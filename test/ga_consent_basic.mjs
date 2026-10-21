// GA4 Consent Mode BASIC contract (2026-10-21, WEB-TECH-BASELINE §T6) — replaces the round-10
// expectation in ga_consent.mjs that gtag.js loads before consent (that was ADVANCED mode, forbidden).
// Negative control: run against the round-10 partial (git show 4114c1e:public/partials/ga.html) and
// it must FAIL at "pre: 0 Google requests".
//   BASE=http://lightshow.test:3011 MAP=1 MOCK=1 FORM=1 node test/ga_consent_basic.mjs   (local; MAP maps
//        *.test to 127.0.0.1 so cookie_domain works; MOCK answers /g/collect locally — nothing reaches
//        Google; FORM=1 submits the lead form against a MOCKED /api/apply)
//   BASE=https://lightshow.flyreelstudio.eu node test/ga_consent_basic.mjs  (live; real hits, no form submit)
import { chromium } from 'playwright';

const BASE = (process.env.BASE || 'http://lightshow.test:3011').replace(/\/$/, '');
const GA_ID = 'G-46C2GKVHPR';
const MOCK = process.env.MOCK === '1', FORM = process.env.FORM === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const GOOGLE = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|analytics\.google\.com/;
const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail}`); if (!ok) fails.push(name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// gtag batches events and flushes every few seconds — poll instead of guessing a fixed delay
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(250); } return false; }

function parseHits(url, body) {
  const u = new URL(url); const shared = Object.fromEntries(u.searchParams);
  const lines = (body || '').split('\n').filter(Boolean);
  if (!lines.length) return [shared];
  return lines.map((l) => Object.assign({}, shared, Object.fromEntries(new URLSearchParams(l))));
}

async function newCtx(browser, locale = 'pl-PL') {
  const ctx = await browser.newContext({ locale, userAgent: UA, viewport: { width: 1366, height: 900 } });
  const log = { google: 0, hits: [], csp: [], errors: [] };
  ctx.on('request', (q) => { if (GOOGLE.test(q.url())) log.google++; });
  if (MOCK) await ctx.route(/\/g\/collect/, (r) => { log.hits.push(...parseHits(r.request().url(), r.request().postData())); r.fulfill({ status: 204, body: '' }); });
  else ctx.on('response', (res) => { if (/\/g\/collect/.test(res.url())) for (const h of parseHits(res.url(), res.request().postData())) { h._st = res.status(); log.hits.push(h); } });
  await ctx.route(/\/api\/apply$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));   // never a real lead
  return { ctx, log };
}
const evs = (log, from = 0) => log.hits.slice(from).map((h) => h.en);

(async () => {
  const args = process.env.MAP === '1' ? ['--host-resolver-rules=MAP *.test 127.0.0.1'] : [];
  if (process.env.VIDEO === '1') args.push('--autoplay-policy=no-user-gesture-required');   // headless: let the clicked embed actually start
  const browser = await chromium.launch({ headless: true, args, executablePath: process.env.CHROME || (process.env.LOCALAPPDATA + '/ms-playwright/chromium-1234/chrome-win64/chrome.exe') });
  const { ctx, log } = await newCtx(browser);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') (/Content Security Policy/i.test(m.text()) ? log.csp : log.errors).push(m.text().slice(0, 160)); });

  // 1) before consent: nothing to Google, no dataLayer, banner with equal buttons + PL labels, settings link
  await page.goto(BASE + '/?lang=pl', { waitUntil: 'load' });
  await wait(3500);
  check('pre_no_google', log.google === 0, `google requests=${log.google}`);
  check('pre_no_datalayer', await page.evaluate(() => !window.dataLayer || window.dataLayer.length === 0));
  const btn = await page.evaluate(() => {
    const a = document.getElementById('clsCookieAcc'), r = document.getElementById('clsCookieRej');
    if (!a || !r) return null;
    const s = (el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.color, c.fontWeight, c.fontSize, c.borderTopColor, c.paddingTop, el.offsetHeight].join('|'); };
    return { acc: a.textContent, rej: r.textContent, same: s(a) === s(r), settings: !!document.getElementById('clsCookieSettings') };
  });
  check('banner_labels_pl', btn && btn.acc === 'Akceptuję' && btn.rej === 'Odrzucam', JSON.stringify(btn));
  check('banner_equal_weight', btn && btn.same);
  check('settings_link_before_choice', btn && btn.settings);

  // 2) Accept -> granted page_view with the right tid
  await page.click('#clsCookieAcc');
  await until(() => log.hits.some((h) => h.en === 'page_view'));
  await wait(1500);
  const pv = log.hits.filter((h) => h.en === 'page_view');
  check('post_page_view_granted', pv.length === 1 && /^G1.1$/.test(pv[0].gcs || '') && pv[0].tid === GA_ID, JSON.stringify(pv.map((h) => [h.tid, h.gcs, h._st])));
  check('post_site_lang', pv[0] && pv[0]['ep.site_lang'] === 'pl', pv[0] && pv[0]['ep.site_lang']);
  const cookies = (await ctx.cookies()).filter((c) => /^_ga/.test(c.name));
  check('post_cookies_host_scoped', cookies.length >= 1 && cookies.every((c) => c.domain.replace(/^\./, '') === new URL(BASE).hostname), JSON.stringify(cookies.map((c) => c.name + '@' + c.domain)));

  // 3) detailed events
  let mark = log.hits.length;
  for (let y = 0; y < 14; y++) { await page.mouse.wheel(0, 700); await wait(250); }
  await until(() => log.hits.slice(mark).filter((h) => h.en === 'section_view').length >= 6);
  const sv = log.hits.slice(mark).filter((h) => h.en === 'section_view').map((h) => h['ep.section_id']);
  check('section_view_once_each', sv.length >= 4 && new Set(sv).size === sv.length, sv.join(','));
  await page.evaluate(() => window.addEventListener('click', (e) => { if (e.target.closest('a[href^="tel:"],a[href^="mailto:"],a[href*="github.com"],a[href*="linkedin.com"]')) e.preventDefault(); }));
  mark = log.hits.length;
  await page.click('.m-nav a[href*="github.com"]');
  await page.click('a[href^="tel:"]');
  await page.click('a[href^="mailto:"]', { strict: false }).catch(() => page.locator('a[href^="mailto:"]').first().click());
  await page.locator('#cls-lang button[data-lang="en"]').click();
  await until(() => log.hits.slice(mark).some((h) => h.en === 'lang_switch'));
  const ev2 = log.hits.slice(mark);
  const find = (en, k, v) => ev2.find((h) => h.en === en && (!k || h['ep.' + k] === v));
  check('cta_click_github', !!find('cta_click', 'cta_id', 'github'), JSON.stringify(ev2.map((h) => [h.en, h['ep.cta_id'], h['ep.cta_location'], h['ep.method']])));
  check('contact_click_phone', !!find('contact_click', 'method', 'phone'));
  check('contact_click_email', !!find('contact_click', 'method', 'email'));
  check('lang_switch_en', !!find('lang_switch', 'lang_to', 'en'));
  mark = log.hits.length;
  // GA4 Enhanced Measurement sends form_start on the first CHANGE of a form field (typing + leaving it);
  // focus alone, or typing and clearing again, does not count
  await page.locator('#lc-name').pressSequentially('T');
  await page.locator('#lc-email').focus();
  if (FORM) {
    await page.fill('#lc-name', 'Test');
    await page.fill('#lc-email', 'test@example.com');
    await page.click('#lc-send');
  }
  await page.addScriptTag({ content: 'setTimeout(function(){ null.clsTestBoom(); }, 10);' });
  await until(() => log.hits.slice(mark).some((h) => h.en === 'exception') && log.hits.slice(mark).some((h) => h.en === 'form_start') && (!FORM || log.hits.slice(mark).some((h) => h.en === 'generate_lead')));
  const ev3 = log.hits.slice(mark);
  // form_start comes from GA Enhanced Measurement (form interactions) — exactly one, no manual duplicate
  check('form_start_once', log.hits.filter((h) => h.en === 'form_start').length === 1 && !!ev3.find((h) => h.en === 'form_start' && h['ep.form_id'] === 'leadForm'), ev3.map((h) => h.en).join(','));
  if (FORM) {
    check('form_submit', !!ev3.find((h) => h.en === 'form_submit' && h['ep.form_id'] === 'leadForm'));
    const gl = ev3.find((h) => h.en === 'generate_lead');
    check('generate_lead_after_200', !!gl && gl['ep.form_id'] === 'leadForm' && !/@|Test/.test(JSON.stringify(gl)), JSON.stringify(gl || {}).slice(0, 200));
  }
  const ex = ev3.find((h) => h.en === 'exception');
  check('exception_own_js', !!ex && (ex['ep.description'] || '').length <= 100, ex && ex['ep.description']);
  const anyPII = log.hits.some((h) => /test@example\.com/.test(JSON.stringify(h)));
  check('no_pii_in_hits', !anyPII);
  check('no_value_or_ua_leftovers', !log.hits.some((h) => h['ep.value'] != null || h['ep.anonymize_ip'] != null || h['ep.page_path'] != null));

  // 4) reload with stored consent: exactly ONE page_view
  mark = log.hits.length;
  await page.goto(BASE + '/about', { waitUntil: 'load' });
  await until(() => log.hits.slice(mark).some((h) => h.en === 'page_view' && /\/about/.test(h.dl || '')));
  await wait(6000);   // a duplicate page_view (manual + config) would arrive in the same window
  const pv2 = log.hits.slice(mark).filter((h) => h.en === 'page_view');
  const pvAbout = log.hits.slice(mark).filter((h) => h.en === 'page_view' && /\/about/.test(h.dl || ''));
  check('reload_single_page_view', pvAbout.length === 1 && pv2.length === 1 && /^G1.1$/.test(pv2[0].gcs || ''), `page_view count=${pv2.length} gcs=${pv2.map((h) => h.gcs)}`);
  check('reload_no_banner', await page.evaluate(() => !document.getElementById('clsCookie')));

  // 5) withdraw: footer link -> Reject
  await page.click('#clsCookieSettings');
  await page.click('#clsCookieRej');
  await wait(800);
  const w = await page.evaluate((id) => ({
    disabled: window['ga-disable-' + id] === true,
    denied: (window.dataLayer || []).some((a) => a[0] === 'consent' && a[1] === 'update' && a[2] && a[2].analytics_storage === 'denied'),
    stored: localStorage.getItem('cls_consent'), cookie: document.cookie,
  }), GA_ID);
  const left = (await ctx.cookies()).filter((c) => /^_ga/.test(c.name));
  check('withdraw_state', w.disabled && w.denied && w.stored === 'denied', JSON.stringify(w));
  check('withdraw_cookies_removed', left.length === 0, JSON.stringify(left.map((c) => c.name + '@' + c.domain)));
  mark = log.hits.length;
  for (let y = 0; y < 6; y++) { await page.mouse.wheel(0, 600); await wait(200); }
  await page.locator('a[href="/"]').first().click({ trial: true }).catch(() => {});
  await page.evaluate(() => window.clsGA && window.clsGA('cta_click', { cta_id: 'after_withdraw' }));
  await wait(3000);
  check('withdraw_no_more_hits', log.hits.length === mark, `new hits=${log.hits.length - mark}`);
  await page.goto(BASE + '/try', { waitUntil: 'load' });
  await wait(3000);
  check('withdraw_next_page_quiet', log.hits.length === mark, `new hits=${log.hits.length - mark}`);
  await ctx.close();

  // 6) /studio before consent: no console events, no Google; /join: never GA, never a banner
  const s = await newCtx(browser);
  const p2 = await s.ctx.newPage();
  await p2.goto(BASE + '/studio', { waitUntil: 'load' });
  await wait(4000);
  check('studio_pre_no_google', s.log.google === 0 && s.log.hits.length === 0, `google=${s.log.google}`);
  await p2.click('#clsCookieAcc');
  await until(() => s.log.hits.some((h) => h.en === 'page_view'));
  check('studio_post_page_view', s.log.hits.some((h) => h.en === 'page_view' && /^G1.1$/.test(h.gcs || '')), evs(s.log).join(','));
  const mk = s.log.hits.length;
  await p2.reload({ waitUntil: 'load' });
  await until(() => evs(s.log, mk).includes('studio_open') && evs(s.log, mk).includes('page_view'));
  await wait(6000);
  const after = evs(s.log, mk);
  check('studio_reload_one_pv_and_studio_open', after.filter((e) => e === 'page_view').length === 1 && after.includes('studio_open'), after.join(','));
  const ps = await s.ctx.newPage();
  await ps.goto(BASE + '/join?demo=1', { waitUntil: 'load' });
  await wait(2500);
  check('join_no_ga', await ps.evaluate(() => !document.getElementById('clsCookie') && !window.clsGA && !document.querySelector('script[src*="googletagmanager"]')));
  await s.ctx.close();

  // 7) optional: a user-started YouTube embed sends video_play {video_id} (VIDEO=1; needs YouTube reachable)
  if (process.env.VIDEO === '1') {
    const v = await newCtx(browser, 'en-US');   // the embed shows a click-through overlay for some locales
    const p3 = await v.ctx.newPage();
    await p3.goto(BASE + '/?lang=en', { waitUntil: 'load' });
    await p3.click('#clsCookieAcc');
    await p3.locator('#wild').scrollIntoViewIfNeeded();
    await wait(5000);
    for (let k = 0; k < 3 && !v.log.hits.some((h) => h.en === 'video_play'); k++) {
      await p3.frameLocator('.m-vid iframe').first().locator('.ytp-large-play-button, button[aria-label*="Play"]').first().click({ timeout: 20000 }).catch((e) => console.log('NOTE play click', String(e).slice(0, 100)));
      await until(() => v.log.hits.some((h) => h.en === 'video_play'), 15000);
    }
    const vp = v.log.hits.find((h) => h.en === 'video_play');
    check('video_play_youtube', !!vp && /^[\w-]{11}$/.test(vp['ep.video_id'] || ''), vp && vp['ep.video_id']);
    await v.ctx.close();
  }

  check('no_csp_errors', log.csp.length === 0, log.csp.join(' | '));
  await browser.close();
  console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL OK');
  process.exit(fails.length ? 1 : 0);
})();
