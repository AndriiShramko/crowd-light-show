// Cue compiler = SAFETY GOVERNOR. Every timeline that reaches a device passes
// through clampSafety(). It is structurally impossible to emit a cue stream that
// exceeds the photosensitive-epilepsy limits (WCAG 2.3.1/2.3.2):
//   - <= 3 luminance flashes in any 1000 ms window
//   - large luminance changes ramped over >= 150 ms (no instant full strobe)
//   - no large-area saturated red (R/(R+G+B) >= 0.8)
import { config } from './config.js';

const LOW = 0.25;   // "off-ish" luminance threshold
const HIGH = 0.6;   // "on" luminance threshold (a low->high cross = one flash)
const MAX_RED_RATIO = 0.8;

export function clampColor(rgb) {
  let [r, g, b] = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  const sum = r + g + b;
  if (sum > 0 && r / sum >= MAX_RED_RATIO) {
    // Desaturate the red toward white/amber until the ratio is safe.
    const need = r / MAX_RED_RATIO - r; // total g+b required so r/(r+g+b) < 0.8
    const add = Math.ceil((need - (g + b)) / 2) + 1;
    g = Math.min(255, g + add);
    b = Math.min(255, b + add);
  }
  return [r, g, b];
}

// Resample an arbitrary cue list to a fixed-fps luminance+color series.
function resample(cues, fps, durationMs) {
  const frameMs = 1000 / fps;
  const n = Math.max(1, Math.ceil(durationMs / frameMs) + 1);
  const lum = new Array(n);
  const col = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i * frameMs;
    while (j < cues.length - 1 && cues[j + 1].t <= t) j++;
    const a = cues[j];
    const bcue = cues[Math.min(j + 1, cues.length - 1)];
    const span = Math.max(1, bcue.t - a.t);
    const f = Math.max(0, Math.min(1, (t - a.t) / span));
    const la = a.b ?? 0, lb = bcue.b ?? 0;
    lum[i] = la + (lb - la) * f;
    const ca = a.rgb || [255, 255, 255];
    const cb = bcue.rgb || ca;
    col[i] = [
      ca[0] + (cb[0] - ca[0]) * f,
      ca[1] + (cb[1] - ca[1]) * f,
      ca[2] + (cb[2] - ca[2]) * f,
    ];
  }
  return { lum, col, frameMs };
}

// The governor. Input: any cue list. Output: a safe cue list at config.cueFps.
export function clampSafety(cues, opts = {}) {
  const fps = opts.fps || config.cueFps;
  const frameMs = 1000 / fps;
  let durationMs = opts.durationMs;
  if (!durationMs) durationMs = cues.length ? cues[cues.length - 1].t : 0;
  if (!cues.length) return [{ t: 0, b: 0, rgb: [0, 0, 0] }];

  const sorted = [...cues].sort((a, b) => a.t - b.t);
  const { lum, col } = resample(sorted, fps, durationMs);

  // 1) Flash-gate: a low->high luminance crossing is a "flash"; allow at most one
  //    per minFlashGap (=> <= maxFlashesPerSec). Suppress (hold low) early rises.
  const minFlashGap = 1000 / config.maxFlashesPerSec; // 333ms for 3/s
  const gated = new Array(lum.length);
  let lastFlashT = -Infinity;
  let armed = true; // true when luminance has gone below LOW since last flash
  for (let i = 0; i < lum.length; i++) {
    const t = i * frameMs;
    let v = lum[i];
    if (v < LOW) armed = true;
    if (v >= HIGH && armed) {
      if (t - lastFlashT < minFlashGap) {
        v = Math.min(v, LOW * 0.9); // suppress this premature flash
      } else {
        lastFlashT = t;
        armed = false;
      }
    }
    gated[i] = v;
  }

  // 2) Ramp-limit (slew): cap |delta| so a full 0<->1 swing takes >= minRampMs.
  const maxDelta = frameMs / config.minRampMs;
  const ramped = new Array(gated.length);
  ramped[0] = gated[0];
  for (let i = 1; i < gated.length; i++) {
    const prev = ramped[i - 1];
    const want = gated[i];
    const d = want - prev;
    ramped[i] = Math.abs(d) <= maxDelta ? want : prev + Math.sign(d) * maxDelta;
  }

  // 3) Color safety + emit keyframes (drop runs of identical frames to shrink).
  const out = [];
  let prevB = null, prevRgb = null;
  for (let i = 0; i < ramped.length; i++) {
    const t = Math.round(i * frameMs);
    const b = Math.round(ramped[i] * 1000) / 1000;
    const rgb = clampColor(col[i]);
    const changed = prevB === null ||
      Math.abs(b - prevB) > 0.02 ||
      rgb[0] !== prevRgb[0] || rgb[1] !== prevRgb[1] || rgb[2] !== prevRgb[2];
    if (changed || i === ramped.length - 1) {
      out.push({ t, b, rgb });
      prevB = b; prevRgb = rgb;
    }
  }
  if (out[0].t !== 0) out.unshift({ t: 0, b: 0, rgb: [0, 0, 0] });
  return out;
}

// Count low->high luminance crossings ("flashes"). Used by tests/verification.
export function countFlashes(cues) {
  const times = [];
  let armed = true;
  for (const c of cues) {
    const v = c.b ?? 0;
    if (v < LOW) armed = true;
    else if (v >= HIGH && armed) { times.push(c.t); armed = false; }
  }
  return times;
}

// Max flashes found in any 1000ms sliding window.
export function maxFlashesPerWindow(cues, windowMs = 1000) {
  const t = countFlashes(cues);
  let max = 0, j = 0;
  for (let i = 0; i < t.length; i++) {
    while (t[i] - t[j] >= windowMs) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

// Build a safe timeline from an RMS envelope (+ optional beat times).
export function compileFromEnvelope(envelope, opts = {}) {
  const durationMs = opts.durationMs || (envelope.length ? envelope[envelope.length - 1].t : 0);
  const beats = opts.beats || [];
  const beatSet = beats.slice().sort((a, b) => a - b);
  // Safe, accessible-leaning palette (no pure saturated red).
  const palette = [
    [255, 255, 255], [80, 160, 255], [255, 180, 60],
    [120, 255, 160], [200, 120, 255], [60, 230, 230],
  ];
  let bi = 0, pi = 0;
  const raw = envelope.map((e) => {
    // luminance from rms with mild gamma so it "breathes"
    const b = Math.max(0, Math.min(1, Math.pow(e.rms, 0.8)));
    while (bi < beatSet.length && beatSet[bi] <= e.t) { bi++; pi = (pi + 1) % palette.length; }
    return { t: e.t, b, rgb: palette[pi] };
  });
  return clampSafety(raw, { fps: config.cueFps, durationMs });
}
