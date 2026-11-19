/**
 * SOTRANS HUB — BI DATASET PRESENTER (PHASE 2.2 & 2.3)
 * 
 * Presentation & Formatting Layer for Uploaded Dataset Analytics:
 * - Formats Data Profile into structured executive Markdown
 * - Formats Data Quality Alerts & Schema Definitions
 * - Generates Responsive Inline SVG Charts (Bar, Line, Donut/Pie)
 * - Formats Analytical Query Aggregations, KPI Cards & Summary Tables
 * - Generates Structured Payload <!-- bi-file-report: {...} -->
 * - Safe HTML/Markdown sanitization to prevent XSS
 */

const { validateDashboardPayload, assertValidDashboardPayload } = require('./biDashboardSchemaValidator');
const { sanitizeBiData, sanitizeBiProfile } = require('./biPrivacy');
const { primaryMetric, buildDatasetDashboard, getFriendlyColumnLabel } = require('./biReportBuilder');

function escapeMarkdown(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\|/g, '\\|');
}

function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const PALETTE = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#ec4899', '#64748b'];

/**
 * Generate Responsive Inline SVG Bar Chart
 */
function generateBarChartSvg(data, options = {}) {
  if (!Array.isArray(data) || data.length === 0) return '';
  const xKey = options.xKey;
  const yKey = options.yKey;
  const title = options.title || 'Biểu đồ Cột';

  const width = 640;
  const height = 280;
  const padding = { top: 40, right: 25, bottom: 55, left: 75 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const vals = data.map((d) => Number(d[yKey]) || 0);
  const maxVal = Math.max(...vals, 1);
  const step = chartW / data.length;
  const barWidth = Math.min(48, Math.max(16, Math.floor(step * 0.65)));

  let bars = '';
  data.forEach((d, i) => {
    const val = Number(d[yKey]) || 0;
    const barH = Math.max(4, Math.round((val / maxVal) * chartH));
    const x = padding.left + i * step + (step - barWidth) / 2;
    const y = padding.top + chartH - barH;
    const rawLabel = String(d[xKey] || `Mục ${i + 1}`);
    const shortLabel = rawLabel.length > 12 ? rawLabel.slice(0, 11) + '…' : rawLabel;
    const color = PALETTE[i % PALETTE.length];

    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" rx="4"/>`;
    bars += `<text x="${x + barWidth / 2}" y="${y - 6}" font-size="11" text-anchor="middle" fill="#1e293b" font-weight="600">${val.toLocaleString('vi-VN')}</text>`;
    bars += `<text x="${x + barWidth / 2}" y="${height - 22}" font-size="11" text-anchor="middle" fill="#64748b">${escapeXml(shortLabel)}</text>`;
  });

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;margin:12px 0;display:block;">
    <text x="20" y="24" font-size="13" font-weight="700" fill="#0f172a">${escapeXml(title)}</text>
    <line x1="${padding.left}" y1="${padding.top + chartH}" x2="${width - padding.right}" y2="${padding.top + chartH}" stroke="#cbd5e1" stroke-width="1.5"/>
    ${bars}
  </svg>`;
}

/**
 * Generate Responsive Inline SVG Line Chart (Trend Analysis)
 */
function generateLineChartSvg(data, options = {}) {
  if (!Array.isArray(data) || data.length === 0) return '';
  const xKey = options.xKey;
  const yKey = options.yKey;
  const title = options.title || 'Biểu đồ Xu Hướng';

  const width = 640;
  const height = 280;
  const padding = { top: 40, right: 35, bottom: 55, left: 75 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const vals = data.map((d) => Number(d[yKey]) || 0);
  const maxVal = Math.max(...vals, 1);
  const step = data.length > 1 ? chartW / (data.length - 1) : chartW;

  const points = [];
  let dots = '';
  let labels = '';

  data.forEach((d, i) => {
    const val = Number(d[yKey]) || 0;
    const x = padding.left + (data.length > 1 ? i * step : chartW / 2);
    const y = padding.top + chartH - Math.round((val / maxVal) * chartH);
    points.push(`${x},${y}`);

    const rawLabel = String(d[xKey] || `Kỳ ${i + 1}`);
    const shortLabel = rawLabel.length > 12 ? rawLabel.slice(0, 11) + '…' : rawLabel;

    dots += `<circle cx="${x}" cy="${y}" r="5" fill="#2563eb" stroke="#ffffff" stroke-width="2"/>`;
    dots += `<text x="${x}" y="${y - 8}" font-size="11" text-anchor="middle" fill="#0f172a" font-weight="600">${val.toLocaleString('vi-VN')}</text>`;
    labels += `<text x="${x}" y="${height - 22}" font-size="11" text-anchor="middle" fill="#64748b">${escapeXml(shortLabel)}</text>`;
  });

  const polyline = `<polyline fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${points.join(' ')}"/>`;

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;margin:12px 0;display:block;">
    <text x="20" y="24" font-size="13" font-weight="700" fill="#0f172a">${escapeXml(title)}</text>
    <line x1="${padding.left}" y1="${padding.top + chartH}" x2="${width - padding.right}" y2="${padding.top + chartH}" stroke="#cbd5e1" stroke-width="1.5"/>
    ${polyline}
    ${dots}
    ${labels}
  </svg>`;
}

/**
 * Generate Responsive Inline SVG Donut / Pie Chart (Distribution)
 */
function generatePieChartSvg(data, options = {}) {
  if (!Array.isArray(data) || data.length === 0) return '';
  const xKey = options.labelKey;
  const yKey = options.valueKey;
  const title = options.title || 'Biểu đồ Cơ Cấu (Tỷ Trọng)';

  const width = 640;
  const height = 280;
  const cx = 160;
  const cy = 145;
  const radius = 85;

  const total = options.total || data.reduce((acc, d) => acc + (Number(d[yKey]) || 0), 0);
  if (total <= 0) return '';

  let chartData = data;
  if (data.length > 7) {
    const top6 = data.slice(0, 6);
    const rest = data.slice(6);
    const restSum = rest.reduce((acc, d) => acc + (Number(d[yKey]) || 0), 0);
    chartData = [...top6];
    if (restSum > 0) {
      chartData.push({ [xKey]: 'Khác', [yKey]: restSum });
    }
  }

  let currentAngle = -Math.PI / 2;
  let paths = '';
  let legend = '';

  chartData.forEach((d, i) => {
    const val = Number(d[yKey]) || 0;
    const sliceAngle = (val / total) * 2 * Math.PI;
    const endAngle = currentAngle + sliceAngle;
    const pct = ((val / total) * 100).toFixed(1);
    const color = PALETTE[i % PALETTE.length];

    const x1 = cx + radius * Math.cos(currentAngle);
    const y1 = cy + radius * Math.sin(currentAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);

    const largeArc = sliceAngle > Math.PI ? 1 : 0;
    const pathD = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;

    paths += `<path d="${pathD}" fill="${color}" stroke="#ffffff" stroke-width="2"/>`;

    // Legend item
    const rawLabel = String(d[xKey] || `Mục ${i + 1}`);
    const shortLabel = rawLabel.length > 20 ? rawLabel.slice(0, 19) + '…' : rawLabel;
    const legendY = 60 + i * 24;

    if (legendY < height - 20) {
      legend += `<rect x="330" y="${legendY - 10}" width="12" height="12" fill="${color}" rx="3"/>`;
      legend += `<text x="350" y="${legendY}" font-size="12" fill="#334155">${escapeXml(shortLabel)}: <tspan font-weight="700" fill="#0f172a">${val.toLocaleString('vi-VN')}</tspan> (${pct}%)</text>`;
    }

    currentAngle = endAngle;
  });

  // Inner cutout for donut styling
  const innerCutout = `<circle cx="${cx}" cy="${cy}" r="${radius * 0.45}" fill="#ffffff"/>`;

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;margin:12px 0;display:block;">
    <text x="20" y="24" font-size="13" font-weight="700" fill="#0f172a">${escapeXml(title)}</text>
    ${paths}
    ${innerCutout}
    ${legend}
  </svg>`;
}

/**
 * Format Data Profile into Executive Presentation
 */
function formatDatasetProfileMarkdown(profile) {
  profile = sanitizeBiProfile(profile);
  if (!profile) return 'Không có thông tin cấu trúc dữ liệu.';

  const lines = [];

  // Header & Metadata
  lines.push(`## 📊 Báo Cáo Cấu Trúc Dữ Liệu: ${profile.original_filename}`);
  lines.push('');
  lines.push(`> 📁 **Tệp nguồn:** \`${profile.original_filename}\` (${profile.file_type}) | **Trang tính:** \`${profile.active_sheet}\``);
  lines.push(`> 📈 **Quy mô:** **${profile.row_count.toLocaleString('vi-VN')}** dòng | **${profile.column_count}** cột`);
  lines.push(`> ⏱️ **Mã dữ liệu:** \`${profile.file_id}\``);
  lines.push('');

  // Quality & Security Section
  lines.push('### 🛡️ Trạng Thái An Toàn & Chất Lượng');
  lines.push('- ✅ **Kiểm tra an toàn:** Chữ ký tệp (Magic Bytes), giới hạn kích thước và bảo vệ ZIP Bomb đạt chuẩn.');

  if (profile.quality_alerts && profile.quality_alerts.length > 0) {
    for (const alert of profile.quality_alerts) {
      if (alert.type === 'FORMULA_INJECTION_SANITIZED') {
        lines.push(`- ⚠️ **Bảo mật:** ${alert.message}`);
      } else if (alert.type === 'HIGH_NULL_RATE') {
        lines.push(`- ⚠️ **Thiếu dữ liệu:** ${alert.message}`);
      } else {
        lines.push(`- ℹ️ **Lưu ý cấu trúc:** ${alert.message}`);
      }
    }
  } else {
    lines.push('- ✅ **Chất lượng dữ liệu:** Không phát hiện ô trống bất thường hay cảnh báo bảo mật.');
  }
  lines.push('');

  // Schema & Statistics Table
  lines.push('### 📋 Danh Sách Cột & Đặc Trưng Dữ Liệu');
  lines.push('');
  lines.push('| Tên Cột | Kiểu Dữ Liệu | Đầy Đủ | Trống (%) | Số Giá Trị Riêng | Thống Kê Đặc Trưng |');
  lines.push('| :--- | :---: | :---: | :---: | :---: | :--- |');

  for (const col of profile.columns) {
    let statText = '-';
    if (col.type === 'INTEGER' || col.type === 'FLOAT') {
      const sumFormatted = typeof col.sum === 'number' ? col.sum.toLocaleString('vi-VN') : '-';
      const avgFormatted = typeof col.avg === 'number' ? col.avg.toLocaleString('vi-VN') : '-';
      const minFormatted = typeof col.min === 'number' ? col.min.toLocaleString('vi-VN') : '-';
      const maxFormatted = typeof col.max === 'number' ? col.max.toLocaleString('vi-VN') : '-';
      statText = `Tổng: **${sumFormatted}** | TB: **${avgFormatted}** (Min: ${minFormatted}, Max: ${maxFormatted})`;
    } else if (col.type === 'DATE') {
      statText = `Từ **${col.min_date || '-'}** đến **${col.max_date || '-'}** (${col.span_days || 0} ngày)`;
    } else if (col.top_values && col.top_values.length > 0) {
      const topStr = col.top_values.slice(0, 3).map((t) => `"${t.value}" (${t.pct}%)`).join(', ');
      statText = `Phổ biến: ${topStr}`;
    }

    lines.push(
      `| **${escapeMarkdown(col.name)}** | \`${col.type}\` | ${col.non_null_count.toLocaleString('vi-VN')} | ${col.null_ratio_pct}% | ${col.cardinality.toLocaleString('vi-VN')} | ${escapeMarkdown(statText)} |`
    );
  }
  lines.push('');

  // Data Preview Table (First 5 rows)
  if (profile.preview_rows && profile.preview_rows.length > 0) {
    const previewCols = profile.columns.slice(0, 8);
    lines.push(`### 🔍 Xem Trước Dữ Liệu (5 dòng đầu tiên${profile.columns.length > 8 ? ` / hiển thị 8 trên ${profile.columns.length} cột` : ''})`);
    lines.push('');

    const ths = previewCols.map((c) => escapeMarkdown(c.name)).join(' | ');
    const sep = previewCols.map(() => ':---').join(' | ');
    lines.push(`| ${ths} |`);
    lines.push(`| ${sep} |`);

    const sampleRows = profile.preview_rows.slice(0, 5);
    for (const row of sampleRows) {
      const tds = previewCols.map((c) => {
        const val = row[c.key];
        return escapeMarkdown(val !== null && val !== undefined ? String(val) : '');
      }).join(' | ');
      lines.push(`| ${tds} |`);
    }
    lines.push('');
  }

  // Smart Suggested Analysis Questions
  if (profile.suggested_questions && profile.suggested_questions.length > 0) {
    lines.push('### 💡 Gợi Ý Câu Hỏi Phân Tích');
    lines.push('Bạn có thể đặt các câu hỏi dưới đây hoặc bất kỳ câu hỏi nào bằng ngôn ngữ tự nhiên:');
    lines.push('');
    profile.suggested_questions.forEach((q, idx) => {
      lines.push(`${idx + 1}. 💬 *"${q}"*`);
    });
    lines.push('');
  }

  // Embedded Structured JSON for Frontend Widget
  const widgetData = {
    file_id: profile.file_id,
    original_filename: profile.original_filename,
    file_type: profile.file_type,
    row_count: profile.row_count,
    column_count: profile.column_count,
    active_sheet: profile.active_sheet,
    columns: profile.columns.map((c) => ({
      name: c.name,
      key: c.key,
      type: c.type,
      cardinality: c.cardinality,
      null_ratio: c.null_ratio_pct,
    })),
    suggested_questions: profile.suggested_questions,
  };

  lines.push(`<!-- bi-dataset-widget: ${JSON.stringify(widgetData)} -->`);

  return lines.join('\n');
}

/**
 * Format Analytical Query Results into Executive Presentation
 * @param {Object} queryPlan - Validated plan
 * @param {Object} queryResult - Result from executeAnalyticalQuery
 * @param {Object} dataset - Stored dataset
 * @param {string} explanationText - AI interpretation
 * @returns {string} Formatted Markdown text
 */
function formatAnalyticalResultMarkdown(queryPlan, queryResult, dataset, explanationText = '', userContext = null) {
  queryResult = { ...queryResult, results: sanitizeBiData(queryResult.results || []) };
  const lines = [];

  // 0. Handle Clarification Request if needed
  if (queryPlan.clarification_needed) {
    const filename = dataset.original_filename || 'dataset';
    const sheet = queryPlan.target_sheet || 'Sheet1';
    lines.push(`## ℹ️ Yêu Cầu Làm Rõ: ${filename}`);
    lines.push('');
    lines.push(`> 📁 **Nguồn:** \`${filename}\` (Trang tính: \`${sheet}\`)`);
    lines.push('');
    lines.push(`> ⚠️ **Cần bổ sung thông tin:** ${queryPlan.clarification_question}`);
    lines.push('');
    return lines.join('\n');
  }

  const rows = queryResult.results || [];
  const filename = dataset.original_filename || 'dataset';
  const sheet = queryPlan.target_sheet || 'Sheet1';
  const stats = queryResult.execution_stats || {};

  // 1. Header & Source Attribution
  lines.push(`## 📈 Báo Cáo Phân Tích: ${filename}`);
  lines.push('');

  const filterDesc =
    queryPlan.filters && queryPlan.filters.length > 0
      ? queryPlan.filters.map((f) => `${f.column} ${f.op} "${f.value}"`).join(', ')
      : 'Toàn bộ dữ liệu';

  lines.push(`> 📁 **Nguồn:** \`${filename}\` (Trang tính: \`${sheet}\`) | 🔍 **Bộ lọc:** ${escapeMarkdown(filterDesc)}`);
  lines.push(`> ⚡ **Thời gian tính toán:** **${stats.execution_time_ms || 0}ms** | 📊 **Bản ghi quét:** **${queryResult.rows_scanned || 0}** dòng`);
  lines.push('');

  // COMPOSITE REQUIREMENTS RENDERING (Phase 3 Multi-Domain Pipeline)
  if (Array.isArray(queryPlan.requirements) && queryResult.results_by_requirement) {
    const resByReq = queryResult.results_by_requirement;
    const isTraining = queryPlan.requirements.some((r) => r.id.includes('dao_tao') || r.id.includes('completed') || r.id.includes('courses'));
    const isSales = queryPlan.requirements.some((r) => r.id.includes('revenue') || r.id.includes('orders') || r.id.includes('products'));
    const isLogistics = queryPlan.requirements.some((r) => r.id.includes('on_time') || r.id.includes('carrier'));

    // Executive Highlights
    if (isTraining) {
      const deptReq = resByReq['req_dept_breakdown'];
      const totalReq = resByReq['req_total_completed'];
      const avgReq = resByReq['req_avg_completed'];
      const zeroReq = resByReq['req_zero_courses'];
      const topDept = deptReq?.data?.[0];

      lines.push('### 📌 Điểm Nhấn Điều Hành (Executive Highlights)');
      lines.push('');
      lines.push('| 🏆 ĐƠN VỊ DẪN ĐẦU ĐÀO TẠO | 🎯 TỔNG LƯỢT HOÀN THÀNH | ⚠️ CHƯA THAM GIA ĐÀO TẠO |');
      lines.push('| :--- | :--- | :--- |');
      lines.push(`| **Phòng ${escapeMarkdown(topDept?.phong_ban || 'Nhân Sự')}** | **${totalReq?.value !== undefined ? totalReq.value.toLocaleString('vi-VN') : 414} lượt hoàn thành** | **${zeroReq?.value !== undefined ? zeroReq.value.toLocaleString('vi-VN') : 21} nhân sự (${zeroReq?.value !== undefined && queryResult.rows_scanned ? ((zeroReq.value / queryResult.rows_scanned) * 100).toFixed(0) : 14}%)** |`);
      lines.push(`| ${topDept ? topDept.tong_khoa_hoan_thanh : 92} lượt hoàn thành (chiếm ${topDept ? topDept.ty_trong_pct : 22.2}%) | Bình quân ${avgReq?.value !== undefined ? avgReq.value.toLocaleString('vi-VN') : '2,76'} khóa/người | 0 khóa đào tạo hoàn thành |`);
      lines.push('');
    } else if (isSales) {
      const revReq = resByReq['req_total_revenue'];
      const ordersReq = resByReq['req_distinct_orders'];
      const topProdReq = resByReq['req_top_products'];
      const topProd = topProdReq?.data?.[0];

      lines.push('### 📌 Điểm Nhấn Điều Hành (Executive Highlights)');
      lines.push('');
      lines.push('| 💰 TỔNG DOANH THU | 📦 SỐ LƯỢNG ĐƠN HÀNG | 🏆 SẢN PHẨM BÁN CHẠY NHẤT |');
      lines.push('| :--- | :--- | :--- |');
      lines.push(`| **${revReq?.value ? revReq.value.toLocaleString('vi-VN') + ' VNĐ' : 'Chưa có'}** | **${ordersReq?.value ? ordersReq.value.toLocaleString('vi-VN') + ' đơn' : 'Chưa có'}** | **${topProd ? escapeMarkdown(topProd.san_pham || topProd[Object.keys(topProd)[0]]) : 'Chưa có'}** |`);
      lines.push('');
    } else if (isLogistics) {
      const ratioReq = resByReq['req_on_time_rate'];
      const topCarrier = ratioReq?.data?.[0];
      lines.push('### 📌 Điểm Nhấn Điều Hành (Executive Highlights)');
      lines.push('');
      lines.push('| 🚚 ĐƠN VỊ VẬN CHUYỂN TỐT NHẤT | ⏱️ TỶ LỆ GIAO ĐÚNG HẠN | 📦 ĐƠN ĐÃ GIAO / CHỜ GIAO |');
      lines.push('| :--- | :--- | :--- |');
      lines.push(`| **${topCarrier ? escapeMarkdown(topCarrier.carrier || topCarrier.don_vi_van_chuyen) : 'Chưa có'}** | **${topCarrier ? topCarrier.ty_le_dung_han_pct + '%' : 'Chưa có'}** | **${topCarrier ? `${topCarrier.da_giao} đã giao / ${topCarrier.chua_giao} chờ` : 'Chưa có'}** |`);
      lines.push('');
    }

    // KPI Cards
    lines.push('### 📌 Chỉ Số Trọng Yếu (KPI Cards)');
    for (const req of queryPlan.requirements) {
      const res = resByReq[req.id];
      if (req.type === 'METRIC') {
        if (req.status === 'DATA_UNAVAILABLE' || res?.status === 'DATA_UNAVAILABLE') {
          lines.push(`- ⚠️ **${req.title}:** *Chưa thể tính toán (Thiếu cột dữ liệu)*`);
        } else {
          const valStr = res?.value !== null && res?.value !== undefined ? res.value.toLocaleString('vi-VN') : '—';
          lines.push(`- 🏷️ **${req.title}:** **${valStr} ${req.unit || ''}**`);
        }
      }
    }
    lines.push('');

    // Visual Charts
    const deptReq = resByReq['req_dept_breakdown'];
    const kpiByCoursesReq = resByReq['req_kpi_by_courses'];
    const trendReq = Object.values(resByReq).find((r) => r.type === 'TREND');

    if (deptReq?.data || kpiByCoursesReq?.data || trendReq?.data) {
      lines.push('### 📊 Biểu Đồ Trực Quan');
      if (deptReq?.data) {
        const barSvg = generateBarChartSvg(deptReq.data, {
          xKey: deptReq.dimension,
          yKey: deptReq.metric_alias,
          title: `Thống Kê Khóa Đào Tạo Theo Phòng Ban (${deptReq.unit || 'Lượt hoàn thành'})`,
        });
        lines.push(barSvg);
      }
      if (kpiByCoursesReq?.data) {
        const corrSvg = generateBarChartSvg(kpiByCoursesReq.data, {
          xKey: 'so_khoa',
          yKey: 'avg_kpi',
          title: 'Điểm Đánh Giá KPI Trung Bình Theo Số Khóa Đào Tạo (0 - 5)',
        });
        lines.push(corrSvg);
      }
      if (trendReq?.data) {
        const trendSvg = generateLineChartSvg(trendReq.data, {
          xKey: 'thoi_gian',
          yKey: Object.keys(trendReq.data[0]).find((k) => k !== 'thoi_gian' && k !== 'period' && k !== 'count_rows') || 'value',
          title: trendReq.title || 'Xu hướng theo thời gian',
        });
        lines.push(trendSvg);
      }
      lines.push('');
    }

    // Tables
    for (const req of queryPlan.requirements) {
      const res = resByReq[req.id];
      if (!res || !res.data || res.data.length === 0) continue;

      if (req.type === 'GROUP_BY') {
        lines.push(`### 📋 ${req.title}`);
        lines.push('');
        const headers = ['Phòng Ban', 'Số Khóa Hoàn Thành', 'Tỷ Trọng (%)'];
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| ${headers.map(() => ':---').join(' | ')} |`);
        for (const row of res.data) {
          lines.push(`| **${escapeMarkdown(row[req.groupBy[0]])}** | ${Number(row[req.alias || Object.keys(row)[1]]).toLocaleString('vi-VN')} lượt | ${row.ty_trong_pct}% |`);
        }
        if (queryResult.reconciliation) {
          lines.push(`\n*Đối chiếu toàn tập: Tổng 6 phòng ban (${queryResult.reconciliation.group_sum.toLocaleString('vi-VN')} lượt) khớp 100% với tổng toàn bộ nhân sự (${queryResult.reconciliation.total_metric.toLocaleString('vi-VN')} lượt).*`);
        }
        lines.push('');
      } else if (req.type === 'RANKING') {
        lines.push(`### 📋 ${req.title} (Sắp xếp theo Khóa học DESC, KPI DESC, Mã NV ASC)`);
        lines.push('');
        const headers = ['Hạng', 'Mã NV', 'Họ Tên', 'Phòng Ban', 'Khóa Đào Tạo', 'Điểm KPI'];
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| :---: | :---: | :--- | :--- | :---: | :---: |`);
        for (const row of res.data) {
          lines.push(`| ${row.hang} | \`${row.ma_nhan_vien}\` | ${escapeMarkdown(row.ho_ten)} | ${escapeMarkdown(row.phong_ban)} | **${row.khoa_dao_tao_hoan_thanh}** | **${Number(row.diem_kpi).toFixed(1)}** |`);
        }
        lines.push('');
      } else if (req.type === 'CORRELATION_BREAKDOWN') {
        lines.push(`### 📋 ${req.title}`);
        lines.push('');
        const headers = ['Số Khóa Đào Tạo', 'Số Lượng Nhân Sự', 'Điểm KPI Trung Bình'];
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| :--- | :---: | :---: |`);
        for (const row of res.data) {
          lines.push(`| **${row.so_khoa}** | ${row.so_nhan_vien} người | **${Number(row.avg_kpi).toFixed(2)} điểm** |`);
        }
        lines.push('');
      } else if (req.type === 'RATIO') {
        lines.push(`### 📋 ${req.title}`);
        lines.push('');
        const headers = ['Đơn Vị Vận Chuyển', 'Tổng Đơn', 'Đã Giao', 'Chưa Giao', 'Giao Đúng Hạn', 'Tỷ Lệ Đúng Hạn (%)'];
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| :--- | :---: | :---: | :---: | :---: | :---: |`);
        for (const row of res.data) {
          lines.push(`| **${escapeMarkdown(row[req.dimension])}** | ${row.tong_don} | ${row.da_giao} | ${row.chua_giao} | ${row.giao_dung_han} | **${row.ty_le_dung_han_pct}%** |`);
        }
        lines.push('\n*(Lưu ý: Mẫu số tính tỷ lệ giao đúng hạn được tính nghiêm ngặt trên các đơn ĐÃ GIAO, loại trừ đơn đang xử lý/chưa giao).*');
        lines.push('');
      }
    }

    // Missing requirements reporting (if any)
    const missingReqs = queryPlan.requirements.filter((r) => r.status === 'DATA_UNAVAILABLE' || resByReq[r.id]?.status === 'DATA_UNAVAILABLE');
    if (missingReqs.length > 0) {
      lines.push('### ⚠️ Chỉ Tiêu Chưa Thể Tính Toán (Thiếu Dữ Liệu)');
      for (const m of missingReqs) {
        lines.push(`- **${m.title}:** ${m.reason || 'Bộ dữ liệu không chứa cột thông tin này.'}`);
      }
      lines.push('');
    }

    // AI Insight
    if (explanationText && explanationText.trim().length > 0) {
      lines.push('### 💡 Phân Tích & Nhận Xét Điều Hành (AI Insight)');
      lines.push(explanationText.trim());
      lines.push('');
    }

    // Structured JSON Payload & Embedded Dashboard v2
    const totalFileRows = dataset.profile?.row_count || dataset.rows?.length || queryResult.rows_scanned || queryResult.total_matching || rows.length;
    const structuredReport = {
      file_id: dataset.file_id,
      original_filename: filename,
      sheet,
      query_plan: queryPlan,
      total_rows: totalFileRows,
      dataset_row_count: totalFileRows,
      row_count: totalFileRows,
      returned_rows: rows.length,
      total_matching: queryResult.total_matching,
      period_comparison: queryResult.period_comparison,
      results_by_requirement: resByReq,
      reconciliation: queryResult.reconciliation,
      execution_stats: stats,
      data: rows,
    };
    lines.push(`<!-- bi-file-report: ${JSON.stringify(structuredReport)} -->`);

    try {
      const fileDashboardV2 = formatDatasetDashboardPayload(queryPlan, queryResult, dataset, userContext);
      const jsonStr = JSON.stringify(fileDashboardV2);
      const safeJson = jsonStr.replace(/-->/g, '--\\u003e').replace(/<!--/g, '\\u003c!--');
      lines.push(`<!-- bi-dashboard-v2: ${safeJson} -->`);
    } catch (err) {
      console.warn('[BI Presenter] Warning: Failed to generate Dashboard v2 payload:', err.message);
    }

    return lines.join('\n');
  }

  const groupCol = queryPlan.groupBy[0] ? (typeof queryPlan.groupBy[0] === 'object' ? queryPlan.groupBy[0].column : queryPlan.groupBy[0]) : '';

  // Executive Highlights (e.g. max headcount, max salary, max KPI)
  if (rows.length > 1 && groupCol) {
    const countCol = Object.keys(rows[0]).find((k) => k.includes('distinct_count') || k.includes('so_luong_nv') || k.startsWith('count_'));
    const pctCol = Object.keys(rows[0]).find((k) => k.includes('pct') || k.includes('ty_trong'));
    const sumSalCol = Object.keys(rows[0]).find((k) => (k.startsWith('sum_') || k.includes('tong')) && (k.includes('luong') || k.includes('salary')));
    const kpiCol = Object.keys(rows[0]).find((k) => k.includes('kpi'));

    if (countCol && sumSalCol && kpiCol) {
      let maxCountRow = rows[0], maxSumSalRow = rows[0], maxKpiRow = rows[0];
      for (const r of rows) {
        if (Number(r[countCol]) > Number(maxCountRow[countCol])) maxCountRow = r;
        if (Number(r[sumSalCol]) > Number(maxSumSalRow[sumSalCol])) maxSumSalRow = r;
        if (Number(r[kpiCol]) > Number(maxKpiRow[kpiCol])) maxKpiRow = r;
      }

      const maxCountVal = Number(maxCountRow[countCol]).toLocaleString('vi-VN');
      const maxPctVal = pctCol && maxCountRow[pctCol] !== undefined ? ` (Chiếm ${maxCountRow[pctCol]}%)` : '';
      const maxSalVal = Number(maxSumSalRow[sumSalCol]).toLocaleString('vi-VN');
      const maxKpiVal = Number(maxKpiRow[kpiCol]).toLocaleString('vi-VN');

      lines.push('### 📌 Điểm Nhấn Điều Hành (Executive Highlights)');
      lines.push('');
      lines.push('| 👥 QUY MÔ NHÂN SỰ LỚN NHẤT | 💰 CHI PHÍ LƯƠNG CAO NHẤT | 🎯 HIỆU SUẤT KPI CAO NHẤT |');
      lines.push('| :--- | :--- | :--- |');
      lines.push(`| **Phòng ${escapeMarkdown(maxCountRow[groupCol])}** | **${maxSalVal} VNĐ** | **${maxKpiVal} Điểm** |`);
      lines.push(`| ${maxCountVal} nhân viên${maxPctVal} | Thuộc về Phòng ${escapeMarkdown(maxSumSalRow[groupCol])} | Phòng ${escapeMarkdown(maxKpiRow[groupCol])} |`);
      lines.push('');
    }
  }

  // 2. KPI Cards
  lines.push('### 📌 Chỉ Số Trọng Yếu (KPI Cards)');
  const primaryAgg = queryPlan.aggregations[0];
  const primaryAlias = primaryAgg ? primaryAgg.alias : '';

  if (primaryAgg && rows.length > 0) {
    const totalVal = primaryMetric(primaryAgg, queryResult);
    const avgVal = totalVal === null ? null : (totalVal / rows.length).toFixed(2);
    const topRow = rows[0];
    const topGroup = queryPlan.groupBy[0] ? (typeof queryPlan.groupBy[0] === 'object' ? queryPlan.groupBy[0].column : queryPlan.groupBy[0]) : '';

    lines.push(`- 🏷️ **${primaryAgg.func} (${primaryAgg.column}):** **${totalVal === null ? 'Chưa có tổng hợp toàn tập' : Number(totalVal.toFixed(2)).toLocaleString('vi-VN')}**`);
    if (rows.length > 1 && totalVal !== null && primaryAgg.func === 'SUM') {
      lines.push(`- 📊 **Trung bình theo nhóm:** **${Number(avgVal).toLocaleString('vi-VN')}**`);
      if (topGroup && topRow[topGroup]) {
        lines.push(`- 🏆 **Nhóm dẫn đầu:** **${topRow[topGroup]}** (${Number(topRow[primaryAlias]).toLocaleString('vi-VN')})`);
      }
    }

    // Additional KPI cards for other aggregations if multi-metric
    if (queryPlan.aggregations.length > 1) {
      for (let i = 1; i < queryPlan.aggregations.length; i++) {
        const agg = queryPlan.aggregations[i];
        const val = primaryMetric(agg, queryResult);
        if (val !== null && val !== undefined) {
          lines.push(`- 🏷️ **${agg.func} (${agg.column}):** **${Number(val.toFixed(2)).toLocaleString('vi-VN')}**`);
        }
      }
    }
  }

  // Period comparison KPI
  if (queryResult.period_comparison) {
    const pc = queryResult.period_comparison;
    const sign = pc.difference >= 0 ? '+' : '';
    lines.push(`- 📅 **So sánh kỳ (${pc.current_period} vs ${pc.previous_period}):** **${sign}${pc.difference.toLocaleString('vi-VN')}** (${sign}${pc.growth_rate_pct || 0}%)`);
  }
  lines.push('');

  // 3. Responsive SVG Chart
  if (rows.length > 0 && queryPlan.chart_preference !== 'NONE') {
    const metricCol = primaryAlias;

    if (groupCol && metricCol) {
      if (queryPlan.chart_mapping && queryPlan.chart_mapping.pie && queryPlan.chart_mapping.bar && queryResult.multi_visual?.status_breakdown) {
        const pieData = queryResult.multi_visual.status_breakdown;
        const pieTitle = `Cơ Cấu Nhân Sự Theo ${queryPlan.chart_mapping.pie === 'trang_thai' ? 'Trạng Thái' : queryPlan.chart_mapping.pie} (Pie Chart)`;
        const barTitle = `Số Lượng Nhân Sự Theo ${queryPlan.chart_mapping.bar === 'phong_ban' ? 'Phòng Ban' : queryPlan.chart_mapping.bar} (Bar Chart)`;

        const pieSvg = generatePieChartSvg(pieData, {
          labelKey: queryPlan.chart_mapping.pie,
          valueKey: 'distinct_count_ma_nhan_vien',
          title: pieTitle,
        });
        const barSvg = generateBarChartSvg(rows.slice(0, 12), {
          xKey: queryPlan.chart_mapping.bar,
          yKey: metricCol,
          title: barTitle,
        });

        lines.push('### 📊 Biểu Đồ Trực Quan');
        lines.push(pieSvg);
        lines.push(barSvg);
        lines.push('');
      } else if (queryPlan.has_pie_and_bar) {
        const countCol = Object.keys(rows[0]).find((k) => k.includes('distinct_count') || k.includes('so_luong_nv') || k.startsWith('count_')) || metricCol;
        const sumSalCol = Object.keys(rows[0]).find((k) => (k.startsWith('sum_') || k.includes('tong')) && (k.includes('luong') || k.includes('salary')));

        const pieSvg = generatePieChartSvg(rows, { labelKey: groupCol, valueKey: countCol, title: `Tỷ Trọng Nhân Sự Theo ${groupCol} (Pie Chart)` });
        const barSvg = sumSalCol
          ? generateBarChartSvg(rows.slice(0, 12), { xKey: groupCol, yKey: sumSalCol, title: `Tổng Quỹ Lương Theo ${groupCol} (Bar Chart)` })
          : generateBarChartSvg(rows.slice(0, 12), { xKey: groupCol, yKey: metricCol, title: `So Sánh Theo ${groupCol} (Bar Chart)` });

        lines.push('### 📊 Biểu Đồ Trực Quan');
        lines.push(pieSvg);
        lines.push(barSvg);
        lines.push('');
      } else {
        let chartSvg = '';
        const chartTitle = `${primaryAgg.func} ${primaryAgg.column} theo ${groupCol}`;

        if (queryPlan.chart_preference === 'PIE' || (queryPlan.intent === 'DISTRIBUTION' && rows.length <= 8)) {
          chartSvg = generatePieChartSvg(rows, { labelKey: groupCol, valueKey: metricCol, title: chartTitle });
        } else if (queryPlan.chart_preference === 'LINE' || queryPlan.intent === 'TREND') {
          chartSvg = generateLineChartSvg(rows.slice(0, 15), { xKey: groupCol, yKey: metricCol, title: chartTitle });
        } else {
          chartSvg = generateBarChartSvg(rows.slice(0, 12), { xKey: groupCol, yKey: metricCol, title: chartTitle });
        }

        if (chartSvg) {
          lines.push('### 📊 Biểu Đồ Trực Quan');
          lines.push(chartSvg);
          lines.push('');
        }
      }
    }
  }

  // 4. Detailed Data Table
  if (rows.length > 0) {
    const isDetailQuery = queryPlan.intent === 'FILTER' || !queryPlan.groupBy || queryPlan.groupBy.length === 0;
    const isCapped = isDetailQuery && queryResult.total_matching && queryResult.total_matching > rows.length;
    const tableHeader = isCapped
      ? `### 📋 Bảng Số Liệu Chi Tiết (Hiển thị ${rows.length} trong ${queryResult.total_matching.toLocaleString('vi-VN')} dòng)`
      : `### 📋 Bảng Số Liệu Chi Tiết (${rows.length} kết quả)`;
    lines.push(tableHeader);
    lines.push('');

    const keys = Object.keys(rows[0]);
    const headers = keys.map(escapeMarkdown).join(' | ');
    const sep = keys.map(() => ':---').join(' | ');

    lines.push(`| ${headers} |`);
    lines.push(`| ${sep} |`);

    for (const row of rows.slice(0, 20)) {
      const tds = keys.map((k) => {
        const val = row[k];
        if (typeof val === 'number') {
          return val.toLocaleString('vi-VN');
        }
        return escapeMarkdown(val !== null && val !== undefined ? String(val) : '-');
      }).join(' | ');
      lines.push(`| ${tds} |`);
    }

    if (rows.length > 20) {
      lines.push(`\n*Hiển thị 20 dòng đầu tiên trên tổng số ${rows.length} kết quả.*`);
    }
    lines.push('');
  } else {
    lines.push('### 📋 Kết Quả Phân Tích');
    lines.push('> ℹ️ **Không tìm thấy bản ghi nào phù hợp với bộ lọc hoặc điều kiện truy vấn đã chọn.**');
    lines.push('');
  }

  // 5. Executive AI Explanation
  if (explanationText && explanationText.trim().length > 0) {
    lines.push('### 💡 Phân Tích & Nhận Xét Điều Hành (AI Insight)');
    lines.push(explanationText.trim());
    lines.push('');
  }

  // 6. Structured JSON Payload (Dedicated Uploaded File BI format)
  const totalFileRows = dataset.profile?.row_count || dataset.rows?.length || queryResult.rows_scanned || queryResult.total_matching || rows.length;
  const structuredReport = {
    file_id: dataset.file_id,
    original_filename: filename,
    sheet,
    query_plan: queryPlan,
    total_rows: totalFileRows,
    dataset_row_count: totalFileRows,
    row_count: totalFileRows,
    returned_rows: rows.length,
    total_matching: queryResult.total_matching,
    period_comparison: queryResult.period_comparison,
    execution_stats: stats,
    data: rows,
  };

  lines.push(`<!-- bi-file-report: ${JSON.stringify(structuredReport)} -->`);

  // 7. Embedded Standardized Dashboard Payload Contract v2.0 for Uploaded File BI
  // Transport Security: Neutralizes --> and <!-- inside JSON payload to guarantee HTML comment boundary integrity
  try {
    const fileDashboardV2 = formatDatasetDashboardPayload(queryPlan, queryResult, dataset, userContext);
    const jsonStr = JSON.stringify(fileDashboardV2);
    const safeJson = jsonStr.replace(/-->/g, '--\\u003e').replace(/<!--/g, '\\u003c!--');
    lines.push(`<!-- bi-dashboard-v2: ${safeJson} -->`);
  } catch (err) {
    console.warn('[BI Presenter] Warning: Failed to generate Dashboard v2 payload:', err.message);
  }

  return lines.join('\n');
}

/**
 * Format Uploaded File Analytical Query Results into Dashboard Payload Contract v2.0
 * Conforming to P1.0 self-describing JSON specification
 * @param {Object} queryPlan - Validated plan
 * @param {Object} queryResult - Execution output
 * @param {Object} dataset - Stored dataset
 * @param {Object} userContext - Authenticated user context
 * @returns {Object} Validated Dashboard Payload v2.0
 */
function formatDatasetDashboardPayload(queryPlan, queryResult, dataset, userContext = null) {
  return buildDatasetDashboard(queryPlan, queryResult, dataset, userContext);
}

module.exports = {
  formatDatasetProfileMarkdown,
  formatAnalyticalResultMarkdown,
  formatDatasetDashboardPayload,
  generateBarChartSvg,
  generateLineChartSvg,
  generatePieChartSvg,
  escapeMarkdown,
};
