/**
 * APPROVAL SAFETY GATE SERVICE (CENTRALIZED GATEWAY)
 * File: auth-service/services/approvalSafetyGate.js
 * 
 * Single Source of Truth for Policy Conflict & Document Safety Validation
 * Fail-Closed Semantics across the entire Document Lifecycle:
 * - Direct Approval (/approve)
 * - Immediate Activation (/activate)
 * - Scheduled Activation (autoActivateDueDocuments cron)
 * - Document Restoration (/restore)
 */

const db = require('../db');
const { detectPolicyConflicts } = require('./policyConflictDetector');

/**
 * Thẩm định điều kiện an toàn nghiêm ngặt trước khi kích hoạt / phê duyệt / khôi phục văn bản
 * 
 * @param {Object} doc - Dữ liệu văn bản từ bảng documents
 * @param {Object} reqBody - Body của request (chứa acknowledge_warnings, override_reason nếu có)
 * @param {Object} client - PG Client nếu chạy trong transaction, hoặc null (sử dụng db pool)
 * @param {Array} confirmedRelationships - Danh sách quan hệ đã được phê duyệt
 * @returns {Promise<Object>} Kết quả thẩm định { passed, risk_level, status, code, error, ... }
 */
async function evaluateApprovalSafetyGate(doc, reqBody = {}, client = null, confirmedRelationships = []) {
  const runner = client || db;

  // 1. Kiểm soát số lượng và nội dung chunks mới nhất từ DB trong transaction
  const chunkCountRes = await runner.query(
    'SELECT COUNT(*)::int as count FROM chunks WHERE doc_version_id = $1',
    [doc.doc_version_id]
  );
  const chunkCount = chunkCountRes.rows[0]?.count || 0;
  if (chunkCount === 0) {
    return {
      passed: false,
      risk_level: 'HIGH',
      status: 400,
      code: 'APPROVE_BLOCKED_ZERO_CHUNK',
      error: 'Không thể phê duyệt/kích hoạt: Văn bản chưa có đoạn trích xuất (0 chunks) trong cơ sở dữ liệu. Vui lòng hoàn tất OCR/chunking trước khi tiếp tục.',
      blocking_conflicts: [{
        severity: 'HIGH',
        type: 'ZERO_CHUNKS',
        message: 'Văn bản chưa có đoạn trích xuất (0 chunks).'
      }],
      warnings: [],
      conflict_report: { has_conflict: true, blocking_conflicts: [] }
    };
  }

  const candidateChunksRes = await runner.query(
    "SELECT COALESCE(substring(string_agg(content, ' ' ORDER BY seq) from 1 for 15000), '') as text FROM chunks WHERE doc_version_id = $1",
    [doc.doc_version_id]
  );
  const candidateContent = candidateChunksRes.rows[0]?.text || '';
  if (!candidateContent || !candidateContent.trim()) {
    return {
      passed: false,
      risk_level: 'HIGH',
      status: 400,
      code: 'EXTRACTION_INCOMPLETE',
      error: 'Không thể phê duyệt/kích hoạt: Nội dung trích xuất của văn bản rỗng hoặc không hợp lệ. Vui lòng kiểm tra lại chất lượng OCR/trích xuất.',
      blocking_conflicts: [{
        severity: 'HIGH',
        type: 'EMPTY_CONTENT',
        message: 'Nội dung trích xuất của văn bản rỗng.'
      }],
      warnings: [],
      conflict_report: { has_conflict: true, blocking_conflicts: [] }
    };
  }

  // 2. Chạy Conflict Detection Engine trên nội dung thực tế mới nhất
  let conflictReport;
  try {
    conflictReport = await detectPolicyConflicts({
      doc_version_id: doc.doc_version_id,
      document_family_id: doc.document_family_id,
      doc_code: doc.doc_code,
      doc_number: doc.doc_number,
      title: doc.title,
      category: doc.category,
      content: candidateContent,
      branch_scope: doc.branch_scope || ['all'],
      department_scope: doc.department_scope || ['all'],
      business_unit_scope: doc.business_unit_scope || ['all'],
      employee_group_scope: doc.employee_group_scope || ['all'],
      effective_date: doc.effective_date,
      expiry_date: doc.expiry_date,
      file_sha256: doc.file_sha256
    }, { client: runner, confirmedRelationships });
  } catch (detectorErr) {
    console.error('Lỗi Conflict Engine trong evaluateApprovalSafetyGate:', detectorErr);
    return {
      passed: false,
      risk_level: 'HIGH',
      status: 503,
      code: 'CONFLICT_ENGINE_UNAVAILABLE',
      error: 'Hệ thống kiểm tra xung đột tạm thời không khả dụng. Giao dịch bị từ chối theo nguyên tắc an toàn (Fail-Closed).',
      blocking_conflicts: [{ severity: 'HIGH', type: 'CONFLICT_ENGINE_UNAVAILABLE', message: detectorErr.message }],
      warnings: [],
      conflict_report: { has_conflict: true, blocking_conflicts: [] }
    };
  }

  const allConflicts = conflictReport.conflicts || [];
  const rawBlocking = (conflictReport.blocking_conflicts && conflictReport.blocking_conflicts.length > 0)
    ? conflictReport.blocking_conflicts
    : allConflicts.filter(c => c.severity === 'HIGH');
  const rawWarnings = allConflicts.filter(c => c.severity === 'MEDIUM');

  // Rút gọn evidence_quote bảo mật
  const sanitizeQuote = (c) => ({
    ...c,
    evidence_quote: (c.evidence_quote && typeof c.evidence_quote === 'string' && c.evidence_quote.length > 80)
      ? c.evidence_quote.substring(0, 80).trim() + '...'
      : c.evidence_quote
  });
  const blockingConflicts = rawBlocking.map(sanitizeQuote);
  const warningConflicts = rawWarnings.map(sanitizeQuote);

  const isHighRisk = blockingConflicts.length > 0 || conflictReport.has_conflict;
  const isMediumRisk = !isHighRisk && (warningConflicts.length > 0 || conflictReport.has_warning);
  const riskLevel = isHighRisk ? 'HIGH' : (isMediumRisk ? 'MEDIUM' : 'LOW');

  // 3. Xử lý rủi ro HIGH: Chặn cứng tuyệt đối (HTTP 409) - Zero Bypass
  if (isHighRisk) {
    const mainConflict = blockingConflicts[0] || { type: 'TRUE_CONFLICT', message: 'Phát hiện xung đột pháp quy nghiêm trọng.' };
    return {
      passed: false,
      risk_level: 'HIGH',
      status: 409,
      code: 'APPROVAL_GATE_BLOCKED_HIGH_CONFLICT',
      conflict_type: mainConflict.type,
      error: `Không thể phê duyệt/kích hoạt do phát hiện trùng lặp hoặc xung đột chính sách nghiêm trọng (${mainConflict.type}): ${mainConflict.message}`,
      blocking_conflicts: blockingConflicts,
      warnings: warningConflicts,
      candidate_content: candidateContent,
      conflict_report: {
        ...conflictReport,
        conflicts: [...blockingConflicts, ...warningConflicts],
        blocking_conflicts: blockingConflicts
      }
    };
  }

  // 4. Xử lý rủi ro MEDIUM: Yêu cầu đồng thời acknowledge_warnings === true và override_reason >= 15 ký tự (HTTP 422 nếu thiếu)
  if (isMediumRisk) {
    const ack = Boolean(reqBody && (reqBody.acknowledge_warnings === true || reqBody.acknowledged_warnings === true));
    const reason = typeof reqBody?.override_reason === 'string' ? reqBody.override_reason.trim() : '';

    if (!ack || reason.length < 15) {
      const missingParts = [];
      if (!ack) missingParts.push('chưa tích chọn xác nhận đã thẩm tra cảnh báo (acknowledge_warnings: true)');
      if (reason.length < 15) missingParts.push(`lý do giải tỏa cảnh báo (override_reason) phải có ít nhất 15 ký tự (hiện có: ${reason.length} ký tự)`);

      return {
        passed: false,
        risk_level: 'MEDIUM',
        status: 422,
        code: 'APPROVAL_GATE_WARNINGS_REQUIRE_ACK',
        conflict_type: warningConflicts[0]?.type || 'POTENTIAL_CONFLICT',
        error: `Không thể phê duyệt/kích hoạt do văn bản có ${warningConflicts.length} cảnh báo cần xác nhận: Yêu cầu ${missingParts.join(' và ')}.`,
        warnings: warningConflicts,
        blocking_conflicts: [],
        candidate_content: candidateContent,
        conflict_report: {
          ...conflictReport,
          conflicts: warningConflicts,
          blocking_conflicts: []
        }
      };
    }

    // MEDIUM nhưng được xác nhận hợp lệ
    return {
      passed: true,
      risk_level: 'MEDIUM',
      acknowledged_warnings: true,
      override_reason: reason,
      warnings: warningConflicts,
      blocking_conflicts: [],
      candidate_content: candidateContent,
      conflict_report: conflictReport
    };
  }

  // 5. Xử lý rủi ro LOW: Cho phép phê duyệt / kích hoạt trực tiếp
  return {
    passed: true,
    risk_level: 'LOW',
    warnings: [],
    blocking_conflicts: [],
    candidate_content: candidateContent,
    conflict_report: conflictReport
  };
}

module.exports = {
  evaluateApprovalSafetyGate
};
