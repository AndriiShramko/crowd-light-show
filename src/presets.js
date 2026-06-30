// Parametric preset engine (server-authoritative core).
//
// The live "studio" channel never streams frames. The server broadcasts a tiny
// descriptor { type, params, epoch, startedAt } and EVERY phone computes its own
// colour each frame as:
//
//     rgb = PRESETS[type](position = serverNow - startedAt, params, index, N)
//     rgb = clampColor(rgb)            // safety backstop (no saturated red)
//
// Because every phone evaluates the same pure function off the same synced clock,
// they are in sync for free (the only error term is the clock offset, ~ms).
//
// SAFETY: validatePreset() is the authoritative gate. It clamps every parameter to
// a safe range and then SIMULATES the resulting luminance series; if it could
// exceed 3 luminance flashes / 1000 ms or show large saturated red, it is clamped
// further or rejected. The browser mirror (public/presets.js) is byte-checked
// against this module by test/presets_parity.mjs, and clampColor here is the exact
// same governor used by the timeline compiler.
import { clampColor } from './compiler.js';

export { clampColor };

// ---------- math helpers (must stay identical to the browser mirror) ----------
export function frac(x) { return x - Math.floor(x); }
export function sin01(x) { return 0.5 + 0.5 * Math.sin(2 * Math.PI * x); }
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
// shortest-arc hue interpolation (avoids the 359->0 wrap flashing through the wheel)
function lerpHue(a, b, t) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return ((a + d * t) % 360 + 360) % 360;
}

export function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp01(s); l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// relative luminance (WCAG-ish, 0..1) of an 0..255 rgb triple
export function relLum(rgb) { return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255; }

// A calm, accessible HSL palette (no pure saturated red). [h, s, l]
const WAVE_PAL = [
  [265, 0.65, 0.45], [205, 0.70, 0.50], [175, 0.60, 0.48],
  [140, 0.60, 0.46], [285, 0.55, 0.42],
];
function palAt(pal, x) {
  x = frac(x);
  const n = pal.length, fx = x * n, i = Math.floor(fx) % n, j = (i + 1) % n, f = fx - Math.floor(fx);
  const a = pal[i], b = pal[j];
  return hsl2rgb(lerpHue(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f));
}

// Music reactivity drive (round 8A — much stronger, operator-tunable). `level` is the
// GOVERNED loudness (sampleCue(trackPos).b, already <=3 flashes/s) at the synced track
// position — identical on every phone, so reactivity stays in sync for free. It is
// CONDITIONED so the slider has real bite: floor-gate drops the quiet-room baseline,
// normalize re-spans 0..1, GAIN makes loud parts reach full sooner (punch), GAMMA lifts
// the mids. Returns { m, a }:
//   m = conditioned drive 0..1 (what the brightness tracks when reactive)
//   a = crossfade weight = audioDepth (0 = autonomous look, 1 = fully music-driven)
// When audioDepth is 0 it returns { m:0, a:0 } => the preset is BYTE-IDENTICAL to the
// autonomous (pre-reactive) output for ANY audioGain/audioFloor/audioGamma — the depth=0
// invariant proven by test/presets_parity.
export function audioDrive(level, p) {
  let d = p.audioDepth == null ? 0 : (p.audioDepth < 0 ? 0 : p.audioDepth > 1 ? 1 : p.audioDepth);
  if (d === 0) return { m: 0, a: 0 };                         // exact autonomous output, any other params
  let lv = (typeof level === 'number' && level === level) ? level : 0; // NaN/undefined -> 0
  lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
  const floor = p.audioFloor == null ? 0 : (p.audioFloor < 0 ? 0 : p.audioFloor > 0.9 ? 0.9 : p.audioFloor);
  const gain = p.audioGain == null ? 1 : (p.audioGain < 0.1 ? 0.1 : p.audioGain > 8 ? 8 : p.audioGain);
  const gamma = p.audioGamma == null ? 1 : p.audioGamma;
  let x = (lv - floor) / (1 - floor);                          // floor-gate + normalize
  if (x < 0) x = 0;
  x = x * gain; if (x > 1) x = 1;                              // gain: loud saturates sooner = punch
  if (gamma !== 1) x = Math.pow(x, gamma);                     // gamma<1 lifts the mid response
  return { m: x, a: d };
}

