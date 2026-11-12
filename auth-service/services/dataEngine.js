const XLSX = require('xlsx');

/**
 * Data Engine for Personal AI Agents - SOTRANS Hub
 * Cung cấp khả năng bóc tách, chuẩn hóa, phân tích thống kê và tính toán xác định trên tệp Excel/CSV.
 * Nguyên tắc:
 * 1. Không cắt cụt dữ liệu ngầm.
 * 2. Không coi ô trống hợp lệ là dòng lỗi.
 * 3. Không tự ý xóa bỏ dữ liệu trùng lặp khi chưa có chỉ định.
 * 4. Cảnh báo rõ ràng khi độ tin cậy Header thấp hoặc công thức thiếu cache.
 * 5. Chuẩn hóa tên cột (loại bỏ khoảng trắng thừa, 'ĐIỂM  ĐẾN' -> 'ĐIỂM ĐẾN').
 * 6. Tuyệt đối không parse nhầm văn bản chứa chữ, mã REF, tên vendor hoặc ngày tháng thành số.
 */

const EXCEL_ERROR_VALUES = new Set([
  '#N/A', '#DIV/0!', '#REF!', '#VALUE!', '#NAME?', '#NUM!', '#NULL!'
]);

/**
 * Chuẩn hóa tiếng Việt bỏ dấu để đối soát tìm kiếm mờ (fuzzy)
 */
