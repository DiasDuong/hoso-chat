/**
 * Service: Interactive Profile Preview Card & Diff Renderer
 * Enhanced for CCCD Duplicate Detection, Multi-tenant Isolation & Clear Grouping
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

function formatSalary(sal) {
  if (!sal) return 'Theo quy định';
  const num = parseInt(String(sal).replace(/\D/g, ''), 10);
  if (isNaN(num) || num <= 0) return 'Theo quy định';
  return num.toLocaleString('vi-VN') + ' VNĐ';
}

function getCompanyBadge(status, companyId) {
  switch (status) {
    case 'confirmed':
      return `🟢 **${companyId || 'N/A'} (Đã xác nhận)**`;
    case 'suggested':
      return `🟡 **${companyId || 'N/A'} (AI Đề xuất - Chờ xác nhận)**`;
    case 'conflict':
      return `🔴 **Xung đột dữ liệu công ty (Cần HR chọn)**`;
    case 'unknown':
    default:
      return `⚪ **Chưa xác định công ty**`;
  }
}

/**
 * Render Interactive Preview Card for Single Staging Record
 */
function renderStagingPreview(stagingItem, canApprove = false) {
  const p = stagingItem;
  const fullName = p.full_name || 'Nhân viên mới';
  const cccd = maskCccd(p.citizen_id);
  const compBadge = getCompanyBadge(p.company_status, p.company_id);
  const empCode = p.employee_code || p.target_employee_code || '*(Chưa cấp mã chính thức)*';
  const dept = p.department || 'Chưa cập nhật';
  const job = p.job_title || 'Chưa cập nhật';
  const startDate = p.employment_start_date || 'Chưa cập nhật';
  const decision = p.recruitment_decision_no || 'Chưa cập nhật';
  const mode = p.intake_mode || 'new_profile';

  // 1A. CASE: RESTORE PROPOSAL (Hồ sơ đã xóa mềm trong cùng công ty)
  if (mode === 'restore_proposal' || p.duplicate_classification === 'SOFT_DELETED_SAME_COMPANY') {
    let proposed = {};
    try { proposed = typeof p.proposed_changes === 'string' ? JSON.parse(p.proposed_changes) : (p.proposed_changes || {}); } catch(e) {}
    const oldCode = proposed.target_employee_code || p.employee_code || 'Chưa cấp';
    const oldName = proposed.matched_record?.full_name || fullName;
    return `### ♻️ ĐỀ XUẤT KHÔI PHỤC HỒ SƠ ĐÃ XÓA MỀM (Staging ID: \`${p.id.slice(0, 8)}\`)\n\n` +
      `- **Tệp nguồn**: \`${p.file_name}\`\n` +
      `- **Họ và tên**: **${fullName}**\n` +
      `- **Số CCCD / Định danh**: \`${cccd}\` *(đã ẩn bảo mật)*\n` +
      `- **Đơn vị trực thuộc**: ${compBadge}\n` +
      `- **Mã nhân viên lịch sử**: \`${oldCode}\` *(giữ nguyên)*\n\n` +
      `> 💡 **THÔNG TIN ĐỐI SOÁT**: Số CCCD này thuộc hồ sơ nhân viên cũ **[${oldCode}] ${oldName}** đã được xóa mềm trước đây trong hệ thống.\n\n` +
      `🛡️ *Chính sách bảo toàn dữ liệu*: Hệ thống sẽ **tái kích hoạt hồ sơ cũ** (chuyển trạng thái sang ACTIVE, giữ nguyên ID và mã NV lịch sử), cập nhật thông tin mới nhất từ tệp scan và tự động đồng bộ lại sang Google Sheets và NocoDB (gỡ bỏ nhãn [ĐÃ XÓA]).\n\n` +
      `👉 Gõ: *"Khôi phục hồ sơ ${fullName}"* hoặc bấm nút **"Phê duyệt"** để hoàn tất khôi phục.`;
  }

  // 1B. CASE: RE-HIRE PROPOSAL (Nhân sự đã nghỉ việc trong cùng công ty)
  if (mode === 'rehire_proposal' || p.duplicate_classification === 'RESIGNED_SAME_COMPANY') {
    let proposed = {};
    try { proposed = typeof p.proposed_changes === 'string' ? JSON.parse(p.proposed_changes) : (p.proposed_changes || {}); } catch(e) {}
    const oldCode = proposed.target_employee_code || p.employee_code || 'Chưa cấp';
    const oldName = proposed.matched_record?.full_name || fullName;
    return `### 💼 ĐỀ XUẤT TIẾP NHẬN LẠI NHÂN SỰ ĐÃ NGHỈ VIỆC (Staging ID: \`${p.id.slice(0, 8)}\`)\n\n` +
      `- **Tệp nguồn**: \`${p.file_name}\`\n` +
      `- **Họ và tên**: **${fullName}**\n` +
      `- **Số CCCD / Định danh**: \`${cccd}\`\n` +
      `- **Đơn vị trực thuộc**: ${compBadge}\n` +
      `- **Mã nhân viên**: \`${oldCode}\` *(bảo toàn lịch sử)*\n\n` +
      `> 💼 **QUY TRÌNH TIẾP NHẬN LẠI (RE-HIRE)**: Nhân sự **[${oldCode}] ${oldName}** đã nghỉ việc theo hồ sơ lưu trữ. Hệ thống giữ nguyên mã nhân viên cũ theo chính sách tập đoàn để bảo toàn lịch sử thuế, BHXH.\n\n` +
      `👉 Gõ: *"Phê duyệt"* để hoàn tất tiếp nhận lại nhân sự.`;
  }

  // 1C. CASE: SUSPECTED DUPLICATE (Chặn tạo mới nhân sự đang làm việc hoặc trùng liên công ty)
  if (p.suspected_duplicate || mode === 'suspected_duplicate') {
    return `### ⛔ CẢNH BÁO PHÁT HIỆN TRÙNG LẶP CCCD (Staging ID: \`${p.id.slice(0, 8)}\`)\n\n` +
      `- **Tệp nguồn**: \`${p.file_name}\`\n` +
      `- **Họ và tên**: **${fullName}**\n` +
      `- **Số CCCD / Định danh**: \`${cccd}\` *(đã ẩn bảo mật)*\n` +
      `- **Đơn vị trực thuộc**: ${compBadge}\n\n` +
      `> ⛔ **TRẠNG THÁI CHẶN**: ${p.duplicate_reason || 'Phát hiện số CCCD đã tồn tại trong hệ thống.'}\n\n` +
      `🛡️ *Chính sách bảo toàn dữ liệu*: Hệ thống **tuyệt đối không tạo bản ghi mới** và **không ghi đè hồ sơ hiện có** khi phát hiện trùng CCCD. Bạn **không cần xác nhận công ty** đối với hồ sơ này vì hồ sơ đã bị khóa tạo mới.`;
  }

  // 2. CASE: INSUFFICIENT DATA / MISSING CCCD
  if (mode === 'insufficient_data' || !p.citizen_id) {
    return `### ⚠️ HỒ SƠ THIẾU THÔNG TIN ĐỊNH DANH (Staging ID: \`${p.id.slice(0, 8)}\`)\n\n` +
      `- **Tệp nguồn**: \`${p.file_name}\`\n` +
      `- **Họ và tên**: **${fullName}**\n` +
      `- **Số CCCD**: *(Chưa xác định được)*\n\n` +
      `> 💡 **CẦN KIỂM TRA THỦ CÔNG**: ${p.duplicate_reason || 'Chưa trích xuất được số CCCD hoặc độ tin cậy OCR thấp.'}\n\n` +
      `*Quy tắc nghiệp vụ*: Hệ thống không tự ý suy đoán trùng hay không trùng khi thiếu CCCD. Vui lòng gõ: *"CCCD của ${fullName}: [Số CCCD 9 hoặc 12 chữ số]"* để bổ sung.`;
  }

  // 3. CASE: COMPANY MISMATCH
  if (mode === 'company_mismatch') {
    return `### ⚠️ TÀI LIỆU KHÔNG KHỚP ĐƠN VỊ CỦA TÀI KHOẢN (Staging ID: \`${p.id.slice(0, 8)}\`)\n\n` +
      `- **Tệp nguồn**: \`${p.file_name}\`\n` +
      `- **Nhân sự**: **${fullName}**\n` +
      `- **Đơn vị tài khoản**: **${p.company_id || 'Chưa rõ'}**\n` +
      `\n> ⛔ **TỪ CHỐI THAO TÁC TỰ ĐỘNG**: ${p.duplicate_reason || 'Tài liệu không khớp phạm vi xử lý hiện tại của tài khoản.'}\n\n` +
      `🛡️ *Chính sách bảo mật*: Hệ thống **không tự động đổi công ty** và **không ghi đè hồ sơ sang đơn vị khác**. Vui lòng chuyển hồ sơ cho Quản trị viên của công ty tương ứng hoặc Super Admin để xử lý điều chuyển.`;
  }

  // 4. CASE: NEW PROFILE ONBOARDING (Standard Flow)
  let alertBlock = '';
  if (p.missing_fields && p.missing_fields.length > 0) {
    alertBlock += `\n> ⚠️ **THIẾU DỮ LIỆU CẦN BỔ SUNG**: ${p.missing_fields.join(', ')}\n`;
  }
  if (p.uncertain_fields && p.uncertain_fields.length > 0) {
    alertBlock += `\n> 💡 **THÔNG TIN CẦN HR KIỂM TRA LẠI**: ${p.uncertain_fields.join('; ')}\n`;
  }
  if (p.company_evidence) {
    alertBlock += `\n> 📌 **Bằng chứng xác định công ty**: ${p.company_evidence}\n`;
  }

  const approveButtonText = canApprove ? '✅ Phê duyệt & Lưu chính thức' : '📤 Gửi trình phê duyệt';

  return `### 📋 Bản Xem Trước Tiếp Nhận Hồ Sơ Mới (Staging ID: \`${p.id.slice(0, 8)}\`)\n\n` +
    `- **Tệp nguồn đính kèm**: \`${p.file_name}\`\n` +
    `- **Họ và tên**: **${fullName}**\n` +
    `- **Số CCCD / Định danh**: \`${cccd}\` *(đã ẩn bảo mật)*\n` +
    `- **Đơn vị trực thuộc**: ${compBadge}\n` +
    `- **Mã nhân viên**: \`${empCode}\`\n` +
    `- **Phòng ban / Đơn vị**: ${dept}\n` +
    `- **Chức danh / Vị trí**: ${job}\n` +
    `- **Ngày bắt đầu làm việc**: ${startDate}\n` +
    `- **Số quyết định tuyển dụng**: ${decision}\n` +
    `- **Trạng thái lưu trữ**: ⏳ \`${p.staging_status}\` (Vùng Staging tạm thời, chưa ghi vào CSDL chính thức)\n` +
    alertBlock + `\n` +
    `**Hành động đề xuất (Gõ hoặc bấm chọn):**\n` +
    `1. *Xác nhận công ty*: Gõ "Hồ sơ này thuộc STL" / "Thuộc VTX" / "Thuộc SWC" / "Chưa xác định".\n` +
    `2. *Hoàn tất*: Gõ "${approveButtonText}" để tiếp tục quy trình.`;
}

