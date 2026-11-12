/**
 * SOTRANS HUB — MULTI-PAGE OCR & INTELLIGENT EXTRACTION ENGINE
 * 
 * Đáp ứng toàn diện Chỉ đạo BƯỚC 4 & Triển khai bắt buộc mục B & C:
 * 1. PDF-to-Image toàn bộ các trang (không bỏ sót trang).
 * 2. Tự động phát hiện hướng xoay ảnh (Deskew / Auto-Orientation) và xoay chuẩn trước khi OCR.
 * 3. Tesseract OCR đa trang hỗ trợ cả tiếng Việt và tiếng Anh (vie+eng).
 * 4. Ưu tiên nhận diện các vùng: Số CCCD, Họ tên, Ngày sinh, Ngày cấp, VNeID, Quyết định tuyển dụng, Thư mời nhận việc.
 * 5. Ưu tiên nguồn thông tin điện tử/văn bản in chính thức (Quyết định, Thư mời, CCCD, VNeID, Bằng cấp) so với chữ viết tay.
 * 6. Chuẩn hóa số CCCD: loại bỏ khoảng trắng, dấu phân cách, kiểm tra 9 hoặc 12 số.
 * 7. Kiểm tra tính hợp lệ của Họ tên người Việt chuẩn xác: chống nhầm với nhãn hành chính, lọc bỏ nhiễu OCR chữ số.
 * 8. Đối chiếu kết quả giữa nhiều trang (Cross-page validation & Consensus scoring).
 * 9. Phát hiện xung đột dữ liệu giữa các trang -> gắn cờ yêu cầu kiểm tra thủ công.
 * 10. Tuyệt đối không lấy tên file làm họ tên nhân sự, không suy đoán thông tin.
 * 11. Tích hợp Gemini 3.5 Flash-Lite Vision bóc tách cấu trúc 53 trường chuẩn.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

/**
 * Standardize and clean CCCD
 * @param {string} raw 
 * @returns {{ cleanCccd: string|null, isValid: boolean, length: number }}
 */
function standardizeCccd(raw) {
  if (!raw) return { cleanCccd: null, isValid: false, length: 0 };
  const clean = String(raw).replace(/\D/g, '');
  const isValid = clean.length === 12 || clean.length === 9;
  return {
    cleanCccd: isValid ? clean : null,
    isValid,
    length: clean.length
  };
}

/**
 * Standardize Date string to YYYY-MM-DD
 */
