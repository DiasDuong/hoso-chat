/**
 * SOTRANS HUB — BI FILES ROUTE (PHASE 2.1, 2.2, 2.3 & 2.4)
 * 
 * REST API for Uploaded File BI, Isolated Tabular Analytics & Data Governance:
 * - POST /api/analytics/files/upload: Secure Intake & Automatic Profiling
 * - GET /api/analytics/files: List accessible datasets (tenant/role/sharing scoped)
 * - GET /api/analytics/files/:fileId: Retrieve metadata & profile
 * - GET /api/analytics/files/:fileId/preview: Get first 10 sanitized rows
 * - POST /api/analytics/files/:fileId/query: Safe in-memory analytical query
 * - POST /api/analytics/files/:fileId/ask: Natural language query to execution
 * - POST /api/analytics/files/:fileId/share: Share dataset with user, role or company
 * - POST /api/analytics/files/:fileId/unshare: Revoke dataset sharing
 * - GET /api/analytics/files/:fileId/audit: Retrieve governance audit trail
 * - DELETE /api/analytics/files/:fileId: Delete dataset & physical storage
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const {
  validateAndStoreIntakeFile,
  FileSecurityError,
  MAX_FILE_SIZE_BYTES,
  STORAGE_DIR,
} = require('../services/biFileSecurityService');
const {
  registerDataset,
  getDataset,
  updateDataset,
  deleteDataset,
  shareDataset,
  revokeDatasetShare,
  listDatasetsForUser,
  canUserAccessDataset,
} = require('../services/biDatasetRegistry');
const {
  processAndProfileDataset,
  queryIsolatedDataset,
  getDatasetForSheet,
} = require('../services/biSpreadsheetEngine');
const { sanitizeBiData, sanitizeBiProfile } = require('../services/biPrivacy');
const { validateQueryPlan } = require('../services/biQueryValidator');
const { planAnalyticalQuery } = require('../services/biQueryPlanner');
const { formatAnalyticalResultMarkdown } = require('../services/biDatasetPresenter');
const { logBiAuditEvent, getBiAuditLogs } = require('../services/biAuditLogger');
const { buildDatasetDashboard } = require('../services/biReportBuilder');

// Multer memory storage for intake verification
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

/**
 * POST /api/analytics/files/upload
 * Secure Intake, Security Scanning, Parsing and Automatic Data Profiling
 */
router.post('/upload', verifyToken, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          error: `Dung lượng tệp vượt quá giới hạn tối đa (${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB).`,
          code: 'FILE_SIZE_EXCEEDED',
        });
      }
      return res.status(400).json({ success: false, error: err.message, code: 'UPLOAD_ERROR' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'Vui lòng chọn tệp bảng tính (.xlsx, .xls, .csv) để tải lên.',
          code: 'MISSING_FILE',
        });
      }

      // Step 1: Security Scan, Magic Bytes verification, and Secure Storage
      const { metadata, buffer } = await validateAndStoreIntakeFile(req.file, req.user);

      // Step 2: Register Initial Status with ownership
      await registerDataset(
        {
          ...metadata,
          processing_status: 'PROCESSING',
          uploaded_by: String(req.user.user_id || req.user.userId || ''),
          uploaded_by_username: String(req.user.username || ''),
        },
        req.user
      );

      // Step 3: Parse, Sanitize & Profile Dataset
      let profileResult;
      try {
        profileResult = await processAndProfileDataset(metadata, buffer);
      } catch (parseErr) {
        await updateDataset(metadata.file_id, {
          processing_status: 'FAILED',
          error_message: parseErr.message,
        });
        return res.status(400).json({
          success: false,
          error: `Không thể phân tích dữ liệu tệp: ${parseErr.message}`,
          code: 'PARSE_FAILED',
        });
      }

      // Step 4: Finalize Dataset Registration with Profile
      const finalized = await updateDataset(metadata.file_id, {
        processing_status: 'READY',
        profile: profileResult.dataProfile,
      });

      return res.status(200).json({
        success: true,
        message: 'Tải lên và phân tích cấu trúc tệp thành công.',
        dataset: {
          file_id: finalized.file_id,
          original_filename: finalized.original_filename,
          file_type: finalized.file_type,
          file_size: finalized.file_size,
          company_id: finalized.company_id,
          uploaded_by: finalized.uploaded_by,
          uploaded_by_username: finalized.uploaded_by_username,
          upload_timestamp: finalized.upload_timestamp,
          retention_expiry: finalized.retention_expiry,
          processing_status: finalized.processing_status,
          profile: sanitizeBiProfile(profileResult.dataProfile),
        },
      });
    } catch (secErr) {
      const status = secErr.status || (secErr instanceof FileSecurityError ? 400 : 500);
      return res.status(status).json({
        success: false,
        error: secErr.message || 'Lỗi bảo mật trong quá trình xử lý tệp.',
        code: secErr.code || 'SECURITY_VIOLATION',
      });
    }
  });
});

