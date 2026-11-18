'use strict';
const crypto = require('node:crypto');
const { sanitizeBiData } = require('./biPrivacy');
const { assertValidDashboardPayload } = require('./biDashboardSchemaValidator');
const { signReport } = require('./biExportToken');

function primaryMetric(aggregation, result) {
  const alias = aggregation.alias || `${aggregation.func.toLowerCase()}_${aggregation.column}`;
  if (Object.prototype.hasOwnProperty.call(result.summary || {}, alias)) return result.summary[alias];
  const rows = result.results || [];
  if (rows.length === 1) return typeof rows[0][alias] === 'number' ? rows[0][alias] : null;
  // Legacy callers without a full-filter summary must not invent a global AVG,
  // MEDIAN, extrema or distinct count from group-level numbers.
  return null;
}

function buildDatasetDashboard(queryPlan, result, dataset, userContext = null) {
  const rows = sanitizeBiData(result.results || []).slice(0, 500);
  const groups = (queryPlan.groupBy || []).map(g => typeof g === 'string' ? g : g.column);
  const aggregations = queryPlan.aggregations || [];
  const dataRef = 'file_dataset_results';
  const dimension = groups[0];
  const kpis = aggregations.map((agg, i) => {
    const value = primaryMetric(agg, result);
    return {
      id: `kpi_file_${i}`, metric_alias: agg.alias || `${agg.func.toLowerCase()}_${agg.column}`, kpi_code: `FILE_${agg.func}_${agg.column}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      title: `${agg.func} (${agg.column})`, primary_value: value, format: 'NUMBER', unit: '',
      status: value === null ? 'DATA_UNAVAILABLE' : 'AVAILABLE',
      subtext: value === null ? 'Chưa có tổng hợp toàn bộ tập dữ liệu đã lọc; không cộng số liệu của các nhóm.' : 'Tính trực tiếp trên toàn bộ dòng phù hợp bộ lọc, trước giới hạn hiển thị.',
    };
  });
  kpis.push({ id: 'kpi_file_matching', kpi_code: 'FILE_MATCHED_ROWS', title: 'Dòng phù hợp', primary_value: result.total_matching ?? result.rows_scanned ?? rows.length, format: 'NUMBER', status: 'AVAILABLE' });
  const visualizations = [];
  const aliases = aggregations.map(a => a.alias || `${a.func.toLowerCase()}_${a.column}`);
  const preferred = String(queryPlan.chart_preference || 'BAR').toUpperCase();
  const chartType = ['BAR', 'LINE', 'PIE', 'DONUT', 'AREA', 'STACKED_BAR', 'TREEMAP'].includes(preferred) ? preferred : 'BAR';
  if (dimension && rows.length && preferred !== 'NONE') {
    if (queryPlan.has_pie_and_bar && aliases.length > 1) {
      visualizations.push({
        id: 'viz_file_main',
        title: `${aliases[0]} theo ${dimension}`,
        chart_type: 'PIE',
        data_ref: dataRef,
        mapping: { category: dimension, value: aliases[0] },
        interactions: { selectable: true, filterable: true, drilldown: groups.length > 1 },
        drill_dimensions: groups,
        grid_col_span: 6,
      });
      for (let i = 1; i < Math.min(aliases.length, 3); i++) {
        visualizations.push({
          id: `viz_file_${i}`,
          title: `${aliases[i]} theo ${dimension}`,
          chart_type: 'BAR',
          data_ref: dataRef,
          mapping: { category: dimension, value: aliases[i] },
          interactions: { selectable: true, filterable: true, drilldown: groups.length > 1 },
          drill_dimensions: groups,
          grid_col_span: 6,
        });
      }
    } else {
      const chartMetrics = chartType === 'STACKED_BAR' ? [aliases] : aliases.slice(0, 8);
      chartMetrics.forEach((metric, index) => visualizations.push({
        id: index === 0 ? 'viz_file_main' : `viz_file_${index}`, title: `${Array.isArray(metric) ? metric.join(', ') : metric} theo ${dimension}`,
        chart_type: chartType, data_ref: dataRef, mapping: { category: dimension, value: metric },
        interactions: { selectable: true, filterable: true, drilldown: groups.length > 1 },
        drill_dimensions: groups, grid_col_span: aliases.length > 1 ? 6 : 12,
      }));
    }
  }
  const payload = {
    version: '2.0', dashboard_id: `dash_file_${crypto.randomUUID()}`, source_type: 'FILE_DATASET',
    title: `Báo Cáo Phân Tích: ${dataset.original_filename || 'Dataset'}`, subtitle: `Trang tính: ${queryPlan.target_sheet || dataset.profile?.active_sheet || 'Sheet1'}`,
    generated_at: new Date().toISOString(),
    provenance: { source_system: 'SOTRANS Hub', generated_by: 'Spreadsheet Engine', file_id: dataset.file_id, checksum: dataset.checksum || null, dataset_version: dataset.updated_at || dataset.upload_timestamp || null },
    filters: {
      current_state: { filters: sanitizeBiData(queryPlan.filters || []) },
      supported_dimensions: groups,
      slicers: groups.map(column => ({ id: `file_filter_${column}`, dimension: column, label: column, type: (queryPlan.groupBy || []).some(g => g.column === column && g.date_trunc) ? 'date' : 'category' })),
    },
    query_context: { file_id: dataset.file_id, target_sheet: queryPlan.target_sheet, sheets: (dataset.profile?.sheets || []).map(s => s.name), base_plan: queryPlan },
    kpi_strip: kpis, visualizations,
    data_tables: rows.length ? [{ id: 'tbl_file_summary', title: 'Dữ liệu theo bộ lọc', data_ref: dataRef, columns: Object.keys(rows[0]).map(key => ({ key, label: key, type: typeof rows[0][key] === 'number' ? 'number' : 'string' })), pagination: { page_size: 15, total_rows: rows.length } }] : [],
    data_store: { [dataRef]: rows },
  };
  assertValidDashboardPayload(payload, userContext);
  return signReport(payload, userContext);
}

module.exports = { primaryMetric, buildDatasetDashboard };
