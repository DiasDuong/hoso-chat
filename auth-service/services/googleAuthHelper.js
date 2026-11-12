const https = require('https');
const crypto = require('crypto');

const GOOGLE_SA = {
  client_email: process.env.GOOGLE_SA_CLIENT_EMAIL || 'n8n-sheets-bot@n8n-sheets-510207.iam.gserviceaccount.com',
  private_key: (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n')
};
if (!GOOGLE_SA.private_key) {
  console.warn('[googleAuthHelper] WARNING: GOOGLE_SA_PRIVATE_KEY is not configured in environment.');
}
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || (process.env.NODE_ENV === 'staging' ? '' : '1q_Sv9-p-pa5_yzoMSlbJfwz5vNqEhFFBaBhC3f0U6YI');

let cachedToken = null;
let tokenExpiry = 0;

function getGoogleAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return Promise.resolve(cachedToken);
  }

  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claim = {
      iss: GOOGLE_SA.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = b64(header) + '.' + b64(claim);
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(GOOGLE_SA.private_key, 'base64url');
    const jwt = unsigned + '.' + signature;
    const postData = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt);

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            cachedToken = parsed.access_token;
            tokenExpiry = Date.now() + ((parsed.expires_in || 3600) - 300) * 1000;
            resolve(cachedToken);
          } else {
            reject(new Error('Lỗi lấy Google Token: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout kết nối OAuth Google')); });
    req.write(postData);
    req.end();
  });
}

module.exports = {
  GOOGLE_SA,
  GOOGLE_SPREADSHEET_ID,
  getGoogleAccessToken
};
