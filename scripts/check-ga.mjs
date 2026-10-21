// GA guard (2026-10-21, WEB-TECH-BASELINE §T6 / vault ANALYTICS-HOWTO §3): the release must never ship
// without the GA4 measurement id. (Drony Bydgoszcz silently lost GA for 8 days because a release was
// built without its env var.) The id is public and committed in public/partials/ga.html; this script
// FAILS (exit 1) when it is missing, changed, or when the /join epilepsy gate would get GA.
//   node scripts/check-ga.mjs                    -> source check (runs inside `docker compose build`)
//   node scripts/check-ga.mjs --live https://lightshow.flyreelstudio.eu   -> served-HTML check after deploy
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GA_ID = 'G-46C2GKVHPR';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GA_PAGES = ['index.html', 'about.html', 'try.html', 'vj.html', 'privacy.html', 'operator.html'];
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const live = process.argv.indexOf('--live');
if (live >= 0) {
  const base = (process.argv[live + 1] || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) { console.error('usage: --live https://host'); process.exit(2); }
  for (const p of ['/', '/about', '/try', '/vj', '/privacy', '/studio']) {
    const r = await fetch(base + p, { redirect: 'follow' });
    const html = await r.text();
    ok(r.status === 200, `${p}: HTTP ${r.status}`);
    ok(html.includes(`'${GA_ID}'`), `${p}: served HTML lacks ${GA_ID}`);
    ok(!html.includes('@@GA@@'), `${p}: raw @@GA@@ token served`);
    ok(!/<script[^>]+googletagmanager\.com\/gtag\/js/.test(html), `${p}: static gtag.js <script> tag (must load only after consent)`);
  }
  const join = await (await fetch(base + '/join?demo=1')).text();
  ok(!join.includes(GA_ID) && !/googletagmanager/i.test(join), '/join must carry no GA (epilepsy gate)');
} else {
  const ga = fs.readFileSync(path.join(root, 'public/partials/ga.html'), 'utf8');
  ok(ga.includes(`var GA_ID = '${GA_ID}'`), `partials/ga.html lacks var GA_ID = '${GA_ID}'`);
  ok(/googletagmanager\.com\/gtag\/js\?id=/.test(ga), 'partials/ga.html lacks the gtag.js loader');
  ok(!/<script[^>]+src=["']https:\/\/www\.googletagmanager/.test(ga), 'partials/ga.html has a static gtag.js tag (pre-consent load)');
  for (const f of GA_PAGES) ok(fs.readFileSync(path.join(root, 'public', f), 'utf8').includes('@@GA@@'), `public/${f} lacks the @@GA@@ token`);
  const aud = fs.readFileSync(path.join(root, 'public/audience.html'), 'utf8');
  ok(!aud.includes('@@GA@@') && !aud.includes(GA_ID), 'public/audience.html (/join) must not get GA');
}

if (fails.length) { console.error('GA GUARD FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log(`GA guard OK (${GA_ID}${live >= 0 ? ', live' : ', source'})`);
