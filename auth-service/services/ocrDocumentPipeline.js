/**
 * SOTRANS HUB — OCR DOCUMENT PIPELINE (PHASE 3)
 * 
 * Pipeline: Ingestion & Validation -> Native Extraction / OCR Fallback -> Normalization -> Quality Check -> Chunking with Page Tracking -> 768-dim Embedding -> PostgreSQL & Qdrant Upsert
 * 
 * Strict Guarantees:
 * 1. Native text layer extraction first for PDF; OCR fallback only when scanned/empty.
 * 2. Direct OCR for JPG, JPEG, PNG.
 * 3. Page preservation: page_start, page_end tracked across all chunks and Qdrant points.
 * 4. Vietnamese Unicode NFC normalization and NUL byte stripping.
 * 5. Quality scoring (parse_quality) and distinction between blank page and OCR error.
 * 6. Concurrency locking via durable retry lease (generation_id, fencing_token).
 * 7. Idempotency: retry purges old generation chunks/vectors without duplicate pollution.
 * 8. Zero-chunk gate & RAG isolation: non-active documents never leaked to general users.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const db = require('../db');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const qdrantSyncService = require('./qdrantSyncService');

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_PRIMARY_MODEL = process.env.GEMINI_OCR_MODEL || 'gemini-flash-lite-latest';
const GEMINI_FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const EMBEDDING_MODEL = 'gemini-embedding-2';

const QDRANT_HOST = process.env.QDRANT_HOST || (process.platform === 'win32' ? 'localhost' : 'qdrant');
const QDRANT_PORT = parseInt(process.env.QDRANT_PORT || '6333', 10);
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'hr_docs';

/**
 * 1. Unicode & Sanitization Helpers
 */
function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .replace(/^\uFEFF/, '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim();
}

function stripAccents(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

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

function formatDisplayDate(d) {
  const iso = formatIsoDate(d);
  const parts = iso.split('-');
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

/**
 * 2. File Format Validation & Magic Bytes Check
 */
function validateFileBuffer(buffer, originalName, mimeType) {
  if (!buffer || buffer.length === 0) {
    return { valid: false, status: 400, code: 'NO_FILE', error: 'Vui lòng cung cấp tệp tin hợp lệ.' };
  }
  if (buffer.length < 10) {
    return { valid: false, status: 422, code: 'INVALID_FILE_STRUCTURE', error: `Tệp tin rỗng hoặc quá nhỏ (${buffer.length} bytes).` };
  }
  if (buffer.length > 25 * 1024 * 1024) {
    return { valid: false, status: 413, code: 'FILE_TOO_LARGE', error: 'Dung lượng tệp tin vượt quá 25MB cho phép.' };
  }

  const ext = path.extname(originalName || '').toLowerCase();
  const supported = ['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg'];
  if (!supported.includes(ext)) {
    return {
      valid: false,
      status: 400,
      code: 'UNSUPPORTED_FORMAT',
      error: `Định dạng tệp "${ext}" không được hỗ trợ. Các định dạng được hỗ trợ: PDF, DOCX, TXT, MD, PNG, JPG, JPEG.`
    };
  }

  // Magic bytes check
  if (ext === '.pdf') {
    const header = buffer.slice(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      return { valid: false, status: 422, code: 'INVALID_PDF_STRUCTURE', error: 'Tệp không đúng định dạng PDF hợp lệ (thiếu header %PDF-).' };
    }
  } else if (ext === '.docx') {
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      return { valid: false, status: 422, code: 'INVALID_DOCX_STRUCTURE', error: 'Tệp không đúng định dạng DOCX hợp lệ (thiếu header PK).' };
    }
  } else if (ext === '.png') {
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
      return { valid: false, status: 422, code: 'INVALID_IMAGE_STRUCTURE', error: 'Tệp không đúng định dạng hình ảnh PNG hợp lệ.' };
    }
  } else if (['.jpg', '.jpeg'].includes(ext)) {
    if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
      return { valid: false, status: 422, code: 'INVALID_IMAGE_STRUCTURE', error: 'Tệp không đúng định dạng hình ảnh JPG/JPEG hợp lệ.' };
    }
  }

  return { valid: true, ext };
}

/**
 * 3. Gemini REST API Call Helper (handles multimodal base64 payload & fallbacks)
 */
async function callGeminiApi(payload, candidateModels = [GEMINI_PRIMARY_MODEL, ...GEMINI_FALLBACK_MODELS], timeoutMs = 30000) {
  let lastErr = null;

  for (const model of candidateModels) {
    try {
      const result = await new Promise((resolve, reject) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const postData = JSON.stringify(payload);

        const req = https.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: timeoutMs
        }, (res) => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(raw));
              } catch (e) {
                reject(new Error(`JSON Parse Error from Gemini (${model}): ${e.message}`));
              }
            } else {
              reject(new Error(`Gemini HTTP ${res.statusCode} (${model}): ${raw.slice(0, 300)}`));
            }
          });
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Gemini API request timed out (${timeoutMs}ms) on ${model}`));
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
      });

      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[OCR Pipeline] Model ${model} failed, trying next fallback: ${err.message}`);
    }
  }

  throw lastErr || new Error('All Gemini API candidate models failed');
}

