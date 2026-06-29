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

  // Music reactivity drive (mirror of src/presets.js audioDrive — round 8A, stronger +
  // operator-tunable): level = governed loudness (sampleCue(trackPos).b, already <=3 fl/s)
  // at the synced track position. Conditions it (floor-gate -> normalize -> GAIN -> GAMMA)
  // into { m, a }: m = drive 0..1, a = crossfade weight = audioDepth. audioDepth=0 returns
  // { m:0, a:0 } -> preset == the autonomous look exactly for any gain/floor/gamma.
  function audioDrive(level, p) {
    var d = p.audioDepth == null ? 0 : (p.audioDepth < 0 ? 0 : p.audioDepth > 1 ? 1 : p.audioDepth);
    if (d === 0) return { m: 0, a: 0 };
    var lv = (typeof level === 'number' && level === level) ? level : 0;
    lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
    var floor = p.audioFloor == null ? 0 : (p.audioFloor < 0 ? 0 : p.audioFloor > 0.9 ? 0.9 : p.audioFloor);
    var gain = p.audioGain == null ? 1 : (p.audioGain < 0.1 ? 0.1 : p.audioGain > 8 ? 8 : p.audioGain);
    var gamma = p.audioGamma == null ? 1 : p.audioGamma;
    var x = (lv - floor) / (1 - floor);
    if (x < 0) x = 0;
    x = x * gain; if (x > 1) x = 1;
    if (gamma !== 1) x = Math.pow(x, gamma);
    return { m: x, a: d };
  }

  var PRESETS = {
    pulse: function (position, p, index, N, level) {
      var t = position / 1000;
      var dr = audioDrive(level, p);
      var gen = clamp01(p.base + p.depth * sin01(t * p.bpm / 60));
      var music = clamp01(p.base + (1 - p.base) * dr.m);
      var L = gen + dr.a * (music - gen);               // == gen when dr.a==0
      return hsl2rgb(p.hue, p.sat, L * 0.85 + 0.04);
    },
    color_waves: function (position, p, index, N, level) {
      var t = position / 1000;
      var u = N > 1 ? index / (N - 1) : 0;
      var phase = p.dir * p.speed * t - u / p.wavelength;
      var rgb = palAt(WAVE_PAL, phase);
      var dr = audioDrive(level, p);
      var k = 1 - dr.a * (1 - (0.30 + 0.70 * dr.m));    // k==1 when dr.a==0; k in [0.30,1]
      return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
    },
    rainbow_chase: function (position, p, index, N, level) {
      var t = position / 1000;
      var u = N > 1 ? index / (N - 1) : 0;
      var h = 360 * frac(p.dir * p.speed * t + p.spread * u);
      var dr = audioDrive(level, p);
      var L = 0.5 - dr.a * (0.5 - (0.15 + 0.45 * dr.m));  // L==0.5 when dr.a==0; L in [0.15,0.6]
      return hsl2rgb(h, 0.9, L);
    },
    ocean: function (position, p, index, N, level) {
      var t = position / 1000;
      var ph = sin01(t * p.speed);
      var dr = audioDrive(level, p);
      var lAuto = 0.30 + 0.35 * ph;
      var lMusic = lAuto + 0.40 * dr.m;
      var L = lAuto + dr.a * (lMusic - lAuto);          // == lAuto when dr.a==0
      return hsl2rgb(lerp(180, 205, ph), 0.7, clamp01(L));
    },
  };

  var AUDIO_PARAMS = {
    audioDepth: { min: 0, max: 1, step: 0.01, def: 0.6, label: 'Music reactivity' },
    audioGain: { min: 1, max: 6, step: 0.1, def: 2.5, label: 'Reactivity strength' },
    audioFloor: { min: 0, max: 0.5, step: 0.01, def: 0.12, label: 'Reactivity floor' },
    audioGamma: { min: 0.4, max: 1.6, step: 0.05, def: 0.8, label: 'Reactivity curve' },
  };
  var PARAM_SCHEMA = {
    pulse: { label: 'Pulse', spatial: false, params: {
      bpm: { min: 30, max: 180, step: 1, def: 70, label: 'Tempo (BPM)' },
      depth: { min: 0, max: 0.8, step: 0.01, def: 0.55, label: 'Depth' },
      base: { min: 0.05, max: 0.5, step: 0.01, def: 0.18, label: 'Floor' },
      hue: { min: 0, max: 360, step: 1, def: 265, label: 'Hue' },
      sat: { min: 0, max: 1, step: 0.01, def: 0.7, label: 'Saturation' },
      audioDepth: AUDIO_PARAMS.audioDepth, audioGain: AUDIO_PARAMS.audioGain, audioFloor: AUDIO_PARAMS.audioFloor, audioGamma: AUDIO_PARAMS.audioGamma } },
    color_waves: { label: 'Color Waves', spatial: true, params: {
      speed: { min: 0.02, max: 0.6, step: 0.01, def: 0.15, label: 'Speed' },
      wavelength: { min: 0.3, max: 3, step: 0.05, def: 1.0, label: 'Wavelength' },
      dir: { min: -1, max: 1, step: 2, def: 1, label: 'Direction' },
      audioDepth: AUDIO_PARAMS.audioDepth, audioGain: AUDIO_PARAMS.audioGain, audioFloor: AUDIO_PARAMS.audioFloor, audioGamma: AUDIO_PARAMS.audioGamma } },
    rainbow_chase: { label: 'Rainbow Chase', spatial: true, params: {
      speed: { min: 0.02, max: 0.5, step: 0.01, def: 0.1, label: 'Speed' },
      spread: { min: 0.2, max: 3, step: 0.05, def: 1.0, label: 'Spread' },
      dir: { min: -1, max: 1, step: 2, def: 1, label: 'Direction' },
      audioDepth: AUDIO_PARAMS.audioDepth, audioGain: AUDIO_PARAMS.audioGain, audioFloor: AUDIO_PARAMS.audioFloor, audioGamma: AUDIO_PARAMS.audioGamma } },
    ocean: { label: 'Ocean', spatial: false, params: {
      speed: { min: 0.04, max: 0.3, step: 0.01, def: 0.12, label: 'Speed' },
      audioDepth: AUDIO_PARAMS.audioDepth, audioGain: AUDIO_PARAMS.audioGain, audioFloor: AUDIO_PARAMS.audioFloor, audioGamma: AUDIO_PARAMS.audioGamma } },
  };

  function defaults(type) {
    var s = PARAM_SCHEMA[type]; if (!s) return {};
    var o = {}; for (var k in s.params) o[k] = s.params[k].def; return o;
  }

  // Client-side safety governor (the hard, on-device guarantee — mirrors the server
  // cue compiler's TWO mechanisms, not just one):
  //   1. FLASH-GATE: at most 3 low(<0.25)->high(>=0.6) luminance crossings per 1000ms;
  //      a premature flash is suppressed (held low). This is what bounds a fast or
  //      AUDIO-DRIVEN preset whose brightness blend could otherwise exceed 3/s.
  //   2. RAMP-LIMIT: a full 0<->1 swing takes >= minRampMs (no square-wave strobe).
  // So NO preset — any params, any audioDepth, any music, even a malformed {preset} —
  // can strobe a phone. Stateful per device; dtMs accumulates a local clock.
  function makeBackstop(minRampMs) {
    minRampMs = minRampMs || 150;
    var LOW = 0.25, HIGH = 0.6, minFlashGap = 1000 / 2.8; // ~357ms => <=3 flashes/1000ms with margin
    var prevL = 0, t = 0, lastFlash = -1e9, armed = true, holding = false;
    return function (rgb, dtMs) {
      dtMs = dtMs || 16; t += dtMs;
      var rawL = relLum(rgb);
      var target = rawL;
      if (target < LOW) armed = true;
      if (holding && t - lastFlash >= minFlashGap) holding = false; // suppression window elapsed
      // 1) flash-gate — gate the RENDERED output (hold it below HIGH) so a premature
      // low->high crossing physically cannot reach the screen until the gap elapses.
      if (target >= HIGH && armed && !holding) {
        if (t - lastFlash < minFlashGap) holding = true;          // too soon: start holding
        else { lastFlash = t; armed = false; }                    // allow this flash
      }
      if (holding) target = Math.min(target, LOW * 0.9);          // cap below HIGH while held
      // 2) ramp-limit (slew): a full swing takes >= minRampMs
      var maxDelta = Math.max(0.0001, dtMs / minRampMs);
      var L = (Math.abs(target - prevL) > maxDelta) ? prevL + (target > prevL ? maxDelta : -maxDelta) : target;
      // apply the governed luminance back onto the colour (uniform scale preserves hue)
      var k = rawL > 0.0001 ? clamp01(L / rawL) : 0;
      if (k !== 1) rgb = [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)];
      prevL = L;
      return rgb;
    };
  }

  // ======================= TORCH channel (round 8B) — mirror of src/presets.js =======================
  // Autonomous flash (camera-LED) channel: own presets + own reactivity knobs, independent of the
  // screen. Binary LED: a torch preset returns intensity 0..1, the phone thresholds (>=0.5) + rate-
  // gates it. iOS = no web torch API -> no-op (screen unaffected). Math byte-identical to the server.
  function torchDrive(level, p) {
    var d = p.torchDepth == null ? 0 : (p.torchDepth < 0 ? 0 : p.torchDepth > 1 ? 1 : p.torchDepth);
    if (d === 0) return 0;
    var lv = (typeof level === 'number' && level === level) ? level : 0;
    lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
    var floor = p.torchFloor == null ? 0 : (p.torchFloor < 0 ? 0 : p.torchFloor > 0.9 ? 0.9 : p.torchFloor);
    var gain = p.torchGain == null ? 1 : (p.torchGain < 0.1 ? 0.1 : p.torchGain > 8 ? 8 : p.torchGain);
    var gamma = p.torchGamma == null ? 1 : p.torchGamma;
    var x = (lv - floor) / (1 - floor);
    if (x < 0) x = 0;
    x = x * gain; if (x > 1) x = 1;
    if (gamma !== 1) x = Math.pow(x, gamma);
    return d * x;
  }
  function hash01(n) { var s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); }
  var TORCH_PRESETS = {
    off: function () { return 0; },
    strobe: function (position, p, index, N, level) { return frac((position / 1000) * p.rate) < p.duty ? 1 : 0; },
    sparkle: function (position, p, index, N, level) {
      var t = position / 1000, slot = Math.floor(t * p.rate), u = N > 1 ? index / N : 0;
      var h = hash01(slot * 7.13 + Math.floor(u * 997));
      return (h < p.duty && frac(t * p.rate) < 0.5) ? 1 : 0;
    },
    beat: function (position, p, index, N, level) { return clamp01(torchDrive(level, p)); },
  };
  var TORCH_AUDIO = {
    torchDepth: { min: 0, max: 1, step: 0.01, def: 0.85, label: 'Flash reactivity' },
    torchGain: { min: 1, max: 6, step: 0.1, def: 2.5, label: 'Flash strength' },
    torchFloor: { min: 0, max: 0.5, step: 0.01, def: 0.12, label: 'Flash floor' },
    torchGamma: { min: 0.4, max: 1.6, step: 0.05, def: 0.8, label: 'Flash curve' },
  };
  var TORCH_SCHEMA = {
    off: { label: 'Off', params: {} },
    strobe: { label: 'Strobe', params: {
      rate: { min: 0.5, max: 2.8, step: 0.1, def: 2.0, label: 'Rate (Hz)' },
      duty: { min: 0.1, max: 0.6, step: 0.05, def: 0.3, label: 'On time' } } },
    sparkle: { label: 'Sparkle', params: {
      rate: { min: 0.5, max: 2.8, step: 0.1, def: 2.5, label: 'Rate (Hz)' },
      duty: { min: 0.1, max: 0.6, step: 0.05, def: 0.3, label: 'Density' } } },
    beat: { label: 'Beat (reactive)', params: {
      torchDepth: TORCH_AUDIO.torchDepth, torchGain: TORCH_AUDIO.torchGain, torchFloor: TORCH_AUDIO.torchFloor, torchGamma: TORCH_AUDIO.torchGamma } },
  };
  function torchDefaults(type) { var s = TORCH_SCHEMA[type]; if (!s) return {}; var o = {}; for (var k in s.params) o[k] = s.params[k].def; return o; }
  // On-device torch rate gate: <=1 ON edge per minFlashGap (>=357ms => <=2.8/s). Binary, stateful.
  function makeTorchGate(minFlashGap) {
    minFlashGap = minFlashGap || (1000 / 2.8);
    var t = 0, lastOn = -1e9, prevOn = false;
    return function (onWanted, dtMs) {
      dtMs = dtMs || 16; t += dtMs;
      if (onWanted && !prevOn) {
        if (t - lastOn >= minFlashGap) { lastOn = t; prevOn = true; return true; }
        return false;
      }
      if (!onWanted) { prevOn = false; return false; }
      return true;
    };
  }

  global.CLS_PRESETS = {
    PRESETS: PRESETS, PARAM_SCHEMA: PARAM_SCHEMA, clampColor: clampColor,
    relLum: relLum, defaults: defaults, makeBackstop: makeBackstop,
    DEFAULT_PRESET: 'pulse', TYPES: Object.keys(PARAM_SCHEMA),
    TORCH_PRESETS: TORCH_PRESETS, TORCH_SCHEMA: TORCH_SCHEMA, torchDefaults: torchDefaults,
    makeTorchGate: makeTorchGate, TORCH_TYPES: Object.keys(TORCH_SCHEMA), DEFAULT_TORCH: 'beat',
  };
})(typeof window !== 'undefined' ? window : this);
