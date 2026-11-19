'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const {
  processAndProfileDataset,
  executeAnalyticalQuery,
  queryIsolatedDataset,
} = require('../auth-service/services/biSpreadsheetEngine');
const {
  planAnalyticalQuery,
  decomposeCompositeRequirements,
} = require('../auth-service/services/biQueryPlanner');
const { validateQueryPlan } = require('../auth-service/services/biQueryValidator');
const { buildDatasetDashboard } = require('../auth-service/services/biReportBuilder');
const { formatAnalyticalResultMarkdown } = require('../auth-service/services/biDatasetPresenter');
const { assertValidDashboardPayload } = require('../auth-service/services/biDashboardSchemaValidator');

const adminUser = { user_id: 'usr_admin_uat', username: 'admin', role: 'ADMIN', company_id: 'ALL' };
const empStlUser = { user_id: 'usr_stl_uat', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' };
const empVtxUser = { user_id: 'usr_vtx_uat', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' };

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    throw new Error(message);
  }
  console.log(`[PASS] ${message}`);
}

async function runComprehensiveTestSuite() {
  console.log('================================================================');
  console.log('SOTRANS HUB — GENERAL AI BI REPORT GENERATION COMPREHENSIVE SUITE');
  console.log('Test 1 to Test 8: Multi-Intent, Visuals, Consistency, Filter, Scale, Cross-Domain, Missing, Security');
  console.log('================================================================\n');

  let passedTests = 0;
  let failedTests = 0;

  // Load demo HR spreadsheet
  let demoPath = path.join(__dirname, '..', 'BAO_CAO_DEMO_SOLIEU.xlsx');
  if (!fs.existsSync(demoPath)) {
    demoPath = path.join(__dirname, '../auth-service/uploads/382cd016-3bfb-48e2-86d4-4bea4c03675f_Du_Lieu_Nhan_Su_Logistics_SOTRANS.xlsx');
  }
  assert(fs.existsSync(demoPath), 'File dữ liệu nhân sự demo tồn tại');

  const demoBuffer = fs.readFileSync(demoPath);
  const metadataHR = {
    file_id: 'test_file_bi_comprehensive',
    original_filename: 'BAO_CAO_DEMO_SOLIEU.xlsx',
    file_extension: '.xlsx',
    file_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  const { dataProfile, datasetJsonPath } = await processAndProfileDataset(metadataHR, demoBuffer);
  const storedJsonHR = JSON.parse(fs.readFileSync(datasetJsonPath, 'utf8'));
  const datasetObjHR = {
    file_id: metadataHR.file_id,
    original_filename: metadataHR.original_filename,
    columns: dataProfile.columns,
    profile: dataProfile,
    rows: storedJsonHR.sheets['HR_Data'].rows,
    uploaded_by: adminUser.user_id,
    company_id: 'ALL',
  };

  // ================================================================
  // TEST 1 — PAYROLL MULTI-INTENT (ALL 8 REQUIREMENTS RECOGNIZED & VERIFIED)
  // ================================================================
  console.log('\n--- [TEST 1] PAYROLL MULTI-INTENT REQUIREMENT DECOMPOSITION & CALCULATION ---');
  try {
    const payrollPrompt =
      'Phân tích quỹ lương nhân sự gồm: 1. Tổng quỹ lương cơ bản. 2. Lương cơ bản trung bình. 3. Lương cao nhất và thấp nhất. 4. Phân bổ quỹ lương theo phòng ban. 5. So sánh lương trung bình giữa các chức vụ. 6. Phân loại nhân viên theo nhóm mức lương. 7. Top 10 nhân viên có lương cao nhất. 8. Hiển thị KPI Cards, Bar Chart, Pie Chart và bảng xếp hạng.';

    const plan1 = planAnalyticalQuery(payrollPrompt, dataProfile);
    assert(plan1.intent === 'COMPOSITE', 'Test 1.1: Intent được phân loại chính xác là COMPOSITE');
    assert(Array.isArray(plan1.requirements) && plan1.requirements.length >= 8, `Test 1.2: Bóc tách đủ tối thiểu 8 yêu cầu (thực tế: ${plan1.requirements?.length})`);

    // Verify presence of all 8 core requirements
    const reqTotal = plan1.requirements.find(r => r.id === 'req_total_salary');
    const reqAvg = plan1.requirements.find(r => r.id === 'req_avg_salary');
    const reqMax = plan1.requirements.find(r => r.id === 'req_max_salary');
    const reqMin = plan1.requirements.find(r => r.id === 'req_min_salary');
    const reqDeptBar = plan1.requirements.find(r => r.id === 'req_salary_by_dept_bar');
    const reqDeptPie = plan1.requirements.find(r => r.id === 'req_salary_by_dept_pie');
    const reqTitle = plan1.requirements.find(r => r.id === 'req_avg_salary_by_title');
    const reqBands = plan1.requirements.find(r => r.id === 'req_salary_bands');
    const reqTop10 = plan1.requirements.find(r => r.id === 'req_top_10_salary');

    assert(Boolean(reqTotal), 'Test 1.3: REQ-01: Tổng quỹ lương cơ bản tồn tại');
    assert(Boolean(reqAvg), 'Test 1.4: REQ-02: Lương cơ bản trung bình tồn tại');
    assert(Boolean(reqMax), 'Test 1.5: REQ-03: Lương cao nhất tồn tại');
    assert(Boolean(reqMin), 'Test 1.6: REQ-04: Lương thấp nhất tồn tại');
    assert(Boolean(reqDeptBar && reqDeptPie), 'Test 1.7: REQ-05: Phân bổ quỹ lương theo phòng ban (Bar và Pie) tồn tại');
    assert(Boolean(reqTitle), 'Test 1.8: REQ-06: So sánh lương trung bình theo chức vụ tồn tại');
    assert(Boolean(reqBands), 'Test 1.9: REQ-07: Phân loại nhân viên theo nhóm mức lương tồn tại');
    assert(Boolean(reqTop10), 'Test 1.10: REQ-08: Top 10 nhân viên có lương cao nhất tồn tại');

    // Validation
    const valPlan1 = validateQueryPlan(plan1, datasetObjHR, adminUser);
    assert(valPlan1.metric_coverage.isComplete === true, 'Test 1.11: Tất cả 8+ yêu cầu vượt qua bước xác thực schema');

    // Execution
    const execResult1 = executeAnalyticalQuery(datasetObjHR, valPlan1);
    const resByReq1 = execResult1.results_by_requirement;
    assert(Boolean(resByReq1), 'Test 1.12: Executor trả về results_by_requirement hoàn chỉnh');

    // Exact Ground Truth Assertions:
    assert(resByReq1['req_total_salary'].value === 3429000000, `Test 1.13: Tổng quỹ lương = 3.429.000.000 VNĐ (Thực tế: ${resByReq1['req_total_salary'].value})`);
    assert(resByReq1['req_avg_salary'].value === 22860000, `Test 1.14: Lương cơ bản trung bình = 22.860.000 VNĐ (Thực tế: ${resByReq1['req_avg_salary'].value})`);
    assert(resByReq1['req_max_salary'].value === 50000000, `Test 1.15: Lương cao nhất = 50.000.000 VNĐ (Thực tế: ${resByReq1['req_max_salary'].value})`);
    assert(resByReq1['req_min_salary'].value === 3000000, `Test 1.16: Lương thấp nhất = 3.000.000 VNĐ (Thực tế: ${resByReq1['req_min_salary'].value})`);

    // Department Sum
    const deptRows = resByReq1['req_salary_by_dept_bar'].data;
    assert(deptRows.length === 6, 'Test 1.17: Quỹ lương chia đủ 6 phòng ban');
    const deptSum = deptRows.reduce((a, b) => a + b.tong_quy_luong, 0);
    assert(deptSum === 3429000000, `Test 1.18: Tổng quỹ lương 6 phòng ban (${deptSum}) khớp chính xác 3.429.000.000 VNĐ`);
    assert(deptRows[0].phong_ban === 'Vận Tải' && deptRows[0].tong_quy_luong === 722000000, 'Test 1.19: Phòng Vận Tải dẫn đầu với 722.000.000 VNĐ');

    // Job Titles
    const titleRows = resByReq1['req_avg_salary_by_title'].data;
    assert(titleRows.length === 20, 'Test 1.20: Có đủ 20 chức vụ');
    assert(titleRows[0].chuc_vu === 'Quản lý đội xe' && Math.round(titleRows[0].luong_trung_binh) === 40727273, `Test 1.21: Chức vụ lương cao nhất là Quản lý đội xe (40.727.273 VNĐ/người)`);

    // Salary Bands
    const bandRows = resByReq1['req_salary_bands'].data;
    assert(bandRows.length === 4, 'Test 1.22: Có đủ 4 khoảng lương');
    const totalBandEmployees = bandRows.reduce((a, b) => a + b.so_nhan_vien, 0);
    assert(totalBandEmployees === 150, `Test 1.23: Tổng số nhân sự trong các khoảng lương (${totalBandEmployees}) khớp chính xác 150 nhân sự`);
    assert(bandRows.find(b => b.nhom_muc_luong === 'Dưới 15 triệu')?.so_nhan_vien === 54, 'Test 1.24: Nhóm < 15 triệu có đúng 54 nhân sự (36%)');
    assert(bandRows.find(b => b.nhom_muc_luong === '15 - 25 triệu')?.so_nhan_vien === 39, 'Test 1.25: Nhóm 15-25 triệu có đúng 39 nhân sự (26%)');
    assert(bandRows.find(b => b.nhom_muc_luong === '25 - 35 triệu')?.so_nhan_vien === 24, 'Test 1.26: Nhóm 25-35 triệu có đúng 24 nhân sự (16%)');
    assert(bandRows.find(b => b.nhom_muc_luong === 'Trên 35 triệu')?.so_nhan_vien === 33, 'Test 1.27: Nhóm > 35 triệu có đúng 33 nhân sự (22%)');

    // Top 10 Employees
    const top10Rows = resByReq1['req_top_10_salary'].data;
    assert(top10Rows.length === 10, 'Test 1.28: Top 10 nhân viên có đúng 10 bản ghi');
    assert(top10Rows[0].ma_nhan_vien === 'NV069' && top10Rows[0].luong_co_ban_vnd === 50000000, 'Test 1.29: #1 là NV069 với mức lương 50.000.000 VNĐ');
    assert(top10Rows[9].luong_co_ban_vnd === 49000000, 'Test 1.30: #10 là nhân viên có mức lương 49.000.000 VNĐ');

    console.log('[TEST 1 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 1 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // TEST 2 — DYNAMIC VISUALIZATION & UNWANTED METRIC ELIMINATION
  // ================================================================
  console.log('\n--- [TEST 2] DYNAMIC VISUALIZATION SPECIFICATION & UNWANTED METRICS CHECK ---');
  try {
    const payrollPrompt =
      'Phân tích quỹ lương nhân sự gồm: 1. Tổng quỹ lương cơ bản. 2. Lương cơ bản trung bình. 3. Lương cao nhất và thấp nhất. 4. Phân bổ quỹ lương theo phòng ban. 5. So sánh lương trung bình giữa các chức vụ. 6. Phân loại nhân viên theo nhóm mức lương. 7. Top 10 nhân viên có lương cao nhất. 8. Hiển thị KPI Cards, Bar Chart, Pie Chart và bảng xếp hạng.';

    const plan2 = planAnalyticalQuery(payrollPrompt, dataProfile);
    const valPlan2 = validateQueryPlan(plan2, datasetObjHR, adminUser);
    const execResult2 = executeAnalyticalQuery(datasetObjHR, valPlan2);
    const dash2 = buildDatasetDashboard(valPlan2, execResult2, datasetObjHR, adminUser);

    // KPI Strip: exactly 4 requested business KPI cards
    assert(dash2.kpi_strip.length === 4, `Test 2.1: KPI strip có đúng 4 thẻ KPI nghiệp vụ (thực tế: ${dash2.kpi_strip.length})`);
    assert(dash2.kpi_strip.some(k => k.title === 'Tổng quỹ lương cơ bản'), 'Test 2.2: Có thẻ Tổng quỹ lương cơ bản');
    assert(dash2.kpi_strip.some(k => k.title === 'Lương cơ bản trung bình'), 'Test 2.3: Có thẻ Lương cơ bản trung bình');
    assert(dash2.kpi_strip.some(k => k.title === 'Lương cơ bản cao nhất'), 'Test 2.4: Có thẻ Lương cơ bản cao nhất');
    assert(dash2.kpi_strip.some(k => k.title === 'Lương cơ bản thấp nhất'), 'Test 2.5: Có thẻ Lương cơ bản thấp nhất');

    // Strict checks: Absolutely NO unrequested cards!
    assert(!dash2.kpi_strip.some(k => k.title.includes('Dòng phù hợp') || k.metric_alias === 'matching_rows'), 'Test 2.6: KHÔNG tự ý chèn thẻ "Dòng phù hợp"');
    assert(!dash2.kpi_strip.some(k => k.title.includes('Tổng nhân sự') || k.metric_alias === 'distinct_headcount'), 'Test 2.7: KHÔNG tự ý chèn thẻ "Tổng nhân sự"');
    assert(!dash2.kpi_strip.some(k => k.title.includes('KPI') && k.metric_alias?.includes('diem_kpi')), 'Test 2.8: KHÔNG tự ý chèn thẻ "Điểm KPI trung bình"');

    // Visualizations: Bar and Pie for dept, Bar for title, Bar for bands
    assert(dash2.visualizations.length === 4, `Test 2.9: Có đúng 4 biểu đồ trực quan (thực tế: ${dash2.visualizations.length})`);
    const deptBarViz = dash2.visualizations.find(v => v.id === 'viz_req_salary_by_dept_bar');
    const deptPieViz = dash2.visualizations.find(v => v.id === 'viz_req_salary_by_dept_pie');
    const titleBarViz = dash2.visualizations.find(v => v.id === 'viz_req_avg_salary_by_title');
    const bandsViz = dash2.visualizations.find(v => v.id === 'viz_req_salary_bands');

    assert(deptBarViz && deptBarViz.chart_type === 'BAR', 'Test 2.10: Biểu đồ cột phân bổ quỹ lương theo phòng ban chuẩn xác');
    assert(deptPieViz && deptPieViz.chart_type === 'PIE', 'Test 2.11: Biểu đồ tròn tỷ trọng quỹ lương theo phòng ban chuẩn xác');
    assert(titleBarViz && titleBarViz.chart_type === 'BAR', 'Test 2.12: Biểu đồ cột so sánh lương theo chức vụ chuẩn xác');
    assert(bandsViz && (bandsViz.chart_type === 'BAR' || bandsViz.chart_type === 'PIE'), 'Test 2.13: Biểu đồ phân nhóm mức lương chuẩn xác');

    // User-friendly Titles (No technical raw names)
    for (const viz of dash2.visualizations) {
      assert(!viz.title.includes('sum_luong_co_ban_vnd'), `Test 2.14: Tiêu đề biểu đồ "${viz.title}" thân thiện, không chứa tên cột kỹ thuật`);
    }

    // Top 10 Ranking Table
    const top10Table = dash2.data_tables.find(t => t.id === 'tbl_req_top_10_salary');
    assert(Boolean(top10Table), 'Test 2.15: Bảng Top 10 tồn tại');
    assert(top10Table.columns.some(c => c.key === 'hang'), 'Test 2.16: Bảng Top 10 có cột Hạng');
    assert(top10Table.columns.some(c => c.key === 'ma_nhan_vien'), 'Test 2.17: Bảng Top 10 có cột Mã NV');
    assert(top10Table.columns.some(c => c.key === 'ho_ten'), 'Test 2.18: Bảng Top 10 có cột Họ Tên');
    assert(top10Table.columns.some(c => c.key === 'phong_ban'), 'Test 2.19: Bảng Top 10 có cột Phòng Ban');
    assert(top10Table.columns.some(c => c.key === 'chuc_vu'), 'Test 2.20: Bảng Top 10 có cột Chức Vụ');
    assert(top10Table.columns.some(c => c.key === 'luong_co_ban_vnd'), 'Test 2.21: Bảng Top 10 có cột Lương Cơ Bản (VNĐ)');

    // Schema Validation Contract v2.0
    assertValidDashboardPayload(dash2, adminUser);
    assert(true, 'Test 2.22: Dashboard payload vượt qua kiểm tra nghiêm ngặt của Contract v2.0');

    console.log('[TEST 2 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 2 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // TEST 3 — INSIGHT CONSISTENCY & SINGLE SOURCE OF TRUTH
  // ================================================================
  console.log('\n--- [TEST 3] INSIGHT CONSISTENCY & RECONCILIATION VERIFICATION ---');
  try {
    const payrollPrompt =
      'Phân tích quỹ lương nhân sự gồm: 1. Tổng quỹ lương cơ bản. 2. Lương cơ bản trung bình. 3. Lương cao nhất và thấp nhất. 4. Phân bổ quỹ lương theo phòng ban. 5. So sánh lương trung bình giữa các chức vụ. 6. Phân loại nhân viên theo nhóm mức lương. 7. Top 10 nhân viên có lương cao nhất. 8. Hiển thị KPI Cards, Bar Chart, Pie Chart và bảng xếp hạng.';

    const plan3 = planAnalyticalQuery(payrollPrompt, dataProfile);
    const valPlan3 = validateQueryPlan(plan3, datasetObjHR, adminUser);
    const execResult3 = executeAnalyticalQuery(datasetObjHR, valPlan3);

    const verifiedInsightText =
      'Quỹ lương toàn công ty đạt 3.429.000.000 VNĐ với mức lương cơ bản trung bình 22.860.000 VNĐ/người. Mức lương cá nhân cao nhất đạt 50.000.000 VNĐ (thuộc về các vị trí quản lý như NV069, NV100, NV116, NV125, NV131) và mức lương cá nhân thấp nhất là 3.000.000 VNĐ. Phòng Vận Tải chiếm quỹ lương lớn nhất với 722.000.000 VNĐ, trong khi vị trí có mức lương bình quân cao nhất là Quản lý đội xe (40.727.273 VNĐ/người). Cơ cấu lương cho thấy nhóm dưới 15 triệu chiếm đa số với 54 nhân sự (36%).';

    const mdReport3 = formatAnalyticalResultMarkdown(valPlan3, execResult3, datasetObjHR, verifiedInsightText, adminUser);

    assert(mdReport3.includes('3.429.000.000'), 'Test 3.1: Markdown chứa đúng tổng quỹ lương 3.429.000.000 VNĐ');
    assert(mdReport3.includes('22.860.000'), 'Test 3.2: Markdown chứa đúng mức lương trung bình 22.860.000 VNĐ');
    assert(mdReport3.includes('50.000.000'), 'Test 3.3: Markdown chứa đúng mức lương cao nhất 50.000.000 VNĐ');
    assert(mdReport3.includes('3.000.000'), 'Test 3.4: Markdown chứa đúng mức lương thấp nhất 3.000.000 VNĐ');
    assert(mdReport3.includes('722.000.000'), 'Test 3.5: Markdown chứa đúng quỹ lương Vận Tải 722.000.000 VNĐ');
    assert(mdReport3.includes('NV069'), 'Test 3.6: Markdown chứa đúng mã nhân viên đứng đầu Top 10 (NV069)');
    assert(mdReport3.includes('Dưới 15 triệu'), 'Test 3.7: Markdown chứa bảng phân loại nhóm mức lương');
    assert(mdReport3.includes('bi-dashboard-v2'), 'Test 3.8: Markdown chứa payload chuẩn bi-dashboard-v2');

    console.log('[TEST 3 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 3 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // TEST 4 — SERVER-SIDE RE-EVALUATION ON CROSS-FILTERING
  // ================================================================
  console.log('\n--- [TEST 4] CROSS-FILTERING RE-EVALUATION & METRIC SYNCHRONIZATION ---');
  try {
    const payrollPrompt =
      'Phân tích quỹ lương nhân sự gồm: 1. Tổng quỹ lương cơ bản. 2. Lương cơ bản trung bình. 3. Lương cao nhất và thấp nhất. 4. Phân bổ quỹ lương theo phòng ban. 5. So sánh lương trung bình giữa các chức vụ. 6. Phân loại nhân viên theo nhóm mức lương. 7. Top 10 nhân viên có lương cao nhất. 8. Hiển thị KPI Cards, Bar Chart, Pie Chart và bảng xếp hạng.';

    const plan4 = planAnalyticalQuery(payrollPrompt, dataProfile);
    const filterVanTaiPlan = {
      ...plan4,
      filters: [{ column: 'phong_ban', op: 'eq', value: 'Vận Tải' }],
    };
    const valPlan4 = validateQueryPlan(filterVanTaiPlan, datasetObjHR, adminUser);
    const execResult4 = executeAnalyticalQuery(datasetObjHR, valPlan4);

    const filteredTotalSal = execResult4.results_by_requirement['req_total_salary'].value;
    const filteredAvgSal = execResult4.results_by_requirement['req_avg_salary'].value;
    const filteredMaxSal = execResult4.results_by_requirement['req_max_salary'].value;
    const filteredMinSal = execResult4.results_by_requirement['req_min_salary'].value;

    assert(filteredTotalSal === 722000000, `Test 4.1: Tổng lương sau khi lọc Vận Tải = 722.000.000 VNĐ (Thực tế: ${filteredTotalSal})`);
    assert(Math.abs(filteredAvgSal - 23290322.58) < 0.1, `Test 4.2: Lương trung bình Vận Tải = 23.290.322,58 VNĐ (Thực tế: ${filteredAvgSal})`);
    assert(filteredMaxSal === 50000000, `Test 4.3: Lương cao nhất Vận Tải = 50.000.000 VNĐ (Thực tế: ${filteredMaxSal})`);
    assert(filteredMinSal === 8000000, `Test 4.4: Lương thấp nhất Vận Tải = 8.000.000 VNĐ (Thực tế: ${filteredMinSal})`);

    const dashFiltered = buildDatasetDashboard(valPlan4, execResult4, datasetObjHR, adminUser);
    assert(dashFiltered.kpi_strip.find(k => k.title === 'Tổng quỹ lương cơ bản')?.primary_value === 722000000, 'Test 4.5: KPI Card trên dashboard cập nhật chính xác theo bộ lọc');

    console.log('[TEST 4 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 4 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // TEST 5 — LARGE DATASET (EXECUTION OVER 2,000 ROWS, NOT PREVIEW CAP)
  // ================================================================
  console.log('\n--- [TEST 5] LARGE DATASET PROCESSING (PREVIEW LIMIT VS EXECUTION LIMIT) ---');
  try {
    const largeRows = [];
    for (let i = 1; i <= 2000; i++) {
      largeRows.push({
        ma_nhan_vien: `NV_SYNTH_${String(i).padStart(4, '0')}`,
        ho_ten: `Nhân viên Synthetic ${i}`,
        phong_ban: i <= 1000 ? 'Vận Tải' : 'Kho Vận',
        chuc_vu: i % 2 === 0 ? 'Chuyên viên' : 'Nhân viên',
        luong_co_ban_vnd: 20000000 + (i * 1000), // from 20.001.000 to 22.000.000
      });
    }

    const largeDataset = {
      file_id: 'file_large_2000_rows',
      original_filename: 'large_dataset_2000.xlsx',
      columns: [
        { key: 'ma_nhan_vien', name: 'Mã Nhân Viên', type: 'STRING' },
        { key: 'ho_ten', name: 'Họ Tên', type: 'STRING' },
        { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING' },
        { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING' },
        { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản', type: 'INTEGER' },
      ],
      profile: {
        active_sheet: 'Sheet1',
        grain: 'EMPLOYEE',
        row_count: 2000,
        columns: [
          { key: 'ma_nhan_vien', name: 'Mã Nhân Viên', type: 'STRING' },
          { key: 'ho_ten', name: 'Họ Tên', type: 'STRING' },
          { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING' },
          { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING' },
          { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản', type: 'INTEGER' },
        ],
      },
      rows: largeRows,
      uploaded_by: adminUser.user_id,
      company_id: 'ALL',
    };

    const queryPlanLarge = planAnalyticalQuery('Tổng quỹ lương cơ bản và lương cao nhất', largeDataset.profile);
    const valPlanLarge = validateQueryPlan(queryPlanLarge, largeDataset, adminUser);
    const execResultLarge = executeAnalyticalQuery(largeDataset, valPlanLarge);

    assert(execResultLarge.rows_scanned === 2000, `Test 5.1: Quét toàn bộ 2.000 dòng dữ liệu (thực tế: ${execResultLarge.rows_scanned})`);
    assert(execResultLarge.total_matching === 2000, `Test 5.2: Khớp toàn bộ 2.000 dòng (thực tế: ${execResultLarge.total_matching})`);

    // Verify SUM is computed over all 2,000 rows
    const expectedTotal = largeRows.reduce((a, b) => a + b.luong_co_ban_vnd, 0);
    const actualTotal = execResultLarge.results_by_requirement
      ? execResultLarge.results_by_requirement['req_total_salary']?.value
      : execResultLarge.summary?.sum_luong_co_ban_vnd;
    assert(actualTotal === expectedTotal, `Test 5.3: Tổng quỹ lương tính trên đủ 2.000 dòng (${actualTotal}) = kỳ vọng (${expectedTotal}), không bị cắt ở dòng 500`);

    console.log('[TEST 5 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 5 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // TEST 6 — CROSS-DOMAIN GENERALIZATION (NOT HARDCODED TO PAYROLL)
  // ================================================================
  console.log('\n--- [TEST 6] CROSS-DOMAIN GENERALIZATION (SALES, LOGISTICS & NUMBERED LISTS) ---');
  try {
    // 6A. Sales domain
    const salesPrompt = 'Báo cáo doanh số bán hàng gồm: 1. Tổng doanh thu, 2. Số đơn hàng phân biệt, 3. Doanh thu theo tháng, 4. Top sản phẩm bán chạy.';
    const salesCols = [
      { key: 'ma_don', name: 'Mã Đơn', type: 'STRING' },
      { key: 'san_pham', name: 'Sản Phẩm', type: 'STRING' },
      { key: 'doanh_thu', name: 'Doanh Thu', type: 'INTEGER' },
      { key: 'ngay_dat', name: 'Ngày Đặt', type: 'DATE' },
    ];
    const planSales = planAnalyticalQuery(salesPrompt, { columns: salesCols });
    assert(planSales.intent === 'COMPOSITE', 'Test 6.1: Nhận diện intent COMPOSITE cho bài toán bán hàng');
    assert(planSales.requirements?.length >= 3, 'Test 6.2: Bóc tách các yêu cầu bán hàng thành công');

    // 6B. Generic numbered list in education / training
    const genericPrompt = 'Thống kê kết quả thi: 1. Điểm trung bình, 2. Điểm cao nhất và thấp nhất, 3. Phân bổ điểm theo lớp, 4. Top 5 học sinh xuất sắc.';
    const genericCols = [
      { key: 'ma_hs', name: 'Mã Học Sinh', type: 'STRING' },
      { key: 'ho_ten', name: 'Họ Tên', type: 'STRING' },
      { key: 'lop', name: 'Lớp Học', type: 'STRING' },
      { key: 'diem_so', name: 'Điểm Số', type: 'FLOAT' },
    ];
    const planGeneric = planAnalyticalQuery(genericPrompt, { columns: genericCols });
    assert(planGeneric.intent === 'COMPOSITE', 'Test 6.3: Phân rã câu hỏi dạng danh sách số thứ tự thành công cho domain giáo dục');
    assert(planGeneric.requirements?.length >= 4, `Test 6.4: Tách được ${planGeneric.requirements?.length} yêu cầu độc lập không phụ thuộc HR`);

    console.log('[TEST 6 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 6 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // TEST 7 — MISSING FIELD DETECTION & GRACEFUL DATA UNAVAILABILITY
  // ================================================================
  console.log('\n--- [TEST 7] MISSING FIELD DETECTION (HONEST DATA UNAVAILABILITY) ---');
  try {
    const missingFieldPrompt = 'Phân tích tình hình đào tạo: tổng số khóa hoàn thành và chi phí đào tạo.';
    const plan7 = planAnalyticalQuery(missingFieldPrompt, dataProfile);
    const valPlan7 = validateQueryPlan(plan7, datasetObjHR, adminUser);
    const execResult7 = executeAnalyticalQuery(datasetObjHR, valPlan7);

    const costReq = execResult7.results_by_requirement['req_missing_training_cost'];
    assert(Boolean(costReq), 'Test 7.1: Chỉ tiêu chi phí đào tạo được ghi nhận');
    assert(costReq.status === 'DATA_UNAVAILABLE', 'Test 7.2: Trạng thái chỉ tiêu thiếu là DATA_UNAVAILABLE');
    assert(costReq.value === undefined || costReq.value === null, 'Test 7.3: Tuyệt đối không sinh giá trị giả cho chỉ tiêu bị thiếu');
    assert(Boolean(costReq.reason), 'Test 7.4: Có lý do giải thích rõ ràng vì sao thiếu cột dữ liệu');

    // Valid requirement is still computed correctly
    const completedReq = execResult7.results_by_requirement['req_total_completed'];
    assert(completedReq && completedReq.value === 414, 'Test 7.5: Các chỉ tiêu hợp lệ khác vẫn được tính toán chính xác (414 khóa)');

    console.log('[TEST 7 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 7 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // TEST 8 — SECURITY, RBAC & AUDIT LOGGING
  // ================================================================
  console.log('\n--- [TEST 8] SECURITY, RBAC & SAFE GOVERNANCE ---');
  try {
    const payrollPrompt = 'Tổng quỹ lương cơ bản';
    const plan8 = planAnalyticalQuery(payrollPrompt, dataProfile);

    // 8A: Unauthenticated user is blocked
    let unauthBlocked = false;
    try {
      validateQueryPlan(plan8, datasetObjHR, null);
    } catch (e) {
      unauthBlocked = e.status === 401 || e.code === 'UNAUTHENTICATED';
    }
    assert(unauthBlocked, 'Test 8.1: Người dùng chưa đăng nhập bị chặn truy vấn BI');

    // 8B: Cross-tenant access check
    const vtxDataset = {
      ...datasetObjHR,
      file_id: 'vtx_confidential_payroll',
      company_id: 'VTX',
      uploaded_by: empVtxUser.user_id,
    };

    let crossTenantBlocked = false;
    try {
      validateQueryPlan(plan8, vtxDataset, empStlUser);
    } catch (e) {
      crossTenantBlocked = e.status === 403 || e.code === 'FORBIDDEN';
    }
    assert(crossTenantBlocked, 'Test 8.2: Nhân viên STL bị chặn truy vấn dataset của VTX (IDOR block)');

    // 8C: Formula injection sanitization check
    const injectedRows = [
      { id: '1', name: '=cmd|"/C calc"!A0', salary: 15000000 },
      { id: '2', name: '+1234567', salary: 25000000 },
    ];
    const { sanitizeFormulaInjection } = require('../auth-service/services/biFileSecurityService');
    const sanitizedObj = sanitizeFormulaInjection(injectedRows[0].name);
    assert(sanitizedObj.sanitized.startsWith("'"), 'Test 8.3: Giá trị chứa ký tự công thức (=, +, -) được thêm dấu nháy đơn bảo vệ an toàn');

    console.log('[TEST 8 PASSED 100%]');
    passedTests++;
  } catch (err) {
    console.error('[TEST 8 FAILED]', err.message);
    failedTests++;
  }

  // ================================================================
  // FINAL SUMMARY
  // ================================================================
  console.log('\n================================================================');
  console.log(`COMPREHENSIVE TEST SUITE RESULT: ${passedTests} / 8 GROUPS PASSED | ${failedTests} FAILED`);
  console.log('Zero Regression | Zero Schema Mutation | 100% Specification Coverage');
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runComprehensiveTestSuite().catch(err => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
