const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken, requireRoles, hasPermission } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { queueEmployeeSync } = require('../services/syncWorker');
const { executeDryRun, executeBackfill, getSourceEmployees, getNocoDBRecords, getGoogleSheetRows } = require('../services/backfillService');
const { reconcileEmployees } = require('../services/reconciliationService');
const { processFileForAI } = require('../services/fileProcessor');
const { executeStagingApproval } = require('./intake');
const { checkDatabaseCccdDuplicates } = require('../services/intakeValidator');
const { executeRestore } = require('../services/employeeRestoreService');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const http = require('http');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 }
});

const N8N_TOKEN = 'Bearer 2ca9f995352866f7081e3f85f00fc759b0dd8661c910cfcebf479d1386b8cd2b';

// Định dạng chuẩn mã nhân viên theo từng công ty
const COMPANY_CODE_PATTERNS = {
  'STL': {
    regex: /^STL-\d{3,5}$/i,
    hint: 'Mã nhân viên SOTRANS Logistics (STL) phải có định dạng "STL-xxx" (Ví dụ: STL-001, STL-1029).'
  },
  'VTX': {
    regex: /^VTX[_-]\d{3,5}$/i,
    hint: 'Mã nhân viên Vietranstimex (VTX) phải có định dạng "VTX_xxx" hoặc "VTX-xxx" (Ví dụ: VTX_881, VTX-101).'
  },
  'SWC': {
    regex: /^(SWC-\d{3,5}|\d{12})$/i,
    hint: 'Mã nhân viên Sowatco (SWC) phải có định dạng "SWC-xxx" hoặc số CCCD 12 chữ số (Ví dụ: SWC-402, 079205001589).'
  }
};

/**
 * 1. GET /api/employees - Danh sách hồ sơ nhân sự
 * Phân quyền: ADMIN, HR
 * - ADMIN: Xem tất cả hoặc lọc theo company_id
 * - HR: Bị khóa cứng theo công ty của mình (req.user.company_id)
 * - Tách bạch rõ: Nhân viên có hay chưa có tài khoản người dùng
 * - Trả về dữ liệu thực tế kết hợp giữa bảng employees và hr_employee_profiles
 */
router.get('/', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  const { company_id, department, status, has_account, search } = req.query || {};

  try {
    let query = `
      SELECT 
        e.id,
        COALESCE(NULLIF(p.ocr_employee_id, ''), e.employee_code) AS employee_id,
        e.employee_code,
        COALESCE(NULLIF(p.ocr_full_name, ''), e.employee_name) AS full_name,
        e.employee_name,
        e.company_id,
        c.company_name,
        COALESCE(NULLIF(p.ocr_job_title, ''), e.position, '') AS job_title,
        e.position,
        COALESCE(p.professional_title, '') AS professional_title,
        COALESCE(NULLIF(p.department_staffing_plan, ''), e.department, '') AS department_staffing_plan,
        e.department,
        COALESCE(p.section_staffing_plan, '') AS section_staffing_plan,
        COALESCE(p.employment_start_date, '') AS employment_start_date,
        COALESCE(p.ocr_phone_number, '') AS phone_number,
        COALESCE(NULLIF(p.ocr_email, ''), e.email, '') AS email,
        COALESCE(p.ocr_file_name, '') AS "fileName",
        COALESCE(p.ocr_file_name, '') AS file_name,
        COALESCE(e.citizen_id, p.citizen_id, '') AS citizen_id,
        COALESCE(p.date_of_birth, '') AS date_of_birth,
        COALESCE(p.gender, '') AS gender,
        COALESCE(e.resignation_date, p.resignation_date, '') AS resignation_date,
        COALESCE(e.resignation_reason, p.resignation_reason, '') AS resignation_reason,
        e.status,
        e.created_at,
        e.updated_at,
        u.user_id AS linked_user_id,
        u.username AS linked_username,
        u.role AS linked_role,
        u.status AS linked_user_status,
        CASE WHEN u.user_id IS NOT NULL THEN true ELSE false END AS has_user_account
      FROM employees e
      LEFT JOIN companies c ON e.company_id = c.id
      LEFT JOIN LATERAL (
        SELECT 
          u.user_id,
          u.username,
          u.role,
          u.status
        FROM users u 
        WHERE u.employee_id = e.id 
        ORDER BY CASE WHEN u.role = 'HR' THEN 1 WHEN u.role = 'ADMIN' THEN 2 ELSE 3 END ASC, u.user_id ASC
        LIMIT 1
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT 
          p.employee_id AS ocr_employee_id,
          p.full_name AS ocr_full_name,
          p.job_title AS ocr_job_title,
          p.professional_title,
          p.department_staffing_plan,
          p.section_staffing_plan,
          p.employment_start_date,
          p.phone_number AS ocr_phone_number,
          p.email AS ocr_email,
          p.file_name AS ocr_file_name,
          p.citizen_id,
          p.date_of_birth,
          p.gender,
          p.resignation_date,
          p.resignation_reason
        FROM hr_employee_profiles p
        WHERE (p.company_id = e.company_id OR p.company_id IS NULL)
          AND (
            (e.citizen_id IS NOT NULL AND e.citizen_id <> '' AND p.citizen_id = e.citizen_id) OR 
            (e.employee_code IS NOT NULL AND e.employee_code <> '' AND p.employee_id = e.employee_code) OR
            (e.employee_code IS NOT NULL AND e.employee_code <> '' AND p.citizen_id = e.employee_code)
          )
        ORDER BY p.id DESC
        LIMIT 1
      ) p ON true
      WHERE 1=1
    `;
    const params = [];

    // Tenant Isolation
    if (req.user.role === 'HR') {
      params.push(req.user.company_id);
      query += ` AND e.company_id = $${params.length}`;
    } else if (req.user.role === 'ADMIN') {
      if (company_id && company_id !== 'all') {
        params.push(company_id);
        query += ` AND e.company_id = $${params.length}`;
      }
    }

    if (department && department.trim()) {
      params.push(department.trim());
      const pIdx = params.length;
      query += ` AND (e.department = $${pIdx} OR p.department_staffing_plan = $${pIdx})`;
    }

    if (status && status.trim()) {
      if (status.trim().toUpperCase() !== 'ALL') {
        params.push(status.trim().toUpperCase());
        query += ` AND e.status = $${params.length}`;
      }
    } else {
      params.push('ACTIVE');
      query += ` AND e.status = $${params.length}`;
    }

    if (has_account === 'true') {
      query += ` AND u.user_id IS NOT NULL`;
    } else if (has_account === 'false') {
      query += ` AND u.user_id IS NULL`;
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const p = params.length;
      query += ` AND (
        LOWER(e.employee_name) LIKE $${p} OR 
        LOWER(e.employee_code) LIKE $${p} OR 
        LOWER(COALESCE(p.ocr_full_name, '')) LIKE $${p} OR 
        LOWER(COALESCE(p.ocr_employee_id, '')) LIKE $${p} OR 
        LOWER(COALESCE(p.citizen_id, '')) LIKE $${p} OR 
        LOWER(COALESCE(e.position, '')) LIKE $${p} OR 
        LOWER(COALESCE(p.ocr_job_title, '')) LIKE $${p} OR 
        LOWER(COALESCE(e.department, '')) LIKE $${p} OR 
        LOWER(COALESCE(p.department_staffing_plan, '')) LIKE $${p} OR 
        LOWER(COALESCE(e.email, '')) LIKE $${p}
      )`;
    }

    query += ` ORDER BY e.created_at DESC`;

    const result = await db.query(query, params);
    const rows = result.rows || [];
    const totalCount = rows.length;
    const activeCount = rows.filter(r => r.status === 'ACTIVE').length;
    const resignedCount = rows.filter(r => r.status === 'RESIGNED').length;
    const deletedCount = rows.filter(r => r.status === 'DELETED').length;
    const inactiveCount = rows.filter(r => r.status === 'INACTIVE').length;
    const ocrCount = rows.filter(r => !!r.fileName || !!r.file_name).length;
    const hasUserCount = rows.filter(r => r.has_user_account === true).length;

    // Tính toán số liệu thống kê tổng quan theo phạm vi công ty để không bị méo mó khi người dùng lọc bảng
    let statsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE e.status != 'DELETED') AS total,
        COUNT(*) AS total_including_deleted,
        COUNT(*) FILTER (WHERE e.status = 'ACTIVE') AS active,
        COUNT(*) FILTER (WHERE e.status = 'RESIGNED') AS resigned,
        COUNT(*) FILTER (WHERE e.status = 'DELETED') AS deleted,
        COUNT(*) FILTER (WHERE e.status = 'INACTIVE') AS inactive,
        COUNT(*) FILTER (WHERE e.status != 'DELETED' AND EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id)) AS has_user_account,
        COUNT(*) FILTER (WHERE e.status != 'DELETED' AND EXISTS (
          SELECT 1 FROM hr_employee_profiles p 
          WHERE (p.company_id = e.company_id OR p.company_id IS NULL)
            AND ((p.citizen_id = e.citizen_id AND e.citizen_id IS NOT NULL AND e.citizen_id <> '') 
                 OR (p.employee_id = e.employee_code AND e.employee_code IS NOT NULL AND e.employee_code <> ''))
            AND (p.file_name IS NOT NULL AND p.file_name <> '')
        )) AS ocr_extracted
      FROM employees e
      WHERE 1=1
    `;
    const statsParams = [];
    if (req.user.role === 'HR') {
      statsParams.push(req.user.company_id);
      statsQuery += ` AND e.company_id = $${statsParams.length}`;
    } else if (req.user.role === 'ADMIN' && company_id && company_id !== 'all') {
      statsParams.push(company_id);
      statsQuery += ` AND e.company_id = $${statsParams.length}`;
    }

    let statsObj = {
      total: totalCount,
      active: activeCount,
      resigned: resignedCount,
      deleted: deletedCount,
      inactive: inactiveCount,
      ocr_extracted: ocrCount,
      has_user_account: hasUserCount
    };

    try {
      const statsRes = await db.query(statsQuery, statsParams);
      if (statsRes.rows && statsRes.rows.length > 0) {
        const s = statsRes.rows[0];
        statsObj = {
          total: parseInt(s.total, 10) || 0,
          total_all: parseInt(s.total_including_deleted, 10) || 0,
          active: parseInt(s.active, 10) || 0,
          resigned: parseInt(s.resigned, 10) || 0,
          deleted: parseInt(s.deleted, 10) || 0,
          inactive: parseInt(s.inactive, 10) || 0,
          ocr_extracted: parseInt(s.ocr_extracted, 10) || 0,
          has_user_account: parseInt(s.has_user_account, 10) || 0
        };
      }
    } catch (eErr) {
      console.warn('Could not compute global employee stats, fallback to row stats:', eErr.message);
    }

    return res.json({
      success: true,
      total: totalCount,
      company_scope: req.user.role === 'ADMIN' ? (company_id || 'ALL') : req.user.company_id,
      employees: rows,
      data: rows,
      stats: statsObj
    });
  } catch (err) {
    console.error('List employees error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tải danh sách hồ sơ nhân sự.' });
  }
});

/**
 * SYNC 1. GET /api/employees/sync/status - Kiểm tra trạng thái và số lượng hồ sơ giữa 3 nơi
 * Phân biệt rõ các trạng thái: WORKER_RUNNING, SYNC_PENDING, SYNC_SUCCESS, SYNC_FAILED, DATA_MISMATCH
 */
router.get('/sync/status', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  try {
    // Run real-time reconciliation across SoR (Postgres employees), NocoDB (hr_employee_profiles), and Google Sheets
    const recon = await reconcileEmployees({ autoFix: false, actor: req.user.username });

    const taskStatsRes = await db.query(
      `SELECT 
         COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
         COUNT(*) FILTER (WHERE status IN ('pending', 'processing', 'pending_nocodb', 'processing_nocodb', 'pending_sheets', 'processing_sheets')) as pending_count,
         MAX(completed_at) as last_success_time,
         (SELECT last_error FROM hr_sync_tasks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1) as last_failure_error
       FROM hr_sync_tasks 
       WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    const taskStats = taskStatsRes.rows[0] || {};
    const failedTasksCount = parseInt(taskStats.failed_count || '0', 10);
    const pendingTasksCount = parseInt(taskStats.pending_count || '0', 10);
    const lastSuccessTime = taskStats.last_success_time || recon.timestamp;

    const missingInNocoCount = (recon.missing_in_nocodb || []).length;
    const missingInSheetsCount = (recon.missing_in_sheets || []).length;
    const statusMismatchCount = (recon.status_mismatches || []).length;
    const totalMissingCount = missingInNocoCount + missingInSheetsCount;

    // Differentiate states strictly per specification:
    // - WORKER_RUNNING: Worker is active but tasks/sync pending
    // - SYNC_PENDING: Tasks queued or executing
    // - SYNC_SUCCESS: Reconciled and 100% matched across all 3 systems
    // - SYNC_FAILED: Tasks failed
    // - DATA_MISMATCH: Count or record mismatch between SoR, NocoDB, and Google Sheets
    let state = 'WORKER_RUNNING';
    let statusMessage = 'Hệ thống đồng bộ đang hoạt động';

    if (totalMissingCount > 0 || statusMismatchCount > 0 || !recon.is_consistent) {
      state = 'DATA_MISMATCH';
      statusMessage = `Dữ liệu chưa đồng nhất: thiếu ${missingInNocoCount} ở NocoDB, ${missingInSheetsCount} ở Sheets${statusMismatchCount > 0 ? `, lệch trạng thái ${statusMismatchCount}` : ''}`;
    } else if (failedTasksCount > 0) {
      state = 'SYNC_FAILED';
      statusMessage = `Có ${failedTasksCount} tác vụ đồng bộ thất bại trong 24h`;
    } else if (pendingTasksCount > 0) {
      state = 'SYNC_PENDING';
      statusMessage = `Đang xử lý ${pendingTasksCount} tác vụ đồng bộ`;
    } else if (recon.is_consistent) {
      state = 'SYNC_SUCCESS';
      statusMessage = 'Đã đồng bộ và xác nhận thành công 100%';
    }

    const recentTasks = await db.query(
      `SELECT target_system, status, COUNT(*) as count 
       FROM hr_sync_tasks 
       WHERE created_at > NOW() - INTERVAL '24 hours' 
       GROUP BY target_system, status`
    );

    return res.json({
      success: true,
      timestamp: recon.timestamp,
      state: state,
      status_message: statusMessage,
      last_success_time: lastSuccessTime,
      reconciled_count: recon.reconciled_count,
      missing_count: totalMissingCount,
      failed_tasks_count: failedTasksCount,
      error_message: failedTasksCount > 0 ? taskStats.last_failure_error : (totalMissingCount > 0 ? statusMessage : null),
      counts: recon.counts,
      status: {
        is_synchronized: recon.is_consistent,
        state: state,
        worker_running: true,
        nocodb_connected: true,
        google_sheets_connected: true
      },
      reconciliation: {
        missing_in_nocodb: recon.missing_in_nocodb,
        missing_in_sheets: recon.missing_in_sheets,
        status_mismatches: recon.status_mismatches,
        orphaned_in_nocodb: recon.orphaned_in_nocodb
      },
      recent_tasks_24h: recentTasks.rows
    });
  } catch (err) {
    console.error('Sync status error:', err);
    return res.status(500).json({ 
      success: false, 
      state: 'SYNC_FAILED',
      error: 'Lỗi khi kiểm tra trạng thái đồng bộ: ' + err.message 
    });
  }
});

