const db = require('../db');
const { canonicalizeIdentity, computeBlindIndex } = require('./identitySecurityService');

/**
 * Mask CCCD to preserve privacy in UI logs and alerts
 * e.g. 079204001284 -> 079******284, 025123456 -> 025***456
 */
function maskCccd(cccd) {
  if (!cccd) return 'Chưa có';
  const s = String(cccd).trim();
  if (s.length >= 9) {
    return s.substring(0, 3) + '******' + s.substring(s.length - 3);
  }
  if (s.length >= 6) {
    return s.substring(0, 2) + '****' + s.substring(s.length - 2);
  }
  return '******';
}

/**
 * Standardize and validate Citizen ID (CCCD)
 * Rules:
 * - CCCD must be 9 or 12 digits
 * - Digits only
 */
function standardizeAndValidateCccd(rawCitizenId) {
  if (!rawCitizenId) {
    return {
      valid: false,
      status: 'MISSING_CCCD',
      cleanCccd: null,
      reason: 'Chưa xác định được số CCCD từ tài liệu hoặc độ tin cậy OCR thấp. Cần kiểm tra thủ công.'
    };
  }

  const clean = String(rawCitizenId).replace(/\D/g, '');
  if (!clean) {
    return {
      valid: false,
      status: 'MISSING_CCCD',
      cleanCccd: null,
      reason: 'Chưa xác định được số CCCD từ tài liệu hoặc độ tin cậy OCR thấp. Cần kiểm tra thủ công.'
    };
  }

  if (clean.length !== 9 && clean.length !== 12) {
    return {
      valid: false,
      status: 'INVALID_CCCD',
      cleanCccd: clean,
      reason: `Số CCCD trích xuất (${maskCccd(clean)}) có độ dài không hợp lệ (${clean.length} số, yêu cầu 9 hoặc 12 chữ số). Cần kiểm tra thủ công.`
    };
  }

  return {
    valid: true,
    status: 'VALID_CCCD',
    cleanCccd: clean,
    reason: null
  };
}

/**
 * Field configuration and permission mapping
 */
const FIELD_PERMISSIONS = {
  // Contact info
  email: { permission: 'hr.profile.edit_contact', sensitive: false, label: 'Email liên hệ' },
  phone_number: { permission: 'hr.profile.edit_contact', sensitive: false, label: 'Số điện thoại' },
  current_address: { permission: 'hr.profile.edit_contact', sensitive: false, label: 'Nơi ở hiện nay' },
  temporary_address: { permission: 'hr.profile.edit_contact', sensitive: false, label: 'Địa chỉ tạm trú' },

  // Department & Job Title
  job_title: { permission: 'hr.profile.edit_department', sensitive: false, label: 'Chức vụ / Vị trí' },
  department_staffing_plan: { permission: 'hr.profile.edit_department', sensitive: false, label: 'Phòng ban / Đơn vị' },
  department: { permission: 'hr.profile.edit_department', sensitive: false, label: 'Phòng ban / Đơn vị' },
  section_staffing_plan: { permission: 'hr.profile.edit_department', sensitive: false, label: 'Bộ phận' },

  // Identity Info (Sensitive)
  full_name: { permission: 'hr.profile.edit_identity', sensitive: true, label: 'Họ và tên' },
  citizen_id: { permission: 'hr.profile.edit_identity', sensitive: true, label: 'Số CCCD / Định danh' },
  date_of_birth: { permission: 'hr.profile.edit_identity', sensitive: true, label: 'Ngày sinh' },
  gender: { permission: 'hr.profile.edit_identity', sensitive: false, label: 'Giới tính' },
  place_of_origin: { permission: 'hr.profile.edit_identity', sensitive: false, label: 'Quê quán' },
  permanent_address: { permission: 'hr.profile.edit_identity', sensitive: false, label: 'Nơi thường trú' },

  // Employee Code (High sensitivity)
  employee_id: { permission: 'hr.profile.edit_code', sensitive: true, label: 'Mã nhân viên' },
  employee_code: { permission: 'hr.profile.edit_code', sensitive: true, label: 'Mã nhân viên' },

  // Salary & Compensation (High sensitivity)
  base_salary: { permission: 'hr.profile.edit_salary', sensitive: true, label: 'Mức lương cơ bản' },
  total_income: { permission: 'hr.profile.edit_salary', sensitive: true, label: 'Tổng thu nhập' },
  social_insurance_salary: { permission: 'hr.profile.edit_salary', sensitive: true, label: 'Lương đóng BHXH' },
  productivity_responsibility_pay: { permission: 'hr.profile.edit_salary', sensitive: true, label: 'Lương năng suất / Trách nhiệm' },

  // Company Transfer (Super Admin only)
  company_id: { permission: 'hr.profile.transfer_company', sensitive: true, label: 'Công ty trực thuộc' }
};

