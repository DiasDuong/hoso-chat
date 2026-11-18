/**
 * SOTRANS HUB — BI FILE SECURITY SERVICE (PHASE 2.1)
 * 
 * Secure File Intake Engine for Uploaded Spreadsheet BI:
 * - Magic byte (file signature) verification
 * - MIME type & extension cross-validation (.xlsx, .xls, .csv)
 * - File size boundary enforcement (default max 25MB)
 * - Path traversal defense & filename sanitization
 * - ZIP bomb / decompression expansion ratio guard
 * - Formula injection (DDE / CSV Formula Injection) defense
 * - Isolated non-public storage with UUID filenames
 * - Cryptographic checksum (SHA-256) & retention metadata
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration constants
const MAX_FILE_SIZE_BYTES = parseInt(process.env.BI_FILE_MAX_SIZE_BYTES, 10) || 25 * 1024 * 1024; // 25 MB
const MAX_UNCOMPRESSED_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB max uncompressed
const MAX_ZIP_RATIO = 25; // 25:1 max compression ratio
const DEFAULT_RETENTION_DAYS = 7;

// Dedicated non-public storage directory
const DEFAULT_STORAGE_DIR = path.resolve(__dirname, '..', 'storage', 'bi_datasets');
const STORAGE_DIR = process.env.BI_STORAGE_DIR ? path.resolve(process.env.BI_STORAGE_DIR) : DEFAULT_STORAGE_DIR;

function assertSafeStorageDir(targetDir) {
  const isTest = process.env.NODE_ENV === 'test' || process.env.ISOLATION_HARNESS === 'true';
  if (!isTest) return;

  const normalized = path.resolve(targetDir).toLowerCase().replace(/\\/g, '/');
  const forbidden1 = 'd:/hoso-chat/storage';
  const forbidden2 = 'd:/hoso-chat/auth-service/storage';

  if (normalized.startsWith(forbidden1) || normalized.startsWith(forbidden2)) {
    const err = new Error(`[FATAL STORAGE GUARD] Test execution attempted to access production storage directory: ${targetDir}`);
    err.code = 'ERR_PRODUCTION_STORAGE_VIOLATION';
    throw err;
  }
}

assertSafeStorageDir(STORAGE_DIR);

// Ensure storage directory exists
try {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  }
} catch (e) {
  console.error('[BiFileSecurity] Failed to initialize storage dir:', e.message);
}

// Allowed MIME types per extension
const ALLOWED_MIME_TYPES = {
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream',
    'application/zip',
    'application/x-zip-compressed',
  ],
  '.xls': [
    'application/vnd.ms-excel',
    'application/msexcel',
    'application/x-msexcel',
    'application/octet-stream',
  ],
  '.csv': [
    'text/csv',
    'text/plain',
    'application/csv',
    'text/x-csv',
    'application/vnd.ms-excel',
    'application/octet-stream',
  ],
};

// Known binary executable & unsafe signatures to block in CSV files
const BLOCKED_BINARY_SIGNATURES = [
  { name: 'Windows PE / EXE', signature: Buffer.from([0x4D, 0x5A]) }, // MZ
  { name: 'Linux ELF', signature: Buffer.from([0x7F, 0x45, 0x4C, 0x46]) }, // ELF
  { name: 'Java Class / Mach-O', signature: Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]) },
  { name: 'PDF', signature: Buffer.from([0x25, 0x50, 0x44, 0x46]) }, // %PDF
  { name: 'ZIP archive', signature: Buffer.from([0x50, 0x4B, 0x03, 0x04]) },
  { name: 'OLE2 / Office binary', signature: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]) },
  { name: 'GZIP', signature: Buffer.from([0x1F, 0x8B]) },
  { name: 'BZIP2', signature: Buffer.from([0x42, 0x5A, 0x68]) },
  { name: 'XZ', signature: Buffer.from([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) },
  { name: 'PNG Image', signature: Buffer.from([0x89, 0x50, 0x4E, 0x47]) },
  { name: 'JPEG Image', signature: Buffer.from([0xFF, 0xD8, 0xFF]) },
];

/**
 * Custom Error Class for File Security Violations
 */
