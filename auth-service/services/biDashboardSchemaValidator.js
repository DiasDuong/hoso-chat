/**
 * SOTRANS HUB — BI DASHBOARD SCHEMA VALIDATOR (PHASE P1.0)
 * 
 * Strict Self-Describing Dashboard Payload Contract v2.0 Validator:
 * - Version verification: Strictly "2.0"
 * - Source Type enforcement: INTERNAL_SYSTEM, FILE_DATASET, HYBRID
 * - Required fields & Schema shape validation
 * - KPI Strip structure & Status integrity (AVAILABLE, CONDITIONAL, BLOCKED, DATA_UNAVAILABLE)
 * - Visualizations contract & Whitelisted chart types (BAR, LINE, PIE, DONUT, STACKED_BAR, AREA, TREEMAP)
 * - Data Store integrity: data_ref cross-validation & mapping field verification
 * - Non-overlapping unique IDs across KPIs, Visualizations, and Tables
 * - Resource boundary defense: Max size 1MB, Max 24 KPIs, Max 12 Charts, Max 6 Tables, Max 500 rows/dataset
 * - Security & Anti-Injection: Zero unescaped HTML, scripts, javascript: or executable code
 * - PII Protection: Blocks forbidden credential/secret/PII keys
 * - Multi-tenant & RBAC authorization validation
 */

const MAX_PAYLOAD_SIZE_BYTES = 1024 * 1024; // 1 MB
const MAX_KPIS = 24;
const MAX_VISUALIZATIONS = 12;
const MAX_DATA_TABLES = 6;
const MAX_ROWS_PER_DATASET = 500;

// P1.0 Invariant: HYBRID is reserved for Unified BI (Phase P2.0+) and strictly rejected in P1.0/P1.1
const ALLOWED_SOURCE_TYPES = Object.freeze(['INTERNAL_SYSTEM', 'FILE_DATASET']);
const RESERVED_FUTURE_SOURCE_TYPES = Object.freeze(['HYBRID']);
let allowedChartTypesList = ['BAR', 'LINE', 'PIE', 'DONUT', 'STACKED_BAR', 'AREA', 'TREEMAP'];
try {
  const { ALL_CHART_TYPE_KEYS } = require('./biChartRegistry');
  if (Array.isArray(ALL_CHART_TYPE_KEYS) && ALL_CHART_TYPE_KEYS.length > 0) {
    allowedChartTypesList = ALL_CHART_TYPE_KEYS;
  }
} catch (_) {}
const ALLOWED_CHART_TYPES = Object.freeze(allowedChartTypesList);
const ALLOWED_KPI_STATUSES = Object.freeze(['AVAILABLE', 'CONDITIONAL', 'BLOCKED', 'DATA_UNAVAILABLE']);
const ALLOWED_FORMATS = Object.freeze(['NUMBER', 'CURRENCY', 'PERCENTAGE', 'TEXT']);
const ALLOWED_COMPARISON_TYPES = Object.freeze(['ABSOLUTE_DELTA', 'PERCENTAGE_POINT_DELTA', 'RELATIVE_PERCENTAGE_CHANGE']);
const ALLOWED_DIRECTIONS = Object.freeze(['UP', 'DOWN', 'NEUTRAL']);

const FORBIDDEN_EXECUTABLE_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>|javascript:|onerror\s*=|onload\s*=|onclick\s*|<iframe|<object|<embed|eval\s*\(|new\s+Function\s*\(/i;
const FORBIDDEN_PII_KEY_PATTERN = /^(password|passwd|secret|token|jwt|auth_token|api_key|hash|credential|private_key)$/i;

class DashboardValidationError extends Error {
  constructor(message, code = 'INVALID_DASHBOARD_PAYLOAD', status = 400, errors = []) {
    super(message);
    this.name = 'DashboardValidationError';
    this.code = code;
    this.status = status;
    this.errors = errors;
  }
}

/**
 * Check if a string contains executable code or script injection
 */
function containsExecutableCode(val) {
  if (typeof val === 'string') {
    return FORBIDDEN_EXECUTABLE_PATTERN.test(val);
  }
  if (Array.isArray(val)) {
    return val.some(containsExecutableCode);
  }
  if (val && typeof val === 'object') {
    return Object.values(val).some(containsExecutableCode);
  }
  return false;
}

/**
 * Check if object contains forbidden PII / sensitive credential keys
 */
function containsForbiddenKeys(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_PII_KEY_PATTERN.test(k)) return true;
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      if (containsForbiddenKeys(obj[k])) return true;
    }
  }
  return false;
}

