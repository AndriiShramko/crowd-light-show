// ROUND 11 — unit test for the audio drift corrector (the "drunk music" fix, owner pt 6).
// The round-10 corrector stepped playbackRate by ±2% (≈34 cents, audible wow). The new one is a
// SLEWED sub-JND trim: a proportional controller with a ±0.3% ceiling and a per-tick slew limit, so
// the played rate is ALWAYS a smooth ramp that never exceeds ±0.3% and never steps. Big jumps reseat.
// Proven deterministically without real audio (the perceptual reasoning is in spec-11-audio).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(dir, '..', 'public', 'audio-sync.js'), 'utf8');
const sandbox = { window: {}, performance: { now: () => 0 } };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const AudioSync = sandbox.window.AudioSync;

const fails = [];
function check(name, ok, detail) { console.log(`${ok ? 'OK  ' : 'FAIL'} [${name}] ${detail || ''}`); if (!ok) fails.push(name + (detail ? ': ' + detail : '')); }
function fresh() { const a = new AudioSync({}); a.src = { playbackRate: { value: 1 } }; return a; }
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

// 1) thresholds are the documented round-11 values
check('thresholds', AudioSync.DEADBAND_MS === 25 && AudioSync.TRIM_MAX === 0.003 && AudioSync.TRIM_SLEW === 0.0010 && AudioSync.RESEAT_MS === 300, `DB=${AudioSync.DEADBAND_MS} MAX=${AudioSync.TRIM_MAX} SLEW=${AudioSync.TRIM_SLEW} RS=${AudioSync.RESEAT_MS}`);

// 2) deadband: small drift -> hold, rate stays exactly 1.0
for (const d of [0, 10, -10, 24.9, -24.9]) {
  const a = fresh(); const act = a._applyDriftDecision(d);
  check('hold@' + d, act === 'hold' && near(a.src.playbackRate.value, 1), 'act=' + act + ' rate=' + a.src.playbackRate.value);
}

// 3) one tick of trim never moves the rate by more than TRIM_SLEW (no step), and toward the target
{
  const a = fresh(); const act = a._applyDriftDecision(200); // far above deadband -> wants the +cap
  check('trim_pos_oneStep', act === 'trim' && near(a.src.playbackRate.value, 1 + AudioSync.TRIM_SLEW), 'rate after 1 tick=' + a.src.playbackRate.value + ' (expect 1+SLEW)');
}
{
  const a = fresh(); const act = a._applyDriftDecision(-200);
  check('trim_neg_oneStep', act === 'trim' && near(a.src.playbackRate.value, 1 - AudioSync.TRIM_SLEW), 'rate=' + a.src.playbackRate.value);
}

// 4) ramps MONOTONICALLY toward the ±0.3% ceiling under sustained drift, never exceeding it, never stepping
{
  const a = fresh(); let prev = 1, maxStep = 0, peak = 1;
  for (let i = 0; i < 20; i++) { a._applyDriftDecision(200); const r = a.src.playbackRate.value; maxStep = Math.max(maxStep, Math.abs(r - prev)); peak = Math.max(peak, r); prev = r; }
  check('ramp_no_step', maxStep <= AudioSync.TRIM_SLEW + 1e-9, 'max per-tick step=' + maxStep);
  check('ramp_bounded', peak <= 1 + AudioSync.TRIM_MAX + 1e-9 && peak >= 1 + AudioSync.TRIM_MAX - 1e-6, 'peak rate=' + peak + ' (expect ~1.003)');
}

// 5) eases BACK toward 1.0 when drift returns to the deadband (no slam, smooth release)
{
  const a = fresh();
  for (let i = 0; i < 10; i++) a._applyDriftDecision(200); // ramp up to ~+0.3%
  const hi = a.src.playbackRate.value;
  const act = a._applyDriftDecision(0); // back in deadband -> target 1.0, but only slew one step
  check('release_ramps', act === 'trim' && a.src.playbackRate.value < hi && a.src.playbackRate.value >= hi - AudioSync.TRIM_SLEW - 1e-9, 'hi=' + hi + ' -> ' + a.src.playbackRate.value);
}

// 6) big jump -> reseat (the ONLY tier that restarts the source), rate forced to 1
{
  const a = fresh(); a._applyDriftDecision(200); const act = a._applyDriftDecision(400);
  check('reseat', act === 'reseat' && near(a.src.playbackRate.value, 1), 'act=' + act + ' rate=' + a.src.playbackRate.value);
}

// 7) rate is NEVER outside ±0.3% across a wide sweep of drift values (inaudible envelope)
{
  let worst = 0;
  for (const d of [-500, -180, -120, -60, -30, 30, 60, 120, 180, 500]) {
    const a = fresh(); for (let i = 0; i < 50; i++) a._applyDriftDecision(d); worst = Math.max(worst, Math.abs(a.src.playbackRate.value - 1));
  }
  check('rate_envelope_subJND', worst <= AudioSync.TRIM_MAX + 1e-9, 'worst |rate-1|=' + worst + ' (<=0.003)');
}

// 8) TIME-DOMAIN containment (owner pt 16: "the PC drifts badly over a minute"). Drive the real
// _driftTick() with a mock clock whose show-time runs +8ms/s faster than audio (a badly-drifting
// desktop). Assert: drift NEVER runs away (stays well under a perceptible runaway), and reseats are
// spaced >= RESEAT_GUARD_MS (no machine-gun stutter). 120 ticks = ~2 min.
{
  let serverMs = 0, ctxSec = 0;
  const a = new AudioSync({ serverNow: () => serverMs });
  a.ctx = { currentTime: 0, state: 'running' };
  a.src = { playbackRate: { value: 1 } };
  a.T0 = 0; a.startOffsetSec = 0; a.startWhenActx = 0; a.outLatencySec = 0; a.tele = () => {};
  let maxAbs = 0, reseats = 0, lastReseatTick = -1e9, minGapMs = 1e9;
  for (let k = 0; k < 120; k++) {
    serverMs += 1008; ctxSec += 1.0;                 // show clock +1008ms/tick, audio +1000ms/tick => +8ms/s drift
    a.ctx.currentTime = ctxSec;
    const r = a._driftTick();
    maxAbs = Math.max(maxAbs, Math.abs(r.drift));
    if (r.action === 'reseat') {
      reseats++;
      const gap = (k - lastReseatTick) * 1000; if (lastReseatTick > -1e8) minGapMs = Math.min(minGapMs, gap);
      lastReseatTick = k;
      a.startWhenActx = ctxSec; a.startOffsetSec = serverMs / 1000; // mimic start() re-anchoring cursor to the show clock
    }
  }
  check('drift_contained_2min', maxAbs < 250, 'max |drift| over 2min = ' + Math.round(maxAbs) + 'ms (must not run away)');
  check('reseats_spaced', reseats === 0 || minGapMs >= AudioSync.RESEAT_GUARD_MS, `reseats=${reseats}, min gap=${minGapMs === 1e9 ? 'n/a' : Math.round(minGapMs) + 'ms'} (>= ${AudioSync.RESEAT_GUARD_MS})`);
}

if (fails.length) { console.error('DRIFT LOGIC FAIL: ' + fails.join('; ')); process.exit(1); }
console.log('DRIFT LOGIC PASS: deadband holds 1.0; sub-JND trim ramps (<=0.1%/tick) to a ±0.3% ceiling and eases back — no audible step; big jump = reseat. Rate envelope stays inaudible.');
