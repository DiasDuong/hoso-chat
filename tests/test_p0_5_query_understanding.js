/**
 * SOTRANS HUB — PHASE P0.5 REGRESSION TEST SUITE
 * 
 * Comprehensive Test Suite for BI Query Understanding & Semantic Accuracy:
 * 33 Detailed Vietnamese Scenarios:
 * 
 * 1. Số lượng nhân viên mỗi phòng ban
 * 2. Tổng lương mỗi phòng ban
 * 3. Lương trung bình mỗi phòng ban
 * 4. Tỷ trọng nhân viên mỗi phòng ban
 * 5. Số lượng nhân viên theo công ty
 * 6. Tổng số hồ sơ theo loại
 * 7. Tỷ lệ hồ sơ theo trạng thái
 * 8. Xu hướng upload theo tháng
 * 9. Top 5 nhân viên theo số lô xử lý
 * 10. So sánh hai phòng ban
 * 11. Lọc phòng ban sau câu hỏi trước (Multi-turn)
 * 12. Thay đổi từ COUNT sang SUM (Multi-turn)
 * 13. Thay đổi từ SUM sang AVG (Multi-turn)
 * 14. Thay đổi từ Bar sang Pie (Multi-turn)
 * 15. Người dùng sửa câu hỏi sau khi AI hiểu sai (Multi-turn Clarification)
 * 16. Câu hỏi thiếu thông tin phải được hỏi lại (Clarification)
 * 17. Đồng nghĩa và cách diễn đạt tiếng Việt khác nhau
 * 18. Lỗi chính tả thông thường nhưng không được suy diễn sai nghiệp vụ ("số lương")
 * 19. Tên cột không tồn tại
 * 20. Dataset thiếu employee identifier
 * 21. Đếm số nhân viên theo giới tính
 * 22. Thống kê nhân sự theo chức vụ
 * 23. Tổng chi phí lương theo từng công ty
 * 24. Lương cao nhất của mỗi phòng ban (MAX)
 * 25. Lương thấp nhất theo bộ phận (MIN)
 * 26. Trung vị lương theo phòng ban (MEDIAN)
 * 27. Cơ cấu phòng ban theo tỷ trọng doanh thu
 * 28. Multi-turn: Giữ metric nhân viên, đổi dimension sang công ty ("Còn theo công ty thì sao?")
 * 29. Multi-turn: Sắp xếp giảm dần ("Sắp xếp giảm dần")
 * 30. Multi-turn: Lấy top 3 ("Chỉ hiển thị top 3")
 * 31. Dữ liệu trùng mã nhân viên: DISTINCT_COUNT đếm chính xác không trùng lặp
 * 32. Presenter Consistency: Slices trên Pie chart và hàng trong Table hoàn toàn khớp nhau
 * 33. Tái hiện trọn vẹn Bug Incident: Prompt 1 và Prompt 2 đều cho query plan chuẩn nghiệp vụ
 */

const assert = require('assert');
const {
  planAnalyticalQuery,
  planFollowUpQuery,
  profileColumns,
  normalizeText,
} = require('../auth-service/services/biQueryPlanner');

const {
  validateQueryPlan,
  QueryValidationError,
} = require('../auth-service/services/biQueryValidator');

const {
  executeAnalyticalQuery,
} = require('../auth-service/services/biSpreadsheetEngine');

const {
  formatAnalyticalResultMarkdown,
} = require('../auth-service/services/biDatasetPresenter');

// Mock User Context
const USER_TEST = { user_id: 'usr_audit_001', username: 'auditor', role: 'ADMIN', company_id: 'ALL' };

