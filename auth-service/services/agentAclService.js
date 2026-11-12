const db = require('../db');

/**
 * Enterprise Agent Access Control Service (ACL)
 * Phân quyền đa cấp: Owner, Editor, Viewer, Clone, Cross-company STL / VTX / SWC
 */

/**
 * Lấy bối cảnh phân quyền của người dùng đối với một Agent cụ thể
 * @param {string} agentId - UUID của Agent
 * @param {object} user - Object người dùng từ JWT ({ user_id, username, company_id, role, department })
 * @returns {Promise<object>} Thông tin quyền hạn chi tiết
 */
async function getAgentAccessContext(agentId, user) {
  if (!agentId || !user || !user.user_id) {
    return { hasAccess: false, role: null, canClone: false, canReshare: false, isOwner: false, agent: null };
  }

  // 1. Lấy thông tin Agent
  const agentRes = await db.query(
    `SELECT a.*, u.username AS owner_username, u.company_id AS owner_company_id, u.status AS owner_status
     FROM user_agents a
     LEFT JOIN users u ON a.user_id = u.user_id
     WHERE a.id = $1 AND a.status = 'active'`,
    [agentId]
  );

  if (agentRes.rows.length === 0) {
    return { hasAccess: false, role: null, canClone: false, canReshare: false, isOwner: false, agent: null, reason: 'AGENT_NOT_FOUND' };
  }

  const agent = agentRes.rows[0];

  // 2. Nếu là Owner trực tiếp
  if (String(agent.user_id) === String(user.user_id)) {
    return {
      hasAccess: true,
      role: 'OWNER',
      canEdit: true,
      canClone: true,
      canReshare: true,
      isOwner: true,
      shareId: null,
      agent
    };
  }

  // Nếu Owner của Agent bị khóa tài khoản (INACTIVE/LOCKED), chặn quyền truy cập đối với các thành viên được chia sẻ (Scenario 20)
  if (agent.owner_status && agent.owner_status !== 'ACTIVE') {
    return {
      hasAccess: false,
      role: null,
      canEdit: false,
      canClone: false,
      canReshare: false,
      isOwner: false,
      agent,
      reason: 'OWNER_ACCOUNT_LOCKED'
    };
  }

  // 3. Tra cứu quyền chia sẻ đang có hiệu lực trong bảng agent_shares
  // Áp dụng cho:
  // - Chỉ định đích danh user (USER)
  // - Công ty (COMPANY: STL, VTX, SWC)
  // - Toàn bộ nhân viên nội bộ (ALL_INTERNAL)
  // - Nhóm/Phòng ban (DEPARTMENT)
  const userComp = user.company_id || '';
  const userDept = user.department || '';

  const sharesRes = await db.query(
    `SELECT s.*
     FROM agent_shares s
     WHERE s.agent_id = $1
       AND s.status = 'ACTIVE'
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND (
         (s.share_type = 'USER' AND s.target_user_id = $2)
         OR (s.share_type = 'COMPANY' AND s.target_company_id = $3)
         OR (s.share_type = 'ALL_INTERNAL')
         OR (s.share_type = 'DEPARTMENT' AND s.target_department = $4 AND ($4 != ''))
       )
     ORDER BY 
       CASE WHEN s.permission_role = 'EDITOR' THEN 1 ELSE 2 END ASC,
       CASE WHEN s.share_type = 'USER' THEN 1 WHEN s.share_type = 'DEPARTMENT' THEN 2 WHEN s.share_type = 'COMPANY' THEN 3 ELSE 4 END ASC`,
    [agentId, user.user_id, userComp, userDept]
  );

  if (sharesRes.rows.length === 0) {
    return {
      hasAccess: false,
      role: null,
      canEdit: false,
      canClone: false,
      canReshare: false,
      isOwner: false,
      agent,
      reason: 'NO_ACTIVE_SHARE'
    };
  }

  // Lấy quyền cao nhất từ các share rules phù hợp (EDITOR > VIEWER)
  const primaryShare = sharesRes.rows[0];
  const canClone = agent.allow_cloning !== false && sharesRes.rows.some(s => s.can_clone === true);
  const canReshare = sharesRes.rows.some(s => s.can_reshare === true);
  const effectiveRole = primaryShare.permission_role; // 'EDITOR' hoặc 'VIEWER'

  return {
    hasAccess: true,
    role: effectiveRole,
    canEdit: effectiveRole === 'EDITOR',
    canClone,
    canReshare,
    isOwner: false,
    shareId: primaryShare.id,
    shareType: primaryShare.share_type,
    expiresAt: primaryShare.expires_at,
    agent
  };
}

/**
 * Lọc hoặc ẩn các thông tin bí mật cấu hình Agent đối với quyền VIEWER
 */
function sanitizeAgentForViewer(agent, role) {
  if (!agent) return agent;
  const sanitized = { ...agent };
  if (role === 'VIEWER') {
    // Ẩn nội dung chi tiết của Prompt bí mật hoặc credential
    sanitized.instruction_prompt = '🔒 [BẢO MẬT HỆ THỐNG]: Chỉ dẫn cấu hình (System Prompt) được bảo vệ và ẩn đối với quyền Viewer.';
    sanitized.is_prompt_masked = true;
  }
  return sanitized;
}

/**
 * Ghi nhật ký kiểm toán Agent (Enterprise Agent Audit Log)
 */
async function logAgentAuditEntry({ agentId, actor, action, targetType = null, targetId = null, details = {}, ip = null }) {
  try {
    const actorId = actor ? actor.user_id : null;
    const actorUsername = actor ? (actor.username || 'SYSTEM') : 'SYSTEM';
    const actorCompany = actor ? (actor.company_id || null) : null;

    await db.query(
      `INSERT INTO agent_audit_logs (agent_id, actor_id, actor_username, actor_company_id, action, target_type, target_id, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [agentId, actorId, actorUsername, actorCompany, action, targetType, targetId ? String(targetId) : null, JSON.stringify(details), ip]
    );

    // Đồng thời đồng bộ vào audit_log chung của hệ thống để thống kê tập trung
    await db.query(
      `INSERT INTO audit_log (at, actor, action, detail)
       VALUES (NOW(), $1, $2, $3)`,
      [
        actorUsername,
        `AGENT_${action}`,
        JSON.stringify({ agentId, actorId, actorCompany, targetType, targetId, ...details })
      ]
    );
  } catch (err) {
    console.warn('[AGENT AUDIT LOG] Ghi log thất bại:', err.message);
  }
}

/**
 * Tạo thông báo nội bộ cho người dùng
 */
async function createAgentNotification({ recipientId, senderId, agentId, type, title, message, metadata = {} }) {
  try {
    if (!recipientId) return;
    await db.query(
      `INSERT INTO agent_notifications (recipient_id, sender_id, agent_id, type, title, message, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [recipientId, senderId || null, agentId, type, title, message, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.warn('[AGENT NOTIFICATION] Gửi thông báo thất bại:', err.message);
  }
}

module.exports = {
  getAgentAccessContext,
  sanitizeAgentForViewer,
  logAgentAuditEntry,
  createAgentNotification
};