/**
 * GET /api/analytics/files
 * List all active datasets accessible to authenticated caller (tenant/role/share scoped)
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const list = listDatasetsForUser(req.user, {
      company_id: req.query.company_id,
    });

    // S6: Filter out any datasets whose backing physical file is missing or status is not READY
    const readyList = list.filter((d) => {
      if (d.processing_status !== 'READY') return false;
      const physicalFile = path.join(STORAGE_DIR, `${d.file_id}.dataset.json`);
      return fs.existsSync(physicalFile);
    });

    const sanitizedList = readyList.map((d) => ({
      file_id: d.file_id,
      original_filename: d.original_filename,
      file_type: d.file_type,
      file_size: d.file_size,
      company_id: d.company_id,
      uploaded_by: d.uploaded_by,
      uploaded_by_username: d.uploaded_by_username,
      shared_with: d.shared_with || [],
      upload_timestamp: d.upload_timestamp,
      retention_expiry: d.retention_expiry,
      processing_status: d.processing_status,
      row_count: d.profile ? d.profile.row_count : 0,
      column_count: d.profile ? d.profile.column_count : 0,
      active_sheet: d.profile ? d.profile.active_sheet : '',
    }));

    return res.status(200).json({
      success: true,
      total: sanitizedList.length,
      datasets: sanitizedList,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/analytics/files/:fileId
 * Retrieve single dataset metadata and full profile
 */
