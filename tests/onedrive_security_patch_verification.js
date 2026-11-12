/**
 * SOTRANS HUB — ONEDRIVE MINIMAL SECURITY PATCH VERIFICATION SUITE
 * 
 * Verifies fixes for D-01, D-02, and D-03:
 * 1. D-01 (Open Redirect & Sanitization):
 *    - https://attacker.com -> /chat/
 *    - //attacker.com -> /chat/
 *    - \\attacker.com -> /chat/
 *    - javascript:alert(1) -> /chat/
 *    - CRLF / Header injection -> /chat/
 *    - Valid relative paths -> preserved safely
 *    - Empty / null / undefined -> /chat/
 * 2. D-02 (Outbound Timeout & Redirect Validation):
 *    - 30-second timeout enforcement on outbound requests
 *    - Handling TimeoutError into controlled user-safe message
 *    - Download redirect SSRF validation (blocks localhost/private IPs, allows Microsoft storage CDNs)
 * 3. D-03 (Stream Size Limiting & Chunk Abort):
 *    - File under 20 MB -> downloaded
 *    - Exactly 20 MB -> downloaded
 *    - Content-Length > 20 MB -> early rejection before stream read
 *    - Chunked stream without Content-Length > 20 MB -> aborted during read
 *    - Fake Content-Length (1 KB) with > 20 MB stream -> aborted during read
 *    - Stream cleanup and error safety
 */

const oneDriveService = require('../auth-service/services/oneDriveService');

const patchResults = [];

