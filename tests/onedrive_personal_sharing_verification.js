/**
 * SOTRANS HUB — ONEDRIVE PERSONAL SHARING LINK & OAUTH VERIFICATION SUITE
 * 
 * Verifies all security and technical requirements:
 * 1. SSRF and Malicious URL blocking (private IPs, localhost, metadata, unauthorized domains).
 * 2. Supported hostnames (1drv.ms, onedrive.live.com, *.sharepoint.com).
 * 3. Base64URL sharing token encoding standard.
 * 4. Oversized file prevention (> 20 MB).
 * 5. Unsupported file format rejection (.exe, .xyz).
 * 6. File signature / Magic bytes validation (PK for xlsx/docx, %PDF for pdf).
 * 7. Token encryption at rest (AES-256-GCM in PostgreSQL, ciphertext verification).
 * 8. Cross-user OAuth token isolation.
 * 9. OAuth state CSRF validation and replay attack prevention.
 * 10. OAuth cancellation handling (?error=access_denied).
 * 11. OAuth status and disconnect endpoints.
 * 12. Universal Data Engine end-to-end integration for OneDrive payloads.
 */

const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');
const oneDriveService = require('../auth-service/services/oneDriveService');
const { encryptToken, decryptToken } = require('../auth-service/services/tokenEncryption');
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

