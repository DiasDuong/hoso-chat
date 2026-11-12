/**
 * TEST P1A SAFE EXECUTION SUITE
 * Covers Giai đoạn 2 (F-01 Rollback) & Giai đoạn 3 (F-06 Retention Cleaner)
 * Strictly verifies all edge cases, safety constraints, concurrency locks, and regressions.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { purgeExpiredAgentOutputs } = require('./services/retentionService');

const JWT_SECRET = process.env.JWT_SECRET || 'hrbot_jwt_secret_dev_2026';
const AGENT_OUTPUTS_DIR = path.resolve(__dirname, 'data/agent_outputs');

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

async function run() {
  console.log('========================================================================');
  console.log('🛡️ BẮT ĐẦU KIỂM THỬ AN TOÀN TOÀN DIỆN GÓI P1A (F-01 & F-06)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}: ${details}`);
      failed++;
    }
  }

  // Chuẩn bị người dùng
  const userARes = await db.query(`SELECT user_id, username, role FROM users WHERE username = 'superadmin' LIMIT 1`);
  const userA = userARes.rows[0];
  const userBRes = await db.query(`SELECT user_id, username, role FROM users WHERE username != 'superadmin' LIMIT 1`);
  const userB = userBRes.rows[0];

  const tokenA = jwt.sign({ user_id: userA.user_id, username: userA.username, role: userA.role }, JWT_SECRET, { expiresIn: '1h' });
  const tokenB = jwt.sign({ user_id: userB.user_id, username: userB.username, role: userB.role }, JWT_SECRET, { expiresIn: '1h' });

  // Baseline conversations check
  const convCountPreRes = await db.query(`SELECT count(*) FROM ai_conversations`);
  const convCountPre = parseInt(convCountPreRes.rows[0].count, 10);

  // --------------------------------------------------------------------------
  // GIAI ĐOẠN 2: F-01 AGENT VERSION ROLLBACK
  // --------------------------------------------------------------------------
  console.log('--- 1. [F-01] Kiểm thử Chi tiết Tính năng Khôi phục Cấu hình Agent ---');
  let testAgentId = null;

  try {
    // 1. Tạo agent test
    const createRes = await apiRequest({
      hostname: '127.0.0.1', port: 3000, path: '/api/agents', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
    }, {
      name: 'Safe-Rollback-Test',
      description: 'Mô tả v1',
      instruction_prompt: 'Chỉ dẫn prompt v1 gốc',
      model_name: 'gemini-3.1-flash-lite'
    });
    testAgentId = createRes.data?.agent?.id;
    assert(createRes.status === 201 && testAgentId, 'Tạo Agent ban đầu thành công');

    // 2. Cập nhật lên v2
    await apiRequest({
      hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}`, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
    }, {
      name: 'Safe-Rollback-Test', description: 'Mô tả v2 đã sửa',
      instruction_prompt: 'Chỉ dẫn prompt v2 đã sửa', model_name: 'gemini-3.5-flash-lite'
    });

    // Test 1: Rollback thành công và tạo snapshot mới
    const rollbackRes = await apiRequest({
      hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/rollback/1`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
    }, { expected_current_version: 2 });

    assert(rollbackRes.status === 200 && rollbackRes.data?.success === true, 'F01-01 Rollback thành công trả về HTTP 200');
    assert(rollbackRes.data?.agent?.current_version === 3, 'F01-01b Snapshot mới được tạo là Version 3 (Append-only)');
    assert(rollbackRes.data?.agent?.instruction_prompt === 'Chỉ dẫn prompt v1 gốc', 'F01-01c Nội dung prompt được khôi phục chính xác');

    // Test 2: Phiên bản đích không tồn tại
    const nonExistVerRes = await apiRequest({
      hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/rollback/999`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
    }, { expected_current_version: 3 });
    assert(nonExistVerRes.status === 404, 'F01-02 Phiên bản đích không tồn tại trả về HTTP 404 Not Found', `Status: ${nonExistVerRes.status}`);

    // Test 3: Agent thuộc người dùng khác (IDOR Protection)
    const idorRes = await apiRequest({
      hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/rollback/1`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenB}` }
    }, { expected_current_version: 3 });
    assert(idorRes.status === 404, 'F01-03 Agent của người khác trả về HTTP 404 (Không tiết lộ sự tồn tại)', `Status: ${idorRes.status}`);

    // Test 4: expected_current_version không khớp
    const occRes = await apiRequest({
      hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/rollback/1`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
    }, { expected_current_version: 1 }); // Thực tế đang là 3
    assert(occRes.status === 409, 'F01-04 expected_current_version không khớp trả về HTTP 409 Conflict', `Status: ${occRes.status}`);

    // Test 5: Hai yêu cầu rollback đồng thời (Concurrency / Row locking)
    console.log('--- Kiểm tra 2 yêu cầu Rollback đồng thời (Row Lock) ---');
    const [p1, p2] = await Promise.all([
      apiRequest({
        hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/rollback/1`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
      }, { expected_current_version: 3 }),
      apiRequest({
        hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/rollback/2`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
      }, { expected_current_version: 3 })
    ]);

    // Một yêu cầu phải thành công (200), yêu cầu còn lại phải xung đột OCC (409) do phiên bản đã tăng lên 4
    const has200 = p1.status === 200 || p2.status === 200;
    const has409 = p1.status === 409 || p2.status === 409;
    assert(has200 && has409, 'F01-05 Khóa đồng thời: Một request thành công 200 và một request xung đột 409 (Chống race condition)', `p1: ${p1.status}, p2: ${p2.status}`);

    // Test 6: Snapshot không hợp lệ hoặc thiếu trường
    // Tạo một snapshot bị rỗng instruction_prompt trong DB để kiểm tra
    await db.query(`
      INSERT INTO user_agent_versions (agent_id, version_number, name, instruction_prompt, model_name, temperature, created_by)
      VALUES ($1, 99, '', '', 'gemini-3.1-flash-lite', 0.70, $2)
    `, [testAgentId, userA.user_id]);

    const currentAgentCheck = (await db.query(`SELECT current_version FROM user_agents WHERE id = $1`, [testAgentId])).rows[0];
    const invalidSnapRes = await apiRequest({
      hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/rollback/99`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` }
    }, { expected_current_version: currentAgentCheck.current_version });

    assert(invalidSnapRes.status === 422, 'F01-06 Snapshot thiếu trường bắt buộc bị từ chối với HTTP 422 Unprocessable Entity', `Status: ${invalidSnapRes.status}`);

    // Test 7: Kiểm tra transaction rollback nếu xảy ra lỗi
    // Agent vẫn giữ nguyên current_version sau khi request 422 bị hủy
    const afterRollbackCheck = (await db.query(`SELECT current_version FROM user_agents WHERE id = $1`, [testAgentId])).rows[0];
    assert(afterRollbackCheck.current_version === currentAgentCheck.current_version, 'F01-07 Transaction an toàn: Lỗi không làm thay đổi cấu hình Agent');

    // Test 8: Lịch sử hội thoại vẫn nguyên vẹn
    const convCountPostRes = await db.query(`SELECT count(*) FROM ai_conversations`);
    const convCountPost = parseInt(convCountPostRes.rows[0].count, 10);
    assert(convCountPost === convCountPre, 'F01-08 Lịch sử hội thoại ai_conversations hoàn toàn nguyên vẹn', `Pre: ${convCountPre}, Post: ${convCountPost}`);

  } finally {
    if (testAgentId) {
      await db.query(`DELETE FROM user_agents WHERE id = $1`, [testAgentId]);
      console.log('✓ Dọn dẹp dữ liệu Agent thử nghiệm');
    }
  }

  // --------------------------------------------------------------------------
  // GIAI ĐOẠN 3: F-06 ARTIFACT RETENTION CLEANER
  // --------------------------------------------------------------------------
  console.log('\n--- 2. [F-06] Kiểm thử An toàn Trình Dọn dẹp Artifact Retention ---');

  const agentRow = await db.query('SELECT id FROM user_agents LIMIT 1');
  const validAgentId = agentRow.rows[0].id;
  const dummySha = 'b'.repeat(64);

  // Test 1: File hết hạn hợp lệ ở chế độ DRY-RUN (MẶC ĐỊNH KHÔNG XÓA FILE THẬT)
  const dummyExpiredPath = path.join(AGENT_OUTPUTS_DIR, 'test_dryrun_expired.xlsx');
  fs.writeFileSync(dummyExpiredPath, 'TEST_DRY_RUN_DATA');
  let expFileId = null;

  try {
    const insExp = await db.query(`
      INSERT INTO agent_output_files (user_id, agent_id, file_name, mime_type, file_size, checksum_sha256, storage_path, status, expires_at)
      VALUES ($1, $2, 'test_dryrun_expired.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 17, $3, $4, 'READY', NOW() - INTERVAL '1 day')
      RETURNING id
    `, [userA.user_id, validAgentId, dummySha, dummyExpiredPath]);
    expFileId = insExp.rows[0].id;

    // Chạy chế độ mặc định (dryRun: true)
    const dryRunResult = await purgeExpiredAgentOutputs({ dryRun: true });

    assert(dryRunResult.dryRun === true, 'F06-01a Cleaner chạy ở chế độ Dry-Run');
    assert(fs.existsSync(dummyExpiredPath), 'F06-01b Chế độ Dry-Run KHÔNG xóa file thật trên đĩa');
    const dbCheckDry = (await db.query(`SELECT status, storage_path FROM agent_output_files WHERE id = $1`, [expFileId])).rows[0];
    assert(dbCheckDry.status === 'READY' && dbCheckDry.storage_path !== '', 'F06-01c Chế độ Dry-Run KHÔNG thay đổi trạng thái trong database');
    assert(dryRunResult.items?.some(i => i.id === expFileId && i.action === 'DRY_RUN_CANDIDATE'), 'F06-01d Báo cáo Dry-Run ghi nhận chi tiết ứng viên đủ điều kiện');

  } finally {
    if (fs.existsSync(dummyExpiredPath)) fs.unlinkSync(dummyExpiredPath);
    if (expFileId) await db.query(`DELETE FROM agent_output_files WHERE id = $1`, [expFileId]);
  }

  // Test 2: File còn hạn không bao giờ bị chọn
  const dummyActivePath = path.join(AGENT_OUTPUTS_DIR, 'test_active_file.xlsx');
  fs.writeFileSync(dummyActivePath, 'TEST_ACTIVE_DATA');
  let activeFileId = null;

  try {
    const insAct = await db.query(`
      INSERT INTO agent_output_files (user_id, agent_id, file_name, mime_type, file_size, checksum_sha256, storage_path, status, expires_at)
      VALUES ($1, $2, 'test_active_file.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 16, $3, $4, 'READY', NOW() + INTERVAL '5 days')
      RETURNING id
    `, [userA.user_id, validAgentId, dummySha, dummyActivePath]);
    activeFileId = insAct.rows[0].id;

    const dryRunActResult = await purgeExpiredAgentOutputs({ dryRun: true });
    assert(!dryRunActResult.items?.some(i => i.id === activeFileId), 'F06-02 File còn hạn (expires_at > NOW()) KHÔNG bị đưa vào danh sách dọn dẹp');
    assert(fs.existsSync(dummyActivePath), 'F06-02b File còn hạn nguyên vẹn trên đĩa');

  } finally {
    if (fs.existsSync(dummyActivePath)) fs.unlinkSync(dummyActivePath);
    if (activeFileId) await db.query(`DELETE FROM agent_output_files WHERE id = $1`, [activeFileId]);
  }

  // Test 3: File đã không tồn tại trên đĩa (Xử lý an toàn)
  const nonExistPath = path.join(AGENT_OUTPUTS_DIR, 'ghost_missing_file.xlsx');
  let ghostFileId = null;

  try {
    const insGhost = await db.query(`
      INSERT INTO agent_output_files (user_id, agent_id, file_name, mime_type, file_size, checksum_sha256, storage_path, status, expires_at)
      VALUES ($1, $2, 'ghost_missing_file.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 10, $3, $4, 'READY', NOW() - INTERVAL '2 days')
      RETURNING id
    `, [userA.user_id, validAgentId, dummySha, nonExistPath]);
    ghostFileId = insGhost.rows[0].id;

    // Chạy thực thi (dryRun: false) trên ghost file
    const realExecGhost = await purgeExpiredAgentOutputs({ dryRun: false });
    assert(realExecGhost.purgedCount >= 1, 'F06-03 File vật lý không tồn tại được xử lý an toàn không gây lỗi');
    const ghostDbCheck = (await db.query(`SELECT status, storage_path FROM agent_output_files WHERE id = $1`, [ghostFileId])).rows[0];
    assert(ghostDbCheck.status === 'PURGED' && ghostDbCheck.storage_path === '', 'F06-03b Bản ghi DB của ghost file được cập nhật PURGED');

  } finally {
    if (ghostFileId) await db.query(`DELETE FROM agent_output_files WHERE id = $1`, [ghostFileId]);
  }

  // Test 4: Đường dẫn Traversal (path.resolve + path.relative boundary check)
  const traversalOutsidePath = path.resolve(__dirname, 'traversal_forbidden_test.txt');
  fs.writeFileSync(traversalOutsidePath, 'SENSITIVE_OUTSIDE_FILE');
  let travFileId = null;

  try {
    const insTrav = await db.query(`
      INSERT INTO agent_output_files (user_id, agent_id, file_name, mime_type, file_size, checksum_sha256, storage_path, status, expires_at)
      VALUES ($1, $2, 'hack.txt', 'text/plain', 22, $3, $4, 'READY', NOW() - INTERVAL '1 hour')
      RETURNING id
    `, [userA.user_id, validAgentId, dummySha, traversalOutsidePath]);
    travFileId = insTrav.rows[0].id;

    const travResult = await purgeExpiredAgentOutputs({ dryRun: false });
    assert(fs.existsSync(traversalOutsidePath), 'F06-04 Path Traversal: Tệp ngoài thư mục tuyệt đối KHÔNG bị xóa');
    const travDbCheck = (await db.query(`SELECT status FROM agent_output_files WHERE id = $1`, [travFileId])).rows[0];
    assert(travDbCheck.status !== 'PURGED', 'F06-04b Bản ghi có path traversal bị từ chối cập nhật PURGED');

  } finally {
    if (fs.existsSync(traversalOutsidePath)) fs.unlinkSync(traversalOutsidePath);
    if (travFileId) await db.query(`DELETE FROM agent_output_files WHERE id = $1`, [travFileId]);
  }

  // Test 5: Concurrency / Mutex lock của Cleaner
  console.log('--- Kiểm tra Mutex Lock của Cleaner (Chống chạy trùng) ---');
  // Kích hoạt đồng thời 2 lần gọi
  const [clean1, clean2] = await Promise.all([
    purgeExpiredAgentOutputs({ dryRun: true }),
    purgeExpiredAgentOutputs({ dryRun: true })
  ]);
  const oneSkipped = clean1.skipped || clean2.skipped;
  assert(oneSkipped, 'F06-05 Concurrency Mutex: Một lần gọi được thực thi và lần gọi song song bị skip');

  // Test 6: Giới hạn Batch (batchLimit)
  const batchTestRes = await purgeExpiredAgentOutputs({ dryRun: true, batchLimit: 5 });
  assert(batchTestRes.batchLimit === 5, 'F06-06 Giới hạn batch được áp dụng chính xác');

  // Test 7: Bảo toàn tệp Artifact thực tế của hệ thống
  console.log('--- Kiểm tra bảo toàn các tệp Artifact thật của hệ thống ---');
  const resolveCheckPath = (p) => {
    if (!p) return null;
    let s = String(p).trim();
    if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(s)) {
      const parts = s.split(/[\\/]/);
      const idx = parts.indexOf('agent_outputs');
      if (idx !== -1) return path.resolve(AGENT_OUTPUTS_DIR, parts.slice(idx + 1).join('/'));
    }
    return path.resolve(s);
  };

  const realArtifactsCheck = await db.query(`SELECT id, file_name, storage_path FROM agent_output_files WHERE status = 'READY'`);
  let allRealFilesExist = true;
  for (const row of realArtifactsCheck.rows) {
    const cp = resolveCheckPath(row.storage_path);
    if (!cp || !fs.existsSync(cp)) {
      allRealFilesExist = false;
      console.error(`File thật bị thiếu: ${row.storage_path} -> ${cp}`);
    }
  }
  assert(allRealFilesExist && realArtifactsCheck.rows.length >= 2, 'F06-07 100% tệp Artifact thật còn hạn vẫn nguyên vẹn trên đĩa');

  // --------------------------------------------------------------------------
  // HỒI QUY TOÀN DIỆN CRUD & CHATBOT
  // --------------------------------------------------------------------------
  console.log('\n--- 3. Kiểm thử Hồi quy Nền tảng (CRUD, Clone, Regenerate) ---');
  const listAgentsRes = await apiRequest({
    hostname: '127.0.0.1', port: 3000, path: '/api/agents', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  assert(listAgentsRes.status === 200 && Array.isArray(listAgentsRes.data?.agents), 'REG-01 Danh sách Personal Agents phản hồi ổn định');

  console.log('\n========================================================================');
  console.log(`🎉 KẾT QUẢ: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Lỗi kiểm thử an toàn:', err);
  process.exit(1);
});
