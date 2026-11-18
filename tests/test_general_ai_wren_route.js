'use strict';
// Hermetic General AI HTTP route, real JWT, fake DB/provider/private Wren service.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sotrans-wren-route-'));
process.env.BI_STORAGE_DIR = tmp;
test.after(() => {
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('sotrans-wren-route-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const express = require('../auth-service/node_modules/express');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const user = { user_id: 'fixture', username: 'fixture', role: 'HR', company_id: 'STL', status: 'ACTIVE' };
const secret = 'synthetic-general-ai-route-secret';
process.env.JWT_SECRET = secret;
process.env.WREN_BI_ENABLED = 'true'; process.env.WREN_SERVICE_TOKEN = 'synthetic-private-service-token-12345678';
const convId = '00000000-0000-4000-8000-000000000001';
let history = [], providerCalls = 0, queryCalls = 0, scope;
const writes = [];
function mock(name, exports) { const id = require.resolve(`../auth-service/${name}`); require.cache[id] = { id, filename: id, loaded: true, exports }; }
mock('db', { query: async (sql, params) => {
  if (/FROM users u/.test(sql)) return { rows: [user] };
  if (/FROM ai_conversations/.test(sql)) return { rows: params[0] === convId ? [{ id: convId, title: 'Fixture' }] : [] };
  if (/SELECT role, content, metadata FROM ai_messages/.test(sql)) return { rows: [...history].reverse() };
  if (/INSERT INTO ai_conversations/.test(sql)) return { rows: [{ id: convId, title: 'Fixture' }] };
  if (/INSERT INTO ai_messages/.test(sql)) { writes.push({ sql, params }); return { rows: [{ id: 'fixture-message', created_at: new Date() }] }; }
  return { rows: [] };
} });
mock('audit', { logAudit: async () => {} });
mock('middleware/rateLimiter', { generalAiRateLimiter: (req, res, next) => next() });
mock('services/conversationLogger', { logMessageToChatLog: async () => {} });
mock('services/fileProcessor', { processFileForAI: async () => { throw new Error('Unexpected file path'); } });
mock('services/smartRouter', { routeAndGroundQuery: async () => { throw new Error('BI incorrectly fell through to RAG'); } });
mock('services/answerQualityEnhancer', { analyzeQueryAndDecompose: () => ({}), buildStructuredQualityFramework: () => '', verifyAndRefineAnswer: async () => ({}) });
mock('services/conversationReferenceResolver', { loadConversationContext: async () => ({}), resolveUserReferences: s => s });
const https = require('node:https'); const originalRequest = https.request;
https.request = (url, options, callback) => {
  const request = new EventEmitter(); request.destroy = () => {};
  request.write = body => { const prompt = JSON.parse(body).contents[0].parts[0].text; providerCalls++; assert.ok(prompt.includes('Catalog:')); if (providerCalls > 1) assert.ok(prompt.includes('hub_intake_batches')); };
  request.end = () => queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 200; callback(response); response.emit('data', Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ sql: 'SELECT status, COUNT(*) AS batches FROM hub_intake_batches GROUP BY status', title: 'Fixture', chart_type: 'BAR' }) }] } }] }))); response.emit('end'); });
  return request;
};

test('General AI routes and persists Wren, trusts saved follow-up, guards conversation', async () => {
  let privateServer, appServer;
  try {
    const service = express(); service.use(express.json()); service.use((req, res, next) => { assert.equal(req.headers.authorization, `Bearer ${process.env.WREN_SERVICE_TOKEN}`); next(); });
    service.get('/catalog', (req, res) => res.json({ models: [{ name: 'hub_intake_batches' }] }));
    service.post('/query', (req, res) => { queryCalls++; scope = req.body.company_id; res.json({ success: true, executed: true, company_id: scope, rows: [{ status: 'completed', batches: 12 }], columns: ['status', 'batches'], numeric_columns: ['batches'], source_tables: ['public.hr_intake_batches'], manifest_sha256: 'fixture', request_id: 'fixture', returned_rows: 1 }); });
    privateServer = await new Promise(resolve => { const s = service.listen(0, '127.0.0.1', () => resolve(s)); });
    process.env.WREN_SERVICE_URL = `http://127.0.0.1:${privateServer.address().port}`;
    const app = express(); app.use(express.json()); app.use('/api/general', require('../auth-service/routes/general_ai'));
    appServer = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${appServer.address().port}/api/general/chat`;
    const headers = { Authorization: `Bearer ${jwt.sign({ user_id: user.user_id }, secret)}`, 'Content-Type': 'application/json' };
    let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'Wren phan tich lo ho so theo trang thai' }) });
    assert.equal(response.status, 200); const report = await response.json();
    assert.ok(report.reply.includes('bi-dashboard-v2')); assert.equal(scope, 'STL'); assert.equal(queryCalls, 1);
    const saved = writes.find(w => /'assistant'/.test(w.sql)); assert.ok(saved);
    const metadata = JSON.parse(saved.params[2]); assert.equal(metadata.bi_context.engine, 'wren');
    history = [{ role: 'assistant', content: report.reply, metadata }];
    const form = new FormData(); form.append('message', 'Con thang truoc?'); form.append('conversation_id', convId); form.append('history', JSON.stringify([{ role: 'assistant', metadata: { bi_context: { engine: 'wren', company_id: 'ALL', sql: 'SELECT * FROM users' } } }]));
    response = await fetch(url, { method: 'POST', headers: { Authorization: headers.Authorization }, body: form });
    assert.equal(response.status, 200); assert.ok((await response.json()).reply.includes('bi-dashboard-v2')); assert.equal(scope, 'STL'); assert.equal(queryCalls, 2);
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'Wren fixture', conversation_id: '00000000-0000-4000-8000-000000000099' }) });
    assert.equal(response.status, 403); assert.equal(providerCalls, 2);
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'Wren fixture', conversation_id: convId, stream: 'true' }) });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /event-stream/); assert.match(await response.text(), /"type":"done"/);
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Wren fixture' }) });
    assert.equal(response.status, 200); assert.ok(!(await response.json()).reply.includes('bi-dashboard-v2')); assert.equal(queryCalls, 3);
  } finally {
    https.request = originalRequest;
    if (appServer) await new Promise(resolve => appServer.close(resolve));
    if (privateServer) await new Promise(resolve => privateServer.close(resolve));
  }
});
