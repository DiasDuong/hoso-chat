/**
 * SOTRANS HUB — BI AUDIT LOGGER SERVICE (PHASE 2.4)
 * 
 * Central Audit Logging for Uploaded File BI & Analytical Queries:
 * - Records full lifecycle events: UPLOAD, QUERY, ASK, SHARE, REVOKE_SHARE, DELETE, PURGE, ACCESS_DENIED
 * - Strictly enforces Data Governance & Security:
 *   - NEVER logs raw row contents, cell values, prompt injection text, or sensitive employee/customer PII
 *   - Only logs high-level metadata (counts, column names, execution times, status codes, user identity)
 * - Persists append-only to storage/bi_audit.log and database auth_audit_logs (when available)
 */

const fs = require('fs');
const path = require('path');
const { STORAGE_DIR } = require('./biFileSecurityService');

const BI_AUDIT_LOG_FILE = path.join(STORAGE_DIR, 'bi_audit.log');

// Try optional database audit logger
let logAuditDb = null;
try {
  const auditModule = require('../audit');
  if (auditModule && typeof auditModule.logAudit === 'function') {
    logAuditDb = auditModule.logAudit;
  }
} catch (_) {}

/**
 * Sanitize details object to strictly eliminate any sensitive raw data or PII
 */
function sanitizeAuditDetails(details = {}) {
  if (!details || typeof details !== 'object') return {};

  const clean = {};
  const allowedKeys = [
    'file_id',
    'filename',
    'file_size',
    'file_type',
    'sheet_count',
    'active_sheet',
    'row_count',
    'column_count',
    'column_names',
    'aggregations',
    'group_by',
    'filters_count',
    'sort_columns',
    'limit',
    'execution_time_ms',
    'company_id',
    'request_id',
    'manifest_sha256',
    'source_tables',
    'returned_rows',
    'total_matching',
    'memory_delta_kb',
    'purged_count',
    'purged_orphans',
    'target_type',
    'target_id',
    'permission',
    'shared_by',
    'revoked_by',
    'reason',
    'error_code',
    'ip_address',
  ];

  for (const [key, val] of Object.entries(details)) {
    if (allowedKeys.includes(key)) {
      clean[key] = val;
    }
  }

  // If column_names provided, map to strings
  if (Array.isArray(details.columns)) {
    clean.column_names = details.columns.map((c) => (typeof c === 'string' ? c : c.name || c.key)).slice(0, 50);
  }

  // If query_plan provided, extract safe structure
  if (details.query_plan && typeof details.query_plan === 'object') {
    const qp = details.query_plan;
    clean.aggregations = Array.isArray(qp.aggregations) ? qp.aggregations.map((a) => `${a.func}(${a.column})`) : [];
    clean.group_by = Array.isArray(qp.groupBy) ? qp.groupBy : [];
    clean.filters_count = Array.isArray(qp.filters) ? qp.filters.length : 0;
    clean.limit = qp.limit || null;
  }

  return clean;
}

/**
 * Log a BI Audit Event
 * @param {Object} entry
 * @param {string} entry.event - Event type: FILE_UPLOAD, DATASET_QUERY, DATASET_ASK, DATASET_SHARE, DATASET_REVOKE_SHARE, DATASET_DELETE, RETENTION_PURGE, ACCESS_DENIED
 * @param {string} entry.fileId - File / Dataset UUID
 * @param {string} entry.filename - Original filename
 * @param {Object} entry.userContext - Authenticated caller context
 * @param {Object} [entry.details] - Safe event details
 * @param {string} [entry.status='SUCCESS'] - Event status: SUCCESS, DENIED, FAILED
 * @param {number} [entry.executionTimeMs=0] - Execution latency
 */
async function logBiAuditEvent({
  event,
  fileId = null,
  filename = '',
  userContext = null,
  details = {},
  status = 'SUCCESS',
  executionTimeMs = 0,
}) {
  const timestamp = new Date().toISOString();
  const safeDetails = sanitizeAuditDetails(details);

  const auditEntry = {
    timestamp,
    event: String(event || 'UNKNOWN_BI_EVENT').toUpperCase(),
    event_type: String(event || 'UNKNOWN_BI_EVENT').toUpperCase(),
    file_id: fileId,
    filename: filename ? path.basename(filename) : null,
    actor_user_id: userContext ? String(userContext.user_id || userContext.userId || '') : null,
    actor_username: userContext ? String(userContext.username || '') : 'ANONYMOUS',
    actor_role: userContext ? String(userContext.role || '').toUpperCase() : 'UNKNOWN',
    actor_company_id: userContext ? String(userContext.company_id || '').toUpperCase() : 'UNKNOWN',
    status: String(status || 'SUCCESS').toUpperCase(),
    execution_time_ms: typeof executionTimeMs === 'number' ? executionTimeMs : 0,
    details: safeDetails,
  };

  // 1. Append-only file persistence
  try {
    const line = JSON.stringify(auditEntry) + '\n';
    await fs.promises.appendFile(BI_AUDIT_LOG_FILE, line, { encoding: 'utf8', mode: 0o600 });
  } catch (fileErr) {
    console.error('[BiAuditLogger] Failed to write audit log file:', fileErr.message);
  }

  // 2. Database audit log persistence (if available)
  if (logAuditDb && userContext) {
    try {
      await logAuditDb({
        actor_user_id: auditEntry.actor_user_id,
        actor_username: auditEntry.actor_username,
        action: `BI_${auditEntry.event}`,
        status: auditEntry.status,
        ip_address: safeDetails.ip_address || '127.0.0.1',
        metadata: {
          file_id: auditEntry.file_id,
          filename: auditEntry.filename,
          company_id: auditEntry.actor_company_id,
          role: auditEntry.actor_role,
          execution_time_ms: auditEntry.execution_time_ms,
          details: safeDetails,
        },
      });
    } catch (_) {
      // Non-blocking for DB log
    }
  }

  return auditEntry;
}

/**
 * Retrieve recent BI Audit Logs for a specific dataset or globally (for Governance view)
 */
async function getBiAuditLogs(filter = {}) {
  try {
    if (!fs.existsSync(BI_AUDIT_LOG_FILE)) {
      return [];
    }

    const raw = await fs.promises.readFile(BI_AUDIT_LOG_FILE, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const logs = [];

    const limit = filter.limit ? parseInt(filter.limit, 10) : 50;

    for (let i = lines.length - 1; i >= 0 && logs.length < limit; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (filter.file_id && item.file_id !== filter.file_id) continue;
        if (filter.event && item.event !== filter.event.toUpperCase()) continue;
        if (filter.company_id && item.actor_company_id !== filter.company_id.toUpperCase()) continue;
        logs.push(item);
      } catch (_) {}
    }

    return logs;
  } catch (err) {
    console.error('[BiAuditLogger] Error reading audit logs:', err.message);
    return [];
  }
}

module.exports = {
  logBiAuditEvent,
  getBiAuditLogs,
  sanitizeAuditDetails,
  BI_AUDIT_LOG_FILE,
};
