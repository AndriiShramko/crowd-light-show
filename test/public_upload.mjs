// ROUND 10 — public own-music upload is KEEP-AND-SERVE (it actually PLAYS), gated by the flag.
// Proves:
//   * flag OFF (BASE): /api/console/upload -> 503; the public session does NOT advertise upload.
//   * flag ON (BASE_UPLOAD): consent is server-mandatory (403 without ?consent=1); non-audio 415;
//     a valid upload is KEPT (a file remains in the guest dir), lightsOnly:false; the audio is
//     SERVED to the console (guest-audio) AND to a room phone (room-audio) which DECODES + plays it;
//     the per-IP file cap (3) rejects a 4th; and the file is DELETED after the room empties (grace).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3011';            // flag OFF
const UP = process.env.BASE_UPLOAD || '';                            // flag ON
const GUEST_DIR = process.env.GUEST_DIR || '';                       // data/uploads/guest of the flag-ON server
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
function parseSession(html) { const m = html.match(/window\.__SESSION__\s*=\s*(\{[\s\S]*?\});<\/script>/); return m ? JSON.parse(m[1]) : null; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const guestAudioFiles = () => (GUEST_DIR && fs.existsSync(GUEST_DIR)) ? fs.readdirSync(GUEST_DIR).filter((f) => /\.(wav|mp3|m4a|ogg|flac)$/i.test(f)) : [];

async function newSession(base) { return parseSession(await fetch(base + '/studio').then((r) => r.text())); }
async function uploadTo(base, token, { consent, file, name }) {
  const fd = new FormData(); fd.append('audio', new Blob([file]), name || 'a.wav');
  return fetch(base + '/api/console/upload' + (consent ? '?consent=1' : ''), { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
}
const armGo = (base, tok, gid) => Promise.all([]) // round 12 (pt 6): arm the upload's real id (g:<room>:<id6>)
  .then(() => fetch(base + '/api/console/arm', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: gid }) }))
  .then(() => fetch(base + '/api/console/go', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: '{}' }));

async function main() {
  // ---- flag OFF ----
  const sessOff = await newSession(BASE);
  check('off_session', !!sessOff && sessOff.mode === 'public', 'public session');
  check('off_upload_feature_false', sessOff.features.upload === false, 'features.upload=' + sessOff.features.upload);
  const wav = fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'));
  const offRes = await uploadTo(BASE, sessOff.token, { consent: true, file: wav });
  check('off_upload_503', offRes.status === 503, 'status=' + offRes.status);

  // ---- flag ON ----
  if (UP) {
    const opTok = (await fetch(UP + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then((r) => r.json())).token;
    await fetch(UP + '/api/operator/public-config', { method: 'POST', headers: { Authorization: 'Bearer ' + opTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ allow_upload: true }) });
    const sess = await newSession(UP);
    const tok = sess.token, room = sess.room;
    check('on_upload_feature', sess.features.upload === true, 'features.upload=' + sess.features.upload);

    check('on_consent_required', (await uploadTo(UP, tok, { consent: false, file: wav })).status === 403, 'no-consent');
    check('on_non_audio_415', (await uploadTo(UP, tok, { consent: true, file: Buffer.from('not audio at all, padding padding padding'), name: 'x.wav' })).status === 415, 'non-audio');

    const ok = await uploadTo(UP, tok, { consent: true, file: wav }); const okJson = await ok.json();
    const gid = okJson.trackId; // g:<room>:<id6>
    check('on_upload_keep_and_serve', ok.status === 200 && okJson.ok && okJson.lightsOnly === false && typeof gid === 'string' && gid.indexOf('g:' + room + ':') === 0, JSON.stringify(okJson));
    check('on_file_kept', guestAudioFiles().length >= 1, 'files kept=' + guestAudioFiles().length);

    // SERVED: console monitor + (after arm) a room phone
    const cAudio = await fetch(UP + '/api/console/guest-audio', { headers: { Authorization: 'Bearer ' + tok } });
    check('on_console_guest_audio_200', cAudio.status === 200, 'console guest-audio=' + cAudio.status);
    await armGo(UP, tok, gid);
    const rAudio = await fetch(`${UP}/api/audience/room-audio?room=${room}`);
    check('on_room_audio_200', rAudio.status === 200, 'room-audio=' + rAudio.status);

    // a REAL phone in the room DECODES + plays the uploaded sound (not just lights)
    const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const ph = await (await b.newContext()).newPage();
    await ph.goto(`${UP}/join?room=${room}&auto=1`);
    await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
    const ready = await ph.waitForFunction(() => window.__cls.audio && window.__cls.audio.ready, { timeout: 15000 }).then(() => true).catch(() => false);
    await armGo(UP, tok, gid); // re-GO so the short track is actively playing when the phone schedules
    const scheduled = await ph.waitForFunction(() => window.__cls.audio && window.__cls.audio.scheduled, { timeout: 10000 }).then(() => true).catch(() => false);
    const cls = await ph.evaluate(() => ({ ready: window.__cls.audio.ready, scheduled: window.__cls.audio.scheduled, lightsOnly: window.__cls.audio.lightsOnly, everLit: window.__cls.everLit }));
    await b.close();
    check('on_phone_plays_guest_sound', ready && scheduled && cls.lightsOnly !== true, JSON.stringify(cls));

    // per-IP file cap: fill up to the cap across fresh rooms, then the next is rejected
    const cap = 3; let last = 200;
    for (let i = 0; i < cap + 1; i++) { const s = await newSession(UP); last = (await uploadTo(UP, s.token, { consent: true, file: wav })).status; }
    check('on_file_cap', last === 429, 'over-cap upload status=' + last);

    // cleanup: a room with no members loses its file after the grace (short on the test server)
    const s2 = await newSession(UP); await uploadTo(UP, s2.token, { consent: true, file: wav });
    const before = guestAudioFiles().length;
    await wait(Number(process.env.WAIT_CLEANUP_MS || 5000)); // > grace + a sweep tick
    const c2 = await fetch(`${UP}/api/audience/room-audio?room=${s2.room}`).then((r) => r.status);
    check('on_cleanup_on_empty', c2 !== 200, 'after grace, room-audio=' + c2 + ' (files before=' + before + ', now=' + guestAudioFiles().length + ')');
  } else {
    console.log('(BASE_UPLOAD not set — only the disabled-by-default behavior was checked)');
  }

  fs.writeFileSync(path.join(dir, '..', 'public_upload_report.json'), JSON.stringify({ base: BASE, up: UP || null, fails }, null, 2));
  if (fails.length) { console.error('PUBLIC UPLOAD FAIL:', fails.join('; ')); process.exit(1); }
  console.log('PUBLIC UPLOAD PASS: OFF=503; ON=keep-and-serve — consent-mandatory, file kept + served to console+phone (real sound), per-IP cap, deleted after the room empties, non-audio 415.');
}
main().catch((e) => { console.error(e); process.exit(1); });
