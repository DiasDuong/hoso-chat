/**
 * SOTRANS HUB — BỘ KIỂM THỬ XÁC THỰC TRUY CẬP TỆP VÀ BẢO VỆ CỔNG DOCKER
 * Kiểm chứng hoàn thành Hạng mục 3 & Hạng mục 4
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('../auth-service/node_modules/pg');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  user: 'hrbot',
  password: 'hrchatbot',
  database: 'hrbot'
});

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

function httpRequest(options, bodyData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: bodyBuf.toString('utf8'),
          buffer: bodyBuf
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function runVerification() {
  console.log('========================================================================');
  console.log('   SOTRANS HUB — KIỂM THỬ HOÀN THÀNH HẠNG MỤC 3 & HẠNG MỤC 4           ');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName} ${details ? '(' + details + ')' : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${details ? '(' + details + ')' : ''}`);
      failed++;
    }
  }

  // 1. Tạo JWT test hợp lệ
  const userRes = await pool.query("SELECT user_id, username, role, company_id FROM users WHERE username = 'admin_stl'");
  const adminUser = userRes.rows[0];
  const validToken = jwt.sign(
    { user_id: adminUser.user_id, username: adminUser.username, role: adminUser.role, company_id: adminUser.company_id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const forgedToken = jwt.sign(
    { user_id: adminUser.user_id, username: adminUser.username, role: adminUser.role, company_id: adminUser.company_id },
    'tampered_attacker_secret_key',
    { expiresIn: '1h' }
  );

  // Lấy 1 tệp tin thực tế trong thư mục files
  const filesList = fs.readdirSync(path.resolve(__dirname, '..', 'files'));
  const sampleFile = filesList[0] || '1470de38-0bd0-4ca8-9032-9f48bb1ef87b';
  console.log(`ℹ️ Tệp tin mẫu sử dụng để kiểm thử: ${sampleFile}\n`);

  console.log('👉 HẠNG MỤC 3: KIỂM TOÁN AN NINH TRUY CẬP TỆP TIN QUA XÁC THỰC BACKEND');

  // TC 3.1: Không có token -> Bị chặn 401 Unauthorized
  try {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: `/chat/files/${sampleFile}`,
      method: 'GET'
    });
    assert(
      res.statusCode === 401 && res.body.includes('Chưa đăng nhập'),
      'TC 3.1: Yêu cầu không có token bị chặn 401 Unauthorized',
      `HTTP ${res.statusCode}`
    );
    assert(
      !res.headers['www-authenticate'] || !res.headers['www-authenticate'].includes('Basic'),
      'TC 3.2: Không còn hiển thị Basic Auth popup (.htpasswd) của Nginx cũ',
      'www-authenticate absent'
    );
  } catch (e) {
    assert(false, 'TC 3.1: Lỗi kết nối', e.message);
  }

  // TC 3.3: Thử truy cập trực tiếp thư mục nội bộ /internal-chat-files/ -> Phải bị Nginx chặn 404
  try {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: `/internal-chat-files/${sampleFile}`,
      method: 'GET'
    });
    assert(
      res.statusCode === 404,
      'TC 3.3: Chặn tuyệt đối truy cập trực tiếp vào /internal-chat-files/ từ bên ngoài',
      `HTTP ${res.statusCode} (Nginx internal directive bảo vệ)`
    );
  } catch (e) {
    assert(false, 'TC 3.3: Lỗi kết nối', e.message);
  }

  // TC 3.4: Token giả mạo / sai chữ ký -> Bị chặn 401
  try {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: `/chat/files/${sampleFile}?token=${forgedToken}`,
      method: 'GET'
    });
    assert(
      res.statusCode === 401,
      'TC 3.4: Token giả mạo hoặc sai signature bị từ chối 401',
      `HTTP ${res.statusCode}`
    );
  } catch (e) {
    assert(false, 'TC 3.4: Lỗi kết nối', e.message);
  }

  // TC 3.5: Tấn công Path Traversal -> Bị chặn 400 Bad Request
  try {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: `/chat/files/..%2F..%2Fetc%2Fpasswd?token=${validToken}`,
      method: 'GET'
    });
    assert(
      res.statusCode === 400 || res.statusCode === 404,
      'TC 3.5: Chặn đứng tấn công Path Traversal (../..)',
      `HTTP ${res.statusCode}`
    );
  } catch (e) {
    assert(false, 'TC 3.5: Lỗi kết nối', e.message);
  }

  // TC 3.6: Xác thực hợp lệ qua query param ?token= (Phục vụ iframe, img, download tag)
  try {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: `/chat/files/${sampleFile}?token=${validToken}`,
      method: 'GET'
    });
    assert(
      res.statusCode === 200 && res.buffer.length > 1000 && res.buffer.slice(0, 4).toString('utf8') === '%PDF',
      'TC 3.6: Xác thực thành công qua ?token=, stream nội dung tệp PDF đầy đủ',
      `HTTP ${res.statusCode}, Size: ${res.buffer.length} bytes, Header: ${res.headers['content-type']}`
    );
  } catch (e) {
    assert(false, 'TC 3.6: Lỗi kết nối', e.message);
  }

  // TC 3.7: Xác thực hợp lệ qua header Authorization: Bearer <token>
  try {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 8082,
      path: `/chat/files/${sampleFile}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${validToken}` }
    });
    assert(
      res.statusCode === 200 && res.buffer.length > 1000,
      'TC 3.7: Xác thực thành công qua Header Authorization: Bearer',
      `HTTP ${res.statusCode}, Size: ${res.buffer.length} bytes`
    );
  } catch (e) {
    assert(false, 'TC 3.7: Lỗi kết nối', e.message);
  }

  console.log('\n👉 HẠNG MỤC 4: KIỂM TOÁN RÀNG BUỘC CỔNG DOCKER NỘI BỘ VỀ 127.0.0.1');

  // TC 4.1: Kiểm tra docker port bindings qua docker inspect
  const portsCheck = [
    { container: 'hr-auth', port: '3000/tcp', expectedIp: '127.0.0.1' },
    { container: 'nocodb', port: '8080/tcp', expectedIp: '127.0.0.1' },
    { container: 'hrbot-n8n-1', port: '5678/tcp', expectedIp: '127.0.0.1' },
    { container: 'hrbot-postgres-1', port: '5432/tcp', expectedIp: '127.0.0.1' },
    { container: 'hrbot-qdrant-1', port: '6333/tcp', expectedIp: '127.0.0.1' }
  ];

  for (const p of portsCheck) {
    try {
      const inspectOut = execSync(`docker inspect ${p.container} --format "{{json .NetworkSettings.Ports}}"`).toString();
      const portMap = JSON.parse(inspectOut);
      const bindings = portMap[p.port];
      const hasWildcard = bindings && bindings.some(b => b.HostIp === '0.0.0.0' || b.HostIp === '::');
      const isLoopbackOnly = bindings && bindings.every(b => b.HostIp === p.expectedIp);

      assert(
        !hasWildcard && isLoopbackOnly,
        `TC 4.${portsCheck.indexOf(p) + 1}: ${p.container} (${p.port}) chỉ lắng nghe trên ${p.expectedIp}`,
        `HostIp: ${bindings ? bindings.map(b => b.HostIp).join(', ') : 'none'}`
      );
    } catch (err) {
      assert(false, `TC 4.${portsCheck.indexOf(p) + 1}: Lỗi kiểm tra port ${p.container}`, err.message);
    }
  }

  // TC 4.6: Cổng Gateway 8082 vẫn mở công khai để phục vụ mạng LAN
  try {
    const gwInspect = execSync('docker inspect hr-gateway --format "{{json .NetworkSettings.Ports}}"').toString();
    const gwPorts = JSON.parse(gwInspect)['80/tcp'];
    const hasWildcardGw = gwPorts && gwPorts.some(b => b.HostIp === '0.0.0.0');
    assert(
      hasWildcardGw,
      'TC 4.6: Cổng Gateway (hr-gateway :8082) mở công khai cho toàn mạng LAN',
      `Bindings: ${gwPorts.map(b => b.HostIp + ':' + b.HostPort).join(', ')}`
    );
  } catch (err) {
    assert(false, 'TC 4.6: Lỗi kiểm tra gateway port', err.message);
  }

  // TC 4.7: Kiểm tra kết nối cục bộ tới các cổng nội bộ
  try {
    const authHealth = await httpRequest({ hostname: '127.0.0.1', port: 3000, path: '/api/health', method: 'GET' });
    const n8nHealth = await httpRequest({ hostname: '127.0.0.1', port: 5679, path: '/healthz', method: 'GET' });
    const nocoHealth = await httpRequest({ hostname: '127.0.0.1', port: 8081, path: '/', method: 'GET' });

    assert(
      authHealth.statusCode === 200 && n8nHealth.statusCode === 200 && nocoHealth.statusCode === 200,
      'TC 4.7: Tất cả các dịch vụ nội bộ (Auth:3000, n8n:5679, NocoDB:8081) phản hồi tốt trên 127.0.0.1',
      `Auth=${authHealth.statusCode}, n8n=${n8nHealth.statusCode}, Noco=${nocoHealth.statusCode}`
    );
  } catch (err) {
    assert(false, 'TC 4.7: Lỗi kết nối dịch vụ nội bộ', err.message);
  }

  await pool.end();

  console.log('\n========================================================================');
  console.log(`📊 TỔNG KẾT KIỂM THỬ: ${passed} PASS, ${failed} FAIL`);
  console.log('========================================================================');

  if (failed > 0) process.exit(1);
}

runVerification().catch(err => {
  console.error('Lỗi thực thi kiểm thử:', err);
  process.exit(1);
});
