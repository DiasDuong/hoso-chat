/**
 * SOTRANS HUB — REGRESSION TEST SUITE FOR OCR ROOT CAUSE FIX
 * TARGET: SWC00814.pdf (15 pages scanned image PDF, no text layer)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const { Pool } = require('../auth-service/node_modules/pg');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

async function runTests() {
  console.log('========================================================================');
  console.log('SOTRANS HUB — OCR ROOT CAUSE REGRESSION TEST (SWC00814.pdf)');
  console.log('========================================================================\n');

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

  // 1. Direct Multi-Page OCR Engine Test via hr-auth internal endpoint
  console.log('--- TEST GROUP 1: Direct MultiPageOcrEngine Execution via hr-auth ---');

  const targetPdf = path.resolve(__dirname, '../auth-service/uploads/staging/14195994-7fec-4d57-8e11-af4b2b5ffbeb_SWC00814.pdf');
  assert(fs.existsSync(targetPdf), '1.1 Real SWC00814.pdf exists on disk', targetPdf);

  const pdfBuf = fs.readFileSync(targetPdf);
  assert(pdfBuf.length > 4000000, '1.2 File size is authentic 4.12 MB (not corrupted 9 bytes)', `Size: ${pdfBuf.length}`);

  console.log('Calling /api/hoso/intake/internal/ocr-document (processing all 15 pages in hr-auth)...');
  const engineResult = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      fileStoragePath: '/app/uploads/staging/14195994-7fec-4d57-8e11-af4b2b5ffbeb_SWC00814.pdf',
      fileName: 'SWC00814.pdf',
      secret: '8973d464f5f1475b83d6ab88d222d824'
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/api/hoso/intake/internal/ocr-document',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': '8973d464f5f1475b83d6ab88d222d824',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${d}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  assert(engineResult.success === true, '1.3 Engine completed successfully');
  assert(engineResult.totalPages === 15, '1.4 Processed all 15 pages without skipping', `Pages: ${engineResult.totalPages}`);

  const auditResults = engineResult.audit.pageResults;
  const p3 = auditResults.find(p => p.page === 3);
  const p4 = auditResults.find(p => p.page === 4);
  const p7 = auditResults.find(p => p.page === 7);

  assert(p3 && p3.type === 'HANDWRITTEN_FORM', '1.5 Page 3 correctly identified as Handwritten form (weight 35)', `Type: ${p3?.type}`);
  assert(p4 && p4.type === 'VNEID_DIGITAL', '1.6 Page 4 correctly identified as VNeID digital (weight 95)', `Type: ${p4?.type}`);
  assert(p7 && p7.type === 'CCCD_CARD', '1.7 Page 7 correctly identified as CCCD card (weight 100)', `Type: ${p7?.type}`);

  const ext = engineResult.extracted;
  assert(ext.citizen_id === '079204001284', '1.8 CCCD correctly identified from Page 7 & cross-referenced', `Got: ${ext.citizen_id}`);
  assert(ext.citizen_id.length === 12, '1.9 CCCD standardized to 12 digits', `Length: ${ext.citizen_id.length}`);
  assert(ext.full_name === 'PHAN DƯƠNG THANH BÌNH', '1.10 Full name extracted accurately, NOT filename SWC00814', `Got: ${ext.full_name}`);
  assert(ext.date_of_birth === '2004-04-17', '1.11 Date of birth extracted as YYYY-MM-DD', `Got: ${ext.date_of_birth}`);
  assert(ext.gender === 'Nam', '1.12 Gender identified as Nam', `Got: ${ext.gender}`);
  assert(ext.citizen_id_issue_date === '2022-01-26', '1.13 CCCD issue date extracted as YYYY-MM-DD', `Got: ${ext.citizen_id_issue_date}`);
  assert(ext.permanent_address && ext.permanent_address.includes('25/27') && ext.permanent_address.includes('Trương Văn Thành'), '1.14 Permanent address extracted correctly (25/27 Trương Văn Thành)', `Got: ${ext.permanent_address}`);
  assert(engineResult.conflicts.length === 0, '1.15 No false conflicts detected across pages', `Conflicts: ${JSON.stringify(engineResult.conflicts)}`);

  // 2. End-to-End Pipeline Upload via Gateway
  console.log('\n--- TEST GROUP 2: End-to-End Pipeline Upload via Gateway ---');
  const token = jwt.sign({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '1h' });

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="company_id"\r\n\r\nSWC\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="SWC00814.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
  parts.push(pdfBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const fullBody = Buffer.concat(parts);

  console.log(`Sending upload request to Gateway (http://127.0.0.1:8082/webhook/hr-lifecycle-upload)... Body: ${(fullBody.length / 1024 / 1024).toFixed(2)} MB`);
  
  const uploadResponse = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/webhook/hr-lifecycle-upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${token}`,
        'X-Correlation-Id': 'corr_ocr_test_' + Date.now(),
        'Content-Length': fullBody.length
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });

  assert(uploadResponse.status === 200, '2.1 Upload webhook returned HTTP 200', `Status: ${uploadResponse.status}`);
  const upBody = uploadResponse.body || {};
  assert(upBody.success === true, '2.2 Upload webhook reported success: true', JSON.stringify(upBody));

  // 3. PostgreSQL Database Staging Verification
  console.log('\n--- TEST GROUP 3: PostgreSQL Database Staging Verification ---');
  const { execSync } = require('child_process');
  
  function queryPgJson(sql) {
    const jsonSql = `SELECT json_agg(t) FROM (${sql}) t;`;
    const out = execSync(`docker exec hrbot-postgres-1 psql -U hrbot -d hrbot -t -A -c "${jsonSql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
    return out && out !== '' ? JSON.parse(out) : [];
  }

  const stagingRows = queryPgJson("SELECT id, file_name, full_name, citizen_id, date_of_birth, gender, file_size, staging_status FROM hr_employee_staging WHERE citizen_id = '079204001284' ORDER BY created_at DESC LIMIT 1");

  assert(stagingRows.length > 0, '3.1 Staging record exists for citizen_id 079204001284');
  if (stagingRows.length > 0) {
    const row = stagingRows[0];
    assert(row.full_name === 'PHAN DƯƠNG THANH BÌNH', '3.2 Staging full_name is PHAN DƯƠNG THANH BÌNH (NOT SWC00814)', `Got: ${row.full_name}`);
    assert(row.citizen_id === '079204001284', '3.3 Staging citizen_id is 079204001284', `Got: ${row.citizen_id}`);
    assert(row.file_name === 'SWC00814.pdf' || row.file_name.includes('SWC00814'), '3.4 Staging file_name references SWC00814.pdf', `Got: ${row.file_name}`);
    assert(parseInt(row.file_size, 10) > 4000000, '3.5 Staging file_size reflects real file (> 4 MB, not 9 bytes)', `Got: ${row.file_size}`);
    assert(row.date_of_birth === '2004-04-17', '3.6 Staging date_of_birth is 2004-04-17', `Got: ${row.date_of_birth}`);
  }

  // 4. Retained Employees & System Integrity Verification
  console.log('\n--- TEST GROUP 4: Retained Employees Integrity Verification ---');
  const retainRows = queryPgJson("SELECT employee_code, employee_name, company_id, status FROM employees WHERE employee_code IN ('STL00014', 'SWC00025', 'SWC00037')");
  assert(retainRows.length === 3, '4.1 All 3 protected employees exist in database', `Found: ${retainRows.length}`);
  const retainedCodes = retainRows.map(r => r.employee_code).sort();
  assert(JSON.stringify(retainedCodes) === JSON.stringify(['STL00014', 'SWC00025', 'SWC00037']), '4.2 Exactly STL00014, SWC00025, SWC00037 preserved', JSON.stringify(retainedCodes));

  console.log('\n========================================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
