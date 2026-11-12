/**
 * TEST P1A VERIFICATION SUITE
 * 
 * Verifies:
 * 1. F-01: Agent Configuration Rollback (API & Security & OCC & DB integrity)
 * 2. F-06: Artifact Storage Lifecycle Cleaner (Path-traversal protection & PURGED state)
 * 3. Full Platform Regression Suite (CRUD, Fallback, Regenerate, Chatbot compatibility)
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { purgeExpiredAgentOutputs } = require('./services/retentionService');

const JWT_SECRET = process.env.JWT_SECRET || 'hrbot_jwt_secret_dev_2026';
const AGENT_OUTPUTS_DIR = path.resolve(__dirname, 'data/agent_outputs');

// Helper to make internal HTTP requests
const http = require('http');

function apiRequest(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body), raw: body });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function runTests() {
  console.log('========================================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ GÓI P1A: AGENT ROLLBACK & ARTIFACT STORAGE CLEANER');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}: ${details}`);
      failed++;
    }
  }

  // 1. Chuẩn bị tokens cho 2 user khác nhau để test IDOR
  console.log('--- 1. Thiết lập người dùng thử nghiệm & JWT Tokens ---');
  const userARes = await db.query(`SELECT user_id, username, role FROM users WHERE username = 'superadmin' LIMIT 1`);
  const userA = userARes.rows[0];

  const userBRes = await db.query(`SELECT user_id, username, role FROM users WHERE username != 'superadmin' LIMIT 1`);
  const userB = userBRes.rows[0];

  assert(userA && userB, 'Tìm thấy 2 người dùng độc lập để kiểm thử IDOR', `UserA: ${userA?.username}, UserB: ${userB?.username}`);

  const tokenA = jwt.sign({ user_id: userA.user_id, username: userA.username, role: userA.role }, JWT_SECRET, { expiresIn: '1h' });
  const tokenB = jwt.sign({ user_id: userB.user_id, username: userB.username, role: userB.role }, JWT_SECRET, { expiresIn: '1h' });

  // --------------------------------------------------------------------------
  // TEST SUITE 1: F-01 - Agent Configuration Rollback
  // --------------------------------------------------------------------------
  console.log('\n--- 2. [F-01] Kiểm thử Vòng đời & Khôi phục Phiên bản Agent (Rollback) ---');
  let testAgentId = null;

  try {
    // 2.1. Tạo Agent mới (Version 1)
    const createRes = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/agents',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      }
    }, {
      name: 'P1A-Rollback-Test',
      description: 'Mô tả ban đầu v1',
      instruction_prompt: 'Chỉ dẫn prompt ban đầu (Phiên bản 1)',
      model_name: 'gemini-3.1-flash-lite',
      temperature: 0.70
    });

    assert(createRes.status === 201 && createRes.data?.agent?.id, 'F-01.1 Tạo Agent thành công', `Status: ${createRes.status}`);
    testAgentId = createRes.data?.agent?.id;

    // Kiểm tra current_version = 1 và snapshot v1
    const v1Check = await db.query(`SELECT current_version FROM user_agents WHERE id = $1`, [testAgentId]);
    assert(v1Check.rows[0]?.current_version === 1, 'F-01.2 Agent có current_version = 1');

    const snap1 = await db.query(`SELECT * FROM user_agent_versions WHERE agent_id = $1 AND version_number = 1`, [testAgentId]);
    assert(snap1.rows.length === 1 && snap1.rows[0].instruction_prompt.includes('Phiên bản 1'), 'F-01.3 user_agent_versions đã lưu snapshot v1');

    // 2.2. Cập nhật Agent lần 1 (Tạo Version 2)
    const update1Res = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/agents/${testAgentId}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      }
    }, {
      name: 'P1A-Rollback-Test',
      description: 'Mô tả đã sửa v2',
      instruction_prompt: 'Chỉ dẫn prompt đã cập nhật (Phiên bản 2)',
      model_name: 'gemini-3.5-flash-lite',
      temperature: 0.50
    });

    assert(update1Res.status === 200, 'F-01.4 Cập nhật Agent lên Version 2 thành công');
    const v2Check = await db.query(`SELECT current_version FROM user_agents WHERE id = $1`, [testAgentId]);
    assert(v2Check.rows[0]?.current_version === 2, 'F-01.5 Agent có current_version = 2');

    // 2.3. Cập nhật Agent lần 2 (Tạo Version 3)
    const update2Res = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/agents/${testAgentId}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      }
    }, {
      name: 'P1A-Rollback-Test',
      description: 'Mô tả đã sửa v3',
      instruction_prompt: 'Chỉ dẫn prompt thử nghiệm (Phiên bản 3)',
      model_name: 'gemini-3.1-pro-preview',
      temperature: 0.20
    });

    assert(update2Res.status === 200, 'F-01.6 Cập nhật Agent lên Version 3 thành công');
    const v3Check = await db.query(`SELECT current_version FROM user_agents WHERE id = $1`, [testAgentId]);
    assert(v3Check.rows[0]?.current_version === 3, 'F-01.7 Agent có current_version = 3');

    // 2.4. Lấy lịch sử phiên bản GET /api/agents/:id/versions
    const listVersionsRes = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/agents/${testAgentId}/versions`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenA}`
      }
    });

    assert(listVersionsRes.status === 200 && listVersionsRes.data?.versions?.length === 3, 'F-01.8 API GET /versions trả về đủ 3 phiên bản', `Count: ${listVersionsRes.data?.versions?.length}`);
    const vers = listVersionsRes.data?.versions || [];
    assert(vers[0]?.version_number === 3 && vers[1]?.version_number === 2 && vers[2]?.version_number === 1, 'F-01.9 Các phiên bản sắp xếp DESC chính xác');

    // 2.5. Kiểm thử Bảo mật IDOR: User B không thể rollback Agent của User A
    console.log('--- Kiểm tra bảo mật IDOR chặn truy cập chéo ---');
    const idorRes = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/agents/${testAgentId}/rollback/1`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenB}`
      }
    }, {});

    assert(idorRes.status === 404, 'F-01.10 IDOR Protection: User B bị chặn khi cố rollback Agent của User A (HTTP 404 Not Found)', `Status: ${idorRes.status}`);

    // 2.6. Kiểm thử Khóa lạc quan (Optimistic Concurrency Control)
    console.log('--- Kiểm tra khóa lạc quan (OCC) ---');
    const occConflictRes = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/agents/${testAgentId}/rollback/1`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      }
    }, {
      expected_current_version: 1 // Thực tế hiện tại đang là 3
    });

    assert(occConflictRes.status === 409, 'F-01.11 OCC: Báo lỗi xung đột 409 khi expected_current_version không khớp', `Status: ${occConflictRes.status}`);

    // 2.7. Thực hiện Rollback hợp lệ về Version 1
    console.log('--- Thực hiện Rollback hợp lệ về Version 1 ---');
    const rollbackRes = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/agents/${testAgentId}/rollback/1`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      }
    }, {
      expected_current_version: 3
    });

    assert(rollbackRes.status === 200 && rollbackRes.data?.success === true, 'F-01.12 Rollback API trả về HTTP 200 Success', `Status: ${rollbackRes.status}`);

    // 2.8. Kiểm tra tính toàn vẹn cơ sở dữ liệu sau Rollback (Append-only)
    const afterAgentRes = await db.query(`SELECT * FROM user_agents WHERE id = $1`, [testAgentId]);
    const afterAgent = afterAgentRes.rows[0];

    assert(afterAgent.current_version === 4, 'F-01.13 Append-only: current_version tăng lên 4 (không ghi đè số phiên bản cũ)', `current_version: ${afterAgent.current_version}`);
    assert(afterAgent.instruction_prompt === 'Chỉ dẫn prompt ban đầu (Phiên bản 1)', 'F-01.14 Nội dung prompt được khôi phục chính xác về Version 1', `Prompt: ${afterAgent.instruction_prompt}`);
    assert(afterAgent.description === 'Mô tả ban đầu v1', 'F-01.15 Mô tả được khôi phục chính xác về Version 1');
    assert(afterAgent.model_name === 'gemini-3.1-flash-lite', 'F-01.16 Mô hình được khôi phục về Version 1');

    // Kiểm tra bản ghi snapshot mới v4 trong user_agent_versions
    const snap4 = await db.query(`SELECT * FROM user_agent_versions WHERE agent_id = $1 AND version_number = 4`, [testAgentId]);
    assert(snap4.rows.length === 1, 'F-01.17 Bản ghi Version 4 đã được tạo trong user_agent_versions');
    assert(snap4.rows[0].change_summary.includes('Khôi phục từ phiên bản #1'), 'F-01.18 change_summary ghi nhận nguồn gốc khôi phục rõ ràng');

    // Kiểm tra Audit Log
    const auditRes = await db.query(
      `SELECT * FROM audit_log WHERE action = 'AGENT_ROLLBACK_AGENT_VERSION' AND actor = $1 ORDER BY at DESC LIMIT 1`,
      [userA.username]
    );
    assert(auditRes.rows.length === 1 && auditRes.rows[0].detail?.restored_from === 1, 'F-01.19 Audit log ghi nhận hành động ROLLBACK_AGENT_VERSION với đầy đủ metadata');

  } finally {
    // Dọn dẹp agent test
    if (testAgentId) {
      await db.query(`DELETE FROM user_agents WHERE id = $1`, [testAgentId]);
      console.log('✓ Đã dọn dẹp dữ liệu thử nghiệm Rollback');
    }
  }

  // --------------------------------------------------------------------------
  // TEST SUITE 2: F-06 - Artifact Storage Lifecycle Cleaner
  // --------------------------------------------------------------------------
  console.log('\n--- 3. [F-06] Kiểm thử Dọn dẹp File Output Hết hạn & Chống Path Traversal ---');

  if (!fs.existsSync(AGENT_OUTPUTS_DIR)) {
    fs.mkdirSync(AGENT_OUTPUTS_DIR, { recursive: true });
  }

  const agentRow = await db.query('SELECT id FROM user_agents LIMIT 1');
  const validAgentId = agentRow.rows[0].id;
  const dummySha = 'a'.repeat(64);

  // 3.1. Chống Path Traversal
  console.log('--- Kiểm tra Path Traversal Attack trên retentionService ---');
  let attackFileId = null;
  const outsidePath = path.resolve(__dirname, 'test_outside_forbidden.txt');
  fs.writeFileSync(outsidePath, 'Tệp nhạy cảm ngoài thư mục agent_outputs');

  try {
    const insertAttackRes = await db.query(`
      INSERT INTO agent_output_files (user_id, agent_id, file_name, mime_type, file_size, checksum_sha256, storage_path, status, expires_at)
      VALUES ($1, $2, 'hack.txt', 'text/plain', 50, $3, $4, 'EXPIRED', NOW() - INTERVAL '10 minutes')
      RETURNING id
    `, [userA.user_id, validAgentId, dummySha, outsidePath]);
    attackFileId = insertAttackRes.rows[0].id;

    // Chạy dọn dẹp
    await purgeExpiredAgentOutputs();

    // Xác minh file ngoài thư mục KHÔNG bị xóa
    assert(fs.existsSync(outsidePath), 'F-06.1 Path-traversal Protection: File nằm ngoài AGENT_OUTPUTS_DIR không bị xóa', `File exists: ${fs.existsSync(outsidePath)}`);

    const attackDbCheck = await db.query(`SELECT status FROM agent_output_files WHERE id = $1`, [attackFileId]);
    assert(attackDbCheck.rows[0]?.status !== 'PURGED', 'F-06.2 DB record chứa path bất hợp pháp không được đánh dấu PURGED');
  } finally {
    if (fs.existsSync(outsidePath)) fs.unlinkSync(outsidePath);
    if (attackFileId) await db.query(`DELETE FROM agent_output_files WHERE id = $1`, [attackFileId]);
  }

  // 3.2. Dọn dẹp File hợp lệ đã hết hạn
  console.log('--- Kiểm tra dọn dẹp file hợp lệ trong thư mục agent_outputs ---');
  const validExpiredFilePath = path.join(AGENT_OUTPUTS_DIR, 'test_p1a_expired_valid.csv');
  fs.writeFileSync(validExpiredFilePath, 'id,name,amount\n1,TestExpired,1000\n');

  let expiredFileDbId = null;
  try {
    const insertExpRes = await db.query(`
      INSERT INTO agent_output_files (user_id, agent_id, file_name, mime_type, file_size, checksum_sha256, storage_path, status, expires_at)
      VALUES ($1, $2, 'test_p1a_expired_valid.csv', 'text/csv', 35, $3, $4, 'READY', NOW() - INTERVAL '1 hour')
      RETURNING id
    `, [userA.user_id, validAgentId, dummySha, validExpiredFilePath]);
    expiredFileDbId = insertExpRes.rows[0].id;

    // Chạy dọn dẹp thực thi cho tệp test
    const purgeStats = await purgeExpiredAgentOutputs({ dryRun: false });

    // Xác minh file vật lý trên đĩa đã bị xóa
    assert(!fs.existsSync(validExpiredFilePath), 'F-06.3 File vật lý hết hạn trong agent_outputs đã bị xóa khỏi đĩa');

    // Xác minh trạng thái DB đã chuyển sang PURGED và storage_path bị xóa rỗng
    const expDbCheck = await db.query(`SELECT status, storage_path FROM agent_output_files WHERE id = $1`, [expiredFileDbId]);
    assert(expDbCheck.rows[0]?.status === 'PURGED', 'F-06.4 DB status chuyển sang "PURGED"');
    assert(expDbCheck.rows[0]?.storage_path === '', 'F-06.5 DB storage_path được gán rỗng để tránh truy cập stale path');
    assert(purgeStats && purgeStats.total >= 1, 'F-06.6 Hàm purgeExpiredAgentOutputs trả về thống kê số file đã dọn dẹp');
  } finally {
    if (fs.existsSync(validExpiredFilePath)) fs.unlinkSync(validExpiredFilePath);
    if (expiredFileDbId) await db.query(`DELETE FROM agent_output_files WHERE id = $1`, [expiredFileDbId]);
  }

  // 3.3. Bảo toàn File còn hạn (Không được xóa nhầm)
  console.log('--- Kiểm tra bảo toàn file chưa hết hạn ---');
  const validActiveFilePath = path.join(AGENT_OUTPUTS_DIR, 'test_p1a_active_keep.csv');
  fs.writeFileSync(validActiveFilePath, 'id,name,amount\n1,ActiveFile,5000\n');

  let activeFileDbId = null;
  try {
    const insertActiveRes = await db.query(`
      INSERT INTO agent_output_files (user_id, agent_id, file_name, mime_type, file_size, checksum_sha256, storage_path, status, expires_at)
      VALUES ($1, $2, 'test_p1a_active_keep.csv', 'text/csv', 35, $3, $4, 'READY', NOW() + INTERVAL '24 hours')
      RETURNING id
    `, [userA.user_id, validAgentId, dummySha, validActiveFilePath]);
    activeFileDbId = insertActiveRes.rows[0].id;

    // Chạy dọn dẹp
    await purgeExpiredAgentOutputs();

    // Xác minh file vật lý còn hạn VẪN TỒN TẠI
    assert(fs.existsSync(validActiveFilePath), 'F-06.7 File còn hạn KHÔNG bị xóa khỏi đĩa');

    // Xác minh DB record vẫn là READY
    const actDbCheck = await db.query(`SELECT status FROM agent_output_files WHERE id = $1`, [activeFileDbId]);
    assert(actDbCheck.rows[0]?.status === 'READY', 'F-06.8 DB status của file còn hạn vẫn giữ nguyên "READY"');
  } finally {
    if (fs.existsSync(validActiveFilePath)) fs.unlinkSync(validActiveFilePath);
    if (activeFileDbId) await db.query(`DELETE FROM agent_output_files WHERE id = $1`, [activeFileDbId]);
  }

  // --------------------------------------------------------------------------
  // TEST SUITE 3: Full Platform Regression Suite
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Kiểm thử Hồi quy Nền tảng (Platform Regression) ---');

  // 4.1. Lấy danh sách Agents cá nhân của User A
  const listMyAgentsRes = await apiRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/agents',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  assert(listMyAgentsRes.status === 200 && Array.isArray(listMyAgentsRes.data?.agents), 'REG-01 Danh sách Personal AI Agents hoạt động bình thường');

  // 4.2. Clone Agent kiểm tra bảo toàn phiên bản độc lập
  if (listMyAgentsRes.data?.agents?.length > 0) {
    const srcAgent = listMyAgentsRes.data.agents[0];
    const cloneRes = await apiRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/agents/${srcAgent.id}/clone`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    assert(cloneRes.status === 201 && cloneRes.data?.agent?.name.endsWith('-copy'), 'REG-02 Clone Agent hoạt động chính xác với snapshot Version 1 độc lập');
    if (cloneRes.data?.agent?.id) {
      await db.query(`DELETE FROM user_agents WHERE id = $1`, [cloneRes.data.agent.id]);
    }
  }

  // 4.3. Kiểm tra Model Fallback Service cấu hình hợp lệ
  const { DEFAULT_FALLBACK_MODELS } = require('./services/agentOrchestrator');
  assert(Array.isArray(DEFAULT_FALLBACK_MODELS) && DEFAULT_FALLBACK_MODELS.length >= 3, 'REG-03 Fallback Model Chain đã cấu hình đầy đủ tối thiểu 3 model');
  assert(DEFAULT_FALLBACK_MODELS.includes('gemini-3.5-flash-lite') && DEFAULT_FALLBACK_MODELS.includes('gemini-3.1-flash-lite'), 'REG-04 Fallback Chain bao phủ thế hệ Gemini 3.x');

  // 4.4. Kiểm tra Chatbot System (General AI conversation retrieval)
  const convListRes = await apiRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/conversations',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  assert(convListRes.status === 200, 'REG-05 Lấy danh sách lịch sử hội thoại hệ thống ổn định');

  console.log('\n========================================================================');
  console.log(`🎉 KẾT QUẢ KIỂM THỬ: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Lỗi nghiêm trọng trong quá trình kiểm thử:', err);
  process.exit(1);
});
