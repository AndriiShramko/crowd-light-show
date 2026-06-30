// ROUND 13 — pt 4. The console's "Live preview — what the crowd's screen does right now" was dead:
// it used a generic simulated loudness (and showed black with no preset). It now samples the armed
// track's REAL compiled envelope (the same AGC'd cue brightness the crowd reacts to) at the live play
// position, so the preview pulses with the actual music — even with Live presets OFF (timeline only).
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
  // a curated default track so /studio Start arms a running, music-reactive show (tone_2hz = a 2 Hz beat)
  let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let tr = (st.tracks || []).find((t) => t.analysis_status === 'done');
  if (!tr) { const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav'); await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j); st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); tr = st.tracks.find((t) => t.analysis_status === 'done'); }
  await fetch(BASE + `/api/operator/track/${tr.id}/attest`, { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + `/api/operator/track/${tr.id}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: tr.id }) }).then(j);

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const con = await (await b.newContext()).newPage();
  const perr = []; con.on('pageerror', (e) => perr.push(e.message));
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  await con.click('#playSound').catch(() => {}); // arm the default track + GO (Live presets default OFF -> timeline)
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});
  await con.waitForFunction(() => window.__opMainPv && window.__opMainPv.hasTimeline, { timeout: 10000 }).catch(() => {});

  // sample the Live preview over ~2.5 s — its level must VARY with the music (the 2 Hz beat) and light up
  const samples = [];
  for (let i = 0; i < 30; i++) { samples.push(await con.evaluate(() => window.__opMainPv ? { l: window.__opMainPv.level, bg: window.__opMainPv.bg, run: window.__opMainPv.running, tl: window.__opMainPv.hasTimeline } : null)); await sleep(85); }
  const ok = samples.filter(Boolean);
  const levels = ok.map((s) => s.l);
  const min = Math.min(...levels), max = Math.max(...levels);
  const nonBlack = ok.filter((s) => s.bg && s.bg !== '#000' && s.bg !== 'rgb(0,0,0)').length;
  check('preview_has_real_timeline', ok.length > 0 && ok[ok.length - 1].tl && ok[ok.length - 1].run, 'running=' + (ok.length && ok[ok.length - 1].run) + ' hasTimeline=' + (ok.length && ok[ok.length - 1].tl));
  check('preview_reacts_to_music', (max - min) > 0.08, `Live preview level swing min=${min.toFixed(2)} max=${max.toFixed(2)} (reacts to the real music, not dead)`);
  check('preview_lights_up', nonBlack >= 3, `preview lit (non-black) in ${nonBlack}/${ok.length} samples (not "as if music isn't playing")`);
  check('no_js_errors', perr.length === 0, perr.slice(0, 2).join(' | '));

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'preview_music_report.json'), JSON.stringify({ base: BASE, min, max, nonBlack, samples: ok.length, fails }, null, 2));
  if (fails.length) { console.error('PREVIEW MUSIC FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('PREVIEW MUSIC PASS: the console Live preview samples the armed track\'s REAL envelope at the play position and pulses with the music (level swings + lights up), even with Live presets OFF.');
}
main().catch((e) => { console.error(e); process.exit(1); });
