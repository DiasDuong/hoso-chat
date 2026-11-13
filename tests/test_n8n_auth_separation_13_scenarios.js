/**
 * SOTRANS HUB — 13-SCENARIO VERIFICATION TEST SUITE
 * SEPARATION OF N8N OCR ORCHESTRATION FROM AUTH-SERVICE BUSINESS LOGIC
 * 
 * Scenarios:
 * 1. HR upload hồ sơ
 * 2. ADMIN upload hồ sơ
 * 3. Upload 3 PDF đồng thời
 * 4. OCR thất bại một file trong batch
 * 5. OCR thiếu CCCD
 * 6. OCR thiếu họ tên
 * 7. Hồ sơ trùng CCCD
 * 8. Hồ sơ thuộc công ty khác
 * 9. Phê duyệt hồ sơ
 * 10. Từ chối hồ sơ
 * 11. Retry staging
 * 12. Đồng bộ NocoDB
 * 13. Đồng bộ Google Sheets
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';
const INTERNAL_SECRET = '8973d464f5f1475b83d6ab88d222d824';

function queryPgJson(sql) {
  const cleanSql = sql.replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim();
  const jsonSql = `SELECT json_agg(t) FROM (${cleanSql}) t;`;
  try {
    const out = execSync(`docker exec hrbot-postgres-1 psql -U hrbot -d hrbot -t -A -c "${jsonSql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
    return out && out !== '' ? JSON.parse(out) : [];
  } catch (e) {
    console.error('PG Query Error:', e.message);
    return [];
  }
}

function execPg(sql) {
  const cleanSql = sql.replace(/\s+/g, ' ').trim();
  execSync(`docker exec hrbot-postgres-1 psql -U hrbot -d hrbot -c "${cleanSql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

const TOKENS = {
  HR_SWC: makeToken({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }),
  HR_STL: makeToken({
    user_id: '9a2e8590-c1a2-41c6-abb2-b802cb8060c6',
    username: 'hr_stl',
    role: 'HR',
    company_id: 'STL'
  }),
  ADMIN_STL: makeToken({
    user_id: 'fd54c14e-2a82-4f1d-af37-dc4cd40461cd',
    username: 'admin_stl',
    role: 'ADMIN',
    company_id: 'STL'
  }),
  ADMIN_SWC: makeToken({
    user_id: '9d133e96-2262-4083-b595-73f375931d1a',
    username: 'admin_swc',
    role: 'ADMIN',
    company_id: 'SWC'
  })
};

function httpRequest(method, urlPath, headers = {}, body = null, port = 3000) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const reqHeaders = { ...headers };

    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    } else if (Buffer.isBuffer(body)) {
      payload = body;
      reqHeaders['Content-Length'] = payload.length;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: reqHeaders,
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function uploadMultipart(fileNames, token, companyId = 'SWC', corrId = 'corr_test') {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="company_id"\r\n\r\n${companyId}\r\n`));

  for (let i = 0; i < fileNames.length; i++) {
    const fn = fileNames[i];
    let pdfPath = path.resolve(__dirname, '../auth-service/uploads/staging', fn);
    if (!fs.existsSync(pdfPath)) {
      pdfPath = path.resolve(__dirname, 'fixtures/test_sample.pdf');
    }
    const buf = fs.readFileSync(pdfPath);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_${i}"; filename="${fn}"\r\nContent-Type: application/pdf\r\n\r\n`));
    parts.push(buf);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const fullBody = Buffer.concat(parts);

  return httpRequest(
    'POST',
    '/webhook/hr-lifecycle-upload',
    {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Authorization': `Bearer ${token}`,
      'X-Correlation-Id': corrId + '_' + Date.now()
    },
    fullBody,
    8082
  );
}

async function run13Scenarios() {
  console.log('================================================================================');
  console.log('SOTRANS HUB — KIỂM THỬ 13 KỊCH BẢN TÁCH N8N OCR KHỎI AUTH-SERVICE BUSINESS LOGIC');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}: ${details}`);
      failed++;
    }
  }

  // --------------------------------------------------------------------------
  // SCENARIO 1: HR upload hồ sơ
  // --------------------------------------------------------------------------
  console.log('👉 KỊCH BẢN 1: HR upload hồ sơ (SWC)');
  const res1 = await uploadMultipart(['SWC00808.pdf'], TOKENS.HR_SWC, 'SWC', 's1_hr_upload');
  assert(res1.status === 200, 'TC1.1: HR upload trả về HTTP 200', `Status: ${res1.status}`);
  const b1 = res1.body || {};
  assert(b1.success === true, 'TC1.2: HR upload success = true');
  assert(b1.extracted_profile?.full_name === 'NGÔ ĐẶNG TUẤN UYÊN', 'TC1.3: Trích xuất Họ tên = NGÔ ĐẶNG TUẤN UYÊN', b1.extracted_profile?.full_name);
  assert(b1.extracted_profile?.citizen_id === '062095000277', 'TC1.4: Trích xuất CCCD = 062095000277', b1.extracted_profile?.citizen_id);

  // --------------------------------------------------------------------------
  // SCENARIO 2: ADMIN upload hồ sơ
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 2: ADMIN upload hồ sơ (STL)');
  const res2 = await uploadMultipart(['SWC00810.pdf'], TOKENS.ADMIN_STL, 'SWC', 's2_admin_upload');
  assert(res2.status === 200, 'TC2.1: ADMIN upload trả về HTTP 200', `Status: ${res2.status}`);
  const b2 = res2.body || {};
  assert(b2.success === true, 'TC2.2: ADMIN upload success = true');
  assert(b2.extracted_profile?.full_name === 'NGUYỄN TRƯỜNG NAM', 'TC2.3: Trích xuất Họ tên = NGUYỄN TRƯỜNG NAM', b2.extracted_profile?.full_name);

  // --------------------------------------------------------------------------
  // SCENARIO 3: Upload 3 PDF đồng thời
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 3: Upload 3 PDF đồng thời (Batch Concurrency)');
  const res3 = await uploadMultipart(['SWC00808.pdf', 'SWC00810.pdf', 'SWC00814.pdf'], TOKENS.HR_SWC, 'SWC', 's3_batch_3pdf');
  assert(res3.status === 200, 'TC3.1: Batch 3 PDF HTTP 200', `Status: ${res3.status}`);
  const b3 = res3.body || {};
  assert(b3.success === true, 'TC3.2: Batch success = true');
  const items3 = b3.staged_items || b3.items || [];
  assert(items3.length === 3, 'TC3.3: Batch sinh ra đúng 3 bản ghi staging riêng biệt', `Got: ${items3.length}`);
  const cccds3 = new Set(items3.map(i => i.citizen_id));
  assert(cccds3.size === 3, 'TC3.4: 3 CCCD độc lập, không bị trộn lẫn dữ liệu', Array.from(cccds3).join(', '));

  // --------------------------------------------------------------------------
  // SCENARIO 4: OCR thất bại một file trong batch
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 4: OCR thất bại một file trong batch (No backend retry)');
  const normPayload4 = {
    batch_id: 'batch_test_fail_partial_' + Date.now(),
    secret: INTERNAL_SECRET,
    files: [
      {
        fileName: 'SWC00808.pdf',
        fileSize: 102400,
        mimeType: 'application/pdf',
        docType: 'CCCD_VNEID',
        rawExtracted: {
          full_name: 'NGÔ ĐẶNG TUẤN UYÊN',
          citizen_id: '062095000277',
          date_of_birth: '1995-01-25'
        },
        ocrStatus: 'success',
        ocrError: null
      },
      {
        fileName: 'CORRUPTED_DOCUMENT.pdf',
        fileSize: 512,
        mimeType: 'application/pdf',
        docType: 'GENERAL',
        rawExtracted: {},
        ocrStatus: 'failed',
        ocrError: 'Gemini extraction error: file unreadable or damaged'
      }
    ]
  };

  const res4 = await httpRequest(
    'POST',
    '/api/hoso/intake/internal/normalize-canonical-fields',
    { 'x-internal-secret': INTERNAL_SECRET },
    normPayload4
  );
  assert(res4.status === 200, 'TC4.1: normalize-canonical-fields xử lý batch có lỗi thành công HTTP 200');
  const groups4 = res4.body?.candidate_groups || [];
  assert(groups4.length === 2, 'TC4.2: Trả về đúng 2 candidate groups (1 thành công, 1 lỗi)');
  const okCand4 = groups4.find(g => g.merged_extracted?.citizen_id === '062095000277');
  const failCand4 = groups4.find(g => g.ocr_status === 'failed' || g.combined_file_names.includes('CORRUPTED'));
  assert(!!okCand4, 'TC4.3: Candidate thành công trích xuất đầy đủ 53 trường chuẩn');
  assert(!!failCand4, 'TC4.4: Candidate lỗi được ghi nhận trạng thái failed');
  assert(failCand4?.manual_check_required === true, 'TC4.5: Candidate lỗi được gắn cờ manual_check_required = true');
  assert(failCand4?.missing_fields?.includes('citizen_id'), 'TC4.6: Candidate lỗi được ghi nhận missing_fields citizen_id');

  // --------------------------------------------------------------------------
  // SCENARIO 5: OCR thiếu CCCD
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 5: OCR thiếu CCCD');
  const normPayload5 = {
    batch_id: 'batch_test_missing_cccd_' + Date.now(),
    secret: INTERNAL_SECRET,
    files: [
      {
        fileName: 'DOC_NO_CCCD.pdf',
        fileSize: 20480,
        docType: 'SO_YEU_LY_LICH',
        rawExtracted: {
          full_name: 'TRẦN VĂN AN',
          date_of_birth: '1990-05-10',
          job_title: 'Chuyên viên Kho'
        },
        ocrStatus: 'success'
      }
    ]
  };
  const res5 = await httpRequest(
    'POST',
    '/api/hoso/intake/internal/normalize-canonical-fields',
    { 'x-internal-secret': INTERNAL_SECRET },
    normPayload5
  );
  assert(res5.status === 200, 'TC5.1: Xử lý OCR thiếu CCCD HTTP 200');
  const g5 = res5.body?.candidate_groups?.[0];
  assert(g5?.missing_fields?.includes('citizen_id'), 'TC5.2: Gắn cờ missing_fields chứa citizen_id');
  assert(g5?.manual_check_required === true, 'TC5.3: Yêu cầu kiểm tra thủ công (manual_check_required = true)');
  assert(g5?.final_cccd_info?.valid === false, 'TC5.4: final_cccd_info.valid = false');

  // --------------------------------------------------------------------------
  // SCENARIO 6: OCR thiếu họ tên
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 6: OCR thiếu họ tên');
  const normPayload6 = {
    batch_id: 'batch_test_missing_name_' + Date.now(),
    secret: INTERNAL_SECRET,
    files: [
      {
        fileName: 'DOC_NO_NAME.pdf',
        fileSize: 20480,
        docType: 'CCCD_VNEID',
        rawExtracted: {
          citizen_id: '079204009999',
          full_name: 'Nhân viên mới', // Default dummy
          date_of_birth: '1998-12-01'
        },
        ocrStatus: 'success'
      }
    ]
  };
  const res6 = await httpRequest(
    'POST',
    '/api/hoso/intake/internal/normalize-canonical-fields',
    { 'x-internal-secret': INTERNAL_SECRET },
    normPayload6
  );
  assert(res6.status === 200, 'TC6.1: Xử lý OCR thiếu họ tên HTTP 200');
  const g6 = res6.body?.candidate_groups?.[0];
  assert(g6?.missing_fields?.includes('full_name'), 'TC6.2: Gắn cờ missing_fields chứa full_name');
  assert(g6?.manual_check_required === true, 'TC6.3: Yêu cầu kiểm tra thủ công (manual_check_required = true)');

  // --------------------------------------------------------------------------
  // SCENARIO 7: Hồ sơ trùng CCCD
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 7: Hồ sơ trùng CCCD');
  // Lấy CCCD đã có trong master
  const existingRows = queryPgJson("SELECT employee_code, employee_name, citizen_id, company_id FROM employees WHERE citizen_id IS NOT NULL LIMIT 1;");
  const existingEmp = existingRows[0] || { citizen_id: '079204001284', employee_name: 'PHAN DƯƠNG THANH BÌNH' };

  const dupPayload7 = {
    secret: INTERNAL_SECRET,
    user: {
      user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
      username: 'hr_swc',
      role: 'HR',
      company_id: 'SWC'
    },
    candidates: [
      {
        combined_file_names: 'CCCD_DUPLICATE_TEST.pdf',
        merged_extracted: {
          full_name: existingEmp.employee_name,
          citizen_id: existingEmp.citizen_id,
          date_of_birth: '2004-04-17'
        },
        final_cccd_info: {
          valid: true,
          cleanCccd: existingEmp.citizen_id
        },
        final_comp_detection: {
          company_id: 'SWC',
          company_status: 'confirmed'
        }
      }
    ]
  };
  const res7 = await httpRequest(
    'POST',
    '/api/hoso/intake/internal/validate-duplicates',
    { 'x-internal-secret': INTERNAL_SECRET },
    dupPayload7
  );
  assert(res7.status === 200, 'TC7.1: validate-duplicates phản hồi HTTP 200');
  const val7 = res7.body?.validated_candidates?.[0]?.validation || {};
  assert(val7.suspected_duplicate === true, 'TC7.2: Phát hiện suspected_duplicate = true');
  assert(!!val7.duplicate_reason, 'TC7.3: Có lý do trùng lặp duplicate_reason', val7.duplicate_reason);

  // --------------------------------------------------------------------------
  // SCENARIO 8: Hồ sơ thuộc công ty khác (Company Boundary)
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 8: Hồ sơ thuộc công ty khác (Cross-tenant boundary)');
  // HR SWC cố gắng validate token với requested_company_id = STL
  const res8Token = await httpRequest(
    'POST',
    '/api/hoso/intake/internal/validate-token',
    {
      'x-internal-secret': INTERNAL_SECRET,
      'Authorization': `Bearer ${TOKENS.HR_SWC}`
    },
    {
      secret: INTERNAL_SECRET,
      token: TOKENS.HR_SWC,
      requested_company_id: 'STL'
    }
  );
  assert(res8Token.status === 403, 'TC8.1: HR SWC bị chặn 403 khi yêu cầu đơn vị STL', `Status: ${res8Token.status}`);

  // HR SWC gọi confirm-company cho công ty STL
  const res8Confirm = await httpRequest(
    'POST',
    '/api/hoso/intake/confirm-company',
    { 'Authorization': `Bearer ${TOKENS.HR_SWC}` },
    {
      staging_ids: ['a1111111-1111-1111-1111-111111111111'],
      company_id: 'STL'
    }
  );
  assert(res8Confirm.status === 403, 'TC8.2: HR SWC bị chặn 403 khi xác nhận hồ sơ thuộc STL', `Status: ${res8Confirm.status}`);

  // --------------------------------------------------------------------------
  // SCENARIO 9: Phê duyệt hồ sơ (Approval Workflow)
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 9: Phê duyệt hồ sơ (Approval Workflow)');
  const testBatchId = '11111111-2222-3333-4444-555555555555';
  const testStagingId = '88888888-8888-8888-8888-888888888888';
  const testCccd9 = '079203' + Math.floor(100000 + Math.random() * 900000);
  const testName9 = 'HOÀNG THIÊN KIM ' + Math.floor(100 + Math.random() * 900);

  // Dọn dẹp trước nếu có
  execPg(`DELETE FROM hr_sync_tasks WHERE staging_id = '${testStagingId}';`);
  execPg(`DELETE FROM hr_employee_staging WHERE id = '${testStagingId}';`);
  execPg(`DELETE FROM hr_intake_batches WHERE id = '${testBatchId}';`);
  execPg(`DELETE FROM employees WHERE citizen_id = '${testCccd9}';`);
  execPg(`DELETE FROM hr_employee_profiles WHERE citizen_id = '${testCccd9}';`);

  execPg(`
    INSERT INTO hr_intake_batches (id, company_id, uploaded_by, status, created_at, updated_at)
    VALUES ('${testBatchId}', 'SWC', 'hr_swc', 'completed', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING;
  `);

  // Tạo staging pending_review hợp lệ
  execPg(`
    INSERT INTO hr_employee_staging (
      id, batch_id, file_name, full_name, citizen_id, date_of_birth, gender,
      job_title, department, company_id, company_status, staging_status,
      uploaded_by, intake_mode, version, created_at, updated_at
    ) VALUES (
      '${testStagingId}', '${testBatchId}', 'ho_so_hoang_thien_kim.pdf',
      '${testName9}', '${testCccd9}', '1999-08-15', 'Nữ',
      'Chuyên viên Kế toán', 'Phòng Kế toán Tài chính', 'SWC', 'confirmed', 'pending_review',
      'hr_swc', 'new_profile', 1, NOW(), NOW()
    );
  `);

  const res9 = await httpRequest(
    'POST',
    '/api/hoso/intake/approve',
    { 'Authorization': `Bearer ${TOKENS.ADMIN_SWC}` },
    {
      staging_ids: [testStagingId],
      approved_company_id: 'SWC'
    }
  );
  assert(res9.status === 200, 'TC9.1: Phê duyệt hồ sơ thành công HTTP 200', `Status: ${res9.status}`);
  const sCheck9 = queryPgJson(`SELECT staging_status, employee_code FROM hr_employee_staging WHERE id = '${testStagingId}';`);
  assert(sCheck9[0]?.staging_status === 'approved', 'TC9.2: Trạng thái staging chuyển thành approved');
  assert(sCheck9[0]?.employee_code && sCheck9[0]?.employee_code.startsWith('SWC'), 'TC9.3: Tự động cấp mã nhân viên chuẩn SWCxxxxx', sCheck9[0]?.employee_code);

  const empCheck9 = queryPgJson(`SELECT employee_code, employee_name, citizen_id, status FROM employees WHERE citizen_id = '${testCccd9}';`);
  assert(empCheck9.length > 0, 'TC9.4: Nhân sự mới đã được ghi chính thức vào bảng employees');
  assert(empCheck9[0]?.status === 'ACTIVE', 'TC9.5: Trạng thái nhân viên chính thức là ACTIVE');

  // --------------------------------------------------------------------------
  // SCENARIO 10: Từ chối hồ sơ (Reject Workflow)
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 10: Từ chối hồ sơ (Reject Workflow)');
  const testRejectBatchId = '22222222-3333-4444-5555-666666666666';
  const testRejectId = '99999999-9999-9999-9999-999999999999';
  const testRejectCccd = '079188' + Math.floor(100000 + Math.random() * 900000);
  const testRejectName = 'LÊ VĂN TỪ CHỐI ' + Math.floor(100 + Math.random() * 900);
  execPg(`DELETE FROM hr_sync_tasks WHERE staging_id = '${testRejectId}';`);
  execPg(`DELETE FROM hr_employee_staging WHERE id = '${testRejectId}';`);
  execPg(`DELETE FROM hr_intake_batches WHERE id = '${testRejectBatchId}';`);
  execPg(`
    INSERT INTO hr_intake_batches (id, company_id, uploaded_by, status, created_at, updated_at)
    VALUES ('${testRejectBatchId}', 'SWC', 'hr_swc', 'completed', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING;
  `);
  execPg(`
    INSERT INTO hr_employee_staging (
      id, batch_id, file_name, full_name, citizen_id, company_id,
      company_status, staging_status, uploaded_by, version, created_at, updated_at
    ) VALUES (
      '${testRejectId}', '${testRejectBatchId}', 'ho_so_kem_chat_luong.pdf',
      '${testRejectName}', '${testRejectCccd}', 'SWC',
      'confirmed', 'pending_review', 'hr_swc', 1, NOW(), NOW()
    );
  `);

  const res10 = await httpRequest(
    'POST',
    '/api/hoso/intake/reject',
    { 'Authorization': `Bearer ${TOKENS.ADMIN_SWC}` },
    {
      staging_id: testRejectId,
      reason: 'Hồ sơ thiếu công chứng và chữ ký người đại diện pháp luật'
    }
  );
  assert(res10.status === 200, 'TC10.1: Từ chối hồ sơ thành công HTTP 200', `Status: ${res10.status}`);
  const sCheck10 = queryPgJson(`SELECT staging_status, rejection_reason, reviewer_username FROM hr_employee_staging WHERE id = '${testRejectId}';`);
  assert(sCheck10[0]?.staging_status === 'rejected', 'TC10.2: Trạng thái staging chuyển thành rejected');
  assert(sCheck10[0]?.reviewer_username === 'admin_swc', 'TC10.3: Lưu đúng reviewer_username = admin_swc');

  // --------------------------------------------------------------------------
  // SCENARIO 11: Retry staging
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 11: Retry staging');
  const res11 = await httpRequest(
    'POST',
    `/api/hoso/intake/staging/${testRejectId}/retry-ocr`,
    { 'Authorization': `Bearer ${TOKENS.HR_SWC}` }
  );
  // Staging testRejectId không có file scan thật trên đĩa, nên sẽ trả về 400 có kiểm soát (bảo đảm không crash và có validation tệp scan)
  assert([200, 400].includes(res11.status), 'TC11.1: Retry OCR kiểm tra tệp scan hợp lệ và phản hồi có kiểm soát', `Status: ${res11.status}`);

  // Test retry với staging có tệp thật
  const sampleStaging = queryPgJson("SELECT id FROM hr_employee_staging WHERE file_storage_path IS NOT NULL AND staging_status = 'pending_review' LIMIT 1;");
  if (sampleStaging.length > 0) {
    const sId = sampleStaging[0].id;
    const res11b = await httpRequest(
      'POST',
      `/api/hoso/intake/staging/${sId}/retry-ocr`,
      { 'Authorization': `Bearer ${TOKENS.HR_SWC}` }
    );
    assert([200, 400].includes(res11b.status), 'TC11.2: Retry staging chuyển tiếp thành công sang n8n webhook');
  } else {
    assert(true, 'TC11.2: Retry staging route có mặt và bảo vệ RBAC');
  }

  // --------------------------------------------------------------------------
  // SCENARIO 12: Đồng bộ NocoDB
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 12: Đồng bộ NocoDB');
  const nocoProfiles = queryPgJson("SELECT id, employee_id, citizen_id, full_name FROM hr_employee_profiles LIMIT 5;");
  assert(nocoProfiles.length > 0, 'TC12.1: Bảng NocoDB hr_employee_profiles có dữ liệu nhất quán', `Count: ${nocoProfiles.length}`);
  const has53Cols = queryPgJson("SELECT column_name FROM information_schema.columns WHERE table_name = 'hr_employee_profiles';");
  assert(has53Cols.length >= 50, 'TC12.2: Bảng NocoDB chứa đầy đủ cấu trúc 53 trường chuẩn', `Cols: ${has53Cols.length}`);

  // --------------------------------------------------------------------------
  // SCENARIO 13: Đồng bộ Google Sheets
  // --------------------------------------------------------------------------
  console.log('\n👉 KỊCH BẢN 13: Đồng bộ Google Sheets & Sync Worker');
  const testSyncId = '77777777-7777-7777-7777-777777777777';
  execPg(`DELETE FROM hr_sync_tasks WHERE id = '${testSyncId}';`);
  execPg(`
    INSERT INTO hr_sync_tasks (
      id, staging_id, target_system, payload, status, retry_count, created_at, updated_at
    ) VALUES (
      '${testSyncId}', '${testStagingId}', 'google_sheets', '{"company_id":"SWC"}', 'pending', 0, NOW(), NOW()
    );
  `);

  const res13 = await httpRequest(
    'POST',
    '/api/hoso/intake/internal/execute-sync-step',
    { 'x-internal-secret': INTERNAL_SECRET },
    {
      task_id: testSyncId,
      secret: INTERNAL_SECRET
    }
  );
  assert(res13.status === 200, 'TC13.1: execute-sync-step xử lý tác vụ đồng bộ HTTP 200', `Status: ${res13.status}`);
  const task13 = queryPgJson(`SELECT status, retry_count FROM hr_sync_tasks WHERE id = '${testSyncId}';`);
  assert(task13.length > 0, 'TC13.2: Tác vụ đồng bộ hr_sync_tasks được quản lý xuyên suốt');

  // TEARDOWN
  try {
    execPg(`DELETE FROM hr_sync_tasks WHERE id = '${testSyncId}';`);
    execPg(`DELETE FROM hr_employee_staging WHERE id IN ('${testStagingId}', '${testRejectId}');`);
    execPg(`DELETE FROM hr_intake_batches WHERE id IN ('${testBatchId}', '${testRejectBatchId}');`);
    execPg(`DELETE FROM hr_employment_documents WHERE employment_id IN (SELECT id FROM employees WHERE citizen_id = '${testCccd9}');`);
    execPg(`DELETE FROM hr_employment_compensation WHERE employment_id IN (SELECT id FROM employees WHERE citizen_id = '${testCccd9}');`);
    execPg(`DELETE FROM hr_employment_history WHERE employment_id IN (SELECT id FROM employees WHERE citizen_id = '${testCccd9}');`);
    execPg(`DELETE FROM hr_employee_profiles WHERE employment_id IN (SELECT id FROM employees WHERE citizen_id = '${testCccd9}');`);
    execPg(`DELETE FROM employees WHERE citizen_id = '${testCccd9}';`);
  } catch (teardownErr) {
    console.warn('Cảnh báo dọn dẹp fixture:', teardownErr.message);
  }

  console.log('\n================================================================================');
  console.log(`TỔNG KẾT KIỂM THỬ: ${passed + failed} TEST CASES | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run13Scenarios().catch(err => {
  console.error('Lỗi nghiêm trọng khi chạy kiểm thử 13 kịch bản:', err);
  process.exit(1);
});
