const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { verifyToken, hasPermission } = require('../middleware/auth');
const { logMessageToChatLog } = require('../services/conversationLogger');
const { syncConversationFile, getConversationFile } = require('../services/conversationFileManager');

const EXPORTS_DIR = path.join(__dirname, '..', 'exports');
if (!fs.existsSync(EXPORTS_DIR)) {
  try { fs.mkdirSync(EXPORTS_DIR, { recursive: true }); } catch (e) {}
}

// BẮT BUỘC: Toàn bộ API quản lý hội thoại yêu cầu xác thực JWT hợp lệ từ server.
// TUYỆT ĐỐI KHÔNG chấp nhận x-user-id, x-remote-user hay fallback default_user.
router.use(verifyToken);

// 1. GET /api/conversations?agent_id=...&search=...
router.get('/', async (req, res) => {
  const agentId = req.query.agent_id || 'general';
  const search = (req.query.search || '').trim();

  try {
    let query = `
      SELECT c.id, c.user_id, c.agent_id, c.title, c.created_at, c.updated_at, c.status,
             COUNT(m.id)::int as message_count,
             (SELECT m2.content FROM ai_messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC LIMIT 1) as last_message
      FROM ai_conversations c
      LEFT JOIN ai_messages m ON m.conversation_id = c.id
      WHERE (c.user_id = $1 OR c.user_id = $2) AND c.agent_id = $3 AND c.status = 'ACTIVE'
    `;
    const params = [req.user.user_id, req.user.username, agentId];

    if (search) {
      query += ` AND c.title ILIKE $4`;
      params.push(`%${search}%`);
    }

    query += ` GROUP BY c.id ORDER BY c.updated_at DESC`;

    const result = await db.query(query, params);
    res.json({ success: true, conversations: result.rows });
  } catch (err) {
    console.error('Error fetching conversations:', err.message);
    res.status(500).json({ success: false, error: 'Lỗi máy chủ khi tải danh sách hội thoại.' });
  }
});