/**
 * SYNC 4. POST /api/employees/sync/reconcile - Chạy đối soát và tự động sửa lệch dữ liệu (Idempotent non-destructive auto-repair)
 */
router.post('/sync/reconcile', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  try {
    const result = await reconcileEmployees({
      autoFix: true,
      actor: req.user.username
    });

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'hr_sync_reconciliation_executed',
      status: result.is_consistent || (result.fixed_in_nocodb.length > 0 || result.fixed_in_sheets.length > 0) ? 'SUCCESS' : 'FAILED',
      ip_address: req.ip,
      metadata: {
        reconciled_count: result.reconciled_count,
        fixed_in_nocodb: result.fixed_in_nocodb,
        fixed_in_sheets: result.fixed_in_sheets,
        duration_ms: result.duration_ms
      }
    });

    return res.json({
      success: true,
      message: 'Đối soát và sửa lệch dữ liệu hoàn tất!',
      data: result
    });
  } catch (err) {
    console.error('Reconciliation error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi đối soát dữ liệu: ' + err.message });
  }
});

/**
 * SYNC 2. POST /api/employees/sync/dry-run - Chạy thử nghiệm đồng bộ bù, hiển thị số bản ghi dự kiến tạo mới, cập nhật, bỏ qua và lỗi
 */
router.post('/sync/dry-run', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  try {
    const result = await executeDryRun();
    return res.json(result);
  } catch (err) {
    console.error('Sync dry-run error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi chạy dry-run đồng bộ: ' + err.message });
  }
});

/**
 * SYNC 3. POST /api/employees/sync/backfill - Thực thi đồng bộ bù toàn bộ hồ sơ nhân sự sang NocoDB và Google Sheets
 */
router.post('/sync/backfill', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  try {
    const result = await executeBackfill({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username
    });

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'hr_sync_backfill_executed',
      status: result.success ? 'SUCCESS' : 'PARTIAL_OR_FAILED',
      ip_address: req.ip,
      metadata: {
        duration_ms: result.duration_ms,
        nocodb: result.nocodb_result,
        google_sheets: result.google_sheets_result,
        verification: result.verification
      }
    });

    return res.json(result);
  } catch (err) {
    console.error('Sync backfill error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi thực thi đồng bộ bù: ' + err.message });
  }
});

/**
 * Helper to locate employee physical file on server
 */
function resolvePhysicalFile(fileName, explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }
  if (!fileName) return null;

  const cleanName = path.basename(fileName);
  const searchDirs = [
    '/app/uploads/staging',
    path.resolve(__dirname, '..', 'uploads', 'staging'),
    '/app/uploads',
    path.resolve(__dirname, '..', 'uploads'),
    '/app/chat-files',
    path.resolve(__dirname, '..', 'chat-files'),
    path.resolve(__dirname, '..', '..', 'files')
  ];

  // 1. Direct path matches
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const directPath = path.join(dir, cleanName);
    if (fs.existsSync(directPath)) {
      return directPath;
    }
  }

  // 2. Prefixed matches (e.g. uuid_SWC00808.pdf)
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      const match = files.find(f => f === cleanName || f.endsWith('_' + cleanName));
      if (match) {
        return path.join(dir, match);
      }
    } catch (_) {}
  }

  // 3. Check backup folder if present
  const backupDir = path.resolve(__dirname, '..', 'uploads', 'backup_20261111_hieu', 'files');
  if (fs.existsSync(backupDir)) {
    try {
      const files = fs.readdirSync(backupDir);
      const match = files.find(f => f === cleanName || f.endsWith('_' + cleanName));
      if (match) return path.join(backupDir, match);
    } catch (_) {}
  }

  return null;
}

/**
 * 1.5. GET /api/employees/file/:filename - Xem trước hoặc tải tệp tài liệu số hóa trực tiếp theo tên file
 */
