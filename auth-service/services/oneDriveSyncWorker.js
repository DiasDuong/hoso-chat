/**
 * SOTRANS HUB — ONEDRIVE AUTOMATIC BACKGROUND SYNC WORKER (180 SECONDS)
 * Task ID: ONEDRIVE-AUTO-SYNC-180S-01
 * 
 * Features:
 * 1. Distributed Locking: Uses PostgreSQL Advisory Lock (8492019) across instances.
 * 2. Runs independently every 180s (configurable via ONEDRIVE_AUTO_SYNC_INTERVAL_MS).
 * 3. Durable state stored in PostgreSQL (onedrive_sync_worker_states & user_onedrive_sources).
 * 4. Microsoft Graph Delta Query for watched folders & change detection.
 * 5. Supports watched folders & individual files.
 * 6. Handles deleted files upstream (marks DELETED_UPSTREAM, unlinks active snapshot).
 * 7. Rate Limit (HTTP 429 Retry-After) and exponential backoff with jitter.
 * 8. Clean crash recovery: resets stuck jobs on boot.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const oneDriveService = require('./oneDriveService');
const oneDriveSourceService = require('./oneDriveSourceService');
const universalDataEngine = require('./universalDataEngine');

const WORKER_INSTANCE_ID = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const ADVISORY_LOCK_ID = 8492019;
const DEFAULT_INTERVAL_MS = 180000; // 3 minutes = 180 seconds

let workerTimer = null;
let isCurrentlyRunning = false;
let isShuttingDown = false;
let isAutoSyncEnabled = process.env.ONEDRIVE_AUTO_SYNC_ENABLED !== 'false';

/**
 * Bật / tắt chế độ tự động đồng bộ định kỳ theo yêu cầu của người dùng/Admin
 */
async function setAutoSyncEnabled(enabled) {
  isAutoSyncEnabled = Boolean(enabled);
  try {
    await db.query(
      `UPDATE public.onedrive_sync_worker_states 
       SET is_active = $1, updated_at = NOW() 
       WHERE id = 'primary_worker'`,
      [isAutoSyncEnabled]
    );
  } catch (err) {
    console.warn('[OneDriveWorker] Không thể cập nhật trạng thái is_active vào DB:', err.message);
  }
  console.log(`[OneDriveWorker] Chế độ tự động đồng bộ đã được đặt thành: ${isAutoSyncEnabled ? 'BẬT' : 'TẮT'}`);
  return isAutoSyncEnabled;
}

const UPLOADS_DIR = path.resolve(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) {}
}

/**
 * Recovers any stale jobs stuck in 'RUNNING' from previous crashes/restarts.
 */
async function recoverStaleJobs() {
  try {
    const res = await db.query(
      `UPDATE public.onedrive_sync_jobs
       SET status = 'FAILED', 
           error_message = 'Tác vụ bị gián đoạn do container hoặc máy chủ khởi động lại',
           completed_at = NOW()
       WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '10 minutes'
       RETURNING id`
    );
    if (res.rows.length > 0) {
      console.log(`[OneDriveWorker] Đã khôi phục ${res.rows.length} tác vụ đồng bộ bị treo từ phiên trước.`);
    }
  } catch (err) {
    console.warn('[OneDriveWorker] Lỗi khi dọn dẹp stale jobs:', err.message);
  }
}

/**
 * Executes a single background polling cycle across all active Microsoft OneDrive connections.
 * @param {object} [options]
 * @param {string} [options.filterUserId] Only run for a specific user if manual
 * @returns {Promise<object>} Cycle statistics
 */
