'use strict';

/**
 * SOTRANS HUB — BI PRIVACY, PII PROTECTION & SAFE INSIGHT CONTEXT
 * 
 * Central Data Privacy Enforcement:
 * - Robust normalizer handling Vietnamese diacritics, English, underscores, and unit suffixes
 * - Strict PII detection (Citizen ID, phone, email, employee ID, full names, bank accounts)
 * - Safe LLM Insight Context builder: guarantees ZERO raw individual records sent to LLM prompt
 * - Whitelist-based category extraction for aggregated queries only
 */

function normalizeKey(key) {
  if (key == null) return '';
  return String(key)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function stripUnits(normKey) {
  return normKey.replace(/(vnd|usd|dong|nghin|trieu)$/, '');
}

const credentialKey = (key) => {
  const k = normalizeKey(key);
  return /^(password|passwordhash|passwd|secret|token|jwt|authtoken|apikey|credential|privatekey|bearer)$/.test(k);
};

const personalKey = (key) => {
  const raw = normalizeKey(key);
  const k = stripUnits(raw);

  // 1. Identifiers
  if (/^(ma|code|id|manv|manhanvien|employeeid|staffid|masodinhdanh|socmnd|cmnd|socccd|cccd|citizenid|passport|sohochieu)$/.test(k)) {
    return true;
  }
  if (/citizenid|cccd|cmnd|passport|hochieu|masothue|mst/.test(k)) {
    return true;
  }

  // 2. Personal Names
  if (/^(hoten|hovaten|tennhanvien|fullname|firstname|lastname|chutaikhoan|employeename|staffname|username)$/.test(k)) {
    return true;
  }
  if (/(hoten|hovaten|tennhanvien)/.test(k)) {
    return true;
  }

  // 3. Contact, Banking & Demographics
  if (/^(sdt|sodienthoai|phone|telephone|mobile|email|diachi|address|sotaikhoan|bankaccount|stk|nganhang|ngaysinh|dob|birthdate|quequan|noisinh)$/.test(k)) {
    return true;
  }
  if (/sodienthoai|dienthoai|sotaikhoan|taikhoannganhang|birthdate|ngaysinh/.test(k)) {
    return true;
  }

  // 4. Individual Compensation & Salary (not an aggregated metric)
  const isAggregate = /^(sum|avg|tong|trungbinh|min|max|median|count|soluong|tytrong|pct|share)/.test(k);
  if (!isAggregate) {
    if (/^(luong|salary|basesalary|luongcoban|luongthang|thunhap|income|phucap|allowance|thuong|bonus|bhxh|baohiem)$/.test(k)) {
      return true;
    }
    if (/luongcoban|basesalary|thunhap/.test(k)) {
      return true;
    }
  }

  return false;
};

function maskPiiValue(val, normKey) {
  if (val == null || val === '') return val;
  const str = String(val).trim();
  if (/citizenid|cccd|cmnd/.test(normKey)) {
    if (str.length >= 6) {
      return str.slice(0, 3) + '*'.repeat(Math.max(4, str.length - 6)) + str.slice(-3);
    }
    return '***';
  }
  if (/sodienthoai|phone|sdt/.test(normKey)) {
    if (str.length >= 6) {
      return str.slice(0, 3) + '*'.repeat(Math.max(4, str.length - 6)) + str.slice(-3);
    }
    return '****';
  }
  if (/email/.test(normKey)) {
    const parts = str.split('@');
    if (parts.length === 2) {
      const userPart = parts[0];
      const prefix = userPart.slice(0, 2);
      return `${prefix}***@${parts[1]}`;
    }
    return '***@***';
  }
  if (/hoten|hovaten|tennhanvien|fullname|name/.test(normKey)) {
    const parts = str.split(' ');
    if (parts.length > 1) {
      return parts[0] + ' ' + '*'.repeat(parts.slice(1).join(' ').length);
    }
    return str.slice(0, 1) + '***';
  }
  if (/manv|manhanvien|employeeid|staffid/.test(normKey)) {
    if (str.length >= 4) {
      return str.slice(0, 2) + '*'.repeat(str.length - 2);
    }
    return '***';
  }
  return '[Đã ẩn]';
}

function sanitizeBiData(value, key = '') {
  const normKey = normalizeKey(key);
  if (personalKey(key)) return maskPiiValue(value, normKey);
  if (Array.isArray(value)) return value.map(item => sanitizeBiData(item));
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [field, item] of Object.entries(value)) {
      if (!credentialKey(field)) clean[field] = sanitizeBiData(item, field);
    }
    return clean;
  }
  return value;
}

function sanitizeBiProfile(profile) {
  if (!profile) return profile;
  const clean = { ...profile };
  if (Array.isArray(clean.sheets)) {
    clean.sheets = clean.sheets.map(s => ({ ...s }));
  }
  clean.columns = (clean.columns || []).filter(column => !credentialKey(column.key || column.name)).map(column => {
    if (!personalKey(column.key || column.name)) return column;
    const safe = { ...column, top_values: (column.top_values || []).map(v => ({ ...v, value: '[Đã ẩn]' })) };
    for (const key of ['min', 'max', 'sum', 'avg', 'median']) if (key in safe) safe[key] = null;
    return safe;
  });
  return clean;
}