class FileSecurityError extends Error {
  constructor(message, code = 'FILE_SECURITY_ERROR', status = 400) {
    super(message);
    this.name = 'FileSecurityError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Sanitize filename to prevent directory traversal and special character attacks
 */
function sanitizeFilename(originalName) {
  if (!originalName || typeof originalName !== 'string') {
    return 'uploaded_dataset.xlsx';
  }
  // Strip path separators and null bytes
  let safeName = path.basename(originalName).replace(/\0/g, '');
  // Remove control characters and non-printable characters
  safeName = safeName.replace(/[\x00-\x1F\x7F]/g, '');
  // Remove dangerous path traversal tokens
  safeName = safeName.replace(/\.{2,}/g, '.');
  // Trim spaces and dots from ends
  safeName = safeName.trim().replace(/^\.+|\.+$/g, '');
  // Default fallback if name is stripped empty
  if (!safeName) {
    safeName = `dataset_${Date.now()}`;
  }
  // Truncate length if excessively long
  if (safeName.length > 200) {
    const ext = path.extname(safeName);
    const base = safeName.slice(0, 190);
    safeName = `${base}${ext}`;
  }
  return safeName;
}

/**
 * Verify Magic Bytes (File Signatures)
 */
function verifyMagicBytes(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new FileSecurityError('Tệp không hợp lệ hoặc rỗng.', 'EMPTY_OR_CORRUPTED_FILE');
  }

  if (ext === '.xlsx') {
    // XLSX is a ZIP container: standard magic bytes PK\x03\x04 (0x50 0x4B 0x03 0x04)
    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
    if (!isZip) {
      throw new FileSecurityError(
        'Định dạng tệp .xlsx không hợp lệ (sai chữ ký file ZIP OpenXML).',
        'INVALID_XLSX_SIGNATURE'
      );
    }
  } else if (ext === '.xls') {
    // XLS is an OLE2 Compound Binary document: 0xD0 0xCF 0x11 0xE0 0xA1 0xB1 0x1A 0xE1
    if (buffer.length < 8) {
      throw new FileSecurityError('Tệp .xls quá nhỏ hoặc bị hỏng.', 'CORRUPTED_XLS_FILE');
    }
    const isOle2 =
      buffer[0] === 0xD0 &&
      buffer[1] === 0xCF &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xE0 &&
      buffer[4] === 0xA1 &&
      buffer[5] === 0xB1 &&
      buffer[6] === 0x1A &&
      buffer[7] === 0xE1;
    if (!isOle2) {
      throw new FileSecurityError(
        'Định dạng tệp .xls không hợp lệ (sai chữ ký file nhị phân OLE2).',
        'INVALID_XLS_SIGNATURE'
      );
    }
  } else if (ext === '.csv') {
    // CSV must be plain text. Check against known binary executable/archive signatures
    for (const binSig of BLOCKED_BINARY_SIGNATURES) {
      if (buffer.length >= binSig.signature.length) {
        if (buffer.subarray(0, binSig.signature.length).equals(binSig.signature)) {
          throw new FileSecurityError(
            `Tệp CSV chứa chữ ký nhị phân không an toàn (${binSig.name}). Tệp bị từ chối.`,
            'DISGUISED_BINARY_FILE'
          );
        }
      }
    }

    // Inspect first 8KB for null bytes (null byte denotes binary file)
    const sampleSize = Math.min(buffer.length, 8192);
    for (let i = 0; i < sampleSize; i++) {
      if (buffer[i] === 0x00) {
        throw new FileSecurityError(
          'Tệp CSV chứa ký tự nhị phân (null byte). Chỉ chấp nhận tệp văn bản UTF-8 hoặc ASCII thuần túy.',
          'BINARY_CONTENT_IN_CSV'
        );
      }
    }

    // Check for disguised HTML / Script
    const sampleText = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8').trim().toLowerCase();
    if (
      sampleText.startsWith('<!doctype') ||
      sampleText.startsWith('<html') ||
      sampleText.startsWith('<script') ||
      sampleText.startsWith('<svg') ||
      sampleText.startsWith('<?xml')
    ) {
      throw new FileSecurityError(
        'Tệp được ngụy trang dưới định dạng HTML/SVG/XML kịch bản web độc hại.',
        'MALICIOUS_SCRIPT_CONTENT'
      );
    }
  }
}

/**
 * Check ZIP Decompression Expansion Ratio (ZIP Bomb Protection)
 * Inspects Central Directory headers without memory-expensive full unzipping
 */
function verifyZipExpansionRatio(buffer) {
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let entryCount = 0;

  // Search for central directory header signatures: PK\x01\x02 (0x50 0x4B 0x01 0x02)
  for (let i = 0; i < buffer.length - 30; i++) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4B && buffer[i + 2] === 0x01 && buffer[i + 3] === 0x02) {
      entryCount++;
      // Compressed size is 4 bytes at offset +20
      const compSize = buffer.readUInt32LE(i + 20);
      // Uncompressed size is 4 bytes at offset +24
      const uncompSize = buffer.readUInt32LE(i + 24);

      totalCompressed += compSize;
      totalUncompressed += uncompSize;

      // Early rejection if uncompressed size exceeds absolute threshold
      if (totalUncompressed > MAX_UNCOMPRESSED_ZIP_BYTES) {
        throw new FileSecurityError(
          `Dung lượng giải nén vượt quá ngưỡng cho phép (${Math.round(totalUncompressed / 1024 / 1024)}MB > ${MAX_UNCOMPRESSED_ZIP_BYTES / 1024 / 1024}MB). Nguy cơ ZIP Bomb.`,
          'ZIP_BOMB_EXCESSIVE_SIZE'
        );
      }
    }
  }

  // Calculate ratio against compressed buffer length
  const ratio = totalUncompressed / Math.max(1, buffer.length);
  if (ratio > MAX_ZIP_RATIO && totalUncompressed > 5 * 1024 * 1024) {
    throw new FileSecurityError(
      `Tỷ lệ giải nén nén tệp quá cao (${ratio.toFixed(1)}:1 > ${MAX_ZIP_RATIO}:1). Tệp bị từ chối để chống tấn công cạn kiệt tài nguyên (ZIP Bomb).`,
      'ZIP_BOMB_HIGH_RATIO'
    );
  }

  return { entryCount, totalCompressed, totalUncompressed, ratio };
}

