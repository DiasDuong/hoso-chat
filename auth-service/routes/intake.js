const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const https = require('https');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { verifyToken, hasPermission } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { processFileForAI } = require('../services/fileProcessor');
const { detectCompany, VALID_COMPANIES } = require('../services/companyDetector');
const intakeValidator = require('../services/intakeValidator');
const { 
  validateStagingProfile, 
  standardizeAndValidateCccd, 
  maskCccd 
} = intakeValidator;
const checkDatabaseCccdDuplicates = (...args) => intakeValidator.checkDatabaseCccdDuplicates(...args);
const { parseConversationalIntake, removeAccents } = require('../services/intakeConversationalParser');
const { renderStagingPreview, renderBatchSummary } = require('../services/intakeCardRenderer');
const { queueSyncTasks, queueEmployeeSync } = require('../services/syncWorker');
const {
  canonicalizeIdentity,
  computeBlindIndex,
  maskIdentityNumber,
  encryptDocNumber,
  findIdentityDocument
} = require('../services/identitySecurityService');
const { uploadRateLimiter } = require('../middleware/rateLimiter');
const {
  FIELD_STATUS,
  CANONICAL_53_FIELDS,
  FIELD_ALIASES,
  FIELD_DOCUMENT_SOURCES,
  normalizeFieldValue,
  buildSchemaMetadata,
  classifyDocumentType
} = require('../services/hrSchemaDictionary');

// Helper to convert arbitrary session ID to valid UUID v4 deterministically
function toValidUUID(str) {
  if (!str || str === 'web' || str === 'default') return null;
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str));
  if (isUUID) return String(str);
  const hash = crypto.createHash('md5').update(String(str)).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// Định dạng chuẩn mã nhân viên theo từng công ty (BIZ-02)
const COMPANY_CODE_PATTERNS = {
  'STL': {
    regex: /^STL[-_]?\d{3,6}$/i,
    hint: 'Mã nhân viên SOTRANS Logistics (STL) bắt buộc và phải có định dạng STL-xxx hoặc STLxxxxx (ví dụ: STL-001, STL00012).'
  },
  'VTX': {
    regex: /^VTX[-_]?\d{3,6}$/i,
    hint: 'Mã nhân viên Vietranstimex (VTX) bắt buộc và phải có định dạng VTX_xxx hoặc VTX-xxx (ví dụ: VTX_881, VTX-101).'
  },
  'SWC': {
    regex: /^(SWC[-_]?\d{3,6}|\d{12})$/i,
    hint: 'Mã nhân viên Sowatco (SWC) phải có định dạng SWC-xxx, SWCxxxxx hoặc số CCCD 12 chữ số (ví dụ: SWC00810, 079205001589).'
  }
};

// ============================================================================
// TỰ ĐỘNG SINH MÃ NHÂN VIÊN CHÍNH THỨC (PHƯƠNG ÁN A - CONCURRENCY-SAFE)
// Định dạng chuẩn: STLxxxxx, SWCxxxxx, VTXxxxxx (5 chữ số với leading zero)
// ============================================================================
async function generateNextEmployeeCode(client, companyId) {
  const comp = String(companyId || 'STL').trim().toUpperCase();
  if (!['STL', 'VTX', 'SWC'].includes(comp)) {
    throw new Error(`Đơn vị "${companyId}" không hợp lệ để cấp mã nhân viên tự động. Whitelist: STL, VTX, SWC.`);
  }
  const seqMap = {
    'STL': 'seq_employee_code_stl',
    'SWC': 'seq_employee_code_swc',
    'VTX': 'seq_employee_code_vtx'
  };
  const seqName = seqMap[comp];
  const prefix = comp;

  let assignedCode = null;
  while (!assignedCode) {
    const seqRes = await client.query(`SELECT nextval($1) AS num`, [seqName]);
    const num = seqRes.rows[0].num;
    const candidateCode = `${prefix}${String(num).padStart(5, '0')}`;

    // Kiểm tra tính duy nhất trên bảng employees (uq_employees_employee_code)
    const checkRes = await client.query(
      `SELECT 1 FROM employees WHERE employee_code = $1 LIMIT 1`,
      [candidateCode]
    );
    if (checkRes.rows.length === 0) {
      assignedCode = candidateCode;
    }
  }

  return assignedCode;
}

/**
 * Validate identity completeness before approval (BIZ-02)
 * Strictly blocks approval if mandatory identity fields (fullName, citizen_id) are missing or invalid.
 * If employee_code is provided, strictly validates format. If missing, allows auto-generation on approval.
 */
function validateItemForApproval(it, comp) {
  const missing = [];
  const fullName = it.full_name ? String(it.full_name).trim() : '';
  if (!fullName || fullName === 'Nhân viên mới') {
    missing.push('Họ và tên nhân viên');
  }

  const rawCitizen = it.citizen_id ? String(it.citizen_id).replace(/\D/g, '') : '';
  if (!rawCitizen || (rawCitizen.length !== 9 && rawCitizen.length !== 12)) {
    missing.push('Số CCCD hợp lệ (9 hoặc 12 chữ số)');
  }

  const pattern = COMPANY_CODE_PATTERNS[comp];
  const empCode = it.employee_code ? String(it.employee_code).trim() : (it.target_employee_code ? String(it.target_employee_code).trim() : '');
  let resolvedCode = empCode;

  // Nếu đã có mã nhân viên, kiểm tra tính hợp lệ theo quy tắc công ty
  if (empCode) {
    if (pattern && !pattern.regex.test(empCode)) {
      missing.push(`Mã nhân viên không hợp lệ: "${empCode}" (${pattern.hint})`);
    }
  } else {
    // Nếu chưa có mã nhân viên: Không báo lỗi thiếu, backend sẽ tự động sinh mã chuẩn theo sequence khi phê duyệt
    resolvedCode = null;
  }

  return {
    valid: missing.length === 0,
    missing,
    resolvedCode,
    cleanCitizenId: rawCitizen
  };
}

// Multer upload config for documents
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB
    files: 10
  },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|docx|txt|md|png|jpe?g|webp|csv|xlsx|xls)$/i;
    if (allowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Định dạng tệp "${file.originalname}" không được hỗ trợ để nhập hồ sơ.`));
    }
  }
});

// [REMOVED LEGACY DEAD CODE]: callGeminiExtraction migrated completely to n8n node "OCR - Gemini Extraction"

/**
 * Fallback Regex Extractor for Document Text (resilient against API key limits or offline mode)
 */
function extractProfileFromText(text = '', fileName = '') {
  if (!text || typeof text !== 'string') return {};
  const extracted = {};

  // 1. Citizen ID (CCCD: 12 digits, CMND: 9 digits)
  const cccdMatch = text.match(/(?:CCCD|CMND|Căn cước|Định danh|Số định danh|Số thẻ|Số CCCD|Số CMND)[:\s#]*([0-9]{4,15})\b/i) ||
                    text.match(/\b([0-9]{12})\b/) ||
                    text.match(/\b([0-9]{9})\b/);
  if (cccdMatch) {
    extracted.citizen_id = cccdMatch[1];
  }

  // 2. Full Name
  const nameMatch = text.match(/(?:Họ và tên|Họ tên|HỌ VÀ TÊN|HỌ VÀ TÊN KHAI SINH|Họ và tên nhân viên|Họ tên ứng viên|Ứng viên|Ông\/Bà|Tuyển dụng ông\/bà|Ký hợp đồng với ông\/bà)[:\s]+([^\n\r,;:–—]+)/i) ||
                    text.match(/(?:^|[\r\n•\-])\s*Nhân viên[:\s]+([^\n\r,;:–—]+)/i);
  if (nameMatch) {
    const raw = nameMatch[1].trim();
    if (raw && !/^(ông|bà|nam|nữ|ngày|tháng|năm|số|tập sự|kinh doanh|văn phòng|giao nhận)$/i.test(raw)) {
      extracted.full_name = raw.toUpperCase();
    }
  }
  // Do NOT fallback to fileName for full_name (Rule B.10 & D: Không lấy tên file làm họ tên nhân sự, không suy đoán)
  if (!extracted.full_name) {
    extracted.full_name = null;
  }

  // 3. Date of birth
  const dobMatch = text.match(/(?:Ngày sinh|Sinh ngày|DOB|Date of birth)[:\s]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4})/i);
  if (dobMatch) {
    const parts = dobMatch[1].split(/[-/]/);
    if (parts.length === 3) {
      extracted.date_of_birth = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }

  // 4. Gender
  const genderMatch = text.match(/(?:Giới tính|Gender)[:\s]*(Nam|Nữ|Male|Female)/i);
  if (genderMatch) {
    extracted.gender = /nam|male/i.test(genderMatch[1]) ? 'Nam' : 'Nữ';
  }

  // 5. Job Title
  const jobMatch = text.match(/(?:Chức vụ|Vị trí|Vị trí tuyển dụng|Chức danh|Công việc)[:\s]+([^\n\r,;]+)/i);
  if (jobMatch) {
    extracted.job_title = jobMatch[1].trim();
  }

  // 6. Department
  const deptMatch = text.match(/(?:Phòng ban|Bộ phận|Đơn vị|Phòng\/Ban|Ban)[:\s]+([^\n\r,;]+)/i);
  if (deptMatch) {
    extracted.department_staffing_plan = deptMatch[1].trim();
  }

  // 7. Email
  const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) {
    extracted.email = emailMatch[1].toLowerCase();
  }

  // 8. Phone
  const phoneMatch = text.match(/(?:Điện thoại|SĐT|Phone|Tel|Mobile)[:\s]*([0-9\s.+]{10,13})/i) ||
                     text.match(/\b(0[3|5|7|8|9][0-9]{8})\b/);
  if (phoneMatch) {
    extracted.phone_number = phoneMatch[1].replace(/\D/g, '');
  }

  // 9. Recruitment Decision No
  const decisionMatch = text.match(/(?:Quyết định số|Số QĐ|Số)[:\s]*([0-9A-Z_/-]+(?:\/QĐ-[A-Z0-9]+|\/HĐLĐ-[A-Z0-9]+))/i) ||
                        text.match(/([0-9]{1,4}\/QĐ-[A-Z0-9]+)/i);
  if (decisionMatch) {
    extracted.recruitment_decision_no = decisionMatch[1].trim();
  }

  // 10. Base salary
  const salMatch = text.match(/(?:Mức lương|Lương cơ bản|Lương chính|Lương)[:\s]*([0-9.,]+(?:\s*(?:triệu|VNĐ|VND|đồng))?)/i);
  if (salMatch) {
    const rawSal = salMatch[1].replace(/[.,]/g, '').replace(/\D/g, '');
    if (rawSal) extracted.base_salary = rawSal;
  }

  // 11. Employment Start Date
  const startMatch = text.match(/(?:Ngày bắt đầu|Thời hạn hợp đồng từ ngày|Từ ngày|Ngày vào làm)[:\s]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4})/i);
  if (startMatch) {
    const parts = startMatch[1].split(/[-/]/);
    if (parts.length === 3) {
      extracted.employment_start_date = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }

  // 12. Address
  const addrMatch = text.match(/(?:Nơi thường trú|Thường trú|Địa chỉ thường trú)[:\s]+([^\n\r;]+)/i);
  if (addrMatch) extracted.permanent_address = addrMatch[1].trim();

  // 13. Current Address
  const curAddrMatch = text.match(/(?:Nơi ở hiện nay|Địa chỉ hiện tại|Địa chỉ ở hiện tại|Chỗ ở hiện nay)[:\s]+([^\n\r;]+)/i);
  if (curAddrMatch) extracted.current_address = curAddrMatch[1].trim();

  // 14. Place of origin
  const originMatch = text.match(/(?:Quê quán|Nguyên quán)[:\s]+([^\n\r;]+)/i);
  if (originMatch) extracted.place_of_origin = originMatch[1].trim();

  // 15. Birth Registration Place
  const birthPlaceMatch = text.match(/(?:Nơi đăng ký khai sinh|Nơi khai sinh)[:\s]+([^\n\r;]+)/i);
  if (birthPlaceMatch) extracted.birth_registration_place = birthPlaceMatch[1].trim();

  // 16. Ethnicity
  const ethMatch = text.match(/(?:Dân tộc)[:\s]+([^\n\r,;]+)/i);
  if (ethMatch) extracted.ethnicity = ethMatch[1].trim();

  // 17. Education Level
  const eduMatch = text.match(/(?:Trình độ văn hóa|Văn hóa|Học vấn)[:\s]+([^\n\r,;]+)/i);
  if (eduMatch) extracted.education_level = eduMatch[1].trim();

  // 18. Qualification & Major
  const qualMatch = text.match(/(?:Trình độ chuyên môn|Chuyên môn)[:\s]+([^\n\r;]+)/i);
  if (qualMatch) extracted.professional_qualification = qualMatch[1].trim();

  const majorMatch = text.match(/(?:Chuyên ngành|Ngành đào tạo)[:\s]+([^\n\r;]+)/i);
  if (majorMatch) extracted.major = majorMatch[1].trim();

  const schoolMatch = text.match(/(?:Trường đào tạo|Cơ sở đào tạo|Tên trường)[:\s]+([^\n\r;]+)/i);
  if (schoolMatch) extracted.training_institution = schoolMatch[1].trim();

  return extracted;
}

// [REMOVED LEGACY DEAD CODE]: processIntakeFiles migrated completely to n8n workflow "SOTRANS_HR_EMPLOYEE_LIFECYCLE"

// ----------------------------------------------------------------------------
router.post('/upload', verifyToken, upload.any(), uploadRateLimiter, async (req, res) => {
  try {
    const canUpload = await hasPermission(req.user.role, 'hr.intake.upload');
    if (!canUpload) {
      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'HR_INTAKE_UPLOAD_FORBIDDEN',
        status: 'BLOCKED',
        ip_address: req.ip,
        metadata: { role: req.user.role }
      });
      return res.status(403).json({ success: false, error: '403 Forbidden: Tài khoản không có quyền tải lên hồ sơ nhân sự.' });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ success: false, error: 'Vui lòng chọn ít nhất 1 tệp hồ sơ đính kèm.' });
    }

    const conversationId = req.body.conversation_id || null;
    const { forwardUploadToN8n } = require('../services/n8nLifecycleProxy');
    const n8nRes = await forwardUploadToN8n(req, files, { conversation_id: conversationId, event_type: 'HR_UPLOAD' });
    return res.status(n8nRes.status || 200).json(n8nRes.body);
  } catch (err) {
    console.error('Lỗi tải lên hồ sơ intake:', err);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi tiếp nhận hồ sơ: ' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 2. POST /api/hoso/intake/confirm-company
// ----------------------------------------------------------------------------
router.post('/confirm-company', verifyToken, async (req, res) => {
  try {
    const canConfirm = await hasPermission(req.user.role, 'hr.intake.confirm_company');
    if (!canConfirm) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền xác nhận công ty cho hồ sơ.' });
    }

    const { staging_ids, staging_id, id, company_id, is_unknown } = req.body;
    let rawIds = staging_ids;
    if (!rawIds) {
      if (staging_id) rawIds = [staging_id];
      else if (id) rawIds = [id];
      else rawIds = [];
    }
    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp danh sách ID hồ sơ cần xác nhận.' });
    }

    let targetComp = null;
    let compStatus = 'unknown';

    if (!is_unknown) {
      targetComp = String(company_id || '').toUpperCase().trim();
      if (!VALID_COMPANIES.includes(targetComp)) {
        return res.status(400).json({ success: false, error: `Công ty "${targetComp}" không hợp lệ. Chỉ chấp nhận STL, VTX hoặc SWC.` });
      }

      if (req.user.role !== 'ADMIN' && req.user.company_id !== targetComp) {
        await logAudit({
          actor_user_id: req.user.user_id,
          actor_username: req.user.username,
          action: 'HR_INTAKE_CONFIRM_COMPANY_BLOCKED',
          status: 'BLOCKED',
          ip_address: req.ip,
          metadata: { attempted_company: targetComp, user_company: req.user.company_id }
        });
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: Tài khoản của bạn thuộc đơn vị ${req.user.company_id}, không có thẩm quyền gán hoặc xác nhận hồ sơ cho đơn vị ${targetComp}.`
        });
      }
      compStatus = 'confirmed';
    }

    const updatedRes = await db.query(
      `UPDATE hr_employee_staging 
       SET company_id = $1,
           company_status = $2,
           reviewer_username = $3,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = ANY($4::uuid[])
       RETURNING *`,
      [targetComp, compStatus, req.user.username, staging_ids]
    );

    const canApprove = await hasPermission(req.user.role, 'hr.intake.approve');
    const updatedItems = updatedRes.rows;
    let replyCard = '';
    if (updatedItems.length === 1) {
      replyCard = `Đã cập nhật công ty thành công!\n\n` + renderStagingPreview(updatedItems[0], canApprove);
    } else {
      replyCard = `Đã cập nhật công ty cho ${updatedItems.length} hồ sơ!\n\n` + renderBatchSummary(updatedItems, canApprove);
    }

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_CONFIRM_COMPANY_SUCCESS',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: { staging_ids, company_id: targetComp, company_status: compStatus }
    });

    return res.json({
      success: true,
      updated_count: updatedItems.length,
      items: updatedItems,
      reply: replyCard
    });
  } catch (err) {
    console.error('Lỗi xác nhận công ty:', err);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi xác nhận công ty: ' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 3. POST /api/hoso/intake/approve
// ----------------------------------------------------------------------------
/**
 * Unified Staging Approval & Profile Commit Function
 * Handles both new profile onboarding and existing profile diff updates with optimistic locking and granular RBAC.
 */
async function executeStagingApproval(client, it, user) {
  const comp = it.company_id;
  const fullName = it.full_name;

  // 0. Guard against CCCD duplicate (BIZ-CCCD-01)
  if (it.suspected_duplicate || it.intake_mode === 'suspected_duplicate') {
    const err = new Error(`Từ chối phê duyệt: Hồ sơ "${fullName}" (${it.file_name || ''}) đã bị phát hiện TRÙNG LẶP CCCD (${it.duplicate_reason || 'Đã tồn tại trong hệ thống'}). Chặn tuyệt đối việc tạo bản ghi mới hoặc ghi đè dữ liệu nhân sự.`);
    err.status = 400;
    throw err;
  }

  // 1. Guard against company mismatch (Requirement 4)
  if (it.intake_mode === 'company_mismatch') {
    if (user.role === 'ADMIN' && comp && ['STL', 'VTX', 'SWC'].includes(comp)) {
      it.intake_mode = it.target_profile_id ? 'update_profile' : 'new_profile';
      await client.query(`UPDATE hr_employee_staging SET intake_mode = $1 WHERE id = $2`, [it.intake_mode, it.id]);
    } else {
      const err = new Error(`Hồ sơ "${fullName}" đang bị gắn cờ "Lệch đơn vị" (Company Mismatch). Bạn không thể duyệt hồ sơ có dấu hiệu thuộc đơn vị khác.`);
      err.status = 403;
      throw err;
    }
  }

  // 2. Guard against multiple matches (Requirement 2)
  if (it.intake_mode === 'multiple_matches') {
    const err = new Error(`Hồ sơ "${fullName}" có nhiều kết quả tương tự cần làm rõ. Vui lòng xác định mã nhân viên hoặc số CCCD cụ thể.`);
    err.status = 400;
    throw err;
  }

  // 3. Guard against insufficient data
  if (it.intake_mode === 'insufficient_data') {
    const err = new Error(`Hồ sơ "${fullName}" thiếu dữ liệu định danh bắt buộc (insufficient_data). Không thể phê duyệt.`);
    err.status = 400;
    err.code = 'INSUFFICIENT_DATA';
    throw err;
  }

  // 4. Guard against cross-company unauthorized actions
  if (user.role !== 'ADMIN' && comp !== user.company_id) {
    const err = new Error(`403 Forbidden: Tài khoản thuộc đơn vị ${user.company_id} không có quyền phê duyệt hồ sơ cho đơn vị ${comp}.`);
    err.status = 403;
    throw err;
  }

  // 5. Verify company confirmation
  if (it.company_status !== 'confirmed' || !comp) {
    if (user.role === 'ADMIN' && comp && ['STL', 'VTX', 'SWC'].includes(comp)) {
      await client.query(`UPDATE hr_employee_staging SET company_status = 'confirmed' WHERE id = $1`, [it.id]);
      it.company_status = 'confirmed';
    } else {
      const err = new Error(`Hồ sơ "${fullName}" chưa có công ty được xác nhận (Trạng thái: ${it.company_status}). Vui lòng xác nhận công ty trước khi phê duyệt.`);
      err.status = 400;
      throw err;
    }
  }

  const extracted = it.extracted_data || {};

  // =========================================================================
  // SUB-CASE 1: UPDATE OF EXISTING PROFILE (intake_mode === 'update_profile')
  // =========================================================================
  if (it.intake_mode === 'update_profile') {
    const targetId = it.target_profile_id;
    const targetCode = it.target_employee_code;
    const changes = it.proposed_changes || {};
    const changedFields = changes.changed_fields || [];
    const diff = changes.diff || {};
    const expectedVersion = changes.current_profile_version || 1;

    // Granular RBAC Check for each changed field (Requirement 5)
    for (const field of changedFields) {
      const fieldMeta = diff[field] || {};
      const requiredPerm = fieldMeta.required_permission || 'hr.profile.edit_department';
      const permitted = await hasPermission(user.role, requiredPerm);
      if (!permitted) {
        const err = new Error(`403 Forbidden: Tài khoản vai trò "${user.role}" không có quyền cập nhật trường "${fieldMeta.label || field}" (yêu cầu quyền: ${requiredPerm}).`);
        err.status = 403;
        throw err;
      }
    }

    // Optimistic Concurrency Control (Requirement 6)
    const curRes = await client.query(
      `SELECT * FROM hr_employee_profiles WHERE id = $1 FOR UPDATE`,
      [targetId]
    );
    if (curRes.rows.length === 0) {
      const err = new Error(`Không tìm thấy hồ sơ gốc (ID: ${targetId}) để cập nhật.`);
      err.status = 404;
      throw err;
    }
    const currentProfile = curRes.rows[0];

    if (currentProfile.version !== expectedVersion) {
      const err = new Error(`409 Conflict: Hồ sơ của "${currentProfile.full_name}" (Mã: ${currentProfile.employee_id}) đã bị chỉnh sửa bởi một phiên làm việc khác (phiên bản CSDL: ${currentProfile.version}, phiên bản đối chiếu: ${expectedVersion}). Vui lòng tải lại dữ liệu mới nhất trước khi cập nhật.`);
      err.status = 409;
      throw err;
    }

    // Build dynamic UPDATE query only for authorized changed fields
    const updateClauses = [];
    const updateParams = [targetId, expectedVersion];

    // Cho phép cập nhật tất cả các trường thuộc 53 trường dữ liệu chuẩn
    const allowedCols = {};
    for (const f of CANONICAL_53_FIELDS) {
      if (f !== 'Create_Time' && f !== 'fileName') {
        allowedCols[f] = f;
      }
    }
    allowedCols['department'] = 'department_staffing_plan';
    allowedCols['employee_code'] = 'employee_id';

    for (const field of changedFields) {
      const colName = allowedCols[field];
      if (colName && diff[field]) {
        updateParams.push(diff[field].new_value);
        updateClauses.push(`${colName} = $${updateParams.length}`);
      }
    }

    if (updateClauses.length > 0) {
      updateClauses.push(`version = version + 1`);
      updateClauses.push(`updated_at = NOW()`);
      const updateQuery = `
        UPDATE hr_employee_profiles 
        SET ${updateClauses.join(', ')}
        WHERE id = $1 AND version = $2
        RETURNING *
      `;
      const updateRes = await client.query(updateQuery, updateParams);
      if (updateRes.rowCount === 0) {
        const err = new Error(`409 Conflict: Không thể cập nhật do xung đột dữ liệu đồng thời.`);
        err.status = 409;
        throw err;
      }
    }

    // Update employees table if position, department, or email changed
    const deptVal = diff.department_staffing_plan?.new_value || diff.department?.new_value;
    const posVal = diff.job_title?.new_value;
    const emailVal = diff.email?.new_value;

    // Preserve DELETED or RESIGNED status if updating an existing employee (Rule BIZ-STATUS-01)
    const existingEmpRes = await client.query('SELECT status FROM employees WHERE company_id = $1 AND employee_code = $2', [comp, targetCode]);
    const existingEmp = existingEmpRes.rows[0] || {};
    const targetStatus = (existingEmp.status === 'DELETED' || existingEmp.status === 'RESIGNED') ? existingEmp.status : undefined;

    if (deptVal || posVal || emailVal) {
      await client.query(
        `UPDATE employees SET
          department = COALESCE($1, department),
          position = COALESCE($2, position),
          email = COALESCE($3, email),
          updated_at = NOW()
        WHERE company_id = $4 AND employee_code = $5`,
        [deptVal || null, posVal || null, emailVal || null, comp, targetCode]
      );
    }

    // Mark Staging row as approved
    await client.query(
      `UPDATE hr_employee_staging 
       SET staging_status = 'approved', approver_username = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [user.username, it.id]
    );

    return {
      type: 'updated',
      id: it.id,
      name: currentProfile.full_name,
      code: targetCode,
      company: comp,
      changedFields
    };
  }

  // =========================================================================
  // SUB-CASE 1B: RESTORE OF SOFT-DELETED PROFILE OR RE-HIRE (restore_proposal / rehire_proposal)
  // =========================================================================
  if (it.intake_mode === 'restore_proposal' || it.intake_mode === 'rehire_proposal' || it.duplicate_classification === 'SOFT_DELETED_SAME_COMPANY' || it.duplicate_classification === 'RESIGNED_SAME_COMPANY') {
    const isRestore = it.intake_mode === 'restore_proposal' || it.duplicate_classification === 'SOFT_DELETED_SAME_COMPANY';

    // Phân quyền: Chỉ ADMIN mới có quyền phê duyệt khôi phục hồ sơ đã xóa mềm
    if (isRestore && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      const err = new Error('403 Forbidden: Chỉ Quản trị viên (ADMIN) mới có quyền phê duyệt khôi phục hồ sơ nhân sự đã bị xóa mềm.');
      err.status = 403;
      throw err;
    }

    if (!isRestore && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      const canRehire = await hasPermission(user.role, 'hr.profile.reactivate');
      if (!canRehire) {
        const err = new Error('403 Forbidden: Vai trò Chuyên viên Nhân sự (HR) chưa được cấp thẩm quyền phê duyệt tái kích hoạt/tái tuyển dụng nhân sự đã nghỉ việc (hr.profile.reactivate).');
        err.status = 403;
        throw err;
      }
    }

    let proposed = {};
    try { proposed = typeof it.proposed_changes === 'string' ? JSON.parse(it.proposed_changes) : (it.proposed_changes || {}); } catch(e) {}
    const targetCode = proposed.target_employee_code || it.employee_code || (it.citizen_id && comp === 'SWC' ? it.citizen_id : null);
    const cleanCitizenId = it.citizen_id ? String(it.citizen_id).replace(/\D/g, '') : null;

    if (!targetCode && !cleanCitizenId) {
      const err = new Error(`Hồ sơ "${fullName}" thiếu mã nhân viên hoặc số CCCD để thực hiện khôi phục.`);
      err.status = 400;
      throw err;
    }

    // 1. Cập nhật bảng employees sang trạng thái ACTIVE
    const empRes = await client.query(
      `UPDATE employees
       SET status = 'ACTIVE',
           resignation_date = NULL,
           resignation_reason = NULL,
           employee_name = COALESCE(NULLIF($1, ''), employee_name),
           department = COALESCE(NULLIF($2, ''), department),
           position = COALESCE(NULLIF($3, ''), position),
           email = COALESCE(NULLIF($4, ''), email),
           citizen_id = COALESCE(NULLIF($5, ''), citizen_id),
           updated_at = NOW()
       WHERE company_id = $6 AND (employee_code = $7 OR (citizen_id IS NOT NULL AND citizen_id = $5))
       RETURNING id, employee_code, employee_name, company_id`,
      [
        fullName,
        it.department || extracted.department_staffing_plan || '',
        it.job_title || extracted.job_title || '',
        it.email || extracted.email || '',
        cleanCitizenId,
        comp,
        targetCode
      ]
    );

    const empRow = empRes.rows[0];
    const targetEmpId = empRow ? empRow.id : null;
    const resolvedEmpCode = empRow ? empRow.employee_code : targetCode;

    // 2. Cập nhật bảng hr_employee_profiles: xóa nhãn [ĐÃ XÓA]
    const profCheck = await client.query(
      `SELECT id FROM hr_employee_profiles
       WHERE (company_id = $1 AND employee_id = $2) OR (citizen_id IS NOT NULL AND citizen_id = $3)
       LIMIT 1`,
      [comp, resolvedEmpCode, cleanCitizenId]
    );

    if (profCheck.rows.length > 0) {
      await client.query(
        `UPDATE hr_employee_profiles
         SET is_deleted = false,
             deleted_at = NULL,
             employment_status = 'ACTIVE',
             status = 'ACTIVE',
             resignation_date = NULL,
             resignation_reason = NULL,
             full_name = REPLACE(REPLACE(COALESCE(NULLIF($1, ''), full_name), ' [ĐÃ XÓA]', ''), ' [NGHỈ VIỆC]', ''),
             department_staffing_plan = COALESCE(NULLIF($2, ''), department_staffing_plan),
             job_title = COALESCE(NULLIF($3, ''), job_title),
             email = COALESCE(NULLIF($4, ''), email),
             phone_number = COALESCE(NULLIF($5, ''), phone_number),
             base_salary = COALESCE(NULLIF($6, ''), base_salary),
             recruitment_decision_no = COALESCE(NULLIF($7, ''), recruitment_decision_no),
             employment_start_date = COALESCE(NULLIF($8, ''), employment_start_date),
             file_name = COALESCE(NULLIF($9, ''), file_name),
             updated_at = NOW()
         WHERE id = $10`,
        [
          fullName,
          it.department || extracted.department_staffing_plan || '',
          it.job_title || extracted.job_title || '',
          it.email || extracted.email || '',
          it.phone_number || extracted.phone_number || '',
          it.base_salary || extracted.base_salary || '',
          it.recruitment_decision_no || extracted.recruitment_decision_no || '',
          it.employment_start_date || extracted.employment_start_date || '',
          it.file_name || '',
          profCheck.rows[0].id
        ]
      );
    }

    // 3. Tái kích hoạt tài khoản liên kết nếu có
    if (targetEmpId) {
      await client.query(
        `UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE employee_id = $1`,
        [targetEmpId]
      );
    }

    // 4. Cập nhật trạng thái Staging sang approved
    await client.query(
      `UPDATE hr_employee_staging
       SET staging_status = 'approved', employee_code = $1, approver_username = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [resolvedEmpCode, user.username, it.id]
    );

    return {
      type: isRestore ? 'restored' : 'rehired',
      id: it.id,
      employee_id: targetEmpId,
      name: fullName,
      code: resolvedEmpCode,
      company: comp,
      isRestore: true
    };
  }

  // =========================================================================
  // SUB-CASE 2: NEW EMPLOYEE PROFILE ONBOARDING (intake_mode === 'new_profile')
  // =========================================================================
  const valRes = validateItemForApproval(it, comp);
  if (!valRes.valid) {
    const err = new Error(`Hồ sơ "${fullName}" (${it.file_name || 'Không rõ tệp'}) thiếu dữ liệu định danh bắt buộc: [${valRes.missing.join('; ')}]. Vui lòng bổ sung đầy đủ trước khi phê duyệt.`);
    err.status = 400;
    throw err;
  }

  let officialCode = valRes.resolvedCode;
  const cleanCitizenId = valRes.cleanCitizenId;

  // Preserve existing official employee_code if already assigned in this company
  if (cleanCitizenId && comp && !it.employee_code) {
    const existingCheck = await client.query(
      `SELECT employee_id FROM hr_employee_profiles WHERE company_id = $1 AND citizen_id = $2 AND employee_id <> '' AND employee_id IS NOT NULL LIMIT 1`,
      [comp, cleanCitizenId]
    );
    if (existingCheck.rows.length > 0) {
      officialCode = existingCheck.rows[0].employee_id;
    } else {
      const empCheck = await client.query(
        `SELECT employee_code FROM employees WHERE company_id = $1 AND citizen_id = $2 AND employee_code <> '' AND employee_code IS NOT NULL LIMIT 1`,
        [comp, cleanCitizenId]
      );
      if (empCheck.rows.length > 0) {
        officialCode = empCheck.rows[0].employee_code;
      }
    }
  }

  // Tự động sinh mã nhân viên chính thức nếu chưa có mã hợp lệ (Phương án A đã được phê duyệt)
  if (!officialCode) {
    officialCode = await generateNextEmployeeCode(client, comp);
  }

  try {
    // Anti-race condition & duplicate check: Check if CCCD already exists in either table (chỉ kiểm tra hồ sơ ACTIVE)
    if (cleanCitizenId) {
      const existingCheckGlobal = await client.query(
        `SELECT 'employees' as src, company_id, employee_code, employee_name as full_name FROM employees WHERE (citizen_id = $1 OR LPAD(citizen_id, 12, '0') = LPAD($1, 12, '0')) AND status != 'DELETED'
         UNION ALL
         SELECT 'hr_employee_profiles' as src, company_id, employee_id as employee_code, full_name FROM hr_employee_profiles WHERE (citizen_id = $1 OR LPAD(citizen_id, 12, '0') = LPAD($1, 12, '0')) AND is_deleted = false
         LIMIT 1`,
        [cleanCitizenId]
      );
      if (existingCheckGlobal.rows.length > 0) {
        const match = existingCheckGlobal.rows[0];
        const err = new Error(`Chặn tạo bản ghi trùng lặp: Số CCCD (${cleanCitizenId}) đã tồn tại trong CSDL tại đơn vị ${match.company_id} (Nhân sự: "${match.full_name}", Mã: "${match.employee_code || 'Chưa cấp'}"). Hệ thống từ chối tạo mới hoặc ghi đè hồ sơ.`);
        err.status = 409;
        throw err;
      }
    }

    // 1. Resolve or Create hr_persons
    let personId = null;
    let identityDoc = null;

    if (cleanCitizenId) {
      identityDoc = await findIdentityDocument(client, cleanCitizenId, 'CCCD', 'VNM');
      if (identityDoc) {
        personId = identityDoc.person_id;
      }
    }

    const ext = typeof it.extracted_data === 'string' ? JSON.parse(it.extracted_data) : (it.extracted_data || {});

    if (!personId) {
      let dob = null;
      const rawDob = it.date_of_birth || ext.date_of_birth;
      if (rawDob && /^\d{4}-\d{2}-\d{2}$/.test(String(rawDob).trim())) {
        dob = String(rawDob).trim();
      } else if (rawDob && /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(String(rawDob).trim())) {
        const parts = String(rawDob).trim().split(/[/-]/);
        dob = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }

      let gender = 'KHAC';
      const rawGender = String(it.gender || ext.gender || '').trim().toLowerCase();
      if (rawGender.includes('nam')) gender = 'NAM';
      else if (rawGender.includes('nữ') || rawGender.includes('nu')) gender = 'NU';

      const pRes = await client.query(`
        INSERT INTO hr_persons (
          full_name,
          date_of_birth,
          gender,
          birth_registration_place,
          place_of_origin,
          permanent_address,
          temporary_address,
          current_address,
          ethnicity,
          education_level,
          education_code,
          qualification,
          major,
          specialization,
          degree_qualification,
          training_institution,
          training_mode,
          training_period,
          graduation_grade,
          degree_valid_until,
          other_professional_certificates,
          phone_number,
          personal_email,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, 'ACTIVE', NOW(), NOW()
        ) RETURNING id;
      `, [
        fullName,
        dob,
        gender,
        ext.birth_registration_place || '',
        ext.place_of_origin || '',
        ext.permanent_address || '',
        ext.temporary_address || '',
        ext.current_address || '',
        ext.ethnicity || '',
        ext.education_level || '',
        ext.education_code || '',
        ext.qualification || '',
        ext.major || '',
        ext.specialization || '',
        ext.degree_qualification || '',
        ext.training_institution || '',
        ext.training_mode || '',
        ext.training_period || '',
        ext.graduation_grade || '',
        ext.degree_valid_until || '',
        ext.other_professional_certificates || '',
        it.phone_number || ext.phone_number || '',
        ext.personal_email || it.email || ''
      ]);
      personId = pRes.rows[0].id;

      if (cleanCitizenId) {
        const canonical = canonicalizeIdentity('CCCD', 'VNM', cleanCitizenId);
        const hmac = computeBlindIndex(canonical, 1);
        const masked = maskIdentityNumber(cleanCitizenId);
        const enc = encryptDocNumber(cleanCitizenId, 'kms-key-v1');

        let issueDate = null;
        const rawIssueDate = ext.citizen_id_issue_date;
        if (rawIssueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(rawIssueDate).trim())) {
          issueDate = String(rawIssueDate).trim();
        }

        await client.query(`
          INSERT INTO hr_person_identity_documents (
            person_id,
            doc_type,
            country_code,
            doc_number_encrypted,
            iv,
            auth_tag,
            encryption_key_id,
            doc_number_hmac,
            hmac_key_version,
            masked_number,
            issue_date,
            issue_place,
            is_primary,
            lifecycle_status,
            verification_status,
            created_at,
            updated_at
          ) VALUES (
            $1, 'CCCD', 'VNM', $2, $3, $4, $5, $6, 1, $7, $8, $9, true, 'ACTIVE', 'MANUALLY_VERIFIED', NOW(), NOW()
          );
        `, [
          personId,
          enc.encryptedBytes,
          enc.iv,
          enc.authTag,
          enc.keyId,
          hmac,
          masked,
          issueDate,
          ext.citizen_id_issue_place || ''
        ]);
      }
    }

    // 2. Tạo bản ghi quan hệ lao động (employees)
    const empId = crypto.randomUUID();
    const maskedCitizen = cleanCitizenId ? maskIdentityNumber(cleanCitizenId) : null;
    let startDate = null;
    const rawStartDate = it.employment_start_date || ext.employment_start_date;
    if (rawStartDate && /^\d{4}-\d{2}-\d{2}$/.test(String(rawStartDate).trim())) {
      startDate = String(rawStartDate).trim();
    }

    const actorUser = user?.username || it.uploaded_by || 'superadmin';

    const empStatusVal = it.employment_status || ext.employment_status || 'ACTIVE';

    await client.query(`
      INSERT INTO employees (
        id, person_id, employee_code, employee_name, company_id, department, position, email, status, employment_status, citizen_id, employment_start_date, updated_by, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, $10, $11, $12, NOW(), NOW()
      );
    `, [
      empId,
      personId,
      officialCode,
      fullName,
      comp,
      it.department || ext.department_staffing_plan || '',
      it.job_title || ext.job_title || '',
      it.email || ext.email || '',
      empStatusVal,
      maskedCitizen,
      startDate,
      actorUser
    ]);

    // 3. Tạo hồ sơ chi tiết hr_employee_profiles
    const profInsert = await client.query(
      `INSERT INTO hr_employee_profiles (
        employment_id, job_grade, employee_id, full_name, date_of_birth, gender,
        job_title, professional_title, department_staffing_plan, section_staffing_plan,
        citizen_id, citizen_id_issue_date, citizen_id_issue_place, birth_registration_place,
        place_of_origin, permanent_address, temporary_address, current_address,
        ethnicity, education_level, education_code, qualification,
        professional_qualification, specialization, degree_qualification,
        training_institution, major, training_mode, training_period,
        graduation_grade, degree_valid_until, other_professional_certificates,
        social_insurance_salary, total_income, base_salary,
        productivity_responsibility_pay, attendance_bonus, responsibility_allowance,
        vessel_size_allowance, professional_allowance_t1, meal_allowance, other_allowances,
        open_ended_contract, fixed_term_contract, seasonal_contract,
        contract_start_date, contract_end_date, recruitment_decision_no,
        employment_start_date, official_labor_contract_sign_date, phone_number,
        email, create_time, file_name, company_id, version, created_at, updated_at,
        uploaded_by, updated_by, employment_status
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25,
        $26, $27, $28, $29, $30,
        $31, $32, $33, $34, $35,
        $36, $37, $38, $39, $40,
        $41, $42, $43, $44, $45,
        $46, $47, $48, $49, $50,
        $51, $52, $53, $54, $55, 1, NOW(), NOW(),
        $56, $57, $58
      ) RETURNING id;`,
      [
        empId,
        ext.job_grade || '',
        officialCode,
        fullName,
        it.date_of_birth || ext.date_of_birth || '',
        it.gender || ext.gender || '',
        it.job_title || ext.job_title || '',
        ext.professional_title || '',
        it.department || ext.department_staffing_plan || '',
        ext.section_staffing_plan || '',
        maskedCitizen || cleanCitizenId || '',
        ext.citizen_id_issue_date || '',
        ext.citizen_id_issue_place || '',
        ext.birth_registration_place || '',
        ext.place_of_origin || '',
        ext.permanent_address || '',
        ext.temporary_address || '',
        ext.current_address || '',
        ext.ethnicity || '',
        ext.education_level || '',
        ext.education_code || '',
        ext.qualification || '',
        ext.professional_qualification || '',
        ext.specialization || '',
        ext.degree_qualification || '',
        ext.training_institution || '',
        ext.major || '',
        ext.training_mode || '',
        ext.training_period || '',
        ext.graduation_grade || '',
        ext.degree_valid_until || '',
        ext.other_professional_certificates || '',
        ext.social_insurance_salary || '',
        ext.total_income || '',
        it.base_salary || ext.base_salary || '',
        ext.productivity_responsibility_pay || '',
        ext.attendance_bonus || '',
        ext.responsibility_allowance || '',
        ext.vessel_size_allowance || '',
        ext.professional_allowance_t1 || '',
        ext.meal_allowance || '',
        ext.other_allowances || '',
        ext.open_ended_contract || '',
        ext.fixed_term_contract || '',
        ext.seasonal_contract || '',
        ext.contract_start_date || '',
        ext.contract_end_date || '',
        it.recruitment_decision_no || ext.recruitment_decision_no || '',
        it.employment_start_date || ext.employment_start_date || '',
        ext.official_labor_contract_sign_date || '',
        it.phone_number || ext.phone_number || '',
        it.email || ext.email || '',
        ext.create_time || new Date().toISOString(),
        it.file_name || 'MANUAL_INTAKE',
        comp,
        it.uploaded_by || actorUser,
        actorUser,
        empStatusVal
      ]
    );
    const profileId = profInsert.rows[0].id;

    // 4. Ghi nhận lịch sử tiếp nhận ban đầu (hr_employment_history)
    await client.query(`
      INSERT INTO hr_employment_history (
        employment_id, person_id, event_type, to_company_id, to_department, to_position, to_status, decision_no, actor_username, created_at
      ) VALUES (
        $1, $2, 'ONBOARDING', $3, $4, $5, 'ACTIVE', $6, $7, NOW()
      );
    `, [
      empId,
      personId,
      comp,
      it.department || ext.department_staffing_plan || '',
      it.job_title || ext.job_title || '',
      it.recruitment_decision_no || ext.recruitment_decision_no || '',
      user.username
    ]);

    // 5. Ghi nhận thông tin đãi ngộ lương nếu có (hr_employment_compensation)
    const baseSalaryNum = parseFloat(String(it.base_salary || ext.base_salary || '0').replace(/[^\d.]/g, '')) || 0;
    const totalIncomeNum = parseFloat(String(it.total_income || ext.total_income || '0').replace(/[^\d.]/g, '')) || 0;
    if (baseSalaryNum > 0 || totalIncomeNum > 0) {
      await client.query(`
        INSERT INTO hr_employment_compensation (
          employment_id, effective_from, base_salary, total_income, decision_no, is_current, created_by, created_at
        ) VALUES (
          $1, COALESCE($2, CURRENT_DATE), $3, $4, $5, true, $6, NOW()
        );
      `, [
        empId,
        startDate,
        baseSalaryNum,
        totalIncomeNum,
        it.recruitment_decision_no || ext.recruitment_decision_no || '',
        user.username
      ]);
    }

    // 6. Ghi nhận tài liệu scan đính kèm nếu có (hr_employment_documents)
    if (it.file_name && it.file_storage_path) {
      await client.query(`
        INSERT INTO hr_employment_documents (
          employment_id, person_id, document_type, file_name, file_storage_path, file_size, mime_type, uploaded_by, created_at
        ) VALUES (
          $1, $2, 'ID_CARD', $3, $4, $5, $6, $7, NOW()
        );
      `, [
        empId,
        personId,
        it.file_name,
        it.file_storage_path,
        it.file_size || 0,
        it.mime_type || 'application/octet-stream',
        user.username
      ]);
    }

    // 7. Cập nhật Staging record
    await client.query(`
      UPDATE hr_employee_staging 
      SET staging_status = 'approved',
          employee_code = $1,
          target_profile_id = $2,
          approver_username = $3,
          approved_at = NOW(),
          updated_at = NOW()
      WHERE id = $4;
    `, [officialCode, profileId, user.username, it.id]);

    return {
      type: 'created',
      id: it.id,
      name: fullName,
      code: officialCode,
      company: comp,
      employee_id: empId,
      person_id: personId
    };
  } catch (dbErr) {
    if (dbErr.code === '23505') {
      const conflictErr = new Error(`409 Conflict: Hồ sơ định danh (CCCD: ${cleanCitizenId} / Mã: ${officialCode}) đã tồn tại trong đơn vị ${comp} (xung đột bản ghi đồng thời). Hệ thống bảo toàn tính toàn vẹn dữ liệu.`);
      conflictErr.status = 409;
      throw conflictErr;
    }
    throw dbErr;
  }
}