function removeAccents(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Danh mục đồng nghĩa và biến thể địa danh logistics
 */
const ALIAS_GROUPS = [
  ['di an', 'di an, binh duong', 'di an city', 'di an city, binh duong province', 'tp di an'],
  ['alley 64', 'hem 64', 'hem 64 truong van vinh', 'alley 64, truong van vinh', 'truong van vinh', '64 truong van vinh', 'alley 64, truong van vinh street', 'alley 64, truong van vinh street, tan binh ward, di an city, binh duong province'],
  ['tan binh', 'kcn tan binh', 'kcn tan binh, hcm', 'khu cong nghiep tan binh'],
  ['cat lai', 'cang cat lai', 'icd cat lai', 'kho sotrans cat lai', 'cl'],
  ['hai phong', 'cang hai phong', 'hph', 'lach huyen'],
  ['dong nai', 'kho sotrans td - dong nai', 'bien hoa', 'kcn bien hoa'],
  ['quang ngai', 'tp quang ngai', 'kcn tinh phong'],
  ['bac giang', 'dinh tram', 'dinh tram industrial park, viet yen, bac giang, vietnam'],
  ['nam dinh', 'cang nam dinh', 'tp nam dinh', 'tinh nam dinh'],
  ['wha', 'wha industrial zone 1', 'wha industrial zone 1- nghe an', 'wha nghe an', 'kcn wha', 'lo b2, khu cong nghiep, wha industrial zone 1- nghe an, xa than linh, tinh nghe an, viet nam']
];

function cleanRouteEndpoint(str) {
  if (!str) return '';
  return removeAccents(str)
    .replace(/^(?:chi\s+phi(?:\s+cho)?(?:\s+\d+)?(?:\s+chuyen)?(?:\s+van\s+chuyen)?|gia(?:\s+cuoc)?(?:\s+cho)?(?:\s+\d+)?(?:\s+chuyen)?|bao\s+gia(?:\s+cho)?|cuoc\s+phi|tra\s+cuu|tim(?:\s+kiem)?|cho\s+toi\s+biet\s+gia|xem\s+gia|tuyen(?:\s+duong)?|chang)\s+/gi, '')
    .replace(/^(?:tu|from|o|tai)\s+/gi, '')
    .replace(/\b(?:het\s+bao\s+nhieu|la\s+bao\s+nhieu|bao\s+nhieu|gia\s+bao\s+nhieu|the\s+nao|nhu\s+the\s+nao|bao\s+gia|hien\s+tai|\?|\.|\!)+.*$/gi, '')
    .replace(/\s*(?:cont\s*20['"]?|cont\s*40['"]?|20\s*feet|40\s*feet|\(di\s*don\)|\(di\s*ghep\)|di\s*don|di\s*ghep)\s*/gi, ' ')
    .trim();
}

/**
 * So khớp địa danh giữa bản ghi dữ liệu (rowLoc) và yêu cầu người dùng (targetLoc)
 * Ngăn chặn triệt để lỗi Containment Inversion: địa danh chung (quận/tỉnh/thành phố) không được
 * tự ý khớp sai với địa chỉ chi tiết cụ thể (hẻm, đường, số nhà, KCN, kho, cảng).
 */
function matchEndpoint(rowLoc, targetLoc) {
  if (!rowLoc || !targetLoc) return false;
  const r = rowLoc.toLowerCase().trim();
  const t = targetLoc.toLowerCase().trim();
  if (!r || !t) return false;

  // 1. Khớp chính xác hoàn toàn
  if (r === t) return true;

  // 2. Dòng dữ liệu chứa đích đến truy vấn (ví dụ: dòng ghi "Alley 64, Truong Van Vinh... Di An", truy vấn tìm "Di An")
  if (r.includes(t)) return true;

  // 3. Truy vấn chứa dòng dữ liệu (ví dụ: truy vấn tìm "KCN Tan Binh, HCM", dòng ghi "KCN Tan Binh")
  // BẢO VỆ CHỐNG LỖI CỤ THỂ HOÁ NGƯỢC (Specificity Guard):
  // Nếu truy vấn có chỉ định địa chỉ chi tiết (hẻm, alley, đường, street, số nhà, KCN, v.v.)
  // mà dòng dữ liệu chỉ ghi chung chung cấp quận/huyện/tỉnh (ví dụ: "Dĩ An, Bình Dương"),
  // thì KHÔNG ĐƯỢC coi là khớp báo giá cụ thể!
  if (t.includes(r)) {
    const specificPattern = /\b(?:alley|hem|ngõ|ngo|ngach|street|pho|lo\s*[a-z0-9]|kcn|cang|kho|nha\s*may|factory)\b|(?<!binh\s+|hai\s+)\bduong\b/i;
    const targetHasSpecific = specificPattern.test(t);
    const rowHasSpecific = specificPattern.test(r);
    if (targetHasSpecific && !rowHasSpecific) {
      return false;
    }

    const tWords = t.split(/[\s,.-]+/).filter(w => w.length >= 4 && !['vietnam', 'viet', 'nam', 'tinh', 'thanh', 'quan', 'huyen', 'phuong', 'binh', 'duong'].includes(w));
    const missingWords = tWords.filter(w => !r.includes(w));
    if (missingWords.length >= 2 && !rowHasSpecific) {
      return false;
    }

    return true;
  }

  // 4. Khớp qua danh mục đồng nghĩa / alias
  return matchLocationAliases(r, t);
}

function matchLocationAliases(textNorm, targetNorm) {
  if (!textNorm || !targetNorm) return false;
  for (const group of ALIAS_GROUPS) {
    const hasTarget = group.some(alias => targetNorm.includes(alias) || alias.includes(targetNorm));
    if (hasTarget) {
      const hasText = group.some(alias => textNorm.includes(alias));
      if (hasText) return true;
    }
  }
  return false;
}

/**
 * Chuyển đổi chuỗi số Việt Nam / Quốc tế thành số thực nghiêm ngặt
 * TUYỆT ĐỐI KHÔNG ép kiểu nếu chuỗi chứa chữ cái (ví dụ: '42_LAU_LCL', '3S'), ngày tháng ('13/10/2026'),
 * đơn vị cước ('900.000/chuyến', '900.000/xe') hoặc phần trăm ('15% phụ phí').
 */
function parseVNNumber(val) {
  if (typeof val === 'number') return isFinite(val) ? val : null;
  if (!val || typeof val !== 'string') return null;
  
  let s = val.trim();
  if (!s) return null;

  // Nếu chuỗi chứa chữ cái (a-z, A-Z), gạch dưới (_), gạch chéo (/), hoặc phần trăm (%) -> ĐÂY LÀ VĂN BẢN!
  if (/[a-zA-Z_\/%]/.test(s)) {
    return null;
  }

  // Xử lý số âm dạng kế toán: (1.500.000) hoặc (1,500,000)
  let isNegative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    isNegative = true;
    s = s.slice(1, -1).trim();
  } else if (s.startsWith('-')) {
    isNegative = true;
    s = s.slice(1).trim();
  }

  // Bỏ ký hiệu tiền tệ hoặc khoảng trắng ở đầu hoặc cuối
  s = s.replace(/^(VND|VNĐ|USD|\$|₫)\s*/i, '').replace(/\s*(VND|VNĐ|USD|\$|₫)$/i, '').trim();

  // Kiểm tra định dạng số nghiêm ngặt (STRICT NUMERIC MATCHING):
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    // Định dạng VN: 1.234.567 hoặc 1.234.567,89
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    // Định dạng US: 1,234,567 hoặc 1,234,567.89
    s = s.replace(/,/g, '');
  } else if (/^\d+(,\d+)$/.test(s)) {
    // Thập phân dấu phẩy: 1234,56
    s = s.replace(',', '.');
  } else if (!/^\d+(\.\d+)?$/.test(s)) {
    // Nếu không khớp hoàn toàn bất kỳ mẫu số nào, KHÔNG PARSE
    return null;
  }

  const num = parseFloat(s);
  if (isNaN(num) || !isFinite(num)) return null;
  return isNegative ? -num : num;
}

/**
 * Tự động phát hiện dòng tiêu đề (Header row)
 */
function detectHeaderRow(rawRows) {
  const maxScan = Math.min(10, rawRows.length);
  let bestRowIndex = 0;
  let bestScore = -1;

  for (let i = 0; i < maxScan; i++) {
    const row = rawRows[i] || [];
    if (!row.length) continue;

    let stringCount = 0;
    let nonNullCount = 0;
    const seen = new Set();
    let duplicates = 0;

    for (const cell of row) {
      if (cell !== undefined && cell !== null && String(cell).trim() !== '') {
        nonNullCount++;
        const str = String(cell).trim();
        if (typeof cell === 'string' && isNaN(Number(str))) {
          stringCount++;
        }
        if (seen.has(str.toLowerCase())) {
          duplicates++;
        }
        seen.add(str.toLowerCase());
      }
    }

    if (nonNullCount === 0) continue;

    // Score based on ratio of text, non-null cells, and uniqueness
    const stringRatio = stringCount / nonNullCount;
    const uniquenessRatio = (nonNullCount - duplicates) / nonNullCount;
    const score = (stringRatio * 0.6) + (uniquenessRatio * 0.4);

    if (score > bestScore) {
      bestScore = score;
      bestRowIndex = i;
    }
  }

  const confidence = bestScore > 0 ? parseFloat(bestScore.toFixed(2)) : 0;
  return {
    headerIndex: bestRowIndex,
    confidence,
    isLowConfidence: confidence < 0.80
  };
}

/**
 * Trích xuất giá trị ngày tháng để sắp xếp giảm dần
 */
function extractDateSortValue(rowObj = {}) {
  for (const [key, val] of Object.entries(rowObj)) {
    if (/ngày|date|time/i.test(key) && val) {
      const s = String(val).trim();
      // Khớp dd/mm/yyyy
      const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
      if (dmy) {
        return new Date(parseInt(dmy[3], 10), parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10)).getTime();
      }
      // Khớp yyyy-mm-dd
      const ymd = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
      if (ymd) {
        return new Date(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10)).getTime();
      }
      const parsed = Date.parse(s);
      if (!isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

/**
 * Phân tích và nạp cấu trúc toàn bộ workbook
 */
function parseSpreadsheet(buffer, options = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: true, cellNF: true });
  const sheetNames = workbook.SheetNames || [];

  if (sheetNames.length === 0) {
    throw new Error('Tệp bảng tính rỗng, không chứa sheet nào.');
  }

  const result = {
    fileName: options.fileName || 'spreadsheet.xlsx',
    totalSheets: sheetNames.length,
    sheetNames,
    sheets: {}
  };

  for (const sName of sheetNames) {
    const worksheet = workbook.Sheets[sName];
    if (!worksheet) continue;

    // Convert sheet to array of arrays, raw: false để nhận dạng chuỗi đã định dạng sẵn từ Excel
    const rawMatrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null, raw: false });
    if (!rawMatrix || rawMatrix.length === 0) {
      result.sheets[sName] = {
        sheetName: sName,
        totalRawRows: 0,
        validDataRows: 0,
        blankRowsCount: 0,
        columns: [],
        warnings: ['Sheet rỗng, không có dữ liệu.'],
        rows: []
      };
      continue;
    }

    const { headerIndex, confidence, isLowConfidence } = detectHeaderRow(rawMatrix);
    const rawHeader = rawMatrix[headerIndex] || [];
    const headers = [];
    const seenHeaders = new Set();
    const colCount = rawHeader.length;

    for (let c = 0; c < colCount; c++) {
      let hName = rawHeader[c] ? String(rawHeader[c]).replace(/\s+/g, ' ').trim().normalize('NFC') : `Cột_${c + 1}`;
      if (!hName) hName = `Cột_${c + 1}`;
      if (seenHeaders.has(hName)) {
        hName = `${hName}_${c + 1}`;
      }
      seenHeaders.add(hName);
      headers.push(hName);
    }

    const dataRows = [];
    let blankRowsCount = 0;
    const colStats = headers.map(h => ({
      name: h,
      nullCount: 0,
      numericCount: 0,
      stringCount: 0,
      dateCount: 0,
      errorCount: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      samples: []
    }));

    for (let r = headerIndex + 1; r < rawMatrix.length; r++) {
      const row = rawMatrix[r];
      if (!row || row.length === 0) {
        blankRowsCount++;
        continue;
      }

      const isCompletelyBlank = row.every(c => c === null || c === undefined || String(c).trim() === '');
      if (isCompletelyBlank) {
        blankRowsCount++;
        continue;
      }

      const rowObj = {};
      let rowHasValidData = false;

      for (let c = 0; c < headers.length; c++) {
        const colName = headers[c];
        const stat = colStats[c];
        let val = row[c];

        if (val === null || val === undefined || String(val).trim() === '') {
          rowObj[colName] = null;
          stat.nullCount++;
          continue;
        }

        const strVal = String(val).trim();

        // Kiểm tra ô lỗi
        if (EXCEL_ERROR_VALUES.has(strVal.toUpperCase())) {
          stat.errorCount++;
          rowObj[colName] = null;
          continue;
        }

        rowHasValidData = true;

        // Xử lý ngày tháng Excel serial nếu xuất hiện dưới dạng số
        if (typeof val === 'number' && val >= 30000 && val <= 65000 && /ngày|date|time/i.test(colName)) {
          try {
            rowObj[colName] = XLSX.SSF.format('dd/mm/yyyy', val);
            stat.dateCount++;
            continue;
          } catch (e) {}
        }

        // Thử parse số nghiêm ngặt
        const parsedNum = parseVNNumber(strVal);
        if (parsedNum !== null) {
          rowObj[colName] = parsedNum;
          stat.numericCount++;
          stat.sum += parsedNum;
          if (parsedNum < stat.min) stat.min = parsedNum;
          if (parsedNum > stat.max) stat.max = parsedNum;
        } else {
          rowObj[colName] = strVal;
          stat.stringCount++;
        }

        if (stat.samples.length < 5 && strVal) {
          stat.samples.push(rowObj[colName]);
        }
      }

      if (rowHasValidData) {
        dataRows.push(rowObj);
      } else {
        blankRowsCount++;
      }
    }

    const warnings = [];
    if (isLowConfidence) {
      warnings.push(`Cảnh báo: Dòng tiêu đề được chọn tự động tại dòng ${headerIndex + 1} với độ tin cậy thấp (${Math.round(confidence * 100)}%).`);
    }

    // Format columns metadata
    const columnsMeta = colStats.map(s => {
      let inferredType = 'string';
      if (s.numericCount > s.stringCount && s.numericCount > 0) {
        inferredType = 'numeric';
      }

      const colObj = {
        name: s.name,
        type: inferredType,
        nullCount: s.nullCount,
        errorCount: s.errorCount,
        samples: s.samples
      };

      if (inferredType === 'numeric' && s.numericCount > 0) {
        colObj.metrics = {
          count: s.numericCount,
          sum: parseFloat(s.sum.toFixed(4)),
          avg: parseFloat((s.sum / s.numericCount).toFixed(4)),
          min: s.min === Infinity ? 0 : s.min,
          max: s.max === -Infinity ? 0 : s.max
        };
      }
      return colObj;
    });

    result.sheets[sName] = {
      sheetName: sName,
      headerRowIndex: headerIndex + 1,
      totalRawRows: rawMatrix.length,
      validDataRows: dataRows.length,
      blankRowsCount,
      columns: columnsMeta,
      warnings,
      rows: dataRows
    };
  }

  return result;
}

