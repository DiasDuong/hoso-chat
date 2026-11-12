/**
 * SOTRANS HUB - BUSINESS-FIRST DOCUMENT GOVERNANCE V2 VERIFICATION SUITE
 * 
 * Kiểm tra toàn diện 4 Batch:
 * Batch 1: UX Intake, Friendly UI, Wizard Scopes, Strict Tenant Boundary, SHA-256 Duplicate Check
 * Batch 2: Policy Relationships & Dynamic Conflict Audit with Evidence Quotes
 * Batch 3: Draft Saving & 3-Axis Lifecycle Handling (Draft isolation)
 * Batch 4: RAG Retrieval Safety & Pilot Isolation
 */

const jwt = require('jsonwebtoken');
const http = require('http');
const db = require('./db');

const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';

function makeToken(user) {
  return jwt.sign(user, secret, { expiresIn: '1h' });
}

function req(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

    const r = http.request(options, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, raw: buf });
        }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function runTests() {
  console.log('========================================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN BUSINESS-FIRST DOCUMENT GOVERNANCE V2');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, extra = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name} ${extra}`);
      failed++;
    }
  }

  // Token users
  const superToken = makeToken({
    user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac',
    username: 'superadmin',
    role: 'ADMIN',
    permissions: ['*']
  });

  const stlToken = makeToken({
    user_id: 'fd54c14e-2a82-4f1d-af37-dc4cd40461cd',
    username: 'admin_stl',
    role: 'ADMIN',
    company_id: 'STL',
    permissions: ['document.create', 'document.edit', 'document.submit', 'document.approve']
  });

  const vtxToken = makeToken({
    user_id: '8544ab81-be69-4607-9c0c-476b0e9546f9',
    username: 'admin_vtx',
    role: 'ADMIN',
    company_id: 'VTX',
    permissions: ['document.create', 'document.edit', 'document.submit', 'document.approve']
  });

  console.log('--- NHÓM 1: SCOPES, TAXONOMY & TENANT BOUNDARY ---');
  // 1. Scopes endpoint STL
  const rScopesSTL = await req('/api/documents/scopes', 'GET', null, stlToken);
  assert('GET /scopes: Admin STL bị khóa chỉ được phép chọn branch STL',
    rScopesSTL.status === 200 &&
    rScopesSTL.body.branches?.length === 1 &&
    rScopesSTL.body.branches[0].id === 'sotrans_logistics'
  );

  // 2. Scopes endpoint SuperAdmin
  const rScopesSuper = await req('/api/documents/scopes', 'GET', null, superToken);
  assert('GET /scopes: Super Admin có toàn quyền chọn tất cả 4 đơn vị',
    rScopesSuper.status === 200 &&
    rScopesSuper.body.branches?.length === 4 &&
    rScopesSuper.body.branches.some(b => b.id === 'all')
  );

  // 3. Taxonomy options
  assert('GET /scopes: Danh mục phòng ban, khối nghiệp vụ và nhóm chức danh chuẩn hóa',
    rScopesSuper.body.departments?.length >= 10 &&
    rScopesSuper.body.business_units?.length >= 6 &&
    rScopesSuper.body.employee_groups?.length >= 8 &&
    rScopesSuper.body.relationship_types?.length >= 5
  );

  // 4. Tenant boundary enforcement: STL admin cannot create document for SWC
  const rTenantCreateFail = await req('/api/documents', 'POST', {
    title: 'Quy định thử nghiệm VTX',
    doc_code: 'TEST-TENANT-VTX-01',
    branch_scope: ['vietranstimex'],
    effective_date: '2026-11-01'
  }, stlToken);
  assert('POST /documents: Admin STL bị chặn 403 khi cố tình tạo văn bản cho VTX',
    rTenantCreateFail.status === 403 &&
    rTenantCreateFail.body.error?.includes('403 Forbidden')
  );

  // 5. Tenant boundary enforcement: STL admin cannot create document for 'all'
  const rTenantCreateAllFail = await req('/api/documents', 'POST', {
    title: 'Quy định thử nghiệm toàn tập đoàn',
    doc_code: 'TEST-TENANT-ALL-01',
    branch_scope: ['all'],
    effective_date: '2026-11-01'
  }, stlToken);
  assert('POST /documents: Admin STL bị chặn 403 khi cố tình tạo văn bản toàn tập đoàn (all)',
    rTenantCreateAllFail.status === 403 &&
    rTenantCreateAllFail.body.error?.includes('403 Forbidden')
  );

  console.log('\n--- NHÓM 2: DUPLICATE DETECTION (SHA-256 & DOC CODE) ---');
  // 6. Check duplicate doc_code
  const rDupCode = await req('/api/documents/check-duplicate', 'POST', {
    doc_code: '01/QC-SOTRANS'
  }, stlToken);
  assert('POST /check-duplicate: Phát hiện mã hiệu 01/QC-SOTRANS đã tồn tại',
    rDupCode.status === 200 &&
    rDupCode.body.is_duplicate === true &&
    rDupCode.body.duplicate_code?.doc_code === '01/QC-SOTRANS'
  );

  // 7. Check non-duplicate doc_code
  const rNonDup = await req('/api/documents/check-duplicate', 'POST', {
    doc_code: 'UNIQUE-CODE-2026-NEVER-SEEN'
  }, stlToken);
  assert('POST /check-duplicate: Mã hiệu duy nhất không bị báo trùng',
    rNonDup.status === 200 &&
    rNonDup.body.is_duplicate === false
  );

  console.log('\n--- NHÓM 3: DYNAMIC CONFLICT AUDIT & EVIDENCE QUOTES ---');
  // 8. Dynamic Conflict Audit: Clean Policy
  const rConfClean = await req('/api/documents/detect-conflicts', 'POST', {
    title: 'Quy trình phòng chống mã độc & sao lưu dữ liệu máy chủ nội bộ',
    branch_scope: ['sotrans_logistics'],
    department_scope: ['chuyen_doi_so'],
    business_unit_scope: ['trung_tam_chuyen_doi_so'],
    employee_group_scope: ['nhan_vien_chuyen_doi_so'],
    effective_date: '2026-11-01'
  }, stlToken);
  assert('POST /detect-conflicts: Văn bản độc lập trả về "Chưa phát hiện xung đột"',
    rConfClean.status === 200 &&
    rConfClean.body.status_label === 'Chưa phát hiện xung đột' &&
    rConfClean.body.has_conflict === false &&
    rConfClean.body.total_scanned_docs > 0 &&
    rConfClean.body.summary?.includes('Chưa phát hiện xung đột')
  );

  // 9. Dynamic Conflict Audit: Direct Conflict with Working Hours
  const rConfDirect = await req('/api/documents/detect-conflicts', 'POST', {
    title: 'Quy định giờ làm việc và chấm công nhân sự',
    branch_scope: ['sotrans_logistics'],
    department_scope: ['all'],
    business_unit_scope: ['all'],
    employee_group_scope: ['all'],
    effective_date: '2026-11-01'
  }, stlToken);
  assert('POST /detect-conflicts: Phát hiện xung đột chính sách trực tiếp với bằng chứng trích lục',
    rConfDirect.status === 200 &&
    rConfDirect.body.has_conflict === true &&
    rConfDirect.body.status_badge === 'DIRECT_CONFLICT' &&
    rConfDirect.body.conflicts?.length > 0 &&
    rConfDirect.body.conflicts[0].evidence_quote?.length > 0
  );

  // 10. Families endpoint
  const rFamilies = await req('/api/documents/families', 'GET', null, stlToken);
  assert('GET /families: Tải danh sách dòng văn bản động (Dynamic Families)',
    rFamilies.status === 200 &&
    rFamilies.body.families?.length >= 10
  );

  console.log('\n--- NHÓM 4: DRAFT SAVING & 3-AXIS STATE LIFECYCLE ---');
  // 11. Create Draft Document
  const draftTitle = 'Văn bản dự thảo kiểm thử tự động V2';
  const draftCode = 'TEST-DRAFT-V2-' + Date.now();
  const rCreateDraft = await req('/api/documents', 'POST', {
    title: draftTitle,
    doc_code: draftCode,
    category: 'CHINH_SACH',
    branch_scope: ['sotrans_logistics'],
    department_scope: ['khoi_van_phong'],
    submit_for_approval: false,
    effective_date: '2026-11-01'
  }, stlToken);

  assert('POST /documents (submit_for_approval: false): Lưu bản nháp thành công ở trạng thái "draft"',
    rCreateDraft.status === 201 &&
    rCreateDraft.body.document?.status === 'draft'
  );

  const testDocId = rCreateDraft.body.document?.doc_version_id;

  // 12. Verify draft cannot be approved directly without submit
  const rApproveDraftDirect = await req(`/api/documents/${testDocId}/approve`, 'POST', {}, stlToken);
  assert('POST /:id/approve: Không thể duyệt trực tiếp văn bản ở trạng thái "draft" khi chưa submit',
    rApproveDraftDirect.status === 400
  );

  // 13. Submit draft for approval
  const rSubmit = await req(`/api/documents/${testDocId}/submit`, 'POST', {}, stlToken);
  assert('POST /:id/submit: Chuyển bản nháp sang trạng thái "pending_approval"',
    rSubmit.status === 200 &&
    rSubmit.body.document?.status === 'pending_approval'
  );

  // 14. Approving document by authorized admin
  const rApprove = await req(`/api/documents/${testDocId}/approve`, 'POST', { verified_by_test: true }, superToken);
  assert('POST /:id/approve: SuperAdmin phê duyệt văn bản thành công',
    rApprove.status === 200 &&
    ['active', 'scheduled'].includes(rApprove.body.document?.status)
  );

  // 15. Cleanup test document
  if (testDocId) {
    await db.query(`DELETE FROM documents WHERE doc_version_id = $1`, [testDocId]);
    console.log('  🧹 Đã dọn dẹp văn bản kiểm thử, khôi phục nguyên trạng database.');
  }

  console.log('\n--- NHÓM 5: BẢO VỆ QC-DXM-2026-FLEX & 3 QUAN HỆ ---');
  // 16. QC-DXM-2026-FLEX controls check
  const flexCheck = await db.query(
    `SELECT doc_code, is_official_policy, is_restricted_general, retrieval_mode FROM document_retrieval_controls WHERE doc_code = 'QC-DXM-2026-FLEX'`
  );
  assert('QC-DXM-2026-FLEX: Cơ chế kiểm soát truy xuất bảo lưu nguyên trạng (pilot_unverified, restricted=true)',
    flexCheck.rows.length === 1 &&
    flexCheck.rows[0].is_restricted_general === true &&
    flexCheck.rows[0].retrieval_mode === 'pilot_unverified'
  );

  // 17. Document count preserved
  const docCountRes = await db.query('SELECT count(*)::int AS count FROM documents');
  assert(`Toàn vẹn dữ liệu: Số lượng tài liệu bảo lưu nguyên trạng (${docCountRes.rows[0].count} văn bản)`,
    docCountRes.rows[0].count >= 21,
    `(Hiện tại: ${docCountRes.rows[0].count})`
  );

  // 18. Relationships count preserved
  const relCountRes = await db.query('SELECT count(*)::int AS count FROM document_relationships');
  assert('Toàn vẹn quan hệ: Số lượng quan hệ văn bản bảo lưu nguyên trạng (3 quan hệ)',
    relCountRes.rows[0].count === 3,
    `(Hiện tại: ${relCountRes.rows[0].count})`
  );

  console.log('\n========================================================================');
  console.log(`📊 KẾT QUẢ KIỂM THỬ: ${passed} PASS, ${failed} FAIL (Tổng: ${passed + failed})`);
  console.log('========================================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Lỗi thực thi kiểm thử:', err);
  process.exit(1);
});