router.get('/file/:filename', verifyToken, async (req, res) => {
  const { filename } = req.params;
  const cleanName = path.basename(filename || '');
  if (!cleanName) {
    return res.status(400).json({ success: false, error: 'Tên tệp không hợp lệ.' });
  }

  try {
    // 1. Xác định nhân sự & công ty sở hữu tệp để kiểm tra Tenant Isolation
    let companyId = null;
    let employeeCode = null;

    const docRes = await db.query(
      `SELECT d.file_name, d.file_storage_path, e.company_id, e.employee_code, e.id AS employment_id
       FROM hr_employment_documents d
       LEFT JOIN employees e ON d.employment_id = e.id
       WHERE d.file_name = $1 LIMIT 1`,
      [cleanName]
    );

    let docPath = null;
    if (docRes.rows.length > 0) {
      companyId = docRes.rows[0].company_id;
      employeeCode = docRes.rows[0].employee_code;
      docPath = docRes.rows[0].file_storage_path;
    } else {
      const profRes = await db.query(
        `SELECT company_id, employee_id, file_name FROM hr_employee_profiles WHERE file_name = $1 LIMIT 1`,
        [cleanName]
      );
      if (profRes.rows.length > 0) {
        companyId = profRes.rows[0].company_id;
        employeeCode = profRes.rows[0].employee_id;
      } else {
        const stgRes = await db.query(
          `SELECT company_id, employee_code, target_employee_code, file_storage_path FROM hr_employee_staging WHERE file_name = $1 LIMIT 1`,
          [cleanName]
        );
        if (stgRes.rows.length > 0) {
          companyId = stgRes.rows[0].company_id;
          employeeCode = stgRes.rows[0].employee_code || stgRes.rows[0].target_employee_code;
          docPath = stgRes.rows[0].file_storage_path;
        }
      }
    }

    // 2. Tenant Isolation & Quyền truy cập
    if (req.user.role === 'EMPLOYEE') {
      if (!req.user.employee_code || req.user.employee_code !== employeeCode) {
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Bạn chỉ có thể xem tài liệu hồ sơ của chính mình.'
        });
      }
    } else if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      if (req.user.company_id && companyId && req.user.company_id.toUpperCase() !== companyId.toUpperCase()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: Bạn không có quyền truy cập tài liệu thuộc đơn vị ${companyId}.`
        });
      }
    }

    // 3. Tìm file trên ổ đĩa
    const resolvedPath = resolvePhysicalFile(cleanName, docPath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      return res.status(404).json({
        success: false,
        error: `404 Not Found: Tệp tài liệu "${cleanName}" không tồn tại trên hệ thống lưu trữ máy chủ.`
      });
    }

    const downloadMode = req.query.download === '1' || req.query.mode === 'download';
    const disposition = downloadMode ? 'attachment' : 'inline';
    const ext = path.extname(cleanName).toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf' :
                    ext === '.png' ? 'image/png' :
                    (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' :
                    'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(cleanName)}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  } catch (err) {
    console.error('Lỗi khi tải tệp hồ sơ:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 1.6. GET /api/employees/:id/file - Xem trước hoặc tải tệp tài liệu số hóa của nhân sự theo ID/mã NV
 */
router.get('/:id/file', verifyToken, async (req, res) => {
  const { id } = req.params;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  try {
    // 1. Tìm thông tin nhân sự
    let empRes;
    if (isUuid) {
      empRes = await db.query(
        `SELECT e.id, e.employee_code, e.employee_name, e.company_id, e.citizen_id, p.file_name AS profile_file_name
         FROM employees e
         LEFT JOIN hr_employee_profiles p ON p.employment_id = e.id
         WHERE e.id = $1 LIMIT 1`,
        [id]
      );
    } else {
      empRes = await db.query(
        `SELECT e.id, e.employee_code, e.employee_name, e.company_id, e.citizen_id, p.file_name AS profile_file_name
         FROM employees e
         LEFT JOIN hr_employee_profiles p ON p.employment_id = e.id
         WHERE e.employee_code = $1 OR e.citizen_id = $1 LIMIT 1`,
        [id]
      );
    }

    let emp = empRes.rows[0];
    if (!emp) {
      const profRes = await db.query(
        `SELECT id, employee_id AS employee_code, full_name AS employee_name, company_id, citizen_id, file_name AS profile_file_name
         FROM hr_employee_profiles
         WHERE id::text = $1 OR employee_id = $1 OR citizen_id = $1 LIMIT 1`,
        [id]
      );
      emp = profRes.rows[0];
    }

    if (!emp) {
      return res.status(404).json({ success: false, error: '404 Not Found: Không tìm thấy hồ sơ nhân sự.' });
    }

    // 2. Quyền & Tenant Isolation
    if (req.user.role === 'EMPLOYEE') {
      if (req.user.employee_id && String(req.user.employee_id) !== String(emp.id) && req.user.employee_code !== emp.employee_code) {
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Bạn chỉ có thể xem tài liệu hồ sơ của chính mình.'
        });
      }
    } else if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      if (req.user.company_id && emp.company_id && req.user.company_id.toUpperCase() !== emp.company_id.toUpperCase()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: Bạn không có quyền truy cập hồ sơ nhân sự thuộc đơn vị ${emp.company_id}.`
        });
      }
    }

    // 3. Tìm tệp hồ sơ
    let targetFileName = req.query.fileName || emp.profile_file_name;
    let docPath = null;

    if (emp.id) {
      const docRes = await db.query(
        `SELECT file_name, file_storage_path, mime_type
         FROM hr_employment_documents
         WHERE employment_id = $1 ${targetFileName ? 'AND file_name = $2' : ''}
         ORDER BY CASE WHEN document_type = 'ID_CARD' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`,
        targetFileName ? [emp.id, targetFileName] : [emp.id]
      );
      if (docRes.rows.length > 0) {
        docPath = docRes.rows[0].file_storage_path;
        targetFileName = docRes.rows[0].file_name;
      }
    }

    if (!docPath || !fs.existsSync(docPath)) {
      const stgRes = await db.query(
        `SELECT file_name, file_storage_path, mime_type
         FROM hr_employee_staging
         WHERE (employee_code = $1 OR target_employee_code = $1 ${targetFileName ? 'OR file_name = $2' : ''})
           AND file_storage_path IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        targetFileName ? [emp.employee_code, targetFileName] : [emp.employee_code]
      );
      if (stgRes.rows.length > 0) {
        docPath = stgRes.rows[0].file_storage_path;
        targetFileName = targetFileName || stgRes.rows[0].file_name;
      }
    }

    const resolvedPath = resolvePhysicalFile(targetFileName, docPath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      return res.status(404).json({
        success: false,
        error: `404 Not Found: Tệp tài liệu số hóa "${targetFileName || 'ho_so.pdf'}" không tồn tại trên hệ thống lưu trữ máy chủ.`
      });
    }

    const downloadMode = req.query.download === '1' || req.query.mode === 'download';
    const disposition = downloadMode ? 'attachment' : 'inline';
    const cleanFileName = path.basename(targetFileName || resolvedPath);
    const ext = path.extname(cleanFileName).toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf' :
                    ext === '.png' ? 'image/png' :
                    (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' :
                    'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(cleanFileName)}"; filename*=UTF-8''${encodeURIComponent(cleanFileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  } catch (err) {
    console.error('Lỗi khi tải tệp hồ sơ nhân viên:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 1.7. GET /api/employees/:id/documents - Danh sách toàn bộ tài liệu hồ sơ của nhân sự
 */
router.get('/:id/documents', verifyToken, async (req, res) => {
  const { id } = req.params;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  try {
    let empRes;
    if (isUuid) {
      empRes = await db.query(
        `SELECT e.id, e.employee_code, e.employee_name, e.company_id, p.file_name AS profile_file_name
         FROM employees e
         LEFT JOIN hr_employee_profiles p ON p.employment_id = e.id
         WHERE e.id = $1 LIMIT 1`,
        [id]
      );
    } else {
      empRes = await db.query(
        `SELECT e.id, e.employee_code, e.employee_name, e.company_id, p.file_name AS profile_file_name
         FROM employees e
         LEFT JOIN hr_employee_profiles p ON p.employment_id = e.id
         WHERE e.employee_code = $1 OR e.citizen_id = $1 LIMIT 1`,
        [id]
      );
    }

    const emp = empRes.rows[0];
    if (!emp) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự.' });
    }

    if (req.user.role === 'EMPLOYEE' && req.user.employee_code !== emp.employee_code) {
      return res.status(403).json({ success: false, error: '403 Forbidden' });
    } else if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      if (req.user.company_id && emp.company_id && req.user.company_id.toUpperCase() !== emp.company_id.toUpperCase()) {
        return res.status(403).json({ success: false, error: '403 Forbidden' });
      }
    }

    const docsRes = await db.query(
      `SELECT id, document_type, file_name, file_size, mime_type, created_at
       FROM hr_employment_documents
       WHERE employment_id = $1
       ORDER BY created_at DESC`,
      [emp.id]
    );

    const docs = docsRes.rows.map(d => ({
      ...d,
      preview_url: `/api/employees/${encodeURIComponent(emp.id)}/file?fileName=${encodeURIComponent(d.file_name)}`,
      download_url: `/api/employees/${encodeURIComponent(emp.id)}/file?fileName=${encodeURIComponent(d.file_name)}&download=1`
    }));

    if (docs.length === 0 && emp.profile_file_name) {
      docs.push({
        id: 'ocr-primary',
        document_type: 'OCR_PROFILE',
        file_name: emp.profile_file_name,
        file_size: null,
        mime_type: 'application/pdf',
        preview_url: `/api/employees/${encodeURIComponent(emp.id)}/file`,
        download_url: `/api/employees/${encodeURIComponent(emp.id)}/file?download=1`
      });
    }

    return res.json({ success: true, documents: docs });
  } catch (err) {
    console.error('Lỗi khi lấy danh sách tài liệu:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 2. GET /api/employees/:id - Chi tiết hồ sơ nhân sự & dữ liệu OCR liên kết (53 trường theo 7 nhóm chuẩn)
 */
router.get('/:id', verifyToken, requireRoles('ADMIN', 'HR', 'EMPLOYEE'), async (req, res) => {
  const { id } = req.params;

  // Bảo vệ IDOR: Nhân viên thường (EMPLOYEE) chỉ được xem hồ sơ của chính mình
  if (req.user.role === 'EMPLOYEE') {
    if (!req.user.employee_id || String(req.user.employee_id) !== String(id)) {
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Nhân viên chỉ được xem hồ sơ của chính mình, không có quyền xem hồ sơ người khác.'
      });
    }
  }

  try {
    const empRes = await db.query(
      `SELECT e.id, e.employee_code, e.citizen_id, e.employee_name, e.company_id, e.department, e.position,
              e.email, e.status, 
              COALESCE(e.resignation_date, '') AS resignation_date,
              COALESCE(e.resignation_reason, '') AS resignation_reason,
              e.created_at, e.updated_at,
              c.company_name,
              u.user_id AS linked_user_id,
              u.username AS linked_username,
              u.role AS linked_role,
              u.status AS linked_user_status,
              CASE WHEN u.user_id IS NOT NULL THEN true ELSE false END AS has_user_account
       FROM employees e
       LEFT JOIN companies c ON e.company_id = c.id
       LEFT JOIN LATERAL (
         SELECT u.user_id, u.username, u.role, u.status 
         FROM users u 
         WHERE u.employee_id = e.id 
         ORDER BY CASE WHEN u.role = 'HR' THEN 1 WHEN u.role = 'ADMIN' THEN 2 ELSE 3 END ASC, u.user_id ASC 
         LIMIT 1
       ) u ON true
       WHERE e.id = $1`,
      [id]
    );

    if (empRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự.' });
    }

    const employee = empRes.rows[0];

    // Tenant Isolation (HR, EMPLOYEE)
    if (['HR', 'EMPLOYEE'].includes(req.user.role)) {
      if (employee.company_id !== req.user.company_id) {
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Bạn không có quyền xem hồ sơ nhân sự của công ty khác.'
        });
      }
    }

    // Tra cứu chi tiết hồ sơ OCR từ bảng hr_employee_profiles (chỉ khớp theo citizen_id hoặc employee_code, tuyệt đối không khớp theo tên)
    let ocrProfile = null;
    try {
      const empCitizenId = String(employee.citizen_id || '').trim();
      const empCode = String(employee.employee_code || '').trim();

      const ocrRes = await db.query(
        `SELECT * FROM hr_employee_profiles 
         WHERE (
           ($1::varchar <> '' AND citizen_id = $1::varchar) OR
           ($2::varchar <> '' AND employee_id = $2::varchar) OR
           ($2::varchar <> '' AND citizen_id = $2::varchar)
         )
         AND (company_id = $3::varchar OR company_id IS NULL)
         ORDER BY id DESC LIMIT 1`,
        [empCitizenId, empCode, employee.company_id]
      );
      if (ocrRes.rows.length > 0) {
        ocrProfile = ocrRes.rows[0];
      }
    } catch (e) {
      console.warn('OCR lookup warning:', e.message);
    }

    const p = ocrProfile || {};
    const isEmployeeRole = req.user.role === 'EMPLOYEE';

    // Masking CCCD nếu là Employee role
    let cccd = p.citizen_id || '';
    if (isEmployeeRole && cccd && cccd.length >= 6) {
      cccd = cccd.substring(0, 3) + '******' + cccd.substring(cccd.length - 3);
    }

    // Tổ chức 7 nhóm chuẩn dữ liệu
    const fullProfile = {
      // 1. Thông tin cá nhân và giấy tờ
      personal_info: {
        employee_id: p.employee_id || employee.employee_code || '',
        full_name: p.full_name || employee.employee_name || '',
        date_of_birth: p.date_of_birth || '',
        gender: p.gender || '',
        citizen_id: cccd,
        citizen_id_issue_date: p.citizen_id_issue_date || '',
        citizen_id_issue_place: p.citizen_id_issue_place || '',
        birth_registration_place: p.birth_registration_place || '',
        place_of_origin: p.place_of_origin || '',
        ethnicity: p.ethnicity || ''
      },
      // 2. Địa chỉ
      address_info: {
        permanent_address: p.permanent_address || '',
        temporary_address: p.temporary_address || '',
        current_address: p.current_address || ''
      },
      // 3. Công việc
      job_info: {
        job_grade: p.job_grade || '',
        job_title: p.job_title || employee.position || '',
        professional_title: p.professional_title || '',
        department_staffing_plan: p.department_staffing_plan || employee.department || '',
        section_staffing_plan: p.section_staffing_plan || '',
        employment_start_date: p.employment_start_date || '',
        recruitment_decision_no: p.recruitment_decision_no || '',
        official_labor_contract_sign_date: p.official_labor_contract_sign_date || '',
        resignation_date: employee.resignation_date || p.resignation_date || '',
        resignation_reason: employee.resignation_reason || p.resignation_reason || ''
      },
      // 4. Trình độ và đào tạo
      education_info: {
        education_level: p.education_level || '',
        education_code: p.education_code || '',
        qualification: p.qualification || '',
        professional_qualification: p.professional_qualification || '',
        specialization: p.specialization || '',
        degree_qualification: p.degree_qualification || '',
        training_institution: p.training_institution || '',
        major: p.major || '',
        training_mode: p.training_mode || '',
        training_period: p.training_period || '',
        graduation_grade: p.graduation_grade || '',
        degree_valid_until: p.degree_valid_until || '',
        other_professional_certificates: p.other_professional_certificates || ''
      },
      // 5. Lương và phụ cấp (Bảo vệ dữ liệu nhạy cảm nếu là Employee)
      salary_info: isEmployeeRole ? {
        note: 'Thông tin tiền lương và thu nhập được bảo mật riêng tư.'
      } : {
        social_insurance_salary: p.social_insurance_salary || '',
        total_income: p.total_income || '',
        base_salary: p.base_salary || '',
        productivity_responsibility_pay: p.productivity_responsibility_pay || '',
        attendance_bonus: p.attendance_bonus || '',
        responsibility_allowance: p.responsibility_allowance || '',
        vessel_size_allowance: p.vessel_size_allowance || '',
        professional_allowance_t1: p.professional_allowance_t1 || '',
        meal_allowance: p.meal_allowance || '',
        other_allowances: p.other_allowances || ''
      },
      // 6. Hợp đồng
      contract_info: {
        open_ended_contract: p.open_ended_contract || '',
        fixed_term_contract: p.fixed_term_contract || '',
        seasonal_contract: p.seasonal_contract || '',
        contract_start_date: p.contract_start_date || '',
        contract_end_date: p.contract_end_date || ''
      },
      // 7. Liên hệ và dữ liệu nguồn
      contact_and_source: {
        phone_number: p.phone_number || '',
        email: p.email || employee.email || '',
        Create_Time: p.create_time || employee.created_at || '',
        create_time: p.create_time || employee.created_at || '',
        fileName: p.file_name || '',
        file_name: p.file_name || ''
      },
      // Hệ thống
      system_info: {
        id: employee.id,
        company_id: employee.company_id,
        company_name: employee.company_name,
        status: employee.status,
        resignation_date: employee.resignation_date || '',
        resignation_reason: employee.resignation_reason || '',
        created_at: employee.created_at,
        updated_at: employee.updated_at,
        has_user_account: employee.has_user_account,
        linked_user_id: employee.linked_user_id,
        linked_username: employee.linked_username,
        linked_role: employee.linked_role,
        linked_user_status: employee.linked_user_status
      }
    };

    return res.json({
      success: true,
      employee,
      ocr_profile: ocrProfile,
      profile: fullProfile
    });
  } catch (err) {
    console.error('Get employee detail error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tải chi tiết hồ sơ nhân sự.' });
  }
});

/**
 * 2.1 POST /api/employees/upload-ocr - Tải lên hồ sơ scan (PDF/ảnh), bóc tách AI và lưu trữ
 * Quyền: ADMIN, HR
 */
router.post('/upload-ocr', (req, res) => {
  return res.status(410).json({
    success: false,
    error: '410 Gone: Endpoint này đã ngừng hoạt động hoàn toàn. Toàn bộ quy trình tiếp nhận và bóc tách hồ sơ nhân sự đã được chuyển giao sang n8n qua webhook /webhook/hr-lifecycle-upload.'
  });
});

/**
 * 2.2 POST /api/employees/parse-ocr - Bóc tách hồ sơ scan bằng AI và kiểm tra chống trùng lặp (Preview & Deduplication)
 * Quyền: ADMIN, HR
 * Thao tác này CHỈ trích xuất dữ liệu và kiểm tra CSDL, KHÔNG lưu trực tiếp vào CSDL để người dùng xem trước.
 */
router.post('/parse-ocr', verifyToken, requireRoles('ADMIN', 'HR'), upload.any(), async (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);
  if (!files.length) {
    return res.status(400).json({ success: false, error: 'Vui lòng chọn tệp scan (PDF, JPG, PNG) để tải lên.' });
  }

  try {
    // SOTRANS HUB MIGRATION: Forward all intake uploads directly to n8n Master Lifecycle Workflow
    const { forwardUploadToN8n } = require('../services/n8nLifecycleProxy');
    const compId = req.user.role === 'ADMIN'
      ? (req.body.company_id && ['STL', 'VTX', 'SWC'].includes(String(req.body.company_id).toUpperCase())
          ? String(req.body.company_id).toUpperCase()
          : (req.user.company_id || 'SWC'))
      : req.user.company_id;

    const n8nRes = await forwardUploadToN8n(req, files, { company_id: compId, event_type: 'HR_UPLOAD' });
    return res.status(n8nRes.status || 200).json(n8nRes.body);
  } catch (err) {
    console.error('Parse OCR error via n8n:', err);
    return res.status(500).json({ success: false, error: 'Lỗi bóc tách OCR qua n8n: ' + err.message });
  }
});

/**
 * 2.3 POST /api/employees/confirm-ocr - Xác nhận lưu dữ liệu đã bóc tách (Tạo mới hoặc Cập nhật)
 * Quyền: ADMIN, HR
 * Nghiệp vụ đa công ty:
 * - Update: Không bao giờ thay đổi company_id và employee_code của nhân viên. Bắt buộc kiểm tra quyền quản lý.
 * - Create: Kiểm tra chống trùng CCCD và Mã NV trên toàn hệ thống.
 */
router.post('/confirm-ocr', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  const { action, target_employee_id, profile, company_id } = req.body || {};
  if (!profile) {
    return res.status(400).json({ success: false, error: 'Thiếu dữ liệu hồ sơ để lưu.' });
  }

  const cleanName = String(profile.full_name || '').trim();
  const cleanCode = String(profile.employee_code || profile.citizen_id || '').trim();
  const cleanCccd = profile.citizen_id ? String(profile.citizen_id).replace(/\D/g, '') : null;

  if (!cleanName) {
    return res.status(400).json({ success: false, error: 'Họ tên nhân viên không được để trống.' });
  }
  if (!cleanCode) {
    return res.status(400).json({ success: false, error: 'Mã nhân viên hoặc số định danh không được để trống.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let savedEmployee = null;

    if (action === 'update') {
      if (!target_employee_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Thiếu ID nhân viên để cập nhật.' });
      }

      // 1. Kiểm tra hồ sơ hiện có trong CSDL
      const existEmpRes = await client.query('SELECT * FROM employees WHERE id = $1', [target_employee_id]);
      if (existEmpRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân viên để cập nhật.' });
      }
      const existingRecord = existEmpRes.rows[0];

      // 2. Kiểm tra phân quyền đa công ty:
      // HR mặc định CHỈ được quản lý nhân viên thuộc công ty của mình.
      // Nếu nhân viên thuộc công ty khác và user không phải ADMIN -> Chặn 403 Forbidden!
      if (req.user.role !== 'ADMIN' && req.user.company_id !== existingRecord.company_id) {
        await client.query('ROLLBACK');
        await logAudit({
          actor_user_id: req.user.user_id,
          actor_username: req.user.username,
          action: 'employee_ocr_update_cross_company_blocked',
          status: 'DENIED',
          ip_address: req.ip,
          metadata: {
            target_employee_id,
            target_company: existingRecord.company_id,
            user_company: req.user.company_id,
            attempted_action: 'update'
          }
        });
        return res.status(403).json({
          success: false,
          error: `Bạn không có quyền cập nhật hồ sơ của nhân viên thuộc đơn vị ${existingRecord.company_id}. Dữ liệu hiện có được bảo toàn tuyệt đối.`
        });
      }

      // 3. Thực hiện CẬP NHẬT:
      // TUYỆT ĐỐI KHÔNG thay đổi company_id và employee_code trong quy trình OCR!
      // Giữ nguyên công ty quản lý chính thức của nhân viên (existingRecord.company_id).
      const updateEmp = await client.query(
        `UPDATE employees
         SET employee_name = $1,
             department = COALESCE(NULLIF($2::varchar, ''), department),
             position = COALESCE(NULLIF($3::varchar, ''), position),
             email = COALESCE(NULLIF($4::varchar, ''), email),
             citizen_id = COALESCE(NULLIF($5::varchar, ''), citizen_id),
             updated_at = now()
         WHERE id = $6
         RETURNING *`,
        [
          cleanName,
          profile.department || null,
          profile.job_title || null,
          profile.email || null,
          cleanCccd,
          target_employee_id
        ]
      );
      savedEmployee = updateEmp.rows[0];

      // 4. Cập nhật bảng chi tiết hr_employee_profiles (công ty giữ nguyên existingRecord.company_id)
      if (cleanCccd) {
        await client.query(
          `INSERT INTO hr_employee_profiles (
             employee_id, full_name, date_of_birth, gender,
             job_title, department_staffing_plan, citizen_id,
             citizen_id_issue_date, citizen_id_issue_place, place_of_origin,
             permanent_address, current_address, ethnicity, education_level,
             qualification, major, training_institution, graduation_grade,
             base_salary, productivity_responsibility_pay, attendance_bonus, meal_allowance,
             recruitment_decision_no, employment_start_date, phone_number, email,
             file_name, company_id
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
           ON CONFLICT (citizen_id) DO UPDATE SET
             full_name = EXCLUDED.full_name,
             job_title = COALESCE(NULLIF(EXCLUDED.job_title, ''), hr_employee_profiles.job_title),
             department_staffing_plan = COALESCE(NULLIF(EXCLUDED.department_staffing_plan, ''), hr_employee_profiles.department_staffing_plan),
             base_salary = COALESCE(NULLIF(EXCLUDED.base_salary, ''), hr_employee_profiles.base_salary),
             recruitment_decision_no = COALESCE(NULLIF(EXCLUDED.recruitment_decision_no, ''), hr_employee_profiles.recruitment_decision_no),
             employment_start_date = COALESCE(NULLIF(EXCLUDED.employment_start_date, ''), hr_employee_profiles.employment_start_date),
             email = COALESCE(NULLIF(EXCLUDED.email, ''), hr_employee_profiles.email),
             phone_number = COALESCE(NULLIF(EXCLUDED.phone_number, ''), hr_employee_profiles.phone_number),
             permanent_address = COALESCE(NULLIF(EXCLUDED.permanent_address, ''), hr_employee_profiles.permanent_address),
             current_address = COALESCE(NULLIF(EXCLUDED.current_address, ''), hr_employee_profiles.current_address)`,
          [
            existingRecord.employee_code, cleanName, profile.date_of_birth || null, profile.gender || null,
            profile.job_title || null, profile.department || null, cleanCccd,
            profile.citizen_id_issue_date || null, profile.citizen_id_issue_place || null, profile.place_of_origin || null,
            profile.permanent_address || null, profile.current_address || null, profile.ethnicity || 'Kinh', profile.education_level || null,
            profile.qualification || null, profile.major || null, profile.training_institution || null, profile.graduation_grade || null,
            profile.base_salary || null, profile.productivity_responsibility_pay || null, profile.attendance_bonus || null, profile.meal_allowance || null,
            profile.recruitment_decision_no || null, profile.employment_start_date || null, profile.phone_number || null, profile.email || null,
            profile.file_name || null, existingRecord.company_id
          ]
        );
      }

      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'employee_ocr_updated',
        status: 'SUCCESS',
        ip_address: req.ip,
        metadata: { employee_id: savedEmployee.id, employee_name: cleanName, company_id: existingRecord.company_id }
      });

    } else if (action === 'create') {
      // TẠO MỚI HỒ SƠ QUA CỔNG TIẾP NHẬN (SINGLE INGESTION GATEWAY)
      // Xác định công ty mục tiêu tạo mới:
      const targetComp = req.user.role === 'ADMIN'
        ? (company_id && ['STL', 'VTX', 'SWC'].includes(String(company_id).toUpperCase()) ? String(company_id).toUpperCase() : 'SWC')
        : (req.user.company_id || 'SWC');

      // Đồng bộ cơ chế khóa Advisory Lock xuyên kênh
      if (cleanCccd) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCccd]);
        const dupCheck = await checkDatabaseCccdDuplicates(cleanCccd, targetComp, req.user, cleanName, client);
        if (dupCheck && dupCheck.hasDuplicate) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: `Từ chối tiếp nhận: ${dupCheck.reason}`
          });
        }
      }

      // 1. Đồng bộ Staging record: Sử dụng lại staging record do processIntakeFiles tạo nếu có, tránh tạo thừa
      const incomingStagingId = req.body.staging_id || profile.staging_id;
      let stagingRow = null;

      if (incomingStagingId) {
        const stRes = await client.query('SELECT * FROM hr_employee_staging WHERE id = $1 FOR UPDATE', [incomingStagingId]);
        if (stRes.rows.length > 0) {
          stagingRow = stRes.rows[0];
        }
      }

      if (stagingRow) {
        // Cập nhật lại bản ghi Staging hiện có với dữ liệu đã được người dùng chỉnh sửa/xác nhận
        const existingExtracted = typeof stagingRow.extracted_data === 'string'
          ? JSON.parse(stagingRow.extracted_data)
          : (stagingRow.extracted_data || {});
        const mergedExtracted = {
          ...existingExtracted,
          ...profile,
          full_name: cleanName,
          citizen_id: cleanCccd,
          company_id: targetComp
        };

        const updateStagingRes = await client.query(`
          UPDATE hr_employee_staging SET
            full_name = $1,
            citizen_id = $2,
            date_of_birth = $3,
            gender = $4,
            job_title = $5,
            department = $6,
            email = $7,
            phone_number = $8,
            recruitment_decision_no = $9,
            employment_start_date = $10,
            base_salary = $11,
            company_id = $12,
            extracted_data = $13::jsonb,
            staging_status = $14,
            updated_at = NOW()
          WHERE id = $15
          RETURNING *;
        `, [
          cleanName,
          cleanCccd,
          profile.date_of_birth || null,
          profile.gender || 'KHAC',
          profile.job_title || null,
          profile.department || null,
          profile.email || null,
          profile.phone_number || null,
          profile.recruitment_decision_no || null,
          profile.employment_start_date || null,
          profile.base_salary || null,
          targetComp,
          JSON.stringify(mergedExtracted),
          (req.user.role === 'HR' ? 'pending_approval' : stagingRow.staging_status),
          stagingRow.id
        ]);
        stagingRow = updateStagingRes.rows[0];
      } else {
        // Tạo bản ghi Staging mới nếu chưa có
        const batchId = crypto.randomUUID();
        const stagingRes = await client.query(`
          INSERT INTO hr_employee_staging (
            batch_id, file_name, full_name, citizen_id, employee_code,
            date_of_birth, gender, job_title, department, email,
            phone_number, recruitment_decision_no, employment_start_date, base_salary, company_id,
            company_status, company_evidence, staging_status, extracted_data, uploaded_by, uploaded_by_user_id,
            intake_mode, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, NULL,
            $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14,
            'confirmed', 'Tiếp nhận qua OCR AI', 'pending_approval', $15::jsonb, $16, $17,
            'new_profile', NOW(), NOW()
          ) RETURNING *;
        `, [
          batchId, profile.file_name || 'ho_so_ocr.pdf', cleanName, cleanCccd,
          profile.date_of_birth || null, profile.gender || 'KHAC', profile.job_title || null, profile.department || null, profile.email || null,
          profile.phone_number || null, profile.recruitment_decision_no || null, profile.employment_start_date || null, profile.base_salary || null, targetComp,
          JSON.stringify(profile), req.user.username, req.user.user_id
        ]);
        stagingRow = stagingRes.rows[0];
      }

      if (req.user.role === 'HR') {
        // HR gửi vào Staging chờ ADMIN duyệt
        await client.query('COMMIT');
        await logAudit({
          actor_user_id: req.user.user_id,
          actor_username: req.user.username,
          action: 'HR_INTAKE_OCR_SUBMITTED',
          status: 'SUCCESS',
          ip_address: req.ip,
          metadata: { staging_id: stagingRow.id, full_name: cleanName, company_id: targetComp }
        });
        return res.status(201).json({
          success: true,
          message: 'Hồ sơ đã được gửi vào Staging và chuyển trạng thái chờ Quản trị viên (ADMIN) phê duyệt!',
          staging_id: stagingRow.id,
          status: 'pending_approval'
        });
      }

      // ADMIN: Thực hiện Direct Onboard qua executeStagingApproval (chuẩn hóa Person-Employment & cấp mã tự động)
      const approvalResult = await executeStagingApproval(client, stagingRow, req.user);
      savedEmployee = {
        id: approvalResult.employee_id,
        employee_code: approvalResult.code,
        employee_name: cleanName,
        company_id: targetComp,
        citizen_id: cleanCccd,
        department: profile.department || null,
        position: profile.job_title || null,
        email: profile.email || null,
        status: 'ACTIVE'
      };

      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'employee_ocr_created_direct_onboard',
        status: 'SUCCESS',
        ip_address: req.ip,
        metadata: {
          employee_id: savedEmployee.id,
          employee_code: savedEmployee.employee_code,
          employee_name: cleanName,
          company_id: targetComp,
          staging_id: stagingRow.id
        }
      });
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Hành động không hợp lệ (chỉ chấp nhận update hoặc create).' });
    }

    await client.query('COMMIT');

    // Tự động xếp hàng đồng bộ sang NocoDB và Google Sheets cho hồ sơ OCR vừa lưu
    if (savedEmployee) {
      await queueEmployeeSync(savedEmployee.id, action === 'create' ? 'CREATE' : 'UPDATE', {
        employee_id: savedEmployee.employee_code,
        employee_code: savedEmployee.employee_code,
        full_name: savedEmployee.employee_name,
        company_id: savedEmployee.company_id,
        citizen_id: savedEmployee.citizen_id,
        department: savedEmployee.department,
        position: savedEmployee.position,
        email: savedEmployee.email,
        status: savedEmployee.status
      });
    }

    return res.json({
      success: true,
      message: action === 'update' ? 'Đã cập nhật hồ sơ nhân sự thành công!' : 'Đã tạo mới hồ sơ nhân sự thành công!',
      employee: savedEmployee
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Confirm OCR error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi lưu hồ sơ: ' + err.message });
  } finally {
    client.release();
  }
});

/**
 * 2.4 POST /api/employees/:id/create-account - Tạo tài khoản đăng nhập trực tiếp cho nhân sự đã có hồ sơ
 * Quyền: ADMIN, HR
 */
router.post('/:id/create-account', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  const { id } = req.params;
  const { username, password, role } = req.body || {};

  try {
    const empRes = await db.query(
      `SELECT e.id, e.employee_code, e.employee_name, e.company_id, e.department, e.position, e.email,
              u.user_id, u.username AS existing_username
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT u.user_id, u.username AS existing_username
         FROM users u
         WHERE u.employee_id = e.id
         LIMIT 1
       ) u ON true
       WHERE e.id = $1`,
      [id]
    );

    if (empRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự này.' });
    }

    const emp = empRes.rows[0];

    // Kiểm tra phân quyền phạm vi công ty
    if (req.user.role === 'HR' && emp.company_id !== req.user.company_id) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn chỉ được tạo tài khoản cho nhân sự thuộc công ty ${req.user.company_id}.`
      });
    }

    // Kiểm tra xem đã có tài khoản liên kết chưa
    if (emp.user_id) {
      return res.status(400).json({
        success: false,
        error: `Nhân viên "${emp.employee_name}" đã được liên kết với tài khoản "@${emp.existing_username}".`
      });
    }

    // Chuẩn hóa username
    let cleanUsername = username ? String(username).trim().toLowerCase() : '';
    if (!cleanUsername) {
      const nameParts = emp.employee_name.trim().toLowerCase().split(/\s+/);
      const lastName = nameParts[nameParts.length - 1];
      const initials = nameParts.slice(0, -1).map(p => p[0]).join('');
      const normalized = (lastName + initials).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
      const codeSuffix = emp.employee_code ? emp.employee_code.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
      cleanUsername = `${normalized || 'user'}.${codeSuffix || emp.company_id.toLowerCase()}`;
    }

    if (!/^[a-zA-Z0-9._-]{3,50}$/.test(cleanUsername)) {
      return res.status(400).json({
        success: false,
        error: 'Tên đăng nhập phải từ 3 đến 50 ký tự, chỉ gồm chữ cái, chữ số, dấu chấm, gạch dưới hoặc gạch ngang.'
      });
    }

    // Kiểm tra trùng username
    const existUser = await db.query(`SELECT user_id FROM users WHERE username = $1`, [cleanUsername]);
    if (existUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Tên đăng nhập "${cleanUsername}" đã được sử dụng. Vui lòng chọn tên đăng nhập khác.`
      });
    }

    // Mật khẩu khởi tạo
    const rawPassword = password ? String(password).trim() : 'Sotrans@2026!';
    if (rawPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Mật khẩu phải có tối thiểu 8 ký tự.' });
    }

    // Vai trò
    let targetRole = role || 'EMPLOYEE';
    if (req.user.role === 'HR') {
      if (!['EMPLOYEE', 'USER'].includes(targetRole)) {
        targetRole = 'EMPLOYEE';
      }
    } else if (req.user.role === 'ADMIN') {
      if (!['ADMIN', 'HR', 'EMPLOYEE', 'USER'].includes(targetRole)) {
        targetRole = 'EMPLOYEE';
      }
    }

    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const newUser = await db.query(
      `INSERT INTO users (
         username, password_hash, role, company_id, employee_id, status,
         failed_login_attempts, must_change_password, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 0, true, now(), now())
       RETURNING user_id, username, role, company_id, employee_id, status, created_at`,
      [cleanUsername, passwordHash, targetRole, emp.company_id, emp.id]
    );

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'user_created_for_employee',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: { employee_id: emp.id, username: cleanUsername, role: targetRole }
    });

    return res.json({
      success: true,
      message: `Đã cấp tài khoản "@${cleanUsername}" cho nhân viên "${emp.employee_name}" thành công!`,
      user: newUser.rows[0],
      temp_password: rawPassword
    });

  } catch (err) {
    console.error('Create account for employee error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tạo tài khoản: ' + err.message });
  }
});

/**
 * 3. POST /api/employees - Thêm mới hồ sơ nhân sự (Nghiệp vụ HR)
 * Quyền: ADMIN, HR
 * Lưu ý: Thao tác này CHỈ tạo hồ sơ nhân sự, KHÔNG tạo tài khoản người dùng
 */
router.post('/', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  if (req.user.role === 'HR') {
    return res.status(403).json({
      success: false,
      code: 'HR_DIRECT_MASTER_WRITE_FORBIDDEN',
      error: '403 Forbidden: Vai trò HR không có quyền tạo trực tiếp nhân sự vào Master Data. Vui lòng gửi hồ sơ qua phân hệ Tiếp nhận & Phê duyệt Staging (/api/hoso/intake/manual-draft).'
    });
  }
  const {
    employee_code,
    employee_name,
    company_id,
    department,
    position,
    email,
    citizen_id,
    status
  } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!employee_code || !String(employee_code).trim()) {
    return res.status(400).json({ success: false, error: 'Mã nhân viên không được để trống.' });
  }
  if (!employee_name || !String(employee_name).trim()) {
    return res.status(400).json({ success: false, error: 'Họ tên nhân viên không được để trống.' });
  }

  const cleanCode = String(employee_code).trim();
  const cleanCitizenId = citizen_id ? String(citizen_id).replace(/\D/g, '') : null;
  const cleanName = String(employee_name).trim();

  // Kiểm tra không cho phép truyền trường tài khoản hệ thống qua API tạo hồ sơ
  if (req.body.role !== undefined || req.body.system_role !== undefined) {
    return res.status(400).json({
      success: false,
      error: 'Thao tác không hợp lệ: API này chỉ dùng để tạo Hồ sơ nhân sự, không dùng để cấp vai trò hệ thống (Role).'
    });
  }
  if (req.body.username !== undefined || req.body.password !== undefined) {
    return res.status(400).json({
      success: false,
      error: 'Thao tác không hợp lệ: API này chỉ dùng để tạo Hồ sơ nhân sự, không tự động tạo tài khoản đăng nhập (username/password).'
    });
  }

  // Xác định công ty & kiểm tra phân quyền công ty
  let targetCompanyId = null;
  if (req.user.role === 'HR') {
    if (company_id && String(company_id).trim().toUpperCase() !== req.user.company_id) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn chỉ được phép tạo hồ sơ nhân sự trong phạm vi công ty được phân công (${req.user.company_id}).`
      });
    }
    targetCompanyId = req.user.company_id;
  } else if (req.user.role === 'ADMIN') {
    if (!company_id) {
      return res.status(400).json({ success: false, error: 'Vui lòng chọn công ty cho hồ sơ nhân sự.' });
    }
    targetCompanyId = String(company_id).trim().toUpperCase();
  }

  // Kiểm tra định dạng mã nhân viên theo quy tắc công ty
  if (targetCompanyId && COMPANY_CODE_PATTERNS[targetCompanyId]) {
    const pat = COMPANY_CODE_PATTERNS[targetCompanyId];
    if (!pat.regex.test(cleanCode)) {
      return res.status(400).json({ success: false, error: pat.hint });
    }
  }

  // Kiểm tra định dạng email nếu có
  if (email && email.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'Địa chỉ email không đúng định dạng.' });
    }
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Đồng bộ cơ chế khóa Advisory Lock xuyên kênh (P1)
    if (cleanCitizenId && (cleanCitizenId.length === 9 || cleanCitizenId.length === 12)) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCitizenId]);
    }

    // Kiểm tra tính duy nhất của cặp (company_id, employee_code)
    const existing = await client.query(
      `SELECT id, employee_code, employee_name FROM employees WHERE company_id = $1 AND employee_code = $2`,
      [targetCompanyId, cleanCode]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Mã nhân viên "${cleanCode}" đã tồn tại trong công ty ${targetCompanyId} (Họ tên: ${existing.rows[0].employee_name}).`
      });
    }

    // Kiểm tra tính duy nhất của citizen_id nếu có (toàn hệ thống và theo công ty)
    if (cleanCitizenId && (cleanCitizenId.length === 9 || cleanCitizenId.length === 12)) {
      const existingCccdAll = await client.query(
        `SELECT id, employee_code, employee_name, company_id, status FROM employees WHERE citizen_id = $1`,
        [cleanCitizenId]
      );
      if (existingCccdAll.rows.length > 0) {
        await client.query('ROLLBACK');
        const found = existingCccdAll.rows[0];
        if (found.company_id !== targetCompanyId) {
          return res.status(400).json({
            success: false,
            is_cross_company: true,
            error: `Cảnh báo trùng định danh liên công ty: Số CCCD/Định danh "${cleanCitizenId}" đang thuộc nhân sự "${found.employee_name}" (Mã: ${found.employee_code}) tại đơn vị ${found.company_id}. Hệ thống không tự động ghi đè hoặc chuyển công ty.`
          });
        }
        if (found.status === 'DELETED') {
          return res.status(400).json({
            success: false,
            can_restore: true,
            is_soft_deleted: true,
            existing_employee_id: found.id,
            existing_employee_code: found.employee_code,
            error: `Số CCCD/Định danh "${cleanCitizenId}" thuộc hồ sơ đã xóa mềm "${found.employee_name}" (Mã NV: ${found.employee_code}). Bạn có thể sử dụng chức năng Khôi phục hồ sơ thay vì tạo mới.`
          });
        }
        if (found.status === 'RESIGNED') {
          return res.status(400).json({
            success: false,
            is_resigned: true,
            existing_employee_id: found.id,
            existing_employee_code: found.employee_code,
            error: `Số CCCD/Định danh "${cleanCitizenId}" thuộc nhân viên đã nghỉ việc "${found.employee_name}" (Mã NV: ${found.employee_code}). Không tự động tạo mới hoặc kích hoạt lại; vui lòng thực hiện quy trình tái tiếp nhận (Rehire).`
          });
        }
        return res.status(400).json({
          success: false,
          error: `Số CCCD/Định danh "${cleanCitizenId}" đã tồn tại cho nhân viên "${found.employee_name}" (Mã: ${found.employee_code}, Trạng thái: ${found.status}).`
        });
      }
    }

    const empStatus = status && ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE';

    const insertRes = await client.query(
      `INSERT INTO employees (employee_code, citizen_id, employee_name, company_id, department, position, email, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       RETURNING *`,
      [
        cleanCode,
        cleanCitizenId || null,
        cleanName,
        targetCompanyId,
        department ? department.trim() : null,
        position ? position.trim() : null,
        email ? email.trim() : null,
        empStatus
      ]
    );

    const newEmp = insertRes.rows[0];
    await client.query('COMMIT');

    // Tự động xếp hàng đồng bộ sang NocoDB và Google Sheets cho nhân sự mới tạo (CHỈ GỌI SAU COMMIT THÀNH CÔNG)
    await queueEmployeeSync(newEmp.id, 'CREATE', {
      employee_id: cleanCode,
      employee_code: cleanCode,
      full_name: cleanName,
      employee_name: cleanName,
      company_id: targetCompanyId,
      department: newEmp.department,
      position: newEmp.position,
      email: newEmp.email,
      citizen_id: cleanCitizenId,
      status: empStatus
    });

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'employee_created',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: {
        employee_id: newEmp.id,
        employee_code: cleanCode,
        employee_name: cleanName,
        company_id: targetCompanyId,
        department: newEmp.department,
        position: newEmp.position
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Tạo hồ sơ nhân sự thành công.',
      employee: newEmp
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create employee error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tạo hồ sơ nhân sự: ' + err.message });
  } finally {
    client.release();
  }
});

/**
 * 4. PUT /api/employees/:id - Cập nhật hồ sơ nhân sự (Nghiệp vụ HR)
 * Quyền: ADMIN, HR
 * - Cho phép sửa thông tin nhân sự: Họ tên, phòng ban, chức vụ, email, trạng thái
 * - Khóa không cho HR đổi company_id hoặc employee_code trái phép
 */
router.put('/:id', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  const { id } = req.params;
  const { employee_name, department, position, email, phone_number, citizen_id, status } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  let client = null;
  try {
    const existingRes = await db.query(
      `SELECT * FROM employees WHERE id = $1`,
      [id]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự.' });
    }

    const currentEmp = existingRes.rows[0];
    const changes = {};

    // Tenant Isolation
    if (req.user.role === 'HR') {
      if (currentEmp.company_id !== req.user.company_id) {
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Bạn không có quyền chỉnh sửa hồ sơ nhân sự thuộc công ty khác.'
        });
      }
    }

    // 1. Chặn can thiệp trái phép vào các trường định danh cố định
    let newCompanyId = currentEmp.company_id;
    if (req.body.company_id !== undefined && String(req.body.company_id).trim().toUpperCase() !== String(currentEmp.company_id).trim().toUpperCase()) {
      if (req.user.role !== 'ADMIN') {
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Chỉ Quản trị viên (ADMIN) mới có quyền điều chuyển nhân sự sang công ty khác.'
        });
      }
      const targetCompany = String(req.body.company_id).trim().toUpperCase();
      const compCheck = await db.query('SELECT id FROM companies WHERE id = $1', [targetCompany]);
      if (compCheck.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Mã công ty điều chuyển không hợp lệ.' });
      }
      newCompanyId = targetCompany;
      changes.company_id = { from: currentEmp.company_id, to: newCompanyId };
    }

    if (req.body.employee_code !== undefined && String(req.body.employee_code).trim().toUpperCase() !== String(currentEmp.employee_code).trim().toUpperCase()) {
      return res.status(400).json({
        success: false,
        error: 'Thao tác không hợp lệ: Mã nhân viên (employee_code) là định danh cố định, không được phép thay đổi.'
      });
    }

    // 2. Chặn can thiệp trái phép vào vai trò hệ thống hoặc tài khoản người dùng
    if (req.body.role !== undefined || req.body.system_role !== undefined) {
      return res.status(400).json({
        success: false,
        error: 'Thao tác không hợp lệ: Không được phép cập nhật hoặc thay đổi vai trò hệ thống (Role) thông qua chức năng quản lý hồ sơ nhân sự. Thao tác này phải thực hiện qua chức năng Quản lý người dùng.'
      });
    }

    if (req.body.username !== undefined || req.body.password !== undefined || req.body.user_status !== undefined) {
      return res.status(400).json({
        success: false,
        error: 'Thao tác không hợp lệ: Không được phép can thiệp thông tin tài khoản người dùng (username/password/user_status) qua chức năng quản lý hồ sơ nhân sự.'
      });
    }

    if (employee_name !== undefined && !String(employee_name).trim()) {
      return res.status(400).json({ success: false, error: 'Họ tên nhân viên không được để trống.' });
    }

    if (email && email.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ success: false, error: 'Địa chỉ email không đúng định dạng.' });
      }
    }

    if (status && !['ACTIVE', 'INACTIVE', 'RESIGNED', 'DELETED'].includes(status.trim().toUpperCase())) {
      return res.status(400).json({ success: false, error: 'Trạng thái hồ sơ chỉ có thể là ACTIVE, INACTIVE, RESIGNED hoặc DELETED.' });
    }

    if (status !== undefined && status.trim().toUpperCase() !== currentEmp.status) {
      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'employee_update_rejected',
        status: 'BAD_REQUEST',
        ip_address: ip,
        metadata: {
          employee_id: id,
          current_status: currentEmp.status,
          attempted_status: status.trim().toUpperCase(),
          reason: 'Cannot alter lifecycle status via generic profile update endpoint'
        }
      });
      return res.status(400).json({
        success: false,
        error: 'Thao tác không hợp lệ: Không được phép thay đổi trực tiếp trạng thái vòng đời nhân sự qua API cập nhật thông tin. Vui lòng sử dụng các chức năng nghiệp vụ tương ứng (Nghỉ việc, Tái tuyển dụng/Tái kích hoạt, Xóa mềm hoặc Khôi phục).'
      });
    }

    // Ghi nhận diff thay đổi
    const newName = employee_name !== undefined ? employee_name.trim() : currentEmp.employee_name;
    const newDept = department !== undefined ? (department ? department.trim() : null) : currentEmp.department;
    const newPos = position !== undefined ? (position ? position.trim() : null) : currentEmp.position;
    const newEmail = email !== undefined ? (email ? email.trim() : null) : currentEmp.email;
    const newStatus = status !== undefined ? status.trim().toUpperCase() : currentEmp.status;

    const cleanCitizenId = citizen_id !== undefined ? (citizen_id ? String(citizen_id).replace(/\D/g, '') : null) : undefined;
    const newCitizenId = cleanCitizenId !== undefined ? cleanCitizenId : currentEmp.citizen_id;

    // Kiểm tra định dạng CCCD/CMND nếu có cập nhật
    if (cleanCitizenId !== undefined && cleanCitizenId !== null && cleanCitizenId !== '') {
      if (cleanCitizenId.length !== 9 && cleanCitizenId.length !== 12) {
        return res.status(400).json({
          success: false,
          error: 'Số CCCD/CMND không hợp lệ. Phải bao gồm đúng 9 hoặc 12 chữ số.'
        });
      }
    }

    client = await db.pool.connect();
    await client.query('BEGIN');

    if (cleanCitizenId !== undefined && cleanCitizenId !== currentEmp.citizen_id) {
      if (cleanCitizenId) {
        // Đồng bộ cơ chế khóa Advisory Lock xuyên kênh (P1)
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCitizenId]);

        // Kiểm tra tính duy nhất trên toàn hệ thống trong bảng employees (bất kể công ty nào)
        const cccdCheck = await client.query(
          `SELECT id, employee_code, employee_name, company_id FROM employees WHERE citizen_id = $1 AND id <> $2`,
          [cleanCitizenId, id]
        );
        if (cccdCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          const dEmp = cccdCheck.rows[0];
          return res.status(400).json({
            success: false,
            error: `Số CCCD/Định danh "${cleanCitizenId}" đã tồn tại cho nhân viên "${dEmp.employee_name}" (Mã: ${dEmp.employee_code}, Công ty: ${dEmp.company_id}).`
          });
        }

        // Kiểm tra tính duy nhất trên bảng hr_employee_profiles
        const profCheck = await client.query(
          `SELECT id, employee_id, full_name, company_id FROM hr_employee_profiles WHERE citizen_id = $1 AND (employee_id IS NULL OR employee_id <> $2)`,
          [cleanCitizenId, currentEmp.employee_code]
        );
        if (profCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          const pEmp = profCheck.rows[0];
          return res.status(400).json({
            success: false,
            error: `Số CCCD/Định danh "${cleanCitizenId}" đã tồn tại trong hồ sơ của "${pEmp.full_name}" (Công ty: ${pEmp.company_id || 'N/A'}).`
          });
        }
      }
      changes.citizen_id = { from: currentEmp.citizen_id, to: cleanCitizenId };
    }

    if (employee_name !== undefined && newName !== currentEmp.employee_name) {
      changes.employee_name = { from: currentEmp.employee_name, to: newName };
    }
    if (department !== undefined && newDept !== currentEmp.department) {
      changes.department = { from: currentEmp.department, to: newDept };
    }
    if (position !== undefined && newPos !== currentEmp.position) {
      changes.position = { from: currentEmp.position, to: newPos };
    }
    if (email !== undefined && newEmail !== currentEmp.email) {
      changes.email = { from: currentEmp.email, to: newEmail };
    }
    if (status !== undefined && newStatus !== currentEmp.status) {
      changes.status = { from: currentEmp.status, to: newStatus };
    }

    // Nếu chuyển trạng thái sang RESIGNED hoặc DELETED, tự động vô hiệu hóa tài khoản liên kết (nếu có)
    if (newStatus === 'RESIGNED' || newStatus === 'DELETED') {
      await client.query(`UPDATE users SET status = 'INACTIVE', updated_at = NOW() WHERE employee_id = $1`, [id]);
    }

    // Nếu điều chuyển công ty, đồng bộ hr_employee_profiles và users
    if (newCompanyId !== currentEmp.company_id) {
      await client.query(
        `UPDATE hr_employee_profiles 
         SET company_id = $1, updated_at = NOW() 
         WHERE (citizen_id IS NOT NULL AND citizen_id = $2) OR (employee_id IS NOT NULL AND employee_id = $3)`,
        [newCompanyId, newCitizenId, currentEmp.employee_code]
      );
      await client.query(`UPDATE users SET company_id = $1, updated_at = NOW() WHERE employee_id = $2`, [newCompanyId, id]);
    }

    const updateRes = await client.query(
      `UPDATE employees 
       SET employee_name = $1,
           department = $2,
           position = $3,
           email = $4,
           status = $5,
           citizen_id = $6,
           company_id = $7,
           updated_at = now()
       WHERE id = $8
       RETURNING *`,
      [newName, newDept, newPos, newEmail, newStatus, newCitizenId, newCompanyId, id]
    );

    // Cập nhật bảng hr_employee_profiles để đồng bộ dữ liệu tra cứu và số điện thoại / email
    const cleanPhone = phone_number !== undefined ? (phone_number ? String(phone_number).trim() : '') : undefined;
    if (cleanPhone !== undefined || email !== undefined || employee_name !== undefined || department !== undefined || position !== undefined) {
      await client.query(
        `UPDATE hr_employee_profiles
         SET phone_number = COALESCE($1, phone_number),
             email = COALESCE($2, email),
             full_name = COALESCE($3, full_name),
             department_staffing_plan = COALESCE($4, department_staffing_plan),
             job_title = COALESCE($5, job_title),
             updated_at = NOW()
         WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $6)
            OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $7)`,
        [
          cleanPhone !== undefined ? cleanPhone : null,
          email !== undefined ? newEmail : null,
          employee_name !== undefined ? newName : null,
          department !== undefined ? newDept : null,
          position !== undefined ? newPos : null,
          currentEmp.employee_code,
          newCitizenId
        ]
      );
      if (cleanPhone !== undefined) {
        changes.phone_number = { to: cleanPhone };
      }
    }

    await client.query('COMMIT');

    // Xếp hàng tác vụ đồng bộ sang NocoDB và Google Sheets
    let syncAction = 'UPDATE';
    if (newStatus === 'RESIGNED') syncAction = 'RESIGNED';
    else if (newStatus === 'DELETED') syncAction = 'SOFT_DELETE';
    else if (newCompanyId !== currentEmp.company_id) syncAction = 'TRANSFER';

    await queueEmployeeSync(id, syncAction, {
      employee_id: currentEmp.employee_code,
      employee_code: currentEmp.employee_code,
      full_name: newName,
      employee_name: newName,
      department: newDept,
      position: newPos,
      email: newEmail,
      phone_number: cleanPhone !== undefined ? cleanPhone : undefined,
      company_id: newCompanyId,
      citizen_id: newCitizenId,
      status: newStatus
    });

    if (Object.keys(changes).length > 0) {
      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'employee_updated',
        status: 'SUCCESS',
        ip_address: ip,
        metadata: {
          employee_id: id,
          employee_code: currentEmp.employee_code,
          changes
        }
      });
    }

    return res.json({
      success: true,
      message: 'Cập nhật hồ sơ nhân sự thành công.',
      employee: updateRes.rows[0],
      changes
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Update employee error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi cập nhật hồ sơ nhân sự: ' + err.message });
  } finally {
    if (client) client.release();
  }
});

/**
 * 5. DELETE /api/employees/:id - Xóa hồ sơ nhân sự
 * Phân quyền: CHỈ ADMIN toàn hệ thống.
 * Vai trò HR BỊ TỪ CHỐI (Không gộp quyền xóa vào quyền sửa/tạo).
 */
router.delete('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Kiểm tra vai trò riêng: HR bị chặn quyền xóa
  if (req.user.role === 'HR') {
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Vai trò Chuyên viên Nhân sự (HR) không có quyền xóa hồ sơ nhân sự. Vui lòng liên hệ Quản trị viên (ADMIN) để thực hiện.'
    });
  }

  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Chỉ Quản trị viên (ADMIN) mới có quyền xóa hồ sơ nhân sự.'
    });
  }

  try {
    const existingRes = await db.query(`SELECT * FROM employees WHERE id = $1`, [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự.' });
    }

    const currentEmp = existingRes.rows[0];

    // 1. Thực hiện XÓA MỀM (Soft delete)
    await db.query(`UPDATE employees SET status = 'DELETED', updated_at = NOW() WHERE id = $1`, [id]);
    await db.query(
      `UPDATE hr_employee_profiles 
       SET status = 'DELETED', job_grade = '[ĐÃ XÓA]', updated_at = NOW() 
       WHERE (employee_id = $1 AND employee_id <> '') OR (citizen_id IS NOT NULL AND citizen_id = $2)`,
      [currentEmp.employee_code, currentEmp.citizen_id]
    );

    // 2. Vô hiệu hóa tài khoản người dùng liên kết nếu có
    await db.query(`UPDATE users SET status = 'INACTIVE', updated_at = NOW() WHERE employee_id = $1`, [id]);

    // 3. Đồng bộ trạng thái xóa mềm sang NocoDB và Google Sheets
    await queueEmployeeSync(id, 'SOFT_DELETE', {
      employee_id: currentEmp.employee_code,
      employee_code: currentEmp.employee_code,
      full_name: currentEmp.employee_name,
      employee_name: currentEmp.employee_name,
      company_id: currentEmp.company_id,
      citizen_id: currentEmp.citizen_id,
      status: 'DELETED'
    });

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'employee_deleted',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: {
        employee_id: id,
        employee_code: currentEmp.employee_code,
        employee_name: currentEmp.employee_name,
        company_id: currentEmp.company_id,
        mode: 'soft_delete'
      }
    });

    return res.json({
      success: true,
      message: `Đã xóa mềm thành công hồ sơ nhân sự [${currentEmp.employee_code}] ${currentEmp.employee_name} (chuyển trạng thái DELETED, bảo toàn lịch sử và xếp hàng đồng bộ).`
    });
  } catch (err) {
    console.error('Delete employee error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi xóa hồ sơ nhân sự: ' + err.message });
  }
});

/**
 * 6. POST /api/employees/:id/restore - Khôi phục hồ sơ nhân sự đã xóa mềm
 * Phân quyền: ADMIN toàn hệ thống hoặc HR của đơn vị trực thuộc (Quy tắc Option A1).
 */
router.post('/:id/restore', verifyToken, async (req, res) => {
  const { id } = req.params;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  let client = null;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    const existingRes = await client.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [id]);
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự.' });
    }

    const currentEmp = existingRes.rows[0];

    // Kiểm tra phân quyền: Chỉ ADMIN/SUPER_ADMIN mới có quyền khôi phục hồ sơ đã xóa mềm
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      await client.query('ROLLBACK');
      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'employee_restore_rejected',
        status: 'FORBIDDEN',
        ip_address: ip,
        metadata: {
          employee_id: id,
          employee_code: currentEmp.employee_code,
          company_id: currentEmp.company_id,
          reason: '403 Forbidden: HR cannot restore soft-deleted profile. ADMIN only.'
        }
      });
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Vai trò Chuyên viên Nhân sự (HR) không có quyền khôi phục hồ sơ nhân sự đã bị xóa mềm. Thao tác này chỉ dành riêng cho Quản trị viên (ADMIN).'
      });
    }

    if (currentEmp.status !== 'DELETED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Hồ sơ [${currentEmp.employee_code}] ${currentEmp.employee_name} hiện đang ở trạng thái "${currentEmp.status}", không cần khôi phục.`
      });
    }

    // Kiểm tra xung đột số CCCD với nhân sự đang ACTIVE khác (Case 7)
    if (currentEmp.citizen_id) {
      const cleanCitizen = String(currentEmp.citizen_id).replace(/\D/g, '');
      if (cleanCitizen) {
        // Đồng bộ cơ chế khóa Advisory Lock xuyên kênh (P1)
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCitizen]);
      }
      const cccdConflict = await client.query(
        `SELECT employee_code, employee_name, company_id FROM employees 
         WHERE citizen_id = $1 AND status = 'ACTIVE' AND id <> $2 LIMIT 1`,
        [currentEmp.citizen_id, id]
      );
      if (cccdConflict.rows.length > 0) {
        await client.query('ROLLBACK');
        const cEmp = cccdConflict.rows[0];
        return res.status(409).json({
          success: false,
          error: `Không thể khôi phục: Số CCCD/Định danh của hồ sơ này đang được sử dụng bởi nhân sự đang hoạt động [${cEmp.employee_code}] ${cEmp.employee_name} (${cEmp.company_id}). Cần giải quyết trùng định danh trước khi khôi phục.`
        });
      }
    }

    // 1. Tái kích hoạt trong bảng employees (status = 'ACTIVE')
    await client.query(`UPDATE employees SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]);

    // 2. Tái kích hoạt tài khoản liên kết nếu có
    await client.query(`UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE employee_id = $1`, [id]);

    // 3. Tái kích hoạt trong bảng hr_employee_profiles (gỡ bỏ nhãn [ĐÃ XÓA])
    await client.query(
      `UPDATE hr_employee_profiles
       SET status = 'ACTIVE',
           job_grade = '',
           full_name = REPLACE(REPLACE(full_name, ' [ĐÃ XÓA]', ''), ' [NGHỈ VIỆC]', ''),
           updated_at = NOW()
       WHERE employee_id = $1 OR (citizen_id IS NOT NULL AND citizen_id = $2)`,
      [currentEmp.employee_code, currentEmp.citizen_id]
    );

    await client.query('COMMIT');

    // 4. Xếp hàng đồng bộ RESTORE sang NocoDB và Google Sheets
    await queueEmployeeSync(id, 'RESTORE', {
      employee_id: currentEmp.employee_code,
      employee_code: currentEmp.employee_code,
      full_name: currentEmp.employee_name,
      employee_name: currentEmp.employee_name,
      company_id: currentEmp.company_id,
      citizen_id: currentEmp.citizen_id,
      status: 'ACTIVE',
      action_type: 'RESTORE'
    });

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'employee_restored',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: {
        employee_id: id,
        employee_code: currentEmp.employee_code,
        employee_name: currentEmp.employee_name,
        company_id: currentEmp.company_id,
        mode: 'soft_delete_restore'
      }
    });

    return res.json({
      success: true,
      message: `Đã khôi phục thành công hồ sơ nhân sự [${currentEmp.employee_code}] ${currentEmp.employee_name} (chuyển trạng thái ACTIVE, giữ nguyên mã NV và đồng bộ 3 hệ thống).`,
      employee: {
        id: currentEmp.id,
        employee_code: currentEmp.employee_code,
        employee_name: currentEmp.employee_name,
        company_id: currentEmp.company_id,
        status: 'ACTIVE'
      }
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Restore employee error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi khôi phục hồ sơ nhân sự: ' + err.message });
  } finally {
    if (client) client.release();
  }
});

/**
 * 7. POST /api/employees/:id/resign - Đánh dấu nhân viên nghỉ việc (RESIGNED)
 * Phân quyền: ADMIN hoặc HR cùng công ty
 */
router.post('/:id/resign', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { resignation_date, resignation_reason } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const existingRes = await db.query(`SELECT * FROM employees WHERE id = $1`, [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự.' });
    }

    const currentEmp = existingRes.rows[0];

    // Kiểm tra phân quyền: ADMIN hoặc HR cùng đơn vị
    if (req.user.role === 'HR') {
      if (req.user.company_id && currentEmp.company_id && req.user.company_id.toUpperCase() !== currentEmp.company_id.toUpperCase()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: Bạn chỉ có quyền thao tác với nhân sự thuộc đơn vị ${req.user.company_id}.`
        });
      }
    } else if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Bạn không có quyền thực hiện nghiệp vụ này.'
      });
    }

    if (currentEmp.status === 'DELETED') {
      return res.status(400).json({
        success: false,
        error: `Hồ sơ [${currentEmp.employee_code}] ${currentEmp.employee_name} đã bị xóa mềm (DELETED), không thể đánh dấu nghỉ việc.`
      });
    }

    if (currentEmp.status === 'RESIGNED') {
      return res.status(400).json({
        success: false,
        error: `Nhân viên [${currentEmp.employee_code}] ${currentEmp.employee_name} hiện đã ở trạng thái nghỉ việc (RESIGNED).`
      });
    }

    const effectiveDate = resignation_date && String(resignation_date).trim() ? String(resignation_date).trim() : new Date().toISOString().split('T')[0];
    const effectiveReason = resignation_reason && String(resignation_reason).trim() ? String(resignation_reason).trim() : 'Chấm dứt hợp đồng lao động theo nguyện vọng';

    // 1. Cập nhật bảng employees: status = 'RESIGNED'
    await db.query(
      `UPDATE employees 
       SET status = 'RESIGNED', 
           resignation_date = $1, 
           resignation_reason = $2, 
           updated_at = NOW() 
       WHERE id = $3`,
      [effectiveDate, effectiveReason, id]
    );

    // 2. Vô hiệu hóa tài khoản Hub nếu có: status = 'INACTIVE'
    await db.query(
      `UPDATE users SET status = 'INACTIVE', updated_at = NOW() WHERE employee_id = $1`,
      [id]
    );

    // 3. Cập nhật bảng hr_employee_profiles: status = 'RESIGNED', job_grade = '[NGHỈ VIỆC]'
    await db.query(
      `UPDATE hr_employee_profiles
       SET status = 'RESIGNED',
           job_grade = '[NGHỈ VIỆC]',
           resignation_date = $1,
           resignation_reason = $2,
           contract_end_date = COALESCE($1, contract_end_date),
           updated_at = NOW()
       WHERE (employee_id = $3 AND employee_id <> '') OR (citizen_id IS NOT NULL AND citizen_id = $4)`,
      [effectiveDate, effectiveReason, currentEmp.employee_code, currentEmp.citizen_id]
    );

    // 4. Xếp hàng đồng bộ 3 hệ thống với action 'RESIGNED'
    await queueEmployeeSync(id, 'RESIGNED', {
      employee_id: currentEmp.employee_code,
      employee_code: currentEmp.employee_code,
      full_name: currentEmp.employee_name,
      employee_name: currentEmp.employee_name,
      company_id: currentEmp.company_id,
      citizen_id: currentEmp.citizen_id,
      status: 'RESIGNED',
      resignation_date: effectiveDate,
      resignation_reason: effectiveReason,
      action_type: 'RESIGNED'
    });

    // 5. Ghi nhật ký kiểm toán (Audit Trail)
    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'employee_resigned',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: {
        employee_id: id,
        employee_code: currentEmp.employee_code,
        employee_name: currentEmp.employee_name,
        company_id: currentEmp.company_id,
        resignation_date: effectiveDate,
        resignation_reason: effectiveReason
      }
    });

    return res.json({
      success: true,
      message: `Đã cập nhật trạng thái nghỉ việc thành công cho nhân viên [${currentEmp.employee_code}] ${currentEmp.employee_name}. Tài khoản đăng nhập đã được vô hiệu hóa an toàn.`,
      employee: {
        id: currentEmp.id,
        employee_code: currentEmp.employee_code,
        employee_name: currentEmp.employee_name,
        company_id: currentEmp.company_id,
        status: 'RESIGNED',
        resignation_date: effectiveDate,
        resignation_reason: effectiveReason
      }
    });
  } catch (err) {
    console.error('Resign employee error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi cập nhật trạng thái nghỉ việc: ' + err.message });
  }
});

