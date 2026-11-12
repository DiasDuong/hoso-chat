const fs = require('fs');
const path = require('path');

const wfPath = path.resolve(__dirname, '../n8n-workflows/SOTRANS_HR_EMPLOYEE_LIFECYCLE.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

console.log('Updating nodes in SOTRANS_HR_EMPLOYEE_LIFECYCLE.json...');

for (const n of wf.nodes) {
  // 1. Prepare - Employee Document Batch
  if (n.name === 'Prepare - Employee Document Batch') {
    n.parameters.jsCode = `
const fs = require('fs');
const crypto = require('crypto');

const item = $input.first().json;
const bin = $input.first().binary || {};
const user = item.user;
const batchId = item.batch_id || crypto.randomUUID();

const stagingDir = '/home/node/.n8n-files/staging';
if (!fs.existsSync(stagingDir)) {
  try { fs.mkdirSync(stagingDir, { recursive: true }); } catch(e) {}
}

const fileItems = [];
const validatedFiles = item.validated_files || [];

for (let i = 0; i < validatedFiles.length; i++) {
  const vf = validatedFiles[i];
  const b = bin[vf.binaryKey];
  if (!b) continue;

  const cleanBase = (vf.fileName || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeFileName = batchId + '_' + cleanBase;
  const diskPath = stagingDir + '/' + safeFileName;

  let fileBuf = null;
  if (this.helpers && typeof this.helpers.getBinaryDataBuffer === 'function') {
    try {
      fileBuf = await this.helpers.getBinaryDataBuffer(0, vf.binaryKey);
    } catch (hErr) {
      console.warn('getBinaryDataBuffer fallback:', hErr.message);
    }
  }

  if (!fileBuf && b.data && !String(b.data).startsWith('filesystem-')) {
    try {
      fileBuf = Buffer.from(b.data, 'base64');
    } catch(e) {}
  }

  if (fileBuf) {
    try {
      fs.writeFileSync(diskPath, fileBuf);
    } catch (saveErr) {
      console.warn('Không thể lưu file staging:', saveErr.message);
    }
  }

  const base64Str = fileBuf ? fileBuf.toString('base64') : (b.data && !String(b.data).startsWith('filesystem-') ? b.data : '');

  fileItems.push({
    fileIndex: i,
    binaryKey: vf.binaryKey,
    fileName: vf.fileName,
    mimeType: vf.mimeType || b.mimeType || 'application/pdf',
    fileSize: fileBuf ? fileBuf.length : (vf.approxSize || 0),
    fileStoragePath: '/app/chat-files/staging/' + safeFileName,
    base64Data: base64Str
  });
}

return [{
  json: {
    batch_id: batchId,
    correlation_id: item.correlation_id,
    idempotency_key: item.idempotency_key,
    conversation_id: item.conversation_id,
    company_id: item.company_id,
    user,
    files: fileItems
  }
}];
`;
    console.log('[OK] Updated node: Prepare - Employee Document Batch');
  }

  // 2. Classify - Document Type
  if (n.name === 'Classify - Document Type') {
    n.parameters.jsCode = `
const item = $input.first().json;
const files = item.files || [];

function classify(fn) {
  const f = (fn || '').toLowerCase();
  if (/cccd|can cuoc|cmnd|dinh danh|citizen/i.test(f)) return 'CCCD_VNEID';
  if (/vneid/i.test(f)) return 'VNEID';
  if (/bhyt|bao hiem y te/i.test(f)) return 'BHYT';
  if (/kham suc khoe|ksk|suc khoe/i.test(f)) return 'GIAY_KHAM_SUC_KHOE';
  if (/so yeu ly lich|syll|ly lich/i.test(f)) return 'SO_YEU_LY_LICH';
  if (/cv|resume|ho so ung vien/i.test(f)) return 'CV';
  if (/don xin viec|don ung tuyen/i.test(f)) return 'DON_XIN_VIEC';
  if (/ket hon|hon nhan/i.test(f)) return 'GIAY_DANG_KY_KET_HON';
  if (/quyet dinh|qd|bo nhiem|tiep nhan/i.test(f)) return 'QUYET_DINH_TUYEN_DUNG';
  if (/hop dong|hdld/i.test(f)) return 'HOP_DONG_LAO_DONG';
  if (/bang|chung chi|tot nghiep/i.test(f)) return 'BANG_CAP_CHUNG_CHI';
  return 'KHAC';
}

for (const f of files) {
  f.docType = classify(f.fileName);
}

// Output one item per file so OCR - Gemini Extraction runs independently per PDF
const outputItems = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  outputItems.push({
    json: {
      fileIndex: i,
      totalFiles: files.length,
      fileName: f.fileName,
      docType: f.docType,
      binaryKey: f.binaryKey,
      fileSize: f.fileSize,
      mimeType: f.mimeType,
      fileStoragePath: f.fileStoragePath,
      batch_id: item.batch_id,
      correlation_id: item.correlation_id,
      idempotency_key: item.idempotency_key,
      conversation_id: item.conversation_id,
      company_id: item.company_id,
      user: item.user,
      gemini_parts: [
        {
          inline_data: {
            mime_type: f.mimeType,
            data: f.base64Data
          }
        },
        {
          text: 'Tài liệu: ' + f.fileName + ' (Phân loại: ' + f.docType + ')\\nHãy bóc tách thông tin chi tiết của người lao động từ tài liệu này theo đúng 53 trường dữ liệu chuẩn của SOTRANS.'
        }
      ]
    }
  });
}

return outputItems;
`;
    console.log('[OK] Updated node: Classify - Document Type');
  }

  // 3. OCR - Gemini Extraction
  if (n.name === 'OCR - Gemini Extraction') {
    n.parameters = {
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'Content-Type',
            value: 'application/json'
          }
        ]
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({
        contents: [{ role: "user", parts: $json.gemini_parts }],
        systemInstruction: {
          parts: [{
            text: "Bạn là chuyên gia nhân sự và OCR AI cấp cao của tập đoàn logistics SOTRANS (SOTRANS Hub).\\nNhiệm vụ: Trích xuất thông tin hồ sơ nhân sự từ tài liệu đính kèm (CCCD, Sơ yếu lý lịch, Đơn xin việc, Quyết định tuyển dụng, Hợp đồng lao động, Bằng cấp/Chứng chỉ, v.v.) sang JSON theo đúng 53 trường dữ liệu chuẩn.\\nQUY TẮC:\\n1. Ưu tiên nguồn dữ liệu: VNeID và CCCD là căn cứ pháp lý cao nhất cho họ tên, số CCCD, ngày sinh, quê quán, nơi thường trú. Quyết định tuyển dụng/Hợp đồng lao động là căn cứ cho chức danh, phòng ban, lương và hợp đồng.\\n2. Đọc toàn bộ nội dung tài liệu PDF, quét qua tất cả các trang, phân biệt rõ chữ viết tay và chữ in (chữ in/điện tử có độ ưu tiên cao hơn chữ viết tay).\\n3. Giữ nguyên dấu tiếng Việt chuẩn Unicode, không tự ý sửa đổi khi OCR thiếu độ tin cậy.\\n4. Tuyệt đối KHÔNG suy đoán họ tên, số CCCD hoặc địa chỉ nếu tài liệu không thể hiện rõ ràng.\\n5. Số CCCD: 9 hoặc 12 số nguyên vẹn, không chứa dấu cách hay ký tự lạ.\\n6. Họ và tên: Viết HOA có dấu (ví dụ: NGUYỄN VĂN A).\\n7. Ngày tháng: YYYY-MM-DD.\\n8. Trả về đúng JSON thuần túy có các trường: job_grade, employee_id, full_name, date_of_birth, gender, job_title, professional_title, department_staffing_plan, section_staffing_plan, citizen_id, citizen_id_issue_date, citizen_id_issue_place, birth_registration_place, place_of_origin, permanent_address, temporary_address, current_address, ethnicity, education_level, education_code, qualification, professional_qualification, specialization, degree_qualification, training_institution, major, training_mode, training_period, graduation_grade, degree_valid_until, other_professional_certificates, social_insurance_salary, total_income, base_salary, productivity_responsibility_pay, attendance_bonus, responsibility_allowance, vessel_size_allowance, professional_allowance_t1, meal_allowance, other_allowances, open_ended_contract, fixed_term_contract, seasonal_contract, contract_start_date, contract_end_date, recruitment_decision_no, employment_start_date, official_labor_contract_sign_date, phone_number, email, _unreadable_fields, _uncertain_fields."
          }]
        },
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      }) }}`,
      options: {
        timeout: 120000
      }
    };
    n.credentials = {
      httpHeaderAuth: {
        id: 'aX79fyjBak04yprX',
        name: 'Gemini Header'
      }
    };
    n.retryOnFail = true;
    n.maxTries = 2;
    n.onError = 'continueRegularOutput';
    console.log('[OK] Updated node: OCR - Gemini Extraction (gemini-3.1-flash-lite, genericCredentialType Gemini Header)');
  }

  // 4. OCR - Parse & Fallback
  if (n.name === 'OCR - Parse & Fallback') {
    n.parameters.jsCode = `
