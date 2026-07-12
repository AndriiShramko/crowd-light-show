// Phase A smoke harness (spec-verify §A пп.4–7 + CPU-throttle probe для self-gate).
// Запуск: node game/test/smoke.mjs [BASE_URL]   (по умолчанию http://localhost:8124)
// ЧЕСТНО: headless = SwiftShader, это smoke/логика, НЕ перф реального телефона.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8124';
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });

const MOBILE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
};
const report = { base: BASE, at: new Date().toISOString(), checks: {} };
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });

async function pixelStats(page) {
  return page.evaluate(() => {
    const src = document.querySelector('#stage canvas'); if (!src) return null;
    if (window.__renderOnce) window.__renderOnce();
    const w = 64, h = 64, cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let nonblack = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) nonblack++;
    return { nonblackPct: Math.round(nonblack / (w * h) * 100) };
  });
}
const errsOf = (page) => { const a = []; page.on('pageerror', (e) => a.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') a.push(m.text()); }); return a; };

// ---- 4. smoke: мир грузится, splatCount>0, скрин не чёрный, 0 JS-ошибок ----
{
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  const jsErrors = errsOf(page);
  await page.goto(BASE + '/?fpsprobe=5', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => ['3d', '2d', 'error'].includes(document.body.dataset.mode), null, { timeout: 90000 });
  await page.waitForTimeout(7000); // окно fps-пробы
  const probe = await page.evaluate(() => window.__probe);
  const px = await pixelStats(page);
  await page.screenshot({ path: OUT + 'smoke-3d.png' });
  report.checks.smoke = {
    mode: probe.mode, splatCount: probe.splatCount, worldBytes: probe.worldBytes,
    fps_swiftshader: probe.fps, nonblackPct: px && px.nonblackPct, jsErrors,
    pass: probe.splatCount > 0 && (px?.nonblackPct ?? 0) >= 5 && jsErrors.length === 0 && ['3d', '2d'].includes(probe.mode),
    note: 'headless SwiftShader — smoke, не перф',
  };
  // ---- 5. reload из Cache API без сети ----
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 30000 }).catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }); // второй заход: SW уже контролирует
  await page.waitForFunction(() => ['3d', '2d', 'error'].includes(document.body.dataset.mode), null, { timeout: 60000 });
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  let offlineOk = false, offProbe = null, px2 = null;
  try {
    await page.waitForFunction(() => ['3d', '2d'].includes(document.body.dataset.mode), null, { timeout: 60000 });
    await page.waitForTimeout(3000); // дать SwiftShader презентовать кадр
    offProbe = await page.evaluate(() => window.__probe);
    px2 = await pixelStats(page);
    // Доказательство Cache API = мир распарсен БЕЗ сети (splatCount>0); пиксели — advisory (доказаны в smoke).
    offlineOk = offProbe.splatCount > 0 && offProbe.worldBytes > 0 && ['3d', '2d'].includes(offProbe.mode);
    await page.screenshot({ path: OUT + 'offline-reload.png' });
  } catch { /* fail */ }
  report.checks.offlineReload = { pass: offlineOk, mode: offProbe?.mode, splatCount: offProbe?.splatCount, worldBytes: offProbe?.worldBytes, nonblackPct: px2?.nonblackPct ?? null };
  await ctx.close();
}

// ---- 6. сервер сплатов недоступен у свежего клиента → внятная ошибка ----
{
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  await ctx.route('**/static/worlds/**', (r) => r.abort());
  await page.goto(BASE + '/?fpsprobe=5', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.mode === 'error', null, { timeout: 60000 });
  const errShown = await page.evaluate(() => getComputedStyle(document.getElementById('err')).display !== 'none');
  const retryVisible = await page.evaluate(() => !!document.getElementById('retry'));
  await page.screenshot({ path: OUT + 'world-error.png' });
  report.checks.worldUnavailable = { pass: errShown && retryVisible, errShown, retryVisible };
  await ctx.close();
}

// ---- 7. FPS-probe → 2D (форс-флагом) ----
{
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  await page.goto(BASE + '/?force2d=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.mode === '2d', null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  const px = await page.evaluate(() => {
    const cv = document.querySelector('#stage canvas'); const ctx2 = cv.getContext('2d');
    const d = ctx2.getImageData(0, 0, cv.width, cv.height).data;
    let nb = 0; for (let i = 0; i < d.length; i += 400) if (d[i] + d[i + 1] + d[i + 2] > 24) nb++;
    return nb;
  });
  await page.screenshot({ path: OUT + 'fallback-2d.png' });
  report.checks.fallback2d = { pass: px > 0, sampledLitPixels: px };
  await ctx.close();
}

// ---- self-gate доп. точка: CPU-throttle ×6, fps за 10 c (SwiftShader!) ----
{
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.goto(BASE + '/?fpsprobe=10', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__probe && window.__probe.fps !== null || document.body.dataset.mode === '2d', null, { timeout: 120000 }).catch(() => {});
  const probe = await page.evaluate(() => window.__probe);
  report.checks.cpuThrottle6x = { fps: probe?.fps, endMode: probe?.mode, note: 'SwiftShader+throttle — консервативная нижняя граница, не реальный GPU' };
  await ctx.close();
}

await browser.close();
const pass = Object.values(report.checks).every((c) => c.pass !== false);
report.pass = pass;
fs.writeFileSync(OUT + 'smoke_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
