'use strict';
const crypto = require('node:crypto');
function payloadDigest(payload) {
  const { export_token, ...data } = payload;
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
function signReport(payload, user) {
  if (!user?.user_id || !process.env.JWT_SECRET) return payload;
  const body = Buffer.from(JSON.stringify({ user_id: user.user_id, expires: Date.now() + 3600000, digest: payloadDigest(payload) })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  return { ...payload, export_token: `${body}.${signature}` };
}
function verifyReport(payload, user) {
  if (!process.env.JWT_SECRET || typeof payload?.export_token !== 'string') return false;
  try {
    const [body, signature, extra] = payload.export_token.split('.');
    if (extra || !body || !signature) return false;
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return claims.user_id === user.user_id && claims.expires > Date.now() && claims.digest === payloadDigest(payload);
  } catch (_) { return false; }
}
module.exports = { signReport, verifyReport };
