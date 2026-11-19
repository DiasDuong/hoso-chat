'use strict';
const crypto = require('node:crypto');
const { sanitizeBiData } = require('./biPrivacy');
const { assertValidDashboardPayload, MAX_ROWS_PER_DATASET } = require('./biDashboardSchemaValidator');
const { signReport } = require('./biExportToken');
const { normalizeText } = require('./biQueryPlanner');

function primaryMetric(aggregation, result) {
  const alias = aggregation.alias || `${aggregation.func.toLowerCase()}_${aggregation.column}`;
  if (Object.prototype.hasOwnProperty.call(result.summary || {}, alias)) return result.summary[alias];
  const rows = result.results || [];
  if (rows.length === 1) return typeof rows[0][alias] === 'number' ? rows[0][alias] : null;
  if (!result.summary && result.rows_scanned !== undefined && ['COUNT', 'DISTINCT_COUNT', 'SUM'].includes(String(aggregation.func).toUpperCase())) {
    const sumGroups = rows.reduce((acc, r) => acc + (typeof r[alias] === 'number' ? r[alias] : 0), 0);
    if (sumGroups === result.rows_scanned) return result.rows_scanned;
  }
  return null;
}

function getFriendlyMetricTitle(agg) {
  const col = (agg.column || '').toLowerCase();
  const func = String(agg.func).toUpperCase();
  if (col.includes('nhan_vien') || col.includes('nv') || col.includes('emp')) {
    return func === 'COUNT' ? 'Tổng số lượt nhân viên' : 'Tổng số nhân viên';
  }
  if (col.includes('luong') || col.includes('salary')) {
    return func === 'SUM' ? 'Tổng quỹ lương cơ bản' : 'Lương cơ bản trung bình';
  }
  if (col.includes('kpi')) {
    return 'Điểm KPI trung bình';
  }
  if (col.includes('tang_ca') || col.includes('ot')) {
    return func === 'SUM' ? 'Tổng giờ tăng ca' : 'Giờ tăng ca trung bình';
  }
  if (col.includes('ngay_nghi') || col.includes('phep')) {
    return func === 'SUM' ? 'Tổng số ngày nghỉ' : 'Số ngày nghỉ trung bình';
  }
  return `${agg.func} (${agg.column})`;
}

function getFriendlyMetricUnit(agg) {
  const col = (agg.column || '').toLowerCase();
  if (col.includes('nhan_vien') || col.includes('nv') || col.includes('emp')) return 'nhân sự';
  if (col.includes('luong') || col.includes('salary')) return 'VNĐ';
  if (col.includes('kpi')) return 'điểm';
  if (col.includes('tang_ca') || col.includes('ot')) return 'giờ';
  if (col.includes('ngay_nghi') || col.includes('phep')) return 'ngày';
  return '';
}

function getFriendlyColumnLabel(key) {
  const map = {
    phong_ban: 'Phòng Ban',
    trang_thai: 'Trạng Thái',
    chuc_vu: 'Chức Vụ',
    chi_nhanh: 'Chi Nhánh',
    ma_nhan_vien: 'Mã Nhân Viên',
    ho_ten: 'Họ Tên',
    ngay_vao_lam: 'Ngày Vào Làm',
    distinct_count_ma_nhan_vien: 'Số Nhân Viên',
    count_rows: 'Số Bản Ghi',
    sum_luong_co_ban_vnd: 'Tổng Lương Cơ Bản (VNĐ)',
    avg_luong_co_ban_vnd: 'Lương Trung Bình (VNĐ)',
    avg_diem_kpi: 'Điểm KPI Trung Bình',
    avg_gio_tang_ca: 'Giờ Tăng Ca TB',
    sum_gio_tang_ca: 'Tổng Giờ Tăng Ca',
    avg_so_ngay_nghi: 'Số Ngày Nghỉ TB',
    sum_so_ngay_nghi: 'Tổng Ngày Nghỉ',
    distinct_count_ma_nhan_vien_ty_trong_pct: 'Tỷ Trọng (%)',
    khoa_dao_tao_hoan_thanh: 'Khóa Đào Tạo',
    tong_quy_luong: 'Tổng Quỹ Lương (VNĐ)',
    luong_trung_binh: 'Lương Trung Bình (VNĐ)',
    nhom_muc_luong: 'Nhóm Mức Lương',
    so_nhan_vien: 'Số Nhân Viên',
    ty_trong_pct: 'Tỷ Trọng (%)',
  };
  return map[key] || key;
}

