// Round-4 fixes, verified by FACT against a live server:
//  A) STOP (and BLACKOUT) kill an active PRESET — the screen must stop flashing.
//  B) When the track ENDS, the show auto-stops: screen goes black, waveform hides,
//     server returns to idle (bug: "music ended but screens kept flashing").
//  C) Sync quality gate: a phone reports a good clock (bestRtt + low jitter) when
//     it declares itself synced — it never paints off a not-yet-trustworthy offset.
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
const black = (c) => c === 'rgb(0, 0, 0)' || c === 'rgba(0, 0, 0, 0)';

const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, detail) => { report.checks[id] = { ok: !!ok, detail }; if (!ok) report.fails.push(id + ': ' + detail); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + detail); };

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;
  const browser = await chromium.launch();

  // ---- A) STOP kills an active preset ----
  await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'pulse' }) }).then(j);
  const a = await (await browser.newContext()).newPage();
  await a.goto(`${BASE}/join?s=${code}&auto=1`);
  await a.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });
  await a.waitForFunction(() => window.__cls.preset === 'pulse' && window.__cls.everLit, { timeout: 5000 }).catch(() => {});
  const litUnderPreset = await a.evaluate(() => window.__cls.everLit && window.__cls.preset === 'pulse');
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) }).then(j);
  await sleep(700);
  const afterStop = await a.evaluate(() => ({ preset: window.__cls.preset, bg: getComputedStyle(document.getElementById('flash')).backgroundColor, status: window.__cls.status }));
  check('A_stop_kills_preset', litUnderPreset && afterStop.preset == null && black(afterStop.bg) && afterStop.status === 'idle',
    `litUnderPreset=${litUnderPreset} -> afterStop preset=${afterStop.preset} bg=${afterStop.bg} status=${afterStop.status}`);

  // ---- C) sync quality gate (read from the same synced page) ----
  const q = await a.evaluate(() => ({ synced: window.__cls.synced, degraded: window.__cls.degraded, quality: window.__cls.quality }));
  check('C_sync_quality', q.synced && q.quality && (q.degraded || (q.quality.bestRtt <= 400 && q.quality.jitter <= 30 && q.quality.n >= 8)),
    `synced=${q.synced} degraded=${q.degraded} quality=${JSON.stringify(q.quality)}`);
  await a.close();

  // ---- B) track end -> auto-stop (black + waveform hidden + server idle) ----
  // upload a short fixture so the end comes quickly
  const fd = new FormData();
  fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  const trackId = up.trackId; const durMs = up.durationMs || 6000;
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId }) }).then(j);
  const b = await (await browser.newContext()).newPage();
  await b.goto(`${BASE}/join?s=${code}&auto=1`);
  await b.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });
  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  await b.waitForFunction(() => window.__cls.everLit, { timeout: 8000 }).catch(() => {});
  const litDuringShow = await b.evaluate(() => window.__cls.everLit);
  await sleep(durMs + 2500); // wait past the track end (+ server auto-stop + tail)
  const afterEnd = await b.evaluate(() => ({ status: window.__cls.status, bg: getComputedStyle(document.getElementById('flash')).backgroundColor, waveHidden: document.getElementById('wave').classList.contains('hidden') }));
  const serverStatus = (await fetch(BASE + '/healthz').then(j)).status;
  check('B_track_end_autostop', litDuringShow && afterEnd.status === 'idle' && black(afterEnd.bg) && afterEnd.waveHidden && serverStatus === 'idle',
    `litDuringShow=${litDuringShow} -> afterEnd status=${afterEnd.status} bg=${afterEnd.bg} waveHidden=${afterEnd.waveHidden} serverStatus=${serverStatus}`);
  await b.close();
  await browser.close();
  await fetch(BASE + '/api/operator/track/' + trackId, { method: 'DELETE', headers: H(token) }); // cleanup fixture

  fs.writeFileSync(path.join(dir, '..', 'round4_report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('\nROUND4 HARNESS FAIL: ' + report.fails.join(' | ')); process.exit(1); }
  console.log('\nROUND4 HARNESS PASS: STOP kills preset, track-end auto-stops (black + wave hidden + server idle), sync quality gated.');
}
main().catch((e) => { console.error(e); process.exit(1); });
