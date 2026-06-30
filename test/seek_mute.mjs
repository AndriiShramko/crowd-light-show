// ROUND 13 — pt 7 (seek) + pt 8 (global mute). The operator can jump the music+lights to any position
// (seek re-anchors T0 so phones follow both lights and audio), and mute the music on EVERY phone at once
// (distinct from the local per-browser mute), with the lights still running and late joiners inheriting it.
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
  const durMs = tr.duration_ms || 6000;

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
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
  await ph.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});
  await sleep(600);

  // ---- pt 7: SEEK to ~half the track; the phone's show position must JUMP there ----
  const target = Math.round(durMs * 0.5);
  const before = await ph.evaluate(() => window.__cls.lastPos || 0);
  const sres = await post('/api/console/seek', { offsetMs: target });
  await sleep(1400); // wait past the start lead so the position is at/after the target
  const after = await ph.evaluate(() => window.__cls.lastPos || 0);
  check('seek_ok', !!(sres && sres.ok), 'server seek -> ' + JSON.stringify(sres));
  // the seek positions the show so `target` lands at a near-future lead anchor; after the lead the
  // phone is at ~target+. The key: it JUMPED forward to the seek region from the old (~1s) position.
  check('phone_jumped_to_seek', after > before + 1000 && after >= target - 900 && after <= target + 2000, `phone pos before=${before} after=${after} (target≈${target}; jumped to the seek region, not stuck at the old spot)`);

  // ---- pt 8: GLOBAL mute silences this phone's audio; lights keep running ----
  await post('/api/console/mute-all', { muted: true });
  await sleep(400);
  const muted = await ph.evaluate(() => ({ g: window.__cls.audio.globalMuted, m: window.__cls.audio.muted, status: window.__cls.status }));
  check('global_mute_applies', muted.g === true && muted.m === true && muted.status === 'running', 'phone globalMuted=' + muted.g + ' muted=' + muted.m + ' status=' + muted.status + ' (lights keep running)');

  // a LATE joiner inherits the mute
  const ph2 = await (await b.newContext()).newPage();
  await ph2.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await ph2.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await ph2.waitForFunction(() => window.__cls && window.__cls.audio && window.__cls.audio.globalMuted === true, { timeout: 6000 }).catch(() => {});
  const lateG = await ph2.evaluate(() => window.__cls.audio.globalMuted);
  check('late_join_inherits_mute', lateG === true, 'late joiner globalMuted=' + lateG);

  // unmute restores
  await post('/api/console/mute-all', { muted: false });
  await sleep(400);
  const un = await ph.evaluate(() => ({ g: window.__cls.audio.globalMuted, m: window.__cls.audio.muted }));
  check('global_unmute', un.g === false && un.m === false, 'after unmute globalMuted=' + un.g + ' muted=' + un.m);

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'seek_mute_report.json'), JSON.stringify({ base: BASE, durMs, target, before, after, fails }, null, 2));
  if (fails.length) { console.error('SEEK MUTE FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('SEEK MUTE PASS: seek jumps the show position (lights + audio re-anchor to it); global mute silences every phone (local-mute-independent), the lights keep running, late joiners inherit it, and unmute restores.');
}
main().catch((e) => { console.error(e); process.exit(1); });
