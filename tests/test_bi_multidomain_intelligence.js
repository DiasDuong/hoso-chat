'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const { processAndProfileDataset, executeAnalyticalQuery } = require('../auth-service/services/biSpreadsheetEngine');
const { planAnalyticalQuery, decomposeCompositeRequirements } = require('../auth-service/services/biQueryPlanner');
const { validateQueryPlan } = require('../auth-service/services/biQueryValidator');
const { buildDatasetDashboard } = require('../auth-service/services/biReportBuilder');
const { formatAnalyticalResultMarkdown } = require('../auth-service/services/biDatasetPresenter');

const userContext = { user_id: 'test_user_bi_multidomain', username: 'admin', role: 'ADMIN' };

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    throw new Error(message);
  }
  console.log(`[PASS] ${message}`);
}

async function runAllTests() {
  console.log('================================================================');
  console.log('SOTRANS HUB — BI MULTI-DOMAIN INTELLIGENCE ACCEPTANCE TEST SUITE');
  console.log('Testing Cases: HR Training, Sales/Orders, Logistics, Robustness, 2000-Row Boundary');
  console.log('================================================================\n');

  // ================================================================
  // CASE A: HR TRAINING & KPI PERFORMANCE ON BAO_CAO_DEMO_SOLIEU.xlsx
  // ================================================================
  console.log('--- [CASE A] NHÂN SỰ & ĐÀO TẠO (BAO_CAO_DEMO_SOLIEU.xlsx - HR_Data) ---');
  let demoPath = path.join(__dirname, '..', 'BAO_CAO_DEMO_SOLIEU.xlsx');
  if (!fs.existsSync(demoPath)) {
    demoPath = path.join(__dirname, '../auth-service/uploads/382cd016-3bfb-48e2-86d4-4bea4c03675f_Du_Lieu_Nhan_Su_Logistics_SOTRANS.xlsx');
  }
  assert(fs.existsSync(demoPath), 'File BAO_CAO_DEMO_SOLIEU.xlsx (hoặc tệp HR demo tương đương) tồn tại');

  const demoBuffer = fs.readFileSync(demoPath);
  const metadataA = {
    file_id: 'test_hr_training_demo_file',
    original_filename: 'BAO_CAO_DEMO_SOLIEU.xlsx',
    file_extension: '.xlsx',
    file_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  const { dataProfile, datasetJsonPath } = await processAndProfileDataset(metadataA, demoBuffer);
  assert(dataProfile.sheets.some(s => s.name === 'HR_Data'), 'Workbook chứa sheet HR_Data');
  assert(dataProfile.grain === 'EMPLOYEE', `Hệ thống nhận diện grain của file là ${dataProfile.grain} (${dataProfile.grain_description})`);

  const trainingPrompt = 'Báo cáo tình hình đào tạo nhân sự: tổng số khóa hoàn thành, số khóa trung bình mỗi người, số người có 0 khóa, thống kê theo phòng ban, top 10 nhân viên có số khóa đào tạo cao nhất, và phân tích KPI theo số khóa đào tạo từ 0 đến 5.';

  // 1. Query Planner decomposition
  const queryPlanA = planAnalyticalQuery(trainingPrompt, dataProfile);
  assert(queryPlanA.intent === 'COMPOSITE', 'Query Planner nhận diện đúng intent COMPOSITE');
  assert(Array.isArray(queryPlanA.requirements) && queryPlanA.requirements.length === 6, 'Query Planner bóc tách đủ 6 yêu cầu con độc lập');

  // 2. Query Validator
  const storedJsonA = JSON.parse(fs.readFileSync(datasetJsonPath, 'utf8'));
  const datasetObjA = {
    file_id: metadataA.file_id,
    original_filename: metadataA.original_filename,
    columns: dataProfile.columns,
    profile: dataProfile,
    rows: storedJsonA.sheets['HR_Data'].rows,
  };

  const validatedPlanA = validateQueryPlan(queryPlanA, datasetObjA, userContext);
  assert(validatedPlanA.requirements && validatedPlanA.requirements.length === 6, 'Validator xác thực thành công toàn bộ 6 yêu cầu con');

  // 3. Analytical Query Execution
  const queryResultA = executeAnalyticalQuery(datasetObjA, validatedPlanA);
  const resByReqA = queryResultA.results_by_requirement;
  assert(Boolean(resByReqA), 'Engine trả về results_by_requirement');

  // 4. Exact Reference Numbers Verification:
  // (1) Total completed courses: 414
  assert(resByReqA['req_total_completed'].value === 414, `(1) Tổng số khóa hoàn thành = ${resByReqA['req_total_completed'].value} (Kỳ vọng: 414 lượt hoàn thành)`);

  // (2) Average per employee: 2.76
  assert(resByReqA['req_avg_completed'].value === 2.76, `(2) Số khóa trung bình mỗi người = ${resByReqA['req_avg_completed'].value} (Kỳ vọng: 2.76 khóa/người)`);

  // (3) Employees with 0 courses: 21
  assert(resByReqA['req_zero_courses'].value === 21, `(3) Số nhân sự có 0 khóa = ${resByReqA['req_zero_courses'].value} (Kỳ vọng: 21 người)`);

  // (4) Completions by 6 departments summing to 414
  const deptDataA = resByReqA['req_dept_breakdown'].data;
  assert(deptDataA.length === 6, `(4a) Đủ 6 phòng ban: ${deptDataA.map(d => d.phong_ban).join(', ')}`);
  const expectedDepts = {
    'Nhân Sự': 92,
    'Vận Tải': 87,
    'Kho Vận': 62,
    'Chăm Sóc Khách Hàng': 61,
    'Kế Toán': 56,
    'Công Nghệ Thông Tin (IT)': 56,
  };
  let sumDeptCompletions = 0;
  for (const d of deptDataA) {
    sumDeptCompletions += d.tong_khoa_hoan_thanh;
    const exp = expectedDepts[d.phong_ban];
    if (exp !== undefined) {
      assert(d.tong_khoa_hoan_thanh === exp, `(4b) Phòng ${d.phong_ban} = ${d.tong_khoa_hoan_thanh} lượt (Kỳ vọng: ${exp})`);
    }
  }
  assert(sumDeptCompletions === 414, `(4c) Tổng 6 phòng ban cộng lại = ${sumDeptCompletions} lượt (Khớp chính xác 414)`);
  assert(queryResultA.reconciliation?.is_balanced === true, `(4d) Đối chiếu toàn tập balanced = true (group_sum: ${queryResultA.reconciliation.group_sum} = total_metric: ${queryResultA.reconciliation.total_metric})`);

  // (5) Top 10 employees by courses with deterministic tie-breaking (Courses DESC, KPI DESC, Mã NV ASC)
  const top10DataA = resByReqA['req_top_10_employees'].data;
  assert(top10DataA.length === 10, '(5a) Top 10 có đúng 10 nhân viên');
  const expectedTop10Ids = ['NV122', 'NV120', 'NV121', 'NV093', 'NV014', 'NV066', 'NV095', 'NV117', 'NV007', 'NV084'];
  const actualTop10Ids = top10DataA.map(r => r.ma_nhan_vien);
  assert(JSON.stringify(actualTop10Ids) === JSON.stringify(expectedTop10Ids), `(5b) Thứ tự Top 10 tie-breaking chuẩn xác: ${actualTop10Ids.join(', ')}`);
  assert(top10DataA[0].khoa_dao_tao_hoan_thanh === 5 && top10DataA[0].diem_kpi === 99.3, `(5c) #1 là NV122 (5 khóa, KPI 99.3)`);
  assert(top10DataA[9].khoa_dao_tao_hoan_thanh === 5 && top10DataA[9].diem_kpi === 89.1, `(5d) #10 là NV084 (5 khóa, KPI 89.1)`);

  // (6) KPI by course count from 0 to 5
  const kpiCorrData = resByReqA['req_kpi_by_courses'].data;
  assert(kpiCorrData.length === 6, '(6a) Có đủ 6 mức khóa đào tạo từ 0 đến 5');
  const expectedKpiByCourse = [
    { so_khoa: 0, count: 21, avgKpi: 85.58 },
    { so_khoa: 1, count: 21, avgKpi: 80.66 },
    { so_khoa: 2, count: 24, avgKpi: 79.13 },
    { so_khoa: 3, count: 24, avgKpi: 85.12 },
    { so_khoa: 4, count: 27, avgKpi: 81.87 },
    { so_khoa: 5, count: 33, avgKpi: 80.31 },
  ];
  for (let i = 0; i < 6; i++) {
    const item = kpiCorrData[i];
    const exp = expectedKpiByCourse[i];
    assert(item.so_nhan_vien === exp.count, `(6b) Mức ${exp.so_khoa} khóa: ${item.so_nhan_vien} nhân sự (Kỳ vọng: ${exp.count})`);
    assert(Math.abs(item.avg_kpi - exp.avgKpi) < 0.05, `(6c) Mức ${exp.so_khoa} khóa: Điểm KPI trung bình = ${item.avg_kpi} (Kỳ vọng: ${exp.avgKpi})`);
  }

  // 5. Dashboard V2 Construction Verification
  const dashboardPayloadA = buildDatasetDashboard(validatedPlanA, queryResultA, datasetObjA, userContext);
  assert(dashboardPayloadA.version === '2.0', 'Dashboard Payload V2 được tạo thành công');
  assert(!dashboardPayloadA.kpi_strip.some(k => k.kpi_code === 'FILE_SUM_SALARY' || k.metric_alias === 'sum_salary'), 'Dashboard V2 KHÔNG bị chèn KPI quỹ lương');
  assert(!dashboardPayloadA.visualizations.some(v => v.chart_type === 'PIE' && v.id.includes('status')), 'Dashboard V2 KHÔNG bị chèn biểu đồ trạng thái nhân sự');
  assert(dashboardPayloadA.kpi_strip.length >= 3, `Dashboard V2 có ${dashboardPayloadA.kpi_strip.length} KPI cards khớp yêu cầu đào tạo`);
  assert(dashboardPayloadA.visualizations.length >= 2, `Dashboard V2 có ${dashboardPayloadA.visualizations.length} visualizations đúng yêu cầu`);
  assert(dashboardPayloadA.data_tables.length >= 3, `Dashboard V2 có ${dashboardPayloadA.data_tables.length} tables đúng yêu cầu`);

  // 6. Presenter Markdown Generation Verification
  const aiInsightTextA = 'Dữ liệu đào tạo ghi nhận 414 lượt hoàn thành trên toàn bộ 150 nhân sự. Mối liên hệ giữa số khóa đào tạo và điểm KPI: Nhóm có 0 khóa đào tạo đạt KPI trung bình 85,58 điểm, trong khi nhóm 5 khóa đạt 80,31 điểm. Điều này phản ánh hiệu quả công việc và KPI được thúc đẩy bởi nhiều yếu tố thực tế (kinh nghiệm, kỹ năng thực chiến) chứ không chỉ phụ thuộc vào số lượng khóa đào tạo.';
  const markdownReportA = formatAnalyticalResultMarkdown(validatedPlanA, queryResultA, datasetObjA, aiInsightTextA, userContext);
  assert(markdownReportA.includes('414 lượt hoàn thành'), 'Markdown chứa tổng số 414 lượt hoàn thành');
  assert(markdownReportA.includes('2,76 khóa/người'), 'Markdown chứa số khóa trung bình 2,76');
  assert(markdownReportA.includes('21 nhân sự') || markdownReportA.includes('21 người'), 'Markdown chứa 21 người có 0 khóa');
  assert(markdownReportA.includes('NV122'), 'Markdown bảng Top 10 chứa nhân viên dẫn đầu NV122');
  assert(markdownReportA.includes('bi-dashboard-v2'), 'Markdown chứa payload bi-dashboard-v2 chuẩn');
  console.log('[CASE A PASSED 100%]\n');

  // ================================================================
  // CASE B: SALES & ORDERS (MULTI-LINE ORDERS)
  // ================================================================
  console.log('--- [CASE B] KINH DOANH & ĐƠN HÀNG (MULTI-LINE ORDERS) ---');
  // Build a test multi-line order dataset: 10 rows, but only 4 distinct orders
  const salesRows = [
    { ma_don: 'ORD_001', ngay_dat: '2026-01-10', san_pham: 'Laptop Dell', so_luong: 1, doanh_thu: 20000000 },
    { ma_don: 'ORD_001', ngay_dat: '2026-01-10', san_pham: 'Chuột Logitech', so_luong: 2, doanh_thu: 1000000 },
    { ma_don: 'ORD_002', ngay_dat: '2026-01-15', san_pham: 'Bàn phím cơ', so_luong: 1, doanh_thu: 2500000 },
    { ma_don: 'ORD_002', ngay_dat: '2026-01-15', san_pham: 'Màn hình Dell 27', so_luong: 1, doanh_thu: 7500000 },
    { ma_don: 'ORD_003', ngay_dat: '2026-02-05', san_pham: 'Laptop Dell', so_luong: 2, doanh_thu: 40000000 },
    { ma_don: 'ORD_003', ngay_dat: '2026-02-05', san_pham: 'Tai nghe Sony', so_luong: 1, doanh_thu: 3000000 },
    { ma_don: 'ORD_004', ngay_dat: '2026-02-20', san_pham: 'Laptop Dell', so_luong: 1, doanh_thu: 20000000 },
    { ma_don: 'ORD_004', ngay_dat: '2026-02-20', san_pham: 'Chuột Logitech', so_luong: 3, doanh_thu: 1500000 },
    { ma_don: 'ORD_004', ngay_dat: '2026-02-20', san_pham: 'Bàn phím cơ', so_luong: 2, doanh_thu: 5000000 },
    { ma_don: 'ORD_004', ngay_dat: '2026-02-20', san_pham: 'Màn hình Dell 27', so_luong: 1, doanh_thu: 7500000 },
  ];

  const salesColumns = [
    { name: 'Mã Đơn', key: 'ma_don', type: 'STRING', semantic_role: 'IDENTIFIER', cardinality: 4 },
    { name: 'Ngày Đặt', key: 'ngay_dat', type: 'DATE', semantic_role: 'DIMENSION_TEMPORAL' },
    { name: 'Sản Phẩm', key: 'san_pham', type: 'STRING', semantic_role: 'DIMENSION_CATEGORY', cardinality: 5 },
    { name: 'Số Lượng', key: 'so_luong', type: 'INTEGER', semantic_role: 'MEASURE_QUANTITY' },
    { name: 'Doanh Thu', key: 'doanh_thu', type: 'INTEGER', semantic_role: 'MEASURE_CURRENCY' },
  ];

  const salesProfile = {
    file_id: 'test_sales_file',
    original_filename: 'BAN_HANG_2026.xlsx',
    active_sheet: 'Sheet1',
    columns: salesColumns,
    grain: 'ORDER_ITEM',
    grain_description: 'Mỗi dòng là một sản phẩm của đơn hàng',
  };

  const salesPrompt = 'Báo cáo doanh số bán hàng: tổng doanh thu, số đơn hàng phân biệt, doanh thu theo tháng và top sản phẩm bán chạy nhất.';
  const queryPlanB = planAnalyticalQuery(salesPrompt, salesProfile);
  assert(queryPlanB.intent === 'COMPOSITE', 'Query Planner nhận diện đúng intent COMPOSITE cho bài toán bán hàng');
  assert(queryPlanB.requirements.some(r => r.id === 'req_distinct_orders'), 'Có yêu cầu đếm số đơn phân biệt (DISTINCT_COUNT)');

  const salesDataset = {
    file_id: 'test_sales_file',
    original_filename: 'BAN_HANG_2026.xlsx',
    columns: salesColumns,
    profile: salesProfile,
    rows: salesRows,
  };

  const validatedPlanB = validateQueryPlan(queryPlanB, salesDataset, userContext);
  const queryResultB = executeAnalyticalQuery(salesDataset, validatedPlanB);
  const resByReqB = queryResultB.results_by_requirement;

  // Expected numbers:
  // 10 total rows scanned
  assert(queryResultB.rows_scanned === 10, 'Quét đủ 10 dòng sản phẩm');
  // Total revenue = 20 + 1 + 2.5 + 7.5 + 40 + 3 + 20 + 1.5 + 5 + 7.5 = 108,000,000 VNĐ
  assert(resByReqB['req_total_revenue'].value === 108000000, `Tổng doanh thu = ${resByReqB['req_total_revenue'].value} VNĐ (Kỳ vọng: 108.000.000 VNĐ)`);
  // Distinct orders: exactly 4 orders (ORD_001, ORD_002, ORD_003, ORD_004), NOT 10 rows!
  assert(resByReqB['req_distinct_orders'].value === 4, `Số đơn hàng phân biệt = ${resByReqB['req_distinct_orders'].value} đơn (Kỳ vọng: 4 đơn, KHÔNG nhầm thành 10 dòng)`);
  // Monthly trend: Jan = 31M, Feb = 77M
  const trendB = resByReqB['req_monthly_revenue'].data;
  assert(trendB.length === 2, 'Có 2 tháng (Tháng 1 & Tháng 2)');
  assert(trendB[0].tong_doanh_thu === 31000000, 'Tháng 1 = 31.000.000 VNĐ');
  assert(trendB[1].tong_doanh_thu === 77000000, 'Tháng 2 = 77.000.000 VNĐ');
  // Top product: Laptop Dell = 80M
  const topProdB = resByReqB['req_top_products'].data;
  assert(topProdB[0].san_pham === 'Laptop Dell' && topProdB[0].tong_doanh_thu === 80000000, 'Top 1 sản phẩm là Laptop Dell với 80.000.000 VNĐ');
  console.log('[CASE B PASSED 100%]\n');

  // ================================================================
  // CASE C: LOGISTICS & ON-TIME DELIVERY RATE
  // ================================================================
  console.log('--- [CASE C] LOGISTICS & TỶ LỆ GIAO HÀNG ĐÚNG HẠN ---');
  // 12 shipments across 2 carriers: VNPost (6 shipments), ViettelPost (6 shipments)
  // VNPost: 5 Da_giao (4 on time, 1 late), 1 Dang_giao (pending) -> on-time rate = 4/5 = 80% (denominator excludes pending)
  // ViettelPost: 4 Da_giao (4 on time), 2 Dang_giao (pending) -> on-time rate = 4/4 = 100%
  const logRows = [
    { ma_vd: 'VD01', don_vi_van_chuyen: 'VNPost', ngay_giao_cam_ket: '2026-03-05', ngay_giao_thuc_te: '2026-03-04', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD02', don_vi_van_chuyen: 'VNPost', ngay_giao_cam_ket: '2026-03-05', ngay_giao_thuc_te: '2026-03-05', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD03', don_vi_van_chuyen: 'VNPost', ngay_giao_cam_ket: '2026-03-06', ngay_giao_thuc_te: '2026-03-06', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD04', don_vi_van_chuyen: 'VNPost', ngay_giao_cam_ket: '2026-03-07', ngay_giao_thuc_te: '2026-03-07', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD05', don_vi_van_chuyen: 'VNPost', ngay_giao_cam_ket: '2026-03-08', ngay_giao_thuc_te: '2026-03-10', trang_thai: 'Da_giao' }, // LATE (10 > 8)
    { ma_vd: 'VD06', don_vi_van_chuyen: 'VNPost', ngay_giao_cam_ket: '2026-03-15', ngay_giao_thuc_te: null, trang_thai: 'Dang_giao' },        // PENDING
    { ma_vd: 'VD07', don_vi_van_chuyen: 'ViettelPost', ngay_giao_cam_ket: '2026-03-05', ngay_giao_thuc_te: '2026-03-04', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD08', don_vi_van_chuyen: 'ViettelPost', ngay_giao_cam_ket: '2026-03-06', ngay_giao_thuc_te: '2026-03-05', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD09', don_vi_van_chuyen: 'ViettelPost', ngay_giao_cam_ket: '2026-03-07', ngay_giao_thuc_te: '2026-03-07', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD10', don_vi_van_chuyen: 'ViettelPost', ngay_giao_cam_ket: '2026-03-08', ngay_giao_thuc_te: '2026-03-08', trang_thai: 'Da_giao' }, // on time
    { ma_vd: 'VD11', don_vi_van_chuyen: 'ViettelPost', ngay_giao_cam_ket: '2026-03-15', ngay_giao_thuc_te: null, trang_thai: 'Dang_giao' },        // PENDING
    { ma_vd: 'VD12', don_vi_van_chuyen: 'ViettelPost', ngay_giao_cam_ket: '2026-03-16', ngay_giao_thuc_te: null, trang_thai: 'Dang_giao' },        // PENDING
  ];

  const logColumns = [
    { name: 'Mã Vận Đơn', key: 'ma_vd', type: 'STRING', semantic_role: 'IDENTIFIER' },
    { name: 'Đơn Vị Vận Chuyển', key: 'don_vi_van_chuyen', type: 'STRING', semantic_role: 'DIMENSION_CATEGORY' },
    { name: 'Ngày Giao Cam Kết', key: 'ngay_giao_cam_ket', type: 'DATE', semantic_role: 'DIMENSION_TEMPORAL' },
    { name: 'Ngày Giao Thực Tế', key: 'ngay_giao_thuc_te', type: 'DATE', semantic_role: 'DIMENSION_TEMPORAL' },
    { name: 'Trạng Thái', key: 'trang_thai', type: 'STRING', semantic_role: 'DIMENSION_CATEGORY' },
  ];

  const logProfile = {
    file_id: 'test_logistics_file',
    original_filename: 'LOGISTICS_GIAO_HANG.xlsx',
    active_sheet: 'Sheet1',
    columns: logColumns,
    grain: 'SHIPMENT',
    grain_description: 'Mỗi dòng là một vận đơn giao hàng',
  };

  const logPrompt = 'Báo cáo tỷ lệ giao hàng đúng hạn theo đơn vị vận chuyển.';
  const queryPlanC = planAnalyticalQuery(logPrompt, logProfile);
  assert(queryPlanC.intent === 'COMPOSITE', 'Query Planner nhận diện đúng intent COMPOSITE cho logistics');
  assert(queryPlanC.requirements.some(r => r.type === 'RATIO'), 'Có yêu cầu tính RATIO (tỷ lệ đúng hạn)');

  const logDataset = {
    file_id: 'test_logistics_file',
    original_filename: 'LOGISTICS_GIAO_HANG.xlsx',
    columns: logColumns,
    profile: logProfile,
    rows: logRows,
  };

  const validatedPlanC = validateQueryPlan(queryPlanC, logDataset, userContext);
  const queryResultC = executeAnalyticalQuery(logDataset, validatedPlanC);
  const ratioDataC = queryResultC.results_by_requirement['req_on_time_rate'].data;

  // Verify ViettelPost: 4 delivered, 2 pending, 4 on-time -> 100%
  const vtp = ratioDataC.find(c => c.don_vi_van_chuyen === 'ViettelPost');
  assert(vtp.da_giao === 4 && vtp.chua_giao === 2, 'ViettelPost: 4 đã giao, 2 chưa giao');
  assert(vtp.ty_le_dung_han_pct === 100, `ViettelPost: Tỷ lệ đúng hạn = ${vtp.ty_le_dung_han_pct}% (Kỳ vọng: 100%)`);

  // Verify VNPost: 5 delivered, 1 pending, 4 on-time -> 80% (denominator is 5 delivered, NOT 6 total!)
  const vnp = ratioDataC.find(c => c.don_vi_van_chuyen === 'VNPost');
  assert(vnp.da_giao === 5 && vnp.chua_giao === 1, 'VNPost: 5 đã giao, 1 chưa giao');
  assert(vnp.giao_dung_han === 4, 'VNPost: 4 đơn đúng hạn');
  assert(vnp.ty_le_dung_han_pct === 80, `VNPost: Tỷ lệ đúng hạn = ${vnp.ty_le_dung_han_pct}% (Kỳ vọng: 80% = 4 / 5 đã giao, loại trừ đơn chưa giao)`);
  console.log('[CASE C PASSED 100%]\n');

  // ================================================================
  // CASE D: ROBUSTNESS & REPORTING MISSING DATA CLEANLY
  // ================================================================
  console.log('--- [CASE D] KHẢ NĂNG THÍCH ỨNG & THIẾU DỮ LIỆU ---');
  // Prompt asks for training cost which does NOT exist in HR_Data
  const promptMissing = 'Báo cáo chi phí đào tạo và số khóa học trung bình của nhân sự.';
  const queryPlanD = planAnalyticalQuery(promptMissing, dataProfile);
  assert(queryPlanD.intent === 'COMPOSITE', 'Query Planner nhận diện intent COMPOSITE');
  const missingReq = queryPlanD.requirements.find(r => r.id === 'req_missing_training_cost');
  assert(missingReq && missingReq.status === 'DATA_UNAVAILABLE', 'Yêu cầu chi phí đào tạo được gắn cờ DATA_UNAVAILABLE');

  const validatedPlanD = validateQueryPlan(queryPlanD, datasetObjA, userContext);
  const queryResultD = executeAnalyticalQuery(datasetObjA, validatedPlanD);
  const markdownReportD = formatAnalyticalResultMarkdown(validatedPlanD, queryResultD, datasetObjA, '', userContext);

  assert(markdownReportD.includes('Chỉ Tiêu Chưa Thể Tính Toán (Thiếu Dữ Liệu)'), 'Báo cáo có phần cảnh báo thiếu dữ liệu');
  assert(markdownReportD.includes('Chi phí đào tạo'), 'Nêu đích danh chỉ tiêu bị thiếu là Chi phí đào tạo');
  assert(!markdownReportD.includes('3.429.000.000 VNĐ') && !markdownReportD.includes('Tổng Quỹ Lương'), 'Tuyệt đối KHÔNG tự ý lấy quỹ lương thay thế cho chi phí đào tạo bị thiếu');
  console.log('[CASE D PASSED 100%]\n');

  // ================================================================
  // CASE E: 2.000-ROW BOUNDARY VERIFICATION
  // ================================================================
  console.log('--- [CASE E] FILE 2.000 DÒNG & RANH GIỚI 500 DÒNG ---');
  // Create 2000 rows dataset where significant values are after row 500
  // e.g. rows 1 to 500 have 1 course each (sum = 500)
  // rows 501 to 2000 have 3 courses each (1500 * 3 = 4500)
  // Total completions on 2000 rows = 500 + 4500 = 5,000! (If capped at 500 rows, it would wrongly be 500)
  // Row 1999 has special employee NV_LATE_1999
  const rows2000 = [];
  for (let i = 1; i <= 2000; i++) {
    const isAfter500 = i > 500;
    const code = i === 1999 ? 'NV_LATE_1999' : `NV_${String(i).padStart(4, '0')}`;
    rows2000.push({
      ma_nv: code,
      ho_ten: `Nhân viên ${i}`,
      phong_ban: i % 2 === 0 ? 'Kinh Doanh' : 'Vận Tải',
      khoa_dao_tao: isAfter500 ? 3 : 1,
      diem_kpi: 80.0,
    });
  }

  const columns2000 = [
    { name: 'Mã NV', key: 'ma_nv', type: 'STRING', semantic_role: 'IDENTIFIER', cardinality: 2000 },
    { name: 'Họ Tên', key: 'ho_ten', type: 'STRING', semantic_role: 'LABEL' },
    { name: 'Phòng Ban', key: 'phong_ban', type: 'STRING', semantic_role: 'DIMENSION_CATEGORY', cardinality: 2 },
    { name: 'Khóa Đào Tạo', key: 'khoa_dao_tao', type: 'INTEGER', semantic_role: 'MEASURE_QUANTITY' },
    { name: 'Điểm KPI', key: 'diem_kpi', type: 'FLOAT', semantic_role: 'MEASURE_RATING' },
  ];

  const dataset2000 = {
    file_id: 'test_dataset_2000_rows',
    original_filename: 'DANH_SACH_2000_NV.xlsx',
    columns: columns2000,
    profile: { active_sheet: 'Sheet1', columns: columns2000 },
    rows: rows2000,
  };

  const plan2000 = {
    intent: 'AGGREGATION',
    target_sheet: 'Sheet1',
    groupBy: ['phong_ban'],
    aggregations: [
      { column: 'khoa_dao_tao', func: 'SUM', alias: 'sum_khoa_dao_tao' },
      { column: 'ma_nv', func: 'DISTINCT_COUNT', alias: 'distinct_count_ma_nv' },
    ],
    filters: [],
    include_detail_rows: true,
  };

  const validatedPlan2000 = validateQueryPlan(plan2000, dataset2000, userContext);
  const result2000 = executeAnalyticalQuery(dataset2000, validatedPlan2000);

  // 1. All 2,000 rows scanned
  assert(result2000.rows_scanned === 2000, 'Quét đủ 2.000 dòng dữ liệu');
  assert(result2000.total_matching === 2000, 'Số dòng khớp là 2.000 dòng');

  // 2. Total calculation uses all 2000 rows (sum must be 5000, NOT 500!)
  const totalCoursesSum = result2000.results.reduce((acc, r) => acc + r.sum_khoa_dao_tao, 0);
  assert(totalCoursesSum === 5000, `Tổng khóa đào tạo tính trên toàn bộ 2.000 dòng = ${totalCoursesSum} (Kỳ vọng: 5.000, không bị cắt ở dòng 500)`);

  // 3. Late filter: filtering for NV_LATE_1999 (at row 1999)
  const lateFilterPlan = {
    intent: 'FILTER',
    target_sheet: 'Sheet1',
    filters: [{ column: 'ma_nv', op: 'eq', value: 'NV_LATE_1999' }],
    needs_details: true,
  };
  const valLatePlan = validateQueryPlan(lateFilterPlan, dataset2000, userContext);
  const lateResult = executeAnalyticalQuery(dataset2000, valLatePlan);
  assert(lateResult.total_matching === 1 && lateResult.results[0].ma_nv === 'NV_LATE_1999', 'Lọc chính xác bản ghi NV_LATE_1999 nằm ở dòng 1999 của file 2.000 dòng');

  // 4. Detail snapshot slice is strictly capped at MAX_ROWS_PER_DATASET = 500
  const detailSlice = result2000.multi_visual.detail_rows;
  assert(detailSlice.length === 500, `Bảng snapshot chi tiết được giới hạn chính xác ${detailSlice.length} dòng (MAX_ROWS_PER_DATASET = 500)`);

  // 5. Dashboard V2 title format: "Hiển thị 500 trong 2.000 dòng"
  const dash2000 = buildDatasetDashboard(validatedPlan2000, result2000, dataset2000, userContext);
  const detailTable2000 = dash2000.data_tables.find(t => t.id === 'tbl_details');
  assert(detailTable2000.title.includes('Hiển thị 500 trong 2.000 dòng'), `Tiêu đề bảng chi tiết: "${detailTable2000.title}"`);
  console.log('[CASE E PASSED 100%]\n');

  console.log('================================================================');
  console.log('TẤT CẢ 5 NHÓM CA KIỂM THỬ ĐÃ ĐẠT 100% TIÊU CHUẨN KỸ THUẬT VÀ NGHIỆP VỤ!');
  console.log('================================================================');
}

runAllTests().catch((err) => {
  console.error('\n[FATAL ERROR IN TEST SUITE]:', err);
  process.exit(1);
});
