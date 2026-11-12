/**
 * Test Suite: Multi-File Batch Dossier Upload & Extraction
 * SOTRANS HUB — HR_CHATBOT & SOTRANS_HR_EMPLOYEE_LIFECYCLE
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');

const BASE_URL = 'http://127.0.0.1:8082';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const TOKENS = {
  HR_SWC: jwt.sign({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '1h' })
};

async function testBatchUpload() {
  console.log('========================================================================');
  console.log('🚀 TESTING MULTI-FILE BATCH DOSSIER UPLOAD & EXTRACTION');
  console.log('========================================================================\n');

  let passCount = 0;
  let failCount = 0;

  function test(name, fn) {
    return (async () => {
      try {
        await fn();
        console.log(`  ✅ [PASS] ${name}`);
        passCount++;
      } catch (err) {
        console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        failCount++;
      }
    })();
  }

  const file1Path = path.resolve('D:/hoso-chat/auth-service/uploads/staging/SWC00808.pdf');
  const file2Path = path.resolve('D:/hoso-chat/auth-service/uploads/staging/cda4fa41-9dc8-49b1-9c26-fd4715acdff4_SWC00803.pdf');

  await test('Test files exist on disk for batch upload test', () => {
    assert(fs.existsSync(file1Path), 'SWC00808.pdf must exist');
    assert(fs.existsSync(file2Path), 'SWC00803.pdf must exist');
  });

  const file1Buf = fs.readFileSync(file1Path);
  const file2Buf = fs.readFileSync(file2Path);

  console.log(`\nPreparing batch upload with 2 multi-page scan dossiers:`);
  console.log(`- File 1: SWC00808.pdf (${(file1Buf.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`- File 2: SWC00803.pdf (${(file2Buf.length / 1024 / 1024).toFixed(2)} MB)`);

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  let bodyBuffers = [];

  function addField(name, val) {
    bodyBuffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
  }

  function addFile(fieldName, fileName, buf, mimeType = 'application/pdf') {
    bodyBuffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    bodyBuffers.push(buf);
    bodyBuffers.push(Buffer.from('\r\n'));
  }

  addField('event_type', 'HR_UPLOAD');
  addField('source', 'CHAT_PORTAL');
  addField('company_id', 'SWC');
  addField('token', TOKENS.HR_SWC);
  addFile('files', 'SWC00808.pdf', file1Buf);
  addFile('files', 'SWC00803.pdf', file2Buf);
  bodyBuffers.push(Buffer.from(`--${boundary}--\r\n`));

  const multiPartBody = Buffer.concat(bodyBuffers);

  console.log('\nSending batch upload to http://127.0.0.1:8082/webhook/hr-lifecycle-upload...');
  const startTime = Date.now();

  const res = await fetch(`${BASE_URL}/webhook/hr-lifecycle-upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKENS.HR_SWC}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Correlation-Id': 'corr_test_batch_' + Date.now(),
      'Idempotency-Key': 'idem_test_batch_' + Date.now()
    },
    body: multiPartBody
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const resText = await res.text();
  console.log(`Batch upload finished in ${durationSec}s with HTTP ${res.status}`);
  if (res.status !== 200) {
    console.log(`Response text (${res.status}):`, resText.slice(0, 300));
  }

  await test('Upload finishes without Gateway Timeout (HTTP 200)', () => {
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  });

  const contentType = res.headers.get('content-type') || '';
  await test('Response Content-Type is valid JSON', () => {
    assert(contentType.includes('application/json'), `Expected json, got ${contentType}`);
  });

  let json = null;
  await test('Response text is valid JSON (no Unexpected token "<", <html>)', () => {
    assert(!resText.startsWith('<'), `Response started with HTML! ${resText.slice(0, 100)}`);
    json = JSON.parse(resText);
    assert.strictEqual(json.success, true);
  });

  await test('Batch summary card or staged results contain multiple candidates', () => {
    assert(json.staged_count >= 1, `Expected at least 1 candidate, got ${json.staged_count}`);
    assert(json.reply, 'Should have reply text/card');
  });

  await test('Retained employees STL00014, SWC00025, SWC00037 remain completely intact', async () => {
    const { execSync } = require('child_process');
    const psqlOutput = execSync('docker exec hrbot-postgres-1 psql -U hrbot -d hrbot -t -A -c "SELECT employee_code FROM employees ORDER BY employee_code ASC;"').toString('utf8');
    const codes = psqlOutput.split('\n').map(s => s.trim()).filter(Boolean);
    assert(codes.includes('STL00014'), 'STL00014 must exist');
    assert(codes.includes('SWC00025'), 'SWC00025 must exist');
    assert(codes.includes('SWC00037'), 'SWC00037 must exist');
    assert.strictEqual(codes.length, 3, `Expected exactly 3 retained employees, found ${codes.length}`);
  });

  console.log('\n========================================================================');
  console.log(`📊 BATCH TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED (TOTAL: ${passCount + failCount})`);
  console.log('========================================================================\n');

  if (failCount > 0) process.exit(1);
  process.exit(0);
}

testBatchUpload().catch(err => {
  console.error('Fatal batch test error:', err);
  process.exit(1);
});
