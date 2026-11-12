/**
 * VIETNAMESE UNICODE & ENCODING INTEGRITY GUARD
 * SOTRANS Hub - System-Wide Text Encoding Protection
 * 
 * Provides:
 * 1. Strict Unicode NFC normalization
 * 2. Anomaly detection: U+FFFD (replacement char), mojibake, detached diacritics
 * 3. Text layer validity checking for PDF/OCR
 * 4. Safe streaming response buffering (prevents multi-byte split corruption)
 */

// Replacement character U+FFFD
const REPLACEMENT_CHAR = '\uFFFD';

// Regex for common mojibake sequences resulting from Latin-1 / Windows-1252 / ASCII decodings of UTF-8
const MOJIBAKE_PATTERNS = [
  /Ã¡/g, /Ã /g, /Ã£/g, /Ã²/g, /Ã¢/g, /Ã¨/g, /Ã©/g, /Ãª/g, /Ã¬/g, /Ã­/g,
  /Ã³/g, /Ã´/g, /Ãµ/g, /Ã¹/g, /Ãº/g, /Ã½/g, /Äƒ/g, /Ä‘/g, /Æ¡/g, /Æ°/g,
  /Ã‚/g, /ÃŠ/g, /Ã”/g, /Ä‚/g, /Ä/g,  /Æ¯/g, /ï¿½/g, /â€™/g, /â€œ/g, /â€/g,
  /Ã\u00A0/g, /Ã\u00A1/g, /Ã\u00A2/g, /Ã\u00A3/g, /Ã\u00A8/g, /Ã\u00A9/g,
  /á»\u0081/g, /á»\u0083/g, /á»\u0085/g, /á»\u0087/g, /á»\u0093/g, /á»\u0095/g,
  /á»\u0097/g, /á»\u0099/g, /á»\u009B/g, /á»\u009D/g, /á»\u009F/g, /á»\u00A1/g,
  /á»\u00A3/g, /á»\u00A5/g, /á»\u00A7/g, /á»\u00A9/g, /á»\u00AB/g, /á»\u00AD/g,
  /áº\u00AD/g, /áº\u00AF/g, /áº\u00B1/g, /áº\u00B3/g, /áº\u00B5/g, /áº\u00B7/g
];

// Detached combining diacritics (U+0300 through U+036F) occurring at word boundaries or after spaces
const DETACHED_DIACRITICS_REGEX = /(?:^|\s)[\u0300-\u036F]+|[\u0300-\u036F]{2,}/;

/**
 * Normalize string to Unicode NFC
 * @param {*} val 
 * @returns {string}
 */
function normalizeUnicodeNFC(val) {
  if (val === undefined || val === null) return '';
  const str = String(val);
  return str.normalize('NFC');
}

/**
 * Detect encoding anomalies such as U+FFFD, mojibake, or malformed diacritics
 * @param {string} text 
 * @returns {{ hasAnomaly: boolean, hasReplacementChar: boolean, hasMojibake: boolean, anomalyTypes: string[], details: string }}
 */
function detectEncodingAnomalies(text) {
  if (!text || typeof text !== 'string') {
    return {
      hasAnomaly: false,
      hasReplacementChar: false,
      hasMojibake: false,
      anomalyTypes: [],
      details: ''
    };
  }

  const normalized = text.normalize('NFC');
  const anomalyTypes = [];
  let hasReplacementChar = false;
  let hasMojibake = false;

  // 1. Check for U+FFFD (Replacement character)
  if (normalized.includes(REPLACEMENT_CHAR)) {
    hasReplacementChar = true;
    const count = (normalized.match(new RegExp(REPLACEMENT_CHAR, 'g')) || []).length;
    anomalyTypes.push(`REPLACEMENT_CHARACTER_DETECTED (count: ${count})`);
  }

  // 2. Check for Mojibake patterns
  for (const pat of MOJIBAKE_PATTERNS) {
    if (pat.test(normalized)) {
      hasMojibake = true;
      anomalyTypes.push(`MOJIBAKE_PATTERN_DETECTED (${pat.source})`);
      break;
    }
  }

  // 3. Check for detached diacritics
  if (DETACHED_DIACRITICS_REGEX.test(normalized)) {
    anomalyTypes.push('DETACHED_OR_CORRUPT_DIACRITICS_DETECTED');
  }

  const hasAnomaly = anomalyTypes.length > 0;
  return {
    hasAnomaly,
    hasReplacementChar,
    hasMojibake,
    anomalyTypes,
    details: hasAnomaly ? anomalyTypes.join('; ') : 'CLEAN_UTF8_NFC'
  };
}

/**
 * Validates text layer integrity from PDF extractors (pdf-parse, etc.)
 * Determines whether text layer should be trusted or if system must fallback to multimodal vision OCR
 * @param {string} extractedText 
 * @returns {{ isReliable: boolean, reason: string, fffdCount: number }}
 */
function evaluatePdfTextLayerReliability(extractedText) {
  if (!extractedText || typeof extractedText !== 'string') {
    return { isReliable: false, reason: 'EMPTY_TEXT_LAYER', fffdCount: 0 };
  }

  const clean = extractedText.replace(/-- \d+ of \d+ --/g, '').trim();
  if (clean.length < 40) {
    return { isReliable: false, reason: 'TOO_FEW_CHARACTERS_LIKELY_SCANNED', fffdCount: 0 };
  }

  // Check for presence of replacement character \uFFFD
  const fffdMatches = clean.match(/\uFFFD/g);
  const fffdCount = fffdMatches ? fffdMatches.length : 0;
  if (fffdCount > 0) {
    return {
      isReliable: false,
      reason: `REPLACEMENT_CHARACTER_IN_TEXT_LAYER (${fffdCount} occurrence(s) of U+FFFD detected - CMap or ToUnicode table corrupted)`,
      fffdCount
    };
  }

  // Check for high mojibake ratio
  const anomalyCheck = detectEncodingAnomalies(clean);
  if (anomalyCheck.hasMojibake) {
    return {
      isReliable: false,
      reason: `MOJIBAKE_IN_TEXT_LAYER (${anomalyCheck.details})`,
      fffdCount: 0
    };
  }

  return { isReliable: true, reason: 'TEXT_LAYER_VERIFIED_CLEAN', fffdCount: 0 };
}

/**
 * Safely collect HTTP response stream into a clean UTF-8 string,
 * avoiding multi-byte character boundary corruption.
 * @param {http.IncomingMessage} res 
 * @returns {Promise<string>}
 */
function bufferStreamToUtf8(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      try {
        const fullBuffer = Buffer.concat(chunks);
        const utf8String = fullBuffer.toString('utf8').normalize('NFC');
        resolve(utf8String);
      } catch (err) {
        reject(err);
      }
    });
    res.on('error', reject);
  });
}

/**
 * Standardize and clean a Vietnamese address string while strictly preserving all diacritics
 * @param {string} addr 
 * @returns {string}
 */
function sanitizeVietnameseAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  let str = addr.normalize('NFC').trim();
  // Normalize double spaces or non-standard spaces
  str = str.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  str = str.replace(/\s+/g, ' ');
  return str;
}

module.exports = {
  REPLACEMENT_CHAR,
  normalizeUnicodeNFC,
  detectEncodingAnomalies,
  evaluatePdfTextLayerReliability,
  bufferStreamToUtf8,
  sanitizeVietnameseAddress
};
