const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

/**
 * Dịch vụ Quản lý File Hội thoại Tập trung SOTRANS Hub.
 * Nguyên tắc: Mỗi cuộc trò chuyện trong Sidebar tương ứng với 1 file Markdown (.md) duy nhất trên ổ đĩa và NocoDB.
 * Khi có tin nhắn mới hoặc đổi tiêu đề, cập nhật file hiện tại, không tạo file trùng lặp.
 */

const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'conversations');
if (!fs.existsSync(STORAGE_DIR)) {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  } catch (err) {
    console.error('[ConversationFileManager] Không thể tạo thư mục lưu trữ:', err.message);
  }
}

// Queue quản lý đồng bộ tránh xung đột ghi tệp đồng thời (Per-conversation Lock & Debounce)
const syncTimers = new Map();
const activeSyncPromises = new Map();

/**
 * Xếp hàng đồng bộ file với độ trễ (debounce), gom các lượt tin nhắn nhanh.
 */
function queueConversationFileSync(conversationId, delayMs = 300) {
  if (!conversationId) return;

  if (syncTimers.has(conversationId)) {
    clearTimeout(syncTimers.get(conversationId));
  }

  const timer = setTimeout(async () => {
    syncTimers.delete(conversationId);
    try {
      await syncConversationFile(conversationId);
    } catch (err) {
      console.error(`[ConversationFileManager] Lỗi đồng bộ nền cho ${conversationId}:`, err.message);
    }
  }, delayMs);

  syncTimers.set(conversationId, timer);
}

/**
 * Tạo nội dung Markdown UTF-8 hoàn chỉnh cho cuộc hội thoại.
 */
function buildConversationMarkdown({ conv, messages, contentHash = '' }) {
  const isCustomAgent = conv.agent_id && conv.agent_id.startsWith('custom_');
  const agentLabel = isCustomAgent ? `Trợ lý AI Cá nhân (${conv.agent_id})` : (conv.agent_id || 'General AI');

  const lines = [
    `# SOTRANS HUB — HỒ SƠ HỘI THOẠI AI`,
    `> Hệ thống Quản trị & Trợ lý AI Tập trung SOTRANS Hub • File lưu trữ đồng bộ NocoDB`,
    ``,
    `| Thuộc tính | Chi tiết |`,
    `| :--- | :--- |`,
    `| **Mã cuộc hội thoại (ID)** | \`${conv.id}\` |`,
    `| **Tiêu đề cuộc trò chuyện** | ${conv.title || 'Cuộc trò chuyện'} |`,
    `| **Chủ sở hữu (Owner)** | **${conv.username || conv.user_id || 'system'}** (\`${conv.user_id}\`) |`,
    `| **Đơn vị / Công ty (Scope)** | \`${conv.company_id || 'SOTRANS'}\` |`,
    `| **Loại Chatbot / Agent** | \`${conv.agent_id || 'general'}\` (${agentLabel}) |`,
    `| **Thời gian khởi tạo** | ${new Date(conv.created_at).toLocaleString('vi-VN')} |`,
    `| **Thời gian cập nhật tệp** | ${new Date().toLocaleString('vi-VN')} |`,
    `| **Tổng số tin nhắn** | **${messages.length}** |`,
    `| **Trạng thái đồng bộ** | \`SYNCED_TO_NOCODB\` |`,
    ``,
    `---`,
    ``
  ];

  if (messages.length === 0) {
    lines.push(`*(Cuộc trò chuyện chưa có tin nhắn)*`);
    lines.push(``);
  } else {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const seqNum = m.seq || (i + 1);
      const isUser = m.role === 'user';
      const timeStr = m.created_at ? new Date(m.created_at).toLocaleString('vi-VN') : '—';
      const speaker = isUser
        ? `👤 Người dùng (${conv.username || conv.user_id || 'User'})`
        : `🤖 Trợ lý AI (${conv.agent_id || 'AI Assistant'})`;

      lines.push(`### [Lượt ${seqNum}] ${speaker} — *${timeStr}*`);
      lines.push(``);
      lines.push(m.content ? m.content.trim() : '*(Không có nội dung văn bản)*');
      lines.push(``);

      // 1. Tệp đính kèm (nếu có)
      if (m.metadata && Array.isArray(m.metadata.files) && m.metadata.files.length) {
        lines.push(`📎 **Tệp đính kèm:** ` + m.metadata.files.map(f => {
          const sz = f.size ? ` (${Math.round(f.size / 1024)} KB)` : '';
          return `\`${f.name || 'file'}\`${sz}`;
        }).join(', '));
        lines.push(``);
      }

      // 2. Nguồn trích dẫn văn bản (nếu có)
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

      // 3. Bảng dữ liệu trích xuất (nếu có)
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
  }

  // Tiền tố UTF-8 BOM (\uFEFF) giúp mở trên mọi ứng dụng Windows không bao giờ lỗi font
  return '\uFEFF' + lines.join('\n');
}

