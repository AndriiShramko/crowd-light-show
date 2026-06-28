// Landing demo now plays the admin track's MUSIC, looped + synced (not just lights).
// Proven by FACT on a fresh server: upload a (decodable WAV) track so it becomes the demo
// track, open /join?demo=1, and assert the phone decodes it, loops it, and the loop stays
// synced to the demo epoch (driftMs bounded) while the lights play. WAV is used because
// headless Chromium can't decode the production AAC tracks (on real phones AAC plays fine).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

function toneWav() {
  const sr = 22050, secs = 6, n = sr * secs; const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / sr; const amp = 0.5 + 0.4 * Math.sin(2 * Math.PI * t / 3); data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * t) * amp * 32767), i * 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  // ensure a decodable demo track exists at the front of the playlist
  const fd = new FormData(); fd.append('audio', new Blob([toneWav()]), 'demo_tone.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  const trackId = up.trackId;

  const demo = await fetch(BASE + '/api/demo').then(j);
  const audioStatus = (await fetch(BASE + '/api/demo/audio')).status;
  check('demo_offers_audio', demo.hasAudio === true && audioStatus === 200, `/api/demo hasAudio=${demo.hasAudio}, /api/demo/audio=${audioStatus}`);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await (await browser.newContext()).newPage();
  const errs = []; p.on('pageerror', (e) => { if (!/Permissions check/.test(e.message)) errs.push(e.message); });
  await p.goto(`${BASE}/join?demo=1&auto=1`);
  await p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {});
  const looped = await p.waitForFunction(() => window.__cls.audio && window.__cls.audio.looping && window.__cls.audio.ready, { timeout: 15000 }).then(() => true).catch(() => false);
  await p.waitForFunction(() => window.__cls.everLit, { timeout: 8000 }).catch(() => {});
  // let the loop run and sample drift
  let worstDrift = 0;
  for (let s = 0; s < 6; s++) { await sleep(700); const d = await p.evaluate(() => Math.abs((window.__cls.audio && window.__cls.audio.driftMs) || 0)); worstDrift = Math.max(worstDrift, d); }
  const st = await p.evaluate(() => ({ lit: window.__cls.everLit, looping: window.__cls.audio.looping, ready: window.__cls.audio.ready, lang: document.documentElement.lang }));
  await browser.close();
  await fetch(BASE + '/api/operator/track/' + trackId, { method: 'DELETE', headers: H(token) }); // cleanup

  check('demo_plays_looped_audio', looped && st.ready && st.looping, `looping=${st.looping} ready=${st.ready}`);
  check('demo_loop_stays_synced', worstDrift <= 60, `worst loop drift ${worstDrift}ms (<=60)`);
  check('demo_lights_play', st.lit, `everLit=${st.lit}`);
  check('demo_default_english', st.lang === 'en', `<html lang>=${st.lang} (expect en)`);
  check('no_js_errors', errs.length === 0, `errors=${errs.length}${errs[0] ? ' (' + errs[0] + ')' : ''}`);

  fs.writeFileSync(path.join(dir, '..', 'demo_audio_report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  if (report.fails.length) { console.error('\nDEMO AUDIO FAIL: ' + report.fails.join(' | ')); process.exit(1); }
  console.log('\nDEMO AUDIO PASS: the demo plays the admin track looped + synced (drift bounded), lights play, defaults to English.');
}
main().catch((e) => { console.error(e); process.exit(1); });
