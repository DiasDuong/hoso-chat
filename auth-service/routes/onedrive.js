/**
 * SOTRANS HUB — ONEDRIVE SOURCES & WEBHOOK ROUTER
 * 
 * Provides:
 * 1. Microsoft Graph Subscription Validation Handshake (GET /webhook)
 * 2. Microsoft Graph Change Notification Handler (POST /webhook)
 * 3. Scheduled / n8n Reconciliation Trigger (POST /reconcile)
 * 4. User Connected Sources API (GET /sources)
 * 5. Manual Source Re-sync Trigger (POST /sources/:id/sync)
 * 6. Disconnect Source API (DELETE /sources/:id)
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');
const oneDriveService = require('../services/oneDriveService');
const oneDriveSourceService = require('../services/oneDriveSourceService');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';

/**
 * 1. GET /api/onedrive/webhook
 * Microsoft Graph Webhook Subscription Validation Handshake.
 * Graph expects HTTP 200 and plain text response matching validationToken.
 */
router.get('/webhook', (req, res) => {
  const validationToken = req.query.validationToken;
  if (validationToken) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(validationToken);
  }
  return res.status(400).send('Thiếu validationToken trong yêu cầu Microsoft Graph handshake.');
});

/**
 * 2. POST /api/onedrive/webhook
 * Handles Microsoft Graph change notifications.
 * Verifies clientState, enqueues sync jobs, returns 202 Accepted immediately (<3s).
 */
router.post('/webhook', async (req, res) => {
  // Trả về 202 Accepted ngay lập tức theo yêu cầu của Microsoft Graph
  res.status(202).send('Accepted');

  const notifications = req.body?.value || [];
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return;
  }

  for (const notif of notifications) {
    try {
      const { subscriptionId, clientState, resource } = notif;
      if (!subscriptionId) continue;

      // Xác thực subscription và clientState trong cơ sở dữ liệu
      const subRes = await db.query(
        `SELECT * FROM public.onedrive_graph_subscriptions WHERE subscription_id = $1 AND status = 'ACTIVE'`,
        [subscriptionId]
      );

      if (subRes.rows.length === 0) {
        console.warn(`[OneDriveWebhook] Bỏ qua notification cho subscription không tồn tại: ${subscriptionId}`);
        continue;
      }

      const sub = subRes.rows[0];
      if (sub.client_state !== clientState) {
        console.warn(`[OneDriveWebhook] CẢNH BÁO: clientState không khớp cho subscription ${subscriptionId}`);
        continue;
      }

      // Tìm các nguồn OneDrive thuộc sở hữu của người dùng này
      const sourcesRes = await db.query(
        `SELECT id, owner_user_id, file_name FROM public.user_onedrive_sources 
         WHERE owner_user_id = $1 AND sync_status != 'DISCONNECTED'`,
        [sub.user_id]
      );

      for (const src of sourcesRes.rows) {
        // Enqueue sync job chạy nền bất đồng bộ
        oneDriveSourceService.syncSourceVersion(src.id, src.owner_user_id, {
          jobType: 'WEBHOOK'
        }).catch(err => {
          console.warn(`[OneDriveWebhook] Lỗi đồng bộ ngầm cho file "${src.file_name}":`, err.message);
        });
      }
    } catch (notifErr) {
      console.warn('[OneDriveWebhook] Lỗi xử lý notification block:', notifErr.message);
    }
  }
});

/**
 * 2b. GET /api/onedrive/files
 * Lists OneDrive files and folders for the connected user.
 * Supports folder navigation, search, and pagination.
 * Cross-references with existing user_onedrive_sources to indicate already-linked files.
 */
