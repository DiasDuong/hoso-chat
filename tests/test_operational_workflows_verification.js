/**
 * SOTRANS HUB — OPERATIONAL POOL FUNCTIONAL & LEAST PRIVILEGE WORKFLOW AUDIT
 * Database: sotrans_production_rehearsal (Port 5432)
 * Role: hr_app_user (Non-Superuser, Zero DDL, Least Privilege DML)
 */

const { Pool } = require('../auth-service/node_modules/pg');

async function testOperationalWorkflows() {
  console.log('================================================================');
  console.log('SOTRANS HUB — OPERATIONAL WORKFLOWS & GRANULAR DML VERIFICATION');
  console.log('Role: hr_app_user on database sotrans_production_rehearsal');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}: ${details}`);
      failed++;
    }
  }

  const appPool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database: 'sotrans_production_rehearsal',
    user: 'hr_app_user',
    password: 'RehearsalPass123!',
  });

  try {
    // -------------------------------------------------------------------------
    // 1. WORKFLOW: AUTHENTICATION & PASSWORD VERIFICATION
    // -------------------------------------------------------------------------
    console.log('--- 1. AUTHENTICATION & SESSION LIFECYCLE ---');
    const authRes = await appPool.query(`
      SELECT user_id, username, password_hash, role, company_id, status 
      FROM public.users 
      WHERE username = 'rehearsal_admin' AND status = 'ACTIVE';
    `);
    assert(authRes.rows.length === 1, 'Authentication lookup: retrieved user record and password_hash');
    const userId = authRes.rows[0].user_id;

    // Update last login
    const updateLoginRes = await appPool.query(`
      UPDATE public.users 
      SET last_login = NOW() 
      WHERE user_id = $1 
      RETURNING last_login;
    `, [userId]);
    assert(updateLoginRes.rows.length === 1, 'Session update: recorded last_login timestamp');

    // Verify DELETE is blocked on users (Users are soft-deleted, not removed)
    let userDeleteBlocked = false;
    try {
      await appPool.query(`DELETE FROM public.users WHERE user_id = $1;`, [userId]);
    } catch (err) {
      userDeleteBlocked = (err.code === '42501');
    }
    assert(userDeleteBlocked, 'Least Privilege: DELETE is strictly blocked on public.users (42501)');

    // -------------------------------------------------------------------------
    // 2. WORKFLOW: REFRESH TOKEN & OAUTH LIFECYCLE
    // -------------------------------------------------------------------------
    console.log('\n--- 2. TOKEN & NONCE LIFECYCLE ---');
    const testNonce = 'nonce_' + Date.now();
    await appPool.query(`
      INSERT INTO public.oauth_state_nonces (state_token, user_id, expires_at) 
      VALUES ($1, $2, NOW() + interval '10 minutes');
    `, [testNonce, userId]);
    assert(true, 'Token lifecycle: inserted OAuth state nonce');

    const nonceDeleteRes = await appPool.query(`
      DELETE FROM public.oauth_state_nonces WHERE state_token = $1;
    `, [testNonce]);
    assert(nonceDeleteRes.rowCount === 1, 'Token lifecycle: rotated and deleted used nonce');

    // -------------------------------------------------------------------------
    // 3. WORKFLOW: AUTH AUDIT LOGGING (APPEND-ONLY)
    // -------------------------------------------------------------------------
    console.log('\n--- 3. AUTH AUDIT TRAIL (STRICT APPEND-ONLY) ---');
    const auditInsert = await appPool.query(`
      INSERT INTO public.auth_audit_logs (actor_user_id, action, created_at) 
      VALUES ($1, 'LOGIN_SUCCESS', NOW()) 
      RETURNING id;
    `, [userId]);
    assert(auditInsert.rows.length === 1, 'Audit log: appended new security event');
    const logId = auditInsert.rows[0].id;

    // Verify UPDATE is blocked on audit logs
    let auditUpdateBlocked = false;
    try {
      await appPool.query(`UPDATE public.auth_audit_logs SET action = 'ALTERED' WHERE id = $1;`, [logId]);
    } catch (err) {
      auditUpdateBlocked = (err.code === '42501');
    }
    assert(auditUpdateBlocked, 'Least Privilege: UPDATE is blocked on auth_audit_logs (append-only, 42501)');

    // Verify DELETE is blocked on audit logs
    let auditDeleteBlocked = false;
    try {
      await appPool.query(`DELETE FROM public.auth_audit_logs WHERE id = $1;`, [logId]);
    } catch (err) {
      auditDeleteBlocked = (err.code === '42501');
    }
    assert(auditDeleteBlocked, 'Least Privilege: DELETE is blocked on auth_audit_logs (tamper-proof, 42501)');

    // -------------------------------------------------------------------------
    // 4. WORKFLOW: HR INTAKE BATCHES & EMPLOYEE STAGING
    // -------------------------------------------------------------------------
    console.log('\n--- 4. HR INTAKE & EMPLOYEE STAGING PIPELINE ---');
    const batchId = 'b0000000-0000-0000-0000-000000000099';
    await appPool.query(`
      INSERT INTO public.hr_intake_batches (id, company_id, status, total_files, uploaded_by, created_at) 
      VALUES ($1, 'STG_CORP', 'processing', 2, 'rehearsal_admin', NOW())
      ON CONFLICT (id) DO UPDATE SET status = 'processing';
    `, [batchId]);
    assert(true, 'HR Intake: created intake batch record');

    const stagingId = 'c0000000-0000-0000-0000-000000000099';
    await appPool.query(`
      INSERT INTO public.hr_employee_staging (
        id, batch_id, file_name, full_name, citizen_id, staging_status, uploaded_by, company_id, company_status, intake_mode
      ) VALUES (
        $1, $2, 'rehearsal_cv.pdf', 'Le Van C', '079987654321', 'pending_review', 'rehearsal_admin', 'STG_CORP', 'confirmed', 'new_profile'
      ) ON CONFLICT (id) DO UPDATE SET staging_status = 'pending_review';
    `, [stagingId, batchId]);
    assert(true, 'Employee Staging: ingested candidate staging record');

    // Approve staging record
    const stagingApprove = await appPool.query(`
      UPDATE public.hr_employee_staging 
      SET staging_status = 'approved', approved_at = NOW() 
      WHERE id = $1 
      RETURNING staging_status;
    `, [stagingId]);
    assert(stagingApprove.rows[0].staging_status === 'approved', 'Employee Staging: approved candidate record via hr_app_user');

    // -------------------------------------------------------------------------
    // 5. WORKFLOW: DOCUMENT MANAGEMENT & RAG CHUNKS LIFECYCLE
    // -------------------------------------------------------------------------
    console.log('\n--- 5. DOCUMENT MANAGEMENT & RAG LIFECYCLE ---');
    const docId = 'd0000000-0000-0000-0000-000000000099';
    await appPool.query(`
      INSERT INTO public.documents (
        doc_version_id, document_id, version, title, doc_type, category, status, effective_date, branch_scope, created_at
      ) VALUES (
        $1, 'DOC_TEST_001', 1, 'Quy định thử nghiệm luồng', 'QUY_DINH', 'HR_POLICY', 'draft', '2026-01-01', ARRAY['ALL'], NOW()
      ) ON CONFLICT (doc_version_id) DO UPDATE SET status = 'draft';
    `, [docId]);
    assert(true, 'Document Lifecycle: drafted new HR policy document');

    // Publish document
    const docPublish = await appPool.query(`
      UPDATE public.documents 
      SET status = 'active', effective_date = '2026-01-01', expiry_date = '2027-01-01' 
      WHERE doc_version_id = $1 
      RETURNING status;
    `, [docId]);
    assert(docPublish.rows[0].status === 'active', 'Document Lifecycle: published document to active state');

    // Insert chunks
    const chunkId = 'e0000000-0000-0000-0000-000000000099';
    await appPool.query(`
      INSERT INTO public.chunks (
        chunk_id, doc_version_id, seq, chunk_type, content
      ) VALUES (
        $1, $2, 0, 'text', 'Nội dung điều khoản quy định kiểm thử quyền hạn.'
      ) ON CONFLICT (chunk_id) DO NOTHING;
    `, [chunkId, docId]);
    assert(true, 'RAG Chunks: generated and stored document chunks');

    // Delete chunks on re-index
    const chunkDelete = await appPool.query(`DELETE FROM public.chunks WHERE chunk_id = $1;`, [chunkId]);
    assert(chunkDelete.rowCount === 1, 'RAG Chunks: deleted obsolete chunk for re-indexing');

    // Soft delete document
    const docArchive = await appPool.query(`
      UPDATE public.documents 
      SET deleted_at = NOW(), status = 'archived' 
      WHERE doc_version_id = $1 
      RETURNING status;
    `, [docId]);
    assert(docArchive.rows[0].status === 'archived', 'Document Lifecycle: archived document with deleted_at timestamp');

    // -------------------------------------------------------------------------
    // 6. WORKFLOW: CHAT & QUERY LOGGING (NO DELETE ALLOWED)
    // -------------------------------------------------------------------------
    console.log('\n--- 6. CHAT & RAG CONVERSATION LOGGING ---');
    const chatInsert = await appPool.query(`
      INSERT INTO public.chat_log (company_id, answerable, best_sim, question, reply, at) 
      VALUES ('STG_CORP', true, 0.94, 'Điều kiện nghỉ phép?', 'Nghỉ phép cần báo trước 3 ngày.', NOW())
      RETURNING id;
    `);
    assert(chatInsert.rows.length === 1, 'Chat Logging: recorded query and AI response');
    const chatId = chatInsert.rows[0].id;

    // Update feedback
    const chatUpdate = await appPool.query(`
      UPDATE public.chat_log 
      SET answerable = false 
      WHERE id = $1 
      RETURNING answerable;
    `, [chatId]);
    assert(chatUpdate.rows[0].answerable === false, 'Chat Logging: updated user feedback on answerability');

    // Verify DELETE is blocked on chat_log
    let chatDeleteBlocked = false;
    try {
      await appPool.query(`DELETE FROM public.chat_log WHERE id = $1;`, [chatId]);
    } catch (err) {
      chatDeleteBlocked = (err.code === '42501');
    }
    assert(chatDeleteBlocked, 'Least Privilege: DELETE is strictly blocked on chat_log (compliance preservation, 42501)');

    // -------------------------------------------------------------------------
    // 7. WORKFLOW: MASTER REFERENCE DATA (STRICT READ-ONLY)
    // -------------------------------------------------------------------------
    console.log('\n--- 7. MASTER CATALOGS & REFERENCE DATA (STRICT READ-ONLY) ---');
    const compRead = await appPool.query(`SELECT id, company_name FROM public.companies;`);
    assert(compRead.rows.length >= 1, 'Master Catalog: read companies directory');

    // Verify INSERT is blocked on companies
    let compInsertBlocked = false;
    try {
      await appPool.query(`INSERT INTO public.companies (id, company_code, company_name) VALUES ('HACK', 'HK', 'Malicious Corp');`);
    } catch (err) {
      compInsertBlocked = (err.code === '42501');
    }
    assert(compInsertBlocked, 'Least Privilege: INSERT is blocked on public.companies (catalog immutable by app, 42501)');

    // Clean up test records
    await appPool.query(`DELETE FROM public.hr_employee_staging WHERE id = $1;`, [stagingId]);
    await appPool.query(`DELETE FROM public.hr_intake_batches WHERE id = $1;`, [batchId]);
    await appPool.query(`DELETE FROM public.documents WHERE doc_version_id = $1;`, [docId]);

    console.log('\n================================================================');
    console.log(`OPERATIONAL WORKFLOW AUDIT RESULT: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('FATAL OPERATIONAL WORKFLOW ERROR:', err);
    process.exit(1);
  } finally {
    await appPool.end();
  }
}

testOperationalWorkflows();
