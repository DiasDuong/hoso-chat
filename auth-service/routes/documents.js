const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { verifyToken, requirePermission } = require('../middleware/auth');
const { syncDocumentToQdrant, deleteDocumentFromQdrant, syncAllDocumentsToQdrant, autoActivateDueDocuments } = require('../services/qdrantSyncService');
const { evaluateApprovalSafetyGate } = require('../services/approvalSafetyGate');
const { detectPolicyConflicts } = require('../services/policyConflictDetector');
const { ERROR_CATALOG, sendError, buildErrorResponse } = require('../services/errorCatalog');
const { stripNullBytes, stripNullBytesWithStats, sanitizeNullBytesRecursive } = require('../services/sanitizer');
const ocrDocumentPipeline = require('../services/ocrDocumentPipeline');
const multer = require('multer');
let PDFParseClass = null;
try {
  const pdfModule = require('pdf-parse');
  PDFParseClass = pdfModule.PDFParse || pdfModule;
} catch (e) {
  console.warn('pdf-parse not available:', e.message);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function getBaseStorageDir() {
  return process.platform === 'win32'
    ? path.resolve(__dirname, '../../files')
    : (fs.existsSync('/app/chat-files') ? '/app/chat-files' : path.resolve(__dirname, '../../files'));
}

async function validateUploadedFile(file) {
  if (!file || !file.buffer) {
    return { valid: false, status: 400, code: 'NO_FILE', error: 'Vui lòng cung cấp tệp tin tải lên.' };
  }
  const originalName = file.originalname || 'file';
  const val = ocrDocumentPipeline.validateFileBuffer(file.buffer, originalName, file.mimetype);
  if (!val.valid) {
    return val;
  }
  return { valid: true, ext: val.ext, originalName };
}

function saveFileToStorage(buffer, safeDocId, originalName) {
  const BASE_STORAGE_DIR = getBaseStorageDir();
  const policiesDir = path.join(BASE_STORAGE_DIR, 'policies');
  if (!fs.existsSync(policiesDir)) {
    fs.mkdirSync(policiesDir, { recursive: true });
  }

  const cleanOriginal = (originalName || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  const safeStorageName = String(safeDocId || 'POLICY').replace(/[^A-Za-z0-9_-]/g, '_') + '_' + Date.now() + '_' + cleanOriginal;
  const physicalPath = path.join(policiesDir, safeStorageName);

  fs.writeFileSync(physicalPath, buffer);

  if (!fs.existsSync(physicalPath) || fs.statSync(physicalPath).size !== buffer.length) {
    throw new Error('Lỗi ghi tệp tin lên hệ thống lưu trữ máy chủ: kích thước tệp không khớp.');
  }

  const readBack = fs.readFileSync(physicalPath);
  if (!readBack || readBack.length !== buffer.length) {
    throw new Error('Lỗi xác minh tệp tin: Không thể đọc lại tệp tin sau khi lưu trữ.');
  }

  const fileUri = 'policies/' + safeStorageName;
  return { fileUri, physicalPath, safeStorageName };
}

async function safeCleanupOrphanFile(fileUri) {
  if (!fileUri) return;
  try {
    const checkRes = await db.query('SELECT 1 FROM documents WHERE file_uri = $1 LIMIT 1', [fileUri]);
    if (checkRes.rows.length === 0) {
      const BASE_STORAGE_DIR = getBaseStorageDir();
      const physicalPath = path.join(BASE_STORAGE_DIR, fileUri);
      if (fs.existsSync(physicalPath)) {
        fs.unlinkSync(physicalPath);
      }
    }
  } catch (e) {
    console.warn('Lỗi dọn dẹp file mồ côi:', e.message);
  }
}

async function triggerDocumentExtraction(doc, fileBuf, fileName, options = {}) {
  try {
    const ext = path.extname(fileName || doc.file_uri || '').toLowerCase();
    const mimeType = options.mimeType || (ext === '.png' ? 'image/png' : (['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : (ext === '.pdf' ? 'application/pdf' : 'text/plain')));
    const pipeRes = await ocrDocumentPipeline.executeDocumentOcrPipeline(doc.doc_version_id, fileBuf, fileName, mimeType, options);
    return { ok: true, source: pipeRes.source, chunks_count: pipeRes.chunks_count, qdrant_points: pipeRes.qdrant_points_count, parse_quality: pipeRes.parse_quality };
  } catch (pipeErr) {
    console.warn('[Pipeline Fallback] OCR Pipeline warning, attempting n8n fallback:', pipeErr.message);
    const ext = path.extname(fileName || '').toLowerCase();
    if (['.md', '.txt', '.pdf'].includes(ext)) {
      return await triggerN8nExtraction(doc, fileBuf, fileName, options);
    }
    throw pipeErr;
  }
}

async function triggerN8nExtraction(doc, fileBuf, fileName, options = {}) {
  const ext = path.extname(fileName || doc.file_uri || '').toLowerCase();
  let blob;
  let uploadFileName = path.basename(fileName || doc.file_uri || 'file');

  if (ext === '.pdf') {
    blob = new Blob([fileBuf], { type: 'application/pdf' });
  } else if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const { value: textValue } = await mammoth.extractRawText({ buffer: fileBuf });
      const cleanDocxText = stripNullBytes((textValue || '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ''));
      blob = new Blob([Buffer.from(cleanDocxText, 'utf8')], { type: 'text/plain' });
      uploadFileName = uploadFileName.replace(/\.docx$/i, '.txt');
    } catch (e) {
      blob = new Blob([fileBuf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }
  } else {
    const cleanText = stripNullBytes(fileBuf.toString('utf8').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ''));
    blob = new Blob([Buffer.from(cleanText, 'utf8')], { type: 'text/plain' });
  }

  const safeDocId = (doc.document_family_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(doc.document_family_id))
    ? String(doc.document_family_id).replace(/[^A-Za-z0-9_-]/g, '_')
    : ('DOC_' + String(doc.doc_code || doc.document_id || 'POLICY').replace(/[^A-Za-z0-9_-]/g, '_'));

  function formatIsoDate(d) {
    if (!d) return new Date().toISOString().slice(0, 10);
    if (d instanceof Date) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    const s = String(d).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return new Date().toISOString().slice(0, 10);
  }

  const safeEffDate = formatIsoDate(doc.effective_date);
  const safeIssueDate = formatIsoDate(doc.issue_date || doc.effective_date);
  const safeBranch = Array.isArray(doc.branch_scope) ? doc.branch_scope.join(', ') : (doc.branch_scope || 'all');

  const formData = new FormData();
  formData.append('file', blob, uploadFileName);
  formData.append('doc_version_id', doc.doc_version_id);
  if (options.generationId) formData.append('generation_id', stripNullBytes(String(options.generationId)));
  if (options.fencingToken) formData.append('fencing_token', stripNullBytes(String(options.fencingToken)));
  formData.append('document_id', stripNullBytes(safeDocId));
  formData.append('document_family_id', stripNullBytes(doc.document_family_id || ('DOC-FAM-' + (doc.doc_code || doc.document_id))));
  formData.append('doc_code', stripNullBytes(doc.doc_code || doc.doc_number || 's/n'));
  formData.append('category', stripNullBytes(doc.category || 'CHINH_SACH'));
  formData.append('title', stripNullBytes(doc.title));
  formData.append('doc_number', stripNullBytes(doc.doc_code || doc.doc_number || 's/n'));
  formData.append('issue_date', stripNullBytes(safeIssueDate));
  formData.append('effective_date', stripNullBytes(safeEffDate));
  formData.append('branch_scope', stripNullBytes(safeBranch));
  formData.append('department_scope', stripNullBytes(Array.isArray(doc.department_scope) ? doc.department_scope.join(', ') : (doc.department_scope || 'all')));
  formData.append('business_unit_scope', stripNullBytes(Array.isArray(doc.business_unit_scope) ? doc.business_unit_scope.join(', ') : (doc.business_unit_scope || 'all')));
  formData.append('employee_group_scope', stripNullBytes(Array.isArray(doc.employee_group_scope) ? doc.employee_group_scope.join(', ') : (doc.employee_group_scope || 'all')));
  formData.append('change_type', stripNullBytes(doc.change_type || 'replace'));
  formData.append('change_summary', stripNullBytes(doc.change_summary || 'Ingest văn bản'));
  formData.append('actor', stripNullBytes(options.actor || 'admin'));
  if (doc.file_uri) formData.append('file_uri', stripNullBytes(doc.file_uri));

  const n8nHost = process.env.N8N_HOST || (process.platform === 'win32' ? 'http://127.0.0.1:5680' : 'http://sotrans-n8n-staging:5678');
  const n8nUrl = n8nHost + '/webhook/hr-upload-api';
  const n8nKey = process.env.INTERNAL_API_KEY || 'hpxgadw2nq4l8euiscoz17krmjv6f5y093bt';

  const response = await fetch(n8nUrl, {
    method: 'POST',
    headers: { 'X-HR-Admin-Key': n8nKey },
    body: formData,
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.message || data.error || ('Lỗi n8n HTTP ' + response.status));
  }
  return data;
}

// Quản lý Durable Retry Lease trong PostgreSQL (kèm RAM fallback dự phòng nếu chưa chạy migration)
const inFlightRetriesFallback = new Map();

async function checkLeaseTableExists(client) {
  try {
    const res = await client.query(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'document_retry_leases'
    `);
    return res.rows.length > 0;
  } catch (e) {
    return false;
  }
}

async function acquireDurableRetryLease(client, docVersionId, actor, idempotencyKey = null) {
  const hasLeaseTable = await checkLeaseTableExists(client);
  const now = new Date();
  const leaseDurationMs = 120000; // 2 phút lease
  const expiresAt = new Date(Date.now() + leaseDurationMs);
  const generationId = crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).substring(2, 9));

  if (!hasLeaseTable) {
    const existing = inFlightRetriesFallback.get(docVersionId);
    if (existing && (Date.now() - existing.startedAt < 60000)) {
      if (idempotencyKey && existing.idempotencyKey === idempotencyKey) {
        return { acquired: false, idempotencyMatch: true, lease: existing };
      }
      return { acquired: false, inProgress: true, actor: existing.actor, expiresAt: new Date(existing.startedAt + 60000) };
    }
    const token = (existing ? existing.fencingToken : 0) + 1;
    const leaseObj = { startedAt: Date.now(), retryId: generationId, generationId, fencingToken: token, actor, idempotencyKey };
    inFlightRetriesFallback.set(docVersionId, leaseObj);
    return { acquired: true, generationId, fencingToken: token, expiresAt, isFallback: true };
  }

  // PostgreSQL Atomic Lease (Insert if not exists, or Lock and Update)
  const insertRes = await client.query(
    `INSERT INTO document_retry_leases 
     (doc_version_id, generation_id, fencing_token, status, acquired_by, retry_idempotency_key, started_at, expires_at, updated_at)
     VALUES ($1, $2, 1, 'PROCESSING', $3, $4, NOW(), $5, NOW())
     ON CONFLICT (doc_version_id) DO NOTHING
     RETURNING *`,
    [docVersionId, generationId, actor, idempotencyKey, expiresAt]
  );

  if (insertRes.rows.length > 0) {
    return { acquired: true, generationId, fencingToken: 1, expiresAt, isFallback: false };
  }

  // Row already exists: Lock under FOR UPDATE and evaluate state
  const leaseRes = await client.query(
    'SELECT * FROM document_retry_leases WHERE doc_version_id = $1 FOR UPDATE',
    [docVersionId]
  );

  if (leaseRes.rows.length > 0) {
    const row = leaseRes.rows[0];
    const isExpired = new Date(row.expires_at) < now;
    const isFinished = ['PUBLISHED', 'FAILED', 'EXPIRED'].includes(row.status);

    if (idempotencyKey && row.retry_idempotency_key === idempotencyKey && !isExpired && row.status === 'PROCESSING') {
      return { acquired: false, idempotencyMatch: true, lease: row };
    }

    if (!isExpired && !isFinished) {
      return {
        acquired: false,
        inProgress: true,
        actor: row.acquired_by,
        expiresAt: row.expires_at,
        status: row.status
      };
    }

    const fencingToken = Number(row.fencing_token || 0) + 1;
    await client.query(
      `UPDATE document_retry_leases 
       SET generation_id = $2,
           fencing_token = $3,
           status = 'PROCESSING',
           acquired_by = $4,
           retry_idempotency_key = $5,
           started_at = NOW(),
           expires_at = $6,
           updated_at = NOW()
       WHERE doc_version_id = $1`,
      [docVersionId, generationId, fencingToken, actor, idempotencyKey, expiresAt]
    );

    return { acquired: true, generationId, fencingToken, expiresAt, isFallback: false };
  }

  return { acquired: true, generationId, fencingToken: 1, expiresAt, isFallback: false };
}

async function releaseOrUpdateLease(client, docVersionId, generationId, fencingToken, status, errorMessage = null) {
  const hasLeaseTable = await checkLeaseTableExists(client);
  if (!hasLeaseTable) {
    inFlightRetriesFallback.delete(docVersionId);
    return;
  }
  try {
    await client.query(
      `UPDATE document_retry_leases 
       SET status = $2,
           retry_reason = COALESCE($3, retry_reason),
           updated_at = NOW()
       WHERE doc_version_id = $1 AND fencing_token = $4`,
      [docVersionId, status, errorMessage, fencingToken]
    );
  } catch (err) {
    console.error('Lỗi cập nhật lease:', err.message);
  }
}

function enrichDocStatuses(d) {
  if (!d) return d;
  const chunkCount = typeof d.chunks === 'number' ? d.chunks : (parseInt(d.chunks, 10) || 0);
  const hasFile = !!(d.file_uri && String(d.file_uri).trim());

  // 1. Processing status
  let processing_status = 'WAITING';
  let processing_status_label = 'Chờ xử lý';
  if (chunkCount > 0) {
    processing_status = 'COMPLETED';
    processing_status_label = `Đã trích xuất (${chunkCount} đoạn)`;
  } else if (hasFile || d.file_sha256) {
    processing_status = 'FAILED_ZERO_CHUNK';
    processing_status_label = 'Chưa có đoạn (0 chunks)';
  } else {
    processing_status = 'WAITING_FILE';
    processing_status_label = 'Chưa có tệp đính kèm';
  }

  // 2. Approval status
  let approval_status = 'NOT_SUBMITTED';
  let approval_status_label = 'Chưa gửi duyệt';
  if (d.status === 'draft') {
    approval_status = 'DRAFT';
    approval_status_label = 'Bản nháp';
  } else if (d.status === 'pending_approval') {
    approval_status = 'PENDING_APPROVAL';
    approval_status_label = 'Chờ phê duyệt';
  } else if (d.status === 'testing') {
    approval_status = 'TESTING';
    approval_status_label = 'Đang kiểm thử RAG';
  } else if (d.status === 'rejected') {
    approval_status = 'REJECTED';
    approval_status_label = 'Bị từ chối';
  } else if (['scheduled', 'active', 'archived', 'superseded', 'revoked'].includes(d.status)) {
    approval_status = 'APPROVED';
    approval_status_label = 'Đã phê duyệt';
  }

  // 3. Activation status
  let activation_status = 'INACTIVE';
  let activation_status_label = 'Chưa kích hoạt';
  if (d.status === 'active') {
    activation_status = 'ACTIVE';
    activation_status_label = 'Đang áp dụng';
  } else if (d.status === 'scheduled') {
    activation_status = 'SCHEDULED';
    activation_status_label = 'Chờ hiệu lực';
  } else if (d.status === 'superseded') {
    activation_status = 'SUPERSEDED';
    activation_status_label = 'Hết hiệu lực (Bị thay thế)';
  } else if (d.status === 'archived') {
    activation_status = 'ARCHIVED';
    activation_status_label = 'Ngừng hiệu lực (Lưu trữ)';
  } else if (d.status === 'revoked') {
    activation_status = 'REVOKED';
    activation_status_label = 'Bị thu hồi';
  } else if (d.status === 'trash') {
    activation_status = 'TRASH';
    activation_status_label = 'Thùng rác';
  }

  return {
    ...d,
    chunks: chunkCount,
    has_file: hasFile,
    processing_status,
    processing_status_label,
    approval_status,
    approval_status_label,
    activation_status,
    activation_status_label
  };
}

// Map company_id to branch name
function getBranchForCompany(companyId) {
  if (!companyId) return null;
  const c = String(companyId).toUpperCase().trim();
  if (c === 'STL') return 'sotrans_logistics';
  if (c === 'VTX') return 'vietranstimex';
  if (c === 'SWC') return 'sowatco';
  return null;
}

// Kiểm tra quyền Super Admin toàn hệ thống (không dùng riêng is_admin)
function isSuperAdminUser(user) {
  if (!user) return false;
  const role = String(user.role || '').toUpperCase();
  const username = String(user.username || '').toLowerCase();
  if (role === 'SUPERADMIN' || role === 'SUPER_ADMIN') return true;
  if (role === 'ADMIN' && username === 'superadmin') return true;
  return false;
}

// Kiểm tra tính hợp lệ phạm vi Tenant của quan hệ văn bản
function checkRelationshipTenantScope(user, sourceBranchScope, targetBranchScope) {
  if (isSuperAdminUser(user)) {
    return { allowed: true, reason: 'Super Admin toàn hệ thống có toàn quyền' };
  }

  const userCompany = user && user.company_id ? String(user.company_id).toUpperCase().trim() : null;
  const userBranch = getBranchForCompany(userCompany);

  if (!userCompany || !userBranch) {
    return {
      allowed: false,
      status: 403,
      error: '403 Forbidden: Tài khoản không có company_id hợp lệ hoặc không xác định được phạm vi đơn vị.'
    };
  }

  const srcScope = Array.isArray(sourceBranchScope) ? sourceBranchScope : (sourceBranchScope ? [sourceBranchScope] : []);
  const tgtScope = Array.isArray(targetBranchScope) ? targetBranchScope : (targetBranchScope ? [targetBranchScope] : []);

  if (srcScope.length === 0 || tgtScope.length === 0) {
    return {
      allowed: false,
      status: 403,
      error: '403 Forbidden: Dữ liệu phạm vi áp dụng (branch_scope) của văn bản không hợp lệ.'
    };
  }

  // Quy tắc phạm vi:
  // - Văn bản có branch_scope = all được coi là văn bản dùng chung, có thể nằm trong phạm vi của các công ty.
  // - Cả văn bản nguồn và văn bản đích đều phải nằm trong phạm vi công ty người dùng được quản lý.
  const isSourceInScope = srcScope.includes(userBranch) || srcScope.includes('all');
  const isTargetInScope = tgtScope.includes(userBranch) || tgtScope.includes('all');

  if (!isSourceInScope || !isTargetInScope) {
    return {
      allowed: false,
      status: 403,
      error: '403 Forbidden: Bạn không có quyền quản lý quan hệ văn bản ngoài phạm vi công ty.'
    };
  }

  // Quan hệ thuần toàn tập đoàn (cả 2 văn bản đều là all, không thuộc branch công ty) chỉ do Super Admin quản lý
  const isPureCorporate = srcScope.length === 1 && srcScope[0] === 'all' &&
                          tgtScope.length === 1 && tgtScope[0] === 'all';
  if (isPureCorporate) {
    return {
      allowed: false,
      status: 403,
      error: '403 Forbidden: Quan hệ chính sách thuần toàn tập đoàn chỉ do Super Admin quản lý.'
    };
  }

  return { allowed: true, userBranch, userCompany };
}

// Kiểm tra quyền xem thông tin chi tiết văn bản theo Tenant Boundary (Bảo vệ rò rỉ chéo tenant VER-DUP-01, VER-DUP-02)
function isAuthorizedForDoc(user, doc) {
  if (!doc) return false;
  if (isSuperAdminUser(user)) return true;
  if (!user || !user.company_id || !doc.branch_scope) return false;
  const userBranch = getBranchForCompany(String(user.company_id).toUpperCase().trim());
  const scope = Array.isArray(doc.branch_scope) ? doc.branch_scope : [doc.branch_scope];
  return scope.includes('all') || (userBranch && scope.includes(userBranch));
}

// =========================================================================
// DANH MỤC QUAN HỆ VĂN BẢN CHUẨN HÓA TOÀN HỆ THỐNG (SINGLE SOURCE OF TRUTH)
// =========================================================================
const DOCUMENT_RELATIONSHIP_TAXONOMY = [
  { id: 'independent', label: 'Văn bản độc lập', desc: 'Không thiết lập quan hệ với văn bản khác (ban hành mới hoàn toàn).' },
  { id: 'supersedes', label: 'Thay thế văn bản cũ', desc: 'Văn bản mới thay thế văn bản cũ (bãi bỏ bản cũ khi có hiệu lực).' },
  { id: 'amends', label: 'Sửa đổi văn bản cũ', desc: 'Văn bản mới sửa đổi một phần nội dung của văn bản cũ.' },
  { id: 'supplements', label: 'Bổ sung văn bản cũ', desc: 'Văn bản mới bổ sung nội dung cho văn bản cũ.' },
  { id: 'exception_to', label: 'Quy định ngoại lệ', desc: 'Văn bản mới quy định ngoại lệ đối với văn bản cũ (áp dụng cho phạm vi hẹp).' },
  { id: 'clarifies', label: 'Làm rõ / Hướng dẫn áp dụng', desc: 'Văn bản mới làm rõ hoặc hướng dẫn áp dụng văn bản cũ.' },
  { id: 'applies_with', label: 'Áp dụng song song (Tham chiếu)', desc: 'Áp dụng đồng thời cùng văn bản hiện hành (không sửa đổi hay bãi bỏ).' }
];

const VALID_RELATION_TYPES = ['supersedes', 'amends', 'supplements', 'exception_to', 'clarifies', 'applies_with'];

/**
 * Kiểm tra mâu thuẫn ngữ nghĩa và trùng lặp quan hệ văn bản
 * @param {Object} dbClient - PostgreSQL client hoặc pool
 * @param {string} sourceId - doc_version_id nguồn
 * @param {string} targetId - doc_version_id đích
 * @param {string} relationType - loại quan hệ ('supersedes', 'amends', 'supplements', 'exception_to', 'clarifies', 'applies_with')
 * @returns {Promise<{valid: boolean, status?: number, code?: string, error?: string}>}
 */
async function checkRelationshipContradiction(dbClient, sourceId, targetId, relationType) {
  if (!sourceId || !targetId) {
    return { valid: false, status: 400, code: 'MISSING_DOC_ID', error: 'Thiếu mã định danh văn bản nguồn hoặc đích.' };
  }
  if (sourceId === targetId) {
    return { valid: false, status: 400, code: 'SELF_RELATION', error: 'Văn bản không thể tự thiết lập quan hệ với chính nó.' };
  }
  if (relationType === 'independent') {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_INDEPENDENT_LINK',
      error: 'Loại "independent" (văn bản độc lập) biểu thị không có quan hệ, không thể liên kết giữa hai văn bản.'
    };
  }

  // Truy vấn toàn bộ quan hệ hiện có giữa 2 văn bản theo cả 2 chiều (chỉ xét các quan hệ chưa bị từ chối)
  const existingRes = await dbClient.query(`
    SELECT relationship_id, source_doc_version_id, target_doc_version_id, relation_type, approval_status
    FROM document_relationships
    WHERE ((source_doc_version_id = $1 AND target_doc_version_id = $2)
       OR (source_doc_version_id = $2 AND target_doc_version_id = $1))
      AND approval_status != 'rejected'
  `, [sourceId, targetId]);

  const existing = existingRes.rows;
  const directRelations = existing.filter(r => r.source_doc_version_id === sourceId && r.target_doc_version_id === targetId);
  const reverseRelations = existing.filter(r => r.source_doc_version_id === targetId && r.target_doc_version_id === sourceId);

  // 1. TÌNH HUỐNG 1: Duplicate cùng chiều (A -> B với cùng relation_type)
  const exactDuplicate = directRelations.find(r => r.relation_type === relationType);
  if (exactDuplicate) {
    return {
      valid: false,
      status: 409,
      code: 'DUPLICATE_RELATIONSHIP',
      error: `Quan hệ "${relationType}" giữa hai văn bản này đã tồn tại trong hệ thống (ID: ${exactDuplicate.relationship_id}, trạng thái: ${exactDuplicate.approval_status}).`
    };
  }

  // 2. Mâu thuẫn cùng chiều: A đã thay thế B thì không thể bổ sung/sửa đổi/ngoại lệ/làm rõ B (và ngược lại)
  if (relationType === 'supersedes' && directRelations.length > 0) {
    const existingTypes = directRelations.map(r => r.relation_type).join(', ');
    return {
      valid: false,
      status: 409,
      code: 'CONTRADICTORY_SUPERSEDES',
      error: `Mâu thuẫn ngữ nghĩa: Văn bản nguồn đã có quan hệ [${existingTypes}] với văn bản đích, không thể đồng thời thiết lập quan hệ thay thế (supersedes).`
    };
  }
  const hasDirectSupersedes = directRelations.find(r => r.relation_type === 'supersedes');
  if (hasDirectSupersedes) {
    return {
      valid: false,
      status: 409,
      code: 'ALREADY_SUPERSEDED',
      error: `Mâu thuẫn ngữ nghĩa: Văn bản nguồn đã thay thế hoàn toàn văn bản đích (supersedes), không thể thiết lập thêm quan hệ "${relationType}".`
    };
  }

  // 3. TÌNH HUỐNG: applies_with (Quan hệ đối xứng)
  // Nếu B applies_with A đã tồn tại, việc tạo A applies_with B là duplicate đối xứng
  if (relationType === 'applies_with') {
    const reverseAppliesWith = reverseRelations.find(r => r.relation_type === 'applies_with');
    if (reverseAppliesWith) {
      return {
        valid: false,
        status: 409,
        code: 'SYMMETRIC_DUPLICATE',
        error: `Quan hệ áp dụng song song (applies_with) đã được thiết lập theo chiều ngược lại giữa hai văn bản này (ID: ${reverseAppliesWith.relationship_id}).`
      };
    }
  }

  // 4. TÌNH HUỐNG: A supersedes B, sau đó B supersedes A (Vòng lặp bãi bỏ lẫn nhau)
  if (relationType === 'supersedes') {
    const reverseSupersedes = reverseRelations.find(r => r.relation_type === 'supersedes');
    if (reverseSupersedes) {
      return {
        valid: false,
        status: 409,
        code: 'CIRCULAR_SUPERSEDES',
        error: 'Mâu thuẫn nghiêm trọng (Vòng lặp bãi bỏ): Văn bản đích đã thiết lập thay thế văn bản nguồn, không thể thiết lập quan hệ thay thế ngược lại.'
      };
    }
  }

  // 5. TÌNH HUỐNG: B đã supersedes A (văn bản nguồn A đã bị văn bản đích B thay thế/bãi bỏ).
  // Văn bản bị bãi bỏ không thể bổ sung, sửa đổi, làm rõ hay ngoại lệ cho văn bản kế thừa nó.
  const targetSupersedesSource = reverseRelations.find(r => r.relation_type === 'supersedes');
  if (targetSupersedesSource) {
    return {
      valid: false,
      status: 409,
      code: 'REVOKED_DOC_RELATION',
      error: `Mâu thuẫn ngữ nghĩa: Văn bản nguồn đã bị văn bản đích thay thế/bãi bỏ (superseded), không thể thiết lập quan hệ "${relationType}" với văn bản đích.`
    };
  }

  // 6. TÌNH HUỐNG: B amends/supplements A (B là văn bản sửa đổi/bổ sung của A), sau đó A supersedes B
  if (relationType === 'supersedes') {
    const reverseModifier = reverseRelations.find(r => ['amends', 'supplements', 'exception_to'].includes(r.relation_type));
    if (reverseModifier) {
      return {
        valid: false,
        status: 409,
        code: 'CONFLICTING_SUPERSEDES_MODIFIER',
        error: `Mâu thuẫn nghiệp vụ: Văn bản đích đang là văn bản ${reverseModifier.relation_type} của văn bản nguồn, không thể thiết lập quan hệ thay thế (supersedes) ngược lại.`
      };
    }
  }

  // 7. TÌNH HUỐNG: A clarifies B, sau đó B clarifies A (Vòng lặp làm rõ / hướng dẫn)
  if (relationType === 'clarifies') {
    const reverseClarifies = reverseRelations.find(r => r.relation_type === 'clarifies');
    if (reverseClarifies) {
      return {
        valid: false,
        status: 409,
        code: 'CIRCULAR_CLARIFICATION',
        error: 'Mâu thuẫn hướng quan hệ: Văn bản đích đã là văn bản làm rõ/hướng dẫn cho văn bản nguồn, không thể thiết lập quan hệ làm rõ theo chiều ngược lại.'
      };
    }
  }

  // 8. TÌNH HUỐNG: Vòng lặp sửa đổi, bổ sung hoặc ngoại lệ ngược chiều (mutual loops)
  if (relationType === 'amends' && reverseRelations.some(r => r.relation_type === 'amends')) {
    return {
      valid: false,
      status: 409,
      code: 'MUTUAL_AMENDMENT',
      error: 'Mâu thuẫn ngữ nghĩa: Hai văn bản không thể cùng là văn bản sửa đổi của nhau.'
    };
  }
  if (relationType === 'supplements' && reverseRelations.some(r => r.relation_type === 'supplements')) {
    return {
      valid: false,
      status: 409,
      code: 'MUTUAL_SUPPLEMENT',
      error: 'Mâu thuẫn ngữ nghĩa: Hai văn bản không thể cùng là văn bản bổ sung của nhau.'
    };
  }
  if (relationType === 'exception_to' && reverseRelations.some(r => r.relation_type === 'exception_to')) {
    return {
      valid: false,
      status: 409,
      code: 'MUTUAL_EXCEPTION',
      error: 'Mâu thuẫn nghiệp vụ: Hai văn bản không thể cùng là quy định ngoại lệ của nhau.'
    };
  }

  // 9. TÌNH HUỐNG: Kiểm tra chu trình vòng lặp đa cấp (Multi-hop DAG Cycle Detection)
  // Áp dụng cho các quan hệ kế thừa / thứ bậc: supersedes, amends, supplements
  if (['supersedes', 'amends', 'supplements'].includes(relationType)) {
    try {
      const cycleCheckRes = await dbClient.query(`
        WITH RECURSIVE rel_chain AS (
          SELECT target_doc_version_id, ARRAY[source_doc_version_id, target_doc_version_id] AS path_nodes
          FROM document_relationships
          WHERE source_doc_version_id = $1
            AND relation_type = $3
            AND approval_status != 'rejected'
          UNION ALL
          SELECT r.target_doc_version_id, rc.path_nodes || r.target_doc_version_id
          FROM document_relationships r
          JOIN rel_chain rc ON r.source_doc_version_id = rc.target_doc_version_id
          WHERE r.relation_type = $3
            AND r.approval_status != 'rejected'
            AND NOT (r.target_doc_version_id = ANY(rc.path_nodes))
        )
        SELECT 1 FROM rel_chain WHERE target_doc_version_id = $2 LIMIT 1;
      `, [targetId, sourceId, relationType]);

      if (cycleCheckRes.rows.length > 0) {
        return {
          valid: false,
          status: 409,
          code: 'CIRCULAR_RELATIONSHIP_DETECTED',
          error: `Phát hiện chu trình vòng lặp quan hệ (${relationType}): Văn bản đích đã gián tiếp liên kết tới văn bản nguồn qua chuỗi quan hệ hiện có.`
        };
      }
    } catch (cycleErr) {
      console.warn('[CYCLE CHECK WARN]:', cycleErr.message);
    }
  }

  return { valid: true };
}

// -------------------------------------------------------------
// DETERMINISTIC LIFECYCLE STATE MACHINE VALIDATOR
// -------------------------------------------------------------
const VALID_LIFECYCLE_TRANSITIONS = {
  draft: ['pending_approval', 'active', 'scheduled', 'trash'], // active/scheduled cho phép với ADMIN Direct Approval
  pending_approval: ['active', 'scheduled', 'rejected', 'draft', 'trash'],
  rejected: ['draft', 'pending_approval', 'trash'],
  active: ['superseded', 'revoked', 'archived', 'trash'],
  superseded: ['trash', 'archived'],
  revoked: ['trash', 'archived'],
  archived: ['trash', 'active'],
  trash: ['draft', 'active', 'superseded', 'archived', 'rejected'], // Khôi phục về trạng thái trước khi xóa
  testing: ['draft', 'active', 'scheduled', 'trash'],
  scheduled: ['active', 'trash', 'revoked', 'archived'] // Tự động kích hoạt khi đến hạn
};

function validateStateTransition(currentStatus, targetStatus, role = 'USER') {
  const allowed = VALID_LIFECYCLE_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_STATE_TRANSITION',
      error: `Chuyển đổi trạng thái không hợp lệ: Không thể chuyển văn bản từ '${currentStatus}' sang '${targetStatus}'.`
    };
  }

  // Phân quyền: Chỉ ADMIN/SUPER_ADMIN mới có quyền duyệt/kích hoạt trực tiếp
  if (['active', 'superseded', 'revoked', 'archived'].includes(targetStatus)) {
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(String(role).toUpperCase());
    if (!isAdmin) {
      return {
        valid: false,
        status: 403,
        code: 'ROLE_TRANSITION_FORBIDDEN',
        error: `403 Forbidden: Chỉ Quản trị viên (ADMIN) mới có quyền chuyển trạng thái văn bản sang '${targetStatus}'.`
      };
    }
  }

  return { valid: true };
}

// Log action to document_audit_logs
async function logDocAudit(req, docVersionId, documentId, action, statusBefore, statusAfter, reason = null, detail = {}, client = null) {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const runner = client || db;
    await runner.query(
      `INSERT INTO document_audit_logs 
        (doc_version_id, document_id, action, actor_user_id, actor_username, actor_role, actor_company, status_before, status_after, reason, detail, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        docVersionId,
        documentId,
        action,
        req.user.user_id,
        req.user.username,
        req.user.role,
        req.user.company_id || null,
        statusBefore,
        statusAfter,
        reason,
        JSON.stringify(detail),
        ip
      ]
    );
  } catch (err) {
    console.error('Lỗi ghi audit log văn bản:', err);
  }
}

// 1. GET /api/documents - Danh sách văn bản theo phạm vi công ty & quản trị phân cấp
router.get('/', verifyToken, async (req, res) => {
  try {
    await autoActivateDueDocuments().catch(e => console.error('Lỗi autoActivate trong GET /documents:', e.message));

    const { status, search, category, document_family_id, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];

    // Phân quyền phạm vi công ty:
    // Non-superadmin chỉ thấy văn bản công ty mình + văn bản chung toàn tập đoàn (all)
    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      params.push([userBranch || 'none', 'all']);
      conditions.push(`d.branch_scope && $${params.length}::text[]`);
    }

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`d.status = $${params.length}`);
    }

    if (category) {
      params.push(category);
      conditions.push(`d.category = $${params.length}`);
    }

    if (document_family_id) {
      params.push(document_family_id);
      conditions.push(`d.document_family_id = $${params.length}`);
    }

    if (search) {
      params.push(`%${search.trim()}%`);
      conditions.push(`(d.title ILIKE $${params.length} OR d.document_id ILIKE $${params.length} OR d.doc_number ILIKE $${params.length} OR d.doc_code ILIKE $${params.length} OR d.document_family_id ILIKE $${params.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `SELECT COUNT(*) FROM documents d ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const query = `
      SELECT d.doc_version_id, d.document_id, d.document_family_id, d.doc_code, d.category,
             d.version, d.title, d.doc_number, d.doc_type,
             d.department_scope, d.business_unit_scope, d.location_scope, d.employee_group_scope,
             d.issue_date, d.effective_date, d.expiry_date, d.status, d.role_access, d.branch_scope,
             d.change_summary, d.file_uri, d.file_sha256, d.uploaded_by, d.approved_by, d.approved_at, d.creator_user_id,
             d.approver_user_id, d.submitted_at, d.reject_reason, d.archived_at, d.archived_by,
             d.archive_reason, d.created_at,
             COALESCE((SELECT COUNT(*)::int FROM chunks c WHERE c.doc_version_id = d.doc_version_id), 0) AS chunks
      FROM documents d
      ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const result = await db.query(query, [...params, limitNum, offset]);

    return res.json({
      success: true,
      data: result.rows.map(enrichDocStatuses),
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (err) {
    console.error('Lỗi lấy danh sách văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ khi truy vấn văn bản.' });
  }
});

// Helper: GET /api/documents/scopes - Danh mục chuẩn hóa cho Wizard
router.get('/scopes', verifyToken, async (req, res) => {
  try {
    const userCompany = req.user.company_id ? String(req.user.company_id).toUpperCase().trim() : null;
    const isSuper = isSuperAdminUser(req.user);
    const userBranch = getBranchForCompany(userCompany);

    const allBranches = [
      { id: 'all', label: 'Toàn tập đoàn SOTRANS (Tất cả công ty con)', code: 'ALL' },
      { id: 'sotrans_logistics', label: 'Công ty TNHH MTV SOTRANS Logistics (STL)', code: 'STL' },
      { id: 'vietranstimex', label: 'CTCP Vận tải Đa phương thức Vietranstimex (VTX)', code: 'VTX' },
      { id: 'sowatco', label: 'Tổng CTCP Đường sông Miền Nam - SOWATCO (SWC)', code: 'SWC' }
    ];

    let allowedBranches = [];
    if (isSuper) {
      allowedBranches = allBranches;
    } else {
      allowedBranches = allBranches.filter(b => b.id === userBranch);
    }

    const departments = [
      { id: 'khoi_van_phong', label: 'Khối Văn phòng' },
      { id: 'ke_toan', label: 'Tài chính - Kế toán' },
      { id: 'nhan_su', label: 'Nhân sự - Hành chính' },
      { id: 'chuyen_doi_so', label: 'Chuyển đổi số & CNTT' },
      { id: 'kho_bai', label: 'Khai thác Kho bãi' },
      { id: 'chi_nhanh_kho_van', label: 'Chi nhánh Kho vận' },
      { id: 'van_tai', label: 'Vận tải & Đội xe' },
      { id: 'giao_nhan', label: 'Giao nhận & Cước quốc tế' },
      { id: 'cong_truong', label: 'Hiện trường / Công trường' },
      { id: 'du_an', label: 'Ban Quản lý Dự án' },
      { id: 'hien_truong', label: 'Hiện trường' },
      { id: 'tru_so_chinh', label: 'Trụ sở chính' }
    ];

    const businessUnits = [
      { id: 'tru_so_chinh', label: 'Trụ sở chính' },
      { id: 'trung_tam_chuyen_doi_so', label: 'Trung tâm Chuyển đổi số' },
      { id: 'chi_nhanh_kho_van', label: 'Chi nhánh Kho vận & Cảng ICD' },
      { id: 'chi_nhanh_vtx', label: 'Chi nhánh Vietranstimex' },
      { id: 'sotrans_logistics', label: 'Khối SOTRANS Logistics' },
      { id: 'vietranstimex', label: 'Khối Vietranstimex' },
      { id: 'sowatco', label: 'Khối SOWATCO' }
    ];

    const employeeGroups = [
      { id: 'nhan_vien_chuyen_doi_so', label: 'Nhân viên Chuyển đổi số & CNTT' },
      { id: 'van_hanh_linh_hoat', label: 'Nhân sự vận hành giờ làm linh hoạt' },
      { id: 'ky_su_cong_truong', label: 'Kỹ sư công trường / Giám sát' },
      { id: 'to_doi_spmt', label: 'Tổ đội xe chuyên dụng SPMT' },
      { id: 'lai_xe_nang', label: 'Lái xe nâng / Xe cẩu' },
      { id: 'nhan_vien_kho', label: 'Nhân viên kho bãi / Thủ kho' },
      { id: 'tally', label: 'Nhân viên kiểm đếm (Tally)' },
      { id: 'chuyen_gia_du_an', label: 'Chuyên gia / Cán bộ dự án' }
    ];

    const relationshipTypes = DOCUMENT_RELATIONSHIP_TAXONOMY;

    return res.json({
      success: true,
      user: {
        is_super_admin: isSuper,
        company_id: userCompany,
        user_branch: userBranch
      },
      branches: allowedBranches,
      departments,
      business_units: businessUnits,
      employee_groups: employeeGroups,
      relationship_types: relationshipTypes
    });
  } catch (err) {
    console.error('Lỗi lấy scopes:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: GET /api/documents/families - Danh sách dòng văn bản
router.get('/families', verifyToken, async (req, res) => {
  try {
    const isSuper = isSuperAdminUser(req.user);
    const userBranch = getBranchForCompany(req.user.company_id);

    let query = `
      SELECT document_family_id, title, doc_code, doc_number, MAX(version) AS max_version,
             status, branch_scope, COUNT(*)::int AS total_versions
      FROM documents
      WHERE document_family_id IS NOT NULL
    `;
    const params = [];
    if (!isSuper) {
      params.push([userBranch || 'none', 'all']);
      query += ` AND branch_scope && $1::text[]`;
    }
    query += `
      GROUP BY document_family_id, title, doc_code, doc_number, status, branch_scope
      ORDER BY title ASC
    `;
    const result = await db.query(query, params);
    return res.json({ success: true, families: result.rows });
  } catch (err) {
    console.error('Lỗi lấy danh sách families:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: POST /api/documents/check-duplicate - Kiểm tra trùng file SHA-256 hoặc mã hiệu
router.post('/check-duplicate', verifyToken, async (req, res) => {
  try {
    let { file_sha256, doc_code, exclude_doc_version_id, document_family_id } = req.body;
    file_sha256 = stripNullBytes(file_sha256);
    doc_code = stripNullBytes(doc_code);
    let duplicateFile = null;
    let duplicateCode = null;

    if (file_sha256 && file_sha256.trim()) {
      let fQuery = "SELECT doc_version_id, document_family_id, doc_code, doc_number, title, version, status, branch_scope FROM documents WHERE file_sha256 = $1 AND deleted_at IS NULL AND status NOT IN ('rejected', 'archived', 'trash')";
      const fParams = [file_sha256.trim()];
      if (exclude_doc_version_id) {
        fQuery += ' AND doc_version_id != $2';
        fParams.push(exclude_doc_version_id);
      }
      fQuery += ' LIMIT 1';

      const fRes = await db.query(fQuery, fParams);
      if (fRes.rows.length > 0) {
        duplicateFile = fRes.rows[0];
      }
    }

    if (doc_code && doc_code.trim() && doc_code.trim() !== 's/n') {
      let cQuery = "SELECT doc_version_id, document_family_id, doc_code, doc_number, title, version, status, branch_scope FROM documents WHERE (doc_code ILIKE $1 OR doc_number ILIKE $1) AND status NOT IN ('rejected', 'archived', 'trash') AND deleted_at IS NULL";
      const cParams = [doc_code.trim()];
      if (exclude_doc_version_id) {
        cQuery += ' AND doc_version_id != $2';
        cParams.push(exclude_doc_version_id);
      }
      cQuery += ' LIMIT 1';

      const cRes = await db.query(cQuery, cParams);
      if (cRes.rows.length > 0) {
        duplicateCode = cRes.rows[0];
      }
    }

    const isDuplicate = !!(duplicateFile || duplicateCode);
    let duplicateType = null;
    let message = 'Không phát hiện trùng lặp.';
    let sanitizedFile = null;
    let sanitizedCode = null;

    if (duplicateFile) {
      const isFileAuth = isAuthorizedForDoc(req.user, duplicateFile);
      const isSameFamily = document_family_id && duplicateFile.document_family_id && (document_family_id === duplicateFile.document_family_id);

      if (!isFileAuth) {
        duplicateType = 'EXISTING_DOCUMENT_RESTRICTED';
        message = 'Tập tin hoặc mã hiệu đã tồn tại trong hệ thống. Vui lòng liên hệ Quản trị viên Tập đoàn để đối soát.';
        sanitizedFile = {
          is_duplicate: true
        };
      } else if (isSameFamily) {
        duplicateType = 'IDENTICAL_FILE_SAME_FAMILY';
        message = `Tập tin này có nội dung hoàn toàn trùng khớp với phiên bản v${duplicateFile.version} của chính dòng văn bản "${duplicateFile.title}".`;
        sanitizedFile = {
          doc_version_id: duplicateFile.doc_version_id,
          document_family_id: duplicateFile.document_family_id,
          doc_code: duplicateFile.doc_code || duplicateFile.doc_number,
          title: duplicateFile.title,
          version: duplicateFile.version,
          status: duplicateFile.status,
          branch_scope: duplicateFile.branch_scope
        };
      } else {
        duplicateType = 'EXACT_DUPLICATE_FILE';
        message = `Tập tin này trùng khớp 100% nội dung (SHA-256) với "${duplicateFile.title}" (${duplicateFile.doc_code || duplicateFile.doc_number}, v${duplicateFile.version}, ${duplicateFile.status}).`;
        sanitizedFile = {
          doc_version_id: duplicateFile.doc_version_id,
          document_family_id: duplicateFile.document_family_id,
          doc_code: duplicateFile.doc_code || duplicateFile.doc_number,
          title: duplicateFile.title,
          version: duplicateFile.version,
          status: duplicateFile.status,
          branch_scope: duplicateFile.branch_scope
        };
      }
    }

    if (duplicateCode) {
      const isCodeAuth = isAuthorizedForDoc(req.user, duplicateCode);
      const isSameFamily = document_family_id && duplicateCode.document_family_id && (document_family_id === duplicateCode.document_family_id);

      if (!isCodeAuth) {
        if (!duplicateType) duplicateType = 'EXISTING_DOCUMENT_RESTRICTED';
        if (!duplicateFile) {
          message = 'Tập tin hoặc mã hiệu đã tồn tại trong hệ thống. Vui lòng liên hệ Quản trị viên Tập đoàn để đối soát.';
        }
        sanitizedCode = {
          is_duplicate: true
        };
      } else if (isSameFamily) {
        duplicateType = duplicateType || 'SAME_FAMILY_CODE';
        if (!duplicateFile) {
          message = `Mã hiệu "${doc_code}" thuộc dòng văn bản "${duplicateCode.title}" (v${duplicateCode.version}). Sẽ tạo phiên bản tiếp theo.`;
        }
        sanitizedCode = {
          doc_version_id: duplicateCode.doc_version_id,
          document_family_id: duplicateCode.document_family_id,
          doc_code: duplicateCode.doc_code || duplicateCode.doc_number,
          title: duplicateCode.title,
          version: duplicateCode.version,
          status: duplicateCode.status,
          branch_scope: duplicateCode.branch_scope
        };
      } else {
        duplicateType = duplicateType || 'DUPLICATE_DOC_CODE';
        if (!duplicateFile) {
          message = `Mã hiệu "${doc_code}" đã tồn tại trong hệ thống (${duplicateCode.title}, v${duplicateCode.version}).`;
        }
        sanitizedCode = {
          doc_version_id: duplicateCode.doc_version_id,
          document_family_id: duplicateCode.document_family_id,
          doc_code: duplicateCode.doc_code || duplicateCode.doc_number,
          title: duplicateCode.title,
          version: duplicateCode.version,
          status: duplicateCode.status,
          branch_scope: duplicateCode.branch_scope
        };
      }
    }

    return res.json({
      success: true,
      is_duplicate: isDuplicate,
      duplicate_type: duplicateType,
      duplicate_file: sanitizedFile,
      duplicate_code: sanitizedCode,
      message
    });
  } catch (err) {
    console.error('Lỗi check-duplicate:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. GET /api/documents/:id - Chi tiết văn bản
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const isUuid = /^[0-9a-f-]{36}$/i.test(id);

    const query = isUuid
      ? 'SELECT d.*, COALESCE((SELECT COUNT(*)::int FROM chunks c WHERE c.doc_version_id = d.doc_version_id), 0) AS chunks FROM documents d WHERE d.doc_version_id = $1'
      : 'SELECT d.*, COALESCE((SELECT COUNT(*)::int FROM chunks c WHERE c.doc_version_id = d.doc_version_id), 0) AS chunks FROM documents d WHERE d.document_id = $1 ORDER BY d.version DESC LIMIT 1';

    const result = await db.query(query, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản yêu cầu.' });
    }

    const doc = result.rows[0];

    // Kiểm tra phạm vi công ty
    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      const isAllowed = doc.branch_scope && (doc.branch_scope.includes('all') || doc.branch_scope.includes(userBranch));
      if (!isAllowed) {
        return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền truy cập văn bản của công ty khác.' });
      }
    }

    return res.json({ success: true, document: enrichDocStatuses(doc) });
  } catch (err) {
    console.error('Lỗi lấy chi tiết văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 3. POST /api/documents - Tạo/Tiếp nhận văn bản mới (Business-First Intake)
router.post('/', verifyToken, requirePermission('document.create'), upload.single('file'), async (req, res) => {
  const client = await db.getClient();
  let inTransaction = false;
  let savedFileUri = null;
  try {
    let {
      document_id,
      document_family_id,
      doc_code,
      category = 'CHINH_SACH',
      title,
      doc_number,
      doc_type = 'Quy chế',
      issue_date,
      effective_date,
      expiry_date,
      change_summary = 'Tạo mới hồ sơ văn bản',
      branch_scope,
      department_scope = ['all'],
      business_unit_scope = ['all'],
      location_scope = ['all'],
      employee_group_scope = ['all'],
      file_sha256,
      file_uri,
      topics,
      relationships,
      relationship,
      submit_for_approval = false
    } = req.body;

    title = stripNullBytes(title);
    doc_code = stripNullBytes(doc_code);
    doc_number = stripNullBytes(doc_number);
    change_summary = stripNullBytes(change_summary);

    if (typeof submit_for_approval === 'string') submit_for_approval = (submit_for_approval === 'true');
    if (typeof relationships === 'string') {
      try { relationships = JSON.parse(relationships); } catch (e) {}
    }
    if (typeof topics === 'string') {
      try { topics = JSON.parse(topics); } catch (e) {}
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Tiêu đề văn bản không được để trống.' });
    }

    // 0. Nếu có đính kèm file: Validate file signature & định dạng TRƯỚC TIÊN
    let validatedFile = null;
    let actualFileSha256 = (file_sha256 && file_sha256.trim()) ? stripNullBytes(file_sha256.trim()) : null;
    if (req.file) {
      const val = await validateUploadedFile(req.file);
      if (!val.valid) {
        return res.status(val.status).json({ success: false, code: val.code, error: val.error });
      }
      validatedFile = val;
      actualFileSha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    }

    // Xác thực danh mục quan hệ văn bản đi kèm nếu có khai báo
    const relInput = relationships || (relationship ? [relationship] : []);
    const relArray = Array.isArray(relInput) ? relInput : [relInput];
    for (const rel of relArray) {
      if (rel && rel.relation_type && rel.relation_type !== 'independent') {
        if (!VALID_RELATION_TYPES.includes(rel.relation_type)) {
          return res.status(400).json({
            success: false,
            error: `Loại quan hệ "${rel.relation_type}" không hợp lệ. Cho phép: ${VALID_RELATION_TYPES.join(', ')}`
          });
        }
        if (!rel.target_doc_version_id) {
          return res.status(400).json({
            success: false,
            error: 'Vui lòng chọn văn bản đích cần liên kết quan hệ.'
          });
        }
        if (rel.relation_type === 'amends') {
          if (!Array.isArray(rel.clauses) || rel.clauses.length === 0) {
            return sendError(res, 'MISSING_CLAUSE_SCOPE', {
              error: 'Quan hệ Sửa đổi (amends) bắt buộc phải xác định danh mục điều khoản sửa đổi (clauses).'
            }, req);
          }
        }
      }
    }

    const effDate = effective_date || new Date().toISOString().split('T')[0];
    const issDate = issue_date || effDate;
    const code = (doc_code && doc_code.trim()) ? doc_code.trim() : ((doc_number && doc_number.trim() && doc_number !== 's/n') ? doc_number.trim() : 's/n');

    // 2. Xác định dòng văn bản (family_id) trước để phân biệt tạo mới hay thêm phiên bản
    let familyId = (document_family_id && document_family_id.trim()) ? stripNullBytes(document_family_id.trim()) : null;
    if (!familyId) {
      if (code && code !== 's/n') {
        familyId = 'DOC-FAM-' + code.toUpperCase().replace(/[^A-Z0-9_-]+/g, '-');
      } else if (document_id && !['CHINH_SACH', 'QUY_CHE_QUY_TRINH', 'NOIQUY', 'SO_TAY', 'CAM_KET_PHAP_LY'].includes(document_id)) {
        familyId = 'DOC-FAM-' + document_id.toUpperCase().replace(/[^A-Z0-9_-]+/g, '-');
      } else {
        familyId = 'DOC-FAM-' + title.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').slice(0, 40);
      }
    }

    // Bắt đầu giao dịch trên dedicated client để bảo vệ tính toàn vẹn và advisory xact lock
    await client.query('BEGIN');
    inTransaction = true;

    // Khóa Advisory Transaction Scope (P0-01 Fix: tự động giải phóng khi transaction COMMIT/ROLLBACK, tuyệt đối không leak)
    let lockKey = null;
    if (code && code !== 's/n') {
      lockKey = `sotrans_doc_code_${code.toLowerCase().trim()}`;
    } else if (actualFileSha256) {
      lockKey = `sotrans_file_sha256_${actualFileSha256}`;
    }
    if (lockKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    }

    // 1. Kiểm tra mã băm SHA-256 chống tải tệp trùng lặp (BẮT BUỘC, KHÔNG CHO PHÉP BYPASS)
    if (actualFileSha256) {
      const dupRes = await client.query(
        "SELECT doc_version_id, document_family_id, doc_code, doc_number, title, version, status, branch_scope FROM documents WHERE file_sha256 = $1 AND deleted_at IS NULL AND status NOT IN ('rejected', 'archived', 'trash') LIMIT 1",
        [actualFileSha256]
      );
      if (dupRes.rows.length > 0) {
        await client.query('ROLLBACK');
        inTransaction = false;
        const dup = dupRes.rows[0];
        const isSameFamily = familyId && dup.document_family_id && (familyId === dup.document_family_id);

        if (isSameFamily) {
          return sendError(res, 'IDENTICAL_FILE_SAME_FAMILY', {
            is_duplicate: true,
            duplicate_type: 'IDENTICAL_FILE_SAME_FAMILY',
            error: `Tệp tải lên có nội dung trùng khớp 100% (SHA-256) với phiên bản v${dup.version} cùng dòng văn bản "${dup.title}". Để ban hành phiên bản mới, vui lòng cập nhật nội dung tệp tin sửa đổi.`,
            duplicate_doc: dup
          }, req);
        }

        const isAuthorized = isAuthorizedForDoc(req.user, dup);
        if (!isAuthorized) {
          return sendError(res, 'EXACT_DUPLICATE_FILE', {
            is_duplicate: true,
            duplicate_type: 'EXISTING_DOCUMENT_RESTRICTED',
            error: 'Tập tin hoặc mã hiệu đã tồn tại trong hệ thống. Vui lòng liên hệ Quản trị viên Tập đoàn để đối soát.',
            duplicate_doc: { is_duplicate: true }
          }, req);
        }

        const sanitizedDup = {
          doc_version_id: dup.doc_version_id,
          doc_code: dup.doc_code || dup.doc_number,
          title: dup.title,
          version: dup.version,
          status: dup.status
        };

        const errorMessage = `Tập tin này có mã băm SHA-256 trùng khớp với văn bản "${dup.title}" (${dup.doc_code || dup.doc_number}, v${dup.version}, ${dup.status}) đã có trong hệ thống.`;

        return sendError(res, 'EXACT_DUPLICATE_FILE', {
          is_duplicate: true,
          duplicate_type: 'EXACT_DUPLICATE_FILE',
          error: errorMessage,
          duplicate_doc: sanitizedDup
        }, req);
      }
    }

    // 1.1 Kiểm tra trùng mã hiệu văn bản chính thức (Duplicate Doc Code)
    if (code && code !== 's/n') {
      const codeDupRes = await client.query(
        "SELECT doc_version_id, document_family_id, doc_code, doc_number, title, version, status, branch_scope FROM documents WHERE (doc_code ILIKE $1 OR doc_number ILIKE $1) AND status NOT IN ('rejected', 'archived', 'trash') AND deleted_at IS NULL LIMIT 1",
        [code]
      );
      if (codeDupRes.rows.length > 0) {
        const dup = codeDupRes.rows[0];
        const isSameFamily = familyId && dup.document_family_id && (familyId === dup.document_family_id);
        if (!isSameFamily) {
          await client.query('ROLLBACK');
          inTransaction = false;
          const isAuthorized = isAuthorizedForDoc(req.user, dup);
          if (!isAuthorized) {
            return sendError(res, 'DUPLICATE_DOC_CODE', {
              is_duplicate: true,
              duplicate_type: 'EXISTING_DOCUMENT_RESTRICTED',
              error: 'Tập tin hoặc mã hiệu đã tồn tại trong hệ thống. Vui lòng liên hệ Quản trị viên Tập đoàn để đối soát.'
            }, req);
          }
          const errorMessage = `Mã hiệu văn bản "${code}" đã tồn tại trong hệ thống (văn bản "${dup.title}", trạng thái ${dup.status}). Vui lòng chọn mã hiệu khác hoặc thiết lập quan hệ thay thế.`;
          return sendError(res, 'DUPLICATE_DOC_CODE', {
            is_duplicate: true,
            duplicate_type: 'DUPLICATE_DOC_CODE',
            error: errorMessage
          }, req);
        }
      }
    }

    const docId = (document_id && document_id.trim()) ? stripNullBytes(document_id.trim()) : familyId;

    // 3. Khóa cứng Tenant Boundary từ Backend:
    let assignedBranchScope = [];
    if (isSuperAdminUser(req.user)) {
      if (Array.isArray(branch_scope) && branch_scope.length > 0) {
        assignedBranchScope = branch_scope;
      } else if (typeof branch_scope === 'string' && branch_scope.trim()) {
        assignedBranchScope = branch_scope.split(',').map(s => s.trim());
      } else {
        assignedBranchScope = ['all'];
      }
    } else {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!userBranch) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return res.status(403).json({ success: false, error: '403 Forbidden: Tài khoản không có công ty hợp lệ.' });
      }
      if (branch_scope) {
        const requested = Array.isArray(branch_scope) ? branch_scope : [branch_scope];
        if (requested.some(b => b !== userBranch)) {
          await client.query('ROLLBACK');
          inTransaction = false;
          return res.status(403).json({
            success: false,
            error: `403 Forbidden: Bạn không có quyền ban hành văn bản ngoài phạm vi công ty được phân công (${userBranch}).`
          });
        }
      }
      assignedBranchScope = [userBranch];
    }

    const normScopeArr = (val) => {
      if (Array.isArray(val) && val.length > 0) return val;
      if (typeof val === 'string' && val.trim()) return val.split(',').map(s => s.trim());
      return ['all'];
    };

    const deptScope = normScopeArr(department_scope);
    const buScope = normScopeArr(business_unit_scope);
    const locScope = normScopeArr(location_scope);
    const egScope = normScopeArr(employee_group_scope);

    // 3.1 Kiểm tra Tenant Boundary cho các quan hệ văn bản đi kèm
    for (const rel of relArray) {
      if (rel && rel.target_doc_version_id && rel.relation_type && rel.relation_type !== 'independent') {
        const tgtDocRes = await client.query(
          'SELECT doc_version_id, branch_scope FROM documents WHERE doc_version_id = $1',
          [rel.target_doc_version_id]
        );
        if (tgtDocRes.rows.length === 0) {
          await client.query('ROLLBACK');
          inTransaction = false;
          return res.status(404).json({
            success: false,
            error: `Không tìm thấy văn bản đích liên kết (ID: ${rel.target_doc_version_id}).`
          });
        }
        const scopeCheck = checkRelationshipTenantScope(req.user, assignedBranchScope, tgtDocRes.rows[0].branch_scope);
        if (!scopeCheck.allowed) {
          await client.query('ROLLBACK');
          inTransaction = false;
          return res.status(scopeCheck.status || 403).json({
            success: false,
            error: scopeCheck.error
          });
        }
      }
    }

    // Xác định version tiếp theo theo document_family_id
    const verRes = await client.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_ver FROM documents WHERE document_family_id = $1',
      [familyId]
    );
    const nextVer = verRes.rows[0].next_ver;

    // Trạng thái: draft (Lưu bản nháp) hoặc pending_approval (Gửi phê duyệt)
    const isSubmitted = submit_for_approval === true;

    // 3.2 Kiểm tra xung đột trước khi cho phép submit_for_approval trực tiếp
    if (isSubmitted) {
      const preConflict = await detectPolicyConflicts({
        title: title.trim(),
        doc_code: code,
        category,
        content: change_summary || '',
        branch_scope: assignedBranchScope,
        department_scope: deptScope,
        business_unit_scope: buScope,
        employee_group_scope: egScope,
        effective_date: effDate,
        expiry_date,
        file_sha256
      });
      if (preConflict.has_conflict) {
        const blockingConflicts = (preConflict.blocking_conflicts && preConflict.blocking_conflicts.length > 0)
          ? preConflict.blocking_conflicts
          : (preConflict.conflicts || []).filter(c => c.severity === 'HIGH');

        if (blockingConflicts.length > 0) {
          const conflictingTargetIds = blockingConflicts.map(c => c.target_doc_version_id).filter(Boolean);
          const hasRelDeclared = relArray.some(r => r && r.relation_type && r.relation_type !== 'independent' && r.target_doc_version_id);
          if (!hasRelDeclared) {
            await client.query('ROLLBACK');
            inTransaction = false;
            const mainConflict = blockingConflicts[0];
            return res.status(409).json({
              success: false,
              code: 'APPROVAL_GATE_BLOCKED',
              conflict_type: mainConflict.type,
              error: `Không thể gửi phê duyệt khi còn xung đột hoặc trùng lặp chính sách trực tiếp (${mainConflict.type}): ${mainConflict.message}`,
              conflicts: blockingConflicts,
              conflict_report: preConflict
            });
          }

          const resolvesTarget = relArray.some(r =>
            r && r.target_doc_version_id &&
            conflictingTargetIds.includes(r.target_doc_version_id) &&
            ['supersedes', 'amends'].includes(r.relation_type)
          );

          if (!resolvesTarget) {
            await client.query('ROLLBACK');
            inTransaction = false;
            const mainConflict = blockingConflicts[0];
            const targetTitle = mainConflict.target_title || 'văn bản hiện hành';
            const targetCode = mainConflict.target_doc_code ? ` (${mainConflict.target_doc_code})` : '';
            return res.status(409).json({
              success: false,
              code: 'UNRESOLVED_TARGET_CONFLICT',
              conflict_type: mainConflict.type,
              conflicting_target_ids: conflictingTargetIds,
              error: `Không thể gửi phê duyệt: Phát hiện xung đột chính sách trực tiếp với "${targetTitle}"${targetCode}. Bạn phải thiết lập quan hệ Thay thế (supersedes) hoặc Sửa đổi (amends) với chính văn bản này, không thể liên kết sang văn bản khác.`,
              conflicts: blockingConflicts,
              conflict_report: preConflict
            });
          }
        }
      }
    }

    const isAdmin = req.user.role === 'ADMIN' || isSuperAdminUser(req.user);
    const initialStatus = (!isAdmin && isSubmitted) ? 'pending_approval' : 'draft';
    const submittedAt = (!isAdmin && isSubmitted) ? new Date() : null;
    const auditAction = isAdmin ? 'CREATE_DOC_ADMIN' : (isSubmitted ? 'HR_SUBMIT_APPROVAL' : 'CREATE_DOC_HR');

    const insertQuery = `
      INSERT INTO documents 
        (document_id, document_family_id, doc_code, category, version, title, doc_number, doc_type,
         issue_date, effective_date, expiry_date, file_sha256, file_uri, topics,
         status, role_access, branch_scope, department_scope, business_unit_scope, location_scope, employee_group_scope,
         change_summary, uploaded_by, creator_user_id, submitted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, '{all}', $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING *
    `;

    savedFileUri = file_uri ? stripNullBytes(file_uri) : null;
    if (req.file) {
      const safeDocId = String(familyId || code || 'POLICY').replace(/[^A-Za-z0-9_-]/g, '_');
      const stored = saveFileToStorage(req.file.buffer, safeDocId, req.file.originalname);
      savedFileUri = stored.fileUri;
    }

    const result = await client.query(insertQuery, [
      docId,
      familyId,
      code,
      category,
      nextVer,
      title.trim(),
      code,
      doc_type,
      issDate,
      effDate,
      expiry_date || null,
      actualFileSha256 || null,
      savedFileUri || null,
      Array.isArray(topics) ? topics : (topics ? [topics] : null),
      initialStatus,
      assignedBranchScope,
      deptScope,
      buScope,
      locScope,
      egScope,
      change_summary,
      req.user.username,
      req.user.user_id,
      submittedAt
    ]);

    const createdDoc = result.rows[0];

    // Xử lý quan hệ văn bản đi kèm (nếu có) -> tạo ở trạng thái 'pending_review'
    for (const rel of relArray) {
      if (rel && rel.target_doc_version_id && rel.relation_type && rel.relation_type !== 'independent') {
        try {
          const contradictionCheck = await checkRelationshipContradiction(client, createdDoc.doc_version_id, rel.target_doc_version_id, rel.relation_type);
          if (contradictionCheck.valid) {
            const relInsertRes = await client.query(`
              INSERT INTO document_relationships
                (source_doc_version_id, target_doc_version_id, relation_type, approval_status, notes, created_by)
              VALUES ($1, $2, $3, 'pending_review', $4, $5)
              ON CONFLICT (source_doc_version_id, target_doc_version_id, relation_type)
              DO UPDATE SET notes = EXCLUDED.notes, approval_status = EXCLUDED.approval_status
              RETURNING relationship_id
            `, [
              createdDoc.doc_version_id,
              rel.target_doc_version_id,
              rel.relation_type,
              (rel.notes && typeof rel.notes === 'string' && rel.notes.trim()) ? stripNullBytes(rel.notes.trim()) : null,
              req.user.username
            ]);

            const newRelId = relInsertRes.rows[0]?.relationship_id;
            // Lưu danh mục điều khoản sửa đổi nếu là quan hệ amends (AUD-APP-02)
            if (newRelId && rel.relation_type === 'amends' && Array.isArray(rel.clauses) && rel.clauses.length > 0) {
              for (const cl of rel.clauses) {
                const tRef = stripNullBytes((cl.target_clause_ref || cl.target_clause_reference || '').trim());
                const sRef = stripNullBytes((cl.source_clause_ref || cl.source_clause_reference || tRef).trim());
                const rawMod = (cl.modification_type || cl.change_type || 'MODIFY').toUpperCase();
                const modType = ['REPLACE', 'REPLACES'].includes(rawMod) ? 'REPLACE' : (['SUPPLEMENT', 'SUPPLEMENTS'].includes(rawMod) ? 'SUPPLEMENT' : (['REPEAL', 'REPEALS'].includes(rawMod) ? 'REPEAL' : 'MODIFY'));
                if (tRef) {
                  await client.query(`
                    INSERT INTO document_relationship_clauses
                      (relationship_id, source_clause_ref, target_clause_ref, modification_type, summary_of_change, created_by)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (relationship_id, source_clause_ref, target_clause_ref) DO NOTHING
                  `, [newRelId, sRef, tRef, modType, cl.summary_of_change || cl.summary ? stripNullBytes(cl.summary_of_change || cl.summary) : null, req.user.username]);
                }
              }
            }
          } else {
            console.warn(`Bỏ qua quan hệ mâu thuẫn khi tạo văn bản: ${contradictionCheck.error}`);
          }
        } catch (rErr) {
          console.error('Lỗi lưu quan hệ văn bản đi kèm:', rErr.message);
        }
      }
    }

    await logDocAudit(req, createdDoc.doc_version_id, createdDoc.document_id, auditAction, null, initialStatus, isAdmin ? 'Quản trị viên tạo hồ sơ văn bản' : (isSubmitted ? 'HR gửi hồ sơ trình duyệt' : 'HR lưu bản nháp văn bản'), {
      title: createdDoc.title,
      version: createdDoc.version,
      document_family_id: familyId,
      branch_scope: assignedBranchScope
    }, client);

    await client.query('COMMIT');
    inTransaction = false;

    // Kích hoạt trích xuất qua n8n sau khi transaction đã COMMIT an toàn
    let extractionResult = { success: false, not_started: !req.file };
    if (savedFileUri && req.file) {
      try {
        const n8nData = await triggerDocumentExtraction(createdDoc, req.file.buffer, req.file.originalname, { actor: req.user.username, mimeType: req.file.mimetype, generationId: createdDoc.doc_version_id });
        extractionResult = { success: true, data: n8nData };
        await db.query(`
          UPDATE chunks 
          SET generation_id = $1, is_published = TRUE 
          WHERE doc_version_id = $1 AND generation_id IS NULL
        `, [createdDoc.doc_version_id]);
        await db.query(`
          UPDATE documents 
          SET active_generation_id = $1 
          WHERE doc_version_id = $1 AND active_generation_id IS NULL
        `, [createdDoc.doc_version_id]);
      } catch (extractErr) {
        console.warn('n8n initial extraction error (file safely preserved on disk):', extractErr.message);
        extractionResult = { success: false, error: extractErr.message };
      }
    }

    return res.status(201).json({
      success: true,
      message: isAdmin
        ? 'Tài liệu đã được tạo thành công. ADMIN có thể xem xét, kiểm tra và trực tiếp phê duyệt.'
        : (isSubmitted
            ? 'Hồ sơ văn bản đã được nộp và chuyển sang trạng thái Chờ phê duyệt (Pending Approval).'
            : 'Đã lưu bản nháp thành công. Văn bản đang ở trạng thái Nháp (Draft), chưa gửi duyệt.'),
      document: enrichDocStatuses(createdDoc),
      extraction: extractionResult
    });
  } catch (err) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    if (savedFileUri && req.file) {
      await safeCleanupOrphanFile(savedFileUri);
    }
    if (err.code === '23505') {
      if (err.constraint === 'uq_documents_file_sha256_active') {
        return sendError(res, 'EXACT_DUPLICATE_FILE', {
          is_duplicate: true,
          duplicate_type: 'EXACT_DUPLICATE_FILE',
          error: 'Tập tin này có mã băm SHA-256 trùng khớp với một văn bản đã tồn tại trong hệ thống. Vui lòng liên hệ Quản trị viên để đối soát.'
        }, req);
      }
      if (err.constraint === 'documents_document_id_version_key' || err.constraint === 'one_active_per_family') {
        return sendError(res, 'DUPLICATE_DOC_CODE', {
          is_duplicate: true,
          duplicate_type: 'DUPLICATE_DOC_CODE',
          error: 'Mã hiệu văn bản hoặc phiên bản đã tồn tại trong hệ thống. Vui lòng chọn mã hiệu khác.'
        }, req);
      }
    }
    console.error('Lỗi tạo văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ khi tạo văn bản: ' + err.message });
  } finally {
    client.release();
  }
});

// 3.1 POST /api/documents/:id/upload-file - Tải tệp đính kèm bổ sung cho bản nháp (Draft Recovery)
router.post('/:id/upload-file', verifyToken, requirePermission('document.edit'), upload.single('file'), async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, error: 'Mã văn bản (ID) không đúng định dạng UUID.' });
  }

  const client = await db.getClient();
  let inTransaction = false;
  let fileSavedLocally = null;

  try {
    await client.query('BEGIN');
    inTransaction = true;

    // Khóa Advisory Transaction Scope chống race condition upload tệp vào cùng một văn bản
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sotrans_doc_draft_' + id]);

    const docRes = await client.query('SELECT * FROM documents WHERE doc_version_id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (docRes.rows.length === 0) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ văn bản.' });
    }
    const doc = docRes.rows[0];

    // Chặn nghiêm ngặt: Tuyệt đối không cho phép ghi đè file tài liệu active hoặc scheduled
    if (doc.status === 'active' || doc.status === 'scheduled') {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(400).json({
        success: false,
        code: 'CANNOT_OVERWRITE_ACTIVE_DOCUMENT',
        error: `Không thể ghi đè hoặc thay thế tệp tin của văn bản đang có hiệu lực thi hành (${doc.status}). Để sửa đổi nội dung, vui lòng tạo phiên bản mới.`
      });
    }

    // Chỉ cho phép gắn file cho Bản nháp (draft), testing hoặc bị từ chối (rejected)
    if (!['draft', 'rejected', 'testing', 'pending_approval'].includes(doc.status)) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(400).json({
        success: false,
        code: 'CANNOT_ATTACH_NON_DRAFT',
        error: `Chỉ có thể tải tệp tin đính kèm bổ sung cho tài liệu ở trạng thái Bản nháp (Draft). Văn bản hiện tại đang ở trạng thái "${doc.status}".`
      });
    }

    // Tenant boundary check
    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!userBranch || (Array.isArray(doc.branch_scope) && !doc.branch_scope.includes('all') && !doc.branch_scope.includes(userBranch))) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền thao tác trên văn bản của đơn vị khác.' });
      }
    }

    // Validate file
    const val = await validateUploadedFile(req.file);
    if (!val.valid) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(val.status).json({ success: false, code: val.code, error: val.error });
    }

    // Tính SHA-256 & Kiểm tra trùng lặp (ngoại trừ chính nó)
    const computedSha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const dupRes = await client.query(
      "SELECT doc_version_id, title, status, branch_scope FROM documents WHERE file_sha256 = $1 AND doc_version_id != $2 AND status NOT IN ('rejected', 'archived', 'trash') AND deleted_at IS NULL LIMIT 1",
      [computedSha256, id]
    );
    if (dupRes.rows.length > 0) {
      await client.query('ROLLBACK');
      inTransaction = false;
      const dup = dupRes.rows[0];
      const isAuthorized = isAuthorizedForDoc(req.user, dup);
      const errorMessage = isAuthorized
        ? `Tệp tin này có mã băm SHA-256 trùng khớp 100% với văn bản "${dup.title}" (${dup.status}) đã có trong hệ thống.`
        : 'Tập tin này có mã băm SHA-256 trùng khớp với một văn bản đã tồn tại trong hệ thống. Vui lòng liên hệ Quản trị viên để đối soát.';

      return res.status(409).json({
        success: false,
        is_duplicate: true,
        duplicate_type: isAuthorized ? 'EXACT_DUPLICATE_FILE' : 'EXISTING_DOCUMENT_RESTRICTED',
        code: 'EXACT_DUPLICATE_FILE',
        error: errorMessage,
        duplicate_doc: isAuthorized ? {
          doc_version_id: dup.doc_version_id,
          title: dup.title,
          status: dup.status
        } : { is_duplicate: true }
      });
    }

    // Lưu file vào shared storage
    const safeDocId = String(doc.document_family_id || doc.doc_code || 'POLICY').replace(/[^A-Za-z0-9_-]/g, '_');
    const { fileUri, physicalPath } = saveFileToStorage(req.file.buffer, safeDocId, req.file.originalname);
    fileSavedLocally = fileUri;

    // Cập nhật PostgreSQL trên dedicated client
    const updateRes = await client.query(
      `UPDATE documents 
       SET file_uri = $1, file_sha256 = $2 
       WHERE doc_version_id = $3 
       RETURNING *`,
      [fileUri, computedSha256, id]
    );
    const updatedDoc = updateRes.rows[0];

    await logDocAudit(req, id, doc.document_id, 'ATTACH_SOURCE_FILE', doc.status, doc.status, `Gắn tệp tin gốc "${req.file.originalname}" vào bản nháp`, { file_uri: fileUri, file_sha256: computedSha256 }, client);

    await client.query('COMMIT');
    inTransaction = false;

    // Tự động kích hoạt extraction qua n8n sau khi COMMIT an toàn
    let extractionResult = { success: false };
    try {
      const n8nData = await triggerDocumentExtraction(updatedDoc, req.file.buffer, req.file.originalname, { actor: req.user.username, mimeType: req.file.mimetype });
      extractionResult = { success: true, data: n8nData };
      await db.query(`
        UPDATE chunks 
        SET generation_id = $1, is_published = TRUE 
        WHERE doc_version_id = $1 AND generation_id IS NULL
      `, [updatedDoc.doc_version_id]);
      await db.query(`
        UPDATE documents 
        SET active_generation_id = $1 
        WHERE doc_version_id = $1 AND active_generation_id IS NULL
      `, [updatedDoc.doc_version_id]);
    } catch (extractErr) {
      console.warn('n8n extraction after attach file error (file safely preserved on disk):', extractErr.message);
      extractionResult = { success: false, error: extractErr.message };
    }

    return res.json({
      success: true,
      message: 'Tệp tin đã được lưu bền vững thành công vào hệ thống' + (extractionResult.success ? ' và trích xuất hoàn tất!' : ', tiến trình trích xuất đang tiếp tục xử lý.'),
      document: enrichDocStatuses(updatedDoc),
      extraction: extractionResult
    });
  } catch (e) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    if (fileSavedLocally) {
      await safeCleanupOrphanFile(fileSavedLocally);
    }
    if (e.code === '23505' && e.constraint === 'uq_documents_file_sha256_active') {
      return res.status(409).json({
        success: false,
        is_duplicate: true,
        duplicate_type: 'EXACT_DUPLICATE_FILE',
        code: 'EXACT_DUPLICATE_FILE',
        error: 'Tệp tin này có mã băm SHA-256 trùng khớp với một văn bản đã tồn tại trong hệ thống. Vui lòng liên hệ Quản trị viên để đối soát.'
      });
    }
    console.error('Lỗi tải tệp bổ sung:', e);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi tải tệp bổ sung: ' + e.message });
  } finally {
    client.release();
  }
});
// Hàm chuẩn hóa mảng Scope (chống lỗi JSON stringified [ "[\"all\"]" ] từ dữ liệu cũ)
function cleanScopeArray(input) {
  if (!input) return ['all'];
  let arr = input;
  if (typeof arr === 'string') {
    try {
      const parsed = JSON.parse(arr);
      if (Array.isArray(parsed)) arr = parsed;
      else arr = [arr];
    } catch (e) {
      arr = arr.split(',').map(s => s.trim());
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return ['all'];

  const flattened = [];
  arr.forEach(item => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const inner = JSON.parse(trimmed);
          if (Array.isArray(inner)) inner.forEach(x => flattened.push(String(x).trim()));
          else flattened.push(trimmed);
        } catch (e) {
          flattened.push(trimmed);
        }
      } else if (trimmed) {
        flattened.push(trimmed);
      }
    } else if (item) {
      flattened.push(String(item).trim());
    }
  });

  const unique = Array.from(new Set(flattened)).filter(Boolean);
  if (unique.length === 0 || unique.includes('all')) return ['all'];
  return unique;
}

// 4. PUT /api/documents/:id - Chỉnh sửa văn bản (document.edit)
router.put('/:id', verifyToken, requirePermission('document.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      doc_number,
      doc_code,
      category,
      doc_type,
      issue_date,
      effective_date,
      expiry_date,
      branch_scope,
      department_scope,
      business_unit_scope,
      location_scope,
      employee_group_scope,
      role_access,
      change_summary
    } = req.body;

    const docRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản để chỉnh sửa.' });
    }

    const doc = docRes.rows[0];

    // QUY TẮC NGHIỆP VỤ VỀ TRẠNG THÁI (LIFECYCLE SAFETY GATE):
    // Chỉ được sửa khi văn bản ở trạng thái 'draft' hoặc 'rejected'
    if (doc.status === 'pending_approval') {
      return res.status(400).json({
        success: false,
        error: 'Văn bản đang trong quá trình chờ phê duyệt (Pending Approval), không thể chỉnh sửa trực tiếp. Vui lòng chờ phê duyệt hoặc rút lại yêu cầu.'
      });
    }

    if (['active', 'scheduled'].includes(doc.status)) {
      return res.status(400).json({
        success: false,
        error: 'Văn bản đã ban hành/có hiệu lực không được phép sửa đổi trực tiếp. Vui lòng tạo phiên bản sửa đổi mới (amendment) để phê duyệt lại.'
      });
    }

    if (['archived', 'trash', 'revoked'].includes(doc.status)) {
      return res.status(400).json({
        success: false,
        error: `Không thể chỉnh sửa văn bản đang ở trạng thái '${doc.status}'.`
      });
    }

    // KIỂM TRA PHẠM VI TENANT VÀ THẨM QUYỀN RBAC (ADMIN vs HR):
    const isSuper = isSuperAdminUser(req.user);
    const userCompany = req.user && req.user.company_id ? String(req.user.company_id).toUpperCase().trim() : null;
    const userBranch = getBranchForCompany(userCompany);

    if (!isSuper) {
      if (!userCompany || !userBranch) {
        return res.status(403).json({ success: false, error: '403 Forbidden: Tài khoản không có thông tin công ty hợp lệ.' });
      }
      const currentDocScope = Array.isArray(doc.branch_scope) ? doc.branch_scope : [doc.branch_scope];
      if (!currentDocScope.includes(userBranch)) {
        return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền chỉnh sửa văn bản của công ty khác.' });
      }
      if (currentDocScope.length === 1 && currentDocScope[0] === 'all') {
        return res.status(403).json({ success: false, error: '403 Forbidden: Văn bản cấp Toàn tập đoàn chỉ do Super Admin quản lý.' });
      }
      if (branch_scope !== undefined) {
        const reqBranchScope = cleanScopeArray(branch_scope);
        if (reqBranchScope.length !== 1 || reqBranchScope[0] !== userBranch) {
          return res.status(403).json({
            success: false,
            error: `403 Forbidden: Quyền HR bị khóa ở công ty phụ trách (${userBranch}). Không thể mở rộng phạm vi liên công ty hoặc toàn tập đoàn.`
          });
        }
      }
    }

    // Xác định finalBranchScope
    let finalBranchScope = doc.branch_scope || ['all'];
    if (isSuper) {
      if (branch_scope !== undefined) {
        finalBranchScope = cleanScopeArray(branch_scope);
      }
    } else {
      finalBranchScope = [userBranch];
    }

    // Xác định finalRoleAccess
    let finalRoleAccess = doc.role_access || ['all'];
    if (role_access !== undefined) {
      let rArr = Array.isArray(role_access) ? role_access : [role_access];
      rArr = rArr.map(r => String(r).trim().toLowerCase()).filter(Boolean);
      finalRoleAccess = rArr.includes('manager') ? ['manager'] : ['all'];
    }

    // Kiểm tra tính hợp lệ của ngày tháng
    const finalEffDate = effective_date || doc.effective_date;
    const finalExpDate = expiry_date !== undefined ? (expiry_date ? expiry_date : null) : doc.expiry_date;
    if (finalExpDate && finalEffDate && finalExpDate < finalEffDate) {
      return res.status(400).json({ success: false, error: 'Ngày hết hiệu lực phải sau hoặc bằng ngày có hiệu lực.' });
    }

    // Kiểm tra trùng mã hiệu với văn bản khác nếu có cập nhật doc_code
    if (doc_code && doc_code.trim() && doc_code.trim() !== 's/n') {
      const codeDupRes = await db.query(
        "SELECT doc_version_id, title, status FROM documents WHERE (doc_code ILIKE $1 OR doc_number ILIKE $1) AND doc_version_id != $2 AND status IN ('active', 'scheduled', 'pending_approval') AND deleted_at IS NULL LIMIT 1",
        [doc_code.trim(), id]
      );
      if (codeDupRes.rows.length > 0) {
        const dup = codeDupRes.rows[0];
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_DOC_CODE',
          error: `Mã hiệu văn bản "${doc_code.trim()}" đã được sử dụng bởi văn bản "${dup.title}" (${dup.status}). Vui lòng chọn mã hiệu khác.`
        });
      }
    }

    // Chuẩn hóa các trường Scope chi tiết
    const finalDeptScope = department_scope !== undefined ? cleanScopeArray(department_scope) : cleanScopeArray(doc.department_scope);
    const finalBuScope = business_unit_scope !== undefined ? cleanScopeArray(business_unit_scope) : cleanScopeArray(doc.business_unit_scope);
    const finalLocScope = location_scope !== undefined ? cleanScopeArray(location_scope) : cleanScopeArray(doc.location_scope);
    const finalEgScope = employee_group_scope !== undefined ? cleanScopeArray(employee_group_scope) : cleanScopeArray(doc.employee_group_scope);

    const updateQuery = `
      UPDATE documents
      SET title = COALESCE($1, title),
          doc_number = COALESCE($2, doc_number),
          doc_code = COALESCE($3, doc_code),
          category = COALESCE($4, category),
          doc_type = COALESCE($5, doc_type),
          issue_date = COALESCE($6, issue_date),
          effective_date = COALESCE($7, effective_date),
          expiry_date = $8,
          branch_scope = $9,
          department_scope = $10,
          business_unit_scope = $11,
          location_scope = $12,
          employee_group_scope = $13,
          role_access = $14,
          change_summary = COALESCE($15, change_summary)
      WHERE doc_version_id = $16
      RETURNING *
    `;

    const updatedResult = await db.query(updateQuery, [
      title ? title.trim() : null,
      doc_number ? doc_number.trim() : null,
      doc_code ? doc_code.trim() : null,
      category || null,
      doc_type ? doc_type.trim() : null,
      issue_date || null,
      finalEffDate || null,
      finalExpDate,
      finalBranchScope,
      finalDeptScope,
      finalBuScope,
      finalLocScope,
      finalEgScope,
      finalRoleAccess,
      change_summary ? change_summary.trim() : null,
      id
    ]);

    const updatedDoc = updatedResult.rows[0];

    await logDocAudit(req, updatedDoc.doc_version_id, updatedDoc.document_id, 'EDIT', doc.status, updatedDoc.status, null, {
      changes: req.body,
      before: {
        title: doc.title,
        doc_code: doc.doc_code,
        doc_number: doc.doc_number,
        branch_scope: doc.branch_scope,
        effective_date: doc.effective_date,
        expiry_date: doc.expiry_date,
        role_access: doc.role_access,
        department_scope: doc.department_scope,
        employee_group_scope: doc.employee_group_scope
      },
      after: {
        title: updatedDoc.title,
        doc_code: updatedDoc.doc_code,
        doc_number: updatedDoc.doc_number,
        branch_scope: updatedDoc.branch_scope,
        effective_date: updatedDoc.effective_date,
        expiry_date: updatedDoc.expiry_date,
        role_access: updatedDoc.role_access,
        department_scope: updatedDoc.department_scope,
        employee_group_scope: updatedDoc.employee_group_scope
      }
    });

    // Đồng bộ tức thời sang Qdrant Vector DB
    await syncDocumentToQdrant(updatedDoc.doc_version_id).catch(e => console.error('Lỗi sync Qdrant sau edit:', e.message));

    return res.json({
      success: true,
      message: 'Cập nhật thông tin văn bản thành công.',
      document: updatedDoc
    });
  } catch (err) {
    console.error('Lỗi chỉnh sửa văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 5. POST /api/documents/:id/submit - Gửi văn bản để phê duyệt (document.submit)
router.post('/:id/submit', verifyToken, requirePermission('document.submit'), async (req, res) => {
  try {
    const { id } = req.params;

    const docRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản.' });
    }

    const doc = docRes.rows[0];

    // Kiểm tra phạm vi công ty
    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!doc.branch_scope || !doc.branch_scope.includes(userBranch)) {
        return res.status(403).json({ success: false, error: '403 Forbidden: Không thể gửi duyệt văn bản của công ty khác.' });
      }
    }

    // Kiểm tra trạng thái bằng State Machine Validator
    const transitionCheck = validateStateTransition(doc.status, 'pending_approval', req.user.role);
    if (!transitionCheck.valid) {
      return res.status(transitionCheck.status).json({
        success: false,
        code: transitionCheck.code,
        error: transitionCheck.error
      });
    }

    // Zero-chunk check: không được gửi duyệt tài liệu 0 chunks
    const chunkCountRes = await db.query('SELECT COUNT(*)::int as count FROM chunks WHERE doc_version_id = $1', [id]);
    const chunkCount = chunkCountRes.rows[0].count;
    if (chunkCount === 0) {
      return res.status(400).json({
        success: false,
        code: 'ZERO_CHUNK_SUBMIT_BLOCKED',
        error: 'Không thể gửi phê duyệt: Văn bản chưa hoàn tất trích xuất nội dung (0 chunks). Vui lòng hoàn tất xử lý tệp trước khi gửi duyệt.'
      });
    }

    const updatedRes = await db.query(
      `UPDATE documents 
       SET status = 'pending_approval', submitted_at = now(), reject_reason = NULL
       WHERE doc_version_id = $1
       RETURNING *`,
      [id]
    );

    const updatedDoc = updatedRes.rows[0];
    const isHR = req.user.role === 'HR';
    const auditAction = isHR ? 'HR_SUBMIT_APPROVAL' : 'SUBMIT_FOR_APPROVAL';

    await logDocAudit(req, updatedDoc.doc_version_id, updatedDoc.document_id, auditAction, doc.status, 'pending_approval', isHR ? 'HR gửi hồ sơ yêu cầu phê duyệt' : 'Gửi văn bản trình phê duyệt');

    return res.json({
      success: true,
      message: 'Đã gửi văn bản trình duyệt thành công. Trạng thái hiện tại: Chờ phê duyệt (Pending Approval).',
      document: enrichDocStatuses(updatedDoc)
    });
  } catch (err) {
    console.error('Lỗi gửi duyệt văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 5.1 POST /api/documents/:id/retry-extraction - Thử lại tiến trình OCR và trích xuất chunks (F-02)
router.post('/:id/retry-extraction', verifyToken, requirePermission('document.edit'), async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return sendError(res, 'INVALID_UUID', { user_message: 'Mã văn bản (ID) không đúng định dạng UUID.' }, req);
  }
  const idempotencyKey = req.headers['x-idempotency-key'] || (req.body && req.body.idempotency_key) || null;

  const client = await db.getClient();
  let leaseResult = null;

  try {
    await client.query('BEGIN');

    // DEF-ERR-01 Fix: Kiểm tra sự tồn tại của văn bản trước khi cấp phát lease để tránh vi phạm khóa ngoại
    const docRes = await client.query('SELECT * FROM documents WHERE doc_version_id = $1 FOR UPDATE', [id]);
    if (docRes.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return sendError(res, 'DOCUMENT_NOT_FOUND', { user_message: 'Không tìm thấy hồ sơ văn bản.' }, req);
    }

    const doc = docRes.rows[0];

    // Acquire durable lease
    leaseResult = await acquireDurableRetryLease(client, id, req.user.username, idempotencyKey);
    if (!leaseResult.acquired) {
      await client.query('ROLLBACK');
      client.release();

      if (leaseResult.idempotencyMatch) {
        return res.status(200).json({
          success: true,
          code: 'IDEMPOTENT_RETRY_IN_FLIGHT',
          message: 'Yêu cầu thử lại trích xuất đã được tiếp nhận và đang trong tiến trình xử lý.',
          generation_id: leaseResult.lease.generation_id,
          status: leaseResult.lease.status
        });
      }

      return res.status(409).json({
        success: false,
        code: 'RETRY_IN_PROGRESS',
        error: `Tiến trình trích xuất cho văn bản này đang được xử lý (bởi ${leaseResult.actor}). Vui lòng chờ trong giây lát.`
      });
    }

    // 1. Kiểm tra trạng thái cấm retry: Không cho retry văn bản đang active hoặc scheduled
    if (doc.status === 'active' || doc.status === 'scheduled') {
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Không thể retry văn bản active/scheduled');
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({
        success: false,
        code: 'CANNOT_RETRY_ACTIVE_DOCUMENT',
        error: 'Không thể thử lại trích xuất tài liệu đang có hiệu lực thi hành (Active/Scheduled).'
      });
    }

    // 2. Kiểm tra phân quyền RBAC & Tenant Scope
    const isSuper = isSuperAdminUser(req.user);
    const userRole = String(req.user.role || '').toUpperCase();
    const userCompany = req.user.company_id;
    const userBranch = getBranchForCompany(userCompany);

    if (!isSuper) {
      // 1. Kiểm tra Tenant Scope Boundary chung cho mọi vai trò (ADMIN, HR, EMPLOYEE)
      const docBranches = Array.isArray(doc.branch_scope) ? doc.branch_scope : [doc.branch_scope || 'all'];
      if (!docBranches.includes('all') && !docBranches.includes(userBranch)) {
        await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Tenant scope violation');
        await client.query('ROLLBACK');
        client.release();
        return res.status(403).json({
          success: false,
          code: 'TENANT_SCOPE_VIOLATION',
          error: '403 Forbidden: Bạn không có quyền trích xuất lại văn bản thuộc phạm vi công ty khác.'
        });
      }

      if (userRole === 'HR') {
        const isOwner = (doc.creator_user_id && doc.creator_user_id === req.user.user_id) ||
                        (doc.uploaded_by && doc.uploaded_by.toLowerCase() === req.user.username.toLowerCase());
        if (!isOwner) {
          await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'HR not owner');
          await client.query('ROLLBACK');
          client.release();
          return res.status(403).json({
            success: false,
            code: 'HR_NOT_OWNER',
            error: '403 Forbidden: Nhân sự chỉ được phép trích xuất lại văn bản do chính mình tạo.'
          });
        }
        if (!['draft', 'rejected'].includes(doc.status)) {
          await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'HR invalid status');
          await client.query('ROLLBACK');
          client.release();
          return res.status(403).json({
            success: false,
            code: 'HR_INVALID_STATUS',
            error: '403 Forbidden: Nhân sự không thể trích xuất lại văn bản đã trình nộp hoặc đang chờ duyệt.'
          });
        }
      } else if (userRole !== 'ADMIN') {
        await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Insufficient permissions');
        await client.query('ROLLBACK');
        client.release();
        return res.status(403).json({
          success: false,
          code: 'INSUFFICIENT_PERMISSIONS',
          error: '403 Forbidden: Bạn không có quyền thực hiện thao tác này.'
        });
      }
    }

    // 3. Kiểm tra sự tồn tại của file_uri
    if (!doc.file_uri || !doc.file_uri.trim()) {
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'File uri missing');
      await client.query('ROLLBACK');
      client.release();
      return res.status(422).json({
        success: false,
        code: 'FILE_URI_MISSING',
        error: 'Hồ sơ văn bản chưa được gắn đường dẫn tệp tin gốc. Vui lòng sử dụng tính năng "Tải tệp bổ sung" để đính kèm tệp tin trước khi thử lại trích xuất.'
      });
    }

    // 4. Xác định đường dẫn vật lý và kiểm tra file trên ổ đĩa
    const BASE_STORAGE_DIR = process.platform === 'win32'
      ? path.resolve(__dirname, '../../files')
      : (fs.existsSync('/app/chat-files') ? '/app/chat-files' : path.resolve(__dirname, '../../files'));

    const physicalPath = path.join(BASE_STORAGE_DIR, doc.file_uri);
    if (!fs.existsSync(physicalPath)) {
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'File not found on disk');
      await client.query('ROLLBACK');
      client.release();
      return res.status(422).json({
        success: false,
        code: 'FILE_NOT_FOUND',
        error: 'Không tìm thấy tệp tin gốc trên hệ thống lưu trữ máy chủ (' + doc.file_uri + '). Vui lòng tải lại tệp tin bổ sung.'
      });
    }

    // 5. Đọc và kiểm tra Magic Bytes / Định dạng thực tế
    const fileStat = fs.statSync(physicalPath);
    if (fileStat.size < 10) {
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Invalid file structure');
      await client.query('ROLLBACK');
      client.release();
      return res.status(422).json({
        success: false,
        code: 'INVALID_FILE_STRUCTURE',
        error: 'Tệp tin gốc bị hỏng hoặc rỗng (dung lượng ' + fileStat.size + ' bytes). Vui lòng cung cấp tệp tin hợp lệ.'
      });
    }

    const fileBuf = fs.readFileSync(physicalPath);
    const ext = path.extname(doc.file_uri || '').toLowerCase();

    if (ext === '.pdf') {
      const header = fileBuf.slice(0, 5).toString('ascii');
      if (header !== '%PDF-') {
        await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Invalid PDF header');
        await client.query('ROLLBACK');
        client.release();
        return res.status(422).json({
          success: false,
          code: 'INVALID_PDF_STRUCTURE',
          error: 'Tệp tin không đúng định dạng PDF hợp lệ (thiếu header %PDF-). Vui lòng kiểm tra lại tệp nguồn.'
        });
      }
    } else if (ext === '.docx') {
      if (fileBuf.length < 4 || fileBuf[0] !== 0x50 || fileBuf[1] !== 0x4B || fileBuf[2] !== 0x03 || fileBuf[3] !== 0x04) {
        await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Invalid DOCX header');
        await client.query('ROLLBACK');
        client.release();
        return res.status(422).json({
          success: false,
          code: 'INVALID_DOCX_STRUCTURE',
          error: 'Tệp tin không đúng định dạng DOCX hợp lệ (thiếu header PK). Vui lòng kiểm tra lại tệp nguồn.'
        });
      }
      try {
        const mammoth = require('mammoth');
        const { value: docxText } = await mammoth.extractRawText({ buffer: fileBuf });
        if (!docxText || docxText.trim().length === 0) {
          await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Empty DOCX content');
          await client.query('ROLLBACK');
          client.release();
          return res.status(422).json({
            success: false,
            code: 'EMPTY_DOCX_CONTENT',
            error: 'Tệp tin DOCX rỗng, không chứa nội dung văn bản khả dụng.'
          });
        }
      } catch (docxErr) {
        await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Corrupted DOCX');
        await client.query('ROLLBACK');
        client.release();
        return res.status(422).json({
          success: false,
          code: 'CORRUPTED_DOCX_FILE',
          error: 'Tệp tin DOCX bị hỏng hoặc cấu trúc không đọc được: ' + docxErr.message
        });
      }
    } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
      const imgVal = ocrDocumentPipeline.validateFileBuffer(fileBuf, fileName, ext === '.png' ? 'image/png' : 'image/jpeg');
      if (!imgVal.valid) {
        await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', imgVal.error);
        await client.query('ROLLBACK');
        client.release();
        return res.status(imgVal.status).json({ success: false, code: imgVal.code, error: imgVal.error });
      }
    } else if (ext === '.txt' || ext === '.md') {
      const textContent = fileBuf.toString('utf8');
      if (textContent.trim().length < 20) {
        await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Invalid text structure');
        await client.query('ROLLBACK');
        client.release();
        return res.status(422).json({
          success: false,
          code: 'INVALID_TEXT_STRUCTURE',
          error: 'Tệp tin văn bản rỗng hoặc không đủ nội dung khả dụng.'
        });
      }
    }

    // 6. Đã có lease bảo vệ concurrency, giải phóng DB lock để n8n ghi dữ liệu chunks
    await client.query('COMMIT');

    // 7. Gửi multipart sang n8n Webhook
    let blob;
    let fileName = path.basename(doc.file_uri);
    if (ext === '.pdf') {
      blob = new Blob([fileBuf], { type: 'application/pdf' });
    } else if (ext === '.docx') {
      try {
        const mammoth = require('mammoth');
        const { value: textValue } = await mammoth.extractRawText({ buffer: fileBuf });
        const cleanDocxText = stripNullBytes((textValue || '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ''));
        blob = new Blob([Buffer.from(cleanDocxText, 'utf8')], { type: 'text/plain' });
        fileName = fileName.replace(/\.docx$/i, '.txt');
      } catch (e) {
        blob = new Blob([fileBuf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      }
    } else {
      const cleanText = stripNullBytes(fileBuf.toString('utf8').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ''));
      blob = new Blob([Buffer.from(cleanText, 'utf8')], { type: 'text/plain' });
    }
    const safeDocId = (doc.document_family_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(doc.document_family_id))
      ? String(doc.document_family_id).replace(/[^A-Za-z0-9_-]/g, '_')
      : ('DOC_' + String(doc.doc_code || doc.document_id || 'POLICY').replace(/[^A-Za-z0-9_-]/g, '_'));
    function formatIsoDate(d) {
      if (!d) return new Date().toISOString().slice(0, 10);
      if (d instanceof Date) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
      const s = String(d).trim();
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      const dObj = new Date(s);
      if (!isNaN(dObj.getTime())) {
        const y = dObj.getFullYear();
        const mo = String(dObj.getMonth() + 1).padStart(2, '0');
        const da = String(dObj.getDate()).padStart(2, '0');
        return `${y}-${mo}-${da}`;
      }
      return new Date().toISOString().slice(0, 10);
    }

    const safeEffDate = formatIsoDate(doc.effective_date);
    const safeIssueDate = formatIsoDate(doc.issue_date || doc.effective_date);
    const safeBranch = Array.isArray(doc.branch_scope) ? doc.branch_scope.join(', ') : (doc.branch_scope || 'all');

    try {
      const mimeType = ext === '.png' ? 'image/png' : (['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : (ext === '.pdf' ? 'application/pdf' : 'text/plain'));
      await triggerDocumentExtraction(doc, fileBuf, fileName, {
        actor: req.user.username,
        mimeType,
        generationId: leaseResult.generationId,
        fencingToken: leaseResult.fencingToken,
        idempotencyKey
      });
    } catch (netErr) {
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Lỗi tiến trình trích xuất OCR: ' + netErr.message);
      client.release();
      await logDocAudit(req, doc.doc_version_id, doc.document_id, 'RETRY_EXTRACTION_FAILED', doc.status, doc.status, 'Lỗi tiến trình trích xuất OCR: ' + netErr.message, { error: netErr.message });
      return res.status(502).json({
        success: false,
        code: 'OCR_EXTRACTION_FAILED',
        error: 'Tiến trình trích xuất OCR gặp sự cố: ' + netErr.message
      });
    }

    // 8. Fencing Token & Stale Worker Rejection Check
    const hasLeaseTable = await checkLeaseTableExists(client);
    if (hasLeaseTable) {
      const currentLeaseRes = await client.query(
        'SELECT fencing_token, status, expires_at FROM document_retry_leases WHERE doc_version_id = $1',
        [id]
      );
      if (currentLeaseRes.rows.length === 0) {
        client.release();
        return res.status(409).json({
          success: false,
          code: 'LEASE_NOT_FOUND',
          error: 'Hợp đồng lease trích xuất không tồn tại.'
        });
      }
      const leaseRow = currentLeaseRes.rows[0];
      const isLeaseExpired = new Date(leaseRow.expires_at) < new Date();
      if (Number(leaseRow.fencing_token) !== Number(leaseResult.fencingToken) || isLeaseExpired || leaseRow.status !== 'PROCESSING') {
        client.release();
        return res.status(409).json({
          success: false,
          code: 'STALE_WORKER_GENERATION',
          error: 'Tiến trình trích xuất này đã quá hạn hoặc bị thay thế bởi lượt retry mới hơn. Bản ghi cũ không được công bố.'
        });
      }
    }

    // 9. Pre-Commit Verification Gate: Kiểm tra tính nhất quán chunks trong PostgreSQL và vectors trong Qdrant
    const checkRes = await client.query('SELECT COUNT(*)::int AS count FROM chunks WHERE doc_version_id = $1', [id]);
    const chunkCount = checkRes.rows[0].count;

    if (chunkCount === 0) {
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', 'Trích xuất hoàn tất nhưng 0 chunks');
      client.release();
      await logDocAudit(req, doc.doc_version_id, doc.document_id, 'RETRY_EXTRACTION_FAILED', doc.status, doc.status, 'Trích xuất hoàn tất nhưng không sinh được đoạn văn bản nào (0 chunks)', {});
      return res.status(422).json({
        success: false,
        code: 'ZERO_CHUNKS_GENERATED',
        error: 'Tiến trình trích xuất hoàn tất nhưng văn bản không chứa nội dung hợp lệ để tạo đoạn (0 chunks).'
      });
    }

    // Kiểm tra số lượng Vector trong Qdrant
    let qdrantCount = 0;
    try {
      const qdrantSync = require('../services/qdrantSyncService');
      qdrantCount = await qdrantSync.countQdrantPoints(id);
    } catch (qErr) {
      console.warn('[RETRY] Không thể kiểm tra số lượng vector Qdrant:', qErr.message);
    }

    // Nếu Qdrant thất bại hoặc số lượng vector không đồng nhất với chunk
    if (qdrantCount === 0 || qdrantCount < chunkCount) {
      console.warn(`[RETRY CONSISTENCY WARNING] Lệch dữ liệu: PostgreSQL = ${chunkCount} chunks, Qdrant = ${qdrantCount} vectors.`);
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', `Lệch tính nhất quán: ${chunkCount} chunks vs ${qdrantCount} vectors`);
      // Compensation: Dọn dẹp vector rác và chunks chưa publish
      try {
        const qdrantSync = require('../services/qdrantSyncService');
        await qdrantSync.deleteDocumentFromQdrant(id);
      } catch (cleanQErr) {}
      await client.query('DELETE FROM chunks WHERE doc_version_id = $1 AND (is_published = FALSE OR generation_id = $2)', [id, leaseResult.generationId]);
      client.release();
      await logDocAudit(req, doc.doc_version_id, doc.document_id, 'RETRY_EXTRACTION_FAILED', doc.status, doc.status, `Đối soát thất bại: ${chunkCount} chunks vs ${qdrantCount} vectors`, {});
      return res.status(502).json({
        success: false,
        code: 'CONSISTENCY_VERIFICATION_FAILED',
        error: `Đối soát tính nhất quán PostgreSQL - Qdrant thất bại: ${chunkCount} đoạn văn bản trong PostgreSQL nhưng chỉ có ${qdrantCount} vector trong Qdrant. Generation chưa được công bố.`
      });
    }

    // 10. Atomic Publication & Promotion: Công bố generation và cập nhật lease
    await client.query('BEGIN');

    // Fencing token final verification under transaction lock
    if (hasLeaseTable) {
      const finalCheck = await client.query(
        'SELECT fencing_token, status FROM document_retry_leases WHERE doc_version_id = $1 FOR UPDATE',
        [id]
      );
      if (finalCheck.rows.length === 0 || Number(finalCheck.rows[0].fencing_token) !== Number(leaseResult.fencingToken) || finalCheck.rows[0].status !== 'PROCESSING') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(409).json({
          success: false,
          code: 'STALE_WORKER_GENERATION',
          error: 'Fencing token bị xung đột trong quá trình công bố. Bản ghi không được công bố.'
        });
      }
    }

    // Cập nhật generation trên documents
    await client.query(
      `UPDATE documents 
       SET active_generation_id = $1, 
           active_fencing_token = $2, 
           retry_count = COALESCE(retry_count, 0) + 1
       WHERE doc_version_id = $3`,
      [leaseResult.generationId, leaseResult.fencingToken, id]
    );

    // 1. Dọn dẹp các chunk thế hệ cũ (đã có generation_id trước đó)
    await client.query(
      `DELETE FROM chunks 
       WHERE doc_version_id = $1 AND generation_id IS NOT NULL`,
      [id]
    );

    // 2. Cập nhật trạng thái published và generation_id mới cho các chunk vừa được trích xuất (đang có generation_id IS NULL)
    await client.query(
      `UPDATE chunks 
       SET is_published = TRUE,
           generation_id = $2,
           fencing_token = $3
       WHERE doc_version_id = $1 AND generation_id IS NULL`,
      [id, leaseResult.generationId, leaseResult.fencingToken]
    );

    // Đồng bộ payload Qdrant cập nhật generation_id và is_published
    try {
      const qdrantSync = require('../services/qdrantSyncService');
      await qdrantSync.syncDocumentToQdrant(id);
    } catch (syncErr) {
      console.warn('[RETRY] Lỗi đồng bộ metadata Qdrant:', syncErr.message);
    }

    await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'PUBLISHED');
    await client.query('COMMIT');
    client.release();

    // 11. Ghi nhận Audit Log thành công
    await logDocAudit(req, doc.doc_version_id, doc.document_id, 'RETRY_EXTRACTION_SUCCESS', doc.status, doc.status, 'Thử lại trích xuất văn bản thành công (' + chunkCount + ' đoạn)', {
      chunk_count: chunkCount,
      generation_id: leaseResult.generationId,
      fencing_token: leaseResult.fencingToken,
      file_uri: doc.file_uri
    });

    const refreshedDocRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    const refreshedDoc = refreshedDocRes.rows[0];

    return res.json({
      success: true,
      message: `Thử lại trích xuất thành công! Đã tạo ${chunkCount} đoạn văn bản và chỉ mục vector.`,
      chunk_count: chunkCount,
      generation_id: leaseResult.generationId,
      fencing_token: leaseResult.fencingToken,
      document: enrichDocStatuses({ ...refreshedDoc, chunks: chunkCount })
    });
  } catch (err) {
    if (leaseResult && leaseResult.generationId) {
      await releaseOrUpdateLease(client, id, leaseResult.generationId, leaseResult.fencingToken, 'FAILED', err.message);
    }
    try { await client.query('ROLLBACK'); } catch(e) {}
    try { client.release(); } catch(e) {}
    console.error('Lỗi Retry Extraction:', err);
    return sendError(res, 'INTERNAL_ERROR', {
      user_message: 'Đã xảy ra lỗi máy chủ trong quá trình thử lại trích xuất.',
      message: err.message
    }, req);
  }
});

// =========================================================================
// PHASE 4/4.1: APPROVAL SAFETY GATE SERVICE (CENTRALIZED GATEWAY)
// Hàm evaluateApprovalSafetyGate được chuẩn hóa tại:
// auth-service/services/approvalSafetyGate.js
// Áp dụng đồng nhất cho: /approve, /activate, /restore và autoActivateDueDocuments
// =========================================================================

// 6. POST /api/documents/:id/approve - Phê duyệt văn bản (document.approve)
// Giai đoạn C: Đảm bảo Concurrency Control (Advisory Lock + FOR UPDATE), Zero-Chunk Safety Gate, Atomic Relationship Approval
router.post('/:id/approve', verifyToken, requirePermission('document.approve'), async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return sendError(res, 'INVALID_UUID', { error: 'Mã văn bản (ID) không đúng định dạng UUID.' }, req);
  }
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // 1. Khóa bản ghi văn bản ứng viên ở mức Row-level (SELECT FOR UPDATE)
    const docRes = await client.query('SELECT * FROM documents WHERE doc_version_id = $1 FOR UPDATE', [id]);
    if (docRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 'DOCUMENT_NOT_FOUND', { error: 'Không tìm thấy văn bản để phê duyệt.' }, req);
    }

    const doc = docRes.rows[0];

    // 2. Concurrency Control: Synchronized Advisory Locks across intersecting domains (P2-3)
    // - Văn bản Toàn tập đoàn ('all') giao thoa với toàn bộ các công ty con (STL, VTX, SWC)
    // - Văn bản công ty thành viên giao thoa với phạm vi công ty đó VÀ văn bản Toàn tập đoàn
    // - Hai công ty thành viên độc lập (ví dụ STL vs VTX) không khóa lẫn nhau nếu phạm vi không giao nhau
    // - Tất cả các transaction phải lấy khóa theo thứ tự tăng dần (sorted hashtext) để triệt tiêu 100% Deadlock!
    const ALL_SUBSIDIARY_BRANCHES = ['sotrans_logistics', 'vietranstimex', 'sowatco'];
    const docScopes = Array.isArray(doc.branch_scope) ? doc.branch_scope.map(s => String(s).toLowerCase().trim()) : [];
    
    let domainsToLock = [];
    if (docScopes.length === 0 || docScopes.includes('all')) {
      // Phạm vi Toàn tập đoàn hoặc không xác định (Fail-Closed): Khóa toàn bộ các domain
      domainsToLock = ['all', ...ALL_SUBSIDIARY_BRANCHES];
    } else {
      // Phạm vi công ty thành viên: Khóa domain công ty đó (sẽ tự động xung đột với Toàn tập đoàn vì Corporate khóa cả công ty con)
      domainsToLock = Array.from(new Set(docScopes));
    }

    // Khóa tuần tự theo thứ tự bảng chữ cái cố định để triệt tiêu hoàn toàn Deadlock
    const sortedDomains = Array.from(new Set(domainsToLock)).sort();
    for (const d of sortedDomains) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conflict_domain:${d}`]);
    }

    // 3. Kiểm tra Tenant Boundary của tài khoản phê duyệt
    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!doc.branch_scope || !doc.branch_scope.includes(userBranch)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: '403 Forbidden: Không thể phê duyệt văn bản thuộc công ty khác.' });
      }
    }

    // 4. Kiểm tra trạng thái hợp lệ trước khi xét quyền phê duyệt
    if (doc.status === 'active') {
      await client.query('ROLLBACK');
      const isIdempotentReq = !!(req.headers['x-idempotency-key'] || (req.body && req.body.idempotent));
      if (isIdempotentReq) {
        return res.status(200).json({
          success: true,
          message: 'Văn bản đã được phê duyệt và đang có hiệu lực thi hành.',
          idempotent: true,
          document: enrichDocStatuses(doc)
        });
      }
      return res.status(400).json({ success: false, error: 'Văn bản này đã được phê duyệt và đang áp dụng.' });
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const isFutureEffective = doc.effective_date && String(doc.effective_date).slice(0, 10) > todayStr;
    const tentativeTargetStatus = isFutureEffective ? 'scheduled' : 'active';
    const transitionCheck = validateStateTransition(doc.status, tentativeTargetStatus, req.user.role);
    if (!transitionCheck.valid) {
      await client.query('ROLLBACK');
      return res.status(transitionCheck.status).json({
        success: false,
        code: transitionCheck.code,
        error: transitionCheck.error
      });
    }

    // 5. Phân quyền và hình thức phê duyệt: ADMIN Phê duyệt trực tiếp vs Phê duyệt yêu cầu từ HR
    const isSelfApproval = (doc.creator_user_id && doc.creator_user_id === req.user.user_id) ||
                           (doc.uploaded_by && doc.uploaded_by.toLowerCase() === req.user.username.toLowerCase());
    const approvalAuditAction = isSelfApproval ? 'ADMIN_DIRECT_APPROVAL' : 'ADMIN_APPROVE_HR_SUBMISSION';
    const approvalAuditReason = isSelfApproval
      ? 'Quản trị viên trực tiếp phê duyệt và ban hành văn bản'
      : `Quản trị viên phê duyệt yêu cầu từ HR (${doc.uploaded_by || 'HR'})`;

    // =========================================================================
    // GATE 1: KIỂM SOÁT ĐỘ ĐẦY ĐỦ DỮ LIỆU & ZERO-CHUNK SAFETY GATE (TÁCH BIỆT HOÀN TOÀN)
    // 1. Kiểm tra số lượng chunk trong PostgreSQL (bắt buộc chunkCount > 0)
    // 2. Kiểm tra chất lượng nội dung trích xuất (bắt buộc candidateContent không rỗng)
    // =========================================================================
    const chunkCountRes = await client.query(
      'SELECT COUNT(*)::int as count FROM chunks WHERE doc_version_id = $1',
      [id]
    );
    const chunkCount = chunkCountRes.rows[0].count;

    if (chunkCount === 0) {
      await client.query('ROLLBACK');
      await logDocAudit(req, doc.doc_version_id, doc.document_id, 'APPROVE_BLOCKED_ZERO_CHUNK', doc.status, 'NEEDS_REVIEW', 'Từ chối phê duyệt do văn bản chưa có đoạn trích xuất (0 chunks) trong cơ sở dữ liệu. Yêu cầu xử lý trích xuất/OCR trước khi kích hoạt.');
      return sendError(res, 'APPROVE_BLOCKED_ZERO_CHUNK', {
        error: 'Không thể phê duyệt: Văn bản chưa có đoạn trích xuất (0 chunks) trong cơ sở dữ liệu. Vui lòng hoàn tất trích xuất OCR và chunking trước khi kích hoạt.',
        details: { doc_version_id: doc.doc_version_id, chunk_count: 0 }
      }, req);
    }

    const candidateChunksRes = await client.query(
      "SELECT COALESCE(substring(string_agg(content, ' ' ORDER BY seq) from 1 for 12000), '') as text FROM chunks WHERE doc_version_id = $1",
      [id]
    );
    const candidateContent = candidateChunksRes.rows[0]?.text || '';

    if (!candidateContent || !candidateContent.trim()) {
      await client.query('ROLLBACK');
      await logDocAudit(req, doc.doc_version_id, doc.document_id, 'APPROVE_BLOCKED_EMPTY_CONTENT', doc.status, 'NEEDS_REVIEW', 'Từ chối phê duyệt do nội dung trích xuất của văn bản rỗng.');
      return res.status(400).json({
        success: false,
        code: 'EXTRACTION_INCOMPLETE',
        status: 'NEEDS_REVIEW',
        error: 'Không thể phê duyệt: Nội dung trích xuất của văn bản rỗng hoặc không hợp lệ. Vui lòng kiểm tra lại chất lượng OCR/trích xuất trước khi kích hoạt.'
      });
    }

    // =========================================================================
    // KIỂM SOÁT QUAN HỆ VĂN BẢN ĐI KÈM & PHÂN QUYỀN DUYỆT QUAN HỆ (GIAI ĐOẠN C)
    // =========================================================================
    const pendingRelRes = await client.query(`
      SELECT r.*, 
             sd.doc_code as source_code, sd.branch_scope as source_branch_scope,
             td.doc_code as target_code, td.branch_scope as target_branch_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      WHERE (r.source_doc_version_id = $1 OR r.target_doc_version_id = $1)
        AND r.approval_status = 'pending_review'
    `, [id]);

    const pendingRelationships = pendingRelRes.rows;
    let confirmedRelationships = [];

    if (pendingRelationships.length > 0) {
      // P1-2: Mặc định KHÔNG tự động xác nhận quan hệ (confirm_relationships default false)
      let requestedRelIds = [];
      if (req.body) {
        if (Array.isArray(req.body.confirmed_relationship_ids)) {
          requestedRelIds = req.body.confirmed_relationship_ids;
        } else if (Array.isArray(req.body.confirm_relationships)) {
          requestedRelIds = req.body.confirm_relationships;
        } else if (req.body.confirm_relationships === true) {
          // Chỉ khi người duyệt gửi explicitly true (chấp thuận toàn bộ quan hệ đi kèm)
          requestedRelIds = pendingRelationships.map(r => r.relationship_id);
        }
      }

      if (requestedRelIds.length > 0) {
        // Kiểm tra từng relationship ID: Phải thuộc tài liệu đang duyệt và đang pending_review
        for (const relId of requestedRelIds) {
          const found = pendingRelationships.find(r => r.relationship_id === relId);
          if (!found) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              success: false,
              code: 'INVALID_RELATIONSHIP_ID',
              error: `Mã quan hệ '${relId}' không hợp lệ hoặc không thuộc tài liệu đang được duyệt.`
            });
          }
        }

        const toConfirm = pendingRelationships.filter(r => requestedRelIds.includes(r.relationship_id));

        // Kiểm tra thẩm quyền phê duyệt quan hệ (Tenant Scope & SuperAdmin) trên cả hai văn bản
        for (const rel of toConfirm) {
          const scopeCheck = checkRelationshipTenantScope(req.user, rel.source_branch_scope, rel.target_branch_scope);
          if (!scopeCheck.allowed) {
            await client.query('ROLLBACK');
            await logDocAudit(req, doc.doc_version_id, doc.document_id, 'RELATIONSHIP_APPROVE_UNAUTHORIZED', doc.status, doc.status, `Từ chối duyệt do không có thẩm quyền duyệt quan hệ: ${scopeCheck.error}`);
            return res.status(403).json({
              success: false,
              code: 'RELATIONSHIP_APPROVAL_UNAUTHORIZED',
              error: `403 Forbidden: Bạn không có thẩm quyền phê duyệt quan hệ đi kèm giữa văn bản ${rel.source_code || ''} và ${rel.target_code || ''}. ${scopeCheck.error}`
            });
          }

          // Bắt buộc quan hệ amends phải có phạm vi điều khoản sửa đổi (AUD-APP-02)
          if (rel.relation_type === 'amends') {
            try {
              const clauseCountRes = await client.query(
                'SELECT COUNT(*)::int as count FROM document_relationship_clauses WHERE relationship_id = $1',
                [rel.relationship_id]
              );
              if (clauseCountRes.rows[0].count === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                  success: false,
                  code: 'AMENDS_CLAUSE_SCOPE_REQUIRED',
                  error: `Không thể phê duyệt: Quan hệ sửa đổi (amends) với văn bản "${rel.target_code || rel.target_doc_version_id}" chưa được khai báo phạm vi điều khoản sửa đổi (Clause-level Scope). Vui lòng cập nhật danh mục điều khoản trước khi duyệt.`
                });
              }
            } catch (clauseQueryErr) {
              // Bỏ qua nếu bảng chưa tồn tại
            }
          }

          // Đính kèm danh mục điều khoản vào confirmedRelationship để Conflict Engine thẩm định
          try {
            const clRes = await client.query(
              'SELECT clause_rel_id, relationship_id, source_clause_ref, target_clause_ref, modification_type, summary_of_change, scope_status FROM document_relationship_clauses WHERE relationship_id = $1',
              [rel.relationship_id]
            );
            rel.clauses = clRes.rows || [];
          } catch (clErr) {
            rel.clauses = [];
          }
        }

        confirmedRelationships = toConfirm;
      }
    }

    // =========================================================================
    // GATE 2: BACKEND APPROVAL GATE - PHÁT HIỆN TRÙNG LẶP & XUNG ĐỘT CHÍNH SÁCH
    // Sử dụng hàm kiểm soát tập trung evaluateApprovalSafetyGate (Fail-Closed Semantics)
    // =========================================================================
    const gateResult = await evaluateApprovalSafetyGate(doc, req.body, client, confirmedRelationships);
    if (!gateResult.passed) {
      await client.query('ROLLBACK');
      await logDocAudit(req, doc.doc_version_id, doc.document_id, gateResult.code, doc.status, doc.status, gateResult.error, {
        risk_level: gateResult.risk_level,
        code: gateResult.code,
        blocking_conflicts: gateResult.blocking_conflicts,
        warnings: gateResult.warnings
      }, client);

      return res.status(gateResult.status).json({
        success: false,
        code: gateResult.code,
        risk_level: gateResult.risk_level,
        error: gateResult.error,
        details: {
          risk_level: gateResult.risk_level,
          conflict_type: gateResult.conflict_type || (gateResult.blocking_conflicts[0]?.type) || 'SAFETY_GATE_ALERT',
          doc_version_id: doc.doc_version_id,
          conflicts: gateResult.blocking_conflicts,
          warnings: gateResult.warnings,
          conflict_report: gateResult.conflict_report
        }
      });
    }

    // Xác định trạng thái đích:
    const today = new Date().toISOString().split('T')[0];
    let isDue = true;
    if (doc.effective_date) {
      const effStr = (doc.effective_date instanceof Date)
        ? new Date(doc.effective_date.getTime() - doc.effective_date.getTimezoneOffset() * 60000).toISOString().split('T')[0]
        : String(doc.effective_date).slice(0, 10);
      isDue = (effStr <= today);
    }
    const targetStatus = isDue ? 'active' : 'scheduled';
    const familyId = doc.document_family_id || ('DOC-FAM-' + doc.document_id);

    // =========================================================================
    // CẬP NHẬT NGUYÊN TỬ (ATOMIC TRANSACTION):
    // 1. Phê duyệt các quan hệ đi kèm đã được xác nhận (confirmedRelationships)
    // 2. Tự động chuyển các văn bản cũ cùng familyId sang superseded
    // 3. Tự động chuyển các văn bản đích có quan hệ supersedes sang superseded
    // 4. Cập nhật trạng thái văn bản chính sang active/scheduled
    // =========================================================================
    if (confirmedRelationships.length > 0) {
      const relIds = confirmedRelationships.map(r => r.relationship_id);
      await client.query(`
        UPDATE document_relationships
        SET approval_status = 'approved', approved_by = $1, approved_at = now()
        WHERE relationship_id = ANY($2::uuid[])
      `, [req.user.username, relIds]);

      for (const cr of confirmedRelationships) {
        await logDocAudit(req, doc.doc_version_id, doc.document_id, 'RELATIONSHIP_APPROVE', 'pending_review', 'approved', `Phê duyệt quan hệ ${cr.relation_type} với văn bản ${cr.target_code || cr.target_doc_version_id}`, {
          relationship_id: cr.relationship_id,
          relation_type: cr.relation_type,
          target_doc_version_id: cr.target_doc_version_id
        }, client);
      }
    }

    if (targetStatus === 'active') {
      // A. Cùng Family ID
      await client.query(
        `UPDATE documents 
         SET status = 'superseded', expiry_date = $1::date - 1
         WHERE document_family_id = $2 AND status = 'active' AND doc_version_id <> $3`,
        [doc.effective_date || today, familyId, doc.doc_version_id]
      );

      // B. Khác Family ID (thông qua quan hệ supersedes đã phê duyệt)
      await client.query(
        `UPDATE documents
         SET status = 'superseded', expiry_date = $1::date - 1
         WHERE doc_version_id IN (
           SELECT target_doc_version_id FROM document_relationships
           WHERE source_doc_version_id = $2 AND relation_type = 'supersedes' AND approval_status = 'approved'
         ) AND status = 'active'`,
        [doc.effective_date || today, doc.doc_version_id]
      );
    }

    // Cập nhật phê duyệt văn bản
    const updatedRes = await client.query(
      `UPDATE documents
       SET status = $1, approved_by = $2, approver_user_id = $3, approved_at = now()
       WHERE doc_version_id = $4
       RETURNING *`,
      [targetStatus, req.user.username, req.user.user_id, id]
    );

    const updatedDoc = updatedRes.rows[0];

    await logDocAudit(req, updatedDoc.doc_version_id, updatedDoc.document_id, approvalAuditAction, doc.status, targetStatus, approvalAuditReason, {
      creator_user_id: doc.creator_user_id,
      approver_user_id: req.user.user_id,
      document_family_id: familyId,
      risk_level: gateResult.risk_level,
      warnings_count: (gateResult.warnings || []).length,
      acknowledged_warnings: gateResult.acknowledged_warnings || false,
      override_reason: gateResult.override_reason || null,
      warnings: gateResult.warnings || [],
      scan_timestamp: new Date().toISOString()
    }, client);

    // =========================================================================
    // HOÀN TẤT TRANSACTION POSTGRESQL (COMMIT)
    // =========================================================================
    await client.query('COMMIT');

    // =========================================================================
    // POST-COMMIT ASYNCHRONOUS QDRANT SYNC (Không chặn và không rollback DB nếu Qdrant retry)
    // =========================================================================
    syncDocumentToQdrant(updatedDoc.doc_version_id).catch(e => console.error('Lỗi sync Qdrant sau approve:', e.message));

    if (targetStatus === 'active') {
      db.query(
        `SELECT doc_version_id::text FROM documents WHERE (document_family_id = $1 OR doc_version_id IN (
          SELECT target_doc_version_id FROM document_relationships WHERE source_doc_version_id = $2 AND relation_type = 'supersedes' AND approval_status = 'approved'
        )) AND status = 'superseded'`,
        [familyId, updatedDoc.doc_version_id]
      ).then(oldRes => {
        for (const r of oldRes.rows) {
          syncDocumentToQdrant(r.doc_version_id).catch(e => console.error('Lỗi sync superseded Qdrant:', e.message));
        }
      }).catch(errSup => {
        console.error('Lỗi truy vấn phiên bản superseded:', errSup.message);
      });
    }

    return res.json({
      success: true,
      message: `Phê duyệt văn bản thành công. Trạng thái mới: ${targetStatus === 'active' ? 'Đang áp dụng (Active)' : 'Chờ hiệu lực (Scheduled)'}.`,
      document: enrichDocStatuses(updatedDoc)
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {}
    console.error('Lỗi phê duyệt văn bản:', err);
    return sendError(res, 'INTERNAL_ERROR', { error: 'Đã xảy ra lỗi máy chủ trong quá trình phê duyệt: ' + err.message }, req);
  } finally {
    client.release();
  }
});