// ---------- the ~4 hero presets (math: spec-studio-arch C) ----------
// Each: (positionMs, params, index, N, level) -> [r,g,b] 0..255 (RAW; caller clampColors).
// `level` (0..1, default 0) = the music's governed loudness at this instant; presets
// fold it in via audioDrive() so audioDepth=0 reproduces the autonomous output exactly,
// and a higher audioDepth/audioGain swings the brightness hard with the beat.
export const PRESETS = {
  // Pulse — sinusoidal "breathing"; with audio it crossfades toward the conditioned loudness.
  pulse(position, p, index, N, level) {
    const t = position / 1000;
    const dr = audioDrive(level, p);
    const gen = clamp01(p.base + p.depth * sin01(t * p.bpm / 60));
    const music = clamp01(p.base + (1 - p.base) * dr.m);
    const L = gen + dr.a * (music - gen);               // == gen when dr.a==0
    return hsl2rgb(p.hue, p.sat, L * 0.85 + 0.04);
  },
  // Color Waves — spatial band rolls across the crowd (time-based); audio dims it when quiet.
  color_waves(position, p, index, N, level) {
    const t = position / 1000;
    const u = N > 1 ? index / (N - 1) : 0;
    const phase = p.dir * p.speed * t - u / p.wavelength;
    const rgb = palAt(WAVE_PAL, phase);
    const dr = audioDrive(level, p);
    const k = 1 - dr.a * (1 - (0.30 + 0.70 * dr.m));    // k==1 when dr.a==0; k in [0.30,1]
    return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
  },
  // Rainbow Chase — rainbow wrapped over the crowd (hue time-based); audio lifts brightness.
  rainbow_chase(position, p, index, N, level) {
    const t = position / 1000;
    const u = N > 1 ? index / (N - 1) : 0;
    const h = 360 * frac(p.dir * p.speed * t + p.spread * u);
    const dr = audioDrive(level, p);
    const L = 0.5 - dr.a * (0.5 - (0.15 + 0.45 * dr.m));  // L==0.5 when dr.a==0; L in [0.15,0.6]
    return hsl2rgb(h, 0.9, L);
  },
  // Ocean — slow calm swell; audio lifts the crest brightness with loudness.
  ocean(position, p, index, N, level) {
    const t = position / 1000;
    const ph = sin01(t * p.speed);
    const dr = audioDrive(level, p);
    const lAuto = 0.30 + 0.35 * ph;
    const lMusic = lAuto + 0.40 * dr.m;
    const L = lAuto + dr.a * (lMusic - lAuto);          // == lAuto when dr.a==0
    return hsl2rgb(lerp(180, 205, ph), 0.7, clamp01(L));
  },
};

// ---------- parameter schema (defaults + safe bounds; also drives the UI) ----------
// maxHz reasoning is baked into the bounds; validatePreset() additionally SIMULATES.
// Music reactivity, shared by every preset (so the operator gets the sliders for free).
// audioDepth def 0.6 (round 10) => presets react to the music OUT OF THE BOX (a visible swing
// that still keeps the preset's own motion). depth=0 still == byte-identical autonomous output
// (the d===0 short-circuit in audioDrive is untouched; the parity test asserts that with an
// explicit 0), so this is a DEFAULT change only, not an engine change.
const AUDIO_PARAMS = {
  audioDepth: { min: 0, max: 1, step: 0.01, def: 0.6, label: 'Music reactivity' },
  audioGain: { min: 1, max: 6, step: 0.1, def: 2.5, label: 'Reactivity strength' },
  audioFloor: { min: 0, max: 0.5, step: 0.01, def: 0.12, label: 'Reactivity floor' },
  audioGamma: { min: 0.4, max: 1.6, step: 0.05, def: 0.8, label: 'Reactivity curve' },
};
export const PARAM_SCHEMA = {
  pulse: {
    label: 'Pulse', spatial: false,
    params: {
      bpm: { min: 30, max: 180, step: 1, def: 70, label: 'Tempo (BPM)' },   // <=180 => <=3 fl/s
      depth: { min: 0, max: 0.8, step: 0.01, def: 0.55, label: 'Depth' },
      base: { min: 0.05, max: 0.5, step: 0.01, def: 0.18, label: 'Floor' },
      hue: { min: 0, max: 360, step: 1, def: 265, label: 'Hue' },
      sat: { min: 0, max: 1, step: 0.01, def: 0.7, label: 'Saturation' },
      ...AUDIO_PARAMS,
    },
  },
  color_waves: {
    label: 'Color Waves', spatial: true,
    params: {
      speed: { min: 0.02, max: 0.6, step: 0.01, def: 0.15, label: 'Speed' },
      wavelength: { min: 0.3, max: 3, step: 0.05, def: 1.0, label: 'Wavelength' },
      dir: { min: -1, max: 1, step: 2, def: 1, label: 'Direction' },
      ...AUDIO_PARAMS,
    },
  },
  rainbow_chase: {
    label: 'Rainbow Chase', spatial: true,
    params: {
      speed: { min: 0.02, max: 0.5, step: 0.01, def: 0.1, label: 'Speed' },
      spread: { min: 0, max: 3, step: 0.05, def: 1.0, label: 'Spread' },
      dir: { min: -1, max: 1, step: 2, def: 1, label: 'Direction' },
      ...AUDIO_PARAMS,
    },
  },
  ocean: {
    label: 'Ocean', spatial: false,
    params: {
      speed: { min: 0.04, max: 0.3, step: 0.01, def: 0.12, label: 'Speed' },
      ...AUDIO_PARAMS,
    },
  },
};