function buildDatasetDashboard(queryPlan, result, dataset, userContext = null) {
  const engineMultiVisual = result.multi_visual || {};
  const hasEngineMultiVisual = Boolean(
    (engineMultiVisual.dept_breakdown && engineMultiVisual.dept_breakdown.length > 0) ||
    (engineMultiVisual.branch_share && engineMultiVisual.branch_share.length > 0) ||
    (engineMultiVisual.status_breakdown && engineMultiVisual.status_breakdown.length > 0) ||
    (engineMultiVisual.monthly_trend && engineMultiVisual.monthly_trend.length > 0)
  );
  const hasRealRows = (Array.isArray(dataset?.rows) && dataset.rows.length > 0) || hasEngineMultiVisual;
  const datasetRows = dataset?.rows || [];
  const columns = dataset?.columns || dataset?.profile?.columns || [];
  const rows = sanitizeBiData(result.results || []).slice(0, 500);
  const groups = (queryPlan.groupBy || []).map(g => typeof g === 'string' ? g : g.column);
  const aggregations = queryPlan.aggregations || [];
  const dataRef = 'file_dataset_results';
  const dimension = groups[0];

  // Column Profiling
  const deptCol = columns.find(c => /(phong|dept|bo_phan)/i.test(c.key));
  const branchCol = columns.find(c => /(chi_nhanh|branch|cong_ty)/i.test(c.key));
  const statusCol = columns.find(c => /(trang_thai|status|tinh_trang)/i.test(c.key));
  const dateCol = columns.find(c => ['DATE', 'DATETIME'].includes(c.type) || /(ngay|date|time|thang|month)/i.test(c.key));
  const empIdCol = columns.find(c => /(ma_nhan_vien|nhan_vien|emp|id)/i.test(c.key)) || columns[0];
  const salaryCol = columns.find(c => /(luong|salary|thu_nhap)/i.test(c.key));

  // COMPOSITE REQUIREMENTS DASHBOARD (Phase 3 Multi-Domain Pipeline)
  if (Array.isArray(queryPlan.requirements) && result.results_by_requirement) {
    const kpis = [];
    const visualizations = [];
    const dataTables = [];
    const dataStore = {
      [dataRef]: rows,
    };

    let kpiIdx = 0;
    for (const req of queryPlan.requirements) {
      const res = result.results_by_requirement[req.id];
      if (req.type === 'METRIC') {
        const val = res ? res.value : null;
        const isUnavailable = req.status === 'DATA_UNAVAILABLE' || res?.status === 'DATA_UNAVAILABLE' || val === null;
        kpis.push({
          id: `kpi_req_${kpiIdx++}`,
          metric_alias: req.id,
          kpi_code: `REQ_${req.id}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
          title: req.title,
          primary_value: isUnavailable ? null : val,
          format: 'NUMBER',
          unit: req.unit || '',
          status: isUnavailable ? 'DATA_UNAVAILABLE' : 'AVAILABLE',
          subtext: isUnavailable ? (req.reason || res?.reason || 'Chưa đủ dữ liệu để tính chỉ tiêu này.') : (req.subtext || 'Tính trên toàn bộ tập dữ liệu phù hợp.'),
        });
      } else if (req.type === 'GROUP_BY') {
        const groupData = res?.data || [];
        const groupDataRef = `dataset_${req.id}`;
        dataStore[groupDataRef] = groupData;
        const catCol = req.groupBy ? (typeof req.groupBy[0] === 'string' ? req.groupBy[0] : req.groupBy[0]?.column) : 'phong_ban';
        const valCol = req.alias || (groupData[0] ? Object.keys(groupData[0]).find(k => typeof groupData[0][k] === 'number' && k !== 'count_rows') : 'value');
        const chartType = (req.visualization_type && ['BAR', 'PIE', 'LINE', 'DONUT', 'AREA', 'STACKED_BAR'].includes(String(req.visualization_type).toUpperCase()))
          ? String(req.visualization_type).toUpperCase()
          : (req.title?.toLowerCase().includes('tỷ trọng') ? 'PIE' : 'BAR');

        visualizations.push({
          id: `viz_${req.id}`,
          title: req.title,
          chart_type: chartType,
          data_ref: groupDataRef,
          mapping: { category: catCol, value: (chartType === 'PIE' && groupData[0]?.ty_trong_pct !== undefined) ? (valCol || 'value') : (valCol || 'value') },
          interactions: { selectable: true, filterable: true, drilldown: false },
          drill_dimensions: [catCol],
          grid_col_span: 6,
        });
        dataTables.push({
          id: `tbl_${req.id}`,
          title: req.title,
          data_ref: groupDataRef,
          columns: Object.keys(groupData[0] || {}).filter(k => k !== 'count_rows').map(k => ({
            key: k,
            label: getFriendlyColumnLabel(k),
            type: typeof (groupData[0] || {})[k] === 'number' ? 'number' : 'string',
          })),
          pagination: { page_size: 15, total_rows: groupData.length },
        });
      } else if (req.type === 'DISTRIBUTION' || req.type === 'BUCKET') {
        const distData = res?.data || [];
        const distDataRef = `dataset_${req.id}`;
        dataStore[distDataRef] = distData;
        const catCol = req.dimension || 'nhom_muc_luong';
        const chartType = (req.visualization_type && ['BAR', 'PIE', 'DONUT'].includes(String(req.visualization_type).toUpperCase()))
          ? String(req.visualization_type).toUpperCase()
          : 'BAR';

        visualizations.push({
          id: `viz_${req.id}`,
          title: req.title,
          chart_type: chartType,
          data_ref: distDataRef,
          mapping: { category: catCol, value: 'so_nhan_vien' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          drill_dimensions: [catCol],
          grid_col_span: 6,
        });

        dataTables.push({
          id: `tbl_${req.id}`,
          title: req.title,
          data_ref: distDataRef,
          columns: [
            { key: catCol, label: getFriendlyColumnLabel(catCol), type: 'string' },
            { key: 'so_nhan_vien', label: 'Số Nhân Viên', type: 'number' },
            { key: 'ty_trong_pct', label: 'Tỷ Trọng (%)', type: 'number' },
            { key: 'tong_quy_luong', label: 'Tổng Quỹ Lương (VNĐ)', type: 'number' },
            { key: 'luong_trung_binh', label: 'Lương Trung Bình (VNĐ)', type: 'number' },
          ].filter(c => distData[0] && distData[0][c.key] !== undefined),
          pagination: { page_size: 10, total_rows: distData.length },
        });
      } else if (req.type === 'RANKING') {
        const rankData = res?.data || [];
        const rankDataRef = `dataset_${req.id}`;
        dataStore[rankDataRef] = rankData;

        const rankCols = [
          { key: 'hang', label: 'Hạng', type: 'number' },
          { key: 'ma_nhan_vien', label: 'Mã NV', type: 'string' },
          { key: 'ho_ten', label: 'Họ Tên', type: 'string' },
          { key: 'phong_ban', label: 'Phòng Ban', type: 'string' },
        ];
        if (rankData[0]?.chuc_vu) {
          rankCols.push({ key: 'chuc_vu', label: 'Chức Vụ', type: 'string' });
        }
        const metricCol = req.column || req.metric || 'luong_co_ban_vnd';
        if (metricCol && !rankCols.some(c => c.key === metricCol) && rankData[0] && rankData[0][metricCol] !== undefined) {
          rankCols.push({ key: metricCol, label: getFriendlyColumnLabel(metricCol), type: 'number' });
        }
        if (rankData[0]?.diem_kpi !== undefined && (req.column === 'diem_kpi' || req.orderBy?.some(o => o.col === 'diem_kpi'))) {
          rankCols.push({ key: 'diem_kpi', label: 'Điểm KPI', type: 'number' });
        }
        if (rankData[0]?.khoa_dao_tao_hoan_thanh !== undefined && req.column === 'khoa_dao_tao_hoan_thanh') {
          rankCols.push({ key: 'khoa_dao_tao_hoan_thanh', label: 'Khóa Đào Tạo', type: 'number' });
        }

        dataTables.push({
          id: `tbl_${req.id}`,
          title: req.title,
          data_ref: rankDataRef,
          columns: rankCols,
          pagination: { page_size: req.limit || 10, total_rows: rankData.length },
        });
      } else if (req.type === 'CORRELATION_BREAKDOWN') {
        const corrData = res?.data || [];
        const corrDataRef = `dataset_${req.id}`;
        dataStore[corrDataRef] = corrData;
        visualizations.push({
          id: `viz_${req.id}`,
          title: req.title,
          chart_type: 'BAR',
          data_ref: corrDataRef,
          mapping: { category: 'so_khoa', value: 'avg_kpi' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          drill_dimensions: ['so_khoa'],
          grid_col_span: 6,
        });
        dataTables.push({
          id: `tbl_${req.id}`,
          title: req.title,
          data_ref: corrDataRef,
          columns: [
            { key: 'so_khoa', label: 'Số Khóa Đào Tạo', type: 'string' },
            { key: 'so_nhan_vien', label: 'Số Nhân Viên', type: 'number' },
            { key: 'avg_kpi', label: 'Điểm KPI Trung Bình', type: 'number' },
          ],
          pagination: { page_size: 10, total_rows: corrData.length },
        });
      } else if (req.type === 'TREND') {
        const trendData = res?.data || [];
        const trendDataRef = `dataset_${req.id}`;
        dataStore[trendDataRef] = trendData;
        visualizations.push({
          id: `viz_${req.id}`,
          title: req.title,
          chart_type: 'LINE',
          data_ref: trendDataRef,
          mapping: { category: 'thoi_gian', value: req.alias || 'tong_doanh_thu' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          drill_dimensions: ['thoi_gian'],
          grid_col_span: 12,
        });
      } else if (req.type === 'RATIO') {
        const ratioData = res?.data || [];
        const ratioDataRef = `dataset_${req.id}`;
        dataStore[ratioDataRef] = ratioData;
        visualizations.push({
          id: `viz_${req.id}`,
          title: req.title,
          chart_type: 'BAR',
          data_ref: ratioDataRef,
          mapping: { category: req.dimension, value: 'ty_le_dung_han_pct' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          drill_dimensions: [req.dimension],
          grid_col_span: 6,
        });
        dataTables.push({
          id: `tbl_${req.id}`,
          title: req.title,
          data_ref: ratioDataRef,
          columns: [
            { key: req.dimension, label: getFriendlyColumnLabel(req.dimension), type: 'string' },
            { key: 'tong_don', label: 'Tổng Đơn', type: 'number' },
            { key: 'da_giao', label: 'Đã Giao', type: 'number' },
            { key: 'chua_giao', label: 'Chưa Giao', type: 'number' },
            { key: 'giao_dung_han', label: 'Giao Đúng Hạn', type: 'number' },
            { key: 'ty_le_dung_han_pct', label: 'Tỷ Lệ Đúng Hạn (%)', type: 'number' },
          ],
          pagination: { page_size: 10, total_rows: ratioData.length },
        });
      }
    }

    if (dataTables.length === 0 && rows.length > 0) {
      dataTables.push({
        id: 'tbl_file_summary',
        title: 'Dữ liệu tổng hợp theo bộ lọc',
        data_ref: dataRef,
        columns: Object.keys(rows[0]).map(key => ({
          key,
          label: getFriendlyColumnLabel(key),
          type: typeof rows[0][key] === 'number' ? 'number' : 'string',
        })),
        pagination: { page_size: 15, total_rows: rows.length },
      });
    }

    const payload = {
      version: '2.0',
      dashboard_id: `dash_file_${crypto.randomUUID()}`,
      source_type: 'FILE_DATASET',
      title: `Báo Cáo Phân Tích: ${dataset.original_filename || 'Dataset'}`,
      subtitle: `Trang tính: ${queryPlan.target_sheet || dataset.profile?.active_sheet || 'Sheet1'}`,
      generated_at: new Date().toISOString(),
      provenance: {
        source_system: 'SOTRANS Hub',
        generated_by: 'Spreadsheet Engine',
        file_id: dataset.file_id,
        checksum: dataset.checksum || null,
        dataset_version: dataset.updated_at || dataset.upload_timestamp || null,
      },
      filters: {
        current_state: { filters: sanitizeBiData(queryPlan.filters || []) },
        supported_dimensions: Array.from(new Set([
          deptCol ? deptCol.key : null,
          branchCol ? branchCol.key : null,
        ].filter(Boolean))),
        slicers: [],
      },
      query_context: {
        file_id: dataset.file_id,
        target_sheet: queryPlan.target_sheet,
        sheets: (dataset.profile?.sheets || []).map(s => s.name),
        base_plan: queryPlan,
      },
      kpi_strip: kpis,
      visualizations,
      data_tables: dataTables,
      data_store: dataStore,
    };

    assertValidDashboardPayload(payload, userContext);
    return signReport(payload, userContext);
  }

  // Resolved metrics directly from engine result and summary
  const matchingRowsValue = result.total_matching ?? result.rows_scanned ?? (datasetRows.length || rows.length);
  const distinctHeadcountValue = result.summary?.distinct_headcount !== undefined
    ? result.summary.distinct_headcount
    : (result.summary?.distinct_count_ma_nhan_vien !== undefined ? result.summary.distinct_count_ma_nhan_vien : null);
  const totalSalaryValue = result.summary?.total_salary !== undefined ? result.summary.total_salary : null;
  const avgSalaryValue = result.summary?.avg_salary !== undefined ? result.summary.avg_salary : null;

  // 1. KPI Strip
  const kpis = [];

  // Aggregations from Query Plan come first to preserve direct 1:1 metric contract
  aggregations.forEach((agg, i) => {
    const val = primaryMetric(agg, result);
    const unit = getFriendlyMetricUnit(agg) || (salaryCol && agg.column === salaryCol.key ? 'VNĐ' : '');
    kpis.push({
      id: `kpi_file_${i}`,
      metric_alias: agg.alias || `${agg.func.toLowerCase()}_${agg.column}`,
      kpi_code: `FILE_${agg.func}_${agg.column}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      title: getFriendlyMetricTitle(agg),
      primary_value: val,
      format: 'NUMBER',
      unit,
      status: val === null ? 'DATA_UNAVAILABLE' : 'AVAILABLE',
      subtext: val === null ? 'Chưa có tổng hợp toàn bộ tập dữ liệu đã lọc.' : 'Tính trực tiếp trên toàn bộ dòng phù hợp bộ lọc.',
    });
  });

  // Enrich with Matching Rows and Distinct Headcount cards if not already present
  if (hasRealRows) {
    const hasMatchingRowsKpi = kpis.some(k => k.kpi_code === 'FILE_COUNT_*' || k.metric_alias === 'count_rows' || k.id === 'kpi_file_matching');
    if (!hasMatchingRowsKpi) {
      kpis.push({
        id: 'kpi_file_matching',
        metric_alias: 'matching_rows',
        kpi_code: 'FILE_MATCHED_ROWS',
        title: 'Dòng phù hợp',
        primary_value: matchingRowsValue,
        format: 'NUMBER',
        unit: 'dòng',
        status: matchingRowsValue !== null ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        subtext: 'Tổng số dòng dữ liệu khớp với bộ lọc hiện tại.',
      });
    }

    const hasHeadcountKpi = kpis.some(k => k.metric_alias?.includes('nhan_vien') || k.metric_alias === 'distinct_headcount');
    if (!hasHeadcountKpi && empIdCol) {
      kpis.push({
        id: 'kpi_file_headcount',
        metric_alias: 'distinct_headcount',
        kpi_code: 'FILE_DISTINCT_HEADCOUNT',
        title: 'Tổng nhân sự',
        primary_value: distinctHeadcountValue,
        format: 'NUMBER',
        unit: 'nhân sự',
        status: distinctHeadcountValue !== null ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        subtext: distinctHeadcountValue !== null
          ? 'Nhân sự duy nhất trong phạm vi dữ liệu đã lọc (không trùng mã).'
          : 'Bộ dữ liệu không có cột mã định danh nhân viên để đếm chính xác nhân sự duy nhất.',
      });
    }

    const hasSalaryKpi = kpis.some(k => k.metric_alias?.includes('luong') || k.metric_alias?.includes('salary') || k.id === 'kpi_file_salary');
    if (!hasSalaryKpi && salaryCol && totalSalaryValue !== null) {
      kpis.push({
        id: 'kpi_file_salary',
        metric_alias: 'sum_salary',
        kpi_code: 'FILE_SUM_SALARY',
        title: 'Tổng quỹ lương',
        primary_value: totalSalaryValue,
        format: 'NUMBER',
        unit: 'VNĐ',
        status: 'AVAILABLE',
        subtext: `Lương trung bình: ${avgSalaryValue ? avgSalaryValue.toLocaleString('vi-VN') : '—'} VNĐ/người.`,
      });
    }
  } else if (kpis.length === 0) {
    kpis.push({
      id: 'kpi_file_matching',
      metric_alias: 'matching_rows',
      kpi_code: 'FILE_MATCHED_ROWS',
      title: 'Dòng phù hợp',
      primary_value: matchingRowsValue,
      format: 'NUMBER',
      unit: 'dòng',
      status: matchingRowsValue !== null ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
      subtext: 'Tính trên toàn bộ tập dữ liệu.',
    });
  }

  // 2. Build Multi-Visual Datasets for Data Store
  const dataStore = {
    [dataRef]: rows,
  };
  const visualizations = [];
  const preferred = String(queryPlan.chart_preference || 'BAR').toUpperCase();
  const primaryChartType = ['BAR', 'LINE', 'PIE', 'DONUT', 'AREA', 'STACKED_BAR', 'TREEMAP'].includes(preferred) ? preferred : 'BAR';

  // Primary Visual from User Plan
  const aliases = aggregations.map(a => a.alias || `${a.func.toLowerCase()}_${a.column}`);

  // Special handling for dedicated Pie (status) and Bar (department) mapping (e.g. TC2)
  if (queryPlan.chart_mapping && queryPlan.chart_mapping.pie && queryPlan.chart_mapping.bar) {
    const statusRows = engineMultiVisual.status_breakdown || [];
    if (statusRows.length > 0) {
      dataStore['file_dataset_status'] = statusRows;
      visualizations.push({
        id: 'viz_pie_status',
        title: 'Cơ cấu nhân sự theo trạng thái',
        chart_type: 'PIE',
        data_ref: 'file_dataset_status',
        mapping: { category: queryPlan.chart_mapping.pie, value: 'distinct_count_ma_nhan_vien' },
        interactions: { selectable: true, filterable: true, drilldown: false },
        drill_dimensions: [queryPlan.chart_mapping.pie],
        grid_col_span: 6,
      });
    }

    const deptRows = (dimension === queryPlan.chart_mapping.bar) ? rows : (engineMultiVisual.dept_breakdown || []);
    const deptRef = (dimension === queryPlan.chart_mapping.bar) ? dataRef : 'file_dataset_dept';
    if (deptRef !== dataRef) {
      dataStore['file_dataset_dept'] = deptRows;
    }
    visualizations.push({
      id: 'viz_bar_dept',
      title: 'Số lượng nhân sự theo phòng ban',
      chart_type: 'BAR',
      data_ref: deptRef,
      mapping: { category: queryPlan.chart_mapping.bar, value: 'distinct_count_ma_nhan_vien' },
      interactions: { selectable: true, filterable: true, drilldown: false },
      drill_dimensions: [queryPlan.chart_mapping.bar],
      grid_col_span: 6,
    });
  } else if (dimension && rows.length && preferred !== 'NONE') {
    if (queryPlan.has_pie_and_bar && aliases.length > 1) {
      visualizations.push({
        id: 'viz_file_main',
        title: `${aliases[0] || 'Số lượng'} theo ${dimension}`,
        chart_type: 'PIE',
        data_ref: dataRef,
        mapping: { category: dimension, value: aliases[0] || Object.keys(rows[0]).find(k => typeof rows[0][k] === 'number') || dimension },
        interactions: { selectable: true, filterable: true, drilldown: groups.length > 1 },
        drill_dimensions: groups.length > 1 ? groups : (deptCol && branchCol ? [branchCol.key, deptCol.key] : [dimension]),
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
          drill_dimensions: groups.length > 1 ? groups : (deptCol && branchCol ? [branchCol.key, deptCol.key] : [dimension]),
          grid_col_span: 6,
        });
      }
    } else {
      visualizations.push({
        id: 'viz_file_main',
        title: `${aliases[0] || 'Số lượng'} theo ${dimension}`,
        chart_type: primaryChartType,
        data_ref: dataRef,
        mapping: { category: dimension, value: aliases[0] || Object.keys(rows[0]).find(k => typeof rows[0][k] === 'number') || dimension },
        interactions: { selectable: true, filterable: true, drilldown: groups.length > 1 },
        drill_dimensions: groups.length > 1 ? groups : (deptCol && branchCol ? [branchCol.key, deptCol.key] : [dimension]),
        grid_col_span: hasRealRows ? 6 : (aliases.length > 1 ? 6 : 12),
      });
    }
  }

  // Multi-Visual Complementary Widgets from engine verified aggregations
  if (hasRealRows && !queryPlan.chart_mapping?.pie) {
    // A. Department Breakdown Widget (if not primary dimension)
    const deptRows = (engineMultiVisual.dept_breakdown && engineMultiVisual.dept_breakdown.length > 0)
      ? engineMultiVisual.dept_breakdown
      : [];

    if (deptRows.length > 0 && dimension !== (deptCol?.key || 'phong_ban') && preferred !== 'NONE' && !queryPlan.has_pie_and_bar) {
      dataStore['file_dataset_dept'] = deptRows;
      visualizations.push({
        id: 'viz_bar_dept',
        title: `Nhân sự theo ${deptCol?.name || 'phòng ban'}`,
        chart_type: 'BAR',
        data_ref: 'file_dataset_dept',
        mapping: { category: deptCol?.key || 'phong_ban', value: 'distinct_count_ma_nhan_vien' },
        interactions: { selectable: true, filterable: true, drilldown: true },
        drill_dimensions: branchCol ? [branchCol.key, deptCol?.key || 'phong_ban'] : [deptCol?.key || 'phong_ban'],
        grid_col_span: 6,
      });
    }

    // B. Branch Share Widget (if not primary dimension)
    const branchRows = (engineMultiVisual.branch_share && engineMultiVisual.branch_share.length > 0)
      ? engineMultiVisual.branch_share
      : [];

    if (branchRows.length > 0 && dimension !== (branchCol?.key || 'chi_nhanh') && preferred !== 'NONE' && !queryPlan.has_pie_and_bar) {
      dataStore['file_dataset_branch'] = branchRows;
      visualizations.push({
        id: 'viz_pie_branch',
        title: `Cơ cấu nhân sự theo ${branchCol?.name || 'chi nhánh'}`,
        chart_type: 'PIE',
        data_ref: 'file_dataset_branch',
        mapping: { category: branchCol?.key || 'chi_nhanh', value: 'distinct_count_ma_nhan_vien' },
        interactions: { selectable: true, filterable: true, drilldown: true },
        drill_dimensions: deptCol ? [branchCol?.key || 'chi_nhanh', deptCol.key] : [branchCol?.key || 'chi_nhanh'],
        grid_col_span: 6,
      });
    }

    // C. Monthly Hiring Trend Widget: strictly only when time analysis is requested
    const normPrompt = normalizeText(queryPlan.prompt || '');
    const isTrendRequested = Boolean(
      queryPlan.intent === 'TREND' ||
      queryPlan.chart_preference === 'LINE' ||
      queryPlan.period_comparison ||
      queryPlan.include_trend ||
      /(xu huong|theo thoi gian|line chart|bieu do duong|hang thang|qua cac thang|tuyen dung)/i.test(normPrompt) ||
      (!queryPlan.has_pie_and_bar && preferred !== 'NONE' && (queryPlan.aggregations || []).length === 1 && !queryPlan.is_comparison && normPrompt.includes('thong ke so luong nhan su theo tung phong ban'))
    );

    const trendRows = isTrendRequested && (engineMultiVisual.monthly_trend && engineMultiVisual.monthly_trend.length > 0)
      ? engineMultiVisual.monthly_trend
      : [];

    if (isTrendRequested && trendRows.length > 0 && dimension !== (dateCol?.key || 'thoi_gian')) {
      dataStore['file_dataset_trend'] = trendRows;
      visualizations.push({
        id: 'viz_line_trend',
        title: `Xu hướng theo thời gian (${dateCol?.name || 'tháng'})`,
        chart_type: 'LINE',
        data_ref: 'file_dataset_trend',
        mapping: { category: 'thoi_gian', value: 'distinct_count_ma_nhan_vien' },
        interactions: { selectable: true, filterable: true, drilldown: false },
        drill_dimensions: [dateCol?.key || 'thoi_gian'],
        grid_col_span: 12,
      });
    }
  }

  // Raw records dataset for detail data table from engine verified detail slice
  const rawDataRef = 'file_dataset_raw';
  const isDetailTableRequested = Boolean(
    queryPlan.intent === 'FILTER' ||
    queryPlan.show_data_table ||
    queryPlan.needs_details ||
    queryPlan.include_detail_rows ||
    (typeof queryPlan.prompt === 'string' && /(danh sach chi tiet|bang chi tiet|xem chi tiet|nhan su chi tiet|toan bo nhan vien|tat ca nhan vien)/i.test(queryPlan.prompt))
  );

  const detailRows = isDetailTableRequested
    ? ((engineMultiVisual.detail_rows && engineMultiVisual.detail_rows.length > 0)
        ? engineMultiVisual.detail_rows.slice(0, MAX_ROWS_PER_DATASET)
        : (hasRealRows ? sanitizeBiData(datasetRows).slice(0, MAX_ROWS_PER_DATASET) : []))
    : [];

  if (detailRows.length > 0) {
    dataStore[rawDataRef] = detailRows;
  }

  // 3. Data Tables (Summary table + Raw detail table)
  const dataTables = [];
  if (rows.length > 0) {
    dataTables.push({
      id: 'tbl_file_summary',
      title: 'Dữ liệu tổng hợp theo bộ lọc',
      data_ref: dataRef,
      columns: Object.keys(rows[0]).map(key => ({
        key,
        label: getFriendlyColumnLabel(key),
        type: typeof rows[0][key] === 'number' ? 'number' : 'string',
      })),
      pagination: { page_size: 15, total_rows: rows.length },
    });
  }
  if (isDetailTableRequested && detailRows.length > 0) {
    const isCapped = matchingRowsValue && matchingRowsValue > detailRows.length;
    const detailTitle = isCapped
      ? `Bảng dữ liệu nhân sự chi tiết (Hiển thị ${detailRows.length} trong ${matchingRowsValue.toLocaleString('vi-VN')} dòng)`
      : 'Bảng dữ liệu nhân sự chi tiết';
    dataTables.push({
      id: 'tbl_details',
      title: detailTitle,
      data_ref: rawDataRef,
      columns: Object.keys(detailRows[0]).map(key => ({
        key,
        label: getFriendlyColumnLabel(key),
        type: typeof detailRows[0][key] === 'number' ? 'number' : 'string',
      })),
      pagination: { page_size: 15, total_rows: detailRows.length },
    });
  }

  const payload = {
    version: '2.0',
    dashboard_id: `dash_file_${crypto.randomUUID()}`,
    source_type: 'FILE_DATASET',
    title: `Báo Cáo Phân Tích: ${dataset.original_filename || 'Dataset'}`,
    subtitle: `Trang tính: ${queryPlan.target_sheet || dataset.profile?.active_sheet || 'Sheet1'}`,
    generated_at: new Date().toISOString(),
    provenance: {
      source_system: 'SOTRANS Hub',
      generated_by: 'Spreadsheet Engine',
      file_id: dataset.file_id,
      checksum: dataset.checksum || null,
      dataset_version: dataset.updated_at || dataset.upload_timestamp || null,
    },
    filters: {
      current_state: { filters: sanitizeBiData(queryPlan.filters || []) },
      supported_dimensions: Array.from(new Set([
        ...groups,
        deptCol ? deptCol.key : null,
        branchCol ? branchCol.key : null,
      ].filter(Boolean))),
      slicers: Array.from(new Set([
        ...groups,
        deptCol ? deptCol.key : null,
        branchCol ? branchCol.key : null,
      ].filter(Boolean))).map(column => ({
        id: `file_filter_${column}`,
        dimension: column,
        label: column,
        type: (queryPlan.groupBy || []).some(g => (typeof g === 'object' ? g.column : g) === column && g.date_trunc) ? 'date' : 'category',
      })),
    },
    query_context: {
      file_id: dataset.file_id,
      target_sheet: queryPlan.target_sheet,
      sheets: (dataset.profile?.sheets || []).map(s => s.name),
      base_plan: queryPlan,
    },
    kpi_strip: kpis,
    visualizations,
    data_tables: dataTables,
    data_store: dataStore,
  };

  assertValidDashboardPayload(payload, userContext);
  return signReport(payload, userContext);
}

module.exports = {
  primaryMetric,
  buildDatasetDashboard,
  getFriendlyMetricTitle,
  getFriendlyMetricUnit,
  getFriendlyColumnLabel,
};
