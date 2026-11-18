/**
 * SOTRANS HUB — BI REPORTING HELPER (PHASE 1.3)
 * 
 * Central Intelligence & Presentation Layer for BI Reporting in General AI
 * - Natural Language BI Intent Classification (BI_QUERY vs NORMAL_CHAT vs AMBIGUOUS_BI_QUERY)
 * - 17 Standard KPI Matching from KPI_CATALOG
 * - Vietnamese Date Range Resolution (Asia/Ho_Chi_Minh)
 * - Strict Tenant Enforcer (ADMIN Whitelist, HR Context Force)
 * - Safe Reporting API / Analytics Engine Execution
 * - Visual Markdown & Interactive Widget Presentation
 */

const analyticsEngine = require('./analyticsEngine');
const { validateDashboardPayload, assertValidDashboardPayload } = require('./biDashboardSchemaValidator');
const { signReport } = require('./biExportToken');

// Whitelist of valid company tenant values
const ALLOWED_ADMIN_TENANTS = Object.freeze(['STL', 'VTX', 'SWC', 'ALL']);
const VALID_HR_TENANTS = Object.freeze(['STL', 'VTX', 'SWC']);

// ============================================================================
// TIMEZONE & DATE PARSER (VIETNAMESE NATURAL LANGUAGE -> YYYY-MM-DD)
// ============================================================================

function getNowVN() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 7 * 3600000);
}

function formatDateISO(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseExplicitDate(str) {
  if (!str) return null;
  const s = str.trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s ? s : null;
  }
  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3];
    const iso = `${year}-${month}-${day}`;
    return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null;
  }
  return null;
}

function resolveDateRangeVN(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const now = getNowVN();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const date = now.getDate();
  const dayOfWeek = now.getDay(); // 0 = Sun, 1 = Mon ...

  // 1. Explicit range: "từ DD/MM/YYYY đến DD/MM/YYYY" or "YYYY-MM-DD đến YYYY-MM-DD"
  const rangeMatch = lower.match(/(?:từ\s+)?(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2})\s*(?:đến|tới|-)\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2})/i);
  if (rangeMatch) {
    const start = parseExplicitDate(rangeMatch[1]);
    const end = parseExplicitDate(rangeMatch[2]);
    if (start && end) {
      return {
        startDate: start,
        endDate: end,
        label: `Từ ${start} đến ${end}`,
      };
    }
    return { invalid: true, label: 'Khoảng ngày không hợp lệ' };
  }

  // 2. "hôm nay"
  if (/\bhôm nay\b/i.test(lower)) {
    const todayStr = formatDateISO(now);
    return { startDate: todayStr, endDate: todayStr, label: 'Hôm nay' };
  }

  // 3. "hôm qua"
  if (/\bhôm qua\b/i.test(lower)) {
    const yest = new Date(now);
    yest.setDate(date - 1);
    const yestStr = formatDateISO(yest);
    return { startDate: yestStr, endDate: yestStr, label: 'Hôm qua' };
  }

  // 4. "tuần này"
  if (/\btuần này\b/i.test(lower)) {
    const diff = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek; // Monday
    const monday = new Date(now);
    monday.setDate(date + diff);
    return {
      startDate: formatDateISO(monday),
      endDate: formatDateISO(now),
      label: 'Tuần này',
    };
  }

  // 5. "tuần trước"
  if (/\btuần trước\b/i.test(lower)) {
    const diff = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek - 7;
    const lastMon = new Date(now);
    lastMon.setDate(date + diff);
    const lastSun = new Date(lastMon);
    lastSun.setDate(lastMon.getDate() + 6);
    return {
      startDate: formatDateISO(lastMon),
      endDate: formatDateISO(lastSun),
      label: 'Tuần trước',
    };
  }

  // 6. "tháng này"
  if (/\btháng này\b/i.test(lower)) {
    const startOfMonth = new Date(year, month, 1);
    return {
      startDate: formatDateISO(startOfMonth),
      endDate: formatDateISO(now),
      label: 'Tháng này',
    };
  }

  // 7. "tháng trước"
  if (/\btháng trước\b/i.test(lower)) {
    const startOfLastMonth = new Date(year, month - 1, 1);
    const endOfLastMonth = new Date(year, month, 0);
    return {
      startDate: formatDateISO(startOfLastMonth),
      endDate: formatDateISO(endOfLastMonth),
      label: 'Tháng trước',
    };
  }

  // 8. "quý này"
  if (/\bquý này\b/i.test(lower)) {
    const quarter = Math.floor(month / 3);
    const startOfQuarter = new Date(year, quarter * 3, 1);
    return {
      startDate: formatDateISO(startOfQuarter),
      endDate: formatDateISO(now),
      label: `Quý ${quarter + 1}/${year}`,
    };
  }

  // 9. "quý trước"
  if (/\bquý trước\b/i.test(lower)) {
    const quarter = Math.floor(month / 3) - 1;
    const qYear = quarter < 0 ? year - 1 : year;
    const qIdx = (quarter + 4) % 4;
    const startOfQuarter = new Date(qYear, qIdx * 3, 1);
    const endOfQuarter = new Date(qYear, (qIdx + 1) * 3, 0);
    return {
      startDate: formatDateISO(startOfQuarter),
      endDate: formatDateISO(endOfQuarter),
      label: `Quý ${qIdx + 1}/${qYear}`,
    };
  }

  // 10. "quý 1", "quý 2", "quý 3", "quý 4" (hoặc "quý 1/2026")
  const quarterExplicitMatch = lower.match(/\bquý\s+([1-4])(?:\s*(?:năm|\/)?\s*(\d{4}))?\b/i);
  if (quarterExplicitMatch) {
    const qNum = parseInt(quarterExplicitMatch[1], 10);
    const qYear = quarterExplicitMatch[2] ? parseInt(quarterExplicitMatch[2], 10) : year;
    const startQ = new Date(qYear, (qNum - 1) * 3, 1);
    const endQ = new Date(qYear, qNum * 3, 0);
    return {
      startDate: formatDateISO(startQ),
      endDate: formatDateISO(endQ),
      label: `Quý ${qNum}/${qYear}`,
    };
  }

  // 11. "năm nay"
  if (/\bnăm nay\b/i.test(lower)) {
    const startOfYear = new Date(year, 0, 1);
    return {
      startDate: formatDateISO(startOfYear),
      endDate: formatDateISO(now),
      label: `Năm ${year}`,
    };
  }

  // 12. "tháng MM/YYYY" or "tháng MM"
  if (/năm\s+trước/i.test(lower)) {
    return { startDate: `${year - 1}-01-01`, endDate: `${year - 1}-12-31`, label: `Năm ${year - 1}` };
  }
  const monthMatch = lower.match(/\btháng\s+(\d{1,2})(?:\/(\d{4}))?\b/i);
  if (monthMatch) {
    const m = parseInt(monthMatch[1], 10);
    const y = monthMatch[2] ? parseInt(monthMatch[2], 10) : year;
    if (m >= 1 && m <= 12) {
      const startM = new Date(y, m - 1, 1);
      const endM = new Date(y, m, 0);
      return {
        startDate: formatDateISO(startM),
        endDate: formatDateISO(endM),
        label: `Tháng ${m}/${y}`,
      };
    }
    return { invalid: true, label: 'Tháng không hợp lệ' };
  }

  return null;
}

