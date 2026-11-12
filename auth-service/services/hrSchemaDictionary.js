/**
 * SOTRANS HUB - HR Schema Dictionary & Field Metadata Engine
 * Chuẩn hóa 53 trường dữ liệu hồ sơ nhân sự theo file tham chiếu Hoso_Nhansu.xlsx
 */

const FIELD_STATUS = {
  EXTRACTED: 'EXTRACTED',                 // Đã nhận diện thành công từ tài liệu
  NOT_FOUND: 'NOT_FOUND',                 // Không tồn tại thông tin trong tài liệu
  UNREADABLE: 'UNREADABLE',               // Có dấu hiệu thông tin nhưng bị mờ/chữ viết tay không đọc được
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',       // Có kết quả nhưng độ tin cậy thấp
  NEEDS_REVIEW: 'NEEDS_REVIEW',           // Cần HR kiểm tra, đối soát
  CONFLICT: 'CONFLICT',                   // Các tài liệu có thông tin mâu thuẫn
  NOT_PROCESSED: 'NOT_PROCESSED',         // Chưa được xử lý
  VALIDATION_FAILED: 'VALIDATION_FAILED'  // Kết quả không vượt qua kiểm tra dữ liệu
};

// Thứ tự và tên 53 cột chuẩn khớp 100% với file Hoso_Nhansu.xlsx
const CANONICAL_53_FIELDS = [
  'job_grade',
  'employee_id',
  'full_name',
  'date_of_birth',
  'gender',
  'job_title',
  'professional_title',
  'department_staffing_plan',
  'section_staffing_plan',
  'citizen_id',
  'citizen_id_issue_date',
  'citizen_id_issue_place',
  'birth_registration_place',
  'place_of_origin',
  'permanent_address',
  'temporary_address',
  'current_address',
  'ethnicity',
  'education_level',
  'education_code',
  'qualification',
  'professional_qualification',
  'specialization',
  'degree_qualification',
  'training_institution',
  'major',
  'training_mode',
  'training_period',
  'graduation_grade',
  'degree_valid_until',
  'other_professional_certificates',
  'social_insurance_salary',
  'total_income',
  'base_salary',
  'productivity_responsibility_pay',
  'attendance_bonus',
  'responsibility_allowance',
  'vessel_size_allowance',
  'professional_allowance_t1',
  'meal_allowance',
  'other_allowances',
  'open_ended_contract',
  'fixed_term_contract',
  'seasonal_contract',
  'contract_start_date',
  'contract_end_date',
  'recruitment_decision_no',
  'employment_start_date',
  'official_labor_contract_sign_date',
  'phone_number',
  'email',
  'Create_Time',
  'fileName'
];

