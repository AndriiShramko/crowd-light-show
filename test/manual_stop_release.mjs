// ROUND 14 — regression for the adversarial-review findings: the VJ manual override + palette must be
// RELEASED on STOP and when the operator leaves (never leaving the crowd stuck lit / torch-on or stale
// for late joiners), and a no-auth /studio console token must NOT be admitted as a main-show operator
// over the WebSocket. Mirrors seek_mute.mjs + adds a raw-ws auth probe.
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3080';
const WSBASE = BASE.replace(/^http/, 'ws');
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseBg = (s) => { const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; };
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

  // ===== A) /studio: STOP releases a latched manual full-mode flash + palette; late joiner stays clean =====
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const sess = await con.evaluate(() => window.__SESSION__);
  const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(j);
  await con.click('#playSound').catch(() => {});
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});

  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(500);

  await post('/api/console/manual', { on: true, mode: 'full', hue: 0, sat: 1, bri: 1, flash: 1 }); // pure red, flash latched on
  await post('/api/console/palette', { on: true, colors: [[255, 0, 0]] });
  await sleep(500);
  const lit = parseBg(await ph.evaluate(() => window.__cls.lastBg));
  check('manual_full_lit_while_running', lit[0] + lit[1] + lit[2] > 60, 'phone lit while running: ' + JSON.stringify(lit));

  await post('/api/console/stop', {});
  await sleep(700);
  const afterStop = await ph.evaluate(() => ({ bg: window.__cls.lastBg, m: window.__cls.manual, p: window.__cls.palette, tw: window.__cls.torch.want, status: window.__cls.status }));
  const dark = parseBg(afterStop.bg);
  check('stop_darkens_crowd', dark[0] + dark[1] + dark[2] === 0 && afterStop.tw === 0, `after STOP bg=${afterStop.bg} torch.want=${afterStop.tw} status=${afterStop.status}`);
  check('stop_releases_manual_palette', afterStop.m && !afterStop.m.on && afterStop.p && !afterStop.p.on, `manual=${JSON.stringify(afterStop.m)} palette=${JSON.stringify(afterStop.p)}`);

  const late = await (await b.newContext()).newPage();
  await late.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await late.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(700);
  const lm = await late.evaluate(() => ({ m: window.__cls.manual, p: window.__cls.palette }));
  check('late_join_after_stop_clean', lm.m && !lm.m.on && lm.p && !lm.p.on, `late manual=${JSON.stringify(lm.m)} palette=${JSON.stringify(lm.p)}`);

  // ===== B) a no-auth /studio CONSOLE token must be REJECTED at the WS operator gate =====
  const authRes = await new Promise((resolve) => {
    const w = new WebSocket(WSBASE + '/ws');
    let got = null; const to = setTimeout(() => resolve({ rejected: got === 'error' || got === 'closed', got: got || 'timeout' }), 3000);
    w.on('open', () => w.send(JSON.stringify({ t: 'hello', role: 'operator', token: sess.token }))); // sess.token is a CONSOLE token
    w.on('message', (d) => { try { const m = JSON.parse(d); if (m.t === 'error') { got = 'error'; } } catch (e) {} });
    w.on('close', () => { if (!got) got = 'closed'; clearTimeout(to); resolve({ rejected: got === 'error' || got === 'closed', got }); });
    w.on('error', () => {});
  });
  check('ws_rejects_console_token_as_operator', authRes.rejected, 'console token at WS operator gate -> ' + authRes.got);

  // ===== C) MAIN show: when the only operator leaves, the manual override is released on every phone =====
  const opCtx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS } });
  const op = await opCtx.newPage();
  await op.goto(BASE + '/operator');
  await op.waitForFunction(() => window.__opMode, { timeout: 12000 }).catch(() => {});
  await sleep(400);
  const mph = await (await b.newContext()).newPage();
  await mph.goto(`${BASE}/join?room=main&auto=1`);
  await mph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(400);
  await fetch(BASE + '/api/operator/manual', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ on: true, mode: 'full', hue: 120, sat: 1, bri: 1, flash: 1 }) }).then(j);
  await sleep(500);
  const before = await mph.evaluate(() => window.__cls.manual.on);
  await opCtx.close(); // operator leaves -> WS drops -> removeOperator -> release
  await sleep(900);
  const afterLeave = await mph.evaluate(() => window.__cls.manual.on);
  check('operator_leave_releases_manual', before === true && afterLeave === false, `manual.on before=${before} after operator left=${afterLeave}`);

  await b.close();
  if (fails.length) { console.error('MANUAL STOP/RELEASE FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('MANUAL STOP/RELEASE PASS: STOP darkens + releases manual/palette; late joiner clean; WS rejects a console token as operator; operator-leave releases the override.');
}
main().catch((e) => { console.error(e); process.exit(1); });