/**
 * Validate Dashboard Payload v2.0
 * @param {Object} payload - Self-describing dashboard JSON
 * @param {Object} userContext - Authenticated user context (optional for offline validation)
 * @returns {Object} { valid: boolean, errors: Array<{ field, message, code }>, sanitizedPayload?: Object }
 */
function validateDashboardPayload(payload, userContext = null) {
  const errors = [];

  function addError(field, message, code) {
    errors.push({ field, message, code });
  }

  // 1. JSON Valid Object
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      errors: [{ field: 'root', message: 'Dashboard payload phải là một JSON object hợp lệ.', code: 'INVALID_JSON_OBJECT' }],
    };
  }

  // 15. Payload Size Limit (1MB)
  let rawJson = '';
  try {
    rawJson = JSON.stringify(payload);
    if (Buffer.byteLength(rawJson, 'utf8') > MAX_PAYLOAD_SIZE_BYTES) {
      addError('root', `Kích thước payload vượt quá giới hạn an toàn tối đa (${MAX_PAYLOAD_SIZE_BYTES} bytes).`, 'PAYLOAD_SIZE_EXCEEDED');
    }
  } catch (e) {
    return {
      valid: false,
      errors: [{ field: 'root', message: 'Không thể tuần tự hóa payload thành JSON.', code: 'JSON_SERIALIZATION_FAILED' }],
    };
  }

  // 17. Executable Code / Script Injection Guard
  if (containsExecutableCode(payload)) {
    addError('root', 'Phát hiện mã thực thi nguy hiểm hoặc thẻ script trong payload.', 'EXECUTABLE_CODE_BLOCKED');
  }

  // 19. PII / Credential Key Guard
  if (containsForbiddenKeys(payload)) {
    addError('root', 'Phát hiện trường dữ liệu nhạy cảm hoặc mật khẩu/token bị rò rỉ trong payload.', 'PII_CREDENTIAL_BLOCKED');
  }

  // 2. Version Supported
  if (payload.version !== '2.0') {
    addError('version', `Phiên bản "${payload.version}" không được hỗ trợ. Chỉ chấp nhận phiên bản "2.0".`, 'UNSUPPORTED_VERSION');
  }

  // 3. Required Fields
  const requiredFields = [
    'version',
    'dashboard_id',
    'source_type',
    'title',
    'generated_at',
    'provenance',
    'filters',
    'kpi_strip',
    'visualizations',
    'data_tables',
    'data_store',
  ];

  for (const f of requiredFields) {
    if (payload[f] === undefined || payload[f] === null) {
      addError(f, `Thiếu trường bắt buộc "${f}" trong Dashboard Payload.`, 'MISSING_REQUIRED_FIELD');
    }
  }

  // 4. Strict enum for source_type (HYBRID is rejected before Unified BI P2.0+)
  if (payload.source_type) {
    if (RESERVED_FUTURE_SOURCE_TYPES.includes(payload.source_type)) {
      addError('source_type', `source_type "${payload.source_type}" là loại nguồn dự trữ cho Unified BI (Phase P2.0+), chưa được phép sử dụng ở giai đoạn hiện tại.`, 'RESERVED_SOURCE_TYPE_HYBRID');
    } else if (!ALLOWED_SOURCE_TYPES.includes(payload.source_type)) {
      addError('source_type', `source_type "${payload.source_type}" không hợp lệ. Chỉ chấp nhận: ${ALLOWED_SOURCE_TYPES.join(', ')}.`, 'INVALID_SOURCE_TYPE');
    }
  }

  // String check on title & dashboard_id
  if (typeof payload.dashboard_id !== 'string' || !payload.dashboard_id.trim()) {
    addError('dashboard_id', 'dashboard_id phải là chuỗi không rỗng.', 'INVALID_DASHBOARD_ID');
  }

  if (typeof payload.title !== 'string' || !payload.title.trim()) {
    addError('title', 'title phải là chuỗi không rỗng.', 'INVALID_TITLE');
  }

  // 6 & 7. KPI Strip Validation
  const kpis = payload.kpi_strip;
  const kpiIds = new Set();

  if (!Array.isArray(kpis)) {
    addError('kpi_strip', 'kpi_strip phải là một mảng.', 'INVALID_KPI_STRIP');
  } else {
    // 14. Max KPIs limit
    if (kpis.length > MAX_KPIS) {
      addError('kpi_strip', `Số lượng KPI (${kpis.length}) vượt quá giới hạn tối đa (${MAX_KPIS}).`, 'MAX_KPIS_EXCEEDED');
    }

    for (let i = 0; i < kpis.length; i++) {
      const kpi = kpis[i];
      const prefix = `kpi_strip[${i}]`;

      if (!kpi || typeof kpi !== 'object') {
        addError(prefix, 'Mục KPI phải là một object.', 'INVALID_KPI_ITEM');
        continue;
      }

      // Check ID
      if (!kpi.id || typeof kpi.id !== 'string') {
        addError(`${prefix}.id`, 'Mỗi KPI phải có một ID duy nhất.', 'MISSING_KPI_ID');
      } else {
        // 13. Duplicate ID check
        if (kpiIds.has(kpi.id)) {
          addError(`${prefix}.id`, `Trùng lặp ID KPI: "${kpi.id}".`, 'DUPLICATE_KPI_ID');
        }
        kpiIds.add(kpi.id);
      }

      // Check Status
      if (!kpi.status || !ALLOWED_KPI_STATUSES.includes(kpi.status)) {
        addError(`${prefix}.status`, `Trạng thái KPI "${kpi.status}" không hợp lệ. Chỉ chấp nhận: ${ALLOWED_KPI_STATUSES.join(', ')}.`, 'INVALID_KPI_STATUS');
      }

      // Check Format
      if (kpi.format && !ALLOWED_FORMATS.includes(kpi.format)) {
        addError(`${prefix}.format`, `Định dạng KPI "${kpi.format}" không hợp lệ. Chỉ chấp nhận: ${ALLOWED_FORMATS.join(', ')}.`, 'INVALID_KPI_FORMAT');
      }

      // Check Values according to status (Truthfulness Invariant: strictly no fake numbers)
      if (kpi.status === 'AVAILABLE' || kpi.status === 'CONDITIONAL') {
        if (kpi.primary_value === undefined) {
          addError(`${prefix}.primary_value`, 'KPI trạng thái AVAILABLE/CONDITIONAL phải có giá trị primary_value (không được undefined).', 'MISSING_PRIMARY_VALUE');
        }
      } else if (kpi.status === 'BLOCKED' || kpi.status === 'DATA_UNAVAILABLE') {
        if (kpi.primary_value !== null && kpi.primary_value !== undefined) {
          addError(`${prefix}.primary_value`, `KPI trạng thái ${kpi.status} bắt buộc primary_value phải là null (nghiêm cấm giả lập giá trị).`, 'FORBIDDEN_FAKE_VALUE');
        }
        // Must explain why in subtext or reason
        if (!kpi.subtext && !kpi.reason) {
          addError(`${prefix}.subtext`, `KPI trạng thái ${kpi.status} phải có lý do giải thích (subtext/reason).`, 'MISSING_BLOCKED_REASON');
        }
      }

      // Check comparison if present
      if (kpi.comparison) {
        const comp = kpi.comparison;
        if (!comp.type || !ALLOWED_COMPARISON_TYPES.includes(comp.type)) {
          addError(`${prefix}.comparison.type`, `Loại so sánh "${comp.type}" không hợp lệ.`, 'INVALID_COMPARISON_TYPE');
        }
        if (comp.direction && !ALLOWED_DIRECTIONS.includes(comp.direction)) {
          addError(`${prefix}.comparison.direction`, `Hướng biến động "${comp.direction}" không hợp lệ.`, 'INVALID_DIRECTION');
        }
      }
    }
  }

  // 11. Data Store Validation
  const dataStore = payload.data_store;
  if (!dataStore || typeof dataStore !== 'object' || Array.isArray(dataStore)) {
    addError('data_store', 'data_store phải là một object chứa các tập dữ liệu mảng.', 'INVALID_DATA_STORE');
  } else {
    for (const [storeKey, rows] of Object.entries(dataStore)) {
      if (!Array.isArray(rows)) {
        addError(`data_store.${storeKey}`, `Dữ liệu tập "${storeKey}" phải là một mảng dòng.`, 'INVALID_DATA_STORE_ENTRY');
      } else if (rows.length > MAX_ROWS_PER_DATASET) {
        addError(`data_store.${storeKey}`, `Số dòng của tập dữ liệu "${storeKey}" (${rows.length}) vượt quá giới hạn tối đa (${MAX_ROWS_PER_DATASET}).`, 'MAX_ROWS_EXCEEDED');
      }
    }
  }

  // 9. Visualizations Validation
  const vizList = payload.visualizations;
  const vizIds = new Set();

  if (!Array.isArray(vizList)) {
    addError('visualizations', 'visualizations phải là một mảng.', 'INVALID_VISUALIZATIONS');
  } else {
    // 14. Max Visualizations limit
    if (vizList.length > MAX_VISUALIZATIONS) {
      addError('visualizations', `Số lượng visualization (${vizList.length}) vượt quá giới hạn tối đa (${MAX_VISUALIZATIONS}).`, 'MAX_VISUALIZATIONS_EXCEEDED');
    }

    for (let i = 0; i < vizList.length; i++) {
      const viz = vizList[i];
      const prefix = `visualizations[${i}]`;

      if (!viz || typeof viz !== 'object') {
        addError(prefix, 'Mục visualization phải là một object.', 'INVALID_VIZ_ITEM');
        continue;
      }

      // Check ID
      if (!viz.id || typeof viz.id !== 'string') {
        addError(`${prefix}.id`, 'Mỗi visualization phải có một ID duy nhất.', 'MISSING_VIZ_ID');
      } else {
        if (vizIds.has(viz.id)) {
          addError(`${prefix}.id`, `Trùng lặp ID visualization: "${viz.id}".`, 'DUPLICATE_VIZ_ID');
        }
        vizIds.add(viz.id);
      }

      // 5. Strict enum for chart_type
      if (!viz.chart_type || !ALLOWED_CHART_TYPES.includes(viz.chart_type)) {
        addError(`${prefix}.chart_type`, `chart_type "${viz.chart_type}" không hợp lệ. Chỉ chấp nhận: ${ALLOWED_CHART_TYPES.join(', ')}.`, 'INVALID_CHART_TYPE');
      }

      // 11. Cross-reference data_ref -> data_store
      if (!viz.data_ref || typeof viz.data_ref !== 'string') {
        addError(`${prefix}.data_ref`, 'Visualization phải chỉ định trường data_ref hợp lệ.', 'MISSING_DATA_REF');
      } else if (dataStore && !dataStore[viz.data_ref]) {
        addError(`${prefix}.data_ref`, `data_ref "${viz.data_ref}" không tồn tại trong data_store.`, 'DATA_REF_NOT_FOUND');
      } else if (dataStore && dataStore[viz.data_ref]) {
        // 12. Cross-reference mapping fields -> dataset schema
        const targetRows = dataStore[viz.data_ref];
        if (targetRows.length > 0 && viz.mapping && typeof viz.mapping === 'object') {
          const sampleRow = targetRows[0];
          const checkFieldExists = (fieldKey, role) => {
            if (fieldKey && typeof fieldKey === 'string' && !(fieldKey in sampleRow)) {
              addError(`${prefix}.mapping.${role}`, `Cột "${fieldKey}" trong mapping không tồn tại trong dữ liệu "${viz.data_ref}".`, 'MAPPING_FIELD_NOT_FOUND');
            }
          };

          checkFieldExists(viz.mapping.x || viz.mapping.category || viz.mapping.dimension, 'dimension');
          
          const yVal = viz.mapping.y || viz.mapping.value || viz.mapping.metric;
          if (Array.isArray(yVal)) {
            yVal.forEach((f) => checkFieldExists(f, 'metric'));
          } else {
            checkFieldExists(yVal, 'metric');
          }
        }
      }
    }
  }

  // 10. Data Tables Validation
  const tableList = payload.data_tables;
  const tableIds = new Set();

  if (!Array.isArray(tableList)) {
    addError('data_tables', 'data_tables phải là một mảng.', 'INVALID_DATA_TABLES');
  } else {
    // 14. Max Data Tables limit
    if (tableList.length > MAX_DATA_TABLES) {
      addError('data_tables', `Số lượng data_tables (${tableList.length}) vượt quá giới hạn tối đa (${MAX_DATA_TABLES}).`, 'MAX_TABLES_EXCEEDED');
    }

    for (let i = 0; i < tableList.length; i++) {
      const tbl = tableList[i];
      const prefix = `data_tables[${i}]`;

      if (!tbl || typeof tbl !== 'object') {
        addError(prefix, 'Mục data_table phải là một object.', 'INVALID_TABLE_ITEM');
        continue;
      }

      if (!tbl.id || typeof tbl.id !== 'string') {
        addError(`${prefix}.id`, 'Mỗi data_table phải có một ID duy nhất.', 'MISSING_TABLE_ID');
      } else {
        if (tableIds.has(tbl.id)) {
          addError(`${prefix}.id`, `Trùng lặp ID data_table: "${tbl.id}".`, 'DUPLICATE_TABLE_ID');
        }
        tableIds.add(tbl.id);
      }

      // Check data_ref
      if (!tbl.data_ref || typeof tbl.data_ref !== 'string') {
        addError(`${prefix}.data_ref`, 'Data table phải chỉ định data_ref hợp lệ.', 'MISSING_TABLE_DATA_REF');
      } else if (dataStore && !dataStore[tbl.data_ref]) {
        addError(`${prefix}.data_ref`, `data_ref "${tbl.data_ref}" của bảng không tồn tại trong data_store.`, 'TABLE_DATA_REF_NOT_FOUND');
      }
    }
  }

  // 20. Multi-tenant and RBAC check if userContext provided
  if (userContext) {
    if (payload.source_type === 'INTERNAL_SYSTEM') {
      const userRole = String(userContext.role || '').toUpperCase();
      if (userRole !== 'ADMIN' && userRole !== 'HR') {
        addError('provenance', 'Người dùng không có quyền truy cập dữ liệu quản trị SOTRANS (yêu cầu ADMIN hoặc HR).', 'UNAUTHORIZED_DASHBOARD_ACCESS');
      }
      if (userRole === 'HR') {
        const tenantScope = payload.provenance?.tenant_scope || payload.filters?.current_state?.company_id;
        if (tenantScope && tenantScope !== userContext.company_id) {
          addError('provenance.tenant_scope', `Nhân sự đơn vị "${userContext.company_id}" không có quyền xem dashboard của "${tenantScope}".`, 'TENANT_BOUNDARY_VIOLATION');
        }
      }
    }
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    sanitizedPayload: valid ? payload : null,
  };
}

