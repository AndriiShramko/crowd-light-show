// ROUND 11 — phase F (pt 20): the /studio + /operator CONSOLES are now multilingual. They load the
// same shared i18n layer as the landing (cls_lang), so the language the visitor picked carries
// through, with a floating EN/PL/ES/FR switcher. EN is canonical (so the parity/UX tests still see
// the English labels), PL authoritative. The switch re-renders both static chrome (data-i18n) AND
// the JS-driven dynamic strings (Start/Pause, state pill). The invite page (/join) honors the same
// cls_lang — but ?demo=1 with no stored choice still defaults to EN (the international try-it flow).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3030';
const dir = path.dirname(fileURLToPath(import.meta.url));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---- the public console: switcher present, EN canonical, switch to PL, persists ----
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const con = await ctx.newPage();
  const perr = []; con.on('pageerror', (e) => perr.push(e.message));
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.CLSI18N && document.getElementById('cls-lang'), { timeout: 12000 });
  await con.waitForTimeout(300);

  const en = await con.evaluate(() => ({
    switcher: document.querySelectorAll('#cls-lang button').length,
    start: (document.getElementById('playSound') || {}).textContent || '',
    showTitle: (document.querySelector('[data-i18n="console.h.show"]') || {}).textContent || '',
    joinTitle: (document.querySelector('[data-i18n="console.h.join"]') || {}).textContent || '',
    htmlLang: document.documentElement.lang,
  }));
  check('switcher_4_langs', en.switcher === 4, 'switcher buttons=' + en.switcher);
  check('en_canonical_start', /Start Light Show/.test(en.start), 'EN start="' + en.start.trim() + '" (parity/UX tests rely on this)');
  check('en_static_chrome', en.showTitle === '1 · Show control' && /Join QR/.test(en.joinTitle), 'show="' + en.showTitle + '" join="' + en.joinTitle + '"');

  // switch to Polish
  await con.click('#cls-lang button[data-lang="pl"]');
  await con.waitForTimeout(300);
  const pl = await con.evaluate(() => ({
    start: (document.getElementById('playSound') || {}).textContent || '',
    showTitle: (document.querySelector('[data-i18n="console.h.show"]') || {}).textContent || '',
    stop: (document.getElementById('stop') || {}).textContent || '',
    htmlLang: document.documentElement.lang,
    stored: (() => { try { return localStorage.getItem('cls_lang'); } catch (e) { return null; } })(),
  }));
  check('pl_dynamic_start', /Włącz pokaz świateł/.test(pl.start), 'PL start="' + pl.start.trim() + '" (JS-driven label re-rendered on switch)');
  check('pl_static_chrome', pl.showTitle === '1 · Sterowanie pokazem' && /Stop/.test(pl.stop), 'PL show="' + pl.showTitle + '"');
  check('pl_html_lang', pl.htmlLang === 'pl' && pl.stored === 'pl', 'html lang=' + pl.htmlLang + ' cls_lang=' + pl.stored);

  // persist across reload (same context keeps cls_lang)
  await con.reload();
  await con.waitForFunction(() => window.CLSI18N && document.getElementById('playSound'), { timeout: 12000 });
  await con.waitForTimeout(300);
  const reloaded = await con.evaluate(() => ({ start: (document.getElementById('playSound') || {}).textContent || '', lang: document.documentElement.lang }));
  check('persist_after_reload', /Włącz pokaz świateł/.test(reloaded.start) && reloaded.lang === 'pl', 'after reload start="' + reloaded.start.trim() + '" lang=' + reloaded.lang);

  // ---- the invite page (/join) honors the SAME cls_lang chosen above (carry-over, pt 20) ----
  const join = await ctx.newPage(); // same context => cls_lang=pl is set
  await join.goto(BASE + '/join');
  await join.waitForTimeout(500);
  const joinPl = await join.evaluate(() => ({ title: (document.querySelector('[data-t="title"]') || {}).textContent || '', lang: document.documentElement.lang }));
  check('join_carries_cls_lang', /Światło z tłumu/.test(joinPl.title) && joinPl.lang === 'pl', 'join title="' + joinPl.title + '" lang=' + joinPl.lang);

  // ---- but ?demo=1 with NO stored choice still defaults to EN (guards demo_audio) ----
  const fresh = await b.newContext();
  const demo = await fresh.newPage();
  await demo.goto(BASE + '/join?demo=1');
  await demo.waitForTimeout(500);
  const demoEn = await demo.evaluate(() => ({ title: (document.querySelector('[data-t="title"]') || {}).textContent || '', lang: document.documentElement.lang }));
  check('demo_still_english', /Crowd Light Show/.test(demoEn.title) && demoEn.lang === 'en', 'demo title="' + demoEn.title + '" lang=' + demoEn.lang);

  check('no_js_errors', perr.length === 0, perr.slice(0, 3).join(' | '));
  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'i18n_console_report.json'), JSON.stringify({ base: BASE, en, pl, joinPl, demoEn, fails }, null, 2));
  if (fails.length) { console.error('I18N CONSOLE FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('I18N CONSOLE PASS: console switcher (EN/PL/ES/FR), EN canonical, switch to PL re-renders static + dynamic strings, persists across reload, /join carries the shared cls_lang, and ?demo=1 still defaults to EN.');
}
main().catch((e) => { console.error(e); process.exit(1); });
