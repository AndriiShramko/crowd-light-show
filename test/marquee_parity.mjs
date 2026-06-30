// ROUND 12 — pt 4. The owner's scrolling marquee must reach the /try DEMO phones (it only showed in
// /studio rooms before), and BOTH consoles must have an identical LIVE marquee control: /operator can
// push scrolling text to the owner's invited (main-show) audience, /studio to its room — same control,
// same code. Text-only overlay, so the epilepsy flash cap can never be perturbed.
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
  // owner sets the DEFAULT scrolling text in Public console defaults
  const DEF = 'WELCOME TO BYDGOSZCZ ✨';
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ marquee_text: DEF }) }).then(j);

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---- pt 4a: the /try DEMO phone now receives the owner's default marquee ----
  const demo = await (await b.newContext()).newPage();
  await demo.goto(`${BASE}/join?demo=1&auto=1`);
  await demo.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await demo.waitForFunction(() => window.__cls && window.__cls.marquee, { timeout: 8000 }).catch(() => {});
  const demoMq = await demo.evaluate(() => ({ cls: window.__cls.marquee, vis: !document.getElementById('marquee').classList.contains('hidden') }));
  check('demo_gets_default_marquee', demoMq.cls === DEF && demoMq.vis, 'demo /try marquee=' + JSON.stringify(demoMq));

  // ---- pt 4b: a LIVE marquee control on /operator reaches the MAIN (invited) audience ----
  const mainPh = await (await b.newContext()).newPage();
  await mainPh.goto(`${BASE}/join?auto=1`); // no room/demo => MAIN show audience (the owner's /join?s=<code> crowd)
  await mainPh.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  const opCtx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS }, viewport: { width: 1280, height: 900 } });
  const op = await opCtx.newPage();
  await op.goto(BASE + '/operator');
  await op.waitForSelector('#marqueeCtl', { timeout: 12000 });
  const opCtlVisible = await op.evaluate(() => { const e = document.getElementById('marqueeCtl'); return !!e && getComputedStyle(e).display !== 'none' && !!document.getElementById('mqLive') && !!document.getElementById('mqSend'); });
  check('operator_has_marquee_control', opCtlVisible, 'the live marquee control is present + visible on /operator');
  const LIVE = 'NEXT SONG: Bohemian Rhapsody 🎸';
  await op.fill('#mqLive', LIVE);
  await op.click('#mqSend');
  await sleep(900);
  const mainMq = await mainPh.evaluate(() => ({ cls: window.__cls.marquee, vis: !document.getElementById('marquee').classList.contains('hidden') }));
  check('operator_marquee_reaches_main', mainMq.cls === LIVE && mainMq.vis, 'main-audience marquee after /operator Send=' + JSON.stringify(mainMq));

  // ---- pt 4c: the SAME control exists on /studio (identical to /operator) ----
  const studio = await (await b.newContext()).newPage();
  await studio.goto(BASE + '/studio');
  await studio.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  await studio.click('#playSound').catch(() => {}); // reveal the console (Live presets is in Advanced)
  await studio.waitForTimeout(500);
  const studioCtl = await studio.evaluate(() => { const e = document.getElementById('marqueeCtl'); return !!e && !!document.getElementById('mqLive') && !!document.getElementById('mqSend'); });
  check('studio_has_same_marquee_control', studioCtl, 'the identical live marquee control is present on /studio too');

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'marquee_parity_report.json'), JSON.stringify({ base: BASE, demoMq, mainMq, fails }, null, 2));
  if (fails.length) { console.error('MARQUEE PARITY FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('MARQUEE PARITY PASS: the default marquee now reaches /try demo phones; a live marquee control on /operator pushes scrolling text to the invited (main) audience; the same control exists on /studio.');
}
main().catch((e) => { console.error(e); process.exit(1); });