// Từ điển ánh xạ các biến thể tên trường tiếng Việt / viết tắt sang tên cột chuẩn
const FIELD_ALIASES = {
  // 1. job_grade
  job_grade: 'job_grade',
  grade: 'job_grade',
  cap_bac: 'job_grade',

  // 2. employee_id
  employee_id: 'employee_id',
  ma_nhan_vien: 'employee_id',
  ma_nv: 'employee_id',
  employee_code: 'employee_id',

  // 3. full_name
  full_name: 'full_name',
  ho_va_ten: 'full_name',
  ho_ten: 'full_name',
  name: 'full_name',

  // 4. date_of_birth
  date_of_birth: 'date_of_birth',
  ngay_sinh: 'date_of_birth',
  dob: 'date_of_birth',

  // 5. gender
  gender: 'gender',
  gioi_tinh: 'gender',

  // 6. job_title
  job_title: 'job_title',
  chuc_danh: 'job_title',
  chuc_vu: 'job_title',
  vi_tri: 'job_title',

  // 7. professional_title
  professional_title: 'professional_title',
  chuc_danh_chuyen_mon: 'professional_title',

  // 8. department_staffing_plan
  department_staffing_plan: 'department_staffing_plan',
  dinh_bien_phong_ban: 'department_staffing_plan',
  phong_ban: 'department_staffing_plan',
  department: 'department_staffing_plan',

  // 9. section_staffing_plan
  section_staffing_plan: 'section_staffing_plan',
  dinh_bien_bo_phan: 'section_staffing_plan',
  bo_phan: 'section_staffing_plan',

  // 10. citizen_id
  citizen_id: 'citizen_id',
  cccd_so: 'citizen_id',
  so_cccd: 'citizen_id',
  cccd: 'citizen_id',
  cmnd: 'citizen_id',
  so_dinh_danh: 'citizen_id',

  // 11. citizen_id_issue_date
  citizen_id_issue_date: 'citizen_id_issue_date',
  cccd_ngay_cap: 'citizen_id_issue_date',
  ngay_cap_cccd: 'citizen_id_issue_date',

  // 12. citizen_id_issue_place
  citizen_id_issue_place: 'citizen_id_issue_place',
  cccd_noi_cap: 'citizen_id_issue_place',
  noi_cap_cccd: 'citizen_id_issue_place',

  // 13. birth_registration_place
  birth_registration_place: 'birth_registration_place',
  noi_dang_ky_khai_sinh: 'birth_registration_place',
  noi_khai_sinh: 'birth_registration_place',

  // 14. place_of_origin
  place_of_origin: 'place_of_origin',
  que_quan: 'place_of_origin',
  nguyen_quan: 'place_of_origin',

  // 15. permanent_address
  permanent_address: 'permanent_address',
  dia_chi_thuong_tru: 'permanent_address',
  thuong_tru: 'permanent_address',
  noi_thuong_tru: 'permanent_address',

  // 16. temporary_address
  temporary_address: 'temporary_address',
  dia_chi_tam_tru: 'temporary_address',
  tam_tru: 'temporary_address',

  // 17. current_address
  current_address: 'current_address',
  dia_chi_hien_tai: 'current_address',
  noi_o_hien_nay: 'current_address',
  hien_tai: 'current_address',

  // 18. ethnicity
  ethnicity: 'ethnicity',
  dan_toc: 'ethnicity',

  // 19. education_level
  education_level: 'education_level',
  trinh_do_van_hoa: 'education_level',
  hoc_van: 'education_level',

  // 20. education_code
  education_code: 'education_code',
  ky_hieu_trinh_do: 'education_code',

  // 21. qualification
  qualification: 'qualification',
  trinh_do: 'qualification',

  // 22. professional_qualification
  professional_qualification: 'professional_qualification',
  trinh_do_chuyen_mon: 'professional_qualification',

  // 23. specialization
  specialization: 'specialization',
  chuyen_mon: 'specialization',

  // 24. degree_qualification
  degree_qualification: 'degree_qualification',
  qtdt_bang_cap_chuyen_mon: 'degree_qualification',
  bang_cap: 'degree_qualification',

  // 25. training_institution
  training_institution: 'training_institution',
  qtdt_ten_truong_dao_tao: 'training_institution',
  truong_dao_tao: 'training_institution',
  ten_truong: 'training_institution',

  // 26. major
  major: 'major',
  qtdt_chuyen_nganh: 'major',
  chuyen_nganh: 'major',
  nganh_dao_tao: 'major',

  // 27. training_mode
  training_mode: 'training_mode',
  qtdt_he_dao_tao: 'training_mode',
  he_dao_tao: 'training_mode',

  // 28. training_period
  training_period: 'training_period',
  qtdt_nam_dao_tao: 'training_period',
  nam_dao_tao: 'training_period',

  // 29. graduation_grade
  graduation_grade: 'graduation_grade',
  qtdt_xep_loai: 'graduation_grade',
  xep_loai: 'graduation_grade',

  // 30. degree_valid_until
  degree_valid_until: 'degree_valid_until',
  qtdt_bang_cap_gia_tri_den: 'degree_valid_until',
  gia_tri_den: 'degree_valid_until',

  // 31. other_professional_certificates
  other_professional_certificates: 'other_professional_certificates',
  chung_chi_chuyen_mon_khac: 'other_professional_certificates',
  chung_chi_khac: 'other_professional_certificates',

  // 32. social_insurance_salary
  social_insurance_salary: 'social_insurance_salary',
  luong_dong_bhxh_bhyt_bhtn: 'social_insurance_salary',
  luong_bhxh: 'social_insurance_salary',

  // 33. total_income
  total_income: 'total_income',
  tong_thu_nhap: 'total_income',

  // 34. base_salary
  base_salary: 'base_salary',
  luong_chinh: 'base_salary',
  luong_co_ban: 'base_salary',

  // 35. productivity_responsibility_pay
  productivity_responsibility_pay: 'productivity_responsibility_pay',
  tien_nang_suat_trach_nhiem: 'productivity_responsibility_pay',
  nang_suat_trach_nhiem: 'productivity_responsibility_pay',

  // 36. attendance_bonus
  attendance_bonus: 'attendance_bonus',
  tien_chuyen_can: 'attendance_bonus',
  chuyen_can: 'attendance_bonus',

  // 37. responsibility_allowance
  responsibility_allowance: 'responsibility_allowance',
  phu_cap_trach_nhiem: 'responsibility_allowance',

  // 38. vessel_size_allowance
  vessel_size_allowance: 'vessel_size_allowance',
  phu_cap_size_tau: 'vessel_size_allowance',

  // 39. professional_allowance_t1
  professional_allowance_t1: 'professional_allowance_t1',
  pc_chuyen_mon_t1: 'professional_allowance_t1',

  // 40. meal_allowance
  meal_allowance: 'meal_allowance',
  tien_an: 'meal_allowance',

  // 41. other_allowances
  other_allowances: 'other_allowances',
  phu_cap_khac: 'other_allowances',

  // 42. open_ended_contract
  open_ended_contract: 'open_ended_contract',
  loai_hdld_kxd: 'open_ended_contract',
  hdld_kxd: 'open_ended_contract',

  // 43. fixed_term_contract
  fixed_term_contract: 'fixed_term_contract',
  loai_hdld_thoi_han: 'fixed_term_contract',
  hdld_co_thoi_han: 'fixed_term_contract',

  // 44. seasonal_contract
  seasonal_contract: 'seasonal_contract',
  loai_hdld_luu_dung: 'seasonal_contract',
  hdld_luu_dung: 'seasonal_contract',
  hdld_mua_vu: 'seasonal_contract',

  // 45. contract_start_date
  contract_start_date: 'contract_start_date',
  thoi_han_tu_ngay: 'contract_start_date',
  hdld_tu_ngay: 'contract_start_date',

  // 46. contract_end_date
  contract_end_date: 'contract_end_date',
  thoi_han_den_ngay: 'contract_end_date',
  hdld_den_ngay: 'contract_end_date',

  // 47. recruitment_decision_no
  recruitment_decision_no: 'recruitment_decision_no',
  so_qd_tuyen_dung: 'recruitment_decision_no',
  qd_tuyen_dung: 'recruitment_decision_no',

  // 48. employment_start_date
  employment_start_date: 'employment_start_date',
  ngay_vao_lam_viec_swc: 'employment_start_date',
  ngay_vao_lam: 'employment_start_date',

  // 49. official_labor_contract_sign_date
  official_labor_contract_sign_date: 'official_labor_contract_sign_date',
  ngay_ky_hdld_chinh_thuc: 'official_labor_contract_sign_date',
  ngay_ky_hdld: 'official_labor_contract_sign_date',

  // 50. phone_number
  phone_number: 'phone_number',
  so_dien_thoai: 'phone_number',
  sdt: 'phone_number',
  phone: 'phone_number',

  // 51. email
  email: 'email',

  // 52. Create_Time
  Create_Time: 'Create_Time',
  create_time: 'Create_Time',

  // 53. fileName
  fileName: 'fileName',
  file_name: 'fileName'
};