export const DEFAULT_PRESET = 'pulse';
export const PRESET_TYPES = Object.keys(PARAM_SCHEMA);

// Fill defaults and clamp every numeric param to its safe range. Unknown keys dropped.
export function normalizeParams(type, params) {
  const schema = PARAM_SCHEMA[type];
  if (!schema) return null;
  const out = {};
  for (const [key, spec] of Object.entries(schema.params)) {
    let v = params && params[key] != null ? Number(params[key]) : spec.def;
    if (!Number.isFinite(v)) v = spec.def;
    v = Math.max(spec.min, Math.min(spec.max, v));
    if (key === 'dir') v = v < 0 ? -1 : 1;
    out[key] = v;
  }
  return out;
}

// Simulate the post-clamp luminance series across representative indices and report
// the worst flash-rate (per 1000ms window) and the worst red-ratio actually shown.
const LOW = 0.25, HIGH = 0.6, MAX_RED_RATIO = 0.8;
export function simulate(type, params, N = 12) {
  const fn = PRESETS[type];
  const idxs = N > 2 ? [0, Math.floor((N - 1) / 2), N - 1] : [0];
  let maxFlashes = 0, maxRed = 0;
  // Dual-pass over loudness: level=0 (autonomous, the binding strobe case) and level=1
  // (max music). A constant held level can't oscillate, so level=0 stays the worst case;
  // the live signal (governed b, <=3/s) is even safer. The on-device makeBackstop is the
  // hard guarantee for intermediate, varying loudness (proved by test/presets_safety).
  for (const lvl of [0, 1]) {
    for (const index of idxs) {
      const cross = [];
      let armed = true;
      for (let ms = 0; ms <= 4000; ms += 10) {
        const rgb = clampColor(fn(ms, params, index, N, lvl));   // exactly what the phone paints
        const sum = rgb[0] + rgb[1] + rgb[2];
        if (sum > 0) maxRed = Math.max(maxRed, rgb[0] / sum);
        const L = relLum(rgb);
        if (L < LOW) armed = true;
        else if (L >= HIGH && armed) { cross.push(ms); armed = false; }
      }
      // max crossings in any 1000ms sliding window
      let j = 0, w = 0;
      for (let i = 0; i < cross.length; i++) { while (cross[i] - cross[j] >= 1000) j++; w = Math.max(w, i - j + 1); }
      maxFlashes = Math.max(maxFlashes, w);
    }
  }
  return { maxFlashesPerWindow: maxFlashes, maxRedRatio: maxRed };
}

// Authoritative gate. Returns { ok, type, params } (safe to broadcast) or { ok:false, error }.
export function validatePreset(type, rawParams) {
  if (type === 'off') return { ok: true, type: 'off', params: {} };
  if (!PARAM_SCHEMA[type]) return { ok: false, error: 'unknown preset type' };
  let params = normalizeParams(type, rawParams);
  let sim = simulate(type, params, 12);
  // Defense in depth: if a clamped preset could still strobe (it shouldn't, by the
  // bounds above), pull its rate down until safe; if even then unsafe, reject.
  let guard = 0;
  while (sim.maxFlashesPerWindow > 3 && guard++ < 8) {
    if (type === 'pulse') params.bpm = Math.max(30, params.bpm * 0.7);
    else if (params.speed != null) params.speed = Math.max(0.02, params.speed * 0.7);
    else break;
    sim = simulate(type, params, 12);
  }
  if (sim.maxFlashesPerWindow > 3) return { ok: false, error: 'preset exceeds flash-rate limit' };
  return { ok: true, type, params, sim };
}

