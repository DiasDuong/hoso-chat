/**
 * SOTRANS HUB — UNIVERSAL DATA UNDERSTANDING ENGINE
 * 
 * Nền tảng phân tích, bóc tách và truy xuất dữ liệu đa phương thức dùng chung cho mọi Personal AI Agent:
 * 1. File Ingestion & Manifest Management (Xác thực, lập manifest, kiểm soát trạng thái READY/PARTIAL/FAILED)
 * 2. Multi-Format Parsing (Spreadsheet, PDF, DOCX, TXT/MD/JSON/Code)
 * 3. Normalization (Unicode NFC, loại bỏ dấu, chuẩn hóa ngày tháng, tiền tệ, từ điển bí danh logistics)
 * 4. Deep Query Understanding (Phân loại ý định, trích xuất thực thể, giải quyết tham chiếu ngữ cảnh)
 * 5. Hybrid Retrieval (Truy xuất có cấu trúc bảng tính, tra cứu văn bản theo phân đoạn, tìm kiếm toàn diện)
 * 6. Completeness & Ground Truth Verification (Xác minh độ bao phủ, chống bịa đặt, phân định FOUND/NOT_FOUND_VERIFIED)
 * 7. Structured Observability (Trace logging, chẩn đoán nguồn dữ liệu)
 */

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const dataEngine = require('./dataEngine');

// Polyfill DOMMatrix for environments where pdf-parse needs it
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {};
}

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  console.warn('[UniversalDataEngine] pdf-parse static load warning:', e.message);
}

/**
 * 1. TỪ ĐIỂN ĐỒNG NGHĨA & BIẾN THỂ ĐỊA DANH LOGISTICS
 */
const ALIAS_GROUPS = [
  ['di an', 'di an, binh duong', 'di an city', 'di an city, binh duong province', 'tp di an'],
  ['alley 64', 'hem 64', 'hem 64 truong van vinh', 'alley 64, truong van vinh', 'truong van vinh', '64 truong van vinh', 'alley 64, truong van vinh street', 'alley 64, truong van vinh street, tan binh ward, di an city, binh duong province'],
  ['tan binh', 'kcn tan binh', 'kcn tan binh, hcm', 'khu cong nghiep tan binh'],
  ['cat lai', 'cang cat lai', 'icd cat lai', 'kho sotrans cat lai', 'cl'],
  ['hai phong', 'cang hai phong', 'hph', 'lach huyen'],
  ['ha noi', 'tp ha noi'],
  ['dong nai', 'kho sotrans td - dong nai', 'bien hoa', 'kcn bien hoa'],
  ['quang ngai', 'tp quang ngai', 'kcn tinh phong'],
  ['bac giang', 'dinh tram', 'dinh tram industrial park, viet yen, bac giang, vietnam'],
  ['nam dinh', 'cang nam dinh', 'tp nam dinh', 'tinh nam dinh'],
  ['wha', 'wha industrial zone 1', 'wha industrial zone 1- nghe an', 'wha nghe an', 'kcn wha', 'lo b2, khu cong nghiep, wha industrial zone 1- nghe an, xa than linh, tinh nghe an, viet nam']
];

