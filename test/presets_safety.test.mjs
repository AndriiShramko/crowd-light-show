// Server-authoritative preset safety. validatePreset() is the only gate from an
// operator/guest request to a broadcast preset; this proves an out-of-envelope
// preset is structurally unrepresentable (clamped or rejected), at any params.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePreset, validateParam, simulate, PRESETS, clampColor, relLum, PARAM_SCHEMA, PRESET_TYPES } from '../src/presets.js';

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

test('validatePreset rejects unknown; off is allowed; validateParam clamps', () => {
  assert.equal(validatePreset('definitely_not_a_preset', {}).ok, false);
  assert.equal(validatePreset('off', {}).ok, true);
  assert.equal(validateParam('pulse', 'bpm', 9999).value, 180); // clamped to max
  assert.equal(validateParam('pulse', 'bpm', -50).value, 30);   // clamped to min
  assert.equal(validateParam('pulse', 'nope', 1).ok, false);
  assert.equal(validateParam('color_waves', 'dir', -3).value, -1);
});
