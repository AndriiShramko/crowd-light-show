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

  // ---- mode setup: hide features this session doesn't have, switch labels ----
  function applyMode() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-feature]'), function (el) {
      var f = el.getAttribute('data-feature');
      if (FEAT[f] === false || FEAT[f] === undefined) el.classList.add('hidden');
    });
    if (PUBLIC) {
      var title = $('consoleTitle'); if (title) title.textContent = (S.brand || 'Light Show') + ' — live console';
      var pw = $('pubWelcome'); if (pw) { pw.textContent = S.welcome || 'The lights are already running. Share the code below so phones join. Tap “Play with sound” to hear the music. It is free — anyone can run their own.'; pw.classList.remove('hidden'); }
      var pcc = $('pubCount'); if (pcc) pcc.classList.remove('hidden');
      var ph = $('playlistHint'); if (ph) ph.classList.remove('hidden');
      var pt = $('playlistTitle'); if (pt) pt.textContent = '1 · Music';
      if (FEAT.upload) { var ucw = $('uploadConsentWrap'); if (ucw) ucw.classList.remove('hidden'); var ub = $('upload'); if (ub) ub.textContent = 'Use my music'; }
      // ROUND 10 UX: collapse the 4 play-ish controls to ONE. Hide the dead native <audio>, the
      // redundant GO (the default track already auto-GOes the lights) and the old Sound button —
      // the single "▶ Play with sound" at the top is the one autoplay gesture.
      ['player', 'go', 'soundBtn'].forEach(function (id) { var e = $(id); if (e) e.classList.add('hidden'); });
      // Move Share to the top — it is the main goal (get phones into the room).
      var share = $('shareBlock'), cardPl = $('cardPlaylist');
      if (share && cardPl && cardPl.parentNode) cardPl.parentNode.insertBefore(share, cardPl);
      // Tuck the operator transport (pause/stop/blackout/nudge) + live presets/torch under an
      // "Advanced" disclosure — a casual host never needs them; one click reveals them.
      var cardShow = $('cardShow'), studioCard = $('studioCard');
      if (cardPl && cardShow && cardPl.parentNode) {
        var det = document.createElement('details'); det.className = 'op-adv';
        var sum = document.createElement('summary'); sum.textContent = '▸ Advanced — pause / stop, live presets & flash';
        det.appendChild(sum); det.appendChild(cardShow); if (studioCard) det.appendChild(studioCard);
        if (cardPl.nextSibling) cardPl.parentNode.insertBefore(det, cardPl.nextSibling); else cardPl.parentNode.appendChild(det);
      }
    }
  }

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
      pubTracks = d.tracks || [];
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
      // default music: auto-arm the default track (LIGHTS start now; SOUND waits for one tap)
      var def = (DEFAULTS && DEFAULTS.default_track_id) || (d.defaults && d.defaults.default_track_id);
      if (def && armedId == null) armTrack(Number(def), true);
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
    if (mode === 'selected') { plSelected = []; var cbs = document.querySelectorAll('[data-plsel]'); for (var i = 0; i < cbs.length; i++) if (cbs[i].checked) plSelected.push(Number(cbs[i].getAttribute('data-plsel'))); }
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
    if ($('state')) $('state').textContent = st.status;
    updateReactHint();
    // GA: one chokepoint for show start/stop — covers GO/resume/stop/blackout/track-end, personal+public.
    if (st.status === 'running' && prevState !== 'running') gaShowStarted(armedId);
    else if (st.status !== 'running' && prevState === 'running') gaShowStopped();
    if (pendingGo) return;
    var locking = (st.status === 'idle' && !(clock && clock.ready));
    if ($('go')) $('go').textContent = st.status === 'paused' ? '▶ RESUME' : (st.status === 'running' ? '● LIVE' : (locking ? '▶ GO (clock…)' : '▶ GO'));
  }

  if ($('tracks')) $('tracks').addEventListener('click', function (e) {
    var arm = e.target.getAttribute('data-arm'); var del = e.target.getAttribute('data-del');
    if (arm) armTrack(Number(arm));
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
      // public console: arm over HTTP (the server broadcasts timeline to the room; the console
      // gets it as a previewer). Then auto-GO so the default music's LIGHTS start with no clicks.
      tx('arm', { trackId: id }).then(function (j) {
        if (!j || !j.ok) { if ($('armed')) $('armed').textContent = 'could not start that track'; return; }
        if ($('armed')) $('armed').textContent = 'playing — lights live';
        loadPublic();
        fetchConsoleAudio(id); // round 10: curated AND guest uploads now have served audio (keep-and-serve)
        if (isDefault) setTimeout(function () { doGoPublic(); }, 250); // visuals roll immediately
      });
      return;
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'arm', trackId: id }));
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
  if ($('playSound')) $('playSound').addEventListener('click', startConsoleSound);

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
  if ($('blackout')) $('blackout').addEventListener('click', function () { flashBtn($('blackout')); if (audio) audio.stop(); tx('blackout', {}); });

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
      if (m.t === 'state') { renderState(m.state); syncLiveAudio(m.state); return; }
      return;
    }
    // ---- public console: derive transport state from the room messages it receives ----
    if (m.t === 'welcome' || m.t === 'state') { if (m.state) { renderState({ status: m.state.status }); if (m.state.status === 'running' && m.state.T0 != null) { pubT0 = m.state.T0; if (audio && soundOn) audio.start(pubT0); } } return; }
    if (m.t === 'index') { var n = Math.max(0, (m.total | 0) - 1); gaPeakUpdate(n); if ($('count2')) $('count2').textContent = n; if ($('countBig')) $('countBig').textContent = n; return; } // -1: the console itself is a member
    if (m.t === 'timeline') { var chg = (m.trackId !== pubTrackId); pubTrackId = m.trackId; if (chg && soundOn && typeof m.trackId === 'number') reloadConsoleSound(m.trackId); return; }
    if (m.t === 'playlist') { // round 10: the room advanced (or mode changed) — follow now/next
      plMode = m.mode || plMode; plNow = m.nowId; plNext = m.nextId;
      if (m.nowId != null && m.nowId !== armedId) { armedId = m.nowId; loadPublic(); } else renderPlaylistCtl();
      return;
    }
    if (m.t === 'start') { renderState({ status: 'running' }); pubT0 = m.T0; if (audio && soundOn) audio.start(m.T0); return; }
    if (m.t === 'pause') { renderState({ status: 'paused' }); if (audio) audio.stop(); return; }
    if (m.t === 'stop') { renderState({ status: 'idle' }); armedId = armedId; if (audio) audio.stop(); return; }
    if (m.t === 'blackout') { renderState({ status: 'blackout' }); if (audio) audio.stop(); return; }
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
    });
  }
  if ($('pcSave')) $('pcSave').addEventListener('click', function () {
    var body = { brand_name: $('pcBrand').value, welcome_text: $('pcWelcome').value, allow_torch: $('pcTorch').checked, default_track_id: $('pcTrack').value ? Number($('pcTrack').value) : null };
    if ($('pcUpload') && !$('pcUpload').disabled) body.allow_upload = $('pcUpload').checked;
    api('/api/operator/public-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).then(function (j) { $('pcMsg').textContent = j.ok ? 'Saved ✓' : ('Error: ' + (j.error || '')); setTimeout(function () { $('pcMsg').textContent = ''; }, 2500); });
  });

  // ---- live presets (studio) ----
  var presetSchema = null, activeType = null, activeParams = {};
  function defParams(type) { var o = {}, ps = presetSchema[type].params; for (var k in ps) o[k] = ps[k].def; return o; }

  var PV = window.CLS_PRESETS;
  var pvCanvas = $('presetPreview'), pvCtx = pvCanvas ? pvCanvas.getContext('2d') : null;
  var pvBackstop = null, pvT0 = null, pvLast = 0;
  window.__opPreview = { ready: !!PV, type: null, frames: 0, changeSeq: 0, maxLum: 0, minLum: 1, hueMin: 360, hueMax: 0, hueSpread: 0, flashesPerSec: 0, lastBg: '', cross: [], _armed: true };
  function simLoudness(ms) { var s = 0.10 + 0.30 * (0.5 + 0.5 * Math.sin(2 * Math.PI * ms / 1400)); var beat = (ms % 1400) < 110 ? 0.45 : 0; var v = s + beat; return v > 1 ? 1 : v; }
  function rgbHue(r, g, b) { r /= 255; g /= 255; b /= 255; var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 1e-6) return 0; var h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h; }
  function pvReset() {
    var pv = window.__opPreview;
    pv.frames = 0; pv.maxLum = 0; pv.minLum = 1; pv.hueMin = 360; pv.hueMax = 0; pv.hueSpread = 0; pv.cross = []; pv._armed = true; pv.changeSeq++;
    pvBackstop = PV ? PV.makeBackstop(150) : null; pvT0 = null;
    if (pvCtx && pvCanvas.width) pvCtx.clearRect(0, 0, pvCanvas.width, pvCanvas.height);
  }
  function pvShow(on) { var w = $('presetPreviewWrap'); if (w) w.className = on ? '' : 'hidden'; }
  function pvFrame(now) {
    requestAnimationFrame(pvFrame);
    if (!pvCtx || !PV || !activeType || !presetSchema || !presetSchema[activeType]) return;
    if (!pvCanvas.width || pvCanvas.width < 8) { pvCanvas.width = pvCanvas.clientWidth || 320; pvCanvas.height = 56; }
    if (pvT0 == null) { pvT0 = now; pvLast = now; }
    var ms = now - pvT0, dt = Math.max(1, now - pvLast); pvLast = now;
    var rgb = PV.clampColor(PV.PRESETS[activeType](ms, activeParams, 0, 1, simLoudness(ms)));
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
      else if (PUBLIC && DEFAULTS && DEFAULTS.screen && DEFAULTS.screen.type) { pickPreset(DEFAULTS.screen.type); } // public: start on the host's default look
      highlightPreset();
      setupTorch(d);
      // round 10: public console auto-picks the host's default REACTIVE torch (beat) so the
      // flash channel is alive on open too (mirror of the screen auto-pick above). Gated on
      // FEAT.torch so a host who disabled torch isn't overridden.
      if (PUBLIC && FEAT.torch !== false && DEFAULTS && DEFAULTS.torch && DEFAULTS.torch.type && DEFAULTS.torch.type !== 'off' && !activeTorch) pickTorch(DEFAULTS.torch.type);
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
  var tpvGate = null, tpvT0 = null, tpvLast = 0;
  window.__opTorchPreview = { ready: !!(TPV && TPV.TORCH_PRESETS), type: null, frames: 0, changeSeq: 0, onFrac: 0, flashesPerSec: 0, _on: 0, _onCount: 0, cross: [], _prev: 0 };
  function tpvReset() { var p = window.__opTorchPreview; p.frames = 0; p._onCount = 0; p.cross = []; p._prev = 0; p.changeSeq++; tpvGate = (TPV && TPV.makeTorchGate) ? TPV.makeTorchGate(1000 / 2.8) : null; tpvT0 = null; if (tpvCtx && tpvCanvas.width) tpvCtx.clearRect(0, 0, tpvCanvas.width, tpvCanvas.height); }
  function tpvShow(on) { var w = $('torchPreviewWrap'); if (w) w.className = on ? '' : 'hidden'; }
  function tpvFrame(now) {
    requestAnimationFrame(tpvFrame);
    if (!tpvCtx || !TPV || !TPV.TORCH_PRESETS || !activeTorch || !torchSchema || !torchSchema[activeTorch]) return;
    if (!tpvCanvas.width || tpvCanvas.width < 8) { tpvCanvas.width = tpvCanvas.clientWidth || 320; tpvCanvas.height = 40; }
    if (tpvT0 == null) { tpvT0 = now; tpvLast = now; }
    var ms = now - tpvT0, dt = Math.max(1, now - tpvLast); tpvLast = now;
    var intensity = TPV.TORCH_PRESETS[activeTorch](ms, activeTorchParams, 0, 1, simLoudness(ms));
    var on = tpvGate ? tpvGate(intensity >= 0.5, dt) : (intensity >= 0.5 ? 1 : 0);
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

  // ---- boot ----
  window.__opMode = { mode: MODE, room: ROOM, features: FEAT }; // test seam
  applyMode();
  ga('studio_open', { is_public: !!PUBLIC });
  connect();
  loadPresets();
  if (PUBLIC) { loadPublic(); }
  else { loadState(); loadApps(); loadPublicConfig(); setInterval(loadState, 8000); setInterval(loadApps, 20000); }
})();
