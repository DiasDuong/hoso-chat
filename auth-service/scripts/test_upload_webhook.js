const jwt = require('jsonwebtoken');
const fs = require('fs');
const http = require('http');

const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';
const token = jwt.sign({
  user_id: '9a2e8590-c1a2-41c6-abb2-b802cb8060c6',
  username: 'hr_stl',
  role: 'HR',
  company_id: 'STL'
}, JWT_SECRET, { expiresIn: '1h' });

const filePath = 'auth-service/uploads/staging/2934d04a-d92a-459a-9c61-a1693ed58615_cccd_nguyen_van_mot.pdf';
const fileBuf = fs.readFileSync(filePath);

const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

const parts = [];
parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="company_id"\r\n\r\nSTL\r\n`));
parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cccd_nguyen_van_mot.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
parts.push(fileBuf);
parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

const fullBody = Buffer.concat(parts);

console.log('Sending upload request to http://127.0.0.1:8082/webhook/hr-lifecycle-upload ...');
const req = http.request({
  hostname: '127.0.0.1',
  port: 8082,
  path: '/webhook/hr-lifecycle-upload',
  method: 'POST',
  headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Authorization': `Bearer ${token}`,
    'X-Correlation-Id': 'corr_test_' + Date.now(),
    'Content-Length': fullBody.length
  }
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('HTTP Status:', res.statusCode);
    try {
      const parsed = JSON.parse(d);
      console.log('Response JSON:', JSON.stringify(parsed, null, 2).slice(0, 800));
    } catch(e) {
      console.log('Raw Response:', d);
    }
  });
});

req.on('error', err => console.error('Request error:', err.message));
req.write(fullBody);
req.end();
