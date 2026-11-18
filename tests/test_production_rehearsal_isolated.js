/**
 * SOTRANS HUB — PRODUCTION DEPLOYMENT REHEARSAL ISOLATED VERIFICATION
 * Database: sotrans_production_rehearsal
 * Port: 5432 (Local PostgreSQL)
 */

const { Pool } = require('../auth-service/node_modules/pg');

const REHEARSAL_DB = 'sotrans_production_rehearsal';
const PG_PORT = 5432;
const PG_HOST = '127.0.0.1';

async function runRehearsalVerification() {
  console.log('================================================================');
  console.log('SOTRANS HUB — PRODUCTION DEPLOYMENT REHEARSAL: ISOLATED DB TEST');
  console.log(`Target Database: ${REHEARSAL_DB} on ${PG_HOST}:${PG_PORT}`);
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

  // --- POOL 1: Admin pool for verifying roles and system catalogs ---
  const adminPool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: REHEARSAL_DB,
    user: 'hrbot',
    password: process.env.PG_PASSWORD || 'WVTd1BjqlizHbMcsro43PwQaO8meSAfL',
  });

  // --- POOL 2: Operational application pool (hr_app_user) ---
  const appPool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: REHEARSAL_DB,
    user: 'hr_app_user',
    password: 'RehearsalPass123!',
  });

  // --- POOL 3: BI Read-only pool (bi_readonly) ---
  const biPool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: REHEARSAL_DB,
    user: 'bi_readonly',
    password: 'BiReadOnlyPass123!',
  });

  try {
    // -------------------------------------------------------------
    // PART 1: ROLE SECURITY ATTRIBUTES & PRIVILEGES (ADMIN CHECK)
    // -------------------------------------------------------------
    console.log('--- 1. VERIFYING hr_app_user 8 SECURITY ATTRIBUTES & LEAST PRIVILEGE ---');
    const appRoleRes = await adminPool.query(`
      SELECT 
        rolname, rolsuper, rolinherit, rolcreaterole, 
        rolcreatedb, rolcanlogin, rolreplication, rolbypassrls 
      FROM pg_roles 
      WHERE rolname = 'hr_app_user';
    `);
    const appRole = appRoleRes.rows[0];
    assert(appRole && appRole.rolname === 'hr_app_user', 'hr_app_user exists in pg_roles');
    assert(appRole.rolsuper === false, 'hr_app_user is NOSUPERUSER (rolsuper = false)');
    assert(appRole.rolcreatedb === false, 'hr_app_user is NOCREATEDB (rolcreatedb = false)');
    assert(appRole.rolcreaterole === false, 'hr_app_user is NOCREATEROLE (rolcreaterole = false)');
    assert(appRole.rolinherit === false, 'hr_app_user is NOINHERIT (rolinherit = false)');
    assert(appRole.rolcanlogin === true, 'hr_app_user can LOGIN (rolcanlogin = true)');
    assert(appRole.rolreplication === false, 'hr_app_user is NOREPLICATION (rolreplication = false)');
    assert(appRole.rolbypassrls === false, 'hr_app_user is NOBYPASSRLS (rolbypassrls = false)');

    const appSchemaCreateRes = await adminPool.query(`
      SELECT has_schema_privilege('hr_app_user', 'public', 'CREATE') AS has_create;
    `);
    assert(appSchemaCreateRes.rows[0].has_create === false, 'hr_app_user has NO CREATE privilege on schema public (DDL blocked)');

    const appOwnershipRes = await adminPool.query(`
      SELECT count(*) AS owned_tables 
      FROM pg_tables 
      WHERE tableowner = 'hr_app_user';
    `);
    assert(parseInt(appOwnershipRes.rows[0].owned_tables, 10) === 0, 'hr_app_user owns 0 business tables (owned_tables = 0)');

    console.log('\n--- 2. VERIFYING bi_readonly 8 SECURITY ATTRIBUTES & LEAST PRIVILEGE ---');
    const biRoleRes = await adminPool.query(`
      SELECT 
        rolname, rolsuper, rolinherit, rolcreaterole, 
        rolcreatedb, rolcanlogin, rolreplication, rolbypassrls 
      FROM pg_roles 
      WHERE rolname = 'bi_readonly';
    `);
    const biRole = biRoleRes.rows[0];
    assert(biRole && biRole.rolname === 'bi_readonly', 'bi_readonly exists in pg_roles');
    assert(biRole.rolsuper === false, 'bi_readonly is NOSUPERUSER (rolsuper = false)');
    assert(biRole.rolcreatedb === false, 'bi_readonly is NOCREATEDB (rolcreatedb = false)');
    assert(biRole.rolcreaterole === false, 'bi_readonly is NOCREATEROLE (rolcreaterole = false)');
    assert(biRole.rolinherit === false, 'bi_readonly is NOINHERIT (rolinherit = false)');
    assert(biRole.rolcanlogin === true, 'bi_readonly can LOGIN (rolcanlogin = true)');
    assert(biRole.rolreplication === false, 'bi_readonly is NOREPLICATION (rolreplication = false)');
    assert(biRole.rolbypassrls === false, 'bi_readonly is NOBYPASSRLS (rolbypassrls = false)');

    const biColumnCountRes = await adminPool.query(`
      SELECT COUNT(*) AS total_granted_columns 
      FROM information_schema.column_privileges 
      WHERE grantee = 'bi_readonly';
    `);
    assert(parseInt(biColumnCountRes.rows[0].total_granted_columns, 10) === 38, 'bi_readonly has EXACTLY 38 granted columns across 6 tables');

    // -------------------------------------------------------------
    // PART 2: OPERATIONAL POOL FUNCTIONAL & SECURITY REHEARSAL
    // -------------------------------------------------------------
    console.log('\n--- 3. OPERATIONAL APPLICATION RUNTIME CAPABILITIES (hr_app_user) ---');
    
    // 3.1. Read operational users
    const userReadRes = await appPool.query(`
      SELECT user_id, username, password_hash, role, company_id, status 
      FROM public.users 
      WHERE username = 'rehearsal_admin';
    `);
    assert(userReadRes.rows.length === 1 && userReadRes.rows[0].role === 'ADMIN', 'hr_app_user can query user authentication details');

    // 3.2. Write audit log
    const auditInsertRes = await appPool.query(`
      INSERT INTO public.auth_audit_logs (actor_user_id, action) 
      VALUES ($1, 'REHEARSAL_TEST_ACTION') 
      RETURNING id;
    `, [userReadRes.rows[0].user_id]);
    assert(auditInsertRes.rows.length === 1, 'hr_app_user can write auth_audit_logs');

    // 3.3. Verify DDL is blocked
    let ddlBlocked = false;
    try {
      await appPool.query(`CREATE TABLE public.malicious_runtime_table (id serial);`);
    } catch (err) {
      ddlBlocked = true;
    }
    assert(ddlBlocked, 'hr_app_user CANNOT create tables (DDL blocked by REVOKE CREATE)');

    // 3.4. Verify TRUNCATE is blocked
    let truncateBlocked = false;
    try {
      await appPool.query(`TRUNCATE TABLE public.users;`);
    } catch (err) {
      truncateBlocked = true;
    }
    assert(truncateBlocked, 'hr_app_user CANNOT TRUNCATE business tables');

    // -------------------------------------------------------------
    // PART 3: BI READ-ONLY POOL FUNCTIONAL & LEAST PRIVILEGE REHEARSAL
    // -------------------------------------------------------------
    console.log('\n--- 4. BI READ-ONLY FUNCTIONALITY & PII ISOLATION (bi_readonly) ---');

    // 4.1. Legitimate 38-column queries
    const biDocRes = await biPool.query(`
      SELECT doc_version_id, status, effective_date, expiry_date, deleted_at, branch_scope, doc_type, category, parse_quality 
      FROM public.documents;
    `);
    assert(biDocRes.rows.length >= 0, 'bi_readonly can select 9 approved columns on public.documents');

    const biBatchRes = await biPool.query(`
      SELECT id, company_id, status, total_files, uploaded_by, created_at 
      FROM public.hr_intake_batches;
    `);
    assert(biBatchRes.rows.length >= 1, 'bi_readonly can select 6 approved columns on public.hr_intake_batches');

    const biStagingRes = await biPool.query(`
      SELECT id, batch_id, company_id, staging_status, suspected_duplicate, missing_fields, uncertain_fields, created_at, approved_at, reviewed_at 
      FROM public.hr_employee_staging;
    `);
    assert(biStagingRes.rows.length >= 1, 'bi_readonly can select 10 approved columns on public.hr_employee_staging');

    const biUserRes = await biPool.query(`
      SELECT user_id, role, company_id, status 
      FROM public.users;
    `);
    assert(biUserRes.rows.length >= 1, 'bi_readonly can select 4 approved columns on public.users');

    const biAuditRes = await biPool.query(`
      SELECT id, actor_user_id, action, created_at 
      FROM public.auth_audit_logs;
    `);
    assert(biAuditRes.rows.length >= 1, 'bi_readonly can select 4 approved columns on public.auth_audit_logs');

    const biChatRes = await biPool.query(`
      SELECT id, company_id, answerable, best_sim, at 
      FROM public.chat_log;
    `);
    assert(biChatRes.rows.length >= 1, 'bi_readonly can select 5 approved columns on public.chat_log');

    // 4.2. PII Isolation Check: Attempting to read PII MUST throw 42501 (permission denied)
    let piiPasswordBlocked = false;
    try {
      await biPool.query(`SELECT password_hash FROM public.users;`);
    } catch (err) {
      piiPasswordBlocked = err.code === '42501';
    }
    assert(piiPasswordBlocked, 'bi_readonly CANNOT read password_hash from users (42501 permission denied)');

    let piiCitizenIdBlocked = false;
    try {
      await biPool.query(`SELECT citizen_id, full_name, base_salary FROM public.hr_employee_staging;`);
    } catch (err) {
      piiCitizenIdBlocked = err.code === '42501';
    }
    assert(piiCitizenIdBlocked, 'bi_readonly CANNOT read citizen_id, full_name, base_salary from hr_employee_staging (42501)');

    let piiChatContentBlocked = false;
    try {
      await biPool.query(`SELECT question, reply FROM public.chat_log;`);
    } catch (err) {
      piiChatContentBlocked = err.code === '42501';
    }
    assert(piiChatContentBlocked, 'bi_readonly CANNOT read question, reply from chat_log (42501)');

    let companiesBlocked = false;
    try {
      await biPool.query(`SELECT * FROM public.companies;`);
    } catch (err) {
      companiesBlocked = err.code === '42501';
    }
    assert(companiesBlocked, 'bi_readonly CANNOT access companies table (42501)');

    let docRelBlocked = false;
    try {
      await biPool.query(`SELECT * FROM public.document_relationships;`);
    } catch (err) {
      docRelBlocked = err.code === '42501';
    }
    assert(docRelBlocked, 'bi_readonly CANNOT access document_relationships table (42501)');

    // 4.3. Write / DDL Blocked for bi_readonly
    let biWriteBlocked = false;
    try {
      await biPool.query(`INSERT INTO public.auth_audit_logs (actor_user_id, action) VALUES ('a0000000-0000-0000-0000-000000000001', 'HACK');`);
    } catch (err) {
      biWriteBlocked = true;
    }
    assert(biWriteBlocked, 'bi_readonly CANNOT write to auth_audit_logs (Write blocked)');

    let biDdlBlocked = false;
    try {
      await biPool.query(`DROP TABLE public.documents;`);
    } catch (err) {
      biDdlBlocked = true;
    }
    assert(biDdlBlocked, 'bi_readonly CANNOT execute DDL (Drop table blocked)');

    console.log('\n================================================================');
    console.log(`REHEARSAL RESULT: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('FATAL REHEARSAL ERROR:', error);
    process.exit(1);
  } finally {
    await adminPool.end();
    await appPool.end();
    await biPool.end();
  }
}

runRehearsalVerification();