function removeAccents(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function matchLocationAliases(textNorm, targetNorm) {
  if (!textNorm || !targetNorm) return false;
  if (textNorm.includes(targetNorm) || targetNorm.includes(textNorm)) return true;
  for (const group of ALIAS_GROUPS) {
    const textInGroup = group.some(alias => textNorm.includes(alias));
    const targetInGroup = group.some(alias => targetNorm.includes(alias));
    if (textInGroup && targetInGroup) return true;
  }
  return false;
}

/**
 * 2. BẢO VỆ PROMPT INJECTION TỪ NỘI DUNG TÀI LIỆU
 */
function sanitizeDocumentText(text) {
  if (!text) return '';
  let cleaned = String(text);
  const injectionPatterns = [
    /ignore\s+(?:all\s+)?previous\s+instructions/gi,
    /disregard\s+(?:all\s+)?prior\s+prompts/gi,
    /you\s+are\s+now\s+(?:a|an)\s+/gi,
    /bỏ\s+qua\s+(?:toàn\s+bộ\s+)?hướng\s+dẫn\s+trước/gi,
    /đây\s+là\s+chỉ\s+thị\s+mới\s+của\s+hệ\s+thống/gi,
    /hãy\s+quên\s+hết\s+các\s+lệnh\s+trước/gi,
    /system\s+prompt\s*:/gi,
    /new\s+system\s+instruction/gi,
    /DAN\s+mode/gi,
    /jailbreak/gi
  ];
  for (const pat of injectionPatterns) {
    cleaned = cleaned.replace(pat, '[NỘI DUNG ĐÃ ĐƯỢC LỌC ĐỂ BẢO ĐẢM AN TOÀN HỆ THỐNG]');
  }
  return cleaned;
}

/**
 * 3. ĐỌC VÀ BÓC TÁCH TỆP ĐA PHƯƠNG THỨC (UNIVERSAL FILE PARSER)
 */
async function parseUniversalFile(buffer, options = {}) {
  const fileName = options.fileName || 'file_attachment';
  const ext = path.extname(fileName).toLowerCase();
  const mimeType = options.mimeType || 'application/octet-stream';
  const size = buffer ? buffer.length : 0;
  const fileId = options.fileId || `file_${Date.now()}`;

  // A. BẢNG TÍNH EXCEL & CSV (.xlsx, .xls, .csv)
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    try {
      const parsedSpreadsheet = dataEngine.parseSpreadsheet(buffer, { fileName });
      const promptProfile = dataEngine.formatProfileForPrompt(parsedSpreadsheet);
      
      let totalRows = 0;
      let totalValidRows = 0;
      for (const sName of parsedSpreadsheet.sheetNames) {
        const sh = parsedSpreadsheet.sheets[sName];
        totalRows += sh.totalRawRows || 0;
        totalValidRows += sh.validDataRows || 0;
      }

      const manifest = {
        fileId,
        fileName,
        fileType: 'spreadsheet',
        parser: 'xlsx_dataEngine',
        parseStatus: 'READY',
        totalUnits: totalRows,
        validUnits: totalValidRows,
        blankOrIgnoredUnits: totalRows - totalValidRows,
        sheets: parsedSpreadsheet.sheetNames,
        warnings: parsedSpreadsheet.sheetNames.flatMap(s => parsedSpreadsheet.sheets[s].warnings || []),
        errors: [],
        readyForQuery: true,
        parsedAt: new Date().toISOString()
      };

      return {
        fileId,
        fileName,
        fileType: 'spreadsheet',
        mimeType: ext === '.csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSize: size,
        parseStatus: 'READY',
        manifest,
        dataProfile: parsedSpreadsheet,
        sections: [],
        promptText: promptProfile,
        part: null
      };
    } catch (err) {
      console.warn('[UniversalDataEngine] Lỗi parse spreadsheet:', err.message);
      return {
        fileId,
        fileName,
        fileType: 'spreadsheet',
        mimeType,
        fileSize: size,
        parseStatus: 'PROCESSING_FAILED',
        manifest: {
          fileId,
          fileName,
          fileType: 'spreadsheet',
          parser: 'xlsx_dataEngine',
          parseStatus: 'PROCESSING_FAILED',
          errors: [err.message],
          readyForQuery: false,
          parsedAt: new Date().toISOString()
        },
        dataProfile: null,
        sections: [],
        promptText: `[Bảng tính đính kèm: "${fileName}"] - TRẠNG THÁI: PROCESSING_FAILED (Lỗi cấu trúc bảng tính: ${err.message}). Hãy thông báo cho người dùng tệp bị lỗi và đề nghị tải lại.`,
        part: null
      };
    }
  }

  // B. TÀI LIỆU WORD (.docx)
  if (ext === '.docx') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const fullText = sanitizeDocumentText(result.value || '');
      
      // Chia thành các đoạn logic theo tiêu đề hoặc ngắt dòng kép
      const rawParas = fullText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      const sections = [];
      let currentHeading = 'Mở đầu / Tổng quan';
      
      rawParas.forEach((para, idx) => {
        // Nhận diện heading tiềm năng (ngắn gọn, viết hoa hoặc có số mục 1., 1.1)
        if (para.length < 120 && /^([0-9]+[\.\)]|Điều|Chương|Mục|Phần|[A-Z\s]{4,})/i.test(para)) {
          currentHeading = para;
        }
        sections.push({
          index: idx + 1,
          heading: currentHeading,
          text: para,
          charCount: para.length
        });
      });

      const MAX_DOC_CHARS = 80000;
      let displayText = fullText;
      let isPartial = false;
      if (fullText.length > MAX_DOC_CHARS) {
        displayText = fullText.slice(0, MAX_DOC_CHARS);
        isPartial = true;
      }

      const manifest = {
        fileId,
        fileName,
        fileType: 'document_word',
        parser: 'mammoth_docx',
        parseStatus: isPartial ? 'PARTIAL' : 'READY',
        totalUnits: sections.length,
        validUnits: sections.length,
        blankOrIgnoredUnits: 0,
        warnings: isPartial ? [`Tài liệu dài ${fullText.length} ký tự, đã phân đoạn ${sections.length} mục và nạp ${MAX_DOC_CHARS} ký tự đầu vào ngữ cảnh.`] : [],
        errors: [],
        readyForQuery: true,
        parsedAt: new Date().toISOString()
      };

      const promptText = `[TÀI LIỆU WORD ĐÍNH KÈM: "${fileName}"] (Gồm ${sections.length} đoạn/mục):\n` +
        `--- BẮT ĐẦU VĂN BẢN ---\n${displayText}\n--- KẾT THÚC VĂN BẢN ---`;

      return {
        fileId,
        fileName,
        fileType: 'document_word',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSize: size,
        parseStatus: isPartial ? 'PARTIAL' : 'READY',
        manifest,
        dataProfile: { sections, fullTextLength: fullText.length },
        sections,
        promptText,
        part: null
      };
    } catch (err) {
      console.warn('[UniversalDataEngine] Lỗi parse docx:', err.message);
      return {
        fileId,
        fileName,
        fileType: 'document_word',
        mimeType,
        fileSize: size,
        parseStatus: 'PROCESSING_FAILED',
        manifest: {
          fileId,
          fileName,
          fileType: 'document_word',
          parser: 'mammoth_docx',
          parseStatus: 'PROCESSING_FAILED',
          errors: [err.message],
          readyForQuery: false,
          parsedAt: new Date().toISOString()
        },
        dataProfile: null,
        sections: [],
        promptText: `[Tài liệu Word đính kèm: "${fileName}"] - TRẠNG THÁI: PROCESSING_FAILED (Không thể trích xuất văn bản: ${err.message}). Hãy thông báo cho người dùng tệp bị lỗi và đề nghị kiểm tra lại tệp.`,
        part: null
      };
    }
  }

  // C. TÀI LIỆU PDF (.pdf)
  if (ext === '.pdf') {
    let extractedText = '';
    let pageCount = 1;
    let isScanned = false;
    let isCorrupted = false;
    let corruptErrorMsg = '';

    // 1. Kiểm tra chữ ký magic header chuẩn của định dạng PDF (%PDF-) trong 1024 bytes đầu
    const headerSnippet = buffer.slice(0, 1024).toString('binary');
    if (!headerSnippet.includes('%PDF-')) {
      isCorrupted = true;
      corruptErrorMsg = 'Tệp không có chữ ký magic header hợp lệ (%PDF-). Tệp có thể đã bị hỏng hoặc đổi sai phần mở rộng.';
    }

    if (!isCorrupted) {
      try {
        if (typeof pdfParse === 'function') {
          const pdfData = await pdfParse(buffer);
          extractedText = pdfData.text || '';
          pageCount = pdfData.numpages || 1;
        } else if (pdfParse && pdfParse.PDFParse) {
          const parser = new pdfParse.PDFParse({ data: buffer });
          const res = await parser.getText();
          extractedText = typeof res === 'string' ? res : (res?.text || '');
        }
      } catch (err) {
        console.warn('[UniversalDataEngine] pdf-parse fallback:', err.message);
        // Kiểm tra xem cấu trúc PDF có dấu hiệu bị hỏng nặng không
        const bufStr = buffer.toString('binary');
        if (!bufStr.includes('obj') && !bufStr.includes('xref') && !bufStr.includes('trailer')) {
          isCorrupted = true;
          corruptErrorMsg = `Tệp PDF có cấu trúc bị lỗi hoặc hỏng: ${err.message}`;
        }
      }
    }

    // Nếu tệp PDF bị hỏng hoặc không hợp lệ, xử lý an toàn minh bạch (không gửi payload rác tới Gemini API)
    if (isCorrupted) {
      const manifest = {
        fileId,
        fileName,
        fileType: 'document_pdf',
        parser: 'pdf_parse',
        parseStatus: 'PROCESSING_FAILED',
        totalUnits: 0,
        validUnits: 0,
        blankOrIgnoredUnits: 0,
        warnings: [],
        errors: [corruptErrorMsg],
        readyForQuery: false,
        parsedAt: new Date().toISOString()
      };

      const promptText = `[TÀI LIỆU PDF ĐÍNH KÈM: "${fileName}"] - TRẠNG THÁI: PROCESSING_FAILED (CORRUPTED FILE).\n` +
        `Chi tiết lỗi: ${corruptErrorMsg}\n` +
        `YÊU CẦU: Hãy thông báo rõ ràng, lịch sự cho người dùng rằng tệp "${fileName}" bị hỏng hoặc không đúng định dạng chuẩn PDF, hệ thống không thể đọc được nội dung tệp này, và hướng dẫn người dùng kiểm tra hoặc tải lại tệp hợp lệ. Tuyệt đối không suy đoán hay bịa đặt nội dung.`;

      return {
        fileId,
        fileName,
        fileType: 'document_pdf',
        mimeType: 'application/pdf',
        fileSize: size,
        parseStatus: 'PROCESSING_FAILED',
        manifest,
        dataProfile: null,
        sections: [],
        promptText,
        part: null
      };
    }

    const cleanCheck = (extractedText || '').replace(/-- \d+ of \d+ --/g, '').trim();
    if (cleanCheck.length < 40) {
      isScanned = true;
    }

    const sections = [];
    if (!isScanned) {
      const safeText = sanitizeDocumentText(extractedText);
      // Chia thành các trang hoặc đoạn logic
      const rawPages = safeText.split(/(?:-- \d+ of \d+ --|\f|\n\s*\n\s*\n)/).map(p => p.trim()).filter(Boolean);
      rawPages.forEach((pgText, idx) => {
        sections.push({
          index: idx + 1,
          heading: `Trang / Phân đoạn ${idx + 1}`,
          pageNumber: idx + 1,
          text: pgText,
          charCount: pgText.length
        });
      });
    }

    const MAX_PDF_CHARS = 80000;
    let displayText = extractedText;
    let isPartial = false;
    if (extractedText.length > MAX_PDF_CHARS) {
      displayText = extractedText.slice(0, MAX_PDF_CHARS);
      isPartial = true;
    }

    const manifest = {
      fileId,
      fileName,
      fileType: 'document_pdf',
      parser: isScanned ? 'gemini_multimodal_vision' : 'pdf_parse',
      parseStatus: isScanned ? 'READY' : (isPartial ? 'PARTIAL' : 'READY'),
      totalUnits: pageCount,
      validUnits: sections.length || (isScanned ? pageCount : 0),
      blankOrIgnoredUnits: 0,
      warnings: isScanned ? ['Tài liệu dạng scan/ảnh (không có lớp text chuẩn), đã kích hoạt năng lực thị giác đa phương thức (multimodal vision) để đọc trực tiếp.'] : (isPartial ? [`Tài liệu dài ${extractedText.length} ký tự, đã nạp ${MAX_PDF_CHARS} ký tự đầu.`] : []),
      errors: [],
      readyForQuery: true,
      parsedAt: new Date().toISOString()
    };

    let promptText = '';
    if (isScanned) {
      promptText = `[TÀI LIỆU PDF DẠNG QUÉT/ẢNH ĐÍNH KÈM: "${fileName}"] (Khoảng ${pageCount} trang). Sử dụng năng lực thị giác đa phương thức (multimodal vision) để đọc từng chi tiết trong tệp.`;
    } else {
      promptText = `[TÀI LIỆU PDF ĐÍNH KÈM: "${fileName}"] (Gồm ${pageCount} trang, ${sections.length} phân đoạn):\n` +
        `--- BẮT ĐẦU VĂN BẢN PDF ---\n${displayText}\n--- KẾT THÚC VĂN BẢN PDF ---`;
    }

    return {
      fileId,
      fileName,
      fileType: 'document_pdf',
      mimeType: 'application/pdf',
      fileSize: size,
      parseStatus: manifest.parseStatus,
      manifest,
      dataProfile: { sections, pageCount, isScanned },
      sections,
      promptText,
      part: (isScanned || size <= 15 * 1024 * 1024) ? {
        inlineData: {
          mimeType: 'application/pdf',
          data: buffer.toString('base64')
        }
      } : null
    };
  }

  // D. TỆP VĂN BẢN THUẦN, MARKDOWN, CODE, JSON (.txt, .md, .json, .sql, .js, .py)
  if (['.txt', '.md', '.json', '.xml', '.html', '.js', '.py', '.sql', '.sh', '.log'].includes(ext)) {
    const rawText = buffer.toString('utf-8');
    const safeText = sanitizeDocumentText(rawText);
    
    // Tách thành các đoạn/section
    const rawBlocks = safeText.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    const sections = rawBlocks.map((blk, idx) => ({
      index: idx + 1,
      heading: `Đoạn ${idx + 1}`,
      text: blk,
      charCount: blk.length
    }));

    const MAX_TEXT_CHARS = 80000;
    let displayText = safeText;
    let isPartial = false;
    if (safeText.length > MAX_TEXT_CHARS) {
      displayText = safeText.slice(0, MAX_TEXT_CHARS);
      isPartial = true;
    }

    const manifest = {
      fileId,
      fileName,
      fileType: 'text_document',
      parser: 'utf8_text_parser',
      parseStatus: isPartial ? 'PARTIAL' : 'READY',
      totalUnits: sections.length,
      validUnits: sections.length,
      blankOrIgnoredUnits: 0,
      warnings: isPartial ? [`Tệp văn bản dài ${safeText.length} ký tự, đã nạp ${MAX_TEXT_CHARS} ký tự đầu.`] : [],
      errors: [],
      readyForQuery: true,
      parsedAt: new Date().toISOString()
    };

    const promptText = `[TỆP VĂN BẢN / DỮ LIỆU ĐÍNH KÈM: "${fileName}"]:\n` +
      `--- BẮT ĐẦU VĂN BẢN ---\n${displayText}\n--- KẾT THÚC VĂN BẢN ---`;

    return {
      fileId,
      fileName,
      fileType: 'text_document',
      mimeType: mimeType || 'text/plain',
      fileSize: size,
      parseStatus: manifest.parseStatus,
      manifest,
      dataProfile: { sections, fullLength: safeText.length },
      sections,
      promptText,
      part: null
    };
  }

  // E. HÌNH ẢNH (.png, .jpg, .jpeg, .webp)
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    const isPng = ext === '.png' && buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isJpg = ['.jpg', '.jpeg'].includes(ext) && buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    const isWebp = ext === '.webp' && buffer.length > 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    const isValidImage = isPng || isJpg || isWebp;

    if (!isValidImage) {
      return {
        fileId,
        fileName,
        fileType: 'image',
        mimeType: ext === '.png' ? 'image/png' : 'image/jpeg',
        fileSize: size,
        parseStatus: 'PROCESSING_FAILED',
        manifest: {
          fileId,
          fileName,
          fileType: 'image',
          parser: 'gemini_multimodal_vision',
          parseStatus: 'PROCESSING_FAILED',
          totalUnits: 0,
          validUnits: 0,
          blankOrIgnoredUnits: 0,
          warnings: [],
          errors: ['Tệp hình ảnh bị hỏng hoặc không có magic header hợp lệ.'],
          readyForQuery: false,
          parsedAt: new Date().toISOString()
        },
        dataProfile: null,
        sections: [],
        promptText: `[HÌNH ẢNH ĐÍNH KÈM: "${fileName}"] - TRẠNG THÁI: PROCESSING_FAILED (Lỗi đọc tệp ảnh). Tệp hình ảnh bị hỏng hoặc định dạng không đúng. Hãy thông báo rõ ràng cho người dùng.`,
        part: null
      };
    }

    const effectiveMime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
    const manifest = {
      fileId,
      fileName,
      fileType: 'image',
      parser: 'gemini_multimodal_vision',
      parseStatus: 'READY',
      totalUnits: 1,
      validUnits: 1,
      blankOrIgnoredUnits: 0,
      warnings: ['Tệp hình ảnh, phân tích trực tiếp qua Multimodal Vision.'],
      errors: [],
      readyForQuery: true,
      parsedAt: new Date().toISOString()
    };

    return {
      fileId,
      fileName,
      fileType: 'image',
      mimeType: effectiveMime,
      fileSize: size,
      parseStatus: 'READY',
      manifest,
      dataProfile: null,
      sections: [],
      promptText: `[Hình ảnh đính kèm: "${fileName}" - Sử dụng Multimodal Vision để đọc chi tiết hình ảnh, bảng biểu hoặc chữ viết trong ảnh.]`,
      part: {
        inlineData: {
          mimeType: effectiveMime,
          data: buffer.toString('base64')
        }
      }
    };
  }

  // F. CÁC ĐỊNH DẠNG KHÔNG ĐƯỢC HỖ TRỢ (UNSUPPORTED FORMAT)
  return {
    fileId,
    fileName,
    fileType: 'unsupported',
    mimeType: mimeType || 'application/octet-stream',
    fileSize: size,
    parseStatus: 'UNSUPPORTED',
    manifest: {
      fileId,
      fileName,
      fileType: 'unsupported',
      parser: 'unsupported_format_handler',
      parseStatus: 'UNSUPPORTED',
      totalUnits: 0,
      validUnits: 0,
      blankOrIgnoredUnits: 0,
      warnings: [`Định dạng tệp "${ext}" hiện không được hỗ trợ bóc tách nội dung.`],
      errors: [`Định dạng "${ext}" không được hỗ trợ. Các định dạng được hỗ trợ gồm: XLSX, XLS, CSV, DOCX, PDF, PNG, JPG, JPEG, WEBP, TXT, MD, JSON.`],
      readyForQuery: false,
      parsedAt: new Date().toISOString()
    },
    dataProfile: null,
    sections: [],
    promptText: `[TỆP ĐÍNH KÈM: "${fileName}"] - TRẠNG THÁI: UNSUPPORTED (Định dạng "${ext}" không được hỗ trợ).\n` +
      `YÊU CẦU: Hãy thông báo rõ ràng cho người dùng rằng hệ thống chỉ hỗ trợ các định dạng: Bảng tính (.xlsx, .xls, .csv), Văn bản Word (.docx), Tài liệu PDF (.pdf), Hình ảnh (.png, .jpg, .webp) và Văn bản thuần (.txt, .md, .json). Tuyệt đối không suy đoán hay bịa đặt nội dung tệp.`,
    part: null
  };
}