// 7. POST /api/documents/:id/reject - Từ chối phê duyệt văn bản (document.approve)
router.post('/:id/reject', verifyToken, requirePermission('document.approve'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp lý do từ chối cụ thể (tối thiểu 3 ký tự).' });
    }

    const docRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản.' });
    }

    const doc = docRes.rows[0];

    // Kiểm tra phạm vi công ty
    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!doc.branch_scope || !doc.branch_scope.includes(userBranch)) {
        return res.status(403).json({ success: false, error: '403 Forbidden: Không thể từ chối văn bản thuộc công ty khác.' });
      }
    }

    const transitionCheck = validateStateTransition(doc.status, 'rejected', req.user.role);
    if (!transitionCheck.valid) {
      return res.status(transitionCheck.status).json({
        success: false,
        code: transitionCheck.code,
        error: transitionCheck.error
      });
    }

    const updatedRes = await db.query(
      `UPDATE documents
       SET status = 'rejected', reject_reason = $1, approver_user_id = $2
       WHERE doc_version_id = $3
       RETURNING *`,
      [reason.trim(), req.user.user_id, id]
    );

    const updatedDoc = updatedRes.rows[0];

    await logDocAudit(req, updatedDoc.doc_version_id, updatedDoc.document_id, 'ADMIN_REJECT', doc.status, 'rejected', reason.trim());
    await syncDocumentToQdrant(updatedDoc.doc_version_id).catch(e => console.error('Lỗi sync Qdrant sau reject:', e.message));

    return res.json({
      success: true,
      message: 'Đã từ chối phê duyệt văn bản. Người tạo có thể chỉnh sửa và gửi duyệt lại.',
      document: enrichDocStatuses(updatedDoc)
    });
  } catch (err) {
    console.error('Lỗi từ chối văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 7.1 POST /api/documents/:id/activate - ADMIN kích hoạt trực tiếp văn bản (document.approve)
router.post('/:id/activate', verifyToken, requirePermission('document.approve'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const docRes = await client.query('SELECT * FROM documents WHERE doc_version_id = $1 FOR UPDATE', [id]);
    if (docRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản.' });
    }
    const doc = docRes.rows[0];

    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!doc.branch_scope || (!doc.branch_scope.includes(userBranch) && !doc.branch_scope.includes('all'))) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: '403 Forbidden: Không có quyền kích hoạt văn bản ngoài phạm vi công ty.' });
      }
    }

    if (doc.status === 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Văn bản này đã đang áp dụng (Active).' });
    }

    const transitionCheck = validateStateTransition(doc.status, 'active', req.user.role);
    if (!transitionCheck.valid) {
      await client.query('ROLLBACK');
      return res.status(transitionCheck.status).json({
        success: false,
        code: transitionCheck.code,
        error: transitionCheck.error
      });
    }

    // GATE 2: BACKEND APPROVAL GATE (FAIL-CLOSED) - KIỂM SOÁT XUNG ĐỘT KHI KÍCH HOẠT
    const gateResult = await evaluateApprovalSafetyGate(doc, req.body, client);
    if (!gateResult.passed) {
      await client.query('ROLLBACK');
      await logDocAudit(req, doc.doc_version_id, doc.document_id, gateResult.code, doc.status, doc.status, `Kích hoạt bị chặn bởi Safety Gate: ${gateResult.error}`, {
        risk_level: gateResult.risk_level,
        code: gateResult.code,
        blocking_conflicts: gateResult.blocking_conflicts,
        warnings: gateResult.warnings
      }, client);

      return res.status(gateResult.status).json({
        success: false,
        code: gateResult.code,
        risk_level: gateResult.risk_level,
        error: gateResult.error,
        details: {
          risk_level: gateResult.risk_level,
          conflict_type: gateResult.conflict_type || (gateResult.blocking_conflicts[0]?.type) || 'SAFETY_GATE_ALERT',
          doc_version_id: doc.doc_version_id,
          conflicts: gateResult.blocking_conflicts,
          warnings: gateResult.warnings,
          conflict_report: gateResult.conflict_report
        }
      });
    }

    const today = new Date().toISOString().split('T')[0];
    const familyId = doc.document_family_id;

    // Supersede previous versions in same family
    if (familyId) {
      await client.query(
        `UPDATE documents 
         SET status = 'superseded', expiry_date = $1::date - 1
         WHERE document_family_id = $2 AND status = 'active' AND doc_version_id <> $3`,
        [doc.effective_date || today, familyId, doc.doc_version_id]
      );
    }

    const updatedRes = await client.query(
      `UPDATE documents 
       SET status = 'active', approved_by = COALESCE(approved_by, $1), approver_user_id = COALESCE(approver_user_id, $2), approved_at = COALESCE(approved_at, now())
       WHERE doc_version_id = $3
       RETURNING *`,
      [req.user.username, req.user.user_id, id]
    );

    const updatedDoc = updatedRes.rows[0];
    await logDocAudit(req, updatedDoc.doc_version_id, updatedDoc.document_id, 'ADMIN_ACTIVATE', doc.status, 'active', 'Quản trị viên kích hoạt trực tiếp văn bản sang trạng thái Đang áp dụng', {
      creator_user_id: doc.creator_user_id,
      approver_user_id: req.user.user_id,
      document_family_id: familyId,
      risk_level: gateResult.risk_level,
      warnings_count: (gateResult.warnings || []).length,
      acknowledged_warnings: gateResult.acknowledged_warnings || false,
      override_reason: gateResult.override_reason || null,
      warnings: gateResult.warnings || [],
      scan_timestamp: new Date().toISOString()
    }, client);

    await client.query('COMMIT');
    syncDocumentToQdrant(updatedDoc.doc_version_id).catch(e => console.error('Lỗi sync Qdrant sau activate:', e.message));

    return res.json({
      success: true,
      message: 'Đã kích hoạt văn bản thành công. Trạng thái hiện tại: Đang áp dụng (Active).',
      document: enrichDocStatuses(updatedDoc)
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {}
    console.error('Lỗi kích hoạt văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ trong quá trình kích hoạt: ' + err.message });
  } finally {
    client.release();
  }
});