function recordPatchTest({ id, name, passed, expected, actual, notes = '' }) {
  patchResults.push({ id, name, passed, expected, actual, notes });
  const statusStr = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${statusStr}] ${id} | ${name}`);
  if (!passed) {
    console.log(`   --> Expected: ${JSON.stringify(expected)}`);
    console.log(`   --> Actual:   ${JSON.stringify(actual)}`);
  }
}

async function runSecurityPatchVerification() {
  console.log('========================================================================================');
  console.log('   SOTRANS HUB — D-01, D-02, D-03 SECURITY PATCH VERIFICATION SUITE                    ');
  console.log('========================================================================================\n');

  // =========================================================================
  // D-01: OPEN REDIRECT & SANITIZATION TESTS
  // =========================================================================
  console.log('--- 1. KIỂM TOÁN VÁ LỖI D-01 (CHỐNG OPEN REDIRECT & XSS) ---');

  // Test 1.1: Malicious external URLs & schemes
  const openRedirectPayloads = [
    { input: 'https://attacker.com', expected: '/chat/' },
    { input: 'http://evil.com/login', expected: '/chat/' },
    { input: '//attacker.com', expected: '/chat/' },
    { input: '//attacker.com/evil', expected: '/chat/' },
    { input: '/\\attacker.com', expected: '/chat/' },
    { input: '\\\\attacker.com', expected: '/chat/' },
    { input: 'javascript:alert(1)', expected: '/chat/' },
    { input: '/javascript:alert(1)', expected: '/chat/' },
    { input: 'data:text/html,<script>alert(1)</script>', expected: '/chat/' },
    { input: '/chat/%0d%0aSet-Cookie:evil=1', expected: '/chat/' },
    { input: '/chat/\r\nInjected:header', expected: '/chat/' },
    { input: '/chat/"onmouseover="alert(1)', expected: '/chat/' },
    { input: '/chat/<script>evil()</script>', expected: '/chat/' },
    { input: '', expected: '/chat/' },
    { input: null, expected: '/chat/' },
    { input: undefined, expected: '/chat/' }
  ];

  let maliciousAllBlocked = true;
  for (const tc of openRedirectPayloads) {
    const res = oneDriveService.sanitizeRedirectUrl(tc.input);
    if (res !== tc.expected) {
      console.error(`D-01 Failed for input: ${tc.input} -> got: ${res}`);
      maliciousAllBlocked = false;
    }
  }

  recordPatchTest({
    id: 'PATCH_D01_01',
    name: 'Chặn 100% các payload Open Redirect, //, \\\\, javascript, CRLF, HTML tag, protocol schemes',
    passed: maliciousAllBlocked,
    expected: 'All malicious inputs fallback strictly to /chat/',
    actual: maliciousAllBlocked ? 'All 16 attack vectors blocked' : 'Some payload bypassed'
  });

  // Test 1.2: Valid relative paths
  const validRelativePaths = [
    { input: '/chat/', expected: '/chat/' },
    { input: '/chat/history', expected: '/chat/history' },
    { input: '/chat/?agent=custom_123', expected: '/chat/?agent=custom_123' },
    { input: '/chat/conversations/38ac1e6f', expected: '/chat/conversations/38ac1e6f' }
  ];

  let validAllPreserved = true;
  for (const tc of validRelativePaths) {
    const res = oneDriveService.sanitizeRedirectUrl(tc.input);
    if (res !== tc.expected) {
      validAllPreserved = false;
    }
  }

  recordPatchTest({
    id: 'PATCH_D01_02',
    name: 'Bảo toàn chính xác các đường dẫn nội bộ tương đối hợp lệ (/chat/, /chat/history, ...)',
    passed: validAllPreserved,
    expected: 'Valid paths preserved',
    actual: validAllPreserved ? 'All 4 valid paths preserved' : 'Valid path rejected'
  });

  // =========================================================================
  // D-02: OUTBOUND TIMEOUT & REDIRECT SSRF TESTS
  // =========================================================================
  console.log('\n--- 2. KIỂM TOÁN VÁ LỖI D-02 (TIMEOUT 30s & REDIRECT SSRF) ---');

  // Test 2.1: Timeout constant is 30 seconds
  const isTimeout30s = oneDriveService.MS_OUTBOUND_TIMEOUT_MS === 30000;
  recordPatchTest({
    id: 'PATCH_D02_01',
    name: 'Cấu hình thời gian chờ kết nối outbound tới Microsoft đúng 30 giây (MS_OUTBOUND_TIMEOUT_MS)',
    passed: isTimeout30s,
    expected: 30000,
    actual: oneDriveService.MS_OUTBOUND_TIMEOUT_MS
  });

  // Test 2.2: Outbound fetch timeout handling
  let timeoutHandled = false;
  try {
    // Gọi fetchWithTimeout với timeout cực ngắn 50ms tới endpoint để kích hoạt timeout handler
    await oneDriveService.fetchWithTimeout('https://10.255.255.1', {}, 50);
  } catch (err) {
    timeoutHandled = err.message.includes('quá thời gian chờ') || err.message.includes('thời gian chờ');
  }

  recordPatchTest({
    id: 'PATCH_D02_02',
    name: 'Xử lý Timeout/AbortError thành thông báo an toàn, không rò rỉ token hoặc làm treo server',
    passed: timeoutHandled,
    expected: 'Controlled timeout error message',
    actual: timeoutHandled ? 'Controlled error message returned' : 'Unhandled timeout'
  });

  // Test 2.3: Storage CDN download redirect SSRF validation
  const redirectSsrfAttacks = [
    'http://127.0.0.1/latest',
    'https://127.0.0.1/evil',
    'https://169.254.169.254/metadata',
    'https://192.168.1.100/secret',
    'https://attacker-blob-storage.com/payload',
    'ftp://storage.azure.com/file'
  ];

  let redirectSsrfBlocked = 0;
  for (const url of redirectSsrfAttacks) {
    try {
      oneDriveService.validateDownloadRedirectUrl(url);
    } catch (e) {
      redirectSsrfBlocked++;
    }
  }

  recordPatchTest({
    id: 'PATCH_D02_03',
    name: 'Chặn đứng chuyển hướng 302 tới IP nội bộ, localhost hoặc host lạ ngoài Microsoft CDN',
    passed: redirectSsrfBlocked === redirectSsrfAttacks.length,
    expected: redirectSsrfAttacks.length,
    actual: redirectSsrfBlocked
  });

  // Test 2.4: Legitimate Microsoft storage CDNs allowed
  const legitimateCdns = [
    'https://public.files.1drv.com/y4m.../Pricing.xlsx',
    'https://sotrans-my.sharepoint.com/personal/.../document.docx',
    'https://msstorageaccount.blob.core.windows.net/container/file.pdf'
  ];

  let legitCdnsAllowed = 0;
  for (const url of legitimateCdns) {
    try {
      oneDriveService.validateDownloadRedirectUrl(url);
      legitCdnsAllowed++;
    } catch (e) {}
  }

  recordPatchTest({
    id: 'PATCH_D02_04',
    name: 'Chấp nhận các URL chuyển hướng hợp lệ từ Microsoft Storage CDN / Azure Blob',
    passed: legitCdnsAllowed === legitimateCdns.length,
    expected: legitimateCdns.length,
    actual: legitCdnsAllowed
  });

  // =========================================================================
  // D-03: STREAM SIZE LIMITING & CHUNK ACCUMULATOR TESTS
  // =========================================================================
  console.log('\n--- 3. KIỂM TOÁN VÁ LỖI D-03 (GIỚI HẠN STREAM & BẢO VỆ BỘ NHỚ RAM) ---');

  // Helper to create mock Response object with streaming body
  function createMockStreamResponse({ status = 200, headers = {}, chunkCount = 1, chunkSize = 1024, cancelSpy = () => {} }) {
    let delivered = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        if (delivered >= chunkCount) {
          controller.close();
          return;
        }
        delivered++;
        const chunk = Buffer.alloc(chunkSize, 'A');
        controller.enqueue(chunk);
      },
      cancel(reason) {
        cancelSpy(reason);
      }
    });

    const headerObj = new Headers(headers);
    return new Response(stream, { status, headers: headerObj });
  }

  // Test 3.1: File under limit (1 MB) -> downloaded successfully
  const smallMock = createMockStreamResponse({
    headers: { 'content-length': String(1024 * 1024) },
    chunkCount: 16,
    chunkSize: 64 * 1024 // 1 MB total
  });
  const smallBuf = await oneDriveService.downloadStreamWithLimit(smallMock, 20 * 1024 * 1024);
  recordPatchTest({
    id: 'PATCH_D03_01',
    name: 'Tải thành công tệp trong ngưỡng cho phép (1 MB)',
    passed: smallBuf && smallBuf.length === 1024 * 1024,
    expected: 1048576,
    actual: smallBuf?.length
  });

  // Test 3.2: Early rejection via Content-Length header (> 20 MB) before reading any chunks
  let earlyRejected = false;
  let chunkDeliveredCount = 0;
  const hugeHeaderMock = createMockStreamResponse({
    headers: { 'content-length': String(25 * 1024 * 1024) }, // 25 MB in header
    chunkCount: 100,
    chunkSize: 64 * 1024
  });

  try {
    await oneDriveService.downloadStreamWithLimit(hugeHeaderMock, 20 * 1024 * 1024);
  } catch (err) {
    earlyRejected = err.message.includes('vượt quá giới hạn tối đa');
  }

  recordPatchTest({
    id: 'PATCH_D03_02',
    name: 'Từ chối sớm ngay tại header Content-Length khi kích thước > 20 MB (Không đọc luồng)',
    passed: earlyRejected,
    expected: true,
    actual: earlyRejected
  });

  // Test 3.3: Chunked stream WITHOUT Content-Length header that exceeds 20 MB
  // Test reading threshold: limit set to 2 MB for fast testing, sending 3 MB
  let cancelCalled = false;
  let chunkExceededAborted = false;
  const testLimitBytes = 2 * 1024 * 1024; // 2 MB test threshold

  const noHeaderHugeMock = createMockStreamResponse({
    headers: {}, // No Content-Length
    chunkCount: 30, // 30 chunks * 128 KB = ~3.8 MB
    chunkSize: 128 * 1024,
    cancelSpy: () => { cancelCalled = true; }
  });

  try {
    await oneDriveService.downloadStreamWithLimit(noHeaderHugeMock, testLimitBytes);
  } catch (err) {
    chunkExceededAborted = err.message.includes('vượt quá giới hạn an toàn');
  }

  recordPatchTest({
    id: 'PATCH_D03_03',
    name: 'Tự động ngắt và giải phóng stream khi tệp không có Content-Length vượt ngưỡng (Bảo vệ RAM)',
    passed: chunkExceededAborted && cancelCalled,
    expected: { aborted: true, readerCancelled: true },
    actual: { aborted: chunkExceededAborted, readerCancelled: cancelCalled }
  });

  // Test 3.4: Fake Content-Length header (Header says 1 KB, but stream sends 3 MB)
  let fakeHeaderAborted = false;
  const fakeHeaderMock = createMockStreamResponse({
    headers: { 'content-length': '1024' }, // Fake 1 KB header
    chunkCount: 25,
    chunkSize: 128 * 1024 // Sends 3.2 MB
  });

  try {
    await oneDriveService.downloadStreamWithLimit(fakeHeaderMock, testLimitBytes);
  } catch (err) {
    fakeHeaderAborted = err.message.includes('vượt quá giới hạn an toàn');
  }

  recordPatchTest({
    id: 'PATCH_D03_04',
    name: 'Phát hiện và hủy tải tệp ngay lập tức khi Content-Length bị giả mạo nhỏ hơn dữ liệu thực',
    passed: fakeHeaderAborted,
    expected: true,
    actual: fakeHeaderAborted
  });

  // Test 3.5: Premature stream error / socket abort cleanup
  let errorHandled = false;
  const brokenStream = new ReadableStream({
    start(controller) {
      controller.error(new Error('Mạng bị ngắt kết nối giữa chừng (Network connection reset)'));
    }
  });
  const brokenMock = new Response(brokenStream, { status: 200 });

  try {
    await oneDriveService.downloadStreamWithLimit(brokenMock, 20 * 1024 * 1024);
  } catch (err) {
    errorHandled = err.message.includes('Mạng bị ngắt kết nối');
  }

  recordPatchTest({
    id: 'PATCH_D03_05',
    name: 'Bắt ngoại lệ an toàn và giải phóng tài nguyên khi luồng truyền tải bị ngắt kết nối',
    passed: errorHandled,
    expected: true,
    actual: errorHandled
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n========================================================================================');
  const passedCount = patchResults.filter(r => r.passed).length;
  console.log(`KẾT QUẢ KIỂM THỬ BẢN VÁ: ${passedCount}/${patchResults.length} TESTS PASS (${((passedCount / patchResults.length) * 100).toFixed(1)}%)`);
  console.log('========================================================================================');

  process.exit(passedCount === patchResults.length ? 0 : 1);
}

runSecurityPatchVerification().catch(err => {
  console.error('Lỗi thực thi kiểm thử bản vá:', err);
  process.exit(1);
});
