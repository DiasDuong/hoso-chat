const db = require('../db');
const fs = require('fs');
const path = require('path');

async function inspectHieu() {
  console.log('=== INSPECTION FOR NGUYEN VAN HIEU ===\n');

  // 1. Employees table
  const empRes = await db.query(`SELECT * FROM employees WHERE employee_name ILIKE '%Hiếu%' OR employee_code = 'SWC00032'`);
  console.log('1. employees table count:', empRes.rows.length);
  console.log(JSON.stringify(empRes.rows, null, 2));

  // 2. hr_persons table
  const perRes = await db.query(`SELECT * FROM hr_persons WHERE full_name ILIKE '%Hiếu%' OR normalized_name ILIKE '%HIEU%'`);
  console.log('\n2. hr_persons table count:', perRes.rows.length);
  console.log(JSON.stringify(perRes.rows, null, 2));

  // 3. hr_person_identity_documents
  const idDocRes = await db.query(`SELECT id, person_id, doc_type, masked_number, doc_number_hmac, issue_date, lifecycle_status, verification_status FROM hr_person_identity_documents`);
  console.log('\n3. hr_person_identity_documents table total count:', idDocRes.rows.length);
  const matchedIdDocs = idDocRes.rows.filter(d => perRes.rows.some(p => p.id === d.person_id));
  console.log('   matched to person count:', matchedIdDocs.length);
  console.log(JSON.stringify(matchedIdDocs, null, 2));

  // 4. hr_employee_profiles
  const profRes = await db.query(`SELECT * FROM hr_employee_profiles WHERE full_name ILIKE '%Hiếu%' OR employee_id = 'SWC00032' OR citizen_id = '060098011607'`);
  console.log('\n4. hr_employee_profiles count:', profRes.rows.length);
  console.log(JSON.stringify(profRes.rows, null, 2));

  // 5. hr_employee_staging
  const stagRes = await db.query(`SELECT id, batch_id, full_name, employee_code, citizen_id, company_id, staging_status, file_name, file_storage_path FROM hr_employee_staging WHERE full_name ILIKE '%Hiếu%' OR employee_code = 'SWC00032' OR citizen_id = '060098011607'`);
  console.log('\n5. hr_employee_staging count:', stagRes.rows.length);
  console.log(JSON.stringify(stagRes.rows, null, 2));

  // 6. hr_employment_history
  const histRes = await db.query(`SELECT * FROM hr_employment_history WHERE employment_id IN (SELECT id FROM employees WHERE employee_name ILIKE '%Hiếu%') OR person_id IN (SELECT id FROM hr_persons WHERE full_name ILIKE '%Hiếu%')`);
  console.log('\n6. hr_employment_history count:', histRes.rows.length);
  console.log(JSON.stringify(histRes.rows, null, 2));

  // 7. hr_employment_documents
  const empDocsRes = await db.query(`SELECT * FROM hr_employment_documents WHERE employment_id IN (SELECT id FROM employees WHERE employee_name ILIKE '%Hiếu%') OR person_id IN (SELECT id FROM hr_persons WHERE full_name ILIKE '%Hiếu%')`);
  console.log('\n7. hr_employment_documents count:', empDocsRes.rows.length);
  console.log(JSON.stringify(empDocsRes.rows, null, 2));

  // 8. hr_employment_compensation
  const compRes = await db.query(`SELECT * FROM hr_employment_compensation WHERE employment_id IN (SELECT id FROM employees WHERE employee_name ILIKE '%Hiếu%')`);
  console.log('\n8. hr_employment_compensation count:', compRes.rows.length);
  console.log(JSON.stringify(compRes.rows, null, 2));

  // 9. hr_sync_tasks
  const syncRes = await db.query(`SELECT * FROM hr_sync_tasks WHERE target_code = 'SWC00032' OR staging_id IN (SELECT id FROM hr_employee_staging WHERE full_name ILIKE '%Hiếu%')`);
  console.log('\n9. hr_sync_tasks count:', syncRes.rows.length);
  console.log(JSON.stringify(syncRes.rows, null, 2));

  // 10. users
  const userRes = await db.query(`SELECT user_id, username, role, employee_id FROM users WHERE employee_id IN (SELECT id FROM employees WHERE employee_name ILIKE '%Hiếu%')`);
  console.log('\n10. users count:', userRes.rows.length);

  // 11. Staging files check
  console.log('\n11. Checking physical files:');
  for (const s of stagRes.rows) {
    if (s.file_storage_path) {
      const exists = fs.existsSync(s.file_storage_path);
      console.log(`   file_storage_path: ${s.file_storage_path} exists? ${exists}`);
    }
    const uploadsStaging = path.join('/app/uploads/staging', s.file_name || '');
    console.log(`   /app/uploads/staging/${s.file_name} exists? ${fs.existsSync(uploadsStaging)}`);
    const appUploadsStaging = path.join('/app/uploads/staging', path.basename(s.file_storage_path || ''));
    console.log(`   /app/uploads/staging/${path.basename(s.file_storage_path || '')} exists? ${fs.existsSync(appUploadsStaging)}`);
  }

  process.exit(0);
}

inspectHieu().catch(err => {
  console.error(err);
  process.exit(1);
});
