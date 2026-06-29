// Parity guard: the browser preset engine (public/presets.js) MUST compute the exact
// same colours as the server engine (src/presets.js). They are deliberately duplicated
// (one ESM for Node, one IIFE for the browser) so this test loads the browser file in a
// vm sandbox and cross-checks PRESETS + clampColor across a grid. If they ever drift,
// phones would render out of sync with the server's safety reasoning — so this fails loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS as S, clampColor as clampS, PARAM_SCHEMA, TORCH_PRESETS as TS, TORCH_SCHEMA as TSCHEMA } from '../src/presets.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(dir, '..', 'public', 'presets.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const B = sandbox.window.CLS_PRESETS;

function defs(type) { const o = {}; for (const [k, s] of Object.entries(PARAM_SCHEMA[type].params)) o[k] = s.def; return o; }
// vm-realm arrays have a different Array prototype, so normalise both sides to plain
// main-realm number arrays before comparing (we are testing VALUES, not realms).
const norm = (x) => Array.from(x, Number);

test('browser CLS_PRESETS exists with all 4 hero presets', () => {
  assert.ok(B && B.PRESETS, 'no CLS_PRESETS');
  for (const t of ['pulse', 'color_waves', 'rainbow_chase', 'ocean']) assert.ok(B.PRESETS[t], 'missing ' + t);
});

test('PRESETS outputs identical (server vs browser) across a grid', () => {
  let checked = 0;
  for (const type of Object.keys(PARAM_SCHEMA)) {
    const p = defs(type);
    for (const N of [1, 3, 12, 37]) {
      for (const index of [0, Math.floor(N / 2), N - 1]) {
        for (let pos = 0; pos <= 6000; pos += 137) {
          const a = norm(clampS(S[type](pos, p, index, N)));
          const b = norm(B.clampColor(B.PRESETS[type](pos, p, index, N)));
          assert.deepEqual(b, a, `${type} N=${N} idx=${index} pos=${pos}: ${b} != ${a}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1000, 'checked ' + checked);
});

test('audio-reactive PRESETS identical (server vs browser) across level + audioDepth/Gain/Floor/Gamma', () => {
  let checked = 0;
  for (const type of Object.keys(PARAM_SCHEMA)) {
    for (const audioDepth of [0, 0.5, 1]) {
      for (const audioGain of [1, 6]) {                  // round-8A strength knob
        for (const audioFloor of [0, 0.4]) {             // round-8A floor-gate
          for (const audioGamma of [0.6, 1.2]) {
            const p = Object.assign(defs(type), { audioDepth, audioGain, audioFloor, audioGamma });
            for (const N of [1, 12, 37]) {
              for (const index of [0, Math.floor(N / 2), N - 1]) {
                for (const level of [undefined, 0, 0.5, 1]) {
                  for (let pos = 0; pos <= 4000; pos += 411) {
                    const a = norm(clampS(S[type](pos, p, index, N, level)));
                    const b = norm(B.clampColor(B.PRESETS[type](pos, p, index, N, level)));
                    assert.deepEqual(b, a, `${type} depth=${audioDepth} gain=${audioGain} floor=${audioFloor} gamma=${audioGamma} N=${N} idx=${index} level=${level} pos=${pos}: ${b} != ${a}`);
                    checked++;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 5000, 'checked ' + checked);
});

test('audioDepth=0 reproduces the autonomous output exactly (any gain/floor/gamma)', () => {
  for (const type of Object.keys(PARAM_SCHEMA)) {
    for (const audioGain of [1, 2.5, 6]) for (const audioFloor of [0, 0.12, 0.5]) {
      const p0 = Object.assign(defs(type), { audioDepth: 0, audioGain, audioFloor });
      // autonomous baseline = the preset with reactivity OFF (audioDepth 0). Round 10 changed the
      // SCHEMA default to 0.6 (reactive out of the box), so the baseline must force depth 0 here
      // rather than rely on defs() — the depth=0==autonomous invariant itself is unchanged.
      const autoP = Object.assign(defs(type), { audioDepth: 0 });
      for (const N of [12]) for (const index of [0, 5, 11]) for (let pos = 0; pos <= 4000; pos += 173) {
        const auto = norm(clampS(S[type](pos, autoP, index, N)));             // 4-arg, depth 0 (autonomous)
        for (const level of [0, 0.5, 1]) {
          const withDepth0 = norm(clampS(S[type](pos, p0, index, N, level))); // depth 0 => music has no effect, any gain
          assert.deepEqual(withDepth0, auto, `${type} depth0 gain=${audioGain} floor=${audioFloor} level=${level} pos=${pos} drifted from autonomous`);
        }
      }
    }
  }
});

test('TORCH_PRESETS identical (server vs browser) across params + level + index (round 8B)', () => {
  const tdefs = (type) => { const o = {}; for (const [k, s] of Object.entries(TSCHEMA[type].params)) o[k] = s.def; return o; };
  assert.ok(B.TORCH_PRESETS, 'no browser TORCH_PRESETS');
  let checked = 0;
  for (const type of Object.keys(TSCHEMA)) {
    assert.ok(B.TORCH_PRESETS[type], 'missing browser torch ' + type);
    const variants = [tdefs(type)];
    if (type === 'strobe' || type === 'sparkle') { variants.push({ ...tdefs(type), rate: 2.8, duty: 0.6 }, { ...tdefs(type), rate: 0.5, duty: 0.1 }); }
    if (type === 'beat') { variants.push({ torchDepth: 1, torchGain: 6, torchFloor: 0, torchGamma: 0.4 }, { torchDepth: 0.5, torchGain: 1, torchFloor: 0.4, torchGamma: 1.6 }, { torchDepth: 0 }); }
    for (const p of variants) {
      for (const N of [1, 12, 37]) {
        for (const index of [0, Math.floor(N / 2), N - 1]) {
          for (const level of [undefined, 0, 0.5, 1]) {
            for (let pos = 0; pos <= 4000; pos += 211) {
              const a = Number(S && TS[type](pos, p, index, N, level));
              const b = Number(B.TORCH_PRESETS[type](pos, p, index, N, level));
              assert.equal(b, a, `torch ${type} N=${N} idx=${index} level=${level} pos=${pos}: ${b} != ${a}`);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 2000, 'checked ' + checked);
});

test('TORCH_SCHEMA identical (server vs browser)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(B.TORCH_SCHEMA)), JSON.parse(JSON.stringify(TSCHEMA)), 'torch schema drift');
});

test('clampColor identical on tricky colours', () => {
  const samples = [[255, 0, 0], [255, 12, 12], [200, 50, 50], [0, 0, 0], [120, 255, 160], [255, 255, 255], [300, -5, 9]];
  for (const s of samples) assert.deepEqual(norm(B.clampColor(s.slice())), norm(clampS(s.slice())), 'clampColor ' + s);
});