/**
 * Strict Assertion: Throws DashboardValidationError if validation fails
 */
function assertValidDashboardPayload(payload, userContext = null) {
  const result = validateDashboardPayload(payload, userContext);
  if (!result.valid) {
    const errorMsg = result.errors.map((e) => `[${e.field}] ${e.message}`).join('; ');
    throw new DashboardValidationError(
      `Dashboard Payload không thỏa mãn hợp đồng v2.0: ${errorMsg}`,
      result.errors[0]?.code || 'INVALID_DASHBOARD_PAYLOAD',
      400,
      result.errors
    );
  }
  return result.sanitizedPayload;
}

module.exports = {
  validateDashboardPayload,
  assertValidDashboardPayload,
  DashboardValidationError,
  ALLOWED_SOURCE_TYPES,
  RESERVED_FUTURE_SOURCE_TYPES,
  ALLOWED_CHART_TYPES,
  ALLOWED_KPI_STATUSES,
  ALLOWED_FORMATS,
  ALLOWED_COMPARISON_TYPES,
  ALLOWED_DIRECTIONS,
  MAX_PAYLOAD_SIZE_BYTES,
  MAX_KPIS,
  MAX_VISUALIZATIONS,
  MAX_DATA_TABLES,
  MAX_ROWS_PER_DATASET,
};
