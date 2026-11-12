import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

with open('workflows_modified.json', 'r', encoding='utf-8') as f:
    workflows = json.load(f)

hr_bot = None
for w in workflows:
    if w.get('name') == 'HR_Chatbot' or w.get('id') == 'KRZmkYM690YlIdPU':
        hr_bot = w
        break

if not hr_bot:
    print("HR_Chatbot not found!")
    sys.exit(1)

# 1. Parse_Fast_Intent
parse_fast_code = """const body = $input.first().json;
const text = String(body.text || body.message || body.prompt || '').trim();
const sessionId = body.sessionId || body.conversation_id || 'web';
const companyId = body.companyId || body.company_id || 'ALL';
const userRole = body.userRole || body.role || 'HR';
const userId = body.userId || body.user_id || 'system';
const userName = body.userName || body.name || 'Người dùng';

// 1. Kiểm tra trợ giúp / hướng dẫn
const helpPatterns = [
  /^(trợ giúp|hướng dẫn|cứu|help|\\?)$/i,
  /^bạn có thể làm gì/i,
  /^hướng dẫn sử dụng/i
];
const isHelp = helpPatterns.some(p => p.test(text));

if (isHelp) {
  const helpReply = `👋 **Chào bạn, tôi là HR Chatbot - Trợ lý số hóa & Tra cứu Hồ sơ Nhân sự SOTRANS.**\\n\\n` +
    `Tôi có thể hỗ trợ bạn:\\n` +
    `1. **Tra cứu nhân sự**: Theo Họ tên, Mã nhân viên (SWC..., STL...), Số CCCD, Số điện thoại, Quê quán, Địa chỉ.\\n` +
    `2. **Xem hồ sơ nhân sự**: Hiển thị đầy đủ thông tin cá nhân, phòng ban, chức vụ, học vấn, bằng cấp, số điện thoại.\\n` +
    `3. **Truy vấn thống kê**: Tìm nhân viên theo trình độ học vấn, độ tuổi, năm sinh, phòng ban.\\n` +
    `4. **Số hóa hồ sơ**: Tải lên tệp scan (PDF, ảnh) để trích xuất và phê duyệt hồ sơ.\\n\\n` +
    `💡 *Ví dụ:* "hãy cho tôi biết thông tin về Nhân viên Ngô Đặng Tuấn Uyên", "Nhân viên Ngô Đặng Tuấn Uyên mã nhân viên là mấy", "SWC00016"`;
  return [{
    json: {
      isHelp: true,
      isFastPath: true,
      reply: helpReply,
      userQuestion: text,
      sessionId,
      companyId
    }
  }];
}

// 2. Nhận diện Fast-path: Nhập trực tiếp số CCCD (9 hoặc 12 số)
const cleanDigits = text.replace(/\\D/g, '');
if ((cleanDigits.length === 12 || cleanDigits.length === 9) && text.replace(/[\\s-]/g, '').length === cleanDigits.length) {
  return [{
    json: {
      isHelp: false,
      isFastPath: true,
      userQuestion: text,
      sessionId,
      companyId,
      sqlQuery: "SELECT * FROM hr_employee_profiles WHERE REPLACE(citizen_id, ' ', '') = $1 AND ($2 = 'ALL' OR company_id = $2) LIMIT 10;",
      sqlParams: [cleanDigits, companyId]
    }
  }];
}

// 3. Nhận diện Fast-path: Nhập trực tiếp Số điện thoại (10 số, bắt đầu bằng 0)
if (/^0\\d{9}$/.test(cleanDigits) && text.replace(/[\\s.-]/g, '').length === cleanDigits.length) {
  return [{
    json: {
      isHelp: false,
      isFastPath: true,
      userQuestion: text,
      sessionId,
      companyId,
      sqlQuery: "SELECT * FROM hr_employee_profiles WHERE REPLACE(phone_number, ' ', '') = $1 AND ($2 = 'ALL' OR company_id = $2) LIMIT 10;",
      sqlParams: [cleanDigits, companyId]
    }
  }];
}

// 4. Nhận diện Fast-path: Mã nhân viên (e.g. SWC00016, SWC-00016, mã nv SWC00016, STL00012)
const codeMatch = text.match(/^(?:mã\\s*(?:nv|nhân viên|số)?\\s*[:\\s]*)?([A-Za-z]{2,10})[-_]?(\\d{3,8})$/i);
if (codeMatch && text.length <= 25) {
  const codeClean = codeMatch[1].toUpperCase() + codeMatch[2];
  return [{
    json: {
      isHelp: false,
      isFastPath: true,
      userQuestion: text,
      cleanKw: codeClean,
      sessionId,
      companyId,
      sqlQuery: "SELECT * FROM hr_employee_profiles WHERE (REPLACE(REPLACE(employee_id, '-', ''), '_', '') ILIKE $1 OR employee_id ILIKE $2) AND ($3 = 'ALL' OR company_id = $3) LIMIT 10;",
      sqlParams: ['%' + codeClean + '%', '%' + codeMatch[1] + '%' + codeMatch[2] + '%', companyId]
    }
  }];
}

// 5. Đối với các câu hỏi tự nhiên thông thường: Chuẩn bị prompt cho Gemini Rewrite
const rewriteSystemPrompt = `Bạn là chuyên gia NLP nhân sự cho HR Chatbot. Bảng dữ liệu nhân sự 'hr_employee_profiles' có các trường:
- employee_id (Mã nhân viên, ví dụ: 'SWC00016', 'STL00012')
- full_name (Họ và tên)
- department_staffing_plan (Phòng ban / Đơn vị)
- job_title (Chức danh / Vị trí)
- place_of_origin (Quê quán)
- permanent_address (Hộ khẩu thường trú)
- current_address (Địa chỉ hiện tại / nơi ở)
- citizen_id (Số CCCD - 12 chữ số)
- phone_number (Số điện thoại)
- email (Email)
- date_of_birth (Ngày sinh / năm sinh, định dạng YYYY-MM-DD)
- education_level (Trình độ học vấn, ví dụ: 'Đại học', 'Cao đẳng', 'Trung cấp', '12/12', '8/12')
- recruitment_decision_no (Số quyết định tiếp nhận)

Nhiệm vụ: Phân tích câu hỏi của người dùng và trích xuất thành JSON:
{
  "employee_id": "mã nhân viên nếu có hoặc null",
  "department": "tên phòng ban (bỏ chữ 'phòng' nếu có) hoặc null",
  "job_title": "vị trí/chức danh hoặc null",
  "place_of_origin": "quê quán cụ thể hoặc null",
  "address": "địa chỉ hoặc null",
  "full_name": "tên người cụ thể nếu có hoặc null",
  "citizen_id": "số cccd nếu có hoặc null",
  "phone_number": "số sđt nếu có hoặc null",
  "birth_year": "năm sinh cụ thể nếu có hoặc null",
  "education_level": "trình độ học vấn nếu có hoặc null",
  "decision_no": "số quyết định nếu có hoặc null",
  "is_comparative_or_general": true nếu câu hỏi có tính so sánh (dưới, trên, trước, sau, hơn, kém), hỏi về vùng miền (miền Tây, miền Bắc...), hỏi về trình độ/bằng cấp/lương/thống kê chung, hoặc liệt kê nhiều người; false nếu là tra cứu 1 người cụ thể,
  "is_general_profile_query": true nếu người dùng hỏi chung/toàn bộ thông tin về 1 nhân sự (ví dụ: 'thông tin về nhân viên X', 'cho tôi biết thông tin X', 'hồ sơ nhân sự X', 'tra cứu X'), false nếu người dùng hỏi 1 trường thuộc tính cụ thể (như 'mã nhân viên là mấy', 'số điện thoại là bao nhiêu', 'quê ở đâu'),
  "search_query": "từ khóa tìm kiếm tổng hợp"
}
Chỉ trả về JSON hợp lệ, không bọc markdown.`;

const geminiRewriteBody = {
  contents: [
    {
      role: "user",
      parts: [
        { text: `${rewriteSystemPrompt}\\n\\nCâu hỏi của người dùng: "${text}"` }
      ]
    }
  ],
  generationConfig: {
    temperature: 0.1,
    responseMimeType: "application/json"
  }
};

return [{
  json: {
    isHelp: false,
    isFastPath: false,
    userQuestion: text,
    sessionId,
    companyId,
    userRole,
    userId,
    userName,
    geminiRewriteBody
  }
}];"""