/**
 * 8. POST /api/employees/:id/reactivate - Tái kích hoạt làm việc cho nhân sự đã nghỉ việc (Rehire / Reactivate)
 * Phân quyền: ADMIN hoặc HR cùng công ty
 */
router.post('/:id/reactivate', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { decision_no, rehire_reason, action_type } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  let client = null;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    const existingRes = await client.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [id]);
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự.' });
    }

    const currentEmp = existingRes.rows[0];

    // 1. Phân quyền và kiểm tra thẩm quyền nghiệp vụ
    if (req.user.role === 'HR') {
      if (req.user.company_id && currentEmp.company_id && req.user.company_id.toUpperCase() !== currentEmp.company_id.toUpperCase()) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: Bạn chỉ có quyền thao tác với nhân sự thuộc đơn vị ${req.user.company_id}.`
        });
      }

      // Kiểm tra xem nhân viên này có bị ADMIN đánh dấu nghỉ việc không
      const lastResignAudit = await client.query(
        `SELECT a.actor_user_id, a.actor_username, u.role AS actor_role
         FROM auth_audit_logs a
         LEFT JOIN users u ON a.actor_user_id = u.user_id
         WHERE a.action = 'employee_resigned' 
           AND a.status = 'SUCCESS'
           AND (a.metadata->>'employee_id' = $1 OR a.metadata->>'employee_code' = $2)
         ORDER BY a.created_at DESC LIMIT 1`,
        [id, currentEmp.employee_code]
      );

      if (lastResignAudit.rows.length > 0 && ['ADMIN', 'SUPER_ADMIN'].includes(lastResignAudit.rows[0].actor_role)) {
        await client.query('ROLLBACK');
        await logAudit({
          actor_user_id: req.user.user_id,
          actor_username: req.user.username,
          action: 'employee_reactivate_rejected',
          status: 'FORBIDDEN',
          ip_address: ip,
          metadata: {
            employee_id: id,
            employee_code: currentEmp.employee_code,
            company_id: currentEmp.company_id,
            reason: 'HR cannot override resignation decision made by ADMIN'
          }
        });
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Nhân sự này đã bị Quản trị viên (ADMIN) đánh dấu thôi việc/nghỉ việc. Chuyên viên Nhân sự (HR) không có thẩm quyền hủy quyết định quản trị của ADMIN.'
        });
      }

      // Kiểm tra quyền nghiệp vụ tái tuyển dụng: hr.profile.reactivate
      const canReactivate = await hasPermission(req.user.role, 'hr.profile.reactivate');
      if (!canReactivate) {
        await client.query('ROLLBACK');
        await logAudit({
          actor_user_id: req.user.user_id,
          actor_username: req.user.username,
          action: 'employee_reactivate_rejected',
          status: 'FORBIDDEN',
          ip_address: ip,
          metadata: {
            employee_id: id,
            employee_code: currentEmp.employee_code,
            company_id: currentEmp.company_id,
            reason: 'HR role does not have hr.profile.reactivate permission'
          }
        });
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Vai trò Chuyên viên Nhân sự (HR) chưa được cấp thẩm quyền tái kích hoạt hoặc tái tuyển dụng nhân sự đã thôi việc (hr.profile.reactivate). Vui lòng liên hệ Quản trị viên (ADMIN) để thực hiện.'
        });
      }

      // Nghiệp vụ tái tuyển dụng hợp lệ yêu cầu số quyết định và căn cứ/lý do
      if (!decision_no || !String(decision_no).trim() || !rehire_reason || !String(rehire_reason).trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Thao tác không hợp lệ: Nghiệp vụ tái tuyển dụng hoặc hủy quyết định nghỉ việc yêu cầu cung cấp Số quyết định tiếp nhận (decision_no) và Căn cứ/Lý do nghiệp vụ (rehire_reason).'
        });
      }
    } else if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Bạn không có quyền thực hiện nghiệp vụ này.'
      });
    }

    if (currentEmp.status === 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Nhân viên [${currentEmp.employee_code}] ${currentEmp.employee_name} hiện đang làm việc (ACTIVE), không cần tái kích hoạt.`
      });
    }

    if (currentEmp.status === 'DELETED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Hồ sơ [${currentEmp.employee_code}] ${currentEmp.employee_name} đang ở trạng thái xóa mềm (DELETED). Vui lòng sử dụng chức năng Khôi phục hồ sơ.`
      });
    }

    // Kiểm tra xung đột số CCCD với nhân sự đang ACTIVE khác (với Advisory Lock)
    if (currentEmp.citizen_id) {
      const cleanCitizen = String(currentEmp.citizen_id).replace(/\D/g, '');
      if (cleanCitizen) {
        // Đồng bộ cơ chế khóa Advisory Lock xuyên kênh (P1)
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCitizen]);
      }
      const cccdConflict = await client.query(
        `SELECT employee_code, employee_name, company_id FROM employees 
         WHERE citizen_id = $1 AND status = 'ACTIVE' AND id <> $2 LIMIT 1`,
        [currentEmp.citizen_id, id]
      );
      if (cccdConflict.rows.length > 0) {
        await client.query('ROLLBACK');
        const cEmp = cccdConflict.rows[0];
        return res.status(409).json({
          success: false,
          error: `Không thể tái kích hoạt: Số CCCD/Định danh của nhân sự này đang được sử dụng bởi nhân sự đang hoạt động [${cEmp.employee_code}] ${cEmp.employee_name} (${cEmp.company_id}).`
        });
      }
    }

    // 1. Tái kích hoạt trong bảng employees
    await client.query(
      `UPDATE employees 
       SET status = 'ACTIVE', 
           resignation_date = NULL, 
           resignation_reason = NULL, 
           updated_at = NOW() 
       WHERE id = $1`,
      [id]
    );

    // 2. Tái kích hoạt trong hr_employee_profiles: status = 'ACTIVE' (xóa nhãn [NGHỈ VIỆC] và [ĐÃ XÓA])
    await client.query(
      `UPDATE hr_employee_profiles
       SET status = 'ACTIVE',
           job_grade = '',
           resignation_date = NULL,
           resignation_reason = NULL,
           full_name = REPLACE(REPLACE(full_name, ' [ĐÃ XÓA]', ''), ' [NGHỈ VIỆC]', ''),
           updated_at = NOW()
       WHERE (employee_id = $1 AND employee_id <> '') OR (citizen_id IS NOT NULL AND citizen_id = $2)`,
      [currentEmp.employee_code, currentEmp.citizen_id]
    );

    await client.query('COMMIT');

    // 3. Xếp hàng đồng bộ RESTORE sang NocoDB và Google Sheets
    await queueEmployeeSync(id, 'RESTORE', {
      employee_id: currentEmp.employee_code,
      employee_code: currentEmp.employee_code,
      full_name: currentEmp.employee_name,
      employee_name: currentEmp.employee_name,
      company_id: currentEmp.company_id,
      citizen_id: currentEmp.citizen_id,
      status: 'ACTIVE',
      action_type: 'RESTORE'
    });

    const effectiveActionType = action_type || (decision_no ? 'REHIRE' : 'REACTIVATE');
    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'employee_reactivated',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: {
        employee_id: id,
        employee_code: currentEmp.employee_code,
        employee_name: currentEmp.employee_name,
        company_id: currentEmp.company_id,
        action_type: effectiveActionType,
        decision_no: decision_no || null,
        rehire_reason: rehire_reason || null,
        status_before: 'RESIGNED',
        status_after: 'ACTIVE'
      }
    });

    return res.json({
      success: true,
      message: `Đã tái kích hoạt làm việc thành công cho nhân sự [${currentEmp.employee_code}] ${currentEmp.employee_name} (chuyển trạng thái ACTIVE và đồng bộ 3 hệ thống).`,
      employee: {
        id: currentEmp.id,
        employee_code: currentEmp.employee_code,
        employee_name: currentEmp.employee_name,
        company_id: currentEmp.company_id,
        status: 'ACTIVE',
        action_type: effectiveActionType,
        decision_no: decision_no || null
      }
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Reactivate employee error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tái kích hoạt nhân sự: ' + err.message });
  } finally {
    if (client) client.release();
  }
});

