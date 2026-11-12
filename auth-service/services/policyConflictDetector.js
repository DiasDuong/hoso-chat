/**
 * SOTRANS HUB - Policy Conflict & Duplicate Governance Detection Engine (Upgraded V3)
 * 
 * Chuẩn hóa 8 nhóm kiểm soát theo Taxonomy Doanh nghiệp:
 * 1. EXACT_DUPLICATE_FILE: Trùng file hash (SHA-256) -> Chặn phê duyệt
 * 2. DUPLICATE_DOC_CODE: Trùng mã hiệu văn bản chính thức -> Chặn phê duyệt
 * 3. DUPLICATE_CONTENT: Cùng nội dung nhưng khác định dạng/scan (similarity >= 85%) -> Chặn phê duyệt
 * 4. SEMANTIC_DUPLICATE: Trùng lặp tiêu đề / chủ đề điều chỉnh xuyên Category (>= 80%) mà chưa có quan hệ -> Chặn phê duyệt
 * 5. TRUE_CONFLICT: Quy định mâu thuẫn trực tiếp trong cùng phạm vi và thời gian hiệu lực -> Chặn kích hoạt
 * 6. COMPLEMENTARY: Bổ sung thông tin cho nhau (supplements/clarifies) -> Không chặn
 * 7. AMENDMENT / SUPERSEDES: Sửa đổi hoặc thay thế văn bản cũ có quan hệ hợp lệ -> Tự động chuyển đổi hiệu lực
 * 8. EXCEPTION: Quy định ngoại lệ cho đơn vị đặc thù (exception_to) -> Không coi là xung đột
 */

const db = require('../db');

/**
 * Chuẩn hóa chuỗi tiếng Việt: Bỏ dấu, chuyển đ/Đ thành d, chuyển chữ thường
 */
