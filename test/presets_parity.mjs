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
import { PRESETS as S, clampColor as clampS, PARAM_SCHEMA } from '../src/presets.js';

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

test('audio-reactive PRESETS identical (server vs browser) across level + audioDepth + audioGamma', () => {
  let checked = 0;
  for (const type of Object.keys(PARAM_SCHEMA)) {
    for (const audioDepth of [0, 0.5, 1]) {
      for (const audioGamma of [1, 1.6]) {
        const p = Object.assign(defs(type), { audioDepth, audioGamma });
        for (const N of [1, 12, 37]) {
          for (const index of [0, Math.floor(N / 2), N - 1]) {
            for (const level of [undefined, 0, 0.27, 0.5, 0.81, 1]) {
              for (let pos = 0; pos <= 4000; pos += 311) {
                const a = norm(clampS(S[type](pos, p, index, N, level)));
                const b = norm(B.clampColor(B.PRESETS[type](pos, p, index, N, level)));
                assert.deepEqual(b, a, `${type} depth=${audioDepth} gamma=${audioGamma} N=${N} idx=${index} level=${level} pos=${pos}: ${b} != ${a}`);
                checked++;
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 5000, 'checked ' + checked);
});

test('audioDepth=0 (or no level) reproduces the autonomous output exactly', () => {
  for (const type of Object.keys(PARAM_SCHEMA)) {
    const p0 = Object.assign(defs(type), { audioDepth: 0 });
    for (const N of [12]) for (const index of [0, 5, 11]) for (let pos = 0; pos <= 4000; pos += 173) {
      const auto = norm(clampS(S[type](pos, defs(type), index, N)));        // 4-arg, today's behaviour
      for (const level of [0, 0.5, 1]) {
        const withDepth0 = norm(clampS(S[type](pos, p0, index, N, level))); // depth 0 => music has no effect
        assert.deepEqual(withDepth0, auto, `${type} depth0 level=${level} pos=${pos} drifted from autonomous`);
      }
    }
  }
});

test('clampColor identical on tricky colours', () => {
  const samples = [[255, 0, 0], [255, 12, 12], [200, 50, 50], [0, 0, 0], [120, 255, 160], [255, 255, 255], [300, -5, 9]];
  for (const s of samples) assert.deepEqual(norm(B.clampColor(s.slice())), norm(clampS(s.slice())), 'clampColor ' + s);
});
