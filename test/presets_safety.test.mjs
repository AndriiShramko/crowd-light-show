// Server-authoritative preset safety. validatePreset() is the only gate from an
// operator/guest request to a broadcast preset; this proves an out-of-envelope
// preset is structurally unrepresentable (clamped or rejected), at any params.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePreset, validateParam, simulate, PRESETS, clampColor, relLum, PARAM_SCHEMA, PRESET_TYPES } from '../src/presets.js';
import { compileFromEnvelope, maxFlashesPerWindow } from '../src/compiler.js';

// load the browser engine for makeBackstop (the on-device safety slew the phone applies)
const __dir = path.dirname(fileURLToPath(import.meta.url));
const __sandbox = { window: {} };
vm.createContext(__sandbox);
vm.runInContext(fs.readFileSync(path.join(__dir, '..', 'public', 'presets.js'), 'utf8'), __sandbox);
const CLS = __sandbox.window.CLS_PRESETS;

const LOW = 0.25, HIGH = 0.6;
function flashesOf(type, params, index, N) {
  const cross = []; let armed = true;
  for (let ms = 0; ms <= 4000; ms += 10) {
    const L = relLum(clampColor(PRESETS[type](ms, params, index, N)));
    if (L < LOW) armed = true; else if (L >= HIGH && armed) { cross.push(ms); armed = false; }
  }
  let j = 0, w = 0; for (let i = 0; i < cross.length; i++) { while (cross[i] - cross[j] >= 1000) j++; w = Math.max(w, i - j + 1); }
  return w;
}

test('every hero preset at DEFAULT params is <=3 flashes/s and no saturated red', () => {
  for (const type of PRESET_TYPES) {
    const v = validatePreset(type, {});
    assert.ok(v.ok, type + ' rejected at defaults');
    for (const N of [3, 12, 30]) for (const idx of [0, Math.floor(N / 2), N - 1]) {
      assert.ok(flashesOf(type, v.params, idx, N) <= 3, `${type} N=${N} idx=${idx} flashes`);
      for (let ms = 0; ms <= 4000; ms += 20) {
        const rgb = clampColor(PRESETS[type](ms, v.params, idx, N)); const sum = rgb[0] + rgb[1] + rgb[2];
        if (sum > 0 && relLum(rgb) > 0.4) assert.ok(rgb[0] / sum < 0.8, `${type} red ratio ${(rgb[0] / sum).toFixed(2)}`);
      }
    }
  }
});

test('pathological params are clamped to a SAFE preset, never strobe (structural)', () => {
  const attacks = [
    { type: 'pulse', params: { bpm: 9999, depth: 5, base: -3, sat: 9, hue: 9999 } },
    { type: 'color_waves', params: { speed: 999, wavelength: 0.0001, dir: 7 } },
    { type: 'rainbow_chase', params: { speed: 999, spread: 999, dir: -9 } },
    { type: 'ocean', params: { speed: 999 } },
  ];
  for (const a of attacks) {
    const v = validatePreset(a.type, a.params);
    assert.ok(v.ok, a.type + ' should clamp, not fail');
    const sim = simulate(v.type, v.params, 24);
    assert.ok(sim.maxFlashesPerWindow <= 3, `${a.type} sim flashes ${sim.maxFlashesPerWindow}`);
    // every param landed within its declared safe bounds
    for (const [k, val] of Object.entries(v.params)) {
      const spec = PARAM_SCHEMA[a.type].params[k];
      assert.ok(val >= spec.min && val <= spec.max, `${a.type}.${k}=${val} out of [${spec.min},${spec.max}]`);
    }
  }
});

test('rainbow_chase sweeps the red hue but the painted red ratio stays < 0.8', () => {
  const v = validatePreset('rainbow_chase', {});
  let sawRedHue = false;
  for (const idx of Array.from({ length: 30 }, (_, i) => i)) {
    const raw = PRESETS.rainbow_chase(0, v.params, idx, 30);
    if (raw[0] > raw[1] * 2 && raw[0] > raw[2] * 2) sawRedHue = true; // a reddish raw colour appears
    const c = clampColor(raw); const sum = c[0] + c[1] + c[2];
    if (sum > 0) assert.ok(c[0] / sum < 0.8, 'painted red ratio ' + (c[0] / sum).toFixed(2));
  }
  assert.ok(sawRedHue, 'expected the rainbow to pass through a red hue');
});

