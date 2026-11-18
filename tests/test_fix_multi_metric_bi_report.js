/**
 * SOTRANS HUB — TEST FIX: MULTI-METRIC COMPOSITE BI REPORT & ACCURACY
 * Validates that composite prompts with multiple metrics across 6 departments:
 * 1. Do NOT falsely add date grouping (ngay_vao_lam) from "số ngày nghỉ" or "quy mô"
 * 2. Do NOT falsely filter out 5 departments from "cơ cấu nhân sự"
 * 3. Extract all 7 requested metrics into aggregations & computations
 * 4. Yield exactly 6 rows matching the reference PDF report
 * 5. Format Executive Highlights (Max Quy mô, Max Lương, Max KPI)
 * 6. Produce both Pie Chart and Bar Chart
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { planAnalyticalQuery } = require('../auth-service/services/biQueryPlanner');
const { validateQueryPlan } = require('../auth-service/services/biQueryValidator');
const { executeAnalyticalQuery } = require('../auth-service/services/biSpreadsheetEngine');
const { formatAnalyticalResultMarkdown } = require('../auth-service/services/biDatasetPresenter');
const { buildDatasetDashboard } = require('../auth-service/services/biReportBuilder');

async function runTest() {
  console.log('================================================================');
  console.log('TEST: MULTI-METRIC COMPOSITE BI REPORT (SOTRANS HR 6 DEPARTMENTS)');
  console.log('================================================================');

  const datasetPath = path.join(__dirname, 'fixtures/multi_metric_synthetic.dataset.json');
  const ds = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  const prompt = `Hãy tạo báo cáo BI phân tích cơ cấu nhân sự của 6 phòng ban.
Yêu cầu:
- Số lượng nhân viên từng phòng ban.
- Tỷ trọng nhân sự theo phòng ban.
- Lương trung bình từng phòng ban.
- Tổng quỹ lương từng phòng ban.
- KPI trung bình từng phòng ban.
- Số giờ tăng ca trung bình.
- Số ngày nghỉ trung bình.
Trình bày bằng Pie Chart, Bar Chart và bảng so sánh. Xác định phòng ban có quy mô nhân sự lớn nhất, chi phí lương cao nhất và KPI cao nhất. ( từ file excel mới tải lên)`;

  const userContext = { user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac', username: 'superadmin', role: 'ADMIN', company_id: 'ALL' };

  // Step 1: Plan
  const plan = planAnalyticalQuery(prompt, ds.profile, {});
  console.log('[1] Checking Planned Query...');
  assert.deepStrictEqual(plan.groupBy, ['phong_ban'], 'GroupBy must be strictly [phong_ban], NOT ngay_vao_lam');
  assert.deepStrictEqual(plan.filters, [], 'Filters must be empty, must NOT filter phong_ban = "Nhân Sự"');
  assert.strictEqual(plan.has_pie_and_bar, true, 'Must identify Pie & Bar chart request');
  assert.strictEqual(plan.aggregations.length, 6, 'Must extract all 6 requested metrics');
  assert.strictEqual(plan.computations.length, 1, 'Must extract percentage computation');
  console.log('  -> PASS: Query plan accurately targets 6 departments with all metrics.');

  // Step 2: Validate
  const validated = validateQueryPlan(plan, ds, userContext);
  console.log('[2] Checking Validation...');
  assert.deepStrictEqual(validated.groupBy, ['phong_ban']);
  assert.strictEqual(validated.aggregations.length, 6);
  console.log('  -> PASS: Query plan validated with zero security or schema errors.');

  // Step 3: Execute
  const queryResult = executeAnalyticalQuery(ds, validated);
  console.log('[3] Checking Analytical Execution...');
  assert.strictEqual(queryResult.results.length, 6, 'Must return exactly 6 departments');
  
  const depts = queryResult.results.map(r => r.phong_ban).sort();
  const expectedDepts = [
    'Chăm Sóc Khách Hàng',
    'Công Nghệ Thông Tin (IT)',
    'Kho Vận',
    'Kế Toán',
    'Nhân Sự',
    'Vận Tải'
  ].sort();
  assert.deepStrictEqual(depts, expectedDepts, 'All 6 departments must be present');

  // Verify numerical values against PDF reference
  const vanTai = queryResult.results.find(r => r.phong_ban === 'Vận Tải');
  assert.strictEqual(vanTai.distinct_count_ma_nhan_vien, 31);
  assert.strictEqual(vanTai.sum_luong_co_ban_vnd, 722000000);
  assert.strictEqual(vanTai.avg_diem_kpi, 80.18);
  assert.strictEqual(vanTai.avg_so_ngay_nghi, 7.52);

  const cskh = queryResult.results.find(r => r.phong_ban === 'Chăm Sóc Khách Hàng');
  assert.strictEqual(cskh.distinct_count_ma_nhan_vien, 22);
  assert.strictEqual(cskh.sum_luong_co_ban_vnd, 620000000);
  assert.strictEqual(cskh.avg_diem_kpi, 85.47);
  assert.strictEqual(cskh.avg_so_ngay_nghi, 6.91);

  const nhanSu = queryResult.results.find(r => r.phong_ban === 'Nhân Sự');
  assert.strictEqual(nhanSu.distinct_count_ma_nhan_vien, 30);
  assert.strictEqual(nhanSu.sum_luong_co_ban_vnd, 600000000);
  assert.strictEqual(nhanSu.avg_gio_tang_ca, 76.07);

  console.log('  -> PASS: Exact numerical match with reference PDF (31 NV Vận Tải, 85.47 KPI CSKH, 76.1h OT Nhân Sự).');

  // Step 4: Presentation & Formatting
  const markdown = formatAnalyticalResultMarkdown(validated, queryResult, ds, 'Nhận xét điều hành mẫu', userContext);
  console.log('[4] Checking Markdown Output Formatting...');
  assert.ok(markdown.includes('### 📌 Điểm Nhấn Điều Hành (Executive Highlights)'), 'Must include Executive Highlights');
  assert.ok(markdown.includes('Phòng Vận Tải'), 'Must highlight Phòng Vận Tải');
  assert.ok(markdown.includes('722.000.000 VNĐ'), 'Must highlight 722.000.000 VNĐ');
  assert.ok(markdown.includes('85,47 Điểm'), 'Must highlight 85,47 Điểm');
  assert.ok(markdown.includes('Phòng Chăm Sóc Khách Hàng'), 'Must highlight Phòng Chăm Sóc Khách Hàng');
  assert.ok(markdown.includes('Pie Chart'), 'Must render Pie Chart');
  assert.ok(markdown.includes('Bar Chart'), 'Must render Bar Chart');
  assert.ok(markdown.includes('Bảng Số Liệu Chi Tiết (6 kết quả)'), 'Must state 6 kết quả, not 19');
  console.log('  -> PASS: Markdown format matches the PDF dashboard layout.');

  // Step 5: Dashboard v2 Contract
  const dashboard = buildDatasetDashboard(validated, queryResult, ds, userContext);
  console.log('[5] Checking Dashboard v2 Contract & Visualizations...');
  assert.ok(dashboard.visualizations.length >= 2, 'Must have at least 2 visualizations for Pie and Bar');
  assert.strictEqual(dashboard.visualizations[0].chart_type, 'PIE', 'First viz must be PIE');
  assert.strictEqual(dashboard.visualizations[1].chart_type, 'BAR', 'Second viz must be BAR');
  console.log('  -> PASS: Interactive ECharts payload supports composite Pie & Bar charts.');

  console.log('\n================================================================');
  console.log('ALL FIX CHECKS PASSED PERFECTLY!');
  console.log('================================================================');
}

runTest().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
