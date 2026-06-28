(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var AUTO = params.get('auto') === '1';        // headless auto-join (sync harness)
  var DEMO = params.get('demo') === '1';        // zero-setup looping demo (Try it)
  var DIAG = params.get('diag') === '1';        // show clock-sync diagnostics
  var JITTER = Math.max(0, Number(params.get('jitter') || 0)); // simulated inbound delay (ms)
  var env = null, waveEl = null, waveCtx = null, waveTick = 0; // music waveform + playhead

  var flashEl = document.getElementById('flash');
  var stopBtn = document.getElementById('stopbtn');
  var pill = document.getElementById('statuspill');
  var elConsent = document.getElementById('consent');
  var elLive = document.getElementById('live');
  var elLeft = document.getElementById('left');
  var agree = document.getElementById('agree');
  var joinScreen = document.getElementById('joinScreen');
  var joinTorch = document.getElementById('joinTorch');

  // Test/telemetry hook (read by the Playwright sync harness).
  window.__cls = { flashes: [], lastBg: '#000', offset: 0, timeOrigin: performance.timeOrigin, status: 'idle', started: false, consented: false, everLit: false, colors: [] };

  var ws = null, clock = null, timeline = null;
  var runState = { status: 'idle', T0: null, epoch: 0, pausePos: 0 };
  var wakeLock = null, torchTrack = null, torchOn = false, lastTorchAt = 0, useTorch = false;
  var lastBg = '#000', prevLum = 0, flashArmed = true;
  var demoMode = false, demoT0 = 0;

  var isAndroid = /Android/i.test(navigator.userAgent);
  var canTryTorch = isAndroid && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (canTryTorch) joinTorch.classList.remove('hidden');

  agree.addEventListener('change', function () {
    joinScreen.disabled = !agree.checked; joinTorch.disabled = !agree.checked;
  });
  joinScreen.addEventListener('click', function () { join(false); });
  joinTorch.addEventListener('click', function () { join(true); });
  stopBtn.addEventListener('click', leave);
  document.getElementById('rejoin').addEventListener('click', function () { location.reload(); });

  if (AUTO) { agree.checked = true; joinScreen.disabled = false; setTimeout(function () { join(false); }, 50); }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && window.__cls.started) { acquireWake(); }
  });

  var lastStatusKey = '';
  function setStatus(key) { if (key === lastStatusKey) return; lastStatusKey = key; pill.classList.remove('hidden'); pill.textContent = i18n.t(key); }

  function join(withTorch) {
    if (!agree.checked) return;
    window.__cls.consented = true; window.__cls.started = true;
    useTorch = withTorch;
    elConsent.classList.add('hidden');
    elLive.classList.remove('hidden');
    stopBtn.classList.remove('hidden'); stopBtn.textContent = i18n.t('stop');
    setStatus('st_conn');
    requestFullscreen();
    acquireWake();
    if (withTorch) startTorch();
    initWave();
    connect();
    requestAnimationFrame(render);
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    clock = new ClockSync(function (o) { try { ws.send(JSON.stringify(o)); } catch (e) {} });
    ws.onopen = function () {
      ws.send(JSON.stringify({ t: 'hello', role: 'audience', platform: isAndroid ? 'android' : (/iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'other') }));
      setStatus('st_sync');
      var n = 0;
      var pinger = setInterval(function () { if (ws.readyState === 1) { clock.ping(); if (++n >= 40) clearInterval(pinger); } }, 70); // ~2.8s rapid sync
      setInterval(function () { if (ws.readyState === 1) clock.ping(); }, 3000); // continuous re-sync (drift + late convergence)
      if (DEMO) {
        fetch('/api/demo').then(function (r) { return r.json(); }).then(function (d) {
          timeline = d.timeline; demoT0 = d.T0; demoMode = true; buildEnvelope(); setStatus('st_play');
        }).catch(function () {});
      }
    };
    ws.onmessage = function (ev) {
      // Simulated delivery jitter on broadcasts (start/timeline/pause/...). The
      // clock-sync handshake is processed at true arrival, like a real client, so
      // it is not deferred. This isolates the claim under test: delayed delivery of
      // START must NOT desync the show, because execution is local off the synced clock.
      if (JITTER > 0 && ev.data.indexOf('"sync"') < 0) { setTimeout(function () { onMsg(ev.data); }, Math.random() * JITTER); }
      else onMsg(ev.data);
    };
    ws.onclose = function () { if (window.__cls.started) setStatus('st_conn'); /* timeline still runs locally */ };
    ws.onerror = function () {};
  }

  function onMsg(raw) {
    var m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'sync') { clock.onReply(m.c0, m.s1); window.__cls.offset = clock.offset; window.__cls.synced = clock.ready; window.__cls.rtt = clock.rtt; if (clock.ready && runState.status === 'idle') setStatus('st_wait'); return; }
    if (m.t === 'welcome' || m.t === 'state') { if (m.state) applyState(m.state); return; }
    if (m.t === 'timeline') { timeline = m.data; window.__cls.gotTimeline = (timeline && timeline.cues || []).length; buildEnvelope(); return; }
    if (m.t === 'start') { runState = { status: 'running', T0: m.T0, epoch: m.epoch, pausePos: 0 }; window.__cls.status = 'running'; window.__cls.gotStart = m.T0; prevLum = 0; flashArmed = true; setStatus('st_play'); return; }
    if (m.t === 'pause') { runState.status = 'paused'; runState.pausePos = m.pos; window.__cls.status = 'paused'; setStatus('st_paused'); return; }
    if (m.t === 'stop') { runState = { status: 'idle', T0: null, epoch: m.epoch, pausePos: 0 }; window.__cls.status = 'idle'; setStatus('st_wait'); return; }
    if (m.t === 'blackout') { runState = { status: 'blackout', T0: null, epoch: m.epoch }; window.__cls.status = 'blackout'; return; }
  }

  function applyState(s) {
    runState.status = s.status; runState.T0 = s.T0; runState.epoch = s.epoch; runState.pausePos = s.pausePos || 0;
    window.__cls.status = s.status;
  }

  function sampleCue(pos) {
    var cues = timeline.cues;
    var lo = 0, hi = cues.length - 1;
    if (pos <= cues[0].t) return { b: cues[0].b, rgb: cues[0].rgb };
    if (pos >= cues[hi].t) return { b: cues[hi].b, rgb: cues[hi].rgb };
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cues[mid].t <= pos) lo = mid; else hi = mid; }
    var a = cues[lo], b = cues[hi]; var f = (pos - a.t) / Math.max(1, b.t - a.t);
    return { b: a.b + (b.b - a.b) * f, rgb: [a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f, a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f] };
  }

  function render() {
    requestAnimationFrame(render);
    window.__cls.ticks = (window.__cls.ticks || 0) + 1;
    var synced = !!(clock && clock.ready); window.__cls.synced = synced;
    var lum = 0, rgb = [0, 0, 0], pos = -1, playing = false;
    if (timeline && runState.status === 'paused') {
      pos = runState.pausePos; var cp = sampleCue(pos); lum = cp.b; rgb = cp.rgb; playing = true;
    } else if (synced && demoMode && timeline) {
      var d = timeline.durationMs; pos = ((clock.serverNow() - demoT0) % d + d) % d; // loop forever
      var cd = sampleCue(pos); lum = cd.b; rgb = cd.rgb; playing = true;
    } else if (synced && timeline && runState.status === 'running') {
      pos = clock.serverNow() - runState.T0;
      if (pos >= 0 && pos <= timeline.durationMs + 250) { var c = sampleCue(pos); lum = c.b; rgb = c.rgb; playing = true; }
      setStatus('st_play');
    } else if (!synced && (demoMode || runState.status === 'running')) {
      setStatus('st_sync'); // clock not converged yet → stay dark, don't flash out of sync
    }
    var bg = 'rgb(' + Math.round(rgb[0] * lum) + ',' + Math.round(rgb[1] * lum) + ',' + Math.round(rgb[2] * lum) + ')';
    if (bg !== lastBg) {
      flashEl.style.backgroundColor = bg; lastBg = bg; window.__cls.lastBg = bg;
      if (bg !== 'rgb(0,0,0)') { window.__cls.everLit = true; if (window.__cls.colors.indexOf(bg) < 0 && window.__cls.colors.length < 40) window.__cls.colors.push(bg); }
    }
    if (demoMode || runState.status === 'running') {
      if (lum < 0.25) flashArmed = true;
      else if (lum >= 0.6 && flashArmed) { flashArmed = false; window.__cls.flashes.push({ epoch: runState.epoch, pos: Math.round(pos), wall: performance.timeOrigin + performance.now() }); }
    }
    prevLum = lum;
    window.__cls.lastPos = Math.round(pos); window.__cls.maxLum = Math.max(window.__cls.maxLum || 0, lum);
    driveTorch(lum);
    if ((++waveTick % 5) === 0) { drawWave(playing ? pos : -1); if (DIAG) updateDiag(pos); }
  }

  // Small per-device waveform of the track's loudness envelope + a moving playhead,
  // so it's visible that the flashing follows THIS music at THIS moment.
  function buildEnvelope() {
    env = null;
    if (!timeline || !timeline.cues || !timeline.durationMs) return;
    var N = 200, dur = timeline.durationMs, a = new Array(N);
    for (var i = 0; i < N; i++) a[i] = sampleCue(i / N * dur).b;
    env = a; if (waveEl) waveEl.classList.remove('hidden');
  }
  function initWave() { waveEl = document.getElementById('wave'); if (waveEl) waveCtx = waveEl.getContext('2d'); }
  function drawWave(pos) {
    if (!waveCtx || !env) return;
    var cw = waveEl.clientWidth || 320, ch = waveEl.clientHeight || 44;
    if (waveEl.width !== cw) waveEl.width = cw; if (waveEl.height !== ch) waveEl.height = ch;
    var ctx = waveCtx; ctx.clearRect(0, 0, cw, ch);
    var n = env.length, bw = cw / n, dur = timeline.durationMs, ph = pos >= 0 ? Math.max(0, Math.min(1, pos / dur)) : -1;
    for (var i = 0; i < n; i++) {
      var h = Math.max(1, env[i] * (ch - 4)), past = ph >= 0 && (i / n) <= ph;
      ctx.fillStyle = past ? 'rgba(90,160,255,.95)' : 'rgba(150,160,180,.35)';
      ctx.fillRect(i * bw, (ch - h) / 2, Math.max(1, bw - 0.5), h);
    }
    if (ph >= 0) { ctx.fillStyle = '#fff'; ctx.fillRect(ph * cw - 1, 0, 2, ch); }
  }
  function updateDiag(pos) {
    var el = document.getElementById('diag'); if (!el) return;
    el.classList.remove('hidden');
    el.textContent = 'offset ' + Math.round(clock ? clock.offset : 0) + 'ms · rtt ' + (clock ? Math.round(clock.rtt) : '?') + 'ms · n' + (clock ? clock.count : 0) + ' · pos ' + Math.round(pos) + 'ms';
  }

  // --- torch (Android only, slow: only toggle on threshold crossing, throttled) ---
  function startTorch() {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      var track = stream.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps && caps.torch) { torchTrack = track; setStatus('st_ready_t'); }
      else { track.stop(); useTorch = false; }
    }).catch(function () { useTorch = false; });
  }
  function driveTorch(lum) {
    if (!torchTrack) return;
    var want = lum > 0.5; var nowt = performance.now();
    if (want !== torchOn && nowt - lastTorchAt > 120) {
      torchOn = want; lastTorchAt = nowt;
      torchTrack.applyConstraints({ advanced: [{ torch: want }] }).catch(function () {});
    }
  }

  // --- screen wake lock (re-acquired on visibility) ---
  function acquireWake() {
    if (!('wakeLock' in navigator)) return;
    window.__cls.wakeTried = true;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
  }
  function requestFullscreen() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) { window.__cls.fsTried = true; try { fn.call(el); } catch (e) {} }
  }

  function leave() {
    window.__cls.started = false;
    try { if (ws) ws.close(); } catch (e) {}
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    if (torchTrack) { try { torchTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {} try { torchTrack.stop(); } catch (e) {} torchTrack = null; }
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    flashEl.style.backgroundColor = '#000'; lastBg = '#000';
    elLive.classList.add('hidden'); stopBtn.classList.add('hidden'); pill.classList.add('hidden');
    elLeft.classList.remove('hidden');
  }

  // expose for harness control
  window.__clsLeave = leave;
})();
