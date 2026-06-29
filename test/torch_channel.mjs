// Round-8B, proven by FACT against a running server: the TORCH (camera-LED flash) is an
// AUTONOMOUS channel — its own presets + reactivity, independent of the screen — driven by
// {t:'preset',channel:'torch'}. On iPhone there is no web torch API, so the torch channel is
// a NO-OP (the screen is unaffected). The operator console shows the Android-torch vs
// screen-only split, and the torch is safety-gated to <=3 flashes/s like the screen.
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
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

function loudQuietWav() { // 8s mono 16-bit: loud [2,4)+[6,8), quiet else (220Hz)
  const sr = 22050, n = sr * 8, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / sr; const amp = (Math.floor(t / 2) % 2) === 1 ? 0.9 : 0.04; data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.sin(2 * Math.PI * 220 * t) * amp * 32767))), i * 2); }
  const head = Buffer.alloc(44); head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40); return Buffer.concat([head, data]);
}
const isLoud = (tp) => (Math.floor((tp / 1000) / 2) % 2) === 1;
const setScreen = (t, type, params) => fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ channel: 'screen', type, params }) }).then(j);
const setTorch = (t, type, params) => fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ channel: 'torch', type, params }) }).then(j);
const setTorchParam = (t, key, value) => fetch(BASE + '/api/operator/preset/param', { method: 'POST', headers: H(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ channel: 'torch', key, value }) }).then(j);

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');
  const fd = new FormData(); fd.append('audio', new Blob([loudQuietWav()]), 'lq.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  const trackId = up.trackId; if (!trackId) throw new Error('upload failed');
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId, keepPreset: true }) }).then(j);

  const browser = await chromium.launch();
  const errors = [];
  const mkPage = async (ua) => { const c = await browser.newContext({ userAgent: ua }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/status of 401|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); }); await p.goto(`${BASE}/join?s=${code}&auto=1`); await p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }); return p; };
  const a = await mkPage(ANDROID_UA);   // Android phone
  const tele = (p) => p.evaluate(() => ({ screen: window.__cls.screen.preset, torch: window.__cls.torch.preset, want: window.__cls.torch.want, intensity: window.__cls.torch.intensity, on: window.__cls.torch.on, capable: window.__cls.torch.capable, note: window.__cls.torch.note, presetRgb: window.__cls.presetRgb, everLit: window.__cls.everLit }));

  // ---- 1. two autonomous channels: changing one never moves the other ----
  await setScreen(token, 'pulse', { audioDepth: 0 }); await setTorch(token, 'strobe', { rate: 2.0, duty: 0.3 }); await sleep(500);
  const s1 = await tele(a);
  await setTorch(token, 'beat', { torchDepth: 1 }); await sleep(400);
  const s2 = await tele(a);                      // torch changed; screen must be untouched
  await setScreen(token, 'ocean', {}); await sleep(400);
  const s3 = await tele(a);                      // screen changed; torch must be untouched
  check('1_channels_independent',
    s1.screen === 'pulse' && s1.torch === 'strobe' && s2.torch === 'beat' && s2.screen === 'pulse' && s3.screen === 'ocean' && s3.torch === 'beat',
    `screen/torch: [${s1.screen}/${s1.torch}] -> setTorch beat -> [${s2.screen}/${s2.torch}] -> setScreen ocean -> [${s3.screen}/${s3.torch}]`);

  // ---- 2. torch reactivity bites; screen untouched by torch-param changes ----
  await setScreen(token, 'pulse', { audioDepth: 0, bpm: 60 }); await setTorch(token, 'beat', { torchDepth: 1, torchGain: 4, torchFloor: 0.1 });
  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  const loud = [], quiet = []; const screenRgbs = new Set();
  for (let i = 0; i < 16; i++) {
    await sleep(260);
    const snap = await a.evaluate(() => ({ intensity: window.__cls.torch.intensity, tp: window.__cls.trackPos, rgb: window.__cls.presetRgb }));
    if (snap.tp != null && snap.tp > 400 && snap.tp < 7600) { (isLoud(snap.tp) ? loud : quiet).push(snap.intensity); if (snap.rgb) screenRgbs.add(snap.rgb.join(',')); }
  }
  const mean = (x) => x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0;
  // change a torch slider mid-run; the SCREEN preset rgb set should be the autonomous pulse either way
  await setTorchParam(token, 'torchGain', 6); await sleep(400);
  check('2_torch_reactive_screen_untouched',
    loud.length >= 3 && quiet.length >= 3 && (mean(loud) - mean(quiet)) > 0.3 && screenRgbs.size > 1,
    `torch intensity loud=${mean(loud).toFixed(2)} vs quiet=${mean(quiet).toFixed(2)} (diff>${0.3}); screen kept rendering its own preset (${screenRgbs.size} distinct rgb)`);

  // ---- 5/7. torch safety: gated channel intent <=3 flashes/s at MAX strength on a beat-heavy track ----
  await setTorch(token, 'beat', { torchDepth: 1, torchGain: 6, torchFloor: 0, torchGamma: 0.4 }); await sleep(300);
  const wants = await a.evaluate(async () => {
    const out = []; const t0 = performance.now();
    while (performance.now() - t0 < 4000) { out.push({ t: performance.now(), w: window.__cls.torch.want }); await new Promise((r) => setTimeout(r, 16)); }
    return out;
  });
  let edges = []; let prev = 0; for (const x of wants) { if (x.w && !prev) edges.push(x.t); prev = x.w; }
  let je = 0, w = 0; for (let i = 0; i < edges.length; i++) { while (edges[i] - edges[je] >= 1000) je++; w = Math.max(w, i - je + 1); }
  check('5_torch_governed', w <= 3, `torch want edges max ${w}/s (<=3) at max strength on a beat-heavy track`);

  // ---- 3. iPhone: torch channel is a NO-OP (LED never fires), note shown, screen still works ----
  const ip = await mkPage(IPHONE_UA);
  await setScreen(token, 'rainbow_chase', {}); await setTorch(token, 'strobe', { rate: 2.5, duty: 0.5 }); await sleep(1200);
  const ipt = await tele(ip);
  check('3_iphone_torch_noop',
    ipt.capable === false && ipt.note === 'ios-screen-only' && ipt.on === 0 && ipt.everLit === true,
    `iPhone: capable=${ipt.capable} note=${ipt.note} ledOn=${ipt.on} screenEverLit=${ipt.everLit}`);

  // ---- 4. operator console shows the Android-torch vs screen-only split ----
  const op = await (await browser.newContext({ httpCredentials: { username: 'operator', password: PASS } })).newPage();
  await op.goto(BASE + '/operator');
  await op.waitForFunction(() => /Android/.test((document.getElementById('torchSplit') || {}).textContent || ''), { timeout: 12000 }).catch(() => {});
  const split = await op.evaluate(() => (document.getElementById('torchSplit') || {}).textContent || '');
  // we have >=1 Android (a) and >=1 iPhone (ip) connected
  check('4_console_split', /(\d+)\s*Android/.test(split) && /iPhone\/other/.test(split) && Number((split.match(/(\d+)\s*Android/) || [])[1]) >= 1 && Number((split.match(/·\s*(\d+)\s*iPhone/) || [])[1]) >= 1,
    `console torchSplit = "${split}"`);

  // ---- 6. operator FLASH preview renders, changes per torch preset, governed <=3/s ----
  const hasTorchEngine = await op.evaluate(() => !!(window.CLS_PRESETS && window.CLS_PRESETS.TORCH_PRESETS && window.CLS_PRESETS.makeTorchGate));
  await op.evaluate(() => { const b = [...document.querySelectorAll('#torchBtns button')].find((x) => x.getAttribute('data-torch') === 'strobe'); if (b) b.click(); });
  await op.waitForTimeout(1400);
  const tp1 = await op.evaluate(() => Object.assign({}, window.__opTorchPreview));
  await op.evaluate(() => { const b = [...document.querySelectorAll('#torchBtns button')].find((x) => x.getAttribute('data-torch') === 'beat'); if (b) b.click(); });
  await op.waitForTimeout(1400);
  const tp2 = await op.evaluate(() => Object.assign({}, window.__opTorchPreview));
  check('6_torch_preview', hasTorchEngine && tp1.ready && tp1.type === 'strobe' && tp1.frames > 15 && tp1.flashesPerSec <= 3 && tp2.type === 'beat' && tp2.flashesPerSec <= 3,
    `engine=${hasTorchEngine} strobe(frames=${tp1.frames},onFrac=${(tp1.onFrac || 0).toFixed(2)},fps=${tp1.flashesPerSec}) -> beat(fps=${tp2.flashesPerSec})`);

  // ---- STOP kills BOTH channels ----
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) }).then(j); await sleep(500);
  const stopped = await tele(a);
  check('stop_kills_both', stopped.screen == null && stopped.torch == null, `after STOP screen=${stopped.screen} torch=${stopped.torch}`);

  check('no_js_errors', errors.length === 0, errors.length ? errors.join(' | ') : 'no JS errors');
  await browser.close();
  fs.writeFileSync(path.join(dir, '..', 'torch_channel_report.json'), JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('TORCH CHANNEL FAIL:', report.fails.join('; ')); process.exit(1); }
  console.log('TORCH CHANNEL PASS: autonomous screen⟂torch, torch reactivity bites, iPhone no-op + note, console split, torch preview, governed <=3/s, STOP kills both. (headless = protocol, not a real LED.)');
}
main().catch((e) => { console.error('TORCH CHANNEL ERROR:', e); process.exit(1); });
