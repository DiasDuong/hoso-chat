/**
 * SOTRANS HUB — ANALYTICS ENGINE (PHASE 1.1 DATA FOUNDATION)
 * 
 * Independent Reporting Engine for Business Intelligence
 * - 17 Standardized KPIs (11 READY, 3 CONDITIONAL, 3 BLOCKED)
 * - Strict Tenant Isolation (ADMIN whitelist, HR context enforcement)
 * - Read-Only Transaction Lifecycle (BEGIN READ ONLY, timeout 3000ms, Asia/Ho_Chi_Minh)
 * - Fully Parameterized SQL Constants (Zero Dynamic Concatenation, Zero User SQL)
 * - Standardized JSON Response Contract
 */

const db = require('../db');

// ============================================================================
// CONSTANTS & CATALOG
// ============================================================================

const TIMEZONE = 'Asia/Ho_Chi_Minh';
const STATEMENT_TIMEOUT = '3000ms';

const BRANCH_MAP = Object.freeze({
  STL: 'sotrans_logistics',
  VTX: 'vietranstimex',
  SWC: 'sowatco',
});

const ALLOWED_ADMIN_COMPANIES = Object.freeze(['STL', 'VTX', 'SWC', 'ALL']);
const VALID_COMPANIES = Object.freeze(['STL', 'VTX', 'SWC']);

const KPI_CATALOG = Object.freeze({
  DOC_TOTAL: {
    code: 'DOC_TOTAL',
    name: 'Tổng số Văn bản Quy định',
    classification: 'READY',
    source_tables: ['public.documents'],
    date_type: 'NONE',
  },
  DOC_BY_EFFECTIVE_DATE: {
    code: 'DOC_BY_EFFECTIVE_DATE',
    name: 'Văn bản Quy định Theo Ngày Hiệu lực',
    classification: 'READY',
    source_tables: ['public.documents'],
    date_type: 'DATE',
  },
  DOC_BY_TYPE: {
    code: 'DOC_BY_TYPE',
    name: 'Cơ cấu Loại hình & Chuyên mục Văn bản',
    classification: 'READY',
    source_tables: ['public.documents'],
    date_type: 'NONE',
  },
  DOC_STATUS: {
    code: 'DOC_STATUS',
    name: 'Cơ cấu Trạng thái Vòng đời Văn bản',
    classification: 'READY',
    source_tables: ['public.documents'],
    date_type: 'NONE',
  },
  INTAKE_UPLOADS: {
    code: 'INTAKE_UPLOADS',
    name: 'Tổng số Lô & Tệp Tiếp nhận Hồ sơ',
    classification: 'READY',
    source_tables: ['public.hr_intake_batches'],
    date_type: 'TIMESTAMPTZ',
  },
  INTAKE_BY_USER: {
    code: 'INTAKE_BY_USER',
    name: 'Khối lượng Tiếp nhận Theo Cán bộ HR',
    classification: 'READY',
    source_tables: ['public.hr_intake_batches'],
    date_type: 'TIMESTAMPTZ',
  },
  INTAKE_TRENDS: {
    code: 'INTAKE_TRENDS',
    name: 'Xu hướng Tiếp nhận Hồ sơ Theo Chu kỳ',
    classification: 'READY',
    source_tables: ['public.hr_intake_batches'],
    date_type: 'TIMESTAMPTZ',
  },
  INTAKE_SUCCESS: {
    code: 'INTAKE_SUCCESS',
    name: 'Phân bổ Trạng thái Lô & Tỷ lệ Chuyển đổi Staging',
    classification: 'CONDITIONAL',
    source_tables: ['public.hr_intake_batches', 'public.hr_employee_staging'],
    date_type: 'TIMESTAMPTZ',
  },
  INTAKE_FAILURE: {
    code: 'INTAKE_FAILURE',
    name: 'Tỷ lệ Tiếp nhận & Trích xuất Thất bại',
    classification: 'BLOCKED',
    source_tables: ['public.hr_intake_batches'],
    date_type: 'TIMESTAMPTZ',
    blocked_reason: 'Pipeline chưa ghi nhận đầy đủ lỗi Gateway/Middleware vào database.',
  },
  INTAKE_DURATION: {
    code: 'INTAKE_DURATION',
    name: 'Thời gian Xử lý Hồ sơ Trung bình',
    classification: 'BLOCKED',
    source_tables: ['public.hr_intake_batches'],
    date_type: 'TIMESTAMPTZ',
    blocked_reason: '100 batch gần nhất có created_at = updated_at và completed_at chưa được cập nhật.',
  },
  DUPLICATE_RATE: {
    code: 'DUPLICATE_RATE',
    name: 'Tỷ lệ Hồ sơ Nghi ngờ Trùng lặp CCCD',
    classification: 'READY',
    source_tables: ['public.hr_employee_staging'],
    date_type: 'TIMESTAMPTZ',
  },
  POLICY_CONFLICT: {
    code: 'POLICY_CONFLICT',
    name: 'Tình trạng Xung đột Văn bản Quy định',
    classification: 'BLOCKED',
    source_tables: ['public.document_relationships'],
    date_type: 'NONE',
    blocked_reason: 'Detected Policy Conflicts được tính động trong policyConflictDetector.js, chưa lưu thành dữ liệu truy vấn tĩnh trong PostgreSQL.',
  },
  APPROVAL_QUEUE: {
    code: 'APPROVAL_QUEUE',
    name: 'Tồn đọng Phê duyệt & Hoạt động Duyệt/Từ chối',
    classification: 'READY',
    source_tables: ['public.hr_employee_staging'],
    date_type: 'TIMESTAMPTZ',
  },
  OCR_QUALITY: {
    code: 'OCR_QUALITY',
    name: 'Điểm Chất lượng Số hóa Văn bản',
    classification: 'CONDITIONAL',
    source_tables: ['public.documents'],
    date_type: 'NONE',
  },
  DATA_INTEGRITY: {
    code: 'DATA_INTEGRITY',
    name: 'Hồ sơ Thiếu hoặc Không chắc chắn',
    classification: 'READY',
    source_tables: ['public.hr_employee_staging'],
    date_type: 'TIMESTAMPTZ',
  },
  ACTIVE_USERS: {
    code: 'ACTIVE_USERS',
    name: 'Tài khoản Hoạt động & Tần suất Phiên',
    classification: 'READY',
    source_tables: ['public.auth_audit_logs', 'public.users'],
    date_type: 'TIMESTAMPTZ',
  },
  RAG_ANSWERABLE: {
    code: 'RAG_ANSWERABLE',
    name: 'Tỷ lệ Đáp ứng của RAG Quy định',
    classification: 'CONDITIONAL',
    source_tables: ['public.chat_log'],
    date_type: 'TIMESTAMPTZ',
  },
});

