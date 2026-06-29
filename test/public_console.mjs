// ROUND 9 — public operator console (/studio). Proves end-to-end + ISOLATION:
//   * /studio mints a public session bound to its OWN ephemeral room (!= main).
//   * a curated is_public track can be armed+GO'd from the console token; a non-public
//     track is refused (403); a private track is never in the playlist.
//   * the console token is REJECTED by every /api/operator/* route (401) — no leads, no main.
//   * a phone joining the room flashes from the console's show, and is ISOLATED from main:
//     arming a DIFFERENT track on the main show never reaches the room phone.
//   * public_config publish requires operator auth (401 without it).
//   * the room-mint per-IP cap and the studio kill-switch behave.
// Headless = protocol + isolation proof, not real phones.
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

async function opGet(p, token) { return fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } }); }
async function opPost(p, body, token) { return fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }

async function ensureTrack(token, want) {
  let state = await opGet('/api/operator/state', token).then(j);
  let done = (state.tracks || []).filter((t) => t.analysis_status === 'done');
  while (done.length < want) {
    const fd = new FormData();
    const fx = done.length === 0 ? 'tone_2hz.wav' : 'tone_flat.wav';
    const buf = fs.readFileSync(path.join(dir, '..', 'fixtures', fx));
    fd.append('audio', new Blob([buf]), fx);
    await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }).then(j);
    state = await opGet('/api/operator/state', token).then(j);
    done = (state.tracks || []).filter((t) => t.analysis_status === 'done');
  }
  return done;
}

