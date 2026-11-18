/**
 * SOTRANS HUB — BI DATASET REGISTRY (PHASE 2.1 & 2.4)
 * 
 * Central Governance & Metadata Registry for Uploaded Datasets:
 * - Isolated file-level metadata tracking (zero intrusion into primary Postgres HR tables)
 * - Atomic persistence with in-memory caching
 * - Strict multi-tenant access control & IDOR prevention
 * - Fine-grained file sharing & instantaneous revocation
 * - Retention lifecycle management & orphan / incomplete dataset purger
 * - Non-sensitive audit logging
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STORAGE_DIR } = require('./biFileSecurityService');
const { logBiAuditEvent } = require('./biAuditLogger');

const REGISTRY_FILE = path.join(STORAGE_DIR, 'datasets_registry.json');

// In-memory cache map: fileId -> datasetMetadata
let registryCache = new Map();
let isInitialized = false;
let registryStamp = null;
let pendingWrites = 0;
let persistQueue = Promise.resolve();
let persistFailure = null;

/**
 * Load registry from disk into memory
 */
function initializeRegistry(force = false) {
  if (pendingWrites && !force) return;
  const stamp = fs.existsSync(REGISTRY_FILE) ? (() => { const s = fs.statSync(REGISTRY_FILE); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`; })() : null;
  if (isInitialized && stamp === registryStamp && !force) return;
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        registryCache = new Map(data.map((item) => [item.file_id, item]));
      }
    } else registryCache = new Map();
  } catch (e) {
    console.error('[BiDatasetRegistry] Error reading registry file:', e.message);
    const error = new Error('Không thể đọc registry BI. Vui lòng liên hệ quản trị viên.');
    error.code = 'REGISTRY_UNAVAILABLE'; error.status = 503;
    throw error;
  }
  registryStamp = stamp;
  isInitialized = true;
}

/**
 * Atomically persist registry cache to disk
 */
async function persistRegistry() {
  const snapshot = JSON.stringify(Array.from(registryCache.values()), null, 2);
  pendingWrites++;
  const operation = persistQueue.catch(() => {}).then(async () => {
    let tempFile;
    try {
    if (persistFailure) throw persistFailure;
    tempFile = `${REGISTRY_FILE}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tempFile, snapshot, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tempFile, REGISTRY_FILE);
    const s = fs.statSync(REGISTRY_FILE); registryStamp = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    } catch (e) {
      if (tempFile) await fs.promises.unlink(tempFile).catch(() => {});
      const error = new Error('Không thể lưu registry BI. Thay đổi chưa được xác nhận.');
      error.code = 'REGISTRY_WRITE_FAILED'; error.status = 503; persistFailure = error; throw error;
    } finally {
      pendingWrites--;
      if (!pendingWrites && persistFailure) {
        try { initializeRegistry(true); } finally { persistFailure = null; }
      }
    }
  });
  persistQueue = operation;
  return operation;
}

/**
 * Register a newly validated dataset
 */
