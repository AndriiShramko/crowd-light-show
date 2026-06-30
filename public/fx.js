// Round 13 (pt 5) — SPECIAL EFFECTS ("fireworks") channel (browser mirror of src/fx.js). Augments
// window.CLS_PRESETS with FX/FX_NAMES/FX_DURATIONS/FX_LABELS. Each fx(ms,i,N) -> {screenRgb,torchOn} is
// played deterministically off the synced clock; the output flows through the SAME clampColor+backstop
// (screen) and torchGate (torch) governors in audience.js, so the fireworks stay <=3 flashes/s.
// MIRRORED with src/fx.js — test/fx_parity.mjs byte-checks the fx functions are identical.
(function (global) {
  'use strict';
  function frac(x) { return x - Math.floor(x); }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function hash01(n) { var s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); }
  function pop(t, center, width) { var x = (t - center) / width; return x * x > 1 ? 0 : (1 - x * x); }
  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp01(s); l = clamp01(l);
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  var FX = {
    salute: function (ms, i, N) {
      var L = Math.max(pop(ms, 150, 170), pop(ms, 1100, 150), pop(ms, 2100, 150), pop(ms, 3100, 150));
      return { screenRgb: hsl2rgb(45, 0.12, 0.04 + 0.92 * clamp01(L)), torchOn: L > 0.5 };
    },
    twinkle: function (ms, i, N) {
      var rate = 2.4, slot = Math.floor(ms / 1000 * rate);
      var lit = (hash01(slot * 7.13 + (i % 997) * 1.7) < 0.5) && (frac(ms / 1000 * rate) < 0.35);
      var hue = 40 + 80 * hash01(i * 3.7 + 1);
      return { screenRgb: lit ? hsl2rgb(hue, 0.18, 0.85) : [0, 0, 0], torchOn: lit };
    },
    ripple: function (ms, i, N) {
      var u = N > 1 ? i / (N - 1) : 0, t = ms / 1000;
      var d = ((t * 0.6 - u) % 2 + 2) % 2;
      var soft = clamp01(1 - Math.abs(d - 0.09) / 0.14);
      return { screenRgb: hsl2rgb(205, 0.4, 0.05 + 0.9 * soft), torchOn: soft > 0.5 };
    },
    strobe_burst: function (ms, i, N) {
      var on = frac(ms / 1000 * 6) < 0.5;
      return { screenRgb: on ? hsl2rgb(45, 0.10, 0.95) : [0, 0, 0], torchOn: on };
    },
    color_burst: function (ms, i, N) {
      var hue = (ms / 1000 * 140) % 360;
      var L = 0.25 + 0.55 * Math.max(pop(ms, 600, 400), pop(ms, 2100, 400), pop(ms, 3600, 400));
      return { screenRgb: hsl2rgb(hue, 0.55, clamp01(L)), torchOn: L > 0.6 };
    },
  };
  var FX_DURATIONS = { salute: 4500, twinkle: 5000, ripple: 4500, strobe_burst: 3500, color_burst: 5000 };
  var FX_LABELS = { salute: 'Salute', twinkle: 'Twinkle', ripple: 'Ripple', strobe_burst: 'Strobe burst', color_burst: 'Color burst' };
  var P = global.CLS_PRESETS || (global.CLS_PRESETS = {});
  P.FX = FX; P.FX_DURATIONS = FX_DURATIONS; P.FX_LABELS = FX_LABELS; P.FX_NAMES = Object.keys(FX);
})(window);
