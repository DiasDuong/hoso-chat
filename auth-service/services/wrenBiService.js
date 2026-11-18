'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertValidDashboardPayload } = require('./biDashboardSchemaValidator');
const { sanitizeBiData } = require('./biPrivacy');
const { logBiAuditEvent } = require('./biAuditLogger');
const { signReport } = require('./biExportToken');

const COMPANIES = ['STL', 'VTX', 'SWC', 'ALL'];
function scopeFor(user, company) {
  if (!user?.user_id || user.status !== 'ACTIVE' || !['ADMIN', 'HR'].includes(user.role)) throw Object.assign(new Error('BI chỉ dành cho ADMIN/HR đang hoạt động.'), { status: 403, code: 'WREN_FORBIDDEN' });
  if (user.role === 'HR') {
    if (!COMPANIES.slice(0, 3).includes(user.company_id)) throw Object.assign(new Error('Đơn vị không hợp lệ.'), { status: 403 });
    if (company && company !== user.company_id) throw Object.assign(new Error('Không có quyền xem đơn vị khác.'), { status: 403 });
    return user.company_id;
  }
  if (!COMPANIES.includes(company)) throw Object.assign(new Error('Vui lòng chọn STL, VTX, SWC hoặc ALL.'), { status: 400, code: 'WREN_SCOPE_REQUIRED' });
  return company;
}

function configuration() {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(__dirname, '../storage/bi_wren_config.json'), 'utf8')); } catch (_) {}
  const enabled = process.env.WREN_BI_ENABLED !== undefined ? process.env.WREN_BI_ENABLED === 'true' : local.enabled === true;
  const url = process.env.WREN_SERVICE_URL || local.url;
  const token = process.env.WREN_SERVICE_TOKEN || local.token;
  if (!enabled || typeof token !== 'string' || token.length < 32) return { enabled: false };
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return { enabled: false };
    return { enabled: true, url: parsed.origin, token };
  } catch (_) { return { enabled: false }; }
}