// Định nghĩa nguồn tài liệu ưu tiên cho từng nhóm trường (VNeID/CCCD có độ tin cậy pháp lý cao nhất)
const FIELD_DOCUMENT_SOURCES = {
  // Định danh cá nhân -> Ưu tiên VNeID / CCCD, tiếp theo BHYT, Giấy khám sức khỏe, Sơ yếu lý lịch
  full_name: ['CCCD_VNEID', 'BHYT', 'GIAY_KHAM_SUC_KHOE', 'SO_YEU_LY_LICH', 'DON_XIN_VIEC', 'QUYET_DINH_TUYEN_DUNG'],
  date_of_birth: ['CCCD_VNEID', 'BHYT', 'GIAY_KHAM_SUC_KHOE', 'SO_YEU_LY_LICH', 'DON_XIN_VIEC'],
  gender: ['CCCD_VNEID', 'BHYT', 'GIAY_KHAM_SUC_KHOE', 'SO_YEU_LY_LICH', 'DON_XIN_VIEC'],
  citizen_id: ['CCCD_VNEID', 'BHYT', 'SO_YEU_LY_LICH', 'DON_XIN_VIEC'],
  citizen_id_issue_date: ['CCCD_VNEID', 'SO_YEU_LY_LICH'],
  citizen_id_issue_place: ['CCCD_VNEID', 'SO_YEU_LY_LICH'],
  birth_registration_place: ['CCCD_VNEID', 'SO_YEU_LY_LICH'],
  place_of_origin: ['CCCD_VNEID', 'SO_YEU_LY_LICH'],
  permanent_address: ['CCCD_VNEID', 'BHYT', 'SO_YEU_LY_LICH', 'DON_XIN_VIEC'],

  // Dân tộc, Trình độ văn hóa, Địa chỉ liên hệ -> Sơ yếu lý lịch, Đơn xin việc
  ethnicity: ['SO_YEU_LY_LICH', 'CCCD_VNEID'],
  education_level: ['SO_YEU_LY_LICH', 'DON_XIN_VIEC'],
  temporary_address: ['SO_YEU_LY_LICH', 'CCCD_VNEID'],
  current_address: ['SO_YEU_LY_LICH', 'DON_XIN_VIEC', 'CCCD_VNEID'],
  phone_number: ['DON_XIN_VIEC', 'SO_YEU_LY_LICH', 'LUONG_PHU_CAP'],
  email: ['DON_XIN_VIEC', 'SO_YEU_LY_LICH'],

  // Bằng cấp & Đào tạo -> Bằng cấp, Chứng chỉ, Hồ sơ đào tạo
  qualification: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  professional_qualification: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  specialization: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  degree_qualification: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  training_institution: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  major: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  training_mode: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  training_period: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  graduation_grade: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  degree_valid_until: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],
  other_professional_certificates: ['BANG_CAP_CHUNG_CHI', 'SO_YEU_LY_LICH'],

  // Vị trí & Tuyển dụng -> Quyết định tuyển dụng, HĐLĐ
  job_title: ['QUYET_DINH_TUYEN_DUNG', 'HOP_DONG_LAO_DONG', 'DON_XIN_VIEC'],
  professional_title: ['QUYET_DINH_TUYEN_DUNG', 'BANG_CAP_CHUNG_CHI'],
  department_staffing_plan: ['QUYET_DINH_TUYEN_DUNG', 'HOP_DONG_LAO_DONG'],
  section_staffing_plan: ['QUYET_DINH_TUYEN_DUNG', 'HOP_DONG_LAO_DONG'],
  recruitment_decision_no: ['QUYET_DINH_TUYEN_DUNG'],
  employment_start_date: ['QUYET_DINH_TUYEN_DUNG', 'HOP_DONG_LAO_DONG'],

  // Lương & Hợp đồng lao động -> HĐLĐ, Bảng lương, QĐ tuyển dụng
  base_salary: ['HOP_DONG_LAO_DONG', 'LUONG_PHU_CAP', 'QUYET_DINH_TUYEN_DUNG'],
  social_insurance_salary: ['HOP_DONG_LAO_DONG', 'LUONG_PHU_CAP'],
  total_income: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  productivity_responsibility_pay: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  attendance_bonus: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  responsibility_allowance: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  vessel_size_allowance: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  professional_allowance_t1: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  meal_allowance: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  other_allowances: ['LUONG_PHU_CAP', 'HOP_DONG_LAO_DONG'],
  open_ended_contract: ['HOP_DONG_LAO_DONG'],
  fixed_term_contract: ['HOP_DONG_LAO_DONG'],
  seasonal_contract: ['HOP_DONG_LAO_DONG'],
  contract_start_date: ['HOP_DONG_LAO_DONG'],
  contract_end_date: ['HOP_DONG_LAO_DONG'],
  official_labor_contract_sign_date: ['HOP_DONG_LAO_DONG']
};