router.get('/:fileId', verifyToken, async (req, res) => {
  try {
    const dataset = getDataset(req.params.fileId);
    if (!dataset) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy bộ dữ liệu.', code: 'NOT_FOUND' });
    }

    const access = canUserAccessDataset(dataset, req.user, 'view');
    if (!access.allowed) {
      await logBiAuditEvent({
        event: 'ACCESS_DENIED',
        fileId: dataset.file_id,
        filename: dataset.original_filename,
        userContext: req.user,
        details: { action: 'VIEW_METADATA', reason: access.reason },
        status: 'DENIED',
      });
      return res.status(403).json({
        success: false,
        error: access.reason || 'Bạn không có quyền truy cập bộ dữ liệu này.',
        code: 'FORBIDDEN',
      });
    }

    return res.status(200).json({
      success: true,
      dataset: {
        file_id: dataset.file_id,
        original_filename: dataset.original_filename,
        file_type: dataset.file_type,
        file_size: dataset.file_size,
        company_id: dataset.company_id,
        uploaded_by: dataset.uploaded_by,
        uploaded_by_username: dataset.uploaded_by_username,
        shared_with: dataset.shared_with || [],
        upload_timestamp: dataset.upload_timestamp,
        retention_expiry: dataset.retention_expiry,
        processing_status: dataset.processing_status,
        profile: sanitizeBiProfile(dataset.profile) || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/analytics/files/:fileId/preview
 * Preview first 10 sanitized rows of the dataset
 */
router.get('/:fileId/preview', verifyToken, async (req, res) => {
  try {
    const dataset = getDataset(req.params.fileId);
    if (!dataset) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy bộ dữ liệu.', code: 'NOT_FOUND' });
    }

    const access = canUserAccessDataset(dataset, req.user, 'view');
    if (!access.allowed) {
      await logBiAuditEvent({
        event: 'ACCESS_DENIED',
        fileId: dataset.file_id,
        filename: dataset.original_filename,
        userContext: req.user,
        details: { action: 'PREVIEW', reason: access.reason },
        status: 'DENIED',
      });
      return res.status(403).json({
        success: false,
        error: access.reason || 'Bạn không có quyền truy cập bộ dữ liệu này.',
        code: 'FORBIDDEN',
      });
    }

    const previewRows = dataset.profile?.preview_rows || [];
    const columns = dataset.profile?.columns || [];

    return res.status(200).json({
      success: true,
      file_id: dataset.file_id,
      original_filename: dataset.original_filename,
      row_count: dataset.profile?.row_count || 0,
      columns: sanitizeBiProfile({ columns }).columns,
      preview_rows: sanitizeBiData(previewRows),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/analytics/files/:fileId/query
 * Safe In-Memory Analytical Query Execution (zero PostgreSQL access)
 * Enforces strict validation, query permission, and resource boundaries
 */
router.post('/:fileId/query', verifyToken, async (req, res) => {
  const startTime = Date.now();
  try {
    const dataset = getDataset(req.params.fileId);
    if (!dataset) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy bộ dữ liệu.', code: 'NOT_FOUND' });
    }

    const access = canUserAccessDataset(dataset, req.user, 'query');
    if (!access.allowed) {
      await logBiAuditEvent({
        event: 'ACCESS_DENIED',
        fileId: dataset.file_id,
        filename: dataset.original_filename,
        userContext: req.user,
        details: { action: 'QUERY', reason: access.reason },
        status: 'DENIED',
      });
      return res.status(403).json({
        success: false,
        error: access.reason || 'Bạn không có quyền truy vấn bộ dữ liệu này.',
        code: 'FORBIDDEN',
      });
    }

    const querySpec = req.body.querySpec || req.body || {};
    const sheetDataset = await getDatasetForSheet(dataset, querySpec.target_sheet);
    const validatedPlan = validateQueryPlan(querySpec, sheetDataset, req.user);
    const queryResult = await queryIsolatedDataset(dataset.file_id, validatedPlan);
    const executionTimeMs = Date.now() - startTime;

    await logBiAuditEvent({
      event: 'DATASET_QUERY',
      fileId: dataset.file_id,
      filename: dataset.original_filename,
      userContext: req.user,
      details: {
        query_plan: validatedPlan,
        returned_rows: queryResult.returned_rows,
        total_matching: queryResult.total_matching,
      },
      executionTimeMs,
      status: 'SUCCESS',
    });

    return res.status(200).json({
      success: true,
      rows: sanitizeBiData(queryResult.results),
      dashboard: buildDatasetDashboard(validatedPlan, queryResult, sheetDataset, req.user),
      execution_time_ms: queryResult.execution_stats?.execution_time_ms || executionTimeMs,
      memory_delta_kb: queryResult.execution_stats?.memory_delta_kb || 0,
      ...sanitizeBiData(queryResult),
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message, code: err.code || 'QUERY_ERROR' });
  }
});

/**
 * POST /api/analytics/files/:fileId/ask
 * Natural Language Query to AI Query Planning & Execution Pipeline
 */
router.post('/:fileId/ask', verifyToken, async (req, res) => {
  const startTime = Date.now();
  try {
    const dataset = getDataset(req.params.fileId);
    if (!dataset) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy bộ dữ liệu.', code: 'NOT_FOUND' });
    }

    const access = canUserAccessDataset(dataset, req.user, 'query');
    if (!access.allowed) {
      await logBiAuditEvent({
        event: 'ACCESS_DENIED',
        fileId: dataset.file_id,
        filename: dataset.original_filename,
        userContext: req.user,
        details: { action: 'ASK', reason: access.reason },
        status: 'DENIED',
      });
      return res.status(403).json({
        success: false,
        error: access.reason || 'Bạn không có quyền truy vấn bộ dữ liệu này.',
        code: 'FORBIDDEN',
      });
    }

    const prompt = req.body.prompt || req.body.message || req.body.query || '';
    if (!prompt.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Vui lòng cung cấp câu hỏi phân tích dữ liệu.',
        code: 'EMPTY_PROMPT',
      });
    }

    const conversationContext = req.body.conversationContext || {};
    const sheetDataset = await getDatasetForSheet(dataset, req.body.target_sheet || conversationContext.previousQueryPlan?.target_sheet);
    const plan = planAnalyticalQuery(prompt, sheetDataset.profile, conversationContext);

    if (plan.clarification_needed) {
      return res.status(200).json({
        success: true,
        clarification_needed: true,
        clarification_question: plan.clarification_question,
      });
    }

    const validatedPlan = validateQueryPlan(plan, sheetDataset, req.user);
    const queryResult = await queryIsolatedDataset(dataset.file_id, validatedPlan);
    const markdown = formatAnalyticalResultMarkdown(validatedPlan, queryResult, sheetDataset, '', req.user);
    const executionTimeMs = Date.now() - startTime;

    await logBiAuditEvent({
      event: 'DATASET_ASK',
      fileId: dataset.file_id,
      filename: dataset.original_filename,
      userContext: req.user,
      details: {
        query_plan: validatedPlan,
        returned_rows: queryResult.returned_rows,
        total_matching: queryResult.total_matching,
      },
      executionTimeMs,
      status: 'SUCCESS',
    });

    return res.status(200).json({
      success: true,
      plan: validatedPlan,
      query_plan: validatedPlan,
      result: sanitizeBiData(queryResult),
      results: sanitizeBiData(queryResult.results),
      rows: sanitizeBiData(queryResult.results),
      returned_rows: queryResult.returned_rows,
      total_matching: queryResult.total_matching,
      markdown,
      presentation: markdown,
      presentation_markdown: markdown,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message, code: err.code || 'QUERY_ERROR' });
  }
});

/**
 * POST /api/analytics/files/:fileId/share
 * Share dataset with a user, role, or company
 */
router.post('/:fileId/share', verifyToken, async (req, res) => {
  try {
    const result = await shareDataset(req.params.fileId, req.body, req.user);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/analytics/files/:fileId/unshare
 * Revoke sharing for a dataset
 */
router.post('/:fileId/unshare', verifyToken, async (req, res) => {
  try {
    const targetId = req.body.target_id || req.body.share_id;
    if (!targetId) {
      return res.status(400).json({ success: false, error: 'target_id hoặc share_id là bắt buộc để thu hồi chia sẻ.' });
    }
    const result = await revokeDatasetShare(req.params.fileId, targetId, req.user);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/analytics/files/:fileId/audit
 * Retrieve governance audit trail for a dataset
 */
router.get('/:fileId/audit', verifyToken, async (req, res) => {
  try {
    const dataset = getDataset(req.params.fileId);
    if (!dataset) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy bộ dữ liệu.', code: 'NOT_FOUND' });
    }

    const access = canUserAccessDataset(dataset, req.user, 'view');
    if (!access.allowed) {
      return res.status(403).json({ success: false, error: access.reason, code: 'FORBIDDEN' });
    }

    const logs = await getBiAuditLogs({ file_id: req.params.fileId, limit: req.query.limit || 50 });
    return res.status(200).json({
      success: true,
      file_id: req.params.fileId,
      total: logs.length,
      logs,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/analytics/files/:fileId
 * Delete dataset and its isolated files
 */
router.delete('/:fileId', verifyToken, async (req, res) => {
  try {
    const result = await deleteDataset(req.params.fileId, req.user);
    return res.status(200).json({
      success: true,
      message: 'Đã xóa bộ dữ liệu và các tệp lưu trữ liên quan thành công.',
      ...result,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = router;