// ============================================================================
// COMPANY RESOLVER FROM TEXT
// ============================================================================

function detectCompanyFromText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  // All / Group
  if (
    /\b(toàn tập đoàn|tất cả công ty|cả 3 công ty|tất cả các công ty|toàn bộ tập đoàn|cả tập đoàn|toàn hệ thống|all)\b/i.test(lower)
  ) {
    return 'ALL';
  }

  // Specific companies (ensure words are properly delimited)
  const hasSTL = /(?:^|\s|[.,;])(stl|sotrans\s+logistics|logistics)(?:$|\s|[.,;])/i.test(lower);
  const hasVTX = /(?:^|\s|[.,;])(vtx|vietranstimex)(?:$|\s|[.,;])/i.test(lower);
  const hasSWC = /(?:^|\s|[.,;])(swc|sowatco|đường\s+sông)(?:$|\s|[.,;])/i.test(lower);

  const matched = [];
  if (hasSTL) matched.push('STL');
  if (hasVTX) matched.push('VTX');
  if (hasSWC) matched.push('SWC');

  if (matched.length === 1) {
    return matched[0];
  }
  if (matched.length > 1) {
    return 'ALL'; // Multi-company request defaults to ALL for comparison
  }

  return null;
}

// ============================================================================
// INTENT CLASSIFICATION & KPI MATCHING
// ============================================================================

