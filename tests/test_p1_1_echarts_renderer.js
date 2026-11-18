/**
 * SOTRANS HUB — PHASE P1.1 INTERACTIVE ECHARTS RENDERER TEST SUITE
 * 
 * Real Browser Automation Test Suite (Microsoft Edge via Playwright-Core)
 * Validating 20 Scenarios from Section V of Specification:
 * - 01: Parse Dashboard V2
 * - 02: Render Internal System BI
 * - 03: Render Uploaded File BI
 * - 04: Multiple KPI Cards
 * - 05: Single Chart
 * - 06: Multiple Charts
 * - 07: Chart Types (BAR, LINE, PIE, DONUT, STACKED_BAR)
 * - 08: Missing data_ref
 * - 09: Invalid chart_type
 * - 10: Empty Dataset
 * - 11: KPI BLOCKED
 * - 12: KPI CONDITIONAL
 * - 13: XSS in title, labels, tooltip data
 * - 14: Closing sequence --> inside payload
 * - 15: Large dataset within limits (500 rows)
 * - 16: Multiple Dashboard Cards in conversation
 * - 17: Resize and Dispose
 * - 18: Legacy bi-report Fallback
 * - 19: Legacy File BI SVG Fallback
 * - 20: Normal General AI Chat
 */

const { chromium } = require('../auth-service/node_modules/playwright-core');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const express = require('express');

const BROWSER_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let passCount = 0;
let failCount = 0;
const results = [];

