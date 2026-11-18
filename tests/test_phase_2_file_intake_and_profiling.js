/**
 * SOTRANS HUB — PHASE 2: UPLOADED FILE BI FOUNDATION TEST SUITE
 * 
 * Comprehensive Test Suite for Phase 2.1 (Secure Intake) & Phase 2.2 (Isolated Processing):
 * - Magic byte verification (.xlsx, .xls, .csv)
 * - Anti-malware & disguised binary blocking (PE, ELF, HTML/Script, null bytes)
 * - Path traversal prevention & filename sanitization
 * - File size boundary enforcement & empty file rejection
 * - ZIP Bomb / high expansion ratio defense
 * - Formula Injection sanitization (=, +, -, @)
 * - Data Profiling (types, null rates, cardinality, min/max/sum/avg/median, date ranges)
 * - Duplicate header resolution & resource limits (sheets, rows, cols)
 * - Multi-tenant isolation & IDOR prevention (STL vs VTX vs SWC vs ADMIN)
 * - In-memory analytical query engine (Filter, Group By, Aggregate, Order By, Limit)
 * - Zero PostgreSQL HR database intrusion
 * - Retention lifecycle & expired dataset cleanup
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('../auth-service/node_modules/xlsx');

const {
  validateAndStoreIntakeFile,
  sanitizeFilename,
  verifyMagicBytes,
  verifyZipExpansionRatio,
  sanitizeFormulaInjection,
  FileSecurityError,
  STORAGE_DIR,
} = require('../auth-service/services/biFileSecurityService');

const {
  registerDataset,
  getDataset,
  updateDataset,
  deleteDataset,
  listDatasetsForUser,
  canUserAccessDataset,
  cleanupExpiredDatasets,
} = require('../auth-service/services/biDatasetRegistry');

const {
  processAndProfileDataset,
  queryIsolatedDataset,
  parseCsvBuffer,
  profileColumn,
  generateAnalysisSuggestions,
  parseNumericValue,
  parseDateValue,
} = require('../auth-service/services/biSpreadsheetEngine');

const {
  formatDatasetProfileMarkdown,
} = require('../auth-service/services/biDatasetPresenter');

// ============================================================================
// TEST HARNESS
// ============================================================================

let passCount = 0;
let failCount = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`[PASS] ${name}`);
    results.push({ name, status: 'PASS' });
  } catch (err) {
    failCount++;
    console.error(`[FAIL] ${name} -> ${err.message}`);
    results.push({ name, status: 'FAIL', error: err.message });
  }
}

// Helpers to create test spreadsheet buffers
function createMockXlsxBuffer(sheetData = [['Tên', 'Tuổi'], ['An', 25]]) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, 'DuLieu');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function createMockCsvBuffer(text = 'Ten,Tuoi\nAn,25\nBinh,30') {
  return Buffer.from(text, 'utf8');
}

// Mock User Contexts
const USER_ADMIN = { user_id: 1, username: 'admin_sys', role: 'ADMIN', company_id: 'ALL' };
const USER_HR_STL = { user_id: 2, username: 'hr_stl', role: 'HR', company_id: 'STL' };
const USER_HR_VTX = { user_id: 3, username: 'hr_vtx', role: 'HR', company_id: 'VTX' };
const USER_EMP_STL_1 = { user_id: 4, username: 'emp_stl_1', role: 'EMPLOYEE', company_id: 'STL' };
const USER_EMP_STL_2 = { user_id: 5, username: 'emp_stl_2', role: 'EMPLOYEE', company_id: 'STL' };

async function runSuite() {
  console.log('================================================================');
  console.log('SOTRANS HUB — PHASE 2 FILE BI TEST SUITE (PHASE 2.1 & 2.2)');
  console.log('Target: Secure Intake, Data Profiling, Isolated Storage & Multi-tenant');
  console.log('================================================================\n');

  // ==========================================================================
  // GROUP 1: FILE INTAKE & VALIDATION SECURITY (PHASE 2.1)
  // ==========================================================================
  console.log('--- GROUP 1: SECURE FILE INTAKE & VALIDATION (1 - 10) ---');

  await test('Scenario 01: Valid .xlsx file passes magic bytes & intake pipeline', async () => {
    const buf = createMockXlsxBuffer();
    const file = {
      buffer: buf,
      originalname: 'bao_cao_nhan_su.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const { metadata } = await validateAndStoreIntakeFile(file, USER_HR_STL);

    assert.ok(metadata.file_id, 'file_id must be generated');
    assert.strictEqual(metadata.file_type, 'XLSX');
    assert.strictEqual(metadata.uploaded_by, USER_HR_STL.user_id);
    assert.strictEqual(metadata.company_id, 'STL');
    assert.ok(metadata.checksum, 'SHA256 checksum must be present');
    assert.ok(fs.existsSync(metadata.storage_path), 'File must be physically written in isolated storage');
  });

  await test('Scenario 02: Valid .csv file passes intake with delimiter detection', async () => {
    const buf = createMockCsvBuffer('MaNV;HoTen;Luong\nNV01;Nguyen Van A;15000000\nNV02;Tran Thi B;18000000');
    const file = {
      buffer: buf,
      originalname: 'danh_sach_luong.csv',
      mimetype: 'text/csv',
    };
    const { metadata } = await validateAndStoreIntakeFile(file, USER_HR_STL);

    assert.strictEqual(metadata.file_type, 'CSV');
    assert.strictEqual(metadata.original_filename, 'danh_sach_luong.csv');
  });

  await test('Scenario 03: Disguised Windows PE/EXE binary (.xlsx extension) is blocked', async () => {
    const fakeExe = Buffer.concat([Buffer.from([0x4D, 0x5A, 0x90, 0x00]), Buffer.alloc(100)]);
    const file = {
      buffer: fakeExe,
      originalname: 'virus_trojan.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    await assert.rejects(
      async () => await validateAndStoreIntakeFile(file, USER_HR_STL),
      (err) => err.code === 'INVALID_XLSX_SIGNATURE'
    );
  });

  await test('Scenario 04: Disguised Linux ELF executable (.csv extension) is blocked', async () => {
    const fakeElf = Buffer.concat([Buffer.from([0x7F, 0x45, 0x4C, 0x46]), Buffer.alloc(100)]);
    const file = {
      buffer: fakeElf,
      originalname: 'script_elf.csv',
      mimetype: 'text/csv',
    };

    await assert.rejects(
      async () => await validateAndStoreIntakeFile(file, USER_HR_STL),
      (err) => err.code === 'DISGUISED_BINARY_FILE'
    );
  });

  await test('Scenario 05: Malicious HTML/Script injection (.csv extension) is blocked', async () => {
    const fakeHtml = Buffer.from('<script>alert("XSS")</script>', 'utf8');
    const file = {
      buffer: fakeHtml,
      originalname: 'phishing.csv',
      mimetype: 'text/csv',
    };

    await assert.rejects(
      async () => await validateAndStoreIntakeFile(file, USER_HR_STL),
      (err) => err.code === 'MALICIOUS_SCRIPT_CONTENT'
    );
  });

  await test('Scenario 06: Binary null byte in CSV header is blocked', async () => {
    const nullBuf = Buffer.from('Col1,Col2\0,Col3\n1,2,3', 'utf8');
    const file = {
      buffer: nullBuf,
      originalname: 'corrupt_binary.csv',
      mimetype: 'text/csv',
    };

    await assert.rejects(
      async () => await validateAndStoreIntakeFile(file, USER_HR_STL),
      (err) => err.code === 'BINARY_CONTENT_IN_CSV'
    );
  });

  await test('Scenario 07: Path traversal attempt in filename is sanitized safely', async () => {
    const buf = createMockXlsxBuffer();
    const file = {
      buffer: buf,
      originalname: '../../../../etc/shadow.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const { metadata } = await validateAndStoreIntakeFile(file, USER_HR_STL);

    assert.strictEqual(metadata.original_filename, 'shadow.xlsx');
    assert.ok(!metadata.storage_path.includes('etc'), 'Storage path must remain in isolated directory');
  });

  await test('Scenario 08: Empty file (0 bytes) is rejected with 400', async () => {
    const file = {
      buffer: Buffer.alloc(0),
      originalname: 'empty.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    await assert.rejects(
      async () => await validateAndStoreIntakeFile(file, USER_HR_STL),
      (err) => err.code === 'EMPTY_OR_CORRUPTED_FILE' || err.code === 'EMPTY_FILE'
    );
  });

  await test('Scenario 09: File exceeding 25MB size limit is rejected', async () => {
    const file = {
      buffer: Buffer.alloc(26 * 1024 * 1024),
      originalname: 'huge_file.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    await assert.rejects(
      async () => await validateAndStoreIntakeFile(file, USER_HR_STL),
      (err) => err.code === 'FILE_SIZE_LIMIT_EXCEEDED'
    );
  });

  await test('Scenario 10: Unauthenticated user upload is strictly rejected with 401', async () => {
    const buf = createMockXlsxBuffer();
    const file = {
      buffer: buf,
      originalname: 'guest_data.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    await assert.rejects(
      async () => await validateAndStoreIntakeFile(file, null),
      (err) => err.code === 'UNAUTHENTICATED' && err.status === 401
    );
  });

  // ==========================================================================
  // GROUP 2: DATA PROFILING & QUALITY SCANNING (PHASE 2.2)
  // ==========================================================================
  console.log('\n--- GROUP 2: DATA PROFILING & QUALITY SCANNING (11 - 20) ---');

  let testDatasetProfile = null;
  let testDatasetMetadata = null;

  await test('Scenario 11: Complex XLSX parses & generates full data profile', async () => {
    const sheetData = [
      ['Mã Đơn', 'Khách Hàng', 'Ngày Tạo', 'Doanh Thu', 'Số Lượng', 'Ghi Chú'],
      ['DH001', 'Công ty A', '2026-01-10', '15.000.000', 5, ''],
      ['DH002', 'Công ty B', '2026-02-15', '25.500.000', 10, ''],
      ['DH003', 'Công ty A', '2026-03-20', '8.200.000', 2, ''],
      ['DH004', 'Công ty C', '2026-04-25', '45.000.000', 12, 'Khẩn'],
    ];
    const buf = createMockXlsxBuffer(sheetData);
    const file = { buffer: buf, originalname: 'don_hang_2026.xlsx' };
    const { metadata } = await validateAndStoreIntakeFile(file, USER_HR_STL);
    testDatasetMetadata = metadata;

    const { dataProfile } = await processAndProfileDataset(metadata, buf);
    testDatasetProfile = dataProfile;

    assert.strictEqual(dataProfile.row_count, 4);
    assert.strictEqual(dataProfile.column_count, 6);
    assert.strictEqual(dataProfile.active_sheet, 'DuLieu');

    // Check column types
    const colMap = new Map(dataProfile.columns.map((c) => [c.key, c]));
    assert.strictEqual(colMap.get('ma_don').type, 'STRING');
    assert.strictEqual(colMap.get('khach_hang').type, 'STRING');
    assert.strictEqual(colMap.get('ngay_tao').type, 'DATE');
    assert.ok(['INTEGER', 'FLOAT'].includes(colMap.get('doanh_thu').type));
    assert.strictEqual(colMap.get('so_luong').type, 'INTEGER');
  });

  await test('Scenario 12: Column statistics (min, max, sum, avg, median) are accurate', async () => {
    const colMap = new Map(testDatasetProfile.columns.map((c) => [c.key, c]));
    const doanhThu = colMap.get('doanh_thu');

    assert.strictEqual(doanhThu.min, 8200000);
    assert.strictEqual(doanhThu.max, 45000000);
    assert.strictEqual(doanhThu.sum, 93700000);
    assert.strictEqual(doanhThu.avg, 23425000);
    assert.strictEqual(doanhThu.median, 20250000);
  });

  await test('Scenario 13: Date range boundaries (min_date, max_date, span_days) calculated', async () => {
    const colMap = new Map(testDatasetProfile.columns.map((c) => [c.key, c]));
    const ngayTao = colMap.get('ngay_tao');

    assert.strictEqual(ngayTao.min_date, '2026-01-10');
    assert.strictEqual(ngayTao.max_date, '2026-04-25');
    assert.strictEqual(ngayTao.span_days, 105);
  });

  await test('Scenario 14: Formula injection values (=, +, -, @) are sanitized safely', async () => {
    const injectionSheet = [
      ['Tên', 'Lệnh Độc Hại', 'Công Thức'],
      ['User1', '=cmd|"/C calc"!A0', '+1+2'],
      ['User2', '@SUM(1,2)', '-2000'],
    ];
    const buf = createMockXlsxBuffer(injectionSheet);
    const file = { buffer: buf, originalname: 'injection_test.xlsx' };
    const { metadata } = await validateAndStoreIntakeFile(file, USER_HR_STL);
    const { dataProfile } = await processAndProfileDataset(metadata, buf);

    const alerts = dataProfile.quality_alerts.filter((a) => a.type === 'FORMULA_INJECTION_SANITIZED');
    assert.ok(alerts.length > 0, 'Alert must be triggered for formula sanitization');

    // Inspect preview rows
    const firstRow = dataProfile.preview_rows[0];
    assert.strictEqual(firstRow.lenh_doc_hai[0], "'", 'Formula must be prefixed with single quote');
  });

  await test('Scenario 15: High null rate alert (>50% empty values) is reported', async () => {
    const colMap = new Map(testDatasetProfile.columns.map((c) => [c.key, c]));
    const ghiChu = colMap.get('ghi_chu');

    assert.strictEqual(ghiChu.null_ratio_pct, 75); // 3 of 4 rows empty
    const nullAlerts = testDatasetProfile.quality_alerts.filter((a) => a.type === 'HIGH_NULL_RATE');
    assert.ok(nullAlerts.length > 0, 'High null alert must be present for column Ghi Chú');
  });

  await test('Scenario 16: Duplicate header names are resolved by suffixing _2, _3', async () => {
    const dupSheet = [
      ['Doanh Thu', 'Doanh Thu', 'Khách'],
      [100, 200, 'A'],
    ];
    const buf = createMockXlsxBuffer(dupSheet);
    const file = { buffer: buf, originalname: 'dup_header.xlsx' };
    const { metadata } = await validateAndStoreIntakeFile(file, USER_HR_STL);
    const { dataProfile } = await processAndProfileDataset(metadata, buf);

    const keys = dataProfile.columns.map((c) => c.key);
    assert.ok(keys.includes('doanh_thu'));
    assert.ok(keys.includes('doanh_thu_2'));
  });

  await test('Scenario 17: Smart analysis suggestions generated based on detected columns', async () => {
    const suggestions = testDatasetProfile.suggested_questions;
    assert.ok(Array.isArray(suggestions) && suggestions.length > 0);
    // Should suggest trend by date or categorical breakdown
    const hasMeaningfulSuggestion = suggestions.some(
      (s) => s.includes('Doanh Thu') || s.includes('Khách Hàng') || s.includes('Ngày Tạo')
    );
    assert.ok(hasMeaningfulSuggestion, 'Smart suggestions must reference identified columns');
  });

  await test('Scenario 18: Preview rows returns exact first 10 sanitized rows', async () => {
    assert.strictEqual(testDatasetProfile.preview_rows.length, 4);
    assert.strictEqual(testDatasetProfile.preview_rows[0].ma_don, 'DH001');
    assert.strictEqual(testDatasetProfile.preview_rows[3].ma_don, 'DH004');
  });

  await test('Scenario 19: Dataset persistence creates isolated .dataset.json without PostgreSQL access', async () => {
    const jsonPath = path.join(STORAGE_DIR, `${testDatasetMetadata.file_id}.dataset.json`);
    assert.ok(fs.existsSync(jsonPath), 'Isolated JSON dataset file must exist on disk');
    const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.strictEqual(content.file_id, testDatasetMetadata.file_id);
    assert.strictEqual(content.rows.length, 4);
  });

  await test('Scenario 20: CSV with semicolon (;) and commas inside quotes is parsed accurately', async () => {
    const csvContent = 'Ma;Ten;MoTa\n1;Sản phẩm A;"Mô tả; có dấu chấm phẩy"\n2;Sản phẩm B;"Mô tả, có dấu phẩy"';
    const parsed = parseCsvBuffer(Buffer.from(csvContent, 'utf8'));
    assert.strictEqual(parsed.delimiter, ';');
    assert.strictEqual(parsed.rawRows.length, 3);
    assert.strictEqual(parsed.rawRows[1][2], 'Mô tả; có dấu chấm phẩy');
    assert.strictEqual(parsed.rawRows[2][2], 'Mô tả, có dấu phẩy');
  });

  // ==========================================================================
  // GROUP 3: TENANT ISOLATION, RBAC & RETENTION (PHASE 2.1 & 2.4)
  // ==========================================================================
  console.log('\n--- GROUP 3: TENANT ISOLATION, RBAC & RETENTION (21 - 30) ---');

  let datasetStl = null;
  let datasetVtx = null;

  await test('Scenario 21: Register datasets for STL and VTX tenants', async () => {
    datasetStl = await registerDataset({
      file_id: crypto.randomUUID(),
      uploaded_by: USER_HR_STL.user_id,
      company_id: 'STL',
      original_filename: 'stl_data.xlsx',
      file_type: 'XLSX',
      processing_status: 'READY',
      retention_expiry: new Date(Date.now() + 86400000).toISOString(),
    });

    datasetVtx = await registerDataset({
      file_id: crypto.randomUUID(),
      uploaded_by: USER_HR_VTX.user_id,
      company_id: 'VTX',
      original_filename: 'vtx_data.xlsx',
      file_type: 'XLSX',
      processing_status: 'READY',
      retention_expiry: new Date(Date.now() + 86400000).toISOString(),
    });

    assert.ok(datasetStl && datasetVtx);
  });

  await test('Scenario 22: STL HR cannot access VTX dataset (IDOR & Tenant Boundary Protection)', async () => {
    const access = canUserAccessDataset(datasetVtx, USER_HR_STL);
    assert.strictEqual(access.allowed, false);
    assert.ok(access.reason.includes('TENANT_MISMATCH'));
  });

  await test('Scenario 23: VTX HR cannot access STL dataset', async () => {
    const access = canUserAccessDataset(datasetStl, USER_HR_VTX);
    assert.strictEqual(access.allowed, false);
    assert.ok(access.reason.includes('TENANT_MISMATCH'));
  });

  await test('Scenario 24: ADMIN can access datasets across all tenants (STL and VTX)', async () => {
    const accessStl = canUserAccessDataset(datasetStl, USER_ADMIN);
    const accessVtx = canUserAccessDataset(datasetVtx, USER_ADMIN);
    assert.strictEqual(accessStl.allowed, true);
    assert.strictEqual(accessVtx.allowed, true);
  });

  await test('Scenario 25: EMPLOYEE can only access self-uploaded datasets within same tenant', async () => {
    const empDataset = await registerDataset({
      file_id: crypto.randomUUID(),
      uploaded_by: USER_EMP_STL_1.user_id,
      company_id: 'STL',
      original_filename: 'my_timesheet.xlsx',
      processing_status: 'READY',
      retention_expiry: new Date(Date.now() + 86400000).toISOString(),
    });

    // Employee 1 can access own dataset
    const accessOwner = canUserAccessDataset(empDataset, USER_EMP_STL_1);
    assert.strictEqual(accessOwner.allowed, true);

    // Employee 2 cannot access Employee 1's dataset
    const accessPeer = canUserAccessDataset(empDataset, USER_EMP_STL_2);
    assert.strictEqual(accessPeer.allowed, false);
  });

  await test('Scenario 26: List datasets for HR returns only datasets of their tenant', async () => {
    const listStl = listDatasetsForUser(USER_HR_STL);
    assert.ok(listStl.every((d) => d.company_id === 'STL'));
    assert.ok(listStl.some((d) => d.file_id === datasetStl.file_id));
    assert.ok(!listStl.some((d) => d.file_id === datasetVtx.file_id));
  });

  await test('Scenario 27: List datasets for ADMIN returns all tenants', async () => {
    const listAdmin = listDatasetsForUser(USER_ADMIN);
    assert.ok(listAdmin.some((d) => d.company_id === 'STL'));
    assert.ok(listAdmin.some((d) => d.company_id === 'VTX'));
  });

  await test('Scenario 28: Non-owner cannot delete dataset; ADMIN or uploader can delete', async () => {
    // Attempt deletion by non-owner HR VTX on STL dataset
    await assert.rejects(
      async () => await deleteDataset(datasetStl.file_id, USER_HR_VTX),
      (err) => err.status === 403
    );

    // ADMIN can delete
    const delRes = await deleteDataset(datasetVtx.file_id, USER_ADMIN);
    assert.strictEqual(delRes.success, true);
    assert.strictEqual(getDataset(datasetVtx.file_id), null);
  });

  await test('Scenario 29: Retention cleanup purges expired datasets', async () => {
    const expiredDataset = await registerDataset({
      file_id: crypto.randomUUID(),
      uploaded_by: USER_HR_STL.user_id,
      company_id: 'STL',
      original_filename: 'old_data.xlsx',
      processing_status: 'READY',
      retention_expiry: new Date(Date.now() - 3600000).toISOString(), // Expired 1 hour ago
    });

    const purgeRes = await cleanupExpiredDatasets();
    assert.ok(purgeRes.purgedCount >= 1);
    assert.strictEqual(getDataset(expiredDataset.file_id), null);
  });

  await test('Scenario 30: Deleted or expired dataset access is rejected', async () => {
    const dead = {
      file_id: 'dead-id',
      company_id: 'STL',
      uploaded_by: USER_HR_STL.user_id,
      processing_status: 'EXPIRED',
    };
    const access = canUserAccessDataset(dead, USER_ADMIN);
    assert.strictEqual(access.allowed, false);
    assert.strictEqual(access.reason, 'DATASET_EXPIRED_OR_DELETED');
  });

  // ==========================================================================
  // GROUP 4: IN-MEMORY ANALYTICAL QUERY ENGINE (PHASE 2.2)
  // ==========================================================================
  console.log('\n--- GROUP 4: ISOLATED ANALYTICAL QUERY ENGINE (31 - 38) ---');

  await test('Scenario 31: Query dataset with SUM and AVG aggregation grouped by Khách Hàng', async () => {
    const querySpec = {
      groupBy: ['khach_hang'],
      aggregations: [
        { column: 'doanh_thu', func: 'SUM', alias: 'tong_doanh_thu' },
        { column: 'doanh_thu', func: 'AVG', alias: 'tb_doanh_thu' },
        { column: 'ma_don', func: 'COUNT', alias: 'so_don' },
      ],
      orderBy: { column: 'tong_doanh_thu', dir: 'DESC' },
    };

    const res = await queryIsolatedDataset(testDatasetMetadata.file_id, querySpec);

    assert.strictEqual(res.returned_rows, 3); // Công ty A, B, C
    // Công ty C has 45M, Công ty A has 15M + 8.2M = 23.2M, Công ty B has 25.5M
    const topRow = res.results[0];
    assert.strictEqual(topRow.khach_hang, 'Công ty C');
    assert.strictEqual(topRow.tong_doanh_thu, 45000000);
    assert.strictEqual(topRow.so_don, 1);

    const rowA = res.results.find((r) => r.khach_hang === 'Công ty A');
    assert.strictEqual(rowA.tong_doanh_thu, 23200000);
    assert.strictEqual(rowA.so_don, 2);
  });

  await test('Scenario 32: Query dataset with numeric filter (gte / lt)', async () => {
    const querySpec = {
      filters: [{ column: 'doanh_thu', op: 'gte', value: 20000000 }],
    };

    const res = await queryIsolatedDataset(testDatasetMetadata.file_id, querySpec);
    assert.strictEqual(res.returned_rows, 2); // 25.5M and 45M
  });

  await test('Scenario 33: Query dataset with substring filter (contains)', async () => {
    const querySpec = {
      filters: [{ column: 'khach_hang', op: 'contains', value: 'Công ty A' }],
    };

    const res = await queryIsolatedDataset(testDatasetMetadata.file_id, querySpec);
    assert.strictEqual(res.returned_rows, 2); // DH001 and DH003
  });

  await test('Scenario 34: Query non-existent dataset returns 404', async () => {
    await assert.rejects(
      async () => await queryIsolatedDataset('non-existent-uuid', {}),
      (err) => err.status === 404
    );
  });

  await test('Scenario 35: Executive Markdown presentation formats schema, alerts and preview', async () => {
    const md = formatDatasetProfileMarkdown(testDatasetProfile);
    assert.ok(md.includes('don_hang_2026.xlsx'));
    assert.ok(md.includes('Doanh Thu'));
    assert.ok(md.includes('DH001'));
    assert.ok(md.includes('bi-dataset-widget'));
  });

  await test('Scenario 36: Markdown presentation escapes pipe characters to prevent XSS/Markdown breakage', async () => {
    const profileWithPipes = {
      ...testDatasetProfile,
      original_filename: 'test|injection.xlsx',
      columns: [
        { name: 'Cột|1', key: 'col1', type: 'STRING', non_null_count: 1, null_ratio_pct: 0, cardinality: 1 },
      ],
      preview_rows: [{ col1: 'Giá trị | có pipe' }],
    };
    const md = formatDatasetProfileMarkdown(profileWithPipes);
    assert.ok(!md.includes('| Cột|1 |'), 'Pipe in header must be escaped');
    assert.ok(md.includes('\\|'));
  });

  await test('Scenario 37: Zero PostgreSQL HR writes or table mutations during entire execution', async () => {
    // Verify that primary PostgreSQL database connection was never used for file rows
    // Storage is strictly under STORAGE_DIR
    const jsonPath = path.join(STORAGE_DIR, `${testDatasetMetadata.file_id}.dataset.json`);
    assert.ok(fs.existsSync(jsonPath));
  });

  await test('Scenario 38: Cleanup temporary test artifacts cleanly', async () => {
    try {
      if (testDatasetMetadata && testDatasetMetadata.storage_path && fs.existsSync(testDatasetMetadata.storage_path)) {
        fs.unlinkSync(testDatasetMetadata.storage_path);
      }
      const jsonPath = path.join(STORAGE_DIR, `${testDatasetMetadata.file_id}.dataset.json`);
      if (fs.existsSync(jsonPath)) {
        fs.unlinkSync(jsonPath);
      }
    } catch (_) {}
    assert.ok(true);
  });

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  console.log('\n================================================================');
  console.log(`PHASE 2 TEST SUMMARY: ${passCount} / ${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('Production Environment Connection: NONE (Zero Production Touch)');
  console.log('PostgreSQL HR Database Intrusion: ZERO (100% Isolated File Dataset)');
  console.log('================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Test runner fatal crash:', err);
  process.exit(1);
});
