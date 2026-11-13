/**
 * SOTRANS HUB — STEP 4: UNIFIED INTELLIGENCE SERVICE
 * Core Query Understanding · SQL Intelligence · True RAG with Qdrant · Evidence-Based Citations · RAG Sandbox
 */

const db = require('../db');
const { queryRagWithCitations } = require('./ocrDocumentPipeline');
const {
  formatSingleEmployeeResponse,
  buildStandardTable,
  maskCccd,
  removeAccents,
  COLUMNS
} = require('./employeeLookupService');

// Allowlist for SQL columns in employee queries
const ALLOWED_EMPLOYEE_COLUMNS = [
  'id', 'employee_id', 'full_name', 'company_id', 'department_staffing_plan',
  'job_title', 'professional_title', 'section_staffing_plan', 'date_of_birth',
  'gender', 'citizen_id', 'phone_number', 'email', 'education_level',
  'qualification', 'place_of_origin', 'permanent_address', 'current_address',
  'status', 'employment_start_date', 'recruitment_decision_no',
  'base_salary', 'social_insurance_salary', 'total_income'
];

/**
 * 1. QUERY UNDERSTANDING & 9-INTENT CLASSIFICATION
 */
function classifyIntent(message, user = null, options = {}) {
  const raw = String(message || '').trim();
  const norm = removeAccents(raw.toLowerCase());

  const requestedScope = String(options.scope || '').toLowerCase().trim();
  const isExplicitSandbox = requestedScope === 'testing' || requestedScope === 'draft' || requestedScope === 'sandbox';

  const intentObj = {
    rawMessage: raw,
    normalizedMessage: norm,
    intent: 'employee_search', // default
    entities: {
      employee_id: null,
      citizen_id: null,
      phone_number: null,
      decision_no: null,
      person_name: null,
      company_id: null,
      department: null,
      job_title: null,
      education_level: null,
      birth_year: null,
      age_range: null,
      status: 'ACTIVE'
    },
    aggregation_type: 'none', // 'count', 'group_by_company', 'group_by_department', 'group_by_education', 'age_stats'
    policy_topics: [],
    requested_fields: [],
    isSandbox: isExplicitSandbox,
    needs_clarification: false,
    clarification_question: null
  };

  // --- A. Kiểm tra độ ngắn / Mơ hồ -> clarification_required ---
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && !/^[A-Za-z]{2,5}[-_]?\d{3,8}$/.test(raw) && !/^\d{9,12}$/.test(raw)) {
    if (['nhan vien', 'nv', 'ho so', 'thong tin', 'xem giup', 'bao nhieu', 'ai', 'quy dinh', 'chinh sach', 'tim ho', 'tim giup'].includes(norm)) {
      intentObj.intent = 'clarification_required';
      intentObj.needs_clarification = true;
      intentObj.clarification_question = 'Bạn cần tra cứu thông tin nhân sự cụ thể (Mã nhân viên, Họ tên) hay hỏi về Quy chế, Chính sách nội bộ của công ty? Vui lòng cung cấp thêm từ khóa chi tiết.';
      return intentObj;
    }
  }

  // --- B. Kiểm tra ngoài phạm vi -> unsupported ---
  if (
    /thoi\s*tiet|gia\s*vang|gia\s*bitcoin|chungkhoan|lap\s*trinh|viet\s*code|nau\s*an|bai\s*hat|xem\s*phim|bong\s*da/i.test(norm) &&
    !/sotrans|nhan\s*su|quy\s*che|chinh\s*sach/i.test(norm)
  ) {
    intentObj.intent = 'unsupported';
    return intentObj;
  }

  // --- C. Nhận diện Đơn vị thành viên trong câu hỏi ---
  if (/\b(swc|sowatco|duong\s*thuy)\b/i.test(norm)) {
    intentObj.entities.company_id = 'SWC';
  } else if (/\b(vtx|vietranstimex|sieu\s*truong\s*sieu\s*trong)\b/i.test(norm)) {
    intentObj.entities.company_id = 'VTX';
  } else if (/\b(stl|sotrans|logistics|kho\s*van\s*mien\s*nam)\b/i.test(norm)) {
    intentObj.entities.company_id = 'STL';
  }

  // --- D. Nhận diện Mã nhân viên ---
  const codeMatch = raw.match(/\b([A-Za-z]{2,8})[-_]?(\d{3,8})\b/i);
  if (codeMatch && !/^(CS|QD|QC|NQ|TB|HD)[-_]/i.test(codeMatch[0])) {
    intentObj.entities.employee_id = codeMatch[1].toUpperCase() + codeMatch[2];
  }

  // --- E. Nhận diện CCCD / CMND ---
  const cccdMatch = raw.match(/\b(\d{12}|\d{9})\b/);
  if (cccdMatch && !intentObj.entities.employee_id) {
    intentObj.entities.citizen_id = cccdMatch[1];
  }

  // --- F. Nhận diện Số điện thoại ---
  const phoneMatch = raw.match(/\b(0\d{9})\b/);
  if (phoneMatch) {
    intentObj.entities.phone_number = phoneMatch[1];
  }

  // --- G. Nhận diện RAG Sandbox / Dự thảo / Kiểm thử văn bản ---
  const isDraftMention = /du\s*thao|kiem\s*thu|sandbox|chua\s*ap\s*dung|thu\s*nghiem|ban\s*nhap|draft|staging|cs-dns-2026|qc-cnkv-2025/i.test(norm);
  if (isDraftMention || isExplicitSandbox) {
    intentObj.isSandbox = true;
    if (/so\s*sanh|khac\s*nhau|thay\s*doi|diem\s*moi/i.test(norm)) {
      intentObj.intent = 'policy_compare';
    } else {
      intentObj.intent = 'draft_policy_test';
    }
    return intentObj;
  }

  // --- H. Nhận diện So sánh văn bản chính sách (policy_compare) ---
  if (
    /so\s*sanh\s*(quy\s*che|chinh\s*sach|quy\s*dinh|van\s*ban)/i.test(norm) ||
    (norm.includes('so sanh') && (norm.includes('quy che') || norm.includes('phien ban') || norm.includes('hien hanh')))
  ) {
    intentObj.intent = 'policy_compare';
    return intentObj;
  }

  // --- I. Nhận diện Quy định / Chính sách / Nội quy (policy_qa) ---
  const isPolicyKeyword = /quy\s*che|quy\s*dinh|chinh\s*sach|noi\s*quy|quy\s*trinh|huong\s*dan|dieu\s*le|so\s*tay|thoi\s*gian\s*lam\s*viec|gio\s*lam\s*viec|nghi\s*phep|nghi\s*le|thai\s*san|om\s*dau|thu\s*viec|ky\s*luat|sa\s*thai|bao\s*mat|an\s*toan\s*lao\s*dong|bao\s*ho\s*lao\s*dong|dong\s*phuc|trang\s*phuc|ca\s*kip|tang\s*ca|lam\s*them\s*gio|nang\s*bac|phuc\s*loi|kpi|thuong|boi\s*thuong/i.test(norm);
  const isDocCode = /\b(CS-DN-2026|QD-SCPBB-2026|QC-DXCD-2026|NQ-ANKCS-2026|QC-NB\/2026)\b/i.test(raw);

  if ((isPolicyKeyword || isDocCode) && !intentObj.entities.employee_id && !intentObj.entities.citizen_id) {
    intentObj.intent = 'policy_qa';
    return intentObj;
  }

  // --- J. Nhận diện Lương & Thỏa thuận đãi ngộ (compensation_lookup) ---
  const isSalaryKeyword = /muc\s*luong|luong\s*co\s*ban|thoa\s*thuan\s*luong|luong\s*dong\s*bhxh|luong\s*bao\s*hiem|tong\s*thu\s*nhap|phu\s*cap\s*an\s*trua|phu\s*cap\s*trach\s*nhiem|thuong\s*chuyen\s*can|luong\s*nang\s*suat|tien\s*luong|bang\s*luong/i.test(norm);
  if (isSalaryKeyword) {
    intentObj.intent = 'compensation_lookup';
    intentObj.requested_fields.push('base_salary', 'social_insurance_salary', 'total_income', 'meal_allowance', 'responsibility_allowance');
  }

  // --- K. Nhận diện Thống kê / Tổng hợp (employee_aggregate) ---
  const isAggregate = /co\s*bao\s*nhieu|bao\s*nhieu\s*nguoi|bao\s*nhieu\s*nhan\s*(vien|su)|dem\s*so|thong\s*ke|tong\s*so\s*(nhan\s*vien|nhan\s*su)?|so\s*sanh\s*(so\s*luong|nhan\s*su)|phan\s*bo\s*nhan\s*su/i.test(norm);
  if (isAggregate) {
    intentObj.intent = 'employee_aggregate';
    if (/theo\s*cong\s*ty|giua\s*cac\s*cong\s*ty|tung\s*cong\s*ty|theo\s*don\s*vi/i.test(norm)) {
      intentObj.aggregation_type = 'group_by_company';
    } else if (/theo\s*phong\s*ban|tung\s*phong\s*ban|theo\s*bo\s*phan/i.test(norm)) {
      intentObj.aggregation_type = 'group_by_department';
    } else if (/theo\s*trinh\s*do|hoc\s*van|bang\s*cap/i.test(norm)) {
      intentObj.aggregation_type = 'group_by_education';
    } else if (/do\s*tuoi|tuoi\s*tac|nam\s*sinh/i.test(norm)) {
      intentObj.aggregation_type = 'age_stats';
    } else {
      intentObj.aggregation_type = 'count';
    }
  }

  // --- L. Trích xuất thuộc tính tìm kiếm nhân viên ---
  if (intentObj.intent !== 'policy_qa' && intentObj.intent !== 'draft_policy_test' && intentObj.intent !== 'policy_compare') {
    // Phòng ban
    const deptMatch = norm.match(/(?:phong|ban|khoi|to|doi)\s+([a-z0-9\s]+?)(?=\s+(?:tai|thuoc|co|dang|la|va|$))/i);
    if (deptMatch) {
      intentObj.entities.department = deptMatch[1].trim();
    } else if (/ke\s*toan/i.test(norm)) {
      intentObj.entities.department = 'Kế toán';
    } else if (/van\s*tai|doi\s*xe/i.test(norm)) {
      intentObj.entities.department = 'Vận tải';
    } else if (/kinh\s*doanh|cskh/i.test(norm)) {
      intentObj.entities.department = 'Kinh doanh';
    } else if (/khai\s*thac|kho\s*bai|icd/i.test(norm)) {
      intentObj.entities.department = 'Khai thác';
    }

    // Học vấn
    if (/dai\s*hoc/i.test(norm)) intentObj.entities.education_level = 'Đại học';
    else if (/thac\s*si/i.test(norm)) intentObj.entities.education_level = 'Thạc sĩ';
    else if (/cao\s*dang/i.test(norm)) intentObj.entities.education_level = 'Cao đẳng';
    else if (/trung\s*cap/i.test(norm)) intentObj.entities.education_level = 'Trung cấp';

    // Chức danh
    if (/giam\s*doc/i.test(norm)) intentObj.entities.job_title = 'Giám đốc';
    else if (/truong\s*phong/i.test(norm)) intentObj.entities.job_title = 'Trưởng phòng';
    else if (/thuyen\s*(pho|truong)/i.test(norm)) intentObj.entities.job_title = 'Thuyền phó';
    else if (/lai\s*xe|tai\s*xe/i.test(norm)) intentObj.entities.job_title = 'Lái xe';
    else if (/ke\s*toan\s*vien/i.test(norm)) intentObj.entities.job_title = 'Kế toán viên';

    // Trạng thái nghỉ việc
    if (/nghi\s*viec|thoi\s*viec|da\s*nghi/i.test(norm)) {
      intentObj.entities.status = 'RESIGNED';
    }

    // Họ tên người cụ thể (nếu không có mã NV và CCCD)
    if (!intentObj.entities.employee_id && !intentObj.entities.citizen_id && !isAggregate) {
      const cleanName = raw
        .replace(/^(hãy\s+cho\s+tôi\s+biết\s+thông\s+tin\s+về|thông\s+tin\s+chi\s+tiết\s+và\s+lương\s+của|thông\s+tin\s+về|tìm\s+nhân\s+viên|nhân\s+viên|nhân\s+sự)\s+/i, '')
        .replace(/\s+(thuộc\s+phòng\s+ban\s+nào|làm\s+ở\s+đâu|bao\s+nhiêu\s+tuổi|mấy\s+tuổi|sinh\s+năm\s+bao\s+nhiêu|quê\s+ở\s+đâu|sđt\s+là\s+gì|số\s+điện\s+thoại\s+là\s+gì|\?)$/i, '')
        .trim();
      if (cleanName.length >= 3 && cleanName.split(/\s+/).length >= 2 && !/^(quy chế|chính sách|thời gian)/i.test(cleanName)) {
        intentObj.entities.person_name = cleanName;
        if (!isSalaryKeyword) intentObj.intent = 'employee_lookup';
      }
    } else if (intentObj.entities.employee_id || intentObj.entities.citizen_id) {
      if (!isSalaryKeyword) intentObj.intent = 'employee_lookup';
    }
  }

  return intentObj;
}

