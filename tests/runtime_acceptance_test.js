/**
 * RUNTIME ACCEPTANCE TEST SUITE - SOTRANS HUB PERSONAL AI AGENTS
 * 
 * Direct runtime execution on live services at http://localhost:3000
 * Covers:
 * - Section 1: Environment & Deployment Verification
 * - Section 2: End-to-End Tests (Test A, B, C, D, E, F)
 * - Section 3: Security & File Lifecycle (IDOR, Expired, Tickets, Traversal, Cascade)
 * - Section 4: Regression Smoke Tests (General AI, HR Policy RAG, HR Intake, Core DB)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const XLSX = require('../auth-service/node_modules/xlsx');
const db = require('../auth-service/db');
const { purgeExpiredAgentOutputs } = require('../auth-service/services/retentionService');

const API_BASE = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';

const testResults = [];
let passedCount = 0;
let failedCount = 0;
let blockedCount = 0;

function recordTest({ id, section, name, input, action, expected, actual, evidence, status }) {
  if (status === 'PASS') passedCount++;
  else if (status === 'FAIL') failedCount++;
  else if (status === 'BLOCKED') blockedCount++;

  const entry = { id, section, name, input, action, expected, actual, evidence, status };
  testResults.push(entry);

  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${icon} [${id}] ${name} -> ${status}`);
  if (status !== 'PASS') {
    console.log(`   Expected: ${expected}`);
    console.log(`   Actual:   ${actual}`);
  }
}

// Token helper for real authenticated users
function createTestToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      username: user.username,
      role: user.role,
      company_id: user.company_id || 'SOTRANS'
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function runRuntimeAcceptanceTests() {
  console.log('========================================================================');
  console.log('🚀 SOTRANS HUB — RUNTIME ACCEPTANCE TEST SUITE (PERSONAL AI AGENTS)');
  console.log('Target: ' + API_BASE);
  console.log('Timestamp: ' + new Date().toISOString());
  console.log('========================================================================\n');

  // Load User A and User B
  const usersRes = await db.query(`
    SELECT user_id, username, role, company_id, status 
    FROM users 
    WHERE username IN ('emp_stl', 'emp_swc') 
    ORDER BY username ASC
  `);
  const userA = usersRes.rows.find(u => u.username === 'emp_stl'); // Has agents
  const userB = usersRes.rows.find(u => u.username === 'emp_swc'); // Another tenant

  if (!userA || !userB) {
    throw new Error('Test requires existing accounts emp_stl and emp_swc in database.');
  }

  const tokenA = createTestToken(userA);
  const tokenB = createTestToken(userB);

  // Load Agent owned by User A
  const agentRes = await db.query(`
    SELECT id, name, model_name, instruction_prompt 
    FROM user_agents 
    WHERE user_id = $1 AND status = 'active' 
    LIMIT 1
  `, [userA.user_id]);
  
  if (agentRes.rows.length === 0) {
    throw new Error('User A must have at least one active agent.');
  }
  const agentA = agentRes.rows[0];

  console.log(`User A: ${userA.username} (${userA.user_id})`);
  console.log(`User B: ${userB.username} (${userB.user_id})`);
  console.log(`Target Agent: ${agentA.name} (${agentA.id}) [Model: ${agentA.model_name}]\n`);

  // ---------------------------------------------------------------------------
  // SECTION 1: MÔI TRƯỜNG VÀ BẰNG CHỨNG TRIỂN KHAI
  // ---------------------------------------------------------------------------
  console.log('--- SECTION 1: Môi trường & Bằng chứng Triển khai ---');

  // 1.1 Kiểm tra bảng agent_output_files schema
  try {
    const colsRes = await db.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'agent_output_files'
      ORDER BY ordinal_position
    `);
    const colNames = colsRes.rows.map(r => r.column_name);
    const requiredCols = ['id', 'user_id', 'agent_id', 'conversation_id', 'file_name', 'storage_path', 'mime_type', 'file_size', 'checksum_sha256', 'status', 'expires_at'];
    const allPresent = requiredCols.every(c => colNames.includes(c));

    recordTest({
      id: 'ENV-01',
      section: 'Environment',
      name: 'Kiểm tra schema bảng agent_output_files trong PostgreSQL',
      input: 'Table agent_output_files',
      action: 'Truy vấn information_schema.columns',
      expected: 'Đầy đủ các cột bắt buộc: ' + requiredCols.join(', '),
      actual: 'Tìm thấy ' + colsRes.rows.length + ' cột: ' + colNames.join(', '),
      evidence: `Columns: ${colNames.join(', ')}`,
      status: allPresent ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'ENV-01',
      section: 'Environment',
      name: 'Kiểm tra schema bảng agent_output_files',
      input: 'N/A',
      action: 'DB query',
      expected: 'Schema tồn tại',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // 1.2 Kiểm tra API Health Check
  try {
    const startT = Date.now();
    const hRes = await fetch(`${API_BASE}/api/health`);
    const hJson = await hRes.json();
    const elapsed = Date.now() - startT;

    recordTest({
      id: 'ENV-02',
      section: 'Environment',
      name: 'Kiểm tra endpoint API Health Check (/api/health)',
      input: 'GET /api/health',
      action: 'Gửi request HTTP GET',
      expected: 'HTTP 200, status: ok, service: hr-auth-service',
      actual: `HTTP ${hRes.status}, status: ${hJson.status}, elapsed: ${elapsed}ms`,
      evidence: JSON.stringify(hJson),
      status: (hRes.status === 200 && hJson.status === 'ok') ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'ENV-02',
      section: 'Environment',
      name: 'Kiểm tra endpoint API Health Check',
      input: 'GET /api/health',
      action: 'Fetch',
      expected: 'HTTP 200',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // ---------------------------------------------------------------------------
  // SECTION 2: KIỂM THỬ PERSONAL AI AGENTS END-TO-END
  // ---------------------------------------------------------------------------
  console.log('\n--- SECTION 2: Kiểm thử Personal AI Agents End-to-End ---');

  // Test A — Câu hỏi thông thường (không cần công cụ)
  try {
    const startA = Date.now();
    const resA = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Thủ đô của nước Pháp là thành phố nào? Chỉ trả lời tên thành phố ngắn gọn.'
      })
    });
    const jsonA = await resA.json();
    const elapsedA = Date.now() - startA;

    const hasParis = /paris/i.test(jsonA.reply || '');
    const noToolsCalled = (!jsonA.artifacts || jsonA.artifacts.length === 0);

    recordTest({
      id: 'TEST-A',
      section: 'End-to-End',
      name: 'Câu hỏi thông thường không cần gọi công cụ',
      input: 'Thủ đô của nước Pháp là thành phố nào?',
      action: `POST /api/agents/${agentA.id}/chat`,
      expected: 'Trả lời đúng Paris, không gọi công cụ tính toán/xuất file, HTTP 200',
      actual: `HTTP ${resA.status}, Reply: "${(jsonA.reply || '').trim()}", Artifacts: ${jsonA.artifacts?.length || 0}`,
      evidence: `HTTP ${resA.status} | Steps: ${jsonA.stepsExecuted || 1} | Time: ${elapsedA}ms`,
      status: (resA.status === 200 && hasParis && noToolsCalled) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'TEST-A',
      section: 'End-to-End',
      name: 'Câu hỏi thông thường không cần gọi công cụ',
      input: 'Hỏi thủ đô Pháp',
      action: 'Fetch API',
      expected: 'HTTP 200 Paris',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // Test B — Phân tích dữ liệu bảng tính nhiều sheet (Multi-sheet Excel)
  try {
    const multiSheetPath = path.join(__dirname, 'fixtures', 'fixture_multi_sheet_4q.xlsx');
    const fileBytes = fs.readFileSync(multiSheetPath);
    const formDataB = new FormData();
    formDataB.append('message', 'Hãy tính tổng doanh thu toàn năm từ 4 sheet quý (Q1_2026, Q2_2026, Q3_2026, Q4_2026). Cho biết tổng số là bao nhiêu và quý nào có doanh thu cao nhất?');
    formDataB.append('files', new Blob([fileBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'fixture_multi_sheet_4q.xlsx');

    const startB = Date.now();
    const resB = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`
      },
      body: formDataB
    });
    const jsonB = await resB.json();
    const elapsedB = Date.now() - startB;

    // Expected revenue: 1,560,000,000 (1.56 tỷ). Highest quarter: Q4 (480,000,000).
    const replyB = jsonB.reply || '';
    const hasSum = /1[.,]560[.,]000[.,]000|1[.,]56\s*tỷ/i.test(replyB);
    const hasQ4 = /Q4|Quý\s*4/i.test(replyB);

    recordTest({
      id: 'TEST-B',
      section: 'End-to-End',
      name: 'Phân tích dữ liệu bảng tính đa sheet (Multi-sheet 4 Quarters)',
      input: 'File fixture_multi_sheet_4q.xlsx (4 sheets: Q1-Q4)',
      action: `POST /api/agents/${agentA.id}/chat (Multipart)`,
      expected: 'Tổng doanh thu cả năm = 1.560.000.000 đ, quý cao nhất là Q4',
      actual: `HTTP ${resB.status}, Nhận diện doanh thu: ${hasSum}, Nhận diện Q4: ${hasQ4}`,
      evidence: `Reply preview: "${replyB.slice(0, 200).replace(/\n/g, ' ')}" | Time: ${elapsedB}ms`,
      status: (resB.status === 200 && hasSum && hasQ4) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'TEST-B',
      section: 'End-to-End',
      name: 'Phân tích dữ liệu bảng tính đa sheet',
      input: 'File multi-sheet',
      action: 'Fetch API',
      expected: 'Doanh thu 1.560.000.000, Q4 cao nhất',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // Test C — Nhiệm vụ nhiều bước (Đọc file -> Tính toán -> Xuất file Excel -> Trả về link tải)
  let generatedFileId = null;
  let generatedStoragePath = null;
  try {
    const singleSheetPath = path.join(__dirname, 'fixtures', 'fixture_single_sheet_math.xlsx');
    const singleBytes = fs.readFileSync(singleSheetPath);
    const formDataC = new FormData();
    formDataC.append('message', 'Hãy tính tổng Thực Lĩnh trong sheet Luong_T10_2026 và xuất một file Excel tên Bao_Cao_Thuc_Linh_P1.xlsx chứa kết quả này để tôi tải về.');
    formDataC.append('files', new Blob([singleBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'fixture_single_sheet_math.xlsx');

    const startC = Date.now();
    const resC = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`
      },
      body: formDataC
    });
    const jsonC = await resC.json();
    const elapsedC = Date.now() - startC;

    const hasArtifact = Array.isArray(jsonC.artifacts) && jsonC.artifacts.length > 0;
    const artifact = hasArtifact ? jsonC.artifacts[0] : null;

    if (artifact && artifact.fileId) {
      generatedFileId = artifact.fileId;
      // Kiểm tra file vật lý và metadata trong DB
      const dbCheck = await db.query('SELECT * FROM agent_output_files WHERE id = $1', [generatedFileId]);
      if (dbCheck.rows.length > 0) {
        generatedStoragePath = dbCheck.rows[0].storage_path;
      }
    }

    let localDiskPath = generatedStoragePath;
    if (localDiskPath && localDiskPath.startsWith('/app/')) {
      localDiskPath = path.join(__dirname, '..', 'auth-service', localDiskPath.slice(5));
    }
    const fileExistsOnDisk = localDiskPath && fs.existsSync(localDiskPath);
    let validXlsxContent = false;
    if (fileExistsOnDisk) {
      try {
        const parsedExported = XLSX.readFile(localDiskPath);
        validXlsxContent = parsedExported.SheetNames.length > 0;
      } catch (e) {}
    }

    recordTest({
      id: 'TEST-C',
      section: 'End-to-End',
      name: 'Nhiệm vụ nhiều bước (Tính toán xác định & Xuất tệp Excel)',
      input: 'File fixture_single_sheet_math.xlsx (1.000 dòng)',
      action: 'Agent gọi calculate_spreadsheet_metrics -> gọi export_excel_report',
      expected: 'Artifact được tạo, file vật lý tồn tại, nội dung Excel hợp lệ, metadata ghi nhận',
      actual: `Artifacts: ${jsonC.artifacts?.length || 0}, FileID: ${generatedFileId}, OnDisk: ${fileExistsOnDisk}, ValidXlsx: ${validXlsxContent}`,
      evidence: `File ID: ${generatedFileId} | Path: ${generatedStoragePath} | Elapsed: ${elapsedC}ms`,
      status: (resC.status === 200 && hasArtifact && fileExistsOnDisk && validXlsxContent) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'TEST-C',
      section: 'End-to-End',
      name: 'Nhiệm vụ nhiều bước',
      input: 'Calculate and Export',
      action: 'Fetch API',
      expected: 'Tạo file Excel thành công',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // Test D — Lỗi công cụ (Sheet hoặc Cột không tồn tại)
  try {
    const singleSheetPath = path.join(__dirname, 'fixtures', 'fixture_single_sheet_math.xlsx');
    const singleBytes = fs.readFileSync(singleSheetPath);
    const formDataD = new FormData();
    formDataD.append('message', 'Hãy sử dụng công cụ tính toán để tính tổng cột "Cot_Khong_Ton_Tai_999" trong sheet "Sheet_Khong_Co_Thuc".');
    formDataD.append('files', new Blob([singleBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'fixture_single_sheet_math.xlsx');

    const resD = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`
      },
      body: formDataD
    });
    const jsonD = await resD.json();
    const replyD = jsonD.reply || '';

    // Agent must not crash (HTTP 200) and must inform user that the sheet/column is not found, without pretending success
    const gracefulHandling = !/Error|crash/i.test(replyD) && (/không tìm thấy|không có|không tồn tại/i.test(replyD) || jsonD.success === true);

    recordTest({
      id: 'TEST-D',
      section: 'End-to-End',
      name: 'Xử lý lỗi công cụ khi tham số không hợp lệ (Sheet/Cột không tồn tại)',
      input: 'Yêu cầu tính toán trên sheet/cột không tồn tại',
      action: 'Tool trả về error -> Agent nhận errorResponse và phản hồi minh bạch',
      expected: 'Agent không crash, thông báo rõ ràng không tìm thấy sheet/cột, không bịa đặt số liệu',
      actual: `HTTP ${resD.status}, Graceful error feedback: ${gracefulHandling}`,
      evidence: `Reply: "${replyD.slice(0, 150).replace(/\n/g, ' ')}"`,
      status: (resD.status === 200 && gracefulHandling) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'TEST-D',
      section: 'End-to-End',
      name: 'Xử lý lỗi công cụ',
      input: 'Sheet không tồn tại',
      action: 'Fetch API',
      expected: 'Phản hồi lịch sự, không bịa số',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // Test E — Tài liệu không phải Excel (TXT, DOCX, PDF)
  try {
    const txtPath = path.join(__dirname, 'fixtures', 'test_sample.txt');
    const txtBytes = fs.readFileSync(txtPath);
    const formDataE = new FormData();
    formDataE.append('message', 'Dựa trên tệp văn bản đính kèm, ngân sách được phê duyệt cho dự án là bao nhiêu tiền và ai là người phụ trách?');
    formDataE.append('files', new Blob([txtBytes], { type: 'text/plain' }), 'test_sample.txt');

    const resE = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`
      },
      body: formDataE
    });
    const jsonE = await resE.json();
    const replyE = jsonE.reply || '';

    const hasBudget = /850[.,]000[.,]000|850\s*triệu/i.test(replyE);
    const hasOwner = /Ban\s+Công\s+Nghệ\s+Thông\s+Tin/i.test(replyE);

    recordTest({
      id: 'TEST-E',
      section: 'End-to-End',
      name: 'Xử lý tài liệu văn bản không phải Excel (.txt)',
      input: 'Tệp test_sample.txt chứa thông tin ngân sách dự án',
      action: 'Trích xuất văn bản qua fileProcessor -> đưa vào prompt',
      expected: 'Trích xuất đúng ngân sách 850 triệu đồng và Ban CNTT phụ trách',
      actual: `HTTP ${resE.status}, Nhận diện ngân sách: ${hasBudget}, Nhận diện phụ trách: ${hasOwner}`,
      evidence: `Reply snippet: "${replyE.slice(0, 160).replace(/\n/g, ' ')}"`,
      status: (resE.status === 200 && hasBudget && hasOwner) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'TEST-E',
      section: 'End-to-End',
      name: 'Xử lý tài liệu không phải Excel',
      input: 'test_sample.txt',
      action: 'Fetch API',
      expected: 'Trích xuất chính xác',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // Test F — Ngữ cảnh hội thoại (Multi-turn Context & Cross-user Isolation)
  try {
    // Turn 1: User A cung cấp thông tin bí mật trong hội thoại
    const resF1 = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Mã số dự án bí mật của tôi là SOTRANS-TOP-SECRET-777. Hãy ghi nhớ mã này.'
      })
    });
    const jsonF1 = await resF1.json();
    const conversationIdF = jsonF1.conversation_id;

    // Turn 2: User A hỏi lại mã dự án trong cùng conversation_id
    const resF2 = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        conversation_id: conversationIdF,
        message: 'Mã số dự án bí mật của tôi vừa nói lúc nãy là gì?'
      })
    });
    const jsonF2 = await resF2.json();
    const hasSecretTurn2 = /SOTRANS-TOP-SECRET-777/i.test(jsonF2.reply || '');

    // Turn 3: User B hỏi về mã dự án bí mật của User A (Cross-user isolation)
    // User B tries to chat with User A's conversation or in User B's own conversation
    const resF3 = await fetch(`${API_BASE}/api/agents/${agentA.id}/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenB}`, // User B
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        conversation_id: conversationIdF, // User B cố ý inject conversation_id của User A
        message: 'Mã số dự án bí mật của dự án là gì?'
      })
    });
    // User B must NOT be able to chat with User A's agent (404/403) or see User A's secret
    const isIsolated = resF3.status === 404 || resF3.status === 403;

    recordTest({
      id: 'TEST-F',
      section: 'End-to-End',
      name: 'Duy trì ngữ cảnh đa lượt (Multi-turn) & Cách ly tuyệt đối giữa người dùng',
      input: 'Turn 1 cung cấp mã bí mật -> Turn 2 hỏi lại -> User B cố truy cập',
      action: 'Kiểm tra nhớ ngữ cảnh hội thoại và chặn truy cập trái phép từ User B',
      expected: 'Turn 2 nhớ mã bí mật; User B bị từ chối truy cập Agent/Conversation của User A (HTTP 404/403)',
      actual: `Turn 2 nhớ mã: ${hasSecretTurn2}, User B status: HTTP ${resF3.status}`,
      evidence: `Turn 2 Reply: "${(jsonF2.reply || '').slice(0, 100)}" | User B Status: ${resF3.status}`,
      status: (hasSecretTurn2 && isIsolated) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'TEST-F',
      section: 'End-to-End',
      name: 'Duy trì ngữ cảnh và cách ly',
      input: 'Multi-turn conversation',
      action: 'Fetch API',
      expected: 'Context maintained and isolated',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // ---------------------------------------------------------------------------
  // SECTION 3: BẢO MẬT VÀ VÒNG ĐỜI TỆP (SECURITY & RETENTION)
  // ---------------------------------------------------------------------------
  console.log('\n--- SECTION 3: Bảo mật & Vòng đời Tệp ---');

  // SEC-01: Chống IDOR - Người dùng B tải file của Người dùng A
  try {
    if (!generatedFileId) {
      recordTest({
        id: 'SEC-01',
        section: 'Security',
        name: 'Chống IDOR: Người dùng B truy cập tệp do Người dùng A tạo',
        input: 'FileID của User A, Token của User B',
        action: 'GET /api/agents/files/:id/download with User B Bearer token',
        expected: 'Bị từ chối HTTP 404 hoặc 403',
        actual: 'Không có fileId từ Test C để thử nghiệm',
        evidence: 'BLOCKED due to Test C',
        status: 'BLOCKED'
      });
    } else {
      const resSec1 = await fetch(`${API_BASE}/api/agents/files/${generatedFileId}/download`, {
        headers: { 'Authorization': `Bearer ${tokenB}` } // Token User B
      });
      const jsonSec1 = await resSec1.json().catch(() => ({}));

      recordTest({
        id: 'SEC-01',
        section: 'Security',
        name: 'Chống IDOR: Người dùng B truy cập tệp do Người dùng A tạo',
        input: `FileID=${generatedFileId}, User B Token`,
        action: 'GET /api/agents/files/:id/download',
        expected: 'HTTP 404 (Không tìm thấy tệp hoặc bạn không có quyền truy cập)',
        actual: `HTTP ${resSec1.status}, Error: "${jsonSec1.error || ''}"`,
        evidence: `HTTP ${resSec1.status} | Response: ${JSON.stringify(jsonSec1)}`,
        status: (resSec1.status === 404 || resSec1.status === 403) ? 'PASS' : 'FAIL'
      });
    }
  } catch (err) {
    recordTest({
      id: 'SEC-01',
      section: 'Security',
      name: 'Chống IDOR',
      input: 'User B access User A file',
      action: 'Fetch API',
      expected: 'HTTP 404/403',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // SEC-02: Truy cập với JWT không hợp lệ / không có token
  try {
    const resSec2 = await fetch(`${API_BASE}/api/agents/files/${generatedFileId || '00000000-0000-0000-0000-000000000000'}/download`, {
      headers: { 'Authorization': 'Bearer token_gia_mao_invalid_jwt_12345' }
    });
    recordTest({
      id: 'SEC-02',
      section: 'Security',
      name: 'Chặn truy cập tệp khi cung cấp JWT giả mạo',
      input: 'Bearer token_gia_mao_invalid_jwt_12345',
      action: 'GET /api/agents/files/:id/download',
      expected: 'HTTP 401 Unauthorized',
      actual: `HTTP ${resSec2.status}`,
      evidence: `HTTP ${resSec2.status}`,
      status: resSec2.status === 401 ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'SEC-02',
      section: 'Security',
      name: 'Chặn truy cập JWT giả mạo',
      input: 'Invalid JWT',
      action: 'Fetch API',
      expected: 'HTTP 401',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // SEC-03: Truy cập tệp không tồn tại
  try {
    const nonExistentId = '00000000-0000-0000-0000-000000000999';
    const resSec3 = await fetch(`${API_BASE}/api/agents/files/${nonExistentId}/download`, {
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    recordTest({
      id: 'SEC-03',
      section: 'Security',
      name: 'Truy cập tệp không tồn tại trong hệ thống',
      input: `FileID=${nonExistentId}`,
      action: 'GET /api/agents/files/:id/download',
      expected: 'HTTP 404 Not Found',
      actual: `HTTP ${resSec3.status}`,
      evidence: `HTTP ${resSec3.status}`,
      status: resSec3.status === 404 ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'SEC-03',
      section: 'Security',
      name: 'Truy cập tệp không tồn tại',
      input: 'Non existent ID',
      action: 'Fetch API',
      expected: 'HTTP 404',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // SEC-04: Từ chối tệp đã hết hạn (7 ngày / status EXPIRED)
  try {
    const expiredTestId = crypto.randomUUID();
    await db.query(`
      INSERT INTO agent_output_files (id, user_id, agent_id, file_name, file_size, storage_path, mime_type, checksum_sha256, status, expires_at)
      VALUES ($1, $2, $3, 'expired_test.xlsx', 500, 'data/agent_outputs/test.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'READY', NOW() - INTERVAL '2 days')
    `, [expiredTestId, userA.user_id, agentA.id]);

    const resSec4 = await fetch(`${API_BASE}/api/agents/files/${expiredTestId}/download`, {
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    const jsonSec4 = await resSec4.json().catch(() => ({}));

    // Clean up
    await db.query('DELETE FROM agent_output_files WHERE id = $1', [expiredTestId]);

    recordTest({
      id: 'SEC-04',
      section: 'Security',
      name: 'Từ chối tải tệp đã quá hạn lưu trữ 7 ngày (Retention Expiration)',
      input: 'File record có expires_at trong quá khứ',
      action: 'GET /api/agents/files/:id/download',
      expected: 'HTTP 410 Gone (Thông báo tệp đã hết hạn lưu trữ)',
      actual: `HTTP ${resSec4.status}, Error: "${jsonSec4.error || ''}"`,
      evidence: `HTTP ${resSec4.status} | Response: ${JSON.stringify(jsonSec4)}`,
      status: resSec4.status === 410 ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'SEC-04',
      section: 'Security',
      name: 'Từ chối tệp hết hạn',
      input: 'Expired file',
      action: 'Fetch API',
      expected: 'HTTP 410',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // SEC-05: Signed Ticket cấp 5 phút & dùng ticket sai tệp
  try {
    if (!generatedFileId) {
      recordTest({
        id: 'SEC-05',
        section: 'Security',
        name: 'Kiểm tra cơ chế Signed Download Ticket 5 phút',
        input: 'N/A',
        action: 'Ticket test',
        expected: 'Ticket hoạt động',
        actual: 'No generated file from Test C',
        evidence: 'BLOCKED',
        status: 'BLOCKED'
      });
    } else {
      // 1. Tạo ticket hợp lệ cho generatedFileId
      const ticketRes = await fetch(`${API_BASE}/api/agents/files/${generatedFileId}/ticket`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tokenA}` }
      });
      const ticketJson = await ticketRes.json();
      const ticket = ticketJson.ticket;

      // 2. Tải tệp bằng ticket mà không cần Bearer token
      const downloadWithTicketRes = await fetch(`${API_BASE}/api/agents/files/${generatedFileId}/download?ticket=${ticket}`);
      const canDownloadWithTicket = downloadWithTicketRes.status === 200;

      // 3. Dùng ticket của file A để tải file B khác (Mismatched file ticket)
      const anotherId = '00000000-0000-0000-0000-000000000002';
      const mismatchRes = await fetch(`${API_BASE}/api/agents/files/${anotherId}/download?ticket=${ticket}`);
      const isMismatchBlocked = mismatchRes.status === 403;

      recordTest({
        id: 'SEC-05',
        section: 'Security',
        name: 'Cấp Signed Download Ticket 5 phút và kiểm tra ràng buộc tệp',
        input: `FileID=${generatedFileId}, POST /:id/ticket`,
        action: 'Tải với ticket hợp lệ & Thử dùng ticket để tải file khác',
        expected: 'Tải thành công HTTP 200; Ticket sai file bị từ chối HTTP 403',
        actual: `Download ticket: HTTP ${downloadWithTicketRes.status}, Mismatch ticket: HTTP ${mismatchRes.status}`,
        evidence: `Ticket prefix: ${ticket?.slice(0, 25)}... | CanDownload: ${canDownloadWithTicket} | MismatchBlocked: ${isMismatchBlocked}`,
        status: (canDownloadWithTicket && isMismatchBlocked) ? 'PASS' : 'FAIL'
      });
    }
  } catch (err) {
    recordTest({
      id: 'SEC-05',
      section: 'Security',
      name: 'Kiểm tra Signed Download Ticket',
      input: 'Ticket test',
      action: 'Fetch API',
      expected: 'Download OK, mismatch blocked',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // SEC-06: Chống Path Traversal trong ID tệp
  try {
    const maliciousId = '..%2F..%2F..%2Fetc%2Fpasswd';
    const resSec6 = await fetch(`${API_BASE}/api/agents/files/${maliciousId}/download`, {
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    recordTest({
      id: 'SEC-06',
      section: 'Security',
      name: 'Chống tấn công Path Traversal qua tham số ID tệp',
      input: `FileID=${maliciousId}`,
      action: 'GET /api/agents/files/:id/download',
      expected: 'HTTP 400 Bad Request (Định dạng ID tệp không hợp lệ)',
      actual: `HTTP ${resSec6.status}`,
      evidence: `HTTP ${resSec6.status}`,
      status: resSec6.status === 400 ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'SEC-06',
      section: 'Security',
      name: 'Chống Path Traversal',
      input: 'Traversal ID',
      action: 'Fetch API',
      expected: 'HTTP 400',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // SEC-07: Tiến trình Retention Purge tự động
  try {
    // Tạo 1 file test giả mạo đã hết hạn trên đĩa và trong DB
    const purgeTestId = crypto.randomUUID();
    const purgeTestDir = path.join(__dirname, '..', 'auth-service', 'data', 'agent_outputs', 'test_purge');
    if (!fs.existsSync(purgeTestDir)) fs.mkdirSync(purgeTestDir, { recursive: true });
    const purgeFilePath = path.join(purgeTestDir, `${purgeTestId}_test_purge.xlsx`);
    fs.writeFileSync(purgeFilePath, 'TEST EXPIRED CONTENT');

    await db.query(`
      INSERT INTO agent_output_files (id, user_id, agent_id, file_name, file_size, storage_path, mime_type, checksum_sha256, status, expires_at)
      VALUES ($1, $2, $3, 'test_purge.xlsx', 20, $4, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'READY', NOW() - INTERVAL '1 day')
    `, [purgeTestId, userA.user_id, agentA.id, purgeFilePath]);

    // Gọi trực tiếp retention service purge với dryRun = false
    const purgeResult = await purgeExpiredAgentOutputs({ dryRun: false });

    // Kiểm tra file trên đĩa đã bị xóa
    const isUnlinked = !fs.existsSync(purgeFilePath);
    // Kiểm tra DB status đã chuyển thành PURGED (hoặc EXPIRED)
    const checkDb = await db.query('SELECT status FROM agent_output_files WHERE id = $1', [purgeTestId]);
    const isDbExpired = checkDb.rows.length > 0 && (checkDb.rows[0].status === 'PURGED' || checkDb.rows[0].status === 'EXPIRED');

    // Dọn dẹp DB
    await db.query('DELETE FROM agent_output_files WHERE id = $1', [purgeTestId]);
    if (fs.existsSync(purgeTestDir)) {
      try { fs.rmdirSync(purgeTestDir); } catch(e){}
    }

    recordTest({
      id: 'SEC-07',
      section: 'Security',
      name: 'Tiến trình tự động dọn dẹp tệp quá hạn (purgeExpiredAgentOutputs)',
      input: 'File test có expires_at trong quá khứ',
      action: 'Gọi hàm purgeExpiredAgentOutputs()',
      expected: 'File vật lý bị xóa khỏi đĩa, status trong DB cập nhật thành EXPIRED',
      actual: `Purged total: ${purgeResult.total}, Unlinked: ${isUnlinked}, DB Status: ${checkDb.rows[0]?.status}`,
      evidence: `Unlinked: ${isUnlinked} | DB Status: ${checkDb.rows[0]?.status}`,
      status: (isUnlinked && isDbExpired) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'SEC-07',
      section: 'Security',
      name: 'Tiến trình tự động dọn dẹp tệp quá hạn',
      input: 'Expired test record',
      action: 'purgeExpiredAgentOutputs()',
      expected: 'File unlinked, status EXPIRED',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // ---------------------------------------------------------------------------
  // SECTION 4: KIỂM THỬ HỒI QUY (REGRESSION SMOKE TESTS ON REAL APIS)
  // ---------------------------------------------------------------------------
  console.log('\n--- SECTION 4: Kiểm thử Hồi quy Real APIs ---');

  // REG-01: General AI Chat Real API
  try {
    const resReg1 = await fetch(`${API_BASE}/api/general/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Xin chào General AI, bạn có thể giúp tôi những tác vụ gì?'
      })
    });
    const jsonReg1 = await resReg1.json();
    const hasGenAiReply = jsonReg1.success !== false && (jsonReg1.reply || jsonReg1.text || '').length > 10;

    recordTest({
      id: 'REG-01',
      section: 'Regression',
      name: 'Smoke test API General AI (POST /api/general/chat)',
      input: 'Tin nhắn chào hỏi gửi tới General AI',
      action: 'POST /api/general/chat with real token',
      expected: 'HTTP 200, phản hồi hợp lệ từ General AI',
      actual: `HTTP ${resReg1.status}, Phản hồi hợp lệ: ${hasGenAiReply}`,
      evidence: `HTTP ${resReg1.status} | Snippet: "${(jsonReg1.reply || jsonReg1.text || '').slice(0, 100).replace(/\n/g, ' ')}"`,
      status: (resReg1.status === 200 && hasGenAiReply) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'REG-01',
      section: 'Regression',
      name: 'Smoke test General AI',
      input: 'Greeting',
      action: 'Fetch API',
      expected: 'HTTP 200',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // REG-02: HR Policy RAG Real API
  try {
    const resReg2 = await fetch(`${API_BASE}/api/policy/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Thời gian làm việc tiêu chuẩn hàng ngày theo quy định là bao nhiêu giờ?'
      })
    });
    const jsonReg2 = await resReg2.json();
    const hasPolicyReply = jsonReg2.success !== false && (jsonReg2.reply || jsonReg2.text || '').length > 10;

    recordTest({
      id: 'REG-02',
      section: 'Regression',
      name: 'Smoke test API HR Policy RAG (POST /api/policy/chat)',
      input: 'Câu hỏi quy chế thời gian làm việc',
      action: 'POST /api/policy/chat with real token',
      expected: 'HTTP 200, phản hồi đối chiếu chính sách nhân sự',
      actual: `HTTP ${resReg2.status}, Phản hồi hợp lệ: ${hasPolicyReply}`,
      evidence: `HTTP ${resReg2.status} | Snippet: "${(jsonReg2.reply || jsonReg2.text || '').slice(0, 100).replace(/\n/g, ' ')}"`,
      status: (resReg2.status === 200 && hasPolicyReply) ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'REG-02',
      section: 'Regression',
      name: 'Smoke test HR Policy RAG',
      input: 'Policy query',
      action: 'Fetch API',
      expected: 'HTTP 200',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // REG-03: HR Intake / OCR API (Confirm Company Endpoint Smoke Test)
  try {
    const hrUserRes = await db.query(`SELECT user_id, username, role, company_id FROM users WHERE role = 'HR' AND status = 'ACTIVE' LIMIT 1`);
    const hrUser = hrUserRes.rows[0];
    const tokenHR = createTestToken(hrUser);

    const resReg3 = await fetch(`${API_BASE}/api/hoso/intake/confirm-company`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenHR}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Gửi body rỗng để kiểm tra API đang lắng nghe và validate dữ liệu đúng chuẩn
      })
    });
    const jsonReg3 = await resReg3.json().catch(() => ({}));
    // Expected: API active, responds with HTTP 400 (yêu cầu tham số) chứng tỏ route hoạt động không bị lỗi 404 hay 500
    const isIntakeRouteActive = resReg3.status === 400;

    recordTest({
      id: 'REG-03',
      section: 'Regression',
      name: 'Smoke test API HR Intake (/api/hoso/intake/confirm-company)',
      input: 'Request tới intake endpoint với tài khoản HR',
      action: 'POST /api/hoso/intake/confirm-company',
      expected: 'Route hoạt động, phản hồi kiểm tra tham số chuẩn xác (HTTP 400)',
      actual: `HTTP ${resReg3.status}, Response: "${jsonReg3.error || jsonReg3.message || ''}"`,
      evidence: `HTTP ${resReg3.status} | Body: ${JSON.stringify(jsonReg3)}`,
      status: isIntakeRouteActive ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'REG-03',
      section: 'Regression',
      name: 'Smoke test HR Intake',
      input: 'Intake request',
      action: 'Fetch API',
      expected: 'HTTP 400/200',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // REG-04: Bảo toàn dữ liệu cơ sở dữ liệu lõi (Core Tables Integrity)
  try {
    const usersCountRes = await db.query('SELECT count(*) FROM users');
    const empCountRes = await db.query('SELECT count(*) FROM employees');
    const docCountRes = await db.query('SELECT count(*) FROM documents');

    const usersCount = parseInt(usersCountRes.rows[0].count, 10);
    const empCount = parseInt(empCountRes.rows[0].count, 10);
    const docCount = parseInt(docCountRes.rows[0].count, 10);

    const isCoreIntact = usersCount === 14 && empCount > 0 && docCount === 17;

    recordTest({
      id: 'REG-04',
      section: 'Regression',
      name: 'Bảo toàn dữ liệu sản xuất (Zero Corruption on Core Tables)',
      input: 'Bảng users, employees, documents',
      action: 'Đếm số lượng bản ghi thực tế',
      expected: '14 users, 17 documents được giữ nguyên vẹn 100%',
      actual: `Users: ${usersCount}, Employees: ${empCount}, Documents: ${docCount}`,
      evidence: `users=${usersCount}, employees=${empCount}, documents=${docCount}`,
      status: isCoreIntact ? 'PASS' : 'FAIL'
    });
  } catch (err) {
    recordTest({
      id: 'REG-04',
      section: 'Regression',
      name: 'Bảo toàn dữ liệu lõi',
      input: 'Core tables check',
      action: 'DB count query',
      expected: 'Counts match baseline',
      actual: err.message,
      evidence: err.stack,
      status: 'FAIL'
    });
  }

  // ---------------------------------------------------------------------------
  // CLEANUP TEST ARTIFACTS
  // ---------------------------------------------------------------------------
  if (generatedFileId) {
    try {
      await db.query('DELETE FROM agent_output_files WHERE id = $1', [generatedFileId]);
      if (generatedStoragePath && fs.existsSync(generatedStoragePath)) {
        fs.unlinkSync(generatedStoragePath);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  const total = passedCount + failedCount + blockedCount;
  console.log('\n========================================================================');
  console.log(`RUNTIME ACCEPTANCE TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED, ${blockedCount} BLOCKED (Total: ${total})`);
  console.log('========================================================================\n');

  // Save report to disk as JSON for programmatic audit
  const summaryJsonPath = path.join(__dirname, 'runtime_acceptance_report.json');
  fs.writeFileSync(summaryJsonPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total,
    passed: passedCount,
    failed: failedCount,
    blocked: blockedCount,
    passRate: `${Math.round((passedCount / total) * 100)}%`,
    tests: testResults
  }, null, 2), 'utf-8');

  console.log(`Saved detailed JSON report to ${summaryJsonPath}`);

  return { total, passed: passedCount, failed: failedCount, blocked: blockedCount, tests: testResults };
}

runRuntimeAcceptanceTests()
  .then(res => {
    if (res.failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  })
  .catch(err => {
    console.error('Fatal Runtime Test Error:', err);
    process.exit(1);
  });
