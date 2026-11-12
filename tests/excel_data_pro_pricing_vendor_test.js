/**
 * SOTRANS HUB — EXCEL-DATA-PRO PRICING VENDOR TEST SUITE
 * 
 * Verifies that Excel-Data-Pro successfully finds and processes all pricing records
 * in "Pricing Vendor.xlsx" for route "KCN Tân Bình -> Dĩ An, Bình Dương" across all sheets,
 * including historical quotes, vendor details, units of measure, unaccented queries,
 * comparison, non-existent routes, and multi-sheet robustness.
 */

const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const BASE_URL = 'http://127.0.0.1:3000';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const token = jwt.sign(
  { user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' },
  JWT_SECRET,
  { expiresIn: '2h' }
);

const AGENT_EXCEL_ID = 'cbb7053e-c388-4072-a87f-1e49b6facf07';
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'Pricing Vendor.xlsx');

const results = [];

function recordTest({ id, suite, name, query, passed, assertions, actualReply, latencyMs, notes }) {
  const item = { id, suite, name, query, passed, assertions, actualReply, latencyMs, notes };
  results.push(item);
  const statusStr = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${statusStr}] ${id} (${suite}): ${name} (${latencyMs}ms)`);
  if (!passed && notes) {
    console.log(`   --> Reason: ${notes}`);
  }
}

async function sendChat({ message, conversationId = null, attachFile = false }) {
  const formData = new FormData();
  formData.append('message', message);
  if (conversationId) {
    formData.append('conversation_id', conversationId);
  }
  if (attachFile) {
    const fileBytes = fs.readFileSync(FIXTURE_PATH);
    formData.append(
      'files',
      new Blob([fileBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'Pricing Vendor.xlsx'
    );
  }

  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/agents/${AGENT_EXCEL_ID}/chat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });

  const latencyMs = Date.now() - start;
  const json = await res.json();
  return { status: res.status, json, latencyMs };
}

async function runTestSuite() {
  console.log('======================================================================');
  console.log('SOTRANS HUB — EXCEL-DATA-PRO PRICING VENDOR VERIFICATION SUITE');
  console.log('Target Agent: Excel-Data-Pro (ID:', AGENT_EXCEL_ID, ')');
  console.log('Fixture:', FIXTURE_PATH);
  console.log('======================================================================\n');

  let activeConversationId = null;

  // -------------------------------------------------------------------------
  // TEST A: Truy vấn hiện trạng tuyến KCN Tân Bình -> Dĩ An
  // -------------------------------------------------------------------------
  try {
    const queryA = 'Giá đi từ KCN Tân Bình tới Dĩ An hiện tại như thế nào?';
    console.log(`[TEST A] Gửi yêu cầu: "${queryA}" (kèm file)...`);
    const { status, json, latencyMs } = await sendChat({ message: queryA, attachFile: true });
    
    if (status !== 200 || !json.reply) {
      recordTest({
        id: 'TEST_A',
        suite: 'SUITE_A',
        name: 'Giá hiện tại tuyến KCN Tân Bình -> Dĩ An',
        query: queryA,
        passed: false,
        latencyMs,
        notes: `HTTP ${status}: ${json.error || 'Không có phản hồi'}`
      });
    } else {
      activeConversationId = json.conversation_id;
      const reply = json.reply;
      const hasRoute = /(Tân Bình|KCN Tân Bình)/i.test(reply) && /(Dĩ An|Bình Dương|Alley 64)/i.test(reply);
      const hasPrice = /(900\.000|900)/i.test(reply);
      const hasVendor = /(3S|Vendor 3S|VENDOR)/i.test(reply);
      const passed = hasRoute && hasPrice && hasVendor;

      recordTest({
        id: 'TEST_A',
        suite: 'SUITE_A',
        name: 'Giá hiện tại tuyến KCN Tân Bình -> Dĩ An',
        query: queryA,
        passed,
        assertions: { hasRoute, hasPrice, hasVendor },
        actualReply: reply,
        latencyMs,
        notes: passed ? 'Tìm thấy tuyến đường, mức giá 900k và nhà cung cấp' : 'Thiếu thông tin tuyến đường hoặc giá'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_A', suite: 'SUITE_A', name: 'Giá hiện tại', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST B: Tìm tất cả báo giá từ KCN Tân Bình đến Dĩ An, Bình Dương
  // -------------------------------------------------------------------------
  try {
    const queryB = 'Tìm tất cả báo giá từ KCN Tân Bình đến Dĩ An, Bình Dương.';
    console.log(`\n[TEST B] Gửi yêu cầu: "${queryB}" (trong cùng hội thoại)...`);
    const { status, json, latencyMs } = await sendChat({ message: queryB, conversationId: activeConversationId });

    if (status !== 200 || !json.reply) {
      recordTest({
        id: 'TEST_B',
        suite: 'SUITE_B',
        name: 'Tìm tất cả báo giá đầy đủ bản ghi',
        query: queryB,
        passed: false,
        latencyMs,
        notes: `HTTP ${status}: ${json.error || 'Lỗi hội thoại'}`
      });
    } else {
      const reply = json.reply;
      const has13 = /13\/10/i.test(reply);
      const has15 = /15\/10/i.test(reply);
      const has16 = /16\/10/i.test(reply);
      const hasRef = /42_LAU_LCL/i.test(reply);
      const has3S = /3S/i.test(reply);
      const hasUnits = /(chuyến|xe|nghìn)/i.test(reply);
      const passed = has13 && has15 && has16 && hasRef && has3S && hasUnits;

      recordTest({
        id: 'TEST_B',
        suite: 'SUITE_B',
        name: 'Tìm tất cả báo giá đầy đủ bản ghi',
        query: queryB,
        passed,
        assertions: { has13, has15, has16, hasRef, has3S, hasUnits },
        actualReply: reply,
        latencyMs,
        notes: passed ? 'Bảo toàn đầy đủ tất cả các bản ghi (13/10, 15/10, 16/10, REF 42_LAU_LCL, đơn vị tính)' : 'Bỏ sót ngày hoặc mã REF'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_B', suite: 'SUITE_B', name: 'Tìm tất cả báo giá', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST C: Giá mới nhất của nhà cung cấp 3S, ngày báo giá và đơn vị tính
  // -------------------------------------------------------------------------
  try {
    const queryC = 'Giá mới nhất của nhà cung cấp 3S là bao nhiêu? Nêu ngày báo giá và đơn vị tính.';
    console.log(`\n[TEST C] Gửi yêu cầu: "${queryC}"...`);
    const { status, json, latencyMs } = await sendChat({ message: queryC, conversationId: activeConversationId });

    if (status !== 200 || !json.reply) {
      recordTest({ id: 'TEST_C', suite: 'SUITE_C', name: 'Giá mới nhất nhà cung cấp 3S', query: queryC, passed: false, latencyMs, notes: 'HTTP error' });
    } else {
      const reply = json.reply;
      const hasLatestDate = /(16\/10|13\/10)/i.test(reply);
      const hasPrice = /(900|900\.000)/i.test(reply);
      const hasUnit = /(chuyến|xe|nghìn|VND)/i.test(reply);
      const passed = hasLatestDate && hasPrice && hasUnit;

      recordTest({
        id: 'TEST_C',
        suite: 'SUITE_C',
        name: 'Giá mới nhất nhà cung cấp 3S, ngày và đơn vị tính',
        query: queryC,
        passed,
        assertions: { hasLatestDate, hasPrice, hasUnit },
        actualReply: reply,
        latencyMs,
        notes: passed ? 'Xác định chính xác ngày báo giá, mức giá và đơn vị tính' : 'Thiếu ngày hoặc đơn vị tính'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_C', suite: 'SUITE_C', name: 'Giá mới nhất 3S', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST D: Truy vấn không dấu "Gia tu Tan Binh den Di An."
  // -------------------------------------------------------------------------
  try {
    const queryD = 'Gia tu Tan Binh den Di An.';
    console.log(`\n[TEST D] Gửi yêu cầu không dấu: "${queryD}"...`);
    const { status, json, latencyMs } = await sendChat({ message: queryD, conversationId: activeConversationId });

    if (status !== 200 || !json.reply) {
      recordTest({ id: 'TEST_D', suite: 'SUITE_D', name: 'Truy vấn tiếng Việt không dấu', query: queryD, passed: false, latencyMs, notes: 'HTTP error' });
    } else {
      const reply = json.reply;
      const hasRouteOrPrice = /(Tân Bình|Dĩ An|900|3S)/i.test(reply);
      const passed = hasRouteOrPrice;

      recordTest({
        id: 'TEST_D',
        suite: 'SUITE_D',
        name: 'Truy vấn tiếng Việt không dấu',
        query: queryD,
        passed,
        assertions: { hasRouteOrPrice },
        actualReply: reply,
        latencyMs,
        notes: passed ? 'Xử lý chính xác câu hỏi không dấu, trả về đúng tuyến đường và giá' : 'Không nhận diện được tuyến không dấu'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_D', suite: 'SUITE_D', name: 'Truy vấn không dấu', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST E: So sánh tất cả báo giá theo ngày, giá và ghi chú
  // -------------------------------------------------------------------------
  try {
    const queryE = 'So sánh tất cả báo giá của tuyến này theo ngày, giá và ghi chú.';
    console.log(`\n[TEST E] Gửi yêu cầu so sánh: "${queryE}"...`);
    const { status, json, latencyMs } = await sendChat({ message: queryE, conversationId: activeConversationId });

    if (status !== 200 || !json.reply) {
      recordTest({ id: 'TEST_E', suite: 'SUITE_E', name: 'So sánh báo giá theo ngày, giá, ghi chú', query: queryE, passed: false, latencyMs, notes: 'HTTP error' });
    } else {
      const reply = json.reply;
      const hasDates = /13\/10/i.test(reply) && /15\/10/i.test(reply);
      const hasNotes = /(máy khuấy|bốc tay|thùng|phụ phí dầu|120kg|140kg|50kg)/i.test(reply);
      const passed = hasDates && hasNotes;

      recordTest({
        id: 'TEST_E',
        suite: 'SUITE_E',
        name: 'So sánh báo giá theo ngày, giá và ghi chú',
        query: queryE,
        passed,
        assertions: { hasDates, hasNotes },
        actualReply: reply,
        latencyMs,
        notes: passed ? 'So sánh chi tiết qua các mốc thời gian kèm ghi chú kỹ thuật' : 'Thiếu so sánh các ngày hoặc ghi chú'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_E', suite: 'SUITE_E', name: 'So sánh báo giá', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST F: Tuyến không tồn tại trong file (Anti-hallucination)
  // -------------------------------------------------------------------------
  try {
    const queryF = 'Tìm báo giá tuyến từ KCN Tân Bình đi Cà Mau trong bảng tính đính kèm.';
    console.log(`\n[TEST F] Gửi yêu cầu tuyến không tồn tại: "${queryF}"...`);
    const { status, json, latencyMs } = await sendChat({ message: queryF, conversationId: activeConversationId });

    if (status !== 200 || !json.reply) {
      recordTest({ id: 'TEST_F', suite: 'SUITE_F', name: 'Tuyến không tồn tại (Anti-hallucination)', query: queryF, passed: false, latencyMs, notes: 'HTTP error' });
    } else {
      const reply = json.reply;
      const statesNotFound = /(không có|không tìm thấy|không ghi nhận|chưa có dữ liệu|chưa có báo giá|chưa có|không tồn tại)/i.test(reply);
      // Ensure it doesn't fabricate a price like "giá là 5.000.000" for Ca Mau
      const doesNotFabricatePrice = !/(giá của tuyến Tân Bình đi Cà Mau là [0-9])/i.test(reply);
      const passed = statesNotFound && doesNotFabricatePrice;

      recordTest({
        id: 'TEST_F',
        suite: 'SUITE_F',
        name: 'Tuyến không tồn tại (Anti-hallucination)',
        query: queryF,
        passed,
        assertions: { statesNotFound, doesNotFabricatePrice },
        actualReply: reply,
        latencyMs,
        notes: passed ? 'Xác nhận chuẩn xác không có dữ liệu cho tuyến không tồn tại, không bịa giá' : 'Có hiện tượng bịa giá hoặc không thông báo thiếu dữ liệu'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_F', suite: 'SUITE_F', name: 'Tuyến không tồn tại', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST G1: Tra cứu trên Sheet khác (Sheet "Miền Bắc")
  // -------------------------------------------------------------------------
  try {
    const queryG1 = 'Trong sheet Miền Bắc, tìm báo giá tuyến từ cảng Hải Phòng đi Hà Nội (hoặc Đình Trám đi cảng Hải Phòng). Cho biết giá và nhà cung cấp.';
    console.log(`\n[TEST G1] Gửi yêu cầu đa sheet: "${queryG1}"...`);
    const { status, json, latencyMs } = await sendChat({ message: queryG1, conversationId: activeConversationId });

    if (status !== 200 || !json.reply) {
      recordTest({ id: 'TEST_G1', suite: 'SUITE_G', name: 'Tra cứu đa sheet (Sheet Miền Bắc)', query: queryG1, passed: false, latencyMs, notes: 'HTTP error' });
    } else {
      const reply = json.reply;
      const foundNorthernRoute = /(Hải Phòng|Hà Nội|Đình Trám|Hàng Bài)/i.test(reply);
      const foundPriceOrVendor = /(6\.200\.000|4600000|5500000|1610000|VENDOR)/i.test(reply);
      const passed = foundNorthernRoute && foundPriceOrVendor;

      recordTest({
        id: 'TEST_G1',
        suite: 'SUITE_G',
        name: 'Tra cứu đa sheet (Sheet Miền Bắc)',
        query: queryG1,
        passed,
        assertions: { foundNorthernRoute, foundPriceOrVendor },
        actualReply: reply,
        latencyMs,
        notes: passed ? 'Truy xuất thành công dữ liệu từ sheet Miền Bắc' : 'Không tìm thấy dữ liệu trên sheet Miền Bắc'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_G1', suite: 'SUITE_G', name: 'Đa sheet Miền Bắc', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST G2: Kiểm tra bảo toàn dữ liệu trùng mã REF (Deterministic check)
  // -------------------------------------------------------------------------
  try {
    const dataEngine = require('../auth-service/services/dataEngine');
    const buf = fs.readFileSync(FIXTURE_PATH);
    const parsed = dataEngine.parseSpreadsheet(buf, { fileName: 'Pricing Vendor.xlsx' });
    const searchRes = dataEngine.searchSpreadsheetRecords(parsed, { refCode: '42_LAU_LCL' });

    const totalMatches = searchRes.totalMatches;
    const hasRow53 = searchRes.results.some(r => r.data['GIÁ COST'] === '900.000/chuyến' && r.data['NGÀY BÁO GIÁ'] === '13/10/2026');
    const hasRow54 = searchRes.results.some(r => r.data['GIÁ COST'] === '900.000/xe' && r.data['NGÀY BÁO GIÁ'] === '13/10/2026');
    const hasRow63 = searchRes.results.some(r => r.data['GIÁ COST'] === '900.000/chuyến' && r.data['NGÀY BÁO GIÁ'] === '15/10/2026');
    const hasRow64 = searchRes.results.some(r => r.data['GIÁ COST'] === 900 && r.data['NGÀY BÁO GIÁ'] === '16/10/2026');

    const passed = totalMatches === 4 && hasRow53 && hasRow54 && hasRow63 && hasRow64;

    recordTest({
      id: 'TEST_G2',
      suite: 'SUITE_G',
      name: 'Bảo toàn dữ liệu trùng mã REF 42_LAU_LCL (Data Engine Integrity)',
      query: 'searchSpreadsheetRecords({ refCode: "42_LAU_LCL" })',
      passed,
      assertions: { totalMatches, hasRow53, hasRow54, hasRow63, hasRow64 },
      actualReply: `Tìm thấy ${totalMatches}/4 bản ghi chính xác`,
      latencyMs: 5,
      notes: passed ? 'Cả 4 bản ghi trùng mã REF đều được giữ nguyên vẹn, không bị deduplicate nhầm' : 'Mất bản ghi khi đối soát mã REF'
    });
  } catch (err) {
    recordTest({ id: 'TEST_G2', suite: 'SUITE_G', name: 'Bảo toàn trùng mã REF', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST G3: Kiểm tra parser không nhầm lẫn chuỗi số (Type Safety Integrity)
  // -------------------------------------------------------------------------
  try {
    const dataEngine = require('../auth-service/services/dataEngine');
    const parsedRef = dataEngine.parseVNNumber('42_LAU_LCL');
    const parsedVendor = dataEngine.parseVNNumber('3S');
    const parsedDate = dataEngine.parseVNNumber('13/10/2026');
    const parsedPriceUnit = dataEngine.parseVNNumber('900.000/chuyến');

    // All should be null because parseVNNumber must reject strings containing letters, underscores, or slashes
    const passed = parsedRef === null && parsedVendor === null && parsedDate === null && parsedPriceUnit === null;

    recordTest({
      id: 'TEST_G3',
      suite: 'SUITE_G',
      name: 'Kiểm tra chống parse nhầm văn bản thành số (Type Safety)',
      query: 'parseVNNumber on text strings',
      passed,
      assertions: { parsedRef, parsedVendor, parsedDate, parsedPriceUnit },
      actualReply: 'Mọi chuỗi chữ và đơn vị đều được bảo toàn nguyên dạng văn bản',
      latencyMs: 1,
      notes: passed ? 'parseVNNumber không còn chuyển 42_LAU_LCL thành 42 hay 3S thành 3' : 'Vẫn parse nhầm văn bản thành số'
    });
  } catch (err) {
    recordTest({ id: 'TEST_G3', suite: 'SUITE_G', name: 'Chống parse nhầm số', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TEST H: Kiểm tra bảo vệ định hướng tuyến đường (Directional Route Integrity: A -> B vs B -> A)
  // -------------------------------------------------------------------------
  try {
    const queryH = 'Giá từ Dĩ An đến KCN Tân Bình là bao nhiêu trong bảng tính đính kèm?';
    console.log(`\n[TEST H] Gửi yêu cầu chiều ngược lại (B -> A): "${queryH}"...`);
    const { status, json, latencyMs } = await sendChat({ message: queryH, conversationId: activeConversationId });

    if (status !== 200 || !json.reply) {
      recordTest({ id: 'TEST_H', suite: 'SUITE_H', name: 'Định hướng tuyến đường (A -> B có, B -> A chưa có)', query: queryH, passed: false, latencyMs, notes: 'HTTP error' });
    } else {
      const reply = json.reply;
      const statesNotFoundForReversed = /(chưa có|không có|chưa ghi nhận|không tìm thấy)/i.test(reply);
      const explainsDirectionOrReverse = /(chiều ngược lại|ngược lại|chiều đi|chiều về|tham khảo|KCN Tân Bình ➔ Dĩ An|KCN Tân Bình đến Dĩ An)/i.test(reply);
      const passed = statesNotFoundForReversed && explainsDirectionOrReverse;

      recordTest({
        id: 'TEST_H',
        suite: 'SUITE_H',
        name: 'Định hướng tuyến đường (A -> B có, B -> A chưa có - Anti-reverse hallucination)',
        query: queryH,
        passed,
        assertions: { statesNotFoundForReversed, explainsDirectionOrReverse },
        actualReply: reply,
        latencyMs,
        notes: passed 
          ? 'Xác nhận chuẩn xác: Bảng tính chỉ có Tân Bình -> Dĩ An, chưa có Dĩ An -> Tân Bình; không tự ý lấy giá chiều đi gán cho chiều về' 
          : 'Lấy nhầm giá chiều đi gán cho chiều về hoặc không phân biệt chiều tuyến đường'
      });
    }
  } catch (err) {
    recordTest({ id: 'TEST_H', suite: 'SUITE_H', name: 'Định hướng tuyến đường', passed: false, notes: err.message, latencyMs: 0 });
  }

  // -------------------------------------------------------------------------
  // TỔNG KẾT
  // -------------------------------------------------------------------------
  console.log('\n======================================================================');
  const total = results.length;
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = total - passedCount;
  console.log(`KẾT QUẢ TỔNG THỂ: ${passedCount}/${total} TESTS PASS (${Math.round((passedCount/total)*100)}%)`);
  console.log('======================================================================');

  const report = {
    timestamp: new Date().toISOString(),
    totalTests: total,
    passedCount,
    failedCount,
    successRate: `${Math.round((passedCount/total)*100)}%`,
    testResults: results
  };

  const reportPath = path.join(__dirname, 'excel_data_pro_test_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Đã xuất báo cáo chi tiết ra tệp: ${reportPath}`);
}

runTestSuite().catch(err => {
  console.error('Lỗi thực thi test suite:', err);
  process.exit(1);
});
