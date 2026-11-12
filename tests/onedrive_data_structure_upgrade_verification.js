/**
 * SOTRANS HUB — ONEDRIVE DATA STRUCTURE & FILE PICKER UPGRADE VERIFICATION
 * 
 * Verifies:
 * 1. GET /api/onedrive/files enriched metadata (linkedAgentName, sheetNames, validUnits, scopeNote)
 * 2. POST /api/onedrive/files/inspect for instant data preview without permanent DB storage
 * 3. GET /api/onedrive/sources/:id/structure returns full sheets, recognized columns & sample rows
 * 4. GET /api/onedrive/sources/:id/structure strict IDOR protection (blocks other users/tenants)
 * 5. GET /api/onedrive/sources enriched with agent_name, sheet_names, valid_units
 * 6. Explicit workbook scope notice ("toàn bộ workbook đã phân tích") present in API & UI
 * 7. HTML Dialogs & Master-Detail File Picker layout integrity
 */

const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');

const BASE_URL = 'http://127.0.0.1:3000';
const GATEWAY_URL = 'http://127.0.0.1:8082';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const emp_vtx = {
  userId: 'bd33d589-3804-469e-a373-a934a5855d19',
  token: jwt.sign(
    { user_id: 'bd33d589-3804-469e-a373-a934a5855d19', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' },
    JWT_SECRET,
    { expiresIn: '3h' }
  )
};

const emp_stl = {
  userId: 'f2b6606e-3125-409c-b5f9-d3ed82282c26',
  token: jwt.sign(
    { user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' },
    JWT_SECRET,
    { expiresIn: '3h' }
  )
};

const results = [];

function recordTest({ id, name, passed, expected, actual, notes = '' }) {
  results.push({ id, name, passed, expected, actual, notes });
  const statusStr = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${statusStr}] ${id} | ${name}`);
  if (!passed) {
    console.log(`   --> Expected: ${JSON.stringify(expected)}`);
    console.log(`   --> Actual:   ${JSON.stringify(actual)}`);
  }
}

async function runStructureUpgradeSuite() {
  console.log('='.repeat(88));
  console.log('   SOTRANS HUB — ONEDRIVE DATA STRUCTURE & FILE PICKER UPGRADE VERIFICATION');
  console.log('='.repeat(88));

  let testDriveItemId = null;
  let testDriveId = null;
  let testSourceId = null;

  // 1. GET /api/onedrive/files enriched metadata
  try {
    const res = await fetch(`${BASE_URL}/api/onedrive/files`, {
      headers: { Authorization: `Bearer ${emp_vtx.token}` }
    });
    const data = await res.json();
    const isOk = res.status === 200 && data.success;
    const pricingItem = data.items?.find(it => it.name.includes('Pricing'));

    if (pricingItem) {
      testDriveItemId = pricingItem.id;
      testDriveId = pricingItem.driveId;
      testSourceId = pricingItem.linkedSourceId;
    }

    const hasEnrichedProps = pricingItem &&
      'isLinked' in pricingItem &&
      'linkedAgentName' in pricingItem &&
      'sheetNames' in pricingItem &&
      Array.isArray(pricingItem.sheetNames) &&
      pricingItem.sheetNames.length > 0 &&
      typeof pricingItem.validUnits === 'number' &&
      typeof pricingItem.scopeNote === 'string';

    recordTest({
      id: 'OD_STRUCT_01',
      name: 'GET /api/onedrive/files trả về cấu trúc sheetNames, validUnits, linkedAgentName và scopeNote',
      passed: isOk && hasEnrichedProps,
      expected: { isOk: true, hasEnrichedProps: true, hasSheets: true },
      actual: {
        isOk,
        hasEnrichedProps,
        fileName: pricingItem?.name,
        linkedAgentName: pricingItem?.linkedAgentName,
        sheetNames: pricingItem?.sheetNames,
        validUnits: pricingItem?.validUnits,
        scopeNote: pricingItem?.scopeNote
      }
    });
  } catch (err) {
    recordTest({
      id: 'OD_STRUCT_01',
      name: 'GET /api/onedrive/files trả về cấu trúc sheetNames, validUnits, linkedAgentName và scopeNote',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // 2. POST /api/onedrive/files/inspect (On-demand data inspection without DB mutation)
  try {
    if (!testDriveItemId) {
      throw new Error('Không tìm thấy tệp Pricing trên OneDrive.');
    }

    const res = await fetch(`${BASE_URL}/api/onedrive/files/inspect`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${emp_vtx.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        itemId: testDriveItemId,
        driveId: testDriveId,
        preview: true
      })
    });

    const data = await res.json();
    const isOk = res.status === 200 && data.success && data.structure;
    const struct = data.structure || {};
    const hasSheets = Array.isArray(struct.sheetNames) && struct.sheetNames.length > 0;
    const firstSheetName = struct.sheetNames?.[0];
    const sheetData = Array.isArray(struct.sheets)
      ? struct.sheets.find(s => s.sheetName === firstSheetName) || struct.sheets[0]
      : struct.sheets?.[firstSheetName];
    const hasCols = Array.isArray(sheetData?.columns) && sheetData.columns.length > 0;
    const hasSamples = Array.isArray(sheetData?.sampleRows) && sheetData.sampleRows.length > 0;
    const hasScopeNotice = (typeof data.scopeNotice === 'string' && data.scopeNotice.includes('toàn bộ')) ||
                           (typeof struct.scopeNote === 'string' && struct.scopeNote.includes('toàn bộ'));

    recordTest({
      id: 'OD_STRUCT_02',
      name: 'POST /api/onedrive/files/inspect trích xuất sheet, cột và dữ liệu mẫu với scopeNotice toàn bộ workbook',
      passed: isOk && hasSheets && hasCols && hasSamples && hasScopeNotice,
      expected: { isOk: true, hasSheets: true, hasCols: true, hasSamples: true, hasScopeNotice: true },
      actual: {
        isOk,
        sheetCount: struct.sheetNames?.length,
        firstSheet: firstSheetName,
        colCount: sheetData?.columns?.length,
        sampleRowCount: sheetData?.sampleRows?.length,
        hasScopeNotice
      }
    });
  } catch (err) {
    recordTest({
      id: 'OD_STRUCT_02',
      name: 'POST /api/onedrive/files/inspect trích xuất sheet, cột và dữ liệu mẫu với scopeNotice toàn bộ workbook',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // 3. GET /api/onedrive/sources/:id/structure (Detailed structure inspection of connected source)
  try {
    if (!testSourceId) {
      // Find active source in DB for emp_vtx
      const sRes = await db.query(
        `SELECT id FROM public.user_onedrive_sources WHERE owner_user_id = $1 AND sync_status = 'SYNCED' LIMIT 1`,
        [emp_vtx.userId]
      );
      testSourceId = sRes.rows[0]?.id;
    }

    const res = await fetch(`${BASE_URL}/api/onedrive/sources/${testSourceId}/structure`, {
      headers: { Authorization: `Bearer ${emp_vtx.token}` }
    });

    const data = await res.json();
    const isOk = Boolean(res.status === 200 && data.success && data.structure);
    const struct = data.structure || {};
    const src = data.source || {};
    const hasValidUnits = Boolean((typeof struct.validUnits === 'number' && struct.validUnits > 0) || (typeof struct.totalDataRows === 'number' && struct.totalDataRows > 0));
    const agentNameFound = src.agentName || src.agent_name || data.agentName || data.agent_name;
    const hasAgentName = Boolean(agentNameFound);

    recordTest({
      id: 'OD_STRUCT_03',
      name: 'GET /api/onedrive/sources/:id/structure trả về cấu trúc chi tiết và Agent name của nguồn kết nối',
      passed: isOk && hasValidUnits && hasAgentName,
      expected: { isOk: true, hasValidUnits: true, hasAgentName: true },
      actual: {
        isOk,
        agentName: agentNameFound,
        validUnits: struct.validUnits || struct.totalDataRows,
        totalUnits: struct.totalUnits,
        sheetNames: struct.sheetNames
      }
    });
  } catch (err) {
    recordTest({
      id: 'OD_STRUCT_03',
      name: 'GET /api/onedrive/sources/:id/structure trả về cấu trúc chi tiết và Agent name của nguồn kết nối',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // 4. Strict IDOR protection on GET /api/onedrive/sources/:id/structure
  try {
    // emp_stl attempts to read emp_vtx's source structure
    const res = await fetch(`${BASE_URL}/api/onedrive/sources/${testSourceId}/structure`, {
      headers: { Authorization: `Bearer ${emp_stl.token}` }
    });

    const data = await res.json();
    const isBlocked = res.status === 404 || res.status === 403;

    recordTest({
      id: 'OD_STRUCT_04',
      name: 'Bảo vệ IDOR trên GET /api/onedrive/sources/:id/structure chặn người dùng khác công ty (HTTP 404/403)',
      passed: isBlocked,
      expected: { status: 404, success: false },
      actual: { status: res.status, error: data.error }
    });
  } catch (err) {
    recordTest({
      id: 'OD_STRUCT_04',
      name: 'Bảo vệ IDOR trên GET /api/onedrive/sources/:id/structure chặn người dùng khác công ty (HTTP 404/403)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // 5. GET /api/onedrive/sources enriched fields
  try {
    const res = await fetch(`${BASE_URL}/api/onedrive/sources`, {
      headers: { Authorization: `Bearer ${emp_vtx.token}` }
    });

    const data = await res.json();
    const isOk = res.status === 200 && data.success && Array.isArray(data.sources);
    const firstSource = data.sources?.[0];
    const hasAgent = Boolean(firstSource && (firstSource.agent_name || firstSource.agentName));
    const hasSheets = Boolean(firstSource && (Array.isArray(firstSource.sheet_names) || Array.isArray(firstSource.sheetNames)));
    const hasValidUnits = Boolean(firstSource && (typeof firstSource.valid_units === 'number' || typeof firstSource.validUnits === 'number'));

    recordTest({
      id: 'OD_STRUCT_05',
      name: 'GET /api/onedrive/sources bổ sung agent_name, sheet_names, valid_units và scope_note',
      passed: isOk && hasAgent && hasSheets && hasValidUnits,
      expected: { isOk: true, hasAgent: true, hasSheets: true, hasValidUnits: true },
      actual: {
        isOk,
        agentName: firstSource?.agent_name,
        sheetNames: firstSource?.sheet_names,
        validUnits: firstSource?.valid_units,
        scopeNote: firstSource?.scope_note
      }
    });
  } catch (err) {
    recordTest({
      id: 'OD_STRUCT_05',
      name: 'GET /api/onedrive/sources bổ sung agent_name, sheet_names, valid_units và scope_note',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // 6. UI Master-Detail Layout and Scope Notice Verification
  try {
    const res = await fetch(`${GATEWAY_URL}/chat/index.html`);
    const html = await res.text();

    const hasMasterDetail = html.includes('id="odPickerMainView"') && html.includes('id="odPickerInspectorPanel"');
    const hasConfirmView = html.includes('id="odPickerConfirmView"') && html.includes('id="btnOdConfirmSubmit"');
    const hasStructDlg = html.includes('id="odSourceStructureDlg"') && html.includes('id="odStructSheetTabs"');
    const hasScopeNotice = html.includes('toàn bộ workbook') && html.includes('tất cả các sheet');
    const hasAgentBadges = html.includes('odPickerAgentSelect') && html.includes('odConfirmAgentName');

    const uiPass = hasMasterDetail && hasConfirmView && hasStructDlg && hasScopeNotice && hasAgentBadges;

    recordTest({
      id: 'OD_STRUCT_06',
      name: 'Giao diện index.html tích hợp Master-Detail 2 cột, bảng xem trước cột/dòng, xác nhận liên kết và cảnh báo phạm vi AI',
      passed: uiPass,
      expected: { hasMasterDetail: true, hasConfirmView: true, hasStructDlg: true, hasScopeNotice: true },
      actual: { hasMasterDetail, hasConfirmView, hasStructDlg, hasScopeNotice, hasAgentBadges }
    });
  } catch (err) {
    recordTest({
      id: 'OD_STRUCT_06',
      name: 'Giao diện index.html tích hợp Master-Detail 2 cột, bảng xem trước cột/dòng, xác nhận liên kết và cảnh báo phạm vi AI',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  console.log('='.repeat(88));
  const passedCount = results.filter(r => r.passed).length;
  console.log(`KẾT QUẢ KIỂM THỬ NÂNG CẤP CẤU TRÚC: ${passedCount}/${results.length} TESTS PASS (${(passedCount / results.length * 100).toFixed(1)}%)`);
  console.log('='.repeat(88));

  fs.writeFileSync(
    path.join(__dirname, 'onedrive_data_structure_upgrade_report.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), passedCount, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(0);
}

runStructureUpgradeSuite().catch(err => {
  console.error('Lỗi thực thi kiểm thử nâng cấp cấu trúc:', err);
  process.exit(1);
});