// ----------------------------------------------------------------------------
// 2.1. POST /api/hoso/intake/manual-draft - Tiếp nhận hồ sơ thủ công (Manual Staging)
// ----------------------------------------------------------------------------
router.post('/manual-draft', verifyToken, async (req, res) => {
  try {
    const {
      full_name,
      citizen_id,
      doc_type = 'CCCD',
      company_id,
      department,
      position,
      email,
      phone_number,
      date_of_birth,
      gender,
      permanent_address,
      current_address,
      base_salary,
      total_income,
      employment_start_date,
      recruitment_decision_no,
      submit_for_approval = false
    } = req.body;

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ success: false, error: 'Họ và tên là thông tin bắt buộc.' });
    }

    const targetCompany = String(company_id || (req.user.role === 'ADMIN' ? 'STL' : req.user.company_id)).trim().toUpperCase();
    if (!['STL', 'VTX', 'SWC'].includes(targetCompany)) {
      return res.status(400).json({ success: false, error: 'Công ty không hợp lệ (phải thuộc STL, VTX hoặc SWC).' });
    }

    if (req.user.role !== 'ADMIN' && req.user.company_id && targetCompany !== req.user.company_id) {
      return res.status(403).json({ success: false, error: `403 Forbidden: Tài khoản thuộc đơn vị ${req.user.company_id} không được tạo hồ sơ cho đơn vị ${targetCompany}.` });
    }

    const rawCccd = citizen_id || req.body.doc_number;
    const cleanCccd = rawCccd ? String(rawCccd).replace(/\D/g, '') : null;
    const rawPosition = position || req.body.job_title || '';
    const rawEmail = email || req.body.work_email || '';
    const rawPhone = phone_number || req.body.mobile_phone || '';
    const rawStartDate = employment_start_date || req.body.date_of_joining || null;

    let dupCheck = null;
    if (cleanCccd) {
      dupCheck = await checkDatabaseCccdDuplicates(cleanCccd, targetCompany, req.user, full_name);
    }

    const isDuplicate = dupCheck && dupCheck.hasDuplicate;
    const initialStatus = (submit_for_approval !== false || req.user.role === 'HR') ? 'pending_approval' : 'pending_review';
    const batchId = crypto.randomUUID();

    const stagingInsert = await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id,
        file_name,
        full_name,
        citizen_id,
        employee_code,
        date_of_birth,
        gender,
        job_title,
        department,
        email,
        phone_number,
        recruitment_decision_no,
        employment_start_date,
        base_salary,
        company_id,
        company_status,
        company_evidence,
        staging_status,
        suspected_duplicate,
        duplicate_reason,
        extracted_data,
        uploaded_by,
        uploaded_by_user_id,
        intake_mode,
        created_at,
        updated_at
      ) VALUES (
        $1, 'MANUAL_INTAKE', $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        'confirmed', 'Tiếp nhận thủ công trực tiếp từ giao diện', $14, $15, $16, $17::jsonb,
        $18, $19, $20, NOW(), NOW()
      ) RETURNING id;
    `, [
      batchId,
      String(full_name).trim(),
      cleanCccd,
      date_of_birth || null,
      gender || 'KHAC',
      rawPosition,
      department || '',
      rawEmail,
      rawPhone,
      recruitment_decision_no || '',
      rawStartDate,
      base_salary || '',
      targetCompany,
      initialStatus,
      isDuplicate ? true : false,
      isDuplicate ? dupCheck.reason : null,
      JSON.stringify({
        source_type: 'MANUAL_INTAKE',
        full_name: String(full_name).trim(),
        citizen_id: cleanCccd,
        doc_type,
        company_id: targetCompany,
        department,
        job_title: rawPosition,
        email: rawEmail,
        phone_number: rawPhone,
        date_of_birth,
        gender,
        permanent_address,
        current_address,
        base_salary,
        total_income,
        employment_start_date: rawStartDate,
        recruitment_decision_no
      }),
      req.user.username,
      req.user.user_id,
      isDuplicate ? 'suspected_duplicate' : 'new_profile'
    ]);

    const stagingId = stagingInsert.rows[0].id;

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_MANUAL_DRAFT_CREATED',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: { staging_id: stagingId, full_name, company_id: targetCompany, is_duplicate: isDuplicate }
    });

    return res.status(201).json({
      success: true,
      staging_id: stagingId,
      status: initialStatus,
      message: submit_for_approval 
        ? 'Hồ sơ đã được tạo và gửi chờ ADMIN phê duyệt.' 
        : 'Hồ sơ nháp thủ công đã được lưu vào Staging.'
    });
  } catch (err) {
    console.error('Lỗi manual-draft:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 2.2. POST /api/hoso/intake/direct-onboard - ADMIN Tiếp nhận & Duyệt trực tiếp
// ----------------------------------------------------------------------------
router.post('/direct-onboard', verifyToken, async (req, res) => {
  if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Chỉ Quản trị viên (ADMIN) mới có thẩm quyền thực hiện Direct Onboarding.'
    });
  }

  const client = await db.getClient();
  try {
    const {
      full_name,
      citizen_id,
      doc_type = 'CCCD',
      company_id,
      department,
      position,
      email,
      phone_number,
      date_of_birth,
      gender,
      permanent_address,
      current_address,
      base_salary,
      total_income,
      employment_start_date,
      recruitment_decision_no
    } = req.body;

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ success: false, error: 'Họ và tên là thông tin bắt buộc.' });
    }

    const targetCompany = String(company_id || 'STL').trim().toUpperCase();
    if (!['STL', 'VTX', 'SWC'].includes(targetCompany)) {
      return res.status(400).json({ success: false, error: 'Công ty không hợp lệ (phải thuộc STL, VTX hoặc SWC).' });
    }

    const rawCccd = citizen_id || req.body.doc_number;
    const cleanCccd = rawCccd ? String(rawCccd).replace(/\D/g, '') : null;
    const rawPosition = position || req.body.job_title || '';
    const rawEmail = email || req.body.work_email || '';
    const rawPhone = phone_number || req.body.mobile_phone || '';
    const rawStartDate = employment_start_date || req.body.date_of_joining || null;

    await client.query('BEGIN');

    // Advisory lock
    if (cleanCccd) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCccd]);
      const dupCheck = await checkDatabaseCccdDuplicates(cleanCccd, targetCompany, req.user, full_name, client);
      if (dupCheck && dupCheck.hasDuplicate) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: `Từ chối tiếp nhận: ${dupCheck.reason}`
        });
      }
    }

    // 1. Tạo Staging record làm nguồn gốc
    const batchId = crypto.randomUUID();
    const stagingRes = await client.query(`
      INSERT INTO hr_employee_staging (
        batch_id,
        file_name,
        full_name,
        citizen_id,
        employee_code,
        date_of_birth,
        gender,
        job_title,
        department,
        email,
        phone_number,
        recruitment_decision_no,
        employment_start_date,
        base_salary,
        company_id,
        company_status,
        company_evidence,
        staging_status,
        extracted_data,
        uploaded_by,
        uploaded_by_user_id,
        approver_username,
        approved_at,
        intake_mode,
        created_at,
        updated_at
      ) VALUES (
        $1, 'MANUAL_INTAKE', $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        'confirmed', 'Direct Onboard bởi ADMIN', 'pending_approval', $14::jsonb,
        $15, $16, $17, NOW(), 'new_profile', NOW(), NOW()
      ) RETURNING *;
    `, [
      batchId,
      String(full_name).trim(),
      cleanCccd,
      date_of_birth || null,
      gender || 'KHAC',
      rawPosition,
      department || '',
      rawEmail,
      rawPhone,
      recruitment_decision_no || '',
      rawStartDate,
      base_salary || '',
      targetCompany,
      JSON.stringify({
        source_type: 'MANUAL_INTAKE',
        full_name: String(full_name).trim(),
        citizen_id: cleanCccd,
        doc_type,
        company_id: targetCompany,
        department,
        job_title: rawPosition,
        email: rawEmail,
        phone_number: rawPhone,
        date_of_birth,
        gender,
        permanent_address,
        current_address,
        base_salary,
        total_income,
        employment_start_date: rawStartDate,
        recruitment_decision_no
      }),
      req.user.username,
      req.user.user_id,
      req.user.username
    ]);

    const stagingRow = stagingRes.rows[0];

    // 2. Phê duyệt chính thức trong cùng transaction
    const approvalResult = await executeStagingApproval(client, stagingRow, req.user);

    await client.query('COMMIT');

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'ADMIN_DIRECT_ONBOARD',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        staging_id: stagingRow.id,
        employee_code: approvalResult.code,
        employee_id: approvalResult.employee_id,
        person_id: approvalResult.person_id,
        company_id: targetCompany
      }
    });

    return res.status(201).json({
      success: true,
      message: `🎉 Direct Onboarding thành công! Nhân sự đã được tiếp nhận với mã nhân viên: ${approvalResult.code}`,
      employee_code: approvalResult.code,
      employee_id: approvalResult.employee_id,
      person_id: approvalResult.person_id,
      staging_id: stagingRow.id
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi direct-onboard:', err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// 3. POST /api/hoso/intake/approve
// ----------------------------------------------------------------------------
router.post('/approve', verifyToken, async (req, res) => {
  const client = await db.getClient();
  try {
    const { staging_ids, staging_id, id, ids: reqIds } = req.body;
    let rawIds = staging_ids || reqIds;
    if (!rawIds) {
      if (staging_id) rawIds = [staging_id];
      else if (id) rawIds = [id];
      else rawIds = [];
    }
    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp danh sách ID hồ sơ cần phê duyệt.' });
    }

    const canApprove = await hasPermission(req.user.role, 'hr.intake.approve');
    const canSubmit = await hasPermission(req.user.role, 'hr.intake.submit');

    if (!canApprove && !canSubmit) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Tài khoản không có quyền thao tác phê duyệt hoặc gửi duyệt hồ sơ.' });
    }

    const checkRes = await client.query(
      `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    const items = checkRes.rows;
    if (items.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ staging tương ứng.' });
    }

    // GUARD 0A: Prevent duplicate approval on already approved dossiers (IDEMPOTENCY)
    const alreadyApproved = items.filter(r => r.staging_status === 'approved');
    if (alreadyApproved.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Từ chối phê duyệt: Hồ sơ ${alreadyApproved.map(d => d.file_name || d.full_name).join(', ')} đã được phê duyệt chính thức trước đó. Không thể phê duyệt lặp lại.`
      });
    }

    // GUARD 0: Strictly block submit or approve of duplicate / company mismatched records
    const blockingItems = [];
    for (const it of items) {
      // Re-verify against current database to ensure no stale data
      const cleanCitizen = it.citizen_id ? String(it.citizen_id).replace(/\D/g, '') : null;
      let currentDupCheck = null;
      if (cleanCitizen) {
        currentDupCheck = await checkDatabaseCccdDuplicates(cleanCitizen, it.company_id, req.user, it.full_name);
      }

      // FAIL-CLOSED: If duplicate check service is unavailable during approval, halt with 503
      if (currentDupCheck && currentDupCheck.duplicateType === 'DUPLICATE_CHECK_UNAVAILABLE') {
        return res.status(503).json({
          success: false,
          error: '503 Service Unavailable: Dịch vụ đối soát trùng lặp CCCD tạm thời không khả dụng. Giao dịch phê duyệt bị tạm dừng để bảo vệ an toàn CSDL.',
          code: 'DUPLICATE_CHECK_UNAVAILABLE'
        });
      }

      const pc = (it.proposed_changes && typeof it.proposed_changes === 'object') ? it.proposed_changes : {};
      const valErrors = Array.isArray(pc.validation_errors) ? [...pc.validation_errors] : [];

      // FAIL-CLOSED: If dossier was staged with unverified / unavailable duplicate check, block approval
      if (valErrors.some(e => e.code === 'DUPLICATE_CHECK_UNAVAILABLE')) {
        return res.status(503).json({
          success: false,
          error: `Từ chối phê duyệt: Hồ sơ "${it.full_name}" chưa thể đối soát trùng lặp do CSDL kiểm tra tạm thời không sẵn sàng (DUPLICATE_CHECK_UNAVAILABLE). Vui lòng thử lại sau.`,
          code: 'DUPLICATE_CHECK_UNAVAILABLE',
          validation_errors: [{
            code: 'DUPLICATE_CHECK_UNAVAILABLE',
            severity: 'BLOCKING',
            blocking: true,
            safe_message: 'Hồ sơ chưa hoàn thành đối soát trùng lặp do CSDL kiểm tra tạm thời không sẵn sàng.'
          }]
        });
      }

      // FAIL-CLOSED: If dossier was staged with insufficient data, block approval with explicit INSUFFICIENT_DATA code
      if (it.intake_mode === 'insufficient_data') {
        return res.status(400).json({
          success: false,
          error: `Từ chối phê duyệt: Hồ sơ "${it.full_name}" đang ở chế độ dữ liệu chưa hoàn tất (INSUFFICIENT_DATA). Vui lòng cập nhật bổ sung trước khi phê duyệt.`,
          code: 'INSUFFICIENT_DATA',
          validation_errors: [{
            code: 'INSUFFICIENT_DATA',
            severity: 'BLOCKING',
            blocking: true,
            safe_message: 'Hồ sơ thiếu dữ liệu định danh bắt buộc (họ tên hoặc số CCCD).'
          }]
        });
      }

      // Check current duplicate status
      const hasActiveOrCrossDup = currentDupCheck && currentDupCheck.hasDuplicate && 
        ['CROSS_COMPANY_DUPLICATE', 'ACTIVE_SAME_COMPANY_DUPLICATE', 'IDENTITY_MISMATCH'].includes(currentDupCheck.duplicateType);

      // Check current mismatch status
      const ext = (typeof it.extracted_data === 'object' && it.extracted_data) ? it.extracted_data : {};
      const rawText = ext._raw_text || '';
      const compDet = detectCompany(ext, rawText);
      const isMismatch = (compDet.company_id && it.company_id && compDet.company_id.toUpperCase() !== it.company_id.toUpperCase()) ||
        (it.company_status === 'conflict') || (it.intake_mode === 'company_mismatch') || valErrors.some(e => e.code === 'COMPANY_MISMATCH');

      if (hasActiveOrCrossDup || it.suspected_duplicate || isMismatch) {
        // Collect structured errors
        const itemErrors = [];
        if (hasActiveOrCrossDup || it.suspected_duplicate) {
          const dupCode = currentDupCheck ? currentDupCheck.duplicateType : 'DUP_CCCD_EXISTING';
          itemErrors.push({
            code: dupCode,
            severity: 'BLOCKING',
            blocking: true,
            field: 'citizen_id',
            safe_message: currentDupCheck ? currentDupCheck.reason : (it.duplicate_reason || 'Trùng lặp CCCD trong hệ thống.'),
            resolution_action: dupCode === 'CROSS_COMPANY_DUPLICATE' ? 'INTERNAL_TRANSFER_REQUIRED' : 'REJECT_DUPLICATE'
          });
        }
        if (isMismatch) {
          itemErrors.push({
            code: 'COMPANY_MISMATCH',
            severity: 'BLOCKING',
            blocking: true,
            field: 'company_id',
            safe_message: `Hồ sơ có dấu hiệu pháp lý thuộc đơn vị ${compDet.company_id || 'khác'}, nhưng đơn vị tiếp nhận là ${it.company_id || 'chưa gán'}. Cần xác nhận văn bản tiếp nhận hoặc điều chuyển hợp lệ.`,
            resolution_action: 'CONFIRM_COMPANY_OR_PROVIDE_TRANSFER_DOC'
          });
        }

        blockingItems.push({
          item: it,
          hasDup: (hasActiveOrCrossDup || it.suspected_duplicate),
          hasMismatch: isMismatch,
          dupReason: currentDupCheck ? currentDupCheck.reason : it.duplicate_reason,
          mismatchReason: `Lệch đơn vị giữa hồ sơ scan (${compDet.company_id || 'khác'}) và đơn vị tiếp nhận (${it.company_id || 'chưa gán'})`,
          errors: itemErrors
        });
      }
    }

    if (blockingItems.length > 0) {
      const first = blockingItems[0];
      const it = first.item;
      let errorMsg = '';
      if (first.hasDup && first.hasMismatch) {
        errorMsg = `Từ chối phê duyệt: Hồ sơ "${it.full_name}" (${it.file_name || ''}) đồng thời bị phát hiện TRÙNG LẶP CCCD liên công ty và LỆCH ĐƠN VỊ tiếp nhận (Company Mismatch). Hệ thống chặn tuyệt đối việc tạo bản ghi mới hoặc phê duyệt theo chính sách BIZ-CCCD-01 và quy tắc cô lập đa đơn vị. Hướng xử lý: Thực hiện thủ tục điều chuyển nội bộ tập đoàn hoặc đối soát lại hồ sơ gốc.`;
      } else if (first.hasDup) {
        errorMsg = `Từ chối phê duyệt: Hồ sơ "${it.full_name}" (${it.file_name || ''}) đã bị phát hiện TRÙNG LẶP CCCD (${first.dupReason || 'Đã tồn tại trong hệ thống'}). Chặn tuyệt đối việc tạo bản ghi mới hoặc ghi đè dữ liệu nhân sự.`;
      } else if (first.hasMismatch) {
        errorMsg = `Từ chối phê duyệt: Hồ sơ "${it.full_name}" đang bị gắn cờ "Lệch đơn vị" (Company Mismatch). ${first.mismatchReason}. Bạn không thể duyệt hồ sơ khi chưa có văn bản tiếp nhận hoặc điều chuyển hợp lệ.`;
      } else {
        errorMsg = `Từ chối phê duyệt: Hồ sơ "${it.full_name}" chưa đáp ứng tiêu chuẩn tiếp nhận nhân sự.`;
      }

      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'HR_INTAKE_APPROVAL_BLOCKED',
        status: 'BLOCKED',
        ip_address: req.ip,
        metadata: {
          staging_id: it.id,
          reasons: first.errors.map(e => e.code),
          hasDup: first.hasDup,
          hasMismatch: first.hasMismatch
        }
      });

      return res.status(400).json({
        success: false,
        error: errorMsg,
        validation_errors: first.errors,
        blocking_count: blockingItems.length
      });
    }

    // Role has SUBMIT only (HR / Staff)
    if (!canApprove && canSubmit) {
      for (const it of items) {
        if (req.user.role !== 'ADMIN' && it.company_id && it.company_id !== req.user.company_id) {
          return res.status(403).json({
            success: false,
            error: `403 Forbidden: Bạn không được phép thao tác hồ sơ của đơn vị khác (${it.company_id}).`
          });
        }
      }

      await client.query(
        `UPDATE hr_employee_staging
         SET staging_status = 'pending_approval',
             reviewer_username = $1,
             reviewed_at = NOW(),
             updated_at = NOW()
         WHERE id = ANY($2::uuid[])`,
        [req.user.username, ids]
      );

      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'HR_INTAKE_SUBMITTED_FOR_APPROVAL',
        status: 'SUCCESS',
        ip_address: req.ip,
        metadata: { staging_ids: ids, count: items.length }
      });

      return res.json({
        success: true,
        action: 'submitted',
        count: items.length,
        reply: `📤 **Hồ sơ đã được tiếp nhận và chuyển sang trạng thái "Chờ phê duyệt" (pending_approval).**\n\n` +
          `Do vai trò của bạn (**${req.user.role}**) không có thẩm quyền phê duyệt chính thức (Separation of Duties), hồ sơ đã được lưu an toàn trong vùng Staging và gửi tới Quản trị viên (**ADMIN**) để xem xét và duyệt chính thức vào hệ thống.`
      });
    }

    // Role has APPROVE (ADMIN)
    // Unified Admin Policy: Mọi ADMIN (STL, SWC, VTX) đều có thẩm quyền phê duyệt
    // Các quy tắc an toàn nghiệp vụ (chặn CCCD trùng, lệch công ty, thiếu dữ liệu) áp dụng bình đẳng cho mọi ADMIN

    await client.query('BEGIN');
    const results = [];
    for (const it of items) {
      const cleanCitizen = it.citizen_id ? String(it.citizen_id).replace(/\D/g, '') : null;
      if (cleanCitizen) {
        // Concurrency lock: Advisory transaction-level lock on CCCD hash to serialize concurrent approvals of same identity
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCitizen]);

        // In-transaction live duplicate re-verification under advisory lock
        const inXactDupCheck = await checkDatabaseCccdDuplicates(cleanCitizen, it.company_id, req.user, it.full_name, client);
        if (inXactDupCheck && inXactDupCheck.hasDuplicate && ['CROSS_COMPANY_DUPLICATE', 'ACTIVE_SAME_COMPANY_DUPLICATE', 'IDENTITY_MISMATCH'].includes(inXactDupCheck.duplicateType)) {
          const err = new Error(`Từ chối phê duyệt: Phát hiện trùng lặp CCCD (${cleanCitizen}) với nhân sự chính thức vừa được ghi nhận trong giao dịch song song.`);
          err.status = 400;
          throw err;
        }
        if (inXactDupCheck && inXactDupCheck.duplicateType === 'DUPLICATE_CHECK_UNAVAILABLE') {
          const err = new Error(`503 Service Unavailable: Dịch vụ đối soát trùng lặp CCCD không khả dụng trong giao dịch phê duyệt.`);
          err.status = 503;
          err.code = 'DUPLICATE_CHECK_UNAVAILABLE';
          throw err;
        }
      }
      const resItem = await executeStagingApproval(client, it, req.user);
      results.push(resItem);
    }
    await client.query('COMMIT');

    // Queue sync tasks for all approved items AFTER transaction commits cleanly
    for (const r of results) {
      if (r && r.id) {
        if (r.type === 'restored' || r.type === 'rehired') {
          await queueEmployeeSync(r.employee_id, 'RESTORE', {
            employee_id: r.code,
            employee_code: r.code,
            full_name: r.name,
            employee_name: r.name,
            company_id: r.company,
            status: 'ACTIVE',
            action_type: 'RESTORE'
          });
        } else {
          try {
            await queueSyncTasks(r.id);
          } catch (syncErr) {
            console.warn('[Approve] queueSyncTasks warning:', syncErr.message);
          }
        }
      }
    }

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_APPROVED_OFFICIAL',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: { results }
    });

    const summaryLines = results.map(r => {
      if (r.type === 'updated') {
        return `- 🔄 Cập nhật: **${r.name}** • Mã NV: \`${r.code}\` • Đơn vị: **${r.company}** (Các trường: ${r.changedFields.join(', ')})`;
      } else if (r.type === 'restored') {
        return `- ♻️ Khôi phục: **${r.name}** • Mã NV: \`${r.code}\` • Đơn vị: **${r.company}** (Tái kích hoạt ACTIVE và đồng bộ 3 hệ thống)`;
      } else if (r.type === 'rehired') {
        return `- 💼 Tiếp nhận lại: **${r.name}** • Mã NV: \`${r.code}\` • Đơn vị: **${r.company}** (Bảo toàn lịch sử mã NV)`;
      }
      return `- 🎉 Tạo mới: **${r.name}** • Mã NV: \`${r.code}\` • Đơn vị: **${r.company}**`;
    }).join('\n');

    return res.json({
      success: true,
      action: 'approved',
      count: results.length,
      items: results,
      reply: `🎉 **Đã phê duyệt thành công ${results.length} hồ sơ nhân sự vào cơ sở dữ liệu!**\n\n` +
        `${summaryLines}\n\n` +
        `✅ Dữ liệu đã được ghi vào bảng nhân sự \`hr_employee_profiles\` & \`employees\`, đồng thời xếp hàng tác vụ đồng bộ sang NocoDB.`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi phê duyệt hồ sơ:', err);
    const statusCode = err.status || 500;
    const resp = { success: false, error: err.message };
    if (err.code) resp.code = err.code;
    return res.status(statusCode).json(resp);
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// 4. GET /api/hoso/intake/staging - Danh sách hồ sơ Staging (Phân trang, Bộ lọc, Thống kê, Phân quyền)
// ----------------------------------------------------------------------------
router.get('/staging', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'HR') {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền truy cập danh sách hồ sơ staging.' });
    }

    const {
      page = 1,
      limit = 20,
      status = 'all',
      company_id,
      search = '',
      batch_id
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // RBAC (Chính sách phân quyền ADMIN thống nhất):
    // ADMIN (STL, SWC, VTX) được xem toàn bộ danh sách hoặc lọc theo company_id truyền vào
    // Các vai trò khác (như HR) chỉ được xem trong phạm vi công ty của chính mình
    let effectiveCompany = null;
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id) {
      effectiveCompany = req.user.company_id;
    } else if (company_id && company_id !== 'all') {
      effectiveCompany = company_id;
    }

    // 1. Thống kê KPI counts trong phạm vi tenant
    const statsParams = [];
    let statsWhere = ' WHERE 1=1';
    if (effectiveCompany) {
      statsParams.push(effectiveCompany);
      statsWhere += ` AND (company_id = $${statsParams.length} OR company_id IS NULL)`;
    }

    const statsRes = await db.query(
      `SELECT 
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE staging_status = 'pending_approval') AS pending_approval,
        COUNT(*) FILTER (WHERE staging_status = 'pending_review') AS pending_review,
        COUNT(*) FILTER (WHERE staging_status = 'pending_review' AND (proposed_changes->'change_request' IS NOT NULL OR rejection_reason LIKE 'YÊU CẦU BỔ SUNG%')) AS awaiting_supplement,
        COUNT(*) FILTER (WHERE staging_status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE staging_status = 'rejected') AS rejected,
        COUNT(*) FILTER (WHERE suspected_duplicate = true OR intake_mode = 'suspected_duplicate') AS suspected_duplicate
      FROM hr_employee_staging ${statsWhere}`,
      statsParams
    );

    const rawStats = statsRes.rows[0] || {};
    const stats = {
      total: parseInt(rawStats.total, 10) || 0,
      pending_approval: parseInt(rawStats.pending_approval, 10) || 0,
      pending_review: parseInt(rawStats.pending_review, 10) || 0,
      awaiting_supplement: parseInt(rawStats.awaiting_supplement, 10) || 0,
      approved: parseInt(rawStats.approved, 10) || 0,
      rejected: parseInt(rawStats.rejected, 10) || 0,
      suspected_duplicate: parseInt(rawStats.suspected_duplicate, 10) || 0
    };

    // 2. Xây dựng điều kiện lọc danh sách
    const queryParams = [];
    let whereClause = ' WHERE 1=1';

    if (effectiveCompany) {
      queryParams.push(effectiveCompany);
      whereClause += ` AND (company_id = $${queryParams.length} OR company_id IS NULL)`;
    }

    if (status && status !== 'all') {
      if (status === 'suspected_duplicate') {
        whereClause += ` AND (suspected_duplicate = true OR intake_mode = 'suspected_duplicate')`;
      } else if (status === 'awaiting_supplement') {
        whereClause += ` AND staging_status = 'pending_review' AND (proposed_changes->'change_request' IS NOT NULL OR rejection_reason LIKE 'YÊU CẦU BỔ SUNG%')`;
      } else {
        queryParams.push(status);
        whereClause += ` AND staging_status = $${queryParams.length}`;
      }
    }

    if (batch_id) {
      queryParams.push(batch_id);
      whereClause += ` AND batch_id = $${queryParams.length}`;
    }

    if (search && search.trim()) {
      queryParams.push(`%${search.trim()}%`);
      whereClause += ` AND (
        full_name ILIKE $${queryParams.length} OR
        citizen_id ILIKE $${queryParams.length} OR
        employee_code ILIKE $${queryParams.length} OR
        file_name ILIKE $${queryParams.length} OR
        department ILIKE $${queryParams.length} OR
        job_title ILIKE $${queryParams.length}
      )`;
    }

    const countRes = await db.query(
      `SELECT COUNT(*) FROM hr_employee_staging ${whereClause}`,
      queryParams
    );
    const totalItems = parseInt(countRes.rows[0].count, 10);

    const itemsRes = await db.query(
      `SELECT 
        id, batch_id, file_name, file_size, mime_type, file_storage_path,
        full_name, citizen_id, employee_code, date_of_birth, gender,
        job_title, department, email, phone_number,
        company_id, company_status, company_evidence,
        staging_status, suspected_duplicate, duplicate_reason,
        intake_mode, uploaded_by, reviewer_username, approver_username,
        rejection_reason, created_at, updated_at, reviewed_at, approved_at,
        proposed_changes, missing_fields
      FROM hr_employee_staging 
      ${whereClause} 
      ORDER BY created_at DESC 
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
      [...queryParams, limitNum, offset]
    );

    const sanitizedItems = itemsRes.rows.map(item => {
      const pc = (item.proposed_changes && typeof item.proposed_changes === 'object') ? item.proposed_changes : {};
      const cr = pc.change_request || null;
      const hasChangeReqNote = !!(item.rejection_reason && item.rejection_reason.includes('YÊU CẦU BỔ SUNG'));
      const isChangeReq = (cr && cr.current_status === 'AWAITING_HR_SUPPLEMENT') ||
        (item.staging_status === 'pending_review' && (hasChangeReqNote || !!cr));
      const isResubmitted = (cr && cr.current_status === 'RESUBMITTED') || false;
      const activeRound = cr ? (cr.active_round || (cr.rounds ? cr.rounds.length : 1)) : 1;
      
      let latestAdminNote = '';
      if (cr && Array.isArray(cr.rounds) && cr.rounds.length > 0) {
        latestAdminNote = cr.rounds[cr.rounds.length - 1].admin_note || '';
      } else if (pc.request_changes_note) {
        latestAdminNote = pc.request_changes_note;
      } else if (item.rejection_reason && item.rejection_reason.includes('YÊU CẦU BỔ SUNG')) {
        latestAdminNote = item.rejection_reason.replace(/^YÊU CẦU BỔ SUNG( \(Vòng \d+\))?:\s*/i, '');
      }

      const { file_storage_path, ...safeItem } = item;

      // RBAC & Cross-Tenant Privacy (Chính sách phân quyền ADMIN thống nhất) in list endpoint
      const isAdmin = (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN');
      let safeProposedChanges = { ...pc };
      const matchedComp = safeProposedChanges.matched_record?.company_id;
      const canViewFullMatched = isAdmin;

      if (!canViewFullMatched && safeProposedChanges.matched_record) {
        safeProposedChanges.matched_record = {
          company_id: safeProposedChanges.matched_record.company_id,
          company_name: safeProposedChanges.matched_record.company_name,
          status: safeProposedChanges.matched_record.status || 'ACTIVE'
        };
      }

      const valErrors = Array.isArray(pc.validation_errors) ? pc.validation_errors : [];
      const isCrossCompDup = valErrors.some(e => e.code === 'CROSS_COMPANY_DUPLICATE') || (item.duplicate_reason && item.duplicate_reason.includes('đơn vị thành viên khác'));
      if (!canViewFullMatched && (isCrossCompDup || (matchedComp && req.user.company_id && req.user.company_id.toUpperCase() !== matchedComp.toUpperCase()))) {
        safeItem.duplicate_reason = `Số CCCD (${maskCccd(item.citizen_id)}) đã tồn tại trên hồ sơ nhân sự thuộc đơn vị thành viên khác (${matchedComp || 'khác'}). Để bảo vệ quyền riêng tư và dữ liệu liên công ty, thông tin chi tiết chỉ hiển thị với Quản trị viên. Cần quy trình điều chuyển nội bộ tập đoàn.`;
      }
      safeItem.proposed_changes = safeProposedChanges;

      return {
        ...safeItem,
        has_scan_file: !!file_storage_path,
        is_change_requested: !!isChangeReq,
        is_resubmitted: isResubmitted,
        change_request_round: activeRound,
        change_request_note: latestAdminNote,
        change_request: cr ? {
          active_round: cr.active_round,
          current_status: cr.current_status,
          round_count: Array.isArray(cr.rounds) ? cr.rounds.length : 0
        } : null
      };
    });

    return res.json({
      success: true,
      total: totalItems,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalItems / limitNum) || 1,
      stats,
      items: sanitizedItems
    });
  } catch (err) {
    console.error('Lỗi lấy danh sách hồ sơ staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Giữ lại hỗ trợ POST /staging cho các tác vụ nội bộ tương thích cũ
router.post('/staging', verifyToken, async (req, res) => {
  const batch_id = req.body?.batch_id;
  const status = req.body?.status;
  let query = `SELECT * FROM hr_employee_staging WHERE 1=1`;
  const params = [];

  if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id) {
    params.push(req.user.company_id);
    query += ` AND (company_id = $${params.length} OR company_id IS NULL)`;
  }
  if (batch_id) {
    params.push(batch_id);
    query += ` AND batch_id = $${params.length}`;
  }
  if (status) {
    params.push(status);
    query += ` AND staging_status = $${params.length}`;
  }
  query += ` ORDER BY created_at DESC LIMIT 50`;
  const result = await db.query(query, params);
  return res.json({ success: true, count: result.rows.length, items: result.rows });
});

// ----------------------------------------------------------------------------
// Helpers: Xác định mã nguyên nhân hệ thống và sinh lý do đề xuất an toàn
// ----------------------------------------------------------------------------
function determineSystemReasonCode(item) {
  if (item.suspected_duplicate === true || item.intake_mode === 'suspected_duplicate') {
    return 'DUP_CCCD_EXISTING';
  }
  if (item.company_status === 'conflict') {
    return 'COMPANY_MISMATCH';
  }
  if (item.company_status === 'unknown' || !item.company_id) {
    return 'COMPANY_UNKNOWN';
  }
  if (Array.isArray(item.missing_fields) && item.missing_fields.length > 0) {
    if (item.missing_fields.some(f => String(f).includes('citizen_id') || String(f).includes('full_name'))) {
      return 'MISSING_IDENTITY';
    }
    if (item.missing_fields.some(f => String(f).includes('salary') || String(f).includes('contract'))) {
      return 'MISSING_CONTRACT_SALARY';
    }
    return 'MISSING_REQUIRED_DATA';
  }
  return 'ADMIN_DECISION';
}

function maskCccdSafe(cccd) {
  if (!cccd) return '***';
  const str = String(cccd).trim();
  if (str.length < 6) return '***';
  return str.slice(0, 3) + '******' + str.slice(-3);
}

function buildSuggestedRejectReason(item, code) {
  const maskedCccd = maskCccdSafe(item.citizen_id);
  switch (code) {
    case 'DUP_CCCD_EXISTING':
      return `Từ chối tiếp nhận: Hồ sơ trùng số CCCD (${maskedCccd}) với nhân sự đã tồn tại trong hệ thống tập đoàn. Theo chính sách BIZ-CCCD-01, hệ thống không tạo mới bản ghi trùng lặp; vui lòng thực hiện quy trình điều chuyển nội bộ nếu cần.`;
    case 'COMPANY_MISMATCH':
      return `Từ chối tiếp nhận: Hồ sơ có dấu hiệu thuộc đơn vị khác (${item.company_id || 'đơn vị thành viên'}), không thuộc thẩm quyền tiếp nhận của đơn vị hiện tại.`;
    case 'COMPANY_UNKNOWN':
      return `Từ chối tiếp nhận: Tài liệu không có căn cứ xác định công ty thành viên trực thuộc trong hệ thống SOTRANS Hub.`;
    case 'MISSING_IDENTITY':
      return `Từ chối tiếp nhận: Thiếu thông tin định danh nhân sự bắt buộc (CCCD / Họ tên) không thể đối soát.`;
    case 'MISSING_CONTRACT_SALARY':
      return `Từ chối tiếp nhận: Hồ sơ thiếu thông tin hợp đồng và mức lương cơ bản bắt buộc.`;
    default:
      return `Từ chối tiếp nhận: Hồ sơ chưa đáp ứng tiêu chuẩn tiếp nhận nhân sự của đơn vị.`;
  }
}

function buildSuggestedChangesNote(item, code) {
  const maskedCccd = maskCccdSafe(item.citizen_id);
  switch (code) {
    case 'DUP_CCCD_EXISTING':
      return `Đề nghị HR đối soát lại số CCCD (${maskedCccd}) và kiểm tra lịch sử công tác xem nhân sự này đã từng làm việc tại đơn vị thành viên khác trong tập đoàn hay chưa.`;
    case 'COMPANY_MISMATCH':
      return `Đề nghị HR kiểm tra và xác nhận lại đơn vị công tác chính xác: tài liệu scan có thông tin liên quan đơn vị khác, cần văn bản đính kèm xác nhận điều chuyển hoặc tiếp nhận của đơn vị.`;
    case 'COMPANY_UNKNOWN':
      return `Đề nghị HR bổ sung Quyết định tuyển dụng hoặc văn bản có dấu mộc pháp nhân xác định rõ công ty thành viên trực thuộc.`;
    case 'MISSING_IDENTITY':
      return `Đề nghị HR bổ sung bản scan rõ nét 2 mặt CCCD và cập nhật đầy đủ thông tin định danh cá nhân.`;
    case 'MISSING_CONTRACT_SALARY':
      return `Đề nghị HR bổ sung Hợp đồng lao động, phụ lục lương hoặc quyết định xếp lương chính thức.`;
    default:
      if (Array.isArray(item.missing_fields) && item.missing_fields.length > 0) {
        return `Đề nghị HR rà soát và bổ sung các trường thông tin còn thiếu trong hồ sơ: ${item.missing_fields.slice(0, 5).join(', ')}.`;
      }
      return `Đề nghị HR kiểm tra lại tính đầy đủ và tính xác thực của bộ hồ sơ trước khi trình duyệt lại.`;
  }
}

// ----------------------------------------------------------------------------
// 4.1. GET /api/hoso/intake/staging/:id - Chi tiết 1 hồ sơ Staging (53 trường & OCR)
// ----------------------------------------------------------------------------
router.get('/staging/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Thiếu ID hồ sơ staging.' });

    if (req.user.role !== 'ADMIN' && req.user.role !== 'HR') {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền xem chi tiết hồ sơ.' });
    }

    const result = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: '404 Not Found: Không tìm thấy hồ sơ staging.' });
    }

    const item = result.rows[0];

    // Kiểm tra cô lập đa đơn vị (Tenant Isolation dành cho non-admin như HR)
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id && item.company_id && item.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn không có quyền truy cập hồ sơ thuộc đơn vị ${item.company_id}.`
      });
    }

    const pc = (item.proposed_changes && typeof item.proposed_changes === 'object') ? item.proposed_changes : {};
    const attachedFiles = (Array.isArray(pc.attached_files) ? pc.attached_files : []).map(f => ({
      file_id: f.file_id,
      file_name: f.file_name,
      file_size: f.file_size,
      mime_type: f.mime_type,
      uploaded_by: f.uploaded_by,
      uploaded_at: f.uploaded_at,
      download_url: `/api/hoso/intake/staging/${item.id}/file?file_id=${encodeURIComponent(f.file_id)}`
    }));

    const systemReasonCode = determineSystemReasonCode(item);
    const suggestedRejectReason = buildSuggestedRejectReason(item, systemReasonCode);
    const suggestedChangesNote = buildSuggestedChangesNote(item, systemReasonCode);

    const valErrors = Array.isArray(pc.validation_errors) ? pc.validation_errors : [];
    const isCrossCompDup = valErrors.some(e => e.code === 'CROSS_COMPANY_DUPLICATE') || (item.duplicate_reason && item.duplicate_reason.includes('đơn vị thành viên khác'));
    const isCompMismatch = valErrors.some(e => e.code === 'COMPANY_MISMATCH') || item.company_status === 'conflict' || item.intake_mode === 'company_mismatch';

    // RBAC & Cross-Tenant Privacy (Chính sách phân quyền ADMIN thống nhất): 
    // Mọi ADMIN (STL, SWC, VTX) đều có quyền xem chi tiết đối chứng để phối hợp điều chuyển nội bộ tập đoàn
    // Các vai trò khác (như HR) chỉ được xem thông tin đã làm mờ
    const isAdmin = (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN');
    let safeProposedChanges = { ...pc };
    const matchedComp = safeProposedChanges.matched_record?.company_id;
    const canViewFullMatched = isAdmin;

    if (!canViewFullMatched && safeProposedChanges.matched_record) {
      safeProposedChanges.matched_record = {
        company_id: safeProposedChanges.matched_record.company_id,
        company_name: safeProposedChanges.matched_record.company_name,
        status: safeProposedChanges.matched_record.status || 'ACTIVE'
      };
    }

    const { file_storage_path, ...safeItem } = item;

    // Sanitization: Làm mờ duplicate_reason đối với non-admin (HR) để ngăn chặn rò rỉ tên/mã nhân sự
    if (!canViewFullMatched && (isCrossCompDup || (matchedComp && req.user.company_id && req.user.company_id.toUpperCase() !== matchedComp.toUpperCase()))) {
      safeItem.duplicate_reason = `Số CCCD (${maskCccd(item.citizen_id)}) đã tồn tại trên hồ sơ nhân sự thuộc đơn vị thành viên khác (${matchedComp || 'khác'}). Để bảo vệ quyền riêng tư và dữ liệu liên công ty, thông tin chi tiết chỉ hiển thị với Quản trị viên. Cần quy trình điều chuyển nội bộ tập đoàn.`;
    }

    return res.json({
      success: true,
      item: {
        ...safeItem,
        proposed_changes: safeProposedChanges,
        has_scan_file: !!file_storage_path,
        attached_files: attachedFiles,
        change_request: pc.change_request || null,
        edit_history: pc.edit_history || [],
        system_reason_code: systemReasonCode,
        suggested_reject_reason: suggestedRejectReason,
        suggested_changes_note: suggestedChangesNote,
        validation_errors: valErrors,
        is_cross_company_duplicate: isCrossCompDup,
        is_company_mismatch: isCompMismatch
      }
    });
  } catch (err) {
    console.error('Lỗi lấy chi tiết hồ sơ staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 4.2. GET /api/hoso/intake/staging/:id/file - Xem trước / tải tệp tài liệu scan gốc hoặc tệp bổ sung an toàn
// ----------------------------------------------------------------------------
router.get('/staging/:id/file', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { file_id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: 'Thiếu ID hồ sơ staging.' });

    if (req.user.role !== 'ADMIN' && req.user.role !== 'HR') {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền truy cập tệp tài liệu.' });
    }

    const result = await db.query(
      `SELECT id, file_name, file_storage_path, mime_type, company_id, uploaded_by, proposed_changes FROM hr_employee_staging WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: '404 Not Found: Không tìm thấy hồ sơ staging.' });
    }

    const item = result.rows[0];

    // Kiểm tra cô lập đa đơn vị (Tenant Isolation dành cho non-admin như HR)
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id && item.company_id && item.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn không có quyền truy cập tài liệu thuộc đơn vị ${item.company_id}.`
      });
    }

    // Trường hợp 1: Tải tệp đính kèm bổ sung theo file_id
    if (file_id) {
      const pc = (item.proposed_changes && typeof item.proposed_changes === 'object') ? item.proposed_changes : {};
      const attached = Array.isArray(pc.attached_files) ? pc.attached_files : [];
      const fileMeta = attached.find(f => String(f.file_id) === String(file_id));
      if (!fileMeta || !fileMeta.file_storage_path || !fs.existsSync(fileMeta.file_storage_path)) {
        return res.status(404).json({ success: false, error: '404 Not Found: Tệp tài liệu bổ sung không tồn tại trên hệ thống lưu trữ.' });
      }

      const mime = fileMeta.mime_type || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(fileMeta.file_name || 'attached_doc'))}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      return fs.createReadStream(fileMeta.file_storage_path).pipe(res);
    }

    // Trường hợp 2: Tệp scan gốc
    let targetPath = null;
    if (item.file_storage_path && fs.existsSync(item.file_storage_path)) {
      targetPath = item.file_storage_path;
    } else {
      const safeName = path.basename(item.file_name || '');
      const candidates = [
        path.join('/app/uploads/staging', safeName),
        path.join('/app/uploads', safeName),
        path.join('/app/chat-files', safeName),
        path.resolve(__dirname, '..', 'uploads', 'staging', safeName),
        path.resolve(__dirname, '..', 'uploads', safeName),
        path.resolve(__dirname, '..', '..', 'files', safeName)
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          targetPath = p;
          break;
        }
      }
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
      return res.status(404).json({
        success: false,
        error: '404 Not Found: Tệp tài liệu scan gốc không tồn tại trên hệ thống lưu trữ máy chủ (dữ liệu OCR đã được lưu trữ trong CSDL).'
      });
    }

    const mime = item.mime_type || (targetPath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(item.file_name || 'document.pdf'))}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const stream = fs.createReadStream(targetPath);
    stream.pipe(res);
  } catch (err) {
    console.error('Lỗi lấy tệp tài liệu staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 4.3. POST /api/hoso/intake/reject & /staging/:id/reject - ADMIN Từ chối hồ sơ kèm lý do
// ----------------------------------------------------------------------------
router.post(['/reject', '/staging/:id/reject'], verifyToken, async (req, res) => {
  try {
    const canApprove = await hasPermission(req.user.role, 'hr.intake.approve');
    if (!canApprove) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Tài khoản không có quyền từ chối phê duyệt hồ sơ.' });
    }

    const { staging_id, staging_ids, id, reason, rejection_reason } = req.body;
    let rawIds = staging_ids;
    if (!rawIds) {
      const singleId = req.params.id || staging_id || id;
      if (singleId) rawIds = [singleId];
      else rawIds = [];
    }
    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp ID hồ sơ cần từ chối.' });
    }

    const cleanReason = String(reason || rejection_reason || '').trim();
    if (!cleanReason || cleanReason.length < 3) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập lý do từ chối hồ sơ (tối thiểu 3 ký tự).' });
    }

    const checkRes = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    const items = checkRes.rows;
    if (items.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ staging tương ứng.' });
    }

    // Company scope check (Non-admin như HR chỉ được thao tác hồ sơ công ty mình)
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id) {
      for (const it of items) {
        if (it.company_id && it.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
          return res.status(403).json({
            success: false,
            error: `403 Forbidden: Tài khoản đơn vị ${req.user.company_id} không có quyền thao tác trên hồ sơ của đơn vị khác (${it.company_id}).`
          });
        }
      }
    }

    // Check if already approved
    const alreadyApproved = items.filter(r => r.staging_status === 'approved');
    if (alreadyApproved.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Không thể từ chối hồ sơ đã được phê duyệt chính thức (${alreadyApproved.map(d => d.file_name || d.full_name).join(', ')}).`
      });
    }

    // Determine system reason code on backend (independent of client)
    const systemReasonCode = determineSystemReasonCode(items[0]);

    await db.query(
      `UPDATE hr_employee_staging 
       SET staging_status = 'rejected',
           rejection_reason = $1,
           reviewer_username = $2,
           reviewed_at = NOW(),
           updated_at = NOW(),
           proposed_changes = jsonb_set(
             COALESCE(proposed_changes, '{}'::jsonb),
             '{rejection_code}',
             to_jsonb($3::text)
           )
       WHERE id = ANY($4::uuid[])`,
      [cleanReason, req.user.username, systemReasonCode, ids]
    );

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_REJECTED',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        staging_ids: ids,
        count: items.length,
        system_reason_code: systemReasonCode,
        decision_reason: cleanReason,
        reviewer_username: req.user.username
      }
    });

    return res.json({
      success: true,
      action: 'rejected',
      count: items.length,
      system_reason_code: systemReasonCode,
      reply: `Đã từ chối ${items.length} hồ sơ. Mã nguyên nhân: [${systemReasonCode}]. Lý do: "${cleanReason}".`
    });
  } catch (err) {
    console.error('Lỗi từ chối hồ sơ staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 4.3.1. POST /api/hoso/intake/staging/:id/clone - Clone hồ sơ từ chối để tạo bản ghi mới
// ----------------------------------------------------------------------------
router.post('/staging/:id/clone', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const fetchRes = await db.query(`SELECT * FROM hr_employee_staging WHERE id = $1`, [id]);
    if (fetchRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ staging.' });
    }
    const old = fetchRes.rows[0];

    const cloneRes = await db.query(`
      INSERT INTO hr_employee_staging (
        batch_id,
        file_name,
        file_storage_path,
        file_size,
        mime_type,
        full_name,
        citizen_id,
        employee_code,
        date_of_birth,
        gender,
        job_title,
        department,
        email,
        phone_number,
        recruitment_decision_no,
        employment_start_date,
        base_salary,
        company_id,
        company_status,
        company_evidence,
        staging_status,
        extracted_data,
        uploaded_by,
        uploaded_by_user_id,
        intake_mode,
        proposed_changes,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
        'pending_review', $20, $21, $22, 'new_profile', $23::jsonb, NOW(), NOW()
      ) RETURNING id;
    `, [
      crypto.randomUUID(),
      old.file_name,
      old.file_storage_path,
      old.file_size,
      old.mime_type,
      old.full_name,
      old.citizen_id,
      old.date_of_birth,
      old.gender,
      old.job_title,
      old.department,
      old.email,
      old.phone_number,
      old.recruitment_decision_no,
      old.employment_start_date,
      old.base_salary,
      old.company_id,
      old.company_status,
      old.company_evidence,
      old.extracted_data || '{}',
      req.user.username,
      req.user.user_id,
      JSON.stringify({ cloned_from_staging_id: old.id, cloned_at: new Date().toISOString() })
    ]);

    const newId = cloneRes.rows[0].id;

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_STAGING_CLONED',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: { original_staging_id: old.id, new_staging_id: newId }
    });

    return res.status(201).json({
      success: true,
      message: 'Hồ sơ đã được nhân bản thành công sang bản ghi mới (pending_review) để chỉnh sửa và nộp lại.',
      staging_id: newId,
      cloned_id: newId
    });
  } catch (err) {
    console.error('Lỗi clone staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 4.4. POST /api/hoso/intake/request-changes - ADMIN Yêu cầu bổ sung thông tin hồ sơ (Multi-Round)
// ----------------------------------------------------------------------------
router.post('/request-changes', verifyToken, async (req, res) => {
  try {
    const canApprove = await hasPermission(req.user.role, 'hr.intake.approve');
    if (!canApprove) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Tài khoản không có quyền yêu cầu bổ sung thông tin hồ sơ.' });
    }

    const { staging_id, staging_ids, id, note } = req.body;
    let rawIds = staging_ids;
    if (!rawIds) {
      if (staging_id) rawIds = [staging_id];
      else if (id) rawIds = [id];
      else rawIds = [];
    }
    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp ID hồ sơ cần yêu cầu bổ sung.' });
    }

    const cleanNote = String(note || '').trim();
    if (!cleanNote || cleanNote.length < 3) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập nội dung yêu cầu bổ sung (tối thiểu 3 ký tự).' });
    }

    const checkRes = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [ids]
    );

    const items = checkRes.rows;
    if (items.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ staging tương ứng.' });
    }

    // Company scope check (Non-admin như HR chỉ được thao tác hồ sơ công ty mình)
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id) {
      for (const it of items) {
        if (it.company_id && it.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
          return res.status(403).json({
            success: false,
            error: `403 Forbidden: Tài khoản đơn vị ${req.user.company_id} không có quyền thao tác trên hồ sơ của đơn vị khác (${it.company_id}).`
          });
        }
      }
    }

    // Check if already approved
    const alreadyApproved = items.filter(r => r.staging_status === 'approved');
    if (alreadyApproved.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Không thể yêu cầu bổ sung cho hồ sơ đã được phê duyệt chính thức (${alreadyApproved.map(d => d.file_name || d.full_name).join(', ')}).`
      });
    }

    // Determine system reason code on backend (independent of client)
    const systemReasonCode = determineSystemReasonCode(items[0]);

    // Cập nhật từng hồ sơ theo cơ chế Multi-Round, bảo toàn 100% lịch sử các vòng trước
    for (const it of items) {
      let proposedChanges = (it.proposed_changes && typeof it.proposed_changes === 'object') ? it.proposed_changes : {};
      let changeRequest = proposedChanges.change_request || { active_round: 0, rounds: [] };
      const currentRounds = Array.isArray(changeRequest.rounds) ? changeRequest.rounds : [];
      const nextRound = (changeRequest.active_round || currentRounds.length || 0) + 1;

      const newRoundObj = {
        round: nextRound,
        requested_at: new Date().toISOString(),
        requested_by: req.user.username,
        system_reason_code: systemReasonCode,
        admin_note: cleanNote,
        status: 'AWAITING_HR_SUPPLEMENT',
        hr_response: null
      };

      changeRequest.active_round = nextRound;
      changeRequest.current_status = 'AWAITING_HR_SUPPLEMENT';
      changeRequest.rounds = [...currentRounds, newRoundObj];

      proposedChanges.change_request = changeRequest;
      proposedChanges.request_changes_note = cleanNote;
      proposedChanges.request_changes_code = systemReasonCode;

      await db.query(
        `UPDATE hr_employee_staging 
         SET staging_status = 'pending_review',
             rejection_reason = $1,
             reviewer_username = $2,
             reviewed_at = NOW(),
             updated_at = NOW(),
             proposed_changes = $3::jsonb
         WHERE id = $4`,
        [`YÊU CẦU BỔ SUNG (Vòng ${nextRound}): ${cleanNote}`, req.user.username, JSON.stringify(proposedChanges), it.id]
      );
    }

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_CHANGES_REQUESTED',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        staging_ids: ids,
        count: items.length,
        system_reason_code: systemReasonCode,
        decision_note: cleanNote,
        reviewer_username: req.user.username
      }
    });

    return res.json({
      success: true,
      action: 'changes_requested',
      count: items.length,
      system_reason_code: systemReasonCode,
      reply: `Đã gửi yêu cầu bổ sung thông tin cho ${items.length} hồ sơ. Mã nguyên nhân: [${systemReasonCode}]. Hồ sơ đã chuyển về trạng thái pending_review để HR chỉnh sửa, bổ sung.`
    });
  } catch (err) {
    console.error('Lỗi yêu cầu bổ sung hồ sơ staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 4.5. PUT /api/hoso/intake/staging/:id - HR / ADMIN Chỉnh sửa dữ liệu & Bổ sung tài liệu
// ----------------------------------------------------------------------------
router.put('/staging/:id', verifyToken, upload.array('supplementary_files', 5), async (req, res) => {
  const stagingDir = path.resolve(__dirname, '..', 'uploads', 'staging');
  const newlyCreatedFilesOnDisk = [];

  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Thiếu ID hồ sơ staging.' });

    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'HR') {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền chỉnh sửa hồ sơ staging.' });
    }

    const checkRes = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ staging.' });
    }

    const item = checkRes.rows[0];

    // Kiểm tra cô lập đa đơn vị (Tenant Isolation dành cho non-admin như HR)
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id && item.company_id && item.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn không có quyền chỉnh sửa hồ sơ thuộc đơn vị ${item.company_id}.`
      });
    }

    if (item.staging_status === 'approved') {
      return res.status(400).json({ success: false, error: 'Hồ sơ đã được phê duyệt chính thức, không thể chỉnh sửa qua staging.' });
    }
    if (item.staging_status === 'rejected') {
      return res.status(400).json({ success: false, error: 'Hồ sơ đã bị từ chối tiếp nhận.' });
    }

    // 1. Phân giải danh sách trường cần cập nhật
    let fieldsToUpdate = {};
    if (req.body.fields) {
      if (typeof req.body.fields === 'string') {
        try { fieldsToUpdate = JSON.parse(req.body.fields); } catch (e) { fieldsToUpdate = {}; }
      } else if (typeof req.body.fields === 'object') {
        fieldsToUpdate = req.body.fields;
      }
    } else {
      const controlKeys = ['edit_reason', 'reason', 'note', 'hr_note', 'supplementary_files'];
      for (const [k, v] of Object.entries(req.body)) {
        if (!controlKeys.includes(k) && typeof v === 'string') {
          fieldsToUpdate[k] = v;
        }
      }
    }

    // 2. Kiểm tra Field Allowlist theo vai trò (HR vs ADMIN)
    const isHr = (req.user.role === 'HR');
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(req.user.role);

    if (isHr) {
      if (fieldsToUpdate.citizen_id !== undefined && String(fieldsToUpdate.citizen_id).trim() !== String(item.citizen_id || '').trim()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: HR không được phép tự ý thay đổi số CCCD (${item.citizen_id} -> ${fieldsToUpdate.citizen_id}). Vui lòng đính kèm tài liệu giải trình và yêu cầu ADMIN xác minh.`
        });
      }
      if (fieldsToUpdate.employee_code !== undefined && String(fieldsToUpdate.employee_code).trim() !== String(item.employee_code || '').trim()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: HR không được phép chỉnh sửa mã nhân viên. Hệ thống tự động cấp mã theo chuẩn khi ADMIN phê duyệt.`
        });
      }
      if (fieldsToUpdate.employee_id !== undefined && String(fieldsToUpdate.employee_id).trim() !== String(item.employee_code || '').trim()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: HR không được phép chỉnh sửa mã nhân viên.`
        });
      }
      if (fieldsToUpdate.company_id !== undefined && String(fieldsToUpdate.company_id).trim().toUpperCase() !== String(item.company_id || '').trim().toUpperCase()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: HR không được phép thay đổi công ty trực thuộc.`
        });
      }
    }

    if (isAdmin) {
      const editReason = String(req.body.edit_reason || req.body.reason || '').trim();
      if (!editReason || editReason.length < 3) {
        return res.status(400).json({
          success: false,
          error: 'Quản trị viên bắt buộc nhập lý do điều chỉnh thông tin hồ sơ (tối thiểu 3 ký tự).'
        });
      }

      if (fieldsToUpdate.citizen_id !== undefined && String(fieldsToUpdate.citizen_id).trim() !== String(item.citizen_id || '').trim()) {
        const newCitizen = String(fieldsToUpdate.citizen_id).replace(/\D/g, '');
        if (newCitizen.length !== 9 && newCitizen.length !== 12) {
          return res.status(400).json({
            success: false,
            error: `Số CCCD mới (${fieldsToUpdate.citizen_id}) không hợp lệ (phải gồm 9 hoặc 12 chữ số).`
          });
        }
        const dupCheck = await db.query(
          `SELECT employee_code, employee_name AS full_name, company_id FROM employees WHERE citizen_id = $1 LIMIT 1`,
          [newCitizen]
        );
        if (dupCheck.rows.length > 0) {
          const emp = dupCheck.rows[0];
          return res.status(400).json({
            success: false,
            error: `Cảnh báo BIZ-CCCD-01: Số CCCD (${newCitizen}) đã tồn tại trên nhân sự chính thức "${emp.full_name}" (Mã: ${emp.employee_code}, Đơn vị: ${emp.company_id}). Không thể gán số CCCD trùng lặp.`
          });
        }
      }

      if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id && fieldsToUpdate.company_id && fieldsToUpdate.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: Tài khoản đơn vị ${req.user.company_id} không thể đổi công ty sang ${fieldsToUpdate.company_id}.`
        });
      }
    }

    // 3. Xử lý tệp đính kèm bổ sung
    const savedFiles = [];
    if (!fs.existsSync(stagingDir)) {
      fs.mkdirSync(stagingDir, { recursive: true });
    }

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileId = crypto.randomUUID();
        const safeBase = path.basename(file.originalname || 'supplement.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
        const diskFileName = `${item.id}_supp_${fileId.slice(0, 8)}_${safeBase}`;
        const diskFilePath = path.join(stagingDir, diskFileName);
        fs.writeFileSync(diskFilePath, file.buffer);
        newlyCreatedFilesOnDisk.push(diskFilePath);

        savedFiles.push({
          file_id: fileId,
          file_name: file.originalname,
          file_size: file.size,
          mime_type: file.mimetype,
          file_storage_path: diskFilePath,
          uploaded_by: req.user.username,
          uploaded_at: new Date().toISOString()
        });
      }
    }

    // 4. Áp dụng cập nhật dữ liệu và ghi lịch sử Before/After Diff
    let proposedChanges = (item.proposed_changes && typeof item.proposed_changes === 'object') ? item.proposed_changes : {};
    let extractedData = (item.extracted_data && typeof item.extracted_data === 'object') ? item.extracted_data : {};
    if (typeof extractedData === 'string') {
      try { extractedData = JSON.parse(extractedData); } catch (e) { extractedData = {}; }
    }

    // Bảo toàn dữ liệu OCR gốc trước lần chỉnh sửa đầu tiên
    if (!proposedChanges._original_ocr) {
      proposedChanges._original_ocr = { ...extractedData };
    }

    const diff = {};
    const changedFields = [];
    for (const [key, val] of Object.entries(fieldsToUpdate)) {
      const oldVal = (extractedData[key] !== undefined) ? extractedData[key] : (item[key] || '');
      if (String(oldVal || '').trim() !== String(val || '').trim()) {
        diff[key] = { old: oldVal, new: val };
        changedFields.push(key);
        extractedData[key] = val;
      }
    }

    // Ghi vào edit_history
    if (changedFields.length > 0 || savedFiles.length > 0) {
      const editHistory = Array.isArray(proposedChanges.edit_history) ? proposedChanges.edit_history : [];
      editHistory.push({
        edited_at: new Date().toISOString(),
        editor_username: req.user.username,
        editor_role: req.user.role,
        reason: req.body.edit_reason || req.body.reason || req.body.hr_note || (isHr ? 'HR cập nhật bổ sung hồ sơ' : 'ADMIN hiệu chỉnh hồ sơ'),
        changed_fields: changedFields,
        diff: diff,
        attached_files_count: savedFiles.length
      });
      proposedChanges.edit_history = editHistory;
    }

    // Gộp tệp đính kèm bổ sung
    if (savedFiles.length > 0) {
      const attachedFiles = Array.isArray(proposedChanges.attached_files) ? proposedChanges.attached_files : [];
      proposedChanges.attached_files = [...attachedFiles, ...savedFiles];
    }

    // Cập nhật các cột trực tiếp trên bảng hr_employee_staging
    const colUpdates = [];
    const colParams = [];
    let pIdx = 1;

    const columnMap = {
      'full_name': 'full_name',
      'citizen_id': 'citizen_id',
      'employee_code': 'employee_code',
      'employee_id': 'employee_code',
      'date_of_birth': 'date_of_birth',
      'gender': 'gender',
      'job_title': 'job_title',
      'department': 'department',
      'department_staffing_plan': 'department',
      'email': 'email',
      'phone_number': 'phone_number',
      'base_salary': 'base_salary',
      'company_id': 'company_id',
      'recruitment_decision_no': 'recruitment_decision_no',
      'employment_start_date': 'employment_start_date'
    };

    const updatedCols = new Set();
    for (const [fKey, colName] of Object.entries(columnMap)) {
      if (fieldsToUpdate[fKey] !== undefined && !updatedCols.has(colName)) {
        updatedCols.add(colName);
        colUpdates.push(`${colName} = $${pIdx++}`);
        colParams.push(fieldsToUpdate[fKey]);
      }
    }

    // Tự động tái thẩm tra (Re-validation) khi thông tin công ty hoặc định danh thay đổi (ngăn chặn Stale Metadata)
    const hasIdentityOrCompanyChange = changedFields.some(f => 
      ['company_id', 'citizen_id', 'full_name', 'department', 'department_staffing_plan', 'job_title', 'recruitment_decision_no'].includes(f)
    ) || fieldsToUpdate.company_id !== undefined || fieldsToUpdate.citizen_id !== undefined;

    if (hasIdentityOrCompanyChange) {
      const revalProfile = {
        ...extractedData,
        company_id: fieldsToUpdate.company_id !== undefined ? fieldsToUpdate.company_id : (extractedData.company_id || item.company_id),
        citizen_id: fieldsToUpdate.citizen_id !== undefined ? fieldsToUpdate.citizen_id : (extractedData.citizen_id || item.citizen_id),
        full_name: fieldsToUpdate.full_name !== undefined ? fieldsToUpdate.full_name : (extractedData.full_name || item.full_name),
        department: fieldsToUpdate.department !== undefined ? fieldsToUpdate.department : (extractedData.department || item.department),
        department_staffing_plan: fieldsToUpdate.department_staffing_plan !== undefined ? fieldsToUpdate.department_staffing_plan : (extractedData.department_staffing_plan || item.department),
        job_title: fieldsToUpdate.job_title !== undefined ? fieldsToUpdate.job_title : (extractedData.job_title || item.job_title),
        recruitment_decision_no: fieldsToUpdate.recruitment_decision_no !== undefined ? fieldsToUpdate.recruitment_decision_no : (extractedData.recruitment_decision_no || item.recruitment_decision_no)
      };

      const rawText = (extractedData && extractedData._raw_text) || '';
      const compDetection = detectCompany(revalProfile, rawText);
      const cccdInfo = standardizeAndValidateCccd(revalProfile.citizen_id);

      const reval = await validateStagingProfile(revalProfile, req.user, compDetection, cccdInfo);

      colUpdates.push(`company_status = $${pIdx++}`);
      colParams.push(reval.company_status || 'unknown');

      colUpdates.push(`intake_mode = $${pIdx++}`);
      colParams.push(reval.intake_mode);

      colUpdates.push(`suspected_duplicate = $${pIdx++}`);
      colParams.push(reval.suspected_duplicate);

      colUpdates.push(`duplicate_reason = $${pIdx++}`);
      colParams.push(reval.duplicate_reason);

      if (reval.missing_fields) {
        colUpdates.push(`missing_fields = $${pIdx++}`);
        colParams.push(reval.missing_fields);
      }

      proposedChanges.duplicate_classification = reval.duplicate_classification;
      proposedChanges.validation_errors = reval.validation_errors;
      if (reval.proposed_changes && reval.proposed_changes.matched_record) {
        proposedChanges.matched_record = reval.proposed_changes.matched_record;
      }
    }

    colUpdates.push(`extracted_data = $${pIdx++}::jsonb`);
    colParams.push(JSON.stringify(extractedData));

    colUpdates.push(`proposed_changes = $${pIdx++}::jsonb`);
    colParams.push(JSON.stringify(proposedChanges));

    colUpdates.push(`version = COALESCE(version, 1) + 1`);
    colUpdates.push(`updated_at = NOW()`);

    colParams.push(item.id);
    const idParamIdx = pIdx++;
    let updateSql = `UPDATE hr_employee_staging SET ${colUpdates.join(', ')} WHERE id = $${idParamIdx}`;

    // Optimistic Concurrency Control (OCC): Chặn Lost Update khi có 2 request đồng thời
    const expectedVersion = req.body.expected_version || req.body.version;
    if (expectedVersion !== undefined && expectedVersion !== null && !isNaN(parseInt(expectedVersion, 10))) {
      colParams.push(parseInt(expectedVersion, 10));
      updateSql += ` AND (version IS NULL OR version = $${pIdx++})`;
    }

    updateSql += ` RETURNING *`;
    const updateRes = await db.query(updateSql, colParams);
    if (updateRes.rows.length === 0) {
      return res.status(409).json({
        success: false,
        error: '409 Conflict: Hồ sơ đã được cập nhật bởi một phiên làm việc khác (phiên bản CSDL không khớp). Vui lòng tải lại dữ liệu mới nhất trước khi chỉnh sửa.'
      });
    }
    const updatedRow = updateRes.rows[0];

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_STAGING_EDITED',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        staging_id: item.id,
        editor_role: req.user.role,
        changed_fields: changedFields,
        files_attached_count: savedFiles.length,
        diff: diff
      }
    });

    const { file_storage_path, ...safeUpdatedItem } = updatedRow;
    const safeAttachedFiles = (proposedChanges.attached_files || []).map(f => ({
      file_id: f.file_id,
      file_name: f.file_name,
      file_size: f.file_size,
      mime_type: f.mime_type,
      uploaded_by: f.uploaded_by,
      uploaded_at: f.uploaded_at,
      download_url: `/api/hoso/intake/staging/${item.id}/file?file_id=${encodeURIComponent(f.file_id)}`
    }));

    return res.json({
      success: true,
      item: {
        ...safeUpdatedItem,
        attached_files: safeAttachedFiles,
        change_request: proposedChanges.change_request || null,
        edit_history: proposedChanges.edit_history || []
      },
      changed_fields: changedFields,
      diff: diff,
      attached_files_count: savedFiles.length,
      reply: 'Đã cập nhật thông tin hồ sơ staging thành công.'
    });

  } catch (err) {
    // Dọn dẹp tệp rác nếu thao tác CSDL gặp lỗi
    newlyCreatedFilesOnDisk.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    console.error('Lỗi cập nhật hồ sơ staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 4.6. POST /api/hoso/intake/staging/:id/resubmit - HR Gửi lại hồ sơ sau khi bổ sung
// ----------------------------------------------------------------------------
router.post('/staging/:id/resubmit', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { note, hr_note, changed_fields } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'Thiếu ID hồ sơ staging.' });

    if (req.user.role !== 'ADMIN' && req.user.role !== 'HR') {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền gửi lại hồ sơ.' });
    }

    const result = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ staging.' });
    }

    const item = result.rows[0];

    // Tenant check (Non-admin như HR chỉ thao tác trong công ty mình)
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id && item.company_id && item.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn không có quyền thao tác trên hồ sơ thuộc đơn vị ${item.company_id}.`
      });
    }

    // Status checks
    if (item.staging_status === 'pending_approval') {
      return res.status(400).json({
        success: false,
        error: 'Hồ sơ đã ở trạng thái chờ phê duyệt (pending_approval), không cần gửi lại.'
      });
    }
    if (item.staging_status === 'approved') {
      return res.status(400).json({
        success: false,
        error: 'Hồ sơ đã được phê duyệt chính thức, không thể gửi lại.'
      });
    }
    if (item.staging_status === 'rejected') {
      return res.status(400).json({
        success: false,
        error: 'Hồ sơ đã bị từ chối tiếp nhận.'
      });
    }
    if (item.staging_status !== 'pending_review') {
      return res.status(400).json({
        success: false,
        error: `Trạng thái hồ sơ (${item.staging_status}) không hợp lệ để gửi lại phê duyệt.`
      });
    }

    // Anti-double submission check (Idempotency)
    let proposedChanges = (item.proposed_changes && typeof item.proposed_changes === 'object') ? item.proposed_changes : {};
    let changeRequest = proposedChanges.change_request || null;
    if (changeRequest && changeRequest.current_status === 'RESUBMITTED') {
      return res.status(400).json({
        success: false,
        error: 'Hồ sơ đã được gửi lại cho Quản trị viên trước đó và đang chờ xem xét. Không thể gửi lặp lại.'
      });
    }

    // Kiểm tra tính đầy đủ của thông tin định danh
    if (!item.full_name || !String(item.full_name).trim()) {
      return res.status(400).json({ success: false, error: 'Hồ sơ thiếu Họ và tên nhân viên, không thể gửi duyệt.' });
    }
    const cleanCitizen = item.citizen_id ? String(item.citizen_id).replace(/\D/g, '') : '';
    if (!cleanCitizen || (cleanCitizen.length !== 9 && cleanCitizen.length !== 12)) {
      return res.status(400).json({ success: false, error: 'Số CCCD không hợp lệ (bắt buộc gồm 9 hoặc 12 chữ số).' });
    }
    if (!item.company_id || !['STL', 'SWC', 'VTX'].includes(item.company_id.toUpperCase())) {
      return res.status(400).json({ success: false, error: 'Hồ sơ chưa có công ty trực thuộc hợp lệ (STL, SWC, VTX).' });
    }

    // Re-check CCCD against employees table (BIZ-CCCD-01)
    const dupCheck = await db.query(
      `SELECT employee_code, employee_name AS full_name, company_id FROM employees WHERE citizen_id = $1 LIMIT 1`,
      [cleanCitizen]
    );
    if (dupCheck.rows.length > 0) {
      const emp = dupCheck.rows[0];
      return res.status(400).json({
        success: false,
        error: `Chính sách BIZ-CCCD-01: Số CCCD (${cleanCitizen}) trùng với nhân sự chính thức "${emp.full_name}" (Mã: ${emp.employee_code}, Đơn vị: ${emp.company_id}). Không thể trình duyệt hồ sơ trùng CCCD.`
      });
    }

    // Record HR response in current round
    const resubmitNote = String(hr_note || note || '').trim() || 'HR đã hoàn tất cập nhật bổ sung hồ sơ và gửi lại Admin';
    if (!changeRequest) {
      changeRequest = {
        active_round: 1,
        current_status: 'RESUBMITTED',
        rounds: [{
          round: 1,
          requested_at: item.reviewed_at || item.created_at,
          requested_by: item.reviewer_username || 'system',
          system_reason_code: 'ADMIN_DECISION',
          admin_note: item.rejection_reason || 'Yêu cầu bổ sung thông tin hồ sơ',
          status: 'RESUBMITTED',
          hr_response: {
            submitted_at: new Date().toISOString(),
            submitted_by: req.user.username,
            note: resubmitNote,
            changed_fields: Array.isArray(changed_fields) ? changed_fields : []
          }
        }]
      };
    } else {
      changeRequest.current_status = 'RESUBMITTED';
      const rounds = Array.isArray(changeRequest.rounds) ? changeRequest.rounds : [];
      const currentRoundIdx = rounds.findIndex(r => r.round === changeRequest.active_round);
      if (currentRoundIdx >= 0) {
        rounds[currentRoundIdx].status = 'RESUBMITTED';
        rounds[currentRoundIdx].hr_response = {
          submitted_at: new Date().toISOString(),
          submitted_by: req.user.username,
          note: resubmitNote,
          changed_fields: Array.isArray(changed_fields) ? changed_fields : []
        };
      } else {
        rounds.push({
          round: changeRequest.active_round || (rounds.length + 1),
          requested_at: item.reviewed_at || new Date().toISOString(),
          requested_by: item.reviewer_username || 'admin',
          system_reason_code: 'ADMIN_DECISION',
          admin_note: item.rejection_reason || 'Yêu cầu bổ sung',
          status: 'RESUBMITTED',
          hr_response: {
            submitted_at: new Date().toISOString(),
            submitted_by: req.user.username,
            note: resubmitNote,
            changed_fields: Array.isArray(changed_fields) ? changed_fields : []
          }
        });
      }
      changeRequest.rounds = rounds;
    }

    proposedChanges.change_request = changeRequest;

    await db.query(
      `UPDATE hr_employee_staging 
       SET staging_status = 'pending_approval',
           rejection_reason = NULL,
           proposed_changes = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(proposedChanges), item.id]
    );

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_INTAKE_RESUBMITTED',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        staging_id: item.id,
        round: changeRequest.active_round,
        hr_note: resubmitNote,
        submitted_by: req.user.username
      }
    });

    return res.json({
      success: true,
      action: 'resubmitted',
      round: changeRequest.active_round,
      reply: `Đã gửi lại hồ sơ cho Quản trị viên phê duyệt thành công (Vòng ${changeRequest.active_round}).`
    });
  } catch (err) {
    console.error('Lỗi gửi lại hồ sơ staging:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// 4.7. POST /api/hoso/intake/staging/:id/retry-ocr - Chạy lại OCR Pipeline trên tệp scan gốc
// ----------------------------------------------------------------------------
router.post('/staging/:id/retry-ocr', verifyToken, upload.any(), uploadRateLimiter, async (req, res) => {
  const { id } = req.params;
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id));
  if (!isUUID) {
    return res.status(400).json({ success: false, error: 'ID hồ sơ staging không hợp lệ.' });
  }

  if (req.user.role !== 'ADMIN' && req.user.role !== 'HR') {
    return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền chạy lại OCR.' });
  }

  try {
    const stagingRes = await db.query('SELECT * FROM hr_employee_staging WHERE id = $1', [id]);
    if (stagingRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ staging.' });
    }
    const staging = stagingRes.rows[0];

    // Không cho phép retry nếu hồ sơ đã được duyệt vào master data
    if (staging.staging_status === 'approved') {
      return res.status(400).json({
        success: false,
        error: 'Hồ sơ đã được phê duyệt chính thức vào Master Data, không thể chạy lại OCR để tránh xung đột dữ liệu.'
      });
    }

    // Tenant check: HR chỉ được retry hồ sơ thuộc công ty của mình
    if (req.user.role !== 'ADMIN' && staging.company_id && staging.company_id !== req.user.company_id) {
      return res.status(403).json({
        success: false,
        error: `Bạn không có quyền thao tác trên hồ sơ của đơn vị ${staging.company_id}.`
      });
    }

    // Lấy buffer tệp scan để chạy OCR
    let fileBuffer = null;
    let fileName = staging.file_name || 'document.pdf';
    let mimeType = staging.mime_type || 'application/pdf';

    const uploadedFiles = req.files || [];
    if (uploadedFiles.length > 0) {
      fileBuffer = uploadedFiles[0].buffer;
      fileName = uploadedFiles[0].originalname;
      mimeType = uploadedFiles[0].mimetype;
    } else if (staging.file_storage_path && fs.existsSync(staging.file_storage_path)) {
      fileBuffer = fs.readFileSync(staging.file_storage_path);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Không tìm thấy tệp scan gốc trên máy chủ và không có tệp mới đính kèm để chạy lại OCR.'
      });
    }

    // Ủy quyền toàn bộ trích xuất OCR sang n8n Webhook
    const { forwardUploadToN8n } = require('../services/n8nLifecycleProxy');
    const n8nRes = await forwardUploadToN8n(req, [{ originalname: fileName, mimetype: mimeType, buffer: fileBuffer }], {
      company_id: staging.company_id,
      batch_id: staging.batch_id,
      event_type: 'HR_UPLOAD'
    });

    if (n8nRes.status !== 200) {
      return res.status(n8nRes.status).json(n8nRes.body);
    }

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_STAGING_RETRY_OCR',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        staging_id: id,
        batch_id: staging.batch_id
      }
    });

    return res.json({
      success: true,
      message: 'Chạy lại OCR qua n8n thành công!',
      staging_id: id,
      result: n8nRes.body
    });

  } catch (err) {
    console.error('Lỗi khi chạy lại OCR staging:', err);
    return res.status(500).json({ success: false, error: 'Lỗi khi chạy lại OCR: ' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 5. GET /api/hoso/intake/export - Xuất hồ sơ nhân sự sang Excel chuẩn 53 cột
// ----------------------------------------------------------------------------
router.get('/export', verifyToken, async (req, res) => {
  try {
    const { scope = 'profiles', batch_id, company_id, department, status, include_metadata } = req.query;

    let rows = [];

    if (scope === 'staging' || batch_id) {
      let whereClauses = [];
      let params = [];
      if (batch_id) {
        params.push(batch_id);
        whereClauses.push(`batch_id = $${params.length}`);
      }
      if (company_id && company_id !== 'ALL') {
        params.push(company_id);
        whereClauses.push(`company_id = $${params.length}`);
      }
      if (req.user.role !== 'ADMIN' && req.user.company_id) {
        params.push(req.user.company_id);
        whereClauses.push(`company_id = $${params.length}`);
      }
      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const stagingRes = await db.query(`SELECT * FROM hr_employee_staging ${whereSql} ORDER BY created_at DESC`, params);

      rows = stagingRes.rows.map(r => {
        const ext = typeof r.extracted_data === 'string' ? JSON.parse(r.extracted_data) : (r.extracted_data || {});
        return {
          ...ext,
          employee_id: r.employee_code || ext.employee_id || '',
          full_name: r.full_name || ext.full_name || '',
          citizen_id: r.citizen_id || ext.citizen_id || '',
          date_of_birth: r.date_of_birth || ext.date_of_birth || '',
          gender: r.gender || ext.gender || '',
          job_title: r.job_title || ext.job_title || '',
          department_staffing_plan: r.department || ext.department_staffing_plan || '',
          email: r.email || ext.email || '',
          phone_number: r.phone_number || ext.phone_number || '',
          base_salary: r.base_salary || ext.base_salary || '',
          recruitment_decision_no: r.recruitment_decision_no || ext.recruitment_decision_no || '',
          employment_start_date: r.employment_start_date || ext.employment_start_date || '',
          Create_Time: r.created_at ? new Date(r.created_at).toISOString() : '',
          fileName: r.file_name || ext.file_name || '',
          _metadata: ext._metadata || {}
        };
      });
    } else {
      let whereClauses = [];
      let params = [];
      if (company_id && company_id !== 'ALL') {
        params.push(company_id);
        whereClauses.push(`company_id = $${params.length}`);
      }
      if (req.user.role !== 'ADMIN' && req.user.company_id) {
        params.push(req.user.company_id);
        whereClauses.push(`company_id = $${params.length}`);
      }
      if (department) {
        params.push(`%${department}%`);
        whereClauses.push(`department_staffing_plan ILIKE $${params.length}`);
      }
      if (status === 'ACTIVE') {
        whereClauses.push(`(is_deleted = false AND (employment_status = 'ACTIVE' OR status = 'ACTIVE'))`);
      } else if (status === 'DELETED') {
        whereClauses.push(`is_deleted = true`);
      } else if (status === 'RESIGNED') {
        whereClauses.push(`(employment_status = 'RESIGNED' OR status = 'RESIGNED')`);
      }
      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const profRes = await db.query(`SELECT * FROM hr_employee_profiles ${whereSql} ORDER BY id ASC`, params);
      rows = profRes.rows;
    }

    const wb = XLSX.utils.book_new();

    // Sheet 1: Trang tính1
    const sheetData = [];
    sheetData.push(CANONICAL_53_FIELDS);

    for (const row of rows) {
      const rowArr = CANONICAL_53_FIELDS.map(col => {
        let val = row[col];
        if (val === undefined || val === null) {
          const lowerCol = col.toLowerCase();
          val = row[lowerCol] !== undefined ? row[lowerCol] : '';
        }
        val = String(val).trim();
        // Bảo toàn số 0 ở đầu bằng cell string
        if ((col === 'citizen_id' || col === 'phone_number' || col === 'employee_id') && /^0\d+$/.test(val)) {
          return { t: 's', v: val };
        }
        return val;
      });
      sheetData.push(rowArr);
    }

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws['!cols'] = CANONICAL_53_FIELDS.map(c => ({ wch: Math.max(c.length + 4, 15) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Trang tính1');

    // Sheet 2: Metadata_TrichXuat nếu có yêu cầu
    if (include_metadata === 'true' || include_metadata === true) {
      const metaData = [['STT', 'Mã NV / CCCD', 'Họ và tên', 'Trường dữ liệu', 'Giá trị', 'Trạng thái trích xuất', 'Độ tin cậy', 'Tài liệu nguồn']];
      let metaIndex = 1;
      for (const row of rows) {
        const codeOrCccd = row.employee_id || row.citizen_id || 'Chưa rõ';
        const name = row.full_name || '';
        const metaObj = row._metadata || {};
        for (const f of CANONICAL_53_FIELDS) {
          if (f === 'Create_Time' || f === 'fileName') continue;
          const fm = metaObj[f] || {};
          metaData.push([
            metaIndex++,
            codeOrCccd,
            name,
            f,
            String(row[f] || fm.value || ''),
            fm.status || (row[f] ? 'EXTRACTED' : 'NOT_FOUND'),
            fm.confidence || (row[f] ? 'high' : 'high'),
            fm.source || row.file_name || row.fileName || ''
          ]);
        }
      }
      const metaWs = XLSX.utils.aoa_to_sheet(metaData);
      metaWs['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 25 }, { wch: 25 }, { wch: 30 }, { wch: 20 }, { wch: 12 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, metaWs, 'Metadata_TrichXuat');
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const downloadName = `Hoso_Nhansu_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  } catch (err) {
    console.error('Lỗi xuất Excel hồ sơ nhân sự:', err);
    return res.status(500).json({ success: false, error: 'Lỗi xuất file Excel: ' + err.message });
  }
});

// ----------------------------------------------------------------------------
// Helper: Conversational Handler for Chat Assistant Integration
// ----------------------------------------------------------------------------
function findStagingItemByTarget(pendingItems, target) {
  if (!target || !pendingItems || !pendingItems.length) return null;
  const targetStr = String(target).trim();
  const normTarget = removeAccents(targetStr).trim();

  // 1. Exact UUID or ID match
  const byId = pendingItems.find(it => String(it.id).toLowerCase() === targetStr.toLowerCase());
  if (byId) return byId;

  // 2. Check if target is a number index: e.g. "3", "so 3", "ho so 3", "file 3", "#3"
  const numMatch = normTarget.match(/^(?:so|thu|file|ho so|#)\s*(\d{1,2})$/i) || normTarget.match(/^(\d{1,2})$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1; // 1-based index
    if (idx >= 0 && idx < pendingItems.length) {
      return pendingItems[idx];
    }
  }

  // 3. Check if target matches employee_code (e.g. "SWC00810", "STL-001", "VTX_881")
  const targetCodeClean = normTarget.replace(/[^a-z0-9]/gi, '');
  if (targetCodeClean.length >= 3) {
    for (const it of pendingItems) {
      const itCode = String(it.employee_code || it.target_employee_code || '').toLowerCase().replace(/[^a-z0-9]/gi, '');
      if (itCode && (itCode === targetCodeClean || itCode.includes(targetCodeClean) || targetCodeClean.includes(itCode))) {
        return it;
      }
    }
  }

  // 4. Check if target matches citizen_id (e.g. "079204001284")
  const targetDigits = targetStr.replace(/\D/g, '');
  if (targetDigits.length >= 9) {
    for (const it of pendingItems) {
      const itCitizen = String(it.citizen_id || '').replace(/\D/g, '');
      if (itCitizen && (itCitizen === targetDigits || itCitizen.includes(targetDigits))) {
        return it;
      }
    }
  }

  // 5. Check if matches file_name (e.g. "SWC00810", "SWC00810.pdf", "189_QD.pdf")
  const fileClean = normTarget.replace(/\.pdf$/i, '').replace(/[^a-z0-9]/gi, '');
  if (fileClean && fileClean.length >= 3) {
    for (const it of pendingItems) {
      const itFileClean = String(it.file_name || '').replace(/\.pdf$/i, '').replace(/[^a-z0-9]/gi, '');
      if (itFileClean && (itFileClean.includes(fileClean) || fileClean.includes(itFileClean))) {
        return it;
      }
    }
  }

  // 6. Check if matches full_name (exact or substring)
  for (const it of pendingItems) {
    const itName = removeAccents(it.full_name || '');
    if (itName && (itName.includes(normTarget) || normTarget.includes(itName))) {
      return it;
    }
  }

  // 7. Token-based word match for full_name (e.g. "Truong Nam" matches "Nguyen Truong Nam")
  const targetWords = normTarget.split(/\s+/).filter(w => w.length > 1);
  if (targetWords.length > 0) {
    for (const it of pendingItems) {
      const itName = removeAccents(it.full_name || '');
      const matchCount = targetWords.filter(w => itName.includes(w)).length;
      if (matchCount >= Math.min(2, targetWords.length)) {
        return it;
      }
    }
  }

  return null;
}

async function doApprovalForItems(itemsToProcess, user, canApprove, prefixMessage = '') {
  if (!itemsToProcess.length) {
    return {
      reply: `${prefixMessage}⚠️ Không có hồ sơ nào được chọn để phê duyệt.`,
      table: null
    };
  }

  // AUTH-01: Company Admin scope separation: only approve own company, separate out-of-scope items
  let approvableItems = itemsToProcess;
  let outOfScopeItems = [];

  if (!canApprove) {
    // User only has submit permission (e.g. HR)
    const ids = approvableItems.map(it => it.id);
    await db.query(
      `UPDATE hr_employee_staging 
       SET staging_status = 'pending_approval', reviewer_username = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ANY($2::uuid[])`,
      [user.username, ids]
    );
    return {
      reply: `${prefixMessage}📤 **Hồ sơ đã được chuyển sang trạng thái "Chờ phê duyệt" (pending_approval).**\n\n` +
        `Do vai trò của bạn (**${user.role}**) không có thẩm quyền duyệt chính thức (Separation of Duties), hồ sơ đã được lưu trong vùng Staging để Quản trị viên (**ADMIN**) duyệt chính thức.`,
      table: null
    };
  }

  // Check unconfirmed
  const unconfirmed = approvableItems.filter(it => it.company_status !== 'confirmed' || !it.company_id);
  if (unconfirmed.length > 0) {
    return {
      reply: `${prefixMessage}⚠️ **Chưa thể phê duyệt**: Có ${unconfirmed.length} hồ sơ chưa được xác nhận công ty (ví dụ: "${unconfirmed[0].full_name}").\n\n` +
        `Bạn có thể:\n` +
        `1. Gõ: **"${unconfirmed[0].full_name} thuộc ${user.company_id || 'SWC'}"** để xác nhận đơn vị.\n` +
        `2. Gõ: **"bỏ hồ sơ ${unconfirmed[0].file_name ? unconfirmed[0].file_name.replace('.pdf', '') : unconfirmed[0].full_name}, hãy cập nhật các hồ sơ trên"** để bỏ qua hồ sơ này và duyệt các hồ sơ còn lại.\n` +
        `3. Gõ: **"Duyệt các hồ sơ hợp lệ"** để duyệt toàn bộ các hồ sơ đã sẵn sàng.`,
      table: null
    };
  }

  // BIZ-02: Validate identity completeness before approval (prevent premature approval without mock codes)
  const validationErrors = [];
  for (const it of approvableItems) {
    const val = validateItemForApproval(it, it.company_id || user.company_id);
    if (!val.valid) {
      validationErrors.push(`• **${it.full_name || it.file_name}**: ${val.missing.join(', ')}`);
    }
  }

  if (validationErrors.length > 0) {
    const hasMissingCode = validationErrors.some(v => v.includes('Mã nhân viên'));
    const hasMissingCccd = validationErrors.some(v => v.includes('CCCD'));
    let guidance = '';
    if (hasMissingCode && !hasMissingCccd) {
      guidance = `Vui lòng cung cấp mã nhân viên hợp lệ theo chuẩn đơn vị (ví dụ: gõ "Mã NV của [Tên] là STL-001") trước khi phê duyệt.`;
    } else if (!hasMissingCode && hasMissingCccd) {
      guidance = `Vui lòng cung cấp số CCCD đầy đủ (ví dụ: gõ "CCCD của [Tên]: 079204001284") trước khi phê duyệt.`;
    } else {
      guidance = `Vui lòng cung cấp mã nhân viên hợp lệ theo chuẩn đơn vị và số CCCD đầy đủ trước khi phê duyệt.`;
    }

    return {
      reply: `${prefixMessage}⚠️ **Chặn phê duyệt do thiếu dữ liệu định danh bắt buộc (BIZ-02)**:\n\n` +
        validationErrors.join('\n') + `\n\n` +
        guidance + ` Hệ thống không cho phép tự tạo mã giả để vượt qua kiểm tra.`,
      table: null
    };
  }

  // Approve through transaction
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const results = [];

    for (const it of approvableItems) {
      const resItem = await executeStagingApproval(client, it, user);
      results.push(resItem);
    }

    await client.query('COMMIT');

    // Queue sync tasks for all approved items AFTER transaction commits cleanly
    for (const r of results) {
      if (r && r.id) {
        if (r.type === 'restored' || r.type === 'rehired') {
          await queueEmployeeSync(r.employee_id, 'RESTORE', {
            employee_id: r.code,
            employee_code: r.code,
            full_name: r.name,
            employee_name: r.name,
            company_id: r.company,
            status: 'ACTIVE',
            action_type: 'RESTORE'
          });
        } else {
          try {
            await queueSyncTasks(r.id);
          } catch (syncErr) {
            console.warn('[Approve] queueSyncTasks warning:', syncErr.message);
          }
        }
      }
    }

    await logAudit({
      actor_user_id: user.user_id,
      actor_username: user.username,
      action: 'HR_INTAKE_APPROVED_CONVERSATIONAL',
      status: 'SUCCESS',
      metadata: { results }
    });

    const lines = results.map(r => {
      const codePart = r.code ? ` • Mã NV: \`${r.code}\`` : '';
      const changedPart = (r.changedFields && r.changedFields.length > 0) ? ` (Trường thay đổi: ${r.changedFields.join(', ')})` : '';
      if (r.type === 'updated') {
        return `- 🔄 Cập nhật: **${r.name}**${codePart} • Đơn vị: **${r.company}**${changedPart}`;
      } else if (r.type === 'restored') {
        return `- ♻️ Khôi phục: **${r.name}**${codePart} • Đơn vị: **${r.company}** (Tái kích hoạt ACTIVE và đồng bộ 3 hệ thống)`;
      } else if (r.type === 'rehired') {
        return `- 💼 Tiếp nhận lại: **${r.name}**${codePart} • Đơn vị: **${r.company}** (Bảo toàn lịch sử mã NV)`;
      }
      return `- 🎉 Tạo mới: **${r.name}**${codePart} • Đơn vị: **${r.company}**`;
    }).join('\n');

    let transferNotice = '';
    if (outOfScopeItems.length > 0) {
      transferNotice = `\n\n📌 *Lưu ý: Có **${outOfScopeItems.length}** hồ sơ ngoài phạm vi đơn vị ${user.company_id} đã được tách riêng sang trạng thái chuyển giao (\`transferred\`) và không làm ảnh hưởng lô phê duyệt của bạn.*`;
    }

    return {
      reply: `${prefixMessage}🎉 **Đã phê duyệt và lưu chính thức ${results.length} hồ sơ nhân sự vào hệ thống!**\n\n` +
        `${lines}${transferNotice}\n\n` +
        `✅ Dữ liệu đã được ghi vào bảng nhân sự \`hr_employee_profiles\` & \`employees\`, đồng thời xếp hàng tác vụ đồng bộ sang NocoDB.`,
      table: null
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi phê duyệt hồ sơ hội thoại:', err);
    return {
      reply: `${prefixMessage}⚠️ **Thao tác phê duyệt thất bại**: ${err.message}`,
      table: null
    };
  } finally {
    client.release();
  }
}

async function handleIntakeConversationalMessage(user, message, conversationId) {
  // Check if user has intake permissions
  const canConfirm = await hasPermission(user.role, 'hr.intake.confirm_company');
  const canSubmit = await hasPermission(user.role, 'hr.intake.submit');
  const canApprove = await hasPermission(user.role, 'hr.intake.approve');

  if (!canConfirm && !canSubmit && !canApprove) return null;

  // 1. Fast parse intent: if not conversational intake, return immediately
  const intent = parseConversationalIntake(message);
  if (intent.type === 'OTHER') return null;

  // 2. BIZ-01: Find pending staging items strictly isolated by deterministic conversation_id or current user batch
  const validConvId = toValidUUID(conversationId);
  let scopeCond = `staging_status IN ('pending_review', 'pending_approval')`;
  const params = [];

  if (validConvId) {
    params.push(validConvId);
    scopeCond += ` AND conversation_id = $${params.length}`;
    if (user.role !== 'ADMIN') {
      params.push(user.username);
      scopeCond += ` AND uploaded_by = $${params.length}`;
    }
  } else {
    // If no session UUID provided, scope strictly to recent uploads by this user within last 2 hours
    params.push(user.username);
    scopeCond += ` AND uploaded_by = $${params.length} AND created_at > NOW() - INTERVAL '2 hours'`;
  }

  // Get records from the latest pending batch, ordered chronologically (created_at ASC)
  const query = `
    WITH scoped AS (
      SELECT * FROM hr_employee_staging WHERE ${scopeCond}
    ),
    latest_batch AS (
      SELECT batch_id FROM scoped ORDER BY created_at DESC LIMIT 1
    )
    SELECT * FROM scoped WHERE batch_id = (SELECT batch_id FROM latest_batch)
    ORDER BY created_at ASC, file_name ASC, id ASC LIMIT 20
  `;

  const pendingRes = await db.query(query, params);
  const pendingItems = pendingRes.rows;
  if (!pendingItems.length) return null;

  // Execute Intent: UPDATE IDENTIFIER (CCCD, Mã nhân viên) via Chat
  if (intent.type === 'UPDATE_IDENTIFIER') {
    const results = [];
    const errors = [];

    for (const upd of intent.updates) {
      const item = findStagingItemByTarget(pendingItems, upd.target);
      if (!item) {
        errors.push(`Không tìm thấy hồ sơ nào khớp với "${upd.target}" trong danh sách chờ.`);
        continue;
      }

      // Check permissions: Non-admin can only update items in their own company or unconfirmed
      if (user.role !== 'ADMIN' && item.company_id && item.company_id !== user.company_id) {
        errors.push(`Hồ sơ "${item.full_name}" thuộc đơn vị ${item.company_id}, bạn không có quyền chỉnh sửa.`);
        continue;
      }

      const updateFields = [];
      const updateParams = [];
      const fieldDesc = [];

      if (upd.citizen_id) {
        const cccdValid = standardizeAndValidateCccd(upd.citizen_id);
        if (!cccdValid.valid) {
          errors.push(cccdValid.reason || `Số CCCD "${upd.citizen_id}" của ${item.full_name} không hợp lệ.`);
        } else {
          const cleanCitizen = cccdValid.cleanCccd;
          const comp = item.company_id || user.company_id;

          // Fail-Closed CCCD Duplicate Check (P0-A)
          let dupCheck = null;
          try {
            dupCheck = await checkDatabaseCccdDuplicates(cleanCitizen, comp, user, item.full_name);
          } catch (lookupErr) {
            console.error('Lỗi ngoại lệ khi kiểm tra trùng CCCD trong chat intent:', lookupErr.message);
            dupCheck = { success: false, duplicateType: 'DUPLICATE_CHECK_UNAVAILABLE' };
          }

          // Case C: Không thể xác minh duplicate (CSDL lỗi / không sẵn sàng)
          if (!dupCheck || dupCheck.success === false || dupCheck.duplicateType === 'DUPLICATE_CHECK_UNAVAILABLE') {
            errors.push(`Dịch vụ đối soát CSDL không khả dụng cho số CCCD (${maskCccd(cleanCitizen)}) của ${item.full_name}. Giao dịch cập nhật bị tạm dừng để bảo vệ an toàn CSDL.`);
            // KHÔNG thêm citizen_id vào updateFields, KHÔNG xóa cờ duplicate, KHÔNG đổi intake_mode
          } else if (dupCheck.hasDuplicate) {
            // Case A: Đã kiểm tra thành công và phát hiện trùng lặp
            updateParams.push(cleanCitizen);
            updateFields.push(`citizen_id = $${updateParams.length}`);
            fieldDesc.push(`CCCD: \`${maskCccd(cleanCitizen)}\``);

            updateFields.push(`suspected_duplicate = true`);
            updateFields.push(`intake_mode = 'suspected_duplicate'`);
            updateParams.push(dupCheck.reason);
            updateFields.push(`duplicate_reason = $${updateParams.length}`);

            const existingPc = (item.proposed_changes && typeof item.proposed_changes === 'object') ? { ...item.proposed_changes } : {};
            existingPc.duplicate_classification = dupCheck.duplicateType;
            if (dupCheck.matchedRecord) {
              existingPc.matched_record = dupCheck.matchedRecord;
            }
            updateParams.push(JSON.stringify(existingPc));
            updateFields.push(`proposed_changes = $${updateParams.length}::jsonb`);
          } else {
            // Case B: Đã kiểm tra thành công và xác nhận KHÔNG trùng lặp
            updateParams.push(cleanCitizen);
            updateFields.push(`citizen_id = $${updateParams.length}`);
            fieldDesc.push(`CCCD: \`${maskCccd(cleanCitizen)}\``);

            updateFields.push(`suspected_duplicate = false`);
            updateFields.push(`duplicate_reason = NULL`);

            // Chỉ đặt new_profile nếu không có lỗi blocking khác (ví dụ: COMPANY_MISMATCH)
            const existingPc = (item.proposed_changes && typeof item.proposed_changes === 'object') ? { ...item.proposed_changes } : {};
            const existingValErrors = Array.isArray(existingPc.validation_errors) ? existingPc.validation_errors : [];
            const isMismatch = (item.company_status === 'conflict') || (item.intake_mode === 'company_mismatch') || existingValErrors.some(e => e.code === 'COMPANY_MISMATCH');

            updateFields.push(`intake_mode = '${isMismatch ? 'company_mismatch' : 'new_profile'}'`);

            existingPc.duplicate_classification = 'NO_DUPLICATE';
            if (Array.isArray(existingPc.validation_errors)) {
              existingPc.validation_errors = existingPc.validation_errors.filter(e => !e.code || !e.code.includes('DUPLICATE'));
            }
            delete existingPc.matched_record;
            updateParams.push(JSON.stringify(existingPc));
            updateFields.push(`proposed_changes = $${updateParams.length}::jsonb`);
          }
        }
      }

      if (upd.employee_code) {
        const cleanCode = String(upd.employee_code).trim();
        const comp = item.company_id || user.company_id;
        const pattern = COMPANY_CODE_PATTERNS[comp];
        if (pattern && !pattern.regex.test(cleanCode)) {
          errors.push(`Mã nhân viên "${cleanCode}" của ${item.full_name} không hợp lệ cho đơn vị ${comp}. (${pattern.hint})`);
        } else {
          updateParams.push(cleanCode);
          updateFields.push(`employee_code = $${updateParams.length}`);
          fieldDesc.push(`Mã NV: \`${cleanCode}\``);
        }
      }

      if (updateFields.length > 0) {
        updateFields.push(`updated_at = NOW()`);
        updateParams.push(item.id);
        await db.query(
          `UPDATE hr_employee_staging 
           SET ${updateFields.join(', ')} 
           WHERE id = $${updateParams.length}`,
          updateParams
        );
        results.push({ item, fieldDesc: fieldDesc.join(', ') });
      }
    }

    if (results.length === 0 && errors.length > 0) {
      return {
        reply: `⚠️ **Không thể cập nhật thông tin định danh**:\n\n` + errors.map(e => `• ${e}`).join('\n'),
        table: null
      };
    }

    // Refresh pending items deterministically
    const refreshedRes = await db.query(
      `SELECT * FROM hr_employee_staging 
       WHERE id = ANY($1::uuid[]) 
       ORDER BY created_at ASC, file_name ASC, id ASC`,
      [pendingItems.map(it => it.id)]
    );
    const refreshedItems = refreshedRes.rows;

    // Check validation status of all items
    const stillInvalid = [];
    for (const it of refreshedItems) {
      const val = validateItemForApproval(it, it.company_id || user.company_id);
      if (!val.valid) {
        stillInvalid.push({ name: it.full_name || it.file_name, missing: val.missing });
      }
    }

    let statusNote = '';
    if (stillInvalid.length === 0) {
      statusNote = `\n\n🎉 **Tất cả ${refreshedItems.length} hồ sơ trong lô đã có đầy đủ thông tin định danh hợp lệ và sẵn sàng phê duyệt!**\n` +
        `👉 Bạn có thể gõ **"Duyệt toàn bộ"** để hoàn tất lưu hồ sơ chính thức vào hệ thống.`;
    } else {
      statusNote = `\n\n⚠️ **Một số hồ sơ vẫn cần bổ sung dữ liệu định danh trước khi phê duyệt**:\n` +
        stillInvalid.map(inv => `• **${inv.name}**: ${inv.missing.join(', ')}`).join('\n') +
        `\n\n*(Gõ "Mã NV của [Tên] là [Mã]" hoặc "CCCD của [Tên]: [Số]" để bổ sung).*`;
    }

    let errorNote = '';
    if (errors.length > 0) {
      errorNote = `\n\n⚠️ *Lưu ý*: ${errors.join('; ')}`;
    }

    const lines = results.map(r => `• **${r.item.full_name || r.item.file_name}**: Đã cập nhật ${r.fieldDesc}`).join('\n');

    return {
      reply: `✅ **Đã cập nhật thông tin định danh thành công:**\n\n` +
        lines + errorNote + statusNote + `\n\n` +
        renderBatchSummary(refreshedItems, canApprove),
      table: null
    };
  }

  // Execute Intent: SKIP / REMOVE (BIZ-03)
  if (intent.type === 'SKIP_ITEM' || intent.type === 'SKIP_AND_APPROVE_OTHERS') {
    const rawTargets = intent.targets && intent.targets.length ? intent.targets : [intent.target];
    const foundItems = [];

    for (const t of rawTargets) {
      const f = findStagingItemByTarget(pendingItems, t);
      if (f && !foundItems.some(x => x.id === f.id)) {
        foundItems.push(f);
      }
    }

    if (!foundItems.length) {
      return {
        reply: `⚠️ Không tìm thấy hồ sơ nào khớp với "${rawTargets.join(', ')}" trong danh sách chờ duyệt để loại bỏ.`,
        table: null
      };
    }

    const foundIds = foundItems.map(f => f.id);
    await db.query(
      `UPDATE hr_employee_staging 
       SET staging_status = 'rejected',
           rejection_reason = 'Người dùng yêu cầu bỏ qua qua hội thoại',
           reviewer_username = $1,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = ANY($2::uuid[])`,
      [user.username, foundIds]
    );

    const names = foundItems.map(f => `"${f.full_name}" (${f.file_name || ''})`).join(', ');

    if (intent.type === 'SKIP_ITEM') {
      const remainingCount = pendingItems.length - foundItems.length;
      return {
        reply: `🗑️ **Đã bỏ qua ${foundItems.length} hồ sơ (${names}) khỏi danh sách xem xét.**\n\n` +
          `Danh sách hiện còn **${remainingCount}** hồ sơ chờ xử lý. Bạn có thể gõ **"Phê duyệt"** để lưu các hồ sơ hợp lệ còn lại.`,
        table: null
      };
    }

    // SKIP_AND_APPROVE_OTHERS
    const remainingItems = pendingItems.filter(it => !foundIds.includes(it.id));
    if (!remainingItems.length) {
      return {
        reply: `🗑️ Đã bỏ qua hồ sơ (${names}). Không còn hồ sơ nào khác trong lô chờ duyệt.`,
        table: null
      };
    }

    return await doApprovalForItems(
      remainingItems, 
      user, 
      canApprove, 
      `🗑️ **Đã bỏ qua hồ sơ (${names}).**\n\n`
    );
  }

  // Execute Intent: CONFIRM COMPANY COMPOUND ("Hồ sơ 3 thuộc STL, tất cả hồ sơ còn lại thuộc SWC") (AUTH-01)
  if (intent.type === 'CONFIRM_COMPANY_COMPOUND') {
    const foundTarget = findStagingItemByTarget(pendingItems, intent.target);
    if (!foundTarget) {
      return {
        reply: `⚠️ Không tìm thấy hồ sơ nào khớp với "${intent.target}" trong danh sách chờ duyệt hiện tại.`
      };
    }

    const remainingItems = pendingItems.filter(it => it.id !== foundTarget.id);

    // Xử lý phân quyền linh hoạt cho HR/User bị giới hạn công ty: tách riêng hồ sơ ngoài phạm vi mà không gây lỗi 403
    if (user.role !== 'ADMIN') {
      if (intent.targetCompany === user.company_id) {
        // Target thuộc công ty của người dùng -> xác nhận
        await db.query(
          `UPDATE hr_employee_staging 
           SET company_id = $1, 
               company_status = 'confirmed', 
               intake_mode = CASE WHEN intake_mode = 'company_mismatch' THEN (CASE WHEN target_profile_id IS NOT NULL THEN 'update_profile' ELSE 'new_profile' END) ELSE intake_mode END,
               duplicate_reason = NULL,
               reviewer_username = $2, 
               reviewed_at = NOW(), 
               updated_at = NOW()
           WHERE id = $3`,
          [intent.targetCompany, user.username, foundTarget.id]
        );

        // Các hồ sơ còn lại thuộc đơn vị khác -> tách riêng sang trạng thái chuyển giao
        if (remainingItems.length > 0) {
          await db.query(
            `UPDATE hr_employee_staging 
             SET company_id = $1::varchar, 
                 company_status = 'confirmed', 
                 staging_status = 'transferred',
                 duplicate_reason = 'Hồ sơ ngoài phạm vi đơn vị ' || $2::text || ', đã chuyển giao sang đơn vị ' || $1::text || ' tiếp nhận xử lý',
                 reviewer_username = $3, 
                 reviewed_at = NOW(), 
                 updated_at = NOW()
             WHERE id = ANY($4::uuid[])`,
            [intent.remainingCompany, user.company_id, user.username, remainingItems.map(it => it.id)]
          );
        }

        const targetUpdated = await db.query(
          `SELECT * FROM hr_employee_staging WHERE id = $1`,
          [foundTarget.id]
        );

        return {
          reply: `✅ **Đã phân tách và xử lý lô hồ sơ đa đơn vị thành công (AUTH-01):**\n\n` +
            `• **Đơn vị ${user.company_id}**: Hồ sơ "${foundTarget.full_name}" (${foundTarget.file_name || ''}) đã xác nhận thuộc **${user.company_id}** và sẵn sàng phê duyệt.\n` +
            `• **Chuyển giao (${intent.remainingCompany})**: **${remainingItems.length}** hồ sơ còn lại đã được tách riêng sang trạng thái chuyển giao (\`transferred\`) cho Quản trị viên đơn vị **${intent.remainingCompany}** tiếp nhận.\n\n` +
            renderStagingPreview(targetUpdated.rows[0], canApprove),
          table: null
        };
      } else if (intent.remainingCompany === user.company_id) {
        // Target thuộc đơn vị khác -> tách riêng sang transferred
        await db.query(
          `UPDATE hr_employee_staging 
           SET company_id = $1::varchar, 
               company_status = 'confirmed', 
               staging_status = 'transferred',
               duplicate_reason = 'Hồ sơ ngoài phạm vi đơn vị ' || $2::text || ', đã chuyển giao sang đơn vị ' || $1::text || ' tiếp nhận xử lý',
               reviewer_username = $3, 
               reviewed_at = NOW(), 
               updated_at = NOW()
           WHERE id = $4`,
          [intent.targetCompany, user.company_id, user.username, foundTarget.id]
        );

        // Các hồ sơ còn lại thuộc công ty mình -> xác nhận
        if (remainingItems.length > 0) {
          await db.query(
            `UPDATE hr_employee_staging 
             SET company_id = $1, 
                 company_status = 'confirmed', 
                 intake_mode = CASE WHEN intake_mode = 'company_mismatch' THEN (CASE WHEN target_profile_id IS NOT NULL THEN 'update_profile' ELSE 'new_profile' END) ELSE intake_mode END,
                 duplicate_reason = NULL,
                 reviewer_username = $2, 
                 reviewed_at = NOW(), 
                 updated_at = NOW()
             WHERE id = ANY($3::uuid[])`,
            [intent.remainingCompany, user.username, remainingItems.map(it => it.id)]
          );
        }

        const remainingUpdated = await db.query(
          `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC, file_name ASC, id ASC`,
          [remainingItems.map(it => it.id)]
        );

        return {
          reply: `✅ **Đã phân tách và xử lý lô hồ sơ đa đơn vị thành công (AUTH-01):**\n\n` +
            `• **Đơn vị ${user.company_id}**: **${remainingItems.length}** hồ sơ đã xác nhận thuộc **${user.company_id}** và sẵn sàng phê duyệt.\n` +
            `• **Chuyển giao (${intent.targetCompany})**: Hồ sơ "${foundTarget.full_name}" đã được tách riêng và chuyển giao sang đơn vị **${intent.targetCompany}**.\n\n` +
            renderBatchSummary(remainingUpdated.rows, canApprove),
          table: null
        };
      } else {
        return {
          reply: `⚠️ **Từ chối thao tác phân quyền**: Bạn thuộc đơn vị **${user.company_id}**, chỉ có thể xử lý hồ sơ liên quan đến đơn vị của mình.`
        };
      }
    }

    // Role ADMIN: cập nhật toàn quyền cho cả hai bên
    await db.query(
      `UPDATE hr_employee_staging 
       SET company_id = $1, 
           company_status = 'confirmed', 
           intake_mode = CASE WHEN intake_mode = 'company_mismatch' THEN (CASE WHEN target_profile_id IS NOT NULL THEN 'update_profile' ELSE 'new_profile' END) ELSE intake_mode END,
           duplicate_reason = NULL,
           reviewer_username = $2, 
           reviewed_at = NOW(), 
           updated_at = NOW()
       WHERE id = $3`,
      [intent.targetCompany, user.username, foundTarget.id]
    );

    if (remainingItems.length > 0) {
      await db.query(
        `UPDATE hr_employee_staging 
         SET company_id = $1, 
             company_status = 'confirmed', 
             intake_mode = CASE WHEN intake_mode = 'company_mismatch' THEN (CASE WHEN target_profile_id IS NOT NULL THEN 'update_profile' ELSE 'new_profile' END) ELSE intake_mode END,
             duplicate_reason = NULL,
             reviewer_username = $2, 
             reviewed_at = NOW(), 
             updated_at = NOW()
         WHERE id = ANY($3::uuid[])`,
        [intent.remainingCompany, user.username, remainingItems.map(it => it.id)]
      );
    }

    const allUpdated = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC, file_name ASC, id ASC`,
      [pendingItems.map(it => it.id)]
    );

    return {
      reply: `✅ **Đã xác nhận đơn vị thành công cho toàn bộ hồ sơ!**\n\n` +
        `• Hồ sơ "${foundTarget.full_name}" (${foundTarget.file_name || ''}): thuộc đơn vị **${intent.targetCompany}**\n` +
        `• **${remainingItems.length}** hồ sơ còn lại: thuộc đơn vị **${intent.remainingCompany}**\n\n` +
        renderBatchSummary(allUpdated.rows, canApprove),
      table: null
    };
  }

  // Execute Intent: CONFIRM COMPANY REMAINING ("5 hồ sơ còn lại thuộc SWC", "các hồ sơ còn lại thuộc SWC")
  if (intent.type === 'CONFIRM_COMPANY_REMAINING') {
    const targetComp = intent.company_id;
    let unconfirmed = pendingItems.filter(it => it.company_status !== 'confirmed' && !it.suspected_duplicate && it.intake_mode !== 'suspected_duplicate');
    if (!unconfirmed.length) unconfirmed = pendingItems.filter(it => !it.suspected_duplicate && it.intake_mode !== 'suspected_duplicate');

    if (!unconfirmed.length) {
      return {
        reply: `⚠️ Không có hồ sơ hợp lệ nào để gán công ty. Các hồ sơ còn lại đều bị phát hiện TRÙNG LẶP CCCD hoặc cần kiểm tra thủ công. Hệ thống từ chối gán công ty để bảo toàn dữ liệu.`,
        table: null
      };
    }

    const idsToUpdate = unconfirmed.map(it => it.id);

    if (user.role !== 'ADMIN' && user.company_id !== targetComp) {
      // Tách riêng sang transferred mà không ném 403
      await db.query(
        `UPDATE hr_employee_staging 
         SET company_id = $1, 
             company_status = 'confirmed', 
             staging_status = 'transferred',
             duplicate_reason = 'Hồ sơ ngoài phạm vi đơn vị ' || $2 || ', đã chuyển giao sang đơn vị ' || $1 || ' tiếp nhận xử lý',
             reviewer_username = $3, 
             reviewed_at = NOW(), 
             updated_at = NOW()
         WHERE id = ANY($4::uuid[])`,
        [targetComp, user.company_id, user.username, idsToUpdate]
      );

      return {
        reply: `✅ **Đã phân tách và chuyển giao ${idsToUpdate.length} hồ sơ ngoài phạm vi sang đơn vị ${targetComp}!**\n\n` +
          `Các hồ sơ này đã được chuyển giao an toàn cho Quản trị viên đơn vị **${targetComp}** tiếp nhận xử lý, không làm treo phiên làm việc của bạn.`,
        table: null
      };
    }

    await db.query(
      `UPDATE hr_employee_staging 
       SET company_id = $1, 
           company_status = 'confirmed', 
           intake_mode = CASE WHEN intake_mode = 'company_mismatch' THEN (CASE WHEN target_profile_id IS NOT NULL THEN 'update_profile' ELSE 'new_profile' END) ELSE intake_mode END,
           duplicate_reason = NULL,
           reviewer_username = $2, 
           reviewed_at = NOW(), 
           updated_at = NOW()
       WHERE id = ANY($3::uuid[])`,
      [targetComp, user.username, idsToUpdate]
    );

    const allUpdated = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC, file_name ASC, id ASC`,
      [pendingItems.map(it => it.id)]
    );

    return {
      reply: `✅ **Đã xác nhận công ty ${targetComp} thành công cho ${idsToUpdate.length} hồ sơ hợp lệ!**\n\n` +
        renderBatchSummary(allUpdated.rows, canApprove),
      table: null
    };
  }

  // Execute Intent: CONFIRM COMPANY
  if (intent.type === 'CONFIRM_COMPANY_SINGLE' || intent.type === 'CONFIRM_COMPANY_BATCH' || intent.type === 'CONFIRM_COMPANY_TARGETED') {
    const targetComp = intent.company_id;
    if (user.role !== 'ADMIN' && user.company_id !== targetComp) {
      return {
        reply: `⚠️ **Từ chối thao tác phân quyền**: Bạn thuộc đơn vị **${user.company_id}**, không có thẩm quyền gán hoặc xác nhận hồ sơ sang đơn vị **${targetComp}**.`
      };
    }

    let itemsToUpdate = [];
    if (intent.type === 'CONFIRM_COMPANY_BATCH') {
      itemsToUpdate = pendingItems.filter(it => !it.suspected_duplicate && it.intake_mode !== 'suspected_duplicate');
      if (!itemsToUpdate.length) {
        return {
          reply: `⚠️ Không có hồ sơ hợp lệ nào để gán công ty. Toàn bộ hồ sơ trong lô đều bị phát hiện TRÙNG LẶP CCCD hoặc cần kiểm tra thủ công. Hệ thống từ chối gán công ty để bảo toàn dữ liệu.`,
          table: null
        };
      }
    } else if (intent.type === 'CONFIRM_COMPANY_TARGETED') {
      const found = findStagingItemByTarget(pendingItems, intent.target);
      if (found) {
        if (found.suspected_duplicate || found.intake_mode === 'suspected_duplicate') {
          return {
            reply: `⚠️ Hồ sơ "${found.full_name}" (${found.file_name || ''}) đã bị phát hiện TRÙNG LẶP CCCD (${found.duplicate_reason}). Hệ thống chặn xác nhận công ty đối với hồ sơ trùng.`,
            table: null
          };
        }
        itemsToUpdate = [found];
      } else {
        itemsToUpdate = pendingItems.length === 1 ? [pendingItems[0]] : [];
        if (!itemsToUpdate.length) {
          return {
            reply: `⚠️ Không tìm thấy hồ sơ nào khớp với "${intent.target}" trong danh sách chờ duyệt hiện tại. Vui lòng kiểm tra lại họ tên hoặc mã file.`
          };
        }
      }
    } else {
      // SINGLE: pick first unconfirmed valid item if available
      const unconfirmedOne = pendingItems.find(it => it.company_status !== 'confirmed' && !it.suspected_duplicate && it.intake_mode !== 'suspected_duplicate') || 
                             pendingItems.find(it => !it.suspected_duplicate && it.intake_mode !== 'suspected_duplicate');
      if (!unconfirmedOne) {
        return {
          reply: `⚠️ Không tìm thấy hồ sơ hợp lệ nào cần xác nhận công ty. Các hồ sơ hiện có đều bị trùng CCCD hoặc cần kiểm tra thủ công.`,
          table: null
        };
      }
      itemsToUpdate = [unconfirmedOne];
    }

    const idsToUpdate = itemsToUpdate.map(it => it.id);
    await db.query(
      `UPDATE hr_employee_staging 
       SET company_id = $1, 
           company_status = 'confirmed', 
           intake_mode = CASE 
             WHEN intake_mode = 'company_mismatch' THEN (CASE WHEN target_profile_id IS NOT NULL THEN 'update_profile' ELSE 'new_profile' END) 
             ELSE intake_mode 
           END,
           duplicate_reason = NULL,
           reviewer_username = $2, 
           reviewed_at = NOW(), 
           updated_at = NOW()
       WHERE id = ANY($3::uuid[])`,
      [targetComp, user.username, idsToUpdate]
    );

    const updatedRes = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC, file_name ASC, id ASC`,
      [pendingItems.map(it => it.id)]
    );

    let card = '';
    if (itemsToUpdate.length === 1 && pendingItems.length === 1) {
      card = `✅ **Đã xác nhận công ty ${targetComp} thành công cho hồ sơ "${itemsToUpdate[0].full_name}"!**\n\n` + renderStagingPreview(updatedRes.rows[0], canApprove);
    } else {
      card = `✅ **Đã xác nhận công ty ${targetComp} cho ${itemsToUpdate.length} hồ sơ hợp lệ!**\n\n` + renderBatchSummary(updatedRes.rows, canApprove);
    }

    return { reply: card, table: null };
  }

  // Execute Intent: POSITIONAL
  if (intent.type === 'CONFIRM_COMPANY_POSITIONAL') {
    const assignments = intent.assignments;
    for (const a of assignments) {
      if (a.index < pendingItems.length) {
        const it = pendingItems[a.index];
        if (user.role !== 'ADMIN' && user.company_id !== a.company_id) {
          return {
            reply: `⚠️ **Từ chối**: Bạn không có quyền gán đơn vị **${a.company_id}** cho hồ sơ "${it.full_name}".`
          };
        }
        await db.query(
          `UPDATE hr_employee_staging 
           SET company_id = $1, company_status = 'confirmed', reviewer_username = $2, reviewed_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [a.company_id, user.username, it.id]
        );
      }
    }

    const allUpdated = await db.query(
      `SELECT * FROM hr_employee_staging WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC, file_name ASC, id ASC`,
      [pendingItems.map(i => i.id)]
    );

    return {
      reply: `✅ **Đã cập nhật công ty theo thứ tự thành công!**\n\n` + renderBatchSummary(allUpdated.rows, canApprove),
      table: null
    };
  }

  // Execute Intent: UNKNOWN
  if (intent.type === 'CONFIRM_COMPANY_UNKNOWN') {
    const ids = pendingItems.map(it => it.id);
    await db.query(
      `UPDATE hr_employee_staging 
       SET company_id = NULL, company_status = 'unknown', reviewer_username = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ANY($2::uuid[])`,
      [user.username, ids]
    );

    return {
      reply: `⚪ **Đã ghi nhận công ty là "Chưa xác định"** cho ${ids.length} hồ sơ trong vùng Staging. Hồ sơ sẽ được giữ tạm thời để đối soát bổ sung sau.`,
      table: null
    };
  }

  // Execute Intent: APPROVE
  if (intent.type === 'APPROVE') {
    let itemsToProcess = pendingItems;

    if (intent.scope === 'indices') {
      itemsToProcess = intent.indices
        .map(i => pendingItems[i - 1])
        .filter(Boolean);
      if (!itemsToProcess.length) {
        return {
          reply: `⚠️ Các số thứ tự hồ sơ bạn chọn không hợp lệ (danh sách có từ 1 đến ${pendingItems.length}).`,
          table: null
        };
      }
    } else if (intent.scope === 'valid_only') {
      itemsToProcess = pendingItems.filter(it => it.company_status === 'confirmed' && it.intake_mode !== 'company_mismatch' && it.intake_mode !== 'insufficient_data');
      if (!itemsToProcess.length) {
        return {
          reply: `⚠️ Chưa có hồ sơ nào trong danh sách đạt trạng thái hợp lệ và đã xác nhận công ty để phê duyệt.`,
          table: null
        };
      }
    }

    // Always exclude suspected duplicate items from approval
    const duplicateItems = itemsToProcess.filter(it => it.suspected_duplicate || it.intake_mode === 'suspected_duplicate');
    itemsToProcess = itemsToProcess.filter(it => !it.suspected_duplicate && it.intake_mode !== 'suspected_duplicate');

    if (!itemsToProcess.length) {
      const dupNames = duplicateItems.map(d => `"${d.full_name}"`).join(', ');
      return {
        reply: `⚠️ **Không thể phê duyệt**: Toàn bộ hồ sơ (${dupNames}) đều bị phát hiện TRÙNG LẶP CCCD. Hệ thống từ chối tạo bản ghi mới để bảo toàn dữ liệu nhân sự.`,
        table: null
      };
    }

    let prefixNote = '';
    if (duplicateItems.length > 0) {
      prefixNote = `ℹ️ *Lưu ý: Đã tự động giữ lại ${duplicateItems.length} hồ sơ bị trùng CCCD ở trạng thái chặn, không tạo mới.*\n\n`;
    }

    return await doApprovalForItems(itemsToProcess, user, canApprove, prefixNote);
  }

  return null;
}

// ============================================================================
// INTERNAL APIS FOR N8N LIFECYCLE WORKFLOW (Phase 3 Integration)
// ============================================================================

const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '8973d464f5f1475b83d6ab88d222d824';
const N8N_INTERNAL_SECRET = '8973d464f5f1475b83d6ab88d222d824';

function verifyInternalAuth(req, res, next) {
  const incoming = req.headers['x-internal-secret'] ||
                   req.headers['x-n8n-auth-token'] ||
                   req.headers['x-n8n-internal-secret'] ||
                   req.body?.secret;
  if (!incoming || (incoming !== INTERNAL_SECRET && incoming !== N8N_INTERNAL_SECRET)) {
    return res.status(401).json({
      success: false,
      error: '401 Unauthorized: Invalid or missing internal secret.'
    });
  }
  next();
}

// 1. POST /api/hoso/intake/internal/validate-token
router.post('/internal/validate-token', verifyInternalAuth, async (req, res) => {
  try {
    let token = req.body?.token;
    const authHeader = req.headers['authorization'];
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        valid: false,
        error: '401 Unauthorized: Token người dùng không được để trống.'
      });
    }

    const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';
    let decoded;
    try {
      decoded = require('jsonwebtoken').verify(token, JWT_SECRET);
    } catch (jwtErr) {
      if (jwtErr.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, valid: false, error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
      }
      return res.status(401).json({ success: false, valid: false, error: 'Token xác thực không hợp lệ.' });
    }

    const uRes = await db.query(
      `SELECT u.user_id, u.username, u.role, u.company_id, u.employee_id, u.status,
              e.employee_code, e.citizen_id, e.employee_name, e.department, e.position, c.company_name
       FROM users u
       LEFT JOIN employees e ON u.employee_id = e.id
       LEFT JOIN companies c ON u.company_id = c.id
       WHERE u.user_id = $1`,
      [decoded.user_id]
    );

    if (uRes.rows.length === 0) {
      return res.status(401).json({ success: false, valid: false, error: 'Tài khoản người dùng không tồn tại.' });
    }

    const user = uRes.rows[0];
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, valid: false, error: `Tài khoản đang ở trạng thái ${user.status}.` });
    }

    const requiredPermission = req.body?.required_permission || 'hr.intake.upload';
    const allowed = await hasPermission(user.role, requiredPermission);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        valid: false,
        error: `403 Forbidden: Vai trò ${user.role} không có quyền ${requiredPermission}.`
      });
    }

    // Company scope check
    let targetCompany = user.company_id || 'STL';
    const reqCompany = (req.body?.requested_company_id || req.body?.company_id || '').toUpperCase();
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      if (['STL', 'VTX', 'SWC'].includes(reqCompany)) {
        targetCompany = reqCompany;
      }
    } else {
      if (reqCompany && reqCompany !== user.company_id) {
        return res.status(403).json({
          success: false,
          valid: false,
          error: `403 Forbidden: Tài khoản thuộc đơn vị ${user.company_id}, không được phép tải hồ sơ cho đơn vị ${reqCompany}.`
        });
      }
    }

    return res.json({
      success: true,
      valid: true,
      user: {
        user_id: user.user_id,
        username: user.username,
        employee_name: user.employee_name || user.username,
        role: user.role,
        company_id: targetCompany
      }
    });
  } catch (err) {
    console.error('Lỗi validate-token internal:', err);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi xác thực token: ' + err.message });
  }
});