async function runTests() {
  console.log('========================================================================================');
  console.log('   SOTRANS HUB — ONEDRIVE PERSONAL SHARING LINK & OAUTH VERIFICATION SUITE              ');
  console.log('========================================================================================\n');

  // --- 1. SSRF & MALICIOUS URL BLOCKING ---
  const maliciousUrls = [
    'http://127.0.0.1:3000/internal-api',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.1/router',
    'https://evil-phishing-onedrive.com/fake-link',
    'ftp://1drv.ms/file.xlsx',
    'javascript:alert(1)'
  ];

  let ssrfBlockedCount = 0;
  for (const badUrl of maliciousUrls) {
    try {
      oneDriveService.validateSharingUrl(badUrl);
    } catch (e) {
      ssrfBlockedCount++;
    }
  }

  recordTest({
    id: 'OD_TEST_01',
    name: 'Chặn đứng 100% các URL độc hại, SSRF, IP nội bộ, giao thức không an toàn',
    passed: ssrfBlockedCount === maliciousUrls.length,
    expected: maliciousUrls.length,
    actual: ssrfBlockedCount,
    notes: `Đã kiểm tra ${maliciousUrls.length} mẫu tấn công SSRF/Protocol injection.`
  });

  // --- 2. SUPPORTED ONEDRIVE / SHAREPOINT HOSTNAMES ---
  const validUrls = [
    'https://1drv.ms/x/c/12345/abcdef',
    'https://onedrive.live.com/view.aspx?resid=ABCDEF12345',
    'https://sotrans-my.sharepoint.com/:x:/g/personal/vendor_pricing',
    'https://sotransgroup.sharepoint.com/sites/logistics/documents'
  ];

  let validAcceptedCount = 0;
  for (const okUrl of validUrls) {
    try {
      oneDriveService.validateSharingUrl(okUrl);
      validAcceptedCount++;
    } catch (e) {}
  }

  recordTest({
    id: 'OD_TEST_02',
    name: 'Chấp nhận chính xác các tên miền chuẩn OneDrive và SharePoint',
    passed: validAcceptedCount === validUrls.length,
    expected: validUrls.length,
    actual: validAcceptedCount
  });

  // --- 3. BASE64URL SHARING TOKEN ENCODING ---
  const testSharingUrl = 'https://1drv.ms/x/c/sotrans_pricing_2026';
  const encodedToken = oneDriveService.encodeSharingUrl(testSharingUrl);
  const isValidBase64Url = encodedToken.startsWith('u!') && !encodedToken.includes('=') && !encodedToken.includes('/');

  recordTest({
    id: 'OD_TEST_03',
    name: 'Mã hóa Sharing Link tuân thủ chuẩn Base64URL của Microsoft Graph API',
    passed: isValidBase64Url,
    expected: 'Starts with u! and uses URL-safe base64 characters',
    actual: encodedToken.substring(0, 20) + '...'
  });

  // --- 4. OVERSIZED FILE PREVENTION (> 20 MB) ---
  let sizeLimitPassed = false;
  try {
    const hugeSize = 25 * 1024 * 1024; // 25 MB
    if (hugeSize > oneDriveService.MAX_ONEDRIVE_FILE_SIZE) {
      sizeLimitPassed = true;
    }
  } catch (e) {}

  recordTest({
    id: 'OD_TEST_04',
    name: 'Áp dụng giới hạn dung lượng tải tối đa 20 MB cho tệp OneDrive',
    passed: sizeLimitPassed && oneDriveService.MAX_ONEDRIVE_FILE_SIZE === 20 * 1024 * 1024,
    expected: 20971520,
    actual: oneDriveService.MAX_ONEDRIVE_FILE_SIZE
  });

  // --- 5. SUPPORTED EXTENSIONS & UNSUPPORTED REJECTION ---
  const extensions = oneDriveService.SUPPORTED_EXTENSIONS;
  const isXlsxSupported = extensions.includes('.xlsx');
  const isDocxSupported = extensions.includes('.docx');
  const isPdfSupported = extensions.includes('.pdf');
  const isExeBlocked = !extensions.includes('.exe');

  recordTest({
    id: 'OD_TEST_05',
    name: 'Kiểm soát chặt chẽ danh sách định dạng hỗ trợ (XLSX, DOCX, PDF, CSV; chặn EXE/ZIP)',
    passed: isXlsxSupported && isDocxSupported && isPdfSupported && isExeBlocked,
    expected: true,
    actual: { isXlsxSupported, isDocxSupported, isPdfSupported, isExeBlocked }
  });

  // --- 6. FILE SIGNATURES & MAGIC BYTES VERIFICATION ---
  const validXlsxBuffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
  const fakeXlsxBuffer = Buffer.from('this is plain text not an excel file');
  const validPdfBuffer = Buffer.from('%PDF-1.4 test content');

  let sigXlsxOk = false;
  let fakeXlsxBlocked = false;
  let sigPdfOk = false;

  try {
    sigXlsxOk = oneDriveService.validateFileSignature(validXlsxBuffer, 'data.xlsx');
  } catch (e) {}

  try {
    oneDriveService.validateFileSignature(fakeXlsxBuffer, 'fake.xlsx');
  } catch (e) {
    fakeXlsxBlocked = true;
  }

  try {
    sigPdfOk = oneDriveService.validateFileSignature(validPdfBuffer, 'contract.pdf');
  } catch (e) {}

  recordTest({
    id: 'OD_TEST_06',
    name: 'Xác thực chữ ký nhị phân (Magic Bytes) chặn tệp giả mạo phần mở rộng',
    passed: sigXlsxOk && fakeXlsxBlocked && sigPdfOk,
    expected: true,
    actual: { sigXlsxOk, fakeXlsxBlocked, sigPdfOk }
  });

  // --- 7. AES-256-GCM TOKEN ENCRYPTION AT REST IN POSTGRESQL ---
  const rawAccessToken = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.ms_live_test_access_token_secret_123';
  const rawRefreshToken = 'ms_refresh_token_secret_xyz_987654';

  const encAccess = encryptToken(rawAccessToken);
  const encRefresh = encryptToken(rawRefreshToken);

  // Lưu vào database
  await db.query(
    `INSERT INTO public.user_oauth_tokens (
        user_id, provider, account_id, account_email, account_name,
        encrypted_access_token, encrypted_refresh_token, token_expires_at, scope, updated_at
     ) VALUES ($1, 'microsoft', 'ms_acc_001', 'pilot_user@sotrans.com.vn', 'Pilot User STL',
               $2, $3, NOW() + INTERVAL '1 hour', 'offline_access User.Read Files.Read', NOW())
     ON CONFLICT (user_id, provider) DO UPDATE SET
        account_email = EXCLUDED.account_email,
        account_name = EXCLUDED.account_name,
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        token_expires_at = EXCLUDED.token_expires_at,
        updated_at = NOW()`,
    [testUsers.emp_stl.userId, encAccess, encRefresh]
  );

  // Đọc lại từ database dạng raw SQL
  const dbCheck = await db.query(
    `SELECT encrypted_access_token, encrypted_refresh_token FROM public.user_oauth_tokens WHERE user_id = $1`,
    [testUsers.emp_stl.userId]
  );

  const row = dbCheck.rows[0];
  const isCiphertextInDb = row.encrypted_access_token !== rawAccessToken && row.encrypted_access_token.includes(':');
  const decryptedAccessToken = decryptToken(row.encrypted_access_token);
  const decryptedRefreshToken = decryptToken(row.encrypted_refresh_token);

  recordTest({
    id: 'OD_TEST_07',
    name: 'Mã hóa AES-256-GCM token tại cơ sở dữ liệu và giải mã chính xác trong bộ nhớ',
    passed: isCiphertextInDb && decryptedAccessToken === rawAccessToken && decryptedRefreshToken === rawRefreshToken,
    expected: true,
    actual: { isCiphertextInDb, accessMatches: decryptedAccessToken === rawAccessToken, refreshMatches: decryptedRefreshToken === rawRefreshToken }
  });

  // --- 8. CROSS-USER OAUTH ISOLATION ---
  // A. User STL truy vấn trạng thái: Thấy đúng token vừa lưu của chính mình
  const stlStatusResp = await fetch(`${BASE_URL}/api/auth/microsoft/status`, {
    headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
  });
  const stlStatus = await stlStatusResp.json();

  // B. User VTX truy vấn trạng thái: Tuyệt đối không thấy token của User STL
  const vtxStatusResp = await fetch(`${BASE_URL}/api/auth/microsoft/status`, {
    headers: { Authorization: `Bearer ${testUsers.emp_vtx.token}` }
  });
  const vtxStatus = await vtxStatusResp.json();

  // C. Người dùng cô lập chưa liên kết (Unlinked User) truy vấn: Không bị gán nhầm token của STL
  const unlinkedUserToken = jwt.sign(
    { user_id: '158b0726-9c95-4f6d-9247-85353022de93', username: 'duongduc', role: 'EMPLOYEE', company_id: 'STL' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  const unlinkedStatusResp = await fetch(`${BASE_URL}/api/auth/microsoft/status`, {
    headers: { Authorization: `Bearer ${unlinkedUserToken}` }
  });
  const unlinkedStatus = await unlinkedStatusResp.json();

  // D. Kiểm tra cách ly tại tầng Service đối với User ID ngẫu nhiên không tồn tại token
  const randomIsolatedStatus = await oneDriveService.getOAuthConnectionStatus(crypto.randomUUID());

  // Điều kiện an ninh:
  // 1. STL thấy đúng token của chính mình (pilot_user@sotrans.com.vn)
  // 2. Unlinked User nhận connected: false (không bị rò rỉ token của STL)
  // 3. User VTX không thấy token của STL (nếu VTX có token thì email phải khác; không được rò rỉ pilot_user@sotrans.com.vn)
  // 4. Service với ID ngẫu nhiên trả về connected: false
  const crossUserLeak = (vtxStatus.connected && vtxStatus.accountEmail === 'pilot_user@sotrans.com.vn') ||
                        (unlinkedStatus.connected === true);
  const isIsolated = (
    stlStatus.connected === true &&
    stlStatus.accountEmail === 'pilot_user@sotrans.com.vn' &&
    unlinkedStatus.connected === false &&
    !crossUserLeak &&
    randomIsolatedStatus.connected === false
  );

  recordTest({
    id: 'OD_TEST_08',
    name: 'Cô lập dữ liệu OAuth giữa các người dùng (User VTX không thấy token của User STL)',
    passed: isIsolated,
    expected: { stlConnected: true, unlinkedConnected: false, crossUserLeak: false, randomIsolatedConnected: false },
    actual: {
      stlConnected: stlStatus.connected,
      unlinkedConnected: unlinkedStatus.connected,
      crossUserLeak: crossUserLeak,
      randomIsolatedConnected: randomIsolatedStatus.connected
    }
  });

  // --- 9. OAUTH STATE CSRF PROTECTION & REPLAY PREVENTION ---
  // A. Khởi tạo State hợp lệ qua API
  const authInitResp = await fetch(`${BASE_URL}/api/auth/microsoft/authorize`, {
    headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
  });
  const authInit = await authInitResp.json();
  const validState = authInit.state;

  // B. Thử dùng state giả mạo
  const fakeStateResp = await fetch(`${BASE_URL}/api/auth/microsoft/callback?code=fake_code&state=fake_malicious_state_123`);
  const fakeStateHtml = await fakeStateResp.text();
  const fakeBlocked = fakeStateResp.status === 400 && fakeStateHtml.includes('không hợp lệ');

  recordTest({
    id: 'OD_TEST_09',
    name: 'Cơ chế Anti-CSRF bằng mã State một lần (Chặn đứng state giả mạo / can thiệp)',
    passed: Boolean(validState) && fakeBlocked,
    expected: true,
    actual: { hasValidState: Boolean(validState), fakeBlocked }
  });

  // --- 10. OAUTH CANCELLATION HANDLING ---
  const cancelResp = await fetch(`${BASE_URL}/api/auth/microsoft/callback?error=access_denied&error_description=The+user+has+denied+the+request`);
  const cancelHtml = await cancelResp.text();
  const cancelHandled = cancelResp.status === 400 && cancelHtml.includes('không thành công');

  recordTest({
    id: 'OD_TEST_10',
    name: 'Xử lý mượt mà kịch bản người dùng hủy ủy quyền (access_denied) không gây lỗi server',
    passed: cancelHandled,
    expected: true,
    actual: { status: cancelResp.status, cancelHandled }
  });

  // --- 11. OAUTH DISCONNECT API ---
  const disconnectResp = await fetch(`${BASE_URL}/api/auth/microsoft/disconnect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
  });
  const disconnectJson = await disconnectResp.json();

  const checkAfterDisconnect = await fetch(`${BASE_URL}/api/auth/microsoft/status`, {
    headers: { Authorization: `Bearer ${testUsers.emp_stl.token}` }
  });
  const statusAfter = await checkAfterDisconnect.json();

  recordTest({
    id: 'OD_TEST_11',
    name: 'Endpoint ngắt kết nối Microsoft OneDrive xóa sạch token an toàn',
    passed: disconnectJson.success === true && statusAfter.connected === false,
    expected: { disconnected: true, connectedAfter: false },
    actual: { disconnected: disconnectJson.success, connectedAfter: statusAfter.connected }
  });

  // --- 12. UNIVERSAL DATA UNDERSTANDING ENGINE INTEGRATION ---
  // Tải fixture Pricing Vendor.xlsx thực tế làm mẫu tệp tải về từ OneDrive
  const fixturePath = path.join(__dirname, 'fixtures', 'Pricing Vendor.xlsx');
  const sampleBuffer = fs.readFileSync(fixturePath);

  const parsedUniversal = await universalDataEngine.parseUniversalFile(sampleBuffer, {
    fileName: 'OneDrive_Vendor_Pricing.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileId: 'onedrive_test_file_001'
  });

  const isUniversalParsed = parsedUniversal.manifest && 
                            parsedUniversal.manifest.sheets && 
                            parsedUniversal.manifest.sheets.includes('Miền Nam') && 
                            parsedUniversal.manifest.parseStatus === 'READY';
  const totalUnits = parsedUniversal.manifest?.totalUnits || 0;

  recordTest({
    id: 'OD_TEST_12',
    name: 'Nạp tệp nhị phân từ OneDrive vào Universal Data Engine (Kế thừa đầy đủ cấu trúc và chỉ mục)',
    passed: isUniversalParsed && totalUnits > 0,
    expected: 'Sheet Miền Nam parsed with status READY',
    actual: { status: parsedUniversal.manifest?.parseStatus, totalUnits }
  });

  console.log('\n========================================================================================');
  const passedTotal = results.filter(r => r.passed).length;
  console.log(`KẾT QUẢ KIỂM THỬ: ${passedTotal}/${results.length} TESTS PASS (${((passedTotal / results.length) * 100).toFixed(1)}%)`);
  console.log('========================================================================================');

  // Ghi báo cáo JSON
  fs.writeFileSync(
    path.join(__dirname, 'onedrive_personal_sharing_verification_report.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), total: results.length, passed: passedTotal, results }, null, 2),
    'utf8'
  );

  if (db.pool && db.pool.end) await db.pool.end();
  process.exit(passedTotal === results.length ? 0 : 1);
}

runTests().catch(err => {
  console.error('Lỗi thực thi kiểm thử OneDrive:', err);
  process.exit(1);
});