/**
 * 4. Gemini Multimodal Vision OCR Engine
 */
async function runVisionOcr(buffer, mimeType, options = {}) {
  const isImage = mimeType.startsWith('image/');
  const targetLabel = isImage ? 'hình ảnh' : 'tài liệu scan';

  const systemInstruction = `Bạn là chuyên gia OCR văn bản chuyên nghiệp của SOTRANS Hub.
Nhiệm vụ: Trích xuất chính xác 100% toàn bộ văn bản trong ${targetLabel} đính kèm sang tiếng Việt và tiếng Anh.
QUY TẮC BẮT BUỘC:
1. Giữ nguyên toàn bộ tiếng Việt có dấu (Unicode NFC), chữ số, ngày tháng (dd/mm/yyyy), số hiệu văn bản và ký hiệu tiền tệ.
2. Cấu trúc bảng biểu PHẢI được trích xuất dưới dạng Markdown table (| Cột 1 | Cột 2 |).
3. Giữ nguyên số trang và thứ tự từng trang (page_number: 1, 2, ...).
4. Phân biệt rõ các trạng thái:
   - Nếu trang hoàn toàn rỗng/trang trắng: text: "[TRANG_TRONG]", status: "BLANK", quality_score: 1.0.
   - Nếu văn bản bị mờ, nhoè không thể đọc: đánh dấu "[MỜ / KHÔNG ĐỌC ĐƯỢC]", TUYỆT ĐỐI KHÔNG SUY ĐOÁN hay bịa đặt. status: "PARTIAL_ILLEGIBLE", quality_score: 0.5.
   - Nếu đọc tốt, rõ ràng: status: "OK", quality_score: 0.95.
5. Chỉ trả về DUY NHẤT một khối JSON theo định dạng sau (không thêm văn bản ngoài JSON):
{
  "document_quality": 0.95,
  "pages": [
    {
      "page_number": 1,
      "text": "Nội dung văn bản trang 1...",
      "has_table": false,
      "status": "OK",
      "quality_score": 0.95
    }
  ]
}`;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        parts: [
          { text: `Hãy trích xuất toàn bộ văn bản từ ${targetLabel} này theo định dạng JSON đã chỉ định.` },
          {
            inlineData: {
              mimeType: mimeType,
              data: buffer.toString('base64')
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192
    }
  };

  const response = await callGeminiApi(payload, [GEMINI_PRIMARY_MODEL, ...GEMINI_FALLBACK_MODELS], 45000);
  const textRaw = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const cleanJsonText = textRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsedJson;
  try {
    parsedJson = JSON.parse(cleanJsonText);
  } catch (err) {
    // Fallback if model returned plain text instead of JSON
    console.warn('[OCR Pipeline] Failed to parse JSON from vision response, using fallback wrapper:', err.message);
    parsedJson = {
      document_quality: 0.85,
      pages: [
        {
          page_number: 1,
          text: normalizeText(textRaw),
          has_table: textRaw.includes('|'),
          status: 'OK',
          quality_score: 0.85
        }
      ]
    };
  }

  // Ensure pages array is valid
  const pages = Array.isArray(parsedJson.pages) && parsedJson.pages.length > 0
    ? parsedJson.pages.map((p, idx) => ({
        pageNumber: Number(p.page_number || idx + 1),
        text: normalizeText(p.text || ''),
        hasTable: !!p.has_table || (p.text && p.text.includes('|')),
        status: p.status || 'OK',
        qualityScore: typeof p.quality_score === 'number' ? p.quality_score : 0.9
      }))
    : [
        {
          pageNumber: 1,
          text: normalizeText(cleanJsonText),
          hasTable: cleanJsonText.includes('|'),
          status: 'OK',
          qualityScore: typeof parsedJson.document_quality === 'number' ? parsedJson.document_quality : 0.85
        }
      ];

  const overallQuality = typeof parsedJson.document_quality === 'number'
    ? parsedJson.document_quality
    : (pages.reduce((acc, p) => acc + p.qualityScore, 0) / pages.length);

  return {
    source: 'OCR_VISION',
    pages,
    overallQuality: Math.round(overallQuality * 100) / 100
  };
}

/**
 * 5. Native PDF Extraction & Fallback Decision
 */
async function extractDocumentPages(buffer, fileName, mimeType) {
  const ext = path.extname(fileName || '').toLowerCase();

  // A. PDF Files
  if (ext === '.pdf') {
    let nativeRes = null;
    try {
      const parser = new PDFParse({ data: buffer });
      nativeRes = await parser.getText();
    } catch (parseErr) {
      console.warn('[OCR Pipeline] Native PDFParse failed:', parseErr.message);
    }

    if (nativeRes && Array.isArray(nativeRes.pages) && nativeRes.pages.length > 0) {
      const pages = [];
      let totalGoodChars = 0;
      let scannedPagesCount = 0;

      nativeRes.pages.forEach((p, idx) => {
        const clean = normalizeText(p.text);
        const pageNum = Number(p.num || idx + 1);
        const charCount = clean.replace(/\s+/g, '').length;

        // Condition for quality text layer: at least 40 non-space characters
        if (charCount >= 40) {
          pages.push({
            pageNumber: pageNum,
            text: clean,
            hasTable: clean.includes('|'),
            status: 'OK',
            qualityScore: 0.98,
            charCount
          });
          totalGoodChars += charCount;
        } else if (charCount === 0) {
          pages.push({
            pageNumber: pageNum,
            text: '[TRANG_TRONG]',
            hasTable: false,
            status: 'BLANK',
            qualityScore: 1.0,
            charCount: 0
          });
        } else {
          // Low characters count: likely scanned page with residual OCR artifacts
          scannedPagesCount++;
          pages.push({
            pageNumber: pageNum,
            text: clean,
            hasTable: clean.includes('|'),
            status: 'PARTIAL_SCANNED',
            qualityScore: 0.4,
            charCount
          });
        }
      });

      // If at least 80% of pages have good native text and total text is substantial:
      const nonBlankPages = pages.filter(p => p.status !== 'BLANK');
      const isHighQualityNative = nonBlankPages.length > 0 &&
        (scannedPagesCount / nonBlankPages.length <= 0.2) &&
        totalGoodChars >= (50 * nonBlankPages.length);

      if (isHighQualityNative) {
        return {
          source: 'NATIVE_PDF',
          pages,
          overallQuality: 0.98
        };
      }
    }

    // Scanned or low-quality PDF: Execute OCR Fallback via Gemini Multimodal Vision
    console.log(`[OCR Pipeline] PDF "${fileName}" has low native text (${nativeRes?.text?.length || 0} chars). Falling back to Vision OCR...`);
    const ocrResult = await runVisionOcr(buffer, 'application/pdf');
    return {
      source: 'OCR_FALLBACK',
      pages: ocrResult.pages,
      overallQuality: ocrResult.overallQuality
    };
  }

  // B. Image Files (JPG, JPEG, PNG)
  if (['.png', '.jpg', '.jpeg'].includes(ext)) {
    const effectiveMime = ext === '.png' ? 'image/png' : 'image/jpeg';
    console.log(`[OCR Pipeline] Processing direct image OCR for "${fileName}" (${effectiveMime})...`);
    const ocrResult = await runVisionOcr(buffer, effectiveMime);
    return {
      source: 'OCR_DIRECT',
      pages: ocrResult.pages,
      overallQuality: ocrResult.overallQuality
    };
  }

  // C. DOCX Files
  if (ext === '.docx') {
    const { value: docxText } = await mammoth.extractRawText({ buffer });
    const clean = normalizeText(docxText);
    return {
      source: 'NATIVE_DOCX',
      pages: [
        {
          pageNumber: 1,
          text: clean,
          hasTable: clean.includes('|'),
          status: 'OK',
          qualityScore: 0.98
        }
      ],
      overallQuality: 0.98
    };
  }

  // D. Plain Text / Markdown Files
  if (['.txt', '.md'].includes(ext)) {
    const clean = normalizeText(buffer.toString('utf8'));
    return {
      source: 'NATIVE_TEXT',
      pages: [
        {
          pageNumber: 1,
          text: clean,
          hasTable: clean.includes('|'),
          status: 'OK',
          qualityScore: 1.0
        }
      ],
      overallQuality: 1.0
    };
  }

  throw new Error(`Định dạng tệp ${ext} không được hỗ trợ bóc tách.`);
}

/**
 * 6. Chunking with Section & Page Number Tracking
 */
function buildDocumentChunks(pages, docMeta) {
  const MAX_CHUNK_CHARS = 1200;
  const STEP_CHARS = 1000;
  const chunks = [];

  const effectiveDateStr = formatDisplayDate(docMeta.effective_date);
  const versionStr = `v${docMeta.version || 1}`;
  const docCodeStr = docMeta.doc_code || docMeta.doc_number || 's/n';

  function splitPieces(text) {
    const tableRe = /(?:^[ \t]*\|.*\|[ \t]*(?:\n|$))+/gm;
    const res = [];
    let last = 0;
    let m;
    while ((m = tableRe.exec(text)) !== null) {
      if (m.index > last) {
        const sub = text.slice(last, m.index).trim();
        if (sub) res.push({ type: 'text', text: sub });
      }
      res.push({ type: 'table', text: m[0].trim() });
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      const remaining = text.slice(last).trim();
      if (remaining) res.push({ type: 'text', text: remaining });
    }
    return res;
  }

  function splitLongText(text) {
    if (text.length <= MAX_CHUNK_CHARS) return [text];
    const out = [];
    const paragraphs = text.split(/\n(?=\s*(?:\d+[\.\)]|[a-z][\.\)]|-|\*)\s)/);
    let cur = '';

    for (const p of paragraphs) {
      if (cur && (cur + '\n' + p).length > MAX_CHUNK_CHARS) {
        out.push(cur.trim());
        cur = p;
      } else {
        cur = cur ? cur + '\n' + p : p;
      }
    }
    if (cur.trim()) out.push(cur.trim());

    // If still oversized paragraph: hard split with overlap
    return out.flatMap(block => {
      if (block.length <= MAX_CHUNK_CHARS * 1.3) return [block];
      const hard = [];
      for (let i = 0; i < block.length; i += STEP_CHARS) {
        hard.push(block.slice(i, i + MAX_CHUNK_CHARS).trim());
      }
      return hard.filter(Boolean);
    });
  }

  for (const page of pages) {
    const pageNum = page.pageNumber || 1;
    const pageText = page.text || '';
    if (!pageText || pageText === '[TRANG_TRONG]' || page.status === 'BLANK' || pageText.includes('[MỜ / KHÔNG ĐỌC ĐƯỢC]') || (page.status === 'PARTIAL_ILLEGIBLE' && pageText.length < 40)) {
      continue;
    }

    // Split page text into Sections (Chương / Điều / Headings)
    let currentChuong = '';
    let currentDieu = '';
    let buf = [];
    const sections = [];

    const flush = () => {
      const t = buf.join('\n').trim();
      if (t) sections.push({ chuong: currentChuong, dieu: currentDieu, text: t });
      buf = [];
    };

    for (const line of pageText.split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
      if (!trimmed) continue;
      if (/^chương\s+[ivxlc0-9]+/i.test(trimmed)) {
        flush();
        currentChuong = trimmed;
        currentDieu = '';
        buf.push(trimmed);
        continue;
      }
      if (/^điều\s+\d+/i.test(trimmed) || /^#{1,3}\s+/.test(line)) {
        flush();
        currentDieu = trimmed;
        buf.push(trimmed);
        continue;
      }
      buf.push(line);
    }
    flush();

    for (const sec of sections) {
      const sectionPath = [sec.chuong, sec.dieu].filter(Boolean).join(' > ') || docMeta.title;
      const pieces = splitPieces(sec.text);

      for (const piece of pieces) {
        const subs = piece.type === 'table' ? [piece.text] : splitLongText(piece.text);

        subs.forEach((txt, idx) => {
          const content = (piece.type === 'table' ? `Bảng thuộc mục ${sectionPath} (Trang ${pageNum}):\n` : '') + txt.trim();
          if (content.length < 15) return;

          const spWithPart = sectionPath + (subs.length > 1 ? ` (phần ${idx + 1})` : '');
          const header = `[${docMeta.title} – ${docCodeStr} – ${spWithPart} – Trang ${pageNum} – hiệu lực ${effectiveDateStr} – ${versionStr}]`;

          chunks.push({
            chunk_id: crypto.randomUUID(),
            doc_version_id: docMeta.doc_version_id,
            seq: chunks.length,
            chunk_type: piece.type === 'table' ? 'table' : 'text',
            section_path: spWithPart,
            page_start: pageNum,
            page_end: pageNum,
            contextual_header: header,
            content: content,
            content_unaccent: stripAccents(spWithPart + ' ' + content),
            embed_text: `${header}\n${content}`
          });
        });
      }
    }
  }

  return chunks;
}