// Validate a single param update against the schema (for live morphing).
export function validateParam(type, key, value) {
  const schema = PARAM_SCHEMA[type];
  if (!schema || !schema.params[key]) return { ok: false, error: 'unknown param' };
  const spec = schema.params[key];
  let v = Number(value);
  if (!Number.isFinite(v)) return { ok: false, error: 'not a number' };
  v = Math.max(spec.min, Math.min(spec.max, v));
  if (key === 'dir') v = v < 0 ? -1 : 1;
  return { ok: true, key, value: v };
}

// ======================= TORCH channel (round 8B) =======================
// An AUTONOMOUS flash (camera-LED) channel, fully independent of the screen presets above
// (different presets, different reactivity sliders, separate state). The torch is binary
// (LED on/off), so a torch preset returns an INTENSITY 0..1 the phone thresholds (>=0.5) to
// drive the LED, with its own on-device rate gate. iOS has NO web torch API -> on iPhone the
// channel is a no-op (the screen channel is unaffected). Lives here so the parity test covers
// it and the operator preview can render it. The flash RATE is structurally capped (rate<=2.8
// in TORCH_SCHEMA) AND the gate (makeTorchGate) + simulateTorch enforce <=3 flashes/s.

// Torch music-reactivity drive — parallel to audioDrive but with torch-prefixed knobs, so the
// flash reactivity is tuned SEPARATELY from the screen.
export function torchDrive(level, p) {
  let d = p.torchDepth == null ? 0 : (p.torchDepth < 0 ? 0 : p.torchDepth > 1 ? 1 : p.torchDepth);
  if (d === 0) return 0;
  let lv = (typeof level === 'number' && level === level) ? level : 0;
  lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
  const floor = p.torchFloor == null ? 0 : (p.torchFloor < 0 ? 0 : p.torchFloor > 0.9 ? 0.9 : p.torchFloor);
  const gain = p.torchGain == null ? 1 : (p.torchGain < 0.1 ? 0.1 : p.torchGain > 8 ? 8 : p.torchGain);
  const gamma = p.torchGamma == null ? 1 : p.torchGamma;
  let x = (lv - floor) / (1 - floor);
  if (x < 0) x = 0;
  x = x * gain; if (x > 1) x = 1;
  if (gamma !== 1) x = Math.pow(x, gamma);
  return d * x;
}

// deterministic hashed pseudo-random in [0,1) from an integer (no Math.random -> every phone
// sparkles identically, in sync).
function hash01(n) { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); }

// Each torch preset: (positionMs, params, index, N, level) -> intensity 0..1.
export const TORCH_PRESETS = {
  off() { return 0; },
  // steady square strobe at `rate` (<=2.8 Hz), `duty` = on-fraction.
  strobe(position, p, index, N, level) {
    return frac((position / 1000) * p.rate) < p.duty ? 1 : 0;
  },
  // sparse twinkle: in each 1/rate slot a hashed subset (by time + crowd index) flashes briefly.
  sparkle(position, p, index, N, level) {
    const t = position / 1000;
    const slot = Math.floor(t * p.rate);
    const u = N > 1 ? index / N : 0;
    const h = hash01(slot * 7.13 + Math.floor(u * 997));
    return (h < p.duty && frac(t * p.rate) < 0.5) ? 1 : 0;   // brief on
  },
  // reactive: the torch pulses with the music loudness (torchGain/Floor/Gamma shape it).
  beat(position, p, index, N, level) {
    return clamp01(torchDrive(level, p));
  },
};

