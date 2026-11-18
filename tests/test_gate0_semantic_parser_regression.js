/**
 * SOTRANS HUB — GATE 0 SEMANTIC PARSER REPRODUCTION & REGRESSION TEST
 * 
 * Tests natural language query planning in biQueryPlanner.js:
 * 1. "Thống kê số lượng nhân sự theo từng phòng ban" -> No Nhan Su filter, group by phong_ban, metric count
 * 2. "Top 5 phòng ban có nhiều nhân sự nhất" -> No Nhan Su filter, rank by distinct_count/count of employees, limit 5
 * 3. "Chỉ lấy dữ liệu phòng Nhân Sự" -> Filter phong_ban = 'Nhan Su' preserved
 * 
 * Covers: Diacritics/no diacritics, casing, "nhân viên", "nhân sự", "phòng Nhân Sự", "bộ phận nhân sự", and follow-ups.
 */

const assert = require('assert');
const path = require('path');
const { planAnalyticalQuery } = require('../auth-service/services/biQueryPlanner');

// Synthetic dataset profile matching synthetic-150.xlsx
const mockProfile = {
  active_sheet: 'NhanSu',
  row_count: 150,
  column_count: 6,
  columns: [
    { key: 'ma_nhan_vien', name: 'Mã nhân viên', type: 'STRING', is_identifier: true },
    {
      key: 'phong_ban',
      name: 'Phòng ban',
      type: 'STRING',
      is_dimension: true,
      cardinality: 6,
      top_values: [
        { value: 'Kho Van', count: 35 },
        { value: 'Logistics', count: 30 },
        { value: 'Ke Toan', count: 25 },
        { value: 'Nhan Su', count: 24 },
        { value: 'Kinh Doanh', count: 20 },
        { value: 'Ky Thuat', count: 16 }
      ]
    },
    { key: 'luong_co_ban', name: 'Lương cơ bản', type: 'INTEGER', is_measure: true },
    { key: 'ngay_tuyen_dung', name: 'Ngày tuyển dụng', type: 'DATE', is_date: true },
    {
      key: 'trang_thai',
      name: 'Trạng thái',
      type: 'STRING',
      is_dimension: true,
      cardinality: 3,
      top_values: [
        { value: 'PROBATION', count: 50 },
        { value: 'INACTIVE', count: 50 },
        { value: 'ACTIVE', count: 50 }
      ]
    },
    {
      key: 'chi_nhanh',
      name: 'Chi nhánh',
      type: 'STRING',
      is_dimension: true,
      cardinality: 3,
      top_values: [
        { value: 'STL', count: 50 },
        { value: 'VTX', count: 50 },
        { value: 'SWC', count: 50 }
      ]
    }
  ]
};

console.log('=== STARTING GATE 0 SEMANTIC PARSER REPRODUCTION & REGRESSION TEST ===\n');

