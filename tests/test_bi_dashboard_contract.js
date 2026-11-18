/**
 * SOTRANS HUB — PHASE P1.0 DASHBOARD PAYLOAD CONTRACT V2 TEST SUITE
 * 
 * Comprehensive Test Suite for Dashboard Payload Contract v2.0 & Schema Validator:
 * - Group A: Valid Contract (Internal System BI & File BI, single/multi KPI, single/multi Viz, data_store)
 * - Group B: Invalid Contract (Missing fields, bad version, bad chart_type, dup IDs, bad data_ref/mapping, size limit, script injection)
 * - Group C: KPI Status (AVAILABLE, CONDITIONAL, BLOCKED, DATA_UNAVAILABLE, null values, no fake zeros)
 * - Group D: Security & Authorization (Zero PII, zero credentials, tenant boundary protection, zero executable code)
 * - Group E: Backward Compatibility (bi-report code block preserved, File BI SVG preserved, no duplicate widgets)
 */

const assert = require('assert');
const {
  validateDashboardPayload,
  assertValidDashboardPayload,
  DashboardValidationError,
  ALLOWED_SOURCE_TYPES,
  ALLOWED_CHART_TYPES,
  ALLOWED_KPI_STATUSES,
  MAX_PAYLOAD_SIZE_BYTES,
  MAX_KPIS,
  MAX_VISUALIZATIONS,
  MAX_DATA_TABLES,
} = require('../auth-service/services/biDashboardSchemaValidator');

const {
  formatBIDashboardPayload,
  formatBIReportMarkdown,
} = require('../auth-service/services/biReportingHelper');

const {
  formatDatasetDashboardPayload,
  formatAnalyticalResultMarkdown,
} = require('../auth-service/services/biDatasetPresenter');

// Mock User Contexts
const USER_ADMIN = { user_id: 'usr_admin', username: 'admin_sys', role: 'ADMIN', company_id: 'ALL' };
const USER_HR_STL = { user_id: 'usr_hr_stl', username: 'hr_stl', role: 'HR', company_id: 'STL' };
const USER_HR_VTX = { user_id: 'usr_hr_vtx', username: 'hr_vtx', role: 'HR', company_id: 'VTX' };
const USER_EMPLOYEE = { user_id: 'usr_emp', username: 'employee_a', role: 'EMPLOYEE', company_id: 'STL' };

// Test Runner
let passCount = 0;
let failCount = 0;
const results = [];

