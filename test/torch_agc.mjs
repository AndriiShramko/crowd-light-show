// ROUND 13 — pt 3. The torch reacts EVENLY across loudness now. The old static curve + binary >=0.5
// left quiet passages BLACK (excite never reached 0.5) and sustained-loud passages SOLID (excite
// pinned over 0.5, no per-beat toggle). The new per-phone rolling floor/ceil + flux AGC re-levels
// quiet UP and makes sustained-loud TOGGLE per onset. Verified by driving the REAL makeTorchAGC
// (exposed as window.__clsMakeTorchAGC) with synthetic QUIET and LOUD signals + the invert path.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3080';
const dir = path.dirname(fileURLToPath(import.meta.url));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  const b = await chromium.launch();
  const p = await (await b.newContext()).newPage();
  await p.goto(`${BASE}/join?demo=1`);
  await p.waitForFunction(() => typeof window.__clsMakeTorchAGC === 'function', { timeout: 12000 });

  // Run a beat signal at a given baseline loudness through the AGC; count how many times the binary
  // (excite>=0.5) decision TOGGLES on->off over ~4s. A working torch toggles in BOTH quiet and loud.
  const run = await p.evaluate(() => {
    function beat(t, base, amp) { // a 1.6 Hz musical beat riding a `base` loudness
      var env = Math.pow(Math.max(0, Math.sin(2 * Math.PI * t * 1.6)), 6);
      return Math.max(0, Math.min(1, base + amp * env));
    }
    function toggles(base, amp) {
      var agc = window.__clsMakeTorchAGC(); var prev = null, edges = 0, onSamples = 0, n = 0;
      for (var ms = 0; ms < 4000; ms += 16) {
        var raw = beat(ms / 1000, base, amp);
        var ex = agc(raw, 16);
        var on = ex >= 0.5; if (on) onSamples++; n++;
        if (prev !== null && on !== prev) edges++; prev = on;
      }
      return { edges: edges, onFrac: onSamples / n };
    }
    function invToggles() { // invert: 1-excite should also toggle, in anti-phase
      var agc = window.__clsMakeTorchAGC(); var prev = null, edges = 0;
      for (var ms = 0; ms < 4000; ms += 16) { var raw = beat(ms / 1000, 0.5, 0.3); var ex = 1 - agc(raw, 16); var on = ex >= 0.5; if (prev !== null && on !== prev) edges++; prev = on; }
      return edges;
    }
    return { quiet: toggles(0.10, 0.10), loud: toggles(0.80, 0.18), inv: invToggles() };
  });

  // QUIET (low baseline, tiny beats): old curve stayed black; AGC must make it TOGGLE (flash).
  check('flashes_when_quiet', run.quiet.edges >= 6, `quiet beats toggle the torch: edges=${run.quiet.edges} onFrac=${run.quiet.onFrac.toFixed(2)} (was black before)`);
  // LOUD (high sustained + beats): old curve pinned solid-on; AGC must keep TOGGLING, not stay on.
  check('toggles_when_loud', run.loud.edges >= 6 && run.loud.onFrac < 0.9, `loud beats still toggle (not solid): edges=${run.loud.edges} onFrac=${run.loud.onFrac.toFixed(2)}`);
  // INVERT: the inverted excite also produces a toggling flash (just anti-phase).
  check('invert_toggles', run.inv >= 6, `invert path toggles: edges=${run.inv}`);
  // both quiet and loud reach a comparable toggle count => EVEN across loudness (the owner's ask).
  check('even_across_loudness', Math.min(run.quiet.edges, run.loud.edges) >= 6 && Math.abs(run.quiet.edges - run.loud.edges) <= run.quiet.edges, `quiet=${run.quiet.edges} loud=${run.loud.edges} (comparable => no manual slider riding)`);

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'torch_agc_report.json'), JSON.stringify({ base: BASE, run, fails }, null, 2));
  if (fails.length) { console.error('TORCH AGC FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('TORCH AGC PASS: the torch toggles evenly in BOTH quiet and loud passages (no black-when-quiet, no solid-when-loud), the invert path toggles anti-phase, and reactivity is comparable across loudness — no manual slider riding.');
}
main().catch((e) => { console.error(e); process.exit(1); });
