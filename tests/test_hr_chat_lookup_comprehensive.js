/**
 * BỘ KIỂM THỬ TOÀN DIỆN CHATBOT HỒ SƠ NHÂN SỰ — SOTRANS HUB
 * Kiểm tra đầy đủ 11 nhóm nghiệp vụ theo yêu cầu kiểm toán và chuẩn hóa hệ thống tra cứu.
 */

const http = require('http');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

// User credentials for testing
const TOKENS = {
  ADMIN: jwt.sign({
    user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac',
    username: 'superadmin',
    role: 'ADMIN',
    company_id: null
  }, JWT_SECRET, { expiresIn: '24h' }),

  HR_SWC: jwt.sign({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '24h' }),

  HR_STL: jwt.sign({
    user_id: '9a2e8590-c1a2-41c6-abb2-b802cb8060c6',
    username: 'hr_stl',
    role: 'HR',
    company_id: 'STL'
  }, JWT_SECRET, { expiresIn: '24h' }),

  EMPLOYEE_SWC: jwt.sign({
    user_id: 'b250d5b5-fdcd-4705-b35d-0eb40403623e',
    username: 'emp_swc',
    role: 'EMPLOYEE',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '24h' })
};

function postChat(token, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/hoso/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': 'Bearer ' + token
      },
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout after 10s'));
    });

    req.write(postData);
    req.end();
  });
}

const results = [];

async function runTestCase(category, id, name, runFn) {
  process.stdout.write(`  [${id}] ${name} ... `);
  const start = Date.now();
  try {
    const res = await runFn();
    const duration = Date.now() - start;
    if (res.passed) {
      console.log(`\x1b[32mPASSED\x1b[0m (${duration}ms)`);
      results.push({ category, id, name, passed: true, duration, detail: res.detail });
    } else {
      console.log(`\x1b[31mFAILED\x1b[0m: ${res.reason}`);
      results.push({ category, id, name, passed: false, duration, detail: res.reason });
    }
  } catch (err) {
    const duration = Date.now() - start;
    console.log(`\x1b[31mERROR\x1b[0m: ${err.message}`);
    results.push({ category, id, name, passed: false, duration, detail: err.message });
  }
}

