const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { verifyToken, requireRoles } = require('../middleware/auth');
const { logAudit } = require('../audit');

// Định dạng chuẩn mã nhân viên và gợi ý theo từng công ty
const COMPANY_CODE_PATTERNS = {
  'STL': {
    regex: /^STL-\d{3,5}$/i,
    hint: 'Mã nhân viên SOTRANS Logistics (STL) phải có định dạng "STL-xxx" (Ví dụ: STL-001, STL-1029).'
  },
  'VTX': {
    regex: /^VTX[_-]\d{3,5}$/i,
    hint: 'Mã nhân viên Vietranstimex (VTX) phải có định dạng "VTX_xxx" hoặc "VTX-xxx" (Ví dụ: VTX_881, VTX-101).'
  },
  'SWC': {
    regex: /^(SWC-\d{3,5}|\d{12})$/i,
    hint: 'Mã nhân viên Sowatco (SWC) phải có định dạng "SWC-xxx" hoặc số CCCD 12 chữ số (Ví dụ: SWC-402, 079205001589).'
  }
};

// 1. GET /users - List users with RBAC scope
router.get('/', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { company_id, role, status, search } = req.query || {};

  try {
    let query = `
      SELECT u.user_id, u.username, u.role, u.company_id, u.employee_id, u.status,
             u.failed_login_attempts, u.must_change_password, u.last_login, u.created_at, u.updated_at,
             e.employee_code, e.employee_name, e.department, e.position, e.email,
             c.company_name
      FROM users u
      LEFT JOIN employees e ON u.employee_id = e.id
      LEFT JOIN companies c ON u.company_id = c.id
      WHERE 1=1
    `;
    const params = [];

    // RBAC Scope check: ADMIN can see all users or filter by company_id
    if (company_id && company_id !== 'all') {
      params.push(company_id);
      query += ` AND u.company_id = $${params.length}`;
    }

    if (role) {
      params.push(role);
      query += ` AND u.role = $${params.length}`;
    }

    if (status) {
      params.push(status);
      query += ` AND u.status = $${params.length}`;
    }

    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const p = params.length;
      query += ` AND (LOWER(u.username) LIKE $${p} OR LOWER(COALESCE(e.employee_name, '')) LIKE $${p} OR LOWER(COALESCE(e.employee_code, '')) LIKE $${p})`;
    }

    query += ` ORDER BY u.created_at DESC`;

    const result = await db.query(query, params);
    return res.json({ success: true, users: result.rows, data: result.rows });
  } catch (err) {
    console.error('List users error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tải danh sách người dùng.' });
  }
});

// GET /users/check-availability - Real-time validation for username & employee code
router.get('/check-availability', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  const { username, employee_code, company_id } = req.query || {};
  const response = {
    username_available: true,
    employee_code_available: true,
    errors: {}
  };

  try {
    if (username) {
      const cleanUser = username.trim().toLowerCase();
      const existing = await db.query(`SELECT user_id FROM users WHERE username = $1`, [cleanUser]);
      if (existing.rows.length > 0) {
        response.username_available = false;
        response.errors.username = `Tên đăng nhập "${cleanUser}" đã tồn tại trên hệ thống.`;
      }
    }

    if (employee_code) {
      const cleanCode = employee_code.trim();
      const comp = req.user.role === 'HR' ? req.user.company_id : (company_id || null);
      if (comp && COMPANY_CODE_PATTERNS[comp]) {
        const pat = COMPANY_CODE_PATTERNS[comp];
        if (!pat.regex.test(cleanCode)) {
          response.employee_code_available = false;
          response.errors.employee_code = pat.hint;
        }
      }

      if (response.employee_code_available !== false) {
        let checkQuery = `SELECT e.id, e.company_id, u.username 
           FROM employees e 
           LEFT JOIN users u ON u.employee_id = e.id 
           WHERE e.employee_code = $1`;
        const qParams = [cleanCode];
        if (comp) {
          checkQuery += ` AND e.company_id = $2`;
          qParams.push(comp);
        }
        const empRes = await db.query(checkQuery, qParams);
        if (empRes.rows.length > 0) {
          if (empRes.rows[0].username) {
            response.employee_code_available = false;
            response.errors.employee_code = `Mã "${cleanCode}" đã được liên kết với tài khoản "${empRes.rows[0].username}".`;
          }
        }
      }
    }

    return res.json({ success: true, ...response });
  } catch (err) {
    console.error('Check availability error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi kiểm tra dữ liệu.' });
  }
});