/**
 * Tính toán thống kê tổng hợp (SUM, AVERAGE, COUNT, GROUP_BY)
 */
function calculateAggregates(parsedSheet, operations = []) {
  if (!parsedSheet || !Array.isArray(parsedSheet.rows)) {
    throw new Error('Dữ liệu sheet không hợp lệ để tính toán.');
  }

  const rows = parsedSheet.rows;
  const results = {};

  for (const op of operations) {
    const { opType, column, filterCol, filterVal } = op;
    let targetRows = rows;

    if (filterCol && filterVal !== undefined) {
      targetRows = rows.filter(r => String(r[filterCol]).toLowerCase() === String(filterVal).toLowerCase());
    }

    if (opType === 'SUM') {
      const sumVal = targetRows.reduce((acc, r) => acc + (typeof r[column] === 'number' ? r[column] : 0), 0);
      results[`SUM_${column}`] = parseFloat(sumVal.toFixed(4));
    } else if (opType === 'AVERAGE') {
      const valid = targetRows.filter(r => typeof r[column] === 'number');
      const avgVal = valid.length ? valid.reduce((acc, r) => acc + r[column], 0) / valid.length : 0;
      results[`AVG_${column}`] = parseFloat(avgVal.toFixed(4));
    } else if (opType === 'COUNT') {
      results[`COUNT_${column || 'ALL'}`] = targetRows.length;
    } else if (opType === 'GROUP_BY') {
      const groups = {};
      for (const r of targetRows) {
        const key = String(r[column] || 'Chưa phân loại');
        if (!groups[key]) groups[key] = { count: 0, sum: 0 };
        groups[key].count++;
        if (op.sumCol && typeof r[op.sumCol] === 'number') {
          groups[key].sum += r[op.sumCol];
        }
      }
      results[`GROUP_BY_${column}`] = groups;
    }
  }

  return results;
}

