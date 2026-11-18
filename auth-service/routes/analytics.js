/**
 * SOTRANS HUB — REPORTING API (PHASE 1.2)
 * 
 * Secure REST API for Business Intelligence & Reporting
 * - Connects exclusively to analyticsEngine.js
 * - Reuses existing authentication (verifyToken) & RBAC (requireRoles)
 * - Strict tenant enforcement (ADMIN explicit whitelist, HR user context force)
 * - Feature flag gated (BI_REPORTING_ENABLED)
 * - Standardized JSON contract without leaking raw SQL, credentials, or PII
 */

const express = require('express');
const router = express.Router();
const { verifyToken, requireRoles } = require('../middleware/auth');
const analyticsEngine = require('../services/analyticsEngine');

// Whitelist of valid company tenant values
const ALLOWED_ADMIN_TENANTS = Object.freeze(['STL', 'VTX', 'SWC', 'ALL']);
const VALID_HR_TENANTS = Object.freeze(['STL', 'VTX', 'SWC']);

// ============================================================================
// HELPER: AUDIT LOG TAMPERING (NON-BLOCKING)
// ============================================================================
function logTenantTampering(req, attemptedCompany) {
  try {
    const audit = require('../audit');
    if (audit && typeof audit.logAudit === 'function') {
      audit.logAudit({
        actor_user_id: req.user?.user_id,
        actor_username: req.user?.username,
        action: 'SECURITY_TENANT_TAMPERING',
        status: 'BLOCKED',
        ip_address: req.ip,
        metadata: {
          attempted_company_id: String(attemptedCompany).slice(0, 50),
          role: req.user?.role,
          endpoint: req.originalUrl || '/api/analytics/kpis',
        },
      });
    }
  } catch (_) {
    // Audit logging failure should not crash API
  }
}

// ============================================================================
// MIDDLEWARE: FEATURE FLAG GUARD
// ============================================================================
function checkFeatureFlag(req, res, next) {
  const isEnabled = (process.env.BI_REPORTING_ENABLED === 'true' || process.env.FEATURE_BI_REPORTING === 'true') && process.env.BI_REPORTING_ENABLED !== 'false';
  if (!isEnabled) {
    return res.status(503).json({
      success: false,
      error: 'Dịch vụ BI Reporting hiện đang tạm thời bị vô hiệu hóa (BI_REPORTING_ENABLED is false).',
      code: 'SERVICE_DISABLED',
    });
  }
  next();
}

// ============================================================================
// MIDDLEWARE: ACCOUNT STATUS GUARD
// ============================================================================
function checkActiveAccount(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Chưa xác thực người dùng.',
      code: 'UNAUTHORIZED',
    });
  }

  const status = req.user.status ? String(req.user.status).trim().toUpperCase() : 'ACTIVE';
  if (status === 'INACTIVE' || status === 'LOCKED') {
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Tài khoản của bạn đã bị vô hiệu hóa hoặc bị khóa.',
      code: 'ACCOUNT_INACTIVE',
    });
  }
  next();
}

// ============================================================================
// ROUTE 1: GET /api/analytics/catalog
// Discover 17 standard KPIs, classifications, and parameters
// ============================================================================
router.get(
  '/catalog',
  checkFeatureFlag,
  verifyToken,
  requireRoles('ADMIN', 'HR'),
  checkActiveAccount,
  (req, res) => {
    res.json({
      success: true,
      data: {
        kpis: analyticsEngine.KPI_CATALOG,
        total: Object.keys(analyticsEngine.KPI_CATALOG).length,
      },
      metadata: {
        generated_at: new Date().toISOString(),
        timezone: 'Asia/Ho_Chi_Minh',
      },
    });
  }
);

