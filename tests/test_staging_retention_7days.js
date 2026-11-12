const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');
const { purgeStagingRecords } = require('../auth-service/services/retentionService');

const BASE_URL = 'http://127.0.0.1:3000';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const tokens = {
  admin: jwt.sign(
    { user_id: 'fd54c14e-2a82-4f1d-af37-dc4cd40461cd', username: 'admin_stl', role: 'ADMIN', company_id: 'STL' },
    JWT_SECRET,
    { expiresIn: '1h' }
  ),
  employee: jwt.sign(
    { user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
};

const UPLOADS_DIR = path.resolve(__dirname, '../auth-service/uploads');

async function runTestSuite() {
  console.log('========================================================================');
  console.log('   SOTRANS HUB — KIỂM THỬ TỰ ĐỘNG CHÍNH SÁCH STAGING RETENTION 7 NGÀY   ');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, note = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${note ? '(' + note + ')' : ''}`);
      failed++;
    }
  }

  // TC-01: Kiểm tra tệp tạm quá hạn (> 7 ngày) bị xóa, tệp mới (< 7 ngày) được bảo toàn
  console.log('👉 KIỂM THỬ 1: Dọn dẹp tệp tạm theo mốc thời gian 7 ngày');
  const expiredFileName = `test_retention_expired_${Date.now()}.tmp`;
  const freshFileName = `test_retention_fresh_${Date.now()}.tmp`;
  const expiredFilePath = path.join(UPLOADS_DIR, expiredFileName);
  const freshFilePath = path.join(UPLOADS_DIR, freshFileName);

  fs.writeFileSync(expiredFilePath, 'EXPIRED_CONTENT_STAGING_7_DAYS', 'utf8');
  fs.writeFileSync(freshFilePath, 'FRESH_CONTENT_STAGING_TODAY', 'utf8');

  // Đặt mtime của expiredFilePath về 8 ngày trước
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(expiredFilePath, eightDaysAgo, eightDaysAgo);

  const purgeResult = await purgeStagingRecords({ stagingFileDays: 7 });

  const expiredExists = fs.existsSync(expiredFilePath);
  const freshExists = fs.existsSync(freshFilePath);

  assert(!expiredExists, 'TC1.1: Tệp tạm có tuổi thọ > 7 ngày bị xóa tự động');
  assert(freshExists, 'TC1.2: Tệp tạm mới (< 7 ngày) được bảo toàn 100%');

  // Dọn dẹp tệp fresh sau test
  if (fs.existsSync(freshFilePath)) fs.unlinkSync(freshFilePath);

  // TC-02: Tệp gắn liền với hồ sơ đang pending trong staging không bao giờ bị xóa dù > 7 ngày
  console.log('\n👉 KIỂM THỬ 2: Bảo vệ tuyệt đối tệp đang được xử lý trong Staging');
  const activeStagingFile = `test_active_staging_${Date.now()}.tmp`;
  const activeStagingPath = path.join(UPLOADS_DIR, activeStagingFile);
  fs.writeFileSync(activeStagingPath, 'ACTIVE_STAGING_CONTENT', 'utf8');
  fs.utimesSync(activeStagingPath, eightDaysAgo, eightDaysAgo);

  // Thêm bản ghi pending_review vào hr_employee_staging
  const crypto = require('crypto');
  const testBatchId = crypto.randomUUID();
  const insertRes = await db.query(
    `INSERT INTO hr_employee_staging (
      batch_id, full_name, file_name, company_id, staging_status, uploaded_by, uploaded_by_user_id
    ) VALUES ($1, 'TEST RETENTION CANDIDATE', $2, 'STL', 'pending_review', 'admin_stl', 'fd54c14e-2a82-4f1d-af37-dc4cd40461cd')
    RETURNING id`,
    [testBatchId, activeStagingFile]
  );
  const testStagingId = insertRes.rows[0].id;

  await purgeStagingRecords({ stagingFileDays: 7 });

  const activeStagingStillExists = fs.existsSync(activeStagingPath);
  assert(activeStagingStillExists, 'TC2.1: Tệp > 7 ngày nhưng đang gắn với hồ sơ pending_review KHÔNG bị xóa');

  // Dọn dẹp staging test
  await db.query(`DELETE FROM hr_employee_staging WHERE id = $1`, [testStagingId]);
  if (fs.existsSync(activeStagingPath)) fs.unlinkSync(activeStagingPath);

  // TC-03: Kiểm tra API endpoint POST /api/audit-logs/retention/run
  console.log('\n👉 KIỂM THỬ 3: API Quản trị & Phân quyền RBAC trên endpoint Retention');
  
  // 3.1 ADMIN gọi thành công (200 OK)
  const resAdmin = await fetch(`${BASE_URL}/api/audit-logs/retention/run`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokens.admin}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ stagingFileDays: 7 })
  });
  const dataAdmin = await resAdmin.json();
  assert(resAdmin.status === 200 && dataAdmin.success === true, 'TC3.1: ADMIN kích hoạt dọn dẹp theo yêu cầu thành công (HTTP 200)');

  // 3.2 EMPLOYEE gọi bị chặn (403 Forbidden)
  const resEmp = await fetch(`${BASE_URL}/api/audit-logs/retention/run`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokens.employee}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ stagingFileDays: 7 })
  });
  assert(resEmp.status === 403, 'TC3.2: Non-Admin (EMPLOYEE/HR) bị chặn 403 Forbidden khi cố gọi API dọn dẹp');

  // 3.3 Không có token bị chặn (401 Unauthorized)
  const resNoAuth = await fetch(`${BASE_URL}/api/audit-logs/retention/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stagingFileDays: 7 })
  });
  assert(resNoAuth.status === 401, 'TC3.3: Yêu cầu không có Token bị từ chối 401 Unauthorized');

  // TC-04: Kiểm tra Audit Log được ghi nhận vào auth_audit_logs
  console.log('\n👉 KIỂM THỬ 4: Truy vết Audit Log hệ thống');
  const auditRes = await db.query(
    `SELECT action, status, actor_username, metadata 
     FROM auth_audit_logs 
     WHERE action = 'OPS_STAGING_RETENTION_PURGE' 
     ORDER BY created_at DESC LIMIT 1`
  );
  assert(auditRes.rows.length > 0 && auditRes.rows[0].status === 'SUCCESS', 'TC4.1: Thao tác dọn dẹp Staging được lưu vết đầy đủ trong auth_audit_logs');
  if (auditRes.rows.length > 0) {
    const policy = auditRes.rows[0].metadata?.retention_policy;
    assert(policy?.stagingFileDays === 7, 'TC4.2: Metadata lưu đúng chính sách 7 ngày (stagingFileDays: 7)');
  }

  console.log('\n========================================================================');
  console.log(`📊 TỔNG KẾT KIỂM THỬ STAGING RETENTION: ${passed} PASS, ${failed} FAIL`);
  console.log('========================================================================');

  db.pool.end();
  if (failed > 0) process.exit(1);
}

runTestSuite().catch(err => {
  console.error('Lỗi khi chạy test suite:', err);
  db.pool.end();
  process.exit(1);
});
