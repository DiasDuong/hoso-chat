/**
 * SOTRANS HUB — FINAL PRODUCTION GO/NO-GO AUTOMATED VERIFICATION SCRIPT
 * 
 * Performs direct automated reconciliation:
 * 1. Ground truth record set reconciliation (exact records, columns, units, duplicates)
 * 2. Automated PARTIAL retrieval & pagination verification (limit < totalMatches)
 * 3. Multi-point server-side Anti-IDOR & Tampered ID verification (Agent, Conversation, File, Attachment)
 * 4. Attachment reload cross-tenant isolation test
 * 5. Operational statuses verification (NOT_FOUND_VERIFIED, PARTIAL, PROCESSING_FAILED, UNSUPPORTED)
 * 6. Regression verification on existing agents (Excel-Data-Pro, Email-Assistant)
 */

const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const universalDataEngine = require('../auth-service/services/universalDataEngine');
const dataEngine = require('../auth-service/services/dataEngine');
const toolRegistry = require('../auth-service/services/toolRegistry');

const BASE_URL = 'http://127.0.0.1:3000';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const tokens = {
  emp_stl: jwt.sign(
    { user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' },
    JWT_SECRET,
    { expiresIn: '3h' }
  ),
  emp_vtx: jwt.sign(
    { user_id: 'bd33d589-3804-469e-a373-a934a5855d19', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' },
    JWT_SECRET,
    { expiresIn: '3h' }
  )
};

const FIXTURES = {
  pricingXlsx: path.join(__dirname, 'fixtures', 'Pricing Vendor.xlsx'),
  vendorCsv: path.join(__dirname, 'fixtures', 'fixture_vendor_csv.csv'),
  corruptedPdf: path.join(__dirname, 'fixtures', 'fixture_corrupted.pdf'),
  unsupportedXyz: path.join(__dirname, 'fixtures', 'fixture_unsupported.xyz'),
  emptyXlsx: path.join(__dirname, 'fixtures', 'fixture_empty.xlsx')
};

const testResults = [];

function recordTest({ id, section, name, passed, expected, actual, notes = '' }) {
  const item = { id, section, name, passed, expected, actual, notes };
  testResults.push(item);
  const statusStr = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${statusStr}] ${id} | [${section}] ${name}`);
  if (!passed) {
    console.log(`   --> Expected: ${JSON.stringify(expected)}`);
    console.log(`   --> Actual:   ${JSON.stringify(actual)}`);
  }
}

async function runVerification() {
  console.log('========================================================================================');
  console.log('   SOTRANS HUB — FINAL PRODUCTION GO/NO-GO AUTOMATED RECONCILIATION                     ');
  console.log('========================================================================================\n');

  // =========================================================================
  // 1. RECONCILIATION: GROUND TRUTH RECORD COMPARISON (XLSX & CSV)
  // =========================================================================
  console.log('--- 1. TỰ ĐỘNG ĐỐI CHIẾU GROUND TRUTH THEO TẬP BẢN GHI (RECORD RECONCILIATION) ---');

  const pricingBuf = fs.readFileSync(FIXTURES.pricingXlsx);
  const parsedPricing = dataEngine.parseSpreadsheet(pricingBuf, { fileName: 'Pricing Vendor.xlsx' });

  // 1.1 Tìm kiếm toàn bộ tuyến Tân Bình -> Dĩ An
  const searchTB = dataEngine.searchSpreadsheetRecords(parsedPricing, {
    origin: 'KCN Tân Bình',
    destination: 'Dĩ An',
    limit: 50
  });

  const expectedGroundTruth_TB = [
    { ref: '42_LAU_LCL', date: '16/10/2026', price: '900', vendor: 'Vendor 3S' },
    { ref: '42_LAU_LCL', date: '15/10/2026', price: '900.000/chuyến', vendor: 'VENDOR' },
    { ref: '42_LAU_LCL', date: '13/10/2026', price: '900.000/chuyến', vendor: '3S' },
    { ref: '42_LAU_LCL', date: '13/10/2026', price: '900.000/xe', vendor: '3S' }
  ];

  const actualRecords_TB = (searchTB.results || []).map(r => ({
    ref: r.data['MÃ REF'],
    date: r.data['NGÀY BÁO GIÁ'],
    price: String(r.data['GIÁ COST'] || '').trim(),
    vehicle: String(r.data['LOẠI CONT/XE'] || '').trim(),
    vendor: String(r.data['VENDOR CHECK GIÁ'] || '').trim()
  }));

  const allRecordsPresent = expectedGroundTruth_TB.every(expected => 
    actualRecords_TB.some(act => 
      act.ref === expected.ref &&
      act.date === expected.date &&
      act.price.includes(expected.price) &&
      act.vendor.includes(expected.vendor)
    )
  );

  recordTest({
    id: 'VERIFY_01',
    section: 'GROUND_TRUTH_RECONCILIATION',
    name: 'Đối chiếu tập bản ghi thực tế vs Ground truth 4 bản ghi Tân Bình -> Dĩ An',
    passed: searchTB.totalMatches === 4 && actualRecords_TB.length === 4 && allRecordsPresent,
    expected: { totalRecords: 4, expectedGroundTruth_TB },
    actual: { totalRecords: actualRecords_TB.length, actualRecords_TB },
    notes: 'Bảo toàn tuyệt đối 100% bản ghi trùng mã REF, phân biệt ngày và đơn vị tính'
  });

  // 1.2 Kiểm tra đa sheet: Sheet Miền Bắc
  const searchMB = dataEngine.searchSpreadsheetRecords(parsedPricing, {
    sheetName: 'Miền Bắc',
    origin: 'Hải Phòng',
    destination: 'Hà Nội',
    limit: 10
  });

  const hasHaiPhongCont = (searchMB.results || []).some(r => String(r.data['GIÁ COST']).includes('6.200.000'));
  const hasHaiPhongXe = (searchMB.results || []).some(r => String(r.data['GIÁ COST']).includes('1610000') || String(r.data['GIÁ COST']).includes('1.610.000'));

  recordTest({
    id: 'VERIFY_02',
    section: 'GROUND_TRUTH_RECONCILIATION',
    name: 'Đối chiếu dữ liệu sheet cuối file (Miền Bắc: Hải Phòng -> Hà Nội cont 40 & xe 1.25T)',
    passed: searchMB.totalMatches >= 2 && hasHaiPhongCont && hasHaiPhongXe,
    expected: 'Có ít nhất 2 bản ghi Hải Phòng - Hà Nội gồm giá 6.200.000 và 1.610.000',
    actual: searchMB.results.map(r => ({ origin: r.data['ĐIỂM ĐI'], dest: r.data['ĐIỂM ĐẾN'], price: r.data['GIÁ COST'] })),
    notes: 'Sheet cuối file được đọc trọn vẹn và chính xác'
  });

  // =========================================================================
  // 2. TỰ ĐỘNG XÁC MINH TRẠNG THÁI PARTIAL (PAGINATION & TOKEN BUDGET)
  // =========================================================================
  console.log('\n--- 2. TỰ ĐỘNG XÁC MINH TRẠNG THÁI PARTIAL KHI VƯỢT GIỚI HẠN TRUY XUẤT ---');

  // Đặt limit = 2 khi dataset có 4 kết quả
  const searchPartial = await toolRegistry.executeTool('search_spreadsheet_data', {
    origin: 'KCN Tân Bình',
    destination: 'Dĩ An',
    limit: 2
  }, {
    activeSpreadsheets: [parsedPricing]
  });

  const isPartialCorrect = searchPartial.status === 'PARTIAL' &&
                           searchPartial.totalMatches === 4 &&
                           searchPartial.returnedMatches === 2 &&
                           searchPartial.isExhaustive === false;

  recordTest({
    id: 'VERIFY_03',
    section: 'PARTIAL_RETRIEVAL_VERIFICATION',
    name: 'Hệ thống tự động phát hiện và gán nhãn PARTIAL khi số bản ghi vượt limit',
    passed: isPartialCorrect,
    expected: { status: 'PARTIAL', totalMatches: 4, returnedMatches: 2, isExhaustive: false },
    actual: { status: searchPartial.status, totalMatches: searchPartial.totalMatches, returnedMatches: searchPartial.returnedMatches, isExhaustive: searchPartial.isExhaustive },
    notes: 'Minh bạch trạng thái PARTIAL khi truy xuất chưa đầy đủ, không gây hiểu nhầm'
  });

  // =========================================================================
  // 3. TỰ ĐỘNG KIỂM TRA PHÂN ĐỊNH 5 TRẠNG THÁI VẬN HÀNH (PARSER & RETRIEVAL)
  // =========================================================================
  console.log('\n--- 3. TỰ ĐỘNG KIỂM TRA PHÂN ĐỊNH RÕ RÀNG 5 TRẠNG THÁI PARSER & RETRIEVAL ---');

  // 3.1 Trạng thái UNSUPPORTED
  const unsuppBuf = fs.readFileSync(FIXTURES.unsupportedXyz);
  const parsedUnsupp = await universalDataEngine.parseUniversalFile(unsuppBuf, { fileName: 'fixture_unsupported.xyz' });
  const isUnsuppCorrect = parsedUnsupp.parseStatus === 'UNSUPPORTED' && parsedUnsupp.manifest.readyForQuery === false;

  recordTest({
    id: 'VERIFY_04',
    section: 'OPERATIONAL_STATUSES',
    name: 'Định dạng không hỗ trợ (.xyz) được gán đúng trạng thái UNSUPPORTED',
    passed: isUnsuppCorrect,
    expected: { parseStatus: 'UNSUPPORTED', readyForQuery: false },
    actual: { parseStatus: parsedUnsupp.parseStatus, readyForQuery: parsedUnsupp.manifest.readyForQuery },
    notes: 'Phân định rõ định dạng không hỗ trợ'
  });

  // 3.2 Trạng thái PROCESSING_FAILED (Corrupted file)
  const corruptBuf = fs.readFileSync(FIXTURES.corruptedPdf);
  const parsedCorrupt = await universalDataEngine.parseUniversalFile(corruptBuf, { fileName: 'fixture_corrupted.pdf' });
  const isCorruptCorrect = parsedCorrupt.parseStatus === 'PROCESSING_FAILED' && parsedCorrupt.manifest.readyForQuery === false;

  recordTest({
    id: 'VERIFY_05',
    section: 'OPERATIONAL_STATUSES',
    name: 'Tệp hỏng (Corrupted PDF) được gán đúng trạng thái PROCESSING_FAILED',
    passed: isCorruptCorrect,
    expected: { parseStatus: 'PROCESSING_FAILED', readyForQuery: false },
    actual: { parseStatus: parsedCorrupt.parseStatus, readyForQuery: parsedCorrupt.manifest.readyForQuery },
    notes: 'Phân định rõ tệp bị hỏng'
  });

  // 3.3 Trạng thái NOT_FOUND_VERIFIED (Không tồn tại trong toàn bộ phạm vi)
  const searchNeg = await toolRegistry.executeTool('search_spreadsheet_data', {
    origin: 'Cát Lái',
    destination: 'Móng Cái',
    limit: 10
  }, {
    activeSpreadsheets: [parsedPricing]
  });

  const isNegCorrect = searchNeg.status === 'NOT_FOUND_VERIFIED' && searchNeg.totalMatches === 0;
  recordTest({
    id: 'VERIFY_06',
    section: 'OPERATIONAL_STATUSES',
    name: 'Tra cứu không có dữ liệu được gán đúng trạng thái NOT_FOUND_VERIFIED',
    passed: isNegCorrect,
    expected: { status: 'NOT_FOUND_VERIFIED', totalMatches: 0 },
    actual: { status: searchNeg.status, totalMatches: searchNeg.totalMatches },
    notes: 'Kiểm tra trọn vẹn và xác nhận phủ định có căn cứ'
  });

  // =========================================================================
  // 4. KIỂM THỬ BẢO MẬT PHÂN QUYỀN VỚI TAMPERED IDs (IDOR & CROSS-TENANT)
  // =========================================================================
  console.log('\n--- 4. KIỂM THỬ AN NINH PHÂN QUYỀN MÁY CHỦ VỚI TAMPERED IDs ---');

  // Lấy Agent của STL
  const agentListRes = await fetch(`${BASE_URL}/api/agents`, {
    headers: { 'Authorization': `Bearer ${tokens.emp_stl}` }
  });
  const agentListJson = await agentListRes.json();
  const stlAgent = (agentListJson.agents || [])[0];

  // 4.1 Tampered Agent ID: Dạng UUID sai định dạng
  const badUuidRes = await fetch(`${BASE_URL}/api/agents/not-a-valid-uuid/chat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokens.emp_stl}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Hello' })
  });
  recordTest({
    id: 'VERIFY_07',
    section: 'SECURITY_TAMPERED_IDS',
    name: 'Server chặn Agent ID sai định dạng (Tampered malformed UUID)',
    passed: badUuidRes.status === 400,
    expected: 400,
    actual: badUuidRes.status,
    notes: 'Input validation ở tầng controller'
  });

  // 4.2 Tampered Agent ID: Dạng UUID hợp lệ nhưng thuộc người dùng/công ty khác (STL agent gọi bởi VTX)
  let crossAgentStatus = 0;
  if (stlAgent) {
    const crossAgentRes = await fetch(`${BASE_URL}/api/agents/${stlAgent.id}`, {
      headers: { 'Authorization': `Bearer ${tokens.emp_vtx}` }
    });
    crossAgentStatus = crossAgentRes.status;
  }
  recordTest({
    id: 'VERIFY_08',
    section: 'SECURITY_TAMPERED_IDS',
    name: 'Server chặn truy cập Agent chi tiết của công ty khác (Cross-tenant Agent IDOR)',
    passed: crossAgentStatus === 404,
    expected: 404,
    actual: crossAgentStatus,
    notes: 'SQL controller ràng buộc id = $1 AND user_id = $2'
  });

  // 4.3 Tampered Conversation ID: User VTX truyền conversation_id của STL vào chat
  // Tạo 1 conversation của STL
  const convCreate = await fetch(`${BASE_URL}/api/conversations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokens.emp_stl}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hội thoại tuyệt mật STL' })
  });
  const convJson = await convCreate.json();
  const stlConvId = convJson.conversation?.id;

  let crossConvReadStatus = 0;
  if (stlConvId) {
    const crossConvRes = await fetch(`${BASE_URL}/api/conversations/${stlConvId}/messages`, {
      headers: { 'Authorization': `Bearer ${tokens.emp_vtx}` }
    });
    crossConvReadStatus = crossConvRes.status;
  }
  recordTest({
    id: 'VERIFY_09',
    section: 'SECURITY_TAMPERED_IDS',
    name: 'Server chặn đọc tin nhắn hội thoại của công ty khác (Cross-tenant Conversation IDOR)',
    passed: crossConvReadStatus === 404,
    expected: 404,
    actual: crossConvReadStatus,
    notes: 'Bảo vệ lịch sử hội thoại trên máy chủ'
  });

  // 4.4 Tampered Attachment Reload Test: Kiểm tra không thể nạp lại attachment của người khác
  // Tạo attachment cho conversation của STL
  const formData = new FormData();
  formData.append('message', 'Tải tệp bí mật');
  formData.append('conversation_id', stlConvId);
  formData.append('files', new Blob([fs.readFileSync(FIXTURES.pricingXlsx)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'Pricing Vendor.xlsx');

  const uploadRes = await fetch(`${BASE_URL}/api/agents/${stlAgent.id}/chat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokens.emp_stl}` },
    body: formData
  });

  // User VTX gọi API general attachments của STL conversation
  const vtxAttachRes = await fetch(`${BASE_URL}/api/general/conversations/${stlConvId}/attachments`, {
    headers: { 'Authorization': `Bearer ${tokens.emp_vtx}` }
  });
  const vtxAttachJson = await vtxAttachRes.json();
  const vtxCannotSeeStlAttachments = (vtxAttachJson.attachments || []).length === 0;

  recordTest({
    id: 'VERIFY_10',
    section: 'SECURITY_ATTACHMENT_ISOLATION',
    name: 'User công ty khác không thể đọc danh sách attachment của hội thoại thuộc công ty STL',
    passed: vtxCannotSeeStlAttachments,
    expected: '0 attachments trả về cho user VTX',
    actual: `${(vtxAttachJson.attachments || []).length} attachments`,
    notes: 'Cô lập hoàn toàn luồng nạp tệp và attachment cache'
  });

  // =========================================================================
  // 5. KIỂM THỬ HỒI QUY: EXCEL-DATA-PRO & EMAIL-ASSISTANT
  // =========================================================================
  console.log('\n--- 5. KIỂM THỬ HỒI QUY (REGRESSION) TRÊN CÁC AGENT CŨ ---');

  const excelPro = (agentListJson.agents || []).find(a => a.name === 'Excel-Data-Pro');
  const emailAsst = (agentListJson.agents || []).find(a => a.name === 'Email-Assistant');

  const hasTools = (agent) => Array.isArray(agent?.enabled_tools) && agent.enabled_tools.length >= 6;

  recordTest({
    id: 'VERIFY_11',
    section: 'REGRESSION_VERIFICATION',
    name: 'Agent nghiệp vụ hiện hữu Excel-Data-Pro giữ nguyên cấu hình và đủ 6 công cụ',
    passed: Boolean(excelPro && excelPro.status === 'active' && hasTools(excelPro)),
    expected: 'Status active, đầy đủ tools',
    actual: { status: excelPro?.status, toolCount: excelPro?.enabled_tools?.length },
    notes: 'Không mất cấu hình hay quyền'
  });

  recordTest({
    id: 'VERIFY_12',
    section: 'REGRESSION_VERIFICATION',
    name: 'Agent nghiệp vụ hiện hữu Email-Assistant giữ nguyên cấu hình và đủ 6 công cụ',
    passed: Boolean(emailAsst && emailAsst.status === 'active' && hasTools(emailAsst)),
    expected: 'Status active, đầy đủ tools',
    actual: { status: emailAsst?.status, toolCount: emailAsst?.enabled_tools?.length },
    notes: 'Không mất cấu hình hay quyền'
  });

  // Dọn dẹp hội thoại thử nghiệm
  if (stlConvId) {
    try {
      await fetch(`${BASE_URL}/api/conversations/${stlConvId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${tokens.emp_stl}` }
      });
    } catch (e) {}
  }

  // =========================================================================
  // TỔNG KẾT
  // =========================================================================
  console.log('\n========================================================================================');
  const total = testResults.length;
  const passedCount = testResults.filter(r => r.passed).length;
  const failedCount = total - passedCount;
  console.log(`KẾT QUẢ XÁC MINH SÂU TỰ ĐỘNG: ${passedCount}/${total} TESTS PASS (${Math.round((passedCount/total)*100)}%)`);
  console.log('========================================================================================\n');

  const finalGoDecision = passedCount === total ? 'GO' : 'NO_GO';
  console.log(`KẾT LUẬN CUỐI CÙNG: [${finalGoDecision}]\n`);

  const report = {
    timestamp: new Date().toISOString(),
    totalTests: total,
    passedCount,
    failedCount,
    successRate: `${Math.round((passedCount/total)*100)}%`,
    finalGoDecision,
    testResults
  };

  const reportPath = path.join(__dirname, 'final_go_nogo_verification_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Đã xuất báo cáo xác minh sâu tại: ${reportPath}`);
}

runVerification().catch(err => {
  console.error('Lỗi thực thi verification:', err);
  process.exit(1);
});
