/**
 * SOTRANS HUB — ONEDRIVE SOURCE REGISTRY & HYBRID SYNC SERVICE
 * 
 * Implements Platform-level Phương án C:
 * 1. Persistent Source Registry (user_onedrive_sources)
 * 2. Immutable Version Snapshots (onedrive_source_snapshots)
 * 3. Query-Time Freshness Validation & Auto-sync
 * 4. Graph Change Notifications & Periodic Delta Reconciliation
 * 5. Concurrency Locks, Idempotent Sync Jobs & Staging Publication
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const oneDriveService = require('./oneDriveService');
const universalDataEngine = require('./universalDataEngine');

const UPLOADS_DIR = path.resolve(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) {}
}

// In-memory mutex map for ongoing sync jobs per sourceId
const ongoingSyncPromises = new Map();

/**
 * Registers or updates a connected OneDrive source with an initial published snapshot.
 */
async function registerOrUpdateSource({
  ownerUserId,
  agentId = null,
  conversationId = null,
  sharingUrl,
  dl,
  parsedUniversal,
  storagePath
}) {
  if (!ownerUserId || !dl || !dl.fileName) {
    throw new Error('Thiếu tham số bắt buộc để đăng ký nguồn OneDrive.');
  }

  // 1. Kiểm tra nguồn đã tồn tại chưa (theo owner và item_id, file_name hoặc sharing_url)
  const targetItemId = dl.driveItemId || dl.itemId || null;
  const existingRes = await db.query(
    `SELECT * FROM public.user_onedrive_sources
     WHERE owner_user_id = $1 AND (
       (item_id IS NOT NULL AND item_id = $2) OR
       (file_name IS NOT NULL AND LOWER(file_name) = LOWER($3)) OR
       (sharing_url IS NOT NULL AND sharing_url = $4)
     )
     ORDER BY updated_at DESC LIMIT 1`,
    [ownerUserId, targetItemId || 'unknown_item', dl.fileName || '', sharingUrl || 'unknown_url']
  );

  let sourceRecord = null;
  let nextVersion = 1;

  if (existingRes.rows.length > 0) {
    sourceRecord = existingRes.rows[0];
    nextVersion = (sourceRecord.active_version || 0) + 1;

    const updateRes = await db.query(
      `UPDATE public.user_onedrive_sources
       SET agent_id = COALESCE($1, agent_id),
           conversation_id = COALESCE($2, conversation_id),
           sharing_url = COALESCE($3, sharing_url),
           drive_id = COALESCE($4, drive_id),
           item_id = COALESCE($5, item_id),
           file_name = $6,
           mime_type = $7,
           file_size = $8,
           etag = $9,
           ctag = $10,
           last_modified_at = $11,
           last_synced_at = NOW(),
           active_version = $12,
           sync_status = 'SYNCED',
           last_error = NULL,
           storage_path = $13,
           updated_at = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        agentId,
        conversationId,
        sharingUrl || null,
        dl.driveId || null,
        targetItemId,
        dl.fileName,
        dl.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dl.size || 0,
        dl.eTag || null,
        dl.cTag || null,
        dl.lastModifiedDateTime ? new Date(dl.lastModifiedDateTime) : new Date(),
        nextVersion,
        storagePath,
        sourceRecord.id
      ]
    );
    sourceRecord = updateRes.rows[0];
  } else {
    const insertRes = await db.query(
      `INSERT INTO public.user_onedrive_sources (
         owner_user_id, agent_id, conversation_id, sharing_url, drive_id, item_id,
         file_name, mime_type, file_size, etag, ctag, last_modified_at, last_synced_at,
         active_version, sync_status, storage_path
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, 'SYNCED', $14)
       RETURNING *`,
      [
        ownerUserId,
        agentId,
        conversationId,
        sharingUrl || null,
        dl.driveId || null,
        targetItemId,
        dl.fileName,
        dl.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dl.size || 0,
        dl.eTag || null,
        dl.cTag || null,
        dl.lastModifiedDateTime ? new Date(dl.lastModifiedDateTime) : new Date(),
        nextVersion,
        storagePath
      ]
    );
    sourceRecord = insertRes.rows[0];
  }

  // 2. Lưu Staging Snapshot và Publish ngay lập tức cho lần nạp đầu tiên
  const promptContext = universalDataEngine.formatUniversalPromptContext([parsedUniversal]);
  const snapRes = await db.query(
    `INSERT INTO public.onedrive_source_snapshots (
       source_id, version_number, etag, ctag, file_name, file_size, storage_path,
       manifest, data_profile, prompt_context, status, published_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PUBLISHED', NOW())
     RETURNING *`,
    [
      sourceRecord.id,
      nextVersion,
      dl.eTag || null,
      dl.cTag || null,
      dl.fileName,
      dl.size || 0,
      storagePath,
      JSON.stringify(parsedUniversal.manifest || {}),
      JSON.stringify(parsedUniversal.dataProfile || {}),
      promptContext || ''
    ]
  );

  const snapshot = snapRes.rows[0];

  // Lưu active_snapshot_id vào user_onedrive_sources
  await db.query(
    `UPDATE public.user_onedrive_sources SET active_snapshot_id = $1 WHERE id = $2`,
    [snapshot.id, sourceRecord.id]
  );

  sourceRecord.active_snapshot_id = snapshot.id;
  sourceRecord.activeSnapshot = snapshot;

  return sourceRecord;
}

/**
 * Returns all active connected OneDrive sources for a specific user and agent.
 * Handles bidirectional agent mapping between built-in 'excel-data-pro' and user custom agents
 * (e.g. data analyst or agents named Excel-Data-Pro), and supports general management mode.
 */
async function getConnectedSourcesForAgent({ ownerUserId, agentId = null, conversationId = null }) {
  if (!ownerUserId) return [];

  let cleanAgentId = agentId ? String(agentId).replace(/^custom_/, '').trim() : null;
  if (cleanAgentId === 'general' || cleanAgentId === 'all' || cleanAgentId === '') {
    cleanAgentId = null;
  }

  // Xác định xem agentId có phải là một Excel agent hay không
  let isExcelAgent = false;
  let userExcelAgentIds = [];
  try {
    const agRes = await db.query(
      `SELECT id::text FROM public.user_agents
       WHERE (user_id = $1 OR status = 'public') 
         AND (name ILIKE '%excel%' OR agent_type = 'DATA_ANALYST')`,
      [ownerUserId]
    );
    userExcelAgentIds = agRes.rows.map(r => r.id);
  } catch (e) {}

  if (cleanAgentId === 'excel-data-pro' || (cleanAgentId && userExcelAgentIds.includes(cleanAgentId))) {
    isExcelAgent = true;
  }

  const query = `
    SELECT s.*, 
           snp.manifest AS snapshot_manifest,
           snp.data_profile AS snapshot_data_profile,
           snp.prompt_context AS snapshot_prompt_context,
           snp.version_number AS snapshot_version_number,
           COALESCE(a.name, CASE WHEN s.agent_id = 'excel-data-pro' THEN 'Excel-Data-Pro' ELSE s.agent_id END) AS agent_name
    FROM public.user_onedrive_sources s
    LEFT JOIN public.onedrive_source_snapshots snp ON s.active_snapshot_id = snp.id
    LEFT JOIN public.user_agents a ON a.id::text = s.agent_id
    WHERE s.owner_user_id = $1 
      AND s.sync_status != 'DISCONNECTED'
      AND (
        ($2::text IS NULL)
        OR ($3::text IS NOT NULL AND s.conversation_id = $3::text)
        OR ($4::boolean = TRUE AND (
          s.agent_id = 'excel-data-pro' 
          OR s.agent_id = $2::text 
          OR s.agent_id = ANY($5::text[])
          OR s.agent_id IS NULL
        ))
        OR ($4::boolean = FALSE AND (
          s.agent_id = $2::text 
          OR s.agent_id IS NULL
        ))
      )
    ORDER BY s.updated_at DESC
  `;

  const res = await db.query(query, [
    ownerUserId,
    cleanAgentId,
    conversationId,
    isExcelAgent,
    userExcelAgentIds
  ]);
  return res.rows;
}

/**
 * Checks metadata freshness with Microsoft Graph API.
 * Compares eTag, cTag and lastModifiedDateTime.
 */
async function checkSourceFreshness(source, accessToken, options = {}) {
  if (!source || !accessToken) {
    return { isFresh: false, isGraphReachable: false, reason: 'Thiếu thông tin source hoặc accessToken' };
  }

  try {
    let meta = null;
    if (typeof options.fetchGraphMetadataFn === 'function') {
      meta = await options.fetchGraphMetadataFn(source, accessToken);
    } else {
      let metaUrl = null;
      if (source.drive_id && source.item_id) {
        metaUrl = `https://graph.microsoft.com/v1.0/drives/${source.drive_id}/items/${source.item_id}?select=id,name,eTag,cTag,size,lastModifiedDateTime,parentReference`;
      } else if (source.item_id) {
        metaUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${source.item_id}?select=id,name,eTag,cTag,size,lastModifiedDateTime,parentReference`;
      } else if (source.sharing_url) {
        const shareToken = oneDriveService.encodeSharingUrl(source.sharing_url);
        metaUrl = `https://graph.microsoft.com/v1.0/shares/${shareToken}/driveItem?select=id,name,eTag,cTag,size,lastModifiedDateTime,parentReference`;
      }

      if (!metaUrl) {
        return { isFresh: false, isGraphReachable: false, reason: 'Không có URL hoặc Drive Item ID để kiểm tra' };
      }

      let resp = await oneDriveService.fetchWithTimeout(metaUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        }
      });

      // Nếu gọi endpoint theo drive_id bị lỗi nhưng có item_id, thử fallback sang /me/drive/items
      if (!resp.ok && source.item_id && metaUrl.includes('/drives/')) {
        const fallbackUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${source.item_id}?select=id,name,eTag,cTag,size,lastModifiedDateTime,parentReference`;
        const fbResp = await oneDriveService.fetchWithTimeout(fallbackUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json'
          }
        });
        if (fbResp.ok) {
          resp = fbResp;
        }
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return {
          isFresh: false,
          isGraphReachable: false,
          httpStatus: resp.status,
          reason: `Graph API trả về mã lỗi ${resp.status}: ${errText.slice(0, 150)}`
        };
      }

      meta = await resp.json();
    }

    // 1. Kiểm tra eTag & cTag
    let isFresh = false;
    if (meta.cTag && source.ctag) {
      isFresh = meta.cTag === source.ctag;
    } else if (meta.eTag && source.etag) {
      isFresh = meta.eTag === source.etag;
    } else if (meta.lastModifiedDateTime && source.last_modified_at) {
      const graphTime = new Date(meta.lastModifiedDateTime).getTime();
      const localTime = new Date(source.last_modified_at).getTime();
      isFresh = Math.abs(graphTime - localTime) < 2000;
    }

    // Nếu chưa có snapshot được publish, bắt buộc đồng bộ
    if (!source.active_snapshot_id) {
      isFresh = false;
    }

    return {
      isFresh,
      isGraphReachable: true,
      currentMetadata: {
        id: meta.id,
        name: meta.name,
        eTag: meta.eTag,
        cTag: meta.cTag,
        size: meta.size,
        lastModifiedDateTime: meta.lastModifiedDateTime,
        driveId: meta.parentReference?.driveId || source.drive_id
      }
    };
  } catch (netErr) {
    return {
      isFresh: false,
      isGraphReachable: false,
      reason: 'Lỗi mạng hoặc quá thời gian chờ khi gọi Microsoft Graph: ' + netErr.message
    };
  }
}

/**
 * Synchronizes an updated version of a OneDrive source safely:
 * - Mutex lock per sourceId
 * - Creates onedrive_sync_jobs audit record
 * - Downloads with 20MB limit & magic bytes validation
 * - Parses with Universal Data Understanding Engine
 * - Staging snapshot -> Verification -> Atomic Publish
 * - On failure: keeps previous snapshot intact
 */
async function syncSourceVersion(sourceId, ownerUserId, options = {}) {
  const { jobType = 'QUERY_TIME', force = false, targetMetadata = null, downloaderFn = null } = options;

  // 1. Concurrency Mutex: Nếu đang có job chạy cho source này, chờ job hiện tại hoàn tất
  if (ongoingSyncPromises.has(sourceId)) {
    return ongoingSyncPromises.get(sourceId);
  }

  const syncPromise = (async () => {
    let job = null;
    let stagingSnapshotId = null;

    try {
      // 2. Đọc thông tin nguồn từ DB
      const sRes = await db.query(
        `SELECT * FROM public.user_onedrive_sources WHERE id = $1 AND owner_user_id = $2`,
        [sourceId, ownerUserId]
      );

      if (sRes.rows.length === 0) {
        const err = new Error('Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập.');
        err.statusCode = 404;
        throw err;
      }

      const source = sRes.rows[0];
      if (!source.sharing_url && !source.item_id) {
        throw new Error('Nguồn OneDrive không có liên kết chia sẻ hoặc Item ID để tải dữ liệu.');
      }

      // Đánh dấu nguồn đang đồng bộ
      await db.query(
        `UPDATE public.user_onedrive_sources SET sync_status = 'SYNCING', updated_at = NOW() WHERE id = $1`,
        [sourceId]
      );

      // 3. Tạo Sync Job Record
      const nextVersion = (source.active_version || 0) + 1;
      const idempotencyKey = `${sourceId}_v${nextVersion}_${Date.now()}`;
      const jobRes = await db.query(
        `INSERT INTO public.onedrive_sync_jobs (
           source_id, job_type, status, idempotency_key, target_etag, started_at
         ) VALUES ($1, $2, 'RUNNING', $3, $4, NOW())
         RETURNING *`,
        [sourceId, jobType, idempotencyKey, targetMetadata?.eTag || source.etag || null]
      );
      job = jobRes.rows[0];
      // 4. Tải tệp an toàn qua Microsoft Graph
      let dl = null;
      if (typeof downloaderFn === 'function') {
        dl = await downloaderFn(source, ownerUserId);
      } else if (source.item_id) {
        try {
          dl = await oneDriveService.downloadDriveItem(source.drive_id, source.item_id, ownerUserId);
        } catch (itemDlErr) {
          if (source.sharing_url) {
            dl = await oneDriveService.resolveAndDownloadSharedItem(source.sharing_url, ownerUserId);
          } else {
            throw itemDlErr;
          }
        }
      } else if (source.sharing_url) {
        dl = await oneDriveService.resolveAndDownloadSharedItem(source.sharing_url, ownerUserId);
      } else {
        throw new Error('Nguồn OneDrive không có Item ID hoặc liên kết chia sẻ để tải dữ liệu.');
      }

      // Tính mã băm SHA-256 của nội dung tệp vừa tải
      let downloadedHash = crypto.createHash('sha256').update(dl.buffer).digest('hex');

      // Xác định mã băm của bản snapshot đang hoạt động (nếu có)
      let activeContentHash = source.content_hash || null;
      if (!activeContentHash && source.active_snapshot_id) {
        const actSnapRes = await db.query(
          `SELECT content_hash, storage_path, manifest FROM public.onedrive_source_snapshots WHERE id = $1`,
          [source.active_snapshot_id]
        );
        if (actSnapRes.rows.length > 0) {
          const act = actSnapRes.rows[0];
          activeContentHash = act.content_hash || act.manifest?.contentHash || null;
          if (!activeContentHash && act.storage_path) {
            const p = resolveStoragePath(act.storage_path);
            if (p && fs.existsSync(p)) {
              activeContentHash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
            }
          }
        }
      }

      // SMART FLUSH POLLING: Nếu người dùng bấm Đồng bộ thủ công (force=true) mà hash chưa đổi,
      // có thể do Excel Online chưa kịp flush phiên làm việc sang lưu trữ OneDrive.
      // Tự động thăm dò đợt 2 sau 2.5s để đón đầu commit thật, tránh người dùng phải bấm 4-5 lần.
      if (activeContentHash && downloadedHash === activeContentHash && force && !downloaderFn) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          console.log(`[OneDriveSync] Nội dung chưa đổi (cùng hash). Thăm dò đợt ${attempt}/2 sau 2.5s để chờ Excel Online commit...`);
          await new Promise(r => setTimeout(r, 2500));
          try {
            let retryDl = null;
            if (source.item_id) {
              retryDl = await oneDriveService.downloadDriveItem(source.drive_id, source.item_id, ownerUserId);
            } else if (source.sharing_url) {
              retryDl = await oneDriveService.resolveAndDownloadSharedItem(source.sharing_url, ownerUserId);
            }
            if (retryDl && retryDl.buffer) {
              const retryHash = crypto.createHash('sha256').update(retryDl.buffer).digest('hex');
              if (retryHash !== activeContentHash) {
                console.log(`[OneDriveSync] Đã đón đầu thành công bản cập nhật mới từ Microsoft OneDrive ở đợt ${attempt}!`);
                dl = retryDl;
                downloadedHash = retryHash;
                break;
              }
            }
          } catch (pollErr) {
            console.warn(`[OneDriveSync] Lỗi thăm dò đợt ${attempt}:`, pollErr.message);
          }
        }
      }

      // NẾU NỘI DUNG THỰC SỰ KHÔNG THAY ĐỔI: Không tăng version ảo, cập nhật trạng thái SYNCED và báo kết quả minh bạch
      if (activeContentHash && downloadedHash === activeContentHash && source.active_snapshot_id) {
        console.log(`[OneDriveSync] File "${dl.fileName}" không có thay đổi nội dung (Hash khớp v${source.active_version}). Giữ nguyên phiên bản.`);
        await db.query(
          `UPDATE public.user_onedrive_sources
           SET sync_status = 'SYNCED',
               last_synced_at = NOW(),
               last_successful_sync_at = NOW(),
               last_error = NULL,
               etag = COALESCE($1, etag),
               ctag = COALESCE($2, ctag),
               content_hash = $3,
               last_modified_at = COALESCE($4, last_modified_at),
               updated_at = NOW()
           WHERE id = $5`,
          [
            dl.eTag || targetMetadata?.eTag || null,
            dl.cTag || targetMetadata?.cTag || null,
            downloadedHash,
            dl.lastModifiedDateTime ? new Date(dl.lastModifiedDateTime) : new Date(),
            sourceId
          ]
        );

        if (job) {
          await db.query(
            `UPDATE public.onedrive_sync_jobs
             SET status = 'COMPLETED', snapshot_id = $1, completed_at = NOW()
             WHERE id = $2`,
            [source.active_snapshot_id, job.id]
          );
        }

        return {
          success: true,
          isNewVersion: false,
          source: { ...source, sync_status: 'SYNCED', last_synced_at: new Date() },
          version: source.active_version || 1,
          fileName: dl.fileName,
          size: dl.size,
          status: 'SYNCED',
          validUnits: source.snapshot_manifest?.validUnits || 0,
          message: `Dữ liệu tệp "${dl.fileName}" đã được đối soát với OneDrive: Nội dung hiện tại đã là mới nhất (phiên bản v${source.active_version || 1}).`
        };
      }

      // 5. Lưu tệp phiên bản mới vào đĩa lưu trữ an toàn
      const fileId = crypto.randomUUID();
      const safeDiskName = `src_${sourceId}_v${nextVersion}_${fileId}_${path.basename(dl.fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const diskPath = path.join(UPLOADS_DIR, safeDiskName);
      fs.writeFileSync(diskPath, dl.buffer);

      // 6. Phân tích qua Universal Data Understanding Engine
      const parsedUniversal = await universalDataEngine.parseUniversalFile(dl.buffer, {
        fileName: dl.fileName,
        fileId: fileId,
        mimeType: dl.mimeType
      });

      if (parsedUniversal.manifest) {
        parsedUniversal.manifest.contentHash = downloadedHash;
      }

      // 7. Tạo Staging Snapshot
      const promptContext = universalDataEngine.formatUniversalPromptContext([parsedUniversal]);
      const snapRes = await db.query(
        `INSERT INTO public.onedrive_source_snapshots (
           source_id, version_number, etag, ctag, file_name, file_size, storage_path,
           manifest, data_profile, prompt_context, status, content_hash, published_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'STAGING', $11, NULL)
         RETURNING *`,
        [
          sourceId,
          nextVersion,
          dl.eTag || targetMetadata?.eTag || null,
          dl.cTag || targetMetadata?.cTag || null,
          dl.fileName,
          dl.size || 0,
          diskPath,
          JSON.stringify(parsedUniversal.manifest || {}),
          JSON.stringify(parsedUniversal.dataProfile || {}),
          promptContext || '',
          downloadedHash
        ]
      );
      const stagingSnap = snapRes.rows[0];
      stagingSnapshotId = stagingSnap.id;

      // 8. Xác minh tính toàn vẹn (Verification Gate)
      if (parsedUniversal.fileType === 'spreadsheet') {
        const sheetCount = parsedUniversal.dataProfile ? (parsedUniversal.dataProfile.sheetNames || []).length : 0;
        if (sheetCount === 0 && (!parsedUniversal.manifest || Object.keys(parsedUniversal.manifest).length === 0)) {
          throw new Error('Dữ liệu bảng tính sau khi giải mã không chứa sheet hợp lệ nào.');
        }
      }

      // 9. Publish Snapshot nguyên tử (Atomic Publication)
      await db.query(
        `UPDATE public.onedrive_source_snapshots
         SET status = 'PUBLISHED', published_at = NOW()
         WHERE id = $1`,
        [stagingSnapshotId]
      );

      // Chuyển các snapshot cũ sang trạng thái ARCHIVED
      await db.query(
        `UPDATE public.onedrive_source_snapshots
         SET status = 'ARCHIVED'
         WHERE source_id = $1 AND id != $2 AND status = 'PUBLISHED'`,
        [sourceId, stagingSnapshotId]
      );

      // Cập nhật nguồn sang trạng thái SYNCED với snapshot mới
      const updatedSourceRes = await db.query(
        `UPDATE public.user_onedrive_sources
         SET active_snapshot_id = $1,
             active_version = $2,
             file_name = $3,
             file_size = $4,
             etag = $5,
             ctag = $6,
             last_modified_at = $7,
             last_synced_at = NOW(),
             last_successful_sync_at = NOW(),
             sync_status = 'SYNCED',
             last_error = NULL,
             storage_path = $8,
             drive_id = COALESCE($9, drive_id),
             item_id = COALESCE($10, item_id),
             content_hash = $11,
             updated_at = NOW()
         WHERE id = $12
         RETURNING *`,
        [
          stagingSnapshotId,
          nextVersion,
          dl.fileName,
          dl.size || 0,
          dl.eTag || targetMetadata?.eTag || null,
          dl.cTag || targetMetadata?.cTag || null,
          dl.lastModifiedDateTime ? new Date(dl.lastModifiedDateTime) : new Date(),
          diskPath,
          dl.driveId || null,
          dl.driveItemId || null,
          downloadedHash,
          sourceId
        ]
      );

      // Cập nhật Job thành công
      await db.query(
        `UPDATE public.onedrive_sync_jobs
         SET status = 'COMPLETED', snapshot_id = $1, completed_at = NOW()
         WHERE id = $2`,
        [stagingSnapshotId, job.id]
      );

      const publishedSource = updatedSourceRes.rows[0];
      publishedSource.activeSnapshot = stagingSnap;
      publishedSource.parsedUniversal = parsedUniversal;

      return {
        success: true,
        isNewVersion: true,
        source: publishedSource,
        version: nextVersion,
        fileName: dl.fileName,
        size: dl.size,
        status: 'SYNCED',
        validUnits: parsedUniversal.manifest?.validUnits || 0,
        message: `Đã đồng bộ thành công tệp "${dl.fileName}" (phiên bản mới v${nextVersion}).`
      };
    } catch (syncErr) {
      console.error(`[OneDriveSync] Lỗi đồng bộ source ${sourceId}:`, syncErr.message);

      // Đánh dấu Staging snapshot là FAILED nếu có
      if (stagingSnapshotId) {
        await db.query(
          `UPDATE public.onedrive_source_snapshots
           SET status = 'FAILED', error_message = $1
           WHERE id = $2`,
          [syncErr.message, stagingSnapshotId]
        );
      }

      // Đánh dấu nguồn sang trạng thái FAILED (bảo toàn active_snapshot_id cũ) - chỉ cập nhật nếu đúng chủ sở hữu
      if (syncErr.statusCode !== 404) {
        await db.query(
          `UPDATE public.user_onedrive_sources
           SET sync_status = 'FAILED', last_error = $1, updated_at = NOW()
           WHERE id = $2 AND owner_user_id = $3`,
          [syncErr.message, sourceId, ownerUserId]
        );
      }

      // Đánh dấu Job thất bại nếu có
      if (job) {
        await db.query(
          `UPDATE public.onedrive_sync_jobs
           SET status = 'FAILED', error_message = $1, completed_at = NOW()
           WHERE id = $2`,
          [syncErr.message, job.id]
        );
      }

      throw syncErr;
    } finally {
      ongoingSyncPromises.delete(sourceId);
    }
  })();

  ongoingSyncPromises.set(sourceId, syncPromise);
  return syncPromise;
}

