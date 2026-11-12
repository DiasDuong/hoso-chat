/**
 * SOTRANS HUB — CONVERSATION REFERENCE RESOLVER & CONTEXT MANAGER
 * 
 * Chịu trách nhiệm:
 * 1. Phân giải các cụm từ tham chiếu hội thoại tự nhiên của người dùng:
 *    - "File vừa gửi", "file đính kèm trước", "tệp thứ hai"
 *    - "Bảng trên", "sheet trên", "bảng tính vừa rồi"
 *    - "Kết quả vừa rồi", "kết quả trước", "so sánh với kết quả trước"
 *    - "Tiếp tục phần còn lại", "làm tương tự cho file thứ hai"
 *    - "Chỉ sửa mục số 3", "mục 2 và 4", "hồ sơ 2, 4 và 6"
 *    - "Quay lại phương án ban đầu", "phương án đầu tiên"
 *    - "Xuất kết quả này ra Excel", "tải về file excel"
 * 2. Ánh xạ các đối tượng ngữ cảnh với ID nội bộ và siêu dữ liệu (metadata) xác thực.
 * 3. Bảo vệ ranh giới sở hữu: Chỉ nạp ngữ cảnh thuộc conversationId và userId của phiên xác thực.
 * 4. Phân loại và cung cấp chỉ dẫn định tuyến đa module (Cross-Module Guidance).
 */

const db = require('../db');

/**
 * Xóa dấu tiếng Việt phục vụ so khớp tham chiếu
 */