/**
 * Helper: Kiểm tra sai lệch họ tên đáng kể (Identity Mismatch)
 */
function isSignificantNameMismatch(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const clean = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
  const a = clean(nameA);
  const b = clean(nameB);
  if (!a || !b || a === 'nhan vien moi' || b === 'nhan vien moi') return false;
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);
  const overlap = wordsA.filter(w => wordsB.includes(w));
  return overlap.length === 0;
}

/**
 * Query PostgreSQL for existing CCCD records across both `employees` and `hr_employee_profiles`
 * Chuẩn hóa phân loại theo 5 nhóm trạng thái nghiệp vụ:
 * 1. ACTIVE_SAME_COMPANY_DUPLICATE: Nhân sự đang làm việc tại cùng công ty
 * 2. SOFT_DELETED_SAME_COMPANY: Hồ sơ đã xóa mềm tại cùng công ty (Đề xuất khôi phục)
 * 3. RESIGNED_SAME_COMPANY: Nhân sự đã nghỉ việc tại cùng công ty (Đề xuất tiếp nhận lại - Rehire)
 * 4. CROSS_COMPANY_DUPLICATE: Nhân sự thuộc công ty thành viên khác
 * 5. IDENTITY_MISMATCH: Trùng CCCD nhưng họ tên sai lệch lớn (Chuyển kiểm tra thủ công)
 */
