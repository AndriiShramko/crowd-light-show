// ROUND 13 — pt 5. End to end: with a reactive preset running, the operator fires a firework FX; the
// phone plays it (overriding the screen for a few seconds), then REVERTS to the same preset that was
// running — the underlying preset/timeline is never cleared. Buttons are present on BOTH consoles.
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
  await con.click('#playSound').catch(() => {});
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});
  // pick a reactive preset so we can prove the FX reverts to it
  await fetch(BASE + '/api/console/preset', { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'rainbow_chase' }) }).then(j);

  // FX buttons exist on /studio
  await con.click('#playSound').catch(() => {});
  await con.waitForTimeout(400);
  const studioFx = await con.evaluate(() => document.querySelectorAll('#fxBtns button[data-fx]').length);
  check('fx_buttons_on_studio', studioFx === 5, 'fx buttons on /studio = ' + studioFx);

  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await ph.waitForFunction(() => window.__cls && window.__cls.screen && window.__cls.screen.preset === 'rainbow_chase', { timeout: 8000 }).catch(() => {});
  const presetBefore = await ph.evaluate(() => window.__cls.screen.preset);

  // fire 'salute' (4.5s); during the window the phone's fx is set + the screen overrides
  const fxRes = await fetch(`${BASE}/api/console/fx`, { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'salute' }) }).then(j);
  check('fx_fired', !!(fxRes && fxRes.ok && fxRes.durationMs > 0), 'server fx -> ' + JSON.stringify(fxRes));
  await sleep(800);
  const during = await ph.evaluate(() => ({ fx: window.__cls.fx && window.__cls.fx.name, everLit: window.__cls.everLit, status: window.__cls.status }));
  check('phone_plays_fx', during.fx === 'salute' && during.status === 'running', 'during-FX phone fx=' + during.fx + ' status=' + during.status);

  // unknown fx name is rejected
  const badFx = await fetch(`${BASE}/api/console/fx`, { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'nope' }) });
  check('fx_validates_name', badFx.status === 400, 'unknown fx -> ' + badFx.status);

  // after the window the FX evaporates and the preset RESUMES (never cleared)
  await sleep(fxRes.durationMs + 600);
  const after = await ph.evaluate(() => ({ fx: window.__cls.fx, preset: window.__cls.screen.preset, status: window.__cls.status }));
  check('fx_reverts', after.fx == null && after.preset === presetBefore && after.status === 'running', 'after-FX fx=' + JSON.stringify(after.fx) + ' preset=' + after.preset + ' (resumed the underlying preset)');

  // FX buttons exist on /operator too (parity)
  const opCtx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS } });
  const op = await opCtx.newPage();
  await op.goto(BASE + '/operator');
  await op.waitForSelector('#fxBtns', { timeout: 12000 });
  const opFx = await op.evaluate(() => document.querySelectorAll('#fxBtns button[data-fx]').length);
  check('fx_buttons_on_operator', opFx === 5, 'fx buttons on /operator = ' + opFx);

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'fx_e2e_report.json'), JSON.stringify({ base: BASE, fxRes, during, after, fails }, null, 2));
  if (fails.length) { console.error('FX E2E FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('FX E2E PASS: 5 firework buttons on BOTH consoles; firing one plays it on the phone (screen override), an unknown name is rejected, and after the window it reverts to the running preset.');
}
main().catch((e) => { console.error(e); process.exit(1); });
