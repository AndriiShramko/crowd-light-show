(function () {
  'use strict';
  var TOKEN = window.__TOKEN__;
  var LEAD_MS = 900;
  var ws = null, clock = null, armedId = null, audioReady = false, nudge = 0;
  var player = document.getElementById('player');

  var $ = function (id) { return document.getElementById(id); };
  function api(path, opts) {
    opts = opts || {}; opts.headers = Object.assign({ Authorization: 'Bearer ' + TOKEN }, opts.headers || {});
    return fetch(path, opts);
  }

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
    armedId = id; audioReady = false;
    // Arm the LIGHTS immediately (distribute the timeline) — independent of audio.
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'arm', trackId: id }));
    $('armed').textContent = 'track #' + id + ' (lights ready, loading audio…)';
    // Stream the audio into an <audio> element via a Blob URL (the original ~3 MB
    // file, NOT a giant decoded buffer): low memory, robust, decoded on the fly.
    api('/api/operator/audio/' + id).then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (blob) {
        if (armedId !== id) return;
        if (!blob) throw new Error('no audio');
        if (player.dataset.url) { try { URL.revokeObjectURL(player.dataset.url); } catch (e) {} }
        var url = URL.createObjectURL(blob); player.dataset.url = url; player.src = url; player.load();
        audioReady = true; $('armed').textContent = 'track #' + id + ' ♪ audio ready';
      })
      .catch(function () { if (armedId === id) $('armed').textContent = 'track #' + id + ' (lights only — play music separately)'; });
  }

  $('go').addEventListener('click', function () {
    if (armedId == null) { alert('Arm a track first.'); return; }
    // Lights start at T0 = now + lead (server clock via offset + nudge). The audio
    // element is scheduled to start at the same instant; nudge fine-tunes PA latency.
    var T0 = performance.now() + LEAD_MS + (clock ? clock.offset : 0) + nudge;
    if (audioReady && player.src) {
      try { player.pause(); player.currentTime = 0; } catch (e) {}
      setTimeout(function () { var p = player.play(); if (p && p.catch) p.catch(function () {}); }, LEAD_MS);
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'go', T0: T0 }));
  });
  $('pause').addEventListener('click', function () { try { player.pause(); } catch (e) {} if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'pause' })); });
  $('stop').addEventListener('click', function () { try { player.pause(); player.currentTime = 0; } catch (e) {} if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'stop' })); });
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

  function loadApps() {
    api('/api/operator/applications').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var tb = $('apps').querySelector('tbody'); tb.innerHTML = '';
      $('appsMsg').textContent = d.applications.length ? (d.applications.length + ' lead(s)') : 'No leads yet — submissions from the landing form appear here.';
      d.applications.forEach(function (a) {
        var when = new Date(a.created_at).toLocaleString();
        var tr = document.createElement('tr');
        tr.innerHTML = '<td><b>' + esc(a.name) + '</b> · ' + esc(a.contact) + '<br><span class="muted">' + esc(a.event_type || '') + (a.message ? ' · ' + esc(a.message) : '') + '<br>' + when + (a.notified ? ' · ✓ TG' : '') + '</span></td>'
          + '<td style="text-align:right;vertical-align:top"><button data-delapp="' + a.id + '" class="ghost" style="width:auto">✕</button></td>';
        tb.appendChild(tr);
      });
    });
  }
  $('apps').addEventListener('click', function (e) {
    var id = e.target.getAttribute('data-delapp');
    if (id) api('/api/operator/application/' + id, { method: 'DELETE' }).then(loadApps);
  });
  $('refreshApps').addEventListener('click', loadApps);

  connect(); loadState(); loadApps(); setInterval(loadState, 8000); setInterval(loadApps, 20000);
})();
