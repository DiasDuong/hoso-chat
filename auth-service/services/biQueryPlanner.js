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
  doanh_so: ['doanh so', 'doanh thu', 'sales', 'revenue', 'tong thu'],
  doanh_thu: ['doanh thu', 'doanh so', 'sales', 'revenue', 'tong thu'],
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
    .replace(/(?:file|tep|o|nhu|bang|danh sach|du lieu)\s+tren\b/g, '')
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

  // 3. Average Salary (Lương trung bình)
  const isAvgSalaryMention =
    hasWordOrPhrase(promptNorm, 'luong trung binh') ||
    hasWordOrPhrase(promptNorm, 'thu nhap trung binh') ||
    hasWordOrPhrase(promptNorm, 'binh quan luong') ||
    hasWordOrPhrase(promptNorm, 'luong tb');

  if (isAvgSalaryMention) {
    const salCol = colProfile.measures.find((c) => {
      const k = normalizeText(c.key);
      const n = normalizeText(c.name);
      return k.includes('luong') || k.includes('salary') || k.includes('thu_nhap') || n.includes('luong');
    });
    if (salCol) {
      metrics.push({
        column: salCol.key,
        func: 'AVG',
        alias: `avg_${salCol.key}`,
      });
    }
  }

  // 4. Total Salary (Tổng quỹ lương)
  const isSumSalaryMention =
    hasWordOrPhrase(promptNorm, 'tong quy luong') ||
    hasWordOrPhrase(promptNorm, 'chi phi luong') ||
    hasWordOrPhrase(promptNorm, 'quy luong') ||
    hasWordOrPhrase(promptNorm, 'tong tien luong') ||
    (hasWordOrPhrase(promptNorm, 'tong luong') && !isAvgSalaryMention);

  if (isSumSalaryMention) {
    const salCol = colProfile.measures.find((c) => {
      const k = normalizeText(c.key);
      const n = normalizeText(c.name);
      return k.includes('luong') || k.includes('salary') || k.includes('thu_nhap') || n.includes('luong');
    });
    if (salCol) {
      metrics.push({
        column: salCol.key,
        func: 'SUM',
        alias: `sum_${salCol.key}`,
      });
    }
  }

  // 5. Average KPI
  const isKpiMention =
    hasWordOrPhrase(promptNorm, 'kpi trung binh') ||
    hasWordOrPhrase(promptNorm, 'diem kpi') ||
    hasWordOrPhrase(promptNorm, 'kpi tb') ||
    hasWordOrPhrase(promptNorm, 'hieu suat kpi') ||
    hasWordOrPhrase(promptNorm, 'kpi');

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

  // 6. Overtime Hours (Giờ tăng ca trung bình)
  const isOtMention =
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
      metrics.push({
        column: otCol.key,
        func: 'AVG',
        alias: `avg_${otCol.key}`,
      });
    }
  }

  // 7. Leave Days (Số ngày nghỉ trung bình)
  const isLeaveMention =
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
      metrics.push({
        column: leaveCol.key,
        func: 'AVG',
        alias: `avg_${leaveCol.key}`,
      });
    }
  }

  return { metrics, computations, empColKey: empCol ? empCol.key : null };
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

  if (isCountEntityIntent) {
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

  const alias = `${func.toLowerCase()}_${targetMetricCol.key}`;
  let aggregations = [{
    column: targetMetricCol.key,
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

    if (isMatch && !groupBy.some((g) => (typeof g === 'string' ? g : g.column) === col.key)) {
      groupBy.push(col.key);
    }
  }

  // C. Special Check for Individual Employee Ranking (e.g. "Top 5 nhân viên theo số lô xử lý")
  if (
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

  // Check if user is asking to analyze/compare all departments
  const isComparingAllDepartments =
    /(?:6|cac|tat ca|moi|tung|toan bo)\s+phong\s+ban/i.test(promptNorm) ||
    hasWordOrPhrase(promptNorm, '6 phong ban') ||
    hasWordOrPhrase(promptNorm, 'cac phong ban') ||
    hasWordOrPhrase(promptNorm, 'tung phong ban') ||
    hasWordOrPhrase(promptNorm, 'theo phong ban') ||
    hasWordOrPhrase(promptNorm, 'moi phong ban') ||
    hasWordOrPhrase(promptNorm, 'cac bo phan') ||
    hasWordOrPhrase(promptNorm, 'tung bo phan');

  // Categorical value filter e.g. "chỉ lấy phòng Kinh Doanh" or "so sánh phòng Kinh Doanh và phòng Logistics"
  for (const col of colProfile.dimensions) {
    if (isComparingAllDepartments && (col.key === 'phong_ban' || normalizeText(col.name).includes('phong ban'))) {
      continue; // NEVER filter down to a single department when analyzing all/6 departments!
    }
    if (col.top_values) {
      for (const tv of col.top_values) {
        const valNorm = normalizeText(tv.value);
        if (valNorm.length > 2 && hasWordOrPhrase(promptNorm, valNorm)) {
          // SPECIAL GUARD: "nhân sự" is both a department name and a general domain word (HR).
          // Only treat "nhân sự" as a department filter if explicitly specified as a department:
          // e.g. "phòng nhân sự", "thuộc phòng nhân sự", "chỉ lấy nhân sự", "riêng nhân sự"
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
              continue; // Do NOT falsely filter out all other departments!
            }
            const isExplicitDept =
              /(?:phong|bo phan|khoa|to|chi lay|thuoc|rieng)\s+nhan\s+su\b/i.test(promptNorm) ||
              /nhan\s+su\s+va\s+(?:van tai|ke toan|kinh doanh|kho van|cskh)/i.test(promptNorm);
            if (!isExplicitDept) {
              continue; // Do NOT falsely filter out all other departments!
            }
          }

          // Filter keyword must be directly associated with the dimension or value
          const hasFilterPrefix =
            new RegExp(`(?:chi lay|loc|thuoc|rieng|phong|bo phan)\\s+(?:cac\\s+)?${valNorm}`, 'i').test(promptNorm) ||
            new RegExp(`so sanh\\s+(?:giua\\s+)?${valNorm}\\s+(?:va|voi)`, 'i').test(promptNorm) ||
            new RegExp(`(?:va|voi)\\s+${valNorm}\\b`, 'i').test(promptNorm);

          if (hasFilterPrefix) {
            filters.push({
              column: col.key,
              op: 'eq',
              value: tv.value,
            });
            // If comparing values of this dimension and groupBy is empty, add this dimension to groupBy!
            if (groupBy.length === 0 && (hasWordOrPhrase(promptNorm, 'so sanh') || hasWordOrPhrase(promptNorm, 'giua'))) {
              groupBy.push(col.key);
            }
          }
        }
      }
    }
  }

  // If comparing two entities and groupBy is still empty, add the filtered dimension to groupBy
  if (groupBy.length === 0 && filters.length > 0) {
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
      .replace(/(?:file|tep|o|nhu|bang|danh sach|du lieu)\s+tren\b/g, '')
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
  if (hasWordOrPhrase(promptNorm, 'tang dan') || hasWordOrPhrase(promptNorm, 'thap nhat') || hasWordOrPhrase(promptNorm, 'it nhat')) {
    orderBy = { column: aggregations[0]?.alias || alias, dir: 'ASC' };
  }

  let limit = 20; // Default limit
  const topMatch = promptNorm.match(/top\s*(\d+)/i);
  if (topMatch) {
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

  let chartPreference = 'BAR';
  if (dateTrunc || hasWordOrPhrase(promptNorm, 'xu huong') || hasWordOrPhrase(promptNorm, 'duong') || hasWordOrPhrase(promptNorm, 'line')) {
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
  } else if (hasWordOrPhrase(promptNorm, 'bang') && !hasWordOrPhrase(promptNorm, 'bieu do')) {
    chartPreference = 'NONE';
  }

  // 8. Intent Classification
  let intent = 'AGGREGATION';
  if (dateTrunc) {
    intent = 'TREND';
  } else if (topMatch || hasWordOrPhrase(promptNorm, 'cao nhat') || hasWordOrPhrase(promptNorm, 'thap nhat')) {
    intent = 'RANKING';
  } else if (computations.some((c) => c.type === 'PERCENTAGE') || chartPreference === 'PIE') {
    intent = 'DISTRIBUTION';
  } else if (periodComparison) {
    intent = 'COMPARISON';
  }

  return {
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
    clarification_needed: false,
    clarification_question: null,
  };
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
    isFollowUp = true;
  }

  // 4. Chart Preference adjustment: "Đổi sang biểu đồ tròn / đường / cột"
  if (hasWordOrPhrase(promptNorm, 'bieu do tron') || hasWordOrPhrase(promptNorm, 'pie')) {
    clonedPlan.chart_preference = 'PIE';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'bieu do duong') || hasWordOrPhrase(promptNorm, 'line')) {
    clonedPlan.chart_preference = 'LINE';
    isFollowUp = true;
  } else if (hasWordOrPhrase(promptNorm, 'bieu do cot') || hasWordOrPhrase(promptNorm, 'bar')) {
    clonedPlan.chart_preference = 'BAR';
    isFollowUp = true;
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

module.exports = {
  planAnalyticalQuery,
  planFollowUpQuery,
  matchColumnFromText,
  parseThresholdValue,
  normalizeText,
  profileColumns,
  hasWordOrPhrase,
};