// Mock Datasets
// 1. HR Dataset (Similar to Du_Lieu_Nhan_Su_Logistics_SOTRANS.xlsx)
const hrProfile = {
  file_id: 'ds_hr_001',
  active_sheet: 'HR_Data',
  columns: [
    { key: 'ma_nhan_vien', name: 'Mã Nhân Viên', type: 'STRING', cardinality: 150, is_unique: true },
    { key: 'ho_ten', name: 'Họ Và Tên', type: 'STRING', cardinality: 150 },
    { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING', cardinality: 5, top_values: [{ value: 'Nhân Sự' }, { value: 'Vận Tải' }, { value: 'Kế Toán' }, { value: 'Kho Vận' }, { value: 'CNTT' }] },
    { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING', cardinality: 6, top_values: [{ value: 'Chuyên Viên' }, { value: 'Trưởng Phòng' }, { value: 'Tài Xế' }] },
    { key: 'gioi_tinh', name: 'Giới Tính', type: 'STRING', cardinality: 2, top_values: [{ value: 'Nam' }, { value: 'Nữ' }] },
    { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản (VNĐ)', type: 'INTEGER' },
    { key: 'cong_ty', name: 'Công Ty', type: 'STRING', cardinality: 3, top_values: [{ value: 'SOTRANS Logistics' }, { value: 'Vietranstimex' }, { value: 'Sowatco' }] },
    { key: 'ngay_vao_lam', name: 'Ngày Vào Làm', type: 'DATE' },
  ],
};

const hrDataset = {
  file_id: 'ds_hr_001',
  original_filename: 'Du_Lieu_Nhan_Su_Logistics_SOTRANS.xlsx',
  profile: hrProfile,
  columns: hrProfile.columns,
  rows: [
    { ma_nhan_vien: 'NV001', ho_ten: 'Nguyễn Văn A', phong_ban: 'Nhân Sự', chuc_vu: 'Trưởng Phòng', gioi_tinh: 'Nam', luong_co_ban_vnd: 25000000, cong_ty: 'SOTRANS Logistics', ngay_vao_lam: '2020-01-15' },
    { ma_nhan_vien: 'NV002', ho_ten: 'Trần Thị B', phong_ban: 'Vận Tải', chuc_vu: 'Tài Xế', gioi_tinh: 'Nữ', luong_co_ban_vnd: 15000000, cong_ty: 'SOTRANS Logistics', ngay_vao_lam: '2021-03-20' },
    { ma_nhan_vien: 'NV003', ho_ten: 'Lê Văn C', phong_ban: 'Kế Toán', chuc_vu: 'Chuyên Viên', gioi_tinh: 'Nam', luong_co_ban_vnd: 18000000, cong_ty: 'Vietranstimex', ngay_vao_lam: '2019-06-10' },
    { ma_nhan_vien: 'NV004', ho_ten: 'Phạm Thị D', phong_ban: 'Nhân Sự', chuc_vu: 'Chuyên Viên', gioi_tinh: 'Nữ', luong_co_ban_vnd: 16000000, cong_ty: 'Sowatco', ngay_vao_lam: '2022-02-01' },
    { ma_nhan_vien: 'NV005', ho_ten: 'Vũ Văn E', phong_ban: 'Kho Vận', chuc_vu: 'Chuyên Viên', gioi_tinh: 'Nam', luong_co_ban_vnd: 14000000, cong_ty: 'SOTRANS Logistics', ngay_vao_lam: '2023-05-12' },
    { ma_nhan_vien: 'NV006', ho_ten: 'Hoàng Thị F', phong_ban: 'Vận Tải', chuc_vu: 'Chuyên Viên', gioi_tinh: 'Nữ', luong_co_ban_vnd: 20000000, cong_ty: 'Vietranstimex', ngay_vao_lam: '2018-11-25' },
  ],
};

// 2. Documents Dataset (Ho So)
const docsProfile = {
  file_id: 'ds_docs_002',
  active_sheet: 'Sheet1',
  columns: [
    { key: 'ma_ho_so', name: 'Mã Hồ Sơ', type: 'STRING', cardinality: 100, is_unique: true },
    { key: 'ten_ho_so', name: 'Tên Hồ Sơ', type: 'STRING', cardinality: 100 },
    { key: 'loai_ho_so', name: 'Loại Hồ Sơ', type: 'STRING', cardinality: 4, top_values: [{ value: 'Hợp Đồng' }, { value: 'Hóa Đơn' }, { value: 'Tờ Khai Hải Quan' }, { value: 'Vận Đơn' }] },
    { key: 'trang_thai', name: 'Trạng Thái', type: 'STRING', cardinality: 3, top_values: [{ value: 'Hoàn Thành' }, { value: 'Đang Xử Lý' }, { value: 'Chờ Duyệt' }] },
    { key: 'ngay_tao', name: 'Ngày Tạo', type: 'DATE' },
    { key: 'so_lo_xu_ly', name: 'Số Lô Xử Lý', type: 'INTEGER' },
    { key: 'nguoi_tao', name: 'Người Tạo', type: 'STRING', cardinality: 10 },
  ],
};

const docsDataset = {
  file_id: 'ds_docs_002',
  original_filename: 'Bao_Cao_Ho_So_Hai_Quan.xlsx',
  profile: docsProfile,
  columns: docsProfile.columns,
  rows: [
    { ma_ho_so: 'HS001', ten_ho_so: 'Hồ sơ A', loai_ho_so: 'Hợp Đồng', trang_thai: 'Hoàn Thành', ngay_tao: '2026-01-10', so_lo_xu_ly: 5, nguoi_tao: 'Nguyễn Văn A' },
    { ma_ho_so: 'HS002', ten_ho_so: 'Hồ sơ B', loai_ho_so: 'Hóa Đơn', trang_thai: 'Đang Xử Lý', ngay_tao: '2026-01-15', so_lo_xu_ly: 8, nguoi_tao: 'Trần Thị B' },
    { ma_ho_so: 'HS003', ten_ho_so: 'Hồ sơ C', loai_ho_so: 'Hợp Đồng', trang_thai: 'Hoàn Thành', ngay_tao: '2026-02-05', so_lo_xu_ly: 3, nguoi_tao: 'Nguyễn Văn A' },
    { ma_ho_so: 'HS004', ten_ho_so: 'Hồ sơ D', loai_ho_so: 'Tờ Khai Hải Quan', trang_thai: 'Chờ Duyệt', ngay_tao: '2026-02-20', so_lo_xu_ly: 12, nguoi_tao: 'Lê Văn C' },
    { ma_ho_so: 'HS005', ten_ho_so: 'Hồ sơ E', loai_ho_so: 'Vận Đơn', trang_thai: 'Hoàn Thành', ngay_tao: '2026-03-01', so_lo_xu_ly: 7, nguoi_tao: 'Trần Thị B' },
  ],
};

// 3. Sales Dataset
const salesProfile = {
  file_id: 'ds_sales_003',
  active_sheet: 'DoanhSo',
  columns: [
    { key: 'ma_don', name: 'Mã Đơn', type: 'STRING', cardinality: 80, is_unique: true },
    { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING', cardinality: 3, top_values: [{ value: 'Kinh Doanh' }, { value: 'Logistics' }, { value: 'Kho Vận' }] },
    { key: 'doanh_so', name: 'Doanh Số (VNĐ)', type: 'INTEGER' },
    { key: 'khach_hang', name: 'Khách Hàng', type: 'STRING', cardinality: 20 },
  ],
};

const salesDataset = {
  file_id: 'ds_sales_003',
  original_filename: 'Doanh_So_Q1.xlsx',
  profile: salesProfile,
  columns: salesProfile.columns,
  rows: [
    { ma_don: 'DH01', phong_ban: 'Kinh Doanh', doanh_so: 100000000, khach_hang: 'Vinamilk' },
    { ma_don: 'DH02', phong_ban: 'Kinh Doanh', doanh_so: 150000000, khach_hang: 'Masan' },
    { ma_don: 'DH03', phong_ban: 'Logistics', doanh_so: 80000000, khach_hang: 'Thaco' },
    { ma_don: 'DH04', phong_ban: 'Logistics', doanh_so: 120000000, khach_hang: 'Vinamilk' },
  ],
};

// Test Runner
let passCount = 0;
let failCount = 0;
const testResults = [];

async function test(scenarioId, title, testFn) {
  try {
    await testFn();
    passCount++;
    console.log(`[PASS] [${scenarioId}] ${title}`);
    testResults.push({ scenarioId, title, status: 'PASS' });
  } catch (err) {
    failCount++;
    console.error(`[FAIL] [${scenarioId}] ${title} -> ${err.message}`);
    testResults.push({ scenarioId, title, status: 'FAIL', error: err.message });
  }
}

async function runAllTests() {
  console.log('================================================================');
  console.log('SOTRANS HUB — P0.5 BI QUERY UNDERSTANDING REGRESSION TEST SUITE');
  console.log('Mode: Isolated In-Memory Schema Verification & Execution Audit');
  console.log('================================================================\n');

  // 1. Số lượng nhân viên mỗi phòng ban
  await test('SC-01', 'Số lượng nhân viên mỗi phòng ban', async () => {
    const plan = planAnalyticalQuery('Số lượng nhân viên mỗi phòng ban', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban'], 'groupBy must be [phong_ban]');
    assert.strictEqual(plan.aggregations[0].column, 'ma_nhan_vien', 'Aggregation column must be ma_nhan_vien');
    assert.strictEqual(plan.aggregations[0].func, 'DISTINCT_COUNT', 'Function must be DISTINCT_COUNT');
    assert.ok(!plan.groupBy.includes('ma_nhan_vien'), 'ma_nhan_vien MUST NOT be in groupBy');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    assert.deepStrictEqual(validated.groupBy, ['phong_ban']);
    assert.strictEqual(validated.aggregations[0].column, 'ma_nhan_vien');

    const res = executeAnalyticalQuery(hrDataset, validated);
    assert.ok(res.results.length > 0, 'Must produce aggregated results');
    const hrGroup = res.results.find((r) => r.phong_ban === 'Nhân Sự');
    assert.strictEqual(hrGroup.distinct_count_ma_nhan_vien, 2, 'Nhân Sự must have exactly 2 distinct employees');
  });

  // 2. Tổng lương mỗi phòng ban
  await test('SC-02', 'Tổng lương mỗi phòng ban', async () => {
    const plan = planAnalyticalQuery('Tổng lương mỗi phòng ban', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].column, 'luong_co_ban_vnd');
    assert.strictEqual(plan.aggregations[0].func, 'SUM');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const res = executeAnalyticalQuery(hrDataset, validated);
    const hrGroup = res.results.find((r) => r.phong_ban === 'Nhân Sự');
    assert.strictEqual(hrGroup.sum_luong_co_ban_vnd, 41000000, 'Nhân Sự total salary must be 41M');
  });

  // 3. Lương trung bình mỗi phòng ban
  await test('SC-03', 'Lương trung bình mỗi phòng ban', async () => {
    const plan = planAnalyticalQuery('Lương trung bình mỗi phòng ban', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].column, 'luong_co_ban_vnd');
    assert.strictEqual(plan.aggregations[0].func, 'AVG');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const res = executeAnalyticalQuery(hrDataset, validated);
    const hrGroup = res.results.find((r) => r.phong_ban === 'Nhân Sự');
    assert.strictEqual(hrGroup.avg_luong_co_ban_vnd, 20500000, 'Nhân Sự avg salary must be 20.5M');
  });

  // 4. Tỷ trọng nhân viên mỗi phòng ban
  await test('SC-04', 'Tỷ trọng nhân viên mỗi phòng ban', async () => {
    const plan = planAnalyticalQuery('Tỷ trọng nhân viên mỗi phòng ban', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].column, 'ma_nhan_vien');
    assert.strictEqual(plan.aggregations[0].func, 'DISTINCT_COUNT');
    assert.strictEqual(plan.chart_preference, 'PIE');
    assert.strictEqual(plan.computations[0].type, 'PERCENTAGE');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const res = executeAnalyticalQuery(hrDataset, validated);
    const hrGroup = res.results.find((r) => r.phong_ban === 'Nhân Sự');
    // Total employees = 6, Nhan Su = 2 -> 33.33%
    assert.strictEqual(hrGroup.distinct_count_ma_nhan_vien_ty_trong_pct, 33.33);
  });

  // 5. Số lượng nhân viên theo công ty
  await test('SC-05', 'Số lượng nhân viên theo công ty', async () => {
    const plan = planAnalyticalQuery('Số lượng nhân viên theo công ty', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['cong_ty']);
    assert.strictEqual(plan.aggregations[0].column, 'ma_nhan_vien');
    assert.strictEqual(plan.aggregations[0].func, 'DISTINCT_COUNT');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const res = executeAnalyticalQuery(hrDataset, validated);
    const stlGroup = res.results.find((r) => r.cong_ty === 'SOTRANS Logistics');
    assert.strictEqual(stlGroup.distinct_count_ma_nhan_vien, 3, 'STL must have 3 employees');
  });

  // 6. Tổng số hồ sơ theo loại
  await test('SC-06', 'Tổng số hồ sơ theo loại', async () => {
    const plan = planAnalyticalQuery('Tổng số hồ sơ theo loại', docsProfile);
    assert.deepStrictEqual(plan.groupBy, ['loai_ho_so']);
    assert.strictEqual(plan.aggregations[0].column, 'ma_ho_so');
    assert.strictEqual(plan.aggregations[0].func, 'DISTINCT_COUNT');

    const validated = validateQueryPlan(plan, docsDataset, USER_TEST);
    const res = executeAnalyticalQuery(docsDataset, validated);
    const hdGroup = res.results.find((r) => r.loai_ho_so === 'Hợp Đồng');
    assert.strictEqual(hdGroup.distinct_count_ma_ho_so, 2, 'Hop Dong has 2 records');
  });

  // 7. Tỷ lệ hồ sơ theo trạng thái
  await test('SC-07', 'Tỷ lệ hồ sơ theo trạng thái', async () => {
    const plan = planAnalyticalQuery('Tỷ lệ hồ sơ theo trạng thái', docsProfile);
    assert.deepStrictEqual(plan.groupBy, ['trang_thai']);
    assert.strictEqual(plan.chart_preference, 'PIE');
    assert.strictEqual(plan.computations[0].type, 'PERCENTAGE');

    const validated = validateQueryPlan(plan, docsDataset, USER_TEST);
    const res = executeAnalyticalQuery(docsDataset, validated);
    const doneGroup = res.results.find((r) => r.trang_thai === 'Hoàn Thành');
    // 3/5 = 60%
    assert.strictEqual(doneGroup.distinct_count_ma_ho_so_ty_trong_pct, 60);
  });

  // 8. Xu hướng upload theo tháng
  await test('SC-08', 'Xu hướng upload theo tháng', async () => {
    const plan = planAnalyticalQuery('Xu hướng upload theo tháng', docsProfile);
    assert.strictEqual(plan.groupBy[0].column, 'ngay_tao');
    assert.strictEqual(plan.groupBy[0].date_trunc, 'month');
    assert.strictEqual(plan.chart_preference, 'LINE');
    assert.strictEqual(plan.intent, 'TREND');

    const validated = validateQueryPlan(plan, docsDataset, USER_TEST);
    const res = executeAnalyticalQuery(docsDataset, validated);
    assert.strictEqual(res.results.length, 3, 'Must have 3 months (Jan, Feb, Mar 2026)');
  });

  // 9. Top 5 nhân viên theo số lô xử lý
  await test('SC-09', 'Top 5 nhân viên theo số lô xử lý', async () => {
    const plan = planAnalyticalQuery('Top 5 nhân viên theo số lô xử lý', docsProfile);
    assert.strictEqual(plan.limit, 5);
    assert.strictEqual(plan.aggregations[0].column, 'so_lo_xu_ly');
    assert.strictEqual(plan.aggregations[0].func, 'SUM');
    assert.strictEqual(plan.groupBy[0], 'nguoi_tao');

    const validated = validateQueryPlan(plan, docsDataset, USER_TEST);
    const res = executeAnalyticalQuery(docsDataset, validated);
    assert.strictEqual(res.results[0].nguoi_tao, 'Trần Thị B', 'Top 1 is Tran Thi B with 15 batches');
    assert.strictEqual(res.results[0].sum_so_lo_xu_ly, 15);
  });

  // 10. So sánh hai phòng ban
  await test('SC-10', 'So sánh hai phòng ban', async () => {
    const plan = planAnalyticalQuery('So sánh doanh số giữa phòng Kinh Doanh và phòng Logistics', salesProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].column, 'doanh_so');
    assert.strictEqual(plan.aggregations[0].func, 'SUM');
    assert.ok(plan.filters.length > 0, 'Should include filter for comparison');
  });

  // 11. Lọc phòng ban sau câu hỏi trước (Multi-turn)
  await test('SC-11', 'Lọc phòng ban sau câu hỏi trước (Multi-turn)', async () => {
    const turn1Plan = planAnalyticalQuery('Tổng lương mỗi phòng ban', hrProfile);
    const turn2Plan = planFollowUpQuery('Chỉ lấy phòng Nhân Sự', turn1Plan, hrProfile);
    assert.ok(turn2Plan, 'Follow-up plan must exist');
    assert.strictEqual(turn2Plan.filters.length, 1);
    assert.strictEqual(turn2Plan.filters[0].column, 'phong_ban');
    assert.strictEqual(turn2Plan.filters[0].value, 'Nhân Sự');
    assert.deepStrictEqual(turn2Plan.groupBy, ['phong_ban'], 'Dimension retained');
  });

  // 12. Thay đổi từ COUNT sang SUM (Multi-turn)
  await test('SC-12', 'Thay đổi từ COUNT sang SUM (Multi-turn)', async () => {
    const turn1Plan = planAnalyticalQuery('Số đơn hàng theo phòng ban', salesProfile);
    assert.strictEqual(turn1Plan.aggregations[0].func, 'DISTINCT_COUNT');

    const turn2Plan = planFollowUpQuery('Đổi sang tính tổng doanh số', turn1Plan, salesProfile);
    // Since this is a full query with a new metric ("tổng doanh số"), planFollowUpQuery forces fresh plan
    const finalPlan = turn2Plan || planAnalyticalQuery('Đổi sang tính tổng doanh số', salesProfile, { previousQueryPlan: turn1Plan });
    assert.strictEqual(finalPlan.aggregations[0].column, 'doanh_so');
    assert.strictEqual(finalPlan.aggregations[0].func, 'SUM');
  });

  // 13. Thay đổi từ SUM sang AVG (Multi-turn)
  await test('SC-13', 'Thay đổi từ SUM sang AVG (Multi-turn)', async () => {
    const turn1Plan = planAnalyticalQuery('Tổng lương mỗi phòng ban', hrProfile);
    assert.strictEqual(turn1Plan.aggregations[0].func, 'SUM');

    const turn2Plan = planFollowUpQuery('Đổi sang tính trung bình', turn1Plan, hrProfile);
    assert.ok(turn2Plan, 'Delta follow-up plan created');
    assert.strictEqual(turn2Plan.aggregations[0].func, 'AVG');
    assert.strictEqual(turn2Plan.aggregations[0].column, 'luong_co_ban_vnd');
  });

  // 14. Thay đổi từ Bar sang Pie (Multi-turn)
  await test('SC-14', 'Thay đổi từ Bar sang Pie (Multi-turn)', async () => {
    const turn1Plan = planAnalyticalQuery('Tổng lương mỗi phòng ban', hrProfile);
    assert.strictEqual(turn1Plan.chart_preference, 'BAR');

    const turn2Plan = planFollowUpQuery('Chuyển sang biểu đồ tròn', turn1Plan, hrProfile);
    assert.ok(turn2Plan);
    assert.strictEqual(turn2Plan.chart_preference, 'PIE');
    assert.deepStrictEqual(turn2Plan.groupBy, ['phong_ban']);
  });

  // 15. Người dùng sửa câu hỏi sau khi AI hiểu sai (Multi-turn Clarification)
  await test('SC-15', 'Người dùng sửa câu hỏi sau khi AI hiểu sai', async () => {
    // Simulating flawed previous plan
    const flawedPreviousPlan = {
      groupBy: ['ma_nhan_vien', 'phong_ban'],
      aggregations: [{ column: 'luong_co_ban_vnd', func: 'COUNT', alias: 'count_luong_co_ban_vnd' }],
      chart_preference: 'PIE',
    };

    const clarificationPrompt = 'Không phải, ý tôi là tạo pie chart về số lượng nhân viên của mỗi phòng ban';
    const rePlanned = planAnalyticalQuery(clarificationPrompt, hrProfile, { previousQueryPlan: flawedPreviousPlan });

    assert.deepStrictEqual(rePlanned.groupBy, ['phong_ban'], 'Must re-plan to pure phong_ban groupBy');
    assert.strictEqual(rePlanned.aggregations[0].column, 'ma_nhan_vien');
    assert.strictEqual(rePlanned.aggregations[0].func, 'DISTINCT_COUNT');
    assert.ok(!rePlanned.groupBy.includes('ma_nhan_vien'), 'ma_nhan_vien must NOT be in groupBy');
  });

  // 16. Câu hỏi thiếu thông tin phải được hỏi lại (Clarification)
  await test('SC-16', 'Câu hỏi thiếu thông tin phải được hỏi lại', async () => {
    const plan = planAnalyticalQuery('Tính toán giúp tôi', hrProfile);
    assert.strictEqual(plan.clarification_needed, true, 'Clarification needed must be true');
    assert.ok(plan.clarification_question.includes('phân tích'), 'Must offer a polite clarification prompt');
  });

  // 17. Đồng nghĩa và cách diễn đạt tiếng Việt khác nhau
  await test('SC-17', 'Đồng nghĩa và cách diễn đạt tiếng Việt khác nhau', async () => {
    const p1 = planAnalyticalQuery('Cơ cấu nhân sự cho từng bộ phận', hrProfile);
    assert.deepStrictEqual(p1.groupBy, ['phong_ban']);
    assert.strictEqual(p1.aggregations[0].func, 'DISTINCT_COUNT');

    const p2 = planAnalyticalQuery('Bao nhiêu cán bộ ở mỗi đơn vị', hrProfile);
    assert.deepStrictEqual(p2.groupBy, ['phong_ban']);
    assert.strictEqual(p2.aggregations[0].func, 'DISTINCT_COUNT');

    const p3 = planAnalyticalQuery('Phân bổ lao động theo phòng', hrProfile);
    assert.deepStrictEqual(p3.groupBy, ['phong_ban']);
    assert.strictEqual(p3.aggregations[0].func, 'DISTINCT_COUNT');
  });

  // 18. Lỗi chính tả thông thường nhưng không được suy diễn sai nghiệp vụ ("số lương")
  await test('SC-18', 'Lỗi chính tả thông thường: "số lương nhân viên"', async () => {
    const plan = planAnalyticalQuery('Tạo pie chart về số lương nhân viên của mỗi phòng ban trong file Excel trên.', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban'], 'Must group by phong_ban');
    assert.strictEqual(plan.aggregations[0].column, 'ma_nhan_vien', 'Must count employee ID, not salary measure');
    assert.strictEqual(plan.aggregations[0].func, 'DISTINCT_COUNT');
    assert.strictEqual(plan.chart_preference, 'PIE');
  });

  // 19. Tên cột không tồn tại
  await test('SC-19', 'Tên cột không tồn tại trong dataset', async () => {
    const invalidPlan = {
      groupBy: ['cot_khong_ton_tai'],
      aggregations: [{ column: 'luong_co_ban_vnd', func: 'SUM', alias: 'sum_val' }],
    };
    assert.throws(
      () => validateQueryPlan(invalidPlan, hrDataset, USER_TEST),
      /COLUMN_NOT_FOUND|không tồn tại/i,
      'Must reject non-existent column'
    );
  });

  // 20. Dataset thiếu employee identifier
  await test('SC-20', 'Dataset thiếu employee identifier', async () => {
    const datasetWithoutEmpId = {
      file_id: 'ds_no_emp_004',
      active_sheet: 'Summary',
      columns: [
        { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING', cardinality: 5 },
        { key: 'chi_phi_van_hanh', name: 'Chi Phí Vận Hành', type: 'INTEGER' },
        { key: 'nam', name: 'Năm', type: 'INTEGER' },
      ],
    };
    const plan = planAnalyticalQuery('Số lượng nhân viên mỗi phòng ban', datasetWithoutEmpId);
    assert.strictEqual(plan.clarification_needed, true, 'Must flag clarification needed');
    assert.ok(plan.clarification_question.includes('định danh nhân viên'), 'Must warn missing employee identifier');
  });

  // 21. Đếm số nhân viên theo giới tính
  await test('SC-21', 'Đếm số nhân viên theo giới tính', async () => {
    const plan = planAnalyticalQuery('Đếm số nhân viên theo giới tính', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['gioi_tinh']);
    assert.strictEqual(plan.aggregations[0].func, 'DISTINCT_COUNT');
    assert.strictEqual(plan.aggregations[0].column, 'ma_nhan_vien');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const res = executeAnalyticalQuery(hrDataset, validated);
    assert.strictEqual(res.results.length, 2, '2 genders: Nam and Nữ');
  });

  // 22. Thống kê nhân sự theo chức vụ
  await test('SC-22', 'Thống kê nhân sự theo chức vụ', async () => {
    const plan = planAnalyticalQuery('Thống kê số lượng nhân sự theo chức vụ', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['chuc_vu']);
    assert.strictEqual(plan.aggregations[0].func, 'DISTINCT_COUNT');
  });

  // 23. Tổng chi phí lương theo từng công ty
  await test('SC-23', 'Tổng chi phí lương theo từng công ty', async () => {
    const plan = planAnalyticalQuery('Tổng chi phí lương theo từng công ty', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['cong_ty']);
    assert.strictEqual(plan.aggregations[0].column, 'luong_co_ban_vnd');
    assert.strictEqual(plan.aggregations[0].func, 'SUM');
  });

  // 24. Lương cao nhất của mỗi phòng ban (MAX)
  await test('SC-24', 'Lương cao nhất của mỗi phòng ban (MAX)', async () => {
    const plan = planAnalyticalQuery('Lương cao nhất của mỗi phòng ban', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].func, 'MAX');
    assert.strictEqual(plan.aggregations[0].column, 'luong_co_ban_vnd');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const res = executeAnalyticalQuery(hrDataset, validated);
    const hrGroup = res.results.find((r) => r.phong_ban === 'Nhân Sự');
    assert.strictEqual(hrGroup.max_luong_co_ban_vnd, 25000000);
  });

  // 25. Lương thấp nhất theo bộ phận (MIN)
  await test('SC-25', 'Lương thấp nhất theo bộ phận (MIN)', async () => {
    const plan = planAnalyticalQuery('Lương thấp nhất theo bộ phận', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].func, 'MIN');
    assert.strictEqual(plan.aggregations[0].column, 'luong_co_ban_vnd');

    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const res = executeAnalyticalQuery(hrDataset, validated);
    const hrGroup = res.results.find((r) => r.phong_ban === 'Nhân Sự');
    assert.strictEqual(hrGroup.min_luong_co_ban_vnd, 16000000);
  });

  // 26. Trung vị lương theo phòng ban (MEDIAN)
  await test('SC-26', 'Trung vị lương theo phòng ban (MEDIAN)', async () => {
    const plan = planAnalyticalQuery('Trung vị lương theo phòng ban', hrProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].func, 'MEDIAN');
    assert.strictEqual(plan.aggregations[0].column, 'luong_co_ban_vnd');
  });

  // 27. Cơ cấu phòng ban theo tỷ trọng doanh thu
  await test('SC-27', 'Cơ cấu phòng ban theo tỷ trọng doanh thu', async () => {
    const plan = planAnalyticalQuery('Cơ cấu phòng ban theo tỷ trọng doanh thu', salesProfile);
    assert.deepStrictEqual(plan.groupBy, ['phong_ban']);
    assert.strictEqual(plan.aggregations[0].column, 'doanh_so');
    assert.strictEqual(plan.chart_preference, 'PIE');
    assert.strictEqual(plan.computations[0].type, 'PERCENTAGE');
  });

  // 28. Multi-turn: Giữ metric nhân viên, đổi dimension sang công ty
  await test('SC-28', 'Multi-turn: "Còn theo công ty thì sao?"', async () => {
    const turn1Plan = planAnalyticalQuery('Số lượng nhân viên mỗi phòng ban', hrProfile);
    assert.deepStrictEqual(turn1Plan.groupBy, ['phong_ban']);

    const turn2Plan = planFollowUpQuery('Còn theo công ty thì sao?', turn1Plan, hrProfile);
    assert.ok(turn2Plan, 'Follow-up plan created');
    assert.deepStrictEqual(turn2Plan.groupBy, ['cong_ty'], 'Switched dimension to cong_ty');
    assert.strictEqual(turn2Plan.aggregations[0].column, 'ma_nhan_vien', 'Retained ma_nhan_vien metric');
    assert.strictEqual(turn2Plan.aggregations[0].func, 'DISTINCT_COUNT');
  });

  // 29. Multi-turn: Sắp xếp giảm dần
  await test('SC-29', 'Multi-turn: "Sắp xếp giảm dần"', async () => {
    const turn1Plan = planAnalyticalQuery('Tổng lương mỗi phòng ban', hrProfile);
    turn1Plan.orderBy = { column: 'sum_luong_co_ban_vnd', dir: 'ASC' };

    const turn2Plan = planFollowUpQuery('Sắp xếp giảm dần', turn1Plan, hrProfile);
    assert.ok(turn2Plan);
    assert.strictEqual(turn2Plan.orderBy.dir, 'DESC');
  });

  // 30. Multi-turn: Lấy top 3
  await test('SC-30', 'Multi-turn: "Chỉ hiển thị top 3"', async () => {
    const turn1Plan = planAnalyticalQuery('Tổng lương mỗi phòng ban', hrProfile);
    const turn2Plan = planFollowUpQuery('Chỉ hiển thị top 3', turn1Plan, hrProfile);
    assert.ok(turn2Plan);
    assert.strictEqual(turn2Plan.limit, 3);
  });

  // 31. Dữ liệu trùng mã nhân viên: DISTINCT_COUNT đếm chính xác không trùng lặp
  await test('SC-31', 'Dữ liệu trùng mã nhân viên: DISTINCT_COUNT đếm chính xác không trùng lặp', async () => {
    // Dataset where NV001 has 3 timesheet entries in 'Nhân Sự'
    const duplicateDataset = {
      file_id: 'ds_dup_005',
      original_filename: 'Bang_Cham_Cong.xlsx',
      profile: hrProfile,
      columns: hrProfile.columns,
      rows: [
        { ma_nhan_vien: 'NV001', ho_ten: 'Nguyễn Văn A', phong_ban: 'Nhân Sự', luong_co_ban_vnd: 25000000 },
        { ma_nhan_vien: 'NV001', ho_ten: 'Nguyễn Văn A', phong_ban: 'Nhân Sự', luong_co_ban_vnd: 25000000 },
        { ma_nhan_vien: 'NV001', ho_ten: 'Nguyễn Văn A', phong_ban: 'Nhân Sự', luong_co_ban_vnd: 25000000 },
        { ma_nhan_vien: 'NV002', ho_ten: 'Trần Thị B', phong_ban: 'Nhân Sự', luong_co_ban_vnd: 15000000 },
      ],
    };

    const plan = planAnalyticalQuery('Số lượng nhân viên mỗi phòng ban', hrProfile);
    const validated = validateQueryPlan(plan, duplicateDataset, USER_TEST);
    const res = executeAnalyticalQuery(duplicateDataset, validated);

    const hrGroup = res.results.find((r) => r.phong_ban === 'Nhân Sự');
    // Must be exactly 2 distinct employees (NV001 and NV002), NOT 4!
    assert.strictEqual(hrGroup.distinct_count_ma_nhan_vien, 2, 'Must not duplicate count NV001');
  });

  // 32. Presenter Consistency: Slices trên Pie chart và hàng trong Table hoàn toàn khớp nhau
  await test('SC-32', 'Presenter Consistency: Slices trên Pie chart và hàng trong Table khớp nhau', async () => {
    const plan = planAnalyticalQuery('Tạo pie chart về số lượng nhân viên của mỗi phòng ban', hrProfile);
    const validated = validateQueryPlan(plan, hrDataset, USER_TEST);
    const queryResult = executeAnalyticalQuery(hrDataset, validated);

    const md = formatAnalyticalResultMarkdown(validated, queryResult, hrDataset, 'Nhận xét phân tích nhân sự');

    // Verification:
    // Slices in Pie chart must NOT have employee IDs NV001, NV002 as slices
    assert.ok(!md.includes('NV001: <tspan'), 'Pie chart MUST NOT have individual employee IDs as slices');
    assert.ok(!md.includes('NV002: <tspan'), 'Pie chart MUST NOT have individual employee IDs as slices');

    // Slices must have department names
    assert.ok(md.includes('Nhân Sự: <tspan') || md.includes('Nhân Sự'), 'Pie chart must include Nhân Sự group');
    assert.ok(md.includes('Vận Tải: <tspan') || md.includes('Vận Tải'), 'Pie chart must include Vận Tải group');

    // Table must have department headers and rows
    assert.ok(md.includes('| phong_ban | distinct_count_ma_nhan_vien |'), 'Table header must match grouping dimension and distinct count');
  });

  // 33. Tái hiện trọn vẹn Bug Incident: Prompt 1 và Prompt 2 đều cho query plan chuẩn nghiệp vụ
  await test('SC-33', 'Tái hiện trọn vẹn Bug Incident: Turn 1 typo + Turn 2 clarification', async () => {
    // Turn 1: User prompt with typo
    const prompt1 = 'Tạo pie chart về số lương nhân viên của mỗi phòng ban trong file Excel trên.';
    const turn1Plan = planAnalyticalQuery(prompt1, hrProfile);

    assert.deepStrictEqual(turn1Plan.groupBy, ['phong_ban'], 'Turn 1 groupBy must be [phong_ban]');
    assert.strictEqual(turn1Plan.aggregations[0].column, 'ma_nhan_vien', 'Turn 1 aggregation must be ma_nhan_vien');
    assert.strictEqual(turn1Plan.aggregations[0].func, 'DISTINCT_COUNT');
    assert.strictEqual(turn1Plan.chart_preference, 'PIE');
    assert.ok(!turn1Plan.groupBy.includes('ma_nhan_vien'), 'ma_nhan_vien MUST NOT be in groupBy');

    // Turn 2: User prompt clarification with previous context
    const prompt2 = 'Tạo pie chart về số lượng nhân viên của mỗi phòng ban trong file Excel trên.';
    const turn2Plan = planAnalyticalQuery(prompt2, hrProfile, { previousQueryPlan: turn1Plan });

    assert.deepStrictEqual(turn2Plan.groupBy, ['phong_ban'], 'Turn 2 groupBy must be [phong_ban]');
    assert.strictEqual(turn2Plan.aggregations[0].column, 'ma_nhan_vien', 'Turn 2 aggregation must be ma_nhan_vien');
    assert.strictEqual(turn2Plan.aggregations[0].func, 'DISTINCT_COUNT');
    assert.strictEqual(turn2Plan.chart_preference, 'PIE');
    assert.ok(!turn2Plan.groupBy.includes('ma_nhan_vien'), 'ma_nhan_vien MUST NOT be in groupBy');

    // Execute Turn 2
    const validatedTurn2 = validateQueryPlan(turn2Plan, hrDataset, USER_TEST);
    const resTurn2 = executeAnalyticalQuery(hrDataset, validatedTurn2);

    assert.strictEqual(resTurn2.results.length, 4, 'Must return 4 department groups');
    const totalEmployees = resTurn2.results.reduce((acc, r) => acc + r.distinct_count_ma_nhan_vien, 0);
    assert.strictEqual(totalEmployees, 6, 'Sum of department employee counts must match total distinct employees (6)');
  });

  console.log('\n================================================================');
  console.log(`P0.5 REGRESSION TEST SUITE RESULT: ${passCount} / ${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('Production Touch: ZERO | PostgreSQL HR Schema Change: ZERO');
  console.log('================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
