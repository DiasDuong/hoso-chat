const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifyToken, JWT_SECRET } = require('../middleware/auth');
const { logAudit } = require('../audit');
const oneDriveService = require('../services/oneDriveService');

const MAX_FAILED_ATTEMPTS = 5;

// Helper to validate password policy
function validatePasswordStrength(password) {
  if (!password || password.length < 8) {
    return 'Mật khẩu mới phải có tối thiểu 8 ký tự.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Mật khẩu mới phải chứa ít nhất một chữ cái in hoa (A-Z).';
  }
  if (!/[a-z]/.test(password)) {
    return 'Mật khẩu mới phải chứa ít nhất một chữ cái thường (a-z).';
  }
  if (!/[0-9]/.test(password) && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    return 'Mật khẩu mới phải chứa ít nhất một chữ số hoặc ký tự đặc biệt.';
  }
  return null;
}

// 1. POST /login
router.post('/login', async (req, res) => {
  const { username, password, portal } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.' });
  }

  try {
    const userRes = await db.query(
      `SELECT u.user_id, u.username, u.password_hash, u.role, u.company_id, u.employee_id,
              u.status, u.failed_login_attempts, u.locked_until, u.must_change_password,
              e.employee_code, e.employee_name, e.department, e.position, c.company_name
       FROM users u
       LEFT JOIN employees e ON u.employee_id = e.id
       LEFT JOIN companies c ON u.company_id = c.id
       WHERE u.username = $1`,
      [username.trim()]
    );

    if (userRes.rows.length === 0) {
      await logAudit({
        target_username: username,
        action: 'login_failed',
        status: 'FAILED',
        ip_address: ip,
        metadata: { reason: 'User not found' },
      });
      return res.status(401).json({ success: false, error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
    }

    const user = userRes.rows[0];

    // Check account status
    if (user.status === 'INACTIVE') {
      await logAudit({
        actor_user_id: user.user_id,
        actor_username: user.username,
        action: 'login_failed',
        status: 'FAILED',
        ip_address: ip,
        metadata: { reason: 'Account INACTIVE' },
      });
      return res.status(403).json({ success: false, error: 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.' });
    }

    if (user.status === 'LOCKED') {
      await logAudit({
        actor_user_id: user.user_id,
        actor_username: user.username,
        action: 'login_failed',
        status: 'FAILED',
        ip_address: ip,
        metadata: { reason: 'Account LOCKED' },
      });
      return res.status(403).json({ success: false, error: 'Tài khoản đã bị khóa do đăng nhập sai nhiều lần. Vui lòng liên hệ quản trị viên.' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        await db.query(
          `UPDATE users SET failed_login_attempts = $1, status = 'LOCKED', locked_until = now() + INTERVAL '30 minutes', updated_at = now()
           WHERE user_id = $2`,
          [attempts, user.user_id]
        );
        await logAudit({
          actor_user_id: user.user_id,
          actor_username: user.username,
          action: 'login_failed',
          status: 'FAILED',
          ip_address: ip,
          metadata: { reason: `Locked after ${MAX_FAILED_ATTEMPTS} failed attempts` },
        });
        return res.status(403).json({
          success: false,
          error: `Mật khẩu sai. Tài khoản đã bị khóa do đăng nhập sai quá ${MAX_FAILED_ATTEMPTS} lần.`,
        });
      } else {
        await db.query(
          `UPDATE users SET failed_login_attempts = $1, updated_at = now() WHERE user_id = $2`,
          [attempts, user.user_id]
        );
        const remaining = MAX_FAILED_ATTEMPTS - attempts;
        await logAudit({
          actor_user_id: user.user_id,
          actor_username: user.username,
          action: 'login_failed',
          status: 'FAILED',
          ip_address: ip,
          metadata: { reason: 'Wrong password', attempts },
        });
        return res.status(401).json({
          success: false,
          error: `Mật khẩu không chính xác. Bạn còn ${remaining} lần thử trước khi tài khoản bị khóa.`,
        });
      }
    }

    // Nếu đăng nhập từ Cổng Quản trị (portal === 'admin') mà không phải Quản trị viên hoặc HR thì từ chối
    if (portal === 'admin' && !['ADMIN', 'HR'].includes(user.role)) {
      await logAudit({
        actor_user_id: user.user_id,
        actor_username: user.username,
        action: 'login_failed',
        status: 'FAILED',
        ip_address: ip,
        metadata: { reason: 'Non-admin/Non-HR attempted login at Admin Portal', role: user.role },
      });
      return res.status(403).json({
        success: false,
        error: 'Quyền truy cập bị từ chối: Cổng này chỉ dành cho Quản trị viên và Chuyên viên Nhân sự (HR).',
      });
    }

    // Login successful -> reset attempts & set last_login
    await db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = now(), updated_at = now() WHERE user_id = $1`,
      [user.user_id]
    );

    // Sign JWT
    const token = jwt.sign(
      {
        user_id: user.user_id,
        username: user.username,
        role: user.role,
        company_id: user.company_id,
      },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    await logAudit({
      actor_user_id: user.user_id,
      actor_username: user.username,
      action: 'login_success',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: { role: user.role, company_id: user.company_id },
    });

    return res.json({
      success: true,
      token,
      user: {
        user_id: user.user_id,
        username: user.username,
        role: user.role,
        company_id: user.company_id,
        company_name: user.company_name,
        employee_id: user.employee_id,
        employee_code: user.employee_code,
        employee_name: user.employee_name,
        department: user.department,
        position: user.position,
        must_change_password: user.must_change_password,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ nội bộ.' });
  }
});

// 2. POST /logout
router.post('/logout', verifyToken, async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  await logAudit({
    actor_user_id: req.user.user_id,
    actor_username: req.user.username,
    action: 'logout',
    status: 'SUCCESS',
    ip_address: ip,
  });
  return res.json({ success: true, message: 'Đăng xuất thành công.' });
});

// 3. GET /me
router.get('/me', verifyToken, async (req, res) => {
  return res.json({ success: true, user: req.user });
});

// 4. POST /change-password
router.post('/change-password', verifyToken, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ success: false, error: 'Vui lòng điền đầy đủ các thông tin mật khẩu.' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ success: false, error: 'Mật khẩu mới và xác nhận mật khẩu không khớp.' });
  }

  const strengthErr = validatePasswordStrength(new_password);
  if (strengthErr) {
    return res.status(400).json({ success: false, error: strengthErr });
  }

  try {
    const userRes = await db.query(
      `SELECT password_hash FROM users WHERE user_id = $1`,
      [req.user.user_id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
    }

    const isMatch = await bcrypt.compare(current_password, userRes.rows[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Mật khẩu hiện tại không chính xác.' });
    }

    if (current_password === new_password) {
      return res.status(400).json({ success: false, error: 'Mật khẩu mới không được trùng với mật khẩu hiện tại.' });
    }

    const newHash = await bcrypt.hash(new_password, 10);

    await db.query(
      `UPDATE users 
       SET password_hash = $1, must_change_password = false, password_changed_at = now(), updated_at = now()
       WHERE user_id = $2`,
      [newHash, req.user.user_id]
    );

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      target_user_id: req.user.user_id,
      target_username: req.user.username,
      action: 'password_changed',
      status: 'SUCCESS',
      ip_address: ip,
    });

    return res.json({ success: true, message: 'Đổi mật khẩu thành công.' });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi cập nhật mật khẩu.' });
  }
});

// =========================================================================
// 5. MICROSOFT ONEDRIVE OAUTH 2.0 INTEGRATION ROUTES
// =========================================================================

/**
 * GET /api/auth/microsoft/authorize
 * Initiates Microsoft OAuth 2.0 Authorization flow with CSRF state protection.
 */
router.get('/microsoft/authorize', verifyToken, async (req, res) => {
  try {
    const rawRedirect = req.query.redirect_after;
    const redirectAfter = oneDriveService.sanitizeRedirectUrl(rawRedirect);
    const { authUrl, state } = await oneDriveService.generateAuthorizationUrl(req.user.user_id, redirectAfter);

    if (req.query.mode === 'redirect') {
      return res.redirect(authUrl);
    }

    return res.json({
      success: true,
      authUrl,
      state,
      message: 'Vui lòng truy cập authUrl để ủy quyền tài khoản Microsoft OneDrive.'
    });
  } catch (err) {
    console.error('[MicrosoftOAuth] Lỗi khởi tạo ủy quyền:', err);
    return res.status(500).json({ success: false, error: 'Không thể khởi tạo ủy quyền Microsoft: ' + err.message });
  }
});

/**
 * GET /api/auth/microsoft/callback
 * Receives authorization code from Microsoft, validates state, and persists encrypted tokens.
 */
router.get('/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Xử lý trường hợp người dùng hủy hoặc Microsoft báo lỗi
  if (error) {
    console.warn('[MicrosoftOAuth] Người dùng hủy hoặc Microsoft báo lỗi:', error, error_description);
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Ủy quyền Microsoft Thất bại</title><meta charset="utf-8"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 40px; background: #fff5f5; color: #7f1d1d;">
        <h2>⚠️ Kết nối Microsoft OneDrive không thành công</h2>
        <p>Lý do: ${error_description || error || 'Người dùng đã hủy quá trình đăng nhập.'}</p>
        <p><a href="/chat/" style="display: inline-block; padding: 8px 16px; background: #dc2626; color: #fff; text-decoration: none; border-radius: 6px; margin-top: 10px;">Quay lại SOTRANS Hub</a></p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'MS_AUTH_ERROR', error: '${error}' }, '*');
            setTimeout(() => window.close(), 3000);
          }
        </script>
      </body>
      </html>
    `);
  }

  try {
    const result = await oneDriveService.handleOAuthCallback(code, state);
    const displayName = result.accountEmail || result.accountName || 'Tài khoản Microsoft';
    const safeRedirect = oneDriveService.sanitizeRedirectUrl(result.redirectAfter);
    const safeRedirectHref = encodeURI(safeRedirect);
    const safeRedirectJs = JSON.stringify(safeRedirect);

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Kết nối Microsoft Thành công</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 40px 20px; background: #f8fafc; color: #1e293b; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box;">
        <div style="max-width: 420px; width: 100%; background: #ffffff; padding: 32px 24px; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; box-sizing: border-box;">
          <div style="width: 56px; height: 56px; border-radius: 50%; background: #dcfce7; color: #16a34a; font-size: 26px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">✓</div>
          <h2 style="color: #16a34a; font-size: 19px; margin: 0 0 10px; font-weight: 700;">Kết nối Microsoft OneDrive thành công!</h2>
          <p style="color: #475569; font-size: 14px; margin: 0 0 6px;">Đã liên kết tài khoản: <strong style="color: #0f172a;">${displayName}</strong></p>
          <p style="color: #64748b; font-size: 13px; margin: 12px 0 20px; line-height: 1.5;">Cửa sổ này đang tự động đóng để bạn tiếp tục trò chuyện trên cửa sổ SOTRANS Hub chính.</p>
          <button type="button" onclick="closePopupAndReturn()" style="display: inline-block; width: 100%; padding: 12px 20px; background: #0284c7; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 4px rgba(2,132,199,0.3);">
            Đóng cửa sổ này & Quay lại Chat
          </button>
        </div>
        <script>
          function notifyParent() {
            try {
              if (window.BroadcastChannel) {
                const bc = new BroadcastChannel('ms_oauth_channel');
                bc.postMessage({ type: 'MS_AUTH_SUCCESS', email: ${JSON.stringify(displayName)} });
              }
            } catch (e) {}
            try {
              localStorage.setItem('MS_AUTH_EVENT', JSON.stringify({
                type: 'MS_AUTH_SUCCESS',
                email: ${JSON.stringify(displayName)},
                ts: Date.now()
              }));
            } catch (e) {}
            try {
              if (window.opener && !window.opener.closed) {
                window.opener.postMessage({ type: 'MS_AUTH_SUCCESS', email: ${JSON.stringify(displayName)} }, '*');
              }
            } catch (e) {}
          }

          function closePopupAndReturn() {
            notifyParent();
            try {
              window.close();
            } catch (e) {}
            // Nếu không phải là popup (mở trực tiếp tab lớn) thì mới chuyển hướng
            setTimeout(() => {
              if (!window.opener && window.innerWidth >= 900) {
                window.location.href = ${safeRedirectJs};
              }
            }, 600);
          }

          // Thông báo ngay khi callback hoàn tất
          notifyParent();

          // Tự động đóng cửa sổ popup sau 1.2s
          setTimeout(() => {
            closePopupAndReturn();
          }, 1200);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[MicrosoftOAuth] Lỗi xử lý callback:', err);
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Lỗi Xác thực Microsoft</title><meta charset="utf-8"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 40px; background: #fff5f5; color: #7f1d1d;">
        <h2>❌ Lỗi xác thực Microsoft OneDrive</h2>
        <p>${err.message}</p>
        <p><a href="/chat/" style="display: inline-block; padding: 8px 16px; background: #dc2626; color: #fff; text-decoration: none; border-radius: 6px; margin-top: 10px;">Quay lại SOTRANS Hub</a></p>
      </body>
      </html>
    `);
  }
});

/**
 * GET /api/auth/microsoft/status
 * Returns current user's Microsoft OneDrive connection status.
 */
router.get('/microsoft/status', verifyToken, async (req, res) => {
  try {
    const status = await oneDriveService.getOAuthConnectionStatus(req.user.user_id);
    return res.json({ success: true, ...status });
  } catch (err) {
    console.error('[MicrosoftOAuth] Lỗi kiểm tra trạng thái:', err);
    return res.status(500).json({ success: false, error: 'Không thể kiểm tra trạng thái: ' + err.message });
  }
});

/**
 * POST /api/auth/microsoft/disconnect
 * Disconnects / removes current user's Microsoft credentials.
 */
router.post('/microsoft/disconnect', verifyToken, async (req, res) => {
  try {
    await oneDriveService.disconnectOAuth(req.user.user_id);
    return res.json({ success: true, message: 'Đã hủy liên kết tài khoản Microsoft OneDrive thành công.' });
  } catch (err) {
    console.error('[MicrosoftOAuth] Lỗi hủy liên kết:', err);
    return res.status(500).json({ success: false, error: 'Không thể hủy liên kết: ' + err.message });
  }
});

module.exports = router;
