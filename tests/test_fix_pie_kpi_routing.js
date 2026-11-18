const assert = require('assert');
const { planAnalyticalQuery } = require('../auth-service/services/biQueryPlanner');
const { detectBIIntent } = require('../auth-service/services/biReportingHelper');
const { formatAnalyticalResultMarkdown } = require('../auth-service/services/biDatasetPresenter');

console.log('================================================================');
console.log('SOTRANS HUB — VERIFICATION TEST: PIE CHART, KPI CARDS & FILE BI ROUTING');
console.log('================================================================');

const hrDatasetProfile = {
  file_id: 'test-dataset-hr-001',
  original_filename: 'Du_Lieu_Nhan_Su_Logistics_SOTRANS.xlsx',
  active_sheet: 'HR_Data',
  row_count: 150,
  column_count: 11,
  columns: [
    { key: 'ma_nhan_vien', name: 'Mã Nhân Viên', type: 'STRING', cardinality: 150 },
    { key: 'ho_ten', name: 'Họ Tên', type: 'STRING', cardinality: 148 },
    { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING', cardinality: 6, top_values: [{ value: 'Nhân Sự', count: 30 }, { value: 'Vận Tải', count: 31 }, { value: 'Kế Toán', count: 24 }] },
    { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING', cardinality: 20 },
    { key: 'ngay_vao_lam', name: 'Ngày Vào Làm', type: 'DATE', cardinality: 146 },
    { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản (VNĐ)', type: 'INTEGER', cardinality: 39 },
    { key: 'diem_kpi', name: 'Điểm KPI', type: 'FLOAT', cardinality: 125 },
    { key: 'so_ngay_nghi', name: 'Số Ngày Nghỉ', type: 'INTEGER', cardinality: 16 },
    { key: 'gio_tang_ca', name: 'Giờ Tăng Ca', type: 'INTEGER', cardinality: 85 },
    { key: 'khoa_dao_tao_hoan_thanh', name: 'Khóa Đào Tạo Hoàn Thành', type: 'INTEGER', cardinality: 6 },
    { key: 'trang_thai', name: 'Trạng Thái', type: 'STRING', cardinality: 3, top_values: [{ value: 'Đang làm việc', count: 128 }, { value: 'Đã nghỉ việc', count: 15 }, { value: 'Thai sản', count: 7 }] }
  ]
};

// --- TEST 1: Pie chart work status does NOT aggregate salary ---
console.log('\n[TEST 1] "hãy tạo pie chart liên quan đến trạng thái làm việc của các nhân viên"');
const p1 = planAnalyticalQuery('hãy tạo pie chart liên quan đến trạng thái làm việc của các nhân viên', hrDatasetProfile);
assert.strictEqual(p1.intent, 'DISTRIBUTION');
assert.deepStrictEqual(p1.groupBy, ['trang_thai']);
assert.strictEqual(p1.aggregations[0].column, 'ma_nhan_vien');
assert.strictEqual(p1.aggregations[0].func, 'DISTINCT_COUNT');
assert.strictEqual(p1.chart_preference, 'PIE');
assert.notStrictEqual(p1.aggregations[0].column, 'luong_co_ban_vnd', 'Must NOT aggregate salary when user asks for employee work status!');
console.log('  -> PASS: Groups by trang_thai, DISTINCT_COUNT on ma_nhan_vien, Pie chart preference.');

// --- TEST 2: Multi-turn does NOT hijack new pie chart request with previous salary metric ---
console.log('\n[TEST 2] Multi-turn follow-up with previous salary plan');
const prevSalaryPlan = {
  intent: 'AGGREGATION',
  groupBy: ['phong_ban'],
  aggregations: [{ func: 'SUM', column: 'luong_co_ban_vnd', alias: 'sum_luong_co_ban_vnd' }],
  chart_preference: 'BAR'
};
const p2 = planAnalyticalQuery('hãy tạo pie chart liên quan đến trạng thái làm việc của các nhân viên', hrDatasetProfile, { previousQueryPlan: prevSalaryPlan });
assert.deepStrictEqual(p2.groupBy, ['trang_thai']);
assert.strictEqual(p2.aggregations[0].column, 'ma_nhan_vien');
assert.strictEqual(p2.aggregations[0].func, 'DISTINCT_COUNT');
assert.strictEqual(p2.chart_preference, 'PIE');
console.log('  -> PASS: Fresh plan executed, previous salary plan did not hijack work status pie chart.');

// --- TEST 3: "dựa vào file trên ... Top 10" does NOT create false filters ---
console.log('\n[TEST 3] "dựa vào file trên hãy xây dựng báo cáo BI phân tích quỹ lương nhân sự... Top 10..."');
const prompt3 = 'dựa vào file trên hãy xây dựng báo cáo BI phân tích quỹ lương nhân sự. Yêu cầu: - Tổng quỹ lương cơ bản... - So sánh lương trung bình giữa các chức vụ. - Top 10 nhân viên có lương cao nhất. Sử dụng KPI Cards, Bar Chart, Pie Chart và bảng xếp hạng.';
const p3 = planAnalyticalQuery(prompt3, hrDatasetProfile);
assert.strictEqual(p3.filters.length, 0, 'Must NOT contain false filter on ma_nhan_vien >= 10 or phong_ban = Nhân Sự');
assert.strictEqual(p3.limit, 10);
assert.strictEqual(p3.aggregations[0].column, 'luong_co_ban_vnd');
console.log('  -> PASS: Zero false filters generated (no false ma_nhan_vien >= 10, no false phong_ban = Nhân Sự).');

// --- TEST 4: Routing guard in detectBIIntent ---
console.log('\n[TEST 4] detectBIIntent does NOT hijack file queries');
const biResult1 = detectBIIntent('Hãy tạo báo cáo BI phân tích cơ cấu nhân sự của 6 phòng ban ( từ file excel mới tải lên)');
assert.strictEqual(biResult1.isBIQuery, false, 'Queries with "(từ file excel mới tải lên)" must NOT trigger corporate BI!');

const biResult2 = detectBIIntent('dựa vào file trên hãy xây dựng báo cáo BI phân tích quỹ lương nhân sự. Sử dụng KPI Cards');
assert.strictEqual(biResult2.isBIQuery, false, 'Queries with "dựa vào file trên" must NOT trigger corporate BI!');
console.log('  -> PASS: File-targeting queries are not hijacked by corporate BI.');

// --- TEST 5: Total rows preserved in structured report for Active Dataset Bar ---
console.log('\n[TEST 5] structuredReport includes total_rows = 150 for Active Dataset Bar');
const mockDataset = {
  file_id: 'test-dataset-hr-001',
  original_filename: 'Du_Lieu_Nhan_Su_Logistics_SOTRANS.xlsx',
  profile: { row_count: 150 },
  rows: new Array(150).fill({})
};
const mockQueryResult = {
  total_matching: 150,
  rows_scanned: 150,
  results: [
    { trang_thai: 'Đang làm việc', distinct_count_ma_nhan_vien: 128 },
    { trang_thai: 'Đã nghỉ việc', distinct_count_ma_nhan_vien: 15 },
    { trang_thai: 'Thai sản', distinct_count_ma_nhan_vien: 7 }
  ]
};
const markdown = formatAnalyticalResultMarkdown(p1, mockQueryResult, mockDataset);
const match = markdown.match(/<!-- bi-file-report:\s*(\{[\s\S]*?\})\s*-->/);
assert(match, 'Must generate bi-file-report comment');
const parsed = JSON.parse(match[1]);
assert.strictEqual(parsed.total_rows, 150, 'total_rows must be 150');
assert.strictEqual(parsed.row_count, 150, 'row_count must be 150');
assert.strictEqual(parsed.returned_rows, 3, 'returned_rows is 3');
console.log('  -> PASS: structuredReport contains total_rows = 150, row_count = 150 (returned_rows is 3).');

console.log('\n================================================================');
console.log('ALL 5/5 FIX VERIFICATION TESTS PASSED 100%!');
console.log('================================================================');
