// Per-phone synchronized audio. Plays the SAME track on every opted-in phone,
// sample-accurately aligned to the show clock, so the crowd becomes one synced
// (lo-fi) speaker array on top of the light show.
//
// Three clocks must never be conflated:
//   performance.now()            ms,  page-load epoch, monotonic
//   showClock = perf + offset    ms,  server epoch  (clock.serverNow())
//   audioCtx.currentTime         SEC, audio-hardware epoch, INDEPENDENT
// We anchor audio<->show once, schedule with source.start(when, offset), then a
// 1 Hz drift loop keeps them aligned (gentle playbackRate nudge, or reseat on a big
// jump). Honest scope: bounded by the speed of sound (§ acoustics) — a small-venue /
// "moment" / shared-recording feature, not a stadium speaker array.
(function (global) {
  'use strict';
  function AudioSync(clock) {
    this.clock = clock; this.ctx = null; this.gain = null; this.buf = null;
    this.src = null; this.anchor = null; this.startOffsetSec = 0; this.T0 = null;
    this.driftTimer = null; this.tele = function () {};
  }
  // MUST be called from a user-gesture handler (autoplay policy).
  AudioSync.prototype.init = function () {
    if (this.ctx) return this.ctx.resume();
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('no WebAudio'));
    this.ctx = new AC();
    this.gain = this.ctx.createGain(); this.gain.gain.value = 0.85; this.gain.connect(this.ctx.destination);
    return this.ctx.resume();
  };
  AudioSync.prototype.setVolume = function (v) { if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, v)); };
  AudioSync.prototype.cache = function (arrayBuffer) {
    var self = this;
    return new Promise(function (res, rej) {
      self.ctx.decodeAudioData(arrayBuffer, function (b) { self.buf = b; self.tele({ ready: true, durMs: Math.round(b.duration * 1000) }); res(b); }, rej);
    });
  };
  AudioSync.prototype.ready = function () { return !!(this.ctx && this.buf); };
  AudioSync.prototype._anchorClocks = function () {
    var ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    var perf = ts && ts.performanceTime ? ts.performanceTime : performance.now();
    var actx = ts && ts.contextTime != null ? ts.contextTime : this.ctx.currentTime;
    this.anchor = { actx: actx, showAtActx: perf + this.clock.offset }; // (audio sec) <-> (show ms)
  };
  // Start (or restart) playback aligned so show-position == clock.serverNow() - T0.
  AudioSync.prototype.start = function (T0) {
    if (!this.ready()) return;
    this.stopSource();
    this._anchorClocks();
    this.T0 = T0;
    var durMs = this.buf.duration * 1000, LEAD = 0.12; // 0.12s scheduling margin (not audible delay)
    var targetShow = this.clock.serverNow() + LEAD * 1000;
    var showPos = targetShow - T0;
    if (showPos > durMs) { this.tele({ scheduled: false, ended: true }); return; } // track already over
    var src = this.ctx.createBufferSource(); src.buffer = this.buf; src.connect(this.gain);
    var when, offsetSec;
    if (showPos < 0) { when = this.anchor.actx + (T0 - this.anchor.showAtActx) / 1000; offsetSec = 0; } // future T0
    else { when = this.anchor.actx + (targetShow - this.anchor.showAtActx) / 1000; offsetSec = showPos / 1000; }
    var safeWhen = Math.max(this.ctx.currentTime + 0.01, when);
    var clampSec = safeWhen - when;                       // if we lost time, skip the buffer forward too
    var realOffset = Math.max(0, offsetSec + clampSec);
    try { src.start(safeWhen, realOffset); } catch (e) { return; }
    this.src = src; this.startOffsetSec = realOffset;
    // Telemetry: the scheduled start AS A SHOW-CLOCK INSTANT (what the harness asserts).
    var scheduledShowInstant = this.anchor.showAtActx + (safeWhen - this.anchor.actx) * 1000 - realOffset * 1000;
    this.tele({ scheduled: true, scheduledShowInstant: scheduledShowInstant, T0: T0, offsetSec: realOffset, driftMs: 0 });
    this._startDrift();
  };
  AudioSync.prototype._startDrift = function () {
    var self = this; if (this.driftTimer) clearInterval(this.driftTimer);
    this.driftTimer = setInterval(function () {
      if (!self.src) return;
      var expected = self.clock.serverNow() - self.T0;                                  // ms (ground truth)
      var played = ((self.ctx.currentTime - self.anchor.actx) + self.startOffsetSec) * 1000; // ms actually rendered
      var drift = expected - played;                                                    // +ve = audio behind
      self.tele({ driftMs: Math.round(drift) });
      if (Math.abs(drift) < 15) { self.src.playbackRate.value = 1; return; }            // deadband
      if (Math.abs(drift) > 90) { self.start(self.T0); return; }                        // reseat on big jump
      try { self.src.playbackRate.value = 1 + (drift > 0 ? 1 : -1) * 0.003; } catch (e) {} // inaudible nudge
    }, 1000);
  };
  AudioSync.prototype.stopSource = function () {
    if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; }
    if (this.src) { try { this.src.stop(); } catch (e) {} try { this.src.disconnect(); } catch (e) {} this.src = null; }
  };
  AudioSync.prototype.stop = function () { this.stopSource(); this.tele({ scheduled: false }); };
  AudioSync.prototype.resume = function () { if (this.ctx) this.ctx.resume(); if (this.src && this.T0 != null) this.start(this.T0); };
  AudioSync.prototype.teardown = function () { this.stopSource(); if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; } this.buf = null; };
  global.AudioSync = AudioSync;
})(window);
