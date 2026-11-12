const express = require('express');
const router = express.Router();
const http = require('http');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { verifyToken, hasPermission } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { chatRateLimiter } = require('../middleware/rateLimiter');
const { handleIntakeConversationalMessage } = require('./intake');
const { handleRestoreConversationalIntent } = require('../services/employeeRestoreService');
const { handleEmployeeLookupIntent } = require('../services/employeeLookupService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 }
});

// Helper to remove accents for normalized string matching
function removeAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

// POST /api/hoso/chat - Authenticated & RBAC-enforced HoSo Chatbot endpoint
router.post('/chat', verifyToken, upload.any(), chatRateLimiter, async (req, res) => {
  try {
    // SEC-03: Strip client-spoofed internal verification headers
    if (req.headers) {
      for (const h of Object.keys(req.headers)) {
        if (h.startsWith('x-verified-') || h.startsWith('x-internal-')) {
          delete req.headers[h];
        }
      }
    }

    const message = String(req.body.message || req.body.text || '').trim();
    const sessionId = req.body.sessionId || req.body.chat_id || 'web';
    const files = req.files || [];

  if (!message && (!files || files.length === 0)) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập nội dung câu hỏi hoặc tải lên tệp hồ sơ.' });
  }

  // 1. Kiểm tra 2 quyền độc lập: query_all vs query_self
  const canQueryAll = await hasPermission(req.user.role, 'hr.chatbot.query_all');
  const canQuerySelf = await hasPermission(req.user.role, 'hr.chatbot.query_self');

  if (!canQueryAll && !canQuerySelf) {
    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_CHAT_FORBIDDEN',
      status: 'BLOCKED',
      ip_address: req.ip,
      metadata: { role: req.user.role, reason: 'Tài khoản không có quyền truy cập hồ sơ nhân sự' }
    });
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Tài khoản của bạn không có quyền truy cập Chatbot Hồ sơ Nhân sự.'
    });
  }

  // =========================================================================
  // TRƯỜNG HỢP 1: EMPLOYEE SELF-SERVICE (Chỉ có quyền hr.chatbot.query_self)
  // =========================================================================
  if (!canQueryAll && canQuerySelf) {
    const userEmpCode = (req.user.employee_code || '').trim();
    const userCitizenId = (req.user.citizen_id || '').trim();
    const userEmpName = (req.user.employee_name || req.user.username || '').trim();
    const userCompany = (req.user.company_id || '').trim();

    // Không cho phép tải lên file đính kèm để trích xuất hồ sơ người khác
    if (files && files.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Chức năng tải file bóc tách hồ sơ hàng loạt chỉ dành cho Quản trị viên và Chuyên viên Nhân sự (HR).'
      });
    }

    const msgNorm = removeAccents(message);
    const userNorm = removeAccents(userEmpName);
    const codeNorm = userEmpCode.toLowerCase();

    // 1. Kiểm tra đối chiếu xem câu hỏi có chứa tên hoặc mã của bất kỳ nhân sự nào khác trong DB không
    let queriedOtherPerson = null;
    try {
      const otherPersonCheck = await db.query(
        `SELECT full_name, employee_id FROM hr_employee_profiles 
         WHERE (employee_id <> $1) AND (
           ($2 ILIKE '%' || full_name || '%' AND full_name <> '') OR 
           ($2 ILIKE '%' || employee_id || '%' AND employee_id <> '')
         )
         LIMIT 1`,
        [userEmpCode, message]
      );
      if (otherPersonCheck.rows.length > 0) {
        queriedOtherPerson = otherPersonCheck.rows[0];
      }
    } catch (e) {
      console.error('Lỗi kiểm tra nhân sự khác:', e);
    }

    // 2. Phát hiện ý định tra cứu danh sách hoặc người khác:
    const collectiveKeywords = [
      'danh sach', 'tat ca', 'toan bo', 'liet ke', 'ai la', 'bao nhieu nguoi',
      'cac nhan vien', 'nhan su hien co', 'show all', 'nhan vien khac',
      'vietranstimex', 'sotrans', 'sowatco', 'vtx', 'stl', 'swc', 'nguoi khac'
    ];
    const isCollective = collectiveKeywords.some(kw => msgNorm.includes(kw));

    // 3. Phát hiện mã nhân viên khác trong câu hỏi
    const codeMatch = message.match(/\b([A-Za-z]{2,5}[-_]\d+)\b/);
    const isOtherCode = codeMatch && codeMatch[1].toLowerCase() !== codeNorm;

    // 4. Phát hiện Prompt injection
    const isInjection = msgNorm.includes('bo qua') || msgNorm.includes('ignore') || msgNorm.includes('giam doc') || msgNorm.includes('admin') || msgNorm.includes('tro ly');

    const isQueryingOthers = queriedOtherPerson || isCollective || isOtherCode || isInjection;

    if (isQueryingOthers) {
      const targetHint = queriedOtherPerson ? ` (${queriedOtherPerson.full_name})` : '';
      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'HR_QUERY_SELF_BLOCKED_CROSS_USER',
        status: 'BLOCKED',
        ip_address: req.ip,
        metadata: { question: message, userEmpCode, userEmpName, targetHint }
      });

      return res.json({
        reply: `⚠️ **Thông báo từ chối truy cập**: Bạn đang sử dụng chức năng **Tra cứu Hồ sơ Cá nhân (Employee Self-Service)**.\n\nTài khoản của bạn (**${userEmpCode || 'N/A'} - ${userEmpName}**) chỉ được phép tra cứu thông tin hồ sơ của chính mình. Hệ thống **từ chối** tra cứu danh sách hoặc thông tin của nhân sự khác${targetHint} theo chính sách bảo mật dữ liệu doanh nghiệp.`,
        table: null,
        self_service: true
      });
    }

    // Tra cứu hồ sơ của chính nhân viên này từ cơ sở dữ liệu (chỉ khớp theo citizen_id hoặc employee_code, tuyệt đối không khớp theo tên)
    let profile = null;
    try {
      const pRes = await db.query(
        `SELECT * FROM hr_employee_profiles
         WHERE (
           ($1::varchar <> '' AND citizen_id = $1::varchar) OR
           ($2::varchar <> '' AND employee_id = $2::varchar) OR
           ($2::varchar <> '' AND citizen_id = $2::varchar)
         ) AND company_id = $3
         ORDER BY id DESC LIMIT 1`,
        [userCitizenId, userEmpCode, userCompany]
      );
      if (pRes.rows.length > 0) {
        profile = pRes.rows[0];
      } else {
        const eRes = await db.query(
          `SELECT * FROM employees
           WHERE (
             ($1::varchar <> '' AND citizen_id = $1::varchar) OR
             ($2::varchar <> '' AND employee_code = $2::varchar) OR
             ($2::varchar <> '' AND citizen_id = $2::varchar)
           ) AND company_id = $3
           LIMIT 1`,
          [userCitizenId, userEmpCode, userCompany]
        );
        if (eRes.rows.length > 0) profile = eRes.rows[0];
      }
    } catch (dbErr) {
      console.error('Lỗi truy vấn hồ sơ self-service:', dbErr);
    }

    if (!profile) {
      return res.json({
        reply: `Chào bạn **${userEmpName}**, hệ thống xác thực bạn thuộc đơn vị **${userCompany}** (Mã: \`${userEmpCode || 'Chưa liên kết'}\`). Hiện chưa tìm thấy bản ghi hồ sơ chi tiết của bạn trong cơ sở dữ liệu nhân sự. Vui lòng liên hệ bộ phận HR để cập nhật.`,
        table: null,
        self_service: true
      });
    }

    // Áp dụng ALLOWLIST và MASKING dữ liệu nhạy cảm
    const fullName = profile.full_name || profile.employee_name || userEmpName;
    const empId = profile.employee_id || profile.employee_code || userEmpCode;
    const dept = profile.department_staffing_plan || profile.department || 'Đang cập nhật';
    const jobTitle = profile.job_title || profile.position || 'Nhân viên';
    const email = profile.email || 'Chưa cập nhật';
    const phone = profile.phone_number || 'Chưa cập nhật';
    const startDate = profile.contract_start_date || profile.employment_start_date || 'Theo hợp đồng lao động';
    const contract = profile.fixed_term_contract || profile.open_ended_contract || 'Hợp đồng lao động';
    const compName = req.user.company_name || userCompany;

    // Masking CCCD: Chỉ hiện 3 số đầu và 3 số cuối (ví dụ: 079******456)
    let maskedCccd = 'Chưa cập nhật';
    if (profile.citizen_id) {
      const rawCccd = String(profile.citizen_id).trim();
      if (rawCccd.length >= 6) {
        maskedCccd = rawCccd.substring(0, 3) + '******' + rawCccd.substring(rawCccd.length - 3);
      } else {
        maskedCccd = '******';
      }
    }

    const salaryNote = '🔒 *Lưu ý bảo mật: Thông tin chi tiết về mức lương, thưởng và thu nhập là dữ liệu tài chính riêng tư. Để tra cứu thông tin này, vui lòng truy cập chức năng Phiếu lương điện tử hoặc liên hệ Phòng Nhân sự.*';

    const empStatus = profile.status || 'ACTIVE';
    let statusLabel = 'Đang làm việc (ACTIVE)';
    if (empStatus === 'RESIGNED') statusLabel = 'Đã nghỉ việc (RESIGNED)';
    else if (empStatus === 'DELETED') statusLabel = 'Đã xóa mềm (DELETED)';
    else if (empStatus === 'INACTIVE') statusLabel = 'Vô hiệu hóa (INACTIVE)';

    const selfReply = `Chào **${fullName}**, dưới đây là thông tin hồ sơ nhân sự của bạn trong hệ thống:\n\n` +
      `### 👤 Hồ sơ Nhân sự Cá nhân\n` +
      `- **Họ và tên**: **${fullName}**\n` +
      `- **Mã nhân viên**: \`${empId}\`\n` +
      `- **Công ty trực thuộc**: ${compName}\n` +
      `- **Phòng ban / Đơn vị**: ${dept}\n` +
      `- **Chức danh / Vị trí**: ${jobTitle}\n` +
      `- **Email liên hệ**: ${email}\n` +
      `- **Số điện thoại**: ${phone}\n` +
      `- **Số CCCD / Định danh**: \`${maskedCccd}\` *(đã che bảo mật)*\n` +
      `- **Ngày bắt đầu làm việc**: ${startDate}\n` +
      `- **Loại hợp đồng**: ${contract}\n` +
      `- **Trạng thái hồ sơ**: ${statusLabel}\n\n` +
      `> ${salaryNote}`;

    await logAudit({
      actor_user_id: req.user.user_id,
      actor_username: req.user.username,
      action: 'HR_QUERY_SELF_SUCCESS',
      status: 'SUCCESS',
      ip_address: req.ip,
      metadata: { employee_id: empId, full_name: fullName, company_id: userCompany }
    });

    return res.json({
      reply: selfReply,
      table: null,
      self_service: true,
      user: { employee_id: empId, full_name: fullName }
    });
  }

  // =========================================================================
  // TRƯỜNG HỢP 2: QUẢN TRỊ VIÊN & NHÂN SỰ (Có quyền hr.chatbot.query_all)
  // (ADMIN: toàn hệ thống | HR: trong phạm vi công ty)
  // =========================================================================
  const verifiedRole = req.user.role || 'HR';
  const verifiedUserId = req.user.user_id || req.user.username;
  const verifiedUserName = req.user.employee_name || req.user.username;
  const userAssignedCompany = req.user.company_id ? String(req.user.company_id).toUpperCase() : null;

  let verifiedCompany = null;
  let canQueryAllSubsidiaries = false;

  if (verifiedRole === 'ADMIN') {
    if (userAssignedCompany && ['STL', 'VTX', 'SWC'].includes(userAssignedCompany)) {
      // Company-specific ADMIN (e.g. admin_stl): strictly restricted to their company scope!
      verifiedCompany = userAssignedCompany;
      canQueryAllSubsidiaries = false;
    } else {
      // Superadmin (ADMIN with no assigned company restriction, e.g. superadmin)
      canQueryAllSubsidiaries = true;
      const requestedCompany = String(req.body.company_id || '').toUpperCase();
      if (['STL', 'VTX', 'SWC'].includes(requestedCompany)) {
        verifiedCompany = requestedCompany;
      } else {
        verifiedCompany = 'ALL';
      }
    }
  } else if (verifiedRole === 'HR') {
    if (!userAssignedCompany || !['STL', 'VTX', 'SWC'].includes(userAssignedCompany)) {
      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'HR_CHAT_INVALID_TENANT',
        status: 'BLOCKED',
        ip_address: req.ip,
        metadata: { role: verifiedRole, reason: 'Tài khoản HR không thuộc đơn vị hợp lệ.' }
      });
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Tài khoản HR không thuộc đơn vị thành viên hợp lệ (STL/VTX/SWC).'
      });
    }
    verifiedCompany = userAssignedCompany;
    canQueryAllSubsidiaries = false;
  } else {
    verifiedCompany = userAssignedCompany || null;
    canQueryAllSubsidiaries = false;
  }

  await logAudit({
    actor_user_id: req.user.user_id,
    actor_username: req.user.username,
    action: 'HR_QUERY_ALL',
    status: 'SUCCESS',
    ip_address: req.ip,
    metadata: { company_scope: verifiedCompany, role: verifiedRole, can_query_all: canQueryAllSubsidiaries }
  });

  if (files && files.length > 0) {
    const canUpload = await hasPermission(req.user.role, 'hr.intake.upload');
    if (!canUpload) {
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Tài khoản của bạn không có quyền tải lên hồ sơ nhân sự.'
      });
    }

    try {
      const { forwardUploadToN8n } = require('../services/n8nLifecycleProxy');
      const n8nRes = await forwardUploadToN8n(req, files, { sessionId, conversation_id: sessionId, event_type: 'HR_UPLOAD' });
      if (n8nRes.status !== 200 || !n8nRes.body?.success) {
        return res.status(n8nRes.status || 500).json({
          success: false,
          error: n8nRes.body?.error || 'Lỗi bóc tách hồ sơ nhân sự qua n8n.'
        });
      }

      await logAudit({
        actor_user_id: req.user.user_id,
        actor_username: req.user.username,
        action: 'HR_INTAKE_UPLOAD_VIA_CHAT',
        status: 'SUCCESS',
        ip_address: req.ip,
        metadata: { batch_id: n8nRes.body.batch_id, file_count: files.length, n8n: true }
      });

      return res.json({
        reply: n8nRes.body.reply || n8nRes.body.output || '',
        table: null,
        batch_id: n8nRes.body.batch_id,
        staged_items: n8nRes.body.staged_items || n8nRes.body.items || []
      });
    } catch (intakeErr) {
      console.error('Lỗi tiếp nhận hồ sơ qua Chat (n8n):', intakeErr);
      return res.status(500).json({
        success: false,
        error: 'Lỗi bóc tách hồ sơ nhân sự: ' + intakeErr.message
      });
    }
  } else {
    // Kiểm tra ý định xác nhận công ty hoặc phê duyệt hồ sơ qua hội thoại
    try {
      const intakeConv = await handleIntakeConversationalMessage(req.user, message, sessionId);
      if (intakeConv) {
        return res.json(intakeConv);
      }
    } catch (convErr) {
      console.error('Lỗi xử lý xác nhận hồ sơ qua hội thoại:', convErr);
      return res.status(500).json({ success: false, error: convErr.message });
    }

    // Kiểm tra ý định khôi phục hồ sơ đã xóa mềm qua hội thoại
    try {
      const restoreConv = await handleRestoreConversationalIntent(req.user, message, req.ip);
      if (restoreConv) {
        return res.json(restoreConv);
      }
    } catch (restoreErr) {
      console.error('Lỗi xử lý khôi phục hồ sơ qua hội thoại:', restoreErr);
      return res.status(restoreErr.status || 500).json({ success: false, error: restoreErr.message });
    }

    // BƯỚC 4: Unified Intelligence Query (SQL Intelligence, True RAG, Sandbox, Aggregations)
    try {
      const { handleUnifiedIntelligenceQuery } = require('../services/unifiedIntelligenceService');
      const intelRes = await handleUnifiedIntelligenceQuery(req.user, message, req.ip, {
        company_id: req.body.company_id,
        scope: req.body.scope,
        conversation_id: sessionId
      });
      if (intelRes) {
        return res.json(intelRes);
      }
    } catch (intelErr) {
      console.error('Lỗi xử lý Unified Intelligence:', intelErr);
    }

    const secret = process.env.INTERNAL_SERVICE_SECRET || process.env.N8N_INTERNAL_SECRET || process.env.N8N_ENCRYPTION_KEY || '8973d464f5f1475b83d6ab88d222d824';
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = crypto.createHmac('sha256', secret)
      .update(`${timestamp}:${nonce}:${verifiedUserId}:${verifiedRole}:${verifiedCompany}`)
      .digest('hex');

    const payload = {
      message: String(message).trim(),
      sessionId: String(sessionId),
      auth_context: {
        user_id: verifiedUserId,
        username: req.user.username,
        role: verifiedRole,
        company_id: verifiedCompany,
        can_query_all: canQueryAllSubsidiaries,
        timestamp,
        nonce,
        signature
      }
    };

    const postData = Buffer.from(JSON.stringify(payload), 'utf-8');

    const options = {
      hostname: 'n8n',
      port: 5678,
      path: '/webhook/hoso-chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length,
        'Authorization': 'HMAC ' + signature,
        'x-internal-signature': signature,
        'x-internal-timestamp': String(timestamp),
        'x-internal-nonce': nonce,
        'x-internal-key-id': 'v1',
        'x-verified-user': req.user.username,
        'x-verified-sub': verifiedUserId,
        'x-verified-role': verifiedRole,
        'x-verified-company': verifiedCompany,
        'x-verified-can-query-all': String(canQueryAllSubsidiaries)
      },
      timeout: 180000
    };

    forwardToN8n(options, postData, res);
  }
  } catch (err) {
    console.error('Unhandled error in /api/hoso/chat:', err);
    return res.status(500).json({
      success: false,
      error_code: 'HR_CHAT_UNHANDLED_EXCEPTION',
      error: 'Đã xảy ra lỗi hệ thống trong quá trình xử lý câu hỏi: ' + (err ? err.message : 'Unknown error')
    });
  }
});

function forwardToN8n(options, postData, clientRes) {
  const n8nReq = http.request(options, (n8nRes) => {
    let raw = '';
    n8nRes.on('data', chunk => { raw += chunk; });
    n8nRes.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        return clientRes.status(n8nRes.statusCode).json(parsed);
      } catch (e) {
        return clientRes.status(n8nRes.statusCode).send(raw);
      }
    });
  });

  n8nReq.on('error', (e) => {
    console.error('Lỗi chuyển tiếp sang n8n:', e);
    return clientRes.status(502).json({ success: false, error: 'Không thể kết nối đến máy chủ xử lý AI: ' + e.message });
  });

  n8nReq.write(postData);
  n8nReq.end();
}

module.exports = router;
