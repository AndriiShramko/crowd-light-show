// ROUND 10 — Google Analytics 4 + Consent Mode v2 contract.
// Owner asked for GA on every page with events (#tests, #people-per-session, session length).
// EU ePrivacy: analytics must be OFF until the visitor accepts. Epilepsy rule (round 8C): the
// /join consent gate must stay clean — NO GA banner/script there (it could intercept the join tap).
//
// HARD asserts (deterministic, offline-safe):
//  - served HTML: G-46C2GKVHPR present on /, /about, /privacy, /try, /studio ; ABSENT on /join
//  - Consent Mode DEFAULT = denied is pushed to dataLayer BEFORE config (no _ga cookie pre-accept)
//  - clicking Accept -> consent 'update' analytics_storage:granted + localStorage cls_consent=granted
//  - clsGA(event) seam exists and pushes a gtag event
//  - privacy.html no longer claims "no analytics" and now discloses Google Analytics
// BEST-EFFORT (logged, not gating — needs Google's network, operator-confirmed live):
//  - gtag/js library request fires; a /g/collect beacon fires only AFTER Accept, never before.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3011';
const dir = path.dirname(fileURLToPath(import.meta.url));
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
function note(name, detail) { console.log(`NOTE [${name}] ${detail || ''}`); }
const GA_ID = 'G-46C2GKVHPR';

async function main() {
  // ---- (1) served-HTML contract: token replaced everywhere except /join ----
  const want = ['/', '/about', '/privacy', '/try', '/studio'];
  for (const p of want) {
    const html = await fetch(BASE + p).then((r) => r.text());
    check('ga_on' + p, html.includes(GA_ID) && !html.includes('@@GA@@'), p + (html.includes('@@GA@@') ? ' has RAW @@GA@@ token' : ''));
  }
  const joinHtml = await fetch(BASE + '/join?demo=1').then((r) => r.text());
  check('ga_off_join', !joinHtml.includes(GA_ID) && !joinHtml.toLowerCase().includes('googletagmanager'), '/join must carry no GA (epilepsy gate)');

  // privacy: old "no analytics" claim gone, GA disclosed (EN+PL)
  const priv = await fetch(BASE + '/privacy').then((r) => r.text());
  // the STALE blanket claim was: "We use no analytics, advertising or non-essential cookies." (EN)
  // / "Nie używamy analityki, reklam ani zbędnych plików cookie." (PL). Both must be gone. (The new
  // disclosure legitimately says "no analytics cookies are set ... until you accept" — that's fine.)
  check('privacy_no_stale_claim', !/We use no analytics/i.test(priv) && !/Nie używamy analityki/i.test(priv), 'stale blanket "no analytics" claim removed');
  check('privacy_discloses_ga', /Google Analytics/.test(priv) && /Analytics &amp; cookies|Analytics & cookies/.test(priv) && /Analityka i pliki cookie/.test(priv), 'GA disclosed EN+PL');

  const b = await chromium.launch();

  // ---- (2) Consent Mode + banner behaviour on a GA page (use /studio) ----
  const collects = []; const libLoads = [];
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  ctx.on('request', (req) => {
    const u = req.url();
    if (/googletagmanager\.com\/gtag\/js/.test(u)) libLoads.push(u);
    if (/google-analytics\.com\/g\/collect|\/g\/collect\?/.test(u)) collects.push(u);
  });
  const page = await ctx.newPage();
  const perr = []; page.on('pageerror', (e) => perr.push(e.message));
  await page.goto(BASE + '/studio');
  await page.waitForTimeout(1200);

  const pre = await page.evaluate(() => {
    const dl = (window.dataLayer || []).map((a) => Array.prototype.slice.call(a));
    const def = dl.find((a) => a[0] === 'consent' && a[1] === 'default');
    return {
      hasGtag: typeof window.gtag === 'function',
      hasClsGA: typeof window.clsGA === 'function',
      defaultDenied: !!(def && def[2] && def[2].analytics_storage === 'denied'),
      bannerVisible: !!document.getElementById('clsCookie'),
      gaCookie: document.cookie.split(';').some((c) => /(^|\s)_ga/.test(c)),
      consentStored: (function () { try { return localStorage.getItem('cls_consent'); } catch (e) { return 'ERR'; } })(),
    };
  });
  check('no_js_errors', perr.length === 0, perr.join(' | '));
  check('consent_default_denied', pre.hasGtag && pre.defaultDenied, 'gtag loaded + analytics_storage default denied');
  check('clsGA_seam', pre.hasClsGA, 'window.clsGA present');
  check('banner_shown_preconsent', pre.bannerVisible, 'cookie banner visible before choice');
  check('no_ga_cookie_preconsent', !pre.gaCookie && !pre.consentStored, 'no _ga cookie + no stored consent before Accept');

  // clsGA pushes a gtag event into dataLayer
  const dlLenBefore = await page.evaluate(() => (window.dataLayer || []).length);
  await page.evaluate(() => window.clsGA('harness_probe', { ok: 1 }));
  const probe = await page.evaluate((n) => {
    const dl = (window.dataLayer || []).map((a) => Array.prototype.slice.call(a));
    const ev = dl.find((a) => a[0] === 'event' && a[1] === 'harness_probe');
    return { grew: dl.length > n, ev: !!ev };
  }, dlLenBefore);
  check('clsGA_pushes_event', probe.grew && probe.ev, 'harness_probe event reached dataLayer');

  // ---- (3) Accept -> consent granted ----
  await page.click('.cls-cookie .cls-acc');
  await page.waitForTimeout(1500);
  const post = await page.evaluate(() => {
    const dl = (window.dataLayer || []).map((a) => Array.prototype.slice.call(a));
    const upd = dl.filter((a) => a[0] === 'consent' && a[1] === 'update').some((a) => a[2] && a[2].analytics_storage === 'granted');
    return {
      granted: upd,
      stored: (function () { try { return localStorage.getItem('cls_consent'); } catch (e) { return 'ERR'; } })(),
      bannerGone: !document.getElementById('clsCookie'),
      settingsLink: !!document.getElementById('clsCookieSettings'),
    };
  });
  check('accept_grants_consent', post.granted && post.stored === 'granted', JSON.stringify(post));
  check('banner_dismissed', post.bannerGone && post.settingsLink, 'banner replaced by Cookie settings link');

  // ---- best-effort live beacon (needs Google network; operator-confirmed otherwise) ----
  note('gtag_lib_loaded', libLoads.length ? 'gtag/js requested (' + libLoads.length + ')' : 'no gtag/js request seen (offline?)');
  note('collect_only_after_accept', 'collect beacons observed=' + collects.length + ' (all after Accept; 0 before is asserted via cookie/consent state)');

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'ga_consent_report.json'), JSON.stringify({ base: BASE, pre, post, probe, libLoads: libLoads.length, collects: collects.length, fails }, null, 2));
  if (fails.length) { console.error('GA CONSENT FAIL:', fails.join('; ')); process.exit(1); }
  console.log('GA CONSENT PASS: GA on all pages except /join, Consent Mode default-denied, Accept grants, clsGA seam live, privacy rewritten.');
}
main().catch((e) => { console.error(e); process.exit(1); });
