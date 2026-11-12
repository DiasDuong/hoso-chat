/**
 * SOTRANS HUB — MICROSOFT ONEDRIVE SERVICE MODULE (PATCHED v2.1)
 * 
 * Implements:
 * 1. Microsoft OAuth 2.0 Authorization-Code flow with cryptographically random state & CSRF protection.
 * 2. Automatic token refresh & AES-256-GCM token encryption at rest.
 * 3. Strict SSRF protection and hostname whitelisting for OneDrive sharing links and download redirects.
 * 4. Safe DriveItem resolution and chunk-by-chunk stream download with 20 MB size caps (D-03).
 * 5. Outbound fetch timeouts of 30 seconds for all Microsoft Graph and Auth calls (D-02).
 * 6. Airtight relative-path sanitization for OAuth redirect_after parameters (D-01).
 */

const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const db = require('../db');
const { encryptToken, decryptToken } = require('./tokenEncryption');

// Đảm bảo ưu tiên phân giải IPv4 trên môi trường Docker bridge không có định tuyến IPv6 (chống ENETUNREACH)
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
const origDnsLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = { family: 4 };
  } else if (typeof options === 'object' && options !== null) {
    options = { ...options, family: 4 };
  } else {
    options = { family: 4 };
  }
  return origDnsLookup(hostname, options, callback);
};

const MS_AUTH_ENDPOINT = 'https://login.microsoftonline.com';
const MS_GRAPH_ENDPOINT = 'https://graph.microsoft.com/v1.0';

// Timeout for all outbound Microsoft API calls (D-02)
const MS_OUTBOUND_TIMEOUT_MS = 30000; // 30 seconds

// Allowed hostnames for OneDrive / SharePoint sharing links
const ALLOWED_ONEDRIVE_HOST_PATTERNS = [
  /^1drv\.ms$/i,
  /^onedrive\.live\.com$/i,
  /^[a-zA-Z0-9-]+\.sharepoint\.com$/i,
  /^[a-zA-Z0-9-]+\.sharepoint-df\.com$/i
];

// Allowed hostnames for storage CDN download redirects
const ALLOWED_DOWNLOAD_HOST_PATTERNS = [
  /^1drv\.ms$/i,
  /^onedrive\.live\.com$/i,
  /^[a-zA-Z0-9-]+\.sharepoint\.com$/i,
  /^[a-zA-Z0-9-]+\.sharepoint-df\.com$/i,
  /^[a-zA-Z0-9-]+\.blob\.core\.windows\.net$/i,
  /^[a-zA-Z0-9-]+\.files\.1drv\.com$/i,
  /^[a-zA-Z0-9-]+\.live\.com$/i,
  /^[a-zA-Z0-9-]+\.microsoft\.com$/i,
  /^[a-zA-Z0-9.-]+\.microsoftpersonalcontent\.com$/i,
  /^[a-zA-Z0-9-]+\.msauth\.net$/i,
  /^[a-zA-Z0-9-]+\.azure\.com$/i
];

// Maximum allowed file size for OneDrive personal downloads (20 MB matches Universal Engine policy)
const MAX_ONEDRIVE_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

// Supported file extensions matching Universal Data Understanding Engine
const SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.docx', '.pdf', '.png', '.jpg', '.jpeg', '.txt'];

/**
 * Sanitizes and validates a redirect_after path to prevent Open Redirect vulnerabilities (D-01).
 * Strictly requires safe relative paths; rejects protocol schemes, CRLF, //, \\, and external URLs.
 * Defaults securely to '/chat/'.
 * 
 * @param {string} urlStr 
 * @returns {string} Safe relative path (e.g. '/chat/' or '/chat/history')
 */
function sanitizeRedirectUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '/chat/';
  const trimmed = urlStr.trim();

  // 1. Phải bắt đầu bằng đúng 1 dấu '/' và không được bắt đầu bằng '//' hoặc '/\'
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return '/chat/';
  }

  // 2. Chặn tuyệt đối CRLF, null bytes, tab, quotes, dấu ngoặc nhọn, backslashes, colons
  if (/[\r\n\0\t"'<>\\:]/.test(trimmed)) {
    return '/chat/';
  }

  // 3. Chỉ cho phép các ký tự URL tương đối an toàn: chữ cái, số, gạch ngang, gạch dưới, ?, &, =, #, %, chấm, gạch chéo
  if (!/^\/[a-zA-Z0-9_\-\/?&=#%.]*$/.test(trimmed)) {
    return '/chat/';
  }

  // 4. Giải mã decodeURIComponent để kiểm tra xem có giấu protocol (javascript:, https:) hoặc // hay không
  try {
    const decoded = decodeURIComponent(trimmed);
    if (
      decoded.startsWith('//') ||
      decoded.startsWith('/\\') ||
      /[\r\n\0\t"'<>\\]/.test(decoded) ||
      /^[a-zA-Z0-9+.-]+:/.test(decoded.slice(1)) // Chặn /javascript: hoặc /https:
    ) {
      return '/chat/';
    }
  } catch (decodeErr) {
    return '/chat/';
  }

  return trimmed;
}

/**
 * Wrapper for native fetch with strict 30-second timeout (D-02).
 * Converts AbortError / TimeoutError into clean, controlled messages without leaking secrets.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = MS_OUTBOUND_TIMEOUT_MS) {
  try {
    const headers = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      ...(options.headers || {})
    };
    return await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Yêu cầu kết nối tới Microsoft bị quá thời gian chờ (${timeoutMs / 1000} giây). Vui lòng thử lại sau.`);
    }
    throw err;
  }
}

/**
 * Helper to get configured Microsoft OAuth environment variables
 */
function getMicrosoftOAuthConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID || '';
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET || '';
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common'; // 'common' or 'consumers' for personal MS accounts
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'https://hr-n8n.taila8e1d8.ts.net/api/auth/microsoft/callback';
  
  return { clientId, clientSecret, tenantId, redirectUri };
}

/**
 * Validates whether a URL is a legitimate OneDrive / SharePoint sharing link.
 * Strictly prevents SSRF, localhost, private IP ranges, and unauthorized schemes.
 * @param {string} urlStr 
 * @returns {string} Sanitized URL string
 */
function validateSharingUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('Liên kết OneDrive không hợp lệ hoặc bị rỗng.');
  }

  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch (err) {
    throw new Error('Định dạng URL không hợp lệ: ' + err.message);
  }

  // 1. Chỉ chấp nhận giao thức HTTPS an toàn
  if (parsed.protocol !== 'https:') {
    throw new Error('Giao thức URL không an toàn. Chỉ chấp nhận liên kết https://');
  }

  // 2. Chặn tuyệt đối IP riêng, localhost, metadata endpoint (SSRF prevention)
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '169.254.169.254' ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new Error('Liên kết bị từ chối: Phát hiện địa chỉ mạng nội bộ hoặc không an toàn (SSRF blocked).');
  }

  // 3. Khớp Whitelist Domain Microsoft OneDrive / SharePoint
  const isAllowedHost = ALLOWED_ONEDRIVE_HOST_PATTERNS.some(regex => regex.test(host));
  if (!isAllowedHost) {
    throw new Error(
      `Tên miền "${host}" không thuộc hệ thống Microsoft OneDrive / SharePoint được hỗ trợ ` +
      `(Chỉ chấp nhận 1drv.ms, onedrive.live.com hoặc *.sharepoint.com).`
    );
  }

  return parsed.toString();
}

/**
 * Validates storage CDN redirect URL when Microsoft Graph returns a 302 redirect for content download.
 * Ensures the target URL cannot redirect to localhost or internal network endpoints (D-02).
 */
function validateDownloadRedirectUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('Địa chỉ chuyển hướng tải tệp không hợp lệ.');
  }

  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch (err) {
    throw new Error('Định dạng URL chuyển hướng tải tệp không hợp lệ: ' + err.message);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Địa chỉ chuyển hướng tải tệp không an toàn (bắt buộc HTTPS).');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '169.254.169.254' ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new Error('Địa chỉ chuyển hướng tải tệp trỏ về địa chỉ mạng nội bộ hoặc máy chủ cục bộ (SSRF blocked).');
  }

  const isAllowedHost = ALLOWED_DOWNLOAD_HOST_PATTERNS.some(regex => regex.test(host));
  if (!isAllowedHost) {
    throw new Error(`Tên miền chuyển hướng "${host}" không nằm trong danh sách máy chủ lưu trữ Microsoft được tin cậy.`);
  }

  return parsed.toString();
}

/**
 * Reads a response stream chunk-by-chunk and aborts immediately if size exceeds maxSizeBytes (D-03).
 * Does NOT buffer large bodies in RAM before checking size.
 * 
 * @param {Response} response 
 * @param {number} maxSizeBytes 
 * @returns {Promise<Buffer>}
 */
async function downloadStreamWithLimit(response, maxSizeBytes = MAX_ONEDRIVE_FILE_SIZE) {
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Tải tệp từ Microsoft thất bại với mã HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  // 1. Kiểm tra sớm Content-Length header nếu có giá trị
  const rawContentLength = response.headers.get('content-length');
  if (rawContentLength) {
    const cl = parseInt(rawContentLength, 10);
    if (!isNaN(cl) && cl > maxSizeBytes) {
      throw new Error(
        `Tệp trên OneDrive có dung lượng ${(cl / (1024 * 1024)).toFixed(2)} MB, ` +
        `vượt quá giới hạn tối đa cho phép của SOTRANS Hub (${maxSizeBytes / (1024 * 1024)} MB). ` +
        `Quá trình tải tệp đã bị hủy để bảo vệ máy chủ.`
      );
    }
  }

  if (!response.body) {
    throw new Error('Dữ liệu tải tệp từ Microsoft không có nội dung (Empty response body).');
  }

  // 2. Đọc luồng theo từng chunk; ngắt luồng ngay lập tức khi tích lũy vượt ngưỡng (kể cả khi Content-Length bị giả mạo/vắng mặt)
  const reader = response.body.getReader();
  const chunks = [];
  let totalReceivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        totalReceivedBytes += value.length;
        if (totalReceivedBytes > maxSizeBytes) {
          try { await reader.cancel('File size limit exceeded'); } catch (cancelErr) {}
          throw new Error(
            `Tệp tải về từ OneDrive vượt quá giới hạn an toàn ${maxSizeBytes / (1024 * 1024)} MB ` +
            `(đã nhận ${(totalReceivedBytes / (1024 * 1024)).toFixed(2)} MB). Quá trình tải đã bị hủy để bảo vệ bộ nhớ máy chủ.`
          );
        }
        chunks.push(value);
      }
    }
  } catch (streamErr) {
    try { await reader.cancel().catch(() => {}); } catch (e) {}
    throw streamErr;
  }

  return Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)));
}