// ============================================================================
// CUSTOM ERROR CLASS
// ============================================================================

class AnalyticsError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AnalyticsError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ============================================================================
// FIXED PARAMETERIZED SQL CONSTANTS
// ============================================================================

const SQL_QUERIES = Object.freeze({
  // KPI 1: DOC_TOTAL
  DOC_TOTAL: `
    SELECT 
      COUNT(DISTINCT doc_version_id) AS total_documents,
      COUNT(DISTINCT doc_version_id) FILTER (
        WHERE status = 'active' 
          AND effective_date <= CURRENT_DATE 
          AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
      ) AS active_count
    FROM public.documents 
    WHERE deleted_at IS NULL 
      AND ($1 = 'ALL' OR branch_scope @> '{all}' OR branch_scope @> ARRAY[$2]::text[])
  `,

  // KPI 2: DOC_BY_EFFECTIVE_DATE
  DOC_BY_EFFECTIVE_DATE: `
    SELECT 
      TO_CHAR(DATE_TRUNC('month', effective_date), 'YYYY-MM') AS period,
      COUNT(DISTINCT doc_version_id) AS doc_count
    FROM public.documents 
    WHERE deleted_at IS NULL 
      AND ($1::date IS NULL OR (effective_date >= $1::date AND effective_date < $2::date))
      AND ($3 = 'ALL' OR branch_scope @> '{all}' OR branch_scope @> ARRAY[$4]::text[])
    GROUP BY 1 
    ORDER BY 1 ASC
  `,

  // KPI 3: DOC_BY_TYPE
  DOC_BY_TYPE: `
    SELECT 
      COALESCE(doc_type, 'Chưa xác định') AS doc_type,
      COALESCE(category, 'Chung') AS category,
      COUNT(DISTINCT doc_version_id) AS doc_count
    FROM public.documents 
    WHERE deleted_at IS NULL 
      AND ($1 = 'ALL' OR branch_scope @> '{all}' OR branch_scope @> ARRAY[$2]::text[])
    GROUP BY 1, 2 
    ORDER BY 3 DESC
  `,

  // KPI 4: DOC_STATUS
  DOC_STATUS: `
    SELECT 
      status::text AS document_status,
      COUNT(DISTINCT doc_version_id) AS total_count,
      ROUND(COUNT(DISTINCT doc_version_id) * 100.0 / NULLIF(SUM(COUNT(DISTINCT doc_version_id)) OVER(), 0), 2) AS ratio_percent
    FROM public.documents 
    WHERE deleted_at IS NULL 
      AND ($1 = 'ALL' OR branch_scope @> '{all}' OR branch_scope @> ARRAY[$2]::text[])
    GROUP BY status 
    ORDER BY total_count DESC
  `,

  // KPI 5: INTAKE_UPLOADS
  INTAKE_UPLOADS: `
    SELECT 
      COUNT(id) AS total_batches,
      COALESCE(SUM(total_files), 0) AS total_files_uploaded,
      ROUND(AVG(total_files), 1) AS avg_files_per_batch
    FROM public.hr_intake_batches 
    WHERE ($1 = 'ALL' OR company_id = $1)
      AND ($2::timestamptz IS NULL OR (created_at >= $2::timestamptz AND created_at < $3::timestamptz))
  `,

  // KPI 6: INTAKE_BY_USER
  INTAKE_BY_USER: `
    SELECT 
      COALESCE(uploaded_by, 'Hệ thống') AS username,
      company_id,
      COUNT(id) AS total_batches,
      COALESCE(SUM(total_files), 0) AS total_files
    FROM public.hr_intake_batches 
    WHERE ($1 = 'ALL' OR company_id = $1)
      AND ($2::timestamptz IS NULL OR (created_at >= $2::timestamptz AND created_at < $3::timestamptz))
    GROUP BY uploaded_by, company_id 
    ORDER BY total_files DESC
  `,

  // KPI 7: INTAKE_TRENDS
  INTAKE_TRENDS: `
    SELECT 
      TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS period,
      COUNT(id) AS batch_count,
      COALESCE(SUM(total_files), 0) AS files_count
    FROM public.hr_intake_batches 
    WHERE ($1 = 'ALL' OR company_id = $1)
      AND ($2::timestamptz IS NULL OR (created_at >= $2::timestamptz AND created_at < $3::timestamptz))
    GROUP BY 1 
    ORDER BY 1 ASC
  `,

  // KPI 8: INTAKE_SUCCESS (CTE prevents batch inflation)
  INTAKE_SUCCESS: `
    WITH batch_scope AS (
      SELECT b.id, b.status, b.company_id
      FROM public.hr_intake_batches b
      WHERE ($1 = 'ALL' OR b.company_id = $1)
        AND ($2::timestamptz IS NULL OR (b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz))
    ),
    staging_agg AS (
      SELECT 
        s.batch_id,
        COUNT(s.id) AS total_records,
        COUNT(s.id) FILTER (WHERE s.company_id = b.company_id) AS same_company_records,
        COUNT(s.id) FILTER (WHERE s.company_id <> b.company_id) AS cross_company_records
      FROM public.hr_employee_staging s
      JOIN batch_scope b ON s.batch_id = b.id
      GROUP BY s.batch_id
    )
    SELECT
      COUNT(b.id) AS total_batches,
      COUNT(b.id) FILTER (WHERE b.status = 'completed') AS completed_batches,
      COUNT(b.id) FILTER (WHERE b.status = 'ocr_completed') AS ocr_completed_batches,
      COUNT(b.id) FILTER (WHERE sa.batch_id IS NOT NULL) AS converted_batches_all_status,
      ROUND(COUNT(b.id) FILTER (WHERE sa.batch_id IS NOT NULL) * 100.0 / NULLIF(COUNT(b.id), 0), 2) AS conversion_rate_all_status,
      COUNT(b.id) FILTER (WHERE b.status = 'completed' AND sa.batch_id IS NOT NULL) AS converted_completed_batches,
      ROUND(COUNT(b.id) FILTER (WHERE b.status = 'completed' AND sa.batch_id IS NOT NULL) * 100.0 / NULLIF(COUNT(b.id) FILTER (WHERE b.status = 'completed'), 0), 2) AS conversion_rate_completed_only,
      COUNT(b.id) FILTER (WHERE sa.same_company_records > 0) AS same_company_converted_batches,
      COUNT(b.id) FILTER (WHERE sa.cross_company_records > 0) AS cross_company_converted_batches,
      COALESCE(SUM(sa.same_company_records), 0) AS same_company_staging_records,
      COALESCE(SUM(sa.cross_company_records), 0) AS cross_company_staging_records
    FROM batch_scope b
    LEFT JOIN staging_agg sa ON b.id = sa.batch_id
  `,

  // KPI 11: DUPLICATE_RATE
  DUPLICATE_RATE: `
    SELECT 
      COUNT(id) AS total_staged,
      COUNT(id) FILTER (WHERE suspected_duplicate = true) AS suspected_cnt,
      ROUND(COUNT(id) FILTER (WHERE suspected_duplicate = true) * 100.0 / NULLIF(COUNT(id), 0), 2) AS suspected_duplicate_rate,
      COUNT(id) FILTER (WHERE suspected_duplicate = true AND staging_status = 'approved') AS approved_duplicate_cnt
    FROM public.hr_employee_staging 
    WHERE ($1 = 'ALL' OR company_id = $1)
      AND ($2::timestamptz IS NULL OR (created_at >= $2::timestamptz AND created_at < $3::timestamptz))
  `,

  // KPI 13: APPROVAL_QUEUE (Split 3 perspectives)
  APPROVAL_QUEUE: `
    SELECT
      (SELECT COUNT(id) FROM public.hr_employee_staging WHERE ($1 = 'ALL' OR company_id = $1) AND staging_status = 'pending_review') AS current_pending_queue,
      (SELECT COUNT(id) FROM public.hr_employee_staging WHERE ($1 = 'ALL' OR company_id = $1) AND staging_status = 'approved' AND ($2::timestamptz IS NULL OR (approved_at >= $2::timestamptz AND approved_at < $3::timestamptz))) AS approval_activity,
      (SELECT COUNT(id) FROM public.hr_employee_staging WHERE ($1 = 'ALL' OR company_id = $1) AND staging_status = 'rejected' AND ($2::timestamptz IS NULL OR (reviewed_at >= $2::timestamptz AND reviewed_at < $3::timestamptz))) AS rejection_activity
  `,

  // KPI 14: OCR_QUALITY
  OCR_QUALITY: `
    SELECT 
      COUNT(doc_version_id) AS total_docs,
      COUNT(doc_version_id) FILTER (WHERE parse_quality IS NOT NULL) AS measured_docs,
      COUNT(doc_version_id) FILTER (WHERE parse_quality IS NULL) AS missing_docs,
      ROUND(AVG(parse_quality)::numeric * 100, 2) AS avg_doc_parse_quality
    FROM public.documents 
    WHERE deleted_at IS NULL 
      AND ($1 = 'ALL' OR branch_scope @> '{all}' OR branch_scope @> ARRAY[$2]::text[])
  `,

  // KPI 15: DATA_INTEGRITY
  DATA_INTEGRITY: `
    SELECT 
      COUNT(id) AS total_profiles,
      COUNT(id) FILTER (WHERE cardinality(missing_fields) > 0) AS missing_fields_count,
      COUNT(id) FILTER (WHERE cardinality(uncertain_fields) > 0) AS uncertain_fields_count,
      ROUND(COUNT(id) FILTER (WHERE cardinality(missing_fields) > 0) * 100.0 / NULLIF(COUNT(id), 0), 2) AS missing_fields_rate
    FROM public.hr_employee_staging 
    WHERE ($1 = 'ALL' OR company_id = $1)
      AND ($2::timestamptz IS NULL OR (created_at >= $2::timestamptz AND created_at < $3::timestamptz))
  `,

  // KPI 16: ACTIVE_USERS
  ACTIVE_USERS: `
    SELECT 
      COUNT(DISTINCT a.actor_user_id) AS active_users,
      COUNT(a.id) AS total_actions,
      u.role,
      u.company_id
    FROM public.auth_audit_logs a 
    JOIN public.users u ON a.actor_user_id = u.user_id 
    WHERE u.status = 'ACTIVE' 
      AND UPPER(a.action) IN ('LOGIN_SUCCESS', 'TOKEN_REFRESH')
      AND ($1::timestamptz IS NULL OR (a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz))
      AND ($3 = 'ALL' OR u.company_id = $3)
    GROUP BY u.role, u.company_id
    ORDER BY active_users DESC
  `,

  // KPI 17: RAG_ANSWERABLE
  RAG_ANSWERABLE: `
    SELECT 
      COUNT(id) AS eligible_rag_queries,
      COUNT(id) FILTER (WHERE answerable = true) AS answerable_count,
      COUNT(id) FILTER (WHERE best_sim IS NOT NULL) AS similarity_sample_count,
      ROUND(COUNT(id) FILTER (WHERE answerable = true) * 100.0 / NULLIF(COUNT(id), 0), 2) AS answerability_rate,
      ROUND(AVG(best_sim)::numeric, 4) AS avg_vector_similarity
    FROM public.chat_log 
    WHERE answerable IS NOT NULL 
      AND ($1 = 'ALL' OR company_id = $1)
      AND ($2::timestamptz IS NULL OR (at >= $2::timestamptz AND at < $3::timestamptz))
  `,
});

