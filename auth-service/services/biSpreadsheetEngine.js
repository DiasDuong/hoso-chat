/**
 * SOTRANS HUB — BI SPREADSHEET ENGINE (PHASE 2.2)
 * 
 * Isolated In-Memory Columnar Processing & Data Profiling Engine:
 * - Safe parsing of .xlsx, .xls and .csv with strict resource limits
 * - Dynamic CSV delimiter detection & RFC 4180 parsing
 * - Automated Data Profiling (types, null rates, cardinality, min/max/avg, distributions)
 * - Data Quality Alerts & Smart Analysis Suggestions
 * - Formula Injection Sanitization
 * - Safe in-memory Analytical Querying (Filter, Group By, Aggregate, Order By)
 * - 100% Isolated: Zero writes to PostgreSQL HR database
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { STORAGE_DIR, sanitizeFormulaInjection } = require('./biFileSecurityService');
const { MAX_ROWS_PER_DATASET } = require('./biDashboardSchemaValidator');

const MAX_SHEETS = 10;
const MAX_ROWS = 50000;
const MAX_COLUMNS = 100;
const MAX_CONCURRENT_QUERIES = parseInt(process.env.BI_MAX_CONCURRENT_QUERIES, 10) || 10;
let activeConcurrentQueries = 0;

// Helper: normalize header name to snake_case identifier
function normalizeHeaderKey(rawHeader, index) {
  if (!rawHeader || typeof rawHeader !== 'string') {
    return `col_${index + 1}`;
  }
  let key = rawHeader
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || `col_${index + 1}`;
}

// Helper: parse string to float/number handling VN/EU and US formats
function parseNumericValue(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val !== 'string') return null;

  let s = val.trim();
  if (!s) return null;

  // Strip leading single quote if present (from CSV quote escape or formula sanitizer)
  if (s.startsWith("'")) {
    s = s.slice(1).trim();
  }

  // Remove currency symbols and percentages
  s = s.replace(/[₫$€£¥%]/g, '').trim();

  // Accounting negative numbers in parens: (123.45) -> -123.45
  if (s.startsWith('(') && s.endsWith(')')) {
    s = '-' + s.slice(1, -1).trim();
  }

  // Handle VN/EU format: 1.234.567,89 -> 1234567.89
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    // US format: 1,234,567.89 -> 1234567.89
    s = s.replace(/,/g, '');
  } else if (s.includes(',') && !s.includes('.')) {
    // e.g. 123,45
    s = s.replace(',', '.');
  }

  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

// Helper: parse date value
function parseDateValue(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const year = val.getFullYear();
    const month = String(val.getMonth() + 1).padStart(2, '0');
    const day = String(val.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (!s) return null;

  // Check YYYY-MM-DD or ISO string starting with YYYY-MM-DD
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    const year = parseInt(ymd[1], 10);
    const month = parseInt(ymd[2], 10);
    const day = parseInt(ymd[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Check DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const month = parseInt(dmy[2], 10);
    const year = parseInt(dmy[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

// Helper: truncate date string by unit
function truncateDate(dateVal, dateTrunc) {
  if (!dateVal) return '';
  const parsed = parseDateValue(dateVal);
  if (!parsed) return String(dateVal);
  if (dateTrunc === 'year') {
    return parsed.slice(0, 4);
  }
  if (dateTrunc === 'quarter') {
    const month = parseInt(parsed.slice(5, 7), 10);
    const q = Math.ceil(month / 3);
    return `${parsed.slice(0, 4)}-Q${q}`;
  }
  if (dateTrunc === 'month') {
    return parsed.slice(0, 7);
  }
  return parsed;
}

// Robust RFC-4180 CSV Parser
function parseCsvBuffer(buffer) {
  let text = buffer.toString('utf8');
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  // Auto-detect delimiter from first 10 non-empty lines
  const sampleLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 10);
  const candidates = [',', ';', '\t', '|'];
  let bestDelimiter = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = sampleLines.map((line) => {
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQuotes = !inQuotes;
        else if (line[i] === delim && !inQuotes) count++;
      }
      return count;
    });

    const avg = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
    if (avg > 0) {
      // Check consistency (low variance)
      const variance = counts.reduce((acc, c) => acc + Math.pow(c - avg, 2), 0) / counts.length;
      const score = avg / (1 + variance);
      if (score > bestScore) {
        bestScore = score;
        bestDelimiter = delim;
      }
    }
  }

  // Parse lines into raw rows
  const rawRows = [];
  let currentRow = [];
  let currentField = '';
  let insideQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === '"') {
      if (insideQuotes && text[i + 1] === '"') {
        currentField += '"';
        i += 2;
        continue;
      }
      insideQuotes = !insideQuotes;
      i++;
      continue;
    }

    if (!insideQuotes && char === bestDelimiter) {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if (!insideQuotes && (char === '\r' || char === '\n')) {
      if (char === '\r' && text[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentField);
      currentField = '';
      if (currentRow.some((f) => f.trim().length > 0)) {
        rawRows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  if (currentRow.length > 0 || currentField.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((f) => f.trim().length > 0)) {
      rawRows.push(currentRow);
    }
  }

  return { rawRows, delimiter: bestDelimiter };
}

/**
 * Infer Column Data Type & Compute Column Statistics
 */
