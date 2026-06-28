// SAME-MODEL phone audio sync (the case the user actually has: nearby identical phones,
// built-in speakers, NO Bluetooth). With compensation OFF by default, every phone schedules
// the buffer CURSOR on the synced show clock, so identical devices lock — INDEPENDENT of the
// (noisy) reported output latency. Proven by FACT: inject the SAME outputLatency on every
// page, do NOT opt into compensation, and assert cross-phone CURSOR agreement (==T0, tight),
// compMs==0, and no playbackRate wobble over time. Run with two latency values to prove the
// result doesn't depend on the latency. WAV so headless can decode.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const N = Number(process.env.N || 6);
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function percentile(arr, p) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }

async function runOnce(token, code, fakeLatMs) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const pages = [];
  for (let i = 0; i < N; i++) {
    const p = await (await browser.newContext()).newPage();
    await p.addInitScript((ms) => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        Object.defineProperty(AC.prototype, 'outputLatency', { get() { return ms / 1000; }, configurable: true });
        Object.defineProperty(AC.prototype, 'baseLatency', { get() { return 0.005; }, configurable: true });
      }
      // SAME latency on every page (identical model) and NO __forceLatComp -> default (no comp)
    }, fakeLatMs);
    await p.goto(`${BASE}/join?s=${code}&auto=1&audio=1`);
    pages.push(p);
  }
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {})));
  const decoded = await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls.audio && window.__cls.audio.ready, { timeout: 20000 }).then(() => true).catch(() => false)));
  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  const scheduledAll = await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls.audio && window.__cls.audio.scheduled, { timeout: 8000 }).then(() => true).catch(() => false)));
  const snap1 = await Promise.all(pages.map((p) => p.evaluate(() => ({ ...window.__cls.audio }))));
  await sleep(4000); // ~4 more drift ticks — catch any playbackRate wobble / drift growth
  const snap2 = await Promise.all(pages.map((p) => p.evaluate(() => ({ driftMs: window.__cls.audio.driftMs, rate: window.__cls.audio.rate }))));
  await browser.close();

  const cur = snap1.map((a) => a && a.scheduledShowInstant).filter(Number.isFinite);
  const cPair = [];
  for (let i = 0; i < cur.length; i++) for (let k = i + 1; k < cur.length; k++) cPair.push(Math.abs(cur[i] - cur[k]));
  return {
    fakeLatMs, decodedAll: decoded.every(Boolean), scheduledAll: scheduledAll.every(Boolean),
    curP95: Math.round(percentile(cPair, 95)), curMax: Math.round(cPair.length ? Math.max(...cPair) : 0),
    curFromT0: Math.round(Math.max(...snap1.map((a) => (a && Number.isFinite(a.scheduledShowInstant) && Number.isFinite(a.T0)) ? Math.abs(a.scheduledShowInstant - a.T0) : Infinity))),
    noComp: snap1.every((a) => a && (a.compMs === 0 || a.compMs == null)),
    rateExcursion: Math.max(...snap2.map((s) => Math.abs((s.rate == null ? 1 : s.rate) - 1))),
    driftGrowth: Math.round(Math.max(...snap2.map((s, i) => Math.abs((s.driftMs || 0) - (snap1[i].driftMs || 0))))),
  };
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  await fetch(BASE + '/api/operator/track/' + up.trackId + '/attest', { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: up.trackId }) }).then(j);

  const a = await runOnce(token, (await fetch(BASE + '/api/public/show').then(j)).code, 15);
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) });
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: up.trackId }) }).then(j);
  const b = await runOnce(token, (await fetch(BASE + '/api/public/show').then(j)).code, 90);

  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) });
  await fetch(BASE + '/api/operator/track/' + up.trackId, { method: 'DELETE', headers: H(token) });

  const report = { base: BASE, clients: N, run_lat15: a, run_lat90: b, latencyIndependenceMs: Math.abs(a.curFromT0 - b.curFromT0),
    note: 'compensation OFF by default => cursor==show clock => identical phones lock regardless of reported outputLatency. The result must NOT change between injected latency 15ms and 90ms (latency-independence). Headless proves the scheduling math; real acoustics need 2 real phones.' };
  fs.writeFileSync(path.join(dir, '..', 'audio_samemodel_report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const fails = [];
  for (const r of [a, b]) {
    if (!r.decodedAll) fails.push(`[lat${r.fakeLatMs}] not all decoded`);
    if (!r.scheduledAll) fails.push(`[lat${r.fakeLatMs}] not all scheduled`);
    if (!r.noComp) fails.push(`[lat${r.fakeLatMs}] compensation applied despite default-off (compMs!=0)`);
    if (r.curP95 > 6) fails.push(`[lat${r.fakeLatMs}] cursor cross-phone p95 ${r.curP95}ms > 6`);
    if (r.curMax > 10) fails.push(`[lat${r.fakeLatMs}] cursor cross-phone max ${r.curMax}ms > 10`);
    if (r.curFromT0 > 6) fails.push(`[lat${r.fakeLatMs}] cursor != T0 (worst ${r.curFromT0}ms) — not on show clock`);
    if (r.rateExcursion > 0.0005) fails.push(`[lat${r.fakeLatMs}] playbackRate wobble ${r.rateExcursion} — corrector chasing`);
    if (r.driftGrowth > 15) fails.push(`[lat${r.fakeLatMs}] drift grew ${r.driftGrowth}ms — instability`);
  }
  if (report.latencyIndependenceMs > 3) fails.push(`cursor depends on latency value (Δ ${report.latencyIndependenceMs}ms > 3) — comp leaked in`);
  if (fails.length) { console.error('SAME-MODEL FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log(`SAME-MODEL PASS: identical phones lock the CURSOR on the show clock (==T0, p95 ${a.curP95}/${b.curP95}ms), independent of injected latency (Δ ${report.latencyIndependenceMs}ms), no playbackRate wobble. (Headless=math; real acoustics need 2 phones.)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
