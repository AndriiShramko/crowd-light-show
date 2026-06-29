// Round-8C site verification, proven by FACT against a running server: pricing tiers (honest
// copy-guard), the redesigned autofill-ready mobile lead form (no PII echo + share), the shared
// contact block on all 5 pages (no raw @@ tokens), 4-language i18n (EN/PL/ES/FR, persists), and
// the RODO privacy/imprint page. Headless = DOM + protocol, not a human design review.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const dir = path.dirname(fileURLToPath(import.meta.url));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };
const get = (p) => fetch(BASE + p).then((r) => r.text());

async function main() {
  // ---- 4. all marketing pages: shared contact block present, NO raw @@ tokens ----
  // round 9: /studio is no longer a marketing page — it is the PUBLIC OPERATOR CONSOLE
  // ("all of /operator EXCEPT leads"), so it carries no lead form by design and is excluded.
  let allClean = true, allForm = true, det = [];
  for (const p of ['/', '/try', '/join', '/about', '/privacy']) {
    const h = await get(p);
    const raw = (h.match(/@@/g) || []).length, form = /id="leadForm"/.test(h);
    if (raw > 0) allClean = false; if (!form) allForm = false;
    det.push(`${p}:@@${raw}${form ? '+form' : '-FORM'}`);
  }
  check('4_contact_5pages', allClean && allForm, det.join(' '));
  // /studio is the public console: NO lead form, and no unrendered @@ tokens.
  const studioHtml = await get('/studio');
  check('4b_studio_is_console', !/id="leadForm"/.test(studioHtml) && (studioHtml.match(/@@/g) || []).length === 0 && /__SESSION__/.test(studioHtml), 'studio console, no lead form');

  // ---- 1. pricing: 4 tiers + CTA to the form ----
  const home = await get('/');
  const tiers = ['Spark', 'Surge', 'Stadium', 'Beyond'].every((t) => home.includes('>' + t + '<') || home.includes(t));
  const prices = home.includes('€1 900') && home.includes('€9 900') && home.includes('€50 000');
  const ctas = (home.match(/href="\?tier=\w+#contact"/g) || []).length;
  check('1_pricing_tiers', tiers && prices && ctas >= 4, `tiers=${tiers} prices=${prices} tierCTAs=${ctas}`);

  // ---- 1b. copy-guard: the PRICING + SHARE copy must be honest (no banned absolutes) ----
  const priceBlock = (home.match(/id="pricing"[\s\S]*?<\/section>/) || [''])[0];
  const banned = [/guarantee/i, /flawless/i, /zero[ -]?latency/i, /\bany size\b/i, /works perfectly/i, /perfectly sync/i];
  const hitBanned = banned.filter((re) => re.test(priceBlock)).map((re) => re.source);
  const partial = fs.readFileSync(path.join(dir, '..', 'public', 'partials', 'contact.html'), 'utf8');
  const shareHit = /perfectly sync/i.test(partial) || /over any network/i.test(partial);
  const qualifiers = /\bfrom\b/i.test(priceBlock) && /subject to/i.test(priceBlock) && /depend/i.test(priceBlock);
  check('1b_copy_guard', hitBanned.length === 0 && !shareHit && qualifiers,
    `bannedInPricing=[${hitBanned}] shareOverpromise=${shareHit} hasQualifiers=${qualifiers}`);

  // ---- 6. RODO privacy + imprint ----
  const priv = await get('/privacy');
  const imprint = priv.includes('7543116302') && /Andrii Shramko/.test(priv);
  const notice = /controller/i.test(priv) && /6\(1\)\(b\)/.test(priv) && /12 months/i.test(priv) && /UODO/.test(priv) && /not sent over Telegram/i.test(priv);
  check('6_privacy_imprint', imprint && notice, `imprint(NIP+name)=${imprint} notice(controller/basis/retention/UODO/tg-min)=${notice}`);
  // DB must never be web-served
  const dbProbe = await Promise.all(['/static/app.db', '/app.db', '/data/app.db'].map((u) => fetch(BASE + u).then((r) => r.status)));
  check('6_db_not_served', dbProbe.every((s) => s === 404 || s === 403), `db path statuses: ${dbProbe.join(',')}`);
  // Telegram DM PII-minimized (source-level: the apply handler's notify call carries no PII)
  const srv = fs.readFileSync(path.join(dir, '..', 'src', 'server.js'), 'utf8');
  const applyBlock = (srv.match(/\/api\/apply[\s\S]*?\n\}\);/) || [''])[0];
  const tgCall = (applyBlock.match(/notifyTelegram\([\s\S]*?\)\s*\.then/) || [''])[0];
  // PII-minimized = the DM argument is a plain string literal with no ${...} interpolation and
  // does not reference the lead's fields (name/email/phone/company/message).
  const noTemplate = tgCall.length > 0 && !/\$\{/.test(tgCall) && !/\b(name|email|phone|company|message|contact)\b/.test(tgCall);
  check('6_telegram_minimized', noTemplate, `apply Telegram call carries no PII template: ${tgCall.slice(0, 60).replace(/\n/g, ' ')}…`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { if (!/Permissions check failed|permission/i.test(e.message)) errors.push('PAGEERR: ' + e.message); });

  // ---- 2. form: fields + autocomplete + required only name/email ----
  await page.goto(BASE + '/');
  await page.waitForSelector('#leadForm', { timeout: 10000 });
  const fa = await page.evaluate(() => {
    const f = document.getElementById('leadForm'); const g = (n) => f.querySelector('[name="' + n + '"]');
    const a = (n) => { const e = g(n); return e ? { type: e.type, ac: e.getAttribute('autocomplete'), req: e.hasAttribute('required') } : null; };
    return { name: a('name'), email: a('email'), phone: a('phone'), company: a('company') };
  });
  const acOk = fa.name.ac === 'name' && fa.email.type === 'email' && fa.email.ac === 'email' && fa.phone.type === 'tel' && fa.phone.ac === 'tel' && fa.company.ac === 'organization';
  const reqOk = fa.name.req && fa.email.req && !fa.phone.req && !fa.company.req;
  check('2_form_autofill', acOk && reqOk, `autocomplete ok=${acOk}; required name+email only=${reqOk}`);

  // ---- 2b. mobile: no horizontal overflow at 360 and 320 ----
  const ov = {};
  for (const w of [360, 320]) { await page.setViewportSize({ width: w, height: 720 }); await page.waitForTimeout(120); ov[w] = await page.evaluate(() => document.documentElement.scrollWidth); }
  check('2b_mobile_no_overflow', ov[360] <= 362 && ov[320] <= 322, `scrollWidth @360=${ov[360]} @320=${ov[320]}`);
  await page.setViewportSize({ width: 1100, height: 800 });

  // ---- 3. validation + thank-you WITHOUT echoing PII ----
  await page.fill('#leadForm [name=name]', 'Test Person');
  const secret = 'verysecret_' + Date.now() + '@example.com';
  await page.fill('#leadForm [name=email]', secret);
  await page.fill('#leadForm [name=phone]', '+48 600 100 200');
  await page.click('#lc-send');
  await page.waitForSelector('#lc-thanks.show', { timeout: 8000 }).catch(() => {});
  const after = await page.evaluate(() => ({ thanks: !!document.querySelector('#lc-thanks.show'), share: !!document.getElementById('lc-share-try'), body: document.body.innerText }));
  check('3_thankyou_no_echo', after.thanks && after.share && after.body.indexOf(secret) < 0 && after.body.indexOf('600 100 200') < 0,
    `thanks=${after.thanks} share=${after.share} pii_echoed=${after.body.indexOf(secret) >= 0}`);

  // ---- 5. i18n: marker renders EN!=PL!=ES!=FR, persists across navigation, no missing keys ----
  const texts = {};
  for (const l of ['en', 'pl', 'es', 'fr']) {
    await page.goto(BASE + '/?lang=' + l);
    await page.waitForSelector('[data-i18n="contact.title"]', { timeout: 8000 });
    await page.waitForTimeout(150);
    texts[l] = await page.evaluate(() => document.querySelector('[data-i18n="contact.title"]').textContent.trim());
  }
  const distinct = new Set(Object.values(texts)).size === 4;
  // persistence: pick PL, then navigate to /try, lang should stick
  await page.goto(BASE + '/?lang=pl'); await page.waitForTimeout(150);
  await page.goto(BASE + '/try'); await page.waitForSelector('[data-i18n="contact.title"]', { timeout: 8000 }); await page.waitForTimeout(150);
  const persisted = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.querySelector('[data-i18n="contact.title"]').textContent.trim() }));
  const missing = await page.evaluate(() => { let n = 0; document.querySelectorAll('[data-i18n]').forEach((e) => { if (!e.textContent.trim()) n++; }); return n; });
  check('5_i18n_4lang', distinct && persisted.lang === 'pl' && persisted.title === texts.pl && missing === 0,
    `EN="${texts.en}" PL="${texts.pl}" ES="${texts.es}" FR="${texts.fr}" | persisted lang=${persisted.lang} missingKeys=${missing}`);

  // switcher present + clickable
  const sw = await page.evaluate(() => { const s = document.getElementById('cls-lang'); return s ? s.querySelectorAll('button').length : 0; });
  check('5b_switcher', sw === 4, `language switcher buttons: ${sw}`);

  check('no_js_errors', errors.length === 0, errors.length ? errors.join(' | ') : 'no JS errors');
  await browser.close();
  fs.writeFileSync(path.join(dir, '..', 'site_8c_report.json'), JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('SITE 8C FAIL:', report.fails.join('; ')); process.exit(1); }
  console.log('SITE 8C PASS: pricing+copy-guard, autofill form (no PII echo)+mobile, contact block on 5 pages (no raw @@), 4-language i18n that persists, RODO privacy+imprint. Headless = DOM, not a human review.');
}
main().catch((e) => { console.error('SITE 8C ERROR:', e); process.exit(1); });