function profileColumn(columnName, columnKey, values) {
  const total = values.length;
  let nullCount = 0;
  const nonNullValues = [];
  const freqMap = new Map();

  let integerCount = 0;
  let floatCount = 0;
  let dateCount = 0;
  let booleanCount = 0;

  for (const raw of values) {
    if (raw === null || raw === undefined || raw === '') {
      nullCount++;
      continue;
    }

    const valStr = String(raw).trim();
    if (valStr === '') {
      nullCount++;
      continue;
    }

    nonNullValues.push(raw);
    freqMap.set(valStr, (freqMap.get(valStr) || 0) + 1);

    // Boolean check
    const lower = valStr.toLowerCase();
    if (['true', 'false', 'yes', 'no', 'đúng', 'sai'].includes(lower)) {
      booleanCount++;
    }

    // Date check
    if (parseDateValue(raw) !== null) {
      dateCount++;
    }

    // Number check
    const num = parseNumericValue(raw);
    if (num !== null) {
      if (Number.isInteger(num)) {
        integerCount++;
      } else {
        floatCount++;
      }
    }
  }

  const nonNullTotal = nonNullValues.length;
  const nullRatio = total > 0 ? Number(((nullCount / total) * 100).toFixed(2)) : 0;
  const cardinality = freqMap.size;

  // Infer dominant type
  let inferredType = 'STRING';
  if (nonNullTotal > 0) {
    if (booleanCount / nonNullTotal >= 0.8) {
      inferredType = 'BOOLEAN';
    } else if (dateCount / nonNullTotal >= 0.8) {
      inferredType = 'DATE';
    } else if ((integerCount + floatCount) / nonNullTotal >= 0.8) {
      inferredType = floatCount > 0 ? 'FLOAT' : 'INTEGER';
    }
  }

  const profile = {
    name: columnName,
    key: columnKey,
    type: inferredType,
    total_count: total,
    non_null_count: nonNullTotal,
    null_count: nullCount,
    null_ratio_pct: nullRatio,
    cardinality,
  };

  // Type-specific metrics
  if (inferredType === 'INTEGER' || inferredType === 'FLOAT') {
    const nums = nonNullValues.map(parseNumericValue).filter((n) => n !== null).sort((a, b) => a - b);
    if (nums.length > 0) {
      const min = nums[0];
      const max = nums[nums.length - 1];
      const sum = nums.reduce((a, b) => a + b, 0);
      const avg = Number((sum / nums.length).toFixed(2));
      const mid = Math.floor(nums.length / 2);
      const median = nums.length % 2 !== 0 ? nums[mid] : Number(((nums[mid - 1] + nums[mid]) / 2).toFixed(2));

      profile.min = min;
      profile.max = max;
      profile.sum = sum;
      profile.avg = avg;
      profile.median = median;
    }
  } else if (inferredType === 'DATE') {
    const dates = nonNullValues.map(parseDateValue).filter(Boolean).sort();
    if (dates.length > 0) {
      profile.min_date = dates[0];
      profile.max_date = dates[dates.length - 1];
      const d1 = new Date(dates[0]);
      const d2 = new Date(dates[dates.length - 1]);
      profile.span_days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    }
  } else {
    // Categorical / String top 5
    const topValues = Array.from(freqMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({
        value,
        count,
        pct: Number(((count / nonNullTotal) * 100).toFixed(1)),
      }));
    profile.top_values = topValues;
  }

  return profile;
}

/**
 * Generate Smart Analysis Suggestions
 */
function generateAnalysisSuggestions(columnsProfile) {
  const suggestions = [];
  const dateCols = columnsProfile.filter((c) => c.type === 'DATE');
  const numCols = columnsProfile.filter((c) => c.type === 'INTEGER' || c.type === 'FLOAT');
  const catCols = columnsProfile.filter((c) => c.type === 'STRING' && c.cardinality > 1 && c.cardinality < 50);

  // Suggestion 1: Date + Metric trend
  if (dateCols.length > 0 && numCols.length > 0) {
    suggestions.push(`Phân tích xu hướng ${numCols[0].name} theo ${dateCols[0].name} (theo tháng hoặc quý).`);
  }

  // Suggestion 2: Categorical + Metric breakdown
  if (catCols.length > 0 && numCols.length > 0) {
    suggestions.push(`Top 5 ${catCols[0].name} có ${numCols[0].name} cao nhất và tỷ trọng đóng góp.`);
  }

  // Suggestion 3: Distribution or second metric
  if (numCols.length >= 2) {
    suggestions.push(`So sánh tương quan giữa ${numCols[0].name} và ${numCols[1].name}.`);
  } else if (catCols.length >= 2) {
    suggestions.push(`Phân bổ số lượng bản ghi theo ${catCols[0].name} và ${catCols[1].name}.`);
  }

  // Fallback
  if (suggestions.length === 0 && numCols.length > 0) {
    suggestions.push(`Tổng hợp số liệu thống kê tổng, trung bình, cao nhất và thấp nhất của ${numCols[0].name}.`);
  }
  if (suggestions.length === 0) {
    suggestions.push('Tổng hợp cơ cấu dữ liệu và thống kê số lượng bản ghi theo từng trường.');
  }

  return suggestions;
}

/**
 * Parse & Profile Stored Spreadsheet File
 * @param {Object} metadata - File metadata from biFileSecurityService
 * @param {Buffer} buffer - File buffer
 * @returns {Promise<Object>} Processed dataset & comprehensive data profile
 */
