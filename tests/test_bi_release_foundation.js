'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sotrans-bi-release-'));
process.env.BI_STORAGE_DIR = tmp;
for (const [file, exports] of [
  ['../auth-service/audit', { logAudit: async () => {} }],
  ['../auth-service/db', { query: async () => { throw new Error('Unexpected database access in isolated test'); } }],
]) require.cache[require.resolve(file)] = { id: require.resolve(file), filename: require.resolve(file), loaded: true, exports };
const engine = require('../auth-service/services/biSpreadsheetEngine');
const registry = require('../auth-service/services/biDatasetRegistry');
const { buildDatasetDashboard } = require('../auth-service/services/biReportBuilder');
const { formatBIReportMarkdown } = require('../auth-service/services/biReportingHelper');
const { sanitizeBiData, sanitizeBiProfile } = require('../auth-service/services/biPrivacy');
const XLSX = require('../auth-service/node_modules/xlsx');
const owner = { user_id: 'fixture-owner', role: 'HR', company_id: 'STL', status: 'ACTIVE' };
const fixture = { file_id: 'fixture-metrics', columns: [{ key: 'day', type: 'DATE' }], rows: [{ day: '2026-02-01', dept: 'A', amount: 200 }, { day: '2026-01-01', dept: 'A', amount: 100 }] };
const sumPlan = { groupBy: [{ column: 'day', date_trunc: 'month' }], aggregations: [{ column: 'amount', func: 'SUM', alias: 'total' }], computations: [{ type: 'GROWTH_RATE', source_alias: 'total', target_alias: 'growth' }], orderBy: { column: 'day', dir: 'ASC' }, limit: 100 };

