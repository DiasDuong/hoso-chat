const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';

async function verifyToken(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Chưa đăng nhập. Vui lòng cung cấp token hợp lệ.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Fetch latest user info from DB to ensure status is still ACTIVE
    const result = await db.query(
      `SELECT u.user_id, u.username, u.role, u.company_id, u.employee_id, u.status, u.must_change_password,
              e.employee_code, e.citizen_id, e.employee_name, e.department, e.position, c.company_name
       FROM users u
       LEFT JOIN employees e ON u.employee_id = e.id
       LEFT JOIN companies c ON u.company_id = c.id
       WHERE u.user_id = $1`,
      [decoded.user_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Tài khoản không tồn tại trên hệ thống.' });
    }

    const user = result.rows[0];

    if (user.status === 'INACTIVE') {
      return res.status(403).json({ success: false, error: 'Tài khoản của bạn đã bị vô hiệu hóa.' });
    }

    if (user.status === 'LOCKED') {
      return res.status(403).json({ success: false, error: 'Tài khoản của bạn đã bị khóa.' });
    }

    // Attach verified user to req
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
    }
    return res.status(401).json({ success: false, error: 'Token không hợp lệ hoặc đã bị thay đổi.' });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Chưa xác thực người dùng.' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Quyền ${req.user.role} không được phép thực hiện thao tác này.`,
      });
    }

    next();
  };
}

async function hasPermission(role, permission) {
  if (!role || !permission) return false;
  try {
    const res = await db.query(
      `SELECT 1 FROM role_permissions WHERE role = $1 AND permission = $2`,
      [role, permission]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error('Permission check error:', err);
    return false;
  }
}

function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Chưa xác thực người dùng.' });
    }

    const allowed = await hasPermission(req.user.role, permission);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Vai trò ${req.user.role} không có quyền '${permission}' để thực hiện thao tác này.`,
      });
    }

    next();
  };
}

module.exports = {
  verifyToken,
  requireRoles,
  hasPermission,
  requirePermission,
  JWT_SECRET,
};
