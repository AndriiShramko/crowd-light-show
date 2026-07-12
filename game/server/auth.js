// Тот же минимальный HMAC-токен, что в src/auth.js лайтшоу (совместим для handoff Фазы D).
import crypto from 'node:crypto';

const SECRET = process.env.GAME_SESSION_SECRET || '';
if (!SECRET) { console.error('GAME_SESSION_SECRET is required'); process.exit(1); }

export function issueToken(role, ttlMs, extra = {}) {
  const payload = Buffer.from(JSON.stringify({ role, ...extra, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
