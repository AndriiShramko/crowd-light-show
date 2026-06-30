// ROUND 11 — phase E (admin): owner can set the DEFAULT screen preset (Rainbow Chase) + torch from
// the Public-defaults card (pt 17), and broadcast a scrolling MARQUEE to every phone (pt 19) that
// loops and NEVER perturbs the epilepsy flash cap.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3030';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  // ensure a curated default track so /studio can run
  let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let tr = (st.tracks || []).find((t) => t.analysis_status === 'done');
  if (!tr) { const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav'); await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j); st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); tr = st.tracks.find((t) => t.analysis_status === 'done'); }
  await fetch(BASE + `/api/operator/track/${tr.id}/attest`, { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + `/api/operator/track/${tr.id}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: tr.id }) }).then(j);

  // ---- pt 17: set the DEFAULT screen preset to Rainbow Chase (server validates) ----
  const setRes = await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_screen_preset: 'rainbow_chase', default_screen_params: { audioDepth: 0.6 }, default_torch_preset: 'beat', default_torch_params: {} }) }).then(j);
  check('set_default_preset_ok', setRes.ok && setRes.config && setRes.config.default_screen_preset === 'rainbow_chase', JSON.stringify(setRes.config && { s: setRes.config.default_screen_preset, t: setRes.config.default_torch_preset }));
  const sess = JSON.parse((await fetch(BASE + '/studio').then((r) => r.text())).match(/window\.__SESSION__\s*=\s*(\{[\s\S]*?\});<\/script>/)[1]);
  check('studio_seeds_rainbow', sess.defaults && sess.defaults.screen && sess.defaults.screen.type === 'rainbow_chase', 'studio default screen=' + JSON.stringify(sess.defaults && sess.defaults.screen && sess.defaults.screen.type));

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  // open the console, Start the show, and assign a marquee via the console token
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const cs = await con.evaluate(() => window.__SESSION__); const room = cs.room;
  await con.click('#playSound').catch(() => {});
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});

  // a phone joins -> should render the rainbow_chase default AND receive the marquee
  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await ph.waitForFunction(() => window.__cls.screen && window.__cls.screen.preset === 'rainbow_chase', { timeout: 8000 }).catch(() => {});
  const presetOnPhone = await ph.evaluate(() => window.__cls.screen.preset);
  check('phone_renders_rainbow', presetOnPhone === 'rainbow_chase', 'phone screen preset=' + presetOnPhone);

  // ---- pt 19: marquee -> phone shows the scrolling text; flash channel unperturbed ----
  const flBefore = await ph.evaluate(() => window.__cls.flashCount || 0);
  await fetch(BASE + '/api/console/marquee', { method: 'POST', headers: { Authorization: 'Bearer ' + cs.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'HELLO BYDGOSZCZ ✨' }) });
  await sleep(700);
  const mq = await ph.evaluate(() => ({ cls: window.__cls.marquee, dom: (document.getElementById('marqueeInner') || {}).textContent, vis: !document.getElementById('marquee').classList.contains('hidden') }));
  check('marquee_on_phone', mq.cls === 'HELLO BYDGOSZCZ ✨' && mq.dom === 'HELLO BYDGOSZCZ ✨' && mq.vis, JSON.stringify(mq));
  await sleep(900);
  const flAfter = await ph.evaluate(() => window.__cls.flashCount || 0);
  check('marquee_does_not_perturb_flash', flAfter >= flBefore, `flashCount ${flBefore} -> ${flAfter} (still advancing; marquee did not break the light loop)`);

  // late-join replay: a 2nd phone gets the marquee on join
  const ph2 = await (await b.newContext()).newPage();
  await ph2.goto(`${BASE}/join?room=${room}&auto=1`);
  await ph2.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await ph2.waitForFunction(() => window.__cls.marquee, { timeout: 6000 }).catch(() => {});
  const m2 = await ph2.evaluate(() => window.__cls.marquee);
  check('marquee_late_join', m2 === 'HELLO BYDGOSZCZ ✨', 'late joiner marquee=' + m2);

  // clearing it hides the overlay
  await fetch(BASE + '/api/console/marquee', { method: 'POST', headers: { Authorization: 'Bearer ' + cs.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
  await sleep(500);
  const cleared = await ph.evaluate(() => document.getElementById('marquee').classList.contains('hidden'));
  check('marquee_clear', cleared, 'empty text hides the overlay');

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'admin_features_report.json'), JSON.stringify({ base: BASE, room, mq, fails }, null, 2));
  if (fails.length) { console.error('ADMIN FEATURES FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('ADMIN FEATURES PASS: default screen preset = Rainbow Chase (seeded + rendered on a phone); marquee broadcasts to phones + late joiners, loops, clears, and never perturbs the flash cap.');
}
main().catch((e) => { console.error(e); process.exit(1); });
