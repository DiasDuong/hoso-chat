/**
 * Service: Company Detection & Multi-tenant Evidence Engine
 * 
 * Rules:
 * - 3 Valid Companies: STL (Sotrans Logistics), VTX (Vietranstimex), SWC (Sowatco).
 * - Company status: 'confirmed', 'suggested', 'unknown', 'conflict'.
 * - Evidence strictly derived from official documents (Recruitment decision, Labor contract, Job offer, Official company stamps/headers).
 * - STRICT CONSTRAINT: NEVER infer company from citizen_id (CCCD), place of origin, permanent address, or employee full name!
 */

const VALID_COMPANIES = ['STL', 'VTX', 'SWC'];

const COMPANY_PATTERNS = {
  STL: [
    /sotrans\s*logistics/i,
    /\bicd\s*sotrans\b/i,
    /\bđsmn\b/i,
    /\bsotrans\b/i,
    /vận\s*tải\s*giao\s*nhận\s*phía\s*nam/i,
    /\bSTL\b/
  ],
  VTX: [
    /vietranstimex/i,
    /vận\s*tải\s*đa\s*phương\s*thức/i,
    /siêu\s*trường\s*siêu\s*trọng/i,
    /\bVTX\b/
  ],
  SWC: [
    /sowatco/i,
    /đường\s*sông\s*miền\s*nam/i,
    /cảng\s*sowatco\s*long\s*bình/i,
    /tổng\s*công\s*ty\s*cp\s*đường\s*sông\s*miền\s*nam/i,
    /\bSWC\b/
  ]
};

/**
 * Detect company from document text, recruitment decisions, contracts, and department names.
 * @param {Object} profile - Extracted profile fields (recruitment_decision_no, department_staffing_plan, job_title, raw text, etc.)
 * @param {string} fullText - Combined document text
 * @returns {Object} { company_id, company_status, company_evidence }
 */
function detectCompany(profile = {}, fullText = '') {
  const textToCheck = [
    profile.recruitment_decision_no || '',
    profile.department_staffing_plan || '',
    profile.section_staffing_plan || '',
    profile.job_title || '',
    profile.file_name || '',
    fullText.slice(0, 15000) // first 15k characters of document
  ].join(' ');

  const matches = {};

  for (const [comp, patterns] of Object.entries(COMPANY_PATTERNS)) {
    for (const pat of patterns) {
      const match = textToCheck.match(pat);
      if (match) {
        if (!matches[comp]) matches[comp] = [];
        matches[comp].push(match[0]);
      }
    }
  }

  const detectedCompanies = Object.keys(matches);

  // 1. Conflict: Multiple contradictory companies detected in the documents
  if (detectedCompanies.length > 1) {
    const evidenceSummary = detectedCompanies
      .map(c => `${c} (phát hiện từ khóa: "${matches[c].slice(0, 2).join(', ')}")`)
      .join(' và ');

    return {
      company_id: null,
      company_status: 'conflict',
      company_evidence: `Phát hiện thông tin mâu thuẫn giữa các đơn vị: ${evidenceSummary}. Cần HR xác nhận lại.`
    };
  }

  // 2. Single match: Suggested company with evidence
  if (detectedCompanies.length === 1) {
    const comp = detectedCompanies[0];
    const evidenceWords = matches[comp].slice(0, 3).join(', ');
    
    // Check specific evidence source
    let sourceHint = 'nội dung văn bản';
    if (profile.recruitment_decision_no && COMPANY_PATTERNS[comp].some(p => p.test(profile.recruitment_decision_no))) {
      sourceHint = `Quyết định tuyển dụng số "${profile.recruitment_decision_no}"`;
    } else if (profile.department_staffing_plan && COMPANY_PATTERNS[comp].some(p => p.test(profile.department_staffing_plan))) {
      sourceHint = `Phòng ban / Đơn vị "${profile.department_staffing_plan}"`;
    }

    return {
      company_id: comp,
      company_status: 'suggested',
      company_evidence: `AI đề xuất dựa trên ${sourceHint} (từ khóa: "${evidenceWords}"). Chưa được HR xác nhận.`
    };
  }

  // 3. Unknown: Insufficient evidence in official documents
  return {
    company_id: null,
    company_status: 'unknown',
    company_evidence: 'Không tìm thấy dấu hiệu công ty trong quyết định tuyển dụng, thư mời nhận việc hoặc hợp đồng lao động.'
  };
}

module.exports = {
  VALID_COMPANIES,
  detectCompany
};