/**
 * Render Interactive Summary for Batch Upload
 * Strictly categorizes records:
 * - Group 1: CCCD Duplicates (Batch, Same company, Cross company) -> Blocked from new creation, NO company confirmation asked!
 * - Group 2: Manual Check Required (Missing/Invalid CCCD) -> Prompt manual check
 * - Group 3: Valid Records -> Prompt company confirmation ONLY if unconfirmed!
 */
function renderBatchSummary(batchItems, canApprove = false) {
  const sortedItems = [...(batchItems || [])].sort((a, b) => {
    const tA = new Date(a.created_at || 0).getTime();
    const tB = new Date(b.created_at || 0).getTime();
    if (tA !== tB) return tA - tB;
    const fA = String(a.file_name || '');
    const fB = String(b.file_name || '');
    if (fA !== fB) return fA.localeCompare(fB);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  const total = sortedItems.length;

  const restoreItems = [];
  const duplicateItems = [];
  const manualCheckItems = [];
  const validItems = [];

  for (let idx = 0; idx < sortedItems.length; idx++) {
    const item = sortedItems[idx];
    let proposed = {};
    if (item.proposed_changes) {
      try {
        proposed = typeof item.proposed_changes === 'string' ? JSON.parse(item.proposed_changes) : item.proposed_changes;
      } catch (e) {}
    }
    const dupType = proposed.duplicate_classification || (item.suspected_duplicate ? 'SAME_COMPANY_DUPLICATE' : null);
    const mode = item.intake_mode || '';

    if (mode === 'restore_proposal' || dupType === 'SOFT_DELETED_SAME_COMPANY') {
      restoreItems.push({ item, idx: idx + 1, oldCode: proposed.target_employee_code || item.employee_code || 'Chưa cấp' });
    } else if (mode === 'rehire_proposal' || dupType === 'RESIGNED_SAME_COMPANY') {
      restoreItems.push({ item, idx: idx + 1, oldCode: proposed.target_employee_code || item.employee_code || 'Chưa cấp', isRehire: true });
    } else if (item.suspected_duplicate || mode === 'suspected_duplicate' || dupType === 'BATCH_DUPLICATE' || dupType === 'ACTIVE_SAME_COMPANY_DUPLICATE' || dupType === 'SAME_COMPANY_DUPLICATE' || dupType === 'CROSS_COMPANY_DUPLICATE' || dupType === 'CROSS_COMPANY_EXISTING' || dupType === 'IDENTITY_MISMATCH') {
      duplicateItems.push({ item, idx: idx + 1, dupType: dupType || 'ACTIVE_SAME_COMPANY_DUPLICATE' });
    } else if (mode === 'insufficient_data' || !item.citizen_id || dupType === 'MANUAL_CHECK_REQUIRED') {
      manualCheckItems.push({ item, idx: idx + 1 });
    } else {
      validItems.push({ item, idx: idx + 1 });
    }
  }

  let content = `📊 **KẾT QUẢ TIẾP NHẬN & BÓC TÁCH ${total} HỒ SƠ:**\n\n`;

  // 0. NHÓM ĐỀ XUẤT KHÔI PHỤC HỒ SƠ ĐÃ XÓA MỀM / TIẾP NHẬN LẠI
  if (restoreItems.length > 0) {
    content += `♻️ **NHÓM ĐỀ XUẤT KHÔI PHỤC / TIẾP NHẬN LẠI (${restoreItems.length} hồ sơ - CÓ THỂ PHÊ DUYỆT):**\n`;
    for (const { item, idx, oldCode, isRehire } of restoreItems) {
      const cccd = maskCccd(item.citizen_id);
      const name = item.full_name || 'Nhân viên';
      const file = item.file_name || 'Không rõ tệp';
      const label = isRehire ? 'Nhân sự nghỉ việc (Re-hire)' : 'Hồ sơ đã xóa mềm';
      content += `${idx}. **${name}** (CCCD: \`${cccd}\`, Mã NV cũ: \`${oldCode}\`) • Tệp: \`${file}\`\n`;
      content += `   - **Trạng thái**: 🟢 ${label} — Đề xuất khôi phục mã lịch sử và cập nhật thông tin mới.\n`;
    }
    content += `\n`;
  }

  // 1. NHÓM 1: PHÁT HIỆN TRÙNG LẶP CCCD
  if (duplicateItems.length > 0) {
    content += `⛔ **NHÓM 1: PHÁT HIỆN TRÙNG LẶP CCCD (${duplicateItems.length} hồ sơ - ĐÃ CHẶN TẠO MỚI):**\n`;
    for (const { item, idx, dupType } of duplicateItems) {
      const cccd = maskCccd(item.citizen_id);
      const name = item.full_name || 'Nhân viên';
      const file = item.file_name || 'Không rõ tệp';

      let badge = '🔴 Đã tồn tại trong CSDL';
      if (dupType === 'BATCH_DUPLICATE') {
        badge = '🟠 Trùng trong cùng đợt upload';
      } else if (dupType === 'SAME_COMPANY_DUPLICATE') {
        badge = `🔴 Đã tồn tại trong cùng công ty (${item.company_id || 'hiện tại'})`;
      } else if (dupType === 'CROSS_COMPANY_EXISTING') {
        badge = `🟡 Đã tồn tại ở công ty thành viên khác`;
      }

      content += `${idx}. **${name}** (CCCD: \`${cccd}\`) • Tệp: \`${file}\`\n`;
      content += `   - **Trạng thái**: ${badge}\n`;
      content += `   - **Chi tiết**: ${item.duplicate_reason || 'Đã phát hiện trùng lặp dữ liệu định danh CCCD.'}\n`;
      content += `   - **Xử lý**: 🛡️ *Hệ thống đã chặn tạo bản ghi mới, không ghi đè hồ sơ hiện có.*\n`;
    }
    content += `\n`;
  }

  // 2. NHÓM 2: CẦN KIỂM TRA THỦ CÔNG
  if (manualCheckItems.length > 0) {
    content += `⚠️ **NHÓM 2: CẦN KIỂM TRA THỦ CÔNG (${manualCheckItems.length} hồ sơ):**\n`;
    for (const { item, idx } of manualCheckItems) {
      const name = item.full_name || 'Nhân viên';
      const file = item.file_name || 'Không rõ tệp';
      content += `${idx}. **${name}** • Tệp: \`${file}\`\n`;
      content += `   - **Lý do**: ${item.duplicate_reason || 'Chưa xác định được số CCCD hoặc độ tin cậy OCR thấp.'}\n`;
      content += `   - **Xử lý**: ℹ️ *Cần HR kiểm tra bản scan gốc và bổ sung CCCD (Gõ: "CCCD của ${name}: [Số]").*\n`;
    }
    content += `\n`;
  }

  // 3. NHÓM 3: HỒ SƠ HỢP LỆ SẴN SÀNG TIẾP TỤC
  if (validItems.length > 0) {
    content += `🟢 **NHÓM 3: HỒ SƠ HỢP LỆ SẴN SÀNG TIẾP TỤC (${validItems.length} hồ sơ):**\n`;
    for (const { item, idx } of validItems) {
      const cccd = maskCccd(item.citizen_id);
      const name = item.full_name || 'Nhân viên';
      const file = item.file_name || 'Không rõ tệp';
      const compBadge = getCompanyBadge(item.company_status, item.company_id);
      content += `${idx}. **${name}** (CCCD: \`${cccd}\`) • Đơn vị: ${compBadge} • Tệp: \`${file}\`\n`;
    }
    content += `\n`;
  }

  // 4. HƯỚNG DẪN HÀNH ĐỘNG TIẾP THEO
  content += `---\n`;
  const unconfirmedValid = validItems.filter(v => v.item.company_status !== 'confirmed');
  const confirmedValid = validItems.filter(v => v.item.company_status === 'confirmed');

  if (validItems.length === 0) {
    content += `> ⛔ **Lưu ý bảo toàn dữ liệu**: Toàn bộ hồ sơ trong đợt tải lên đều bị trùng lặp hoặc cần kiểm tra thủ công. Hệ thống **không yêu cầu xác nhận công ty** và **chặn tạo bản ghi mới** để bảo toàn dữ liệu nhân sự.`;
  } else {
    content += `👉 **Hành động đề xuất cho các hồ sơ hợp lệ:**\n`;
    if (unconfirmedValid.length > 0) {
      const unconfirmedNums = unconfirmedValid.map(v => v.idx).join(', ');
      content += `- **Xác nhận công ty** (cho hồ sơ ${unconfirmedNums}): Gõ *"Hồ sơ [Số thứ tự] thuộc STL"* (hoặc VTX, SWC).\n`;
    }
    if (confirmedValid.length > 0) {
      const approveText = canApprove ? 'Duyệt toàn bộ hồ sơ hợp lệ' : 'Gửi trình duyệt hồ sơ hợp lệ';
      content += `- **Hoàn tất**: Gõ *"${approveText}"* để lưu các hồ sơ hợp lệ vào hệ thống (các hồ sơ trùng CCCD sẽ được tự động giữ lại ở trạng thái chặn).\n`;
    } else {
      const approveText = canApprove ? 'Duyệt toàn bộ' : 'Gửi trình duyệt';
      content += `- Sau khi xác nhận công ty cho các hồ sơ hợp lệ, gõ *"${approveText}"* để hoàn tất.\n`;
    }
  }

  return content;
}

module.exports = {
  renderStagingPreview,
  renderBatchSummary,
  maskCccd,
  formatSalary
};
