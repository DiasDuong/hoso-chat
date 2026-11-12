/**
 * Service: Conversational Natural Language Interpreter for Company Confirmation & Approval
 * Enhanced for BIZ-03, AUTH-01, BIZ-01
 */

function removeAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Parse natural language user intent for updating identifier fields (CCCD, employee_code)
 */
function parseIdentifierUpdates(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const lines = raw.split(/[\r\n]+|;\s*/).map(l => l.trim()).filter(Boolean);
  const updates = [];

  for (const line of lines) {
    const rawClean = line.replace(/^(?:cập nhật|bổ sung|điền|nhập|gán)\s+/i, '').trim();

    // Case 1: 'CCCD' or 'Mã NV' is at the start:
    // e.g. 'CCCD của PHAN DƯƠNG THANH BÌNH : 079204001284'
    // e.g. 'Mã NV của PHAN DƯƠNG THANH BÌNH là STL-001'
    const fieldPrefixMatch = rawClean.match(/^(?:số\s+)?(cccd|cmnd|căn cước|mã\s*(?:số\s*)?(?:nv|nhân viên)|employee\s*code)(?:\s+công\s+dân)?\s*(?:của|cho)?\s*[:\-=–]?\s*(.*?)\s*(?:là|la|:|=|–|-|\s+là\s+|\s+la\s+)\s*([A-Za-z0-9_\-]+)$/i);
    if (fieldPrefixMatch) {
      const fieldType = fieldPrefixMatch[1].toLowerCase();
      let target = fieldPrefixMatch[2].trim();
      const val = fieldPrefixMatch[3].trim();
      
      target = target.replace(/^(?:cho|của)\s+/i, '').trim();
      if (/cccd|cmnd|căn cước/i.test(fieldType)) {
        updates.push({ target, citizen_id: val.replace(/\D/g, ''), employee_code: null, rawLine: line });
        continue;
      } else {
        updates.push({ target, citizen_id: null, employee_code: val, rawLine: line });
        continue;
      }
    }

    // Case 2: Target is at the start:
    // e.g. 'PHAN DƯƠNG THANH BÌNH: CCCD 079204001284'
    // e.g. 'Hồ sơ 3 mã NV là STL-001'
    // e.g. 'Hồ sơ 2 CCCD là 036202007139'
    const targetPrefixMatch = rawClean.match(/^(.*?)\s*(?:có\s+)?(?:số\s+)?(cccd|cmnd|căn cước|mã\s*(?:số\s*)?(?:nv|nhân viên)|employee\s*code)(?:\s+công\s+dân)?\s*(?:là|la|:|=|–|-)\s*([A-Za-z0-9_\-]+)$/i);
    if (targetPrefixMatch) {
      let target = targetPrefixMatch[1].trim();
      const fieldType = targetPrefixMatch[2].toLowerCase();
      const val = targetPrefixMatch[3].trim();
      target = target.replace(/^(?:cho|của)\s+/i, '').replace(/[:\-=–]+$/, '').trim();

      if (/cccd|cmnd|căn cước/i.test(fieldType)) {
        updates.push({ target, citizen_id: val.replace(/\D/g, ''), employee_code: null, rawLine: line });
        continue;
      } else {
        updates.push({ target, citizen_id: null, employee_code: val, rawLine: line });
        continue;
      }
    }

    // Case 3: Both CCCD and Mã NV in one line:
    // e.g. 'PHAN DƯƠNG THANH BÌNH: CCCD 079204001284, mã NV STL-001'
    const comboMatch = rawClean.match(/^(.*?)\s*[:–=–]\s*(?:.*?(?:cccd|cmnd|căn cước)\s*[:\-=–]?\s*(\d{9,12}))?(?:.*?(?:mã\s*(?:số\s*)?(?:nv|nhân viên)|employee\s*code)\s*[:\-=–]?\s*([A-Za-z0-9_\-]+))?/i);
    if (comboMatch && (comboMatch[2] || comboMatch[3])) {
      const target = comboMatch[1].trim();
      updates.push({
        target,
        citizen_id: comboMatch[2] ? comboMatch[2].trim() : null,
        employee_code: comboMatch[3] ? comboMatch[3].trim() : null,
        rawLine: line
      });
      continue;
    }
  }

  if (updates.length > 0) {
    return {
      type: 'UPDATE_IDENTIFIER',
      updates,
      rawText: text
    };
  }
  return null;
}