// 2. [DEPRECATED / REMOVED in Phase 1.1]: POST /api/hoso/intake/internal/classify-document
// Document classification migrated 100% to n8n node "Classify - Document Type".
// Proved 0 callers across all workflows, frontend, and tests.
router.post('/internal/classify-document', verifyInternalAuth, (req, res) => {
  return res.status(410).json({
    success: false,
    error: '410 Gone: Endpoint /internal/classify-document đã bị loại bỏ trong Phase 1.1. Logic phân loại đã được chuyển toàn diện sang n8n node "Classify - Document Type".'
  });
});

// ============================================================================
// 2B. UNIFIED INGESTION ENDPOINT (Phase 1.2):
// POST /api/hoso/intake/internal/process-staged-candidate
// Replaces the 4 sequential n8n calls:
//   1. /normalize-canonical-fields
//   2. /validate-duplicates
//   3. /persist-staging
//   4. /audit-log
// ============================================================================
router.post('/internal/process-staged-candidate', verifyInternalAuth, async (req, res) => {
  let client = null;
  try {
    const {
      batch_id,
      correlation_id,
      idempotency_key,
      conversation_id,
      files,
      candidates
    } = req.body || {};

    if (!batch_id) {
      return res.status(400).json({ success: false, error: 'Thiếu batch_id bắt buộc.' });
    }

    const safeBatchId = toValidUUID(batch_id) || require('crypto').randomUUID();

    // 1. Identity & Context Authentication (Anti-spoofing & RBAC)
    const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';
    let verifiedUser = null;
    let authHeader = req.headers['authorization'];
    let token = req.body?.token;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (token) {
      try {
        const decoded = require('jsonwebtoken').verify(token, JWT_SECRET);
        const uRes = await db.query(
          `SELECT user_id, username, role, company_id, status FROM users WHERE user_id = $1 AND status = 'ACTIVE'`,
          [decoded.user_id]
        );
        if (uRes.rows.length === 0) {
          return res.status(401).json({ success: false, error: '401 Unauthorized: Người dùng không tồn tại hoặc tài khoản đã bị khóa.' });
        }
        verifiedUser = {
          user_id: uRes.rows[0].user_id,
          username: uRes.rows[0].username,
          role: uRes.rows[0].role,
          company_id: uRes.rows[0].company_id
        };
      } catch (jwtErr) {
        return res.status(401).json({ success: false, error: '401 Unauthorized: JWT token không hợp lệ hoặc đã hết hạn.' });
      }
    } else if (req.body?.user && (req.body.user.user_id || req.body.user.username)) {
      const u = req.body.user;
      const uRes = await db.query(
        `SELECT user_id, username, role, company_id, status FROM users WHERE (user_id = $1 OR username = $2) AND status = 'ACTIVE'`,
        [u.user_id || null, u.username || '']
      );
      if (uRes.rows.length === 0) {
        return res.status(401).json({ success: false, error: '401 Unauthorized: Người dùng không tồn tại trong hệ thống.' });
      }
      const realUser = uRes.rows[0];
      // Anti-spoofing: Verify caller cannot escalate role or switch company arbitrarily
      if (u.role && u.role !== realUser.role && realUser.role !== 'ADMIN' && realUser.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ success: false, error: '403 Forbidden: Quyền hạn (role) không hợp lệ so với cơ sở dữ liệu xác thực.' });
      }
      if (u.company_id && realUser.company_id && u.company_id.toUpperCase() !== realUser.company_id.toUpperCase()) {
        return res.status(403).json({ success: false, error: `403 Forbidden: Bạn không có quyền thao tác hồ sơ cho đơn vị ${u.company_id}.` });
      }
      verifiedUser = {
        user_id: realUser.user_id,
        username: realUser.username,
        role: realUser.role,
        company_id: realUser.company_id
      };
    } else {
      return res.status(401).json({ success: false, error: '401 Unauthorized: Thiếu token xác thực hoặc ngữ cảnh danh tính người dùng.' });
    }

    // Tenant tampering check: body.company_id vs verifiedUser.company_id
    if (req.body.company_id && verifiedUser.company_id) {
      if (req.body.company_id.toUpperCase() !== verifiedUser.company_id.toUpperCase()) {
        return res.status(403).json({
          success: false,
          error: `403 Forbidden: Tài khoản thuộc ${verifiedUser.company_id} không có quyền ghi hồ sơ cho ${req.body.company_id}.`
        });
      }
    }

    // Permission check for upload
    const canUpload = await hasPermission(verifiedUser.role, 'hr.intake.upload');
    if (!canUpload) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền tải lên hồ sơ nhân sự.' });
    }

    let validConvId = toValidUUID(conversation_id);
    if (validConvId) {
      try {
        const convCheck = await db.query(`SELECT id FROM ai_conversations WHERE id = $1`, [validConvId]);
        if (convCheck.rows.length === 0) validConvId = null;
      } catch(e) { validConvId = null; }
    }

    // 2. IDEMPOTENCY CHECK UNDER ADVISORY TRANSACTION LOCK
    client = await db.getClient();
    let existingStagingRows = [];
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('intake_batch_' || $1))`, [safeBatchId]);

      if (idempotency_key || correlation_id) {
        const bRes = await client.query(
          `SELECT s.* FROM hr_employee_staging s 
           JOIN hr_intake_batches b ON s.batch_id = b.id 
           WHERE b.n8n_execution_id = $1 OR b.n8n_execution_id = $2
           ORDER BY s.created_at ASC, s.id ASC`,
          [idempotency_key || '', correlation_id || '']
        );
        if (bRes.rows.length > 0) existingStagingRows = bRes.rows;
      }
      if (existingStagingRows.length === 0 && safeBatchId) {
        const sRes = await client.query(
          `SELECT * FROM hr_employee_staging WHERE batch_id = $1 ORDER BY created_at ASC, id ASC`,
          [safeBatchId]
        );
        if (sRes.rows.length > 0) existingStagingRows = sRes.rows;
      }

      if (existingStagingRows.length > 0) {
        await client.query('COMMIT');
        client.release();

        const canApprove = await hasPermission(verifiedUser.role, 'hr.intake.approve');
        let replyCard = (existingStagingRows.length === 1)
          ? renderStagingPreview(existingStagingRows[0], canApprove)
          : renderBatchSummary(existingStagingRows, canApprove);

        return res.json({
          success: true,
          batch_id: existingStagingRows[0].batch_id,
          total_candidates: existingStagingRows.length,
          staged_count: existingStagingRows.filter(r => r.intake_mode !== 'insufficient_data' && r.intake_mode !== 'duplicate').length,
          failed_count: 0,
          candidate_results: existingStagingRows.map(r => ({
            staging_id: r.id,
            full_name: r.full_name,
            citizen_id: r.citizen_id,
            status: r.intake_mode === 'insufficient_data' ? 'insufficient_data' : (r.suspected_duplicate ? 'duplicate' : 'staged'),
            company_id: r.company_id
          })),
          reply_card: replyCard,
          idempotency_replayed: true
        });
      }

    // 3. Prepare Files and Candidate Groups
    const rawFiles = Array.isArray(files) ? files : [];
    let candidateGroups = [];

    const { isValidPersonName } = require('../services/vietnameseEncodingGuard');

    if (rawFiles.length > 0) {
      const singleFileResults = [];
      for (let idx = 0; idx < rawFiles.length; idx++) {
        const f = rawFiles[idx];
        const fileName = f.fileName || f.file_name || 'document.pdf';
        let rawExtracted = f.rawExtracted || f.extracted || {};
        let text = f.text || '';
        const ocrStatus = f.ocrStatus || (f.ocrError ? 'failed' : 'success');
        const ocrError = f.ocrError || null;

        if (text && (!rawExtracted.full_name || !rawExtracted.citizen_id)) {
          const fallbackExtracted = extractProfileFromText(text, fileName);
          rawExtracted = {
            ...fallbackExtracted,
            ...rawExtracted,
            full_name: (rawExtracted.full_name && rawExtracted.full_name !== 'Nhân viên mới')
              ? rawExtracted.full_name
              : (fallbackExtracted.full_name || null),
            citizen_id: (rawExtracted.citizen_id && String(rawExtracted.citizen_id).replace(/\D/g, '').length >= 9)
              ? String(rawExtracted.citizen_id).replace(/\D/g, '')
              : (fallbackExtracted.citizen_id || null)
          };
        }

        const docType = f.docType || classifyDocumentType(fileName, text);
        const cleanExtracted = {};
        const provenance = f.provenance ? { ...f.provenance } : {};

        for (const rawKey of Object.keys(rawExtracted)) {
          if (rawKey.startsWith('_')) continue;
          const canonicalKey = FIELD_ALIASES[rawKey] || rawKey;
          const normVal = normalizeFieldValue(canonicalKey, rawExtracted[rawKey]);
          cleanExtracted[canonicalKey] = normVal;
          if (normVal && !provenance[canonicalKey]) {
            provenance[canonicalKey] = {
              fileName,
              docType,
              originalValue: normVal
            };
          }
        }

        const cccdInfo = standardizeAndValidateCccd(cleanExtracted.citizen_id);
        if (cccdInfo.valid && cccdInfo.cleanCccd) {
          cleanExtracted.citizen_id = cccdInfo.cleanCccd;
        }

        const missingFields = [];
        const uncertainFields = Array.isArray(rawExtracted._uncertain_fields)
          ? [...rawExtracted._uncertain_fields]
          : (rawExtracted._uncertain_fields ? [String(rawExtracted._uncertain_fields)] : []);
        const unreadableFields = Array.isArray(rawExtracted._unreadable_fields)
          ? [...rawExtracted._unreadable_fields]
          : (rawExtracted._unreadable_fields ? [String(rawExtracted._unreadable_fields)] : []);

        const hasValidName = cleanExtracted.full_name &&
          cleanExtracted.full_name !== 'Nhân viên mới' &&
          cleanExtracted.full_name !== 'NHÂN VIÊN MỚI' &&
          isValidPersonName(cleanExtracted.full_name);

        if (!hasValidName) {
          if (!cleanExtracted.full_name || cleanExtracted.full_name === 'Nhân viên mới' || cleanExtracted.full_name === 'NHÂN VIÊN MỚI') {
            cleanExtracted.full_name = null;
            missingFields.push('full_name');
          } else {
            uncertainFields.push('full_name');
          }
        }

        if (!cccdInfo.valid || !cleanExtracted.citizen_id) {
          missingFields.push('citizen_id');
          uncertainFields.push('citizen_id');
        }

        if (ocrStatus === 'failed') {
          unreadableFields.push('entire_document');
        }

        const compDetection = detectCompany(cleanExtracted, text);

        singleFileResults.push({
          fileName,
          fileSize: f.fileSize || f.file_size || 0,
          mimeType: f.mimeType || f.mime_type || 'application/pdf',
          fileStoragePath: f.fileStoragePath || f.file_storage_path || null,
          rawText: text,
          extracted: cleanExtracted,
          docType,
          cccdInfo,
          compDetection,
          provenance,
          missingFields,
          uncertainFields,
          unreadableFields,
          ocrStatus,
          ocrError
        });
      }

      for (const item of singleFileResults) {
        const cccd = item.cccdInfo.cleanCccd;
        const normName = removeAccents(item.extracted.full_name || '');
        const dob = item.extracted.date_of_birth || '';

        let matchedGroup = null;
        if (cccd) {
          matchedGroup = candidateGroups.find(g => g.cccd === cccd);
        }
        if (!matchedGroup && normName && normName !== 'nhan vien moi') {
          matchedGroup = candidateGroups.find(g => {
            const gName = removeAccents(g.primaryExtracted.full_name || '');
            if (gName === normName) {
              if (dob && g.primaryExtracted.date_of_birth) {
                return g.primaryExtracted.date_of_birth === dob;
              }
              return true;
            }
            return false;
          });
        }

        if (matchedGroup) {
          matchedGroup.items.push(item);
          if (!matchedGroup.cccd && cccd) matchedGroup.cccd = cccd;
        } else {
          candidateGroups.push({
            cccd: cccd || null,
            primaryExtracted: { ...item.extracted },
            items: [item]
          });
        }
      }
    } else if (Array.isArray(candidates) && candidates.length > 0) {
      candidateGroups = candidates.map(c => {
        const mergedExt = c.merged_extracted || c;
        const cccdVal = c.citizen_id || c.cccd || mergedExt.citizen_id || null;
        return {
          cccd: cccdVal,
          primaryExtracted: mergedExt,
          items: c.items || [{
            fileName: c.combined_file_names || c.fileName || 'document.pdf',
            fileSize: c.total_size || c.fileSize || 0,
            mimeType: c.mime_type || 'application/pdf',
            fileStoragePath: c.file_storage_path || null,
            rawText: c.raw_text || '',
            extracted: mergedExt,
            docType: c.primary_doc_type || 'CCCD',
            cccdInfo: standardizeAndValidateCccd(cccdVal),
            compDetection: detectCompany(mergedExt, c.raw_text || ''),
            provenance: c.provenance || {},
            missingFields: c.missing_fields || [],
            uncertainFields: c.uncertain_fields || [],
            unreadableFields: c.unreadable_fields || [],
            ocrStatus: c.ocr_status || 'success'
          }]
        };
      });
    } else {
      return res.status(400).json({ success: false, error: 'Thiếu dữ liệu files hoặc candidates để xử lý.' });
    }

    // 4. PARTIAL SUCCESS PER CANDIDATE PROCESSING (Independent Sub-transactions)
    const candidateResults = [];
    const successfullyStagedRows = [];
    let stagedCount = 0;
    let insufficientCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;

    for (let cIdx = 0; cIdx < candidateGroups.length; cIdx++) {
      const grp = candidateGroups[cIdx];
      const items = grp.items;
      try {
        let mergedExtracted = {};
        const provenance = {};
        const conflicts = {};

        if (items.length === 1) {
          const it = items[0];
          mergedExtracted = { ...it.extracted };
          for (const k of Object.keys(mergedExtracted)) {
            if (mergedExtracted[k]) {
              provenance[k] = { fileName: it.fileName, docType: it.docType, originalValue: mergedExtracted[k] };
            }
          }
        } else {
          for (const field of CANONICAL_53_FIELDS) {
            if (field === 'Create_Time' || field === 'fileName') continue;
            const preferredTypes = FIELD_DOCUMENT_SOURCES[field] || [];
            const candidateValues = [];

            for (const it of items) {
              const val = it.extracted[field];
              if (val && String(val).trim() !== '') {
                candidateValues.push({ val, docType: it.docType, fileName: it.fileName });
              }
            }

            if (candidateValues.length === 0) {
              mergedExtracted[field] = '';
            } else if (candidateValues.length === 1) {
              mergedExtracted[field] = candidateValues[0].val;
              provenance[field] = { fileName: candidateValues[0].fileName, docType: candidateValues[0].docType };
            } else {
              const distinctVals = Array.from(new Set(candidateValues.map(c => c.val)));
              if (distinctVals.length > 1) {
                conflicts[field] = candidateValues.map(c => ({
                  source: c.fileName,
                  docType: c.docType,
                  value: c.val
                }));
              }
              let chosen = null;
              for (const prefType of preferredTypes) {
                chosen = candidateValues.find(c => c.docType === prefType);
                if (chosen) break;
              }
              if (!chosen) chosen = candidateValues[0];
              mergedExtracted[field] = chosen.val;
              provenance[field] = { fileName: chosen.fileName, docType: chosen.docType };
            }
          }
        }

        const combinedFileNames = items.length === 1
          ? items[0].fileName
          : `[Hồ sơ đa chứng từ: ${items.length} tệp] ` + items.map(it => it.fileName).join(', ');
        const totalSize = items.reduce((acc, it) => acc + (it.fileSize || 0), 0);
        const primaryDocType = items[0].docType || 'CCCD';
        const finalCccdInfo = grp.cccd ? standardizeAndValidateCccd(grp.cccd) : standardizeAndValidateCccd(mergedExtracted.citizen_id);
        const finalCompDetection = items.find(it => it.compDetection && it.compDetection.company_id)?.compDetection || items[0].compDetection || {};

        let finalCompanyId = finalCompDetection.company_id;
        let finalCompanyStatus = finalCompDetection.company_status || 'unknown';
        let finalCompanyEvidence = finalCompDetection.company_evidence || null;

        if (verifiedUser.role !== 'ADMIN' && verifiedUser.role !== 'SUPER_ADMIN' && verifiedUser.company_id) {
          finalCompanyId = verifiedUser.company_id;
          if (finalCompDetection.company_id && finalCompDetection.company_id !== verifiedUser.company_id && finalCompDetection.company_status === 'suggested') {
            finalCompanyStatus = 'conflict';
            finalCompanyEvidence = `Cảnh báo lệch đơn vị: Tài khoản thuộc ${verifiedUser.company_id}, nhưng tài liệu phát hiện từ khóa đơn vị ${finalCompDetection.company_id}.`;
          }
        } else if (!finalCompanyId) {
          finalCompanyId = verifiedUser.company_id || 'STL';
        }

        // Live Duplicate Check & Schema Validation against Postgres
        const validation = await validateStagingProfile(mergedExtracted, verifiedUser, finalCompDetection, finalCccdInfo);

        const fieldMetadata = buildSchemaMetadata(mergedExtracted, primaryDocType, provenance, conflicts, {
          unreadableFields: mergedExtracted._unreadable_fields || [],
          uncertainFields: validation.uncertain_fields || mergedExtracted._uncertain_fields || []
        });

        mergedExtracted._metadata = fieldMetadata;
        mergedExtracted._schema_metadata = fieldMetadata;
        mergedExtracted._provenance = provenance;
        mergedExtracted._conflicts = conflicts;
        mergedExtracted._document_types = items.map(it => it.docType);

        // Status Determination
        let candStatus = 'staged';
        const hasValidName = mergedExtracted.full_name &&
          mergedExtracted.full_name !== 'Nhân viên mới' &&
          mergedExtracted.full_name !== 'NHÂN VIÊN MỚI' &&
          isValidPersonName(mergedExtracted.full_name);

        if (!finalCccdInfo.valid || !hasValidName || validation.intake_mode === 'insufficient_data') {
          candStatus = 'insufficient_data';
          insufficientCount++;
        } else if (validation.suspected_duplicate || ['CROSS_COMPANY_DUPLICATE', 'ACTIVE_SAME_COMPANY_DUPLICATE'].includes(validation.duplicate_classification)) {
          candStatus = 'duplicate';
          duplicateCount++;
        } else if (validation.validation_errors && validation.validation_errors.some(e => e.blocking && e.code !== 'INSUFFICIENT_DATA')) {
          candStatus = 'validation_failed';
          failedCount++;
        } else {
          candStatus = 'staged';
          stagedCount++;
        }

        // Insert into hr_employee_staging (Sub-transaction per candidate)
        const insertStaging = await client.query(
          `INSERT INTO hr_employee_staging (
            batch_id, conversation_id, file_name, file_storage_path, file_size, mime_type,
            full_name, citizen_id, employee_code, date_of_birth, gender,
            job_title, department, email, phone_number, recruitment_decision_no,
            employment_start_date, base_salary, company_id, company_status, company_evidence,
            staging_status, missing_fields, uncertain_fields, suspected_duplicate, duplicate_reason,
            extracted_data, uploaded_by, uploaded_by_user_id,
            intake_mode, target_profile_id, target_employee_code, proposed_changes, version
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21,
            'pending_review', $22, $23, $24, $25,
            $26, $27, $28,
            $29, $30, $31, $32, 1
          ) RETURNING *`,
          [
            safeBatchId,
            validConvId,
            combinedFileNames,
            items[0].fileStoragePath || null,
            totalSize,
            items[0].mimeType || 'application/pdf',
            mergedExtracted.full_name || 'Nhân viên mới',
            finalCccdInfo.cleanCccd || null,
            mergedExtracted.employee_id || null,
            mergedExtracted.date_of_birth || null,
            mergedExtracted.gender || null,
            mergedExtracted.job_title || null,
            mergedExtracted.department_staffing_plan || null,
            mergedExtracted.email || null,
            mergedExtracted.phone_number || null,
            mergedExtracted.recruitment_decision_no || null,
            mergedExtracted.employment_start_date || null,
            mergedExtracted.base_salary || null,
            finalCompanyId,
            finalCompanyStatus,
            finalCompanyEvidence,
            validation.missing_fields || [],
            validation.uncertain_fields || [],
            !!validation.suspected_duplicate,
            validation.duplicate_reason || null,
            JSON.stringify(mergedExtracted),
            verifiedUser.username,
            verifiedUser.user_id,
            candStatus === 'insufficient_data' ? 'insufficient_data' : (validation.intake_mode || 'new_profile'),
            (validation.target_profile_id && !isNaN(parseInt(validation.target_profile_id, 10)) && !String(validation.target_profile_id).includes('-'))
              ? parseInt(validation.target_profile_id, 10)
              : null,
            validation.target_employee_code || null,
            JSON.stringify(validation.proposed_changes || {})
          ]
        );

        const stagedRow = insertStaging.rows[0];
        successfullyStagedRows.push(stagedRow);

        candidateResults.push({
          candidate_index: cIdx,
          full_name: stagedRow.full_name,
          citizen_id: stagedRow.citizen_id,
          status: candStatus,
          staging_id: stagedRow.id,
          company_id: stagedRow.company_id,
          validation: {
            missing_fields: validation.missing_fields,
            uncertain_fields: validation.uncertain_fields,
            suspected_duplicate: validation.suspected_duplicate,
            duplicate_reason: validation.duplicate_reason,
            intake_mode: validation.intake_mode
          }
        });
      } catch (candErr) {
        console.error(`[Candidate ${cIdx}] Lỗi xử lý candidate:`, candErr.message);
        failedCount++;
        candidateResults.push({
          candidate_index: cIdx,
          full_name: grp.primaryExtracted?.full_name || 'Không xác định',
          citizen_id: grp.cccd || null,
          status: 'processing_error',
          error: candErr.message
        });
      }
    }

    // 5. Batch Record
    try {
      await client.query(
        `INSERT INTO hr_intake_batches (
          id, company_id, uploaded_by, uploaded_by_user_id, total_files,
          file_manifest, status, n8n_execution_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [
          safeBatchId,
          verifiedUser.company_id || 'STL',
          verifiedUser.username,
          verifiedUser.user_id,
          rawFiles.length || candidateGroups.length,
          JSON.stringify(candidateResults),
          idempotency_key || correlation_id || null
        ]
      );
    } catch (batchErr) {
      console.warn('Lỗi ghi hr_intake_batches:', batchErr.message);
    }

    await client.query('COMMIT');
    client.release();

    // 6. Resilient Audit Logging
    await logAudit({
      actor_user_id: verifiedUser.user_id,
      actor_username: verifiedUser.username,
      action: 'HR_INTAKE_PROCESS_STAGED_CANDIDATE',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: {
        batch_id,
        total_candidates: candidateGroups.length,
        staged_count: stagedCount,
        insufficient_count: insufficientCount,
        duplicate_count: duplicateCount,
        failed_count: failedCount,
        correlation_id
      }
    });

    const canApprove = await hasPermission(verifiedUser.role, 'hr.intake.approve');
    let replyCard = '';
    if (successfullyStagedRows.length === 1) {
      replyCard = renderStagingPreview(successfullyStagedRows[0], canApprove);
    } else if (successfullyStagedRows.length > 1) {
      replyCard = renderBatchSummary(successfullyStagedRows, canApprove);
    }

    return res.json({
      success: true,
      batch_id,
      total_candidates: candidateGroups.length,
      staged_count: stagedCount,
      insufficient_count: insufficientCount,
      duplicate_count: duplicateCount,
      failed_count: failedCount,
      candidate_results: candidateResults,
      reply_card: replyCard,
      idempotency_replayed: false
    });
  } catch (err) {
    if (typeof client !== 'undefined' && client) {
      await client.query('ROLLBACK').catch(() => {});
      try { client.release(); } catch(e) {}
    }
    console.error('Lỗi process-staged-candidate internal:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 3. POST /api/hoso/intake/internal/normalize-canonical-fields
router.post('/internal/normalize-canonical-fields', verifyInternalAuth, async (req, res) => {
  try {
    const { batch_id, files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, error: 'files must be a non-empty array' });
    }

    const singleFileResults = new Array(files.length);
    const FILE_CONCURRENCY = Math.min(2, files.length);

    async function processFileItem(idx) {
      const f = files[idx];
      const fileName = f.fileName || f.file_name || 'document.pdf';
      let rawExtracted = f.rawExtracted || f.extracted || {};
      let text = f.text || '';
      const ocrStatus = f.ocrStatus || (f.ocrError ? 'failed' : 'success');
      const ocrError = f.ocrError || null;

      // Pure text parsing fallback if text is provided and rawExtracted lacks fields (no local OCR)
      if (text && (!rawExtracted.full_name || !rawExtracted.citizen_id)) {
        const fallbackExtracted = extractProfileFromText(text, fileName);
        rawExtracted = {
          ...fallbackExtracted,
          ...rawExtracted,
          full_name: (rawExtracted.full_name && rawExtracted.full_name !== 'Nhân viên mới')
            ? rawExtracted.full_name
            : (fallbackExtracted.full_name || null),
          citizen_id: (rawExtracted.citizen_id && String(rawExtracted.citizen_id).replace(/\D/g, '').length >= 9)
            ? String(rawExtracted.citizen_id).replace(/\D/g, '')
            : (fallbackExtracted.citizen_id || null)
        };
      }

      const docType = f.docType || classifyDocumentType(fileName, text);

      // Clean & normalize 53 canonical fields
      const cleanExtracted = {};
      const provenance = f.provenance ? { ...f.provenance } : {};

      for (const rawKey of Object.keys(rawExtracted)) {
        if (rawKey.startsWith('_')) continue;
        const canonicalKey = FIELD_ALIASES[rawKey] || rawKey;
        const normVal = normalizeFieldValue(canonicalKey, rawExtracted[rawKey]);
        cleanExtracted[canonicalKey] = normVal;
        if (normVal && !provenance[canonicalKey]) {
          provenance[canonicalKey] = {
            fileName,
            docType,
            originalValue: normVal
          };
        }
      }

      // Standardize and validate CCCD
      const cccdInfo = standardizeAndValidateCccd(cleanExtracted.citizen_id);
      if (cccdInfo.valid && cccdInfo.cleanCccd) {
        cleanExtracted.citizen_id = cccdInfo.cleanCccd;
      }

      // Track missing, uncertain, unreadable fields
      const missingFields = [];
      const uncertainFields = Array.isArray(rawExtracted._uncertain_fields)
        ? [...rawExtracted._uncertain_fields]
        : (rawExtracted._uncertain_fields ? [String(rawExtracted._uncertain_fields)] : []);

      const unreadableFields = Array.isArray(rawExtracted._unreadable_fields)
        ? [...rawExtracted._unreadable_fields]
        : (rawExtracted._unreadable_fields ? [String(rawExtracted._unreadable_fields)] : []);

      const { isValidPersonName } = require('../services/vietnameseEncodingGuard');
      const hasValidName = cleanExtracted.full_name &&
        cleanExtracted.full_name !== 'Nhân viên mới' &&
        cleanExtracted.full_name !== 'NHÂN VIÊN MỚI' &&
        isValidPersonName(cleanExtracted.full_name);

      if (!hasValidName) {
        if (!cleanExtracted.full_name || cleanExtracted.full_name === 'Nhân viên mới' || cleanExtracted.full_name === 'NHÂN VIÊN MỚI') {
          cleanExtracted.full_name = null;
          missingFields.push('full_name');
        } else {
          uncertainFields.push('full_name');
        }
      }

      if (!cccdInfo.valid || !cleanExtracted.citizen_id) {
        missingFields.push('citizen_id');
        uncertainFields.push('citizen_id');
      }

      if (ocrStatus === 'failed') {
        unreadableFields.push('entire_document');
      }

      const compDetection = detectCompany(cleanExtracted, text);

      singleFileResults[idx] = {
        fileName,
        fileSize: f.fileSize || f.file_size || 0,
        mimeType: f.mimeType || f.mime_type || 'application/pdf',
        fileStoragePath: f.fileStoragePath || f.file_storage_path || null,
        rawText: text,
        extracted: cleanExtracted,
        docType,
        cccdInfo,
        compDetection,
        provenance,
        missingFields,
        uncertainFields,
        unreadableFields,
        ocrStatus,
        ocrError,
        manualCheckRequired: missingFields.length > 0 || ocrStatus === 'failed' || uncertainFields.length > 0
      };
    }

    let fileIdx = 0;
    const fileWorkers = Array.from({ length: FILE_CONCURRENCY }, async () => {
      while (fileIdx < files.length) {
        const current = fileIdx++;
        await processFileItem(current);
      }
    });
    await Promise.all(fileWorkers);

    // Group by Candidate (Multi-Document Dossier Merging)
    const candidateGroups = [];
    for (const item of singleFileResults) {
      if (!item) continue;
      const cccd = item.cccdInfo.cleanCccd;
      const normName = removeAccents(item.extracted.full_name || '');
      const dob = item.extracted.date_of_birth || '';

      let matchedGroup = null;
      if (cccd) {
        matchedGroup = candidateGroups.find(g => g.cccd === cccd);
      }
      if (!matchedGroup && normName && normName !== 'nhan vien moi') {
        matchedGroup = candidateGroups.find(g => {
          const gName = removeAccents(g.primaryExtracted.full_name || '');
          if (gName === normName) {
            if (dob && g.primaryExtracted.date_of_birth) {
              return g.primaryExtracted.date_of_birth === dob;
            }
            return true;
          }
          return false;
        });
      }

      if (matchedGroup) {
        matchedGroup.items.push(item);
        if (!matchedGroup.cccd && cccd) matchedGroup.cccd = cccd;
      } else {
        candidateGroups.push({
          cccd: cccd || null,
          primaryExtracted: { ...item.extracted },
          items: [item]
        });
      }
    }

    // Process merged dossier for each group
    const processedGroups = [];
    for (const grp of candidateGroups) {
      const items = grp.items;
      let mergedExtracted = {};
      const provenance = {};
      const conflicts = {};

      if (items.length === 1) {
        const it = items[0];
        mergedExtracted = { ...it.extracted };
        for (const k of Object.keys(mergedExtracted)) {
          if (mergedExtracted[k]) {
            provenance[k] = { fileName: it.fileName, docType: it.docType, originalValue: mergedExtracted[k] };
          }
        }
      } else {
        for (const field of CANONICAL_53_FIELDS) {
          if (field === 'Create_Time' || field === 'fileName') continue;
          const preferredTypes = FIELD_DOCUMENT_SOURCES[field] || [];
          const candidateValues = [];

          for (const it of items) {
            const val = it.extracted[field];
            if (val && String(val).trim() !== '') {
              candidateValues.push({
                val,
                docType: it.docType,
                fileName: it.fileName
              });
            }
          }

          if (candidateValues.length === 0) {
            mergedExtracted[field] = '';
          } else if (candidateValues.length === 1) {
            mergedExtracted[field] = candidateValues[0].val;
            provenance[field] = { fileName: candidateValues[0].fileName, docType: candidateValues[0].docType };
          } else {
            const distinctVals = Array.from(new Set(candidateValues.map(c => c.val)));
            if (distinctVals.length > 1) {
              conflicts[field] = candidateValues.map(c => ({
                source: c.fileName,
                docType: c.docType,
                value: c.val
              }));
            }

            let chosen = null;
            for (const prefType of preferredTypes) {
              chosen = candidateValues.find(c => c.docType === prefType);
              if (chosen) break;
            }
            if (!chosen) chosen = candidateValues[0];

            mergedExtracted[field] = chosen.val;
            provenance[field] = { fileName: chosen.fileName, docType: chosen.docType };
          }
        }
      }

      const combinedFileNames = items.length === 1
        ? items[0].fileName
        : `[Hồ sơ đa chứng từ: ${items.length} tệp] ` + items.map(it => it.fileName).join(', ');
      const totalSize = items.reduce((acc, it) => acc + (it.fileSize || 0), 0);
      const primaryDocType = items[0].docType;
      const finalCccdInfo = standardizeAndValidateCccd(mergedExtracted.citizen_id);
      const finalCompDetection = items.find(it => it.compDetection.company_id)?.compDetection || items[0].compDetection;

      const groupMissing = Array.from(new Set(items.flatMap(it => it.missingFields || [])));
      const groupUncertain = Array.from(new Set(items.flatMap(it => it.uncertainFields || [])));
      const groupUnreadable = Array.from(new Set(items.flatMap(it => it.unreadableFields || [])));
      const groupOcrFailed = items.some(it => it.ocrStatus === 'failed');
      const manualCheckRequired = groupMissing.length > 0 || groupOcrFailed || Object.keys(conflicts).length > 0 || !finalCccdInfo.valid || !mergedExtracted.full_name;

      processedGroups.push({
        cccd: grp.cccd,
        combined_file_names: combinedFileNames,
        file_storage_path: items[0].fileStoragePath || null,
        total_size: totalSize,
        mime_type: items[0].mimeType || 'application/pdf',
        primary_doc_type: primaryDocType,
        merged_extracted: mergedExtracted,
        provenance,
        conflicts,
        doc_types: items.map(it => it.docType),
        final_cccd_info: finalCccdInfo,
        final_comp_detection: finalCompDetection,
        raw_text: items.map(it => it.rawText).filter(Boolean).join('\n---\n'),
        missing_fields: groupMissing,
        uncertain_fields: groupUncertain,
        unreadable_fields: groupUnreadable,
        manual_check_required: manualCheckRequired,
        ocr_status: groupOcrFailed ? 'failed' : 'success'
      });
    }

    return res.json({
      success: true,
      batch_id,
      candidate_groups: processedGroups,
      manual_check_required: processedGroups.some(g => g.manual_check_required)
    });
  } catch (err) {
    console.error('Lỗi normalize-canonical-fields internal:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. POST /api/hoso/intake/internal/validate-duplicates
router.post('/internal/validate-duplicates', verifyInternalAuth, async (req, res) => {
  try {
    const { candidate, candidates, user } = req.body || {};
    if ((!candidate && (!Array.isArray(candidates) || candidates.length === 0)) || !user) {
      return res.status(400).json({ success: false, error: 'Thiếu dữ liệu candidate hoặc user' });
    }

    const targetCandidates = Array.isArray(candidates) && candidates.length > 0 ? candidates : [candidate];
    const validatedCandidates = [];

    for (const cand of targetCandidates) {
      const mergedExtracted = cand.merged_extracted || cand;
      const finalCccdInfo = cand.final_cccd_info || standardizeAndValidateCccd(mergedExtracted.citizen_id);
      const finalCompDetection = cand.final_comp_detection || detectCompany(mergedExtracted, cand.raw_text || '');

      let finalCompanyId = finalCompDetection.company_id;
      let finalCompanyStatus = finalCompDetection.company_status;
      let finalCompanyEvidence = finalCompDetection.company_evidence;

      if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN' && user.company_id) {
        finalCompanyId = user.company_id;
        if (finalCompDetection.company_id && finalCompDetection.company_id !== user.company_id && finalCompDetection.company_status === 'suggested') {
          finalCompanyStatus = 'conflict';
          finalCompanyEvidence = `Cảnh báo lệch đơn vị: Tài khoản thuộc ${user.company_id}, nhưng tài liệu phát hiện từ khóa đơn vị ${finalCompDetection.company_id}.`;
        }
      }

      const validation = await validateStagingProfile(mergedExtracted, user, finalCompDetection, finalCccdInfo);

      const primaryDocType = cand.primary_doc_type || 'CCCD';
      const provenance = cand.provenance || {};
      const conflicts = cand.conflicts || {};

      const fieldMetadata = buildSchemaMetadata(mergedExtracted, primaryDocType, provenance, conflicts, {
        unreadableFields: mergedExtracted._unreadable_fields || [],
        uncertainFields: validation.uncertain_fields || mergedExtracted._uncertain_fields || []
      });

      mergedExtracted._metadata = fieldMetadata;
      mergedExtracted._schema_metadata = fieldMetadata;
      mergedExtracted._provenance = provenance;
      mergedExtracted._conflicts = conflicts;
      if (cand.doc_types) {
        mergedExtracted._document_types = cand.doc_types;
      }

      validatedCandidates.push({
        ...cand,
        combined_file_names: cand.combined_file_names || cand.fileName || 'Tài liệu hồ sơ',
        file_storage_path: cand.file_storage_path || cand.fileStoragePath,
        total_size: cand.total_size || cand.fileSize || 0,
        mime_type: cand.mime_type || cand.mimeType || 'application/pdf',
        final_company_id: finalCompanyId,
        final_company_status: finalCompanyStatus,
        final_company_evidence: finalCompanyEvidence,
        final_cccd_info: finalCccdInfo,
        field_metadata: fieldMetadata,
        validation: {
          missing_fields: validation.missing_fields,
          uncertain_fields: validation.uncertain_fields,
          suspected_duplicate: validation.suspected_duplicate,
          duplicate_reason: validation.duplicate_reason,
          intake_mode: validation.intake_mode,
          target_profile_id: validation.target_profile_id,
          target_employee_code: validation.target_employee_code,
          proposed_changes: validation.proposed_changes,
          duplicate_check: validation.duplicate_check
        },
        merged_extracted: mergedExtracted
      });
    }

    const primaryResult = validatedCandidates[0] || {};
    return res.json({
      success: true,
      validated_candidates: validatedCandidates,
      primary_candidate: primaryResult,
      final_company_id: primaryResult.final_company_id,
      final_company_status: primaryResult.final_company_status,
      final_company_evidence: primaryResult.final_company_evidence,
      final_cccd_info: primaryResult.final_cccd_info,
      field_metadata: primaryResult.field_metadata,
      validation: primaryResult.validation,
      merged_extracted: primaryResult.merged_extracted
    });
  } catch (err) {
    console.error('Lỗi validate-duplicates internal:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. POST /api/hoso/intake/internal/persist-staging
router.post('/internal/persist-staging', verifyInternalAuth, async (req, res) => {
  try {
    const {
      batch_id,
      correlation_id,
      idempotency_key,
      conversation_id,
      user,
      candidates
    } = req.body || {};

    if (!batch_id || !user || !Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ success: false, error: 'Thiếu batch_id, user hoặc candidates hợp lệ.' });
    }

    const safeBatchId = toValidUUID(batch_id) || require('crypto').randomUUID();

    let validConvId = toValidUUID(conversation_id);
    if (validConvId) {
      try {
        const convCheck = await db.query(`SELECT id FROM ai_conversations WHERE id = $1`, [validConvId]);
        if (convCheck.rows.length === 0) validConvId = null;
      } catch(e) { validConvId = null; }
    }

    // IDEMPOTENCY CHECK:
    // If records already exist for this idempotency_key, correlation_id or batch_id, return them without re-inserting!
    let existingStagingRows = [];
    if (idempotency_key || correlation_id) {
      const bRes = await db.query(
        `SELECT s.* FROM hr_employee_staging s 
         JOIN hr_intake_batches b ON s.batch_id = b.id 
         WHERE b.n8n_execution_id = $1 OR b.n8n_execution_id = $2
         ORDER BY s.created_at ASC, s.id ASC`,
        [idempotency_key || '', correlation_id || '']
      );
      if (bRes.rows.length > 0) existingStagingRows = bRes.rows;
    }
    if (existingStagingRows.length === 0 && safeBatchId) {
      const sRes = await db.query(
        `SELECT * FROM hr_employee_staging WHERE batch_id = $1 ORDER BY created_at ASC, id ASC`,
        [safeBatchId]
      );
      if (sRes.rows.length > 0) existingStagingRows = sRes.rows;
    }

    if (existingStagingRows.length > 0) {
      const stagedResults = existingStagingRows;
      const canApprove = await hasPermission(user.role, 'hr.intake.approve');
      let replyCard = '';
      if (stagedResults.length === 1) {
        replyCard = renderStagingPreview(stagedResults[0], canApprove);
      } else {
        replyCard = renderBatchSummary(stagedResults, canApprove);
      }

      return res.json({
        success: true,
        batch_id: stagedResults[0].batch_id,
        staged_count: stagedResults.length,
        staged_results: stagedResults,
        reply_card: replyCard,
        idempotency_replayed: true
      });
    }

    // Insert batch into hr_intake_batches
    try {
      await db.query(
        `INSERT INTO hr_intake_batches (
          id, company_id, uploaded_by, uploaded_by_user_id, total_files,
          file_manifest, status, n8n_execution_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [
          safeBatchId,
          user.company_id || 'STL',
          user.username,
          user.user_id,
          candidates.length,
          JSON.stringify(candidates.map(c => ({
            name: c.combined_file_names,
            size: c.total_size,
            storage_path: c.file_storage_path
          }))),
          idempotency_key || correlation_id || null
        ]
      );
    } catch (batchErr) {
      console.warn('Lỗi ghi hr_intake_batches:', batchErr.message);
    }

    // Insert each candidate into hr_employee_staging
    const stagedResults = [];
    for (const cand of candidates) {
      const mergedExtracted = cand.merged_extracted || {};
      const validation = cand.validation || {};
      const finalCccdInfo = cand.final_cccd_info || {};

      const insertStaging = await db.query(
        `INSERT INTO hr_employee_staging (
          batch_id, conversation_id, file_name, file_storage_path, file_size, mime_type,
          full_name, citizen_id, employee_code, date_of_birth, gender,
          job_title, department, email, phone_number, recruitment_decision_no,
          employment_start_date, base_salary, company_id, company_status, company_evidence,
          staging_status, missing_fields, uncertain_fields, suspected_duplicate, duplicate_reason,
          extracted_data, uploaded_by, uploaded_by_user_id,
          intake_mode, target_profile_id, target_employee_code, proposed_changes, version
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21,
          'pending_review', $22, $23, $24, $25,
          $26, $27, $28,
          $29, $30, $31, $32, 1
        ) RETURNING *`,
        [
          safeBatchId,
          validConvId,
          cand.combined_file_names || 'Tài liệu hồ sơ',
          cand.file_storage_path || null,
          cand.total_size || 0,
          cand.mime_type || 'application/pdf',
          mergedExtracted.full_name || 'Nhân viên mới',
          finalCccdInfo.cleanCccd || null,
          mergedExtracted.employee_id || null,
          mergedExtracted.date_of_birth || null,
          mergedExtracted.gender || null,
          mergedExtracted.job_title || null,
          mergedExtracted.department_staffing_plan || null,
          mergedExtracted.email || null,
          mergedExtracted.phone_number || null,
          mergedExtracted.recruitment_decision_no || null,
          mergedExtracted.employment_start_date || null,
          mergedExtracted.base_salary || null,
          cand.final_company_id || user.company_id || 'STL',
          cand.final_company_status || 'unknown',
          cand.final_company_evidence || null,
          validation.missing_fields || [],
          validation.uncertain_fields || [],
          !!validation.suspected_duplicate,
          validation.duplicate_reason || null,
          JSON.stringify(mergedExtracted),
          user.username,
          user.user_id,
          validation.intake_mode || 'new_profile',
          (validation.target_profile_id && !isNaN(parseInt(validation.target_profile_id, 10)) && !String(validation.target_profile_id).includes('-'))
            ? parseInt(validation.target_profile_id, 10)
            : null,
          validation.target_employee_code || null,
          JSON.stringify(validation.proposed_changes || {})
        ]
      );

      stagedResults.push(insertStaging.rows[0]);
    }

    stagedResults.sort((a, b) => {
      const tA = new Date(a.created_at || 0).getTime();
      const tB = new Date(b.created_at || 0).getTime();
      if (tA !== tB) return tA - tB;
      const fA = String(a.file_name || '');
      const fB = String(b.file_name || '');
      if (fA !== fB) return fA.localeCompare(fB);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

    const canApprove = await hasPermission(user.role, 'hr.intake.approve');
    let replyCard = '';
    if (stagedResults.length === 1) {
      replyCard = renderStagingPreview(stagedResults[0], canApprove);
    } else {
      replyCard = renderBatchSummary(stagedResults, canApprove);
    }

    await logAudit({
      actor_user_id: user.user_id,
      actor_username: user.username,
      action: 'HR_INTAKE_UPLOAD_SUCCESS',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: { batch_id, candidate_count: stagedResults.length, correlation_id }
    });

    return res.json({
      success: true,
      batch_id,
      staged_count: stagedResults.length,
      staged_results: stagedResults,
      reply_card: replyCard,
      idempotency_replayed: false
    });
  } catch (err) {
    console.error('Lỗi persist-staging internal:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 6. [DEPRECATED / REMOVED in Post-Phase 1.2]: POST /api/hoso/intake/internal/extract-text-fallback
// Proved 0 callers across all workflows, frontend, and tests.
router.post('/internal/extract-text-fallback', verifyInternalAuth, (req, res) => {
  return res.status(410).json({
    success: false,
    error: '410 Gone: Endpoint /internal/extract-text-fallback đã bị loại bỏ. Toàn bộ trích xuất nội dung do n8n Gemini OCR và backend normalizer phụ trách.'
  });
});

// 6b. POST /api/hoso/intake/internal/ocr-document (Multi-Page OCR & Canonical Extraction)
router.post('/internal/ocr-document', verifyInternalAuth, async (req, res) => {
  try {
    const enableOcrFallback = process.env.ENABLE_BACKEND_OCR_FALLBACK === 'true';
    if (!enableOcrFallback) {
      return res.status(403).json({
        success: false,
        fallback_disabled: true,
        error: 'Backend OCR fallback endpoint is disabled. OCR orchestration is exclusively handled by n8n Gemini 3.1 Flash-Lite workflow.'
      });
    }

    const { fileStoragePath, fileName } = req.body || {};
    if (!fileStoragePath) {
      return res.status(400).json({ success: false, error: 'fileStoragePath is required' });
    }
    const baseName = path.basename(fileStoragePath);
    const cleanBase = baseName.replace(/^[0-9a-fA-F-]+_/, '');
    const candidates = [
      path.resolve(__dirname, '..', fileStoragePath.replace(/^\/app\//, '')),
      path.resolve(__dirname, '..', 'chat-files', fileStoragePath.replace(/^\/app\//, '')),
      path.resolve(__dirname, '..', 'chat-files', 'staging', baseName),
      path.resolve(__dirname, '..', 'uploads', 'staging', baseName),
      path.resolve(__dirname, '..', 'uploads', 'staging', cleanBase)
    ];

    let foundPath = null;
    for (const p of candidates) {
      if (fs.existsSync(p) && fs.statSync(p).size > 100) {
        foundPath = p;
        break;
      }
    }

    if (!foundPath) {
      const uploadsStaging = path.resolve(__dirname, '..', 'uploads', 'staging');
      if (fs.existsSync(uploadsStaging)) {
        const filesInUploads = fs.readdirSync(uploadsStaging);
        const match = filesInUploads.find(fn => fn.endsWith(cleanBase) || fn.includes(cleanBase));
        if (match) {
          const mp = path.join(uploadsStaging, match);
          if (fs.statSync(mp).size > 100) foundPath = mp;
        }
      }
    }

    if (!foundPath) {
      return res.status(404).json({ success: false, error: `File not found on disk: ${fileStoragePath}` });
    }

    const multiPageOcrEngine = require('../services/multiPageOcrEngine');
    const result = await multiPageOcrEngine.processDocumentMultiPage(foundPath, { fileName: fileName || baseName });
    return res.json(result);
  } catch (err) {
    console.error('[Internal-OCR-Document] Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 7. POST /api/hoso/intake/internal/audit-log
router.post('/internal/audit-log', verifyInternalAuth, async (req, res) => {
  try {
    const { actor_user_id, actor_username, action, status, metadata } = req.body || {};
    await logAudit({
      actor_user_id: actor_user_id || null,
      actor_username: actor_username || 'system',
      action: action || 'N8N_INTAKE_LIFECYCLE_EVENT',
      status: status || 'INFO',
      ip_address: req.ip,
      metadata: metadata || {}
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('Lỗi audit-log internal:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// 8. GET /api/hoso/intake/batch/:batchId (Tenant Isolation & Batch Lookup)
router.get('/batch/:batchId', verifyToken, async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!batchId) return res.status(400).json({ success: false, error: 'Thiếu batch ID.' });

    const result = await db.query(
      `SELECT * FROM hr_employee_staging WHERE batch_id = $1 LIMIT 1`,
      [batchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: '404 Not Found: Không tìm thấy hồ sơ batch.' });
    }

    const item = result.rows[0];
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.company_id && item.company_id && item.company_id.toUpperCase() !== req.user.company_id.toUpperCase()) {
      return res.status(403).json({
        success: false,
        error: `403 Forbidden: Bạn không có quyền truy cập hồ sơ thuộc đơn vị ${item.company_id}.`
      });
    }

    return res.json({ success: true, item });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 9. POST /api/hoso/intake/internal/execute-batch-ocr (Protected Internal Trigger)
router.post('/internal/execute-batch-ocr', verifyInternalAuth, async (req, res) => {
  return res.json({ success: true, message: 'Internal batch OCR trigger acknowledged.' });
});

// 10. POST /api/hoso/intake/internal/execute-sync-step (Protected Sequential Sync Step)
router.post('/internal/execute-sync-step', verifyInternalAuth, async (req, res) => {
  try {
    const { sync_task_id, task_id } = req.body || {};
    const tid = sync_task_id || task_id;
    if (!tid) return res.status(400).json({ success: false, error: 'Thiếu task_id' });

    const { processSyncTask } = require('../services/syncWorker');
    await processSyncTask(tid);

    const checkRes = await db.query('SELECT * FROM hr_sync_tasks WHERE id = $1', [tid]);
    return res.json({ success: true, task: checkRes.rows[0] });
  } catch (err) {
    console.error('Lỗi execute-sync-step:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 11. POST /api/hoso/intake/internal/scan-failed-sync (Protected Recovery Scanner)
router.post('/internal/scan-failed-sync', verifyInternalAuth, async (req, res) => {
  try {
    const { pollPendingSyncTasks } = require('../services/syncWorker');
    await pollPendingSyncTasks();
    return res.json({ success: true, message: 'Recovery scan completed.' });
  } catch (err) {
    console.error('Lỗi scan-failed-sync:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = {
  router,
  handleIntakeConversationalMessage,
  validateItemForApproval,
  findStagingItemByTarget,
  doApprovalForItems,
  executeStagingApproval,
  extractProfileFromText
};
