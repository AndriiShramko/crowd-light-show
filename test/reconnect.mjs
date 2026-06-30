// ROUND 11 — phase D robustness: auto-reconnect + crash-guards (owner pts 12,13).
// Before: ws.onclose did NOTHING (phones stayed dead after a network blip); the 20s pinger was
// created per-onopen (stacked on every reconnect); __cls.flashes grew unbounded (OOM); no global
// error guards. Proven here with Playwright context.setOffline (simulates the radio drop):
//   - drop+return -> phone auto-reconnects and the server rehydrates the running show
//   - offline -> bounded exponential backoff (no 80ms/20ms storm), page stays responsive, no error flood
//   - singleton timers + single rAF loop survive many offline/online cycles
//   - flash ring-buffer is capped (no unbounded growth) ; mute with no audio never throws
// Real-radio crash repro is operator-verified; this proves the mechanisms that cause it are gone.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3030';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  // ensure a done+attested track, arm + GO the MAIN show so the joined phone has a running show to recover
  let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let tr = (st.tracks || []).find((t) => t.analysis_status === 'done');
  if (!tr) {
    const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
    await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
    st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); tr = st.tracks.find((t) => t.analysis_status === 'done');
  }
  await fetch(BASE + `/api/operator/track/${tr.id}/attest`, { method: 'POST', headers: H(token) }).then(j);
  // a live PRESET (indefinite) is the recoverable state we test — a 6s track would just end.
  await fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'pulse', params: {} }) }).then(j);
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;

  const b = await chromium.launch();
  const ctx = await b.newContext();
  const perr = []; const p = await ctx.newPage(); p.on('pageerror', (e) => perr.push(e.message));
  await p.goto(`${BASE}/join?s=${code}&auto=1`);
  await p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 });
  await p.waitForFunction(() => window.__cls.everLit, { timeout: 8000 }).catch(() => {});

  // ---- T1: socket drop (radio loss) -> auto-reconnect + the server rehydrates the live preset ----
  await p.evaluate(() => window.__clsDropWs());
  const back = await p.waitForFunction(() => window.__cls.synced && window.__cls.reconnects >= 1, { timeout: 12000 }).then(() => true).catch(() => false);
  await sleep(500);
  const after = await p.evaluate(() => ({ synced: window.__cls.synced, rec: window.__cls.reconnects, preset: window.__cls.screen.preset, wsState: window.__cls.wsState }));
  check('reconnect_after_drop', back && after.synced && after.rec >= 1 && after.wsState === 1, JSON.stringify(after));
  check('rehydrated_preset', after.preset === 'pulse', 'preset after reconnect=' + after.preset);

  // ---- T2: drop WHILE offline -> bounded backoff (no storm), responsive, no error flood ----
  await ctx.setOffline(true);
  await p.evaluate(() => window.__clsDropWs());        // kill the socket; reconnect attempts will now fail (offline)
  const a0 = await p.evaluate(() => window.__cls.connectAttempts);
  await sleep(10000);
  const a1 = await p.evaluate(() => ({ att: window.__cls.connectAttempts, err: window.__cls.errors, ticks: window.__cls.ticks, timers: window.__cls.timers }));
  check('backoff_bounded', (a1.att - a0) < 25, `attempts grew ${a1.att - a0} in 10s (expect <25 logarithmic)`);
  check('no_error_storm_offline', a1.err < 8, 'errors=' + a1.err);
  check('page_responsive_offline', (await p.evaluate(() => 1 + 1)) === 2, 'evaluate returns');
  await ctx.setOffline(false);
  await p.waitForFunction(() => window.__cls.synced, { timeout: 12000 }).catch(() => {});

  // ---- T6: many drop cycles -> ONE render loop + singleton timers ----
  for (let i = 0; i < 3; i++) { await p.evaluate(() => window.__clsDropWs()); await sleep(900); await p.waitForFunction(() => window.__cls.synced, { timeout: 12000 }).catch(() => {}); }
  const tt1 = await p.evaluate(() => window.__cls.ticks); await sleep(1000); const tt2 = await p.evaluate(() => window.__cls.ticks);
  const timers = await p.evaluate(() => window.__cls.timers);
  check('single_render_loop', (tt2 - tt1) > 20 && (tt2 - tt1) < 240, 'ticks/sec=' + (tt2 - tt1));
  check('timers_singleton', timers <= 1, 'active module timers=' + timers);

  // ---- T5: flash ring-buffer cap ----
  const cap = await p.evaluate(() => { const b0 = window.__cls.flashCount; for (let i = 0; i < 250; i++) window.__clsRecordFlash(0, i); return { len: window.__cls.flashes.length, count: window.__cls.flashCount - b0 }; });
  check('flash_ring_capped', cap.len <= 200 && cap.count === 250, JSON.stringify(cap));

  // ---- T4: mute with no audio (main show, audio opt-in not enabled) never throws ----
  const me = []; p.on('pageerror', (e) => me.push(e.message));
  await p.evaluate(() => { window.__clsToggleMute(); window.__clsToggleMute(); });
  await sleep(200);
  check('mute_no_audio_safe', me.length === 0, me.join(' | '));

  check('no_pageerror_overall', perr.length === 0, perr.slice(0, 3).join(' | '));
  await b.close();

  fs.writeFileSync(path.join(dir, '..', 'reconnect_report.json'), JSON.stringify({ base: BASE, after, a1, cap, timers, fails }, null, 2));
  if (fails.length) { console.error('RECONNECT FAIL:', fails.join('; ')); process.exit(1); }
  console.log('RECONNECT PASS: auto-reconnect+rehydrate after a drop, bounded backoff (no storm), single render loop + singleton timers across cycles, flash ring capped, mute-no-audio safe.');
}
main().catch((e) => { console.error(e); process.exit(1); });
