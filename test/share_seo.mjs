// ROUND 9 — share block + GEO/SEO. Asserts the share affordances and the crawl/answer-engine
// surface: root robots/sitemap/llms/og-image actually serve; /studio is the public console
// (noindex, no lead form, share block); the landing has exactly ONE primary hero CTA -> /studio.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3009';
const dir = path.dirname(fileURLToPath(import.meta.url));
const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
const get = (p) => fetch(BASE + p);
const text = (p) => get(p).then((r) => r.text());

async function main() {
  // ---- root SEO / answer-engine files ----
  const robots = await get('/robots.txt'); const robotsT = await robots.text();
  check('robots_root_200', robots.status === 200, 'status=' + robots.status);
  check('robots_disallow_studio', /Disallow:\s*\/studio/.test(robotsT), 'has Disallow /studio');
  const sm = await get('/sitemap.xml'); const smT = await sm.text();
  check('sitemap_root_200', sm.status === 200, 'status=' + sm.status);
  check('sitemap_has_privacy', /\/privacy/.test(smT), 'lists /privacy');
  const llms = await get('/llms.txt'); const llmsT = await llms.text();
  check('llms_root_200', llms.status === 200, 'status=' + llms.status);
  check('llms_run_your_own', /Run your own/i.test(llmsT) && /Share a show/i.test(llmsT), 'has GEO sections');
  const og = await get('/og-cover.png');
  const ogBuf = Buffer.from(await og.arrayBuffer());
  check('og_image_200_png', og.status === 200 && ogBuf.slice(0, 8).toString('hex') === '89504e470d0a1a0a', 'png sig + status ' + og.status);

  // ---- landing head: OG/Twitter/hreflang/canonical/JSON-LD ----
  const home = await text('/');
  check('og_image_meta', /property="og:image"[^>]*og-cover\.png/.test(home), 'og:image');
  check('twitter_large', /name="twitter:card"\s+content="summary_large_image"/.test(home), 'summary_large_image');
  check('hreflang', /hreflang="en"/.test(home) && /hreflang="x-default"/.test(home), 'hreflang set');
  check('canonical', /rel="canonical"/.test(home), 'canonical');
  check('jsonld_howto', /"@type":\s*"HowTo"/.test(home), 'HowTo JSON-LD');

  // ---- /studio is the public console: noindex, no lead form, has the share block ----
  const studio = await text('/studio');
  check('studio_noindex', /name="robots"\s+content="noindex"/.test(studio), 'noindex');
  check('studio_no_leadform', !/id="leadForm"/.test(studio), 'no lead form');
  check('studio_share_block', /id="shareBlock"/.test(studio), 'share block present');
  check('studio_session', /__SESSION__/.test(studio), 'session present');

  // ---- /join carries the share block + script ----
  const join = await text('/join');
  check('join_share_block', /id="shareBlock"/.test(join), 'share block');
  check('join_share_js', /\/static\/share\.js/.test(join), 'share.js loaded');

  // ---- ONE primary CTA on the landing (req 1) ----
  const b = await chromium.launch();
  const p = await (await b.newContext()).newPage();
  await p.goto(BASE + '/');
  await p.waitForTimeout(400); // let the reveal script run
  const cta = await p.evaluate(() => {
    const hero = document.querySelector('.m-hero-cta');
    const primaries = hero ? hero.querySelectorAll('.m-btn-primary') : [];
    const visible = [];
    primaries.forEach((el) => { const s = getComputedStyle(el); if (s.display !== 'none' && s.visibility !== 'hidden') visible.push((el.textContent || '').trim().slice(0, 40)); });
    const studioVisible = !!(document.querySelector('.m-studio-cta') && getComputedStyle(document.querySelector('.m-studio-cta')).display !== 'none');
    const studioHref = document.querySelector('.m-studio-cta') ? document.querySelector('.m-studio-cta').getAttribute('href') : null;
    const quiet = document.querySelectorAll('.m-try-quiet').length;
    return { count: visible.length, labels: visible, studioVisible, studioHref, quiet };
  });
  // share intents are well-formed on /studio (load it and read hrefs)
  const sp = await (await b.newContext()).newPage();
  await sp.goto(BASE + '/studio');
  await sp.waitForTimeout(800);
  const sh = await sp.evaluate(() => {
    const g = (id) => { const e = document.getElementById(id); return e ? (e.getAttribute('href') || '') : null; };
    return { wa: g('shWa'), tg: g('shTg'), x: g('shX'), fb: g('shFb'), mail: g('shMail'), own: g('shOwn'), visible: !document.getElementById('shareBlock').hidden };
  });
  await b.close();

  check('one_primary_hero_cta', cta.count === 1, 'visible primaries=' + cta.count + ' ' + JSON.stringify(cta.labels));
  check('primary_cta_is_studio', cta.studioVisible && cta.studioHref === '/studio', 'studio CTA href=' + cta.studioHref);
  check('try_demoted_quiet', cta.quiet >= 1, 'quiet links=' + cta.quiet);
  check('share_intents_built', sh.visible && /wa\.me/.test(sh.wa) && /t\.me/.test(sh.tg) && /twitter\.com/.test(sh.x) && /facebook\.com/.test(sh.fb) && /^mailto:/.test(sh.mail), JSON.stringify({ wa: !!sh.wa, tg: !!sh.tg, x: !!sh.x, fb: !!sh.fb, mail: !!sh.mail }));
  check('share_join_not_site', /room=/.test(sh.wa) || /join/.test(sh.wa), 'join url in share text');
  check('share_start_own_site', /\/\?utm=share/.test(sh.own), 'start-your-own = static site url');

  const report = { base: BASE, cta, share: sh, fails };
  fs.writeFileSync(path.join(dir, '..', 'share_seo_report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (fails.length) { console.error('SHARE/SEO FAIL:', fails.join('; ')); process.exit(1); }
  console.log('SHARE/SEO PASS: root robots(+Disallow /studio)/sitemap(+privacy)/llms(+GEO)/og-image serve; /studio noindex console w/ share block; ONE primary hero CTA -> /studio; share intents carry the JOIN url + a static start-your-own url.');
}
main().catch((e) => { console.error(e); process.exit(1); });
