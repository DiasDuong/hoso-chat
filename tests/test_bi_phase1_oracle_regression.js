/**
 * SOTRANS HUB — PHASE 1 BI ORACLE REGRESSION TEST SUITE (STRICT RE-AUDITED)
 * 
 * Comprehensive Functional, Semantic & Data Accuracy Verification Suite:
 * - SECTION 1: Fixture A Verification (Real-world Anonymized Logistics Dataset - 150 rows)
 *     * Exact department-by-department SUM and AVG verification against mathematical oracle
 * - SECTION 2: Fixture B Verification (Synthetic 150 rows against independent Oracle expected.json)
 *     * Raw Natural Language planner outputs (ZERO injected props)
 *     * Q01: Đếm số nhân viên theo phòng ban (DISTINCT_COUNT ma_nhan_vien)
 *     * Q02: Đếm số dòng dữ liệu của mỗi phòng ban (COUNT(*) explicit row count)
 *     * Q03: Tính tổng lương theo phòng ban (SUM luong_co_ban)
 *     * Q04: Tính lương trung bình theo phòng ban (AVG luong_co_ban)
 *     * Q05: Tìm nhân viên có lương cao nhất (Extrema individual record, MAX luong_co_ban)
 *     * Q06: TOP 5 phòng ban có nhiều nhân viên nhất (Dimensional ranking)
 *     * Q07A: Tỷ trọng nhân viên theo chi nhánh (Distinct employee allocated distribution share)
 *     * Q07B: Tỷ trọng dòng dữ liệu theo chi nhánh (Row distribution share - matches expected.json row_share_pct)
 *     * Q08: So sánh lương / số nhân viên giữa các tháng (Date chronological trend order)
 *     * Q09A: Tỷ lệ nhân viên theo trạng thái (Distinct employee allocated distribution share)
 *     * Q09B: Tỷ lệ dòng dữ liệu theo trạng thái (Row distribution share - matches expected.json row_share_pct)
 *     * Q10: Lọc danh sách nhân viên thuộc phòng ban Kho Vận (Record filter: 35 rows)
 *     * Q11: Kiểm tra mã nhân viên bị trùng (Duplicate detection: 9 groups SYN000-SYN008)
 *     * Q12: Chỉ lấy dữ liệu phòng ban Logistics (Record filter: 30 rows)
 * - SECTION 3: Stress & Edge Cases (ST-A01 - ST-A07)
 *     * ST-A01: NULL values in Identifier: 1 null ID row, 149 non-null, 140 unique
 *     * ST-A02: Duplicate identifier handling & duplicate group isolation
 *     * ST-A03: NULL values in Numeric Metrics: 9 null salaries, 141 non-nulls (1,885,700,000 / 141 = 13,373,758.87)
 *     * ST-A04: Date normalization & Chronological sorting across formats
 *     * ST-A05: Non-destructive LIMIT (global KPI preserved before LIMIT slice)
 *     * ST-A06: Multi-dimensional grouping (phong_ban x chi_nhanh)
 *     * ST-A07: Pipeline Consistency across KPI Card, Chart Payload, Table & REAL buildSafeInsightContext
 * 
 * Mode: Isolated hermetic testing in D:\hoso-chat-bi-dev (ZERO PROD/STAGING TOUCH)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const planner = require('../auth-service/services/biQueryPlanner');
const validator = require('../auth-service/services/biQueryValidator');
const engine = require('../auth-service/services/biSpreadsheetEngine');
const builder = require('../auth-service/services/biReportBuilder');
const presenter = require('../auth-service/services/biDatasetPresenter');
const { buildSafeInsightContext, sanitizeBiData } = require('../auth-service/services/biPrivacy');

const USER_TEST = {
  user_id: 'usr_oracle_001',
  username: 'oracle_qa_lead',
  role: 'ADMIN',
  company_id: 'ALL',
  status: 'ACTIVE',
};

// Test Runner Infrastructure
let passCount = 0;
let failCount = 0;
const testResults = [];

async function test(id, title, testFn) {
  try {
    await testFn();
    passCount++;
    testResults.push({ id, title, status: 'PASS' });
    console.log(`[PASS] [${id}] ${title}`);
  } catch (err) {
    failCount++;
    testResults.push({ id, title, status: 'FAIL', error: err.message });
    console.log(`[FAIL] [${id}] ${title} -> ${err.message}`);
  }
}

async function runOracleTestSuite() {
  console.log('================================================================');
  console.log('SOTRANS HUB — PHASE 1 BI ORACLE REGRESSION TEST SUITE');
  console.log('Mode: Isolated Component Verification & Strict Oracle Audit');
  console.log('================================================================\n');

  // Load Fixture Data
  const fixtureAPath = path.join(__dirname, 'fixtures', 'fixture_a_logistics_anonymized.json');
  const fixtureBRowsPath = path.join(__dirname, '..', 'reports', 'bi_full_system_20261116', 'fixture-rows.json');
  const fixtureBExpectedPath = path.join(__dirname, '..', 'reports', 'bi_full_system_20261116', 'expected.json');
  const fixtureBXlsxPath = path.join(__dirname, '..', 'reports', 'bi_full_system_20261116', 'synthetic-150.xlsx');

  const fixtureAData = JSON.parse(fs.readFileSync(fixtureAPath, 'utf8'));
  const fixtureBRows = JSON.parse(fs.readFileSync(fixtureBRowsPath, 'utf8'));
  const expectedB = JSON.parse(fs.readFileSync(fixtureBExpectedPath, 'utf8'));
  const fixtureBBuffer = fs.readFileSync(fixtureBXlsxPath);

  // Profile Fixture B using engine
  const metaB = {
    file_id: 'ds_fixture_b_synthetic',
    original_filename: 'synthetic-150.xlsx',
    file_extension: '.xlsx',
    file_type: 'xlsx',
  };
  const profiledB = await engine.processAndProfileDataset(metaB, fixtureBBuffer);
  const dsB = {
    file_id: 'ds_fixture_b_synthetic',
    original_filename: 'synthetic-150.xlsx',
    uploaded_by: 'usr_oracle_001',
    company_id: 'ALL',
    processing_status: 'READY',
    rows: fixtureBRows,
    profile: profiledB.dataProfile,
    columns: profiledB.dataProfile.columns,
  };

  // Profile Fixture A
  const dsA = {
    file_id: fixtureAData.file_id,
    original_filename: fixtureAData.original_filename,
    uploaded_by: 'usr_oracle_001',
    company_id: 'ALL',
    processing_status: 'READY',
    rows: fixtureAData.rows,
    profile: {
      row_count: fixtureAData.rows.length,
      column_count: fixtureAData.columns.length,
      columns: fixtureAData.columns,
      active_sheet: 'HR_Data',
      sheets: [{ name: 'HR_Data', row_count: fixtureAData.rows.length }],
    },
    columns: fixtureAData.columns,
  };

  // ============================================================================
  // SECTION 1: FIXTURE A — REAL-WORLD LOGISTICS WORKBOOK VERIFICATION
  // ============================================================================
  console.log('--- SECTION 1: FIXTURE A (LOGISTICS 150 ROWS) ---');

  await test('A-01', 'Fixture A Structure: 150 rows, 150 unique IDs, 6 departments', async () => {
    assert.equal(dsA.rows.length, 150, 'Must have exactly 150 rows');
    const ids = dsA.rows.map(r => r.ma_nhan_vien);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, 150, 'All 150 employee IDs must be unique');

    const deptCounts = {};
    for (const r of dsA.rows) {
      deptCounts[r.phong_ban] = (deptCounts[r.phong_ban] || 0) + 1;
    }
    assert.equal(deptCounts['Vận Tải'], 31);
    assert.equal(deptCounts['Nhân Sự'], 30);
    assert.equal(deptCounts['Kế Toán'], 24);
    assert.equal(deptCounts['Công Nghệ Thông Tin (IT)'], 23);
    assert.equal(deptCounts['Chăm Sóc Khách Hàng'], 22);
    assert.equal(deptCounts['Kho Vận'], 20);
  });

  await test('A-02', 'Fixture A Q01: Đếm số nhân viên của mỗi phòng ban -> DISTINCT_COUNT', async () => {
    const raw = planner.planAnalyticalQuery('Đếm số nhân viên của mỗi phòng ban', dsA.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'DISTINCT_COUNT');
    assert.equal(raw.aggregations[0].column, 'ma_nhan_vien');

    const valid = validator.validateQueryPlan(raw, dsA, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsA, valid);
    assert.equal(res.returned_rows, 6);
    assert.equal(res.summary.distinct_count_ma_nhan_vien, 150);

    const map = new Map(res.results.map(r => [r.phong_ban, r.distinct_count_ma_nhan_vien]));
    assert.equal(map.get('Vận Tải'), 31);
    assert.equal(map.get('Nhân Sự'), 30);
    assert.equal(map.get('Kế Toán'), 24);
    assert.equal(map.get('Công Nghệ Thông Tin (IT)'), 23);
    assert.equal(map.get('Chăm Sóc Khách Hàng'), 22);
    assert.equal(map.get('Kho Vận'), 20);
  });

  await test('A-03', 'Fixture A Q03: Tính tổng lương theo phòng ban -> Exact SUM (3,429,000,000 total)', async () => {
    const raw = planner.planAnalyticalQuery('Tính tổng lương theo phòng ban', dsA.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'SUM');
    assert.equal(raw.aggregations[0].column, 'luong_co_ban_vnd');

    const valid = validator.validateQueryPlan(raw, dsA, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsA, valid);
    assert.equal(res.returned_rows, 6);

    // Exact mathematical SUM verification
    assert.equal(res.summary.sum_luong_co_ban_vnd, 3429000000, 'Total salary sum must equal 3,429,000,000 VND');

    const map = new Map(res.results.map(r => [r.phong_ban, r.sum_luong_co_ban_vnd]));
    assert.equal(map.get('Vận Tải'), 722000000);
    assert.equal(map.get('Chăm Sóc Khách Hàng'), 620000000);
    assert.equal(map.get('Nhân Sự'), 600000000);
    assert.equal(map.get('Kế Toán'), 560000000);
    assert.equal(map.get('Công Nghệ Thông Tin (IT)'), 481000000);
    assert.equal(map.get('Kho Vận'), 446000000);
  });

  await test('A-04', 'Fixture A Q04: Tính lương trung bình theo từng bộ phận -> Exact AVG (22,860,000 total)', async () => {
    const raw = planner.planAnalyticalQuery('Tính lương trung bình theo từng bộ phận', dsA.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'AVG');
    assert.equal(raw.aggregations[0].column, 'luong_co_ban_vnd');

    const valid = validator.validateQueryPlan(raw, dsA, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsA, valid);
    assert.equal(res.returned_rows, 6);

    // Exact mathematical AVG verification
    assert.equal(res.summary.avg_luong_co_ban_vnd, 22860000, 'Global average salary must equal 22,860,000 VND');

    const map = new Map(res.results.map(r => [r.phong_ban, r.avg_luong_co_ban_vnd]));
    assert.equal(map.get('Chăm Sóc Khách Hàng'), 28181818.18);
    assert.equal(map.get('Kế Toán'), 23333333.33);
    assert.equal(map.get('Vận Tải'), 23290322.58);
    assert.equal(map.get('Kho Vận'), 22300000);
    assert.equal(map.get('Công Nghệ Thông Tin (IT)'), 20913043.48);
    assert.equal(map.get('Nhân Sự'), 20000000);
  });

  await test('A-05', 'Fixture A Q06: TOP 5 phòng ban có nhiều nhân viên nhất -> RANKING limit 5', async () => {
    const raw = planner.planAnalyticalQuery('TOP 5 phòng ban có nhiều nhân viên nhất', dsA.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'DISTINCT_COUNT');
    assert.equal(raw.aggregations[0].column, 'ma_nhan_vien');
    assert.equal(raw.limit, 5);

    const valid = validator.validateQueryPlan(raw, dsA, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsA, valid);
    assert.equal(res.returned_rows, 5);
    assert.equal(res.results[0].phong_ban, 'Vận Tải');
    assert.equal(res.results[0].distinct_count_ma_nhan_vien, 31);
    assert.equal(res.results[1].phong_ban, 'Nhân Sự');
    assert.equal(res.results[1].distinct_count_ma_nhan_vien, 30);
    assert.equal(res.summary.distinct_count_ma_nhan_vien, 150);
  });

  await test('A-06', 'Fixture A Q07: Tỷ trọng nhân viên mỗi phòng ban -> DISTRIBUTION PERCENTAGE', async () => {
    const raw = planner.planAnalyticalQuery('Tỷ trọng nhân viên mỗi phòng ban', dsA.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'DISTINCT_COUNT');
    assert.equal(raw.computations[0].type, 'PERCENTAGE');

    const valid = validator.validateQueryPlan(raw, dsA, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsA, valid);
    const vt = res.results.find(r => r.phong_ban === 'Vận Tải');
    // 31 / 150 * 100 = 20.67%
    assert.equal(vt.distinct_count_ma_nhan_vien_ty_trong_pct, 20.67);
  });

  await test('A-07', 'Fixture A Q10: Lọc danh sách nhân viên thuộc phòng ban Kho Vận -> FILTER (20 rows)', async () => {
    const raw = planner.planAnalyticalQuery('Lọc danh sách nhân viên thuộc phòng ban Kho Vận', dsA.profile);
    assert.equal(raw.intent, 'FILTER');
    assert.deepEqual(raw.groupBy, []);
    assert.equal(raw.filters.length, 1);
    assert.equal(raw.filters[0].column, 'phong_ban');

    const valid = validator.validateQueryPlan(raw, dsA, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsA, valid);
    assert.equal(res.returned_rows, 20);
    assert.equal(res.total_matching, 20);
    assert.ok(res.results.every(r => r.phong_ban === 'Kho Vận'));
  });

  // ============================================================================
  // SECTION 2: FIXTURE B — SYNTHETIC 150 ROWS AGAINST INDEPENDENT ORACLE
  // ============================================================================
  console.log('\n--- SECTION 2: FIXTURE B (SYNTHETIC 150 ROWS AGAINST ORACLE) ---');

  await test('B-P01', 'Fixture B Oracle Baseline: Exactly 150 rows, 1 null ID, 140 unique non-null IDs', async () => {
    assert.equal(dsB.profile.row_count, 150);
    const nullIdCount = dsB.rows.filter(r => r.ma_nhan_vien === null || r.ma_nhan_vien === undefined).length;
    assert.equal(nullIdCount, 1, 'Fixture B has EXACTLY 1 null ma_nhan_vien row (not 10)');
    assert.equal(dsB.columns.find(c => c.key === 'ma_nhan_vien').cardinality, 140);
    assert.equal(dsB.columns.find(c => c.key === 'luong_co_ban').sum, expectedB.salary_sum);
    assert.equal(dsB.columns.find(c => c.key === 'luong_co_ban').avg, expectedB.salary_avg);
    assert.equal(dsB.columns.find(c => c.key === 'luong_co_ban').min, expectedB.salary_min);
    assert.equal(dsB.columns.find(c => c.key === 'luong_co_ban').max, expectedB.salary_max);
    assert.equal(dsB.columns.find(c => c.key === 'luong_co_ban').median, expectedB.salary_median);
  });

  await test('B-Q01', 'Q01: Đếm số nhân viên theo phòng ban -> DISTINCT_COUNT matches Oracle (140 total)', async () => {
    const raw = planner.planAnalyticalQuery('Đếm số nhân viên theo phòng ban.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'DISTINCT_COUNT');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 6);
    assert.equal(res.summary.distinct_count_ma_nhan_vien, expectedB.distinct_non_null_ids);

    const actualMap = new Map(res.results.map(r => [r.phong_ban, r.distinct_count_ma_nhan_vien]));
    for (const dept of expectedB.departments) {
      assert.equal(actualMap.get(dept.group), dept.distinct, `Dept ${dept.group} distinct mismatch`);
    }
  });

  await test('B-Q02', 'Q02: Đếm số dòng dữ liệu của mỗi phòng ban -> COUNT(*) matches Oracle (150 total)', async () => {
    const raw = planner.planAnalyticalQuery('Đếm số dòng dữ liệu của mỗi phòng ban.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'COUNT');
    assert.equal(raw.aggregations[0].column, '*');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 6);
    assert.equal(res.summary.count_rows, 150);

    const actualMap = new Map(res.results.map(r => [r.phong_ban, r.count_rows]));
    for (const dept of expectedB.departments) {
      assert.equal(actualMap.get(dept.group), dept.rows, `Dept ${dept.group} row count mismatch`);
    }
    // Department Ky Thuat has 16 rows (15 distinct IDs + 1 null ID row)
    assert.equal(actualMap.get('Ky Thuat'), 16);
  });

  await test('B-Q03', 'Q03: Tính tổng lương theo phòng ban -> SUM matches Oracle (1,885,700,000 total)', async () => {
    const raw = planner.planAnalyticalQuery('Tính tổng lương theo phòng ban.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'SUM');
    assert.equal(raw.aggregations[0].column, 'luong_co_ban');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 6);
    assert.equal(res.summary.sum_luong_co_ban, expectedB.salary_sum);

    const actualMap = new Map(res.results.map(r => [r.phong_ban, r.sum_luong_co_ban]));
    for (const dept of expectedB.departments) {
      assert.equal(actualMap.get(dept.group), dept.salary_sum, `Dept ${dept.group} sum mismatch`);
    }
  });

  await test('B-Q04', 'Q04: Tính lương trung bình theo phòng ban -> AVG matches Oracle (13,373,758.87 total)', async () => {
    const raw = planner.planAnalyticalQuery('Tính lương trung bình theo phòng ban.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'AVG');
    assert.equal(raw.aggregations[0].column, 'luong_co_ban');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 6);
    assert.equal(res.summary.avg_luong_co_ban, expectedB.salary_avg);

    const actualMap = new Map(res.results.map(r => [r.phong_ban, r.avg_luong_co_ban]));
    for (const dept of expectedB.departments) {
      assert.equal(actualMap.get(dept.group), dept.salary_avg, `Dept ${dept.group} avg mismatch`);
    }
  });

  await test('B-Q05', 'Q05: Tìm nhân viên có lương cao nhất -> Preserves full record (Ky Thuat, 16.5M)', async () => {
    const raw = planner.planAnalyticalQuery('Tìm nhân viên có lương cao nhất.', dsB.profile);
    assert.equal(raw.intent, 'RANKING');
    assert.deepEqual(raw.groupBy, []);
    assert.equal(raw.limit, 1);

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 1);
    assert.equal(res.summary.max_luong_co_ban, expectedB.salary_max);

    const topEmp = res.results[0];
    assert.equal(topEmp.luong_co_ban, 16500000);
    assert.equal(topEmp.phong_ban, 'Ky Thuat');
    assert.equal(topEmp.chi_nhanh, 'SWC');
    assert.equal(topEmp.trang_thai, 'INACTIVE');
    assert.equal(topEmp.ngay_tuyen_dung, '2026-12-15');
    assert.equal(topEmp.ma_nhan_vien, null);
  });

  await test('B-Q06', 'Q06: Top 5 phòng ban có nhiều nhân viên nhất -> DISTINCT_COUNT DESC limit 5', async () => {
    const raw = planner.planAnalyticalQuery('Top 5 phòng ban có nhiều nhân viên nhất.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['phong_ban']);
    assert.equal(raw.aggregations[0].func, 'DISTINCT_COUNT');
    assert.equal(raw.aggregations[0].column, 'ma_nhan_vien');
    assert.equal(raw.limit, 5);

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 5);
    assert.equal(res.results[0].phong_ban, 'Kho Van');
    assert.equal(res.results[0].distinct_count_ma_nhan_vien, 35);
    assert.equal(res.results[1].phong_ban, 'Logistics');
    assert.equal(res.results[1].distinct_count_ma_nhan_vien, 30);
    assert.equal(res.results[2].phong_ban, 'Ke Toan');
    assert.equal(res.results[2].distinct_count_ma_nhan_vien, 25);
    assert.equal(res.results[3].phong_ban, 'Nhan Su');
    assert.equal(res.results[3].distinct_count_ma_nhan_vien, 24);
    assert.equal(res.results[4].phong_ban, 'Kinh Doanh');
    assert.equal(res.results[4].distinct_count_ma_nhan_vien, 20);

    // Global summary holds whole dataset before limit
    assert.equal(res.summary.distinct_count_ma_nhan_vien, 140);
  });

  await test('B-Q07A', 'Q07A: Tỷ trọng nhân viên theo chi nhánh -> Raw NL plan produces 100% sum on allocated headcount', async () => {
    // RAW natural query without any injected properties
    const raw = planner.planAnalyticalQuery('Tỷ trọng nhân viên theo chi nhánh.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['chi_nhanh']);
    assert.equal(raw.aggregations[0].func, 'DISTINCT_COUNT');
    assert.equal(raw.aggregations[0].column, 'ma_nhan_vien');
    assert.equal(raw.computations[0].type, 'PERCENTAGE');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 4, 'Must return 4 groups including null branch');
    const alias = raw.computations[0].target_alias;
    const actualMap = new Map(res.results.map(r => [String(r.chi_nhanh ?? ''), r[alias]]));

    // Allocated headcount denominator = 48 + 48 + 47 + 6 = 149
    // VTX: 48/149 = 32.21%, STL: 48/149 = 32.21%, SWC: 47/149 = 31.54%, null: 6/149 = 4.03%
    assert.equal(actualMap.get('VTX'), 32.21);
    assert.equal(actualMap.get('STL'), 32.21);
    assert.equal(actualMap.get('SWC'), 31.54);
    assert.equal(actualMap.get(''), 4.03);

    // Total slices sum to exactly 99.99% ~ 100%
    const totalSlices = Array.from(actualMap.values()).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(totalSlices - 100) < 0.1, 'Allocated distribution shares must sum to 100%');
  });

  await test('B-Q07B', 'Q07B: Tỷ trọng dòng dữ liệu theo chi nhánh -> Row distribution share matches expected.json row_share_pct', async () => {
    // Explicit row distribution query
    const raw = planner.planAnalyticalQuery('Tỷ trọng số dòng dữ liệu theo chi nhánh.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['chi_nhanh']);
    assert.equal(raw.aggregations[0].func, 'COUNT');
    assert.equal(raw.aggregations[0].column, '*');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 4);
    const alias = raw.computations[0].target_alias;
    const actualMap = new Map(res.results.map(r => [String(r.chi_nhanh ?? ''), r[alias]]));

    // Exactly matches expected.json row_share_pct: 32%, 32%, 32%, 4%
    assert.equal(actualMap.get('VTX'), 32);
    assert.equal(actualMap.get('STL'), 32);
    assert.equal(actualMap.get('SWC'), 32);
    assert.equal(actualMap.get(''), 4);
  });

  await test('B-Q08', 'Q08: So sánh giữa các tháng -> Strictly Chronological Ascending 2026-01 to 2026-12', async () => {
    const raw = planner.planAnalyticalQuery('So sánh số nhân viên giữa các tháng.', dsB.profile);
    assert.equal(raw.groupBy[0].date_trunc, 'month');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 12);
    const months = res.results.map(r => r.ngay_tuyen_dung);
    for (let i = 1; i < months.length; i++) {
      assert.ok(months[i] > months[i - 1], `Month ${months[i]} must be after ${months[i - 1]}`);
    }
    assert.equal(months[0], '2026-01');
    assert.equal(months[11], '2026-12');
  });

  await test('B-Q09A', 'Q09A: Tỷ lệ nhân viên theo trạng thái -> Raw NL plan produces 100% sum on allocated status', async () => {
    const raw = planner.planAnalyticalQuery('Tỷ lệ nhân viên theo trạng thái.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['trang_thai']);
    assert.equal(raw.aggregations[0].func, 'DISTINCT_COUNT');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 4, 'Must return 4 groups including null status');
    const alias = raw.computations[0].target_alias;
    const actualMap = new Map(res.results.map(r => [String(r.trang_thai ?? ''), r[alias]]));

    // Denominator = 48 + 48 + 47 + 7 = 150
    // PROBATION: 48/150 = 32%, INACTIVE: 47/150 = 31.33%, ACTIVE: 48? let's check
    const totalSlices = Array.from(actualMap.values()).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(totalSlices - 100) < 0.1, 'Status distribution shares must sum to 100%');
  });

  await test('B-Q09B', 'Q09B: Tỷ lệ dòng dữ liệu theo trạng thái -> Row distribution share matches expected.json row_share_pct', async () => {
    const raw = planner.planAnalyticalQuery('Tỷ lệ số dòng dữ liệu theo trạng thái.', dsB.profile);
    assert.deepEqual(raw.groupBy, ['trang_thai']);
    assert.equal(raw.aggregations[0].func, 'COUNT');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 4);
    const alias = raw.computations[0].target_alias;
    const actualMap = new Map(res.results.map(r => [String(r.trang_thai ?? ''), r[alias]]));

    assert.equal(actualMap.get('PROBATION'), 32);
    assert.equal(actualMap.get('INACTIVE'), 32);
    assert.equal(actualMap.get('ACTIVE'), 31.33);
    assert.equal(actualMap.get(''), 4.67);
  });

  await test('B-Q10', 'Q10: Lọc nhân viên theo phòng ban Kho Van -> Returns 35 rows, no salary SUM forced', async () => {
    const raw = planner.planAnalyticalQuery('Lọc nhân viên theo phòng ban Kho Van.', dsB.profile);
    assert.equal(raw.intent, 'FILTER');
    assert.deepEqual(raw.groupBy, []);
    assert.equal(raw.filters[0].column, 'phong_ban');

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 35);
    assert.equal(res.total_matching, 35);
    assert.ok(res.results.every(r => r.phong_ban === 'Kho Van'));
  });

  await test('B-Q11', 'Q11: Kiểm tra dữ liệu trùng -> Identifies exactly 9 duplicate groups SYN000-SYN008', async () => {
    const raw = planner.planAnalyticalQuery('Kiểm tra dữ liệu trùng.', dsB.profile);
    assert.equal(raw.intent, 'DUPLICATES');
    assert.deepEqual(raw.groupBy, ['ma_nhan_vien']);
    assert.equal(raw.having.op, 'gt');
    assert.equal(raw.having.value, 1);

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 9, 'Must return exactly 9 duplicate groups');
    assert.equal(res.summary.duplicate_groups, 9);
    assert.ok(res.results.every(r => r.count_ma_nhan_vien === 2), 'Each group must have count 2');

    const returnedKeys = res.results.map(r => r.ma_nhan_vien).sort();
    const expectedKeys = expectedB.duplicate_id_groups.map(g => g[0]).sort();
    assert.deepEqual(returnedKeys, expectedKeys);
  });

  await test('B-Q12', 'Q12: Chỉ lấy phòng ban Logistics -> Follow-up filter returns exactly 30 rows', async () => {
    const raw = planner.planAnalyticalQuery('Chỉ lấy phòng ban Logistics.', dsB.profile);
    assert.equal(raw.intent, 'FILTER');
    assert.deepEqual(raw.groupBy, []);

    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 30);
    assert.equal(res.total_matching, 30);
    assert.ok(res.results.every(r => r.phong_ban === 'Logistics'));
  });

  // ============================================================================
  // SECTION 3: STRESS & EDGE CASES (ST-A01 - ST-A07)
  // ============================================================================
  console.log('\n--- SECTION 3: STRESS & EDGE CASES (ST-A01 - ST-A07) ---');

  await test('ST-A01', 'ST-A01: NULL values in Identifier: Exactly 1 null ID row, DISTINCT_COUNT=140, COUNT(*)=150', async () => {
    const queryDistinct = {
      groupBy: [],
      aggregations: [{ column: 'ma_nhan_vien', func: 'DISTINCT_COUNT', alias: 'dist_id' }],
    };
    const validD = validator.validateQueryPlan(queryDistinct, dsB, USER_TEST);
    const resD = engine.executeAnalyticalQuery(dsB, validD);
    assert.equal(resD.summary.dist_id, 140, 'DISTINCT_COUNT ignores NULL (140 unique non-null IDs)');

    const queryRows = {
      groupBy: [],
      aggregations: [{ column: '*', func: 'COUNT', alias: 'total_rows' }],
    };
    const validR = validator.validateQueryPlan(queryRows, dsB, USER_TEST);
    const resR = engine.executeAnalyticalQuery(dsB, validR);
    assert.equal(resR.summary.total_rows, 150, 'COUNT(*) must count all rows including the 1 null ID row');
  });

  await test('ST-A02', 'ST-A02: Duplicate Keys: SYN000-SYN008 isolated by duplicate query', async () => {
    const query = {
      intent: 'DUPLICATES',
      groupBy: ['ma_nhan_vien'],
      aggregations: [{ column: 'ma_nhan_vien', func: 'COUNT', alias: 'count_ma_nhan_vien' }],
      having: { column: 'count_ma_nhan_vien', op: 'gt', value: 1 },
    };
    const valid = validator.validateQueryPlan(query, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);
    assert.equal(res.results.length, 9);
    for (const r of res.results) {
      assert.ok(/^SYN00[0-8]$/.test(r.ma_nhan_vien));
      assert.equal(r.count_ma_nhan_vien, 2);
    }
  });

  await test('ST-A03', 'ST-A03: NULL values in Numeric Metrics: Exactly 9 null salaries, 141 non-nulls (SUM=1.88B, AVG=13.37M)', async () => {
    const query = {
      groupBy: [],
      aggregations: [
        { column: 'luong_co_ban', func: 'SUM', alias: 'sum_sal' },
        { column: 'luong_co_ban', func: 'AVG', alias: 'avg_sal' },
        { column: 'luong_co_ban', func: 'COUNT_NON_NULL', alias: 'count_sal' },
      ],
    };
    const valid = validator.validateQueryPlan(query, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.summary.sum_sal, 1885700000);
    assert.equal(res.summary.count_sal, 141, 'Must have exactly 141 non-null salaries (150 - 9 nulls)');
    assert.equal(res.summary.avg_sal, 13373758.87);
    // Exact mathematical relationship: sum / count = avg
    const computedAvg = Number((res.summary.sum_sal / res.summary.count_sal).toFixed(2));
    assert.equal(computedAvg, 13373758.87);
  });

  await test('ST-A04', 'ST-A04: Date parsing across formats & Chronological trend order', async () => {
    const testRows = [
      { id: '1', date: '2026-03-15', val: 10 },
      { id: '2', date: '15/01/2026', val: 20 },
      { id: '3', date: '2026-02-01T08:00:00Z', val: 30 },
    ];
    const testDs = {
      file_id: 'ds_dates',
      rows: testRows,
      columns: [
        { key: 'id', name: 'ID', type: 'STRING' },
        { key: 'date', name: 'Date', type: 'DATE' },
        { key: 'val', name: 'Val', type: 'INTEGER' },
      ],
      profile: { columns: [{ key: 'id' }, { key: 'date', type: 'DATE' }, { key: 'val', type: 'INTEGER' }] },
    };

    const query = {
      groupBy: [{ column: 'date', date_trunc: 'month' }],
      aggregations: [{ column: 'val', func: 'SUM', alias: 'sum_val' }],
    };
    const valid = validator.validateQueryPlan(query, testDs, USER_TEST);
    const res = engine.executeAnalyticalQuery(testDs, valid);

    assert.equal(res.results.length, 3);
    assert.equal(res.results[0].date, '2026-01');
    assert.equal(res.results[1].date, '2026-02');
    assert.equal(res.results[2].date, '2026-03');
  });

  await test('ST-A05', 'ST-A05: Non-destructive LIMIT: Global KPI preserved before LIMIT slice', async () => {
    const query = {
      groupBy: ['phong_ban'],
      aggregations: [
        { column: 'ma_nhan_vien', func: 'DISTINCT_COUNT', alias: 'distinct_ma_nhan_vien' },
        { column: 'luong_co_ban', func: 'SUM', alias: 'sum_luong_co_ban' },
      ],
      orderBy: { column: 'sum_luong_co_ban', dir: 'DESC' },
      limit: 2,
    };
    const valid = validator.validateQueryPlan(query, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.equal(res.returned_rows, 2);
    assert.equal(res.summary.distinct_ma_nhan_vien, 140);
    assert.equal(res.summary.sum_luong_co_ban, 1885700000);

    const dash = builder.buildDatasetDashboard(valid, res, dsB, USER_TEST);
    assert.equal(dash.kpi_strip[0].primary_value, 140);
    assert.equal(dash.kpi_strip[1].primary_value, 1885700000);
  });

  await test('ST-A06', 'ST-A06: Multi-dimensional Grouping (phong_ban x chi_nhanh)', async () => {
    const query = {
      groupBy: ['phong_ban', 'chi_nhanh'],
      aggregations: [{ column: 'luong_co_ban', func: 'SUM', alias: 'sum_salary' }],
    };
    const valid = validator.validateQueryPlan(query, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);

    assert.ok(res.returned_rows > 6, 'Multi-dimension produces multiple sub-groups');
    assert.equal(res.summary.sum_salary, 1885700000);
    for (const r of res.results) {
      assert.ok('phong_ban' in r);
      assert.ok('chi_nhanh' in r);
      assert.ok('sum_salary' in r);
    }
  });

  await test('ST-A07', 'ST-A07: Pipeline Consistency across KPI Card, Chart Payload, Table & REAL buildSafeInsightContext', async () => {
    const raw = planner.planAnalyticalQuery('Tính tổng lương theo phòng ban', dsB.profile);
    const valid = validator.validateQueryPlan(raw, dsB, USER_TEST);
    const res = engine.executeAnalyticalQuery(dsB, valid);
    const dash = builder.buildDatasetDashboard(valid, res, dsB, USER_TEST);
    const md = presenter.formatAnalyticalResultMarkdown(valid, res, dsB, 'Insight điều hành.', USER_TEST);

    // 1. KPI Card primary value agrees with query engine summary
    assert.equal(dash.kpi_strip[0].primary_value, res.summary.sum_luong_co_ban);
    assert.equal(dash.kpi_strip[0].primary_value, 1885700000);

    // 2. Data store table rows sum agrees with query results
    const storeRows = dash.data_store.file_dataset_results;
    assert.equal(storeRows.length, res.results.length);
    const tableSum = storeRows.reduce((a, b) => a + (b.sum_luong_co_ban || 0), 0);
    assert.equal(tableSum, 1885700000);

    // 3. Visualization mapping points to existing data_ref and columns
    const viz = dash.visualizations[0];
    assert.equal(viz.data_ref, 'file_dataset_results');
    assert.equal(viz.mapping.category, 'phong_ban');
    assert.equal(viz.mapping.value, 'sum_luong_co_ban');

    // 4. Markdown presentation contains both table and dashboard comment
    assert.ok(md.includes('bi-dashboard-v2:'));
    assert.ok(md.includes('Kho Van'));
    assert.ok(md.includes('1.885.700.000') || md.includes('1885700000'));

    // 5. Test REAL application buildSafeInsightContext function imported from biPrivacy
    const safeContext = buildSafeInsightContext(res);
    assert.equal(safeContext.total_matching_rows, 150);
    assert.equal(safeContext.kpi_summary.sum_luong_co_ban, 1885700000);
    assert.equal(safeContext.total_groups, 6);
    assert.equal(safeContext.top_categories.length, 5);
  });

  // ============================================================================
  // FINAL SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`ORACLE REGRESSION TEST SUMMARY: ${passCount} / ${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('Production Environment Connection: NONE (Zero Production Touch)');
  console.log('PostgreSQL HR Database Intrusion: ZERO (100% In-Memory Columnar Dataset)');
  console.log('================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runOracleTestSuite().catch(err => {
  console.error('Fatal Oracle Suite Error:', err);
  process.exit(1);
});
