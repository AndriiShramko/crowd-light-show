import crypto from 'node:crypto';
import { config } from './config.js';

// Minimal signed token (HMAC-SHA256) for operator sessions. No external deps.
export function issueToken(role = 'operator', ttlMs = 12 * 3600 * 1000) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
