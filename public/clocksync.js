// Shared NTP-like clock sync over WebSocket. Estimates the offset between this
// client's monotonic clock (performance.now) and the server's master clock using
// the MINIMUM-RTT round over a rolling window: the round that dodged queueing has
// the least path-asymmetry error, so its offset is the most trustworthy. This is
// far more robust on real phones/cellular than averaging jittery samples.
(function (global) {
  function ClockSync(send) {
    this.send = send;
    this.samples = [];
    this.offset = 0;
    this.rtt = Infinity;
    this.count = 0;
    this.ready = false;
  }
  ClockSync.prototype.ping = function () { this.send({ t: 'sync', c0: performance.now() }); };
  ClockSync.prototype.onReply = function (c0, s1) {
    var c1 = performance.now();
    var offset = ((s1 - c0) + (s1 - c1)) / 2; // server - client
    var rtt = c1 - c0;
    if (rtt < 0 || rtt > 4000) return;        // drop absurd rounds (suspend/resume gaps)
    this.samples.push({ offset: offset, rtt: rtt });
    if (this.samples.length > 40) this.samples.shift(); // rolling window adapts to drift
    var best = this.samples[0];
    for (var i = 1; i < this.samples.length; i++) if (this.samples[i].rtt < best.rtt) best = this.samples[i];
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.count = this.samples.length;
    if (this.samples.length >= 6) this.ready = true;
  };
  ClockSync.prototype.serverNow = function () { return performance.now() + this.offset; };
  global.ClockSync = ClockSync;
})(window);
