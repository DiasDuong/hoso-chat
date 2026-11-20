/**
 * SOTRANS HUB — ENTERPRISE BI CHART REGISTRY (CONTRACT V2.0 / PHASE 4)
 * 
 * Enterprise Chart Registry & Intelligence Recommendation Engine:
 * - Groups A to H Enterprise Chart Catalog
 * - Metadata specifications: Supported Data Shapes, Required Dimensions/Measures, Validation Rules, Interaction Specs
 * - Intelligent Recommendation Engine: Selects optimal chart based on analytical intent, data cardinality, temporal traits, and user preferences
 * - ECharts Option Synthesizers for each chart type with responsive enterprise palettes
 * - Graceful Fallbacks to ensure zero visualization crashes
 */

'use strict';

const ENTERPRISE_PALETTE = Object.freeze([
  '#0284c7', // Primary Ocean Blue
  '#2563eb', // Indigo Blue
  '#10b981', // Emerald Green
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#64748b', // Slate Gray
  '#f43f5e', // Rose
  '#14b8a6', // Teal
]);

/**
 * Enterprise Chart Catalog Definitions (Groups A through H)
 */
const CHART_REGISTRY = {
  // ==========================================
  // GROUP A: KPI & Summary
  // ==========================================
  KPI_CARD: {
    id: 'KPI_CARD',
    name: 'Thẻ KPI Đơn mục tiêu',
    group: 'A_SUMMARY',
    supportedShapes: ['SCALAR', 'SINGLE_METRIC'],
    minDimensions: 0,
    maxDimensions: 0,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['COUNT', 'DISTINCT_COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'PERCENTAGE', 'RATIO'],
    interactions: { clickable: true, filterable: false, tooltip: true },
    fallbackType: 'METRIC_CARD',
    description: 'Hiển thị giá trị chỉ số trọng yếu cùng xu hướng biến động và định dạng đơn vị.',
  },
  METRIC_CARD: {
    id: 'METRIC_CARD',
    name: 'Thẻ Chỉ Số Thứ cấp',
    group: 'A_SUMMARY',
    supportedShapes: ['SCALAR'],
    minDimensions: 0,
    maxDimensions: 0,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'],
    interactions: { clickable: false, tooltip: true },
    fallbackType: 'KPI_CARD',
    description: 'Thẻ chỉ số phụ hỗ trợ ngữ cảnh cho dashboard.',
  },
  GAUGE: {
    id: 'GAUGE',
    name: 'Biểu đồ Đồng Hồ Tốc Độ (Gauge)',
    group: 'A_SUMMARY',
    supportedShapes: ['SCALAR_RATIO', 'PERCENTAGE'],
    minDimensions: 0,
    maxDimensions: 0,
    minMeasures: 1,
    maxMeasures: 2,
    supportedAggregations: ['PERCENTAGE', 'RATIO', 'AVG'],
    interactions: { tooltip: true },
    fallbackType: 'KPI_CARD',
    description: 'Đo lường mức độ hoàn thành chỉ tiêu so với mục tiêu hoặc tỷ lệ phần trăm (0-100%).',
  },

  // ==========================================
  // GROUP B: Comparison
  // ==========================================
  BAR: {
    id: 'BAR',
    name: 'Biểu đồ Cột Đứng (Vertical Bar)',
    group: 'B_COMPARISON',
    supportedShapes: ['CATEGORY_METRIC'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 4,
    supportedAggregations: ['SUM', 'AVG', 'COUNT', 'DISTINCT_COUNT', 'MIN', 'MAX'],
    interactions: { selectable: true, filterable: true, drilldown: true, tooltip: true },
    fallbackType: 'HORIZONTAL_BAR',
    description: 'So sánh độ lớn các danh mục rời rạc (phòng ban, trạng thái, danh mục).',
  },
  HORIZONTAL_BAR: {
    id: 'HORIZONTAL_BAR',
    name: 'Biểu đồ Cột Ngang (Horizontal Bar)',
    group: 'B_COMPARISON',
    supportedShapes: ['CATEGORY_METRIC'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 2,
    supportedAggregations: ['SUM', 'AVG', 'COUNT', 'DISTINCT_COUNT'],
    interactions: { selectable: true, filterable: true, drilldown: true, tooltip: true },
    fallbackType: 'BAR',
    description: 'Thích hợp cho danh mục có tên dài hoặc bảng xếp hạng Top N.',
  },
  GROUPED_BAR: {
    id: 'GROUPED_BAR',
    name: 'Biểu đồ Cột Nhóm (Grouped Bar)',
    group: 'B_COMPARISON',
    supportedShapes: ['CATEGORY_MULTI_METRIC', 'TWO_DIMENSION_METRIC'],
    minDimensions: 1,
    maxDimensions: 2,
    minMeasures: 2,
    maxMeasures: 6,
    supportedAggregations: ['SUM', 'AVG', 'COUNT'],
    interactions: { selectable: true, filterable: true, tooltip: true, legendToggle: true },
    fallbackType: 'BAR',
    description: 'So sánh đa chỉ số hoặc hai chiều phân loại cạnh nhau.',
  },
  STACKED_BAR: {
    id: 'STACKED_BAR',
    name: 'Biểu đồ Cột Chồng (Stacked Bar)',
    group: 'B_COMPARISON',
    supportedShapes: ['CATEGORY_MULTI_METRIC'],
    minDimensions: 1,
    maxDimensions: 2,
    minMeasures: 2,
    maxMeasures: 6,
    supportedAggregations: ['SUM', 'COUNT'],
    interactions: { selectable: true, filterable: true, tooltip: true, legendToggle: true },
    fallbackType: 'BAR',
    description: 'So sánh tổng quy mô và các thành phần cấu thành cùng lúc.',
  },
  PERCENT_STACKED_BAR: {
    id: 'PERCENT_STACKED_BAR',
    name: 'Biểu đồ Cột Chồng 100% (100% Stacked Bar)',
    group: 'B_COMPARISON',
    supportedShapes: ['CATEGORY_MULTI_METRIC'],
    minDimensions: 1,
    maxDimensions: 2,
    minMeasures: 2,
    maxMeasures: 6,
    supportedAggregations: ['SUM', 'COUNT', 'PERCENTAGE'],
    interactions: { selectable: true, filterable: true, tooltip: true, legendToggle: true },
    fallbackType: 'STACKED_BAR',
    description: 'So sánh cơ cấu tỷ trọng tương đối giữa các nhóm chuẩn hóa 100%.',
  },
  LOLLIPOP: {
    id: 'LOLLIPOP',
    name: 'Biểu đồ Lollipop',
    group: 'B_COMPARISON',
    supportedShapes: ['CATEGORY_METRIC'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['SUM', 'AVG', 'COUNT'],
    interactions: { selectable: true, filterable: true, tooltip: true },
    fallbackType: 'BAR',
    description: 'Trực quan hóa so sánh gọn gàng, giảm mật độ trực quan so với Bar Chart lớn.',
  },

  // ==========================================
  // GROUP C: Trend & Time Series
  // ==========================================
  LINE: {
    id: 'LINE',
    name: 'Biểu đồ Đường Xu Hướng (Line Chart)',
    group: 'C_TREND',
    supportedShapes: ['TIME_SERIES', 'ORDERED_METRIC'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 4,
    supportedAggregations: ['SUM', 'AVG', 'COUNT', 'DISTINCT_COUNT'],
    interactions: { selectable: true, filterable: true, zoom: true, tooltip: true },
    fallbackType: 'BAR',
    description: 'Thể hiện diễn biến, xu hướng chỉ số theo thời gian (ngày, tháng, quý, năm).',
  },
  MULTI_LINE: {
    id: 'MULTI_LINE',
    name: 'Biểu đồ Đa Đường (Multi-Line Chart)',
    group: 'C_TREND',
    supportedShapes: ['TIME_SERIES_MULTI_SERIES'],
    minDimensions: 1,
    maxDimensions: 2,
    minMeasures: 1,
    maxMeasures: 6,
    supportedAggregations: ['SUM', 'AVG'],
    interactions: { selectable: true, zoom: true, tooltip: true, legendToggle: true },
    fallbackType: 'LINE',
    description: 'So sánh tốc độ và xu thế giữa nhiều phân khúc hoặc dòng sản phẩm theo thời gian.',
  },
  AREA: {
    id: 'AREA',
    name: 'Biểu đồ Vùng (Area Chart)',
    group: 'C_TREND',
    supportedShapes: ['TIME_SERIES'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 2,
    supportedAggregations: ['SUM', 'AVG', 'COUNT'],
    interactions: { zoom: true, tooltip: true },
    fallbackType: 'LINE',
    description: 'Nhấn mạnh độ lớn của khối lượng tích lũy theo thời gian.',
  },
  STACKED_AREA: {
    id: 'STACKED_AREA',
    name: 'Biểu đồ Vùng Chồng (Stacked Area)',
    group: 'C_TREND',
    supportedShapes: ['TIME_SERIES_MULTI_SERIES'],
    minDimensions: 1,
    maxDimensions: 2,
    minMeasures: 2,
    maxMeasures: 6,
    supportedAggregations: ['SUM', 'COUNT'],
    interactions: { zoom: true, tooltip: true, legendToggle: true },
    fallbackType: 'AREA',
    description: 'Thể hiện sự thay đổi cơ cấu tổng thể và đóng góp của từng nhóm theo thời gian.',
  },
  STEP_LINE: {
    id: 'STEP_LINE',
    name: 'Biểu đồ Đường Bậc Thang (Step Line)',
    group: 'C_TREND',
    supportedShapes: ['TIME_SERIES_DISCRETE'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 2,
    supportedAggregations: ['SUM', 'AVG'],
    interactions: { tooltip: true },
    fallbackType: 'LINE',
    description: 'Hiển thị dữ liệu thay đổi theo bước rời rạc (lãi suất, định mức, bảng giá).',
  },
  COMBO: {
    id: 'COMBO',
    name: 'Biểu đồ Kết Hợp Cột & Đường (Combo Bar + Line)',
    group: 'C_TREND',
    supportedShapes: ['CATEGORY_DUAL_AXIS'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 2,
    maxMeasures: 3,
    supportedAggregations: ['SUM', 'AVG', 'RATIO', 'PERCENTAGE'],
    interactions: { tooltip: true, legendToggle: true },
    fallbackType: 'BAR',
    description: 'Kết hợp chỉ số quy mô (Cột: Doanh thu, Sản lượng) và chỉ số hiệu suất (Đường: Tỷ lệ, Biên lợi nhuận).',
  },

  // ==========================================
  // GROUP D: Composition
  // ==========================================
  PIE: {
    id: 'PIE',
    name: 'Biểu đồ Tròn Cơ Cấu (Pie Chart)',
    group: 'D_COMPOSITION',
    supportedShapes: ['CATEGORY_PART_TO_WHOLE'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['SUM', 'COUNT', 'DISTINCT_COUNT'],
    validationRules: ['NO_NEGATIVE_VALUES', 'MAX_CARDINALITY_7'],
    interactions: { selectable: true, filterable: true, tooltip: true, legendToggle: true },
    fallbackType: 'BAR',
    description: 'Thể hiện tỷ trọng của ít hơn 7 nhóm cấu thành trong một tổng thể 100%.',
  },
  DONUT: {
    id: 'DONUT',
    name: 'Biểu đồ Vành Khuyên (Donut Chart)',
    group: 'D_COMPOSITION',
    supportedShapes: ['CATEGORY_PART_TO_WHOLE'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['SUM', 'COUNT', 'DISTINCT_COUNT'],
    validationRules: ['NO_NEGATIVE_VALUES', 'MAX_CARDINALITY_8'],
    interactions: { selectable: true, filterable: true, tooltip: true, legendToggle: true },
    fallbackType: 'BAR',
    description: 'Tương tự biểu đồ tròn nhưng hiện đại hơn và hỗ trợ đặt chỉ số tổng ở tâm vành.',
  },
  TREEMAP: {
    id: 'TREEMAP',
    name: 'Biểu đồ Cây Phân Cấp (Treemap)',
    group: 'D_COMPOSITION',
    supportedShapes: ['HIERARCHICAL_RECTANGLES'],
    minDimensions: 1,
    maxDimensions: 2,
    minMeasures: 1,
    maxMeasures: 2,
    supportedAggregations: ['SUM', 'COUNT'],
    validationRules: ['NO_NEGATIVE_VALUES'],
    interactions: { drilldown: true, tooltip: true },
    fallbackType: 'BAR',
    description: 'Trực quan hóa cấu trúc đóng góp lồng ghép nhiều cấp với số lượng danh mục lớn.',
  },
  WATERFALL: {
    id: 'WATERFALL',
    name: 'Biểu đồ Thác Nước (Waterfall Chart)',
    group: 'D_COMPOSITION',
    supportedShapes: ['VARIANCE_DECOMPOSITION'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 2,
    supportedAggregations: ['SUM', 'VARIANCE'],
    interactions: { tooltip: true },
    fallbackType: 'BAR',
    description: 'Phân tích các yếu tố cộng dồn tăng/giảm từ điểm khởi đầu đến số dư cuối kỳ (P&L, ngân sách).',
  },

  // ==========================================
  // GROUP E: Distribution
  // ==========================================
  HISTOGRAM: {
    id: 'HISTOGRAM',
    name: 'Biểu đồ Phân Phối Tần Suất (Histogram)',
    group: 'E_DISTRIBUTION',
    supportedShapes: ['CONTINUOUS_BINS'],
    minDimensions: 0,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['COUNT', 'DISTRIBUTION'],
    interactions: { tooltip: true },
    fallbackType: 'BAR',
    description: 'Phát hiện hình dạng phân phối (lệch trái, lệch phải, chuẩn) của biến liên tục (lương, thời gian, chi phí).',
  },
  BOXPLOT: {
    id: 'BOXPLOT',
    name: 'Biểu đồ Hộp & Râu (Box Plot)',
    group: 'E_DISTRIBUTION',
    supportedShapes: ['FIVE_NUMBER_SUMMARY'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['PERCENTILE', 'MIN', 'MAX', 'MEDIAN'],
    interactions: { tooltip: true },
    fallbackType: 'BAR',
    description: 'Phát hiện điểm ngoại lai (outliers), khoảng tứ phân vị (IQR) và trung vị giữa các nhóm.',
  },

  // ==========================================
  // GROUP F: Relationships
  // ==========================================
  SCATTER: {
    id: 'SCATTER',
    name: 'Biểu đồ Phân Tán (Scatter Plot)',
    group: 'F_RELATIONSHIPS',
    supportedShapes: ['POINT_PAIRS'],
    minDimensions: 0,
    maxDimensions: 1,
    minMeasures: 2,
    maxMeasures: 3,
    supportedAggregations: ['NONE', 'RAW_VALUES', 'CORRELATION'],
    interactions: { zoom: true, tooltip: true, brush: true },
    fallbackType: 'BAR',
    description: 'Khảo sát mối tương quan hoặc phân cụm giữa hai chỉ số định lượng liên tục.',
  },
  BUBBLE: {
    id: 'BUBBLE',
    name: 'Biểu đồ Bong Bóng (Bubble Chart)',
    group: 'F_RELATIONSHIPS',
    supportedShapes: ['POINT_TUPLES_3D'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 3,
    maxMeasures: 3,
    supportedAggregations: ['NONE', 'RAW_VALUES'],
    interactions: { zoom: true, tooltip: true },
    fallbackType: 'SCATTER',
    description: 'Biểu diễn đồng thời 3 chiều thông tin: Trục X, Trục Y và Kích thước bong bóng (Z).',
  },
  HEATMAP: {
    id: 'HEATMAP',
    name: 'Bản Đồ Nhiệt Ma Trận (Heatmap)',
    group: 'F_RELATIONSHIPS',
    supportedShapes: ['MATRIX_GRID'],
    minDimensions: 2,
    maxDimensions: 2,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['SUM', 'AVG', 'COUNT'],
    interactions: { tooltip: true },
    fallbackType: 'PIVOT_TABLE',
    description: 'Quan sát mật độ hoặc cường độ dữ liệu trên ma trận giao nhau giữa 2 chiều phân loại.',
  },

  // ==========================================
  // GROUP G: Process & Flow
  // ==========================================
  FUNNEL: {
    id: 'FUNNEL',
    name: 'Biểu đồ Phễu Chuyển Đổi (Funnel Chart)',
    group: 'G_PROCESS',
    supportedShapes: ['SEQUENTIAL_STAGES'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['COUNT', 'SUM', 'CONVERSION_RATE'],
    interactions: { tooltip: true },
    fallbackType: 'HORIZONTAL_BAR',
    description: 'Theo dõi độ hao hụt và tỷ lệ chuyển đổi qua các giai đoạn quy trình (tuyển dụng, bán hàng, xử lý hồ sơ).',
  },
  SANKEY: {
    id: 'SANKEY',
    name: 'Biểu đồ Dòng Chuyển Dịch (Sankey Diagram)',
    group: 'G_PROCESS',
    supportedShapes: ['SOURCE_TARGET_FLOW'],
    minDimensions: 2,
    maxDimensions: 2,
    minMeasures: 1,
    maxMeasures: 1,
    supportedAggregations: ['SUM', 'COUNT'],
    interactions: { tooltip: true },
    fallbackType: 'BAR',
    description: 'Trực quan hóa luồng di chuyển từ nguồn tới đích kèm trọng số lưu lượng.',
  },

  // ==========================================
  // GROUP H: Multi-dimensional & Specialized
  // ==========================================
  RADAR: {
    id: 'RADAR',
    name: 'Biểu đồ Mạng Nhện (Radar Chart)',
    group: 'H_SPECIALIZED',
    supportedShapes: ['MULTI_AXIS_PROFILE'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 3,
    maxMeasures: 8,
    supportedAggregations: ['AVG', 'SCORE'],
    interactions: { tooltip: true, legendToggle: true },
    fallbackType: 'BAR',
    description: 'Đánh giá hồ sơ năng lực, điểm KPI đa tiêu chí của cá nhân hoặc đơn vị.',
  },
  PARETO: {
    id: 'PARETO',
    name: 'Biểu đồ Pareto (80/20 Analysis)',
    group: 'H_SPECIALIZED',
    supportedShapes: ['RANKED_CUMULATIVE'],
    minDimensions: 1,
    maxDimensions: 1,
    minMeasures: 1,
    maxMeasures: 2,
    supportedAggregations: ['SUM', 'COUNT', 'CUMULATIVE_PERCENT'],
    interactions: { tooltip: true },
    fallbackType: 'COMBO',
    description: 'Xác định 20% nguyên nhân cốt lõi tạo ra 80% kết quả/doanh thu/lỗi.',
  },
  PIVOT_TABLE: {
    id: 'PIVOT_TABLE',
    name: 'Bảng Tổng Hợp Chéo (Pivot Table)',
    group: 'H_SPECIALIZED',
    supportedShapes: ['CROSS_TAB_MATRIX'],
    minDimensions: 2,
    maxDimensions: 3,
    minMeasures: 1,
    maxMeasures: 3,
    supportedAggregations: ['SUM', 'AVG', 'COUNT'],
    interactions: { sorting: true, pagination: true },
    fallbackType: 'BAR',
    description: 'Bảng dữ liệu đa chiều hỗ trợ gom nhóm dòng và cột linh hoạt.',
  },
};

/**
 * All allowed chart types enum list for validation
 */
const ALL_CHART_TYPE_KEYS = Object.freeze(Object.keys(CHART_REGISTRY));

/**
 * Intelligent Chart Recommender
 * 
 * Rules-based engine scoring candidates by data profile, user intent, cardinality, and constraints.
 * 
 * @param {Object} context
 * @param {string} context.intent - Analytical intent (TREND, COMPARISON, COMPOSITION, DISTRIBUTION, RELATIONSHIP, FUNNEL, PARETO, etc.)
 * @param {Array} context.dimensions - Categorical dimensions available
 * @param {Array} context.measures - Numeric measures available
 * @param {number} context.cardinality - Number of unique categories in primary dimension
 * @param {boolean} context.hasTimeDimension - Whether date/time column is present
 * @param {boolean} context.hasNegativeValues - Whether data contains negative values
 * @param {string} [context.userPreference] - User explicitly asked chart type (e.g. 'PIE', 'LINE', 'RADAR')
 * @returns {{ recommendedType: string, confidence: number, reason: string, fallbackType: string }}
 */
function recommendChart(context = {}) {
  const {
    intent = 'COMPARISON',
    dimensions = [],
    measures = [],
    cardinality = 5,
    hasTimeDimension = false,
    hasNegativeValues = false,
    userPreference = null,
  } = context;

  // 1. Honor explicit valid user preference if data shape permits
  if (userPreference) {
    const prefUpper = String(userPreference).toUpperCase();
    const candidate = CHART_REGISTRY[prefUpper];
    if (candidate) {
      // Validate hard constraints
      if ((prefUpper === 'PIE' || prefUpper === 'DONUT') && measures.length > 1) {
        return {
          recommendedType: 'GROUPED_BAR',
          confidence: 0.95,
          reason: 'Biểu đồ tròn (Pie/Donut) chỉ áp dụng cho một chỉ tiêu thành phần phân bổ (part-to-whole). Không thể biểu diễn nhiều chỉ tiêu có bản chất đo lường khác nhau (như Tổng và Trung bình) trên cùng một biểu đồ tròn; tự động chuyển sang Biểu đồ Cột Nhóm (Grouped Bar Chart).',
          fallbackType: 'GROUPED_BAR',
        };
      }
      if ((prefUpper === 'PIE' || prefUpper === 'DONUT') && hasNegativeValues) {
        return {
          recommendedType: 'BAR',
          confidence: 0.95,
          reason: 'Người dùng yêu cầu biểu đồ tròn nhưng dữ liệu chứa giá trị âm, tự động chuyển sang Bar Chart chuẩn xác.',
          fallbackType: 'BAR',
        };
      }
      if ((prefUpper === 'PIE' || prefUpper === 'DONUT') && cardinality > 8) {
        return {
          recommendedType: 'BAR',
          confidence: 0.9,
          reason: 'Số lượng nhóm phân loại lớn (> 8), chuyển sang Bar Chart để tránh chồng chéo nhãn.',
          fallbackType: 'BAR',
        };
      }
      if (prefUpper === 'SCATTER' && measures.length < 2) {
        return {
          recommendedType: 'BAR',
          confidence: 0.85,
          reason: 'Biểu đồ phân tán yêu cầu tối thiểu 2 chỉ tiêu số, chuyển sang Bar Chart.',
          fallbackType: 'BAR',
        };
      }
      return {
        recommendedType: prefUpper,
        confidence: 0.98,
        reason: `Áp dụng đúng dạng biểu đồ ${candidate.name} theo yêu cầu người dùng.`,
        fallbackType: candidate.fallbackType,
      };
    }
  }

  // 2. Intelligent recommendation by Analytical Intent
  const normIntent = String(intent).toUpperCase();

  // Intent: TREND or TIME SERIES
  if (normIntent === 'TREND' || hasTimeDimension) {
    if (measures.length >= 2) {
      return {
        recommendedType: 'COMBO',
        confidence: 0.92,
        reason: 'Xu hướng theo thời gian với nhiều chỉ số: kết hợp Cột và Đường tối ưu đối chiếu.',
        fallbackType: 'LINE',
      };
    }
    return {
      recommendedType: 'LINE',
      confidence: 0.95,
      reason: 'Dữ liệu chuỗi thời gian phù hợp nhất với Line Chart để theo dõi biến động.',
      fallbackType: 'BAR',
    };
  }

  // Intent: COMPOSITION / PROPORTION
  if (normIntent === 'COMPOSITION' || normIntent === 'PART_TO_WHOLE') {
    if (!hasNegativeValues && cardinality <= 6) {
      return {
        recommendedType: 'DONUT',
        confidence: 0.94,
        reason: 'Cơ cấu phân bổ với số lượng danh mục ít (<= 6): Donut Chart tối ưu tính thẩm mỹ và trực quan.',
        fallbackType: 'BAR',
      };
    }
    if (!hasNegativeValues && cardinality > 6 && cardinality <= 25) {
      return {
        recommendedType: 'TREEMAP',
        confidence: 0.88,
        reason: 'Cơ cấu phân bổ nhiều nhóm: Treemap hiển thị đóng góp tỷ trọng không bị rối nhãn.',
        fallbackType: 'BAR',
      };
    }
    return {
      recommendedType: 'BAR',
      confidence: 0.9,
      reason: 'Cơ cấu nhiều nhóm hoặc có số âm: Horizontal Bar Chart rõ ràng nhất.',
      fallbackType: 'HORIZONTAL_BAR',
    };
  }

  // Intent: DISTRIBUTION
  if (normIntent === 'DISTRIBUTION') {
    if (dimensions.length >= 1 && measures.length >= 1) {
      return {
        recommendedType: 'BOXPLOT',
        confidence: 0.9,
        reason: 'Khảo sát phân phối giữa các nhóm: Box Plot phát hiện tứ phân vị và điểm bất thường.',
        fallbackType: 'HISTOGRAM',
      };
    }
    return {
      recommendedType: 'HISTOGRAM',
      confidence: 0.92,
      reason: 'Phân phối tần suất chỉ số liên tục qua các dải giá trị.',
      fallbackType: 'BAR',
    };
  }

  // Intent: RELATIONSHIP / CORRELATION
  if (normIntent === 'RELATIONSHIP' || normIntent === 'CORRELATION') {
    if (dimensions.length >= 2) {
      return {
        recommendedType: 'HEATMAP',
        confidence: 0.91,
        reason: 'Mối quan hệ giao nhau giữa 2 chiều phân loại: Heatmap thể hiện mật độ cường độ.',
        fallbackType: 'BAR',
      };
    }
    if (measures.length >= 3) {
      return {
        recommendedType: 'BUBBLE',
        confidence: 0.89,
        reason: 'Tương quan 3 chiều chỉ số định lượng: Bubble Chart hiển thị trục X, Y và quy mô Z.',
        fallbackType: 'SCATTER',
      };
    }
    return {
      recommendedType: 'SCATTER',
      confidence: 0.94,
      reason: 'Tương quan giữa 2 biến số định lượng: Scatter Plot làm rõ hệ số tương quan.',
      fallbackType: 'BAR',
    };
  }

  // Intent: PROCESS / FUNNEL
  if (normIntent === 'FUNNEL' || normIntent === 'PROCESS' || normIntent === 'CONVERSION') {
    return {
      recommendedType: 'FUNNEL',
      confidence: 0.95,
      reason: 'Quy trình tuần tự nhiều giai đoạn: Funnel Chart đo lường độ hao hụt và tỷ lệ chuyển đổi.',
      fallbackType: 'HORIZONTAL_BAR',
    };
  }

  // Intent: PARETO
  if (normIntent === 'PARETO') {
    return {
      recommendedType: 'PARETO',
      confidence: 0.96,
      reason: 'Phân tích quy luật 80/20: Pareto kết hợp cột độ lớn và đường tỷ lệ tích lũy.',
      fallbackType: 'COMBO',
    };
  }

  // Intent: MULTI-CRITERIA EVALUATION
  if (normIntent === 'EVALUATION' || normIntent === 'SKILLS' || (measures.length >= 4 && cardinality <= 5)) {
    return {
      recommendedType: 'RADAR',
      confidence: 0.88,
      reason: 'Đánh giá đa tiêu chí năng lực / KPI: Radar Chart tổng hợp cân đối các trục.',
      fallbackType: 'GROUPED_BAR',
    };
  }

  // Intent: RANKING / COMPARISON
  if (normIntent === 'RANKING' || cardinality > 10) {
    return {
      recommendedType: 'HORIZONTAL_BAR',
      confidence: 0.93,
      reason: 'Bảng xếp hạng Top N hoặc danh mục nhiều phần tử: Cột ngang dễ đọc tên danh mục.',
      fallbackType: 'BAR',
    };
  }

  // Default fallback for comparison
  return {
    recommendedType: 'BAR',
    confidence: 0.9,
    reason: 'So sánh tiêu chuẩn giữa các danh mục độc lập.',
    fallbackType: 'HORIZONTAL_BAR',
  };
}

/**
 * Validate Chart Mapping against Schema Constraints
 * @param {Object} vizConfig - Visualization contract item
 * @param {Array<Object>} rows - Target dataset rows
 * @returns {{ valid: boolean, errors: Array<string>, adjustedChartType?: string }}
 */
function validateChartMapping(vizConfig, rows = []) {
  const errors = [];
  let chartType = String(vizConfig.chart_type || 'BAR').toUpperCase();
  const spec = CHART_REGISTRY[chartType];

  if (!spec) {
    return {
      valid: false,
      errors: [`Loại biểu đồ "${chartType}" không có trong Chart Registry.`],
      adjustedChartType: 'BAR',
    };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { valid: true, adjustedChartType: chartType };
  }

  const mapping = vizConfig.mapping || {};
  const catKey = mapping.category || mapping.x || mapping.dimension;
  const valKey = mapping.value || mapping.y || mapping.metric;

  // Validation: PIE / DONUT negative values and multi-metric guard
  if (['PIE', 'DONUT', 'TREEMAP'].includes(chartType)) {
    if (Array.isArray(valKey) && valKey.length > 1) {
      return {
        valid: false,
        errors: [`Biểu đồ ${chartType} chỉ hỗ trợ một chỉ tiêu thành phần phân bổ (part-to-whole), không thể hiển thị đồng thời nhiều chỉ tiêu có bản chất khác nhau.`],
        adjustedChartType: 'GROUPED_BAR',
      };
    }
    const hasNegative = rows.some((r) => {
      const v = Number(r[valKey]);
      return Number.isFinite(v) && v < 0;
    });
    if (hasNegative) {
      return {
        valid: false,
        errors: [`Biểu đồ ${chartType} không thể hiển thị số âm.`],
        adjustedChartType: spec.fallbackType || 'BAR',
      };
    }
  }

  // Validation: SCATTER / BUBBLE numeric measure presence
  if (chartType === 'SCATTER') {
    const xKey = mapping.x || Object.keys(rows[0])[0];
    const yKey = mapping.y || Object.keys(rows[0])[1];
    const isXNumeric = rows.some((r) => Number.isFinite(Number(r[xKey])));
    const isYNumeric = rows.some((r) => Number.isFinite(Number(r[yKey])));
    if (!isXNumeric || !isYNumeric) {
      return {
        valid: false,
        errors: ['Biểu đồ Scatter yêu cầu cả trục X và trục Y đều là giá trị số.'],
        adjustedChartType: 'BAR',
      };
    }
  }

  return { valid: errors.length === 0, errors, adjustedChartType: chartType };
}

module.exports = {
  CHART_REGISTRY,
  ALL_CHART_TYPE_KEYS,
  ENTERPRISE_PALETTE,
  recommendChart,
  validateChartMapping,
};
