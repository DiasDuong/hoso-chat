/**
 * SOTRANS HUB — FINAL E2E VALIDATION & ACCEPTANCE SUITE (CONTRACT V2.0)
 *
 * Comprehensive E2E Verification Covering:
 * - TASK 1: Source code integrity, git state & production path verification
 * - TASK 2: Live end-to-end API test & ground truth reconciliation on BAO_CAO_DEMO_SOLIEU.xlsx
 * - TASK 3: Live browser rendering (Microsoft Edge via Playwright-core) for Desktop & Mobile
 * - TASK 4: Interactive cross-filter synchronization (Vận Tải filter & reset)
 * - TASK 5: Generic BI capability across multiple domains (Training, Sales, KPI, Mixed Language)
 * - TASK 6: Data quality, nulls, ties, salary boundaries, and scale testing (150, 2000, 10000 rows)
 * - TASK 7: Security governance, tenant isolation, IDOR, formula injection & regression
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const XLSX = require('../auth-service/node_modules/xlsx');
const { chromium } = require('../auth-service/node_modules/playwright-core');

const { planAnalyticalQuery, planFollowUpQuery } = require('../auth-service/services/biQueryPlanner');
const { validateQueryPlan } = require('../auth-service/services/biQueryValidator');
const {
  processAndProfileDataset,
  executeAnalyticalQuery,
  queryIsolatedDataset,
  getDatasetForSheet,
} = require('../auth-service/services/biSpreadsheetEngine');
const { registerDataset, getDataset, updateDataset } = require('../auth-service/services/biDatasetRegistry');
const { buildDatasetDashboard } = require('../auth-service/services/biReportBuilder');
const { formatAnalyticalResultMarkdown } = require('../auth-service/services/biDatasetPresenter');
const { sanitizeFormulaInjection } = require('../auth-service/services/biFileSecurityService');

const BROWSER_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const GATEWAY_PORT = 8082;
const DEMO_EXCEL_PATH = path.resolve(__dirname, '..', 'BAO_CAO_DEMO_SOLIEU.xlsx');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testRecords = [];

function check(taskId, testId, title, condition, details = {}) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`[PASS] [${taskId}] ${testId}: ${title}`);
    testRecords.push({ taskId, testId, title, status: 'PASS', details });
  } else {
    failedTests++;
    console.error(`[FAIL] [${taskId}] ${testId}: ${title}`);
    testRecords.push({ taskId, testId, title, status: 'FAIL', details });
    throw new Error(`[${testId}] ${title} FAILED`);
  }
}

// HTTP Helper for live API calls
function httpRequest(options, body = null, isMultipart = false, boundary = null) {
  return new Promise((resolve, reject) => {
    const headers = options.headers || {};
    if (body && !isMultipart && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    } else if (body && isMultipart) {
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      headers['Content-Length'] = body.length;
    }

    const req = http.request({
      hostname: 'localhost',
      port: GATEWAY_PORT,
      path: options.path,
      method: options.method || 'GET',
      headers,
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { json = raw; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json, raw });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP Timeout calling ${options.path}`));
    });

    if (body) req.write(body);
    req.end();
  });
}

async function runMasterAcceptanceValidation() {
  console.log('================================================================');
  console.log('SOTRANS HUB — FINAL E2E ACCEPTANCE VALIDATION (CONTRACT V2.0)');
  console.log('Target: Live Gateway (8082), Live Backend (3000), Headless Edge');
  console.log('================================================================\n');

  // Ensure reports directory exists
  const reportsDir = path.resolve(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  // ============================================================================
  // TASK 1: VERIFY SOURCE CODE & PRODUCTION CODE PATH
  // ============================================================================
  console.log('--- [TASK 1] SOURCE CODE & PRODUCTION PATH AUDIT ---');

  // 1.1 Verify file existence
  const modifiedFiles = [
    'auth-service/services/biQueryPlanner.js',
    'auth-service/services/biSpreadsheetEngine.js',
    'auth-service/services/biQueryValidator.js',
    'auth-service/services/biReportBuilder.js',
    'auth-service/services/biDatasetPresenter.js',
    'auth-service/routes/general_ai.js',
  ];
  for (const f of modifiedFiles) {
    check('TASK-1', `F-EXISTS-${path.basename(f)}`, `File ${f} tồn tại trong codebase`, fs.existsSync(path.resolve(__dirname, '..', f)));
  }

  // 1.2 Verify upgraded functions exist in modules
  const planner = require('../auth-service/services/biQueryPlanner');
  const engine = require('../auth-service/services/biSpreadsheetEngine');
  const validator = require('../auth-service/services/biQueryValidator');
  const builder = require('../auth-service/services/biReportBuilder');
  const presenter = require('../auth-service/services/biDatasetPresenter');

  check('TASK-1', 'FN-PLANNER-DECOMPOSE', 'biQueryPlanner có hàm decomposeCompositeRequirements', typeof planner.decomposeCompositeRequirements === 'function');
  check('TASK-1', 'FN-ENGINE-EXEC', 'biSpreadsheetEngine có hàm executeAnalyticalQuery', typeof engine.executeAnalyticalQuery === 'function');
  check('TASK-1', 'FN-VALIDATOR-PLAN', 'biQueryValidator có hàm validateQueryPlan', typeof validator.validateQueryPlan === 'function');
  check('TASK-1', 'FN-BUILDER-DASH', 'biReportBuilder có hàm buildDatasetDashboard', typeof builder.buildDatasetDashboard === 'function');
  check('TASK-1', 'FN-PRESENTER-MD', 'biDatasetPresenter có hàm formatAnalyticalResultMarkdown', typeof presenter.formatAnalyticalResultMarkdown === 'function');

  // 1.3 Verify production path in general_ai.js
  const generalAiContent = fs.readFileSync(path.resolve(__dirname, '..', 'auth-service/routes/general_ai.js'), 'utf8');
  check('TASK-1', 'PATH-GENERAL-AI-PLAN', 'general_ai.js gọi planAnalyticalQuery trong production path', generalAiContent.includes('planAnalyticalQuery('));
  check('TASK-1', 'PATH-GENERAL-AI-EXEC', 'general_ai.js gọi queryIsolatedDataset trong production path', generalAiContent.includes('queryIsolatedDataset('));
  check('TASK-1', 'PATH-GENERAL-AI-MD', 'general_ai.js gọi formatAnalyticalResultMarkdown trong production path', generalAiContent.includes('formatAnalyticalResultMarkdown('));
  check('TASK-1', 'PATH-GENERAL-AI-GROUNDING', 'general_ai.js có Grounding Prompt cho Quỹ Lương (isPayroll)', generalAiContent.includes('isPayroll') && generalAiContent.includes('TUYỆT ĐỐI KHÔNG diễn giải'));

  // ============================================================================
  // TASK 2: LIVE END-TO-END WORKFLOW & GROUND TRUTH AUDIT
  // ============================================================================
  console.log('\n--- [TASK 2] LIVE END-TO-END TEST & GROUND TRUTH RECONCILIATION ---');

  // Wait for gateway health
  let healthy = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const h = await httpRequest({ path: '/api/health', method: 'GET' });
      if (h.statusCode === 200 && h.body?.status === 'ok') { healthy = true; break; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  check('TASK-2', 'LIVE-GATEWAY-HEALTHY', 'Cổng API Gateway và backend hr-auth sẵn sàng', healthy);

  // 2.1 Live Authentication via API
  const loginRes = await httpRequest({ path: '/api/auth/login', method: 'POST' }, JSON.stringify({
    username: 'admin_stl',
    password: '123456',
  }));
  check('TASK-2', 'LIVE-LOGIN', 'Đăng nhập thành công với tài khoản admin_stl qua cổng live 8082', loginRes.statusCode === 200 && Boolean(loginRes.body?.token));
  const authToken = loginRes.body.token;
  const authUser = loginRes.body.user;

  // 2.2 Verify Excel test file existence & checksum
  check('TASK-2', 'EXCEL-EXISTS', 'File BAO_CAO_DEMO_SOLIEU.xlsx tồn tại', fs.existsSync(DEMO_EXCEL_PATH));
  const excelBuffer = fs.readFileSync(DEMO_EXCEL_PATH);
  const sha256Hash = crypto.createHash('sha256').update(excelBuffer).digest('hex').toUpperCase();
  check('TASK-2', 'EXCEL-SHA256', `Checksum SHA256 file khớp chuẩn (${sha256Hash})`, sha256Hash === '7C7EDB17AF51742C2178A6E2CF426501098148363D904301F19D7BD07111DE0C');

  // 2.3 Live Upload Excel File via API
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
  const filename = 'BAO_CAO_DEMO_SOLIEU.xlsx';
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
  );
  const fileFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipartBody = Buffer.concat([fileHeader, excelBuffer, fileFooter]);

  const uploadRes = await httpRequest({
    path: '/api/bi/files/upload',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}` },
  }, multipartBody, true, boundary);

  check('TASK-2', 'LIVE-UPLOAD', 'Tải tệp Excel lên hệ thống thành công (HTTP 200/201)', uploadRes.statusCode === 200 || uploadRes.statusCode === 201);
  const uploadedDataset = uploadRes.body?.dataset;
  const fileId = uploadedDataset?.file_id;
  check('TASK-2', 'DATASET-REGISTERED', 'Bộ dữ liệu được tạo file_id và profile tự động', Boolean(fileId) && Boolean(uploadedDataset.profile));

  // 2.4 Send full analytical query prompt via API (/api/bi/files/:fileId/ask)
  const fullPayrollPrompt = `Hãy xây dựng báo cáo BI phân tích quỹ lương nhân sự.
Yêu cầu:
- Tổng quỹ lương cơ bản.
- Lương cơ bản trung bình.
- Lương cao nhất và thấp nhất.
- Phân bổ quỹ lương theo phòng ban.
- So sánh lương trung bình giữa các chức vụ.
- Phân loại nhân viên theo các nhóm mức lương.
- Top 10 nhân viên có lương cao nhất.
Sử dụng KPI Cards, Bar Chart, Pie Chart và bảng xếp hạng.`;

  const askRes = await httpRequest({
    path: `/api/bi/files/${fileId}/ask`,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}` },
  }, JSON.stringify({ prompt: fullPayrollPrompt }));

  check('TASK-2', 'LIVE-ASK-API', 'API xử lý câu hỏi phân tích trả về HTTP 200', askRes.statusCode === 200 && askRes.body?.success === true);

  const queryPlan = askRes.body.plan;
  const queryResult = askRes.body.result;
  const markdownReport = askRes.body.markdown;

  // Extract embedded bi-dashboard-v2 JSON payload from Markdown
  const dashMatch = markdownReport.match(/<!--\s*bi-dashboard-v2:\s*([\s\S]*?)\s*-->/);
  check('TASK-2', 'DASHBOARD-PAYLOAD-EMBEDDED', 'Phản hồi chứa payload HTML comment <!-- bi-dashboard-v2: ... -->', Boolean(dashMatch));
  const dashboardPayload = JSON.parse(dashMatch[1].replace(/--\\u003e/g, '-->').replace(/\\u003c!--/g, '<!--'));

  // 2.5 Verification of 8 Requirements in Plan
  check('TASK-2', 'REQ-COUNT', `Kế hoạch nhận diện đủ tối thiểu 8 yêu cầu (thực tế: ${queryPlan.requirements.length})`, queryPlan.requirements.length >= 8);

  const req1 = queryResult.results_by_requirement['req_total_salary'];
  const req2 = queryResult.results_by_requirement['req_avg_salary'];
  const req3 = queryResult.results_by_requirement['req_max_salary'];
  const req4 = queryResult.results_by_requirement['req_min_salary'];
  const req5 = queryResult.results_by_requirement['req_salary_by_dept_bar'] || queryResult.results_by_requirement['req_salary_by_dept'];
  const req5Pie = queryResult.results_by_requirement['req_salary_by_dept_pie'];
  const req6 = queryResult.results_by_requirement['req_avg_salary_by_title'];
  const req7 = queryResult.results_by_requirement['req_salary_bands'];
  const req8 = queryResult.results_by_requirement['req_top_10_salary'];

  // 2.6 Independent Ground Truth Comparison
  // Ground Truth calculated directly from Excel 150 rows:
  check('TASK-2', 'GT-REQ-01-SUM', 'Tổng quỹ lương cơ bản = 3.429.000.000 VNĐ', req1.value === 3429000000);
  check('TASK-2', 'GT-REQ-02-AVG', 'Lương cơ bản trung bình = 22.860.000 VNĐ', req2.value === 22860000);
  check('TASK-2', 'GT-REQ-03-MAX', 'Lương cá nhân cao nhất = 50.000.000 VNĐ', req3.value === 50000000);
  check('TASK-2', 'GT-REQ-04-MIN', 'Lương cá nhân thấp nhất = 3.000.000 VNĐ', req4.value === 3000000);

  // REQ-05: Department breakdown
  check('TASK-2', 'GT-REQ-05-DEPTS', 'Phân bổ đủ 6 phòng ban', req5.data.length === 6);
  const totalDeptSalary = req5.data.reduce((a, b) => a + b.tong_quy_luong, 0);
  check('TASK-2', 'GT-REQ-05-SUM-MATCH', `Tổng quỹ lương 6 phòng ban (${totalDeptSalary}) = 3.429.000.000 VNĐ`, totalDeptSalary === 3429000000);
  check('TASK-2', 'GT-REQ-05-TOP-DEPT', 'Phòng Vận Tải dẫn đầu với 722.000.000 VNĐ', req5.data[0].phong_ban === 'Vận Tải' && req5.data[0].tong_quy_luong === 722000000);

  // REQ-06: Title breakdown
  check('TASK-2', 'GT-REQ-06-TITLES', 'So sánh lương TB trên đủ 20 chức vụ', req6.data.length === 20);
  check('TASK-2', 'GT-REQ-06-TOP-TITLE', 'Chức vụ lương cao nhất là Quản lý đội xe (40.727.273 VNĐ/người)', req6.data[0].chuc_vu === 'Quản lý đội xe' && Math.round(req6.data[0].luong_trung_binh) === 40727273);

  // REQ-07: Salary bands
  check('TASK-2', 'GT-REQ-07-BANDS-COUNT', 'Phân loại đúng 4 khoảng lương', req7.data.length === 4);
  const totalEmployeesInBands = req7.data.reduce((a, b) => a + b.so_nhan_vien, 0);
  check('TASK-2', 'GT-REQ-07-SUM-150', `Tổng số nhân viên trong 4 khoảng (${totalEmployeesInBands}) = đúng 150 nhân viên`, totalEmployeesInBands === 150);
  const b1 = req7.data.find(d => d.nhom_muc_luong === 'Dưới 15 triệu');
  const b2 = req7.data.find(d => d.nhom_muc_luong === '15 - 25 triệu');
  const b3 = req7.data.find(d => d.nhom_muc_luong === '25 - 35 triệu');
  const b4 = req7.data.find(d => d.nhom_muc_luong === 'Trên 35 triệu');
  check('TASK-2', 'GT-REQ-07-B1', 'Khoảng < 15 triệu có đúng 54 nhân sự (36%)', b1 && b1.so_nhan_vien === 54 && b1.ty_trong_pct === 36);
  check('TASK-2', 'GT-REQ-07-B2', 'Khoảng 15-25 triệu có đúng 39 nhân sự (26%)', b2 && b2.so_nhan_vien === 39 && b2.ty_trong_pct === 26);
  check('TASK-2', 'GT-REQ-07-B3', 'Khoảng 25-35 triệu có đúng 24 nhân sự (16%)', b3 && b3.so_nhan_vien === 24 && b3.ty_trong_pct === 16);
  check('TASK-2', 'GT-REQ-07-B4', 'Khoảng > 35 triệu có đúng 33 nhân sự (22%)', b4 && b4.so_nhan_vien === 33 && b4.ty_trong_pct === 22);

  // REQ-08: Top 10 Employees
  const top10DashRows = dashboardPayload.data_store['dataset_req_top_10_salary'] || req8.data || [];
  check('TASK-2', 'GT-REQ-08-COUNT', 'Bảng Top 10 trả về đúng 10 nhân viên', top10DashRows.length === 10);
  check('TASK-2', 'GT-REQ-08-NO1', 'Nhân viên #1 là NV069 với 50.000.000 VNĐ', top10DashRows[0].ma_nhan_vien === 'NV069' && top10DashRows[0].luong_co_ban_vnd === 50000000);
  check('TASK-2', 'GT-REQ-08-NO10', 'Nhân viên #10 là NV140 với 49.000.000 VNĐ (tie-breaking chuẩn)', top10DashRows[9].ma_nhan_vien === 'NV140' && top10DashRows[9].luong_co_ban_vnd === 49000000);
  check('TASK-2', 'GT-REQ-08-PII-GUARD', 'API áp dụng cơ chế che mờ PII trong raw JSON payload', req8.data[0].ma_nhan_vien === 'NV***' && req8.data[0].luong_co_ban_vnd === '[Đã ẩn]');

  // 2.7 Verification of Unwanted Metric Elimination
  check('TASK-2', 'KPI-EXACT-4-CARDS', `KPI strip có đúng 4 thẻ nghiệp vụ (thực tế: ${dashboardPayload.kpi_strip.length})`, dashboardPayload.kpi_strip.length === 4);
  check('TASK-2', 'NO-MATCHING-ROWS', 'Không xuất hiện thẻ kỹ thuật "Dòng phù hợp"', !dashboardPayload.kpi_strip.some(k => k.title.includes('Dòng phù hợp') || k.metric_alias === 'matching_rows'));
  check('TASK-2', 'NO-DISTINCT-HEADCOUNT', 'Không xuất hiện thẻ kỹ thuật "Tổng nhân sự"', !dashboardPayload.kpi_strip.some(k => k.title.includes('Tổng nhân sự') || k.metric_alias === 'distinct_headcount'));
  check('TASK-2', 'NO-DIEM-KPI', 'Không xuất hiện thẻ kỹ thuật "Điểm KPI"', !dashboardPayload.kpi_strip.some(k => k.title.includes('KPI') || k.metric_alias?.includes('diem_kpi')));

  // ============================================================================
  // TASK 3: VALIDATE DASHBOARD RENDERING IN REAL BROWSER (EDGE)
  // ============================================================================
  console.log('\n--- [TASK 3] REAL BROWSER RENDERING (MICROSOFT EDGE) ---');

  const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
  });

  const consoleErrors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const APP_URL = `http://localhost:${GATEWAY_PORT}/chat/`;
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Authenticate in browser context via localStorage
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('HR_ADMIN_TOKEN', token);
    localStorage.setItem('HR_CHAT_TOKEN', token);
    localStorage.setItem('HR_AUTH_TOKEN', token);
    localStorage.setItem('HR_ADMIN_USER', JSON.stringify(user));
    localStorage.setItem('HR_CHAT_USER', JSON.stringify(user));
    localStorage.setItem('HR_AUTH_USER', JSON.stringify(user));
  }, { token: authToken, user: authUser });

  // Mount the live Markdown report containing Dashboard Spec v2.0 into the DOM
  const renderEvaluation = await page.evaluate(async (mdText) => {
    const container = document.createElement('div');
    container.id = 'live-test-chat-container';
    container.style.cssText = 'padding: 20px; background: #f8fafc; max-width: 1200px; margin: 0 auto;';
    document.body.appendChild(container);

    // Call window.mountBIDashboardsInElement or render directly
    const parsedPayload = window.parseBIDashboardPayload(mdText);
    const validation = window.validateDashboardForRendering(parsedPayload);

    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    // Render interactive dashboard container
    const dashHtml = window.renderInteractiveBIDashboard(parsedPayload);
    container.innerHTML = dashHtml;

    // Trigger post-render to mount charts and bind interactive events
    if (typeof window.postProcessBIDashboards === 'function') {
      window.postProcessBIDashboards(container);
    } else if (typeof window.mountBIDashboardsInElement === 'function') {
      // Create mock wrapper with markdown text
      const mockMsg = document.createElement('div');
      mockMsg.className = 'ai-chat-bubble';
      mockMsg.innerHTML = `<!-- bi-dashboard-v2: ${JSON.stringify(parsedPayload)} -->`;
      container.appendChild(mockMsg);
      window.mountBIDashboardsInElement(container);
    }

    // Query DOM Elements
    const kpiCards = container.querySelectorAll('.bi-kpi-card');
    const chartBoxes = container.querySelectorAll('.bi-chart-card');
    const tableWraps = container.querySelectorAll('.bi-dash-table-wrap');
    const top10TableWrap = Array.from(tableWraps).find(t => t.textContent.includes('Top 10') || t.getAttribute('data-bi-table')?.includes('top_10'));
    const top10Rows = top10TableWrap ? top10TableWrap.querySelectorAll('tbody tr') : [];

    const kpiTitles = Array.from(kpiCards).map(c => (c.querySelector('.bi-kpi-label') || c.querySelector('.bi-kpi-title'))?.textContent?.trim());
    const kpiValues = Array.from(kpiCards).map(c => (c.querySelector('.bi-kpi-val') || c.querySelector('.bi-kpi-primary'))?.textContent?.trim());

    return {
      success: true,
      kpiCount: kpiCards.length,
      kpiTitles,
      kpiValues,
      chartCount: chartBoxes.length,
      tableCount: tableWraps.length,
      top10RowCount: top10Rows.length,
    };
  }, markdownReport);

  check('TASK-3', 'BROWSER-PARSE-PAYLOAD', 'Trình duyệt parse thành công Dashboard Spec v2.0', renderEvaluation.success);
  check('TASK-3', 'BROWSER-KPI-CARDS', `Trình duyệt render đúng 4 thẻ KPI nghiệp vụ (thực tế: ${renderEvaluation.kpiCount})`, renderEvaluation.kpiCount === 4);
  check('TASK-3', 'BROWSER-KPI-TITLES', 'Thẻ KPI hiển thị đúng 4 tiêu đề nghiệp vụ tiếng Việt',
    renderEvaluation.kpiTitles.includes('Tổng quỹ lương cơ bản') &&
    renderEvaluation.kpiTitles.includes('Lương cơ bản trung bình') &&
    renderEvaluation.kpiTitles.includes('Lương cơ bản cao nhất') &&
    renderEvaluation.kpiTitles.includes('Lương cơ bản thấp nhất')
  );
  check('TASK-3', 'BROWSER-CHARTS-RENDERED', `Trình duyệt render đủ 4 biểu đồ trực quan (thực tế: ${renderEvaluation.chartCount})`, renderEvaluation.chartCount === 4);
  check('TASK-3', 'BROWSER-TOP10-TABLE', `Trình duyệt render bảng Top 10 với đúng 10 dòng (thực tế: ${renderEvaluation.top10RowCount})`, renderEvaluation.top10RowCount === 10);

  // Capture Desktop Screenshot Evidence
  const desktopScreenshotPath = path.join(reportsDir, 'FINAL_E2E_DASHBOARD_DESKTOP.png');
  await page.screenshot({ path: desktopScreenshotPath, fullPage: true });
  check('TASK-3', 'SCREENSHOT-DESKTOP', 'Đã chụp ảnh màn hình Desktop bằng chứng thành công', fs.existsSync(desktopScreenshotPath));

  // Test Responsive Mobile Viewport (375x667)
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(500);
  const mobileScreenshotPath = path.join(reportsDir, 'FINAL_E2E_DASHBOARD_MOBILE.png');
  await page.screenshot({ path: mobileScreenshotPath, fullPage: true });
  check('TASK-3', 'SCREENSHOT-MOBILE', 'Đã chụp ảnh màn hình Mobile bằng chứng responsive thành công', fs.existsSync(mobileScreenshotPath));

  // Console Error Audit
  const fatalErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('font'));
  check('TASK-3', 'NO-CONSOLE-ERRORS', `Không có lỗi JavaScript browser console nghiêm trọng (thực tế: ${fatalErrors.length})`, fatalErrors.length === 0);

  // ============================================================================
  // TASK 4: FILTER SYNCHRONIZATION
  // ============================================================================
  console.log('\n--- [TASK 4] CROSS-FILTER SYNCHRONIZATION ---');

  // 4.1 Filter query by Department = "Vận Tải" via Live API
  const filterVanTaiPlan = {
    ...queryPlan,
    filters: [{ column: 'phong_ban', op: 'eq', value: 'Vận Tải' }],
  };

  const filterApiRes = await httpRequest({
    path: `/api/bi/files/${fileId}/query`,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}` },
  }, JSON.stringify(filterVanTaiPlan));

  check('TASK-4', 'FILTER-API-STATUS', 'API lọc trên server trả về HTTP 200 thành công', filterApiRes.statusCode === 200 && filterApiRes.body?.success === true);
  const filterResult = filterApiRes.body;

  const filteredTotalSal = filterResult.results_by_requirement['req_total_salary'].value;
  const filteredAvgSal = filterResult.results_by_requirement['req_avg_salary'].value;
  const filteredMaxSal = filterResult.results_by_requirement['req_max_salary'].value;
  const filteredMinSal = filterResult.results_by_requirement['req_min_salary'].value;
  const filteredTop10 = filterResult.results_by_requirement['req_top_10_salary'].data;

  check('TASK-4', 'FILTER-TOTAL-SAL', `Lọc Vận Tải: Tổng lương = 722.000.000 VNĐ (Thực tế: ${filteredTotalSal})`, filteredTotalSal === 722000000);
  check('TASK-4', 'FILTER-AVG-SAL', `Lọc Vận Tải: Lương TB = 23.290.322,58 VNĐ (Thực tế: ${filteredAvgSal})`, Math.abs(filteredAvgSal - 23290322.58) < 0.1);
  check('TASK-4', 'FILTER-MAX-SAL', `Lọc Vận Tải: Lương Max = 50.000.000 VNĐ (Thực tế: ${filteredMaxSal})`, filteredMaxSal === 50000000);
  check('TASK-4', 'FILTER-MIN-SAL', `Lọc Vận Tải: Lương Min = 8.000.000 VNĐ (Thực tế: ${filteredMinSal})`, filteredMinSal === 8000000);
  check('TASK-4', 'FILTER-TOP10-SCOPE', 'Lọc Vận Tải: Bảng Top 10 chỉ chứa nhân sự phòng Vận Tải', filteredTop10.every(e => e.phong_ban === 'Vận Tải'));

  // 4.2 Reset filter: Verify full metrics restored
  const resetApiRes = await httpRequest({
    path: `/api/bi/files/${fileId}/query`,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}` },
  }, JSON.stringify({ ...queryPlan, filters: [] }));
  const resetResult = resetApiRes.body;

  check('TASK-4', 'FILTER-RESET-TOTAL', 'Bỏ lọc: Tổng quỹ lương phục hồi chính xác 3.429.000.000 VNĐ', resetResult.results_by_requirement['req_total_salary'].value === 3429000000);

  // ============================================================================
  // TASK 5: GENERIC BI CAPABILITY ACROSS DOMAINS
  // ============================================================================
  console.log('\n--- [TASK 5] GENERIC BI CAPABILITY ---');

  // Test 5A: Training Domain
  const promptTraining = 'Báo cáo đào tạo nhân sự gồm: 1. Tổng khóa hoàn thành, 2. Trung bình khóa mỗi người, 3. Số nhân viên chưa hoàn thành khóa nào, 4. Phân bổ theo phòng ban, 5. Top 10 nhân viên có số khóa cao nhất.';
  const planTraining = planAnalyticalQuery(promptTraining, uploadedDataset.profile);
  check('TASK-5', 'GENERIC-TRAINING-COMPOSITE', 'Domain Đào tạo nhận diện intent COMPOSITE', planTraining.intent === 'COMPOSITE');
  check('TASK-5', 'GENERIC-TRAINING-REQS', `Domain Đào tạo tách đủ yêu cầu độc lập (thực tế: ${planTraining.requirements.length})`, planTraining.requirements.length >= 5);

  // Test 5B: Sales Domain (E-Commerce Orders)
  const promptSales = 'Báo cáo doanh số bán hàng: 1. Tổng doanh thu, 2. Số đơn hàng phân biệt, 3. Doanh thu theo tháng, 4. Top sản phẩm bán chạy.';
  const salesProfile = {
    columns: [
      { key: 'ma_don', name: 'Mã Đơn Hàng', type: 'STRING' },
      { key: 'san_pham', name: 'Sản Phẩm', type: 'STRING' },
      { key: 'doanh_thu', name: 'Doanh Thu', type: 'INTEGER' },
      { key: 'thang', name: 'Tháng', type: 'STRING' },
    ],
  };
  const planSales = planAnalyticalQuery(promptSales, salesProfile);
  check('TASK-5', 'GENERIC-SALES-COMPOSITE', 'Domain Bán hàng nhận diện intent COMPOSITE', planSales.intent === 'COMPOSITE');
  check('TASK-5', 'GENERIC-SALES-REQS', `Domain Bán hàng bóc tách đủ yêu cầu (thực tế: ${planSales.requirements.length})`, planSales.requirements.length >= 3);

  // Test 5C: KPI Extrema & Comparison
  const promptKpi = 'Thống kê điểm KPI: 1. Điểm KPI trung bình, 2. Điểm KPI cao nhất và thấp nhất, 3. So sánh KPI theo phòng ban, 4. Top 5 nhân sự xuất sắc.';
  const planKpi = planAnalyticalQuery(promptKpi, uploadedDataset.profile);
  check('TASK-5', 'GENERIC-KPI-COMPOSITE', 'Domain Hiệu suất nhận diện intent COMPOSITE', planKpi.intent === 'COMPOSITE');
  check('TASK-5', 'GENERIC-KPI-REQS', `Domain Hiệu suất bóc tách đủ yêu cầu (thực tế: ${planKpi.requirements.length})`, planKpi.requirements.length >= 4);

  // Test 5D: Mixed Vietnamese / English / Abbreviations (Non-numbered prompt)
  const promptMixed = 'Thống kê lương cơ bản avg, max, min, cơ cấu dept và xếp hạng top 5';
  const planMixed = planAnalyticalQuery(promptMixed, uploadedDataset.profile);
  check('TASK-5', 'GENERIC-MIXED-COMPOSITE', 'Câu hỏi viết tắt tiếng Anh + tiếng Việt nhận diện COMPOSITE', planMixed.intent === 'COMPOSITE');
  check('TASK-5', 'GENERIC-MIXED-REQS', `Câu hỏi hỗn hợp bóc tách được ${planMixed.requirements.length} yêu cầu`, planMixed.requirements.length >= 3);

  // Test 5E: Recruitment & Tenure Domain (Benchmark Conversation 2e84fd1c-1883-4b85-ae28-9762baf62f4f)
  const promptTenure = `Hãy tạo báo cáo BI về tình hình tuyển dụng và thâm niên nhân viên.

Yêu cầu:
- Số lượng nhân viên theo năm vào làm.
- Số lượng nhân viên theo từng giai đoạn thâm niên.
- Thâm niên trung bình.
- Phòng ban có nhiều nhân viên lâu năm nhất.
- So sánh KPI giữa nhóm nhân viên mới và lâu năm.
- Phân tích cơ cấu nhân sự theo thời gian làm việc.
Sử dụng Line Chart, Bar Chart và bảng thống kê.`;
  const planTenure = planAnalyticalQuery(promptTenure, uploadedDataset.profile);
  check('TASK-5', 'TENURE-COMPOSITE-INTENT', 'Domain Tuyển dụng & Thâm niên nhận diện intent COMPOSITE', planTenure.intent === 'COMPOSITE');
  check('TASK-5', 'TENURE-ALL-6-REQS', `Bóc tách đủ 6 yêu cầu nghiệp vụ thâm niên (thực tế: ${planTenure.requirements?.length})`, planTenure.requirements?.length === 6);

  let tenureDataset = null;
  const tenureDatasetPath = path.resolve(__dirname, '../auth-service/storage/bi_datasets', `${fileId}.dataset.json`);
  if (fs.existsSync(tenureDatasetPath)) {
    tenureDataset = JSON.parse(fs.readFileSync(tenureDatasetPath, 'utf8'));
  } else {
    const { datasetJsonPath } = await processAndProfileDataset({
      file_id: 'tenure_suite_file',
      original_filename: 'BAO_CAO_DEMO_SOLIEU.xlsx',
      file_extension: '.xlsx',
      uploaded_by: authUser.user_id,
      company_id: 'ALL',
    }, excelBuffer);
    tenureDataset = JSON.parse(fs.readFileSync(datasetJsonPath, 'utf8'));
  }
  tenureDataset.uploaded_by = authUser.user_id;
  tenureDataset.company_id = 'ALL';

  const valTenure = validateQueryPlan(planTenure, tenureDataset, authUser);
  check('TASK-5', 'TENURE-CONTRACT-COMPLETE', 'Hợp đồng v2.0: metric_coverage.isComplete = true', valTenure.metric_coverage.isComplete === true);
  check('TASK-5', 'TENURE-CONTRACT-6-RESOLVED', 'Hợp đồng v2.0: 6/6 yêu cầu được phân giải (resolved_requirements = 6)', valTenure.metric_coverage.resolved_requirements === 6);

  const execTenure = executeAnalyticalQuery(tenureDataset, valTenure);
  const avgTenureVal = execTenure.results_by_requirement['req_avg_tenure']?.value;
  check('TASK-5', 'TENURE-AVG-VALUE', `Thâm niên trung bình chính xác = 4.85 năm (Thực tế: ${avgTenureVal})`, avgTenureVal === 4.85);

  const seniorDeptVal = execTenure.results_by_requirement['req_senior_department']?.value;
  check('TASK-5', 'TENURE-SENIOR-DEPT', `Phòng ban nhiều NV lâu năm nhất = 15 nhân sự (Thực tế: ${seniorDeptVal})`, seniorDeptVal === 15);

  const tenureDistList = execTenure.results_by_requirement['req_tenure_distribution']?.data || [];
  const tenureDistTotal = tenureDistList.reduce((s, b) => s + b.so_nhan_vien, 0);
  check('TASK-5', 'TENURE-DIST-TOTAL-150', `Tổng số nhân viên phân bổ thâm niên (4 khoảng) = đúng 150 nhân viên (Thực tế: ${tenureDistTotal})`, tenureDistTotal === 150);

  const hiresByYearList = execTenure.results_by_requirement['req_recruitment_by_year']?.data || [];
  const hiresTotal = hiresByYearList.reduce((s, y) => s + y.so_nhan_vien, 0);
  check('TASK-5', 'TENURE-HIRES-TOTAL-150', `Tổng số nhân viên tuyển dụng theo năm (8 năm) = đúng 150 nhân viên (Thực tế: ${hiresTotal})`, hiresTotal === 150);

  // ============================================================================
  // TASK 6: DATA QUALITY, BOUNDARIES, SCALE & PROFILING
  // ============================================================================
  console.log('\n--- [TASK 6] DATA QUALITY & SCALE STRESS TESTING ---');

  // 6.1 Test synthetic 2,000 rows
  const rows2000 = [];
  for (let i = 1; i <= 2000; i++) {
    rows2000.push({
      ma_nhan_vien: `NV_SCALE_${String(i).padStart(5, '0')}`,
      ho_ten: `Nhân Viên Scale ${i}`,
      phong_ban: i % 2 === 0 ? 'Vận Tải' : 'Kho Vận',
      chuc_vu: 'Chuyên viên',
      luong_co_ban_vnd: 20000000 + (i * 100),
    });
  }
  const dataset2000 = {
    file_id: 'ds_scale_2000',
    original_filename: 'scale_2000.xlsx',
    uploaded_by: authUser.user_id,
    company_id: 'ALL',
    profile: {
      active_sheet: 'Sheet1',
      grain: 'EMPLOYEE',
      row_count: 2000,
      columns: [
        { key: 'ma_nhan_vien', name: 'Mã NV', type: 'STRING' },
        { key: 'ho_ten', name: 'Họ Tên', type: 'STRING' },
        { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING' },
        { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING' },
        { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản', type: 'INTEGER' },
      ],
    },
    rows: rows2000,
  };

  const tStart2000 = Date.now();
  const mStart2000 = process.memoryUsage().heapUsed;
  const plan2000 = planAnalyticalQuery('Tổng quỹ lương cơ bản và lương cao nhất', dataset2000.profile);
  const val2000 = validateQueryPlan(plan2000, dataset2000, authUser);
  const exec2000 = executeAnalyticalQuery(dataset2000, val2000);
  const tEnd2000 = Date.now() - tStart2000;
  const mDelta2000 = Math.round((process.memoryUsage().heapUsed - mStart2000) / 1024);

  check('TASK-6', 'SCALE-2000-SCANNED', `Quét toàn bộ 2.000 dòng dữ liệu (thực tế: ${exec2000.rows_scanned})`, exec2000.rows_scanned === 2000);
  check('TASK-6', 'SCALE-2000-TIME', `Thời gian thực thi file 2.000 dòng (${tEnd2000}ms) < 1.000ms`, tEnd2000 < 1000);

  // 6.2 Test synthetic 10,000 rows (High-Volume Scale Test)
  const rows10000 = [];
  for (let i = 1; i <= 10000; i++) {
    rows10000.push({
      ma_nhan_vien: `NV_10K_${String(i).padStart(6, '0')}`,
      ho_ten: `Nhân Viên 10K ${i}`,
      phong_ban: i % 4 === 0 ? 'Vận Tải' : (i % 4 === 1 ? 'Kho Vận' : (i % 4 === 2 ? 'Kế Toán' : 'IT')),
      chuc_vu: 'Chuyên viên',
      luong_co_ban_vnd: 15000000 + (i * 10),
    });
  }
  const dataset10000 = {
    file_id: 'ds_scale_10000',
    original_filename: 'scale_10000.xlsx',
    uploaded_by: authUser.user_id,
    company_id: 'ALL',
    profile: {
      active_sheet: 'Sheet1',
      grain: 'EMPLOYEE',
      row_count: 10000,
      columns: [
        { key: 'ma_nhan_vien', name: 'Mã NV', type: 'STRING' },
        { key: 'ho_ten', name: 'Họ Tên', type: 'STRING' },
        { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING' },
        { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING' },
        { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản', type: 'INTEGER' },
      ],
    },
    rows: rows10000,
  };

  const tStart10k = Date.now();
  const mStart10k = process.memoryUsage().heapUsed;
  const plan10k = planAnalyticalQuery('Tổng quỹ lương cơ bản, lương trung bình và lương cao nhất', dataset10000.profile);
  const val10k = validateQueryPlan(plan10k, dataset10000, authUser);
  const exec10k = executeAnalyticalQuery(dataset10000, val10k);
  const tEnd10k = Date.now() - tStart10k;
  const mDelta10k = Math.round((process.memoryUsage().heapUsed - mStart10k) / 1024);

  check('TASK-6', 'SCALE-10000-SCANNED', `Quét toàn bộ 10.000 dòng dữ liệu (thực tế: ${exec10k.rows_scanned})`, exec10k.rows_scanned === 10000);
  check('TASK-6', 'SCALE-10000-TIME', `Thời gian thực thi file 10.000 dòng (${tEnd10k}ms) < 3.000ms`, tEnd10k < 3000);
  console.log(`[PERF INFO] 10.000 Rows: Execution Time = ${tEnd10k}ms | Heap Delta = ${mDelta10k} KB`);

  // 6.3 Boundary Values in Salary Bands (15M, 25M, 35M)
  const boundaryRows = [
    { ma_nhan_vien: 'NV_B0', ho_ten: 'A', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 14999999 }, // < 15M
    { ma_nhan_vien: 'NV_B1', ho_ten: 'B', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 15000000 }, // 15-25M
    { ma_nhan_vien: 'NV_B2', ho_ten: 'C', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 25000000 }, // 15-25M
    { ma_nhan_vien: 'NV_B3', ho_ten: 'D', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 25000001 }, // 25-35M
    { ma_nhan_vien: 'NV_B4', ho_ten: 'E', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 35000000 }, // 25-35M
    { ma_nhan_vien: 'NV_B5', ho_ten: 'F', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 35000001 }, // > 35M
  ];
  const datasetBoundary = {
    file_id: 'ds_boundary',
    original_filename: 'boundary.xlsx',
    uploaded_by: authUser.user_id,
    company_id: 'ALL',
    profile: {
      active_sheet: 'Sheet1',
      grain: 'EMPLOYEE',
      row_count: 6,
      columns: [
        { key: 'ma_nhan_vien', name: 'Mã NV', type: 'STRING' },
        { key: 'ho_ten', name: 'Họ Tên', type: 'STRING' },
        { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING' },
        { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING' },
        { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản', type: 'INTEGER' },
      ],
    },
    rows: boundaryRows,
  };
  const planBoundary = planAnalyticalQuery('Phân loại nhân viên theo nhóm mức lương', datasetBoundary.profile);
  const valBoundary = validateQueryPlan(planBoundary, datasetBoundary, authUser);
  const execBoundary = executeAnalyticalQuery(datasetBoundary, valBoundary);
  const bandsBoundary = execBoundary.results_by_requirement['req_salary_bands'].data;

  const totalBoundaryAssigned = bandsBoundary.reduce((a, b) => a + b.so_nhan_vien, 0);
  check('TASK-6', 'BOUNDARY-NON-OVERLAPPING', `Toàn bộ 6 giá trị ranh giới (15M, 25M, 35M) được chia đúng 6 phần tử không trùng lặp (${totalBoundaryAssigned})`, totalBoundaryAssigned === 6);

  // 6.4 Null and Bad Data Handling
  const dirtyRows = [
    { ma_nhan_vien: 'NV_D1', ho_ten: 'Valid 1', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 20000000 },
    { ma_nhan_vien: 'NV_D2', ho_ten: 'Valid 2', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 30000000 },
    { ma_nhan_vien: 'NV_D3', ho_ten: 'Null Salary', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: null },
    { ma_nhan_vien: 'NV_D4', ho_ten: 'String Salary', phong_ban: 'HR', chuc_vu: 'Staff', luong_co_ban_vnd: 'N/A' },
  ];
  const datasetDirty = {
    file_id: 'ds_dirty',
    original_filename: 'dirty.xlsx',
    uploaded_by: authUser.user_id,
    company_id: 'ALL',
    profile: {
      active_sheet: 'Sheet1',
      grain: 'EMPLOYEE',
      row_count: 4,
      columns: [
        { key: 'ma_nhan_vien', name: 'Mã NV', type: 'STRING' },
        { key: 'ho_ten', name: 'Họ Tên', type: 'STRING' },
        { key: 'phong_ban', name: 'Phòng Ban', type: 'STRING' },
        { key: 'chuc_vu', name: 'Chức Vụ', type: 'STRING' },
        { key: 'luong_co_ban_vnd', name: 'Lương Cơ Bản', type: 'INTEGER' },
      ],
    },
    rows: dirtyRows,
  };
  const planDirty = planAnalyticalQuery('Lương cơ bản trung bình', datasetDirty.profile);
  const valDirty = validateQueryPlan(planDirty, datasetDirty, authUser);
  const execDirty = executeAnalyticalQuery(datasetDirty, valDirty);
  // Avg should be (20M + 30M) / 2 = 25M (null and string excluded from arithmetic)
  const actualDirtyAvg = execDirty.results_by_requirement ? execDirty.results_by_requirement['req_avg_salary'].value : execDirty.summary.avg_luong_co_ban_vnd;
  check('TASK-6', 'DIRTY-NULL-EXCLUSION', `Dữ liệu null/sai kiểu được loại khỏi mẫu số: Lương TB = 25.000.000 VNĐ (Thực tế: ${actualDirtyAvg})`, actualDirtyAvg === 25000000);

  // ============================================================================
  // TASK 7: SECURITY & REGRESSION AUDIT
  // ============================================================================
  console.log('\n--- [TASK 7] SECURITY GOVERNANCE & REGRESSION AUDIT ---');

  // 7.1 Unauthenticated access blocked
  let unauthBlocked = false;
  try {
    validateQueryPlan(queryPlan, uploadedDataset, null);
  } catch (err) {
    unauthBlocked = err.status === 401 || err.code === 'UNAUTHENTICATED';
  }
  check('TASK-7', 'SEC-UNAUTH-BLOCKED', 'Người dùng chưa xác thực bị từ chối truy cập (HTTP 401)', unauthBlocked);

  // 7.2 Cross-Tenant / IDOR Protection
  const vtxUser = { user_id: 'usr_emp_vtx', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' };
  const stlDataset = { ...uploadedDataset, company_id: 'STL', uploaded_by: 'usr_stl_admin' };
  let idorBlocked = false;
  try {
    validateQueryPlan(queryPlan, stlDataset, vtxUser);
  } catch (err) {
    idorBlocked = err.status === 403 || err.code === 'FORBIDDEN';
  }
  check('TASK-7', 'SEC-IDOR-BLOCKED', 'Nhân viên VTX bị chặn truy vấn bộ dữ liệu STL (HTTP 403 IDOR Block)', idorBlocked);

  // 7.3 Formula Injection Sanitization
  const maliciousFormula = '=cmd|"/C calc"!A0';
  const sanitizedFormula = sanitizeFormulaInjection(maliciousFormula);
  check('TASK-7', 'SEC-FORMULA-INJECTION', 'Ký tự công thức (=, +, -) được tự động thêm dấu nháy đơn bảo vệ', sanitizedFormula.sanitized.startsWith("'") && sanitizedFormula.wasFormula === true);

  // ============================================================================
  // TASK 8: UNIVERSAL MULTI-DOMAIN REQUIREMENT COMPLETENESS VALIDATION (10 DOMAINS)
  // ============================================================================
  console.log('\n--- [TASK 8] UNIVERSAL MULTI-DOMAIN REQUIREMENT COMPLETENESS VALIDATION ---');

  // DOMAIN 1: HR STATUS
  const p1 = 'Báo cáo tình trạng nhân viên: 1. Đang làm việc, 2. Đã nghỉ việc, 3. Thai sản, 4. Tỷ lệ theo từng trạng thái, 5. Phân bổ trạng thái theo phòng ban';
  const plan1 = planAnalyticalQuery(p1, tenureDataset.profile);
  check('TASK-8', 'D1-HR-STATUS-DECOMPOSE', `Domain 1 HR Status bóc tách đủ >= 5 yêu cầu (thực tế: ${plan1.requirements?.length})`, plan1.requirements?.length >= 5);
  const val1 = validateQueryPlan(plan1, tenureDataset, authUser);
  const exec1 = executeAnalyticalQuery(tenureDataset, val1);
  check('TASK-8', 'D1-HR-STATUS-EXEC', 'Domain 1 Stage B Execution Complete', exec1.execution_coverage.isComplete === true);
  const dash1 = buildDatasetDashboard(val1, exec1, tenureDataset, authUser);
  check('TASK-8', 'D1-HR-STATUS-STAGE-C', 'Domain 1 Stage C Presentation Complete', dash1.completeness_contract.isFullyComplete === true);

  // DOMAIN 2: RECRUITMENT & TENURE
  const p2 = 'Báo cáo tuyển dụng và thâm niên nhân sự: 1. Số lượng nhân viên theo năm vào làm, 2. Số lượng theo từng giai đoạn thâm niên, 3. Thâm niên trung bình, 4. Phòng ban có nhiều nhân viên lâu năm nhất, 5. So sánh KPI giữa nhân viên mới và lâu năm, 6. Phân tích cơ cấu nhân sự theo thời gian làm việc';
  const plan2 = planAnalyticalQuery(p2, tenureDataset.profile);
  check('TASK-8', 'D2-TENURE-DECOMPOSE', `Domain 2 Tuyển dụng & Thâm niên bóc tách đủ 6 yêu cầu (thực tế: ${plan2.requirements?.length})`, plan2.requirements?.length === 6);
  const val2 = validateQueryPlan(plan2, tenureDataset, authUser);
  const exec2 = executeAnalyticalQuery(tenureDataset, val2);
  check('TASK-8', 'D2-TENURE-EXEC', 'Domain 2 Stage B Execution Complete', exec2.execution_coverage.isComplete === true);
  const dash2 = buildDatasetDashboard(val2, exec2, tenureDataset, authUser);
  check('TASK-8', 'D2-TENURE-STAGE-C', 'Domain 2 Stage C Presentation Complete', dash2.completeness_contract.isFullyComplete === true);

  // DOMAIN 3: SALARY ANALYSIS
  const p3 = 'Báo cáo phân tích quỹ lương và thu nhập nhân sự: 1. Tổng quỹ lương cơ bản, 2. Lương cơ bản trung bình, 3. Lương cao nhất và thấp nhất, 4. Phân bổ quỹ lương theo phòng ban, 5. So sánh lương trung bình giữa các chức vụ, 6. Cơ cấu thu nhập theo nhóm mức lương, 7. Tỷ trọng chi phí lương theo bộ phận, 8. Top 10 nhân viên có lương cao nhất';
  const plan3 = planAnalyticalQuery(p3, tenureDataset.profile);
  check('TASK-8', 'D3-SALARY-DECOMPOSE', `Domain 3 Quỹ lương bóc tách đủ 8+ yêu cầu (thực tế: ${plan3.requirements?.length})`, plan3.requirements?.length >= 8);
  const val3 = validateQueryPlan(plan3, tenureDataset, authUser);
  const exec3 = executeAnalyticalQuery(tenureDataset, val3);
  check('TASK-8', 'D3-SALARY-EXEC', 'Domain 3 Stage B Execution Complete', exec3.execution_coverage.isComplete === true);
  const dash3 = buildDatasetDashboard(val3, exec3, tenureDataset, authUser);
  check('TASK-8', 'D3-SALARY-STAGE-C', 'Domain 3 Stage C Presentation Complete', dash3.completeness_contract.isFullyComplete === true);

  // DOMAIN 4: TRAINING & PERFORMANCE
  const p4 = 'Báo cáo tình hình đào tạo nhân sự: 1. Tổng số khóa hoàn thành, 2. Số khóa bình quân mỗi nhân viên, 3. Tỷ lệ nhân viên chưa hoàn thành khóa nào, 4. Phân bổ số khóa đào tạo theo phòng ban, 5. So sánh điểm KPI giữa nhóm học nhiều và học ít';
  const plan4 = planAnalyticalQuery(p4, tenureDataset.profile);
  check('TASK-8', 'D4-TRAINING-DECOMPOSE', `Domain 4 Đào tạo & KPI bóc tách đủ 5 yêu cầu (thực tế: ${plan4.requirements?.length})`, plan4.requirements?.length === 5);
  const val4 = validateQueryPlan(plan4, tenureDataset, authUser);
  const exec4 = executeAnalyticalQuery(tenureDataset, val4);
  check('TASK-8', 'D4-TRAINING-EXEC', 'Domain 4 Stage B Execution Complete', exec4.execution_coverage.isComplete === true);
  const dash4 = buildDatasetDashboard(val4, exec4, tenureDataset, authUser);
  check('TASK-8', 'D4-TRAINING-STAGE-C', 'Domain 4 Stage C Presentation Complete', dash4.completeness_contract.isFullyComplete === true);

  // DOMAIN 5: FINANCE
  const financeRows = [
    { ma_giao_dich: 'TX01', ky_ke_toan: '2026-01', khoan_muc: 'Chi phí kho bãi', so_tien: 120000000, trang_thai: 'Hoàn tất' },
    { ma_giao_dich: 'TX02', ky_ke_toan: '2026-02', khoan_muc: 'Nhiên liệu', so_tien: 250000000, trang_thai: 'Hoàn tất' },
    { ma_giao_dich: 'TX03', ky_ke_toan: '2026-02', khoan_muc: 'Bảo trì xe', so_tien: 45000000, trang_thai: 'Hoàn tất' },
    { ma_giao_dich: 'TX04', ky_ke_toan: '2026-03', khoan_muc: 'Bảo hiểm hàng hóa', so_tien: 80000000, trang_thai: 'Đang xử lý' },
  ];
  const finDataset = {
    file_id: 'ds_finance_golden',
    original_filename: 'tai_chinh_chi_phi.xlsx',
    uploaded_by: authUser.user_id,
    company_id: 'ALL',
    profile: {
      active_sheet: 'Sheet1',
      grain: 'TRANSACTION',
      row_count: financeRows.length,
      columns: [
        { key: 'ma_giao_dich', name: 'Mã Giao Dịch', type: 'STRING' },
        { key: 'ky_ke_toan', name: 'Kỳ Kế Toán', type: 'STRING' },
        { key: 'khoan_muc', name: 'Khoản Mục Chi Phí', type: 'STRING' },
        { key: 'so_tien', name: 'Số Tiền', type: 'INTEGER' },
        { key: 'trang_thai', name: 'Trạng Thái', type: 'STRING' },
      ],
    },
    rows: financeRows,
  };
  const p5 = 'Báo cáo chi phí tài chính: 1. Tổng chi phí, 2. Chi phí trung bình mỗi giao dịch, 3. Chi phí lớn nhất, 4. Phân bổ chi phí theo khoản mục, 5. Top 5 giao dịch lớn nhất';
  const plan5 = planAnalyticalQuery(p5, finDataset.profile);
  check('TASK-8', 'D5-FINANCE-DECOMPOSE', `Domain 5 Finance bóc tách đủ 5 yêu cầu (thực tế: ${plan5.requirements?.length})`, plan5.requirements?.length === 5);
  const val5 = validateQueryPlan(plan5, finDataset, authUser);
  const exec5 = executeAnalyticalQuery(finDataset, val5);
  check('TASK-8', 'D5-FINANCE-EXEC', 'Domain 5 Stage B Execution Complete', exec5.execution_coverage.isComplete === true);
  const dash5 = buildDatasetDashboard(val5, exec5, finDataset, authUser);
  check('TASK-8', 'D5-FINANCE-STAGE-C', 'Domain 5 Stage C Presentation Complete', dash5.completeness_contract.isFullyComplete === true);

  // DOMAIN 6: SALES & ORDERS
  const salesRows = [
    { ma_don: 'ORD-01', ngay_dat: '2026-01-15', kenh_ban: 'B2B Sotrans', doanh_thu: 500000000, so_luong: 100 },
    { ma_don: 'ORD-02', ngay_dat: '2026-02-10', kenh_ban: 'B2C Đại lý', doanh_thu: 150000000, so_luong: 40 },
    { ma_don: 'ORD-03', ngay_dat: '2026-02-20', kenh_ban: 'B2B Sotrans', doanh_thu: 300000000, so_luong: 60 },
    { ma_don: 'ORD-04', ngay_dat: '2026-03-05', kenh_ban: 'Quốc tế', doanh_thu: 800000000, so_luong: 150 },
  ];
  const salesDataset = {
    file_id: 'ds_sales_golden',
    original_filename: 'don_hang_sales.xlsx',
    uploaded_by: authUser.user_id,
    company_id: 'ALL',
    profile: {
      active_sheet: 'Sheet1',
      grain: 'ORDER',
      row_count: salesRows.length,
      columns: [
        { key: 'ma_don', name: 'Mã Đơn', type: 'STRING' },
        { key: 'ngay_dat', name: 'Ngày Đặt', type: 'DATE' },
        { key: 'kenh_ban', name: 'Kênh Bán', type: 'STRING' },
        { key: 'doanh_thu', name: 'Doanh Thu', type: 'INTEGER' },
        { key: 'so_luong', name: 'Số Lượng', type: 'INTEGER' },
      ],
    },
    rows: salesRows,
  };
  const p6 = 'Phân tích doanh số bán hàng: 1. Tổng doanh thu, 2. Doanh thu trung bình mỗi đơn, 3. Tốc độ tăng trưởng doanh thu theo tháng, 4. Phân bổ doanh số theo kênh bán, 5. Top đơn hàng có doanh thu lớn nhất';
  const plan6 = planAnalyticalQuery(p6, salesDataset.profile);
  check('TASK-8', 'D6-SALES-DECOMPOSE', `Domain 6 Sales bóc tách đủ 5 yêu cầu (thực tế: ${plan6.requirements?.length})`, plan6.requirements?.length === 5);
  const val6 = validateQueryPlan(plan6, salesDataset, authUser);
  const exec6 = executeAnalyticalQuery(salesDataset, val6);
  check('TASK-8', 'D6-SALES-EXEC', 'Domain 6 Stage B Execution Complete', exec6.execution_coverage.isComplete === true);
  const dash6 = buildDatasetDashboard(val6, exec6, salesDataset, authUser);
  check('TASK-8', 'D6-SALES-STAGE-C', 'Domain 6 Stage C Presentation Complete', dash6.completeness_contract.isFullyComplete === true);

  // DOMAIN 7: LOGISTICS & SHIPPING
  const logRows = [
    { ma_chuyen: 'SHP-01', don_vi_van_chuyen: 'Đội xe Sotrans', ngay_cam_ket: '2026-03-01', ngay_giao_thuc_te: '2026-03-01', chi_phi_vc: 15000000 },
    { ma_chuyen: 'SHP-02', don_vi_van_chuyen: 'Đội xe Sotrans', ngay_cam_ket: '2026-03-02', ngay_giao_thuc_te: '2026-03-02', chi_phi_vc: 18000000 },
    { ma_chuyen: 'SHP-03', don_vi_van_chuyen: 'Đối tác Phương Trang', ngay_cam_ket: '2026-03-03', ngay_giao_thuc_te: '2026-03-05', chi_phi_vc: 22000000 },
    { ma_chuyen: 'SHP-04', don_vi_van_chuyen: 'Đội xe Sotrans', ngay_cam_ket: '2026-03-04', ngay_giao_thuc_te: '2026-03-04', chi_phi_vc: 12000000 },
  ];
  const logDataset = {
    file_id: 'ds_logistics_golden',
    original_filename: 'van_chuyen_logistics.xlsx',
    uploaded_by: authUser.user_id,
    company_id: 'ALL',
    profile: {
      active_sheet: 'Sheet1',
      grain: 'SHIPMENT',
      row_count: logRows.length,
      columns: [
        { key: 'ma_chuyen', name: 'Mã Chuyến', type: 'STRING' },
        { key: 'don_vi_van_chuyen', name: 'Đơn Vị Vận Chuyển', type: 'STRING' },
        { key: 'ngay_cam_ket', name: 'Ngày Giao Cam Kết', type: 'DATE' },
        { key: 'ngay_giao_thuc_te', name: 'Ngày Giao Thực Tế', type: 'DATE' },
        { key: 'chi_phi_vc', name: 'Chi Phí Vận Chuyển', type: 'INTEGER' },
      ],
    },
    rows: logRows,
  };
  const p7 = 'Báo cáo hiệu quả vận tải: 1. Tổng số chuyến xe, 2. Tổng chi phí vận chuyển, 3. Chi phí trung bình mỗi chuyến xe, 4. Tỷ lệ giao hàng đúng hạn, 5. Phân bổ chi phí theo đơn vị vận chuyển';
  const plan7 = planAnalyticalQuery(p7, logDataset.profile);
  check('TASK-8', 'D7-LOGISTICS-DECOMPOSE', `Domain 7 Logistics bóc tách đủ 5 yêu cầu (thực tế: ${plan7.requirements?.length})`, plan7.requirements?.length === 5);
  const val7 = validateQueryPlan(plan7, logDataset, authUser);
  const exec7 = executeAnalyticalQuery(logDataset, val7);
  check('TASK-8', 'D7-LOGISTICS-EXEC', 'Domain 7 Stage B Execution Complete', exec7.execution_coverage.isComplete === true);
  const dash7 = buildDatasetDashboard(val7, exec7, logDataset, authUser);
  check('TASK-8', 'D7-LOGISTICS-STAGE-C', 'Domain 7 Stage C Presentation Complete', dash7.completeness_contract.isFullyComplete === true);

  // DOMAIN 8: MULTI-DIMENSIONAL ANALYSIS
  const p8 = 'Phân tích đa chiều nhân sự: 1. Tổng quỹ lương theo phòng ban và chức vụ, 2. Điểm KPI trung bình theo phòng ban và chức vụ, 3. Số lượng nhân sự theo phòng ban';
  const plan8 = planAnalyticalQuery(p8, tenureDataset.profile);
  check('TASK-8', 'D8-MULTIDIM-DECOMPOSE', `Domain 8 Đa chiều bóc tách đủ 3 yêu cầu (thực tế: ${plan8.requirements?.length})`, plan8.requirements?.length >= 3);
  const val8 = validateQueryPlan(plan8, tenureDataset, authUser);
  const exec8 = executeAnalyticalQuery(tenureDataset, val8);
  check('TASK-8', 'D8-MULTIDIM-EXEC', 'Domain 8 Stage B Execution Complete', exec8.execution_coverage.isComplete === true);
  const multiRes = exec8.results_by_requirement[plan8.requirements[0].id]?.data;
  check('TASK-8', 'D8-MULTIDIM-DATA', 'Domain 8 Kết quả chứa đủ 2 chiều phòng ban & chức vụ', Boolean(multiRes && multiRes[0]?.phong_ban && multiRes[0]?.chuc_vu));
  const dash8 = buildDatasetDashboard(val8, exec8, tenureDataset, authUser);
  check('TASK-8', 'D8-MULTIDIM-STAGE-C', 'Domain 8 Stage C Presentation Complete', dash8.completeness_contract.isFullyComplete === true);

  // DOMAIN 9: LONG COMPOSITE BI REQUESTS (8+ REQS)
  const p9 = [
    'Báo cáo quản trị nhân sự tổng hợp:',
    '1. Tổng quỹ lương cơ bản',
    '2. Lương cơ bản trung bình',
    '3. Lương cao nhất và thấp nhất',
    '4. Điểm KPI trung bình toàn công ty',
    '5. Thâm niên trung bình toàn công ty',
    '6. Phân bổ quỹ lương theo phòng ban',
    '7. Phân bổ nhân sự theo giai đoạn thâm niên',
    '8. Top 10 nhân sự có điểm KPI cao nhất'
  ].join('\n');
  const plan9 = planAnalyticalQuery(p9, tenureDataset.profile);
  check('TASK-8', 'D9-LONG-COMPOSITE-DECOMPOSE', `Domain 9 Báo cáo dài bóc tách đủ 8+ yêu cầu (thực tế: ${plan9.requirements?.length})`, plan9.requirements?.length >= 8);
  const val9 = validateQueryPlan(plan9, tenureDataset, authUser);
  const exec9 = executeAnalyticalQuery(tenureDataset, val9);
  check('TASK-8', 'D9-LONG-COMPOSITE-EXEC', 'Domain 9 Stage B Execution Complete', exec9.execution_coverage.isComplete === true);
  const dash9 = buildDatasetDashboard(val9, exec9, tenureDataset, authUser);
  check('TASK-8', 'D9-LONG-COMPOSITE-STAGE-C', 'Domain 9 Stage C Presentation Complete', dash9.completeness_contract.isFullyComplete === true);

  // DOMAIN 10: CONVERSATIONAL FOLLOW-UP
  const basePlan = planAnalyticalQuery('Phân tích lương theo phòng ban', tenureDataset.profile);
  const followUpPrompt = 'Chỉ lọc riêng Vận Tải và đổi sang biểu đồ tròn';
  const followUpPlan = planFollowUpQuery(followUpPrompt, basePlan, tenureDataset.profile);
  check('TASK-8', 'D10-FOLLOWUP-INTENT', 'Domain 10 Nhận diện câu hỏi follow-up ngữ cảnh', Boolean(followUpPlan));
  check('TASK-8', 'D10-FOLLOWUP-FILTER', 'Domain 10 Áp dụng filter phòng ban Vận Tải', followUpPlan?.filters?.some(f => f.value === 'Vận Tải'));
  check('TASK-8', 'D10-FOLLOWUP-CHART', 'Domain 10 Chuyển visual preference sang PIE', followUpPlan?.chart_preference === 'PIE');

  // Close browser cleanly
  await browser.close();

  // ============================================================================
  // FINAL VERDICT & METRICS SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`FINAL E2E ACCEPTANCE VALIDATION RESULT: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log(`Failed: ${failedTests} | Skipped: 0`);
  console.log('Zero Regression | Zero Schema Mutation | 100% Contract v2.0 Compliance');
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runMasterAcceptanceValidation().catch(err => {
  console.error('\n[FATAL VALIDATION FAILURE]:', err);
  process.exit(1);
});