async function processAndProfileDataset(metadata, buffer) {
  const qualityAlerts = [];
  let sheets = [];
  let activeSheetName = '';
  let rawRows = [];
  const rawSheets = new Map();

  const ext = metadata.file_extension;

  // 1. Parse File Buffer
  if (ext === '.csv') {
    const csvResult = parseCsvBuffer(buffer);
    rawRows = csvResult.rawRows;
    activeSheetName = 'Sheet1';
    sheets = [{ name: 'Sheet1', rowCount: rawRows.length, delimiter: csvResult.delimiter }];
    rawSheets.set('Sheet1', rawRows);
  } else {
    // XLSX or XLS
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: true,
      dense: true,
      sheetStubs: false,
      sheetRows: MAX_ROWS + 2,
    });

    const sheetNames = workbook.SheetNames || [];
    if (sheetNames.length === 0) {
      throw new Error('Tệp bảng tính không có trang tính (sheet) nào.');
    }

    if (sheetNames.length > MAX_SHEETS) {
      qualityAlerts.push({
        type: 'SHEETS_TRUNCATED',
        message: `Tệp chứa ${sheetNames.length} sheet, chỉ xử lý tối đa ${MAX_SHEETS} sheet đầu tiên.`,
      });
    }

    // Default to first sheet or first sheet with rows
    activeSheetName = sheetNames[0];
    sheets = sheetNames.slice(0, MAX_SHEETS).map((name) => {
      const sheet = workbook.Sheets[name];
      const ref = sheet ? sheet['!ref'] : null;
      let count = 0;
      if (ref) {
        const range = XLSX.utils.decode_range(ref);
        count = range.e.r - range.s.r + 1;
      }
      return { name, rowCount: count };
    });

    const activeSheet = workbook.Sheets[activeSheetName];
    if (activeSheet) {
      rawRows = XLSX.utils.sheet_to_json(activeSheet, {
        header: 1,
        defval: '',
        raw: false,
      });
    }
    for (const name of sheetNames.slice(0, MAX_SHEETS)) {
      rawSheets.set(name, name === activeSheetName ? rawRows : XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: false }));
    }
    activeSheetName = Array.from(rawSheets.keys()).find(name => rawSheets.get(name).length >= 2) || activeSheetName;
  }

  const baseQualityAlerts = [...qualityAlerts];
  function buildSheet(rawRows, activeSheetName) {
  const qualityAlerts = [...baseQualityAlerts];
  // 2. Validate Rows & Columns
  if (rawRows.length < 2) {
    throw new Error('Bảng tính không có đủ dữ liệu (ít nhất cần 1 dòng tiêu đề và 1 dòng dữ liệu).');
  }

  const rawHeaders = rawRows[0].map((h) => (h === null || h === undefined ? '' : String(h).trim()));
  let columnCount = rawHeaders.length;

  if (columnCount > MAX_COLUMNS) {
    qualityAlerts.push({
      type: 'COLUMNS_TRUNCATED',
      message: `Bảng tính có ${columnCount} cột, chỉ xử lý ${MAX_COLUMNS} cột đầu tiên.`,
    });
    rawHeaders.length = MAX_COLUMNS;
    columnCount = MAX_COLUMNS;
  }

  let dataRows = rawRows.slice(1).filter((rowArr) => {
    return Array.isArray(rowArr) && rowArr.some((v) => v !== null && v !== undefined && String(v).trim() !== '');
  });
  if (dataRows.length > MAX_ROWS) {
    qualityAlerts.push({
      type: 'ROWS_TRUNCATED',
      message: `Dữ liệu có ${dataRows.length} dòng, chỉ nạp ${MAX_ROWS} dòng đầu tiên.`,
    });
    dataRows = dataRows.slice(0, MAX_ROWS);
  }

  // 3. Resolve Header Keys & Check for duplicates
  const seenKeys = new Map();
  const columns = rawHeaders.map((headerName, idx) => {
    let key = normalizeHeaderKey(headerName, idx);
    if (seenKeys.has(key)) {
      const count = seenKeys.get(key) + 1;
      seenKeys.set(key, count);
      qualityAlerts.push({
        type: 'DUPLICATE_HEADER',
        message: `Tiêu đề cột "${headerName}" bị trùng lặp, tự động đổi mã thành "${key}_${count}".`,
      });
      key = `${key}_${count}`;
    } else {
      seenKeys.set(key, 1);
    }
    return { name: headerName || `Cột ${idx + 1}`, key, index: idx };
  });

  // 4. Build Structured Rows & Sanitize Formula Injection
  let formulaInjectionCount = 0;
  const structuredRows = dataRows.map((rowArr) => {
    const rowObj = {};
    for (const col of columns) {
      let rawVal = rowArr[col.index];
      if (rawVal === undefined || rawVal === null) rawVal = '';

      // Formula sanitization
      const sanitizedRes = sanitizeFormulaInjection(rawVal);
      if (sanitizedRes.wasFormula) {
        formulaInjectionCount++;
      }
      rowObj[col.key] = sanitizedRes.sanitized;
    }
    return rowObj;
  });

  if (formulaInjectionCount > 0) {
    qualityAlerts.push({
      type: 'FORMULA_INJECTION_SANITIZED',
      message: `Đã phát hiện và vô hiệu hóa ${formulaInjectionCount} ô chứa ký tự công thức (=, +, -, @) để phòng chống tấn công CSV Injection.`,
    });
  }

  // 5. Data Profiling per Column
  const columnsProfile = columns.map((col) => {
    const values = structuredRows.map((r) => r[col.key]);
    const prof = profileColumn(col.name, col.key, values);

    // High null alert
    if (prof.null_ratio_pct > 50) {
      qualityAlerts.push({
        type: 'HIGH_NULL_RATE',
        column: col.name,
        message: `Cột "${col.name}" có ${prof.null_ratio_pct}% ô trống (thiếu dữ liệu).`,
      });
    }

    return prof;
  });

  // 6. Generate Smart Suggestions & Data Preview (first 10 rows)
  const suggestedQuestions = generateAnalysisSuggestions(columnsProfile);
  const previewRows = structuredRows.slice(0, 10);

  const dataProfile = {
    file_id: metadata.file_id,
    original_filename: metadata.original_filename,
    file_type: metadata.file_type,
    active_sheet: activeSheetName,
    sheets,
    row_count: structuredRows.length,
    column_count: columnsProfile.length,
    columns: columnsProfile,
    quality_alerts: qualityAlerts,
    suggested_questions: suggestedQuestions,
    preview_rows: previewRows,
  };
  return { profile: dataProfile, columns: columnsProfile, rows: structuredRows };
  }

  const sheetDatasets = Object.create(null);
  let remainingRows = MAX_ROWS;
  for (const [name, rows] of rawSheets) {
    if (rows.length < 2) continue;
    if (remainingRows === 0) throw Object.assign(new Error('Tổng số dòng của các sheet vượt giới hạn 50.000. Vui lòng chia nhỏ tệp.'), { code: 'WORKBOOK_ROW_LIMIT', status: 400 });
    const built = buildSheet(rows, name);
    remainingRows -= built.rows.length;
    if (remainingRows < 0) throw Object.assign(new Error('Tổng số dòng của các sheet vượt giới hạn 50.000. Vui lòng chia nhỏ tệp.'), { code: 'WORKBOOK_ROW_LIMIT', status: 400 });
    sheetDatasets[name] = built;
  }
  const active = sheetDatasets[activeSheetName];
  if (!active) throw new Error('Không có sheet chứa dữ liệu hợp lệ.');
  const dataProfile = active.profile;

  // 7. Persist Isolated Dataset JSON (Strictly separated from Postgres HR tables)
  const datasetJsonPath = path.join(STORAGE_DIR, `${metadata.file_id}.dataset.json`);
  const datasetPayload = {
    file_id: metadata.file_id,
    metadata,
    profile: dataProfile,
    columns: active.columns,
    rows: active.rows,
    sheets: sheetDatasets,
  };

  await fs.promises.writeFile(datasetJsonPath, JSON.stringify(datasetPayload), {
    encoding: 'utf8',
    mode: 0o600,
  });

  return { dataProfile, datasetJsonPath };
}

