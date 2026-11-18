'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { planAnalyticalQuery, planFollowUpQuery } = require('../auth-service/services/biQueryPlanner');
const { validateQueryPlan } = require('../auth-service/services/biQueryValidator');
const { processAndProfileDataset, executeAnalyticalQuery } = require('../auth-service/services/biSpreadsheetEngine');
const { buildDatasetDashboard } = require('../auth-service/services/biReportBuilder');
const { validateDashboardPayload } = require('../auth-service/services/biDashboardSchemaValidator');
const { signReport, verifyReport } = require('../auth-service/services/biExportToken');

async function runPhase4Tests() {
  console.log('=== STARTING SOTRANS HUB PHASE 4 MULTI-VISUAL DASHBOARD VERIFICATION ===\n');

  const fixtureBRowsPath = path.join(__dirname, '..', 'reports', 'bi_full_system_20261116', 'fixture-rows.json');
  const fixtureBXlsxPath = path.join(__dirname, '..', 'reports', 'bi_full_system_20261116', 'synthetic-150.xlsx');

  const fixtureBRows = JSON.parse(fs.readFileSync(fixtureBRowsPath, 'utf8'));
  const fixtureBBuffer = fs.readFileSync(fixtureBXlsxPath);

  const metaB = {
    file_id: 'file_syn_phase4_001',
    original_filename: 'synthetic-150.xlsx',
    file_extension: '.xlsx',
    file_type: 'xlsx',
  };
  const profiledB = await processAndProfileDataset(metaB, fixtureBBuffer);
  const dataset = {
    file_id: 'file_syn_phase4_001',
    original_filename: 'synthetic-150.xlsx',
    checksum: 'checksum_phase4_test',
    rows: fixtureBRows,
    profile: profiledB.dataProfile,
    columns: profiledB.dataProfile.columns,
  };

  const userContext = {
    user_id: 'usr_phase4_admin',
    username: 'phase4_admin',
    role: 'ADMIN',
    company_id: 'ALL',
    status: 'ACTIVE',
  };

  let passed = 0;
  let total = 0;

  function record(name, fn) {
    total++;
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name} -> ${err.message}`);
      throw err;
    }
  }

  console.log('--- SECTION 1: MULTI-VISUAL DASHBOARD COMPOSITION (BACKEND & SCHEMA) ---');

  let baseDash = null;
  record('P4-01: Generate Multi-Visual Dashboard with 3 Distinct Visuals and Unique Data Refs', () => {
    const rawPlan = planAnalyticalQuery('Thống kê số lượng nhân sự theo từng phòng ban', dataset.profile);
    const validPlan = validateQueryPlan(rawPlan, dataset, userContext);
    const queryResult = executeAnalyticalQuery(dataset, validPlan);

    baseDash = buildDatasetDashboard(validPlan, queryResult, dataset, userContext);
    assert.strictEqual(baseDash.version, '2.0');
    assert.strictEqual(baseDash.source_type, 'FILE_DATASET');

    // Must have at least 3 distinct visualizations
    assert.ok(baseDash.visualizations.length >= 3, `Expected at least 3 visualizations, got ${baseDash.visualizations.length}`);

    // Verify distinct data references (NEVER duplicate result set across widgets!)
    const dataRefs = baseDash.visualizations.map(v => v.data_ref);
    const uniqueDataRefs = new Set(dataRefs);
    assert.strictEqual(uniqueDataRefs.size, dataRefs.length, 'Every visualization must point to its own distinct data_ref!');

    // Verify presence of department bar, branch pie, and trend line widgets
    const deptViz = baseDash.visualizations.find(v => v.id === 'viz_file_main' || v.id === 'viz_bar_dept');
    const branchViz = baseDash.visualizations.find(v => v.id === 'viz_pie_branch');
    const trendViz = baseDash.visualizations.find(v => v.id === 'viz_line_trend');

    assert.ok(deptViz, 'Department visualization must exist');
    assert.ok(branchViz, 'Branch visualization must exist');
    assert.ok(trendViz, 'Trend visualization must exist');

    assert.strictEqual(branchViz.chart_type, 'PIE');
    assert.strictEqual(trendViz.chart_type, 'LINE');

    // Verify distinct data store arrays
    assert.ok(Array.isArray(baseDash.data_store[deptViz.data_ref]));
    assert.ok(Array.isArray(baseDash.data_store[branchViz.data_ref]));
    assert.ok(Array.isArray(baseDash.data_store[trendViz.data_ref]));
  });

  record('P4-02: KPI Strip Contains Matching Rows, Unique Headcount, and Aggregate Metric', () => {
    assert.ok(baseDash.kpi_strip.length >= 3, `Expected at least 3 KPI cards, got ${baseDash.kpi_strip.length}`);

    const matchingKpi = baseDash.kpi_strip.find(k => k.kpi_code === 'FILE_MATCHED_ROWS' || k.metric_alias === 'matching_rows');
    const headcountKpi = baseDash.kpi_strip.find(k => k.metric_alias === 'distinct_headcount' || k.metric_alias?.includes('nhan_vien'));
    const salaryKpi = baseDash.kpi_strip.find(k => k.id === 'kpi_file_salary' || k.metric_alias?.includes('luong'));

    assert.ok(matchingKpi, 'Matching Rows KPI card must exist');
    assert.ok(headcountKpi, 'Distinct Headcount KPI card must exist');
    assert.ok(salaryKpi, 'Salary/Metric KPI card must exist');

    assert.strictEqual(matchingKpi.primary_value, 150, 'Matching rows on synthetic-150.xlsx must be 150');
    assert.strictEqual(headcountKpi.primary_value, 140, 'Distinct headcount on synthetic-150.xlsx must be 140');
    assert.strictEqual(salaryKpi.primary_value, 1885700000, 'Total salary on synthetic-150.xlsx must be 1,885,700,000');
  });

  record('P4-03: Chronological Sorting of Trend Visualization Months', () => {
    const trendViz = baseDash.visualizations.find(v => v.id === 'viz_line_trend');
    const trendRows = baseDash.data_store[trendViz.data_ref];
    assert.ok(trendRows.length > 0);

    const monthKey = trendViz.mapping.category;
    for (let i = 1; i < trendRows.length; i++) {
      assert.ok(trendRows[i][monthKey] >= trendRows[i - 1][monthKey], `Trend rows must be chronologically ascending: ${trendRows[i][monthKey]} vs ${trendRows[i - 1][monthKey]}`);
    }
  });

  record('P4-04: Explicit Denominator for Branch Share Pie Chart', () => {
    const branchViz = baseDash.visualizations.find(v => v.id === 'viz_pie_branch');
    const branchRows = baseDash.data_store[branchViz.data_ref];
    assert.ok(branchRows.length >= 3);

    // Sum of shares must equal ~100%
    const totalShare = branchRows.reduce((acc, r) => acc + (r.ty_trong_pct || 0), 0);
    assert.ok(Math.abs(totalShare - 100) < 0.2, `Branch share percentages must sum to 100%, got ${totalShare}%`);
  });

  record('P4-05: Multi-Visual Dashboard Validates against Contract Schema v2.0', () => {
    const validation = validateDashboardPayload(baseDash, userContext);
    assert.strictEqual(validation.valid, true, `Validation failed: ${JSON.stringify(validation.errors)}`);
  });

  record('P4-06: Signed Export Token Verification', () => {
    assert.ok(baseDash.export_token, 'Dashboard payload must contain signed export_token');
    const isValid = verifyReport(baseDash, userContext);
    assert.strictEqual(isValid, true, 'Export token signature must be valid');
  });

  console.log('\n--- SECTION 2: CONVERSATIONAL FOLLOW-UP UPDATES (GENERAL AI MULTI-TURN) ---');

  let turn1Plan = null;
  record('P4-07: Turn 1 Baseline Query: "Thống kê số lượng nhân sự theo từng phòng ban"', () => {
    turn1Plan = planAnalyticalQuery('Thống kê số lượng nhân sự theo từng phòng ban', dataset.profile);
    assert.strictEqual(turn1Plan.groupBy[0], 'phong_ban');
    assert.strictEqual(turn1Plan.chart_preference, 'BAR');
    assert.strictEqual(turn1Plan.filters.length, 0);
  });

  record('P4-08: Follow-up Turn 2: "Đổi biểu đồ phòng ban sang biểu đồ tròn"', () => {
    const turn2Plan = planFollowUpQuery('Đổi biểu đồ phòng ban sang biểu đồ tròn', turn1Plan, dataset.profile);
    assert.ok(turn2Plan, 'Follow-up query must be recognized');
    assert.strictEqual(turn2Plan.chart_preference, 'PIE');
    assert.strictEqual(turn2Plan.groupBy[0], 'phong_ban', 'GroupBy dimension must be preserved');
    assert.strictEqual(turn2Plan.aggregations[0].func, turn1Plan.aggregations[0].func, 'Metric function must be preserved');
  });

  record('P4-09: Follow-up Turn 3: "Chỉ lấy phòng Kho Vận"', () => {
    const turn3Plan = planFollowUpQuery('Chỉ lấy phòng Kho Vận', turn1Plan, dataset.profile);
    assert.ok(turn3Plan, 'Follow-up query must be recognized');
    assert.ok(turn3Plan.filters.length >= 1, 'Filter must be added');
    assert.strictEqual(turn3Plan.filters[0].column, 'phong_ban');
    assert.strictEqual(turn3Plan.filters[0].value, 'Kho Van');
    assert.strictEqual(turn3Plan.groupBy[0], 'phong_ban', 'GroupBy must be preserved');
  });

  record('P4-10: Follow-up Turn 4: "So sánh với tháng trước"', () => {
    const turn4Plan = planFollowUpQuery('So sánh với tháng trước', turn1Plan, dataset.profile);
    assert.ok(turn4Plan, 'Follow-up query must be recognized');
    assert.ok(turn4Plan.period_comparison, 'period_comparison must be present');
    assert.strictEqual(turn4Plan.period_comparison.period, 'MONTH_OVER_MONTH');
  });

  record('P4-11: Follow-up Turn 5: "Hiển thị Top 5 phòng ban"', () => {
    const turn5Plan = planFollowUpQuery('Hiển thị Top 5 phòng ban', turn1Plan, dataset.profile);
    assert.ok(turn5Plan, 'Follow-up query must be recognized');
    assert.strictEqual(turn5Plan.limit, 5);
    assert.strictEqual(turn5Plan.intent, 'RANKING');
  });

  record('P4-12: Follow-up Turn 6: "Thêm bảng dữ liệu chi tiết"', () => {
    const turn6Plan = planFollowUpQuery('Thêm bảng dữ liệu chi tiết', turn1Plan, dataset.profile);
    assert.ok(turn6Plan, 'Follow-up query must be recognized');
    assert.strictEqual(turn6Plan.show_data_table, true);
  });

  console.log('\n--- SECTION 3: SERVER-SIDE RE-EVALUATION ON CROSS-FILTERING ---');

  record('P4-13: Server Cross-Filter on Kho Van Recomputes Full Dashboard Metrics', () => {
    const crossFilterPlan = {
      ...turn1Plan,
      filters: [{ column: 'phong_ban', op: 'eq', value: 'Kho Van' }],
    };
    const validPlan = validateQueryPlan(crossFilterPlan, dataset, userContext);
    const queryResult = executeAnalyticalQuery(dataset, validPlan);
    const filteredDash = buildDatasetDashboard(validPlan, queryResult, dataset, userContext);

    // Matching rows KPI must reflect exactly Kho Van (35 rows)
    const matchingKpi = filteredDash.kpi_strip.find(k => k.kpi_code === 'FILE_MATCHED_ROWS' || k.metric_alias === 'matching_rows');
    assert.strictEqual(matchingKpi.primary_value, 35);

    // Total headcount KPI must reflect distinct headcount in Kho Van
    const headcountKpi = filteredDash.kpi_strip.find(k => k.metric_alias === 'distinct_headcount' || k.metric_alias?.includes('nhan_vien'));
    assert.strictEqual(headcountKpi.primary_value, 35);

    // Branch breakdown visual must reflect branches where Kho Van employees reside
    const branchViz = filteredDash.visualizations.find(v => v.id === 'viz_pie_branch');
    assert.ok(branchViz);
    const branchRows = filteredDash.data_store[branchViz.data_ref];
    const branchSum = branchRows.reduce((a, b) => a + b.distinct_count_ma_nhan_vien, 0);
    assert.strictEqual(branchSum, 35, 'Filtered branch headcount must equal 35');
  });

  console.log('\n================================================================');
  console.log(`TOTAL: ${passed} / ${total} PASSED (${total - passed} FAILED)`);
  console.log('================================================================');
}

runPhase4Tests().catch(err => {
  console.error('\nTest Suite Execution Aborted on Error:', err);
  process.exit(1);
});