/**
 * 8.1. POST /api/employees/:id/transfer - Điều chuyển nhân sự liên công ty (VTX -> STL, STL -> SWC, v.v.)
 * Quyền: ADMIN
 */
router.post('/:id/transfer', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const {
    target_company_id,
    target_department,
    target_position,
    transfer_date,
    transfer_reason,
    decision_no
  } = req.body || {};

  if (!target_company_id || !['STL', 'VTX', 'SWC'].includes(String(target_company_id).toUpperCase())) {
    return res.status(400).json({ success: false, error: 'Đơn vị tiếp nhận không hợp lệ (phải là STL, VTX hoặc SWC).' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lấy thông tin employment cũ
    const empRes = await client.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [id]);
    if (empRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ nhân sự cần điều chuyển.' });
    }
    const oldEmp = empRes.rows[0];

    if (oldEmp.status === 'TRANSFERRED' || oldEmp.status === 'DELETED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: `Hồ sơ đang ở trạng thái "${oldEmp.status}", không thể thực hiện điều chuyển.` });
    }

    const targetComp = String(target_company_id).toUpperCase();
    if (oldEmp.company_id.toUpperCase() === targetComp) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: `Đơn vị tiếp nhận (${targetComp}) trùng với đơn vị hiện tại (${oldEmp.company_id}). Vui lòng dùng chức năng chuyển phòng ban nội bộ.` });
    }

    // 2. Bảo đảm có Person liên kết
    let personId = oldEmp.person_id;
    if (!personId) {
      const pRes = await client.query(`
        INSERT INTO hr_persons (full_name, status, created_at, updated_at)
        VALUES ($1, 'ACTIVE', NOW(), NOW())
        RETURNING id;
      `, [oldEmp.employee_name]);
      personId = pRes.rows[0].id;
      await client.query(`UPDATE employees SET person_id = $1 WHERE id = $2`, [personId, oldEmp.id]);
    }

    const tDate = transfer_date || new Date().toISOString().split('T')[0];
    const tReason = transfer_reason || 'Điều chuyển nhân sự nội bộ tập đoàn';

    // 3. Cập nhật Employment cũ: status = 'TRANSFERRED' (CẤM ghi resignation_date!)
    await client.query(`
      UPDATE employees
      SET status = 'TRANSFERRED',
          transfer_date = $1,
          transfer_reason = $2,
          transfer_target_company = $3,
          updated_at = NOW()
      WHERE id = $4;
    `, [tDate, tReason, targetComp, oldEmp.id]);

    // 4. Sinh mã nhân viên mới cho đơn vị tiếp nhận qua Sequence chuẩn
    const seqMap = {
      'STL': 'seq_employee_code_stl',
      'SWC': 'seq_employee_code_swc',
      'VTX': 'seq_employee_code_vtx'
    };
    const seqRes = await client.query(`SELECT nextval($1) AS num`, [seqMap[targetComp]]);
    const newNum = seqRes.rows[0].num;
    const newCode = `${targetComp}${String(newNum).padStart(5, '0')}`;

    // 5. Tạo Employment mới tại công ty tiếp nhận (cùng person_id)
    const newEmpId = crypto.randomUUID();
    await client.query(`
      INSERT INTO employees (
        id, person_id, employee_code, employee_name, company_id, department, position, email, status, citizen_id, employment_start_date, transfer_source_company, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, $10, $11, NOW(), NOW()
      );
    `, [
      newEmpId,
      personId,
      newCode,
      oldEmp.employee_name,
      targetComp,
      target_department || oldEmp.department,
      target_position || oldEmp.position,
      oldEmp.email,
      oldEmp.citizen_id,
      tDate,
      oldEmp.company_id
    ]);

    // 6. Sao chép hoặc tạo hr_employee_profiles cho Employment mới
    const oldProfRes = await client.query(`SELECT * FROM hr_employee_profiles WHERE employee_id = $1 LIMIT 1`, [oldEmp.employee_code]);
    if (oldProfRes.rows.length > 0) {
      const op = oldProfRes.rows[0];
      await client.query(`
        INSERT INTO hr_employee_profiles (
          employment_id, job_grade, employee_id, full_name, date_of_birth, gender,
          job_title, professional_title, department_staffing_plan, section_staffing_plan,
          citizen_id, citizen_id_issue_date, citizen_id_issue_place, birth_registration_place,
          place_of_origin, permanent_address, temporary_address, current_address,
          ethnicity, education_level, education_code, qualification,
          professional_qualification, specialization, degree_qualification,
          training_institution, major, training_mode, training_period,
          graduation_grade, degree_valid_until, other_professional_certificates,
          social_insurance_salary, total_income, base_salary,
          productivity_responsibility_pay, attendance_bonus, responsibility_allowance,
          vessel_size_allowance, professional_allowance_t1, meal_allowance, other_allowances,
          open_ended_contract, fixed_term_contract, seasonal_contract,
          contract_start_date, contract_end_date, recruitment_decision_no,
          employment_start_date, official_labor_contract_sign_date, phone_number,
          email, create_time, file_name, company_id, version, created_at, updated_at
        ) VALUES (
          $1, '', $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24,
          $25, $26, $27, $28,
          $29, $30, $31,
          $32, $33, $34,
          $35, $36, $37,
          $38, $39, $40, $41,
          $42, $43, $44,
          $45, $46, $47,
          $48, $49, $50,
          $51, $52, $53, $54, 1, NOW(), NOW()
        );
      `, [
        newEmpId,
        newCode,
        op.full_name,
        op.date_of_birth,
        op.gender,
        target_position || op.job_title,
        op.professional_title,
        target_department || op.department_staffing_plan,
        op.section_staffing_plan,
        op.citizen_id,
        op.citizen_id_issue_date,
        op.citizen_id_issue_place,
        op.birth_registration_place,
        op.place_of_origin,
        op.permanent_address,
        op.temporary_address,
        op.current_address,
        op.ethnicity,
        op.education_level,
        op.education_code,
        op.qualification,
        op.professional_qualification,
        op.specialization,
        op.degree_qualification,
        op.training_institution,
        op.major,
        op.training_mode,
        op.training_period,
        op.graduation_grade,
        op.degree_valid_until,
        op.other_professional_certificates,
        op.social_insurance_salary,
        op.total_income,
        op.base_salary,
        op.productivity_responsibility_pay,
        op.attendance_bonus,
        op.responsibility_allowance,
        op.vessel_size_allowance,
        op.professional_allowance_t1,
        op.meal_allowance,
        op.other_allowances,
        op.open_ended_contract,
        op.fixed_term_contract,
        op.seasonal_contract,
        tDate,
        op.contract_end_date,
        decision_no || op.recruitment_decision_no,
        tDate,
        op.official_labor_contract_sign_date,
        op.phone_number,
        op.email,
        new Date().toISOString(),
        op.file_name,
        targetComp
      ]);
    }

    // 7. Ghi nhận lịch sử điều chuyển (TRANSFER_OUT & TRANSFER_IN)
    await client.query(`
      INSERT INTO hr_employment_history (
        employment_id, person_id, event_type, from_company_id, to_company_id, from_department, to_department, from_position, to_position, from_status, to_status, event_date, decision_no, notes, actor_username, created_at
      ) VALUES (
        $1, $2, 'TRANSFER_OUT', $3, $4, $5, $6, $7, $8, 'ACTIVE', 'TRANSFERRED', $9, $10, $11, $12, NOW()
      );
    `, [
      oldEmp.id,
      personId,
      oldEmp.company_id,
      targetComp,
      oldEmp.department,
      target_department || oldEmp.department,
      oldEmp.position,
      target_position || oldEmp.position,
      tDate,
      decision_no || '',
      tReason,
      req.user.username
    ]);

    await client.query(`
      INSERT INTO hr_employment_history (
        employment_id, person_id, event_type, from_company_id, to_company_id, from_department, to_department, from_position, to_position, from_status, to_status, event_date, decision_no, notes, actor_username, created_at
      ) VALUES (
        $1, $2, 'TRANSFER_IN', $3, $4, $5, $6, $7, $8, 'TRANSFERRED', 'ACTIVE', $9, $10, $11, $12, NOW()
      );
    `, [
      newEmpId,
      personId,
      oldEmp.company_id,
      targetComp,
      oldEmp.department,
      target_department || oldEmp.department,
      oldEmp.position,
      target_position || oldEmp.position,
      tDate,
      decision_no || '',
      tReason,
      req.user.username
    ]);

    // 8. Bảo toàn tài khoản người dùng: Cập nhật users.employee_id và users.company_id
    const userCheck = await client.query(`SELECT user_id, username FROM users WHERE employee_id = $1`, [oldEmp.id]);
    let linkedUserId = null;
    if (userCheck.rows.length > 0) {
      linkedUserId = userCheck.rows[0].user_id;
      await client.query(`
        UPDATE users
        SET employee_id = $1,
            company_id = $2,
            updated_at = NOW()
        WHERE user_id = $3;
      `, [newEmpId, targetComp, linkedUserId]);
    }

    // 9. Ghi Outbox Task
    await queueEmployeeSync(newEmpId, 'TRANSFER', {
      employee_id: newCode,
      employee_code: newCode,
      full_name: oldEmp.employee_name,
      company_id: targetComp,
      old_company_id: oldEmp.company_id,
      old_employee_code: oldEmp.employee_code,
      action_type: 'TRANSFER'
    }, client);

    await client.query('COMMIT');

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_EMPLOYEE_TRANSFERRED',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        person_id: personId,
        old_employment_id: oldEmp.id,
        new_employment_id: newEmpId,
        old_code: oldEmp.employee_code,
        new_code: newCode,
        from_company: oldEmp.company_id,
        to_company: targetComp,
        linked_user_id: linkedUserId
      }
    });

    return res.json({
      success: true,
      message: `🎉 Điều chuyển nhân sự thành công! Mã nhân viên mới tại ${targetComp}: ${newCode}`,
      old_employment_id: oldEmp.id,
      new_employment_id: newEmpId,
      new_employee_code: newCode,
      new_employee: {
        id: newEmpId,
        employee_code: newCode,
        company_id: targetComp
      },
      from_company: oldEmp.company_id,
      to_company: targetComp,
      linked_user_updated: !!linkedUserId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi transfer employee:', err);
    return res.status(500).json({ success: false, error: 'Lỗi điều chuyển: ' + err.message });
  } finally {
    client.release();
  }
});

