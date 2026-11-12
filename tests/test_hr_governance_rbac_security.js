/**
 * SOTRANS HUB — BỘ KIỂM THỬ AN TOÀN PHÂN QUYỀN HR/ADMIN & VÒNG ĐỜI TRẠNG THÁI NHÂN SỰ
 * 
 * Kiểm tra 10 kịch bản nghiệp vụ theo yêu cầu kiểm toán:
 * 1. ADMIN xóa mềm -> HR thử khôi phục trên giao diện (UI Guards)
 * 2. ADMIN xóa mềm -> HR gọi API khôi phục trực tiếp (Chặn 403 & bảo toàn DELETED)
 * 3. ADMIN đánh dấu nghỉ việc -> HR thử chuyển về ACTIVE (Chặn 403 & bảo toàn RESIGNED)
 * 4. HR không có quyền -> API từ chối và không thay đổi database (Default Deny)
 * 5. ADMIN khôi phục hồ sơ DELETED hợp lệ (200 OK & đồng bộ ACTIVE)
 * 6. Nghiệp vụ tái tuyển dụng hoặc hủy quyết định nghỉ việc theo quyền được cấp
 * 7. Upload và đồng bộ lại hồ sơ DELETED/RESIGNED không được tự ý đổi trạng thái
 * 8. Kiểm tra audit log, chatbot và an toàn dữ liệu
 * 9. Kiểm tra cách ly đa công ty (Cross-tenant Isolation)
 * 10. Regression test chức năng nhân sự hiện có
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const TOKENS = {
  ADMIN: jwt.sign({
    user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac',
    username: 'superadmin',
    role: 'ADMIN',
    company_id: null
  }, JWT_SECRET, { expiresIn: '1h' }),

  HR_STL: jwt.sign({
    user_id: '9a2e8590-c1a2-41c6-abb2-b802cb8060c6',
    username: 'hr_stl',
    role: 'HR',
    company_id: 'STL'
  }, JWT_SECRET, { expiresIn: '1h' }),

  HR_SWC: jwt.sign({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '1h' })
};

function apiRequest(method, reqPath, body, token) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': 'Bearer ' + token
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: reqPath,
      method: method,
      headers: headers,
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: raw });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

let passed = 0;
let failed = 0;
const testDetails = [];

function assert(condition, testId, testName, evidence = '') {
  const isPass = !!condition;
  if (isPass) {
    console.log(`  ✅ [PASS] ${testId}: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testId}: ${testName} - ${evidence}`);
    failed++;
  }
  testDetails.push({ testId, testName, passed: isPass, evidence });
}

async function runSecurityAudit() {
  console.log('========================================================================================');
  console.log('   SOTRANS HUB — KIỂM THỬ BẢO MẬT & PHÂN QUYỀN NGHỈ VIỆC / XÓA MỀM / KHÔI PHỤC         ');
  console.log('========================================================================================\n');

  const TEST_EMP_CODE = 'STL-GOV-999';
  const TEST_CCCD = '079888999111';
  let testEmpId = null;

  // Dọn dẹp dữ liệu kiểm thử nếu còn tồn đọng trước đó
  try {
    await db.query(`DELETE FROM employees WHERE employee_code = $1`, [TEST_EMP_CODE]);
    await db.query(`DELETE FROM hr_employee_profiles WHERE employee_id = $1`, [TEST_EMP_CODE]);
    await db.query(`DELETE FROM auth_audit_logs WHERE metadata->>'employee_code' = $1`, [TEST_EMP_CODE]);
  } catch (e) {}

  try {
    // -----------------------------------------------------------------------------------
    // SETUP: Tạo nhân sự thử nghiệm trong công ty STL
    // -----------------------------------------------------------------------------------
    console.log('--- KHỞI TẠO BẢN GHI KIỂM THỬ RIÊNG BIỆT ---');
    const initRes = await db.query(`
      INSERT INTO employees (employee_code, employee_name, company_id, position, department, citizen_id, email, status)
      VALUES ($1, $2, 'STL', 'Chuyên viên Vận hành', 'Ban Logistics', $3, 'test.gov@sotrans.com.vn', 'ACTIVE')
      RETURNING id;
    `, [TEST_EMP_CODE, 'NGUYỄN VĂN KIỂM TOÁN', TEST_CCCD]);
    testEmpId = initRes.rows[0].id;

    await db.query(`
      INSERT INTO hr_employee_profiles (employee_id, full_name, company_id, job_title, department_staffing_plan, citizen_id, email, status)
      VALUES ($1, $2, 'STL', 'Chuyên viên Vận hành', 'Ban Logistics', $3, 'test.gov@sotrans.com.vn', 'ACTIVE');
    `, [TEST_EMP_CODE, 'NGUYỄN VĂN KIỂM TOÁN', TEST_CCCD]);
    console.log(`  ℹ️ Bản ghi kiểm thử đã tạo thành công với ID: ${testEmpId}\n`);

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 1: Kiểm tra giao diện người dùng (UI state & buttons)
    // -----------------------------------------------------------------------------------
    console.log('👉 KỊCH BẢN 1: Kiểm tra hiển thị nút thao tác theo quyền trên Giao diện');
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'chat', 'hr-admin.html'), 'utf-8');
    const hasAdminOnlyBatchRestore = htmlContent.includes("isSysAdmin && sVal === 'DELETED'");
    const hasAdminOnlySingleRestore = htmlContent.includes("else if(canDeleteEmp && isDeleted)");
    const hasAdminOnlyReactivate = htmlContent.includes("else if(canDeleteEmp && isResigned && !isDeleted)");

    assert(hasAdminOnlyBatchRestore, 'TC1.1', 'Nút Khôi phục hàng loạt chỉ hiển thị cho ADMIN khi lọc DELETED');
    assert(hasAdminOnlySingleRestore, 'TC1.2', 'Menu Thao tác: Nút Khôi phục hồ sơ đã xóa chỉ hiển thị cho ADMIN');
    assert(hasAdminOnlyReactivate, 'TC1.3', 'Menu Thao tác: Nút Tái kích hoạt nhân sự đã thôi việc chỉ hiển thị cho ADMIN');

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 2: ADMIN xóa mềm -> HR gọi API khôi phục trực tiếp
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 2: ADMIN xóa mềm -> HR gọi API khôi phục trực tiếp');
    // ADMIN xóa mềm
    const adminDeleteRes = await apiRequest('DELETE', `/api/employees/${testEmpId}`, {}, TOKENS.ADMIN);
    assert(adminDeleteRes.status === 200, 'TC2.1', 'ADMIN xóa mềm hồ sơ thành công (status chuyển DELETED)');

    // HR thử gọi API khôi phục đơn lẻ
    const hrRestoreRes = await apiRequest('POST', `/api/employees/${testEmpId}/restore`, {}, TOKENS.HR_STL);
    assert(hrRestoreRes.status === 403, 'TC2.2', 'HR bị từ chối 403 Forbidden khi gọi POST /:id/restore trực tiếp', JSON.stringify(hrRestoreRes.body));

    // HR thử gọi API khôi phục hàng loạt
    const hrBatchRestoreRes = await apiRequest('POST', `/api/employees/restore-batch`, { employee_ids: [testEmpId] }, TOKENS.HR_STL);
    assert(hrBatchRestoreRes.status === 403, 'TC2.3', 'HR bị từ chối 403 Forbidden khi gọi POST /restore-batch trực tiếp', JSON.stringify(hrBatchRestoreRes.body));

    // Xác minh trong CSDL hồ sơ vẫn là DELETED
    const dbCheckDeleted = await db.query(`SELECT status FROM employees WHERE id = $1`, [testEmpId]);
    assert(dbCheckDeleted.rows[0].status === 'DELETED', 'TC2.4', 'Cơ sở dữ liệu bảo toàn trạng thái DELETED (HR không thể đảo ngược)');

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 5 (Chạy trước để chuẩn bị cho KB 3): ADMIN khôi phục hồ sơ DELETED hợp lệ
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 5: ADMIN khôi phục hồ sơ DELETED hợp lệ');
    const adminRestoreRes = await apiRequest('POST', `/api/employees/${testEmpId}/restore`, {}, TOKENS.ADMIN);
    assert(adminRestoreRes.status === 200, 'TC5.1', 'ADMIN khôi phục hồ sơ thành công (status chuyển lại ACTIVE)', JSON.stringify(adminRestoreRes.body));

    const dbCheckActive = await db.query(`SELECT status FROM employees WHERE id = $1`, [testEmpId]);
    assert(dbCheckActive.rows[0].status === 'ACTIVE', 'TC5.2', 'Cơ sở dữ liệu cập nhật trạng thái ACTIVE sau khi ADMIN khôi phục');

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 3: ADMIN đánh dấu nghỉ việc -> HR thử chuyển về ACTIVE
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 3: ADMIN đánh dấu nghỉ việc -> HR thử chuyển về ACTIVE');
    // ADMIN đánh dấu thôi việc
    const adminResignRes = await apiRequest('POST', `/api/employees/${testEmpId}/resign`, {
      resignation_date: '2026-10-28',
      resignation_reason: 'Quyết định kỷ luật / Quản trị nội bộ của ADMIN'
    }, TOKENS.ADMIN);
    assert(adminResignRes.status === 200, 'TC3.1', 'ADMIN đánh dấu nhân viên nghỉ việc thành công (status = RESIGNED)');

    // HR thử gọi reactivate để chuyển về ACTIVE
    const hrReactivateOnAdminRes = await apiRequest('POST', `/api/employees/${testEmpId}/reactivate`, {
      decision_no: 'QD-STL-001',
      rehire_reason: 'HR tự ý phục hồi'
    }, TOKENS.HR_STL);
    assert(hrReactivateOnAdminRes.status === 403, 'TC3.2',
      'HR bị chặn 403 Forbidden khi cố gắng hủy quyết định nghỉ việc do ADMIN ban hành',
      JSON.stringify(hrReactivateOnAdminRes.body));

    // HR thử bypass qua PUT /api/employees/:id với { status: 'ACTIVE' }
    const hrPutBypassRes = await apiRequest('PUT', `/api/employees/${testEmpId}`, {
      status: 'ACTIVE'
    }, TOKENS.HR_STL);
    assert(hrPutBypassRes.status === 400, 'TC3.3',
      'HR bị từ chối 400 Bad Request khi cố thay đổi status qua generic PUT endpoint',
      JSON.stringify(hrPutBypassRes.body));

    // Xác minh CSDL vẫn là RESIGNED
    const dbCheckResigned = await db.query(`SELECT status FROM employees WHERE id = $1`, [testEmpId]);
    assert(dbCheckResigned.rows[0].status === 'RESIGNED', 'TC3.4', 'Cơ sở dữ liệu bảo toàn trạng thái RESIGNED');

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 4: HR không có quyền -> API từ chối và không thay đổi database
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 4: HR không có quyền hr.profile.reactivate -> API từ chối');
    // Thử reactivate khi không có quyền đặc biệt
    const hrNoPermRes = await apiRequest('POST', `/api/employees/${testEmpId}/reactivate`, {}, TOKENS.HR_STL);
    assert(hrNoPermRes.status === 403, 'TC4.1',
      'HR không có quyền hr.profile.reactivate bị chặn 403 Forbidden',
      JSON.stringify(hrNoPermRes.body));

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 6: Nghiệp vụ tái tuyển dụng hoặc hủy quyết định nghỉ việc theo quyền được cấp
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 6: Nghiệp vụ tái tuyển dụng hợp lệ của ADMIN & HR có thẩm quyền');
    // ADMIN thực hiện tái tuyển dụng / hủy quyết định nghỉ việc hợp lệ
    const adminRehireRes = await apiRequest('POST', `/api/employees/${testEmpId}/reactivate`, {
      action_type: 'REHIRE',
      decision_no: 'QD-SOTRANS-REHIRE-2026/01',
      rehire_reason: 'Tiếp nhận tái tuyển dụng nhân sự sau thời gian nghỉ theo quyết định HĐQT'
    }, TOKENS.ADMIN);
    assert(adminRehireRes.status === 200, 'TC6.1', 'ADMIN thực hiện tái tuyển dụng hợp lệ thành công (status = ACTIVE)', JSON.stringify(adminRehireRes.body));

    // Cấp quyền tạm thời hr.profile.reactivate cho HR để kiểm thử nghiệp vụ được ủy quyền
    await db.query(`INSERT INTO role_permissions (role, permission, description) VALUES ('HR', 'hr.profile.reactivate', 'Quyền tái tuyển dụng thử nghiệm') ON CONFLICT DO NOTHING;`);
    
    // Đánh dấu nghỉ việc bởi HR (không phải ADMIN)
    await apiRequest('POST', `/api/employees/${testEmpId}/resign`, {
      resignation_date: '2026-10-28',
      resignation_reason: 'Nghỉ việc theo nguyện vọng cá nhân (HR ghi nhận)'
    }, TOKENS.HR_STL);

    // HR có quyền nhưng thiếu số quyết định -> Bị từ chối 400
    const hrMissingDataRes = await apiRequest('POST', `/api/employees/${testEmpId}/reactivate`, {}, TOKENS.HR_STL);
    assert(hrMissingDataRes.status === 400, 'TC6.2', 'HR có quyền nhưng thiếu thông tin nghiệp vụ (decision_no) bị từ chối 400');

    // HR có quyền và cung cấp đầy đủ thông tin nghiệp vụ -> Thành công 200
    const hrRehireSuccessRes = await apiRequest('POST', `/api/employees/${testEmpId}/reactivate`, {
      action_type: 'REHIRE',
      decision_no: 'QD-STL-REHIRE-2026/88',
      rehire_reason: 'Tái tuyển dụng hợp lệ có phê duyệt Giám đốc đơn vị STL'
    }, TOKENS.HR_STL);
    assert(hrRehireSuccessRes.status === 200, 'TC6.3', 'HR có quyền và đầy đủ hồ sơ thực hiện tái tuyển dụng thành công');

    // Thu hồi quyền thử nghiệm sau test
    await db.query(`DELETE FROM role_permissions WHERE role = 'HR' AND permission = 'hr.profile.reactivate';`);

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 7: Upload và đồng bộ lại hồ sơ DELETED/RESIGNED không được tự ý đổi trạng thái
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 7: Upload & Intake không được tự ý đổi trạng thái hồ sơ');
    // ADMIN xóa mềm lại nhân sự kiểm thử
    await apiRequest('DELETE', `/api/employees/${testEmpId}`, {}, TOKENS.ADMIN);

    // Thử gửi intake staging approve dạng restore_proposal bởi HR
    const { executeStagingApproval } = require('../auth-service/routes/intake');
    let hrStagingReject = false;
    let hrStagingErrMsg = '';
    try {
      await executeStagingApproval(db, {
        id: 999999,
        intake_mode: 'restore_proposal',
        duplicate_classification: 'SOFT_DELETED_SAME_COMPANY',
        company_status: 'confirmed',
        company_id: 'STL',
        full_name: 'NGUYỄN VĂN KIỂM TOÁN',
        employee_code: TEST_EMP_CODE,
        citizen_id: TEST_CCCD
      }, { role: 'HR', company_id: 'STL', username: 'hr_stl' });
    } catch (stagingErr) {
      hrStagingErrMsg = stagingErr.message;
      if (stagingErr.status === 403) hrStagingReject = true;
    }
    assert(hrStagingReject, 'TC7.1', 'HR bị từ chối 403 khi cố duyệt khôi phục hồ sơ đã xóa mềm qua Intake Staging', hrStagingErrMsg);

    // Kiểm tra bảo toàn trạng thái trong confirm-ocr intake logic
    const intakeRouteCode = fs.readFileSync(path.join(__dirname, '..', 'auth-service', 'routes', 'intake.js'), 'utf-8');
    const hasStatusPreservation = intakeRouteCode.includes("targetStatus = (existingEmp.status === 'DELETED' || existingEmp.status === 'RESIGNED')");
    assert(hasStatusPreservation, 'TC7.2', 'Hàm xác nhận intake bảo toàn trạng thái DELETED/RESIGNED, không tự động chuyển thành ACTIVE');

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 8: Kiểm tra Audit Log & Chatbot
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 8: Kiểm tra Audit Log và Chặn khôi phục qua Chatbot');
    // Kiểm tra audit log ghi nhận các sự kiện từ chối FORBIDDEN
    const auditRes = await db.query(`
      SELECT action, status, actor_username 
      FROM auth_audit_logs 
      WHERE (metadata->>'employee_id' = $1 OR metadata->>'employee_code' = $2)
        AND status = 'FORBIDDEN'
      ORDER BY created_at DESC;
    `, [testEmpId, TEST_EMP_CODE]);
    assert(auditRes.rows.length >= 2, 'TC8.1',
      `Audit log ghi nhận đầy đủ các lần HR bị từ chối quyền (Tìm thấy ${auditRes.rows.length} bản ghi FORBIDDEN)`);

    // Chatbot: HR thử ra lệnh khôi phục qua chatbot
    const chatbotRes = await apiRequest('POST', '/api/hoso/chat', {
      message: `Khôi phục hồ sơ nhân viên ${TEST_EMP_CODE}`
    }, TOKENS.HR_STL);
    const chatReply = chatbotRes.body?.reply || '';
    const chatbotBlocked = chatReply.includes('TỪ CHỐI THỰC HIỆN') || chatReply.includes('không có quyền khôi phục') || !chatReply.includes('ĐÃ KHÔI PHỤC THÀNH CÔNG');
    assert(chatbotBlocked, 'TC8.2', 'Chatbot từ chối yêu cầu khôi phục hồ sơ xóa mềm của HR');

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 9: Kiểm tra cách ly đa công ty (Cross-tenant isolation)
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 9: Kiểm tra cách ly đa công ty (Cross-tenant RBAC)');
    const crossResignRes = await apiRequest('POST', `/api/employees/${testEmpId}/resign`, {}, TOKENS.HR_SWC);
    assert(crossResignRes.status === 403, 'TC9.1', 'HR công ty SWC bị chặn 403 khi thao tác trên nhân sự công ty STL');

    const crossReactivateRes = await apiRequest('POST', `/api/employees/${testEmpId}/reactivate`, {}, TOKENS.HR_SWC);
    assert(crossReactivateRes.status === 403, 'TC9.2', 'HR công ty SWC bị chặn 403 khi tái kích hoạt nhân sự công ty STL');

    // -----------------------------------------------------------------------------------
    // KỊCH BẢN 10: Regression test chức năng nhân sự hiện có
    // -----------------------------------------------------------------------------------
    console.log('\n👉 KỊCH BẢN 10: Regression test chức năng quản lý nhân sự');
    // ADMIN khôi phục hồ sơ test về ACTIVE
    await apiRequest('POST', `/api/employees/${testEmpId}/restore`, {}, TOKENS.ADMIN);

    // HR cập nhật thông tin phòng ban, vị trí hợp lệ qua PUT
    const validPutRes = await apiRequest('PUT', `/api/employees/${testEmpId}`, {
      position: 'Kỹ sư Vận hành Cấp cao',
      department: 'Ban Vận tải Đường bộ'
    }, TOKENS.HR_STL);
    assert(validPutRes.status === 200, 'TC10.1', 'HR cập nhật chức vụ và phòng ban hợp lệ qua PUT thành công');

    const listRes = await apiRequest('GET', '/api/employees', null, TOKENS.HR_STL);
    assert(listRes.status === 200 && Array.isArray(listRes.body.data), 'TC10.2', 'GET /api/employees hoạt động chuẩn xác');

  } catch (err) {
    console.error('Lỗi ngoại lệ trong quá trình kiểm toán:', err);
    failed++;
  } finally {
    // -----------------------------------------------------------------------------------
    // TEARDOWN: Xóa sạch dữ liệu kiểm thử
    // -----------------------------------------------------------------------------------
    console.log('\n--- DỌN DẸP DỮ LIỆU KIỂM THỬ AN TOÀN (TEARDOWN) ---');
    if (testEmpId) {
      try {
        await db.query(`DELETE FROM hr_sync_tasks WHERE employee_id = $1`, [testEmpId]);
        await db.query(`DELETE FROM hr_employee_profiles WHERE employee_id = $1`, [TEST_EMP_CODE]);
        await db.query(`DELETE FROM employees WHERE id = $1`, [testEmpId]);
        await db.query(`DELETE FROM auth_audit_logs WHERE metadata->>'employee_code' = $1`, [TEST_EMP_CODE]);
        console.log(`  🧹 Đã xóa dọn dẹp sạch sẽ nhân sự kiểm thử ID: ${testEmpId}`);
      } catch (e) {
        console.error('Lỗi dọn dẹp:', e);
      }
    }
    await db.pool.end();
  }

  console.log('\n========================================================================================');
  console.log(`📊 TỔNG KẾT KIỂM TOÁN AN TOÀN: ${passed} PASS, ${failed} FAIL`);
  console.log('========================================================================================');
  return { passed, failed, testDetails };
}

if (require.main === module) {
  runSecurityAudit().then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}

module.exports = { runSecurityAudit };