function normalizeVietnamese(text) {
  if (!text) return '';
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Tách và lọc các từ khóa cốt lõi từ tiêu đề văn bản (loại bỏ stopwords và từ tiền tố)
 */
function cleanTitleTokens(title) {
  if (!title) return [];
  const norm = normalizeVietnamese(title).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const stopwords = new Set([
    'quy', 'che', 'chinh', 'sach', 'dinh', 'noi', 'huong', 'dan', 'thong', 'tu', 'quyet',
    've', 'viec', 'ban', 'hanh', 'so', 'nam', 'sotrans', 'tap', 'doan', 'cong', 'ty',
    'dung', 'dieu', 'khoan', 'thuc', 'hien', 'quan', 'muc', 'cac', 'nhung', 'theo',
    'trong', 'ngoai', 'chung', 'rieng', 'tong', 'thoi', 'gian', 'ngay', 'thang', 'van',
    'nhan', 'vien', 'can', 'bo', 'ap', 'su', 'tuc', 'cap', 'nhat', 'kiem', 'tra', 'thu', 'nghiem', 'sung'
  ]);
  return norm.split(' ').filter(w => w.length > 2 && !stopwords.has(w) && !/^\d+$/.test(w));
}

/**
 * Tính toán độ tương đồng tiêu đề (Cross-Category Title Similarity)
 * Trả về giá trị từ 0.0 đến 1.0
 */
function calculateTitleSimilarity(titleA, titleB) {
  if (!titleA || !titleB) return 0;
  const normA = normalizeVietnamese(titleA).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const normB = normalizeVietnamese(titleB).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normA === normB) return 1.0;

  const tokensA = cleanTitleTokens(titleA);
  const tokensB = cleanTitleTokens(titleB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersect = 0;
  for (const t of setA) {
    if (setB.has(t)) intersect++;
  }
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union > 0 ? (intersect / union) : 0;

  // Nếu một bên chứa trọn vẹn toàn bộ các từ cốt lõi của bên kia và tỉ lệ trùng >= 75%
  const isSubset = (tokensA.length >= 2 && tokensA.every(t => setB.has(t))) ||
                   (tokensB.length >= 2 && tokensB.every(t => setA.has(t)));

  if (isSubset && jaccard >= 0.6) return Math.max(jaccard, 0.85);

  return jaccard;
}

/**
 * Tính toán độ trùng khớp nội dung văn bản qua 3-word shingles (N-gram content fingerprint)
 * Trả về giá trị từ 0.0 đến 1.0
 */
function calculateContentSimilarity(textA, textB) {
  if (!textA || !textB) return 0;
  const strA = normalizeVietnamese(textA).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const strB = normalizeVietnamese(textB).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (strA === strB && strA.length > 20) return 1.0;
  if (strA.length < 50 || strB.length < 50) return 0;

  const wordsA = strA.split(' ').filter(w => w.length > 1);
  const wordsB = strB.split(' ').filter(w => w.length > 1);
  if (wordsA.length < 5 || wordsB.length < 5) return 0;

  const shinglesA = new Set();
  for (let i = 0; i <= wordsA.length - 3; i++) {
    shinglesA.add(wordsA[i] + ' ' + wordsA[i+1] + ' ' + wordsA[i+2]);
  }
  const shinglesB = new Set();
  for (let i = 0; i <= wordsB.length - 3; i++) {
    shinglesB.add(wordsB[i] + ' ' + wordsB[i+1] + ' ' + wordsB[i+2]);
  }

  let intersect = 0;
  for (const s of shinglesA) {
    if (shinglesB.has(s)) intersect++;
  }
  const union = new Set([...shinglesA, ...shinglesB]).size;
  return union > 0 ? (intersect / union) : 0;
}

/**
 * Kiểm tra xem một mảng scope có phải là "Toàn bộ" (all) hay không
 */
function isAllScope(scope) {
  if (!scope) return true;
  if (!Array.isArray(scope)) return scope === 'all' || scope === '{all}';
  if (scope.length === 0) return true;
  return scope.includes('all') || scope.includes('{all}');
}

/**
 * Lấy danh sách phần tử scope đã được làm sạch
 */
function cleanScopeList(scope) {
  if (isAllScope(scope)) return ['all'];
  return scope.map(s => String(s).trim()).filter(Boolean);
}

/**
 * Kiểm tra xem 2 mảng scope có giao thoa không
 * Quy ước: '{all}' giao thoa với mọi scope khác
 */
function isScopeOverlapping(scopeA, scopeB) {
  if (isAllScope(scopeA) || isAllScope(scopeB)) return true;
  const listA = cleanScopeList(scopeA);
  const listB = cleanScopeList(scopeB);
  return listA.some(item => listB.includes(item));
}

/**
 * Kiểm tra xem scopeA có hẹp hơn (là tập con thực sự của) scopeB hay không
 */
function isNarrowerScope(scopeA, scopeB) {
  const isAllA = isAllScope(scopeA);
  const isAllB = isAllScope(scopeB);

  if (!isAllA && isAllB) return true;
  if (isAllA && !isAllB) return false;
  if (isAllA && isAllB) return false;

  const listA = cleanScopeList(scopeA);
  const listB = cleanScopeList(scopeB);

  const isSubset = listA.every(item => listB.includes(item));
  const isStrictlySmaller = listA.length < listB.length;

  return isSubset && isStrictlySmaller;
}

/**
 * Kiểm tra xem 2 scope có trùng khớp hoàn toàn (cùng tập hợp) hay không
 */
function isIdenticalScope(scopeA, scopeB) {
  const arrA = cleanScopeList(scopeA);
  const arrB = cleanScopeList(scopeB);

  if (arrA.includes('all') && arrB.includes('all')) return true;
  if (arrA.includes('all') || arrB.includes('all')) return false;
  if (arrA.length !== arrB.length) return false;
  return arrA.every(item => arrB.includes(item));
}

/**
 * Kiểm tra 2 khoảng thời gian hiệu lực có giao thoa không
 */
function isDateRangeOverlapping(startA, endA, startB, endB) {
  const sA = startA ? new Date(startA).getTime() : 0;
  const eA = endA ? new Date(endA).getTime() : 253402300799000; // year 9999
  const sB = startB ? new Date(startB).getTime() : 0;
  const eB = endB ? new Date(endB).getTime() : 253402300799000;

  return sA <= eB && sB <= eA;
}

/**
 * Trích xuất chủ đề chính từ văn bản dựa trên từ khóa cốt lõi và nội dung
 * @param {string} text Toàn bộ nội dung hoặc trích đoạn
 * @param {string} [title=''] Tiêu đề văn bản (chỉ trích xuất token từ khóa từ tiêu đề)
 */
function extractCoreTopics(text, title = '') {
  if (!text && !title) return [];
  const norm = normalizeVietnamese(`${text} ${title}`);

  const topics = [];

  // 1. Giờ làm việc & ca kíp
  if (/thoi\s*gio\s*lam\s*viec|gio\s*lam\s*viec|khung\s*gio|ca\s*kip|nghi\s*trua|flexitime|check-in|gio\s*giac/.test(norm)) {
    topics.push('thoi_gio_lam_viec');
  }

  // 2. Làm việc từ xa (WFH/Remote)
  if (/lam\s*viec\s*tu\s*xa|remote|wfh|hybrid/.test(norm)) {
    topics.push('lam_viec_tu_xa');
  }

  // 3. Chế độ nghỉ phép
  if (/phep\s*nam|nghi\s*phep|nghi\s*bu|nghi\s*om|thai\s*san|che\s*do\s*nghi/.test(norm)) {
    topics.push('che_do_nghi_phep');
  }

  // 4. Phụ cấp & Công tác phí
  if (/phu\s*cap|cong\s*tac\s*phi|luu\s*dong|cong\s*truong|spmt|sieu\s*truong|tien\s*an|xang\s*xe|dien\s*thoai/.test(norm)) {
    topics.push('phu_cap_cong_tac_phi');
  }

  // 5. An toàn kho cảng & Cổng kiểm soát
  if (/an\s*ninh\s*kho\s*cang|kiem\s*soat\s*cong|tuan\s*tra\s*ben\s*bai|an\s*ninh\s*cang|the\s*ra\s*vao\s*cang|cong\s*cang|kho\s*bai\s*cang|ben\s*bai\s*cang|kho\s*cang/.test(norm)) {
    topics.push('an_ninh_kho_cang');
  }

  // 6. Phòng cháy chữa cháy & Cứu nạn
  if (/pccc|phong\s*chay|chua\s*chay|cuu\s*nan|cuu\s*ho|thiet\s*bi\s*pccc|binh\s*chua\s*chay|tieu\s*lenh/.test(norm)) {
    topics.push('an_toan_pccc');
  }

  // 7. An toàn lao động & PPE
  if (/an\s*toan\s*lao\s*dong|bao\s*ho\s*lao\s*dong|trang\s*bi\s*bao\s*ho|ppe|tai\s*nan\s*lao\s*dong|ve\s*sinh\s*lao\s*dong|mu\s*bao\s*ho|giay\s*bao\s*ho/.test(norm)) {
    topics.push('an_toan_lao_dong');
  }

  // 8. An toàn giao thông & Cơ giới
  if (/an\s*toan\s*giao\s*thong|phuong\s*tien|xe\s*nang|xe\s*cau|toc\s*do\s*trong\s*cang|luong\s*giao\s*thong/.test(norm)) {
    topics.push('an_toan_giao_thong');
  }

  // 9. An toàn thông tin & An ninh mạng
  if (/an\s*toan\s*thong\s*tin|bao\s*mat\s*thong\s*tin|an\s*ninh\s*mang|ma\s*nguon|tai\s*khoan\s*he\s*thong|ro\s*ri\s*du\s*lieu|it\s*security|cyber\s*security/.test(norm)) {
    topics.push('an_toan_thong_tin');
  }

  // 10. Chuyển đổi số & Công nghệ
  if (/chuyen\s*doi\s*so|dxm|digital\s*transformation|phan\s*mem|he\s*thong\s*cntt|so\s*hoa|it\s*policy|sang\s*kien\s*so|cong\s*nghe\s*so/.test(norm)) {
    topics.push('chuyen_doi_so');
  }

  // 11. Khen thưởng & Kỷ luật lao động (Chỉ nhận diện kỷ luật nhân sự thực thụ, không nhầm với vi phạm an toàn/kho)
  if (/(?:khen\s*thuong\s*ky\s*luat|ky\s*luat\s*lao\s*dong|hoi\s*dong\s*ky\s*luat|xu\s*ly\s*ky\s*luat|hinh\s*thuc\s*ky\s*luat|khien\s*trach|sa\s*thai|dinh\s*chi\s*cong\s*tac|che\s*tai\s*di\s*muon|vi\s*pham\s*noi\s*quy\s*lao\s*dong|xu\s*ly\s*vi\s*pham\s*lao\s*dong)/.test(norm)) {
    topics.push('ky_luat_lao_dong');
  }

  // 12. Văn phòng trụ sở
  if (/van\s*phong\s*tru\s*so|tru\s*so\s*chinh|co\s*so\s*vat\s*chat|tai\s*san\s*van\s*phong/.test(norm)) {
    topics.push('van_phong_tru_so');
  }

  // Tự động bổ sung các từ khóa cốt lõi có tần suất/ý nghĩa cao CHỈ từ TIÊU ĐỀ
  const titleText = title || (text && text.length <= 150 ? text : '');
  const titleTokens = cleanTitleTokens(titleText);
  for (const token of titleTokens) {
    if (token.length >= 4 && !topics.includes(token)) {
      topics.push(token);
    }
  }

  return topics;
}

/**
 * Trích xuất hồ sơ đối tượng nhân sự áp dụng từ văn bản
 * Hỗ trợ 6 nhóm chuẩn hóa: DIGITAL_TECH, OPERATIONS_WAREHOUSE, OFFICE_GENERAL, HEAVY_TRANSPORT_PROJECT, COMPANY_WIDE, UNSPECIFIED
 * Nhận diện điều khoản mở rộng, điều kiện đăng ký và trường hợp loại trừ
 */
function extractAudienceProfile(text) {
  if (!text) return { profiles: ['UNSPECIFIED'], hasFlexibleRegistration: false, hasExclusions: false, hasSpecialCondition: false, rawMatches: [] };
  const norm = normalizeVietnamese(text);
  const profiles = [];
  const rawMatches = [];

  // Tách câu khẳng định áp dụng và câu loại trừ để tránh nhầm lẫn giữa đối tượng thụ hưởng và đối tượng bị loại trừ
  const sentences = norm.split(/[.\n;]/);
  let affirmativeText = '';
  let excludedText = '';

  for (const s of sentences) {
    if (/khong\s*ap\s*dung|loai\s*tru|ngoai\s*tru|khong\s*bao\s*gom|tuyet\s*doi\s*khong/.test(s)) {
      excludedText += ' ' + s;
    } else {
      affirmativeText += ' ' + s;
    }
  }

  // 1. Nhóm Công nghệ & Chuyển đổi số & Nhân sự số (Digital / Tech / Agile Office)
  const isDigitalTech = /\b(chuyen\s*doi\s*so|nhan\s*su\s*so|cong\s*nghe|cntt|developer|lap\s*trinh|khoi\s*cong\s*nghe|phan\s*mem|output-based)\b/.test(affirmativeText);
  if (isDigitalTech) {
    profiles.push('DIGITAL_TECH');
    rawMatches.push('Bộ phận Chuyển đổi số, Công nghệ & Nhân sự số');
  }

  // 2. Nhóm Vận hành, Hiện trường, Kho bãi & Cơ giới (Tránh nhầm với "vận hành linh hoạt")
  const isOperationsField = /nhan\s*vien\s*van\s*hanh|cong\s*nhan\s*van\s*hanh|van\s*hanh\s*kho|van\s*hanh\s*ben|kho\s*van|kho\s*bai|thu\s*kho|lai\s*xe|tai\s*xe|xe\s*nang|co\s*gioi|ky\s*thuat\s*co\s*gioi|dieu\s*do|cfs|cang\s*can|hien\s*truong|giao\s*nhan|cong\s*truong/.test(affirmativeText);
  if (isOperationsField) {
    profiles.push('OPERATIONS_WAREHOUSE');
    rawMatches.push('Khối Vận hành, Kho bãi, Bến cảng & Kỹ thuật cơ giới');
  }

  // 3. Nhóm Văn phòng Trụ sở chung
  const isOffice = /nhan\s*vien\s*van\s*phong|khoi\s*van\s*phong|can\s*bo\s*nhan\s*vien\s*van\s*phong|can\s*bo\s*khoi\s*van\s*phong|hanh\s*chinh\s*tong\s*hop|phap\s*che|ke\s*toan|tru\s*so\s*chinh/.test(affirmativeText) && !isOperationsField;
  if (isOffice && !isDigitalTech) {
    profiles.push('OFFICE_GENERAL');
    rawMatches.push('Khối Văn phòng Trụ sở');
  }

  // 4. Nhóm Dự án Siêu trường Siêu trọng
  const isHeavyTransport = /spmt|sieu\s*truong|sieu\s*trong|chuyen\s*gia\s*du\s*an|ky\s*su\s*cong\s*truong|to\s*doi\s*spmt/.test(affirmativeText);
  if (isHeavyTransport) {
    profiles.push('HEAVY_TRANSPORT_PROJECT');
    rawMatches.push('Dự án Siêu trường Siêu trọng Vietranstimex');
  }

  // 5. Toàn thể công ty khi không giới hạn nhóm cụ thể
  const isCompanyWide = /toan\s*the\s*can\s*bo|toan\s*the\s*nhan\s*vien|toan\s*bo\s*nhan\s*vien|tat\s*ca\s*nguoi\s*lao\s*dong|tat\s*ca\s*nhan\s*su|toan\s*tap\s*doan|toan\s*cong\s*ty|can\s*bo\s*nhan\s*vien/.test(affirmativeText);
  if (isCompanyWide && profiles.length === 0) {
    profiles.push('COMPANY_WIDE');
    rawMatches.push('Toàn thể Cán bộ Nhân viên Tập đoàn');
  }

  // Khả năng mở rộng / Đăng ký linh hoạt
  const hasFlexibleRegistration = /dang\s*ky\s*van\s*hanh\s*linh\s*hoat|dang\s*ky\s*lam\s*viec\s*linh\s*hoat|ap\s*dung\s*cho\s*cac\s*don\s*vi\s*dang\s*ky/.test(norm);

  // Điều khoản loại trừ
  const hasExclusions = /khong\s*ap\s*dung|loai\s*tru|ngoai\s*tru|khong\s*bao\s*gom|tuyet\s*doi\s*khong/.test(norm);

  // Điều kiện khẩn cấp / tình huống đặc thù
  const hasSpecialCondition = /truong\s*hop\s*khan\s*cap|tinh\s*huong\s*dac\s*biet|thoi\s*gian\s*cao\s*diem|khi\s*co\s*yeu\s*cau\s*dot\s*xuat|du\s*an\s*dac\s*thu|thien\s*tai|bao\s*lu/.test(norm);

  return {
    profiles: profiles.length ? profiles : ['UNSPECIFIED'],
    hasFlexibleRegistration,
    hasExclusions,
    hasSpecialCondition,
    rawMatches: rawMatches.length ? rawMatches : ['Chưa xác định rõ nhóm nhân sự']
  };
}

/**
 * Trích xuất trích dẫn liên quan đến đối tượng và điều khoản chính (Verbatim Quotes)
 */
function extractKeyExcerpts(text, docTitle = '') {
  if (!text) return { audienceExcerpt: docTitle || 'N/A', ruleExcerpt: '', verbatimQuote: docTitle || 'N/A' };
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let audienceExcerpt = '';
  let ruleExcerpt = '';

  for (const line of lines) {
    const norm = normalizeVietnamese(line);
    if (!audienceExcerpt && /doi\s*tuong|pham\s*vi|ap\s*dung|muc\s*tieu\s*thu\s*nghiem/.test(norm)) {
      audienceExcerpt = line.replace(/\t+/g, ' ').trim();
      if (audienceExcerpt.length > 250) audienceExcerpt = audienceExcerpt.substring(0, 250) + '...';
    }
    if (!ruleExcerpt && /khung\s*gio|gio\s*lam\s*viec|thoi\s*gio|flexitime|ca\s*kip|wfh|remote|thu\s*viec|phep\s*nam/.test(norm)) {
      ruleExcerpt = line.replace(/\t+/g, ' ').trim();
      if (ruleExcerpt.length > 250) ruleExcerpt = ruleExcerpt.substring(0, 250) + '...';
    }
  }

  const parts = [];
  if (audienceExcerpt) parts.push(audienceExcerpt);
  if (ruleExcerpt && ruleExcerpt !== audienceExcerpt) parts.push(ruleExcerpt);
  const verbatimQuote = parts.join(' | ') || docTitle || 'N/A';

  return {
    audienceExcerpt: audienceExcerpt || docTitle,
    ruleExcerpt: ruleExcerpt || '',
    verbatimQuote
  };
}

/**
 * Trích xuất và phát hiện mâu thuẫn quy phạm thực tế (Substantive Rule Delta & Modality Opposition)
 * Phục vụ mô hình Dual-Evidence Model loại bỏ triệt để False Positive
 * @param {Object} candidate Thông tin văn bản mới
 * @param {Object} doc Thông tin văn bản hiện hành trong DB
 * @param {Array<string>} commonTopics Các chủ đề giao thoa
 * @returns {Array<Object>|null} Danh sách các điểm mâu thuẫn quy phạm thực tế (nếu có)
 */
function detectSubstantiveRuleDelta(candidate, doc, commonTopics = []) {
  const candText = normalizeVietnamese(`${candidate.title || ''} ${candidate.content || ''}`);
  const docText = normalizeVietnamese(`${doc.title || ''} ${doc.change_summary || ''} ${doc.chunk_content || ''}`);

  // Trích xuất đối tượng nhân viên áp dụng (audience profiles)
  const audA = extractAudienceProfile(candText);
  const audB = extractAudienceProfile(docText);

  const sharedProfiles = audA.profiles.filter(p => audB.profiles.includes(p));
  const isDivergentAudience = sharedProfiles.length === 0 &&
    !audA.profiles.includes('COMPANY_WIDE') && !audB.profiles.includes('COMPANY_WIDE') &&
    !audA.profiles.includes('UNSPECIFIED') && !audB.profiles.includes('UNSPECIFIED');

  // Điều kiện khẩn cấp vs thường nhật
  const isConditionalException = audA.hasSpecialCondition && !audB.hasSpecialCondition;

  const deltas = [];

  // 1. Đối kháng về Giờ làm việc & Khung giờ Check-in / Thời lượng
  const candHasFlexitime = /flexitime|gio\s*check-?in\s*linh\s*hoat|linh\s*hoat\s*tu\s*0?8|gio\s*lam\s*viec\s*linh\s*hoat|35\s*gio\s*\/\s*tuan|35\s*gio\s*tuan|40\s*gio\s*\/\s*tuan|nghi\s*trua\s*tu\s*do/.test(candText);
  const docHasFixedHours = /gio\s*lam\s*viec\s*co\s*dinh|co\s*dinh\s*tu\s*0?8|bat\s*buoc\s*co\s*mat|khong\s*ap\s*dung\s*linh\s*hoat|48\s*gio\s*\/\s*tuan|48\s*gio\s*tuan|07\s*[:h]\s*30|thu\s*hai\s*den\s*thu\s*bay/.test(docText);

  const candHasFixedHours = /gio\s*lam\s*viec\s*co\s*dinh|co\s*dinh\s*tu\s*0?8|bat\s*buoc\s*co\s*mat|48\s*gio\s*\/\s*tuan|48\s*gio\s*tuan|07\s*[:h]\s*30/.test(candText);
  const docHasFlexitime = /flexitime|gio\s*check-?in\s*linh\s*hoat|linh\s*hoat\s*tu\s*0?8|35\s*gio\s*\/\s*tuan|35\s*gio\s*tuan|nghi\s*trua\s*tu\s*do/.test(docText);

  if (!isDivergentAudience && !isConditionalException) {
    if ((candHasFlexitime && docHasFixedHours) || (candHasFixedHours && docHasFlexitime)) {
      deltas.push({
        dimension: 'WORKING_HOURS_MODALITY',
        description: 'Mâu thuẫn về quy chuẩn giờ làm việc (Giờ linh hoạt / Flexitime đối lập với Giờ cố định bắt buộc).'
      });
    }

    // Đối kháng về định mức thời giờ làm việc tuần (48 giờ/tuần vs 35/40/44 giờ/tuần)
    const cand48h = /48\s*gio/.test(candText);
    const docReducedH = /(?:35|40|44)\s*gio/.test(docText);
    const candReducedH = /(?:35|40|44)\s*gio/.test(candText);
    const doc48h = /48\s*gio/.test(docText);
    if ((cand48h && docReducedH) || (candReducedH && doc48h)) {
      deltas.push({
        dimension: 'WORKING_HOURS_DURATION_CONFLICT',
        description: 'Mâu thuẫn trực tiếp về định mức thời giờ làm việc tuần (48 giờ/tuần đối lập với giờ làm rút gọn 35-44 giờ/tuần).'
      });
    }

    // Đối kháng về mức phụ cấp ăn trưa
    const candMealMatch = candText.match(/phu\s*cap\s*an\s*trua.*?(\d+[\d\.]*)\s*(?:vnd|dong)?/i);
    const docMealMatch = docText.match(/phu\s*cap\s*an\s*trua.*?(\d+[\d\.]*)\s*(?:vnd|dong)?/i);
    if (candMealMatch && docMealMatch) {
      const valA = candMealMatch[1].replace(/\./g, '');
      const valB = docMealMatch[1].replace(/\./g, '');
      if (valA !== valB) {
        deltas.push({
          dimension: 'MEAL_ALLOWANCE_AMOUNT_CONFLICT',
          description: `Mâu thuẫn trực tiếp về mức phụ cấp ăn trưa (${candMealMatch[1]} VNĐ đối lập với ${docMealMatch[1]} VNĐ).`
        });
      }
    }

    // Đối kháng về chính sách an toàn thông tin thiết bị ngoại vi (USB)
    const candPermitUsb = /(cho\s*phep|duoc\s*phep|tu\s*do).*su\s*dung\s*usb/i.test(candText);
    const docForbidUsb = /(nghiem\s*cam|cam|khong\s*duoc).*su\s*dung\s*usb/i.test(docText);
    const candForbidUsb = /(nghiem\s*cam|cam|khong\s*duoc).*su\s*dung\s*usb/i.test(candText);
    const docPermitUsb = /(cho\s*phep|duoc\s*phep|tu\s*do).*su\s*dung\s*usb/i.test(docText);
    if ((candPermitUsb && docForbidUsb) || (candForbidUsb && docPermitUsb)) {
      deltas.push({
        dimension: 'SECURITY_USB_POLICY_CONFLICT',
        description: 'Mâu thuẫn trực tiếp về chính sách an toàn thông tin thiết bị ngoại vi (Cho phép sử dụng USB đối lập với Cấm sử dụng USB).'
      });
    }

    // Đối kháng về thẩm quyền phê duyệt nghỉ phép
    const candUnapprovedLeave = /(tu\s*do\s*nghi|nghi.*khong\s*can.*phe\s*duyet)/i.test(candText);
    if (candUnapprovedLeave) {
      deltas.push({
        dimension: 'LEAVE_APPROVAL_AUTHORITY_CONFLICT',
        description: 'Mâu thuẫn về thẩm quyền phê duyệt nghỉ phép (Nghỉ việc tự do không cần phê duyệt đối kháng với quy chế quản trị nhân sự).'
      });
    }
  }

  // 2. Đối kháng về Kỷ luật đi muộn & Chế tài
  const candAbolishesPenalty = /bai\s*bo.*che\s*tai\s*phat\s*di\s*muon|bai\s*bo.*phat\s*tien\s*di\s*tre|khong\s*phat\s*tien|output-based|danh\s*gia\s*hieu\s*suat.*khong\s*phat/.test(candText);
  const docEnforcesPenalty = /phat\s*tien|tru\s*20%\s*diem\s*kpi|che\s*tai\s*di\s*muon|hoi\s*dong\s*ky\s*luat.*khien\s*trach|xu\s*ly\s*ky\s*luat.*di\s*tre|khau\s*tru.*ngay\s*cong/.test(docText);

  const candEnforcesPenalty = /phat\s*tien|tru\s*20%\s*diem\s*kpi|che\s*tai\s*di\s*muon|phat.*di\s*muon|khau\s*tru.*ngay\s*cong/.test(candText);
  const docAbolishesPenalty = /bai\s*bo.*che\s*tai\s*phat\s*di\s*muon|bai\s*bo.*phat\s*tien\s*di\s*tre|output-based/.test(docText);

  if (!isDivergentAudience && !isConditionalException) {
    if ((candAbolishesPenalty && docEnforcesPenalty) || (candEnforcesPenalty && docAbolishesPenalty)) {
      deltas.push({
        dimension: 'PENALTY_POLICY_OPPOSITION',
        description: 'Mâu thuẫn trực tiếp về chế tài xử lý đi muộn (Một văn bản bãi bỏ chế tài phạt đi muộn trong khi văn bản kia duy trì xử phạt/trừ KPI).'
      });
    }
  }

  // 3. Đối kháng về Làm việc từ xa (WFH) & Địa điểm làm việc
  const candUnlimitedWfh = /remote\s*khong\s*gioi\s*han|wfh\s*khong\s*gioi\s*han|lam\s*viec\s*tu\s*xa\s*tu\s*do|cho\s*phep\s*wfh\s*toan\s*thoi\s*gian|(cho\s*phep|duoc\s*phep).*lam\s*viec\s*tu\s*xa|wfh\s*100%|lam\s*viec\s*tu\s*xa.*100%/.test(candText);
  const docRestrictsWfh = /bat\s*buoc\s*tai\s*van\s*phong|khong\s*ap\s*dung\s*wfh|toi\s*da\s*0?1\s*ngay\s*wfh|nghiem\s*cam.*lam\s*viec\s*tu\s*xa|nghiem\s*cam.*wfh|bat\s*buoc.*hien\s*dien\s*truc\s*tiep/.test(docText);

  const candRestrictsWfh = /bat\s*buoc\s*tai\s*van\s*phong|khong\s*ap\s*dung\s*wfh|nghiem\s*cam.*lam\s*viec\s*tu\s*xa|nghiem\s*cam.*wfh|bat\s*buoc.*hien\s*dien\s*truc\s*tiep/.test(candText);
  const docUnlimitedWfh = /remote\s*khong\s*gioi\s*han|wfh\s*khong\s*gioi\s*han|(cho\s*phep|duoc\s*phep).*lam\s*viec\s*tu\s*xa|wfh\s*100%|lam\s*viec\s*tu\s*xa.*100%/.test(docText);

  if (!isDivergentAudience && !isConditionalException) {
    if ((candUnlimitedWfh && docRestrictsWfh) || (candRestrictsWfh && docUnlimitedWfh)) {
      deltas.push({
        dimension: 'REMOTE_WORK_OPPOSITION',
        description: 'Mâu thuẫn về chính sách làm việc từ xa (Một văn bản cho phép WFH không giới hạn trong khi văn bản kia bắt buộc hiện diện trực tiếp hoặc cấm WFH).'
      });
    }
  }

  // 4. Đối kháng về Mức hưởng Nghỉ phép & Lương tháng 13
  const candLeave15 = /nghi\s*phep\s*nam\s*15\s*ngay/.test(candText);
  const docLeave12 = /nghi\s*phep\s*nam\s*(12|14)\s*ngay/.test(docText);
  if (!isDivergentAudience && !isConditionalException && candLeave15 && docLeave12) {
    deltas.push({
      dimension: 'ANNUAL_LEAVE_DELTA',
      description: 'Mâu thuẫn về định ngạch nghỉ phép năm (15 ngày/năm đối lập với 12 hoặc 14 ngày/năm).'
    });
  }

  const candThirteen15 = /luong\s*thang\s*13.*1\.5\s*thang/.test(candText);
  const docThirteen10 = /luong\s*thang\s*13.*1\.0\s*thang/.test(docText);
  if (!isDivergentAudience && !isConditionalException && candThirteen15 && docThirteen10) {
    deltas.push({
      dimension: 'BONUS_THIRTEENTH_DELTA',
      description: 'Mâu thuẫn về cam kết lương tháng 13 (Tối thiểu 1.5 tháng đối lập với 1.0 tháng).'
    });
  }

  // 5. Đối kháng về Thời gian thử việc
  const candProbation1m = /thu\s*viec.*0?1\s*thang\s*duy\s*nhat/.test(candText);
  const docProbation2m = /thu\s*viec.*0?2\s*thang/.test(docText);
  if (!isDivergentAudience && !isConditionalException && candProbation1m && docProbation2m) {
    deltas.push({
      dimension: 'PROBATION_PERIOD_DELTA',
      description: 'Mâu thuẫn về thời gian thử việc tối đa (01 tháng đối lập với 02 tháng).'
    });
  }

  // 6. Đối kháng Modality tổng quát
  const abolishingKeywords = ['bai bo', 'khong ap dung', 'mien tru', 'duoc phep', 'khong gioi han', 'tu do', 'linh hoat'];
  const restrictingKeywords = ['bat buoc', 'nghiem cam', 'khong duoc phep', 'co dinh', 'phat tien', 'che tai', 'tieu chuan'];

  const candHasAbolishing = abolishingKeywords.some(k => candText.includes(k));
  const docHasRestricting = restrictingKeywords.some(k => docText.includes(k));
  const candHasRestricting = restrictingKeywords.some(k => candText.includes(k));
  const docHasAbolishing = abolishingKeywords.some(k => docText.includes(k));

  if (!isDivergentAudience && !isConditionalException && commonTopics.length >= 1 && ((candHasAbolishing && docHasRestricting) || (candHasRestricting && docHasAbolishing))) {
    if (deltas.length === 0) {
      const shared = audA.profiles.filter(p => audB.profiles.includes(p));
      const hasShared = shared.length > 0 && !shared.includes('COMPANY_WIDE') && !shared.includes('UNSPECIFIED');
      deltas.push({
        dimension: 'POTENTIAL_MODALITY_VARIATION',
        is_potential: true,
        description: hasShared
          ? `Ghi nhận khác biệt tính chất quy phạm (Modality) trên cùng nhóm đối tượng [${shared.join(', ')}] thuộc chủ đề: ${commonTopics.join(', ')}. Cần đối chiếu ngữ cảnh điều khoản cụ thể.`
          : `Ghi nhận khác biệt tính chất quy phạm (Modality) giữa hai văn bản thuộc chủ đề: ${commonTopics.join(', ')}. Cần đối chiếu ngữ cảnh điều khoản và nhóm đối tượng áp dụng.`
      });
    }
  }

  return deltas.length > 0 ? deltas : null;
}

// -------------------------------------------------------------
// CANONICAL CLASSIFICATION V2 & SHADOW AUDIT ENGINE
// -------------------------------------------------------------
const CANONICAL_CLASSIFICATIONS_V2 = [
  'EXACT_DUPLICATE',
  'IDENTIFIER_DUPLICATE',
  'CONTENT_OVERLAP',
  'COMPLEMENTARY',
  'AMENDMENT',
  'SUPERSESSION',
  'POTENTIAL_CONFLICT',
  'CONFIRMED_CONFLICT',
  'UNKNOWN'
];

const CLASSIFICATION_SEVERITY_HIERARCHY = {
  EXACT_DUPLICATE: 90,
  IDENTIFIER_DUPLICATE: 85,
  CONFIRMED_CONFLICT: 80,
  UNKNOWN: 75,
  CONTENT_OVERLAP: 70,
  POTENTIAL_CONFLICT: 60,
  AMENDMENT: 30,
  SUPERSESSION: 20,
  COMPLEMENTARY: 10
};

function mapToCanonicalClassification(type, relationType = null) {
  if (['EXACT_DUPLICATE_FILE', 'EXACT_DUPLICATE'].includes(type)) return 'EXACT_DUPLICATE';
  if (['DUPLICATE_DOC_CODE', 'IDENTIFIER_DUPLICATE'].includes(type)) return 'IDENTIFIER_DUPLICATE';
  if (['DUPLICATE_CONTENT', 'SEMANTIC_DUPLICATE', 'CONTENT_OVERLAP'].includes(type)) return 'CONTENT_OVERLAP';
  if (['TRUE_CONFLICT', 'CONFIRMED_CONFLICT', 'REVERSE_SUPERSEDES_CONFLICT', 'INVALID_EXCEPTION_SCOPE', 'AMENDS_CLAUSE_SCOPE_REQUIRED'].includes(type)) return 'CONFIRMED_CONFLICT';
  if (['POTENTIAL_CONFLICT'].includes(type)) return 'POTENTIAL_CONFLICT';
  if (['INSUFFICIENT_EVIDENCE', 'UNKNOWN', 'SUPERSEDES_EVIDENCE_UNVERIFIED'].includes(type)) return 'UNKNOWN';
  if (relationType === 'supersedes' || type === 'SUPERSESSION') return 'SUPERSESSION';
  if (relationType === 'amends' || type === 'AMENDMENT') return 'AMENDMENT';
  if (['COMPATIBLE_COEXISTING', 'COMPLEMENTARY'].includes(type) || ['supplements', 'clarifies', 'applies_with', 'exception_to'].includes(relationType)) {
    return 'COMPLEMENTARY';
  }
  return 'UNKNOWN';
}

function dispatchShadowAudit(candidate, report, durationMs) {
  setImmediate(() => {
    try {
      const fs = require('fs');
      const path = require('path');
      const logDir = path.resolve(__dirname, '../storage/logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logFile = path.join(logDir, 'shadow_conflict_audit.jsonl');
      const entry = {
        timestamp: new Date().toISOString(),
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'candidate',
        candidate_title: candidate.title,
        status_badge: report.status_badge,
        primary_classification: report.primary_classification_v2 || 'COMPATIBLE',
        classifications: report.classifications_v2 || [],
        has_conflict: report.has_conflict,
        total_scanned: report.total_scanned_docs || 0,
        blocking_count: report.blocking_conflicts ? report.blocking_conflicts.length : 0,
        conflict_count: report.conflict_count || 0,
        duration_ms: durationMs
      };
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      console.warn('[SHADOW AUDIT WARN]:', e.message);
    }
  });
}

/**
 * Động cơ phát hiện xung đột và trùng lặp chính sách cho một tài liệu ứng viên
 * @param {Object} candidate Thông tin văn bản cần kiểm tra
 * @param {Object} [options] Tùy chọn kiểm tra (isApprovalGate, checkActiveOnly)
 * @returns {Promise<Object>} Báo cáo kết quả phân tích xung đột và trùng lặp
 */
async function detectPolicyConflicts(candidate, options = {}) {
  const {
    doc_version_id,
    document_family_id,
    doc_code,
    doc_number,
    title = '',
    category = 'CHINH_SACH',
    content = '',
    branch_scope = ['all'],
    department_scope = ['all'],
    business_unit_scope = ['all'],
    location_scope = ['all'],
    employee_group_scope = ['all'],
    effective_date,
    expiry_date,
    file_sha256,
    sha256
  } = candidate;

  const startTime = Date.now();

  // 0. Kiểm tra tính khả dụng của nội dung văn bản mới
  const rawContent = (content || candidate.change_summary || '').trim();
  const isCandidateContentMissing = rawContent.length < 40;

  if (isCandidateContentMissing) {
    const report = {
      success: true,
      status_badge: 'UNKNOWN',
      status_label: 'Thiếu dữ liệu nội dung đối soát (Fail-Closed)',
      classification_v2: 'UNKNOWN',
      primary_classification_v2: 'UNKNOWN',
      classifications_v2: ['UNKNOWN'],
      has_conflict: true, // FAIL-CLOSED: Chặn duyệt trực tiếp khi dữ liệu UNKNOWN
      has_warning: true,
      total_scanned_docs: 0,
      conflict_count: 1,
      compatible_count: 0,
      blocking_conflicts: [{
        severity: 'HIGH',
        type: 'INSUFFICIENT_EVIDENCE',
        classification_v2: 'UNKNOWN',
        target_doc_code: 'ALL',
        target_title: 'Chưa có nội dung văn bản mới',
        message: 'Văn bản dự thảo chưa có nội dung văn bản để thực hiện đối soát quy chuẩn với các quy chế đang áp dụng. Vui lòng đính kèm tệp tin hợp lệ hoặc hoàn tất trích xuất trước khi gửi duyệt.',
        suggested_action: 'Đính kèm tệp tin văn bản đầy đủ ở Giai đoạn 1 để hệ thống phân tích đối tượng áp dụng và quy chuẩn thực tế.'
      }],
      conflicts: [{
        severity: 'HIGH',
        type: 'INSUFFICIENT_EVIDENCE',
        classification_v2: 'UNKNOWN',
        target_doc_code: 'ALL',
        target_title: 'Chưa có nội dung văn bản mới',
        message: 'Văn bản dự thảo chưa có nội dung văn bản để thực hiện đối soát quy chuẩn với các quy chế đang áp dụng. Vui lòng đính kèm tệp tin hợp lệ hoặc hoàn tất trích xuất trước khi gửi duyệt.',
        suggested_action: 'Đính kèm tệp tin văn bản đầy đủ ở Giai đoạn 1 để hệ thống phân tích đối tượng áp dụng và quy chuẩn thực tế.'
      }],
      valid_specializations: [],
      compatible_docs: [],
      summary: 'Văn bản dự thảo chưa có nội dung văn bản (hoặc chưa trích xuất) để đối soát quy chuẩn. Áp dụng cơ chế Fail-Closed: Tạm dừng phê duyệt trực tiếp.'
    };
    dispatchShadowAudit(candidate, report, Date.now() - startTime);
    return report;
  }

  // Hỗ trợ transaction client và quan hệ xác nhận phê duyệt đồng thời (Giai đoạn C)
  const queryRunner = options.client || db;

  // 1. Lấy danh sách các tài liệu đang Active hoặc Scheduled trong hệ thống thuộc phạm vi Tenant liên quan
  const candidateBranches = Array.isArray(branch_scope) && branch_scope.length > 0 ? branch_scope : ['all'];
  const isGlobalCandidate = candidateBranches.includes('all');

  const activeDocsRes = await queryRunner.query(`
    SELECT d.doc_version_id, d.document_id, d.document_family_id, d.doc_code, d.doc_number,
           d.title, d.category, d.version, d.status, d.branch_scope, d.department_scope, d.business_unit_scope,
           d.employee_group_scope, d.effective_date, d.expiry_date, d.change_summary, d.file_sha256,
           COALESCE(substring(string_agg(c.content, ' ' ORDER BY c.seq) from 1 for 15000), '') as chunk_content
    FROM documents d
    LEFT JOIN chunks c ON c.doc_version_id = d.doc_version_id
    WHERE d.status IN ('active', 'scheduled')
      AND d.deleted_at IS NULL
      AND ($1::uuid IS NULL OR d.doc_version_id <> $1::uuid)
      AND ($2::boolean = true OR d.branch_scope && $3::text[])
    GROUP BY d.doc_version_id, d.document_id, d.document_family_id, d.doc_code, d.doc_number,
             d.title, d.category, d.version, d.status, d.branch_scope, d.department_scope, d.business_unit_scope,
             d.employee_group_scope, d.effective_date, d.expiry_date, d.change_summary, d.file_sha256
  `, [
    doc_version_id || null,
    isGlobalCandidate,
    candidateBranches.concat(['all'])
  ]);

  const activeDocs = activeDocsRes.rows;
  const totalScannedDocs = activeDocs.length;

  // 2. Lấy toàn bộ quan hệ đã phê duyệt liên quan đến candidate nếu candidate đã có version_id
  let existingRelations = [];
  if (doc_version_id) {
    const relRes = await queryRunner.query(`
      SELECT relationship_id, source_doc_version_id, target_doc_version_id, relation_type, approval_status
      FROM document_relationships
      WHERE (source_doc_version_id = $1 OR target_doc_version_id = $1)
        AND approval_status = 'approved'
    `, [doc_version_id]);
    existingRelations = relRes.rows;

    // Bổ sung danh mục điều khoản sửa đổi (AUD-APP-02)
    for (const r of existingRelations) {
      if (r.relation_type === 'amends') {
        try {
          const clRes = await queryRunner.query(
            'SELECT clause_rel_id, relationship_id, source_clause_ref, target_clause_ref, modification_type, summary_of_change, scope_status FROM document_relationship_clauses WHERE relationship_id = $1',
            [r.relationship_id]
          );
          r.clauses = clRes.rows || [];
        } catch (clErr) {
          r.clauses = [];
        }
      }
    }
  }

  // Tích hợp quan hệ được xác nhận duyệt đồng thời trong cùng transaction (Giai đoạn C)
  if (Array.isArray(options.confirmedRelationships) && options.confirmedRelationships.length > 0) {
    for (const cr of options.confirmedRelationships) {
      const existingRel = existingRelations.find(r =>
        ((r.source_doc_version_id === cr.source_doc_version_id && r.target_doc_version_id === cr.target_doc_version_id) ||
         (r.source_doc_version_id === cr.target_doc_version_id && r.target_doc_version_id === cr.source_doc_version_id)) &&
        r.relation_type === cr.relation_type
      );
      if (!existingRel) {
        existingRelations.push({
          relationship_id: cr.relationship_id || 'confirmed-inline',
          source_doc_version_id: cr.source_doc_version_id,
          target_doc_version_id: cr.target_doc_version_id,
          relation_type: cr.relation_type,
          approval_status: 'approved',
          clauses: cr.clauses || []
        });
      } else if (cr.clauses && Array.isArray(cr.clauses)) {
        existingRel.clauses = cr.clauses;
      }
    }
  }

  const candidateText = `${title} ${candidate.topics?.join(' ') || ''} ${content}`;
  const candidateTopics = extractCoreTopics(candidateText, title);
  const candAud = extractAudienceProfile(candidateText);

  let scopeMismatchWarning = null;
  if (candidateBranches.includes('all') && (isAllScope(department_scope) || isAllScope(employee_group_scope))) {
    if (candAud.profiles.length > 0 && !candAud.profiles.includes('COMPANY_WIDE') && !candAud.profiles.includes('UNSPECIFIED')) {
      scopeMismatchWarning = `Metadata đang chọn cấp ban hành "Toàn tập đoàn", nhưng nội dung văn bản thực tế chỉ áp dụng cho nhóm: ${candAud.rawMatches.join(', ')}. Hệ thống sẽ đối soát theo đối tượng thực tế nêu trong nội dung để bảo đảm tính chuẩn xác.`;
    }
  }

  const conflicts = [];
  const validSpecializations = [];
  const compatibleDocs = [];

  for (const doc of activeDocs) {
    // A. Bỏ qua nếu cùng family (đây là phiên bản mới thay thế bản cũ cùng dòng)
    if (document_family_id && doc.document_family_id && document_family_id === doc.document_family_id) {
      continue;
    }

    const docFullText = `${doc.title} ${doc.doc_code || ''} ${doc.change_summary || ''} ${doc.chunk_content || ''}`;
    const docTopics = extractCoreTopics(docFullText, doc.title);
    const commonTopics = candidateTopics.filter(t => docTopics.includes(t));

    // B. Kiểm tra quan hệ chính sách đã có giữa 2 văn bản (Phân biệt rõ chiều source -> target)
    // Quy tắc: NEW DOCUMENT (source) --supersedes--> OLD DOCUMENT (target)
    const forwardRel = existingRelations.find(r =>
      (r.source_doc_version_id === doc_version_id || (!doc_version_id && options.confirmedRelationships)) &&
      r.target_doc_version_id === doc.doc_version_id
    );
    const reverseRel = existingRelations.find(r =>
      r.source_doc_version_id === doc.doc_version_id &&
      (r.target_doc_version_id === doc_version_id || (!doc_version_id && options.confirmedRelationships))
    );

    // B1. Phát hiện đảo ngược chiều quan hệ thay thế (Reverse Supersedes Check - P2-2)
    if (reverseRel && reverseRel.relation_type === 'supersedes') {
      conflicts.push({
        severity: 'HIGH',
        type: 'REVERSE_SUPERSEDES_CONFLICT',
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        message: `Sai chiều quan hệ thay thế: Văn bản "${doc.title}" đã từng thay thế văn bản này trong lịch sử. Không thể phê duyệt văn bản cũ để thay thế ngược lại văn bản mới.`,
        suggested_action: 'Vui lòng ban hành phiên bản mới kế thừa từ văn bản hiện hành hoặc điều chỉnh đúng chiều quan hệ thay thế (New supersedes Old).'
      });
      continue;
    }

    const hasApprovedSupersedes = forwardRel && forwardRel.relation_type === 'supersedes';
    const hasApprovedAmends = forwardRel && forwardRel.relation_type === 'amends';
    const hasApprovedException = forwardRel && forwardRel.relation_type === 'exception_to';
    const hasApprovedComplementary = forwardRel && ['supplements', 'clarifies', 'applies_with'].includes(forwardRel.relation_type);

    // C0. Kiểm tra trùng lặp tập tin tuyệt đối (Exact SHA-256 Duplicate) - Không thể miễn trừ bởi bất kỳ quan hệ nào
    const candidateSha = file_sha256 || sha256;
    if (candidateSha && doc.file_sha256 && candidateSha.toLowerCase() === doc.file_sha256.toLowerCase()) {
      conflicts.push({
        severity: 'HIGH',
        type: 'EXACT_DUPLICATE_FILE',
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: candidateTopics,
        evidence_quote: `Mã băm SHA-256 trùng khớp 100%: ${candidateSha}`,
        comparison_summary: `Tập tin tải lên hoàn toàn trùng khớp với văn bản đang ban hành "${doc.title}".`,
        message: `Phát hiện tập tin trùng lặp 100%: Tập tin này đã tồn tại trong hệ thống dưới tên "${doc.title}" (${doc.doc_code || doc.doc_number}).`,
        suggested_action: 'Không thể phê duyệt tài liệu trùng file hash. Hãy dùng lại văn bản hiện hành hoặc ban hành phiên bản mới nếu có sửa đổi.'
      });
      continue;
    }

    // D0. Kiểm tra trùng mã hiệu văn bản chính thức (Duplicate Doc Code)
    const candCode = (doc_code || doc_number || '').trim();
    const existCode = (doc.doc_code || doc.doc_number || '').trim();
    if (candCode && existCode && candCode !== 's/n' && existCode !== 's/n' && candCode.toLowerCase() === existCode.toLowerCase()) {
      const isSameFamily = document_family_id && doc.document_family_id && (document_family_id === doc.document_family_id);
      if (!isSameFamily && !hasApprovedSupersedes) {
        conflicts.push({
          severity: 'HIGH',
          type: 'DUPLICATE_DOC_CODE',
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: existCode,
          target_title: doc.title,
          common_topics: candidateTopics,
          evidence_quote: `Mã hiệu trùng khớp: ${candCode}`,
          comparison_summary: `Mã hiệu văn bản "${candCode}" đã được sử dụng bởi văn bản "${doc.title}".`,
          message: `Mã hiệu văn bản "${candCode}" đã tồn tại trên hệ thống.`,
          suggested_action: 'Vui lòng đổi mã hiệu khác hoặc khai báo quan hệ "Thay thế toàn bộ (supersedes)" để thay thế bản cũ.'
        });
        continue;
      }
    }

    // B2. Xử lý quan hệ ngoại lệ (exception_to) - Bắt buộc kiểm tra Scope Narrowing (P2-1)
    if (hasApprovedException) {
      const candBranch = Array.isArray(branch_scope) && branch_scope.length > 0 ? branch_scope : ['all'];
      const docBranch = Array.isArray(doc.branch_scope) && doc.branch_scope.length > 0 ? doc.branch_scope : ['all'];
      const candDept = Array.isArray(department_scope) && department_scope.length > 0 ? department_scope : ['all'];
      const docDept = Array.isArray(doc.department_scope) && doc.department_scope.length > 0 ? doc.department_scope : ['all'];
      const candBu = Array.isArray(business_unit_scope) && business_unit_scope.length > 0 ? business_unit_scope : ['all'];
      const docBu = Array.isArray(doc.business_unit_scope) && doc.business_unit_scope.length > 0 ? doc.business_unit_scope : ['all'];
      const candLoc = Array.isArray(location_scope) && location_scope.length > 0 ? location_scope : ['all'];
      const docLoc = Array.isArray(doc.location_scope) && doc.location_scope.length > 0 ? doc.location_scope : ['all'];
      const candEg = Array.isArray(employee_group_scope) && employee_group_scope.length > 0 ? employee_group_scope : ['all'];
      const docEg = Array.isArray(doc.employee_group_scope) && doc.employee_group_scope.length > 0 ? doc.employee_group_scope : ['all'];

      const isBranchNarrower = isNarrowerScope(candBranch, docBranch);
      const isDeptNarrower = isNarrowerScope(candDept, docDept);
      const isBuNarrower = isNarrowerScope(candBu, docBu);
      const isLocNarrower = isNarrowerScope(candLoc, docLoc);
      const isEgNarrower = isNarrowerScope(candEg, docEg);

      const isBranchBroader = isNarrowerScope(docBranch, candBranch);
      const isDeptBroader = isNarrowerScope(docDept, candDept);
      const isBuBroader = isNarrowerScope(docBu, candBu);
      const isLocBroader = isNarrowerScope(docLoc, candLoc);
      const isEgBroader = isNarrowerScope(docEg, candEg);

      const hasNarrowerDimension = isBranchNarrower || isDeptNarrower || isBuNarrower || isLocNarrower || isEgNarrower;
      const hasBroaderDimension = isBranchBroader || isDeptBroader || isBuBroader || isLocBroader || isEgBroader;

      if (!hasNarrowerDimension || hasBroaderDimension) {
        conflicts.push({
          severity: 'HIGH',
          type: 'INVALID_EXCEPTION_SCOPE',
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number || 's/n',
          target_title: doc.title,
          message: `Quan hệ ngoại lệ (exception_to) không hợp lệ: Phạm vi áp dụng của văn bản mới không hẹp hơn văn bản gốc "${doc.title}".`,
          suggested_action: 'Chỉ thiết lập quan hệ ngoại lệ khi văn bản mới áp dụng cho phạm vi hẹp hơn (công ty con hoặc phòng ban đặc thù).'
        });
        continue;
      }

      validSpecializations.push({
        target_doc_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number,
        target_title: doc.title,
        relation_type: 'exception_to',
        note: `Quy chế đặc thù/ngoại lệ được công nhận hợp lệ cho "${doc.title}" (phạm vi hẹp hơn)`
      });
      continue;
    }

    // B3. Xử lý quan hệ thay thế (supersedes)
    if (hasApprovedSupersedes) {
      // Xác minh bằng chứng nội dung cho quan hệ thay thế (F-03 Parity Verification)
      const candNorm = normalizeVietnamese(`${candidate.title || ''} ${candidate.content || ''}`);
      const targetCode = normalizeVietnamese(doc.doc_code || doc.doc_number || '');
      const hasExplicitTextMention = targetCode && candNorm.includes(targetCode);
      const hasKeywordReplacement = /thay\s*the|bai\s*bo|ke\s*thua|cap\s*nhat\s*thay/.test(candNorm);
      const sharesCategoryOrTopics = (candidate.category === doc.category) || commonTopics.length > 0;

      if (!hasExplicitTextMention && !hasKeywordReplacement && !sharesCategoryOrTopics) {
        conflicts.push({
          severity: 'MEDIUM',
          type: 'SUPERSEDES_EVIDENCE_UNVERIFIED',
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number || 's/n',
          target_title: doc.title,
          common_topics: commonTopics,
          comparison_summary: `Quan hệ thay thế (supersedes) được khai báo nhưng chưa có bằng chứng nội dung hoặc không cùng chủ đề/lĩnh vực.`,
          target_scope: {
            branch: doc.branch_scope,
            department: doc.department_scope,
            business_unit: doc.business_unit_scope,
            employee_group: doc.employee_group_scope
          },
          candidate_scope: {
            branch: branch_scope,
            department: department_scope,
            business_unit: business_unit_scope,
            employee_group: employee_group_scope
          },
          message: `Cảnh báo quan hệ thay thế: Văn bản khai báo thay thế "${doc.title}" (${doc.doc_code || doc.doc_number}) nhưng không tìm thấy viện dẫn mã văn bản hoặc chủ đề tương đồng trong nội dung. Cần xem xét lại trước khi phê duyệt.`,
          suggested_action: 'Kiểm tra lại điều khoản bãi bỏ/thay thế trong nội dung văn bản hoặc xác nhận lại quan hệ liên kết trước khi phê duyệt.'
        });
      } else {
        validSpecializations.push({
          target_doc_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number,
          target_title: doc.title,
          relation_type: 'supersedes',
          note: `Văn bản có quan hệ thay thế (supersedes) hợp lệ với "${doc.title}" (đã xác thực bằng chứng nội dung/chủ đề)`
        });
        continue;
      }
    }

    // B4. Xử lý quan hệ sửa đổi (amends) - Loại bỏ bypass mù (AUD-APP-01, AUD-APP-02)
    if (hasApprovedAmends) {
      const declaredClauses = forwardRel.clauses || [];
      const hasClausesDeclared = Array.isArray(declaredClauses) && declaredClauses.length > 0;

      if (!hasClausesDeclared) {
        // Bắt buộc phải khai báo phạm vi điều khoản sửa đổi (AUD-APP-02)
        conflicts.push({
          severity: 'HIGH',
          type: 'AMENDS_CLAUSE_SCOPE_REQUIRED',
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number || 's/n',
          target_title: doc.title,
          message: `Quan hệ sửa đổi (amends) với "${doc.title}" (${doc.doc_code || doc.doc_number}) chưa khai báo chi tiết danh mục điều khoản sửa đổi (Clause-level Scope). Bắt buộc phải khai báo phạm vi sửa đổi trước khi phê duyệt.`,
          suggested_action: 'Vui lòng bổ sung danh mục các điều khoản sửa đổi tại mục Quản lý quan hệ văn bản.'
        });
      } else {
        const clauseSummary = declaredClauses.map(c => `${c.source_clause_ref || ''} -> ${c.target_clause_ref || ''} (${c.modification_type || 'MODIFY'})`).join('; ');
        validSpecializations.push({
          target_doc_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number,
          target_title: doc.title,
          relation_type: 'amends',
          clauses: declaredClauses,
          note: `Văn bản có quan hệ sửa đổi (amends) đối với "${doc.title}". Phạm vi điều khoản: ${clauseSummary}. Tiếp tục kiểm tra xung đột quy chuẩn thực chất.`
        });
      }
      // TUYỆT ĐỐI KHÔNG continue; ở đây!
      // Toàn bộ kiểm tra trùng lặp nội dung, trùng lặp tiêu đề và mâu thuẫn quy chuẩn đối kháng vẫn tiếp tục thực hiện đầy đủ.
    }

    // E. Kiểm tra Tenant Isolation (Bảo toàn ranh giới công ty / chi nhánh)
    const branchOverlap = isScopeOverlapping(branch_scope, doc.branch_scope);
    if (!branchOverlap) {
      continue; // Tuyệt đối không đối soát chéo giữa các công ty con độc lập không giao thoa
    }

    // F. Kiểm tra thời gian hiệu lực
    const dateOverlap = isDateRangeOverlapping(effective_date, expiry_date, doc.effective_date, doc.expiry_date);
    if (!dateOverlap) continue;

    // F2. Kiểm tra dữ liệu chunks của văn bản hiện hành (bảo đảm tính toàn vẹn chứng cứ)
    if (!doc.chunk_content || doc.chunk_content.trim().length < 20) {
      conflicts.push({
        severity: 'MEDIUM',
        type: 'INSUFFICIENT_EVIDENCE',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        message: `Tài liệu hiện hành "${doc.title}" (${doc.doc_code || doc.doc_number}) chưa có dữ liệu đoạn văn trích xuất (chunks) trong cơ sở dữ liệu để đối soát toàn diện.`,
        suggested_action: 'Cần hoàn tất trích xuất chunks cho văn bản hiện hành này trước khi kết luận an toàn.'
      });
      continue;
    }

    // G. Kiểm tra trùng lặp nội dung thực tế (DUPLICATE_CONTENT - ví dụ khác định dạng PDF/DOCX)
    const contentSim = calculateContentSimilarity(content, doc.chunk_content);
    if (contentSim >= 0.85 && !hasApprovedSupersedes) {
      conflicts.push({
        severity: 'HIGH',
        type: 'DUPLICATE_CONTENT',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: candidateTopics,
        evidence_quote: `Độ tương đồng nội dung văn bản đạt ${(contentSim * 100).toFixed(0)}%`,
        comparison_summary: `Nội dung văn bản hoàn toàn tương đương với "${doc.title}" (${doc.category}).`,
        message: `Phát hiện trùng lặp nội dung (${(contentSim * 100).toFixed(0)}%): Văn bản có nội dung tương đương với văn bản đang áp dụng "${doc.title}".` +
          (hasApprovedComplementary ? ` Quan hệ bổ sung (${forwardRel.relation_type}) không được miễn trừ cho văn bản trùng lặp nội dung.` : '') +
          (hasApprovedAmends ? ' Quan hệ sửa đổi (amends) không được miễn trừ cho văn bản trùng lặp toàn văn nội dung.' : ''),
        suggested_action: 'Không thể phê duyệt văn bản trùng nội dung khi chưa thiết lập quan hệ thay thế (supersedes).'
      });
      continue;
    }

    // G2. Xử lý quan hệ bổ trợ (supplements / clarifies / applies_with)
    if (hasApprovedComplementary) {
      // PHASE 4B: Loại bỏ blind bypass. Bắt buộc kiểm tra mâu thuẫn quy phạm thực chất (Fail-Closed)
      const compTopics = commonTopics.length > 0 ? commonTopics : candidateTopics;
      const compDeltas = detectSubstantiveRuleDelta(candidate, doc, compTopics);
      const trueConflictsFound = compDeltas && compDeltas.filter(d => !d.is_potential);
      if (trueConflictsFound && trueConflictsFound.length > 0) {
        conflicts.push({
          severity: 'HIGH',
          type: 'TRUE_CONFLICT',
          candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
          candidate_version_id: candidate.doc_version_id || 'draft-pending',
          target_doc_id: doc.document_id,
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number || 's/n',
          target_title: doc.title,
          common_topics: candidateTopics,
          substantive_deltas: trueConflictsFound,
          comparison_summary: `Phát hiện mâu thuẫn quy phạm đối kháng trực tiếp dù khai báo quan hệ ${forwardRel.relation_type}: ${trueConflictsFound.map(d => d.description).join('; ')}`,
          message: `Phát hiện mâu thuẫn quy phạm đối kháng trực tiếp: Văn bản có quy định mâu thuẫn trực tiếp với "${doc.title}" (${doc.doc_code || doc.doc_number}): ${trueConflictsFound.map(d => d.description).join(' ')}. Quan hệ bổ trợ (${forwardRel.relation_type}) không được phép miễn trừ cho mâu thuẫn đối kháng quy phạm.`,
          points_to_verify: 'Hai quy chế ban hành điều khoản đối lập cho cùng nhóm nhân sự. Quan hệ bổ sung không thể giải quyết mâu thuẫn đối kháng.',
          suggested_action: 'Quan hệ bổ sung không thể miễn trừ cho điều khoản trái ngược. Vui lòng chọn quan hệ "Thay thế (supersedes)" nếu bãi bỏ bản cũ, hoặc "Sửa đổi (amends)" với điều khoản cụ thể, hoặc điều chỉnh nội dung đối kháng.'
        });
        continue;
      }

      const potConflictsFound = compDeltas && compDeltas.filter(d => d.is_potential);
      if (potConflictsFound && potConflictsFound.length > 0) {
        conflicts.push({
          severity: 'MEDIUM',
          type: 'POTENTIAL_CONFLICT',
          candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
          candidate_version_id: candidate.doc_version_id || 'draft-pending',
          target_doc_id: doc.document_id,
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number || 's/n',
          target_title: doc.title,
          common_topics: candidateTopics,
          substantive_deltas: potConflictsFound,
          comparison_summary: `Phát hiện khác biệt quy chuẩn tiềm năng dù có quan hệ ${forwardRel.relation_type}: ${potConflictsFound.map(d => d.description).join('; ')}`,
          message: `Khác biệt quy chuẩn cần xem xét (${forwardRel.relation_type}): Văn bản và "${doc.title}" có khác biệt quy phạm cần xác nhận trước khi phê duyệt.`,
          points_to_verify: 'Đối chiếu ngữ cảnh thực thi và tính chất nhiệm vụ của nhóm nhân sự.',
          suggested_action: 'Người kiểm duyệt cần đối chiếu cụ thể điều khoản và đối tượng áp dụng trước khi phê duyệt kích hoạt.'
        });
        continue;
      }

      validSpecializations.push({
        target_doc_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number,
        target_title: doc.title,
        relation_type: forwardRel.relation_type,
        note: `Văn bản có quan hệ ${forwardRel.relation_type} bổ sung điều khoản mới hợp lệ cho "${doc.title}" (nội dung phân biệt, không mâu thuẫn quy chuẩn đối kháng)`
      });
      continue;
    }

    // H. Kiểm tra trùng lặp tiêu đề / chủ đề điều chỉnh xuyên Category (SEMANTIC_DUPLICATE)
    const titleSim = calculateTitleSimilarity(title, doc.title);
    const earlyDeltas = detectSubstantiveRuleDelta(candidate, doc, commonTopics);
    const hasEarlyTrueConflict = earlyDeltas && earlyDeltas.some(d => !d.is_potential);

    if (titleSim >= 0.85 && !hasApprovedSupersedes && !hasEarlyTrueConflict) {
      conflicts.push({
        severity: 'HIGH',
        type: 'SEMANTIC_DUPLICATE',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: candidateTopics,
        evidence_quote: `Tiêu đề tương đồng ${(titleSim * 100).toFixed(0)}%: "${title}" vs "${doc.title}"`,
        comparison_summary: `Cùng điều chỉnh chung một chủ đề với văn bản "${doc.title}" (${doc.category}) nhưng chưa có quan hệ pháp lý.`,
        message: `Phát hiện trùng lặp tiêu đề/chủ đề quy định (${(titleSim * 100).toFixed(0)}%): Cùng quy định với "${doc.title}" (${doc.category} - ${doc.doc_code || doc.doc_number}).`,
        suggested_action: 'Cần thiết lập quan hệ "Thay thế (supersedes)" ở mục Quản lý quan hệ trước khi phê duyệt kích hoạt.'
      });
      continue;
    }

    // I. Kiểm tra chủ đề cốt lõi
    const domainTopics = [
      'thoi_gio_lam_viec', 'lam_viec_tu_xa', 'che_do_nghi_phep', 'phu_cap_cong_tac_phi',
      'an_ninh_kho_cang', 'an_toan_pccc', 'an_toan_lao_dong', 'an_toan_giao_thong',
      'an_toan_thong_tin', 'chuyen_doi_so', 'ky_luat_lao_dong', 'van_phong_tru_so'
    ];
    const hasDomainTopic = candidateTopics.some(t => domainTopics.includes(t) && docTopics.includes(t));
    if (commonTopics.length === 0 && !hasDomainTopic) continue;

    // J. Lấy trích lục nguyên văn đối chiếu (Verbatim Dual Excerpts)
    const excerptsA = extractKeyExcerpts(content || title, title);
    const excerptsB = extractKeyExcerpts(doc.chunk_content || doc.title, doc.title);

    // K. Đánh giá phân định đối tượng áp dụng (Audience Profiling)
    const docAud = extractAudienceProfile(docFullText);
    const substantiveDeltas = earlyDeltas || detectSubstantiveRuleDelta(candidate, doc, commonTopics);
    const hasTrueConflictDeltas = substantiveDeltas && substantiveDeltas.some(d => !d.is_potential);
    const hasPotentialDeltas = substantiveDeltas && substantiveDeltas.some(d => d.is_potential);

    const sharedProfiles = candAud.profiles.filter(p => docAud.profiles.includes(p));
    const isDistinctAudience = sharedProfiles.length === 0 &&
      !candAud.profiles.includes('COMPANY_WIDE') && !docAud.profiles.includes('COMPANY_WIDE') &&
      !candAud.profiles.includes('UNSPECIFIED') && !docAud.profiles.includes('UNSPECIFIED');

    const isCompanyWideVsSpecific = (candAud.profiles.includes('COMPANY_WIDE') && !docAud.profiles.includes('COMPANY_WIDE')) ||
                                    (!candAud.profiles.includes('COMPANY_WIDE') && docAud.profiles.includes('COMPANY_WIDE'));

    // Trường hợp 1: Thiếu thông tin đối tượng ở một trong hai phía (trừ khi có điều khoản đăng ký vận hành linh hoạt)
    if (!candAud.hasFlexibleRegistration && !docAud.hasFlexibleRegistration && (candAud.profiles.includes('UNSPECIFIED') || docAud.profiles.includes('UNSPECIFIED'))) {
      conflicts.push({
        severity: 'MEDIUM',
        type: 'INSUFFICIENT_EVIDENCE',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: commonTopics,
        candidate_audience: candAud.rawMatches,
        target_audience: docAud.rawMatches,
        candidate_quote: excerptsA.verbatimQuote,
        target_quote: excerptsB.verbatimQuote,
        comparison_summary: 'Không đủ dữ liệu xác định đối tượng áp dụng cụ thể từ nội dung văn bản.',
        message: 'Thiếu chứng cứ phân định đối tượng: Không trích xuất được phạm vi nhóm nhân sự cụ thể từ một trong hai văn bản để kết luận xung đột quy chuẩn.',
        points_to_verify: 'Cần kiểm tra điều khoản quy định đối tượng áp dụng trong tệp văn bản gốc.',
        suggested_action: 'Kiểm tra lại văn bản để bổ sung điều khoản đối tượng áp dụng rõ ràng.'
      });
      continue;
    }

    // Trường hợp 2: Khác biệt điều kiện áp dụng (tình huống đặc thù / khẩn cấp vs thường nhật)
    if (candAud.hasSpecialCondition && !docAud.hasSpecialCondition) {
      compatibleDocs.push({
        severity: 'LOW',
        type: 'COMPATIBLE_COEXISTING',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: commonTopics,
        candidate_audience: candAud.rawMatches,
        target_audience: docAud.rawMatches,
        candidate_quote: excerptsA.verbatimQuote,
        target_quote: excerptsB.verbatimQuote,
        comparison_summary: 'Khác biệt điều kiện áp dụng: Văn bản mới áp dụng cho tình huống đặc thù/khẩn cấp.',
        message: `Quy chế tương thích theo điều kiện đặc thù: Văn bản áp dụng cho trường hợp đặc biệt/khẩn cấp, cùng tồn tại hợp lệ song song với quy chuẩn thường nhật của "${doc.title}".`,
        verdict_reason: 'Khác biệt điều kiện áp dụng (tình huống đặc thù/khẩn cấp vs thường nhật), không cấu thành mâu thuẫn đối kháng.'
      });
      continue;
    }

    // Trường hợp 2.1: Có điều khoản mở rộng / đăng ký vận hành linh hoạt (Chồng lấn phạm vi tiềm năng)
    if (candAud.hasFlexibleRegistration || docAud.hasFlexibleRegistration) {
      conflicts.push({
        severity: 'MEDIUM',
        type: 'POTENTIAL_CONFLICT',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: commonTopics,
        candidate_audience: candAud.rawMatches,
        target_audience: docAud.rawMatches,
        candidate_quote: excerptsA.verbatimQuote,
        target_quote: excerptsB.verbatimQuote,
        comparison_summary: `Tiềm năng chồng lấn phạm vi: Văn bản có điều khoản mở rộng ("các đơn vị đăng ký vận hành linh hoạt") có khả năng giao thoa với quy chế vận hành hiện trường tại "${doc.title}".`,
        message: `Khả năng chồng lấn phạm vi áp dụng: Văn bản có điều khoản mở rộng "các đơn vị đăng ký vận hành linh hoạt". Điều này có thể gây mâu thuẫn với quy định hiện diện trực tiếp 100% của "${doc.title}" nếu các đơn vị bến bãi đăng ký.`,
        points_to_verify: `Cần xác minh: Nhân sự hiện trường, bến bãi, lái xe nâng thuộc "${doc.title}" có thuộc diện được loại trừ khỏi cơ chế làm việc linh hoạt hay không.`,
        suggested_action: 'Bổ sung điều khoản loại trừ rõ ràng trong dự thảo đối với nhân sự hiện trường bắt buộc, hoặc thiết lập quan hệ bổ sung/ngoại lệ để phân cấp rõ ràng.'
      });
      continue;
    }

    // Trường hợp 3: Khác nhóm nhân sự rõ ràng
    if (isDistinctAudience) {
      // Hoàn toàn không giao nhau -> COMPATIBLE
      compatibleDocs.push({
        severity: 'LOW',
        type: 'COMPATIBLE_COEXISTING',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: commonTopics,
        candidate_audience: candAud.rawMatches,
        target_audience: docAud.rawMatches,
        candidate_quote: excerptsA.verbatimQuote,
        target_quote: excerptsB.verbatimQuote,
        comparison_summary: `Cùng chủ đề "${commonTopics.join(', ')}" nhưng khác đối tượng áp dụng rõ ràng: [${candAud.rawMatches.join(', ')}] đối lập [${docAud.rawMatches.join(', ')}].`,
        message: `Quy chế cùng tồn tại tương thích: Văn bản điều chỉnh cho nhóm nhân sự riêng biệt ([${candAud.rawMatches.join(', ')}]), không mâu thuẫn đối kháng với quy chế vận hành dành cho [${docAud.rawMatches.join(', ')}] của "${doc.title}".`,
        verdict_reason: `Hai văn bản có cùng chủ đề "${commonTopics.join(', ')}" nhưng áp dụng cho hai nhóm đối tượng lao động độc lập, cùng tồn tại hợp lệ song song.`
      });
      continue;
    }

    // Trường hợp 4: Quy chế chung toàn công ty vs Quy chuẩn nhóm đặc thù
    if (isCompanyWideVsSpecific) {
      if (hasTrueConflictDeltas) {
        conflicts.push({
          severity: 'MEDIUM',
          type: 'POTENTIAL_CONFLICT',
          candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
          candidate_version_id: candidate.doc_version_id || 'draft-pending',
          target_doc_id: doc.document_id,
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number || 's/n',
          target_title: doc.title,
          common_topics: commonTopics,
          candidate_audience: candAud.rawMatches,
          target_audience: docAud.rawMatches,
          candidate_quote: excerptsA.verbatimQuote,
          target_quote: excerptsB.verbatimQuote,
          comparison_summary: 'Giao thoa giữa quy chế chung toàn công ty và quy chuẩn nhóm đặc thù: Cần xác nhận quy định ngoại lệ (exception_to) hoặc thứ tự ưu tiên áp dụng.',
          message: `Khác biệt phân cấp chính sách: Văn bản chung toàn công ty có quy định khác biệt với quy chuẩn đặc thù dành cho [${docAud.rawMatches.join(', ')}] của "${doc.title}". Cần làm rõ thứ tự áp dụng hoặc thiết lập quan hệ ngoại lệ.`,
          points_to_verify: `Xác định xem quy chế mới có bãi bỏ hay tiếp tục công nhận hiệu lực đặc thù của "${doc.title}".`,
          suggested_action: 'Thiết lập quan hệ "exception_to" (ngoại lệ) hoặc "supplements" (bổ sung) ở Bước 3 trước khi phê duyệt.'
        });
      } else {
        compatibleDocs.push({
          severity: 'LOW',
          type: 'COMPATIBLE_COEXISTING',
          candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
          candidate_version_id: candidate.doc_version_id || 'draft-pending',
          target_doc_id: doc.document_id,
          target_doc_version_id: doc.doc_version_id,
          target_doc_code: doc.doc_code || doc.doc_number || 's/n',
          target_title: doc.title,
          common_topics: commonTopics,
          candidate_audience: candAud.rawMatches,
          target_audience: docAud.rawMatches,
          candidate_quote: excerptsA.verbatimQuote,
          target_quote: excerptsB.verbatimQuote,
          comparison_summary: 'Quy chế chung tương thích với quy chuẩn đặc thù hiện hành.',
          message: `Tương thích phân cấp: Văn bản không có điều khoản đối kháng trực tiếp với quy chế đặc thù "${doc.title}".`,
          verdict_reason: 'Quy chế chung và quy chuẩn đặc thù tương thích, không phát hiện xung đột.'
        });
      }
      continue;
    }

    // Trường hợp 5: Cùng nhóm đối tượng áp dụng
    if (hasTrueConflictDeltas) {
      conflicts.push({
        severity: 'HIGH',
        type: 'TRUE_CONFLICT',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: commonTopics,
        candidate_audience: candAud.rawMatches,
        target_audience: docAud.rawMatches,
        candidate_quote: excerptsA.verbatimQuote,
        target_quote: excerptsB.verbatimQuote,
        substantive_deltas: substantiveDeltas.filter(d => !d.is_potential),
        comparison_summary: `Phát hiện mâu thuẫn quy phạm đối kháng trực tiếp trên cùng đối tượng [${sharedProfiles.join(', ')}]: ${substantiveDeltas.filter(d => !d.is_potential).map(d => d.description).join('; ')}`,
        message: `Phát hiện xung đột chính sách trực tiếp: Văn bản có quy định mâu thuẫn trên cùng nhóm đối tượng [${sharedProfiles.join(', ')}] với "${doc.title}" (${doc.doc_code || doc.doc_number}): ${substantiveDeltas.filter(d => !d.is_potential).map(d => d.description).join(' ')}`,
        points_to_verify: 'Hai quy chế ban hành điều khoản đối lập cho cùng một nhóm nhân sự trong cùng thời gian hiệu lực.',
        suggested_action: 'Cần thiết lập quan hệ "supersedes" (thay thế) nếu là bản mới bãi bỏ bản cũ, hoặc "amends" nếu sửa đổi, hoặc điều chỉnh quy chuẩn quy định.'
      });
    } else if (hasPotentialDeltas) {
      conflicts.push({
        severity: 'MEDIUM',
        type: 'POTENTIAL_CONFLICT',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: commonTopics,
        candidate_audience: candAud.rawMatches,
        target_audience: docAud.rawMatches,
        candidate_quote: excerptsA.verbatimQuote,
        target_quote: excerptsB.verbatimQuote,
        substantive_deltas: substantiveDeltas,
        comparison_summary: `Phát hiện khác biệt quy phạm tiềm năng (Review Required): ${substantiveDeltas.map(d => d.description).join('; ')}`,
        message: `Khác biệt quy chuẩn cần xem xét: Văn bản và "${doc.title}" có khác biệt quy phạm nhưng chưa xác định mâu thuẫn đối kháng tuyệt đối.`,
        points_to_verify: 'Đối chiếu ngữ cảnh thực thi và tính chất nhiệm vụ của nhóm nhân sự.',
        suggested_action: 'Người kiểm duyệt cần đối chiếu cụ thể điều khoản và đối tượng áp dụng trước khi phê duyệt kích hoạt.'
      });
    } else {
      compatibleDocs.push({
        severity: 'LOW',
        type: 'COMPATIBLE_COEXISTING',
        candidate_doc_id: candidate.document_id || candidate.doc_code || 'new-candidate',
        candidate_version_id: candidate.doc_version_id || 'draft-pending',
        target_doc_id: doc.document_id,
        target_doc_version_id: doc.doc_version_id,
        target_doc_code: doc.doc_code || doc.doc_number || 's/n',
        target_title: doc.title,
        common_topics: commonTopics,
        candidate_audience: candAud.rawMatches,
        target_audience: docAud.rawMatches,
        candidate_quote: excerptsA.verbatimQuote,
        target_quote: excerptsB.verbatimQuote,
        comparison_summary: `Cùng điều chỉnh trong nhóm đối tượng [${sharedProfiles.join(', ')}] nhưng các điều khoản tương thích, không phát hiện mâu thuẫn quy chuẩn đối kháng.`,
        message: `Quy chế cùng tồn tại tương thích: Văn bản cùng điều chỉnh trong phạm vi nhưng không có mâu thuẫn quy phạm trực tiếp với "${doc.title}".`,
        verdict_reason: 'Cùng nhóm đối tượng và các quy chuẩn tương thích, không có đối kháng quy phạm.'
      });
    }
  }

  // Đính kèm classification_v2 cho từng đối tượng
  conflicts.forEach(c => {
    c.classification_v2 = mapToCanonicalClassification(c.type);
    // Fail-Closed on UNKNOWN: Nâng severity lên HIGH để chặn phê duyệt trực tiếp
    if (c.classification_v2 === 'UNKNOWN') {
      c.severity = 'HIGH';
    }
  });
  validSpecializations.forEach(s => {
    s.classification_v2 = mapToCanonicalClassification(null, s.relation_type);
  });
  compatibleDocs.forEach(d => {
    d.classification_v2 = 'COMPLEMENTARY';
  });

  const allItems = [...conflicts, ...validSpecializations, ...compatibleDocs];
  const distinctClassifications = Array.from(new Set(allItems.map(i => i.classification_v2).filter(Boolean)));

  // Xác định primary_classification_v2 dựa trên thang độ ưu tiên
  let primaryClassification = 'COMPLEMENTARY';
  let highestScore = -1;
  for (const c of distinctClassifications) {
    const score = CLASSIFICATION_SEVERITY_HIERARCHY[c] || 0;
    if (score > highestScore) {
      highestScore = score;
      primaryClassification = c;
    }
  }

  const blockingConflicts = conflicts.filter(c => c.severity === 'HIGH');
  const hasConflict = blockingConflicts.length > 0;
  const hasWarning = conflicts.some(c => c.severity === 'MEDIUM');

  let statusBadge = 'NO_CONFLICT_DETECTED';
  let statusLabel = 'Hợp lệ & Tương thích quy chuẩn';
  let summary = 'Chưa phát hiện xung đột. Dựa trên dữ liệu hiện có trong hệ thống, chưa tìm thấy điểm mâu thuẫn trực tiếp với các quy chế đang áp dụng.';

  if (hasConflict) {
    if (primaryClassification === 'UNKNOWN') {
      statusBadge = 'UNKNOWN';
      statusLabel = 'Thiếu chứng cứ đối soát (Fail-Closed)';
      summary = 'Không đủ chứng cứ hoặc dữ liệu văn bản bị gián đoạn. Hệ thống áp dụng Fail-Closed ngăn chặn phê duyệt trực tiếp.';
    } else {
      statusBadge = 'DIRECT_CONFLICT';
      statusLabel = 'Phát hiện xung đột / Trùng lặp chính sách';
      summary = `Phát hiện ${blockingConflicts.length} điểm xung đột/trùng lặp chính sách trực tiếp (${blockingConflicts.map(b => b.classification_v2 || b.type).join(', ')}) cần giải quyết trước khi ban hành.`;
    }
  } else if (conflicts.some(c => c.type === 'POTENTIAL_CONFLICT')) {
    statusBadge = 'POTENTIAL_CONFLICT';
    statusLabel = 'Cảnh báo tiềm năng chồng lấn phạm vi';
    summary = `Phát hiện ${conflicts.filter(c => c.type === 'POTENTIAL_CONFLICT').length} điểm có khả năng chồng lấn phạm vi áp dụng giữa văn bản mới và quy chế hiện hành. Cần kiểm tra điều khoản loại trừ trước khi ban hành.`;
  } else if (conflicts.some(c => c.type === 'INSUFFICIENT_EVIDENCE' || c.classification_v2 === 'UNKNOWN')) {
    statusBadge = 'UNKNOWN';
    statusLabel = 'Thiếu chứng cứ phân định đối soát';
    summary = 'Không đủ dữ liệu hoặc thiếu nội dung đoạn văn bản để kết luận an toàn tuyệt đối. Cần rà soát bổ sung.';
  } else if (hasWarning) {
    statusBadge = 'SIMILAR_CONTENT';
    statusLabel = 'Nội dung tương tự cần lưu ý';
    summary = `Không có xung đột trực tiếp. Có ${conflicts.length} khuyến nghị liên kết quan hệ (bổ sung hoặc ngoại lệ) để hoàn thiện phân cấp chính sách.`;
  }

  const report = {
    success: true,
    status_badge: statusBadge,
    status_label: statusLabel,
    classification_v2: primaryClassification,
    primary_classification_v2: primaryClassification,
    classifications_v2: distinctClassifications,
    has_conflict: hasConflict,
    has_warning: hasWarning,
    scope_mismatch_warning: scopeMismatchWarning,
    total_scanned_docs: totalScannedDocs,
    conflict_count: conflicts.length,
    compatible_count: compatibleDocs.length,
    blocking_conflicts: blockingConflicts,
    conflicts,
    compatible_docs: compatibleDocs,
    valid_specializations: validSpecializations,
    summary
  };

  dispatchShadowAudit(candidate, report, Date.now() - startTime);
  return report;
}

module.exports = {
  detectPolicyConflicts,
  detectSubstantiveRuleDelta,
  extractAudienceProfile,
  extractKeyExcerpts,
  calculateTitleSimilarity,
  calculateContentSimilarity,
  cleanTitleTokens,
  isScopeOverlapping,
  isNarrowerScope,
  isIdenticalScope,
  isDateRangeOverlapping,
  extractCoreTopics,
  normalizeVietnamese
};
