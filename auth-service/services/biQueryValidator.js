/**
 * SOTRANS HUB — BI QUERY VALIDATOR (PHASE 2.3)
 * 
 * Strict Query Plan Validation & Security Guard:
 * - Dataset existence & tenant access control via biDatasetRegistry
 * - Single dataset integrity (blocks cross-dataset or cross-tenant joins)
 * - Schema column existence verification
 * - Data type compatibility verification (SUM/AVG/MEDIAN only on numeric, date_trunc only on dates)
 * - Operation & function whitelisting (zero raw SQL or unvetted functions)
 * - Configurable resource boundaries (max rows, max groups, complexity limits)
 * - Anti-Prompt-Injection defense
 */

const { canUserAccessDataset } = require('./biDatasetRegistry');
const { credentialKey } = require('./biPrivacy');
const identifierKey = key => /citizenid|cccd|cmnd|sodienthoai|phone|email|bankaccount|sotaikhoan|^sdt$/.test(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''));

// Configurable resource limits
const MAX_LIMIT = parseInt(process.env.BI_QUERY_MAX_LIMIT, 10) || 500;
const MAX_GROUPS = parseInt(process.env.BI_QUERY_MAX_GROUPS, 10) || 1000;
const MAX_GROUP_BY_COLS = 3;
const MAX_AGGREGATIONS = 8;
const TIMEOUT_MS = parseInt(process.env.BI_QUERY_TIMEOUT_MS, 10) || 3000;

const ALLOWED_FUNCTIONS = Object.freeze([
  'COUNT',
  'COUNT_ROWS',
  'COUNT_NON_NULL',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'MEDIAN',
  'DISTINCT_COUNT',
]);

const ALLOWED_OPERATORS = Object.freeze([
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'between',
  'is_null',
  'not_null',
]);

const ALLOWED_DATE_TRUNC = Object.freeze(['day', 'month', 'quarter', 'year']);
const ALLOWED_COMPUTATIONS = Object.freeze(['PERCENTAGE', 'GROWTH_RATE']);

// SQL keywords to block in any custom field
const SQL_INJECTION_PATTERN = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|EXECUTE|GRANT|REVOKE|TRUNCATE)\b/i;