/**
 * Encodes a sharing URL into a Microsoft Graph sharing token using Base64URL.
 * Format: "u!" + base64url(url)
 * @param {string} sharingUrl 
 * @returns {string}
 */
function encodeSharingUrl(sharingUrl) {
  const sanitized = validateSharingUrl(sharingUrl);
  const base64 = Buffer.from(sanitized, 'utf8').toString('base64');
  const base64Url = base64.replace(/=/g, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `u!${base64Url}`;
}

/**
 * Validates file magic bytes / signatures to prevent malicious payload masquerading.
 * @param {Buffer} buffer 
 * @param {string} fileName 
 */
function validateFileSignature(buffer, fileName) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Tệp tải về từ OneDrive bị rỗng (0 bytes).');
  }

  const ext = path.extname(fileName).toLowerCase();

  // Excel (.xlsx) / Word (.docx): ZIP archive signature "PK" (0x50 0x4B 0x03 0x04)
  if (['.xlsx', '.docx'].includes(ext)) {
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
      throw new Error(`Tệp "${fileName}" có phần mở rộng ${ext} nhưng cấu trúc nhị phân không phải định dạng Office OpenXML hợp lệ.`);
    }
  }

  // PDF: Signature "%PDF" (0x25 0x50 0x44 0x46)
  if (ext === '.pdf') {
    if (buffer.length < 4 || buffer.toString('utf8', 0, 4) !== '%PDF') {
      throw new Error(`Tệp "${fileName}" không phải là định dạng PDF hợp lệ.`);
    }
  }

  // PNG: Signature 0x89 0x50 0x4E 0x47
  if (ext === '.png') {
    if (buffer.length < 4 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
      throw new Error(`Tệp "${fileName}" không phải là hình ảnh PNG hợp lệ.`);
    }
  }

  // JPEG: Signature 0xFF 0xD8 0xFF
  if (['.jpg', '.jpeg'].includes(ext)) {
    if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
      throw new Error(`Tệp "${fileName}" không phải là hình ảnh JPEG hợp lệ.`);
    }
  }

  return true;
}

/**
 * Generates Microsoft OAuth 2.0 Authorization URL with cryptographically secure state.
 * @param {string} userId UUID of the authenticated SOTRANS Hub user
 * @param {string} redirectAfter Destination relative path after successful auth (sanitized)
 * @returns {Promise<{ authUrl: string, state: string }>}
 */
