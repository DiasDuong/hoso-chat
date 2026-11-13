const db = require('../db');
const { logAudit } = require('../audit');
const { canonicalizeIdentity, computeBlindIndex } = require('./identitySecurityService');

function removeAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function maskCccd(cccd) {
  if (!cccd) return 'Chưa cập nhật';
  const clean = String(cccd).trim();
  if (clean.length >= 6) {
    return clean.substring(0, 3) + '******' + clean.substring(clean.length - 3);
  }
  return '******';
}

function parseBirthDate(dobStr) {
  if (!dobStr || typeof dobStr !== 'string') return null;
  const s = dobStr.trim();
  // YYYY-MM-DD hoặc YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
  }
  // DD/MM/YYYY hoặc DD-MM-YYYY
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    return { year: parseInt(m[3], 10), month: parseInt(m[2], 10), day: parseInt(m[1], 10) };
  }
  // YYYY
  m = s.match(/^(\d{4})$/);
  if (m) {
    return { year: parseInt(m[1], 10), month: 1, day: 1, yearOnly: true };
  }
  return null;
}

function calculateExactAge(birthDate, referenceDate = new Date()) {
  if (!birthDate) return null;
  const refYear = referenceDate.getFullYear();
  const refMonth = referenceDate.getMonth() + 1;
  const refDay = referenceDate.getDate();

  let age = refYear - birthDate.year;
  if (!birthDate.yearOnly) {
    if (refMonth < birthDate.month || (refMonth === birthDate.month && refDay < birthDate.day)) {
      age -= 1;
    }
  }
  return age;
}

function formatDateDisplay(dobStr) {
  const parsed = parseBirthDate(dobStr);
  if (!parsed) return dobStr || 'Chưa cập nhật';
  if (parsed.yearOnly) return String(parsed.year);
  const dd = String(parsed.day).padStart(2, '0');
  const mm = String(parsed.month).padStart(2, '0');
  return `${dd}/${mm}/${parsed.year}`;
}

const COLUMNS = [
  "job_grade", "employee_id", "full_name", "date_of_birth", "gender",
  "job_title", "professional_title", "department_staffing_plan", "section_staffing_plan",
  "citizen_id", "citizen_id_issue_date", "citizen_id_issue_place", "birth_registration_place",
  "place_of_origin", "permanent_address", "temporary_address", "current_address",
  "ethnicity", "education_level", "education_code", "qualification",
  "professional_qualification", "specialization", "degree_qualification",
  "training_institution", "major", "training_mode", "training_period",
  "graduation_grade", "degree_valid_until", "other_professional_certificates",
  "social_insurance_salary", "total_income", "base_salary",
  "productivity_responsibility_pay", "attendance_bonus", "responsibility_allowance",
  "vessel_size_allowance", "professional_allowance_t1", "meal_allowance", "other_allowances",
  "open_ended_contract", "fixed_term_contract", "seasonal_contract",
  "contract_start_date", "contract_end_date", "recruitment_decision_no",
  "employment_start_date", "official_labor_contract_sign_date", "phone_number",
  "email", "create_time", "file_name"
];

function buildStandardTable(rows, user = null) {
  const isAuthorizedStaff = user && (user.role === 'ADMIN' || user.role === 'HR');
  const tableRows = rows.map(r => {
    return COLUMNS.map(col => {
      if (col === 'employee_id') return r.employee_code || '';
      if (col === 'full_name') return r.employee_name || '';
      if (col === 'job_grade') {
        return r.job_grade || '';
      }
      if (col === 'employment_status') {
        return r.employment_status || (r.status === 'RESIGNED' ? 'RESIGNED' : 'ACTIVE');
      }
      if (col === 'citizen_id') return isAuthorizedStaff ? (r.citizen_id || '') : maskCccd(r.citizen_id);
      if (col === 'phone_number') return r.phone_number || '';
      if (col === 'email') return r.email || '';
      if (col === 'job_title') return r.job_title || r.position || '';
      if (col === 'department_staffing_plan') return r.department_staffing_plan || r.department || '';
      if (col === 'date_of_birth') return formatDateDisplay(r.date_of_birth);
      const val = r[col];
      return (val === undefined || val === null) ? '' : String(val);
    });
  });

  return {
    columns: COLUMNS,
    rows: tableRows
  };
}

/**
 * Helper: Xác định chi tiết trường thuộc tính nào trong 53 trường khớp với từ khóa tìm kiếm
 */
function findMatchingAttributeDetail(row, keyword) {
  if (!keyword || !row) return '';
  const kwNorm = removeAccents(String(keyword).trim());
  if (kwNorm.length < 2) return '';

  const checks = [
    { label: 'Họ và tên', val: row.employee_name || row.full_name },
    { label: 'Mã nhân viên', val: row.employee_code },
    { label: 'Số QĐ tuyển dụng', val: row.recruitment_decision_no },
    { label: 'Chức danh / Vị trí', val: row.job_title || row.position },
    { label: 'Chức danh chuyên môn', val: row.professional_title },
    { label: 'Phòng ban', val: row.department_staffing_plan || row.department },
    { label: 'Bộ phận định biên', val: row.section_staffing_plan },
    { label: 'Ngạch bậc', val: row.job_grade },
    { label: 'Cơ sở đào tạo', val: row.training_institution },
    { label: 'Chuyên ngành', val: row.major },
    { label: 'Ngành đào tạo', val: row.specialization },
    { label: 'Trình độ / Bằng cấp', val: row.qualification },
    { label: 'Trình độ chuyên môn', val: row.professional_qualification },
    { label: 'Văn bằng chứng chỉ', val: row.degree_qualification },
    { label: 'Trình độ văn hóa', val: row.education_level },
    { label: 'Hình thức đào tạo', val: row.training_mode },
    { label: 'Thời gian đào tạo', val: row.training_period },
    { label: 'Xếp loại tốt nghiệp', val: row.graduation_grade },
    { label: 'Thời hạn bằng', val: row.degree_valid_until },
    { label: 'Chứng chỉ chuyên môn khác', val: row.other_professional_certificates },
    { label: 'Quê quán', val: row.place_of_origin },
    { label: 'Nơi sinh', val: row.birth_registration_place },
    { label: 'Địa chỉ thường trú', val: row.permanent_address },
    { label: 'Nơi ở hiện nay', val: row.current_address },
    { label: 'Địa chỉ tạm trú', val: row.temporary_address },
    { label: 'Nơi cấp CCCD', val: row.citizen_id_issue_place },
    { label: 'Ngày cấp CCCD', val: row.citizen_id_issue_date },
    { label: 'Dân tộc', val: row.ethnicity },
    { label: 'Giới tính', val: row.gender },
    { label: 'Ngày sinh', val: row.date_of_birth },
    { label: 'Số điện thoại', val: row.phone_number },
    { label: 'Email', val: row.email },
    { label: 'Lương cơ bản', val: row.base_salary },
    { label: 'Lương đóng BHXH', val: row.social_insurance_salary },
    { label: 'Tổng thu nhập', val: row.total_income },
    { label: 'Lương năng suất / trách nhiệm', val: row.productivity_responsibility_pay },
    { label: 'Thưởng chuyên cần', val: row.attendance_bonus },
    { label: 'Phụ cấp trách nhiệm', val: row.responsibility_allowance },
    { label: 'Phụ cấp phương tiện', val: row.vessel_size_allowance },
    { label: 'Phụ cấp chuyên môn T1', val: row.professional_allowance_t1 },
    { label: 'Tiền ăn ca', val: row.meal_allowance },
    { label: 'Phụ cấp khác', val: row.other_allowances },
    { label: 'Hợp đồng không xác định thời hạn', val: row.open_ended_contract },
    { label: 'Hợp đồng xác định thời hạn', val: row.fixed_term_contract },
    { label: 'Hợp đồng thời vụ', val: row.seasonal_contract },
    { label: 'Ngày bắt đầu hợp đồng', val: row.contract_start_date },
    { label: 'Ngày kết thúc hợp đồng', val: row.contract_end_date },
    { label: 'Ngày ký HĐLĐ chính thức', val: row.official_labor_contract_sign_date },
    { label: 'Ngày vào làm việc', val: row.employment_start_date },
    { label: 'Tệp hồ sơ scan', val: row.file_name }
  ];

  for (const c of checks) {
    if (c.val && removeAccents(String(c.val)).includes(kwNorm)) {
      return `${c.label}: *${c.val}*`;
    }
  }
  return '';
}

/**
 * Phân tích chuyên sâu ý định truy vấn nhân sự qua hội thoại
 * Hỗ trợ toàn bộ 53 trường thông tin chuẩn hóa
 */
