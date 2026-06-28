import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clampSafety, clampColor, compileFromEnvelope, maxFlashesPerWindow } from '../src/compiler.js';
import { analyze } from '../src/audio.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// A) A 10 Hz on/off cue list must be clamped to <= 3 flashes / 1000ms window.
test('flash-rate cap: 10Hz strobe clamped to <=3/s', () => {
  const cues = [];
  for (let t = 0; t < 4000; t += 50) cues.push({ t, b: (t / 50) % 2 ? 1 : 0, rgb: [255, 255, 255] });
  const safe = clampSafety(cues, { durationMs: 4000 });
  assert.ok(maxFlashesPerWindow(safe) <= 3, 'max flashes/window = ' + maxFlashesPerWindow(safe));
});

// B) Large saturated-red full-screen strobe: no output cue may be saturated red.
test('no large saturated-red strobe survives the compiler', () => {
  const cues = [];
  for (let t = 0; t < 3000; t += 50) cues.push({ t, b: (t / 50) % 2 ? 1 : 0, rgb: [255, 0, 0] });
  const safe = clampSafety(cues, { durationMs: 3000 });
  for (const c of safe) {
    const sum = c.rgb[0] + c.rgb[1] + c.rgb[2];
    if (sum > 0 && c.b > 0.4) assert.ok(c.rgb[0] / sum < 0.8, 'red ratio ' + (c.rgb[0] / sum).toFixed(2));
  }
  assert.ok(maxFlashesPerWindow(safe) <= 3);
});

test('clampColor desaturates pure red', () => {
  const c = clampColor([255, 0, 0]); const sum = c[0] + c[1] + c[2];
  assert.ok(c[0] / sum < 0.8);
});

// C) An instant 0->1 step must be ramped over >= 150ms (no single-frame full swing).
test('ramp limit: large change spread over >=150ms', () => {
  const cues = [{ t: 0, b: 0, rgb: [255, 255, 255] }, { t: 40, b: 1, rgb: [255, 255, 255] }, { t: 2000, b: 1, rgb: [255, 255, 255] }];
  const safe = clampSafety(cues, { durationMs: 2000 });
  let maxDelta = 0;
  for (let i = 1; i < safe.length; i++) {
    const dt = safe[i].t - safe[i - 1].t; if (dt <= 0) continue;
    maxDelta = Math.max(maxDelta, Math.abs(safe[i].b - safe[i - 1].b) / dt * 40); // per 40ms frame
  }
  assert.ok(maxDelta <= 0.30, 'per-frame delta ' + maxDelta.toFixed(3) + ' (>=150ms ramp => <=0.267)');
});

// D) Real audio path: 10Hz strobe audio is clamped; beat-heavy clip yields more cues than steady tone.
test('audio analysis: strobe fixture clamped + beat-heavy > steady', async () => {
  const strobe = await analyze(path.join(fixtures, 'strobe_10hz.wav'));
  const safeStrobe = compileFromEnvelope(strobe.envelope, { durationMs: strobe.durationMs, beats: strobe.beats });
  assert.ok(maxFlashesPerWindow(safeStrobe) <= 3, 'strobe flashes/window=' + maxFlashesPerWindow(safeStrobe));

  const beaty = await analyze(path.join(fixtures, 'tone_2hz.wav'));
  const flat = await analyze(path.join(fixtures, 'tone_flat.wav'));
  const cuesBeaty = compileFromEnvelope(beaty.envelope, { durationMs: beaty.durationMs, beats: beaty.beats }).length;
  const cuesFlat = compileFromEnvelope(flat.envelope, { durationMs: flat.durationMs, beats: flat.beats }).length;
  assert.ok(cuesBeaty > cuesFlat, `beaty ${cuesBeaty} should exceed flat ${cuesFlat}`);
});