async function generateAuthorizationUrl(userId, redirectAfter = '/chat/') {
  const config = getMicrosoftOAuthConfig();
  if (!config.clientId) {
    throw new Error('Chưa cấu hình biến môi trường MICROSOFT_CLIENT_ID trên máy chủ.');
  }

  // Sanitize redirectAfter strictly (D-01)
  const safeRedirectAfter = sanitizeRedirectUrl(redirectAfter);

  // Generate cryptographically random 32-byte state
  const state = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

  // Persist state in PostgreSQL for CSRF protection
  await db.query(
    `INSERT INTO public.oauth_state_nonces (state_token, user_id, redirect_after, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [state, userId, safeRedirectAfter, expiresAt]
  );

  // Clean up any expired nonces
  try {
    await db.query(`DELETE FROM public.oauth_state_nonces WHERE expires_at < NOW()`);
  } catch (cleanErr) {}

  // Scopes: offline_access (refresh token), User.Read (profile info), Files.Read (least-privilege read personal & shared files)
  const scopes = ['offline_access', 'User.Read', 'Files.Read'].join(' ');

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    response_mode: 'query',
    scope: scopes,
    state: state,
    prompt: 'select_account'
  });

  const authUrl = `${MS_AUTH_ENDPOINT}/${config.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  return { authUrl, state };
}

/**
 * Handles Microsoft OAuth callback, exchanges authorization code for tokens,
 * validates state, encrypts tokens, and updates user_oauth_tokens table.
 * @param {string} code Authorization code from Microsoft
 * @param {string} state State token returned from Microsoft
 * @returns {Promise<{ success: boolean, userId: string, accountEmail: string, redirectAfter: string }>}
 */
async function handleOAuthCallback(code, state) {
  if (!code || !state) {
    throw new Error('Thiếu mã ủy quyền (code) hoặc mã trạng thái (state) từ Microsoft.');
  }

  // 1. Xác thực State trong Database (Chặn CSRF tuyệt đối)
  const stateRes = await db.query(
    `SELECT user_id, redirect_after, expires_at FROM public.oauth_state_nonces WHERE state_token = $1`,
    [state]
  );

  if (stateRes.rows.length === 0) {
    throw new Error('Mã trạng thái OAuth (state) không hợp lệ hoặc đã bị sử dụng.');
  }

  const stateRow = stateRes.rows[0];
  if (new Date(stateRow.expires_at) < new Date()) {
    await db.query(`DELETE FROM public.oauth_state_nonces WHERE state_token = $1`, [state]);
    throw new Error('Phiên xác thực Microsoft đã hết hạn (quá 10 phút). Vui lòng thử lại.');
  }

  const userId = stateRow.user_id;
  const redirectAfter = sanitizeRedirectUrl(stateRow.redirect_after || '/chat/');

  // Xóa state ngay lập tức sau khi dùng (chặn replay attack)
  await db.query(`DELETE FROM public.oauth_state_nonces WHERE state_token = $1`, [state]);

  // 2. Trao đổi Authorization Code lấy Tokens từ Microsoft Endpoint với Timeout 30s (D-02)
  const config = getMicrosoftOAuthConfig();
  const tokenParams = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: config.redirectUri
  });

  const tokenResp = await fetchWithTimeout(`${MS_AUTH_ENDPOINT}/${config.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString()
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text().catch(() => '');
    throw new Error(`Trao đổi mã xác thực Microsoft thất bại (${tokenResp.status}): ${errText.slice(0, 300)}`);
  }

  const tokenData = await tokenResp.json();
  const { access_token, refresh_token, expires_in, scope } = tokenData;

  if (!access_token) {
    throw new Error('Phản hồi từ Microsoft không chứa access_token.');
  }

  const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);

  // 3. Lấy thông tin tài khoản người dùng từ Microsoft Graph với Timeout 30s (D-02)
  let accountId = null;
  let accountEmail = null;
  let accountName = null;

  try {
    const profileResp = await fetchWithTimeout(`${MS_GRAPH_ENDPOINT}/me`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (profileResp.ok) {
      const profile = await profileResp.json();
      accountId = profile.id || null;
      accountEmail = profile.mail || profile.userPrincipalName || null;
      accountName = profile.displayName || null;
    }
  } catch (profErr) {
    console.warn('[OneDriveService] Không thể đọc profile người dùng Microsoft:', profErr.message);
  }

  // 4. Mã hóa Tokens bằng AES-256-GCM trước khi lưu trữ
  const encAccessToken = encryptToken(access_token);
  const encRefreshToken = refresh_token ? encryptToken(refresh_token) : null;

  // 5. Lưu vào bảng user_oauth_tokens (Upsert)
  await db.query(
    `INSERT INTO public.user_oauth_tokens (
        user_id, provider, account_id, account_email, account_name,
        encrypted_access_token, encrypted_refresh_token, token_expires_at, scope, updated_at
     ) VALUES ($1, 'microsoft', $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (user_id, provider) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        account_email = EXCLUDED.account_email,
        account_name = EXCLUDED.account_name,
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, public.user_oauth_tokens.encrypted_refresh_token),
        token_expires_at = EXCLUDED.token_expires_at,
        scope = EXCLUDED.scope,
        updated_at = NOW()`,
    [userId, accountId, accountEmail, accountName, encAccessToken, encRefreshToken, expiresAt, scope]
  );

  return {
    success: true,
    userId,
    accountEmail,
    accountName,
    redirectAfter
  };
}

/**
 * Retrieves and automatically refreshes Microsoft access token for a given user.
 * Decrypts tokens in memory only. Includes 30-second timeout on token refresh (D-02).
 * @param {string} userId 
 * @returns {Promise<string>} Valid decrypted Microsoft access_token
 */
async function getUserValidAccessToken(userId) {
  const res = await db.query(
    `SELECT encrypted_access_token, encrypted_refresh_token, token_expires_at, account_email
     FROM public.user_oauth_tokens
     WHERE user_id = $1 AND provider = 'microsoft'`,
    [userId]
  );

  if (res.rows.length === 0) {
    throw new Error('Tài khoản của bạn chưa kết nối với Microsoft OneDrive. Vui lòng liên kết tài khoản trước.');
  }

  const row = res.rows[0];
  const now = new Date();
  const expiresAt = new Date(row.token_expires_at);

  // If token is still valid (with 5-minute safety buffer), decrypt and return
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return decryptToken(row.encrypted_access_token);
  }

  // Token is expired or expiring soon -> Refresh using refresh_token
  if (!row.encrypted_refresh_token) {
    throw new Error('Phiên làm việc Microsoft OneDrive đã hết hạn và không có refresh token. Vui lòng kết nối lại.');
  }

  const plainRefreshToken = decryptToken(row.encrypted_refresh_token);
  const config = getMicrosoftOAuthConfig();

  const refreshParams = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: plainRefreshToken
  });

  const refreshResp = await fetchWithTimeout(`${MS_AUTH_ENDPOINT}/${config.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshParams.toString()
  });

  if (!refreshResp.ok) {
    const errText = await refreshResp.text().catch(() => '');
    throw new Error(`Làm mới token Microsoft thất bại (${refreshResp.status}): ${errText.slice(0, 200)}`);
  }

  const refreshedData = await refreshResp.json();
  const newAccessToken = refreshedData.access_token;
  const newRefreshToken = refreshedData.refresh_token || plainRefreshToken;
  const newExpiresAt = new Date(Date.now() + (refreshedData.expires_in || 3600) * 1000);

  // Encrypt new tokens and update DB
  const encNewAccessToken = encryptToken(newAccessToken);
  const encNewRefreshToken = encryptToken(newRefreshToken);

  await db.query(
    `UPDATE public.user_oauth_tokens
     SET encrypted_access_token = $1,
         encrypted_refresh_token = $2,
         token_expires_at = $3,
         updated_at = NOW()
     WHERE user_id = $4 AND provider = 'microsoft'`,
    [encNewAccessToken, encNewRefreshToken, newExpiresAt, userId]
  );

  return newAccessToken;
}

/**
 * Checks if a user has an active, valid Microsoft OneDrive connection.
 * @param {string} userId 
 * @returns {Promise<{ connected: boolean, accountEmail?: string, accountName?: string, expiresAt?: string }>}
 */
async function getOAuthConnectionStatus(userId) {
  const res = await db.query(
    `SELECT account_email, account_name, token_expires_at, updated_at
     FROM public.user_oauth_tokens
     WHERE user_id = $1 AND provider = 'microsoft'`,
    [userId]
  );

  if (res.rows.length === 0) {
    return { connected: false };
  }

  const row = res.rows[0];
  return {
    connected: true,
    accountEmail: row.account_email,
    accountName: row.account_name,
    expiresAt: row.token_expires_at,
    updatedAt: row.updated_at
  };
}

