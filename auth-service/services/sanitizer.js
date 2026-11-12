/**
 * SOTRANS HUB — STRING & TEXT SANITIZER SERVICE
 * 
 * Purpose: Triệt tiêu hoàn toàn ký tự NUL (ASCII 0x00 / \u0000) gây lỗi PostgreSQL JSONB
 *          (unsupported Unicode escape sequence \u0000)
 * 
 * Invariants:
 * - Bảo toàn 100% tiếng Việt Unicode UTF-8 (NFC/NFD).
 * - Bảo toàn chuỗi literal "\\u0000" (dạng text thông thường, không phải byte 0x00).
 * - Đếm và ghi nhận thống kê số lượng byte NUL đã loại bỏ.
 */

/**
 * Khử byte NUL khỏi một chuỗi ký tự
 * @param {string} str 
 * @returns {string} Chuỗi sau khi khử \0
 */
function stripNullBytes(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '');
}

/**
 * Khử byte NUL và trả về số lượng ký tự đã loại bỏ
 * @param {string} str 
 * @returns {{ sanitized: string, removedCount: number }}
 */
function stripNullBytesWithStats(str) {
  if (typeof str !== 'string') return { sanitized: str, removedCount: 0 };
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 0) count++;
  }
  const sanitized = str.replace(/\0/g, '');
  return { sanitized, removedCount: count };
}

/**
 * Đệ quy khử byte NUL trên object hoặc array trước khi JSON.stringify
 * @param {*} val 
 * @returns {*} Dữ liệu đã làm sạch
 */
function sanitizeNullBytesRecursive(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return stripNullBytes(val);
  if (Array.isArray(val)) return val.map(sanitizeNullBytesRecursive);
  if (typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      res[stripNullBytes(k)] = sanitizeNullBytesRecursive(v);
    }
    return res;
  }
  return val;
}

module.exports = {
  stripNullBytes,
  stripNullBytesWithStats,
  sanitizeNullBytesRecursive
};