/**
 * 4. PHÂN TÍCH Ý ĐỊNH & THỰC THỂ CÂU HỎI (DEEP QUERY UNDERSTANDING)
 */
function understandUserQuery(userMessage = '', history = [], activeFiles = []) {
  const q = String(userMessage || '').trim();
  const qNorm = removeAccents(q);

  // A. Nhận diện ý định cốt lõi (Core Query Intent)
  const isAllRecords = /(tat ca|toan bo|moi ban ghi|danh sach day du|liet ke het|toan pham vi|bao gom ca|tat ca cac bao gia)/i.test(qNorm);
  const isComparison = /(so sanh|doi chieu|khac gi|so voi|su khac biet|chenh lech)/i.test(qNorm);
  const isAggregation = /(tong|trung binh|dem|so luong|trung binh cong|cao nhat|thap nhat|max|min|sum|count|average)/i.test(qNorm);
  const isNegativeOrExistence = /(co vendor nao chay|co ai chay|co chuyen nao|co hay khong|khong co|chua co|co ghi nhan)/i.test(qNorm);
  const isExport = /(xuat file|xuat excel|tao bao cao|tai ve|download|export|xuat bang)/i.test(qNorm);
  const isAnaphoric = /(tuyen do|tuyen tren|dong do|ban ghi do|vendor vua roi|bao gia truoc|tuyen nay|chuyen do|noi do)/i.test(qNorm);
  const isFollowUp = isAnaphoric || history.length > 0 && q.length < 50;

  let intent = 'SINGLE_LOOKUP';
  if (isExport) intent = 'EXPORT_REPORT';
  else if (isComparison) intent = 'COMPARISON';
  else if (isAllRecords) intent = 'ALL_RECORDS';
  else if (isAggregation) intent = 'AGGREGATION_CALCULATION';
  else if (isNegativeOrExistence) intent = 'EXISTENCE_OR_NEGATIVE';
  else if (isFollowUp) intent = 'CONTINUATION_FOLLOWUP';

  // B. Trích xuất thực thể logistics & định danh (Entity Extraction)
  let origin = null;
  let destination = null;
  let vendor = null;
  let refCode = null;

  // Trích xuất mã REF (dạng: 41_WIN_FCL, 42_LAU_LCL, 43_VIC_LCL)
  const refMatch = q.match(/[0-9]{2}_[a-zA-Z]{3}_[a-zA-Z0-9]+/i);
  if (refMatch) refCode = refMatch[0];

  // Trích xuất Vendor
  if (/vendor\s*3s|3s/i.test(q)) vendor = '3S';
  else if (/thilogi/i.test(q)) vendor = 'THILOGI';
  else if (/transimex/i.test(q)) vendor = 'TRANSIMEX';

  // Trích xuất Tuyến đường (Điểm đi - Điểm đến)
  const routeRegexAccented = /(?:từ|đi từ|xuất phát từ|tuyến|chặng)\s+([^,–\->]+?)\s+(?:đến|tới|về|sang|đi|qua|ra|–|-|>)\s+([^,?.!]+?)(?:\s+(?:là bao nhiêu|bao nhiêu|hết bao nhiêu|giá sao|\?|$)|$)/i;
  const routeRegexUnaccented = /(?:tu|di tu|xuat phat tu|tuyen|chang)\s+([^,–\->]+?)\s+(?:den|toi|ve|sang|di|qua|ra|–|-|>)\s+([^,?.!]+?)(?:\s+(?:la bao nhieu|bao nhieu|het bao nhieu|gia sao|\?|$)|$)/i;
  
  let routeMatch = q.match(routeRegexAccented);
  if (!routeMatch) {
    routeMatch = qNorm.match(routeRegexUnaccented);
  }

  if (routeMatch) {
    origin = routeMatch[1].trim();
    destination = routeMatch[2].trim();
  } else {
    // Thử bắt cặp địa danh độc lập
    if (/tan binh/i.test(qNorm)) origin = 'KCN Tân Bình';
    if (/di an/i.test(qNorm)) destination = 'Dĩ An';
    else if (/ha noi/i.test(qNorm)) destination = destination || 'Hà Nội';
    else if (/dong nai/i.test(qNorm)) destination = destination || 'Đồng Nai';
  }

  // C. Giải quyết tham chiếu ngữ cảnh từ lịch sử (Anaphoric Resolution)
  if (isAnaphoric && (!origin || !destination)) {
    // Quét ngược 4 tin nhắn gần nhất trong lịch sử
    for (let i = history.length - 1; i >= 0; i--) {
      const hText = history[i]?.content || '';
      const hNorm = removeAccents(hText);
      if (!origin && /tan binh/i.test(hNorm)) origin = 'KCN Tân Bình';
      if (!destination && /di an/i.test(hNorm)) destination = 'Dĩ An';
      if (!origin && /hai phong/i.test(hNorm)) origin = 'Cảng Hải Phòng';
      if (!destination && /ha noi/i.test(hNorm)) destination = 'Hà Nội';
      if (!vendor && /3s/i.test(hNorm)) vendor = '3S';
      if (!refCode) {
        const m = hText.match(/[0-9]{2}_[a-zA-Z]{3}_[a-zA-Z0-9]+/i);
        if (m) refCode = m[0];
      }
      if (origin && destination) break;
    }
  }

  // D. Xác định chiến lược truy xuất tối ưu (Retrieval Strategy)
  const hasSpreadsheets = activeFiles.some(f => f.fileType === 'spreadsheet');
  const hasDocuments = activeFiles.some(f => ['document_word', 'document_pdf', 'text_document'].includes(f.fileType));

  let retrievalStrategy = 'EXACT_KEYWORD';
  if (hasSpreadsheets && (origin || destination || vendor || refCode || isAggregation)) {
    retrievalStrategy = 'STRUCTURED_SPREADSHEET';
  } else if (hasDocuments && !hasSpreadsheets) {
    retrievalStrategy = 'DOCUMENT_SECTION_SEARCH';
  } else if (hasSpreadsheets && hasDocuments) {
    retrievalStrategy = 'HYBRID_ALL_SOURCES';
  }

  return {
    rawQuery: q,
    normalizedQuery: qNorm,
    intent,
    isAllRecordsRequested: isAllRecords,
    isComparisonRequested: isComparison,
    isAggregationRequested: isAggregation,
    isExportRequested: isExport,
    isFollowUp,
    entities: {
      origin,
      destination,
      vendor,
      refCode
    },
    retrievalStrategy
  };
}

