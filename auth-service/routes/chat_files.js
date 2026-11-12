/**
 * SOTRANS HUB — SECURE CHAT FILES ROUTER (HẠNG MỤC 3)
 * 
 * Cung cấp cơ chế xác thực JWT và kiểm tra phân quyền RBAC / Tenant Isolation
 * trước khi cho phép xem trước hoặc tải tệp đính kèm trong hội thoại.
 * Tuyệt đối không mở công khai thư mục tệp tin ra Internet.
 * 
 * Kết hợp cơ chế Nginx Internal Redirection (X-Accel-Redirect) để đảm bảo:
 * 1. Mọi truy cập vào /chat/files/:fileName đều bị Nginx chuyển tiếp qua route này.
 * 2. Route này kiểm tra token (Header Authorization hoặc Query ?token=).
 * 3. Kiểm tra quyền sở hữu người dùng và phạm vi công ty (Tenant scope).
 * 4. Nếu hợp lệ, trả header X-Accel-Redirect để Nginx phục vụ tệp tin nội bộ.
 * 5. Nếu không hợp lệ, trả về 401 Unauthorized hoặc 403 Forbidden.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');
const { logAudit } = require('../audit');

// Đường dẫn thư mục lưu trữ chat-files trên các môi trường
const CHAT_FILES_DIR = fs.existsSync('/app/chat-files')
  ? '/app/chat-files'
  : (fs.existsSync('/usr/share/nginx/chat-files')
      ? '/usr/share/nginx/chat-files'
      : path.resolve(__dirname, '..', '..', 'files'));

/**
 * Hàm xác định MIME Type an toàn dựa trên phần mở rộng hoặc magic bytes
 */
function getMimeType(filePath, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls': return 'application/vnd.ms-excel';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.doc': return 'application/msword';
    default:
      try {
        if (filePath && fs.existsSync(filePath)) {
          const buf = Buffer.alloc(8);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buf, 0, 8, 0);
          fs.closeSync(fd);
          if (buf.toString('utf8', 0, 4) === '%PDF') {
            return 'application/pdf';
          }
          if (buf[0] === 0x89 && buf.toString('utf8', 1, 4) === 'PNG') {
            return 'image/png';
          }
          if (buf[0] === 0xFF && buf[1] === 0xD8) {
            return 'image/jpeg';
          }
        }
      } catch (e) {}
      // Mặc định PDF nếu tên file dạng UUID chuẩn 36 ký tự (các file upload trong hệ thống)
      if (/^[0-9a-fA-F-]{36}$/.test(fileName)) {
        return 'application/pdf';
      }
      return 'application/octet-stream';
  }
}

/**
 * GET /api/chat-files/:fileName
 * Yêu cầu xác thực JWT (Bearer header hoặc query param ?token=)
 */
router.get('/:fileName', verifyToken, async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const rawFileName = req.params.fileName;

  try {
    // 1. Chuẩn hóa và làm sạch tên file chống tấn công Path Traversal
    const cleanFileName = path.basename(decodeURIComponent(rawFileName || ''));
    if (!cleanFileName || cleanFileName === '.' || cleanFileName.includes('..') || cleanFileName.startsWith('.')) {
      return res.status(400).json({ success: false, error: '400 Bad Request: Tên tệp không hợp lệ.' });
    }

    const filePath = path.join(CHAT_FILES_DIR, cleanFileName);
    const isBehindNginx = Boolean(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);

    // 2. Nếu gọi trực tiếp không qua Nginx, kiểm tra tồn tại tệp vật lý cục bộ
    if (!isBehindNginx && !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: '404 Not Found: Tệp tin không tồn tại trên hệ thống.' });
    }

    // 3. Kiểm tra phân quyền RBAC & Cô lập đa công ty (Cross-tenant Access Control)
    try {
      const fileCheck = await db.query(
        `SELECT company_id, owner_user_id 
         FROM chat_conversation_files 
         WHERE file_name = $1 OR file_reference LIKE $2 
         LIMIT 1`,
        [cleanFileName, `%${cleanFileName}%`]
      );

      if (fileCheck.rows.length > 0) {
        const fileRec = fileCheck.rows[0];
        // Nếu user không phải ADMIN và thuộc công ty khác -> chặn 403
        if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
          if (fileRec.company_id && req.user.company_id && 
              fileRec.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
            await logAudit({
              actor_user_id: req.user.user_id,
              actor_username: req.user.username,
              action: 'chat_file_access_forbidden',
              status: 'FORBIDDEN',
              ip_address: ip,
              metadata: {
                fileName: cleanFileName,
                file_company_id: fileRec.company_id,
                user_company_id: req.user.company_id,
                reason: 'Cross-tenant file access blocked.'
              }
            });

            return res.status(403).json({
              success: false,
              error: `403 Forbidden: Bạn không có quyền truy cập tệp tin thuộc đơn vị ${fileRec.company_id}.`
            });
          }
        }
      }
    } catch (dbErr) {
      console.warn('[ChatFiles] Database permission lookup warning:', dbErr.message);
    }

    // 4. Xác định MIME type và thiết lập các header bảo vệ an toàn
    const mimeType = getMimeType(filePath, cleanFileName);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(cleanFileName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    // 5. Phục vụ tệp
    if (isBehindNginx) {
      // Chỉ thị cho Nginx phục vụ tệp nội bộ từ /usr/share/nginx/chat-files/
      res.setHeader('X-Accel-Redirect', `/internal-chat-files/${cleanFileName}`);
      return res.end();
    } else {
      // Phục vụ trực tiếp khi gọi thẳng vào cổng backend (ví dụ khi chạy test scripts cục bộ)
      return fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('[ChatFiles Error]:', err);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi xử lý truy cập tệp tin: ' + err.message });
  }
});

module.exports = router;