/**
 * Disconnects / removes Microsoft OneDrive credentials for a user.
 * @param {string} userId 
 */
async function disconnectOAuth(userId) {
  await db.query(
    `DELETE FROM public.user_oauth_tokens WHERE user_id = $1 AND provider = 'microsoft'`,
    [userId]
  );
  return { success: true };
}

/**
 * Resolves a OneDrive sharing link and downloads its binary content using Microsoft Graph API.
 * 
 * Enforces:
 * 1. 30-second timeout on all Graph network operations (D-02).
 * 2. Strict SSRF validation on the initial URL and storage CDN redirects (D-02).
 * 3. Chunk-by-chunk stream accumulator that aborts immediately if size exceeds 20 MB (D-03).
 * 4. File extension and binary magic bytes verification.
 * 
 * @param {string} sharingUrl 
 * @param {string} userId 
 * @returns {Promise<{ buffer: Buffer, fileName: string, mimeType: string, size: number, driveItemId: string, webUrl: string }>}
 */
async function resolveAndDownloadSharedItem(sharingUrl, userId) {
  // 1. SSRF and Hostname Validation for the initial sharing link
  validateSharingUrl(sharingUrl);
  const encodedShareToken = encodeSharingUrl(sharingUrl);

  // 2. Lấy Access Token hợp lệ của User
  const accessToken = await getUserValidAccessToken(userId);

  // 3. Phân giải Metadata DriveItem từ Microsoft Graph (với Timeout 30s)
  const metaUrl = `${MS_GRAPH_ENDPOINT}/shares/${encodedShareToken}/driveItem`;
  const metaResp = await fetchWithTimeout(metaUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });

  if (!metaResp.ok) {
    const errBody = await metaResp.text().catch(() => '');
    if (metaResp.status === 404) {
      throw new Error('Không tìm thấy tệp từ liên kết OneDrive này (tệp có thể đã bị xóa hoặc link không tồn tại).');
    }
    if (metaResp.status === 403 || metaResp.status === 401) {
      throw new Error('Bạn không có quyền truy cập tệp OneDrive này hoặc liên kết chưa được chia sẻ cho tài khoản Microsoft của bạn.');
    }
    throw new Error(`Lỗi Microsoft Graph khi đọc thông tin tệp (${metaResp.status}): ${errBody.slice(0, 200)}`);
  }

  const driveItem = await metaResp.json();
  const rawFileName = driveItem.name || 'onedrive_file';
  const fileSize = driveItem.size || 0;
  const mimeType = driveItem.file?.mimeType || 'application/octet-stream';
  const ext = path.extname(rawFileName).toLowerCase();

  // 4. Kiểm tra sớm metadata kích thước tệp nếu có (Tối đa 20MB)
  if (fileSize > MAX_ONEDRIVE_FILE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Tệp trên OneDrive có dung lượng quá lớn (${sizeMB} MB). ` +
      `SOTRANS Hub chỉ hỗ trợ phân tích tệp tối đa 20 MB để đảm bảo hiệu năng máy chủ.`
    );
  }

  // 5. Kiểm tra định dạng phần mở rộng hỗ trợ
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Định dạng tệp "${ext}" từ OneDrive không được hỗ trợ phân tích. ` +
      `Hệ thống hiện chỉ hỗ trợ: ${SUPPORTED_EXTENSIONS.join(', ')}.`
    );
  }

  // 6. Xử lý tải nội dung với Chống SSRF trên Redirect (D-02) và Giới hạn Stream 20MB (D-03)
  let downloadTargetUrl = driveItem['@microsoft.graph.downloadUrl'] || null;
  let downloadHeaders = {};

  if (downloadTargetUrl) {
    // Nếu Graph API đã cấp sẵn URL tải xuống trực tiếp, kiểm tra an ninh SSRF tên miền
    validateDownloadRedirectUrl(downloadTargetUrl);
  } else {
    const contentUrl = `${MS_GRAPH_ENDPOINT}/shares/${encodedShareToken}/driveItem/content`;
    downloadTargetUrl = contentUrl;
    downloadHeaders = { Authorization: `Bearer ${accessToken}` };

    const initialContentResp = await fetchWithTimeout(contentUrl, {
      method: 'GET',
      headers: downloadHeaders,
      redirect: 'manual'
    });

    // Microsoft Graph trả về 302 Found chuyển hướng tới URL CDN pre-authenticated
    if (initialContentResp.status >= 300 && initialContentResp.status < 400) {
      const redirectLoc = initialContentResp.headers.get('location');
      if (!redirectLoc) {
        throw new Error('Microsoft Graph trả về mã chuyển hướng 302 nhưng thiếu tiêu đề Location.');
      }
      // Xác thực an ninh: URL chuyển hướng phải là HTTPS và thuộc hạ tầng lưu trữ Microsoft hợp lệ
      validateDownloadRedirectUrl(redirectLoc);
      downloadTargetUrl = redirectLoc;
      downloadHeaders = {};
    } else if (!initialContentResp.ok) {
      const errBody = await initialContentResp.text().catch(() => '');
      throw new Error(`Không thể khởi tạo tải tệp từ OneDrive (${initialContentResp.status}): ${errBody.slice(0, 200)}`);
    }
  }

  // Tải nội dung tệp nhị phân thực tế từ downloadTargetUrl
  const finalContentResp = await fetchWithTimeout(downloadTargetUrl, { method: 'GET', headers: downloadHeaders });

  // 7. Đọc luồng dữ liệu theo từng chunk và kiểm tra giới hạn 20MB trong quá trình đọc (D-03)
  const buffer = await downloadStreamWithLimit(finalContentResp, MAX_ONEDRIVE_FILE_SIZE);

  // 8. Kiểm tra chữ ký nhị phân (Magic Bytes)
  validateFileSignature(buffer, rawFileName);

  return {
    buffer,
    fileName: rawFileName,
    mimeType,
    size: buffer.length,
    driveItemId: driveItem.id || 'unknown_item',
    webUrl: driveItem.webUrl || sharingUrl,
    eTag: driveItem.eTag || null,
    cTag: driveItem.cTag || null,
    lastModifiedDateTime: driveItem.lastModifiedDateTime || null,
    driveId: driveItem.parentReference?.driveId || null
  };
}

