/**
 * SOTRANS HUB — PHASE 2.4 STAGING LIVE UAT & DATA GOVERNANCE VERIFICATION
 * 
 * Verifies live execution against Staging:
 * Host: 127.0.0.1:3001 (sotrans-auth-staging)
 * Database: sotrans_staging (Zero intrusion into HR tables)
 */

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const XLSX = require('../auth-service/node_modules/xlsx');

const STAGING_HOST = '127.0.0.1';
const STAGING_PORT = 3001;

let passed = 0;
let failed = 0;
const results = [];

function request(options, postData = null, isMultipart = false, boundary = null) {
  return new Promise((resolve, reject) => {
    const headers = options.headers || {};
    if (postData && !isMultipart && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    } else if (postData && isMultipart) {
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      headers['Content-Length'] = postData.length;
    }

    const req = http.request(
      {
        hostname: STAGING_HOST,
        port: STAGING_PORT,
        path: options.path,
        method: options.method || 'GET',
        headers: headers,
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(rawBody);
          } catch (e) {
            parsed = rawBody;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            rawBody: rawBody,
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function buildMultipart(filename, fileBuffer, fields = {}) {
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
  const crlf = '\r\n';
  const parts = [];

  for (const [key, val] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${key}"${crlf}${crlf}${val}${crlf}`)
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet${crlf}${crlf}`
    )
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`));

  const payload = Buffer.concat(parts);
  return { payload, boundary };
}

function createMockXlsxBuffer(sheetDataMap) {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, data] of Object.entries(sheetDataMap)) {
    const ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function runScenario(id, name, fn) {
  try {
    await fn();
    passed++;
    results.push({ id, name, status: 'PASS' });
    console.log(`[PASS] Scenario ${String(id).padStart(2, '0')}: ${name}`);
  } catch (err) {
    failed++;
    results.push({ id, name, status: 'FAIL', error: err.message });
    console.error(`[FAIL] Scenario ${String(id).padStart(2, '0')}: ${name}`);
    console.error(`       Error: ${err.message}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log('SOTRANS HUB — PHASE 2.4 LIVE STAGING UAT & GOVERNANCE SUITE');
  console.log(`Target: http://${STAGING_HOST}:${STAGING_PORT} (sotrans-auth-staging)`);
  console.log('================================================================\n');

  let tokenAdminStl = null;
  let tokenHrStl = null;
  let tokenEmpStl = null;
  let tokenEmpVtx = null;
  let tokenDuongduc = null;

  let testFileId = null;
  let prevQueryPlan = null;

  // 1. Live Authentication
  await runScenario(1, 'Authenticate distinct roles (admin_stl, hr_stl, emp_stl, duongduc, emp_vtx)', async () => {
    const loginUser = async (u) => {
      const res = await request(
        { path: '/api/auth/login', method: 'POST' },
        JSON.stringify({ username: u, password: 'password123' })
      );
      if (res.statusCode === 200) return res.body.token;
      const res2 = await request(
        { path: '/api/auth/login', method: 'POST' },
        JSON.stringify({ username: u, password: '123456' })
      );
      assert.strictEqual(res2.statusCode, 200, `Login failed for ${u}`);
      return res2.body.token;
    };

    tokenAdminStl = await loginUser('admin_stl');
    tokenHrStl = await loginUser('hr_stl');
    tokenEmpStl = await loginUser('emp_stl');
    tokenDuongduc = await loginUser('duongduc');
    tokenEmpVtx = await loginUser('emp_vtx');

    assert.ok(tokenAdminStl, 'Admin token missing');
    assert.ok(tokenHrStl, 'HR token missing');
    assert.ok(tokenEmpStl, 'Emp STL token missing');
    assert.ok(tokenDuongduc, 'Duongduc token missing');
    assert.ok(tokenEmpVtx, 'Emp VTX token missing');
  });

  // 2. Multi-sheet XLSX Upload by Employee STL
  await runScenario(2, 'UAT File Intake: emp_stl uploads multi-sheet XLSX dataset', async () => {
    const xlsxBuf = createMockXlsxBuffer({
      TongHop: [
        ['PhongBan', 'DoanhSo', 'ChiPhi'],
        ['Kinh Doanh', 100000000, 30000000],
        ['Logistics', 50000000, 15000000],
        ['Kho Van', 30000000, 10000000],
        ['Tai Chinh', 20000000, 5000000],
      ],
      NhanSu: [
        ['HoTen', 'PhongBan', 'Luong'],
        ['Nguyen Van A', 'Kinh Doanh', 25000000],
        ['Tran Van B', 'Logistics', 18000000],
      ],
    });

    const { payload, boundary } = buildMultipart('doanh_so_q4_uat.xlsx', xlsxBuf);
    const res = await request(
      {
        path: '/api/bi/files/upload',
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenEmpStl}` },
      },
      payload,
      true,
      boundary
    );

    assert.strictEqual(res.statusCode, 200, `Upload failed: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    const ds = res.body.dataset || res.body;
    assert.ok(ds.file_id, 'file_id missing');
    assert.strictEqual(ds.original_filename, 'doanh_so_q4_uat.xlsx');
    assert.strictEqual(ds.profile.sheets.length, 2);
    assert.strictEqual(ds.profile.row_count, 4);

    testFileId = ds.file_id;
  });

  // 3. Preview Rows
  await runScenario(3, 'Data Preview API: emp_stl retrieves preview rows', async () => {
    const res = await request({
      path: `/api/bi/files/${testFileId}/preview`,
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenEmpStl}` },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.preview_rows.length, 4);
    assert.strictEqual(res.body.preview_rows[0].phongban, 'Kinh Doanh');
  });

  // 4. Natural Language Query
  await runScenario(4, 'Natural Language Query (/ask): "Tổng doanh số theo phòng ban"', async () => {
    const res = await request(
      {
        path: `/api/bi/files/${testFileId}/ask`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenEmpStl}` },
      },
      JSON.stringify({ prompt: 'Tổng doanh số theo phòng ban' })
    );

    assert.strictEqual(res.statusCode, 200, `Ask failed: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.plan, 'Plan missing');
    assert.strictEqual(res.body.returned_rows, 4);
    assert.ok(res.body.presentation, 'Presentation markdown missing');
    assert.ok(res.body.presentation.includes('Kinh Doanh'));

    prevQueryPlan = res.body.plan;
  });

  // 5. Multi-turn Follow-up Query
  await runScenario(5, 'Multi-turn follow-up: "Chỉ lấy phòng Kinh Doanh"', async () => {
    const res = await request(
      {
        path: `/api/bi/files/${testFileId}/ask`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenEmpStl}` },
      },
      JSON.stringify({
        prompt: 'Chỉ lấy phòng Kinh Doanh',
        conversationContext: { previousQueryPlan: prevQueryPlan },
      })
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.returned_rows, 1);
    assert.strictEqual(res.body.results[0].phongban, 'Kinh Doanh');
  });

  // 6. Empty State Presentation
  await runScenario(6, 'Empty State handling when query returns 0 rows', async () => {
    const res = await request(
      {
        path: `/api/bi/files/${testFileId}/ask`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenEmpStl}` },
      },
      JSON.stringify({
        prompt: 'Doanh số trên 500 triệu',
      })
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.returned_rows, 0);
    assert.ok(res.body.presentation.includes('Không tìm thấy bản ghi nào phù hợp'));
  });

  // 7. File Sharing: Grant View Only to duongduc
  await runScenario(7, 'File Sharing: emp_stl shares view access to duongduc', async () => {
    const res = await request(
      {
        path: `/api/bi/files/${testFileId}/share`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenEmpStl}` },
      },
      JSON.stringify({
        target_type: 'user',
        target_id: 'duongduc',
        permission: 'view',
      })
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);

    // duongduc can view metadata
    const metaRes = await request({
      path: `/api/bi/files/${testFileId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenDuongduc}` },
    });
    assert.strictEqual(metaRes.statusCode, 200);

    // duongduc CANNOT query (must receive 403 INSUFFICIENT_PERMISSION)
    const queryRes = await request(
      {
        path: `/api/bi/files/${testFileId}/query`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenDuongduc}` },
      },
      JSON.stringify({
        aggregations: [{ column: 'doanhso', func: 'SUM' }],
      })
    );
    assert.strictEqual(queryRes.statusCode, 403);
    assert.ok(queryRes.body.error.includes('INSUFFICIENT_PERMISSION') || queryRes.body.error.includes('quyền xem'));
  });

  // 8. Upgrade Permission to Query
  await runScenario(8, 'File Sharing: Upgrade duongduc permission to query', async () => {
    const res = await request(
      {
        path: `/api/bi/files/${testFileId}/share`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenEmpStl}` },
      },
      JSON.stringify({
        target_type: 'user',
        target_id: 'duongduc',
        permission: 'query',
      })
    );
    assert.strictEqual(res.statusCode, 200);

    // duongduc can now execute query successfully
    const queryRes = await request(
      {
        path: `/api/bi/files/${testFileId}/query`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenDuongduc}` },
      },
      JSON.stringify({
        aggregations: [{ column: 'doanhso', func: 'SUM' }],
      })
    );
    assert.strictEqual(queryRes.statusCode, 200);
    assert.ok(queryRes.body.results.length >= 1);
  });

  // 9. Instantaneous Revocation
  await runScenario(9, 'Instantaneous Revocation: Revoke duongduc access cuts query instantly (403)', async () => {
    const unshareRes = await request(
      {
        path: `/api/bi/files/${testFileId}/unshare`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenEmpStl}` },
      },
      JSON.stringify({
        target_id: 'duongduc',
      })
    );
    assert.strictEqual(unshareRes.statusCode, 200);

    // duongduc immediately blocked from query (403)
    const queryRes = await request(
      {
        path: `/api/bi/files/${testFileId}/query`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenDuongduc}` },
      },
      JSON.stringify({
        aggregations: [{ column: 'doanhso', func: 'SUM' }],
      })
    );
    assert.strictEqual(queryRes.statusCode, 403);
  });

  // 10. Cross-Tenant IDOR Block
  await runScenario(10, 'Tenant Boundary (IDOR Block): emp_vtx cannot access STL dataset', async () => {
    const res = await request({
      path: `/api/bi/files/${testFileId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenEmpVtx}` },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.body.error.includes('TENANT_MISMATCH') || res.body.error.includes('đơn vị'));
  });

  // 11. Non-Owner Cannot Delete
  await runScenario(11, 'Access Control: Non-owner cannot delete dataset (403)', async () => {
    const res = await request({
      path: `/api/bi/files/${testFileId}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenDuongduc}` },
    });
    assert.strictEqual(res.statusCode, 403);
  });

  // 12. Admin Cross-Tenant Access
  await runScenario(12, 'Admin Access: admin_stl has full access to dataset', async () => {
    const res = await request(
      {
        path: `/api/bi/files/${testFileId}/query`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenAdminStl}` },
      },
      JSON.stringify({
        aggregations: [{ column: 'doanhso', func: 'SUM' }],
      })
    );
    assert.strictEqual(res.statusCode, 200);
  });

  // 13. Audit Trail Inspection
  await runScenario(13, 'Audit Trail (/audit): Verify logged lifecycle events & zero PII leak', async () => {
    const res = await request({
      path: `/api/bi/files/${testFileId}/audit`,
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAdminStl}` },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.logs));
    assert.ok(res.body.logs.length >= 3, `Expected at least 3 audit logs, got ${res.body.logs.length}`);

    const events = res.body.logs.map((l) => l.event || l.event_type);
    assert.ok(events.includes('FILE_UPLOAD'));
    assert.ok(events.includes('DATASET_QUERY'));
    assert.ok(events.includes('DATASET_SHARE'));

    // Check zero PII or raw rows
    for (const log of res.body.logs) {
      if (log.details) {
        assert.strictEqual(log.details.raw_rows, undefined);
        assert.strictEqual(log.details.cell_content, undefined);
        assert.strictEqual(log.details.cccd, undefined);
      }
    }
  });

  // 14. Dataset Deletion
  await runScenario(14, 'Dataset Deletion: emp_stl deletes dataset permanently', async () => {
    const res = await request({
      path: `/api/bi/files/${testFileId}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenEmpStl}` },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);

    // Subsequent access returns 404
    const checkRes = await request({
      path: `/api/bi/files/${testFileId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenEmpStl}` },
    });
    assert.strictEqual(checkRes.statusCode, 404);
  });

  // 15. General AI & Normal Chat Coexistence
  await runScenario(15, 'Coexistence: Ordinary health & auth services intact', async () => {
    const health = await request({ path: '/health', method: 'GET' });
    assert.strictEqual(health.statusCode, 200);
  });

  console.log('\n================================================================');
  console.log(`STAGING LIVE UAT EXECUTION SUMMARY: ${passed} / ${passed + failed} PASS | ${failed} FAIL`);
  console.log('Production Environment Connection: NONE (Zero Production Touch)');
  console.log('Target Database: sotrans_staging (Port 5433)');
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
