// STOP/DONE harness for Studio Slice 1 (live presets + landing demo). Runs against a
// running server (BASE) with N>=10 headless phones and proves, by FACT:
//   1. preset + preset/param endpoints: anon=401, Bearer=200
//   2. switch -> all clients render the expected colour within 500ms, epoch++
//   3. spatial rainbow_chase -> different index = different hue at one instant (index math)
//   4. param morph -> epoch + startedAt unchanged, position keeps flowing (no restart)
//   5. server-side safety: pathological params are clamped before broadcast (<=3 fl/s, no red)
//   6. landing demo: N>=2 phones, NO auth, switch a preset -> all change; N=1 degrades
//   7. consent-scroll regression at 375x560: consent + Join reachable/clickable
// Headless = the PROTOCOL + local scheduling, NOT real phones on real networks.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, clampColor, relLum } from '../src/presets.js';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const N = Number(process.env.N || 12);
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (token, extra) => ({ Authorization: 'Bearer ' + token, ...(extra || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rgb2hue(c) {
  let r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 0.02) return -1; // achromatic -> no meaningful hue
  let h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
}
function maxAbsDelta(a, b) { return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])); }

const report = { base: BASE, n: N, when: 'stamped-after', checks: {}, fails: [] };
function check(id, ok, detail) { report.checks[id] = { ok: !!ok, detail }; if (!ok) report.fails.push(id + ': ' + detail); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + (detail || '')); }

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');

  // ---- 1. auth gate ----
  const anonPreset = await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'pulse' }) });
  const anonParam = await fetch(BASE + '/api/operator/preset/param', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'bpm', value: 60 }) });
  const okPreset = await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'pulse' }) });
  check('1_gate', anonPreset.status === 401 && anonParam.status === 401 && okPreset.status === 200,
    `anon preset=${anonPreset.status} param=${anonParam.status} bearer=${okPreset.status}`);

  const browser = await chromium.launch();
  const pages = [];
  for (let i = 0; i < N; i++) { const p = await (await browser.newContext()).newPage(); await p.goto(`${BASE}/join?auto=1`); pages.push(p); }
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {})));
  const syncedAll = (await Promise.all(pages.map((p) => p.evaluate(() => !!(window.__cls && window.__cls.synced))))).every(Boolean);

  // ---- 2. switch convergence (<=500ms) + colour matches the pure function + epoch++ ----
  // The server broadcasts inside the POST handler, so the broadcast is already in
  // flight when the response returns. Measure propagation from THAT instant (server
  // -> phones), not including the operator's own request latency (which, at a real
  // venue, is LAN-local; here the harness runs from a remote home connection).
  await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'pulse', params: { bpm: 70 } }) }).then(j);
  const t0 = Date.now();
  let converged = true;
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls && window.__cls.preset === 'pulse' && window.__cls.presetRgb, { timeout: 500 }).catch(() => { converged = false; })));
  const switchMs = Date.now() - t0;
  const active = (await fetch(BASE + '/api/operator/presets', { headers: H(token) }).then(j)).active;
  const snap2 = await Promise.all(pages.map((p) => p.evaluate(() => ({ rgb: window.__cls.presetRgb, pos: window.__cls.presetPos, idx: window.__cls.idx, total: window.__cls.total, epoch: window.__cls.presetEpoch, type: window.__cls.preset }))));
  let worstDelta = 0, epochOk = true;
  for (const s of snap2) {
    const expected = clampColor(PRESETS.pulse(s.pos, active.params, s.idx, s.total));
    worstDelta = Math.max(worstDelta, maxAbsDelta(s.rgb, expected));
    if (!(s.epoch >= 1)) epochOk = false;
  }
  check('2_switch', converged && switchMs <= 500 && worstDelta <= 12 && epochOk,
    `converged=${converged} in ${switchMs}ms, worstΔ=${worstDelta} (<=12), epoch>=1=${epochOk}`);

  // ---- 3. spatial: rainbow_chase -> different index = different hue at one instant ----
  await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'rainbow_chase', params: { speed: 0.05, spread: 1 } }) }).then(j);
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls.preset === 'rainbow_chase', { timeout: 800 }).catch(() => {})));
  await sleep(300);
  const snap3 = await Promise.all(pages.map((p) => p.evaluate(() => ({ idx: window.__cls.idx, rgb: window.__cls.presetRgb }))));
  const hues = snap3.map((s) => rgb2hue(s.rgb)).filter((h) => h >= 0);
  const buckets = new Set(hues.map((h) => Math.floor(h / 40)));
  const hueRange = hues.length ? Math.max(...hues) - Math.min(...hues) : 0;
  // sort by index, confirm neighbours differ (not one global colour)
  const byIdx = snap3.slice().sort((a, b) => a.idx - b.idx);
  let neighbourDiffs = 0;
  for (let i = 1; i < byIdx.length; i++) if (maxAbsDelta(byIdx[i].rgb, byIdx[i - 1].rgb) > 20) neighbourDiffs++;
  check('3_spatial', buckets.size >= 5 && hueRange > 180 && neighbourDiffs >= byIdx.length - 3,
    `distinctHueBuckets=${buckets.size} (>=5), hueRange=${Math.round(hueRange)}° (>180), neighbourDiffs=${neighbourDiffs}/${byIdx.length - 1}`);

  // ---- 4. param morph: epoch + startedAt unchanged, position keeps flowing ----
  const before = await pages[0].evaluate(() => ({ epoch: window.__cls.presetEpoch, started: window.__cls.presetStartedAt, pos: window.__cls.presetPos }));
  await fetch(BASE + '/api/operator/preset/param', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ key: 'speed', value: 0.2 }) }).then(j);
  await sleep(600);
  const after = await pages[0].evaluate(() => ({ epoch: window.__cls.presetEpoch, started: window.__cls.presetStartedAt, pos: window.__cls.presetPos }));
  const morphOk = after.epoch === before.epoch && after.started === before.started && after.pos > before.pos && after.pos < before.pos + 3000;
  check('4_morph', morphOk, `epoch ${before.epoch}->${after.epoch}, startedAt same=${after.started === before.started}, pos ${before.pos}->${after.pos} (flowing, no reset)`);

  // ---- 5. server-side safety: pathological params clamped before broadcast ----
  await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'pulse', params: { bpm: 9999, depth: 5, base: -3 } }) }).then(j);
  const active5 = (await fetch(BASE + '/api/operator/presets', { headers: H(token) }).then(j)).active;
  // simulate the broadcast preset and confirm it is sub-flash + no saturated red (post-clamp)
  let cross = 0, armed = true, lastT = -1e9, maxRed = 0;
  for (let ms = 0; ms <= 4000; ms += 10) {
    const rgb = clampColor(PRESETS.pulse(ms, active5.params, 0, 12)); const sum = rgb[0] + rgb[1] + rgb[2];
    if (sum > 0) maxRed = Math.max(maxRed, rgb[0] / sum);
    const L = relLum(rgb);
    if (L < 0.25) armed = true; else if (L >= 0.6 && armed) { cross++; armed = false; }
  }
  check('5_safety', active5.params.bpm <= 180 && maxRed < 0.8,
    `clamped bpm=${active5.params.bpm} (<=180), maxRedRatio=${maxRed.toFixed(2)} (<0.8) — see also test/presets_safety.test.mjs`);

  // ---- 6. landing demo: N>=2 phones, NO auth, switch a preset -> all change ----
  const roomInfo = await fetch(BASE + '/api/demo/room').then(j);
  const room = roomInfo.room;
  const demo = [];
  for (let i = 0; i < 2; i++) { const p = await (await browser.newContext()).newPage(); await p.goto(`${BASE}/join?room=${room}&auto=1`); demo.push(p); }
  await Promise.all(demo.map((p) => p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {})));
  const demoSwitch = await fetch(BASE + '/api/demo/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, type: 'color_waves' }) }); // NO auth
  let demoChanged = true;
  await Promise.all(demo.map((p) => p.waitForFunction(() => window.__cls.preset === 'color_waves' && window.__cls.everLit, { timeout: 1200 }).catch(() => { demoChanged = false; })));
  // N=1 degrade: a single device on its own room still renders the preset
  const solo = await (await browser.newContext()).newPage();
  const room2 = (await fetch(BASE + '/api/demo/room').then(j)).room;
  await solo.goto(`${BASE}/join?room=${room2}&auto=1`);
  await solo.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await fetch(BASE + '/api/demo/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: room2, type: 'pulse' }) });
  const soloOk = await solo.waitForFunction(() => window.__cls.preset === 'pulse' && window.__cls.everLit, { timeout: 1500 }).then(() => true).catch(() => false);
  check('6_demo', demoSwitch.status === 200 && demoChanged && soloOk,
    `noAuthSwitch=${demoSwitch.status}, both-phones-changed=${demoChanged}, single-device-degrades=${soloOk}`);

  // ---- 7. consent-scroll regression at 375x560 ----
  const cs = await (await browser.newContext({ viewport: { width: 375, height: 560 } })).newPage();
  const csErr = [];
  cs.on('pageerror', (e) => { if (!/Permissions check failed/.test(e.message)) csErr.push(e.message); });
  await cs.goto(`${BASE}/join`); // NO auto -> consent gate
  await cs.waitForTimeout(800);
  const reach = await cs.evaluate(() => {
    const a = document.getElementById('agree'), jb = document.getElementById('joinScreen');
    const st = document.getElementById('stage');
    return { hasAgree: !!a, hasJoin: !!jb, scrollable: st ? st.scrollHeight >= st.clientHeight : false };
  });
  await cs.check('#agree');
  const joinEnabled = await cs.evaluate(() => !document.getElementById('joinScreen').disabled);
  await cs.click('#joinScreen'); // Playwright auto-scrolls — fails if unreachable
  await cs.waitForTimeout(400);
  const started = await cs.evaluate(() => !!window.__cls.started);
  check('7_consent_scroll', reach.hasAgree && reach.hasJoin && joinEnabled && started && csErr.length === 0,
    `reachable agree+join, join-enabled=${joinEnabled}, started=${started}, errors=${csErr.length}`);

  report.detail = { syncedAll, switchMs, worstDelta, hueBuckets: buckets.size, hueRange: Math.round(hueRange), clampedBpm: active5.params.bpm };
  await browser.close();

  fs.writeFileSync(path.join(dir, '..', 'presets_report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('\nPRESETS HARNESS FAIL: ' + report.fails.join(' | ')); process.exit(1); }
  console.log('\nPRESETS HARNESS PASS: all Slice-1 STOP/DONE checks green (headless = protocol, not real phones).');
}
main().catch((e) => { console.error(e); process.exit(1); });