const KPI_PATTERNS = [
  // 1. DOC_TOTAL
  {
    code: 'DOC_TOTAL',
    patterns: [
      /(?:tổng\s+số|bao\s+nhiêu|số\s+lượng|tình\s+hình|báo\s+cáo|thống\s+kê)\s+(?:văn\s+bản|quy\s+định|quy\s+chế|tài\s+liệu)/i,
      /(?:văn\s+bản|quy\s+định)\s+(?:hiện\s+tại|hiện\s+có|còn\s+hiệu\s+lực)/i,
      /tổng\s+văn\s+bản/i,
      /tình\s+hình\s+văn\s+bản/i,
    ],
  },
  // 2. DOC_BY_EFFECTIVE_DATE
  {
    code: 'DOC_BY_EFFECTIVE_DATE',
    patterns: [
      /văn\s+bản\s+theo\s+ngày\s+hiệu\s+lực/i,
      /ngày\s+hiệu\s+lực\s+của\s+văn\s+bản/i,
      /văn\s+bản\s+hiệu\s+lực\s+theo\s+tháng/i,
    ],
  },
  // 3. DOC_BY_TYPE
  {
    code: 'DOC_BY_TYPE',
    patterns: [
      /(?:cơ\s+cấu|phân\s+loại|loại\s+hình|chuyên\s+mục)\s+(?:văn\s+bản|quy\s+định|tài\s+liệu)/i,
      /các\s+loại\s+văn\s+bản\s+(?:trong|của)/i,
    ],
  },
  // 4. DOC_STATUS
  {
    code: 'DOC_STATUS',
    patterns: [
      /(?:trạng\s+thái|vòng\s+đời|tình\s+trạng)\s+(?:văn\s+bản|quy\s+định)/i,
      /tỷ\s+lệ\s+văn\s+bản\s+(?:active|hết\s+hiệu\s+lực)/i,
    ],
  },
  // 5. INTAKE_UPLOADS
  {
    code: 'INTAKE_UPLOADS',
    patterns: [
      /(?:báo\s+cáo|thống\s+kê|tình\s+hình|bao\s+nhiêu|số\s+lượng|tổng\s+số)\s+(?:hồ\s+sơ|lô\s+nạp|file|tệp)\s*(?:tiếp\s+nhận|tải\s+lên|upload)?/i,
      /(?:báo\s+cáo|thống\s+kê|tình\s+hình)?\s*(?:tiếp\s+nhận\s+hồ\s+sơ|nạp\s+hồ\s+sơ|upload\s+hồ\s+sơ|hồ\s+sơ\s+tiếp\s+nhận|hồ\s+sơ\s+tải\s+lên)/i,
      /báo\s+cáo\s+hồ\s+sơ/i,
      /số\s+lô\s+tiếp\s+nhận/i,
    ],
  },
  // 6. INTAKE_BY_USER
  {
    code: 'INTAKE_BY_USER',
    patterns: [
      /(?:cán\s+bộ|người\s+dùng|user|ai)\s+(?:tải\s+lên|nạp|upload)\s+(?:nhiều|hồ\s+sơ)/i,
      /tiếp\s+nhận\s+theo\s+(?:cán\s+bộ|người\s+dùng|user|hr)/i,
      /thống\s+kê\s+theo\s+người\s+nạp/i,
    ],
  },
  // 7. INTAKE_TRENDS
  {
    code: 'INTAKE_TRENDS',
    patterns: [
      /xu\s+hướng\s+tiếp\s+nhận/i,
      /tiếp\s+nhận\s+(?:hồ\s+sơ\s+)?theo\s+tháng/i,
      /biến\s+động\s+nạp\s+hồ\s+sơ/i,
    ],
  },
  // 8. INTAKE_SUCCESS
  {
    code: 'INTAKE_SUCCESS',
    patterns: [
      /tỷ\s+lệ\s+(?:chuyển\s+đổi|thành\s+công|staging)/i,
      /chuyển\s+đổi\s+hồ\s+sơ\s+thành\s+công/i,
      /bao\s+nhiêu\s+lô\s+hoàn\s+tất/i,
    ],
  },
  // 9. INTAKE_FAILURE (BLOCKED)
  {
    code: 'INTAKE_FAILURE',
    patterns: [
      /tỷ\s+lệ\s+(?:thất\s+bại|lỗi\s+nạp|lỗi\s+tiếp\s+nhận)/i,
      /bao\s+nhiêu\s+hồ\s+sơ\s+(?:bị\s+lỗi|thất\s+bại)/i,
    ],
  },
  // 10. INTAKE_DURATION (BLOCKED)
  {
    code: 'INTAKE_DURATION',
    patterns: [
      /thời\s+gian\s+(?:xử\s+lý|trích\s+xuất)\s+trung\s+bình/i,
      /mất\s+bao\s+lâu\s+để\s+(?:xử\s+lý|trích\s+xuất)\s+hồ\s+sơ/i,
      /tốc\s+độ\s+xử\s+lý\s+hồ\s+sơ/i,
    ],
  },
  // 11. DUPLICATE_RATE
  {
    code: 'DUPLICATE_RATE',
    patterns: [
      /tỷ\s+lệ\s+(?:nghi\s+trùng|trùng\s+lặp)\s+(?:hồ\s+sơ\s+)?(?:cccd|căn\s+cước)/i,
      /hồ\s+sơ\s+(?:nghi\s+trùng|trùng\s+cccd)/i,
      /trùng\s+lặp\s+(?:hồ\s+sơ\s+)?căn\s+cước/i,
      /trùng\s+lặp\s+cccd/i,
      /duyệt\s+trùng/i,
    ],
  },
  // 12. POLICY_CONFLICT (BLOCKED)
  {
    code: 'POLICY_CONFLICT',
    patterns: [
      /xung\s+đột\s+(?:chính\s+sách|văn\s+bản|quy\s+định)/i,
      /mâu\s+thuẫn\s+(?:chính\s+sách|quy\s+định)/i,
    ],
  },
  // 13. APPROVAL_QUEUE
  {
    code: 'APPROVAL_QUEUE',
    patterns: [
      /(?:hồ\s+sơ|yêu\s+cầu)\s+(?:đang\s+)?chờ\s+(?:phê\s+)?duyệt/i,
      /tồn\s+đọng\s+phê\s+duyệt/i,
      /hồ\s+sơ\s+(?:được\s+duyệt|bị\s+từ\s+chối)/i,
      /hoạt\s+động\s+duyệt\s+hồ\s+sơ/i,
    ],
  },
  // 14. OCR_QUALITY
  {
    code: 'OCR_QUALITY',
    patterns: [
      /chất\s+lượng\s+(?:ocr|số\s+hóa|phân\s+tích\s+văn\s+bản)/i,
      /điểm\s+(?:ocr|parse\s+quality)/i,
    ],
  },
  // 15. DATA_INTEGRITY
  {
    code: 'DATA_INTEGRITY',
    patterns: [
      /hồ\s+sơ\s+(?:thiếu\s+trường|nghi\s+vấn|không\s+chắc\s+chắn)/i,
      /độ\s+toàn\s+vẹn\s+dữ\s+liệu/i,
      /missing\s+fields/i,
    ],
  },
  // 16. ACTIVE_USERS
  {
    code: 'ACTIVE_USERS',
    patterns: [
      /người\s+dùng\s+hoạt\s+động/i,
      /tài\s+khoản\s+active/i,
      /tần\s+suất\s+đăng\s+nhập/i,
      /tình\s+hình\s+sử\s+dụng\s+hệ\s+thống/i,
    ],
  },
  // 17. RAG_ANSWERABLE
  {
    code: 'RAG_ANSWERABLE',
    patterns: [
      /(?:tỷ\s+lệ\s+)?(?:trả\s+lời|đáp\s+ứng)\s+(?:của\s+)?(?:chatbot|rag)/i,
      /(?:tỷ\s+lệ\s+)?(?:chatbot|rag)\s+(?:trả\s+lời|đáp\s+ứng)/i,
      /chatbot\s+trả\s+lời\s+được\s+bao\s+nhiêu/i,
      /độ\s+tương\s+đồng\s+vector/i,
    ],
  },
];

// Summary triggers that map to executive dashboard group
const SUMMARY_PATTERNS = [
  /báo\s+cáo\s+(?:tổng\s+quan|toàn\s+diện|bi|tình\s+hình)/i,
  /tổng\s+quan\s+hệ\s+thống/i,
  /chỉ\s+số\s+kpi\s+(?:chính|tổng\s+quan)/i,
];

