/**
 * SOTRANS HUB — PHASE 1.1 ANALYTICS ENGINE FOUNDATION UNIT TEST SUITE
 * 
 * Strict Unit Test Suite with Mocked db.getClient()
 * - Zero connection to Live/Production Database
 * - Verifies 30 mandatory test scenarios covering:
 *   1. ADMIN Tenant Whitelisting & Tampering Prevention
 *   2. HR Tenant Context Enforcement (Zero Trust Client Params)
 *   3. Role & Account Inactive Guards
 *   4. Read-Only Transaction Lifecycle (BEGIN READ ONLY, timeout 3000ms, Asia/Ho_Chi_Minh)
 *   5. Parameterized SQL & Zero Arbitrary SQL Injection
 *   6. Pure DATE vs TIMESTAMPTZ (+07:00) Date Range Normalization
 *   7. Mathematical and Schema Fidelity across 17 KPIs
 *   8. Immediate BLOCKED KPI Handling without DB Connection
 */

const assert = require('assert');
const path = require('path');

// Ensure db module is loaded so we can mock db.getClient
const db = require('../auth-service/db');
const analyticsEngine = require('../auth-service/services/analyticsEngine');

// ============================================================================
// MOCK HARNESS SETUP
// ============================================================================

let mockClientState = {
  getClientCallCount: 0,
  queries: [],
  releaseCount: 0,
  inTransaction: false,
  isReadOnly: false,
  timeoutSet: null,
  timezoneSet: null,
  isCommitted: false,
  isRolledBack: false,
  customRows: null,
  shouldThrowOnQuery: null,
};

function resetMockState() {
  mockClientState = {
    getClientCallCount: 0,
    queries: [],
    releaseCount: 0,
    inTransaction: false,
    isReadOnly: false,
    timeoutSet: null,
    timezoneSet: null,
    isCommitted: false,
    isRolledBack: false,
    customRows: null,
    shouldThrowOnQuery: null,
  };
}

// Override db.getClient with hermetic mock
db.getClient = async () => {
  mockClientState.getClientCallCount++;
  const client = {
    query: async (sqlText, params = []) => {
      const normalizedSql = String(sqlText).trim();
      mockClientState.queries.push({ sql: normalizedSql, params });

      if (normalizedSql === 'BEGIN TRANSACTION READ ONLY') {
        mockClientState.inTransaction = true;
        mockClientState.isReadOnly = true;
        return { rows: [] };
      }

      if (normalizedSql.startsWith('SET LOCAL statement_timeout')) {
        mockClientState.timeoutSet = normalizedSql;
        return { rows: [] };
      }

      if (normalizedSql.startsWith('SET LOCAL TIME ZONE')) {
        mockClientState.timezoneSet = normalizedSql;
        return { rows: [] };
      }

      if (normalizedSql === 'COMMIT') {
        mockClientState.isCommitted = true;
        mockClientState.inTransaction = false;
        return { rows: [] };
      }

      if (normalizedSql === 'ROLLBACK') {
        mockClientState.isRolledBack = true;
        mockClientState.inTransaction = false;
        return { rows: [] };
      }

      if (mockClientState.shouldThrowOnQuery) {
        throw mockClientState.shouldThrowOnQuery;
      }

      // Return configured mock rows or default mock row
      return { rows: mockClientState.customRows || [{ count: '1' }] };
    },
    release: () => {
      mockClientState.releaseCount++;
    },
  };
  return client;
};
db.getReadOnlyClient = db.getClient;

// ============================================================================
// TEST RUNNER
// ============================================================================

let passCount = 0;
let failCount = 0;
const results = [];

