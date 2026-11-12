/**
 * SOTRANS Hub — F-06 Hardening Stage 3
 * STAGING FILESYSTEM SAFETY TEST SUITE
 * 
 * Verifies all 10 filesystem error scenarios in an isolated staging sandbox:
 * - Dedicated staging database: hrbot_staging (port 5433)
 * - Dedicated staging directory: tests/fixtures/staging_agent_outputs
 * - Strict isolation from production (port 5432 / hrbot / auth-service/data/agent_outputs)
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('../auth-service/node_modules/pg');
const { purgeExpiredAgentOutputs } = require('../auth-service/services/retentionService');

// 1. Cấu hình Staging DB độc lập (Port 5433)
const stagingPool = new Pool({
  host: '127.0.0.1',
  port: 5433,
  database: 'hrbot_staging',
  user: 'hrbot',
  password: 'hrchatbot',
});

const STAGING_DIR = path.resolve(__dirname, 'fixtures', 'staging_agent_outputs');
const OUTSIDE_DIR = path.resolve(__dirname, 'fixtures', 'staging_outside_canary');
const PROD_DIR = path.resolve(__dirname, '../auth-service/data/agent_outputs');

// Production DB Pool để kiểm tra bất biến (Read-only)
const prodPool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'hrbot',
  user: 'hrbot',
  password: 'hrchatbot',
});

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_AGENT_ID = '22222222-2222-2222-2222-222222222222';

const testResults = [];

function recordTest(id, name, status, details = {}) {
  testResults.push({ id, name, status, ...details });
  const symbol = status === 'PASS' ? '[PASS]' : (status === 'NOT VERIFIED' ? '[NOT VERIFIED]' : '[FAIL]');
  console.log(`${symbol} ${id}: ${name}`);
  if (details.note) console.log(`       Note: ${details.note}`);
  if (details.error) console.log(`       Error: ${details.error}`);
}

async function runStagingTestSuite() {
  console.log('======================================================================');
  console.log('   SOTRANS HUB — F-06 HARDENING STAGE 3: STAGING FILESYSTEM SUITE    ');
  console.log('======================================================================');

  // Setup sandbox directories
  if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
  if (!fs.existsSync(OUTSIDE_DIR)) fs.mkdirSync(OUTSIDE_DIR, { recursive: true });

  // Baseline production check
  const prodInitialRes = await prodPool.query(`SELECT id, status, file_name FROM public.agent_output_files ORDER BY id`);
  const prodInitialCount = prodInitialRes.rowCount;
  const prodInitialFiles = fs.readdirSync(path.join(PROD_DIR, 'f2b6606e-3125-409c-b5f9-d3ed82282c26/2026/10'));
  console.log(`[PREFLIGHT] Production DB records: ${prodInitialCount}, Production files: ${prodInitialFiles.length}`);

  // Clean staging DB before tests
  await stagingPool.query(`DELETE FROM public.agent_output_files WHERE user_id = $1`, [TEST_USER_ID]);

  // Canary file outside staging dir to verify path traversal never deletes outside
  const canaryPath = path.join(OUTSIDE_DIR, 'canary_do_not_delete.txt');
  fs.writeFileSync(canaryPath, 'CRITICAL_CANARY_OUTSIDE_SANDBOX', 'utf8');

  // -----------------------------------------------------------------------------------
  // TC-01: File thử nghiệm đã hết hạn, nằm trong thư mục được phép và xóa thành công
  // -----------------------------------------------------------------------------------
  try {
    const file1Path = path.join(STAGING_DIR, 'tc01_expired.xlsx');
    fs.writeFileSync(file1Path, 'EXPIRED_CONTENT_TC01', 'utf8');
    const ins1 = await stagingPool.query(`
      INSERT INTO public.agent_output_files 
      (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
      VALUES ($1, $2, 'tc01_expired.xlsx', $3, 'application/vnd.ms-excel', 20, 'hash1', 'EXPIRED', NOW() - INTERVAL '2 days')
      RETURNING id
    `, [TEST_USER_ID, TEST_AGENT_ID, file1Path]);
    const file1Id = ins1.rows[0].id;

    const res1 = await purgeExpiredAgentOutputs({
      dryRun: false,
      baseDir: STAGING_DIR,
      db: stagingPool
    });

    const file1StillExists = fs.existsSync(file1Path);
    const db1Res = await stagingPool.query(`SELECT status, storage_path FROM public.agent_output_files WHERE id = $1`, [file1Id]);
    const db1Status = db1Res.rows[0]?.status;
    const db1Path = db1Res.rows[0]?.storage_path;

    if (!file1StillExists && db1Status === 'PURGED' && db1Path === '') {
      recordTest('TC-01', 'Expired file in allowed dir purged successfully', 'PASS', {
        file_id: file1Id,
        fs_deleted: !file1StillExists,
        db_status: db1Status,
        unlinked_count: res1.unlinkedCount
      });
    } else {
      recordTest('TC-01', 'Expired file in allowed dir purged successfully', 'FAIL', {
        file_exists: file1StillExists,
        db_status: db1Status
      });
    }

    await stagingPool.query(`DELETE FROM public.agent_output_files WHERE id = $1`, [file1Id]);
  } catch (err) {
    recordTest('TC-01', 'Expired file in allowed dir purged successfully', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-02: File còn hạn không bị chọn để xóa
  // -----------------------------------------------------------------------------------
  try {
    const file2Path = path.join(STAGING_DIR, 'tc02_active.xlsx');
    fs.writeFileSync(file2Path, 'ACTIVE_FILE_TC02', 'utf8');
    const ins2 = await stagingPool.query(`
      INSERT INTO public.agent_output_files 
      (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
      VALUES ($1, $2, 'tc02_active.xlsx', $3, 'application/vnd.ms-excel', 16, 'hash2', 'READY', NOW() + INTERVAL '5 days')
      RETURNING id
    `, [TEST_USER_ID, TEST_AGENT_ID, file2Path]);
    const file2Id = ins2.rows[0].id;

    await purgeExpiredAgentOutputs({
      dryRun: false,
      baseDir: STAGING_DIR,
      db: stagingPool
    });

    const file2Exists = fs.existsSync(file2Path);
    const db2Res = await stagingPool.query(`SELECT status FROM public.agent_output_files WHERE id = $1`, [file2Id]);
    const db2Status = db2Res.rows[0]?.status;

    if (file2Exists && db2Status === 'READY') {
      recordTest('TC-02', 'Active unexpired file not selected or deleted', 'PASS', {
        file_id: file2Id,
        file_intact: file2Exists,
        db_status: db2Status
      });
    } else {
      recordTest('TC-02', 'Active unexpired file not selected or deleted', 'FAIL', {
        file_exists: file2Exists,
        db_status: db2Status
      });
    }

    if (fs.existsSync(file2Path)) fs.unlinkSync(file2Path);
    await stagingPool.query(`DELETE FROM public.agent_output_files WHERE id = $1`, [file2Id]);
  } catch (err) {
    recordTest('TC-02', 'Active unexpired file not selected or deleted', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-03: File vật lý không tồn tại nhưng còn metadata trong DB (Ghost Record)
  // -----------------------------------------------------------------------------------
  try {
    const ghostPath = path.join(STAGING_DIR, 'tc03_ghost_nonexistent.xlsx');
    // Không tạo file vật lý
    const ins3 = await stagingPool.query(`
      INSERT INTO public.agent_output_files 
      (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
      VALUES ($1, $2, 'tc03_ghost.xlsx', $3, 'application/vnd.ms-excel', 500, 'hash3', 'EXPIRED', NOW() - INTERVAL '1 day')
      RETURNING id
    `, [TEST_USER_ID, TEST_AGENT_ID, ghostPath]);
    const ghostId = ins3.rows[0].id;

    const res3 = await purgeExpiredAgentOutputs({
      dryRun: false,
      baseDir: STAGING_DIR,
      db: stagingPool
    });

    const db3Res = await stagingPool.query(`SELECT status, storage_path FROM public.agent_output_files WHERE id = $1`, [ghostId]);
    const db3Status = db3Res.rows[0]?.status;

    if (db3Status === 'PURGED' && db3Res.rows[0]?.storage_path === '') {
      recordTest('TC-03', 'Ghost record safely marked PURGED in DB', 'PASS', {
        file_id: ghostId,
        db_status: db3Status,
        purged_count: res3.purgedCount
      });
    } else {
      recordTest('TC-03', 'Ghost record safely marked PURGED in DB', 'FAIL', { db_status: db3Status });
    }

    await stagingPool.query(`DELETE FROM public.agent_output_files WHERE id = $1`, [ghostId]);
  } catch (err) {
    recordTest('TC-03', 'Ghost record safely marked PURGED in DB', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-04: Đường dẫn traversal ra ngoài thư mục artifact
  // -----------------------------------------------------------------------------------
  try {
    const outsideTarget = canaryPath; // trỏ vào file canary bên ngoài
    const ins4 = await stagingPool.query(`
      INSERT INTO public.agent_output_files 
      (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
      VALUES ($1, $2, 'tc04_traversal.xlsx', $3, 'application/vnd.ms-excel', 100, 'hash4', 'EXPIRED', NOW() - INTERVAL '1 day')
      RETURNING id
    `, [TEST_USER_ID, TEST_AGENT_ID, outsideTarget]);
    const traversalId = ins4.rows[0].id;

    const res4 = await purgeExpiredAgentOutputs({
      dryRun: false,
      baseDir: STAGING_DIR,
      db: stagingPool
    });

    const canaryStillExists = fs.existsSync(canaryPath);
    const db4Res = await stagingPool.query(`SELECT status FROM public.agent_output_files WHERE id = $1`, [traversalId]);
    const db4Status = db4Res.rows[0]?.status;

    const rejectedItem = res4.items?.find(i => i.id === traversalId);
    if (canaryStillExists && db4Status !== 'PURGED' && rejectedItem?.action === 'REJECTED_PATH_TRAVERSAL') {
      recordTest('TC-04', 'Path traversal outside artifact root rejected', 'PASS', {
        file_id: traversalId,
        canary_intact: canaryStillExists,
        db_status: db4Status,
        action: rejectedItem.action
      });
    } else {
      recordTest('TC-04', 'Path traversal outside artifact root rejected', 'FAIL', {
        canary_exists: canaryStillExists,
        db_status: db4Status
      });
    }

    await stagingPool.query(`DELETE FROM public.agent_output_files WHERE id = $1`, [traversalId]);
  } catch (err) {
    recordTest('TC-04', 'Path traversal outside artifact root rejected', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-05: Symlink trỏ ra ngoài thư mục được phép (nếu HĐH hỗ trợ)
  // -----------------------------------------------------------------------------------
  try {
    const symlinkPath = path.join(STAGING_DIR, 'tc05_symlink_outside.xlsx');
    let symlinkCreated = false;
    try {
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      fs.symlinkSync(canaryPath, symlinkPath, 'file');
      symlinkCreated = true;
    } catch (symErr) {
      console.log(`[INFO] Symlink creation restricted by Windows OS privilege: ${symErr.message}`);
    }

    if (symlinkCreated) {
      const ins5 = await stagingPool.query(`
        INSERT INTO public.agent_output_files 
        (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
        VALUES ($1, $2, 'tc05_symlink.xlsx', $3, 'application/vnd.ms-excel', 50, 'hash5', 'EXPIRED', NOW() - INTERVAL '1 day')
        RETURNING id
      `, [TEST_USER_ID, TEST_AGENT_ID, symlinkPath]);
      const symlinkId = ins5.rows[0].id;

      const res5 = await purgeExpiredAgentOutputs({
        dryRun: false,
        baseDir: STAGING_DIR,
        db: stagingPool
      });

      const canaryExists = fs.existsSync(canaryPath);
      const db5Res = await stagingPool.query(`SELECT status FROM public.agent_output_files WHERE id = $1`, [symlinkId]);
      const item = res5.items?.find(i => i.id === symlinkId);

      if (canaryExists && item?.action === 'REJECTED_SYMLINK_OUTSIDE') {
        recordTest('TC-05', 'Symlink pointing outside artifact root rejected', 'PASS', {
          canary_intact: canaryExists,
          action: item.action
        });
      } else {
        recordTest('TC-05', 'Symlink pointing outside artifact root rejected', 'FAIL', {
          canary_intact: canaryExists,
          action: item?.action
        });
      }
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      await stagingPool.query(`DELETE FROM public.agent_output_files WHERE id = $1`, [symlinkId]);
    } else {
      recordTest('TC-05', 'Symlink pointing outside artifact root rejected', 'NOT VERIFIED', {
        note: 'Windows unprivileged environment requires SeCreateSymbolicLinkPrivilege. Symlink validation logic (fs.lstatSync + fs.realpathSync) inspected and verified via unit mock.'
      });
    }
  } catch (err) {
    recordTest('TC-05', 'Symlink pointing outside artifact root rejected', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-06: Lỗi EACCES hoặc EPERM khi xóa tệp (Permission / Unlink Denied)
  // -----------------------------------------------------------------------------------
  try {
    // Trên Windows, fs.unlinkSync trên thư mục sẽ quăng EPERM: operation not permitted
    // Mô phỏng chính xác tình huống fs.unlinkSync bị chặn bởi quyền hệ thống tệp
    const lockedDirPath = path.join(STAGING_DIR, 'tc06_locked_file.xlsx');
    if (!fs.existsSync(lockedDirPath)) fs.mkdirSync(lockedDirPath);

    const ins6 = await stagingPool.query(`
      INSERT INTO public.agent_output_files 
      (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
      VALUES ($1, $2, 'tc06_locked.xlsx', $3, 'application/vnd.ms-excel', 30, 'hash6', 'EXPIRED', NOW() - INTERVAL '1 day')
      RETURNING id
    `, [TEST_USER_ID, TEST_AGENT_ID, lockedDirPath]);
    const lockedId = ins6.rows[0].id;

    const res6 = await purgeExpiredAgentOutputs({
      dryRun: false,
      baseDir: STAGING_DIR,
      db: stagingPool
    });

    const fileStillExists = fs.existsSync(lockedDirPath);
    const db6Res = await stagingPool.query(`SELECT status FROM public.agent_output_files WHERE id = $1`, [lockedId]);
    const db6Status = db6Res.rows[0]?.status;
    const deleteFailedItem = res6.items?.find(i => i.id === lockedId);

    // Tiêu chí PASS cốt lõi: Nếu thao tác xóa thất bại (EPERM), DB TUYỆT ĐỐI KHÔNG ĐƯỢC cập nhật PURGED!
    if (fileStillExists && db6Status !== 'PURGED' && deleteFailedItem?.action === 'DELETE_FAILED') {
      recordTest('TC-06', 'File locked/permission error (EPERM/EACCES) handled safely (DB not marked PURGED)', 'PASS', {
        file_id: lockedId,
        file_preserved: fileStillExists,
        db_status: db6Status,
        reason: deleteFailedItem.reason
      });
    } else {
      recordTest('TC-06', 'File locked/permission error (EPERM/EACCES) handled safely (DB not marked PURGED)', 'FAIL', {
        file_exists: fileStillExists,
        db_status: db6Status,
        item: deleteFailedItem
      });
    }

    // Dọn dẹp thư mục sau test
    if (fs.existsSync(lockedDirPath)) fs.rmdirSync(lockedDirPath);
    await stagingPool.query(`DELETE FROM public.agent_output_files WHERE id = $1`, [lockedId]);
  } catch (err) {
    recordTest('TC-06', 'File locked/permission error handled safely', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-07: Lỗi cập nhật database sau khi xóa tệp (Simulated DB Interruption)
  // -----------------------------------------------------------------------------------
  try {
    const file7Path = path.join(STAGING_DIR, 'tc07_db_error.xlsx');
    fs.writeFileSync(file7Path, 'TC07_CONTENT', 'utf8');

    const ins7 = await stagingPool.query(`
      INSERT INTO public.agent_output_files 
      (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
      VALUES ($1, $2, 'tc07_db_error.xlsx', $3, 'application/vnd.ms-excel', 25, 'hash7', 'EXPIRED', NOW() - INTERVAL '1 day')
      RETURNING id
    `, [TEST_USER_ID, TEST_AGENT_ID, file7Path]);
    const file7Id = ins7.rows[0].id;

    // Giả lập DB mock bị lỗi khi chạy UPDATE
    const faultyDb = {
      query: async (sql, params) => {
        if (typeof sql === 'string' && sql.includes('UPDATE public.agent_output_files')) {
          throw new Error('Simulated DB Network Interruption during UPDATE');
        }
        return stagingPool.query(sql, params);
      }
    };

    const res7 = await purgeExpiredAgentOutputs({
      dryRun: false,
      baseDir: STAGING_DIR,
      db: faultyDb
    });

    const fileDeleted = !fs.existsSync(file7Path);
    const db7Res = await stagingPool.query(`SELECT status FROM public.agent_output_files WHERE id = $1`, [file7Id]);
    const db7Status = db7Res.rows[0]?.status;

    // File đã bị unlink nhưng DB UPDATE bị ngắt -> DB vẫn giữ 'EXPIRED'
    // Giữ nguyên bản ghi này để TC-10 kiểm thử Self-Healing!
    if (fileDeleted && db7Status === 'EXPIRED' && res7.error?.includes('Simulated DB Network Interruption')) {
      recordTest('TC-07', 'DB error after unlink handled gracefully (state noted as unlinked ghost)', 'PASS', {
        file_id: file7Id,
        fs_deleted: fileDeleted,
        db_retained_status: db7Status,
        error_captured: res7.error
      });
    } else {
      recordTest('TC-07', 'DB error after unlink handled gracefully', 'FAIL', {
        file_deleted: fileDeleted,
        db_status: db7Status,
        error: res7.error
      });
    }
  } catch (err) {
    recordTest('TC-07', 'DB error after unlink handled gracefully', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-08: Hai cleaner chạy đồng thời (Concurrency Lock)
  // -----------------------------------------------------------------------------------
  try {
    const p1 = purgeExpiredAgentOutputs({ dryRun: true, baseDir: STAGING_DIR, db: stagingPool });
    const p2 = purgeExpiredAgentOutputs({ dryRun: true, baseDir: STAGING_DIR, db: stagingPool });

    const [r1, r2] = await Promise.all([p1, p2]);

    const oneSkipped = r1.skipped === true || r2.skipped === true;
    if (oneSkipped) {
      recordTest('TC-08', 'Concurrent cleaners blocked safely via concurrency lock', 'PASS', {
        p1_skipped: r1.skipped || false,
        p2_skipped: r2.skipped || false,
        reason: r1.reason || r2.reason
      });
    } else {
      recordTest('TC-08', 'Concurrent cleaners blocked safely via concurrency lock', 'FAIL', { r1, r2 });
    }
  } catch (err) {
    recordTest('TC-08', 'Concurrent cleaners blocked safely via concurrency lock', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-09: Giới hạn batch (Batch Limit)
  // -----------------------------------------------------------------------------------
  try {
    const batchIds = [];
    for (let i = 1; i <= 4; i++) {
      const p = path.join(STAGING_DIR, `tc09_batch_${i}.xlsx`);
      fs.writeFileSync(p, `BATCH_${i}`, 'utf8');
      const ins = await stagingPool.query(`
        INSERT INTO public.agent_output_files 
        (user_id, agent_id, file_name, storage_path, mime_type, file_size, checksum_sha256, status, expires_at)
        VALUES ($1, $2, $3, $4, 'application/vnd.ms-excel', 10, 'batchhash', 'EXPIRED', NOW() - INTERVAL '3 days')
        RETURNING id
      `, [TEST_USER_ID, TEST_AGENT_ID, `tc09_batch_${i}.xlsx`, p]);
      batchIds.push({ id: ins.rows[0].id, path: p });
    }

    const res9 = await purgeExpiredAgentOutputs({
      dryRun: false,
      batchLimit: 2, // Chỉ giới hạn 2
      baseDir: STAGING_DIR,
      db: stagingPool
    });

    if (res9.purgedCount === 2 && res9.totalScanned === 2) {
      recordTest('TC-09', 'Batch limit strictly enforced (processed exactly 2 of 4)', 'PASS', {
        requested_batch: 2,
        purged_count: res9.purgedCount,
        total_scanned: res9.totalScanned
      });
    } else {
      recordTest('TC-09', 'Batch limit strictly enforced', 'FAIL', { res9 });
    }

    // Dọn dẹp phần còn lại
    batchIds.forEach(item => {
      if (fs.existsSync(item.path)) fs.unlinkSync(item.path);
    });
    await stagingPool.query(`DELETE FROM public.agent_output_files WHERE user_id = $1 AND file_name LIKE 'tc09_batch_%'`, [TEST_USER_ID]);
  } catch (err) {
    recordTest('TC-09', 'Batch limit strictly enforced', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // TC-10: Khởi chạy lại sau khi một lần chạy bị gián đoạn (Self-Healing from TC-07)
  // -----------------------------------------------------------------------------------
  try {
    const tc07Candidate = await stagingPool.query(`
      SELECT id, status, storage_path FROM public.agent_output_files 
      WHERE file_name = 'tc07_db_error.xlsx' AND status = 'EXPIRED'
    `);

    if (tc07Candidate.rows.length === 0) {
      throw new Error('TC-07 candidate not found for self-healing verification');
    }

    const targetId = tc07Candidate.rows[0].id;

    // Chạy lại cleaner bình thường với DB staging
    const res10 = await purgeExpiredAgentOutputs({
      dryRun: false,
      baseDir: STAGING_DIR,
      db: stagingPool
    });

    const db10Res = await stagingPool.query(`SELECT status, storage_path FROM public.agent_output_files WHERE id = $1`, [targetId]);
    const db10Status = db10Res.rows[0]?.status;

    if (db10Status === 'PURGED' && db10Res.rows[0]?.storage_path === '') {
      recordTest('TC-10', 'Interrupted run self-heals on subsequent cycle (ghost transitioned to PURGED)', 'PASS', {
        file_id: targetId,
        healed_status: db10Status
      });
    } else {
      recordTest('TC-10', 'Interrupted run self-heals on subsequent cycle', 'FAIL', { db_status: db10Status });
    }

    await stagingPool.query(`DELETE FROM public.agent_output_files WHERE id = $1`, [targetId]);
  } catch (err) {
    recordTest('TC-10', 'Interrupted run self-heals on subsequent cycle', 'FAIL', { error: err.message });
  }

  // -----------------------------------------------------------------------------------
  // POST-FLIGHT PRODUCTION DATA INTEGRITY VERIFICATION
  // -----------------------------------------------------------------------------------
  console.log('----------------------------------------------------------------------');
  console.log('   POST-FLIGHT: VERIFYING PRODUCTION UNTOUCHED IMMUTABILITY           ');
  console.log('----------------------------------------------------------------------');

  const prodFinalRes = await prodPool.query(`SELECT id, status, file_name FROM public.agent_output_files ORDER BY id`);
  const prodFinalFiles = fs.readdirSync(path.join(PROD_DIR, 'f2b6606e-3125-409c-b5f9-d3ed82282c26/2026/10'));

  const prodRecordsMatch = prodFinalRes.rowCount === prodInitialCount &&
    prodFinalRes.rows.every((r, idx) => r.id === prodInitialRes.rows[idx].id && r.status === prodInitialRes.rows[idx].status);

  const prodFilesMatch = prodFinalFiles.length === prodInitialFiles.length &&
    prodFinalFiles.every((f, idx) => f === prodInitialFiles[idx]);

  console.log(`[POST-FLIGHT] Production DB unchanged: ${prodRecordsMatch} (${prodFinalRes.rowCount} rows)`);
  console.log(`[POST-FLIGHT] Production Files unchanged: ${prodFilesMatch} (${prodFinalFiles.length} files)`);

  // -----------------------------------------------------------------------------------
  // CLEANUP STAGING SANDBOX (Only sandbox test data)
  // -----------------------------------------------------------------------------------
  console.log('----------------------------------------------------------------------');
  console.log('   CLEANUP: PURGING ONLY STAGING SANDBOX TEST DATA                    ');
  console.log('----------------------------------------------------------------------');

  await stagingPool.query(`DELETE FROM public.agent_output_files WHERE user_id = $1`, [TEST_USER_ID]);
  const remainingStagingRows = await stagingPool.query(`SELECT COUNT(*) FROM public.agent_output_files`);

  const remainingFiles = fs.readdirSync(STAGING_DIR);
  remainingFiles.forEach(f => {
    try { fs.unlinkSync(path.join(STAGING_DIR, f)); } catch (_) {}
  });

  if (fs.existsSync(canaryPath)) fs.unlinkSync(canaryPath);
  try { fs.rmdirSync(OUTSIDE_DIR); } catch (_) {}

  console.log(`[CLEANUP] Staging DB rows remaining: ${remainingStagingRows.rows[0].count}`);
  console.log(`[CLEANUP] Staging directory files remaining: ${fs.readdirSync(STAGING_DIR).length}`);

  console.log('======================================================================');
  const passCount = testResults.filter(t => t.status === 'PASS').length;
  const notVerifiedCount = testResults.filter(t => t.status === 'NOT VERIFIED').length;
  const failCount = testResults.filter(t => t.status === 'FAIL').length;
  console.log(`TEST RESULTS: ${passCount} PASSED, ${notVerifiedCount} NOT VERIFIED, ${failCount} FAILED`);
  console.log('======================================================================');

  await stagingPool.end();
  await prodPool.end();

  // Lưu báo cáo JSON
  fs.writeFileSync(
    path.resolve(__dirname, 'staging_filesystem_test_report.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: { total: testResults.length, passed: passCount, not_verified: notVerifiedCount, failed: failCount },
      production_integrity: { records_match: prodRecordsMatch, files_match: prodFilesMatch },
      tests: testResults
    }, null, 2)
  );

  if (failCount > 0) process.exit(1);
}

runStagingTestSuite()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
  });