/**
 * Chuẩn hóa giá trị trường theo kiểu dữ liệu quy chuẩn
 */
function normalizeFieldValue(fieldName, rawVal) {
  if (rawVal === undefined || rawVal === null) return '';
  let str = String(rawVal).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined' || str === '---') {
    return '';
  }

  // 1. Số CCCD / CMND: Phải giữ nguyên số 0 ở đầu, loại bỏ dấu cách và ký tự không phải số
  if (fieldName === 'citizen_id') {
    const digits = str.replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 12) {
      return digits.padStart(digits.length > 9 ? 12 : 9, '0');
    }
    return digits;
  }

  // 2. Số điện thoại: Phải giữ nguyên số 0 ở đầu (10 hoặc 11 số)
  if (fieldName === 'phone_number') {
    let digits = str.replace(/\D/g, '');
    if (digits.startsWith('84') && digits.length >= 11) {
      digits = '0' + digits.slice(2);
    }
    if (digits.length >= 9 && !digits.startsWith('0')) {
      digits = '0' + digits;
    }
    return digits;
  }

  // 3. Họ và tên: Viết hoa chuẩn tiếng Việt
  if (fieldName === 'full_name') {
    return str.toUpperCase().replace(/\s+/g, ' ');
  }

  // 4. Ngày tháng: Chuẩn hóa YYYY-MM-DD
  if (fieldName.includes('date') || fieldName.includes('ngay')) {
    // Trường hợp DD/MM/YYYY
    const dmyMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
    if (dmyMatch) {
      const d = dmyMatch[1].padStart(2, '0');
      const m = dmyMatch[2].padStart(2, '0');
      const y = dmyMatch[3];
      return `${y}-${m}-${d}`;
    }
    // Trường hợp YYYY-MM-DD (có thể kèm giờ 00:00:00)
    const ymdMatch = str.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    if (ymdMatch) {
      const y = ymdMatch[1];
      const m = ymdMatch[2].padStart(2, '0');
      const d = ymdMatch[3].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // 5. Giá trị tiền (Lương, phụ cấp): Chuẩn hóa số nguyên sạch, loại bỏ dấu chấm/phẩy ngăn cách hoặc chữ 'VNĐ', '.0'
  if (
    fieldName === 'base_salary' ||
    fieldName === 'social_insurance_salary' ||
    fieldName === 'total_income' ||
    fieldName === 'productivity_responsibility_pay' ||
    fieldName === 'attendance_bonus' ||
    fieldName === 'responsibility_allowance' ||
    fieldName === 'vessel_size_allowance' ||
    fieldName === 'professional_allowance_t1' ||
    fieldName === 'meal_allowance' ||
    fieldName === 'other_allowances'
  ) {
    // Nếu có dạng 8000000.0 thì lấy phần nguyên
    let clean = str.replace(/\.0+$/, '').replace(/,/g, '').replace(/\./g, '').replace(/[^\d]/g, '');
    return clean;
  }

  return str;
}

/**
 * Xây dựng metadata trạng thái và độ tin cậy cho từng trường (5 trạng thái cốt lõi: EXTRACTED, NOT_FOUND, UNREADABLE, LOW_CONFIDENCE, NEEDS_REVIEW)
 */
function buildSchemaMetadata(extractedObj = {}, documentType = 'GENERAL', provenance = {}, conflicts = {}, options = {}) {
  const metadata = {};
  const unreadableSet = new Set((options.unreadableFields || options.unreadable_fields || []).map(f => FIELD_ALIASES[f] || f));
  const uncertainSet = new Set((options.uncertainFields || options.uncertain_fields || []).map(f => FIELD_ALIASES[f] || f));

  for (const field of CANONICAL_53_FIELDS) {
    if (field === 'Create_Time' || field === 'fileName') continue;

    const val = extractedObj[field];
    const prov = provenance[field] || null;
    const hasConflict = !!conflicts[field];
    const isUnreadable = unreadableSet.has(field);
    const isUncertain = uncertainSet.has(field);

    if (hasConflict) {
      metadata[field] = {
        status: FIELD_STATUS.CONFLICT,
        confidence: 'medium',
        value: val || '',
        conflict_details: conflicts[field],
        source: prov ? prov.fileName : null,
        document_type: prov ? prov.docType : documentType
      };
    } else if (isUnreadable) {
      metadata[field] = {
        status: FIELD_STATUS.UNREADABLE,
        confidence: 'none',
        value: val || '',
        source: prov ? prov.fileName : null,
        document_type: prov ? prov.docType : documentType,
        note: 'Tài liệu có chứa trường này nhưng chữ bị mờ hoặc viết tay không thể đọc rõ'
      };
    } else if (isUncertain) {
      metadata[field] = {
        status: FIELD_STATUS.NEEDS_REVIEW,
        confidence: 'low',
        value: val || '',
        source: prov ? prov.fileName : null,
        document_type: prov ? prov.docType : documentType,
        note: 'Độ tin cậy chưa cao hoặc có sự nghi ngờ, cần HR rà soát trực tiếp'
      };
    } else if (val && String(val).trim() !== '') {
      // Đã có giá trị trích xuất
      let conf = 'high';
      if (field === 'citizen_id' && String(val).length !== 12 && String(val).length !== 9) {
        conf = 'low';
      }
      metadata[field] = {
        status: conf === 'low' ? FIELD_STATUS.LOW_CONFIDENCE : FIELD_STATUS.EXTRACTED,
        confidence: conf,
        value: val,
        source: prov ? prov.fileName : null,
        document_type: prov ? prov.docType : documentType
      };
    } else {
      // Không tìm thấy giá trị trong tài liệu
      metadata[field] = {
        status: FIELD_STATUS.NOT_FOUND,
        confidence: 'high', // Xác nhận chính xác là không có trong tài liệu
        value: '',
        source: null,
        document_type: documentType,
        note: 'Không xuất hiện trong tài liệu gốc'
      };
    }
  }

  return metadata;
}

/**
 * Nhận diện loại tài liệu dựa trên văn bản hoặc tên tệp (Hỗ trợ toàn bộ nhóm tài liệu nhân sự)
 */
function classifyDocumentType(fileName = '', text = '') {
  const combined = `${fileName} ${text}`.toLowerCase();

  if (/(?:căn cước công dân|cccd|vneid|định danh điện tử|cmnd|cục cảnh sát quản lý hành chính)/i.test(combined)) {
    return 'CCCD_VNEID';
  }
  if (/(?:thẻ bảo hiểm y tế|bảo hiểm y tế|bhyt|mã thẻ bhyt|cơ quan bhxh|bảo hiểm xã hội)/i.test(combined)) {
    return 'BHYT';
  }
  if (/(?:giấy khám sức khỏe|khám sức khỏe|bệnh viện|kết luận sức khỏe|phân loại sức khỏe)/i.test(combined)) {
    return 'GIAY_KHAM_SUC_KHOE';
  }
  if (/(?:sơ yếu lý lịch|lý lịch cá nhân|lý lịch tự thuật|thành phần gia đình)/i.test(combined)) {
    return 'SO_YEU_LY_LICH';
  }
  if (/(?:quyết định tuyển dụng|tiếp nhận và bố trí|qđ-đsmn|bổ nhiệm|về việc tiếp nhận|quyết định về việc)/i.test(combined)) {
    return 'QUYET_DINH_TUYEN_DUNG';
  }
  if (/(?:hợp đồng lao động|hđlđ|phụ lục hợp đồng|thời hạn hợp đồng|người sử dụng lao động)/i.test(combined)) {
    return 'HOP_DONG_LAO_DONG';
  }
  if (/(?:bằng tốt nghiệp|chứng chỉ|giấy chứng nhận khả năng chuyên môn|thuyền trưởng|máy trưởng|hạng fc|chứng chỉ chuyên môn)/i.test(combined)) {
    return 'BANG_CAP_CHUNG_CHI';
  }
  if (/(?:đơn xin việc|phiếu đăng ký dự tuyển|thư ứng tuyển|curriculum vitae|\bcv\b)/i.test(combined)) {
    return 'DON_XIN_VIEC';
  }
  if (/(?:bảng thanh toán lương|bảng lương|phiếu lương|chuyển lương|đơn đề nghị chuyển lương)/i.test(combined)) {
    return 'LUONG_PHU_CAP';
  }

  return 'GENERAL';
}

module.exports = {
  FIELD_STATUS,
  CANONICAL_53_FIELDS,
  FIELD_ALIASES,
  FIELD_DOCUMENT_SOURCES,
  normalizeFieldValue,
  buildSchemaMetadata,
  classifyDocumentType
};
