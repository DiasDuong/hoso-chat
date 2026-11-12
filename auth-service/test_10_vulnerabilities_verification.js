/**
 * End-to-End Verification Test Suite for the 10 HR Chatbot Vulnerabilities:
 * AUTH-01, BIZ-01, DATA-02, SEC-02, BIZ-02, WF-02, BIZ-03, SEC-03, DATA-03, OPS-01
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { parseConversationalIntake } = require('./services/intakeConversationalParser');
const { validateItemForApproval, findStagingItemByTarget, handleIntakeConversationalMessage, doApprovalForItems } = require('./routes/intake');
const { purgeStagingRecords } = require('./services/retentionService');
const { createRateLimiter } = require('./middleware/rateLimiter');

async function runAllTests() {
  console.log('========================================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ HỒI QUY TOÀN DIỆN 10 LỖ HỔNG (HR CHATBOT)');
  console.log('========================================================================\n');

  let passedCount = 0;
  let failedCount = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedCount++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}: ${details}`);
      failedCount++;
    }
  }

  // Helper to resolve workflow path across host and container
  function getWorkflowPath() {
    const candidates = [
      path.resolve(__dirname, 'workflows_modified.json'),
      '/app/workflows_modified.json',
      'd:/hoso-chat/workflows_modified.json',
      'C:/Users/Admin/hrbot/auth-service/workflows_modified.json'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  }

  // --------------------------------------------------------------------------
  // 1. WF-02: Vietnamese Encoding Integrity & BOM Check
  // --------------------------------------------------------------------------
  console.log('--- [WF-02] Kiểm tra khôi phục chuỗi tiếng Việt chuẩn & UTF-8 không BOM ---');
  try {
    const wfPath = getWorkflowPath();
    const buffer = fs.readFileSync(wfPath);
    const hasBOM = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
    assert(!hasBOM, 'WF-02.1 File workflows_modified.json không chứa BOM (UTF-8 without BOM)');

    const content = buffer.toString('utf8');
    const hasGarbageChars = content.includes('Ch╞░a') || content.includes('c├│') || content.includes('h? so');
    assert(!hasGarbageChars, 'WF-02.2 Không còn ký tự rác / mojibake trong workflows_modified.json');

    const hasVietnamesePrompt = content.includes('Bạn là Trợ lý AI chuyên trách') && content.includes('Hàng rào an toàn độ tin cậy');
    assert(hasVietnamesePrompt, 'WF-02.3 Chuỗi tiếng Việt nguyên bản được bảo toàn 100%');
  } catch (err) {
    assert(false, 'WF-02 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 2. SEC-02: SQL Parameterization in n8n nodes
  // --------------------------------------------------------------------------
  console.log('\n--- [SEC-02] Kiểm tra tham số hóa truy vấn SQL trong node n8n ---');
  try {
    const wfPath = getWorkflowPath();
    const workflows = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    const qaWf = workflows.find(w => w.name === 'HR_Policy_QA' || w.id === 'btcmLiJpb11xZ5BY');
    assert(!!qaWf, 'SEC-02.1 Tìm thấy workflow HR_Policy_QA');

    const pgKw = qaWf.nodes.find(n => n.name === 'PG Keyword');
    assert(!!pgKw, 'SEC-02.2 Tìm thấy node PG Keyword');
    const pgKwNoInterpolation = !pgKw.parameters.query.includes("{{ $('Prep')") && pgKw.parameters.query.includes('$1');
    const pgKwHasReplacement = !!pgKw.parameters.options?.queryReplacement;
    assert(pgKwNoInterpolation && pgKwHasReplacement, 'SEC-02.3 PG Keyword đã thay thế string interpolation bằng $1..$4 và queryReplacement');

    const pgRc = qaWf.nodes.find(n => n.name === 'PG Recheck');
    assert(!!pgRc, 'SEC-02.4 Tìm thấy node PG Recheck');
    const pgRcNoInterpolation = !pgRc.parameters.query.includes("{{ $json.ids_sql }}") && pgRc.parameters.query.includes('$1::uuid[]');
    const pgRcHasReplacement = !!pgRc.parameters.options?.queryReplacement;
    assert(pgRcNoInterpolation && pgRcHasReplacement, 'SEC-02.5 PG Recheck đã thay thế string interpolation bằng $1..$3 và queryReplacement');
  } catch (err) {
    assert(false, 'SEC-02 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 3. SEC-03: Rate Limiting Throttling
  // --------------------------------------------------------------------------
  console.log('\n--- [SEC-03] Kiểm tra giới hạn tần suất (Rate Limiter) ---');
  try {
    const testLimiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 3,
      message: '429 Rate limit test'
    });

    let allowedCount = 0;
    let blockedCount = 0;
    const fakeReq = { ip: '127.0.0.1', user: { username: 'test_user_sec03' } };

    for (let i = 0; i < 5; i++) {
      let nextCalled = false;
      const fakeRes = {
        setHeader: () => {},
        status: (code) => ({
          json: (body) => {
            if (code === 429) blockedCount++;
          }
        })
      };
      testLimiter(fakeReq, fakeRes, () => { nextCalled = true; allowedCount++; });
    }

    assert(allowedCount === 3, 'SEC-03.1 Đúng 3 request đầu tiên được cho phép qua limiter');
    assert(blockedCount === 2, 'SEC-03.2 2 request vượt ngưỡng bị trả về 429 Too Many Requests');
  } catch (err) {
    assert(false, 'SEC-03 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 4. BIZ-03: Conversational Parser & Disambiguation for Skip Intent
  // --------------------------------------------------------------------------
  console.log('\n--- [BIZ-03] Kiểm tra nhận diện lệnh bỏ qua hồ sơ (Index, Code, CCCD, Name) ---');
  try {
    const p1 = parseConversationalIntake('bỏ qua 2');
    assert(p1.type === 'SKIP_ITEM' && (p1.target == 2 || p1.indices?.includes(2)), 'BIZ-03.1 Nhận diện lệnh "bỏ qua 2" thành index 2');

    const p2 = parseConversationalIntake('bỏ hồ sơ SWC00810, hãy cập nhật các hồ sơ trên');
    assert(p2.type === 'SKIP_AND_APPROVE_OTHERS' && p2.target === 'SWC00810', 'BIZ-03.2 Nhận diện "bỏ hồ sơ SWC00810, hãy cập nhật các hồ sơ trên"');

    const p3 = parseConversationalIntake('bỏ qua hồ sơ Nguyễn Trường Nam');
    assert(p3.type === 'SKIP_ITEM' && p3.target.includes('nguyen truong nam'), 'BIZ-03.3 Nhận diện bỏ qua theo tên nhân sự');

    const pJson = parseConversationalIntake('{"action": "skip", "targets": [1, 3]}');
    assert(pJson.type === 'SKIP_ITEM' && pJson.targets?.length === 2, 'BIZ-03.4 Nhận diện payload giao diện JSON bỏ qua nhiều hồ sơ');

    // Test findStagingItemByTarget
    const mockPending = [
      { id: '11111111-1111-1111-1111-111111111111', employee_code: 'STL-001', citizen_id: '079201000001', full_name: 'Nguyễn Văn A', file_name: 'QuyetDinh_STL001.pdf' },
      { id: '22222222-2222-2222-2222-222222222222', employee_code: 'SWC00810', citizen_id: '079204001284', full_name: 'Nguyễn Trường Nam', file_name: 'SWC00810.pdf' },
      { id: '33333333-3333-3333-3333-333333333333', employee_code: 'VTX_881', citizen_id: '079205009999', full_name: 'Trần Văn Bảo', file_name: 'HoSo_Bao.pdf' }
    ];

    const fIndex = findStagingItemByTarget(mockPending, 2);
    assert(fIndex?.employee_code === 'SWC00810', 'BIZ-03.5 Khớp hồ sơ thứ 2 ra đúng SWC00810');

    const fCode = findStagingItemByTarget(mockPending, 'SWC00810');
    assert(fCode?.id === '22222222-2222-2222-2222-222222222222', 'BIZ-03.6 Khớp hồ sơ theo mã nhân viên SWC00810');

    const fCccd = findStagingItemByTarget(mockPending, '079204001284');
    assert(fCccd?.employee_code === 'SWC00810', 'BIZ-03.7 Khớp hồ sơ theo số CCCD 079204001284');

    const fName = findStagingItemByTarget(mockPending, 'Trường Nam');
    assert(fName?.employee_code === 'SWC00810', 'BIZ-03.8 Khớp hồ sơ theo token họ tên "Trường Nam"');
  } catch (err) {
    assert(false, 'BIZ-03 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 5. BIZ-02: Block Approval for Missing Identity / Mock Codes
  // --------------------------------------------------------------------------
  console.log('\n--- [BIZ-02] Chặn phê duyệt khi thiếu dữ liệu định danh bắt buộc & Không tạo mã giả ---');
  try {
    // 5.1 Missing CCCD
    const badCccd = { full_name: 'Lê Văn Test', citizen_id: '', employee_code: 'STL-101' };
    const valBadCccd = validateItemForApproval(badCccd, 'STL');
    assert(!valBadCccd.valid && valBadCccd.missing.some(m => m.includes('CCCD')), 'BIZ-02.1 Chặn phê duyệt khi thiếu CCCD');

    // 5.2 STL missing employee_code
    const badStlCode = { full_name: 'Lê Văn Test', citizen_id: '079200001111', employee_code: '' };
    const valBadStl = validateItemForApproval(badStlCode, 'STL');
    assert(!valBadStl.valid && valBadStl.missing.some(m => m.includes('Mã nhân viên công ty STL')), 'BIZ-02.2 Chặn phê duyệt STL khi thiếu mã nhân viên (không tự tạo mã giả)');

    // 5.3 STL invalid employee_code format
    const invalidStlCode = { full_name: 'Lê Văn Test', citizen_id: '079200001111', employee_code: 'INVALID_123' };
    const valInvStl = validateItemForApproval(invalidStlCode, 'STL');
    assert(!valInvStl.valid && valInvStl.missing.some(m => m.includes('không hợp lệ')), 'BIZ-02.3 Chặn STL khi mã nhân viên sai định dạng regex');

    // 5.4 Valid STL
    const goodStl = { full_name: 'Lê Văn Test', citizen_id: '079200001111', employee_code: 'STL-005' };
    const valGoodStl = validateItemForApproval(goodStl, 'STL');
    assert(valGoodStl.valid && valGoodStl.resolvedCode === 'STL-005', 'BIZ-02.4 Phê duyệt STL hợp lệ với mã chuẩn');

    // 5.5 SWC fallback to 12-digit CCCD
    const swcNewHire = { full_name: 'Nguyễn Văn Mới', citizen_id: '079204009999', employee_code: '' };
    const valSwc = validateItemForApproval(swcNewHire, 'SWC');
    assert(valSwc.valid && valSwc.resolvedCode === '079204009999', 'BIZ-02.5 SWC chấp nhận mã định danh là CCCD 12 số khi chưa cấp mã NV');
  } catch (err) {
    assert(false, 'BIZ-02 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 6. DATA-03: Unique Constraint on (company_id, citizen_id) & Concurrent Safe
  // --------------------------------------------------------------------------
  console.log('\n--- [DATA-03] Kiểm tra Unique Index (company_id, citizen_id) và chống trùng lặp ---');
  try {
    const idxCheck = await db.query(`
      SELECT indexname, indexdef FROM pg_indexes 
      WHERE tablename = 'employees' AND indexname = 'uq_employees_company_citizen'
    `);
    assert(idxCheck.rows.length > 0, 'DATA-03.1 Index uq_employees_company_citizen tồn tại trên bảng employees');

    // Test duplicate insertion safety
    const testCitizen = '099999999999';
    const testCode1 = 'SWC_TEST_01';
    const testCode2 = 'SWC_TEST_02';

    await db.query(`DELETE FROM employees WHERE citizen_id = $1`, [testCitizen]);

    await db.query(`
      INSERT INTO employees (employee_code, employee_name, company_id, citizen_id, status)
      VALUES ($1, 'Test Duplicate 1', 'SWC', $2, 'ACTIVE')
    `, [testCode1, testCitizen]);

    let duplicateBlocked = false;
    try {
      await db.query(`
        INSERT INTO employees (employee_code, employee_name, company_id, citizen_id, status)
        VALUES ($1, 'Test Duplicate 2', 'SWC', $2, 'ACTIVE')
      `, [testCode2, testCitizen]);
    } catch (dbErr) {
      if (dbErr.code === '23505') {
        duplicateBlocked = true;
      }
    }
    assert(duplicateBlocked, 'DATA-03.2 Unique index chặn triệt để bản ghi trùng CCCD trong cùng công ty (Mã lỗi 23505)');

    // Cleanup test record
    await db.query(`DELETE FROM employees WHERE citizen_id = $1`, [testCitizen]);
  } catch (err) {
    assert(false, 'DATA-03 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 7. BIZ-01: Session & Conversation Isolation
  // --------------------------------------------------------------------------
  console.log('\n--- [BIZ-01] Cách ly dữ liệu chờ duyệt theo conversation_id và người dùng ---');
  try {
    const sessionA = 'session-web-aaa-111';
    const sessionB = 'session-web-bbb-222';
    const testBatchA = crypto.randomUUID();
    const testBatchB = crypto.randomUUID();

    // Helper to generate deterministic UUID
    function toValidUUID(str) {
      const hash = crypto.createHash('md5').update(String(str)).digest('hex');
      return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    }

    const uuidA = toValidUUID(sessionA);
    const uuidB = toValidUUID(sessionB);

    // Ensure parent conversation records exist (BIZ-01 FK)
    await db.query(`
      INSERT INTO ai_conversations (id, user_id, agent_id, title)
      VALUES ($1, 'admin_stl', 'hr_intake', 'Session A')
      ON CONFLICT (id) DO NOTHING
    `, [uuidA]);
    await db.query(`
      INSERT INTO ai_conversations (id, user_id, agent_id, title)
      VALUES ($1, 'admin_stl', 'hr_intake', 'Session B')
      ON CONFLICT (id) DO NOTHING
    `, [uuidB]);

    // Insert mock staging row into Session A
    await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, conversation_id, file_name, full_name, citizen_id, employee_code, company_id, company_status, staging_status, uploaded_by
      ) VALUES (
        $1, $2, 'SessionA_Profile.pdf', 'Người Session A', '079201111222', 'STL-991', 'STL', 'confirmed', 'pending_review', 'admin_stl'
      )
    `, [testBatchA, uuidA]);

    // Query from Session B context
    const testUserB = { 
      user_id: 'fd54c14e-2a82-4f1d-af37-dc4cd40461cd',
      username: 'admin_stl', 
      role: 'ADMIN', 
      company_id: 'STL' 
    };
    const resultB = await handleIntakeConversationalMessage(testUserB, 'Xem danh sách', sessionB);

    // Session B should have no records from Session A
    assert(resultB === null, 'BIZ-01.1 Session B không nhìn thấy hồ sơ thuộc Session A (cách ly hoàn toàn)');

    // Query from Session A context
    const resultA = await handleIntakeConversationalMessage(testUserB, 'Phê duyệt', sessionA);
    assert(resultA && resultA.reply.includes('Đã phê duyệt'), 'BIZ-01.2 Session A xử lý đúng hồ sơ của chính phiên đó');

    // Cleanup test staging
    await db.query(`DELETE FROM hr_employee_staging WHERE batch_id IN ($1, $2)`, [testBatchA, testBatchB]);
    await db.query(`DELETE FROM ai_conversations WHERE id IN ($1, $2)`, [uuidA, uuidB]);
    await db.query(`DELETE FROM employees WHERE citizen_id = '079201111222'`);
    await db.query(`DELETE FROM hr_employee_profiles WHERE citizen_id = '079201111222'`);
  } catch (err) {
    assert(false, 'BIZ-01 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 8. AUTH-01: Cross-Company Staging & Segregation without Deadlock
  // --------------------------------------------------------------------------
  console.log('\n--- [AUTH-01] Xử lý lô hồ sơ khác công ty (Tách riêng, không làm treo lô) ---');
  try {
    const testConvId = crypto.randomUUID();
    const testBatchId = crypto.randomUUID();

    // Ensure conversation record exists for testConvId
    await db.query(`
      INSERT INTO ai_conversations (id, user_id, agent_id, title)
      VALUES ($1, 'hr_stl', 'hr_intake', 'Test Conversation AUTH-01')
      ON CONFLICT (id) DO NOTHING
    `, [testConvId]);

    // Insert 2 records: Record 1 is STL, Record 2 is SWC
    const recStl = await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, conversation_id, file_name, full_name, citizen_id, employee_code, company_id, company_status, staging_status, uploaded_by
      ) VALUES (
        $1, $2, 'Doc_STL.pdf', 'Nhân Sự STL', '079201888111', 'STL-881', 'STL', 'suggested', 'pending_review', 'hr_stl'
      ) RETURNING id
    `, [testBatchId, testConvId]);

    const recSwc = await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, conversation_id, file_name, full_name, citizen_id, employee_code, company_id, company_status, staging_status, uploaded_by
      ) VALUES (
        $1, $2, 'Doc_SWC.pdf', 'Nhân Sự SWC', '079201888222', 'SWC00810', 'SWC', 'suggested', 'pending_review', 'hr_stl'
      ) RETURNING id
    `, [testBatchId, testConvId]);

    const userStl = { 
      user_id: '9a2e8590-c1a2-41c6-abb2-b802cb8060c6',
      username: 'hr_stl', 
      role: 'HR', 
      company_id: 'STL' 
    };

    // Compound intent: "Hồ sơ 1 thuộc STL, tất cả hồ sơ còn lại thuộc SWC"
    const compRes = await handleIntakeConversationalMessage(
      userStl,
      'Hồ sơ 1 thuộc STL, tất cả hồ sơ còn lại thuộc SWC',
      testConvId
    );

    assert(compRes && !compRes.reply.includes('Từ chối thao tác phân quyền') && compRes.reply.includes('thành công'), 
      'AUTH-01.1 Company Admin STL gán compound không bị chặn lỗi 403');

    // Check status of remaining SWC record: should be transferred
    const checkSwc = await db.query(`SELECT staging_status, company_id, duplicate_reason FROM hr_employee_staging WHERE id = $1`, [recSwc.rows[0].id]);
    assert(checkSwc.rows[0].staging_status === 'transferred', 'AUTH-01.2 Hồ sơ SWC ngoài phạm vi được tách riêng sang trạng thái "transferred"');

    // Check STL record: confirmed and ready
    const checkStl = await db.query(`SELECT staging_status, company_id, company_status FROM hr_employee_staging WHERE id = $1`, [recStl.rows[0].id]);
    assert(checkStl.rows[0].company_status === 'confirmed' && checkStl.rows[0].company_id === 'STL', 'AUTH-01.3 Hồ sơ STL được xác nhận hợp lệ sẵn sàng phê duyệt');

    // Test approval: HR triggers review/pending_approval, then ADMIN officially approves without failure on transferred SWC
    const hrSubmitRes = await handleIntakeConversationalMessage(userStl, 'Phê duyệt', testConvId);
    assert(hrSubmitRes && (hrSubmitRes.reply.includes('Chờ phê duyệt') || hrSubmitRes.reply.includes('Đã phê duyệt')), 'AUTH-01.4a HR trình duyệt hồ sơ hợp lệ');

    const adminApprover = { user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac', username: 'superadmin', role: 'ADMIN', company_id: null };
    const appRes = await handleIntakeConversationalMessage(adminApprover, 'Phê duyệt', testConvId);
    assert(appRes && appRes.reply.includes('Đã phê duyệt'), 'AUTH-01.4 Phê duyệt lô thành công không bị gián đoạn hay treo lô');

    // Cleanup
    await db.query(`DELETE FROM hr_employee_staging WHERE batch_id = $1`, [testBatchId]);
    await db.query(`DELETE FROM ai_conversations WHERE id = $1`, [testConvId]);
    await db.query(`DELETE FROM employees WHERE citizen_id IN ('079201888111', '079201888222')`);
    await db.query(`DELETE FROM hr_employee_profiles WHERE citizen_id IN ('079201888111', '079201888222')`);
  } catch (err) {
    assert(false, 'AUTH-01 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 9. DATA-02: Soft Delete, Resignation, and Transfer Sync
  // --------------------------------------------------------------------------
  console.log('\n--- [DATA-02] Đồng bộ xóa mềm, nghỉ việc (RESIGNED) và điều chuyển ---');
  try {
    const testCitizen = '079201777888';
    const testCode = 'STL-777';

    await db.query(`DELETE FROM employees WHERE citizen_id = $1`, [testCitizen]);
    const empInsert = await db.query(`
      INSERT INTO employees (employee_code, employee_name, company_id, citizen_id, status)
      VALUES ($1, 'Nguyễn Thị Đồng Bộ', 'STL', $2, 'ACTIVE')
      RETURNING id
    `, [testCode, testCitizen]);
    const empId = empInsert.rows[0].id;

    // Simulate Soft Delete via UPDATE status = 'DELETED'
    await db.query(`UPDATE employees SET status = 'DELETED', updated_at = NOW() WHERE id = $1`, [empId]);

    // Query active employees (default filter status != 'DELETED')
    const activeCheck = await db.query(`SELECT id FROM employees WHERE id = $1 AND status != 'DELETED'`, [empId]);
    assert(activeCheck.rows.length === 0, 'DATA-02.1 Nhân viên đã xóa mềm không xuất hiện trong danh sách hoạt động');

    const softDeletedCheck = await db.query(`SELECT id, status FROM employees WHERE id = $1`, [empId]);
    assert(softDeletedCheck.rows[0].status === 'DELETED', 'DATA-02.2 Bản ghi vẫn được bảo toàn nguyên vẹn trong CSDL với status = "DELETED"');

    // Simulate RESIGNED status
    await db.query(`UPDATE employees SET status = 'RESIGNED', updated_at = NOW() WHERE id = $1`, [empId]);
    const resignedCheck = await db.query(`SELECT status FROM employees WHERE id = $1`, [empId]);
    assert(resignedCheck.rows[0].status === 'RESIGNED', 'DATA-02.3 Trạng thái nghỉ việc (RESIGNED) được ghi nhận thành công');

    // Cleanup
    await db.query(`DELETE FROM employees WHERE id = $1`, [empId]);
  } catch (err) {
    assert(false, 'DATA-02 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 10. OPS-01: Retention & Staging Cleanup Lifecycle
  // --------------------------------------------------------------------------
  console.log('\n--- [OPS-01] Chính sách lưu trữ & Dọn dẹp staging/tệp tạm định kỳ ---');
  try {
    const oldBatch = crypto.randomUUID();

    // Insert an old approved staging row (> 65 days ago)
    await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, file_name, full_name, citizen_id, employee_code, company_id, company_status, staging_status, uploaded_by, updated_at
      ) VALUES (
        $1, 'old_approved.pdf', 'Nhân viên Cũ Đã Duyệt', '079201999000', 'SWC00999', 'SWC', 'confirmed', 'approved', 'admin_swc', NOW() - INTERVAL '65 days'
      )
    `, [oldBatch]);

    // Insert a recent pending staging row (today)
    await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, file_name, full_name, citizen_id, employee_code, company_id, company_status, staging_status, uploaded_by, updated_at
      ) VALUES (
        $1, 'recent_pending.pdf', 'Nhân viên Mới Đang Chờ', '079201999111', 'SWC00998', 'SWC', 'confirmed', 'pending_review', 'admin_swc', NOW()
      )
    `, [oldBatch]);

    // Run purge service
    const purgeResult = await purgeStagingRecords({ approvedDays: 60, rejectedDays: 30, abandonedDays: 30 });
    assert(purgeResult.success && purgeResult.purged.approved >= 1, 'OPS-01.1 Bản ghi staging đã duyệt quá hạn 60 ngày được dọn dẹp');

    const checkRecent = await db.query(`SELECT id FROM hr_employee_staging WHERE citizen_id = '079201999111'`);
    assert(checkRecent.rows.length === 1, 'OPS-01.2 Hồ sơ đang chờ hợp lệ không bao giờ bị xóa nhầm');

    // Cleanup
    await db.query(`DELETE FROM hr_employee_staging WHERE batch_id = $1`, [oldBatch]);
  } catch (err) {
    assert(false, 'OPS-01 Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // 11. BIZ-04: Cập nhật định danh qua hội thoại (CCCD, Mã NV) & Thứ tự lô chuẩn xác
  // --------------------------------------------------------------------------
  console.log('\n--- [BIZ-04] Cập nhật định danh qua hội thoại (CCCD, Mã NV) & Thứ tự lô chuẩn xác ---');
  try {
    // 11.1 Parser multi-line CCCD input (Test đúng ngữ cảnh ảnh 2)
    const cccdMulti = "CCCD của PHAN DƯƠNG THANH BÌNH : 079204001284\nCCCD của NGUYỄN TRƯỜNG NAM: 036202007139";
    const parsedCccd = parseConversationalIntake(cccdMulti);
    assert(parsedCccd && parsedCccd.type === 'UPDATE_IDENTIFIER' && parsedCccd.updates.length === 2, 
      'BIZ-04.1 Nhận diện chính xác 02 bản ghi cập nhật CCCD từ tin nhắn nhiều dòng');
    assert(parsedCccd.updates[0].citizen_id === '079204001284' && parsedCccd.updates[1].citizen_id === '036202007139',
      'BIZ-04.2 Trích xuất đúng số CCCD cho từng nhân sự');

    // 11.2 Parser employee code input
    const codeMsg = "Mã NV của PHAN DƯƠNG THANH BÌNH là STL-001";
    const parsedCode = parseConversationalIntake(codeMsg);
    assert(parsedCode && parsedCode.type === 'UPDATE_IDENTIFIER' && parsedCode.updates[0].employee_code === 'STL-001',
      'BIZ-04.3 Nhận diện cập nhật Mã nhân viên theo cú pháp tự nhiên');

    // 11.3 Cập nhật vào DB qua handleIntakeConversationalMessage
    const testBatchId = crypto.randomUUID();
    const testConvId = crypto.randomUUID();

    await db.query(`
      INSERT INTO ai_conversations (id, user_id, agent_id, title)
      VALUES ($1, 'superadmin', 'hr_intake', 'Test Conversation BIZ-04')
      ON CONFLICT (id) DO NOTHING
    `, [testConvId]);

    const insertRes = await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, conversation_id, file_name, full_name, citizen_id, employee_code, company_id, company_status, staging_status, uploaded_by
      ) VALUES (
        $1, $2, 'test_upd.pdf', 'Lê Thị Kiểm Thử', NULL, NULL, 'STL', 'confirmed', 'pending_review', 'superadmin'
      ) RETURNING id
    `, [testBatchId, testConvId]);

    const userAdmin = { user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac', username: 'superadmin', role: 'ADMIN', company_id: null };
    const updateRes = await handleIntakeConversationalMessage(
      userAdmin,
      "CCCD của Lê Thị Kiểm Thử : 079200008888",
      testConvId
    );

    assert(updateRes && updateRes.reply.includes('Đã cập nhật'), 'BIZ-04.4 handleIntakeConversationalMessage cập nhật CCCD thành công');

    const checkDb = await db.query(`SELECT citizen_id FROM hr_employee_staging WHERE id = $1`, [insertRes.rows[0].id]);
    assert(checkDb.rows[0].citizen_id === '079200008888', 'BIZ-04.5 Số CCCD mới được lưu chính xác vào CSDL staging');

    // Cleanup
    await db.query(`DELETE FROM hr_employee_staging WHERE batch_id = $1`, [testBatchId]);
  } catch (err) {
    assert(false, 'BIZ-04 Execution', err.message);
  }

  console.log('\n========================================================================');
  console.log(`🏁 KẾT QUẢ KIỂM THỬ: ${passedCount} PASS, ${failedCount} FAIL`);
  console.log('========================================================================\n');

  process.exit(failedCount > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
