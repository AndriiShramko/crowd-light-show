// Cat Conga — GA4 Consent Mode BASIC contract (2026-10-21). Playwright, fresh context per phase.
//   BASE=https://game.flyreelstudio.eu node game/test/ga_consent.mjs        (live: real hits, real /api/join)
//   BASE=http://game.test:3012 MAP=1 MOCK=1 node game/test/ga_consent.mjs   (local static copy; /g/collect
//        answered locally, /api/join + WS absent -> only the consent mechanics and page_view are checked)
// Checks: 0 Google requests before consent; PL labels "Akceptuję"/"Odrzucam" of equal weight; the banner does
// not cover the joystick or the buttons; Accept -> granted page_view (tid G-ETW2D67D8F); live: game_join +
// world_loaded; reload -> exactly one page_view; withdraw -> denied + ga-disable + no _ga cookies + no hits.
const PW = process.env.PW || 'E:/dev/tools/node_modules/playwright';
const { chromium } = await import(PW.endsWith('.mjs') ? PW : 'file:///' + PW.replace(/\\/g, '/') + '/index.mjs');

const BASE = (process.env.BASE || 'https://game.flyreelstudio.eu').replace(/\/$/, '');
const GA_ID = 'G-ETW2D67D8F';
const MOCK = process.env.MOCK === '1', LIVE = /^https:/.test(BASE);
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';
const GOOGLE = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|analytics\.google\.com/;
const fails = [];
const check = (n, ok, d = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d}`); if (!ok) fails.push(n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(250); } return false; }
function parseHits(url, body) {
  const shared = Object.fromEntries(new URL(url).searchParams);
  const lines = (body || '').split('\n').filter(Boolean);
  return lines.length ? lines.map((l) => Object.assign({}, shared, Object.fromEntries(new URLSearchParams(l)))) : [shared];
}
async function newCtx(browser) {
  const ctx = await browser.newContext({ locale: 'pl-PL', userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const log = { google: 0, hits: [], csp: [] };
  ctx.on('request', (q) => { if (GOOGLE.test(q.url())) log.google++; });
  if (MOCK) await ctx.route(/\/g\/collect/, (r) => { log.hits.push(...parseHits(r.request().url(), r.request().postData())); r.fulfill({ status: 204, body: '' }); });
  else ctx.on('response', (res) => { if (/\/g\/collect/.test(res.url())) for (const h of parseHits(res.url(), res.request().postData())) { h._st = res.status(); log.hits.push(h); } });
  return { ctx, log };
}
const overlap = (a, b) => a && b && !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

const args = process.env.MAP === '1' ? ['--host-resolver-rules=MAP *.test 127.0.0.1'] : [];
const browser = await chromium.launch({ headless: true, args, executablePath: process.env.CHROME || (process.env.LOCALAPPDATA + '/ms-playwright/chromium-1234/chrome-win64/chrome.exe') });
const { ctx, log } = await newCtx(browser);
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) log.csp.push(m.text().slice(0, 160)); });

// 1) play.html before consent
await page.goto(BASE + '/play.html', { waitUntil: 'load' });
await wait(4000);
check('pre_no_google', log.google === 0, `google requests=${log.google}`);
check('pre_no_datalayer', await page.evaluate(() => !window.dataLayer || window.dataLayer.length === 0));
const ui = await page.evaluate(() => {
  const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const st = (id) => { const c = getComputedStyle(document.getElementById(id)); return [c.backgroundColor, c.color, c.fontWeight, c.fontSize, c.borderTopColor, c.paddingTop].join('|'); };
  const a = document.getElementById('ccAccept'), j = document.getElementById('ccReject');
  return { acc: a && a.textContent, rej: j && j.textContent, same: !!(a && j) && st('ccAccept') === st('ccReject'),
    banner: r('ccBanner'), joy: r('joy'), btns: r('btns'), settings: !!document.getElementById('ccSettings') };
});
check('banner_labels_pl', ui.acc === 'Akceptuję' && ui.rej === 'Odrzucam', `${ui.acc} / ${ui.rej}`);
check('banner_equal_weight', ui.same);
check('banner_not_over_controls', !overlap(ui.banner, ui.joy) && !overlap(ui.banner, ui.btns), JSON.stringify({ banner: ui.banner, joy: ui.joy, btns: ui.btns }));
check('settings_link_present', ui.settings);

// 2) Accept -> granted page_view; live: game_join + world_loaded
await page.click('#ccAccept');
await until(() => log.hits.some((h) => h.en === 'page_view'));
const pv = log.hits.filter((h) => h.en === 'page_view');
check('post_page_view_granted', pv.length === 1 && /^G1.1$/.test(pv[0].gcs || '') && pv[0].tid === GA_ID && (MOCK || pv[0]._st === 204), JSON.stringify(pv.map((h) => [h.tid, h.gcs, h._st])));
const ck = (await ctx.cookies()).filter((c) => /^_ga/.test(c.name));
check('post_cookies_host_scoped', ck.length >= 1 && ck.every((c) => c.domain.replace(/^\./, '') === new URL(BASE).hostname), JSON.stringify(ck.map((c) => c.name + '@' + c.domain)));
if (LIVE) {
  // a stored consent from now on: reload so the play start / world load happen WITH consent
  const mk = log.hits.length;
  await page.reload({ waitUntil: 'load' });
  await until(() => log.hits.slice(mk).some((h) => h.en === 'world_loaded' || h.en === 'fallback_2d') && log.hits.slice(mk).some((h) => h.en === 'game_join'), 45000);
  await wait(6000);
  const ev = log.hits.slice(mk);
  check('reload_single_page_view', ev.filter((h) => h.en === 'page_view').length === 1, ev.map((h) => h.en).join(','));
  const gj = ev.find((h) => h.en === 'game_join');
  check('game_join', !!gj && /^(direct|handoff)$/.test(gj['ep.source'] || ''), gj && gj['ep.source']);
  const wl = ev.find((h) => h.en === 'world_loaded') || ev.find((h) => h.en === 'fallback_2d');
  check('world_loaded_or_fallback', !!wl, wl && JSON.stringify([wl.en, wl['ep.mode'], wl['ep.load_ms_bucket'], wl['ep.reason']]));
}

// 3) withdraw: Cookie settings -> Odrzucam
await page.click('#ccSettings');
await page.click('#ccReject');
await wait(6000);   // gtag may still flush a batch of events recorded BEFORE the click (e.g. a scroll) — not new activity
const w = await page.evaluate((id) => ({ disabled: window['ga-disable-' + id] === true, stored: localStorage.getItem('cc_consent'),
  denied: (window.dataLayer || []).some((a) => a[0] === 'consent' && a[1] === 'update' && a[2] && a[2].analytics_storage === 'denied') }), GA_ID);
const left = (await ctx.cookies()).filter((c) => /^_ga/.test(c.name));
check('withdraw_state', w.disabled && w.denied && w.stored === 'denied', JSON.stringify(w));
check('withdraw_cookies_removed', left.length === 0, JSON.stringify(left.map((c) => c.name + '@' + c.domain)));
const mark = log.hits.length;
await page.evaluate(() => window.ccGA && window.ccGA('identify_used', {}));
await page.goto(BASE + '/', { waitUntil: 'load' });
await wait(5000);
check('withdraw_no_more_hits', log.hits.length === mark, `new hits=${log.hits.length - mark} ${log.hits.slice(mark).map((h) => h.en + '@' + (h.gcs || '') + ' _et=' + (h._et || '')).join(',')}`);
check('no_csp_errors', log.csp.length === 0, log.csp.join(' | '));
await ctx.close();

// 4) index.html (world preview): pre 0 Google, Accept -> page_view
const p2 = await newCtx(browser);
const pg2 = await p2.ctx.newPage();
await pg2.goto(BASE + '/', { waitUntil: 'load' });
await wait(3000);
check('index_pre_no_google', p2.log.google === 0, `google=${p2.log.google}`);
await pg2.click('#ccAccept');
await until(() => p2.log.hits.some((h) => h.en === 'page_view'));
check('index_post_page_view', p2.log.hits.some((h) => h.en === 'page_view' && /^G1.1$/.test(h.gcs || '') && h.tid === GA_ID));
await p2.ctx.close();
await browser.close();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL OK');
process.exit(fails.length ? 1 : 0);