function removeAccents(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Nạp ngữ cảnh chi tiết của cuộc hội thoại (Conversation Context)
 */
async function loadConversationContext(conversationId, userId) {
  if (!conversationId || typeof conversationId !== 'string') {
    return {
      conversationId: null,
      turns: [],
      files: [],
      lastAssistantTurn: null,
      lastUserTurn: null,
      hasContext: false
    };
  }

  try {
    // 1. Kiểm tra quyền sở hữu hội thoại (Tenant & User Isolation)
    if (userId) {
      const convCheck = await db.query(
        `SELECT id, user_id, title, metadata FROM ai_conversations WHERE id = $1`,
        [conversationId]
      );
      if (convCheck.rows.length > 0) {
        const owner = convCheck.rows[0].user_id;
        // Nếu hội thoại thuộc user khác thì từ chối nạp ngữ cảnh để chống rò rỉ chéo
        if (owner && owner !== userId && owner !== 'guest') {
          return { conversationId, turns: [], files: [], forbidden: true };
        }
      }
    }

    // 2. Lấy 10 lượt tin nhắn gần nhất
    const msgRes = await db.query(
      `SELECT id, role, content, metadata, created_at 
       FROM ai_messages 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC 
       LIMIT 16`,
      [conversationId]
    );

    const turns = msgRes.rows || [];

    // 3. Lấy toàn bộ tệp đính kèm trong hội thoại
    const attRes = await db.query(
      `SELECT id, file_name, file_type, file_size, storage_path, manifest, created_at 
       FROM ai_attachments 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC`,
      [conversationId]
    );

    const files = attRes.rows || [];

    // Lọc lượt trả lời gần nhất của trợ lý và lượt gần nhất của người dùng
    const assistantTurns = turns.filter(t => t.role === 'assistant');
    const userTurns = turns.filter(t => t.role === 'user');

    return {
      conversationId,
      turns,
      files,
      lastAssistantTurn: assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null,
      lastUserTurn: userTurns.length > 0 ? userTurns[userTurns.length - 1] : null,
      initialAssistantTurn: assistantTurns.length > 0 ? assistantTurns[0] : null,
      hasContext: turns.length > 0 || files.length > 0
    };
  } catch (err) {
    console.warn('[ConversationReferenceResolver] Lỗi nạp ngữ cảnh:', err.message);
    return { conversationId, turns: [], files: [], error: err.message, hasContext: false };
  }
}

/**
 * Phân tích và giải quyết tham chiếu trong câu hỏi người dùng
 */
function resolveUserReferences(userQuery, context = {}) {
  const q = String(userQuery || '').trim();
  const qNorm = removeAccents(q);
  const files = context.files || [];
  const lastAssistant = context.lastAssistantTurn;
  const initialAssistant = context.initialAssistantTurn;

  const resolution = {
    hasReferences: false,
    fileReference: null,
    tableReference: null,
    resultReference: null,
    itemReference: null,
    isContinuation: false,
    isReversion: false,
    isExportRequest: false,
    promptAugmentation: '',
    suggestedTool: null,
    routingHint: null
  };

  // =========================================================================
  // 1. THAM CHIẾU TỆP TIN (FILE REFERENCES)
  // =========================================================================
  const isLatestFileRef = /(file\s+vua\s+gui|tep\s+vua\s+gui|file\s+vua\s+roi|tep\s+vua\s+roi|file\s+dinh\s+kem|tep\s+dinh\s+kem|file\s+truoc|tep\s+truoc|file\s+nay|tep\s+nay|tai\s+lieu\s+vua\s+gui)/i.test(qNorm);
  const isSecondFileRef = /(file\s+thu\s+hai|file\s+thu\s+2|file\s+2|tep\s+thu\s+hai|tep\s+thu\s+2|tep\s+2|file\s+ke\s+tiep)/i.test(qNorm);
  const isFirstFileRef = /(file\s+dau\s+tien|file\s+thu\s+nhat|file\s+thu\s+1|file\s+1|tep\s+dau\s+tien|tep\s+thu\s+1)/i.test(qNorm);

  if (isLatestFileRef && files.length > 0) {
    const targetFile = files[files.length - 1];
    resolution.hasReferences = true;
    resolution.fileReference = {
      type: 'LATEST_FILE',
      id: targetFile.id,
      fileName: targetFile.file_name,
      fileType: targetFile.file_type,
      storagePath: targetFile.storage_path,
      manifest: targetFile.manifest
    };
  } else if (isSecondFileRef && files.length >= 2) {
    const targetFile = files[1];
    resolution.hasReferences = true;
    resolution.fileReference = {
      type: 'SECOND_FILE',
      id: targetFile.id,
      fileName: targetFile.file_name,
      fileType: targetFile.file_type,
      storagePath: targetFile.storage_path,
      manifest: targetFile.manifest
    };
  } else if (isFirstFileRef && files.length >= 1) {
    const targetFile = files[0];
    resolution.hasReferences = true;
    resolution.fileReference = {
      type: 'FIRST_FILE',
      id: targetFile.id,
      fileName: targetFile.file_name,
      fileType: targetFile.file_type,
      storagePath: targetFile.storage_path,
      manifest: targetFile.manifest
    };
  } else {
    // Tìm kiếm theo tên file cụ thể nếu có nhắc đến tên file
    for (const f of files) {
      const fBase = f.file_name.toLowerCase();
      if (q.toLowerCase().includes(fBase) || qNorm.includes(removeAccents(f.file_name))) {
        resolution.hasReferences = true;
        resolution.fileReference = {
          type: 'EXPLICIT_NAME_MATCH',
          id: f.id,
          fileName: f.file_name,
          fileType: f.file_type,
          storagePath: f.storage_path,
          manifest: f.manifest
        };
        break;
      }
    }
  }

  // =========================================================================
  // 2. THAM CHIẾU BẢNG TÍNH / DỮ LIỆU ĐÃ KẾT XUẤT (TABLE REFERENCES)
  // =========================================================================
  const isTableRef = /(bang\s+tren|bang\s+tinh\s+tren|sheet\s+tren|bang\s+vua\s+roi|sheet\s+vua\s+roi|du\s+lieu\s+bang\s+tren)/i.test(qNorm);
  if (isTableRef && lastAssistant) {
    resolution.hasReferences = true;
    resolution.tableReference = {
      type: 'PREVIOUS_TABLE',
      sourceTurnId: lastAssistant.id,
      snippet: (lastAssistant.content || '').slice(0, 1500)
    };
    resolution.routingHint = 'SPREADSHEET_DATA_ENGINE';
  }

  // =========================================================================
  // 3. THAM CHIẾU KẾT QUẢ VỪA RỒI / SO SÁNH (RESULT REFERENCES)
  // =========================================================================
  const isResultRef = /(ket\s+qua\s+vua\s+roi|ket\s+qua\s+truoc|so\s+sanh\s+voi\s+ket\s+qua\s+truoc|doi\s+chieu\s+voi\s+truoc|so\s+voi\s+lan\s+truoc)/i.test(qNorm);
  if (isResultRef && lastAssistant) {
    resolution.hasReferences = true;
    resolution.resultReference = {
      type: 'PREVIOUS_RESULT_COMPARISON',
      sourceTurnId: lastAssistant.id,
      previousSummary: (lastAssistant.content || '').slice(0, 1000)
    };
  }

  // =========================================================================
  // 4. THAM CHIẾU MỤC CỤ THỂ HOẶC SỐ THỨ TỰ (ITEM / ROW SPECIFICITY)
  // =========================================================================
  const itemMatch = qNorm.match(/(?:chi\s+sua|sua|thay\s+doi|xem|chon|kiem\s+tra)\s+(?:muc|dong|phan|ho\s+so|so|item)\s*(?:so\s*)?([0-9,\s&va]+)/i) ||
                    qNorm.match(/(?:ho\s+so|muc|dong)\s+([0-9,\s&va]+)/i);

  if (itemMatch && itemMatch[1]) {
    const rawTokens = itemMatch[1].replace(/va/g, ',').replace(/&/g, ',').split(',');
    const itemNumbers = rawTokens.map(t => parseInt(t.trim(), 10)).filter(n => !isNaN(n));
    if (itemNumbers.length > 0) {
      resolution.hasReferences = true;
      resolution.itemReference = {
        type: 'SPECIFIC_ITEMS',
        indices: itemNumbers,
        rawQuery: itemMatch[0]
      };
    }
  }

  // =========================================================================
  // 5. TIẾP TỤC PHẦN CÒN LẠI (CONTINUATION)
  // =========================================================================
  const isContinuation = /(tiep\s+tuc\s+phan\s+con\s+lai|tiep\s+tuc|lam\s+tiep|chay\s+tiep|phan\s+con\s+lai|con\s+gi\s+nua\s+khong|xuat\s+tiep)/i.test(qNorm);
  if (isContinuation && lastAssistant) {
    resolution.hasReferences = true;
    resolution.isContinuation = true;
  }

  // =========================================================================
  // 6. QUAY LẠI PHƯƠNG ÁN BAN ĐẦU (REVERSION)
  // =========================================================================
  const isReversion = /(quay\s+lai\s+phuong\s+an\s+ban\s+dau|phuong\s+an\s+dau\s+tien|cach\s+ban\s+dau|ban\s+dau\s+the\s+nao|phuong\s+an\s+1|y\s+kien\s+ban\s+dau)/i.test(qNorm);
  if (isReversion && initialAssistant) {
    resolution.hasReferences = true;
    resolution.isReversion = true;
    resolution.resultReference = {
      type: 'INITIAL_PROPOSAL',
      sourceTurnId: initialAssistant.id,
      proposalText: (initialAssistant.content || '').slice(0, 1200)
    };
  }

  // =========================================================================
  // 7. YÊU CẦU XUẤT RA EXCEL (EXPORT REQUEST)
  // =========================================================================
  const isExportExcel = /(xuat\s+ket\s+qua\s+nay\s+ra\s+excel|xuat\s+ra\s+excel|tai\s+ve\s+file\s+excel|export\s+excel|xuat\s+file\s+excel|tai\s+bang\s+nay\s+ve)/i.test(qNorm);
  if (isExportExcel) {
    resolution.hasReferences = true;
    resolution.isExportRequest = true;
    resolution.suggestedTool = 'export_excel_report';
    resolution.routingHint = 'AGENT_ORCHESTRATOR';
  }

  // =========================================================================
  // XÂY DỰNG KHỐI NGỮ CẢNH BỔ TRỢ (PROMPT AUGMENTATION)
  // =========================================================================
  let promptParts = [];
  if (resolution.fileReference) {
    promptParts.push(`[NGỮ CẢNH THAM CHIẾU TỆP TIN ĐÃ ĐỐI SOÁT CHÍNH XÁC]`);
    promptParts.push(`- Tệp được tham chiếu: "${resolution.fileReference.fileName}" (Định dạng: ${resolution.fileReference.fileType})`);
    promptParts.push(`- Mã định danh nội bộ: ${resolution.fileReference.id}`);
    if (resolution.fileReference.manifest) {
      promptParts.push(`- Thông số tệp: ${JSON.stringify(resolution.fileReference.manifest)}`);
    }
  }

  if (resolution.tableReference) {
    promptParts.push(`[NGỮ CẢNH THAM CHIẾU BẢNG DỮ LIỆU VỪA TẠO]`);
    promptParts.push(`Người dùng đang nhắc tới bảng tính/kết quả tại lượt trả lời trước. Hãy tiếp tục thao tác trên dữ liệu của bảng đó.`);
  }

  if (resolution.itemReference) {
    promptParts.push(`[CHỈ THỊ THAO TÁC CÓ CHỌN LỌC TRÊN CÁC MỤC]`);
    promptParts.push(`Người dùng chỉ định rõ ràng chỉ thao tác trên các mục/hồ sơ/dòng có số thứ tự: [${resolution.itemReference.indices.join(', ')}]. Tuyệt đối không thay đổi các mục khác ngoài danh sách này.`);
  }

  if (resolution.isContinuation) {
    promptParts.push(`[CHỈ THỊ TIẾP TỤC TÁC VỤ DANG DỞ]`);
    promptParts.push(`Người dùng yêu cầu tiếp tục phần còn lại từ lượt trả lời trước. Hãy phân tích phần chưa hoàn tất và thực hiện tiếp mà không lặp lại nội dung đã trình bày.`);
  }

  if (resolution.isReversion && resolution.resultReference) {
    promptParts.push(`[CHỈ THỊ KHÔI PHỤC PHƯƠNG ÁN BAN ĐẦU]`);
    promptParts.push(`Người dùng yêu cầu quay lại phương án đầu tiên trong cuộc trò chuyện:\n"""\n${resolution.resultReference.proposalText}\n"""\nHãy lấy lại phương án này làm trọng tâm.`);
  }

  if (resolution.isExportRequest) {
    promptParts.push(`[YÊU CẦU XUẤT TỆP BÁO CÁO EXCEL]`);
    promptParts.push(`Người dùng yêu cầu kết xuất bảng phân tích/kết quả hiện tại thành file Excel. Hãy gọi công cụ "export_excel_report" hoặc chuẩn bị dữ liệu bảng tính đầy đủ.`);
  }

  resolution.promptAugmentation = promptParts.join('\n');
  return resolution;
}

module.exports = {
  loadConversationContext,
  resolveUserReferences
};