/**
 * Parse natural language user intent for HR Intake
 * @param {string} text - User message
 * @param {Array} stagingList - Current pending staging items in active conversation/batch
 * @returns {Object} Parsed intent object
 */
function parseConversationalIntake(text = '', stagingList = []) {
  const rawTrimmed = String(text || '').trim();
  const norm = removeAccents(rawTrimmed);

  // Fast guard: Không can thiệp nếu là câu hỏi tra cứu thông tin, thống kê số lượng, danh sách nhân sự
  const isQuery = rawTrimmed.endsWith('?') ||
                  /^(?:ai|co bao nhieu|bao nhieu|danh sach|liet ke|nhan vien|nhung|tim|tra cuu|cho toi|xem|so luong|nv|thong tin|sdt|email|que quan|dia chi)\b/i.test(norm) ||
                  norm.includes('co bao nhieu') || norm.includes('bao nhieu nhan') ||
                  norm.includes('danh sach nhan') || norm.includes('liet ke nhan') ||
                  norm.includes('cho toi xem') || norm.includes('ai dang') || norm.includes('ai lam') ||
                  norm.includes('nhan vien nao') || norm.includes('duoi 30') || norm.includes('tren 30') ||
                  norm.includes('sinh nam');

  const hasIntakeAction = /^(?:duyet|phe duyet|bo qua|loai bo|huy|xac nhan|trinh duyet|gui duyet|cap nhat cccd|cap nhat ma)/i.test(norm) ||
                          norm.includes('xac nhan cong ty') || norm.includes('phe duyet ho so') || norm.includes('duyet ho so');

  if (isQuery && !hasIntakeAction) {
    return { type: 'OTHER', rawText: text };
  }

  // 0. Handle Identifier Updates (CCCD, Mã nhân viên) via Chat
  const idUpdates = parseIdentifierUpdates(rawTrimmed);
  if (idUpdates) return idUpdates;

  // 0. Handle Direct Structured JSON Action from UI Buttons / Action Pills
  if (rawTrimmed.startsWith('{') && rawTrimmed.endsWith('}')) {
    try {
      const payload = JSON.parse(rawTrimmed);
      if (payload.action === 'skip' || payload.action === 'reject') {
        return {
          type: payload.approve_remaining ? 'SKIP_AND_APPROVE_OTHERS' : 'SKIP_ITEM',
          target: payload.target || payload.id || payload.staging_id || String(payload.index || ''),
          indices: payload.index ? [parseInt(payload.index, 10)] : (payload.indices || null),
          targets: payload.targets || null,
          rawText: text
        };
      }
      if (payload.action === 'approve') {
        return {
          type: 'APPROVE',
          scope: payload.scope || 'all',
          indices: payload.indices || (payload.index ? [parseInt(payload.index, 10)] : null),
          rawText: text
        };
      }
      if (payload.action === 'confirm_company') {
        return {
          type: 'CONFIRM_COMPANY_TARGETED',
          target: payload.target || payload.id || String(payload.index || ''),
          company_id: payload.company_id,
          rawText: text
        };
      }
    } catch (e) {}
  }

  // 1. Check for Skip / Remove / Reject Item (BIZ-03 Enhanced)
  // Matches:
  // - "bỏ qua hồ sơ 3", "bỏ qua số 3", "bỏ hồ sơ 3", "bỏ 3", "bỏ file 2"
  // - "bỏ qua hồ sơ 1, 2" / "bỏ 1 và 3"
  // - "bỏ hồ sơ SWC00810, hãy cập nhật các hồ sơ trên"
  // - "bỏ qua hồ sơ Nguyễn Trường Nam"
  // - "tôi đã nhắn bỏ qua..."
  const isSkipIntent = /^(?:bo\s+qua|bo\s+ho\s+so|bo\s+file|loai\s+bo|huy\s+ho\s+so|xoa\s+ho\s+so|khong\s+cap\s+nhat|khong\s+duyet|\bbo\b\s*(?:so|thu|ho so|file|\d+))\b/i.test(norm) ||
                       norm.includes('nhan bo qua') || norm.includes('yeu cau bo qua') || norm.includes('bo qua ho so');

  if (isSkipIntent) {
    const isFollowupApprove = norm.includes('cap nhat cac ho so') || norm.includes('duyet cac ho so') || 
                             norm.includes('duyet con lai') || norm.includes('cap nhat con lai') || 
                             norm.includes('cap nhat cac ho') || norm.includes('duyet cac ho') ||
                             norm.includes('cap nhat ho so tren') || norm.includes('luu cac ho so tren');

    // Check multiple indices: e.g. "bỏ qua hồ sơ 1, 2, 4"
    const multiIdxMatch = norm.match(/(?:bo\s+qua|bo\s+ho\s+so|bo\s+file|bo)(?:\s+cac\s+ho\s+so|\s+ho\s+so|\s+so|\s+file)?\s+([0-9\s,va]+)/i);
    let extractedIndices = null;
    if (multiIdxMatch) {
      const parts = multiIdxMatch[1].replace(/va/g, ' ').split(/[\s,]+/).map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      if (parts.length > 0) extractedIndices = parts;
    }

    // Check code / CCCD match: e.g. "bỏ qua STL-101", "bỏ qua SWC00810", "bỏ qua 079204001284"
    const codeMatch = rawTrimmed.match(/\b([A-Za-z]{2,5}[-_]?\d+|\d{9,12})\b/);
    const targetCode = codeMatch ? codeMatch[1] : null;

    let targetMatch = norm.replace(/^(?:ti da nhan\s+)?(?:bo\s+qua|bo\s+ho\s+so|bo\s+file|loai\s+bo|huy\s+ho\s+so|xoa\s+ho\s+so|khong\s+cap\s+nhat|khong\s+duyet|\bbo\b)\s*/i, '')
                          .replace(/[,;].*$/, '').trim();

    // If target is just generic ("nay", "ho so nay") and only 1 item exists in staging
    if ((!targetMatch || /^(nay|ho so nay|file nay|nay)$/i.test(targetMatch)) && stagingList.length === 1) {
      targetMatch = '1';
    }

    return {
      type: isFollowupApprove ? 'SKIP_AND_APPROVE_OTHERS' : 'SKIP_ITEM',
      target: targetCode || targetMatch,
      indices: extractedIndices,
      requiresClarification: !targetCode && !targetMatch && (!extractedIndices || !extractedIndices.length) && stagingList.length > 1,
      rawText: text
    };
  }

  // 2. Check for Approval with Specific Indices ("Duyệt hồ sơ 1,2,4,5,6", "phê duyệt 1, 2, 4, 5, 6", "cập nhật hồ sơ 1,2,4,5,6")
  const idxMatch = norm.match(/(?:duyet|phe duyet|cap nhat|luu)(?:\s+ho\s+so|\s+cac\s+ho\s+so|\s+file)?\s+([0-9\s,va]+)$/i);
  if (idxMatch) {
    const indices = idxMatch[1].replace(/va/g, ' ').split(/[\s,]+/).map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n) && n > 0);
    if (indices.length > 0) {
      return {
        type: 'APPROVE',
        scope: 'indices',
        indices,
        rawText: text
      };
    }
  }

  // 3. Check for General Approval Intent
  if (/^(duyet|phe duyet|luu chinh thuc|chap thuan|xac nhan luu|luu ho so|cap nhat|xac nhan cap nhat|duyet cap nhat|luu cap nhat)/i.test(norm) ||
      norm.includes('duyet ho so') || norm.includes('luu chinh thuc') || norm.includes('phe duyet tat ca') ||
      norm.includes('xac nhan cap nhat') || norm.includes('cap nhat ho so') || norm.includes('duyet cap nhat')) {
    const isAll = norm.includes('tat ca') || norm.includes('toan bo');
    const isValidOnly = norm.includes('hop le') || norm.includes('da xac nhan') || norm.includes('con lai');
    return {
      type: 'APPROVE',
      scope: isAll ? 'all' : (isValidOnly ? 'valid_only' : 'single'),
      rawText: text
    };
  }

  // 4. Check for Submit for Approval (Gửi trình duyệt) Intent
  if (/^(gui duyet|trinh duyet|gui trinh duyet|cho duyet)/i.test(norm) ||
      norm.includes('gui trinh duyet') || norm.includes('gui cho duyet')) {
    return {
      type: 'SUBMIT_FOR_APPROVAL',
      scope: norm.includes('tat ca') ? 'all' : 'single',
      rawText: text
    };
  }

  // 5. Check for Reject / Cancel Intent
  if (/^(tu choi|huy|huy bo|khong duyet|chuyen sang cho xu ly)/i.test(norm)) {
    return {
      type: 'REJECT',
      rawText: text
    };
  }

  // 6. Check for "Unknown Company" (Chưa xác định được công ty)
  if (norm.includes('chua xac dinh') || norm.includes('chua ro') || norm.includes('khong xac dinh') || norm.includes('chua biet')) {
    return {
      type: 'CONFIRM_COMPANY_UNKNOWN',
      company_id: null,
      scope: norm.includes('tat ca') || norm.includes('ca ') ? 'all' : 'single',
      rawText: text
    };
  }

  // Helper: Resolve company identifier from string
  function resolveComp(str) {
    if (/\bswc\b|sowatco/i.test(str)) return 'SWC';
    if (/\bstl\b|sotrans/i.test(str)) return 'STL';
    if (/\bvtx\b|vietranstimex/i.test(str)) return 'VTX';
    return null;
  }

  // 7. Check for Positional Assignment ("Hồ sơ đầu tiên thuộc VTX, hồ sơ thứ hai thuộc SWC")
  const positionalPatterns = [
    { pos: 0, keywords: ['dau tien', 'thu nhat', 'so 1', 'file 1', 'ho so 1'] },
    { pos: 1, keywords: ['thu hai', 'so 2', 'file 2', 'ho so 2'] },
    { pos: 2, keywords: ['thu ba', 'so 3', 'file 3', 'ho so 3'] },
    { pos: 3, keywords: ['thu tu', 'so 4', 'file 4', 'ho so 4'] },
    { pos: 4, keywords: ['thu nam', 'so 5', 'file 5', 'ho so 5'] }
  ];

  const detectedPositions = [];
  for (const p of positionalPatterns) {
    for (const kw of p.keywords) {
      const idx = norm.indexOf(kw);
      if (idx !== -1) {
        detectedPositions.push({ pos: p.pos, idx, kw });
        break;
      }
    }
  }

  if (detectedPositions.length > 0) {
    detectedPositions.sort((a, b) => a.idx - b.idx);
    const positionalAssignments = [];

    for (let i = 0; i < detectedPositions.length; i++) {
      const cur = detectedPositions[i];
      const startIdx = cur.idx;
      const endIdx = (i + 1 < detectedPositions.length) ? detectedPositions[i + 1].idx : norm.length;
      const segment = norm.substring(startIdx, endIdx);

      const comp = resolveComp(segment);
      if (comp) {
        positionalAssignments.push({ index: cur.pos, company_id: comp });
      }
    }

    if (positionalAssignments.length > 1) {
      return {
        type: 'CONFIRM_COMPANY_POSITIONAL',
        assignments: positionalAssignments,
        rawText: text
      };
    }
  }

  // 8. Check for Compound Assignment ("Hồ sơ 3 thuộc STL, tất cả hồ sơ còn lại thuộc SWC")
  const compoundMatch = norm.match(/^(?:toi da gui rang\s+)?(.*?)\s+(?:la\s+)?thuoc\s+(stl|swc|vtx|sotrans|sowatco|vietranstimex)[,;\s]+(?:va\s+|con\s+|nhung\s+)?(?:tat\s+ca\s+|toan\s+bo\s+|cac\s+)?(?:\d+\s+)?(?:ho\s+so\s+|file\s+)?(?:con\s+lai|khac)\s+(?:la\s+)?thuoc\s+(stl|swc|vtx|sotrans|sowatco|vietranstimex)/i);
  if (compoundMatch) {
    const comp1 = resolveComp(compoundMatch[2]);
    const comp2 = resolveComp(compoundMatch[3]);
    if (comp1 && comp2) {
      return {
        type: 'CONFIRM_COMPANY_COMPOUND',
        target: compoundMatch[1].trim(),
        targetCompany: comp1,
        remainingCompany: comp2,
        rawText: text
      };
    }
  }

  // 9. Check for "Remaining items" assignment ("5 hồ sơ còn lại thuộc SWC", "các hồ sơ còn lại thuộc SWC", "hồ sơ còn lại thuộc SWC")
  if (norm.includes('con lai') || norm.includes('khac')) {
    const comp = resolveComp(norm);
    if (comp && (norm.includes('thuoc') || norm.includes('cho') || norm.includes('la'))) {
      return {
        type: 'CONFIRM_COMPANY_REMAINING',
        company_id: comp,
        rawText: text
      };
    }
  }

  // 10. Check for Company Assignment (Targeted, Batch, or Single)
  let targetCompany = resolveComp(norm);

  if (targetCompany) {
    // Check if target precedes "thuộc" ("NGUYỄN TRƯỜNG NAM thuộc công ty SWC", "SWC00810 thuộc SWC")
    const matchBefore = norm.match(/^(?:toi da gui rang\s+)?(.*?)\s+(?:la\s+)?thuoc\s+/i);
    // Or target follows "cho" ("Xác nhận SWC cho Nguyễn Trường Nam")
    const matchAfter = norm.match(/(?:xac nhan|gan)\s+(?:cong ty\s+)?(?:stl|vtx|swc)\s+cho\s+(.*)/i);

    if (matchBefore) {
      const prefix = matchBefore[1].trim();
      const prefixNorm = removeAccents(prefix);
      if (prefixNorm.includes('liet ke') || prefixNorm.includes('danh sach') || prefixNorm.includes('co bao nhieu') || prefixNorm.includes('nhan vien') || prefixNorm.includes('cho toi') || prefixNorm.includes('nhung')) {
        return { type: 'OTHER', rawText: text };
      }

      const isBatch = prefix.includes('tat ca') || prefix.includes('toan bo') || prefix.includes('ca lo') || prefix.includes('cac ho so') || prefix.includes('trong lo nay') || prefix.includes('con lai');
      const isGeneric = !prefix || /^(ho so nay|ho so|ung vien nay|file nay|nay)$/i.test(prefix);

      if (isBatch) {
        return { type: 'CONFIRM_COMPANY_BATCH', company_id: targetCompany, rawText: text };
      }
      if (isGeneric) {
        return { type: 'CONFIRM_COMPANY_SINGLE', company_id: targetCompany, rawText: text };
      }
      return {
        type: 'CONFIRM_COMPANY_TARGETED',
        target: prefix,
        company_id: targetCompany,
        rawText: text
      };
    }

    if (matchAfter) {
      return {
        type: 'CONFIRM_COMPANY_TARGETED',
        target: matchAfter[1].trim(),
        company_id: targetCompany,
        rawText: text
      };
    }

    // Default batch check if text has batch keywords
    const isBatch = norm.includes('tat ca') || norm.includes('toan bo') || norm.includes('ca ') || norm.includes('trong lo nay') || norm.includes('con lai');
    if (isBatch) {
      return { type: 'CONFIRM_COMPANY_BATCH', company_id: targetCompany, rawText: text };
    }

    const isStandaloneComp = ['swc', 'stl', 'vtx', 'sowatco', 'sotrans', 'vietranstimex'].includes(norm);
    const hasAssignVerb = norm.includes('xac nhan') || norm.includes('gan') || norm.includes('chon') || norm.includes('thuoc') || norm.includes('la cua');
    if (isStandaloneComp || hasAssignVerb) {
      return {
        type: 'CONFIRM_COMPANY_SINGLE',
        company_id: targetCompany,
        rawText: text
      };
    }

    return { type: 'OTHER', rawText: text };
  }

  return {
    type: 'OTHER',
    rawText: text
  };
}

module.exports = {
  parseConversationalIntake,
  parseIdentifierUpdates,
  removeAccents
};