async function runSyncCycle(options = {}) {
  const { filterUserId = null, force = false } = options;
  const startTime = Date.now();

  // Kiểm tra nếu chế độ tự động đồng bộ đang TẮT và không phải kích hoạt thủ công
  if (!isAutoSyncEnabled && !filterUserId && !force) {
    console.log('[OneDriveWorker] Tự động đồng bộ đang TẮT. Bỏ qua chu kỳ định kỳ.');
    return { skipped: true, reason: 'Auto-sync is disabled' };
  }

  // 1. Kiểm tra khóa phân tán PostgreSQL Advisory Lock
  let lockAcquired = false;
  try {
    const lockRes = await db.query(`SELECT pg_try_advisory_lock($1) AS acquired`, [ADVISORY_LOCK_ID]);
    lockAcquired = lockRes.rows[0]?.acquired === true;
  } catch (e) {
    console.warn('[OneDriveWorker] Lỗi kiểm tra advisory lock:', e.message);
    return { skipped: true, reason: 'DB lock check error' };
  }

  if (!lockAcquired) {
    console.log('[OneDriveWorker] Một worker instance khác đang thực hiện chu kỳ đồng bộ. Bỏ qua lượt này.');
    return { skipped: true, reason: 'Lock held by another instance' };
  }

  const cycleStats = {
    startedAt: new Date(),
    connectionsChecked: 0,
    filesPolled: 0,
    filesUpdated: 0,
    filesDeleted: 0,
    newFilesDiscovered: 0,
    errors: 0
  };

  try {
    isCurrentlyRunning = true;

    // Cập nhật trạng thái bắt đầu vào DB
    await db.query(
      `UPDATE public.onedrive_sync_worker_states
       SET worker_instance_id = $1,
           last_heartbeat = NOW(),
           last_run_started_at = NOW(),
           last_run_status = 'RUNNING',
           updated_at = NOW()
       WHERE id = 'primary_worker'`,
      [WORKER_INSTANCE_ID]
    );

    // 2. Lấy danh sách kết nối Microsoft OAuth đang hoạt động
    let tokenQuery = `
      SELECT user_id, account_email, account_name, token_expires_at
      FROM public.user_oauth_tokens
      WHERE provider = 'microsoft'
    `;
    const tokenParams = [];
    if (filterUserId) {
      tokenQuery += ` AND user_id = $1`;
      tokenParams.push(filterUserId);
    }
    const tokenRes = await db.query(tokenQuery, tokenParams);

    cycleStats.connectionsChecked = tokenRes.rows.length;

    // 3. Xử lý từng kết nối người dùng
    for (const conn of tokenRes.rows) {
      const userId = conn.user_id;

      let accessToken = null;
      try {
        accessToken = await oneDriveService.getUserValidAccessToken(userId);
      } catch (tokenErr) {
        console.warn(`[OneDriveWorker] Không thể lấy token cho user ${userId} (${conn.account_email}):`, tokenErr.message);
        cycleStats.errors++;

        // Nếu token bị thu hồi hoặc grant không hợp lệ upstream
        if (tokenErr.message?.includes('invalid_grant') || tokenErr.message?.includes('revoked')) {
          await db.query(
            `UPDATE public.user_onedrive_sources
             SET poll_status = 'REVOKED', last_error = 'Phiên làm việc Microsoft OneDrive đã hết hạn hoặc bị thu hồi'
             WHERE owner_user_id = $1 AND sync_status NOT IN ('DISCONNECTED', 'DELETED_UPSTREAM')`,
            [userId]
          );
        }
        continue;
      }

      // Lấy danh sách nguồn tệp và thư mục đang được theo dõi của user này
      const sourcesRes = await db.query(
        `SELECT * FROM public.user_onedrive_sources
         WHERE owner_user_id = $1
           AND is_watched = TRUE
           AND sync_status NOT IN ('DISCONNECTED', 'DELETED_UPSTREAM')
           AND (retry_after_until IS NULL OR retry_after_until <= NOW())
         ORDER BY updated_at ASC`,
        [userId]
      );

      // Phân tách thư mục theo dõi (FOLDER) và tệp riêng lẻ (FILE)
      const folderSources = sourcesRes.rows.filter(s => s.source_type === 'FOLDER');
      const fileSources = sourcesRes.rows.filter(s => s.source_type !== 'FOLDER');

      // A. XỬ LÝ THƯ MỤC THEO DÕI (WATCHED FOLDERS) QUA MICROSOFT GRAPH DELTA QUERY
      for (const folder of folderSources) {
        try {
          await db.query(
            `UPDATE public.user_onedrive_sources SET poll_status = 'POLLING' WHERE id = $1`,
            [folder.id]
          );

          const deltaRes = await oneDriveService.pollDriveDelta({
            accessToken,
            driveId: folder.drive_id,
            folderId: folder.item_id,
            deltaLink: folder.delta_link
          });

          if (deltaRes.isThrottled) {
            console.warn(`[OneDriveWorker] Microsoft Graph Throttled folder ${folder.file_name}. Retry-After: ${deltaRes.retryAfter}s.`);
            await db.query(
              `UPDATE public.user_onedrive_sources 
               SET poll_status = 'THROTTLED', 
                   retry_after_until = NOW() + ($1 * INTERVAL '1 second'),
                   updated_at = NOW()
               WHERE id = $2`,
              [deltaRes.retryAfter, folder.id]
            );
            continue;
          }

          if (deltaRes.resyncRequired) {
            // Delta link đã hết hạn (HTTP 410) -> Xóa deltaLink để lần tới scan lại từ đầu
            await db.query(
              `UPDATE public.user_onedrive_sources SET delta_link = NULL, poll_status = 'IDLE' WHERE id = $1`,
              [folder.id]
            );
            continue;
          }

          // Xử lý các items trả về từ Delta
          for (const item of deltaRes.items) {
            cycleStats.filesPolled++;
            const itemId = item.id;
            const isItemDeleted = Boolean(item.deleted || item['@deleted']);

            if (isItemDeleted) {
              // Tìm tệp con đang được theo dõi có item_id này
              const existingChild = await db.query(
                `SELECT id, file_name FROM public.user_onedrive_sources
                 WHERE owner_user_id = $1 AND item_id = $2 AND parent_folder_id = $3`,
                [userId, itemId, folder.item_id]
              );
              if (existingChild.rows.length > 0) {
                for (const row of existingChild.rows) {
                  await oneDriveSourceService.handleUpstreamDeletedSource(row.id, userId);
                  console.log(`[OneDriveWorker] Delta phát hiện tệp "${row.file_name}" đã bị xóa trên OneDrive.`);
                  cycleStats.filesDeleted++;
                }
              }
              continue;
            }

            // Nếu là tệp thông thường (không phải folder)
            if (item.file) {
              const fileName = item.name || '';
              const ext = path.extname(fileName).toLowerCase();

              // Bỏ qua định dạng không hỗ trợ
              if (!oneDriveService.SUPPORTED_EXTENSIONS.includes(ext)) {
                continue;
              }

              // Kiểm tra xem tệp này đã được đăng ký trong hệ thống chưa
              const childMatch = await db.query(
                `SELECT * FROM public.user_onedrive_sources
                 WHERE owner_user_id = $1 AND item_id = $2`,
                [userId, itemId]
              );

              if (childMatch.rows.length > 0) {
                // TỆP ĐÃ TỒN TẠI: Kiểm tra thay đổi metadata
                const existingSource = childMatch.rows[0];
                const hasModified = (item.cTag && existingSource.ctag && item.cTag !== existingSource.ctag) ||
                                    (item.eTag && existingSource.etag && item.eTag !== existingSource.etag) ||
                                    !existingSource.active_snapshot_id;

                // Cập nhật tên tệp nếu bị đổi tên
                if (existingSource.file_name !== fileName) {
                  await db.query(
                    `UPDATE public.user_onedrive_sources SET file_name = $1, updated_at = NOW() WHERE id = $2`,
                    [fileName, existingSource.id]
                  );
                }

                if (hasModified) {
                  console.log(`[OneDriveWorker] Delta phát hiện tệp "${fileName}" có bản sửa đổi mới. Bắt đầu ingestion...`);
                  try {
                    await oneDriveSourceService.syncSourceVersion(existingSource.id, userId, {
                      jobType: 'SCHEDULED',
                      targetMetadata: {
                        id: item.id,
                        name: fileName,
                        eTag: item.eTag,
                        cTag: item.cTag,
                        size: item.size,
                        lastModifiedDateTime: item.lastModifiedDateTime,
                        driveId: item.parentReference?.driveId || folder.drive_id
                      }
                    });
                    cycleStats.filesUpdated++;
                  } catch (ingestErr) {
                    cycleStats.errors++;
                    console.error(`[OneDriveWorker] Lỗi ingestion cho tệp ${fileName}:`, ingestErr.message);
                  }
                }
              } else {
                // PHÁT HIỆN TỆP MỚI XUẤT HIỆN TRONG THƯ MỤC THEO DÕI
                console.log(`[OneDriveWorker] Phát hiện tệp mới "${fileName}" trong thư mục theo dõi "${folder.file_name}". Tự động nạp...`);
                try {
                  const dl = await oneDriveService.downloadDriveItem(
                    item.parentReference?.driveId || folder.drive_id,
                    itemId,
                    userId
                  );

                  const fileId = crypto.randomUUID();
                  const safeDiskName = `src_auto_${fileId}_${path.basename(dl.fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                  const diskPath = path.join(UPLOADS_DIR, safeDiskName);
                  fs.writeFileSync(diskPath, dl.buffer);

                  const parsed = await universalDataEngine.parseUniversalFile(dl.buffer, {
                    fileName: dl.fileName,
                    fileId: fileId,
                    mimeType: dl.mimeType
                  });

                  const newSource = await oneDriveSourceService.registerOrUpdateSource({
                    ownerUserId: userId,
                    agentId: folder.agent_id,
                    dl,
                    parsedUniversal: parsed,
                    storagePath: diskPath
                  });

                  // Gắn parent_folder_id vào nguồn mới tạo
                  await db.query(
                    `UPDATE public.user_onedrive_sources 
                     SET parent_folder_id = $1, source_type = 'FILE', is_watched = TRUE 
                     WHERE id = $2`,
                    [folder.item_id, newSource.id]
                  );

                  cycleStats.newFilesDiscovered++;
                  console.log(`[OneDriveWorker] Đã tự động nạp thành công tệp mới "${fileName}" (v1).`);
                } catch (newFileErr) {
                  cycleStats.errors++;
                  console.error(`[OneDriveWorker] Lỗi nạp tệp mới "${fileName}":`, newFileErr.message);
                }
              }
            }
          }

          // Lưu delta link mới nhất và thời điểm poll
          await db.query(
            `UPDATE public.user_onedrive_sources
             SET delta_link = COALESCE($1, delta_link),
                 last_polled_at = NOW(),
                 next_poll_at = NOW() + INTERVAL '180 seconds',
                 poll_status = 'IDLE',
                 poll_error_count = 0,
                 updated_at = NOW()
             WHERE id = $2`,
            [deltaRes.deltaLink, folder.id]
          );

        } catch (folderErr) {
          cycleStats.errors++;
          console.error(`[OneDriveWorker] Lỗi polling thư mục ${folder.file_name}:`, folderErr.message);
          await db.query(
            `UPDATE public.user_onedrive_sources
             SET poll_status = 'ERROR', 
                 poll_error_count = poll_error_count + 1,
                 last_error = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [folderErr.message, folder.id]
          );
        }
      }

      // B. XỬ LÝ TỆP RIÊNG LẺ (SINGLE MONITORED FILES)
      for (const fileSrc of fileSources) {
        // Nếu tệp này nằm trong một thư mục đã có delta quét ở trên, bỏ qua quét trùng lặp
        if (fileSrc.parent_folder_id && folderSources.some(f => f.item_id === fileSrc.parent_folder_id)) {
          continue;
        }

        cycleStats.filesPolled++;
        try {
          await db.query(
            `UPDATE public.user_onedrive_sources SET poll_status = 'POLLING' WHERE id = $1`,
            [fileSrc.id]
          );

          // 1. Kiểm tra sự tồn tại và tính hợp lệ upstream
          const checkRes = await oneDriveService.checkItemExistsOrDeleted({
            accessToken,
            driveId: fileSrc.drive_id,
            itemId: fileSrc.item_id
          });

          if (checkRes.isThrottled) {
            console.warn(`[OneDriveWorker] Throttled tệp ${fileSrc.file_name}. Retry-After: ${checkRes.retryAfter}s.`);
            await db.query(
              `UPDATE public.user_onedrive_sources 
               SET poll_status = 'THROTTLED', 
                   retry_after_until = NOW() + ($1 * INTERVAL '1 second'),
                   updated_at = NOW()
               WHERE id = $2`,
              [checkRes.retryAfter, fileSrc.id]
            );
            continue;
          }

          if (checkRes.isDeleted) {
            console.log(`[OneDriveWorker] Tệp "${fileSrc.file_name}" xác nhận đã bị xóa trên OneDrive upstream.`);
            await oneDriveSourceService.handleUpstreamDeletedSource(fileSrc.id, userId);
            cycleStats.filesDeleted++;
            continue;
          }

          if (checkRes.exists && checkRes.item) {
            const item = checkRes.item;

            // Kiểm tra đổi tên tệp
            if (item.name && item.name !== fileSrc.file_name) {
              await db.query(
                `UPDATE public.user_onedrive_sources SET file_name = $1, updated_at = NOW() WHERE id = $2`,
                [item.name, fileSrc.id]
              );
            }

            // Kiểm tra thay đổi nội dung (eTag / cTag)
            const hasChanged = (item.cTag && fileSrc.ctag && item.cTag !== fileSrc.ctag) ||
                               (item.eTag && fileSrc.etag && item.eTag !== fileSrc.etag) ||
                               !fileSrc.active_snapshot_id;

            if (hasChanged) {
              console.log(`[OneDriveWorker] Phát hiện bản cập nhật mới cho tệp "${fileSrc.file_name}". Tự động ingestion...`);
              await oneDriveSourceService.syncSourceVersion(fileSrc.id, userId, {
                jobType: 'SCHEDULED',
                targetMetadata: {
                  id: item.id,
                  name: item.name || fileSrc.file_name,
                  eTag: item.eTag,
                  cTag: item.cTag,
                  size: item.size,
                  lastModifiedDateTime: item.lastModifiedDateTime,
                  driveId: item.parentReference?.driveId || fileSrc.drive_id
                }
              });
              cycleStats.filesUpdated++;
            }

            // Cập nhật trạng thái poll thành công
            await db.query(
              `UPDATE public.user_onedrive_sources
               SET last_polled_at = NOW(),
                   next_poll_at = NOW() + INTERVAL '180 seconds',
                   poll_status = 'IDLE',
                   poll_error_count = 0,
                   updated_at = NOW()
               WHERE id = $1`,
              [fileSrc.id]
            );
          }
        } catch (fileErr) {
          cycleStats.errors++;
          console.error(`[OneDriveWorker] Lỗi polling tệp ${fileSrc.file_name}:`, fileErr.message);

          if (fileErr.statusCode === 404 || fileErr.message?.includes('404')) {
            await oneDriveSourceService.handleUpstreamDeletedSource(fileSrc.id, userId);
            cycleStats.filesDeleted++;
          } else {
            await db.query(
              `UPDATE public.user_onedrive_sources
               SET poll_status = 'ERROR',
                   poll_error_count = poll_error_count + 1,
                   last_error = $1,
                   updated_at = NOW()
               WHERE id = $2`,
              [fileErr.message, fileSrc.id]
            );
          }
        }
      }
    }

    const durationMs = Date.now() - startTime;

    const statsPayload = JSON.stringify({
      last_cycle_duration_ms: durationMs,
      last_connections_checked: cycleStats.connectionsChecked,
      last_new_files_discovered: cycleStats.newFilesDiscovered,
      last_files_updated: cycleStats.filesUpdated,
      last_files_deleted: cycleStats.filesDeleted
    });

    // 4. Cập nhật Worker State sau khi hoàn tất chu kỳ
    await db.query(
      `UPDATE public.onedrive_sync_worker_states
       SET last_heartbeat = NOW(),
           last_run_completed_at = NOW(),
           last_run_status = 'COMPLETED',
           last_run_duration_ms = $1::int,
           total_runs = total_runs + 1,
           total_files_polled = total_files_polled + $2::int,
           total_files_updated = total_files_updated + $3::int,
           total_files_deleted = total_files_deleted + $4::int,
           total_errors = total_errors + $5::int,
           stats = $6::jsonb,
           updated_at = NOW()
       WHERE id = 'primary_worker'`,
      [
        durationMs,
        cycleStats.filesPolled,
        cycleStats.filesUpdated,
        cycleStats.filesDeleted,
        cycleStats.errors,
        statsPayload
      ]
    );

    console.log(
      `[OneDriveWorker] ✅ Hoàn thành chu kỳ đồng bộ (${durationMs}ms): ` +
      `${cycleStats.connectionsChecked} kết nối, ${cycleStats.filesPolled} tệp kiểm tra, ` +
      `${cycleStats.newFilesDiscovered} tệp mới, ${cycleStats.filesUpdated} cập nhật, ` +
      `${cycleStats.filesDeleted} xóa, ${cycleStats.errors} lỗi.`
    );

    return { success: true, durationMs, cycleStats };
  } catch (cycleErr) {
    console.error('[OneDriveWorker] ❌ Lỗi nghiêm trọng trong chu kỳ đồng bộ:', cycleErr);
    try {
      await db.query(
        `UPDATE public.onedrive_sync_worker_states
         SET last_run_completed_at = NOW(),
             last_run_status = 'FAILED',
             total_errors = total_errors + 1,
             updated_at = NOW()
         WHERE id = 'primary_worker'`
      );
    } catch (e) {}
    return { success: false, error: cycleErr.message };
  } finally {
    isCurrentlyRunning = false;
    // 5. Giải phóng khóa PostgreSQL Advisory Lock
    try {
      await db.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    } catch (e) {
      console.warn('[OneDriveWorker] Lỗi giải phóng advisory lock:', e.message);
    }
  }
}

/**
 * Starts the recurring Background Sync Worker.
 */
function startSyncWorker(customIntervalMs = null) {
  if (process.env.ONEDRIVE_AUTO_SYNC_ENABLED === 'false') {
    console.log('[OneDriveWorker] Tự động đồng bộ OneDrive đang TẮT (ONEDRIVE_AUTO_SYNC_ENABLED=false).');
    return;
  }

  const intervalMs = customIntervalMs || parseInt(process.env.ONEDRIVE_AUTO_SYNC_INTERVAL_MS, 10) || DEFAULT_INTERVAL_MS;

  if (workerTimer) {
    clearInterval(workerTimer);
  }

  console.log(`[OneDriveWorker] 🚀 Khởi chạy Background Sync Worker (Chu kỳ: ${intervalMs / 1000} giây)...`);

  // Dọn dẹp stale jobs và chạy lượt kiểm tra đầu tiên sau 5 giây khởi động
  setTimeout(async () => {
    await recoverStaleJobs();
    await runSyncCycle();
  }, 5000);

  // Đặt lịch lặp lại định kỳ
  workerTimer = setInterval(async () => {
    if (isShuttingDown) return;
    await runSyncCycle();
  }, intervalMs);

  // Graceful shutdown listeners
  const handleShutdown = async () => {
    isShuttingDown = true;
    if (workerTimer) clearInterval(workerTimer);
    try {
      await db.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    } catch (e) {}
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}

/**
 * Stops the recurring Background Sync Worker.
 */
function stopSyncWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  isShuttingDown = true;
  console.log('[OneDriveWorker] Đã dừng Background Sync Worker.');
}

/**
 * Retrieves the live status and operational telemetry of the worker.
 */
async function getSyncWorkerStatus() {
  const res = await db.query(`SELECT * FROM public.onedrive_sync_worker_states WHERE id = 'primary_worker'`);
  const workerState = res.rows[0] || {};
  const activeFromDb = workerState.is_active !== undefined ? workerState.is_active : true;

  return {
    autoSyncEnabled: isAutoSyncEnabled && activeFromDb,
    intervalMs: workerState.interval_ms || DEFAULT_INTERVAL_MS,
    intervalSeconds: (workerState.interval_ms || DEFAULT_INTERVAL_MS) / 1000,
    workerInstanceId: workerState.worker_instance_id,
    isCurrentlyRunning,
    lastHeartbeat: workerState.last_heartbeat,
    lastRunStartedAt: workerState.last_run_started_at,
    lastRunCompletedAt: workerState.last_run_completed_at,
    lastRunStatus: workerState.last_run_status,
    lastRunDurationMs: workerState.last_run_duration_ms,
    totalRuns: workerState.total_runs,
    totalFilesPolled: workerState.total_files_polled,
    totalFilesUpdated: workerState.total_files_updated,
    totalFilesDeleted: workerState.total_files_deleted,
    totalErrors: workerState.total_errors,
    stats: workerState.stats || {}
  };
}

module.exports = {
  startSyncWorker,
  stopSyncWorker,
  runSyncCycle,
  recoverStaleJobs,
  getSyncWorkerStatus,
  setAutoSyncEnabled,
  ADVISORY_LOCK_ID,
  DEFAULT_INTERVAL_MS
};