/**
 * Execute Safe Analytical Query on In-Memory Structured Dataset
 * Core Engine Implementation conforming to IAnalyticalQueryEngine interface
 * @param {Object} dataset - { file_id, columns, rows }
 * @param {Object} querySpec - Validated analytical query plan
 * @returns {Object} Query results with execution metrics
 */
function executeAnalyticalQuery(dataset, querySpec = {}) {
  if (activeConcurrentQueries >= MAX_CONCURRENT_QUERIES) {
    const err = new Error(`Hệ thống phân tích đang xử lý tối đa ${MAX_CONCURRENT_QUERIES} tác vụ đồng thời. Vui lòng thử lại sau giây lát.`);
    err.code = 'CONCURRENCY_LIMIT_EXCEEDED';
    err.status = 429;
    throw err;
  }

  activeConcurrentQueries++;
  try {
    const startTime = Date.now();
    const startHeap = process.memoryUsage().heapUsed;
    const timeoutMs = typeof querySpec.timeout_ms === 'number' ? querySpec.timeout_ms : (parseInt(process.env.BI_QUERY_TIMEOUT_MS, 10) || 3000);
    const maxGroups = typeof querySpec.max_groups === 'number' ? querySpec.max_groups : (parseInt(process.env.BI_QUERY_MAX_GROUPS, 10) || 1000);

    // Early timeout check
    if (Date.now() - startTime >= timeoutMs) {
      const err = new Error(`Thời gian thực thi truy vấn vượt quá giới hạn an toàn (${timeoutMs}ms).`);
      err.code = 'TIMEOUT_EXCEEDED';
      err.status = 408;
      throw err;
    }

    let rows = dataset.rows || [];
    const columns = dataset.columns || [];

  // 1. Filter Stage
  if (Array.isArray(querySpec.filters) && querySpec.filters.length > 0) {
    rows = rows.filter((row) => {
      // Check execution timeout periodically
      if (Date.now() - startTime > timeoutMs) {
        const err = new Error(`Thời gian lọc dữ liệu vượt quá giới hạn an toàn (${timeoutMs}ms).`);
        err.code = 'TIMEOUT_EXCEEDED';
        err.status = 408;
        throw err;
      }

      for (const filter of querySpec.filters) {
        const { column, op, value } = filter;
        const cell = row[column];
        const colDef = columns.find(c => c.key === column);
        const isDateCol = ['DATE', 'DATETIME'].includes(colDef?.type) || /(ngay|date|time|thang|month)/i.test(column || '');
        const comparable = v => {
          if (isDateCol) {
            const pd = parseDateValue(v);
            if (pd) {
              const ts = Date.parse(pd);
              if (!isNaN(ts)) return ts;
            }
            if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v.trim())) {
              const ts = Date.parse(`${v.trim()}-01`);
              if (!isNaN(ts)) return ts;
            }
          }
          const num = parseNumericValue(v);
          if (num !== null && Number.isFinite(num)) return num;
          const pdFallback = parseDateValue(v);
          if (pdFallback) {
            const ts = Date.parse(pdFallback);
            if (!isNaN(ts)) return ts;
          }
          return null;
        };
        if (op === 'eq' && String(cell).toLowerCase() !== String(value).toLowerCase()) return false;
        if (op === 'neq' && String(cell).toLowerCase() === String(value).toLowerCase()) return false;
        if (op === 'contains' && !String(cell).toLowerCase().includes(String(value).toLowerCase())) return false;
        if (op === 'is_null' && cell !== null && cell !== undefined && cell !== '') return false;
        if (op === 'not_null' && (cell === null || cell === undefined || cell === '')) return false;

        if (op === 'gt') {
          const num = comparable(cell);
          if (num === null || !Number.isFinite(num) || num <= comparable(value)) return false;
        }
        if (op === 'gte') {
          const num = comparable(cell);
          if (num === null || !Number.isFinite(num) || num < comparable(value)) return false;
        }
        if (op === 'lt') {
          const num = comparable(cell);
          if (num === null || !Number.isFinite(num) || num >= comparable(value)) return false;
        }
        if (op === 'lte') {
          const num = comparable(cell);
          if (num === null || !Number.isFinite(num) || num > comparable(value)) return false;
        }
        if (op === 'in' && Array.isArray(value)) {
          if (!value.map(String).map((s) => s.toLowerCase()).includes(String(cell).toLowerCase())) return false;
        }
        if (op === 'between' && Array.isArray(value) && value.length === 2) {
          const num = comparable(cell);
          if (num === null || !Number.isFinite(num) || num < comparable(value[0]) || num > comparable(value[1])) return false;
        }
      }
      return true;
    });
  }

  const totalMatching = rows.length;

  // 2. Group By & Aggregations Stage
  let resultRows = [];
  const groupBy = querySpec.groupBy || [];
  const aggregations = querySpec.aggregations || [];

  if (groupBy.length > 0 || (aggregations.length > 0 && querySpec.intent !== 'RANKING' && querySpec.intent !== 'FILTER')) {
    const groups = new Map();

    for (const row of rows) {
      if (Date.now() - startTime > timeoutMs) {
        const err = new Error(`Thời gian gom nhóm vượt quá giới hạn an toàn (${timeoutMs}ms).`);
        err.code = 'TIMEOUT_EXCEEDED';
        err.status = 408;
        throw err;
      }

      const groupKeyParts = [];
      const groupObj = {};

      for (const g of groupBy) {
        if (typeof g === 'object' && g.date_trunc) {
          const val = truncateDate(row[g.column], g.date_trunc);
          groupKeyParts.push(val);
          groupObj[g.column] = val;
        } else {
          const colKey = typeof g === 'string' ? g : g.column;
          const val = row[colKey] !== undefined ? row[colKey] : '';
          groupKeyParts.push(String(val));
          groupObj[colKey] = val;
        }
      }

      const groupKey = JSON.stringify(groupKeyParts);

      if (!groups.has(groupKey)) {
        if (groups.size >= maxGroups) {
          const err = new Error(`Số lượng nhóm dữ liệu (${groups.size}) vượt quá giới hạn tối đa cho phép (${maxGroups}). Vui lòng thu hẹp phạm vi lọc.`);
          err.code = 'MAX_GROUPS_EXCEEDED';
          err.status = 400;
          throw err;
        }
        groups.set(groupKey, { groupObj, groupRows: [] });
      }

      groups.get(groupKey).groupRows.push(row);
    }

    for (const { groupObj, groupRows } of groups.values()) {
      const outRow = { ...groupObj };

      for (const agg of aggregations) {
        const { column, func, alias } = agg;
        const targetAlias = alias || `${func.toLowerCase()}_${column}`;
        const upperFunc = String(func).toUpperCase();

        if (upperFunc === 'COUNT' || upperFunc === 'COUNT_ROWS') {
          if (!column || column === '*' || upperFunc === 'COUNT_ROWS') {
            outRow[targetAlias] = groupRows.length;
          } else {
            outRow[targetAlias] = groupRows.filter((r) => r[column] !== null && r[column] !== undefined && r[column] !== '').length;
          }
        } else if (upperFunc === 'COUNT_NON_NULL') {
          outRow[targetAlias] = groupRows.filter((r) => r[column] !== null && r[column] !== undefined && r[column] !== '').length;
        } else if (upperFunc === 'DISTINCT_COUNT' || upperFunc === 'COUNT_DISTINCT') {
          const distinctSet = new Set(
            groupRows.map((r) => r[column]).filter((v) => v !== null && v !== undefined && v !== '')
          );
          outRow[targetAlias] = distinctSet.size;
        } else {
          const nums = groupRows.map((r) => parseNumericValue(r[column])).filter((n) => n !== null);

          if (nums.length === 0) {
            outRow[targetAlias] = null;
          } else if (upperFunc === 'SUM') {
            outRow[targetAlias] = Number(nums.reduce((a, b) => a + b, 0).toFixed(2));
          } else if (upperFunc === 'AVG') {
            outRow[targetAlias] = Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
          } else if (upperFunc === 'MIN') {
            outRow[targetAlias] = Math.min(...nums);
          } else if (upperFunc === 'MAX') {
            outRow[targetAlias] = Math.max(...nums);
          } else if (upperFunc === 'MEDIAN') {
            nums.sort((a, b) => a - b);
            const mid = Math.floor(nums.length / 2);
            outRow[targetAlias] =
              nums.length % 2 !== 0 ? nums[mid] : Number(((nums[mid - 1] + nums[mid]) / 2).toFixed(2));
          }
        }
      }

      resultRows.push(outRow);
    }
  } else {
    resultRows = [...rows];
  }

  // Filter groups if having clause specified (e.g. DUPLICATES check)
  if (querySpec.having && querySpec.having.column) {
    const { column, op, value } = querySpec.having;
    const targetComp = parseNumericValue(value) ?? value;
    resultRows = resultRows.filter((r) => {
      const cellVal = parseNumericValue(r[column]) ?? r[column];
      if (op === 'gt') return cellVal > targetComp;
      if (op === 'gte') return cellVal >= targetComp;
      if (op === 'lt') return cellVal < targetComp;
      if (op === 'lte') return cellVal <= targetComp;
      if (op === 'eq') return cellVal === targetComp;
      if (op === 'neq') return cellVal !== targetComp;
      return true;
    });
  }

  // Compute whole-filter summaries before grouping limits; AVG/MEDIAN/DISTINCT
  // cannot be recovered by adding or averaging the group aggregates.
  const summary = {};
  for (const agg of aggregations) {
    const alias = agg.alias || `${agg.func.toLowerCase()}_${agg.column}`;
    const values = rows.map(r => parseNumericValue(r[agg.column])).filter(n => n !== null);
    const func = String(agg.func).toUpperCase();
    if (func === 'COUNT' || func === 'COUNT_ROWS') {
      if (!agg.column || agg.column === '*' || func === 'COUNT_ROWS') {
        summary[alias] = rows.length;
      } else {
        summary[alias] = rows.filter(r => r[agg.column] !== null && r[agg.column] !== undefined && r[agg.column] !== '').length;
      }
    } else if (func === 'COUNT_NON_NULL') {
      summary[alias] = rows.filter(r => r[agg.column] !== null && r[agg.column] !== undefined && r[agg.column] !== '').length;
    } else if (func === 'DISTINCT_COUNT' || func === 'COUNT_DISTINCT') {
      summary[alias] = new Set(rows.map(r => r[agg.column]).filter(v => v !== null && v !== undefined && v !== '')).size;
    } else if (!values.length) {
      summary[alias] = null;
    } else if (func === 'SUM') {
      summary[alias] = values.reduce((a, b) => a + b, 0);
    } else if (func === 'AVG') {
      summary[alias] = values.reduce((a, b) => a + b, 0) / values.length;
    } else if (func === 'MIN') {
      summary[alias] = Math.min(...values);
    } else if (func === 'MAX') {
      summary[alias] = Math.max(...values);
    } else if (func === 'MEDIAN') {
      values.sort((a, b) => a - b);
      const mid = Math.floor(values.length / 2);
      summary[alias] = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    }
    if (typeof summary[alias] === 'number') summary[alias] = Number(summary[alias].toFixed(2));
  }

  if (querySpec.intent === 'DUPLICATES') {
    summary.duplicate_groups = resultRows.length;
  }

  const timeGroup = groupBy.find(g => typeof g === 'object' && g.date_trunc);
  const dateColumn = querySpec.period_comparison?.date_column || timeGroup?.column || groupBy.map(g => typeof g === 'string' ? g : g.column).find(k => ['DATE', 'DATETIME'].includes(columns.find(c => c.key === k)?.type));
  if (dateColumn && (querySpec.period_comparison || (querySpec.computations || []).some(c => c.type === 'GROWTH_RATE'))) {
    // Calculate each time series separately, in calendar order, then apply display sorting.
    const dimensions = groupBy.map(g => typeof g === 'string' ? g : g.column).filter(k => k !== dateColumn);
    resultRows.sort((a, b) => JSON.stringify(dimensions.map(k => a[k])).localeCompare(JSON.stringify(dimensions.map(k => b[k]))) || String(a[dateColumn]).localeCompare(String(b[dateColumn])));
  }

  // 3. Post-Aggregations & Computations (PERCENTAGE & GROWTH_RATE)
  if (Array.isArray(querySpec.computations) && querySpec.computations.length > 0) {
    for (const comp of querySpec.computations) {
      const { type, source_alias, target_alias } = comp;

      if (type === 'PERCENTAGE') {
        const totalSum = resultRows.reduce((acc, r) => acc + (parseNumericValue(r[source_alias]) || 0), 0);
        let denominator = totalSum;
        if (querySpec.percentage_basis === 'TOTAL_POPULATION' && totalMatching > 0) {
          denominator = totalMatching;
        } else if (querySpec.percentage_basis === 'GLOBAL_UNIQUE_COUNT' && summary[source_alias] > 0) {
          denominator = summary[source_alias];
        } else {
          // Standard distribution share: sum of group values guarantees slices sum to 100%
          denominator = totalSum > 0 ? totalSum : (summary[source_alias] || totalMatching);
        }
        for (const row of resultRows) {
          const val = parseNumericValue(row[source_alias]);
          row[target_alias] = val !== null && denominator !== 0 ? Number(((val / denominator) * 100).toFixed(2)) : null;
        }
      } else if (type === 'GROWTH_RATE') {
        const dimensions = groupBy.map(g => typeof g === 'string' ? g : g.column).filter(k => k !== dateColumn);
        const previousBySeries = new Map();
        for (let i = 0; i < resultRows.length; i++) {
          const series = JSON.stringify(dimensions.map(k => resultRows[i][k]));
          const previous = previousBySeries.get(series);
          if (!previous) {
            resultRows[i][target_alias] = null;
          } else {
            const prev = parseNumericValue(previous[source_alias]);
            const curr = parseNumericValue(resultRows[i][source_alias]);
            resultRows[i][target_alias] =
              prev !== null && curr !== null && prev !== 0 ? Number((((curr - prev) / Math.abs(prev)) * 100).toFixed(2)) : null;
          }
          previousBySeries.set(series, resultRows[i]);
        }
      }
    }
  }

  // 4. Period Comparison
  let periodComparisonResult = null;
  const comparisonDimensions = groupBy.map(g => typeof g === 'string' ? g : g.column).filter(k => k !== dateColumn);
  if (querySpec.period_comparison && resultRows.length >= 2 && comparisonDimensions.length === 0) {
    const { period, date_column } = querySpec.period_comparison;
    const metricAlias = aggregations[0]?.alias;
    if (metricAlias) {
      const currentPeriodRow = resultRows[resultRows.length - 1];
      const prevPeriodRow = resultRows[resultRows.length - 2];
      const currentVal = parseNumericValue(currentPeriodRow[metricAlias]);
      const prevVal = parseNumericValue(prevPeriodRow[metricAlias]);
      const diff = currentVal !== null && prevVal !== null ? Number((currentVal - prevVal).toFixed(2)) : null;
      const changePct = diff !== null && prevVal !== 0 ? Number(((diff / Math.abs(prevVal)) * 100).toFixed(2)) : null;

      periodComparisonResult = {
        comparison_basis: 'PREVIOUS_OBSERVED_PERIOD',
        period,
        current_period: currentPeriodRow[date_column] || 'Kỳ hiện tại',
        previous_period: prevPeriodRow[date_column] || 'Kỳ trước',
        current_value: currentVal,
        previous_value: prevVal,
        difference: diff,
        growth_rate_pct: changePct,
      };
    }
  }

  // 5. Order By Stage
  if (querySpec.orderBy && querySpec.orderBy.column) {
    const { column, dir = 'ASC' } = querySpec.orderBy;
    const isDesc = String(dir).toUpperCase() === 'DESC';
    resultRows.sort((a, b) => {
      const valA = a[column];
      const valB = b[column];
      const numA = parseNumericValue(valA);
      const numB = parseNumericValue(valB);
      if (numA !== null && numB !== null) {
        return isDesc ? numB - numA : numA - numB;
      }
      return isDesc
        ? String(valB || '').localeCompare(String(valA || ''))
        : String(valA || '').localeCompare(String(valB || ''));
    });
  }

  // 6. Limit Stage
  const maxLimit = querySpec.limit ? Math.min(querySpec.limit, 1000) : 100;
  const returnedRows = resultRows.slice(0, maxLimit);

  const executionTimeMs = Date.now() - startTime;
  const endHeap = process.memoryUsage().heapUsed;
  const memoryDeltaKb = Math.max(0, Math.round((endHeap - startHeap) / 1024));

  // 6b. Generate Multi-Visual Engine Aggregations on matching rows (Guarantees multi-visual on all routes)
  const deptCol = columns.find(c => /(phong|dept|bo_phan)/i.test(c.key));
  const branchCol = columns.find(c => /(chi_nhanh|branch|cong_ty)/i.test(c.key));
  const dateCol = columns.find(c => ['DATE', 'DATETIME'].includes(c.type) || /(ngay|date|time|thang|month)/i.test(c.key));
  const empIdCol = columns.find(c => /(ma_nhan_vien|nhan_vien|emp|id)/i.test(c.key));
  const salaryCol = columns.find(c => /(luong|salary|thu_nhap)/i.test(c.key));

  let distinctHeadcount = null;
  if (empIdCol) {
    const distinctSet = new Set();
    for (const r of rows) {
      const v = r[empIdCol.key];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        distinctSet.add(String(v).trim());
      }
    }
    distinctHeadcount = distinctSet.size;
  }

  let totalSalary = null;
  let avgSalary = null;
  if (salaryCol) {
    let sum = 0;
    let count = 0;
    for (const r of rows) {
      const n = parseNumericValue(r[salaryCol.key]);
      if (n !== null && Number.isFinite(n)) {
        sum += n;
        count++;
      }
    }
    if (count > 0) {
      totalSalary = sum;
      avgSalary = Math.round(sum / count);
    }
  }

  // Department breakdown
  let deptRows = [];
  if (deptCol) {
    const dMap = new Map();
    for (const r of rows) {
      const d = String(r[deptCol.key] || 'Khác').trim() || 'Khác';
      if (!dMap.has(d)) dMap.set(d, { [deptCol.key]: d, count_rows: 0, distinct_ids: new Set() });
      const item = dMap.get(d);
      item.count_rows++;
      if (empIdCol && r[empIdCol.key]) item.distinct_ids.add(String(r[empIdCol.key]).trim());
    }
    deptRows = Array.from(dMap.values())
      .map(item => ({
        [deptCol.key]: item[deptCol.key],
        distinct_count_ma_nhan_vien: empIdCol ? item.distinct_ids.size : item.count_rows,
        count_rows: item.count_rows,
      }))
      .sort((a, b) => b.distinct_count_ma_nhan_vien - a.distinct_count_ma_nhan_vien)
      .slice(0, 20);
  }

  // Branch share
  let branchRows = [];
  if (branchCol) {
    const bMap = new Map();
    for (const r of rows) {
      const b = String(r[branchCol.key] || 'Khác').trim() || 'Khác';
      if (!bMap.has(b)) bMap.set(b, { [branchCol.key]: b, count_rows: 0, distinct_ids: new Set() });
      const item = bMap.get(b);
      item.count_rows++;
      if (empIdCol && r[empIdCol.key]) item.distinct_ids.add(String(r[empIdCol.key]).trim());
    }
    const totalCount = rows.length;
    branchRows = Array.from(bMap.values()).map(item => {
      const count = empIdCol ? item.distinct_ids.size : item.count_rows;
      return {
        [branchCol.key]: item[branchCol.key],
        distinct_count_ma_nhan_vien: count,
        count_rows: item.count_rows,
        ty_trong_pct: totalCount > 0 ? Number(((item.count_rows / totalCount) * 100).toFixed(2)) : 0,
        ty_le_phan_tram: totalCount > 0 ? Number(((item.count_rows / totalCount) * 100).toFixed(2)) : 0,
      };
    }).sort((a, b) => b.count_rows - a.count_rows);
  }

  // Status breakdown (trạng thái)
  let statusRows = [];
  const statusCol = columns.find(c => /(trang_thai|status|tinh_trang)/i.test(c.key));
  if (statusCol) {
    const sMap = new Map();
    for (const r of rows) {
      const s = String(r[statusCol.key] || 'Khác').trim() || 'Khác';
      if (!sMap.has(s)) sMap.set(s, { [statusCol.key]: s, count_rows: 0, distinct_ids: new Set() });
      const item = sMap.get(s);
      item.count_rows++;
      if (empIdCol && r[empIdCol.key]) item.distinct_ids.add(String(r[empIdCol.key]).trim());
    }
    const totalCount = rows.length;
    statusRows = Array.from(sMap.values()).map(item => {
      const count = empIdCol ? item.distinct_ids.size : item.count_rows;
      return {
        [statusCol.key]: item[statusCol.key],
        distinct_count_ma_nhan_vien: count,
        count_rows: item.count_rows,
        ty_trong_pct: totalCount > 0 ? Number(((count / totalCount) * 100).toFixed(2)) : 0,
        ty_le_phan_tram: totalCount > 0 ? Number(((count / totalCount) * 100).toFixed(2)) : 0,
      };
    }).sort((a, b) => b.count_rows - a.count_rows);
  }

  // Monthly trend
  let trendRows = [];
  if (dateCol) {
    const tMap = new Map();
    for (const r of rows) {
      const t = truncateDate(r[dateCol.key], 'month') || 'Khác';
      if (!tMap.has(t)) tMap.set(t, { thoi_gian: t, count_rows: 0, sum_salary: 0, distinct_ids: new Set() });
      const item = tMap.get(t);
      item.count_rows++;
      if (empIdCol && r[empIdCol.key]) item.distinct_ids.add(String(r[empIdCol.key]).trim());
      if (salaryCol) {
        const sal = parseNumericValue(r[salaryCol.key]);
        if (sal !== null && Number.isFinite(sal)) item.sum_salary += sal;
      }
    }
    trendRows = Array.from(tMap.values())
      .filter(item => item.thoi_gian !== 'Khác')
      .map(item => ({
        thoi_gian: item.thoi_gian,
        count_rows: item.count_rows,
        distinct_count_ma_nhan_vien: empIdCol ? item.distinct_ids.size : item.count_rows,
        tong_luong: item.sum_salary,
      }))
      .sort((a, b) => String(a.thoi_gian).localeCompare(String(b.thoi_gian)));
  }

  summary.total_matching = totalMatching;
  summary.distinct_headcount = distinctHeadcount;
  summary.total_salary = totalSalary;
  summary.avg_salary = avgSalary;

  const isDetailRequested = Boolean(
    querySpec.intent === 'FILTER' ||
    querySpec.needs_details ||
    querySpec.include_detail_rows ||
    querySpec.show_data_table
  );
  const detailRows = isDetailRequested ? rows.slice(0, MAX_ROWS_PER_DATASET) : [];

  return {
    file_id: dataset.file_id,
    rows_scanned: dataset.rows ? dataset.rows.length : 0,
    total_matching: totalMatching,
    returned_rows: returnedRows.length,
    results: returnedRows,
    summary,
    total_groups: resultRows.length,
    period_comparison: periodComparisonResult,
    multi_visual: {
      dept_breakdown: deptRows,
      branch_share: branchRows,
      status_breakdown: statusRows,
      monthly_trend: trendRows,
      detail_rows: detailRows,
    },
    execution_stats: {
      execution_time_ms: executionTimeMs,
      memory_delta_kb: memoryDeltaKb,
    },
  };
  } finally {
    activeConcurrentQueries--;
  }
}