# 2. Build_SQL_From_Rewrite
build_sql_code = """const geminiResp = $input.first().json;
const fastIntent = $('Parse_Fast_Intent').first().json;
const userQuestion = fastIntent.userQuestion || '';
const sessionId = fastIntent.sessionId || 'web';
const companyId = fastIntent.companyId || 'STL';
const userRole = fastIntent.userRole || 'HR';

const rawText = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
let criteria = {};
try {
  criteria = JSON.parse(rawText.replace(/^```json\\s*/i, '').replace(/```\\s*$/i, '').trim());
} catch (e) {
  criteria = { search_query: userQuestion };
}

// 1. Direct identifier lookups: Mã nhân viên (employee_id)
if (criteria.employee_id) {
  const empCode = String(criteria.employee_id).replace(/[-\\s_]/g, '');
  return [{
    json: {
      sqlQuery: "SELECT * FROM hr_employee_profiles WHERE (REPLACE(REPLACE(employee_id, '-', ''), '_', '') ILIKE $1 OR employee_id ILIKE $2) AND ($3 = 'ALL' OR company_id = $3) LIMIT 10;",
      sqlParams: ['%' + empCode + '%', '%' + criteria.employee_id + '%', companyId],
      userQuestion,
      sessionId,
      companyId,
      criteria
    }
  }];
}

// 2. Direct identifier lookups: CCCD / SĐT / Số quyết định
if (criteria.citizen_id) {
  const cccd = String(criteria.citizen_id).replace(/\\D/g, '');
  if (cccd.length >= 9) {
    return [{
      json: {
        sqlQuery: "SELECT * FROM hr_employee_profiles WHERE REPLACE(citizen_id, ' ', '') = $1 AND ($2 = 'ALL' OR company_id = $2) LIMIT 10;",
        sqlParams: [cccd, companyId],
        userQuestion,
        sessionId,
        companyId,
        criteria
      }
    }];
  }
}

if (criteria.phone_number) {
  const phone = String(criteria.phone_number).replace(/\\D/g, '');
  if (phone.length >= 9) {
    return [{
      json: {
        sqlQuery: "SELECT * FROM hr_employee_profiles WHERE REPLACE(phone_number, ' ', '') = $1 AND ($2 = 'ALL' OR company_id = $2) LIMIT 10;",
        sqlParams: [phone, companyId],
        userQuestion,
        sessionId,
        companyId,
        criteria
      }
    }];
  }
}

if (criteria.decision_no) {
  const decNo = String(criteria.decision_no).trim();
  return [{
    json: {
      sqlQuery: "SELECT * FROM hr_employee_profiles WHERE recruitment_decision_no ILIKE $1 AND ($2 = 'ALL' OR company_id = $2) LIMIT 10;",
      sqlParams: ['%' + decNo + '%', companyId],
      userQuestion,
      sessionId,
      companyId,
      criteria
    }
  }];
}

// 3. Tra cứu người cụ thể theo tên (khi không phải câu hỏi so sánh/liệt kê nhiều người)
if (criteria.full_name && !criteria.is_comparative_or_general) {
  const name = String(criteria.full_name).trim();
  return [{
    json: {
      sqlQuery: "SELECT * FROM hr_employee_profiles WHERE ($2 = 'ALL' OR company_id = $2) ORDER BY CASE WHEN unaccent(full_name) ILIKE unaccent($1) THEN 0 ELSE 1 END, id ASC LIMIT 50;",
      sqlParams: ['%' + name + '%', companyId],
      userQuestion,
      sessionId,
      companyId,
      criteria
    }
  }];
}

// 4. Với các câu hỏi so sánh, điều kiện học vấn, bằng cấp, lương, ngày sinh, vùng miền, danh sách, phòng ban:
return [{
  json: {
    sqlQuery: "SELECT * FROM hr_employee_profiles WHERE ($1 = 'ALL' OR company_id = $1) ORDER BY id ASC LIMIT 100;",
    sqlParams: [companyId],
    userQuestion,
    sessionId,
    companyId,
    criteria
  }
}];"""