// ============================================================================
// VALUE NORMALIZATION UTILITIES (POSTGRES STRINGS -> NUMBERS/NULLS)
// ============================================================================

function normalizeValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      return Number.isSafeInteger(num) ? num : trimmed;
    }
    if (/^-?\d+\.\d+$/.test(trimmed)) {
      const num = parseFloat(trimmed);
      return Number.isNaN(num) ? trimmed : num;
    }
    return trimmed;
  }
  return val;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const normalized = {};
  for (const [key, val] of Object.entries(row)) {
    normalized[key] = normalizeValue(val);
  }
  return normalized;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeRow);
}

// ============================================================================
// TENANT RESOLUTION & SECURITY GUARD
// ============================================================================

function resolveTenantScope(userContext, options = {}) {
  if (!userContext || typeof userContext !== 'object' || !userContext.role) {
    throw new AnalyticsError('Chưa xác thực người dùng.', 401, 'UNAUTHORIZED');
  }

  const role = String(userContext.role).trim().toUpperCase();

  // Check account active status if present in context
  if (userContext.status && ['INACTIVE', 'LOCKED'].includes(String(userContext.status).trim().toUpperCase())) {
    throw new AnalyticsError('403 Forbidden: Tài khoản của bạn đã bị vô hiệu hóa hoặc bị khóa.', 403, 'ACCOUNT_INACTIVE');
  }

  if (role !== 'ADMIN' && role !== 'HR') {
    throw new AnalyticsError(`403 Forbidden: Vai trò ${userContext.role} không có quyền truy cập dữ liệu Analytics Engine.`, 403, 'FORBIDDEN_ROLE');
  }

  let effectiveCompanyId = null;

  if (role === 'ADMIN') {
    const rawCompanyId = options.companyId;
    if (rawCompanyId === undefined || rawCompanyId === null || String(rawCompanyId).trim() === '') {
      throw new AnalyticsError('Thiếu tham số options.companyId bắt buộc cho quyền ADMIN (phải thuộc STL, VTX, SWC hoặc ALL).', 400, 'MISSING_ADMIN_TENANT');
    }

    const normalizedCompanyId = String(rawCompanyId).trim().toUpperCase();
    if (!ALLOWED_ADMIN_COMPANIES.includes(normalizedCompanyId)) {
      // Trigger non-blocking audit logging for tampering
      try {
        const audit = require('../audit');
        if (audit && typeof audit.logAudit === 'function') {
          audit.logAudit({
            actor_user_id: userContext.user_id,
            actor_username: userContext.username,
            action: 'SECURITY_TENANT_TAMPERING',
            status: 'BLOCKED',
            metadata: {
              attempted_company_id: String(rawCompanyId).slice(0, 50),
              role: userContext.role,
            },
          });
        }
      } catch (_) {}

      throw new AnalyticsError(`options.companyId không hợp lệ: "${rawCompanyId}". Giá trị hợp lệ: STL, VTX, SWC, ALL.`, 400, 'INVALID_ADMIN_TENANT');
    }

    effectiveCompanyId = normalizedCompanyId;
  } else if (role === 'HR') {
    // HR tenant is STRICTLY forced from userContext.company_id; options.companyId is completely ignored
    if (!userContext.company_id) {
      throw new AnalyticsError('403 Forbidden: Tài khoản HR chưa được gán company_id hợp lệ.', 403, 'MISSING_HR_TENANT');
    }

    const hrCompany = String(userContext.company_id).trim().toUpperCase();
    if (!VALID_COMPANIES.includes(hrCompany)) {
      throw new AnalyticsError(`403 Forbidden: Đơn vị "${userContext.company_id}" của tài khoản HR không hợp lệ.`, 403, 'INVALID_HR_TENANT');
    }

    effectiveCompanyId = hrCompany;
  }

  const effectiveBranch = effectiveCompanyId === 'ALL' ? 'all' : (BRANCH_MAP[effectiveCompanyId] || null);

  return {
    effectiveCompanyId,
    effectiveBranch,
    role,
  };
}