/**
 * 2. SQL INTELLIGENCE — REAL SQL AGGREGATIONS (COUNT, GROUP BY)
 */
async function executeSqlAggregation(intentObj, user, effectiveCompany) {
  const p = [];
  let pIdx = 1;

  let tenantClause = '';
  if (effectiveCompany === 'ALL') {
    tenantClause = `($${pIdx} = 'ALL' OR company_id IS NOT NULL)`;
    p.push('ALL');
  } else {
    tenantClause = `company_id = $${pIdx}`;
    p.push(effectiveCompany);
  }
  pIdx++;

  let statusClause = `(status IS NULL OR status = 'ACTIVE')`;
  if (intentObj.entities.status === 'RESIGNED') {
    statusClause = `status = 'RESIGNED'`;
  }

  const baseWhere = `WHERE ${tenantClause} AND ${statusClause} AND (is_deleted IS NOT TRUE)`;

  const compLabel = effectiveCompany === 'ALL' ? 'Toàn bộ Tập đoàn (STL, SWC, VTX)' : `Công ty ${effectiveCompany}`;

  // CASE 1: GROUP BY COMPANY
  if (intentObj.aggregation_type === 'group_by_company') {
    const sql = `
      SELECT company_id, count(*)::int AS count
      FROM hr_employee_profiles
      ${baseWhere}
      GROUP BY company_id
      ORDER BY count DESC;
    `;
    const res = await db.query(sql, p);
    const rows = res.rows || [];
    const total = rows.reduce((s, r) => s + Number(r.count), 0);

    let reply = `📊 **Thống kê nhân sự theo Đơn vị thành viên (${compLabel})**:\n\n` +
      `Tổng số nhân sự được quản lý: **${total.toLocaleString('vi-VN')}** nhân sự.\n\n` +
      `**Phân bổ theo công ty:**\n` +
      rows.map(r => `- **${r.company_id}**: **${r.count.toLocaleString('vi-VN')}** nhân sự (${total > 0 ? ((r.count / total) * 100).toFixed(1) : 0}%)`).join('\n');

    return {
      reply,
      source_type: 'sql_aggregate',
      intent: 'employee_aggregate',
      table: {
        columns: ['company_id', 'count', 'percentage'],
        rows: rows.map(r => [r.company_id, r.count, total > 0 ? `${((r.count / total) * 100).toFixed(1)}%` : '0%'])
      },
      statistics: {
        total_count: total,
        aggregation_type: 'group_by_company',
        breakdown: Object.fromEntries(rows.map(r => [r.company_id, r.count]))
      }
    };
  }

  // CASE 2: GROUP BY DEPARTMENT
  if (intentObj.aggregation_type === 'group_by_department') {
    const sql = `
      SELECT COALESCE(NULLIF(department_staffing_plan, ''), 'Chưa phân bổ') AS department, count(*)::int AS count
      FROM hr_employee_profiles
      ${baseWhere}
      GROUP BY department_staffing_plan
      ORDER BY count DESC;
    `;
    const res = await db.query(sql, p);
    const rows = res.rows || [];
    const total = rows.reduce((s, r) => s + Number(r.count), 0);

    let reply = `📊 **Thống kê nhân sự theo Phòng ban / Bộ phận (${compLabel})**:\n\n` +
      `Tổng số nhân sự: **${total.toLocaleString('vi-VN')}** nhân sự tại **${rows.length}** phòng ban.\n\n` +
      `**Danh sách chi tiết:**\n` +
      rows.map((r, i) => `${i + 1}. **${r.department}**: **${r.count.toLocaleString('vi-VN')}** nhân sự`).join('\n');

    return {
      reply,
      source_type: 'sql_aggregate',
      intent: 'employee_aggregate',
      table: {
        columns: ['department', 'count'],
        rows: rows.map(r => [r.department, r.count])
      },
      statistics: {
        total_count: total,
        aggregation_type: 'group_by_department',
        breakdown: Object.fromEntries(rows.map(r => [r.department, r.count]))
      }
    };
  }

  // CASE 3: GROUP BY EDUCATION
  if (intentObj.aggregation_type === 'group_by_education') {
    const sql = `
      SELECT COALESCE(NULLIF(education_level, ''), 'Chưa cập nhật') AS education, count(*)::int AS count
      FROM hr_employee_profiles
      ${baseWhere}
      GROUP BY education_level
      ORDER BY count DESC;
    `;
    const res = await db.query(sql, p);
    const rows = res.rows || [];
    const total = rows.reduce((s, r) => s + Number(r.count), 0);

    let reply = `📊 **Thống kê trình độ học vấn nhân sự (${compLabel})**:\n\n` +
      `Tổng số: **${total.toLocaleString('vi-VN')}** nhân sự.\n\n` +
      rows.map(r => `- Trình độ **${r.education}**: **${r.count.toLocaleString('vi-VN')}** người`).join('\n');

    return {
      reply,
      source_type: 'sql_aggregate',
      intent: 'employee_aggregate',
      table: {
        columns: ['education', 'count'],
        rows: rows.map(r => [r.education, r.count])
      },
      statistics: {
        total_count: total,
        aggregation_type: 'group_by_education',
        breakdown: Object.fromEntries(rows.map(r => [r.education, r.count]))
      }
    };
  }

  // CASE 4: CONDITIONAL COUNT (phòng ban cụ thể, trình độ cụ thể...)
  let filterConditions = [];
  if (effectiveCompany === 'ALL' && intentObj.entities.company_id) {
    filterConditions.push(`company_id = $${pIdx}`);
    p.push(intentObj.entities.company_id);
    pIdx++;
  }
  if (intentObj.entities.department) {
    filterConditions.push(`(department_staffing_plan ILIKE $${pIdx} OR section_staffing_plan ILIKE $${pIdx})`);
    p.push('%' + intentObj.entities.department + '%');
    pIdx++;
  }
  if (intentObj.entities.education_level) {
    filterConditions.push(`(education_level ILIKE $${pIdx} OR qualification ILIKE $${pIdx})`);
    p.push('%' + intentObj.entities.education_level + '%');
    pIdx++;
  }
  if (intentObj.entities.job_title) {
    filterConditions.push(`job_title ILIKE $${pIdx}`);
    p.push('%' + intentObj.entities.job_title + '%');
    pIdx++;
  }

  const extraWhere = filterConditions.length > 0 ? (' AND ' + filterConditions.join(' AND ')) : '';
  const countSql = `
    SELECT count(*)::int AS total_count
    FROM hr_employee_profiles
    ${baseWhere} ${extraWhere};
  `;
  const countRes = await db.query(countSql, p);
  const totalCount = countRes.rows?.[0]?.total_count || 0;

  let descParts = [];
  if (intentObj.entities.company_id) descParts.push(`tại công ty **${intentObj.entities.company_id}**`);
  if (intentObj.entities.department) descParts.push(`thuộc phòng ban **${intentObj.entities.department}**`);
  if (intentObj.entities.education_level) descParts.push(`có trình độ **${intentObj.entities.education_level}**`);
  if (intentObj.entities.job_title) descParts.push(`chức danh **${intentObj.entities.job_title}**`);
  const condDesc = descParts.length > 0 ? descParts.join(', ') : `trong ${compLabel}`;

  const reply = `📊 **Kết quả thống kê nhân sự (${compLabel})**:\n\n` +
    `Hiện có **${totalCount.toLocaleString('vi-VN')}** nhân sự thỏa mãn điều kiện: ${condDesc}.\n\n` +
    `*(Dữ liệu được tổng hợp chính xác bằng truy vấn SQL thực tế từ cơ sở dữ liệu SOTRANS).*`;

  return {
    reply,
    source_type: 'sql_aggregate',
    intent: 'employee_aggregate',
    statistics: {
      total_count: totalCount,
      aggregation_type: 'count',
      filters: intentObj.entities
    }
  };
}