// 2. POST /users - Create user with transactional profile linking
router.post('/', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  const {
    username,
    password,
    role,
    company_id,
    employee_code,
    employee_name,
    department,
    position,
    email,
    generate_temp_password,
    must_change_password
  } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Validate username
  const cleanUsername = username ? username.trim().toLowerCase() : '';
  if (!cleanUsername) {
    return res.status(400).json({ success: false, error: 'Tên đăng nhập không được để trống.' });
  }
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(cleanUsername)) {
    return res.status(400).json({
      success: false,
      error: 'Tên đăng nhập phải từ 3 đến 50 ký tự, chỉ gồm chữ cái, chữ số, dấu chấm, gạch dưới hoặc gạch ngang.'
    });
  }

  // Password setup (manual or auto-generated secure temporary password)
  let actualPassword = password ? String(password).trim() : '';
  let mustChange = true;

  if (generate_temp_password || !actualPassword) {
    actualPassword = `Sotrans@${crypto.randomBytes(3).toString('hex').toUpperCase()}!`;
    mustChange = true;
  } else {
    if (actualPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Mật khẩu phải có tối thiểu 8 ký tự.' });
    }
    mustChange = must_change_password !== undefined ? Boolean(must_change_password) : true;
  }

  // Validate email if provided
  if (email && email.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'Địa chỉ email không đúng định dạng.' });
    }
  }

  // Security enforcement on role & company
  let targetRole = role || 'EMPLOYEE';
  let targetCompanyId = company_id || null;

  if (!['ADMIN', 'HR', 'EMPLOYEE', 'USER'].includes(targetRole)) {
    return res.status(400).json({ success: false, error: 'Vai trò người dùng không hợp lệ.' });
  }

  if (req.user.role === 'HR') {
    if (!['EMPLOYEE', 'USER'].includes(targetRole)) {
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: HR chỉ được quyền tạo tài khoản nhân viên (EMPLOYEE / USER).',
      });
    }
    // Anti-tamper: Không được phép tạo tài khoản cho công ty khác
    if (company_id && String(company_id).trim().toUpperCase() !== req.user.company_id) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn không có quyền tạo tài khoản thuộc công ty khác (${company_id}).`
      });
    }
    // Khóa cứng company_id theo HR
    targetCompanyId = req.user.company_id;
  } else if (req.user.role === 'ADMIN') {
    if (targetRole === 'ADMIN') {
      targetCompanyId = null;
    } else if (targetRole === 'USER' && !targetCompanyId) {
      targetCompanyId = null;
    } else if (!targetCompanyId && targetRole !== 'USER') {
      return res.status(400).json({
        success: false,
        error: 'Vui lòng chọn công ty trực thuộc cho tài khoản HR hoặc EMPLOYEE.',
      });
    }
  }

  // Check username uniqueness
  const existingUser = await db.query(`SELECT user_id FROM users WHERE username = $1`, [cleanUsername]);
  if (existingUser.rows.length > 0) {
    return res.status(400).json({ success: false, error: 'Tên đăng nhập đã tồn tại trên hệ thống.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let employeeId = null;

    if (['EMPLOYEE', 'HR'].includes(targetRole)) {
      if (!employee_code || !employee_name) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Tài khoản nhân sự/nhân viên cần có Mã nhân viên và Họ tên.' });
      }

      const cleanCode = employee_code.trim();

      // Enforce company employee code format rule
      if (targetCompanyId && COMPANY_CODE_PATTERNS[targetCompanyId]) {
        const pat = COMPANY_CODE_PATTERNS[targetCompanyId];
        if (!pat.regex.test(cleanCode)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: pat.hint });
        }
      }

      // Check if employee code already exists in employees table for this company
      const existingEmp = await client.query(
        `SELECT id, employee_code, employee_name, company_id FROM employees WHERE employee_code = $1 AND company_id = $2`,
        [cleanCode, targetCompanyId]
      );

      if (existingEmp.rows.length > 0) {
        const emp = existingEmp.rows[0];

        // Check if employee profile is already linked to another user account
        const linkedUser = await client.query(
          `SELECT user_id, username FROM users WHERE employee_id = $1`,
          [emp.id]
        );

        if (linkedUser.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: `Mã nhân viên "${cleanCode}" đã được liên kết với tài khoản "${linkedUser.rows[0].username}".`
          });
        }

        // Link with existing employee profile and update profile details
        employeeId = emp.id;
        await client.query(
          `UPDATE employees 
           SET employee_name = $1,
               department = COALESCE($2::varchar, department),
               position = COALESCE($3::varchar, position),
               email = COALESCE($4::varchar, email),
               updated_at = now()
           WHERE id = $5`,
          [
            employee_name.trim(),
            department ? department.trim() : null,
            position ? position.trim() : null,
            email ? email.trim() : null,
            employeeId
          ]
        );
      } else {
        // Create new employee profile
        const defaultDept = targetRole === 'HR' ? (department ? department.trim() : 'Nhân sự') : (department ? department.trim() : null);

        const empRes = await client.query(
          `INSERT INTO employees (employee_code, employee_name, company_id, department, position, email, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now(), now())
           RETURNING id`,
          [
            cleanCode,
            employee_name.trim(),
            targetCompanyId,
            defaultDept,
            position ? position.trim() : null,
            email ? email.trim() : null,
          ]
        );
        employeeId = empRes.rows[0].id;
      }
    }

    const passwordHash = await bcrypt.hash(actualPassword, 10);

    const userRes = await client.query(
      `INSERT INTO users (username, password_hash, role, company_id, employee_id, status, failed_login_attempts, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 0, $6, now(), now())
       RETURNING user_id, username, role, company_id, employee_id, status, must_change_password, created_at`,
      [cleanUsername, passwordHash, targetRole, targetCompanyId, employeeId, mustChange]
    );

    await client.query('COMMIT');

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      target_user_id: userRes.rows[0].user_id,
      target_username: cleanUsername,
      action: 'user_created',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: { role: targetRole, company_id: targetCompanyId },
    });

    return res.status(201).json({
      success: true,
      user: userRes.rows[0],
      temporary_password: actualPassword
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create user error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tạo người dùng: ' + err.message });
  } finally {
    client.release();
  }
});

// 3. PUT /users/:id - Update user / employee info
router.put('/:id', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { employee_name, department, position, email, status, role, company_id } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Validation
  if (email && email.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'Địa chỉ email không đúng định dạng.' });
    }
  }

  if (status && !['ACTIVE', 'INACTIVE', 'LOCKED'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Trạng thái tài khoản không hợp lệ.' });
  }

  if (role && !['ADMIN', 'HR', 'EMPLOYEE', 'USER'].includes(role)) {
    return res.status(400).json({ success: false, error: 'Vai trò hệ thống không hợp lệ.' });
  }

  try {
    const targetRes = await db.query(
      `SELECT u.user_id, u.username, u.role, u.company_id, u.employee_id, u.status, u.failed_login_attempts, u.locked_until,
              e.employee_code, e.employee_name, e.department, e.position, e.email
       FROM users u 
       LEFT JOIN employees e ON u.employee_id = e.id 
       WHERE u.user_id = $1`,
      [id]
    );

    if (targetRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
    }

    const targetUser = targetRes.rows[0];

    // Anti-self-lock / Anti-self-demotion
    if (req.user.user_id === id) {
      if (status && status !== 'ACTIVE') {
        return res.status(400).json({ success: false, error: 'Không thể tự vô hiệu hóa hoặc khóa tài khoản của chính mình.' });
      }
      if (role && role !== 'ADMIN') {
        return res.status(400).json({ success: false, error: 'Không thể tự hạ vai trò Admin của chính mình.' });
      }
    }

    // Track diff for audit log
    const changes = {};

    let newStatus = targetUser.status;
    if (status && status !== targetUser.status) {
      changes.status = { from: targetUser.status, to: status };
      newStatus = status;
    }

    let newRole = targetUser.role;
    let newCompanyId = targetUser.company_id;

    if (company_id !== undefined && company_id !== targetUser.company_id) {
      if (company_id) {
        const compCheck = await db.query('SELECT id FROM companies WHERE id = $1', [company_id]);
        if (compCheck.rows.length === 0) {
          return res.status(400).json({ success: false, error: 'Mã công ty không tồn tại trên hệ thống.' });
        }
      }
      changes.company_id = { from: targetUser.company_id, to: company_id };
      newCompanyId = company_id;
    }

    if (role && role !== targetUser.role) {
      if (role === 'ADMIN') {
        newCompanyId = null;
        changes.company_id = { from: targetUser.company_id, to: null };
      }
      changes.role = { from: targetUser.role, to: role };
      newRole = role;
    }

    // Employee profile fields diff
    const newEmpName = employee_name !== undefined ? (employee_name ? employee_name.trim() : null) : targetUser.employee_name;
    const newDept = department !== undefined ? (department ? department.trim() : null) : targetUser.department;
    const newPosition = position !== undefined ? (position ? position.trim() : null) : targetUser.position;
    const newEmail = email !== undefined ? (email ? email.trim() : null) : targetUser.email;

    if (targetUser.employee_id) {
      if (employee_name !== undefined && newEmpName !== targetUser.employee_name) {
        changes.employee_name = { from: targetUser.employee_name, to: newEmpName };
      }
      if (department !== undefined && newDept !== targetUser.department) {
        changes.department = { from: targetUser.department, to: newDept };
      }
      if (position !== undefined && newPosition !== targetUser.position) {
        changes.position = { from: targetUser.position, to: newPosition };
      }
      if (email !== undefined && newEmail !== targetUser.email) {
        changes.email = { from: targetUser.email, to: newEmail };
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Update users table
      const failedReset = newStatus === 'ACTIVE' ? 0 : targetUser.failed_login_attempts;
      const lockedUntil = newStatus === 'ACTIVE' ? null : targetUser.locked_until;
      await client.query(
        `UPDATE users 
         SET status = $1, 
             role = $2, 
             company_id = $3, 
             failed_login_attempts = $4, 
             locked_until = $5, 
             updated_at = now() 
         WHERE user_id = $6`,
        [newStatus, newRole, newCompanyId, failedReset, lockedUntil, id]
      );

      // Update employees table if linked
      if (targetUser.employee_id) {
        await client.query(
          `UPDATE employees 
           SET employee_name = COALESCE($1::varchar, employee_name),
               department = COALESCE($2::varchar, department),
               position = COALESCE($3::varchar, position),
               email = COALESCE($4::varchar, email),
               company_id = $5::varchar,
               updated_at = now() 
           WHERE id = $6`,
          [
            newEmpName,
            newDept,
            newPosition,
            newEmail,
            newCompanyId,
            targetUser.employee_id,
          ]
        );

        if (newCompanyId !== targetUser.company_id) {
          await client.query(
            `UPDATE hr_employee_profiles 
             SET company_id = $1, updated_at = now() 
             WHERE employee_id = $2 OR (citizen_id IS NOT NULL AND citizen_id = (SELECT citizen_id FROM employees WHERE id = $3))`,
            [newCompanyId, targetUser.employee_code, targetUser.employee_id]
          );
        }
      }

      await client.query('COMMIT');

      // Write audit log if changes occurred
      if (Object.keys(changes).length > 0) {
        await logAudit({
          actor_user_id: req.user.user_id,
          actor_username: req.user.username,
          target_user_id: id,
          target_username: targetUser.username,
          action: 'user_updated',
          status: 'SUCCESS',
          ip_address: ip,
          metadata: { changes, summary: Object.keys(changes).join(', ') },
        });
      }

      return res.json({ 
        success: true, 
        message: 'Cập nhật thông tin thành công.',
        changes 
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Update user error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi cập nhật người dùng: ' + err.message });
  }
});

// 4. POST & PUT /users/:id/reset-password - Admin reset password
router.put('/:id/reset-password', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  return handleResetPassword(req, res);
});
router.post('/:id/reset-password', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  return handleResetPassword(req, res);
});

async function handleResetPassword(req, res) {
  const { id } = req.params;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const targetRes = await db.query(`SELECT * FROM users WHERE user_id = $1`, [id]);
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
    }

    const targetUser = targetRes.rows[0];

    // Custom new password or generate secure temporary password
    const tempPassword = (req.body && req.body.new_password) 
      ? req.body.new_password 
      : `Reset@${Math.random().toString(36).substring(2, 8).toUpperCase()}!`;
    const mustChange = (req.body && req.body.must_change_password !== undefined) 
      ? Boolean(req.body.must_change_password) 
      : true;

    const newHash = await bcrypt.hash(tempPassword, 10);

    await db.query(
      `UPDATE users 
       SET password_hash = $1, must_change_password = $2, failed_login_attempts = 0, status = 'ACTIVE', locked_until = NULL, updated_at = now()
       WHERE user_id = $3`,
      [newHash, mustChange, id]
    );

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      target_user_id: id,
      target_username: targetUser.username,
      action: 'password_reset',
      status: 'SUCCESS',
      ip_address: ip,
    });

    return res.json({
      success: true,
      message: 'Mật khẩu đã được đặt lại thành công.',
      temporary_password: tempPassword,
    });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi reset mật khẩu.' });
  }
}

// 5. POST /users/:id/toggle-status
router.post('/:id/toggle-status', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!['ACTIVE', 'INACTIVE', 'LOCKED'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Trạng thái không hợp lệ.' });
  }

  if (req.user.user_id === id) {
    return res.status(400).json({ success: false, error: 'Không thể tự vô hiệu hóa tài khoản của chính mình.' });
  }

  try {
    const targetRes = await db.query(`SELECT * FROM users WHERE user_id = $1`, [id]);
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
    }

    const targetUser = targetRes.rows[0];

    const failedReset = status === 'ACTIVE' ? 0 : targetUser.failed_login_attempts;
    await db.query(
      `UPDATE users SET status = $1, failed_login_attempts = $2, locked_until = NULL, updated_at = now() WHERE user_id = $3`,
      [status, failedReset, id]
    );

    const action = status === 'INACTIVE' ? 'user_disabled' : 'user_status_changed';
    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      target_user_id: id,
      target_username: targetUser.username,
      action,
      status: 'SUCCESS',
      ip_address: ip,
      metadata: { new_status: status },
    });

    return res.json({ success: true, message: `Đã cập nhật trạng thái tài khoản sang ${status}.` });
  } catch (err) {
    console.error('Toggle status error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi cập nhật trạng thái tài khoản.' });
  }
});

// 6. DELETE /users/:id - Xóa tài khoản người dùng
// Phân quyền: CHỈ Admin toàn hệ thống
router.delete('/:id', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const targetRes = await db.query(`SELECT * FROM users WHERE user_id = $1`, [id]);
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
    }

    const targetUser = targetRes.rows[0];

    // Không cho phép Admin tự xóa tài khoản của chính mình
    if (req.user.user_id === id) {
      return res.status(400).json({ success: false, error: 'Không thể tự xóa tài khoản của chính mình.' });
    }

    await db.query(`DELETE FROM users WHERE user_id = $1`, [id]);

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      target_user_id: id,
      target_username: targetUser.username,
      action: 'user_deleted',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: { deleted_username: targetUser.username, company_id: targetUser.company_id }
    });

    return res.json({
      success: true,
      message: `Đã xóa thành công tài khoản "${targetUser.username}".`
    });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi xóa người dùng: ' + err.message });
  }
});

module.exports = router;