// ============================================================================
// DATE RANGE PARSER & VALIDATOR
// ============================================================================

function parseDateRange(options = {}) {
  const { startDate, endDate } = options;

  if (!startDate && !endDate) {
    return {
      hasDateRange: false,
      startDate: null,
      endDate: null,
      endExclusiveDate: null,
      dateStart: null,
      dateEndExclusive: null,
      startTimestamptz: null,
      endExclusiveTimestamptz: null,
    };
  }

  if (!startDate || !endDate) {
    throw new AnalyticsError('Yêu cầu cung cấp cả startDate và endDate (hoặc không truyền cả hai).', 400, 'INCOMPLETE_DATE_RANGE');
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(String(startDate).trim()) || !dateRegex.test(String(endDate).trim())) {
    throw new AnalyticsError('Định dạng ngày phải là YYYY-MM-DD.', 400, 'INVALID_DATE_FORMAT');
  }

  const sDate = String(startDate).trim();
  const eDate = String(endDate).trim();

  const dStart = new Date(`${sDate}T00:00:00Z`);
  const dEnd = new Date(`${eDate}T00:00:00Z`);

  if (Number.isNaN(dStart.getTime()) || Number.isNaN(dEnd.getTime())) {
    throw new AnalyticsError('Giá trị ngày không hợp lệ trên lịch.', 400, 'INVALID_DATE_VALUE');
  }

  if (sDate > eDate) {
    throw new AnalyticsError(`startDate (${sDate}) không được lớn hơn endDate (${eDate}).`, 400, 'INVALID_DATE_ORDER');
  }

  // Calculate endExclusiveDate = endDate + 1 day
  const nextDay = new Date(dEnd);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endExclusiveDate = nextDay.toISOString().slice(0, 10);

  return {
    hasDateRange: true,
    startDate: sDate,
    endDate: eDate,
    endExclusiveDate,
    // Pure DATE format for date column queries
    dateStart: sDate,
    dateEndExclusive: endExclusiveDate,
    // TIMESTAMPTZ with +07:00 Asia/Ho_Chi_Minh offset
    startTimestamptz: `${sDate}T00:00:00+07:00`,
    endExclusiveTimestamptz: `${endExclusiveDate}T00:00:00+07:00`,
  };
}

