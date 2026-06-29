// ROUND 10 — unit test for the audio drift-corrector tiers (the per-second-stutter fix).
// The stutter was the drift loop reseating (stop+restart the source) on a constant phantom
// ~120ms drift, every tick. The corrector now has THREE tiers; this proves them deterministically
// without real audio (which headless can't render faithfully — its virtual clock drifts ~10ms/s):
//   - |drift| <= DEADBAND (50ms): 'hold', rate stays 1.0 (never chase clock noise / inter-phone floor)
//   - DEADBAND < |drift| <= RESEAT (180ms): ONE bounded nudge (rate = 1 ± <=2%), then forced back to
//     1.0 within NUDGE_TICKS ticks (one-shot — no continuous chasing, so identical phones don't wobble)
//   - |drift| > RESEAT: 'reseat' (a clean reschedule) — the ONLY tier that restarts the source
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
function fresh() { const a = new AudioSync({}); a.src = { playbackRate: { value: 1 } }; a._nudgeLeft = 0; return a; }
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 1) deadband: small drift -> hold, rate 1.0, no pending nudge
for (const d of [0, 20, -20, 49.9, -49.9]) {
  const a = fresh(); const act = a._applyDriftDecision(d);
  check('hold@' + d, act === 'hold' && near(a.src.playbackRate.value, 1) && a._nudgeLeft === 0, 'act=' + act + ' rate=' + a.src.playbackRate.value);
}

// 2) medium drift -> one bounded nudge (+ve drift = audio behind = play faster = rate>1)
{
  const a = fresh(); const act = a._applyDriftDecision(80);
  check('nudge_pos', act === 'nudge' && near(a.src.playbackRate.value, 1.02) && a._nudgeLeft === 2, 'act=' + act + ' rate=' + a.src.playbackRate.value + ' left=' + a._nudgeLeft);
}
{
  const a = fresh(); const act = a._applyDriftDecision(-80);
  check('nudge_neg', act === 'nudge' && near(a.src.playbackRate.value, 0.98) && a._nudgeLeft === 2, 'act=' + act + ' rate=' + a.src.playbackRate.value);
}

// 3) bounded: rate never exceeds ±2% even for a near-reseat drift (179ms)
{
  const a = fresh(); a._applyDriftDecision(179);
  check('nudge_bounded', a.src.playbackRate.value <= 1.0200001 && a.src.playbackRate.value >= 0.98, 'rate=' + a.src.playbackRate.value);
}

// 4) one-shot: nudge -> hold rate for NUDGE_TICKS, last tick forces back to exactly 1.0
{
  const a = fresh();
  a._applyDriftDecision(80);                       // tick1: nudge, rate 1.02, left=2
  const t2 = a._applyDriftDecision(80);            // tick2: nudging, left=1, rate held
  const r2 = a.src.playbackRate.value;
  const t3 = a._applyDriftDecision(80);            // tick3: nudging, left=0, rate forced to 1.0
  const r3 = a.src.playbackRate.value;
  const t4 = a._applyDriftDecision(80);            // tick4: drift still high -> may re-nudge (proves it's a bounded DUTY cycle, not continuous)
  check('oneshot_holds', t2 === 'nudging' && near(r2, 1.02) && t3 === 'nudging' && near(r3, 1), 't2=' + t2 + ' r2=' + r2 + ' t3=' + t3 + ' r3=' + r3);
  check('oneshot_refires', t4 === 'nudge' && near(a.src.playbackRate.value, 1.02), 't4=' + t4 + ' rate=' + a.src.playbackRate.value);
}

// 5) large drift -> reseat (the ONLY tier that restarts the source), rate forced to 1, no pending nudge
{
  const a = fresh(); const act = a._applyDriftDecision(200);
  check('reseat', act === 'reseat' && near(a.src.playbackRate.value, 1) && a._nudgeLeft === 0, 'act=' + act);
}
// reseat takes priority even mid-nudge
{
  const a = fresh(); a._applyDriftDecision(80); const act = a._applyDriftDecision(250);
  check('reseat_priority', act === 'reseat' && a._nudgeLeft === 0 && near(a.src.playbackRate.value, 1), 'act=' + act + ' left=' + a._nudgeLeft);
}

// 6) thresholds are the documented round-10 values
check('thresholds', AudioSync.DEADBAND_MS === 50 && AudioSync.RESEAT_MS === 180 && AudioSync.NUDGE_MAX === 0.02, `DB=${AudioSync.DEADBAND_MS} RS=${AudioSync.RESEAT_MS} MAX=${AudioSync.NUDGE_MAX}`);

if (fails.length) { console.error('DRIFT LOGIC FAIL: ' + fails.join('; ')); process.exit(1); }
console.log('DRIFT LOGIC PASS: deadband holds at 1.0, medium drift = one bounded ±2% one-shot nudge, big jump = reseat (only tier that restarts the source).');
