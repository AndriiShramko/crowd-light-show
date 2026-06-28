// Verifies real Pause -> Resume (continue, not restart), the sync-gate, and the
// per-device waveform. Run against BASE with a 'done' track present (uploads a
// fixture if none).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE; const PASS = process.env.OPERATOR_PASS;
const j = (r) => r.json();
const H = (token, extra) => ({ Authorization: 'Bearer ' + token, ...(extra || {}) });
const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
let track = (st.tracks || []).find((t) => t.analysis_status === 'done');
if (!track) {
  const fd = new FormData();
  fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
  await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  track = st.tracks.find((t) => t.analysis_status === 'done');
}
const code = (await fetch(BASE + '/api/public/show').then(j)).code;
await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: track.id }) }).then(j);
const b = await chromium.launch();
const a = await (await b.newContext()).newPage();
const err = []; a.on('pageerror', (e) => { if (!/Permissions check failed/.test(e.message)) err.push(e.message); });
await a.goto(`${BASE}/join?s=${code}&auto=1`);
await a.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 });
await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
await a.waitForTimeout(2000);
const running = await a.evaluate(() => window.__cls.lastPos);
await fetch(BASE + '/api/operator/pause', { method: 'POST', headers: H(token) }).then(j);
await a.waitForTimeout(1000);
const paused1 = await a.evaluate(() => window.__cls.lastPos);
await a.waitForTimeout(900);
const paused2 = await a.evaluate(() => window.__cls.lastPos);
await fetch(BASE + '/api/operator/resume', { method: 'POST', headers: H(token) }).then(j);
await a.waitForTimeout(1300);
const resumed = await a.evaluate(() => window.__cls.lastPos);
const waveVisible = await a.evaluate(() => { const w = document.getElementById('wave'); return !!w && !w.classList.contains('hidden'); });
await b.close();
console.log(JSON.stringify({ running, paused1, paused2, resumed, waveVisible, err }, null, 2));
const fails = [];
if (err.length) fails.push('JS errors: ' + err.join(' | '));
if (running < 1000) fails.push('did not start (' + running + ')');
if (Math.abs(paused2 - paused1) > 200) fails.push('PAUSE not frozen (' + paused1 + '->' + paused2 + ')');
if (resumed <= paused2 + 400) fails.push('RESUME did not continue forward (' + paused2 + '->' + resumed + ')');
if (resumed > paused2 + 3000) fails.push('RESUME jumped (restart?) (' + paused2 + '->' + resumed + ')');
if (!waveVisible) fails.push('waveform not visible');
if (fails.length) { console.error('PAUSE/RESUME FAIL:', fails.join('; ')); process.exit(1); }
console.log('PAUSE/RESUME PASS: started, PAUSE froze position, RESUME continued from the pause point (not 0), waveform visible, no JS errors');