router.get('/files', verifyToken, async (req, res) => {
  try {
    const { folder_id = 'root', search = '', limit = 20, skip_token = null } = req.query;

    const listResult = await oneDriveService.listDriveItems(req.user.user_id, {
      folderId: folder_id,
      search,
      limit,
      skipToken: skip_token
    });

    // Lấy danh sách các nguồn tệp đang active của người dùng này để đánh dấu
    const existingRes = await db.query(
      `SELECT s.id, s.item_id, s.file_name, s.active_version, s.sync_status, s.agent_id, s.last_synced_at,
              COALESCE(a.name, CASE WHEN s.agent_id = 'excel-data-pro' THEN 'Excel-Data-Pro' ELSE s.agent_id END) AS agent_name,
              snp.id AS snapshot_id,
              snp.manifest AS snapshot_manifest,
              snp.data_profile AS snapshot_data_profile
       FROM public.user_onedrive_sources s
       LEFT JOIN public.user_agents a ON a.id::text = s.agent_id
       LEFT JOIN public.onedrive_source_snapshots snp ON s.active_snapshot_id = snp.id
       WHERE s.owner_user_id = $1 AND s.sync_status != 'DISCONNECTED'`,
      [req.user.user_id]
    );

    const linkedItemsMap = new Map();
    const linkedByNameMap = new Map();
    for (const row of existingRes.rows) {
      if (row.item_id) {
        linkedItemsMap.set(row.item_id, row);
      }
      if (row.file_name) {
        linkedByNameMap.set(row.file_name.toLowerCase(), row);
      }
    }

    const enrichedItems = listResult.items.map(item => {
      const linked = linkedItemsMap.get(item.id) || linkedByNameMap.get((item.name || '').toLowerCase());
      if (linked && item.id && linked.item_id !== item.id) {
        // Cập nhật lại item_id mới nhất từ OneDrive
        db.query('UPDATE public.user_onedrive_sources SET item_id = $1 WHERE id = $2', [item.id, linked.id]).catch(() => {});
      }
      const mn = linked?.snapshot_manifest || {};
      const dp = linked?.snapshot_data_profile || {};
      const sheetNames = dp.sheetNames || mn.sheets || [];
      const totalUnits = mn.totalUnits || 0;
      const validUnits = mn.validUnits || 0;

      return {
        ...item,
        isLinked: Boolean(linked),
        linkedSourceId: linked ? linked.id : null,
        linkedAgentId: linked ? linked.agent_id : null,
        linkedAgentName: linked ? linked.agent_name : null,
        linkedVersion: linked ? linked.active_version : null,
        linkedSyncStatus: linked ? linked.sync_status : null,
        lastSyncedAt: linked ? linked.last_synced_at : null,
        hasSnapshot: Boolean(linked && linked.snapshot_id),
        parseStatus: linked ? (mn.parseStatus || (sheetNames.length > 0 ? 'READY' : 'NOT_PARSED')) : 'NOT_PARSED',
        sheetNames,
        sheetCount: sheetNames.length,
        totalUnits,
        validUnits,
        scopeNote: sheetNames.length > 0 ? `Toàn bộ workbook (${sheetNames.length} sheet, ~${validUnits} dòng dữ liệu)` : null
      };
    });

    return res.json({
      success: true,
      parentFolder: listResult.parentFolder,
      items: enrichedItems,
      nextSkipToken: listResult.nextSkipToken,
      total: enrichedItems.length
    });
  } catch (err) {
    if (err.message?.includes('chưa kết nối') || err.message?.includes('hết hạn')) {
      return res.status(401).json({
        success: false,
        notConnected: true,
        error: err.message
      });
    }
    return res.status(500).json({
      success: false,
      error: `Không thể đọc danh mục tệp OneDrive: ${err.message}`
    });
  }
});

/**
 * 2b. POST /api/onedrive/files/inspect & GET /api/onedrive/files/:itemId/inspect
 * Inspects and returns deep data structure (worksheets, tables, columns, sample rows, document summary).
 * - If already linked: instantly retrieved from active snapshot in DB (0 download).
 * - If not linked & preview requested: safely downloads to memory and parses through Universal Engine.
 */
router.post('/files/inspect', verifyToken, async (req, res) => {
  try {
    const { itemId, driveId = null, preview = false } = req.body;
    if (!itemId || typeof itemId !== 'string' || !/^[a-zA-Z0-9!._-]+$/.test(itemId)) {
      return res.status(400).json({ success: false, error: 'ID tệp OneDrive không hợp lệ.' });
    }

    const inspection = await oneDriveSourceService.inspectDriveItemStructure({
      ownerUserId: req.user.user_id,
      itemId,
      driveId,
      preview: Boolean(preview)
    });

    return res.json({
      success: true,
      ...inspection
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Lỗi phân tích cấu trúc tệp: ${err.message}`
    });
  }
});

router.get('/files/:itemId/inspect', verifyToken, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { drive_id = null, preview = 'false' } = req.query;
    if (!itemId || !/^[a-zA-Z0-9!._-]+$/.test(itemId)) {
      return res.status(400).json({ success: false, error: 'ID tệp OneDrive không hợp lệ.' });
    }

    const inspection = await oneDriveSourceService.inspectDriveItemStructure({
      ownerUserId: req.user.user_id,
      itemId,
      driveId: drive_id,
      preview: preview === 'true' || preview === '1'
    });

    return res.json({
      success: true,
      ...inspection
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Lỗi phân tích cấu trúc tệp: ${err.message}`
    });
  }
});

