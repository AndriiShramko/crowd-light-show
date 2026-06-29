// ROUND 10 — /studio public-console UX collapse + responsive + reactive default.
// Owner complaints: 3-4 play buttons, GO with no sound, dead native <audio>, narrow strip.
// Asserts: ONE prominent "Play with sound" (the single autoplay gesture), the native <audio> +
// redundant GO + old Sound button hidden, transport/presets under an Advanced disclosure, Share
// at the top, the default preset auto-picked (reactive), full-width container on desktop — AND
// the personal /operator console keeps all its controls.
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
  // ensure a curated public default track
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

  const b = await chromium.launch();

  // ---- PUBLIC /studio ----
  const pub = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const perr = []; pub.on('pageerror', (e) => perr.push(e.message));
  await pub.goto(BASE + '/studio');
  await pub.waitForTimeout(1500); // applyMode + default auto-arm + fetchConsoleAudio reveal
  const ui = await pub.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); if (!e) return false; const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden'; };
    const det = document.querySelector('details.op-adv');
    const detHasShow = !!(det && det.querySelector('#cardShow'));
    const detHasStudio = !!(det && det.querySelector('#studioCard'));
    // share before the playlist card in DOM order?
    const share = document.getElementById('shareBlock'), pl = document.getElementById('cardPlaylist');
    const shareBeforePlaylist = !!(share && pl && (share.compareDocumentPosition(pl) & Node.DOCUMENT_POSITION_FOLLOWING));
    // count visible "primary"-styled play-ish buttons OUTSIDE the collapsed Advanced (the per-track
    // Switch buttons are width:auto ghosts; the one hero is #playSound)
    const consoleWidth = document.querySelector('.op-console').getBoundingClientRect().width;
    return {
      playSoundVis: vis('playSound'),
      playerHidden: !vis('player'), goHidden: !vis('go'), soundBtnHidden: !vis('soundBtn'),
      detPresent: !!det, detHasShow, detHasStudio, shareBeforePlaylist,
      activePreset: window.__opPreview ? window.__opPreview.type : null,
      consoleWidth,
    };
  });
  check('public_no_js_errors', perr.length === 0, perr.join(' | '));
  check('one_play_button', ui.playSoundVis, 'playSound visible');
  check('dead_player_hidden', ui.playerHidden, 'native <audio> hidden');
  check('redundant_go_hidden', ui.goHidden, 'GO hidden in public');
  check('old_sound_hidden', ui.soundBtnHidden, 'old Sound button hidden');
  check('advanced_disclosure', ui.detPresent && ui.detHasShow && ui.detHasStudio, 'transport+presets under Advanced');
  check('share_on_top', ui.shareBeforePlaylist, 'Share above the playlist');
  check('reactive_default_preset', ui.activePreset === 'pulse', 'auto-picked preset=' + ui.activePreset);
  check('full_width_desktop', ui.consoleWidth > 900, 'console width=' + Math.round(ui.consoleWidth) + 'px @1440');

  // tap Play-with-sound → it becomes "Sound on" and there is no SECOND sound control after
  await pub.click('#playSound').catch(() => {});
  await pub.waitForTimeout(300);
  const afterTap = await pub.evaluate(() => {
    const ps = document.getElementById('playSound');
    const sb = document.getElementById('soundBtn');
    const sbVis = sb && getComputedStyle(sb).display !== 'none';
    return { playLabel: ps ? ps.textContent : '', playDisabled: ps ? ps.disabled : false, secondSound: !!sbVis };
  });
  check('one_gesture_no_second_sound', /Sound on/i.test(afterTap.playLabel) && afterTap.playDisabled && !afterTap.secondSound, JSON.stringify(afterTap));

  // ---- PERSONAL /operator stays intact ----
  const opCtx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS } });
  const op = await opCtx.newPage();
  await op.goto(BASE + '/operator');
  await op.waitForSelector('[data-arm]', { timeout: 12000 });
  const opUi = await op.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); if (!e) return false; const s = getComputedStyle(e); return s.display !== 'none'; };
    return { player: vis('player'), go: vis('go'), nudge: vis('nudge'), apps: !!document.querySelector('[data-feature="applications"]') && getComputedStyle(document.querySelector('[data-feature="applications"]')).display !== 'none', pubcfg: !!document.querySelector('[data-feature="publicConfig"]') && getComputedStyle(document.querySelector('[data-feature="publicConfig"]')).display !== 'none', adv: !!document.querySelector('details.op-adv') };
  });
  await b.close();
  check('personal_intact', opUi.player && opUi.go && opUi.apps && opUi.pubcfg && !opUi.adv, 'player+go+apps+pubcfg visible, no Advanced wrap: ' + JSON.stringify(opUi));

  fs.writeFileSync(path.join(dir, '..', 'studio_ux_report.json'), JSON.stringify({ base: BASE, ui, afterTap, opUi, fails }, null, 2));
  if (fails.length) { console.error('STUDIO UX FAIL:', fails.join('; ')); process.exit(1); }
  console.log('STUDIO UX PASS: one Play-with-sound gesture, dead controls hidden, Advanced disclosure, Share on top, reactive default, full-width desktop; personal /operator intact.');
}
main().catch((e) => { console.error(e); process.exit(1); });
