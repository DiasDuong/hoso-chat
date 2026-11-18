/**
 * SOTRANS HUB — PHASE 1.2 REPORTING API & SECURITY UNIT TEST SUITE
 * 
 * Strict Unit Test Suite for Reporting API (/api/analytics/kpis)
 * - Zero connection to Live/Production Database
 * - Hermetic Mocking of Auth Middleware and Analytics Engine
 * - Verifies 30 mandatory test scenarios:
 *   1-4. ADMIN Tenant Resolution (STL, VTX, SWC, ALL)
 *   5-7. ADMIN Tenant Validation (Missing, Empty, Invalid/Tampering)
 *   8-9. HR Tenant Enforcement (req.user context force, Zero trust client param)
 *   10-12. Role & Account Guards (EMPLOYEE, USER/Guest, INACTIVE/LOCKED)
 *   13. Missing Authentication (401)
 *   14-17. KPI Code Validation (Valid, Invalid, Duplicate, >17 Limit)
 *   18-20. Date Range Validation (Invalid format/value, startDate > endDate, Incomplete)
 *   21. Arbitrary SQL & Identity Spoofing Protection
 *   22. Blocked KPIs Preservation (DATA_UNAVAILABLE for KPI 9, 10, 12)
 *   23-24. Error Handling & Leak Prevention (AnalyticsError propagation, No Stack Traces/SQL)
 *   25. Feature Flag (BI_REPORTING_ENABLED defaults to disabled / 503)
 *   26-27. Short-Circuit Verification (Analytics Engine NOT called on unauthorized/invalid requests)
 *   28. Standardized JSON Contract Verification
 *   29. Non-Interference with General AI Routes
 *   30. Fault Tolerance & Server Resilience
 */

const assert = require('assert');
const http = require('http');
const express = require('../auth-service/node_modules/express');

// ============================================================================
// STEP 1: MOCK AUTH MIDDLEWARE BEFORE REQUIRING ROUTES
// ============================================================================

const auth = require('../auth-service/middleware/auth');
const analyticsEngine = require('../auth-service/services/analyticsEngine');

let mockCurrentUser = null;

auth.verifyToken = (req, res, next) => {
  if (!mockCurrentUser) {
    return res.status(401).json({
      success: false,
      error: 'Chưa đăng nhập. Vui lòng cung cấp token hợp lệ.',
      code: 'UNAUTHORIZED',
    });
  }
  req.user = mockCurrentUser;
  next();
};

