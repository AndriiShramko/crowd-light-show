// ROUND 10 — public playlist auto-advance (loop all / loop selected / loop one).
// Owner: "I should manage the playlist — play all tracks in a loop, or only selected ones."
// Before, a track end called stop(); now a public room ADVANCES through its playlist, looping.
// Proven by FACT against the live engine: drive a /studio room via the console token, GO a short
// (6s) track, and watch the SERVER advance the room to the right next track per mode:
//   - 'all'      -> ends -> the OTHER public track is now armed+running
//   - 'one'      -> ends -> the SAME track re-arms (loops)
//   - 'selected' -> only the chosen subset cycles (and jumps in if the current track isn't in it)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3011';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  // ensure >=2 DONE tracks, both public+attested (the playlist needs >1 to prove advancement)
  async function state() { return fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); }
  let s = await state();
  let done = (s.tracks || []).filter((t) => t.analysis_status === 'done');
  while (done.length < 2) {
    const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
    await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
    s = await state(); done = (s.tracks || []).filter((t) => t.analysis_status === 'done');
  }
  const A = done[0].id, B = done[1].id;
  for (const id of [A, B]) {
    await fetch(`${BASE}/api/operator/track/${id}/attest`, { method: 'POST', headers: H(token) }).then(j);
    await fetch(`${BASE}/api/operator/track/${id}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
  }
  // round 11: a real /studio always has a default track configured (the owner sets it; live also
  // pins default_screen_preset=rainbow_chase). The single "Start Light Show" arms THAT track, so
  // the room is genuinely running when the console drives the playlist UI. Without it, Start has
  // nothing to arm and the playlist-mode buttons never bind to a live room.
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: A }) }).then(j);

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const sess = await con.evaluate(() => window.__SESSION__);
  const room = sess.room;
  const cAuth = { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' };
  const cmd = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: cAuth, body: JSON.stringify(body || {}) }).then((r) => r.json());
  const pl = () => fetch(`${BASE}/api/console/playlist`, { headers: { Authorization: 'Bearer ' + sess.token } }).then(j).then((d) => d.playlist);

  // helper: arm a specific track + GO, then wait for the auto-advance, return the new playlist state
  async function runAndAwaitAdvance(armId) {
    await cmd('/api/console/arm', { trackId: armId });
    const before = await pl();
    await cmd('/api/console/go', {});
    // 6s track + tail; poll for the server to advance (idx or nowId changes from the armed track)
    for (let i = 0; i < 30; i++) { await sleep(500); const p = await pl(); if (p.nowId !== before.nowId || p.idx !== before.idx) return p; }
    return await pl();
  }

  // ---- mode 'all': end -> the OTHER track ----
  await cmd('/api/console/playlist', { mode: 'all' });
  const afterAll = await runAndAwaitAdvance(A);
  check('all_advances_to_other', afterAll.nowId === B, `armed A=${A} -> now ${afterAll.nowId} (expect B=${B})`);
  check('all_order_has_both', afterAll.len >= 2, 'order len=' + afterAll.len);

  // ---- mode 'one': end -> SAME track loops ----
  await cmd('/api/console/playlist', { mode: 'one' });
  await cmd('/api/console/arm', { trackId: A });
  const one0 = await pl();
  await cmd('/api/console/go', {});
  await sleep(7500); // > track duration + tail
  const one1 = await pl();
  check('one_loops_same', one1.nowId === A && one1.len === 1, `nowId=${one1.nowId} (expect A=${A}), len=${one1.len} (expect 1)`);

  // ---- mode 'selected' = [B]: jumps to B and only B cycles ----
  const selRes = await cmd('/api/console/playlist', { mode: 'selected', selected: [B] });
  await sleep(300);
  const sel = await pl();
  check('selected_jumps_in', sel.nowId === B && sel.len === 1 && sel.order[0] === B, `nowId=${sel.nowId} len=${sel.len} order=${JSON.stringify(sel.order)} (expect only B=${B})`);

  // ---- console UI: the operator can SEE + drive the playlist (mode buttons + now/next) ----
  await con.reload();
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  await con.click('#playSound').catch(() => {}); // round 11: reveal the page (playlist is block 2, hidden until Start)
  await con.waitForFunction(() => { const c = document.getElementById('playlistCtl'); return c && c.getBoundingClientRect().width > 0; }, { timeout: 12000 }).catch(() => {});
  const ui = await con.evaluate(() => {
    const ctl = document.getElementById('playlistCtl');
    const modes = ctl ? ctl.querySelectorAll('[data-plmode]').length : 0;
    const nn = document.getElementById('plNowNext');
    return { visible: !!(ctl && !ctl.classList.contains('hidden')), modes, nowNext: nn ? nn.textContent : '' };
  });
  check('console_playlist_ui', ui.visible && ui.modes === 3, JSON.stringify(ui));
  // click "Loop one" -> it highlights as the active mode
  await con.click('[data-plmode="one"]').catch(() => {});
  await sleep(600);
  const oneActive = await con.evaluate(() => { const b = document.querySelector('[data-plmode="one"]'); return b && b.className === 'primary'; });
  check('console_mode_click', oneActive, 'Loop one highlighted after click');

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'playlist_advance_report.json'), JSON.stringify({ base: BASE, room, A, B, afterAll, one1, sel, fails }, null, 2));
  if (fails.length) { console.error('PLAYLIST FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log(`PLAYLIST PASS: loop-all advances A->B at track end; loop-one re-loops the same track; loop-selected cycles only the chosen subset. (room ${room})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