/**
 * Formula Injection Sanitization (CSV / Excel Formula Injection / DDE attack)
 * Cells starting with =, +, -, @, \t, \r are escaped with a leading single quote (')
 * Crucial: Plain negative/positive numeric literals (e.g. -100, -250.5, +50, -1,234.56)
 * must remain numeric data and not be treated as formula injection.
 */
function sanitizeFormulaInjection(value) {
  if (typeof value !== 'string') return { sanitized: value, wasFormula: false };
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    const firstChar = trimmed[0];
    if (firstChar === '=' || firstChar === '@' || firstChar === '\t' || firstChar === '\r') {
      return { sanitized: `'${value}`, wasFormula: true };
    }
    if (firstChar === '+' || firstChar === '-') {
      // Allow legitimate plain numbers: e.g. -100, -250.5, +50, -1.000.000, -1,234.56, -15%
      const isPlainNumber =
        /^[-+]?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s*[%₫$€£¥]?$/.test(trimmed) ||
        /^[-+]?\s*\d+(?:[.,]\d+)?\s*[%₫$€£¥]?$/.test(trimmed);
      if (!isPlainNumber) {
        return { sanitized: `'${value}`, wasFormula: true };
      }
    }
  }
  return { sanitized: value, wasFormula: false };
}

/**
 * Full Intake Verification & Storage Pipeline
 * @param {Object} file - Multer file object { buffer, originalname, mimetype, size }
 * @param {Object} userContext - Authenticated user context { user_id, username, role, company_id }
 * @returns {Promise<Object>} Metadata of validated & stored dataset
 */