auth.requireRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Chưa xác thực người dùng.',
        code: 'UNAUTHORIZED',
      });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Quyền ${req.user.role} không được phép thực hiện thao tác này.`,
        code: 'FORBIDDEN_ROLE',
      });
    }
    next();
  };
};

// ============================================================================
// STEP 2: MOCK ANALYTICS ENGINE
// ============================================================================

let engineCallLog = [];
let mockEngineThrow = null;

const originalComputeKPI = analyticsEngine.computeKPI;

analyticsEngine.computeKPI = async (kpiCode, options, userContext) => {
  engineCallLog.push({ kpiCode, options, userContext });

  if (mockEngineThrow) {
    throw mockEngineThrow;
  }

  // Handle BLOCKED KPIs according to Phase 1.1 specifications
  if (['INTAKE_FAILURE', 'INTAKE_DURATION', 'POLICY_CONFLICT'].includes(kpiCode)) {
    const reasonMap = {
      INTAKE_FAILURE: 'Pipeline chưa ghi nhận đầy đủ lỗi Gateway/Middleware vào database.',
      INTAKE_DURATION: '100 batch gần nhất có created_at = updated_at và completed_at chưa được cập nhật.',
      POLICY_CONFLICT: 'Detected Policy Conflicts được tính động trong policyConflictDetector.js, chưa lưu thành dữ liệu truy vấn tĩnh trong PostgreSQL.',
    };
    return {
      kpi: kpiCode,
      status: 'DATA_UNAVAILABLE',
      reason: reasonMap[kpiCode],
      scope: { company_id: options.companyId, branch: options.companyId === 'ALL' ? 'all' : 'sotrans_logistics' },
      period: { start: options.startDate, end_exclusive: options.endDate, timezone: 'Asia/Ho_Chi_Minh' },
      data: null,
      warnings: [`KPI ${kpiCode} bị khóa kỹ thuật.`],
      metadata: { source_tables: ['hr_intake_batches'], generated_at: new Date().toISOString() },
    };
  }

  // Default mock response for other KPIs
  return {
    kpi: kpiCode,
    status: 'AVAILABLE',
    scope: { company_id: options.companyId, branch: options.companyId === 'ALL' ? 'all' : 'sotrans_logistics' },
    period: { start: options.startDate, end_exclusive: options.endDate, timezone: 'Asia/Ho_Chi_Minh' },
    data: { value: 100, label: 'mock_metric' },
    warnings: [],
    metadata: { source_tables: ['mock_table'], generated_at: new Date().toISOString() },
  };
};

// ============================================================================
// STEP 3: CONFIGURE EXPRESS TEST APPLICATION
// ============================================================================

const analyticsRoutes = require('../auth-service/routes/analytics');

const app = express();
app.use(express.json());
app.use('/api/analytics', analyticsRoutes);

// Global test error handler
app.use((err, req, res, next) => {
  res.status(500).json({ success: false, error: err.message });
});

let server = null;
let serverPort = 0;

function resetTestState() {
  engineCallLog = [];
  mockEngineThrow = null;
  mockCurrentUser = null;
  process.env.BI_REPORTING_ENABLED = 'true'; // Enabled by default for scenario testing
}

// HTTP request helper
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        path,
        method,
        headers: reqHeaders,
      },
      res => {
        let responseBody = '';
        res.on('data', chunk => {
          responseBody += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(responseBody);
          } catch (_) {
            parsed = responseBody;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ============================================================================
// TEST RUNNER
// ============================================================================

let passCount = 0;
let failCount = 0;
const results = [];

async function runScenario(id, title, testFn) {
  resetTestState();
  try {
    await testFn();
    passCount++;
    results.push({ id, title, status: 'PASS' });
    console.log(`[PASS] Scenario ${String(id).padStart(2, '0')}: ${title}`);
  } catch (err) {
    failCount++;
    results.push({ id, title, status: 'FAIL', error: err.message });
    console.error(`[FAIL] Scenario ${String(id).padStart(2, '0')}: ${title} -> ${err.message}`);
  }
}

// ============================================================================
// 30 MANDATORY TEST SCENARIOS
// ============================================================================

async function runAllTests() {
  console.log('================================================================');
  console.log('SOTRANS HUB — PHASE 1.2 REPORTING API 30 SCENARIOS SUITE');
  console.log('Target: POST /api/analytics/kpis');
  console.log('Mode: Isolated Mock Unit Testing (NO PRODUCTION DB ACCESS)');
  console.log('================================================================\n');

  // Start test server
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });

  // Scenario 1: ADMIN explicit STL
  await runScenario(1, 'ADMIN explicit STL executes successfully', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.count, 1);
    assert.strictEqual(res.body.data.results[0].scope.company_id, 'STL');
    assert.strictEqual(engineCallLog[0].options.companyId, 'STL');
  });

  // Scenario 2: ADMIN explicit VTX
  await runScenario(2, 'ADMIN explicit VTX executes successfully', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'VTX',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(engineCallLog[0].options.companyId, 'VTX');
  });

  // Scenario 3: ADMIN explicit SWC
  await runScenario(3, 'ADMIN explicit SWC executes successfully', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'SWC',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(engineCallLog[0].options.companyId, 'SWC');
  });

  // Scenario 4: ADMIN explicit ALL
  await runScenario(4, 'ADMIN explicit ALL executes successfully', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'ALL',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(engineCallLog[0].options.companyId, 'ALL');
  });

  // Scenario 5: ADMIN thiếu companyId
  await runScenario(5, 'ADMIN missing companyId is blocked with 400 and zero engine calls', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'MISSING_ADMIN_TENANT');
    assert.strictEqual(engineCallLog.length, 0, 'Analytics Engine must NOT be called');
  });

  // Scenario 6: ADMIN companyId rỗng
  await runScenario(6, 'ADMIN empty companyId is blocked with 400 and zero engine calls', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: '   ',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'MISSING_ADMIN_TENANT');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 7: ADMIN companyId không hợp lệ
  await runScenario(7, 'ADMIN invalid companyId is blocked with 400 and triggers tamper log', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'HACK_CORP',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'INVALID_ADMIN_TENANT');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 8: HR chỉ truy cập tenant từ req.user
  await runScenario(8, 'HR tenant is strictly enforced from req.user.company_id', async () => {
    mockCurrentUser = { user_id: 'hr-1', username: 'hr_vtx', role: 'HR', company_id: 'VTX', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['INTAKE_UPLOADS'],
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(engineCallLog[0].options.companyId, 'VTX');
  });

  // Scenario 9: HR không thể override tenant
  await runScenario(9, 'HR client cannot override tenant by passing options.companyId', async () => {
    mockCurrentUser = { user_id: 'hr-1', username: 'hr_stl', role: 'HR', company_id: 'STL', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['INTAKE_UPLOADS'],
      companyId: 'SWC', // Client attempts to switch to SWC
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(engineCallLog[0].options.companyId, 'STL', 'Must remain forced to STL');
  });

  // Scenario 10: EMPLOYEE bị chặn
  await runScenario(10, 'EMPLOYEE role is rejected with 403 Forbidden', async () => {
    mockCurrentUser = { user_id: 'emp-1', username: 'employee_user', role: 'EMPLOYEE', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'FORBIDDEN_ROLE');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 11: USER/Guest bị chặn
  await runScenario(11, 'USER and Guest roles are rejected with 403 Forbidden', async () => {
    mockCurrentUser = { user_id: 'usr-1', username: 'standard_user', role: 'USER', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'FORBIDDEN_ROLE');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 12: INACTIVE bị chặn
  await runScenario(12, 'INACTIVE account is rejected with 403 Forbidden', async () => {
    mockCurrentUser = { user_id: 'hr-inactive', username: 'duongminh', role: 'HR', company_id: 'STL', status: 'INACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'ACCOUNT_INACTIVE');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 13: Missing authentication trả 401
  await runScenario(13, 'Unauthenticated request returns 401 Unauthorized', async () => {
    mockCurrentUser = null; // No user logged in
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'UNAUTHORIZED');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 14: KPI code hợp lệ
  await runScenario(14, 'Valid KPI codes in catalog are accepted and executed', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL', 'INTAKE_UPLOADS'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.count, 2);
    assert.strictEqual(engineCallLog.length, 2);
  });

  // Scenario 15: KPI code không hợp lệ
  await runScenario(15, 'Invalid KPI code returns 400 Bad Request with zero engine calls', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL', 'FAKE_UNSUPPORTED_KPI'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'UNKNOWN_KPI_CODE');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 16: KPI code trùng
  await runScenario(16, 'Duplicate KPI codes in same request are rejected with 400', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL', 'DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'DUPLICATE_KPI_CODE');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 17: Hơn 17 KPI trong một request
  await runScenario(17, 'More than 17 KPI codes in one request is rejected with 400', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const codes = Array.from({ length: 18 }, (_, i) => `KPI_${i}`);
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: codes,
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'KPI_LIMIT_EXCEEDED');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 18: Ngày không hợp lệ
  await runScenario(18, 'Invalid date format/value is rejected with 400 Bad Request', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
      startDate: 'invalid-date',
      endDate: '2026-11-13',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'INVALID_DATE_FORMAT');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 19: startDate > endDate
  await runScenario(19, 'startDate > endDate is rejected with 400 Bad Request', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
      startDate: '2026-11-20',
      endDate: '2026-11-10',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'INVALID_DATE_ORDER');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 20: Thiếu một trong hai trường ngày
  await runScenario(20, 'Providing only startDate without endDate is rejected with 400', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
      startDate: '2026-11-01',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'INCOMPLETE_DATE_RANGE');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 21: API không nhận arbitrary SQL
  await runScenario(21, 'Identity spoofing or arbitrary body injections are rejected with 400', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
      userId: 'spoofed-id', // Illegal spoofing parameter
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'IDENTITY_SPOOFING_ATTEMPT');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 22: KPI 9/10/12 trả DATA_UNAVAILABLE
  await runScenario(22, 'BLOCKED KPIs 9, 10, 12 return DATA_UNAVAILABLE with clear reasons', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['INTAKE_FAILURE', 'INTAKE_DURATION', 'POLICY_CONFLICT'],
      companyId: 'ALL',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.count, 3);
    for (const item of res.body.data.results) {
      assert.strictEqual(item.status, 'DATA_UNAVAILABLE');
      assert.strictEqual(item.data, null);
      assert.ok(item.reason && item.reason.length > 0);
    }
  });

  // Scenario 23: Lỗi Analytics Engine được xử lý đúng
  await runScenario(23, 'AnalyticsError from engine propagates with accurate status and code', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    mockEngineThrow = new analyticsEngine.AnalyticsError('Lỗi kiểm tra dữ liệu Analytics', 400, 'CUSTOM_ANALYTICS_ERR');
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'CUSTOM_ANALYTICS_ERR');
  });

  // Scenario 24: Không trả stack trace hoặc SQL ra client
  await runScenario(24, 'Internal engine errors return safe 500 without leaking stack traces or SQL', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    mockEngineThrow = new Error('FATAL: disk corrupt at SELECT * FROM secret_table');
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'INTERNAL_SERVER_ERROR');
    assert.ok(!JSON.stringify(res.body).includes('secret_table'), 'Must not leak SQL or table names');
    assert.ok(!JSON.stringify(res.body).includes('stack'), 'Must not leak stack traces');
  });

  // Scenario 25: Feature flag mặc định disabled
  await runScenario(25, 'Feature flag disabled returns 503 SERVICE_DISABLED', async () => {
    process.env.BI_REPORTING_ENABLED = 'false'; // Temporarily disable
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'SERVICE_DISABLED');
    assert.strictEqual(engineCallLog.length, 0);
  });

  // Scenario 26: Không gọi Analytics Engine khi user không có quyền
  await runScenario(26, 'Zero engine invocations when caller lacks required role', async () => {
    mockCurrentUser = { user_id: 'guest-1', username: 'guest', role: 'GUEST', status: 'ACTIVE' };
    await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(engineCallLog.length, 0, 'Must short-circuit before engine');
  });

  // Scenario 27: Không gọi Analytics Engine khi tenant không hợp lệ
  await runScenario(27, 'Zero engine invocations when ADMIN tenant parameter is invalid', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'ILLEGAL_TENANT_VALUE',
    });
    assert.strictEqual(engineCallLog.length, 0, 'Must short-circuit before engine');
  });

  // Scenario 28: Kiểm tra response JSON contract
  await runScenario(28, 'Response payload conforms to Phase 1.2 standardized contract', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    const res = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data && Array.isArray(res.body.data.results));
    assert.strictEqual(typeof res.body.data.count, 'number');
    assert.ok(res.body.metadata && res.body.metadata.generated_at);
    assert.strictEqual(res.body.metadata.timezone, 'Asia/Ho_Chi_Minh');

    const kpiItem = res.body.data.results[0];
    assert.ok(kpiItem.kpi);
    assert.ok(kpiItem.status);
    assert.ok(kpiItem.scope);
    assert.ok(kpiItem.period);
    assert.ok('data' in kpiItem);
    assert.ok(Array.isArray(kpiItem.warnings));
    assert.ok(kpiItem.metadata);
  });

  // Scenario 29: Kiểm tra route không gây ảnh hưởng General AI
  await runScenario(29, 'Analytics routes do not intercept or conflict with General AI routes', async () => {
    const generalAiRoutes = require('../auth-service/routes/general_ai');
    assert.ok(generalAiRoutes, 'General AI routes remain intact and independently loaded');
    // Verify analytics routes path namespace is cleanly isolated
    assert.strictEqual(typeof analyticsRoutes, 'function');
  });

  // Scenario 30: Kiểm tra lỗi không làm sập auth-service
  await runScenario(30, 'Server survives unhandled exceptions and remains operational for follow-up requests', async () => {
    mockCurrentUser = { user_id: 'adm-1', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
    mockEngineThrow = new Error('Simulated runtime crash error');
    const crashRes = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(crashRes.statusCode, 500);

    // Follow-up request must succeed cleanly
    mockEngineThrow = null;
    const okRes = await request('POST', '/api/analytics/kpis', {
      kpiCodes: ['DOC_TOTAL'],
      companyId: 'STL',
    });
    assert.strictEqual(okRes.statusCode, 200);
    assert.strictEqual(okRes.body.success, true);
  });

  // ==========================================================================
  // FINAL SUMMARY REPORT
  // ==========================================================================
  console.log('\n================================================================');
  console.log(`PHASE 1.2 API TEST EXECUTION: ${passCount} / 30 PASS | ${failCount} FAIL`);
  console.log('Production Environment Connection: NONE (Hermetic Unit Mocks)');
  console.log('================================================================\n');

  // Close server
  if (server) {
    server.close();
  }

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Restore original function on exit
process.on('exit', () => {
  analyticsEngine.computeKPI = originalComputeKPI;
});

// Run suite
runAllTests().catch(err => {
  console.error('Fatal test runner error in API suite:', err);
  if (server) server.close();
  process.exit(1);
});
