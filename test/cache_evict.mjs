// Regression for the timeline-cache staleness bug: SQLite reuses a row id after the
// highest track is deleted, so a delete-then-reupload could make loadTimeline serve the
// OLD track's cached cues to new joiners. Proven by FACT: upload A (varying), delete it,
// upload B (flat) which reuses the id, arm B, and assert a fresh phone receives B's cue
// count — not A's. WAVs are decoded natively (no ffmpeg).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });

// mono 16-bit WAV; varying=loud/quiet 2s blocks (many cues), flat=constant (few cues)
function wav(varying) {
  const sr = 22050, secs = 6, n = sr * secs; const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr; const amp = varying ? ((Math.floor(t / 2) % 2) === 1 ? 0.9 : 0.04) : 0.7;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.sin(2 * Math.PI * 220 * t) * amp * 32767))), i * 2);
  }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}
async function upload(token, varying, name) {
  const fd = new FormData(); fd.append('audio', new Blob([wav(varying)]), name);
  return fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;
  const A = await upload(token, true, 'A_varying.wav');   // many cues
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: A.trackId }) }).then(j);
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) });
  await fetch(BASE + '/api/operator/track/' + A.trackId, { method: 'DELETE', headers: H(token) });
  const B = await upload(token, false, 'B_flat.wav');     // few cues; id likely reused
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: B.trackId }) }).then(j);

  const browser = await chromium.launch();
  const p = await (await browser.newContext()).newPage();
  await p.goto(`${BASE}/join?s=${code}&auto=1`);
  await p.waitForFunction(() => window.__cls && window.__cls.gotTimeline != null, { timeout: 20000 }).catch(() => {});
  const got = await p.evaluate(() => window.__cls.gotTimeline);
  await browser.close();
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) });
  await fetch(BASE + '/api/operator/track/' + B.trackId, { method: 'DELETE', headers: H(token) });

  const idReused = A.trackId === B.trackId;
  const report = { base: BASE, idA: A.trackId, idB: B.trackId, idReused, cueA: A.cueCount, cueB: B.cueCount, phoneGotCues: got };
  fs.writeFileSync(path.join(dir, '..', 'cache_evict_report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // the phone must receive B's cue count (the NEW track), never A's stale cached cues
  const ok = got === B.cueCount && got !== A.cueCount;
  if (!ok) { console.error(`CACHE EVICT FAIL: phone got ${got} cues; expected B=${B.cueCount} (A=${A.cueCount}, idReused=${idReused})`); process.exit(1); }
  console.log(`CACHE EVICT PASS: after delete+reupload (idReused=${idReused}), the joiner got the NEW track's ${got} cues, not the stale ${A.cueCount}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