const testCases = [
  // GROUP 1: Department breakdown queries using "nhân sự" or "nhân viên" (MUST NOT filter Nhan Su)
  {
    category: 'GROUP 1: Group By Department (No False Nhan Su Filter)',
    prompts: [
      'Thống kê số lượng nhân sự theo từng phòng ban',
      'Thong ke so luong nhan su theo tung phong ban',
      'THỐNG KÊ SỐ LƯỢNG NHÂN SỰ THEO TỪNG PHÒNG BAN',
      'Thống kê số lượng nhân viên theo từng phòng ban',
      'Đếm nhân sự của mỗi phòng ban',
      'Phân bổ nhân sự theo phòng ban',
      'Cơ cấu nhân sự theo từng phòng ban'
    ],
    validate: (plan, prompt) => {
      // Must group by phong_ban
      const hasGroupByDept = (plan.groupBy || []).some(g => (typeof g === 'string' ? g : g.column) === 'phong_ban');
      assert.ok(hasGroupByDept, `Prompt "${prompt}" must group by phong_ban, got groupBy: ${JSON.stringify(plan.groupBy)}`);

      // Must NOT filter phong_ban = 'Nhan Su'
      const hasNhanSuFilter = (plan.filters || []).some(f => f.column === 'phong_ban' && /nhan\s*su/i.test(f.value));
      assert.strictEqual(hasNhanSuFilter, false, `Prompt "${prompt}" must NOT have filter phong_ban = 'Nhan Su', got filters: ${JSON.stringify(plan.filters)}`);

      // Metric must be COUNT or DISTINCT_COUNT on employee identifier or row
      const agg = plan.aggregations?.[0];
      assert.ok(agg, `Prompt "${prompt}" must have aggregations`);
      assert.ok(['DISTINCT_COUNT', 'COUNT'].includes(agg.func), `Prompt "${prompt}" agg func must be COUNT or DISTINCT_COUNT, got ${agg.func}`);
      assert.ok(['ma_nhan_vien', '*'].includes(agg.column), `Prompt "${prompt}" agg col must be ma_nhan_vien or *, got ${agg.column}`);
    }
  },

  // GROUP 2: Top N ranking queries (Rank by headcount, NOT SUM salary, NO false Nhan Su filter)
  {
    category: 'GROUP 2: Top Headcount Ranking (Headcount Metric, Limit 5, No False Filter)',
    prompts: [
      'Top 5 phòng ban có nhiều nhân sự nhất',
      'top 5 phong ban co nhieu nhan su nhat',
      'TOP 5 PHÒNG BAN CÓ NHIỀU NHÂN SỰ NHẤT',
      'Top 5 phòng ban có nhiều nhân viên nhất',
      'Top 5 phòng ban đông nhân sự nhất',
      'Top 5 phòng ban quy mô nhân sự lớn nhất',
      '5 phòng ban có số lượng nhân sự cao nhất'
    ],
    validate: (plan, prompt) => {
      // Must group by phong_ban or intent RANKING on phong_ban
      const hasGroupByDept = (plan.groupBy || []).some(g => (typeof g === 'string' ? g : g.column) === 'phong_ban');
      assert.ok(hasGroupByDept, `Prompt "${prompt}" must group by phong_ban, got groupBy: ${JSON.stringify(plan.groupBy)}`);

      // Must NOT filter phong_ban = 'Nhan Su'
      const hasNhanSuFilter = (plan.filters || []).some(f => f.column === 'phong_ban' && /nhan\s*su/i.test(f.value));
      assert.strictEqual(hasNhanSuFilter, false, `Prompt "${prompt}" must NOT have filter phong_ban = 'Nhan Su', got filters: ${JSON.stringify(plan.filters)}`);

      // Metric must be COUNT / DISTINCT_COUNT, NOT SUM salary
      const agg = plan.aggregations?.[0];
      assert.ok(agg, `Prompt "${prompt}" must have aggregations`);
      assert.ok(['DISTINCT_COUNT', 'COUNT'].includes(agg.func), `Prompt "${prompt}" agg func must be COUNT or DISTINCT_COUNT, got ${agg.func}`);
      assert.notStrictEqual(agg.column, 'luong_co_ban', `Prompt "${prompt}" must NOT rank by luong_co_ban`);

      // Limit must be 5
      assert.strictEqual(plan.limit, 5, `Prompt "${prompt}" limit must be 5, got ${plan.limit}`);
    }
  },

  // GROUP 3: Explicit HR Department Filter (MUST preserve filter phong_ban = 'Nhan Su')
  {
    category: 'GROUP 3: Explicit HR Department Filter (Must Preserve Filter)',
    prompts: [
      'Chỉ lấy dữ liệu phòng Nhân Sự',
      'chi lay du lieu phong nhan su',
      'CHỈ LẤY DỮ LIỆU PHÒNG NHÂN SỰ',
      'Lọc danh sách nhân viên phòng Nhân Sự',
      'Báo cáo nhân viên thuộc bộ phận nhân sự',
      'Chỉ xem số liệu phòng ban Nhân Sự'
    ],
    validate: (plan, prompt) => {
      const hasNhanSuFilter = (plan.filters || []).some(f => f.column === 'phong_ban' && /nhan\s*su/i.test(f.value));
      assert.strictEqual(hasNhanSuFilter, true, `Prompt "${prompt}" MUST have filter phong_ban = 'Nhan Su', got filters: ${JSON.stringify(plan.filters)}`);
    }
  }
];

let totalTests = 0;
let passTests = 0;
let failTests = 0;

for (const grp of testCases) {
  console.log(`--- ${grp.category} ---`);
  for (const prompt of grp.prompts) {
    totalTests++;
    try {
      const plan = planAnalyticalQuery(prompt, mockProfile);
      grp.validate(plan, prompt);
      passTests++;
      console.log(`  [PASS] "${prompt}"`);
    } catch (err) {
      failTests++;
      console.error(`  [FAIL] "${prompt}" -> ${err.message}`);
    }
  }
  console.log('');
}

console.log('================================================================');
console.log(`TOTAL: ${passTests} / ${totalTests} PASSED (${failTests} FAILED)`);
console.log('================================================================');

if (failTests > 0) {
  process.exit(1);
}
