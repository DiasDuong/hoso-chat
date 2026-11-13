/**
 * SOTRANS HUB — GOOGLE SHEETS RECONCILIATION & TEST DATA ISOLATION ACCEPTANCE SUITE
 * 
 * Kiểm thử nghiệm thu toàn diện theo yêu cầu:
 * 1. Hiện trạng: NocoDB = SoT (3 hồ sơ) khớp hoàn toàn với Google Sheets (3 hồ sơ)
 * 2. Idempotent: Chạy đồng bộ nhiều lần liên tiếp không phát sinh bản ghi trùng
 * 3. Update: Sửa thông tin tại NocoDB cập nhật chính xác dòng theo employee_id
 * 4. Soft Delete & Restore: Xử lý trạng thái xóa mềm chính xác trên Sheets
 * 5. Test Isolation: Ngăn dữ liệu kiểm thử xuất hiện trên Google Sheets Production
 * 6. Add & Teardown: Thêm nhân sự mới tại NocoDB, đồng bộ sang Sheets và dọn dẹp sạch
 * 7. Integrity Layers: Phân biệt rõ 3 lớp toàn vẹn (Sync, Reconciliation, Data Integrity)
 */

const path = require('path');
require('../auth-service/node_modules/dotenv').config({ path: path.join(__dirname, '../auth-service/.env') });
const db = require('../auth-service/db');
const { reconcileEmployees } = require('../auth-service/services/reconciliationService');
const { fetchGoogleSheetAllRows, syncEventToGoogleSheets, deleteGoogleSheetRows, isTestRecord, runWithGoogleSheetsLock } = require('../auth-service/services/syncWorker');
const http = require('http');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

const ADMIN_TOKEN = makeToken({
  user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac',
  username: 'superadmin',
  role: 'ADMIN'
});