async function registerDataset(metadata, userContext = null) {
  initializeRegistry();
  if (!metadata || !metadata.file_id) {
    throw new Error('Invalid metadata for dataset registration');
  }

  const datasetEntry = {
    ...metadata,
    uploaded_by: metadata.uploaded_by || (userContext ? String(userContext.user_id || '') : null),
    uploaded_by_username: metadata.uploaded_by_username || (userContext ? String(userContext.username || '') : null),
    shared_with: Array.isArray(metadata.shared_with) ? metadata.shared_with : [],
    created_at: metadata.created_at || metadata.upload_timestamp || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  registryCache.set(metadata.file_id, datasetEntry);
  if (metadata.processing_status === 'READY') {
    const datasetJsonPath = path.join(STORAGE_DIR, `${metadata.file_id}.dataset.json`);
    if (!fs.existsSync(datasetJsonPath)) {
      try {
        fs.writeFileSync(datasetJsonPath, JSON.stringify({ file_id: metadata.file_id, metadata, rows: [] }), 'utf8');
      } catch (_) {}
    }
  }
  await persistRegistry();

  if (userContext) {
    await logBiAuditEvent({
      event: 'FILE_UPLOAD',
      fileId: metadata.file_id,
      filename: metadata.original_filename,
      userContext,
      details: {
        file_size: metadata.file_size,
        file_type: metadata.file_type,
        company_id: metadata.company_id,
      },
    });
  }

  return datasetEntry;
}

/**
 * Retrieve dataset metadata by file_id
 */
function getDataset(fileId) {
  initializeRegistry();
  const dataset = registryCache.get(fileId);
  if (!dataset) return null;
  if (dataset.processing_status === 'READY' && !fs.existsSync(path.join(STORAGE_DIR, `${dataset.file_id}.dataset.json`))) {
    return { ...dataset, processing_status: 'MISSING_DATA' };
  }
  return dataset;
}

/**
 * Update dataset metadata (e.g., status, profile, error message)
 */
async function updateDataset(fileId, updates = {}) {
  initializeRegistry();
  const existing = registryCache.get(fileId);
  if (!existing) {
    throw new Error(`Dataset with file_id "${fileId}" not found in registry`);
  }

  const updated = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  registryCache.set(fileId, updated);
  await persistRegistry();
  return updated;
}

/**
 * Multi-Tenant & Role-Based Access Control Verification with Sharing & Revocation
 * @param {Object} dataset - The dataset metadata
 * @param {Object} userContext - The authenticated caller context
 * @param {string} [requiredPermission='view'] - 'view' (preview/metadata) or 'query' (analytical calculation)
 */
function canUserAccessDataset(dataset, userContext, requiredPermission = 'view') {
  if (!userContext || (!userContext.user_id && !userContext.userId)) {
    return { allowed: false, reason: 'UNAUTHENTICATED' };
  }

  if (!dataset || typeof dataset !== 'object' || !dataset.file_id) {
    return { allowed: false, reason: 'DATASET_MISSING' };
  }

  const userStatus = String(userContext.status || '').toUpperCase();
  if (userStatus && userStatus !== 'ACTIVE') {
    return { allowed: false, reason: 'ACCOUNT_INACTIVE' };
  }
  if (userContext.is_active === false || userContext.isActive === false) {
    return { allowed: false, reason: 'ACCOUNT_INACTIVE' };
  }

  if (['FAILED', 'MISSING_DATA'].includes(dataset.processing_status)) {
    return { allowed: false, reason: 'DATASET_UNAVAILABLE' };
  }

  if (dataset.processing_status === 'EXPIRED' || dataset.processing_status === 'DELETED') {
    return { allowed: false, reason: 'DATASET_EXPIRED_OR_DELETED' };
  }

  const expiry = Date.parse(dataset.retention_expiry);
  if (dataset.retention_expiry && (!Number.isFinite(expiry) || expiry <= Date.now())) {
    return { allowed: false, reason: 'DATASET_EXPIRED' };
  }

  if (requiredPermission === 'query' && dataset.processing_status && dataset.processing_status !== 'READY') {
    return { allowed: false, reason: 'DATASET_NOT_READY' };
  }

  const userRole = String(userContext.role || '').toUpperCase();
  const userCompany = String(userContext.company_id || '').toUpperCase();
  const datasetCompany = String(dataset.company_id || '').toUpperCase();
  const userIdStr = String(userContext.user_id || userContext.userId || '');
  const uploaderStr = String(dataset.uploaded_by || '');
  const username = String(userContext.username || '').toLowerCase();
  const uploaderUsername = String(dataset.uploaded_by_username || '').toLowerCase();

  // 1. ADMIN role: can access any active non-expired dataset across all companies with full query permission
  if (userRole === 'ADMIN') {
    return { allowed: true, permission: 'query', role: 'ADMIN' };
  }

  // 2. File Owner: full query access for active non-expired dataset
  const isOwner = (userIdStr && userIdStr === uploaderStr) || (username && username === uploaderUsername);
  if (isOwner) {
    return { allowed: true, permission: 'query', role: 'OWNER' };
  }

  // Helper: Check shared_with entries for matching grants
  const sharedList = Array.isArray(dataset.shared_with) ? dataset.shared_with : [];
  const matchingShare = sharedList.find((s) => {
    if (!s || !s.target_type || !s.target_id) return false;
    if (s.revoked === true || s.status === 'REVOKED' || s.is_active === false) return false;
    if (s.expires_at && Date.parse(s.expires_at) <= Date.now()) return false;

    const targetType = String(s.target_type).toLowerCase();
    const targetId = String(s.target_id);

    if (targetType === 'user') {
      return targetId === userIdStr || targetId.toLowerCase() === username;
    }
    if (targetType === 'role') {
      return targetId.toUpperCase() === userRole;
    }
    if (targetType === 'company') {
      return targetId.toUpperCase() === userCompany;
    }
    return false;
  });

  // 3. Cross-company boundary check
  if (userCompany !== datasetCompany) {
    if (matchingShare) {
      // Explicit cross-company share granted
      const grantedPermission = matchingShare.permission || 'view';
      if (requiredPermission === 'query' && grantedPermission === 'view') {
        return {
          allowed: false,
          reason: 'INSUFFICIENT_PERMISSION: Bạn chỉ có quyền xem (view), không có quyền truy vấn (query).',
        };
      }
      return { allowed: true, permission: grantedPermission, role: 'SHARED' };
    }
    return {
      allowed: false,
      reason: 'TENANT_MISMATCH: Người dùng không thuộc công ty/đơn vị sở hữu tệp này.',
    };
  }

  // 4. Within same company: HR role has default query access to company files
  if (userRole === 'HR') {
    return { allowed: true, permission: 'query', role: 'HR' };
  }

  // 5. Within same company: EMPLOYEE / USER role
  if (matchingShare) {
    const grantedPermission = matchingShare.permission || 'view';
    if (requiredPermission === 'query' && grantedPermission === 'view') {
      return {
        allowed: false,
        reason: 'INSUFFICIENT_PERMISSION: Bạn chỉ có quyền xem (view), không có quyền truy vấn (query).',
      };
    }
    return { allowed: true, permission: grantedPermission, role: 'SHARED' };
  }

  return {
    allowed: false,
    reason: 'INSUFFICIENT_PERMISSIONS: Bạn không có quyền truy cập bộ dữ liệu này.',
  };
}

/**
 * Share a dataset with a user, role, or company
 * Only dataset owner or ADMIN can share
 */
async function shareDataset(fileId, shareSpec = {}, userContext) {
  initializeRegistry();
  const dataset = registryCache.get(fileId);
  if (!dataset) {
    const err = new Error('Không tìm thấy bộ dữ liệu.');
    err.status = 404;
    throw err;
  }

  const access = canUserAccessDataset(dataset, userContext, 'view');
  if (!access.allowed) {
    const err = new Error(access.reason || 'Quyền truy cập bị từ chối.');
    err.status = 403;
    throw err;
  }

  const userRole = String(userContext.role || '').toUpperCase();
  const userIdStr = String(userContext.user_id || userContext.userId || '');
  const uploaderStr = String(dataset.uploaded_by || '');
  const username = String(userContext.username || '').toLowerCase();
  const uploaderUsername = String(dataset.uploaded_by_username || '').toLowerCase();
  const isOwner = (userIdStr && userIdStr === uploaderStr) || (username && username === uploaderUsername);

  if (userRole !== 'ADMIN' && !isOwner) {
    const err = new Error('Chỉ người tải lên hoặc Quản trị viên (ADMIN) mới có quyền chia sẻ tệp này.');
    err.status = 403;
    throw err;
  }

  const targetType = String(shareSpec.target_type || 'user').toLowerCase();
  const targetId = String(shareSpec.target_id || '').trim();
  const permission = String(shareSpec.permission || 'view').toLowerCase();

  if (!['user', 'role', 'company'].includes(targetType)) {
    const err = new Error('target_type không hợp lệ. Cho phép: "user", "role", "company".');
    err.status = 400;
    throw err;
  }
  if (!targetId) {
    const err = new Error('target_id không được để trống.');
    err.status = 400;
    throw err;
  }
  if (!['view', 'query'].includes(permission)) {
    const err = new Error('permission không hợp lệ. Cho phép: "view", "query".');
    err.status = 400;
    throw err;
  }

  if (!Array.isArray(dataset.shared_with)) {
    dataset.shared_with = [];
  }

  // Remove existing share with same target to overwrite
  dataset.shared_with = dataset.shared_with.filter(
    (s) => !(s.target_type === targetType && String(s.target_id).toLowerCase() === targetId.toLowerCase())
  );

  const shareEntry = {
    share_id: crypto.randomUUID(),
    target_type: targetType,
    target_id: targetId,
    permission,
    shared_by: username || userIdStr,
    shared_at: new Date().toISOString(),
  };

  dataset.shared_with.push(shareEntry);
  dataset.updated_at = new Date().toISOString();

  registryCache.set(fileId, dataset);
  await persistRegistry();

  await logBiAuditEvent({
    event: 'DATASET_SHARE',
    fileId,
    filename: dataset.original_filename,
    userContext,
    details: {
      target_type: targetType,
      target_id: targetId,
      permission,
    },
  });

  return {
    success: true,
    file_id: fileId,
    share: shareEntry,
    shared_with: dataset.shared_with,
  };
}

/**
 * Revoke sharing for a dataset
 * Only dataset owner or ADMIN can revoke
 */
async function revokeDatasetShare(fileId, targetIdOrShareId, userContext) {
  initializeRegistry();
  const dataset = registryCache.get(fileId);
  if (!dataset) {
    const err = new Error('Không tìm thấy bộ dữ liệu.');
    err.status = 404;
    throw err;
  }

  const access = canUserAccessDataset(dataset, userContext, 'view');
  if (!access.allowed) {
    const err = new Error(access.reason || 'Quyền truy cập bị từ chối.');
    err.status = 403;
    throw err;
  }

  const userRole = String(userContext.role || '').toUpperCase();
  const userIdStr = String(userContext.user_id || userContext.userId || '');
  const uploaderStr = String(dataset.uploaded_by || '');
  const username = String(userContext.username || '').toLowerCase();
  const uploaderUsername = String(dataset.uploaded_by_username || '').toLowerCase();
  const isOwner = (userIdStr && userIdStr === uploaderStr) || (username && username === uploaderUsername);

  if (userRole !== 'ADMIN' && !isOwner) {
    const err = new Error('Chỉ người tải lên hoặc Quản trị viên (ADMIN) mới có quyền thu hồi chia sẻ tệp này.');
    err.status = 403;
    throw err;
  }

  const initialCount = Array.isArray(dataset.shared_with) ? dataset.shared_with.length : 0;
  const needle = String(targetIdOrShareId).toLowerCase();

  dataset.shared_with = (dataset.shared_with || []).filter(
    (s) => s.share_id !== targetIdOrShareId && String(s.target_id).toLowerCase() !== needle
  );

  const revokedCount = initialCount - dataset.shared_with.length;
  dataset.updated_at = new Date().toISOString();

  registryCache.set(fileId, dataset);
  await persistRegistry();

  await logBiAuditEvent({
    event: 'DATASET_REVOKE_SHARE',
    fileId,
    filename: dataset.original_filename,
    userContext,
    details: {
      target_id: targetIdOrShareId,
      revoked_count: revokedCount,
    },
  });

  return {
    success: true,
    file_id: fileId,
    revoked_count: revokedCount,
    shared_with: dataset.shared_with,
  };
}

/**
 * List active datasets accessible to the user
 */
function listDatasetsForUser(userContext, options = {}) {
  initializeRegistry();
  if (!userContext || (!userContext.user_id && !userContext.userId)) {
    return [];
  }

  const userRole = String(userContext.role || '').toUpperCase();
  const userCompany = String(userContext.company_id || '').toUpperCase();
  const userIdStr = String(userContext.user_id || userContext.userId || '');
  const username = String(userContext.username || '').toLowerCase();

  if (userContext.status && userContext.status !== 'ACTIVE') return [];
  const all = Array.from(registryCache.keys()).map(getDataset);

  return all.filter((item) => {
    // Exclude deleted or expired
    if (item.processing_status === 'EXPIRED' || item.processing_status === 'DELETED') {
      return false;
    }
    if (item.retention_expiry && (!Number.isFinite(Date.parse(item.retention_expiry)) || Date.parse(item.retention_expiry) <= Date.now())) return false;

    if (userRole === 'ADMIN') {
      if (options.company_id && options.company_id !== 'ALL') {
        return item.company_id === options.company_id;
      }
      return true;
    }

    const access = canUserAccessDataset(item, userContext, 'view');
    return access.allowed;
  });
}

/**
 * Delete a dataset and its isolated physical files
 */
async function deleteDataset(fileId, userContext) {
  initializeRegistry();
  const dataset = registryCache.get(fileId);
  if (!dataset) {
    const err = new Error('Không tìm thấy bộ dữ liệu.');
    err.status = 404;
    throw err;
  }

  const access = canUserAccessDataset(dataset, userContext, 'view');
  if (!access.allowed) {
    const err = new Error(access.reason || 'Quyền truy cập bị từ chối.');
    err.status = 403;
    throw err;
  }

  // Only uploader or ADMIN can delete
  const userRole = String(userContext.role || '').toUpperCase();
  const userIdStr = String(userContext.user_id || userContext.userId || '');
  const uploaderStr = String(dataset.uploaded_by || '');
  const username = String(userContext.username || '').toLowerCase();
  const uploaderUsername = String(dataset.uploaded_by_username || '').toLowerCase();
  const isOwner = (userIdStr && userIdStr === uploaderStr) || (username && username === uploaderUsername);

  if (userRole !== 'ADMIN' && !isOwner) {
    const err = new Error('Chỉ người tải lên hoặc Quản trị viên (ADMIN) mới có quyền xóa bộ dữ liệu này.');
    err.status = 403;
    throw err;
  }

  // Mark status DELETED
  dataset.processing_status = 'DELETED';
  dataset.updated_at = new Date().toISOString();

  // Remove physical files
  try {
    if (dataset.storage_path && fs.existsSync(dataset.storage_path)) {
      await fs.promises.unlink(dataset.storage_path);
    }
    const datasetJsonPath = path.join(STORAGE_DIR, `${fileId}.dataset.json`);
    if (fs.existsSync(datasetJsonPath)) {
      await fs.promises.unlink(datasetJsonPath);
    }
  } catch (e) {
    console.warn(`[BiDatasetRegistry] Warning while deleting files for ${fileId}:`, e.message);
  }

  registryCache.delete(fileId);
  await persistRegistry();

  await logBiAuditEvent({
    event: 'DATASET_DELETE',
    fileId,
    filename: dataset.original_filename,
    userContext,
    details: {
      company_id: dataset.company_id,
    },
  });

  return { success: true, file_id: fileId };
}

/**
 * Retention Cleanup: Purge expired datasets and remove their physical files (Default 7-day policy)
 */
async function cleanupExpiredDatasets() {
  initializeRegistry();
  const now = Date.now();
  let purgedCount = 0;

  for (const [fileId, dataset] of registryCache.entries()) {
    if (dataset.retention_expiry) {
      const expiryTime = Date.parse(dataset.retention_expiry);
      if (!isNaN(expiryTime) && expiryTime <= now) {
        // Expired!
        try {
          if (dataset.storage_path && fs.existsSync(dataset.storage_path)) {
            await fs.promises.unlink(dataset.storage_path);
          }
          const datasetJsonPath = path.join(STORAGE_DIR, `${fileId}.dataset.json`);
          if (fs.existsSync(datasetJsonPath)) {
            await fs.promises.unlink(datasetJsonPath);
          }
        } catch (_) {}

        dataset.processing_status = 'EXPIRED';
        registryCache.delete(fileId);
        purgedCount++;

        await logBiAuditEvent({
          event: 'RETENTION_PURGE',
          fileId,
          filename: dataset.original_filename,
          userContext: { username: 'SYSTEM_RETENTION_CRON', role: 'SYSTEM', company_id: dataset.company_id },
          details: {
            retention_expiry: dataset.retention_expiry,
          },
        });
      }
    }
  }

  if (purgedCount > 0) {
    await persistRegistry();
    console.log(`[BiDatasetRegistry] Purged ${purgedCount} expired datasets.`);
  }

  return { purgedCount };
}

/**
 * Orphan & Incomplete Cleanup:
 * 1. Clean up datasets stuck in 'PROCESSING' for > 15 minutes (stuck intake)
 * 2. Clean up orphan physical files in STORAGE_DIR that have no entry in datasets_registry.json
 * 3. Clean up registry entries whose physical data files are missing
 */
async function cleanupOrphanAndIncompleteDatasets(maxStuckAgeMs = 15 * 60 * 1000) {
  initializeRegistry();
  const now = Date.now();
  let purgedIncomplete = 0;
  let purgedOrphans = 0;
  let purgedBroken = 0;

  // 1. Incomplete / stuck datasets
  for (const [fileId, dataset] of registryCache.entries()) {
    if (dataset.processing_status === 'PROCESSING') {
      const createdAt = Date.parse(dataset.created_at || dataset.upload_timestamp || 0);
      if (now - createdAt > maxStuckAgeMs) {
        try {
          if (dataset.storage_path && fs.existsSync(dataset.storage_path)) {
            await fs.promises.unlink(dataset.storage_path);
          }
          const datasetJsonPath = path.join(STORAGE_DIR, `${fileId}.dataset.json`);
          if (fs.existsSync(datasetJsonPath)) {
            await fs.promises.unlink(datasetJsonPath);
          }
        } catch (_) {}
        registryCache.delete(fileId);
        purgedIncomplete++;
      }
    }
  }

  // 2. Orphan physical files on disk
  if (fs.existsSync(STORAGE_DIR)) {
    try {
      const diskFiles = await fs.promises.readdir(STORAGE_DIR);
      for (const f of diskFiles) {
        if (f === 'datasets_registry.json' || f === 'bi_audit.log' || f.endsWith('.tmp')) continue;

        const fullPath = path.join(STORAGE_DIR, f);
        try {
          const stat = await fs.promises.stat(fullPath);
          // Only check files older than 10 minutes to avoid race conditions with live uploads
          if (now - stat.mtimeMs > 10 * 60 * 1000) {
            let fileIdCandidate = null;
            if (f.endsWith('.dataset.json')) {
              fileIdCandidate = f.replace('.dataset.json', '');
            } else if (/^[0-9a-f-]{36}\.(?:xlsx|xls|csv|data)$/i.test(f)) {
              fileIdCandidate = f.slice(0, f.lastIndexOf('.'));
            }

            if (fileIdCandidate && !registryCache.has(fileIdCandidate)) {
              await fs.promises.unlink(fullPath);
              purgedOrphans++;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 3. Broken registry entries (missing physical json file for READY datasets)
  for (const [fileId, dataset] of registryCache.entries()) {
    if (dataset.processing_status === 'READY') {
      const datasetJsonPath = path.join(STORAGE_DIR, `${fileId}.dataset.json`);
      if (!fs.existsSync(datasetJsonPath)) {
        dataset.processing_status = 'MISSING_DATA';
        purgedBroken++;
      }
    }
  }

  if (purgedIncomplete > 0 || purgedOrphans > 0 || purgedBroken > 0) {
    await persistRegistry();
    console.log('[BiDatasetRegistry] Orphan cleanup completed:', {
      purgedIncomplete,
      purgedOrphans,
      purgedBroken,
    });
  }

  return { purgedIncomplete, purgedOrphans, purgedBroken };
}

module.exports = {
  registerDataset,
  getDataset,
  updateDataset,
  deleteDataset,
  shareDataset,
  revokeDatasetShare,
  listDatasetsForUser,
  canUserAccessDataset,
  cleanupExpiredDatasets,
  cleanupOrphanAndIncompleteDatasets,
  initializeRegistry,
  persistRegistry,
};
