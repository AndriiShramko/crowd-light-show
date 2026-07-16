// Дресс-репетиция, эмуляторное плечо (Трек E): РЕАЛЬНЫЙ Android Chrome проходит полный цикл
// шоу→prefetch→переход→attach→identify на НАСТОЯЩЕМ коде клиента (audience.js + play.js).
// Пред-условия: эмулятор загружен, adb forward tcp:9223 localabstract:chrome_devtools_remote.
// Запуск: node game/test/emulator-rehearsal.mjs
// ЧЕСТНО: host-GPU эмулятор ≠ реальный телефон; термалка/батарея/iOS — только живое событие.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';

const LSPORT = 3022;
const LS = `http://127.0.0.1:${LSPORT}`;
const LS_EMU = `http://10.0.2.2:${LSPORT}`;      // host loopback из эмулятора
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { at: new Date().toISOString(), device: 'android-emulator (real Chrome, host-GPU)', checks: {} };

// ---- локальный лайтшоу (реальный код репо, вкл. новый audience.js) ----
const ls = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, PORT: String(LSPORT), OPERATOR_PASS: 'devpass', DATA_DIR: OUT + 'ls-emu-' + Date.now() },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`${LS}/healthz`)).ok; } catch {} if (!up) await sleep(500); }
if (!up) { console.error('local lightshow did not start'); ls.kill(); process.exit(1); }

// ---- CDP к Chrome в эмуляторе ----
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const ctx = browser.contexts()[0];
let page = ctx.pages()[0];
if (!page) throw new Error('no page over CDP');

// ---- зритель: страница /join → согласие → войти в шоу ----
await page.goto(`${LS_EMU}/join?room=main`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.click('#agreeBtn', { timeout: 20000 });
await page.click('#joinScreen', { timeout: 20000 });
await page.waitForFunction(() => window.__cls && window.__cls.started && window.__cls.wsState === 1, null, { timeout: 30000 });
report.checks.joinedShow = { pass: true };

// ---- оператор: prefetch (окно 20с) ----
const login = await fetch(`${LS}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'devpass' }) }).then((r) => r.json());
const op = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
await fetch(`${LS}/api/operator/game-prefetch`, { method: 'POST', headers: op, body: JSON.stringify({ sceneUrl: 'https://game.flyreelstudio.eu/static/worlds/dubai-b5-v1.sog', windowSec: 20 }) });
await page.waitForFunction(() => window.__cls.gamePrefetch && window.__cls.gamePrefetch.ok === true, null, { timeout: 60000 });
const pf = await page.evaluate(() => window.__cls.gamePrefetch);
report.checks.prefetch = { delayMs: pf.delayMs, fetchMs: pf.ms, ok: pf.ok, pass: pf.ok === true && pf.delayMs >= 0 };

// ---- оператор: game push → РЕАЛЬНАЯ навигация страницы на прод play.html ----
await fetch(`${LS}/api/operator/game-launch`, { method: 'POST', headers: op, body: JSON.stringify({ url: 'https://game.flyreelstudio.eu/play.html?room=MAIN', inSec: 2 }) });
const goInfo = await page.evaluate(() => new Promise((res) => { const iv = setInterval(() => { if (window.__cls.gameGo) { clearInterval(iv); res(window.__cls.gameGo); } }, 100); setTimeout(() => { clearInterval(iv); res(null); }, 8000); }));
await page.waitForURL(/game\.flyreelstudio\.eu\/play\.html/, { timeout: 30000 });
report.checks.transition = { jitterMs: goInfo?.jitterMs ?? null, navigated: true, pass: true };

// ---- вход в мир → attach (магнит сервера тянет к хвосту БЕЗ ввода) → auto-join клиента ----
await page.waitForFunction(() => window.__probe && window.__probe.num != null, null, { timeout: 90000 });
await page.waitForFunction(() => window.__probe.seat >= 0, null, { timeout: 120000 });
const st = await page.evaluate(() => ({ num: window.__probe.num, seat: window.__probe.seat, mode: window.__probe.mode }));
report.checks.attach = { ...st, viaMagnetNoInput: true, pass: st.seat >= 0 };

// ---- identify: реальный тап по кнопке → паттерн ≤3 Гц + номер ----
await page.click('#bId', { timeout: 10000 });
await page.waitForFunction(() => window.__probe.identify != null, null, { timeout: 15000 });
const id = await page.evaluate(() => window.__probe.identify);
const bgs = [];
for (let i = 0; i < 8; i++) { bgs.push(await page.evaluate(() => getComputedStyle(document.getElementById('ident')).backgroundColor)); await sleep(200); }
report.checks.identify = { ...id, blinkObserved: new Set(bgs).size >= 2, pass: id.stepMs >= 334 && id.pattern > 0 && new Set(bgs).size >= 2 };

report.pass = Object.values(report.checks).every((c) => c.pass);
ls.kill();
fs.writeFileSync(OUT + 'emulator_rehearsal_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
