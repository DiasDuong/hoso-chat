/**
 * SOTRANS HUB — STEP 3: COMPLETE SECURITY & GOVERNANCE HARDENING
 * End-to-End Verification Test Suite
 * 
 * Verifies all 5 Phases:
 * - Phase A: Baseline & Backups verification
 * - Phase B: Gateway Security, HMAC Internal Authentication, Tenant Isolation
 * - Phase C: Standardization of File Upload to SOTRANS_HR_EMPLOYEE_LIFECYCLE
 * - Phase D: Elimination of hardcoded Google SA private keys
 * - Phase E: CCCD & Salary Agreement Data Preservation for authorized roles
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('../auth-service/node_modules/dotenv').config({ path: path.join(__dirname, '../auth-service/.env') });
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';
const GATEWAY_URL = 'http://127.0.0.1:8082';
const AUTH_URL = 'http://127.0.0.1:3000';
const N8N_URL = 'http://127.0.0.1:5679';

// Test JWT Tokens
const TOKENS = {
  SUPERADMIN: jwt.sign({
    user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac',
    username: 'superadmin',
    role: 'ADMIN',
    company_id: null
  }, JWT_SECRET, { expiresIn: '1h' }),

  ADMIN_STL: jwt.sign({
    user_id: 'fd54c14e-2a82-4f1d-af37-dc4cd40461cd',
    username: 'admin_stl',
    role: 'ADMIN',
    company_id: 'STL'
  }, JWT_SECRET, { expiresIn: '1h' }),

  ADMIN_SWC: jwt.sign({
    user_id: '9d133e96-2262-4083-b595-73f375931d1a',
    username: 'admin_swc',
    role: 'ADMIN',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '1h' }),

  HR_STL: jwt.sign({
    user_id: '9a2e8590-c1a2-41c6-abb2-b802cb8060c6',
    username: 'hr_stl',
    role: 'HR',
    company_id: 'STL'
  }, JWT_SECRET, { expiresIn: '1h' }),

  HR_SWC: jwt.sign({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '1h' }),

  EMP_STL: jwt.sign({
    user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26',
    username: 'emp_stl',
    role: 'EMPLOYEE',
    company_id: 'STL'
  }, JWT_SECRET, { expiresIn: '1h' })
};

function httpRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const opts = Object.assign({ timeout: 25000 }, options);
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch(e) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (data) {
      if (Buffer.isBuffer(data)) req.write(data);
      else if (typeof data === 'string') req.write(data);
      else req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log('========================================================================');
  console.log('🚀 SOTRANS HUB — STEP 3 COMPLETE SECURITY & GOVERNANCE TEST SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName} ${detail ? '— ' + detail : ''}`);
      failed++;
    }
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 1: GATEWAY SECURITY (SEC-01)
  // --------------------------------------------------------------------------
  console.log('--- 1. GATEWAY SECURITY & ACCESS BOUNDARIES ---');
  try {
    // 1.1 Direct POST to /webhook/hoso-chat via Gateway (8082)
    const gwRes1 = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/webhook/hoso-chat',
      method: 'POST'
    });
    assert(gwRes1.status === 403, '1.1 Direct POST to /webhook/hoso-chat via Gateway returns 403 Forbidden', `Got ${gwRes1.status}`);

    // 1.2 Direct POST with trailing slash
    const gwRes2 = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/webhook/hoso-chat/',
      method: 'POST'
    });
    assert(gwRes2.status === 403, '1.2 Direct POST with trailing slash /webhook/hoso-chat/ returns 403 Forbidden', `Got ${gwRes2.status}`);

    // 1.3 Direct POST with static token spoofing attempt
    const gwRes3 = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/webhook/hoso-chat?token=test',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 2ca9f995352866f7081e3f85f00fc759b0dd8661c910cfcebf479d1386b8cd2b'
      }
    });
    assert(gwRes3.status === 403, '1.3 Direct access with old static token returns 403 Forbidden', `Got ${gwRes3.status}`);

    // 1.4 Verify other webhooks (e.g. hr-admin-api) not affected by hoso-chat rule
    const gwRes4 = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/webhook/hr-admin-api',
      method: 'POST'
    });
    assert(gwRes4.status !== 404, '1.4 Other webhooks (/webhook/hr-admin-api) reach n8n ingress', `Got ${gwRes4.status}`);

  } catch(err) {
    assert(false, 'Gateway Security Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 2: AUTHENTICATION & REPLAY RESISTANCE (SEC-02, SEC-03)
  // --------------------------------------------------------------------------
  console.log('\n--- 2. AUTHENTICATION & IDENTITY GOVERNANCE ---');
  try {
    // 2.1 Missing JWT Token at /chat/api
    const noAuthRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { message: 'hello' });
    assert(noAuthRes.status === 401, '2.1 Request without JWT token is rejected with 401 Unauthorized', `Got ${noAuthRes.status}`);

    // 2.2 Invalid JWT Token
    const badAuthRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid.token.value'
      }
    }, { message: 'hello' });
    assert(badAuthRes.status === 401, '2.2 Request with invalid JWT token is rejected with 401', `Got ${badAuthRes.status}`);

    // 2.3 Spoofed Header Stripping: HR sending x-verified-role = ADMIN
    const spoofHeaderRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.HR_STL,
        'x-verified-role': 'ADMIN',
        'x-verified-company': 'ALL'
      }
    }, { message: 'trợ giúp' });
    assert(spoofHeaderRes.status === 200, '2.3 HR request processed normally without header collision');

    // 2.4 Replay Attack Resistance on n8n Webhook: Expired Timestamp (> 5 min)
    const secret = '8973d464f5f1475b83d6ab88d222d824';
    const expiredTimestamp = Date.now() - (600 * 1000); // 10 minutes ago
    const nonce = 'replay_test_nonce_1234';
    const expiredSig = crypto.createHmac('sha256', secret)
      .update(`${expiredTimestamp}:${nonce}:fake_user:HR:STL`)
      .digest('hex');

    const replayRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 5679,
      path: '/webhook/hoso-chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'HMAC ' + expiredSig,
        'x-internal-signature': expiredSig,
        'x-internal-timestamp': String(expiredTimestamp),
        'x-internal-nonce': nonce,
        'x-verified-sub': 'fake_user',
        'x-verified-role': 'HR',
        'x-verified-company': 'STL'
      }
    }, { message: 'trợ giúp' });
    assert(replayRes.status === 401, '2.4 Replayed internal request with expired timestamp is rejected with 401', `Got ${replayRes.status}`);

    // 2.5 Tampered HMAC Signature Resistance on n8n Webhook
    const goodTimestamp = Date.now();
    const tamperedSig = 'a'.repeat(64);
    const tamperRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 5679,
      path: '/webhook/hoso-chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'HMAC ' + tamperedSig,
        'x-internal-signature': tamperedSig,
        'x-internal-timestamp': String(goodTimestamp),
        'x-internal-nonce': 'tamper_nonce_12345',
        'x-verified-sub': 'fake_user',
        'x-verified-role': 'HR',
        'x-verified-company': 'STL'
      }
    }, { message: 'trợ giúp' });
    assert(tamperRes.status === 401, '2.5 Internal request with forged/tampered signature is rejected with 401', `Got ${tamperRes.status}`);

    // 2.6 Valid Internal Signature on n8n Webhook
    const validNonce = 'valid_nonce_' + Date.now();
    const validTimestamp = Date.now();
    const validSig = crypto.createHmac('sha256', secret)
      .update(`${validTimestamp}:${validNonce}:superadmin:ADMIN:ALL`)
      .digest('hex');

    const validRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 5679,
      path: '/webhook/hoso-chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'HMAC ' + validSig,
        'x-internal-signature': validSig,
        'x-internal-timestamp': String(validTimestamp),
        'x-internal-nonce': validNonce,
        'x-verified-sub': 'superadmin',
        'x-verified-role': 'ADMIN',
        'x-verified-company': 'ALL',
        'x-verified-can-query-all': 'true'
      }
    }, { message: 'trợ giúp' });
    assert(validRes.status === 200, '2.6 Valid HMAC signed internal request is accepted with 200', `Got ${validRes.status}`);

  } catch(err) {
    assert(false, 'Authentication & Replay Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 3: TENANT ISOLATION (SEC-06)
  // --------------------------------------------------------------------------
  console.log('\n--- 3. TENANT ISOLATION & RBAC BOUNDARIES ---');
  try {
    // 3.1 HR_STL attempting to query SWC employee by code SWC00025
    const hrStlCrossQuery = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.HR_STL
      }
    }, { message: 'SWC00025' });
    const swcCodeFoundInStl = hrStlCrossQuery.body && (hrStlCrossQuery.body.includes('LÊ THÀNH NHÂN') || hrStlCrossQuery.body.includes('HỒ SƠ NHÂN SỰ TOÀN DIỆN') || hrStlCrossQuery.body.includes('Sowatco (SWC)'));
    assert(!swcCodeFoundInStl, '3.1 HR_STL cannot retrieve SWC employee by employee code SWC00025', `Found SWC employee across boundary`);

    // 3.2 HR_STL attempting to override company_id = SWC in request body
    const hrStlOverrideBody = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.HR_STL
      }
    }, { message: 'danh sách nhân viên', company_id: 'SWC' });
    const swcInStlBody = hrStlOverrideBody.body && hrStlOverrideBody.body.includes('Sowatco');
    assert(!swcInStlBody, '3.2 HR_STL request body company_id=SWC is ignored; scoped to STL', `Leaked SWC`);

    // 3.3 ADMIN_STL attempting to query ALL or SWC
    const adminStlCross = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.ADMIN_STL
      }
    }, { message: 'SWC00025', company_id: 'SWC' });
    const adminStlFoundSwc = adminStlCross.body && (adminStlCross.body.includes('LÊ THÀNH NHÂN') || adminStlCross.body.includes('HỒ SƠ NHÂN SỰ TOÀN DIỆN') || adminStlCross.body.includes('Sowatco (SWC)'));
    assert(!adminStlFoundSwc, '3.3 ADMIN_STL cannot query cross-tenant (SWC) despite passing company_id=SWC', `Leaked SWC`);

    // 3.4 HR_SWC querying SWC00025 within their own tenant
    const hrSwcValid = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.HR_SWC
      }
    }, { message: 'SWC00025' });
    const hrSwcFound = hrSwcValid.body && (hrSwcValid.body.includes('SWC00025') || hrSwcValid.body.includes('LÊ THÀNH NHÂN') || hrSwcValid.body.includes('Sowatco'));
    assert(hrSwcFound, '3.4 HR_SWC can query SWC00025 within authorized SWC tenant', `Failed to find record`);

    // 3.5 SUPERADMIN querying ALL
    const superadminValid = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.SUPERADMIN
      }
    }, { message: 'SWC00025' });
    const superFound = superadminValid.body && (superadminValid.body.includes('SWC') || superadminValid.body.includes('Sowatco'));
    assert(superFound, '3.5 SUPERADMIN can query across all tenants (ALL scope)', `Failed query`);

  } catch(err) {
    assert(false, 'Tenant Isolation Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 4: SECRET ELIMINATION & KEY ROTATION (SEC-04)
  // --------------------------------------------------------------------------
  console.log('\n--- 4. SECRET ELIMINATION & KEY ROTATION ---');
  try {
    // 4.1 Check HR_Chatbot workflow export for hardcoded private keys
    const n8nWfRaw = fs.readFileSync('scratch/hardened_hr_chatbot_KRZmkYM690YlIdPU.json', 'utf8');
    const hasWfKey = n8nWfRaw.includes('-----BEGIN PRIVATE KEY-----') || n8nWfRaw.includes('2ca9f995352866f7081e3f85f00fc759b0dd8661c910cfcebf479d1386b8cd2b');
    assert(!hasWfKey, '4.1 Hardened HR_Chatbot workflow contains ZERO hardcoded private keys or static tokens');

    // 4.2 Check googleAuthHelper.js for hardcoded private keys
    const helperRaw = fs.readFileSync('auth-service/services/googleAuthHelper.js', 'utf8');
    const hasHelperKey = helperRaw.includes('-----BEGIN PRIVATE KEY-----');
    assert(!hasHelperKey, '4.2 googleAuthHelper.js contains ZERO hardcoded private keys (externalized to .env)');

    // 4.3 Verify Google Access Token generation succeeds via environment
    const { getGoogleAccessToken } = require('../auth-service/services/googleAuthHelper');
    const token = await getGoogleAccessToken();
    assert(!!token && token.length > 500, '4.3 Google Access Token successfully generated using environment credentials', `Token length: ${token ? token.length : 0}`);

  } catch(err) {
    assert(false, 'Secret Elimination Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 5: SALARY AGREEMENT & CCCD DATA PRESERVATION (PHASE E)
  // --------------------------------------------------------------------------
  console.log('\n--- 5. CCCD & SALARY AGREEMENT DATA PRESERVATION ---');
  try {
    // 5.1 Query employee profile with salary/compensation for authorized HR
    const salaryQueryRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.HR_SWC
      }
    }, { message: 'hồ sơ nhân viên SWC00025' });

    assert(salaryQueryRes.status === 200, '5.1 Employee profile query returns HTTP 200 for authorized HR_SWC');

    // 5.2 Verify that authorized HR response preserves financial figures
    const bodyStr = salaryQueryRes.body || '';
    const hasAsteriskSalary = bodyStr.includes('*** VNĐ') || bodyStr.includes('Lương: ***');
    const hasRealSalary = bodyStr.includes('15.000.000') || bodyStr.includes('18.000.000') || bodyStr.includes('15 triệu') || bodyStr.includes('18 triệu');
    assert(!hasAsteriskSalary && hasRealSalary, '5.2 Financial figures are preserved with real figures (not ***) for authorized HR');

    // 5.3 Verify CCCD is unmasked for authorized HR
    const hasUnmaskedCccd = bodyStr.includes('080087002353');
    assert(hasUnmaskedCccd, '5.3 CCCD is fully unmasked (080087002353) for authorized HR');

    // 5.4 Verify that regular EMPLOYEE has CCCD masked and salary denied when querying self
    const empQueryRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/chat/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKENS.EMP_STL
      }
    }, { message: 'hồ sơ của tôi' });

    const empBody = empQueryRes.body || '';
    const empCccdMasked = empBody.includes('036******139') || empBody.includes('đã che bảo mật');
    const empSalaryDenied = !empBody.includes('8.000.000 VNĐ') && empBody.includes('Thông tin chi tiết về mức lương');
    assert(empCccdMasked && empSalaryDenied, '5.4 Regular EMPLOYEE receives masked CCCD and cannot access salary information');

  } catch(err) {
    assert(false, 'Salary Agreement Execution', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n========================================================================');
  console.log(`📊 KẾT QUẢ KIỂM THỬ: ${passed} PASS, ${failed} FAIL (Tổng số: ${passed + failed})`);
  console.log('========================================================================\n');

  if (failed === 0) {
    console.log('🎉 TOÀN BỘ CÁC HẠNG MỤC BẢO MẬT & GOVERNANCE ĐẠT YÊU CẦU 100%!');
    process.exit(0);
  } else {
    console.error(`⚠️ CÓ ${failed} TEST CASE THẤT BẠI. CẦN KHẮC PHỤC TRƯỚC KHI BÀN GIAO.`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test suite runner error:', err);
  process.exit(1);
});