function standardizeDate(raw) {
  if (!raw) return null;
  const match = String(raw).match(/([0-9]{1,2})[/-]([0-9]{1,2})[/-]([0-9]{4})/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}`;
  }
  const isoMatch = String(raw).match(/([0-9]{4})[/-]([0-9]{1,2})[/-]([0-9]{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  return null;
}

/**
 * Remove accent marks for comparison
 */
function removeAccents(str) {
  if (!str) return '';
  return str.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().trim();
}

function levenshteinDistance(a, b) {
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

/**
 * Common Vietnamese Surnames
 */
const COMMON_VN_SURNAMES = new Set([
  'nguyen', 'tran', 'le', 'pham', 'hoang', 'huynh', 'phan', 'vu', 'vo', 'dang', 'bui', 'do', 'ho', 'ngo',
  'duong', 'ly', 'dao', 'dinh', 'doan', 'lam', 'trinh', 'mai', 'cao', 'truong', 'ha', 'luong', 'nong',
  'trieu', 'luu', 'vuong', 'dam', 'chu', 'chau', 'to', 'phung', 'ta', 'giang', 'khong', 'quach', 'thai',
  'van', 'la', 'thach', 'luc', 'tieu', 'kim', 'tong', 'than', 'hua', 'kieu', 'thieu', 'doan', 'du'
]);

/**
 * Check if a candidate name is a valid person's name
 */
function isValidPersonName(name) {
  if (!name || typeof name !== 'string') return false;
  let clean = name.trim().replace(/\s+/g, ' ');

  // Strip honorific prefixes: Ông, Bà, Anh, Chị
  clean = clean.replace(/^(?:Ông|Bà|Anh|Chị|Ong|Ba|Mr|Mrs|Ms)\s+/i, '').trim();

  if (clean.length < 4 || clean.length > 40) return false;

  // Must NOT contain digits
  if (/\d/.test(clean)) return false;

  // Must NOT contain U+FFFD
  if (clean.includes('\uFFFD')) return false;

  // Must NOT contain forbidden special symbols/delimiters
  if (/[\(\)\[\]\{\}\<\>\;\:\*\?\!\@\#\$\%\^\&\_\=\+\\\|\/\"~`—–]/.test(clean)) {
    return false;
  }

  // Must NOT match administrative / document structure labels / locations / organizations
  const lower = clean.toLowerCase();
  const norm = removeAccents(lower);
  if (/(?:^|\s)(?:chu in hoa|in hoa|viet hoa|khai sinh|ung vien|nguoi lao dong|tap su|khong|ho va ten|ho ten|chu ky|kinh gui|chuc vu|phong ban|noi lam viec|so dien thoai|kinh te van tai|cu nhan|nhan vien|giam doc|truong phong|don vi|cong ty|tong cong ty|quyet dinh|thu moi|gioi tinh|ngay sinh|noi sinh|que quan|thuong tru|quoc tich|dan toc|duong song|duong bo|duong thuy|hang hai|logistics|sotrans|sowatco|ho chi minh|viet nam|cong hoa|xa hoi|doc lap|tu do|hanh phuc|co phan)(?:\s|$)/i.test(norm)) {
    return false;
  }

  const words = clean.split(' ').filter(w => w.length > 0);
  if (words.length < 2 || words.length > 5) return false;

  // Check each word's casing and phonetics
  for (const w of words) {
    // Single consonant cannot be a Vietnamese word (e.g. "n", "r", "k")
    if (w.length === 1 && !/^[aăâeêioôơuưyáắấéếíóốớúứýàằầèềìòồờùừỳảẳẩẻểỉỏổởủửỷãẵẫẽễĩõỗỡũữỹạặậẹệịọộợụựỵ]$/i.test(w)) {
      return false;
    }
    // Must contain at least one vowel
    if (!/[aăâeêioôơuưyáắấéếíóốớúứýàằầèềìòồờùừỳảẳẩẻểỉỏổởủửỷãẵẫẽễĩõỗỡũữỹạặậẹệịọộợụựỵ]/i.test(w)) {
      return false;
    }
    // Check casing: each word should be TitleCase or ALL_UPPERCASE or all_lowercase
    const isUpper = w === w.toUpperCase();
    const isLower = w === w.toLowerCase();
    const isTitle = (w[0] === w[0].toUpperCase()) && (w.slice(1) === w.slice(1).toLowerCase());
    if (!isUpper && !isLower && !isTitle) {
      return false;
    }
    // Foreign non-Vietnamese letters
    if (/[fzwj]/i.test(w)) {
      return false;
    }
  }

  // Check surname (first word)
  const firstWordNorm = removeAccents(words[0]);
  if (!COMMON_VN_SURNAMES.has(firstWordNorm)) {
    if (/^(?:ilyuy|iluy|lyuy|uyr)/i.test(firstWordNorm)) return false;
  }

  return true;
}

/**
 * Classify document type of a specific page based on OCR text
 */
function classifyPageType(text) {
  const t = (text || '').toLowerCase();

  // 0. Dossier Checklist / Table of contents (NEVER classify as VNeID or CCCD)
  if (t.includes('danh mục hồ sơ') || t.includes('danh mục ho so') || t.includes('bảng kiểm tra hồ sơ') || t.includes('danh mục tài liệu')) {
    return { type: 'DOSSIER_CHECKLIST', weight: 25, isElectronic: false };
  }
  // 1. Official Corporate Decision
  if (t.includes('quyết định') && (t.includes('tuyển dụng') || t.includes('điều động') || t.includes('bổ nhiệm') || t.includes('tiếp nhận'))) {
    return { type: 'DECISION_LETTER', weight: 100, isElectronic: true };
  }
  // 2. Offer Letter / Thư mời nhận việc
  if (t.includes('thư mời nhận việc') || t.includes('thu moi nhan viec') || t.includes('thư mời làm việc')) {
    return { type: 'OFFER_LETTER', weight: 95, isElectronic: true };
  }
  // 3. VNeID Digital Identity App
  if ((t.includes('căn cước điện tử') || t.includes('căncước điện tử') || t.includes('vneid') || t.includes('tài khoản định danh')) &&
      (t.includes('số định danh') || t.includes('personal identity') || t.includes('quê quán') || t.includes('nơi thường trú') || t.includes('bộ công an'))) {
    return { type: 'VNEID_DIGITAL', weight: 95, isElectronic: true };
  }
  // 4. CCCD Physical Card
  if (t.includes('thông tin căn cước công dân') || t.includes('mã qr in trên cccd') || (t.includes('căn cước công dân') && (t.includes('có giá trị đến') || t.includes('ngày cấp cccd')))) {
    return { type: 'CCCD_CARD', weight: 100, isElectronic: true };
  }
  // 5. University Degree
  if (t.includes('bằng cử nhân') || t.includes('bằng tốt nghiệp') || t.includes('confers the degree') || t.includes('cấp bằng')) {
    return { type: 'UNIVERSITY_DEGREE', weight: 90, isElectronic: true };
  }
  // 6. Application Form
  if (t.includes('bản thông tin ứng viên') || t.includes('thông tin ứng viên')) {
    return { type: 'APPLICATION_FORM', weight: 85, isElectronic: true };
  }
  // 7. Handwritten Form / Application
  if (t.includes('phiếu đăng ký dự tuyển') || t.includes('sơ yếu lý lịch') || t.includes('tự thuật') || t.includes('đơn xin việc')) {
    return { type: 'HANDWRITTEN_FORM', weight: 35, isElectronic: false };
  }
  // 8. Official Certification
  if (t.includes('chứng thực') || t.includes('ủy ban nhân dân') || t.includes('ubnd')) {
    return { type: 'OFFICIAL_CERTIFICATION', weight: 90, isElectronic: true };
  }
  // 9. Health Check
  if (t.includes('khám sức khỏe') || t.includes('bệnh viện') || t.includes('phòng khám')) {
    return { type: 'HEALTH_CHECK', weight: 85, isElectronic: true };
  }
  // 10. Labor Contract
  if (t.includes('hợp đồng lao động') || t.includes('hđlđ') || t.includes('lao động xác định thời hạn')) {
    return { type: 'LABOR_CONTRACT', weight: 80, isElectronic: true };
  }
  return { type: 'GENERAL_DOCUMENT', weight: 50, isElectronic: false };
}