/**
 * 2c. POST /api/onedrive/sources/import
 * Imports one or more selected OneDrive files directly into SOTRANS Hub.
 * Associates them with the specified agentId and active conversation.
 */
router.post('/sources/import', verifyToken, async (req, res) => {
  try {
    const { items, agentId = null, conversationId = null } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Vui lòng chọn ít nhất một tệp OneDrive để liên kết.'
      });
    }

    if (items.length > 10) {
      return res.status(400).json({
        success: false,
        error: 'Chỉ được chọn tối đa 10 tệp trong một lần liên kết.'
      });
    }

    // Xác thực quyền với Agent đích (nếu agentId là UUID của My Agents)
    let rawAgent = agentId ? String(agentId).replace(/^custom_/, '').trim() : null;
    let validatedAgentId = (rawAgent && rawAgent !== 'general') ? rawAgent : 'excel-data-pro';
    if (validatedAgentId !== 'excel-data-pro' && /^[0-9a-f-]{36}$/i.test(validatedAgentId)) {
      const agentCheck = await db.query(
        `SELECT id, name, user_id FROM public.user_agents
         WHERE id = $1 AND (user_id = $2 OR status = 'public')`,
        [validatedAgentId, req.user.user_id]
      );
      if (agentCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Bạn không có quyền liên kết dữ liệu với Agent này.'
        });
      }
    }

    const imported = [];
    const errors = [];

    for (const item of items) {
      const { itemId, driveId = null } = item;
      if (!itemId) {
        errors.push({ itemId: null, error: 'Thiếu itemId của tệp.' });
        continue;
      }

      try {
        const sourceRecord = await oneDriveSourceService.importSourceFromDriveItem({
          ownerUserId: req.user.user_id,
          agentId: validatedAgentId,
          conversationId,
          itemId,
          driveId
        });

        imported.push({
          sourceId: sourceRecord.id,
          itemId: sourceRecord.item_id,
          fileName: sourceRecord.file_name,
          version: sourceRecord.active_version,
          syncStatus: sourceRecord.sync_status,
          fileSize: sourceRecord.file_size
        });
      } catch (importErr) {
        errors.push({
          itemId,
          error: importErr.message
        });
      }
    }

    const isAllFailed = imported.length === 0 && errors.length > 0;
    return res.status(isAllFailed ? 400 : 200).json({
      success: imported.length > 0,
      importedCount: imported.length,
      errorCount: errors.length,
      imported,
      errors
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Lỗi khi liên kết tệp OneDrive: ${err.message}`
    });
  }
});

/**
 * 3. GET /api/onedrive/sources
 * Returns connected OneDrive sources for the authenticated user.
 */
router.get('/sources', verifyToken, async (req, res) => {
  try {
    const rawAgentParam = req.query.agent_id ? String(req.query.agent_id).replace(/^custom_/, '').trim() : null;
    const agentId = (rawAgentParam && rawAgentParam !== 'general' && rawAgentParam !== 'all') ? rawAgentParam : null;
    const sources = await oneDriveSourceService.getConnectedSourcesForAgent({
      ownerUserId: req.user.user_id,
      agentId
    });

    const sanitized = sources.map(s => {
      const dp = s.snapshot_data_profile || {};
      const mn = s.snapshot_manifest || {};
      const sheetNames = dp.sheetNames || mn.sheets || [];

      const sheetsSummary = sheetNames.map(name => {
        const sh = (dp.sheets && dp.sheets[name]) || {};
        const cols = Array.isArray(sh.columns) ? sh.columns : [];
        return {
          sheetName: name,
          columnsCount: cols.length,
          columns: cols.map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean).slice(0, 10),
          totalRows: sh.totalRawRows || 0,
          validRows: sh.validDataRows || 0
        };
      });

      return {
        id: s.id,
        fileName: s.file_name,
        file_name: s.file_name,
        mimeType: s.mime_type,
        mime_type: s.mime_type,
        fileSize: s.file_size,
        file_size: s.file_size,
        activeVersion: s.active_version,
        active_version: s.active_version,
        syncStatus: s.sync_status,
        sync_status: s.sync_status,
        contentHash: s.content_hash,
        content_hash: s.content_hash,
        lastError: s.last_error,
        last_error: s.last_error,
        lastModifiedAt: s.last_modified_at,
        last_modified_at: s.last_modified_at,
        lastSyncedAt: s.last_synced_at,
        last_synced_at: s.last_synced_at,
        lastSuccessfulSyncAt: s.last_successful_sync_at,
        last_successful_sync_at: s.last_successful_sync_at,
        syncStartedAt: s.sync_started_at,
        sync_started_at: s.sync_started_at,
        sharingUrl: s.sharing_url,
        sharing_url: s.sharing_url,
        agentId: s.agent_id,
        agent_id: s.agent_id,
        agentName: s.agent_name || (s.agent_id === 'excel-data-pro' ? 'Excel-Data-Pro' : 'Custom Agent'),
        agent_name: s.agent_name || (s.agent_id === 'excel-data-pro' ? 'Excel-Data-Pro' : 'Custom Agent'),
        sheetNames,
        sheet_names: sheetNames,
        sheetCount: sheetNames.length,
        sheet_count: sheetNames.length,
        totalUnits: mn.totalUnits || 0,
        total_units: mn.totalUnits || 0,
        validUnits: mn.validUnits || 0,
        valid_units: mn.validUnits || 0,
        parseStatus: mn.parseStatus || (sheetNames.length > 0 ? 'READY' : 'NOT_PARSED'),
        parse_status: mn.parseStatus || (sheetNames.length > 0 ? 'READY' : 'NOT_PARSED'),
        sheetsSummary,
        sheets_summary: sheetsSummary,
        scopeNote: sheetNames.length > 0
          ? `AI sử dụng toàn bộ workbook (${sheetNames.length} sheet, ~${mn.validUnits || 0} dòng dữ liệu)`
          : 'Tài liệu đã được phân tích toàn bộ',
        scope_note: sheetNames.length > 0
          ? `AI sử dụng toàn bộ workbook (${sheetNames.length} sheet, ~${mn.validUnits || 0} dòng dữ liệu)`
          : 'Tài liệu đã được phân tích toàn bộ'
      };
    });

    return res.json({ success: true, sources: sanitized });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Không thể lấy danh sách nguồn: ' + err.message });
  }
});

/**
 * 3b. GET /api/onedrive/sources/:id/structure
 * Returns full data structure, sheets, columns, and sample rows for a connected source.
 */
router.get('/sources/:id/structure', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ success: false, error: 'ID nguồn không hợp lệ.' });
    }

    const structureData = await oneDriveSourceService.getSourceStructureById({
      ownerUserId: req.user.user_id,
      sourceId: id
    });

    if (!structureData) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập.'
      });
    }

    return res.json({
      success: true,
      source: {
        id: structureData.sourceId,
        sourceId: structureData.sourceId,
        fileName: structureData.fileName,
        fileSize: structureData.fileSize,
        mimeType: structureData.mimeType,
        activeVersion: structureData.activeVersion,
        syncStatus: structureData.syncStatus,
        lastSyncedAt: structureData.lastSyncedAt,
        agentId: structureData.agentId,
        agentName: structureData.agentName,
        parseStatus: structureData.structure?.parseStatus || 'READY'
      },
      ...structureData
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Lỗi đọc cấu trúc nguồn dữ liệu: ${err.message}`
    });
  }
});

