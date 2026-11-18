'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const net = require('net');

// 1. HARD SAFETY GUARDS — Fail closed
function assertSafeTarget(host, port, db) {
  const p = parseInt(port, 10);
  if (p === 5432 || p === 5433) {
    console.error(`[FATAL SAFETY GUARD] Attempted connection to forbidden port ${p} (Production or Staging DB)! Execution aborted.`);
    process.exit(101);
  }
  if (p === 8082) {
    console.error(`[FATAL SAFETY GUARD] Attempted connection to forbidden port ${p} (Production Gateway)! Execution aborted.`);
    process.exit(103);
  }
  if (db === 'hrbot' || db === 'sotrans_staging') {
    console.error(`[FATAL SAFETY GUARD] Attempted connection to forbidden database '${db}'! Execution aborted.`);
    process.exit(102);
  }
}

if (require.main !== module) {
  module.exports = { assertSafeTarget };
} else {
  // Parse CLI args: node test_runner_wrapper.js <hermetic|candidate> <test_script_path> [...test_args]
  const mode = process.argv[2];
  const testScript = process.argv[3];
  const testArgs = process.argv.slice(4);

  if (!mode || !testScript || !['hermetic', 'candidate'].includes(mode)) {
    console.error('Usage: node test_runner_wrapper.js <hermetic|candidate> <path_to_test_script> [...args]');
    process.exit(1);
  }

// 2. Setup Isolated Temporary Storage
const backupStorage = 'D:/backup-bi-20261117/storage_backup/bi_datasets';
const tempStoragePrefix = path.join(os.tmpdir(), `sotrans-bi-isolated-${Date.now()}-`);
const tempStorageDir = fs.mkdtempSync(tempStoragePrefix);

if (fs.existsSync(backupStorage)) {
  fs.cpSync(backupStorage, tempStorageDir, { recursive: true });
} else {
  console.warn(`[WARN] Backup storage not found at ${backupStorage}. Created empty directory.`);
}

// 3. Prepare Environment
const env = { ...process.env };

const wtRoot = path.resolve(__dirname, '../..');
const authModules = path.join(wtRoot, 'auth-service/node_modules');
env.NODE_PATH = authModules + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');

env.STORAGE_DIR = tempStorageDir;
env.BI_STORAGE_DIR = tempStorageDir;
env.NODE_ENV = 'test';
env.ISOLATION_HARNESS = 'true';
env.JWT_SECRET = env.JWT_SECRET || 'test_jwt_secret_for_isolation_harness_2026';

if (mode === 'hermetic') {
  env.PG_HOST = '127.0.0.1';
  env.PG_PORT = '1';
  env.PG_DATABASE = 'dead_hermetic_db';
  env.PG_USER = 'nobody';
  env.PG_PASSWORD = 'no_password';

  env.PG_RO_HOST = '127.0.0.1';
  env.PG_RO_PORT = '1';
  env.PG_RO_DATABASE = 'dead_hermetic_db';
  env.PG_RO_USER = 'nobody_ro';
  env.PG_RO_PASSWORD = 'no_password';

  console.log(`[ISOLATION HARNESS] Mode: HERMETIC`);
  console.log(`[ISOLATION HARNESS] PG Target: 127.0.0.1:1 / dead_hermetic_db`);
  console.log(`[ISOLATION HARNESS] Storage: ${tempStorageDir}`);
} else if (mode === 'candidate') {
  env.PG_HOST = process.env.CANDIDATE_PG_HOST || '127.0.0.1';
  env.PG_PORT = process.env.CANDIDATE_PG_PORT || '5439';
  env.PG_DATABASE = process.env.CANDIDATE_PG_DATABASE || 'bi_candidate_db';
  env.PG_USER = process.env.CANDIDATE_PG_USER || 'candidate_user';
  env.PG_PASSWORD = process.env.CANDIDATE_PG_PASSWORD || process.env.PG_PASSWORD || '';

  env.PG_RO_HOST = process.env.CANDIDATE_PG_RO_HOST || '127.0.0.1';
  env.PG_RO_PORT = process.env.CANDIDATE_PG_RO_PORT || '5439';
  env.PG_RO_DATABASE = process.env.CANDIDATE_PG_RO_DATABASE || 'bi_candidate_db';
  env.PG_RO_USER = process.env.CANDIDATE_PG_RO_USER || 'candidate_user_ro';
  env.PG_RO_PASSWORD = process.env.CANDIDATE_PG_RO_PASSWORD || process.env.PG_RO_PASSWORD || '';

  if (!env.PG_PASSWORD || !env.PG_RO_PASSWORD) {
    console.warn('[ISOLATION HARNESS] Warning: CANDIDATE_PG_PASSWORD or CANDIDATE_PG_RO_PASSWORD not set in environment.');
  }

  console.log(`[ISOLATION HARNESS] Mode: CANDIDATE`);
  console.log(`[ISOLATION HARNESS] PG Target: 127.0.0.1:5439 / bi_candidate_db (Users: candidate_user, candidate_user_ro)`);
  console.log(`[ISOLATION HARNESS] Storage: ${tempStorageDir}`);
}

assertSafeTarget(env.PG_HOST, env.PG_PORT, env.PG_DATABASE);
assertSafeTarget(env.PG_RO_HOST, env.PG_RO_PORT, env.PG_RO_DATABASE);

// 4. Execute Test Subprocess
const absoluteScriptPath = path.isAbsolute(testScript) ? testScript : path.resolve(wtRoot, testScript);
console.log(`[ISOLATION HARNESS] Executing: node ${absoluteScriptPath} ${testArgs.join(' ')}\n`);

const start = Date.now();
const res = spawnSync(process.execPath, [absoluteScriptPath, ...testArgs], {
  env,
  stdio: 'inherit',
  cwd: wtRoot
});

const elapsed = Date.now() - start;
console.log(`\n[ISOLATION HARNESS] Completed in ${elapsed}ms with exit code: ${res.status}`);

// 5. Cleanup Temporary Storage
try {
  fs.rmSync(tempStorageDir, { recursive: true, force: true });
} catch (e) {
  console.warn(`[WARN] Failed to delete temp storage: ${e.message}`);
}

  process.exit(res.status === null ? 1 : res.status);
}