# 3. Build_RAG_Prompt
build_rag_prompt_code = """const items = $input.all();
const employees = items.map(i => i.json).filter(r => r.full_name || r.citizen_id);
const buildSqlNode = $('Build_SQL_From_Rewrite').first().json;
const userQuestion = buildSqlNode.userQuestion || '';
const sessionId = buildSqlNode.sessionId || 'web';
const companyId = buildSqlNode.companyId || 'ALL';
const criteria = buildSqlNode.criteria || {};

const now = new Date(Date.now() + 7 * 3600 * 1000);
const currentYear = now.getUTCFullYear();
const currentMonth = now.getUTCMonth() + 1;
const currentDay = now.getUTCDate();
const currentDateVN = `${String(currentDay).padStart(2, '0')}/${String(currentMonth).padStart(2, '0')}/${currentYear}`;

const companyLabel = companyId === 'ALL' 
  ? 'Toàn bộ các đơn vị tập đoàn (STL, VTX, SWC)' 
  : (companyId === 'STL' 
      ? 'SOTRANS Logistics (STL)' 
      : (companyId === 'VTX' 
          ? 'Vietranstimex (VTX)' 
          : 'Sowatco (SWC)'));

const compactEmployees = employees.map(e => {
  let calculated_age = null;
  let birth_date_vn = '';
  if (e.date_of_birth && String(e.date_of_birth).trim()) {
    const raw = String(e.date_of_birth).trim();
    const parts = raw.split(/[-/]/);
    let by = null, bm = null, bd = null;
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        by = parseInt(parts[0], 10);
        bm = parseInt(parts[1], 10);
        bd = parseInt(parts[2], 10);
      } else if (parts[2].length === 4) {
        by = parseInt(parts[2], 10);
        bm = parseInt(parts[1], 10);
        bd = parseInt(parts[0], 10);
      }
    } else if (parts.length === 1 && parts[0].length === 4) {
      by = parseInt(parts[0], 10);
      bm = 1;
      bd = 1;
    }
    if (by && by > 1900 && by <= currentYear) {
      let age = currentYear - by;
      if (bm && (currentMonth < bm || (currentMonth === bm && currentDay < (bd || 1)))) {
        age--;
      }
      calculated_age = age;
      birth_date_vn = `${String(bd).padStart(2, '0')}/${String(bm).padStart(2, '0')}/${by}`;
    }
  }

  // Chuyển đổi tên công ty đầy đủ
  const cName = e.company_id === 'SWC' 
    ? 'Tổng Công Ty CP Đường Sông Miền Nam (SWC)' 
    : (e.company_id === 'VTX' 
        ? 'Công Ty Cổ Phần Vietranstimex (VTX)' 
        : 'Công Ty Cổ Phần Kho Vận Miền Nam (STL)');

  return {
    employee_id: e.employee_id || '',
    full_name: e.full_name,
    company_id: e.company_id,
    company_name: cName,
    department: e.department_staffing_plan || '',
    section: e.section_staffing_plan || '',
    job_title: e.job_title || '',
    professional_title: e.professional_title || '',
    date_of_birth: birth_date_vn || e.date_of_birth || '',
    tuoi_hien_tai: calculated_age !== null ? calculated_age : undefined,
    gender: e.gender || '',
    ethnicity: e.ethnicity || '',
    place_of_origin: e.place_of_origin || '',
    birth_registration_place: e.birth_registration_place || '',
    permanent_address: e.permanent_address || '',
    temporary_address: e.temporary_address || '',
    current_address: e.current_address || '',
    citizen_id: e.citizen_id || '',
    citizen_id_issue_date: e.citizen_id_issue_date || '',
    citizen_id_issue_place: e.citizen_id_issue_place || '',
    education_level: e.education_level || '',
    qualification: e.qualification || '',
    professional_qualification: e.professional_qualification || '',
    specialization: e.specialization || '',
    training_institution: e.training_institution || '',
    major: e.major || '',
    other_certificates: e.other_professional_certificates || '',
    phone_number: e.phone_number || '',
    email: e.email || '',
    employment_start_date: e.employment_start_date || '',
    base_salary: e.base_salary ? (Number(e.base_salary).toLocaleString('vi-VN') + ' VNĐ') : undefined
  };
});

function removeAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

const qNorm = removeAccents(userQuestion);

// Phát hiện câu hỏi hỏi thuộc tính cụ thể
const isSpecificAttrQuery = /(so\\s+dien\\s+thoai|sdt|dien\\s+thoai|ma\\s+nhan\\s+vien|ma\\s+nv|ma\\s+so|que\\s+quan|que\\s+o\\s+dau|que\\s+dau|nam\\s+sinh|ngay\\s+sinh|bao\\s+nhieu\\s+tuoi|may\\s+tuoi|cccd|cmnd|can\\s+cuoc|luong|thu\\s+nhap|bang\\s+cap|trinh\\s+do|chuc\\s+vu|chuc\\s+danh|phong\\s+ban)/i.test(qNorm);

// Phát hiện câu hỏi hỏi thông tin chung / toàn bộ hồ sơ
const isGeneralInfoQuery = /(thong\\s+tin\\s+ve\\s+nhan\\s+vien|thong\\s+tin\\s+nhan\\s+vien|thong\\s+tin\\s+ve\\s+nhan\\s+su|thong\\s+tin\\s+nhan\\s+su|ho\\s+so\\s+nhan\\s+vien|ho\\s+so\\s+nhan\\s+su|cho\\s+toi\\s+biet\\s+thong\\s+tin|xem\\s+thong\\s+tin|xem\\s+ho\\s+so|toan\\s+bo|chi\\s+tiet|profile|tra\\s+cuu)/i.test(qNorm) || !isSpecificAttrQuery;

const firstEmp = compactEmployees[0] || {};
const secInfo = firstEmp.section ? ' - ' + firstEmp.section : '';
const profInfo = firstEmp.professional_title ? ' - ' + firstEmp.professional_title : '';
const ageInfo = firstEmp.tuoi_hien_tai ? ' (' + firstEmp.tuoi_hien_tai + ' tuổi)' : '';

const systemPrompt = `Bạn là trợ lý nhân sự HR Chatbot của ${companyLabel}.

THỜI ĐIỂM HIỆN TẠI (REAL TIME): Ngày ${currentDateVN} (Năm ${currentYear}).
ĐƠN VỊ ĐƯỢC PHÉP TRUY XUẤT: ${companyLabel}.

Câu hỏi của người dùng: "${userQuestion}"

Dữ liệu hồ sơ nhân sự truy xuất được từ cơ sở dữ liệu (${compactEmployees.length} nhân viên):
${JSON.stringify(compactEmployees, null, 2)}

QUY TẮC TRẢ LỜI NGHIÊM NGẶT (TUÂN THỦ 100%):

1. TRƯỜNG HỢP 1: NGƯỜI DÙNG HỎI THÔNG TIN CHUNG / HỒ SƠ VỀ MỘT NHÂN SỰ
   (Ví dụ: "hãy cho tôi biết thông tin về Nhân viên [Tên]", "thông tin nhân viên [Tên]", "hồ sơ nhân sự [Tên]", "tra cứu [Tên]"):
   - Khi đó, người dùng muốn xem ĐẦY ĐỦ VÀ TOÀN BỘ thông tin về nhân viên đó.
   - Bạn PHẢI LIỆT KÊ TOÀN BỘ CÁC THÔNG TIN CÓ TRONG HỒ SƠ bằng danh sách Markdown rõ ràng, đẹp mắt:
     • **Mã nhân viên**: ${firstEmp.employee_id || '[Mã nhân viên nếu có]'} (NẾU CÓ TRONG DỮ LIỆU BẮT BUỘC PHẢI NÊU RÕ)
     • **Họ và tên**: ${firstEmp.full_name || '[Họ và tên]'}
     • **Đơn vị / Công ty**: ${firstEmp.company_name || firstEmp.company_id}
     • **Phòng ban / Bộ phận**: ${firstEmp.department || 'Chưa cập nhật'}${secInfo}
     • **Chức danh / Vị trí**: ${firstEmp.job_title || 'Chưa cập nhật'}${profInfo}
     • **Ngày sinh & Tuổi**: ${firstEmp.date_of_birth || 'Chưa cập nhật'}${ageInfo}
     • **Giới tính & Dân tộc**: ${firstEmp.gender || 'Chưa cập nhật'} - ${firstEmp.ethnicity || 'Chưa cập nhật'}
     • **Quê quán**: ${firstEmp.place_of_origin || 'Chưa cập nhật'}
     • **Nơi đăng ký khai sinh**: ${firstEmp.birth_registration_place || 'Chưa cập nhật'}
     • **Địa chỉ hiện tại / Nơi ở**: ${firstEmp.current_address || 'Chưa cập nhật'}
     • **Hộ khẩu thường trú**: ${firstEmp.permanent_address || 'Chưa cập nhật'}
     • **Tạm trú**: ${firstEmp.temporary_address || 'Chưa cập nhật'}
     • **Số CCCD**: ${firstEmp.citizen_id || 'Chưa cập nhật'} (Ngày cấp: ${firstEmp.citizen_id_issue_date || '—'}, Nơi cấp: ${firstEmp.citizen_id_issue_place || '—'})
     • **Trình độ học vấn & Chuyên môn**: ${[firstEmp.education_level, firstEmp.qualification, firstEmp.professional_qualification].filter(Boolean).join(', ') || 'Chưa cập nhật'} (Cơ sở đào tạo: ${firstEmp.training_institution || '—'}, Chuyên ngành: ${firstEmp.major || '—'})
     • **Chứng chỉ khác**: ${firstEmp.other_certificates || 'Không có'}
     • **Thông tin liên hệ**: SĐT: ${firstEmp.phone_number || 'Chưa cập nhật'} - Email: ${firstEmp.email || 'Chưa cập nhật'}
   *(Lưu ý: Chỉ hiển thị các trường có dữ liệu thực tế từ hồ sơ, không tự bịa thêm thông tin)*.

2. TRƯỜNG HỢP 2: NGƯỜI DÙNG HỎI MỘT TRƯỜNG THUỘC TÍNH CỤ THỂ
   (Ví dụ: "mã nhân viên là mấy", "số điện thoại là bao nhiêu", "quê ở đâu", "sinh năm nào", "đang làm ở bộ phận nào"):
   - Trả lời TRỰC TIẾP, ĐÚNG TRỌNG TÂM vào trường được hỏi (Ví dụ: "Mã nhân viên của nhân sự **Ngô Đặng Tuấn Uyên** là: **${firstEmp.employee_id || 'SWC00016'}**").
   - Kèm theo các thông tin nhận diện cơ bản: Họ tên, Đơn vị, Chức danh / Phòng ban.
   - TUYỆT ĐỐI KHÔNG trả lời "không ghi nhận mã nhân viên" khi trường employee_id có giá trị!
   - Không liệt kê lan man các trường không liên quan khi người dùng chỉ hỏi 1 câu hỏi đơn lẻ.

3. TRƯỜNG HỢP 3: KHÔNG TÌM THẤY DỮ LIỆU
   - Lịch sự thông báo không tìm thấy nhân sự phù hợp trong hệ thống dữ liệu ${companyLabel}.

4. ĐỊNH DẠNG & PHONG THÁI:
   - Sử dụng Markdown chuẩn, in đậm các tiêu đề và giá trị chính.
   - Trả lời bằng tiếng Việt tự nhiên, không mở đầu bằng câu chào rườm rà.`;

const geminiRagBody = {
  contents: [
    {
      role: 'user',
      parts: [
        { text: systemPrompt }
      ]
    }
  ],
  generationConfig: {
    temperature: 0.1
  }
};

return [{
  json: {
    geminiRagBody,
    userQuestion,
    sessionId,
    companyId,
    isGeneralInfoQuery,
    isSpecificAttrQuery,
    hasResults: compactEmployees.length > 0,
    employeeCount: compactEmployees.length
  }
}];"""