// ---- audio-reactive safety: a beat-heavy track at FULL reactivity stays <=3 flashes/s ----
function sampleB(cues, pos) {
  if (pos <= cues[0].t) return cues[0].b;
  if (pos >= cues[cues.length - 1].t) return cues[cues.length - 1].b;
  let lo = 0, hi = cues.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cues[mid].t <= pos) lo = mid; else hi = mid; }
  const a = cues[lo], b = cues[hi], f = (pos - a.t) / Math.max(1, b.t - a.t);
  return a.b + (b.b - a.b) * f;
}
test('audio-reactive presets stay <=3 flashes/s on a beat-heavy track (rendered pipeline)', () => {
  // a deliberately strobe-prone source: loud<->quiet every 120ms (~8 onsets/s) BEFORE governing
  const env = [];
  for (let t = 0; t <= 8000; t += 20) env.push({ t, rms: (Math.floor(t / 120) % 2) === 0 ? 0.95 : 0.05 });
  const cues = compileFromEnvelope(env, { durationMs: 8000 });
  assert.ok(maxFlashesPerWindow(cues) <= 3, 'fixture cue series must already be governed <=3/s');

  // Drive the EXACT phone render pipeline: clampColor + makeBackstop(150), level = governed b(t).
  // round-8A: sweep includes the STRONGEST reactivity (max gain, min floor, min gamma) — the
  // conditioned drive must never let a beat-heavy track strobe >3/s through the on-device backstop.
  const audioConfigs = [
    { audioDepth: 0.3, audioGamma: 1 },
    { audioDepth: 0.6, audioGamma: 1 },
    { audioDepth: 1, audioGamma: 1 },
    { audioDepth: 1, audioGain: 6, audioFloor: 0, audioGamma: 0.4 },     // max strength / steepest
    { audioDepth: 1, audioGain: 6, audioFloor: 0.5, audioGamma: 1.6 },   // max gain, high floor/gamma
    { audioDepth: 0.7, audioGain: 4, audioFloor: 0.1, audioGamma: 0.8 }, // strong near-defaults
  ];
  for (const type of PRESET_TYPES) {
    for (const ac of audioConfigs) {
      const v = validatePreset(type, { ...ac, bpm: 180, depth: 0.8, speed: 0.5 });
      assert.ok(v.ok, `${type} ${JSON.stringify(ac)} rejected`);
      for (const N of [12]) for (const idx of [0, 6, 11]) {
        const backstop = CLS.makeBackstop(150);
        const cross = []; let armed = true;
        for (let ms = 0; ms <= 8000; ms += 16) {
          const level = sampleB(cues, ms);
          let rgb = clampColor(PRESETS[type](ms, v.params, idx, N, level));
          rgb = backstop(rgb, 16);                       // the on-device slew the phone applies
          const L = relLum(rgb);
          if (L < LOW) armed = true; else if (L >= HIGH && armed) { cross.push(ms); armed = false; }
        }
        let j = 0, w = 0; for (let i = 0; i < cross.length; i++) { while (cross[i] - cross[j] >= 1000) j++; w = Math.max(w, i - j + 1); }
        assert.ok(w <= 3, `${type} ${JSON.stringify(ac)} N=${N} idx=${idx}: ${w} flashes/s on beat-heavy track`);
      }
    }
  }
});

test('validatePreset gate is safe with audio params (dual-pass level 0/1)', () => {
  const v = validatePreset('pulse', { audioDepth: 1, audioGamma: 1, depth: 0.8, bpm: 180 });
  assert.ok(v.ok && v.sim.maxFlashesPerWindow <= 3, 'reactive pulse must pass gate <=3/s');
  // audio params are clamped to schema bounds by validateParam (live morph path)
  assert.equal(validateParam('pulse', 'audioDepth', 5).value, 1);
  assert.equal(validateParam('pulse', 'audioDepth', -1).value, 0);
  assert.equal(validateParam('ocean', 'audioGamma', 99).value, 1.6);   // round-8A max
  assert.equal(validateParam('pulse', 'audioGain', 99).value, 6);      // round-8A strength cap
  assert.equal(validateParam('pulse', 'audioGain', 0).value, 1);
  assert.equal(validateParam('pulse', 'audioFloor', 9).value, 0.5);
});

test('validatePreset rejects unknown; off is allowed; validateParam clamps', () => {
  assert.equal(validatePreset('definitely_not_a_preset', {}).ok, false);
  assert.equal(validatePreset('off', {}).ok, true);
  assert.equal(validateParam('pulse', 'bpm', 9999).value, 180); // clamped to max
  assert.equal(validateParam('pulse', 'bpm', -50).value, 30);   // clamped to min
  assert.equal(validateParam('pulse', 'nope', 1).ok, false);
  assert.equal(validateParam('color_waves', 'dir', -3).value, -1);
});
