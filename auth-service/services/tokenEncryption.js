/**
 * SOTRANS HUB — TOKEN ENCRYPTION AT REST
 * 
 * Provides AES-256-GCM authenticated encryption and decryption for sensitive OAuth tokens.
 * Complies with requirement: Tokens are encrypted before persisting to PostgreSQL
 * and decrypted only in memory when calling Microsoft Graph API.
 */

const crypto = require('crypto');

function getEncryptionKey() {
  const envKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (envKey && typeof envKey === 'string') {
    if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    if (envKey.length === 32) {
      return Buffer.from(envKey, 'utf8');
    }
  }
  // Deterministic fallback derived from server JWT_SECRET if explicit key is not configured
  const baseSecret = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';
  return crypto.createHash('sha256').update(baseSecret + '_oauth_token_salt_2026').digest();
}

/**
 * Encrypt a plaintext token using AES-256-GCM.
 * @param {string} plainText 
 * @returns {string} Format: "ivHex:tagHex:encryptedHex"
 */
function encryptToken(plainText) {
  if (!plainText || typeof plainText !== 'string') return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // Recommended IV length for GCM is 12 bytes
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypt an AES-256-GCM encrypted ciphertext string.
 * @param {string} cipherText Format: "ivHex:tagHex:encryptedHex"
 * @returns {string} Plaintext token
 */
function decryptToken(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return null;
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Định dạng token mã hóa không hợp lệ (Invalid encrypted token format).');
  }
  
  const [ivHex, tagHex, encryptedHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = {
  encryptToken,
  decryptToken
};
