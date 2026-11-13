const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const TARGETS = {
  kim: {
    name: 'HOÀNG THIÊN KIM',
    employee_code: 'SWC00050',
    id: '50ee3d03-0bbc-46c6-b1f5-6a705f76b024',
    citizen_id: '079203998877',
    company_id: 'SWC',
    department: 'Phòng Kế toán Tài chính',
    position: 'Chuyên viên Kế toán'
  },
  mai: {
    name: 'TRẦN THỊ NGỌC MAI',
    employee_code: 'SWC00049',
    id: 'f7df07b9-ce73-49e7-9a1b-70f3e630f38e',
    citizen_id: '079199280544',
    company_id: 'SWC',
    department: 'Phòng Kế toán Tài chính',
    position: 'Chuyên viên Kế toán'
  }
};

const EMP_IDS = [TARGETS.kim.id, TARGETS.mai.id];
const EMP_CODES = [TARGETS.kim.employee_code, TARGETS.mai.employee_code];
const CITIZEN_IDS = [TARGETS.kim.citizen_id, TARGETS.mai.citizen_id];

async function runHardDelete() {
  const timestamp = '20261112';
  const backupDir = path.join('/app/uploads', `backup_${timestamp}_kim_mai`);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const client = await db.getClient();
  const report = {
    started_at: new Date().toISOString(),
    targets: TARGETS,
    backup: { items: {} },
    production_db: {},
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
      `SELECT * FROM hr_persons WHERE full_name ILIKE '%THIÊN KIM%' OR full_name ILIKE '%NGỌC MAI%'`
    );
    const personIds = perRes.rows.map(r => r.id);

    // 3. hr_person_identity_documents
    const idDocRes = await db.query(
      `SELECT * FROM hr_person_identity_documents WHERE person_id = ANY($1::uuid[])`,
      [personIds]
    );

    // 4. hr_employee_profiles
    const profRes = await db.query(
      `SELECT * FROM hr_employee_profiles WHERE employee_id = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR employment_id = ANY($3::uuid[])`,
      [EMP_CODES, CITIZEN_IDS, EMP_IDS]
    );

    // 5. hr_employee_staging
    const stagRes = await db.query(
      `SELECT * FROM hr_employee_staging WHERE employee_code = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR full_name ILIKE '%THIÊN KIM%' OR full_name ILIKE '%NGỌC MAI%'`,
      [EMP_CODES, CITIZEN_IDS]
    );

    const tablesToBackup = {
      'backup_employees.json': empRes.rows,
      'backup_hr_persons.json': perRes.rows,
      'backup_hr_person_identity_documents.json': idDocRes.rows,
      'backup_hr_employee_profiles.json': profRes.rows,
      'backup_hr_employee_staging.json': stagRes.rows
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
    console.log(`Pre-counts: employees=${preEmp}, profiles=${preProf}, persons=${prePer}`);

    // Step 1: hr_employee_profiles (if any)
    const delProf = await client.query(`
      DELETE FROM hr_employee_profiles 
      WHERE employee_id = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR employment_id = ANY($3::uuid[])
      RETURNING id, full_name, employee_id
    `, [EMP_CODES, CITIZEN_IDS, EMP_IDS]);
    console.log(`Deleted hr_employee_profiles: ${delProf.rowCount} rows`);
    report.production_db.deleted_profiles = delProf.rows;

    // Step 2: hr_employee_staging (if any)
    const delStag = await client.query(`
      DELETE FROM hr_employee_staging 
      WHERE citizen_id = ANY($1::text[]) OR employee_code = ANY($2::text[]) OR full_name ILIKE '%THIÊN KIM%' OR full_name ILIKE '%NGỌC MAI%'
      RETURNING id, full_name
    `, [CITIZEN_IDS, EMP_CODES]);
    console.log(`Deleted hr_employee_staging: ${delStag.rowCount} rows`);
    report.production_db.deleted_staging = delStag.rows;

    // Step 3: employees
    const delEmp = await client.query(`
      DELETE FROM employees 
      WHERE id = ANY($1::uuid[]) OR employee_code = ANY($2::text[])
      RETURNING id, employee_name, employee_code, citizen_id
    `, [EMP_IDS, EMP_CODES]);
    console.log(`Deleted employees: ${delEmp.rowCount} rows`);
    report.production_db.deleted_employees = delEmp.rows;

    if (delEmp.rowCount !== 2) {
      throw new Error(`Expected exactly 2 employees to delete, got ${delEmp.rowCount}. Rolling back.`);
    }

    // Step 4: hr_person_identity_documents
    let delIdDocsCount = 0;
    if (personIds.length > 0) {
      const delIdDocs = await client.query(`
        DELETE FROM hr_person_identity_documents 
        WHERE person_id = ANY($1::uuid[])
        RETURNING id
      `, [personIds]);
      delIdDocsCount = delIdDocs.rowCount;
      console.log(`Deleted hr_person_identity_documents: ${delIdDocs.rowCount} rows`);
      report.production_db.deleted_identity_documents = delIdDocs.rows;
    }

    // Step 5: hr_persons
    let delPerCount = 0;
    if (personIds.length > 0) {
      const delPer = await client.query(`
        DELETE FROM hr_persons 
        WHERE id = ANY($1::uuid[])
        RETURNING id, full_name
      `, [personIds]);
      delPerCount = delPer.rowCount;
      console.log(`Deleted hr_persons: ${delPer.rowCount} rows`);
      report.production_db.deleted_persons = delPer.rows;
    }

    // Audit log
    const auditPayload = {
      action_type: 'AUTHORIZED_HARD_DELETE',
      targets: TARGETS,
      deleted_records: {
        employees: delEmp.rowCount,
        hr_employee_profiles: delProf.rowCount,
        hr_employee_staging: delStag.rowCount,
        hr_persons: delPerCount,
        hr_person_identity_documents: delIdDocsCount
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
    console.log(`Post-counts: employees=${postEmp}, profiles=${postProf}, persons=${postPer}`);

    if (preEmp - postEmp !== 2) {
      throw new Error(`Employee delta assertion failed: preEmp=${preEmp}, postEmp=${postEmp}. Rolling back.`);
    }

    await client.query('COMMIT');
    console.log('\n[POSTGRES] Transaction COMMITTED successfully.');
    report.production_db.status = 'COMMITTED';

    // === PHASE 3: VERIFICATION ===
    console.log('\n=== [PHASE 3] VERIFICATION CHECKS ===');
    const vEmp = (await db.query(`SELECT count(*)::int as c FROM employees WHERE employee_code = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR employee_name ILIKE '%THIÊN KIM%' OR employee_name ILIKE '%NGỌC MAI%'`, [EMP_CODES, CITIZEN_IDS])).rows[0].c;
    const vProf = (await db.query(`SELECT count(*)::int as c FROM hr_employee_profiles WHERE employee_id = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR full_name ILIKE '%THIÊN KIM%' OR full_name ILIKE '%NGỌC MAI%'`, [EMP_CODES, CITIZEN_IDS])).rows[0].c;
    const vPer = (await db.query(`SELECT count(*)::int as c FROM hr_persons WHERE full_name ILIKE '%THIÊN KIM%' OR full_name ILIKE '%NGỌC MAI%'`)).rows[0].c;
    const vStag = (await db.query(`SELECT count(*)::int as c FROM hr_employee_staging WHERE employee_code = ANY($1::text[]) OR citizen_id = ANY($2::text[]) OR full_name ILIKE '%THIÊN KIM%' OR full_name ILIKE '%NGỌC MAI%'`, [EMP_CODES, CITIZEN_IDS])).rows[0].c;

    report.verification = {
      remaining_employees: vEmp,
      remaining_profiles: vProf,
      remaining_persons: vPer,
      remaining_staging: vStag,
      total_employees_in_db: postEmp,
      total_profiles_in_db: postProf,
      total_persons_in_db: postPer
    };

    const isAllClean = vEmp === 0 && vProf === 0 && vPer === 0 && vStag === 0;
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