// 8. POST /api/documents/:id/archive - Lưu trữ / ngừng hiệu lực văn bản (document.archive)
router.post('/:id/archive', verifyToken, requirePermission('document.archive'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const docRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản để lưu trữ.' });
    }

    const doc = docRes.rows[0];

    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!doc.branch_scope || !doc.branch_scope.includes(userBranch)) {
        return res.status(403).json({ success: false, error: '403 Forbidden: Không thể lưu trữ văn bản của công ty khác.' });
      }
    }

    const transitionCheck = validateStateTransition(doc.status, 'archived', req.user.role);
    if (!transitionCheck.valid) {
      return res.status(transitionCheck.status).json({
        success: false,
        code: transitionCheck.code,
        error: transitionCheck.error
      });
    }

    const archiveReason = (reason && reason.trim()) ? reason.trim() : 'Ngừng áp dụng và chuyển vào kho lưu trữ';

    const updatedRes = await db.query(
      `UPDATE documents
       SET status = 'archived', archived_at = now(), archived_by = $1, archive_reason = $2
       WHERE doc_version_id = $3
       RETURNING *`,
      [req.user.username, archiveReason, id]
    );

    const updatedDoc = updatedRes.rows[0];

    await logDocAudit(req, updatedDoc.doc_version_id, updatedDoc.document_id, 'ARCHIVE', doc.status, 'archived', archiveReason);
    await syncDocumentToQdrant(updatedDoc.doc_version_id).catch(e => console.error('Lỗi sync Qdrant sau archive:', e.message));

    return res.json({
      success: true,
      message: 'Văn bản đã được chuyển sang trạng thái Lưu trữ (Archived) an toàn.',
      document: updatedDoc
    });
  } catch (err) {
    console.error('Lỗi lưu trữ văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 8.1 POST /api/documents/:id/retract - Thu hồi yêu cầu phê duyệt về bản nháp (draft)
router.post('/:id/retract', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_UUID', error: 'Mã văn bản (ID) không đúng định dạng UUID.' });
    }

    const docRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'DOCUMENT_NOT_FOUND', error: 'Không tìm thấy văn bản để thu hồi.' });
    }

    const doc = docRes.rows[0];
    const isSuperAdmin = isSuperAdminUser(req.user);
    const isAdmin = req.user.role === 'ADMIN' || isSuperAdmin;
    const isHR = req.user.role === 'HR';

    // Tenant boundary check
    if (!isSuperAdmin) {
      const userBranch = getBranchForCompany(req.user.company_id);
      const isScopeAllowed = !doc.branch_scope || doc.branch_scope.includes(userBranch) || (isAdmin && doc.branch_scope.includes('all'));
      if (!isScopeAllowed) {
        return res.status(403).json({ success: false, code: 'CROSS_TENANT_FORBIDDEN', error: '403 Forbidden: Không thể thao tác trên văn bản của công ty khác.' });
      }
    }

    // State machine check
    const transitionCheck = validateStateTransition(doc.status, 'draft', req.user.role);
    if (!transitionCheck.valid) {
      return res.status(transitionCheck.status).json({
        success: false,
        code: transitionCheck.code,
        error: transitionCheck.error
      });
    }

    // Owner check: HR must be creator or uploader
    if (!isAdmin) {
      const isOwner = (doc.creator_user_id && doc.creator_user_id === req.user.user_id) ||
                      (doc.uploaded_by && doc.uploaded_by.toLowerCase() === (req.user.username || '').toLowerCase());
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          code: 'NOT_DOCUMENT_OWNER',
          error: '403 Forbidden: Bạn không phải người tải lên văn bản này nên không có quyền thu hồi yêu cầu phê duyệt.'
        });
      }
    }

    const retractReason = (req.body && req.body.reason && req.body.reason.trim()) ? req.body.reason.trim() : 'Người tạo thu hồi yêu cầu phê duyệt để chỉnh sửa';

    await db.query(
      `UPDATE documents
       SET status = 'draft', submitted_at = NULL
       WHERE doc_version_id = $1`,
      [id]
    );

    await logDocAudit(req, doc.doc_version_id, doc.document_id, 'RETRACT_APPROVAL', doc.status, 'draft', retractReason);

    return res.json({
      success: true,
      code: 'RETRACTED_TO_DRAFT',
      message: 'Đã thu hồi yêu cầu phê duyệt thành công. Văn bản đã quay về trạng thái Bản nháp (draft).',
      status: 'draft'
    });
  } catch (err) {
    console.error('Lỗi thu hồi văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 8.2 POST /api/documents/:id/restore - Khôi phục văn bản từ Thùng rác / Lưu trữ / Đã hủy
// PHASE 4.1B: Kiểm soát an toàn toàn diện (Approval Safety Gate Guard khi mục tiêu là Active)
router.post('/:id/restore', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, code: 'INVALID_UUID', error: 'Mã văn bản (ID) không đúng định dạng UUID.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Khóa bi quan bản ghi văn bản
    const docRes = await client.query('SELECT * FROM documents WHERE doc_version_id = $1 FOR UPDATE', [id]);
    if (docRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, code: 'DOCUMENT_NOT_FOUND', error: 'Không tìm thấy văn bản để khôi phục.' });
    }

    const doc = docRes.rows[0];
    const isSuperAdmin = isSuperAdminUser(req.user);
    const isAdmin = req.user.role === 'ADMIN' || isSuperAdmin;
    const isHR = req.user.role === 'HR';

    // 2. Kiểm tra Tenant Boundary
    if (!isSuperAdmin) {
      const userBranch = getBranchForCompany(req.user.company_id);
      const isScopeAllowed = !doc.branch_scope || doc.branch_scope.includes(userBranch) || (isAdmin && doc.branch_scope.includes('all'));
      if (!isScopeAllowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, code: 'CROSS_TENANT_FORBIDDEN', error: '403 Forbidden: Không thể khôi phục văn bản của công ty khác.' });
      }
    }

    if (doc.status !== 'trash' && doc.status !== 'revoked' && doc.status !== 'archived') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        code: 'NOT_IN_TRASH',
        error: `Chỉ có thể khôi phục văn bản đang ở trong Thùng rác, Đã hủy hoặc Lưu trữ (hiện tại: ${doc.status}).`
      });
    }

    // 3. Quyền chủ sở hữu nếu là HR
    if (!isAdmin) {
      const isOwner = (doc.creator_user_id && doc.creator_user_id === req.user.user_id) ||
                      (doc.uploaded_by && doc.uploaded_by.toLowerCase() === (req.user.username || '').toLowerCase());
      if (!isOwner) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          code: 'NOT_DOCUMENT_OWNER',
          error: '403 Forbidden: Bạn không phải người tải lên văn bản này nên không có quyền khôi phục.'
        });
      }
    }

    // 4. Xác định trạng thái đích cần khôi phục
    let targetStatus = 'active';
    if (doc.status === 'trash') {
      if (doc.status_before_trash === 'rejected' || (!doc.status_before_trash && doc.reject_reason && !doc.approved_at)) {
        targetStatus = 'rejected';
      } else if (doc.status_before_trash === 'draft' || (!doc.status_before_trash && !doc.approved_at)) {
        targetStatus = 'draft';
      }
    }

    // 5. PHASE 4.1B: Khi mục tiêu là 'active', BẮT BUỘC gọi evaluateApprovalSafetyGate (Fail-Closed, Zero-Bypass)
    let gateResult = null;
    if (targetStatus === 'active') {
      // Khóa tuần tự domain/mã văn bản
      const domainsToLock = [doc.document_id, doc.document_family_id, doc.doc_code].filter(Boolean);
      const sortedDomains = Array.from(new Set(domainsToLock)).sort();
      for (const dom of sortedDomains) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conflict_domain:${dom}`]);
      }

      // Tải quan hệ văn bản đã được phê duyệt
      const relRes = await client.query(`
        SELECT r.*, 
               sd.doc_code as source_code, td.doc_code as target_code
        FROM document_relationships r
        JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
        JOIN documents td ON r.target_doc_version_id = td.doc_version_id
        WHERE (r.source_doc_version_id = $1 OR r.target_doc_version_id = $1)
          AND r.approval_status = 'approved'
      `, [doc.doc_version_id]);
      const confirmedRelationships = relRes.rows || [];

      gateResult = await evaluateApprovalSafetyGate(doc, req.body, client, confirmedRelationships);

      if (!gateResult.passed) {
        await client.query('ROLLBACK');

        // Ghi Audit Log hành vi bị chặn
        await logDocAudit(req, doc.doc_version_id, doc.document_id, gateResult.code, doc.status, doc.status, `Khôi phục bị chặn bởi Safety Gate: ${gateResult.error}`, {
          risk_level: gateResult.risk_level,
          code: gateResult.code,
          blocking_conflicts: gateResult.blocking_conflicts || [],
          warnings: gateResult.warnings || [],
          target_status: 'active'
        });

        const statusHttp = gateResult.status || (gateResult.risk_level === 'HIGH' ? 409 : 422);
        return res.status(statusHttp).json({
          success: false,
          code: gateResult.code,
          risk_level: gateResult.risk_level,
          error: gateResult.error,
          details: {
            risk_level: gateResult.risk_level,
            conflict_type: gateResult.conflict_type,
            doc_version_id: doc.doc_version_id,
            conflicts: gateResult.blocking_conflicts || [],
            warnings: gateResult.warnings || [],
            conflict_report: gateResult.conflict_report
          }
        });
      }
    }

    // 6. Thực hiện khôi phục văn bản trong Transaction
    const familyId = doc.document_family_id || ('DOC-FAM-' + doc.document_id);
    if (targetStatus === 'active') {
      // Supersede các văn bản active khác cùng nhóm family
      await client.query(`
        UPDATE documents SET status = 'superseded', expiry_date = CURRENT_DATE - 1
        WHERE (document_id = $1 OR (document_family_id IS NOT NULL AND document_family_id = $2))
          AND status = 'active' AND doc_version_id <> $3
      `, [doc.document_id, familyId, id]);

      await client.query(`
        UPDATE documents
        SET status = 'active', expiry_date = NULL, deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, status_before_trash = NULL,
            archived_at = NULL, archived_by = NULL, archive_reason = NULL,
            approved_by = COALESCE(approved_by, $1), approved_at = COALESCE(approved_at, now())
        WHERE doc_version_id = $2
      `, [req.user.username, id]);
    } else {
      await client.query(`
        UPDATE documents
        SET status = $1, deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, status_before_trash = NULL
        WHERE doc_version_id = $2
      `, [targetStatus, id]);
    }

    const restoreReason = doc.status === 'archived'
      ? 'Khôi phục văn bản từ kho Lưu trữ sang Đang áp dụng'
      : (doc.status === 'revoked' ? 'Khôi phục văn bản Đã hủy sang Đang áp dụng' : 'Khôi phục văn bản từ Thùng rác');

    const auditDetail = {
      document_id: doc.document_id,
      version: doc.version,
      title: doc.title,
      target_status: targetStatus,
      risk_level: gateResult ? gateResult.risk_level : 'LOW',
      acknowledged_warnings: gateResult ? !!gateResult.acknowledged_warnings : false,
      override_reason: gateResult ? gateResult.override_reason : null,
      warnings_count: gateResult?.warnings?.length || 0
    };

    await client.query(`
      INSERT INTO document_audit_logs (doc_version_id, document_id, action, actor_user_id, actor_username, actor_role, actor_company, status_before, status_after, reason, detail)
      VALUES ($1, $2, 'RESTORE', $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      doc.doc_version_id, doc.document_id, req.user.user_id, req.user.username, req.user.role, req.user.company_id || 'SYSTEM',
      doc.status, targetStatus, restoreReason, JSON.stringify(auditDetail)
    ]);

    await client.query('COMMIT');

    // 7. Đồng bộ Qdrant
    if (targetStatus === 'active') {
      await syncDocumentToQdrant(id).catch(e => console.error('Lỗi sync Qdrant sau restore:', e.message));
      db.query(
        `SELECT doc_version_id FROM documents WHERE (document_id = $1 OR document_family_id = $2) AND status = 'superseded' AND doc_version_id <> $3`,
        [doc.document_id, familyId, id]
      ).then(supRes => {
        for (const sRow of supRes.rows) {
          syncDocumentToQdrant(sRow.doc_version_id).catch(() => {});
        }
      }).catch(() => {});
    }

    return res.json({
      success: true,
      code: 'DOCUMENT_RESTORED',
      message: `Đã khôi phục văn bản về trạng thái "${targetStatus}".`,
      restored_status: targetStatus,
      risk_level: gateResult ? gateResult.risk_level : 'LOW'
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Lỗi khôi phục văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  } finally {
    client.release();
  }
});