/**
 * Đồng bộ toàn bộ cuộc trò chuyện thành 1 file duy nhất và cập nhật vào NocoDB.
 */
async function syncConversationFile(conversationId) {
  if (!conversationId) {
    throw new Error('conversationId là bắt buộc để đồng bộ file');
  }

  // Đảm bảo không chạy đồng thời 2 quá trình ghi đè lên cùng 1 file
  if (activeSyncPromises.has(conversationId)) {
    return activeSyncPromises.get(conversationId);
  }

  const syncPromise = (async () => {
    try {
      // 1. Lấy thông tin cuộc trò chuyện
      let convRes = await db.query(
        `SELECT c.id, c.user_id, c.agent_id, c.title, c.created_at, c.updated_at, c.status,
                u.username, u.company_id, u.role as user_role
         FROM ai_conversations c
         LEFT JOIN users u ON (u.user_id::text = c.user_id OR u.username = c.user_id)
         WHERE c.id = $1`,
        [conversationId]
      );

      let conv;
      if (convRes.rows.length > 0) {
        conv = convRes.rows[0];
      } else {
        // Fallback: Tìm từ chat_log nếu là cuộc hội thoại cũ chưa có trong ai_conversations
        const clCheck = await db.query(
          `SELECT conversation_id as id, user_id, username, company_id, agent_id,
                  MIN(at) as created_at, MAX(at) as updated_at,
                  'Cuộc trò chuyện ' || SUBSTRING(conversation_id::text FROM 1 FOR 8) as title
           FROM chat_log
           WHERE conversation_id = $1
           GROUP BY conversation_id, user_id, username, company_id, agent_id`,
          [conversationId]
        );
        if (clCheck.rows.length === 0) {
          throw new Error(`Không tìm thấy cuộc trò chuyện có ID: ${conversationId}`);
        }
        conv = clCheck.rows[0];
      }

      // 2. Lấy toàn bộ danh sách tin nhắn theo đúng thứ tự (seq)
      let msgRes = await db.query(
        `SELECT id, role, content, metadata, created_at,
                ROW_NUMBER() OVER(ORDER BY created_at ASC) as seq
         FROM ai_messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC`,
        [conversationId]
      );

      let messages = msgRes.rows;
      if (messages.length === 0) {
        // Fallback từ chat_log
        const clRes = await db.query(
          `SELECT id::text, role, COALESCE(content, question, reply, '') as content,
                  metadata, at as created_at, seq
           FROM chat_log
           WHERE conversation_id = $1
           ORDER BY seq ASC, at ASC`,
          [conversationId]
        );
        messages = clRes.rows;
      }

      // 3. Tạo nội dung Markdown UTF-8 và tính hash nội dung
      const markdownContent = buildConversationMarkdown({ conv, messages });
      const contentHash = crypto.createHash('sha256').update(markdownContent, 'utf8').digest('hex');

      // 4. Ghi nguyên tử (Atomic write qua temp file) để không bị hỏng file nếu có lỗi giữa chừng
      const fileName = `conversation_${conversationId}.md`;
      const targetPath = path.join(STORAGE_DIR, fileName);
      const tempPath = path.join(STORAGE_DIR, `.tmp_${conversationId}_${Date.now()}.md`);

      fs.writeFileSync(tempPath, markdownContent, 'utf8');
      fs.renameSync(tempPath, targetPath);

      const stats = fs.statSync(targetPath);
      const fileSize = stats.size;
      const fileRef = `/storage/conversations/${fileName}`;

      // 5. Cập nhật metadata vào NocoDB (bảng chat_conversation_files)
      const attachmentPayload = JSON.stringify([
        {
          url: `/api/conversations/${conversationId}/file`,
          title: fileName,
          mimetype: 'text/markdown; charset=utf-8',
          size: fileSize
        }
      ]);

      const upsertSql = `
        INSERT INTO chat_conversation_files (
          conversation_id, owner_user_id, company_id, chatbot_type, agent_id,
          file_name, file_format, file_reference, attachment,
          message_count, sync_status, content_hash, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, 'markdown', $7, $8::jsonb,
          $9, 'synced', $10, NOW()
        )
        ON CONFLICT (conversation_id) DO UPDATE SET
          owner_user_id = EXCLUDED.owner_user_id,
          company_id = EXCLUDED.company_id,
          chatbot_type = EXCLUDED.chatbot_type,
          agent_id = EXCLUDED.agent_id,
          file_name = EXCLUDED.file_name,
          file_reference = EXCLUDED.file_reference,
          attachment = EXCLUDED.attachment,
          message_count = EXCLUDED.message_count,
          sync_status = 'synced',
          content_hash = EXCLUDED.content_hash,
          updated_at = NOW()
        RETURNING *
      `;

      const upsertParams = [
        conversationId,
        conv.user_id || 'system',
        conv.company_id || 'SOTRANS',
        conv.agent_id || 'general',
        conv.agent_id || 'general',
        fileName,
        fileRef,
        attachmentPayload,
        messages.length,
        contentHash
      ];

      const fileRecordRes = await db.query(upsertSql, upsertParams);
      const fileRecord = fileRecordRes.rows[0];

      // 6. Ghi chú tham chiếu file vào chat_log và ai_conversations
      try {
        await db.query(`UPDATE chat_log SET export_file = $1 WHERE conversation_id = $2`, [fileRef, conversationId]);
        await db.query(
          `UPDATE ai_conversations
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{conversation_file}', $1::jsonb)
           WHERE id = $2`,
          [JSON.stringify({ file_name: fileName, file_reference: fileRef, message_count: messages.length, synced_at: new Date().toISOString() }), conversationId]
        );
      } catch (metaErr) {
        console.warn('[ConversationFileManager] Cảnh báo cập nhật metadata bổ sung:', metaErr.message);
      }

      return {
        success: true,
        fileRecord,
        filePath: targetPath,
        fileName,
        fileSize,
        messageCount: messages.length,
        contentHash
      };
    } finally {
      activeSyncPromises.delete(conversationId);
    }
  })();

  activeSyncPromises.set(conversationId, syncPromise);
  return syncPromise;
}