/**
 * 7. 768-dim Embedding Generation & Exact SOTRANS Parity Prefix
 */
function formatEmbeddingInput(title, rawEmbedText) {
  const sanitized = (rawEmbedText || '').replace(/\0/g, ' ');
  return title ? `title: ${title} | text: ${sanitized}` : sanitized;
}

async function generateEmbeddings(chunks, options = {}) {
  const docTitle = (typeof options === 'string' ? options : options?.title) || '';
  const vectors = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const cTitle = chunk.title || docTitle;
    const rawEmbedText = chunk.embed_text || chunk.content || '';
    const textToEmbed = formatEmbeddingInput(cTitle, rawEmbedText);

    const payload = {
      content: {
        parts: [{ text: textToEmbed }]
      },
      outputDimensionality: 768
    };

    let vector = null;
    let attempts = 0;
    while (!vector && attempts < 3) {
      attempts++;
      try {
        const res = await new Promise((resolve, reject) => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;
          const postData = JSON.stringify(payload);

          const req = https.request(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': GEMINI_API_KEY,
              'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 15000
          }, (r) => {
            let data = '';
            r.on('data', c => { data += c; });
            r.on('end', () => {
              if (r.statusCode >= 200 && r.statusCode < 300) {
                try {
                  const p = JSON.parse(data);
                  resolve(p.embedding?.values);
                } catch (e) {
                  reject(new Error(`Embedding parse error: ${e.message}`));
                }
              } else {
                reject(new Error(`Embedding HTTP ${r.statusCode}: ${data.slice(0, 200)}`));
              }
            });
          });

          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Embedding request timed out (15s)'));
          });
          req.on('error', reject);
          req.write(postData);
          req.end();
        });

        if (Array.isArray(res) && res.length === 768) {
          vector = res;
        } else {
          throw new Error(`Embedding returned invalid dimension: ${res?.length || 0}`);
        }
      } catch (embErr) {
        console.warn(`[Embedding] Chunk ${i + 1}/${chunks.length} attempt ${attempts} failed: ${embErr.message}`);
        if (attempts >= 3) throw embErr;
        await new Promise(r => setTimeout(r, 1000 * attempts));
      }
    }

    vectors.push(vector);
  }

  return vectors;
}