const SAFE_DIMENSIONS = new Set([
  'phongban', 'department', 'donvi', 'bophan', 'team', 'chinhanh', 'branch', 'khuvuc', 'diaban',
  'chucvu', 'title', 'position', 'vaitro', 'role', 'capbac',
  'trangthai', 'status', 'loaihopdong', 'contracttype', 'loaihoso', 'documenttype',
  'thang', 'month', 'quy', 'quarter', 'nam', 'year', 'kybaocao', 'period', 'date', 'ngay',
  'gioitinh', 'gender',
]);

function isSafeDimension(key) {
  const k = normalizeKey(key);
  if (personalKey(key) || credentialKey(key)) return false;
  return SAFE_DIMENSIONS.has(k) || /^(phongban|chinhanh|chucvu|trangthai|loai|thang|quy|nam)/.test(k);
}

function isSafeAggregateMetric(key) {
  const k = normalizeKey(key);
  if (credentialKey(key)) return false;
  return /^(count|soluong|headcount|tong|sum|trungbinh|avg|min|max|median|tytrong|percentage|pct|share)/.test(k);
}

function isAllowedCategoryField(key) {
  if (personalKey(key) || credentialKey(key)) return false;
  return isSafeDimension(key) || isSafeAggregateMetric(key);
}

/**
 * Build Safe Insight Context for LLM Prompts
 * Guarantees zero raw individual rows or personal data sent to LLM.
 * 
 * @param {Object} queryResult - Results from analytical engine
 * @param {Object} [queryPlan=null] - Validated query plan
 * @returns {Object} Safe summary payload for LLM prompt
 */
function buildSafeInsightContext(queryResult, queryPlan = null) {
  if (!queryResult) return {};

  // 1. Determine if this query is an aggregated grouping vs raw record retrieval
  const planType = queryPlan?.query_type || queryResult?.query_type || '';
  const planGroupBy = queryPlan?.groupBy || queryResult?.group_by || [];
  const isAggQuery = ['AGGREGATION', 'DISTRIBUTION', 'TREND'].includes(planType) ||
    (Array.isArray(planGroupBy) && planGroupBy.length > 0);

  // If query is an un-grouped FILTER or RANKING, results are individual records, NOT categories!
  const firstRow = (queryResult.results && queryResult.results.length > 0) ? queryResult.results[0] : null;
  const firstRowHasIdentity = firstRow && Object.keys(firstRow).some(k => personalKey(k));

  const isSafeAggregation = isAggQuery || (
    firstRow &&
    !firstRowHasIdentity &&
    Object.keys(firstRow).some(k => isSafeDimension(k)) &&
    Object.keys(firstRow).some(k => isSafeAggregateMetric(k))
  );

  // 2. Build safe top_categories only if it is a genuine safe aggregation
  let topCategories = [];
  if (isSafeAggregation && Array.isArray(queryResult.results)) {
    topCategories = queryResult.results.slice(0, 5).map(r => {
      const safeRow = {};
      for (const [k, v] of Object.entries(r)) {
        if (isAllowedCategoryField(k)) {
          safeRow[k] = v;
        }
      }
      return safeRow;
    }).filter(r => Object.keys(r).length > 0);
  }

  // 3. Build safe kpi_summary (exclude any unexpected personal keys in summary)
  const safeSummary = {};
  if (queryResult.summary && typeof queryResult.summary === 'object') {
    for (const [k, v] of Object.entries(queryResult.summary)) {
      if (!personalKey(k) && !credentialKey(k)) {
        safeSummary[k] = v;
      }
    }
  }

  // 4. Build safe period_comparison
  let safePeriodComp = null;
  if (queryResult.period_comparison && typeof queryResult.period_comparison === 'object') {
    safePeriodComp = {};
    for (const [k, v] of Object.entries(queryResult.period_comparison)) {
      if (!personalKey(k) && !credentialKey(k) && typeof v !== 'object') {
        safePeriodComp[k] = v;
      }
    }
  }

  return {
    total_matching_rows: queryResult.total_matching ?? queryResult.rows_scanned ?? 0,
    total_groups: isSafeAggregation ? (queryResult.total_groups ?? (queryResult.results ? queryResult.results.length : 0)) : 0,
    kpi_summary: safeSummary,
    period_comparison: safePeriodComp,
    top_categories: topCategories,
  };
}

module.exports = {
  sanitizeBiData,
  sanitizeBiProfile,
  buildSafeInsightContext,
  credentialKey,
  personalKey,
  isAllowedCategoryField,
  isSafeDimension,
  isSafeAggregateMetric,
  normalizeKey,
};
