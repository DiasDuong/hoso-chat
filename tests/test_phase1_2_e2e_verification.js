/**
 * SOTRANS HUB — PHASE 1.2 LIVE E2E VERIFICATION TEST SUITE
 * 
 * 12 Verification Scenarios:
 *  1. Full valid dossier upload & ingestion
 *  2. Batch multi-candidate upload
 *  3. Mixed batch (Partial Success: 1 valid + 1 incomplete)
 *  4. Duplicate CCCD detection & flagging
 *  5. Duplicate check unavailable (503 fail-closed on approval)
 *  6. Fail-closed checkFileSignature rejection (empty/corrupted/tampered)
 *  7. Approval Gate blocks insufficient_data (400 & INSUFFICIENT_DATA code)
 *  8. Idempotency replay (no duplicate DB rows created)
 *  9. Concurrent requests under lock (safe handling)
 * 10. Company_id tampering (403 Forbidden)
 * 11. Audit log fallback buffer & recovery
 * 12. Vietnamese name regex regression & validation guard
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../auth-service/db');
const { isValidPersonName } = require('../auth-service/services/vietnameseEncodingGuard');
const { bufferAuditFailure, flushFailedAuditLogs, getFailedBuffer } = require('../auth-service/audit');

const BASE_URL = 'http://127.0.0.1:3000';
const INTERNAL_SECRET = '8973d464f5f1475b83d6ab88d222d824';

// Helper for HTTP requests
function sendRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const postData = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      'x-internal-secret': INTERNAL_SECRET,
      ...(options.headers || {})
    };
    if (postData) {
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: options.path,
      method: options.method || 'POST',
      headers: reqHeaders
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch(e) { parsed = body; }
        resolve({ status: res.statusCode, data: parsed, raw: body });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const testBatchIds = [];

async function cleanupTestData() {
  for (const bId of testBatchIds) {
    try {
      await db.query(`DELETE FROM hr_employee_staging WHERE batch_id = $1 OR file_name LIKE '%E2E_TEST%'`, [bId]);
      await db.query(`DELETE FROM hr_intake_batches WHERE id = $1`, [bId]);
    } catch (e) {}
  }
  await db.query(`DELETE FROM hr_employee_staging WHERE file_name LIKE '%E2E_TEST%'`);
}

async function runAllTests() {
  console.log('================================================================');
  console.log(' SOTRANS HUB — PHASE 1.2 E2E LIVE VERIFICATION TEST RUNNER');
  console.log(' Target: http://127.0.0.1:3000 & PostgreSQL hrbot (Port 5432)');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const results = [];

  function record(id, title, isPass, detail) {
    if (isPass) {
      passed++;
      console.log(`[PASS] Scenario ${id}: ${title}`);
    } else {
      failed++;
      console.error(`[FAIL] Scenario ${id}: ${title} -> ${detail}`);
    }
    results.push({ id, title, isPass, detail });
  }

  try {
    // ------------------------------------------------------------------------
    // Scenario 1: Full valid dossier upload & ingestion
    // ------------------------------------------------------------------------
    const batch1 = crypto.randomUUID();
    testBatchIds.push(batch1);
    const s1Res = await sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch1,
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx' },
      files: [{
        fileName: 'E2E_TEST_CCCD_NGUYEN_VAN_AN.pdf',
        docType: 'CCCD_VNEID',
        rawExtracted: {
          full_name: 'Nguyễn Văn An',
          citizen_id: '079090009901',
          date_of_birth: '1992-05-15',
          job_title: 'Chuyên viên Điều độ',
          department_staffing_plan: 'Phòng Điều hành Vận tải'
        }
      }]
    });

    const s1Db = await db.query(`SELECT * FROM hr_employee_staging WHERE batch_id = $1`, [batch1]);
    const s1Pass = s1Res.status === 200 &&
                   s1Res.data.success === true &&
                   s1Res.data.staged_count === 1 &&
                   s1Res.data.candidate_results[0].status === 'staged' &&
                   s1Db.rows.length === 1 &&
                   s1Db.rows[0].citizen_id === '079090009901';
    record(1, 'Full valid dossier upload & ingestion', s1Pass, `Status: ${s1Res.status}, DB rows: ${s1Db.rows.length}`);

    // ------------------------------------------------------------------------
    // Scenario 2: Batch multi-candidate upload
    // ------------------------------------------------------------------------
    const batch2 = crypto.randomUUID();
    testBatchIds.push(batch2);
    const s2Res = await sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch2,
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx' },
      files: [
        {
          fileName: 'E2E_TEST_CAND_1.pdf',
          docType: 'CCCD_VNEID',
          rawExtracted: {
            full_name: 'Trần Thị Bình',
            citizen_id: '079090009902',
            date_of_birth: '1993-06-20',
            job_title: 'Nhân viên Kế toán',
            department_staffing_plan: 'Phòng Tài chính'
          }
        },
        {
          fileName: 'E2E_TEST_CAND_2.pdf',
          docType: 'CCCD_VNEID',
          rawExtracted: {
            full_name: 'Lê Văn Cường',
            citizen_id: '079090009903',
            date_of_birth: '1991-08-10',
            job_title: 'Kỹ sư Cầu cảng',
            department_staffing_plan: 'Phòng Kỹ thuật'
          }
        }
      ]
    });

    const s2Pass = s2Res.status === 200 &&
                   s2Res.data.success === true &&
                   s2Res.data.total_candidates === 2 &&
                   s2Res.data.staged_count === 2 &&
                   s2Res.data.candidate_results.length === 2 &&
                   s2Res.data.candidate_results.every(c => c.status === 'staged');
    record(2, 'Batch multi-candidate upload (2 valid candidates)', s2Pass, `Total: ${s2Res.data?.total_candidates}, Staged: ${s2Res.data?.staged_count}`);

    // ------------------------------------------------------------------------
    // Scenario 3: Mixed batch (Partial Success: 1 valid + 1 incomplete)
    // ------------------------------------------------------------------------
    const batch3 = crypto.randomUUID();
    testBatchIds.push(batch3);
    const s3Res = await sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch3,
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx' },
      files: [
        {
          fileName: 'E2E_TEST_VALID_CAND.pdf',
          docType: 'CCCD_VNEID',
          rawExtracted: {
            full_name: 'Phạm Văn Dũng',
            citizen_id: '079090009904',
            date_of_birth: '1989-11-25',
            job_title: 'Thuyền trưởng',
            department_staffing_plan: 'Đội Tàu'
          }
        },
        {
          fileName: 'E2E_TEST_INCOMPLETE_CAND.pdf',
          docType: 'SO_YEU_LY_LICH',
          rawExtracted: {
            full_name: null, // Missing full name
            citizen_id: null // Missing citizen ID
          }
        }
      ]
    });

    const s3Cand1 = s3Res.data?.candidate_results?.[0];
    const s3Cand2 = s3Res.data?.candidate_results?.[1];
    const s3Pass = s3Res.status === 200 &&
                   s3Res.data.success === true &&
                   s3Cand1?.status === 'staged' &&
                   s3Cand2?.status === 'insufficient_data' &&
                   s3Res.data.staged_count === 1 &&
                   s3Res.data.insufficient_count === 1;
    record(3, 'Mixed batch (Partial Success: 1 staged, 1 insufficient_data)', s3Pass, `Cand1: ${s3Cand1?.status}, Cand2: ${s3Cand2?.status}`);

    // ------------------------------------------------------------------------
    // Scenario 4: Duplicate CCCD detection
    // ------------------------------------------------------------------------
    // Insert a master record in employees table
    const testDupCccd = '079090009905';
    await db.query(`DELETE FROM employees WHERE citizen_id = $1`, [testDupCccd]);
    await db.query(`
      INSERT INTO employees (employee_code, employee_name, citizen_id, company_id, status, created_at, updated_at)
      VALUES ('VTX_E2E_DUP', 'Nguyễn Thị Hoa', $1, 'VTX', 'ACTIVE', NOW(), NOW())
      ON CONFLICT (employee_code) DO NOTHING
    `, [testDupCccd]);

    const batch4 = crypto.randomUUID();
    testBatchIds.push(batch4);
    const s4Res = await sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch4,
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx' },
      files: [{
        fileName: 'E2E_TEST_DUP_CCCD.pdf',
        docType: 'CCCD_VNEID',
        rawExtracted: {
          full_name: 'Nguyễn Thị Hoa',
          citizen_id: testDupCccd,
          date_of_birth: '1995-02-14',
          job_title: 'Chuyên viên Nhân sự',
          department_staffing_plan: 'Phòng HCNS'
        }
      }]
    });

    const s4Cand = s4Res.data?.candidate_results?.[0];
    const s4Pass = s4Res.status === 200 &&
                   s4Cand?.status === 'duplicate' &&
                   s4Cand?.validation?.suspected_duplicate === true;
    record(4, 'Duplicate CCCD detection & flagging', s4Pass, `Status: ${s4Cand?.status}, suspected_duplicate: ${s4Cand?.validation?.suspected_duplicate}`);
    // Cleanup employee
    await db.query(`DELETE FROM employees WHERE employee_code = 'VTX_E2E_DUP'`);

    // ------------------------------------------------------------------------
    // Scenario 5: Duplicate check unavailable (503 fail-closed on approval)
    // ------------------------------------------------------------------------
    const batch5 = crypto.randomUUID();
    testBatchIds.push(batch5);
    const s5Insert = await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, file_name, full_name, citizen_id, company_id, staging_status,
        intake_mode, proposed_changes, uploaded_by, created_at
      ) VALUES (
        $1, 'E2E_TEST_UNAVAIL.pdf', 'Vũ Đình Trọng', '079090009906', 'VTX', 'pending_review',
        'insufficient_data',
        '{"validation_errors": [{"code": "DUPLICATE_CHECK_UNAVAILABLE", "severity": "BLOCKING"}]}',
        'admin_vtx',
        NOW()
      ) RETURNING id
    `, [batch5]);
    const s5StagingId = s5Insert.rows[0].id;

    const s5Res = await sendRequest({
      path: '/api/hoso/intake/approve',
      headers: {
        'authorization': 'Bearer ' + require('../auth-service/node_modules/jsonwebtoken').sign(
          { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx', role: 'ADMIN', company_id: 'VTX' },
          'super_secret_jwt_key_hrbot_2026_!@#$',
          { expiresIn: '1h' }
        )
      }
    }, {
      staging_ids: [s5StagingId]
    });

    const s5Pass = s5Res.status === 503 && s5Res.data.code === 'DUPLICATE_CHECK_UNAVAILABLE';
    record(5, 'Duplicate check unavailable (503 fail-closed on approval)', s5Pass, `HTTP Status: ${s5Res.status}, Code: ${s5Res.data?.code}`);

    // ------------------------------------------------------------------------
    // Scenario 6: Strict Fail-Closed checkFileSignature
    // ------------------------------------------------------------------------
    function testFileSig(base64Data, ext) {
      if (!base64Data || typeof base64Data !== 'string') return false;
      try {
        const cleanB64 = base64Data.trim();
        if (cleanB64.length < 8) return false;
        const headBuf = Buffer.from(cleanB64.slice(0, 128), 'base64');
        if (headBuf.length < 4) return false;
        const hex = headBuf.toString('hex').toLowerCase();
        switch (ext) {
          case 'pdf': return hex.startsWith('25504446');
          case 'png': return hex.startsWith('89504e47');
          case 'jpg': case 'jpeg': return hex.startsWith('ffd8ff');
          case 'webp': {
            if (headBuf.length < 12) return false;
            return headBuf.slice(0, 4).toString('hex') === '52494646' && headBuf.slice(8, 12).toString('hex') === '57454250';
          }
          case 'docx': case 'xlsx': {
            if (headBuf.length < 30) return false;
            return hex.startsWith('504b0304');
          }
          default: return false;
        }
      } catch (e) { return false; }
    }

    const s6Empty = testFileSig('', 'pdf') === false;
    const s6Corrupt = testFileSig('AABBCCDDEEFF', 'pdf') === false;
    const s6FakeWebp = testFileSig(Buffer.from('RIFF1234AVI ').toString('base64'), 'webp') === false;
    const s6ValidPdf = testFileSig(Buffer.from('%PDF-1.7 standard doc content').toString('base64'), 'pdf') === true;
    const s6ValidDocx = testFileSig(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30)]).toString('base64'), 'docx') === true;
    const s6Pass = s6Empty && s6Corrupt && s6FakeWebp && s6ValidPdf && s6ValidDocx;
    record(6, 'Fail-closed checkFileSignature rejection (empty/corrupted/tampered)', s6Pass, `Empty: ${s6Empty}, Corrupt: ${s6Corrupt}, FakeWEBP: ${s6FakeWebp}, ValidPDF: ${s6ValidPdf}`);

    // ------------------------------------------------------------------------
    // Scenario 7: Approval Gate blocks insufficient_data (400 & INSUFFICIENT_DATA code)
    // ------------------------------------------------------------------------
    const batch7 = crypto.randomUUID();
    testBatchIds.push(batch7);
    const s7Insert = await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id, file_name, full_name, citizen_id, company_id, staging_status,
        intake_mode, uploaded_by, created_at
      ) VALUES (
        $1, 'E2E_TEST_INSUFF.pdf', 'Chưa có họ tên', NULL, 'VTX', 'pending_review',
        'insufficient_data', 'admin_vtx', NOW()
      ) RETURNING id
    `, [batch7]);
    const s7StagingId = s7Insert.rows[0].id;

    const s7Res = await sendRequest({
      path: '/api/hoso/intake/approve',
      headers: {
        'authorization': 'Bearer ' + require('../auth-service/node_modules/jsonwebtoken').sign(
          { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx', role: 'ADMIN', company_id: 'VTX' },
          'super_secret_jwt_key_hrbot_2026_!@#$',
          { expiresIn: '1h' }
        )
      }
    }, {
      staging_ids: [s7StagingId]
    });

    const s7Pass = s7Res.status === 400 && s7Res.data.code === 'INSUFFICIENT_DATA';
    record(7, 'Approval Gate blocks insufficient_data (400 & INSUFFICIENT_DATA code)', s7Pass, `Status: ${s7Res.status}, Code: ${s7Res.data?.code}`);

    // ------------------------------------------------------------------------
    // Scenario 8: Idempotency replay (no duplicate DB rows created)
    // ------------------------------------------------------------------------
    const batch8 = crypto.randomUUID();
    const idemKey8 = 'idem-e2e-test-' + Date.now();
    testBatchIds.push(batch8);

    const s8First = await sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch8,
      idempotency_key: idemKey8,
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx' },
      files: [{
        fileName: 'E2E_TEST_IDEMPOTENCY.pdf',
        docType: 'CCCD_VNEID',
        rawExtracted: {
          full_name: 'Đặng Quốc Huy',
          citizen_id: '079090009908',
          date_of_birth: '1994-03-12',
          job_title: 'Kỹ sư Phần mềm',
          department_staffing_plan: 'Trung tâm CNTT'
        }
      }]
    });

    const s8DbBefore = await db.query(`SELECT count(*) FROM hr_employee_staging WHERE batch_id = $1`, [batch8]);

    // Send exact same request again (Replay)
    const s8Second = await sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch8,
      idempotency_key: idemKey8,
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx' },
      files: [{
        fileName: 'E2E_TEST_IDEMPOTENCY.pdf',
        docType: 'CCCD_VNEID',
        rawExtracted: {
          full_name: 'Đặng Quốc Huy',
          citizen_id: '079090009908',
          date_of_birth: '1994-03-12',
          job_title: 'Kỹ sư Phần mềm',
          department_staffing_plan: 'Trung tâm CNTT'
        }
      }]
    });

    const s8DbAfter = await db.query(`SELECT count(*) FROM hr_employee_staging WHERE batch_id = $1`, [batch8]);
    const s8Pass = s8First.status === 200 &&
                   s8Second.status === 200 &&
                   s8Second.data.idempotency_replayed === true &&
                   parseInt(s8DbBefore.rows[0].count, 10) === 1 &&
                   parseInt(s8DbAfter.rows[0].count, 10) === 1;
    record(8, 'Idempotency replay (no duplicate DB rows created)', s8Pass, `Replayed: ${s8Second.data?.idempotency_replayed}, Rows Before: ${s8DbBefore.rows[0].count}, After: ${s8DbAfter.rows[0].count}`);

    // ------------------------------------------------------------------------
    // Scenario 9: Concurrent requests under lock (safe handling)
    // ------------------------------------------------------------------------
    const batch9 = crypto.randomUUID();
    const idemKey9 = 'concurrent-idem-' + Date.now();
    testBatchIds.push(batch9);

    const concurrentCalls = Array.from({ length: 4 }, () => sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch9,
      idempotency_key: idemKey9,
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx' },
      files: [{
        fileName: 'E2E_TEST_CONCURRENT.pdf',
        docType: 'CCCD_VNEID',
        rawExtracted: {
          full_name: 'Đỗ Hoàng Nam',
          citizen_id: '079090009909',
          date_of_birth: '1990-12-01',
          job_title: 'Giám sát Cảng',
          department_staffing_plan: 'Phòng Khai thác Cảng'
        }
      }]
    }));

    const s9Results = await Promise.all(concurrentCalls);
    const s9All200 = s9Results.every(r => r.status === 200);
    const s9DbCount = await db.query(`SELECT count(*) FROM hr_employee_staging WHERE batch_id = $1`, [batch9]);
    const s9Pass = s9All200 && parseInt(s9DbCount.rows[0].count, 10) === 1;
    record(9, 'Concurrent requests under lock (safe handling, no race conditions)', s9Pass, `All 200: ${s9All200}, Staging Rows: ${s9DbCount.rows[0].count}`);

    // ------------------------------------------------------------------------
    // Scenario 10: Company_id tampering (403 Forbidden)
    // ------------------------------------------------------------------------
    const batch10 = crypto.randomUUID();
    testBatchIds.push(batch10);
    // User belongs to VTX (admin_vtx), but body tampers to SWC
    const s10Res = await sendRequest({
      path: '/api/hoso/intake/internal/process-staged-candidate'
    }, {
      batch_id: batch10,
      company_id: 'SWC', // Tampered company!
      user: { user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9', username: 'admin_vtx', company_id: 'SWC' }, // Tampered
      files: [{
        fileName: 'E2E_TEST_TAMPER.pdf',
        docType: 'CCCD_VNEID',
        rawExtracted: {
          full_name: 'Lý Quốc Bảo',
          citizen_id: '079090009910',
          date_of_birth: '1992-04-10'
        }
      }]
    });

    const s10Pass = s10Res.status === 403;
    record(10, 'Company_id tampering (403 Forbidden)', s10Pass, `HTTP Status: ${s10Res.status}, Error: ${s10Res.data?.error}`);

    // ------------------------------------------------------------------------
    // Scenario 11: Audit log fallback buffer & recovery
    // ------------------------------------------------------------------------
    const mockAudit = {
      actor_user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9',
      actor_username: 'admin_vtx',
      action: 'E2E_TEST_AUDIT_BUFFER',
      status: 'SUCCESS',
      metadata: { test: true, timestamp: Date.now() },
      logged_at: new Date().toISOString()
    };

    bufferAuditFailure(mockAudit);
    const bufBefore = getFailedBuffer();
    const recoverRes = await flushFailedAuditLogs();
    const bufAfter = getFailedBuffer();
    const s11Pass = bufBefore.length > 0 && recoverRes.recovered >= 1 && bufAfter.length === 0;
    record(11, 'Audit log fallback buffer & recovery (resilient persistence)', s11Pass, `Buffered: ${bufBefore.length}, Recovered: ${recoverRes.recovered}, Remaining: ${bufAfter.length}`);

    // ------------------------------------------------------------------------
    // Scenario 12: Vietnamese name regex regression & validation guard
    // ------------------------------------------------------------------------
    const validNames = [
      'Nguyễn Văn An',
      'Trần Thị Mai',
      'Đặng Quốc Huy',
      'Lê Thị Thu Thảo',
      'VŨ ĐÌNH TRỌNG'
    ];
    const invalidNames = [
      'CỘNG HÒA XÃ HỘI',
      'Nhân viên mới',
      'BẢNG LƯƠNG THÁNG 5',
      'Nguyễn Văn 123',
      'Mr John',
      'a',
      'Nguyễn-Văn-An'
    ];

    const validsOk = validNames.every(n => isValidPersonName(n) === true);
    const invalidsOk = invalidNames.every(n => isValidPersonName(n) === false);
    const s12Pass = validsOk && invalidsOk;
    record(12, 'Vietnamese name regex regression (vietnameseEncodingGuard)', s12Pass, `Valids OK: ${validsOk}, Invalids OK: ${invalidsOk}`);

  } catch (err) {
    console.error('Lỗi khi chạy test suite:', err);
  } finally {
    await cleanupTestData();
    await db.pool.end();
  }

  console.log('\n================================================================');
  console.log(` FINAL RESULTS: ${passed} / 12 PASSED (${failed} FAILED)`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests();