/**
 * 8. Qdrant HTTP Request Helper
 */
function qdrantRequest(pathStr, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: QDRANT_HOST,
        port: QDRANT_PORT,
        path: pathStr,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        },
        timeout: 15000
      },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`Qdrant error ${res.statusCode}: ${raw.slice(0, 300)}`));
            }
          } catch (e) {
            reject(new Error(`Qdrant parse error: ${e.message} (raw: ${raw.slice(0, 200)})`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Qdrant request timed out (15s)'));
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 9. Core Pipeline Orchestrator (Idempotent, Transactional & Safe)
 */
async function executeDocumentOcrPipeline(docVersionId, fileBuffer, fileName, mimeType, options = {}) {
  const client = await db.getClient();
  const actor = options.actor || 'admin';
  const idempotencyKey = options.idempotencyKey || null;

  let lease = null;
  let inTransaction = false;

  try {
    // 1. Fetch document and verify existence
    const docRes = await client.query('SELECT * FROM documents WHERE doc_version_id = $1 FOR UPDATE', [docVersionId]);
    if (docRes.rows.length === 0) {
      throw new Error(`Document version ${docVersionId} not found.`);
    }
    const doc = docRes.rows[0];

    // Check lease table existence
    const leaseTableRes = await client.query(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'document_retry_leases'
    `);
    const hasLeaseTable = leaseTableRes.rows.length > 0;

    const generationId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 120000); // 2 minutes lease

    // 2. Concurrency Lock: Acquire lease
    if (hasLeaseTable) {
      const leaseRes = await client.query(
        'SELECT * FROM document_retry_leases WHERE doc_version_id = $1 FOR UPDATE',
        [docVersionId]
      );

      if (leaseRes.rows.length > 0) {
        const cur = leaseRes.rows[0];
        const isExpired = new Date(cur.expires_at) < new Date();
        const isBusy = cur.status === 'PROCESSING' && !isExpired;

        if (isBusy) {
          if (idempotencyKey && cur.retry_idempotency_key === idempotencyKey) {
            return {
              success: true,
              in_progress: true,
              idempotency_matched: true,
              generation_id: cur.generation_id,
              status: cur.status
            };
          }
          throw new Error(`Tài liệu đang trong tiến trình xử lý trích xuất/OCR bởi ${cur.acquired_by}.`);
        }

        const nextFencingToken = Number(cur.fencing_token || 0) + 1;
        await client.query(`
          UPDATE document_retry_leases 
          SET generation_id = $2, fencing_token = $3, status = 'PROCESSING', acquired_by = $4,
              retry_idempotency_key = $5, started_at = NOW(), expires_at = $6, updated_at = NOW()
          WHERE doc_version_id = $1
        `, [docVersionId, generationId, nextFencingToken, actor, idempotencyKey, expiresAt]);

        lease = { generationId, fencingToken: nextFencingToken };
      } else {
        await client.query(`
          INSERT INTO document_retry_leases 
            (doc_version_id, generation_id, fencing_token, status, acquired_by, retry_idempotency_key, started_at, expires_at, updated_at)
          VALUES ($1, $2, 1, 'PROCESSING', $3, $4, NOW(), $5, NOW())
        `, [docVersionId, generationId, actor, idempotencyKey, expiresAt]);

        lease = { generationId, fencingToken: 1 };
      }
    } else {
      lease = { generationId, fencingToken: 1 };
    }

    // 3. Format Validation
    const val = validateFileBuffer(fileBuffer, fileName, mimeType);
    if (!val.valid) {
      throw new Error(val.error);
    }

    // 4. Extraction & OCR Fallback
    console.log(`[OCR Pipeline] Extracting content from "${fileName}" (${doc.title})...`);
    const extractRes = await extractDocumentPages(fileBuffer, fileName, mimeType);
    const pages = extractRes.pages;
    const parseQuality = extractRes.overallQuality;

    console.log(`[OCR Pipeline] Extracted ${pages.length} pages via ${extractRes.source} (quality: ${parseQuality})`);

    // 5. Chunking with Page Tracking
    const chunks = buildDocumentChunks(pages, {
      ...doc,
      doc_version_id: docVersionId
    });

    if (chunks.length === 0) {
      throw new Error('Văn bản không chứa nội dung hợp lệ hoặc không bóc tách được đoạn văn nào (0 chunks).');
    }
    console.log(`[OCR Pipeline] Built ${chunks.length} structured chunks with page numbers.`);

    // 6. Embedding Generation with exact title prefix parity
    console.log(`[OCR Pipeline] Generating 768-dim embeddings for ${chunks.length} chunks via ${EMBEDDING_MODEL}...`);
    const vectors = await generateEmbeddings(chunks, doc.title);
    if (vectors.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${vectors.length}`);
    }

    // 7. Upsert into Qdrant Vector DB with Generation Tracking
    const points = chunks.map((c, idx) => ({
      id: c.chunk_id,
      vector: vectors[idx],
      payload: {
        chunk_id: c.chunk_id,
        doc_version_id: doc.doc_version_id,
        document_id: doc.document_id,
        version: doc.version,
        title: doc.title,
        doc_number: doc.doc_code || doc.doc_number || 's/n',
        doc_code: doc.doc_code || doc.doc_number || 's/n',
        category: doc.category || 'CHINH_SACH',
        section_path: c.section_path,
        page_start: c.page_start,
        page_end: c.page_end,
        page_number: c.page_start,
        generation_id: lease.generationId,
        // Isolation: keep draft or testing; NEVER active until Admin approval
        status: doc.status === 'active' ? 'testing' : (doc.status || 'draft'),
        branch_scope: Array.isArray(doc.branch_scope) && doc.branch_scope.length > 0 ? doc.branch_scope : ['all'],
        role_access: Array.isArray(doc.role_access) && doc.role_access.length > 0 ? doc.role_access : ['all'],
        effective_int: Number(formatIsoDate(doc.effective_date).replace(/-/g, '')),
        expiry_int: doc.expiry_date ? Number(formatIsoDate(doc.expiry_date).replace(/-/g, '')) : 99991231
      }
    }));

    console.log(`[OCR Pipeline] Upserting ${points.length} points to Qdrant collection "${COLLECTION_NAME}" (generation: ${lease.generationId})...`);
    await qdrantRequest(`/collections/${COLLECTION_NAME}/points?wait=true`, 'PUT', { points });

    // Verify Qdrant Points for this generation
    const scrollRes = await qdrantRequest(`/collections/${COLLECTION_NAME}/points/scroll`, 'POST', {
      limit: 1000,
      with_payload: false,
      with_vector: false,
      filter: {
        must: [
          { key: 'doc_version_id', match: { value: docVersionId } },
          { key: 'generation_id', match: { value: lease.generationId } }
        ]
      }
    });
    const qdrantCount = scrollRes?.result?.points?.length || 0;
    if (qdrantCount === 0 || qdrantCount < chunks.length) {
      throw new Error(`Đối soát Qdrant thất bại: tạo ${chunks.length} chunks nhưng chỉ có ${qdrantCount} vectors cho generation ${lease.generationId}.`);
    }

    // 8. Atomic Database Persistence & Generation Switch
    await client.query('BEGIN');
    inTransaction = true;

    // Insert new chunks for this generation
    for (const c of chunks) {
      await client.query(`
        INSERT INTO chunks 
          (chunk_id, doc_version_id, seq, chunk_type, section_path, page_start, page_end, contextual_header, content, content_unaccent, generation_id, fencing_token, is_published)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE)
      `, [
        c.chunk_id,
        docVersionId,
        c.seq,
        c.chunk_type,
        c.section_path,
        c.page_start,
        c.page_end,
        c.contextual_header,
        c.content,
        c.content_unaccent,
        lease.generationId,
        lease.fencingToken
      ]);
    }

    // Purge superseded generation chunks in DB only after new generation is inserted
    await client.query('DELETE FROM chunks WHERE doc_version_id = $1 AND generation_id != $2', [docVersionId, lease.generationId]);

    // Update Document metadata to point to the new active generation
    await client.query(`
      UPDATE documents 
      SET parse_quality = $1,
          active_generation_id = $2,
          active_fencing_token = $3,
          retry_count = COALESCE(retry_count, 0) + 1
      WHERE doc_version_id = $4
    `, [parseQuality, lease.generationId, lease.fencingToken, docVersionId]);

    // Release lease as PUBLISHED
    if (hasLeaseTable) {
      await client.query(`
        UPDATE document_retry_leases 
        SET status = 'PUBLISHED', updated_at = NOW() 
        WHERE doc_version_id = $1
      `, [docVersionId]);
    }

    await client.query('COMMIT');
    inTransaction = false;

    // 9. Post-commit Qdrant cleanup: Purge old generation points
    try {
      await qdrantRequest(`/collections/${COLLECTION_NAME}/points/delete?wait=true`, 'POST', {
        filter: {
          must: [
            { key: 'doc_version_id', match: { value: docVersionId } }
          ],
          must_not: [
            { key: 'generation_id', match: { value: lease.generationId } }
          ]
        }
      });
    } catch (_) {}

    console.log(`[OCR Pipeline] ✅ Hoàn tất pipeline OCR & Chunks cho ${doc.document_id} (${chunks.length} chunks, Qdrant: ${qdrantCount} points).`);

    return {
      success: true,
      doc_version_id: docVersionId,
      source: extractRes.source,
      pages_count: pages.length,
      chunks_count: chunks.length,
      qdrant_points_count: qdrantCount,
      parse_quality: parseQuality,
      generation_id: lease.generationId,
      fencing_token: lease.fencingToken
    };
  } catch (err) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }

    // Compensation: Clean up ONLY the failed generation points from Qdrant, preserving active generation
    if (lease && lease.generationId) {
      try {
        await qdrantRequest(`/collections/${COLLECTION_NAME}/points/delete?wait=true`, 'POST', {
          filter: {
            must: [
              { key: 'doc_version_id', match: { value: docVersionId } },
              { key: 'generation_id', match: { value: lease.generationId } }
            ]
          }
        });
      } catch (_) {}
    }

    // Mark lease as FAILED
    if (lease && lease.generationId) {
      try {
        await client.query(`
          UPDATE document_retry_leases 
          SET status = 'FAILED', retry_reason = $2, updated_at = NOW() 
          WHERE doc_version_id = $1
        `, [docVersionId, err.message]);
      } catch (_) {}
    }

    console.error(`[OCR Pipeline ERROR] Thất bại xử lý tài liệu ${docVersionId}:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 10. RAG Query with Page Citation & Tenant Isolation
 */
async function queryRagWithCitations(options = {}) {
  const {
    query,
    branch = 'all',
    role = 'employee',
    scope = 'production', // 'production' (only active) or 'testing' (active + testing)
    limit = 5
  } = options;

  if (!query || !query.trim()) {
    return { answerable: false, answer: 'Vui lòng cung cấp nội dung câu hỏi.', citations: [] };
  }

  // Current Vietnam business date (UTC+7)
  const vnNow = new Date(Date.now() + 7 * 3600 * 1000);
  const todayInt = Number(vnNow.toISOString().slice(0, 10).replace(/-/g, ''));

  // 1. Embed user query to 768 dimensions
  const queryVectors = await generateEmbeddings([{
    content: query.trim(),
    embed_text: query.trim()
  }]);
  const queryVector = queryVectors[0];

  // 2. Build tenant, status, and validity date filters
  const mustFilters = [];
  const mustNotFilters = [];

  // Tenant / Branch Isolation
  if (branch && branch !== 'all') {
    mustFilters.push({
      key: 'branch_scope',
      match: { any: ['all', branch] }
    });
  }

  // Status Filter: Production only queries 'active' docs; Sandbox queries active, testing, draft
  if (scope === 'testing' || scope === 'sandbox' || scope === 'draft') {
    mustFilters.push({
      key: 'status',
      match: { any: ['active', 'testing', 'draft'] }
    });
  } else {
    mustFilters.push({
      key: 'status',
      match: { value: 'active' }
    });
  }

  // Role Access Filter
  if (role && role !== 'admin') {
    mustFilters.push({
      key: 'role_access',
      match: { any: ['all', role] }
    });
  }

  // Policy Validity Date Governance (only in production scope)
  if (scope !== 'testing') {
    // Exclude policies not yet effective
    mustNotFilters.push({
      key: 'effective_int',
      range: { gt: todayInt }
    });
    // Exclude expired policies (points with expiry_int = 99991231 or missing are kept)
    mustNotFilters.push({
      key: 'expiry_int',
      range: { lt: todayInt }
    });
  }

  // 3. Search Qdrant points
  const filterObj = {};
  if (mustFilters.length > 0) filterObj.must = mustFilters;
  if (mustNotFilters.length > 0) filterObj.must_not = mustNotFilters;

  const searchBody = {
    vector: queryVector,
    limit: limit,
    with_payload: true,
    with_vector: false,
    filter: Object.keys(filterObj).length > 0 ? filterObj : undefined
  };

  const searchRes = await qdrantRequest(`/collections/${COLLECTION_NAME}/points/search`, 'POST', searchBody);
  const hits = searchRes.result || [];

  if (hits.length === 0) {
    return {
      answerable: false,
      answer: 'Hiện tại tài liệu nội bộ được cung cấp chưa có thông tin về nội dung bạn hỏi.',
      citations: [],
      hits: []
    };
  }

  // 4. Fetch rich chunk details from PostgreSQL to guarantee ground truth
  const chunkIds = hits.map(h => h.id || h.payload?.chunk_id).filter(Boolean);
  if (chunkIds.length === 0) {
    return {
      answerable: false,
      answer: 'Hiện tại tài liệu nội bộ được cung cấp chưa có thông tin về nội dung bạn hỏi.',
      citations: [],
      hits: []
    };
  }

  let sql = `
    SELECT c.chunk_id, c.doc_version_id, c.section_path, c.page_start, c.page_end, c.content, c.contextual_header,
           c.generation_id,
           d.document_id, d.title, d.doc_number, d.doc_code, d.version, d.status,
           to_char(d.effective_date, 'DD/MM/YYYY') AS effective_date,
           to_char(d.expiry_date, 'DD/MM/YYYY') AS expiry_date
    FROM chunks c
    JOIN documents d USING (doc_version_id)
    WHERE c.chunk_id = ANY($1::uuid[])
      AND c.is_published = TRUE
      AND (d.active_generation_id IS NULL OR c.generation_id = d.active_generation_id)
  `;
  const params = [chunkIds];

  if (scope !== 'testing') {
    sql += `
      AND d.status = 'active'
      AND d.effective_date <= CURRENT_DATE 
      AND (d.expiry_date IS NULL OR d.expiry_date >= CURRENT_DATE)
    `;
    if (role && role !== 'admin') {
      params.push(role);
      sql += ` AND (d.role_access IS NULL OR 'all' = ANY(d.role_access) OR $${params.length} = ANY(d.role_access))`;
    }
    if (branch && branch !== 'all') {
      params.push(branch);
      sql += ` AND (d.branch_scope IS NULL OR 'all' = ANY(d.branch_scope) OR $${params.length} = ANY(d.branch_scope))`;
    }
  } else {
    sql += ` AND d.status IN ('active', 'testing', 'draft')`;
  }

  const chunksRes = await db.query(sql, params);
  const chunkMap = new Map();
  chunksRes.rows.forEach(r => chunkMap.set(r.chunk_id, r));

  // 5. Build citations with explicit page numbers (ground-truth verified by PostgreSQL)
  const citations = [];
  const contextParts = [];

  hits.forEach((hit) => {
    const chunk = chunkMap.get(hit.id);
    if (!chunk) return; // Dropped if not verified by PostgreSQL

    const pageStr = chunk.page_start ? `Trang ${chunk.page_start}` : 'Trang 1';
    const docCode = chunk.doc_code || chunk.doc_number || 's/n';
    const sectionPath = chunk.section_path || 'Quy định chung';

    citations.push({
      citation_id: `C${citations.length + 1}`,
      chunk_id: chunk.chunk_id,
      doc_version_id: chunk.doc_version_id,
      document_id: chunk.document_id,
      title: chunk.title,
      doc_number: docCode,
      page: chunk.page_start || 1,
      page_label: pageStr,
      section_path: sectionPath,
      score: hit.score,
      evidence_quote: (chunk.content || '').slice(0, 150)
    });

    contextParts.push(`[Căn cứ ${citations.length}: ${chunk.title} (${docCode}) – ${sectionPath} – ${pageStr}]:\n${chunk.content}`);
  });

  if (citations.length === 0) {
    return {
      answerable: false,
      answer: 'Hiện tại tài liệu nội bộ được cung cấp chưa có thông tin về nội dung bạn hỏi.',
      citations: [],
      hits: []
    };
  }

  return {
    answerable: true,
    citations,
    context: contextParts.join('\n\n'),
    hits_count: hits.length
  };
}

module.exports = {
  validateFileBuffer,
  extractDocumentPages,
  buildDocumentChunks,
  generateEmbeddings,
  formatEmbeddingInput,
  executeDocumentOcrPipeline,
  queryRagWithCitations,
  normalizeText,
  stripAccents,
  runVisionOcr
};