function detectBIIntent(userMessage, historyText = '', user = null) {
  const q = (userMessage || '').trim();
  const lower = q.toLowerCase();

  // Guard against prompt injection attempting SQL execution
  if (/(?:chạy\s+sql|viết\s+sql|thực\s+thi\s+sql|select\s+\*|drop\s+table|delete\s+from|insert\s+into)/i.test(lower)) {
    return {
      isBIQuery: false,
      intent: 'NORMAL_CHAT',
      kpiCodes: [],
      reason: 'SQL generation is prohibited',
    };
  }

  // Guard against hijacking queries that explicitly target an uploaded file / spreadsheet
  if (/(?:từ\s+file|dựa\s+vào\s+file|trong\s+file|bảng\s+tính|file\s+excel|file\s+mới\s+tải|file\s+trên|file\s+đang\s+gắn)/i.test(lower)) {
    return {
      isBIQuery: false,
      intent: 'NORMAL_CHAT',
      kpiCodes: [],
      reason: 'Query explicitly targets uploaded file dataset',
    };
  }

  // Check summary triggers
  let matchedKPIs = [];
  const isSummary = SUMMARY_PATTERNS.some(p => p.test(lower));
  if (isSummary) {
    matchedKPIs = ['DOC_TOTAL', 'INTAKE_UPLOADS', 'INTAKE_SUCCESS', 'APPROVAL_QUEUE', 'ACTIVE_USERS', 'RAG_ANSWERABLE'];
  } else {
    for (const item of KPI_PATTERNS) {
      if (item.patterns.some(p => p.test(lower))) {
        matchedKPIs.push(item.code);
      }
    }
  }

  // If no KPI matched, check general data reporting keywords specifically for SOTRANS Hub
  if (matchedKPIs.length === 0) {
    if (/(?:báo\s+cáo|thống\s+kê|số\s+liệu)\s+(?:về\s+)?(?:sotrans|hệ\s+thống|văn\s+bản|hồ\s+sơ|nhân\s+sự|người\s+dùng|hoạt\s+động)/i.test(lower)) {
      matchedKPIs = ['DOC_TOTAL', 'INTAKE_UPLOADS', 'ACTIVE_USERS'];
    }
  }

  // Not a BI Query -> Normal Chat
  if (matchedKPIs.length === 0 && /^(còn|thế|vậy|chỉ|đổi|so với|tháng|quý|năm|tuần|hôm)/i.test(q)) {
    const blocks = [...String(historyText).matchAll(/```bi-report\s*\n([\s\S]*?)```/g)];
    if (blocks.length) {
      try {
        const prior = JSON.parse(blocks[blocks.length - 1][1]);
        matchedKPIs = (prior.results || []).map(item => item.kpi).filter(code => analyticsEngine.KPI_CATALOG[code]);
      } catch (_) {}
    }
  }
  if (matchedKPIs.length === 0) {
    return {
      isBIQuery: false,
      intent: 'NORMAL_CHAT',
      kpiCodes: [],
    };
  }

  // Date range resolution
  const dateRange = resolveDateRangeVN(q) || resolveDateRangeVN(historyText);

  // Company detection
  let detectedCompany = detectCompanyFromText(q) || detectCompanyFromText(historyText);

  // Tenant logic & Ambiguity handling
  const role = user?.role ? String(user.role).trim().toUpperCase() : null;

  if (role === 'HR') {
    // HR is always strictly bound to their assigned company
    detectedCompany = user.company_id ? String(user.company_id).trim().toUpperCase() : 'STL';
  }

  // If ADMIN and no company is detected, it is an AMBIGUOUS_BI_QUERY
  if (role === 'ADMIN' && !detectedCompany) {
    return {
      isBIQuery: true,
      intent: 'AMBIGUOUS_BI_QUERY',
      kpiCodes: matchedKPIs,
      companyId: null,
      startDate: dateRange?.startDate || null,
      endDate: dateRange?.endDate || null,
      clarificationRequired: true,
      clarificationQuestion:
        'Để cung cấp số liệu chính xác, bạn muốn xem báo cáo của đơn vị nào: **SOTRANS Logistics (STL)**, **Vietranstimex (VTX)**, **Sowatco (SWC)**, hay **Toàn tập đoàn (ALL)**?',
    };
  }

  return {
    isBIQuery: true,
    intent: 'BI_QUERY',
    kpiCodes: matchedKPIs,
    companyId: detectedCompany || (role === 'HR' ? user?.company_id : null),
    startDate: dateRange?.startDate || null,
    endDate: dateRange?.endDate || null,
    dateLabel: dateRange?.label || null,
    invalidDateRange: dateRange?.invalid === true,
    clarificationRequired: false,
    clarificationQuestion: null,
  };
}

// ============================================================================
// EXECUTE REPORTING ENGINE (BACKEND-TO-ENGINE BRIDGE WITH RBAC)
// ============================================================================

async function executeBIReporting(biIntent, user) {
  if (biIntent.invalidDateRange) return { success: false, code: 'INVALID_DATE_RANGE', error: 'Khoảng ngày không hợp lệ. Vui lòng dùng ngày/tháng có thực.' };
  // 1. Check Feature Flag
  if (process.env.BI_REPORTING_ENABLED !== 'true') {
    return {
      success: false,
      error: 'Dịch vụ BI Reporting hiện đang tạm thời bị vô hiệu hóa (BI_REPORTING_ENABLED is false).',
      code: 'SERVICE_DISABLED',
    };
  }

  // 2. Check Authentication
  if (!user || !user.user_id) {
    return {
      success: false,
      error: 'Bạn cần đăng nhập bằng tài khoản Quản trị viên (ADMIN) hoặc Nhân sự (HR) để truy cập báo cáo BI.',
      code: 'UNAUTHORIZED',
    };
  }

  // 3. Check Account Status
  const status = user.status ? String(user.status).trim().toUpperCase() : 'ACTIVE';
  if (status === 'INACTIVE' || status === 'LOCKED') {
    return {
      success: false,
      error: 'Tài khoản của bạn đã bị vô hiệu hóa hoặc bị khóa. Không thể truy xuất dữ liệu BI.',
      code: 'ACCOUNT_INACTIVE',
    };
  }

  // 4. Check Role
  const role = user.role ? String(user.role).trim().toUpperCase() : '';
  if (role !== 'ADMIN' && role !== 'HR') {
    return {
      success: false,
      error: `Tài khoản vai trò ${user.role} không có quyền truy cập dữ liệu báo cáo BI. Chức năng này chỉ dành cho Quản trị viên (ADMIN) và Cán bộ Nhân sự (HR).`,
      code: 'FORBIDDEN_ROLE',
    };
  }

  // 5. Enforce Tenant Scope
  let effectiveCompany = null;
  let tenantNotice = null;

  if (role === 'ADMIN') {
    if (!biIntent.companyId || !ALLOWED_ADMIN_TENANTS.includes(biIntent.companyId)) {
      return {
        success: false,
        error: 'Vui lòng xác định rõ công ty cần báo cáo: STL, VTX, SWC hoặc ALL.',
        code: 'MISSING_ADMIN_TENANT',
      };
    }
    effectiveCompany = biIntent.companyId;
  } else if (role === 'HR') {
    const hrComp = user.company_id ? String(user.company_id).trim().toUpperCase() : null;
    if (!hrComp || !VALID_HR_TENANTS.includes(hrComp)) {
      return {
        success: false,
        error: 'Tài khoản HR chưa được gán company_id hợp lệ.',
        code: 'INVALID_HR_TENANT',
      };
    }
    effectiveCompany = hrComp;

    if (biIntent.companyId && biIntent.companyId !== hrComp) {
      tenantNotice = `Lưu ý: Tài khoản của bạn thuộc đơn vị ${hrComp}. Hệ thống cung cấp báo cáo theo đúng phạm vi thẩm quyền được cấp.`;
    }
  }

  // 6. Compute KPIs sequentially
  const options = {
    companyId: effectiveCompany,
    startDate: biIntent.startDate || null,
    endDate: biIntent.endDate || null,
  };

  const results = [];
  for (const kpiCode of biIntent.kpiCodes) {
    try {
      const res = await analyticsEngine.computeKPI(kpiCode, options, user);
      results.push(res);
    } catch (err) {
      console.warn(`[BI Helper] Error computing KPI ${kpiCode}:`, err.message);
      results.push({
        kpi: kpiCode,
        status: 'DATA_UNAVAILABLE',
        reason: err.message,
        scope: { company_id: effectiveCompany, branch: null },
        period: { start: options.startDate, end_exclusive: options.endDate, timezone: 'Asia/Ho_Chi_Minh' },
        data: null,
        warnings: [`Lỗi truy vấn: ${err.message}`],
        metadata: { source_tables: [], generated_at: new Date().toISOString() },
      });
    }
  }

  return {
    success: true,
    results,
    companyId: effectiveCompany,
    periodLabel: biIntent.dateLabel || (biIntent.startDate && biIntent.endDate ? `${biIntent.startDate} đến ${biIntent.endDate}` : 'Toàn thời gian'),
    tenantNotice,
  };
}