const ocrOutputs = $input.all();
const classifyOutputs = $('Classify - Document Type').all();
const prevData = classifyOutputs[0] ? classifyOutputs[0].json : {};

const processedFiles = [];

for (let i = 0; i < classifyOutputs.length; i++) {
  const f = classifyOutputs[i].json;
  const ocrRes = ocrOutputs[i] ? ocrOutputs[i].json : {};
  let extractedJson = {};
  let parseError = null;

  try {
    if (ocrRes.candidates && ocrRes.candidates[0] && ocrRes.candidates[0].content) {
      const parts = ocrRes.candidates[0].content.parts || [];
      const rawText = parts.map(p => p.text || '').join('').trim();
      const clean = rawText.replace(/^\\\`\\\`\\\`json\\s*/i, '').replace(/\\\`\\\`\\\`\\s*$/i, '').trim();
      if (clean) {
        extractedJson = JSON.parse(clean);
        if (Array.isArray(extractedJson)) {
          extractedJson = extractedJson[0] || {};
        }
      }
    } else if (ocrRes.error) {
      parseError = typeof ocrRes.error === 'string' ? ocrRes.error : (ocrRes.error.message || JSON.stringify(ocrRes.error));
      console.warn('[OCR Gemini Error] File: ' + f.fileName + ', CorrId: ' + (prevData.correlation_id || 'unknown') + ': ' + parseError);
    } else {
      parseError = 'No valid candidates returned from Gemini response';
      console.warn('[OCR Gemini Invalid Response] File: ' + f.fileName + ', CorrId: ' + (prevData.correlation_id || 'unknown'));
    }
  } catch (parseErr) {
    parseError = parseErr.message;
    console.warn('[OCR Parse JSON Error] File: ' + f.fileName + ', CorrId: ' + (prevData.correlation_id || 'unknown') + ': ' + parseErr.message);
  }

  // Preserve provenance for each extracted field
  const provenance = {};
  if (extractedJson && typeof extractedJson === 'object') {
    for (const key of Object.keys(extractedJson)) {
      if (key.startsWith('_')) continue;
      const val = extractedJson[key];
      if (val !== null && val !== undefined && val !== '') {
        provenance[key] = {
          fileName: f.fileName,
          docType: f.docType,
          binaryKey: f.binaryKey,
          value: val
        };
      }
    }
  }

  // Ensure rawExtracted is NEVER emptied for batches!
  processedFiles.push({
    fileIndex: i,
    fileName: f.fileName,
    binaryKey: f.binaryKey,
    fileSize: f.fileSize,
    mimeType: f.mimeType,
    fileStoragePath: f.fileStoragePath,
    docType: f.docType,
    rawExtracted: extractedJson || {},
    provenance: provenance,
    ocrStatus: parseError ? 'failed' : 'success',
    ocrError: parseError,
    text: ''
  });
}

return [{
  json: {
    batch_id: prevData.batch_id,
    correlation_id: prevData.correlation_id,
    idempotency_key: prevData.idempotency_key,
    conversation_id: prevData.conversation_id,
    company_id: prevData.company_id,
    user: prevData.user,
    processed_files: processedFiles
  }
}];
`;
    console.log('[OK] Updated node: OCR - Parse & Fallback (multi-file handling, individual rawExtracted, provenance, robust parsing)');
  }
}

fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
console.log('Successfully updated SOTRANS_HR_EMPLOYEE_LIFECYCLE.json!');