# 4. Format_RAG_Reply
format_rag_code = """const geminiResp = $input.first().json;
const sqlItems = $('Query_Postgres_RAG').all();
const buildPromptNode = $('Build_RAG_Prompt').first().json;
const userQuestion = buildPromptNode.userQuestion || '';
const isGeneralInfoQuery = buildPromptNode.isGeneralInfoQuery;
const isSpecificAttrQuery = buildPromptNode.isSpecificAttrQuery;

const reply = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text || 'Đã xử lý yêu cầu của bạn.';

const COLUMNS = [
  'job_grade', 'employee_id', 'full_name', 'date_of_birth', 'gender',
  'job_title', 'professional_title', 'department_staffing_plan', 'section_staffing_plan',
  'citizen_id', 'citizen_id_issue_date', 'citizen_id_issue_place', 'birth_registration_place',
  'place_of_origin', 'permanent_address', 'temporary_address', 'current_address',
  'ethnicity', 'education_level', 'education_code', 'qualification',
  'professional_qualification', 'specialization', 'degree_qualification',
  'training_institution', 'major', 'training_mode', 'training_period',
  'graduation_grade', 'degree_valid_until', 'other_professional_certificates',
  'social_insurance_salary', 'total_income', 'base_salary',
  'productivity_responsibility_pay', 'attendance_bonus', 'responsibility_allowance',
  'vessel_size_allowance', 'professional_allowance_t1', 'meal_allowance', 'other_allowances',
  'open_ended_contract', 'fixed_term_contract', 'seasonal_contract',
  'contract_start_date', 'contract_end_date', 'recruitment_decision_no',
  'employment_start_date', 'official_labor_contract_sign_date', 'phone_number',
  'email', 'create_time', 'file_name'
];

const allRows = sqlItems.map(i => i.json).filter(r => r.full_name || r.citizen_id);

function removeAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

const replyLower = removeAccents(reply);

// Lọc CHÍNH XÁC những nhân viên xuất hiện trong câu trả lời kết quả tra cứu của Gemini
const matchedEmployees = allRows.filter(r => {
  if (!r.full_name) return false;
  const nameNorm = removeAccents(r.full_name);
  if (replyLower.includes(nameNorm)) return true;
  if (r.citizen_id && reply.includes(String(r.citizen_id).replace(/\\D/g, ''))) return true;
  if (r.employee_id && reply.toLowerCase().includes(String(r.employee_id).toLowerCase())) return true;
  return false;
});

// Chỉ đính kèm bảng / thẻ hồ sơ khi:
// 1. Có từ 2 nhân viên trở lên (danh sách tóm tắt)
// 2. Hoặc 1 nhân viên nhưng là câu hỏi thông tin chung / toàn bộ hồ sơ (isGeneralInfoQuery === true)
let finalTable = null;
if (matchedEmployees.length > 1 || (matchedEmployees.length === 1 && isGeneralInfoQuery && !isSpecificAttrQuery)) {
  const tableRows = matchedEmployees.map(r => {
    return COLUMNS.map(col => {
      const val = r[col];
      return (val === undefined || val === null) ? '' : String(val);
    });
  });
  finalTable = {
    columns: COLUMNS,
    rows: tableRows
  };
}

return [{
  json: {
    reply,
    table: finalTable
  }
}];"""