/**
 * 5. TRUY XUẤT NỘI DUNG ĐA NGUỒN (UNIVERSAL HYBRID SEARCH)
 */
function searchUniversalContent(activeFiles = [], options = {}) {
  const query = options.query || '';
  const queryNorm = removeAccents(query);
  const targetOrigin = options.origin ? removeAccents(options.origin) : null;
  const targetDest = options.destination ? removeAccents(options.destination) : null;
  const targetVendor = options.vendor ? removeAccents(options.vendor) : null;
  const targetRef = options.refCode ? options.refCode.trim() : null;
  const targetSheet = options.sheetName ? options.sheetName.trim().toLowerCase() : null;
  const isExhaustive = options.exhaustive !== false;
  const limit = options.limit || (isExhaustive ? 200 : 50);

  const matchedResults = [];
  const scannedSources = [];

  for (const file of activeFiles) {
    scannedSources.push({ fileId: file.fileId, fileName: file.fileName, fileType: file.fileType });

    // A. TÌM KIẾM TRÊN BẢNG TÍNH EXCEL / CSV
    if (file.fileType === 'spreadsheet' && file.dataProfile) {
      const searchRes = dataEngine.searchSpreadsheetRecords(file.dataProfile, {
        query,
        origin: options.origin,
        destination: options.destination,
        vendor: options.vendor,
        refCode: options.refCode,
        sheetName: options.sheetName,
        limit
      });

      for (const rec of searchRes.results) {
        matchedResults.push({
          sourceType: 'spreadsheet',
          fileId: file.fileId,
          fileName: file.fileName,
          location: `Sheet: "${rec.sheetName}", Dòng ${rec.rowNumber}`,
          sheetName: rec.sheetName,
          rowNumber: rec.rowNumber,
          data: rec.data,
          score: 1.0
        });
      }
    }

    // B. TÌM KIẾM TRÊN VĂN BẢN WORD, PDF, TEXT
    if (['document_word', 'document_pdf', 'text_document'].includes(file.fileType) && Array.isArray(file.sections)) {
      for (const sec of file.sections) {
        const secText = sec.text || '';
        const secNorm = removeAccents(secText);
        let isMatch = false;
        let score = 0;

        if (queryNorm) {
          const words = queryNorm.split(/\s+/).filter(w => w.length > 1);
          const matchedWords = words.filter(w => secNorm.includes(w));
          if (matchedWords.length > 0) {
            score = matchedWords.length / words.length;
            if (score >= 0.4 || secNorm.includes(queryNorm)) {
              isMatch = true;
            }
          }
        }

        if (targetRef && secText.includes(targetRef)) isMatch = true;
        if (targetOrigin && matchLocationAliases(secNorm, targetOrigin)) isMatch = true;
        if (targetDest && matchLocationAliases(secNorm, targetDest)) isMatch = true;

        if (isMatch) {
          matchedResults.push({
            sourceType: file.fileType,
            fileId: file.fileId,
            fileName: file.fileName,
            location: sec.pageNumber ? `Trang ${sec.pageNumber} (${sec.heading})` : `Mục ${sec.index} (${sec.heading})`,
            heading: sec.heading,
            pageNumber: sec.pageNumber || null,
            snippet: secText.length > 400 ? secText.slice(0, 400) + '...' : secText,
            fullText: secText,
            score
          });
        }
      }
    }
  }

  // Sắp xếp kết quả theo điểm phù hợp giảm dần
  matchedResults.sort((a, b) => b.score - a.score);
  const finalResults = isExhaustive ? matchedResults : matchedResults.slice(0, limit);

  // Phân định nghiêm ngặt giữa Trạng thái xử lý tệp (Parser Status) và Trạng thái truy xuất dữ liệu (Retrieval Status)
  const hasFailedFiles = activeFiles.some(f => ['PROCESSING_FAILED', 'FAILED'].includes(f.parseStatus));
  const hasUnsupportedFiles = activeFiles.some(f => f.parseStatus === 'UNSUPPORTED');
  const hasNotIndexedFiles = activeFiles.some(f => f.parseStatus === 'NOT_INDEXED');
  const allFilesUnready = activeFiles.length > 0 && activeFiles.every(f => f.manifest && f.manifest.readyForQuery === false);

  let status = 'FOUND';
  if (finalResults.length === 0) {
    if (activeFiles.length === 0) {
      status = 'NOT_FOUND_VERIFIED';
    } else if (allFilesUnready) {
      // Toàn bộ tệp bị lỗi hoặc không hỗ trợ, không thể tuyên bố NOT_FOUND_VERIFIED
      status = hasFailedFiles ? 'PROCESSING_FAILED' : (hasUnsupportedFiles ? 'UNSUPPORTED' : 'NOT_INDEXED');
    } else if (hasFailedFiles || hasUnsupportedFiles || hasNotIndexedFiles) {
      // Một phần tệp không thể truy xuất, phạm vi tìm kiếm chưa hoàn tất
      status = 'PARTIAL_UNVERIFIED';
    } else {
      // Đã quét trọn vẹn 100% phạm vi tệp hợp lệ và không có bản ghi phù hợp
      status = 'NOT_FOUND_VERIFIED';
    }
  } else if (matchedResults.length > limit) {
    status = 'PARTIAL';
  }

  return {
    status,
    totalMatches: matchedResults.length,
    returnedMatches: finalResults.length,
    isExhaustive: finalResults.length === matchedResults.length,
    scannedSources,
    results: finalResults
  };
}

