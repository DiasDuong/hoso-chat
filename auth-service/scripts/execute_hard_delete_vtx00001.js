const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const TARGET = {
  name: 'NGUYỄN VĂN CHƯA CÓ PDF',
  employee_code: 'VTX00001',
  id: '634e9840-9deb-42c3-85c3-150a872a5b6c',
  company_id: 'VTX',
  department: 'Kế toán',
  position: 'Chuyên viên'
};

async function execute() {
  const backupDir = '/app/uploads/backup_20261111_vtx00001';
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const client = await db.getClient();
  const report = {
    started_at: new Date().toISOString(),
    target: TARGET,
    backup: {},
    production_db: {},
    verification: {}
  };

  try {
    console.log('=== STARTING BACKUP & HARD DELETE FOR VTX00001 ===');

    // 1. BACKUP
    const empRes = await db.query(`SELECT * FROM employees WHERE id = $1 OR employee_code = $2`, [TARGET.id, TARGET.employee_code]);
    const empJson = JSON.stringify(empRes.rows, null, 2);
    fs.writeFileSync(path.join(backupDir, 'backup_employees.json'), empJson, 'utf8');
    report.backup['backup_employees.json'] = {
      records: empRes.rows.length,
      sha256: sha256Buffer(Buffer.from(empJson))
    };

    const profRes = await db.query(`SELECT * FROM hr_employee_profiles WHERE employee_id = $1 OR employment_id = $2`, [TARGET.employee_code, TARGET.id]);
    const profJson = JSON.stringify(profRes.rows, null, 2);
    fs.writeFileSync(path.join(backupDir, 'backup_hr_employee_profiles.json'), profJson, 'utf8');
    report.backup['backup_hr_employee_profiles.json'] = {
      records: profRes.rows.length,
      sha256: sha256Buffer(Buffer.from(profJson))
    };

    fs.writeFileSync(path.join(backupDir, 'backup_manifest.json'), JSON.stringify(report.backup, null, 2), 'utf8');
    console.log('[BACKUP] Backup completed successfully.');

    // 2. TRANSACTION DELETE
    await client.query('BEGIN');

    const preEmp = (await client.query('SELECT count(*)::int as c FROM employees')).rows[0].c;
    const preProf = (await client.query('SELECT count(*)::int as c FROM hr_employee_profiles')).rows[0].c;
    console.log(`Pre-counts: employees=${preEmp}, profiles=${preProf}`);

    // Delete hr_employee_profiles
    const delProf = await client.query(`
      DELETE FROM hr_employee_profiles 
      WHERE employee_id = $1 OR employment_id = $2
      RETURNING id, full_name, employee_id
    `, [TARGET.employee_code, TARGET.id]);
    console.log(`Deleted hr_employee_profiles: ${delProf.rowCount} rows`);
    report.production_db.deleted_profiles = delProf.rows;
    if (delProf.rowCount !== 1) {
      throw new Error(`Expected exactly 1 profile to delete, got ${delProf.rowCount}`);
    }

    // Delete employees
    const delEmp = await client.query(`
      DELETE FROM employees 
      WHERE id = $1 OR employee_code = $2
      RETURNING id, employee_name, employee_code
    `, [TARGET.id, TARGET.employee_code]);
    console.log(`Deleted employees: ${delEmp.rowCount} rows`);
    report.production_db.deleted_employees = delEmp.rows;
    if (delEmp.rowCount !== 1) {
      throw new Error(`Expected exactly 1 employee to delete, got ${delEmp.rowCount}`);
    }

    // Audit log
    const auditPayload = {
      action_type: 'AUTHORIZED_HARD_DELETE',
      target: TARGET,
      deleted_records: {
        employees: delEmp.rowCount,
        hr_employee_profiles: delProf.rowCount
      }
    };
    await client.query(`
      INSERT INTO auth_audit_logs (actor_username, action, status, metadata)
      VALUES ('superadmin', 'EMPLOYEE_HARD_DELETE', 'SUCCESS', $1::jsonb)
    `, [JSON.stringify(auditPayload)]);

    const postEmp = (await client.query('SELECT count(*)::int as c FROM employees')).rows[0].c;
    const postProf = (await client.query('SELECT count(*)::int as c FROM hr_employee_profiles')).rows[0].c;

    if (preEmp - postEmp !== 1 || preProf - postProf !== 1) {
      throw new Error(`Count delta assertion failed. preEmp=${preEmp}, postEmp=${postEmp}, preProf=${preProf}, postProf=${postProf}`);
    }

    await client.query('COMMIT');
    console.log('[POSTGRES] Transaction COMMITTED successfully.');
    report.production_db.status = 'COMMITTED';

    // 3. Verification
    const vEmp = await db.query('SELECT count(*)::int as c FROM employees WHERE employee_name ILIKE $1 OR employee_code = $2', ['%CHƯA CÓ PDF%', TARGET.employee_code]);
    const vProf = await db.query('SELECT count(*)::int as c FROM hr_employee_profiles WHERE full_name ILIKE $1 OR employee_id = $2', ['%CHƯA CÓ PDF%', TARGET.employee_code]);

    report.verification = {
      remaining_target_employees: vEmp.rows[0].c,
      remaining_target_profiles: vProf.rows[0].c,
      total_employees_in_db: postEmp,
      total_profiles_in_db: postProf
    };

    report.completed_at = new Date().toISOString();
    report.status = (vEmp.rows[0].c === 0 && vProf.rows[0].c === 0) ? 'SUCCESS' : 'FAILED';

    fs.writeFileSync(path.join(backupDir, 'execution_result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('[SUCCESS] DB execution finished:', JSON.stringify(report.verification, null, 2));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ROLLBACK ERROR]:', err);
    report.status = 'ROLLED_BACK';
    report.error = err.message;
    fs.writeFileSync(path.join(backupDir, 'execution_result.json'), JSON.stringify(report, null, 2), 'utf8');
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

execute();