/**
 * 4. POST /api/onedrive/sources/:id/sync
 * Manually triggers a re-sync for a specific source.
 */
router.post('/sources/:id/sync', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, error: 'ID nguồn không hợp lệ.' });
  }

  try {
    const result = await oneDriveSourceService.syncSourceVersion(id, req.user.user_id, {
      jobType: 'MANUAL',
      force: true
    });

    return res.json({
      success: true,
      message: result.message || `Đã đồng bộ thành công tệp "${result.fileName}" (phiên bản v${result.version}).`,
      version: result.version,
      active_version: result.version,
      isNewVersion: Boolean(result.isNewVersion),
      fileName: result.fileName,
      size: result.size,
      status: result.status,
      valid_units: result.validUnits || 0
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập.'
      });
    }
    return res.status(500).json({
      success: false,
      error: `Đồng bộ thất bại: ${err.message}`
    });
  }
});

/**
 * 5. DELETE /api/onedrive/sources/:id
 * Phân biệt rõ hai thao tác:
 * - Thao tác B (mặc định hoặc ?mode=unlink): Gỡ tệp khỏi Agent (sync_status='DISCONNECTED', agent_id=NULL, bảo tồn snapshot lịch sử trong DB)
 * - Thao tác C (?mode=purge hoặc ?purge=true): Xóa vĩnh viễn toàn bộ dữ liệu (Purge file trên đĩa, snapshots, sync jobs, và registry record)
 */
