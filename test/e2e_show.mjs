// Full end-to-end: an operator (real console) arms + GOes a real track while an
// audience client is joined, and the audience must actually flash from it. This
// mirrors exactly what a real operator does (the path that was failing on a real
// MP3/MP4 upload). Run against BASE with a track already uploaded.
import { chromium } from 'playwright';
const BASE = process.env.BASE; const PASS = process.env.OPERATOR_PASS;
const code = (await fetch(BASE + '/api/public/show').then((r) => r.json())).code;
const b = await chromium.launch();

const opCtx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS } });
const op = await opCtx.newPage();
const opErrors = [];
op.on('pageerror', (e) => opErrors.push(e.message));
await op.goto(BASE + '/operator');
await op.waitForSelector('[data-arm]', { timeout: 12000 });

const au = await (await b.newContext()).newPage();
await au.goto(`${BASE}/join?s=${code}&auto=1`);
await au.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 });

// operator arms the first track (lights immediately; audio best-effort) then GOes
await op.click('[data-arm]');
await op.waitForTimeout(3000); // allow audio load attempt
const armedLabel = await op.evaluate(() => document.getElementById('armed').textContent);
await op.click('#go');
await op.waitForTimeout(27000); // run past the song's quiet intro into a loud part

const au2 = await au.evaluate(() => ({ everLit: window.__cls.everLit, flashes: window.__cls.flashes.length, status: window.__cls.status, gotStart: !!window.__cls.gotStart, maxLum: Math.round((window.__cls.maxLum || 0) * 100) / 100 }));
await op.evaluate(() => document.getElementById('stop').click());
await b.close();

console.log(JSON.stringify({ armedLabel, audience: au2, opErrors }, null, 2));
const fails = [];
if (opErrors.length) fails.push('operator JS errors: ' + opErrors.join(' | '));
if (!/track #/.test(armedLabel)) fails.push('track did not arm (label=' + armedLabel + ') — audio decode likely failed');
if (!au2.gotStart) fails.push('audience never received START');
if (!au2.everLit || au2.flashes < 1) fails.push('audience did NOT flash from the real track');
if (fails.length) { console.error('E2E SHOW FAIL:', fails.join('; ')); process.exit(1); }
console.log(`E2E SHOW PASS: operator armed "${armedLabel}" + GO; audience flashed (${au2.flashes} flashes, maxLum ${au2.maxLum}) from the REAL uploaded track`);