async function runScenario(id, title, testFn) {
  resetMockState();
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
  console.log('SOTRANS HUB — ANALYTICS ENGINE FOUNDATION 30 SCENARIOS SUITE');
  console.log('Mode: Isolated Unit Test Mocking (NO LIVE DATABASE CONNECTION)');
  console.log('================================================================\n');

  // Scenario 1: ADMIN explicit STL
  await runScenario(1, 'ADMIN explicit STL resolves correctly', async () => {
    mockClientState.customRows = [{ total_documents: '10', active_count: '8' }];
    const res = await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'STL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.scope.company_id, 'STL');
    assert.strictEqual(res.scope.branch, 'sotrans_logistics');
    assert.strictEqual(res.status, 'AVAILABLE');
    assert.strictEqual(res.data.total_documents, 10);
    // Verify query parameters
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.documents'));
    assert.ok(appQuery, 'Query on documents was executed');
    assert.strictEqual(appQuery.params[0], 'STL');
    assert.strictEqual(appQuery.params[1], 'sotrans_logistics');
  });

  // Scenario 2: ADMIN explicit VTX
  await runScenario(2, 'ADMIN explicit VTX resolves correctly', async () => {
    mockClientState.customRows = [{ total_documents: '5', active_count: '4' }];
    const res = await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'VTX' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.scope.company_id, 'VTX');
    assert.strictEqual(res.scope.branch, 'vietranstimex');
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.documents'));
    assert.strictEqual(appQuery.params[0], 'VTX');
    assert.strictEqual(appQuery.params[1], 'vietranstimex');
  });

  // Scenario 3: ADMIN explicit SWC
  await runScenario(3, 'ADMIN explicit SWC resolves correctly', async () => {
    mockClientState.customRows = [{ total_documents: '7', active_count: '6' }];
    const res = await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'SWC' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.scope.company_id, 'SWC');
    assert.strictEqual(res.scope.branch, 'sowatco');
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.documents'));
    assert.strictEqual(appQuery.params[0], 'SWC');
    assert.strictEqual(appQuery.params[1], 'sowatco');
  });

  // Scenario 4: ADMIN explicit ALL
  await runScenario(4, 'ADMIN explicit ALL resolves correctly without company filter', async () => {
    mockClientState.customRows = [{ total_documents: '22', active_count: '18' }];
    const res = await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.scope.company_id, 'ALL');
    assert.strictEqual(res.scope.branch, 'all');
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.documents'));
    assert.strictEqual(appQuery.params[0], 'ALL');
    assert.strictEqual(appQuery.params[1], 'all');
  });

  // Scenario 5: ADMIN thiếu companyId bị chặn, không query
  await runScenario(5, 'ADMIN missing companyId is blocked with 400 and no query', async () => {
    let threw = false;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        {},
        { user_id: 1, username: 'admin', role: 'ADMIN' }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.code, 'MISSING_ADMIN_TENANT');
    }
    assert.ok(threw, 'Should throw error when options.companyId is missing');
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 6: ADMIN companyId rỗng bị chặn, không query
  await runScenario(6, 'ADMIN empty companyId is blocked with 400 and no query', async () => {
    let threw = false;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: '   ' },
        { user_id: 1, username: 'admin', role: 'ADMIN' }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.code, 'MISSING_ADMIN_TENANT');
    }
    assert.ok(threw, 'Should throw error when options.companyId is empty/whitespace');
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 7: ADMIN companyId không hợp lệ bị chặn, không query
  await runScenario(7, 'ADMIN invalid companyId triggers 400 and tamper block', async () => {
    let threw = false;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: 'UNKNOWN_COMPANY' },
        { user_id: 1, username: 'admin', role: 'ADMIN' }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.code, 'INVALID_ADMIN_TENANT');
    }
    assert.ok(threw, 'Should throw error when options.companyId is not in whitelist');
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 8: HR chỉ dùng company_id từ userContext
  await runScenario(8, 'HR tenant strictly resolved from userContext.company_id', async () => {
    mockClientState.customRows = [{ total_batches: '5', total_files_uploaded: '10', avg_files_per_batch: '2.0' }];
    const res = await analyticsEngine.computeKPI(
      'INTAKE_UPLOADS',
      {},
      { user_id: 2, username: 'hr_vtx', role: 'HR', company_id: 'VTX' }
    );
    assert.strictEqual(res.scope.company_id, 'VTX');
    assert.strictEqual(res.scope.branch, 'vietranstimex');
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.hr_intake_batches'));
    assert.strictEqual(appQuery.params[0], 'VTX');
  });

  // Scenario 9: HR không thể override tenant bằng options
  await runScenario(9, 'HR options.companyId is completely ignored in favor of userContext', async () => {
    mockClientState.customRows = [{ total_batches: '3', total_files_uploaded: '6', avg_files_per_batch: '2.0' }];
    const res = await analyticsEngine.computeKPI(
      'INTAKE_UPLOADS',
      { companyId: 'SWC' }, // Client tries to override with SWC
      { user_id: 3, username: 'hr_stl', role: 'HR', company_id: 'STL' } // User is STL
    );
    assert.strictEqual(res.scope.company_id, 'STL', 'Effective tenant must remain STL');
    assert.strictEqual(res.scope.branch, 'sotrans_logistics');
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.hr_intake_batches'));
    assert.strictEqual(appQuery.params[0], 'STL', 'SQL must be bound to authenticated company STL');
  });

  // Scenario 10: EMPLOYEE và USER/Guest bị chặn
  await runScenario(10, 'EMPLOYEE, USER, and unauthenticated callers are blocked', async () => {
    // Unauthenticated
    let errUnauth = null;
    try {
      await analyticsEngine.computeKPI('DOC_TOTAL', { companyId: 'STL' }, null);
    } catch (e) {
      errUnauth = e;
    }
    assert.ok(errUnauth, 'Unauthenticated caller must throw');
    assert.strictEqual(errUnauth.statusCode, 401);

    // EMPLOYEE
    let errEmployee = null;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: 'STL' },
        { user_id: 4, username: 'emp1', role: 'EMPLOYEE' }
      );
    } catch (e) {
      errEmployee = e;
    }
    assert.ok(errEmployee, 'EMPLOYEE caller must throw');
    assert.strictEqual(errEmployee.statusCode, 403);

    // USER
    let errUser = null;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: 'STL' },
        { user_id: 5, username: 'usr1', role: 'USER' }
      );
    } catch (e) {
      errUser = e;
    }
    assert.ok(errUser, 'USER caller must throw');
    assert.strictEqual(errUser.statusCode, 403);
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 11: INACTIVE bị chặn nếu trạng thái được cung cấp trong userContext
  await runScenario(11, 'INACTIVE and LOCKED userContext statuses are blocked with 403', async () => {
    // INACTIVE HR
    let errInactive = null;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        {},
        { user_id: 6, username: 'duongminh', role: 'HR', company_id: 'STL', status: 'INACTIVE' }
      );
    } catch (e) {
      errInactive = e;
    }
    assert.ok(errInactive, 'INACTIVE user must throw');
    assert.strictEqual(errInactive.statusCode, 403);
    assert.strictEqual(errInactive.code, 'ACCOUNT_INACTIVE');

    // LOCKED ADMIN
    let errLocked = null;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: 'ALL' },
        { user_id: 7, username: 'admin_locked', role: 'ADMIN', status: 'LOCKED' }
      );
    } catch (e) {
      errLocked = e;
    }
    assert.ok(errLocked, 'LOCKED user must throw');
    assert.strictEqual(errLocked.statusCode, 403);
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 12: Branch scope áp dụng đúng cho documents
  await runScenario(12, 'Branch scope uses @> array overlap with {all} fallback in documents SQL', async () => {
    mockClientState.customRows = [{ total_documents: '10', active_count: '8' }];
    await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'STL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.documents'));
    assert.ok(appQuery.sql.includes("branch_scope @> '{all}'"), 'Must include branch_scope @> {all}');
    assert.ok(appQuery.sql.includes('branch_scope @> ARRAY[$2]::text[]'), 'Must include branch_scope array check');
    assert.strictEqual(appQuery.params[1], 'sotrans_logistics');
  });

  // Scenario 13: KPI 8 không đếm nhân bản batch
  await runScenario(13, 'KPI 8 uses CTE aggregation to prevent batch duplication', async () => {
    mockClientState.customRows = [{
      total_batches: '114',
      completed_batches: '100',
      ocr_completed_batches: '14',
      converted_batches_all_status: '73',
      conversion_rate_all_status: '64.04',
      converted_completed_batches: '73',
      conversion_rate_completed_only: '73.00',
      same_company_converted_batches: '70',
      cross_company_converted_batches: '3',
      same_company_staging_records: '93',
      cross_company_staging_records: '10',
    }];
    const res = await analyticsEngine.computeKPI(
      'INTAKE_SUCCESS',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    const appQuery = mockClientState.queries.find(q => q.sql.includes('WITH batch_scope AS'));
    assert.ok(appQuery, 'Must use batch_scope CTE');
    assert.ok(appQuery.sql.includes('GROUP BY s.batch_id'), 'Must aggregate staging by batch_id');
    assert.strictEqual(res.data.total_batches, 114);
    assert.strictEqual(res.data.converted_batches_all_status, 73);
    assert.strictEqual(res.data.conversion_rate_all_status, 64.04);
  });

  // Scenario 14: KPI 8 phân biệt cùng công ty và khác công ty
  await runScenario(14, 'KPI 8 distinguishes same-company vs cross-company conversion', async () => {
    mockClientState.customRows = [{
      total_batches: '114',
      completed_batches: '100',
      ocr_completed_batches: '14',
      converted_batches_all_status: '73',
      conversion_rate_all_status: '64.04',
      converted_completed_batches: '73',
      conversion_rate_completed_only: '73.00',
      same_company_converted_batches: '70',
      cross_company_converted_batches: '3',
      same_company_staging_records: '93',
      cross_company_staging_records: '10',
    }];
    const res = await analyticsEngine.computeKPI(
      'INTAKE_SUCCESS',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.data.same_company_staging_records, 93);
    assert.strictEqual(res.data.cross_company_staging_records, 10);
    assert.ok(Array.isArray(res.warnings), 'Must include warnings array');
    assert.ok(res.warnings.length >= 2, 'Must include business explanations in warnings');
  });

  // Scenario 15: KPI 9 trả DATA_UNAVAILABLE
  await runScenario(15, 'KPI 9 (INTAKE_FAILURE) returns DATA_UNAVAILABLE with no DB call', async () => {
    const res = await analyticsEngine.computeKPI(
      'INTAKE_FAILURE',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.status, 'DATA_UNAVAILABLE');
    assert.strictEqual(res.data, null);
    assert.ok(res.reason.includes('Gateway/Middleware'));
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 16: KPI 10 trả DATA_UNAVAILABLE
  await runScenario(16, 'KPI 10 (INTAKE_DURATION) returns DATA_UNAVAILABLE with no DB call', async () => {
    const res = await analyticsEngine.computeKPI(
      'INTAKE_DURATION',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.status, 'DATA_UNAVAILABLE');
    assert.strictEqual(res.data, null);
    assert.ok(res.reason.includes('created_at = updated_at'));
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 17: KPI 12 trả DATA_UNAVAILABLE
  await runScenario(17, 'KPI 12 (POLICY_CONFLICT) returns DATA_UNAVAILABLE with no DB call', async () => {
    const res = await analyticsEngine.computeKPI(
      'POLICY_CONFLICT',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.status, 'DATA_UNAVAILABLE');
    assert.strictEqual(res.data, null);
    assert.ok(res.reason.includes('policyConflictDetector.js'));
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No DB client was requested');
  });

  // Scenario 18: KPI 13 tách ba góc nhìn
  await runScenario(18, 'KPI 13 splits current_pending_queue, approval_activity, and rejection_activity', async () => {
    mockClientState.customRows = [{
      current_pending_queue: '101',
      approval_activity: '42',
      rejection_activity: '5',
    }];
    const res = await analyticsEngine.computeKPI(
      'APPROVAL_QUEUE',
      { companyId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-13' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.data.current_pending_queue, 101);
    assert.strictEqual(res.data.approval_activity, 42);
    assert.strictEqual(res.data.rejection_activity, 5);
    const appQuery = mockClientState.queries.find(q => q.sql.includes('staging_status = \'pending_review\''));
    assert.ok(appQuery, 'Query must look up pending review');
    assert.ok(appQuery.sql.includes('reviewed_at'), 'Must use reviewed_at for rejection');
    assert.ok(!appQuery.sql.includes('rejected_at'), 'Must NOT use non-existent rejected_at');
  });

  // Scenario 19: KPI 14 trả đầy đủ sample counts
  await runScenario(19, 'KPI 14 returns measured_docs, total_docs, missing_docs, and quality', async () => {
    mockClientState.customRows = [{
      total_docs: '9',
      measured_docs: '5',
      missing_docs: '4',
      avg_doc_parse_quality: '98.00',
    }];
    const res = await analyticsEngine.computeKPI(
      'OCR_QUALITY',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.status, 'PARTIALLY_AVAILABLE');
    assert.strictEqual(res.data.measured_docs, 5);
    assert.strictEqual(res.data.total_docs, 9);
    assert.strictEqual(res.data.missing_docs, 4);
    assert.strictEqual(res.data.avg_doc_parse_quality, 98.0);
    assert.strictEqual(res.data.sub_metric_hr_profile_ocr.status, 'DATA_UNAVAILABLE');
  });

  // Scenario 20: KPI 17 trả similarity_sample_count độc lập với eligible_rag_queries
  await runScenario(20, 'KPI 17 counts similarity_sample_count independently from eligible_rag_queries', async () => {
    mockClientState.customRows = [{
      eligible_rag_queries: '485',
      answerable_count: '348',
      similarity_sample_count: '481',
      avg_vector_similarity: '0.7570',
      answerability_rate: '71.75',
    }];
    const res = await analyticsEngine.computeKPI(
      'RAG_ANSWERABLE',
      { companyId: 'ALL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.data.eligible_rag_queries, 485);
    assert.strictEqual(res.data.answerable_count, 348);
    assert.strictEqual(res.data.similarity_sample_count, 481);
    assert.strictEqual(res.data.avg_vector_similarity, 0.757);
    assert.strictEqual(res.data.answerability_rate, 71.75);
    assert.strictEqual(res.data.sub_metric_latency.status, 'DATA_UNAVAILABLE');
  });

  // Scenario 21: Date parsing và endExclusive đúng
  await runScenario(21, 'Date range converts end date into inclusive calendar next day endExclusive', async () => {
    mockClientState.customRows = [{ total_batches: '1', total_files_uploaded: '1', avg_files_per_batch: '1.0' }];
    const res = await analyticsEngine.computeKPI(
      'INTAKE_UPLOADS',
      { companyId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-13' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(res.period.start, '2026-11-01');
    assert.strictEqual(res.period.end_exclusive, '2026-11-14');
  });

  // Scenario 22: DATE không bị chuyển timezone
  await runScenario(22, 'Pure DATE queries receive YYYY-MM-DD without timestamp offset', async () => {
    mockClientState.customRows = [{ period: '2026-11', doc_count: '5' }];
    await analyticsEngine.computeKPI(
      'DOC_BY_EFFECTIVE_DATE',
      { companyId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-13' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    const appQuery = mockClientState.queries.find(q => q.sql.includes('effective_date'));
    assert.strictEqual(appQuery.params[0], '2026-11-01');
    assert.strictEqual(appQuery.params[1], '2026-11-14');
  });

  // Scenario 23: TIMESTAMPTZ sử dụng offset +07:00
  await runScenario(23, 'TIMESTAMPTZ queries receive ISO string with +07:00 offset', async () => {
    mockClientState.customRows = [{ total_batches: '1', total_files_uploaded: '1', avg_files_per_batch: '1.0' }];
    await analyticsEngine.computeKPI(
      'INTAKE_UPLOADS',
      { companyId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-13' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    const appQuery = mockClientState.queries.find(q => q.sql.includes('public.hr_intake_batches'));
    assert.strictEqual(appQuery.params[1], '2026-11-01T00:00:00+07:00');
    assert.strictEqual(appQuery.params[2], '2026-11-14T00:00:00+07:00');
  });

  // Scenario 24: Read-only transaction được mở và commit/rollback đúng
  await runScenario(24, 'Read-only transaction begins READ ONLY, commits on success, rollbacks on error', async () => {
    // 1. Success case
    mockClientState.customRows = [{ total_documents: '5', active_count: '5' }];
    await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'STL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.ok(mockClientState.isReadOnly, 'Must execute BEGIN TRANSACTION READ ONLY');
    assert.ok(mockClientState.isCommitted, 'Must execute COMMIT on success');
    assert.strictEqual(mockClientState.releaseCount, 1, 'Client must be released');

    // 2. Error case
    resetMockState();
    mockClientState.shouldThrowOnQuery = new Error('Database disk error');
    let threw = false;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: 'STL' },
        { user_id: 1, username: 'admin', role: 'ADMIN' }
      );
    } catch (_) {
      threw = true;
    }
    assert.ok(threw, 'Should throw original error');
    assert.ok(mockClientState.isRolledBack, 'Must execute ROLLBACK on query error');
    assert.strictEqual(mockClientState.releaseCount, 1, 'Client must be released even after error');
  });

  // Scenario 25: Statement timeout được thiết lập 3000ms
  await runScenario(25, 'Transaction enforces SET LOCAL statement_timeout = 3000ms', async () => {
    mockClientState.customRows = [{ total_documents: '1', active_count: '1' }];
    await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'STL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(mockClientState.timeoutSet, "SET LOCAL statement_timeout = '3000ms'");
  });

  // Scenario 26: Transaction timezone được thiết lập Asia/Ho_Chi_Minh
  await runScenario(26, 'Transaction enforces SET LOCAL TIME ZONE Asia/Ho_Chi_Minh', async () => {
    mockClientState.customRows = [{ total_documents: '1', active_count: '1' }];
    await analyticsEngine.computeKPI(
      'DOC_TOTAL',
      { companyId: 'STL' },
      { user_id: 1, username: 'admin', role: 'ADMIN' }
    );
    assert.strictEqual(mockClientState.timezoneSet, "SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh'");
  });

  // Scenario 27: Client luôn release khi có lỗi
  await runScenario(27, 'Client is released exactly once and never leaked on exceptions', async () => {
    mockClientState.shouldThrowOnQuery = new Error('Timeout 3000ms exceeded');
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: 'STL' },
        { user_id: 1, username: 'admin', role: 'ADMIN' }
      );
    } catch (_) {}
    assert.strictEqual(mockClientState.releaseCount, 1, 'release() must be called exactly once in finally block');
  });

  // Scenario 28: SQL không nhận input tùy ý
  await runScenario(28, 'Zero runtime dynamic string concatenation for SQL statements', async () => {
    let threw = false;
    try {
      await analyticsEngine.computeKPI(
        'DOC_TOTAL',
        { companyId: "STL'; DROP TABLE users;--" },
        { user_id: 1, username: 'admin', role: 'ADMIN' }
      );
    } catch (e) {
      threw = true;
      assert.strictEqual(e.statusCode, 400);
    }
    assert.ok(threw, 'Malicious SQL input in tenant must be caught by validation');
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'No query executed');
  });

  // Scenario 29: Không export generic SQL executor
  await runScenario(29, 'Analytics Engine strictly does NOT export generic SQL executor', async () => {
    assert.strictEqual(typeof analyticsEngine.computeKPI, 'function');
    assert.strictEqual(typeof analyticsEngine.getSummaryKPIs, 'function');
    assert.strictEqual(typeof analyticsEngine.getDocumentKPIs, 'function');
    assert.strictEqual(typeof analyticsEngine.getIntakeQualityKPIs, 'function');
    assert.strictEqual(typeof analyticsEngine.getRagHealthKPIs, 'function');
    assert.strictEqual(analyticsEngine.executeQuery, undefined);
    assert.strictEqual(analyticsEngine.runReadOnlyQuery, undefined);
    assert.strictEqual(analyticsEngine.executeSafeReadOnlyQuery, undefined);
    assert.strictEqual(analyticsEngine.query, undefined);
  });

  // Scenario 30: Blocked KPI không mở kết nối database
  await runScenario(30, 'All 3 BLOCKED KPIs bypass database connection completely', async () => {
    await analyticsEngine.computeKPI('INTAKE_FAILURE', { companyId: 'ALL' }, { user_id: 1, role: 'ADMIN' });
    await analyticsEngine.computeKPI('INTAKE_DURATION', { companyId: 'ALL' }, { user_id: 1, role: 'ADMIN' });
    await analyticsEngine.computeKPI('POLICY_CONFLICT', { companyId: 'ALL' }, { user_id: 1, role: 'ADMIN' });
    assert.strictEqual(mockClientState.getClientCallCount, 0, 'Zero DB client connections acquired for blocked KPIs');
  });

  // ==========================================================================
  // FINAL SUMMARY REPORT
  // ==========================================================================
  console.log('\n================================================================');
  console.log(`TEST EXECUTION SUMMARY: ${passCount} / 30 PASS | ${failCount} FAIL`);
  console.log('Production Environment Connection: NONE (Verified Unit Mock)');
  console.log('Integration Test Execution: SKIPPED (Awaiting dedicated test DB)');
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Execute suite
runAllTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