// ============================================================================
// READ-ONLY TRANSACTION EXECUTOR (INTERNAL ONLY — NOT EXPORTED)
// ============================================================================

async function executeReadOnlyTransaction(sql, params = []) {
  const client = await (db.getReadOnlyClient ? db.getReadOnlyClient() : db.getClient());
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await client.query(`SET LOCAL TIME ZONE '${TIMEZONE}'`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Suppress rollback errors to rethrow original query error
    }
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// INDIVIDUAL KPI COMPUTERS
// ============================================================================

async function executeKPIQuery(kpiCode, tenant, dateRange) {
  const { effectiveCompanyId, effectiveBranch } = tenant;
  const { dateStart, dateEndExclusive, startTimestamptz, endExclusiveTimestamptz } = dateRange;

  switch (kpiCode) {
    case 'DOC_TOTAL': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.DOC_TOTAL,
        [effectiveCompanyId, effectiveBranch]
      );
      const row = normalizeRow(rows[0] || {});
      const totalDocs = row.total_documents || 0;
      const activeCount = row.active_count || 0;
      return {
        status: 'AVAILABLE',
        data: {
          total_documents: totalDocs,
          active_count: activeCount,
          inactive_or_expired_count: Math.max(0, totalDocs - activeCount),
        },
        warnings: [],
      };
    }

    case 'DOC_BY_EFFECTIVE_DATE': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.DOC_BY_EFFECTIVE_DATE,
        [dateStart, dateEndExclusive, effectiveCompanyId, effectiveBranch]
      );
      const items = normalizeRows(rows);
      return {
        status: 'AVAILABLE',
        data: {
          items,
          total_periods: items.length,
          total_documents: items.reduce((sum, item) => sum + (item.doc_count || 0), 0),
        },
        warnings: [],
      };
    }

    case 'DOC_BY_TYPE': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.DOC_BY_TYPE,
        [effectiveCompanyId, effectiveBranch]
      );
      const items = normalizeRows(rows);
      return {
        status: 'AVAILABLE',
        data: {
          items,
          total_types: items.length,
          total_documents: items.reduce((sum, item) => sum + (item.doc_count || 0), 0),
        },
        warnings: [],
      };
    }

    case 'DOC_STATUS': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.DOC_STATUS,
        [effectiveCompanyId, effectiveBranch]
      );
      const items = normalizeRows(rows);
      return {
        status: 'AVAILABLE',
        data: {
          items,
          total_documents: items.reduce((sum, item) => sum + (item.total_count || 0), 0),
        },
        warnings: [],
      };
    }

    case 'INTAKE_UPLOADS': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.INTAKE_UPLOADS,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const row = normalizeRow(rows[0] || {});
      return {
        status: 'AVAILABLE',
        data: {
          total_batches: row.total_batches || 0,
          total_files_uploaded: row.total_files_uploaded || 0,
          avg_files_per_batch: row.avg_files_per_batch || 0,
        },
        warnings: [],
      };
    }

    case 'INTAKE_BY_USER': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.INTAKE_BY_USER,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const items = normalizeRows(rows);
      return {
        status: 'AVAILABLE',
        data: {
          items,
          total_users: items.length,
          total_batches: items.reduce((sum, item) => sum + (item.total_batches || 0), 0),
          total_files: items.reduce((sum, item) => sum + (item.total_files || 0), 0),
        },
        warnings: [],
      };
    }

    case 'INTAKE_TRENDS': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.INTAKE_TRENDS,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const items = normalizeRows(rows);
      return {
        status: 'AVAILABLE',
        data: {
          items,
          total_periods: items.length,
          total_batches: items.reduce((sum, item) => sum + (item.batch_count || 0), 0),
          total_files: items.reduce((sum, item) => sum + (item.files_count || 0), 0),
        },
        warnings: [],
      };
    }

    case 'INTAKE_SUCCESS': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.INTAKE_SUCCESS,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const row = normalizeRow(rows[0] || {});
      return {
        status: 'AVAILABLE',
        data: {
          total_batches: row.total_batches || 0,
          completed_batches: row.completed_batches || 0,
          ocr_completed_batches: row.ocr_completed_batches || 0,
          converted_batches_all_status: row.converted_batches_all_status || 0,
          conversion_rate_all_status: row.conversion_rate_all_status !== null ? row.conversion_rate_all_status : 0,
          converted_completed_batches: row.converted_completed_batches || 0,
          conversion_rate_completed_only: row.conversion_rate_completed_only !== null ? row.conversion_rate_completed_only : 0,
          same_company_converted_batches: row.same_company_converted_batches || 0,
          cross_company_converted_batches: row.cross_company_converted_batches || 0,
          same_company_staging_records: row.same_company_staging_records || 0,
          cross_company_staging_records: row.cross_company_staging_records || 0,
        },
        warnings: [
          'Trạng thái completed của lô không đồng nghĩa 100% hồ sơ chuyển đổi thành công (batch mock hoặc rỗng không tạo staging record).',
          'Chỉ số chuyển đổi được quy gán theo company_id của lô nạp hồ sơ (batch attribution).',
        ],
      };
    }

    case 'DUPLICATE_RATE': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.DUPLICATE_RATE,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const row = normalizeRow(rows[0] || {});
      return {
        status: 'AVAILABLE',
        data: {
          total_staged: row.total_staged || 0,
          suspected_cnt: row.suspected_cnt || 0,
          suspected_duplicate_rate: row.suspected_duplicate_rate !== null ? row.suspected_duplicate_rate : 0,
          approved_duplicate_cnt: row.approved_duplicate_cnt || 0,
        },
        warnings: [],
      };
    }

    case 'APPROVAL_QUEUE': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.APPROVAL_QUEUE,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const row = normalizeRow(rows[0] || {});
      return {
        status: 'AVAILABLE',
        data: {
          current_pending_queue: row.current_pending_queue || 0,
          approval_activity: row.approval_activity || 0,
          rejection_activity: row.rejection_activity || 0,
        },
        warnings: [
          'rejection_activity đo lường số hồ sơ hiện ở trạng thái rejected được đánh giá trong kỳ qua cột reviewed_at (CSDL không có cột rejected_at).',
          'current_pending_queue phản ánh tồn đọng hiện tại, không phụ thuộc vào bộ lọc thời gian.',
        ],
      };
    }

    case 'OCR_QUALITY': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.OCR_QUALITY,
        [effectiveCompanyId, effectiveBranch]
      );
      const row = normalizeRow(rows[0] || {});
      const totalDocs = row.total_docs || 0;
      const measuredDocs = row.measured_docs || 0;
      const missingDocs = row.missing_docs || 0;
      const avgQuality = row.avg_doc_parse_quality;

      let status = 'DATA_UNAVAILABLE';
      if (totalDocs > 0) {
        if (measuredDocs === totalDocs) {
          status = 'AVAILABLE';
        } else if (measuredDocs > 0) {
          status = 'PARTIALLY_AVAILABLE';
        } else {
          status = 'DATA_UNAVAILABLE';
        }
      }

      return {
        status,
        data: {
          measured_docs: measuredDocs,
          total_docs: totalDocs,
          missing_docs: missingDocs,
          avg_doc_parse_quality: avgQuality,
          sub_metric_hr_profile_ocr: {
            status: 'DATA_UNAVAILABLE',
            reason: 'Bảng hr_employee_staging chưa có cột numeric confidence để tính toán định lượng.',
          },
        },
        warnings: [
          'Chất lượng số hóa chỉ đo lường trên văn bản quy định có parse_quality.',
          'Điểm tin cậy OCR hồ sơ nhân sự (hr_employee_staging) chưa có cột định lượng.',
        ],
      };
    }

    case 'DATA_INTEGRITY': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.DATA_INTEGRITY,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const row = normalizeRow(rows[0] || {});
      return {
        status: 'AVAILABLE',
        data: {
          total_profiles: row.total_profiles || 0,
          missing_fields_count: row.missing_fields_count || 0,
          uncertain_fields_count: row.uncertain_fields_count || 0,
          missing_fields_rate: row.missing_fields_rate !== null ? row.missing_fields_rate : 0,
        },
        warnings: [],
      };
    }

    case 'ACTIVE_USERS': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.ACTIVE_USERS,
        [startTimestamptz, endExclusiveTimestamptz, effectiveCompanyId]
      );
      const items = normalizeRows(rows);
      const totalActiveUsers = items.reduce((sum, item) => sum + (item.active_users || 0), 0);
      const totalActions = items.reduce((sum, item) => sum + (item.total_actions || 0), 0);
      return {
        status: 'AVAILABLE',
        data: {
          total_active_users: totalActiveUsers,
          total_actions: totalActions,
          breakdown: items,
        },
        warnings: [],
      };
    }

    case 'RAG_ANSWERABLE': {
      const rows = await executeReadOnlyTransaction(
        SQL_QUERIES.RAG_ANSWERABLE,
        [effectiveCompanyId, startTimestamptz, endExclusiveTimestamptz]
      );
      const row = normalizeRow(rows[0] || {});
      return {
        status: 'AVAILABLE',
        data: {
          eligible_rag_queries: row.eligible_rag_queries || 0,
          answerable_count: row.answerable_count || 0,
          similarity_sample_count: row.similarity_sample_count || 0,
          avg_vector_similarity: row.avg_vector_similarity,
          answerability_rate: row.answerability_rate !== null ? row.answerability_rate : 0,
          sub_metric_latency: {
            status: 'DATA_UNAVAILABLE',
            reason: 'Bảng chat_log chưa có cột latency_ms để đo lường độ trễ phản hồi.',
          },
        },
        warnings: [
          'Chỉ số chỉ tính trên các bản ghi RAG có answerable IS NOT NULL (loại trừ hội thoại General AI).',
          'similarity_sample_count đếm độc lập trên các bản ghi có best_sim IS NOT NULL.',
          'Sub-metric độ trễ (latency) ở trạng thái DATA_UNAVAILABLE do thiếu cột latency_ms.',
        ],
      };
    }

    default:
      throw new AnalyticsError(`Mã KPI không được hỗ trợ thực thi: "${kpiCode}".`, 400, 'UNSUPPORTED_KPI');
  }
}

