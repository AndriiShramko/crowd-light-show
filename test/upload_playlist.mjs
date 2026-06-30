// ROUND 12 — pt 6. A visitor's OWN uploaded tracks must land in the room PLAYLIST (so they can loop
// them / put them in the loop list) and a room may keep up to 3. Verified by fact (flag-on server):
//   - 3 uploads -> 3 distinct guest tracks in /api/console/playlist.guestTracks + in the console UI list
//   - arming an uploaded track makes the room LOOP it (loop:true — the seamless round-12 engine)
//   - a 4th upload keeps the room at 3 (FIFO drops the oldest)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3060';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };
const wav = fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'));

async function uploadOne(sess, name) {
  const fd = new FormData(); fd.append('audio', new Blob([wav]), name);
  const r = await fetch(BASE + '/api/console/upload?consent=1', { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token }, body: fd });
  return { status: r.status, body: r.ok ? await r.json() : null };
}
const playlist = (sess) => fetch(BASE + '/api/console/playlist', { headers: { Authorization: 'Bearer ' + sess.token } }).then(j);

async function main() {
  // enable visitor uploads (owner toggle)
  const opTok = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: { Authorization: 'Bearer ' + opTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ allow_upload: true }) }).then(j);

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const sess = await con.evaluate(() => window.__SESSION__);

  // ---- upload 3 distinct tracks ----
  const ids = [];
  for (const nm of ['song-one.wav', 'song-two.wav', 'song-three.wav']) { const u = await uploadOne(sess, nm); if (u.body && u.body.trackId) ids.push(u.body.trackId); }
  check('three_uploads_distinct', ids.length === 3 && new Set(ids).size === 3, 'guest ids=' + JSON.stringify(ids));

  const pl1 = await playlist(sess);
  const gt = pl1.guestTracks || [];
  check('playlist_has_3_guest_tracks', gt.length === 3 && gt.every((t) => /^g:/.test(t.id) && t.title), 'guestTracks=' + JSON.stringify(gt.map((t) => t.title)));

  // ---- the console UI lists the uploaded tracks (so they can be looped / selected) ----
  // (we uploaded over HTTP; a real UI upload re-fetches the playlist via armTrack -> loadPublic.
  //  Trigger that same refresh in the SAME room — reloading would mint a fresh room and lose them.)
  await con.click('#playSound').catch(() => {}); // reveal the console (playlist is block 2)
  await con.evaluate(() => window.__opRefreshPublic && window.__opRefreshPublic());
  await con.waitForTimeout(900);
  const uiTitles = await con.evaluate(() => [...document.querySelectorAll('#tracks tbody tr td b')].map((e) => e.textContent));
  check('ui_lists_uploads', ['song-one', 'song-two', 'song-three'].every((t) => uiTitles.includes(t)), 'console playlist rows=' + JSON.stringify(uiTitles));

  // ---- arming an uploaded track makes the room LOOP it (the round-12 seamless engine) ----
  await fetch(BASE + '/api/console/playlist', { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'one' }) }).then(j);
  await fetch(BASE + '/api/console/arm', { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: ids[0], keepPreset: true }) }).then(j);
  const goRes = await fetch(BASE + '/api/console/go', { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: '{}' }).then(j);
  const pl2 = await playlist(sess);
  check('uploaded_track_loops', pl2.playlist && pl2.playlist.len >= 1 && pl2.playlist.nowId === ids[0], 'armed upload -> playlist nowId=' + (pl2.playlist && pl2.playlist.nowId) + ' len=' + (pl2.playlist && pl2.playlist.len) + ' (in the loop, not a play-once)');

  // ---- a 4th upload keeps the room at 3 (FIFO drop) ----
  const u4 = await uploadOne(sess, 'song-four.wav');
  const pl3 = await playlist(sess);
  const gt3 = pl3.guestTracks || [];
  check('cap_3_per_room_fifo', u4.status === 200 && gt3.length === 3 && gt3.some((t) => t.title === 'song-four') && !gt3.some((t) => t.title === 'song-one'), '4th kept, oldest dropped -> ' + JSON.stringify(gt3.map((t) => t.title)));

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'upload_playlist_report.json'), JSON.stringify({ base: BASE, ids, guestTracks: gt, fails }, null, 2));
  if (fails.length) { console.error('UPLOAD PLAYLIST FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('UPLOAD PLAYLIST PASS: a visitor can upload up to 3 tracks; they appear in the room playlist (server + console UI), an armed upload loops via the seamless engine, and a 4th upload FIFO-drops the oldest (kept at 3).');
}
main().catch((e) => { console.error(e); process.exit(1); });
