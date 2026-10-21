// GA guard for the static game (2026-10-21, vault ANALYTICS-HOWTO §3): the GA4 measurement id is
// committed in game/consent.js and must reach both pages. FAILS (exit 1) when it is missing or changed.
//   node game/deploy/check-ga.mjs                                  -> source check (deploy-static.sh runs it first)
//   node game/deploy/check-ga.mjs --live https://game.flyreelstudio.eu   -> served files after the deploy
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GA_ID = 'G-ETW2D67D8F';
const game = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const checkConsent = (js, where) => {
  ok(js.includes(`var GA_ID = '${GA_ID}'`), `${where}: consent.js lacks var GA_ID = '${GA_ID}'`);
  ok(/googletagmanager\.com\/gtag\/js\?id=/.test(js), `${where}: consent.js lacks the gtag.js loader`);
};
const checkPage = (html, where) => {
  ok(/<script src="\.\/consent\.js"><\/script>/.test(html), `${where}: page does not load ./consent.js`);
  ok(!/<script[^>]+googletagmanager/.test(html), `${where}: static gtag.js tag (must load only after consent)`);
};

const live = process.argv.indexOf('--live');
if (live >= 0) {
  const base = (process.argv[live + 1] || '').replace(/\/$/, '');
  const get = async (p) => { const r = await fetch(base + p, { cache: 'no-store' }); ok(r.status === 200, `${p}: HTTP ${r.status}`); return r.text(); };
  checkConsent(await get('/consent.js'), 'live');
  checkPage(await get('/'), 'live /');
  checkPage(await get('/play.html'), 'live /play.html');
} else {
  checkConsent(fs.readFileSync(path.join(game, 'consent.js'), 'utf8'), 'source');
  for (const f of ['index.html', 'play.html']) checkPage(fs.readFileSync(path.join(game, f), 'utf8'), 'source ' + f);
}
if (fails.length) { console.error('GA GUARD FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log(`GA guard OK (${GA_ID}${live >= 0 ? ', live' : ', source'})`);