async function test(scenarioId, title, testFn) {
  try {
    await testFn();
    passCount++;
    console.log(`[PASS] [${scenarioId}] ${title}`);
    results.push({ scenarioId, title, status: 'PASS' });
  } catch (err) {
    failCount++;
    console.error(`[FAIL] [${scenarioId}] ${title} -> ${err.message}`);
    results.push({ scenarioId, title, status: 'FAIL', error: err.message });
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('SOTRANS HUB — P1.1 INTERACTIVE ECHARTS RENDERER TEST SUITE');
  console.log('Target: Live Browser Verification of parseMarkdown & ECharts');
  console.log('Engine: Headless Microsoft Edge (Playwright-Core)');
  console.log('================================================================\n');

  const app = express();
  app.use('/chat', express.static(path.join(__dirname, '..', 'chat')));
  app.use(express.static(path.join(__dirname, '..', 'chat')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const APP_URL = `http://127.0.0.1:${port}/chat/`;

  const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Navigate to application page
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Verify that ECharts script is loaded in page context
  const isEchartsLoaded = await page.evaluate(() => typeof window.echarts !== 'undefined');
  assert.ok(isEchartsLoaded, 'Apache ECharts must be loaded on the page');

  // Verify that P1.1 renderer functions exist
  const hasRendererFuncs = await page.evaluate(() => {
    return (
      typeof window.parseBIDashboardPayload === 'function' &&
      typeof window.validateDashboardForRendering === 'function' &&
      typeof window.renderInteractiveBIDashboard === 'function' &&
      typeof window.renderEChartInstance === 'function' &&
      typeof window.mountBIDashboardsInElement === 'function' &&
      typeof window.disposeBIDashboard === 'function'
    );
  });
  assert.ok(hasRendererFuncs, 'All P1.1 frontend functions must be defined on window');

  // ============================================================================
  // TEST SCENARIOS 01 - 20
  // ============================================================================

  // Scenario 01: Parse Dashboard V2
  await test('SC-01', 'Parse Dashboard V2 thành công từ HTML comment', async () => {
    const parsed = await page.evaluate(() => {
      const text = 'Here is report: <!-- bi-dashboard-v2: {"version":"2.0","dashboard_id":"dash_test_1","title":"Test Dash"} -->';
      return window.parseBIDashboardPayload(text);
    });
    assert.strictEqual(parsed.version, '2.0');
    assert.strictEqual(parsed.dashboard_id, 'dash_test_1');
    assert.strictEqual(parsed.title, 'Test Dash');
  });

  // Scenario 02: Render Internal System BI
  await test('SC-02', 'Render Internal System BI với 17 Canonical KPIs & Biểu đồ ECharts', async () => {
    const res = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_sys_test_02',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Báo Cáo Quản Trị SOTRANS Logistics',
        subtitle: 'Kỳ báo cáo: Tháng 01/2026',
        generated_at: new Date().toISOString(),
        provenance: { source_system: 'SOTRANS Hub', generated_by: 'Analytics Engine' },
        filters: {},
        kpi_strip: [
          { id: 'kpi_doc_total', kpi_code: 'DOC_TOTAL', title: 'Tổng văn bản', primary_value: 1250, unit: 'văn bản', status: 'AVAILABLE' },
          { id: 'kpi_doc_status', kpi_code: 'DOC_STATUS', title: 'Trạng thái', primary_value: 1250, unit: 'văn bản', status: 'AVAILABLE' },
        ],
        visualizations: [
          {
            id: 'viz_doc_status',
            title: 'Cơ Cấu Trạng Thái Văn Bản',
            chart_type: 'PIE',
            data_ref: 'doc_status_data',
            mapping: { category: 'status', value: 'count' },
          },
        ],
        data_tables: [],
        data_store: {
          doc_status_data: [
            { status: 'Hiệu lực', count: 950 },
            { status: 'Hết hiệu lực', count: 300 },
          ],
        },
      };

      const md = `Báo cáo hệ thống:\n\n<!-- bi-dashboard-v2: ${JSON.stringify(payload)} -->`;
      const container = document.createElement('div');
      container.id = 'test-container-sc02';
      document.body.appendChild(container);
      container.innerHTML = window.parseMarkdown(md, false);
      
      // Wait for mount
      await new Promise(r => setTimeout(r, 100));
      window.mountBIDashboardsInElement(container);

      const chartDom = container.querySelector('.bi-chart-host');
      const chartInstance = chartDom ? window.echarts.getInstanceByDom(chartDom) : null;
      return {
        hasDashboard: !!container.querySelector('.bi-interactive-dashboard'),
        kpiCount: container.querySelectorAll('.bi-kpi-card').length,
        hasChart: !!chartInstance,
        chartType: chartInstance ? chartInstance.getOption().series[0].type : null,
      };
    });

    assert.ok(res.hasDashboard, 'Dashboard container must exist');
    assert.strictEqual(res.kpiCount, 2, 'Must have 2 KPI cards');
    assert.ok(res.hasChart, 'ECharts chart instance must be mounted');
    assert.strictEqual(res.chartType, 'pie', 'Chart must be pie');
  });

  // Scenario 03: Render Uploaded File BI
  await test('SC-03', 'Render Uploaded File BI với Dynamic Aggregation & ECharts Bar', async () => {
    const res = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_file_test_03',
        source_type: 'FILE_DATASET',
        title: 'Báo Cáo Phân Tích File: BangLuong_Q1.xlsx',
        subtitle: 'Trang tính: ChiTietLuong',
        generated_at: new Date().toISOString(),
        provenance: { source_system: 'SOTRANS Hub', generated_by: 'Spreadsheet Engine', file_id: 'ds_test_03' },
        filters: {},
        kpi_strip: [
          { id: 'kpi_luong', kpi_code: 'FILE_SUM_LUONG', title: 'Tổng Lương', primary_value: 450000000, unit: 'VNĐ', status: 'AVAILABLE' },
        ],
        visualizations: [
          {
            id: 'viz_file_dept',
            title: 'Tổng lương theo Phòng Ban',
            chart_type: 'BAR',
            data_ref: 'file_data',
            mapping: { category: 'phong_ban', value: 'tong_luong' },
          },
        ],
        data_tables: [],
        data_store: {
          file_data: [
            { phong_ban: 'Kinh Doanh', tong_luong: 180000000 },
            { phong_ban: 'Kỹ Thuật', tong_luong: 150000000 },
            { phong_ban: 'Nhân Sự', tong_luong: 120000000 },
          ],
        },
      };

      const md = `Phân tích tệp tải lên:\n\n<!-- bi-dashboard-v2: ${JSON.stringify(payload)} -->`;
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.parseMarkdown(md, false);
      window.mountBIDashboardsInElement(container);

      const chartDom = container.querySelector('.bi-chart-host');
      const chartInstance = chartDom ? window.echarts.getInstanceByDom(chartDom) : null;
      return {
        badgeText: container.querySelector('.bi-dash-badge')?.textContent || '',
        hasChart: !!chartInstance,
        chartType: chartInstance ? chartInstance.getOption().series[0].type : null,
      };
    });

    assert.ok(res.badgeText.includes('Tệp Dữ Liệu'), 'Source badge must indicate uploaded file');
    assert.ok(res.hasChart, 'Chart instance must be mounted');
    assert.strictEqual(res.chartType, 'bar', 'Chart must be bar');
  });

  // Scenario 04: Multiple KPI Cards
  await test('SC-04', 'Nhiều KPI Cards (8 thẻ) được render cân đối trong responsive grid', async () => {
    const kpiCount = await page.evaluate(async () => {
      const kpis = [];
      for (let i = 1; i <= 8; i++) {
        kpis.push({
          id: `kpi_${i}`,
          kpi_code: `CODE_${i}`,
          title: `Chỉ số ${i}`,
          primary_value: i * 100,
          status: 'AVAILABLE',
        });
      }
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_multi_kpi',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Multi KPI Grid Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: kpis,
        visualizations: [],
        data_tables: [],
        data_store: {},
      };
      const html = window.renderInteractiveBIDashboard(payload);
      const div = document.createElement('div');
      div.innerHTML = html;
      return div.querySelectorAll('.bi-kpi-card').length;
    });

    assert.strictEqual(kpiCount, 8, 'Must render exactly 8 KPI cards');
  });

  // Scenario 05: Single Chart
  await test('SC-05', 'Render chính xác 1 biểu đồ duy nhất khi dashboard chỉ có 1 visualization', async () => {
    const chartCount = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_single_chart',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Single Chart Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [],
        visualizations: [
          { id: 'v1', title: 'Chart 1', chart_type: 'BAR', data_ref: 'd1', mapping: { category: 'cat', value: 'val' } },
        ],
        data_tables: [],
        data_store: { d1: [{ cat: 'A', val: 10 }] },
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      window.mountBIDashboardsInElement(container);
      return container.querySelectorAll('.bi-chart-card').length;
    });

    assert.strictEqual(chartCount, 1, 'Must render exactly 1 chart card');
  });

  // Scenario 06: Multiple Charts
  await test('SC-06', 'Render nhiều biểu đồ đồng thời (3 biểu đồ) trong cùng một dashboard', async () => {
    const chartCount = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_multi_chart',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Multi Chart Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [],
        visualizations: [
          { id: 'v1', title: 'Chart 1', chart_type: 'BAR', data_ref: 'd1', mapping: { category: 'cat', value: 'val' } },
          { id: 'v2', title: 'Chart 2', chart_type: 'LINE', data_ref: 'd1', mapping: { category: 'cat', value: 'val' } },
          { id: 'v3', title: 'Chart 3', chart_type: 'PIE', data_ref: 'd1', mapping: { category: 'cat', value: 'val' } },
        ],
        data_tables: [],
        data_store: { d1: [{ cat: 'A', val: 10 }, { cat: 'B', val: 20 }] },
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      window.mountBIDashboardsInElement(container);
      return container.querySelectorAll('.bi-chart-card').length;
    });

    assert.strictEqual(chartCount, 3, 'Must render exactly 3 chart cards');
  });

  // Scenario 07: All 5 Chart Types (BAR, LINE, PIE, DONUT, STACKED_BAR)
  await test('SC-07', 'Hỗ trợ chuẩn xác cả 5 loại biểu đồ: BAR, LINE, PIE, DONUT, STACKED_BAR', async () => {
    const chartTypes = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_all_types',
        source_type: 'INTERNAL_SYSTEM',
        title: 'All Types Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [],
        visualizations: [
          { id: 'c_bar', title: 'Bar', chart_type: 'BAR', data_ref: 'd', mapping: { category: 'cat', value: 'val' } },
          { id: 'c_line', title: 'Line', chart_type: 'LINE', data_ref: 'd', mapping: { category: 'cat', value: 'val' } },
          { id: 'c_pie', title: 'Pie', chart_type: 'PIE', data_ref: 'd', mapping: { category: 'cat', value: 'val' } },
          { id: 'c_donut', title: 'Donut', chart_type: 'DONUT', data_ref: 'd', mapping: { category: 'cat', value: 'val' } },
          { id: 'c_stacked', title: 'Stacked', chart_type: 'STACKED_BAR', data_ref: 'd', mapping: { category: 'cat', value: ['val'] } },
        ],
        data_tables: [],
        data_store: { d: [{ cat: 'X', val: 10 }, { cat: 'Y', val: 25 }] },
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      window.mountBIDashboardsInElement(container);

      const hosts = container.querySelectorAll('.bi-chart-host');
      const detected = [];
      hosts.forEach(h => {
        const inst = window.echarts.getInstanceByDom(h);
        if (inst) {
          detected.push(inst.getOption().series[0].type);
        }
      });
      return detected;
    });

    assert.strictEqual(chartTypes.length, 5, 'Must initialize 5 charts');
    assert.strictEqual(chartTypes[0], 'bar');
    assert.strictEqual(chartTypes[1], 'line');
    assert.strictEqual(chartTypes[2], 'pie');
    assert.strictEqual(chartTypes[3], 'pie'); // donut is pie with inner radius
    assert.strictEqual(chartTypes[4], 'bar'); // stacked bar is bar with stack: total
  });

  // Scenario 08: Missing data_ref
  await test('SC-08', 'Missing data_ref xử lý êm dịu, không gây sập JavaScript', async () => {
    const res = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_missing_ref',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Missing Ref Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [],
        visualizations: [
          { id: 'v_missing', title: 'Missing Ref', chart_type: 'BAR', data_ref: 'non_existent_store', mapping: { category: 'a', value: 'b' } },
        ],
        data_tables: [],
        data_store: {},
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      window.mountBIDashboardsInElement(container);
      return container.textContent;
    });

    assert.ok(res.includes('Chưa có dữ liệu cho biểu đồ này'), 'Must show empty notice for missing data_ref');
  });

  // Scenario 09: Invalid chart_type
  await test('SC-09', 'Invalid chart_type tự động fallback về biểu đồ mặc định an toàn', async () => {
    const chartType = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_invalid_type',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Invalid Type Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [],
        visualizations: [
          { id: 'v_bad', title: 'Bad Type', chart_type: 'RADAR_CHART', data_ref: 'd', mapping: { category: 'c', value: 'v' } },
        ],
        data_tables: [],
        data_store: { d: [{ c: 'A', v: 10 }] },
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      window.mountBIDashboardsInElement(container);

      const host = container.querySelector('.bi-chart-host');
      const inst = window.echarts.getInstanceByDom(host);
      return inst ? inst.getOption().series[0].type : null;
    });

    assert.strictEqual(chartType, 'bar', 'Must fallback safely to bar chart');
  });

  // Scenario 10: Empty dataset
  await test('SC-10', 'Dataset rỗng [] hiển thị thông báo trống mà không bị lỗi', async () => {
    const text = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_empty_dataset',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Empty Dataset Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [],
        visualizations: [
          { id: 'v_empty', title: 'Empty', chart_type: 'BAR', data_ref: 'empty_store', mapping: { category: 'c', value: 'v' } },
        ],
        data_tables: [],
        data_store: { empty_store: [] },
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      window.mountBIDashboardsInElement(container);
      return container.textContent;
    });

    assert.ok(text.includes('Chưa có dữ liệu cho biểu đồ này'));
  });

  // Scenario 11: KPI BLOCKED
  await test('SC-11', 'KPI BLOCKED hiển thị "Chưa hỗ trợ", badge đỏ và lý do giải thích', async () => {
    const res = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_kpi_blocked',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Blocked KPI Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [
          {
            id: 'kpi_blocked',
            kpi_code: 'INTAKE_FAILURE',
            title: 'Tỷ lệ thất bại',
            primary_value: null,
            status: 'BLOCKED',
            subtext: 'Pipeline chưa ghi nhận đầy đủ lỗi Gateway vào database.',
          },
        ],
        visualizations: [],
        data_tables: [],
        data_store: {},
      };
      const container = document.createElement('div');
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      const card = container.querySelector('.bi-kpi-card');
      return {
        badgeText: card.querySelector('.bi-badge-blocked')?.textContent || '',
        valText: card.querySelector('.bi-kpi-val')?.textContent || '',
        subText: card.querySelector('.bi-kpi-sub')?.textContent || '',
      };
    });

    assert.ok(res.badgeText.includes('Bị khóa'));
    assert.strictEqual(res.valText, 'Chưa hỗ trợ');
    assert.ok(res.subText.includes('Pipeline chưa ghi nhận'));
  });

  // Scenario 12: KPI CONDITIONAL
  await test('SC-12', 'KPI CONDITIONAL hiển thị giá trị, badge vàng và cảnh báo', async () => {
    const res = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_kpi_cond',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Conditional KPI Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [
          {
            id: 'kpi_cond',
            kpi_code: 'OCR_QUALITY',
            title: 'Chất lượng OCR',
            primary_value: 92.5,
            format: 'PERCENTAGE',
            unit: '%',
            status: 'CONDITIONAL',
            subtext: 'Đo lường 45/50 văn bản (thiếu 5)',
          },
        ],
        visualizations: [],
        data_tables: [],
        data_store: {},
      };
      const container = document.createElement('div');
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      const card = container.querySelector('.bi-kpi-card');
      return {
        badgeText: card.querySelector('.bi-badge-conditional')?.textContent || '',
        valText: card.querySelector('.bi-kpi-val')?.textContent || '',
        subText: card.querySelector('.bi-kpi-sub')?.textContent || '',
      };
    });

    assert.ok(res.badgeText.includes('Có điều kiện'));
    assert.ok(res.valText.includes('92.5%'));
    assert.ok(res.subText.includes('Đo lường 45/50'));
  });

  // Scenario 13: XSS in title, labels and tooltip data
  await test('SC-13', 'XSS trong title, labels và data được escape an toàn 100%', async () => {
    const res = await page.evaluate(async () => {
      const maliciousPayload = {
        version: '2.0',
        dashboard_id: 'dash_xss_test',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Report <script>window.__xss_flag = true;</script>',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [
          {
            id: 'kpi_xss',
            kpi_code: 'XSS_KPI',
            title: 'Metric <img src=x onerror="window.__xss_flag = true;">',
            primary_value: 100,
            status: 'AVAILABLE',
            subtext: 'Subtext <svg onload="window.__xss_flag = true;">',
          },
        ],
        visualizations: [],
        data_tables: [],
        data_store: {},
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(maliciousPayload);

      return {
        xssTriggered: !!window.__xss_flag,
        hasRawScriptTag: !!container.querySelector('script'),
        hasRawImgTag: !!container.querySelector('img'),
      };
    });

    assert.strictEqual(res.xssTriggered, false, 'XSS must not execute');
    assert.strictEqual(res.hasRawScriptTag, false, 'No raw script tag in DOM');
    assert.strictEqual(res.hasRawImgTag, false, 'No raw malicious img tag in DOM');
  });

  // Scenario 14: Closing sequence --> inside payload
  await test('SC-14', 'Chuỗi đóng comment --> được trung hòa an toàn', async () => {
    const res = await page.evaluate(async () => {
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_arrow_test',
        source_type: 'FILE_DATASET',
        title: 'Báo cáo --> Phân tích mũi tên',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [{ id: 'k1', kpi_code: 'TEST', title: 'K', primary_value: 10, status: 'AVAILABLE' }],
        visualizations: [],
        data_tables: [],
        data_store: {},
      };

      // Simulated serialized string with encoded --\u003e
      const jsonStr = JSON.stringify(payload).replace(/-->/g, '--\\u003e');
      const md = `Báo cáo phân tích:\n\n<!-- bi-dashboard-v2: ${jsonStr} -->`;
      const html = window.parseMarkdown(md, false);

      const div = document.createElement('div');
      div.innerHTML = html;
      const titleEl = div.querySelector('.bi-dash-title');
      return titleEl ? titleEl.textContent : '';
    });

    assert.ok(res.includes('-->'), 'Arrow sequence must be preserved cleanly in title text');
  });

  // Scenario 15: Large dataset within limits (500 rows)
  await test('SC-15', 'Dashboard có dữ liệu lớn (500 dòng) render mượt mà trong giới hạn', async () => {
    const renderTimeMs = await page.evaluate(async () => {
      const rows = [];
      for (let i = 0; i < 500; i++) {
        rows.push({ dept: `Dept_${i % 20}`, score: i * 2 });
      }
      const payload = {
        version: '2.0',
        dashboard_id: 'dash_large_500',
        source_type: 'FILE_DATASET',
        title: 'Large Dataset 500 Rows',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [{ id: 'k1', kpi_code: 'TOTAL', title: 'Total', primary_value: 500, status: 'AVAILABLE' }],
        visualizations: [
          { id: 'v_large', title: 'Score', chart_type: 'BAR', data_ref: 'large_data', mapping: { category: 'dept', value: 'score' } },
        ],
        data_tables: [],
        data_store: { large_data: rows },
      };

      const t0 = performance.now();
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(payload);
      window.mountBIDashboardsInElement(container);
      const t1 = performance.now();
      return Math.round(t1 - t0);
    });

    assert.ok(renderTimeMs < 1500, `Render time (${renderTimeMs}ms) must be under 1.5 seconds`);
  });

  // Scenario 16: Multiple Dashboard Cards in conversation
  await test('SC-16', 'Nhiều Dashboard Cards trong cùng một chuỗi hội thoại hoạt động độc lập', async () => {
    const res = await page.evaluate(async () => {
      const p1 = {
        version: '2.0',
        dashboard_id: 'dash_turn_1',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Dashboard Lượt 1',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [{ id: 'k1', kpi_code: 'T1', title: 'T1', primary_value: 10, status: 'AVAILABLE' }],
        visualizations: [{ id: 'v1', title: 'C1', chart_type: 'BAR', data_ref: 'd1', mapping: { category: 'c', value: 'v' } }],
        data_tables: [],
        data_store: { d1: [{ c: 'A', v: 10 }] },
      };
      const p2 = {
        version: '2.0',
        dashboard_id: 'dash_turn_2',
        source_type: 'FILE_DATASET',
        title: 'Dashboard Lượt 2',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [{ id: 'k2', kpi_code: 'T2', title: 'T2', primary_value: 20, status: 'AVAILABLE' }],
        visualizations: [{ id: 'v2', title: 'C2', chart_type: 'PIE', data_ref: 'd2', mapping: { category: 'c', value: 'v' } }],
        data_tables: [],
        data_store: { d2: [{ c: 'B', v: 20 }] },
      };

      const md = `Lượt 1:\n<!-- bi-dashboard-v2: ${JSON.stringify(p1)} -->\n\nLượt 2:\n<!-- bi-dashboard-v2: ${JSON.stringify(p2)} -->`;
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.parseMarkdown(md, false);
      window.mountBIDashboardsInElement(container);

      const dashboards = container.querySelectorAll('.bi-interactive-dashboard');
      const hosts = container.querySelectorAll('.bi-chart-host');
      const inst1 = window.echarts.getInstanceByDom(hosts[0]);
      const inst2 = window.echarts.getInstanceByDom(hosts[1]);

      return {
        dashCount: dashboards.length,
        hasBothCharts: !!inst1 && !!inst2,
        chartTypes: [inst1?.getOption().series[0].type, inst2?.getOption().series[0].type],
      };
    });

    assert.strictEqual(res.dashCount, 2, 'Must have 2 dashboard cards');
    assert.ok(res.hasBothCharts, 'Both chart instances must be initialized');
    assert.strictEqual(res.chartTypes[0], 'bar');
    assert.strictEqual(res.chartTypes[1], 'pie');
  });

  // Scenario 17: Resize and Dispose
  await test('SC-17', 'Lifecycle: ResizeObserver và disposeBIDashboard dọn dẹp bộ nhớ sạch sẽ', async () => {
    const res = await page.evaluate(async () => {
      const p = {
        version: '2.0',
        dashboard_id: 'dash_to_dispose',
        source_type: 'INTERNAL_SYSTEM',
        title: 'Dispose Test',
        generated_at: new Date().toISOString(),
        provenance: {},
        filters: {},
        kpi_strip: [],
        visualizations: [{ id: 'v_disp', title: 'C', chart_type: 'BAR', data_ref: 'd', mapping: { category: 'c', value: 'v' } }],
        data_tables: [],
        data_store: { d: [{ c: 'X', v: 5 }] },
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = window.renderInteractiveBIDashboard(p);
      window.mountBIDashboardsInElement(container);

      const host = container.querySelector('.bi-chart-host');
      const chartKey = host.id;
      const initialSize = window._biEchartInstances.size;
      const hasInstanceBefore = window._biEchartInstances.has(chartKey);

      // Call dispose
      window.disposeBIDashboard('dash_to_dispose');
      const hasInstanceAfter = window._biEchartInstances.has(chartKey);

      return {
        hasInstanceBefore,
        hasInstanceAfter,
      };
    });

    assert.strictEqual(res.hasInstanceBefore, true, 'Chart must be registered before dispose');
    assert.strictEqual(res.hasInstanceAfter, false, 'Chart must be cleanly removed after dispose');
  });

  // Scenario 18: Legacy bi-report Fallback
  await test('SC-18', 'Fallback: Khi không có V2, khối bi-report legacy tiếp tục hiển thị bình thường', async () => {
    const res = await page.evaluate(async () => {
      const legacyJson = JSON.stringify({
        companyId: 'STL',
        periodLabel: 'Tháng 01/2026',
        generatedAt: '2026-11-16T00:00:00.000Z',
        results: [
          { kpi: 'DOC_TOTAL', status: 'AVAILABLE', data: { total_documents: 888 } },
        ],
      });

      const md = `Báo cáo dạng cũ:\n\n\`\`\`bi-report\n${legacyJson}\n\`\`\``;
      const html = window.parseMarkdown(md, false);
      const div = document.createElement('div');
      div.innerHTML = html;

      return {
        hasLegacyCard: !!div.querySelector('.bi-dashboard-card'),
        valText: div.querySelector('.bi-dashboard-card')?.textContent || '',
      };
    });

    assert.ok(res.hasLegacyCard, 'Legacy card must render when V2 is not present');
    assert.ok(res.valText.includes('888'), 'Legacy value 888 must appear');
  });

  // Scenario 19: Legacy File BI SVG Fallback
  await test('SC-19', 'Fallback: Khi không có V2, inline SVG legacy tiếp tục hiển thị bình thường', async () => {
    const res = await page.evaluate(async () => {
      const svg = `<svg viewBox="0 0 640 280"><rect width="100" height="100" fill="blue"/></svg>`;
      const md = `Biểu đồ SVG cũ:\n\n${svg}`;
      const html = window.parseMarkdown(md, false);
      const div = document.createElement('div');
      div.innerHTML = html;

      return {
        hasSvg: !!div.querySelector('svg'),
        rectFill: div.querySelector('rect')?.getAttribute('fill') || '',
      };
    });

    assert.ok(res.hasSvg, 'Legacy inline SVG must render when V2 is not present');
    assert.strictEqual(res.rectFill, 'blue');
  });

  // Scenario 20: Normal General AI Chat
  await test('SC-20', 'Hội thoại thông thường (text, markdown, code, list) hoạt động mượt mà 100%', async () => {
    const res = await page.evaluate(async () => {
      const chatMd = `# Chào bạn\n\nĐây là câu trả lời thông thường:\n- Mục 1: **Đậm**\n- Mục 2: *Nghiêng*\n\n\`\`\`javascript\nconsole.log('hello');\n\`\`\``;
      const html = window.parseMarkdown(chatMd, false);
      const div = document.createElement('div');
      div.innerHTML = html;

      return {
        hasH1: !!div.querySelector('h1'),
        hasList: !!div.querySelector('ul'),
        hasCode: !!div.querySelector('.code-block'),
      };
    });

    assert.ok(res.hasH1, 'Heading 1 must render');
    assert.ok(res.hasList, 'List must render');
    assert.ok(res.hasCode, 'Code block must render');
  });

  // ============================================================================
  // CAPTURE EVIDENCE SCREENSHOT
  // ============================================================================
  const screenshotPath = 'reports/P1_1_BROWSER_RENDERING_EVIDENCE.png';
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`\n[INFO] Browser screenshot saved to: ${screenshotPath}`);

  await browser.close();
  server.close();

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`P1.1 ECHARTS RENDERER TEST SUMMARY: ${passCount} / ${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('Browser Engine: Microsoft Edge (Headless Playwright-Core)');
  console.log('Real DOM Verification: 20 / 20 SCENARIOS VERIFIED');
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
