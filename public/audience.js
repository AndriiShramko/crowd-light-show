(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var AUTO = params.get('auto') === '1';        // headless auto-join (sync harness)
  var DEMO = params.get('demo') === '1';        // zero-setup looping demo (Try it)
  var DIAG = params.get('diag') === '1';        // show clock-sync diagnostics
  var JITTER = Math.max(0, Number(params.get('jitter') || 0)); // simulated inbound delay (ms)
  var ROOM = (function () { var r = params.get('room') || ''; return /^[a-z0-9]{6,24}$/.test(r) ? r : ''; })(); // studio demo room
  var AUDIO = params.get('audio') === '1'; // headless: auto opt-in to phone audio
  var JOIN_SPREAD = (AUTO || DEMO || ROOM) ? 0 : 800; // spread the join herd (stadium); off for tests/demo
  var env = null, waveEl = null, waveCtx = null, waveTick = 0; // music waveform + playhead
  var audio = null, audioOn = false, audioCaching = false, audioTrackId = null; // per-phone synchronized music (opt-in)

  // Live parametric preset engine (studio channel). Each phone renders the active
  // preset locally off the synced clock; switches are a tiny broadcast (epoch++).
  var P = window.CLS_PRESETS;
  var preset = null;        // { type, params, epoch, startedAt }
  var myIndex = 0, N = 1;   // sticky index in the crowd + grid width
  var backstop = P ? P.makeBackstop(150) : null; // client-side safety slew (defense in depth)
  var lastFrameT = 0;

  var flashEl = document.getElementById('flash');
  var stopBtn = document.getElementById('stopbtn');
  var pill = document.getElementById('statuspill');
  var elConsent = document.getElementById('consent');
  var elLive = document.getElementById('live');
  var elLeft = document.getElementById('left');
  var agree = document.getElementById('agree');
  var joinScreen = document.getElementById('joinScreen');
  var joinTorch = document.getElementById('joinTorch');
  var brightToast = document.getElementById('brightToast');

  // Test/telemetry hook (read by the Playwright sync harness). Every new path writes
  // here — it is the single machine-readable seam for verification.
  window.__cls = { flashes: [], lastBg: '#000', offset: 0, timeOrigin: performance.timeOrigin, status: 'idle', started: false, consented: false, everLit: false, colors: [],
    room: ROOM || 'main', idx: 0, total: 1, preset: null, presetRgb: null, presetPos: -1, presetEpoch: 0,
    synced: false, degraded: false, quality: null, audio: { wanted: false, ready: false, scheduled: false } };

  var ws = null, clock = null, timeline = null;
  var runState = { status: 'idle', T0: null, epoch: 0, pausePos: 0 };
  var wakeLock = null, torchTrack = null, torchOn = false, lastTorchAt = 0, useTorch = false;
  var lastBg = '#000', prevLum = 0, flashArmed = true;
  var demoMode = false, demoT0 = 0, demoLoopMs = 0, demoHasAudio = false; // landing demo (loops the admin track)
  var renderRunning = false; // the rAF loop starts once and survives leave()/rejoin

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
  var audioBtn = document.getElementById('audioBtn');
  if (audioBtn) audioBtn.addEventListener('click', enableAudio); // user gesture creates+resumes AudioContext

  if (AUTO) { agree.checked = true; joinScreen.disabled = false; setTimeout(function () { join(false); }, 50); }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && window.__cls.started) {
      acquireWake();
      if (clock) { clock.resync(); resyncBurst(); } // froze while backgrounded — re-converge (stays dark until ready)
      if (audio && audioOn) audio.resume();
    }
  });

  // Web pages CANNOT set screen brightness (no API on iOS/Android) — and auto-brightness
  // DIMS the phone in a dark venue. So we ask: a short self-dismissing reminder on join
  // (plus the consent-card instruction). Skipped for headless/auto so harnesses are unaffected.
  function showBrightToast() {
    if (AUTO || !brightToast) return;
    brightToast.textContent = i18n.t('bright_toast');
    brightToast.classList.remove('hidden');
    setTimeout(function () { brightToast.classList.add('hidden'); }, 4000);
  }
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
    showBrightToast();             // non-blocking reminder to max brightness (can't set it for them)
    requestFullscreen();
    acquireWake();
    if (withTorch) startTorch();
    initWave();
    // Spread the join thundering-herd at a stadium: stagger WS handshakes over a
    // window so thousands don't connect in the same instant (off for tests/demo).
    if (DEMO) demoAudioInit();    // create+resume the AudioContext IN this tap (autoplay policy)
    setTimeout(connect, Math.random() * JOIN_SPREAD);
    if (AUDIO) enableAudio(); // headless auto opt-in
    if (!renderRunning) { renderRunning = true; requestAnimationFrame(render); } // start once; survives rejoin
  }

  // A short burst of pings (join, and after a background-resume) to converge fast.
  function resyncBurst() {
    var n = 0; var p = setInterval(function () {
      if (!ws || ws.readyState !== 1) return;
      clock.ping(); if (++n >= 14) clearInterval(p); // ClockSync is "ready" at >=8 clean samples
    }, 80);
  }
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    clock = new ClockSync(function (o) { try { ws.send(JSON.stringify(o)); } catch (e) {} });
    ws.onopen = function () {
      ws.send(JSON.stringify({ t: 'hello', role: 'audience', room: ROOM || undefined, platform: isAndroid ? 'android' : (/iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'other') }));
      setStatus('st_sync');
      resyncBurst();
      // Steady re-sync every 20s — cheap (10x fewer frames than 3s at stadium scale),
      // still < the 25s server ping and < cellular NAT timeout. Drift over 20s is sub-ms.
      setInterval(function () { if (ws.readyState === 1) clock.ping(); }, 20000);
      if (DEMO) {
        fetch('/api/demo').then(function (r) { return r.json(); }).then(function (d) {
          timeline = d.timeline; demoT0 = d.T0; demoMode = true; demoLoopMs = d.timeline.durationMs; demoHasAudio = !!d.hasAudio;
          buildEnvelope(); setStatus('st_play');
          if (audio && demoHasAudio) startDemoAudio(); // play the admin track's music, looped + synced
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
    if (m.t === 'full') { window.__cls.full = true; setStatus('st_full'); try { ws.close(); } catch (e) {} setTimeout(connect, 3000 + Math.random() * 5000); return; } // venue full: backoff+jitter retry (no retry storm)
    if (m.t === 'sync') { clock.onReply(m.c0, m.s1); window.__cls.offset = clock.offset; window.__cls.synced = clock.ready; window.__cls.degraded = clock.degraded; window.__cls.quality = clock.quality; window.__cls.rtt = clock.rtt; if (clock.ready && runState.status === 'idle') setStatus('st_wait'); return; }
    if (m.t === 'welcome' || m.t === 'state') { if (m.state) applyState(m.state); return; }
    if (m.t === 'timeline') {
      timeline = m.data; window.__cls.gotTimeline = (timeline && timeline.cues || []).length; window.__cls.trackId = m.trackId; buildEnvelope();
      if (m.trackId !== audioTrackId) {                 // operator armed a DIFFERENT track
        audioTrackId = m.trackId;
        if (audio && audio.dropBuffer) audio.dropBuffer(); // drop the old track's cached audio so the new one is fetched
      }
      if (audioOn) cacheAudio(); showAudioBtn(); return;
    }
    if (m.t === 'start') { runState = { status: 'running', T0: m.T0, epoch: m.epoch, pausePos: 0 }; window.__cls.status = 'running'; window.__cls.gotStart = m.T0; prevLum = 0; flashArmed = true; if (audio && audioOn) audio.start(m.T0); setStatus('st_play'); showWave(); return; }
    if (m.t === 'pause') { runState.status = 'paused'; runState.pausePos = m.pos; window.__cls.status = 'paused'; if (audio) audio.stop(); setStatus('st_paused'); return; }
    if (m.t === 'stop') { runState = { status: 'idle', T0: null, epoch: m.epoch, pausePos: 0 }; preset = null; window.__cls.preset = null; window.__cls.status = 'idle'; if (audio) audio.stop(); hideWave(); setStatus('st_wait'); return; }
    if (m.t === 'blackout') { runState = { status: 'blackout', T0: null, epoch: m.epoch }; preset = null; window.__cls.preset = null; window.__cls.status = 'blackout'; if (audio) audio.stop(); hideWave(); return; }
    // ---- studio: live parametric presets ----
    if (m.t === 'index') { myIndex = m.index | 0; N = Math.max(1, m.total | 0); window.__cls.idx = myIndex; window.__cls.total = N; return; }
    if (m.t === 'preset') {
      if (m.type === 'off' || !P || !P.PRESETS[m.type]) { preset = null; window.__cls.preset = null; window.__cls.status = 'idle'; setStatus('st_wait'); return; }
      preset = { type: m.type, params: m.params || P.defaults(m.type), epoch: m.epoch | 0, startedAt: m.startedAt };
      window.__cls.preset = m.type; window.__cls.presetEpoch = preset.epoch; window.__cls.presetStartedAt = m.startedAt; window.__cls.status = 'running';
      prevLum = 0; flashArmed = true; setStatus('st_play'); return;
    }
    if (m.t === 'paramUpdate') {
      if (preset && m.epoch === preset.epoch) { preset.params[m.key] = m.value; } // epoch-gated, phase preserved
      return;
    }
  }

  function applyState(s) {
    runState.status = s.status; runState.T0 = s.T0; runState.epoch = s.epoch; runState.pausePos = s.pausePos || 0;
    window.__cls.status = s.status;
    prevLum = 0; flashArmed = true; // late-join: don't suppress the first legitimate flash
    if (s.status === 'running' && s.T0 != null && audio && audioOn) audio.start(s.T0); // late-join audio
  }

  // ---- per-phone synchronized music (opt-in) ----
  function showAudioBtn() {
    if (!audioBtn || ROOM || DEMO) return;            // only the main timeline show
    if (timeline && runState.status !== 'blackout') audioBtn.classList.remove('hidden');
  }
  function enableAudio() {
    if (audioOn || !window.AudioSync) return;
    audioOn = true; window.__cls.audio.wanted = true;
    if (audioBtn) { audioBtn.textContent = i18n.t('audio_on'); audioBtn.disabled = true; }
    audio = new AudioSync(clock || new ClockSync(function () {}));
    if (window.__forceLatComp) audio.compensateLatency = true;   // opt-in (heterogeneous fleet / harness)
    audio.tele = function (o) { for (var k in o) window.__cls.audio[k] = o[k]; };
    audio.init().then(function () { cacheAudio(); }).catch(function () {});
  }
  // Landing demo music: create+resume the AudioContext inside the Join tap (iOS autoplay),
  // then (once the track is fetched + clock synced) loop the admin track's audio in sync.
  function demoAudioInit() {
    if (audio || !window.AudioSync) return;
    audio = new AudioSync(null);
    audio.tele = function (o) { for (var k in o) window.__cls.audio[k] = o[k]; };
    window.__cls.audio.wanted = true;
    audio.init().catch(function () {});
  }
  function startDemoAudio() {
    if (!audio || audioCaching || audio.ready()) return;
    audio.clock = clock;
    audioCaching = true;
    fetch('/api/demo/audio?v=' + ((timeline && timeline.trackId) || '')).then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (ab) {
        audioCaching = false; if (!ab) return;
        return audio.cache(ab).then(function () {
          var tries = 0, w = setInterval(function () {        // start once the clock is synced
            if (clock && clock.ready) { clearInterval(w); audio.startLoop(demoT0, demoLoopMs); }
            else if (++tries > 200) clearInterval(w);
          }, 50);
        });
      })
      .catch(function () { audioCaching = false; });          // AAC may not decode headless -> lights-only (graceful)
  }
  function cacheAudio() {
    if (!audio || !audioOn || audio.ready() || audioCaching) return;
    audioCaching = true;
    // ?v=<trackId> busts the HTTP cache: the endpoint serves the ARMED track (same URL for
    // all), so without a per-track key the browser would replay the previous track's cached
    // audio when the operator arms a different one.
    fetch('/api/audience/audio?v=' + (audioTrackId == null ? '' : audioTrackId)).then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (ab) { audioCaching = false; if (!ab) return; return audio.cache(ab).then(function () {
        // if the show is already running, jump in at the right position now
        if (runState.status === 'running' && runState.T0 != null) audio.start(runState.T0);
      }); })
      .catch(function () { audioCaching = false; });
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

  // The music's governed loudness at the current TRACK position — the deterministic,
  // already-safe (<=3 fl/s) signal that makes presets react to the song while staying
  // perfectly in sync (every phone samples the same cue b at the same synced trackPos).
  // Neutral (level 0) whenever no track is running -> presets behave exactly as before.
  function sampleEnv() {
    if (!timeline || !timeline.cues || runState.T0 == null || runState.status !== 'running' || !(clock && clock.ready)) {
      return { level: 0, active: false, trackPos: -1 };
    }
    var trackPos = clock.serverNow() - runState.T0;
    if (trackPos < 0 || trackPos > timeline.durationMs) return { level: 0, active: false, trackPos: trackPos };
    return { level: sampleCue(trackPos).b, active: true, trackPos: trackPos };
  }

  function render() {
    requestAnimationFrame(render);
    window.__cls.ticks = (window.__cls.ticks || 0) + 1;
    var synced = !!(clock && clock.ready); window.__cls.synced = synced;
    var finalRgb = [0, 0, 0], flum = 0, pos = -1, playing = false, epochNow = runState.epoch;

    if (runState.status === 'blackout') {
      // operator BLACKOUT overrides everything — go dark immediately.
    } else if (preset && preset.type && P) {
      // STUDIO: render the active parametric preset locally off the synced clock.
      if (synced) {
        pos = clock.serverNow() - preset.startedAt;
        var env = sampleEnv();                          // music loudness at the synced track position
        var raw = P.PRESETS[preset.type](pos, preset.params, myIndex, N, env.level);
        finalRgb = P.clampColor(raw);                 // safety backstop #1: no saturated red
        var nowf = performance.now(); var dt = lastFrameT ? nowf - lastFrameT : 16; lastFrameT = nowf;
        if (backstop) finalRgb = backstop(finalRgb, dt); // safety backstop #2: >=150ms ramp / <=3 fl/s
        flum = P.relLum(finalRgb); playing = true; epochNow = preset.epoch;
        window.__cls.presetRgb = finalRgb; window.__cls.presetPos = Math.round(pos);
        window.__cls.envLevel = env.level; window.__cls.envActive = env.active; window.__cls.trackPos = Math.round(env.trackPos);
        setStatus('st_play');
      } else { setStatus('st_sync'); }
    } else {
      // TIMELINE (existing show): luminance + colour from the pre-baked cue list.
      var lum = 0, rgb = [0, 0, 0];
      if (timeline && runState.status === 'paused') {
        pos = runState.pausePos; var cp = sampleCue(pos); lum = cp.b; rgb = cp.rgb; playing = true;
      } else if (synced && demoMode && timeline) {
        var d = timeline.durationMs; pos = ((clock.serverNow() - demoT0) % d + d) % d; // loop forever
        var cd = sampleCue(pos); lum = cd.b; rgb = cd.rgb; playing = true;
      } else if (synced && timeline && runState.status === 'running') {
        pos = clock.serverNow() - runState.T0;
        if (pos > timeline.durationMs + 250) {
          // Track finished: end locally (go dark, hide the waveform) even before the
          // server's auto-stop arrives — the music is over, so stop flashing.
          runState.status = 'idle'; window.__cls.status = 'idle'; hideWave(); setStatus('st_wait');
        } else if (pos >= 0) { var c = sampleCue(pos); lum = c.b; rgb = c.rgb; playing = true; setStatus('st_play'); }
      } else if (!synced && (demoMode || runState.status === 'running')) {
        setStatus('st_sync'); // clock not converged yet → stay dark, don't flash out of sync
      }
      finalRgb = [Math.round(rgb[0] * lum), Math.round(rgb[1] * lum), Math.round(rgb[2] * lum)];
      flum = lum;
    }

    var bg = 'rgb(' + finalRgb[0] + ',' + finalRgb[1] + ',' + finalRgb[2] + ')';
    if (bg !== lastBg) {
      flashEl.style.backgroundColor = bg; lastBg = bg; window.__cls.lastBg = bg;
      if (bg !== 'rgb(0,0,0)') { window.__cls.everLit = true; if (window.__cls.colors.indexOf(bg) < 0 && window.__cls.colors.length < 40) window.__cls.colors.push(bg); }
    }
    if (playing) {
      if (flum < 0.25) flashArmed = true;
      else if (flum >= 0.6 && flashArmed) { flashArmed = false; window.__cls.flashes.push({ epoch: epochNow, pos: Math.round(pos), wall: performance.timeOrigin + performance.now() }); }
    }
    prevLum = flum;
    window.__cls.lastPos = Math.round(pos); window.__cls.maxLum = Math.max(window.__cls.maxLum || 0, flum);
    driveTorch(flum);
    if ((++waveTick % 5) === 0) { drawWave(playing && timeline ? pos : -1); if (DIAG) updateDiag(pos); }
  }

  // Small per-device waveform of the track's loudness envelope + a moving playhead,
  // so it's visible that the flashing follows THIS music at THIS moment.
  function buildEnvelope() {
    env = null;
    if (!timeline || !timeline.cues || !timeline.durationMs) return;
    var N = 200, dur = timeline.durationMs, a = new Array(N);
    for (var i = 0; i < N; i++) a[i] = sampleCue(i / N * dur).b;
    env = a; showWave();
  }
  function initWave() { waveEl = document.getElementById('wave'); if (waveEl) waveCtx = waveEl.getContext('2d'); }
  // Show/hide are decoupled from buildEnvelope so a RESTART can re-reveal the waveform.
  // The bug (round 8A): the track ends -> hideWave(); the operator presses GO again on the
  // SAME armed track -> the server sends only {t:'start'} (no fresh {t:'timeline'}, so
  // buildEnvelope is NOT called) -> the canvas stayed `hidden` forever until the phone app
  // was restarted. So {t:'start'} now calls showWave() too. env/waveEl survive a restart
  // (neither is nulled), so re-showing is safe.
  function showWave() { if (waveEl && env) waveEl.classList.remove('hidden'); window.__cls.waveHidden = waveEl ? waveEl.classList.contains('hidden') : null; }
  function hideWave() { if (waveEl) waveEl.classList.add('hidden'); window.__cls.waveHidden = waveEl ? waveEl.classList.contains('hidden') : null; }
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
    preset = null; runState.status = 'idle'; // opt-out is terminal: stop all rendering
    if (audio) { try { audio.teardown(); } catch (e) {} audio = null; audioOn = false; }
    try { if (ws) ws.close(); } catch (e) {}
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    if (torchTrack) { try { torchTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {} try { torchTrack.stop(); } catch (e) {} torchTrack = null; }
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    flashEl.style.backgroundColor = '#000'; lastBg = '#000';
    hideWave(); if (brightToast) brightToast.classList.add('hidden');
    elLive.classList.add('hidden'); stopBtn.classList.add('hidden'); pill.classList.add('hidden'); lastStatusKey = '';
    // Back to the main menu with consent ALREADY accepted — one tap to rejoin, no
    // re-checking the box (the user already agreed this session).
    agree.checked = true; joinScreen.disabled = false; joinTorch.disabled = false;
    elLeft.classList.add('hidden');
    elConsent.classList.remove('hidden');
  }

  // expose for harness control
  window.__clsLeave = leave;
})();
