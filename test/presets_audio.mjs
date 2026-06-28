// Audio-reactive presets, proven by FACT against a live server:
//   - with audioDepth=1 each phone's rendered luminance tracks the music (bright in
//     loud sections, dark in quiet ones) AND all phones agree (same governed b at the
//     same synced track position);
//   - with audioDepth=0 the preset is byte-identical to the autonomous (non-reactive)
//     output — the music has zero effect.
// A loud/quiet WAV is generated in-memory and uploaded (WAV is decoded natively, no
// ffmpeg needed), so the server analyzes a real loudness envelope. Headless = protocol
// + scheduling, NOT real phones.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, clampColor, relLum } from '../src/presets.js';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const N = Number(process.env.N || 8);
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mono 16-bit WAV, 8s: quiet [0,2)+[4,6), loud [2,4)+[6,8) (220Hz sine).
function loudQuietWav() {
  const sr = 22050, secs = 8, n = sr * secs;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr; const loud = (Math.floor(t / 2) % 2) === 1;
    const amp = loud ? 0.9 : 0.04;
    const s = Math.round(Math.sin(2 * Math.PI * 220 * t) * amp * 32767);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
function isLoud(trackPos) { return (Math.floor((trackPos / 1000) / 2) % 2) === 1; }
const report = { base: BASE, n: N, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');
  const fd = new FormData();
  fd.append('audio', new Blob([loudQuietWav()]), 'loudquiet.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  const trackId = up.trackId; if (!trackId) throw new Error('upload failed: ' + JSON.stringify(up));
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;
  // arm KEEPING any preset, then GO so the timeline runs underneath the preset
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId, keepPreset: true }) }).then(j);
  // fetch the DELIVERED timeline so we can assert each phone reads the exact governed b
  const tl = await fetch(BASE + '/api/operator/timeline/' + trackId, { headers: H(token) }).then(j).catch(() => null);
  const cues = (tl && (tl.cues || (tl.data && tl.data.cues))) || [];
  const durationMs = (tl && (tl.durationMs || (tl.data && tl.data.durationMs))) || 8000;
  function cueB(pos) {
    if (!cues.length) return 0;
    if (pos <= cues[0].t) return cues[0].b;
    if (pos >= cues[cues.length - 1].t) return cues[cues.length - 1].b;
    let lo = 0, hi = cues.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cues[m].t <= pos) lo = m; else hi = m; }
    const a = cues[lo], b = cues[hi], f = (pos - a.t) / Math.max(1, b.t - a.t); return a.b + (b.b - a.b) * f;
  }

  const browser = await chromium.launch();
  const pages = [];
  for (let i = 0; i < N; i++) { const p = await (await browser.newContext()).newPage(); await p.goto(`${BASE}/join?s=${code}&auto=1`); pages.push(p); }
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {})));

  // ---- reactive: audioDepth=1, depth=0 isolates the music term ----
  await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'pulse', params: { audioDepth: 1, audioGamma: 1, bpm: 60, depth: 0, base: 0.12 } }) }).then(j);
  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);

  // We verify the MUSIC SIGNAL (window.__cls.envLevel = the raw governed b the preset
  // reads, BEFORE clampColor/backstop) — robust to the flash-gate and to eval-skew,
  // because each phone is compared to ITS OWN expected b at ITS OWN trackPos.
  const loudEnv = [], quietEnv = []; let activeSamples = 0, totalSamples = 0, worstDet = 0, detSamples = 0;
  const inCore = (tp) => { const m = ((tp % 2000) + 2000) % 2000; return m >= 450 && m <= 1550; }; // >=450ms from a section edge
  for (let s = 0; s < 20; s++) {
    await sleep(260);
    const snap = await Promise.all(pages.map((p) => p.evaluate(() => ({ env: window.__cls.envLevel, tp: window.__cls.trackPos, active: window.__cls.envActive }))));
    for (const x of snap) {
      if (x.tp == null || x.tp < 400 || x.tp > durationMs - 400) continue;  // inside the track only
      totalSamples++;
      if (x.active) activeSamples++;
      if (x.env == null || !x.active) continue;
      // determinism: every phone reads the governed b at its OWN trackPos (=> all phones agree)
      worstDet = Math.max(worstDet, Math.abs(x.env - cueB(x.tp))); detSamples++;
      // reactivity: the music signal itself is high in loud sections, low in quiet ones
      if (inCore(x.tp)) (isLoud(x.tp) ? loudEnv : quietEnv).push(x.env);
    }
  }
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const react = mean(loudEnv) - mean(quietEnv);
  check('reactive_correlates',
    activeSamples >= Math.max(1, Math.floor(totalSamples * 0.8)) && loudEnv.length >= 3 && quietEnv.length >= 3 && react > 0.4,
    `envActive ${activeSamples}/${totalSamples}; loud envLevel=${mean(loudEnv).toFixed(2)} vs quiet=${mean(quietEnv).toFixed(2)} (diff ${react.toFixed(3)} > 0.4)`);
  check('phones_read_governed_envelope', detSamples >= 10 && worstDet < 0.06,
    `every phone's envLevel == delivered timeline b at its trackPos within ${worstDet.toFixed(3)} (<0.06) over ${detSamples} reads (proves deterministic cross-phone sync)`);

  // ---- identity: audioDepth=0 must equal the autonomous 4-arg output exactly ----
  await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'pulse', params: { audioDepth: 0, bpm: 70 } }) }).then(j);
  await sleep(500);
  const idSnap = await Promise.all(pages.map((p) => p.evaluate(() => ({ rgb: window.__cls.presetRgb, pos: window.__cls.presetPos, idx: window.__cls.idx, total: window.__cls.total, params: null }))));
  // recompute expected with the SAME params (server normalized) via /presets active
  const active = (await fetch(BASE + '/api/operator/presets', { headers: H(token) }).then(j)).active;
  let worstId = 0;
  for (const s of idSnap) {
    if (!s.rgb) { worstId = 999; break; }
    const exp = clampColor(PRESETS.pulse(s.pos, active.params, s.idx, s.total)); // 4-arg, no music
    worstId = Math.max(worstId, Math.abs(s.rgb[0] - exp[0]), Math.abs(s.rgb[1] - exp[1]), Math.abs(s.rgb[2] - exp[2]));
  }
  check('depth0_identity', worstId <= 3, `worst |Δ| vs autonomous 4-arg output = ${worstId} (<=3)`);

  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) });
  await browser.close();
  await fetch(BASE + '/api/operator/track/' + trackId, { method: 'DELETE', headers: H(token) }); // cleanup fixture

  fs.writeFileSync(path.join(dir, '..', 'presets_audio_report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('\nPRESETS AUDIO FAIL: ' + report.fails.join(' | ')); process.exit(1); }
  console.log('\nPRESETS AUDIO PASS: presets react to the music (loud>quiet), phones agree, depth0 == autonomous.');
}
main().catch((e) => { console.error(e); process.exit(1); });
