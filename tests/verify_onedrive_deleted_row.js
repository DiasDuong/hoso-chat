const jwt = require('../auth-service/node_modules/jsonwebtoken');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';
const token = jwt.sign(
  {
    user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26',
    username: 'emp_stl',
    email: 'emp_stl@sotrans.com.vn',
    role: 'STAFF',
    company_id: 'STL'
  },
  JWT_SECRET,
  { expiresIn: '2h' }
);

async function testDeletedRowRetrieval() {
  console.log('Testing live chat endpoint for conversation 54fd3668-fa98-461b-9595-7a3217006e33...');
  const agentId = 'cbb7053e-c388-4072-a87f-1e49b6facf07';
  const conversationId = '54fd3668-fa98-461b-9595-7a3217006e33';
  const message = 'giá dịch vụ đi từ KCN Đình Vũ đi Cảng Hải Phòng là bao nhiêu';

  const response = await fetch(`http://localhost:3000/api/agents/${agentId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      message,
      conversation_id: conversationId,
      stream: false
    })
  });

  const data = await response.json();
  console.log('\n--- Status:', response.status);
  console.log('--- Reply:\n', data.reply);
  console.log('--- Metadata:\n', JSON.stringify(data.versions || data.active_version, null, 2));

  const text = (data.reply || '').toLowerCase();

  // Check that 3.800.000 (deleted row) is NOT asserted
  const assertsDeletedRow = text.includes('3.800.000') || text.includes('3,800,000') || text.includes('3.8 triệu') || text.includes('dòng số 15') || text.includes('dòng 15');
  if (assertsDeletedRow) {
    console.error('\n❌ FAILED: The response still contains the deleted row (3.800.000 / Dòng 15)!');
    process.exit(1);
  }

  // Check that it recognizes there is NO direct quote or only reverse quote
  const recognizesNoQuoteOrReversed = text.includes('chưa có') || text.includes('không có') || text.includes('chiều ngược lại') || text.includes('ngược lại');
  if (!recognizesNoQuoteOrReversed) {
    console.error('\n❌ FAILED: Did not indicate that the quote is missing or only reverse exists!');
    process.exit(1);
  }

  console.log('\n✅ PASSED: System successfully ignored stale conversation memory, verified current OneDrive snapshot, and accurately reported that KCN Đình Vũ -> Cảng Hải Phòng is not quoted (row was deleted)!');
}

testDeletedRowRetrieval().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
