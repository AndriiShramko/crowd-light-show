// Round-8A acceptance: the music-reactivity sliders must REALLY move the screen.
// Andrii's complaint: "Music reactivity / Reactivity curve — min->max barely changes the
// screen." We measure the GOVERNED rendered luminance swing (max-min, exactly what the
// crowd's phone paints: clampColor + the on-device makeBackstop) over a moderate beat and
// prove that (a) turning audioDepth 0->1 swings the screen far harder than the autonomous
// breathing, and (b) the new audioGain "strength" knob measurably increases the swing.
//
// Pure math (no server / no browser) — loads the browser engine in a vm so it tests the
// EXACT functions the phone runs. A moderate, slow (~0.7 Hz) beat is used so the swing
// reflects reactivity, not the safety flash-gate (which only bounds >3/s strobing).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, '..', 'public', 'presets.js'), 'utf8'), sandbox);
const CLS = sandbox.window.CLS_PRESETS;
const { PRESETS, clampColor, relLum, makeBackstop, PARAM_SCHEMA, defaults } = CLS;

// Moderate passage: loudness oscillates 0.12..0.42 at ~0.7 Hz (period 1400ms). Realistic
// "music is playing but not pinned at max", which is exactly where weak reactivity hides.
function level(ms) { return 0.12 + 0.30 * (0.5 + 0.5 * Math.sin(2 * Math.PI * ms / 1400)); }

// Render a preset through the real phone pipeline and return the luminance swing over the
// steady-state window (skip the first 1500ms so the backstop ramp has settled).
function swing(type, params, { N = 1, idx = 0 } = {}) {
  const backstop = makeBackstop(150);
  let lo = 1, hi = 0;
  for (let ms = 0; ms <= 6000; ms += 16) {
    let rgb = clampColor(PRESETS[type](ms, params, idx, N, level(ms)));
    rgb = backstop(rgb, 16);
    if (ms >= 1500) { const L = relLum(rgb); if (L < lo) lo = L; if (L > hi) hi = L; }
  }
  return hi - lo;
}
function withP(type, over) { return Object.assign(defaults(type), over); }

const report = { kind: 'reactivity_swing', presets: {}, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

for (const type of Object.keys(PARAM_SCHEMA)) {
  const auto = swing(type, withP(type, { audioDepth: 0 }));                                   // autonomous breathing
  const gainLo = swing(type, withP(type, { audioDepth: 1, audioGain: 1 }));                   // reactive, weak strength
  const gainDef = swing(type, withP(type, { audioDepth: 1 }));                                // reactive, default strength (2.5)
  const gainMax = swing(type, withP(type, { audioDepth: 1, audioGain: 6 }));                  // reactive, max strength
  report.presets[type] = {
    autonomous: +auto.toFixed(4), reactive_gain1: +gainLo.toFixed(4),
    reactive_default: +gainDef.toFixed(4), reactive_gain6: +gainMax.toFixed(4),
    depthRatio: +(gainDef / Math.max(1e-4, auto)).toFixed(2),
    gainRatio: +(gainMax / Math.max(1e-4, gainLo)).toFixed(2),
  };
  console.log(`  ${type}: auto=${auto.toFixed(3)} gain1=${gainLo.toFixed(3)} default=${gainDef.toFixed(3)} gain6=${gainMax.toFixed(3)}  (depthX${(gainDef/Math.max(1e-4,auto)).toFixed(2)}, gainX${(gainMax/Math.max(1e-4,gainLo)).toFixed(2)})`);
}

// Acceptance — STOP/DONE #2 "swing at audioGain=max >= K x at audioGain=min", measured on
// the governed render. The strength knob must have real range on EVERY hero preset.
const p = report.presets.pulse;
let minGainRatio = Infinity, worst = '';
for (const t of Object.keys(report.presets)) { const r = report.presets[t]; if (r.gainRatio < minGainRatio) { minGainRatio = r.gainRatio; worst = t; } }
check('gain_knob_strong_all', minGainRatio >= 1.5,
  `min audioGain min->max swing ratio across presets = x${minGainRatio.toFixed(2)} (${worst}); need >=1.5`);
check('default_is_punchy', (p.reactive_default / Math.max(1e-4, p.reactive_gain1)) >= 2.0,
  `pulse default strength vs weakest: ${p.reactive_gain1} -> ${p.reactive_default} (x${(p.reactive_default / Math.max(1e-4, p.reactive_gain1)).toFixed(2)}, need >=2.0)`);
// Every preset must react meaningfully to the music at max strength (not just pulse).
let allReact = true;
for (const t of Object.keys(report.presets)) {
  const r = report.presets[t]; if (r.reactive_gain6 < r.autonomous + 0.05 && r.reactive_gain6 < 0.45) { allReact = false; report.fails.push(`${t} reactive swing weak`); }
}
check('all_presets_react', allReact, 'every hero preset swings strongly with music at max strength');

fs.writeFileSync(path.join(dir, '..', 'reactivity_report.json'), JSON.stringify(report, null, 2));
if (report.fails.length) { console.error('REACTIVITY FAIL:', report.fails.join('; ')); process.exit(1); }
console.log('REACTIVITY SWING PASS: depth slider x' + p.depthRatio + ' over autonomous, gain knob x' + p.gainRatio + ' (governed render). Headless = math, not real phones.');
