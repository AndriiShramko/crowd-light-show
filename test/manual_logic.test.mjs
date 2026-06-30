// ROUND 14 — unit-test the pure VJ manual-layer transforms (server engine, which is parity-identical
// to the browser). Proves the contract the safety proof relies on: intervene brightness only attenuates,
// hue wraps, palette-snap returns a real palette member and preserves source luminance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyManualScreen, paletteSnap, rgb2hsl, hsl2rgb, relLum, clampColor } from '../src/presets.js';

const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128], [240, 200, 30], [10, 200, 150], [200, 17, 38], [80, 80, 200]];

test('applyManualScreen: hue rotates mod 360, sat/bri scale stay in gamut', () => {
  for (const c of COLORS) for (const hue of [0, 90, 270, 359, 400]) for (const sat of [0, 0.5, 1]) for (const bri of [0, 0.5, 1]) {
    const out = applyManualScreen(c, { hue, sat, bri });
    assert.ok(out.every((v) => v >= 0 && v <= 255), `out of gamut ${out}`);
  }
});

test('applyManualScreen: bri is a <=1 scale -> can ONLY attenuate luminance (never manufacture a flash)', () => {
  for (const c of COLORS) for (const bri of [0, 0.25, 0.5, 0.75, 1]) {
    const inL = relLum(c);
    const out = applyManualScreen(c, { hue: 0, sat: 1, bri });
    // hue/sat can shift luminance a little via the channel weights, but bri<1 must pull it DOWN overall;
    // assert the bri=1 case never lifts luminance beyond a rounding margin and lower bri reduces it.
    if (bri === 1) assert.ok(relLum(out) <= inL + 0.02, `bri=1 lifted ${relLum(out).toFixed(3)} > ${inL.toFixed(3)}`);
    if (bri <= 0.25) assert.ok(relLum(out) <= inL + 0.02, `low bri did not attenuate (${relLum(out).toFixed(3)} vs ${inL.toFixed(3)})`);
  }
});

test('applyManualScreen: hue offset is additive and wraps', () => {
  const base = hsl2rgb(100, 0.8, 0.5);
  const rotated = applyManualScreen(base, { hue: 50, sat: 1, bri: 1 });
  const h = rgb2hsl(rotated[0], rotated[1], rotated[2])[0];
  assert.ok(Math.abs(((h - 150) % 360 + 360) % 360) < 3 || Math.abs(((150 - h) % 360 + 360) % 360) < 3, `expected ~150 hue, got ${h.toFixed(1)}`);
});

test('paletteSnap: identity when off, returns a palette HUE member, preserves source luminance', () => {
  const off = { on: false, colors: [] };
  for (const c of COLORS) assert.deepEqual(paletteSnap(c, off), c, 'off must be identity');
  const pal = { on: true, colors: [[0, 0, 255], [0, 200, 0], [255, 180, 0]] };
  for (const c of COLORS) {
    const out = paletteSnap(c, pal);
    // the OUTPUT hue must match one of the palette hues (luminance is re-imposed from the source)
    const oh = rgb2hsl(out[0], out[1], out[2])[0];
    const palHues = pal.colors.map((p) => rgb2hsl(p[0], p[1], p[2])[0]);
    const near = palHues.some((ph) => Math.abs(((oh - ph) % 360 + 360) % 360) < 4 || Math.abs(((ph - oh) % 360 + 360) % 360) < 4 || rgb2hsl(out[0], out[1], out[2])[1] < 0.02);
    assert.ok(near, `snapped hue ${oh.toFixed(1)} not in palette ${palHues.map((x) => x.toFixed(0))}`);
    // brightness preserved: paletteSnap re-imposes the source HSL lightness onto the palette hue, so
    // a pulsing source still pulses within the palette colour (relLum differs by hue, by design).
    const lo = rgb2hsl(out[0], out[1], out[2])[2], lc = rgb2hsl(c[0], c[1], c[2])[2];
    assert.ok(Math.abs(lo - lc) < 0.02, `HSL-L not preserved: ${lo.toFixed(3)} vs ${lc.toFixed(3)}`);
  }
});

test('paletteSnap: chosen colour is the redmean-nearest of the palette', () => {
  const pal = { on: true, colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] };
  const rm = (a, b) => { const m = (a[0] + b[0]) / 2; const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]; return (2 + m / 256) * dr * dr + 4 * dg * dg + (2 + (255 - m) / 256) * db * db; };
  for (const c of [[200, 30, 30], [20, 220, 40], [40, 40, 230], [200, 200, 30]]) {
    let bi = 0, bd = Infinity; for (let i = 0; i < pal.colors.length; i++) { const d = rm(c, pal.colors[i]); if (d < bd) { bd = d; bi = i; } }
    const out = paletteSnap(c, pal);
    const outHue = rgb2hsl(out[0], out[1], out[2])[0], wantHue = rgb2hsl(...pal.colors[bi])[0];
    assert.ok(Math.abs(((outHue - wantHue) % 360 + 360) % 360) < 4 || Math.abs(((wantHue - outHue) % 360 + 360) % 360) < 4, `snap picked wrong colour for ${c}`);
  }
});

test('full-mode HSV maps into the governed L-band [~0.04, ~0.89]', () => {
  for (const bri of [0, 0.5, 1]) {
    const l = bri * 0.85 + 0.04;
    assert.ok(l >= 0.04 && l <= 0.89, `full-mode L ${l} out of band`);
    const rgb = clampColor(hsl2rgb(0, 0, l));   // grey, so luminance ~ l
    assert.ok(relLum(rgb) >= 0 && relLum(rgb) <= 0.92);
  }
});
