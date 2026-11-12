const db = require('../db');

/**
 * Thư viện ghi log và quản lý tin nhắn hội thoại thống nhất SOTRANS Hub.
 * Đồng bộ bền vững vào bảng chat_log (NocoDB) và ai_messages (Fast UI).
 */

// Bộ nhớ đệm ngắn hạn chống gửi lặp (De-duplication cache trong 3 giây)
const dedupCache = new Map();

function getDedupKey(conversationId, role, content) {
  const sample = (content || '').trim().slice(0, 100);
  return `${conversationId}_${role}_${sample}`;
}

function cleanDedupCache() {
  const now = Date.now();
  for (const [key, timestamp] of dedupCache.entries()) {
    if (now - timestamp > 10000) {
      dedupCache.delete(key);
    }
  }
}
setInterval(cleanDedupCache, 15000).unref();

/**
 * Ghi một tin nhắn vào chat_log (NocoDB) với cơ chế Retry & Idempotency.
 */
async function logMessageToChatLog({
  conversationId,
  userId,
  username,
  companyId,
  agentId,
  role = 'user',
  content = '',
  metadata = {},
  timestamp = null,
  maxRetries = 2
}) {
  if (!conversationId) {
    throw new Error('conversationId là bắt buộc để ghi chat_log');
  }

  const normalizedContent = (content || '').trim();
  const dedupKey = getDedupKey(conversationId, role, normalizedContent);
  const now = Date.now();

  // Kiểm tra chống gửi lặp trong vòng 2.5 giây
  if (dedupCache.has(dedupKey) && (now - dedupCache.get(dedupKey) < 2500)) {
    console.warn(`[ConversationLogger] Phát hiện gửi lặp cho conversation ${conversationId}, bỏ qua ghi trùng.`);
    // Trả về bản ghi gần nhất nếu có
    const existing = await db.query(
      `SELECT id, seq, at FROM chat_log WHERE conversation_id = $1 AND role = $2 ORDER BY id DESC LIMIT 1`,
      [conversationId, role]
    );
    if (existing.rows.length) {
      return { success: true, id: existing.rows[0].id, seq: existing.rows[0].seq, deduplicated: true };
    }
  }
  dedupCache.set(dedupKey, now);

  const cleanRole = (role || 'user').toLowerCase();
  const questionText = cleanRole === 'user' ? normalizedContent : null;
  const replyText = cleanRole === 'assistant' ? normalizedContent : null;

  let attempt = 0;
  let lastError = null;

  while (attempt <= maxRetries) {
    try {
      // 1. Xác định số thứ tự (seq) của tin nhắn trong cuộc trò chuyện
      const seqRes = await db.query(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM chat_log WHERE conversation_id = $1`,
        [conversationId]
      );
      const nextSeq = parseInt(seqRes.rows[0]?.next_seq || 1, 10);

      // 2. Ghi bền vững vào chat_log (bảng NocoDB)
      const bestSim = (metadata && typeof metadata.best_sim === 'number') ? metadata.best_sim : null;
      const rawDocVersions = (metadata && Array.isArray(metadata.doc_versions)) ? metadata.doc_versions : null;
      const docVersions = rawDocVersions && rawDocVersions.length ? rawDocVersions : null;
      const answerable = (metadata && typeof metadata.answerable === 'boolean') ? metadata.answerable : null;

      const insertSql = `
        INSERT INTO chat_log (
          at, mode, question, reply, content, role,
          conversation_id, user_id, username, company_id, agent_id,
          seq, metadata, best_sim, doc_versions, answerable
        ) VALUES (
          COALESCE($1, NOW()), 'chat', $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15
        ) RETURNING id, at, seq
      `;

      const insertParams = [
        timestamp || new Date(),
        questionText,
        replyText,
        normalizedContent,
        cleanRole,
        conversationId,
        userId || 'system',
        username || userId || 'system',
        companyId || 'SOTRANS',
        agentId || 'general',
        nextSeq,
        JSON.stringify(metadata || {}),
        bestSim,
        docVersions,
        answerable
      ];

      const res = await db.query(insertSql, insertParams);
      if (!res.rows || res.rows.length === 0) {
        throw new Error('Ghi chat_log thất bại, không có bản ghi trả về.');
      }

      // Tự động kích hoạt đồng bộ file hội thoại duy nhất
      try {
        const { queueConversationFileSync } = require('./conversationFileManager');
        queueConversationFileSync(conversationId);
      } catch (syncErr) {
        console.warn('[ConversationLogger] Cảnh báo kích hoạt đồng bộ file:', syncErr.message);
      }

      return {
        success: true,
        id: res.rows[0].id,
        at: res.rows[0].at,
        seq: res.rows[0].seq,
        deduplicated: false
      };
    } catch (err) {
      lastError = err;
      attempt++;
      console.warn(`[ConversationLogger] Lỗi ghi chat_log (lần thử ${attempt}/${maxRetries}):`, err.message);
      if (attempt <= maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 150 * attempt));
      }
    }
  }

  console.error('[ConversationLogger] KHÔNG THỂ GHI BỀN VỮNG VÀO CHAT_LOG sau các lần thử:', lastError.message);
  throw new Error('Lỗi lưu trữ hội thoại NocoDB/Postgres: ' + lastError.message);
}

module.exports = {
  logMessageToChatLog,
  getDedupKey
};
