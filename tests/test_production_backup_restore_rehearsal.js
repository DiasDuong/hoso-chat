/**
 * SOTRANS HUB — PRODUCTION BACKUP & RESTORE REHEARSAL VERIFICATION
 * End-to-end verification of multi-component Point-in-Time Backup, Checksums,
 * and Non-Destructive Isolated Restore Protocol.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Pool } = require('../auth-service/node_modules/pg');

const REHEARSAL_DIR = path.join(__dirname, '../temp_rehearsal_backup');
const RECOVERED_DIR = path.join(__dirname, '../temp_rehearsal_recovered');
const SOURCE_DB = 'sotrans_production_rehearsal';
const RECOVERED_DB = 'sotrans_rehearsal_recovered';

async function runBackupRestoreRehearsal() {
  console.log('================================================================');
  console.log('SOTRANS HUB — BACKUP & RESTORE REHEARSAL VERIFICATION');
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

  // Cleanup past temp directories
  if (fs.existsSync(REHEARSAL_DIR)) fs.rmSync(REHEARSAL_DIR, { recursive: true, force: true });
  if (fs.existsSync(RECOVERED_DIR)) fs.rmSync(RECOVERED_DIR, { recursive: true, force: true });
  fs.mkdirSync(REHEARSAL_DIR, { recursive: true });
  fs.mkdirSync(RECOVERED_DIR, { recursive: true });

  const adminPool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    user: 'hrbot',
    password: process.env.PG_PASSWORD || 'WVTd1BjqlizHbMcsro43PwQaO8meSAfL',
  });

  try {
    // -------------------------------------------------------------------------
    // STEP 1: PREPARE SYNTHETIC TEST ARTIFACTS FOR STORAGE & CHAT-FILES
    // -------------------------------------------------------------------------
    console.log('--- 1. PREPARING TEST DATA FOR STORAGE & CHAT-FILES ---');
    const mockStorageDir = path.join(REHEARSAL_DIR, 'mock_storage');
    const mockChatFilesDir = path.join(REHEARSAL_DIR, 'mock_chat_files');
    fs.mkdirSync(path.join(mockStorageDir, 'bi_datasets'), { recursive: true });
    fs.mkdirSync(path.join(mockStorageDir, 'raw_files'), { recursive: true });
    fs.mkdirSync(path.join(mockStorageDir, 'audit_logs'), { recursive: true });
    fs.mkdirSync(mockChatFilesDir, { recursive: true });

    // 1.1. Dataset Registry
    const mockRegistry = {
      version: '2.4',
      datasets: {
        'mock-ds-001': {
          dataset_id: 'mock-ds-001',
          file_name: 'rehearsal_sales.xlsx',
          uploaded_by: 'rehearsal_admin',
          company_id: 'STG_CORP',
          created_at: new Date().toISOString(),
          total_rows: 150,
          total_columns: 8,
        }
      }
    };
    fs.writeFileSync(path.join(mockStorageDir, 'dataset_registry.json'), JSON.stringify(mockRegistry, null, 2));

    // 1.2. Mock Raw File & Dataset File
    fs.writeFileSync(path.join(mockStorageDir, 'raw_files', 'rehearsal_sales.xlsx'), 'BINARY_MOCK_EXCEL_DATA');
    fs.writeFileSync(path.join(mockStorageDir, 'bi_datasets', 'mock-ds-001.parquet'), 'BINARY_MOCK_PARQUET_DATA');

    // 1.3. Mock Audit Log
    fs.writeFileSync(path.join(mockStorageDir, 'audit_logs', 'governance_audit.log'), '2026-11-15: DATASET_QUERY uploaded_by:rehearsal_admin\n');

    // 1.4. Mock Permanent Chat File
    fs.writeFileSync(path.join(mockChatFilesDir, 'policy_2026.pdf'), 'PDF_MOCK_CONTENT');

    assert(fs.existsSync(path.join(mockStorageDir, 'dataset_registry.json')), 'Synthetic dataset registry prepared');
    assert(fs.existsSync(path.join(mockChatFilesDir, 'policy_2026.pdf')), 'Synthetic permanent chat file prepared');

    // -------------------------------------------------------------------------
    // STEP 2: EXECUTE MULTI-COMPONENT BACKUP WITH SHA256 INTEGRITY CHECKS
    // -------------------------------------------------------------------------
    console.log('\n--- 2. EXECUTING MULTI-COMPONENT BACKUP ---');
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const backupTargetDir = path.join(REHEARSAL_DIR, `backup_${timestamp}`);
    fs.mkdirSync(backupTargetDir, { recursive: true });

    // 2.1. PostgreSQL Custom Compressed Dump (-Fc)
    const pgDumpFile = path.join(backupTargetDir, `postgres_${SOURCE_DB}_${timestamp}.dump`);
    execSync(`docker exec hrbot-postgres-1 pg_dump -U hrbot -d ${SOURCE_DB} -Fc --no-owner --no-privileges > "${pgDumpFile}"`);
    assert(fs.existsSync(pgDumpFile) && fs.statSync(pgDumpFile).size > 1000, 'PostgreSQL pg_dump -Fc generated successfully');

    // 2.2. Archive chat-files
    const chatFilesTar = path.join(backupTargetDir, `chat_files_${timestamp}.tar.gz`);
    execSync(`tar -czf "${chatFilesTar}" -C "${mockChatFilesDir}" .`);
    assert(fs.existsSync(chatFilesTar), 'chat-files archive tar.gz generated successfully');

    // 2.3. Archive storage (bi_datasets, registry, audit logs, raw files)
    const storageTar = path.join(backupTargetDir, `bi_storage_${timestamp}.tar.gz`);
    execSync(`tar -czf "${storageTar}" -C "${mockStorageDir}" .`);
    assert(fs.existsSync(storageTar), 'storage archive tar.gz generated successfully');

    // 2.4. Generate SHA256 Checksums & Metadata
    const filesToHash = [
      path.basename(pgDumpFile),
      path.basename(chatFilesTar),
      path.basename(storageTar)
    ];
    let sha256Content = '';
    for (const f of filesToHash) {
      const fullPath = path.join(backupTargetDir, f);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
      sha256Content += `${hash}  ${f}\n`;
    }
    fs.writeFileSync(path.join(backupTargetDir, 'SHA256SUMS.txt'), sha256Content);

    // 2.5. Verify SHA256 Checksums
    const lines = sha256Content.trim().split('\n');
    let allHashesValid = true;
    for (const line of lines) {
      const [expectedHash, fileName] = line.split(/\s+/);
      const computedHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(backupTargetDir, fileName))).digest('hex');
      if (expectedHash !== computedHash) allHashesValid = false;
    }
    assert(allHashesValid, 'All backup component archives pass SHA256 verification');

    // -------------------------------------------------------------------------
    // STEP 3: NON-DESTRUCTIVE ISOLATED RESTORE PROTOCOL (NO OVERWRITE)
    // -------------------------------------------------------------------------
    console.log('\n--- 3. NON-DESTRUCTIVE ISOLATED RESTORE PROTOCOL ---');
    
    // 3.1. Create target isolated database (sotrans_rehearsal_recovered)
    await adminPool.query(`DROP DATABASE IF EXISTS ${RECOVERED_DB};`);
    await adminPool.query(`CREATE DATABASE ${RECOVERED_DB} OWNER hrbot;`);
    assert(true, `Created isolated recovery database "${RECOVERED_DB}" (NO DROP of active DB)`);

    // 3.2. Restore pg_restore into isolated database
    execSync(`docker exec -i hrbot-postgres-1 pg_restore -U hrbot -d ${RECOVERED_DB} --no-owner --no-privileges < "${pgDumpFile}"`);
    assert(true, 'pg_restore completed into isolated recovery database');

    // 3.3. Restore files into isolated directory
    const recoveredChatFiles = path.join(RECOVERED_DIR, 'chat-files');
    const recoveredStorage = path.join(RECOVERED_DIR, 'storage');
    fs.mkdirSync(recoveredChatFiles, { recursive: true });
    fs.mkdirSync(recoveredStorage, { recursive: true });
    execSync(`tar -xzf "${chatFilesTar}" -C "${recoveredChatFiles}"`);
    execSync(`tar -xzf "${storageTar}" -C "${recoveredStorage}"`);
    assert(fs.existsSync(path.join(recoveredChatFiles, 'policy_2026.pdf')), 'Permanent documents successfully recovered to isolated directory');
    assert(fs.existsSync(path.join(recoveredStorage, 'dataset_registry.json')), 'BI storage registry successfully recovered to isolated directory');

    // -------------------------------------------------------------------------
    // STEP 4: VERIFY RECOVERED SYSTEM CAPABILITIES & DATA INTEGRITY
    // -------------------------------------------------------------------------
    console.log('\n--- 4. POST-RESTORE DATA INTEGRITY & FUNCTIONALITY AUDIT ---');
    const recoveredPool = new Pool({
      host: '127.0.0.1',
      port: 5432,
      database: RECOVERED_DB,
      user: 'hrbot',
      password: process.env.PG_PASSWORD || 'WVTd1BjqlizHbMcsro43PwQaO8meSAfL',
    });

    // 4.1. Users & Authentication
    const userRes = await recoveredPool.query(`SELECT username, role, status FROM public.users WHERE username = 'rehearsal_admin';`);
    assert(userRes.rows.length === 1 && userRes.rows[0].role === 'ADMIN', 'Recovered database retains user credentials & authentication state');

    // 4.2. Staging Batches & Records
    const batchRes = await recoveredPool.query(`SELECT status, total_files FROM public.hr_intake_batches;`);
    assert(batchRes.rows.length === 1 && batchRes.rows[0].total_files === 5, 'Recovered database retains HR intake batches');

    const stagingRes = await recoveredPool.query(`SELECT full_name, citizen_id FROM public.hr_employee_staging;`);
    assert(stagingRes.rows.length === 1 && stagingRes.rows[0].citizen_id === '079123456789', 'Recovered database retains employee staging records');

    // 4.3. Audit Logs
    const auditRes = await recoveredPool.query(`SELECT count(*) AS total_logs FROM public.auth_audit_logs;`);
    assert(parseInt(auditRes.rows[0].total_logs, 10) >= 1, 'Recovered database retains audit trail logs');

    // 4.4. Uploaded File BI Metadata & Ownership
    const recoveredRegData = JSON.parse(fs.readFileSync(path.join(recoveredStorage, 'dataset_registry.json'), 'utf8'));
    assert(
      recoveredRegData.datasets['mock-ds-001'] && recoveredRegData.datasets['mock-ds-001'].uploaded_by === 'rehearsal_admin',
      'Recovered storage retains dataset registry metadata, tenancy and file ownership'
    );

    // 4.5. Cleanup recovery temp database
    await recoveredPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS ${RECOVERED_DB};`);
    console.log('\nIsolated recovery database cleaned up safely.');

    console.log('\n================================================================');
    console.log(`BACKUP & RESTORE REHEARSAL RESULT: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('FATAL BACKUP/RESTORE REHEARSAL ERROR:', err);
    process.exit(1);
  } finally {
    await adminPool.end();
    // Cleanup rehearsal files
    if (fs.existsSync(REHEARSAL_DIR)) fs.rmSync(REHEARSAL_DIR, { recursive: true, force: true });
    if (fs.existsSync(RECOVERED_DIR)) fs.rmSync(RECOVERED_DIR, { recursive: true, force: true });
  }
}

runBackupRestoreRehearsal();
