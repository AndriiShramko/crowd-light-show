// ROUND 11 — /studio UX redesign (owner pts 1,2,3,4,5,9,10,11,14). The public console now opens with
// ONE "Start Light Show" button and NOTHING else (no auto-GO); the first click shows a spinner, then
// morphs to "Pause Light Show" once the show is running, REVEALING STOP/BLACKOUT + the rest. Block
// order is 1 Show control · 2 Playlist · 3 Join QR · 4 Invite · 5 Live presets (Advanced, open).
// Join URL is filled, Nudge is hidden on /studio, a small Mute button exists, Live presets is full-
// width, and /studio == /operator minus the admin-only cards. The personal /operator stays intact.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3030';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
async function opPost(p, body, token) { return fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
async function opGet(p, token) { return fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } }); }
const orderOf = (page) => page.$$eval('.op-console .card, .op-console #shareBlock', (els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id));
const visibleBlocks = (page) => page.$$eval('.op-console > .card, .op-console > #shareBlock, .op-console > details', (els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || (e.querySelector('.card') || {}).id || e.tagName));

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
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
  const pub = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const perr = []; pub.on('pageerror', (e) => perr.push(e.message));
  await pub.goto(BASE + '/studio');
  await pub.waitForTimeout(1200);

  // ---- IDLE on open: one Start button, nothing else (pt 2), join URL filled (pt 1) ----
  const idle = await pub.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const ju = document.getElementById('joinurl');
    return {
      startText: (document.getElementById('playSound') || {}).textContent || '',
      startVisible: vis('playSound'),
      playlistHidden: !vis('cardPlaylist'), joinHidden: !vis('cardJoin'), shareHidden: !vis('shareBlock'), stopRowHidden: !vis('stopRow'),
      stateText: (document.getElementById('state') || {}).textContent,
      joinUrl: ju ? ju.textContent : '', joinHref: ju ? ju.getAttribute('href') : '',
      advOpen: (document.getElementById('advCard') || {}).hasAttribute && document.getElementById('advCard').hasAttribute('open'),
      nudgeHidden: !vis('nudge'), goHidden: !vis('go'), playerHidden: !vis('player'), soundBtnHidden: !vis('soundBtn'),
      muteExists: !!document.getElementById('muteBtn'), mutePrimary: (document.getElementById('muteBtn') || {}).className || '',
      preset: window.__opPreview ? window.__opPreview.type : null,
    };
  });
  check('no_js_errors', perr.length === 0, perr.slice(0, 3).join(' | '));
  check('one_start_button', idle.startVisible && /Start Light Show/.test(idle.startText), 'btn="' + idle.startText.trim() + '"');
  check('idle_progressive_hidden', idle.playlistHidden && idle.joinHidden && idle.shareHidden && idle.stopRowHidden, JSON.stringify({ pl: idle.playlistHidden, jn: idle.joinHidden, sh: idle.shareHidden, stop: idle.stopRowHidden }));
  check('studio_idle_on_open', idle.stateText === 'idle', 'state=' + idle.stateText + ' (no auto-GO)');
  check('join_url_filled', /\/join\?room=[0-9a-f]{16}$/.test(idle.joinUrl || '') && idle.joinHref === idle.joinUrl, 'joinurl="' + idle.joinUrl + '"');
  check('advanced_open', !!idle.advOpen, 'advCard open=' + idle.advOpen);
  check('nudge_hidden_studio', idle.nudgeHidden, 'nudge hidden on /studio');
  check('dead_controls_hidden', idle.goHidden && idle.playerHidden && idle.soundBtnHidden, JSON.stringify({ go: idle.goHidden, player: idle.playerHidden, sound: idle.soundBtnHidden }));
  check('mute_button_small', idle.muteExists && !/primary/.test(idle.mutePrimary), 'muteBtn class="' + idle.mutePrimary + '"');
  check('live_presets_default_off', !idle.preset || idle.preset === 'off', 'Live presets default OFF (round 13 pt 8) — no reactive preset auto-applied; preset=' + idle.preset);

  // ---- click Start -> spinner -> Pause + reveal (pt 2) ----
  await pub.click('#playSound');
  const spinSeen = await pub.waitForFunction(() => { const s = document.getElementById('playSpin'); return s && getComputedStyle(s).display !== 'none'; }, { timeout: 2000 }).then(() => true).catch(() => false);
  const playing = await pub.waitForFunction(() => /Pause Light Show/.test((document.getElementById('playSound') || {}).textContent || ''), { timeout: 12000 }).then(() => true).catch(() => false);
  await pub.waitForTimeout(400);
  const afterStart = await pub.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return { btn: (document.getElementById('playSound') || {}).textContent || '', state: (document.getElementById('state') || {}).textContent, playlistVis: vis('cardPlaylist'), joinVis: vis('cardJoin'), shareVis: vis('shareBlock'), stopVis: vis('stop'), blackoutVis: vis('blackout'), stopInAdv: !!document.querySelector('.op-adv #stop') };
  });
  check('start_spinner', spinSeen, 'spinner shown on click');
  check('morph_to_pause', playing && /Pause Light Show/.test(afterStart.btn) && afterStart.state === 'running', JSON.stringify({ btn: afterStart.btn.trim(), state: afterStart.state }));
  check('reveal_after_start', afterStart.playlistVis && afterStart.joinVis && afterStart.shareVis && afterStart.stopVis && afterStart.blackoutVis, JSON.stringify(afterStart));
  check('stop_not_in_advanced', !afterStart.stopInAdv, 'STOP is a top-level control, not buried in Advanced');

  // ---- block order (pt 11) + full-width presets (pt 10) ----
  const order = await orderOf(pub);
  const idx = (id) => order.indexOf(id);
  check('block_order', idx('cardShow') >= 0 && idx('cardShow') < idx('cardPlaylist') && idx('cardPlaylist') < idx('cardJoin') && idx('cardJoin') < idx('shareBlock') && idx('shareBlock') < idx('studioCard'), 'order=' + JSON.stringify(order));
  const widths = await pub.evaluate(() => ({ studio: (document.getElementById('studioCard') || {}).getBoundingClientRect().width, playlist: (document.getElementById('cardPlaylist') || {}).getBoundingClientRect().width }));
  check('presets_full_width', widths.studio > widths.playlist * 1.6, 'studioCard ' + Math.round(widths.studio) + 'px vs playlist ' + Math.round(widths.playlist) + 'px @1440');

  // ---- /studio vs /operator parity (pt 14) ----
  const studioBlocks = await visibleBlocks(pub);
  const opCtx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS }, viewport: { width: 1440, height: 900 } });
  const op = await opCtx.newPage();
  await op.goto(BASE + '/operator');
  await op.waitForSelector('[data-arm]', { timeout: 12000 });
  const opUi = await op.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); if (!e) return false; const s = getComputedStyle(e); return s.display !== 'none'; };
    return { go: vis('go'), nudge: vis('nudge'), apps: !!document.querySelector('[data-feature="applications"]') && getComputedStyle(document.querySelector('[data-feature="applications"]')).display !== 'none', pubcfg: !!document.querySelector('[data-feature="publicConfig"]') && getComputedStyle(document.querySelector('[data-feature="publicConfig"]')).display !== 'none', startHidden: !vis('playSound'), preStart: document.getElementById('opConsole').classList.contains('pre-start') };
  });
  const opBlocks = await visibleBlocks(op);
  await b.close();
  // /studio should show the SAME blocks as /operator minus the admin-only cards (applications, publicConfig)
  const onlyOnOperator = opBlocks.filter((x) => !studioBlocks.includes(x));
  check('parity_studio_subset', onlyOnOperator.every((x) => x === 'cardApps' || x === 'cardPublicConfig' || /apps|publicConfig|application/i.test(x)), 'operator-only blocks=' + JSON.stringify(onlyOnOperator) + ' studio=' + JSON.stringify(studioBlocks));
  check('personal_intact', opUi.go && opUi.nudge && opUi.apps && opUi.pubcfg && opUi.startHidden && !opUi.preStart, 'go+nudge+apps+pubcfg visible, Start hidden, no pre-start: ' + JSON.stringify(opUi));

  fs.writeFileSync(path.join(dir, '..', 'studio_ux_report.json'), JSON.stringify({ base: BASE, idle, afterStart, order, studioBlocks, opBlocks, fails }, null, 2));
  if (fails.length) { console.error('STUDIO UX FAIL:', fails.join('; ')); process.exit(1); }
  console.log('STUDIO UX PASS: one Start->spinner->Pause with progressive reveal, idle on open (no auto-GO), join URL filled, Advanced open, Nudge hidden, small Mute, full-width presets, block order, /studio==/operator minus admin; personal intact.');
}
main().catch((e) => { console.error(e); process.exit(1); });