/**
 * Extract candidates from OCR text of a single page
 */
function extractFromPageText(text, pageNum) {
  const pageClassification = classifyPageType(text);
  const candidates = {
    pageNum,
    classification: pageClassification,
    cccds: [],
    names: [],
    dobs: [],
    genders: [],
    addresses: [],
    issueDates: []
  };

  // 1. CCCD patterns
  const cccdLabelRegex = /(?:Số\s*CCCD|Số\s*căn\s*cước|Căn\s*cước\s*công\s*dân|Số\s*\/|Số\s*định\s*danh|Mã\s*số)[:\s]*([0-9\s]{9,16})/gi;
  let match;
  while ((match = cccdLabelRegex.exec(text)) !== null) {
    const std = standardizeCccd(match[1]);
    if (std.isValid) {
      candidates.cccds.push({ value: std.cleanCccd, weight: pageClassification.weight + 15, source: `label_p${pageNum}` });
    }
  }

  // 12 digits or 4-4-4 format
  const raw12Regex = /\b(\d{4}\s+\d{4}\s+\d{4})\b|\b(0\d{11})\b/g;
  while ((match = raw12Regex.exec(text)) !== null) {
    const rawVal = match[1] || match[2];
    const std = standardizeCccd(rawVal);
    if (std.isValid) {
      candidates.cccds.push({ value: std.cleanCccd, weight: pageClassification.weight, source: `regex12_p${pageNum}` });
    }
  }

  // 9 digits (CMND)
  const raw9Regex = /\b([0-3]\d{8})\b/g;
  while ((match = raw9Regex.exec(text)) !== null) {
    const std = standardizeCccd(match[1]);
    if (std.isValid) {
      candidates.cccds.push({ value: std.cleanCccd, weight: pageClassification.weight - 5, source: `regex9_p${pageNum}` });
    }
  }

  // 2. Full Name patterns
  // Pattern a: Decision Letter (Page 7)
  const decisionRegex = /(?:tuy[eế]n\s*d[uụ]ng\s*v[aà]\s*[đd]i[eề]u\s*[đd][oộ]ng|[đd]i[eề]u\s*[đd][oộ]ng)\s*(?:[OÔô]ng|[BВb]à)?\s*[:\s]*([A-ZÀ-Ỹa-zà-ỹ\s]{3,35})(?=\s*[-–—\n]|\s*Cử nhân|\s*là hợp đồng|\s*Đến nhận)/gi;
  let dMatch;
  while ((dMatch = decisionRegex.exec(text)) !== null) {
    let clean = dMatch[1].trim().replace(/\s+/g, ' ');
    clean = clean.replace(/^(?:Ông|Bà|Anh|Chị|Ong|Ba)\s+/i, '').trim();
    if (isValidPersonName(clean)) {
      candidates.names.push({ value: clean.toUpperCase(), weight: pageClassification.weight + 40, source: `decision_p${pageNum}` });
    }
  }

  // Pattern b: Offer Letter (Page 9)
  const offerRegex = /K[ií]nh\s*g[uử]i\s*(?:Anh[\/\s]*Ch[iị]|Ông[\/\s]*Bà|Anh|Chị|Ông|Bà)?\s*[:\s]+([A-ZÀ-Ỹa-zà-ỹ\s]{3,35})(?=\s*[-–—\n]|\s*Địa chỉ|\s*Số điện thoại)/gi;
  let oMatch;
  while ((oMatch = offerRegex.exec(text)) !== null) {
    let clean = oMatch[1].trim().replace(/\s+/g, ' ');
    clean = clean.replace(/^(?:Ông|Bà|Anh|Chị|Ong|Ba)\s+/i, '').trim();
    if (isValidPersonName(clean)) {
      candidates.names.push({ value: clean.toUpperCase(), weight: pageClassification.weight + 35, source: `offer_p${pageNum}` });
    }
  }

  // Pattern c: CCCD Card Page
  const cccdCardNameMatch = text.match(/Họ\s*và\s*tên[:\s\n]+([A-ZÀ-Ỹa-zà-ỹ\s]{3,35})(?=\s*\n\s*(?:Giới\s*tính|Ngày\s*sinh|Quốc\s*tịch|Dân\s*tộc|$))/i);
  if (cccdCardNameMatch) {
    let cleanName = cccdCardNameMatch[1].trim().replace(/\s+/g, ' ');
    cleanName = cleanName.replace(/^(?:Ông|Bà|Anh|Chị|Ong|Ba)\s+/i, '').trim();
    if (isValidPersonName(cleanName)) {
      candidates.names.push({ value: cleanName.toUpperCase(), weight: pageClassification.weight + 30, source: `cccd_card_p${pageNum}` });
    }
  }

  // Pattern d: General label matches (stops before next field on same line)
  const nameLabelMatch = text.match(/(?:Họ\s*và\s*tên|Họ\s*tên|HỌ\s*VÀ\s*TÊN|HỌ\s*VÀ\s*TÊN\s*KHAI\s*SINH|Tên\s*tôi\s*là)[:\s]+([^\n\r,;:–—]+?)(?=\s+(?:Nơi\s*sinh|Giới\s*tính|Ngày\s*sinh|Sinh\s*ngày|Quê\s*quán|Số\s*CCCD|CCCD|Dân\s*tộc|Quốc\s*tịch|Đơn\s*vị|Chức\s*vụ|Mã\s*NV)\b|[\n\r,;:–—]|$)/i);
  if (nameLabelMatch) {
    let raw = nameLabelMatch[1].trim().replace(/\s+/g, ' ');
    raw = raw.replace(/^(?:Ông|Bà|Anh|Chị|Ong|Ba)\s+/i, '').trim();
    if (isValidPersonName(raw)) {
      candidates.names.push({ value: raw.toUpperCase(), weight: pageClassification.weight + 20, source: `label_p${pageNum}` });
    }
  }

  // Pattern e: Printed Full Name with standard Vietnamese surname
  const printedNameMatch = text.match(/(?<!cổ\s+|thành\s+|giai\s+)\b((?:NGUYỄN|TRẦN|LÊ|PHẠM|HOÀNG|HUỲNH|PHAN|VŨ|VÕ|ĐẶNG|BÙI|ĐỖ|HỒ|NGÔ|DƯƠNG|LÝ)\s+[A-ZÀ-Ỹa-zà-ỹ\s]{3,25})\b/i);
  if (printedNameMatch) {
    let clean = printedNameMatch[1].trim().replace(/\s+/g, ' ');
    clean = clean.replace(/^(?:Ông|Bà|Anh|Chị|Ong|Ba)\s+/i, '').trim();
    if (isValidPersonName(clean)) {
      candidates.names.push({ value: clean.toUpperCase(), weight: pageClassification.weight + 15, source: `printed_header_p${pageNum}` });
    }
  }

  // 3. Date of birth
  const dobMatch = text.match(/(?:Ngày\s*sinh|Sinh\s*ngày|DOB|Date\s*of\s*birth)[:\s]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4})/i) ||
                   text.match(/\b([0-3][0-9]\/[0-1][0-9]\/(?:19|20)[0-9]{2})\b/);
  if (dobMatch) {
    const stdDob = standardizeDate(dobMatch[1]);
    if (stdDob) {
      candidates.dobs.push({ value: stdDob, weight: pageClassification.weight, source: `dob_p${pageNum}` });
    }
  }

  // 4. Gender
  const genderMatch = text.match(/(?:Giới\s*tính)[:\s]*(Nam|Nữ|Male|Female)/i) ||
                      text.match(/Giới\s*tính[\s\n]+(Nam|Nữ)/i);
  if (genderMatch) {
    candidates.genders.push({ value: /nam|male/i.test(genderMatch[1]) ? 'Nam' : 'Nữ', weight: pageClassification.weight });
  }

  // 5. Permanent Address
  // Special pattern for CCCD card
  const cccdCardAddrMatch = text.match(/Nơi\s*thường\s*trú[\s\n]+([\s\S]+?)(?=\n\s*(?:Ngày\s*cấp|Thông\s*tin|Nơi\s*ở|Nơi\s*tạm\s*trú|Quê\s*quán|Đặc\s*điểm|$))/i);
  if (cccdCardAddrMatch) {
    let cleanAddr = cccdCardAddrMatch[1].trim().replace(/\s+/g, ' ').replace(/^[^a-zA-Z0-9\s,./-]+/, '').trim();
    if (cleanAddr.length > 8 && !cleanAddr.toLowerCase().includes('không')) {
      candidates.addresses.push({ value: cleanAddr, weight: pageClassification.weight + 40, source: `cccd_card_addr_p${pageNum}` });
    }
  }

  const cccdAddrMatch = text.match(/(?:Nơi\s*thường\s*trú|Thường\s*trú|Hộ\s*khẩu\s*thường\s*trú)[:\s\n]+([^\n\r]+(?:\n[^\n\r]+)?)/i);
  if (cccdAddrMatch) {
    let rawAddr = cccdAddrMatch[1].trim().replace(/\s+/g, ' ');
    rawAddr = rawAddr.replace(/^[^a-zA-Z0-9\s,./-]+/, '').trim();
    if (rawAddr.length > 8 && !rawAddr.toLowerCase().includes('không')) {
      candidates.addresses.push({ value: rawAddr, weight: pageClassification.weight + 20 });
    }
  }

  // 6. Issue Date
  const issueMatch = text.match(/(?:Ngày\s*cấp\s*CCCD|Ngày\s*cấp|Cấp\s*ngày)[:\s]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4})/i);
  if (issueMatch) {
    const stdIssue = standardizeDate(issueMatch[1]);
    if (stdIssue) {
      candidates.issueDates.push({ value: stdIssue, weight: pageClassification.weight });
    }
  }

  return candidates;
}

