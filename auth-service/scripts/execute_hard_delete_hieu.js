const fs = require('fs');
const path = require('path');
const db = require('../db');

const TARGET = {
  name: 'NGUYỄN VĂN HIẾU',
  employee_code: 'SWC00032',
  id: '180c7240-5d74-47cc-87c2-200bf312802a',
  citizen_id: '060098011607',
  person_id: 'fdd31f9a-00eb-4dd3-8837-9318dc44f2a1',
  staging_ids: [
    'a5e48f94-5c6f-4e0c-82ef-c4e6611c9929',
    '98805931-5b8f-4c7f-92ef-9e84c6111676'
  ]
};

const FILES_TO_DELETE = [
  '/app/uploads/staging/40f47b28-43f0-4b31-b874-abce2abbd2ed_SWC00803.pdf',
  '/app/uploads/staging/ec702e6c-c6ef-4530-9e1b-df9251fb9e43_SWC00803.pdf'
];

async function execute() {
  const client = await db.getClient();
  const result = {
    started_at: new Date().toISOString(),
    target: TARGET,
    production_db: {},
    files: {},
    verification: {}
  };

  try {
    console.log('=== STARTING CONTROLLED TRANSACTION FOR HARD DELETE ===');
    await client.query('BEGIN');

    // 1. Check pre-counts
    const preEmp = (await client.query('SELECT count(*)::int as c FROM employees')).rows[0].c;
    const preProf = (await client.query('SELECT count(*)::int as c FROM hr_employee_profiles')).rows[0].c;
    const prePer = (await client.query('SELECT count(*)::int as c FROM hr_persons')).rows[0].c;
    const preStag = (await client.query('SELECT count(*)::int as c FROM hr_employee_staging')).rows[0].c;
    console.log(`Pre-counts: employees=${preEmp}, profiles=${preProf}, persons=${prePer}, staging=${preStag}`);

    // 2. hr_sync_tasks
    const delSync = await client.query(`
      DELETE FROM hr_sync_tasks 
      WHERE employee_id = $1 OR staging_id = ANY($2::uuid[])
      RETURNING id, target_system, status
    `, [TARGET.id, TARGET.staging_ids]);
    console.log(`Deleted hr_sync_tasks: ${delSync.rowCount} rows`);
    result.production_db.deleted_sync_tasks = delSync.rows;

    // 3. hr_employee_staging
    const delStag = await client.query(`
      DELETE FROM hr_employee_staging 
      WHERE id = ANY($1::uuid[]) OR citizen_id = $2 OR employee_code = $3
      RETURNING id, full_name, employee_code, citizen_id, staging_status
    `, [TARGET.staging_ids, TARGET.citizen_id, TARGET.employee_code]);
    console.log(`Deleted hr_employee_staging: ${delStag.rowCount} rows`);
    result.production_db.deleted_staging = delStag.rows;
    if (delStag.rowCount !== 2) {
      throw new Error(`Expected 2 staging rows to delete, got ${delStag.rowCount}. Aborting.`);
    }

    // 4. hr_employment_history
    const delHist = await client.query(`
      DELETE FROM hr_employment_history 
      WHERE employment_id = $1 OR person_id = $2
      RETURNING id, event_type
    `, [TARGET.id, TARGET.person_id]);
    console.log(`Deleted hr_employment_history: ${delHist.rowCount} rows`);
    result.production_db.deleted_history = delHist.rows;

    // 5. hr_employment_documents & compensation
    const delDocs = await client.query(`
      DELETE FROM hr_employment_documents 
      WHERE employment_id = $1 OR person_id = $2
      RETURNING id
    `, [TARGET.id, TARGET.person_id]);
    const delComp = await client.query(`
      DELETE FROM hr_employment_compensation 
      WHERE employment_id = $1
      RETURNING id
    `, [TARGET.id]);

    // 6. hr_employee_profiles
    const delProf = await client.query(`
      DELETE FROM hr_employee_profiles 
      WHERE employee_id = $1 OR citizen_id = $2 OR employment_id = $3
      RETURNING id, full_name, employee_id, citizen_id
    `, [TARGET.employee_code, TARGET.citizen_id, TARGET.id]);
    console.log(`Deleted hr_employee_profiles: ${delProf.rowCount} rows`);
    result.production_db.deleted_profiles = delProf.rows;
    if (delProf.rowCount !== 1) {
      throw new Error(`Expected 1 profile row to delete, got ${delProf.rowCount}. Aborting.`);
    }

    // 7. employees
    const delEmp = await client.query(`
      DELETE FROM employees 
      WHERE id = $1 OR employee_code = $2
      RETURNING id, employee_name, employee_code, citizen_id
    `, [TARGET.id, TARGET.employee_code]);
    console.log(`Deleted employees: ${delEmp.rowCount} rows`);
    result.production_db.deleted_employees = delEmp.rows;
    if (delEmp.rowCount !== 1) {
      throw new Error(`Expected 1 employee row to delete, got ${delEmp.rowCount}. Aborting.`);
    }

    // 8. hr_person_identity_documents
    const delIdDocs = await client.query(`
      DELETE FROM hr_person_identity_documents 
      WHERE person_id = $1
      RETURNING id, masked_number
    `, [TARGET.person_id]);
    console.log(`Deleted hr_person_identity_documents: ${delIdDocs.rowCount} rows`);
    result.production_db.deleted_identity_documents = delIdDocs.rows;

    // 9. hr_persons
    const delPer = await client.query(`
      DELETE FROM hr_persons 
      WHERE id = $1
      RETURNING id, full_name, normalized_name
    `, [TARGET.person_id]);
    console.log(`Deleted hr_persons: ${delPer.rowCount} rows`);
    result.production_db.deleted_persons = delPer.rows;
    if (delPer.rowCount !== 1) {
      throw new Error(`Expected 1 person row to delete, got ${delPer.rowCount}. Aborting.`);
    }

    // 10. Audit trail log
    const auditPayload = {
      action_type: 'AUTHORIZED_HARD_DELETE',
      target: TARGET,
      deleted_records: {
        employees: delEmp.rowCount,
        hr_persons: delPer.rowCount,
        hr_employee_profiles: delProf.rowCount,
        hr_person_identity_documents: delIdDocs.rowCount,
        hr_employment_history: delHist.rowCount,
        hr_employee_staging: delStag.rowCount,
        hr_sync_tasks: delSync.rowCount
      }
    };
    await client.query(`
      INSERT INTO auth_audit_logs (actor_username, action, status, metadata)
      VALUES ('superadmin', 'EMPLOYEE_HARD_DELETE', 'SUCCESS', $1::jsonb)
    `, [JSON.stringify(auditPayload)]);

    // 11. Assert total counts
    const postEmp = (await client.query('SELECT count(*)::int as c FROM employees')).rows[0].c;
    const postProf = (await client.query('SELECT count(*)::int as c FROM hr_employee_profiles')).rows[0].c;
    const postPer = (await client.query('SELECT count(*)::int as c FROM hr_persons')).rows[0].c;
    const postStag = (await client.query('SELECT count(*)::int as c FROM hr_employee_staging')).rows[0].c;

    if (preEmp - postEmp !== 1 || preProf - postProf !== 1 || prePer - postPer !== 1 || preStag - postStag !== 2) {
      throw new Error(`Delta assertion failed: emp=${preEmp - postEmp}, prof=${preProf - postProf}, per=${prePer - postPer}, stag=${preStag - postStag}. Rolling back.`);
    }

    // 12. Commit
    await client.query('COMMIT');
    console.log('[POSTGRES] Transaction successfully COMMITTED.');
    result.production_db.status = 'COMMITTED';

    // 13. Delete physical files
    console.log('\n--- DELETING PHYSICAL STAGING FILES ---');
    const deletedFiles = [];
    for (const f of FILES_TO_DELETE) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        deletedFiles.push(f);
        console.log(`[FILES] Deleted file: ${f}`);
      } else {
        console.warn(`[FILES] File not present: ${f}`);
      }
    }
    result.files.deleted = deletedFiles;

    // 14. Verification
    const vEmp = await db.query('SELECT count(*)::int as c FROM employees WHERE employee_name ILIKE $1 OR employee_code = $2', ['%Hiếu%', TARGET.employee_code]);
    const vProf = await db.query('SELECT count(*)::int as c FROM hr_employee_profiles WHERE full_name ILIKE $1 OR employee_id = $2', ['%Hiếu%', TARGET.employee_code]);
    const vPer = await db.query('SELECT count(*)::int as c FROM hr_persons WHERE full_name ILIKE $1', ['%Hiếu%']);
    const vStag = await db.query('SELECT count(*)::int as c FROM hr_employee_staging WHERE full_name ILIKE $1 OR employee_code = $2', ['%Hiếu%', TARGET.employee_code]);

    result.verification = {
      remaining_employees: vEmp.rows[0].c,
      remaining_profiles: vProf.rows[0].c,
      remaining_persons: vPer.rows[0].c,
      remaining_staging: vStag.rows[0].c,
      total_employees_in_db: postEmp,
      total_profiles_in_db: postProf,
      total_persons_in_db: postPer,
      total_staging_in_db: postStag
    };

    result.completed_at = new Date().toISOString();
    result.status = (result.verification.remaining_employees === 0 &&
                     result.verification.remaining_profiles === 0 &&
                     result.verification.remaining_persons === 0 &&
                     result.verification.remaining_staging === 0) ? 'SUCCESS' : 'FAILED';

    fs.writeFileSync('/app/uploads/backup_20261111_hieu/execution_result.json', JSON.stringify(result, null, 2), 'utf8');
    console.log('\n[SUCCESS] Hard delete execution finished successfully.');
    console.log(JSON.stringify(result.verification, null, 2));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n[ROLLBACK ERROR]:', err);
    result.status = 'ROLLED_BACK';
    result.error = err.message;
    fs.writeFileSync('/app/uploads/backup_20261111_hieu/execution_result.json', JSON.stringify(result, null, 2), 'utf8');
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

execute();
