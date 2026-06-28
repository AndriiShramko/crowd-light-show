// Browser mirror of src/presets.js — the parametric preset engine that every phone
// runs locally off the synced clock. The pure generator math + clampColor here are
// byte-checked against the server module by test/presets_parity.mjs, so the two can
// never drift. Exposes window.CLS_PRESETS.
(function (global) {
  'use strict';
  var MAX_RED_RATIO = 0.8;

  function frac(x) { return x - Math.floor(x); }
  function sin01(x) { return 0.5 + 0.5 * Math.sin(2 * Math.PI * x); }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpHue(a, b, t) { var d = ((b - a) % 360 + 540) % 360 - 180; return ((a + d * t) % 360 + 360) % 360; }

  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp01(s); l = clamp01(l);
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function relLum(rgb) { return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255; }

  // EXACT copy of the timeline compiler's colour governor (no large saturated red).
  function clampColor(rgb) {
    var r = Math.max(0, Math.min(255, Math.round(rgb[0])));
    var g = Math.max(0, Math.min(255, Math.round(rgb[1])));
    var b = Math.max(0, Math.min(255, Math.round(rgb[2])));
    var sum = r + g + b;
    if (sum > 0 && r / sum >= MAX_RED_RATIO) {
      var need = r / MAX_RED_RATIO - r;
      var add = Math.ceil((need - (g + b)) / 2) + 1;
      g = Math.min(255, g + add); b = Math.min(255, b + add);
    }
    return [r, g, b];
  }

  var WAVE_PAL = [
    [265, 0.65, 0.45], [205, 0.70, 0.50], [175, 0.60, 0.48],
    [140, 0.60, 0.46], [285, 0.55, 0.42],
  ];
  function palAt(pal, x) {
    x = frac(x);
    var n = pal.length, fx = x * n, i = Math.floor(fx) % n, j = (i + 1) % n, f = fx - Math.floor(fx);
    var a = pal[i], b = pal[j];
    return hsl2rgb(lerpHue(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f));
  }

  var PRESETS = {
    pulse: function (position, p, index, N) {
      var t = position / 1000;
      var L = clamp01(p.base + p.depth * sin01(t * p.bpm / 60));
      return hsl2rgb(p.hue, p.sat, L * 0.85 + 0.04);
    },
    color_waves: function (position, p, index, N) {
      var t = position / 1000;
      var u = N > 1 ? index / (N - 1) : 0;
      var phase = p.dir * p.speed * t - u / p.wavelength;
      return palAt(WAVE_PAL, phase);
    },
    rainbow_chase: function (position, p, index, N) {
      var t = position / 1000;
      var u = N > 1 ? index / (N - 1) : 0;
      var h = 360 * frac(p.dir * p.speed * t + p.spread * u);
      return hsl2rgb(h, 0.9, 0.5);
    },
    ocean: function (position, p, index, N) {
      var t = position / 1000;
      var ph = sin01(t * p.speed);
      return hsl2rgb(lerp(180, 205, ph), 0.7, 0.30 + 0.35 * ph);
    },
  };

  var PARAM_SCHEMA = {
    pulse: { label: 'Pulse', spatial: false, params: {
      bpm: { min: 30, max: 180, step: 1, def: 70, label: 'Tempo (BPM)' },
      depth: { min: 0, max: 0.8, step: 0.01, def: 0.55, label: 'Depth' },
      base: { min: 0.05, max: 0.5, step: 0.01, def: 0.18, label: 'Floor' },
      hue: { min: 0, max: 360, step: 1, def: 265, label: 'Hue' },
      sat: { min: 0, max: 1, step: 0.01, def: 0.7, label: 'Saturation' } } },
    color_waves: { label: 'Color Waves', spatial: true, params: {
      speed: { min: 0.02, max: 0.6, step: 0.01, def: 0.15, label: 'Speed' },
      wavelength: { min: 0.3, max: 3, step: 0.05, def: 1.0, label: 'Wavelength' },
      dir: { min: -1, max: 1, step: 2, def: 1, label: 'Direction' } } },
    rainbow_chase: { label: 'Rainbow Chase', spatial: true, params: {
      speed: { min: 0.02, max: 0.5, step: 0.01, def: 0.1, label: 'Speed' },
      spread: { min: 0.2, max: 3, step: 0.05, def: 1.0, label: 'Spread' },
      dir: { min: -1, max: 1, step: 2, def: 1, label: 'Direction' } } },
    ocean: { label: 'Ocean', spatial: false, params: {
      speed: { min: 0.04, max: 0.3, step: 0.01, def: 0.12, label: 'Speed' } } },
  };

  function defaults(type) {
    var s = PARAM_SCHEMA[type]; if (!s) return {};
    var o = {}; for (var k in s.params) o[k] = s.params[k].def; return o;
  }

  // Client-side safety backstop: limit how fast luminance may swing (>=150ms for a
  // full 0<->1 change), mirroring the server governor. Presets are smooth by
  // construction so this is almost always a no-op; it exists as defense-in-depth so
  // even a malformed {preset} message can never strobe a phone. Stateful per device.
  function makeBackstop(minRampMs) {
    minRampMs = minRampMs || 150;
    var prevL = 0;
    return function (rgb, dtMs) {
      var L = relLum(rgb);
      var maxDelta = Math.max(0.0001, (dtMs || 16) / minRampMs);
      if (Math.abs(L - prevL) > maxDelta && L > 0.0001) {
        var allowed = prevL + (L > prevL ? maxDelta : -maxDelta);
        var k = clamp01(allowed / L);
        rgb = [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)];
        L = allowed;
      }
      prevL = L;
      return rgb;
    };
  }

  global.CLS_PRESETS = {
    PRESETS: PRESETS, PARAM_SCHEMA: PARAM_SCHEMA, clampColor: clampColor,
    relLum: relLum, defaults: defaults, makeBackstop: makeBackstop,
    DEFAULT_PRESET: 'pulse', TYPES: Object.keys(PARAM_SCHEMA),
  };
})(typeof window !== 'undefined' ? window : this);
