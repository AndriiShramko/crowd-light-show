// ROUND 9 — operator-console audio sync (Andrii's bug #7). The console's LIGHTS were always
// synced; the SOUND was started by a bare setTimeout(LEAD) that ignored clock.offset+nudge, so
// the console's monitor drifted from the on-air audio by exactly offset+nudge. Fix: the console
// plays through AudioSync.start(T0) on the SAME show clock as the phones.
//
// Proof: a phone opts into audio and the operator runs the same track. We read the SCHEDULED
// show-instant of each (AudioSync telemetry) and assert they agree <=50ms — at a non-zero NUDGE,
// which the old setTimeout ignored entirely (so it would have been ~|nudge| ms off).
// HONEST: this is a schedule instant, not acoustics (the operator still hears their own speaker;
// the real-room check is a 2-phone clap test).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3009';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  const op = (p, o = {}) => fetch(BASE + p, { ...o, headers: { Authorization: 'Bearer ' + token, ...(o.headers || {}) } });

  // ensure a DONE, licence-attested track (phones may only fetch /api/audience/audio if attested)
  let state = await op('/api/operator/state').then(j);
  let track = (state.tracks || []).find((t) => t.analysis_status === 'done');
  if (!track) {
    const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
    await op('/api/operator/upload', { method: 'POST', body: fd }).then(j);
    state = await op('/api/operator/state').then(j); track = state.tracks.find((t) => t.analysis_status === 'done');
  }
  await op(`/api/operator/track/${track.id}/attest`, { method: 'POST' });
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;

  const b = await chromium.launch();
  const opCtx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS } });
  const opPage = await opCtx.newPage();
  const opErr = []; opPage.on('pageerror', (e) => opErr.push(e.message));
  await opPage.goto(BASE + '/operator');
  await opPage.waitForSelector('[data-arm]', { timeout: 12000 });

  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?s=${code}&auto=1&audio=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 });

  async function runAt(nudgeMs) {
    // set the operator nudge slider (drives the JS nudge var used in T0 = ...+nudge)
    await opPage.evaluate((n) => { const el = document.getElementById('nudge'); el.value = String(n); el.dispatchEvent(new Event('input')); }, nudgeMs);
    await opPage.click('[data-arm]');
    await opPage.waitForTimeout(2500);          // allow AudioSync to fetch+decode on the arm gesture
    await opPage.click('#go');
    await opPage.waitForTimeout(2500);          // let the running-state echo schedule audio on both
    const o = await opPage.evaluate(() => window.__opAudio ? { si: window.__opAudio.scheduledShowInstant, T0: window.__opAudio.T0, ready: window.__opAudio.ready } : null);
    const p = await ph.evaluate(() => window.__cls && window.__cls.audio ? { si: window.__cls.audio.scheduledShowInstant, scheduled: window.__cls.audio.scheduled } : null);
    await opPage.click('#stop');
    await opPage.waitForTimeout(600);
    return { nudgeMs, o, p };
  }

  const r0 = await runAt(0);
  const r200 = await runAt(200);
  await b.close();

  const diff = (r) => (r.o && r.p && Number.isFinite(r.o.si) && Number.isFinite(r.p.si)) ? Math.abs(r.o.si - r.p.si) : NaN;
  const d0 = diff(r0), d200 = diff(r200);
  // |operator T0 - operator scheduled instant|: the console honored the FULL nudged T0. The old
  // bare-setTimeout path would have been ~|nudge| ms away from T0 (it ignored offset+nudge).
  const opVsT0_200 = (r200.o && Number.isFinite(r200.o.si) && Number.isFinite(r200.o.T0)) ? Math.abs(r200.o.si - r200.o.T0) : NaN;

  check('no_operator_js_errors', opErr.length === 0, opErr.join(' | '));
  check('console_audio_scheduled', !!(r0.o && r0.o.ready) && !!(r200.o && r200.o.ready), 'ready');
  check('phone_audio_scheduled', !!(r0.p && r0.p.scheduled) && !!(r200.p && r200.p.scheduled), 'scheduled');
  check('sync_at_nudge0', d0 <= 50, 'diff=' + Math.round(d0) + 'ms');
  check('sync_at_nudge200', d200 <= 50, 'diff=' + Math.round(d200) + 'ms (old setTimeout would be ~200ms off)');
  check('console_honors_nudge', opVsT0_200 <= 50, 'console scheduled at T0 (incl +200 nudge), |op-T0|=' + Math.round(opVsT0_200) + 'ms');

  const report = { base: BASE, nudge0: { diffMs: Math.round(d0), op: r0.o, phone: r0.p }, nudge200: { diffMs: Math.round(d200), op: r200.o, phone: r200.p, opVsT0Ms: Math.round(opVsT0_200) }, note: 'scheduled-instant agreement (schedule, not acoustics). A non-zero nudge proves the console now honors offset+nudge — the old setTimeout did not.', fails };
  fs.writeFileSync(path.join(dir, '..', 'audio_operator_sync_report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (fails.length) { console.error('AUDIO OPERATOR SYNC FAIL:', fails.join('; ')); process.exit(1); }
  console.log(`AUDIO OPERATOR SYNC PASS: console audio == phones <=50ms at nudge 0 (${Math.round(d0)}ms) and 200 (${Math.round(d200)}ms); console honored the nudged T0 the old setTimeout ignored.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