const TORCH_AUDIO = {
  torchDepth: { min: 0, max: 1, step: 0.01, def: 0.85, label: 'Flash reactivity' },
  torchGain: { min: 1, max: 6, step: 0.1, def: 2.5, label: 'Flash strength' },
  torchFloor: { min: 0, max: 0.5, step: 0.01, def: 0.12, label: 'Flash floor' },
  torchGamma: { min: 0.4, max: 1.6, step: 0.05, def: 0.8, label: 'Flash curve' },
};
export const TORCH_SCHEMA = {
  off: { label: 'Off', params: {} },
  strobe: { label: 'Strobe', params: {
    rate: { min: 0.5, max: 2.8, step: 0.1, def: 2.0, label: 'Rate (Hz)' },   // <=2.8 => <=3 flashes/s
    duty: { min: 0.1, max: 0.6, step: 0.05, def: 0.3, label: 'On time' },
  } },
  sparkle: { label: 'Sparkle', params: {
    rate: { min: 0.5, max: 2.8, step: 0.1, def: 2.5, label: 'Rate (Hz)' },
    duty: { min: 0.1, max: 0.6, step: 0.05, def: 0.3, label: 'Density' },
  } },
  beat: { label: 'Beat (reactive)', params: { ...TORCH_AUDIO } },
};
export const TORCH_TYPES = Object.keys(TORCH_SCHEMA);
export const DEFAULT_TORCH = 'beat'; // round 10: the default flash is reactive (beat) out of the box

export function normalizeTorchParams(type, params) {
  const schema = TORCH_SCHEMA[type];
  if (!schema) return null;
  const out = {};
  for (const [key, spec] of Object.entries(schema.params)) {
    let v = params && params[key] != null ? Number(params[key]) : spec.def;
    if (!Number.isFinite(v)) v = spec.def;
    v = Math.max(spec.min, Math.min(spec.max, v));
    out[key] = v;
  }
  return out;
}

// Count binary ON-edges per 1000ms window (dual-pass over a held loudness — the varying-
// loudness flashing is the on-device makeTorchGate's job, proven by test/presets_safety).
export function simulateTorch(type, params, N = 12) {
  const fn = TORCH_PRESETS[type]; if (!fn) return { maxFlashesPerWindow: 0 };
  const idxs = N > 2 ? [0, Math.floor((N - 1) / 2), N - 1] : [0];
  let maxFlashes = 0;
  for (const lvl of [0, 0.5, 1]) {
    for (const index of idxs) {
      const edges = []; let prev = 0;
      for (let ms = 0; ms <= 4000; ms += 10) {
        const on = fn(ms, params, index, N, lvl) >= 0.5 ? 1 : 0;
        if (on && !prev) edges.push(ms);
        prev = on;
      }
      let j = 0, w = 0; for (let i = 0; i < edges.length; i++) { while (edges[i] - edges[j] >= 1000) j++; w = Math.max(w, i - j + 1); }
      maxFlashes = Math.max(maxFlashes, w);
    }
  }
  return { maxFlashesPerWindow: maxFlashes };
}

// Authoritative torch gate (server). Returns { ok, type, params } or { ok:false, error }.
export function validateTorchPreset(type, rawParams) {
  if (type === 'off') return { ok: true, type: 'off', params: {} };
  if (!TORCH_SCHEMA[type]) return { ok: false, error: 'unknown torch preset' };
  let params = normalizeTorchParams(type, rawParams);
  let sim = simulateTorch(type, params, 12); let guard = 0;
  while (sim.maxFlashesPerWindow > 3 && guard++ < 8) {
    if (params.rate != null) params.rate = Math.max(0.5, params.rate * 0.7); else break;
    sim = simulateTorch(type, params, 12);
  }
  if (sim.maxFlashesPerWindow > 3) return { ok: false, error: 'torch preset exceeds flash-rate limit' };
  return { ok: true, type, params, sim };
}

export function validateTorchParam(type, key, value) {
  const schema = TORCH_SCHEMA[type];
  if (!schema || !schema.params[key]) return { ok: false, error: 'unknown torch param' };
  const spec = schema.params[key];
  let v = Number(value);
  if (!Number.isFinite(v)) return { ok: false, error: 'not a number' };
  v = Math.max(spec.min, Math.min(spec.max, v));
  return { ok: true, key, value: v };
}

// On-device torch rate gate (the hard, per-phone guarantee): at most one ON edge per
// minFlashGap (>=357ms => <=2.8/s, margin under the 3/s cap). Binary in/out, stateful.
export function makeTorchGate(minFlashGap) {
  minFlashGap = minFlashGap || (1000 / 2.8);
  let t = 0, lastOn = -1e9, prevOn = false;
  return function (onWanted, dtMs) {
    dtMs = dtMs || 16; t += dtMs;
    if (onWanted && !prevOn) {                 // requested rising edge
      if (t - lastOn >= minFlashGap) { lastOn = t; prevOn = true; return true; }
      return false;                            // too soon -> suppress (stay off)
    }
    if (!onWanted) { prevOn = false; return false; }
    return true;                               // hold ON (steady on isn't a new flash)
  };
}