// ============================================================================
// FORMAT BI REPORT MARKDOWN & STRUCTURED VISUAL DASHBOARD
// ============================================================================

function sanitizeText(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeDataObj(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return sanitizeText(val);
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) return val.map(sanitizeDataObj);
  if (typeof val === 'object') {
    const sanitized = {};
    for (const [k, v] of Object.entries(val)) {
      sanitized[k] = sanitizeDataObj(v);
    }
    return sanitized;
  }
  return val;
}

function formatNumberVN(val) {
  if (val === null || val === undefined) return 'N/A';
  if (typeof val === 'number') {
    return val.toLocaleString('vi-VN');
  }
  return sanitizeText(String(val));
}

function formatBIReportMarkdown(biExecutionResult, userContext = null) {
  const { results, companyId, periodLabel, tenantNotice } = biExecutionResult;

  const companyLabels = {
    STL: 'SOTRANS Logistics (STL)',
    VTX: 'Vietranstimex (VTX)',
    SWC: 'Sowatco (SWC)',
    ALL: 'Toàn Tập Đoàn SOTRANS (ALL)',
  };

  const compTitle = sanitizeText(companyLabels[companyId] || companyId);
  const cleanPeriod = sanitizeText(periodLabel || 'Toàn thời gian');
  const cleanNotice = tenantNotice ? sanitizeText(tenantNotice) : null;
  const nowVN = getNowVN().toLocaleString('vi-VN', { hour12: false });

  let md = '';

  // 1. Header Banner
  md += `## 📊 Báo Cáo Số Liệu Quản Trị — ${compTitle}\n\n`;
  md += `> 🏢 **Phạm vi:** \`${compTitle}\` &nbsp;|&nbsp; 📅 **Kỳ báo cáo:** \`${cleanPeriod}\` &nbsp;|&nbsp; 🕒 **Xuất lúc:** \`${nowVN}\`\n\n`;

  if (cleanNotice) {
    md += `> ℹ️ *${cleanNotice}*\n\n`;
  }

  // 2. Summary KPI Metric Grid
  md += `### 📌 Chỉ Số Nghiệp Vụ Trọng Yếu\n\n`;
  md += `| Chỉ Số (KPI) | Trạng Thái | Giá Trị Thực Tế | Ghi Chú Kỹ Thuật |\n`;
  md += `|---|:---:|:---:|---|\n`;

  for (const item of results) {
    const kpiName = sanitizeText(analyticsEngine.KPI_CATALOG[item.kpi]?.name || item.kpi);
    const statusPill =
      item.status === 'AVAILABLE'
        ? '🟢 Khả dụng'
        : item.status === 'PARTIALLY_AVAILABLE'
        ? '🟡 Một phần'
        : '⚪ Chưa có dữ liệu';

    let displayValue = '—';
    let technicalNote = sanitizeText(item.warnings?.join('; ') || 'Hoàn tất trích xuất');

    if (item.status === 'DATA_UNAVAILABLE') {
      displayValue = '*Không khả dụng*';
      technicalNote = sanitizeText(item.reason || 'Pipeline chưa hỗ trợ lưu trữ số liệu');
    } else if (item.data) {
      switch (item.kpi) {
        case 'DOC_TOTAL':
          displayValue = `**${formatNumberVN(item.data.total_documents)}** văn bản (Active: ${formatNumberVN(item.data.active_count)})`;
          break;
        case 'INTAKE_UPLOADS':
          displayValue = `**${formatNumberVN(item.data.total_batches)}** lô (${formatNumberVN(item.data.total_files_uploaded)} tệp)`;
          break;
        case 'INTAKE_SUCCESS':
          displayValue = `**${item.data.conversion_rate_all_status}%** (${item.data.converted_batches_all_status}/${item.data.total_batches} lô có Staging)`;
          technicalNote = `Trạng thái: ${item.data.completed_batches} hoàn tất, ${item.data.ocr_completed_batches} xong OCR; Staging cùng cty: ${item.data.same_company_staging_records}, khác cty: ${item.data.cross_company_staging_records}`;
          break;
        case 'DUPLICATE_RATE':
          displayValue = `**${item.data.suspected_duplicate_rate}%** (${item.data.suspected_cnt}/${item.data.total_staged} hồ sơ)`;
          break;
        case 'APPROVAL_QUEUE':
          displayValue = `Tồn đọng: **${formatNumberVN(item.data.current_pending_queue)}** | Đã duyệt: **${formatNumberVN(item.data.approval_activity)}** | Từ chối: **${formatNumberVN(item.data.rejection_activity)}**`;
          technicalNote = `Duyệt & từ chối tính theo reviewed_at trong kỳ báo cáo`;
          break;
        case 'OCR_QUALITY':
          displayValue = item.data.avg_doc_parse_quality !== null ? `**${item.data.avg_doc_parse_quality}%**` : 'Chưa có mẫu';
          technicalNote = `Đo lường: ${item.data.measured_docs}/${item.data.total_docs} văn bản (thiếu: ${item.data.missing_docs}). OCR hồ sơ nhân sự: DATA_UNAVAILABLE`;
          break;
        case 'DATA_INTEGRITY':
          displayValue = `Thiếu trường: **${item.data.missing_fields_rate}%** (${item.data.missing_fields_count}/${item.data.total_profiles})`;
          break;
        case 'ACTIVE_USERS':
          displayValue = `**${formatNumberVN(item.data.total_active_users)}** tài khoản (${formatNumberVN(item.data.total_actions)} phiên)`;
          break;
        case 'RAG_ANSWERABLE':
          displayValue = `**${item.data.answerability_rate}%** (${item.data.answerable_count}/${item.data.eligible_rag_queries} câu)`;
          technicalNote = `Độ tương đồng TB: ${item.data.avg_vector_similarity || '—'} (trên ${item.data.similarity_sample_count} mẫu). Độ trễ phản hồi (latency): DATA_UNAVAILABLE`;
          break;
        default:
          if (Array.isArray(item.data.items)) {
            displayValue = `**${formatNumberVN(item.data.total_documents || item.data.total_batches || item.data.items.length)}** bản ghi`;
          } else {
            displayValue = sanitizeText(JSON.stringify(item.data));
          }
      }
    }

    md += `| **${kpiName}** (\`${item.kpi}\`) | ${statusPill} | ${displayValue} | ${technicalNote} |\n`;
  }

  md += `\n`;

  // 3. Detailed Data Breakdowns (for list/table KPIs)
  for (const item of results) {
    if (item.data && Array.isArray(item.data.items) && item.data.items.length > 0) {
      const kpiName = sanitizeText(analyticsEngine.KPI_CATALOG[item.kpi]?.name || item.kpi);
      md += `#### 📋 Chi Tiết: ${kpiName}\n\n`;

      if (item.kpi === 'DOC_STATUS') {
        md += `| Trạng Thái Văn Bản | Số Lượng | Tỷ Lệ (%) |\n|---|:---:|:---:|\n`;
        for (const row of item.data.items) {
          md += `| \`${sanitizeText(row.document_status)}\` | ${formatNumberVN(row.total_count)} | ${row.ratio_percent}% |\n`;
        }
      } else if (item.kpi === 'DOC_BY_TYPE') {
        md += `| Loại Hình Văn Bản | Chuyên Mục | Số Lượng |\n|---|---|:---:|\n`;
        for (const row of item.data.items.slice(0, 10)) {
          md += `| ${sanitizeText(row.doc_type)} | ${sanitizeText(row.category)} | ${formatNumberVN(row.doc_count)} |\n`;
        }
      } else if (item.kpi === 'INTAKE_BY_USER') {
        md += `| Cán Bộ Tiếp Nhận | Đơn Vị | Số Lô | Tổng Số Tệp |\n|---|:---:|:---:|:---:|\n`;
        for (const row of item.data.items) {
          md += `| **${sanitizeText(row.username)}** | \`${sanitizeText(row.company_id)}\` | ${formatNumberVN(row.total_batches)} | ${formatNumberVN(row.total_files)} |\n`;
        }
      } else if (item.kpi === 'INTAKE_TRENDS') {
        md += `| Chu Kỳ (Tháng) | Số Lô Tiếp Nhận | Số Tệp Hồ Sơ |\n|:---:|:---:|:---:|\n`;
        for (const row of item.data.items) {
          md += `| **${sanitizeText(row.period)}** | ${formatNumberVN(row.batch_count)} | ${formatNumberVN(row.files_count)} |\n`;
        }
      } else if (item.kpi === 'DOC_BY_EFFECTIVE_DATE') {
        md += `| Tháng Hiệu Lực | Số Văn Bản Có Hiệu Lực |\n|:---:|:---:|\n`;
        for (const row of item.data.items) {
          md += `| **${sanitizeText(row.period)}** | ${formatNumberVN(row.doc_count)} |\n`;
        }
      }
      md += `\n`;
    }
  }

  // 4. Embedded Structured JSON Block for Rich Frontend Widget Rendering (XSS-safe)
  const reportPayload = {
    title: `Báo Cáo Quản Trị ${compTitle}`,
    company_id: companyId,
    period: cleanPeriod,
    generated_at: nowVN,
    results: results.map(r => ({
      kpi: r.kpi,
      name: sanitizeText(analyticsEngine.KPI_CATALOG[r.kpi]?.name || r.kpi),
      classification: analyticsEngine.KPI_CATALOG[r.kpi]?.classification || 'READY',
      status: r.status,
      data: sanitizeDataObj(r.data),
      reason: r.reason ? sanitizeText(r.reason) : null,
      warnings: (r.warnings || []).map(sanitizeText),
    })),
  };

  md += `\`\`\`bi-report\n${JSON.stringify(reportPayload, null, 2)}\n\`\`\`\n\n`;

  // 4b. Embedded Standardized Dashboard Payload Contract v2.0 (Self-describing JSON for Interactive Renderer)
  // Transport Security: Neutralizes --> and <!-- inside JSON payload to guarantee HTML comment boundary integrity
  try {
    const dashboardPayloadV2 = formatBIDashboardPayload(biExecutionResult, userContext);
    const jsonStr = JSON.stringify(dashboardPayloadV2);
    const safeJson = jsonStr.replace(/-->/g, '--\\u003e').replace(/<!--/g, '\\u003c!--');
    md += `<!-- bi-dashboard-v2: ${safeJson} -->\n\n`;
  } catch (err) {
    console.warn('[BI Helper] Warning: Failed to generate Dashboard v2 payload:', err.message);
  }

  // 5. Report Footer
  const sourceTables = Array.from(
    new Set(results.flatMap(r => r.metadata?.source_tables || []))
  ).map(sanitizeText);

  md += `---\n`;
  md += `*Nguồn dữ liệu CSDL:* \`${sourceTables.join(', ') || 'PostgreSQL SOTRANS Hub'}\`  \n`;
  md += `*Bảo mật & Phân quyền:* Dữ liệu được xác thực tự động bởi Analytics Engine. Read-Only Transaction enforce.`;

  return md;
}

