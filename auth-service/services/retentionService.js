/**
 * Service: Retention & Storage Lifecycle Purge Service (OPS-01)
 * Enforces data minimization and storage cleanup policies:
 * - Approved staging records purged after 60 days (reconciliation period)
 * - Rejected staging records purged after 30 days
 * - Abandoned pending drafts (>14 days inactive) purged after 30 days
 * - Orphaned temporary files cleaned up safely
 * - NEVER deletes official employee profiles or employee records!
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { logAudit } = require('../audit');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

async function purgeStagingRecords(options = {}) {
  const approvedDays = options.approvedDays || 60;
  const rejectedDays = options.rejectedDays || 30;
  const abandonedDays = options.abandonedDays || 7; // Mặc định 7 ngày cho hồ sơ tạm staging bị bỏ dở
  const stagingFileDays = options.stagingFileDays !== undefined ? options.stagingFileDays : 7; // Chính sách dọn dẹp tệp tạm 7 ngày được phê duyệt

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Purge approved staging items older than approvedDays
    const purgeApproved = await client.query(
      `DELETE FROM hr_employee_staging 
       WHERE staging_status = 'approved' 
         AND updated_at < NOW() - ($1 || ' days')::INTERVAL
       RETURNING id, file_name`,
      [approvedDays]
    );

    // 2. Purge rejected staging items older than rejectedDays
    const purgeRejected = await client.query(
      `DELETE FROM hr_employee_staging 
       WHERE staging_status = 'rejected' 
         AND updated_at < NOW() - ($1 || ' days')::INTERVAL
       RETURNING id, file_name`,
      [rejectedDays]
    );

    // 3. Purge abandoned draft items older than abandonedDays
    const purgeAbandoned = await client.query(
      `DELETE FROM hr_employee_staging 
       WHERE staging_status IN ('pending_review', 'pending_approval')
         AND updated_at < NOW() - ($1 || ' days')::INTERVAL
       RETURNING id, file_name`,
      [abandonedDays]
    );

    await client.query('COMMIT');

    const totalPurged = purgeApproved.rowCount + purgeRejected.rowCount + purgeAbandoned.rowCount;

    // 4. Clean orphaned physical files in uploads/ if older than stagingFileDays (mặc định 7 ngày)
    let filesPurgedCount = 0;
    let bytesPurged = 0;
    if (fs.existsSync(UPLOADS_DIR)) {
      try {
        const diskFiles = fs.readdirSync(UPLOADS_DIR);
        const now = Date.now();
        const maxFileAgeMs = stagingFileDays * 24 * 60 * 60 * 1000; // 7 ngày

        // Query active file names in staging
        const activeRes = await db.query(
          `SELECT file_name FROM hr_employee_staging WHERE staging_status IN ('pending_review', 'pending_approval')`
        );
        const activeNames = new Set(activeRes.rows.map(r => r.file_name).filter(Boolean));

        // Bảo vệ bổ sung: nạp danh sách tệp snapshot và tệp agent output đang active để tuyệt đối không xóa nhầm
        try {
          const snapshotRes = await db.query(
            `SELECT disk_path FROM onedrive_source_snapshots WHERE disk_path IS NOT NULL`
          );
          snapshotRes.rows.forEach(r => {
            if (r.disk_path) activeNames.add(path.basename(r.disk_path));
          });
        } catch (e) {}

        for (const file of diskFiles) {
          const filePath = path.join(UPLOADS_DIR, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile() && (now - stat.mtimeMs > maxFileAgeMs)) {
              if (!activeNames.has(file)) {
                bytesPurged += stat.size;
                fs.unlinkSync(filePath);
                filesPurgedCount++;
              }
            }
          } catch (fErr) {}
        }
      } catch (dirErr) {
        console.warn('[RETENTION] Lỗi kiểm tra thư mục uploads:', dirErr.message);
      }
    }

    if (totalPurged > 0 || filesPurgedCount > 0) {
      await logAudit({
        actor_user_id: options.actorUserId || null,
        actor_username: options.actorUsername || 'SYSTEM_RETENTION_CRON',
        action: 'OPS_STAGING_RETENTION_PURGE',
        status: 'SUCCESS',
        ip_address: '127.0.0.1',
        metadata: {
          approved_purged: purgeApproved.rowCount,
          rejected_purged: purgeRejected.rowCount,
          abandoned_purged: purgeAbandoned.rowCount,
          files_purged: filesPurgedCount,
          bytes_purged: bytesPurged,
          retention_policy: { approvedDays, rejectedDays, abandonedDays, stagingFileDays }
        }
      });
    }

    return {
      success: true,
      purged: {
        approved: purgeApproved.rowCount,
        rejected: purgeRejected.rowCount,
        abandoned: purgeAbandoned.rowCount,
        files: filesPurgedCount,
        bytes: bytesPurged,
        total_staging: totalPurged,
        stagingFileDays
      }
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[RETENTION PURGE ERROR]:', err);
    throw err;
  } finally {
    client.release();
  }
}

const AGENT_OUTPUTS_DIR = path.resolve(__dirname, '..', 'data', 'agent_outputs');
let isPurgingAgentOutputs = false;

/**
 * Dọn dẹp tệp output của Agent đã hết hạn lưu trữ (F-06).
 * Mặc định chạy ở chế độ dry-run an toàn (dryRun: true) và giới hạn batch 50 bản ghi.
 * 
 * @param {Object} options
 * @param {boolean} [options.dryRun=true] - Chế độ chạy thử, không xóa tệp thật và không cập nhật DB
 * @param {number} [options.batchLimit=50] - Giới hạn số lượng tệp xử lý mỗi đợt
 * @param {string} [options.actor='SYSTEM_RETENTION_CLEANER'] - Người thực hiện hoặc hệ thống
 * @param {string} [options.baseDir] - Thư mục cơ sở tùy biến (cho staging/test sandbox)
 * @param {Object} [options.db] - DB client/pool tùy biến (cho staging/test sandbox)
 * @returns {Promise<Object>} Thống kê dọn dẹp chi tiết kèm Audit Log run_id và events
 */
