// Regression: arming a DIFFERENT track must change the music on opted-in phones (the
// phone cached the first track's audio buffer and never re-fetched). Proven by FACT:
// upload two tracks of DIFFERENT length, opt a phone into audio, arm+GO A (phone audio
// buffer ~= A's duration), then arm+GO B (phone audio buffer ~= B's duration). WAV so
// headless can decode. The __cls.audio.durMs telemetry = the decoded buffer length.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

function wav(secs, freq) {
  const sr = 22050, n = sr * secs; const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 0.6 * 32767), i * 2);
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}
async function up(token, secs, freq, name) {
  const fd = new FormData(); fd.append('audio', new Blob([wav(secs, freq)]), name);
  const r = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  await fetch(BASE + '/api/operator/track/' + r.trackId + '/attest', { method: 'POST', headers: H(token) }).then(j); // crowd audio is licence-gated
  return r;
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;
  const A = await up(token, 6, 220, 'trackA_6s.wav');  // ~6000ms
  const B = await up(token, 3, 440, 'trackB_3s.wav');  // ~3000ms

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await (await browser.newContext()).newPage();
  await p.goto(`${BASE}/join?s=${code}&auto=1&audio=1`);
  await p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {});

  // arm + GO A
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: A.trackId }) }).then(j);
  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  await p.waitForFunction(() => window.__cls.audio && window.__cls.audio.ready, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  const durA = await p.evaluate(() => window.__cls.audio.durMs);
  check('A_loaded', Math.abs(durA - 6000) < 400, `phone audio buffer for A = ${durA}ms (~6000)`);

  // arm + GO B (the different track) — the phone must switch to B's audio
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: B.trackId }) }).then(j);
  await p.waitForFunction((da) => window.__cls.audio && window.__cls.audio.ready && Math.abs(window.__cls.audio.durMs - da) > 1000, durA, { timeout: 15000 }).catch(() => {});
  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  await sleep(600);
  const durB = await p.evaluate(() => window.__cls.audio.durMs);
  check('B_switched', Math.abs(durB - 3000) < 400 && durB !== durA, `phone audio buffer after arming B = ${durB}ms (~3000, changed from ${durA})`);

  await browser.close();
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) });
  for (const id of [A.trackId, B.trackId]) await fetch(BASE + '/api/operator/track/' + id, { method: 'DELETE', headers: H(token) });

  fs.writeFileSync(path.join(dir, '..', 'track_switch_report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('\nTRACK SWITCH FAIL: ' + report.fails.join(' | ')); process.exit(1); }
  console.log('\nTRACK SWITCH PASS: arming a different track switches the music on the phone (buffer re-fetched).');
}
main().catch((e) => { console.error(e); process.exit(1); });
