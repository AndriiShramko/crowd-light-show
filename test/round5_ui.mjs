// Round-5 UI, verified by FACT:
//  A) After Stop the audience returns to the consent "main menu" with the checkbox
//     ALREADY ticked and Join enabled — one tap to rejoin, no re-consent.
//  B) The "turn on the flashlight" button is light-blue (accent-blue).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const dir = path.dirname(fileURLToPath(import.meta.url));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch();

  // ---- A) Stop -> consent with checkbox pre-checked -> one-tap rejoin ----
  const a = await (await browser.newContext()).newPage();
  await a.goto(`${BASE}/join?auto=1`);
  await a.waitForFunction(() => window.__cls && window.__cls.started, { timeout: 15000 });
  await a.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {});
  await a.evaluate(() => window.__clsLeave());            // press Stop
  await sleep(300);
  const afterStop = await a.evaluate(() => ({
    consentVisible: !document.getElementById('consent').classList.contains('hidden'),
    liveHidden: document.getElementById('live').classList.contains('hidden'),
    agreeChecked: document.getElementById('agree').checked,
    joinEnabled: !document.getElementById('joinScreen').disabled,
    started: window.__cls.started,
  }));
  check('A_stop_returns_to_menu_checked',
    afterStop.consentVisible && afterStop.liveHidden && afterStop.agreeChecked && afterStop.joinEnabled && !afterStop.started,
    `consent=${afterStop.consentVisible} liveHidden=${afterStop.liveHidden} agreeChecked=${afterStop.agreeChecked} joinEnabled=${afterStop.joinEnabled} started=${afterStop.started}`);
  // one tap rejoins (no re-checking the box)
  await a.click('#joinScreen');
  await sleep(300);
  const rejoined = await a.evaluate(() => window.__cls.started && !document.getElementById('live').classList.contains('hidden'));
  check('A_one_tap_rejoin', rejoined, `rejoined=${rejoined}`);
  await a.close();

  // ---- B) flashlight button is light-blue ----
  const b = await (await browser.newContext()).newPage();
  await b.goto(`${BASE}/join`);
  await sleep(300);
  const torch = await b.evaluate(() => {
    const el = document.getElementById('joinTorch');
    el.classList.remove('hidden');                       // force-show (normally Android-only) to read its colour
    const cs = getComputedStyle(el);
    return { cls: el.className, bg: cs.backgroundColor };
  });
  // #2bc0ee === rgb(43, 192, 238)
  check('B_torch_is_blue', /accent-blue/.test(torch.cls) && torch.bg === 'rgb(43, 192, 238)',
    `class="${torch.cls}" bg=${torch.bg} (expect rgb(43, 192, 238))`);
  await b.close();
  await browser.close();

  fs.writeFileSync(path.join(dir, '..', 'round5_ui_report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('\nROUND5 UI FAIL: ' + report.fails.join(' | ')); process.exit(1); }
  console.log('\nROUND5 UI PASS: Stop returns to a pre-checked menu (one-tap rejoin); flashlight button is light-blue.');
}
main().catch((e) => { console.error(e); process.exit(1); });
