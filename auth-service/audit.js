const fs = require('fs');
const path = require('path');
const db = require('./db');

const BUFFER_FILE_PATH = path.resolve(__dirname, 'data', 'audit_failures.jsonl');
const inMemoryFailedBuffer = [];
let isFlushing = false;

// Ensure data directory exists
try {
  const dataDir = path.dirname(BUFFER_FILE_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
} catch (e) {
  // Silent ignore
}

/**
 * Persist a failed audit log entry to fallback file
 */
function bufferAuditFailure(entry) {
  try {
    inMemoryFailedBuffer.push(entry);
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(BUFFER_FILE_PATH, line, 'utf8');
    console.warn(`[Audit Resilience] Buffered failed audit log to disk (Buffer count: ${inMemoryFailedBuffer.length}). Action: ${entry.action}`);
  } catch (fsErr) {
    console.error('[Audit Resilience] Critical: Failed to buffer audit log to disk:', fsErr.message);
  }
}

/**
 * Flush and retry inserting buffered audit log entries into database
 * @returns {Promise<{ recovered: number, remaining: number }>}
 */
async function flushFailedAuditLogs() {
  if (isFlushing) return { recovered: 0, remaining: inMemoryFailedBuffer.length };
  isFlushing = true;

  let allEntries = [...inMemoryFailedBuffer];

  // Also read from disk buffer if file exists
  if (fs.existsSync(BUFFER_FILE_PATH)) {
    try {
      const content = fs.readFileSync(BUFFER_FILE_PATH, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const fileEntries = lines.map(l => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);

      // Merge unique entries by timestamp + action + actor_username
      for (const fe of fileEntries) {
        if (!allEntries.some(e => e.logged_at === fe.logged_at && e.action === fe.action && e.actor_username === fe.actor_username)) {
          allEntries.push(fe);
        }
      }
    } catch (readErr) {
      console.warn('[Audit Resilience] Could not read disk buffer:', readErr.message);
    }
  }

  if (allEntries.length === 0) {
    isFlushing = false;
    return { recovered: 0, remaining: 0 };
  }

  let recoveredCount = 0;
  const unrecovered = [];

  for (const entry of allEntries) {
    try {
      const isActorUuid = typeof entry.actor_user_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.actor_user_id);
      const validActorId = isActorUuid ? entry.actor_user_id : null;
      const isTargetUuid = typeof entry.target_user_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.target_user_id);
      const validTargetId = isTargetUuid ? entry.target_user_id : null;

      const metaWithRecovery = {
        ...(entry.metadata || {}),
        _audit_recovered: true,
        _audit_original_timestamp: entry.logged_at
      };

      await db.query(
        `INSERT INTO auth_audit_logs 
          (actor_user_id, actor_username, target_user_id, target_username, action, status, ip_address, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`,
        [
          validActorId,
          entry.actor_username,
          validTargetId,
          entry.target_username,
          entry.action,
          entry.status,
          entry.ip_address,
          JSON.stringify(metaWithRecovery),
          entry.logged_at || null
        ]
      );
      recoveredCount++;
    } catch (retryErr) {
      entry.retry_count = (entry.retry_count || 0) + 1;
      entry.last_retry_error = retryErr.message;
      unrecovered.push(entry);
    }
  }

  // Update in-memory buffer
  inMemoryFailedBuffer.length = 0;
  inMemoryFailedBuffer.push(...unrecovered);

  // Rewrite remaining unrecovered back to file
  try {
    if (unrecovered.length > 0) {
      const rewritten = unrecovered.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(BUFFER_FILE_PATH, rewritten, 'utf8');
    } else if (fs.existsSync(BUFFER_FILE_PATH)) {
      fs.unlinkSync(BUFFER_FILE_PATH);
    }
  } catch (writeErr) {
    console.error('[Audit Resilience] Could not rewrite disk buffer:', writeErr.message);
  }

  if (recoveredCount > 0) {
    console.log(`[Audit Resilience] Successfully recovered and inserted ${recoveredCount} buffered audit logs. Remaining: ${unrecovered.length}`);
  }

  isFlushing = false;
  return { recovered: recoveredCount, remaining: unrecovered.length };
}

// Background auto-flush timer (every 60s, non-blocking)
const flushTimer = setInterval(() => {
  flushFailedAuditLogs().catch(() => {});
}, 60000);
if (flushTimer.unref) flushTimer.unref();

/**
 * Standard logAudit function with failure resilience
 */
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
  const auditEntry = {
    actor_user_id,
    actor_username,
    target_user_id,
    target_username,
    action,
    status,
    ip_address,
    metadata,
    logged_at: new Date().toISOString()
  };

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
    console.error('Failed to write audit log to database:', err.message);
    auditEntry.error = err.message;
    bufferAuditFailure(auditEntry);
  }
}

module.exports = {
  logAudit,
  bufferAuditFailure,
  flushFailedAuditLogs,
  getFailedBuffer: () => [...inMemoryFailedBuffer]
};
