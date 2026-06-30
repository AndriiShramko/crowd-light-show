// ROUND 13 — pt 5. Every firework MUST stay <=3 flashes/s (screen + torch) with no red strobe, for any
// phone in the crowd — the SAME epilepsy governor as every other channel. This runs each FX through the
// EXACT client pipeline (clampColor + makeBackstop for the screen, makeTorchGate for the torch — all from
// the browser presets module) at 60 fps over its full duration and asserts no 1000 ms window exceeds 3.
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
vm.runInContext(fs.readFileSync(path.join(dir, '..', 'public', 'fx.js'), 'utf8'), sandbox);
const P = sandbox.window.CLS_PRESETS;
const DT = 1000 / 60;

function maxFlashesPerSec(name, i, N) {
  const backstop = P.makeBackstop(150), torchGate = P.makeTorchGate();
  const onEdges = [], torchEdges = []; let prevHi = false, prevTorch = false;
  for (let ms = 0; ms < P.FX_DURATIONS[name] + 200; ms += DT) {
    const out = P.FX[name](ms, i, N);
    let rgb = P.clampColor(out.screenRgb); rgb = backstop(rgb, DT);
    // red-strobe guard: no large saturated-red frame (clampColor enforces it; assert the ratio holds)
    const r = rgb[0], g = rgb[1], b = rgb[2];
    if (r > 120 && r > 2 * (g + b)) return { red: true, screen: 99, torch: 99 };
    const lum = P.relLum(rgb), hi = lum >= 0.6;
    if (hi && !prevHi) onEdges.push(ms); prevHi = hi;
    const ton = !!torchGate(!!out.torchOn, DT);
    if (ton && !prevTorch) torchEdges.push(ms); prevTorch = ton;
  }
  const win = (edges) => { let m = 0; for (const e of edges) { const c = edges.filter((x) => x >= e && x < e + 1000).length; if (c > m) m = c; } return m; };
  return { red: false, screen: win(onEdges), torch: win(torchEdges) };
}

test('every firework stays <=3 flashes/s (screen + torch), no red strobe, for any phone', () => {
  for (const name of P.FX_NAMES) {
    for (const N of [1, 8, 200]) {
      for (const i of [0, 1, Math.floor(N / 2), N - 1]) {
        const r = maxFlashesPerSec(name, i, N);
        assert.equal(r.red, false, `${name} i${i}/N${N}: produced a large saturated-red frame`);
        assert.ok(r.screen <= 3, `${name} i${i}/N${N}: screen ${r.screen} flashes/s > 3`);
        assert.ok(r.torch <= 3, `${name} i${i}/N${N}: torch ${r.torch} flashes/s > 3`);
      }
    }
  }
});
