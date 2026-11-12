/**
 * TEST SUITE: TRA CỨU ĐA THUỘC TÍNH & TÌM KIẾM TỰ DO TOÀN DIỆN (UNIVERSAL LOOKUP)
 * Kiểm tra khả năng tra cứu hồ sơ nhân sự bằng BẤT KỲ thông tin nào người dùng có:
 * - Số quyết định tuyển dụng
 * - Cơ sở đào tạo / Trường học
 * - Chuyên ngành / Ngành học
 * - Trình độ / Bằng cấp
 * - Quê quán / Nơi sinh / Địa chỉ
 * - Giới tính (Nam/Nữ)
 * - Tên tệp hồ sơ đính kèm (.pdf)
 * - Chứng chỉ chuyên môn
 * - Tra cứu thuộc tính cá nhân cụ thể
 * - Tìm kiếm tự do theo từ khóa (Universal Keyword Search)
 */

const http = require('http');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';
const ADMIN_TOKEN = jwt.sign({
  user_id: '59b76d7d-39ea-4734-88f5-11a3e2097dac',
  username: 'superadmin',
  role: 'ADMIN',
  company_id: null
}, JWT_SECRET, { expiresIn: '24h' });

function ask(message) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ message });
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/hoso/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': 'Bearer ' + ADMIN_TOKEN
      },
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const tests = [
  {
    name: '1. Tra cứu theo Số quyết định tuyển dụng (190/QĐ-ĐSMN)',
    query: 'Ai có số quyết định 190/QĐ-ĐSMN?',
    assert: (res) => res.status === 200 && res.body.reply.includes('PHAN DƯƠNG THANH BÌNH') && res.body.reply.includes('190/QĐ-ĐSMN')
  },
  {
    name: '2. Tra cứu theo Trường đào tạo (Cao đẳng Hàng hải)',
    query: 'Ai tốt nghiệp Trường Cao đẳng Hàng hải?',
    assert: (res) => res.status === 200 && res.body.reply.includes('PHAN DƯƠNG THANH BÌNH') && res.body.reply.includes('Trường Cao đẳng Hàng hải')
  },
  {
    name: '3. Tra cứu theo Chuyên ngành (Logistics)',
    query: 'Nhân viên nào học ngành Logistics?',
    assert: (res) => res.status === 200 && res.body.reply.includes('NGUYỄN TRẦN THIỆN NHÂN') && res.body.reply.includes('Logistics')
  },
  {
    name: '4. Tra cứu theo Trình độ / Bằng cấp (Cử nhân)',
    query: 'Nhân viên nào có bằng Cử nhân?',
    assert: (res) => res.status === 200 && res.body.reply.includes('NGUYỄN TRẦN THIỆN NHÂN') && res.body.reply.includes('Cử nhân')
  },
  {
    name: '5. Tra cứu theo Quê quán (Hà Tĩnh)',
    query: 'Nhân viên nào quê ở Hà Tĩnh?',
    assert: (res) => res.status === 200 && res.body.reply.includes('PHAN DƯƠNG THANH BÌNH') && res.body.reply.includes('Hà Tĩnh')
  },
  {
    name: '6. Tra cứu theo Địa chỉ (Trịnh Đình Trọng)',
    query: 'Ai ở Trịnh Đình Trọng?',
    assert: (res) => res.status === 200 && res.body.reply.includes('NGUYỄN TRẦN THIỆN NHÂN') && res.body.reply.includes('Trịnh Đình Trọng')
  },
  {
    name: '7. Tra cứu theo Địa chỉ (Trương Văn Thành)',
    query: 'Ai ở đường Trương Văn Thành?',
    assert: (res) => res.status === 200 && res.body.reply.includes('PHAN DƯƠNG THANH BÌNH')
  },
  {
    name: '8. Tra cứu theo Giới tính (Nhân viên nữ)',
    query: 'Ai là nhân viên nữ?',
    assert: (res) => res.status === 200 && (res.body.reply.includes('Lê Thu Hà') || res.body.reply.includes('Trần Thị Bình'))
  },
  {
    name: '9. Tra cứu theo Tệp hồ sơ gốc (.pdf)',
    query: 'Tìm hồ sơ theo file SWC00814.pdf',
    assert: (res) => res.status === 200 && res.body.reply.includes('PHAN DƯƠNG THANH BÌNH')
  },
  {
    name: '10. Tra cứu theo Chứng chỉ chuyên môn (phương tiện thủy nội địa)',
    query: 'Ai có chứng chỉ phương tiện thủy nội địa?',
    assert: (res) => res.status === 200 && (res.body.reply.includes('PHAN DƯƠNG THANH BÌNH') || res.body.reply.includes('LÊ THÀNH NHÂN'))
  },
  {
    name: '11. Tra cứu thuộc tính cá nhân: Quê quán của nhân sự',
    query: 'Quê quán của Phan Dương Thanh Bình là ở đâu?',
    assert: (res) => res.status === 200 && res.body.reply.includes('Hà Tĩnh') && res.body.reply.includes('PHAN DƯƠNG THANH BÌNH')
  },
  {
    name: '12. Tra cứu thuộc tính cá nhân: Trường tốt nghiệp của nhân sự',
    query: 'Phan Dương Thanh Bình tốt nghiệp trường nào?',
    assert: (res) => res.status === 200 && res.body.reply.includes('Cao đẳng Hàng hải') && res.body.reply.includes('PHAN DƯƠNG THANH BÌNH')
  },
  {
    name: '13. Tìm kiếm tự do theo từ khóa fragment: Cam Lộ',
    query: 'Cam Lộ',
    assert: (res) => res.status === 200 && res.body.reply.includes('NGUYỄN TRẦN THIỆN NHÂN')
  },
  {
    name: '14. Tìm kiếm tự do theo từ khóa fragment: 205/QĐ-ĐSMN',
    query: '205/QĐ-ĐSMN',
    assert: (res) => res.status === 200 && res.body.reply.includes('LÊ MINH ĐỨC')
  }
];

async function run() {
  console.log('================================================================================');
  console.log('KIỂM THỬ TRA CỨU ĐA THUỘC TÍNH & UNIVERSAL LOOKUP — SOTRANS HUB');
  console.log('================================================================================\n');

  let passed = 0;
  for (const t of tests) {
    process.stdout.write(`  [TEST] ${t.name} ... `);
    const start = Date.now();
    try {
      const res = await ask(t.query);
      const duration = Date.now() - start;
      const ok = t.assert(res);
      if (ok) {
        console.log(`\x1b[32mPASSED\x1b[0m (${duration}ms)`);
        passed++;
      } else {
        console.log(`\x1b[31mFAILED\x1b[0m: status ${res.status}, reply: ${res.body?.reply?.slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`\x1b[31mERROR\x1b[0m: ${e.message}`);
    }
  }

  const fs = require('fs');
  const path = require('path');
  const report = {
    timestamp: new Date().toISOString(),
    total: tests.length,
    passed,
    failed: tests.length - passed,
    passRate: `${Math.round((passed / tests.length) * 100)}%`
  };
  fs.writeFileSync(path.join(__dirname, 'test_universal_attribute_lookup_report.json'), JSON.stringify(report, null, 2));

  console.log('\n================================================================================');
  console.log(`TỔNG KẾT: ${passed}/${tests.length} tests PASSED (${Math.round((passed / tests.length) * 100)}%)`);
  console.log('📄 Đã lưu báo cáo: tests/test_universal_attribute_lookup_report.json');
  console.log('================================================================================\n');
}

run();