# 5. Format_Fast_Reply
format_fast_code = """const intent = $('Parse_Fast_Intent').first().json;
const items = $input.all();
const rows = items.map(i => i.json).filter(r => r.full_name || r.citizen_id);

if (!rows.length) {
  let kw = intent.cleanKw || intent.text || intent.userQuestion || 'thông tin yêu cầu';
  const msg = `Không tìm thấy nhân viên nào phù hợp với từ khóa tra cứu: **${kw}**.\\n\\n💡 *Gợi ý: Bạn có thể tìm theo Mã nhân viên (SWC..., STL...), Số CCCD, Họ tên, Số điện thoại, Chức vụ, hoặc Phòng ban.*`;
  return [{ json: { reply: msg } }];
}

const COLUMNS = [
  "job_grade", "employee_id", "full_name", "date_of_birth", "gender",
  "job_title", "professional_title", "department_staffing_plan", "section_staffing_plan",
  "citizen_id", "citizen_id_issue_date", "citizen_id_issue_place", "birth_registration_place",
  "place_of_origin", "permanent_address", "temporary_address", "current_address",
  "ethnicity", "education_level", "education_code", "qualification",
  "professional_qualification", "specialization", "degree_qualification",
  "training_institution", "major", "training_mode", "training_period",
  "graduation_grade", "degree_valid_until", "other_professional_certificates",
  "social_insurance_salary", "total_income", "base_salary",
  "productivity_responsibility_pay", "attendance_bonus", "responsibility_allowance",
  "vessel_size_allowance", "professional_allowance_t1", "meal_allowance", "other_allowances",
  "open_ended_contract", "fixed_term_contract", "seasonal_contract",
  "contract_start_date", "contract_end_date", "recruitment_decision_no",
  "employment_start_date", "official_labor_contract_sign_date", "phone_number",
  "email", "create_time", "file_name"
];

let reply = '';
if (rows.length === 1) {
  const emp = rows[0];
  const compLabel = emp.company_id === 'SWC' ? 'Sowatco (SWC)' : (emp.company_id === 'VTX' ? 'Vietranstimex (VTX)' : 'SOTRANS Logistics (STL)');
  reply = `🔍 **Thông tin nhân viên ${emp.full_name}:**\\n\\n` +
    (emp.employee_id ? `• **Mã nhân viên**: **${emp.employee_id}**\\n` : '') +
    `• **Họ và tên**: **${emp.full_name}**\\n` +
    `• **Đơn vị / Công ty**: **${compLabel}**\\n` +
    (emp.job_title ? `• **Chức danh / Vị trí**: ${emp.job_title}\\n` : '') +
    (emp.department_staffing_plan ? `• **Phòng ban**: ${emp.department_staffing_plan}\\n` : '') +
    (emp.date_of_birth ? `• **Ngày sinh**: ${emp.date_of_birth}\\n` : '') +
    (emp.place_of_origin ? `• **Quê quán**: ${emp.place_of_origin}\\n` : '') +
    (emp.current_address ? `• **Nơi ở hiện nay**: ${emp.current_address}\\n` : '') +
    (emp.phone_number ? `• **Số điện thoại**: **${emp.phone_number}**\\n` : '') +
    (emp.email ? `• **Email**: ${emp.email}\\n` : '');
} else {
  const kw = intent.cleanKw || intent.text || intent.userQuestion || '';
  const listDetails = rows.map((emp, idx) => {
    let line = `${idx + 1}. **${emp.full_name}**`;
    if (emp.employee_id) line += ` [${emp.employee_id}]`;
    const comp = emp.company_id || '';
    if (comp) line += ` (${comp})`;
    if (emp.job_title) line += ` • *${emp.job_title}*`;
    if (emp.department_staffing_plan) line += ` - ${emp.department_staffing_plan}`;
    if (emp.phone_number) line += `\\n   - SĐT: ${emp.phone_number}`;
    return line;
  }).join('\\n\\n');

  reply = `🔍 Tìm thấy **${rows.length}** nhân viên phù hợp với từ khóa "**${kw}**":\\n\\n${listDetails}`;
}

const tableRows = rows.map(r => {
  return COLUMNS.map(col => {
    const val = r[col];
    return (val === undefined || val === null) ? '' : String(val);
  });
});
const finalTable = {
  columns: COLUMNS,
  rows: tableRows
};

return [{
  json: {
    reply,
    table: finalTable
  }
}];"""

