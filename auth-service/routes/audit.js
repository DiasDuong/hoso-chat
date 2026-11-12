const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken, requireRoles } = require('../middleware/auth');

router.get('/', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  const { action, company_id, limit = 100 } = req.query || {};

  try {
    let query = `
      SELECT l.id, l.actor_user_id, l.actor_username, l.target_user_id, l.target_username,
             l.action, l.status, l.ip_address, l.metadata, l.created_at
      FROM auth_audit_logs l
      WHERE 1=1
    `;
    const params = [];

    if (company_id && company_id !== 'all') {
      params.push(company_id);
      query += ` AND (
        (l.metadata->>'company_id' = $${params.length}) OR 
        (l.actor_username IN (SELECT username FROM users WHERE company_id = $${params.length})) OR
        (l.target_username IN (SELECT username FROM users WHERE company_id = $${params.length}))
      )`;
    }

    if (action) {
      params.push(action);
      query += ` AND l.action = $${params.length}`;
    }

    params.push(parseInt(limit, 10) || 100);
    query += ` ORDER BY l.created_at DESC LIMIT $${params.length}`;

    const result = await db.query(query, params);
    return res.json({ success: true, logs: result.rows });
  } catch (err) {
    console.error('List audit logs error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi tải nhật ký kiểm toán.' });
  }
});

// POST /api/audit/retention/run - Quản trị viên kích hoạt dọn dẹp lưu trữ Staging theo yêu cầu (Chính sách 7 ngày)
router.post('/retention/run', verifyToken, requireRoles('ADMIN'), async (req, res) => {
  try {
    const { stagingFileDays = 7, abandonedDays = 7 } = req.body || {};
    const { purgeStagingRecords, purgeExpiredAgentOutputs } = require('../services/retentionService');

    const stagingRes = await purgeStagingRecords({
      stagingFileDays: parseInt(stagingFileDays, 10) || 7,
      abandonedDays: parseInt(abandonedDays, 10) || 7,
      actorUserId: req.user.user_id,
      actorUsername: req.user.username
    });

    const outputsRes = await purgeExpiredAgentOutputs({
      dryRun: false,
      actor: req.user.username
    });

    return res.json({
      success: true,
      message: 'Tiến trình dọn dẹp lưu trữ Staging hoàn tất thành công.',
      staging: stagingRes,
      agent_outputs: outputsRes
    });
  } catch (err) {
    console.error('[MANUAL RETENTION PURGE ERROR]:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