/**
 * Lấy file hội thoại vật lý và kiểm tra quyền truy cập theo chuẩn RBAC.
 */
async function getConversationFile(conversationId, requestingUser) {
  if (!conversationId) {
    throw new Error('conversationId là bắt buộc');
  }

  // 1. Kiểm tra quyền sở hữu cuộc trò chuyện
  const convRes = await db.query(
    `SELECT c.id, c.user_id, c.agent_id, c.title, c.status,
            u.username, u.company_id
     FROM ai_conversations c
     LEFT JOIN users u ON (u.user_id::text = c.user_id OR u.username = c.user_id)
     WHERE c.id = $1`,
    [conversationId]
  );

  if (convRes.rows.length === 0) {
    // Kiểm tra trong chat_log nếu là cuộc trò chuyện cũ
    const clCheck = await db.query(
      `SELECT DISTINCT conversation_id as id, user_id, username, company_id, agent_id
       FROM chat_log
       WHERE conversation_id = $1`,
      [conversationId]
    );
    if (clCheck.rows.length === 0) {
      const err = new Error('Không tìm thấy cuộc trò chuyện');
      err.statusCode = 404;
      throw err;
    }
    convRes.rows = [clCheck.rows[0]];
  }

  const conv = convRes.rows[0];

  // RBAC: Chỉ chủ sở hữu hoặc Quản trị viên cùng công ty mới được truy cập
  const isOwner = requestingUser && (conv.user_id === requestingUser.user_id || conv.user_id === requestingUser.username);
  const isAdmin = requestingUser && requestingUser.role === 'ADMIN';
  const isSameCompany = !conv.company_id || conv.company_id === requestingUser.company_id || (requestingUser && requestingUser.company_id === 'ALL');

  if (!isOwner && !(isAdmin && isSameCompany)) {
    const err = new Error('403 Forbidden: Bạn không có quyền truy cập file hội thoại này.');
    err.statusCode = 403;
    throw err;
  }

  const fileName = `conversation_${conversationId}.md`;
  const filePath = path.join(STORAGE_DIR, fileName);

  // Nếu file chưa tồn tại trên ổ đĩa, tiến hành đồng bộ ngay lập tức
  if (!fs.existsSync(filePath)) {
    await syncConversationFile(conversationId);
  }

  if (!fs.existsSync(filePath)) {
    const err = new Error('File hội thoại chưa sẵn sàng.');
    err.statusCode = 404;
    throw err;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const stats = fs.statSync(filePath);

  return {
    fileName,
    filePath,
    content,
    size: stats.size,
    conversation: conv
  };
}

/**
 * Chuyển đổi và tạo file cho toàn bộ các cuộc hội thoại cũ hiện có trong hệ thống (Requirement 8).
 */
async function backfillAllExistingConversations() {
  console.log('[ConversationFileManager] Bắt đầu chuyển đổi lịch sử thành các file hội thoại NocoDB...');

  // 1. Lấy tất cả conversation_id duy nhất từ ai_conversations
  const convList = await db.query(
    `SELECT id, user_id, agent_id, title, created_at, updated_at
     FROM ai_conversations
     WHERE status = 'ACTIVE'
     ORDER BY updated_at DESC`
  );

  console.log(`[ConversationFileManager] Tìm thấy ${convList.rows.length} cuộc trò chuyện trong ai_conversations.`);

  let successCount = 0;
  let errorCount = 0;
  let totalMessagesProcessed = 0;

  for (const conv of convList.rows) {
    try {
      const res = await syncConversationFile(conv.id);
      successCount++;
      totalMessagesProcessed += res.messageCount;
    } catch (err) {
      errorCount++;
      console.warn(`[ConversationFileManager] Lỗi chuyển đổi hội thoại ${conv.id}:`, err.message);
    }
  }

  // 2. Kiểm tra các bản ghi trong chat_log không có conversation_id
  const orphanedRes = await db.query(
    `SELECT count(*) as orphaned_count FROM chat_log WHERE conversation_id IS NULL`
  );
  const orphanedCount = parseInt(orphanedRes.rows[0]?.orphaned_count || 0, 10);

  // 3. Đếm tổng số bản ghi trong chat_conversation_files
  const filesCountRes = await db.query(
    `SELECT count(*) as total_files, sum(message_count) as total_synced_messages FROM chat_conversation_files`
  );

  const report = {
    totalConversationsFound: convList.rows.length,
    filesSuccessfullyCreated: successCount,
    filesFailed: errorCount,
    totalMessagesProcessed,
    orphanedRecordsInChatLog: orphanedCount,
    nocoDbFilesTableSummary: filesCountRes.rows[0]
  };

  console.log('[ConversationFileManager] Hoàn tất chuyển đổi:', report);
  return report;
}

module.exports = {
  syncConversationFile,
  queueConversationFileSync,
  getConversationFile,
  backfillAllExistingConversations,
  STORAGE_DIR
};