// 9. DELETE /api/documents/:id - Xóa mềm / Xóa vĩnh viễn văn bản
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_UUID', error: 'Mã văn bản (ID) không đúng định dạng UUID.' });
    }

    const docRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'DOCUMENT_NOT_FOUND', error: 'Không tìm thấy văn bản để xóa.' });
    }

    const doc = docRes.rows[0];

    const isSuperAdmin = isSuperAdminUser(req.user);
    const isAdmin = req.user.role === 'ADMIN' || isSuperAdmin;
    const isHR = req.user.role === 'HR';

    // Anti-IDOR Tenant Boundary check
    if (!isSuperAdmin) {
      const userBranch = getBranchForCompany(req.user.company_id);
      const isScopeAllowed = !doc.branch_scope || doc.branch_scope.includes(userBranch) || (isAdmin && doc.branch_scope.includes('all'));
      if (!isScopeAllowed) {
        return res.status(403).json({
          success: false,
          code: 'CROSS_TENANT_FORBIDDEN',
          error: '403 Forbidden: Không thể xóa văn bản thuộc công ty khác.'
        });
      }
    }

    // Lifecycle Status Checks (409 Conflict)
    if (doc.status === 'active') {
      return res.status(409).json({
        success: false,
        code: 'DOCUMENT_ACTIVE',
        error: 'Văn bản đang áp dụng (Active) không thể xóa trực tiếp. Vui lòng lưu trữ (Archive) hoặc hủy bỏ trước khi chuyển vào thùng rác.'
      });
    }

    if (doc.status === 'pending_approval') {
      return res.status(409).json({
        success: false,
        code: 'DOCUMENT_PENDING_APPROVAL',
        error: 'Văn bản đang chờ phê duyệt không thể xóa trực tiếp. Người tải lên có thể thu hồi yêu cầu phê duyệt về bản nháp trước khi xóa.'
      });
    }

    if (doc.status === 'scheduled') {
      return res.status(409).json({
        success: false,
        code: 'DOCUMENT_SCHEDULED',
        error: 'Văn bản đang chờ đến ngày hiệu lực không thể xóa trực tiếp. Vui lòng hủy bỏ trước khi chuyển vào thùng rác.'
      });
    }

    // Role & Ownership Verification:
    // HR chỉ được xóa bản nháp (draft) hoặc bị từ chối (rejected) do chính mình tải lên
    if (!isAdmin) {
      if (!isHR) {
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN_ROLE',
          error: '403 Forbidden: Bạn không có quyền xóa văn bản.'
        });
      }

      if (!['draft', 'rejected'].includes(doc.status)) {
        return res.status(403).json({
          success: false,
          code: 'HR_STATUS_FORBIDDEN',
          error: `403 Forbidden: Nhân sự chỉ được phép xóa văn bản ở trạng thái Bản nháp (draft) hoặc Bị từ chối (rejected), không thể xóa văn bản đang ở trạng thái "${doc.status}".`
        });
      }

      // Check owner strictly from authenticated session/token (anti-IDOR)
      const isOwner = (doc.creator_user_id && doc.creator_user_id === req.user.user_id) ||
                      (doc.uploaded_by && doc.uploaded_by.toLowerCase() === (req.user.username || '').toLowerCase());
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          code: 'NOT_DOCUMENT_OWNER',
          error: '403 Forbidden: Bạn không phải người tải lên văn bản này nên không có quyền xóa.'
        });
      }
    }

    const deletionReason = (req.body && req.body.reason && req.body.reason.trim())
      ? req.body.reason.trim()
      : (isHR ? 'HR người tạo xóa văn bản' : 'Chuyển vào thùng rác lưu 30 ngày');

    if (doc.status !== 'trash') {
      // Soft Delete: Chuyển vào Thùng rác, lưu status_before_trash, deleted_by, deletion_reason
      await db.query(
        `UPDATE documents
         SET status_before_trash = status,
             status = 'trash',
             deleted_at = now(),
             deleted_by = $1,
             deletion_reason = $2
         WHERE doc_version_id = $3`,
        [req.user.username || 'unknown', deletionReason, id]
      );
      await logDocAudit(req, doc.doc_version_id, doc.document_id, 'DELETE', doc.status, 'trash', deletionReason);
      await syncDocumentToQdrant(id).catch(e => console.error('Lỗi sync Qdrant sau trash:', e.message));
      return res.json({
        success: true,
        code: 'DOCUMENT_TRASHED',
        message: isHR ? 'Đã xóa văn bản thành công (chuyển vào Thùng rác lưu 30 ngày).' : 'Đã chuyển văn bản vào thùng rác lưu trữ 30 ngày.',
        status_before_trash: doc.status
      });
    } else {
      // Xóa vĩnh viễn (Purge): Chỉ Quản trị viên cấp cao (Super Admin)
      if (!isSuperAdmin) {
        return res.status(403).json({
          success: false,
          code: 'PURGE_SUPERADMIN_ONLY',
          error: 'Chỉ Quản trị viên cấp cao (Super Admin) mới có quyền xóa vĩnh viễn văn bản khỏi cơ sở dữ liệu.'
        });
      }

      await db.query('DELETE FROM chunks WHERE doc_version_id = $1', [id]);
      await db.query('DELETE FROM documents WHERE doc_version_id = $1', [id]);
      await logDocAudit(req, doc.doc_version_id, doc.document_id, 'PERMANENT_DELETE', 'trash', 'DELETED', deletionReason);
      await deleteDocumentFromQdrant(id).catch(e => console.error('Lỗi delete Qdrant:', e.message));
      return res.json({
        success: true,
        code: 'DOCUMENT_PURGED',
        message: 'Đã xóa vĩnh viễn văn bản khỏi hệ thống.'
      });
    }
  } catch (err) {
    console.error('Lỗi xóa văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 10. GET /api/documents/:id/audit-logs - Lịch sử kiểm toán văn bản
router.get('/:id/audit-logs', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!['ADMIN', 'HR'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Bạn không có quyền xem nhật ký kiểm toán văn bản.' });
    }

    const query = `
      SELECT id, doc_version_id, document_id, action, actor_username, actor_role,
             actor_company, status_before, status_after, reason, detail, ip_address, created_at
      FROM document_audit_logs
      WHERE doc_version_id = $1 OR document_id = $2
      ORDER BY created_at DESC
    `;

    const result = await db.query(query, [/^[0-9a-f-]{36}$/i.test(id) ? id : null, id]);
    return res.json({ success: true, logs: result.rows });
  } catch (err) {
    console.error('Lỗi lấy nhật ký kiểm toán văn bản:', err);
    return res.status(500).json({ success: false, error: 'Đã xảy ra lỗi máy chủ.' });
  }
});

