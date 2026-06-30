// Round 13 (pt 5) — SPECIAL EFFECTS ("fireworks") channel. A one-shot, time-boxed overlay the operator
// fires from either console; every phone plays the SAME program deterministically off the synced clock
// (serverNow - startedAt), using its crowd index for spatial/random variety (hash01 — NOT Math.random).
// Each fx(ms, i, N) -> { screenRgb:[r,g,b], torchOn:bool }. The output is fed through the SAME governors
// as every other channel downstream (clampColor + backstop for the screen, torchGate for the torch), so
// even the "rapid" ones are physically clamped to <=3 flashes/s with no red strobe. After durationMs the
// phone reverts to whatever preset/timeline/torch was running — the FX overlays, it never clears them.
//
// This module is MIRRORED in public/fx.js (browser). test/fx_parity.mjs byte-checks the two are identical.
function frac(x) { return x - Math.floor(x); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function hash01(n) { var s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); }
function pop(t, center, width) { var x = (t - center) / width; return x * x > 1 ? 0 : (1 - x * x); } // soft attack/decay bump, 0..1
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp01(s); l = clamp01(l);
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// The 5 fireworks. Distinct shapes; each delivers its "flash" crests spaced so they sit at/under 3/s even
// BEFORE the downstream governor (which is the hard backstop). Colours are low-saturation amber/white (can't
// trip the red clamp) except color_burst, which sweeps hue slowly.
export const FX = {
  // simultaneous burst then crackle — the whole crowd blinks as ONE, 4 global crests 1s apart.
  salute: function (ms, i, N) {
    var L = Math.max(pop(ms, 150, 170), pop(ms, 1100, 150), pop(ms, 2100, 150), pop(ms, 3100, 150));
    return { screenRgb: hsl2rgb(45, 0.12, 0.04 + 0.92 * clamp01(L)), torchOn: L > 0.5 };
  },
  // random sparkle — each phone fires on its own hashed slots, so the crowd shimmers incoherently.
  twinkle: function (ms, i, N) {
    var rate = 2.4, slot = Math.floor(ms / 1000 * rate);
    var lit = (hash01(slot * 7.13 + (i % 997) * 1.7) < 0.5) && (frac(ms / 1000 * rate) < 0.35);
    var hue = 40 + 80 * hash01(i * 3.7 + 1);
    return { screenRgb: lit ? hsl2rgb(hue, 0.18, 0.85) : [0, 0, 0], torchOn: lit };
  },
  // a bright band sweeps across the crowd by index — coherent, calm, spatial.
  ripple: function (ms, i, N) {
    var u = N > 1 ? i / (N - 1) : 0, t = ms / 1000;
    var d = ((t * 0.6 - u) % 2 + 2) % 2;
    var soft = clamp01(1 - Math.abs(d - 0.09) / 0.14);
    return { screenRgb: hsl2rgb(205, 0.4, 0.05 + 0.9 * soft), torchOn: soft > 0.5 };
  },
  // the deliberately "rapid" one — raw 6 Hz request that the downstream governor CLAMPS to <=2.8/s.
  strobe_burst: function (ms, i, N) {
    var on = frac(ms / 1000 * 6) < 0.5;
    return { screenRgb: on ? hsl2rgb(45, 0.10, 0.95) : [0, 0, 0], torchOn: on };
  },
  // colour explosion — a slow full-hue sweep with synchronized brightness swells.
  color_burst: function (ms, i, N) {
    var hue = (ms / 1000 * 140) % 360;
    var L = 0.25 + 0.55 * Math.max(pop(ms, 600, 400), pop(ms, 2100, 400), pop(ms, 3600, 400));
    return { screenRgb: hsl2rgb(hue, 0.55, clamp01(L)), torchOn: L > 0.6 };
  },
};
export const FX_DURATIONS = { salute: 4500, twinkle: 5000, ripple: 4500, strobe_burst: 3500, color_burst: 5000 };
export const FX_LABELS = { salute: 'Salute', twinkle: 'Twinkle', ripple: 'Ripple', strobe_burst: 'Strobe burst', color_burst: 'Color burst' };
export const FX_NAMES = Object.keys(FX);
export function validateFx(name) { return FX_NAMES.indexOf(String(name)) >= 0 ? { ok: true, name: String(name) } : { ok: false, error: 'unknown fx' }; }