// ============================================================================
// PUBLIC API: COMPUTE KPI
// ============================================================================

/**
 * Compute a single KPI according to standardized specifications.
 * 
 * @param {string} kpiCode - Standard KPI code (e.g. 'DOC_TOTAL', 'INTAKE_SUCCESS')
 * @param {object} options - Query options { companyId, startDate, endDate }
 * @param {object} userContext - Authenticated user context { user_id, username, role, company_id, status }
 * @returns {Promise<object>} Standardized JSON response payload
 */
async function computeKPI(kpiCode, options = {}, userContext = {}) {
  const code = String(kpiCode || '').trim().toUpperCase();
  const kpiMeta = KPI_CATALOG[code];

  if (!kpiMeta) {
    throw new AnalyticsError(`Mã KPI không hợp lệ: "${kpiCode}". Vui lòng tham chiếu danh mục 17 KPI chuẩn.`, 400, 'UNKNOWN_KPI');
  }

  // 1. Resolve Tenant Scope (Enforce strict security guard)
  const tenant = resolveTenantScope(userContext, options);

  // 2. Parse & Validate Date Range
  const dateRange = parseDateRange(options);

  // 3. Handle BLOCKED KPIs (Zero DB queries, immediate structured response)
  if (kpiMeta.classification === 'BLOCKED') {
    return {
      kpi: code,
      status: 'DATA_UNAVAILABLE',
      reason: kpiMeta.blocked_reason,
      scope: {
        company_id: tenant.effectiveCompanyId,
        branch: tenant.effectiveBranch,
      },
      period: {
        start: dateRange.startDate,
        end_exclusive: dateRange.endExclusiveDate,
        timezone: TIMEZONE,
      },
      data: null,
      warnings: [`KPI ${code} bị khóa kỹ thuật: ${kpiMeta.blocked_reason}`],
      metadata: {
        classification: kpiMeta.classification,
        source_tables: kpiMeta.source_tables,
        generated_at: new Date().toISOString(),
      },
    };
  }

  // 4. Execute Query in Read-Only Transaction
  const queryResult = await executeKPIQuery(code, tenant, dateRange);

  // 5. Build Standardized JSON Payload
  return {
    kpi: code,
    status: queryResult.status,
    scope: {
      company_id: tenant.effectiveCompanyId,
      branch: tenant.effectiveBranch,
    },
    period: {
      start: dateRange.startDate,
      end_exclusive: dateRange.endExclusiveDate,
      timezone: TIMEZONE,
    },
    data: queryResult.data,
    warnings: queryResult.warnings || [],
    metadata: {
      classification: kpiMeta.classification,
      source_tables: kpiMeta.source_tables,
      generated_at: new Date().toISOString(),
    },
  };
}