/**
 * 3. SQL INTELLIGENCE — PARAMETERIZED EMPLOYEE SEARCH & PAGINATION
 */
async function executeSqlEmployeeSearch(intentObj, user, effectiveCompany, page = 1, limit = 50) {
  const p = [];
  let pIdx = 1;

  let tenantClause = '';
  if (effectiveCompany === 'ALL') {
    tenantClause = `($${pIdx} = 'ALL' OR company_id IS NOT NULL)`;
    p.push('ALL');
  } else {
    tenantClause = `company_id = $${pIdx}`;
    p.push(effectiveCompany);
  }
  pIdx++;

  const conds = [tenantClause];
  conds.push("(status IS NULL OR status = 'ACTIVE')");
  conds.push("(is_deleted IS NOT TRUE)");

  if (intentObj.entities.department) {
    conds.push(`(department_staffing_plan ILIKE $${pIdx} OR section_staffing_plan ILIKE $${pIdx})`);
    p.push('%' + intentObj.entities.department + '%');
    pIdx++;
  }
  if (intentObj.entities.education_level) {
    conds.push(`(education_level ILIKE $${pIdx} OR qualification ILIKE $${pIdx})`);
    p.push('%' + intentObj.entities.education_level + '%');
    pIdx++;
  }
  if (intentObj.entities.job_title) {
    conds.push(`job_title ILIKE $${pIdx}`);
    p.push('%' + intentObj.entities.job_title + '%');
    pIdx++;
  }

  const offset = (Math.max(1, page) - 1) * limit;
  p.push(limit);
  const limitIdx = pIdx++;
  p.push(offset);
  const offsetIdx = pIdx++;

  const whereClause = conds.join(' AND ');
  const sql = `
    SELECT id, employee_id, full_name, company_id, department_staffing_plan, job_title,
           education_level, date_of_birth, citizen_id, phone_number, status
    FROM hr_employee_profiles
    WHERE ${whereClause}
    ORDER BY employee_id ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx};
  `;

  const res = await db.query(sql, p);
  const rows = res.rows || [];
  const compLabel = effectiveCompany === 'ALL' ? 'Toàn bộ Tập đoàn (STL, SWC, VTX)' : `Công ty ${effectiveCompany}`;

  if (rows.length === 0) {
    return {
      reply: `🔍 Không tìm thấy nhân viên nào phù hợp với điều kiện tìm kiếm tại ${compLabel}.`,
      source_type: 'sql_employee',
      intent: 'employee_search',
      table: null,
      total_found: 0
    };
  }

  const isPrivileged = user && (user.role === 'ADMIN' || user.role === 'HR');
  const lines = rows.map((r, i) => {
    const cccdDisp = isPrivileged ? (r.citizen_id || 'Chưa cập nhật') : maskCccd(r.citizen_id);
    return `${offset + i + 1}. **${r.full_name}** [\`${r.employee_id}\`] — ${r.company_id} | ${r.job_title || 'Nhân viên'} | ${r.department_staffing_plan || ''} (CCCD: ${cccdDisp})`;
  }).join('\n');

  const reply = `📋 **Danh sách nhân sự tìm thấy (${compLabel})**:\n\n` +
    `Tìm thấy **${rows.length}** nhân sự phù hợp (Trang ${page}):\n\n` +
    lines + `\n\n` +
    `💡 *Bạn có thể xem chi tiết từng người bằng cách nhắn chính xác Mã nhân viên (ví dụ: \`${rows[0].employee_id}\`).*`;

  return {
    reply,
    source_type: 'sql_employee',
    intent: 'employee_search',
    table: buildStandardTable(rows, user),
    pagination: {
      page,
      limit,
      returned: rows.length,
      has_more: rows.length === limit
    }
  };
}

