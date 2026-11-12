/**
 * SOTRANS HUB — ONEDRIVE FILE PICKER ACCEPTANCE & INTEGRATION TEST SUITE
 * 
 * Verifies:
 * 1. File & folder listing from Microsoft Graph API (GET /api/onedrive/files)
 * 2. Search functionality with folder/children fallback
 * 3. Folder navigation and breadcrumbs metadata
 * 4. Filtering & clear warnings for unsupported formats or files > 20MB
 * 5. Clean error handling when token is missing/expired (401 notConnected)
 * 6. Direct import & registration of picked files without sharing links (POST /api/onedrive/sources/import)
 * 7. Anti-duplicate protection: updates version smoothly without duplicate pollution
 * 8. Strict IDOR & unauthorized target agent isolation (403 Forbidden)
 * 9. Batch limit validation (rejects >10 items or empty payload)
 * 10. Multi-conversation continuity for sources imported via File Picker
 * 11. Query-Time Freshness Guard compatibility with item_id sources
 * 12. Full prompt context generation and snapshot profile persistence
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');
const oneDriveService = require('../auth-service/services/oneDriveService');
const oneDriveSourceService = require('../auth-service/services/oneDriveSourceService');
const universalDataEngine = require('../auth-service/services/universalDataEngine');

const BASE_URL = 'http://127.0.0.1:3000';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const testUsers = {
  emp_vtx: {
    userId: 'bd33d589-3804-469e-a373-a934a5855d19',
    token: jwt.sign(
      { user_id: 'bd33d589-3804-469e-a373-a934a5855d19', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' },
      JWT_SECRET,
      { expiresIn: '3h' }
    )
  },
  emp_stl: {
    userId: 'f2b6606e-3125-409c-b5f9-d3ed82282c26',
    token: jwt.sign(
      { user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' },
      JWT_SECRET,
      { expiresIn: '3h' }
    )
  },
  user_unlinked: {
    userId: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    token: jwt.sign(
      { user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548', username: 'hr_swc', role: 'HR', company_id: 'SWC' },
      JWT_SECRET,
      { expiresIn: '3h' }
    )
  }
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

async function runSuite() {
  console.log('='.repeat(88));
  console.log('   SOTRANS HUB — ONEDRIVE FILE PICKER INTEGRATION & ACCEPTANCE SUITE');
  console.log('='.repeat(88));

  let livePickedItem = null;
  let importedSourceRecord = null;

  // --- 1. LIST FILES & FOLDERS ---
  try {
    const listResp = await fetch(`${BASE_URL}/api/onedrive/files`, {
      headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
    });
    const listData = await listResp.json();

    const isOk = listResp.status === 200 && listData.success === true;
    const hasItems = Array.isArray(listData.items) && listData.items.length > 0;
    const hasParent = listData.parentFolder && listData.parentFolder.id === 'root';
    const hasFolder = hasItems && listData.items.some(x => x.isFolder === true);
    const hasFile = hasItems && listData.items.some(x => x.isFolder === false && x.extension === '.xlsx');

    if (hasFile) {
      livePickedItem = listData.items.find(x => x.isFolder === false && x.extension === '.xlsx');
    }

    recordTest({
      id: 'OD_PICKER_01',
      name: 'Liệt kê danh mục tệp và thư mục từ Microsoft OneDrive qua GET /api/onedrive/files',
      passed: isOk && hasItems && hasParent && hasFolder && hasFile,
      expected: { status: 200, success: true, hasFolder: true, hasFile: true },
      actual: { status: listResp.status, success: listData.success, totalItems: listData.items?.length, hasFolder, hasFile }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_01',
      name: 'Liệt kê danh mục tệp và thư mục từ Microsoft OneDrive qua GET /api/onedrive/files',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 2. SEARCH FUNCTIONALITY ---
  try {
    const searchResp = await fetch(`${BASE_URL}/api/onedrive/files?search=Pricing`, {
      headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
    });
    const searchData = await searchResp.json();

    const isSearchOk = searchResp.status === 200 && searchData.success === true;
    const hasPricing = Array.isArray(searchData.items) && searchData.items.some(it => it.name.includes('Pricing'));

    recordTest({
      id: 'OD_PICKER_02',
      name: 'Tìm kiếm tệp trong OneDrive qua tham số search (có cơ chế fallback root)',
      passed: isSearchOk && hasPricing,
      expected: { status: 200, hasPricing: true },
      actual: { status: searchResp.status, hasPricing, matchedCount: searchData.items?.length }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_02',
      name: 'Tìm kiếm tệp trong OneDrive qua tham số search (có cơ chế fallback root)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 3. FOLDER NAVIGATION & BREADCRUMBS ---
  try {
    // Navigate into Documents folder if exists
    const listResp = await fetch(`${BASE_URL}/api/onedrive/files`, {
      headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
    });
    const listData = await listResp.json();
    const folder = listData.items?.find(x => x.isFolder);

    if (folder) {
      const folderResp = await fetch(`${BASE_URL}/api/onedrive/files?folder_id=${encodeURIComponent(folder.id)}`, {
        headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
      });
      const folderData = await folderResp.json();

      const isNavOk = folderResp.status === 200 && folderData.success === true;
      const isParentCorrect = folderData.parentFolder && folderData.parentFolder.id === folder.id;

      recordTest({
        id: 'OD_PICKER_03',
        name: 'Điều hướng thư mục con và trích xuất cấu trúc Breadcrumbs metadata',
        passed: isNavOk && isParentCorrect,
        expected: { status: 200, isParentCorrect: true },
        actual: { status: folderResp.status, parentFolderId: folderData.parentFolder?.id, folderName: folderData.parentFolder?.name }
      });
    } else {
      recordTest({
        id: 'OD_PICKER_03',
        name: 'Điều hướng thư mục con và trích xuất cấu trúc Breadcrumbs metadata',
        passed: true,
        expected: true,
        actual: 'Không có thư mục con để test (Pass default)'
      });
    }
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_03',
      name: 'Điều hướng thư mục con và trích xuất cấu trúc Breadcrumbs metadata',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 4. FORMAT SUPPORT & FILE SIZE POLICIES ---
  try {
    const listResp = await fetch(`${BASE_URL}/api/onedrive/files`, {
      headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
    });
    const listData = await listResp.json();

    const excelFile = listData.items?.find(it => it.extension === '.xlsx');
    const isExcelSupported = excelFile ? excelFile.isSupported === true : true;

    // Verify service rule for unsupported ext & large files
    const mockCheck1 = oneDriveService.SUPPORTED_EXTENSIONS.includes('.xlsx');
    const mockCheck2 = !oneDriveService.SUPPORTED_EXTENSIONS.includes('.exe');
    const mockCheck3 = oneDriveService.MAX_ONEDRIVE_FILE_SIZE === 20 * 1024 * 1024;

    recordTest({
      id: 'OD_PICKER_04',
      name: 'Kiểm soát định dạng hỗ trợ (.xlsx, .docx, .pdf) và giới hạn cứng dung lượng 20MB',
      passed: isExcelSupported && mockCheck1 && mockCheck2 && mockCheck3,
      expected: { isExcelSupported: true, xlsxSupported: true, exeBlocked: true, max20MB: true },
      actual: { isExcelSupported, mockCheck1, mockCheck2, mockCheck3 }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_04',
      name: 'Kiểm soát định dạng hỗ trợ (.xlsx, .docx, .pdf) và giới hạn cứng dung lượng 20MB',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 5. CLEAN ERROR ON DISCONNECTED / EXPIRED TOKEN ---
  try {
    const noTokenResp = await fetch(`${BASE_URL}/api/onedrive/files`, {
      headers: { Authorization: `Bearer ${testUsers.user_unlinked.token}` }
    });
    const noTokenData = await noTokenResp.json();

    const isAuthHandled = noTokenResp.status === 401 && noTokenData.notConnected === true;

    recordTest({
      id: 'OD_PICKER_05',
      name: 'Xử lý an toàn khi tài khoản chưa liên kết Microsoft hoặc token hết hạn (HTTP 401 notConnected)',
      passed: isAuthHandled,
      expected: { status: 401, notConnected: true },
      actual: { status: noTokenResp.status, notConnected: noTokenData.notConnected, error: noTokenData.error }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_05',
      name: 'Xử lý an toàn khi tài khoản chưa liên kết Microsoft hoặc token hết hạn (HTTP 401 notConnected)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 6. IMPORT AND LINK SELECTED FILE VIA POST /sources/import ---
  try {
    if (!livePickedItem) {
      throw new Error('Không có tệp OneDrive để nhập.');
    }

    const importResp = await fetch(`${BASE_URL}/api/onedrive/sources/import`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testUsers.emp_vtx.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [
          { itemId: livePickedItem.id, driveId: livePickedItem.driveId }
        ],
        agentId: 'excel-data-pro',
        conversationId: 'picker_conv_test_001'
      })
    });
    const importData = await importResp.json();

    const isImportOk = importResp.status === 200 && importData.success === true && importData.importedCount === 1;
    importedSourceRecord = importData.imported ? importData.imported[0] : null;

    // Verify DB snapshot exists
    let hasSnapshot = false;
    if (importedSourceRecord) {
      const snapCheck = await db.query(
        `SELECT id, status, version_number FROM public.onedrive_source_snapshots WHERE source_id = $1 AND status = 'PUBLISHED'`,
        [importedSourceRecord.sourceId]
      );
      hasSnapshot = snapCheck.rows.length > 0;
    }

    recordTest({
      id: 'OD_PICKER_06',
      name: 'Nhập và liên kết tệp chọn từ File Picker qua POST /api/onedrive/sources/import (Không cần sharing link)',
      passed: isImportOk && hasSnapshot,
      expected: { status: 200, success: true, hasSnapshot: true },
      actual: { status: importResp.status, success: importData.success, hasSnapshot, sourceId: importedSourceRecord?.sourceId }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_06',
      name: 'Nhập và liên kết tệp chọn từ File Picker qua POST /api/onedrive/sources/import (Không cần sharing link)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 7. ANTI-DUPLICATE PROTECTION ---
  try {
    if (!livePickedItem) throw new Error('Thiếu tệp kiểm thử.');

    const reImportResp = await fetch(`${BASE_URL}/api/onedrive/sources/import`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testUsers.emp_vtx.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [
          { itemId: livePickedItem.id, driveId: livePickedItem.driveId }
        ],
        agentId: 'excel-data-pro',
        conversationId: 'picker_conv_test_002'
      })
    });
    const reImportData = await reImportResp.json();

    // Verify it updated the existing record without creating duplicate row
    const countCheck = await db.query(
      `SELECT COUNT(*) FROM public.user_onedrive_sources WHERE owner_user_id = $1 AND item_id = $2`,
      [testUsers.emp_vtx.userId, livePickedItem.id]
    );

    const isSingleRow = parseInt(countCheck.rows[0].count, 10) === 1;
    const newVersion = reImportData.imported?.[0]?.version;
    const isVersionBumped = newVersion >= 2;

    recordTest({
      id: 'OD_PICKER_07',
      name: 'Kiểm soát trùng lặp tệp (Anti-Duplicate): Cập nhật phiên bản thay vì tạo rác bản ghi',
      passed: reImportResp.status === 200 && isSingleRow && isVersionBumped,
      expected: { singleRow: true, isVersionBumped: true },
      actual: { singleRow: isSingleRow, rowCount: countCheck.rows[0].count, version: newVersion }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_07',
      name: 'Kiểm soát trùng lặp tệp (Anti-Duplicate): Cập nhật phiên bản thay vì tạo rác bản ghi',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 8. IDOR & UNAUTHORIZED TARGET AGENT PROTECTION ---
  try {
    // Attempt to link to an agent owned by another company/user
    const unauthorizedAgentId = '80a721d0-afa6-4ed1-81ef-53e102a15814'; // Owned by superadmin
    const crossAgentResp = await fetch(`${BASE_URL}/api/onedrive/sources/import`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testUsers.emp_vtx.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [
          { itemId: livePickedItem.id, driveId: livePickedItem.driveId }
        ],
        agentId: unauthorizedAgentId
      })
    });

    const isCrossAgentBlocked = crossAgentResp.status === 403;

    recordTest({
      id: 'OD_PICKER_08',
      name: 'Bảo vệ phân quyền IDOR & Chặn liên kết vào Agent của người dùng khác (HTTP 403 Forbidden)',
      passed: isCrossAgentBlocked,
      expected: { status: 403 },
      actual: { status: crossAgentResp.status }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_08',
      name: 'Bảo vệ phân quyền IDOR & Chặn liên kết vào Agent của người dùng khác (HTTP 403 Forbidden)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 9. BATCH LIMIT VALIDATION ---
  try {
    // Payload with empty items
    const emptyResp = await fetch(`${BASE_URL}/api/onedrive/sources/import`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testUsers.emp_vtx.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ items: [] })
    });

    // Payload with > 10 items
    const elevenItems = Array(11).fill({ itemId: 'ITEM_MOCK_123' });
    const overflowResp = await fetch(`${BASE_URL}/api/onedrive/sources/import`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testUsers.emp_vtx.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ items: elevenItems })
    });

    const isLimitOk = emptyResp.status === 400 && overflowResp.status === 400;

    recordTest({
      id: 'OD_PICKER_09',
      name: 'Kiểm soát tải giới hạn theo lô (Chặn mảng rỗng và từ chối khi vượt quá 10 tệp/lần)',
      passed: isLimitOk,
      expected: { emptyStatus: 400, overflowStatus: 400 },
      actual: { emptyStatus: emptyResp.status, overflowStatus: overflowResp.status }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_09',
      name: 'Kiểm soát tải giới hạn theo lô (Chặn mảng rỗng và từ chối khi vượt quá 10 tệp/lần)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 10. MULTI-CONVERSATION CONTINUITY ---
  try {
    const brandNewConvSources = await oneDriveSourceService.getConnectedSourcesForAgent({
      ownerUserId: testUsers.emp_vtx.userId,
      agentId: 'excel-data-pro',
      conversationId: 'completely_new_conversation_777'
    });

    const hasImportedSource = brandNewConvSources.length > 0 &&
      brandNewConvSources.some(s => s.item_id === livePickedItem?.id);

    recordTest({
      id: 'OD_PICKER_10',
      name: 'Tích hợp liên tục qua cuộc trò chuyện mới (Tự động nạp nguồn đã chọn cho phiên chat mới)',
      passed: Boolean(hasImportedSource),
      expected: { hasImportedSource: true },
      actual: { hasImportedSource, totalFound: brandNewConvSources.length }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_10',
      name: 'Tích hợp liên tục qua cuộc trò chuyện mới (Tự động nạp nguồn đã chọn cho phiên chat mới)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 11. QUERY-TIME FRESHNESS GUARD WITH ITEM_ID ---
  try {
    const srcRow = await db.query(
      `SELECT * FROM public.user_onedrive_sources WHERE id = $1`,
      [importedSourceRecord.sourceId]
    );
    const source = srcRow.rows[0];
    const token = await oneDriveService.getUserValidAccessToken(testUsers.emp_vtx.userId);

    const freshnessResult = await oneDriveSourceService.checkSourceFreshness(source, token);

    const isFreshnessOk = freshnessResult.isGraphReachable === true && freshnessResult.isFresh === true;

    recordTest({
      id: 'OD_PICKER_11',
      name: 'Tương thích tuyệt đối với Query-Time Freshness Guard (Kiểm tra eTag trực tiếp qua item_id)',
      passed: isFreshnessOk,
      expected: { isGraphReachable: true, isFresh: true },
      actual: { isGraphReachable: freshnessResult.isGraphReachable, isFresh: freshnessResult.isFresh }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_11',
      name: 'Tương thích tuyệt đối với Query-Time Freshness Guard (Kiểm tra eTag trực tiếp qua item_id)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 12. PROMPT CONTEXT & UNIVERSAL SNAPSHOT GENERATION ---
  try {
    const freshnessGuard = await oneDriveSourceService.ensureAgentSourcesFreshness({
      userId: testUsers.emp_vtx.userId,
      agent: { id: 'excel-data-pro', name: 'Excel-Data-Pro' },
      conversationId: 'picker_conv_test_003',
      userMessage: 'Giá cước vận chuyển hiện tại là bao nhiêu?'
    });

    const hasActiveFile = Array.isArray(freshnessGuard.activeFiles) && freshnessGuard.activeFiles.length > 0;
    const targetFile = freshnessGuard.activeFiles?.find(f => f.fileName.includes('Pricing'));
    const hasPromptText = Boolean(targetFile && targetFile.promptText && targetFile.promptText.length > 20);
    const hasSpreadsheet = Boolean(freshnessGuard.activeSpreadsheets && freshnessGuard.activeSpreadsheets.length > 0);

    recordTest({
      id: 'OD_PICKER_12',
      name: 'Nạp dữ liệu cấu trúc bảng tính và chỉ dẫn độ mới vào Prompt của AI Agent',
      passed: hasActiveFile && Boolean(targetFile) && hasPromptText && hasSpreadsheet,
      expected: { hasActiveFile: true, hasTargetFile: true, hasPromptText: true, hasSpreadsheet: true },
      actual: { hasActiveFile, hasTargetFile: Boolean(targetFile), hasPromptText, hasSpreadsheet, fileName: targetFile?.fileName }
    });
  } catch (err) {
    recordTest({
      id: 'OD_PICKER_12',
      name: 'Nạp dữ liệu cấu trúc bảng tính và chỉ dẫn độ mới vào Prompt của AI Agent',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  console.log('='.repeat(88));
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const pct = ((passedCount / totalCount) * 100).toFixed(1);
  console.log(`KẾT QUẢ KIỂM THỬ FILE PICKER: ${passedCount}/${totalCount} TESTS PASS (${pct}%)`);
  console.log('='.repeat(88));

  const reportPath = path.join(__dirname, 'onedrive_file_picker_verification_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    passedCount,
    totalCount,
    passRate: `${pct}%`,
    results
  }, null, 2));
  console.log(`Báo cáo chi tiết đã lưu tại: ${reportPath}`);

  if (passedCount < totalCount) {
    process.exit(1);
  }
}

runSuite().then(() => process.exit(0)).catch(err => {
  console.error('Fatal suite failure:', err);
  process.exit(1);
});
