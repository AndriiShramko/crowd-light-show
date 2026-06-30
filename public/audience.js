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
  var env = null, envTrackId = null, waveEl = null, waveCtx = null, waveTick = 0; // music waveform + playhead
  var audio = null, audioOn = false, audioCaching = false, audioTrackId = null; // per-phone synchronized music (opt-in)

  // Live parametric preset engine (studio channel). Each phone renders the active
  // preset locally off the synced clock; switches are a tiny broadcast (epoch++).
  var P = window.CLS_PRESETS;
  var preset = null;        // screen channel { type, params, epoch, startedAt }
  var torchPreset = null;   // torch channel (round 8B) — autonomous, independent of the screen
  var myIndex = 0, N = 1;   // sticky index in the crowd + grid width
  var backstop = P ? P.makeBackstop(150) : null; // client-side safety slew (defense in depth)
  var torchGate = (P && P.makeTorchGate) ? P.makeTorchGate() : null; // torch rate cap <=2.8/s (defense in depth)
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
    // round 8B: the two autonomous channels are independent readback seams (screen never moves the torch & vice-versa)
    screen: { preset: null, epoch: 0 }, torch: { preset: null, epoch: 0, on: 0, intensity: 0, capable: null, startedAt: 0 },
    synced: false, degraded: false, quality: null, audio: { wanted: false, ready: false, scheduled: false, preload: 'idle' } };

  var ws = null, clock = null, timeline = null;
  var runState = { status: 'idle', T0: null, epoch: 0, pausePos: 0 };
  var wakeLock = null, torchTrack = null, torchOn = false, lastTorchAt = 0, useTorch = false;
  var lastBg = '#000', prevLum = 0, flashArmed = true;
  var demoMode = false, demoT0 = 0, demoLoopMs = 0, demoHasAudio = false; // landing demo (loops the admin track)
  var renderRunning = false; // the rAF loop starts once and survives leave()/rejoin

  // ---- round 11 (phase D): robustness. ONE reconnect controller + SINGLETON timers + crash guards.
  // The server fully rehydrates a freshly-connected phone (welcome+state+preset+timeline+index), and
  // the show runs locally off the synced clock, so a reconnect just re-runs connect(). Every retry/
  // timer routes through here so visibility/online/offline can't triple-fire a storm (= the crash).
  var reconnectTimer = null, resyncTimer = null, pingTimer = null, reconnectAttempts = 0;
  window.__cls.errors = 0; window.__cls.reconnects = 0; window.__cls.connectAttempts = 0; window.__cls.wsState = -1; window.__cls.flashCount = 0; window.__cls.timers = 0;
  function setTimerCount() { window.__cls.timers = (pingTimer ? 1 : 0) + (resyncTimer ? 1 : 0) + (reconnectTimer ? 1 : 0); }
  function noteError() { window.__cls.errors++; if (window.__cls.errors > 50) window.__cls.degradedErr = true; } // past a threshold: stop trusting, don't loop
  window.addEventListener('error', function () { noteError(); }); // count; the rAF re-arm + try/catch already keep the loop alive
  window.addEventListener('unhandledrejection', function (e) { noteError(); try { if (e && e.preventDefault) e.preventDefault(); } catch (x) {} }); // suppress the flood that wedges the tab
  // Record a flash into a CAPPED ring-buffer (a multi-hour show would otherwise grow the array
  // unbounded -> memory pressure -> crash). flashCount is a monotonic counter the harness reads.
  function recordFlash(epoch, pos) {
    window.__cls.flashCount++;
    var fl = window.__cls.flashes; fl.push({ epoch: epoch, pos: pos, wall: performance.timeOrigin + performance.now() });
    if (fl.length > 200) fl.shift();
  }
  function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; setTimerCount(); } }
  function scheduleReconnect() {
    if (!window.__cls.started) return;          // user left -> never reconnect
    if (reconnectTimer) return;                 // already scheduled (debounce — no storm)
    var delay = Math.min(500 * Math.pow(2, reconnectAttempts), 15000) + Math.random() * 500;
    reconnectAttempts++;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; setTimerCount(); connect(); }, delay);
    setTimerCount();
  }
  function reconnectNow() {                      // online/visibility: skip the backoff wait, ONE path
    if (!window.__cls.started) return;
    if (ws && ws.readyState === 1) return;       // already connected
    clearReconnect(); connect();
  }
  window.addEventListener('online', function () { if (window.__cls.started) reconnectNow(); });
  window.addEventListener('offline', function () { if (window.__cls.started) { setStatus('st_conn'); clearReconnect(); } });

  var isAndroid = /Android/i.test(navigator.userAgent);
  var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  // iOS has NO web torch API (WebKit) -> torch impossible; Android may have it (camera LED).
  var canTryTorch = isAndroid && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  window.__cls.torch.capable = canTryTorch ? null : false; // false on iOS/desktop; null=unknown until probed (Android)
  if (isIOS) window.__cls.torch.note = 'ios-screen-only';  // iPhone: torch channel is a no-op; screen is the light
  if (canTryTorch) joinTorch.classList.remove('hidden');

  agree.addEventListener('change', function () {
    joinScreen.disabled = !agree.checked; joinTorch.disabled = !agree.checked;
  });
  joinScreen.addEventListener('click', function () { join(false); });
  joinTorch.addEventListener('click', function () { join(true); });
  stopBtn.addEventListener('click', leave);
  document.getElementById('rejoin').addEventListener('click', function () { location.reload(); });
  var audioBtn = document.getElementById('audioBtn');
  // round 10: in a STUDIO room (or the demo) music streams automatically, so the button is a
  // MUTE toggle; on the main timeline show it stays the opt-in "tap for sound" enable button.
  if (audioBtn) audioBtn.addEventListener('click', function () { if (ROOM || DEMO) toggleMute(); else enableAudio(); });

  if (AUTO) { agree.checked = true; joinScreen.disabled = false; setTimeout(function () { join(false); }, 50); }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !window.__cls.started) return;
    acquireWake();
    if (!ws || ws.readyState !== 1) { reconnectNow(); return; } // socket died while backgrounded -> ONE reconnect path
    if (clock) { clock.resync(); resyncBurst(); } // froze while backgrounded — re-converge (stays dark until ready)
    if (audio && audioOn) audio.resume();
  });

  // Web pages CANNOT set screen brightness (no API on iOS/Android) — and auto-brightness
  // DIMS the phone in a dark venue. So we ask: a short self-dismissing reminder on join
  // (plus the consent-card instruction). Skipped for headless/auto so harnesses are unaffected.
  function showBrightToast() {
    if (AUTO || !brightToast) return;
    var msg = i18n.t('bright_toast');
    if (isIOS) msg += ' · ' + i18n.t('ios_torch');   // honest: no web torch on iPhone — the screen is the light
    brightToast.textContent = msg;
    brightToast.classList.remove('hidden');
    setTimeout(function () { brightToast.classList.add('hidden'); }, isIOS ? 6000 : 4000);
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
    else if (ROOM) roomAudioInit(); // round 10: a studio room ALWAYS streams its music — start the AudioContext in THIS tap (the only gesture), then auto-play when the timeline arrives
    setTimeout(connect, Math.random() * JOIN_SPREAD);
    if (AUDIO) enableAudio(); // headless auto opt-in
    if (!renderRunning) { renderRunning = true; requestAnimationFrame(render); } // start once; survives rejoin
  }

  // A short burst of pings (join, and after a background-resume) to converge fast. SINGLETON:
  // a second burst clears the first, so reconnects/visibility can't stack 80ms intervals.
  function resyncBurst() {
    if (resyncTimer) { clearInterval(resyncTimer); resyncTimer = null; }
    var n = 0;
    resyncTimer = setInterval(function () {
      if (!ws || ws.readyState !== 1) return;
      if (clock) clock.ping(); if (++n >= 14) { clearInterval(resyncTimer); resyncTimer = null; setTimerCount(); } // ready at >=8 clean samples
    }, 80);
    setTimerCount();
  }
  // SINGLETON steady 20s re-sync (was created inside ws.onopen -> stacked one per reconnect).
  function startSteadyPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    pingTimer = setInterval(function () { if (ws && ws.readyState === 1 && clock) clock.ping(); }, 20000);
    setTimerCount();
  }
  function connect() {
    window.__cls.connectAttempts++;
    // reentrant-safe: detach the old socket so its late onclose can't start a SECOND reconnect chain.
    if (ws) { try { ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; ws.close(); } catch (e) {} ws = null; }
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(proto + '://' + location.host + '/ws'); }
    catch (e) { noteError(); scheduleReconnect(); return; } // never throw out of connect (offline open)
    window.__cls.wsState = 0;
    clock = new ClockSync(function (o) { try { ws.send(JSON.stringify(o)); } catch (e) {} });
    ws.onopen = function () {
      window.__cls.wsState = 1;
      if (reconnectAttempts > 0) window.__cls.reconnects++; // a drop was recovered
      reconnectAttempts = 0;
      if (audio) audio.clock = clock; // wire the freshly-created synced clock into an AudioSync built in the join tap (room/demo)
      if (clock) clock.resync();      // hold dark until reconverged (a gap left the offset stale)
      ws.send(JSON.stringify({ t: 'hello', role: 'audience', room: ROOM || undefined, platform: isAndroid ? 'android' : (/iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'other') }));
      setStatus('st_sync');
      resyncBurst();
      startSteadyPing();              // SINGLETON (was a fresh setInterval per onopen -> stacked on every reconnect)
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
    ws.onclose = function () {
      window.__cls.wsState = 3;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; setTimerCount(); } // stop pinging a dead socket
      if (!window.__cls.started) return;   // user left via leave() -> do not reconnect
      setStatus('st_conn');                // timeline keeps running locally off the synced clock
      ws = null; scheduleReconnect();      // auto-reconnect with bounded backoff (server rehydrates on reopen)
    };
    ws.onerror = function () { noteError(); /* onclose follows and schedules the reconnect */ };
  }

  function onMsg(raw) {
    var m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'full') { window.__cls.full = true; setStatus('st_full'); reconnectAttempts = 5; try { ws.close(); } catch (e) {} return; } // venue full: onclose -> scheduleReconnect with a long (~15s) backoff (ONE path, no storm)
    if (m.t === 'sync') { clock.onReply(m.c0, m.s1); window.__cls.offset = clock.offset; window.__cls.synced = clock.ready; window.__cls.degraded = clock.degraded; window.__cls.quality = clock.quality; window.__cls.rtt = clock.rtt; if (clock.ready && runState.status === 'idle') setStatus('st_wait'); return; }
    if (m.t === 'welcome' || m.t === 'state') { if (m.state) applyState(m.state); return; }
    if (m.t === 'timeline') {
      timeline = m.data; window.__cls.gotTimeline = (timeline && timeline.cues || []).length; window.__cls.trackId = m.trackId; buildEnvelope();
      if (m.trackId !== audioTrackId) {                 // operator armed a DIFFERENT track
        audioTrackId = m.trackId;
        if (audio && audio.dropBuffer) audio.dropBuffer(); // drop the old track's cached audio so the new one is fetched
      }
      if (audioOn) cacheAudio(); else preloadAudio(); // round 11: pre-fetch+decode before the tap (main show)
      showAudioBtn(); return;
    }
    if (m.t === 'start') { runState = { status: 'running', T0: m.T0, epoch: m.epoch, pausePos: 0, loop: !!m.loop }; window.__cls.status = 'running'; window.__cls.gotStart = m.T0; window.__cls.loop = !!m.loop; prevLum = 0; flashArmed = true; if (audio && audioOn) playRoomAudio(m.T0); setStatus('st_play'); showWave(); return; }
    if (m.t === 'pause') { runState.status = 'paused'; runState.pausePos = m.pos; window.__cls.status = 'paused'; if (audio) audio.stop(); setStatus('st_paused'); return; }
    if (m.t === 'stop') { runState = { status: 'idle', T0: null, epoch: m.epoch, pausePos: 0 }; preset = null; torchPreset = null; window.__cls.preset = null; window.__cls.screen.preset = null; window.__cls.torch.preset = null; window.__cls.status = 'idle'; if (audio) audio.stop(); hideWave(); setStatus('st_wait'); return; }
    if (m.t === 'blackout') { runState = { status: 'blackout', T0: null, epoch: m.epoch }; preset = null; torchPreset = null; window.__cls.preset = null; window.__cls.screen.preset = null; window.__cls.torch.preset = null; window.__cls.status = 'blackout'; if (audio) audio.stop(); hideWave(); return; }
    // ---- studio: live parametric presets ----
    if (m.t === 'index') { myIndex = m.index | 0; N = Math.max(1, m.total | 0); window.__cls.idx = myIndex; window.__cls.total = N; return; }
    if (m.t === 'marquee') { // round 11 (pt 19): scrolling text overlay — text ONLY, never touches the flash/preset/run-state
      var mq = document.getElementById('marquee'), inner = document.getElementById('marqueeInner');
      var txt = String(m.text || '').slice(0, 200); window.__cls.marquee = txt;
      if (mq && inner) { if (!txt) { mq.classList.add('hidden'); inner.textContent = ''; } else { inner.textContent = txt; mq.classList.remove('hidden'); } }
      return;
    }
    if (m.t === 'preset') {
      if (m.channel === 'torch') {                 // round 8B: autonomous torch channel — never touches the screen
        if (m.type === 'off' || !P || !P.TORCH_PRESETS || !P.TORCH_PRESETS[m.type]) { torchPreset = null; window.__cls.torch.preset = null; window.__cls.torch.epoch = m.epoch | 0; return; }
        torchPreset = { type: m.type, params: m.params || (P.torchDefaults ? P.torchDefaults(m.type) : {}), epoch: m.epoch | 0, startedAt: m.startedAt };
        window.__cls.torch.preset = m.type; window.__cls.torch.epoch = torchPreset.epoch; window.__cls.torch.startedAt = m.startedAt; return;
      }
      if (m.type === 'off' || !P || !P.PRESETS[m.type]) { preset = null; window.__cls.preset = null; window.__cls.screen.preset = null; window.__cls.status = 'idle'; setStatus('st_wait'); return; }
      preset = { type: m.type, params: m.params || P.defaults(m.type), epoch: m.epoch | 0, startedAt: m.startedAt };
      window.__cls.preset = m.type; window.__cls.screen.preset = m.type; window.__cls.screen.epoch = preset.epoch; window.__cls.presetEpoch = preset.epoch; window.__cls.presetStartedAt = m.startedAt; window.__cls.status = 'running';
      prevLum = 0; flashArmed = true; setStatus('st_play'); return;
    }
    if (m.t === 'paramUpdate') {
      if (m.channel === 'torch') { if (torchPreset && m.epoch === torchPreset.epoch) torchPreset.params[m.key] = m.value; return; }
      if (preset && m.epoch === preset.epoch) { preset.params[m.key] = m.value; } // epoch-gated, phase preserved
      return;
    }
  }

  function applyState(s) {
    runState.status = s.status; runState.T0 = s.T0; runState.epoch = s.epoch; runState.pausePos = s.pausePos || 0; runState.loop = !!s.loop;
    window.__cls.status = s.status; window.__cls.loop = !!s.loop;
    prevLum = 0; flashArmed = true; // late-join: don't suppress the first legitimate flash
    if (s.status === 'running' && s.T0 != null && audio && audioOn) playRoomAudio(s.T0); // late-join audio
  }
  // Round 12 (pt 2): pick the audio engine. A LOOPING room (a /studio playlist) uses the SEAMLESS
  // fixed-anchor loop the /try demo uses (startLoop) — its tight corrector holds sync to end-of-song
  // and never lets the gentle one-shot trim slide the whole group off the lights. A non-looping show
  // (main show, plays once) keeps the one-shot start(). The loop period == the track's duration.
  function playRoomAudio(T0) {
    if (!audio) return;
    if (runState.loop && timeline && timeline.durationMs) audio.startLoop(T0, timeline.durationMs);
    else audio.start(T0);
  }

  // ---- per-phone synchronized music ----
  var muted = false;
  function showAudioBtn() {
    if (!audioBtn) return;
    if (ROOM || DEMO) {                               // round 10: music auto-on -> the button is a MUTE toggle
      if (window.__cls.audio.lightsOnly) { audioBtn.classList.add('hidden'); return; } // nothing to mute (guest upload / decode-fail)
      audioBtn.classList.remove('hidden'); updateMuteBtn(); return;
    }
    if (timeline && runState.status !== 'blackout') updateAudioBtn(); // main show: opt-in enable button + preload status
  }
  // round 11 (pt 15): the main-show audio button reflects the PRELOAD state so the user isn't left
  // tapping into a blank wait — "Connecting to music…" while it fetches+decodes, then tappable.
  function updateAudioBtn() {
    if (!audioBtn || ROOM || DEMO) return;
    var pl = window.__cls.audio.preload;
    if (pl === 'lightsOnly') { audioBtn.classList.add('hidden'); return; } // no served audio -> honest, hide it
    audioBtn.classList.remove('hidden');
    if (audioOn) { audioBtn.textContent = i18n.t('audio_on'); audioBtn.disabled = true; return; }
    if (pl === 'fetching' || pl === 'decoding') { audioBtn.textContent = i18n.t('audio_connecting'); audioBtn.disabled = true; }
    else { audioBtn.textContent = i18n.t('audio_btn'); audioBtn.disabled = false; } // 'ready' or 'idle' -> tappable (instant when ready)
  }
  // Fetch+decode the main-show track BEFORE the tap (decode needs no gesture), so the tap is instant.
  function preloadAudio() {
    if (DEMO || ROOM || !window.AudioSync || !timeline) return; // room/demo build the ctx in the join tap
    if (!audio) { audio = new AudioSync(clock || new ClockSync(function () {})); if (window.__forceLatComp) audio.compensateLatency = true; audio.tele = function (o) { for (var k in o) window.__cls.audio[k] = o[k]; }; }
    if (clock) audio.clock = clock;
    if (audio.ready() || audioCaching) { updateAudioBtn(); return; }
    if (!audio.ensureCtx || !audio.ensureCtx()) { window.__cls.audio.preload = 'error'; return; } // no WebAudio -> stay opt-in
    audioCaching = true; window.__cls.audio.preload = 'fetching'; updateAudioBtn();
    fetch('/api/audience/audio?v=' + (audioTrackId == null ? '' : audioTrackId)).then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (ab) {
        if (!ab) { audioCaching = false; window.__cls.audio.preload = 'lightsOnly'; window.__cls.audio.lightsOnly = true; updateAudioBtn(); return; }
        window.__cls.audio.preload = 'decoding'; updateAudioBtn();
        return audio.cache(ab).then(function () {
          audioCaching = false; window.__cls.audio.preload = 'ready'; window.__cls.audio.lightsOnly = false; updateAudioBtn();
          if (audioOn && runState.status === 'running' && runState.T0 != null) playRoomAudio(runState.T0); // already opted-in: jump in now
        });
      })
      .catch(function () { audioCaching = false; window.__cls.audio.preload = 'error'; updateAudioBtn(); });
  }
  function updateMuteBtn() {
    if (!audioBtn || !(ROOM || DEMO)) return;
    audioBtn.disabled = false;
    audioBtn.textContent = muted ? i18n.t('audio_unmute') : i18n.t('audio_mute');
  }
  function toggleMute() {
    muted = !muted;
    if (audio) audio.setVolume(muted ? 0 : 0.85);
    window.__cls.audio.muted = muted;
    updateMuteBtn();
  }
  // Studio room: build + resume the AudioContext INSIDE the join tap (iOS autoplay), mark audio on.
  // The synced clock is wired in on ws.onopen; the room's music is fetched + played when its
  // timeline/start arrive (see cacheAudio + the start handler).
  function roomAudioInit() {
    if (audio || !window.AudioSync) return;
    audioOn = true; window.__cls.audio.wanted = true;
    audio = new AudioSync(clock || new ClockSync(function () {}));
    if (window.__forceLatComp) audio.compensateLatency = true;
    audio.tele = function (o) { for (var k in o) window.__cls.audio[k] = o[k]; };
    audio.init().catch(function () {});
  }
  function enableAudio() {
    if (audioOn || !window.AudioSync) return;
    audioOn = true; window.__cls.audio.wanted = true;
    if (!audio) { audio = new AudioSync(clock || new ClockSync(function () {})); if (window.__forceLatComp) audio.compensateLatency = true; audio.tele = function (o) { for (var k in o) window.__cls.audio[k] = o[k]; }; } // reuse a preloaded instance
    if (clock) audio.clock = clock;
    updateAudioBtn();
    // tap = the gesture: resume the (possibly preloaded) context, then play immediately if the buffer
    // is already decoded; otherwise fall back to fetch-in-the-tap.
    audio.init().then(function () {
      if (audio.ready()) { if (runState.status === 'running' && runState.T0 != null) playRoomAudio(runState.T0); }
      else cacheAudio();
    }).catch(function () {});
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
    if (clock) audio.clock = clock;   // ensure the live synced clock (room/demo AudioSync was built in the tap before connect())
    audioCaching = true;
    // A STUDIO room streams ITS room's armed track (room-audio, room from the URL); the main timeline
    // show streams the global armed track. ?v=<trackId> busts the HTTP cache so arming a different
    // track doesn't replay the previous one. A guest upload / decode-fail yields no audio -> the
    // phone honestly stays lights-only (we never claim sound we don't have).
    var url = ROOM
      ? ('/api/audience/room-audio?room=' + encodeURIComponent(ROOM) + '&v=' + (audioTrackId == null ? '' : audioTrackId))
      : ('/api/audience/audio?v=' + (audioTrackId == null ? '' : audioTrackId));
    fetch(url).then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (ab) {
        audioCaching = false;
        if (!ab) { window.__cls.audio.lightsOnly = true; showAudioBtn(); return; } // lights-only (no served audio)
        window.__cls.audio.lightsOnly = false;
        return audio.cache(ab).then(function () {
          showAudioBtn();
          // if the show is already running, jump in at the right position now (loop-aware: pt 2)
          if (runState.status === 'running' && runState.T0 != null) playRoomAudio(runState.T0);
        });
      })
      .catch(function () { audioCaching = false; window.__cls.audio.lightsOnly = true; showAudioBtn(); });
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
    requestAnimationFrame(render); // re-arm FIRST so a throw below never kills the loop
    try {
    window.__cls.ticks = (window.__cls.ticks || 0) + 1;
    var synced = !!(clock && clock.ready); window.__cls.synced = synced;
    var finalRgb = [0, 0, 0], flum = 0, pos = -1, playing = false, epochNow = runState.epoch;
    var nowf = performance.now(); var dt = lastFrameT ? nowf - lastFrameT : 16; lastFrameT = nowf;
    var musicLevel = sampleEnv();                       // governed loudness once — shared by screen + torch

    if (runState.status === 'blackout') {
      // operator BLACKOUT overrides everything — go dark immediately.
    } else if (preset && preset.type && P) {
      // STUDIO: render the active parametric preset locally off the synced clock.
      if (synced) {
        pos = clock.serverNow() - preset.startedAt;
        var env = musicLevel;                           // music loudness at the synced track position
        var raw = P.PRESETS[preset.type](pos, preset.params, myIndex, N, env.level);
        finalRgb = P.clampColor(raw);                 // safety backstop #1: no saturated red
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
      } else if (synced && timeline && runState.loop && timeline.durationMs) {
        // round 12 (pt 2): a looping /studio room runs lights on ONE fixed anchor, modulo the track
        // duration — exactly like the /try demo — so lights + the seamless-looped audio share one
        // clock and never drift apart by end-of-song. The track never "ends" here; STOP clears it.
        var dl = timeline.durationMs; pos = ((clock.serverNow() - runState.T0) % dl + dl) % dl;
        var cl = sampleCue(pos); lum = cl.b; rgb = cl.rgb; playing = true; setStatus('st_play');
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
      else if (flum >= 0.6 && flashArmed) { flashArmed = false; recordFlash(epochNow, Math.round(pos)); }
    }
    prevLum = flum;
    window.__cls.lastPos = Math.round(pos); window.__cls.maxLum = Math.max(window.__cls.maxLum || 0, flum);
    driveTorchChannel(dt, synced, musicLevel.level);
    // round 11 (pt 8): draw the playhead from the AUDIO cursor when sound is live, so the lit bar
    // matches what's HEARD (even across a reseat/slew); fall back to the show clock for lights-only.
    // The audio cursor is the position in the CURRENTLY DECODED buffer = the current track, so it
    // can't point into a different/stale track's envelope.
    var wavePos = pos, waveFromAudio = false;
    if (audio && audio.isLive && audio.isLive()) { var pm = audio.playedMs ? audio.playedMs() : null; if (pm != null && pm >= 0) { wavePos = pm; waveFromAudio = true; } }
    // round 12 (pt 3): the audio cursor (playedMs) grows monotonically and a looped buffer plays past
    // the track length, so without this the playhead pinned to the right edge and stayed there on every
    // loop. Wrap it modulo the track duration so it snaps back to the start each pass (lights + demo too).
    if (timeline && timeline.durationMs && wavePos >= 0) { var wd = timeline.durationMs; wavePos = ((wavePos % wd) + wd) % wd; }
    window.__cls.wavePos = Math.round(wavePos); window.__cls.waveFromAudio = waveFromAudio; // test seam (pt 8)
    if ((++waveTick % 5) === 0) { drawWave(playing && timeline ? wavePos : -1); if (DIAG) updateDiag(pos); }
    } catch (e) { noteError(); /* this frame degrades to whatever was last painted; the loop survives */ }
  }

  // ---- TORCH CHANNEL (round 8B): autonomous from the screen. Computes the torch intensity
  // from the torch preset (off when none / on STOP / BLACKOUT), gates it to <=2.8/s, and drives
  // the camera LED. On iOS there is no torchTrack -> applyTorch is a no-op and the screen is
  // untouched. The torch reads the SAME governed loudness as the screen so 'beat' stays in sync.
  function driveTorchChannel(dt, synced, level) {
    var wantOn = false, intensity = 0;
    if (runState.status !== 'blackout' && torchPreset && torchPreset.type && P && P.TORCH_PRESETS && P.TORCH_PRESETS[torchPreset.type] && synced) {
      var tpos = clock.serverNow() - torchPreset.startedAt;
      intensity = P.TORCH_PRESETS[torchPreset.type](tpos, torchPreset.params, myIndex, N, level);
      wantOn = intensity >= 0.5;
    }
    var gatedOn = torchGate ? torchGate(wantOn, dt) : wantOn; // hard <=2.8/s cap, independent of the screen gate
    window.__cls.torch.intensity = intensity; window.__cls.torch.want = gatedOn ? 1 : 0; // channel intent (gated)
    applyTorch(gatedOn);
  }
  function applyTorch(on) {
    if (!torchTrack) { window.__cls.torch.on = 0; window.__cls.torch.capable = canTryTorch ? window.__cls.torch.capable : false; return; } // iOS/no-LED: NO-OP, LED stays off, screen unaffected
    window.__cls.torch.capable = true;
    var nowt = performance.now();
    if (!!on !== torchOn && nowt - lastTorchAt > 60) {   // only hit applyConstraints on a real change (it's slow)
      torchOn = !!on; lastTorchAt = nowt;
      torchTrack.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
    }
    window.__cls.torch.on = torchOn ? 1 : 0;   // ACTUAL LED state (only ever non-zero with a real torchTrack)
  }

  // Small per-device waveform of the track's loudness envelope + a moving playhead,
  // so it's visible that the flashing follows THIS music at THIS moment.
  function buildEnvelope() {
    env = null; envTrackId = null; window.__cls.waveTrackId = null; // clear so a stale track's bars never draw during a switch
    if (!timeline || !timeline.cues || !timeline.durationMs) return;
    envTrackId = (typeof timeline.trackId !== 'undefined') ? timeline.trackId : (window.__cls.trackId != null ? window.__cls.trackId : null);
    window.__cls.waveTrackId = envTrackId;
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

  // --- torch acquisition (Android only). hasWebTorch probe: getUserMedia(env) -> getCapabilities().torch.
  // The torch is then driven by the AUTONOMOUS torch channel (driveTorchChannel), NOT the screen.
  function startTorch() {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      var track = stream.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps && caps.torch) { torchTrack = track; window.__cls.torch.capable = true; setStatus('st_ready_t'); }
      else { track.stop(); useTorch = false; window.__cls.torch.capable = false; } // Android, but no torch-capable LED
    }).catch(function () { useTorch = false; window.__cls.torch.capable = false; });
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
  window.__clsToggleMute = toggleMute; // round 11: assert mute-with-no-audio never throws
  window.__clsRecordFlash = recordFlash; // round 11: exercise the flash ring-buffer cap deterministically
  window.__clsDropWs = function () { try { if (ws) ws.close(); } catch (e) {} }; // round 11: simulate a radio drop (Playwright setOffline can't kill an open WS)
})();
