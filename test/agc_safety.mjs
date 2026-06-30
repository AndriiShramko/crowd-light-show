// ROUND 11 — phase C, red-team P0-1: the new AGC (audio.js) AMPLIFIES quiet sections, which creates
// MORE low->high luminance crossings — so the ≤3 flashes/s epilepsy cap MUST be proven to hold on the
// AGC output, not on a pre-governed fixture. This runs the FULL real pipeline (analyze -> compileFrom
// Envelope, which ends in clampSafety) on ADVERSARIAL synthetic audio and asserts maxFlashesPerWindow
// <= 3 every time. (presets_safety.test.mjs proves the on-DEVICE makeBackstop separately.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/audio.js';
import { compileFromEnvelope, maxFlashesPerWindow } from '../src/compiler.js';

const SR = 22050, DUR = 12; // 12s synthetic tracks
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-'));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

function writeWav(file, samples) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2); }
  fs.writeFileSync(file, buf);
}
const N = SR * DUR;
function gen(fn) { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = fn(i / SR, i); return a; }
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

const cases = {
  // near-silence with sparse loud transients (AGC will try hardest to amplify the quiet)
  silence_sparse: gen((t) => { const click = (t % 1.7) < 0.03 ? 0.9 : 0; return click * Math.sin(2 * Math.PI * 440 * t) + 0.002 * rnd(); }),
  // quiet verse (0.04) -> loud chorus (0.9) hard step at 6s
  quiet_then_loud: gen((t) => (t < 6 ? 0.04 : 0.9) * Math.sin(2 * Math.PI * 220 * t)),
  // broadband white noise (no tonal structure)
  white_noise: gen(() => 0.5 * rnd()),
  // 2 Hz pulse train (a click every 0.5s — directly tempts the flash gate)
  pulse_2hz: gen((t) => ((t % 0.5) < 0.04 ? 0.95 : 0) * Math.sin(2 * Math.PI * 660 * t)),
  // 8 Hz amplitude modulation (way above the 3/s cap — the gate MUST suppress)
  am_8hz: gen((t) => (0.5 + 0.5 * Math.sign(Math.sin(2 * Math.PI * 8 * t))) * 0.9 * Math.sin(2 * Math.PI * 330 * t)),
};

async function main() {
  for (const [name, samples] of Object.entries(cases)) {
    const file = path.join(tmp, name + '.wav'); writeWav(file, samples);
    const { durationMs, envelope, beats } = await analyze(file);
    const cues = compileFromEnvelope(envelope, { durationMs, beats });
    const fpw = maxFlashesPerWindow(cues);
    check('cap_' + name, fpw <= 3, `max flashes/1s = ${fpw} (<=3) on AGC'd ${name}`);
    // sanity: the AGC produced a non-trivial envelope (not all-zero) except where it should be dark
    const maxB = Math.max(...cues.map((c) => c.b || 0));
    if (name !== 'silence_sparse') check('alive_' + name, maxB > 0.3, `peak b=${maxB.toFixed(2)} (AGC drives the lights)`);
  }
  // EVENNESS (red-team P2-8 / owner pt 18): the SAME slow modulation at a QUIET level and at a LOUD
  // level must produce SIMILAR light swing — that is "even reactivity regardless of absolute loudness".
  // With the old global-p95 normalization the quiet half barely moved (ratio << 1); AGC brings it ~1.
  const evenSamples = gen((t) => { const mod = 0.5 + 0.5 * Math.max(0, Math.sin(2 * Math.PI * 1.2 * t)); const level = (t < 6 ? 0.06 : 0.85); return level * mod * Math.sin(2 * Math.PI * 200 * t); });
  writeWav(path.join(tmp, 'even.wav'), evenSamples);
  const ev = await analyze(path.join(tmp, 'even.wav'));
  const evc = compileFromEnvelope(ev.envelope, { durationMs: ev.durationMs, beats: ev.beats });
  const swingIn = (a, c) => { let lo = 1, hi = 0; for (const cue of evc) if (cue.t >= a && cue.t <= c) { const b = cue.b || 0; if (b < lo) lo = b; if (b > hi) hi = b; } return hi - lo; };
  const sQuiet = swingIn(1500, 5500), sLoud = swingIn(7000, 11500); // skip the transition window
  const ratio = sQuiet / Math.max(1e-4, sLoud);
  check('reactivity_even', ratio >= 0.5 && ratio <= 2.0, `quiet swing ${sQuiet.toFixed(2)} vs loud ${sLoud.toFixed(2)} -> ratio ${ratio.toFixed(2)} (must be in [0.5,2.0] — even across loudness)`);
  check('quiet_alive', sQuiet >= 0.2, `quiet-section swing ${sQuiet.toFixed(2)} (>=0.2 — lively even when quiet)`);

  // silence stays dark: a truly silent buffer must yield ~no light (MIN_SPAN guard)
  const silent = new Float32Array(N); writeWav(path.join(tmp, 'silent.wav'), silent);
  const z = await analyze(path.join(tmp, 'silent.wav'));
  const zc = compileFromEnvelope(z.envelope, { durationMs: z.durationMs, beats: z.beats });
  check('silence_dark', Math.max(...zc.map((c) => c.b || 0)) < 0.15, 'peak b on pure silence = ' + Math.max(...zc.map((c) => c.b || 0)).toFixed(3));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  if (fails.length) { console.error('AGC SAFETY FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('AGC SAFETY PASS: the rolling-AGC envelope stays <=3 flashes/s through clampSafety on every adversarial input (silence+transients, quiet->loud, noise, 2Hz/8Hz pulses); silence stays dark.');
}
main().catch((e) => { console.error(e); process.exit(1); });
