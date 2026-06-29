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
    // OFF by default: same-model phones share the same TRUE speaker latency, so aligning
    // the buffer cursor to the show clock already aligns their SOUND — and subtracting a
    // per-device REPORTED outputLatency (noisy, quantized, device-variable, 0 on Safari)
    // only pushes identical phones apart. Compensation is an explicit opt-in for known
    // heterogeneous fleets; even then it is clamped.
    this.compensateLatency = false;
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
  // REPORTED output latency of THIS device (TELEMETRY ONLY): graph->device buffer
  // (baseLatency) + device->speaker incl. OS stack (outputLatency). Browser-estimated,
  // quantized, variable run-to-run even on identical hardware; Safari returns undefined(->0).
  AudioSync.prototype._outLatency = function () {
    var ol = (typeof this.ctx.outputLatency === 'number') ? this.ctx.outputLatency : 0;
    var bl = (typeof this.ctx.baseLatency === 'number') ? this.ctx.baseLatency : 0;
    return ol + bl; // seconds — telemetry
  };
  // The latency actually SUBTRACTED from the schedule. 0 by default (cursor == show clock,
  // so identical devices lock); only when explicitly opted in, and clamped against absurd reads.
  AudioSync.prototype._latComp = function () {
    if (!this.compensateLatency) return 0;
    var L = this._outLatency();
    return (L > 0 && L <= 0.5) ? L : 0;
  };
  AudioSync.prototype.cache = function (arrayBuffer) {
    var self = this;
    return new Promise(function (res, rej) {
      self.ctx.decodeAudioData(arrayBuffer, function (b) { self.buf = b; self.tele({ ready: true, durMs: Math.round(b.duration * 1000) }); res(b); }, rej);
    });
  };
  AudioSync.prototype.ready = function () { return !!(this.ctx && this.buf); };
  AudioSync.prototype._anchorClocks = function () {
    var ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    // only trust getOutputTimestamp once it has real values — right after resume() some
    // browsers return {contextTime:0, performanceTime:0}, which would skew the anchor ~100ms.
    var valid = ts && ts.contextTime > 0 && ts.performanceTime > 0;
    var perf = valid ? ts.performanceTime : performance.now();
    var actx = valid ? ts.contextTime : this.ctx.currentTime;
    // Anchor in the SAME slewed basis serverNow() uses (offsetApplied), not the raw best
    // estimate `offset`. During clock convergence the two differ, so a raw-offset anchor made
    // the drift loop compare audio against a DIFFERENT clock than the scheduler used and inject
    // a phantom per-second drift (part of the round-10 stutter). Fall back to offset if a stub
    // clock lacks offsetApplied.
    var applied = (typeof this.clock.offsetApplied === 'number') ? this.clock.offsetApplied : this.clock.offset;
    this.anchor = { actx: actx, showAtActx: perf + applied }; // (audio sec) <-> (show ms)
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
    var L = this._latComp();                              // 0 by default -> cursor == show clock (identical phones lock)
    var Lrep = this._outLatency();                        // reported latency (telemetry only)
    var when, offsetSec;
    if (showPos < 0) { when = this.anchor.actx + (T0 - this.anchor.showAtActx) / 1000 - L; offsetSec = 0; } // future T0
    else { when = this.anchor.actx + (targetShow - this.anchor.showAtActx) / 1000 - L; offsetSec = showPos / 1000; }
    var safeWhen = Math.max(this.ctx.currentTime + 0.01, when);
    var clampSec = safeWhen - when;                       // if we lost time, skip the buffer forward too
    var realOffset = Math.max(0, offsetSec + clampSec);
    try { src.start(safeWhen, realOffset); } catch (e) { return; }
    // startWhenActx is the REAL audio instant the cursor == realOffset. The drift loop measures
    // played progress from HERE (not from anchor.actx, which sits one LEAD earlier — that gap was
    // a constant ~120ms phantom drift that reseated the source every second: the round-10 stutter).
    this.src = src; this.startOffsetSec = realOffset; this.startWhenActx = safeWhen; this.outLatencySec = L;
    this._startSeq = (this._startSeq || 0) + 1; // counts (re)schedules — a drift-loop reseat bumps it; the no-reseat test asserts it stays flat during steady playback
    // Cursor instant is the PRIMARY alignment (== show clock when comp is off, the default,
    // so same-model phones lock). soundShowInstant uses the REPORTED latency so a mixed
    // fleet's spread stays observable even though we don't compensate it by default.
    var scheduledShowInstant = this.anchor.showAtActx + (safeWhen - this.anchor.actx) * 1000 - realOffset * 1000;
    var soundShowInstant = scheduledShowInstant + Lrep * 1000;
    this.tele({ scheduled: true, scheduledShowInstant: scheduledShowInstant, soundShowInstant: soundShowInstant,
      outLatencyMs: Math.round(Lrep * 1000), compMs: Math.round(L * 1000), rate: 1, T0: T0, offsetSec: realOffset, driftMs: 0, startSeq: this._startSeq });
    this._startDrift();
  };
  // Deadband / nudge / reseat thresholds (ms). On REAL hardware the AudioContext crystal drifts
  // <10ms over a 3-min track (round-9 measurement) — far below DEADBAND — so on real phones none
  // of the tiers ever fire: rate stays 1.0, phones stay locked, no stutter. The tiers only act on
  // anomalies (a clock slew after resync, a tab suspend, a throttle glitch).
  AudioSync.DEADBAND_MS = 50;   // <= this: leave rate at 1.0 (never chase clock noise / inter-phone floor)
  AudioSync.RESEAT_MS = 180;    // > this: one clean reseat (stop+restart) — unavoidable for a big jump
  AudioSync.NUDGE_MAX = 0.02;   // bounded ±2% playbackRate
  AudioSync.NUDGE_TICKS = 2;    // one-shot: a nudge lasts at most this many ticks, then forced back to 1.0
  // Pure decision for ONE drift tick. Extracted so the tiers are unit-testable without real audio.
  // Returns 'reseat' | 'nudging' | 'nudge' | 'hold'; mutates playbackRate + _nudgeLeft as a side effect.
  AudioSync.prototype._applyDriftDecision = function (drift) {
    var ad = Math.abs(drift);
    var rate = this.src ? this.src.playbackRate : null;
    if (ad > AudioSync.RESEAT_MS) { this._nudgeLeft = 0; if (rate) rate.value = 1; return 'reseat'; }
    // mid-nudge: count it down; the LAST tick of a nudge forces rate back to exactly 1.0 (one-shot,
    // so identical phones don't continuously chase their own clock noise -> no inter-phone wobble).
    if (this._nudgeLeft > 0) { this._nudgeLeft--; if (this._nudgeLeft === 0 && rate) rate.value = 1; return 'nudging'; }
    if (ad > AudioSync.DEADBAND_MS) {
      if (rate) rate.value = 1 + Math.max(-AudioSync.NUDGE_MAX, Math.min(AudioSync.NUDGE_MAX, drift / 2000)); // +ve drift -> behind -> play faster
      this._nudgeLeft = AudioSync.NUDGE_TICKS;
      return 'nudge';
    }
    if (rate) rate.value = 1;
    return 'hold';
  };
  AudioSync.prototype._startDrift = function () {
    var self = this; if (this.driftTimer) clearInterval(this.driftTimer);
    this._nudgeLeft = 0;
    this.driftTimer = setInterval(function () {
      if (!self.src) return;
      var expected = self.clock.serverNow() - self.T0;                                       // ms (ground truth)
      var played = (self.startOffsetSec + (self.ctx.currentTime - self.startWhenActx)) * 1000; // ms rendered, from the REAL buffer-start instant
      // +outLatency: when latency-compensation is ON the cursor INTENTIONALLY leads the show clock
      // by L (so the SOUND lands on time), so subtract that designed lead — otherwise the loop would
      // fight its own compensation. L is 0 in the default (no-comp) path, so this is a no-op there.
      var drift = expected - played + (self.outLatencySec || 0) * 1000;                       // +ve = audio behind
      self.tele({ driftMs: Math.round(drift), rate: self.src.playbackRate.value });
      if (self._applyDriftDecision(drift) === 'reseat') self.start(self.T0);                 // clean reschedule only on a big jump
    }, 1000);
  };
  // LOOPING playback synced to a fixed epoch (the landing demo): every phone plays the
  // same position = (serverNow - epochMs) % loopMs at the same wall instant, looping forever.
  AudioSync.prototype.startLoop = function (epochMs, loopMs) {
    if (!this.ready()) return;
    this.stopSource();
    this._anchorClocks();
    this.T0 = epochMs; this.loopMs = loopMs; this.looping = true;
    var L = this._latComp();                                   // 0 by default (cursor == show clock)
    var Lrep = this._outLatency();
    var loopSec = Math.min(this.buf.duration, loopMs / 1000); // audio loop period == lights loop period
    var targetShow = this.clock.serverNow() + 120;            // +0.12s scheduling margin
    var loopPos = (((targetShow - epochMs) % loopMs) + loopMs) % loopMs; // ms into the loop at target
    var src = this.ctx.createBufferSource(); src.buffer = this.buf;
    src.loop = true; src.loopStart = 0; src.loopEnd = loopSec; src.connect(this.gain);
    var when = this.anchor.actx + (targetShow - this.anchor.showAtActx) / 1000 - L;
    var safeWhen = Math.max(this.ctx.currentTime + 0.01, when);
    var clampSec = safeWhen - when;
    var offsetSec = ((loopPos / 1000) + clampSec) % loopSec;
    if (offsetSec < 0) offsetSec += loopSec;
    try { src.start(safeWhen, offsetSec); } catch (e) { return; }
    this.src = src; this.startOffsetSec = offsetSec; this.startWhenActx = safeWhen; this.loopSec = loopSec;
    this._startSeq = (this._startSeq || 0) + 1;
    this.tele({ scheduled: true, looping: true, outLatencyMs: Math.round(Lrep * 1000), compMs: Math.round(L * 1000), loopMs: loopMs, rate: 1, driftMs: 0, startSeq: this._startSeq });
    this._startLoopDrift();
  };
  AudioSync.prototype._startLoopDrift = function () {
    var self = this; if (this.driftTimer) clearInterval(this.driftTimer);
    self.loopBase = null; // the constant cursor<->lights offset (intended lead + buffer latency)
    this.driftTimer = setInterval(function () {
      if (!self.src || !self.looping) return;
      var expected = (((self.clock.serverNow() - self.T0) % self.loopMs) + self.loopMs) % self.loopMs; // ms in loop
      var playedSec = (self.ctx.currentTime - self.startWhenActx) + self.startOffsetSec;
      var playedPos = (((playedSec % self.loopSec) + self.loopSec) % self.loopSec) * 1000;               // ms in loop
      var raw = expected - playedPos;
      if (raw > self.loopMs / 2) raw -= self.loopMs;            // wrap to nearest
      if (raw < -self.loopMs / 2) raw += self.loopMs;
      if (self.loopBase == null) { self.loopBase = raw; }       // lock onto the start offset (cursor leads sound by L on purpose)
      var dev = raw - self.loopBase;                            // GENUINE drift since the lock (clock/audio divergence)
      if (dev > self.loopMs / 2) dev -= self.loopMs;
      if (dev < -self.loopMs / 2) dev += self.loopMs;
      self.tele({ driftMs: Math.round(dev), rate: 1 });
      self.src.playbackRate.value = 1;                                           // never nudge (no inter-phone wobble)
      if (Math.abs(dev) > 80) self.startLoop(self.T0, self.loopMs);              // reseat only on a real slip
    }, 1000);
  };
  AudioSync.prototype.stopSource = function () {
    if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; }
    if (this.src) { try { this.src.stop(); } catch (e) {} try { this.src.disconnect(); } catch (e) {} this.src = null; }
  };
  AudioSync.prototype.stop = function () { this.stopSource(); this.tele({ scheduled: false }); };
  // Drop the decoded buffer (operator armed a different track) so the next cache() fetches
  // the NEW track's audio instead of replaying the old one. ready() goes false again.
  AudioSync.prototype.dropBuffer = function () { this.stopSource(); this.buf = null; this.looping = false; this.tele({ ready: false, scheduled: false }); };
  AudioSync.prototype.resume = function () { if (this.ctx) this.ctx.resume(); if (this.src && this.T0 != null) this.start(this.T0); };
  AudioSync.prototype.teardown = function () { this.stopSource(); if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; } this.buf = null; };
  global.AudioSync = AudioSync;
})(window);