function httpRequest(method, urlPath, headers = {}, body = null, port = 3000) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const reqHeaders = { ...headers };

    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    } else if (Buffer.isBuffer(body)) {
      payload = body;
      reqHeaders['Content-Length'] = payload.length;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: reqHeaders,
      timeout: 30000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          resolve({ status: res.statusCode, headers: res.headers, data: parsed, raw: data });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, data, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition, testName, detail = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

async function runAcceptanceSuite() {
  console.log('================================================================================');
  console.log('  SOTRANS HUB — GOOGLE SHEETS RECONCILIATION & DATA INTEGRITY ACCEPTANCE SUITE  ');
  console.log('================================================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: Kiểm tra hiện trạng sau dọn dẹp (Parity 3 hồ sơ chuẩn)
  // --------------------------------------------------------------------------
  console.log('👉 TEST 1: Kiểm tra đối soát hiện trạng (NocoDB 3 == Sheets 3 == Website 3)');
  const reconInit = await reconcileEmployees({ autoFix: false, cleanStale: false });
  assert(reconInit.counts.nocodb_official === 3, 'T1.1: NocoDB SoT có đúng 3 hồ sơ chính thức', `Got ${reconInit.counts.nocodb_official}`);
  assert(reconInit.counts.google_sheets_total === 3, 'T1.2: Google Sheets có đúng 3 dòng dữ liệu (không dư thừa)', `Got ${reconInit.counts.google_sheets_total}`);
  assert(reconInit.counts.google_sheets_matched === 3, 'T1.3: Google Sheets khớp 3/3 hồ sơ chính thức', `Got ${reconInit.counts.google_sheets_matched}`);
  assert(reconInit.counts.google_sheets_stale === 0, 'T1.4: Không còn dòng stale (Uyên, Hiếu đã dọn sạch)', `Got ${reconInit.counts.google_sheets_stale}`);
  assert(reconInit.counts.google_sheets_test === 0, 'T1.5: Không còn dòng kiểm thử trên Sheets Production', `Got ${reconInit.counts.google_sheets_test}`);
  assert(reconInit.is_consistent === true, 'T1.6: Hệ thống đạt trạng thái is_consistent = true');
  assert(reconInit.integrity_layers.sync_pipeline.status === 'SYNC_SUCCESS', 'T1.7: Lớp 1 (Sync Pipeline) đạt SYNC_SUCCESS');
  assert(reconInit.integrity_layers.reconciliation.status === 'RECONCILIATION_SUCCESS', 'T1.8: Lớp 2 (Reconciliation) đạt RECONCILIATION_SUCCESS');
  assert(reconInit.integrity_layers.data_integrity.status === 'DATA_INTEGRITY_SUCCESS', 'T1.9: Lớp 3 (Data Integrity) đạt DATA_INTEGRITY_SUCCESS');

  // --------------------------------------------------------------------------
  // TEST 2: Tính lũy thừa (Idempotency) khi chạy đồng bộ nhiều lần liên tiếp
  // --------------------------------------------------------------------------
  console.log('\n👉 TEST 2: Kiểm tra tính lũy thừa khi chạy đồng bộ liên tiếp');
  const run1 = await reconcileEmployees({ autoFix: true });
  const run2 = await reconcileEmployees({ autoFix: true });
  const run3 = await reconcileEmployees({ autoFix: true });
  const sheetAfterRuns = await fetchGoogleSheetAllRows();
  assert(sheetAfterRuns.rows.length === 3, 'T2.1: Chạy 3 lần liên tiếp Google Sheets vẫn giữ nguyên đúng 3 dòng (không sinh dòng trùng)', `Got ${sheetAfterRuns.rows.length}`);
  assert(run3.counts.google_sheets_duplicates === 0, 'T2.2: Không phát sinh bất kỳ bản ghi trùng lặp nào');

  // --------------------------------------------------------------------------
  // TEST 3: Cập nhật thông tin nhân sự tại NocoDB và đồng bộ đúng dòng
  // --------------------------------------------------------------------------
  console.log('\n👉 TEST 3: Sửa thông tin nhân sự tại NocoDB -> Cập nhật đúng dòng theo employee_id');
  const targetCode = 'SWC00046';
  const originalProfile = (await db.query('SELECT * FROM hr_employee_profiles WHERE employee_id = $1', [targetCode])).rows[0];
  const oldJobTitle = originalProfile.job_title;
  const newJobTitle = 'CHUYÊN VIÊN PHÁT TRIỂN HỆ THỐNG CAO CẤP (TEST)';

  // Update in NocoDB
  await db.query('UPDATE hr_employee_profiles SET job_title = $1, version = version + 1, updated_at = NOW() WHERE employee_id = $2', [newJobTitle, targetCode]);

  // Reconcile with autoFix
  const reconUpdate = await reconcileEmployees({ autoFix: true });
  assert(reconUpdate.fixed_in_sheets.length > 0 || reconUpdate.data_mismatches.length > 0, 'T3.1: Đối soát phát hiện sự thay đổi dữ liệu và tiến hành cập nhật');

  // Verify in Google Sheets
  const sheetAfterUpdate = await fetchGoogleSheetAllRows();
  assert(sheetAfterUpdate.rows.length === 3, 'T3.2: Số dòng Google Sheets không đổi (3 dòng)', `Got ${sheetAfterUpdate.rows.length}`);
  const updatedRow = sheetAfterUpdate.rows.find(r => r.empId === targetCode);
  const titleIdx = sheetAfterUpdate.header.indexOf('job_title');
  const actualSheetTitle = updatedRow ? updatedRow.values[titleIdx] : null;
  assert(actualSheetTitle === newJobTitle, 'T3.3: Google Sheets đã cập nhật đúng chức danh mới tại đúng dòng', `Got "${actualSheetTitle}"`);

  // Restore back to original
  await db.query('UPDATE hr_employee_profiles SET job_title = $1, version = version + 1, updated_at = NOW() WHERE employee_id = $2', [oldJobTitle, targetCode]);
  await reconcileEmployees({ autoFix: true });

  // --------------------------------------------------------------------------
  // TEST 4: Xóa mềm và khôi phục hồ sơ
  // --------------------------------------------------------------------------
  console.log('\n👉 TEST 4: Xóa mềm một hồ sơ -> Cập nhật trạng thái xóa mềm trên Sheets');
  // Soft delete SWC00046 in NocoDB
  await db.query('UPDATE hr_employee_profiles SET status = \'DELETED\', is_deleted = true, deleted_at = NOW(), version = version + 1 WHERE employee_id = $1', [targetCode]);

  const reconSoftDel = await reconcileEmployees({ autoFix: true });
  const sheetAfterSoftDel = await fetchGoogleSheetAllRows();
  assert(sheetAfterSoftDel.rows.length === 3, 'T4.1: Số dòng trên Sheets vẫn bảo toàn (3 dòng, không xóa mất dòng)', `Got ${sheetAfterSoftDel.rows.length}`);
  const softDelRow = sheetAfterSoftDel.rows.find(r => r.empId === targetCode);
  assert(softDelRow.isDeleted === true, 'T4.2: Google Sheets ghi nhận cờ is_deleted = true cho hồ sơ xóa mềm');

  // Restore SWC00046
  await db.query('UPDATE hr_employee_profiles SET status = \'ACTIVE\', is_deleted = false, deleted_at = NULL, version = version + 1 WHERE employee_id = $1', [targetCode]);
  await reconcileEmployees({ autoFix: true });
  const sheetAfterRestore = await fetchGoogleSheetAllRows();
  const restoredRow = sheetAfterRestore.rows.find(r => r.empId === targetCode);
  assert(restoredRow.isDeleted === false, 'T4.3: Google Sheets khôi phục cờ is_deleted = false khi hồ sơ active trở lại');

  // --------------------------------------------------------------------------
  // TEST 5: Cơ chế ngăn dữ liệu kiểm thử xuất hiện trên Google Sheets Production
  // --------------------------------------------------------------------------
  console.log('\n👉 TEST 5: Ngăn chặn dữ liệu kiểm thử đồng bộ sang Google Sheets Production');
  const mockTestPayload = {
    employee_id: 'SWC_MOCK_TEST_99',
    full_name: 'NGUYỄN VĂN TEST MOCK',
    citizen_id: '079199999999',
    company_id: 'SWC',
    is_test: true,
    metadata: { test_run: true }
  };

  const testSyncResult = await runWithGoogleSheetsLock(async () => {
    return await syncEventToGoogleSheets({
      event_id: 'test_event_' + Date.now(),
      employee_id: mockTestPayload.employee_id,
      action_type: 'UPSERT',
      version: 1,
      payload: mockTestPayload
    });
  });

  assert(testSyncResult.action === 'SKIPPED_TEST_RECORD', 'T5.1: Worker từ chối ghi và trả về action SKIPPED_TEST_RECORD');
  const sheetAfterMock = await fetchGoogleSheetAllRows();
  const mockFound = sheetAfterMock.rows.find(r => r.empId === 'SWC_MOCK_TEST_99');
  assert(!mockFound, 'T5.2: Google Sheets Production KHÔNG bị ghi nhận bản ghi kiểm thử');
  assert(sheetAfterMock.rows.length === 3, 'T5.3: Tổng số dòng trên Google Sheets Production vẫn an toàn ở 3 dòng');

  // --------------------------------------------------------------------------
  // TEST 6: Thêm nhân sự mới tại NocoDB, đồng bộ và dọn dẹp kiểm thử
  // --------------------------------------------------------------------------
  console.log('\n👉 TEST 6: Thêm nhân sự mới tại NocoDB -> Đồng bộ sang Sheets -> Dọn dẹp an toàn');
  const testNewCode = 'STL00088';
  const testNewCccd = '079201888999';
  const testNewName = 'HOÀNG VĂN THỬ NGHIỆM';

  // Insert to NocoDB
  await db.query(`
    INSERT INTO hr_employee_profiles (
      employee_id, full_name, citizen_id, company_id, job_grade, status, employment_status, is_deleted, version, created_at, updated_at
    ) VALUES (
      $1, $2, $3, 'STL', 'Bậc 4', 'ACTIVE', 'ACTIVE', false, 1, NOW(), NOW()
    )
  `, [testNewCode, testNewName, testNewCccd]);

  // Sync to Sheets
  const reconAdd = await reconcileEmployees({ autoFix: true });
  const sheetAfterAdd = await fetchGoogleSheetAllRows();
  assert(sheetAfterAdd.rows.length === 4, 'T6.1: Google Sheets tiếp nhận chính xác thêm 1 dòng hồ sơ mới (tổng 4 dòng)', `Got ${sheetAfterAdd.rows.length}`);
  const newRow = sheetAfterAdd.rows.find(r => r.empId === testNewCode);
  assert(newRow && newRow.fullName === testNewName, 'T6.2: Dòng mới trên Sheets có đầy đủ mã và tên khớp NocoDB');

  // Teardown: Delete from NocoDB and Website employees
  await db.query('DELETE FROM hr_employee_profiles WHERE employee_id = $1', [testNewCode]);
  await db.query('DELETE FROM employees WHERE employee_code = $1', [testNewCode]);

  // Clean stale from Sheets
  const reconClean = await reconcileEmployees({ autoFix: true, cleanStale: true });
  const sheetFinal = await fetchGoogleSheetAllRows();
  assert(sheetFinal.rows.length === 3, 'T6.3: Dọn dẹp dòng đã xóa khỏi NocoDB đưa Sheets trở về đúng 3 dòng', `Got ${sheetFinal.rows.length}`);
  const cleanedCheck = sheetFinal.rows.find(r => r.empId === testNewCode);
  assert(!cleanedCheck, 'T6.4: Hồ sơ đã xóa không còn tồn tại trên Sheets');

  // --------------------------------------------------------------------------
  // TEST 7: Kiểm tra API Endpoint và Giao diện Modal
  // --------------------------------------------------------------------------
  console.log('\n👉 TEST 7: Kiểm tra API /api/employees/sync/status và phân tách 3 lớp toàn vẹn');
  const apiRes = await httpRequest('GET', '/api/employees/sync/status', {
    'Authorization': `Bearer ${ADMIN_TOKEN}`
  });
  assert(apiRes.status === 200, 'T7.1: API /api/employees/sync/status phản hồi HTTP 200');
  const apiData = apiRes.data;
  assert(apiData.success === true, 'T7.2: API trả về success = true');
  assert(apiData.integrity_layers !== undefined, 'T7.3: API trả về cấu trúc phân tách 3 lớp toàn vẹn dữ liệu (integrity_layers)');
  assert(apiData.integrity_layers.sync_pipeline.status === 'SYNC_SUCCESS', 'T7.4: integrity_layers.sync_pipeline = SYNC_SUCCESS');
  assert(apiData.integrity_layers.reconciliation.status === 'RECONCILIATION_SUCCESS', 'T7.5: integrity_layers.reconciliation = RECONCILIATION_SUCCESS');
  assert(apiData.integrity_layers.data_integrity.status === 'DATA_INTEGRITY_SUCCESS', 'T7.6: integrity_layers.data_integrity = DATA_INTEGRITY_SUCCESS');
  assert(apiData.counts.nocodb_official === 3, 'T7.7: Số hồ sơ chính thức NocoDB = 3');
  assert(apiData.counts.google_sheets_matched === 3, 'T7.8: Số hồ sơ khớp trên Google Sheets = 3');
  assert(apiData.counts.google_sheets_test === 0, 'T7.9: Số bản ghi kiểm thử = 0');
  assert(apiData.counts.google_sheets_stale === 0, 'T7.10: Số bản ghi dư thừa = 0');
  assert(apiData.status.is_synchronized === true, 'T7.11: Hệ thống xác nhận đồng bộ toàn vẹn 100%');

  console.log('\n================================================================================');
  console.log(`TỔNG KẾT NGHIỆM THU: ${passed + failed} TEST CASES | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAcceptanceSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
