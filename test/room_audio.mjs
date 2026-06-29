// ROUND 10 — a phone that joins a public STUDIO room ALWAYS gets the room's music.
// Owner: "phones get NO music now — ALWAYS stream music to phones." Before, showAudioBtn()
// froze audio for any room join (`if (ROOM) return`), so studio-room phones were silent.
// Now the join tap starts the AudioContext and the room's armed track auto-streams, synced.
//
// Proven by FACT: open the /studio console (it auto-arms+GOes the default public track), read its
// room code, then join a REAL phone at /join?room=<code>&auto=1 (NO audio=1 — the auto-stream path,
// not the headless opt-in). Assert the phone decoded + scheduled the room's audio and is NOT
// lights-only. Plus the server gate: room-audio 200 for the armed room, 400 bad room, 409 unknown.
// (Headless proves the wiring + scheduling; real audible sound on a real phone is operator-verified.)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3011';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
async function opPost(p, body, token) { return fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
async function opGet(p, token) { return fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } }); }

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  // ensure a curated, attested, public DEFAULT track (the room auto-arms it)
  let state = await opGet('/api/operator/state', token).then(j);
  let track = (state.tracks || []).find((t) => t.analysis_status === 'done');
  if (!track) {
    const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
    await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }).then(j);
    state = await opGet('/api/operator/state', token).then(j); track = state.tracks.find((t) => t.analysis_status === 'done');
  }
  await opPost(`/api/operator/track/${track.id}/attest`, {}, token);
  await opPost(`/api/operator/track/${track.id}/public`, { is_public: true }, token);
  await opPost('/api/operator/public-config', { default_track_id: track.id }, token);

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---- the /studio console creates the room + auto-arms + auto-GOes the default ----
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const sess = await con.evaluate(() => window.__SESSION__);
  const room = sess.room;
  const cAuth = { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' };
  // wait until the console's room is actually running (default armed + GO)
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});
  check('room_code', /^[a-z0-9]{6,24}$/.test(room || ''), 'room=' + room);

  // ---- server gate ----
  const sGood = (await fetch(`${BASE}/api/audience/room-audio?room=${room}`)).status;
  const sBad = (await fetch(`${BASE}/api/audience/room-audio?room=NOPE`)).status;
  const sUnknown = (await fetch(`${BASE}/api/audience/room-audio?room=zzzzzz999999`)).status;
  check('server_room_audio_200', sGood === 200, 'armed room -> ' + sGood);
  check('server_bad_room_400', sBad === 400, 'bad room -> ' + sBad);
  check('server_unknown_room_409', sUnknown === 409, 'unknown room -> ' + sUnknown);

  // ---- a REAL phone joins that room (auto-stream path; NO audio=1) ----
  const ph = await (await b.newContext()).newPage();
  const phErr = []; ph.on('pageerror', (e) => phErr.push(e.message));
  await ph.goto(`${BASE}/join?room=${room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {});
  // the phone should auto-want audio and decode the room track
  const wanted = await ph.waitForFunction(() => window.__cls.audio && window.__cls.audio.wanted, { timeout: 8000 }).then(() => true).catch(() => false);
  const ready = await ph.waitForFunction(() => window.__cls.audio && window.__cls.audio.ready, { timeout: 15000 }).then(() => true).catch(() => false);
  // the 6s tone fixture may have ended before the phone joined (a real default track is a full
  // song). Re-arm + GO via the console token so the track is actively playing, then assert the
  // already-joined+decoded phone SCHEDULES it on the synced clock.
  await fetch(`${BASE}/api/console/arm`, { method: 'POST', headers: cAuth, body: JSON.stringify({ trackId: track.id }) });
  await fetch(`${BASE}/api/console/go`, { method: 'POST', headers: cAuth, body: '{}' });
  const scheduled = await ph.waitForFunction(() => window.__cls.audio && window.__cls.audio.scheduled, { timeout: 10000 }).then(() => true).catch(() => false);
  const snap = await ph.evaluate(() => ({ ...window.__cls.audio, status: window.__cls.status }));
  await b.close();

  // headless requests fullscreen/wake-lock on join; "Permissions check failed" is a benign
  // headless artifact (no such API in CI), not an app error — ignore it.
  const realErr = phErr.filter((e) => !/Permissions check failed|fullscreen|wake ?lock/i.test(e));
  check('phone_no_js_errors', realErr.length === 0, realErr.join(' | '));
  check('phone_wants_audio', wanted, 'auto-stream armed (no audio=1 needed)');
  check('phone_decoded_room_audio', ready, 'decoded the room track');
  check('phone_scheduled', scheduled, 'scheduled on the synced clock');
  check('phone_not_lightsonly', snap.lightsOnly !== true, 'lightsOnly=' + snap.lightsOnly);

  fs.writeFileSync(path.join(dir, '..', 'room_audio_report.json'), JSON.stringify({ base: BASE, room, server: { good: sGood, bad: sBad, unknown: sUnknown }, phone: snap, fails }, null, 2));
  if (fails.length) { console.error('ROOM AUDIO FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('ROOM AUDIO PASS: a studio-room phone auto-streams the room music (decoded+scheduled, not lights-only); server gate 200/400/409. (Real audible sound = operator-verified on a phone.)');
}
main().catch((e) => { console.error(e); process.exit(1); });
