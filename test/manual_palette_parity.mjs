// ROUND 14 — the new VJ manual-layer math (rgb2hsl, applyManualScreen, paletteSnap) MUST stay
// byte-identical between the server engine (src/presets.js) and the browser mirror (public/presets.js),
// exactly like the presets and FX. The phone applies these BEFORE its safety governor, so any drift
// would make a phone look different from what the safety test proved. Load the browser file in a vm
// sandbox and cross-check every function across a grid.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rgb2hsl as S_rgb2hsl, applyManualScreen as S_applyManual, paletteSnap as S_paletteSnap } from '../src/presets.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, '..', 'public', 'presets.js'), 'utf8'), sandbox);
const B = sandbox.window.CLS_PRESETS;
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

check('browser_exports', !!(B && B.rgb2hsl && B.applyManualScreen && B.paletteSnap), 'public/presets.js exposes the manual layer');

const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0], [255, 255, 255], [128, 128, 128], [206, 17, 38], [10, 200, 150], [240, 200, 30], [17, 17, 100]];
const eq3 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eqHsl = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;

let n = 0, bad = 0;
// rgb2hsl
for (const c of COLORS) { n++; if (!eqHsl(S_rgb2hsl(...c), B.rgb2hsl(...c))) { bad++; if (bad <= 3) console.log('  rgb2hsl drift', c); } }
// applyManualScreen across modes
for (const c of COLORS) for (const hue of [0, 37, 120, 359]) for (const sat of [0, 0.5, 1]) for (const bri of [0, 0.5, 1]) {
  n++; const mn = { hue, sat, bri };
  if (!eq3(S_applyManual(c, mn), B.applyManualScreen(c, mn))) { bad++; if (bad <= 3) console.log('  applyManual drift', c, mn); }
}
// paletteSnap across palettes
const PALS = [{ on: false, colors: [] }, { on: true, colors: [[230, 0, 0], [255, 255, 255]] }, { on: true, colors: [[0, 0, 255], [0, 255, 0], [255, 200, 0]] }];
for (const c of COLORS) for (const pal of PALS) { n++; if (!eq3(S_paletteSnap(c, pal), B.paletteSnap(c, pal))) { bad++; if (bad <= 3) console.log('  paletteSnap drift', c, pal); } }
check('manual_layer_byte_identical', bad === 0, `${bad} mismatches across ${n} samples`);

if (fails.length) { console.error('MANUAL PARITY FAIL: ' + fails.join('; ')); process.exit(1); }
console.log(`MANUAL PARITY PASS: rgb2hsl + applyManualScreen + paletteSnap identical across ${n} samples.`);
