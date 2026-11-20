/**
 * SOTRANS HUB — BI QUERY PLANNER (PHASE 2.3 & P0.5 STABILIZATION)
 * 
 * Natural Language to Structured Analytical Query Plan Compiler:
 * - Translates Vietnamese natural language queries into safe, structured JSON query plans
 * - Identifies analytical intents: AGGREGATION, GROUPING, RANKING, TREND, COMPARISON, DISTRIBUTION
 * - Semantic Column Profiling: Distinguishes Entity Identifiers, Dimensions, Measures, Counts, and Dates
 * - Accurate Entity Counting: Maps "số lượng [thực thể]" to DISTINCT_COUNT on entity identifier, NOT measure
 * - Token-boundary matching: Prevents "số lượng" from falsely triggering "lương" (salary)
 * - Strict Preposition Grouping: Only adds dimensions preceded by "theo", "mỗi", "từng", etc. to groupBy
 * - Resolves mathematical functions (COUNT, SUM, AVG, MIN, MAX, MEDIAN, DISTINCT_COUNT)
 * - Resolves date grouping (day, month, quarter, year)
 * - Resolves filters, sorting, limits (Top N)
 * - Resolves computations (PERCENTAGE, GROWTH_RATE, PERIOD_COMPARISON)
 * - Resolves chart preferences (BAR, LINE, PIE)
 * - Multi-turn Context Governance: Prevents follow-up hijacking; distinguishes full re-plans from deltas
 * - Strict Security: Zero arbitrary SQL or JS code execution!
 */

// Helper: Normalize string (remove accents, lowercase)
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Check if a word or phrase exists as a distinct token/boundary in text
 */
function hasWordOrPhrase(textNorm, phrase) {
  if (!textNorm || !phrase) return false;
  const pNorm = normalizeText(phrase);
  if (!pNorm) return false;
  const escaped = pNorm.replace(/[^a-z0-9]/g, '\\s+');
  const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return regex.test(textNorm);
}

// Common business aliases in logistics, HR, and finance
const COLUMN_SYNONYMS = {
  doanh_so: ['doanh so', 'doanh thu', 'sales', 'revenue', 'tong thu', 'thanh tien', 'gia tri don'],
  doanh_thu: ['doanh thu', 'doanh so', 'sales', 'revenue', 'tong thu', 'thanh tien', 'gia tri don'],
  luong: ['luong', 'thu nhap', 'salary', 'tien luong', 'tong luong', 'chi phi luong', 'luong co ban', 'bang luong', 'muc luong'],
  phong_ban: ['phong ban', 'bo phan', 'don vi', 'department', 'khoa', 'to', 'nhom', 'phong'],
  nhan_vien: ['nhan vien', 'nhan su', 'ho ten', 'ten', 'employee', 'nguoi', 'can bo', 'lao dong', 'nguoi tao'],
  cong_ty: ['cong ty', 'chi nhanh', 'don vi thanh vien', 'company', 'branch'],
  ngay_tao: ['ngay tao', 'ngay', 'thoi gian', 'date', 'ngay thang', 'thang'],
  so_luong: ['so luong', 'sl', 'qty', 'quantity', 'san luong'],
  chi_phi: ['chi phi', 'cost', 'expense', 'phi', 'tong chi'],
  khach_hang: ['khach hang', 'khach', 'doi tac', 'customer', 'client'],
  trang_thai: ['trang thai', 'tinh trang', 'status'],
  loai_ho_so: ['loai ho so', 'loai van ban', 'loai tai lieu', 'loai', 'loai hinh'],
  chuc_vu: ['chuc vu', 'vi tri', 'cap bac', 'position'],
  gioi_tinh: ['gioi tinh', 'nam nu', 'gender'],
  so_lo: ['so lo', 'lo hang', 'so lo xu ly', 'lo'],
  khoa_dao_tao: ['khoa dao tao', 'dao tao', 'khoa hoc', 'luot hoc', 'khoa dao tao hoan thanh', 'so khoa', 'so khoa dao tao', 'luot hoan thanh'],
  kpi: ['kpi', 'diem kpi', 'hieu suat kpi', 'danh gia kpi', 'diem danh gia'],
  don_hang: ['don hang', 'don', 'so don', 'ma don', 'ma don hang', 'order', 'orders'],
  san_pham: ['san pham', 'ten san pham', 'hang hoa', 'mat hang', 'product', 'item'],
  don_vi_van_chuyen: ['don vi van chuyen', 'nguoi van chuyen', 'nha xe', 'carrier', 'hang van chuyen', 'doi tac van chuyen'],
  ngay_giao_cam_ket: ['ngay giao cam ket', 'han giao', 'ngay cam ket', 'promised date', 'due date'],
  ngay_giao_thuc_te: ['ngay giao thuc te', 'ngay giao hang', 'ngay nhan hang', 'actual date', 'delivery date'],
  trang_thai_giao: ['trang thai giao', 'trang thai giao hang', 'tinh trang giao', 'delivery status'],
};

/**
 * Classify and profile columns by their semantic roles
 */
function profileColumns(columns) {
  const profile = {
    all: columns,
    identifiers: [],      // Entity IDs like ma_nhan_vien, id, cccd, ma_don
    labels: [],           // Entity Names like ho_ten, ten_nhan_vien, nguoi_tao
    dimensions: [],       // Categorical like phong_ban, cong_ty, trang_thai
    measures: [],         // Numeric business amounts like luong, doanh_so
    quantities: [],       // Numeric counts like so_luong, sl, so_lo
    dates: [],            // Date columns like ngay_tao
  };

  for (const col of columns) {
    const keyNorm = normalizeText(col.key);
    const nameNorm = normalizeText(col.name);
    const type = String(col.type || '').toUpperCase();

    // 1. Dates (Must not falsely classify day counts like "so_ngay_nghi", "ngay_cong" as dates)
    const isDayCount = keyNorm.startsWith('so_ngay') || keyNorm.includes('ngay_nghi') || keyNorm.includes('ngay_cong') || keyNorm.includes('ngay_phep');
    if (!isDayCount && (type === 'DATE' || type === 'DATETIME' || ((type !== 'INTEGER' && type !== 'FLOAT') && (keyNorm.includes('ngay') || keyNorm.includes('thoi_gian'))))) {
      profile.dates.push(col);
      continue;
    }

    // 2. Entity Identifier pattern
    const isId =
      keyNorm === 'id' ||
      keyNorm.startsWith('id_') ||
      keyNorm.endsWith('_id') ||
      keyNorm.startsWith('ma_') ||
      keyNorm.endsWith('_ma') ||
      keyNorm.includes('cccd') ||
      keyNorm.includes('cmnd') ||
      keyNorm.includes('employee_id') ||
      keyNorm.includes('ma_nv') ||
      keyNorm.includes('manv') ||
      keyNorm.includes('ma_nhan_vien') ||
      keyNorm.includes('ma_don') ||
      keyNorm.includes('madon') ||
      keyNorm.includes('ma_kh') ||
      keyNorm.includes('makh') ||
      keyNorm.includes('ma_hs') ||
      keyNorm.includes('ma_ho_so') ||
      (type === 'STRING' && col.is_unique && !keyNorm.includes('phong') && !keyNorm.includes('cong_ty'));

    const isLabel =
      keyNorm.includes('ho_ten') ||
      keyNorm.includes('hoten') ||
      keyNorm.includes('ten_nhan_vien') ||
      keyNorm.includes('ten_nv') ||
      keyNorm.includes('nguoi_tao') ||
      keyNorm.includes('nguoi_xu_ly') ||
      keyNorm.includes('nguoi_thuc_hien') ||
      nameNorm.includes('nguoi tao') ||
      nameNorm.includes('ho va ten') ||
      nameNorm.includes('ho ten') ||
      nameNorm.includes('ten khach hang');

    if (isId) {
      profile.identifiers.push(col);
      continue;
    }
    if (isLabel) {
      profile.labels.push(col);
      continue;
    }

    // 3. Numeric Measures vs Quantities
    if (type === 'INTEGER' || type === 'FLOAT') {
      const isQty =
        keyNorm.startsWith('so_luong') ||
        keyNorm === 'sl' ||
        keyNorm === 'qty' ||
        keyNorm === 'quantity' ||
        keyNorm.includes('so_lo') ||
        keyNorm.includes('so_don') ||
        keyNorm.includes('so_lan');

      if (isQty) {
        profile.quantities.push(col);
      } else {
        profile.measures.push(col);
      }
      continue;
    }

    // 4. Categorical Dimensions
    if (type === 'STRING' || type === 'BOOLEAN') {
      profile.dimensions.push(col);
    }
  }

  return profile;
}

/**
 * Match a word or phrase from user prompt to a dataset column
 */