async function runAllTests() {
  console.log('================================================================================');
  console.log('KIỂM THỬ TOÀN DIỆN ENGINE TRA CỨU HỒ SƠ NHÂN SỰ CHATBOT — SOTRANS HUB');
  console.log('================================================================================\n');

  // ---------------------------------------------------------------------------
  // NHÓM 1: NHẬN DIỆN ĐỊNH DANH (Mã, Tên, Không dấu, CCCD, SĐT, Email, Trùng tên)
  // ---------------------------------------------------------------------------
  console.log('👉 NHÓM 1: Nhận diện định danh cá nhân');

  await runTestCase('Nhóm 1', 'TC1.1', 'Tra cứu theo mã nhân viên SWC00017', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Thông tin nhân viên SWC00017' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && (reply.includes('NGUYỄN VĂN HIẾU') || reply.includes('SWC00017'));
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 1', 'TC1.2', 'Tra cứu theo họ và tên đầy đủ (PHAN DƯƠNG THANH BÌNH)', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Tìm nhân viên PHAN DƯƠNG THANH BÌNH' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('PHAN DƯƠNG THANH BÌNH') && reply.includes('Thợ máy');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 1', 'TC1.3', 'Tra cứu họ tên không dấu (nguyen truong nam)', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'nguyen truong nam lam viec o dau' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && (reply.includes('NGUYỄN TRƯỜNG NAM') || reply.includes('Nguyễn Trường Nam'));
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 1', 'TC1.4', 'Tra cứu theo số CCCD (079204001284)', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Tra cứu thông tin theo CCCD 079204001284' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('PHAN DƯƠNG THANH BÌNH');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 1', 'TC1.5', 'Tra cứu theo số điện thoại (0987654321)', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Ai có số điện thoại 0987654321?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('NGUYỄN TRƯỜNG NAM');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 1', 'TC1.6', 'Tra cứu theo email (thienhan662005@gmail.com)', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'thong tin nhan su email thienhan662005@gmail.com' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('NGUYỄN TRẦN THIỆN NHÂN');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 1', 'TC1.7', 'Xử lý disambiguation khi tìm tên trùng lặp (Nhân)', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Thông tin nhân viên Nhân' });
    const reply = res.body?.reply || '';
    // Có cả LÊ THÀNH NHÂN và NGUYỄN TRẦN THIỆN NHÂN
    const passed = res.status === 200 && (reply.includes('trùng khớp') || reply.includes('khớp với từ khóa') || reply.includes('Phát hiện'));
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 2: NHÂN KHẨU HỌC & NGÀY SINH (Năm sinh, Dưới 30, Trên 30, Giáp ranh)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 2: Nhân khẩu học & Ngày sinh');

  await runTestCase('Nhóm 2', 'TC2.1', 'Nhân viên nào sinh năm 2005?', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Nhân viên nào sinh năm 2005?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('NGUYỄN TRẦN THIỆN NHÂN') && reply.includes('2005');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 2', 'TC2.2', 'Những nhân viên nào dưới 30 tuổi?', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Những nhân viên nào dưới 30 tuổi?' });
    const reply = res.body?.reply || '';
    // SWC: Bình (2004), Thiện Nhân (2005), Hiếu (1998); STL: Nam (2002)
    const passed = res.status === 200 && res.body?.total_found >= 3 && reply.includes('PHAN DƯƠNG THANH BÌNH');
    return { passed, reason: `Status ${res.status}, total: ${res.body?.total_found}` };
  });

  await runTestCase('Nhóm 2', 'TC2.3', 'Những nhân viên nào trên 30 tuổi?', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Những nhân viên nào trên 30 tuổi?' });
    const reply = res.body?.reply || '';
    // Lê Thành Nhân sinh 1987 (39 tuổi), Ngô Đặng Tuấn Uyên sinh 1995 (31 tuổi)
    const passed = res.status === 200 && reply.includes('LÊ THÀNH NHÂN') && reply.includes('NGÔ ĐẶNG TUẤN UYÊN');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 2', 'TC2.4', 'Kiểm tra độ chính xác mốc giáp ranh ngày sinh', async () => {
    // Năm hiện tại 2026: Sinh 1995 sinh tháng 1 (25/01/1995) -> hiện tại tháng 10/2026 là tròn 31 tuổi.
    const res = await postChat(TOKENS.ADMIN, { message: 'Nhân viên nào từ 31 đến 32 tuổi?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('NGÔ ĐẶNG TUẤN UYÊN') && reply.includes('31 tuổi');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 3: THUỘC TÍNH NHÂN SỰ (Công ty, Phòng ban, Chức danh / Vị trí)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 3: Thuộc tính nhân sự');

  await runTestCase('Nhóm 3', 'TC3.1', 'Liệt kê nhân viên thuộc công ty SWC', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Liệt kê nhân viên thuộc công ty SWC' });
    const passed = res.status === 200 && res.body?.total_found === 7;
    return { passed, reason: `Status ${res.status}, total_found: ${res.body?.total_found}` };
  });

  await runTestCase('Nhóm 3', 'TC3.2', 'Liệt kê nhân viên thuộc Phòng Vận tải', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Có những nhân viên nào thuộc phòng Vận tải?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && (reply.includes('PHAN DƯƠNG THANH BÌNH') || reply.includes('LÊ THÀNH NHÂN'));
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 3', 'TC3.3', 'Tra cứu theo chức danh "Thợ máy"', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Ai đang làm Thợ máy?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('PHAN DƯƠNG THANH BÌNH') && reply.includes('Thợ máy');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 3', 'TC3.4', 'Tra cứu theo chức danh "Thuyền phó"', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Ai đang giữ chức vụ Thuyền phó?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('LÊ THÀNH NHÂN') && reply.includes('Thuyền phó');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 4: ĐIỀU KIỆN KẾT HỢP (Công ty + Tuổi, Phòng ban + Năm sinh)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 4: Điều kiện kết hợp đa chiều');

  await runTestCase('Nhóm 4', 'TC4.1', 'Nhân viên SWC dưới 30 tuổi', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Danh sách nhân viên công ty SWC dưới 30 tuổi' });
    const reply = res.body?.reply || '';
    // SWC < 30: Bình, Thiện Nhân, Hiếu (STL Nam excluded)
    const passed = res.status === 200 && res.body?.total_found === 3 && !reply.includes('STL00012');
    return { passed, reason: `Status ${res.status}, total_found: ${res.body?.total_found}` };
  });

  await runTestCase('Nhóm 4', 'TC4.2', 'Nhân viên STL dưới 30 tuổi', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Danh sách nhân viên công ty STL dưới 30 tuổi' });
    const reply = res.body?.reply || '';
    // STL < 30: chỉ có Nguyễn Trường Nam
    const passed = res.status === 200 && reply.includes('NGUYỄN TRƯỜNG NAM') && !reply.includes('079204001284');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 5: THỐNG KÊ & TỔNG HỢP (Đếm tổng số, Đếm theo phòng ban, Đếm theo công ty)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 5: Thống kê & Tổng hợp dữ liệu');

  await runTestCase('Nhóm 5', 'TC5.1', 'Có bao nhiêu nhân viên toàn hệ thống?', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Có bao nhiêu nhân viên trong hệ thống?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('15') && reply.includes('Kết quả thống kê nhân sự');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 5', 'TC5.2', 'Có bao nhiêu nhân viên thuộc công ty SWC?', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Có bao nhiêu nhân viên thuộc SWC?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('7') && reply.includes('SWC');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 5', 'TC5.3', 'Có bao nhiêu nhân viên thuộc công ty STL?', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Số lượng nhân viên của STL là bao nhiêu?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('6') && reply.includes('STL');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 6: DỮ LIỆU THIẾU / CHƯA CẬP NHẬT (Minh bạch, không bịa đặt)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 6: Xử lý dữ liệu thiếu / Chưa cập nhật');

  await runTestCase('Nhóm 6', 'TC6.1', 'Minh bạch ghi chú số lượng nhân sự chưa có ngày sinh', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Những nhân viên nào dưới 30 tuổi?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('chưa có ngày sinh');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 6', 'TC6.2', 'Tra cứu thuộc tính chưa có dữ liệu (không tự bịa thông tin)', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Số điện thoại của Lê Hoàng Cường là gì?' });
    const reply = res.body?.reply || '';
    // Lê Hoàng Cường chưa có số điện thoại -> phải trả về Chưa cập nhật
    const passed = res.status === 200 && (reply.includes('Chưa cập nhật') || reply.includes('chưa cập nhật'));
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 7: TRẠNG THÁI NHÂN VIÊN (Mặc định ACTIVE, RESIGNED, DELETED)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 7: Trạng thái nhân sự (ACTIVE, RESIGNED, DELETED)');

  await runTestCase('Nhóm 7', 'TC7.1', 'Mặc định danh sách chung loại trừ nhân viên DELETED', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Danh sách nhân viên công ty STL' });
    const reply = res.body?.reply || '';
    // STL00009 Lê Minh Đức đã bị DELETED -> không được xuất hiện trong danh sách thông thường
    const passed = res.status === 200 && !reply.includes('STL00009') && !reply.includes('Lê Minh Đức');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 7', 'TC7.2', 'Tra cứu đích danh nhân viên đã xóa mềm thông báo rõ trạng thái', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Thông tin nhân viên STL00009' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && (reply.toLowerCase().includes('đã xóa mềm') || reply.includes('DELETED')) && reply.includes('STL00009');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 8: PHÂN QUYỀN RBAC & ĐA CÔNG TY (Multi-tenant Privacy)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 8: Phân quyền & Đa công ty (Multi-tenant RBAC)');

  await runTestCase('Nhóm 8', 'TC8.1', 'HR SWC tra cứu nhân viên nội bộ SWC thành công', async () => {
    const res = await postChat(TOKENS.HR_SWC, { message: 'Có bao nhiêu nhân viên?' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('7') && reply.includes('SWC');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 8', 'TC8.2', 'HR SWC cố tình tra cứu nhân viên công ty STL bị chặn', async () => {
    const res = await postChat(TOKENS.HR_SWC, { message: 'Danh sách nhân viên công ty STL' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('Thông báo bảo mật dữ liệu liên đơn vị') && reply.includes('SWC');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 8', 'TC8.3', 'HR STL cố tình tra cứu nhân viên công ty SWC bị chặn', async () => {
    const res = await postChat(TOKENS.HR_STL, { message: 'Danh sách nhân viên công ty SWC' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('Thông báo bảo mật dữ liệu liên đơn vị') && reply.includes('STL');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 8', 'TC8.4', 'EMPLOYEE Self-service chỉ xem được của mình, chặn tra cứu người khác', async () => {
    const res = await postChat(TOKENS.EMPLOYEE_SWC, { message: 'Danh sách nhân viên công ty SWC' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('Thông báo từ chối truy cập') && reply.includes('chỉ được phép tra cứu thông tin hồ sơ của chính mình');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 9: LỖI KỸ THUẬT & NGOẠI LỆ (Không bao giờ crash 500 unhandled)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 9: Xử lý ngoại lệ kỹ thuật');

  await runTestCase('Nhóm 9', 'TC9.1', 'Request rỗng trả về mã lỗi 400 rõ ràng', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: '   ' });
    const passed = res.status === 400 && res.body?.error?.includes('Vui lòng nhập nội dung');
    return { passed, reason: `Status ${res.status}, error: ${res.body?.error}` };
  });

  await runTestCase('Nhóm 9', 'TC9.2', 'Thử SQL injection hoặc ký tự đặc biệt không gây lỗi 500', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: "Nhân viên nào có tên là ' OR 1=1; -- DROP TABLE employees;" });
    const passed = res.status === 200 && !res.body?.error;
    return { passed, reason: `Status ${res.status}, reply: ${res.body?.reply?.slice(0, 100)}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 10: NGÔN NGỮ & CÁCH DIỄN ĐẠT (Viết tắt, Không dấu, Câu tự nhiên)
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 10: Ngôn ngữ & Cách diễn đạt tự nhiên');

  await runTestCase('Nhóm 10', 'TC10.1', 'Viết tắt "nv nao duoi 30 tuoi"', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'nv nao duoi 30 tuoi' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && res.body?.total_found >= 3;
    return { passed, reason: `Status ${res.status}, total_found: ${res.body?.total_found}` };
  });

  await runTestCase('Nhóm 10', 'TC10.2', 'Không dấu "nhan vien nao sinh nam 2005"', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'nhan vien nao sinh nam 2005' });
    const reply = res.body?.reply || '';
    const passed = res.status === 200 && reply.includes('NGUYỄN TRẦN THIỆN NHÂN');
    return { passed, reason: `Status ${res.status}, reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 10', 'TC10.3', 'Cách diễn đạt tự nhiên "cho tôi xem danh sách nhân sự bên swc"', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'cho tôi xem danh sách nhân sự bên swc' });
    const passed = res.status === 200 && res.body?.total_found === 7;
    return { passed, reason: `Status ${res.status}, total_found: ${res.body?.total_found}` };
  });

  // ---------------------------------------------------------------------------
  // NHÓM 11: PHÂN ĐỊNH CÂU HỎI QUY ĐỊNH / CHÍNH SÁCH VS TRA CỨU HỒ SƠ
  // ---------------------------------------------------------------------------
  console.log('\n👉 NHÓM 11: Phân định ranh giới giữa tra cứu hồ sơ và quy định chính sách');

  await runTestCase('Nhóm 11', 'TC11.1', 'Câu hỏi quy chế/chính sách (không bị chặn nhầm bởi tra cứu hồ sơ)', async () => {
    // Với câu hỏi chính sách, parseIntent trả về null và luồng chuyển sang n8n
    // Nếu n8n timeout hoặc xử lý, endpoint trả về 200 hoặc n8n response, nhưng không bị format thành bảng nhân viên rỗng.
    const res = await postChat(TOKENS.ADMIN, { message: 'Quy định thử việc của công ty tối đa là mấy tháng?' });
    const reply = res.body?.reply || res.body?.output || '';
    // Không bị format nhầm thành "Không tìm thấy nhân sự có tên Quy định thử việc..."
    const passed = !reply.includes('Không tìm thấy nhân sự nào có tên hoặc thông tin phù hợp với **Quy định thử việc');
    return { passed, reason: `Reply: ${reply.slice(0, 100)}` };
  });

  await runTestCase('Nhóm 11', 'TC11.2', 'Lời chào xã giao "Xin chào chatbot" không bị nhầm là tra cứu nhân sự', async () => {
    const res = await postChat(TOKENS.ADMIN, { message: 'Xin chào bot!' });
    const reply = res.body?.reply || res.body?.output || '';
    const passed = !reply.includes('Không tìm thấy nhân sự nào có tên hoặc thông tin phù hợp với **Xin chào');
    return { passed, reason: `Reply: ${reply.slice(0, 100)}` };
  });

  console.log('\n================================================================================');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;
  console.log(`TỔNG KẾT: ${passed}/${total} test cases PASSED (${Math.round((passed / total) * 100)}%)`);
  if (failed > 0) {
    console.log(`CÓ ${failed} TEST CASE THẤT BẠI.`);
  } else {
    console.log('🎉 TẤT CẢ CÁC BÀI KIỂM THỬ ĐỀU ĐẠT CHUẨN XUẤT SẮC!');
  }
  console.log('================================================================================\n');

  const fs = require('fs');
  const reportPath = path.join(__dirname, 'test_hr_chat_lookup_comprehensive_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total,
    passed,
    failed,
    pass_rate: `${Math.round((passed / total) * 100)}%`,
    results
  }, null, 2), 'utf-8');
  console.log(`📄 Đã lưu báo cáo kiểm thử chi tiết vào: ${reportPath}\n`);

  return { total, passed, failed, results };
}

runAllTests().catch(console.error);
