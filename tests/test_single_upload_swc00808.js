const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('../auth-service/node_modules/jsonwebtoken');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

async function testUpload() {
  console.log('--- TEST SINGLE UPLOAD: SWC00808.pdf via Gateway ---');
  
  const token = jwt.sign({
    user_id: 'a175e400-b5e3-4a3a-a6ac-16c9973ee548',
    username: 'hr_swc',
    role: 'HR',
    company_id: 'SWC'
  }, JWT_SECRET, { expiresIn: '1h' });

  const pdfPath = path.resolve(__dirname, '../auth-service/uploads/staging/SWC00808.pdf');
  const pdfBuf = fs.readFileSync(pdfPath);
  console.log(`Loaded SWC00808.pdf: ${(pdfBuf.length / 1024 / 1024).toFixed(2)} MB`);

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="company_id"\r\n\r\nSWC\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="SWC00808.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
  parts.push(pdfBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const fullBody = Buffer.concat(parts);

  console.log('Sending upload request to http://127.0.0.1:8082/webhook/hr-lifecycle-upload ...');
  const start = Date.now();

  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8082,
      path: '/webhook/hr-lifecycle-upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${token}`,
        'X-Correlation-Id': 'corr_test_swc00808_' + Date.now(),
        'Content-Length': fullBody.length
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`Response received in ${duration}s: Status = ${res.status}`);
  console.log('Response Body:', JSON.stringify(res.body || res.raw, null, 2));
}

testUpload().catch(console.error);
