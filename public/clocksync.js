// Shared NTP-like clock sync over WebSocket. Estimates the offset between this
// client's monotonic clock (performance.now) and the server's master clock, using
// the minimum-RTT samples (the rounds that dodged network queueing).
(function (global) {
  function ClockSync(send) {
    this.send = send;
    this.samples = [];
    this.offset = 0;
    this.rtt = Infinity;
    this.ready = false;
  }
  ClockSync.prototype.ping = function () { this.send({ t: 'sync', c0: performance.now() }); };
  ClockSync.prototype.onReply = function (c0, s1) {
    var c1 = performance.now();
    var offset = ((s1 - c0) + (s1 - c1)) / 2; // server - client
    var rtt = c1 - c0;
    this.samples.push({ offset: offset, rtt: rtt });
    this.samples.sort(function (a, b) { return a.rtt - b.rtt; });
    if (this.samples.length > 12) this.samples.length = 12;
    var half = this.samples.slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    half.sort(function (a, b) { return a.offset - b.offset; });
    this.offset = half[Math.floor(half.length / 2)].offset;
    this.rtt = this.samples[0].rtt;
    if (this.samples.length >= 5) this.ready = true;
  };
  ClockSync.prototype.serverNow = function () { return performance.now() + this.offset; };
  global.ClockSync = ClockSync;
})(window);
