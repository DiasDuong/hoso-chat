const db = require('../db');
const fs = require('fs');
const path = require('path');

async function inspect() {
  console.log('=== COMPREHENSIVE INSPECTION FOR UYEN & HIEU ===\n');

  // Search by names and employee codes
  const empRes = await db.query(`
    SELECT * FROM employees 
    WHERE employee_name ILIKE '%UYÊN%' OR employee_name ILIKE '%HIẾU%'
       OR employee_code IN ('SWC00037', 'SWC00047')
  `);
  console.log('1. employees count:', empRes.rows.length);
  console.log(JSON.stringify(empRes.rows, null, 2));

  const empIds = empRes.rows.map(r => r.id);
  const empCodes = empRes.rows.map(r => r.employee_code);
  const personIds = empRes.rows.map(r => r.person_id).filter(Boolean);
  const citizenIds = empRes.rows.map(r => r.citizen_id).filter(Boolean);

  console.log('\nExtracted identifiers:', { empIds, empCodes, personIds, citizenIds });

  // 2. hr_persons
  const perRes = await db.query(`
    SELECT * FROM hr_persons 
    WHERE id = ANY($1::uuid[]) 
       OR full_name ILIKE '%UYÊN%' OR full_name ILIKE '%HIẾU%'
  `, [personIds]);
  console.log('\n2. hr_persons count:', perRes.rows.length);
  console.log(JSON.stringify(perRes.rows, null, 2));

  const allPersonIds = Array.from(new Set([...personIds, ...perRes.rows.map(r => r.id)]));

  // 3. hr_person_identity_documents
  const idDocRes = await db.query(`
    SELECT * FROM hr_person_identity_documents 
    WHERE person_id = ANY($1::uuid[])
  `, [allPersonIds]);
  console.log('\n3. hr_person_identity_documents count:', idDocRes.rows.length);
  console.log(JSON.stringify(idDocRes.rows, null, 2));

  // 4. hr_employee_profiles
  const profRes = await db.query(`
    SELECT * FROM hr_employee_profiles 
    WHERE employee_id = ANY($1::text[]) 
       OR citizen_id = ANY($2::text[]) 
       OR employment_id = ANY($3::uuid[])
       OR full_name ILIKE '%UYÊN%' OR full_name ILIKE '%HIẾU%'
  `, [empCodes, citizenIds, empIds]);
  console.log('\n4. hr_employee_profiles count:', profRes.rows.length);
  console.log(JSON.stringify(profRes.rows, null, 2));

  // 5. hr_employee_staging
  const stagRes = await db.query(`
    SELECT * FROM hr_employee_staging 
    WHERE employee_code = ANY($1::text[]) 
       OR target_employee_code = ANY($1::text[])
       OR citizen_id = ANY($2::text[]) 
       OR full_name ILIKE '%UYÊN%' OR full_name ILIKE '%HIẾU%'
  `, [empCodes, citizenIds]);
  console.log('\n5. hr_employee_staging count:', stagRes.rows.length);
  console.log(JSON.stringify(stagRes.rows, null, 2));

  // 6. hr_employment_history
  const histRes = await db.query(`
    SELECT * FROM hr_employment_history 
    WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])
  `, [empIds, allPersonIds]);
  console.log('\n6. hr_employment_history count:', histRes.rows.length);
  console.log(JSON.stringify(histRes.rows, null, 2));

  // 7. hr_employment_documents
  const empDocRes = await db.query(`
    SELECT * FROM hr_employment_documents 
    WHERE employment_id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])
  `, [empIds, allPersonIds]);
  console.log('\n7. hr_employment_documents count:', empDocRes.rows.length);
  console.log(JSON.stringify(empDocRes.rows, null, 2));

  // 8. hr_employment_compensation
  const compRes = await db.query(`
    SELECT * FROM hr_employment_compensation 
    WHERE employment_id = ANY($1::uuid[])
  `, [empIds]);
  console.log('\n8. hr_employment_compensation count:', compRes.rows.length);
  console.log(JSON.stringify(compRes.rows, null, 2));

  // 9. hr_sync_tasks
  const stagIds = stagRes.rows.map(r => r.id);
  const syncRes = await db.query(`
    SELECT * FROM hr_sync_tasks 
    WHERE employee_id = ANY($1::uuid[]) 
       OR staging_id = ANY($2::uuid[])
  `, [empIds, stagIds]);
  console.log('\n9. hr_sync_tasks count:', syncRes.rows.length);
  console.log(JSON.stringify(syncRes.rows, null, 2));

  // 10. employee_sync_outbox
  const outboxRes = await db.query(`
    SELECT * FROM employee_sync_outbox 
    WHERE employee_id = ANY($1::text[]) OR employee_id = ANY($2::text[])
  `, [empCodes, empIds.map(String)]);
  console.log('\n10. employee_sync_outbox count:', outboxRes.rows.length);
  console.log(JSON.stringify(outboxRes.rows, null, 2));

  // 11. users
  const userRes = await db.query(`
    SELECT user_id, username, role, employee_id, company_id, status 
    FROM users 
    WHERE employee_id = ANY($1::uuid[]) OR username = ANY($2::text[])
  `, [empIds, empCodes]);
  console.log('\n11. users count:', userRes.rows.length);
  console.log(JSON.stringify(userRes.rows, null, 2));

  // 12. Physical files check
  console.log('\n12. Associated files from staging and profiles:');
  const filesToCheck = new Set();
  for (const s of stagRes.rows) {
    if (s.file_name) filesToCheck.add(s.file_name);
    if (s.file_storage_path) filesToCheck.add(s.file_storage_path);
  }
  for (const p of profRes.rows) {
    if (p.file_name) filesToCheck.add(p.file_name);
  }
  for (const ed of empDocRes.rows) {
    if (ed.file_path) filesToCheck.add(ed.file_path);
    if (ed.file_name) filesToCheck.add(ed.file_name);
  }
  console.log('Files to check:', Array.from(filesToCheck));

  for (const f of filesToCheck) {
    const candidates = [
      f,
      path.join('/app/uploads/staging', path.basename(f)),
      path.join('/app/uploads', path.basename(f)),
      path.join('/app/chat-files', path.basename(f)),
      path.join('/home/node/.n8n-files', path.basename(f))
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        console.log(`[FOUND FILE] ${c} exists (${fs.statSync(c).size} bytes)`);
      }
    }
  }

  process.exit(0);
}

inspect().catch(err => {
  console.error(err);
  process.exit(1);
});
