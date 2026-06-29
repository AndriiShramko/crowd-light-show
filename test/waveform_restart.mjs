// Round-8A bug, proven by FACT against a running server: after the music ENDS and the
// operator presses GO again, the waveform vanished on every phone and never came back
// until the app was restarted. Root cause (public/audience.js): track-end -> hideWave();
// a fresh GO on the SAME armed track sends only {t:'start'} (no new {t:'timeline'}, so
// buildEnvelope is not called) -> the canvas stayed `hidden` forever. Fix: {t:'start'}
// now calls showWave(). This reproduces the operator's REAL stop->restart WS sequence
// (server stop() — what natural track-end fires too — then go()) across 3 cycles, plus a
// natural track-end cycle, asserting #wave is visible after each restart with no JS errors.
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

// short mono 16-bit WAV (~2.6s, 220Hz, loud/quiet so the envelope is non-trivial) — decoded
// natively by the server (no ffmpeg needed). Short so a natural track-end comes quickly.
function shortWav(secs) {
  const sr = 22050, n = Math.round(sr * secs); const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / sr; const amp = (Math.floor(t / 0.4) % 2) ? 0.9 : 0.1; data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.sin(2 * Math.PI * 220 * t) * amp * 32767))), i * 2); }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const waveState = (p) => p.evaluate(() => {
  const w = document.getElementById('wave'); if (!w) return { exists: false };
  const r = w.getBoundingClientRect();
  return { exists: true, hidden: w.classList.contains('hidden'), display: getComputedStyle(w).display, w: r.width, h: r.height, cls: window.__cls && window.__cls.waveHidden };
});
const visible = (s) => s.exists && !s.hidden && s.display !== 'none' && s.w > 0 && s.h > 0;

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');
  const fd = new FormData(); fd.append('audio', new Blob([shortWav(2.6)]), 'short.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  const trackId = up.trackId; if (!trackId) throw new Error('upload failed: ' + JSON.stringify(up));
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;

  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  // headless throws benign permission errors for wakeLock/fullscreen (no real permission in a
  // headless browser) — not app bugs; filter them like the other harnesses (presets_harness).
  const benign = /Permissions check failed|status of 401|Failed to load resource|permission|NotAllowedError/i;
  page.on('pageerror', (e) => { if (!benign.test(e.message)) errors.push('PAGEERR: ' + e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !benign.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
  await page.goto(`${BASE}/join?s=${code}&auto=1`);
  await page.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });

  const arm = () => fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId }) }).then(j);
  const go = () => fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  const stop = () => fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) }).then(j);

  // first play: arm (delivers timeline -> buildEnvelope shows wave) + GO
  await arm(); await go(); await sleep(1500);
  let s = await waveState(page);
  check('wave_visible_first_play', visible(s), `first play wave: ${JSON.stringify(s)}`);

  // 3x stop -> restart cycles (server stop() == what a natural track-end fires). The bug:
  // before the fix, the wave was hidden after the first stop and never returned on GO.
  let allRestart = true, details = [];
  for (let c = 1; c <= 3; c++) {
    await stop(); await sleep(500);
    const hid = await waveState(page);                       // stop must hide it (regression guard)
    await go(); await sleep(1200);
    const vis = await waveState(page);
    const ok = !visible(hid) && visible(vis);
    details.push(`cycle${c}: afterStop=${visible(hid)} afterGo=${visible(vis)}`);
    if (!ok) allRestart = false;
  }
  check('wave_returns_on_restart_x3', allRestart, details.join(' | '));

  // natural track-end -> restart (Andrii's exact scenario): let the short track finish so
  // the server auto-stop fires, then GO again and assert the wave comes back.
  await arm(); await go(); await sleep(1500);
  const playing = await waveState(page);
  await sleep(3200);                                          // 2.6s track + 0.9s lead + tail -> ended
  const ended = await waveState(page);
  await go(); await sleep(1300);
  const restarted = await waveState(page);
  check('wave_returns_after_natural_end', visible(playing) && !visible(ended) && visible(restarted),
    `playing=${visible(playing)} ended(hidden)=${!visible(ended)} restarted=${visible(restarted)}`);

  check('no_js_errors', errors.length === 0, errors.length ? errors.join(' | ') : 'no console/page errors during restart cycles');
  await browser.close();
  fs.writeFileSync(path.join(dir, '..', 'waveform_restart_report.json'), JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('WAVEFORM RESTART FAIL:', report.fails.join('; ')); process.exit(1); }
  console.log('WAVEFORM RESTART PASS: #wave returns after every stop->GO (x3) and after a natural track-end->GO; no JS errors. (headless = the operator WS sequence, not real phones.)');
}
main().catch((e) => { console.error('WAVEFORM RESTART ERROR:', e); process.exit(1); });