function matchColumnFromText(promptNorm, columns) {
  let bestMatch = null;
  let bestScore = 0;

  for (const col of columns) {
    const colNameNorm = normalizeText(col.name);
    const colKeyNorm = normalizeText(col.key);

    // Exact word or phrase matches
    if (hasWordOrPhrase(promptNorm, colNameNorm) && colNameNorm.length > bestScore) {
      bestMatch = col;
      bestScore = colNameNorm.length;
    } else if (hasWordOrPhrase(promptNorm, colKeyNorm) && colKeyNorm.length > bestScore) {
      bestMatch = col;
      bestScore = colKeyNorm.length;
    }

    // Synonym matches
    for (const [canonical, aliases] of Object.entries(COLUMN_SYNONYMS)) {
      if (colKeyNorm.includes(canonical) || colNameNorm.includes(canonical)) {
        for (const alias of aliases) {
          if (hasWordOrPhrase(promptNorm, alias) && alias.length > bestScore) {
            bestMatch = col;
            bestScore = alias.length;
          }
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Extract numeric threshold from Vietnamese text
 */
function parseThresholdValue(text) {
  const norm = normalizeText(text);

  // Clean out referential phrases like "file trên", "ở trên", "bảng trên" before parsing
  const cleanNorm = norm
    .replace(/\b(?:file|tep|o|nhu|bang|danh sach|du lieu)\s+tren\b/g, '')
    .replace(/\btren\s+day\b/g, '');

  // Must be in comparison context: e.g. "tren 10 trieu", "lon hon 50", "tu 20tr", "> 50"
  const compMatch = cleanNorm.match(/(?:(?:^|[^a-z0-9])(?:tren|lon hon|cao hon|duoi|nho hon|thap hon|tu|>|<|>=|<=))\s*(\d+(?:[.,]\d+)?\s*(?:ty|ti|billion|trieu|tr|m|million|k|ngan|nghin|thousand)?)/i);
  if (!compMatch) return null;

  const numPart = compMatch[1].trim();

  // Match "X ty"
  const tyMatch = numPart.match(/^(\d+(?:[.,]\d+)?)\s*(?:ty|ti|billion)/);
  if (tyMatch) {
    const val = parseFloat(tyMatch[1].replace(',', '.'));
    return val * 1000000000;
  }

  // Match "X trieu"
  const trMatch = numPart.match(/^(\d+(?:[.,]\d+)?)\s*(?:trieu|tr|m|million)/);
  if (trMatch) {
    const val = parseFloat(trMatch[1].replace(',', '.'));
    return val * 1000000;
  }

  // Match "X k / ngan"
  const kMatch = numPart.match(/^(\d+(?:[.,]\d+)?)\s*(?:k|ngan|nghin|thousand)/);
  if (kMatch) {
    const val = parseFloat(kMatch[1].replace(',', '.'));
    return val * 1000;
  }

  // Direct number
  const directMatch = numPart.match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)/);
  if (directMatch) {
    const cleanNum = directMatch[1].replace(/[.,]/g, '');
    return Number(cleanNum);
  }

  return null;
}

/**
 * Detect multiple metrics in composite / multi-requirement prompts
 */
function detectMultipleMetrics(promptNorm, colProfile, columns) {
  const metrics = [];
  const computations = [];

  // 1. Employee / Entity count
  const isCountEntity =
    hasWordOrPhrase(promptNorm, 'so luong nhan vien') ||
    hasWordOrPhrase(promptNorm, 'so luong nhan su') ||
    hasWordOrPhrase(promptNorm, 'so nhan vien') ||
    hasWordOrPhrase(promptNorm, 'so nhan su') ||
    hasWordOrPhrase(promptNorm, 'dem nhan vien') ||
    hasWordOrPhrase(promptNorm, 'dem nhan su') ||
    hasWordOrPhrase(promptNorm, 'quy mo nhan su') ||
    hasWordOrPhrase(promptNorm, 'so luong can bo');

  let empCol = null;
  if (isCountEntity) {
    empCol =
      colProfile.identifiers.find((c) => {
        const k = normalizeText(c.key);
        return k.includes('nhan_vien') || k.includes('nv') || k.includes('emp') || k === 'id';
      }) ||
      colProfile.labels.find((c) => normalizeText(c.key).includes('ho_ten') || normalizeText(c.key).includes('ten')) ||
      colProfile.identifiers[0];

    if (empCol) {
      metrics.push({
        column: empCol.key,
        func: 'DISTINCT_COUNT',
        alias: `distinct_count_${empCol.key}`,
      });
    }
  }

  // 2. Headcount Share / Percentage (Tỷ trọng)
  const isShareMention =
    hasWordOrPhrase(promptNorm, 'ty trong nhan su') ||
    hasWordOrPhrase(promptNorm, 'ty trong nhan vien') ||
    hasWordOrPhrase(promptNorm, 'ty trong') ||
    hasWordOrPhrase(promptNorm, 'ty le nhan su') ||
    hasWordOrPhrase(promptNorm, 'ty le');

  if (isShareMention && empCol) {
    computations.push({
      type: 'PERCENTAGE',
      source_alias: `distinct_count_${empCol.key}`,
      target_alias: `distinct_count_${empCol.key}_ty_trong_pct`,
    });
  }

  // 3 & 4. Salary Metrics (Lương trung bình & Tổng quỹ lương)
  const isAvgSalaryMention =
    hasWordOrPhrase(promptNorm, 'luong trung binh') ||
    hasWordOrPhrase(promptNorm, 'thu nhap trung binh') ||
    hasWordOrPhrase(promptNorm, 'binh quan luong') ||
    hasWordOrPhrase(promptNorm, 'luong tb');

  const isSumSalaryMention =
    hasWordOrPhrase(promptNorm, 'tong quy luong') ||
    hasWordOrPhrase(promptNorm, 'chi phi luong') ||
    hasWordOrPhrase(promptNorm, 'quy luong') ||
    hasWordOrPhrase(promptNorm, 'tong tien luong') ||
    hasWordOrPhrase(promptNorm, 'tong luong co ban') ||
    hasWordOrPhrase(promptNorm, 'tong luong') ||
    hasWordOrPhrase(promptNorm, 'tong thu nhap');

  const salCol = colProfile.measures.find((c) => {
    const k = normalizeText(c.key);
    const n = normalizeText(c.name);
    return k.includes('luong') || k.includes('salary') || k.includes('thu_nhap') || n.includes('luong');
  });

  if (salCol) {
    if (isAvgSalaryMention && isSumSalaryMention) {
      const idxAvg = Math.min(
        promptNorm.indexOf('luong trung binh') !== -1 ? promptNorm.indexOf('luong trung binh') : Infinity,
        promptNorm.indexOf('thu nhap trung binh') !== -1 ? promptNorm.indexOf('thu nhap trung binh') : Infinity,
        promptNorm.indexOf('binh quan luong') !== -1 ? promptNorm.indexOf('binh quan luong') : Infinity
      );
      const idxSum = Math.min(
        promptNorm.indexOf('tong luong') !== -1 ? promptNorm.indexOf('tong luong') : Infinity,
        promptNorm.indexOf('tong quy luong') !== -1 ? promptNorm.indexOf('tong quy luong') : Infinity,
        promptNorm.indexOf('chi phi luong') !== -1 ? promptNorm.indexOf('chi phi luong') : Infinity,
        promptNorm.indexOf('tong tien luong') !== -1 ? promptNorm.indexOf('tong tien luong') : Infinity
      );
      if (idxSum < idxAvg) {
        metrics.push({ column: salCol.key, func: 'SUM', alias: `sum_${salCol.key}` });
        metrics.push({ column: salCol.key, func: 'AVG', alias: `avg_${salCol.key}` });
      } else {
        metrics.push({ column: salCol.key, func: 'AVG', alias: `avg_${salCol.key}` });
        metrics.push({ column: salCol.key, func: 'SUM', alias: `sum_${salCol.key}` });
      }
    } else if (isAvgSalaryMention) {
      metrics.push({ column: salCol.key, func: 'AVG', alias: `avg_${salCol.key}` });
    } else if (isSumSalaryMention) {
      metrics.push({ column: salCol.key, func: 'SUM', alias: `sum_${salCol.key}` });
    }
  }

  // 5. Average KPI (Prevent false trigger from UI request like "KPI Cards", "thẻ KPI")
  const isKpiCardUiMention =
    hasWordOrPhrase(promptNorm, 'kpi cards') ||
    hasWordOrPhrase(promptNorm, 'kpi card') ||
    hasWordOrPhrase(promptNorm, 'the kpi') ||
    hasWordOrPhrase(promptNorm, 'hien thi kpi') ||
    hasWordOrPhrase(promptNorm, 'cards');

  const isKpiMention =
    hasWordOrPhrase(promptNorm, 'kpi trung binh') ||
    hasWordOrPhrase(promptNorm, 'diem kpi') ||
    hasWordOrPhrase(promptNorm, 'kpi tb') ||
    hasWordOrPhrase(promptNorm, 'hieu suat kpi') ||
    (hasWordOrPhrase(promptNorm, 'kpi') && !isKpiCardUiMention);

  if (isKpiMention) {
    const kpiCol = colProfile.measures.find((c) => {
      const k = normalizeText(c.key);
      const n = normalizeText(c.name);
      return k.includes('kpi') || n.includes('kpi');
    });
    if (kpiCol) {
      metrics.push({
        column: kpiCol.key,
        func: 'AVG',
        alias: `avg_${kpiCol.key}`,
      });
    }
  }

  // 6. Overtime Hours (Giờ tăng ca)
  const isSumOtMention =
    hasWordOrPhrase(promptNorm, 'tong gio tang ca') ||
    hasWordOrPhrase(promptNorm, 'tong so gio tang ca') ||
    hasWordOrPhrase(promptNorm, 'tong tang ca') ||
    hasWordOrPhrase(promptNorm, 'tong ot');

  const isAvgOtMention =
    hasWordOrPhrase(promptNorm, 'gio tang ca trung binh') ||
    hasWordOrPhrase(promptNorm, 'tang ca trung binh') ||
    hasWordOrPhrase(promptNorm, 'ot trung binh') ||
    hasWordOrPhrase(promptNorm, 'trung binh gio tang ca');

  const isOtMention =
    isSumOtMention ||
    isAvgOtMention ||
    hasWordOrPhrase(promptNorm, 'gio tang ca') ||
    hasWordOrPhrase(promptNorm, 'tang ca') ||
    hasWordOrPhrase(promptNorm, 'ot');

  if (isOtMention) {
    const otCol = colProfile.measures.concat(colProfile.quantities).find((c) => {
      const k = normalizeText(c.key);
      const n = normalizeText(c.name);
      return k.includes('tang_ca') || k.includes('ot') || n.includes('tang ca');
    });
    if (otCol) {
      if (isSumOtMention && !isAvgOtMention) {
        metrics.push({
          column: otCol.key,
          func: 'SUM',
          alias: `sum_${otCol.key}`,
        });
      } else if (isAvgOtMention && !isSumOtMention) {
        metrics.push({
          column: otCol.key,
          func: 'AVG',
          alias: `avg_${otCol.key}`,
        });
      } else if (isSumOtMention && isAvgOtMention) {
        metrics.push({
          column: otCol.key,
          func: 'SUM',
          alias: `sum_${otCol.key}`,
        });
        metrics.push({
          column: otCol.key,
          func: 'AVG',
          alias: `avg_${otCol.key}`,
        });
      } else {
        metrics.push({
          column: otCol.key,
          func: 'AVG',
          alias: `avg_${otCol.key}`,
        });
      }
    }
  }

  // 7. Leave Days (Số ngày nghỉ)
  const isSumLeaveMention =
    hasWordOrPhrase(promptNorm, 'tong so ngay nghi') ||
    hasWordOrPhrase(promptNorm, 'tong ngay nghi') ||
    hasWordOrPhrase(promptNorm, 'tong nghi phep') ||
    hasWordOrPhrase(promptNorm, 'tong so ngay phep');

  const isAvgLeaveMention =
    hasWordOrPhrase(promptNorm, 'so ngay nghi trung binh') ||
    hasWordOrPhrase(promptNorm, 'ngay nghi trung binh') ||
    hasWordOrPhrase(promptNorm, 'nghi phep trung binh') ||
    hasWordOrPhrase(promptNorm, 'trung binh so ngay nghi');

  const isLeaveMention =
    isSumLeaveMention ||
    isAvgLeaveMention ||
    hasWordOrPhrase(promptNorm, 'ngay nghi') ||
    hasWordOrPhrase(promptNorm, 'so ngay nghi') ||
    hasWordOrPhrase(promptNorm, 'nghi phep') ||
    hasWordOrPhrase(promptNorm, 'phep');

  if (isLeaveMention) {
    const leaveCol = colProfile.measures.concat(colProfile.quantities).find((c) => {
      const k = normalizeText(c.key);
      const n = normalizeText(c.name);
      return k.includes('ngay_nghi') || k.includes('phep') || n.includes('ngay nghi');
    });
    if (leaveCol) {
      if (isSumLeaveMention && !isAvgLeaveMention) {
        metrics.push({
          column: leaveCol.key,
          func: 'SUM',
          alias: `sum_${leaveCol.key}`,
        });
      } else if (isAvgLeaveMention && !isSumLeaveMention) {
        metrics.push({
          column: leaveCol.key,
          func: 'AVG',
          alias: `avg_${leaveCol.key}`,
        });
      } else if (isSumLeaveMention && isAvgLeaveMention) {
        metrics.push({
          column: leaveCol.key,
          func: 'SUM',
          alias: `sum_${leaveCol.key}`,
        });
        metrics.push({
          column: leaveCol.key,
          func: 'AVG',
          alias: `avg_${leaveCol.key}`,
        });
      } else {
        metrics.push({
          column: leaveCol.key,
          func: 'AVG',
          alias: `avg_${leaveCol.key}`,
        });
      }
    }
  }

  return { metrics, computations, empColKey: empCol ? empCol.key : null };
}

/**
 * Decompose composite/multi-intent analytical queries into individual verifiable requirements
 */
function decomposeCompositeRequirements(promptNorm, promptRaw, datasetProfile, columns, colProfile) {
  const isTrainingAsked =
    hasWordOrPhrase(promptNorm, 'dao tao') ||
    hasWordOrPhrase(promptNorm, 'khoa hoc') ||
    hasWordOrPhrase(promptNorm, 'khoa dao tao') ||
    hasWordOrPhrase(promptNorm, 'khoa dao tao hoan thanh');

  const isSalesAsked =
    hasWordOrPhrase(promptNorm, 'doanh thu') ||
    hasWordOrPhrase(promptNorm, 'doanh so') ||
    hasWordOrPhrase(promptNorm, 'ban hang') ||
    (hasWordOrPhrase(promptNorm, 'don hang') && (hasWordOrPhrase(promptNorm, 'doanh thu') || hasWordOrPhrase(promptNorm, 'san pham')));

  const isLogisticsAsked =
    hasWordOrPhrase(promptNorm, 'dung han') ||
    hasWordOrPhrase(promptNorm, 'giao hang') ||
    hasWordOrPhrase(promptNorm, 'van chuyen') ||
    hasWordOrPhrase(promptNorm, 'ty le giao');

  // Check if prompt is structured as a multi-part question
  const isCompositeStructure =
    promptNorm.includes(',') ||
    promptNorm.includes(':') ||
    promptNorm.includes(';') ||
    hasWordOrPhrase(promptNorm, 'tinh hinh dao tao') ||
    hasWordOrPhrase(promptNorm, 'bao cao dao tao') ||
    hasWordOrPhrase(promptNorm, 'bao cao tinh hinh dao tao') ||
    hasWordOrPhrase(promptNorm, 'bao cao doanh so') ||
    hasWordOrPhrase(promptNorm, 'bao cao giao hang') ||
    (hasWordOrPhrase(promptNorm, 'va') && (hasWordOrPhrase(promptNorm, 'top') || hasWordOrPhrase(promptNorm, 'trung binh') || hasWordOrPhrase(promptNorm, 'theo')));

  // CASE 0: WORKFORCE STATUS & HEADCOUNT COMPOSITION (Without salary/overtime)
  const isWorkforceStatusAsked =
    (
      hasWordOrPhrase(promptNorm, 'tinh trang nhan vien') ||
      hasWordOrPhrase(promptNorm, 'trang thai nhan vien') ||
      hasWordOrPhrase(promptNorm, 'co cau trang thai') ||
      hasWordOrPhrase(promptNorm, 'so luong va ty le nhan vien theo tung trang thai') ||
      hasWordOrPhrase(promptNorm, 'ty le nhan vien theo tung trang thai') ||
      (hasWordOrPhrase(promptNorm, 'trang thai') && (
        hasWordOrPhrase(promptNorm, 'ty le') ||
        hasWordOrPhrase(promptNorm, 'dang lam viec thap nhat') ||
        (hasWordOrPhrase(promptNorm, 'phong ban') && hasWordOrPhrase(promptNorm, 'dang lam viec'))
      ))
    ) &&
    !hasWordOrPhrase(promptNorm, 'tong quy luong') &&
    !hasWordOrPhrase(promptNorm, 'luong trung binh') &&
    !hasWordOrPhrase(promptNorm, 'gio tang ca');

  const statusCol = columns.find((c) =>
    /(trang_thai|status|tinh_trang)/i.test(c.key) ||
    /(trang thai|tinh trang)/i.test(normalizeText(c.name))
  );

  if (isWorkforceStatusAsked && statusCol) {
    const deptCol = colProfile.dimensions.find((c) => /(phong|dept|bo_phan)/i.test(c.key)) ||
      columns.find((c) => /(phong|dept|bo_phan)/i.test(c.key)) ||
      { key: 'phong_ban', name: 'Phòng Ban' };
    const empIdCol = colProfile.identifiers.find((c) => /(nhan_vien|nv|emp|id)/i.test(c.key)) ||
      colProfile.identifiers[0] ||
      { key: 'ma_nhan_vien', name: 'Mã Nhân Viên' };

    const requirements = [];

    // 1. Total Headcount (REQ-01)
    requirements.push({
      id: 'req_status_total_headcount',
      requirement_id: 'REQ-01',
      original_user_request: 'Tổng số nhân viên toàn công ty',
      title: 'Tổng số nhân viên',
      type: 'METRIC',
      func: 'DISTINCT_COUNT',
      column: empIdCol ? empIdCol.key : 'ma_nhan_vien',
      unit: 'nhân sự',
      visualization_type: 'KPI_CARD',
      status: 'AVAILABLE',
      subtext: 'Toàn bộ nhân sự công ty',
    });

    // 2. Active Status (REQ-02)
    requirements.push({
      id: 'req_status_active',
      requirement_id: 'REQ-02',
      original_user_request: 'Số lượng và tỷ lệ nhân viên đang làm việc',
      title: 'Đang làm việc',
      type: 'METRIC',
      func: 'COUNT',
      column: empIdCol ? empIdCol.key : statusCol.key,
      filters: [{ column: statusCol.key, op: 'eq', value: 'Đang làm việc' }],
      unit: 'nhân sự',
      visualization_type: 'KPI_CARD',
      status: 'AVAILABLE',
    });

    // 3. Resigned Status (REQ-03)
    requirements.push({
      id: 'req_status_resigned',
      requirement_id: 'REQ-03',
      original_user_request: 'Số lượng và tỷ lệ nhân viên đã nghỉ việc',
      title: 'Đã nghỉ việc',
      type: 'METRIC',
      func: 'COUNT',
      column: empIdCol ? empIdCol.key : statusCol.key,
      filters: [{ column: statusCol.key, op: 'eq', value: 'Đã nghỉ việc' }],
      unit: 'nhân sự',
      visualization_type: 'KPI_CARD',
      status: 'AVAILABLE',
    });

    // 4. Maternity Leave Status (REQ-04)
    requirements.push({
      id: 'req_status_maternity',
      requirement_id: 'REQ-04',
      original_user_request: 'Số lượng và tỷ lệ nhân viên thai sản',
      title: 'Thai sản',
      type: 'METRIC',
      func: 'COUNT',
      column: empIdCol ? empIdCol.key : statusCol.key,
      filters: [{ column: statusCol.key, op: 'eq', value: 'Thai sản' }],
      unit: 'nhân sự',
      visualization_type: 'KPI_CARD',
      status: 'AVAILABLE',
    });

    // 5. Lowest Active Ratio Department (REQ-05)
    if (
      hasWordOrPhrase(promptNorm, 'thap nhat') ||
      hasWordOrPhrase(promptNorm, 'ty le') ||
      hasWordOrPhrase(promptNorm, 'dang lam viec thap nhat') ||
      hasWordOrPhrase(promptNorm, 'xac dinh phong ban')
    ) {
      requirements.push({
        id: 'req_lowest_active_dept',
        requirement_id: 'REQ-05',
        original_user_request: 'Xác định phòng ban có tỷ lệ nhân viên đang làm việc thấp nhất',
        title: 'Tỷ lệ đang làm việc thấp nhất',
        type: 'METRIC',
        unit: '%',
        visualization_type: 'KPI_CARD',
        status: (deptCol && statusCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: (deptCol && statusCol) ? null : 'Thiếu cột phòng ban hoặc trạng thái để tính tỷ lệ.',
      });
    }

    // 6. Status Breakdown Pie Chart (REQ-06)
    requirements.push({
      id: 'req_status_pie',
      requirement_id: 'REQ-06',
      original_user_request: 'Cơ cấu nhân sự theo trạng thái (Pie Chart)',
      title: 'Cơ cấu nhân sự theo trạng thái',
      type: 'GROUP_BY',
      groupBy: [statusCol.key],
      dimension: statusCol.key,
      column: empIdCol ? empIdCol.key : statusCol.key,
      func: 'COUNT',
      alias: 'so_luong',
      unit: 'nhân sự',
      visualization_type: 'PIE',
      status: 'AVAILABLE',
    });

    // 7. Department Status Breakdown Bar Chart (REQ-07)
    if (
      hasWordOrPhrase(promptNorm, 'theo phong ban') ||
      hasWordOrPhrase(promptNorm, 'co cau trang thai theo phong ban') ||
      hasWordOrPhrase(promptNorm, 'phong ban') ||
      hasWordOrPhrase(promptNorm, 'bar chart')
    ) {
      requirements.push({
        id: 'req_dept_status_bar',
        requirement_id: 'REQ-07',
        original_user_request: 'Cơ cấu trạng thái và tỷ lệ đang làm việc theo phòng ban (Bar Chart)',
        title: 'Cơ cấu trạng thái và tỷ lệ đang làm việc theo phòng ban',
        type: 'DEPT_STATUS_ANALYSIS',
        dimension: deptCol.key,
        status_col: statusCol.key,
        visualization_type: 'BAR',
        status: (deptCol && statusCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: (deptCol && statusCol) ? null : 'Thiếu cột phòng ban hoặc trạng thái.',
      });
    }

    return requirements;
  }

  // CASE A: TRAINING & PERFORMANCE (HR)
  if (isTrainingAsked && (isCompositeStructure || hasWordOrPhrase(promptNorm, 'khoa dao tao'))) {
    const trainingCol = columns.find((c) =>
      /(khoa.*dao.*tao|dao.*tao|khoa_hoc|khoa_dao_tao_hoan_thanh)/i.test(c.key) ||
      /(khoa.*dao.*tao|dao.*tao)/i.test(normalizeText(c.name))
    );
    const empIdCol = colProfile.identifiers.find((c) => /(nhan_vien|nv|emp)/i.test(c.key)) || colProfile.identifiers[0];
    const kpiCol = columns.find((c) => /kpi/i.test(c.key) || /kpi/i.test(c.name));
    const deptCol = colProfile.dimensions.find((c) => /(phong|dept|bo_phan)/i.test(c.key)) || { key: 'phong_ban', name: 'Phòng Ban' };

    if (trainingCol) {
      const requirements = [];

      // 1. Total completed courses
      if (
        hasWordOrPhrase(promptNorm, 'tong so khoa') ||
        hasWordOrPhrase(promptNorm, 'tong khoa') ||
        hasWordOrPhrase(promptNorm, 'tong so khoa hoan thanh') ||
        hasWordOrPhrase(promptNorm, 'tong luot') ||
        hasWordOrPhrase(promptNorm, 'tong so luot') ||
        hasWordOrPhrase(promptNorm, 'bao cao tinh hinh dao tao') ||
        hasWordOrPhrase(promptNorm, 'bao cao dao tao')
      ) {
        requirements.push({
          id: 'req_total_completed',
          title: 'Tổng số khóa hoàn thành',
          type: 'METRIC',
          func: 'SUM',
          column: trainingCol.key,
          unit: 'lượt hoàn thành',
          status: 'AVAILABLE',
        });
      }

      // 2. Average per employee
      if (
        hasWordOrPhrase(promptNorm, 'trung binh') ||
        hasWordOrPhrase(promptNorm, 'so khoa trung binh') ||
        hasWordOrPhrase(promptNorm, 'binh quan') ||
        hasWordOrPhrase(promptNorm, 'moi nguoi')
      ) {
        requirements.push({
          id: 'req_avg_completed',
          title: 'Số khóa trung bình mỗi người',
          type: 'METRIC',
          func: 'AVG',
          column: trainingCol.key,
          unit: 'khóa/người',
          status: 'AVAILABLE',
        });
      }

      // 3. Number with 0 courses
      if (
        hasWordOrPhrase(promptNorm, '0 khoa') ||
        hasWordOrPhrase(promptNorm, 'khong khoa') ||
        hasWordOrPhrase(promptNorm, 'chua co khoa') ||
        hasWordOrPhrase(promptNorm, 'chua hoc') ||
        hasWordOrPhrase(promptNorm, 'chua tham gia') ||
        hasWordOrPhrase(promptNorm, 'chua hoan thanh') ||
        hasWordOrPhrase(promptNorm, 'chua hoan thanh khoa nao')
      ) {
        requirements.push({
          id: 'req_zero_courses',
          title: 'Số nhân sự có 0 khóa đào tạo',
          type: 'METRIC',
          func: 'COUNT',
          column: empIdCol ? empIdCol.key : trainingCol.key,
          filters: [{ column: trainingCol.key, op: 'eq', value: 0 }],
          unit: 'người',
          status: 'AVAILABLE',
        });
      }

      // 4. Department breakdown
      if (
        hasWordOrPhrase(promptNorm, 'theo phong ban') ||
        hasWordOrPhrase(promptNorm, 'tung phong ban') ||
        hasWordOrPhrase(promptNorm, 'thong ke theo phong ban') ||
        hasWordOrPhrase(promptNorm, 'cac phong ban') ||
        hasWordOrPhrase(promptNorm, 'phong ban')
      ) {
        requirements.push({
          id: 'req_dept_breakdown',
          title: 'Thống kê khóa đào tạo theo phòng ban',
          type: 'GROUP_BY',
          groupBy: [deptCol.key],
          column: trainingCol.key,
          func: 'SUM',
          alias: 'tong_khoa_hoan_thanh',
          unit: 'lượt hoàn thành',
          status: 'AVAILABLE',
        });
      }

      // 5. Top 10 employees
      if (
        hasWordOrPhrase(promptNorm, 'top 10') ||
        hasWordOrPhrase(promptNorm, 'top nhan vien') ||
        hasWordOrPhrase(promptNorm, 'cao nhat')
      ) {
        const topLimitMatch = promptNorm.match(/top\s*(\d+)/i);
        const limitVal = topLimitMatch ? parseInt(topLimitMatch[1], 10) : 10;
        requirements.push({
          id: 'req_top_10_employees',
          title: `Top ${limitVal} nhân viên có số khóa đào tạo cao nhất`,
          type: 'RANKING',
          limit: limitVal,
          column: trainingCol.key,
          orderBy: [
            { col: trainingCol.key, dir: 'DESC' },
            { col: kpiCol ? kpiCol.key : 'diem_kpi', dir: 'DESC' },
            { col: empIdCol ? empIdCol.key : 'ma_nhan_vien', dir: 'ASC' },
          ],
          status: 'AVAILABLE',
        });
      }

      // 6. KPI by course count (0 to 5)
      if (
        hasWordOrPhrase(promptNorm, 'kpi theo so khoa') ||
        hasWordOrPhrase(promptNorm, 'kpi theo khoa') ||
        hasWordOrPhrase(promptNorm, 'phan tich kpi') ||
        (hasWordOrPhrase(promptNorm, 'kpi') && hasWordOrPhrase(promptNorm, '0 den 5')) ||
        (hasWordOrPhrase(promptNorm, 'kpi') && hasWordOrPhrase(promptNorm, 'tu 0'))
      ) {
        requirements.push({
          id: 'req_kpi_by_courses',
          title: 'Phân tích điểm KPI theo số khóa đào tạo (0 - 5)',
          type: 'CORRELATION_BREAKDOWN',
          dimension: trainingCol.key,
          target_measure: kpiCol ? kpiCol.key : 'diem_kpi',
          discrete_values: [0, 1, 2, 3, 4, 5],
          status: kpiCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
          reason: kpiCol ? null : 'Bộ dữ liệu không có cột điểm KPI.',
        });
      }

      // Missing metric check (e.g. chi phí đào tạo)
      if (hasWordOrPhrase(promptNorm, 'chi phi dao tao') || hasWordOrPhrase(promptNorm, 'ngan sach dao tao')) {
        const costCol = columns.find((c) => /(chi_phi_dao_tao|ngan_sach_dao_tao)/i.test(c.key));
        requirements.push({
          id: 'req_missing_training_cost',
          title: 'Chi phí đào tạo',
          type: 'METRIC',
          status: costCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
          reason: costCol ? null : 'Tệp không chứa thông tin chi phí đào tạo (cần bổ sung cột Chi Phí Đào Tạo).',
        });
      }

      if (requirements.length > 0) {
        return requirements;
      }
    }
  }

  // CASE B: SALES & ORDERS
  if (isSalesAsked && isCompositeStructure) {
    const revCol = columns.find((c) =>
      /(doanh_thu|doanh_so|tong_tien|thanh_tien|revenue|sales|tong_gia_tri)/i.test(c.key) ||
      /(doanh thu|doanh so|tong tien|thanh tien)/i.test(normalizeText(c.name))
    );
    const orderIdCol = columns.find((c) =>
      /(ma_don|order_id|so_don|ma_don_hang)/i.test(c.key) ||
      /(ma don|order id)/i.test(normalizeText(c.name))
    );
    const productCol = columns.find((c) =>
      /(san_pham|product|ten_sp|hang_hoa|mat_hang)/i.test(c.key) ||
      /(san pham|ten sp|mat hang)/i.test(normalizeText(c.name))
    );
    const orderDateCol = colProfile.dates[0] || columns.find((c) => /(ngay_dat|ngay_tao|order_date|ngay_don)/i.test(c.key));

    const requirements = [];
    if (hasWordOrPhrase(promptNorm, 'tong doanh thu') || hasWordOrPhrase(promptNorm, 'doanh thu')) {
      requirements.push({
        id: 'req_total_revenue',
        title: 'Tổng doanh thu',
        type: 'METRIC',
        func: 'SUM',
        column: revCol ? revCol.key : 'doanh_thu',
        unit: 'VNĐ',
        status: revCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: revCol ? null : 'Tệp không chứa cột doanh thu/số tiền.',
      });
    }

    if (hasWordOrPhrase(promptNorm, 'so don') || hasWordOrPhrase(promptNorm, 'so don hang') || hasWordOrPhrase(promptNorm, 'don phan biet')) {
      requirements.push({
        id: 'req_distinct_orders',
        title: 'Số đơn hàng phân biệt',
        type: 'METRIC',
        func: 'DISTINCT_COUNT',
        column: orderIdCol ? orderIdCol.key : 'ma_don',
        unit: 'đơn hàng',
        status: orderIdCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: orderIdCol ? null : 'Tệp không chứa cột mã đơn hàng để đếm đơn phân biệt.',
      });
    }

    if (hasWordOrPhrase(promptNorm, 'theo thang') || hasWordOrPhrase(promptNorm, 'xu huong')) {
      requirements.push({
        id: 'req_monthly_revenue',
        title: 'Doanh thu theo tháng',
        type: 'TREND',
        groupBy: [{ column: orderDateCol ? orderDateCol.key : 'ngay', date_trunc: 'month' }],
        column: revCol ? revCol.key : 'doanh_thu',
        func: 'SUM',
        alias: 'tong_doanh_thu',
        unit: 'VNĐ',
        status: (revCol && orderDateCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: (revCol && orderDateCol) ? null : 'Thiếu cột ngày tháng hoặc doanh thu để phân tích xu hướng.',
      });
    }

    if (hasWordOrPhrase(promptNorm, 'top san pham') || hasWordOrPhrase(promptNorm, 'san pham ban chay')) {
      requirements.push({
        id: 'req_top_products',
        title: 'Top sản phẩm bán chạy',
        type: 'GROUP_BY',
        groupBy: [productCol ? productCol.key : 'san_pham'],
        column: revCol ? revCol.key : 'doanh_thu',
        func: 'SUM',
        alias: 'tong_doanh_thu',
        unit: 'VNĐ',
        status: (revCol && productCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: (revCol && productCol) ? null : 'Thiếu cột sản phẩm hoặc doanh thu.',
      });
    }

    if (requirements.length > 0) {
      return requirements;
    }
  }

  // CASE C: LOGISTICS & ON-TIME DELIVERY
  if (isLogisticsAsked) {
    const carrierCol = columns.find((c) =>
      /(don_vi_van_chuyen|nguoi_van_chuyen|carrier|nha_xe|van_tai|doi_tac_vc)/i.test(c.key) ||
      /(van chuyen|nha xe|carrier)/i.test(normalizeText(c.name))
    );
    const promisedCol = columns.find((c) =>
      /(ngay_giao_cam_ket|promised|han_giao|ngay_cam_ket)/i.test(c.key) ||
      /(cam ket|han giao|han chot)/i.test(normalizeText(c.name))
    );
    const actualCol = columns.find((c) =>
      c.key !== promisedCol?.key && (
        /(ngay_giao_thuc_te|actual|ngay_nhan|giao_thuc_te)/i.test(c.key) ||
        /(thuc te|ngay nhan|hoan tat)/i.test(normalizeText(c.name)) ||
        (/(ngay giao)/i.test(normalizeText(c.name)) && !/(cam ket|han giao)/i.test(normalizeText(c.name)))
      )
    );
    const statusCol = columns.find((c) => /(trang_thai|status|tinh_trang)/i.test(c.key));

    const requirements = [{
      id: 'req_on_time_rate',
      title: 'Tỷ lệ giao hàng đúng hạn theo đơn vị vận chuyển',
      type: 'RATIO',
      dimension: carrierCol ? carrierCol.key : 'don_vi_van_chuyen',
      promised_date_col: promisedCol?.key,
      actual_date_col: actualCol?.key,
      status_col: statusCol?.key,
      delivered_status_value: 'Da_giao',
      status: (carrierCol && promisedCol && actualCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
      reason: (carrierCol && promisedCol && actualCol) ? null : 'Thiếu cột ngày giao cam kết hoặc ngày giao thực tế để tính tỷ lệ đúng hạn.',
    }];

    return requirements;
  }

  // CASE D: PAYROLL & SALARY DISTRIBUTION
  const isPayrollAsked =
    hasWordOrPhrase(promptNorm, 'quy luong') ||
    hasWordOrPhrase(promptNorm, 'tien luong') ||
    hasWordOrPhrase(promptNorm, 'bang luong') ||
    hasWordOrPhrase(promptNorm, 'luong co ban') ||
    hasWordOrPhrase(promptNorm, 'chi phi luong') ||
    hasWordOrPhrase(promptNorm, 'phan tich quy luong') ||
    hasWordOrPhrase(promptNorm, 'phan tich luong') ||
    hasWordOrPhrase(promptNorm, 'nhom muc luong') ||
    hasWordOrPhrase(promptNorm, 'nhom luong') ||
    hasWordOrPhrase(promptNorm, 'phan bo quy luong') ||
    (hasWordOrPhrase(promptNorm, 'luong') && !hasWordOrPhrase(promptNorm, 'so luong') && (
      isCompositeStructure ||
      hasWordOrPhrase(promptNorm, 'phong ban') ||
      hasWordOrPhrase(promptNorm, 'chuc vu') ||
      hasWordOrPhrase(promptNorm, 'top') ||
      hasWordOrPhrase(promptNorm, 'trung binh') ||
      hasWordOrPhrase(promptNorm, 'cao nhat')
    ));

  const isMultiBreakdownStatusDept = (hasWordOrPhrase(promptNorm, 'trang thai') || hasWordOrPhrase(promptNorm, 'tinh trang')) &&
    (hasWordOrPhrase(promptNorm, 'phong ban') || hasWordOrPhrase(promptNorm, 'bo phan')) &&
    (hasWordOrPhrase(promptNorm, 'pie') || hasWordOrPhrase(promptNorm, 'tron') || hasWordOrPhrase(promptNorm, 'tong quan'));

  const isDeptComparisonMultiMetric = hasWordOrPhrase(promptNorm, 'so sanh') &&
    (hasWordOrPhrase(promptNorm, 'phong ban') || hasWordOrPhrase(promptNorm, 'bo phan')) &&
    !hasWordOrPhrase(promptNorm, 'nhom muc luong') &&
    !hasWordOrPhrase(promptNorm, 'nhom luong') &&
    !hasWordOrPhrase(promptNorm, 'top 10') &&
    !hasWordOrPhrase(promptNorm, 'phan tich quy luong') &&
    !hasWordOrPhrase(promptNorm, 'bang xep hang');

  if (!isMultiBreakdownStatusDept && !isDeptComparisonMultiMetric && isPayrollAsked && (isCompositeStructure || hasWordOrPhrase(promptNorm, 'phan tich') || hasWordOrPhrase(promptNorm, 'quy luong') || hasWordOrPhrase(promptNorm, 'nhom muc luong') || hasWordOrPhrase(promptNorm, 'nhom luong') || hasWordOrPhrase(promptNorm, 'phan loai'))) {
    const salCol = columns.find((c) =>
      /(luong.*co.*ban|luong|salary|thu.*nhap)/i.test(c.key) ||
      /(luong.*co.*ban|luong|thu.*nhap)/i.test(normalizeText(c.name))
    );
    const deptCol = colProfile.dimensions.find((c) => /(phong|dept|bo.*phan)/i.test(c.key)) ||
      columns.find((c) => /(phong|dept|bo.*phan)/i.test(c.key)) ||
      { key: 'phong_ban', name: 'Phòng Ban' };
    const titleCol = colProfile.dimensions.find((c) => /(chuc.*vu|vi.*tri|position|chuc.*danh)/i.test(c.key)) ||
      columns.find((c) => /(chuc.*vu|vi.*tri|position)/i.test(c.key)) ||
      { key: 'chuc_vu', name: 'Chức Vụ' };
    const empIdCol = colProfile.identifiers.find((c) => /(nhan_vien|nv|emp|id)/i.test(c.key)) ||
      colProfile.identifiers[0] ||
      { key: 'ma_nhan_vien', name: 'Mã Nhân Viên' };

    const requirements = [];

    // 1. Total basic salary (REQ-01)
    if (
      hasWordOrPhrase(promptNorm, 'tong quy luong') ||
      hasWordOrPhrase(promptNorm, 'tong luong') ||
      hasWordOrPhrase(promptNorm, 'tong luong co ban') ||
      hasWordOrPhrase(promptNorm, 'chi phi luong') ||
      hasWordOrPhrase(promptNorm, 'phan tich quy luong') ||
      hasWordOrPhrase(promptNorm, '1. tong quy luong co ban') ||
      promptNorm.includes('1. tong')
    ) {
      requirements.push({
        id: 'req_total_salary',
        requirement_id: 'REQ-01',
        original_user_request: 'Tổng quỹ lương cơ bản',
        title: 'Tổng quỹ lương cơ bản',
        type: 'METRIC',
        func: 'SUM',
        aggregation: 'SUM',
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        unit: 'VNĐ',
        visualization_type: 'KPI_CARD',
        status: salCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: salCol ? null : 'Tệp không chứa cột lương cơ bản.',
        data_source_reference: salCol ? salCol.key : null,
      });
    }

    // 2. Average basic salary (REQ-02)
    if (
      hasWordOrPhrase(promptNorm, 'luong co ban trung binh') ||
      hasWordOrPhrase(promptNorm, 'luong trung binh') ||
      hasWordOrPhrase(promptNorm, 'thu nhap trung binh') ||
      hasWordOrPhrase(promptNorm, 'binh quan luong') ||
      hasWordOrPhrase(promptNorm, '2. luong co ban trung binh') ||
      promptNorm.includes('2. luong')
    ) {
      requirements.push({
        id: 'req_avg_salary',
        requirement_id: 'REQ-02',
        original_user_request: 'Lương cơ bản trung bình',
        title: 'Lương cơ bản trung bình',
        type: 'METRIC',
        func: 'AVG',
        aggregation: 'AVG',
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        unit: 'VNĐ/người',
        visualization_type: 'KPI_CARD',
        status: salCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: salCol ? null : 'Tệp không chứa cột lương cơ bản.',
        data_source_reference: salCol ? salCol.key : null,
      });
    }

    // 3. Max basic salary (REQ-03)
    if (
      hasWordOrPhrase(promptNorm, 'luong cao nhat') ||
      hasWordOrPhrase(promptNorm, 'cao nhat va thap nhat') ||
      hasWordOrPhrase(promptNorm, 'cao nhat') ||
      hasWordOrPhrase(promptNorm, 'max') ||
      promptNorm.includes('3. luong cao nhat')
    ) {
      requirements.push({
        id: 'req_max_salary',
        requirement_id: 'REQ-03',
        original_user_request: 'Lương cao nhất',
        title: 'Lương cơ bản cao nhất',
        type: 'METRIC',
        func: 'MAX',
        aggregation: 'MAX',
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        unit: 'VNĐ',
        visualization_type: 'KPI_CARD',
        status: salCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: salCol ? null : 'Tệp không chứa cột lương cơ bản.',
        data_source_reference: salCol ? salCol.key : null,
      });
    }

    // 4. Min basic salary (REQ-04)
    if (
      hasWordOrPhrase(promptNorm, 'luong thap nhat') ||
      hasWordOrPhrase(promptNorm, 'cao nhat va thap nhat') ||
      hasWordOrPhrase(promptNorm, 'thap nhat') ||
      hasWordOrPhrase(promptNorm, 'min') ||
      promptNorm.includes('thap nhat')
    ) {
      requirements.push({
        id: 'req_min_salary',
        requirement_id: 'REQ-04',
        original_user_request: 'Lương thấp nhất',
        title: 'Lương cơ bản thấp nhất',
        type: 'METRIC',
        func: 'MIN',
        aggregation: 'MIN',
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        unit: 'VNĐ',
        visualization_type: 'KPI_CARD',
        status: salCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: salCol ? null : 'Tệp không chứa cột lương cơ bản.',
        data_source_reference: salCol ? salCol.key : null,
      });
    }

    // 5. Department allocation (REQ-05A & REQ-05B: Bar and Pie)
    if (
      hasWordOrPhrase(promptNorm, 'theo phong ban') ||
      hasWordOrPhrase(promptNorm, 'phan bo quy luong') ||
      hasWordOrPhrase(promptNorm, 'phan bo') ||
      hasWordOrPhrase(promptNorm, 'phong ban') ||
      promptNorm.includes('4. phan bo')
    ) {
      const wantsPie = hasWordOrPhrase(promptNorm, 'pie') || hasWordOrPhrase(promptNorm, 'bieu do tron') || hasWordOrPhrase(promptNorm, 'ty trong');
      requirements.push({
        id: 'req_salary_by_dept_bar',
        requirement_id: 'REQ-05',
        original_user_request: 'Phân bổ quỹ lương theo phòng ban',
        title: 'Quỹ lương theo phòng ban',
        type: 'GROUP_BY',
        groupBy: [deptCol.key],
        dimension: deptCol.key,
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        func: 'SUM',
        aggregation: 'SUM',
        alias: 'tong_quy_luong',
        unit: 'VNĐ',
        visualization_type: 'BAR',
        status: (salCol && deptCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: (salCol && deptCol) ? null : 'Thiếu cột phòng ban hoặc lương cơ bản.',
        data_source_reference: deptCol ? deptCol.key : null,
      });

      if (wantsPie) {
        requirements.push({
          id: 'req_salary_by_dept_pie',
          requirement_id: 'REQ-05B',
          original_user_request: 'Tỷ trọng phân bổ quỹ lương theo phòng ban',
          title: 'Tỷ trọng quỹ lương theo phòng ban',
          type: 'GROUP_BY',
          groupBy: [deptCol.key],
          dimension: deptCol.key,
          column: salCol ? salCol.key : 'luong_co_ban_vnd',
          metric: salCol ? salCol.key : 'luong_co_ban_vnd',
          func: 'SUM',
          aggregation: 'SUM',
          alias: 'tong_quy_luong',
          unit: 'VNĐ',
          visualization_type: 'PIE',
          status: (salCol && deptCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
          reason: (salCol && deptCol) ? null : 'Thiếu cột phòng ban hoặc lương cơ bản.',
          data_source_reference: deptCol ? deptCol.key : null,
        });
      }
    }

    // 6. Job title breakdown (REQ-06)
    if (
      hasWordOrPhrase(promptNorm, 'chuc vu') ||
      hasWordOrPhrase(promptNorm, 'vi tri') ||
      hasWordOrPhrase(promptNorm, 'cap bac') ||
      hasWordOrPhrase(promptNorm, 'theo chuc vu') ||
      promptNorm.includes('5. so sanh')
    ) {
      requirements.push({
        id: 'req_avg_salary_by_title',
        requirement_id: 'REQ-06',
        original_user_request: 'So sánh lương trung bình giữa các chức vụ',
        title: 'Lương trung bình theo chức vụ',
        type: 'GROUP_BY',
        groupBy: [titleCol.key],
        dimension: titleCol.key,
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        func: 'AVG',
        aggregation: 'AVG',
        alias: 'luong_trung_binh',
        unit: 'VNĐ/người',
        visualization_type: 'BAR',
        status: (salCol && titleCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: (salCol && titleCol) ? null : 'Thiếu cột chức vụ hoặc lương cơ bản.',
        data_source_reference: titleCol ? titleCol.key : null,
      });
    }

    // 7. Salary bands / distribution (REQ-07)
    if (
      hasWordOrPhrase(promptNorm, 'nhom muc luong') ||
      hasWordOrPhrase(promptNorm, 'nhom luong') ||
      hasWordOrPhrase(promptNorm, 'muc luong') ||
      hasWordOrPhrase(promptNorm, 'phan loai nhan vien theo nhom') ||
      hasWordOrPhrase(promptNorm, 'phan loai') ||
      hasWordOrPhrase(promptNorm, 'salary band') ||
      hasWordOrPhrase(promptNorm, 'khoang luong') ||
      promptNorm.includes('6. phan loai')
    ) {
      requirements.push({
        id: 'req_salary_bands',
        requirement_id: 'REQ-07',
        original_user_request: 'Phân loại nhân viên theo nhóm mức lương',
        title: 'Phân loại nhân viên theo nhóm mức lương',
        type: 'DISTRIBUTION',
        dimension: 'nhom_muc_luong',
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        aggregation: 'COUNT',
        band_type: 'SALARY_BAND',
        unit: 'nhân sự',
        visualization_type: 'BAR',
        status: salCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: salCol ? null : 'Tệp không chứa cột lương cơ bản.',
        data_source_reference: salCol ? salCol.key : null,
      });
    }

    // 8. Top 10 highest paid employees (REQ-08)
    if (
      hasWordOrPhrase(promptNorm, 'top 10') ||
      hasWordOrPhrase(promptNorm, 'top') ||
      hasWordOrPhrase(promptNorm, 'bang xep hang') ||
      hasWordOrPhrase(promptNorm, 'xep hang') ||
      promptNorm.includes('7. top 10')
    ) {
      const topLimitMatch = promptNorm.match(/top\s*(\d+)/i);
      const limitVal = topLimitMatch ? parseInt(topLimitMatch[1], 10) : 10;
      requirements.push({
        id: 'req_top_10_salary',
        requirement_id: 'REQ-08',
        original_user_request: `Top ${limitVal} nhân viên có lương cao nhất`,
        title: `Top ${limitVal} nhân viên có lương cao nhất`,
        type: 'RANKING',
        limit: limitVal,
        column: salCol ? salCol.key : 'luong_co_ban_vnd',
        metric: salCol ? salCol.key : 'luong_co_ban_vnd',
        orderBy: [
          { col: salCol ? salCol.key : 'luong_co_ban_vnd', dir: 'DESC' },
          { col: empIdCol ? empIdCol.key : 'ma_nhan_vien', dir: 'ASC' },
        ],
        visualization_type: 'TABLE',
        status: salCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        reason: salCol ? null : 'Tệp không chứa cột lương cơ bản.',
        data_source_reference: salCol ? salCol.key : null,
      });
    }

    if (requirements.length > 0) {
      return requirements;
    }
  }

  // CASE E: GENERIC MULTI-INTENT NUMBERED/BULLET DECOMPOSITION
  // Supports comma, semicolon, newline delimiters between numbered items (e.g. "1. A, 2. B, 3. C")
  const numberedMatches = [...promptRaw.matchAll(/(?:^|\n|\s)(\d+)[.)]\s*(.+?)(?=\s*(?:[.,;]|\n)?\s*\d+[.)]|$)/gs)];
  if (numberedMatches.length >= 2) {
    const genericReqs = [];
    let reqIndex = 1;
    for (const match of numberedMatches) {
      const clauseRaw = match[2].trim().replace(/[.,;]+$/, '');
      const clauseNorm = normalizeText(clauseRaw);

      // Skip UI-only directives like "8. Hiển thị KPI Cards, Bar Chart..."
      if (
        hasWordOrPhrase(clauseNorm, 'hien thi kpi cards') ||
        hasWordOrPhrase(clauseNorm, 'hien thi bieu do') ||
        hasWordOrPhrase(clauseNorm, 'hien thi dashboard') ||
        (hasWordOrPhrase(clauseNorm, 'hien thi') && hasWordOrPhrase(clauseNorm, 'chart') && !hasWordOrPhrase(clauseNorm, 'theo'))
      ) {
        continue;
      }

      // Match candidate measure
      let measureCol = null;
      for (const col of colProfile.measures.concat(colProfile.quantities)) {
        const k = normalizeText(col.key);
        const n = normalizeText(col.name);
        if (hasWordOrPhrase(clauseNorm, k) || hasWordOrPhrase(clauseNorm, n)) {
          measureCol = col;
          break;
        }
      }
      if (!measureCol && colProfile.measures.length > 0) {
        measureCol = colProfile.measures[0];
      }

      // Match candidate dimension
      let dimCol = null;
      for (const col of colProfile.dimensions) {
        const k = normalizeText(col.key);
        const n = normalizeText(col.name);
        if (hasWordOrPhrase(clauseNorm, k) || hasWordOrPhrase(clauseNorm, n)) {
          dimCol = col;
          break;
        }
      }

      const reqIdStr = `REQ-${String(reqIndex).padStart(2, '0')}`;

      // Detect intent in clause
      if (hasWordOrPhrase(clauseNorm, 'top') || hasWordOrPhrase(clauseNorm, 'xep hang')) {
        const topMatch = clauseNorm.match(/top\s*(\d+)/i);
        const limitVal = topMatch ? parseInt(topMatch[1], 10) : 10;
        const idCol = colProfile.identifiers[0] || { key: 'id', name: 'ID' };
        genericReqs.push({
          id: `req_generic_top_${reqIndex}`,
          requirement_id: reqIdStr,
          original_user_request: clauseRaw,
          title: `Top ${limitVal} theo ${measureCol ? measureCol.name : 'chỉ số'}`,
          type: 'RANKING',
          limit: limitVal,
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          orderBy: [
            { col: measureCol ? measureCol.key : 'value', dir: 'DESC' },
            { col: idCol.key, dir: 'ASC' },
          ],
          visualization_type: 'TABLE',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      } else if (dimCol && (hasWordOrPhrase(clauseNorm, 'theo') || hasWordOrPhrase(clauseNorm, 'so sanh') || hasWordOrPhrase(clauseNorm, 'phan bo') || hasWordOrPhrase(clauseNorm, 'giua'))) {
        const func = hasWordOrPhrase(clauseNorm, 'trung binh') || hasWordOrPhrase(clauseNorm, 'binh quan') ? 'AVG' : (hasWordOrPhrase(clauseNorm, 'dem') || hasWordOrPhrase(clauseNorm, 'so luong') ? 'COUNT' : 'SUM');
        const isPie = hasWordOrPhrase(clauseNorm, 'pie') || hasWordOrPhrase(clauseNorm, 'ty trong') || hasWordOrPhrase(clauseNorm, 'tron');
        genericReqs.push({
          id: `req_generic_group_${reqIndex}`,
          requirement_id: reqIdStr,
          original_user_request: clauseRaw,
          title: `${func === 'AVG' ? 'Trung bình' : 'Tổng'} theo ${dimCol.name}`,
          type: 'GROUP_BY',
          groupBy: [dimCol.key],
          dimension: dimCol.key,
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          func,
          aggregation: func,
          alias: `${func.toLowerCase()}_${measureCol ? measureCol.key : 'value'}`,
          unit: '',
          visualization_type: isPie ? 'PIE' : 'BAR',
          status: (measureCol && dimCol) ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      } else if (hasWordOrPhrase(clauseNorm, 'phan loai') || hasWordOrPhrase(clauseNorm, 'nhom')) {
        genericReqs.push({
          id: `req_generic_dist_${reqIndex}`,
          requirement_id: reqIdStr,
          original_user_request: clauseRaw,
          title: `Phân loại theo ${measureCol ? measureCol.name : 'mức'}`,
          type: 'DISTRIBUTION',
          dimension: 'nhom_chi_tieu',
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          aggregation: 'COUNT',
          visualization_type: 'BAR',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      } else if ((hasWordOrPhrase(clauseNorm, 'cao nhat') || hasWordOrPhrase(clauseNorm, 'max')) && (hasWordOrPhrase(clauseNorm, 'thap nhat') || hasWordOrPhrase(clauseNorm, 'min'))) {
        genericReqs.push({
          id: `req_generic_max_${reqIndex}`,
          requirement_id: `${reqIdStr}A`,
          original_user_request: `${clauseRaw} (Cao nhất)`,
          title: `${measureCol ? measureCol.name : 'Chỉ số'} cao nhất`,
          type: 'METRIC',
          func: 'MAX',
          aggregation: 'MAX',
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          visualization_type: 'KPI_CARD',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        genericReqs.push({
          id: `req_generic_min_${reqIndex}`,
          requirement_id: `${reqIdStr}B`,
          original_user_request: `${clauseRaw} (Thấp nhất)`,
          title: `${measureCol ? measureCol.name : 'Chỉ số'} thấp nhất`,
          type: 'METRIC',
          func: 'MIN',
          aggregation: 'MIN',
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          visualization_type: 'KPI_CARD',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      } else if (hasWordOrPhrase(clauseNorm, 'cao nhat') || hasWordOrPhrase(clauseNorm, 'max')) {
        genericReqs.push({
          id: `req_generic_max_${reqIndex}`,
          requirement_id: reqIdStr,
          original_user_request: clauseRaw,
          title: `${measureCol ? measureCol.name : 'Chỉ số'} cao nhất`,
          type: 'METRIC',
          func: 'MAX',
          aggregation: 'MAX',
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          visualization_type: 'KPI_CARD',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      } else if (hasWordOrPhrase(clauseNorm, 'thap nhat') || hasWordOrPhrase(clauseNorm, 'min')) {
        genericReqs.push({
          id: `req_generic_min_${reqIndex}`,
          requirement_id: reqIdStr,
          original_user_request: clauseRaw,
          title: `${measureCol ? measureCol.name : 'Chỉ số'} thấp nhất`,
          type: 'METRIC',
          func: 'MIN',
          aggregation: 'MIN',
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          visualization_type: 'KPI_CARD',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      } else if (hasWordOrPhrase(clauseNorm, 'trung binh') || hasWordOrPhrase(clauseNorm, 'binh quan')) {
        genericReqs.push({
          id: `req_generic_avg_${reqIndex}`,
          requirement_id: reqIdStr,
          original_user_request: clauseRaw,
          title: `${measureCol ? measureCol.name : 'Chỉ số'} trung bình`,
          type: 'METRIC',
          func: 'AVG',
          aggregation: 'AVG',
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          visualization_type: 'KPI_CARD',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      } else if (hasWordOrPhrase(clauseNorm, 'tong')) {
        genericReqs.push({
          id: `req_generic_sum_${reqIndex}`,
          requirement_id: reqIdStr,
          original_user_request: clauseRaw,
          title: `Tổng ${measureCol ? measureCol.name : 'chỉ số'}`,
          type: 'METRIC',
          func: 'SUM',
          aggregation: 'SUM',
          column: measureCol ? measureCol.key : 'value',
          metric: measureCol ? measureCol.key : 'value',
          visualization_type: 'KPI_CARD',
          status: measureCol ? 'AVAILABLE' : 'DATA_UNAVAILABLE',
        });
        reqIndex++;
      }
    }

    if (genericReqs.length >= 2) {
      return genericReqs;
    }
  }
}

/**
 * Plan an Analytical Query from User Prompt & Dataset Schema
 * @param {string} userPrompt - Natural language prompt
 * @param {Object} datasetProfile - Schema & columns profile from biSpreadsheetEngine
 * @param {Object} conversationContext - Context with previous query plan for follow-up questions
 * @returns {Object} Structured Query Plan
 */
function planAnalyticalQuery(userPrompt, datasetProfile, conversationContext = {}) {
  const prompt = String(userPrompt || '').trim();
  const promptNorm = normalizeText(prompt);
  const columns = datasetProfile?.columns || [];
  const colProfile = profileColumns(columns);

  // 1. Check for Contextual Follow-Up
  if (conversationContext && conversationContext.previousQueryPlan) {
    const followUpPlan = planFollowUpQuery(prompt, conversationContext.previousQueryPlan, datasetProfile);
    if (followUpPlan) {
      return followUpPlan;
    }
  }

  // Check for ambiguous or empty prompt (Requirement 16)
  const isAmbiguousQuery =
    promptNorm.length < 5 ||
    /^(tinh toan|tinh toan giup toi|phan tich di|phan tich giup toi|ve bieu do|bieu do di|xem so lieu)$/i.test(promptNorm);

  if (isAmbiguousQuery) {
    return {
      intent: 'AGGREGATION',
      target_sheet: datasetProfile?.active_sheet || 'Sheet1',
      groupBy: [],
      aggregations: [],
      filters: [],
      computations: [],
      period_comparison: null,
      orderBy: { column: 'value', dir: 'DESC' },
      limit: 20,
      chart_preference: 'BAR',
      clarification_needed: true,
      clarification_question: 'Bạn muốn phân tích chỉ số nào (ví dụ: số lượng nhân viên, tổng lương, doanh số) và nhóm theo tiêu chí nào (ví dụ: phòng ban, công ty, thời gian)?',
    };
  }

  // Check for Duplicate Keys query (e.g. "Kiểm tra dữ liệu trùng", "Kiểm tra trùng lặp")
  const isDuplicateIntent =
    hasWordOrPhrase(promptNorm, 'du lieu trung') ||
    hasWordOrPhrase(promptNorm, 'trung lap') ||
    hasWordOrPhrase(promptNorm, 'kiem tra trung') ||
    hasWordOrPhrase(promptNorm, 'kiem tra du lieu trung') ||
    hasWordOrPhrase(promptNorm, 'check trung') ||
    hasWordOrPhrase(promptNorm, 'trung ma');

  if (isDuplicateIntent) {
    const idCol = colProfile.identifiers[0] || columns.find(c => c.key.includes('ma_') || c.key.includes('id')) || columns[0];
    const idKey = idCol ? idCol.key : 'id';
    return {
      intent: 'DUPLICATES',
      target_sheet: datasetProfile?.active_sheet || 'Sheet1',
      groupBy: [idKey],
      aggregations: [{ column: idKey, func: 'COUNT', alias: `count_${idKey}` }],
      filters: [],
      computations: [],
      period_comparison: null,
      having: { column: `count_${idKey}`, op: 'gt', value: 1 },
      orderBy: { column: `count_${idKey}`, dir: 'DESC' },
      limit: 50,
      chart_preference: 'NONE',
      clarification_needed: false,
      clarification_question: null,
    };
  }

  // 1b. Composite Analytical Requirements Check (Phase 3 Multi-Domain Pipeline)
  const compositeRequirements = decomposeCompositeRequirements(promptNorm, prompt, datasetProfile, columns, colProfile);
  if (compositeRequirements && compositeRequirements.length > 0) {
    const primaryReq = compositeRequirements.find(r => r.type === 'GROUP_BY') || compositeRequirements.find(r => r.type === 'METRIC') || compositeRequirements[0];
    const groupBy = primaryReq.groupBy ? [...primaryReq.groupBy] : (primaryReq.type === 'GROUP_BY' && primaryReq.dimension ? [primaryReq.dimension] : []);
    const targetCol = primaryReq.column || (columns[0] ? columns[0].key : 'col_1');
    const targetMeta = columns.find(c => c.key === targetCol);
    const isTargetNumeric = targetMeta && (targetMeta.type === 'INTEGER' || targetMeta.type === 'FLOAT');
    const targetFunc = primaryReq.func || (isTargetNumeric ? 'SUM' : 'COUNT');
    
    // Multi-metric synchronization: collect all metrics requested by user & requirements
    const aggregations = [];
    const multiResult = detectMultipleMetrics(promptNorm, colProfile, columns);
    if (multiResult.metrics && multiResult.metrics.length > 0) {
      for (const m of multiResult.metrics) {
        if (!aggregations.some(a => a.column === m.column && a.func === m.func)) {
          aggregations.push(m);
        }
      }
    }
    for (const r of compositeRequirements) {
      if ((r.type === 'METRIC' || r.type === 'AGGREGATION' || r.type === 'GROUP_BY') && r.column && r.func) {
        if (!aggregations.some(a => a.column === r.column && a.func === r.func)) {
          aggregations.push({
            column: r.column,
            func: r.func,
            alias: r.alias || `${r.func.toLowerCase()}_${r.column}`,
          });
        }
      }
    }
    if (aggregations.length === 0) {
      aggregations.push({
        column: targetCol,
        func: targetFunc,
        alias: primaryReq.alias || `${targetFunc.toLowerCase()}_${targetCol}`,
      });
    }
    const chartPref = compositeRequirements.some(r => r.type === 'GROUP_BY' || r.type === 'CORRELATION_BREAKDOWN' || r.type === 'DISTRIBUTION') ? 'BAR' : 'NONE';

    return {
      intent: 'COMPOSITE',
      target_sheet: datasetProfile?.active_sheet || 'Sheet1',
      requirements: compositeRequirements,
      groupBy,
      aggregations,
      filters: [],
      computations: [],
      period_comparison: null,
      orderBy: { column: aggregations[0].alias, dir: 'DESC' },
      limit: 50,
      chart_preference: chartPref,
      prompt: userPrompt,
      clarification_needed: false,
      clarification_question: null,
      metric_coverage: { isComplete: true, missing: [] },
    };
  }

  // 2. Identify Intent & Aggregation Target
  let func = 'SUM';
  let targetMetricCol = null;
  let entitySubjectKey = null; // Key of entity being counted, so it is NOT added to groupBy

  // Entity Flags
  const isNhanVienEntity =
    hasWordOrPhrase(promptNorm, 'nhan vien') ||
    hasWordOrPhrase(promptNorm, 'nhan su') ||
    hasWordOrPhrase(promptNorm, 'can bo') ||
    hasWordOrPhrase(promptNorm, 'nguoi') ||
    hasWordOrPhrase(promptNorm, 'lao dong');

  const isHoSoEntity =
    hasWordOrPhrase(promptNorm, 'ho so') ||
    hasWordOrPhrase(promptNorm, 'van ban') ||
    hasWordOrPhrase(promptNorm, 'tai lieu');

  const isDonHangEntity =
    hasWordOrPhrase(promptNorm, 'don hang') ||
    hasWordOrPhrase(promptNorm, 'don') ||
    hasWordOrPhrase(promptNorm, 'hop dong');

  const isKhachHangEntity =
    hasWordOrPhrase(promptNorm, 'khach hang') ||
    hasWordOrPhrase(promptNorm, 'khach') ||
    hasWordOrPhrase(promptNorm, 'doi tac');

  const hasEntityMention = isNhanVienEntity || isHoSoEntity || isDonHangEntity || isKhachHangEntity;

  // Check if any specific numeric measure is explicitly mentioned in prompt
  const hasMeasureMention =
    hasWordOrPhrase(promptNorm, 'tien luong') ||
    hasWordOrPhrase(promptNorm, 'bang luong') ||
    hasWordOrPhrase(promptNorm, 'tong luong') ||
    hasWordOrPhrase(promptNorm, 'chi phi luong') ||
    hasWordOrPhrase(promptNorm, 'luong co ban') ||
    hasWordOrPhrase(promptNorm, 'luong trung binh') ||
    hasWordOrPhrase(promptNorm, 'thu nhap') ||
    hasWordOrPhrase(promptNorm, 'salary') ||
    (hasWordOrPhrase(promptNorm, 'luong') && !hasWordOrPhrase(promptNorm, 'so luong') && !hasWordOrPhrase(promptNorm, 'so luong nhan vien')) ||
    hasWordOrPhrase(promptNorm, 'doanh so') ||
    hasWordOrPhrase(promptNorm, 'doanh thu') ||
    hasWordOrPhrase(promptNorm, 'chi phi') ||
    hasWordOrPhrase(promptNorm, 'gio tang ca') ||
    hasWordOrPhrase(promptNorm, 'so ngay nghi') ||
    colProfile.measures.some((c) => {
      const k = normalizeText(c.key);
      const n = normalizeText(c.name);
      return (k.length > 3 && hasWordOrPhrase(promptNorm, k)) || (n.length > 3 && hasWordOrPhrase(promptNorm, n));
    });

  const isPieChartIntent =
    hasWordOrPhrase(promptNorm, 'pie') ||
    hasWordOrPhrase(promptNorm, 'pie chart') ||
    hasWordOrPhrase(promptNorm, 'bieu do tron') ||
    hasWordOrPhrase(promptNorm, 'donut');

  const isCategoricalBreakdownWithoutMeasure =
    !hasMeasureMention &&
    (isPieChartIntent ||
      hasWordOrPhrase(promptNorm, 'trang thai') ||
      hasWordOrPhrase(promptNorm, 'tinh trang') ||
      hasWordOrPhrase(promptNorm, 'phan loai') ||
      hasWordOrPhrase(promptNorm, 'thong ke nhan vien') ||
      hasWordOrPhrase(promptNorm, 'thong ke nhan su') ||
      hasWordOrPhrase(promptNorm, 'lien quan den'));

  // A. Check for Entity Count Intent
  // Phrasing: "số lượng nhân viên", "số lương nhân viên" (typo), "đếm nhân sự", "bao nhiêu người",
  // "số lượng hồ sơ", "tổng số hồ sơ", "tỷ lệ hồ sơ", "số lượng đơn hàng", "tỷ trọng nhân viên", "cơ cấu nhân sự",
  // or categorical breakdowns without measure (e.g. "pie chart liên quan đến trạng thái làm việc của nhân viên")
  const isCountEntityIntent =
    hasWordOrPhrase(promptNorm, 'so luong') ||
    hasWordOrPhrase(promptNorm, 'dem') ||
    hasWordOrPhrase(promptNorm, 'bao nhieu') ||
    hasWordOrPhrase(promptNorm, 'so nhan su') ||
    hasWordOrPhrase(promptNorm, 'so nhan vien') ||
    hasWordOrPhrase(promptNorm, 'so ho so') ||
    hasWordOrPhrase(promptNorm, 'tong so ho so') ||
    hasWordOrPhrase(promptNorm, 'so don') ||
    hasWordOrPhrase(promptNorm, 'so khach') ||
    hasWordOrPhrase(promptNorm, 'so luong can bo') ||
    ((hasWordOrPhrase(promptNorm, 'ty trong') || hasWordOrPhrase(promptNorm, 'ty le') || hasWordOrPhrase(promptNorm, 'co cau') || hasWordOrPhrase(promptNorm, 'phan bo')) && hasEntityMention && !hasWordOrPhrase(promptNorm, 'doanh so') && !hasWordOrPhrase(promptNorm, 'doanh thu')) ||
    (hasEntityMention && isCategoricalBreakdownWithoutMeasure);

  const isRowCountIntent =
    hasWordOrPhrase(promptNorm, 'so dong du lieu') ||
    hasWordOrPhrase(promptNorm, 'so dong') ||
    hasWordOrPhrase(promptNorm, 'dem so dong') ||
    hasWordOrPhrase(promptNorm, 'dem dong') ||
    hasWordOrPhrase(promptNorm, 'so record') ||
    hasWordOrPhrase(promptNorm, 'tong so dong') ||
    hasWordOrPhrase(promptNorm, 'dong du lieu');

  if (isRowCountIntent) {
    func = 'COUNT';
    targetMetricCol = { key: '*', name: 'Dòng', type: 'ROW_COUNT' };
  } else if (isCountEntityIntent) {
    func = 'DISTINCT_COUNT';

    if (isNhanVienEntity) {
      // Find employee identifier or label
      const empCol =
        colProfile.identifiers.find((c) => {
          const k = normalizeText(c.key);
          return k.includes('nhan_vien') || k.includes('nv') || k.includes('emp') || k === 'id';
        }) ||
        colProfile.labels.find((c) => normalizeText(c.key).includes('ho_ten') || normalizeText(c.key).includes('ten')) ||
        colProfile.identifiers[0];

      if (empCol) {
        targetMetricCol = empCol;
        entitySubjectKey = empCol.key;
      } else {
        // Dataset lacks employee identifier (Requirement 20 & Phase B.4)
        return {
          intent: 'AGGREGATION',
          target_sheet: datasetProfile?.active_sheet || 'Sheet1',
          groupBy: [],
          aggregations: [],
          filters: [],
          computations: [],
          period_comparison: null,
          orderBy: { column: 'value', dir: 'DESC' },
          limit: 20,
          chart_preference: 'BAR',
          clarification_needed: true,
          clarification_question: 'Bộ dữ liệu không có cột định danh nhân viên (như mã nhân viên, họ tên) để đếm chính xác số lượng nhân viên. Vui lòng cung cấp file có thông tin nhân viên hoặc chọn chỉ số khác.',
        };
      }
    } else if (isHoSoEntity) {
      const hsCol =
        colProfile.identifiers.find((c) => {
          const k = normalizeText(c.key);
          return k.includes('ho_so') || k.includes('hs') || k.includes('van_ban') || k === 'id';
        }) || colProfile.identifiers[0] || colProfile.all[0];
      targetMetricCol = hsCol;
      entitySubjectKey = hsCol ? hsCol.key : null;
    } else if (isDonHangEntity) {
      const donCol =
        colProfile.identifiers.find((c) => {
          const k = normalizeText(c.key);
          return k.includes('don') || k.includes('order') || k.includes('hd') || k === 'id';
        }) || colProfile.identifiers[0] || colProfile.all[0];
      targetMetricCol = donCol;
      entitySubjectKey = donCol ? donCol.key : null;
    } else if (isKhachHangEntity) {
      const khCol =
        colProfile.identifiers.find((c) => {
          const k = normalizeText(c.key);
          return k.includes('khach') || k.includes('customer') || k === 'id';
        }) ||
        colProfile.dimensions.find((c) => normalizeText(c.key).includes('khach')) ||
        colProfile.all[0];
      targetMetricCol = khCol;
      entitySubjectKey = khCol ? khCol.key : null;
    } else {
      // Generic entity count
      targetMetricCol = colProfile.identifiers[0] || colProfile.all[0];
      entitySubjectKey = targetMetricCol ? targetMetricCol.key : null;
    }
  }

  // B. If not entity count, resolve Mathematical Function & Target Column
  if (!targetMetricCol) {
    if (hasWordOrPhrase(promptNorm, 'trung binh') || hasWordOrPhrase(promptNorm, 'binh quan') || hasWordOrPhrase(promptNorm, 'avg')) {
      func = 'AVG';
    } else if (hasWordOrPhrase(promptNorm, 'trung vi') || hasWordOrPhrase(promptNorm, 'median')) {
      func = 'MEDIAN';
    } else if (hasWordOrPhrase(promptNorm, 'cao nhat') || hasWordOrPhrase(promptNorm, 'lon nhat') || hasWordOrPhrase(promptNorm, 'max')) {
      func = 'MAX';
    } else if (hasWordOrPhrase(promptNorm, 'thap nhat') || hasWordOrPhrase(promptNorm, 'nho nhat') || hasWordOrPhrase(promptNorm, 'min')) {
      func = 'MIN';
    } else if (hasWordOrPhrase(promptNorm, 'khac nhau') || hasWordOrPhrase(promptNorm, 'bao nhieu loai') || hasWordOrPhrase(promptNorm, 'distinct')) {
      func = 'DISTINCT_COUNT';
    } else {
      func = 'SUM';
    }

    // Look for matching measure/quantity column
    // 1. Salary / Luong check (must not be preceded by "so" without "tien")
    const isSalaryMention =
      hasWordOrPhrase(promptNorm, 'tien luong') ||
      hasWordOrPhrase(promptNorm, 'bang luong') ||
      hasWordOrPhrase(promptNorm, 'tong luong') ||
      hasWordOrPhrase(promptNorm, 'chi phi luong') ||
      hasWordOrPhrase(promptNorm, 'luong co ban') ||
      hasWordOrPhrase(promptNorm, 'luong trung binh') ||
      hasWordOrPhrase(promptNorm, 'thu nhap') ||
      hasWordOrPhrase(promptNorm, 'salary') ||
      (hasWordOrPhrase(promptNorm, 'luong') && !hasWordOrPhrase(promptNorm, 'so luong'));

    if (isSalaryMention) {
      targetMetricCol = colProfile.measures.find((c) => {
        const k = normalizeText(c.key);
        const n = normalizeText(c.name);
        return k.includes('luong') || k.includes('salary') || k.includes('thu_nhap') || n.includes('luong');
      });
    }

    // 2. Revenue / Sales check
    if (!targetMetricCol) {
      const isSalesMention =
        hasWordOrPhrase(promptNorm, 'doanh so') ||
        hasWordOrPhrase(promptNorm, 'doanh thu') ||
        hasWordOrPhrase(promptNorm, 'sales') ||
        hasWordOrPhrase(promptNorm, 'revenue') ||
        hasWordOrPhrase(promptNorm, 'tong thu');

      if (isSalesMention) {
        targetMetricCol = colProfile.measures.find((c) => {
          const k = normalizeText(c.key);
          return k.includes('doanh_so') || k.includes('doanhso') || k.includes('doanh_thu') || k.includes('revenue') || k.includes('sales');
        });
      }
    }

    // 3. Cost / Expense check
    if (!targetMetricCol) {
      const isCostMention = hasWordOrPhrase(promptNorm, 'chi phi') || hasWordOrPhrase(promptNorm, 'cost') || hasWordOrPhrase(promptNorm, 'expense');
      if (isCostMention) {
        targetMetricCol = colProfile.measures.find((c) => normalizeText(c.key).includes('chi_phi') || normalizeText(c.name).includes('chi phi'));
      }
    }

    // 4. Quantity / Count Measures (e.g. so_lo, so_luong, sl)
    if (!targetMetricCol) {
      if (hasWordOrPhrase(promptNorm, 'so lo') || hasWordOrPhrase(promptNorm, 'lo xu ly') || hasWordOrPhrase(promptNorm, 'lo')) {
        targetMetricCol = colProfile.quantities.find((c) => normalizeText(c.key).includes('lo') || normalizeText(c.name).includes('lo'));
      } else if (hasWordOrPhrase(promptNorm, 'so luong') || hasWordOrPhrase(promptNorm, 'san luong')) {
        targetMetricCol = colProfile.quantities.find((c) => normalizeText(c.key).includes('so_luong') || normalizeText(c.key) === 'sl');
      }
    }

    // 5. Fallback to direct name match across all measures
    if (!targetMetricCol) {
      for (const col of colProfile.measures.concat(colProfile.quantities)) {
        if (hasWordOrPhrase(promptNorm, col.name) || hasWordOrPhrase(promptNorm, col.key)) {
          targetMetricCol = col;
          break;
        }
      }
    }

    // 6. Default fallback
    if (!targetMetricCol) {
      if (hasEntityMention && colProfile.identifiers.length > 0 && !hasMeasureMention) {
        targetMetricCol = colProfile.identifiers[0];
        func = 'DISTINCT_COUNT';
      } else if (hasEntityMention && colProfile.labels.length > 0 && !hasMeasureMention) {
        targetMetricCol = colProfile.labels[0];
        func = 'DISTINCT_COUNT';
      } else if (colProfile.measures.length > 0 && hasMeasureMention) {
        targetMetricCol = colProfile.measures[0];
      } else if (colProfile.quantities.length > 0) {
        targetMetricCol = colProfile.quantities[0];
      } else if (colProfile.identifiers.length > 0) {
        targetMetricCol = colProfile.identifiers[0];
        func = 'DISTINCT_COUNT';
      } else if (colProfile.measures.length > 0) {
        targetMetricCol = colProfile.measures[0];
      } else {
        targetMetricCol = columns[0] || { key: 'col_1', name: 'Bản ghi' };
        func = 'COUNT';
      }
    }
  }

  const alias =
    targetMetricCol?.key === '*'
      ? 'count_rows'
      : func === 'COUNT'
      ? `count_${targetMetricCol?.key || 'all'}`
      : `${func.toLowerCase()}_${targetMetricCol?.key || 'all'}`;
  let aggregations = [{
    column: targetMetricCol ? targetMetricCol.key : columns[0].key,
    func,
    alias,
  }];

  // Multi-metric composite support
  const multiResult = detectMultipleMetrics(promptNorm, colProfile, columns);
  const isMultiMetric = multiResult.metrics.length > 1;
  if (isMultiMetric) {
    aggregations = multiResult.metrics;
    if (multiResult.empColKey) {
      entitySubjectKey = multiResult.empColKey;
    }
  }

  // 3. Identify Group By Dimensions
  const groupBy = [];
  let dateTrunc = null;

  // A. Date Grouping check: Must be temporal phrasing, NOT numeric metrics like "ngày nghỉ", "quy mô"
  const cleanPromptForDate = promptNorm
    .replace(/(?:so\s+)?ngay\s+nghi\b/g, '')
    .replace(/(?:so\s+)?ngay\s+phep\b/g, '')
    .replace(/(?:so\s+)?ngay\s+cong\b/g, '')
    .replace(/quy\s+mo\b/g, '')
    .replace(/quy\s+(?:luong|tien\s+luong|thuong|bao\s+hiem)\b/g, '')
    .replace(/quy\s+(?:dinh|trinh|tac|chuan|uoc)\b/g, '');

  const isQuarterDate =
    hasWordOrPhrase(cleanPromptForDate, 'theo quy') ||
    hasWordOrPhrase(cleanPromptForDate, 'tung quy') ||
    hasWordOrPhrase(cleanPromptForDate, 'cac quy') ||
    hasWordOrPhrase(cleanPromptForDate, 'moi quy') ||
    /\bquy\s*[1-4]\b/i.test(cleanPromptForDate) ||
    /\bhang\s+quy\b/i.test(cleanPromptForDate);

  const isDateGroupingIntent =
    isQuarterDate ||
    hasWordOrPhrase(cleanPromptForDate, 'theo thang') ||
    hasWordOrPhrase(cleanPromptForDate, 'tung thang') ||
    hasWordOrPhrase(cleanPromptForDate, 'cac thang') ||
    hasWordOrPhrase(cleanPromptForDate, 'moi thang') ||
    hasWordOrPhrase(cleanPromptForDate, 'hang thang') ||
    hasWordOrPhrase(cleanPromptForDate, 'qua cac thang') ||
    hasWordOrPhrase(cleanPromptForDate, 'theo nam') ||
    hasWordOrPhrase(cleanPromptForDate, 'tung nam') ||
    hasWordOrPhrase(cleanPromptForDate, 'cac nam') ||
    hasWordOrPhrase(cleanPromptForDate, 'moi nam') ||
    hasWordOrPhrase(cleanPromptForDate, 'hang nam') ||
    hasWordOrPhrase(cleanPromptForDate, 'qua cac nam') ||
    hasWordOrPhrase(cleanPromptForDate, 'theo ngay') ||
    hasWordOrPhrase(cleanPromptForDate, 'tung ngay') ||
    hasWordOrPhrase(cleanPromptForDate, 'cac ngay') ||
    hasWordOrPhrase(cleanPromptForDate, 'moi ngay') ||
    hasWordOrPhrase(cleanPromptForDate, 'hang ngay') ||
    hasWordOrPhrase(cleanPromptForDate, 'theo thoi gian') ||
    (hasWordOrPhrase(cleanPromptForDate, 'xu huong') && (hasWordOrPhrase(cleanPromptForDate, 'thang') || hasWordOrPhrase(cleanPromptForDate, 'nam') || hasWordOrPhrase(cleanPromptForDate, 'ngay') || hasWordOrPhrase(cleanPromptForDate, 'thoi gian')));

  if (colProfile.dates.length > 0 && isDateGroupingIntent) {
    const targetDateCol = colProfile.dates[0];
    if (isQuarterDate) {
      dateTrunc = 'quarter';
    } else if (hasWordOrPhrase(cleanPromptForDate, 'nam')) {
      dateTrunc = 'year';
    } else if (hasWordOrPhrase(cleanPromptForDate, 'ngay')) {
      dateTrunc = 'day';
    } else {
      dateTrunc = 'month'; // Default date truncation
    }
    groupBy.push({
      column: targetDateCol.key,
      date_trunc: dateTrunc,
    });
  }

  // B. Categorical Dimension Grouping with Strict Prepositions
  // Prepositions: "theo [X]", "mỗi [X]", "của mỗi [X]", "từng [X]", "cho từng [X]", "của các [X]", "theo các [X]", "phân bổ theo [X]", "cơ cấu theo [X]", "giữa [X]", "liên quan đến [X]", "về [X]"
  const candidateDimensions = colProfile.dimensions.filter((c) => c.key !== entitySubjectKey);
  const matchedDimensions = [];

  for (const col of candidateDimensions) {
    const colNameNorm = normalizeText(col.name);
    const colKeyNorm = normalizeText(col.key);

    let isMatch = false;

    // Check prepositions before colName or colKey
    const prepPatterns = [
      `theo ${colNameNorm}`,
      `theo ${colKeyNorm}`,
      `moi ${colNameNorm}`,
      `moi ${colKeyNorm}`,
      `cua moi ${colNameNorm}`,
      `cua moi ${colKeyNorm}`,
      `tung ${colNameNorm}`,
      `tung ${colKeyNorm}`,
      `cho tung ${colNameNorm}`,
      `cua cac ${colNameNorm}`,
      `theo cac ${colNameNorm}`,
      `phan bo theo ${colNameNorm}`,
      `co cau theo ${colNameNorm}`,
      `chia theo ${colNameNorm}`,
      `giua ${colNameNorm}`,
      `so sanh ${colNameNorm}`,
      `lien quan den ${colNameNorm}`,
      `lien quan den ${colKeyNorm}`,
      `ve ${colNameNorm}`,
      `cho ${colNameNorm}`,
    ];

    if (prepPatterns.some((pattern) => hasWordOrPhrase(promptNorm, pattern))) {
      isMatch = true;
    }

    // Check synonyms with prepositions
    if (!isMatch) {
      for (const [canonical, aliases] of Object.entries(COLUMN_SYNONYMS)) {
        if (colKeyNorm.includes(canonical) || colNameNorm.includes(canonical)) {
          for (const a of aliases) {
            const aliasPatterns = [
              `theo ${a}`,
              `moi ${a}`,
              `cua moi ${a}`,
              `tung ${a}`,
              `cho tung ${a}`,
              `cua cac ${a}`,
              `theo cac ${a}`,
              `phan bo theo ${a}`,
              `co cau theo ${a}`,
              `chia theo ${a}`,
              `giua ${a}`,
              `so sanh ${a}`,
              `lien quan den ${a}`,
              `ve ${a}`,
              `cho ${a}`,
            ];
            if (aliasPatterns.some((p) => hasWordOrPhrase(promptNorm, p))) {
              isMatch = true;
              break;
            }
          }
        }
        if (isMatch) break;
      }
    }

    if (isMatch && !matchedDimensions.includes(col.key)) {
      matchedDimensions.push(col.key);
    }
  }

  let independentBreakdowns = [];
  let chartMapping = {};

  if (matchedDimensions.length === 1) {
    if (!groupBy.some((g) => (typeof g === 'string' ? g : g.column) === matchedDimensions[0])) {
      groupBy.push(matchedDimensions[0]);
    }
  } else if (matchedDimensions.length > 1) {
    // Check if user specifically requested a 2-dimensional cross-tab or combined grouping
    const isExplicitCrossGroup =
      /(?:theo|va)\s+(?:phong\s+ban|bo\s+phan)\s+(?:va|theo)\s+(?:trang\s+thai|tinh\s+trang|chuc\s+vu|chi\s+nhanh)/i.test(promptNorm) ||
      /(?:ket\s+hop|ma\s+tran|hai\s+chieu|2\s+chieu|cross-tab)/i.test(promptNorm);

    if (isExplicitCrossGroup) {
      for (const dim of matchedDimensions) {
        if (!groupBy.some((g) => (typeof g === 'string' ? g : g.column) === dim)) {
          groupBy.push(dim);
        }
      }
    } else {
      // Independent breakdown requests in composite prompt (e.g. TC2: theo trạng thái, theo phòng ban)
      independentBreakdowns = [...matchedDimensions];
      const deptDim = matchedDimensions.find(k => k === 'phong_ban' || k.includes('phong'));
      const statusDim = matchedDimensions.find(k => k === 'trang_thai' || k.includes('trang_thai'));
      const primaryDim = deptDim || matchedDimensions[0];

      if (!groupBy.some((g) => (typeof g === 'string' ? g : g.column) === primaryDim)) {
        groupBy.push(primaryDim);
      }

      if (statusDim && deptDim) {
        chartMapping = { pie: statusDim, bar: deptDim };
      }
    }
  }

  const isFindTopRecord =
    (hasWordOrPhrase(promptNorm, 'tim nhan vien') ||
     hasWordOrPhrase(promptNorm, 'ai co') ||
     hasWordOrPhrase(promptNorm, 'nhan vien nao co') ||
     hasWordOrPhrase(promptNorm, 'nguoi co')) &&
    (hasWordOrPhrase(promptNorm, 'cao nhat') || hasWordOrPhrase(promptNorm, 'thap nhat') || hasWordOrPhrase(promptNorm, 'lon nhat') || hasWordOrPhrase(promptNorm, 'nho nhat'));

  // C. Special Check for Individual Employee Ranking (e.g. "Top 5 nhân viên theo số lô xử lý")
  if (
    !isFindTopRecord &&
    groupBy.length === 0 &&
    (hasWordOrPhrase(promptNorm, 'nhan vien') || hasWordOrPhrase(promptNorm, 'can bo') || hasWordOrPhrase(promptNorm, 'nguoi tao')) &&
    (hasWordOrPhrase(promptNorm, 'top') || hasWordOrPhrase(promptNorm, 'cao nhat') || hasWordOrPhrase(promptNorm, 'thap nhat')) &&
    !hasWordOrPhrase(promptNorm, 'phong ban') &&
    !hasWordOrPhrase(promptNorm, 'cong ty')
  ) {
    const rankingCol =
      colProfile.labels.find((c) => {
        const k = normalizeText(c.key);
        return k.includes('nguoi') || k.includes('ten') || k.includes('nhan_vien');
      }) ||
      colProfile.labels[0] ||
      colProfile.dimensions.find((c) => normalizeText(c.key).includes('nguoi')) ||
      colProfile.identifiers[0];

    if (rankingCol) {
      groupBy.push(rankingCol.key);
    }
  }

  // D. Fallback Dimension: If no group found yet, check if prompt mentions dimension without preposition
  if (groupBy.length === 0) {
    for (const col of candidateDimensions) {
      const colNameNorm = normalizeText(col.name);
      if (hasWordOrPhrase(promptNorm, colNameNorm) && col.cardinality > 1 && col.cardinality <= 100) {
        groupBy.push(col.key);
        break;
      }
    }
  }

  // E. Fallback: if user asked "theo [gì đó]" and no group found, pick first low-cardinality dimension
  if (groupBy.length === 0 && (hasWordOrPhrase(promptNorm, 'theo') || hasWordOrPhrase(promptNorm, 'tung') || hasWordOrPhrase(promptNorm, 'cac'))) {
    const candidate = candidateDimensions.find((c) => c.cardinality > 1 && c.cardinality <= 50);
    if (candidate) {
      groupBy.push(candidate.key);
    }
  }

  // 4. Identify Filters
  const filters = [];

  const isFilterOnlyIntent =
    (promptNorm.startsWith('loc') ||
     promptNorm.startsWith('tim') ||
     hasWordOrPhrase(promptNorm, 'tim nhan vien') ||
     hasWordOrPhrase(promptNorm, 'loc danh sach') ||
     hasWordOrPhrase(promptNorm, 'loc nhan vien') ||
     hasWordOrPhrase(promptNorm, 'chi lay') ||
     hasWordOrPhrase(promptNorm, 'chi xem') ||
     hasWordOrPhrase(promptNorm, 'lay danh sach') ||
     hasWordOrPhrase(promptNorm, 'xem danh sach') ||
     hasWordOrPhrase(promptNorm, 'danh sach chi tiet') ||
     hasWordOrPhrase(promptNorm, 'bang chi tiet') ||
     hasWordOrPhrase(promptNorm, 'bang du lieu chi tiet')) &&
    !hasWordOrPhrase(promptNorm, 'tong') &&
    !hasWordOrPhrase(promptNorm, 'trung binh') &&
    !hasWordOrPhrase(promptNorm, 'dem') &&
    !hasWordOrPhrase(promptNorm, 'so luong') &&
    !hasWordOrPhrase(promptNorm, 'ty trong') &&
    !hasWordOrPhrase(promptNorm, 'ty le') &&
    !hasWordOrPhrase(promptNorm, 'thong ke') &&
    !hasWordOrPhrase(promptNorm, 'so sanh');

  // Check if user is asking to analyze/compare all departments
  const isComparingAllDepartments =
    !isFilterOnlyIntent &&
    (/(?:6|cac|tat ca|moi|tung|toan bo)\s+phong\s+ban/i.test(promptNorm) ||
     hasWordOrPhrase(promptNorm, '6 phong ban') ||
     hasWordOrPhrase(promptNorm, 'cac phong ban') ||
     hasWordOrPhrase(promptNorm, 'tung phong ban') ||
     hasWordOrPhrase(promptNorm, 'theo phong ban') ||
     hasWordOrPhrase(promptNorm, 'moi phong ban') ||
     hasWordOrPhrase(promptNorm, 'cac bo phan') ||
     hasWordOrPhrase(promptNorm, 'tung bo phan'));

  // Categorical value filter e.g. "chỉ lấy phòng Kinh Doanh" or "so sánh phòng Kinh Doanh và phòng Logistics"
  for (const col of colProfile.dimensions) {
    if (isComparingAllDepartments && (col.key === 'phong_ban' || normalizeText(col.name).includes('phong ban'))) {
      continue; // NEVER filter down to a single department when analyzing all/6 departments!
    }

    let candidateValues = (col.top_values || []).map(v => v.value);
    if (col.key === 'phong_ban' || normalizeText(col.name).includes('phong ban')) {
      const extraDepts = ['Kho Vận', 'Kho Van', 'Vận Tải', 'Van Tai', 'Kế Toán', 'Ke Toan', 'Nhân Sự', 'Nhan Su', 'Kinh Doanh', 'Logistics', 'Chăm Sóc Khách Hàng', 'CSKH', 'Công Nghệ Thông Tin (IT)', 'IT'];
      for (const ed of extraDepts) {
        if (!candidateValues.some(cv => normalizeText(cv) === normalizeText(ed))) {
          candidateValues.push(ed);
        }
      }
    }

    for (const val of candidateValues) {
      const valNorm = normalizeText(val);
      if (valNorm.length > 2 && hasWordOrPhrase(promptNorm, valNorm)) {
        // SPECIAL GUARD: "nhân sự" is both a department name and a general domain word (HR).
        if (valNorm === 'nhan su') {
          if (
            hasWordOrPhrase(promptNorm, 'co cau nhan su') ||
            hasWordOrPhrase(promptNorm, 'quy mo nhan su') ||
            hasWordOrPhrase(promptNorm, 'ty trong nhan su') ||
            hasWordOrPhrase(promptNorm, 'quan tri nhan su') ||
            hasWordOrPhrase(promptNorm, 'du lieu nhan su') ||
            hasWordOrPhrase(promptNorm, 'nhan su cua') ||
            /(?:co\s+cau|quy\s+mo|ty\s+trong|quan\s+tri|du\s+lieu)\s+nhan\s+su/i.test(promptNorm)
          ) {
            continue;
          }
          const isExplicitDept =
            /(?:phong\s+ban|phong|bo\s+phan|khoa|to|chi\s+lay|thuoc|rieng)\s+nhan\s+su\b/i.test(promptNorm) ||
            /nhan\s+su\s+va\s+(?:van tai|ke toan|kinh doanh|kho van|cskh)/i.test(promptNorm);
          if (!isExplicitDept) {
            continue;
          }
        }

        // Filter keyword must be directly associated with the dimension or value
        const hasFilterPrefix =
          isFilterOnlyIntent ||
          new RegExp(`(?:chi lay|chi xem|xem|loc|thuoc|rieng|phong|bo phan|theo)\\s+(?:so\\s+lieu\\s+|du\\s+lieu\\s+)?(?:cac\\s+|phong\\s+ban\\s+|phong\\s+|bo\\s+phan\\s+)?${valNorm}`, 'i').test(promptNorm) ||
          new RegExp(`so sanh\\s+(?:giua\\s+)?${valNorm}\\s+(?:va|voi)`, 'i').test(promptNorm) ||
          new RegExp(`(?:va|voi)\\s+${valNorm}\\b`, 'i').test(promptNorm);

        if (hasFilterPrefix) {
          filters.push({
            column: col.key,
            op: 'eq',
            value: val,
          });
          // If comparing values of this dimension and groupBy is empty, add this dimension to groupBy!
          if (groupBy.length === 0 && (hasWordOrPhrase(promptNorm, 'so sanh') || hasWordOrPhrase(promptNorm, 'giua'))) {
            groupBy.push(col.key);
          }
          break;
        }
      }
    }
  }

  // If comparing two entities and groupBy is still empty, add the filtered dimension to groupBy
  if (!isFilterOnlyIntent && groupBy.length === 0 && filters.length > 0) {
    const firstFilterCol = filters[0].column;
    if (!groupBy.includes(firstFilterCol)) {
      groupBy.push(firstFilterCol);
    }
  }

  // Numeric threshold filter e.g. "doanh thu tren 50 trieu", "luong duoi 15 tr"
  // Must ONLY apply to numeric measures (INTEGER, FLOAT) and ignore referential "file trên" / "ở trên"
  const hasNumericMetric = targetMetricCol && (targetMetricCol.type === 'INTEGER' || targetMetricCol.type === 'FLOAT');
  if (hasNumericMetric) {
    const cleanNormThreshold = promptNorm
      .replace(/\b(?:file|tep|o|nhu|bang|danh sach|du lieu)\s+tren\b/g, '')
      .replace(/\btren\s+day\b/g, '');

    const hasGte = /(?:tren|lon hon|cao hon)\s+\d+/i.test(cleanNormThreshold) || cleanNormThreshold.includes('>');
    const hasLte = /(?:duoi|nho hon|thap hon)\s+\d+/i.test(cleanNormThreshold) || cleanNormThreshold.includes('<');

    if (hasGte) {
      const thresh = parseThresholdValue(prompt);
      if (thresh !== null) {
        filters.push({
          column: targetMetricCol.key,
          op: 'gte',
          value: thresh,
        });
      }
    } else if (hasLte) {
      const thresh = parseThresholdValue(prompt);
      if (thresh !== null) {
        filters.push({
          column: targetMetricCol.key,
          op: 'lte',
          value: thresh,
        });
      }
    }
  }

  // 4b. Explicit Code / ID filter (e.g. "NV_0750", "EMP01")
  const empIdCol = datasetProfile?.columns?.find(c => /(ma_nhan_vien|emp|id|ma_nv)/i.test(c.key));
  if (empIdCol && !filters.some(f => f.column === empIdCol.key)) {
    const codeMatch = prompt.match(/\b([A-Za-z]{2,}_?\d{2,})\b/);
    if (codeMatch) {
      filters.push({
        column: empIdCol.key,
        op: 'eq',
        value: codeMatch[1],
      });
    }
  }

  // 5. Identify Computations (Percentage, Growth Rate, Period Comparison)
  const computations = [];

  // Add multi-metric computations if present
  if (isMultiMetric && multiResult.computations.length > 0) {
    for (const comp of multiResult.computations) {
      if (!computations.some((c) => c.target_alias === comp.target_alias)) {
        computations.push(comp);
      }
    }
  }

  const isPercentageRequested =
    hasWordOrPhrase(promptNorm, 'ty trong') ||
    hasWordOrPhrase(promptNorm, 'phan tram') ||
    hasWordOrPhrase(promptNorm, 'ty le') ||
    hasWordOrPhrase(promptNorm, 'co cau') ||
    promptNorm.includes('%');

  if (isPercentageRequested && !isMultiMetric) {
    computations.push({
      type: 'PERCENTAGE',
      source_alias: alias,
      target_alias: `${alias}_ty_trong_pct`,
    });
  }

  if (hasWordOrPhrase(promptNorm, 'tang truong') || hasWordOrPhrase(promptNorm, 'toc do tang') || hasWordOrPhrase(promptNorm, 'bien dong')) {
    computations.push({
      type: 'GROWTH_RATE',
      source_alias: alias,
      target_alias: `${alias}_tang_truong_pct`,
    });
  }

  let periodComparison = null;
  if (hasWordOrPhrase(promptNorm, 'so voi thang truoc') || hasWordOrPhrase(promptNorm, 'so sanh ky') || hasWordOrPhrase(promptNorm, 'so voi quy truoc')) {
    periodComparison = {
      date_column: colProfile.dates[0]?.key || 'ngay_tao',
      period: hasWordOrPhrase(promptNorm, 'quy') ? 'QUARTER_OVER_QUARTER' : 'MONTH_OVER_MONTH',
    };
  }

  // 6. Identify Sorting & Limits
  let orderBy = { column: aggregations[0]?.alias || alias, dir: 'DESC' };
  if (dateTrunc && !hasWordOrPhrase(promptNorm, 'giam dan') && !hasWordOrPhrase(promptNorm, 'top')) {
    const dateColKey = typeof groupBy[0] === 'object' ? groupBy[0].column : groupBy[0];
    orderBy = { column: dateColKey, dir: 'ASC' };
  } else if (hasWordOrPhrase(promptNorm, 'tang dan') || hasWordOrPhrase(promptNorm, 'thap nhat') || hasWordOrPhrase(promptNorm, 'it nhat')) {
    orderBy = { column: aggregations[0]?.alias || alias, dir: 'ASC' };
  }

  let limit = 20; // Default limit
  const topMatch = promptNorm.match(/top\s*(\d+)/i);
  if (isFindTopRecord) {
    limit = 1;
    const salCol = colProfile.measures.find((c) => normalizeText(c.key).includes('luong') || normalizeText(c.key).includes('salary')) || targetMetricCol;
    orderBy = { column: salCol ? salCol.key : 'luong_co_ban', dir: hasWordOrPhrase(promptNorm, 'thap nhat') ? 'ASC' : 'DESC' };
  } else if (topMatch) {
    limit = parseInt(topMatch[1], 10);
  } else if (hasWordOrPhrase(promptNorm, 'cao nhat') && !hasWordOrPhrase(promptNorm, 'theo') && !isComparingAllDepartments) {
    limit = 5;
  }
  if (isComparingAllDepartments) {
    limit = Math.max(limit, 20);
  }

  // 7. Identify Chart Preference
  const hasPieAndBar =
    (hasWordOrPhrase(promptNorm, 'pie') || hasWordOrPhrase(promptNorm, 'tron')) &&
    (hasWordOrPhrase(promptNorm, 'bar') || hasWordOrPhrase(promptNorm, 'cot'));

  const hasAnyChartExplicit =
    hasPieAndBar ||
    hasWordOrPhrase(promptNorm, 'pie') ||
    hasWordOrPhrase(promptNorm, 'bar') ||
    hasWordOrPhrase(promptNorm, 'chart') ||
    hasWordOrPhrase(promptNorm, 'bieu do') ||
    hasWordOrPhrase(promptNorm, 'tron') ||
    hasWordOrPhrase(promptNorm, 'cot') ||
    hasWordOrPhrase(promptNorm, 'line') ||
    hasWordOrPhrase(promptNorm, 'duong');

  let chartPreference = 'BAR';
  if (hasWordOrPhrase(promptNorm, 'radar') || hasWordOrPhrase(promptNorm, 'mang nhen')) {
    chartPreference = 'RADAR';
  } else if (hasWordOrPhrase(promptNorm, 'funnel') || hasWordOrPhrase(promptNorm, 'pheu')) {
    chartPreference = 'FUNNEL';
  } else if (hasWordOrPhrase(promptNorm, 'bubble') || hasWordOrPhrase(promptNorm, 'bong bong')) {
    chartPreference = 'BUBBLE';
  } else if (hasWordOrPhrase(promptNorm, 'scatter') || hasWordOrPhrase(promptNorm, 'phan tan')) {
    chartPreference = 'SCATTER';
  } else if (hasWordOrPhrase(promptNorm, 'heatmap') || hasWordOrPhrase(promptNorm, 'ban do nhiet')) {
    chartPreference = 'HEATMAP';
  } else if (hasWordOrPhrase(promptNorm, 'pareto') || hasWordOrPhrase(promptNorm, '80/20') || hasWordOrPhrase(promptNorm, '80 20')) {
    chartPreference = 'PARETO';
  } else if (hasWordOrPhrase(promptNorm, 'cot ngang') || hasWordOrPhrase(promptNorm, 'horizontal bar')) {
    chartPreference = 'HORIZONTAL_BAR';
  } else if (hasWordOrPhrase(promptNorm, 'cot nhom') || hasWordOrPhrase(promptNorm, 'grouped bar')) {
    chartPreference = 'GROUPED_BAR';
  } else if (hasWordOrPhrase(promptNorm, 'cot chong 100') || hasWordOrPhrase(promptNorm, '100% stacked bar') || hasWordOrPhrase(promptNorm, 'percent stacked bar')) {
    chartPreference = 'PERCENT_STACKED_BAR';
  } else if (hasWordOrPhrase(promptNorm, 'cot chong') || hasWordOrPhrase(promptNorm, 'stacked bar')) {
    chartPreference = 'STACKED_BAR';
  } else if (hasWordOrPhrase(promptNorm, 'lollipop') || hasWordOrPhrase(promptNorm, 'keo mut')) {
    chartPreference = 'LOLLIPOP';
  } else if (hasWordOrPhrase(promptNorm, 'sankey') || hasWordOrPhrase(promptNorm, 'luong luu chuyen') || hasWordOrPhrase(promptNorm, 'dong chuyen dich')) {
    chartPreference = 'SANKEY';
  } else if (hasWordOrPhrase(promptNorm, 'histogram') || hasWordOrPhrase(promptNorm, 'tan suat')) {
    chartPreference = 'HISTOGRAM';
  } else if (hasWordOrPhrase(promptNorm, 'gauge') || hasWordOrPhrase(promptNorm, 'dong ho')) {
    chartPreference = 'GAUGE';
  } else if (hasWordOrPhrase(promptNorm, 'waterfall') || hasWordOrPhrase(promptNorm, 'thac nuoc')) {
    chartPreference = 'WATERFALL';
  } else if (hasWordOrPhrase(promptNorm, 'boxplot') || hasWordOrPhrase(promptNorm, 'bieu do hop') || hasWordOrPhrase(promptNorm, 'hop va rau')) {
    chartPreference = 'BOXPLOT';
  } else if (hasWordOrPhrase(promptNorm, 'donut') || hasWordOrPhrase(promptNorm, 'vanh khuyen')) {
    chartPreference = 'DONUT';
  } else if (hasWordOrPhrase(promptNorm, 'treemap') || hasWordOrPhrase(promptNorm, 'cay phan cap')) {
    chartPreference = 'TREEMAP';
  } else if (hasWordOrPhrase(promptNorm, 'vung chong') || hasWordOrPhrase(promptNorm, 'stacked area')) {
    chartPreference = 'STACKED_AREA';
  } else if (hasWordOrPhrase(promptNorm, 'vung') || hasWordOrPhrase(promptNorm, 'area')) {
    chartPreference = 'AREA';
  } else if (hasWordOrPhrase(promptNorm, 'bac thang') || hasWordOrPhrase(promptNorm, 'step line')) {
    chartPreference = 'STEP_LINE';
  } else if (hasWordOrPhrase(promptNorm, 'da duong') || hasWordOrPhrase(promptNorm, 'multi line')) {
    chartPreference = 'MULTI_LINE';
  } else if (hasWordOrPhrase(promptNorm, 'combo') || (hasWordOrPhrase(promptNorm, 'duong') && hasWordOrPhrase(promptNorm, 'cot'))) {
    chartPreference = 'COMBO';
  } else if (hasWordOrPhrase(promptNorm, 'pivot') || hasWordOrPhrase(promptNorm, 'tong hop cheo')) {
    chartPreference = 'PIVOT_TABLE';
  } else if (dateTrunc || hasWordOrPhrase(promptNorm, 'xu huong') || hasWordOrPhrase(promptNorm, 'duong') || hasWordOrPhrase(promptNorm, 'line')) {
    chartPreference = 'LINE';
  } else if (hasPieAndBar) {
    chartPreference = 'BAR';
  } else if (
    hasWordOrPhrase(promptNorm, 'tron') ||
    hasWordOrPhrase(promptNorm, 'pie') ||
    hasWordOrPhrase(promptNorm, 'co cau') ||
    hasWordOrPhrase(promptNorm, 'ty trong') ||
    hasWordOrPhrase(promptNorm, 'ty le')
  ) {
    chartPreference = 'PIE';
  } else if (
    (hasWordOrPhrase(promptNorm, 'bang') && !hasWordOrPhrase(promptNorm, 'bieu do')) ||
    (!hasAnyChartExplicit && isComparingAllDepartments && isMultiMetric)
  ) {
    chartPreference = 'NONE';
  }

  // 8. Intent Classification
  let intent = 'AGGREGATION';
  if (isFilterOnlyIntent) {
    intent = 'FILTER';
    groupBy.length = 0;
    aggregations.length = 0;
    chartPreference = 'NONE';
    limit = 500;
  } else if (dateTrunc) {
    intent = 'TREND';
  } else if (isFindTopRecord || topMatch || hasWordOrPhrase(promptNorm, 'cao nhat') || hasWordOrPhrase(promptNorm, 'thap nhat')) {
    intent = 'RANKING';
    if (isFindTopRecord) {
      groupBy.length = 0;
    }
  } else if (computations.some((c) => c.type === 'PERCENTAGE') || chartPreference === 'PIE') {
    intent = 'DISTRIBUTION';
  } else if (periodComparison) {
    intent = 'COMPARISON';
  }

  const queryPlan = {
    intent,
    target_sheet: datasetProfile?.active_sheet || 'Sheet1',
    groupBy,
    aggregations,
    filters,
    computations,
    period_comparison: periodComparison,
    orderBy,
    limit,
    chart_preference: chartPreference,
    has_pie_and_bar: hasPieAndBar,
    independent_breakdowns: independentBreakdowns,
    chart_mapping: chartMapping,
    prompt: userPrompt,
    clarification_needed: false,
    clarification_question: null,
  };

  queryPlan.metric_coverage = validateMetricCoverage(userPrompt, queryPlan);
  return queryPlan;
}

/**
 * Handle Multi-turn Follow-up queries (Contextual refinement)
 */
function planFollowUpQuery(prompt, previousPlan, datasetProfile) {
  if (!previousPlan) return null;
  const promptNorm = normalizeText(prompt);

  // 1. Guard against Hijacking:
  // If the prompt is a full analytical query specification, a new chart request,
  // or user clarification/correction, return null so planAnalyticalQuery can perform a fresh, accurate re-plan!
  const hasDimensionPreposition = /(?:theo|moi|tung|cua moi|cua cac|cho tung|lien quan den|ve|cho)\s+([a-z0-9_]+)/i.test(promptNorm);
  const hasMetricKeywords = /(?:so luong|dem|bao nhieu|tong|trung binh|cao nhat|thap nhat|ty trong|co cau|luong|doanh so|trang thai|nhan vien|ho so)/i.test(promptNorm);
  const isCorrection = /(?:y toi la|toi muon|sua lai|khong phai|chu khong phai|tinh so luong chu|y la)/i.test(promptNorm);
  const isNewRequest =
    /(?:hay tao|tao bieu do|ve bieu do|tao pie|ve pie|tao bar|ve bar|hay xay dung|xay dung bao cao|lap bao cao|phan tich|thong ke)/i.test(promptNorm) ||
    /(?:lien quan den|trang thai lam viec|theo chuc vu|theo phong ban|theo ngay)/i.test(promptNorm);

  if (isCorrection || isNewRequest || (hasDimensionPreposition && hasMetricKeywords && promptNorm.length > 25)) {
    return null; // Force fresh plan!
  }

  const clonedPlan = JSON.parse(JSON.stringify(previousPlan));
  const columns = datasetProfile?.columns || [];
  const colProfile = profileColumns(columns);

  let isFollowUp = false;

  // 2. Filter adjustment: "Chỉ lấy X" or "Lọc X" or "Riêng X"
  if (hasWordOrPhrase(promptNorm, 'chi lay') || hasWordOrPhrase(promptNorm, 'loc') || hasWordOrPhrase(promptNorm, 'rieng')) {
    for (const col of colProfile.dimensions) {
      if (col.top_values) {
        for (const tv of col.top_values) {
          const valNorm = normalizeText(tv.value);
          if (valNorm.length > 1 && hasWordOrPhrase(promptNorm, valNorm)) {
            clonedPlan.filters = clonedPlan.filters || [];
            // Remove previous filter on same column if any
            clonedPlan.filters = clonedPlan.filters.filter((f) => f.column !== col.key);
            clonedPlan.filters.push({
              column: col.key,
              op: 'eq',
              value: tv.value,
            });
            isFollowUp = true;
          }
        }
      }
    }
  }

  // 3. Limit adjustment: "Top X" or "Hiển thị Top X" or "Chỉ lấy 3"
  const topMatch = promptNorm.match(/top\s*(\d+)/i);
  if (topMatch) {
    clonedPlan.limit = parseInt(topMatch[1], 10);
    clonedPlan.intent = 'RANKING';
    isFollowUp = true;
  }

  // Period comparison follow-up: "So sánh với tháng trước"
  if (hasWordOrPhrase(promptNorm, 'thang truoc') || hasWordOrPhrase(promptNorm, 'ky truoc') || hasWordOrPhrase(promptNorm, 'so sanh voi thang truoc')) {
    clonedPlan.period_comparison = {
      period: 'MONTH_OVER_MONTH',
    };
    isFollowUp = true;
  }

  // Show data table follow-up: "Thêm bảng dữ liệu chi tiết"
  if (hasWordOrPhrase(promptNorm, 'bang du lieu') || hasWordOrPhrase(promptNorm, 'chi tiet') || hasWordOrPhrase(promptNorm, 'them bang')) {
    clonedPlan.show_data_table = true;
    isFollowUp = true;
  }

  // 4. Chart Preference adjustment: "Đổi sang biểu đồ tròn / đường / cột / donut / funnel / v.v."
  if (hasWordOrPhrase(promptNorm, 'bieu do tron') || hasWordOrPhrase(promptNorm, 'hinh tron') || hasWordOrPhrase(promptNorm, 'pie')) {
    const hasMultipleDisparateMetrics = clonedPlan.aggregations && clonedPlan.aggregations.length > 1;
    if (hasMultipleDisparateMetrics) {
      clonedPlan.chart_preference = 'GROUPED_BAR';
      clonedPlan.chart_preference_explanation = 'Biểu đồ tròn chỉ hỗ trợ cơ cấu tỷ trọng của 1 chỉ số thành phần (part-to-whole). Không thể gộp nhiều chỉ tiêu có bản chất khác nhau (như Tổng và Trung bình) vào chung một biểu đồ tròn; hệ thống chuyển sang Biểu đồ Cột Nhóm.';
    } else {
      clonedPlan.chart_preference = 'PIE';
    }
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'bieu do duong') || hasWordOrPhrase(promptNorm, 'line')) {
    clonedPlan.chart_preference = 'LINE';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'bieu do cot') || hasWordOrPhrase(promptNorm, 'bar')) {
    clonedPlan.chart_preference = 'BAR';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'donut') || hasWordOrPhrase(promptNorm, 'vanh khuyen')) {
    const hasMultipleDisparateMetrics = clonedPlan.aggregations && clonedPlan.aggregations.length > 1;
    if (hasMultipleDisparateMetrics) {
      clonedPlan.chart_preference = 'GROUPED_BAR';
      clonedPlan.chart_preference_explanation = 'Biểu đồ Donut chỉ hỗ trợ cơ cấu tỷ trọng của 1 chỉ số thành phần (part-to-whole); tự động chuyển sang Biểu đồ Cột Nhóm.';
    } else {
      clonedPlan.chart_preference = 'DONUT';
    }
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'funnel') || hasWordOrPhrase(promptNorm, 'pheu')) {
    clonedPlan.chart_preference = 'FUNNEL';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'radar') || hasWordOrPhrase(promptNorm, 'mang nhen')) {
    clonedPlan.chart_preference = 'RADAR';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'scatter') || hasWordOrPhrase(promptNorm, 'phan tan')) {
    clonedPlan.chart_preference = 'SCATTER';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'bubble') || hasWordOrPhrase(promptNorm, 'bong bong')) {
    clonedPlan.chart_preference = 'BUBBLE';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'heatmap') || hasWordOrPhrase(promptNorm, 'ban do nhiet')) {
    clonedPlan.chart_preference = 'HEATMAP';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'pareto') || hasWordOrPhrase(promptNorm, '80/20') || hasWordOrPhrase(promptNorm, '80 20')) {
    clonedPlan.chart_preference = 'PARETO';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'histogram') || hasWordOrPhrase(promptNorm, 'tan suat')) {
    clonedPlan.chart_preference = 'HISTOGRAM';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'boxplot') || hasWordOrPhrase(promptNorm, 'bieu do hop')) {
    clonedPlan.chart_preference = 'BOXPLOT';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'gauge') || hasWordOrPhrase(promptNorm, 'dong ho')) {
    clonedPlan.chart_preference = 'GAUGE';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'cot ngang') || hasWordOrPhrase(promptNorm, 'horizontal bar')) {
    clonedPlan.chart_preference = 'HORIZONTAL_BAR';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'sankey') || hasWordOrPhrase(promptNorm, 'luong luu chuyen')) {
    clonedPlan.chart_preference = 'SANKEY';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'treemap') || hasWordOrPhrase(promptNorm, 'cay phan cap')) {
    clonedPlan.chart_preference = 'TREEMAP';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'waterfall') || hasWordOrPhrase(promptNorm, 'thac nuoc')) {
    clonedPlan.chart_preference = 'WATERFALL';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'lollipop') || hasWordOrPhrase(promptNorm, 'keo mut')) {
    clonedPlan.chart_preference = 'LOLLIPOP';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'combo') || hasWordOrPhrase(promptNorm, 'ket hop')) {
    clonedPlan.chart_preference = 'COMBO';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'vung') || hasWordOrPhrase(promptNorm, 'area')) {
    clonedPlan.chart_preference = 'AREA';
    isFollowUp = true;
  }
  if (isFollowUp && clonedPlan.visualizations && clonedPlan.visualizations[0] && clonedPlan.chart_preference) {
    clonedPlan.visualizations[0].chart_type = clonedPlan.chart_preference;
  }

  // 5. Sorting adjustment: "Sắp xếp tăng dần / giảm dần"
  if (hasWordOrPhrase(promptNorm, 'tang dan')) {
    if (clonedPlan.orderBy) clonedPlan.orderBy.dir = 'ASC';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'giam dan')) {
    if (clonedPlan.orderBy) clonedPlan.orderBy.dir = 'DESC';
    isFollowUp = true;
  }

  // 6. Metric Function & Measure Switch:
  // e.g. "Đổi sang tính trung bình" or "Đổi sang tính tổng doanh số" or "Tính tổng"
  const isSumRequested = hasWordOrPhrase(promptNorm, 'tong') || hasWordOrPhrase(promptNorm, 'tinh tong') || hasWordOrPhrase(promptNorm, 'sum');
  const isAvgRequested = hasWordOrPhrase(promptNorm, 'trung binh') || hasWordOrPhrase(promptNorm, 'binh quan') || hasWordOrPhrase(promptNorm, 'avg');

  if (isSumRequested || isAvgRequested) {
    if (clonedPlan.aggregations && clonedPlan.aggregations.length > 0) {
      const currentAgg = clonedPlan.aggregations[0];
      const targetFunc = isAvgRequested ? 'AVG' : 'SUM';
      currentAgg.func = targetFunc;

      // Check if user specified a measure column in prompt (e.g. "doanh số", "lương", "chi phí")
      let matchedMeasureCol = null;
      if (hasWordOrPhrase(promptNorm, 'doanh so') || hasWordOrPhrase(promptNorm, 'doanh thu')) {
        matchedMeasureCol = colProfile.measures.find((c) => normalizeText(c.key).includes('doanh_so') || normalizeText(c.key).includes('doanhso'));
      } else if (hasWordOrPhrase(promptNorm, 'luong') || hasWordOrPhrase(promptNorm, 'thu nhap')) {
        matchedMeasureCol = colProfile.measures.find((c) => normalizeText(c.key).includes('luong') || normalizeText(c.key).includes('salary'));
      } else if (hasWordOrPhrase(promptNorm, 'chi phi')) {
        matchedMeasureCol = colProfile.measures.find((c) => normalizeText(c.key).includes('chi_phi'));
      }

      // If user specified a measure, or if currentAgg.column was a non-numeric identifier (e.g. ma_don, ma_nhan_vien)
      const currentMeta = columns.find((c) => c.key === currentAgg.column);
      const isCurrentNonNumeric = currentMeta && currentMeta.type !== 'INTEGER' && currentMeta.type !== 'FLOAT';

      if (matchedMeasureCol) {
        currentAgg.column = matchedMeasureCol.key;
      } else if (isCurrentNonNumeric && colProfile.measures.length > 0) {
        currentAgg.column = colProfile.measures[0].key;
      }

      currentAgg.alias = `${targetFunc.toLowerCase()}_${currentAgg.column}`;
      if (clonedPlan.orderBy) clonedPlan.orderBy.column = currentAgg.alias;
      isFollowUp = true;
    }
  }

  // 7. Dimension Switch keeping metric:
  // e.g. "Còn theo công ty thì sao?", "Thế còn theo công ty?", "Thống kê theo chi nhánh"
  if (
    hasWordOrPhrase(promptNorm, 'con theo') ||
    hasWordOrPhrase(promptNorm, 'the con') ||
    (promptNorm.length < 30 && (hasWordOrPhrase(promptNorm, 'theo cong ty') || hasWordOrPhrase(promptNorm, 'theo chi nhanh') || hasWordOrPhrase(promptNorm, 'theo phong ban')))
  ) {
    for (const col of colProfile.dimensions) {
      const colNameNorm = normalizeText(col.name);
      const colKeyNorm = normalizeText(col.key);
      if (hasWordOrPhrase(promptNorm, colNameNorm) || hasWordOrPhrase(promptNorm, colKeyNorm)) {
        clonedPlan.groupBy = [col.key];
        isFollowUp = true;
        break;
      }
    }
  }

  // 8. Computation adjustment: "Thêm tỷ trọng" or "Tính phần trăm"
  if (hasWordOrPhrase(promptNorm, 'ty trong') || hasWordOrPhrase(promptNorm, 'phan tram')) {
    clonedPlan.computations = clonedPlan.computations || [];
    const sourceAlias = clonedPlan.aggregations[0]?.alias || 'value';
    if (!clonedPlan.computations.some((c) => c.type === 'PERCENTAGE')) {
      clonedPlan.computations.push({
        type: 'PERCENTAGE',
        source_alias: sourceAlias,
        target_alias: `${sourceAlias}_ty_trong_pct`,
      });
      clonedPlan.chart_preference = 'PIE';
      clonedPlan.intent = 'DISTRIBUTION';
      isFollowUp = true;
    }
  }

  return isFollowUp ? clonedPlan : null;
}

/**
 * Validate that all metrics requested in natural language prompt are present in the query plan
 * @param {string} prompt - User question
 * @param {Object} plan - Query plan
 * @returns {Object} Validation status and missing metrics
 */
function validateMetricCoverage(prompt, plan) {
  const promptNorm = normalizeText(prompt || '');
  const aggregations = plan?.aggregations || [];
  const missing = [];

  const asksSumSal =
    hasWordOrPhrase(promptNorm, 'tong luong') ||
    hasWordOrPhrase(promptNorm, 'tong quy luong') ||
    hasWordOrPhrase(promptNorm, 'chi phi luong') ||
    hasWordOrPhrase(promptNorm, 'tong luong co ban') ||
    hasWordOrPhrase(promptNorm, 'tong tien luong');
  if (asksSumSal && !aggregations.some((a) => String(a.func).toUpperCase() === 'SUM' && /(luong|salary|thu_nhap)/i.test(a.column))) {
    missing.push('SUM(luong)');
  }

  const asksAvgSal =
    hasWordOrPhrase(promptNorm, 'luong trung binh') ||
    hasWordOrPhrase(promptNorm, 'thu nhap trung binh') ||
    hasWordOrPhrase(promptNorm, 'binh quan luong') ||
    hasWordOrPhrase(promptNorm, 'luong tb');
  if (asksAvgSal && !aggregations.some((a) => String(a.func).toUpperCase() === 'AVG' && /(luong|salary|thu_nhap)/i.test(a.column))) {
    missing.push('AVG(luong)');
  }

  const asksAvgKpi =
    hasWordOrPhrase(promptNorm, 'kpi trung binh') ||
    hasWordOrPhrase(promptNorm, 'diem kpi') ||
    hasWordOrPhrase(promptNorm, 'kpi tb');
  if (asksAvgKpi && !aggregations.some((a) => /(kpi)/i.test(a.column))) {
    missing.push('AVG(diem_kpi)');
  }

  const asksSumOt =
    hasWordOrPhrase(promptNorm, 'tong gio tang ca') ||
    hasWordOrPhrase(promptNorm, 'tong so gio tang ca') ||
    hasWordOrPhrase(promptNorm, 'tong tang ca');
  if (asksSumOt && !aggregations.some((a) => String(a.func).toUpperCase() === 'SUM' && /(tang_ca|ot)/i.test(a.column))) {
    missing.push('SUM(gio_tang_ca)');
  }

  const asksSumLeave =
    hasWordOrPhrase(promptNorm, 'tong so ngay nghi') ||
    hasWordOrPhrase(promptNorm, 'tong ngay nghi') ||
    hasWordOrPhrase(promptNorm, 'tong nghi phep') ||
    hasWordOrPhrase(promptNorm, 'tong so ngay phep');
  if (asksSumLeave && !aggregations.some((a) => String(a.func).toUpperCase() === 'SUM' && /(ngay_nghi|phep)/i.test(a.column))) {
    missing.push('SUM(so_ngay_nghi)');
  }

  return {
    isComplete: missing.length === 0,
    missing,
  };
}

module.exports = {
  planAnalyticalQuery,
  planFollowUpQuery,
  decomposeCompositeRequirements,
  validateMetricCoverage,
  matchColumnFromText,
  parseThresholdValue,
  normalizeText,
  profileColumns,
  hasWordOrPhrase,
};