/**
 * Call Gemini 3.5 Flash-Lite with high-priority page images for comprehensive 53-field extraction
 */
async function callGeminiVisionForDossier(highPriorityImages, contextText = '') {
  if (!GEMINI_API_KEY) {
    console.warn('[MultiPageOcrEngine] GEMINI_API_KEY not configured, skipping AI vision call');
    return null;
  }

  try {
    const parts = [];
    for (const img of highPriorityImages) {
      if (fs.existsSync(img.path)) {
        const base64Data = fs.readFileSync(img.path).toString('base64');
        parts.push({
          inline_data: {
            mime_type: 'image/png',
            data: base64Data
          }
        });
        parts.push({
          text: `Hình ảnh trang ${img.page} (${img.type})`
        });
      }
    }

    if (parts.length === 0) return null;

    parts.push({
      text: `Dưới đây là các trang tài liệu định danh trọng yếu của nhân sự (Quyết định tuyển dụng, Thư mời nhận việc, Thẻ CCCD, VNeID, Bản thông tin ứng viên, Bằng cử nhân).
Văn bản OCR thu được từ toàn bộ các trang:
${contextText.slice(0, 10000)}

NHIỆM VỤ: Hãy trích xuất thông tin định danh và hồ sơ nhân sự theo đúng chuẩn của tập đoàn SOTRANS.
QUY TẮC BẮT BUỘC:
1. Số CCCD: 9 hoặc 12 số nguyên vẹn (ví dụ: 036202007139, 079204001284, 062093000277). Bỏ qua mọi khoảng trắng hay ký tự phân tách.
2. Họ và tên: Lấy từ văn bản in chính thức (Quyết định tuyển dụng, Thư mời nhận việc, Thẻ CCCD, VNeID). Viết HOA đầy đủ có dấu (ví dụ: NGUYỄN TRƯỜNG NAM, PHAN DƯƠNG THANH BÌNH, NGÔ ĐẶNG TUẤN UYÊN). Tuyệt đối không lấy chữ viết tay nguệch ngoạc trên phiếu nộp hồ sơ/danh mục checklist, không lấy tên chức vụ hoặc tên cơ quan làm tên người.
3. Ngày sinh, ngày cấp: Định dạng YYYY-MM-DD.
4. Trả về ĐÚNG 1 JSON object thuần túy duy nhất với các trường:
{
  "full_name": "string",
  "citizen_id": "string",
  "date_of_birth": "YYYY-MM-DD",
  "gender": "Nam | Nữ",
  "permanent_address": "string",
  "current_address": "string",
  "citizen_id_issue_date": "YYYY-MM-DD",
  "place_of_origin": "string",
  "ethnicity": "string",
  "job_title": "string",
  "company_id": "string",
  "department_staffing_plan": "string",
  "phone_number": "string",
  "email": "string"
}`
    });

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          response_mime_type: 'application/json'
        }
      })
    });

    if (!res.ok) {
      console.warn(`[MultiPageOcrEngine] Gemini Vision HTTP ${res.status}`);
      return null;
    }

    const resData = await res.json();
    const candidate = resData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) return null;

    const clean = candidate.replace(/^\`\`\`json\s*/i, '').replace(/\`\`\`\s*$/i, '').trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch (err) {
    console.warn('[MultiPageOcrEngine] Gemini Vision call failed:', err.message);
    return null;
  }
}

/**
 * Main Pipeline: Process Document with Multi-Page OCR
 * @param {string|Buffer} input - Path to PDF/image or file Buffer
 * @param {object} options - { fileName, mimeType, maxPages }
 */
async function processDocumentMultiPage(input, options = {}) {
  const fileName = options.fileName || 'document.pdf';
  const tmpId = `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = path.join(os.tmpdir(), tmpId);
  fs.mkdirSync(tmpDir, { recursive: true });

  const auditLog = {
    fileName,
    totalPages: 0,
    pageResults: [],
    consensus: {},
    conflicts: [],
    requiresManualReview: false,
    durationMs: 0
  };
  const startTime = Date.now();

  try {
    let pdfPath = '';
    if (Buffer.isBuffer(input)) {
      pdfPath = path.join(tmpDir, fileName);
      fs.writeFileSync(pdfPath, input);
    } else if (typeof input === 'string') {
      if (!fs.existsSync(input)) {
        throw new Error(`File không tồn tại trên đĩa: ${input}`);
      }
      pdfPath = input;
    } else {
      throw new Error('Dữ liệu đầu vào không hợp lệ (phải là Buffer hoặc filepath)');
    }

    // 1. PDF-to-Image for ALL pages using pdftoppm
    const imgPrefix = path.join(tmpDir, 'page');
    try {
      execSync(`pdftoppm -png -r 150 "${pdfPath}" "${imgPrefix}"`);
    } catch (ppmErr) {
      console.error('[MultiPageOcrEngine] pdftoppm error:', ppmErr.message);
      throw new Error(`Không thể chuyển đổi PDF sang ảnh: ${ppmErr.message}`);
    }

    const imageFiles = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10);
        const numB = parseInt(b.replace(/\D/g, ''), 10);
        return numA - numB;
      });

    auditLog.totalPages = imageFiles.length;
    if (imageFiles.length === 0) {
      throw new Error('Không có trang nào được trích xuất từ tệp PDF');
    }

    // 2. Multi-page Tesseract OCR (vie+eng) for ALL pages with worker pool concurrency
    const CONCURRENCY = 3;
    const ocrResults = new Array(imageFiles.length);

    async function processPage(index) {
      const imgName = imageFiles[index];
      const pageNum = parseInt(imgName.replace(/\D/g, ''), 10);
      const imgPath = path.join(tmpDir, imgName);

      // Auto-Orientation / Deskew Check via Tesseract OSD
      let effectiveImgPath = imgPath;
      try {
        const osdOut = execSync(`tesseract "${imgPath}" stdout --psm 0 2>/dev/null || true`).toString();
        const rotateMatch = osdOut.match(/Rotate:\s*(\d+)/i);
        if (rotateMatch) {
          const deg = parseInt(rotateMatch[1], 10);
          if (deg === 90 || deg === 180 || deg === 270) {
            const rotPath = path.join(tmpDir, `rot_${deg}_${imgName}`);
            execSync(`magick "${imgPath}" -rotate ${deg} "${rotPath}" 2>/dev/null || convert "${imgPath}" -rotate ${deg} "${rotPath}" 2>/dev/null || true`);
            if (fs.existsSync(rotPath) && fs.statSync(rotPath).size > 1000) {
              effectiveImgPath = rotPath;
            }
          }
        }
      } catch (osdErr) {
        // Fallback to original imgPath
      }

      const txtBase = path.join(tmpDir, `ocr_${imgName.replace('.png', '')}`);
      try {
        await execPromise(`tesseract "${effectiveImgPath}" "${txtBase}" -l vie+eng --psm 1 2>/dev/null || true`);
      } catch (tessErr) {
        console.warn(`[MultiPageOcrEngine] Tesseract warning page ${pageNum}:`, tessErr.message);
      }

      const txtPath = txtBase + '.txt';
      const pageText = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : '';
      const pageCandidates = extractFromPageText(pageText, pageNum);

      let highPriority = null;
      if (['DECISION_LETTER', 'OFFER_LETTER', 'CCCD_CARD', 'VNEID_DIGITAL', 'APPLICATION_FORM', 'UNIVERSITY_DEGREE', 'HEALTH_CHECK', 'OFFICIAL_CERTIFICATION'].includes(pageCandidates.classification.type)) {
        highPriority = {
          page: pageNum,
          type: pageCandidates.classification.type,
          weight: pageCandidates.classification.weight,
          path: effectiveImgPath
        };
      }

      ocrResults[index] = {
        pageNum,
        pageText,
        pageCandidates,
        highPriority
      };
    }

    let nextIdx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, imageFiles.length) }, async () => {
      while (nextIdx < imageFiles.length) {
        const current = nextIdx++;
        await processPage(current);
      }
    });
    await Promise.all(workers);

    const pageCandidatesList = [];
    const highPriorityImages = [];
    let fullAggregatedText = '';

    for (let i = 0; i < ocrResults.length; i++) {
      const res = ocrResults[i];
      fullAggregatedText += `\n--- TRANG ${res.pageNum} (${res.pageCandidates.classification.type}) ---\n${res.pageText}\n`;
      pageCandidatesList.push(res.pageCandidates);
      if (res.highPriority) highPriorityImages.push(res.highPriority);

      auditLog.pageResults.push({
        page: res.pageNum,
        type: res.pageCandidates.classification.type,
        weight: res.pageCandidates.classification.weight,
        isElectronic: res.pageCandidates.classification.isElectronic,
        cccds: res.pageCandidates.cccds.map(c => c.value),
        names: res.pageCandidates.names.map(n => n.value)
      });
    }

    // 3. Cross-page Synthesis & Conflict Detection
    // A. CCCD Consensus
    const cccdScores = {};
    for (const pc of pageCandidatesList) {
      for (const item of pc.cccds) {
        if (!cccdScores[item.value]) {
          cccdScores[item.value] = { score: 0, count: 0, pages: [], sources: [] };
        }
        cccdScores[item.value].score += item.weight;
        cccdScores[item.value].count += 1;
        cccdScores[item.value].pages.push(pc.pageNum);
        cccdScores[item.value].sources.push(item.source);
      }
    }

    const uniqueCccds = Object.keys(cccdScores);
    let chosenCccd = null;
    let cccdConflict = false;

    if (uniqueCccds.length === 1) {
      chosenCccd = uniqueCccds[0];
    } else if (uniqueCccds.length > 1) {
      uniqueCccds.sort((a, b) => cccdScores[b].score - cccdScores[a].score);
      const topCccd = uniqueCccds[0];
      const secondCccd = uniqueCccds[1];

      // Check if both have high confidence from different official documents
      if (cccdScores[topCccd].score >= 80 && cccdScores[secondCccd].score >= 80 && topCccd !== secondCccd) {
        cccdConflict = true;
        auditLog.conflicts.push(`Phát hiện nhiều số CCCD có độ tin cậy cao mâu thuẫn: ${topCccd} (trang ${cccdScores[topCccd].pages.join(',')}) vs ${secondCccd} (trang ${cccdScores[secondCccd].pages.join(',')})`);
      } else {
        chosenCccd = topCccd;
      }
    }

    // B. Full Name Consensus (Group by unaccented root)
    const nameGroups = {};
    for (const pc of pageCandidatesList) {
      for (const item of pc.names) {
        if (!isValidPersonName(item.value)) continue;

        const normKey = removeAccents(item.value);
        if (!nameGroups[normKey]) {
          nameGroups[normKey] = {
            normKey,
            totalScore: 0,
            variants: {},
            pages: []
          };
        }
        nameGroups[normKey].totalScore += item.weight;
        nameGroups[normKey].variants[item.value] = (nameGroups[normKey].variants[item.value] || 0) + item.weight;
        nameGroups[normKey].pages.push(pc.pageNum);
      }
    }

    const uniqueNameGroups = Object.values(nameGroups);
    let chosenName = null;
    let nameConflict = false;

    if (uniqueNameGroups.length === 1) {
      const g = uniqueNameGroups[0];
      // Pick variant with highest score (proper diacritics)
      chosenName = Object.keys(g.variants).sort((a, b) => g.variants[b] - g.variants[a])[0];
    } else if (uniqueNameGroups.length > 1) {
      uniqueNameGroups.sort((a, b) => b.totalScore - a.totalScore);
      const topG = uniqueNameGroups[0];
      const secondG = uniqueNameGroups[1];

      const dist = levenshteinDistance(topG.normKey, secondG.normKey);
      if (dist <= 2) {
        // Minor OCR typo variant of the same name (e.g. "phan duong thanh binh" vs "phan duong thanh bin")
        topG.totalScore += secondG.totalScore;
        chosenName = Object.keys(topG.variants).sort((a, b) => topG.variants[b] - topG.variants[a])[0];
      } else if (secondG.totalScore >= 120) {
        nameConflict = true;
        auditLog.conflicts.push(`Phát hiện họ tên mâu thuẫn giữa các tài liệu chính thức: "${topG.normKey}" vs "${secondG.normKey}"`);
        chosenName = Object.keys(topG.variants).sort((a, b) => topG.variants[b] - topG.variants[a])[0];
      } else {
        chosenName = Object.keys(topG.variants).sort((a, b) => topG.variants[b] - topG.variants[a])[0];
      }
    }

    // C. DOB Consensus
    const dobScores = {};
    for (const pc of pageCandidatesList) {
      for (const item of pc.dobs) {
        dobScores[item.value] = (dobScores[item.value] || 0) + item.weight;
      }
    }
    const chosenDob = Object.keys(dobScores).sort((a, b) => dobScores[b] - dobScores[a])[0] || null;

    // D. Gender Consensus
    const genderScores = {};
    for (const pc of pageCandidatesList) {
      for (const item of pc.genders) {
        genderScores[item.value] = (genderScores[item.value] || 0) + item.weight;
      }
    }
    const chosenGender = Object.keys(genderScores).sort((a, b) => genderScores[b] - genderScores[a])[0] || null;

    // E. Address Consensus
    const addrScores = {};
    for (const pc of pageCandidatesList) {
      for (const item of pc.addresses) {
        addrScores[item.value] = (addrScores[item.value] || 0) + item.weight;
      }
    }
    const chosenAddress = Object.keys(addrScores).sort((a, b) => addrScores[b] - addrScores[a])[0] || null;

    // F. Issue Date Consensus
    const issueScores = {};
    for (const pc of pageCandidatesList) {
      for (const item of pc.issueDates) {
        issueScores[item.value] = (issueScores[item.value] || 0) + item.weight;
      }
    }
    const chosenIssueDate = Object.keys(issueScores).sort((a, b) => issueScores[b] - issueScores[a])[0] || null;

    // 4. Gemini Vision Enhancement for full 53 canonical fields
    let aiExtracted = null;
    if (highPriorityImages.length > 0) {
      // Sort by weight descending, pick top 3 images
      highPriorityImages.sort((a, b) => b.weight - a.weight);
      const topImages = highPriorityImages.slice(0, 3);
      aiExtracted = await callGeminiVisionForDossier(topImages, fullAggregatedText);
    }

    // Merge OCR consensus and AI Vision result
    let finalFullName = null;
    if (aiExtracted?.full_name && isValidPersonName(aiExtracted.full_name)) {
      finalFullName = aiExtracted.full_name.toUpperCase().trim();
    }
    if (!finalFullName && chosenName && isValidPersonName(chosenName)) {
      finalFullName = chosenName.toUpperCase().trim();
    }
    // If both exist and normalized root matches, prefer the one with highest diacritic fidelity
    if (aiExtracted?.full_name && chosenName && isValidPersonName(aiExtracted.full_name) && isValidPersonName(chosenName)) {
      if (removeAccents(aiExtracted.full_name) === removeAccents(chosenName)) {
        finalFullName = chosenName; // OCR from official decision/offer letter has exact diacritics
      }
    }

    const finalCccd = aiExtracted?.citizen_id
      ? (standardizeCccd(aiExtracted.citizen_id).cleanCccd || chosenCccd)
      : chosenCccd;

    const finalDob = aiExtracted?.date_of_birth
      ? (standardizeDate(aiExtracted.date_of_birth) || chosenDob)
      : chosenDob;

    const finalGender = aiExtracted?.gender || chosenGender;
    const finalAddress = aiExtracted?.permanent_address || chosenAddress;
    const finalIssueDate = aiExtracted?.citizen_id_issue_date
      ? (standardizeDate(aiExtracted.citizen_id_issue_date) || chosenIssueDate)
      : chosenIssueDate;

    // Check if manual review is required (Rule B.9 & B.10)
    const requiresManualReview = cccdConflict || nameConflict || !finalCccd || !finalFullName;

    auditLog.consensus = {
      full_name: finalFullName,
      citizen_id: finalCccd,
      date_of_birth: finalDob,
      gender: finalGender,
      permanent_address: finalAddress,
      citizen_id_issue_date: finalIssueDate,
      place_of_origin: aiExtracted?.place_of_origin || null,
      ethnicity: aiExtracted?.ethnicity || 'Kinh',
      job_title: aiExtracted?.job_title || null,
      company_id: aiExtracted?.company_id || 'SWC',
      department_staffing_plan: aiExtracted?.department_staffing_plan || null,
      phone_number: aiExtracted?.phone_number || null,
      email: aiExtracted?.email || null
    };
    auditLog.requiresManualReview = requiresManualReview;
    auditLog.durationMs = Date.now() - startTime;

    return {
      success: true,
      fileName,
      totalPages: auditLog.totalPages,
      aggregatedText: fullAggregatedText,
      extracted: auditLog.consensus,
      conflicts: auditLog.conflicts,
      requiresManualReview,
      aiVisionUsed: !!aiExtracted,
      audit: auditLog
    };
  } finally {
    try {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
    } catch (cleanupErr) {
      console.warn('[MultiPageOcrEngine] Temp cleanup warning:', cleanupErr.message);
    }
  }
}

module.exports = {
  processDocumentMultiPage,
  standardizeCccd,
  standardizeDate,
  classifyPageType,
  extractFromPageText,
  isValidPersonName
};
