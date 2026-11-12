const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifyToken, JWT_SECRET } = require('../middleware/auth');

const AGENT_OUTPUTS_DIR = path.resolve(__dirname, '..', 'data', 'agent_outputs');

function resolveStoragePath(storedPath) {
  if (!storedPath) return null;
  let p = String(storedPath).trim();
  const normalizedBase = path.resolve(AGENT_OUTPUTS_DIR);
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(p)) {
    const parts = p.split(/[\\/]/);
    const idx = parts.indexOf('agent_outputs');
    if (idx !== -1) {
      const sub = parts.slice(idx + 1).join('/');
      return path.resolve(normalizedBase, sub);
    }
  }
  return path.resolve(p);
}

/**
 * Xác thực linh hoạt: Chấp nhận JWT Bearer hoặc Ticket tải tệp ngắn hạn
 */
async function resolveDownloadAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.ticket) {
    token = req.query.ticket;
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Chưa xác thực. Vui lòng cung cấp token hoặc ticket tải tệp hợp lệ.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || (!decoded.user_id && !decoded.userId)) {
      return res.status(401).json({ success: false, error: 'Token không hợp lệ.' });
    }

    const userId = decoded.user_id || decoded.userId;
    const userRes = await db.query(
      `SELECT user_id, username, role, status FROM users WHERE user_id = $1`,
      [userId]
    );

    if (userRes.rows.length === 0 || userRes.rows[0].status !== 'ACTIVE') {
      return res.status(403).json({ success: false, error: 'Tài khoản không tồn tại hoặc đã bị khóa.' });
    }

    req.user = userRes.rows[0];
    req.targetFileId = decoded.fileId || null;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Phiên tải tệp hoặc ticket đã hết hạn. Vui lòng lấy liên kết mới.' });
    }
    return res.status(401).json({ success: false, error: 'Token tải tệp không hợp lệ: ' + err.message });
  }
}

// 1. GET /api/agents/files/:id/download
router.get('/:id/download', resolveDownloadAuth, async (req, res) => {
  const { id } = req.params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, error: 'Định dạng ID tệp không hợp lệ.' });
  }

  // Nếu dùng ticket, kiểm tra ticket có khớp với đúng fileId hay không
  if (req.targetFileId && req.targetFileId !== id) {
    return res.status(403).json({ success: false, error: 'Ticket tải tệp không khớp với tệp yêu cầu.' });
  }

  try {
    // CHẶN IDOR TUYỆT ĐỐI: Chỉ chủ sở hữu (user_id) mới được tải file của mình
    const result = await db.query(
      `SELECT * FROM public.agent_output_files 
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy tệp hoặc bạn không có quyền truy cập tệp này.'
      });
    }

    const fileRecord = result.rows[0];

    // Kiểm tra thời hạn lưu trữ (7 ngày)
    const now = new Date();
    if (new Date(fileRecord.expires_at) < now || fileRecord.status === 'EXPIRED') {
      if (fileRecord.status !== 'EXPIRED') {
        await db.query(`UPDATE public.agent_output_files SET status = 'EXPIRED' WHERE id = $1`, [id]);
      }
      return res.status(410).json({
        success: false,
        error: 'Tệp này đã hết hạn lưu trữ (chính sách lưu tối đa 7 ngày) và đã bị gỡ bỏ.'
      });
    }

    const diskPath = resolveStoragePath(fileRecord.storage_path);
    if (!diskPath || !fs.existsSync(diskPath)) {
      return res.status(404).json({
        success: false,
        error: 'Tệp vật lý không còn tồn tại trên máy chủ lưu trữ.'
      });
    }

    // Tăng lượt tải
    await db.query(`UPDATE public.agent_output_files SET download_count = download_count + 1 WHERE id = $1`, [id]);

    const stat = fs.statSync(diskPath);
    const safeEncodedName = encodeURIComponent(fileRecord.file_name);

    res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${safeEncodedName}"; filename*=UTF-8''${safeEncodedName}`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const readStream = fs.createReadStream(diskPath);
    readStream.pipe(res);
  } catch (err) {
    console.error('Lỗi tải tệp agent_output_files:', err);
    res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ khi tải tệp: ' + err.message });
  }
});

// 2. POST /api/agents/files/:id/ticket - Tạo ticket tải ngắn hạn 5 phút cho thẻ <a> hoặc window.open
router.post('/:id/ticket', verifyToken, async (req, res) => {
  const { id } = req.params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, error: 'Định dạng ID tệp không hợp lệ.' });
  }

  try {
    const result = await db.query(
      `SELECT id, file_name, status, expires_at FROM public.agent_output_files 
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tệp hoặc bạn không có quyền sở hữu.' });
    }

    const file = result.rows[0];
    if (new Date(file.expires_at) < new Date() || file.status === 'EXPIRED') {
      return res.status(410).json({ success: false, error: 'Tệp đã hết hạn lưu trữ.' });
    }

    const ticket = jwt.sign(
      { userId: req.user.user_id, fileId: file.id, purpose: 'AGENT_FILE_DOWNLOAD' },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    res.json({
      success: true,
      ticket,
      downloadUrl: `/api/agents/files/${file.id}/download?ticket=${ticket}`,
      expiresInSeconds: 300
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. GET /api/agents/files/my-files - Danh sách file kết quả cá nhân
router.get('/my-files', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, conversation_id, agent_id, file_name, file_size, mime_type, status, download_count, created_at, expires_at
       FROM public.agent_output_files
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.user_id]
    );

    res.json({ success: true, files: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