router_code = """const req = $input.first().json;
const body = req.body || req;
const text = (body.message || body.text || '').trim();
const sessionId = body.sessionId || body.chat_id || 'web';
const userRole = String(body.role || body.userRole || req.headers?.['x-verified-role'] || 'HR').trim().toUpperCase();
const userId = String(body.user_id || body.userId || req.headers?.['x-verified-user'] || 'user').trim();
const userName = String(body.user_name || body.userName || req.headers?.['x-verified-user-name'] || userId).trim();

let companyId = String(body.company_id || body.companyId || req.headers?.['x-verified-company'] || '').trim().toUpperCase();
if (!companyId || companyId === 'UNDEFINED') {
  companyId = (userRole === 'SUPER_ADMIN') ? 'ALL' : 'STL';
}

const binary = $input.first().binary || {};
const keys = Object.keys(binary);

if (!keys.length) {
  return [{ json: { sessionId, text, hasFile: false, companyId, userRole, userId, userName } }];
}

return keys.map((k, idx) => {
  const fileItem = binary[k];
  return {
    json: {
      sessionId,
      text,
      hasFile: true,
      fileIndex: idx,
      totalFiles: keys.length,
      fileKey: k,
      fileName: fileItem.fileName || k,
      mimeType: fileItem.mimeType || 'application/pdf',
      companyId,
      userRole,
      userId,
      userName
    },
    binary: {
      data: fileItem
    }
  };
});"""

node_map = {
    'Router': router_code,
    'Parse_Fast_Intent': parse_fast_code,
    'Build_SQL_From_Rewrite': build_sql_code,
    'Build_RAG_Prompt': build_rag_prompt_code,
    'Format_RAG_Reply': format_rag_code,
    'Format_Fast_Reply': format_fast_code,
}

for node in hr_bot.get('nodes', []):
    name = node.get('name')
    if name in node_map:
        node.setdefault('parameters', {})['jsCode'] = node_map[name]
        print(f"✓ Updated node: {name}")

# Write back workflows_modified.json without BOM
with open('workflows_modified.json', 'w', encoding='utf-8') as f:
    json.dump(workflows, f, ensure_ascii=False, indent=2)
print("✓ Saved workflows_modified.json")

# Export hr_chatbot_updated.json to ./files
with open('files/hr_chatbot_updated.json', 'w', encoding='utf-8') as f:
    json.dump(hr_bot, f, ensure_ascii=False, indent=2)
print("✓ Saved files/hr_chatbot_updated.json")
