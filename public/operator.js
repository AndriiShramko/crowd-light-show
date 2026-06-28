(function () {
  'use strict';
  var TOKEN = window.__TOKEN__;
  var LEAD_MS = 900;
  var ws = null, clock = null, audioCtx = null, armedBuffer = null, armedId = null, source = null, nudge = 0;

  var $ = function (id) { return document.getElementById(id); };
  function api(path, opts) {
    opts = opts || {}; opts.headers = Object.assign({ Authorization: 'Bearer ' + TOKEN }, opts.headers || {});
    return fetch(path, opts);
  }
  function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); }

  function loadState() {
    api('/api/operator/state').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s) return;
      $('joinurl').textContent = s.joinUrl; $('joinurl').href = s.joinUrl; $('joinBig').textContent = s.joinUrl;
      $('disk').textContent = (s.freeDiskBytes / 1e9).toFixed(1) + ' GB';
      $('nudge').value = s.show.nudge_ms || 0; $('nudgeVal').textContent = (s.show.nudge_ms || 0) + ' ms'; nudge = s.show.nudge_ms || 0;
      renderState(s.state);
      var tb = $('tracks').querySelector('tbody'); tb.innerHTML = '';
      s.tracks.forEach(function (t) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td><b>' + esc(t.title) + '</b><br><span class="muted">' + (t.analysis_status) + (t.cue_count ? ' · ' + t.cue_count + ' cues · ' + Math.round((t.duration_ms || 0) / 1000) + 's' : '') + '</span>'
          + '<br><label class="muted"><input type="checkbox" ' + (t.license_attested ? 'checked' : '') + ' data-attest="' + t.id + '"> I hold rights/licence (ZAiKS) to play this publicly</label></td>'
          + '<td style="text-align:right"><button data-arm="' + t.id + '" ' + (t.analysis_status !== 'done' ? 'disabled' : '') + ' style="width:auto">Arm</button> '
          + '<button data-del="' + t.id + '" class="ghost" style="width:auto">✕</button></td>';
        tb.appendChild(tr);
      });
    });
    api('/api/operator/qr').then(function (r) { return r.blob(); }).then(function (b) { var u = URL.createObjectURL(b); $('qr').src = u; $('qrBig').src = u; });
  }
  function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }); }
  function renderState(st) { $('state').textContent = st.status; }

  $('tracks').addEventListener('click', function (e) {
    var arm = e.target.getAttribute('data-arm'); var del = e.target.getAttribute('data-del');
    if (arm) armTrack(Number(arm));
    if (del) api('/api/operator/track/' + del, { method: 'DELETE' }).then(loadState);
  });
  $('tracks').addEventListener('change', function (e) {
    var at = e.target.getAttribute('data-attest');
    if (at && e.target.checked) api('/api/operator/track/' + at + '/attest', { method: 'POST' });
  });

  $('upload').addEventListener('click', function () {
    var f = $('file').files[0]; if (!f) { $('uploadMsg').textContent = 'Choose a file first.'; return; }
    var fd = new FormData(); fd.append('audio', f);
    $('uploadMsg').textContent = 'Uploading & analyzing…';
    api('/api/operator/upload', { method: 'POST', body: fd }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) { $('uploadMsg').textContent = res.ok ? ('Done: ' + res.j.cueCount + ' cues, ' + res.j.beats + ' beats') : ('Error: ' + (res.j.error || '')); loadState(); })
      .catch(function (e) { $('uploadMsg').textContent = 'Upload failed: ' + e; });
  });

  function armTrack(id) {
    ensureAudio();
    armedId = id; armedBuffer = null;
    // Arm the LIGHTS immediately (distribute the timeline) — independent of whether
    // this browser can decode the audio. The show must never depend on local decode.
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'arm', trackId: id }));
    $('armed').textContent = 'track #' + id + ' (lights ready, loading audio…)';
    // Best-effort: load + decode the audio for console playback (P0-1 alignment).
    // If the browser can't decode this format, the lights still run — play the music
    // from another source and use GO + nudge to line it up.
    api('/api/operator/audio/' + id).then(function (r) { return r.arrayBuffer(); })
      .then(function (ab) { return audioCtx.decodeAudioData(ab); })
      .then(function (buf) { if (armedId === id) { armedBuffer = buf; $('armed').textContent = 'track #' + id + ' ♪ audio ready'; } })
      .catch(function () { if (armedId === id) $('armed').textContent = 'track #' + id + ' (lights only — this browser can’t play this audio; play music separately)'; });
  }

  $('go').addEventListener('click', function () {
    if (armedId == null) { alert('Arm a track first.'); return; }
    ensureAudio();
    // P0-1: when the console can play the audio, derive T0 from the REAL audio start
    // so the light and the audible PA track share one origin (nudge compensates PA
    // latency). If audio couldn't be decoded here, start the lights at now+lead and
    // play the music from another source, lining it up with the nudge slider.
    var T0;
    if (armedBuffer) {
      var ctxStart = audioCtx.currentTime + LEAD_MS / 1000;
      var perfStart = performance.now() + LEAD_MS;
      T0 = perfStart + (clock ? clock.offset : 0) + nudge;
      if (source) { try { source.stop(); } catch (e) {} }
      source = audioCtx.createBufferSource(); source.buffer = armedBuffer; source.connect(audioCtx.destination);
      source.start(ctxStart);
    } else {
      T0 = performance.now() + LEAD_MS + (clock ? clock.offset : 0) + nudge;
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'go', T0: T0 }));
  });
  $('pause').addEventListener('click', function () { if (source) { try { source.stop(); } catch (e) {} } if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'pause' })); });
  $('stop').addEventListener('click', function () { if (source) { try { source.stop(); } catch (e) {} } if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'stop' })); });
  $('blackout').addEventListener('click', function () { if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'blackout' })); });

  $('nudge').addEventListener('input', function () { nudge = Number($('nudge').value); $('nudgeVal').textContent = nudge + ' ms'; });
  $('nudge').addEventListener('change', function () { api('/api/operator/nudge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms: nudge }) }); });

  $('projector').addEventListener('click', function () { $('proj').classList.remove('hidden'); });
  $('projClose').addEventListener('click', function () { $('proj').classList.add('hidden'); });

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    clock = new ClockSync(function (o) { try { ws.send(JSON.stringify(o)); } catch (e) {} });
    ws.onopen = function () {
      $('conn').textContent = 'online';
      ws.send(JSON.stringify({ t: 'hello', role: 'operator', token: TOKEN }));
      var n = 0; var p = setInterval(function () { if (ws.readyState === 1) { clock.ping(); if (++n >= 12) clearInterval(p); } }, 120);
      setInterval(function () { if (ws.readyState === 1) clock.ping(); }, 25000);
    };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'sync') { clock.onReply(m.c0, m.s1); return; }
      if (m.t === 'count') { $('count').textContent = m.audience; $('countBig').textContent = m.audience; return; }
      if (m.t === 'state') { renderState(m.state); return; }
    };
    ws.onclose = function () { $('conn').textContent = 'offline — retrying'; setTimeout(connect, 1500); };
    ws.onerror = function () {};
  }

  connect(); loadState(); setInterval(loadState, 8000);
})();