// ============================================================================
// ROUTE 2: POST /api/analytics/kpis
// Execute one or more KPIs (max 17) in a safe, parameterized reporting batch
// ============================================================================
router.post(
  '/kpis',
  checkFeatureFlag,
  verifyToken,
  requireRoles('ADMIN', 'HR'),
  checkActiveAccount,
  async (req, res) => {
    try {
      const { kpiCodes, companyId, startDate, endDate } = req.body || {};

      // 1. Guard against spoofed identity parameters in request body
      if ('userId' in req.body || 'user_id' in req.body || 'role' in req.body || 'userContext' in req.body) {
        return res.status(400).json({
          success: false,
          error: 'Không được phép truyền thông tin định danh (userId, role) trong body request.',
          code: 'IDENTITY_SPOOFING_ATTEMPT',
        });
      }

      // 2. Validate kpiCodes list
      if (!kpiCodes || !Array.isArray(kpiCodes) || kpiCodes.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'kpiCodes phải là một mảng chứa ít nhất 1 mã KPI.',
          code: 'INVALID_KPI_CODES',
        });
      }

      if (kpiCodes.length > 17) {
        return res.status(400).json({
          success: false,
          error: 'Số lượng KPI trong một request không được vượt quá 17.',
          code: 'KPI_LIMIT_EXCEEDED',
        });
      }

      // 3. Check for duplicate KPI codes and validate against catalog
      const seenCodes = new Set();
      const normalizedCodes = [];

      for (const rawCode of kpiCodes) {
        if (typeof rawCode !== 'string') {
          return res.status(400).json({
            success: false,
            error: 'Mỗi phần tử trong kpiCodes phải là một chuỗi ký tự.',
            code: 'INVALID_KPI_TYPE',
          });
        }

        const code = rawCode.trim().toUpperCase();
        if (seenCodes.has(code)) {
          return res.status(400).json({
            success: false,
            error: `Danh sách kpiCodes chứa mã KPI trùng lặp: "${code}".`,
            code: 'DUPLICATE_KPI_CODE',
          });
        }
        seenCodes.add(code);

        if (!analyticsEngine.KPI_CATALOG[code]) {
          return res.status(400).json({
            success: false,
            error: `Mã KPI "${rawCode}" không tồn tại trong danh mục báo cáo.`,
            code: 'UNKNOWN_KPI_CODE',
          });
        }

        normalizedCodes.push(code);
      }

      // 4. Validate Tenant Isolation
      let effectiveCompanyId = null;

      if (req.user.role === 'ADMIN') {
        if (companyId === undefined || companyId === null || String(companyId).trim() === '') {
          return res.status(400).json({
            success: false,
            error: 'Thiếu tham số companyId bắt buộc đối với quyền ADMIN (phải thuộc STL, VTX, SWC hoặc ALL).',
            code: 'MISSING_ADMIN_TENANT',
          });
        }

        const normalizedCompany = String(companyId).trim().toUpperCase();
        if (!ALLOWED_ADMIN_TENANTS.includes(normalizedCompany)) {
          logTenantTampering(req, companyId);
          return res.status(400).json({
            success: false,
            error: `Tham số companyId "${companyId}" không hợp lệ. Phải thuộc STL, VTX, SWC hoặc ALL.`,
            code: 'INVALID_ADMIN_TENANT',
          });
        }

        effectiveCompanyId = normalizedCompany;
      } else if (req.user.role === 'HR') {
        // HR tenant is STRICTLY forced from authenticated token
        if (!req.user.company_id) {
          return res.status(403).json({
            success: false,
            error: '403 Forbidden: Tài khoản HR chưa được gán company_id hợp lệ.',
            code: 'MISSING_HR_TENANT',
          });
        }

        const hrCompany = String(req.user.company_id).trim().toUpperCase();
        if (!VALID_HR_TENANTS.includes(hrCompany)) {
          return res.status(403).json({
            success: false,
            error: `403 Forbidden: Đơn vị "${req.user.company_id}" của tài khoản HR không hợp lệ.`,
            code: 'INVALID_HR_TENANT',
          });
        }

        effectiveCompanyId = hrCompany;
      }

      // 5. Validate Date Range if provided
      if (startDate || endDate) {
        if (!startDate || !endDate) {
          return res.status(400).json({
            success: false,
            error: 'Yêu cầu cung cấp cả startDate và endDate (hoặc không truyền cả hai).',
            code: 'INCOMPLETE_DATE_RANGE',
          });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(String(startDate).trim()) || !dateRegex.test(String(endDate).trim())) {
          return res.status(400).json({
            success: false,
            error: 'Định dạng ngày phải là YYYY-MM-DD.',
            code: 'INVALID_DATE_FORMAT',
          });
        }

        const dStart = new Date(`${startDate}T00:00:00Z`);
        const dEnd = new Date(`${endDate}T00:00:00Z`);
        if (Number.isNaN(dStart.getTime()) || Number.isNaN(dEnd.getTime())) {
          return res.status(400).json({
            success: false,
            error: 'Giá trị ngày không hợp lệ trên lịch.',
            code: 'INVALID_DATE_VALUE',
          });
        }

        if (String(startDate).trim() > String(endDate).trim()) {
          return res.status(400).json({
            success: false,
            error: `startDate (${startDate}) không được lớn hơn endDate (${endDate}).`,
            code: 'INVALID_DATE_ORDER',
          });
        }
      }

      // 6. Execute Analytics Engine computation sequentially
      // Sequential execution guarantees we do not saturate the PostgreSQL pool
      const options = {
        companyId: effectiveCompanyId,
        startDate: startDate ? String(startDate).trim() : null,
        endDate: endDate ? String(endDate).trim() : null,
      };

      const results = [];
      for (const code of normalizedCodes) {
        const kpiResult = await analyticsEngine.computeKPI(code, options, req.user);
        results.push(kpiResult);
      }

      // 7. Return Standardized JSON Response
      return res.json({
        success: true,
        data: {
          results,
          count: results.length,
        },
        metadata: {
          generated_at: new Date().toISOString(),
          timezone: 'Asia/Ho_Chi_Minh',
        },
      });
    } catch (err) {
      if (err instanceof analyticsEngine.AnalyticsError) {
        return res.status(err.statusCode || 400).json({
          success: false,
          error: err.message,
          code: err.code || 'ANALYTICS_ERROR',
        });
      }

      console.error('[Reporting API Unhandled Error]:', err.message);
      return res.status(500).json({
        success: false,
        error: 'Đã xảy ra lỗi nội bộ khi xử lý báo cáo KPI.',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

module.exports = router;
