const db = require('./db');

async function logAudit({
  actor_user_id = null,
  actor_username = null,
  target_user_id = null,
  target_username = null,
  action,
  status = 'SUCCESS',
  ip_address = null,
  metadata = {},
}) {
  try {
    const isActorUuid = typeof actor_user_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor_user_id);
    const validActorId = isActorUuid ? actor_user_id : null;
    const isTargetUuid = typeof target_user_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target_user_id);
    const validTargetId = isTargetUuid ? target_user_id : null;

    await db.query(
      `INSERT INTO auth_audit_logs 
        (actor_user_id, actor_username, target_user_id, target_username, action, status, ip_address, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        validActorId,
        actor_username,
        validTargetId,
        target_username,
        action,
        status,
        ip_address,
        JSON.stringify(metadata),
      ]
    );
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
}

module.exports = { logAudit };
