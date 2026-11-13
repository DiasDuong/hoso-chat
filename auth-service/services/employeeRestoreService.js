/**
 * Service: Employee Profile Restore Engine
 * Enterprise-grade restoration for Soft-Deleted Employees across PostgreSQL, NocoDB, and Google Sheets.
 * Supports Conversational Chatbot Requests, REST API, Single and Bulk Operations with RBAC & Audit Logging.
 */

const db = require('../db');
const { logAudit } = require('../audit');
const { queueEmployeeSync } = require('./syncWorker');

function removeAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

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
 * 1. Find candidate soft-deleted employees matching criteria and user RBAC scope
 */
async function findRestoreCandidates(user = {}, queryCriteria = {}) {
  const params = [];
  let whereClauses = [];

  // Base soft-delete condition: is_deleted = true or status = 'DELETED'
  whereClauses.push(`(e.is_deleted = true OR p.is_deleted = true OR e.status = 'DELETED')`);

  // RBAC Tenant Isolation: HR only sees their own company
  if (user.role === 'HR' && user.company_id) {
    params.push(user.company_id.toUpperCase());
    whereClauses.push(`UPPER(e.company_id) = $${params.length}`);
  } else if (queryCriteria.company_id && queryCriteria.company_id !== 'ALL') {
    params.push(queryCriteria.company_id.toUpperCase());
    whereClauses.push(`UPPER(e.company_id) = $${params.length}`);
  }

  // Specific targets (codes, names, or IDs)
  if (queryCriteria.targets && Array.isArray(queryCriteria.targets) && queryCriteria.targets.length > 0) {
    const targetClauses = [];
    for (const t of queryCriteria.targets) {
      const clean = String(t).trim();
      if (!clean) continue;
      params.push(clean);
      const idx = params.length;
      params.push(`%${clean}%`);
      const lIdx = params.length;
      targetClauses.push(`(e.employee_code = $${idx} OR e.id::text = $${idx} OR e.citizen_id = $${idx} OR unaccent(e.employee_name) ILIKE unaccent($${lIdx}) OR e.employee_name ILIKE $${lIdx} OR p.employee_id = $${idx} OR unaccent(p.full_name) ILIKE unaccent($${lIdx}) OR p.full_name ILIKE $${lIdx})`);
    }
    if (targetClauses.length > 0) {
      whereClauses.push(`(${targetClauses.join(' OR ')})`);
    }
  }

  const sql = `
    SELECT DISTINCT ON (e.id)
      e.id,
      e.employee_code,
      e.employee_name,
      e.company_id,
      c.company_name,
      e.department,
      e.position,
      e.citizen_id,
      e.status AS employee_status,
      p.id AS profile_id,
      p.job_grade,
      p.full_name AS profile_name
    FROM employees e
    LEFT JOIN companies c ON e.company_id = c.id
    LEFT JOIN hr_employee_profiles p ON (e.employee_code = p.employee_id OR (e.citizen_id IS NOT NULL AND e.citizen_id <> '' AND e.citizen_id = p.citizen_id))
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY e.id, e.company_id ASC, e.employee_code ASC
  `;

  const res = await db.query(sql, params);
  return res.rows.sort((a, b) => (a.company_id || '').localeCompare(b.company_id || '') || (a.employee_code || '').localeCompare(b.employee_code || ''));
}

/**
 * 2. Execute atomic restoration for single or multiple employees
 */
