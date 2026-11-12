/**
 * Test Suite: Employee Dossier File Viewing & Download Feature
 * SOTRANS HUB — HR_CHATBOT & HR_ADMIN
 */

const assert = require('assert');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const BASE_URL = 'http://127.0.0.1:8082';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const TOKENS = {
  SUPERADMIN: jwt.sign({ user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac', username: 'superadmin', role: 'ADMIN', company_id: 'ALL' }, JWT_SECRET, { expiresIn: '1h' }),
  HR_SWC: jwt.sign({ user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548', username: 'hr_swc', role: 'HR', company_id: 'SWC' }, JWT_SECRET, { expiresIn: '1h' }),
  HR_STL: jwt.sign({ user_id: '9a2e8590-c1a2-41c6-abb2-b802cb8060c6', username: 'hr_stl', role: 'HR', company_id: 'STL' }, JWT_SECRET, { expiresIn: '1h' })
};

async function testFiles() {
  console.log('========================================================================');
  console.log('🚀 TESTING EMPLOYEE DOSSIER FILE VIEW & DOWNLOAD FEATURE');
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

  // Target files under test
  const testCases = [
    { code: 'SWC00037', name: 'NGÔ ĐẶNG TUẤN UYÊN', fileName: 'SWC00808.pdf', minSize: 2000000, token: TOKENS.HR_SWC },
    { code: 'SWC00025', name: 'LÊ THÀNH NHÂN', fileName: 'SWC00802.pdf', minSize: 3000000, token: TOKENS.HR_SWC },
    { code: 'STL00014', name: 'NGUYỄN TRƯỜNG NAM', fileName: 'SWC00810.pdf', minSize: 3000000, token: TOKENS.HR_STL }
  ];

  for (const tc of testCases) {
    // 1. View mode via filename endpoint
    await test(`View ${tc.fileName} by filename (inline disposition)`, async () => {
      const res = await fetch(`${BASE_URL}/api/employees/file/${tc.fileName}`, {
        headers: { Authorization: `Bearer ${tc.token}` }
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
      assert(res.headers.get('content-disposition').includes('inline'), 'Should have inline disposition');
      assert(res.headers.get('content-disposition').includes(tc.fileName), 'Should contain filename');
      const buf = await res.arrayBuffer();
      assert(buf.byteLength >= tc.minSize, `Size ${buf.byteLength} should be >= ${tc.minSize}`);
    });

    // 2. Download mode via filename endpoint
    await test(`Download ${tc.fileName} by filename (?download=1)`, async () => {
      const res = await fetch(`${BASE_URL}/api/employees/file/${tc.fileName}?download=1`, {
        headers: { Authorization: `Bearer ${tc.token}` }
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
      assert(res.headers.get('content-disposition').includes('attachment'), 'Should have attachment disposition');
      assert(res.headers.get('content-disposition').includes(tc.fileName), 'Should contain filename');
    });

    // 3. View mode via employee code endpoint
    await test(`View file for employee ${tc.code} (/api/employees/${tc.code}/file)`, async () => {
      const res = await fetch(`${BASE_URL}/api/employees/${tc.code}/file`, {
        headers: { Authorization: `Bearer ${tc.token}` }
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
      assert(res.headers.get('content-disposition').includes('inline'), 'Should have inline disposition');
    });

    // 4. Download mode via employee code endpoint
    await test(`Download file for employee ${tc.code} (/api/employees/${tc.code}/file?download=1)`, async () => {
      const res = await fetch(`${BASE_URL}/api/employees/${tc.code}/file?download=1`, {
        headers: { Authorization: `Bearer ${tc.token}` }
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert(res.headers.get('content-disposition').includes('attachment'), 'Should have attachment disposition');
    });

    // 5. Query param token access (for browser iframe and new-tab preview)
    await test(`Access ${tc.fileName} via query param ?token=... (browser target="_blank" compatible)`, async () => {
      const res = await fetch(`${BASE_URL}/api/employees/${tc.code}/file?token=${tc.token}`);
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
      assert(res.headers.get('content-disposition').includes('inline'), 'Should have inline disposition');
    });
  }

  // 6. Documents listing endpoint
  await test(`List documents for employee SWC00025`, async () => {
    const res = await fetch(`${BASE_URL}/api/employees/SWC00025/documents`, {
      headers: { Authorization: `Bearer ${TOKENS.HR_SWC}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert(Array.isArray(data.documents) && data.documents.length > 0, 'Should return documents');
    const docNames = data.documents.map(d => d.file_name);
    assert(docNames.includes('SWC00802.pdf'), 'Should include SWC00802.pdf');
  });

  // 7. Security: Unauthenticated request rejected
  await test(`Unauthenticated request without token is rejected with 401`, async () => {
    const res = await fetch(`${BASE_URL}/api/employees/file/SWC00808.pdf`);
    assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
  });

  // 8. Security: Cross-tenant isolation (HR_STL cannot view SWC file)
  await test(`Tenant isolation: HR_STL cannot access SWC file (SWC00808.pdf) -> 403`, async () => {
    const res = await fetch(`${BASE_URL}/api/employees/file/SWC00808.pdf`, {
      headers: { Authorization: `Bearer ${TOKENS.HR_STL}` }
    });
    assert.strictEqual(res.status, 403, `Expected 403, got ${res.status}`);
  });

  // 9. Security: Cross-tenant isolation (HR_SWC cannot view STL file)
  await test(`Tenant isolation: HR_SWC cannot access STL file (SWC00810.pdf) -> 403`, async () => {
    const res = await fetch(`${BASE_URL}/api/employees/file/SWC00810.pdf`, {
      headers: { Authorization: `Bearer ${TOKENS.HR_SWC}` }
    });
    assert.strictEqual(res.status, 403, `Expected 403, got ${res.status}`);
  });

  // 10. Superadmin can access files across all tenants
  await test(`Superadmin can access files from all tenants (SWC00808 and SWC00810)`, async () => {
    const res1 = await fetch(`${BASE_URL}/api/employees/file/SWC00808.pdf`, {
      headers: { Authorization: `Bearer ${TOKENS.SUPERADMIN}` }
    });
    const res2 = await fetch(`${BASE_URL}/api/employees/file/SWC00810.pdf`, {
      headers: { Authorization: `Bearer ${TOKENS.SUPERADMIN}` }
    });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res2.status, 200);
  });

  console.log('\n========================================================================');
  console.log(`📊 TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED (TOTAL: ${passCount + failCount})`);
  console.log('========================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

testFiles();