/**
 * Format Internal System BI Results into Dashboard Payload Contract v2.0
 * Conforming to P1.0 self-describing JSON specification
 * @param {Object} biExecutionResult - Output from executeBIReporting
 * @param {Object} userContext - Authenticated user context
 * @returns {Object} Validated Dashboard Payload v2.0
 */
function formatBIDashboardPayload(biExecutionResult, userContext = null) {
  const { results, companyId, periodLabel, tenantNotice } = biExecutionResult;

  const companyLabels = {
    STL: 'SOTRANS Logistics (STL)',
    VTX: 'Vietranstimex (VTX)',
    SWC: 'Sowatco (SWC)',
    ALL: 'Toàn Tập Đoàn SOTRANS (ALL)',
  };

  const compTitle = companyLabels[companyId] || companyId || 'SOTRANS Hub';
  const cleanPeriod = periodLabel || 'Toàn thời gian';
  const dashboardId = `dash_sys_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const kpiStrip = [];
  const visualizations = [];
  const dataTables = [];
  const dataStore = {};

  for (let i = 0; i < (results || []).length; i++) {
    const item = results[i];
    const kpiMeta = analyticsEngine.KPI_CATALOG[item.kpi] || {};
    const kpiCode = item.kpi;
    const kpiId = `kpi_${kpiCode.toLowerCase()}`;
    const status = item.status === 'PARTIALLY_AVAILABLE' ? 'CONDITIONAL' : item.status;

    let primaryValue = null;
    let format = 'NUMBER';
    let unit = '';
    let subtext = item.reason ? sanitizeText(item.reason) : (item.warnings && item.warnings.length > 0 ? item.warnings.map(sanitizeText).join('; ') : 'Dữ liệu được xác thực tự động bởi Analytics Engine.');

    if (status === 'AVAILABLE' || status === 'CONDITIONAL') {
      const d = item.data || {};
      switch (kpiCode) {
        case 'DOC_TOTAL':
          primaryValue = typeof d.total_documents === 'number' ? d.total_documents : 0;
          unit = 'văn bản';
          format = 'NUMBER';
          break;
        case 'DOC_BY_EFFECTIVE_DATE':
          primaryValue = Array.isArray(d.items) ? d.items.reduce((s, r) => s + (Number(r.doc_count) || 0), 0) : (typeof d.total_documents === 'number' ? d.total_documents : 0);
          unit = 'văn bản';
          format = 'NUMBER';
          break;
        case 'DOC_BY_TYPE':
          primaryValue = Array.isArray(d.items) ? d.items.reduce((s, r) => s + (Number(r.doc_count) || 0), 0) : (typeof d.total_documents === 'number' ? d.total_documents : 0);
          unit = 'văn bản';
          format = 'NUMBER';
          break;
        case 'DOC_STATUS':
          primaryValue = Array.isArray(d.items) ? d.items.reduce((s, r) => s + (Number(r.total_count) || 0), 0) : (typeof d.total_documents === 'number' ? d.total_documents : 0);
          unit = 'văn bản';
          format = 'NUMBER';
          break;
        case 'INTAKE_UPLOADS':
          primaryValue = typeof d.total_batches === 'number' ? d.total_batches : 0;
          unit = 'lô';
          format = 'NUMBER';
          break;
        case 'INTAKE_BY_USER':
          primaryValue = Array.isArray(d.items) ? d.items.reduce((s, r) => s + (Number(r.total_files) || 0), 0) : (typeof d.total_files === 'number' ? d.total_files : 0);
          unit = 'tệp';
          format = 'NUMBER';
          break;
        case 'INTAKE_TRENDS':
          primaryValue = Array.isArray(d.items) ? d.items.reduce((s, r) => s + (Number(r.files_count) || 0), 0) : (typeof d.total_files === 'number' ? d.total_files : 0);
          unit = 'tệp';
          format = 'NUMBER';
          break;
        case 'INTAKE_SUCCESS':
          primaryValue = typeof d.conversion_rate_all_status === 'number' ? d.conversion_rate_all_status : (typeof d.conversion_rate_completed_only === 'number' ? d.conversion_rate_completed_only : 0);
          format = 'PERCENTAGE';
          unit = '%';
          break;
        case 'DUPLICATE_RATE':
          primaryValue = typeof d.suspected_duplicate_rate === 'number' ? d.suspected_duplicate_rate : (typeof d.duplicate_rate_percent === 'number' ? d.duplicate_rate_percent : 0);
          format = 'PERCENTAGE';
          unit = '%';
          break;
        case 'APPROVAL_QUEUE':
          primaryValue = typeof d.current_pending_queue === 'number' ? d.current_pending_queue : 0;
          unit = 'hồ sơ';
          format = 'NUMBER';
          break;
        case 'OCR_QUALITY':
          primaryValue = (d.avg_doc_parse_quality !== null && d.avg_doc_parse_quality !== undefined) ? Number(d.avg_doc_parse_quality) : null;
          format = 'PERCENTAGE';
          unit = '%';
          if (primaryValue === null) {
            subtext = 'Chưa có mẫu đo lường OCR';
          }
          break;
        case 'DATA_INTEGRITY':
          primaryValue = typeof d.missing_fields_rate === 'number' ? d.missing_fields_rate : (typeof d.missing_fields_count === 'number' ? d.missing_fields_count : 0);
          format = typeof d.missing_fields_rate === 'number' ? 'PERCENTAGE' : 'NUMBER';
          unit = typeof d.missing_fields_rate === 'number' ? '%' : 'hồ sơ';
          break;
        case 'ACTIVE_USERS':
          primaryValue = typeof d.total_active_users === 'number' ? d.total_active_users : (typeof d.active_users === 'number' ? d.active_users : (Array.isArray(d.items) ? d.items.length : 0));
          unit = 'người';
          format = 'NUMBER';
          break;
        case 'RAG_ANSWERABLE':
          primaryValue = typeof d.answerability_rate === 'number' ? d.answerability_rate : 0;
          format = 'PERCENTAGE';
          unit = '%';
          break;
        default:
          if (typeof d.value === 'number') {
            primaryValue = d.value;
          } else if (typeof d.total === 'number') {
            primaryValue = d.total;
          } else if (Array.isArray(d.items)) {
            primaryValue = d.items.length;
          } else {
            primaryValue = 0;
          }
      }
    } else {
      // BLOCKED or DATA_UNAVAILABLE: strictly null primary_value, mandatory subtext
      primaryValue = null;
      if (!subtext || subtext.includes('xác thực tự động')) {
        subtext = kpiMeta.blocked_reason || item.reason || 'Chỉ số hiện chưa hỗ trợ trong kiến trúc dữ liệu hiện tại.';
      }
    }

    kpiStrip.push({
      id: kpiId,
      kpi_code: kpiCode,
      title: sanitizeText(kpiMeta.name || kpiCode),
      primary_value: primaryValue,
      format,
      unit,
      status,
      subtext,
    });

    // Check if this KPI has items array for data_store, visualizations, and data_tables
    if (item.data && Array.isArray(item.data.items) && item.data.items.length > 0) {
      const dataRef = `kpi_${kpiCode.toLowerCase()}_data`;
      dataStore[dataRef] = item.data.items.map(sanitizeDataObj);

      if (kpiCode === 'DOC_STATUS') {
        visualizations.push({
          id: 'viz_doc_status',
          title: 'Cơ Cấu Văn Bản Theo Trạng Thái',
          chart_type: 'PIE',
          data_ref: dataRef,
          mapping: { category: 'document_status', value: 'total_count' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          grid_col_span: 6,
        });
        dataTables.push({
          id: 'tbl_doc_status',
          title: 'Chi Tiết Trạng Thái Văn Bản',
          data_ref: dataRef,
          columns: [
            { key: 'document_status', label: 'Trạng Thái', type: 'string' },
            { key: 'total_count', label: 'Số Lượng', type: 'number', format: 'NUMBER' },
            { key: 'ratio_percent', label: 'Tỷ Lệ (%)', type: 'number', format: 'PERCENTAGE' },
          ],
          pagination: { page_size: 10, total_rows: item.data.items.length },
        });
      } else if (kpiCode === 'DOC_BY_TYPE') {
        visualizations.push({
          id: 'viz_doc_by_type',
          title: 'Cơ Cấu Văn Bản Theo Loại Hình',
          chart_type: 'BAR',
          data_ref: dataRef,
          mapping: { category: 'doc_type', value: 'doc_count' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          grid_col_span: 6,
        });
        dataTables.push({
          id: 'tbl_doc_by_type',
          title: 'Chi Tiết Loại Hình & Chuyên Mục Văn Bản',
          data_ref: dataRef,
          columns: [
            { key: 'doc_type', label: 'Loại Hình', type: 'string' },
            { key: 'category', label: 'Chuyên Mục', type: 'string' },
            { key: 'doc_count', label: 'Số Lượng', type: 'number', format: 'NUMBER' },
          ],
          pagination: { page_size: 10, total_rows: item.data.items.length },
        });
      } else if (kpiCode === 'INTAKE_TRENDS') {
        visualizations.push({
          id: 'viz_intake_trends',
          title: 'Xu Hướng Tiếp Nhận Hồ Sơ Theo Tháng',
          chart_type: 'LINE',
          data_ref: dataRef,
          mapping: { x: 'period', y: 'files_count' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          grid_col_span: 12,
        });
        dataTables.push({
          id: 'tbl_intake_trends',
          title: 'Chi Tiết Tiếp Nhận Theo Chu Kỳ',
          data_ref: dataRef,
          columns: [
            { key: 'period', label: 'Chu Kỳ', type: 'string' },
            { key: 'batch_count', label: 'Số Lô', type: 'number', format: 'NUMBER' },
            { key: 'files_count', label: 'Số Tệp', type: 'number', format: 'NUMBER' },
          ],
          pagination: { page_size: 10, total_rows: item.data.items.length },
        });
      } else if (kpiCode === 'DOC_BY_EFFECTIVE_DATE') {
        visualizations.push({
          id: 'viz_doc_effective_date',
          title: 'Số Lượng Văn Bản Có Hiệu Lực Theo Tháng',
          chart_type: 'BAR',
          data_ref: dataRef,
          mapping: { category: 'period', value: 'doc_count' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          grid_col_span: 12,
        });
        dataTables.push({
          id: 'tbl_doc_effective_date',
          title: 'Chi Tiết Văn Bản Theo Ngày Hiệu Lực',
          data_ref: dataRef,
          columns: [
            { key: 'period', label: 'Tháng', type: 'string' },
            { key: 'doc_count', label: 'Số Lượng', type: 'number', format: 'NUMBER' },
          ],
          pagination: { page_size: 10, total_rows: item.data.items.length },
        });
      } else if (kpiCode === 'INTAKE_BY_USER') {
        visualizations.push({
          id: 'viz_intake_by_user',
          title: 'Số Lượng Hồ Sơ Theo Cán Bộ Tiếp Nhận',
          chart_type: 'BAR',
          data_ref: dataRef,
          mapping: { category: 'username', value: 'total_files' },
          interactions: { selectable: true, filterable: true, drilldown: false },
          grid_col_span: 12,
        });
        dataTables.push({
          id: 'tbl_intake_by_user',
          title: 'Chi Tiết Tiếp Nhận Theo Cán Bộ',
          data_ref: dataRef,
          columns: [
            { key: 'username', label: 'Cán Bộ', type: 'string' },
            { key: 'company_id', label: 'Đơn Vị', type: 'string' },
            { key: 'total_batches', label: 'Số Lô', type: 'number', format: 'NUMBER' },
            { key: 'total_files', label: 'Số Tệp', type: 'number', format: 'NUMBER' },
          ],
          pagination: { page_size: 10, total_rows: item.data.items.length },
        });
      }
    }
  }

  const payload = {
    version: '2.0',
    dashboard_id: dashboardId,
    source_type: 'INTERNAL_SYSTEM',
    title: `Báo Cáo Quản Trị ${compTitle}`,
    subtitle: `Kỳ báo cáo: ${cleanPeriod}`,
    generated_at: new Date().toISOString(),
    provenance: {
      source_system: 'SOTRANS Hub',
      generated_by: 'Analytics Engine',
      tenant_scope: companyId,
    },
    filters: {
      current_state: {
        company_id: companyId,
        period: cleanPeriod,
      },
      supported_dimensions: ['company_id', 'department', 'status', 'period'],
      slicers: [
        {
          id: 'slicer_company',
          dimension: 'company_id',
          label: 'Đơn vị / Công ty',
          selected: companyId,
          options: ['STL', 'VTX', 'SWC', 'ALL'],
        },
      ],
    },
    kpi_strip: kpiStrip,
    visualizations,
    data_tables: dataTables,
    data_store: dataStore,
  };

  // Validate before returning
  assertValidDashboardPayload(payload, userContext);
  return signReport(payload, userContext);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  detectBIIntent,
  resolveDateRangeVN,
  detectCompanyFromText,
  executeBIReporting,
  formatBIReportMarkdown,
  formatBIDashboardPayload,
};
