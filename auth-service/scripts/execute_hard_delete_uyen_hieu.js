const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const TARGETS = {
  uyen: {
    name: 'NGÔ ĐẶNG TUẤN UYÊN',
    employee_code: 'SWC00037',
    id: 'e861b850-79ae-413c-9ea8-62a59e93cb0d',
    citizen_id: '062095000277',
    person_id: 'c290f3d1-18a3-4866-8038-835e6b538c73',
    profile_id: 377
  },
  hieu: {
    name: 'NGUYỄN VĂN HIẾU',
    employee_code: 'SWC00047',
    id: 'd2e311c3-9711-4361-b448-36853a8e9243',
    citizen_id: '060098011607',
    person_id: '850b7ce2-56fd-4c3c-be9d-b4c4cbdbad8e',
    profile_id: 518
  }
};

const EMP_IDS = [TARGETS.uyen.id, TARGETS.hieu.id];
const EMP_CODES = [TARGETS.uyen.employee_code, TARGETS.hieu.employee_code];
const PERSON_IDS = [TARGETS.uyen.person_id, TARGETS.hieu.person_id];
const CITIZEN_IDS = [TARGETS.uyen.citizen_id, TARGETS.hieu.citizen_id];

async function runHardDelete() {
  const timestamp = '20261112';
  const backupDir = path.join('/app/uploads', `backup_${timestamp}_uyen_hieu`);
  const filesBackupDir = path.join(backupDir, 'files');

  for (const dir of [backupDir, filesBackupDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const client = await db.getClient();
  const report = {
    started_at: new Date().toISOString(),
    targets: TARGETS,
    backup: { items: {}, files: {} },
    production_db: {},
    staging_db_cleanup: {},
    files_cleanup: {},
    verification: {}
  };

  try {
    console.log('=== [PHASE 1] COLLECTING DATA & EXECUTING PRE-DELETION BACKUP ===\n');

    // 1. Employees
    const empRes = await db.query(
      `SELECT * FROM employees WHERE id = ANY($1::uuid[]) OR employee_code = ANY($2::text[])`,
      [EMP_IDS, EMP_CODES]
    );
    // 2. hr_persons
    const perRes = await db.query(
      `SELECT * FROM hr_persons WHERE id = ANY($1::uuid[])`,
      [PERSON_IDS]
    );
    // 3. hr_person_identity_documents
    const idDocRes = await db.query(
      `SELECT * FROM hr_person_identity_documents WHERE person_id = ANY($1::uuid[])`,
      [PERSON_IDS]
    );
    // 4. hr_employee_profiles
    const profRes = await db.query(
      `SELECT * FROM hr_employee_profiles 
       WHERE employee_id = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR employment_id = ANY($3::uuid[])`,
      [EMP_CODES, CITIZEN_IDS, EMP_IDS]
    );
    // 5. hr_employee_staging
    const stagRes = await db.query(
      `SELECT * FROM hr_employee_staging 
       WHERE employee_code = ANY($1::text[]) 
          OR target_employee_code = ANY($1::text[]) 
          OR citizen_id = ANY($2::text[]) 
          OR full_name ILIKE '%UYÊN%' 
          OR full_name ILIKE '%HIẾU%'`,
      [EMP_CODES, CITIZEN_IDS]
    );
    const stagIds = stagRes.rows.map(r => r.id);

    // 6. hr_employment_history
    const histRes = await db.query(
      `SELECT * FROM hr_employment_history WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])`,
      [EMP_IDS, PERSON_IDS]
    );
    // 7. hr_employment_documents
    const empDocRes = await db.query(
      `SELECT * FROM hr_employment_documents WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])`,
      [EMP_IDS, PERSON_IDS]
    );
    // 8. hr_sync_tasks
    const syncRes = await db.query(
      `SELECT * FROM hr_sync_tasks WHERE employee_id = ANY($1::uuid[]) OR staging_id = ANY($2::uuid[])`,
      [EMP_IDS, stagIds]
    );

    const tablesToBackup = {
      'backup_employees.json': empRes.rows,
      'backup_hr_persons.json': perRes.rows,
      'backup_hr_person_identity_documents.json': idDocRes.rows,
      'backup_hr_employee_profiles.json': profRes.rows,
      'backup_hr_employee_staging.json': stagRes.rows,
      'backup_hr_employment_history.json': histRes.rows,
      'backup_hr_employment_documents.json': empDocRes.rows,
      'backup_hr_sync_tasks.json': syncRes.rows
    };

    for (const [filename, rows] of Object.entries(tablesToBackup)) {
      const jsonStr = JSON.stringify(rows, null, 2);
      fs.writeFileSync(path.join(backupDir, filename), jsonStr, 'utf8');
      report.backup.items[filename] = {
        records: rows.length,
        bytes: Buffer.byteLength(jsonStr),
        sha256: sha256Buffer(Buffer.from(jsonStr))
      };
      console.log(`[BACKUP] Saved ${filename}: ${rows.length} records`);
    }

    // Physical files backup
    const filesToLocate = new Set();
    const searchDirs = [
      '/app/uploads/staging',
      '/app/chat-files/staging',
      '/app/uploads',
      '/app/chat-files'
    ];

    for (const s of stagRes.rows) {
      if (s.file_name) filesToLocate.add(s.file_name);
      if (s.file_storage_path) filesToLocate.add(path.basename(s.file_storage_path));
    }
    for (const ed of empDocRes.rows) {
      if (ed.file_name) filesToLocate.add(ed.file_name);
      if (ed.file_storage_path) filesToLocate.add(path.basename(ed.file_storage_path));
    }

    // Also collect all files containing SWC00808 and SWC00803
    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          if (file.includes('SWC00808') || file.includes('SWC00803')) {
            filesToLocate.add(file);
          }
        }
      }
    }

    for (const filename of filesToLocate) {
      for (const dir of searchDirs) {
        const fullPath = path.join(dir, filename);
        if (fs.existsSync(fullPath)) {
          const destPath = path.join(filesBackupDir, filename);
          fs.copyFileSync(fullPath, destPath);
          const buf = fs.readFileSync(destPath);
          report.backup.files[filename] = {
            source_path: fullPath,
            size: buf.length,
            sha256: sha256Buffer(buf)
          };
          console.log(`[BACKUP FILE] Copied ${fullPath} -> ${destPath} (${buf.length} bytes)`);
          break;
        }
      }
    }

    const manifestJson = JSON.stringify(report.backup, null, 2);
    fs.writeFileSync(path.join(backupDir, 'backup_manifest.json'), manifestJson, 'utf8');
    console.log('\n[BACKUP] Manifest successfully written.\n');

    // === PHASE 2: TRANSACTIONAL DATABASE HARD DELETE ===
    console.log('=== [PHASE 2] STARTING TRANSACTION FOR HARD DELETE (HRBOT PRODUCTION) ===');
    await client.query('BEGIN');

    // Pre-counts
    const preEmp = (await client.query('SELECT count(*)::int as c FROM employees')).rows[0].c;
    const preProf = (await client.query('SELECT count(*)::int as c FROM hr_employee_profiles')).rows[0].c;
    const prePer = (await client.query('SELECT count(*)::int as c FROM hr_persons')).rows[0].c;
    const preIdDoc = (await client.query('SELECT count(*)::int as c FROM hr_person_identity_documents')).rows[0].c;
    const preStag = (await client.query('SELECT count(*)::int as c FROM hr_employee_staging')).rows[0].c;
    const preHist = (await client.query('SELECT count(*)::int as c FROM hr_employment_history')).rows[0].c;
    const preDocs = (await client.query('SELECT count(*)::int as c FROM hr_employment_documents')).rows[0].c;
    const preSync = (await client.query('SELECT count(*)::int as c FROM hr_sync_tasks')).rows[0].c;

    console.log(`Pre-counts: employees=${preEmp}, profiles=${preProf}, persons=${prePer}, id_docs=${preIdDoc}, staging=${preStag}, history=${preHist}, emp_docs=${preDocs}, sync_tasks=${preSync}`);

    // Step 1: hr_sync_tasks
    const delSync = await client.query(`
      DELETE FROM hr_sync_tasks 
      WHERE employee_id = ANY($1::uuid[]) 
         OR staging_id IN (
           SELECT id FROM hr_employee_staging 
           WHERE citizen_id = ANY($2::text[]) OR employee_code = ANY($3::text[]) OR target_employee_code = ANY($3::text[])
         )
      RETURNING id, target_system, status
    `, [EMP_IDS, CITIZEN_IDS, EMP_CODES]);
    console.log(`Deleted hr_sync_tasks: ${delSync.rowCount} rows`);
    report.production_db.deleted_sync_tasks = delSync.rows;

    // Step 2: hr_employee_staging
    const delStag = await client.query(`
      DELETE FROM hr_employee_staging 
      WHERE citizen_id = ANY($1::text[]) 
         OR employee_code = ANY($2::text[]) 
         OR target_employee_code = ANY($2::text[])
         OR full_name ILIKE '%UYÊN%' 
         OR full_name ILIKE '%HIẾU%'
      RETURNING id, full_name, employee_code, citizen_id, staging_status
    `, [CITIZEN_IDS, EMP_CODES]);
    console.log(`Deleted hr_employee_staging: ${delStag.rowCount} rows`);
    report.production_db.deleted_staging = delStag.rows;

    // Step 3: hr_employment_documents
    const delDocs = await client.query(`
      DELETE FROM hr_employment_documents 
      WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])
      RETURNING id, file_name
    `, [EMP_IDS, PERSON_IDS]);
    console.log(`Deleted hr_employment_documents: ${delDocs.rowCount} rows`);
    report.production_db.deleted_employment_documents = delDocs.rows;

    // Step 4: hr_employment_compensation
    const delComp = await client.query(`
      DELETE FROM hr_employment_compensation 
      WHERE employment_id = ANY($1::uuid[])
      RETURNING id
    `, [EMP_IDS]);
    console.log(`Deleted hr_employment_compensation: ${delComp.rowCount} rows`);
    report.production_db.deleted_compensation = delComp.rows;

    // Step 5: hr_employment_history
    const delHist = await client.query(`
      DELETE FROM hr_employment_history 
      WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])
      RETURNING id, event_type
    `, [EMP_IDS, PERSON_IDS]);
    console.log(`Deleted hr_employment_history: ${delHist.rowCount} rows`);
    report.production_db.deleted_history = delHist.rows;

    // Step 6: hr_employee_profiles
    const delProf = await client.query(`
      DELETE FROM hr_employee_profiles 
      WHERE employee_id = ANY($1::text[]) 
         OR citizen_id = ANY($2::text[]) 
         OR employment_id = ANY($3::uuid[])
         OR full_name ILIKE '%UYÊN%' 
         OR full_name ILIKE '%HIẾU%'
      RETURNING id, full_name, employee_id, citizen_id
    `, [EMP_CODES, CITIZEN_IDS, EMP_IDS]);
    console.log(`Deleted hr_employee_profiles: ${delProf.rowCount} rows`);
    report.production_db.deleted_profiles = delProf.rows;

    // Step 7: users (if linked)
    const delUsers = await client.query(`
      DELETE FROM users 
      WHERE employee_id = ANY($1::uuid[]) OR username = ANY($2::text[])
      RETURNING user_id, username
    `, [EMP_IDS, EMP_CODES]);
    console.log(`Deleted users: ${delUsers.rowCount} rows`);
    report.production_db.deleted_users = delUsers.rows;

    // Step 8: employees
    const delEmp = await client.query(`
      DELETE FROM employees 
      WHERE id = ANY($1::uuid[]) 
         OR employee_code = ANY($2::text[])
         OR citizen_id = ANY($3::text[])
         OR employee_name ILIKE '%UYÊN%' 
         OR employee_name ILIKE '%HIẾU%'
      RETURNING id, employee_name, employee_code, citizen_id
    `, [EMP_IDS, EMP_CODES, CITIZEN_IDS]);
    console.log(`Deleted employees: ${delEmp.rowCount} rows`);
    report.production_db.deleted_employees = delEmp.rows;

    // Step 9: hr_person_identity_documents
    const delIdDocs = await client.query(`
      DELETE FROM hr_person_identity_documents 
      WHERE person_id = ANY($1::uuid[])
      RETURNING id, masked_number
    `, [PERSON_IDS]);
    console.log(`Deleted hr_person_identity_documents: ${delIdDocs.rowCount} rows`);
    report.production_db.deleted_identity_documents = delIdDocs.rows;

    // Step 10: hr_persons
    const delPer = await client.query(`
      DELETE FROM hr_persons 
      WHERE id = ANY($1::uuid[]) 
         OR full_name ILIKE '%UYÊN%' 
         OR full_name ILIKE '%HIẾU%'
      RETURNING id, full_name, normalized_name
    `, [PERSON_IDS]);
    console.log(`Deleted hr_persons: ${delPer.rowCount} rows`);
    report.production_db.deleted_persons = delPer.rows;

    // Audit log
    const auditPayload = {
      action_type: 'AUTHORIZED_HARD_DELETE',
      targets: TARGETS,
      deleted_records: {
        employees: delEmp.rowCount,
        hr_persons: delPer.rowCount,
        hr_employee_profiles: delProf.rowCount,
        hr_person_identity_documents: delIdDocs.rowCount,
        hr_employment_documents: delDocs.rowCount,
        hr_employment_compensation: delComp.rowCount,
        hr_employment_history: delHist.rowCount,
        hr_employee_staging: delStag.rowCount,
        hr_sync_tasks: delSync.rowCount,
        users: delUsers.rowCount
      }
    };
    await client.query(`
      INSERT INTO auth_audit_logs (actor_username, action, status, metadata)
      VALUES ('superadmin', 'EMPLOYEE_HARD_DELETE', 'SUCCESS', $1::jsonb)
    `, [JSON.stringify(auditPayload)]);

    // Post-counts check
    const postEmp = (await client.query('SELECT count(*)::int as c FROM employees')).rows[0].c;
    const postProf = (await client.query('SELECT count(*)::int as c FROM hr_employee_profiles')).rows[0].c;
    const postPer = (await client.query('SELECT count(*)::int as c FROM hr_persons')).rows[0].c;
    const postIdDoc = (await client.query('SELECT count(*)::int as c FROM hr_person_identity_documents')).rows[0].c;
    const postStag = (await client.query('SELECT count(*)::int as c FROM hr_employee_staging')).rows[0].c;
    const postHist = (await client.query('SELECT count(*)::int as c FROM hr_employment_history')).rows[0].c;
    const postDocs = (await client.query('SELECT count(*)::int as c FROM hr_employment_documents')).rows[0].c;
    const postSync = (await client.query('SELECT count(*)::int as c FROM hr_sync_tasks')).rows[0].c;

    console.log(`Post-counts: employees=${postEmp}, profiles=${postProf}, persons=${postPer}, id_docs=${postIdDoc}, staging=${postStag}, history=${postHist}, emp_docs=${postDocs}, sync_tasks=${postSync}`);

    // Assert exact 2 primary rows deleted
    if (delEmp.rowCount !== 2 || delProf.rowCount !== 2 || delPer.rowCount !== 2 || delIdDocs.rowCount !== 2) {
      throw new Error(`Primary record deletion delta mismatch: employees=${delEmp.rowCount}, profiles=${delProf.rowCount}, persons=${delPer.rowCount}, id_docs=${delIdDocs.rowCount}. Rolling back.`);
    }

    await client.query('COMMIT');
    console.log('\n[POSTGRES] Transaction COMMITTED successfully.');
    report.production_db.status = 'COMMITTED';

    // === PHASE 3: CLEANUP TEST / STAGING DATABASES ===
    console.log('\n=== [PHASE 3] CLEANING TEST/STAGING DATABASES ===');
    try {
      const { Pool } = require('pg');
      const stagingPool = new Pool({
        host: process.env.PG_HOST || 'postgres',
        port: process.env.PG_PORT || 5432,
        user: process.env.PG_USER || 'hrbot',
        password: process.env.PG_PASSWORD || 'hrchatbot',
        database: 'hrbot_staging'
      });
      const delStagingEmp = await stagingPool.query(`
        DELETE FROM employees WHERE citizen_id = ANY($1::text[]) OR employee_name ILIKE '%UYÊN%' OR employee_name ILIKE '%HIẾU%' RETURNING id, employee_code, employee_name
      `, [CITIZEN_IDS]);
      console.log(`[hrbot_staging] Deleted ${delStagingEmp.rowCount} employees`);
      report.staging_db_cleanup.hrbot_staging = delStagingEmp.rows;
      await stagingPool.end();

      const testPool = new Pool({
        host: process.env.PG_HOST || 'postgres',
        port: process.env.PG_PORT || 5432,
        user: process.env.PG_USER || 'hrbot',
        password: process.env.PG_PASSWORD || 'hrchatbot',
        database: 'hrbot_test'
      });
      const delTestEmp = await testPool.query(`
        DELETE FROM employees WHERE citizen_id = ANY($1::text[]) OR employee_name ILIKE '%UYÊN%' OR employee_name ILIKE '%HIẾU%' RETURNING id, employee_code, employee_name
      `, [CITIZEN_IDS]);
      console.log(`[hrbot_test] Deleted ${delTestEmp.rowCount} employees`);
      report.staging_db_cleanup.hrbot_test = delTestEmp.rows;
      await testPool.end();
    } catch (dbErr) {
      console.warn('[WARN] Secondary db cleanup warning:', dbErr.message);
      report.staging_db_cleanup.warning = dbErr.message;
    }

    // === PHASE 4: PHYSICAL FILES CLEANUP ===
    console.log('\n=== [PHASE 4] DELETING PHYSICAL STAGING FILES ===');
    const deletedFiles = [];
    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          if (file.includes('SWC00808') || file.includes('SWC00803')) {
            const filePath = path.join(dir, file);
            try {
              fs.unlinkSync(filePath);
              deletedFiles.push(filePath);
              console.log(`[FILES] Deleted: ${filePath}`);
            } catch (fErr) {
              console.warn(`[FILES] Failed to delete ${filePath}:`, fErr.message);
            }
          }
        }
      }
    }
    report.files_cleanup.deleted = deletedFiles;

    // === PHASE 5: VERIFICATION ===
    console.log('\n=== [PHASE 5] VERIFICATION CHECKS ===');
    const vEmp = (await db.query(`SELECT count(*)::int as c FROM employees WHERE employee_code = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR employee_name ILIKE '%UYÊN%' OR employee_name ILIKE '%HIẾU%'`, [EMP_CODES, CITIZEN_IDS])).rows[0].c;
    const vProf = (await db.query(`SELECT count(*)::int as c FROM hr_employee_profiles WHERE employee_id = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR full_name ILIKE '%UYÊN%' OR full_name ILIKE '%HIẾU%'`, [EMP_CODES, CITIZEN_IDS])).rows[0].c;
    const vPer = (await db.query(`SELECT count(*)::int as c FROM hr_persons WHERE id = ANY($1::uuid[]) OR full_name ILIKE '%UYÊN%' OR full_name ILIKE '%HIẾU%'`, [PERSON_IDS])).rows[0].c;
    const vIdDoc = (await db.query(`SELECT count(*)::int as c FROM hr_person_identity_documents WHERE person_id = ANY($1::uuid[])`, [PERSON_IDS])).rows[0].c;
    const vStag = (await db.query(`SELECT count(*)::int as c FROM hr_employee_staging WHERE employee_code = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR full_name ILIKE '%UYÊN%' OR full_name ILIKE '%HIẾU%'`, [EMP_CODES, CITIZEN_IDS])).rows[0].c;
    const vDocs = (await db.query(`SELECT count(*)::int as c FROM hr_employment_documents WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])`, [EMP_IDS, PERSON_IDS])).rows[0].c;
    const vHist = (await db.query(`SELECT count(*)::int as c FROM hr_employment_history WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])`, [EMP_IDS, PERSON_IDS])).rows[0].c;
    const vSync = (await db.query(`SELECT count(*)::int as c FROM hr_sync_tasks WHERE employee_id = ANY($1::uuid[])`, [EMP_IDS])).rows[0].c;

    report.verification = {
      remaining_employees: vEmp,
      remaining_profiles: vProf,
      remaining_persons: vPer,
      remaining_identity_documents: vIdDoc,
      remaining_staging: vStag,
      remaining_employment_documents: vDocs,
      remaining_employment_history: vHist,
      remaining_sync_tasks: vSync,
      total_employees_in_db: postEmp,
      total_profiles_in_db: postProf,
      total_persons_in_db: postPer
    };

    const isAllClean = Object.entries(report.verification)
      .filter(([k]) => k.startsWith('remaining_'))
      .every(([, v]) => v === 0);

    report.completed_at = new Date().toISOString();
    report.status = isAllClean ? 'SUCCESS' : 'FAILED';

    const resultPath = path.join(backupDir, 'execution_result.json');
    fs.writeFileSync(resultPath, JSON.stringify(report, null, 2), 'utf8');

    console.log('\n[SUMMARY RESULT]:');
    console.log(JSON.stringify(report.verification, null, 2));
    console.log(`Status: ${report.status}`);
    console.log(`Execution report saved to: ${resultPath}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n[ROLLBACK TRIGGERED DUE TO ERROR]:', err);
    report.status = 'ROLLED_BACK';
    report.error = err.message;
    fs.writeFileSync(path.join(backupDir, 'execution_result.json'), JSON.stringify(report, null, 2), 'utf8');
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

runHardDelete();