async function checkDatabaseCccdDuplicates(cleanCccd, targetCompany, user = {}, candidateName = '', customDb = null) {
  if (!cleanCccd || typeof cleanCccd !== 'string') {
    return {
      hasDuplicate: null,
      duplicateType: 'INVALID_IDENTIFIER',
      error: 'INVALID_IDENTIFIER',
      message: 'Số CCCD không được để trống hoặc không đúng định dạng.'
    };
  }

  const digitsOnly = String(cleanCccd).replace(/\D/g, '');
  if (digitsOnly.length !== 9 && digitsOnly.length !== 12) {
    return {
      hasDuplicate: null,
      duplicateType: 'INVALID_IDENTIFIER',
      error: 'INVALID_IDENTIFIER',
      message: 'Số CCCD phải có độ dài đúng 9 hoặc 12 chữ số.'
    };
  }
  const dbClient = customDb || db;

  try {
    const canonical = canonicalizeIdentity('CCCD', 'VNM', cleanCccd);
    const hmacV1 = computeBlindIndex(canonical, 1);
    const hmacV2 = computeBlindIndex(canonical, 2);

    const res = await dbClient.query(
      `SELECT 'employees' AS source_table, e.id::text AS id, e.employee_code, e.employee_name AS full_name, e.citizen_id, e.company_id, e.status, c.company_name
       FROM employees e
       LEFT JOIN companies c ON e.company_id = c.id
       WHERE (e.citizen_id = $1 OR LPAD(e.citizen_id, 12, '0') = LPAD($1, 12, '0'))
       UNION ALL
       SELECT 'hr_employee_profiles' AS source_table, p.id::text AS id, p.employee_id AS employee_code, p.full_name, p.citizen_id, p.company_id,
              CASE WHEN p.job_grade = '[ĐÃ XÓA]' THEN 'DELETED'
                   WHEN p.job_grade = '[NGHỈ VIỆC]' THEN 'RESIGNED'
                   ELSE 'ACTIVE' END AS status,
              c.company_name
       FROM hr_employee_profiles p
       LEFT JOIN companies c ON p.company_id = c.id
       WHERE (p.citizen_id = $1 OR LPAD(p.citizen_id, 12, '0') = LPAD($1, 12, '0'))
       UNION ALL
       SELECT 'hr_person_identity_documents' AS source_table, e.id::text AS id, e.employee_code, p.full_name, d.masked_number AS citizen_id, e.company_id, e.status, c.company_name
       FROM hr_person_identity_documents d
       JOIN hr_persons p ON d.person_id = p.id
       JOIN employees e ON e.person_id = p.id
       LEFT JOIN companies c ON e.company_id = c.id
       WHERE (d.doc_number_hmac = $2 OR d.doc_number_hmac = $3) AND d.lifecycle_status = 'ACTIVE'`,
      [cleanCccd, hmacV1, hmacV2]
    );

    if (res.rows.length === 0) {
      return {
        hasDuplicate: false,
        duplicateType: 'NO_DUPLICATE',
        records: []
      };
    }

    const records = res.rows;
    const effectiveCompany = targetCompany || (user.role !== 'ADMIN' ? user.company_id : null);

    // 1. Kiểm tra bản ghi cùng công ty
    const sameCompanyRecords = effectiveCompany
      ? records.filter(r => r.company_id && r.company_id.toUpperCase() === effectiveCompany.toUpperCase())
      : records;

    if (sameCompanyRecords.length > 0) {
      // Ưu tiên bản ghi từ bảng employees
      const sameCompanyMatch = sameCompanyRecords.find(r => r.source_table === 'employees') || sameCompanyRecords[0];
      const compId = sameCompanyMatch.company_id;
      const compName = sameCompanyMatch.company_name || compId;
      const empName = sameCompanyMatch.full_name || 'Nhân sự';
      const empCode = sameCompanyMatch.employee_code ? `Mã NV: ${sameCompanyMatch.employee_code}` : 'Chưa cấp mã';
      const recStatus = (sameCompanyMatch.status || 'ACTIVE').toUpperCase();

      // Trường hợp A: Hồ sơ ĐÃ XÓA MỀM trong cùng công ty
      if (recStatus === 'DELETED') {
        return {
          hasDuplicate: true,
          duplicateType: 'SOFT_DELETED_SAME_COMPANY',
          isSoftDeleted: true,
          status: 'DELETED',
          matchedCompany: compId,
          matchedCompanyName: compName,
          matchedRecord: sameCompanyMatch,
          records,
          reason: `Số CCCD (${maskCccd(cleanCccd)}) thuộc hồ sơ nhân sự đã xóa mềm trước đây [${empCode}] "${empName}" tại đơn vị ${compId}. Hệ thống đề xuất Khôi phục hồ sơ cũ thay vì tạo bản ghi mới.`
        };
      }

      // Trường hợp B: Hồ sơ ĐÃ NGHỈ VIỆC trong cùng công ty
      if (recStatus === 'RESIGNED') {
        return {
          hasDuplicate: true,
          duplicateType: 'RESIGNED_SAME_COMPANY',
          isResigned: true,
          status: 'RESIGNED',
          matchedCompany: compId,
          matchedCompanyName: compName,
          matchedRecord: sameCompanyMatch,
          records,
          reason: `Số CCCD (${maskCccd(cleanCccd)}) thuộc nhân sự đã nghỉ việc [${empCode}] "${empName}" tại đơn vị ${compId}. Hệ thống đề xuất kích hoạt quy trình tiếp nhận lại (Re-hiring) với mã NV cũ.`
        };
      }

      // Trường hợp C: Trùng CCCD nhưng sai lệch họ tên đáng kể (Nghi vấn giả mạo / nhập nhầm)
      if (candidateName && isSignificantNameMismatch(candidateName, empName)) {
        return {
          hasDuplicate: true,
          duplicateType: 'IDENTITY_MISMATCH',
          isMismatch: true,
          matchedCompany: compId,
          matchedCompanyName: compName,
          matchedRecord: sameCompanyMatch,
          records,
          reason: `Cảnh báo sai lệch định danh: Số CCCD (${maskCccd(cleanCccd)}) trùng với nhân sự "${empName}" (${empCode}) trong CSDL nhưng tài liệu scan mang tên "${candidateName}". Cần kiểm tra thủ công trước khi phê duyệt.`
        };
      }

      // Trường hợp D: Nhân sự đang làm việc (ACTIVE) tại cùng công ty -> CHẶN TẠO MỚI
      return {
        hasDuplicate: true,
        duplicateType: 'ACTIVE_SAME_COMPANY_DUPLICATE',
        status: 'ACTIVE',
        matchedCompany: compId,
        matchedCompanyName: compName,
        matchedRecord: sameCompanyMatch,
        records,
        reason: `Số CCCD (${maskCccd(cleanCccd)}) đã tồn tại cho nhân viên đang làm việc [${empCode}] "${empName}" tại đơn vị ${compId}. Hệ thống chặn tạo mới để bảo toàn dữ liệu.`
      };
    }

    // 2. Bản ghi thuộc công ty thành viên khác trong tập đoàn SOTRANS
    const otherCompanyMatch = records.find(r => r.source_table === 'employees') || records[0];
    const otherCompId = otherCompanyMatch.company_id || 'Chưa rõ đơn vị';
    const otherCompName = otherCompanyMatch.company_name || otherCompId;
    const empName = otherCompanyMatch.full_name || 'Nhân sự';
    const empCode = otherCompanyMatch.employee_code ? `Mã NV: ${otherCompanyMatch.employee_code}` : 'Chưa cấp mã';

    // Phân quyền bảo vệ dữ liệu chéo công ty (Chính sách phân quyền ADMIN thống nhất):
    // Tất cả tài khoản có vai trò ADMIN (dù company_id null, STL, SWC hay VTX) đều có cùng bộ quyền quản trị
    // và được xem thông tin đối chứng đầy đủ để điều chuyển nội bộ tập đoàn.
    // Các vai trò khác (như HR) tuân thủ nghiêm ngặt bảo mật liên công ty và bị làm mờ thông tin nhạy cảm.
    const isPrivileged = (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN');
    const safeEmpName = isPrivileged ? empName : (empName ? empName.substring(0, 1) + '***' : 'Nhân sự');
    const safeEmpCode = isPrivileged ? empCode : (empCode ? empCode.substring(0, 3) + '***' : '***');

    return {
      hasDuplicate: true,
      duplicateType: 'CROSS_COMPANY_DUPLICATE',
      matchedCompany: otherCompId,
      matchedCompanyName: otherCompName,
      matchedRecord: isPrivileged ? otherCompanyMatch : {
        company_id: otherCompId,
        company_name: otherCompName,
        status: otherCompanyMatch.status || 'ACTIVE'
      },
      records: isPrivileged ? records : [],
      reason: isPrivileged
        ? `Nhân sự với số CCCD (${maskCccd(cleanCccd)}) đang thuộc đơn vị thành viên khác (${otherCompId} - ${otherCompName}, Nhân viên: "${empName}", ${empCode}). Không tự ý ghi đè hoặc chuyển công ty. Cần quy trình điều chuyển nội bộ tập đoàn.`
        : `Số CCCD (${maskCccd(cleanCccd)}) đã tồn tại trên hồ sơ nhân sự thuộc đơn vị thành viên khác (${otherCompId}). Để bảo vệ quyền riêng tư và dữ liệu liên công ty, thông tin chi tiết chỉ hiển thị với Quản trị viên. Cần quy trình điều chuyển nội bộ tập đoàn.`
    };
  } catch (err) {
    console.error('Lỗi truy vấn đối soát trùng CCCD trong CSDL:', err.message);
    return {
      success: false,
      hasDuplicate: null,
      duplicateType: 'DUPLICATE_CHECK_UNAVAILABLE',
      error: 'DUPLICATE_CHECK_UNAVAILABLE',
      message: 'Hệ thống đối soát nhân sự không khả dụng do lỗi cơ sở dữ liệu. Vui lòng thử lại sau.',
      originalError: err.message,
      records: []
    };
  }
}

/**
 * Service: Intake Validation, Profile Matching & Anti-Duplication
 * @param {Object} profile - Extracted profile fields
 * @param {Object} user - Authenticated user object (user_id, username, role, company_id)
 * @param {Object} compDetection - Detection output from companyDetector
 * @param {Object} cccdInfo - Pre-standardized CCCD object (optional)
 * @returns {Promise<Object>} Comprehensive classification, diff, and validation result
 */
async function validateStagingProfile(profile, user = {}, compDetection = {}, cccdInfo = null, customDb = null) {
  const missing = [];
  const uncertain = [];
  const validationErrors = [];
  let suspectedDuplicate = false;
  let duplicateReason = null;
  let intakeMode = 'new_profile';
  let targetProfileId = null;
  let targetEmployeeCode = null;
  let duplicateClassification = 'NO_DUPLICATE';
  let canRestore = false;
  let canRehire = false;
  let matchedRecord = null;

  const fullName = (profile.full_name || '').trim();
  const cccdValidation = cccdInfo || standardizeAndValidateCccd(profile.citizen_id);
  const rawCccd = cccdValidation.cleanCccd;
  const empCode = String(profile.employee_code || profile.employee_id || '').trim();

  // 1. Check for Missing Required Fields
  if (!fullName || fullName === 'Nhân viên mới') {
    missing.push('Họ và tên');
  }
  if (!rawCccd && !empCode) {
    missing.push('Số CCCD hoặc Mã nhân viên');
  }
  if (!profile.department_staffing_plan && !profile.department) {
    missing.push('Phòng ban / Đơn vị');
  }
  if (!profile.job_title && !profile.position) {
    missing.push('Chức vụ / Vị trí');
  }

  // 2. Check for CCCD extraction status
  if (!cccdValidation.valid) {
    if (cccdValidation.status === 'MISSING_CCCD') {
      missing.push('Số CCCD hợp lệ');
      uncertain.push('Không trích xuất được số CCCD từ tài liệu hoặc tài liệu bị mờ');
    } else if (cccdValidation.status === 'INVALID_CCCD') {
      uncertain.push(`Số CCCD trích xuất (${maskCccd(rawCccd)}) không hợp lệ (phải là 9 hoặc 12 chữ số)`);
    }
  }

  // If no identifiers or name is missing/placeholder, flag as insufficient_data
  if (!cccdValidation.valid || (!fullName || fullName === 'Nhân viên mới')) {
    duplicateClassification = 'MANUAL_CHECK_REQUIRED';
    intakeMode = 'insufficient_data';
    const insufficientReason = cccdValidation.reason || 'Chưa xác định được CCCD hoặc độ tin cậy OCR thấp: cần kiểm tra thủ công.';
    validationErrors.push({
      code: 'INSUFFICIENT_DATA',
      severity: 'BLOCKING',
      blocking: true,
      field: !cccdValidation.valid ? 'citizen_id' : 'full_name',
      safe_message: insufficientReason,
      resolution_action: 'SUPPLEMENT_IDENTITY_DOCUMENT'
    });

    return {
      intake_mode: intakeMode,
      target_profile_id: null,
      target_employee_code: null,
      company_status: compDetection.company_status || 'unknown',
      can_restore: false,
      can_rehire: false,
      proposed_changes: {
        duplicate_classification: duplicateClassification,
        validation_errors: validationErrors
      },
      missing_fields: missing,
      uncertain_fields: uncertain,
      suspected_duplicate: false,
      duplicate_classification: duplicateClassification,
      duplicate_reason: insufficientReason,
      validation_errors: validationErrors
    };
  }

  // 3. DATABASE DUPLICATE CHECK (employees & hr_employee_profiles) - HIGHEST SECURITY PRIORITY (BIZ-CCCD-01)
  const selectedComp = profile.company_id ? String(profile.company_id).toUpperCase().trim() : null;
  const userComp = user.company_id ? String(user.company_id).toUpperCase().trim() : null;
  const targetCompany = selectedComp || (user.role !== 'ADMIN' ? userComp : (compDetection.company_id || null));
  const dbDupCheck = await checkDatabaseCccdDuplicates(rawCccd, targetCompany, user, fullName, customDb);

  // FAIL-CLOSED: If database duplicate check failed / unavailable
  if (dbDupCheck && dbDupCheck.duplicateType === 'DUPLICATE_CHECK_UNAVAILABLE') {
    duplicateClassification = 'DUPLICATE_CHECK_UNAVAILABLE';
    intakeMode = 'insufficient_data';
    const unavailableReason = 'Không thể đối soát CSDL nhân sự do dịch vụ kiểm tra tạm thời không sẵn sàng (DUPLICATE_CHECK_UNAVAILABLE). Vui lòng thử lại sau.';
    validationErrors.push({
      code: 'DUPLICATE_CHECK_UNAVAILABLE',
      severity: 'BLOCKING',
      blocking: true,
      field: 'citizen_id',
      safe_message: unavailableReason,
      resolution_action: 'RETRY_CHECK_LATER'
    });

    return {
      intake_mode: intakeMode,
      target_profile_id: null,
      target_employee_code: null,
      company_status: compDetection.company_status || 'unknown',
      can_restore: false,
      can_rehire: false,
      proposed_changes: {
        duplicate_classification: duplicateClassification,
        validation_errors: validationErrors
      },
      missing_fields: missing,
      uncertain_fields: uncertain,
      suspected_duplicate: false, // NOT marked as confirmed duplicate
      duplicate_classification: duplicateClassification,
      duplicate_reason: unavailableReason,
      validation_errors: validationErrors
    };
  }

  if (dbDupCheck && dbDupCheck.hasDuplicate) {
    const hrProfRec = dbDupCheck.records ? dbDupCheck.records.find(r => r.source_table === 'hr_employee_profiles' && !isNaN(parseInt(r.id, 10))) : null;
    if (hrProfRec && !isNaN(parseInt(hrProfRec.id, 10))) {
      targetProfileId = parseInt(hrProfRec.id, 10);
    } else if (dbDupCheck.matchedRecord && !isNaN(parseInt(dbDupCheck.matchedRecord.id, 10)) && !String(dbDupCheck.matchedRecord.id).includes('-')) {
      targetProfileId = parseInt(dbDupCheck.matchedRecord.id, 10);
    }

    targetEmployeeCode = dbDupCheck.matchedRecord ? dbDupCheck.matchedRecord.employee_code : null;
    const empRow = dbDupCheck.records ? dbDupCheck.records.find(r => r.source_table === 'employees') : null;
    const matchedEmployeeId = empRow ? empRow.id : (dbDupCheck.matchedRecord && String(dbDupCheck.matchedRecord.id).includes('-') ? dbDupCheck.matchedRecord.id : null);
    
    matchedRecord = {
      id: matchedEmployeeId || targetProfileId,
      employee_id: matchedEmployeeId,
      target_profile_id: targetProfileId,
      company_id: dbDupCheck.matchedCompany,
      company_name: dbDupCheck.matchedCompanyName,
      employee_code: targetEmployeeCode,
      full_name: dbDupCheck.matchedRecord?.full_name,
      status: dbDupCheck.matchedRecord?.status || 'ACTIVE'
    };

    if (dbDupCheck.duplicateType === 'SOFT_DELETED_SAME_COMPANY') {
      canRestore = true;
      intakeMode = 'restore_proposal';
      duplicateClassification = 'SOFT_DELETED_SAME_COMPANY';
      duplicateReason = dbDupCheck.reason;
    } else if (dbDupCheck.duplicateType === 'RESIGNED_SAME_COMPANY') {
      canRehire = true;
      intakeMode = 'rehire_proposal';
      duplicateClassification = 'RESIGNED_SAME_COMPANY';
      duplicateReason = dbDupCheck.reason;
    } else if (dbDupCheck.duplicateType === 'IDENTITY_MISMATCH') {
      suspectedDuplicate = true;
      duplicateClassification = 'IDENTITY_MISMATCH';
      duplicateReason = dbDupCheck.reason;
      validationErrors.push({
        code: 'IDENTITY_MISMATCH',
        severity: 'BLOCKING',
        blocking: true,
        field: 'citizen_id',
        safe_message: dbDupCheck.reason,
        resolution_action: 'MANUAL_IDENTITY_VERIFICATION'
      });
    } else if (dbDupCheck.duplicateType === 'ACTIVE_SAME_COMPANY_DUPLICATE') {
      suspectedDuplicate = true;
      duplicateClassification = 'ACTIVE_SAME_COMPANY_DUPLICATE';
      duplicateReason = dbDupCheck.reason;
      validationErrors.push({
        code: 'ACTIVE_SAME_COMPANY_DUPLICATE',
        severity: 'BLOCKING',
        blocking: true,
        field: 'citizen_id',
        safe_message: dbDupCheck.reason,
        resolution_action: 'REJECT_DUPLICATE'
      });
    } else if (dbDupCheck.duplicateType === 'CROSS_COMPANY_DUPLICATE') {
      suspectedDuplicate = true;
      duplicateClassification = 'CROSS_COMPANY_DUPLICATE';
      duplicateReason = dbDupCheck.reason;
      validationErrors.push({
        code: 'CROSS_COMPANY_DUPLICATE',
        severity: 'BLOCKING',
        blocking: true,
        field: 'citizen_id',
        safe_message: dbDupCheck.reason,
        resolution_action: 'INTERNAL_TRANSFER_REQUIRED'
      });
    }
  }

  // 4. CHECK FOR COMPANY MISMATCH (Evaluated independently from duplicate check)
  const effectiveComp = selectedComp || (user.role !== 'ADMIN' ? userComp : null);
  const detectedComp = compDetection.company_id ? String(compDetection.company_id).toUpperCase().trim() : null;

  // Condition 4A: Document text points to a company, but receiving company is set to a different one
  let hasCompanyMismatch = false;
  let mismatchReason = null;

  if (detectedComp && effectiveComp && detectedComp !== effectiveComp) {
    hasCompanyMismatch = true;
    mismatchReason = `Tài liệu scan mang dấu hiệu pháp lý thuộc đơn vị ${detectedComp}, nhưng đơn vị tiếp nhận hiện tại là ${effectiveComp}. Không thể tiếp nhận hoặc phê duyệt hồ sơ ngoài phạm vi đơn vị.`;
  } else if (user.role !== 'ADMIN' && userComp && detectedComp && detectedComp !== userComp) {
    hasCompanyMismatch = true;
    mismatchReason = `Tài liệu có dấu hiệu thuộc đơn vị ${detectedComp}, nhưng tài khoản của bạn thuộc ${userComp}. Bạn không được phép tiếp nhận hồ sơ ngoài phạm vi đơn vị.`;
  } else if (compDetection.company_status === 'conflict') {
    hasCompanyMismatch = true;
    mismatchReason = compDetection.company_evidence || 'Phát hiện xung đột dữ liệu công ty trong tài liệu scan.';
  }

  if (hasCompanyMismatch) {
    validationErrors.push({
      code: 'COMPANY_MISMATCH',
      severity: 'BLOCKING',
      blocking: true,
      field: 'company_id',
      safe_message: mismatchReason,
      resolution_action: 'CONFIRM_COMPANY_OR_PROVIDE_TRANSFER_DOC'
    });
  }

  // 5. SYNTHESIZE CLASSIFICATION & PRIORITIZATION PER BIZ-CCCD-01
  let companyStatus = compDetection.company_status || 'unknown';
  if (hasCompanyMismatch) {
    companyStatus = 'conflict';
  } else if (effectiveComp && detectedComp && effectiveComp === detectedComp) {
    companyStatus = 'confirmed';
  }

  // Priority warning synthesis:
  // If BOTH Cross-Company Duplicate and Company Mismatch exist:
  const hasCrossCompDup = validationErrors.some(e => e.code === 'CROSS_COMPANY_DUPLICATE');
  const hasActiveSameCompDup = validationErrors.some(e => e.code === 'ACTIVE_SAME_COMPANY_DUPLICATE');
  const hasIdentityMismatch = validationErrors.some(e => e.code === 'IDENTITY_MISMATCH');

  if (hasCrossCompDup) {
    suspectedDuplicate = true;
    intakeMode = 'suspected_duplicate';
    duplicateClassification = 'CROSS_COMPANY_DUPLICATE';
    if (hasCompanyMismatch) {
      duplicateReason = `${dbDupCheck?.reason || 'Trùng CCCD liên công ty.'} Đồng thời, hồ sơ bị Lệch đơn vị tiếp nhận (Company Mismatch): ${mismatchReason}`;
    } else {
      duplicateReason = dbDupCheck?.reason || 'Trùng CCCD liên công ty.';
    }
  } else if (hasActiveSameCompDup) {
    suspectedDuplicate = true;
    intakeMode = 'suspected_duplicate';
    duplicateClassification = 'ACTIVE_SAME_COMPANY_DUPLICATE';
    duplicateReason = dbDupCheck?.reason || 'Trùng CCCD nhân sự đang hoạt động cùng đơn vị.';
  } else if (hasIdentityMismatch) {
    suspectedDuplicate = true;
    intakeMode = 'suspected_duplicate';
    duplicateClassification = 'IDENTITY_MISMATCH';
    duplicateReason = dbDupCheck?.reason || 'Trùng CCCD nhưng sai lệch họ tên.';
  } else if (hasCompanyMismatch) {
    suspectedDuplicate = false; // No CCCD duplicate
    intakeMode = 'company_mismatch';
    duplicateClassification = 'COMPANY_MISMATCH';
    duplicateReason = mismatchReason;
  } else if (canRestore) {
    suspectedDuplicate = false;
    intakeMode = 'restore_proposal';
  } else if (canRehire) {
    suspectedDuplicate = false;
    intakeMode = 'rehire_proposal';
  } else {
    suspectedDuplicate = false;
    intakeMode = 'new_profile';
    duplicateClassification = 'NO_DUPLICATE';
    duplicateReason = null;
  }

  return {
    intake_mode: intakeMode,
    target_profile_id: targetProfileId,
    target_employee_code: targetEmployeeCode,
    company_status: companyStatus,
    can_restore: canRestore,
    can_rehire: canRehire,
    proposed_changes: {
      duplicate_classification: duplicateClassification,
      can_restore: canRestore,
      can_rehire: canRehire,
      target_employee_code: targetEmployeeCode,
      matched_record: matchedRecord,
      validation_errors: validationErrors
    },
    missing_fields: missing,
    uncertain_fields: uncertain,
    suspected_duplicate: suspectedDuplicate,
    duplicate_classification: duplicateClassification,
    duplicate_reason: duplicateReason,
    validation_errors: validationErrors
  };
}

module.exports = {
  standardizeAndValidateCccd,
  checkDatabaseCccdDuplicates,
  maskCccd,
  validateStagingProfile,
  FIELD_PERMISSIONS
};