// 2. POST /api/conversations
router.post('/', async (req, res) => {
  const agentId = req.body.agent_id || 'general';
  const title = (req.body.title || 'Cuộc trò chuyện mới').trim().normalize('NFC').slice(0, 255);

  // Kiểm tra phân quyền truy cập theo loại chatbot
  if (agentId === 'hoso') {
    const canSelf = await hasPermission(req.user.role, 'hr.chatbot.query_self');
    const canAll = await hasPermission(req.user.role, 'hr.chatbot.query_all');
    if (!canSelf && !canAll) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Tài khoản không có quyền truy cập Chatbot Hồ sơ Nhân sự.' });
    }
  }

  if (agentId === 'policy' && req.user.role === 'USER') {
    return res.status(403).json({ success: false, error: '403 Forbidden: Tra cứu Quy định & Chính sách chỉ dành cho Nhân viên hoặc Quản trị viên.' });
  }

  // Nếu là Agent cá nhân, kiểm tra quyền sở hữu agent đó
  if (!['general', 'hoso', 'policy'].includes(agentId)) {
    const rawAgentId = String(agentId).replace(/^custom_/, '');
    const isUuid = /^[0-9a-f-]{36}$/i.test(rawAgentId);
    if (isUuid) {
      const agentCheck = await db.query(
        `SELECT id FROM user_agents WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [rawAgentId, req.user.user_id]
      );
      if (agentCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy Agent cá nhân hoặc bạn không có quyền truy cập.' });
      }
    }
  }

  try {
    const result = await db.query(
      `INSERT INTO ai_conversations (user_id, agent_id, title)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, agent_id, title, created_at, updated_at, status`,
      [req.user.user_id, agentId, title]
    );
    const conv = result.rows[0];

    // Khởi tạo file hội thoại và metadata NocoDB ngay khi tạo cuộc trò chuyện (Requirement 5)
    try {
      await syncConversationFile(conv.id);
    } catch (fErr) {
      console.warn('[Conversations] Cảnh báo tạo file ban đầu:', fErr.message);
    }

    res.status(201).json({ success: true, conversation: conv });
  } catch (err) {
    console.error('Error creating conversation:', err.message);
    res.status(500).json({ success: false, error: 'Lỗi tạo cuộc trò chuyện: ' + err.message });
  }
});

// 3. GET /api/conversations/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM ai_conversations WHERE id = $1 AND (user_id = $2 OR user_id = $3) AND status = 'ACTIVE'`,
      [id, req.user.user_id, req.user.username]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy cuộc trò chuyện hoặc bạn không có quyền truy cập.' });
    }
    res.json({ success: true, conversation: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. PATCH & PUT /api/conversations/:id (Rename)
const handleRename = async (req, res) => {
  const { id } = req.params;
  const title = (req.body.title || '').trim().slice(0, 255);
  if (!title) {
    return res.status(400).json({ success: false, error: 'Tiêu đề không được để trống.' });
  }

  try {
    const result = await db.query(
      `UPDATE ai_conversations
       SET title = $1, updated_at = NOW()
       WHERE id = $2 AND (user_id = $3 OR user_id = $4) AND status = 'ACTIVE'
       RETURNING id, user_id, agent_id, title, created_at, updated_at`,
      [title, id, req.user.user_id, req.user.username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy cuộc trò chuyện để đổi tên.' });
    }

    // Cập nhật lại tiêu đề trong file hội thoại và NocoDB (Requirement 6)
    try {
      await syncConversationFile(id);
    } catch (fErr) {
      console.warn('[Conversations] Cảnh báo đồng bộ file khi đổi tên:', fErr.message);
    }

    res.json({ success: true, conversation: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
router.patch('/:id', handleRename);
router.put('/:id', handleRename);

// 5. DELETE /api/conversations/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM ai_conversations WHERE id = $1 AND (user_id = $2 OR user_id = $3) RETURNING id`,
      [id, req.user.user_id, req.user.username]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy cuộc trò chuyện để xóa.' });
    }

    // Đồng bộ dọn dẹp các bản ghi liên quan trong chat_log và cập nhật chat_conversation_files
    try {
      await db.query(`DELETE FROM chat_log WHERE conversation_id = $1`, [id]);
      await db.query(`UPDATE chat_conversation_files SET sync_status = 'deleted', updated_at = NOW() WHERE conversation_id = $1`, [id]);
    } catch (e) {
      console.warn('Lỗi dọn dẹp chat_log/files khi xóa hội thoại:', e.message);
    }

    res.json({ success: true, message: 'Đã xóa cuộc trò chuyện thành công.', deletedId: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. GET /api/conversations/:id/messages
router.get('/:id/messages', async (req, res) => {
  const { id } = req.params;
  try {
    // Verify ownership
    const convCheck = await db.query(
      `SELECT id FROM ai_conversations WHERE id = $1 AND (user_id = $2 OR user_id = $3) AND status = 'ACTIVE'`,
      [id, req.user.user_id, req.user.username]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Cuộc trò chuyện không tồn tại hoặc không thuộc quyền truy cập.' });
    }

    let messages = await db.query(
      `SELECT id, conversation_id, role, content, metadata, created_at
       FROM ai_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    // Fallback phục hồi từ chat_log nếu ai_messages rỗng (Requirement 3 & 7)
    if (messages.rows.length === 0) {
      const fallback = await db.query(
        `SELECT id::text, conversation_id, role, COALESCE(content, question, reply, '') as content, metadata, at as created_at
         FROM chat_log
         WHERE conversation_id = $1
         ORDER BY seq ASC, at ASC`,
        [id]
      );
      if (fallback.rows.length > 0) {
        messages = fallback;
      }
    }

    res.json({ success: true, messages: messages.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. POST /api/conversations/:id/messages
router.post('/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { role, content, metadata } = req.body;

  if (!content && !metadata) {
    return res.status(400).json({ success: false, error: 'Nội dung tin nhắn không được để trống.' });
  }

  try {
    // Verify ownership
    const convCheck = await db.query(
      `SELECT id, title, agent_id FROM ai_conversations WHERE id = $1 AND (user_id = $2 OR user_id = $3) AND status = 'ACTIVE'`,
      [id, req.user.user_id, req.user.username]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Cuộc trò chuyện không tồn tại hoặc không thuộc quyền truy cập.' });
    }

    const conv = convCheck.rows[0];

    const result = await db.query(
      `INSERT INTO ai_messages (conversation_id, role, content, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING id, conversation_id, role, content, metadata, created_at`,
      [id, role || 'user', content || '', JSON.stringify(metadata || {})]
    );

    // Ghi bền vững vào chat_log (NocoDB) - Yêu cầu bắt buộc 2, 3, 7
    try {
      await logMessageToChatLog({
        conversationId: id,
        userId: req.user.user_id,
        username: req.user.username,
        companyId: req.user.company_id || 'SOTRANS',
        agentId: conv.agent_id || 'general',
        role: role || 'user',
        content: content || '',
        metadata: metadata || {},
        timestamp: result.rows[0].created_at
      });
    } catch (logErr) {
      console.error('[Conversations] Không thể ghi bền vững vào chat_log:', logErr.message);
      return res.status(500).json({ success: false, error: 'Lỗi ghi bền vững dữ liệu hội thoại NocoDB: ' + logErr.message });
    }

    // Update conversation updated_at & auto title if first user message
    let updateTitleSql = `UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1`;
    const updateParams = [id];

    if (role === 'user' && conv.title === 'Cuộc trò chuyện mới' && content) {
      const autoTitle = content.trim().slice(0, 40);
      updateTitleSql = `UPDATE ai_conversations SET title = $2, updated_at = NOW() WHERE id = $1`;
      updateParams.push(autoTitle);
    }

    await db.query(updateTitleSql, updateParams);

    // Đồng bộ trực tiếp file hội thoại duy nhất cho cuộc trò chuyện này (Requirement 1, 5)
    try {
      await syncConversationFile(id);
    } catch (fErr) {
      console.warn('[Conversations] Cảnh báo đồng bộ file hội thoại:', fErr.message);
    }

    res.status(201).json({ success: true, message: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7b. PUT /api/conversations/:id/messages/:messageId (Regenerate / update message with version history preservation)
router.put('/:id/messages/:messageId', async (req, res) => {
  const { id, messageId } = req.params;
  const { content, metadata } = req.body || {};

  try {
    const convCheck = await db.query(
      `SELECT id, agent_id FROM ai_conversations WHERE id = $1 AND (user_id = $2 OR user_id = $3) AND status = 'ACTIVE'`,
      [id, req.user.user_id, req.user.username]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Cuộc trò chuyện không tồn tại hoặc bạn không có quyền truy cập.' });
    }

    const msgCheck = await db.query(
      `SELECT id, content, metadata, created_at FROM ai_messages WHERE id = $1 AND conversation_id = $2`,
      [messageId, id]
    );
    if (msgCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tin nhắn cần cập nhật.' });
    }

    if (content !== undefined && (typeof content !== 'string' || content.trim().length === 0)) {
      return res.status(400).json({ success: false, error: 'Nội dung phản hồi không được để trống khi cập nhật.' });
    }

    const oldMsg = msgCheck.rows[0];
    const prevMeta = oldMsg.metadata || {};
    const versions = Array.isArray(prevMeta.versions) ? [...prevMeta.versions] : [];
    if (versions.length === 0) {
      versions.push({
        version: 1,
        content: oldMsg.content,
        model: prevMeta.model,
        sources: prevMeta.sources || [],
        artifacts: prevMeta.artifacts || [],
        created_at: oldMsg.created_at
      });
    }

    const newVersionNum = versions.length + 1;
    const newContent = content !== undefined ? content : oldMsg.content;
    versions.push({
      version: newVersionNum,
      content: newContent,
      model: metadata?.model || prevMeta.model,
      sources: metadata?.sources || [],
      artifacts: metadata?.artifacts || [],
      created_at: new Date().toISOString()
    });

    const updatedMeta = {
      ...prevMeta,
      ...(metadata || {}),
      active_version: newVersionNum,
      versions: versions,
      regenerated_at: new Date().toISOString()
    };

    const updateRes = await db.query(
      `UPDATE ai_messages
       SET content = $1, metadata = $2, created_at = NOW()
       WHERE id = $3 AND conversation_id = $4
       RETURNING id, conversation_id, role, content, metadata, created_at`,
      [newContent, JSON.stringify(updatedMeta), messageId, id]
    );

    try {
      await syncConversationFile(id);
    } catch (e) {}

    return res.json({ success: true, message: updateRes.rows[0], versions, active_version: newVersionNum });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 7c. PATCH /api/conversations/:id/messages/:messageId/version (Switch active version)
router.patch('/:id/messages/:messageId/version', async (req, res) => {
  const { id, messageId } = req.params;
  const { version } = req.body || {};

  try {
    const convCheck = await db.query(
      `SELECT id FROM ai_conversations WHERE id = $1 AND (user_id = $2 OR user_id = $3) AND status = 'ACTIVE'`,
      [id, req.user.user_id, req.user.username]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Cuộc trò chuyện không tồn tại.' });
    }

    const msgCheck = await db.query(
      `SELECT id, content, metadata FROM ai_messages WHERE id = $1 AND conversation_id = $2`,
      [messageId, id]
    );
    if (msgCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tin nhắn.' });
    }

    const msg = msgCheck.rows[0];
    const meta = msg.metadata || {};
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const targetVer = parseInt(version, 10);

    if (isNaN(targetVer) || targetVer < 1 || targetVer > versions.length) {
      return res.status(400).json({ success: false, error: 'Phiên bản chỉ định không hợp lệ.' });
    }

    const selected = versions[targetVer - 1];
    const updatedMeta = { ...meta, active_version: targetVer };
    await db.query(
      `UPDATE ai_messages SET content = $1, metadata = $2 WHERE id = $3 AND conversation_id = $4`,
      [selected.content, JSON.stringify(updatedMeta), messageId, id]
    );

    return res.json({ success: true, active_version: targetVer, content: selected.content });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 8. GET /api/conversations/:id/export?format=markdown|json (Requirement 5 & 6)
router.get('/:id/export', async (req, res) => {
  const { id } = req.params;
  const format = (req.query.format || 'markdown').toLowerCase();

  try {
    const convCheck = await db.query(
      `SELECT c.id, c.user_id, c.agent_id, c.title, c.created_at, c.updated_at, c.metadata,
              u.username, u.company_id, u.role as user_role
       FROM ai_conversations c
       LEFT JOIN users u ON (u.user_id::text = c.user_id OR u.username = c.user_id)
       WHERE c.id = $1 AND c.status = 'ACTIVE'`,
      [id]
    );

    if (convCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy cuộc trò chuyện để xuất dữ liệu.' });
    }

    const conv = convCheck.rows[0];

    // Kiểm tra quyền sở hữu / phân quyền công ty (Requirement 6)
    const isOwner = conv.user_id === req.user.user_id || conv.user_id === req.user.username;
    const isAdmin = req.user.role === 'ADMIN';
    const isSameCompany = !conv.company_id || conv.company_id === req.user.company_id || req.user.company_id === 'ALL';

    if (!isOwner && !(isAdmin && isSameCompany)) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền truy cập hoặc xuất cuộc trò chuyện này.' });
    }

    // Lấy toàn bộ danh sách tin nhắn có thứ tự
    let msgRes = await db.query(
      `SELECT id, role, content, metadata, created_at,
              ROW_NUMBER() OVER(ORDER BY created_at ASC) as seq
       FROM ai_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    let messages = msgRes.rows;
    if (messages.length === 0) {
      const clRes = await db.query(
        `SELECT id::text, role, COALESCE(content, question, reply, '') as content, metadata, at as created_at, seq
         FROM chat_log
         WHERE conversation_id = $1
         ORDER BY seq ASC, at ASC`,
        [id]
      );
      messages = clRes.rows;
    }

    // Tên tệp an toàn (ASCII slug cho HTTP header filename, và UTF-8 cho filename*)
    const safeTitle = (conv.title || 'hoi_thoai')
      .replace(/[\/\\?%*:|"<>]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 50);
    const asciiTitle = (conv.title || 'hoi_thoai')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40) || 'hoi_thoai';
    const dateStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const asciiFileName = `sotrans_${asciiTitle}_${dateStamp}.${format === 'json' ? 'json' : 'md'}`;
    const utf8FileName = `sotrans_${safeTitle}_${dateStamp}.${format === 'json' ? 'json' : 'md'}`;

    if (format === 'json') {
      const exportData = {
        system: 'SOTRANS Hub - Unified AI Workspace',
        version: '2.0',
        exported_at: new Date().toISOString(),
        conversation: {
          id: conv.id,
          title: conv.title,
          agent_id: conv.agent_id,
          user_id: conv.user_id,
          username: conv.username || req.user.username,
          company_id: conv.company_id || req.user.company_id || 'SOTRANS',
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          total_messages: messages.length
        },
        messages: messages.map(m => ({
          seq: parseInt(m.seq || 1, 10),
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          metadata: m.metadata || {}
        }))
      };

      const fileContent = JSON.stringify(exportData, null, 2);
      const filePath = path.join(EXPORTS_DIR, asciiFileName);

      fs.writeFileSync(filePath, fileContent, 'utf8');

      // Ghi metadata và tham chiếu tệp vào NocoDB (chat_log) và ai_conversations (Requirement 5)
      const relPath = `/exports/${asciiFileName}`;
      await db.query(`UPDATE chat_log SET export_file = $1 WHERE conversation_id = $2`, [relPath, id]);
      await db.query(
        `UPDATE ai_conversations
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{last_export}', $1::jsonb)
         WHERE id = $2`,
        [JSON.stringify({ format: 'json', file_name: utf8FileName, storage_path: relPath, exported_at: new Date().toISOString(), size: Buffer.byteLength(fileContent, 'utf8') }), id]
      );

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(utf8FileName)}`);
      return res.send(fileContent);
    } else {
      // Mặc định xuất Markdown (.md)
      const lines = [
        `# SOTRANS HUB — BẢN XUẤT HỘI THOẠI AI`,
        `> Hệ thống SOTRANS Hub • AI & Quản trị Tập trung • Xuất tự động định dạng Markdown UTF-8`,
        ``,
        `| Thông tin | Chi tiết |`,
        `| :--- | :--- |`,
        `| **Tiêu đề hội thoại** | ${conv.title} |`,
        `| **Mã cuộc trò chuyện (ID)** | \`${conv.id}\` |`,
        `| **Loại Chatbot / Agent** | \`${conv.agent_id}\` |`,
        `| **Người dùng thực hiện** | **${conv.username || req.user.username}** (\`${conv.user_id}\`) |`,
        `| **Đơn vị / Công ty** | ${conv.company_id || req.user.company_id || 'SOTRANS'} |`,
        `| **Thời gian khởi tạo** | ${new Date(conv.created_at).toLocaleString('vi-VN')} |`,
        `| **Thời gian xuất dữ liệu** | ${new Date().toLocaleString('vi-VN')} |`,
        `| **Tổng số lượt tin nhắn** | ${messages.length} |`,
        ``,
        `---`,
        ``
      ];

      for (const m of messages) {
        const isUser = m.role === 'user';
        const timeStr = m.created_at ? new Date(m.created_at).toLocaleString('vi-VN') : '—';
        const speaker = isUser ? `👤 Người dùng (${conv.username || 'User'})` : `🤖 Trợ lý AI (${conv.agent_id})`;

        lines.push(`### ${speaker} — *${timeStr}*`);
        lines.push(``);
        lines.push(m.content || '*(Không có nội dung văn bản)*');
        lines.push(``);

        // Hiển thị tệp đính kèm nếu có
        if (m.metadata && Array.isArray(m.metadata.files) && m.metadata.files.length) {
          lines.push(`📎 **Tệp đính kèm:** ` + m.metadata.files.map(f => `\`${f.name}\` (${f.size ? Math.round(f.size / 1024) + ' KB' : ''})`).join(', '));
          lines.push(``);
        }

        // Hiển thị nguồn trích dẫn nếu có
        if (m.metadata && Array.isArray(m.metadata.sources) && m.metadata.sources.length) {
          lines.push(`📚 **Căn cứ văn bản trích dẫn:**`);
          for (const s of m.metadata.sources) {
            const docNum = s.doc_number ? `[${s.doc_number}] ` : '';
            const title = s.title || s.name || 'Văn bản quy định';
            const ver = s.version ? ` (v${s.version})` : '';
            lines.push(`- ${docNum}${title}${ver}`);
          }
          lines.push(``);
        }

        // Hiển thị bảng biểu nếu có
        if (m.metadata && m.metadata.table && Array.isArray(m.metadata.table.columns) && Array.isArray(m.metadata.table.rows)) {
          const t = m.metadata.table;
          lines.push(`📊 **Bảng dữ liệu trích xuất:**`);
          lines.push(`| ` + t.columns.join(' | ') + ` |`);
          lines.push(`| ` + t.columns.map(() => ':---').join(' | ') + ` |`);
          for (const r of t.rows) {
            lines.push(`| ` + r.map(c => String(c ?? '').replace(/\|/g, '\\|')).join(' | ') + ` |`);
          }
          lines.push(``);
        }

        lines.push(`---`);
        lines.push(``);
      }

      // Đặt tiền tố UTF-8 BOM (\uFEFF) đảm bảo mở trên Windows Notepad / Word / VS Code không bao giờ bị vỡ font
      const fileContent = '\uFEFF' + lines.join('\n');
      const filePath = path.join(EXPORTS_DIR, asciiFileName);

      fs.writeFileSync(filePath, fileContent, 'utf8');

      // Ghi metadata và tham chiếu tệp vào NocoDB (chat_log) và ai_conversations
      const relPath = `/exports/${asciiFileName}`;
      await db.query(`UPDATE chat_log SET export_file = $1 WHERE conversation_id = $2`, [relPath, id]);
      await db.query(
        `UPDATE ai_conversations
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{last_export}', $1::jsonb)
         WHERE id = $2`,
        [JSON.stringify({ format: 'markdown', file_name: utf8FileName, storage_path: relPath, exported_at: new Date().toISOString(), size: Buffer.byteLength(fileContent, 'utf8') }), id]
      );

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(utf8FileName)}`);
      return res.send(fileContent);
    }
  } catch (err) {
    console.error('Lỗi khi xuất cuộc hội thoại:', err);
    res.status(500).json({ success: false, error: 'Lỗi máy chủ khi xuất cuộc trò chuyện: ' + err.message });
  }
});

// 9. GET /api/conversations/:id/file (Tải / Đọc file hội thoại duy nhất trên NocoDB - Requirement 1, 3, 4, 7)
router.get('/:id/file', async (req, res) => {
  const { id } = req.params;
  try {
    const fileData = await getConversationFile(id, req.user);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileData.fileName}"`);
    return res.send(fileData.content);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

// 10. GET /api/conversations/:id/file/metadata (Lấy metadata từ chat_conversation_files trên NocoDB - Requirement 4)
router.get('/:id/file/metadata', async (req, res) => {
  const { id } = req.params;
  try {
    const convCheck = await db.query(
      `SELECT c.id, c.user_id, u.company_id 
       FROM ai_conversations c
       LEFT JOIN users u ON (u.user_id::text = c.user_id OR u.username = c.user_id)
       WHERE c.id = $1`,
      [id]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy cuộc trò chuyện' });
    }
    const conv = convCheck.rows[0];
    const isOwner = conv.user_id === req.user.user_id || conv.user_id === req.user.username;
    const isAdmin = req.user.role === 'ADMIN';
    const isSameCompany = !conv.company_id || conv.company_id === req.user.company_id || req.user.company_id === 'ALL';
    if (!isOwner && !(isAdmin && isSameCompany)) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Không có quyền truy cập.' });
    }

    let metaRes = await db.query(
      `SELECT * FROM chat_conversation_files WHERE conversation_id = $1`,
      [id]
    );
    if (metaRes.rows.length === 0) {
      const syncRes = await syncConversationFile(id);
      return res.json({ success: true, metadata: syncRes.fileRecord });
    }
    return res.json({ success: true, metadata: metaRes.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 11. POST /api/conversations/:id/file/sync (Thao tác đồng bộ file thủ công hoặc thử lại khi lỗi - Requirement 5)
router.post('/:id/file/sync', async (req, res) => {
  const { id } = req.params;
  try {
    const convCheck = await db.query(
      `SELECT c.id, c.user_id, u.company_id 
       FROM ai_conversations c
       LEFT JOIN users u ON (u.user_id::text = c.user_id OR u.username = c.user_id)
       WHERE c.id = $1`,
      [id]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy cuộc trò chuyện' });
    }
    const conv = convCheck.rows[0];
    const isOwner = conv.user_id === req.user.user_id || conv.user_id === req.user.username;
    const isAdmin = req.user.role === 'ADMIN';
    const isSameCompany = !conv.company_id || conv.company_id === req.user.company_id || req.user.company_id === 'ALL';
    if (!isOwner && !(isAdmin && isSameCompany)) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Không có quyền thao tác.' });
    }

    const syncRes = await syncConversationFile(id);
    return res.json({ success: true, fileRecord: syncRes.fileRecord, fileSize: syncRes.fileSize, messageCount: syncRes.messageCount });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