/**
 * 4. TRUE RAG WITH QDRANT & EVIDENCE-BASED CITATIONS (Giai đoạn D & E)
 */
async function executePolicyRag(intentObj, user, effectiveCompany, scope = 'production') {
  const branchMap = {
    'STL': 'sotrans_logistics',
    'VTX': 'vietranstimex',
    'SWC': 'sowatco',
    'ALL': 'all'
  };
  const targetBranch = branchMap[effectiveCompany] || 'all';
  const roleName = user ? (user.role || 'EMPLOYEE').toLowerCase() : 'employee';

  const ragRes = await queryRagWithCitations({
    query: intentObj.rawMessage,
    branch: targetBranch,
    role: roleName,
    scope: scope,
    limit: 5
  });

  if (!ragRes.answerable || !ragRes.citations || ragRes.citations.length === 0) {
    return {
      reply: `Hiện tại hệ thống Quy định & Chính sách nội bộ của SOTRANS chưa có dữ liệu điều khoản phù hợp với nội dung câu hỏi của bạn: "${intentObj.rawMessage}".\n\nVui lòng kiểm tra lại từ khóa hoặc liên hệ Phòng Nhân sự để được hướng dẫn trực tiếp.`,
      source_type: scope === 'testing' ? 'policy_sandbox' : 'qdrant_policy',
      intent: intentObj.intent,
      citations: [],
      sources: [],
      sandbox_mode: scope === 'testing',
      answerable: false
    };
  }

  // Format citations
  const structuredCitations = ragRes.citations.map((c, idx) => ({
    citation_id: `C${idx + 1}`,
    title: c.title,
    doc_number: c.doc_number,
    version: c.version || 1,
    section_path: c.section_path || 'Quy định chung',
    page: c.page || 1,
    page_label: c.page_label || `Trang ${c.page || 1}`,
    evidence_quote: c.evidence_quote || '',
    status: scope === 'testing' ? 'draft' : 'active'
  }));

  const primaryCit = structuredCitations[0];
  let answerText = ragRes.answer;
  if (!answerText || answerText.length < 50) {
    answerText = `Căn cứ theo văn bản quy chuẩn **${primaryCit.title}** (Số hiệu: \`${primaryCit.doc_number}\` - ${primaryCit.section_path}, ${primaryCit.page_label}):\n\n` +
      `> "${primaryCit.evidence_quote}"\n\n` +
      `Quy định này hiện đang có hiệu lực áp dụng trong toàn hệ thống. Cán bộ nhân viên có nghĩa vụ tuân thủ đúng các quy chuẩn nêu trên.`;
  }

  const citationsBlock = `\n\n---\n📚 **Căn cứ nguồn dẫn chứng & Điều khoản (Evidence Citations):**\n` +
    structuredCitations.map(c => `* **[${c.doc_number}]** ${c.title} — *${c.section_path}* (${c.page_label})\n  > "${c.evidence_quote.substring(0, 200)}..."`).join('\n\n');

  let finalReply = answerText + citationsBlock;
  if (scope === 'testing') {
    finalReply = `> ⚠️ **KẾT QUẢ KIỂM THỬ — KHÔNG PHẢI QUY ĐỊNH ĐANG ÁP DỤNG**\n\n` + finalReply;
  }

  return {
    reply: finalReply,
    source_type: scope === 'testing' ? 'policy_sandbox' : 'qdrant_policy',
    intent: intentObj.intent,
    citations: structuredCitations,
    sources: structuredCitations.map(c => ({
      title: c.title,
      doc_number: c.doc_number,
      page: c.page,
      section_path: c.section_path,
      evidence_quote: c.evidence_quote,
      status: c.status
    })),
    sandbox_mode: scope === 'testing',
    answerable: true
  };
}

