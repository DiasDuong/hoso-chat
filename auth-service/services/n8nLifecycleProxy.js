const http = require('http');

/**
 * SOTRANS HUB - N8N Lifecycle Proxy Service
 * Forwards any legacy upload intake requests directly to N8N SOTRANS_HR_EMPLOYEE_LIFECYCLE Webhook
 */
async function forwardUploadToN8n(req, files, extraFields = {}) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts = [];

  const fields = { ...req.body, ...extraFields };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && typeof v !== 'object') {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
  }

  if (Array.isArray(files)) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const fieldName = f.fieldname || `file_${i}`;
      const fileName = f.originalname || `file_${i}.pdf`;
      const mime = f.mimetype || 'application/pdf';
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
      parts.push(f.buffer || Buffer.alloc(0));
      parts.push(Buffer.from('\r\n'));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const internalSecret = process.env.N8N_INTERNAL_SECRET || process.env.INTERNAL_SERVICE_SECRET || '8973d464f5f1475b83d6ab88d222d824';
  if (!fields.secret) {
    parts.unshift(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="secret"\r\n\r\n${internalSecret}\r\n`));
  }

  const fullBody = Buffer.concat(parts);
  const authHeader = req.headers['authorization'] || '';
  const correlationId = req.headers['x-correlation-id'] || req.id || ('corr_' + Date.now());

  return new Promise((resolve, reject) => {
    const postReq = http.request({
      hostname: 'n8n',
      port: 5678,
      path: '/webhook/hr-lifecycle-upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': authHeader,
        'X-Correlation-Id': correlationId,
        'x-n8n-internal-secret': internalSecret,
        'x-internal-secret': internalSecret,
        'Content-Length': fullBody.length
      },
      timeout: 120000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          resolve({ status: res.statusCode, body: json });
        } catch(e) {
          resolve({ status: res.statusCode, body: { success: false, error: d } });
        }
      });
    });

    postReq.on('error', (err) => {
      console.error('[n8nLifecycleProxy] Error forwarding to n8n:', err.message);
      reject(err);
    });

    postReq.write(fullBody);
    postReq.end();
  });
}

module.exports = { forwardUploadToN8n };
