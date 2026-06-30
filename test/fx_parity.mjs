// ROUND 13 — pt 5. src/fx.js (server) and public/fx.js (browser) MUST stay byte-identical in behavior,
// like the presets. This loads the browser file in a vm sandbox and cross-checks every FX(ms, i, N)
// against the server module across a grid. If they ever drift, the firework would look different on a
// phone than the safety check proved — fail the build.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { FX as SRV_FX, FX_NAMES, FX_DURATIONS } from '../src/fx.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(dir, '..', 'public', 'fx.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const BR = sandbox.window.CLS_PRESETS;
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

check('browser_exports', !!(BR && BR.FX && BR.FX_NAMES && BR.FX_DURATIONS), 'public/fx.js augments window.CLS_PRESETS');
check('names_match', JSON.stringify(BR.FX_NAMES) === JSON.stringify(FX_NAMES), 'src=' + JSON.stringify(FX_NAMES) + ' browser=' + JSON.stringify(BR.FX_NAMES));
check('durations_match', JSON.stringify(BR.FX_DURATIONS) === JSON.stringify(FX_DURATIONS), JSON.stringify(BR.FX_DURATIONS));

let mismatches = 0, samples = 0;
for (const name of FX_NAMES) {
  for (const N of [1, 7, 64, 500]) {
    for (const i of [0, 1, 3, Math.floor(N / 2), N - 1]) {
      for (let ms = 0; ms < FX_DURATIONS[name]; ms += 53) {
        const a = SRV_FX[name](ms, i, N), b = BR.FX[name](ms, i, N);
        samples++;
        if (JSON.stringify(a.screenRgb) !== JSON.stringify(b.screenRgb) || !!a.torchOn !== !!b.torchOn) { mismatches++; if (mismatches <= 3) console.log('  drift', name, { N, i, ms, a, b }); }
      }
    }
  }
}
check('fx_byte_identical', mismatches === 0, `${mismatches} mismatches across ${samples} (name×N×index×ms) samples`);

if (fails.length) { console.error('FX PARITY FAIL: ' + fails.join('; ')); process.exit(1); }
console.log(`FX PARITY PASS: src/fx.js == public/fx.js across ${samples} samples (5 fireworks × crowd sizes × indices × time).`);
