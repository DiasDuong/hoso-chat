/* SOTRANS Hub BI controls. All values are data; no payload code is executed. */
(function () {
  'use strict';
  const states = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stateFor = p => {
    if (!states.has(p.dashboard_id)) states.set(p.dashboard_id, { filters: {}, ranges: {}, tables: {}, drill: {}, basePlan: p.query_context?.base_plan, revision: 0 });
    return states.get(p.dashboard_id);
  };
  const payloadFor = id => window._biDashboardPayloadStore?.get(id);
  const rootFor = id => document.getElementById(`bi-dash-${id}`);
  function dateKey(value) {
    const v = String(value || '');
    if (/^\d{4}$/.test(v)) return `${v}-01-01`;
    if (/^\d{4}-Q[1-4]$/.test(v)) return `${v.slice(0, 4)}-${String((Number(v.at(-1)) - 1) * 3 + 1).padStart(2, '0')}-01`;
    return /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v.slice(0, 10);
  }
  function filteredStore(p, state) {
    return Object.fromEntries(Object.entries(p.data_store || {}).map(([ref, rows]) => [ref, rows.filter(row => {
      if (!Object.entries(state.filters).every(([key, value]) => !value || !(key in row) || String(row[key]) === value)) return false;
      return Object.entries(state.ranges).every(([key, range]) => !(key in row) || ((!range.from || dateKey(row[key]) >= range.from) && (!range.to || dateKey(row[key]) <= range.to)));
    })]));
  }
  function controls(p) {
    const s = stateFor(p);
    const dimensions = [...new Set([...(p.filters?.supported_dimensions || []), ...(p.visualizations || []).map(v => v.mapping?.category || v.mapping?.x)])].filter(Boolean).slice(0, 8);
    let html = '';
    for (const key of dimensions) {
      const values = [...new Set(Object.values(p.data_store || {}).flat().filter(r => key in r).map(r => String(r[key])))].sort().slice(0, 100);
      if (!values.length) continue;
      const dateLike = values.some(v => /^\d{4}($|-(\d{2}|Q[1-4]))/.test(v));
      html += `<label>${esc(key)} <select data-bi-dimension="${esc(key)}"><option value="">Tất cả nhóm</option>${values.map(v => `<option value="${esc(v)}"${s.filters[key] === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
      if (dateLike) html += `<label>Từ <input type="date" data-bi-range="${esc(key)}" data-bound="from" value="${esc(s.ranges[key]?.from || '')}"></label><label>Đến <input type="date" data-bi-range="${esc(key)}" data-bound="to" value="${esc(s.ranges[key]?.to || '')}"></label>`;
    }
    const sheets = p.query_context?.sheets || [];
    if (sheets.length > 1) html += `<label>Sheet cho câu hỏi tiếp <select data-bi-sheet>${sheets.map(name => `<option${name === p.query_context.target_sheet ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`;
    return `<div class="bi-controls">${html}<button type="button" data-bi-action="reset">Bỏ lọc</button><button type="button" data-bi-action="xlsx"${p.export_token ? '' : ' disabled'}>Excel</button><button type="button" data-bi-action="pdf">PDF / In</button></div><div class="bi-control-status" role="status">${p.query_context?.file_id ? 'Bộ lọc dữ liệu được xác thực lại trên server.' : 'Lọc các nhóm kết quả đang hiển thị; KPI toàn phạm vi giữ nguyên.'}</div>`;
  }
  function tables(p, store) {
    const s = stateFor(p);
    return (p.data_tables || []).map(table => {
      const state = s.tables[table.id] || (s.tables[table.id] = { page: 0, search: '', sort: '', desc: false });
      let rows = [...(store[table.data_ref] || [])];
      if (state.search) rows = rows.filter(r => Object.values(r).some(v => String(v).toLocaleLowerCase('vi').includes(state.search.toLocaleLowerCase('vi'))));
      if (state.sort) rows.sort((a, b) => {
        const av = a[state.sort], bv = b[state.sort];
        const order = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), 'vi', { numeric: true });
        return state.desc ? -order : order;
      });
      const totalPages = Math.max(1, Math.ceil(rows.length / 15));
      state.page = Math.min(state.page, totalPages - 1);
      const shown = rows.slice(state.page * 15, state.page * 15 + 15);
      const columns = table.columns || [];
      return `<section class="bi-dash-table-wrap" data-bi-table="${esc(table.id)}"><strong>${esc(table.title)}</strong><div class="bi-table-actions"><input type="search" data-bi-search value="${esc(state.search)}" placeholder="Tìm trong bảng" aria-label="Tìm trong bảng"><button type="button" data-bi-action="prev"${state.page === 0 ? ' disabled' : ''}>Trước</button><span>${state.page + 1}/${totalPages} · ${rows.length} dòng</span><button type="button" data-bi-action="next"${state.page + 1 === totalPages ? ' disabled' : ''}>Sau</button></div><div style="overflow:auto;max-height:320px"><table><thead><tr>${columns.map(c => `<th><button type="button" data-bi-sort="${esc(c.key)}">${esc(c.label || c.key)}${state.sort === c.key ? (state.desc ? ' ▼' : ' ▲') : ''}</button></th>`).join('')}</tr></thead><tbody>${shown.map(row => `<tr>${columns.map(c => `<td>${typeof row[c.key] === 'number' ? row[c.key].toLocaleString('vi-VN') : esc(row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
    }).join('');
  }
  function bindChart(id, chart, viz) {
    if (!chart) return;
    chart.off('click');
    chart.on('click', params => {
      const p = payloadFor(id); if (!p) return;
      const state = stateFor(p);
      const dimensions = viz.drill_dimensions?.length ? viz.drill_dimensions : [viz.mapping?.category || viz.mapping?.x];
      const key = dimensions[state.drill[viz.id] || 0];
      const row = filteredStore(p, state)[viz.data_ref]?.[params.dataIndex];
      if (!row || !key) return;
      const value = String(row[key]);
      state.filters[key] = state.filters[key] === value ? '' : value;
      if ((state.drill[viz.id] || 0) + 1 < dimensions.length) state.drill[viz.id] = (state.drill[viz.id] || 0) + 1;
      refresh(id).catch(error => status(id, error.message));
    });
  }
  function status(id, text) { const node = rootFor(id)?.querySelector('.bi-control-status'); if (node) node.textContent = text; }
  function prepare(p, original, store) {
    const state = stateFor(p), dimensions = original.drill_dimensions || [];
    if (!dimensions.length) return { viz: original, store };
    let level = state.drill[original.id] || 0;
    while (level < dimensions.length - 1 && state.filters[dimensions[level]]) level++;
    state.drill[original.id] = level;
    const visible = dimensions.slice(level).filter(key => !state.filters[key]);
    const categories = visible.length ? visible : [dimensions[level]];
    let category = categories[0], chartStore = store;
    if (categories.length > 1) {
      category = '__bi_display_label';
      chartStore = { ...store, [original.data_ref]: (store[original.data_ref] || []).map(row => ({ ...row, [category]: categories.map(key => String(row[key] ?? '')).join(' · ') })) };
    }
    const title = `${String(original.title).replace(/\s+theo\s+.*$/, '')} theo ${categories.join(' / ')}`;
    return { viz: { ...original, title, mapping: { ...original.mapping, category } }, store: chartStore };
  }
  function draw(id) {
    const p = payloadFor(id), root = rootFor(id); if (!p || !root) return;
    const s = stateFor(p), store = filteredStore(p, s);
    root.querySelectorAll('.bi-chart-host').forEach(host => {
      const original = p.visualizations.find(v => v.id === host.dataset.vizId); if (!original) return;
      const prepared = prepare(p, original, store);
      const label = host.closest('.bi-chart-card')?.querySelector('.bi-chart-title'); if (label) label.textContent = `📈 ${prepared.viz.title}`;
      bindChart(id, window.renderEChartInstance(host, prepared.viz, prepared.store), original);
    });
    root.querySelectorAll(':scope > .bi-dash-table-wrap').forEach(node => node.remove());
    root.querySelector('.bi-dash-footer')?.insertAdjacentHTML('beforebegin', tables(p, store));
    root.querySelectorAll('[data-bi-dimension]').forEach(select => { select.value = s.filters[select.dataset.biDimension] || ''; });
    status(id, `${Object.values(store).reduce((n, rows) => n + rows.length, 0)} nhóm hiển thị. ${p.query_context?.file_id ? 'KPI được tính lại trên dữ liệu đã lọc.' : 'KPI toàn phạm vi truy vấn giữ nguyên; biểu đồ/bảng lọc theo cột chung.'}`);
  }
  function serverFilters(p, state) {
    const filters = [...(state.basePlan?.filters || [])];
    for (const [column, value] of Object.entries(state.filters)) if (value) {
      const group = (state.basePlan?.groupBy || []).find(g => typeof g === 'object' && g.column === column);
      if (group?.date_trunc) {
        const from = dateKey(value); const end = new Date(`${from}T00:00:00Z`);
        if (group.date_trunc === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
        else if (group.date_trunc === 'quarter') end.setUTCMonth(end.getUTCMonth() + 3);
        else if (group.date_trunc === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
        else end.setUTCDate(end.getUTCDate() + 1);
        filters.push({ column, op: 'gte', value: from }, { column, op: 'lt', value: end.toISOString().slice(0, 10) });
      } else filters.push({ column, op: 'eq', value });
    }
    for (const [column, range] of Object.entries(state.ranges)) {
      if (range.from) filters.push({ column, op: 'gte', value: range.from });
      if (range.to) { const end = new Date(`${range.to}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1); filters.push({ column, op: 'lt', value: end.toISOString().slice(0, 10) }); }
    }
    return filters;
  }
  async function refresh(id) {
    const p = payloadFor(id), root = rootFor(id); if (!p || !root) return;
    const state = stateFor(p);
    if (!p.query_context?.file_id || !state.basePlan) return draw(id);
    state.abort?.abort(); state.abort = new AbortController(); const revision = ++state.revision;
    status(id, 'Đang tính lại theo bộ lọc...');
    const response = await fetch(`/api/analytics/files/${encodeURIComponent(p.query_context.file_id)}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${window.getAuthToken()}`, 'Content-Type': 'application/json' },
      signal: state.abort.signal, body: JSON.stringify({ ...state.basePlan, filters: serverFilters(p, state) }),
    });
    const result = await response.json();
    if (!response.ok || !result.dashboard) throw new Error(result.error || 'Không thể áp dụng bộ lọc hoặc quyền dữ liệu đã thay đổi.');
    if (revision !== state.revision || !root.isConnected) return;
    const next = result.dashboard;
    states.set(next.dashboard_id, state);
    window.disposeBIDashboard(id); states.delete(id);
    root.outerHTML = window.renderInteractiveBIDashboard(next);
    window.mountBIDashboardsInElement(document.body);
    draw(next.dashboard_id);
    status(next.dashboard_id, 'Đã cập nhật số liệu từ dataset theo bộ lọc và quyền hiện tại.');
  }
  async function exportExcel(id) {
    const p = payloadFor(id); if (!p) return;
    const response = await fetch('/api/analytics/export', { method: 'POST', headers: { Authorization: `Bearer ${window.getAuthToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: p, filters: stateFor(p).filters, ranges: stateFor(p).ranges }) });
    if (!response.ok) throw new Error('Không thể xuất báo cáo. Vui lòng tạo lại báo cáo và kiểm tra quyền.');
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'sotrans-bi-report.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function printReport(id) {
    const root = rootFor(id); if (!root) return;
    const clone = root.cloneNode(true);
    const canvases = [...root.querySelectorAll('canvas')];
    clone.querySelectorAll('canvas').forEach((node, i) => { const img = document.createElement('img'); img.src = canvases[i].toDataURL(); img.style.maxWidth = '100%'; node.replaceWith(img); });
    clone.querySelectorAll('.bi-controls,.bi-table-actions').forEach(node => node.remove());
    clone.querySelectorAll('button').forEach(node => node.replaceWith(document.createTextNode(node.textContent)));
    const note = document.createElement('p'); note.textContent = 'Bản in biểu đồ và trang bảng đang hiển thị. Dùng Excel để xuất toàn bộ nhóm trong báo cáo.'; clone.appendChild(note);
    const frame = document.createElement('iframe'); frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px'; document.body.appendChild(frame);
    const doc = frame.contentDocument; doc.open(); doc.write('<!doctype html><meta charset="utf-8"><title>SOTRANS BI</title><style>body{font-family:Arial,sans-serif}table{width:100%;border-collapse:collapse}td,th{border:1px solid #bbb;padding:6px}img{max-width:100%}.bi-chart-card{break-inside:avoid}</style>'); doc.close();
    doc.body.appendChild(clone); frame.contentWindow.focus(); setTimeout(() => frame.contentWindow.print(), 250); setTimeout(() => frame.remove(), 60000);
  }
  document.addEventListener('change', event => {
    const root = event.target.closest('.bi-interactive-dashboard'); if (!root) return;
    const p = payloadFor(root.dataset.dashId); if (!p) return;
    const state = stateFor(p), target = event.target;
    if (target.hasAttribute('data-bi-sheet')) {
      window.activeBiDatasetId = p.query_context.file_id; window.activeBiDatasetSheet = target.value;
      status(p.dashboard_id, `Sheet cho câu hỏi tiếp theo: ${target.value}. Hãy nhập yêu cầu trong General AI.`); return;
    }
    if (target.dataset.biDimension) state.filters[target.dataset.biDimension] = target.value;
    else if (target.dataset.biRange) (state.ranges[target.dataset.biRange] ||= {})[target.dataset.bound] = target.value;
    else if (target.hasAttribute('data-bi-search')) { const id = target.closest('[data-bi-table]').dataset.biTable; state.tables[id].search = target.value; state.tables[id].page = 0; return draw(p.dashboard_id); }
    else return;
    refresh(p.dashboard_id).catch(error => { if (error.name !== 'AbortError') status(p.dashboard_id, error.message); });
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-bi-action],[data-bi-sort]'); if (!button) return;
    const root = button.closest('.bi-interactive-dashboard'); if (!root) return;
    const p = payloadFor(root.dataset.dashId); if (!p) return;
    const state = stateFor(p), action = button.dataset.biAction;
    if (button.hasAttribute('data-bi-sort')) { const table = state.tables[button.closest('[data-bi-table]').dataset.biTable]; table.desc = table.sort === button.dataset.biSort ? !table.desc : false; table.sort = button.dataset.biSort; return draw(p.dashboard_id); }
    if (action === 'reset') { state.filters = {}; state.ranges = {}; state.drill = {}; refresh(p.dashboard_id).catch(error => status(p.dashboard_id, error.message)); }
    else if (action === 'xlsx') exportExcel(p.dashboard_id).catch(error => status(p.dashboard_id, error.message));
    else if (action === 'pdf') printReport(p.dashboard_id);
    else if (action === 'prev' || action === 'next') { const table = state.tables[button.closest('[data-bi-table]').dataset.biTable]; table.page = Math.max(0, table.page + (action === 'next' ? 1 : -1)); draw(p.dashboard_id); }
  });
  window.HubBIDashboard = { controls, tables, bindChart, draw, prepare, filteredStore, stateFor, serverFilters, printReport };
  // Conversation changes remove DOM nodes: release charts, observers and state.
  document.addEventListener('DOMContentLoaded', () => {
    let scheduled;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        for (const [id, state] of states) if (!rootFor(id)) { state.abort?.abort(); window.disposeBIDashboard?.(id); states.delete(id); }
      }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