function parseIntent(rawMsg) {
  if (!rawMsg || typeof rawMsg !== 'string') return null;
  const msg = rawMsg.trim();
  const norm = removeAccents(msg);

  // 1. Loại trừ nhanh các ý định không liên quan đến tra cứu nhân sự
  if (
    norm.startsWith('tro giup') ||
    norm.startsWith('huong dan') ||
    norm.startsWith('help') ||
    norm.includes('chao ban') ||
    norm.includes('xin chao') ||
    norm.startsWith('hello') ||
    norm.includes('khoi phuc') ||
    norm.includes('restore') ||
    norm.includes('dong bo') ||
    norm.includes('sync') ||
    norm.includes('quy dinh') ||
    norm.includes('chinh sach') ||
    norm.includes('noi quy') ||
    norm.includes('quy che') ||
    norm.includes('van ban') ||
    norm.includes('thong tu') ||
    norm.includes('nghi dinh') ||
    norm.includes('luat lao dong')
  ) {
    return null;
  }

  const intent = {
    rawMsg: msg,
    normMsg: norm,
    isEmployeeQuery: false,
    isAggregation: false,
    isGroupQuery: false,
    groupByCompany: false,
    targetCode: null,
    targetCccd: null,
    targetPhone: null,
    targetEmail: null,
    targetName: null,
    targetAttr: null,
    companyFilter: null,
    departmentFilter: null,
    positionFilter: null,
    statusFilter: 'ACTIVE',
    explicitStatus: false,
    birthYear: null,
    ageFilter: null,
    recruitmentDecision: null,
    schoolFilter: null,
    majorFilter: null,
    qualificationFilter: null,
    placeFilter: null,
    genderFilter: null,
    fileFilter: null,
    certificateFilter: null,
    contractFilter: null,
    isUniversalMatch: false,
    universalKeyword: null
  };

  // Phát hiện yêu cầu thống kê / đếm số lượng
  if (
    /co\s*bao\s*nhieu|bao\s*nhieu\s*nguoi|bao\s*nhieu\s*nhan\s*(vien|su)|dem\s*so|thong\s*ke|tong\s*so\s*(nhan\s*vien|nhan\s*su)?/i.test(norm)
  ) {
    intent.isAggregation = true;
    intent.isEmployeeQuery = true;
  }

  // Phát hiện phân nhóm theo công ty
  if (/theo\s*cong\s*ty|theo\s*don\s*vi/i.test(norm)) {
    intent.groupByCompany = true;
    intent.isAggregation = true;
    intent.isEmployeeQuery = true;
  }

  // Phát hiện câu hỏi nhóm / liệt kê
  if (
    /nhung\s*nhan\s*vien\s*nao|nhan\s*vien\s*nao|nv\s*nao|ai\s*la|ai\s*dang\s*giu|ai\s*dang\s*lam|ai\s*lam|ai\s*la\s*ai|liet\s*ke|danh\s*sach|ds\s*(nhan\s*vien|nv)|cac\s*nhan\s*vien/i.test(norm)
  ) {
    intent.isGroupQuery = true;
    intent.isEmployeeQuery = true;
  }

  // -------------------------------------------------------------
  // Phát hiện thuộc tính cụ thể trong 53 trường dữ liệu chuẩn hóa
  // -------------------------------------------------------------
  // 1. Ngày sinh / Tuổi
  if (/ngay\s*sinh|sinh\s*ngay|ngay\s*thang\s*nam\s*sinh|sinh\s*nhat/i.test(norm)) {
    intent.targetAttr = 'dob';
  } else if (/bao\s*nhieu\s*tuoi|may\s*tuoi|tuoi\s*tac/i.test(norm)) {
    intent.targetAttr = 'age';
  }
  // 2. Liên lạc
  else if (/so\s*(dien\s*thoai|dt)|sdt|dien\s*thoai|phone|di\s*dong/i.test(norm)) {
    intent.targetAttr = 'phone';
  } else if (/email|mail|thu\s*dien\s*tu|hom\s*thu/i.test(norm)) {
    intent.targetAttr = 'email';
  }
  // 3. Quê quán / Nơi sinh / Nơi ở
  else if (/que\s*(quan|o\s*dau)|nguyen\s*quan/i.test(norm)) {
    intent.targetAttr = 'place_of_origin';
  } else if (/noi\s*sinh|khai\s*sinh/i.test(norm)) {
    intent.targetAttr = 'birth_registration_place';
  } else if (/thuong\s*tru|ho\s*khau/i.test(norm)) {
    intent.targetAttr = 'permanent_address';
  } else if (/tam\s*tru/i.test(norm)) {
    intent.targetAttr = 'temporary_address';
  } else if (/dia\s*chi|noi\s*o|cho\s*o|cho\s*o\s*hien\s*nay|hien\s*o\s*dau/i.test(norm)) {
    intent.targetAttr = 'current_address';
  }
  // 4. CCCD / Định danh
  else if (/ngay\s*cap\s*(?:cccd|cmnd|can\s*cuoc)/i.test(norm)) {
    intent.targetAttr = 'citizen_id_issue_date';
  } else if (/noi\s*cap\s*(?:cccd|cmnd|can\s*cuoc)/i.test(norm)) {
    intent.targetAttr = 'citizen_id_issue_place';
  } else if (/cccd|cmnd|can\s*cuoc|dinh\s*danh/i.test(norm)) {
    intent.targetAttr = 'citizen_id';
  }
  // 5. Giới tính / Dân tộc
  else if (/gioi\s*tinh|nam\s*hay\s*nu/i.test(norm)) {
    intent.targetAttr = 'gender';
  } else if (/dan\s*toc/i.test(norm)) {
    intent.targetAttr = 'ethnicity';
  }
  // 6. Vị trí / Công tác / Phòng ban
  else if (/chuc\s*(vu|danh)|vi\s*tri|lam\s*(chuc\s*vu\s*)?gi|cong\s*viec/i.test(norm)) {
    intent.targetAttr = 'job_title';
  } else if (/chuc\s*danh\s*chuyen\s*mon|chuyen\s*mon/i.test(norm)) {
    intent.targetAttr = 'professional_title';
  } else if (/phong\s*ban|bo\s*phan|don\s*vi|lam\s*o\s*dau/i.test(norm)) {
    intent.targetAttr = 'department';
  } else if (/to\s*doi|phan\s*xuong|dinh\s*bien/i.test(norm)) {
    intent.targetAttr = 'section_staffing_plan';
  } else if (/ngach\s*(luong|bac)|bac\s*luong|cap\s*bac/i.test(norm)) {
    intent.targetAttr = 'job_grade';
  } else if (/ma\s*(nv|nhan\s*vien|so)/i.test(norm)) {
    intent.targetAttr = 'employee_id';
  } else if (/trang\s*thai|nghi\s*viec\s*chua|con\s*lam\s*(viec\s*)?khong|da\s*bi\s*xoa\s*chua/i.test(norm)) {
    intent.targetAttr = 'status';
  }
  // 7. Học vấn / Trình độ / Bằng cấp / Chứng chỉ
  else if (/truong\s+(?:hoc|dao\s*tao)|tot\s*nghiep\s+(?:truong\s+|o\s+)?nao|hoc\s+(?:truong\s+|o\s+)?nao|co\s*so\s*dao\s*tao/i.test(norm)) {
    intent.targetAttr = 'training_institution';
  } else if (/chuyen\s*nganh|nganh\s*hoc|nganh\s*gi/i.test(norm)) {
    intent.targetAttr = 'major';
  } else if (/nganh\s*dao\s*tao|chuyen\s*mon\s*sau/i.test(norm)) {
    intent.targetAttr = 'specialization';
  } else if (/trinh\s*do\s*van\s*hoa|van\s*hoa/i.test(norm)) {
    intent.targetAttr = 'education_level';
  } else if (/xep\s*loai|loai\s*tot\s*nghiep/i.test(norm)) {
    intent.targetAttr = 'graduation_grade';
  } else if (/hinh\s*thuc\s*dao\s*tao|he\s*dao\s*tao|chinh\s*quy/i.test(norm)) {
    intent.targetAttr = 'training_mode';
  } else if (/thoi\s*gian\s*dao\s*tao|khoa\s*hoc/i.test(norm)) {
    intent.targetAttr = 'training_period';
  } else if (/han\s*bang|thoi\s*han\s*bang/i.test(norm)) {
    intent.targetAttr = 'degree_valid_until';
  } else if (/bang\s*(cap)?|trinh\s*do|hoc\s*vi/i.test(norm)) {
    intent.targetAttr = 'qualification';
  } else if (/chung\s*chi\s*khac|bang\s*lai|chung\s*chi/i.test(norm)) {
    intent.targetAttr = 'other_professional_certificates';
  }
  // 8. Lương bổng & Phụ cấp
  else if (/luong\s*co\s*ban|muc\s*luong|tien\s*luong|luong/i.test(norm)) {
    intent.targetAttr = 'base_salary';
  } else if (/luong\s*(dong\s*)?bhxh|luong\s*bao\s*hiem|muc\s*dong\s*bh/i.test(norm)) {
    intent.targetAttr = 'social_insurance_salary';
  } else if (/tong\s*thu\s*nhap|thu\s*nhap|tong\s*luong/i.test(norm)) {
    intent.targetAttr = 'total_income';
  } else if (/luong\s*nang\s*suat|phu\s*cap\s*nang\s*suat/i.test(norm)) {
    intent.targetAttr = 'productivity_responsibility_pay';
  } else if (/chuyen\s*can/i.test(norm)) {
    intent.targetAttr = 'attendance_bonus';
  } else if (/phu\s*cap\s*trach\s*nhiem/i.test(norm)) {
    intent.targetAttr = 'responsibility_allowance';
  } else if (/phu\s*cap\s*phuong\s*tien|phu\s*cap\s*trong\s*tai/i.test(norm)) {
    intent.targetAttr = 'vessel_size_allowance';
  } else if (/phu\s*cap\s*t1/i.test(norm)) {
    intent.targetAttr = 'professional_allowance_t1';
  } else if (/tien\s*an|an\s*ca|phu\s*cap\s*an|com\s*trua/i.test(norm)) {
    intent.targetAttr = 'meal_allowance';
  } else if (/phu\s*cap/i.test(norm)) {
    intent.targetAttr = 'other_allowances';
  }
  // 9. Hợp đồng & Quyết định
  else if (/so\s*quyet\s*dinh|quyet\s*dinh\s*tuyen\s*dung|quyet\s*dinh|qd/i.test(norm)) {
    intent.targetAttr = 'recruitment_decision_no';
  } else if (/loai\s*hop\s*dong|hop\s*dong\s*(lao\s*dong)?/i.test(norm)) {
    intent.targetAttr = 'contract';
  } else if (/ngay\s*(vao|bat\s*dau)\s*lam/i.test(norm)) {
    intent.targetAttr = 'employment_start_date';
  } else if (/ngay\s*het\s*han\s*hop\s*dong|thoi\s*han\s*hop\s*dong/i.test(norm)) {
    intent.targetAttr = 'contract_end_date';
  } else if (/ngay\s*ky\s*hop\s*dong/i.test(norm)) {
    intent.targetAttr = 'contract_start_date';
  } else if (/file|tep|ho\s*so\s*goc|pdf/i.test(norm)) {
    intent.targetAttr = 'file_name';
  }

  if (intent.targetAttr) intent.isEmployeeQuery = true;

  // Phát hiện trạng thái lọc
  if (/nghi\s*viec|thoi\s*viec|cham\s*dut/i.test(norm)) {
    intent.statusFilter = 'RESIGNED';
    intent.explicitStatus = true;
    intent.isEmployeeQuery = true;
  } else if (/xoa\s*mem|da\s*xoa|bi\s*xoa/i.test(norm)) {
    intent.statusFilter = 'DELETED';
    intent.explicitStatus = true;
    intent.isEmployeeQuery = true;
  } else if (/dang\s*lam\s*viec|con\s*lam\s*viec|active/i.test(norm)) {
    intent.statusFilter = 'ACTIVE';
    intent.explicitStatus = true;
    intent.isEmployeeQuery = true;
  }

  // Phát hiện công ty / đơn vị
  if (/\bswc\b|sowatco|duong\s*song\s*mien\s*nam/i.test(norm)) {
    intent.companyFilter = 'SWC';
    intent.isEmployeeQuery = true;
  } else if (/\bstl\b|sotrans|kho\s*van\s*mien\s*nam/i.test(norm)) {
    intent.companyFilter = 'STL';
    intent.isEmployeeQuery = true;
  } else if (/\bvtx\b|vietranstimex|van\s*tai\s*da\s*phuong\s*thuc/i.test(norm)) {
    intent.companyFilter = 'VTX';
    intent.isEmployeeQuery = true;
  }

  // Phát hiện năm sinh (e.g. "sinh năm 2005", "năm sinh 2005", "sinh 2005")
  const yMatch = norm.match(/(?:sinh\s*nam|nam\s*sinh|sinh)\s*(\d{4})\b/i);
  if (yMatch) {
    intent.birthYear = parseInt(yMatch[1], 10);
    intent.isEmployeeQuery = true;
  }

  // Phát hiện độ tuổi:
  // - "dưới X tuổi", "nhỏ hơn X tuổi", "< X tuổi"
  const underAgeMatch = norm.match(/(?:duoi|nho\s*hon|<\s*)\s*(\d{1,2})\s*tuoi/i);
  if (underAgeMatch) {
    intent.ageFilter = { op: '<', val: parseInt(underAgeMatch[1], 10) };
    intent.isEmployeeQuery = true;
  }

  // - "trên X tuổi", "lớn hơn X tuổi", "> X tuổi"
  const overAgeMatch = norm.match(/(?:tren|lon\s*hon|>\s*)\s*(\d{1,2})\s*tuoi/i);
  if (overAgeMatch) {
    intent.ageFilter = { op: '>', val: parseInt(overAgeMatch[1], 10) };
    intent.isEmployeeQuery = true;
  }

  // - "từ X đến Y tuổi"
  const betweenAgeMatch = norm.match(/tu\s*(\d{1,2})\s*(?:den|toi|-)\s*(\d{1,2})\s*tuoi/i);
  if (betweenAgeMatch) {
    intent.ageFilter = {
      op: 'BETWEEN',
      val: [parseInt(betweenAgeMatch[1], 10), parseInt(betweenAgeMatch[2], 10)]
    };
    intent.isEmployeeQuery = true;
  }

  // - "đúng X tuổi", "đủ X tuổi", "tròn X tuổi"
  const exactAgeMatch = norm.match(/(?:dung|du|tron)\s*(\d{1,2})\s*tuoi/i);
  if (exactAgeMatch) {
    intent.ageFilter = { op: '=', val: parseInt(exactAgeMatch[1], 10) };
    intent.isEmployeeQuery = true;
  }

  // Phát hiện phòng ban cụ thể
  const deptMatch = norm.match(/(?:phong|bo\s*phan|ban)\s+([a-z0-9\s\-_]+?)(?=\s*(?:cua|thuoc|o|sinh|duoi|tren|co|la|\?|$))/i);
  if (deptMatch) {
    const rawDept = deptMatch[1].trim();
    const ignoredDeptWords = ['ban', 'nao', 'gi', 'o dau', 'cua ai'];
    if (rawDept.length >= 2 && !ignoredDeptWords.includes(rawDept)) {
      intent.departmentFilter = rawDept;
      intent.isEmployeeQuery = true;
    }
  }

  // Phát hiện chức danh / vị trí cụ thể
  const posKeywords = [
    'thuyen pho', 'thuyen truong', 'tho may', 'lai xe cont', 'lai xe',
    'chuyen vien dieu do', 'chuyen vien hai quan', 'chuyen vien logistics', 'chuyen vien nhan su', 'chuyen vien',
    'ky su van tai', 'ky su', 'nhan vien khai thac',
    'truong phong', 'pho giam doc', 'giam doc'
  ];
  for (const pk of posKeywords) {
    if (norm.includes(pk)) {
      intent.positionFilter = pk;
      intent.isEmployeeQuery = true;
      break;
    }
  }

  // Trích xuất mã nhân viên (không khớp nếu là phần tên tệp .pdf/.docx)
  const codeMatch = msg.match(/\b([A-Za-z]{2,5}(?:[-_][A-Za-z0-9]+)*[-_]\d{1,6}|[A-Za-z]{2,5}\d{3,6})(?!\.[A-Za-z0-9]+)\b/i);
  if (codeMatch) {
    intent.targetCode = codeMatch[1].trim();
    intent.isEmployeeQuery = true;
  }

  // Trích xuất CCCD (9 hoặc 12 số)
  const cccdMatch = msg.match(/\b(\d{12}|\d{9})\b/);
  if (cccdMatch) {
    intent.targetCccd = cccdMatch[1];
    intent.isEmployeeQuery = true;
  }

  // Trích xuất số điện thoại (10 số bắt đầu bằng 0)
  const phoneMatch = msg.match(/\b(0\d{9})\b/);
  if (phoneMatch) {
    intent.targetPhone = phoneMatch[1];
    intent.isEmployeeQuery = true;
  }

  // Trích xuất Email
  const emailMatch = msg.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch) {
    intent.targetEmail = emailMatch[0];
    intent.isEmployeeQuery = true;
  }

  // Trích xuất số quyết định tuyển dụng (chỉ khi có số quyết định thực tế dạng 174/QĐ-DSMN hoặc chứa số)
  const decisionMatch = msg.match(/\b(\d+[\s\-_/]+Q[ĐD][-_/\s]?[A-Za-zĐđ0-9]+)\b/i) ||
                        msg.match(/(?:quyết\s*định|quyet\s*dinh|qđ|qd)(?:\s*(?:tuyển\s*dụng|tuyen\s*dung|số|so))?\s*[:\s#]?\s*([A-Za-z0-9/\-_]{2,})/i);
  if (decisionMatch) {
    const decVal = decisionMatch[1].trim();
    const decValNorm = removeAccents(decVal);
    const ignoredDecWords = ['nao', 'gi', 'may', 'bao nhieu', 'tuyen dung', 'tuyen', 'dung', 'so', 'la', 'tuy'];
    if (decVal.length >= 2 && !ignoredDecWords.includes(decValNorm) && (/\d/.test(decVal) || decVal.includes('/'))) {
      intent.recruitmentDecision = decVal;
      intent.isEmployeeQuery = true;
    }
  }

  // Trích xuất tên tệp hồ sơ (e.g. "SWC00814.pdf", "SWC00811.pdf")
  const fileMatch = msg.match(/\b([A-Za-z0-9_\-]+\.(?:pdf|docx|xlsx|doc|png|jpg))\b/i);
  if (fileMatch) {
    intent.fileFilter = fileMatch[1].trim();
    intent.isEmployeeQuery = true;
  }

  // Trích xuất cơ sở đào tạo / trường học
  const schoolMatch = msg.match(/(?:^|\s)(?:tốt\s*nghiệp|tot\s*nghiep|học\s*(?:ở\s*trường|tai\s*truong|o\s*truong|tại\s*trường|trường|truong)?|hoc\s*(?:ở\s*trường|tai\s*truong|o\s*truong|tại\s*trường|trường|truong)?)\s*(?:đại\s*học|dai\s*hoc|cao\s*đẳng|cao\s*dang|trung\s*cấp|trung\s*cap)\s+([a-z0-9\s,\-–_àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệđìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]+?)(?=\s*(?:ngành|khoa|chuyên|thuộc|thuoc|sinh|là|la|\?|$))/i) ||
                      msg.match(/(?:^|\s)(?:tốt\s*nghiệp|tot\s*nghiep|học\s*ở\s*trường|hoc\s*o\s*truong|học\s*tại\s*trường|hoc\s*tai\s*truong|học\s*trường|hoc\s*truong)\s+([a-z0-9\s,\-–_àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệđìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]+?)(?=\s*(?:ngành|khoa|chuyên|thuộc|thuoc|sinh|là|la|\?|$))/i);
  if (schoolMatch) {
    const rawSchool = schoolMatch[1].trim();
    if (/\b(?:nào|nao|gì|gi|ở đâu|o dau)\b/i.test(rawSchool)) {
      intent.targetAttr = intent.targetAttr || 'training_institution';
      intent.isEmployeeQuery = true;
    } else if (rawSchool.length >= 3) {
      intent.schoolFilter = rawSchool;
      intent.isEmployeeQuery = true;
    }
  }

  // Trích xuất chuyên ngành
  const majorMatch = msg.match(/(?:^|\s)(?:chuyên\s*ngành|chuyen\s*nganh|ngành\s*học|nganh\s*hoc|ngành|nganh)\s+([a-z0-9\s,\-–_àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệđìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]+?)(?=\s*(?:thuộc|thuoc|sinh|là|la|\?|$))/i);
  if (majorMatch) {
    const rawMajor = majorMatch[1].trim();
    if (/\b(?:nào|nao|gì|gi)\b/i.test(rawMajor)) {
      intent.targetAttr = intent.targetAttr || 'major';
      intent.isEmployeeQuery = true;
    } else if (rawMajor.length >= 3) {
      intent.majorFilter = rawMajor;
      intent.isEmployeeQuery = true;
    }
  }

  // Trích xuất trình độ học vấn / bằng cấp
  if (norm.includes('dai hoc') || norm.includes('đại học')) {
    intent.qualificationFilter = 'Đại học';
    intent.isEmployeeQuery = true;
  } else if (norm.includes('cao dang') || norm.includes('cao đẳng')) {
    intent.qualificationFilter = 'Cao đẳng';
    intent.isEmployeeQuery = true;
  } else if (norm.includes('thac si') || norm.includes('thạc sĩ')) {
    intent.qualificationFilter = 'Thạc sĩ';
    intent.isEmployeeQuery = true;
  } else if (norm.includes('tien si') || norm.includes('tiến sĩ')) {
    intent.qualificationFilter = 'Tiến sĩ';
    intent.isEmployeeQuery = true;
  } else if (norm.includes('trung cap') || norm.includes('trung cấp')) {
    intent.qualificationFilter = 'Trung cấp';
    intent.isEmployeeQuery = true;
  } else if (norm.includes('12/12')) {
    intent.qualificationFilter = '12/12';
    intent.isEmployeeQuery = true;
  }

  // Trích xuất quê quán / nơi sinh / địa chỉ
  const placeMatch = msg.match(/(?:^|\s)(?:quê\s*quán|que\s*quan|quê\s*ở|que\s*o|nguyên\s*quán|nguyen\s*quan|nơi\s*sinh|noi\s*sinh|địa\s*chỉ|dia\s*chi|thường\s*trú|thuong\s*tru|tạm\s*trú|tam\s*tru|sống\s*ở|song\s*o|sống\s*tại|song\s*tai|tại\s*đường|tai\s*duong|ở\s+đường|o\s+duong|ở\s+phố|o\s+pho|ai\s+ở|ai\s+o|ở|o)\s+([a-z0-9\s,/\-–_àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệđìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]+?)(?=\s*(?:không|khong|làm|lam|thuộc|thuoc|sinh|là|la|\?|$))/i);
  if (placeMatch) {
    const rawPlace = placeMatch[1].trim();
    if (/^(?:của|cua)\s+/i.test(rawPlace)) {
      intent.targetAttr = intent.targetAttr || 'place_of_origin';
      intent.isEmployeeQuery = true;
    } else {
      let cleanPlace = rawPlace.replace(/^(?:đường|duong|phố|pho|tại|tai|ở|o|khu\s*vực|khu\s*vuc|khu|tỉnh|tinh|thành\s*phố|thanh\s*pho|tp\.?|tx\.?|quận|quan|huyện|huyen|thị\s*trấn|thi\s*tran|thị\s*xã|thi\s*xa|xã|xa|phường|phuong)\s+/i, '').trim();
      const ignoredPlace = ['đâu', 'dau', 'nào', 'nao', 'gì', 'gi', 'đây', 'day', 'công ty', 'cong ty', 'swc', 'stl', 'vtx', 'sotrans', 'sowatco', 'phòng ban', 'phong ban', 'bộ phận', 'bo phan', 'hệ thống', 'he thong'];
      if (cleanPlace.length >= 2 && !ignoredPlace.includes(cleanPlace.toLowerCase())) {
        intent.placeFilter = cleanPlace;
        intent.isEmployeeQuery = true;
      }
    }
  }

  // Trích xuất giới tính
  if (/\b(?:nhan\s*vien\s*nu|la\s*nu|phu\s*nu|chi\s*em|gioi\s*tinh\s*nu)\b/i.test(norm)) {
    intent.genderFilter = 'Nữ';
    intent.isEmployeeQuery = true;
  } else if (/\b(?:nhan\s*vien\s*nam|la\s*nam|gioi\s*tinh\s*nam|nam\s*gioi)\b/i.test(norm)) {
    intent.genderFilter = 'Nam';
    intent.isEmployeeQuery = true;
  }

  // Trích xuất chứng chỉ chuyên môn
  const certMatch = msg.match(/(?:^|\s)(?:chứng\s*chỉ|chung\s*chi|bằng\s*chuyên\s*môn|bang\s*chuyen\s*mon)\s+([a-z0-9\s,\-–_àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệđìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]+?)(?=\s*(?:không|khong|thuộc|thuoc|sinh|là|la|\?|$))/i);
  if (certMatch) {
    const rawCert = certMatch[1].trim();
    if (rawCert.length >= 2 && !['nào', 'nao', 'gì', 'gi'].includes(rawCert.toLowerCase())) {
      intent.certificateFilter = rawCert;
      intent.isEmployeeQuery = true;
    }
  }
  if (!intent.certificateFilter) {
    if (norm.includes('phuong tien thuy') || norm.includes('hang tm') || norm.includes('hang t1')) {
      intent.certificateFilter = 'phương tiện thủy nội địa';
      intent.isEmployeeQuery = true;
    }
  }

  // Trích xuất loại hợp đồng
  if (norm.includes('khong xac dinh thoi han') || norm.includes('vo thoi han')) {
    intent.contractFilter = 'open_ended';
    intent.isEmployeeQuery = true;
  } else if (norm.includes('xac dinh thoi han') || norm.includes('co thoi han')) {
    intent.contractFilter = 'fixed_term';
    intent.isEmployeeQuery = true;
  } else if (norm.includes('thoi vu') || norm.includes('mua vu')) {
    intent.contractFilter = 'seasonal';
    intent.isEmployeeQuery = true;
  }

  // Trích xuất tên người (chỉ trích xuất khi không phải truy vấn nhóm/thống kê thuần túy theo thuộc tính hoặc trạng thái)
  const isBroadQuery = intent.ageFilter || intent.birthYear || (intent.isAggregation && !intent.targetCode) || 
                       intent.explicitStatus || intent.targetEmail ||
                       intent.recruitmentDecision || intent.schoolFilter || intent.majorFilter ||
                       intent.qualificationFilter || intent.placeFilter || intent.genderFilter ||
                       intent.fileFilter || intent.certificateFilter || intent.contractFilter ||
                       (intent.isGroupQuery && (intent.companyFilter || intent.departmentFilter || intent.positionFilter)) ||
                       (intent.positionFilter && /^(ai|nhung ai|ai dang|ai lam|co ai)\b/i.test(norm)) ||
                       (intent.departmentFilter && /^(ai|nhung ai|ai dang|ai lam|co ai)\b/i.test(norm));

  if (!intent.targetCode && !intent.targetCccd && !intent.targetPhone && !intent.targetEmail && !isBroadQuery) {
    let clean = msg.replace(/[?!.:,;]+$/g, '').trim();

    // 1. Loại bỏ các tiền tố câu hỏi (Prefix Stripping)
    let prefixChanged = true;
    while (prefixChanged) {
      const prev = clean;
      clean = clean
        .replace(/^(hãy\s+cho\s+tôi\s+biết|hay\s+cho\s+toi\s+biet|cho\s+tôi\s+biết|cho\s+toi\s+biet|hãy\s+cho\s+tôi\s+xin|hay\s+cho\s+toi\s+xin|cho\s+tôi\s+xin|cho\s+toi\s+xin|vui\s+lòng\s+cho\s+tôi\s+biết|vui\s+long\s+cho\s+toi\s+biet|xin\s+cho\s+biết|xin\s+cho\s+biet|cho\s+biết|cho\s+biet|liệt\s+kê\s+nhân\s+viên|liet\s+ke\s+nhan\s+vien|liệt\s+kê|liet\s+ke|danh\s+sách\s+nhân\s+viên|danh\s+sach\s+nhan\s+vien|danh\s+sách|danh\s+sach|ds\s+nhân\s+viên|ds\s+nhan\s+vien|ds\s+nv|ds|những\s+nhân\s+viên|nhung\s+nhan\s+vien|các\s+nhân\s+viên|cac\s+nhan\s+vien|tìm\s+thông\s+tin\s+của|tim\s+thong\s+tin\s+cua|tìm\s+nhân\s+viên|tim\s+nhan\s+vien|tra\s+cứu\s+nhân\s+viên|tra\s+cuu\s+nhan\s+vien|tra\s+cứu\s+hồ\s+sơ|tra\s+cuu\s+ho\s+so|hồ\s+sơ\s+nhân\s+viên|ho\s+so\s+nhan\s+vien|hồ\s+sơ\s+của|ho\s+so\s+cua|hồ\s+sơ|ho\s+so|thông\s+tin\s+về|thong\s+tin\s+ve|thông\s+tin\s+nhân\s+viên|thong\s+tin\s+nhan\s+vien|thông\s+tin\s+nhân\s+sự|thong\s+tin\s+nhan\s+su|thông\s+tin\s+của|thong\s+tin\s+cua|thông\s+tin|thong\s+tin)\s+/i, '')
        .replace(/^(số\s+điện\s+thoại|so\s+dien\s+thoai|sđt|sdt|email|địa\s+chỉ|dia\s+chi|quê\s+quán|que\s+quan|quê|que|nơi\s+sinh|noi\s+sinh|ngày\s+sinh|ngay\s+sinh|năm\s+sinh|nam\s+sinh|phòng\s+ban|phong\s+ban|chức\s+vụ|chuc\s+vu|chức\s+danh|chuc\s+danh|mã\s+nhân\s+viên|ma\s+nhan\s+vien|mã\s+nv|ma\s+nv|trạng\s+thái|trang\s+thai|lương|luong|thu\s+nhập|thu\s+nhap|hợp\s+đồng|hop\s+dong|quyết\s+định|quyet\s+dinh)\s+(của|thuộc|cua|thuoc)\s+/i, '')
        .replace(/^(của|thuộc|cua|thuoc|nhân\s+viên|nhan\s+vien|nhân\s+sự|nhan\s+su|ai\s+ở|ai\s+o|ai\s+có|ai\s+co|ai\s+học|ai\s+hoc|ai\s+tại|ai\s+tai|ai\s+làm|ai\s+lam|ai\s+là|ai\s+la|ai|anh|chị|chi|ông|ong|bà|ba|bạn|ban|đ\/c|đồng\s+chí|dong\s+chi)\s+/i, '')
        .trim();
      prefixChanged = (clean !== prev);
    }

    // 2. Loại bỏ các hậu tố câu hỏi (Suffix Stripping mở rộng toàn diện cho 53 trường)
    let suffixChanged = true;
    while (suffixChanged) {
      const prev = clean;
      clean = clean
        .replace(/[?!.:,;]+$/g, '')
        // Hậu tố về ngày sinh, năm sinh, độ tuổi
        .replace(/\s+(?:sinh\s*)?(?:ngày|tháng|năm)?\s*(?:mấy|nào|bao\s*nhiêu|gì)$/i, '')
        .replace(/\s+ngày\s*sinh\s*(?:là\s*)?(?:gì|mấy|nào|bao\s*nhiêu)$/i, '')
        .replace(/\s+năm\s*sinh\s*(?:là\s*)?(?:gì|mấy|nào|bao\s*nhiêu)$/i, '')
        .replace(/\s+(?:bao\s*nhiêu\s*tuổi|mấy\s*tuổi|tuổi\s*bao\s*nhiêu)$/i, '')
        // Hậu tố về quê quán, nơi sinh, địa chỉ, cư trú
        .replace(/\s+quê\s*(?:quán\s*)?(?:ở\s*đâu|là\s*ở\s*đâu|là\s*gì|ở\s*tỉnh\s*nào|ở\s*đâu\s*vậy)$/i, '')
        .replace(/\s+nơi\s*sinh\s*(?:ở\s*đâu|là\s*ở\s*đâu|là\s*gì|ở\s*tỉnh\s*nào)$/i, '')
        .replace(/\s+địa\s*chỉ\s*(?:ở\s*đâu|là\s*ở\s*đâu|là\s*gì|thường\s*trú\s*ở\s*đâu|tạm\s*trú\s*ở\s*đâu)$/i, '')
        .replace(/\s+nơi\s*ở\s*(?:hiện\s*nay|ở\s*đâu|là\s*gì)$/i, '')
        .replace(/\s+thường\s*trú\s*(?:ở\s*đâu|tại\s*đâu)$/i, '')
        .replace(/\s+tạm\s*trú\s*(?:ở\s*đâu|tại\s*đâu)$/i, '')
        // Hậu tố về vị trí, chức vụ, phòng ban, công việc
        .replace(/\s+chức\s*vụ\s*(?:gì|là\s*gì|nào)$/i, '')
        .replace(/\s+chức\s*danh\s*(?:gì|là\s*gì|nào)$/i, '')
        .replace(/\s+làm\s*(?:chức\s*vụ\s*gì|vị\s*trí\s*gì|công\s*việc\s*gì|nghề\s*gì|gì|ở\s*đâu|việc\s*gì)$/i, '')
        .replace(/\s+(?:thuộc\s*)?phòng\s*ban\s*(?:nào|gì|ở\s*đâu)$/i, '')
        .replace(/\s+(?:thuộc\s*)?bộ\s*phận\s*(?:nào|gì)$/i, '')
        .replace(/\s+làm\s*việc\s*(?:ở\s*đâu|tại\s*đâu)$/i, '')
        .replace(/\s+công\s*tác\s*(?:ở\s*đâu|tại\s*đâu)$/i, '')
        // Hậu tố về liên lạc, định danh
        .replace(/\s+số\s*điện\s*thoại\s*(?:là\s*)?(?:gì|mấy|bao\s*nhiêu)$/i, '')
        .replace(/\s+sđt\s*(?:là\s*)?(?:gì|mấy|bao\s*nhiêu)$/i, '')
        .replace(/\s+email\s*(?:là\s*)?(?:gì|nào)$/i, '')
        .replace(/\s+số\s*cccd\s*(?:là\s*)?(?:gì|mấy|bao\s*nhiêu)$/i, '')
        .replace(/\s+cccd\s*(?:số\s*mấy|là\s*gì)$/i, '')
        .replace(/\s+ngày\s*cấp\s*cccd\s*(?:khi\s*nào|ngày\s*mấy)$/i, '')
        .replace(/\s+nơi\s*cấp\s*cccd\s*(?:ở\s*đâu|là\s*gì)$/i, '')
        // Hậu tố về lương bổng, phụ cấp
        .replace(/\s+lương\s*(?:bao\s*nhiêu|cơ\s*bản\s*bao\s*nhiêu|là\s*bao\s*nhiêu)$/i, '')
        .replace(/\s+thu\s*nhập\s*(?:bao\s*nhiêu|là\s*bao\s*nhiêu)$/i, '')
        .replace(/\s+phụ\s*cấp\s*(?:bao\s*nhiêu|gì|là\s*gì)$/i, '')
        .replace(/\s+tiền\s*ăn\s*(?:bao\s*nhiêu|có\s*không)$/i, '')
        // Hậu tố về học vấn, bằng cấp, chứng chỉ
        .replace(/\s+tốt\s*nghiệp\s*(?:ở\s+|tai\s+|tại\s+|trường\s+)?(?:trường\s+)?(?:nào|ở\s*đâu|gì|loại\s*gì)$/i, '')
        .replace(/\s+học\s*(?:ở\s+|tai\s+|tại\s+|trường\s+)?(?:trường\s+)?(?:nào|ở\s*đâu|gì)$/i, '')
        .replace(/\s+học\s*ngành\s*(?:gì|nào)$/i, '')
        .replace(/\s+chuyên\s*ngành\s*(?:gì|nào|là\s*gì)$/i, '')
        .replace(/\s+bằng\s*cấp\s*(?:gì|là\s*gì)$/i, '')
        .replace(/\s+trình\s*độ\s*(?:gì|học\s*vấn\s*gì|là\s*gì)$/i, '')
        .replace(/\s+chứng\s*chỉ\s*(?:gì|nào|chuyên\s*môn\s*gì)$/i, '')
        // Hậu tố về hợp đồng, quyết định, ngày vào làm
        .replace(/\s+hợp\s*đồng\s*(?:gì|loại\s*gì|khi\s*nào\s*hết\s*hạn)$/i, '')
        .replace(/\s+loại\s*hợp\s*đồng\s*(?:là\s*gì|gì)$/i, '')
        .replace(/\s+quyết\s*định\s*tuyển\s*dụng\s*(?:số\s*mấy|là\s*gì|nào)$/i, '')
        .replace(/\s+số\s*quyết\s*định\s*(?:là\s*gì|số\s*mấy)$/i, '')
        .replace(/\s+vào\s*làm\s*(?:ngày\s*nào|khi\s*nào|năm\s*nào|bao\s*giờ)$/i, '')
        .replace(/\s+ngày\s*vào\s*làm\s*(?:là\s*)?(?:khi\s*nào|ngày\s*mấy|nào)$/i, '')
        // Hậu tố về trạng thái
        .replace(/\s+(?:đã\s+nghỉ\s+việc\s+chưa|nghỉ\s+việc\s+chưa|còn\s+làm\s+việc\s+không|con\s+lam\s+khong|còn\s+làm\s+không|đã\s+bị\s+xóa\s+chưa|trạng\s+thái\s+là\s+gì)$/i, '')
        .replace(/\s+(?:dân\s*tộc\s*gì|giới\s*tính\s*gì|là\s*nam\s*hay\s*nữ)$/i, '')
        .replace(/\s+(?:mã\s*nhân\s*viên\s*là\s*(?:gì|mấy)|mã\s*nv\s*là\s*(?:gì|mấy))$/i, '')
        .replace(/\s+(?:là\s+ai|là\s+gì|là\s+bao\s+nhiêu|là\s+mấy|ở\s+đâu)$/i, '')
        .replace(/\s+(?:thuộc|ở|tại)\s+(?:công\s+ty\s+)?(?:swc|stl|vtx|sowatco|sotrans|vietranstimex)$/i, '')
        .trim();
      suffixChanged = (clean !== prev);
    }

    const cleanNorm = removeAccents(clean);
    const stopWords = [
      'ai', 'gi', 'dau', 'nao', 'khong', 'sao', 'ha', 'chua', 'ta', 'minh', 'toi',
      'phong van tai', 'phong khai thac', 'van tai', 'khai thac', 'swc', 'stl', 'vtx',
      'thuyen pho', 'tho may', 'chuyen vien', 'lai xe', 'cong ty swc', 'cong ty stl', 'cong ty vtx',
      'da nghi viec', 'da xoa mem', 'nghi viec', 'xoa mem'
    ];

    if (clean.length >= 2 && !stopWords.includes(cleanNorm) && !cleanNorm.includes('phong ban') && !cleanNorm.includes('chuc danh')) {
      intent.targetName = clean;
      intent.isEmployeeQuery = true;
    }
  }

  const generalKeywords = [
    'thong tin ve', 'thong tin nhan vien', 'thong tin nhan su', 'thong tin cua',
    'tim nhan vien', 'tim nhan su', 'tra cuu nhan vien', 'tra cuu nhan su',
    'ho so nhan vien', 'ho so nhan su', 'ho so cua', 'nhan vien', 'nhan su',
    'so dien thoai', 'sdt', 'ngay sinh', 'chuc vu', 'phong ban', 'cong ty'
  ];
  if (generalKeywords.some(kw => norm.includes(kw))) {
    intent.isEmployeeQuery = true;
  }

  return intent;
}

/**
 * Handle Conversational Employee Lookup Intent
 * Grounded 100% in PostgreSQL System of Record
 */
async function handleEmployeeLookupIntent(user = {}, message = '', ipAddress = '127.0.0.1') {
  if (!message || typeof message !== 'string') return null;

  const intent = parseIntent(message);
  if (!intent || !intent.isEmployeeQuery) {
    return null; // Fallback cho câu hỏi chung / ngoài hồ sơ nhân sự
  }

  // 1. Phân quyền đa đơn vị (Multi-tenant RBAC)
  const isHR = user.role === 'HR';
  const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
  const userCompany = user.company_id ? user.company_id.toUpperCase() : '';

  let effectiveCompany = 'ALL';
  if (isAdmin) {
    if (userCompany && ['STL', 'VTX', 'SWC'].includes(userCompany)) {
      effectiveCompany = userCompany;
      if (intent.companyFilter && intent.companyFilter !== userCompany) {
        await logAudit({
          actor_user_id: user.user_id,
          actor_username: user.username,
          action: 'ADMIN_CROSS_COMPANY_BLOCKED',
          status: 'BLOCKED',
          ip_address: ip,
          metadata: { user_company: userCompany, requested_company: intent.companyFilter }
        });
        return {
          reply: `⚠️ **Từ chối truy cập đa đơn vị**: Tài khoản Quản trị viên của bạn được phân quyền phụ trách đơn vị **${userCompany}**.\nBạn không có thẩm quyền truy vấn hồ sơ nhân sự của đơn vị khác (**${intent.companyFilter}**). Vui lòng liên hệ Quản trị viên cấp cao (Super Admin) nếu cần quyền truy cập toàn tập đoàn.`,
          table: null
        };
      }
    } else {
      effectiveCompany = intent.companyFilter || 'ALL';
    }
  } else if (isHR) {
    if (!userCompany) {
      return {
        reply: `⚠️ Tài khoản HR chưa được gán mã công ty trực thuộc. Vui lòng liên hệ Quản trị viên để cập nhật đơn vị công tác.`,
        table: null
      };
    }
    // Nếu HR yêu cầu tra cứu công ty khác ngoài phạm vi của mình
    if (intent.companyFilter && intent.companyFilter !== userCompany) {
      await logAudit({
        actor_user_id: user.user_id,
        actor_username: user.username,
        action: 'HR_CHAT_QUERY_CROSS_COMPANY_BLOCKED',
        status: 'BLOCKED',
        ip_address: ipAddress,
        metadata: { target_company: intent.companyFilter, user_company: userCompany, question: message }
      });
      return {
        reply: `⚠️ **Thông báo bảo mật dữ liệu liên đơn vị**:\n\nTài khoản của bạn thuộc đơn vị **${userCompany}** nên không có quyền truy cập thông tin nhân sự của đơn vị **${intent.companyFilter}** theo chính sách bảo mật đa công ty (Multi-tenant).\n\nVui lòng chỉ tra cứu trong phạm vi đơn vị ${userCompany} hoặc liên hệ Quản trị viên (ADMIN) để được hỗ trợ.`,
        table: null,
        blocked: true
      };
    }
    effectiveCompany = userCompany;
  } else {
    // Không có quyền HR hoặc ADMIN
    return {
      reply: `⚠️ **Quyền truy cập bị từ chối**: Chatbot Hồ sơ Nhân sự chỉ dành cho Chuyên viên Nhân sự (HR) và Quản trị viên (ADMIN).`,
      table: null,
      blocked: true
    };
  }

  // 2. Database Name Grounding (Khớp thực thể nhân sự trực tiếp từ CSDL PostgreSQL)
  // Quét đối soát thông minh: nếu câu hỏi chứa tên của nhân sự trong CSDL, liên kết ngay Mã NV & Tên chuẩn xác
  try {
    const activeRes = await db.query(`
      SELECT e.id, e.employee_code, e.employee_name, e.company_id
      FROM employees e
      WHERE e.status != 'DELETED'
        AND ($1 = 'ALL' OR e.company_id = $1)
    `, [effectiveCompany]);

    const activeList = activeRes.rows || [];
    const normMsg = removeAccents(message);

    // Sắp xếp theo độ dài tên giảm dần để ưu tiên tên dài hơn tránh trùng lặp tiền tố
    const sortedEmps = activeList.slice().sort((a, b) => (b.employee_name || '').length - (a.employee_name || '').length);

    for (const emp of sortedEmps) {
      const empNorm = removeAccents(emp.employee_name);
      if (empNorm && empNorm.length >= 3 && normMsg.includes(empNorm)) {
        // Khớp chính xác tên nhân sự trong CSDL!
        intent.targetName = emp.employee_name;
        if (!intent.targetCode) {
          intent.targetCode = emp.employee_code;
        }
        intent.isEmployeeQuery = true;
        break;
      }
    }
  } catch (groundErr) {
    console.warn('[EmployeeLookupService] Name Grounding Check Warning:', groundErr);
  }

  // 3. Xây dựng câu truy vấn SQL chuẩn hóa toàn bộ 53 trường dữ liệu
  const params = [];
  let paramIdx = 1;

  let sql = `
    SELECT 
      e.id,
      e.employee_code,
      e.employee_name,
      e.company_id,
      c.company_name,
      e.department,
      e.position,
      COALESCE(NULLIF(e.email, ''), p.email, '') AS email,
      COALESCE(NULLIF(e.citizen_id, ''), p.citizen_id, '') AS citizen_id,
      e.status,
      COALESCE(e.resignation_date, p.resignation_date, '') AS resignation_date,
      COALESCE(e.resignation_reason, p.resignation_reason, '') AS resignation_reason,
      e.created_at,
      e.updated_at,
      p.job_grade,
      p.date_of_birth,
      p.gender,
      p.job_title,
      p.professional_title,
      p.department_staffing_plan,
      p.section_staffing_plan,
      p.citizen_id_issue_date,
      p.citizen_id_issue_place,
      p.birth_registration_place,
      p.place_of_origin,
      p.permanent_address,
      p.temporary_address,
      p.current_address,
      p.ethnicity,
      p.education_level,
      p.education_code,
      p.qualification,
      p.professional_qualification,
      p.specialization,
      p.degree_qualification,
      p.training_institution,
      p.major,
      p.training_mode,
      p.training_period,
      p.graduation_grade,
      p.degree_valid_until,
      p.other_professional_certificates,
      p.social_insurance_salary,
      p.total_income,
      p.base_salary,
      p.productivity_responsibility_pay,
      p.attendance_bonus,
      p.responsibility_allowance,
      p.vessel_size_allowance,
      p.professional_allowance_t1,
      p.meal_allowance,
      p.other_allowances,
      p.open_ended_contract,
      p.fixed_term_contract,
      p.seasonal_contract,
      p.contract_start_date,
      p.contract_end_date,
      p.recruitment_decision_no,
      p.employment_start_date,
      p.official_labor_contract_sign_date,
      p.phone_number,
      p.create_time,
      p.file_name
    FROM employees e
    LEFT JOIN companies c ON e.company_id = c.id
    LEFT JOIN LATERAL (
      SELECT *
      FROM hr_employee_profiles
      WHERE (employee_id = e.employee_code AND employee_id <> '')
         OR (e.citizen_id IS NOT NULL AND citizen_id = e.citizen_id)
      ORDER BY id DESC
      LIMIT 1
    ) p ON true
    WHERE 1=1
  `;

  // Lọc theo công ty
  sql += ` AND ($${paramIdx} = 'ALL' OR e.company_id = $${paramIdx})`;
  params.push(effectiveCompany);
  paramIdx++;

  // Lọc theo trạng thái
  if (intent.explicitStatus) {
    sql += ` AND e.status = $${paramIdx}`;
    params.push(intent.statusFilter);
    paramIdx++;
  } else if (!intent.targetCode && !intent.targetCccd && !intent.targetName && !intent.recruitmentDecision && !intent.fileFilter) {
    // Với câu hỏi danh sách/nhóm/thống kê chung, mặc định chỉ lấy ACTIVE
    sql += ` AND e.status = 'ACTIVE'`;
  }

  // Lọc theo Mã nhân viên
  if (intent.targetCode) {
    sql += ` AND (
      LOWER(e.employee_code) = LOWER($${paramIdx}) OR 
      LOWER(REPLACE(REPLACE(e.employee_code, '-', ''), '_', '')) = LOWER(REPLACE(REPLACE($${paramIdx}, '-', ''), '_', ''))
    )`;
    params.push(intent.targetCode);
    paramIdx++;
  }

  // Lọc theo CCCD (hỗ trợ cả cột legacy và HMAC Blind Index)
  if (intent.targetCccd) {
    const canonicalCccd = canonicalizeIdentity('CCCD', 'VNM', intent.targetCccd);
    const hmacV1 = computeBlindIndex(canonicalCccd, 1);
    const hmacV2 = computeBlindIndex(canonicalCccd, 2);

    sql += ` AND (
      e.citizen_id = $${paramIdx} 
      OR LPAD(e.citizen_id, 12, '0') = LPAD($${paramIdx}, 12, '0')
      OR e.person_id IN (
        SELECT person_id FROM hr_person_identity_documents 
        WHERE (doc_number_hmac = $${paramIdx + 1} OR doc_number_hmac = $${paramIdx + 2})
          AND lifecycle_status = 'ACTIVE'
      )
    )`;
    params.push(intent.targetCccd, hmacV1, hmacV2);
    paramIdx += 3;
  }

  // Lọc theo Số điện thoại
  if (intent.targetPhone) {
    sql += ` AND (p.phone_number = $${paramIdx} OR REPLACE(p.phone_number, ' ', '') = $${paramIdx})`;
    params.push(intent.targetPhone);
    paramIdx++;
  }

  // Lọc theo Email
  if (intent.targetEmail) {
    sql += ` AND (LOWER(e.email) = LOWER($${paramIdx}) OR LOWER(p.email) = LOWER($${paramIdx}))`;
    params.push(intent.targetEmail);
    paramIdx++;
  }

  // Lọc theo Tên người cụ thể (chỉ áp dụng nếu chưa có targetCode)
  if (intent.targetName && !intent.targetCode) {
    sql += ` AND (
      unaccent(LOWER(e.employee_name)) ILIKE unaccent(LOWER($${paramIdx})) OR
      unaccent(LOWER(e.employee_name)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%'))
    )`;
    params.push(intent.targetName.trim());
    paramIdx++;
  }

  // Lọc theo Phòng ban
  if (intent.departmentFilter) {
    sql += ` AND (
      unaccent(LOWER(e.department)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(p.department_staffing_plan)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%'))
    )`;
    params.push(intent.departmentFilter);
    paramIdx++;
  }

  // Lọc theo Chức danh / Vị trí
  if (intent.positionFilter) {
    sql += ` AND (
      unaccent(LOWER(e.position)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(p.job_title)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(p.professional_title)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%'))
    )`;
    params.push(intent.positionFilter);
    paramIdx++;
  }

  // Lọc theo Số quyết định tuyển dụng
  if (intent.recruitmentDecision) {
    sql += ` AND (p.recruitment_decision_no ILIKE ('%' || $${paramIdx} || '%'))`;
    params.push(intent.recruitmentDecision);
    paramIdx++;
  }

  // Lọc theo Trường / Cơ sở đào tạo
  if (intent.schoolFilter) {
    sql += ` AND (unaccent(LOWER(p.training_institution)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')))`;
    params.push(intent.schoolFilter);
    paramIdx++;
  }

  // Lọc theo Chuyên ngành
  if (intent.majorFilter) {
    sql += ` AND (
      unaccent(LOWER(p.major)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(p.specialization)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%'))
    )`;
    params.push(intent.majorFilter);
    paramIdx++;
  }

  // Lọc theo Trình độ / Bằng cấp
  if (intent.qualificationFilter) {
    sql += ` AND (
      unaccent(LOWER(p.qualification)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(p.professional_qualification)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(p.education_level)) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%'))
    )`;
    params.push(intent.qualificationFilter);
    paramIdx++;
  }

  // Lọc theo Địa chỉ / Quê quán
  if (intent.placeFilter) {
    sql += ` AND (
      unaccent(LOWER(COALESCE(p.place_of_origin, ''))) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(COALESCE(p.birth_registration_place, ''))) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(COALESCE(p.permanent_address, ''))) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(COALESCE(p.current_address, ''))) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(COALESCE(p.temporary_address, ''))) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%'))
    )`;
    params.push(intent.placeFilter);
    paramIdx++;
  }

  // Lọc theo Giới tính
  if (intent.genderFilter) {
    sql += ` AND (p.gender ILIKE ($${paramIdx} || '%'))`;
    params.push(intent.genderFilter);
    paramIdx++;
  }

  // Lọc theo Tên file hồ sơ
  if (intent.fileFilter) {
    sql += ` AND (p.file_name ILIKE ('%' || $${paramIdx} || '%'))`;
    params.push(intent.fileFilter);
    paramIdx++;
  }

  // Lọc theo Chứng chỉ chuyên môn
  if (intent.certificateFilter) {
    sql += ` AND (
      unaccent(LOWER(COALESCE(p.professional_title, ''))) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%')) OR
      unaccent(LOWER(COALESCE(p.other_professional_certificates, ''))) ILIKE unaccent(LOWER('%' || $${paramIdx} || '%'))
    )`;
    params.push(intent.certificateFilter);
    paramIdx++;
  }

  // Lọc theo Hợp đồng
  if (intent.contractFilter === 'open_ended') {
    sql += ` AND (p.open_ended_contract IS NOT NULL AND p.open_ended_contract <> '' AND p.open_ended_contract <> '0')`;
  } else if (intent.contractFilter === 'fixed_term') {
    sql += ` AND (p.fixed_term_contract IS NOT NULL AND p.fixed_term_contract <> '' AND p.fixed_term_contract <> '0')`;
  } else if (intent.contractFilter === 'seasonal') {
    sql += ` AND (p.seasonal_contract IS NOT NULL AND p.seasonal_contract <> '' AND p.seasonal_contract <> '0')`;
  }

  sql += `
    ORDER BY 
      CASE WHEN e.status = 'ACTIVE' THEN 1 WHEN e.status = 'RESIGNED' THEN 2 ELSE 3 END,
      e.employee_code ASC
    LIMIT 200;
  `;

  let result;
  try {
    result = await db.query(sql, params);
  } catch (dbErr) {
    console.error('[EmployeeLookupService] Database Query Error:', dbErr);
    return {
      reply: `❌ **Lỗi kỹ thuật**: Không thể truy vấn cơ sở dữ liệu nhân sự (Mã lỗi: \`DB_QUERY_ERROR\`). Vui lòng thử lại hoặc liên hệ Quản trị viên hệ thống để kiểm tra kết nối.`,
      table: null,
      error_code: 'DB_QUERY_ERROR'
    };
  }

  let rows = result.rows || [];

  // 4. Universal Fallback Search: Tìm kiếm đa trường trên toàn bộ 53 thuộc tính nếu chưa có kết quả
  if (rows.length === 0 && intent.targetName && !intent.targetCode && !intent.targetCccd && !intent.birthYear && !intent.ageFilter) {
    try {
      const universalSql = `
        SELECT 
          e.id, e.employee_code, e.employee_name, e.company_id, c.company_name, e.department, e.position,
          COALESCE(NULLIF(e.email, ''), p.email, '') AS email,
          COALESCE(NULLIF(e.citizen_id, ''), p.citizen_id, '') AS citizen_id,
          e.status,
          COALESCE(e.resignation_date, p.resignation_date, '') AS resignation_date,
          COALESCE(e.resignation_reason, p.resignation_reason, '') AS resignation_reason,
          e.created_at, e.updated_at,
          p.job_grade, p.date_of_birth, p.gender, p.job_title, p.professional_title,
          p.department_staffing_plan, p.section_staffing_plan, p.citizen_id_issue_date, p.citizen_id_issue_place,
          p.birth_registration_place, p.place_of_origin, p.permanent_address, p.temporary_address, p.current_address,
          p.ethnicity, p.education_level, p.education_code, p.qualification, p.professional_qualification,
          p.specialization, p.degree_qualification, p.training_institution, p.major, p.training_mode,
          p.training_period, p.graduation_grade, p.degree_valid_until, p.other_professional_certificates,
          p.social_insurance_salary, p.total_income, p.base_salary, p.productivity_responsibility_pay,
          p.attendance_bonus, p.responsibility_allowance, p.vessel_size_allowance, p.professional_allowance_t1,
          p.meal_allowance, p.other_allowances, p.open_ended_contract, p.fixed_term_contract, p.seasonal_contract,
          p.contract_start_date, p.contract_end_date, p.recruitment_decision_no, p.employment_start_date,
          p.official_labor_contract_sign_date, p.phone_number, p.create_time, p.file_name
        FROM employees e
        LEFT JOIN companies c ON e.company_id = c.id
        LEFT JOIN LATERAL (
          SELECT * FROM hr_employee_profiles
          WHERE (employee_id = e.employee_code AND employee_id <> '')
             OR (e.citizen_id IS NOT NULL AND citizen_id = e.citizen_id)
          ORDER BY id DESC LIMIT 1
        ) p ON true
        WHERE ($1 = 'ALL' OR e.company_id = $1)
          ${intent.explicitStatus ? `AND e.status = '${intent.statusFilter}'` : ''}
          AND (
            unaccent(LOWER(COALESCE(e.employee_name, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.place_of_origin, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.birth_registration_place, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.permanent_address, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.current_address, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.temporary_address, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.training_institution, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.major, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.specialization, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.qualification, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.professional_qualification, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.degree_qualification, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.education_level, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.professional_title, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            unaccent(LOWER(COALESCE(p.other_professional_certificates, ''))) ILIKE unaccent(LOWER('%' || $2 || '%')) OR
            COALESCE(p.recruitment_decision_no, '') ILIKE ('%' || $2 || '%') OR
            COALESCE(p.file_name, '') ILIKE ('%' || $2 || '%') OR
            COALESCE(p.phone_number, '') ILIKE ('%' || $2 || '%') OR
            COALESCE(p.email, '') ILIKE ('%' || $2 || '%')
          )
        ORDER BY e.employee_code ASC
        LIMIT 200;
      `;
      const fallbackRes = await db.query(universalSql, [effectiveCompany, intent.targetName.trim()]);
      if (fallbackRes.rows && fallbackRes.rows.length > 0) {
        rows = fallbackRes.rows;
        intent.isUniversalMatch = true;
        intent.universalKeyword = intent.targetName.trim();
        rows.forEach(r => {
          r._matchedDetail = findMatchingAttributeDetail(r, intent.universalKeyword);
        });
      }
    } catch (fbErr) {
      console.error('[EmployeeLookupService] Universal Fallback Query Error:', fbErr);
    }
  }

  // 5. Xử lý logic nghiệp vụ ngày sinh & độ tuổi chính xác (in-memory evaluation)
  const now = new Date();
  let missingDobRows = [];

  if (intent.birthYear) {
    const matched = [];
    rows.forEach(r => {
      const parsed = parseBirthDate(r.date_of_birth);
      if (parsed && parsed.year === intent.birthYear) {
        matched.push(r);
      } else if (!parsed) {
        missingDobRows.push(r);
      }
    });
    rows = matched;
  }

  if (intent.ageFilter) {
    const matched = [];
    rows.forEach(r => {
      const parsed = parseBirthDate(r.date_of_birth);
      if (parsed) {
        const age = calculateExactAge(parsed, now);
        r._calculatedAge = age;
        if (intent.ageFilter.op === '<' && age < intent.ageFilter.val) {
          matched.push(r);
        } else if (intent.ageFilter.op === '<=' && age <= intent.ageFilter.val) {
          matched.push(r);
        } else if (intent.ageFilter.op === '>' && age > intent.ageFilter.val) {
          matched.push(r);
        } else if (intent.ageFilter.op === '>=' && age >= intent.ageFilter.val) {
          matched.push(r);
        } else if (intent.ageFilter.op === '=' && age === intent.ageFilter.val) {
          matched.push(r);
        } else if (intent.ageFilter.op === 'BETWEEN' && age >= intent.ageFilter.val[0] && age <= intent.ageFilter.val[1]) {
          matched.push(r);
        }
      } else {
        missingDobRows.push(r);
      }
    });
    rows = matched;
  }

  // 6. Định dạng câu trả lời theo từng kịch bản
  const compLabel = effectiveCompany === 'ALL' ? 'Toàn bộ Tập đoàn (STL, SWC, VTX)' : `Công ty ${effectiveCompany}`;

  // Kịch bản A: Thống kê / Đếm số lượng
  if (intent.isAggregation) {
    return formatAggregationResponse(rows, intent, compLabel, missingDobRows, user);
  }

  // Kịch bản B: Không tìm thấy kết quả
  if (rows.length === 0) {
    return formatNotFoundResponse(intent, compLabel, missingDobRows);
  }

  // Kịch bản C: Tìm thấy đúng 1 người cụ thể
  if (rows.length === 1 && (intent.targetCode || intent.targetCccd || intent.targetPhone || intent.targetName || intent.recruitmentDecision || intent.fileFilter || intent.isUniversalMatch)) {
    return formatSingleEmployeeResponse(rows[0], user, intent.targetAttr);
  }

  // Kịch bản D: Tìm thấy nhiều người (Danh sách nhóm / Làm rõ người trùng tên)
  return formatMultipleEmployeesResponse(rows, user, intent, compLabel, missingDobRows);
}

function formatAggregationResponse(rows, intent, compLabel, missingDobRows, user = null) {
  const count = rows.length;
  let conditionDesc = [];
  if (intent.companyFilter) conditionDesc.push(`thuộc đơn vị **${intent.companyFilter}**`);
  if (intent.departmentFilter) conditionDesc.push(`phòng ban **${intent.departmentFilter}**`);
  if (intent.positionFilter) conditionDesc.push(`chức danh **${intent.positionFilter}**`);
  if (intent.birthYear) conditionDesc.push(`sinh năm **${intent.birthYear}**`);
  if (intent.ageFilter) {
    if (intent.ageFilter.op === '<') conditionDesc.push(`**dưới ${intent.ageFilter.val} tuổi**`);
    else if (intent.ageFilter.op === '>') conditionDesc.push(`**trên ${intent.ageFilter.val} tuổi**`);
    else if (intent.ageFilter.op === 'BETWEEN') conditionDesc.push(`từ **${intent.ageFilter.val[0]} đến ${intent.ageFilter.val[1]} tuổi**`);
    else conditionDesc.push(`**${intent.ageFilter.val} tuổi**`);
  }
  if (intent.explicitStatus) {
    if (intent.statusFilter === 'RESIGNED') conditionDesc.push(`trạng thái **Đã nghỉ việc (RESIGNED)**`);
    else if (intent.statusFilter === 'DELETED') conditionDesc.push(`trạng thái **Đã xóa mềm (DELETED)**`);
    else conditionDesc.push(`trạng thái **Đang làm việc (ACTIVE)**`);
  }
  const condText = conditionDesc.length > 0 ? conditionDesc.join(', ') : 'toàn hệ thống';

  // Thống kê phân nhóm theo công ty nếu có yêu cầu
  let breakdown = '';
  if (intent.groupByCompany && count > 0) {
    const counts = {};
    rows.forEach(r => {
      const c = r.company_id || 'KHAC';
      counts[c] = (counts[c] || 0) + 1;
    });
    breakdown = '\n\n**Phân bổ theo công ty thành viên:**\n' +
      Object.entries(counts).map(([c, n]) => `- **${c}**: **${n}** nhân sự`).join('\n') + '\n';
  }

  let lines = '';
  if (count > 0) {
    lines = rows.map((r, i) => {
      const ageStr = r._calculatedAge !== undefined ? ` (${r._calculatedAge} tuổi)` : '';
      const dobStr = r.date_of_birth ? ` - NS: ${formatDateDisplay(r.date_of_birth)}${ageStr}` : '';
      return `${i + 1}. **${r.employee_name}** [\`${r.employee_code}\`] — ${r.company_id} | ${r.job_title || r.position || 'Nhân viên'} | ${r.department_staffing_plan || r.department || ''}${dobStr}`;
    }).join('\n');
  }

  let note = '';
  if (missingDobRows.length > 0 && (intent.ageFilter || intent.birthYear)) {
    note = `\n\n*(Lưu ý: Có ${missingDobRows.length} nhân sự chưa cập nhật ngày sinh trong hệ thống nên không đưa vào thống kê độ tuổi).*`;
  }

  const reply = `📊 **Kết quả thống kê nhân sự (${compLabel})**:\n\n` +
    `Hiện có **${count}** nhân sự thỏa mãn điều kiện: ${condText}.${breakdown}\n\n` +
    (lines ? `### Danh sách chi tiết:\n${lines}${note}` : `Không có bản ghi nào phù hợp.`);

  return {
    reply,
    table: count > 0 ? buildStandardTable(rows, user) : null,
    total_found: count
  };
}

function formatNotFoundResponse(intent, compLabel, missingDobRows) {
  let criteriaArr = [];
  if (intent.targetCode) criteriaArr.push(`Mã nhân viên: \`${intent.targetCode}\``);
  if (intent.targetCccd) criteriaArr.push(`CCCD: \`${intent.targetCccd}\``);
  if (intent.targetName) criteriaArr.push(`Họ tên / Từ khóa: "${intent.targetName}"`);
  if (intent.birthYear) criteriaArr.push(`Sinh năm: ${intent.birthYear}`);
  if (intent.ageFilter) {
    if (intent.ageFilter.op === '<') criteriaArr.push(`Dưới ${intent.ageFilter.val} tuổi`);
    else if (intent.ageFilter.op === '>') criteriaArr.push(`Trên ${intent.ageFilter.val} tuổi`);
    else criteriaArr.push(`Độ tuổi: ${intent.ageFilter.val}`);
  }
  if (intent.departmentFilter) criteriaArr.push(`Phòng ban: "${intent.departmentFilter}"`);
  if (intent.positionFilter) criteriaArr.push(`Chức danh: "${intent.positionFilter}"`);
  if (intent.recruitmentDecision) criteriaArr.push(`Số QĐ tuyển dụng: "${intent.recruitmentDecision}"`);
  if (intent.schoolFilter) criteriaArr.push(`Trường đào tạo: "${intent.schoolFilter}"`);
  if (intent.majorFilter) criteriaArr.push(`Chuyên ngành: "${intent.majorFilter}"`);
  if (intent.qualificationFilter) criteriaArr.push(`Trình độ / Bằng cấp: "${intent.qualificationFilter}"`);
  if (intent.placeFilter) criteriaArr.push(`Địa chỉ / Quê quán: "${intent.placeFilter}"`);
  if (intent.genderFilter) criteriaArr.push(`Giới tính: ${intent.genderFilter}`);
  if (intent.certificateFilter) criteriaArr.push(`Chứng chỉ: "${intent.certificateFilter}"`);
  if (intent.fileFilter) criteriaArr.push(`Tệp hồ sơ: "${intent.fileFilter}"`);
  if (intent.explicitStatus) {
    if (intent.statusFilter === 'RESIGNED') criteriaArr.push('Trạng thái: Đã nghỉ việc (RESIGNED)');
    else if (intent.statusFilter === 'DELETED') criteriaArr.push('Trạng thái: Đã xóa mềm (DELETED)');
    else criteriaArr.push('Trạng thái: Đang làm việc (ACTIVE)');
  }

  const criteriaText = criteriaArr.length > 0 ? criteriaArr.join(', ') : 'điều kiện tra cứu';

  let note = '';
  if (missingDobRows.length > 0 && (intent.ageFilter || intent.birthYear)) {
    note = `\n\n💡 *Ghi chú: Hiện có ${missingDobRows.length} hồ sơ nhân sự trong hệ thống chưa có thông tin ngày sinh chính thức để đối chiếu.*`;
  }

  return {
    reply: `🔍 **Không tìm thấy nhân sự phù hợp**:\n\nKhông có hồ sơ nhân sự nào thuộc **${compLabel}** thỏa mãn các điều kiện: **${criteriaText}**.\n\n💡 *Gợi ý: Vui lòng kiểm tra lại tính chính xác của tiêu chí lọc hoặc thử tra cứu theo Mã nhân viên (ví dụ: \`SWC00016\`, \`STL00012\`) hoặc Họ tên đầy đủ.*${note}`,
    table: null,
    found_count: 0
  };
}

/**
 * Định dạng câu trả lời cho đúng 1 nhân sự cụ thể
 * Hỗ trợ tra cứu chi tiết toàn bộ 53 trường thông tin
 */
function formatSingleEmployeeResponse(emp, user, targetAttr = null) {
  const compLabel = emp.company_id === 'SWC' ? 'Sowatco (SWC)' : (emp.company_id === 'VTX' ? 'Vietranstimex (VTX)' : (emp.company_name || 'SOTRANS Logistics (STL)'));
  const jobTitle = emp.job_title || emp.position || 'Chưa cập nhật';
  const dept = emp.department_staffing_plan || emp.department || 'Chưa cập nhật';
  const startDate = emp.employment_start_date || emp.contract_start_date || 'Theo hợp đồng lao động';
  const phone = emp.phone_number || 'Chưa cập nhật';
  const email = emp.email || 'Chưa cập nhật';
  const placeOfOrigin = emp.place_of_origin || 'Chưa cập nhật';
  const currentAddress = emp.current_address || 'Chưa cập nhật';
  const permanentAddress = emp.permanent_address || 'Chưa cập nhật';
  const temporaryAddress = emp.temporary_address || 'Chưa cập nhật';
  const birthPlace = emp.birth_registration_place || 'Chưa cập nhật';
  const dob = formatDateDisplay(emp.date_of_birth);
  const isAuthorizedStaff = user && (user.role === 'ADMIN' || user.role === 'HR');
  const displayCccd = isAuthorizedStaff ? (emp.citizen_id || 'Chưa cập nhật') : (maskCccd(emp.citizen_id) + ' *(đã che bảo mật)*');
  const maskedCccd = maskCccd(emp.citizen_id);

  let reply = '';
  let attachTable = true;

  // Trường hợp ĐÃ XÓA MỀM
  if (emp.status === 'DELETED') {
    reply = `### ⚠️ HỒ SƠ ĐÃ XÓA MỀM (DELETED)\n\n` +
      `Hồ sơ nhân sự **${emp.employee_name}** (Mã: \`${emp.employee_code}\`, Đơn vị: ${compLabel}) hiện đang ở trạng thái **ĐÃ XÓA MỀM (DELETED)** trong hệ thống.\n\n` +
      `- **Mã nhân viên**: \`${emp.employee_code}\`\n` +
      `- **Họ và tên**: **${emp.employee_name}**\n` +
      `- **Đơn vị trực thuộc**: ${compLabel}\n` +
      `- **Chức vụ trước khi xóa**: ${jobTitle}\n` +
      `- **Phòng ban**: ${dept}\n` +
      `- **Số quyết định**: ${emp.recruitment_decision_no ? `\`${emp.recruitment_decision_no}\`` : 'Chưa cập nhật'}\n` +
      `- **Số CCCD / Định danh**: **${displayCccd}**\n` +
      `- **Thời gian cập nhật xóa**: ${new Date(emp.updated_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n\n` +
      `💡 *Nếu bạn muốn khôi phục hồ sơ này hoạt động trở lại, vui lòng phản hồi:*\n` +
      `> **"Khôi phục nhân viên ${emp.employee_code}"** hoặc sử dụng nút khôi phục trên màn hình Quản lý hồ sơ.`;
    return { reply, table: buildStandardTable([emp], user), employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
  }

  // Trường hợp ĐÃ NGHỈ VIỆC
  if (emp.status === 'RESIGNED') {
    const resDate = emp.resignation_date || 'Theo quyết định thôi việc';
    const resReason = emp.resignation_reason || 'Chấm dứt hợp đồng lao động theo nguyện vọng';
    const resDateStr = emp.resignation_date ? ` từ ngày **${emp.resignation_date}**` : '';
    const isAdminUser = user && (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN');

    let displayPhone = '🔒 *Đã che bảo mật theo chính sách nhân sự thôi việc*';
    let displayEmail = '🔒 *Đã che bảo mật theo chính sách nhân sự thôi việc*';
    if (isAdminUser) {
      displayPhone = phone || 'Chưa cập nhật';
      displayEmail = email || 'Chưa cập nhật';
    } else if (phone && phone !== 'Chưa cập nhật') {
      const cleanP = String(phone).replace(/\s/g, '');
      if (cleanP.length >= 7) {
        displayPhone = cleanP.substring(0, 3) + '****' + cleanP.substring(cleanP.length - 3) + ' *(đã che bảo mật)*';
      }
    }

    if (targetAttr === 'phone') {
      reply = `⚠️ **Lưu ý nghiệp vụ**: Nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) **ĐÃ NGHỈ VIỆC (RESIGNED)**${resDateStr}.\n\n` +
        `* **Số điện thoại liên lạc**: ${displayPhone}\n` +
        `* **Chức danh trước khi nghỉ**: ${jobTitle}\n` +
        `* **Phòng ban trước khi nghỉ**: ${dept}\n` +
        `* **Ngày thôi việc**: ${resDate}\n` +
        `* **Lý do thôi việc**: ${resReason}`;
      return { reply, table: null, employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
    } else if (targetAttr === 'email') {
      reply = `⚠️ **Lưu ý nghiệp vụ**: Nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) **ĐÃ NGHỈ VIỆC (RESIGNED)**${resDateStr}.\n\n` +
        `* **Email liên hệ**: ${displayEmail}\n` +
        `* **Chức danh trước khi nghỉ**: ${jobTitle}\n` +
        `* **Phòng ban trước khi nghỉ**: ${dept}\n` +
        `* **Ngày thôi việc**: ${resDate}\n` +
        `* **Lý do thôi việc**: ${resReason}`;
      return { reply, table: null, employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
    } else {
      reply = `### 🟠 THÔNG TIN NHÂN SỰ — ĐÃ NGHỈ VIỆC (RESIGNED)\n\n` +
        `⚠️ **Lưu ý nghiệp vụ**: Nhân sự này **ĐÃ CHẤM DỨT LÀM VIỆC** tại công ty, không còn là nhân viên đang hoạt động.\n\n` +
        `- **Họ và tên**: **${emp.employee_name}**\n` +
        `- **Mã nhân viên**: \`${emp.employee_code}\`\n` +
        `- **Trạng thái**: \`🟠 ĐÃ NGHỈ VIỆC (RESIGNED)\`\n` +
        `- **Đơn vị / Công ty**: ${compLabel}\n` +
        `- **Chức danh trước khi nghỉ**: ${jobTitle}\n` +
        `- **Phòng ban trước khi nghỉ**: ${dept}\n` +
        `- **Ngày chính thức nghỉ việc**: **${resDate}**\n` +
        `- **Lý do nghỉ việc**: ${resReason}\n` +
        `- **Số điện thoại**: ${displayPhone}\n` +
        `- **Email**: ${displayEmail}\n` +
        `- **Số CCCD / Định danh**: **${displayCccd}**`;
      return { reply, table: buildStandardTable([emp], user), employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
    }
  }

  // Trường hợp ĐANG LÀM VIỆC (ACTIVE) - Kiểm tra trực tiếp theo từng thuộc tính trong 53 trường
  if (targetAttr === 'dob') {
    attachTable = false;
    reply = `Ngày sinh của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${dob}**.\n\n` +
      `* **Họ và tên**: **${emp.employee_name}**\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Chức danh / Vị trí**: ${jobTitle}\n` +
      `* **Trạng thái**: \`🟢 ĐANG LÀM VIỆC (ACTIVE)\``;

  } else if (targetAttr === 'age') {
    attachTable = false;
    const parsed = parseBirthDate(emp.date_of_birth);
    const age = parsed ? calculateExactAge(parsed) : null;
    const ageText = age !== null ? `**${age} tuổi** (Sinh ngày ${dob})` : `Chưa xác định chính xác (Ngày sinh trong hồ sơ: ${dob})`;
    reply = `Độ tuổi hiện tại của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: ${ageText}.\n\n` +
      `* **Họ và tên**: **${emp.employee_name}**\n` +
      `* **Chức danh**: ${jobTitle}\n` +
      `* **Phòng ban**: ${dept}`;

  } else if (targetAttr === 'phone') {
    attachTable = false;
    reply = `Số điện thoại của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${phone}**.\n\n` +
      `* **Họ và tên**: **${emp.employee_name}**\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Chức danh / Vị trí**: ${jobTitle}\n` +
      `* **Trạng thái**: \`🟢 ĐANG LÀM VIỆC (ACTIVE)\``;

  } else if (targetAttr === 'email') {
    attachTable = false;
    reply = `Email của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${email}**.\n\n` +
      `* **Họ và tên**: **${emp.employee_name}**\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Chức danh / Vị trí**: ${jobTitle}\n` +
      `* **Trạng thái**: \`🟢 ĐANG LÀM VIỆC (ACTIVE)\``;

  } else if (targetAttr === 'place_of_origin') {
    attachTable = false;
    const val = emp.place_of_origin || 'Chưa cập nhật trong hồ sơ';
    reply = `Quê quán / Nguyên quán của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Nơi sinh**: ${birthPlace}\n` +
      `* **Địa chỉ thường trú**: ${permanentAddress}\n` +
      `* **Nơi ở hiện nay**: ${currentAddress}`;

  } else if (targetAttr === 'birth_registration_place') {
    attachTable = false;
    const val = emp.birth_registration_place || 'Chưa cập nhật trong hồ sơ';
    reply = `Nơi đăng ký khai sinh / Nơi sinh của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Quê quán**: ${placeOfOrigin}\n` +
      `* **Địa chỉ thường trú**: ${permanentAddress}`;

  } else if (targetAttr === 'permanent_address') {
    attachTable = false;
    const val = emp.permanent_address || 'Chưa cập nhật trong hồ sơ';
    reply = `Địa chỉ thường trú (hộ khẩu) của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Nơi ở hiện nay**: ${currentAddress}\n` +
      `* **Quê quán**: ${placeOfOrigin}`;

  } else if (targetAttr === 'temporary_address') {
    attachTable = false;
    const val = emp.temporary_address || 'Chưa cập nhật trong hồ sơ';
    reply = `Địa chỉ tạm trú của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Nơi ở hiện nay**: ${currentAddress}\n` +
      `* **Địa chỉ thường trú**: ${permanentAddress}`;

  } else if (targetAttr === 'current_address') {
    attachTable = false;
    const val = emp.current_address || 'Chưa cập nhật trong hồ sơ';
    reply = `Nơi ở hiện nay của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Địa chỉ thường trú**: ${permanentAddress}\n` +
      `* **Quê quán**: ${placeOfOrigin}`;

  } else if (targetAttr === 'citizen_id') {
    attachTable = false;
    reply = `Số CCCD / CMND của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${displayCccd}**.\n\n` +
      `* **Ngày cấp**: ${emp.citizen_id_issue_date ? formatDateDisplay(emp.citizen_id_issue_date) : 'Chưa cập nhật'}\n` +
      `* **Nơi cấp**: ${emp.citizen_id_issue_place || 'Chưa cập nhật'}\n` +
      `* **Họ và tên**: **${emp.employee_name}**`;

  } else if (targetAttr === 'citizen_id_issue_date') {
    attachTable = false;
    const val = emp.citizen_id_issue_date ? formatDateDisplay(emp.citizen_id_issue_date) : 'Chưa cập nhật trong hồ sơ';
    reply = `Ngày cấp CCCD của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Nơi cấp**: ${emp.citizen_id_issue_place || 'Chưa cập nhật'}\n` +
      `* **Số CCCD**: **${displayCccd}**`;

  } else if (targetAttr === 'citizen_id_issue_place') {
    attachTable = false;
    const val = emp.citizen_id_issue_place || 'Chưa cập nhật trong hồ sơ';
    reply = `Nơi cấp CCCD của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Ngày cấp**: ${emp.citizen_id_issue_date ? formatDateDisplay(emp.citizen_id_issue_date) : 'Chưa cập nhật'}\n` +
      `* **Số CCCD**: **${displayCccd}**`;

  } else if (targetAttr === 'gender') {
    attachTable = false;
    const val = emp.gender || 'Chưa cập nhật trong hồ sơ';
    reply = `Giới tính của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Ngày sinh**: ${dob}\n` +
      `* **Dân tộc**: ${emp.ethnicity || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'ethnicity') {
    attachTable = false;
    const val = emp.ethnicity || 'Chưa cập nhật trong hồ sơ';
    reply = `Dân tộc của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Quê quán**: ${placeOfOrigin}\n` +
      `* **Giới tính**: ${emp.gender || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'job_title') {
    attachTable = false;
    reply = `Chức danh / Vị trí công tác của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${jobTitle}**.\n\n` +
      `* **Chức danh chuyên môn**: ${emp.professional_title || 'Chưa cập nhật'}\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Trạng thái**: \`🟢 ĐANG LÀM VIỆC (ACTIVE)\``;

  } else if (targetAttr === 'professional_title') {
    attachTable = false;
    const val = emp.professional_title || emp.other_professional_certificates || 'Chưa cập nhật trong hồ sơ';
    reply = `Chức danh chuyên môn / Giấy chứng nhận khả năng chuyên môn của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Vị trí công tác**: ${jobTitle}\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Chứng chỉ khác**: ${emp.other_professional_certificates || 'Không có'}`;

  } else if (targetAttr === 'department') {
    attachTable = false;
    reply = `Nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) hiện đang công tác tại:\n\n` +
      `* **Phòng ban**: **${dept}**\n` +
      `* **Bộ phận định biên**: ${emp.section_staffing_plan || 'Theo phân công nội bộ'}\n` +
      `* **Chức danh / Vị trí**: ${jobTitle}\n` +
      `* **Trạng thái**: \`🟢 ĐANG LÀM VIỆC (ACTIVE)\``;

  } else if (targetAttr === 'section_staffing_plan') {
    attachTable = false;
    const val = emp.section_staffing_plan || 'Chưa cập nhật bộ phận cụ thể';
    reply = `Bộ phận / Tổ đội định biên của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Chức danh**: ${jobTitle}`;

  } else if (targetAttr === 'job_grade') {
    attachTable = false;
    const val = emp.job_grade || 'Chưa phân cấp bậc ngạch';
    reply = `Cấp bậc / Ngạch bậc của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Chức vụ**: ${jobTitle}\n` +
      `* **Phòng ban**: ${dept}`;

  } else if (targetAttr === 'employee_id') {
    attachTable = false;
    reply = `Mã nhân viên của nhân sự **${emp.employee_name}** (${compLabel}) là: **\`${emp.employee_code}\`**.\n\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Chức danh**: ${jobTitle}`;

  } else if (targetAttr === 'training_institution') {
    attachTable = false;
    const val = emp.training_institution || 'Chưa cập nhật trong hồ sơ';
    reply = `Cơ sở đào tạo / Trường học của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Chuyên ngành**: ${emp.major || 'Chưa cập nhật'}\n` +
      `* **Trình độ / Bằng cấp**: ${emp.qualification || emp.professional_qualification || 'Chưa cập nhật'}\n` +
      `* **Xếp loại tốt nghiệp**: ${emp.graduation_grade || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'major') {
    attachTable = false;
    const val = emp.major || emp.specialization || 'Chưa cập nhật trong hồ sơ';
    reply = `Chuyên ngành đào tạo của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Cơ sở đào tạo**: ${emp.training_institution || 'Chưa cập nhật'}\n` +
      `* **Trình độ / Bằng cấp**: ${emp.qualification || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'specialization') {
    attachTable = false;
    const val = emp.specialization || emp.major || 'Chưa cập nhật trong hồ sơ';
    reply = `Ngành đào tạo / Chuyên ngành của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Trường đào tạo**: ${emp.training_institution || 'Chưa cập nhật'}\n` +
      `* **Bằng cấp**: ${emp.qualification || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'qualification') {
    attachTable = false;
    const val = emp.qualification || emp.professional_qualification || emp.education_level || 'Chưa cập nhật trong hồ sơ';
    reply = `Trình độ / Bằng cấp chuyên môn của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Trường đào tạo**: ${emp.training_institution || 'Chưa cập nhật'}\n` +
      `* **Chuyên ngành**: ${emp.major || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'education_level') {
    attachTable = false;
    const val = emp.education_level || 'Chưa cập nhật trong hồ sơ';
    reply = `Trình độ văn hóa của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Trình độ chuyên môn**: ${emp.qualification || emp.professional_qualification || 'Chưa cập nhật'}\n` +
      `* **Chuyên ngành**: ${emp.major || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'graduation_grade') {
    attachTable = false;
    const val = emp.graduation_grade || 'Chưa cập nhật trong hồ sơ';
    reply = `Xếp loại tốt nghiệp của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Cơ sở đào tạo**: ${emp.training_institution || 'Chưa cập nhật'}\n` +
      `* **Chuyên ngành**: ${emp.major || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'training_mode') {
    attachTable = false;
    const val = emp.training_mode || 'Chưa cập nhật trong hồ sơ';
    reply = `Hình thức đào tạo của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Cơ sở đào tạo**: ${emp.training_institution || 'Chưa cập nhật'}\n` +
      `* **Chuyên ngành**: ${emp.major || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'training_period') {
    attachTable = false;
    const val = emp.training_period || 'Chưa cập nhật trong hồ sơ';
    reply = `Thời gian đào tạo của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Cơ sở đào tạo**: ${emp.training_institution || 'Chưa cập nhật'}\n` +
      `* **Chuyên ngành**: ${emp.major || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'degree_valid_until') {
    attachTable = false;
    const val = emp.degree_valid_until ? formatDateDisplay(emp.degree_valid_until) : 'Vô thời hạn hoặc chưa cập nhật';
    reply = `Thời hạn văn bằng / chứng chỉ chuyên môn của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) đến ngày: **${val}**.\n\n` +
      `* **Văn bằng**: ${emp.degree_qualification || emp.professional_title || 'Chưa cập nhật'}\n` +
      `* **Chức danh chuyên môn**: ${emp.professional_title || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'other_professional_certificates') {
    attachTable = false;
    const val = emp.other_professional_certificates || 'Chưa ghi nhận chứng chỉ chuyên môn khác';
    reply = `Chứng chỉ chuyên môn khác của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) gồm: **${val}**.\n\n` +
      `* **Chức danh chuyên môn chính**: ${emp.professional_title || 'Chưa cập nhật'}\n` +
      `* **Trình độ nghiệp vụ**: ${emp.professional_qualification || 'Chưa cập nhật'}`;

  } else if (targetAttr === 'base_salary') {
    attachTable = false;
    if (!isAuthorizedStaff) {
      reply = `🔒 **Từ chối truy cập**: Bạn không có quyền xem thông tin mức lương của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\`). Theo chính sách bảo mật thông tin nhân sự, chỉ HR và ADMIN phụ trách mới được truy cập dữ liệu thỏa thuận lương.`;
      return { reply, table: null, employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
    }
    const val = emp.base_salary ? `${Number(emp.base_salary).toLocaleString('vi-VN')} VNĐ` : 'Chưa cập nhật trong hồ sơ';
    reply = `Mức lương cơ bản của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Chức vụ**: ${jobTitle}\n` +
      `* **Phòng ban**: ${dept}\n` +
      `* **Tổng thu nhập**: ${emp.total_income ? `${Number(emp.total_income).toLocaleString('vi-VN')} VNĐ` : 'Chưa cập nhật'}`;

  } else if (targetAttr === 'social_insurance_salary') {
    attachTable = false;
    if (!isAuthorizedStaff) {
      reply = `🔒 **Từ chối truy cập**: Bạn không có quyền xem thông tin mức lương đóng BHXH của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\`). Theo chính sách bảo mật thông tin nhân sự, chỉ HR và ADMIN phụ trách mới được truy cập dữ liệu thỏa thuận lương.`;
      return { reply, table: null, employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
    }
    const val = emp.social_insurance_salary ? `${Number(emp.social_insurance_salary).toLocaleString('vi-VN')} VNĐ` : 'Chưa cập nhật trong hồ sơ';
    reply = `Mức lương đóng Bảo hiểm Xã hội (BHXH) của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Lương cơ bản**: ${emp.base_salary ? `${Number(emp.base_salary).toLocaleString('vi-VN')} VNĐ` : 'Chưa cập nhật'}\n` +
      `* **Chức vụ**: ${jobTitle}`;

  } else if (targetAttr === 'total_income') {
    attachTable = false;
    if (!isAuthorizedStaff) {
      reply = `🔒 **Từ chối truy cập**: Bạn không có quyền xem thông tin tổng thu nhập của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\`). Theo chính sách bảo mật thông tin nhân sự, chỉ HR và ADMIN phụ trách mới được truy cập dữ liệu thỏa thuận lương.`;
      return { reply, table: null, employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
    }
    const val = emp.total_income ? `${Number(emp.total_income).toLocaleString('vi-VN')} VNĐ` : 'Chưa cập nhật trong hồ sơ';
    reply = `Tổng thu nhập của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Lương cơ bản**: ${emp.base_salary ? `${Number(emp.base_salary).toLocaleString('vi-VN')} VNĐ` : 'Chưa cập nhật'}\n` +
      `* **Chức vụ**: ${jobTitle}\n` +
      `* **Phòng ban**: ${dept}`;

  } else if (targetAttr === 'meal_allowance') {
    attachTable = false;
    const val = emp.meal_allowance ? `${Number(emp.meal_allowance).toLocaleString('vi-VN')} VNĐ` : 'Theo chính sách ăn ca hiện hành của công ty';
    reply = `Chế độ phụ cấp tiền ăn ca của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Đơn vị trực thuộc**: ${compLabel}\n` +
      `* **Vị trí công tác**: ${jobTitle}`;

  } else if (targetAttr === 'other_allowances' || targetAttr === 'responsibility_allowance' || targetAttr === 'vessel_size_allowance' || targetAttr === 'professional_allowance_t1' || targetAttr === 'attendance_bonus' || targetAttr === 'productivity_responsibility_pay') {
    attachTable = false;
    if (!isAuthorizedStaff) {
      reply = `🔒 **Từ chối truy cập**: Bạn không có quyền xem chi tiết phụ cấp và đãi ngộ của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\`). Theo chính sách bảo mật thông tin nhân sự, chỉ HR và ADMIN phụ trách mới được truy cập dữ liệu này.`;
      return { reply, table: null, employee: { employee_code: emp.employee_code, employee_name: emp.employee_name, status: emp.status } };
    }
    reply = `Thông tin phụ cấp & chế độ đãi ngộ của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}):\n\n` +
      `* **Phụ cấp trách nhiệm**: ${emp.responsibility_allowance ? `${emp.responsibility_allowance} VNĐ` : 'Chưa áp dụng'}\n` +
      `* **Phụ cấp phương tiện / trọng tải**: ${emp.vessel_size_allowance ? `${emp.vessel_size_allowance} VNĐ` : 'Chưa áp dụng'}\n` +
      `* **Phụ cấp chuyên môn T1**: ${emp.professional_allowance_t1 ? `${emp.professional_allowance_t1} VNĐ` : 'Chưa áp dụng'}\n` +
      `* **Thưởng chuyên cần**: ${emp.attendance_bonus ? `${emp.attendance_bonus} VNĐ` : 'Theo quy chế đánh giá công ty'}\n` +
      `* **Lương năng suất / trách nhiệm**: ${emp.productivity_responsibility_pay ? `${emp.productivity_responsibility_pay} VNĐ` : 'Chưa áp dụng'}\n` +
      `* **Phụ cấp ăn ca**: ${emp.meal_allowance ? `${emp.meal_allowance} VNĐ` : 'Theo quy định chung'}\n` +
      `* **Phụ cấp khác**: ${emp.other_allowances || 'Không có'}`;

  } else if (targetAttr === 'contract') {
    attachTable = false;
    let contractType = 'Chưa xác định';
    if (emp.open_ended_contract && emp.open_ended_contract !== '0') contractType = 'Hợp đồng lao động không xác định thời hạn (Vô thời hạn)';
    else if (emp.fixed_term_contract && emp.fixed_term_contract !== '0') contractType = 'Hợp đồng lao động xác định thời hạn';
    else if (emp.seasonal_contract && emp.seasonal_contract !== '0') contractType = 'Hợp đồng lao động thời vụ / mùa vụ';

    reply = `Thông tin hợp đồng lao động của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}):\n\n` +
      `* **Loại hợp đồng**: **${contractType}**\n` +
      `* **Ngày bắt đầu hợp đồng**: ${emp.contract_start_date ? formatDateDisplay(emp.contract_start_date) : (emp.employment_start_date ? formatDateDisplay(emp.employment_start_date) : 'Chưa cập nhật')}\n` +
      `* **Thời hạn / Ngày kết thúc hợp đồng**: ${emp.contract_end_date ? formatDateDisplay(emp.contract_end_date) : (emp.open_ended_contract ? 'Không xác định thời hạn' : 'Chưa cập nhật')}\n` +
      `* **Ngày ký HĐLĐ chính thức**: ${emp.official_labor_contract_sign_date ? formatDateDisplay(emp.official_labor_contract_sign_date) : 'Chưa cập nhật'}`;

  } else if (targetAttr === 'recruitment_decision_no') {
    attachTable = false;
    const val = emp.recruitment_decision_no ? `\`${emp.recruitment_decision_no}\`` : 'Chưa cập nhật trong hồ sơ';
    reply = `Số quyết định tuyển dụng của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Ngày vào làm việc**: ${formatDateDisplay(emp.employment_start_date)}\n` +
      `* **Chức danh**: ${jobTitle}\n` +
      `* **Phòng ban**: ${dept}`;

  } else if (targetAttr === 'employment_start_date') {
    attachTable = false;
    const val = emp.employment_start_date ? formatDateDisplay(emp.employment_start_date) : (emp.contract_start_date ? formatDateDisplay(emp.contract_start_date) : 'Chưa cập nhật trong hồ sơ');
    reply = `Ngày vào làm việc của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Số quyết định tuyển dụng**: ${emp.recruitment_decision_no ? `\`${emp.recruitment_decision_no}\`` : 'Chưa cập nhật'}\n` +
      `* **Chức danh / Vị trí**: ${jobTitle}\n` +
      `* **Phòng ban**: ${dept}`;

  } else if (targetAttr === 'file_name') {
    attachTable = false;
    const val = emp.file_name ? `\`${emp.file_name}\`` : 'Chưa có tệp hồ sơ đính kèm';
    reply = `Tệp hồ sơ scan của nhân sự **${emp.employee_name}** (Mã NV: \`${emp.employee_code}\` - ${compLabel}) là: **${val}**.\n\n` +
      `* **Thời gian tạo hồ sơ**: ${emp.create_time ? new Date(emp.create_time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Chưa cập nhật'}\n` +
      `* **Đơn vị trực thuộc**: ${compLabel}`;

  } else {
    // Truy vấn tổng quát toàn diện (Hiển thị đầy đủ 53 trường thông tin chuẩn hóa)
    let contractType = 'Hợp đồng lao động';
    if (emp.open_ended_contract && emp.open_ended_contract !== '0') contractType = 'HĐLĐ không xác định thời hạn';
    else if (emp.fixed_term_contract && emp.fixed_term_contract !== '0') contractType = 'HĐLĐ xác định thời hạn';
    else if (emp.seasonal_contract && emp.seasonal_contract !== '0') contractType = 'HĐLĐ thời vụ';

    reply = `### 🟢 HỒ SƠ NHÂN SỰ TOÀN DIỆN (53 TRƯỜNG CHUẨN HÓA) — ĐANG LÀM VIỆC (ACTIVE)\n\n` +
      `#### 👤 1. Thông tin cá nhân & Định danh\n` +
      `- **Họ và tên**: **${emp.employee_name}**\n` +
      `- **Mã nhân viên**: \`${emp.employee_code}\`\n` +
      `- **Ngày sinh**: ${dob}\n` +
      `- **Giới tính**: ${emp.gender || 'Chưa cập nhật'}\n` +
      `- **Dân tộc**: ${emp.ethnicity || 'Chưa cập nhật'}\n` +
      `- **Số CCCD / Định danh**: **${displayCccd}**\n` +
      (emp.citizen_id_issue_date ? `- **Ngày cấp CCCD**: ${formatDateDisplay(emp.citizen_id_issue_date)}\n` : '') +
      (emp.citizen_id_issue_place ? `- **Nơi cấp CCCD**: ${emp.citizen_id_issue_place}\n` : '') +
      (emp.birth_registration_place ? `- **Nơi sinh / Khai sinh**: ${emp.birth_registration_place}\n` : '') +
      (emp.place_of_origin ? `- **Quê quán / Nguyên quán**: ${emp.place_of_origin}\n` : '') +
      (emp.permanent_address ? `- **Địa chỉ thường trú**: ${emp.permanent_address}\n` : '') +
      (emp.current_address ? `- **Nơi ở hiện nay**: ${emp.current_address}\n` : '') +
      (emp.temporary_address ? `- **Địa chỉ tạm trú**: ${emp.temporary_address}\n` : '') +
      `\n#### 🏢 2. Vị trí công tác & Tổ chức\n` +
      `- **Đơn vị / Công ty**: **${compLabel}**\n` +
      `- **Phòng ban**: ${dept}\n` +
      (emp.section_staffing_plan ? `- **Bộ phận định biên**: ${emp.section_staffing_plan}\n` : '') +
      `- **Chức danh / Vị trí**: **${jobTitle}**\n` +
      (emp.professional_title ? `- **Chức danh chuyên môn**: ${emp.professional_title}\n` : '') +
      (emp.job_grade ? `- **Ngạch bậc**: ${emp.job_grade}\n` : '') +
      `- **Trạng thái**: \`🟢 ĐANG LÀM VIỆC (ACTIVE)\`\n` +
      `\n#### 🎓 3. Trình độ học vấn & Bằng cấp\n` +
      `- **Trình độ văn hóa**: ${emp.education_level || 'Chưa cập nhật'}\n` +
      `- **Trình độ chuyên môn**: ${emp.qualification || emp.professional_qualification || 'Chưa cập nhật'}\n` +
      (emp.training_institution ? `- **Cơ sở đào tạo**: ${emp.training_institution}\n` : '') +
      (emp.major ? `- **Chuyên ngành**: ${emp.major}\n` : '') +
      (emp.specialization ? `- **Ngành đào tạo**: ${emp.specialization}\n` : '') +
      (emp.graduation_grade ? `- **Xếp loại tốt nghiệp**: ${emp.graduation_grade}\n` : '') +
      (emp.training_mode ? `- **Hình thức đào tạo**: ${emp.training_mode}\n` : '') +
      (emp.degree_valid_until ? `- **Thời hạn văn bằng**: ${formatDateDisplay(emp.degree_valid_until)}\n` : '') +
      (emp.other_professional_certificates ? `- **Chứng chỉ khác**: ${emp.other_professional_certificates}\n` : '') +
      `\n#### 📑 4. Hợp đồng & Quyết định tuyển dụng\n` +
      `- **Loại hợp đồng**: ${contractType}\n` +
      `- **Ngày vào làm việc**: ${startDate}\n` +
      (emp.contract_end_date ? `- **Thời hạn hợp đồng đến**: ${formatDateDisplay(emp.contract_end_date)}\n` : '') +
      (emp.recruitment_decision_no ? `- **Số quyết định tuyển dụng**: \`${emp.recruitment_decision_no}\`\n` : '') +
      `\n#### 📞 5. Thông tin liên hệ & Hồ sơ\n` +
      `- **Số điện thoại**: ${phone}\n` +
      `- **Email**: ${email}\n` +
      (emp.file_name ? `- **Tệp hồ sơ scan gốc**: \`${emp.file_name}\`\n` : '');

    // Phase E: Văn bản Thỏa thuận Lương & Chế độ Đãi ngộ (Bảo toàn 100% cho người có quyền)
    if (isAuthorizedStaff) {
      const hasSalary = emp.base_salary || emp.total_income || emp.social_insurance_salary || emp.productivity_responsibility_pay || emp.meal_allowance;
      if (hasSalary) {
        reply += `\n#### 💰 6. Văn bản Thỏa thuận Lương & Chế độ Đãi ngộ\n` +
          (emp.base_salary ? `- **Lương cơ bản**: **${Number(emp.base_salary).toLocaleString('vi-VN')} VNĐ**\n` : '') +
          (emp.total_income ? `- **Tổng thu nhập thỏa thuận**: **${Number(emp.total_income).toLocaleString('vi-VN')} VNĐ**\n` : '') +
          (emp.social_insurance_salary ? `- **Lương đóng BHXH**: ${Number(emp.social_insurance_salary).toLocaleString('vi-VN')} VNĐ\n` : '') +
          (emp.productivity_responsibility_pay ? `- **Lương năng suất / Trách nhiệm**: ${Number(emp.productivity_responsibility_pay).toLocaleString('vi-VN')} VNĐ\n` : '') +
          (emp.attendance_bonus ? `- **Thưởng chuyên cần**: ${Number(emp.attendance_bonus).toLocaleString('vi-VN')} VNĐ\n` : '') +
          (emp.responsibility_allowance ? `- **Phụ cấp trách nhiệm**: ${Number(emp.responsibility_allowance).toLocaleString('vi-VN')} VNĐ\n` : '') +
          (emp.meal_allowance ? `- **Phụ cấp ăn trưa**: ${Number(emp.meal_allowance).toLocaleString('vi-VN')} VNĐ\n` : '') +
          (emp.other_allowances ? `- **Các phụ cấp khác**: ${Number(emp.other_allowances).toLocaleString('vi-VN')} VNĐ\n` : '');
      }
    }
  }

  return {
    reply,
    table: attachTable ? buildStandardTable([emp], user) : null,
    employee: {
      employee_code: emp.employee_code,
      employee_name: emp.employee_name,
      status: emp.status
    }
  };
}

function formatMultipleEmployeesResponse(employees, user, intent, compLabel, missingDobRows) {
  const count = employees.length;

  // Nếu là tìm theo tên và có nhiều người trùng tên -> làm rõ
  const isDisambiguation = Boolean(intent.targetName && count > 1 && !intent.isUniversalMatch);

  let title = `🔍 Tìm thấy **${count}** hồ sơ nhân sự phù hợp với yêu cầu tra cứu (${compLabel}):`;
  if (isDisambiguation) {
    title = `⚠️ **Phát hiện ${count} nhân sự trùng khớp với từ khóa "${intent.targetName}"**:\n\nVui lòng xem danh sách dưới đây và chọn chính xác Mã nhân viên để tra cứu chi tiết:`;
  } else if (intent.explicitStatus && intent.statusFilter === 'DELETED') {
    title = `🗑️ **Danh sách hồ sơ nhân sự đã xóa mềm (DELETED)** (${compLabel}):`;
  } else if (intent.explicitStatus && intent.statusFilter === 'RESIGNED') {
    title = `🟠 **Danh sách nhân sự đã nghỉ việc (RESIGNED)** (${compLabel}):`;
  } else if (intent.birthYear) {
    title = `📅 **Danh sách nhân sự sinh năm ${intent.birthYear}** (${compLabel}):`;
  } else if (intent.ageFilter) {
    const ageDesc = intent.ageFilter.op === '<' ? `dưới ${intent.ageFilter.val} tuổi` : (intent.ageFilter.op === '>' ? `trên ${intent.ageFilter.val} tuổi` : `${intent.ageFilter.val} tuổi`);
    title = `👥 **Danh sách nhân sự ${ageDesc}** (${compLabel}):`;
  } else if (intent.recruitmentDecision) {
    title = `📄 **Danh sách nhân sự theo Số quyết định tuyển dụng: "${intent.recruitmentDecision}"** (${compLabel}):`;
  } else if (intent.schoolFilter) {
    title = `🎓 **Danh sách nhân sự tốt nghiệp / đào tạo tại "${intent.schoolFilter}"** (${compLabel}):`;
  } else if (intent.majorFilter) {
    title = `📚 **Danh sách nhân sự chuyên ngành "${intent.majorFilter}"** (${compLabel}):`;
  } else if (intent.qualificationFilter) {
    title = `🎖️ **Danh sách nhân sự có Trình độ / Bằng cấp "${intent.qualificationFilter}"** (${compLabel}):`;
  } else if (intent.placeFilter) {
    title = `📍 **Danh sách nhân sự theo Quê quán / Địa chỉ "${intent.placeFilter}"** (${compLabel}):`;
  } else if (intent.genderFilter) {
    title = `👥 **Danh sách nhân sự (Giới tính: ${intent.genderFilter})** (${compLabel}):`;
  } else if (intent.certificateFilter) {
    title = `📜 **Danh sách nhân sự có Chứng chỉ chuyên môn "${intent.certificateFilter}"** (${compLabel}):`;
  } else if (intent.fileFilter) {
    title = `📁 **Danh sách nhân sự theo Tệp hồ sơ "${intent.fileFilter}"** (${compLabel}):`;
  } else if (intent.isUniversalMatch) {
    title = `🔍 **Tìm thấy ${count} hồ sơ nhân sự khớp với từ khóa "${intent.universalKeyword || intent.targetName}"** (${compLabel}):`;
  }

  let lines = employees.map((emp, idx) => {
    let statusBadge = '🟢 Đang làm việc';
    if (emp.status === 'RESIGNED') statusBadge = '🟠 Đã nghỉ việc';
    else if (emp.status === 'DELETED') statusBadge = '🔴 Đã xóa mềm';

    const comp = emp.company_id || '';
    const job = emp.job_title || emp.position || 'Chưa cập nhật';
    const dept = emp.department_staffing_plan || emp.department || 'Chưa cập nhật';
    const code = emp.employee_code || '';
    const ageStr = emp._calculatedAge !== undefined ? ` (${emp._calculatedAge} tuổi)` : '';
    const dobStr = emp.date_of_birth ? ` | NS: ${formatDateDisplay(emp.date_of_birth)}${ageStr}` : '';

    let matchDetailStr = '';
    if (emp._matchedDetail) {
      matchDetailStr = `\n     ↳ 🎯 *${emp._matchedDetail}*`;
    } else {
      const extra = findMatchingAttributeDetail(emp, intent.schoolFilter || intent.majorFilter || intent.qualificationFilter || intent.placeFilter || intent.recruitmentDecision || intent.certificateFilter || intent.fileFilter);
      if (extra) matchDetailStr = `\n     ↳ 🎯 *${extra}*`;
    }

    return `${idx + 1}. **${emp.employee_name}** [\`${code}\`] — **${statusBadge}**\n` +
      `   - Đơn vị: **${comp}** | Vị trí: *${job}* | Phòng ban: *${dept}*${dobStr}${matchDetailStr}`;
  }).join('\n\n');

  let note = '';
  if (missingDobRows.length > 0 && (intent.ageFilter || intent.birthYear)) {
    note = `\n\n*(Lưu ý: Có ${missingDobRows.length} nhân sự chưa có ngày sinh trong hệ thống).*`;
  }

  const reply = `${title}\n\n` +
    `${lines}${note}\n\n` +
    `💡 *Bạn có thể xem chi tiết từng người bằng cách nhắn chính xác Mã nhân viên (ví dụ: \`${employees[0].employee_code}\`).*`;

  return {
    reply,
    table: buildStandardTable(employees, user),
    total_found: count
  };
}

module.exports = {
  handleEmployeeLookupIntent,
  formatSingleEmployeeResponse,
  parseIntent,
  parseBirthDate,
  calculateExactAge,
  formatDateDisplay,
  maskCccd,
  removeAccents,
  buildStandardTable,
  COLUMNS
};
