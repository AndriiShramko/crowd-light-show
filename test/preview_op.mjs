// Round-8A: the operator console shows a LIVE preview of what the crowd's screen does as
// the operator turns each preset/param — rendered through the EXACT phone pipeline
// (CLS_PRESETS + clampColor + makeBackstop), so it is safety-governed (<=3 flashes/s) and
// is NOT a bypass. Proven by FACT against a running server: window.CLS_PRESETS is defined
// on /operator (it did not even load presets.js before), the preview updates when the
// preset changes (canvas-diff via hue character) and when a slider moves (changeSeq), and
// the preview's own flash-rate stays <=3/s.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };
const pv = (page) => page.evaluate(() => Object.assign({}, window.__opPreview));

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ httpCredentials: { username: 'operator', password: PASS } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 401|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
  await page.goto(BASE + '/operator');
  await page.waitForFunction(() => document.querySelectorAll('#presetBtns button').length > 0, { timeout: 15000 });

  // 1) the engine is actually present on /operator (it wasn't loaded here before 8A)
  const hasEngine = await page.evaluate(() => !!(window.CLS_PRESETS && window.CLS_PRESETS.PRESETS && window.CLS_PRESETS.makeBackstop));
  check('cls_presets_on_operator', hasEngine, 'window.CLS_PRESETS defined on /operator: ' + hasEngine);

  const pick = (type) => page.evaluate((t) => { const b = [...document.querySelectorAll('#presetBtns button')].find((x) => x.getAttribute('data-preset') === t); if (b) b.click(); }, type);

  // 2) pick Pulse -> preview animates, governed <=3/s, fixed-hue (small hue spread)
  await pick('pulse'); await sleep(1400);
  const a = await pv(page);
  check('preview_pulse_renders', a.ready && a.type === 'pulse' && a.frames > 15 && (a.maxLum - a.minLum) > 0.02,
    `pulse preview: ready=${a.ready} type=${a.type} frames=${a.frames} swing=${(a.maxLum - a.minLum).toFixed(3)} hueSpread=${a.hueSpread.toFixed(0)}`);
  check('preview_pulse_governed', a.flashesPerSec <= 3, `pulse preview flashesPerSec=${a.flashesPerSec} (<=3)`);

  // 3) switch to Rainbow Chase -> preview CHANGES (rainbow sweeps many hues; canvas-diff
  // proven by hue spread jumping far above pulse's fixed hue), still governed <=3/s
  await pick('rainbow_chase'); await sleep(2300);
  const b = await pv(page);
  check('preview_changes_on_preset', b.type === 'rainbow_chase' && b.frames > 10 && (b.hueSpread - a.hueSpread) > 40,
    `rainbow preview: type=${b.type} frames=${b.frames} hueSpread=${b.hueSpread.toFixed(0)} vs pulse ${a.hueSpread.toFixed(0)} (diff>40 = canvas changed character)`);
  check('preview_rainbow_governed', b.flashesPerSec <= 3, `rainbow preview flashesPerSec=${b.flashesPerSec} (<=3)`);

  // 4) move a slider -> the preview reflects it (changeSeq advances; preview reads activeParams live)
  const seq0 = (await pv(page)).changeSeq;
  const moved = await page.evaluate(() => {
    const inp = document.querySelector('#presetParams input[type=range]');
    if (!inp) return false;
    inp.value = inp.max; inp.dispatchEvent(new Event('input', { bubbles: true })); return true;
  });
  await sleep(700);
  const seq1 = (await pv(page)).changeSeq;
  check('preview_reacts_to_slider', moved && seq1 > seq0, `slider moved=${moved}, changeSeq ${seq0} -> ${seq1}`);

  check('no_js_errors', errors.length === 0, errors.length ? errors.join(' | ') : 'no console/page errors');
  await browser.close();
  fs.writeFileSync(path.join(dir, '..', 'preview_op_report.json'), JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('PREVIEW OP FAIL:', report.fails.join('; ')); process.exit(1); }
  console.log('PREVIEW OP PASS: CLS_PRESETS on /operator, preview renders + changes per preset (hue-diff) + reacts to sliders, governed <=3/s, no JS errors.');
}
main().catch((e) => { console.error('PREVIEW OP ERROR:', e); process.exit(1); });
