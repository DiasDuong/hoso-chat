'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sotrans-wren-orchestration-'));
process.env.BI_STORAGE_DIR = tmp;
test.after(() => {
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('sotrans-wren-orchestration-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
process.env.JWT_SECRET = 'synthetic-test-signing-key-not-a-runtime-key';
require.cache[require.resolve('../auth-service/audit')] = { exports: { logAudit: async () => {} } };
const { scopeFor, runReport, decodeDraft, resultDashboard } = require('../auth-service/services/wrenBiService');
const { signReport, verifyReport } = require('../auth-service/services/biExportToken');
const user = { user_id: 'fixture', role: 'HR', company_id: 'STL', status: 'ACTIVE' };
const result = { executed: true, company_id: 'STL', rows: [{ status: 'completed', batches: 12 }], columns: ['status', 'batches'], returned_rows: 1, source_tables: ['public.hr_intake_batches'], manifest_sha256: 'fixture', request_id: 'fixture' };

test('orchestrator uses verified scope and produces a signed v2 report', async () => {
  const requests = [];
  const report = await runReport({ message: 'fixture question', user, generate: async () => JSON.stringify({ sql: 'SELECT status, COUNT(*) AS batches FROM hub_intake_batches GROUP BY status', chart_type: 'BAR', title: 'Fixture' }), request: async (url, body) => { requests.push({ url, body }); return url === '/catalog' ? { models: [] } : result; } });
  assert.equal(requests[1].body.company_id, 'STL');
  assert.equal(report.context.engine, 'wren');
  const payload = JSON.parse(report.reply.match(/<!-- bi-dashboard-v2: (.*?) -->/s)[1]);
  assert.equal(verifyReport(payload, user), true);
  assert.equal(payload.provenance.generated_by, 'WrenAI');
  assert.equal(payload.visualizations.length, 1);
});
test('forbidden role is rejected before LLM or network calls', async () => {
  let called = false;
  await assert.rejects(runReport({ message: 'fixture', user: { ...user, role: 'EMPLOYEE' }, generate: async () => { called = true; }, request: async () => { called = true; } }), { code: 'WREN_FORBIDDEN' });
  assert.equal(called, false);
});
test('cross-company HR request is rejected', () => assert.throws(() => scopeFor(user, 'ALL'), { status: 403 }));
test('invalid SQL retry is bounded', async () => {
  let generated = 0;
  await assert.rejects(runReport({ message: 'fixture', user, generate: async () => { generated++; return '{"sql":"SELECT 1"}'; }, request: async url => { if (url === '/catalog') return {}; throw Object.assign(new Error('fixture'), { code: 'INVALID_SQL' }); } }));
  assert.equal(generated, 2);
});
test('clarification produces no execution', async () => {
  let queried = false;
  const response = await runReport({ message: 'fixture', user, generate: async () => '{"clarification_question":"Chọn nguồn?"}', request: async url => { if (url === '/query') queried = true; return {}; } });
  assert.equal(queried, false); assert.equal(response.context, null);
});
test('no code or free text is accepted as an LLM draft', () => assert.throws(() => decodeDraft('I executed your query: 123')));
test('export signature rejects tampering and another user', () => {
  const payload = signReport({ version: '2.0', data_store: { d: [{ total: 12 }] } }, user);
  assert.equal(verifyReport(payload, user), true);
  assert.equal(verifyReport(payload, { ...user, user_id: 'another' }), false);
  payload.data_store.d[0].total = 999;
  assert.equal(verifyReport(payload, user), false);
});
test('database numeric metadata preserves date dimensions and numeric visuals', () => {
  const p = resultDashboard({ ...result, rows: [{ period: '2026-01', average: '12.5' }], columns: ['period', 'average'], numeric_columns: ['average'] }, { title: 'Fixture', chart_type: 'LINE' }, user);
  assert.equal(p.data_store.wren_result[0].average, 12.5);
  assert.equal(p.visualizations[0].mapping.category, 'period');
});
