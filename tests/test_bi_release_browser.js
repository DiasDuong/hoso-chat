'use strict';
// Actual browser + file/query/export routes, isolated synthetic storage and auth.
// This is a fixture acceptance test, not a production login/LLM test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sotrans-bi-browser-'));
process.env.BI_STORAGE_DIR = tmp;
process.env.JWT_SECRET = 'isolated-browser-fixture-signing-secret';
const user = { user_id: 'fixture-browser', role: 'HR', company_id: 'STL', status: 'ACTIVE' };
for (const [name, exports] of [
  ['audit', { logAudit: async () => {} }],
  ['db', { query: async () => { throw new Error('Database access forbidden in browser fixture'); } }],
  ['middleware/auth', { verifyToken: (req, res, next) => { req.user = user; next(); } }],
]) {
  const file = require.resolve(`../auth-service/${name}`);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const express = require('../auth-service/node_modules/express');
const XLSX = require('../auth-service/node_modules/xlsx');
const { chromium } = require('../auth-service/node_modules/playwright-core');
const engine = require('../auth-service/services/biSpreadsheetEngine');
const registry = require('../auth-service/services/biDatasetRegistry');
const { validateQueryPlan } = require('../auth-service/services/biQueryValidator');
const { buildDatasetDashboard } = require('../auth-service/services/biReportBuilder');

(async () => {
  let browser, server;
  const checks = [];
  try {
    const rows = [['Department', 'Day', 'Amount']];
    for (let dept = 0; dept < 4; dept++) for (let month = 1; month <= 8; month++) rows.push([String.fromCharCode(65 + dept), `2026-${String(month).padStart(2, '0')}-01`, (dept + 1) * 10 + month]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Metrics');
    const metadata = { file_id: 'browser-fixture', file_extension: '.xlsx', original_filename: 'Synthetic BI.xlsx', company_id: 'STL', uploaded_by: user.user_id, processing_status: 'PROCESSING' };
    const { dataProfile } = await engine.processAndProfileDataset(metadata, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    await registry.registerDataset(metadata, user);
    const dataset = await registry.updateDataset(metadata.file_id, { processing_status: 'READY', profile: dataProfile });
    const plan = validateQueryPlan({ groupBy: ['department', { column: 'day', date_trunc: 'month' }], aggregations: [{ column: 'amount', func: 'SUM', alias: 'total' }, { column: 'amount', func: 'AVG', alias: 'average' }, { column: 'amount', func: 'COUNT', alias: 'entries' }], limit: 500, chart_preference: 'BAR' }, dataset, user);
    const result = await engine.queryIsolatedDataset(dataset.file_id, plan);
    const payload = buildDatasetDashboard(plan, result, dataset, user);
    assert.equal(result.summary.total, 944);
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use('/api/analytics/files', require('../auth-service/routes/bi_files'));
    app.use('/api/analytics/export', require('../auth-service/routes/bi_exports'));
    app.use(express.static(path.join(root, 'chat')));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
    await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const missing = await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'isolated-metric-chart'; host.style.cssText = 'width:400px;height:300px'; document.body.appendChild(host);
      const config = { id: 'isolated-metric', chart_type: 'LINE', data_ref: 'd', mapping: { category: 'label', value: 'value' } };
      const store = { d: [{ label: 'Missing', value: null }, { label: 'Negative', value: -2 }] };
      let chart = window.renderEChartInstance(host, config, store); const line = chart.getOption().series[0].data;
      chart = window.renderEChartInstance(host, { ...config, chart_type: 'PIE' }, store); const negative = chart.getOption().series[0];
      chart.dispose(); host._biResizeObserver?.disconnect(); window._biEchartInstances.delete(host.id); host.remove();
      return { line, type: negative.type, data: negative.data };
    });
    assert.deepEqual(missing.line, [null, -2]); assert.equal(missing.type, 'bar'); assert.deepEqual(missing.data, [null, -2]); checks.push('Missing chart values remain gaps; negative pie falls back to bar');
    await page.evaluate(p => {
      window.getAuthToken = () => 'synthetic-fixture-auth';
      const overlay = document.createElement('main'); overlay.id = 'fixture-dashboard'; overlay.style.cssText = 'position:absolute;inset:0;z-index:999999;background:#f3f6fc;padding:24px;min-height:100vh;overflow:auto';
      overlay.innerHTML = window.parseMarkdown(`<!-- bi-dashboard-v2: ${JSON.stringify(p)} -->`);
      document.body.appendChild(overlay); window.mountBIDashboardsInElement(overlay);
    }, payload);
    const dashboard = () => page.locator('#fixture-dashboard .bi-interactive-dashboard');
    await page.waitForFunction(() => document.querySelectorAll('#fixture-dashboard canvas').length >= 3);
    assert.equal(await dashboard().locator('.bi-chart-host').count(), 3); checks.push('Three actual ECharts canvases and four KPI cards');
    assert.match(await dashboard().locator('.bi-table-actions').innerText(), /1\/3.*32/);
    await dashboard().locator('[data-bi-action="next"]').click();
    assert.match(await dashboard().locator('.bi-table-actions').innerText(), /2\/3/); checks.push('Table pagination');
    await dashboard().locator('[data-bi-sort="total"]').click();
    await dashboard().locator('[data-bi-search]').fill('2026-08');
    await dashboard().locator('[data-bi-search]').dispatchEvent('change');
    assert.match(await dashboard().locator('.bi-table-actions').innerText(), /4 dòng/); checks.push('Table sort and search');
    await dashboard().locator('[data-bi-search]').fill(''); await dashboard().locator('[data-bi-search]').dispatchEvent('change');
    const oldId = await dashboard().getAttribute('data-dash-id');
    await dashboard().locator('[data-bi-dimension="department"]').selectOption('A');
    await page.waitForFunction(id => document.querySelector('#fixture-dashboard .bi-interactive-dashboard')?.dataset.dashId !== id, oldId);
    const afterFilter = await page.evaluate(() => window._biDashboardPayloadStore.get(document.querySelector('#fixture-dashboard .bi-interactive-dashboard').dataset.dashId));
    assert.equal(afterFilter.kpi_strip[0].primary_value, 116); checks.push('Category filter re-queries actual server route; KPI 944 to 116');
    let old = await dashboard().getAttribute('data-dash-id');
    await dashboard().locator('[data-bi-range="day"][data-bound="from"]').fill('2026-07-01');
    await dashboard().locator('[data-bi-range="day"][data-bound="from"]').dispatchEvent('change');
    await page.waitForFunction(id => document.querySelector('#fixture-dashboard .bi-interactive-dashboard')?.dataset.dashId !== id, old);
    assert.equal(await page.evaluate(() => window._biDashboardPayloadStore.get(document.querySelector('#fixture-dashboard .bi-interactive-dashboard').dataset.dashId).kpi_strip[0].primary_value), 35); checks.push('Date filter re-computes full filtered summary');
    const downloaded = page.waitForEvent('download'); await dashboard().locator('[data-bi-action="xlsx"]').click();
    const download = await downloaded; const downloadPath = await download.path(); const exported = XLSX.readFile(downloadPath);
    assert.ok(exported.SheetNames.includes('Provenance'));
    assert.equal(XLSX.utils.sheet_to_json(exported.Sheets.Data_1).length, 2); checks.push('Signed Excel export matches category/date filters');
    const invalid = await page.evaluate(async () => {
      const p = structuredClone(window._biDashboardPayloadStore.get(document.querySelector('#fixture-dashboard .bi-interactive-dashboard').dataset.dashId)); p.title = 'tampered';
      return (await fetch('/api/analytics/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: p }) })).status;
    }); assert.equal(invalid, 403); checks.push('Tampered export rejected');
    old = await dashboard().getAttribute('data-dash-id'); await dashboard().locator('[data-bi-action="reset"]').click();
    await page.waitForFunction(id => document.querySelector('#fixture-dashboard .bi-interactive-dashboard')?.dataset.dashId !== id, old);
    assert.equal(await page.evaluate(() => window._biDashboardPayloadStore.get(document.querySelector('#fixture-dashboard .bi-interactive-dashboard').dataset.dashId).kpi_strip[0].primary_value), 944);
    // Dispatch ECharts' actual event bus; exercises shared filter and drill handler.
    await page.evaluate(() => {
      const host = document.querySelector('#fixture-dashboard .bi-chart-host'); window.echarts.getInstanceByDom(host).getZr();
      window.echarts.getInstanceByDom(host).trigger('click', { dataIndex: 0 });
    });
    await page.waitForFunction(() => {
      const p = window._biDashboardPayloadStore.get(document.querySelector('#fixture-dashboard .bi-interactive-dashboard').dataset.dashId);
      return p.kpi_strip[0].primary_value < 944;
    }); checks.push('Reset, chart event cross-filter and drill');
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    await dashboard().screenshot({ path: path.join(root, 'reports/BI_WREN_RELEASE_BROWSER.png') });
    await page.evaluate(() => { window.__printed = false; const nativeOpen = document.createElement.bind(document); document.createElement = function(name, ...args) { const el = nativeOpen(name, ...args); if (name === 'iframe') setTimeout(() => { el.contentWindow.print = () => { window.__printed = true; }; }, 0); return el; }; });
    await dashboard().locator('[data-bi-action="pdf"]').click();
    await page.waitForFunction(() => window.__printed); checks.push('PDF print document with chart images');
    console.log(JSON.stringify({ passed: checks.length, checks, fixture: true }, null, 2));
    fs.writeFileSync(path.join(root, 'reports/BI_WREN_RELEASE_BROWSER.json'), JSON.stringify({ passed: checks.length, checks, fixture: true }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const resolved = fs.realpathSync(tmp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('sotrans-bi-browser-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