router.delete('/sources/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const isPurge = req.query.mode === 'purge' || req.query.purge === 'true';

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, error: 'ID nguồn không hợp lệ.' });
  }

  try {
    if (isPurge) {
      const purgeResult = await oneDriveSourceService.purgeSource(id, req.user.user_id);
      return res.json({
        success: true,
        action: 'PURGE',
        purged: true,
        message: purgeResult.message
      });
    } else {
      const disconnected = await oneDriveSourceService.disconnectSource(id, req.user.user_id);
      return res.json({
        success: true,
        action: 'UNLINK',
        purged: false,
        message: `Đã gỡ tệp dữ liệu "${disconnected.file_name}" khỏi Agent.`
      });
    }
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Không tìm thấy') || err.message?.includes('quyền')) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập.'
      });
    }
    return res.status(500).json({ success: false, error: 'Không thể xử lý nguồn: ' + err.message });
  }
});

/**
 * 5b. POST /api/onedrive/sources/:id/purge
 * Endpoint tường minh cho Thao tác C — Xóa vĩnh viễn dữ liệu (Purge)
 */
router.post('/sources/:id/purge', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, error: 'ID nguồn không hợp lệ.' });
  }

  try {
    const purgeResult = await oneDriveSourceService.purgeSource(id, req.user.user_id);
    return res.json({
      success: true,
      action: 'PURGE',
      purged: true,
      message: purgeResult.message
    });
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Không tìm thấy') || err.message?.includes('quyền')) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy nguồn dữ liệu hoặc bạn không có quyền truy cập.'
      });
    }
    return res.status(500).json({ success: false, error: 'Không thể xóa vĩnh viễn nguồn: ' + err.message });
  }
});

/**
 * 6. POST /api/onedrive/reconcile
 * Reconciliation endpoint for n8n or scheduled cron jobs.
 * Scans active sources, validates Graph freshness, and updates stale sources.
 */
router.post('/reconcile', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const N8N_TOKEN = 'Bearer 2ca9f995352866f7081e3f85f00fc759b0dd8661c910cfcebf479d1386b8cd2b';

  let isAuthorized = false;
  if (authHeader === N8N_TOKEN) {
    isAuthorized = true;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET);
      if (decoded.role === 'ADMIN' || decoded.role === 'SUPER_ADMIN') {
        isAuthorized = true;
      }
    } catch (e) {}
  }

  if (!isAuthorized) {
    return res.status(401).json({ success: false, error: 'Chưa xác thực quyền điều phối reconciliation.' });
  }

  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || req.body?.limit || 20, 10), 1), 100);
    const offset = Math.max(parseInt(req.query.offset || req.body?.offset || 0, 10), 0);

    const sourcesRes = await db.query(
      `SELECT s.* FROM public.user_onedrive_sources s
       WHERE s.sync_status != 'DISCONNECTED'
       ORDER BY s.last_synced_at ASC NULLS FIRST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const report = {
      totalScanned: sourcesRes.rows.length,
      limit,
      offset,
      syncedCount: 0,
      freshCount: 0,
      errorCount: 0,
      items: []
    };

    for (const src of sourcesRes.rows) {
      try {
        const token = await oneDriveService.getUserValidAccessToken(src.owner_user_id);
        const freshness = await oneDriveSourceService.checkSourceFreshness(src, token);

        if (freshness.isGraphReachable && !freshness.isFresh) {
          const syncRes = await oneDriveSourceService.syncSourceVersion(src.id, src.owner_user_id, {
            jobType: 'SCHEDULED',
            targetMetadata: freshness.currentMetadata
          });
          report.syncedCount++;
          report.items.push({ id: src.id, fileName: src.file_name, action: 'SYNCED', version: syncRes.version });
        } else if (freshness.isFresh) {
          report.freshCount++;
          report.items.push({ id: src.id, fileName: src.file_name, action: 'FRESH' });
        } else {
          report.errorCount++;
          report.items.push({ id: src.id, fileName: src.file_name, action: 'UNREACHABLE', reason: freshness.reason });
        }
      } catch (err) {
        report.errorCount++;
        report.items.push({ id: src.id, fileName: src.file_name, action: 'ERROR', error: err.message });
      }
    }

    return res.json({ success: true, report });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lỗi reconciliation: ' + err.message });
  }
});

module.exports = router;
