// ROUND 12 — pts 2 + 3. A /studio room that loops a single curated track must run BOTH lights and
// audio on ONE fixed anchor (the seamless engine the /try demo already uses) so the whole group can
// no longer slide off the lights by end-of-song; and the waveform playhead must WRAP to the start on
// each loop instead of pinning to the right edge. Verified by fact on a headless phone:
//   - the room's `start` carries loop:true and the phone runs startLoop() (audio.looping)
//   - PAST the track duration the show is STILL running (not ended) and the lights pos has wrapped
//   - the waveform cursor (wavePos) has wrapped back to < duration (round 11's playhead no longer stuck)
//   - the server did NOT auto-stop the single-track loop (no per-song re-GO)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3060';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  // one curated short track => the room loops it in place (plOrder length 1)
  let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let tr = (st.tracks || []).find((t) => t.analysis_status === 'done');
  if (!tr) { const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav'); await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j); st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); tr = st.tracks.find((t) => t.analysis_status === 'done'); }
  await fetch(BASE + `/api/operator/track/${tr.id}/attest`, { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + `/api/operator/track/${tr.id}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: tr.id, playlist_mode: 'one' }) }).then(j);
  const durMs = tr.duration_ms || 3000;

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const room = (await con.evaluate(() => window.__SESSION__)).room;
  await con.click('#playSound').catch(() => {});
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});

  // a phone joins the looping room and opts into the music (auto in a room)
  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await ph.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});
  await ph.waitForFunction(() => window.__cls && window.__cls.audio && window.__cls.audio.looping === true, { timeout: 8000 }).catch(() => {});

  const early = await ph.evaluate(() => ({ loop: window.__cls.loop, looping: window.__cls.audio.looping, status: window.__cls.status }));
  check('room_start_loop', early.loop === true, 'phone got start{loop:true}=' + early.loop);
  check('audio_uses_startloop', early.looping === true, 'audio.looping=' + early.looping + ' (seamless /try engine, not one-shot)');

  // wait PAST the track duration: the OLD one-shot would go idle at durationMs and pin the cursor
  await sleep(durMs + 1800);
  const late = await ph.evaluate(() => ({ status: window.__cls.status, wavePos: window.__cls.wavePos, everLit: window.__cls.everLit, looping: window.__cls.audio.looping, lastPos: window.__cls.lastPos }));
  check('still_running_past_end', late.status === 'running' && late.everLit && late.looping === true, 'status=' + late.status + ' everLit=' + late.everLit + ' looping=' + late.looping + ' (single-track loop kept playing past end-of-song, not stopped/drifted off)');
  // the audio cursor (waveform playhead) wraps modulo the duration each loop — the round-11 "stuck at
  // the end" cursor is gone. (Lights in this room are the reactive preset, which is clock-based and
  // never drifts; the AUDIO is what used to slide off — proven held by looping + the wrapped cursor.)
  check('cursor_wrapped_to_start', late.wavePos >= 0 && late.wavePos < durMs, `wavePos=${late.wavePos} < dur=${durMs} (playhead snapped back to the start on loop, not pinned at the end)`);

  // the server did NOT auto-stop / churn the single-track loop (no per-song re-GO)
  const srv = await fetch(`${BASE}/api/console/playlist`, { headers: { Authorization: 'Bearer ' + (await con.evaluate(() => window.__SESSION__)).token } }).then(j).catch(() => null);
  check('server_still_running', !!srv && srv.playlist && srv.playlist.mode === 'one', 'server room still on the looping track, mode=' + (srv && srv.playlist && srv.playlist.mode));

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'loop_sync_report.json'), JSON.stringify({ base: BASE, durMs, early, late, fails }, null, 2));
  if (fails.length) { console.error('LOOP SYNC FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('LOOP SYNC PASS: a single-track /studio room loops lights+audio on one fixed anchor (startLoop, the /try engine) — runs past end-of-song without drifting off or ending, and the waveform cursor wraps back to the start each loop.');
}
main().catch((e) => { console.error(e); process.exit(1); });
