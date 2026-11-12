const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');

async function testDocs() {
  const u = (await db.query("SELECT user_id, username, role, company_id FROM users WHERE username = 'emp_stl'")).rows[0];
  const token = jwt.sign(
    { user_id: u.user_id, username: u.username, role: u.role, company_id: u.company_id },
    'super_secret_jwt_key_hrbot_2026_!@#$',
    { expiresIn: '1h' }
  );
  const agent = (await db.query("SELECT id FROM user_agents WHERE user_id = $1 LIMIT 1", [u.user_id])).rows[0];

  console.log('1. Testing DOCX upload...');
  const docxBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'test_sample.docx'));
  const fdDocx = new FormData();
  fdDocx.append('message', 'Hãy cho tôi biết tài liệu Word đính kèm này chứa những nội dung hoặc chú thích gì.');
  fdDocx.append('files', new Blob([docxBytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'test_sample.docx');

  const resDocx = await fetch('http://localhost:3000/api/agents/' + agent.id + '/chat', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: fdDocx
  });
  const jsonDocx = await resDocx.json();
  console.log('DOCX HTTP Status:', resDocx.status);
  console.log('DOCX Reply:', (jsonDocx.reply || '').slice(0, 200).replace(/\n/g, ' '));

  console.log('\n2. Testing PDF upload...');
  const pdfBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'test_sample.pdf'));
  const fdPdf = new FormData();
  fdPdf.append('message', 'Hãy đọc tệp PDF đính kèm và cho biết đây là loại giấy tờ/hồ sơ gì.');
  fdPdf.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'test_sample.pdf');

  const resPdf = await fetch('http://localhost:3000/api/agents/' + agent.id + '/chat', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: fdPdf
  });
  const jsonPdf = await resPdf.json();
  console.log('PDF HTTP Status:', resPdf.status);
  console.log('PDF Reply:', (jsonPdf.reply || '').slice(0, 200).replace(/\n/g, ' '));

  process.exit(0);
}

testDocs().catch(e => {
  console.error('Fatal DOCX/PDF Test Error:', e);
  process.exit(1);
});
