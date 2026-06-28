// Per-phone synchronized audio proof. Spawns N headless phones that opt into audio,
// decode the armed track, and (on GO) schedule playback off the synced clock. We do
// NOT measure sound (headless has no speaker); we assert the SCHEDULED START — mapped
// back to a show-clock instant — agrees across phones and equals T0. That proves the
// AudioContext<->show-clock mapping + scheduling math are coherent, so every phone
// would sound the same sample at the same wall instant. (Same honest caveat as
// sync_harness: protocol + scheduling, not real phones / real acoustics.)
//
// Uses a WAV fixture because headless Chromium can't decode proprietary AAC.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const N = Number(process.env.N || 6);
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (token, extra) => ({ Authorization: 'Bearer ' + token, ...(extra || {}) });
function percentile(arr, p) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');

  // Upload a decodable WAV fixture, attest it (crowd audio is licence-gated), arm it.
  const fd = new FormData();
  fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  const trackId = up.trackId;
  if (!trackId) throw new Error('upload failed: ' + JSON.stringify(up));
  await fetch(BASE + '/api/operator/track/' + trackId + '/attest', { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId }) }).then(j);
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;

  // gate check: audio served (attested) vs a fresh unauth fetch
  const audioStatus = (await fetch(BASE + '/api/audience/audio')).status;

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const pages = [];
  for (let i = 0; i < N; i++) { const p = await (await browser.newContext()).newPage(); await p.goto(`${BASE}/join?s=${code}&auto=1&audio=1`); pages.push(p); }
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 }).catch(() => {})));
  // wait for the audio buffer to decode on every phone
  const decoded = await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls.audio && window.__cls.audio.ready, { timeout: 20000 }).then(() => true).catch(() => false)));

  await fetch(BASE + '/api/operator/go', { method: 'POST', headers: H(token) }).then(j);
  const scheduledAll = await Promise.all(pages.map((p) => p.waitForFunction(() => window.__cls.audio && window.__cls.audio.scheduled, { timeout: 8000 }).then(() => true).catch(() => false)));
  await new Promise((r) => setTimeout(r, 2500)); // let the drift loop run a couple ticks
  const snap = await Promise.all(pages.map((p) => p.evaluate(() => window.__cls.audio)));
  await browser.close();
  // cleanup: remove the fixture track we added
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token) });
  await fetch(BASE + '/api/operator/track/' + trackId, { method: 'DELETE', headers: H(token) });

  const instants = snap.map((a) => a && a.scheduledShowInstant).filter((x) => Number.isFinite(x));
  const T0s = snap.map((a) => a && a.T0).filter((x) => Number.isFinite(x));
  const pair = [];
  for (let i = 0; i < instants.length; i++) for (let k = i + 1; k < instants.length; k++) pair.push(Math.abs(instants[i] - instants[k]));
  const p95 = Math.round(percentile(pair, 95));
  const maxSpread = Math.round(pair.length ? Math.max(...pair) : 0);
  const offsetFromT0 = snap.map((a) => a && Number.isFinite(a.scheduledShowInstant) && Number.isFinite(a.T0) ? Math.abs(a.scheduledShowInstant - a.T0) : Infinity);
  const worstFromT0 = Math.round(Math.max(...offsetFromT0));
  const drifts = snap.map((a) => a && Math.abs(a.driftMs || 0));
  const worstDrift = Math.round(Math.max(...drifts));

  const report = {
    base: BASE, clients: N, audioEndpointStatus: audioStatus,
    decodedAll: decoded.every(Boolean), scheduledAll: scheduledAll.every(Boolean),
    p95SpreadMs: p95, maxSpreadMs: maxSpread, worstDeltaFromT0Ms: worstFromT0, worstDriftMs: worstDrift,
    note: 'scheduledShowInstant = the show-clock ms instant each phone scheduled audio sample 0 to sound. Agreement across phones (and == T0) proves the AudioContext<->show-clock mapping. Headless = protocol+scheduling, NOT real speakers/acoustics (speed of sound caps real-venue audio — small-venue/moment feature).',
  };
  fs.writeFileSync(path.join(dir, '..', 'audio_report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const fails = [];
  if (audioStatus !== 200) fails.push('audio endpoint not 200 for attested track (' + audioStatus + ')');
  if (!report.decodedAll) fails.push('not all phones decoded the audio');
  if (!report.scheduledAll) fails.push('not all phones scheduled audio');
  if (worstFromT0 > 15) fails.push('scheduled instant != T0 (worst ' + worstFromT0 + 'ms)');
  if (p95 > 15) fails.push('cross-phone schedule spread p95 ' + p95 + 'ms > 15ms');
  if (worstDrift > 60) fails.push('drift not bounded (worst ' + worstDrift + 'ms)');
  if (fails.length) { console.error('AUDIO SYNC FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log(`AUDIO SYNC PASS: ${N} phones decoded + scheduled audio at the same show instant (p95 spread ${p95}ms, ≤15; ==T0 within ${worstFromT0}ms; drift ≤${worstDrift}ms).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
