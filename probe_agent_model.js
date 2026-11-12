const http = require('http');

async function probe() {
  const loginRes = await new Promise(r => {
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
    });
    req.write(JSON.stringify({ username: 'emp_stl', password: 'Employee@2026!' }));
    req.end();
  });
  const token = loginRes.token;

  // Tạo probe agent với gemini-3.5-flash-lite
  const createRes = await new Promise(r => {
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/agents', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
    });
    req.write(JSON.stringify({
      name: 'Audit-Probe-35',
      description: 'Agent thử nghiệm kiểm toán',
      instruction_prompt: 'Bạn là chuyên gia phân tích dữ liệu logistics SOTRANS.',
      model_name: 'gemini-3.5-flash-lite',
      agent_type: 'DATA_ANALYST'
    }));
    req.end();
  });
  console.log('Create agent:', createRes.success, 'ID:', createRes.agent?.id);
  const testAgentId = createRes.agent?.id;
  if (!testAgentId) return;

  const boundary = '----Boundary123';
  const postData = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n1+1 bằng mấy? Giải thích ngắn gọn 1 câu.\r\n--${boundary}--\r\n`
  );

  const chatRes = await new Promise(r => {
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}/chat`, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Authorization': 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { r({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { r({ status: res.statusCode, raw: d }); }
      });
    });
    req.write(postData);
    req.end();
  });
  console.log('Chat status:', chatRes.status);
  console.log('Chat reply:', chatRes.data?.reply || chatRes.raw);

  // Xóa probe agent sau khi xong
  const delRes = await new Promise(r => {
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: `/api/agents/${testAgentId}`, method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
    });
    req.end();
  });
  console.log('Cleaned up agent:', delRes.success);
}

probe().catch(console.error);