// ============================================================================
// HIGH-LEVEL BUSINESS AGGREGATORS (DOMAIN-SPECIFIC WRAPPERS)
// ============================================================================

async function getSummaryKPIs(options = {}, userContext = {}) {
  const summaryCodes = ['DOC_TOTAL', 'INTAKE_UPLOADS', 'INTAKE_SUCCESS', 'APPROVAL_QUEUE', 'ACTIVE_USERS', 'RAG_ANSWERABLE'];
  const results = {};
  for (const code of summaryCodes) {
    results[code] = await computeKPI(code, options, userContext);
  }
  return {
    group: 'SUMMARY_OVERVIEW',
    kpis: results,
    generated_at: new Date().toISOString(),
  };
}

async function getDocumentKPIs(options = {}, userContext = {}) {
  const docCodes = ['DOC_TOTAL', 'DOC_BY_EFFECTIVE_DATE', 'DOC_BY_TYPE', 'DOC_STATUS', 'OCR_QUALITY'];
  const results = {};
  for (const code of docCodes) {
    results[code] = await computeKPI(code, options, userContext);
  }
  return {
    group: 'DOCUMENTS',
    kpis: results,
    generated_at: new Date().toISOString(),
  };
}

async function getIntakeQualityKPIs(options = {}, userContext = {}) {
  const intakeCodes = [
    'INTAKE_UPLOADS',
    'INTAKE_BY_USER',
    'INTAKE_TRENDS',
    'INTAKE_SUCCESS',
    'INTAKE_FAILURE',
    'INTAKE_DURATION',
    'DUPLICATE_RATE',
    'APPROVAL_QUEUE',
    'DATA_INTEGRITY',
  ];
  const results = {};
  for (const code of intakeCodes) {
    results[code] = await computeKPI(code, options, userContext);
  }
  return {
    group: 'INTAKE_AND_QUALITY',
    kpis: results,
    generated_at: new Date().toISOString(),
  };
}

async function getRagHealthKPIs(options = {}, userContext = {}) {
  const ragCodes = ['RAG_ANSWERABLE', 'POLICY_CONFLICT'];
  const results = {};
  for (const code of ragCodes) {
    results[code] = await computeKPI(code, options, userContext);
  }
  return {
    group: 'RAG_HEALTH',
    kpis: results,
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// EXPORTS (STRICTLY NO GENERIC SQL EXECUTOR EXPORTED)
// ============================================================================

module.exports = {
  computeKPI,
  getSummaryKPIs,
  getDocumentKPIs,
  getIntakeQualityKPIs,
  getRagHealthKPIs,
  KPI_CATALOG,
  BRANCH_MAP,
  AnalyticsError,
};