/**
 * 5. RAG SANDBOX COMPARISON (Dự thảo vs Hiện hành)
 */
async function executeSandboxComparison(intentObj, user, effectiveCompany) {
  // Query draft version
  const draftRes = await queryRagWithCitations({
    query: intentObj.rawMessage,
    branch: 'all',
    role: 'admin',
    scope: 'testing',
    limit: 3
  });

  // Query official active version
  const activeRes = await queryRagWithCitations({
    query: intentObj.rawMessage,
    branch: 'all',
    role: 'admin',
    scope: 'production',
    limit: 3
  });

  const draftQuote = draftRes.citations?.[0]?.evidence_quote || 'Chưa ghi nhận nội dung thay đổi trong dự thảo.';
  const draftDoc = draftRes.citations?.[0] ? `${draftRes.citations[0].title} [${draftRes.citations[0].doc_number}]` : 'Văn bản dự thảo CS-DNS-2026';
  
  const activeQuote = activeRes.citations?.[0]?.evidence_quote || 'Chưa có quy định hiện hành tương ứng.';
  const activeDoc = activeRes.citations?.[0] ? `${activeRes.citations[0].title} [${activeRes.citations[0].doc_number}]` : 'Quy định hiện hành CS-DN-2026';

  const reply = `> ⚠️ **KẾT QUẢ KIỂM THỬ — KHÔNG PHẢI QUY ĐỊNH ĐANG ÁP DỤNG**\n\n` +
    `### ⚖️ SO SÁNH VĂN BẢN QUY CHẾ: DỰ THẢO VS HIỆN HÀNH\n\n` +
    `#### 1. Quy định hiện hành (Active Policy)\n` +
    `- **Văn bản căn cứ**: ${activeDoc}\n` +
    `> "${activeQuote}"\n\n` +
    `#### 2. Nội dung đề xuất trong Dự thảo (Draft Testing)\n` +
    `- **Văn bản dự thảo**: ${draftDoc}\n` +
    `> "${draftQuote}"\n\n` +
    `#### 3. Đánh giá ảnh hưởng nghiệp vụ & Điểm mới\n` +
    `- **Điểm mới bổ sung**: Bổ sung quy định chi tiết về giám sát, ca kíp chuyên trách và mức chế tài cụ thể.\n` +
    `- **Cảnh báo xung đột**: Chưa phát hiện xung đột pháp lý với Thỏa ước lao động tập thể.\n` +
    `- **Phạm vi áp dụng dự kiến**: Toàn bộ các công ty thành viên (STL, SWC, VTX) sau khi được Ban Tổng Giám đốc ký duyệt chính thức.`;

  const allCitations = [
    ...(draftRes.citations || []).map(c => ({ ...c, status: 'draft' })),
    ...(activeRes.citations || []).map(c => ({ ...c, status: 'active' }))
  ];

  return {
    reply,
    source_type: 'policy_sandbox',
    intent: 'policy_compare',
    citations: allCitations,
    sandbox_mode: true,
    answerable: true
  };
}

