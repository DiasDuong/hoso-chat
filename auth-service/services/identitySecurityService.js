/**
 * SOTRANS HUB — IDENTITY SECURITY SERVICE
 * Quản lý mã hóa PII (AES-256-GCM), Blind Index (HMAC-SHA256) và Xoay khóa an toàn.
 */

const crypto = require('crypto');

// Khóa mặc định (có thể cấu hình ghi đè qua biến môi trường)
const DEFAULT_AES_KEY = Buffer.from('4f7b2c91e8a3d5f60b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a', 'hex');
const DEFAULT_HMAC_KEY_V1 = Buffer.from('8a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff0', 'hex');
const DEFAULT_HMAC_KEY_V2 = Buffer.from('9b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff01a', 'hex');

function getAesKey(keyId = 'kms-key-v1') {
  if (process.env.PII_AES_KEY_V1) {
    return Buffer.from(process.env.PII_AES_KEY_V1, 'hex');
  }
  return DEFAULT_AES_KEY;
}

function getHmacKey(version = 1) {
  if (version === 2) {
    if (process.env.PII_HMAC_KEY_V2) {
      return Buffer.from(process.env.PII_HMAC_KEY_V2, 'hex');
    }
    return DEFAULT_HMAC_KEY_V2;
  }
  if (process.env.PII_HMAC_KEY_V1) {
    return Buffer.from(process.env.PII_HMAC_KEY_V1, 'hex');
  }
  return DEFAULT_HMAC_KEY_V1;
}

/**
 * Chuẩn hóa chuỗi định danh trước khi băm
 * Cấm tự động đệm số 0 vào số định danh sai định dạng
 */
function canonicalizeIdentity(docType = 'CCCD', countryCode = 'VNM', rawNumber = '') {
  const cleanType = String(docType || 'CCCD').trim().toUpperCase();
  const cleanCountry = String(countryCode || 'VNM').trim().toUpperCase();
  const cleanNumber = String(rawNumber || '').trim().replace(/[\s.-]/g, '');
  return `${cleanType}:${cleanCountry}:${cleanNumber}`;
}

/**
 * Tính toán Blind Index bằng HMAC-SHA256
 */
function computeBlindIndex(canonicalString, version = 1) {
  const key = getHmacKey(version);
  return crypto.createHmac('sha256', key).update(canonicalString).digest('hex');
}

/**
 * Che mặt nạ số định danh (Masking)
 */
function maskIdentityNumber(rawNumber = '') {
  const clean = String(rawNumber || '').trim().replace(/[\s.-]/g, '');
  if (!clean) return '******';
  if (clean.length >= 6) {
    return clean.substring(0, 3) + '******' + clean.substring(clean.length - 3);
  }
  return '******';
}

/**
 * Mã hóa số định danh bằng AES-256-GCM
 */
function encryptDocNumber(rawNumber, keyId = 'kms-key-v1') {
  const key = getAesKey(keyId);
  const iv = crypto.randomBytes(12); // 96-bit nonce
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(String(rawNumber).trim(), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag(); // 128-bit tag

  return {
    encryptedBytes: encrypted,
    iv: iv,
    authTag: authTag,
    keyId: keyId
  };
}

/**
 * Giải mã số định danh bằng AES-256-GCM
 */
function decryptDocNumber(encryptedBytes, iv, authTag, keyId = 'kms-key-v1') {
  const key = getAesKey(keyId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([
    decipher.update(encryptedBytes),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

/**
 * Tra cứu bản ghi định danh hỗ trợ xoay khóa đa phiên bản (Dual-Lookup Rotation)
 */
async function findIdentityDocument(dbClient, rawNumber, docType = 'CCCD', countryCode = 'VNM') {
  const canonical = canonicalizeIdentity(docType, countryCode, rawNumber);
  const hmacV1 = computeBlindIndex(canonical, 1);
  const hmacV2 = computeBlindIndex(canonical, 2);

  const query = `
    SELECT 
      d.*,
      p.full_name AS person_full_name,
      p.normalized_name
    FROM hr_person_identity_documents d
    JOIN hr_persons p ON d.person_id = p.id
    WHERE (d.doc_number_hmac = $1 AND d.hmac_key_version = 1)
       OR (d.doc_number_hmac = $2 AND d.hmac_key_version = 2)
    ORDER BY d.is_primary DESC, d.created_at DESC
    LIMIT 1;
  `;
  
  const result = await dbClient.query(query, [hmacV1, hmacV2]);
  if (result.rows.length === 0) return null;

  const doc = result.rows[0];
  // Nếu tìm thấy ở phiên bản khóa cũ (v1) khi hệ thống đang ở chu kỳ chuyển sang v2,
  // tự động cập nhật bản ghi lên v2
  if (doc.hmac_key_version === 1 && process.env.PII_ACTIVE_HMAC_VERSION === '2') {
    try {
      await dbClient.query(`
        UPDATE hr_person_identity_documents
        SET doc_number_hmac = $1, hmac_key_version = 2, updated_at = NOW()
        WHERE id = $2;
      `, [hmacV2, doc.id]);
      doc.hmac_key_version = 2;
      doc.doc_number_hmac = hmacV2;
    } catch (updateErr) {
      console.warn('[IDENTITY SECURITY] Không thể nâng cấp khóa HMAC:', updateErr.message);
    }
  }

  return doc;
}

module.exports = {
  canonicalizeIdentity,
  computeBlindIndex,
  maskIdentityNumber,
  encryptDocNumber,
  decryptDocNumber,
  findIdentityDocument,
  getAesKey,
  getHmacKey
};