/**
 * In-Memory Safe Analytical Query Engine on Isolated Datasets by File ID
 * @param {string} fileId
 * @param {Object} querySpec - Validated analytical query plan
 */
async function queryIsolatedDataset(fileId, querySpec = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) throw Object.assign(new Error('Mã dataset không hợp lệ.'), { status: 400, code: 'INVALID_DATASET_ID' });
  const datasetJsonPath = path.join(STORAGE_DIR, `${fileId}.dataset.json`);
  if (!fs.existsSync(datasetJsonPath)) {
    const err = new Error(`Bộ dữ liệu ${fileId} không tồn tại hoặc đã hết hạn.`);
    err.code = 'DATASET_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const raw = await fs.promises.readFile(datasetJsonPath, 'utf8');
  const dataset = JSON.parse(raw);
  const target = querySpec.target_sheet || dataset.profile?.active_sheet;
  if (target && dataset.sheets) {
    if (!Object.prototype.hasOwnProperty.call(dataset.sheets, target)) throw Object.assign(new Error('Sheet không tồn tại hoặc không có dữ liệu.'), { status: 400, code: 'SHEET_NOT_FOUND' });
    const selected = dataset.sheets[target];
    return executeAnalyticalQuery({ ...dataset, ...selected }, querySpec);
  }
  if (target && dataset.profile?.active_sheet && target !== dataset.profile.active_sheet) throw Object.assign(new Error('Dataset cũ chưa có dữ liệu sheet này. Vui lòng tải lại tệp.'), { status: 400, code: 'SHEET_NOT_AVAILABLE' });
  return executeAnalyticalQuery(dataset, querySpec);
}

