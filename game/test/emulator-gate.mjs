// Phase A SELF-GATE: реальный Chrome в Android-эмуляторе (host-GPU) держит 3D-мир ≥25 fps 10 минут.
// Пред-условия: эмулятор загружен, adb forward tcp:9222 localabstract:chrome_devtools_remote, Chrome открыт на BASE.
// Запуск: node game/test/emulator-gate.mjs [BASE_URL] [minutes]
// ЧЕСТНО: эмулятор рендерит на host-GPU этой машины — это НЕ реальный телефон и НЕ iPhone; термалка/батарея не покрыты.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'https://game.flyreelstudio.eu';
const MINUTES = Number(process.argv[3] || 10);
const FLOOR = 25;
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('game.flyreelstudio.eu')) || ctx.pages()[0];
if (!page) throw new Error('no page over CDP');
const probeWindow = MINUTES * 60 + 60;
const url = BASE.includes('?') ? BASE + '&fpsprobe=' + probeWindow : BASE + '/?fpsprobe=' + probeWindow;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => ['3d', '2d', 'error'].includes(document.body.dataset.mode), null, { timeout: 180000 });

const report = { base: BASE, minutes: MINUTES, device: 'android-emulator host-gpu', samples: [], at: new Date().toISOString() };
let prevFrames = await page.evaluate(() => window.__probe.frames);
let prevT = Date.now();
const t0 = Date.now();
let crashed = false;
while ((Date.now() - t0) < MINUTES * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 30000));
  try {
    const s = await page.evaluate(() => ({ f: window.__probe.frames, m: document.body.dataset.mode, e: window.__probe.errors.length }));
    const now = Date.now();
    const fps = (s.f - prevFrames) / ((now - prevT) / 1000);
    report.samples.push({ tSec: Math.round((now - t0) / 1000), fps: Math.round(fps * 10) / 10, mode: s.m, errs: s.e });
    console.log(`t=${Math.round((now - t0) / 1000)}s fps=${fps.toFixed(1)} mode=${s.m}`);
    prevFrames = s.f; prevT = now;
  } catch (e) {
    crashed = true;
    report.samples.push({ tSec: Math.round((Date.now() - t0) / 1000), crash: String(e).slice(0, 120) });
    console.log('CRASH/detach:', String(e).slice(0, 120));
    break;
  }
}
const fpsVals = report.samples.filter((s) => s.fps !== undefined).map((s) => s.fps);
const minFps = Math.min(...fpsVals);
const avgFps = fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length;
const stayed3d = report.samples.every((s) => s.mode === '3d');
report.result = {
  avgFps: Math.round(avgFps * 10) / 10, minFps, stayed3d, crashed,
  pass: !crashed && stayed3d && minFps >= FLOOR,
  honesty: 'host-GPU эмулятор; реальный iPhone/термалка/батарея НЕ покрыты — финальная валидация на живом событии',
};
fs.writeFileSync(OUT + 'emulator_gate_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.result));
process.exit(report.result.pass ? 0 : 1);
