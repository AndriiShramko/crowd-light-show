(function () {
  'use strict';
  // ROUND 9: ONE operator component drives BOTH consoles, parameterized by __SESSION__.
  //   personal (/operator): authed, full features, transport over the operator WS, MAIN room.
  //   public   (/studio)  : no auth, a console token bound to one ephemeral room; transport
  //                         over HTTP /api/console/*; joins its room as a synced previewer.
  // Every operator-only assumption (applications, upload, nudge persist, operator WS commands)
  // is gated on the session mode/features — the public branch can NEVER reach /api/operator/*.
  var S = window.__SESSION__ || { mode: 'personal', token: window.__TOKEN__, apiBase: '/api/operator', lead: window.__LEAD__, features: { applications: true, upload: true, torch: true, transport: true, publicConfig: true } };
  var MODE = S.mode || 'personal';
  var PUBLIC = MODE === 'public';
  var TOKEN = S.token;
  var APIB = S.apiBase || '/api/operator';
  var ROOM = S.room || null;
  var FEAT = S.features || {};
  var DEFAULTS = S.defaults || {};
  var LEAD_MS = Number(S.lead) || 900;
  var ws = null, clock = null, armedId = null, audioReady = false, nudge = 0, curState = 'idle';
  var pendingGo = false, goWatcher = null; // GO deferred until the operator clock locks (personal)
  var pubT0 = null, pubTrackId = null, soundOn = false; // public: armed-track audio T0 + opt-in sound
  var audio = null, audioBuf = null;                    // AudioSync + the armed track's raw bytes (decoded lazily)
  var wantLiveAudio = false, lastAudioT0 = null;        // personal: drive audio start off the running-state echo
  var plMode = (DEFAULTS && DEFAULTS.playlist_mode) || 'all', plNow = null, plNext = null, plSelected = []; // round 10 playlist (public)
  var pubTracks = [];                                   // last-loaded public track list (for now/next titles + selected checkboxes)
  var consoleTimeline = null, lastT0 = null;            // round 13 (pt 4): armed track's cues + running T0, so the Live preview reacts to the REAL music
  var player = document.getElementById('player');

  // ROUND 9 AUDIO FIX: the console's lights were already synced (T0 carries clock.offset+nudge),
  // but the SOUND was started with a bare setTimeout(LEAD) — ignoring offset+nudge — so the
  // console's monitor drifted from the on-air audio by exactly offset+nudge. Now the console plays
  // through AudioSync.start(T0) on the SAME show clock as the phones (the visible <audio> is muted
  // during live and kept only for off-air scrubbing). HONEST: __opAudio.scheduledShowInstant is a
  // SCHEDULE instant (<=50ms to the phones), not acoustics — the operator still hears their own speaker.
  window.__opAudio = { mode: MODE, ready: false, scheduled: false, scheduledShowInstant: null, soundShowInstant: null, T0: null, driftMs: 0 };
  function ensureAudio() {
    if (!audio && window.AudioSync) {
      audio = new AudioSync(clock || new ClockSync(function () {}));
      audio.tele = function (o) { for (var k in o) window.__opAudio[k] = o[k]; };
    }
    if (audio && clock) audio.clock = clock;
    return audio;
  }
  // Align the console's audio to a running show T0 (covers GO and RESUME — both echo a running
  // state with the authoritative T0). Decode is done ahead on arm, so this is immediate.
  function syncLiveAudio(state) {
    var a = ensureAudio(); if (!a) return;
    if (state && state.status === 'running' && state.T0 != null && wantLiveAudio) {
      if (lastAudioT0 === state.T0) return; // already aligned to this T0
      lastAudioT0 = state.T0;
      if (a.ready()) a.start(state.T0); else a._pendingT0 = state.T0; // start once the buffer decodes
      window.__opAudio.T0 = state.T0;
    } else { a.stop(); lastAudioT0 = null; }
  }

  var $ = function (id) { return document.getElementById(id); };
  // round 11 (pt 20): console i18n. CLSI18N (site-i18n.js) is the SHARED layer — the same cls_lang
  // the visitor picked on the landing carries through. tr() returns the active-language string,
  // falling back to the English literal if CLSI18N is absent or the key is missing (so the console
  // is never broken by i18n). Static chrome carries data-i18n (applied by site-i18n.js); only the
  // JS-driven dynamic strings (Start/Pause, mute, state) go through tr() + the langchange re-render.
  function tr(key, fallback) { try { if (window.CLSI18N) { var v = window.CLSI18N.t(key); if (v) return v; } } catch (e) {} return fallback; }
  function api(path, opts) {
    opts = opts || {}; opts.headers = Object.assign({ Authorization: 'Bearer ' + TOKEN }, opts.headers || {});
    // A personal-mode path /api/operator/X maps to the public console /api/console/X.
    var p = (APIB !== '/api/operator') ? path.replace('/api/operator', APIB) : path;
    return fetch(p, opts);
  }
  function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }); }

  // ---- GA4 events (round 10): answer the owner's "how many tests / how many people per session
  // / how long is a session". window.clsGA is a no-op until the visitor accepts the cookie banner.
  var gaRoom = ROOM || 'main', gaPeak = 0, gaT0 = null;
  function ga(ev, p) { try { if (window.clsGA) window.clsGA(ev, Object.assign({ room_id: gaRoom, operator_mode: MODE }, p || {})); } catch (e) {} }
  function gaPeakUpdate(n) { n = n | 0; if (n > gaPeak) gaPeak = n; }
  function gaShowStarted(trackId) { gaT0 = Date.now(); ga('show_started', { track_id: trackId == null ? '' : trackId, preset_type: activeType || '' }); }
  function gaShowStopped() { if (gaT0 == null) return; ga('show_stopped', { duration_sec: Math.round((Date.now() - gaT0) / 1000), peak_phones: gaPeak, track_id: armedId == null ? '' : armedId }); gaT0 = null; gaPeak = 0; }

  // ---- mode setup: hide features this session doesn't have, switch labels (round 11: the block
  // ORDER is now static HTML — applyMode only gates visibility + relabels, no imperative reorder) ----
  function applyMode() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-feature]'), function (el) {
      var f = el.getAttribute('data-feature');
      if (FEAT[f] === false || FEAT[f] === undefined) el.classList.add('hidden');
    });
    // Join URL: public has no /api/operator/state to fill #joinurl, so derive it from the signed room.
    if (PUBLIC && ROOM) {
      var ju = location.origin + '/join?room=' + ROOM;
      var jl = $('joinurl'); if (jl) { jl.textContent = ju; jl.href = ju; }
      var jb = $('joinBig'); if (jb) jb.textContent = ju;
    }
    if (PUBLIC) {
      var title = $('consoleTitle'); if (title) title.textContent = (S.brand || 'Light Show') + tr('console.title_suffix', ' — live console');
      var pw = $('pubWelcome'); if (pw) { pw.textContent = S.welcome || tr('console.welcome_default', 'Tap “Start Light Show”, then share the code so phones join — they hear the music automatically. It is free; anyone can run their own.'); pw.classList.remove('hidden'); }
      var pcc = $('pubCount'); if (pcc) pcc.classList.remove('hidden');
      var ph = $('playlistHint'); if (ph) ph.classList.remove('hidden');
      if (FEAT.upload) { var ub = $('upload'); if (ub) ub.textContent = tr('console.use_my_music', 'Use my music'); }
      ['player', 'soundBtn'].forEach(function (id) { var e = $(id); if (e) e.classList.add('hidden'); }); // dead native <audio> + old sound btn
      var con = $('opConsole'); if (con) con.classList.add('pre-start'); // progressive disclosure: only Start shows until first Start (pt 2)
      var ps = $('playSound'); if (ps) ps.classList.remove('hidden');
      var mb = $('muteBtn'); if (mb) mb.classList.remove('hidden');     // public-only convenience (a personal operator scrubs the <audio>)
      setPlayUI('idle');
    } else {
      var ps2 = $('playSound'); if (ps2) ps2.classList.add('hidden');   // personal uses GO/pause directly; no Start button, nothing gated
    }
  }

  // ---- Start / Pause state machine (public console, pt 2). The /studio console opens with ONE
  // "Start Light Show" button (no auto-GO); the first click loads (spinner), then morphs to "Pause
  // Light Show" once the show is actually running, revealing STOP/BLACKOUT + the rest of the page.
  var playUiState = 'idle'; // idle | loading | playing | paused
  function setPlayUI(state) {
    playUiState = state; if (window.__opAudio) window.__opAudio.playUiState = state;
    var ps = $('playSound'), spin = $('playSpin'); if (!ps) return;
    var fb = { idle: '▶ Start Light Show ', loading: '● Starting… ', playing: '⏸ Pause Light Show ', paused: '▶ Resume Light Show ' }[state] || '▶ Start Light Show ';
    var txt = tr('console.play.' + state, fb);
    if (ps.childNodes[0]) ps.childNodes[0].nodeValue = txt; else ps.textContent = txt;
    ps.disabled = (state === 'loading');
    if (spin) spin.classList[state === 'loading' ? 'remove' : 'add']('hidden');
    if (state === 'playing') { var con = $('opConsole'); if (con) con.classList.remove('pre-start'); } // reveal STOP/BLACKOUT + the rest
  }
  if ($('playSound')) $('playSound').addEventListener('click', function () {
    if (!PUBLIC) return;
    if (playUiState === 'idle') {
      setPlayUI('loading');
      var a = ensureAudio(); if (a) a.init().catch(function () {}); soundOn = true; // resume the AudioContext IN this gesture (autoplay)
      if (armedId == null) { var def = (DEFAULTS && DEFAULTS.default_track_id); if (def != null) armTrack(Number(def), true); else doGoPublic(); }
      else doGoPublic();
      ga('show_started', { track_id: armedId == null ? '' : armedId });
    } else if (playUiState === 'playing') {
      tx('pause'); if (audio && soundOn) audio.stop(); setPlayUI('paused');
    } else if (playUiState === 'paused') {
      tx('resume'); if (audio && soundOn) audio.resume(); setPlayUI('playing');
    }
  });
  // local MUTE/UNMUTE (this browser only — the show keeps running; pt 9)
  var consoleMuted = false;
  if ($('muteBtn')) $('muteBtn').addEventListener('click', function () {
    consoleMuted = !consoleMuted;
    if (audio && audio.setVolume) audio.setVolume(consoleMuted ? 0 : 0.85);
    if (player) player.muted = consoleMuted || player.muted;
    if (window.__opAudio) window.__opAudio.muted = consoleMuted;
    $('muteBtn').textContent = consoleMuted ? tr('console.unmute', '🔇 Unmute music') : tr('console.mute', '🔊 Mute music');
  });
  // round 13 (pt 8): GLOBAL mute — silence the music on EVERY phone (distinct from the local mute above).
  var allMuted = false;
  if ($('muteAllBtn')) $('muteAllBtn').addEventListener('click', function () {
    allMuted = !allMuted;
    api('/api/operator/mute-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muted: allMuted }) });
    $('muteAllBtn').textContent = allMuted ? tr('console.unmute_all', '🔈 Unmute all phones') : tr('console.mute_all', '🔇 Mute all phones');
    ga('mute_all', { muted: allMuted });
  });
  // round 13 (pt 7): SEEK slider — jump the music+lights to any position (range = 0..1000 permille of dur).
  var seekDurMs = 0, seekDragging = false;
  function fmtMs(ms) { ms = Math.max(0, ms | 0); var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function seekSetDur(ms) { seekDurMs = Number(ms) || 0; var s = $('seek'); if (s) s.disabled = !(seekDurMs > 0 && (curState === 'running' || curState === 'paused')); }
  function seekTick() {
    var s = $('seek'); if (!s || seekDragging || !seekDurMs) return;
    var pos = (typeof consolePos === 'function') ? consolePos() : null;
    if (pos != null && pos >= 0) { s.value = Math.round(pos / seekDurMs * 1000); if ($('seekVal')) $('seekVal').textContent = fmtMs(pos) + ' / ' + fmtMs(seekDurMs); }
  }
  if ($('seek')) {
    $('seek').addEventListener('input', function () { seekDragging = true; if ($('seekVal')) $('seekVal').textContent = fmtMs(Number($('seek').value) / 1000 * seekDurMs) + ' / ' + fmtMs(seekDurMs); });
    $('seek').addEventListener('change', function () { seekDragging = false; var off = Math.round(Number($('seek').value) / 1000 * seekDurMs); tx('seek', { offsetMs: off }); });
  }

  // round 12 (pt 4): a LIVE scrolling-marquee control on BOTH consoles. api() rewrites the path per
  // session: /operator -> /api/operator/marquee (hub.setMarquee('main') -> the owner's invited audience),
  // /studio -> /api/console/marquee (this room's phones). Same control, same code, identical on both —
  // text only, so it can never touch the lights / flash cap.
  function sendMarquee(text) {
    return api('/api/operator/marquee', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(text || '').slice(0, 200) }) })
      .then(function (r) { return r.ok ? r.json() : null; });
  }
  if ($('mqSend')) $('mqSend').addEventListener('click', function () {
    sendMarquee($('mqLive').value).then(function (j) { if ($('mqMsg')) $('mqMsg').textContent = (j && j.ok) ? tr('console.marquee_sent', 'Showing on all phones ✓') : tr('console.marquee_err', 'Could not send — try again'); });
  });
  if ($('mqClear')) $('mqClear').addEventListener('click', function () {
    if ($('mqLive')) $('mqLive').value = '';
    sendMarquee('').then(function () { if ($('mqMsg')) $('mqMsg').textContent = tr('console.marquee_cleared', 'Cleared'); });
  });

  // ===================== personal: playlist + applications =====================
  function loadState() {
    api('/api/operator/state').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s) return;
      if ($('joinurl')) { $('joinurl').textContent = s.joinUrl; $('joinurl').href = s.joinUrl; $('joinBig').textContent = s.joinUrl; }
      if ($('disk')) $('disk').textContent = (s.freeDiskBytes / 1e9).toFixed(1) + ' GB';
      if ($('nudge')) { $('nudge').value = s.show.nudge_ms || 0; $('nudgeVal').textContent = (s.show.nudge_ms || 0) + ' ms'; nudge = s.show.nudge_ms || 0; }
      renderState(s.state);
      var tb = $('tracks').querySelector('tbody'); tb.innerHTML = '';
      s.tracks.forEach(function (t) {
        var isArmed = t.id === armedId;
        var tr = document.createElement('tr');
        if (isArmed) tr.style.background = 'rgba(90,160,255,.15)';
        tr.innerHTML = '<td><b>' + esc(t.title) + '</b>' + (isArmed ? ' <span style="color:#5aa0ff">● ARMED</span>' : '') + '<br><span class="muted">' + (t.analysis_status) + (t.cue_count ? ' · ' + t.cue_count + ' cues · ' + Math.round((t.duration_ms || 0) / 1000) + 's' : '') + '</span>'
          + '<br><label class="muted"><input type="checkbox" ' + (t.license_attested ? 'checked' : '') + ' data-attest="' + t.id + '"> I hold rights/licence (ZAiKS) to play this publicly</label>'
          + '<br><label class="muted"><input type="checkbox" ' + (t.is_public ? 'checked' : '') + ' data-public="' + t.id + '"> Show in the public /studio playlist</label></td>'
          + '<td style="text-align:right"><button data-arm="' + t.id + '" ' + (t.analysis_status !== 'done' ? 'disabled' : '') + ' class="' + (isArmed ? 'primary' : '') + '" style="width:auto">' + (isArmed ? '✓ Armed' : 'Arm') + '</button> '
          + '<button data-del="' + t.id + '" class="ghost" style="width:auto">✕</button></td>';
        tb.appendChild(tr);
      });
    });
    api('/api/operator/qr').then(function (r) { return r.blob(); }).then(function (b) { var u = URL.createObjectURL(b); $('qr').src = u; $('qrBig').src = u; });
  }

  // ===================== public: curated playlist + QR =====================
  function loadPublic() {
    api('/api/operator/playlist').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) { var tb0 = $('tracks').querySelector('tbody'); if (tb0) tb0.innerHTML = '<tr><td class="muted">No public tracks yet.</td></tr>'; return; }
      // round 12 (pt 6): the visitor's OWN uploads (d.guestTracks) appear in the playlist FIRST, then
      // the host's curated tracks — so they can loop / select their own music like any other track.
      pubTracks = (d.guestTracks || []).concat(d.tracks || []);
      if (d.playlist && d.playlist.mode) { plMode = d.playlist.mode; plNow = d.playlist.nowId; plNext = d.playlist.nextId; }
      if (d.defaults && d.defaults.playlist_mode && plNow == null) plMode = plMode || d.defaults.playlist_mode;
      var tb = $('tracks').querySelector('tbody'); tb.innerHTML = '';
      pubTracks.forEach(function (t) {
        var isArmed = t.id === armedId;
        var tr = document.createElement('tr');
        if (isArmed) tr.style.background = 'rgba(90,160,255,.15)';
        var pick = (plMode === 'selected') ? '<input type="checkbox" data-plsel="' + t.id + '"' + (plSelected.indexOf(t.id) >= 0 ? ' checked' : '') + ' style="margin-right:6px">' : '';
        tr.innerHTML = '<td>' + pick + '<b>' + esc(t.title) + '</b>' + (isArmed ? ' <span style="color:#5aa0ff">● playing</span>' : '') + '<br><span class="muted">' + (t.cue_count ? Math.round((t.duration_ms || 0) / 1000) + 's' : '') + '</span></td>'
          + '<td style="text-align:right"><button data-arm="' + t.id + '" class="' + (isArmed ? 'primary' : '') + '" style="width:auto">' + (isArmed ? '✓ Playing' : 'Switch') + '</button></td>';
        tb.appendChild(tr);
      });
      if (!pubTracks.length) { tb.innerHTML = '<tr><td class="muted">The host has not published any tracks yet.</td></tr>'; }
      renderPlaylistCtl();
      // round 11 (pt 2): do NOT auto-GO on open — /studio waits for the single "Start Light Show"
      // click so the user is never confused about what starts the show. Remember the default for it.
      if (DEFAULTS && (d.defaults && d.defaults.default_track_id) && DEFAULTS.default_track_id == null) DEFAULTS.default_track_id = d.defaults.default_track_id;
    });
    api('/api/operator/qr').then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) { if (!b) return; var u = URL.createObjectURL(b); if ($('qr')) $('qr').src = u; if ($('qrBig')) $('qrBig').src = u; });
  }

  // ---- playlist controls (public console, round 10) ----
  function plTitle(id) { for (var i = 0; i < pubTracks.length; i++) if (pubTracks[i].id === id) return pubTracks[i].title; return id == null ? '—' : ('#' + id); }
  function renderPlaylistCtl() {
    if (!PUBLIC) return;
    var ctl = $('playlistCtl'); if (!ctl) return;
    if (!pubTracks.length) { ctl.classList.add('hidden'); return; }
    ctl.classList.remove('hidden');
    var btns = ctl.querySelectorAll('[data-plmode]');
    for (var i = 0; i < btns.length; i++) { var on = btns[i].getAttribute('data-plmode') === plMode; btns[i].className = on ? 'primary' : ''; }
    var nn = $('plNowNext');
    if (nn) {
      var label = plMode === 'one' ? 'Looping' : (plMode === 'selected' ? 'Selected loop' : 'Loop all');
      nn.textContent = label + ' · Now: ' + plTitle(plNow == null ? armedId : plNow) + (plMode === 'one' ? '' : ' · Next: ' + plTitle(plNext));
    }
  }
  function applyPlMode(mode) {
    plMode = mode;
    // collect ticked ids for 'selected'
    if (mode === 'selected') { plSelected = []; var cbs = document.querySelectorAll('[data-plsel]'); for (var i = 0; i < cbs.length; i++) if (cbs[i].checked) { var sv = cbs[i].getAttribute('data-plsel'); plSelected.push(/^g:/.test(sv) ? sv : Number(sv)); } } // guest ids stay strings (round 12 pt 6)
    api('/api/operator/playlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode, selected: plSelected }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { if (p && p.ok) { plNow = p.nowId; plNext = p.nextId; if (typeof p.idx === 'number' && p.nowId != null) armedId = p.nowId; } loadPublic(); });
    renderPlaylistCtl();
  }
  if ($('plModes')) $('plModes').addEventListener('click', function (e) { var m = e.target.getAttribute('data-plmode'); if (m) applyPlMode(m); });
  if ($('tracks')) $('tracks').addEventListener('change', function (e) {
    if (!PUBLIC) return; var sel = e.target.getAttribute('data-plsel');
    if (sel && plMode === 'selected') applyPlMode('selected'); // re-post the new selection
  });

  function renderState(st) {
    var prevState = curState;
    curState = st.status;
    if ($('state')) $('state').textContent = tr('console.state.' + st.status, st.status);
    updateReactHint();
    if (typeof seekSetDur === 'function') seekSetDur(seekDurMs); // round 13 (pt 7): enable/disable seek on state change
    // GA: one chokepoint for show start/stop — covers GO/resume/stop/blackout/track-end, personal+public.
    if (st.status === 'running' && prevState !== 'running') gaShowStarted(armedId);
    else if (st.status !== 'running' && prevState === 'running') gaShowStopped();
    // round 11 (pt 2): the public Start/Pause button follows the real transport state (chokepoint).
    if (PUBLIC) {
      if (st.status === 'running') { if (playUiState !== 'playing') setPlayUI('playing'); }
      else if (st.status === 'paused') { if (playUiState !== 'paused') setPlayUI('paused'); }
      else if (playUiState !== 'idle' && playUiState !== 'loading') setPlayUI('idle'); // stop/blackout -> back to Start (page stays revealed)
    }
    if (pendingGo) return;
    var locking = (st.status === 'idle' && !(clock && clock.ready));
    if ($('go')) $('go').textContent = st.status === 'paused' ? '▶ RESUME' : (st.status === 'running' ? '● LIVE' : (locking ? '▶ GO (clock…)' : '▶ GO'));
  }

  if ($('tracks')) $('tracks').addEventListener('click', function (e) {
    var arm = e.target.getAttribute('data-arm'); var del = e.target.getAttribute('data-del');
    if (arm) armTrack(/^g:/.test(arm) ? arm : Number(arm)); // guest uploads keep their string id (round 12 pt 6)
    if (del && !PUBLIC) api('/api/operator/track/' + del, { method: 'DELETE' }).then(loadState);
  });
  if ($('tracks')) $('tracks').addEventListener('change', function (e) {
    if (PUBLIC) return;
    var at = e.target.getAttribute('data-attest');
    var pub = e.target.getAttribute('data-public');
    if (at && e.target.checked) api('/api/operator/track/' + at + '/attest', { method: 'POST' });
    if (pub) api('/api/operator/track/' + pub + '/public', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_public: e.target.checked }) })
      .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) { alert(j.error || 'cannot publish'); loadState(); } loadPublicConfig(); });
  });

  if ($('upload')) $('upload').addEventListener('click', function () {
    var f = $('file').files[0]; if (!f) { $('uploadMsg').textContent = 'Choose a file first.'; return; }
    var path = '/api/operator/upload';
    if (PUBLIC) {
      if (!($('uploadConsent') && $('uploadConsent').checked)) { $('uploadMsg').textContent = 'Please tick the rights confirmation first.'; return; }
      path = '/api/operator/upload?consent=1'; // -> /api/console/upload?consent=1 (server-mandatory)
      var a0 = ensureAudio(); if (a0) a0.init().catch(function () {}); // create+resume the AudioContext IN this click so the uploaded sound can auto-play (autoplay policy)
    }
    var fd = new FormData(); fd.append('audio', f);
    $('uploadMsg').textContent = 'Uploading & analyzing…';
    api(path, { method: 'POST', body: fd }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { ga('upload_test', { result: 'error', reason: String(res.j.error || '').slice(0, 60) }); $('uploadMsg').textContent = 'Error: ' + (res.j.error || ''); return; }
        ga('upload_test', { result: 'ok', cue_count: res.j.cueCount });
        if (PUBLIC) { $('uploadMsg').textContent = 'Ready — ' + res.j.cueCount + ' cues. Playing your music…'; armTrack(res.j.trackId, true); soundOn = false; setTimeout(startConsoleSound, 400); } // auto-play the uploaded sound (gesture = the Upload click)
        else { $('uploadMsg').textContent = 'Done: ' + res.j.cueCount + ' cues, ' + res.j.beats + ' beats'; loadState(); }
      })
      .catch(function (e) { ga('upload_test', { result: 'fail' }); $('uploadMsg').textContent = 'Upload failed: ' + e; });
  });

  // round 11 (pt 3): the licence confirmation lives in a MODAL that opens only when the visitor picks
  // a file (it no longer occupies the page). Agreeing ticks the consent + uploads; Cancel clears it.
  function closeConsent() { var m = $('consentModal'); if (m) m.classList.add('hidden'); }
  if ($('file')) $('file').addEventListener('change', function () {
    if (!(PUBLIC && FEAT.upload) || !$('file').files[0]) return;
    if ($('uploadConsent') && $('uploadConsent').checked) return; // already agreed this session
    var m = $('consentModal'); if (m) m.classList.remove('hidden');
  });
  if ($('consentAgree')) $('consentAgree').addEventListener('click', function () {
    if ($('uploadConsent')) $('uploadConsent').checked = true;
    closeConsent();
    if ($('file') && $('file').files[0] && $('upload')) $('upload').click(); // proceed with the upload
  });
  if ($('consentCancel')) $('consentCancel').addEventListener('click', function () {
    if ($('file')) $('file').value = ''; if ($('uploadConsent')) $('uploadConsent').checked = false; closeConsent();
  });

  // ---- transport: personal = operator WS; public = HTTP /api/console/* ----
  function tx(cmd, extra) {
    if (PUBLIC) {
      return api('/api/operator/' + cmd, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(extra || {}) })
        .then(function (r) { return r.ok ? r.json() : null; });
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t: 'op', cmd: cmd }, extra || {})));
    return Promise.resolve(null);
  }

  function armTrack(id, isDefault) {
    armedId = id; audioReady = false;
    ga('track_played', { track_id: id == null ? '' : id, track_kind: (typeof id === 'number') ? 'curated' : 'guest', is_default: !!isDefault });
    if (PUBLIC) {
      // public console: arm over HTTP. keepPreset so the host's default REACTIVE preset (e.g. Rainbow
      // Chase) keeps rendering OVER the track, reading its loudness — that's the default crowd LOOK
      // (round 11 pt 17). The track supplies the music + envelope; the preset is the visual.
      tx('arm', { trackId: id, keepPreset: true }).then(function (j) {
        if (!j || !j.ok) { if ($('armed')) $('armed').textContent = 'could not start that track'; return; }
        if ($('armed')) $('armed').textContent = 'playing — lights live';
        loadPublic();
        fetchConsoleAudio(id); // round 10: curated AND guest uploads now have served audio (keep-and-serve)
        if (isDefault) setTimeout(function () { doGoPublic(); }, 250); // visuals roll immediately
      });
      return;
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'arm', trackId: id }));
    // round 13 (pt 4): the personal operator isn't a room audience, so fetch the armed track's cues
    // for the Live preview (the public console gets them via the {t:'timeline'} room broadcast).
    if (typeof id === 'number') api('/api/operator/timeline/' + id).then(function (r) { return r.ok ? r.json() : null; }).then(function (tl) { if (armedId === id && tl) { consoleTimeline = tl; seekSetDur(tl.durationMs); } }).catch(function () {});
    $('armed').textContent = 'track #' + id + ' (lights ready, loading audio…)';
    loadState();
    // re-arm: drop the previous track's decoded buffer so the NEW one is fetched + decoded.
    var aPrev = ensureAudio(); if (aPrev) { aPrev.dropBuffer(); window.__opAudio.ready = false; lastAudioT0 = null; }
    audioBuf = null;
    // Fetch the audio ONCE: a Blob feeds the visible <audio> (off-air scrub); the SAME bytes are
    // decoded into AudioSync for sample-accurate LIVE playback aligned to the show clock (the fix).
    api('/api/operator/audio/' + id).then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (ab) {
        if (armedId !== id) return;
        if (!ab) throw new Error('no audio');
        if (player.dataset.url) { try { URL.revokeObjectURL(player.dataset.url); } catch (e) {} }
        var url = URL.createObjectURL(new Blob([ab])); player.dataset.url = url; player.src = url; player.muted = false; player.load();
        audioReady = true; $('armed').textContent = 'track #' + id + ' ♪ audio ready';
        var a2 = ensureAudio();
        if (a2) {
          a2.init().then(function () { return a2.cache(ab); }).then(function () {
            window.__opAudio.ready = true;
            if (a2._pendingT0 != null) { a2.start(a2._pendingT0); a2._pendingT0 = null; }
          }).catch(function () {}); // decode may fail headless (AAC) -> lights + <audio> still work
        }
      })
      .catch(function () { if (armedId === id) $('armed').textContent = 'track #' + id + ' (lights only — play music separately)'; });
  }

  // public console synced audio (curated track). Lights are already synced via the room
  // broadcast; the SOUND is opt-in (one tap) per browser autoplay policy.
  function fetchConsoleAudio(id) {
    if (!window.AudioSync) return;
    ensureAudio();
    pubTrackId = id;
    // round 10: the one prominent "▶ Play with sound" button is the single sound gesture.
    if (!soundOn) { var ps = $('playSound'); if (ps) ps.classList.remove('hidden'); }
  }
  function guestPath(id) { return (typeof id === 'string' && id.indexOf('g:') === 0) ? '/api/operator/guest-audio' : null; } // -> /api/console/guest-audio (room from token)
  function startConsoleSound() {
    if (!ensureAudio() || pubTrackId == null) return;
    audio.clock = clock || audio.clock;
    var trackPath = (typeof pubTrackId === 'number') ? ('/api/operator/audio/' + pubTrackId) : guestPath(pubTrackId); // round 10: guest uploads are served too
    if (trackPath) {
      audio.init().then(function () {
        return api(trackPath).then(function (r) { return r.ok ? r.arrayBuffer() : null; });
      }).then(function (ab) {
        if (!ab) return; return audio.cache(ab).then(function () { if (curState === 'running' && pubT0 != null) audio.start(pubT0); });
      }).catch(function () {});
    } else { audio.init().catch(function () {}); }
    soundOn = true;
    var ps = $('playSound'); if (ps) { ps.textContent = '🔊 Sound on'; ps.disabled = true; }
    if ($('soundBtn')) { $('soundBtn').textContent = '🔊 Sound on'; $('soundBtn').disabled = true; }
  }
  if ($('soundBtn')) $('soundBtn').addEventListener('click', startConsoleSound);
  // (#playSound is the Start/Pause machine — wired above; not a one-shot sound enabler any more)

  // playlist advanced to a new curated track while the console sound is on — swap the monitor audio.
  function reloadConsoleSound(id) {
    if (!ensureAudio() || typeof id !== 'number') return;
    audio.clock = clock || audio.clock;
    if (audio.dropBuffer) audio.dropBuffer();
    audio.init().then(function () { return api('/api/operator/audio/' + id).then(function (r) { return r.ok ? r.arrayBuffer() : null; }); })
      .then(function (ab) { if (!ab) return; return audio.cache(ab).then(function () { if (curState === 'running' && pubT0 != null) audio.start(pubT0); }); })
      .catch(function () {});
  }

  function flashBtn(el) { el.style.boxShadow = '0 0 0 3px #fff'; setTimeout(function () { el.style.boxShadow = ''; }, 300); }

  // personal GO: client-computed, audio-aligned T0 over the operator WS. The audio is NOT
  // started by a bare setTimeout any more (that ignored clock.offset+nudge → console drifted
  // from the on-air audio). The running-state echo (same authoritative T0) drives AudioSync
  // via syncLiveAudio, so the console plays on the exact show clock the phones use.
  function doGo() {
    $('go').textContent = '● starting…';
    var T0 = performance.now() + LEAD_MS + (clock ? clock.offset : 0) + nudge;
    wantLiveAudio = true;
    try { player.pause(); player.muted = true; } catch (e) {} // visible <audio> is scrub-only during live
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'go', T0: T0 }));
  }
  // public GO: server-timed; the console hears the start broadcast and aligns its sound to it.
  function doGoPublic() { if ($('go')) $('go').textContent = '● starting…'; tx('go', {}); }

  if ($('go')) $('go').addEventListener('click', function () {
    if (armedId == null) { alert(PUBLIC ? 'Pick a track first.' : 'Arm a track first.'); return; }
    flashBtn($('go'));
    if (curState === 'paused') {
      if (PUBLIC) { tx('resume', {}); if (audio && soundOn) audio.resume(); return; }
      wantLiveAudio = true; lastAudioT0 = null; // the running echo realigns AudioSync to the resume T0
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'resume' }));
      return;
    }
    if (PUBLIC) { doGoPublic(); return; }
    if (!(clock && clock.ready)) {
      pendingGo = true; $('go').textContent = '⏳ syncing clock…';
      if (!goWatcher) goWatcher = setInterval(function () {
        if (clock && clock.ready && pendingGo) { pendingGo = false; clearInterval(goWatcher); goWatcher = null; doGo(); }
      }, 100);
      return;
    }
    doGo();
  });
  if ($('pause')) $('pause').addEventListener('click', function () { flashBtn($('pause')); try { player.pause(); } catch (e) {} if (audio) audio.stop(); tx('pause', {}); });
  if ($('stop')) $('stop').addEventListener('click', function () { flashBtn($('stop')); try { player.pause(); player.currentTime = 0; } catch (e) {} if (audio) audio.stop(); tx('stop', {}); });
  if ($('blackout')) $('blackout').addEventListener('click', function () { flashBtn($('blackout')); tx('blackout', {}); }); // round 13 (pt 6): BLACKOUT darkens lights/torch only — music keeps playing (no audio.stop)

  if ($('nudge')) {
    $('nudge').addEventListener('input', function () { nudge = Number($('nudge').value); $('nudgeVal').textContent = nudge + ' ms'; });
    if (!PUBLIC) $('nudge').addEventListener('change', function () { api('/api/operator/nudge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms: nudge }) }); });
  }

  if ($('projector')) $('projector').addEventListener('click', function () { $('proj').classList.remove('hidden'); });
  if ($('projClose')) $('projClose').addEventListener('click', function () { $('proj').classList.add('hidden'); });

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    clock = new ClockSync(function (o) { try { ws.send(JSON.stringify(o)); } catch (e) {} });
    if (audio) audio.clock = clock;
    ws.onopen = function () {
      if ($('conn')) $('conn').textContent = 'online';
      if (PUBLIC) ws.send(JSON.stringify({ t: 'hello', role: 'audience', room: ROOM, platform: 'console' }));
      else ws.send(JSON.stringify({ t: 'hello', role: 'operator', token: TOKEN }));
      var n = 0; var p = setInterval(function () { if (ws.readyState === 1) { clock.ping(); if (++n >= 25) clearInterval(p); } }, 80);
      setInterval(function () { if (ws.readyState === 1) clock.ping(); }, 25000);
    };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onWs(m); };
    ws.onclose = function () { if ($('conn')) $('conn').textContent = 'offline — retrying'; setTimeout(connect, 1500); };
    ws.onerror = function () {};
  }

  function onWs(m) {
    if (m.t === 'sync') { clock.onReply(m.c0, m.s1); if (clock.ready && curState === 'idle') renderState({ status: curState }); return; }
    if (!PUBLIC) {
      if (m.t === 'count') {
        gaPeakUpdate(m.audience);
        $('count').textContent = m.audience; if ($('countBig')) $('countBig').textContent = m.audience;
        var ts = $('torchSplit');
        if (ts) ts.textContent = 'Flash reach: ' + (m.torchCapable || 0) + ' Android (camera-LED) · ' + (m.screenOnly || 0) + ' iPhone/other (screen-only)';
        return;
      }
      if (m.t === 'state') { renderState(m.state); syncLiveAudio(m.state); if (m.state && m.state.T0 != null) lastT0 = m.state.T0; return; }
      return;
    }
    // ---- public console: derive transport state from the room messages it receives ----
    if (m.t === 'welcome' || m.t === 'state') { if (m.state) { renderState({ status: m.state.status }); if (m.state.status === 'running' && m.state.T0 != null) { pubT0 = m.state.T0; lastT0 = m.state.T0; if (audio && soundOn) audio.start(pubT0); } } return; }
    if (m.t === 'index') { var n = Math.max(0, (m.total | 0) - 1); gaPeakUpdate(n); if ($('count2')) $('count2').textContent = n; if ($('countBig')) $('countBig').textContent = n; return; } // -1: the console itself is a member
    if (m.t === 'timeline') { var chg = (m.trackId !== pubTrackId); pubTrackId = m.trackId; consoleTimeline = m.data || null; seekSetDur(m.data && m.data.durationMs); if (chg && soundOn && typeof m.trackId === 'number') reloadConsoleSound(m.trackId); return; } // round 13 (pt 4/7): cues for the Live preview + seek range
    if (m.t === 'playlist') { // round 10: the room advanced (or mode changed) — follow now/next
      plMode = m.mode || plMode; plNow = m.nowId; plNext = m.nextId;
      if (m.nowId != null && m.nowId !== armedId) { armedId = m.nowId; loadPublic(); } else renderPlaylistCtl();
      return;
    }
    if (m.t === 'start') { renderState({ status: 'running' }); pubT0 = m.T0; lastT0 = m.T0; if (audio && soundOn) audio.start(m.T0); return; }
    if (m.t === 'pause') { renderState({ status: 'paused' }); if (audio) audio.stop(); return; }
    if (m.t === 'stop') { renderState({ status: 'idle' }); armedId = armedId; if (audio) audio.stop(); return; }
    if (m.t === 'blackout') { renderState({ status: 'blackout' }); return; } // round 13 (pt 6): keep the console's music monitor playing through a blackout
  }

  function loadApps() {
    if (!FEAT.applications) return;
    api('/api/operator/applications').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var tb = $('apps').querySelector('tbody'); tb.innerHTML = '';
      $('appsMsg').textContent = d.applications.length ? (d.applications.length + ' lead(s)') : 'No leads yet — submissions from the landing form appear here.';
      d.applications.forEach(function (a) {
        var when = new Date(a.created_at).toLocaleString();
        var tr = document.createElement('tr');
        var bits = [esc(a.event_type || ''), a.phone ? '📞 ' + esc(a.phone) : '', a.company ? '🏢 ' + esc(a.company) : '', a.tier ? '💶 ' + esc(a.tier) : '', a.source ? 'via ' + esc(a.source) : ''].filter(Boolean).join(' · ');
        tr.innerHTML = '<td><b>' + esc(a.name) + '</b> · ' + esc(a.contact) + '<br><span class="muted">' + bits + (a.message ? '<br>' + esc(a.message) : '') + '<br>' + when + (a.notified ? ' · ✓ TG' : '') + '</span></td>'
          + '<td style="text-align:right;vertical-align:top"><button data-delapp="' + a.id + '" class="ghost" style="width:auto">✕</button></td>';
        tb.appendChild(tr);
      });
    });
  }
  if ($('apps')) $('apps').addEventListener('click', function (e) {
    var id = e.target.getAttribute('data-delapp');
    if (id) api('/api/operator/application/' + id, { method: 'DELETE' }).then(loadApps);
  });
  if ($('refreshApps')) $('refreshApps').addEventListener('click', loadApps);

  // ---- public console defaults editor (personal mode only) ----
  function loadPublicConfig() {
    if (!FEAT.publicConfig) return;
    api('/api/operator/public-config').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.config) return;
      var c = d.config;
      if ($('pcBrand')) $('pcBrand').value = c.brand_name || '';
      if ($('pcWelcome')) $('pcWelcome').value = c.welcome_text || '';
      if ($('pcTorch')) $('pcTorch').checked = c.allow_torch !== 0;
      if ($('pcUpload')) { $('pcUpload').checked = !!c.allow_upload; $('pcUpload').disabled = !d.uploadEnabled; if ($('pcUploadNote')) $('pcUploadNote').textContent = d.uploadEnabled ? '' : '(disabled on the server — PUBLIC_UPLOAD_ENABLED=0)'; }
      var sel = $('pcTrack'); if (sel) {
        sel.innerHTML = '<option value="">— none —</option>';
        (d.publicTracks || []).forEach(function (t) { var o = document.createElement('option'); o.value = t.id; o.textContent = t.title; if (c.default_track_id === t.id) o.selected = true; sel.appendChild(o); });
      }
      if ($('pcMarquee')) $('pcMarquee').value = c.marquee_text || '';
      pcLastConfig = c; pcApplyPresetDefaults(); // populate default-preset pickers (hydrates if schemas already loaded)
    });
  }
  if ($('pcSave')) $('pcSave').addEventListener('click', function () {
    var body = { brand_name: $('pcBrand').value, welcome_text: $('pcWelcome').value, allow_torch: $('pcTorch').checked, default_track_id: $('pcTrack').value ? Number($('pcTrack').value) : null };
    if ($('pcUpload') && !$('pcUpload').disabled) body.allow_upload = $('pcUpload').checked;
    if ($('pcScreenPreset') && $('pcScreenPreset').value) { body.default_screen_preset = $('pcScreenPreset').value; body.default_screen_params = pcScreenParams; } // round 11 pt 17 (server validates)
    if ($('pcTorchPreset') && $('pcTorchPreset').value) { body.default_torch_preset = $('pcTorchPreset').value; body.default_torch_params = pcTorchParams; }
    if ($('pcMarquee')) body.marquee_text = $('pcMarquee').value; // round 11 pt 19
    api('/api/operator/public-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).then(function (j) { $('pcMsg').textContent = j.ok ? 'Saved ✓' : ('Error: ' + (j.error || '')); setTimeout(function () { $('pcMsg').textContent = ''; }, 2500); });
  });
  // ---- round 11 (pt 17): default screen/torch preset PICKER + param sliders in the defaults card.
  // Reuses the same schema-driven rows as Live presets; the server re-validates on save.
  var pcScreenParams = {}, pcTorchParams = {}, pcLastConfig = null;
  function pcBuildParamRows(container, schema, values) {
    container.innerHTML = ''; if (!schema || !schema.params) return;
    Object.keys(schema.params).forEach(function (k) {
      var spec = schema.params[k];
      var row = document.createElement('div'); row.className = 'nudge';
      var lab = document.createElement('span'); lab.textContent = spec.label; lab.style.minWidth = '110px'; lab.style.fontSize = '.85rem';
      var inp = document.createElement('input'); inp.type = 'range'; inp.min = spec.min; inp.max = spec.max; inp.step = spec.step;
      inp.value = values[k] != null ? values[k] : spec.def;
      var val = document.createElement('span'); val.textContent = inp.value; val.style.minWidth = '46px';
      inp.addEventListener('input', function () { val.textContent = inp.value; values[k] = Number(inp.value); });
      row.appendChild(lab); row.appendChild(inp); row.appendChild(val); container.appendChild(row);
    });
  }
  function pcDefaultsFor(schema) { var o = {}; if (schema && schema.params) for (var k in schema.params) o[k] = schema.params[k].def; return o; }
  function pcRenderScreen() { var s = $('pcScreenPreset'); if (!s) return; var t = s.value; if (t && presetSchema && presetSchema[t]) pcBuildParamRows($('pcScreenParams'), presetSchema[t], pcScreenParams); else if ($('pcScreenParams')) $('pcScreenParams').innerHTML = ''; }
  function pcRenderTorch() { var s = $('pcTorchPreset'); if (!s) return; var t = s.value; if (t && t !== 'off' && torchSchema && torchSchema[t]) pcBuildParamRows($('pcTorchParams'), torchSchema[t], pcTorchParams); else if ($('pcTorchParams')) $('pcTorchParams').innerHTML = ''; }
  function pcApplyPresetDefaults() {  // populate selects (once schemas are loaded) + hydrate from the last config
    if (!FEAT.publicConfig) return;
    var ss = $('pcScreenPreset');
    if (ss && presetSchema && ss.options.length === 0) Object.keys(presetSchema).forEach(function (t) { var o = document.createElement('option'); o.value = t; o.textContent = presetSchema[t].label || t; ss.appendChild(o); });
    var ts = $('pcTorchPreset');
    if (ts && torchSchema && ts.options.length === 0) { var off = document.createElement('option'); off.value = 'off'; off.textContent = 'Off'; ts.appendChild(off); Object.keys(torchSchema).forEach(function (t) { if (t === 'off') return; var o = document.createElement('option'); o.value = t; o.textContent = (torchSchema[t] && torchSchema[t].label) || t; ts.appendChild(o); }); }
    var c = pcLastConfig; if (!c) return;
    if (ss && presetSchema && c.default_screen_preset && presetSchema[c.default_screen_preset]) { ss.value = c.default_screen_preset; try { pcScreenParams = c.default_screen_params ? JSON.parse(c.default_screen_params) : {}; } catch (e) { pcScreenParams = {}; } pcRenderScreen(); }
    if (ts && torchSchema && c.default_torch_preset) { ts.value = c.default_torch_preset; try { pcTorchParams = c.default_torch_params ? JSON.parse(c.default_torch_params) : {}; } catch (e) { pcTorchParams = {}; } pcRenderTorch(); }
  }
  if ($('pcScreenPreset')) $('pcScreenPreset').addEventListener('change', function () { pcScreenParams = pcDefaultsFor(presetSchema && presetSchema[$('pcScreenPreset').value]); pcRenderScreen(); });
  if ($('pcTorchPreset')) $('pcTorchPreset').addEventListener('change', function () { pcTorchParams = pcDefaultsFor(torchSchema && torchSchema[$('pcTorchPreset').value]); pcRenderTorch(); });

  // ---- live presets (studio) ----
  var presetSchema = null, activeType = null, activeParams = {};
  function defParams(type) { var o = {}, ps = presetSchema[type].params; for (var k in ps) o[k] = ps[k].def; return o; }

  var PV = window.CLS_PRESETS;
  var pvCanvas = $('presetPreview'), pvCtx = pvCanvas ? pvCanvas.getContext('2d') : null;
  var pvBackstop = null, pvT0 = null, pvLast = 0;
  window.__opPreview = { ready: !!PV, type: null, frames: 0, changeSeq: 0, maxLum: 0, minLum: 1, hueMin: 360, hueMax: 0, hueSpread: 0, flashesPerSec: 0, lastBg: '', cross: [], _armed: true };
  // round 13 (pt 4): the Live preview now reacts to the REAL music — it samples the armed track's
  // compiled envelope (the SAME AGC'd cue brightness the crowd reacts to) at the actual play position,
  // instead of a generic sine. 0 when not running/no track (silent => steady, no phantom jump).
  function sampleCueAt(pos) { // -> { b, rgb } at track position `pos` ms (binary search, like the phone)
    var tl = consoleTimeline; if (!tl || !tl.cues || !tl.cues.length) return null;
    var c = tl.cues, lo = 0, hi = c.length - 1;
    if (pos <= c[0].t) return { b: c[0].b, rgb: c[0].rgb };
    if (pos >= c[hi].t) return { b: c[hi].b, rgb: c[hi].rgb };
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (c[mid].t <= pos) lo = mid; else hi = mid; }
    var a = c[lo], d = c[hi], f = (pos - a.t) / Math.max(1, d.t - a.t);
    return { b: a.b + (d.b - a.b) * f, rgb: [a.rgb[0] + (d.rgb[0] - a.rgb[0]) * f, a.rgb[1] + (d.rgb[1] - a.rgb[1]) * f, a.rgb[2] + (d.rgb[2] - a.rgb[2]) * f] };
  }
  function consolePos() { // current track position (ms), from the playing audio cursor else the show clock
    var tl = consoleTimeline; if (!tl || !tl.durationMs) return null;
    var dur = tl.durationMs;
    if (audio && audio.isLive && audio.isLive() && audio.playedMs) { var pm = audio.playedMs(); if (pm != null && pm >= 0) return ((pm % dur) + dur) % dur; }
    if (curState === 'running' && lastT0 != null && clock && clock.ready) return ((clock.serverNow() - lastT0) % dur + dur) % dur;
    return null;
  }
  function simLoudness() {
    if (curState !== 'running' || armedId == null) return 0;
    var p = consolePos(); if (p == null) return 0;
    var c = sampleCueAt(p); return c ? c.b : 0;
  }
  function rgbHue(r, g, b) { r /= 255; g /= 255; b /= 255; var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 1e-6) return 0; var h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h; }
  function pvReset() {
    var pv = window.__opPreview;
    pv.frames = 0; pv.maxLum = 0; pv.minLum = 1; pv.hueMin = 360; pv.hueMax = 0; pv.hueSpread = 0; pv.cross = []; pv._armed = true; pv.changeSeq++;
    pvBackstop = PV ? PV.makeBackstop(150) : null; pvT0 = null;
    if (pvCtx && pvCanvas.width) pvCtx.clearRect(0, 0, pvCanvas.width, pvCanvas.height);
  }
  function pvShow(on) { var w = $('presetPreviewWrap'); if (w) w.className = on ? '' : 'hidden'; }
  // The Live preview under Start/Stop (pt 7): the crowd's current screen colour when RUNNING with an
  // active preset; steady black when idle/stopped/blackout (no music reaction in silence).
  function mainPreviewFrame() {
    var mp = $('mainPreview'); if (!mp) return; var mc = mp.getContext ? mp.getContext('2d') : null; if (!mc) return;
    if (!mp.width || mp.width < 8) { mp.width = mp.clientWidth || 320; mp.height = 48; }
    var bg = '#000', lvl = 0;
    if (curState === 'running') {
      if (activeType && window.__opPreview && window.__opPreview.lastBg) { bg = window.__opPreview.lastBg; lvl = window.__opPreview.maxLum || 0; } // a preset overlay drives the crowd screen
      else { var p = consolePos(), c = p != null ? sampleCueAt(p) : null; if (c) { bg = 'rgb(' + Math.round(c.rgb[0] * c.b) + ',' + Math.round(c.rgb[1] * c.b) + ',' + Math.round(c.rgb[2] * c.b) + ')'; lvl = c.b; } } // round 13 (pt 4): no preset -> show the music-reactive TIMELINE colour the crowd sees
    }
    mc.fillStyle = bg; mc.fillRect(0, 0, mp.width, mp.height);
    window.__opMainPv = { bg: bg, level: lvl, running: curState === 'running', hasTimeline: !!consoleTimeline }; // test seam (pt 4)
  }
  function pvFrame(now) {
    requestAnimationFrame(pvFrame);
    mainPreviewFrame(); // round 11 (pt 7): the small Live preview under Start/Stop
    seekTick();          // round 13 (pt 7): keep the seek slider following the play position
    if (!pvCtx || !PV || !activeType || !presetSchema || !presetSchema[activeType]) return;
    if (!pvCanvas.width || pvCanvas.width < 8) { pvCanvas.width = pvCanvas.clientWidth || 320; pvCanvas.height = 56; }
    if (pvT0 == null) { pvT0 = now; pvLast = now; }
    var ms = now - pvT0, dt = Math.max(1, now - pvLast); pvLast = now;
    var rgb = PV.clampColor(PV.PRESETS[activeType](ms, activeParams, 0, 1, simLoudness()));
    if (pvBackstop) rgb = pvBackstop(rgb, dt);
    var w = pvCanvas.width, h = pvCanvas.height, col = 3;
    try { var img = pvCtx.getImageData(col, 0, w - col, h); pvCtx.putImageData(img, 0, 0); } catch (e) {}
    var bg = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    pvCtx.fillStyle = bg; pvCtx.fillRect(w - col, 0, col, h);
    var pv = window.__opPreview, L = PV.relLum(rgb);
    pv.frames++; pv.type = activeType; pv.lastBg = bg;
    if (L > pv.maxLum) pv.maxLum = L; if (L < pv.minLum) pv.minLum = L;
    if (L > 0.1) { var hue = rgbHue(rgb[0], rgb[1], rgb[2]); if (hue < pv.hueMin) pv.hueMin = hue; if (hue > pv.hueMax) pv.hueMax = hue; pv.hueSpread = pv.hueMax - pv.hueMin; }
    if (L < 0.25) pv._armed = true; else if (L >= 0.6 && pv._armed) { pv._armed = false; pv.cross.push(ms); }
    while (pv.cross.length && ms - pv.cross[0] > 1000) pv.cross.shift();
    pv.flashesPerSec = pv.cross.length;
  }
  requestAnimationFrame(pvFrame);
  function highlightPreset() {
    Array.prototype.forEach.call($('presetBtns').querySelectorAll('button'), function (b) {
      var t = b.getAttribute('data-preset');
      b.className = (t === activeType) ? 'primary' : (t === 'off' ? 'ghost' : '');
    });
  }
  function renderParams() {
    var wrap = $('presetParams'); wrap.innerHTML = '';
    if (!activeType || !presetSchema[activeType]) return;
    var ps = presetSchema[activeType].params;
    Object.keys(ps).forEach(function (k) {
      var spec = ps[k];
      var row = document.createElement('div'); row.className = 'nudge';
      var lab = document.createElement('span'); lab.textContent = spec.label; lab.style.minWidth = '110px';
      var inp = document.createElement('input'); inp.type = 'range'; inp.min = spec.min; inp.max = spec.max; inp.step = spec.step;
      inp.value = activeParams[k] != null ? activeParams[k] : spec.def;
      var val = document.createElement('span'); val.textContent = inp.value; val.style.minWidth = '52px';
      inp.addEventListener('input', function () { val.textContent = inp.value; activeParams[k] = Number(inp.value); sendParam(k, Number(inp.value)); });
      row.appendChild(lab); row.appendChild(inp); row.appendChild(val); wrap.appendChild(row);
    });
    updateReactHint();
  }
  function updateReactHint() {
    var el = $('reactHint'); if (!el) return;
    if (!activeType || activeType === 'off') { el.textContent = ''; return; }
    var running = curState === 'running' && armedId != null;
    el.textContent = running
      ? '🎵 Reacting to the running track — raise “Music reactivity” to taste.'
      : '🎵 Music reactivity needs a track: arm + GO a track above, then raise it.';
  }
  var paramTimer = null, pendingParam = {};
  function sendParam(k, v) {
    if (window.__opPreview) window.__opPreview.changeSeq++;
    pendingParam[k] = v; if (paramTimer) return;
    paramTimer = setTimeout(function () {
      var pp = pendingParam; pendingParam = {}; paramTimer = null;
      Object.keys(pp).forEach(function (key) {
        api('/api/operator/preset/param', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, value: pp[key] }) });
      });
    }, 80);
  }
  function pickPreset(type) {
    ga('preset_changed', { channel: 'screen', preset_type: type });
    if (type === 'off') {
      activeType = null; $('presetParams').innerHTML = ''; highlightPreset();
      window.__opPreview.type = null; pvShow(false);
      api('/api/operator/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'off' }) });
      $('presetMsg').textContent = 'Presets off.'; return;
    }
    activeType = type; activeParams = defParams(type); renderParams(); highlightPreset();
    pvReset(); pvShow(true);
    api('/api/operator/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: type, params: activeParams }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { $('presetMsg').textContent = j.ok ? ('● LIVE: ' + presetSchema[type].label + ' — epoch ' + j.epoch) : ('Error: ' + (j.error || '')); });
  }
  function loadPresets() {
    api('/api/operator/presets').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return; presetSchema = d.schema;
      var box = $('presetBtns'); box.innerHTML = '';
      d.types.forEach(function (type) {
        var b = document.createElement('button'); b.style.width = 'auto'; b.textContent = d.schema[type].label; b.setAttribute('data-preset', type); box.appendChild(b);
      });
      var off = document.createElement('button'); off.style.width = 'auto'; off.className = 'ghost'; off.textContent = '■ Off'; off.setAttribute('data-preset', 'off'); box.appendChild(off);
      if (d.active && d.active.type && d.active.type !== 'off') { activeType = d.active.type; activeParams = Object.assign({}, d.active.params); renderParams(); pvReset(); pvShow(true); }
      else if (PUBLIC && DEFAULTS && DEFAULTS.screen && DEFAULTS.screen.type && DEFAULTS.screen.type !== 'off') { pickPreset(DEFAULTS.screen.type); } // public: start on the host's default look (round 13 pt 8: 'off' => Live presets default OFF, lights run the timeline)
      highlightPreset();
      setupTorch(d);
      setupFx(d); // round 13 (pt 5): the Special-effects buttons
      // round 10: public console auto-picks the host's default REACTIVE torch (beat) so the
      // flash channel is alive on open too (mirror of the screen auto-pick above). Gated on
      // FEAT.torch so a host who disabled torch isn't overridden.
      if (PUBLIC && FEAT.torch !== false && DEFAULTS && DEFAULTS.torch && DEFAULTS.torch.type && DEFAULTS.torch.type !== 'off' && !activeTorch) pickTorch(DEFAULTS.torch.type);
      pcApplyPresetDefaults(); // schemas now loaded -> fill the default-preset pickers (operator console)
    });
  }
  if ($('presetBtns')) $('presetBtns').addEventListener('click', function (e) { var t = e.target.getAttribute('data-preset'); if (t) pickPreset(t); });

  // ======================= TORCH channel (round 8B) — operator UI =======================
  var torchSchema = null, activeTorch = null, activeTorchParams = {};
  function torchDefParams(type) { var o = {}, ps = (torchSchema[type] && torchSchema[type].params) || {}; for (var k in ps) o[k] = ps[k].def; return o; }
  function highlightTorch() {
    Array.prototype.forEach.call($('torchBtns').querySelectorAll('button'), function (b) {
      var t = b.getAttribute('data-torch'); b.className = (t === (activeTorch || 'off')) ? 'primary' : (t === 'off' ? 'ghost' : '');
    });
  }
  function setupTorch(d) {
    torchSchema = d.torchSchema || {};
    var box = $('torchBtns'); if (!box) return; box.innerHTML = '';
    (d.torchTypes || []).forEach(function (type) {
      if (type === 'off') return;
      var b = document.createElement('button'); b.style.width = 'auto'; b.textContent = (torchSchema[type] && torchSchema[type].label) || type; b.setAttribute('data-torch', type); box.appendChild(b);
    });
    var off = document.createElement('button'); off.style.width = 'auto'; off.className = 'ghost'; off.textContent = '■ Off'; off.setAttribute('data-torch', 'off'); box.appendChild(off);
    if (d.torchActive && d.torchActive.type && d.torchActive.type !== 'off') {
      activeTorch = d.torchActive.type; activeTorchParams = Object.assign({}, d.torchActive.params); renderTorchParams(); tpvReset(); tpvShow(true);
    }
    highlightTorch();
  }
  // round 13 (pt 5): the Special-effects (firework) buttons — fired over HTTP via tx(), which routes to
  // /api/operator/fx (main) or /api/console/fx (room) — identical on both consoles. No params -> safe.
  function setupFx(d) {
    var box = $('fxBtns'); if (!box || !d.fxNames) return; box.innerHTML = '';
    d.fxNames.forEach(function (name) {
      var b = document.createElement('button'); b.style.width = 'auto';
      b.textContent = '🎆 ' + ((d.fxLabels && d.fxLabels[name]) || name); b.setAttribute('data-fx', name); box.appendChild(b);
    });
  }
  function triggerFx(name) {
    ga('fx_fired', { fx_name: name });
    tx('fx', { name: name }).then(function (j) {
      if ($('fxMsg')) $('fxMsg').textContent = (j && j.ok) ? ('🎆 ' + name + ' — ' + Math.round((j.durationMs || 0) / 1000) + 's') : tr('console.fx_err', 'Could not fire — try again');
    });
  }
  if ($('fxBtns')) $('fxBtns').addEventListener('click', function (e) { var n = e.target.getAttribute('data-fx'); if (n) triggerFx(n); });
  function renderTorchParams() {
    var wrap = $('torchParams'); wrap.innerHTML = '';
    if (!activeTorch || !torchSchema[activeTorch]) return;
    var ps = torchSchema[activeTorch].params;
    Object.keys(ps).forEach(function (k) {
      var spec = ps[k];
      var row = document.createElement('div'); row.className = 'nudge';
      var lab = document.createElement('span'); lab.textContent = spec.label; lab.style.minWidth = '110px';
      var inp = document.createElement('input'); inp.type = 'range'; inp.min = spec.min; inp.max = spec.max; inp.step = spec.step;
      inp.value = activeTorchParams[k] != null ? activeTorchParams[k] : spec.def;
      var val = document.createElement('span'); val.textContent = inp.value; val.style.minWidth = '52px';
      inp.addEventListener('input', function () { val.textContent = inp.value; activeTorchParams[k] = Number(inp.value); sendTorchParam(k, Number(inp.value)); });
      row.appendChild(lab); row.appendChild(inp); row.appendChild(val); wrap.appendChild(row);
    });
  }
  var torchParamTimer = null, pendingTorch = {};
  function sendTorchParam(k, v) {
    if (window.__opTorchPreview) window.__opTorchPreview.changeSeq++;
    pendingTorch[k] = v; if (torchParamTimer) return;
    torchParamTimer = setTimeout(function () {
      var pp = pendingTorch; pendingTorch = {}; torchParamTimer = null;
      Object.keys(pp).forEach(function (key) {
        api('/api/operator/preset/param', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'torch', key: key, value: pp[key] }) });
      });
    }, 80);
  }
  function pickTorch(type) {
    ga('preset_changed', { channel: 'torch', preset_type: type });
    if (type === 'off') {
      activeTorch = null; $('torchParams').innerHTML = ''; highlightTorch();
      if (window.__opTorchPreview) window.__opTorchPreview.type = null; tpvShow(false);
      api('/api/operator/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'torch', type: 'off' }) });
      $('torchMsg').textContent = 'Flash off.'; return;
    }
    activeTorch = type; activeTorchParams = torchDefParams(type); renderTorchParams(); highlightTorch(); tpvReset(); tpvShow(true);
    api('/api/operator/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'torch', type: type, params: activeTorchParams }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { $('torchMsg').textContent = j.ok ? ('⚡ LIVE flash: ' + (torchSchema[type].label || type) + ' — epoch ' + j.epoch) : ('Error: ' + (j.error || '')); });
  }
  if ($('torchBtns')) $('torchBtns').addEventListener('click', function (e) { var t = e.target.getAttribute('data-torch'); if (t) pickTorch(t); });

  var TPV = window.CLS_PRESETS, tpvCanvas = $('torchPreview'), tpvCtx = tpvCanvas ? tpvCanvas.getContext('2d') : null;
  var tpvGate = null, tpvT0 = null, tpvLast = 0, tpvAGC = null;
  // round 13 (pt 3): mirror the phone's torch AGC so the preview shows the SAME even reactivity + invert.
  function makeTorchAGC() {
    var F = 0, C = 0, prevX = 0, init = false; var MIN_SPAN = 0.05, FLUXGAIN = 6;
    function k(tauS, dtMs) { return 1 - Math.exp(-(dtMs / 1000) / Math.max(0.001, tauS)); }
    return function (raw, dtMs) {
      raw = Math.max(0, Math.min(1, raw || 0)); dtMs = Math.max(1, Math.min(100, dtMs || 16));
      if (!init) { F = raw; C = raw; prevX = 0; init = true; }
      F += (raw > F ? k(3.0, dtMs) : k(0.15, dtMs)) * (raw - F);
      C += (raw > C ? k(0.10, dtMs) : k(2.0, dtMs)) * (raw - C);
      var span = Math.max(MIN_SPAN, C - F), norm = Math.max(0, Math.min(1, (raw - F) / span));
      var flux = Math.max(0, Math.min(1, (norm - prevX) * FLUXGAIN)); prevX = norm;
      return Math.max(0, Math.min(1, 0.55 * norm + 0.45 * flux));
    };
  }
  window.__opTorchPreview = { ready: !!(TPV && TPV.TORCH_PRESETS), type: null, frames: 0, changeSeq: 0, onFrac: 0, flashesPerSec: 0, _on: 0, _onCount: 0, cross: [], _prev: 0 };
  function tpvReset() { var p = window.__opTorchPreview; p.frames = 0; p._onCount = 0; p.cross = []; p._prev = 0; p.changeSeq++; tpvGate = (TPV && TPV.makeTorchGate) ? TPV.makeTorchGate(1000 / 2.8) : null; tpvAGC = makeTorchAGC(); tpvT0 = null; if (tpvCtx && tpvCanvas.width) tpvCtx.clearRect(0, 0, tpvCanvas.width, tpvCanvas.height); }
  function tpvShow(on) { var w = $('torchPreviewWrap'); if (w) w.className = on ? '' : 'hidden'; }
  function tpvFrame(now) {
    requestAnimationFrame(tpvFrame);
    if (!tpvCtx || !TPV || !TPV.TORCH_PRESETS || !activeTorch || !torchSchema || !torchSchema[activeTorch]) return;
    if (!tpvCanvas.width || tpvCanvas.width < 8) { tpvCanvas.width = tpvCanvas.clientWidth || 320; tpvCanvas.height = 40; }
    if (tpvT0 == null) { tpvT0 = now; tpvLast = now; }
    var ms = now - tpvT0, dt = Math.max(1, now - tpvLast); tpvLast = now;
    var intensity = TPV.TORCH_PRESETS[activeTorch](ms, activeTorchParams, 0, 1, simLoudness());
    var excite = (tpvAGC && activeTorch === 'beat') ? tpvAGC(intensity, dt) : intensity; // round 13 (pt 3): AGC the reactive torch
    if (activeTorchParams && activeTorchParams.torchInvert) excite = 1 - excite;
    var on = tpvGate ? tpvGate(excite >= 0.5, dt) : (excite >= 0.5 ? 1 : 0);
    var w = tpvCanvas.width, h = tpvCanvas.height, col = 3;
    try { var img = tpvCtx.getImageData(col, 0, w - col, h); tpvCtx.putImageData(img, 0, 0); } catch (e) {}
    tpvCtx.fillStyle = on ? '#ffe9a8' : '#0a0a0a'; tpvCtx.fillRect(w - col, 0, col, h);
    var pv = window.__opTorchPreview; pv.frames++; pv.type = activeTorch;
    if (on) pv._onCount++; pv.onFrac = pv._onCount / pv.frames;
    if (on && !pv._prev) pv.cross.push(ms); pv._prev = on;
    while (pv.cross.length && ms - pv.cross[0] > 1000) pv.cross.shift();
    pv.flashesPerSec = pv.cross.length;
  }
  requestAnimationFrame(tpvFrame);

  // round 11 (pt 20): re-render the JS-driven dynamic strings when the user switches language.
  // The static chrome (data-i18n) is re-applied by site-i18n.js itself; here we only refresh the
  // labels that JS owns (Start/Pause/Resume, mute, the state pill, the public title/welcome).
  window.addEventListener('cls-langchange', function () {
    try {
      setPlayUI(playUiState);
      if ($('muteBtn')) $('muteBtn').textContent = consoleMuted ? tr('console.unmute', '🔇 Unmute music') : tr('console.mute', '🔊 Mute music');
      if ($('state')) $('state').textContent = tr('console.state.' + curState, curState);
      if (PUBLIC) {
        var title = $('consoleTitle'); if (title) title.textContent = (S.brand || 'Light Show') + tr('console.title_suffix', ' — live console');
        var pw = $('pubWelcome'); if (pw && !S.welcome) pw.textContent = tr('console.welcome_default', pw.textContent);
      }
    } catch (e) {}
  });

  // ===== round 14: VJ pult — live manual control (saturation / colour / brightness / flash), four
  // touch-first widget variants in tabs, fullscreen, a palette restriction, and optional WebMIDI. It
  // emits through tx('manual'/'palette') — WS 'op' on /operator, HTTP on /studio — RAF-coalesced to
  // ~20 Hz. The epilepsy governors live on the PHONE; the pult is just input. =====
  function setupVJ() {
    var stage = $('vjStage'); if (!stage) return;
    var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
    var st = { hue: 200, sat: 1, bri: 0.9, flash: 0 };
    var vjOn = false, vjMode = 'intervene', tab = 'faders';
    var palette = { on: false, colors: [] };
    window.__opVJ = { on: false, mode: 'intervene', hue: 200, sat: 1, bri: 0.9, flash: 0, palette: palette, tab: 'faders' }; // test seam

    var dirty = false, raf = false, lastSent = 0, MIN = 50; // ~20 Hz
    function emit() {
      raf = false; if (!dirty) return; var nowt = (window.performance ? performance.now() : Date.now());
      if (nowt - lastSent < MIN) { raf = true; requestAnimationFrame(emit); return; }
      lastSent = nowt; dirty = false;
      tx('manual', { on: vjOn, mode: vjMode, hue: st.hue, sat: st.sat, bri: st.bri, flash: st.flash });
      var s = window.__opVJ; s.on = vjOn; s.mode = vjMode; s.hue = st.hue; s.sat = st.sat; s.bri = st.bri; s.flash = st.flash; s.tab = tab;
    }
    function push() { dirty = true; if (!raf) { raf = true; requestAnimationFrame(emit); } readout(); paint(); }
    function readout() { var r = $('vjReadout'); if (r) r.textContent = (vjOn ? '● LIVE  ' : '○ off  ') + 'hue ' + Math.round(st.hue) + '° · sat ' + Math.round(st.sat * 100) + '% · bri ' + Math.round(st.bri * 100) + '% · flash ' + Math.round(st.flash * 100) + '%  ·  ' + (vjMode === 'full' ? 'manual only (presets off)' : 'intervene in preset'); }

    function bindDrag(el, onMove, onDown, onUp) {
      el.addEventListener('pointerdown', function (e) { try { el.setPointerCapture(e.pointerId); } catch (x) {} el.__cap = e.pointerId; if (onDown) onDown(e); onMove(e); e.preventDefault(); });
      el.addEventListener('pointermove', function (e) { if (el.__cap == null) return; onMove(e); });
      function end(e) { if (el.__cap == null) return; el.__cap = null; try { el.releasePointerCapture(e.pointerId); } catch (x) {} if (onUp) onUp(e); }
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', function () { el.__cap = null; if (onUp) onUp(); });
    }
    function killFlash() { if (st.flash !== 0) { st.flash = 0; push(); } } // dropped finger / backgrounded tab must never leave the crowd strobing
    window.addEventListener('blur', killFlash);
    document.addEventListener('visibilitychange', function () { if (document.hidden) killFlash(); });
    // round 14 fix: best-effort release of the manual override + palette when the console tab closes, so a
    // /studio guest leaving doesn't freeze the crowd on their last frame. (On /operator the server also
    // releases on the WS drop; this covers the HTTP-only /studio path where there is no operator socket.)
    window.addEventListener('pagehide', function () { try { if (vjOn) tx('manual', { on: false, mode: vjMode, hue: st.hue, sat: st.sat, bri: st.bri, flash: 0 }); if (palette.on) tx('palette', { on: false, colors: [] }); } catch (e) {} });

    var painters = [];
    function paint() { for (var i = 0; i < painters.length; i++) { try { painters[i](); } catch (e) {} } }
    function clearStage() { painters = []; stage.innerHTML = ''; }

    var HUEGRAD = 'linear-gradient(to top,' + [0, 60, 120, 180, 240, 300, 360].map(function (h) { return 'hsl(' + h + ',100%,50%)'; }).join(',') + ')';
    function vFader(label, get, set, grad, isHue) {
      var col = document.createElement('div'); col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;min-width:56px';
      var track = document.createElement('div'); track.style.cssText = 'position:relative;width:52px;height:170px;border-radius:12px;background:' + (grad || '#1b2030') + ';border:1px solid rgba(255,255,255,.15);touch-action:none;overflow:hidden;cursor:ns-resize';
      var fill = document.createElement('div'); if (!grad) fill.style.cssText = 'position:absolute;left:0;right:0;bottom:0;background:rgba(120,160,255,.30)';
      var thumb = document.createElement('div'); thumb.style.cssText = 'position:absolute;left:3px;right:3px;height:26px;border-radius:8px;background:#eaf2ff;box-shadow:0 1px 5px rgba(0,0,0,.6)';
      if (!grad) track.appendChild(fill); track.appendChild(thumb);
      var lab = document.createElement('div'); lab.style.cssText = 'font:600 12px system-ui;color:#cfd6e6'; lab.textContent = label;
      var val = document.createElement('div'); val.style.cssText = 'font:600 12px system-ui;color:#9fb0cc';
      col.appendChild(lab); col.appendChild(track); col.appendChild(val);
      bindDrag(track, function (e) { var r = track.getBoundingClientRect(); set(clamp01((r.bottom - e.clientY) / r.height)); push(); });
      painters.push(function () { var v = get(); thumb.style.bottom = (v * (170 - 26)) + 'px'; if (!grad) fill.style.height = (v * 170) + 'px'; val.textContent = isHue ? Math.round(v * 360) + '°' : Math.round(v * 100) + '%'; });
      return col;
    }
    var satF = function () { return vFader('Sat', function () { return st.sat; }, function (v) { st.sat = v; }); };
    var hueF = function () { return vFader('Hue', function () { return st.hue / 360; }, function (v) { st.hue = v * 360; }, HUEGRAD, true); };
    var briF = function () { return vFader('Bri', function () { return st.bri; }, function (v) { st.bri = v; }); };
    var flashF = function () { return vFader('Flash', function () { return st.flash; }, function (v) { st.flash = v; }); };

    function row(children) { var d = document.createElement('div'); d.style.cssText = 'display:flex;gap:10px;align-items:stretch;justify-content:center'; children.forEach(function (c) { d.appendChild(c); }); return d; }

    // colour wheel: angle -> hue, radius -> sat. Drawn once to a canvas; a cursor dot moves over it.
    function wheel() {
      var box = document.createElement('div'); box.style.cssText = 'position:relative;width:200px;height:200px;flex:0 0 auto';
      var cv = document.createElement('canvas'); cv.width = 200; cv.height = 200; cv.style.cssText = 'width:200px;height:200px;border-radius:50%;touch-action:none;cursor:crosshair';
      var dot = document.createElement('div'); dot.style.cssText = 'position:absolute;width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 4px #000;pointer-events:none;transform:translate(-50%,-50%)';
      box.appendChild(cv); box.appendChild(dot);
      var cx = 100, cy = 100, R = 98, cc = cv.getContext('2d'), img = cc.createImageData(200, 200), D = img.data;
      for (var y = 0; y < 200; y++) for (var x = 0; x < 200; x++) { var dx = x - cx, dy = y - cy, dist = Math.sqrt(dx * dx + dy * dy), i4 = (y * 200 + x) * 4; if (dist > R) { D[i4 + 3] = 0; continue; } var h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, s = Math.min(1, dist / R); var rgb = (window.CLS_PRESETS ? window.CLS_PRESETS.hsl2rgb(h, s, 0.5) : [0, 0, 0]); D[i4] = rgb[0]; D[i4 + 1] = rgb[1]; D[i4 + 2] = rgb[2]; D[i4 + 3] = 255; }
      cc.putImageData(img, 0, 0);
      bindDrag(cv, function (e) { var r = cv.getBoundingClientRect(); var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2); st.hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; st.sat = clamp01(Math.sqrt(dx * dx + dy * dy) / (r.width / 2)); push(); });
      painters.push(function () { var a = st.hue * Math.PI / 180, rr = st.sat * R; dot.style.left = (cx + rr * Math.cos(a)) + 'px'; dot.style.top = (cy + rr * Math.sin(a)) + 'px'; });
      return box;
    }
    // XY pad: x -> hue, y -> brightness. Background painted as a hue x value gradient.
    function xyPad() {
      var box = document.createElement('div'); box.style.cssText = 'position:relative;width:210px;height:180px;flex:0 0 auto;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.15);touch-action:none;background:' +
        'linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,' + [0, 60, 120, 180, 240, 300, 360].map(function (h) { return 'hsl(' + h + ',100%,50%)'; }).join(',') + ')';
      var dot = document.createElement('div'); dot.style.cssText = 'position:absolute;width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 4px #000;pointer-events:none;transform:translate(-50%,-50%)';
      box.appendChild(dot);
      bindDrag(box, function (e) { var r = box.getBoundingClientRect(); st.hue = clamp01((e.clientX - r.left) / r.width) * 360; st.bri = clamp01((r.bottom - e.clientY) / r.height); push(); });
      painters.push(function () { dot.style.left = (st.hue / 360 * 210) + 'px'; dot.style.top = ((1 - st.bri) * 180) + 'px'; });
      return box;
    }
    // momentary flash pad: hold -> flash on, release -> off (double-tap latches)
    function flashPad() {
      var pad = document.createElement('div'); pad.style.cssText = 'width:120px;height:180px;border-radius:14px;background:#241a10;border:1px solid rgba(255,200,80,.4);display:flex;align-items:center;justify-content:center;font:700 14px system-ui;color:#ffd98a;text-align:center;touch-action:none;cursor:pointer;flex:0 0 auto';
      pad.textContent = 'FLASH\n(hold)'; pad.style.whiteSpace = 'pre-line'; var latched = false;
      bindDrag(pad, function (e) { var r = pad.getBoundingClientRect(); st.flash = clamp01((r.bottom - e.clientY) / r.height) || 1; if (st.flash < 0.2) st.flash = 1; pad.style.background = '#ffd98a'; push(); },
        function () { st.flash = 1; pad.style.background = '#ffd98a'; push(); },
        function () { if (!latched) { st.flash = 0; pad.style.background = '#241a10'; push(); } });
      pad.addEventListener('dblclick', function () { latched = !latched; pad.style.outline = latched ? '3px solid #ffd98a' : 'none'; if (!latched) { st.flash = 0; pad.style.background = '#241a10'; push(); } });
      return pad;
    }
    function bigPad(label, color, onHold, latch) {
      var pad = document.createElement('div'); pad.style.cssText = 'flex:1;min-width:120px;height:84px;border-radius:14px;background:' + color + ';border:1px solid rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font:700 14px system-ui;color:#06121f;text-align:center;touch-action:none;cursor:pointer';
      pad.textContent = label; var lt = false;
      bindDrag(pad, function () {}, function () { if (latch) { lt = !lt; pad.style.outline = lt ? '3px solid #fff' : 'none'; onHold(lt); } else { onHold(true); pad.style.filter = 'brightness(1.3)'; } }, function () { if (!latch) { onHold(false); pad.style.filter = 'none'; } });
      return pad;
    }
    function hueSwatches() {
      var box = document.createElement('div'); box.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px';
      [0, 30, 60, 120, 180, 210, 270, 300].forEach(function (h) {
        var s = document.createElement('button'); s.style.cssText = 'width:38px;height:38px;border-radius:50%;border:2px solid rgba(255,255,255,.3);background:hsl(' + h + ',100%,50%);cursor:pointer';
        s.addEventListener('click', function () { st.hue = h; st.sat = 1; push(); }); box.appendChild(s);
      });
      return box;
    }

    function buildTab() {
      clearStage();
      if (tab === 'faders') { stage.appendChild(row([satF(), hueF(), briF(), flashF()])); }
      else if (tab === 'wheel') { stage.appendChild(row([wheel(), briF(), flashF()])); }
      else if (tab === 'xy') { stage.appendChild(row([satF(), xyPad(), flashPad()])); }
      else { // big pads
        var wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
        var r1 = document.createElement('div'); r1.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
        r1.appendChild(bigPad('FLASH (hold)', '#ffd98a', function (v) { st.flash = v ? 1 : 0; push(); }, false));
        r1.appendChild(bigPad('WHITE STAB', '#ffffff', function (v) { if (v) { st.sat = 0; st.bri = 1; } push(); }, false));
        r1.appendChild(bigPad('BLACK (hold)', '#33405a', function (v) { st._sav = v ? st.bri : st._sav; st.bri = v ? 0 : (st._sav != null ? st._sav : st.bri); push(); }, false));
        r1.appendChild(bigPad('FULL (latch)', '#8ad', function (v) { st.bri = v ? 1 : 0.6; push(); }, true));
        wrap.appendChild(r1); wrap.appendChild(hueSwatches());
        wrap.appendChild(row([vFader('Bri', function () { return st.bri; }, function (v) { st.bri = v; }), vFader('Sat', function () { return st.sat; }, function (v) { st.sat = v; })]));
        stage.appendChild(wrap);
      }
      paint();
    }

    // ---- tabs ----
    if ($('vjTabs')) $('vjTabs').addEventListener('click', function (e) { var t = e.target.getAttribute('data-vjtab'); if (!t) return; tab = t; Array.prototype.forEach.call($('vjTabs').children, function (b) { b.className = (b.getAttribute('data-vjtab') === t) ? 'on' : ''; }); buildTab(); });
    // ---- enable / mode ----
    // round 15 (#3): the manual widgets (tabs + stage + readout + mode/fullscreen) only mean anything when
    // manual control is ON — hide them when it's OFF so the user understands what they belong to. The
    // palette/flags section and MIDI stay visible (they work independently of the manual controls).
    function showManualUI(v) {
      ['vjTabs', 'vjStage', 'vjReadout', 'vjModeBtn', 'vjFull'].forEach(function (id) { var el = $(id); if (el) el.style.display = v ? '' : 'none'; });
    }
    function setEnable(v) { vjOn = v; $('vjEnable').textContent = tr(v ? 'console.vj_on' : 'console.vj_off', v ? '● Manual control: ON' : 'Manual control: OFF'); $('vjEnable').className = v ? 'primary' : 'ghost'; $('vjEnable').style.width = 'auto'; showManualUI(v); push(); }
    if ($('vjEnable')) $('vjEnable').addEventListener('click', function () { setEnable(!vjOn); });
    if ($('vjModeBtn')) $('vjModeBtn').addEventListener('click', function () { vjMode = (vjMode === 'full') ? 'intervene' : 'full'; $('vjModeBtn').textContent = tr(vjMode === 'full' ? 'console.vj_mode_full' : 'console.vj_mode_intervene', vjMode === 'full' ? 'Mode: manual only (presets off)' : 'Mode: intervene in preset'); push(); });
    // ---- fullscreen ----
    if ($('vjFull')) $('vjFull').addEventListener('click', function () {
      var card = $('vjCard');
      if (document.fullscreenElement || document.webkitFullscreenElement) { var ex = document.exitFullscreen || document.webkitExitFullscreen; if (ex) ex.call(document); card.classList.remove('vj-faux-full'); return; }
      var fn = card.requestFullscreen || card.webkitRequestFullscreen;
      if (fn) {
        var p = fn.call(card); if (p && p['catch']) p['catch'](function () { card.classList.add('vj-faux-full'); });
        try { if (window.screen && screen.orientation && screen.orientation.lock) { var lp = screen.orientation.lock('landscape'); if (lp && lp['catch']) lp['catch'](function () {}); } } catch (e) {}
      } else { card.classList.add('vj-faux-full'); }
    });

    // ---- palette ----
    var PALS = [
      { n: '🇵🇱 Poland', c: [[255, 255, 255], [228, 0, 43]] },
      { n: '🇺🇦 Ukraine', c: [[0, 87, 183], [255, 221, 0]] },
      { n: '🇪🇺 EU', c: [[0, 51, 153], [255, 204, 0]] },
      { n: '🏳️‍🌈 Pride', c: [[228, 3, 3], [255, 140, 0], [255, 237, 0], [0, 128, 38], [0, 76, 255], [117, 7, 135]] },
      { n: '🇩🇪 DE', c: [[10, 10, 10], [221, 0, 0], [255, 206, 0]] },
      { n: '🔵 Cool', c: [[0, 90, 200], [0, 200, 220], [120, 80, 255]] },
      { n: '🔥 Warm', c: [[255, 60, 0], [255, 160, 0], [255, 30, 90]] }
    ];
    function swEl(c) { var s = document.createElement('span'); s.style.cssText = 'display:inline-block;width:16px;height:16px;border-radius:4px;margin-right:3px;vertical-align:middle;border:1px solid rgba(255,255,255,.25);background:rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; return s; }
    function sendPalette() { tx('palette', { on: palette.on, colors: palette.colors }); window.__opVJ.palette = { on: palette.on, colors: palette.colors }; var sw = $('vjPalSwatches'); if (sw) { sw.innerHTML = ''; palette.colors.forEach(function (c) { sw.appendChild(swEl(c)); }); } if ($('vjPalToggle')) { $('vjPalToggle').textContent = tr(palette.on ? 'console.vj_pal_on' : 'console.vj_pal_off', palette.on ? '● Palette: ON' : 'Palette: OFF'); $('vjPalToggle').className = palette.on ? 'primary' : 'ghost'; $('vjPalToggle').style.width = 'auto'; } }
    if ($('vjPalPresets')) PALS.forEach(function (p) { var b = document.createElement('button'); b.style.width = 'auto'; b.textContent = p.n; b.addEventListener('click', function () { palette = { on: true, colors: p.c.slice(0, 8) }; sendPalette(); }); $('vjPalPresets').appendChild(b); });
    function parseHex(s) { var out = []; (s || '').split(/[\s,]+/).forEach(function (t) { t = t.replace('#', '').trim(); if (/^[0-9a-fA-F]{3}$/.test(t)) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2]; if (/^[0-9a-fA-F]{6}$/.test(t) && out.length < 8) out.push([parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)]); }); return out; }
    if ($('vjPalApply')) $('vjPalApply').addEventListener('click', function () { var c = parseHex($('vjPalHex').value); if (c.length) { palette = { on: true, colors: c }; sendPalette(); } });
    if ($('vjPalToggle')) $('vjPalToggle').addEventListener('click', function () { palette.on = !palette.on && palette.colors.length > 0 ? true : false; if (!palette.colors.length) palette.on = false; sendPalette(); });

    // round 15 (#4): visual custom-palette builder — pick colours on a wheel (hue×sat) + a brightness
    // slider, add each to a custom set (removable chips), then "Use" applies it. The hex box stays as a
    // text alternative. Reuses the same P.hsl2rgb engine + bindDrag as the manual wheel.
    (function buildPalWheel() {
      var P = window.CLS_PRESETS;
      var host = $('vjPalWheel'); if (!host || !P || !P.hsl2rgb) return;
      var custom = [], pick = { hue: 210, sat: 1, l: 0.5 };
      var wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap';
      var box = document.createElement('div'); box.style.cssText = 'position:relative;width:130px;height:130px;flex:0 0 auto';
      var cv = document.createElement('canvas'); cv.width = 130; cv.height = 130; cv.className = 'vj-widget'; cv.style.cssText = 'width:130px;height:130px;border-radius:50%;touch-action:none;cursor:crosshair';
      var dot = document.createElement('div'); dot.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 4px #000;pointer-events:none;transform:translate(-50%,-50%)';
      box.appendChild(cv); box.appendChild(dot);
      var R = 63, cx = 65, cy = 65, cc = cv.getContext('2d'), img = cc.createImageData(130, 130), Dp = img.data;
      for (var y = 0; y < 130; y++) for (var x = 0; x < 130; x++) { var dx = x - cx, dy = y - cy, dist = Math.sqrt(dx * dx + dy * dy), i4 = (y * 130 + x) * 4; if (dist > R) { Dp[i4 + 3] = 0; continue; } var h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, s = Math.min(1, dist / R); var rgb = P.hsl2rgb(h, s, 0.5); Dp[i4] = rgb[0]; Dp[i4 + 1] = rgb[1]; Dp[i4 + 2] = rgb[2]; Dp[i4 + 3] = 255; }
      cc.putImageData(img, 0, 0);
      var col = document.createElement('div'); col.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:150px;flex:1';
      var sw = document.createElement('div'); sw.id = 'vjPickSwatch'; sw.style.cssText = 'width:100%;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,.2)';
      var briR = document.createElement('input'); briR.type = 'range'; briR.min = '0.1'; briR.max = '0.9'; briR.step = '0.01'; briR.value = '0.5'; briR.className = 'vj-widget'; briR.title = 'brightness';
      var addB = document.createElement('button'); addB.style.width = 'auto'; addB.id = 'vjPalAdd'; addB.textContent = tr('console.vj_pal_add', '＋ Add colour');
      col.appendChild(sw); col.appendChild(briR); col.appendChild(addB);
      wrap.appendChild(box); wrap.appendChild(col);
      var chips = document.createElement('div'); chips.id = 'vjPalChips'; chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center';
      var useB = document.createElement('button'); useB.style.width = 'auto'; useB.className = 'primary'; useB.textContent = tr('console.vj_pal_use', 'Use these colours');
      host.appendChild(wrap); host.appendChild(chips);
      function rgbNow() { return P.hsl2rgb(pick.hue, pick.sat, pick.l); }
      function refresh() { var c = rgbNow(); sw.style.background = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; var a = pick.hue * Math.PI / 180, rr = pick.sat * R; dot.style.left = (cx + rr * Math.cos(a)) + 'px'; dot.style.top = (cy + rr * Math.sin(a)) + 'px'; }
      function drawChips() { chips.innerHTML = ''; custom.forEach(function (c, i) { var bt = document.createElement('button'); bt.style.cssText = 'width:26px;height:26px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ');cursor:pointer'; bt.title = 'remove'; bt.addEventListener('click', function () { custom.splice(i, 1); drawChips(); }); chips.appendChild(bt); }); if (custom.length) chips.appendChild(useB); }
      bindDrag(cv, function (e) { var r = cv.getBoundingClientRect(); var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2); pick.hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; pick.sat = clamp01(Math.sqrt(dx * dx + dy * dy) / (r.width / 2)); refresh(); });
      briR.addEventListener('input', function () { pick.l = Number(briR.value); refresh(); });
      addB.addEventListener('click', function () { if (custom.length < 8) { custom.push(rgbNow()); drawChips(); } });
      useB.addEventListener('click', function () { if (custom.length) { palette = { on: true, colors: custom.slice() }; sendPalette(); } });
      refresh(); drawChips();
    })();

    // ---- WebMIDI (progressive enhancement; Chrome/Edge desktop) ----
    var midiMap = {}; try { midiMap = JSON.parse(localStorage.getItem('cls_midi_map') || '{}'); } catch (e) {}
    var learn = null;
    function onMidi(ev) {
      var status = ev.data[0] & 0xF0, d1 = ev.data[1], d2 = ev.data[2];
      if (status === 0xB0) { if (learn) { midiMap[d1] = learn; try { localStorage.setItem('cls_midi_map', JSON.stringify(midiMap)); } catch (e) {} if ($('vjMidiStatus')) $('vjMidiStatus').textContent = 'learned CC' + d1 + ' -> ' + learn; learn = null; return; } var name = midiMap[d1]; if (!name) return; var nz = d2 / 127; if (name === 'hue') st.hue = nz * 360; else st[name] = nz; if (!vjOn) setEnable(true); push(); }
      else if (status === 0x90 && d2 > 0) { st.flash = 1; if (!vjOn) setEnable(true); push(); }
      else if (status === 0x80 || (status === 0x90 && d2 === 0)) { st.flash = 0; push(); }
    }
    if ($('vjMidiConnect')) $('vjMidiConnect').addEventListener('click', function () {
      if (!navigator.requestMIDIAccess) { if ($('vjMidiStatus')) $('vjMidiStatus').textContent = 'Web MIDI not supported in this browser (use Chrome/Edge desktop)'; return; }
      navigator.requestMIDIAccess().then(function (access) {
        if ($('vjMidiStatus')) $('vjMidiStatus').textContent = 'connected — wiggle a fader after pressing Learn'; if ($('vjMidiLearn')) $('vjMidiLearn').className = 'row';
        access.inputs.forEach(function (inp) { inp.onmidimessage = onMidi; });
        access.onstatechange = function (e) { if (e.port.type === 'input' && e.port.state === 'connected') e.port.onmidimessage = onMidi; };
      })['catch'](function () { if ($('vjMidiStatus')) $('vjMidiStatus').textContent = 'MIDI permission denied'; });
    });
    if ($('vjMidiLearn')) $('vjMidiLearn').addEventListener('click', function (e) { var t = e.target.getAttribute('data-midilearn'); if (t) { learn = t; if ($('vjMidiStatus')) $('vjMidiStatus').textContent = 'learning ' + t + ' — move a control…'; } });

    buildTab(); readout(); showManualUI(vjOn); // round 15 (#3): start collapsed (manual OFF) — tabs appear on enable
  }

  // ---- boot ----
  window.__opMode = { mode: MODE, room: ROOM, features: FEAT }; // test seam
  // round 15 (#2): on a touchscreen PC a long-press pops the browser context menu over the controls and
  // blocks live VJ-ing. Suppress it on buttons, range sliders and the VJ pult widgets (NOT on links/text,
  // so right-click-to-copy the join URL still works).
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (t && t.closest && (t.closest('button') || t.closest('input[type=range]') || t.closest('#vjStage') || t.closest('.vj-widget'))) e.preventDefault();
  });
  if (PUBLIC) window.__opRefreshPublic = loadPublic; // test seam: re-fetch the room playlist (a real UI upload calls this via armTrack)
  applyMode();
  ga('studio_open', { is_public: !!PUBLIC });
  connect();
  loadPresets();
  setupVJ(); // round 14: the VJ pult (manual control + palette + MIDI)
  if (PUBLIC) { loadPublic(); }
  else { loadState(); loadApps(); loadPublicConfig(); setInterval(loadState, 8000); setInterval(loadApps, 20000); }
})();