async function executeRestore(user = {}, options = {}) {
  const {
    employee_ids = [],
    employee_codes = [],
    targets = [],
    scope = 'targeted',
    ipAddress = '127.0.0.1'
  } = options;

  // 1. RBAC Verification: Chỉ ADMIN/SUPER_ADMIN mới có quyền khôi phục hồ sơ xóa mềm
  if (!['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
    const err = new Error('403 Forbidden: Vai trò Chuyên viên Nhân sự (HR) không có quyền khôi phục hồ sơ nhân sự đã bị xóa mềm. Thao tác này chỉ dành riêng cho Quản trị viên (ADMIN).');
    err.status = 403;
    throw err;
  }

  const client = await db.getClient();

  const report = {
    total_requested: 0,
    restored: [],
    already_active: [],
    forbidden: [],
    not_found: [],
    conflict: []
  };

  try {
    await client.query('BEGIN');

    // Build list of target queries
    let resolvedQueries = [];
    if (scope === 'all_deleted') {
      // Find all soft-deleted records within user's company scope
      const candidates = await findRestoreCandidates(user, { company_id: user.company_id || 'ALL' });
      resolvedQueries = candidates.map(c => ({ id: c.id, code: c.employee_code, name: c.employee_name, company: c.company_id }));
    } else {
      const set = new Set();
      employee_ids.forEach(id => { if (id) set.add(String(id).trim()); });
      employee_codes.forEach(c => { if (c) set.add(String(c).trim()); });
      targets.forEach(t => { if (t) set.add(String(t).trim()); });
      resolvedQueries = Array.from(set).map(q => ({ query: q }));
    }

    report.total_requested = resolvedQueries.length;
    if (resolvedQueries.length === 0) {
      await client.query('ROLLBACK');
      return {
        success: true,
        report,
        message: 'Không tìm thấy hồ sơ nhân sự nào phù hợp để khôi phục.'
      };
    }

    const syncQueueItems = [];

    for (const item of resolvedQueries) {
      // Lookup employee record by ID, code, or name
      let empRes;
      if (item.id) {
        empRes = await client.query(`SELECT e.*, c.company_name FROM employees e LEFT JOIN companies c ON e.company_id = c.id WHERE e.id = $1`, [item.id]);
      } else {
        const q = String(item.query || item.code || '').trim();
        empRes = await client.query(
          `SELECT e.*, c.company_name FROM employees e 
           LEFT JOIN companies c ON e.company_id = c.id 
           WHERE e.employee_code = $1 OR e.id::text = $1 OR e.citizen_id = $1 
              OR unaccent(e.employee_name) ILIKE unaccent($2) OR e.employee_name ILIKE $2
           LIMIT 1`,
          [q, `%${q}%`]
        );
      }

      if (empRes.rows.length === 0) {
        report.not_found.push({ query: item.query || item.code || item.id, reason: 'Không tìm thấy hồ sơ trong cơ sở dữ liệu' });
        continue;
      }

      const emp = empRes.rows[0];

      // Tenant Isolation Check for HR Role
      if (user.role === 'HR') {
        const userComp = (user.company_id || '').toUpperCase();
        const empComp = (emp.company_id || '').toUpperCase();
        if (userComp && empComp && userComp !== empComp) {
          report.forbidden.push({
            id: emp.id,
            code: emp.employee_code,
            name: emp.employee_name,
            company: emp.company_id,
            user_company: user.company_id,
            reason: `Hồ sơ thuộc đơn vị ${emp.company_id}, tài khoản HR chỉ được phép thao tác trong đơn vị ${user.company_id}`
          });
          continue;
        }
      }

      // Check if already active
      if (emp.status === 'ACTIVE') {
        report.already_active.push({
          id: emp.id,
          code: emp.employee_code,
          name: emp.employee_name,
          company: emp.company_id,
          status: emp.status
        });
        continue;
      }

      // Check if another ACTIVE employee already possesses this citizen_id (Case 7: Conflict Resolution)
      if (emp.citizen_id) {
        const cleanCccd = String(emp.citizen_id).replace(/\D/g, '');
        if (cleanCccd) {
          await client.query(`SELECT pg_advisory_xact_lock(hashtext('cccd:' || $1))`, [cleanCccd]);
        }
        const conflictRes = await client.query(
          `SELECT employee_code, employee_name, company_id FROM employees 
           WHERE citizen_id = $1 AND status = 'ACTIVE' AND id <> $2 
           LIMIT 1`,
          [emp.citizen_id, emp.id]
        );
        if (conflictRes.rows.length > 0) {
          const conflicting = conflictRes.rows[0];
          report.conflict.push({
            id: emp.id,
            code: emp.employee_code,
            name: emp.employee_name,
            company: emp.company_id,
            citizen_id: emp.citizen_id,
            conflicting_code: conflicting.employee_code,
            conflicting_name: conflicting.employee_name,
            conflicting_company: conflicting.company_id,
            reason: `Số CCCD/Định danh ${maskCccd(emp.citizen_id)} đang được sử dụng bởi nhân sự đang hoạt động [${conflicting.employee_code}] ${conflicting.employee_name} (${conflicting.company_id}). Cần giải quyết trùng định danh trước khi khôi phục.`
          });
          continue;
        }
      }

      // Execute restoration
      // 1. Update employees table
      await client.query(
        `UPDATE employees SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`,
        [emp.id]
      );

      // 2. Reactivate linked user account if exists
      await client.query(
        `UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE employee_id = $1`,
        [emp.id]
      );

      // 3. Update hr_employee_profiles table (clear [ĐÃ XÓA] label)
      await client.query(
        `UPDATE hr_employee_profiles
         SET job_grade = '',
             full_name = REPLACE(REPLACE(full_name, ' [ĐÃ XÓA]', ''), ' [NGHỈ VIỆC]', ''),
             updated_at = NOW()
         WHERE (employee_id = $1 AND employee_id <> '') OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)`,
        [emp.employee_code, emp.citizen_id]
      );

      report.restored.push({
        id: emp.id,
        code: emp.employee_code,
        name: emp.employee_name,
        company: emp.company_id,
        company_name: emp.company_name || emp.company_id,
        citizen_id: emp.citizen_id
      });

      syncQueueItems.push({
        id: emp.id,
        payload: {
          employee_id: emp.employee_code,
          employee_code: emp.employee_code,
          full_name: emp.employee_name,
          employee_name: emp.employee_name,
          company_id: emp.company_id,
          citizen_id: emp.citizen_id,
          status: 'ACTIVE',
          action_type: 'RESTORE'
        }
      });
    }

    await client.query('COMMIT');

    // Queue sync tasks for restored records AFTER successful commit
    for (const s of syncQueueItems) {
      await queueEmployeeSync(s.id, 'RESTORE', s.payload);
    }

    // Audit Logging
    if (report.restored.length > 0) {
      await logAudit({
        actor_user_id: user.user_id,
        actor_username: user.username,
        action: 'employee_batch_restored',
        status: 'SUCCESS',
        ip_address: ipAddress,
        metadata: {
          restored_count: report.restored.length,
          restored_employees: report.restored.map(r => ({ code: r.code, name: r.name, company: r.company })),
          scope
        }
      });
    }

    return {
      success: true,
      report,
      message: `Đã khôi phục thành công ${report.restored.length} hồ sơ nhân sự (chuyển trạng thái ACTIVE, giữ nguyên mã nhân viên và kích hoạt đồng bộ 3 hệ thống).`
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Execute restore error:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 3. Format interactive Markdown response card for Chatbot
 */
function formatRestoreResponse(data, mode = 'execution') {
  if (mode === 'preview') {
    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      return `ℹ️ **Không tìm thấy hồ sơ nhân sự nào đã xóa mềm** phù hợp với yêu cầu của bạn trong phạm vi đơn vị cho phép.\n\n` +
        `Hiện tại toàn bộ hồ sơ đang ở trạng thái hoạt động hoặc không có bản ghi nào mang nhãn \`[ĐÃ XÓA]\`.`;
    }

    const lines = candidates.map((c, i) => {
      const codePart = c.employee_code ? `\`${c.employee_code}\`` : '*(Chưa cấp mã)*';
      const cccdPart = maskCccd(c.citizen_id);
      const compBadge = `**${c.company_id || 'N/A'}**`;
      const deptPart = c.department ? ` • ${c.department}` : '';
      return `${i + 1}. **${c.employee_name}** • Mã NV: ${codePart} • Đơn vị: ${compBadge} • CCCD: \`${cccdPart}\`${deptPart}`;
    }).join('\n');

    return `### ♻️ ĐỀ XUẤT KHÔI PHỤC ${candidates.length} HỒ SƠ ĐÃ XÓA MỀM\n\n` +
      `Hệ thống tìm thấy **${candidates.length} hồ sơ nhân sự** đang ở trạng thái đã xóa mềm (\`DELETED\`):\n\n` +
      `${lines}\n\n` +
      `🛡️ **Chính sách bảo toàn dữ liệu (Phương án A)**:\n` +
      `- Giữ nguyên mã nhân viên lịch sử, bảo toàn lịch sử thuế & BHXH.\n` +
      `- Chuyển trạng thái hồ sơ sang **ACTIVE** trên CSDL.\n` +
      `- Tự động đồng bộ gỡ bỏ nhãn \`[ĐÃ XÓA]\` trên Google Sheets và NocoDB.\n\n` +
      `👉 **Hành động**: Gõ *"Xác nhận khôi phục tất cả"* (hoặc *"Khôi phục hồ sơ [Mã/Tên]"*) để tiến hành khôi phục ngay.`;
  }

  // Execution Report
  const r = data.report || {};
  const restored = r.restored || [];
  const already = r.already_active || [];
  const forbidden = r.forbidden || [];
  const notFound = r.not_found || [];

  let out = `### ♻️ BÁO CÁO KẾT QUẢ KHÔI PHỤC HỒ SƠ NHÂN SỰ\n\n`;

  if (restored.length > 0) {
    out += `✅ **ĐÃ KHÔI PHỤC THÀNH CÔNG (${restored.length} hồ sơ)**:\n`;
    restored.forEach((e, idx) => {
      out += `${idx + 1}. **${e.name}** • Mã NV: \`${e.code}\` • Đơn vị: **${e.company}**\n`;
      out += `   - *Trạng thái mới*: 🟢 **ACTIVE**\n`;
      out += `   - *Đồng bộ*: Đã xếp hàng tác vụ gỡ bỏ \`[ĐÃ XÓA]\` trên Google Sheets & NocoDB.\n`;
    });
    out += `\n`;
  }

  if (already.length > 0) {
    out += `ℹ️ **HỒ SƠ ĐÃ Ở TRẠNG THÁI HOẠT ĐỘNG (${already.length} hồ sơ)**:\n`;
    already.forEach(e => {
      out += `- **${e.name}** (\`${e.code}\` - ${e.company}): Hồ sơ hiện đã là ACTIVE, không cần cập nhật lại.\n`;
    });
    out += `\n`;
  }

  if (forbidden.length > 0) {
    out += `⛔ **TỪ CHỐI DO KHÔNG ĐỦ THẨM QUYỀN (${forbidden.length} hồ sơ)**:\n`;
    forbidden.forEach(e => {
      out += `- **${e.name}** (\`${e.code}\` - ${e.company}): ${e.reason}\n`;
    });
    out += `\n`;
  }

  if (r.conflict && r.conflict.length > 0) {
    out += `⚠️ **XUNG ĐỘT TRÙNG ĐỊNH DANH (${r.conflict.length} hồ sơ)**:\n`;
    r.conflict.forEach(e => {
      out += `- **${e.name}** (\`${e.code}\` - ${e.company}): ${e.reason}\n`;
    });
    out += `\n`;
  }

  if (notFound.length > 0) {
    out += `❌ **KHÔNG TÌM THẤY HỒ SƠ (${notFound.length})**:\n`;
    notFound.forEach(e => {
      out += `- Truy vấn "${e.query}": ${e.reason}\n`;
    });
    out += `\n`;
  }

  out += `> 📌 **Lưu ý**: Dữ liệu đã được ghi nhận trực tiếp vào CSDL PostgreSQL System of Record. Bạn có thể mở mục **Quản lý Hồ sơ Nhân sự & Số hóa OCR** để xem ngay danh sách hồ sơ hoạt động.`;
  return out;
}

/**
 * 4. Parse conversational user message for restore intent and execute appropriate action
 */
async function handleRestoreConversationalIntent(user, message, ipAddress = '127.0.0.1') {
  if (!message || typeof message !== 'string') return null;
  const rawTrimmed = message.trim();
  const norm = removeAccents(rawTrimmed);

  // Fast check: message must contain "khoi phuc" or be direct JSON action
  const hasRestoreWord = norm.includes('khoi phuc');
  const isDirectJson = rawTrimmed.startsWith('{') && rawTrimmed.endsWith('}');

  if (!hasRestoreWord && !isDirectJson) {
    // Check if user is confirming a pending restore: "xac nhan khoi phuc", "dong y khoi phuc"
    const isConfirmRestore = norm.includes('xac nhan khoi phuc') || norm.includes('dong y khoi phuc');
    if (!isConfirmRestore) return null;
  }

  if (!['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
    return {
      reply: '⛔ **TỪ CHỐI THỰC HIỆN**: Vai trò Chuyên viên Nhân sự (HR) không có quyền khôi phục hồ sơ nhân sự đã bị xóa mềm qua chatbot. Thao tác này chỉ dành riêng cho Quản trị viên (ADMIN) toàn hệ thống theo chính sách an toàn thông tin.',
      table: null
    };
  }

  // 1. Check for Direct JSON Action
  if (isDirectJson) {
    try {
      const payload = JSON.parse(rawTrimmed);
      if (payload.action === 'restore_all' || (payload.action === 'restore' && payload.scope === 'all')) {
        const result = await executeRestore(user, { scope: 'all_deleted', ipAddress });
        return {
          reply: formatRestoreResponse(result, 'execution'),
          table: null,
          restore_result: result.report
        };
      }
      if (payload.action === 'restore' && (payload.codes || payload.ids || payload.targets)) {
        const result = await executeRestore(user, {
          employee_codes: payload.codes || [],
          employee_ids: payload.ids || [],
          targets: payload.targets || [],
          ipAddress
        });
        return {
          reply: formatRestoreResponse(result, 'execution'),
          table: null,
          restore_result: result.report
        };
      }
    } catch (e) {}
  }

  // 2. Check for Confirmed Bulk Restore ("Xác nhận khôi phục tất cả", "Đồng ý khôi phục tất cả", "Xác nhận khôi phục", "khôi phục tất cả")
  const isExplicitConfirm = (norm.includes('xac nhan') || norm.includes('dong y') || norm.includes('tien hanh')) &&
                            (norm.includes('khoi phuc') || norm.includes('tat ca') || norm.includes('toan bo'));
  const isDirectBulkRestore = norm === 'khoi phuc tat ca' || norm === 'khoi phuc lai tat ca' || norm === 'khoi phuc toan bo' || norm === 'khoi phuc lai toan bo';

  if (isExplicitConfirm || isDirectBulkRestore) {
    const result = await executeRestore(user, { scope: 'all_deleted', ipAddress });
    return {
      reply: formatRestoreResponse(result, 'execution'),
      table: null,
      restore_result: result.report
    };
  }

  // 3. Check for Specific Target Codes or Names in message
  // e.g. "khôi phục hồ sơ STL00012", "khôi phục SWC00016, SWC00017", "khôi phục mã SWC00018"
  const codeMatches = rawTrimmed.match(/\b([A-Za-z]{2,5}\d{3,6}|[A-Za-z]{2,5}-\d{2,4}|\d{9,12})\b/g);
  
  // If specific codes are explicitly present:
  if (codeMatches && codeMatches.length > 0 && !norm.includes('tat ca') && !norm.includes('toan bo') && !norm.includes('cac nhan vien')) {
    const result = await executeRestore(user, { employee_codes: codeMatches, ipAddress });
    return {
      reply: formatRestoreResponse(result, 'execution'),
      table: null,
      restore_result: result.report
    };
  }

  // Check if a specific employee name is targeted: e.g. "khôi phục hồ sơ Nguyễn Trường Nam", "khôi phục nhân viên Nguyễn Trường Nam"
  const rawNameMatch = rawTrimmed.match(/(?:khôi phục|khoi phuc|khôi phục lại|khoi phuc lai|khôi phục hồ sơ|khoi phuc ho so|khôi phục nhân viên|khoi phuc nhan vien|khôi phục lại hồ sơ|khoi phuc lai ho so|khôi phục lại thông tin|khoi phuc lai thong tin)\s+(?:của\s+|cua\s+)?(?:nhân viên\s+|nhan vien\s+|hồ sơ\s+|ho so\s+)?([^\n,\.;!\?]+)$/i);
  if (rawNameMatch && rawNameMatch[1]) {
    const candidateName = rawNameMatch[1].trim();
    const candidateNorm = removeAccents(candidateName);
    // Exclude generic words
    const genericWords = ['tat ca', 'toan bo', 'cac nhan vien', 'cac ho so', 'da xoa', 'da xoa mem', 'nhan vien da xoa', 'ho so da xoa', 'cac nhan su', 'thong tin cua cac nhan vien da xoa mem', 'thong tin cac nhan vien da xoa mem', 'cac nhan vien da xoa mem', 'cac nhan vien da xoa'];
    const isGeneric = genericWords.some(w => candidateNorm === w || candidateNorm.endsWith(w));

    if (!isGeneric && candidateName.length >= 2) {
      // Look up candidate by name
      const specificCandidates = await findRestoreCandidates(user, { targets: [candidateName] });
      if (specificCandidates.length > 0) {
        const result = await executeRestore(user, { employee_ids: specificCandidates.map(c => c.id), ipAddress });
        return {
          reply: formatRestoreResponse(result, 'execution'),
          table: null,
          restore_result: result.report
        };
      }
    }
  }

  // 4. General Bulk Restore Request ("khôi phục lại thông tin của các nhân viên đã xóa mềm", "khôi phục lại hồ sơ các nhân viên đã xóa mềm", "khôi phục tất cả hồ sơ đã xóa",...)
  // Per Section 3.D.4: Display preview of candidate employees and require user confirmation!
  const candidates = await findRestoreCandidates(user, { company_id: user.company_id || 'ALL' });
  return {
    reply: formatRestoreResponse({ candidates }, 'preview'),
    table: null,
    preview_candidates: candidates.map(c => ({ id: c.id, code: c.employee_code, name: c.employee_name, company: c.company_id }))
  };
}

module.exports = {
  findRestoreCandidates,
  executeRestore,
  formatRestoreResponse,
  handleRestoreConversationalIntent
};
