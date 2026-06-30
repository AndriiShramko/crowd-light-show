// ROUND 14 — the VJ pult WIDGETS (not just the API) drive the crowd. Open /studio, toggle the pult on,
// drag a widget, click a palette preset, flip the mode — and prove each reaches a real phone over the
// room WS. Mirrors seek_mute.mjs.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3080';
const dir = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room && window.__opVJ, { timeout: 12000 });
  const sess = await con.evaluate(() => window.__SESSION__);
  // press Start so the progressive-reveal cards (incl. the VJ pult) appear, then expand the pult panel
  await con.click('#playSound').catch(() => {});
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});
  await con.evaluate(() => { const d = document.getElementById('vjAdv'); if (d) d.open = true; });
  await sleep(300);

  // the pult card + 4 tabs + widgets exist
  const ui = await con.evaluate(() => ({ card: !!document.getElementById('vjCard'), tabs: document.querySelectorAll('#vjTabs button[data-vjtab]').length, stageKids: document.querySelectorAll('#vjStage *').length }));
  check('pult_renders', ui.card && ui.tabs === 4 && ui.stageKids > 0, `card=${ui.card} tabs=${ui.tabs} stageKids=${ui.stageKids}`);

  // a phone in this room
  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(500);

  // enable manual control
  await con.click('#vjEnable');
  await sleep(400);
  const en = await con.evaluate(() => window.__opVJ.on);
  const phOn = await ph.evaluate(() => window.__cls.manual && window.__cls.manual.on);
  check('enable_reaches_phone', en === true && phOn === true, `console.on=${en} phone.on=${phOn}`);

  // switch to the XY pad tab and DRAG it -> sets hue (x) + brightness (y); the phone must get that hue.
  // Dispatch real PointerEvents with an explicit clientX (75% width -> hue ~270) into the widget.
  await con.click('#vjTabs button[data-vjtab="xy"]');
  await sleep(250);
  await con.evaluate(() => {
    const xy = document.querySelectorAll('#vjStage > div > *')[1];
    const r = xy.getBoundingClientRect();
    const o = { clientX: r.left + r.width * 0.75, clientY: r.top + r.height * 0.5, pointerId: 1, bubbles: true };
    xy.dispatchEvent(new PointerEvent('pointerdown', o));
    xy.dispatchEvent(new PointerEvent('pointermove', o));
    xy.dispatchEvent(new PointerEvent('pointerup', o));
  });
  await sleep(500);
  const conHue = await con.evaluate(() => window.__opVJ.hue);
  const phHue = await ph.evaluate(() => window.__cls.manual.hue);
  check('xy_drag_reaches_phone', Math.abs(conHue - 270) < 40 && Math.abs(phHue - conHue) < 5, `console hue=${conHue.toFixed(0)} (~270) phone hue=${phHue.toFixed(0)}`);

  // a palette preset (Ukraine = 2 colours) must reach the phone
  await con.evaluate(() => { const btns = [...document.querySelectorAll('#vjPalPresets button')]; const u = btns.find((x) => /Ukraine/.test(x.textContent)); if (u) u.click(); });
  await sleep(500);
  const pal = await ph.evaluate(() => window.__cls.palette);
  check('palette_preset_reaches_phone', pal && pal.on && pal.colors.length === 2, `phone palette=${JSON.stringify(pal)}`);

  // mode toggle -> 'full'
  await con.click('#vjModeBtn');
  await sleep(400);
  const md = await ph.evaluate(() => window.__cls.manual.mode);
  check('mode_toggle_reaches_phone', md === 'full', `phone mode=${md}`);

  // fullscreen button + MIDI connect button present (capability, not invoked headless)
  const caps = await con.evaluate(() => ({ full: !!document.getElementById('vjFull'), midi: !!document.getElementById('vjMidiConnect') }));
  check('fullscreen_and_midi_present', caps.full && caps.midi, JSON.stringify(caps));

  // turn the pult OFF -> phone manual.on false (req: the block can be disabled)
  await con.click('#vjEnable');
  await sleep(400);
  const offPh = await ph.evaluate(() => window.__cls.manual.on);
  check('disable_reaches_phone', offPh === false, `phone manual.on=${offPh}`);

  await b.close();
  if (fails.length) { console.error('MANUAL UI FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('MANUAL UI PASS: pult renders (4 tabs), enable/XY-drag/palette-preset/mode/disable all reached a real phone; fullscreen + MIDI controls present.');
}
main().catch((e) => { console.error(e); process.exit(1); });