// 11. POST /api/documents/sync-qdrant - Kích hoạt đối soát & đồng bộ toàn diện sang Qdrant
router.post('/sync-qdrant', verifyToken, requirePermission('document.approve'), async (req, res) => {
  try {
    const result = await syncAllDocumentsToQdrant();
    return res.json({
      success: true,
      message: 'Đã hoàn tất đồng bộ toàn diện tất cả tài liệu sang Qdrant Vector DB.',
      ...result
    });
  } catch (err) {
    console.error('Lỗi API sync-qdrant:', err);
    return res.status(500).json({ success: false, error: 'Lỗi đồng bộ Qdrant: ' + err.message });
  }
});

// 11.5 GET /api/documents/relationships/all - Lấy danh sách tất cả các quan hệ trong hệ thống
router.get('/relationships/all', verifyToken, async (req, res) => {
  try {
    const query = `
      SELECT r.relationship_id, r.source_doc_version_id, r.target_doc_version_id,
             r.relation_type, r.approval_status, r.notes, r.created_by, r.approved_by,
             r.created_at, r.approved_at,
             sd.title AS source_title, sd.doc_code AS source_doc_code, sd.doc_number AS source_doc_number,
             sd.branch_scope AS source_branch_scope, sd.department_scope AS source_dept_scope,
             td.title AS target_title, td.doc_code AS target_doc_code, td.doc_number AS target_doc_number,
             td.branch_scope AS target_branch_scope, td.department_scope AS target_dept_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      ORDER BY r.created_at DESC
    `;
    const result = await db.query(query);
    let rows = result.rows;
    if (!isSuperAdminUser(req.user)) {
      const userCompany = req.user.company_id ? String(req.user.company_id).toUpperCase().trim() : null;
      const userBranch = getBranchForCompany(userCompany);
      rows = rows.filter(r => {
        const sBranch = Array.isArray(r.source_branch_scope) ? r.source_branch_scope : [r.source_branch_scope];
        const tBranch = Array.isArray(r.target_branch_scope) ? r.target_branch_scope : [r.target_branch_scope];
        return sBranch.includes(userBranch) || sBranch.includes('all') || tBranch.includes(userBranch) || tBranch.includes('all');
      });
    }
    return res.json({ success: true, relationships: rows });
  } catch (err) {
    console.error('Lỗi lấy tất cả quan hệ:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 11.6 POST /api/documents/relationships/:relId/review - HR/Admin phê duyệt hoặc từ chối quan hệ
router.post('/relationships/:relId/review', verifyToken, async (req, res) => {
  try {
    const { relId } = req.params;
    const { status, action, notes = '' } = req.body;
    const finalStatus = status || (action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : action));

    if (!['approved', 'rejected', 'pending_review'].includes(finalStatus)) {
      return res.status(400).json({ success: false, error: 'Trạng thái phê duyệt không hợp lệ. Cho phép: approved, rejected, pending_review.' });
    }

    // Kiểm tra quyền hạn: Chỉ HR hoặc Quản trị viên (ADMIN) mới được duyệt/từ chối
    const userRole = String(req.user.role || '').toUpperCase();
    if (!['ADMIN', 'HR', 'SUPER_ADMIN', 'SUPERADMIN'].includes(userRole)) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Chỉ tài khoản HR hoặc Quản trị viên mới có quyền phê duyệt quan hệ văn bản.' });
    }

    const relRes = await db.query(`
      SELECT r.*, sd.doc_code AS source_code, sd.branch_scope AS source_branch_scope,
             td.doc_code AS target_code, td.branch_scope AS target_branch_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      WHERE r.relationship_id = $1
    `, [relId]);

    if (relRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quan hệ văn bản.' });
    }
    const rel = relRes.rows[0];

    // Kiểm tra Tenant Boundary
    const scopeCheck = checkRelationshipTenantScope(req.user, rel.source_branch_scope, rel.target_branch_scope);
    if (!scopeCheck.allowed) {
      // Ghi nhận security audit log khi có vi phạm Tenant Boundary
      try {
        await db.query(`
          INSERT INTO document_audit_logs (
            id, doc_version_id, document_id, action,
            actor_user_id, actor_username, actor_role, actor_company,
            status_before, status_after, reason, detail, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        `, [
          require('crypto').randomUUID(),
          rel.source_doc_version_id,
          rel.source_code || 'RELATIONSHIP',
          'SECURITY_TENANT_VIOLATION',
          req.user.user_id || null,
          req.user.username || 'unknown',
          req.user.role || 'UNKNOWN',
          req.user.company_id || null,
          rel.approval_status,
          rel.approval_status,
          `Từ chối thao tác quan hệ ngoài phạm vi công ty ${req.user.company_id || 'UNKNOWN'}: ${scopeCheck.error}`,
          JSON.stringify({
            relationship_id: relId,
            source_doc_version_id: rel.source_doc_version_id,
            target_doc_version_id: rel.target_doc_version_id,
            source_branch_scope: rel.source_branch_scope,
            target_branch_scope: rel.target_branch_scope,
            attempted_action: finalStatus
          })
        ]);
      } catch (logErr) {
        console.error('Lỗi ghi security audit log:', logErr.message);
      }

      return res.status(scopeCheck.status || 403).json({
        success: false,
        error: scopeCheck.error
      });
    }

    const approverName = req.user.username || req.user.email || 'hr_admin';
    const approverUserId = req.user.user_id || null;
    const combinedNotes = notes ? `${rel.notes ? rel.notes + ' | ' : ''}Ghi chú duyệt [${approverName}]: ${notes}` : rel.notes;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const updateQuery = `
        UPDATE document_relationships
        SET approval_status = $1,
            approved_by = $2,
            approved_at = NOW(),
            notes = $3
        WHERE relationship_id = $4
        RETURNING *
      `;
      const updatedRes = await client.query(updateQuery, [
        finalStatus,
        finalStatus === 'approved' ? approverName : null,
        combinedNotes,
        relId
      ]);

      // Ghi audit log
      await client.query(`
        INSERT INTO document_audit_logs (
          id, doc_version_id, document_id, action,
          actor_user_id, actor_username, actor_role, actor_company,
          status_before, status_after, reason, detail, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      `, [
        require('crypto').randomUUID(),
        rel.source_doc_version_id,
        rel.source_code || 'RELATIONSHIP',
        finalStatus === 'approved' ? 'RELATIONSHIP_APPROVE' : (finalStatus === 'rejected' ? 'RELATIONSHIP_REJECT' : 'RELATIONSHIP_REVIEW_UPDATE'),
        approverUserId,
        approverName,
        req.user.role,
        req.user.company_id || null,
        rel.approval_status,
        finalStatus,
        notes || `HR/Admin xử lý phê duyệt quan hệ: ${finalStatus}`,
        JSON.stringify({
          relationship_id: relId,
          relation_type: rel.relation_type,
          source_doc_version_id: rel.source_doc_version_id,
          target_doc_version_id: rel.target_doc_version_id,
          source_code: rel.source_code,
          target_code: rel.target_code,
          source_branch_scope: rel.source_branch_scope,
          target_branch_scope: rel.target_branch_scope,
          approval_status: finalStatus,
          approved_by: finalStatus === 'approved' ? approverName : null
        })
      ]);

      // Xử lý logic nghiệp vụ đặc thù khi quan hệ supersedes được duyệt
      if (rel.relation_type === 'supersedes' && finalStatus === 'approved') {
        const srcDocRes = await client.query('SELECT status, effective_date FROM documents WHERE doc_version_id = $1', [rel.source_doc_version_id]);
        if (srcDocRes.rows.length > 0 && srcDocRes.rows[0].status === 'active') {
          const effDate = srcDocRes.rows[0].effective_date || new Date().toISOString().slice(0, 10);
          await client.query(
            `UPDATE documents SET status = 'superseded', expiry_date = $1::date - 1 WHERE doc_version_id = $2`,
            [effDate, rel.target_doc_version_id]
          );
        }
      }

      await client.query('COMMIT');

      if (rel.relation_type === 'supersedes' && finalStatus === 'approved') {
        syncDocumentToQdrant(rel.target_doc_version_id).catch(() => {});
      }

      return res.json({ success: true, relationship: updatedRes.rows[0] });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Lỗi review quan hệ văn bản:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 11.7 GET /api/documents/:id/retrieval-control - Lấy thông tin cấu hình kiểm soát truy xuất
router.get('/:id/retrieval-control', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM document_retrieval_controls WHERE doc_version_id = $1',
      [id]
    );
    return res.json({ success: true, control: result.rows[0] || null });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 11.8 PUT /api/documents/:id/retrieval-control - Cập nhật cấu hình kiểm soát truy xuất
router.put('/:id/retrieval-control', verifyToken, requirePermission('document.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { is_official_policy, is_restricted_general, retrieval_mode, disclaimer_text, is_active } = req.body;

    const docRes = await db.query('SELECT doc_code, branch_scope FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu' });
    const doc = docRes.rows[0];

    // Kiểm tra Tenant Boundary
    if (!isSuperAdminUser(req.user)) {
      const userBranch = getBranchForCompany(req.user.company_id);
      if (!userBranch || !doc.branch_scope || (!doc.branch_scope.includes(userBranch) && !doc.branch_scope.includes('all'))) {
        return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền cấu hình kiểm soát truy xuất cho văn bản ngoài công ty.' });
      }
    }

    const docCode = doc.doc_code;

    const upsertQuery = `
      INSERT INTO document_retrieval_controls (
        doc_version_id, doc_code, is_official_policy, is_restricted_general,
        retrieval_mode, disclaimer_text, is_active, created_by, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (doc_version_id) DO UPDATE SET
        is_official_policy = EXCLUDED.is_official_policy,
        is_restricted_general = EXCLUDED.is_restricted_general,
        retrieval_mode = EXCLUDED.retrieval_mode,
        disclaimer_text = EXCLUDED.disclaimer_text,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING *
    `;
    const result = await db.query(upsertQuery, [
      id, docCode,
      is_official_policy !== undefined ? is_official_policy : true,
      is_restricted_general !== undefined ? is_restricted_general : false,
      retrieval_mode || 'standard',
      disclaimer_text || '',
      is_active !== undefined ? is_active : true,
      req.user.username || 'admin'
    ]);

    await syncDocumentToQdrant(id).catch(e => console.error('Lỗi sync Qdrant sau retrieval-control:', e.message));

    return res.json({ success: true, control: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


// 12. GET /api/documents/:id/relationships - Lấy danh sách quan hệ của văn bản (Tenant & RBAC Hardened)
router.get('/:id/relationships', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Phân quyền RBAC: Chỉ ADMIN, HR hoặc SUPERADMIN mới có quyền xem thông tin quan hệ văn bản
    const userRole = String(req.user && req.user.role || '').toUpperCase();
    if (!['ADMIN', 'SUPER_ADMIN', 'SUPERADMIN', 'HR'].includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Chỉ tài khoản Quản trị viên hoặc HR mới có quyền xem danh sách quan hệ văn bản.'
      });
    }

    // 2. Kiểm tra văn bản tồn tại
    const isUuid = /^[0-9a-f-]{36}$/i.test(id);
    const docRes = await db.query(
      isUuid
        ? 'SELECT doc_version_id, doc_code, branch_scope, status FROM documents WHERE doc_version_id = $1'
        : 'SELECT doc_version_id, doc_code, branch_scope, status FROM documents WHERE document_id = $1 ORDER BY version DESC LIMIT 1',
      [id]
    );
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản yêu cầu.' });
    }
    const currentDoc = docRes.rows[0];
    const docVersionId = currentDoc.doc_version_id;

    // 3. Kiểm tra Tenant Boundary theo công ty của người dùng (từ JWT, không tin tưởng body/query)
    if (!isSuperAdminUser(req.user)) {
      const userCompany = req.user && req.user.company_id ? String(req.user.company_id).toUpperCase().trim() : null;
      const userBranch = getBranchForCompany(userCompany);
      if (!userCompany || !userBranch) {
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Tài khoản không có thông tin đơn vị hợp lệ.'
        });
      }
      const bScope = Array.isArray(currentDoc.branch_scope) ? currentDoc.branch_scope : [currentDoc.branch_scope];
      if (!bScope.includes(userBranch) && !bScope.includes('all')) {
        return res.status(403).json({
          success: false,
          error: '403 Forbidden: Bạn không có quyền truy cập quan hệ của văn bản thuộc đơn vị khác.'
        });
      }
    }

    // 4. Truy vấn danh sách quan hệ
    const query = `
      SELECT r.relationship_id, r.source_doc_version_id, r.target_doc_version_id,
             r.relation_type, r.approval_status, r.notes, r.created_by, r.approved_by,
             r.created_at, r.approved_at,
             sd.title AS source_title, sd.doc_code AS source_doc_code, sd.doc_number AS source_doc_number,
             sd.branch_scope AS source_branch_scope,
             td.title AS target_title, td.doc_code AS target_doc_code, td.doc_number AS target_doc_number,
             td.branch_scope AS target_branch_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      WHERE r.source_doc_version_id = $1 OR r.target_doc_version_id = $1
      ORDER BY r.created_at DESC
    `;
    const result = await db.query(query, [docVersionId]);
    let rows = result.rows;

    // 5. Kiểm tra quyền truy cập các tài liệu liên quan trong response (không tiết lộ văn bản thuộc tenant khác)
    if (!isSuperAdminUser(req.user)) {
      const userCompany = String(req.user.company_id).toUpperCase().trim();
      const userBranch = getBranchForCompany(userCompany);
      rows = rows.filter(r => {
        const otherBranch = (r.source_doc_version_id === docVersionId) ? r.target_branch_scope : r.source_branch_scope;
        const oScope = Array.isArray(otherBranch) ? otherBranch : [otherBranch];
        return oScope.includes(userBranch) || oScope.includes('all');
      });
    }

    // Làm sạch metadata nhạy cảm trước khi trả kết quả
    const sanitizedRows = rows.map(r => {
      const { source_branch_scope, target_branch_scope, ...cleanRel } = r;
      return cleanRel;
    });

    // Bổ sung danh mục điều khoản sửa đổi (AUD-APP-02)
    if (sanitizedRows.length > 0) {
      const relIds = sanitizedRows.map(r => r.relationship_id);
      try {
        const clausesRes = await db.query(
          'SELECT clause_rel_id, relationship_id, source_clause_ref, target_clause_ref, modification_type, summary_of_change, scope_status, created_at, updated_at FROM document_relationship_clauses WHERE relationship_id = ANY($1::uuid[]) ORDER BY created_at ASC',
          [relIds]
        );
        const clauseMap = {};
        for (const c of clausesRes.rows) {
          if (!clauseMap[c.relationship_id]) clauseMap[c.relationship_id] = [];
          clauseMap[c.relationship_id].push(c);
        }
        sanitizedRows.forEach(r => {
          r.clauses = clauseMap[r.relationship_id] || [];
        });
      } catch (clauseErr) {
        sanitizedRows.forEach(r => { r.clauses = []; });
      }
    }

    return res.json({ success: true, relationships: sanitizedRows });
  } catch (err) {
    console.error('Lỗi lấy quan hệ văn bản:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 13. POST /api/documents/:id/relationships - Thiết lập quan hệ văn bản (Hardened & Clause-Scope Supported)
router.post('/:id/relationships', verifyToken, requirePermission('document.edit'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { id } = req.params;
    const { target_doc_version_id, relation_type, notes = '', clauses = [] } = req.body;

    if (!target_doc_version_id) {
      return res.status(400).json({ success: false, error: 'Thiếu target_doc_version_id.' });
    }
    if (id === target_doc_version_id) {
      return res.status(400).json({ success: false, code: 'SELF_RELATION', error: 'Văn bản không thể tự thiết lập quan hệ với chính nó.' });
    }
    if (relation_type === 'independent') {
      return res.status(400).json({ success: false, code: 'INVALID_INDEPENDENT_LINK', error: 'Loại "independent" (văn bản độc lập) biểu thị không có quan hệ, không thể liên kết giữa hai văn bản.' });
    }
    if (!VALID_RELATION_TYPES.includes(relation_type)) {
      return res.status(400).json({ success: false, error: `Loại quan hệ "${relation_type}" không hợp lệ. Cho phép: ${VALID_RELATION_TYPES.join(', ')}` });
    }
    // Ghi chú nghiệp vụ / Căn cứ pháp lý (notes) là tùy chọn: chấp nhận null, chuỗi rỗng hoặc không truyền
    const trimmedNotes = (notes && typeof notes === 'string' && notes.trim()) ? notes.trim() : null;

    // Bắt buộc khai báo phạm vi điều khoản sửa đổi cho quan hệ amends (AUD-APP-02)
    if (relation_type === 'amends') {
      if (!Array.isArray(clauses) || clauses.length === 0) {
        return sendError(res, 'MISSING_CLAUSE_SCOPE', {
          error: 'Quan hệ sửa đổi (amends) bắt buộc phải khai báo ít nhất một điều khoản sửa đổi (Clause-level Scope).'
        }, req);
      }

      // Xác thực và kiểm tra trùng tham chiếu điều khoản (AUD-APP-02)
      const seenPairs = new Set();
      for (const cl of clauses) {
        const tRef = (cl.target_clause_ref || '').trim();
        const sRef = (cl.source_clause_ref || tRef).trim();
        if (!tRef) {
          return sendError(res, 'INVALID_CLAUSE_REFERENCE', {
            error: 'Mỗi điều khoản sửa đổi phải có tham chiếu điều khoản gốc cần sửa (target_clause_ref).'
          }, req);
        }
        const pairKey = `${sRef}:::${tRef}`;
        if (seenPairs.has(pairKey)) {
          return sendError(res, 'DUPLICATE_CLAUSE_REFERENCE', {
            error: `Phát hiện tham chiếu điều khoản bị trùng lặp trong cùng một quan hệ: "${sRef}" -> "${tRef}".`
          }, req);
        }
        seenPairs.add(pairKey);
      }
    }

    // Lấy thông tin hai văn bản
    const docsRes = await client.query(`
      SELECT doc_version_id, doc_code, branch_scope, status, effective_date
      FROM documents
      WHERE doc_version_id IN ($1, $2)
    `, [id, target_doc_version_id]);

    const srcDoc = docsRes.rows.find(d => d.doc_version_id === id);
    const tgtDoc = docsRes.rows.find(d => d.doc_version_id === target_doc_version_id);

    if (!srcDoc || !tgtDoc) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản nguồn hoặc văn bản đích.' });
    }

    // Kiểm tra Tenant Boundary
    const scopeCheck = checkRelationshipTenantScope(req.user, srcDoc.branch_scope, tgtDoc.branch_scope);
    if (!scopeCheck.allowed) {
      return res.status(scopeCheck.status || 403).json({ success: false, error: scopeCheck.error });
    }

    // Kiểm tra mâu thuẫn ngữ nghĩa và trùng lặp
    const contradictionCheck = await checkRelationshipContradiction(client, id, target_doc_version_id, relation_type);
    if (!contradictionCheck.valid) {
      return res.status(contradictionCheck.status || 409).json({
        success: false,
        code: contradictionCheck.code,
        error: contradictionCheck.error
      });
    }

    const isSuper = isSuperAdminUser(req.user);
    const status = isSuper ? 'approved' : 'pending_review';

    await client.query('BEGIN');

    const insertQuery = `
      INSERT INTO document_relationships
        (source_doc_version_id, target_doc_version_id, relation_type, approval_status, notes, created_by, approved_by, approved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const result = await client.query(insertQuery, [
      id,
      target_doc_version_id,
      relation_type,
      status,
      trimmedNotes,
      req.user.username,
      status === 'approved' ? req.user.username : null,
      status === 'approved' ? new Date() : null
    ]);
    const insertedRel = result.rows[0];

    // Lưu danh mục điều khoản sửa đổi vào bảng document_relationship_clauses (AUD-APP-02)
    const insertedClauses = [];
    if (Array.isArray(clauses) && clauses.length > 0) {
      for (const cl of clauses) {
        const tRef = (cl.target_clause_ref || cl.target_clause_reference || '').trim();
        const sRef = (cl.source_clause_ref || cl.source_clause_reference || tRef).trim();
        const rawMod = (cl.modification_type || cl.change_type || 'MODIFY').toUpperCase();
        const modType = ['REPLACE', 'REPLACES'].includes(rawMod) ? 'REPLACE' : (['SUPPLEMENT', 'SUPPLEMENTS'].includes(rawMod) ? 'SUPPLEMENT' : (['REPEAL', 'REPEALS'].includes(rawMod) ? 'REPEAL' : 'MODIFY'));
        if (tRef) {
          const clRes = await client.query(`
            INSERT INTO document_relationship_clauses
              (relationship_id, source_clause_ref, target_clause_ref, modification_type, summary_of_change, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `, [insertedRel.relationship_id, sRef, tRef, modType, cl.summary_of_change || cl.summary || null, req.user.username]);
          insertedClauses.push(clRes.rows[0]);
        }
      }
    }

    // Nếu quan hệ là 'supersedes' và được duyệt, đồng thời source đang active -> tự động chuyển target sang superseded
    if (relation_type === 'supersedes' && status === 'approved') {
      if (srcDoc.status === 'active') {
        const effDate = srcDoc.effective_date || new Date().toISOString().slice(0, 10);
        await client.query(
          `UPDATE documents SET status = 'superseded', expiry_date = $1::date - 1 WHERE doc_version_id = $2`,
          [effDate, target_doc_version_id]
        );
        syncDocumentToQdrant(target_doc_version_id).catch(() => {});
      }
    }

    await client.query('COMMIT');
    return res.status(201).json({ success: true, relationship: { ...insertedRel, clauses: insertedClauses } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi tạo quan hệ văn bản:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 13.1 GET /api/documents/relationships/:relId/clauses - Lấy danh mục điều khoản của một quan hệ (AUD-APP-02, TC-SEC-TENANT-01)
router.get('/relationships/:relId/clauses', verifyToken, async (req, res) => {
  try {
    const userRole = String(req.user && req.user.role || '').toUpperCase();
    if (!['ADMIN', 'HR', 'SUPERADMIN'].includes(userRole)) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Quyền của bạn không được phép xem điều khoản quan hệ.' });
    }
    const { relId } = req.params;

    // Kiểm tra phạm vi Tenant của quan hệ (VER-TENANT-01)
    const relRes = await db.query(`
      SELECT r.*, sd.branch_scope AS source_branch_scope, td.branch_scope AS target_branch_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      WHERE r.relationship_id = $1
    `, [relId]);

    if (relRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quan hệ văn bản.' });
    }
    const rel = relRes.rows[0];
    const scopeCheck = checkRelationshipTenantScope(req.user, rel.source_branch_scope, rel.target_branch_scope);
    if (!scopeCheck.allowed) {
      return res.status(scopeCheck.status || 403).json({ success: false, error: scopeCheck.error });
    }

    const clRes = await db.query(
      'SELECT clause_rel_id, relationship_id, source_clause_ref, target_clause_ref, modification_type, summary_of_change, scope_status, created_at, updated_at FROM document_relationship_clauses WHERE relationship_id = $1 ORDER BY created_at ASC',
      [relId]
    );
    return res.json({ success: true, clauses: clRes.rows });
  } catch (err) {
    console.error('Lỗi lấy điều khoản quan hệ:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 13.2 POST /api/documents/relationships/:relId/clauses - Thêm điều khoản sửa đổi vào quan hệ (AUD-APP-02, VER-CLA-03)
router.post('/relationships/:relId/clauses', verifyToken, requirePermission('document.edit'), async (req, res) => {
  try {
    const { relId } = req.params;
    const { source_clause_ref, source_clause_reference, target_clause_ref, target_clause_reference, modification_type, change_type, summary_of_change, summary } = req.body;

    const tRef = (target_clause_ref || target_clause_reference || '').trim();
    const sRef = (source_clause_ref || source_clause_reference || tRef).trim();

    if (!tRef) {
      return sendError(res, 'INVALID_CLAUSE_REFERENCE', { error: 'Thiếu tham chiếu điều khoản gốc (target_clause_ref).' }, req);
    }
    const rawMod = (modification_type || change_type || 'MODIFY').toUpperCase();
    const modType = ['REPLACE', 'REPLACES'].includes(rawMod) ? 'REPLACE' : (['SUPPLEMENT', 'SUPPLEMENTS'].includes(rawMod) ? 'SUPPLEMENT' : (['REPEAL', 'REPEALS'].includes(rawMod) ? 'REPEAL' : 'MODIFY'));
    const clauseSummary = summary_of_change || summary || null;

    // Kiểm tra quan hệ tồn tại và quyền truy cập
    const relRes = await db.query(`
      SELECT r.*, sd.branch_scope AS source_branch_scope, td.branch_scope AS target_branch_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      WHERE r.relationship_id = $1
    `, [relId]);

    if (relRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quan hệ văn bản.' });
    }
    const rel = relRes.rows[0];

    // Chặn sửa đổi quan hệ đã được duyệt (VER-CLA-03)
    if (rel.approval_status === 'approved') {
      return sendError(res, 'APPROVED_RELATIONSHIP_IMMUTABLE', {
        error: 'Không thể chỉnh sửa hoặc thêm điều khoản vào quan hệ đã được phê duyệt chính thức. Để thay đổi, vui lòng sử dụng quy trình thu hồi hoặc thay thế.'
      }, req);
    }

    const scopeCheck = checkRelationshipTenantScope(req.user, rel.source_branch_scope, rel.target_branch_scope);
    if (!scopeCheck.allowed) {
      return res.status(scopeCheck.status || 403).json({ success: false, error: scopeCheck.error });
    }

    // Kiểm tra trùng tham chiếu
    const existCheck = await db.query(
      'SELECT clause_rel_id FROM document_relationship_clauses WHERE relationship_id = $1 AND source_clause_ref = $2 AND target_clause_ref = $3',
      [relId, sRef, tRef]
    );
    if (existCheck.rows.length > 0) {
      return sendError(res, 'DUPLICATE_CLAUSE_REFERENCE', { error: `Tham chiếu điều khoản "${sRef}" -> "${tRef}" đã tồn tại trong quan hệ này.` }, req);
    }

    const insRes = await db.query(`
      INSERT INTO document_relationship_clauses
        (relationship_id, source_clause_ref, target_clause_ref, modification_type, summary_of_change, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [relId, sRef, tRef, modType, clauseSummary, req.user.username]);

    return res.status(201).json({ success: true, clause: insRes.rows[0] });
  } catch (err) {
    console.error('Lỗi thêm điều khoản quan hệ:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 13.3 DELETE /api/documents/relationships/:relId/clauses/:clauseId - Xóa một điều khoản khỏi quan hệ (AUD-APP-02, VER-CLA-03)
router.delete('/relationships/:relId/clauses/:clauseId', verifyToken, requirePermission('document.edit'), async (req, res) => {
  try {
    const { relId, clauseId } = req.params;
    const relRes = await db.query(`
      SELECT r.*, sd.branch_scope AS source_branch_scope, td.branch_scope AS target_branch_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      WHERE r.relationship_id = $1
    `, [relId]);

    if (relRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quan hệ văn bản.' });
    }
    const rel = relRes.rows[0];

    // Chặn xóa điều khoản của quan hệ đã được duyệt (VER-CLA-03)
    if (rel.approval_status === 'approved') {
      return sendError(res, 'APPROVED_RELATIONSHIP_IMMUTABLE', {
        error: 'Không thể xóa điều khoản của quan hệ đã được phê duyệt chính thức. Để thay đổi, vui lòng sử dụng quy trình thu hồi hoặc thay thế.'
      }, req);
    }

    const scopeCheck = checkRelationshipTenantScope(req.user, rel.source_branch_scope, rel.target_branch_scope);
    if (!scopeCheck.allowed) {
      return res.status(scopeCheck.status || 403).json({ success: false, error: scopeCheck.error });
    }

    await db.query('DELETE FROM document_relationship_clauses WHERE clause_rel_id = $1 AND relationship_id = $2', [clauseId, relId]);
    return res.json({ success: true, message: 'Đã xóa điều khoản sửa đổi.' });
  } catch (err) {
    console.error('Lỗi xóa điều khoản quan hệ:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 14. DELETE /api/documents/relationships/:relId - Xóa quan hệ văn bản (VER-CLA-03)
router.delete('/relationships/:relId', verifyToken, requirePermission('document.edit'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { relId } = req.params;
    const relRes = await client.query(`
      SELECT r.*, sd.doc_code AS source_code, sd.branch_scope AS source_branch_scope,
             td.doc_code AS target_code, td.branch_scope AS target_branch_scope
      FROM document_relationships r
      JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
      JOIN documents td ON r.target_doc_version_id = td.doc_version_id
      WHERE r.relationship_id = $1
    `, [relId]);

    if (relRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy quan hệ văn bản.' });
    }
    const rel = relRes.rows[0];

    // Chặn xóa quan hệ đã được duyệt chính thức (VER-CLA-03)
    if (rel.approval_status === 'approved') {
      return sendError(res, 'APPROVED_RELATIONSHIP_IMMUTABLE', {
        error: 'Không thể xóa quan hệ văn bản đã được phê duyệt chính thức. Để thay đổi, vui lòng sử dụng quy trình thu hồi hoặc thay thế.'
      }, req);
    }

    const scopeCheck = checkRelationshipTenantScope(req.user, rel.source_branch_scope, rel.target_branch_scope);
    if (!scopeCheck.allowed) {
      return res.status(scopeCheck.status || 403).json({ success: false, error: scopeCheck.error });
    }

    await client.query('BEGIN');
    // Xóa các điều khoản liên quan trước khi xóa quan hệ (bảo toàn ràng buộc ON DELETE RESTRICT)
    await client.query('DELETE FROM document_relationship_clauses WHERE relationship_id = $1', [relId]);
    await client.query('DELETE FROM document_relationships WHERE relationship_id = $1', [relId]);
    await client.query('COMMIT');

    return res.json({ success: true, message: 'Đã xóa quan hệ văn bản.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi xóa quan hệ văn bản:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 15. POST /api/documents/:id/detect-conflicts - Kiểm tra xung đột cho văn bản đã có trong hệ thống
router.post('/:id/detect-conflicts', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const docRes = await db.query('SELECT * FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản.' });
    }

    const doc = docRes.rows[0];
    if (!doc.content || doc.content.trim().length < 40) {
      try {
        const chunkRes = await db.query(
          `SELECT substring(string_agg(content, ' ' ORDER BY seq) from 1 for 15000) as full_text
           FROM chunks WHERE doc_version_id = $1`,
          [doc.doc_version_id]
        );
        if (chunkRes.rows.length > 0 && chunkRes.rows[0].full_text) {
          doc.content = chunkRes.rows[0].full_text;
        }
      } catch (chunkErr) {
        console.warn('[detect-conflicts/:id] Không thể nạp chunks:', chunkErr.message);
      }
    }
    const report = await detectPolicyConflicts(doc);
    return res.json(report);
  } catch (err) {
    console.error('Lỗi detect-conflicts:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 16. POST /api/documents/detect-conflicts - Kiểm tra xung đột cho văn bản dự thảo (trước khi lưu)
router.post('/detect-conflicts', verifyToken, upload.single('file'), async (req, res) => {
  try {
    let payload = { ...req.body };

    // 1. Phân giải các trường mảng gửi qua FormData (nếu có)
    ['branch_scope', 'department_scope', 'business_unit_scope', 'employee_group_scope', 'topics'].forEach(field => {
      if (typeof payload[field] === 'string') {
        try {
          const parsed = JSON.parse(payload[field]);
          if (Array.isArray(parsed)) payload[field] = parsed;
          else payload[field] = [parsed];
        } catch (_) {
          payload[field] = payload[field].split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    });

    // 2. Nếu có tệp đính kèm trong request: đọc nội dung tạm thời trong memory (< 80ms)
    // TUYỆT ĐỐI KHÔNG TẠO BẢN GHI DATABASE VÀ KHÔNG GHI ĐÈ TỆP TIN GỐC
    if (req.file && req.file.buffer) {
      const origName = req.file.originalname || '';
      const isPdf = req.file.mimetype === 'application/pdf' || origName.toLowerCase().endsWith('.pdf');
      const isDocx = req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || origName.toLowerCase().endsWith('.docx');

      // Tính SHA-256 tạm thời
      if (!payload.file_sha256) {
        payload.file_sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      }

      if (isPdf && PDFParseClass) {
        try {
          const parser = new PDFParseClass(new Uint8Array(req.file.buffer));
          await parser.load();
          const parsedRes = await parser.getText();
          if (parsedRes && parsedRes.text && parsedRes.text.trim()) {
            payload.content = parsedRes.text.trim();
          }
        } catch (pdfErr) {
          console.warn('[detect-conflicts] Lỗi đọc text PDF nhanh:', pdfErr.message);
        }
      } else if (isDocx) {
        try {
          const mammoth = require('mammoth');
          const { value: docxText } = await mammoth.extractRawText({ buffer: req.file.buffer });
          if (docxText && docxText.trim()) {
            payload.content = docxText.trim();
          }
        } catch (docxErr) {
          console.warn('[detect-conflicts] Lỗi đọc text DOCX:', docxErr.message);
        }
      } else {
        // Tệp văn bản thuần (Markdown, Text, HTML)
        try {
          const textContent = req.file.buffer.toString('utf8');
          if (textContent && textContent.trim()) {
            payload.content = textContent.trim();
          }
        } catch (txtErr) {
          console.warn('[detect-conflicts] Lỗi đọc text:', txtErr.message);
        }
      }
    }

    // 3. Nếu chưa có content nhưng có doc_version_id (tài liệu đã lưu nháp trước đó): Tái sử dụng chunks đã có
    if ((!payload.content || payload.content.trim().length < 40) && payload.doc_version_id) {
      try {
        const chunkRes = await db.query(
          `SELECT substring(string_agg(content, ' ' ORDER BY seq) from 1 for 15000) as full_text
           FROM chunks WHERE doc_version_id = $1`,
          [payload.doc_version_id]
        );
        if (chunkRes.rows.length > 0 && chunkRes.rows[0].full_text) {
          payload.content = chunkRes.rows[0].full_text;
        }
      } catch (chunkErr) {
        console.warn('[detect-conflicts] Không tìm thấy chunks của version:', chunkErr.message);
      }
    }

    const report = await detectPolicyConflicts(payload);
    return res.json(report);
  } catch (err) {
    console.error('Lỗi detect-conflicts payload:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 17. GET /api/documents/:id/chunks - Lấy danh sách chunks kèm nội dung trích lục
router.get('/:id/chunks', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const isUuid = /^[0-9a-f-]{36}$/i.test(id);
    const query = `
      SELECT c.chunk_id, c.section_path, c.content, c.seq,
             d.title, d.doc_number, d.doc_code, d.version, d.effective_date, d.branch_scope, d.department_scope
      FROM chunks c
      JOIN documents d USING (doc_version_id)
      WHERE ${isUuid ? 'd.doc_version_id = $1::uuid OR c.chunk_id = $1::uuid' : 'd.document_id = $1 OR d.doc_code = $1 OR d.doc_number = $1 OR d.document_family_id = $1'}
      ORDER BY c.seq ASC
      LIMIT 100
    `;
    const result = await db.query(query, [id]);
    return res.json({ success: true, chunks: result.rows });
  } catch (err) {
    console.error('Lỗi lấy chunks:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 18. POST /api/documents/reconcile-consistency - Đối soát Generation Leases và Vector Consistency
router.post('/reconcile-consistency', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Chỉ ADMIN mới có quyền kích hoạt đối soát tính nhất quán hệ thống.' });
    }
    const qdrantSync = require('../services/qdrantSyncService');
    const report = await qdrantSync.reconcileGenerationsAndVectors();
    return res.json({
      success: true,
      message: 'Hoàn tất đối soát tính nhất quán PostgreSQL - Qdrant và Durable Leases.',
      report
    });
  } catch (err) {
    console.error('Lỗi đối soát tính nhất quán:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// GET /api/documents/:id/ocr-status - Trạng thái tiến trình OCR & bóc tách tài liệu
router.get('/:id/ocr-status', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ success: false, error: 'Mã văn bản không hợp lệ.' });
  }
  try {
    const docRes = await db.query('SELECT doc_version_id, document_id, version, title, status, parse_quality, retry_count, active_generation_id, active_fencing_token, file_uri FROM documents WHERE doc_version_id = $1', [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu.' });
    }
    const doc = docRes.rows[0];
    const chunkCountRes = await db.query('SELECT COUNT(*)::int as count FROM chunks WHERE doc_version_id = $1', [id]);
    const leaseRes = await db.query('SELECT status, acquired_by, started_at, expires_at, updated_at, retry_reason FROM document_retry_leases WHERE doc_version_id = $1', [id]);

    let ocrJobStatus = 'PENDING';
    const chunkCount = chunkCountRes.rows[0].count;
    const lease = leaseRes.rows[0] || null;

    if (lease) {
      if (lease.status === 'PROCESSING') {
        const isExpired = new Date(lease.expires_at) < new Date();
        ocrJobStatus = isExpired ? 'FAILED' : 'PROCESSING';
      } else if (lease.status === 'PUBLISHED') {
        ocrJobStatus = chunkCount > 0 ? 'COMPLETED' : 'FAILED';
      } else if (lease.status === 'FAILED') {
        ocrJobStatus = doc.retry_count > 0 ? 'RETRYING' : 'FAILED';
      }
    } else if (chunkCount > 0) {
      ocrJobStatus = 'COMPLETED';
    }

    const pagesRes = await db.query('SELECT page_start, page_end, COUNT(*)::int as chunk_count FROM chunks WHERE doc_version_id = $1 GROUP BY page_start, page_end ORDER BY page_start', [id]);

    return res.json({
      success: true,
      doc_version_id: id,
      document_id: doc.document_id,
      title: doc.title,
      status: doc.status,
      ocr_status: ocrJobStatus,
      parse_quality: doc.parse_quality,
      total_chunks: chunkCount,
      pages: pagesRes.rows,
      lease: lease ? { status: lease.status, acquired_by: lease.acquired_by, expires_at: lease.expires_at, updated_at: lease.updated_at } : null
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