/**
 * TÌM KIẾM VÀ TRUY VẤN NÂNG CAO TRÊN TOÀN BỘ CÁC SHEET CỦA WORKBOOK
 * Hỗ trợ:
 * - Tìm theo tuyến (Origin -> Destination)
 * - Tìm theo Vendor / Nhà cung cấp
 * - Tìm theo Mã REF
 * - Tìm kiếm không dấu, biến thể địa danh (Dĩ An, Tân Bình, Cát Lái...)
 * - Sắp xếp theo ngày cập nhật giảm dần
 */
function searchSpreadsheetRecords(parsedResult, options = {}) {
  if (!parsedResult || !parsedResult.sheets) {
    return { success: false, error: 'Không có dữ liệu bảng tính để tìm kiếm.' };
  }

  const queryRaw = String(options.query || '').trim();
  const queryNorm = removeAccents(queryRaw);
  const originNorm = removeAccents(options.origin || '');
  const destNorm = removeAccents(options.destination || '');
  const vendorNorm = removeAccents(options.vendor || '');
  const refNorm = removeAccents(options.refCode || '');
  const requestedSheet = options.sheetName ? removeAccents(options.sheetName) : null;
  const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 50));

  // Phân tích nếu query có dạng "Điểm đi -> Điểm đến" hoặc "Điểm đi đến Điểm đến"
  let parsedOriginFromQuery = null;
  let parsedDestFromQuery = null;
  let containerFilter = null;
  let isDiDon = false;
  let isDiGhep = false;

  if (/(?:đi\s*đơn|di\s*don|đơn\s*chuyến|don\s*chuyen)/i.test(queryRaw)) {
    isDiDon = true;
  }
  if (/(?:đi\s*ghép|di\s*ghep|ghép\s*chuyến|ghep\s*chuyen)/i.test(queryRaw)) {
    isDiGhep = true;
  }
  if (/(?:cont\s*20|20\s*feet|20ft|20')/i.test(queryRaw)) {
    containerFilter = '20';
  } else if (/(?:cont\s*40|40\s*feet|40ft|40')/i.test(queryRaw)) {
    containerFilter = '40';
  }

  if (!originNorm && !destNorm) {
    const normQ = removeAccents(queryRaw);
    let m = normQ.match(/\b(?:tu|from)\s+(.+?)\s+(?:den|toi|ve|to|->|→|--|-|di)\s+(.+?)(?:\s+(?:la|het|mat|khoang|tam|gia|bao|the|nhu|co|trong|theo|dung|cont|xe|hien)|\s*[\?\.!]+|$)/i);
    if (!m) {
      m = normQ.match(/(?:^|tuyen\s+|chang\s+|gia\s+)(.+?)\s*(?:->|→|--|-(?!\d)|toi|den|to|di)\s*(.+?)(?:\s+(?:la|het|mat|khoang|tam|gia|bao|the|nhu|co|trong|theo|dung|cont|xe|hien)|\s*[\?\.!]+|$)/i);
    }
    if (!m) {
      m = normQ.match(/(?:.*?\b(?:tu|from)\s+|^)(.+?)\s*(?:->|→|toi|den|to|-|di)\s*(.+)$/i);
    }
    if (m) {
      parsedOriginFromQuery = cleanRouteEndpoint(m[1]);
      parsedDestFromQuery = cleanRouteEndpoint(m[2]);
    }
  }

  const effectiveOrigin = originNorm || parsedOriginFromQuery;
  const effectiveDest = destNorm || parsedDestFromQuery;

  const matchedRecords = [];
  const reversedMatches = [];

  for (const sName of parsedResult.sheetNames) {
    if (requestedSheet && !removeAccents(sName).includes(requestedSheet)) {
      continue;
    }

    const sh = parsedResult.sheets[sName];
    if (!sh || !Array.isArray(sh.rows) || sh.rows.length === 0) continue;

    for (let rIdx = 0; rIdx < sh.rows.length; rIdx++) {
      const row = sh.rows[rIdx];
      const rowStr = Object.values(row).map(v => String(v ?? '')).join(' ');
      const rowNorm = removeAccents(rowStr);

      // Phân giải Điểm đi & Điểm đến của bản ghi (Row endpoints)
      let rowOrigin = '';
      let rowDest = '';
      let hasExplicitOriginCol = false;
      let hasExplicitDestCol = false;
      let hasRouteCol = false;
      let routeColVal = '';

      for (const [k, v] of Object.entries(row)) {
        if (v === null || v === undefined) continue;
        const kNorm = removeAccents(k);
        const vNorm = removeAccents(String(v));

        if (/diem\s*di|noi\s*di|cang\s*di|noi\s*nhan|noi\s*lay|xuat\s*phat|origin|\bfrom\b|\bpol\b/i.test(kNorm)) {
          hasExplicitOriginCol = true;
          rowOrigin += ' ' + vNorm;
        }
        if (/diem\s*den|noi\s*den|cang\s*den|noi\s*giao|noi\s*tra|dich\s*den|destination|\bto\b|\bpod\b/i.test(kNorm)) {
          hasExplicitDestCol = true;
          rowDest += ' ' + vNorm;
        }
        if (/tuyen|lo\s*trinh|chang|route/i.test(kNorm)) {
          hasRouteCol = true;
          routeColVal += ' ' + vNorm;
        }
      }

      if (!hasExplicitOriginCol && !hasExplicitDestCol && hasRouteCol) {
        const splitRoute = routeColVal.split(/\s*(?:->|→|--|-|toi|den|to|di)\s*/i);
        if (splitRoute.length >= 2) {
          rowOrigin = splitRoute[0].trim();
          rowDest = splitRoute.slice(1).join(' ').trim();
          hasExplicitOriginCol = true;
          hasExplicitDestCol = true;
        }
      }

      let isMatch = true;

      // 1. Kiểm tra Origin (Điểm đi)
      if (effectiveOrigin) {
        let matchOrigin = false;
        if (hasExplicitOriginCol) {
          matchOrigin = matchEndpoint(rowOrigin, effectiveOrigin);
        } else {
          matchOrigin = matchEndpoint(rowNorm, effectiveOrigin);
        }
        if (!matchOrigin) isMatch = false;
      }

      // 2. Kiểm tra Destination (Điểm đến)
      if (isMatch && effectiveDest) {
        let matchDest = false;
        if (hasExplicitDestCol) {
          matchDest = matchEndpoint(rowDest, effectiveDest);
        } else {
          matchDest = matchEndpoint(rowNorm, effectiveDest);
        }
        if (!matchDest) isMatch = false;
      }

      // 2b. Chống đảo ngược tuyến (Anti-Reverse Route Guard)
      if (effectiveOrigin && effectiveDest && (hasExplicitOriginCol || hasExplicitDestCol)) {
        const isReversedOrigin = rowOrigin && matchEndpoint(rowOrigin, effectiveDest);
        const isReversedDest = rowDest && matchEndpoint(rowDest, effectiveOrigin);
        if (isReversedOrigin && isReversedDest) {
          isMatch = false;
          reversedMatches.push({
            sheet: sName,
            rowNumber: rIdx + 2,
            data: row,
            actualRoute: `${rowOrigin.trim()} -> ${rowDest.trim()}`
          });
        }
      }

      // 3. Kiểm tra Vendor (Nhà cung cấp)
      if (isMatch && vendorNorm) {
        let matchVendor = false;
        for (const [k, v] of Object.entries(row)) {
          if (/vendor|nha\s*cung\s*cap|don\s*vi|carrier/i.test(removeAccents(k))) {
            const vNorm = removeAccents(v || '');
            if (vNorm.includes(vendorNorm) || vendorNorm.includes(vNorm)) {
              matchVendor = true;
              break;
            }
          }
        }
        if (!matchVendor) {
          matchVendor = rowNorm.includes(vendorNorm);
        }
        if (!matchVendor) isMatch = false;
      }

      // 4. Kiểm tra Ref Code
      if (isMatch && refNorm) {
        let matchRef = false;
        for (const [k, v] of Object.entries(row)) {
          if (/ref|ma\s*ref/i.test(removeAccents(k))) {
            const vNorm = removeAccents(v || '');
            if (vNorm.includes(refNorm) || refNorm.includes(vNorm)) {
              matchRef = true;
              break;
            }
          }
        }
        if (!matchRef) {
          matchRef = rowNorm.includes(refNorm);
        }
        if (!matchRef) isMatch = false;
      }

      // 4b. Kiểm tra Container condition (đi đơn vs đi ghép) và size nếu có yêu cầu
      if (isMatch && isDiDon) {
        if (/di\s*ghep/i.test(rowNorm) && !/di\s*don/i.test(rowNorm)) {
          isMatch = false;
        }
      }
      if (isMatch && isDiGhep) {
        if (/di\s*don/i.test(rowNorm) && !/di\s*ghep/i.test(rowNorm)) {
          isMatch = false;
        }
      }
      if (isMatch && containerFilter) {
        if (!rowNorm.includes(containerFilter)) {
          isMatch = false;
        }
      }

      // 5. Kiểm tra Query chung (nếu không có origin/dest cụ thể)
      if (isMatch && queryNorm && !effectiveOrigin && !effectiveDest && !vendorNorm && !refNorm) {
        const tokens = queryNorm.split(/\s+/).filter(t => t.length > 1);
        const allTokensPresent = tokens.every(t => rowNorm.includes(t) || matchLocationAliases(rowNorm, t));
        if (!allTokensPresent) isMatch = false;
      }

      if (isMatch) {
        matchedRecords.push({
          sheet: sName,
          rowNumber: rIdx + 2, // Excel 1-based, header is row 1
          data: row
        });
      }
    }
  }

  // Sắp xếp bản ghi theo ngày giảm dần (ngày mới nhất xếp trên)
  matchedRecords.sort((a, b) => {
    const dateA = extractDateSortValue(a.data);
    const dateB = extractDateSortValue(b.data);
    return dateB - dateA;
  });

  return {
    success: true,
    totalMatches: matchedRecords.length,
    results: matchedRecords.slice(0, limit),
    hasReversedRoute: matchedRecords.length === 0 && reversedMatches.length > 0,
    reversedMatchesCount: reversedMatches.length,
    reversedRouteResults: matchedRecords.length === 0 ? reversedMatches.slice(0, 5) : [],
    requestedRoute: (effectiveOrigin || effectiveDest) ? {
      origin: effectiveOrigin,
      destination: effectiveDest
    } : null
  };
}

/**
 * XUẤT HỒ SƠ VÀ DỮ LIỆU ĐỂ ĐƯA VÀO PROMPT CHO AI
 * - Với các sheet <= 100 dòng: Xuất TOÀN BỘ dữ liệu dạng bảng Markdown để LLM đọc trực tiếp không cần tool.
 * - Với các sheet > 100 dòng: Xuất 25 dòng mẫu + chỉ dẫn kích hoạt công cụ search_spreadsheet_data.
 */
function formatProfileForPrompt(parsedResult) {
  let text = `[HỒ SƠ BẢNG TÍNH ĐỐI SOÁT XÁC ĐỊNH - 100% PHẠM VI DỮ LIỆU ĐÃ XỬ LÝ]:\n`;
  text += `- Tên file: ${parsedResult.fileName}\n`;
  text += `- Số sheet: ${parsedResult.totalSheets} (${parsedResult.sheetNames.join(', ')})\n`;
  text += `- HƯỚNG DẪN TRUY XUẤT: Bạn có công cụ "search_spreadsheet_data" để tìm kiếm, tra cứu và lọc chi tiết các dòng theo tuyến đường (điểm đi/đến), nhà cung cấp, mã REF, ngày tháng trên TOÀN BỘ các sheet.\n\n`;

  for (const sName of parsedResult.sheetNames) {
    const sh = parsedResult.sheets[sName];
    text += `### Sheet: "${sName}"\n`;
    text += `- Tổng số dòng thực tế: ${sh.validDataRows.toLocaleString('vi-VN')} dòng hợp lệ (loại ${sh.blankRowsCount} dòng trống)\n`;
    text += `- Dòng tiêu đề: dòng ${sh.headerRowIndex}\n`;
    if (sh.warnings && sh.warnings.length) {
      text += `- Ghi chú an toàn: ${sh.warnings.join('; ')}\n`;
    }

    if (sh.validDataRows === 0) {
      text += `*(Sheet rỗng hoặc chỉ chứa tiêu đề)*\n\n`;
      continue;
    }

    // Nếu sheet có <= 100 dòng: In toàn bộ dữ liệu dạng bảng Markdown
    if (sh.validDataRows <= 100) {
      text += `\n**DỮ LIỆU ĐẦY ĐỦ CỦA SHEET "${sName}" (100% dòng dữ liệu):**\n\n`;
      const colNames = sh.columns.map(c => c.name);
      text += `| ${colNames.join(' | ')} |\n`;
      text += `| ${colNames.map(() => '---').join(' | ')} |\n`;

      for (const row of sh.rows) {
        const rowValues = colNames.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return '';
          if (typeof val === 'number' && Number.isInteger(val) && Math.abs(val) >= 10000) {
            return val.toLocaleString('vi-VN');
          }
          return String(val).replace(/\|/g, '/').replace(/\n/g, ' ');
        });
        text += `| ${rowValues.join(' | ')} |\n`;
      }
      text += `\n`;
    } else {
      // Sheet lớn > 100 dòng: In mẫu 20 dòng đầu + nhắc sử dụng công cụ
      text += `\n**MẪU 20 DÒNG ĐẦU CỦA SHEET "${sName}" (Sheet có ${sh.validDataRows} dòng, sử dụng tool search_spreadsheet_data để tìm thêm):**\n\n`;
      const colNames = sh.columns.map(c => c.name);
      text += `| ${colNames.join(' | ')} |\n`;
      text += `| ${colNames.map(() => '---').join(' | ')} |\n`;

      for (const row of sh.rows.slice(0, 20)) {
        const rowValues = colNames.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return '';
          if (typeof val === 'number' && Number.isInteger(val) && Math.abs(val) >= 10000) {
            return val.toLocaleString('vi-VN');
          }
          return String(val).replace(/\|/g, '/').replace(/\n/g, ' ');
        });
        text += `| ${rowValues.join(' | ')} |\n`;
      }
      text += `\n> *(Sheet này có tổng cộng ${sh.validDataRows} dòng. Hãy sử dụng công cụ "search_spreadsheet_data" khi người dùng hỏi các dòng dữ liệu khác.)*\n\n`;
    }
  }

  text += `LƯU Ý QUAN TRỌNG VỀ ĐỘ CHÍNH XÁC:\n`;
  text += `1. Toàn bộ dữ liệu bảng tính ở trên là dữ liệu thực tế từ file người dùng tải lên. Hãy đọc kỹ từng sheet (đặc biệt các sheet "Miền Nam", "Miền Bắc", v.v.).\n`;
  text += `2. Khi người dùng hỏi về tuyến đường hoặc báo giá, hãy tìm kiếm chính xác các dòng tương ứng, nêu rõ ngày báo giá, nhà cung cấp, mã REF, loại hình và giá cost theo từng xe/chuyến.\n`;
  text += `3. Nếu có nhiều bản ghi cho cùng tuyến đường hoặc mã REF, hãy liệt kê đầy đủ và sắp xếp theo ngày cập nhật mới nhất trước.\n`;
  text += `4. NGUYÊN TẮC ĐỊNH HƯỚNG TUYẾN ĐƯỜNG (A -> B KHÔNG BẰNG B -> A): Tuyến đường vận chuyển có tính định hướng một chiều (Điểm đi -> Điểm đến). Chi phí chiều đi và chiều về thường khác nhau. Nếu bảng tính CHỈ CÓ chiều từ A đến B mà người dùng hỏi từ B đến A (chiều ngược lại), TUYỆT ĐỐI KHÔNG được lấy giá của chiều A -> B để trả lời khẳng định cho B -> A. Bắt buộc phải thông báo rõ ràng là bảng tính chỉ có dữ liệu chiều từ A đến B, CHƯA CÓ báo giá cho chiều ngược lại từ B đến A.`;

  return text;
}

module.exports = {
  parseSpreadsheet,
  calculateAggregates,
  searchSpreadsheetRecords,
  formatProfileForPrompt,
  parseVNNumber,
  removeAccents,
  matchLocationAliases
};
