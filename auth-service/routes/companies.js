const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken, requireRoles } = require('../middleware/auth');
const { logAudit } = require('../audit');

// 1. GET /companies (Admin & HR scoped)
router.get('/', verifyToken, requireRoles('ADMIN', 'HR'), async (req, res) => {
  try {
    let query = `
      SELECT c.id, c.company_code, c.company_name, c.status, c.created_at, c.updated_at,
             COUNT(DISTINCT e.id)::int AS employee_count,
             COUNT(DISTINCT u.user_id)::int AS user_count
      FROM companies c
      LEFT JOIN employees e ON c.id = e.company_id
      LEFT JOIN users u ON c.id = u.company_id
    `;
    const params = [];

    if (req.user.role === 'ADMIN') {
      query += ` GROUP BY c.id ORDER BY c.company_code ASC`;
    } else {
      // Scoped to own company
      query += ` WHERE c.id = $1 GROUP BY c.id ORDER BY c.company_code ASC`;
      params.push(req.user.company_id);
    }

    const result = await db.query(query, params);
    return res.json({ success: true, companies: result.rows });
  } catch (err) {
    console.error('List companies error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tải danh sách công ty.' });
  }
});

// 2. POST /companies (ADMIN only)
router.post('/', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { id, company_code, company_name } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!id || !company_code || !company_name) {
    return res.status(400).json({ success: false, error: 'Vui lòng cung cấp mã ID, mã công ty và tên công ty.' });
  }

  const cleanId = id.trim().toUpperCase();
  const cleanCode = company_code.trim().toUpperCase();
  const cleanName = company_name.trim();

  try {
    const existing = await db.query(
      `SELECT id FROM companies WHERE id = $1 OR company_code = $2`,
      [cleanId, cleanCode]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Mã công ty đã tồn tại.' });
    }

    const result = await db.query(
      `INSERT INTO companies (id, company_code, company_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', now(), now())
       RETURNING *`,
      [cleanId, cleanCode, cleanName]
    );

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'company_created',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: { company_id: cleanId, company_name: cleanName },
    });

    return res.status(201).json({ success: true, company: result.rows[0] });
  } catch (err) {
    console.error('Create company error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tạo công ty mới.' });
  }
});

// 3. PUT /companies/:id (ADMIN only)
router.put('/:id', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { company_name, status } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const existing = await db.query(`SELECT * FROM companies WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy công ty.' });
    }

    const newName = company_name ? company_name.trim() : existing.rows[0].company_name;
    const newStatus = status ? status.trim().toUpperCase() : existing.rows[0].status;

    if (!['ACTIVE', 'INACTIVE'].includes(newStatus)) {
      return res.status(400).json({ success: false, error: 'Trạng thái chỉ có thể là ACTIVE hoặc INACTIVE.' });
    }

    const result = await db.query(
      `UPDATE companies SET company_name = $1, status = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [newName, newStatus, id]
    );

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'company_updated',
      status: 'SUCCESS',
      ip_address: ip,
      metadata: { company_id: id, old_status: existing.rows[0].status, new_status: newStatus },
    });

    return res.json({ success: true, company: result.rows[0] });
  } catch (err) {
    console.error('Update company error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi cập nhật công ty.' });
  }
});

module.exports = router;
