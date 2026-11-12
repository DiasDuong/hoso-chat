/**
 * SOTRANS HUB — ONEDRIVE INTENT & DETERMINISTIC STATUS VERIFICATION SUITE
 */

const assert = require('assert');
const path = require('path');
const db = require('../auth-service/db');
const oneDriveService = require('../auth-service/services/oneDriveService');

async function runTests() {
  console.log('========================================================================================');
  console.log('   SOTRANS HUB — ONEDRIVE INTENT & DETERMINISTIC STATUS VERIFICATION                    ');
  console.log('========================================================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`[✅ PASS] TEST_${String(total).padStart(2, '0')} | ${name}`);
      passed++;
    } catch (err) {
      console.error(`[❌ FAIL] TEST_${String(total).padStart(2, '0')} | ${name}: ${err.message}`);
    }
  }

  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`[✅ PASS] TEST_${String(total).padStart(2, '0')} | ${name}`);
      passed++;
    } catch (err) {
      console.error(`[❌ FAIL] TEST_${String(total).padStart(2, '0')} | ${name}: ${err.message}`);
    }
  }

  // Helper matching the logic in routes/agents.js
  function checkOneDriveIntent(userMessage) {
    const rawNormUserMsg = (userMessage || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const mentionsOneDrive = rawNormUserMsg.includes('onedrive') || rawNormUserMsg.includes('1drv') || rawNormUserMsg.includes('one drive');
    const asksOneDriveAction = (
      /(?:ket\s*noi|lien\s*ket|dang\s*nhap|connect|link|tich\s*hop|cai\s*dat|kiem\s*tra|trang\s*thai|status|da\s*ket\s*noi|duoc\s*chua|huong\s*dan|lam\s*sao|cach\s*dung|cach\s*su\s*dung|cach\s*ket\s*noi|mo\s*file|lay\s*file|ho\s*tro|nhan\s*dien|tai\s*khoan)/.test(rawNormUserMsg) ||
      /^(?:toi\s+muon|muon|cho\s+toi|xin\s+huong\s+dan|lam\s+the\s+nao|sao\s+khong)/.test(rawNormUserMsg.trim()) ||
      rawNormUserMsg.trim().length <= 35
    );
    const ONEDRIVE_LINK_REGEX = /https:\/\/(?:1drv\.ms|onedrive\.live\.com|[a-zA-Z0-9-]+\.sharepoint\.com)\/[^\s<>"')]+/gi;
    const detectedOneDriveLinks = userMessage.match(ONEDRIVE_LINK_REGEX) || [];

    return mentionsOneDrive && asksOneDriveAction && detectedOneDriveLinks.length === 0;
  }

  // TEST 1: Handles user's exact query with typo "tôi muốn kết nôi với onedrive"
  test('Nhận diện chính xác câu hỏi thực tế có lỗi gõ phím "tôi muốn kết nôi với onedrive"', () => {
    const res = checkOneDriveIntent('tôi muốn kết nôi với onedrive');
    assert.strictEqual(res, true);
  });

  // TEST 2: Handles accented standard query "tôi muốn kết nối với onedrive"
  test('Nhận diện chính xác câu hỏi chuẩn "tôi muốn kết nối với onedrive"', () => {
    const res = checkOneDriveIntent('tôi muốn kết nối với onedrive');
    assert.strictEqual(res, true);
  });

  // TEST 3: Handles query without accents "ket noi onedrive"
  test('Nhận diện câu hỏi không dấu "ket noi onedrive"', () => {
    const res = checkOneDriveIntent('ket noi onedrive');
    assert.strictEqual(res, true);
  });

  // TEST 4: Handles status inquiries "onedrive đã kết nối chưa"
  test('Nhận diện câu hỏi kiểm tra trạng thái "onedrive đã kết nối chưa"', () => {
    const res = checkOneDriveIntent('onedrive đã kết nối chưa');
    assert.strictEqual(res, true);
  });

  // TEST 5: Handles short queries "onedrive"
  test('Nhận diện truy vấn ngắn "onedrive"', () => {
    const res = checkOneDriveIntent('onedrive');
    assert.strictEqual(res, true);
  });

  // TEST 6: Does NOT intercept when a OneDrive link is provided
  test('Không chặn câu hỏi có kèm liên kết OneDrive (để hệ thống tiếp tục tải và phân tích file)', () => {
    const res = checkOneDriveIntent('Phân tích file từ OneDrive https://1drv.ms/x/c/12345');
    assert.strictEqual(res, false);
  });

  // TEST 7: Database check for emp_swc (Lê Hoàng Cường)
  await testAsync('Kiểm tra trạng thái liên kết OAuth của tài khoản Lê Hoàng Cường (emp_swc) trong DB', async () => {
    const userId = 'b250d5b5-fdcd-4705-b35d-0eb40403623e';
    const status = await oneDriveService.getOAuthConnectionStatus(userId);
    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.accountEmail, 'duongminhduc196873@gmail.com');
  });

  // TEST 8: Database check for an unconnected user
  await testAsync('Kiểm tra người dùng giả định chưa kết nối trả về connected: false', async () => {
    const status = await oneDriveService.getOAuthConnectionStatus('00000000-0000-0000-0000-000000000000');
    assert.strictEqual(status.connected, false);
  });

  console.log('\n========================================================================================');
  console.log(`KẾT QUẢ KIỂM THỬ INTENT & STATUS: ${passed}/${total} TESTS PASS (${((passed/total)*100).toFixed(1)}%)`);
  console.log('========================================================================================\n');

  await db.pool.end();
  process.exit(passed === total ? 0 : 1);
}

runTests().catch(err => {
  console.error('Lỗi chạy suite:', err);
  process.exit(1);
});
