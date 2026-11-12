const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function doBackup() {
  const backupDir = '/app/uploads/backup_20261111_hieu';
  const filesBackupDir = path.join(backupDir, 'files');
  if (!fs.existsSync(filesBackupDir)) fs.mkdirSync(filesBackupDir, { recursive: true });

  const target = {
    name: 'NGUYỄN VĂN HIẾU',
    employee_code: 'SWC00032',
    id: '180c7240-5d74-47cc-87c2-200bf312802a',
    citizen_id: '060098011607',
    person_id: 'fdd31f9a-00eb-4dd3-8837-9318dc44f2a1',
    staging_ids: ['a5e48f94-5c6f-4e0c-82ef-c4e6611c9929', '98805931-5b8f-4c7f-92ef-9e84c6111676']
  };

  const manifest = {
    created_at: new Date().toISOString(),
    target,
    items: {}
  };

  // 1. employees
  const empRes = await db.query(`SELECT * FROM employees WHERE id = $1 OR employee_code = $2`, [target.id, target.employee_code]);
  const empJson = JSON.stringify(empRes.rows, null, 2);
  const empPath = path.join(backupDir, 'backup_employees.json');
  fs.writeFileSync(empPath, empJson, 'utf8');
  manifest.items['backup_employees.json'] = {
    records: empRes.rows.length,
    size: Buffer.byteLength(empJson),
    sha256: sha256Buffer(Buffer.from(empJson))
  };

  // 2. hr_persons
  const perRes = await db.query(`SELECT * FROM hr_persons WHERE id = $1`, [target.person_id]);
  const perJson = JSON.stringify(perRes.rows, null, 2);
  const perPath = path.join(backupDir, 'backup_hr_persons.json');
  fs.writeFileSync(perPath, perJson, 'utf8');
  manifest.items['backup_hr_persons.json'] = {
    records: perRes.rows.length,
    size: Buffer.byteLength(perJson),
    sha256: sha256Buffer(Buffer.from(perJson))
  };

  // 3. hr_person_identity_documents
  const idDocRes = await db.query(`SELECT * FROM hr_person_identity_documents WHERE person_id = $1`, [target.person_id]);
  const idDocJson = JSON.stringify(idDocRes.rows, null, 2);
  const idDocPath = path.join(backupDir, 'backup_hr_person_identity_documents.json');
  fs.writeFileSync(idDocPath, idDocJson, 'utf8');
  manifest.items['backup_hr_person_identity_documents.json'] = {
    records: idDocRes.rows.length,
    size: Buffer.byteLength(idDocJson),
    sha256: sha256Buffer(Buffer.from(idDocJson))
  };

  // 4. hr_employee_profiles
  const profRes = await db.query(`SELECT * FROM hr_employee_profiles WHERE employee_id = $1 OR citizen_id = $2 OR employment_id = $3`, [target.employee_code, target.citizen_id, target.id]);
  const profJson = JSON.stringify(profRes.rows, null, 2);
  const profPath = path.join(backupDir, 'backup_hr_employee_profiles.json');
  fs.writeFileSync(profPath, profJson, 'utf8');
  manifest.items['backup_hr_employee_profiles.json'] = {
    records: profRes.rows.length,
    size: Buffer.byteLength(profJson),
    sha256: sha256Buffer(Buffer.from(profJson))
  };

  // 5. hr_employee_staging
  const stagRes = await db.query(`SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[]) OR citizen_id = $2 OR employee_code = $3`, [target.staging_ids, target.citizen_id, target.employee_code]);
  const stagJson = JSON.stringify(stagRes.rows, null, 2);
  const stagPath = path.join(backupDir, 'backup_hr_employee_staging.json');
  fs.writeFileSync(stagPath, stagJson, 'utf8');
  manifest.items['backup_hr_employee_staging.json'] = {
    records: stagRes.rows.length,
    size: Buffer.byteLength(stagJson),
    sha256: sha256Buffer(Buffer.from(stagJson))
  };

  // 6. hr_employment_history
  const histRes = await db.query(`SELECT * FROM hr_employment_history WHERE employment_id = $1 OR person_id = $2`, [target.id, target.person_id]);
  const histJson = JSON.stringify(histRes.rows, null, 2);
  const histPath = path.join(backupDir, 'backup_hr_employment_history.json');
  fs.writeFileSync(histPath, histJson, 'utf8');
  manifest.items['backup_hr_employment_history.json'] = {
    records: histRes.rows.length,
    size: Buffer.byteLength(histJson),
    sha256: sha256Buffer(Buffer.from(histJson))
  };

  // 7. hr_sync_tasks
  const syncRes = await db.query(`SELECT * FROM hr_sync_tasks WHERE employee_id = $1 OR staging_id = ANY($2::uuid[])`, [target.id, target.staging_ids]);
  const syncJson = JSON.stringify(syncRes.rows, null, 2);
  const syncPath = path.join(backupDir, 'backup_hr_sync_tasks.json');
  fs.writeFileSync(syncPath, syncJson, 'utf8');
  manifest.items['backup_hr_sync_tasks.json'] = {
    records: syncRes.rows.length,
    size: Buffer.byteLength(syncJson),
    sha256: sha256Buffer(Buffer.from(syncJson))
  };

  // 8. Files
  const files = [
    '40f47b28-43f0-4b31-b874-abce2abbd2ed_SWC00803.pdf',
    'ec702e6c-c6ef-4530-9e1b-df9251fb9e43_SWC00803.pdf'
  ];
  manifest.files = {};
  for (const f of files) {
    const src = path.join('/app/uploads/staging', f);
    const dst = path.join(filesBackupDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      const buf = fs.readFileSync(dst);
      manifest.files[f] = {
        size: buf.length,
        sha256: sha256Buffer(buf)
      };
      console.log(`Backed up file: ${f} (${buf.length} bytes)`);
    } else {
      console.warn(`File not found: ${src}`);
    }
  }

  // Write manifest
  fs.writeFileSync(path.join(backupDir, 'backup_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Backup manifest written successfully.');
  console.log(JSON.stringify(manifest, null, 2));

  process.exit(0);
}

doBackup().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
