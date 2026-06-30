// ROUND 14 — end-to-end: the operator's live VJ override + palette restriction reach a real phone over
// the room WebSocket, in both modes, and a late joiner inherits them; turning the block off restores the
// plain show. Mirrors seek_mute.mjs (BASE server + headless /studio console + /join phone).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3080';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };
const parseBg = (s) => { const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; };
function hueOf(rgb) { const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d !== 0) { if (mx === r) h = 60 * (((g - b) / d) % 6); else if (mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4); } return (h + 360) % 360; }
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let tr = (st.tracks || []).find((t) => t.analysis_status === 'done');
  if (!tr) { const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav'); await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j); st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); tr = st.tracks.find((t) => t.analysis_status === 'done'); }
  await fetch(BASE + `/api/operator/track/${tr.id}/attest`, { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + `/api/operator/track/${tr.id}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: tr.id }) }).then(j);

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const sess = await con.evaluate(() => window.__SESSION__);
  const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(j);
  await con.click('#playSound').catch(() => {});
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});
  // run a steady-ish screen preset so intervene has something to modulate
  await post('/api/console/preset', { type: 'rainbow_chase', params: { speed: 0.02, spread: 0, dir: 1 } });

  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(800);

  // ---- (a) FULL mode: presets OFF, screen = manual HSV (green) ----
  await post('/api/console/manual', { on: true, mode: 'full', hue: 120, sat: 1, bri: 0.9, flash: 0 });
  await sleep(500);
  const full = await ph.evaluate(() => ({ m: window.__cls.manual, bg: window.__cls.lastBg }));
  const fullRgb = parseBg(full.bg);
  check('full_mode_applies', full.m && full.m.on && full.m.mode === 'full' && hueDist(hueOf(fullRgb), 120) < 30, `manual=${JSON.stringify(full.m)} bg=${full.bg} hue=${hueOf(fullRgb).toFixed(0)}`);

  // ---- (b) INTERVENE: rotate the running preset's hue by +160 and confirm the painted hue moved ----
  await post('/api/console/manual', { on: true, mode: 'intervene', hue: 0, sat: 1, bri: 1 });
  await sleep(400);
  const h0 = hueOf(parseBg(await ph.evaluate(() => window.__cls.lastBg)));
  await post('/api/console/manual', { hue: 160 });
  await sleep(400);
  const h1 = hueOf(parseBg(await ph.evaluate(() => window.__cls.lastBg)));
  check('intervene_rotates_hue', hueDist(h0 + 160, h1) < 40, `hue ${h0.toFixed(0)} --(+160)--> ${h1.toFixed(0)} (expected ~${((h0 + 160) % 360).toFixed(0)})`);

  // ---- (c) PALETTE: restrict to pure blue; every painted colour must be blue-dominant ----
  await post('/api/console/manual', { on: false });          // palette must work WITHOUT the pult (req 4)
  await post('/api/console/palette', { on: true, colors: [[0, 0, 255]] });
  await sleep(700);
  // sample the LIVE painted colour over a window (not the deduped colour history, which holds stale
  // pre-palette frames). Every live frame of a rainbow preset snapped to pure blue must be blue-dominant.
  const live = [];
  for (let i = 0; i < 10; i++) { live.push(parseBg(await ph.evaluate(() => window.__cls.lastBg))); await sleep(60); }
  const palP = await ph.evaluate(() => window.__cls.palette);
  const allBlue = live.every((c) => c[2] >= c[0] && c[2] >= c[1] && c[2] > 20);
  check('palette_snaps_to_blue', palP && palP.on && allBlue, `palette=${JSON.stringify(palP)} live=${JSON.stringify(live.slice(0, 4))}`);

  // ---- (d) LATE JOINER inherits the active palette (and manual if on) ----
  const ph2 = await (await b.newContext()).newPage();
  await ph2.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await ph2.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(700);
  const late = await ph2.evaluate(() => ({ p: window.__cls.palette }));
  check('late_join_inherits_palette', late.p && late.p.on && late.p.colors.length === 1, `late palette=${JSON.stringify(late.p)}`);

  // ---- (e) turning everything OFF restores the plain preset (req 3 — behaves exactly as before) ----
  await post('/api/console/palette', { on: false, colors: [] });
  await sleep(700);
  const offState = await ph.evaluate(() => ({ p: window.__cls.palette, m: window.__cls.manual, preset: window.__cls.screen.preset, cols: window.__cls.colors.slice(-8) }));
  const notAllBlue = offState.cols.some((s) => { const c = parseBg(s); return c[0] > c[2] + 10 || c[1] > c[2] + 10; }); // rainbow returns
  check('off_restores_plain_show', !offState.p.on && !offState.m.on && offState.preset === 'rainbow_chase' && notAllBlue, `palette.on=${offState.p.on} manual.on=${offState.m.on} preset=${offState.preset} variedColours=${notAllBlue}`);

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'manual_e2e_report.json'), JSON.stringify({ base: BASE, fails }, null, 2));
  if (fails.length) { console.error('MANUAL E2E FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('MANUAL E2E PASS: full-mode HSV, intervene hue-rotate, palette-snap (no pult), late-join inherit, and off-restores-plain all reached the phone over the room WS.');
}
main().catch((e) => { console.error(e); process.exit(1); });
