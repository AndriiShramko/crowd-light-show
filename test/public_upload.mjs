// ROUND 9 — public own-music upload (DARK behind PUBLIC_UPLOAD_ENABLED). Proves:
//   * flag OFF (BASE): /api/console/upload -> 503; the public session does NOT advertise upload.
//   * flag ON (BASE_UPLOAD): consent is server-mandatory (403 without ?consent=1); a valid upload
//     is DECODE-THEN-DISCARD (the audio file is deleted, no audio is ever served for it), returns
//     a lights-only timeline that can be armed and flashes a room phone; non-audio is 415.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3009';            // flag OFF (V1 default)
const UP = process.env.BASE_UPLOAD || '';                            // flag ON (optional)
const GUEST_DIR = process.env.GUEST_DIR || '';                       // data/uploads/guest of the flag-ON server
const dir = path.dirname(fileURLToPath(import.meta.url));
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
function parseSession(html) { const m = html.match(/window\.__SESSION__\s*=\s*(\{[\s\S]*?\});<\/script>/); return m ? JSON.parse(m[1]) : null; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadTo(base, token, { consent, file, name }) {
  const fd = new FormData();
  fd.append('audio', new Blob([file]), name || 'a.wav');
  const q = consent ? '?consent=1' : '';
  return fetch(base + '/api/console/upload' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
}

async function main() {
  // ---- flag OFF (V1 default) ----
  const sessOff = parseSession(await fetch(BASE + '/studio').then((r) => r.text()));
  check('off_session', !!sessOff && sessOff.mode === 'public', 'public session');
  check('off_upload_feature_false', sessOff.features.upload === false, 'features.upload=' + sessOff.features.upload);
  const wav = fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'));
  const offRes = await uploadTo(BASE, sessOff.token, { consent: true, file: wav });
  check('off_upload_503', offRes.status === 503, 'status=' + offRes.status);

  // ---- flag ON (dark feature exercised) ----
  if (UP) {
    // Andrii must ALSO opt in (two-level gate: env flag + his public_config.allow_upload). Enable it.
    const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
    const opTok = (await fetch(UP + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then((r) => r.json())).token;
    await fetch(UP + '/api/operator/public-config', { method: 'POST', headers: { Authorization: 'Bearer ' + opTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ allow_upload: true }) });
    const sessOn = parseSession(await fetch(UP + '/studio').then((r) => r.text()));
    const tok = sessOn.token, room = sessOn.room;
    check('on_upload_feature', sessOn.features.upload === true, 'features.upload=' + sessOn.features.upload + ' (env flag + allow_upload both required)');

    // consent is mandatory
    const noConsent = await uploadTo(UP, tok, { consent: false, file: wav });
    check('on_consent_required', noConsent.status === 403, 'status=' + noConsent.status);

    // non-audio is rejected
    const notAudio = await uploadTo(UP, tok, { consent: true, file: Buffer.from('this is not audio at all, just text padding padding'), name: 'x.wav' });
    check('on_non_audio_415', notAudio.status === 415, 'status=' + notAudio.status);

    // valid upload: lights-only timeline, audio discarded
    const ok = await uploadTo(UP, tok, { consent: true, file: wav });
    const okJson = await ok.json();
    check('on_upload_ok', ok.status === 200 && okJson.ok && okJson.lightsOnly === true && okJson.trackId === 'g:' + room, JSON.stringify(okJson));
    check('on_upload_governed', okJson.cueCount > 0, 'cues=' + okJson.cueCount);

    // decode-then-discard: the guest dir holds NO audio file after processing
    if (GUEST_DIR && fs.existsSync(GUEST_DIR)) {
      const left = fs.readdirSync(GUEST_DIR).filter((f) => /\.(wav|mp3|m4a|ogg|flac)$/i.test(f));
      check('on_audio_discarded', left.length === 0, 'files left=' + left.length);
    }
    // no audio is served for a guest track (it was discarded; route serves is_public only)
    const audioRes = await fetch(UP + '/api/console/audio/' + encodeURIComponent('g:' + room), { headers: { Authorization: 'Bearer ' + tok } });
    check('on_no_guest_audio', audioRes.status === 404 || audioRes.status === 400, 'status=' + audioRes.status);

    // arm the guest light timeline + a phone in the room flashes (lights only)
    const b = await chromium.launch();
    const ph = await (await b.newContext()).newPage();
    await ph.goto(`${UP}/join?room=${room}&auto=1`);
    await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
    await fetch(UP + '/api/console/arm', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: 'g:' + room }) });
    await fetch(UP + '/api/console/go', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: '{}' });
    await wait(4000);
    const cls = await ph.evaluate(() => ({ everLit: window.__cls.everLit, flashes: window.__cls.flashes.length, trackId: window.__cls.trackId }));
    await b.close();
    check('on_guest_lights_flash', cls.everLit && cls.flashes >= 1, 'flashes=' + cls.flashes + ' trackId=' + cls.trackId);
  } else {
    console.log('(BASE_UPLOAD not set — skipping the flag-ON path; only the disabled-by-default behavior was checked)');
  }

  fs.writeFileSync(path.join(dir, '..', 'public_upload_report.json'), JSON.stringify({ base: BASE, up: UP || null, fails }, null, 2));
  if (fails.length) { console.error('PUBLIC UPLOAD FAIL:', fails.join('; ')); process.exit(1); }
  console.log('PUBLIC UPLOAD PASS: disabled-by-default returns 503' + (UP ? '; flag-ON path: consent-mandatory, decode-then-discard (audio deleted, none served), lights-only timeline flashes a room phone, non-audio 415.' : '.'));
}
main().catch((e) => { console.error(e); process.exit(1); });
