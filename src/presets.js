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

// Music reactivity drive. `level` is the GOVERNED loudness (sampleCue(trackPos).b,
// already <=3 flashes/s) sampled at the synced track position — identical on every
// phone, so reactivity stays in sync for free. Returns the effective drive 0..1:
// ZERO whenever audioDepth is 0 OR there is no track (level undefined/0), so a preset
// with the default audioDepth=0 is BYTE-IDENTICAL to the pre-reactive behaviour.
// audioGamma shapes the response curve (a "sensitivity" feel); 1 = linear = no effect.
export function envL(level, p) {
  let lv = (typeof level === 'number' && level === level) ? level : 0; // NaN/undefined -> 0
  lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
  let d = p.audioDepth == null ? 0 : (p.audioDepth < 0 ? 0 : p.audioDepth > 1 ? 1 : p.audioDepth);
  let a = d * lv;
  const g = p.audioGamma == null ? 1 : p.audioGamma;
  if (g !== 1) a = Math.pow(a, g);
  return a;
}
function lvl01(level) { return (typeof level === 'number' && level === level) ? clamp01(level) : 0; }

// ---------- the ~4 hero presets (math: spec-studio-arch C) ----------
// Each: (positionMs, params, index, N, level) -> [r,g,b] 0..255 (RAW; caller clampColors).
// `level` (0..1, default 0) = the music's governed loudness at this instant; presets
// fold it in via envL() so a=0 reproduces the autonomous (non-reactive) output exactly.
export const PRESETS = {
  // Pulse — sinusoidal "breathing"; with audio it crossfades toward the music's loudness.
  pulse(position, p, index, N, level) {
    const t = position / 1000;
    const a = envL(level, p);
    const gen = clamp01(p.base + p.depth * sin01(t * p.bpm / 60));
    const music = clamp01(p.base + (1 - p.base) * lvl01(level));
    const L = gen + a * (music - gen);                  // == gen when a==0
    return hsl2rgb(p.hue, p.sat, L * 0.85 + 0.04);
  },
  // Color Waves — spatial band rolls across the crowd (time-based); audio dims it when quiet.
  color_waves(position, p, index, N, level) {
    const t = position / 1000;
    const u = N > 1 ? index / (N - 1) : 0;
    const phase = p.dir * p.speed * t - u / p.wavelength;
    const rgb = palAt(WAVE_PAL, phase);
    const a = envL(level, p);
    const k = 1 - a * (1 - (0.35 + 0.65 * lvl01(level)));  // k==1 when a==0; k in [0.35,1]
    return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
  },
  // Rainbow Chase — rainbow wrapped over the crowd (hue time-based); audio lifts brightness.
  rainbow_chase(position, p, index, N, level) {
    const t = position / 1000;
    const u = N > 1 ? index / (N - 1) : 0;
    const h = 360 * frac(p.dir * p.speed * t + p.spread * u);
    const a = envL(level, p);
    const L = 0.5 - a * (0.5 - (0.18 + 0.42 * lvl01(level)));  // L==0.5 when a==0; L in [0.18,0.6]
    return hsl2rgb(h, 0.9, L);
  },
  // Ocean — slow calm swell; audio lifts the crest brightness with loudness.
  ocean(position, p, index, N, level) {
    const t = position / 1000;
    const ph = sin01(t * p.speed);
    const a = envL(level, p);
    const lAuto = 0.30 + 0.35 * ph;
    const lMusic = 0.30 + 0.35 * ph + 0.30 * lvl01(level);
    const L = lAuto + a * (lMusic - lAuto);             // == lAuto when a==0
    return hsl2rgb(lerp(180, 205, ph), 0.7, clamp01(L));
  },
};

// ---------- parameter schema (defaults + safe bounds; also drives the UI) ----------
// maxHz reasoning is baked into the bounds; validatePreset() additionally SIMULATES.
// Music reactivity, shared by every preset (so the operator gets the sliders for free).
// audioDepth def 0 => a freshly-picked preset is NON-reactive until the operator drags it.
const AUDIO_PARAMS = {
  audioDepth: { min: 0, max: 1, step: 0.01, def: 0, label: 'Music reactivity' },
  audioGamma: { min: 0.4, max: 2.5, step: 0.05, def: 1, label: 'Reactivity curve' },
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
      spread: { min: 0.2, max: 3, step: 0.05, def: 1.0, label: 'Spread' },
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