async function validateAndStoreIntakeFile(file, userContext = {}) {
  // 1. Basic Presence Validation
  if (!file || !file.buffer) {
    throw new FileSecurityError('Không nhận được dữ liệu tệp đính kèm.', 'NO_FILE_ATTACHED', 400);
  }

  // 2. Authentication Enforcement
  if (!userContext || !userContext.user_id) {
    throw new FileSecurityError('Yêu cầu đăng nhập để tải lên tệp phân tích dữ liệu.', 'UNAUTHENTICATED', 401);
  }

  const rawFilename = file.originalname || 'dataset';
  const cleanFilename = sanitizeFilename(rawFilename);
  const ext = path.extname(cleanFilename).toLowerCase();

  // 3. Extension Whitelist
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    throw new FileSecurityError(
      `Định dạng tệp "${ext}" không được hỗ trợ. Chỉ chấp nhận các định dạng bảng tính: .xlsx, .xls, .csv.`,
      'UNSUPPORTED_FILE_TYPE',
      400
    );
  }

  // 4. File Size Boundary Check
  const bufferLength = file.buffer.length;
  if (bufferLength === 0) {
    throw new FileSecurityError('Tệp đính kèm rỗng (0 bytes).', 'EMPTY_FILE', 400);
  }
  if (bufferLength > MAX_FILE_SIZE_BYTES) {
    const maxMb = (MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    throw new FileSecurityError(
      `Dung lượng tệp (${(bufferLength / (1024 * 1024)).toFixed(2)} MB) vượt quá giới hạn tối đa cho phép (${maxMb} MB).`,
      'FILE_SIZE_LIMIT_EXCEEDED',
      400
    );
  }

  // 5. MIME Type Cross-Validation
  const providedMime = (file.mimetype || '').toLowerCase().trim();
  const allowedMimes = ALLOWED_MIME_TYPES[ext] || [];
  if (providedMime && !allowedMimes.includes(providedMime)) {
    // Warn or reject if MIME clearly contradicts
    console.warn(`[BiFileSecurity] Suspicious MIME type: ${providedMime} for extension ${ext}`);
  }

  // 6. Magic Bytes Deep Inspection
  verifyMagicBytes(file.buffer, ext);

  // 7. ZIP Bomb Protection for OpenXML .xlsx
  if (ext === '.xlsx') {
    verifyZipExpansionRatio(file.buffer);
  }

  // 8. Generate File ID & Cryptographic Checksum
  const fileId = crypto.randomUUID();
  const sha256Checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const now = new Date();
  const expiryDate = new Date(now.getTime() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const fileTypeMap = { '.xlsx': 'XLSX', '.xls': 'XLS', '.csv': 'CSV' };
  const normalizedFileType = fileTypeMap[ext] || 'UNKNOWN';

  // 9. Store File in Isolated Directory with UUID filename
  const storedFilename = `${fileId}${ext}`;
  const storedPath = path.join(STORAGE_DIR, storedFilename);

  await fs.promises.writeFile(storedPath, file.buffer, { mode: 0o600 });

  // 10. Assemble Intake Metadata Record
  const metadata = {
    file_id: fileId,
    uploaded_by: userContext.user_id,
    uploader_name: userContext.username || 'unknown',
    uploader_role: userContext.role || 'USER',
    company_id: userContext.company_id || 'UNKNOWN',
    original_filename: cleanFilename,
    file_type: normalizedFileType,
    file_extension: ext,
    file_size: bufferLength,
    checksum: sha256Checksum,
    upload_timestamp: now.toISOString(),
    processing_status: 'UPLOADED',
    retention_expiry: expiryDate.toISOString(),
    storage_path: storedPath,
    stored_filename: storedFilename,
  };

  return { metadata, buffer: file.buffer };
}

module.exports = {
  validateAndStoreIntakeFile,
  sanitizeFilename,
  verifyMagicBytes,
  verifyZipExpansionRatio,
  sanitizeFormulaInjection,
  assertSafeStorageDir,
  FileSecurityError,
  STORAGE_DIR,
  MAX_FILE_SIZE_BYTES,
  MAX_UNCOMPRESSED_ZIP_BYTES,
  MAX_ZIP_RATIO,
  DEFAULT_RETENTION_DAYS,
};
