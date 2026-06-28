// Shared NTP-like clock sync over WebSocket. Estimates the offset between this
// client's monotonic clock (performance.now) and the server's master clock using
// the MINIMUM-RTT round over a rolling window: the round that dodged queueing has
// the least path-asymmetry error, so its offset is the most trustworthy.
//
// Hardening (round 4 — "never desync"):
//  - quality-gated `ready`: not just N samples, but a clean enough best-RTT AND a
//    stable offset, so a phone never paints off a not-yet-trustworthy estimate;
//  - degraded fallback: after a while on a bad network, accept best-effort and paint
//    anyway (a slightly-late phone beats a permanently black rectangle);
//  - drift slew: serverNow() moves the APPLIED offset toward the latest best estimate
//    smoothly, so a re-sync correction is an invisible drift, never a visible jump;
//  - resync(): a backgrounded tab's monotonic clock froze, so its offset is stale —
//    invalidate and re-converge (the render-gate keeps it dark meanwhile).
(function (global) {
  var MAX_READY_RTT = 400;   // ms — don't trust a round that never dodged queueing
  var STABLE_MS = 30;        // ms — best-offset must settle within this to be "ready"
  var MIN_SAMPLES = 8;
  var FALLBACK_MS = 6000;    // ms — bad network: paint best-effort after this (degraded)
  var SNAP_MS = 8;           // ms — corrections this small snap; larger ones slew
  var SLEW_PER_MS = 0.15;    // applied offset slews toward target at ~150 ms/s

  function ClockSync(send) {
    this.send = send;
    this.samples = [];
    this.offset = 0;          // best (min-RTT) estimate — operator T0 + telemetry use this
    this.offsetApplied = 0;   // slewed value used by serverNow() for smooth rendering
    this.rtt = Infinity;
    this.count = 0;
    this.ready = false;
    this.degraded = false;
    this.quality = { n: 0, bestRtt: Infinity, jitter: Infinity };
    this._recent = [];
    this._first = 0;
    this._have = false;
    this._lastSlew = 0;
  }
  ClockSync.prototype.ping = function () { this.send({ t: 'sync', c0: performance.now() }); };
  ClockSync.prototype.onReply = function (c0, s1) {
    var c1 = performance.now();
    var offset = ((s1 - c0) + (s1 - c1)) / 2; // server - client
    var rtt = c1 - c0;
    if (rtt < 0 || rtt > 4000) return;        // drop suspend/resume gaps & absurd rounds
    if (!this._first) this._first = c1;
    this.samples.push({ offset: offset, rtt: rtt });
    if (this.samples.length > 40) this.samples.shift(); // rolling window adapts to drift
    var best = this.samples[0];
    for (var i = 1; i < this.samples.length; i++) if (this.samples[i].rtt < best.rtt) best = this.samples[i];
    this.offset = best.offset;                // best estimate, updated every reply
    if (!this._have) { this.offsetApplied = best.offset; this._have = true; this._lastSlew = c1; } // snap first
    this.rtt = best.rtt;
    this.count = this.samples.length;
    this._recent.push(best.offset); if (this._recent.length > 3) this._recent.shift();
    var mn = this._recent[0], mx = this._recent[0];
    for (var j = 1; j < this._recent.length; j++) { if (this._recent[j] < mn) mn = this._recent[j]; if (this._recent[j] > mx) mx = this._recent[j]; }
    var spread = mx - mn;
    this.quality = { n: this.count, bestRtt: Math.round(best.rtt), jitter: Math.round(spread) };
    var good = this.count >= MIN_SAMPLES && best.rtt <= MAX_READY_RTT && this._recent.length >= 3 && spread <= STABLE_MS;
    if (good) { this.ready = true; this.degraded = false; }
    else if (!this.ready && this.count >= 6 && (c1 - this._first) > FALLBACK_MS) { this.ready = true; this.degraded = true; }
  };
  ClockSync.prototype.serverNow = function () {
    var now = performance.now();
    // Slew the applied offset toward the latest best estimate so re-syncs never jump.
    var dt = this._lastSlew ? now - this._lastSlew : 0; this._lastSlew = now;
    var diff = this.offset - this.offsetApplied;
    if (Math.abs(diff) <= SNAP_MS) this.offsetApplied = this.offset;
    else this.offsetApplied += (diff > 0 ? 1 : -1) * Math.min(Math.abs(diff), SLEW_PER_MS * Math.max(0, dt));
    return now + this.offsetApplied;
  };
  // A backgrounded tab's monotonic clock froze — the offset is now untrustworthy.
  // Invalidate and re-converge (render-gate keeps the phone dark until ready again).
  ClockSync.prototype.resync = function () {
    this.samples = []; this._recent = []; this.ready = false; this.degraded = false;
    this._first = 0; this.count = 0; this.rtt = Infinity;
  };
  global.ClockSync = ClockSync;
})(window);