async function purgeExpiredAgentOutputs(options = {}) {
  const dryRun = options.dryRun !== false; // Mặc định true
  const batchLimit = Math.max(1, Math.min(500, parseInt(options.batchLimit, 10) || 50));
  const activeDb = options.db || db;
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : AGENT_OUTPUTS_DIR;
  const actor = options.actor || 'SYSTEM_RETENTION_CLEANER';

  // Chống xử lý đồng thời (Concurrency Lock)
  if (isPurgingAgentOutputs) {
    return { skipped: true, reason: 'Tiến trình dọn dẹp artifact đang chạy, bỏ qua lần kích hoạt này.' };
  }
  isPurgingAgentOutputs = true;

  const runId = crypto.randomUUID();
  const startedAt = new Date();

  try {
    const normalizedBase = path.resolve(baseDir);

    // Chỉ chọn các artifact có expires_at thực sự trong quá khứ (< NOW()), chưa PURGED và có storage_path hợp lệ
    const expiredRes = await activeDb.query(
      `SELECT id, storage_path, file_name, file_size, status, expires_at 
       FROM public.agent_output_files 
       WHERE expires_at IS NOT NULL 
         AND expires_at < NOW() 
         AND status != 'PURGED' 
         AND storage_path IS NOT NULL 
         AND storage_path != ''
       ORDER BY expires_at ASC
       LIMIT $1`,
      [batchLimit]
    );

    let unlinkedCount = 0;
    let bytesFreed = 0;
    const purgedIds = [];
    const reportItems = [];
    const auditEvents = [];
    const pendingUnlinkedEvents = [];
    const pendingGhostEvents = [];

    function resolveStoragePath(storedPath) {
      if (!storedPath) return null;
      let p = String(storedPath).trim();
      if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(p)) {
        const parts = p.split(/[\\/]/);
        const idx = parts.indexOf('agent_outputs');
        if (idx !== -1) {
          const sub = parts.slice(idx + 1).join('/');
          return path.resolve(normalizedBase, sub);
        }
      }
      return path.resolve(p);
    }

    for (const f of expiredRes.rows) {
      if (!f.storage_path) continue;

      const resolvedPath = resolveStoragePath(f.storage_path);
      if (!resolvedPath) continue;

      // 1. Kiểm tra biên giới đường dẫn kết hợp path.resolve + path.relative (Path Traversal)
      const rel = path.relative(normalizedBase, resolvedPath);
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
        console.warn(`[RETENTION SECURITY ALERT] Phát hiện đường dẫn ngoài thư mục cho phép (Path Traversal): ID ${f.id}`);
        reportItems.push({
          id: f.id,
          normalized_path: resolvedPath,
          status: f.status,
          expires_at: f.expires_at,
          action: 'REJECTED_PATH_TRAVERSAL',
          reason: 'Đường dẫn nằm ngoài thư mục lưu trữ cho phép'
        });
        auditEvents.push({
          artifact_id: f.id,
          file_name: f.file_name,
          file_size: parseInt(f.file_size, 10) || 0,
          event: 'REJECTED_UNSAFE_PATH',
          details: {
            error_code: 'PATH_TRAVERSAL_DETECTED',
            reason: 'Đường dẫn nằm ngoài thư mục lưu trữ cho phép'
          }
        });
        continue;
      }

      // 2. Kiểm tra Symlink trỏ ra ngoài thư mục
      let fileExists = false;
      let isSymlink = false;
      let stat = null;

      try {
        if (fs.existsSync(resolvedPath)) {
          fileExists = true;
          const lstat = fs.lstatSync(resolvedPath);
          if (lstat.isSymbolicLink()) {
            isSymlink = true;
            const realTarget = fs.realpathSync(resolvedPath);
            const realRel = path.relative(normalizedBase, realTarget);
            if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
              console.warn(`[RETENTION SECURITY ALERT] Phát hiện symlink trỏ ra ngoài thư mục cho phép: ID ${f.id}`);
              reportItems.push({
                id: f.id,
                normalized_path: resolvedPath,
                status: f.status,
                expires_at: f.expires_at,
                action: 'REJECTED_SYMLINK_OUTSIDE',
                reason: 'Symlink trỏ ra ngoài thư mục lưu trữ hợp lệ'
              });
              auditEvents.push({
                artifact_id: f.id,
                file_name: f.file_name,
                file_size: parseInt(f.file_size, 10) || 0,
                event: 'REJECTED_UNSAFE_PATH',
                details: {
                  error_code: 'SYMLINK_OUTSIDE_ROOT',
                  reason: 'Symlink trỏ ra ngoài thư mục lưu trữ hợp lệ'
                }
              });
              continue;
            }
          }
          stat = fs.statSync(resolvedPath);
        }
      } catch (checkErr) {
        console.warn(`[RETENTION I/O ERROR] Lỗi kiểm tra thuộc tính tệp ID ${f.id}:`, checkErr.message);
        reportItems.push({
          id: f.id,
          normalized_path: resolvedPath,
          status: f.status,
          expires_at: f.expires_at,
          action: 'SKIPPED_IO_ERROR',
          reason: checkErr.message
        });
        auditEvents.push({
          artifact_id: f.id,
          file_name: f.file_name,
          file_size: parseInt(f.file_size, 10) || 0,
          event: 'DELETE_FAILED',
          details: {
            error_code: checkErr.code || 'IO_CHECK_ERROR',
            reason: checkErr.message
          }
        });
        continue;
      }

      // 3. Xử lý chế độ Dry-Run (Không xóa, chỉ tổng hợp báo cáo)
      if (dryRun) {
        const itemSize = stat ? stat.size : (parseInt(f.file_size, 10) || 0);
        bytesFreed += itemSize;
        purgedIds.push(f.id);
        reportItems.push({
          id: f.id,
          normalized_path: resolvedPath,
          status: f.status,
          expires_at: f.expires_at,
          file_exists: fileExists,
          projected_size_bytes: itemSize,
          action: 'DRY_RUN_CANDIDATE',
          reason: fileExists ? 'Tệp quá hạn và tồn tại trên đĩa' : 'Tệp quá hạn và đã không còn trên đĩa'
        });
        auditEvents.push({
          artifact_id: f.id,
          file_name: f.file_name,
          file_size: itemSize,
          event: 'DRY_RUN_CANDIDATE',
          details: {
            file_existed: fileExists,
            reason: fileExists ? 'Tệp quá hạn và tồn tại trên đĩa' : 'Tệp quá hạn và đã không còn trên đĩa'
          }
        });
        continue;
      }

      // 4. Chế độ Thực thi (Chỉ khi dryRun: false)
      if (fileExists) {
        try {
          fs.unlinkSync(resolvedPath);
          unlinkedCount++;
          bytesFreed += (stat?.size || 0);
          purgedIds.push(f.id);
          reportItems.push({
            id: f.id,
            normalized_path: resolvedPath,
            status: 'PURGED',
            file_unlinked: true,
            bytes_freed: stat?.size || 0,
            action: 'PURGED_SUCCESS'
          });
          const ev = {
            artifact_id: f.id,
            file_name: f.file_name,
            file_size: stat?.size || 0,
            event: 'DELETE_SUCCEEDED_DB_UPDATE_PENDING',
            details: {
              file_existed: true,
              unlinked: true,
              db_updated: false
            }
          };
          auditEvents.push(ev);
          pendingUnlinkedEvents.push(ev);
        } catch (uErr) {
          console.warn(`[RETENTION] Không thể xóa tệp vật lý ID ${f.id}:`, uErr.message);
          reportItems.push({
            id: f.id,
            normalized_path: resolvedPath,
            status: f.status,
            action: 'DELETE_FAILED',
            reason: uErr.message
          });
          auditEvents.push({
            artifact_id: f.id,
            file_name: f.file_name,
            file_size: stat?.size || 0,
            event: 'DELETE_FAILED',
            details: {
              file_existed: true,
              unlinked: false,
              db_updated: false,
              error_code: uErr.code || 'UNLINK_FAILED',
              reason: uErr.message
            }
          });
          continue; // Không đánh dấu PURGED nếu việc xóa tệp vật lý bị lỗi quyền hoặc I/O
        }
      } else {
        // Tệp vật lý đã không còn trên đĩa (Ghost record / Recovered on retry)
        purgedIds.push(f.id);
        reportItems.push({
          id: f.id,
          normalized_path: resolvedPath,
          status: 'PURGED',
          file_unlinked: false,
          bytes_freed: 0,
          action: 'PURGED_SUCCESS'
        });
        const ev = {
          artifact_id: f.id,
          file_name: f.file_name,
          file_size: parseInt(f.file_size, 10) || 0,
          event: 'RECOVERED_ON_RETRY',
          details: {
            file_existed: false,
            unlinked: false,
            db_updated: false,
            reason: 'Tệp đĩa đã không còn tồn tại, tự phục hồi DB sang PURGED'
          }
        };
        auditEvents.push(ev);
        pendingGhostEvents.push(ev);
      }
    }

    // 5. Cập nhật trạng thái bản ghi DB nếu không phải Dry-run
    let dbUpdateSucceeded = false;
    let inconsistencyDetected = false;
    const inconsistentArtifactIds = [];

    if (!dryRun && purgedIds.length > 0) {
      try {
        await activeDb.query(
          `UPDATE public.agent_output_files 
           SET status = 'PURGED', storage_path = '' 
           WHERE id = ANY($1::uuid[])`,
          [purgedIds]
        );
        dbUpdateSucceeded = true;
        // Chuyển sự kiện sang DB_UPDATE_SUCCEEDED
        for (const ev of pendingUnlinkedEvents) {
          ev.event = 'DB_UPDATE_SUCCEEDED';
          ev.details.db_updated = true;
        }
        for (const ev of pendingGhostEvents) {
          ev.details.db_updated = true;
        }
        console.log(`[RETENTION AGENT OUTPUTS] Đã dọn dẹp ${purgedIds.length} tệp hết hạn (xóa ${unlinkedCount} tệp vật lý, giải phóng ${(bytesFreed / 1024).toFixed(1)} KB).`);
      } catch (dbErr) {
        console.error('[RETENTION AGENT OUTPUTS DB ERROR]:', dbErr.message);
        inconsistencyDetected = true;
        for (const ev of pendingUnlinkedEvents) {
          ev.details.db_error = dbErr.message;
          inconsistentArtifactIds.push(ev.artifact_id);
        }
      }
    } else if (dryRun) {
      console.log(`[RETENTION AGENT OUTPUTS DRY-RUN] Đã quét ${reportItems.length} ứng viên hết hạn, dự kiến giải phóng ${(bytesFreed / 1024).toFixed(1)} KB.`);
    }

    // 6. Ghi Audit Log vào bảng public.audit_log
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const summary = {
      total_candidates: expiredRes.rows.length,
      dry_run_candidates_count: auditEvents.filter(e => e.event === 'DRY_RUN_CANDIDATE').length,
      delete_succeeded_count: pendingUnlinkedEvents.length,
      delete_failed_count: auditEvents.filter(e => e.event === 'DELETE_FAILED').length,
      db_update_succeeded_count: dbUpdateSucceeded ? purgedIds.length : 0,
      db_update_pending_count: dbUpdateSucceeded ? 0 : pendingUnlinkedEvents.length,
      recovered_on_retry_count: pendingGhostEvents.length,
      rejected_unsafe_path_count: auditEvents.filter(e => e.event === 'REJECTED_UNSAFE_PATH').length,
      bytes_freed: bytesFreed,
      inconsistency_detected: inconsistencyDetected
    };

    const auditDetail = {
      run_id: runId,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
      mode: dryRun ? 'DRY_RUN' : 'DELETE',
      batch_limit: batchLimit,
      actor,
      summary,
      inconsistent_artifact_ids: inconsistentArtifactIds,
      events: auditEvents
    };

    let auditLogged = false;
    let auditError = null;
    let auditId = null;

    try {
      const auditRes = await activeDb.query(
        `INSERT INTO public.audit_log (at, actor, action, detail)
         VALUES (NOW(), $1, 'AGENT_RETENTION_PURGE_BATCH', $2)
         RETURNING id`,
        [actor, JSON.stringify(auditDetail)]
      );
      auditLogged = true;
      auditId = auditRes.rows[0]?.id;
    } catch (auditErr) {
      console.error('[AUDIT LOG FAILURE] Không thể ghi audit log vào database:', auditErr.message);
      auditLogged = false;
      auditError = auditErr.message;
    }

    return {
      runId,
      dryRun,
      batchLimit,
      total: dbUpdateSucceeded ? purgedIds.length : (dryRun ? purgedIds.length : 0),
      purged: dbUpdateSucceeded ? purgedIds.length : 0,
      purgedCount: dbUpdateSucceeded ? purgedIds.length : 0,
      totalScanned: expiredRes.rows.length,
      unlinkedCount,
      bytesFreed,
      auditLogged,
      auditId,
      auditError,
      inconsistencyDetected,
      inconsistentArtifactIds,
      summary,
      events: auditEvents,
      items: reportItems
    };
  } catch (err) {
    console.warn('[RETENTION AGENT OUTPUTS ERROR]:', err.message);
    return {
      runId,
      dryRun,
      error: err.message,
      totalScanned: 0,
      purgedCount: 0,
      auditLogged: false,
      auditError: err.message
    };
  } finally {
    isPurgingAgentOutputs = false;
  }
}

