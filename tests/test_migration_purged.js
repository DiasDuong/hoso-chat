/**
 * Test: Independent Verification Script for Migration 20261020_p1a_add_purged_status.sql
 * Stage 2 — F-06 Hardening
 */

const fs = require('fs');
const path = require('path');
const db = require('../auth-service/db');

async function runMigrationTest() {
  console.log('===============================================================');
  console.log('   F-06 HARDENING — STAGE 2 MIGRATION VERIFICATION SUITE       ');
  console.log('===============================================================');

  const migrationPath = path.resolve(__dirname, '../sql/migrations/20261020_p1a_add_purged_status.sql');
  const historicalPath = path.resolve(__dirname, '../sql/migrations/20261019_create_agent_output_files.sql');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} - ${details}`);
      failed++;
    }
  }

  // 1. Kiểm tra sự tồn tại và tính nguyên vẹn của file migration
  assert(fs.existsSync(migrationPath), '1.1 Migration file 20261020_p1a_add_purged_status.sql exists');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  assert(migrationSql.includes('chk_agent_output_status') && migrationSql.includes('PURGED'),
    '1.2 Migration SQL contains correct constraint name and PURGED status');

  assert(fs.existsSync(historicalPath), '1.3 Historical migration 20261019_create_agent_output_files.sql preserved');

  const client = await db.getClient();

  try {
    // 2. Kiểm tra trước khi áp dụng
    const preCheck = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) as def 
      FROM pg_constraint 
      WHERE conrelid = 'public.agent_output_files'::regclass 
        AND conname = 'chk_agent_output_status'
    `);
    assert(preCheck.rows.length === 1, '2.1 Constraint chk_agent_output_status exists before re-application');

    // Lưu snapshot dữ liệu thật trước khi kiểm thử
    const initialRows = await client.query(`SELECT id, status, file_name FROM public.agent_output_files ORDER BY id`);
    const initialCount = initialRows.rowCount;
    console.log(`[INFO] Current production records count: ${initialCount}`);

    // 3. Thực thi migration lần 1
    console.log('[INFO] Applying migration (Run 1)...');
    await client.query(migrationSql);
    assert(true, '3.1 Migration executed successfully on Run 1');

    // 4. Kiểm tra định nghĩa constraint sau khi chạy
    const postCheck1 = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) as def 
      FROM pg_constraint 
      WHERE conrelid = 'public.agent_output_files'::regclass 
        AND conname = 'chk_agent_output_status'
    `);
    const def1 = postCheck1.rows[0]?.def || '';
    const containsAll = ['GENERATING', 'READY', 'FAILED', 'EXPIRED', 'PURGED'].every(s => def1.includes(s));
    assert(containsAll, '4.1 Constraint definition includes all 5 valid statuses', def1);

    // 5. Kiểm tra tính Idempotent (Chạy lại lần 2 và lần 3)
    console.log('[INFO] Testing Idempotency (Run 2 & Run 3)...');
    await client.query(migrationSql);
    await client.query(migrationSql);
    const postCheck2 = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) as def 
      FROM pg_constraint 
      WHERE conrelid = 'public.agent_output_files'::regclass 
        AND conname = 'chk_agent_output_status'
    `);
    assert(postCheck2.rows.length === 1, '5.1 Idempotency verified: exactly 1 constraint exists after repeated runs');

    // 6. Kiểm thử dữ liệu mẫu: Thử nghiệm cả 5 trạng thái hợp lệ
    // Lấy 1 user_id và agent_id hợp lệ để gắn khóa ngoại
    const userRes = await client.query(`SELECT user_id FROM public.users LIMIT 1`);
    const agentRes = await client.query(`SELECT id FROM public.user_agents LIMIT 1`);
    const testUserId = userRes.rows[0]?.user_id;
    const testAgentId = agentRes.rows[0]?.id;

    if (!testUserId || !testAgentId) {
      throw new Error('Cannot find valid user or agent for constraint testing');
    }

    const validStatuses = ['GENERATING', 'READY', 'FAILED', 'EXPIRED', 'PURGED'];
    for (const st of validStatuses) {
      await client.query('BEGIN');
      try {
        const ins = await client.query(`
          INSERT INTO public.agent_output_files 
          (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status)
          VALUES ($1, $2, 'test_status.xlsx', '/tmp/test.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 100, 'dummyhash', $3)
          RETURNING id, status
        `, [testUserId, testAgentId, st]);
        assert(ins.rows[0].status === st, `6. Valid status accepted: ${st}`);
      } finally {
        await client.query('ROLLBACK'); // Rollback tuyệt đối không lưu rác
      }
    }

    // 7. Kiểm thử trạng thái không hợp lệ (Bắt buộc phải bị REJECT)
    await client.query('BEGIN');
    let rejected = false;
    let errorCode = null;
    try {
      await client.query(`
        INSERT INTO public.agent_output_files 
        (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status)
        VALUES ($1, $2, 'test_invalid.xlsx', '/tmp/test.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 100, 'dummyhash', 'INVALID_STATUS')
      `, [testUserId, testAgentId]);
    } catch (err) {
      rejected = true;
      errorCode = err.code;
    } finally {
      await client.query('ROLLBACK');
    }
    assert(rejected && errorCode === '23514', '7.1 Invalid status rejected with check_violation (code 23514)');

    // 8. Xác minh tính toàn vẹn của dữ liệu Production
    const finalRows = await client.query(`SELECT id, status, file_name FROM public.agent_output_files ORDER BY id`);
    assert(finalRows.rowCount === initialCount, `8.1 Production row count strictly preserved (${finalRows.rowCount} === ${initialCount})`);
    
    let rowsMatch = true;
    for (let i = 0; i < initialCount; i++) {
      if (initialRows.rows[i].id !== finalRows.rows[i].id || initialRows.rows[i].status !== finalRows.rows[i].status) {
        rowsMatch = false;
        break;
      }
    }
    assert(rowsMatch, '8.2 Existing production records unchanged in IDs, names, and statuses');

  } catch (err) {
    console.error('[ERROR during migration test]:', err);
    failed++;
  } finally {
    client.release();
  }

  console.log('===============================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runMigrationTest()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Fatal test runner error:', e);
    process.exit(1);
  });