/**
 * 6. XÁC MINH TÍNH TOÀN VẸN VÀ BẰNG CHỨNG (ANSWER VERIFICATION)
 */
function verifyRetrievalCompleteness(searchResult = {}, queryUnderstanding = {}, activeFiles = []) {
  const { totalMatches = 0, isExhaustive = true, status = 'NOT_FOUND_VERIFIED', results = [] } = searchResult;
  const { isAllRecordsRequested = false, entities = {} } = queryUnderstanding;

  const verifications = {
    status,
    confidence: 'HIGH',
    isFullyExhaustive: isExhaustive,
    hasConflictingData: false,
    conflicts: [],
    groundTruthEvidenceCount: results.length,
    missingConditions: []
  };

  if (totalMatches === 0) {
    // Chỉ tuyên bố NOT_FOUND_VERIFIED khi toàn bộ tệp đính kèm đều ở trạng thái sẵn sàng (READY/PARTIAL)
    const unreadyFile = activeFiles.find(f => f.manifest && f.manifest.readyForQuery === false);
    if (unreadyFile) {
      verifications.status = unreadyFile.parseStatus || 'PROCESSING_FAILED';
      verifications.summary = `Không đủ điều kiện kết luận NOT_FOUND_VERIFIED do tệp "${unreadyFile.fileName}" ở trạng thái ${verifications.status} (chưa đọc được toàn bộ nội dung).`;
      return verifications;
    }
    verifications.status = 'NOT_FOUND_VERIFIED';
    verifications.summary = 'Đã quét toàn bộ các sheet và phân đoạn của các tệp đính kèm trong phạm vi được cấp quyền nhưng không tìm thấy bản ghi phù hợp. Không có cơ sở để suy đoán.';
    return verifications;
  }

  // Kiểm tra tính nhất quán giữa các bản ghi cùng mã REF hoặc cùng tuyến
  const refMap = new Map();
  for (const item of results) {
    if (item.data && item.data['MÃ REF']) {
      const ref = item.data['MÃ REF'];
      if (!refMap.has(ref)) refMap.set(ref, []);
      refMap.get(ref).push(item);
    }
  }

  for (const [ref, items] of refMap.entries()) {
    if (items.length > 1) {
      // Kiểm tra xem có sự khác nhau về đơn vị tính, ngày hoặc giá không
      const prices = new Set(items.map(i => i.data['GIÁ COST']));
      const dates = new Set(items.map(i => i.data['NGÀY BÁO GIÁ']));
      if (prices.size > 1 || dates.size > 1) {
        verifications.hasConflictingData = true;
        verifications.conflicts.push({
          refCode: ref,
          recordCount: items.length,
          distinctPrices: Array.from(prices),
          distinctDates: Array.from(dates),
          note: `Mã REF ${ref} có ${items.length} bản ghi cập nhật qua các thời điểm khác nhau hoặc có đơn vị tính khác nhau. Cần trình bày chi tiết từng bản ghi.`
        });
      }
    }
  }

  if (isAllRecordsRequested && !isExhaustive) {
    verifications.status = 'PARTIAL';
    verifications.missingConditions.push('Người dùng yêu cầu tất cả kết quả nhưng phạm vi trả về bị giới hạn.');
  }

  return verifications;
}