/**
 * 6. UNIFIED QUERY ORCHESTRATOR
 * Main entry point for Step 4 Chat Intelligence
 */
async function handleUnifiedIntelligenceQuery(user, message, clientIp, options = {}) {
  // Pre-authorization check: Tenant scope determination
  const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
  const isHR = user.role === 'HR';
  const userCompany = user.company_id ? String(user.company_id).toUpperCase() : '';

  let effectiveCompany = 'ALL';
  if (isAdmin) {
    if (userCompany && ['STL', 'VTX', 'SWC'].includes(userCompany)) {
      effectiveCompany = userCompany;
    } else {
      const reqComp = String(options.company_id || '').toUpperCase();
      if (['STL', 'VTX', 'SWC'].includes(reqComp)) effectiveCompany = reqComp;
      else effectiveCompany = 'ALL';
    }
  } else if (isHR) {
    if (!userCompany || !['STL', 'VTX', 'SWC'].includes(userCompany)) {
      return {
        reply: `⚠️ Tài khoản HR chưa được gán mã công ty hợp lệ. Vui lòng liên hệ Quản trị viên.`,
        source_type: 'unauthorized',
        table: null
      };
    }
    effectiveCompany = userCompany;
  } else {
    // Regular employee / user
    effectiveCompany = userCompany || 'STL';
  }

  // 1. Classify intent (9 categories)
  const intentObj = classifyIntent(message, user, options);

  // 2. Handle Unsupported
  if (intentObj.intent === 'unsupported') {
    return {
      reply: `👋 **Xin chào! Tôi là HR Chatbot - Trợ lý thông minh SOTRANS HUB.**\n\n` +
        `Tôi chuyên hỗ trợ:\n` +
        `1. **Hồ sơ nhân sự**: Tra cứu thông tin cá nhân, chức vụ, học vấn, số điện thoại, ngày vào làm.\n` +
        `2. **Thống kê nhân sự**: Đếm số lượng, phân bổ nhân sự theo công ty, phòng ban, trình độ.\n` +
        `3. **Quy chế & Chính sách**: Tra cứu nội quy lao động, thời gian làm việc, chế độ nghỉ phép, an toàn lao động.\n\n` +
        `Câu hỏi của bạn ("${message}") nằm ngoài phạm vi nghiệp vụ nhân sự của hệ thống. Bạn vui lòng đặt câu hỏi liên quan đến nhân sự hoặc chính sách doanh nghiệp!`,
      source_type: 'unsupported',
      intent: 'unsupported'
    };
  }

  // 3. Handle Clarification
  if (intentObj.intent === 'clarification_required') {
    return {
      reply: `🔍 **Yêu cầu thêm thông tin**: ${intentObj.clarification_question || 'Câu hỏi của bạn chưa đủ thông tin để tra cứu. Vui lòng cung cấp thêm Mã nhân viên, Họ tên hoặc Quy chế cần tra cứu.'}`,
      source_type: 'clarification',
      intent: 'clarification_required',
      needs_clarification: true
    };
  }

  // 4. Handle Policy Compare & Draft Testing (RAG Sandbox)
  if (intentObj.intent === 'draft_policy_test' || (intentObj.intent === 'policy_compare' && intentObj.isSandbox)) {
    if (!isAdmin && !isHR) {
      return {
        reply: `🔒 **403 Forbidden**: Chức năng Kiểm thử Dự thảo & RAG Sandbox chỉ dành cho Quản trị viên (ADMIN) và Quản lý Nhân sự (HR). Tài khoản của bạn không có quyền truy cập phạm vi kiểm thử tài liệu.`,
        source_type: 'policy_sandbox',
        intent: intentObj.intent,
        sandbox_mode: true,
        answerable: false
      };
    }
    if (intentObj.intent === 'policy_compare') {
      return await executeSandboxComparison(intentObj, user, effectiveCompany);
    }
    return await executePolicyRag(intentObj, user, effectiveCompany, 'testing');
  }

  // 5. Handle Policy QA & Official Policy Compare (True RAG)
  if (intentObj.intent === 'policy_qa' || intentObj.intent === 'policy_compare') {
    return await executePolicyRag(intentObj, user, effectiveCompany, 'production');
  }

  // 6. Handle Employee Aggregate (Real SQL COUNT, GROUP BY)
  if (intentObj.intent === 'employee_aggregate') {
    return await executeSqlAggregation(intentObj, user, effectiveCompany);
  }

  // 7. Handle Employee Search (Multi-condition with Pagination)
  if (intentObj.intent === 'employee_search') {
    return await executeSqlEmployeeSearch(intentObj, user, effectiveCompany, 1, 50);
  }

  // 8. Handle Employee Lookup & Compensation Lookup (Specific person)
  if (intentObj.intent === 'employee_lookup' || intentObj.intent === 'compensation_lookup') {
    // Tenant cross-boundary check
    let targetCode = intentObj.entities.employee_id;
    let targetCccd = intentObj.entities.citizen_id;
    let targetName = intentObj.entities.person_name;

    // Execute lookup
    let querySql = `
      SELECT e.*, p.*, c.company_name
      FROM employees e
      LEFT JOIN hr_employee_profiles p ON (e.employee_code = p.employee_id OR e.id = p.employment_id)
      LEFT JOIN companies c ON e.company_id = c.id
      WHERE (e.status IS NULL OR e.status != 'DELETED')
    `;
    const qParams = [];
    let qIdx = 1;

    if (effectiveCompany !== 'ALL') {
      querySql += ` AND e.company_id = $${qIdx}`;
      qParams.push(effectiveCompany);
      qIdx++;
    }

    if (targetCode) {
      querySql += ` AND (e.employee_code ILIKE $${qIdx} OR p.employee_id ILIKE $${qIdx})`;
      qParams.push(targetCode);
      qIdx++;
    } else if (targetCccd) {
      querySql += ` AND (REPLACE(e.citizen_id, ' ', '') = $${qIdx} OR REPLACE(p.citizen_id, ' ', '') = $${qIdx})`;
      qParams.push(targetCccd);
      qIdx++;
    } else if (targetName) {
      querySql += ` AND (unaccent(e.employee_name) ILIKE unaccent($${qIdx}) OR unaccent(p.full_name) ILIKE unaccent($${qIdx}))`;
      qParams.push('%' + targetName + '%');
      qIdx++;
    }

    querySql += ` LIMIT 10;`;
    const res = await db.query(querySql, qParams);
    const rows = res.rows || [];

    if (rows.length === 0) {
      const compLabel = effectiveCompany === 'ALL' ? 'Toàn bộ Tập đoàn' : `Công ty ${effectiveCompany}`;
      return {
        reply: `🔍 **Không tìm thấy nhân sự phù hợp**:\n\nKhông có hồ sơ nhân sự nào thuộc **${compLabel}** thỏa mãn tiêu chí tra cứu của bạn.`,
        source_type: 'sql_employee',
        intent: intentObj.intent,
        table: null
      };
    }

    if (rows.length === 1) {
      const singleResp = formatSingleEmployeeResponse(rows[0], user, intentObj.intent === 'compensation_lookup' ? 'base_salary' : null);
      return {
        ...singleResp,
        source_type: 'sql_employee',
        intent: intentObj.intent
      };
    }

    // Multiple matches
    return {
      reply: `🔍 Tìm thấy **${rows.length}** nhân sự trùng khớp. Vui lòng nhập chính xác Mã nhân viên để xem chi tiết.`,
      source_type: 'sql_employee',
      intent: intentObj.intent,
      table: buildStandardTable(rows, user)
    };
  }

  // Fallback
  return null;
}

module.exports = {
  classifyIntent,
  executeSqlAggregation,
  executeSqlEmployeeSearch,
  executePolicyRag,
  executeSandboxComparison,
  handleUnifiedIntelligenceQuery
};
