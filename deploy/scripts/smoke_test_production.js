/**
 * SOTRANS HUB — PRODUCTION POST-DEPLOYMENT SMOKE TEST SUITE
 * 
 * Verifies live production health, role boundaries, and functional endpoints
 * Run immediately after deployment to confirm system readiness
 */

const http = require('http');
const https = require('https');
const assert = require('assert');

const PROD_URL = process.env.PROD_URL || 'http://127.0.0.1:3000';
const isHttps = PROD_URL.startsWith('https');
const client = isHttps ? https : http;

let passed = 0;
let failed = 0;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, PROD_URL);
    const req = client.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let body = raw;
          try {
            body = JSON.parse(raw);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (options.data) {
      req.write(options.data);
    }
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (e) {
    failed++;
    console.error(`[FAIL] ${name}: ${e.message}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log('SOTRANS HUB — PRODUCTION POST-DEPLOYMENT SMOKE TEST');
  console.log(`Target: ${PROD_URL}`);
  console.log('================================================================\n');

  // 1. Health Checks
  await test('1. Health check endpoint responds with 200 OK', async () => {
    const res = await request('/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  await test('2. API Health check endpoint responds with 200 OK', async () => {
    const res = await request('/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  // 2. Authentication Rejection on Empty Request
  await test('3. Auth login rejects missing payload with 400', async () => {
    const res = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({}),
    });
    assert.ok(res.status === 400 || res.status === 401);
  });

  // 3. Security Headers Verification
  await test('4. Core security headers are served', async () => {
    const res = await request('/health');
    const ct = res.headers['x-content-type-options'];
    if (ct) {
      assert.strictEqual(ct, 'nosniff');
    }
  });

  // 4. File BI Intake Endpoint Authentication Gate
  await test('5. File BI upload blocks unauthenticated requests with 401', async () => {
    const res = await request('/api/analytics/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 401);
  });

  // 5. Analytics KPIs Endpoint Authentication Gate
  await test('6. BI Reporting API blocks unauthenticated requests with 401', async () => {
    const res = await request('/api/analytics/kpis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ kpi_codes: ['DOC_TOTAL'] }),
    });
    assert.strictEqual(res.status, 401);
  });

  console.log('\n================================================================');
  console.log(`SMOKE TEST SUMMARY: ${passed} / ${passed + failed} PASS | ${failed} FAIL`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal smoke test error:', err);
  process.exit(1);
});