async function serviceRequest(endpoint, body, config = configuration()) {
  if (!config.enabled) throw Object.assign(new Error('Wren BI chưa được bật.'), { status: 503, code: 'WREN_DISABLED' });
  const response = await fetch(`${config.url}${endpoint}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) { await reader.cancel(); throw Object.assign(new Error('Kết quả Wren vượt giới hạn.'), { code: 'WREN_OUTPUT_LIMIT' }); }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const result = JSON.parse(text);
  if (!response.ok || result.success === false) throw Object.assign(new Error('Không thể truy vấn báo cáo Wren theo phạm vi này.'), { status: response.status, code: result.code || 'WREN_QUERY_FAILED' });
  return result;
}

function shouldHandle(message, fixedIntent, previousContext) {
  if (!configuration().enabled) return false;
  const q = String(message).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  if (/quy dinh|nghi phep|noi dung van ban|tom tat van ban/.test(q) && !/thong ke|bao cao|phan tich|so luong/.test(q)) return false;
  if (previousContext?.engine === 'wren' && /^(con |the |vay |chi |doi |loc |so voi|thang |quy |nam )/.test(q)) return true;
  if (/wren|phan tich nang cao|truy van nang cao/.test(q)) return true;
  const analytical = /phan tich|thong ke|bao cao|so sanh|tong|so luong|dashboard/.test(q);
  const internal = /van ban|tiep nhan|lo ho so|staging|ho so/.test(q);
  return analytical && internal && ((!fixedIntent?.isBIQuery) || /theo .+ va |dong thoi|nhieu chieu/.test(q));
}

function decodeDraft(text) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('INVALID_MODEL_DRAFT');
  if (value.clarification_question) return { clarification_question: String(value.clarification_question).slice(0, 500) };
  if (typeof value.sql !== 'string' || !value.sql.trim() || value.sql.length > 8000) throw new Error('INVALID_MODEL_SQL');
  return { sql: value.sql, title: String(value.title || 'Báo cáo phân tích').slice(0, 160), chart_type: ['BAR', 'LINE', 'PIE', 'DONUT', 'AREA', 'STACKED_BAR', 'TREEMAP'].includes(value.chart_type) ? value.chart_type : 'BAR' };
}

function resultDashboard(result, draft, user) {
  const rows = sanitizeBiData(result.rows || []);
  for (const row of rows) for (const key of result.numeric_columns || []) {
    if (typeof row[key] === 'string' && /^-?\d+(?:\.\d+)?$/.test(row[key]) && Number.isFinite(Number(row[key])) && Math.abs(Number(row[key])) <= Number.MAX_SAFE_INTEGER) row[key] = Number(row[key]);
  }
  const fields = result.columns || Object.keys(rows[0] || {});
  const numeric = fields.filter(k => rows.some(r => typeof r[k] === 'number'));
  const dimensions = fields.filter(k => !numeric.includes(k));
  const dataRef = 'wren_result';
  const metrics = rows.length === 1 ? numeric.map((key, i) => ({ id: `wren_metric_${i}`, kpi_code: key.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), title: key, primary_value: rows[0][key], format: 'NUMBER', status: 'AVAILABLE', subtext: 'Kết quả truy vấn Wren trong phạm vi đã xác thực.' })) : [];
  metrics.push({ id: 'wren_visible_groups', kpi_code: 'WREN_RETURNED_ROWS', title: 'Nhóm kết quả', primary_value: rows.length, format: 'NUMBER', status: 'AVAILABLE', subtext: result.may_be_truncated ? 'Đạt giới hạn hiển thị; không phải tổng số nhóm toàn dữ liệu.' : 'Số nhóm được trả về từ truy vấn.' });
  const visualizations = dimensions.length ? numeric.slice(0, 8).map((key, i) => ({ id: `wren_visual_${i}`, title: `${key} theo ${dimensions[0]}`, chart_type: draft.chart_type, data_ref: dataRef, mapping: { category: dimensions[0], value: key }, drill_dimensions: dimensions, interactions: { selectable: true, filterable: true, drilldown: dimensions.length > 1 }, grid_col_span: numeric.length > 1 ? 6 : 12 })) : [];
  const payload = {
    version: '2.0', dashboard_id: `dash_wren_${crypto.randomUUID()}`, source_type: 'INTERNAL_SYSTEM', title: draft.title,
    subtitle: `Đơn vị ${result.company_id} · Wren semantic engine`, generated_at: new Date().toISOString(),
    provenance: { source_system: 'SOTRANS Hub', generated_by: 'WrenAI', tenant_scope: result.company_id, source_tables: result.source_tables, manifest_sha256: result.manifest_sha256, request_id: result.request_id },
    filters: { current_state: { company_id: result.company_id }, supported_dimensions: dimensions, slicers: dimensions.map(key => ({ id: `wren_filter_${key}`, dimension: key, label: key, type: /date|day|period|month/i.test(key) ? 'date' : 'category' })) },
    kpi_strip: metrics, visualizations, data_tables: rows.length ? [{ id: 'wren_table', title: 'Dữ liệu truy vấn', data_ref: dataRef, columns: fields.map(key => ({ key, label: key, type: numeric.includes(key) ? 'number' : 'string' })), pagination: { page_size: 15, total_rows: rows.length } }] : [],
    data_store: { [dataRef]: rows },
  };
  assertValidDashboardPayload(payload, user);
  return signReport(payload, user);
}

async function performReport({ message, user, companyId, previousContext, generate, request = serviceRequest }) {
  const company = scopeFor(user, companyId || previousContext?.company_id);
  const model = await request('/catalog');
  const todayVN = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const prompt = `Lập kế hoạch BI SOTRANS dưới dạng JSON {sql,title,chart_type} hoặc {clarification_question}. Chỉ dùng tên model/cột trong catalog, SELECT một statement, không bảng vật lý, không sinh số liệu, không SQL literal-only. Hồ sơ staging không phải headcount. Hãy hỏi lại nếu thiếu nguồn hoặc metric bị khóa. Ngày hiện tại tại Việt Nam: ${todayVN}. Khoảng thời gian dùng đầu kỳ bao gồm, đầu kỳ tiếp theo loại trừ.\nCatalog: ${JSON.stringify(model)}\nContext trước: ${JSON.stringify(previousContext?.engine === 'wren' ? { question: previousContext.question, sql: previousContext.sql } : null)}\nPhạm vi đã xác thực: ${company}\nYêu cầu: ${message}`;
  let draft, result;
  for (let attempt = 0; attempt < 2; attempt++) {
    draft = decodeDraft(await generate(prompt + (attempt ? '\nKế hoạch trước không hợp lệ. Chỉ dùng model/cột/hàm được cho phép hoặc yêu cầu làm rõ.' : '')));
    if (draft.clarification_question) return { reply: draft.clarification_question, context: null };
    try {
      result = await request('/query', { sql: draft.sql, company_id: company, limit: 500, request_id: crypto.randomUUID() });
      if (!result.executed || result.company_id !== company) throw new Error('INVALID_EXECUTION_RESPONSE');
      break;
    } catch (error) { if (attempt || !['INVALID_SQL', 'INVALID_MODEL_OR_COLUMN', 'MODEL_NOT_FOUND'].includes(error.code)) throw error; }
  }
  const payload = resultDashboard(result, draft, user);
  const safe = JSON.stringify(payload).replace(/-->/g, '--\\u003e').replace(/<!--/g, '\\u003c!--');
  await logBiAuditEvent({ event: 'WREN_QUERY', userContext: user, details: { company_id: company, request_id: result.request_id, manifest_sha256: result.manifest_sha256, source_tables: result.source_tables, returned_rows: result.returned_rows, execution_time_ms: result.execution_time_ms }, executionTimeMs: result.execution_time_ms });
  return {
    reply: `## ${draft.title.replace(/[<>]/g, '')}\n\n<!-- bi-dashboard-v2: ${safe} -->\n\n*Nguồn: ${result.source_tables.join(', ')} · Phạm vi: ${company} · Engine: WrenAI*`,
    context: { engine: 'wren', company_id: company, question: String(message).slice(0, 1000), sql: draft.sql, manifest_sha256: result.manifest_sha256 },
  };
}

async function runReport(options) {
  try { return await performReport(options); }
  catch (error) {
    await logBiAuditEvent({ event: 'WREN_QUERY_FAILED', userContext: options.user, status: error.status === 403 ? 'DENIED' : 'FAILED', details: { error_code: error.code || 'WREN_REPORT_FAILED' } });
    throw error;
  }
}

module.exports = { configuration, scopeFor, shouldHandle, decodeDraft, resultDashboard, runReport, serviceRequest };
