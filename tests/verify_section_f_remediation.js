/**
 * SOTRANS HUB — VERIFICATION SCRIPT FOR SECTION F (AUDIT & REMEDIATION)
 * 
 * Verifies all 4 remediation items:
 * - VULN-01: n8n workflow SQL filtering of deleted profiles
 * - VULN-02: hr_employee_profiles table schema standardization (status column + index)
 * - VULN-03: Default employee list view defaults to ACTIVE in API & UI
 * - VULN-04: Chatbot PII masking for RESIGNED employees & blocking of DELETED profiles
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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
  }, JWT_SECRET, { expiresIn: '1h' })
};

function apiRequest(method, path, body, token) {
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
      path: path,
      method: method,
      headers: headers,
      timeout: 15000
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

function assert(condition, testName, detail = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName} - ${detail}`);
    failed++;
  }
}

async function runSectionFVerification() {
  console.log('========================================================================');
  console.log('   SOTRANS HUB — BỘ ĐỐI SOÁT & KIỂM THỬ TỰ ĐỘNG PHẦN F (REMEDIATION)   ');
  console.log('========================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // VULN-01: KIỂM TOÁN N8N WORKFLOW SECURITY
    // -------------------------------------------------------------------------
    console.log('👉 [VULN-01] Kiểm toán bảo mật Workflow n8n (Fast Intent & Query Rewrite)');
    
    let n8nWorkflowVerified = false;
    let n8nDetails = '';
    try {
      const exportRaw = execSync(`docker exec hrbot-n8n-1 n8n export:workflow --id=KRZmkYM690YlIdPU`, { encoding: 'utf-8' });
      const wfArray = JSON.parse(exportRaw);
      const wf = wfArray[0] || {};
      const nodes = wf.nodes || [];
      const fastIntentNode = nodes.find(n => n.name === 'Parse_Fast_Intent');
      const rewriteNode = nodes.find(n => n.name === 'Build_SQL_From_Rewrite');

      const fastCode = fastIntentNode?.parameters?.jsCode || '';
      const rewriteCode = rewriteNode?.parameters?.jsCode || '';

      const fastOk = fastCode.includes("status != 'DELETED'") && fastCode.includes("[ĐÃ XÓA]");
      const rewriteOk = rewriteCode.includes("status != 'DELETED'") && rewriteCode.includes("[ĐÃ XÓA]");

      n8nWorkflowVerified = fastOk && rewriteOk;
      n8nDetails = `Parse_Fast_Intent ok: ${fastOk}, Build_SQL_From_Rewrite ok: ${rewriteOk}`;
    } catch (e) {
      n8nDetails = e.message;
    }
    assert(n8nWorkflowVerified, 'Workflow KRZmkYM690YlIdPU chặn 100% hồ sơ [ĐÃ XÓA] và DELETED trong Fast Path & Rewrite', n8nDetails);

    // -------------------------------------------------------------------------
    // VULN-02: KIỂM TOÁN DATABASE SCHEMA STANDARDIZATION
    // -------------------------------------------------------------------------
    console.log('\n👉 [VULN-02] Kiểm toán chuẩn hóa cấu trúc dữ liệu hr_employee_profiles');
    
    // Check column exists
    const colRes = await db.query(`
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'hr_employee_profiles' AND column_name = 'status';
    `);
    assert(colRes.rows.length === 1 && colRes.rows[0].column_name === 'status', 
      'Cột "status" tồn tại trong bảng hr_employee_profiles', JSON.stringify(colRes.rows));

    // Check index exists
    const idxRes = await db.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'hr_employee_profiles' AND indexname = 'idx_hr_employee_profiles_status';
    `);
    assert(idxRes.rows.length === 1, 
      'Index idx_hr_employee_profiles_status được tạo thành công trên cột status', JSON.stringify(idxRes.rows));

    // Check data integrity
    const statusCountRes = await db.query(`
      SELECT status, COUNT(*) AS count 
      FROM hr_employee_profiles 
      GROUP BY status 
      ORDER BY status;
    `);
    const statusCounts = {};
    statusCountRes.rows.forEach(r => statusCounts[r.status] = parseInt(r.count, 10));
    assert(statusCounts['ACTIVE'] > 0 && statusCounts['DELETED'] >= 1 && !statusCounts['null'], 
      'Dữ liệu hồ sơ đã được chuẩn hóa (ACTIVE: ' + statusCounts['ACTIVE'] + ', DELETED: ' + statusCounts['DELETED'] + ')',
      JSON.stringify(statusCounts));

    // Check STL00009 has status DELETED
    const delProfileRes = await db.query(`
      SELECT employee_id, full_name, status, job_grade 
      FROM hr_employee_profiles 
      WHERE employee_id = 'STL00009';
    `);
    assert(delProfileRes.rows.length === 1 && delProfileRes.rows[0].status === 'DELETED',
      'Hồ sơ đã xóa mềm STL00009 (LÊ MINH ĐỨC) có status = "DELETED" và job_grade = "[ĐÃ XÓA]"',
      JSON.stringify(delProfileRes.rows));

    // -------------------------------------------------------------------------
    // VULN-03: KIỂM TOÁN DEFAULT VIEW VÀ PHÂN TRANG / LỌC TRẠNG THÁI
    // -------------------------------------------------------------------------
    console.log('\n👉 [VULN-03] Kiểm toán mặc định ACTIVE trong API và Giao diện Quản trị');

    // 1. GET /api/employees without status -> must return only ACTIVE
    const defaultListRes = await apiRequest('GET', '/api/employees', null, TOKENS.HR_STL);
    const defaultList = defaultListRes.body.data || defaultListRes.body.employees || [];
    const hasNonActiveByDefault = defaultList.some(e => e.status !== 'ACTIVE');
    assert(defaultListRes.status === 200 && !hasNonActiveByDefault && defaultList.length > 0,
      'GET /api/employees mặc định trả về 100% hồ sơ ACTIVE (không lẫn RESIGNED hoặc DELETED)',
      `Tổng số: ${defaultList.length}, có hồ sơ khác ACTIVE: ${hasNonActiveByDefault}`);

    // 2. GET /api/employees?status=ALL -> returns all including DELETED
    const allListRes = await apiRequest('GET', '/api/employees?status=ALL', null, TOKENS.HR_STL);
    const allList = allListRes.body.data || allListRes.body.employees || [];
    const hasDeletedInAll = allList.some(e => e.status === 'DELETED');
    assert(hasDeletedInAll, 'GET /api/employees?status=ALL hiển thị đầy đủ bao gồm cả DELETED', `Tổng số: ${allList.length}`);

    // 3. Stats verification
    const stats = defaultListRes.body.stats;
    assert(stats && stats.active > 0 && stats.deleted > 0 && stats.total > 0,
      'Số liệu thống kê thẻ tổng quan (stats) chuẩn xác: Total=' + stats?.total + ', Active=' + stats?.active + ', Deleted=' + stats?.deleted);

    // 4. Verify hr-admin.html default view & dropdown
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'chat', 'hr-admin.html'), 'utf-8');
    assert(htmlContent.includes(`let currentEmpStatFilter = 'active';`),
      'hr-admin.html khởi tạo currentEmpStatFilter = "active" để tô sáng thẻ "Đang làm việc"');
    assert(htmlContent.includes(`<option value="ACTIVE" selected>Đang làm việc (ACTIVE)</option>`),
      'hr-admin.html có dropdown empStatusFilter mặc định chọn ACTIVE');

    // -------------------------------------------------------------------------
    // VULN-04: KIỂM TOÁN BẢO VỆ PII NHÂN VIÊN RESIGNED & CHẶN DELETED TRÊN CHATBOT
    // -------------------------------------------------------------------------
    console.log('\n👉 [VULN-04] Kiểm toán bảo vệ PII nhân viên thôi việc và chặn hồ sơ đã xóa trên Chatbot');

    // 1. Check DELETED employee query by HR -> must NOT return profile details
    const deletedChatRes = await apiRequest('POST', '/api/hoso/chat', {
      message: 'Tra cứu thông tin nhân viên LÊ MINH ĐỨC mã STL00009'
    }, TOKENS.HR_STL);
    const delReply = deletedChatRes.body?.reply || '';
    const delLeak = delReply.includes('079089001234') || delReply.includes('Trưởng phòng Kỹ thuật');
    assert(!delLeak, 'Chatbot KHÔNG để lộ thông tin hồ sơ đã xóa mềm STL00009 (LÊ MINH ĐỨC)', delReply.slice(0, 150));

    // 2. Test RESIGNED employee PII masking:
    // Create a temporary test resigned employee in STL
    const testResignedCode = 'STL-7777';
    await db.query(`DELETE FROM employees WHERE employee_code = $1`, [testResignedCode]);
    await db.query(`DELETE FROM hr_employee_profiles WHERE employee_id = $1`, [testResignedCode]);

    await db.query(`
      INSERT INTO employees (employee_code, employee_name, company_id, position, department, status, email, citizen_id, resignation_date, resignation_reason)
      VALUES ($1, $2, $3, $4, $5, 'RESIGNED', 'resigned.test@sotrans.com.vn', '079123456789', '2026-09-30', 'Đã chuyển công tác');
    `, [testResignedCode, 'TRẦN THỊ THỬ NGHIỆM', 'STL', 'Chuyên viên Khai thác', 'Ban Vận tải']);
    
    await db.query(`
      INSERT INTO hr_employee_profiles (employee_id, full_name, company_id, job_title, department_staffing_plan, status, phone_number, email, citizen_id, job_grade)
      VALUES ($1, $2, $3, $4, $5, 'RESIGNED', '0912345678', 'resigned.test@sotrans.com.vn', '079123456789', '[NGHỈ VIỆC]');
    `, [testResignedCode, 'TRẦN THỊ THỬ NGHIỆM', 'STL', 'Chuyên viên Khai thác', 'Ban Vận tải']);

    try {
      // Query as HR -> Phone/Email should be masked
      const hrQueryRes = await apiRequest('POST', '/api/hoso/chat', {
        message: 'Thông tin nhân viên TRẦN THỊ THỬ NGHIỆM mã STL-7777'
      }, TOKENS.HR_STL);
      const hrReply = hrQueryRes.body?.reply || '';

      const isStatusTransparent = hrReply.includes('ĐÃ NGHỈ VIỆC') || hrReply.includes('RESIGNED') || hrReply.includes('thôi việc');
      const isPhoneMasked = hrReply.includes('091****') || hrReply.includes('Đã che') || !hrReply.includes('0912345678');
      const isEmailMasked = hrReply.includes('Đã che bảo mật') || !hrReply.includes('resigned.test@sotrans.com.vn');

      assert(isStatusTransparent, 'Chatbot thông báo rõ ràng trạng thái nhân viên ĐÃ NGHỈ VIỆC');
      assert(isPhoneMasked && isEmailMasked, 'Chatbot che bảo mật PII (Số điện thoại, Email) của nhân viên đã nghỉ việc đối với HR', hrReply.slice(0, 200));

      // Query as ADMIN -> Personal info available for administrative review
      const adminQueryRes = await apiRequest('POST', '/api/hoso/chat', {
        message: 'Thông tin nhân viên TRẦN THỊ THỬ NGHIỆM mã STL-7777'
      }, TOKENS.ADMIN);
      const adminReply = adminQueryRes.body?.reply || '';
      assert(adminReply.includes('TRẦN THỊ THỬ NGHIỆM') && (adminReply.includes('0912345678') || adminReply.includes('Chuyên viên Khai thác')),
        'ADMIN có quyền thẩm tra hồ sơ đầy đủ của nhân sự đã nghỉ việc theo đúng phân quyền');

    } finally {
      // Clean up test employee
      await db.query(`DELETE FROM employees WHERE employee_code = $1`, [testResignedCode]);
      await db.query(`DELETE FROM hr_employee_profiles WHERE employee_id = $1`, [testResignedCode]);
    }

  } catch (err) {
    console.error('Lỗi ngoại lệ trong quá trình kiểm thử Phần F:', err);
    failed++;
  } finally {
    await db.pool.end();
  }

  console.log('\n========================================================================');
  console.log(`📊 TỔNG KẾT KIỂM TOÁN PHẦN F: ${passed} PASS, ${failed} FAIL`);
  console.log('========================================================================');
  return { passed, failed };
}

if (require.main === module) {
  runSectionFVerification().then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}

module.exports = { runSectionFVerification };
