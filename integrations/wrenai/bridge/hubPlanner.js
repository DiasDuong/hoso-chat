'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const KIT = path.resolve(__dirname, '..');
const COMPANIES = new Set(['STL', 'VTX', 'SWC']);

class WrenBridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'WrenBridgeError'; this.code = code; }
}

// The caller must supply req.user from verified server middleware, never req.body.user.
function authorizeScope(userContext, requestedCompany) {
  if (!userContext?.user_id || userContext.status !== 'ACTIVE') {
    throw new WrenBridgeError('UNAUTHORIZED', 'An authenticated ACTIVE user is required.');
  }
  if (userContext.role === 'HR') {
    if (!COMPANIES.has(userContext.company_id)) throw new WrenBridgeError('INVALID_TENANT', 'Invalid HR company.');
    if (requestedCompany && requestedCompany !== userContext.company_id) {
      throw new WrenBridgeError('TENANT_MISMATCH', 'The requested company is outside this HR scope.');
    }
    return userContext.company_id;
  }
  if (userContext.role === 'ADMIN') {
    if (!COMPANIES.has(requestedCompany) && requestedCompany !== 'ALL') {
      throw new WrenBridgeError('MISSING_ADMIN_TENANT', 'ADMIN must select STL, VTX, SWC or ALL.');
    }
    return requestedCompany;
  }
  throw new WrenBridgeError('FORBIDDEN_ROLE', 'Internal BI planning requires ADMIN or HR.');
}

function runWorker(pythonExecutable, request, timeoutMs, maxOutputBytes) {
  return new Promise((resolve, reject) => {
    const environment = { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    const child = spawn(pythonExecutable, ['-B', path.join(__dirname, 'plan_worker.py')], {
      cwd: KIT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment,
    });
    let settled = false, bytes = 0, output = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new WrenBridgeError('PLANNER_TIMEOUT', 'Wren planning timed out.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        child.kill(); finish(new WrenBridgeError('PLANNER_OUTPUT_LIMIT', 'Wren response exceeded the limit.')); return;
      }
      output += decoder.write(chunk);
    });
    // Drain stderr without logging SQL, environment, driver details or credentials.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new WrenBridgeError('PLANNER_UNAVAILABLE', 'Cannot start the isolated Wren planner.')));
    child.stdin.on('error', () => finish(new WrenBridgeError('PLANNER_UNAVAILABLE', 'Cannot send the planning request.')));
    child.on('close', code => {
      if (settled) return;
      try {
        output += decoder.end();
        const result = JSON.parse(output);
        if (!result.success) {
          finish(new WrenBridgeError(result.code || 'PLAN_REJECTED', 'The analytical plan was rejected.'));
        } else if (code !== 0 || result.mode !== 'plan-only' || result.executed !== false || result.company_id !== request.company_id || typeof result.planned_sql !== 'string') {
          finish(new WrenBridgeError('INVALID_PLANNER_RESPONSE', 'Invalid planner response.'));
        } else finish(null, result);
      } catch (_) { finish(new WrenBridgeError('INVALID_PLANNER_RESPONSE', 'Invalid planner response.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function createWrenPlanner({ enabled = false, pythonExecutable, timeoutMs = 15000, maxOutputBytes = 1024 * 1024 } = {}) {
  if (typeof enabled !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) {
    throw new WrenBridgeError('INVALID_CONFIG', 'Invalid planner limits or feature flag.');
  }
  if (enabled && (!pythonExecutable || !path.isAbsolute(pythonExecutable))) {
    throw new WrenBridgeError('INVALID_CONFIG', 'An explicit absolute Python executable path is required.');
  }
  return Object.freeze({
    enabled,
    async plan({ sql, userContext, companyId, limit = 100 } = {}) {
      if (!enabled) throw new WrenBridgeError('WREN_DISABLED', 'The supplementary Wren planner is disabled.');
      const scope = authorizeScope(userContext, companyId);
      if (typeof sql !== 'string' || !sql.trim() || sql.length > 8000) throw new WrenBridgeError('INVALID_SQL_SIZE', 'Invalid analytical query size.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new WrenBridgeError('INVALID_LIMIT', 'The row limit must be 1 to 500.');
      return runWorker(pythonExecutable, { action: 'plan', company_id: scope, sql, limit }, timeoutMs, maxOutputBytes);
    },
  });
}

module.exports = { createWrenPlanner, authorizeScope, WrenBridgeError };