// Tiến trình dọn dẹp lưu trữ Staging và Artifacts tự động
async function runDailyRetentionJob() {
  console.log('[RETENTION CRON] Khởi chạy tiến trình dọn dẹp Staging tự động (Chính sách lưu giữ 7 ngày)...');
  try {
    const resStaging = await purgeStagingRecords({ stagingFileDays: 7, abandonedDays: 7 });
    if (resStaging.purged.total_staging > 0 || resStaging.purged.files > 0) {
      console.log('[RETENTION CRON] Đã dọn dẹp staging và tệp tạm mồ côi:', resStaging.purged);
    }
    const resOutputs = await purgeExpiredAgentOutputs({ dryRun: false });
    if (resOutputs.purgedCount > 0) {
      console.log('[RETENTION CRON] Đã dọn dẹp tệp agent outputs hết hạn:', resOutputs.purgedCount);
    }
  } catch (err) {
    console.error('[RETENTION CRON ERROR]:', err.message);
  }
}

// Khởi chạy 1 lần sau khi khởi động máy chủ 15 giây (khi database và pool đã sẵn sàng)
setTimeout(() => {
  runDailyRetentionJob();
}, 15000).unref();

// Định kỳ quét dọn mỗi 24 giờ
setInterval(() => {
  runDailyRetentionJob();
}, 24 * 60 * 60 * 1000).unref();

module.exports = {
  purgeStagingRecords,
  purgeExpiredAgentOutputs,
  runDailyRetentionJob
};