/**
 * Platform-Level Query-Time Freshness Guard for any My Agent.
 * 
 * 1. Checks if user provided a new OneDrive link -> Auto-registers it.
 * 2. Fetches all connected sources for this agent.
 * 3. Validates freshness against Microsoft Graph.
 * 4. Auto-syncs if modified on OneDrive.
 * 5. Loads active published snapshot into activeFiles & activeSpreadsheets.
 * 6. Injects warning if Graph is offline (never silently serves stale data).
 */
async function ensureAgentSourcesFreshness({
  agent,
  userId,
  conversationId = null,
  userMessage = ''
}) {
  const freshnessNotes = [];
  const activeFiles = [];
  const activeSpreadsheets = [];

  // A. Kiểm tra nếu trong câu hỏi có kèm liên kết chia sẻ OneDrive mới
  const ONEDRIVE_LINK_REGEX = /https:\/\/(?:1drv\.ms|onedrive\.live\.com|[a-zA-Z0-9-]+\.sharepoint\.com)\/[^\s<>"')]+/gi;
  let detectedLinks = (userMessage || '').match(ONEDRIVE_LINK_REGEX) || [];

  if (detectedLinks.length === 0 && conversationId && /^[0-9a-f-]{36}$/i.test(conversationId)) {
    try {
      const recentUserMsgs = await db.query(
        `SELECT content FROM ai_messages
         WHERE conversation_id = $1 AND role = 'user'
         ORDER BY created_at DESC LIMIT 5`,
        [conversationId]
      );
      for (const row of recentUserMsgs.rows) {
        const found = (row.content || '').match(ONEDRIVE_LINK_REGEX);
        if (found && found.length > 0) {
          detectedLinks = found;
          break;
        }
      }
    } catch (histErr) {
      console.warn('[OneDriveSourceService] Lỗi tìm link trong lịch sử:', histErr.message);
    }
  }

  let accessToken = null;
  try {
    accessToken = await oneDriveService.getUserValidAccessToken(userId);
  } catch (tokenErr) {
    // Người dùng chưa liên kết hoặc token lỗi
  }

  // B. Xử lý nạp / đăng ký nguồn mới nếu người dùng gửi link
  if (detectedLinks.length > 0 && accessToken) {
    for (const url of detectedLinks) {
      try {
        const dl = await oneDriveService.resolveAndDownloadSharedItem(url, userId);
        const fileId = crypto.randomUUID();
        const safeDiskName = `src_new_${fileId}_${path.basename(dl.fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const diskPath = path.join(UPLOADS_DIR, safeDiskName);
        fs.writeFileSync(diskPath, dl.buffer);

        const parsed = await universalDataEngine.parseUniversalFile(dl.buffer, {
          fileName: dl.fileName,
          fileId: fileId,
          mimeType: dl.mimeType
        });

        const registeredSource = await registerOrUpdateSource({
          ownerUserId: userId,
          agentId: agent.id,
          conversationId,
          sharingUrl: url,
          dl,
          parsedUniversal: parsed,
          storagePath: diskPath
        });

        freshnessNotes.push(
          `✅ [ONEDRIVE ĐÃ NẠP & KẾT NỐI NGUỒN]: Đã tải và đăng ký tệp "${dl.fileName}" (${(dl.size / 1024).toFixed(1)} KB) ` +
          `làm nguồn dữ liệu thường trực cho Agent. Phiên bản hiện tại: v${registeredSource.active_version}. ` +
          `Các lần chỉnh sửa tệp trên OneDrive trong tương lai sẽ được hệ thống tự động nhận diện và cập nhật.`
        );
      } catch (regErr) {
        freshnessNotes.push(
          `⚠️ [CẢNH BÁO LỖI NẠP TỆP ONEDRIVE]: Không thể đọc tệp từ liên kết ${url}: ${regErr.message}`
        );
      }
    }
  }

  // C. Lấy tất cả các nguồn dữ liệu OneDrive đã kết nối cho Agent này
  const connectedSources = await getConnectedSourcesForAgent({
    ownerUserId: userId,
    agentId: agent.id,
    conversationId
  });

  if (connectedSources.length === 0) {
    return { activeFiles, activeSpreadsheets, freshnessNotes, connectedSources: [] };
  }

  // D. Query-Time Freshness Guard: Kiểm tra độ mới của từng nguồn trước khi Agent trả lời
  for (const src of connectedSources) {
    let activeProfile = src.snapshot_data_profile || null;
    let activeManifest = src.snapshot_manifest || null;
    let promptContext = src.snapshot_prompt_context || '';

    let isOffline = false;
    let offlineReason = null;

    if (accessToken) {
      const freshness = await checkSourceFreshness(src, accessToken);

      if (freshness.isGraphReachable) {
        if (!freshness.isFresh) {
          // PHÁT HIỆN TỆP TRÊN ONEDRIVE ĐÃ THAY ĐỔI -> TỰ ĐỘNG ĐỒNG BỘ PHIÊN BẢN MỚI
          try {
            const syncResult = await syncSourceVersion(src.id, userId, {
              jobType: 'QUERY_TIME',
              targetMetadata: freshness.currentMetadata
            });

            activeProfile = syncResult.source.activeSnapshot?.data_profile || activeProfile;
            activeManifest = syncResult.source.activeSnapshot?.manifest || activeManifest;
            promptContext = syncResult.source.activeSnapshot?.prompt_context || promptContext;

            freshnessNotes.push(
              `🔄 [TỰ ĐỘNG ĐỒNG BỘ ONEDRIVE THÀNH CÔNG]: Tệp "${src.file_name}" vừa được chỉnh sửa trên OneDrive ` +
              `và hệ thống đã tự động đồng bộ phiên bản mới nhất (v${syncResult.version}) trước khi trả lời. ` +
              `Thời gian sửa đổi gần nhất từ Microsoft: ${new Date(freshness.currentMetadata.lastModifiedDateTime).toLocaleString('vi-VN')}.`
            );
          } catch (syncErr) {
            isOffline = true;
            offlineReason = `Lỗi đồng bộ tự động (${syncErr.message})`;
            freshnessNotes.push(
              `⚠️ [CẢNH BÁO ĐỘ MỚI ONEDRIVE - NGUỒN NGOẠI TUYẾN]: Tệp "${src.file_name}" trên OneDrive đã có bản sửa đổi mới ` +
              `nhưng quá trình đồng bộ tự động gặp lỗi (${syncErr.message}). ` +
              `Hệ thống đang tạm thời sử dụng bản sao lưu nội bộ (lúc ${new Date(src.last_synced_at).toLocaleString('vi-VN')}). ` +
              `Hãy nhắc người dùng lưu ý số liệu có thể chưa phản ánh thay đổi mới nhất.`
            );
          }
        } else {
          // Tệp hoàn toàn mới (Đã đồng bộ) -> Báo cáo trạng thái Fresh
          freshnessNotes.push(
            `⚡ [DỮ LIỆU ONEDRIVE ĐÃ XÁC MINH MỚI NHẤT]: Tệp "${src.file_name}" (phiên bản v${src.active_version}) ` +
            `vừa được xác thực nguyên vẹn trực tuyến với Microsoft Graph API tại thời điểm truy vấn (Trạng thái: Fresh).`
          );
        }
      } else {
        // Microsoft Graph API tạm thời không phản hồi (Timeout / Network)
        isOffline = true;
        offlineReason = `Không thể kết nối tới Microsoft Graph API (${freshness.reason})`;
        freshnessNotes.push(
          `⚠️ [CẢNH BÁO ĐỘ MỚI - NGUỒN NGOẠI TUYẾN]: Không thể kết nối tới Microsoft Graph API để xác minh độ mới của "${src.file_name}" ` +
          `(Lỗi: ${freshness.reason}). ` +
          `Dữ liệu đang dùng là bản sao lưu nội bộ v${src.active_version} đã đồng bộ lúc ${new Date(src.last_synced_at).toLocaleString('vi-VN')}. ` +
          `Không được cam kết đây là số liệu mới nhất nếu người dùng vừa sửa đổi tệp gần đây.`
        );
      }
    } else {
      isOffline = true;
      offlineReason = 'Tài khoản Microsoft OneDrive hiện đã ngắt kết nối (Chế độ Ngoại tuyến)';
      freshnessNotes.push(
        `⚠️ [TÀI KHOẢN MICROSOFT ĐÃ NGẮT KẾT NỐI - NGUỒN NGOẠI TUYẾN]: Tài khoản Microsoft OneDrive cá nhân hiện đã ngắt kết nối. ` +
        `Hệ thống đang truy xuất dữ liệu từ BẢN SAO LƯU NỘI BỘ (Phiên bản v${src.active_version}, thời điểm đồng bộ lần cuối: ${new Date(src.last_synced_at).toLocaleString('vi-VN')}). ` +
        `Số liệu có thể chưa phản ánh những thay đổi mới nhất trên OneDrive nếu tệp gốc đã bị chỉnh sửa.`
      );
    }

    // Đưa snapshot vào danh sách activeFiles & activeSpreadsheets cho Agent sử dụng
    if (activeProfile) {
      activeSpreadsheets.push(activeProfile);
    }

    activeFiles.push({
      id: src.id,
      name: src.file_name,
      fileName: src.file_name,
      fileType: 'spreadsheet',
      mimeType: src.mime_type,
      size: src.file_size,
      dataProfile: activeProfile,
      manifest: activeManifest,
      promptText: promptContext,
      source: 'onedrive_registry',
      version: src.active_version,
      lastSyncedAt: src.last_synced_at,
      isOffline: isOffline,
      offlineReason: offlineReason,
      syncStatus: src.sync_status
    });
  }

  return { activeFiles, activeSpreadsheets, freshnessNotes, connectedSources };
}

/**
 * Thao tác B — Gỡ một tệp khỏi Agent (Unlink Source from Agent):
 * - Đánh dấu trạng thái sync_status = 'DISCONNECTED' và hủy liên kết agent_id = NULL.
 * - Loại bỏ tệp khỏi tập nguồn được phép truy xuất cho các truy vấn mới của Agent.
 * - Bảo tồn các snapshot lịch sử trong DB theo chính sách lưu giữ kiểm toán.
 * - Dọn dẹp bản sao trong ai_attachments để tránh việc truy xuất lại tệp đã gỡ trong hội thoại cũ.
 */
async function disconnectSource(sourceId, ownerUserId) {
  const res = await db.query(
    `UPDATE public.user_onedrive_sources
     SET sync_status = 'DISCONNECTED', agent_id = NULL, updated_at = NOW()
     WHERE id = $1 AND owner_user_id = $2
     RETURNING id, file_name`,
    [sourceId, ownerUserId]
  );

  if (res.rows.length === 0) {
    const err = new Error('Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập.');
    err.statusCode = 404;
    throw err;
  }

  const disconnected = res.rows[0];

  // Dọn dẹp ai_attachments cho tệp này để tránh hồi sinh tệp đã gỡ trong các hội thoại cũ
  try {
    await db.query(
      `DELETE FROM public.ai_attachments 
       WHERE file_name = $1 AND (user_id = $2::text OR user_id IN (SELECT username FROM public.users WHERE user_id = $3))`,
      [disconnected.file_name, ownerUserId, ownerUserId]
    );
  } catch (cleanAttErr) {
    console.warn('[OneDriveSourceService] Cảnh báo dọn dẹp ai_attachments khi gỡ tệp:', cleanAttErr.message);
  }

  return disconnected;
}

function resolveStoragePath(p) {
  if (!p) return null;
  if (fs.existsSync(p)) return p;
  // Nếu đang chạy trong Docker container (/app) nhưng đường dẫn lưu là Windows (D:\...)
  const toContainer = p.replace(/^[a-zA-Z]:[\\\/].*?[\\\/]auth-service[\\\/]/, '/app/').replace(/\\/g, '/');
  if (fs.existsSync(toContainer)) return toContainer;
  // Nếu đang chạy trên máy Host (Windows) nhưng đường dẫn là container (/app/...)
  const toHost = p.replace(/^\/app[\\\/]/, path.resolve(__dirname, '..') + path.sep).replace(/\//g, path.sep);
  if (fs.existsSync(toHost)) return toHost;
  // Kiểm tra trực tiếp trong thư mục data/uploads theo basename
  const directUpload = path.resolve(__dirname, '..', 'data', 'uploads', path.basename(p));
  if (fs.existsSync(directUpload)) return directUpload;
  return null;
}

/**
 * Thao tác C — Xóa vĩnh viễn dữ liệu đã nhập (Purge / Hard-Delete Imported Data):
 * - Xóa tất cả các bản copy vật lý trên đĩa (uploads).
 * - Xóa tất cả các bản ghi snapshots trong onedrive_source_snapshots.
 * - Xóa tất cả các job log trong onedrive_sync_jobs.
 * - Xóa tất cả ai_attachments liên quan.
 * - Xóa bản ghi trong user_onedrive_sources.
 */
async function purgeSource(sourceId, ownerUserId) {
  // 1. Kiểm tra nguồn và quyền sở hữu
  const sRes = await db.query(
    `SELECT * FROM public.user_onedrive_sources WHERE id = $1 AND owner_user_id = $2`,
    [sourceId, ownerUserId]
  );

  if (sRes.rows.length === 0) {
    const err = new Error('Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập.');
    err.statusCode = 404;
    throw err;
  }

  const source = sRes.rows[0];

  // 2. Lấy danh sách đường dẫn tệp trên đĩa cần xóa từ tất cả snapshots
  const snapRes = await db.query(
    `SELECT storage_path FROM public.onedrive_source_snapshots WHERE source_id = $1`,
    [sourceId]
  );

  const pathsToDelete = new Set();
  if (source.storage_path) pathsToDelete.add(source.storage_path);
  for (const row of snapRes.rows) {
    if (row.storage_path) pathsToDelete.add(row.storage_path);
  }

  // Xóa các file vật lý trên đĩa (hỗ trợ cả container Linux và host Windows)
  for (const p of pathsToDelete) {
    try {
      const resolved = resolveStoragePath(p);
      if (resolved && fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
    } catch (fsErr) {
      console.warn(`[OneDriveSourceService] Cảnh báo xóa file vật lý (${p}):`, fsErr.message);
    }
  }

  // 3. Xóa các bản ghi liên quan trong DB
  await db.query(`DELETE FROM public.onedrive_sync_jobs WHERE source_id = $1`, [sourceId]);
  await db.query(`DELETE FROM public.onedrive_source_snapshots WHERE source_id = $1`, [sourceId]);
  await db.query(`DELETE FROM public.user_onedrive_sources WHERE id = $1`, [sourceId]);

  // 4. Xóa ai_attachments liên quan
  try {
    await db.query(
      `DELETE FROM public.ai_attachments 
       WHERE file_name = $1 AND (user_id = $2::text OR user_id IN (SELECT username FROM public.users WHERE user_id = $3))`,
      [source.file_name, ownerUserId, ownerUserId]
    );
  } catch (e) {}

  return {
    success: true,
    purgedSourceId: sourceId,
    purgedFileName: source.file_name,
    message: `Đã xóa vĩnh viễn toàn bộ dữ liệu, bản sao lưu và chỉ mục của tệp "${source.file_name}".`
  };
}

/**
 * Imports and connects a OneDrive file selected from File Picker as a permanent agent source.
 * Downloads the driveItem, saves to disk, parses via Universal Data Engine, and registers source v1.
 */
async function importSourceFromDriveItem({ ownerUserId, agentId = null, conversationId = null, itemId, driveId = null }) {
  if (!ownerUserId || !itemId) {
    throw new Error('Thiếu ownerUserId hoặc itemId để nhập tệp OneDrive.');
  }

  // 1. Tải tệp an toàn từ Microsoft Graph (với xác thực chữ ký Magic Bytes và giới hạn 20MB)
  const dl = await oneDriveService.downloadDriveItem(driveId, itemId, ownerUserId);

  // 2. Lưu tệp vào thư mục uploads an toàn
  const fileId = crypto.randomUUID();
  const safeDiskName = `src_picker_${fileId}_${path.basename(dl.fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const diskPath = path.join(UPLOADS_DIR, safeDiskName);
  fs.writeFileSync(diskPath, dl.buffer);

  // 3. Phân tích nội dung qua Universal Data Understanding Engine
  const parsedUniversal = await universalDataEngine.parseUniversalFile(dl.buffer, {
    fileName: dl.fileName,
    fileId: fileId,
    mimeType: dl.mimeType
  });

  // 4. Đăng ký hoặc cập nhật nguồn và xuất bản snapshot v1
  const registeredSource = await registerOrUpdateSource({
    ownerUserId,
    agentId,
    conversationId,
    sharingUrl: dl.webUrl || null,
    dl,
    parsedUniversal,
    storagePath: diskPath
  });

  return registeredSource;
}

/**
 * Trích xuất cấu trúc dữ liệu chi tiết (worksheet, table, columns, sample rows, document summary)
 * từ manifest và dataProfile của Universal Data Understanding Engine.
 */
function extractDataStructureSummary(manifest = {}, dataProfile = {}, rawFileName = 'file') {
  const fileType = manifest.fileType || dataProfile.fileType || 'spreadsheet';
  const isSpreadsheet = fileType === 'spreadsheet' || Boolean(dataProfile.sheetNames);

  let sheets = [];
  let totalDataRows = 0;

  if (isSpreadsheet && dataProfile.sheetNames && Array.isArray(dataProfile.sheetNames)) {
    sheets = dataProfile.sheetNames.map(sName => {
      const sh = (dataProfile.sheets && dataProfile.sheets[sName]) || {};
      const cols = Array.isArray(sh.columns) ? sh.columns : [];
      const colNames = cols.map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean);

      // Nhận diện Excel Table nếu có từ metadata
      const tables = [];
      if (sh.tableName) tables.push(sh.tableName);
      if (sh.tables && Array.isArray(sh.tables)) tables.push(...sh.tables);

      // Trích xuất tối đa 3-5 dòng mẫu cho người dùng xem trước nội dung
      const sampleRows = Array.isArray(sh.rows) ? sh.rows.slice(0, 3) : [];
      const validRows = sh.validDataRows || 0;
      totalDataRows += validRows;

      return {
        sheetName: sName,
        totalRawRows: sh.totalRawRows || 0,
        validDataRows: validRows,
        blankRowsCount: sh.blankRowsCount || 0,
        columnsCount: colNames.length,
        columns: colNames,
        tables,
        sampleRows,
        warnings: sh.warnings || []
      };
    });
  }

  let documentSummary = null;
  if (!isSpreadsheet) {
    documentSummary = {
      fileType: fileType,
      charCount: manifest.totalUnits || 0,
      sectionsCount: Array.isArray(manifest.sections) ? manifest.sections.length : 0,
      headings: Array.isArray(manifest.sections) ? manifest.sections.map(s => s.heading).filter(Boolean).slice(0, 10) : [],
      sampleExcerpt: manifest.sampleExcerpt || ''
    };
  }

  const parseStatus = manifest.parseStatus || (sheets.length > 0 ? 'READY' : 'NOT_PARSED');

  return {
    fileType: isSpreadsheet ? 'spreadsheet' : fileType,
    totalSheets: sheets.length,
    sheetNames: isSpreadsheet ? (dataProfile.sheetNames || []) : [],
    sheets,
    totalDataRows: isSpreadsheet ? totalDataRows : (manifest.totalUnits || 0),
    validUnits: isSpreadsheet ? totalDataRows : (manifest.validUnits || manifest.totalUnits || 0),
    totalUnits: manifest.totalUnits || (isSpreadsheet ? totalDataRows : 0),
    documentSummary,
    parseStatus,
    warnings: manifest.warnings || [],
    errors: manifest.errors || [],
    scopeNote: isSpreadsheet
      ? `AI sẽ sử dụng toàn bộ workbook đã phân tích (${sheets.length} sheet, ~${totalDataRows} dòng dữ liệu) để đối soát và trả lời câu hỏi. Không giới hạn riêng một sheet.`
      : `AI sẽ đọc toàn bộ nội dung tài liệu đã phân đoạn để trích xuất và đối soát dữ liệu.`
  };
}

/**
 * Phân tích và trả về cấu trúc dữ liệu của tệp OneDrive (worksheet, table, columns, sample rows).
 * - Nếu tệp đã có trong Source Registry (đã liên kết): Trả về ngay lập tức từ active snapshot trong DB (siêu nhanh, 0 tốn băng thông).
 * - Nếu tệp chưa liên kết:
 *     + Nếu preview === true: Tải tệp tạm vào RAM và bóc tách qua Universal Engine, trả về cấu trúc mà không ghi vĩnh viễn vào DB.
 *     + Nếu preview === false: Trả về trạng thái "Chưa phân tích" kèm metadata cơ bản.
 */
async function inspectDriveItemStructure({ ownerUserId, itemId, driveId = null, preview = false }) {
  if (!ownerUserId || !itemId) {
    throw new Error('Thiếu ownerUserId hoặc itemId để kiểm tra cấu trúc tệp.');
  }

  // 1. Kiểm tra nguồn đã liên kết trong DB hay chưa
  const existingRes = await db.query(
    `SELECT s.*, 
            snp.id as snapshot_id,
            snp.version_number,
            snp.status as snapshot_status,
            snp.manifest,
            snp.data_profile,
            COALESCE(a.name, CASE WHEN s.agent_id = 'excel-data-pro' THEN 'Excel-Data-Pro' ELSE s.agent_id END) AS agent_name
     FROM public.user_onedrive_sources s
     LEFT JOIN public.onedrive_source_snapshots snp ON s.active_snapshot_id = snp.id
     LEFT JOIN public.user_agents a ON a.id::text = s.agent_id
     WHERE s.owner_user_id = $1 
       AND s.item_id = $2
       AND s.sync_status != 'DISCONNECTED'
     ORDER BY s.updated_at DESC LIMIT 1`,
    [ownerUserId, itemId]
  );

  if (existingRes.rows.length > 0) {
    const src = existingRes.rows[0];
    const structure = extractDataStructureSummary(src.manifest || {}, src.data_profile || {}, src.file_name);

    return {
      itemId: src.item_id,
      driveId: src.drive_id,
      fileName: src.file_name,
      fileSize: src.file_size,
      mimeType: src.mime_type,
      extension: path.extname(src.file_name).toLowerCase(),
      lastModifiedDateTime: src.last_modified_at,
      webUrl: src.sharing_url,
      isLinked: true,
      linkedSourceId: src.id,
      linkedAgentId: src.agent_id,
      linkedAgentName: src.agent_name,
      linkedVersion: src.active_version,
      linkedSyncStatus: src.sync_status,
      lastSyncedAt: src.last_synced_at,
      parseStatus: structure.parseStatus,
      isSupported: true,
      unsupportedReason: null,
      location: {
        driveId: src.drive_id,
        webUrl: src.sharing_url
      },
      structure
    };
  }

  // 2. Tệp chưa liên kết: Tải và bóc tách tạm nếu preview = true
  if (preview) {
    const dl = await oneDriveService.downloadDriveItem(driveId, itemId, ownerUserId);
    const parsedUniversal = await universalDataEngine.parseUniversalFile(dl.buffer, {
      fileName: dl.fileName,
      mimeType: dl.mimeType
    });

    const structure = extractDataStructureSummary(parsedUniversal.manifest, parsedUniversal.dataProfile, dl.fileName);

    return {
      itemId,
      driveId: dl.driveId || driveId,
      fileName: dl.fileName,
      fileSize: dl.size,
      mimeType: dl.mimeType,
      extension: path.extname(dl.fileName).toLowerCase(),
      lastModifiedDateTime: dl.lastModifiedDateTime,
      webUrl: dl.webUrl,
      isLinked: false,
      linkedSourceId: null,
      linkedAgentId: null,
      linkedAgentName: null,
      linkedVersion: null,
      linkedSyncStatus: null,
      lastSyncedAt: null,
      parseStatus: structure.parseStatus,
      isSupported: true,
      unsupportedReason: null,
      location: {
        driveId: dl.driveId || driveId,
        webUrl: dl.webUrl
      },
      structure
    };
  }

  // 3. Nếu chưa yêu cầu preview, trả về trạng thái Chưa phân tích
  return {
    itemId,
    driveId,
    fileName: 'Tệp OneDrive',
    isLinked: false,
    parseStatus: 'NOT_PARSED',
    structure: {
      fileType: 'unknown',
      totalSheets: 0,
      sheetNames: [],
      sheets: [],
      totalDataRows: 0,
      parseStatus: 'NOT_PARSED',
      scopeNote: 'Tệp chưa được phân tích cấu trúc. Bấm "Xem trước cấu trúc" hoặc "Liên kết với Agent" để đọc dữ liệu.'
    }
  };
}

/**
 * Lấy cấu trúc dữ liệu chi tiết của một nguồn đã kết nối theo sourceId (kiểm tra owner_user_id)
 */
async function getSourceStructureById({ ownerUserId, sourceId }) {
  if (!ownerUserId || !sourceId) {
    throw new Error('Thiếu tham số ownerUserId hoặc sourceId.');
  }

  const res = await db.query(
    `SELECT s.*, 
            snp.id as snapshot_id,
            snp.version_number,
            snp.status as snapshot_status,
            snp.manifest,
            snp.data_profile,
            snp.prompt_context,
            COALESCE(a.name, CASE WHEN s.agent_id = 'excel-data-pro' THEN 'Excel-Data-Pro' ELSE s.agent_id END) AS agent_name
     FROM public.user_onedrive_sources s
     LEFT JOIN public.onedrive_source_snapshots snp ON s.active_snapshot_id = snp.id
     LEFT JOIN public.user_agents a ON a.id::text = s.agent_id
     WHERE s.id = $1 AND s.owner_user_id = $2
     ORDER BY s.updated_at DESC LIMIT 1`,
    [sourceId, ownerUserId]
  );

  if (res.rows.length === 0) {
    return null;
  }

  const src = res.rows[0];
  const structure = extractDataStructureSummary(src.manifest || {}, src.data_profile || {}, src.file_name);

  return {
    sourceId: src.id,
    itemId: src.item_id,
    driveId: src.drive_id,
    fileName: src.file_name,
    fileSize: src.file_size,
    mimeType: src.mime_type,
    activeVersion: src.active_version,
    syncStatus: src.sync_status,
    lastSyncedAt: src.last_synced_at,
    lastModifiedAt: src.last_modified_at,
    agentId: src.agent_id,
    agentName: src.agent_name,
    webUrl: src.sharing_url,
    storagePath: src.storage_path,
    structure
  };
}


/**
 * Xử lý khi một tệp nguồn bị xóa trên OneDrive upstream:
 * - Đánh dấu sync_status = 'DELETED_UPSTREAM'
 * - Gỡ active_snapshot_id (không đưa vào truy xuất RAG của Agent)
 * - Đặt poll_status = 'IDLE'
 * - Dọn dẹp ai_attachments liên quan để chống hồi sinh trong hội thoại cũ
 * @param {string} sourceId ID của nguồn trong user_onedrive_sources
 * @param {string} ownerUserId User ID của chủ sở hữu nguồn (Tenant Isolation)
 */
async function handleUpstreamDeletedSource(sourceId, ownerUserId) {
  if (!sourceId || !ownerUserId) {
    throw new Error('Thiếu sourceId hoặc ownerUserId để xử lý nguồn bị xóa upstream.');
  }

  const res = await db.query(
    `UPDATE public.user_onedrive_sources
     SET sync_status = 'DELETED_UPSTREAM',
         active_snapshot_id = NULL,
         agent_id = NULL,
         poll_status = 'IDLE',
         updated_at = NOW()
     WHERE id = $1 AND owner_user_id = $2
     RETURNING id, file_name, owner_user_id`,
    [sourceId, ownerUserId]
  );

  if (res.rows.length === 0) {
    const err = new Error('Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập (Tenant Mismatch).');
    err.statusCode = 404;
    throw err;
  }

  const deleted = res.rows[0];

  try {
    await db.query(
      `DELETE FROM public.ai_attachments 
       WHERE file_name = $1 AND (user_id = $2::text OR user_id IN (SELECT username FROM public.users WHERE user_id = $3))`,
      [deleted.file_name, ownerUserId, ownerUserId]
    );
  } catch (cleanAttErr) {
    console.warn('[OneDriveSourceService] Cảnh báo dọn dẹp ai_attachments khi tệp bị xóa upstream:', cleanAttErr.message);
  }

  return deleted;
}

/**
 * Đăng ký hoặc cập nhật thư mục theo dõi (Watched Folder)
 */
async function registerWatchedFolder({ ownerUserId, folderId, folderName, driveId = null }) {
  if (!ownerUserId || !folderId) {
    throw new Error('Thiếu ownerUserId hoặc folderId khi đăng ký watched folder.');
  }
  const existRes = await db.query(
    `SELECT * FROM public.user_onedrive_sources WHERE owner_user_id = $1 AND item_id = $2 LIMIT 1`,
    [ownerUserId, folderId]
  );
  if (existRes.rows.length > 0) {
    const upd = await db.query(
      `UPDATE public.user_onedrive_sources
       SET is_watched = TRUE, source_type = 'FOLDER', file_name = $1, drive_id = COALESCE($2, drive_id), updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [folderName || existRes.rows[0].file_name || 'Watched Folder', driveId, existRes.rows[0].id]
    );
    return upd.rows[0];
  }

  const ins = await db.query(
    `INSERT INTO public.user_onedrive_sources 
       (owner_user_id, item_id, drive_id, file_name, source_type, is_watched, sync_status, poll_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'FOLDER', TRUE, 'SYNCED', 'IDLE', NOW(), NOW())
     RETURNING *`,
    [ownerUserId, folderId, driveId, folderName || 'Watched Folder']
  );
  return ins.rows[0];
}

module.exports = {
  handleUpstreamDeletedSource,
  registerWatchedFolder,
  registerOrUpdateSource,
  getConnectedSourcesForAgent,
  checkSourceFreshness,
  syncSourceVersion,
  ensureAgentSourcesFreshness,
  disconnectSource,
  purgeSource,
  importSourceFromDriveItem,
  extractDataStructureSummary,
  inspectDriveItemStructure,
  getSourceStructureById
};
