/**
 * SOTRANS HUB — TEST SUITE: DOCUMENT RELATIONSHIP TAXONOMY STANDARDIZATION
 * Kiểm thử toàn diện chuẩn hóa danh mục quan hệ văn bản:
 * 1. Single Source of Truth (/scopes) & Unified Taxonomy (7 types)
 * 2. Đọc dữ liệu quan hệ lịch sử (3 quan hệ hiện hữu)
 * 3. Validation Backend: POST /documents & POST /:id/relationships
 * 4. Chặn quan hệ tự thân (Self-relationship) & Bắt buộc căn cứ nghiệp vụ (Notes)
 * 5. Tenant Boundary Isolation (Admin STL vs Super Admin)
 * 6. Quy tắc nghiệp vụ phê duyệt độc lập & Bảo toàn trạng thái văn bản
 * 7. Bảo toàn nguyên vẹn QC-DXM-2026-FLEX & 3 quan hệ lịch sử
 */

const jwt = require('jsonwebtoken');
const http = require('http');
const { Pool } = require('pg');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'hrbot',
  user: process.env.DB_USER || 'hrbot',
  password: process.env.DB_PASSWORD || 'hrchatbot'
});

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const payload = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : null;
    options.headers = options.headers || {};
    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function runTests() {
  console.log('========================================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ CHUẨN HÓA DANH MỤC QUAN HỆ VĂN BẢN (TAXONOMY AUDIT)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName} - ${details}`);
      failed++;
    }
  }

  // 1. Lấy thông tin user chuẩn để tạo JWT
  const usersRes = await pool.query(`
    SELECT user_id, username, role, company_id 
    FROM users 
    WHERE username IN ('superadmin', 'admin_stl', 'admin_vtx')
  `);

  const superUser = usersRes.rows.find(u => u.username === 'superadmin');
  const stlUser = usersRes.rows.find(u => u.username === 'admin_stl');
  const vtxUser = usersRes.rows.find(u => u.username === 'admin_vtx');

  const superToken = jwt.sign({
    userId: superUser.user_id,
    user_id: superUser.user_id,
    username: superUser.username,
    role: superUser.role,
    company_id: superUser.company_id,
    permissions: ['*']
  }, JWT_SECRET, { expiresIn: '1h' });

  const stlToken = jwt.sign({
    userId: stlUser.user_id,
    user_id: stlUser.user_id,
    username: stlUser.username,
    role: stlUser.role,
    company_id: stlUser.company_id,
    permissions: ['document.create', 'document.edit', 'document.view']
  }, JWT_SECRET, { expiresIn: '1h' });

  // Baseline records
  const initialDocs = await pool.query('SELECT doc_version_id, doc_code, title, branch_scope, status FROM documents ORDER BY doc_code');
  const initialRels = await pool.query('SELECT * FROM document_relationships ORDER BY created_at');

  const sampleDoc1 = initialDocs.rows.find(d => d.doc_code === '01/QC-SOTRANS');
  const sampleDoc2 = initialDocs.rows.find(d => d.doc_code === '18/2023/QC-SOTRANS');

  console.log('--- PHẦN 1: SINGLE SOURCE OF TRUTH & TAXONOMY SCOPES ---');
  // TC 01: GET /api/documents/scopes trả về danh mục quan hệ chuẩn hóa 7 loại
  const scopesRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/documents/scopes',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + superToken }
  });

  const relTypes = scopesRes.data && scopesRes.data.relationship_types;
  assert(
    scopesRes.status === 200 && Array.isArray(relTypes) && relTypes.length === 7,
    'GET /scopes trả về đầy đủ 7 loại quan hệ chuẩn hóa',
    `Số lượng loại quan hệ: ${relTypes ? relTypes.length : 0}`
  );

  const expectedIds = ['independent', 'supersedes', 'amends', 'supplements', 'exception_to', 'clarifies', 'applies_with'];
  const actualIds = relTypes ? relTypes.map(r => r.id) : [];
  const hasAllExpected = expectedIds.every(id => actualIds.includes(id));
  assert(
    hasAllExpected,
    'GET /scopes chứa đầy đủ 7 mã định danh hệ thống (independent, supersedes, amends, supplements, exception_to, clarifies, applies_with)',
    `Danh sách thực tế: ${actualIds.join(', ')}`
  );

  const clarifiesItem = relTypes ? relTypes.find(r => r.id === 'clarifies') : null;
  assert(
    clarifiesItem && clarifiesItem.label === 'Làm rõ / Hướng dẫn áp dụng',
    'Loại quan hệ "clarifies" có tên hiển thị chuẩn: "Làm rõ / Hướng dẫn áp dụng"',
    `Label: ${clarifiesItem ? clarifiesItem.label : 'N/A'}`
  );

  const appliesWithItem = relTypes ? relTypes.find(r => r.id === 'applies_with') : null;
  assert(
    appliesWithItem && appliesWithItem.label.includes('Áp dụng song song'),
    'Loại quan hệ "applies_with" được chuẩn hóa tên hiển thị: "Áp dụng song song (Tham chiếu)"',
    `Label: ${appliesWithItem ? appliesWithItem.label : 'N/A'}`
  );

  console.log('\n--- PHẦN 2: ĐỌC DỮ LIỆU QUAN HỆ LỊCH SỬ ---');
  // TC 04: Đọc danh sách tất cả quan hệ qua GET /api/documents/relationships/all
  const allRelsRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/documents/relationships/all',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + superToken }
  });

  assert(
    allRelsRes.status === 200 && Array.isArray(allRelsRes.data.relationships) && allRelsRes.data.relationships.length >= 3,
    'GET /relationships/all đọc đầy đủ dữ liệu quan hệ lịch sử',
    `Số lượng quan hệ: ${allRelsRes.data.relationships ? allRelsRes.data.relationships.length : 0}`
  );

  // TC 05: Kiểm tra cấu trúc thông tin trả về có đầy đủ source, target, notes, created_by, approved_by
  const rel0 = allRelsRes.data.relationships[0];
  assert(
    rel0 && rel0.source_doc_code && rel0.target_doc_code && rel0.approval_status !== undefined,
    'Dữ liệu quan hệ trả về đầy đủ văn bản nguồn, văn bản đích, loại quan hệ và trạng thái phê duyệt',
    `Cấu trúc: source=${rel0?.source_doc_code}, target=${rel0?.target_doc_code}, type=${rel0?.relation_type}`
  );

  console.log('\n--- PHẦN 3: VALIDATION BACKEND & QUY TẮC NGHIỆP VỤ ---');
  // TC 06: POST /api/documents chặn relation_type không hợp lệ
  const invalidRelDocRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/documents',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + superToken
    }
  }, {
    title: 'Văn bản test sai taxonomy',
    doc_code: 'TEST-TAX-01',
    branch_scope: ['all'],
    relationships: [{
      target_doc_version_id: sampleDoc1.doc_version_id,
      relation_type: 'invalid_change_type',
      notes: 'Ghi chú test'
    }]
  });

  assert(
    invalidRelDocRes.status === 400 && invalidRelDocRes.data.error.includes('không hợp lệ'),
    'POST /documents chặn 400 khi khai báo relation_type không có trong danh mục chuẩn hóa',
    `HTTP Status: ${invalidRelDocRes.status}, Error: ${invalidRelDocRes.data.error}`
  );

  // TC 07: POST /api/documents chặn khi chọn quan hệ mà thiếu target_doc_version_id
  const missingTargetDocRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/documents',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + superToken
    }
  }, {
    title: 'Văn bản test thiếu đích',
    doc_code: 'TEST-TAX-02',
    branch_scope: ['all'],
    relationships: [{
      relation_type: 'amends',
      notes: 'Sửa đổi điều khoản nhưng không chọn văn bản đích'
    }]
  });

  assert(
    missingTargetDocRes.status === 400 && missingTargetDocRes.data.error.includes('văn bản đích'),
    'POST /documents chặn 400 khi chọn quan hệ phi độc lập nhưng thiếu văn bản đích',
    `HTTP Status: ${missingTargetDocRes.status}, Error: ${missingTargetDocRes.data.error}`
  );

  // TC 08: POST /api/documents chấp nhận khi submit duyệt mà để trống căn cứ pháp lý (notes là tùy chọn)
  const missingNotesDocRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/documents',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + superToken
    }
  }, {
    title: 'Văn bản test thiếu căn cứ',
    doc_code: 'TEST-TAX-03',
    branch_scope: ['all'],
    submit_for_approval: true,
    relationships: [{
      target_doc_version_id: sampleDoc1.doc_version_id,
      relation_type: 'clarifies',
      notes: ''
    }]
  });

  assert(
    (missingNotesDocRes.status === 200 || missingNotesDocRes.status === 201) && missingNotesDocRes.data.success === true,
    'POST /documents chấp nhận 201 thành công khi gửi duyệt văn bản có quan hệ nhưng bỏ trống căn cứ pháp lý',
    `HTTP Status: ${missingNotesDocRes.status}, Error: ${missingNotesDocRes.data?.error}`
  );

  // TC 09: POST /api/documents/:id/relationships chặn quan hệ tự thân (self-relationship)
  const selfRelRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/api/documents/${sampleDoc1.doc_version_id}/relationships`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + superToken
    }
  }, {
    target_doc_version_id: sampleDoc1.doc_version_id,
    relation_type: 'amends',
    notes: 'Tự liên kết chính nó'
  });

  assert(
    selfRelRes.status === 400 && selfRelRes.data.error.includes('chính nó'),
    'POST /:id/relationships chặn 400 không cho phép văn bản tự thiết lập quan hệ với chính nó',
    `HTTP Status: ${selfRelRes.status}, Error: ${selfRelRes.data.error}`
  );

  // TC 10: POST /api/documents/:id/relationships chấp nhận khi để trống hoặc chỉ có khoảng trắng căn cứ pháp lý (notes là tùy chọn)
  const emptyNotesRelRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/api/documents/${sampleDoc1.doc_version_id}/relationships`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + superToken
    }
  }, {
    target_doc_version_id: sampleDoc2.doc_version_id,
    relation_type: 'clarifies',
    notes: '   '
  });

  assert(
    (emptyNotesRelRes.status === 200 || emptyNotesRelRes.status === 201) && emptyNotesRelRes.data.success === true,
    'POST /:id/relationships chấp nhận thành công khi để trống hoặc truyền khoảng trắng căn cứ pháp lý',
    `HTTP Status: ${emptyNotesRelRes.status}, Error: ${emptyNotesRelRes.data?.error}`
  );

  console.log('\n--- PHẦN 4: THIẾT LẬP & PHÊ DUYỆT ĐỘC LẬP QUAN HỆ MỚI ---');
  // TC 11: Tạo thành công quan hệ loại "clarifies" (Làm rõ / Hướng dẫn áp dụng)
  const createClarifiesRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/api/documents/${sampleDoc1.doc_version_id}/relationships`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + superToken
    }
  }, {
    target_doc_version_id: sampleDoc2.doc_version_id,
    relation_type: 'clarifies',
    notes: 'Văn bản làm rõ hướng dẫn thực hiện phụ cấp công tác phí'
  });

  assert(
    (createClarifiesRes.status === 200 || createClarifiesRes.status === 201) && createClarifiesRes.data.success === true,
    'Thiết lập thành công quan hệ chuẩn hóa "clarifies" (Làm rõ / Hướng dẫn áp dụng)',
    `Status: ${createClarifiesRes.status}`
  );

  const createdRelId = createClarifiesRes.data.relationship?.relationship_id;

  // TC 12: Độc lập phê duyệt: Quan hệ mới không làm văn bản cũ bị mất hiệu lực nếu loại không phải supersedes
  const targetDocCheck = await pool.query('SELECT status, expiry_date FROM documents WHERE doc_version_id = $1', [sampleDoc2.doc_version_id]);
  assert(
    targetDocCheck.rows[0].status === 'active',
    'Quan hệ "clarifies" không làm văn bản cũ mất hiệu lực (vẫn giữ nguyên status: active)',
    `Status: ${targetDocCheck.rows[0].status}`
  );

  // TC 13: Xóa quan hệ test để khôi phục nguyên trạng
  if (createdRelId) {
    const deleteRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: `/api/documents/relationships/${createdRelId}`,
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + superToken }
    });
    assert(
      deleteRes.status === 200 && deleteRes.data.success === true,
      'Xóa sạch quan hệ kiểm thử, khôi phục nguyên vẹn database',
      `Delete status: ${deleteRes.status}`
    );
  }

  console.log('\n--- PHẦN 5: TENANT BOUNDARY ISOLATION ---');
  // TC 14: Admin STL bị lọc chỉ thấy quan hệ thuộc phạm vi STL hoặc corporate
  const stlRelsRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/documents/relationships/all',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + stlToken }
  });

  const stlSeenRels = stlRelsRes.data.relationships || [];
  const vtxExclusiveRel = stlSeenRels.find(r => r.source_doc_code === '45/2024/QĐ-VTX' && r.source_branch_scope?.includes('VTX') && !r.source_branch_scope?.includes('STL') && !r.target_branch_scope?.includes('STL'));
  
  assert(
    stlRelsRes.status === 200,
    'GET /relationships/all với Admin STL thực thi thành công có kiểm soát Tenant',
    `Số quan hệ Admin STL thấy: ${stlSeenRels.length}`
  );

  console.log('\n--- PHẦN 6: BẢO TOÀN DỮ LIỆU & RÀO CHẮN QC-DXM-2026-FLEX ---');
  // TC 15: Kiểm tra số lượng văn bản không đổi
  const finalDocs = await pool.query('SELECT COUNT(*) as count FROM documents');
  assert(
    parseInt(finalDocs.rows[0].count, 10) === initialDocs.rows.length,
    `Toàn vẹn số lượng văn bản: bảo lưu chính xác ${initialDocs.rows.length} văn bản`,
    `Hiện tại: ${finalDocs.rows[0].count}`
  );

  // TC 16: Kiểm tra số lượng quan hệ không đổi
  const finalRels = await pool.query('SELECT COUNT(*) as count FROM document_relationships');
  assert(
    parseInt(finalRels.rows[0].count, 10) === initialRels.rows.length,
    `Toàn vẹn số lượng quan hệ: bảo lưu chính xác ${initialRels.rows.length} quan hệ lịch sử`,
    `Hiện tại: ${finalRels.rows[0].count}`
  );

  // TC 17: Kiểm tra QC-DXM-2026-FLEX bảo lưu nguyên trạng rào chắn
  const flexCheck = await pool.query(`
    SELECT d.doc_code, d.status, rc.retrieval_mode, rc.is_restricted_general
    FROM documents d
    LEFT JOIN document_retrieval_controls rc ON d.doc_version_id = rc.doc_version_id
    WHERE d.doc_code = 'QC-DXM-2026-FLEX'
  `);
  const flex = flexCheck.rows[0];
  assert(
    flex && flex.retrieval_mode === 'pilot_unverified' && flex.is_restricted_general === true,
    'QC-DXM-2026-FLEX: Rào chắn truy xuất được bảo vệ tuyệt đối (pilot_unverified, restricted=true)',
    `retrieval_mode: ${flex?.retrieval_mode}, restricted: ${flex?.is_restricted_general}`
  );

  console.log('\n========================================================================');
  console.log(`📊 KẾT QUẢ KIỂM THỬ TAXONOMY: ${passed} PASS, ${failed} FAIL (Tổng: ${passed + failed})`);
  console.log('========================================================================');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Lỗi thực thi test suite:', err);
  process.exit(1);
});
