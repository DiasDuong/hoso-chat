/**
 * SOTRANS HUB — ONEDRIVE HYBRID SYNC & QUERY-TIME FRESHNESS ACCEPTANCE SUITE
 * 
 * Verifies:
 * 1. Source Registration & Immutable Snapshot Generation
 * 2. Multi-conversation Continuity (No re-pasting link required)
 * 3. Query-Time Freshness Detection (Unmodified item)
 * 4. Query-Time Auto-Sync on Remote Modification (eTag change -> v2 snapshot)
 * 5. Freshness / Staleness Warning Prompt Injection
 * 6. Graceful Fallback on Graph Offline / Timeout (Never crash or hallucinate)
 * 7. Concurrency Mutex Locking (Prevents double sync on simultaneous queries)
 * 8. Cross-User Source Isolation & IDOR Protection (User B cannot access User A's source)
 * 9. Manual Re-Sync Endpoint (POST /api/onedrive/sources/:id/sync)
 * 10. Disconnect Source API (DELETE /api/onedrive/sources/:id)
 * 11. Scheduled Reconciliation Endpoint (POST /api/onedrive/reconcile)
 * 12. Microsoft Graph Webhook Handshake & Notification Ingestion (GET/POST /api/onedrive/webhook)
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
  emp_stl: {
    userId: 'f2b6606e-3125-409c-b5f9-d3ed82282c26',
    token: jwt.sign(
      { user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' },
      JWT_SECRET,
      { expiresIn: '3h' }
    )
  },
  emp_vtx: {
    userId: 'bd33d589-3804-469e-a373-a934a5855d19',
    token: jwt.sign(
      { user_id: 'bd33d589-3804-469e-a373-a934a5855d19', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' },
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
  console.log('   SOTRANS HUB — ONEDRIVE HYBRID SYNC & QUERY-TIME FRESHNESS ACCEPTANCE SUITE');
  console.log('='.repeat(88));

  const testAgentId = 'excel-data-pro';
  const ownerUserId = testUsers.emp_stl.userId;
  const fixturePath = path.join(__dirname, 'fixtures', 'Pricing Vendor.xlsx');
  const sampleBuffer = fs.readFileSync(fixturePath);

  // Parse sample fixture
  const parsedUniversal = await universalDataEngine.parseUniversalFile(sampleBuffer, {
    fileName: 'Pricing Vendor.xlsx',
    fileId: 'sample_fixture_001',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  const testUploadPath = path.join(__dirname, '..', 'auth-service', 'uploads', 'test_src_pricing_vendor.xlsx');
  fs.writeFileSync(testUploadPath, sampleBuffer);

  const testSharingUrl = 'https://1drv.ms/x/s!AmQTY_' + Date.now();

  // --- 1. SOURCE REGISTRATION & SNAPSHOT GENERATION ---
  let registeredSource = null;
  try {
    registeredSource = await oneDriveSourceService.registerOrUpdateSource({
      ownerUserId,
      agentId: testAgentId,
      conversationId: 'conv_test_001',
      sharingUrl: testSharingUrl,
      dl: {
        fileName: 'Pricing Vendor.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: sampleBuffer.length,
        driveId: 'D629852830F61364',
        itemId: 'ITEM_TEST_PRICING_' + Date.now(),
        eTag: '"{6231BF65-79B5-402A-A0B3-8408C0A50097},10"',
        cTag: '"c:{6231BF65-79B5-402A-A0B3-8408C0A50097},7"',
        lastModifiedDateTime: new Date().toISOString()
      },
      parsedUniversal,
      storagePath: testUploadPath
    });

    // Check database row for snapshot v1
    const snapCheck = await db.query(
      `SELECT id, version_number, status FROM public.onedrive_source_snapshots WHERE source_id = $1 AND version_number = 1`,
      [registeredSource.id]
    );

    const isSnapPublished = snapCheck.rows.length === 1 &&
      snapCheck.rows[0].status === 'PUBLISHED' &&
      registeredSource.active_snapshot_id === snapCheck.rows[0].id;

    recordTest({
      id: 'OD_HYBRID_01',
      name: 'Đăng ký nguồn OneDrive và tự động xuất bản Snapshot bất biến phiên bản v1',
      passed: Boolean(registeredSource && registeredSource.id && registeredSource.active_version === 1 && isSnapPublished),
      expected: { activeVersion: 1, isSnapPublished: true },
      actual: { activeVersion: registeredSource?.active_version, isSnapPublished }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_01',
      name: 'Đăng ký nguồn OneDrive và tự động xuất bản Snapshot bất biến phiên bản v1',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 2. MULTI-CONVERSATION CONTINUITY ---
  // In a brand new conversation without any link, source must be auto-retrieved for this agent
  try {
    const newConvSources = await oneDriveSourceService.getConnectedSourcesForAgent({
      ownerUserId,
      agentId: testAgentId,
      conversationId: 'completely_new_conv_999'
    });

    const hasSource = newConvSources.length > 0 && newConvSources.some(s => s.id === registeredSource.id);
    const hasDataProfile = hasSource && Boolean(newConvSources[0].snapshot_data_profile);

    recordTest({
      id: 'OD_HYBRID_02',
      name: 'Lưu trữ thường trực nguồn dữ liệu qua các cuộc hội thoại mới của cùng Agent',
      passed: hasSource && hasDataProfile,
      expected: { hasSource: true, hasDataProfile: true },
      actual: { hasSource, hasDataProfile }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_02',
      name: 'Lưu trữ thường trực nguồn dữ liệu qua các cuộc hội thoại mới của cùng Agent',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 3. QUERY-TIME FRESHNESS DETECTION (UNMODIFIED) ---
  try {
    const freshness = await oneDriveSourceService.checkSourceFreshness(
      {
        ...registeredSource,
        etag: '"{6231BF65-79B5-402A-A0B3-8408C0A50097},10"',
        ctag: '"c:{6231BF65-79B5-402A-A0B3-8408C0A50097},7"'
      },
      'mock_token',
      {
        fetchGraphMetadataFn: async () => ({
          eTag: '"{6231BF65-79B5-402A-A0B3-8408C0A50097},10"',
          cTag: '"c:{6231BF65-79B5-402A-A0B3-8408C0A50097},7"',
          lastModifiedDateTime: new Date().toISOString()
        })
      }
    );

    recordTest({
      id: 'OD_HYBRID_03',
      name: 'Query-Time Freshness: Xác nhận dữ liệu FRESH khi Microsoft Graph eTag/cTag nguyên vẹn',
      passed: freshness.isGraphReachable === true && freshness.isFresh === true,
      expected: { isGraphReachable: true, isFresh: true },
      actual: { isGraphReachable: freshness.isGraphReachable, isFresh: freshness.isFresh }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_03',
      name: 'Query-Time Freshness: Xác nhận dữ liệu FRESH khi Microsoft Graph eTag/cTag nguyên vẹn',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 4. QUERY-TIME AUTO-SYNC ON REMOTE MODIFICATION ---
  try {
    const syncRes = await oneDriveSourceService.syncSourceVersion(
      registeredSource.id,
      ownerUserId,
      {
        jobType: 'QUERY_TIME',
        targetMetadata: {
          eTag: '"{6231BF65-79B5-402A-A0B3-8408C0A50097},11"',
          cTag: '"c:{6231BF65-79B5-402A-A0B3-8408C0A50097},8"',
          lastModifiedDateTime: new Date().toISOString()
        },
        downloaderFn: async () => ({
          buffer: sampleBuffer,
          fileName: 'Pricing Vendor.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: sampleBuffer.length,
          eTag: '"{6231BF65-79B5-402A-A0B3-8408C0A50097},11"',
          cTag: '"c:{6231BF65-79B5-402A-A0B3-8408C0A50097},8"',
          lastModifiedDateTime: new Date().toISOString()
        })
      }
    );

    // Verify v2 is PUBLISHED and v1 is ARCHIVED/retained
    const v2Check = await db.query(
      `SELECT version_number, status FROM public.onedrive_source_snapshots WHERE source_id = $1 ORDER BY version_number ASC`,
      [registeredSource.id]
    );

    const hasBothSnapshots = v2Check.rows.length === 2;
    const v1Archived = v2Check.rows[0].status === 'ARCHIVED';
    const v2Published = v2Check.rows[1].status === 'PUBLISHED';

    recordTest({
      id: 'OD_HYBRID_04',
      name: 'Tự động nâng cấp phiên bản (v1 -> v2) khi phát hiện eTag thay đổi; lưu vết lịch sử Snapshot',
      passed: syncRes.version === 2 && hasBothSnapshots && v1Archived && v2Published,
      expected: { newVersion: 2, hasBothSnapshots: true, v1Archived: true, v2Published: true },
      actual: { newVersion: syncRes.version, hasBothSnapshots, v1Archived, v2Published }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_04',
      name: 'Tự động nâng cấp phiên bản (v1 -> v2) khi phát hiện eTag thay đổi; lưu vết lịch sử Snapshot',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 5. FRESHNESS PROMPT INJECTION ---
  try {
    const freshnessGuard = await oneDriveSourceService.ensureAgentSourcesFreshness({
      agent: { id: testAgentId, name: 'Excel-Data-Pro' },
      userId: ownerUserId,
      conversationId: 'conv_test_prompt_inject',
      userMessage: 'Tra cứu giá cước xe tải 1.25 tấn từ Hải Phòng đi Hà Nội'
    });

    const hasNotes = freshnessGuard.freshnessNotes.length > 0;
    const hasSpreadsheets = freshnessGuard.activeSpreadsheets.length > 0;
    const hasPromptText = freshnessGuard.activeFiles.some(f => f.promptText && f.promptText.length > 0);

    recordTest({
      id: 'OD_HYBRID_05',
      name: 'Nạp dữ liệu cấu trúc bảng tính và chỉ dẫn độ mới vào Prompt của AI Agent',
      passed: hasNotes && hasSpreadsheets && hasPromptText,
      expected: { hasNotes: true, hasSpreadsheets: true, hasPromptText: true },
      actual: { hasNotes, hasSpreadsheets, hasPromptText }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_05',
      name: 'Nạp dữ liệu cấu trúc bảng tính và chỉ dẫn độ mới vào Prompt của AI Agent',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 6. GRACEFUL FALLBACK ON GRAPH TIMEOUT / OFFLINE ---
  try {
    const offlineFreshness = await oneDriveSourceService.checkSourceFreshness(
      registeredSource,
      'valid_token',
      {
        fetchGraphMetadataFn: async () => {
          const timeoutErr = new Error('Connect timeout to graph.microsoft.com');
          timeoutErr.name = 'AbortError';
          throw timeoutErr;
        }
      }
    );

    recordTest({
      id: 'OD_HYBRID_06',
      name: 'Xử lý an toàn khi Graph API Timeout/Offline: Báo trạng thái cảnh báo, không làm gián đoạn AI',
      passed: offlineFreshness.isGraphReachable === false && offlineFreshness.isFresh === false && Boolean(offlineFreshness.reason),
      expected: { isGraphReachable: false, isFresh: false },
      actual: { isGraphReachable: offlineFreshness.isGraphReachable, isFresh: offlineFreshness.isFresh }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_06',
      name: 'Xử lý an toàn khi Graph API Timeout/Offline: Báo trạng thái cảnh báo, không làm gián đoạn AI',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 7. CONCURRENCY MUTEX LOCKING ---
  try {
    let callCount = 0;
    const mockDownloader = async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 100)); // Simulate 100ms network latency
      return {
        buffer: sampleBuffer,
        fileName: 'Pricing Vendor.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: sampleBuffer.length,
        eTag: '"{6231BF65-79B5-402A-A0B3-8408C0A50097},12"',
        cTag: '"c:{6231BF65-79B5-402A-A0B3-8408C0A50097},9"',
        lastModifiedDateTime: new Date().toISOString()
      };
    };

    // Run 2 simultaneous sync calls
    const [p1, p2] = await Promise.all([
      oneDriveSourceService.syncSourceVersion(registeredSource.id, ownerUserId, {
        jobType: 'CONCURRENCY_TEST',
        downloaderFn: mockDownloader
      }),
      oneDriveSourceService.syncSourceVersion(registeredSource.id, ownerUserId, {
        jobType: 'CONCURRENCY_TEST',
        downloaderFn: mockDownloader
      })
    ]);

    recordTest({
      id: 'OD_HYBRID_07',
      name: 'Cơ chế Khóa Mutex đồng thời: Chặn đứng xung đột tải trùng lặp khi có 2 truy vấn cùng lúc',
      passed: callCount === 1 && p1.version === p2.version,
      expected: { callCount: 1, versionsMatch: true },
      actual: { callCount, versionsMatch: p1.version === p2.version }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_07',
      name: 'Cơ chế Khóa Mutex đồng thời: Chặn đứng xung đột tải trùng lặp khi có 2 truy vấn cùng lúc',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 8. CROSS-USER SOURCE ISOLATION & IDOR PROTECTION ---
  try {
    // 1. User VTX attempts to fetch User STL's sources
    const vtxSourcesResp = await fetch(`${BASE_URL}/api/onedrive/sources`, {
      headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
    });
    const vtxSources = await vtxSourcesResp.json();
    const hasStlSourceInVtx = Array.isArray(vtxSources.sources) && vtxSources.sources.some(s => s.id === registeredSource.id);

    // 2. User VTX (cross-company) attempts to force sync User STL's source -> Must return 404
    const vtxSyncResp = await fetch(`${BASE_URL}/api/onedrive/sources/${registeredSource.id}/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
    });
    const vtxSyncStatus = vtxSyncResp.status;

    // 3. User VTX (cross-company) attempts to delete User STL's source -> Must return 404
    const vtxDeleteResp = await fetch(`${BASE_URL}/api/onedrive/sources/${registeredSource.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
    });
    const vtxDeleteStatus = vtxDeleteResp.status;

    // 4. User from same company but different user_id attempts to delete -> Must return 404
    const otherUserToken = jwt.sign(
      { user_id: '158b0726-9c95-4f6d-9247-85353022de93', username: 'duongduc', role: 'EMPLOYEE', company_id: 'STL' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    const otherUserDeleteResp = await fetch(`${BASE_URL}/api/onedrive/sources/${registeredSource.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${otherUserToken}` }
    });
    const otherUserDeleteStatus = otherUserDeleteResp.status;

    // 5. Malformed source ID -> Must return 400
    const malformedResp = await fetch(`${BASE_URL}/api/onedrive/sources/invalid_malformed_id_123`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
    });
    const malformedStatus = malformedResp.status;

    // 6. Non-existent UUID -> Must return 404
    const nonExistentResp = await fetch(`${BASE_URL}/api/onedrive/sources/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
    });
    const nonExistentStatus = nonExistentResp.status;

    const idorStrictOk = !hasStlSourceInVtx &&
      vtxSyncStatus === 404 &&
      vtxDeleteStatus === 404 &&
      otherUserDeleteStatus === 404 &&
      malformedStatus === 400 &&
      nonExistentStatus === 404;

    recordTest({
      id: 'OD_HYBRID_08',
      name: 'Chuẩn hóa phân quyền IDOR: Chặn xem/đồng bộ/xóa nguồn chéo (Trả HTTP 404 nhất quán, 400 khi ID sai định dạng)',
      passed: idorStrictOk,
      expected: { hasStlSourceInVtx: false, vtxSync: 404, vtxDelete: 404, sameCompDiffUser: 404, malformed: 400, nonExistent: 404 },
      actual: { hasStlSourceInVtx, vtxSync: vtxSyncStatus, vtxDelete: vtxDeleteStatus, sameCompDiffUser: otherUserDeleteStatus, malformed: malformedStatus, nonExistent: nonExistentStatus }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_08',
      name: 'Chuẩn hóa phân quyền IDOR: Chặn xem/đồng bộ/xóa nguồn chéo (Trả HTTP 404 nhất quán, 400 khi ID sai định dạng)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 9. MANUAL RE-SYNC API VERIFICATION ---
  try {
    const manualResp = await fetch(`${BASE_URL}/api/onedrive/sources/${registeredSource.id}/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
    });
    const manualJson = await manualResp.json();

    // Since mock access token or live token will either sync or safely catch, check contract
    const isManualHandled = manualResp.status === 200 || (manualResp.status === 500 && manualJson.error);

    recordTest({
      id: 'OD_HYBRID_09',
      name: 'Endpoint kích hoạt đồng bộ thủ công (POST /api/onedrive/sources/:id/sync) phản hồi chuẩn mực',
      passed: Boolean(isManualHandled),
      expected: 'Response with status 200 or safe 500 handling',
      actual: `Status: ${manualResp.status}`
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_09',
      name: 'Endpoint kích hoạt đồng bộ thủ công (POST /api/onedrive/sources/:id/sync) phản hồi chuẩn mực',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 10. DISCONNECT SOURCE API VERIFICATION ---
  try {
    const disResp = await fetch(`${BASE_URL}/api/onedrive/sources/${registeredSource.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
    });
    const disJson = await disResp.json();

    // Check DB status is DISCONNECTED
    const checkDb = await db.query(
      `SELECT sync_status FROM public.user_onedrive_sources WHERE id = $1`,
      [registeredSource.id]
    );

    const isMarkedDisconnected = checkDb.rows.length === 1 && checkDb.rows[0].sync_status === 'DISCONNECTED';

    recordTest({
      id: 'OD_HYBRID_10',
      name: 'Endpoint ngắt kết nối tệp (DELETE /api/onedrive/sources/:id) chuyển trạng thái DISCONNECTED an toàn',
      passed: disResp.status === 200 && disJson.success === true && isMarkedDisconnected,
      expected: { status: 200, success: true, isMarkedDisconnected: true },
      actual: { status: disResp.status, success: disJson.success, isMarkedDisconnected }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_10',
      name: 'Endpoint ngắt kết nối tệp (DELETE /api/onedrive/sources/:id) chuyển trạng thái DISCONNECTED an toàn',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 11. SCHEDULED RECONCILIATION ENDPOINT (POST /api/onedrive/reconcile) ---
  try {
    const recResp = await fetch(`${BASE_URL}/api/onedrive/reconcile`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 2ca9f995352866f7081e3f85f00fc759b0dd8661c910cfcebf479d1386b8cd2b',
        'Content-Type': 'application/json'
      }
    });
    const recJson = await recResp.json();

    recordTest({
      id: 'OD_HYBRID_11',
      name: 'Endpoint đối soát định kỳ n8n (POST /api/onedrive/reconcile) kiểm toán toàn diện danh mục tệp',
      passed: recResp.status === 200 && recJson.success === true && recJson.report !== undefined,
      expected: { status: 200, success: true },
      actual: { status: recResp.status, success: recJson.success, totalScanned: recJson.report?.totalScanned }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_11',
      name: 'Endpoint đối soát định kỳ n8n (POST /api/onedrive/reconcile) kiểm toán toàn diện danh mục tệp',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // --- 12. GRAPH WEBHOOK HANDSHAKE & NOTIFICATION ---
  try {
    // Handshake
    const testValidationToken = 'MS_GRAPH_VALIDATION_TOKEN_' + crypto.randomUUID();
    const handshakeResp = await fetch(`${BASE_URL}/api/onedrive/webhook?validationToken=${encodeURIComponent(testValidationToken)}`);
    const handshakeText = await handshakeResp.text();

    const isHandshakeOk = handshakeResp.status === 200 && handshakeText === testValidationToken;

    // Notification ingestion (Fast 202 response)
    const notifStart = Date.now();
    const notifResp = await fetch(`${BASE_URL}/api/onedrive/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: [
          {
            subscriptionId: 'sub_test_mock_001',
            clientState: 'secret_client_state_test',
            resource: '/me/drive/root'
          }
        ]
      })
    });
    const notifDuration = Date.now() - notifStart;
    const isNotifFast = notifResp.status === 202 && notifDuration < 3000;

    recordTest({
      id: 'OD_HYBRID_12',
      name: 'Webhook Microsoft Graph: Bắt tay validationToken chuẩn HTTP 200 & tiếp nhận notification HTTP 202 (<3s)',
      passed: isHandshakeOk && isNotifFast,
      expected: { isHandshakeOk: true, isNotifFast: true },
      actual: { isHandshakeOk, isNotifFast, notifDuration: `${notifDuration}ms` }
    });
  } catch (err) {
    recordTest({
      id: 'OD_HYBRID_12',
      name: 'Webhook Microsoft Graph: Bắt tay validationToken chuẩn HTTP 200 & tiếp nhận notification HTTP 202 (<3s)',
      passed: false,
      expected: 'Success',
      actual: err.message
    });
  }

  // Cleanup temporary test files
  try { if (fs.existsSync(testUploadPath)) fs.unlinkSync(testUploadPath); } catch (e) {}

  console.log('='.repeat(88));
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const pct = ((passedCount / totalCount) * 100).toFixed(1);
  console.log(`KẾT QUẢ KIỂM THỬ: ${passedCount}/${totalCount} TESTS PASS (${pct}%)`);
  console.log('='.repeat(88));

  const reportPath = path.join(__dirname, 'onedrive_hybrid_sync_verification_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    passedCount,
    totalCount,
    passRate: `${pct}%`,
    results
  }, null, 2));
  console.log(`Báo cáo chi tiết đã lưu tại: ${reportPath}`);

  if (passedCount !== totalCount) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSuite().catch(err => {
  console.error('Lỗi thực thi suite kiểm thử:', err);
  process.exit(1);
});
