// ROUND 14 — the VJ manual override + palette restriction sit on TOP of the show, but the on-device
// safety governors (clampColor + makeBackstop for the screen, makeTorchGate for the LED) stay the
// unchanged LAST stage. This drives the EXACT phone pipeline at 60 fps under the most HOSTILE operator
// input (full saturation, a fast hue sweep, brightness oscillated at 8 Hz, the flash slammed/oscillated)
// over a strobe-prone source and asserts no 1000 ms window ever exceeds 3 flashes — screen OR torch —
// and that a red-flag palette is still red-ratio safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, '..', 'public', 'presets.js'), 'utf8'), sandbox);
const P = sandbox.window.CLS_PRESETS;       // the engine the phone actually runs
const DT = 1000 / 60;
const LOW = 0.25, HIGH = 0.6;

// The EXACT screen pipeline a phone applies, per frame: source -> (intervene modify) -> (palette snap)
// -> clampColor -> backstop. In full mode the source is the operator's HSV directly.
function frameAt(ms, srcAt, manualAt, palette, backstop) {
  const manual = manualAt(ms);
  let raw;
  if (manual.on && manual.mode === 'full') {
    raw = P.hsl2rgb(manual.hue, manual.sat, manual.bri * 0.85 + 0.04);
  } else {
    raw = srcAt(ms);
    if (manual.on) raw = P.applyManualScreen(raw, manual);
  }
  if (palette && palette.on) raw = P.paletteSnap(raw, palette);
  let rgb = P.clampColor(raw);
  rgb = backstop(rgb, DT);
  return rgb;
}
function runScreen(srcAt, manualAt, palette) {
  const backstop = P.makeBackstop(150);
  const edges = []; let armed = true, maxRed = 0;
  for (let ms = 0; ms < 4000; ms += DT) {
    const rgb = frameAt(ms, srcAt, manualAt, palette, backstop);
    const sum = rgb[0] + rgb[1] + rgb[2];
    if (sum > 0 && P.relLum(rgb) > 0.4) maxRed = Math.max(maxRed, rgb[0] / sum);
    const L = P.relLum(rgb);
    if (L < LOW) armed = true; else if (L >= HIGH && armed) { edges.push(ms); armed = false; }
  }
  let j = 0, w = 0; for (let i = 0; i < edges.length; i++) { while (edges[i] - edges[j] >= 1000) j++; w = Math.max(w, i - j + 1); }
  return { flashes: w, maxRed };
}

// a deliberately strobe-prone source: ~6 Hz square pulse (>3/s without the governor)
const squarePulse = (ms) => (Math.floor(ms / 80) % 2) ? [255, 255, 255] : [0, 0, 0];
const steadyMid = () => [120, 120, 120];
// hostile manual: full sat, hue sweeping a full turn/sec, brightness square-waved at ~8 Hz
const hostileIntervene = (ms) => ({ on: true, mode: 'intervene', sat: 1, hue: (ms / 1000 * 360) % 360, bri: (Math.floor(ms / 62) % 2) ? 1 : 0, flash: 0 });
const hostileFull = (ms) => ({ on: true, mode: 'full', sat: 1, hue: (ms / 1000 * 360) % 360, bri: (Math.floor(ms / 62) % 2) ? 1 : 0, flash: 0 });
const steadyIntervene = () => ({ on: true, mode: 'intervene', sat: 1, hue: 200, bri: 1, flash: 0 });

const FLAG_RED = { on: true, colors: [[230, 0, 0], [255, 255, 255]] };   // Poland-style red+white
const BRAND = { on: true, colors: [[0, 90, 200], [255, 200, 0]] };       // a 2-colour brand
const OFF = { on: false, colors: [] };

test('intervene manual over a strobe-prone preset stays <=3 flashes/s for any palette', () => {
  for (const pal of [OFF, FLAG_RED, BRAND]) {
    const r = runScreen(squarePulse, steadyIntervene, pal);
    assert.ok(r.flashes <= 3, `intervene+palette flashes ${r.flashes} > 3`);
    assert.ok(r.maxRed < 0.8, `intervene red ratio ${r.maxRed.toFixed(2)} >= 0.8`);
  }
});

test('hostile manual (8 Hz bri + hue sweep) stays <=3 flashes/s — intervene and full, any palette', () => {
  for (const pal of [OFF, FLAG_RED, BRAND]) {
    const a = runScreen(steadyMid, hostileIntervene, pal);
    assert.ok(a.flashes <= 3, `hostile intervene flashes ${a.flashes} > 3 (pal ${JSON.stringify(pal.colors)})`);
    assert.ok(a.maxRed < 0.8, `hostile intervene red ${a.maxRed.toFixed(2)}`);
    const b = runScreen(squarePulse, hostileFull, pal);
    assert.ok(b.flashes <= 3, `hostile full flashes ${b.flashes} > 3 (pal ${JSON.stringify(pal.colors)})`);
    assert.ok(b.maxRed < 0.8, `hostile full red ${b.maxRed.toFixed(2)}`);
  }
});

test('a red-flag palette is red-ratio safe and a sub-threshold flag red passes clampColor unchanged', () => {
  for (let h = 0; h < 360; h += 7) {
    const src = P.hsl2rgb(h, 1, 0.5);
    const snapped = P.clampColor(P.paletteSnap(src, FLAG_RED));
    const sum = snapped[0] + snapped[1] + snapped[2];
    if (sum > 0 && P.relLum(snapped) > 0.4) assert.ok(snapped[0] / sum < 0.8, `snapped red ratio ${(snapped[0] / sum).toFixed(2)}`);
  }
  const usRed = [206, 17, 38];                                  // r/sum = 0.79 < 0.8 -> unchanged
  const cl = P.clampColor(usRed);                               // value-compare (clampColor returns a vm-realm array)
  assert.ok(cl[0] === 206 && cl[1] === 17 && cl[2] === 38, `sub-threshold red changed: ${cl}`);
  const pure = P.clampColor([255, 0, 0]); const s = pure[0] + pure[1] + pure[2];
  assert.ok(pure[0] / s < 0.81, `pure red lifted to ${(pure[0] / s).toFixed(2)}`);
});

test('manual FLASH slammed/oscillated stays <=3 torch ON-edges/s through makeTorchGate', () => {
  for (const pattern of ['slam', 'fast', 'beat']) {
    const gate = P.makeTorchGate();
    const edges = []; let prev = false;
    for (let ms = 0; ms < 4000; ms += DT) {
      let wantOn;
      if (pattern === 'slam') wantOn = true;                                // held on
      else if (pattern === 'fast') wantOn = (Math.floor(ms / 50) % 2) === 0; // 10 Hz manual flash
      else wantOn = (ms % 1000) < 30;                                       // a sharp 1 Hz punch
      const on = !!gate(wantOn, DT);
      if (on && !prev) edges.push(ms); prev = on;
    }
    let j = 0, w = 0; for (let i = 0; i < edges.length; i++) { while (edges[i] - edges[j] >= 1000) j++; w = Math.max(w, i - j + 1); }
    assert.ok(w <= 3, `torch pattern ${pattern}: ${w} ON-edges/s > 3`);
  }
});