async function getDatasetForSheet(dataset, sheetName) {
  if (!sheetName || sheetName === dataset.profile?.active_sheet) return dataset;
  if (!/^[a-zA-Z0-9_-]+$/.test(dataset.file_id)) throw Object.assign(new Error('Mã dataset không hợp lệ.'), { status: 400 });
  const stored = JSON.parse(await fs.promises.readFile(path.join(STORAGE_DIR, `${dataset.file_id}.dataset.json`), 'utf8'));
  const selected = Object.prototype.hasOwnProperty.call(stored.sheets || {}, sheetName) ? stored.sheets[sheetName] : null;
  if (!selected) throw Object.assign(new Error('Sheet không tồn tại hoặc dataset cần được tải lại.'), { status: 400, code: 'SHEET_NOT_FOUND' });
  return { ...dataset, columns: selected.columns, profile: selected.profile };
}

module.exports = {
  getDatasetForSheet,
  processAndProfileDataset,
  queryIsolatedDataset,
  executeAnalyticalQuery,
  parseCsvBuffer,
  profileColumn,
  generateAnalysisSuggestions,
  parseNumericValue,
  parseDateValue,
  truncateDate,
  normalizeHeaderKey,
  MAX_SHEETS,
  MAX_ROWS,
  MAX_COLUMNS,
  MAX_CONCURRENT_QUERIES,
  getActiveConcurrentQueries: () => activeConcurrentQueries,
};