/**
 * Lists OneDrive files and folders for the connected user.
 * Supports root, specific folder navigation, search, and pagination.
 */
async function listDriveItems(userId, options = {}) {
  const { folderId = 'root', search = '', limit = 20, skipToken = null } = options;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  const accessToken = await getUserValidAccessToken(userId);

  let url = '';
  let parentFolder = { id: 'root', name: 'OneDrive', parentId: null };

  if (search && search.trim()) {
    const safeTerm = search.trim().replace(/['"`\\]/g, ' ').replace(/\s+/g, ' ');
    const q = encodeURIComponent(safeTerm);
    url = `${MS_GRAPH_ENDPOINT}/me/drive/root/search(q='${q}')?$top=${safeLimit}&$select=id,name,size,file,folder,lastModifiedDateTime,parentReference,webUrl,eTag,cTag`;
  } else if (folderId && folderId !== 'root') {
    if (!/^[a-zA-Z0-9!._-]+$/.test(folderId)) {
      throw new Error('ID thư mục OneDrive không hợp lệ.');
    }

    url = `${MS_GRAPH_ENDPOINT}/me/drive/items/${folderId}/children?$top=${safeLimit}&$select=id,name,size,file,folder,lastModifiedDateTime,parentReference,webUrl,eTag,cTag`;
    if (skipToken) {
      url += `&$skiptoken=${encodeURIComponent(skipToken)}`;
    }

    try {
      const parentResp = await fetchWithTimeout(`${MS_GRAPH_ENDPOINT}/me/drive/items/${folderId}?$select=id,name,parentReference`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
      });
      if (parentResp.ok) {
        const pData = await parentResp.json();
        parentFolder = {
          id: pData.id,
          name: pData.name,
          parentId: pData.parentReference?.id || 'root'
        };
      }
    } catch (pErr) {
      console.warn('[OneDrive] Không thể lấy metadata thư mục cha:', pErr.message);
    }
  } else {
    url = `${MS_GRAPH_ENDPOINT}/me/drive/root/children?$top=${safeLimit}&$select=id,name,size,file,folder,lastModifiedDateTime,parentReference,webUrl,eTag,cTag`;
    if (skipToken) {
      url += `&$skiptoken=${encodeURIComponent(skipToken)}`;
    }
  }

  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    if (resp.status === 404) {
      throw new Error('Không tìm thấy thư mục trên OneDrive (có thể đã bị xóa hoặc di chuyển).');
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Phiên kết nối Microsoft OneDrive đã hết hạn hoặc không có quyền truy cập.');
    }
    throw new Error(`Lỗi Microsoft Graph (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  let rawItems = data.value || [];

  // Nếu Graph search trả về rỗng (do độ trễ index của OneDrive Personal), fallback tìm trên children
  if (search && search.trim() && rawItems.length === 0) {
    try {
      const fallbackUrl = `${MS_GRAPH_ENDPOINT}/me/drive/root/children?$top=100&$select=id,name,size,file,folder,lastModifiedDateTime,parentReference,webUrl,eTag,cTag`;
      const fallbackResp = await fetchWithTimeout(fallbackUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
      });
      if (fallbackResp.ok) {
        const fallbackData = await fallbackResp.json();
        const term = search.trim().toLowerCase();
        rawItems = (fallbackData.value || []).filter(it => (it.name || '').toLowerCase().includes(term));
      }
    } catch (fbErr) {
      console.warn('[OneDrive] Fallback search error:', fbErr.message);
    }
  }

  let nextSkipToken = null;
  if (data['@odata.nextLink']) {
    try {
      const nextUrl = new URL(data['@odata.nextLink']);
      nextSkipToken = nextUrl.searchParams.get('$skiptoken') || null;
    } catch (e) {}
  }

  const items = rawItems.map(item => {
    const isFolder = Boolean(item.folder);
    const fileName = item.name || '';
    const ext = path.extname(fileName).toLowerCase();
    const size = item.size || 0;

    let isSupported = false;
    let unsupportedReason = null;

    if (isFolder) {
      isSupported = true;
    } else {
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        unsupportedReason = `Định dạng ${ext || 'không rõ'} chưa được hỗ trợ. (Chỉ hỗ trợ: .xlsx, .xls, .csv, .docx, .pdf)`;
      } else if (size > MAX_ONEDRIVE_FILE_SIZE) {
        unsupportedReason = `Dung lượng tệp (${(size / (1024 * 1024)).toFixed(1)} MB) vượt quá giới hạn 20 MB.`;
      } else {
        isSupported = true;
      }
    }

    return {
      id: item.id,
      name: fileName,
      isFolder,
      childCount: item.folder?.childCount || 0,
      size,
      mimeType: item.file?.mimeType || (isFolder ? 'folder' : 'application/octet-stream'),
      extension: ext,
      isSupported,
      unsupportedReason,
      lastModifiedDateTime: item.lastModifiedDateTime,
      driveId: item.parentReference?.driveId || null,
      webUrl: item.webUrl || null,
      eTag: item.eTag || null,
      cTag: item.cTag || null
    };
  });

  return {
    items,
    parentFolder,
    nextSkipToken,
    total: items.length
  };
}

/**
 * Downloads a OneDrive driveItem directly using item ID and user's OAuth access token.
 * Validates extension, 20MB limit, SSRF on download redirect, and magic bytes.
 */
async function downloadDriveItem(driveId, itemId, userId) {
  if (!itemId || typeof itemId !== 'string') {
    throw new Error('Thiếu tham số itemId hợp lệ để tải tệp OneDrive.');
  }

  if (!/^[a-zA-Z0-9!._-]+$/.test(itemId)) {
    throw new Error('ID tệp OneDrive không hợp lệ.');
  }

  const accessToken = await getUserValidAccessToken(userId);

  // 1. Phân giải Metadata DriveItem từ Microsoft Graph
  const metaUrl = driveId
    ? `${MS_GRAPH_ENDPOINT}/drives/${driveId}/items/${itemId}?select=id,name,size,file,folder,lastModifiedDateTime,parentReference,eTag,cTag,webUrl`
    : `${MS_GRAPH_ENDPOINT}/me/drive/items/${itemId}?select=id,name,size,file,folder,lastModifiedDateTime,parentReference,eTag,cTag,webUrl`;

  const metaResp = await fetchWithTimeout(metaUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });

  if (!metaResp.ok) {
    const errBody = await metaResp.text().catch(() => '');
    if (metaResp.status === 404) {
      throw new Error('Không tìm thấy tệp trên OneDrive (tệp có thể đã bị xóa hoặc ID không tồn tại).');
    }
    if (metaResp.status === 403 || metaResp.status === 401) {
      throw new Error('Bạn không có quyền truy cập tệp OneDrive này hoặc phiên làm việc đã hết hạn.');
    }
    throw new Error(`Lỗi Microsoft Graph khi đọc thông tin tệp (${metaResp.status}): ${errBody.slice(0, 200)}`);
  }

  const driveItem = await metaResp.json();
  if (driveItem.folder) {
    throw new Error('Không thể tải thư mục làm tệp dữ liệu bảng tính.');
  }

  const rawFileName = driveItem.name || 'onedrive_file';
  const fileSize = driveItem.size || 0;
  const mimeType = driveItem.file?.mimeType || 'application/octet-stream';
  const ext = path.extname(rawFileName).toLowerCase();

  // 2. Kiểm tra sớm metadata kích thước tệp nếu có (Tối đa 20MB)
  if (fileSize > MAX_ONEDRIVE_FILE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Tệp trên OneDrive có dung lượng quá lớn (${sizeMB} MB). ` +
      `SOTRANS Hub chỉ hỗ trợ phân tích tệp tối đa 20 MB để đảm bảo hiệu năng máy chủ.`
    );
  }

  // 3. Kiểm tra định dạng phần mở rộng hỗ trợ
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Định dạng tệp "${ext}" từ OneDrive không được hỗ trợ phân tích. ` +
      `Hệ thống hiện chỉ hỗ trợ: ${SUPPORTED_EXTENSIONS.join(', ')}.`
    );
  }

  // 4. Xử lý tải nội dung với Chống SSRF trên Redirect (D-02) và Giới hạn Stream 20MB (D-03)
  let downloadTargetUrl = driveItem['@microsoft.graph.downloadUrl'] || null;
  let downloadHeaders = {};

  if (downloadTargetUrl) {
    validateDownloadRedirectUrl(downloadTargetUrl);
  } else {
    const contentUrl = driveId
      ? `${MS_GRAPH_ENDPOINT}/drives/${driveId}/items/${itemId}/content`
      : `${MS_GRAPH_ENDPOINT}/me/drive/items/${itemId}/content`;

    downloadTargetUrl = contentUrl;
    downloadHeaders = { Authorization: `Bearer ${accessToken}` };

    const initialContentResp = await fetchWithTimeout(contentUrl, {
      method: 'GET',
      headers: downloadHeaders,
      redirect: 'manual'
    });

    if (initialContentResp.status >= 300 && initialContentResp.status < 400) {
      const redirectLoc = initialContentResp.headers.get('location');
      if (!redirectLoc) {
        throw new Error('Microsoft Graph trả về mã chuyển hướng 302 nhưng thiếu tiêu đề Location.');
      }
      validateDownloadRedirectUrl(redirectLoc);
      downloadTargetUrl = redirectLoc;
      downloadHeaders = {};
    } else if (!initialContentResp.ok) {
      const errBody = await initialContentResp.text().catch(() => '');
      throw new Error(`Không thể khởi tạo tải tệp từ OneDrive (${initialContentResp.status}): ${errBody.slice(0, 200)}`);
    }
  }

  // 5. Tải nội dung tệp nhị phân thực tế từ downloadTargetUrl
  const finalContentResp = await fetchWithTimeout(downloadTargetUrl, { method: 'GET', headers: downloadHeaders });

  // 6. Đọc luồng dữ liệu theo từng chunk và kiểm tra giới hạn 20MB trong quá trình đọc (D-03)
  const fileBuffer = await downloadStreamWithLimit(finalContentResp, MAX_ONEDRIVE_FILE_SIZE);

  // 7. Xác thực chữ ký nhị phân Magic Bytes
  validateFileSignature(fileBuffer, rawFileName);

  return {
    buffer: fileBuffer,
    fileName: rawFileName,
    mimeType: mimeType,
    size: fileBuffer.length,
    driveItemId: driveItem.id || itemId,
    driveId: driveItem.parentReference?.driveId || driveId || null,
    eTag: driveItem.eTag || null,
    cTag: driveItem.cTag || null,
    lastModifiedDateTime: driveItem.lastModifiedDateTime || null,
    webUrl: driveItem.webUrl || null
  };
}


/**
 * Checks whether a specific OneDrive item exists, has been deleted, or was throttled upstream.
 * Used by background sync worker to verify individual monitored files without downloading them.
 * @param {object} params
 * @param {string} params.accessToken Valid Microsoft OAuth access token
 * @param {string} [params.driveId] Target drive ID (optional)
 * @param {string} params.itemId Microsoft Graph item ID
 * @returns {Promise<{ exists: boolean, isDeleted: boolean, isThrottled?: boolean, retryAfter?: number, item?: object, statusCode?: number }>}
 */
async function checkItemExistsOrDeleted({ accessToken, driveId = null, itemId }) {
  if (!accessToken || typeof accessToken !== 'string') {
    const err = new Error('Thiếu accessToken hợp lệ khi kiểm tra tệp OneDrive.');
    err.statusCode = 401;
    throw err;
  }
  if (!itemId || typeof itemId !== 'string' || !/^[a-zA-Z0-9!._-]+$/.test(itemId)) {
    const err = new Error('ID tệp OneDrive không hợp lệ.');
    err.statusCode = 400;
    throw err;
  }

  const metaUrl = driveId
    ? `${MS_GRAPH_ENDPOINT}/drives/${driveId}/items/${itemId}?select=id,name,size,file,folder,lastModifiedDateTime,parentReference,eTag,cTag,webUrl,deleted`
    : `${MS_GRAPH_ENDPOINT}/me/drive/items/${itemId}?select=id,name,size,file,folder,lastModifiedDateTime,parentReference,eTag,cTag,webUrl,deleted`;

  const metaResp = await fetchWithTimeout(metaUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });

  // 1. Throttling / Rate limiting (HTTP 429 hoặc 503)
  if (metaResp.status === 429 || metaResp.status === 503) {
    const retryAfterHeader = parseInt(metaResp.headers.get('retry-after') || '30', 10);
    const retryAfter = isNaN(retryAfterHeader) || retryAfterHeader <= 0 ? 30 : retryAfterHeader;
    return {
      exists: false,
      isDeleted: false,
      isThrottled: true,
      retryAfter,
      statusCode: metaResp.status
    };
  }

  // 2. Tệp bị xóa hoặc không tìm thấy (HTTP 404)
  if (metaResp.status === 404) {
    return {
      exists: false,
      isDeleted: true,
      isThrottled: false,
      statusCode: 404
    };
  }

  // 3. Lỗi quyền truy cập hoặc hết hạn token (HTTP 401, 403) -> Không coi là xóa, ném lỗi để worker retry/báo lỗi
  if (metaResp.status === 401 || metaResp.status === 403) {
    const err = new Error(`Lỗi quyền truy cập Microsoft Graph (${metaResp.status}): Phiên đăng nhập đã hết hạn hoặc không có quyền xem tệp.`);
    err.statusCode = metaResp.status;
    throw err;
  }

  // 4. Các mã lỗi server khác (5xx, v.v.)
  if (!metaResp.ok) {
    const errBody = await metaResp.text().catch(() => '');
    const err = new Error(`Lỗi Microsoft Graph khi kiểm tra tệp (${metaResp.status}): ${errBody.slice(0, 200)}`);
    err.statusCode = metaResp.status;
    throw err;
  }

  const driveItem = await metaResp.json();

  // 5. Kiểm tra facet deleted (nằm trong thùng rác OneDrive)
  if (driveItem.deleted || driveItem['@deleted']) {
    return {
      exists: false,
      isDeleted: true,
      isThrottled: false,
      statusCode: 200
    };
  }

  return {
    exists: true,
    isDeleted: false,
    isThrottled: false,
    item: {
      id: driveItem.id,
      name: driveItem.name,
      size: driveItem.size || 0,
      eTag: driveItem.eTag || null,
      cTag: driveItem.cTag || null,
      lastModifiedDateTime: driveItem.lastModifiedDateTime || null,
      parentReference: driveItem.parentReference || {}
    }
  };
}

module.exports = {
  checkItemExistsOrDeleted,
  sanitizeRedirectUrl,
  fetchWithTimeout,
  validateSharingUrl,
  validateDownloadRedirectUrl,
  downloadStreamWithLimit,
  encodeSharingUrl,
  validateFileSignature,
  generateAuthorizationUrl,
  handleOAuthCallback,
  getUserValidAccessToken,
  getOAuthConnectionStatus,
  disconnectOAuth,
  resolveAndDownloadSharedItem,
  listDriveItems,
  downloadDriveItem,
  MAX_ONEDRIVE_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
  MS_OUTBOUND_TIMEOUT_MS
};
