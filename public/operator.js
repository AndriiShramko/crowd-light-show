(function () {
  'use strict';
  var TOKEN = window.__TOKEN__;
  var LEAD_MS = Number(window.__LEAD__) || 900; // from config (single source of truth)
  var ws = null, clock = null, armedId = null, audioReady = false, nudge = 0, curState = 'idle';
  var pendingGo = false, goWatcher = null; // GO deferred until the operator clock locks
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
        var isArmed = t.id === armedId;
        var tr = document.createElement('tr');
        if (isArmed) tr.style.background = 'rgba(90,160,255,.15)';
        tr.innerHTML = '<td><b>' + esc(t.title) + '</b>' + (isArmed ? ' <span style="color:#5aa0ff">● ARMED</span>' : '') + '<br><span class="muted">' + (t.analysis_status) + (t.cue_count ? ' · ' + t.cue_count + ' cues · ' + Math.round((t.duration_ms || 0) / 1000) + 's' : '') + '</span>'
          + '<br><label class="muted"><input type="checkbox" ' + (t.license_attested ? 'checked' : '') + ' data-attest="' + t.id + '"> I hold rights/licence (ZAiKS) to play this publicly</label></td>'
          + '<td style="text-align:right"><button data-arm="' + t.id + '" ' + (t.analysis_status !== 'done' ? 'disabled' : '') + ' class="' + (isArmed ? 'primary' : '') + '" style="width:auto">' + (isArmed ? '✓ Armed' : 'Arm') + '</button> '
          + '<button data-del="' + t.id + '" class="ghost" style="width:auto">✕</button></td>';
        tb.appendChild(tr);
      });
    });
    api('/api/operator/qr').then(function (r) { return r.blob(); }).then(function (b) { var u = URL.createObjectURL(b); $('qr').src = u; $('qrBig').src = u; });
  }
  function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }); }
  function renderState(st) {
    curState = st.status;
    $('state').textContent = st.status;
    if (pendingGo) return; // keep the "⏳ syncing clock…" label while a GO is deferred
    var locking = (st.status === 'idle' && !(clock && clock.ready));
    $('go').textContent = st.status === 'paused' ? '▶ RESUME' : (st.status === 'running' ? '● LIVE' : (locking ? '▶ GO (clock…)' : '▶ GO'));
  }

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
    loadState(); // instant feedback: highlight the armed row now
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

  function flashBtn(el) { el.style.boxShadow = '0 0 0 3px #fff'; setTimeout(function () { el.style.boxShadow = ''; }, 300); }

  function doGo() {
    $('go').textContent = '● starting…';      // instant feedback (there is a lead before the drop)
    // Lights start at T0 = now + lead (server clock via offset + nudge); audio is
    // scheduled to the same instant. nudge fine-tunes PA latency.
    var T0 = performance.now() + LEAD_MS + (clock ? clock.offset : 0) + nudge;
    if (audioReady && player.src) {
      try { player.pause(); player.currentTime = 0; } catch (e) {}
      setTimeout(function () { var p = player.play(); if (p && p.catch) p.catch(function () {}); }, LEAD_MS);
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'go', T0: T0 }));
  }
  $('go').addEventListener('click', function () {
    if (armedId == null) { alert('Arm a track first.'); return; }
    flashBtn($('go'));
    if (curState === 'paused') {              // RESUME from the pause point (continue, not restart)
      if (audioReady && player.src) { var pr = player.play(); if (pr && pr.catch) pr.catch(function () {}); }
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'op', cmd: 'resume' }));
      return;
    }
    // Do NOT GO off an unconverged operator clock — that shifts the whole crowd vs the
    // music. Defer and auto-fire the instant the clock locks (usually <2s).
    if (!(clock && clock.ready)) {
      pendingGo = true; $('go').textContent = '⏳ syncing clock…';
      if (!goWatcher) goWatcher = setInterval(function () {
        if (clock && clock.ready && pendingGo) { pendingGo = false; clearInterval(goWatcher); goWatcher = null; doGo(); }
      }, 100);
      return;
    }
    doGo();
  });
  $('pause').addEventListener('click', function () { flashBtn($('pause')); try { player.pause(); } catch (e) {} if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'pause' })); });
  $('stop').addEventListener('click', function () { flashBtn($('stop')); try { player.pause(); player.currentTime = 0; } catch (e) {} if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'stop' })); });
  $('blackout').addEventListener('click', function () { flashBtn($('blackout')); if (ws) ws.send(JSON.stringify({ t: 'op', cmd: 'blackout' })); });

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
      // Longer rapid sync (~2s, 25 @80ms) so the operator clock is genuinely converged
      // before a human can arm+GO — a GO off an unconverged operator clock shifts the
      // WHOLE crowd vs the music (the reported first-run ~0.5s desync).
      var n = 0; var p = setInterval(function () { if (ws.readyState === 1) { clock.ping(); if (++n >= 25) clearInterval(p); } }, 80);
      setInterval(function () { if (ws.readyState === 1) clock.ping(); }, 25000);
    };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'sync') { clock.onReply(m.c0, m.s1); if (clock.ready && curState === 'idle') renderState({ status: curState }); return; }
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

  // ---- live presets (studio) ----
  var presetSchema = null, activeType = null, activeParams = {};
  function defParams(type) { var o = {}, ps = presetSchema[type].params; for (var k in ps) o[k] = ps[k].def; return o; }
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
  }
  var paramTimer = null, pendingParam = {};
  function sendParam(k, v) {
    pendingParam[k] = v; if (paramTimer) return;
    paramTimer = setTimeout(function () {
      var pp = pendingParam; pendingParam = {}; paramTimer = null;
      Object.keys(pp).forEach(function (key) {
        api('/api/operator/preset/param', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, value: pp[key] }) });
      });
    }, 80); // throttle slider spam (morph is phase-preserving, order-independent)
  }
  function pickPreset(type) {
    if (type === 'off') {
      activeType = null; $('presetParams').innerHTML = ''; highlightPreset();
      api('/api/operator/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'off' }) });
      $('presetMsg').textContent = 'Presets off.'; return;
    }
    activeType = type; activeParams = defParams(type); renderParams(); highlightPreset();
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
      if (d.active && d.active.type && d.active.type !== 'off') { activeType = d.active.type; activeParams = Object.assign({}, d.active.params); renderParams(); }
      highlightPreset();
    });
  }
  if ($('presetBtns')) $('presetBtns').addEventListener('click', function (e) { var t = e.target.getAttribute('data-preset'); if (t) pickPreset(t); });

  connect(); loadState(); loadApps(); loadPresets(); setInterval(loadState, 8000); setInterval(loadApps, 20000);
})();