async function test(scenarioId, title, testFn) {
  try {
    await testFn();
    passCount++;
    console.log(`[PASS] [${scenarioId}] ${title}`);
    results.push({ scenarioId, title, status: 'PASS' });
  } catch (err) {
    failCount++;
    console.error(`[FAIL] [${scenarioId}] ${title} -> ${err.message}`);
    results.push({ scenarioId, title, status: 'FAIL', error: err.message });
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('SOTRANS HUB — P1.0 DASHBOARD PAYLOAD CONTRACT V2 TEST SUITE');
  console.log('Target: Self-Describing Dashboard Schema Validator & Adapters');
  console.log('Mode: Isolated Mock Unit & Integration Testing (NO DB WRITES)');
  console.log('================================================================\n');

  // ============================================================================
  // GROUP A: VALID CONTRACT (INTERNAL & FILE BI)
  // ============================================================================
  console.log('--- GROUP A: VALID CONTRACT SPECIFICATIONS ---');

  await test('A01', 'Internal System BI generates fully valid Dashboard Payload v2', async () => {
    const mockBiResult = {
      success: true,
      companyId: 'STL',
      periodLabel: 'Tháng 01/2026',
      results: [
        {
          kpi: 'DOC_TOTAL',
          status: 'AVAILABLE',
          data: { total_documents: 150 },
          metadata: { source_tables: ['public.documents'] },
        },
        {
          kpi: 'DOC_STATUS',
          status: 'AVAILABLE',
          data: {
            items: [
              { document_status: 'Hiệu lực', total_count: 120, ratio_percent: 80.0 },
              { document_status: 'Hết hiệu lực', total_count: 30, ratio_percent: 20.0 },
            ],
          },
          metadata: { source_tables: ['public.documents'] },
        },
      ],
    };

    const payload = formatBIDashboardPayload(mockBiResult, USER_HR_STL);
    assert.strictEqual(payload.version, '2.0');
    assert.strictEqual(payload.source_type, 'INTERNAL_SYSTEM');
    assert.strictEqual(payload.provenance.tenant_scope, 'STL');
    assert.strictEqual(payload.kpi_strip.length, 2);
    assert.strictEqual(payload.kpi_strip[0].primary_value, 150);
    assert.strictEqual(payload.visualizations.length, 1);
    assert.strictEqual(payload.visualizations[0].chart_type, 'PIE');
    assert.ok(payload.data_store.kpi_doc_status_data);

    const validation = validateDashboardPayload(payload, USER_HR_STL);
    assert.strictEqual(validation.valid, true, 'Must validate successfully');
  });

  await test('A02', 'Uploaded File BI generates fully valid Dashboard Payload v2', async () => {
    const mockPlan = {
      target_sheet: 'HR_Sheet',
      groupBy: ['phong_ban'],
      aggregations: [{ column: 'ma_nhan_vien', func: 'DISTINCT_COUNT', alias: 'distinct_count_ma_nhan_vien' }],
      filters: [],
      chart_preference: 'PIE',
      intent: 'DISTRIBUTION',
    };

    const mockQueryResult = {
      results: [
        { phong_ban: 'Nhân Sự', distinct_count_ma_nhan_vien: 15 },
        { phong_ban: 'Vận Tải', distinct_count_ma_nhan_vien: 35 },
        { phong_ban: 'Kế Toán', distinct_count_ma_nhan_vien: 10 },
      ],
      rows_scanned: 60,
      execution_stats: { execution_time_ms: 3 },
    };

    const mockDataset = {
      file_id: 'ds_file_test_001',
      original_filename: 'NhanSu_Logistics.xlsx',
      columns: [
        { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING' },
        { key: 'ma_nhan_vien', name: 'Mã NV', type: 'STRING' },
      ],
    };

    const payload = formatDatasetDashboardPayload(mockPlan, mockQueryResult, mockDataset);
    assert.strictEqual(payload.version, '2.0');
    assert.strictEqual(payload.source_type, 'FILE_DATASET');
    assert.strictEqual(payload.kpi_strip.length, 1);
    assert.strictEqual(payload.kpi_strip[0].primary_value, 60); // 15 + 35 + 10 = 60
    assert.strictEqual(payload.visualizations.length, 1);
    assert.strictEqual(payload.visualizations[0].chart_type, 'PIE');
    assert.strictEqual(payload.visualizations[0].mapping.category, 'phong_ban');
    assert.strictEqual(payload.visualizations[0].mapping.value, 'distinct_count_ma_nhan_vien');

    const validation = validateDashboardPayload(payload);
    assert.strictEqual(validation.valid, true);
  });

  await test('A03', 'Single KPI & Zero Visualizations is a valid minimal Dashboard', async () => {
    const minimalPayload = {
      version: '2.0',
      dashboard_id: 'dash_min_001',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Báo cáo tối giản',
      generated_at: new Date().toISOString(),
      provenance: { source_system: 'SOTRANS Hub', generated_by: 'Analytics Engine' },
      filters: { current_state: {}, supported_dimensions: [] },
      kpi_strip: [
        {
          id: 'kpi_min_1',
          kpi_code: 'DOC_TOTAL',
          title: 'Tổng số văn bản',
          primary_value: 45,
          format: 'NUMBER',
          unit: 'văn bản',
          status: 'AVAILABLE',
          subtext: 'Hoạt động bình thường',
        },
      ],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const validation = validateDashboardPayload(minimalPayload);
    assert.strictEqual(validation.valid, true);
  });

  await test('A04', 'Multi-KPI and Multiple Visualizations (BAR, LINE, PIE) validate successfully', async () => {
    const multiPayload = {
      version: '2.0',
      dashboard_id: 'dash_multi_002',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Báo cáo Tổng hợp',
      generated_at: new Date().toISOString(),
      provenance: { source_system: 'SOTRANS Hub', generated_by: 'Analytics Engine' },
      filters: { current_state: {}, supported_dimensions: ['period', 'dept'] },
      kpi_strip: [
        { id: 'k1', kpi_code: 'DOC_TOTAL', title: 'Tổng VB', primary_value: 200, format: 'NUMBER', unit: 'vb', status: 'AVAILABLE' },
        { id: 'k2', kpi_code: 'ACTIVE_USERS', title: 'Người dùng', primary_value: 50, format: 'NUMBER', unit: 'người', status: 'AVAILABLE' },
      ],
      visualizations: [
        { id: 'v1', title: 'Biểu đồ thanh', chart_type: 'BAR', data_ref: 'ds_bar', mapping: { category: 'dept', value: 'amount' } },
        { id: 'v2', title: 'Biểu đồ đường', chart_type: 'LINE', data_ref: 'ds_line', mapping: { x: 'period', y: 'vol' } },
        { id: 'v3', title: 'Biểu đồ tròn', chart_type: 'PIE', data_ref: 'ds_pie', mapping: { category: 'status', value: 'count' } },
      ],
      data_tables: [
        { id: 't1', title: 'Bảng Bar', data_ref: 'ds_bar', columns: [{ key: 'dept', label: 'Phòng' }] },
      ],
      data_store: {
        ds_bar: [{ dept: 'Kho', amount: 100 }, { dept: 'Vận Tải', amount: 200 }],
        ds_line: [{ period: '2026-01', vol: 15 }, { period: '2026-02', vol: 25 }],
        ds_pie: [{ status: 'Active', count: 80 }, { status: 'Draft', count: 20 }],
      },
    };

    const validation = validateDashboardPayload(multiPayload);
    assert.strictEqual(validation.valid, true);
  });

  // ============================================================================
  // GROUP B: INVALID CONTRACT (SCHEMA GUARDS & INTEGRITY)
  // ============================================================================
  console.log('\n--- GROUP B: INVALID CONTRACT & INTEGRITY REJECTIONS ---');

  await test('B01', 'Missing required fields is rejected', async () => {
    const invalidPayload = {
      version: '2.0',
      dashboard_id: 'dash_bad_001',
      // missing source_type, title, kpi_strip, etc.
    };
    const val = validateDashboardPayload(invalidPayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD'));
  });

  await test('B02', 'Unsupported version is rejected', async () => {
    const badVersion = {
      version: '1.0',
      dashboard_id: 'dash_bad_002',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Old Version',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };
    const val = validateDashboardPayload(badVersion);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'UNSUPPORTED_VERSION'));
  });

  await test('B03', 'Invalid source_type is rejected', async () => {
    const badSource = {
      version: '2.0',
      dashboard_id: 'dash_bad_003',
      source_type: 'RANDOM_DATABASE',
      title: 'Bad Source',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };
    const val = validateDashboardPayload(badSource);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'INVALID_SOURCE_TYPE'));
  });

  await test('B04', 'Invalid chart_type is rejected', async () => {
    const badChart = {
      version: '2.0',
      dashboard_id: 'dash_bad_004',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Bad Chart',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [
        { id: 'v1', title: 'Radar Chart', chart_type: 'RADAR_UNSUPPORTED', data_ref: 'ds1', mapping: {} },
      ],
      data_tables: [],
      data_store: { ds1: [] },
    };
    const val = validateDashboardPayload(badChart);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'INVALID_CHART_TYPE'));
  });

  await test('B05', 'Duplicate IDs in KPIs or Visualizations are rejected', async () => {
    const dupPayload = {
      version: '2.0',
      dashboard_id: 'dash_bad_005',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Duplicate IDs',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [
        { id: 'dup_kpi', kpi_code: 'DOC_TOTAL', title: 'T1', primary_value: 10, status: 'AVAILABLE' },
        { id: 'dup_kpi', kpi_code: 'ACTIVE_USERS', title: 'T2', primary_value: 20, status: 'AVAILABLE' },
      ],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };
    const val = validateDashboardPayload(dupPayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'DUPLICATE_KPI_ID'));
  });

  await test('B06', 'Missing data_ref or data_ref pointing to non-existent dataset is rejected', async () => {
    const missingRefPayload = {
      version: '2.0',
      dashboard_id: 'dash_bad_006',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Missing Ref',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [
        { id: 'v1', title: 'Ghost Viz', chart_type: 'BAR', data_ref: 'ghost_data_ref', mapping: { category: 'a', value: 'b' } },
      ],
      data_tables: [],
      data_store: { real_data_ref: [{ a: '1', b: 2 }] },
    };
    const val = validateDashboardPayload(missingRefPayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'DATA_REF_NOT_FOUND'));
  });

  await test('B07', 'Mapping field not found in referenced dataset is rejected', async () => {
    const missingFieldPayload = {
      version: '2.0',
      dashboard_id: 'dash_bad_007',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Missing Field',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [
        { id: 'v1', title: 'Bar Viz', chart_type: 'BAR', data_ref: 'ds_test', mapping: { category: 'non_existent_col', value: 'val' } },
      ],
      data_tables: [],
      data_store: { ds_test: [{ existing_col: 'ABC', val: 123 }] },
    };
    const val = validateDashboardPayload(missingFieldPayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'MAPPING_FIELD_NOT_FOUND'));
  });

  await test('B08', 'Payload exceeding 1MB size limit is rejected', async () => {
    const largeRows = [];
    for (let i = 0; i < 400; i++) {
      largeRows.push({
        id: `row_${i}`,
        description: 'A'.repeat(3000), // ~1.2 MB total
      });
    }

    const hugePayload = {
      version: '2.0',
      dashboard_id: 'dash_huge',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Huge Payload',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [],
      data_tables: [],
      data_store: { huge_store: largeRows },
    };

    const val = validateDashboardPayload(hugePayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'PAYLOAD_SIZE_EXCEEDED'));
  });

  await test('B09', 'Script injection / Executable code inside title or data is blocked', async () => {
    const maliciousPayload = {
      version: '2.0',
      dashboard_id: 'dash_xss',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Báo cáo <script>alert("hacked")</script>',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const val = validateDashboardPayload(maliciousPayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'EXECUTABLE_CODE_BLOCKED'));
  });

  // ============================================================================
  // GROUP C: KPI STATUS INTEGRITY (NO FAKE ZEROS)
  // ============================================================================
  console.log('\n--- GROUP C: KPI STATUS INTEGRITY ---');

  await test('C01', 'BLOCKED KPI retains null primary_value and requires subtext reason', async () => {
    const blockedPayload = {
      version: '2.0',
      dashboard_id: 'dash_blocked',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Blocked Test',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [
        {
          id: 'kpi_blocked',
          kpi_code: 'INTAKE_TIME',
          title: 'Thời gian hoàn tất trung bình',
          primary_value: null,
          format: 'NUMBER',
          unit: 'giờ',
          status: 'BLOCKED',
          subtext: 'Bị khóa do thiếu cột completed_at trong cơ sở dữ liệu.',
        },
      ],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const val = validateDashboardPayload(blockedPayload);
    assert.strictEqual(val.valid, true, 'BLOCKED KPI with null value and subtext must be valid');
    assert.strictEqual(blockedPayload.kpi_strip[0].primary_value, null, 'Must NOT be converted to fake 0');
  });

  await test('C02', 'CONDITIONAL KPI holds warning subtext with valid calculated value', async () => {
    const condPayload = {
      version: '2.0',
      dashboard_id: 'dash_cond',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Conditional Test',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [
        {
          id: 'kpi_cond',
          kpi_code: 'INTAKE_SUCCESS',
          title: 'Tỷ lệ chuyển đổi hồ sơ',
          primary_value: 85.5,
          format: 'PERCENTAGE',
          unit: '%',
          status: 'CONDITIONAL',
          subtext: 'Cảnh báo: Tính toán dựa trên các lô trạng thái completed.',
        },
      ],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const val = validateDashboardPayload(condPayload);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(condPayload.kpi_strip[0].status, 'CONDITIONAL');
  });

  await test('C03', 'DATA_UNAVAILABLE KPI does not accept arbitrary fake number without explanation', async () => {
    const badUnavailablePayload = {
      version: '2.0',
      dashboard_id: 'dash_unavail',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Unavailable Test',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [
        {
          id: 'kpi_unavail',
          kpi_code: 'DOC_SPEED',
          title: 'Tốc độ',
          primary_value: null,
          status: 'DATA_UNAVAILABLE',
          // missing subtext / reason
        },
      ],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const val = validateDashboardPayload(badUnavailablePayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'MISSING_BLOCKED_REASON'));
  });

  // ============================================================================
  // GROUP D: SECURITY & MULTI-TENANT AUTHORIZATION
  // ============================================================================
  console.log('\n--- GROUP D: SECURITY & TENANT AUTHORIZATION ---');

  await test('D01', 'PII / Sensitive credentials inside payload are strictly blocked', async () => {
    const piiPayload = {
      version: '2.0',
      dashboard_id: 'dash_pii',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Leaked PII',
      generated_at: new Date().toISOString(),
      provenance: {},
      filters: {},
      kpi_strip: [],
      visualizations: [],
      data_tables: [],
      data_store: {
        users: [{ username: 'admin', password: 'plain_password_123' }],
      },
    };

    const val = validateDashboardPayload(piiPayload);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'PII_CREDENTIAL_BLOCKED'));
  });

  await test('D02', 'EMPLOYEE role is rejected from accessing Internal System BI Dashboard', async () => {
    const sysPayload = {
      version: '2.0',
      dashboard_id: 'dash_rbac_1',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Admin Report',
      generated_at: new Date().toISOString(),
      provenance: { source_system: 'SOTRANS Hub', generated_by: 'Analytics Engine', tenant_scope: 'ALL' },
      filters: {},
      kpi_strip: [],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const val = validateDashboardPayload(sysPayload, USER_EMPLOYEE);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'UNAUTHORIZED_DASHBOARD_ACCESS'));
  });

  await test('D03', 'HR user cannot access dashboard of another tenant (Tenant Boundary)', async () => {
    const vtxPayload = {
      version: '2.0',
      dashboard_id: 'dash_rbac_vtx',
      source_type: 'INTERNAL_SYSTEM',
      title: 'VTX Report',
      generated_at: new Date().toISOString(),
      provenance: { source_system: 'SOTRANS Hub', generated_by: 'Analytics Engine', tenant_scope: 'VTX' },
      filters: { current_state: { company_id: 'VTX' } },
      kpi_strip: [],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    // User is HR STL -> Must be rejected with TENANT_BOUNDARY_VIOLATION
    const val = validateDashboardPayload(vtxPayload, USER_HR_STL);
    assert.strictEqual(val.valid, false);
    assert.ok(val.errors.some((e) => e.code === 'TENANT_BOUNDARY_VIOLATION'));

    // User is HR VTX -> Must be accepted
    const valOk = validateDashboardPayload(vtxPayload, USER_HR_VTX);
    assert.strictEqual(valOk.valid, true);

    // User is ADMIN -> Must be accepted
    const valAdmin = validateDashboardPayload(vtxPayload, USER_ADMIN);
    assert.strictEqual(valAdmin.valid, true);
  });

  // ============================================================================
  // GROUP E: BACKWARD COMPATIBILITY
  // ============================================================================
  console.log('\n--- GROUP E: BACKWARD COMPATIBILITY ---');

  await test('E01', 'formatBIReportMarkdown preserves bi-report codeblock while embedding bi-dashboard-v2', async () => {
    const mockExecution = {
      results: [
        {
          kpi: 'DOC_TOTAL',
          status: 'AVAILABLE',
          data: { total_documents: 88 },
          metadata: { source_tables: ['public.documents'] },
        },
      ],
      companyId: 'STL',
      periodLabel: 'Hôm nay',
    };

    const markdown = formatBIReportMarkdown(mockExecution);
    // 1. Must contain ```bi-report code block for existing frontend
    assert.ok(markdown.includes('```bi-report'), 'Must retain existing bi-report codeblock');
    assert.ok(markdown.includes('"kpi": "DOC_TOTAL"'));

    // 2. Must contain <!-- bi-dashboard-v2: ... --> for new contract
    assert.ok(markdown.includes('<!-- bi-dashboard-v2:'), 'Must embed bi-dashboard-v2 comment');

    // 3. Extract and validate embedded dashboard JSON
    const match = markdown.match(/<!-- bi-dashboard-v2:\s*(\{.+?\})\s*-->/s);
    assert.ok(match, 'Dashboard v2 payload must be extracted');
    const parsedPayload = JSON.parse(match[1]);
    assert.strictEqual(parsedPayload.version, '2.0');
    assert.strictEqual(parsedPayload.source_type, 'INTERNAL_SYSTEM');
    assert.strictEqual(parsedPayload.kpi_strip[0].primary_value, 88);

    assertValidDashboardPayload(parsedPayload, USER_HR_STL);
  });

  await test('E02', 'formatAnalyticalResultMarkdown preserves bi-file-report while embedding bi-dashboard-v2', async () => {
    const mockPlan = {
      target_sheet: 'Sheet1',
      groupBy: ['dept'],
      aggregations: [{ column: 'id', func: 'DISTINCT_COUNT', alias: 'distinct_count_id' }],
      chart_preference: 'BAR',
    };
    const mockResult = {
      results: [{ dept: 'IT', distinct_count_id: 12 }],
      rows_scanned: 12,
      execution_stats: { execution_time_ms: 1 },
    };
    const mockDataset = {
      file_id: 'file_001',
      original_filename: 'Test.xlsx',
      columns: [{ key: 'dept', name: 'dept', type: 'STRING' }],
    };

    const markdown = formatAnalyticalResultMarkdown(mockPlan, mockResult, mockDataset);
    // 1. Must retain <!-- bi-file-report: ... -->
    assert.ok(markdown.includes('<!-- bi-file-report:'));

    // 2. Must embed <!-- bi-dashboard-v2: ... -->
    assert.ok(markdown.includes('<!-- bi-dashboard-v2:'));

    const match = markdown.match(/<!-- bi-dashboard-v2:\s*(\{.+?\})\s*-->/s);
    assert.ok(match);
    const parsedPayload = JSON.parse(match[1]);
    assert.strictEqual(parsedPayload.version, '2.0');
    assert.strictEqual(parsedPayload.source_type, 'FILE_DATASET');
    assert.strictEqual(parsedPayload.kpi_strip[0].primary_value, 12);

    assertValidDashboardPayload(parsedPayload);
  });

  // ============================================================================
  // GROUP F: GATE A INTEGRITY REFINEMENTS (HYBRID REJECTION, COMMENT ESCAPING, PII MASKING)
  // ============================================================================
  console.log('\n--- GROUP F: GATE A INTEGRITY ENHANCEMENTS ---');

  await test('F01', 'Source type HYBRID is strictly rejected before Unified BI (P2.0+)', async () => {
    const hybridPayload = {
      version: '2.0',
      dashboard_id: 'dash_hybrid_001',
      source_type: 'HYBRID',
      title: 'Unified Hybrid Dashboard',
      generated_at: new Date().toISOString(),
      provenance: { source_system: 'SOTRANS Hub', generated_by: 'Unified Engine' },
      filters: {},
      kpi_strip: [{ id: 'kpi_1', kpi_code: 'TEST', title: 'Test', primary_value: 10, status: 'AVAILABLE' }],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const res = validateDashboardPayload(hybridPayload);
    assert.strictEqual(res.valid, false, 'HYBRID must be rejected');
    assert.ok(res.errors.some((e) => e.code === 'RESERVED_SOURCE_TYPE_HYBRID'));
  });

  await test('F02', 'BLOCKED KPI with non-null primary_value is strictly rejected (no fake values)', async () => {
    const fakeBlockedPayload = {
      version: '2.0',
      dashboard_id: 'dash_fake_blocked_001',
      source_type: 'INTERNAL_SYSTEM',
      title: 'Fake Blocked Test',
      generated_at: new Date().toISOString(),
      provenance: { source_system: 'SOTRANS Hub', generated_by: 'Analytics Engine' },
      filters: {},
      kpi_strip: [
        {
          id: 'kpi_fake_1',
          kpi_code: 'INTAKE_FAILURE',
          title: 'Tỷ lệ thất bại',
          primary_value: 0, // Fake zero on BLOCKED KPI!
          status: 'BLOCKED',
          subtext: 'Bị chặn',
        },
      ],
      visualizations: [],
      data_tables: [],
      data_store: {},
    };

    const res = validateDashboardPayload(fakeBlockedPayload);
    assert.strictEqual(res.valid, false, 'Non-null on BLOCKED KPI must be rejected');
    assert.ok(res.errors.some((e) => e.code === 'FORBIDDEN_FAKE_VALUE'));
  });

  await test('F03', 'HTML comment closing sequence --> inside payload is neutralized during serialization', async () => {
    const maliciousPlan = {
      target_sheet: 'Sheet1',
      groupBy: ['dept'],
      aggregations: [{ column: 'id', func: 'COUNT', alias: 'count_id' }],
      chart_preference: 'BAR',
    };
    const mockResult = {
      results: [{ dept: 'Test --> fake comment closer', count_id: 5 }],
      rows_scanned: 5,
    };
    const mockDataset = {
      file_id: 'file_inject',
      original_filename: 'Dangerous --> file.xlsx',
      columns: [{ key: 'dept', name: 'dept', type: 'STRING' }],
    };

    const markdown = formatAnalyticalResultMarkdown(maliciousPlan, mockResult, mockDataset);
    
    // Extract everything between <!-- bi-dashboard-v2: and the FIRST -->
    const commentMatch = markdown.match(/<!-- bi-dashboard-v2:\s*([\s\S]*?)\s*-->/);
    assert.ok(commentMatch, 'Comment block must be cleanly extractable');
    
    // The inner content should NOT have unescaped -->
    assert.strictEqual(commentMatch[1].includes('-->'), false, 'Inner JSON must not contain unescaped -->');
    
    // And JSON.parse should still parse it cleanly
    const parsed = JSON.parse(commentMatch[1]);
    assert.strictEqual(parsed.version, '2.0');
    assert.ok(parsed.title.includes('Dangerous --> file.xlsx'));
  });

  await test('F04', 'File BI data table masks sensitive PII columns (CCCD, phone, email)', async () => {
    const plan = {
      target_sheet: 'NhanVien',
      groupBy: ['cccd', 'so_dien_thoai', 'email'],
      aggregations: [{ column: 'luong', func: 'SUM', alias: 'sum_luong' }],
      chart_preference: 'NONE',
    };
    const mockResult = {
      results: [
        { cccd: '079123456789', so_dien_thoai: '0901234567', email: 'nguyenvana@sotrans.com.vn', sum_luong: 15000000 },
      ],
      rows_scanned: 1,
    };
    const dataset = { file_id: 'ds_pii', original_filename: 'DS_NhanVien.xlsx' };

    const payload = formatDatasetDashboardPayload(plan, mockResult, dataset);
    const storeRow = payload.data_store.file_dataset_results[0];

    // CCCD should be masked: 079******789
    assert.ok(storeRow.cccd.includes('******'), 'CCCD must be masked');
    assert.strictEqual(storeRow.cccd, '079******789');

    // Phone should be masked: 090****567
    assert.ok(storeRow.so_dien_thoai.includes('****'), 'Phone must be masked');
    assert.strictEqual(storeRow.so_dien_thoai, '090****567');

    // Email should be masked: ng***@sotrans.com.vn
    assert.ok(storeRow.email.includes('***@'), 'Email must be masked');
  });

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`P1.0 DASHBOARD CONTRACT TEST SUMMARY: ${passCount} / ${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('Production Environment Connection: NONE (Hermetic Unit Testing)');
  console.log('PostgreSQL HR Database Intrusion: ZERO (100% Read-Only Schema Contract)');
  console.log('================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