class QueryValidationError extends Error {
  constructor(message, code = 'QUERY_VALIDATION_ERROR', status = 400) {
    super(message);
    this.name = 'QueryValidationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Validate Analytical Query Plan
 * @param {Object} queryPlan - Output of biQueryPlanner
 * @param {Object} dataset - Stored dataset with metadata and profile/columns
 * @param {Object} userContext - Authenticated user context from verified JWT
 * @returns {Object} Validated & sanitized query plan
 */
function validateQueryPlan(queryPlan, dataset, userContext) {
  // 1. Authenticate & Verify Tenant Access
  if (!userContext || !userContext.user_id) {
    throw new QueryValidationError('Yêu cầu đăng nhập để truy vấn dữ liệu.', 'UNAUTHENTICATED', 401);
  }

  if (!dataset) {
    throw new QueryValidationError('Bộ dữ liệu không tồn tại hoặc đã hết hạn.', 'DATASET_NOT_FOUND', 404);
  }

  const access = canUserAccessDataset(dataset, userContext, 'query');
  if (!access.allowed) {
    throw new QueryValidationError(access.reason || 'Quyền truy cập bị từ chối.', 'FORBIDDEN', 403);
  }

  // 2. Validate Single Dataset & Null/Shape
  if (!queryPlan || typeof queryPlan !== 'object') {
    throw new QueryValidationError('Kế hoạch truy vấn không hợp lệ.', 'INVALID_QUERY_PLAN');
  }

  // Handle clarification_needed from Query Planner gracefully
  if (queryPlan.clarification_needed) {
    return {
      file_id: dataset.file_id,
      target_sheet: queryPlan.target_sheet || dataset.profile?.active_sheet || 'Sheet1',
      groupBy: [],
      aggregations: [],
      filters: [],
      computations: [],
      period_comparison: null,
      orderBy: { column: 'value', dir: 'DESC' },
      limit: 20,
      chart_preference: 'BAR',
      clarification_needed: true,
      clarification_question: queryPlan.clarification_question,
      max_groups: MAX_GROUPS,
      timeout_ms: TIMEOUT_MS,
    };
  }

  if (queryPlan.datasets && Array.isArray(queryPlan.datasets) && queryPlan.datasets.length > 1) {
    throw new QueryValidationError(
      'Hệ thống hiện tại chỉ cho phép truy vấn đơn bộ dữ liệu (cấm join chéo dataset hoặc chéo tenant).',
      'MULTI_DATASET_JOIN_BLOCKED',
      400
    );
  }

  // Build Column Lookup Map
  const requestedSheet = queryPlan.target_sheet || dataset.profile?.active_sheet;
  if (requestedSheet && requestedSheet !== dataset.profile?.active_sheet) throw new QueryValidationError('Cần chọn schema của sheet trước khi xác thực query.', 'SHEET_SCHEMA_MISMATCH');
  const columns = (dataset.columns || dataset.profile?.columns || []).filter(c => !credentialKey(c.key || c.name));
  if (columns.length === 0) {
    throw new QueryValidationError('Bộ dữ liệu không chứa danh sách cột hợp lệ.', 'DATASET_CORRUPTED');
  }

  const colMap = new Map();
  for (const c of columns) {
    colMap.set(c.key, c);
    colMap.set(c.name, c);
  }

  // 3. Validate Group By
  const groupBy = queryPlan.groupBy || [];
  if (!Array.isArray(groupBy)) {
    throw new QueryValidationError('Cấu hình gom nhóm (groupBy) phải là một mảng.', 'INVALID_GROUP_BY');
  }

  if (groupBy.length > MAX_GROUP_BY_COLS) {
    throw new QueryValidationError(
      `Số lượng cột gom nhóm (${groupBy.length}) vượt quá giới hạn tối đa cho phép (${MAX_GROUP_BY_COLS}).`,
      'MAX_GROUP_BY_EXCEEDED'
    );
  }

  const validatedGroupBy = [];
  for (const item of groupBy) {
    let colKey = typeof item === 'string' ? item : item.column;
    let dateTrunc = typeof item === 'object' ? item.date_trunc : null;

    if (!colKey || typeof colKey !== 'string') {
      throw new QueryValidationError('Tên cột gom nhóm không hợp lệ.', 'INVALID_COLUMN_NAME');
    }

    if (SQL_INJECTION_PATTERN.test(colKey)) {
      throw new QueryValidationError('Phát hiện chuỗi SQL không hợp lệ trong tên cột gom nhóm.', 'SQL_INJECTION_DETECTED');
    }

    const colMeta = colMap.get(colKey);
    if (!colMeta) {
      throw new QueryValidationError(
        `Cột gom nhóm "${colKey}" không tồn tại trong bộ dữ liệu này.`,
        'COLUMN_NOT_FOUND'
      );
    }

    // Check date_trunc type compatibility
    if (dateTrunc) {
      const lowerTrunc = String(dateTrunc).toLowerCase();
      if (!ALLOWED_DATE_TRUNC.includes(lowerTrunc)) {
        throw new QueryValidationError(
          `Chu kỳ thời gian "${dateTrunc}" không hợp lệ. Chỉ chấp nhận: ${ALLOWED_DATE_TRUNC.join(', ')}.`,
          'INVALID_DATE_TRUNC'
        );
      }
      if (colMeta.type !== 'DATE' && colMeta.type !== 'DATETIME') {
        throw new QueryValidationError(
          `Cột "${colMeta.name}" có kiểu ${colMeta.type}, không thể áp dụng gom nhóm theo thời gian (date_trunc). Chỉ cột kiểu DATE hoặc DATETIME mới được hỗ trợ.`,
          'INVALID_COLUMN_TYPE'
        );
      }
      validatedGroupBy.push({ column: colMeta.key, date_trunc: lowerTrunc });
    } else {
      validatedGroupBy.push(colMeta.key);
    }
  }

  // 3.1 Semantic Guard: GroupBy Identifier vs Dimension Conflict Protection
  // If groupBy contains an entity identifier (e.g. ma_nhan_vien, id) AND a categorical dimension (e.g. phong_ban, cong_ty),
  // and explicit_individual_grouping is not true:
  // Sanitize groupBy by removing the identifier so that grouping summarizes at the dimension level.
  if (validatedGroupBy.length > 1 && !queryPlan.explicit_individual_grouping) {
    const isIdCol = (key) => {
      const k = String(key || '').toLowerCase();
      return k === 'id' || k.startsWith('ma_') || k.endsWith('_id') || k.includes('employee_id') || k.includes('nhan_vien_id') || k.includes('cccd');
    };
    const hasDimension = validatedGroupBy.some((g) => {
      const k = typeof g === 'string' ? g : g.column;
      return !isIdCol(k);
    });
    const hasIdentifier = validatedGroupBy.some((g) => {
      const k = typeof g === 'string' ? g : g.column;
      return isIdCol(k);
    });

    if (hasDimension && hasIdentifier) {
      validatedGroupBy = validatedGroupBy.filter((g) => {
        const k = typeof g === 'string' ? g : g.column;
        return !isIdCol(k);
      });
    }
  }

  // 4. Validate Aggregations
  const aggregations = queryPlan.aggregations || [];
  if ((!Array.isArray(aggregations) || aggregations.length === 0) && queryPlan.intent !== 'FILTER') {
    // If no aggregations defined, default to COUNT
    aggregations.push({
      column: columns[0].key,
      func: 'COUNT',
      alias: `count_${columns[0].key}`,
    });
  }

  if (aggregations.length > MAX_AGGREGATIONS) {
    throw new QueryValidationError(
      `Số lượng phép tính tổng hợp (${aggregations.length}) vượt quá giới hạn tối đa (${MAX_AGGREGATIONS}).`,
      'MAX_AGGREGATIONS_EXCEEDED'
    );
  }

  const validatedAggs = [];
  const definedAliases = new Set();

  for (const agg of aggregations) {
    if (!agg || typeof agg !== 'object') {
      throw new QueryValidationError('Phép tính tổng hợp không hợp lệ.', 'INVALID_AGGREGATION');
    }

    const colKey = agg.column;
    const func = String(agg.func || 'SUM').toUpperCase();
    const alias = agg.alias || `${func.toLowerCase()}_${colKey}`;

    if (!colKey || typeof colKey !== 'string') {
      throw new QueryValidationError('Cột thực hiện phép tính không hợp lệ.', 'INVALID_COLUMN_NAME');
    }

    if (SQL_INJECTION_PATTERN.test(colKey) || SQL_INJECTION_PATTERN.test(alias)) {
      throw new QueryValidationError('Phát hiện chuỗi SQL nguy hiểm trong định danh phép tính.', 'SQL_INJECTION_DETECTED');
    }

    if (!ALLOWED_FUNCTIONS.includes(func)) {
      throw new QueryValidationError(
        `Hàm tổng hợp "${func}" không được hỗ trợ. Chỉ cho phép: ${ALLOWED_FUNCTIONS.join(', ')}.`,
        'UNSUPPORTED_FUNCTION'
      );
    }

    if (colKey === '*' && ['COUNT', 'COUNT_ROWS'].includes(func)) {
      validatedAggs.push({
        column: '*',
        func: 'COUNT',
        alias: alias || 'count_rows',
      });
      definedAliases.add(alias || 'count_rows');
      continue;
    }

    const colMeta = colMap.get(colKey);
    if (!colMeta) {
      throw new QueryValidationError(
        `Cột thực hiện tính toán "${colKey}" không tồn tại trong bộ dữ liệu này.`,
        'COLUMN_NOT_FOUND'
      );
    }

    if (identifierKey(colMeta.key) && !['COUNT', 'DISTINCT_COUNT'].includes(func)) {
      throw new QueryValidationError('Chỉ hỗ trợ đếm dữ liệu định danh cá nhân.', 'PERSONAL_IDENTIFIER_AGGREGATION');
    }

    // Mathematical type compatibility check
    if (['SUM', 'AVG', 'MEDIAN'].includes(func)) {
      if (colMeta.type !== 'INTEGER' && colMeta.type !== 'FLOAT') {
        throw new QueryValidationError(
          `Không thể thực hiện phép tính ${func} trên cột "${colMeta.name}" vì cột này có kiểu dữ liệu là ${colMeta.type}. Phép tính số học chỉ áp dụng cho cột kiểu INTEGER hoặc FLOAT.`,
          'INVALID_COLUMN_TYPE'
        );
      }
    }

    validatedAggs.push({
      column: colMeta.key,
      func,
      alias,
    });
    definedAliases.add(alias);
  }

  // 5. Validate Filters
  const filters = queryPlan.filters || [];
  if (!Array.isArray(filters)) {
    throw new QueryValidationError('Bộ lọc (filters) phải là một mảng.', 'INVALID_FILTERS');
  }

  const validatedFilters = [];
  for (const f of filters) {
    if (!f || typeof f !== 'object') continue;
    const colKey = f.column;
    const op = String(f.op || 'eq').toLowerCase();

    const colMeta = colMap.get(colKey);
    if (!colMeta) {
      throw new QueryValidationError(
        `Cột lọc "${colKey}" không tồn tại trong bộ dữ liệu này.`,
        'COLUMN_NOT_FOUND'
      );
    }

    if (!ALLOWED_OPERATORS.includes(op)) {
      throw new QueryValidationError(
        `Toán tử lọc "${op}" không hợp lệ. Chỉ cho phép: ${ALLOWED_OPERATORS.join(', ')}.`,
        'UNSUPPORTED_OPERATOR'
      );
    }

    if (SQL_INJECTION_PATTERN.test(String(f.value))) {
      throw new QueryValidationError('Phát hiện mẫu SQL Injection trong giá trị bộ lọc.', 'SQL_INJECTION_DETECTED');
    }

    if (['DATE', 'DATETIME'].includes(colMeta.type) && ['gt', 'gte', 'lt', 'lte', 'between'].includes(op)) {
      const values = op === 'between' ? f.value : [f.value];
      if (!Array.isArray(values) || (op === 'between' && values.length !== 2) || values.some(v => typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v.slice(0, 10))) {
        throw new QueryValidationError('Giá trị lọc ngày không hợp lệ.', 'INVALID_DATE_FILTER');
      }
    }
    validatedFilters.push({
      column: colMeta.key,
      op,
      value: f.value,
    });
  }

  // 6. Validate Computations
  const computations = queryPlan.computations || [];
  const validatedComputations = [];
  for (const comp of computations) {
    const type = String(comp.type || '').toUpperCase();
    if (!ALLOWED_COMPUTATIONS.includes(type)) {
      throw new QueryValidationError(`Phép tính nâng cao "${type}" không được hỗ trợ.`, 'UNSUPPORTED_COMPUTATION');
    }
    validatedComputations.push({
      type,
      source_alias: comp.source_alias,
      target_alias: comp.target_alias || `${comp.source_alias}_${type.toLowerCase()}`,
    });
  }

  // 7. Validate Order By & Limit
  let orderBy = queryPlan.orderBy || null;
  if (orderBy) {
    const orderCol = orderBy.column;
    const orderDir = String(orderBy.dir || 'DESC').toUpperCase();

    // Must be either an existing column or a defined alias
    if (!colMap.has(orderCol) && !definedAliases.has(orderCol)) {
      // Fallback to first aggregation alias or first column
      orderBy.column = validatedAggs[0]?.alias || columns[0].key;
    }
    orderBy.dir = orderDir === 'ASC' ? 'ASC' : 'DESC';
  } else if (validatedGroupBy.some(g => typeof g === 'object' && g.date_trunc)) {
    const dateG = validatedGroupBy.find(g => typeof g === 'object' && g.date_trunc);
    orderBy = { column: dateG.column, dir: 'ASC' };
  } else if (validatedAggs.length > 0) {
    orderBy = { column: validatedAggs[0].alias, dir: 'DESC' };
  } else {
    orderBy = null;
  }

  let limit = queryPlan.limit ? parseInt(queryPlan.limit, 10) : 50;
  if (isNaN(limit) || limit <= 0) limit = 50;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // Pie chart guard: fallback to BAR if grouping cardinality is too high for a readable pie chart
  let chartPreference = queryPlan.chart_preference || 'BAR';
  if (chartPreference === 'PIE' && validatedGroupBy.length > 0) {
    const primaryColKey = typeof validatedGroupBy[0] === 'string' ? validatedGroupBy[0] : validatedGroupBy[0].column;
    const colMeta = colMap.get(primaryColKey);
    if (colMeta && colMeta.cardinality > 25) {
      chartPreference = 'BAR';
    }
  }

  return {
    file_id: dataset.file_id,
    target_sheet: queryPlan.target_sheet || dataset.profile?.active_sheet || 'Sheet1',
    intent: queryPlan.intent || 'AGGREGATION',
    groupBy: validatedGroupBy,
    aggregations: validatedAggs,
    filters: validatedFilters,
    computations: validatedComputations,
    period_comparison: queryPlan.period_comparison || null,
    having: queryPlan.having || null,
    orderBy,
    limit,
    chart_preference: chartPreference,
    has_pie_and_bar: Boolean(queryPlan.has_pie_and_bar),
    percentage_basis: queryPlan.percentage_basis || null,
    max_groups: MAX_GROUPS,
    timeout_ms: TIMEOUT_MS,
  };
}

module.exports = {
  validateQueryPlan,
  QueryValidationError,
  MAX_LIMIT,
  MAX_GROUPS,
  MAX_GROUP_BY_COLS,
  MAX_AGGREGATIONS,
  TIMEOUT_MS,
  ALLOWED_FUNCTIONS,
  ALLOWED_OPERATORS,
  ALLOWED_DATE_TRUNC,
};