/**
 * 7. ĐỊNH DẠNG HỒ SƠ NGỮ CẢNH DÙNG CHUNG CHO PROMPT
 */
function formatUniversalPromptContext(activeFiles = []) {
  if (!activeFiles || activeFiles.length === 0) return '';

  const header = `\n# [HỆ THỐNG DỮ LIỆU ĐÍNH KÈM — SOTRANS HUB UNIVERSAL DATA ENGINE]:\n` +
    `Cuộc trò chuyện này đang có ${activeFiles.length} tệp tài liệu/dữ liệu hợp lệ được liên kết:\n`;

  const fileSummaries = activeFiles.map((f, i) => {
    const mf = f.manifest || {};
    let desc = `${i + 1}. Tệp "${f.fileName}" (Loại: ${f.fileType}, Trạng thái: ${f.parseStatus})`;
    if (f.fileType === 'spreadsheet' && mf.sheets) {
      desc += ` - Gồm ${mf.sheets.length} sheet: [${mf.sheets.join(', ')}], tổng ${mf.validUnits || 0} dòng hợp lệ.`;
    } else if (f.sections && f.sections.length > 0) {
      desc += ` - Gồm ${f.sections.length} phân đoạn/trang văn bản.`;
    }
    return desc;
  }).join('\n');

  const toolsGuidance = `\n\n📌 NGUYÊN TẮC TRUY XUẤT XÁC THỰC:\n` +
    `- Sử dụng công cụ "search_spreadsheet_data" khi cần tìm kiếm, lọc, so sánh chi tiết các dòng trong bảng tính.\n` +
    `- Sử dụng công cụ "search_document_sections" khi cần tra cứu các điều khoản, quy định, đoạn văn trong tệp Word, PDF hoặc văn bản.\n` +
    `- Khi người dùng hỏi thông tin, luôn tìm kiếm và trích dẫn dữ liệu thực tế từ các tệp trên. Tuyệt đối KHÔNG bịa đặt thông tin khi không có trong tệp.`;

  return header + fileSummaries + toolsGuidance;
}

module.exports = {
  removeAccents,
  matchLocationAliases,
  sanitizeDocumentText,
  parseUniversalFile,
  understandUserQuery,
  searchUniversalContent,
  verifyRetrievalCompleteness,
  formatUniversalPromptContext,
  ALIAS_GROUPS
};