/**
 * 9. POST /api/employees/restore-batch - Khôi phục hàng loạt hồ sơ nhân sự đã xóa mềm
 * Phân quyền: Chỉ ADMIN/SUPER_ADMIN mới có quyền thực hiện khôi phục hàng loạt
 */
router.post('/restore-batch', verifyToken, async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { employee_ids, employee_codes, targets, scope } = req.body || {};

  if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'employee_batch_restore_rejected',
      status: 'FORBIDDEN',
      ip_address: ip,
      metadata: { reason: 'HR cannot batch restore soft-deleted profiles. ADMIN only.' }
    });
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Vai trò Chuyên viên Nhân sự (HR) không có quyền khôi phục hàng loạt hồ sơ đã xóa mềm. Thao tác này chỉ dành riêng cho Quản trị viên (ADMIN).'
    });
  }

  try {
    const result = await executeRestore(req.user, {
      employee_ids,
      employee_codes,
      targets,
      scope: scope || (employee_ids && employee_ids.length > 0 ? 'targeted' : 'all_deleted'),
      ipAddress: ip
    });
    return res.json(result);
  } catch (err) {
    console.error('Batch restore error:', err);
    return res.status(err.status || 500).json({ success: false, error: 'Lỗi khôi phục hàng loạt: ' + err.message });
  }
});

module.exports = router;
