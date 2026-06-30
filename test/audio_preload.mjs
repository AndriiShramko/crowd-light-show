// ROUND 11 — phase B pt 15: the phone PRELOADS (fetch+decode) the main-show track BEFORE the user
// taps "play music", and shows a "Connecting to music…" status — so the tap is instant and the user
// is never left waiting blankly. Decode needs no gesture (only resume/start do), so this is provable
// headless WITHOUT the autoplay override: a phone joins (no audio=1, no tap) and the buffer reaches
// 'ready' on its own; then a trusted click plays it WITHOUT a second fetch.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3030';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let tr = (st.tracks || []).find((t) => t.analysis_status === 'done');
  if (!tr) {
    const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
    await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
    st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); tr = st.tracks.find((t) => t.analysis_status === 'done');
  }
  await fetch(BASE + `/api/operator/track/${tr.id}/attest`, { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: tr.id }) }).then(j);
  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;

  // NO --autoplay-policy override: prove decode happens with no gesture (real-phone behavior).
  const b = await chromium.launch();
  const ctx = await b.newContext();
  let audioFetches = 0; ctx.on('request', (r) => { if (/\/api\/audience\/audio/.test(r.url())) audioFetches++; });
  const p = await ctx.newPage(); const perr = []; p.on('pageerror', (e) => perr.push(e.message));
  await p.goto(`${BASE}/join?s=${code}&auto=1`);   // joins, but does NOT opt into audio (no audio=1)
  await p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 });

  // the buffer should PRELOAD to 'ready' on its own (no tap), and the button reflect it.
  const ready = await p.waitForFunction(() => window.__cls.audio && window.__cls.audio.preload === 'ready', { timeout: 15000 }).then(() => true).catch(() => false);
  const pre = await p.evaluate(() => ({ preload: window.__cls.audio.preload, ready: window.__cls.audio.ready, lightsOnly: window.__cls.audio.lightsOnly, wanted: window.__cls.audio.wanted, btn: (document.getElementById('audioBtn') || {}).textContent, disabled: (document.getElementById('audioBtn') || {}).disabled }));
  check('preloaded_before_tap', ready && pre.preload === 'ready' && pre.ready === true, JSON.stringify(pre));
  check('not_yet_opted_in', pre.wanted === false, 'wanted=' + pre.wanted + ' (audio not started until the tap)');
  check('btn_tappable_when_ready', pre.disabled === false && !/Connecting/i.test(pre.btn || ''), 'btn="' + pre.btn + '"');
  check('one_fetch_preload', audioFetches === 1, 'audience/audio fetches before tap=' + audioFetches);

  // a trusted tap resumes + plays from the decoded buffer WITHOUT a second fetch
  await p.click('#audioBtn').catch(() => {});
  await p.waitForTimeout(800);
  const afterTap = await p.evaluate(() => ({ wanted: window.__cls.audio.wanted, scheduled: window.__cls.audio.scheduled }));
  check('no_refetch_on_tap', audioFetches === 1, 'fetches after tap=' + audioFetches + ' (must stay 1 — reused the preloaded buffer)');
  check('tap_opted_in', afterTap.wanted === true, JSON.stringify(afterTap));
  check('no_pageerror', perr.length === 0, perr.slice(0, 2).join(' | '));
  await b.close();

  fs.writeFileSync(path.join(dir, '..', 'audio_preload_report.json'), JSON.stringify({ base: BASE, pre, afterTap, audioFetches, fails }, null, 2));
  if (fails.length) { console.error('AUDIO PRELOAD FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('AUDIO PRELOAD PASS: the main-show track fetch+decodes BEFORE the tap (status shown), and the tap plays from the preloaded buffer with no second fetch.');
}
main().catch((e) => { console.error(e); process.exit(1); });