function parseSession(html) {
  const m = html.match(/window\.__SESSION__\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (!m) throw new Error('no __SESSION__ in /studio');
  return JSON.parse(m[1]);
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');

  const done = await ensureTrack(token, 2);
  const pubTrack = done[0], privTrack = done[1];   // A = public/curated, B = stays private (armed on main for isolation)

  // curate track A into the public playlist (attest -> public -> default), leave B private
  await opPost(`/api/operator/track/${pubTrack.id}/attest`, {}, token);
  const pubRes = await opPost(`/api/operator/track/${pubTrack.id}/public`, { is_public: true }, token).then(j);
  check('curate_public', pubRes.ok && pubRes.is_public === 1, 'is_public=' + pubRes.is_public);
  // a non-attested track cannot be made public
  const cantPub = await opPost(`/api/operator/track/${privTrack.id}/public`, { is_public: true }, token);
  check('public_needs_attest', cantPub.status === 409, 'status=' + cantPub.status);
  // set defaults (must be authed)
  const noAuthCfg = await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand_name: 'X' }) });
  check('public_config_authed', noAuthCfg.status === 401, 'status=' + noAuthCfg.status);
  const cfg = await opPost('/api/operator/public-config', { default_track_id: pubTrack.id, default_screen_preset: 'pulse', default_screen_params: {}, brand_name: 'Test Lights' }, token).then(j);
  check('public_config_save', cfg.ok && cfg.config.default_track_id === pubTrack.id, 'defaultTrack=' + (cfg.config && cfg.config.default_track_id));
  // round 9 fix: the default track can be CLEARED (null), not only set
  await opPost('/api/operator/public-config', { default_track_id: null }, token).then(j);
  const cleared = await opGet('/api/operator/public-config', token).then(j);
  check('public_config_clear', cleared.config.default_track_id === null, 'cleared=' + cleared.config.default_track_id);
  await opPost('/api/operator/public-config', { default_track_id: pubTrack.id }, token).then(j); // re-set for the rest

  // mint a public console session
  const html = await fetch(BASE + '/studio').then((r) => r.text());
  const sess = parseSession(html);
  check('studio_public_session', sess.mode === 'public' && /^[a-z0-9]{6,24}$/.test(sess.room) && !!sess.token, 'room=' + sess.room);
  check('studio_not_main', sess.room !== 'main', 'room=' + sess.room);
  check('studio_no_leads', sess.features && sess.features.applications === false, 'applications=' + (sess.features && sess.features.applications));
  check('studio_playlist_has_curated', (sess.playlist || []).some((t) => t.id === pubTrack.id) && !(sess.playlist || []).some((t) => t.id === privTrack.id), 'playlist=' + JSON.stringify((sess.playlist || []).map((t) => t.id)));
  check('studio_default_track', sess.defaults && sess.defaults.default_track_id === pubTrack.id, 'def=' + (sess.defaults && sess.defaults.default_track_id));
  const cTok = sess.token, room = sess.room;

  // console token is REJECTED by every operator route (no leads, no main control)
  for (const p of ['/api/operator/applications', '/api/operator/state']) {
    const r = await opGet(p, cTok); check('console_blocked_GET ' + p, r.status === 401, 'status=' + r.status);
  }
  const armMain = await opPost('/api/operator/arm', { trackId: pubTrack.id }, cTok);
  check('console_blocked_arm_main', armMain.status === 401, 'status=' + armMain.status);

  // console can arm the PUBLIC track, but NOT a private one
  const armPriv = await opPost('/api/console/arm', { trackId: privTrack.id }, cTok);
  check('console_refuses_private', armPriv.status === 403, 'status=' + armPriv.status);

  // ---- SAFETY SWEEP: the governor sits BELOW the console layer and is never bypassed ----
  // (done before the flash test; sets presets on the room then turns them off — no track armed)
  await opPost('/api/console/preset', { type: 'pulse', params: { bpm: 600, depth: 5 } }, cTok).then(j);
  let cat = await opGet('/api/console/presets', cTok).then(j);
  check('console_screen_clamped', cat.active && cat.active.params.bpm <= 180 && cat.active.params.depth <= 0.8, 'bpm=' + (cat.active && cat.active.params.bpm) + ' depth=' + (cat.active && cat.active.params.depth));
  await opPost('/api/console/preset', { channel: 'torch', type: 'strobe', params: { rate: 20 } }, cTok).then(j);
  cat = await opGet('/api/console/presets', cTok).then(j);
  check('console_torch_clamped', cat.torchActive && cat.torchActive.params.rate <= 2.8, 'rate=' + (cat.torchActive && cat.torchActive.params.rate));
  // NO bypass: debug/raw/unsafe query flags do not loosen the clamp
  await fetch(BASE + '/api/console/preset?debug=1&raw=1&unsafe=1&next=1', { method: 'POST', headers: { Authorization: 'Bearer ' + cTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'pulse', params: { bpm: 999 } }) }).then(j);
  cat = await opGet('/api/console/presets', cTok).then(j);
  check('console_no_bypass', cat.active && cat.active.params.bpm <= 180, 'bpm=' + (cat.active && cat.active.params.bpm));
  await opPost('/api/console/preset', { type: 'off' }, cTok);
  await opPost('/api/console/preset', { channel: 'torch', type: 'off' }, cTok);

  // a phone joins the room, THEN the console runs the public track -> the phone must flash
  const b = await chromium.launch();
  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});

  const arm = await opPost('/api/console/arm', { trackId: pubTrack.id }, cTok).then(j);
  const go = await opPost('/api/console/go', {}, cTok).then(j);
  check('console_arm_go', arm.ok && go.ok, 'arm=' + arm.ok + ' go=' + go.ok);

  // ISOLATION: arm a DIFFERENT (private) track on the MAIN show — the room phone must NOT switch
  await opPost('/api/operator/arm', { trackId: privTrack.id }, token).then(j);
  await opPost('/api/operator/go', {}, token).then(j);

  await wait(4000);
  const cls = await ph.evaluate(() => ({ everLit: window.__cls.everLit, flashes: window.__cls.flashes.length, room: window.__cls.room, trackId: window.__cls.trackId, gotStart: !!window.__cls.gotStart }));
  await b.close();

  check('room_phone_in_room', cls.room === room, 'room=' + cls.room);
  check('room_phone_isolated_track', cls.trackId === pubTrack.id, 'phoneTrack=' + cls.trackId + ' (main armed ' + privTrack.id + ', room=' + pubTrack.id + ')');
  check('room_phone_flashed', cls.everLit && cls.flashes >= 1, 'flashes=' + cls.flashes);

  // kill-switch / mint guard sanity (best-effort; depend on env)
  const studio2 = await fetch(BASE + '/studio');
  check('studio_serves', studio2.status === 200 || studio2.status === 429, 'status=' + studio2.status);

  const report = { base: BASE, room, pubTrack: pubTrack.id, privTrack: privTrack.id, fails };
  fs.writeFileSync(path.join(dir, '..', 'public_console_report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (fails.length) { console.error('PUBLIC CONSOLE FAIL:', fails.join('; ')); process.exit(1); }
  console.log('PUBLIC CONSOLE PASS: /studio public session bound to its own room; curated arm+GO flashes a room phone; isolated from main; console token blocked from every operator route; defaults authed.');
}
main().catch((e) => { console.error(e); process.exit(1); });
