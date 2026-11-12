const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const { execSync } = require('child_process');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

function queryPgJson(sql) {
  const cleanSql = sql.replace(/\s+/g, ' ').trim();
  const jsonSql = `SELECT json_agg(t) FROM (${cleanSql}) t;`;
  const out = execSync(`docker exec hrbot-postgres-1 psql -U hrbot -d hrbot -t -A -c "${jsonSql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
  return out && out !== '' ? JSON.parse(out) : [];
}

async function uploadFiles(fileNames, corrIdPrefix) {
  const token = jwt.sign({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '1h' });

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="company_id"\r\n\r\nSWC\r\n`));

  let totalBytes = 0;
  for (let i = 0; i < fileNames.length; i++) {
    const fn = fileNames[i];
    const pdfPath = path.resolve(__dirname, '../auth-service/uploads/staging', fn);
    const buf = fs.readFileSync(pdfPath);
    totalBytes += buf.length;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_${i}"; filename="${fn}"\r\nContent-Type: application/pdf\r\n\r\n`));
    parts.push(buf);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const fullBody = Buffer.concat(parts);

  const start = Date.now();
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/webhook/hr-lifecycle-upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${token}`,
        'X-Correlation-Id': corrIdPrefix + '_' + Date.now(),
        'Content-Length': fullBody.length
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), durationMs: Date.now() - start });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data, durationMs: Date.now() - start });
        }
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });

  return res;
}

async function runAllTests() {
  console.log('================================================================================');
  console.log('SOTRANS HUB — OCR GEMINI 3.1 FLASH-LITE MIGRATION & MULTI-FILE VERIFICATION');
  console.log('================================================================================\n');

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

  // --- TEST GROUP 1: Single Upload SWC00808.pdf ---
  console.log('--- SCENARIO 1: Single Upload SWC00808.pdf ---');
  const res808 = await uploadFiles(['SWC00808.pdf'], 'corr_single_808');
  assert(res808.status === 200, '1.1 SWC00808 HTTP 200', `Status: ${res808.status}`);
  const b808 = res808.body || {};
  assert(b808.success === true, '1.2 SWC00808 success is true');
  assert(b808.extracted_profile?.full_name === 'NGÔ ĐẶNG TUẤN UYÊN', '1.3 SWC00808 Full Name = NGÔ ĐẶNG TUẤN UYÊN', `Got: ${b808.extracted_profile?.full_name}`);
  assert(b808.extracted_profile?.citizen_id === '062095000277', '1.4 SWC00808 CCCD = 062095000277', `Got: ${b808.extracted_profile?.citizen_id}`);
  assert(b808.extracted_profile?.date_of_birth === '1995-01-25', '1.5 SWC00808 DOB = 1995-01-25', `Got: ${b808.extracted_profile?.date_of_birth}`);
  console.log(`SWC00808 processed in ${(res808.durationMs / 1000).toFixed(2)}s\n`);

  // --- TEST GROUP 2: Single Upload SWC00810.pdf ---
  console.log('--- SCENARIO 2: Single Upload SWC00810.pdf ---');
  const res810 = await uploadFiles(['SWC00810.pdf'], 'corr_single_810');
  assert(res810.status === 200, '2.1 SWC00810 HTTP 200', `Status: ${res810.status}`);
  const b810 = res810.body || {};
  assert(b810.success === true, '2.2 SWC00810 success is true');
  assert(b810.extracted_profile?.full_name === 'NGUYỄN TRƯỜNG NAM', '2.3 SWC00810 Full Name = NGUYỄN TRƯỜNG NAM', `Got: ${b810.extracted_profile?.full_name}`);
  assert(b810.extracted_profile?.citizen_id === '036202007139', '2.4 SWC00810 CCCD = 036202007139', `Got: ${b810.extracted_profile?.citizen_id}`);
  assert(b810.extracted_profile?.date_of_birth === '2002-09-21', '2.5 SWC00810 DOB = 2002-09-21', `Got: ${b810.extracted_profile?.date_of_birth}`);
  console.log(`SWC00810 processed in ${(res810.durationMs / 1000).toFixed(2)}s\n`);

  // --- TEST GROUP 3: Single Upload SWC00814.pdf ---
  console.log('--- SCENARIO 3: Single Upload SWC00814.pdf ---');
  const res814 = await uploadFiles(['SWC00814.pdf'], 'corr_single_814');
  assert(res814.status === 200, '3.1 SWC00814 HTTP 200', `Status: ${res814.status}`);
  const b814 = res814.body || {};
  assert(b814.success === true, '3.2 SWC00814 success is true');
  assert(b814.extracted_profile?.full_name === 'PHAN DƯƠNG THANH BÌNH', '3.3 SWC00814 Full Name = PHAN DƯƠNG THANH BÌNH', `Got: ${b814.extracted_profile?.full_name}`);
  assert(b814.extracted_profile?.citizen_id === '079204001284', '3.4 SWC00814 CCCD = 079204001284', `Got: ${b814.extracted_profile?.citizen_id}`);
  assert(b814.extracted_profile?.date_of_birth === '2004-04-17', '3.5 SWC00814 DOB = 2004-04-17', `Got: ${b814.extracted_profile?.date_of_birth}`);
  console.log(`SWC00814 processed in ${(res814.durationMs / 1000).toFixed(2)}s\n`);

  // --- TEST GROUP 4: Batch Upload 3 Files (SWC00808.pdf, SWC00810.pdf, SWC00814.pdf) ---
  console.log('--- SCENARIO 4: Batch Upload 3 Files Simultaneously ---');
  const batchRes = await uploadFiles(['SWC00808.pdf', 'SWC00810.pdf', 'SWC00814.pdf'], 'corr_batch_3files');
  assert(batchRes.status === 200, '4.1 Batch 3 Files HTTP 200', `Status: ${batchRes.status}`);
  const bBatch = batchRes.body || {};
  assert(bBatch.success === true, '4.2 Batch success is true');
  console.log(`Batch 3 files processed in ${(batchRes.durationMs / 1000).toFixed(2)}s`);

  const stagedItems = bBatch.staged_items || bBatch.items || [];
  assert(stagedItems.length === 3, '4.3 Batch generated exactly 3 distinct staged items', `Found: ${stagedItems.length}`);

  // Find each employee in staged items
  const cand808 = stagedItems.find(s => s.citizen_id === '062095000277' || s.full_name?.includes('TUẤN UYÊN'));
  const cand810 = stagedItems.find(s => s.citizen_id === '036202007139' || s.full_name?.includes('TRƯỜNG NAM'));
  const cand814 = stagedItems.find(s => s.citizen_id === '079204001284' || s.full_name?.includes('THANH BÌNH'));

  assert(!!cand808, '4.4 Candidate 1 found: NGÔ ĐẶNG TUẤN UYÊN (062095000277)');
  if (cand808) {
    assert(cand808.full_name === 'NGÔ ĐẶNG TUẤN UYÊN', '4.4.1 Full Name correct with Vietnamese diacritics', cand808.full_name);
    assert(cand808.citizen_id === '062095000277', '4.4.2 CCCD correct', cand808.citizen_id);
    const data = cand808.extracted_data || {};
    assert(Object.keys(data).length > 5, '4.4.3 extracted_data is populated for batch item 1', `Keys: ${Object.keys(data).length}`);
    assert(data.full_name === 'NGÔ ĐẶNG TUẤN UYÊN', '4.4.4 extracted_data.full_name matches candidate', data.full_name);
  }

  assert(!!cand810, '4.5 Candidate 2 found: NGUYỄN TRƯỜNG NAM (036202007139)');
  if (cand810) {
    assert(cand810.full_name === 'NGUYỄN TRƯỜNG NAM', '4.5.1 Full Name correct with Vietnamese diacritics', cand810.full_name);
    assert(cand810.citizen_id === '036202007139', '4.5.2 CCCD correct', cand810.citizen_id);
    const data = cand810.extracted_data || {};
    assert(Object.keys(data).length > 5, '4.5.3 extracted_data is populated for batch item 2', `Keys: ${Object.keys(data).length}`);
    assert(data.full_name === 'NGUYỄN TRƯỜNG NAM', '4.5.4 extracted_data.full_name matches candidate', data.full_name);
  }

  assert(!!cand814, '4.6 Candidate 3 found: PHAN DƯƠNG THANH BÌNH (079204001284)');
  if (cand814) {
    assert(cand814.full_name === 'PHAN DƯƠNG THANH BÌNH', '4.6.1 Full Name correct with Vietnamese diacritics', cand814.full_name);
    assert(cand814.citizen_id === '079204001284', '4.6.2 CCCD correct', cand814.citizen_id);
    const data = cand814.extracted_data || {};
    assert(Object.keys(data).length > 5, '4.6.3 extracted_data is populated for batch item 3', `Keys: ${Object.keys(data).length}`);
    assert(data.full_name === 'PHAN DƯƠNG THANH BÌNH', '4.6.4 extracted_data.full_name matches candidate', data.full_name);
  }

  // Verify no mixing of records
  const distinctCccds = new Set(stagedItems.map(s => s.citizen_id));
  assert(distinctCccds.size === 3, '4.7 No mixing of CCCD across batch items', `Unique CCCDs: ${Array.from(distinctCccds).join(', ')}`);

  // --- TEST GROUP 5: PostgreSQL Database Integrity & Staging Verification ---
  console.log('\n--- SCENARIO 5: PostgreSQL Staging & Database Integrity ---');
  const pgStaging = queryPgJson("SELECT id, file_name, full_name, citizen_id, date_of_birth, company_id, staging_status FROM hr_employee_staging WHERE citizen_id IN ('062095000277', '036202007139', '079204001284') ORDER BY created_at DESC LIMIT 10");
  assert(pgStaging.length >= 3, '5.1 Staging records exist in PostgreSQL for all 3 employees', `Count: ${pgStaging.length}`);

  // Protected employees check
  const retainRows = queryPgJson("SELECT employee_code, employee_name, company_id, status FROM employees WHERE employee_code IN ('STL00014', 'SWC00025', 'SWC00037')");
  assert(retainRows.length === 3, '5.2 Protected employees (STL00014, SWC00025, SWC00037) preserved', `Count: ${retainRows.length}`);

  // NocoDB table check (hr_employee_profiles)
  const nocoProfiles = queryPgJson("SELECT id, employee_id, citizen_id, full_name FROM hr_employee_profiles LIMIT 5");
  assert(nocoProfiles.length > 0, '5.3 NocoDB profile table is accessible and consistent', `Profiles: ${nocoProfiles.length}`);

  console.log('\n================================================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================================\n');

  if (failed > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
