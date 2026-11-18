'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWrenPlanner, authorizeScope } = require('../bridge/hubPlanner');
const user = { user_id: 'synthetic', role: 'HR', company_id: 'STL', status: 'ACTIVE' };
const admin = { ...user, role: 'ADMIN' };
const pythonExecutable = path.resolve(__dirname, '../.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sql = 'SELECT SUM(total_files) AS files FROM hub_intake_batches';
const rejectsCode = (promise, code) => assert.rejects(promise, { code });

test('disabled by default and does not start Python', async () => {
  await rejectsCode(createWrenPlanner().plan({ sql, userContext: user }), 'WREN_DISABLED');
});
test('HR uses authenticated company', () => assert.equal(authorizeScope(user), 'STL'));
test('HR cannot select another company or ALL', () => {
  for (const c of ['VTX', 'ALL']) assert.throws(() => authorizeScope(user, c), { code: 'TENANT_MISMATCH' });
});
test('ADMIN needs an explicit approved scope', () => {
  assert.throws(() => authorizeScope(admin), { code: 'MISSING_ADMIN_TENANT' });
  assert.equal(authorizeScope(admin, 'ALL'), 'ALL');
});
test('employee is refused', () => assert.throws(() => authorizeScope({ ...user, role: 'EMPLOYEE' }), { code: 'FORBIDDEN_ROLE' }));
test('missing, locked or inactive identity is refused', () => {
  for (const u of [null, { ...user, user_id: null }, { ...user, status: 'LOCKED' }, { ...user, status: 'INACTIVE' }]) {
    assert.throws(() => authorizeScope(u), { code: 'UNAUTHORIZED' });
  }
});
test('enabled planner needs an absolute Python path', () => assert.throws(() => createWrenPlanner({ enabled: true, pythonExecutable: 'python' }), { code: 'INVALID_CONFIG' }));
test('configuration cannot remove limits', () => {
  assert.throws(() => createWrenPlanner({ timeoutMs: 0 }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createWrenPlanner({ maxOutputBytes: 2000000 }), { code: 'INVALID_CONFIG' });
});
test('real Node to Python to extracted Wren pipeline plans only', async () => {
  const planner = createWrenPlanner({ enabled: true, pythonExecutable });
  const result = await planner.plan({ sql, userContext: user });
  assert.equal(result.executed, false);
  assert.equal(result.company_id, 'STL');
  assert.deepEqual(result.source_tables, ['public.hr_intake_batches']);
  assert.equal(result.mode, 'plan-only');
});
test('runtime rejects arbitrary SQL functions without forwarding SQL in error', async () => {
  const planner = createWrenPlanner({ enabled: true, pythonExecutable });
  await rejectsCode(planner.plan({ sql: 'SELECT pg_read_file(\'/private\') FROM hub_intake_batches', userContext: user }), 'INVALID_SQL');
});
test('row limits are checked before spawning', async () => {
  const planner = createWrenPlanner({ enabled: true, pythonExecutable });
  await rejectsCode(planner.plan({ sql, userContext: user, limit: 999 }), 'INVALID_LIMIT');
});
test('Unicode aliases survive the process protocol', async () => {
  const planner = createWrenPlanner({ enabled: true, pythonExecutable });
  const result = await planner.plan({ sql: 'SELECT SUM(total_files) AS "Tổng_tệp" FROM hub_intake_batches', userContext: user });
  assert.ok(result.planned_sql.includes('Tổng_tệp'));
});
test('timeout ends the planner subprocess', async () => {
  const planner = createWrenPlanner({ enabled: true, pythonExecutable, timeoutMs: 1 });
  await rejectsCode(planner.plan({ sql, userContext: user }), 'PLANNER_TIMEOUT');
});
test('output bound is enforced', async () => {
  const planner = createWrenPlanner({ enabled: true, pythonExecutable, maxOutputBytes: 32 });
  await rejectsCode(planner.plan({ sql, userContext: user }), 'PLANNER_OUTPUT_LIMIT');
});