test('growth and period comparison use chronological order', () => {
  const result = engine.executeAnalyticalQuery(fixture, { ...sumPlan, period_comparison: { period: 'month', date_column: 'day' } });
  assert.deepEqual(result.results.map(r => [r.day, r.growth]), [['2026-01', null], ['2026-02', 100]]);
  assert.equal(result.period_comparison.current_value, 200);
  assert.equal(result.period_comparison.previous_value, 100);
});
test('growth is independent for each categorical time series', () => {
  const data = { ...fixture, rows: [...fixture.rows, { day: '2026-01-01', dept: 'B', amount: 40 }, { day: '2026-02-01', dept: 'B', amount: 20 }] };
  const result = engine.executeAnalyticalQuery(data, { ...sumPlan, groupBy: ['dept', ...sumPlan.groupBy] });
  assert.equal(result.results.find(r => r.dept === 'B' && r.day === '2026-02').growth, -50);
});
test('whole-filter AVG and distinct count are not rollups of groups or top-N', () => {
  const data = { file_id: 'summary', rows: [{ dept: 'A', amount: 10, person: 'p1' }, { dept: 'B', amount: 20, person: 'p1' }, { dept: 'B', amount: 40, person: 'p2' }] };
  const plan = { groupBy: ['dept'], aggregations: [{ func: 'AVG', column: 'amount', alias: 'average' }, { func: 'DISTINCT_COUNT', column: 'person', alias: 'people' }], limit: 1, chart_preference: 'BAR' };
  const result = engine.executeAnalyticalQuery(data, plan);
  assert.equal(result.summary.average, 23.33);
  assert.equal(result.summary.people, 2);
  assert.equal(result.total_groups, 2);
  const payload = buildDatasetDashboard(plan, result, { file_id: data.file_id, original_filename: 'Synthetic' });
  assert.equal(payload.kpi_strip[0].primary_value, 23.33);
  assert.equal(payload.kpi_strip[1].primary_value, 2);
  assert.ok(payload.visualizations.length >= 1);
});
test('legacy grouped AVG without summary is unavailable instead of fabricated', () => {
  const payload = buildDatasetDashboard({ groupBy: ['dept'], aggregations: [{ func: 'AVG', column: 'amount', alias: 'avg' }] }, { results: [{ dept: 'A', avg: 10 }, { dept: 'B', avg: 20 }] }, { file_id: 'legacy' });
  assert.equal(payload.kpi_strip[0].primary_value, null);
  assert.equal(payload.kpi_strip[0].status, 'DATA_UNAVAILABLE');
});
test('missing/nonfinite metrics stay null through groups, share, growth and comparison', () => {
  const data = { file_id: 'missing', columns: [{ key: 'day', type: 'DATE' }], rows: [{ day: '2026-01-01', amount: 10 }, { day: '2026-02-01', amount: '1e309' }] };
  const result = engine.executeAnalyticalQuery(data, { ...sumPlan, computations: [...sumPlan.computations, { type: 'PERCENTAGE', source_alias: 'total', target_alias: 'share' }], period_comparison: { date_column: 'day', period: 'month' } });
  const missing = result.results.find(r => r.day === '2026-02');
  assert.equal(missing.total, null); assert.equal(missing.growth, null); assert.equal(missing.share, null);
  assert.equal(result.period_comparison.difference, null); assert.equal(result.period_comparison.growth_rate_pct, null);
});
test('date filter uses calendar values', () => {
  const result = engine.executeAnalyticalQuery(fixture, { filters: [{ column: 'day', op: 'gte', value: '2026-02-01' }], aggregations: [{ func: 'SUM', column: 'amount', alias: 'sum' }] });
  assert.equal(result.summary.sum, 200);
});
test('multi-sheet workbook persists and queries the selected sheet', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Amount'], [10]]), 'January');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Cost'], [20], [30]]), 'February');
  const metadata = { file_id: 'two-sheets', file_extension: '.xlsx', original_filename: 'Synthetic.xlsx' };
  const { dataProfile } = await engine.processAndProfileDataset(metadata, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const selected = await engine.getDatasetForSheet({ ...metadata, profile: dataProfile }, 'February');
  assert.equal(selected.profile.active_sheet, 'February');
  const result = await engine.queryIsolatedDataset(metadata.file_id, { target_sheet: 'February', aggregations: [{ func: 'SUM', column: 'cost', alias: 'cost_total' }] });
  assert.equal(result.summary.cost_total, 50);
  await assert.rejects(engine.queryIsolatedDataset(metadata.file_id, { target_sheet: 'Missing' }), { code: 'SHEET_NOT_FOUND' });
});
test('expiry and broken state are checked before owner/ADMIN bypass', () => {
  const base = { uploaded_by: owner.user_id, company_id: 'STL', processing_status: 'READY' };
  assert.equal(registry.canUserAccessDataset({ ...base, retention_expiry: '2020-01-01' }, owner, 'query').allowed, false);
  assert.equal(registry.canUserAccessDataset({ ...base, processing_status: 'MISSING_DATA' }, { ...owner, role: 'ADMIN' }, 'query').allowed, false);
});
test('registry persist failure is reported and does not leave a successful cached entry', async () => {
  const rename = fs.promises.rename;
  const copyFileSync = fs.copyFileSync;
  fs.promises.rename = async () => { throw new Error('Synthetic disk failure'); };
  fs.copyFileSync = () => { throw new Error('Synthetic disk failure'); };
  try { await assert.rejects(registry.registerDataset({ file_id: 'failed-save' }), { code: 'REGISTRY_WRITE_FAILED' }); }
  finally { fs.promises.rename = rename; fs.copyFileSync = copyFileSync; }
  assert.equal(registry.getDataset('failed-save'), null);
});
test('privacy masking is uniform for report rows and profile values', () => {
  const data = sanitizeBiData({ cccd: 'SYNTHETIC_ID', email: 'fixture@example.invalid', password: 'synthetic', sum_salary: 100 });
  assert.equal(data.cccd, 'SYN******_ID');
  assert.equal(data.email, 'fi***@example.invalid');
  assert.equal('password' in data, false);
  assert.equal(data.sum_salary, 100);
  const p = sanitizeBiProfile({ columns: [{ key: 'cccd', top_values: [{ value: 'SYNTHETIC_ID' }], min: 123 }], preview_rows: [{ cccd: 'SYNTHETIC_ID' }] });
  assert.equal(p.columns[0].top_values[0].value, '[Đã ẩn]');
  assert.equal(p.columns[0].min, null);
});
test('failed concurrent registry writes cannot report phantom success', async () => {
  const rename = fs.promises.rename;
  const copyFileSync = fs.copyFileSync;
  fs.promises.rename = async () => { throw new Error('Synthetic concurrent disk failure'); };
  fs.copyFileSync = () => { throw new Error('Synthetic concurrent disk failure'); };
  let results;
  try { results = await Promise.allSettled([registry.registerDataset({ file_id: 'concurrent-one' }), registry.registerDataset({ file_id: 'concurrent-two' })]); }
  finally { fs.promises.rename = rename; fs.copyFileSync = copyFileSync; }
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'REGISTRY_WRITE_FAILED'));
  assert.equal(registry.getDataset('concurrent-one'), null);
  assert.equal(registry.getDataset('concurrent-two'), null);
});
test('follow-up retains approved KPI and rejects impossible calendar date', async () => {
  const helper = require('../auth-service/services/biReportingHelper');
  const history = '```bi-report\n' + JSON.stringify({ results: [{ kpi: 'INTAKE_UPLOADS' }] }) + '\n```';
  const follow = helper.detectBIIntent('Còn tháng trước?', history, owner);
  assert.deepEqual(follow.kpiCodes, ['INTAKE_UPLOADS']); assert.equal(follow.companyId, 'STL');
  const invalid = helper.detectBIIntent('Báo cáo tiếp nhận hồ sơ từ 31/02/2026 đến 01/03/2026', '', owner);
  assert.equal(invalid.invalidDateRange, true);
  assert.equal((await helper.executeBIReporting(invalid, owner)).code, 'INVALID_DATE_RANGE');
});
test('query validator rejects identifier extrema and invalid dates; audit keeps provenance only', () => {
  const { validateQueryPlan } = require('../auth-service/services/biQueryValidator');
  const dataset = { file_id: 'validation', uploaded_by: owner.user_id, company_id: 'STL', processing_status: 'READY', profile: { active_sheet: 'Sheet1', columns: [{ key: 'cccd', type: 'INTEGER' }, { key: 'day', type: 'DATE' }] } };
  assert.throws(() => validateQueryPlan({ aggregations: [{ column: 'cccd', func: 'MIN', alias: 'first' }] }, dataset, owner), { code: 'PERSONAL_IDENTIFIER_AGGREGATION' });
  assert.throws(() => validateQueryPlan({ filters: [{ column: 'day', op: 'gte', value: '2026-02-31' }] }, dataset, owner), { code: 'INVALID_DATE_FILTER' });
  const { sanitizeAuditDetails } = require('../auth-service/services/biAuditLogger');
  const audit = sanitizeAuditDetails({ request_id: 'fixture', company_id: 'STL', manifest_sha256: 'fixture', source_tables: ['public.documents'], returned_rows: 1, raw_rows: [{ cccd: 'fixture' }], sql: 'private SQL' });
  assert.equal(audit.request_id, 'fixture'); assert.equal(audit.returned_rows, 1); assert.equal('raw_rows' in audit, false); assert.equal('sql' in audit, false);
});
test('partial OCR produces a valid conditional v2 card', () => {
  const md = formatBIReportMarkdown({ companyId: 'STL', periodLabel: 'Fixture', results: [{ kpi: 'OCR_QUALITY', status: 'PARTIALLY_AVAILABLE', data: { avg_doc_parse_quality: 90, measured_docs: 5, total_docs: 9 }, warnings: [], metadata: {} }] });
  const json = md.match(/<!-- bi-dashboard-v2: (.*?) -->/s);
  assert.ok(json);
  assert.equal(JSON.parse(json[1]).kpi_strip[0].status, 'CONDITIONAL');
  assert.equal(JSON.parse(json[1]).kpi_strip[0].primary_value, 90);
});
test.after(() => {
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('sotrans-bi-release-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
