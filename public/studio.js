// Guest "Try it live" studio: mint a private ephemeral room, point your own phones
// at it, and switch parametric presets in real time (no auth). The page also joins
// the room as a synced previewer, so the crowd canvas mirrors EXACTLY what the
// phones show — and it works convincingly with a single device (degrades gracefully).
(function () {
  'use strict';
  var P = window.CLS_PRESETS;
  var $ = function (id) { return document.getElementById(id); };
  var ROOM = null, schema = null, activeType = null, activeParams = {};
  var ws = null, clock = null, preset = null, total = 1;
  var GRID = 24; // simulated crowd wall (N-independent demonstration)

  function api(path, opts) { return fetch(path, opts); }

  // ---- mint room + UI ----
  api('/api/demo/room').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) { $('presetMsg').textContent = 'Studio is unavailable right now.'; return; }
    ROOM = d.room; schema = d.schema;
    $('qr').src = '/api/demo/room-qr?room=' + ROOM;
    $('joinurl').textContent = d.joinUrl; $('joinurl').href = d.joinUrl;
    buildButtons(d.types);
    connect();
    pickPreset(d.default); // go live immediately so the page is alive
  }).catch(function () { $('presetMsg').textContent = 'Studio is unavailable right now.'; });

  function buildButtons(types) {
    var box = $('presetBtns'); box.innerHTML = '';
    types.forEach(function (type) {
      var b = document.createElement('button'); b.style.width = 'auto'; b.className = 'preset-btn';
      b.textContent = schema[type].label; b.setAttribute('data-preset', type); box.appendChild(b);
    });
    box.addEventListener('click', function (e) { var t = e.target.getAttribute('data-preset'); if (t) pickPreset(t); });
  }
  function highlight() {
    Array.prototype.forEach.call($('presetBtns').querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-preset') === activeType);
    });
  }
  function defParams(type) { var o = {}, ps = schema[type].params; for (var k in ps) o[k] = ps[k].def; return o; }
  function renderParams() {
    var wrap = $('presetParams'); wrap.innerHTML = '';
    if (!activeType || !schema[activeType]) return;
    var ps = schema[activeType].params;
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
  var paramTimer = null, pending = {};
  function sendParam(k, v) {
    pending[k] = v; if (paramTimer || !ROOM) return;
    paramTimer = setTimeout(function () {
      var pp = pending; pending = {}; paramTimer = null;
      Object.keys(pp).forEach(function (key) {
        api('/api/demo/preset/param', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: ROOM, key: key, value: pp[key] }) });
      });
    }, 80);
  }
  function pickPreset(type) {
    if (!ROOM || !schema[type]) return;
    activeType = type; activeParams = defParams(type); renderParams(); highlight();
    api('/api/demo/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: ROOM, type: type, params: activeParams }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { $('presetMsg').textContent = j.ok ? ('● LIVE: ' + schema[type].label + (j.members ? ' · ' + j.members + ' phone(s)' : '')) : ('Error: ' + (j.error || '')); });
  }

  // ---- join the room as a synced previewer ----
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    clock = new ClockSync(function (o) { try { ws.send(JSON.stringify(o)); } catch (e) {} });
    ws.onopen = function () {
      ws.send(JSON.stringify({ t: 'hello', role: 'audience', room: ROOM, platform: 'studio' }));
      var n = 0; var p = setInterval(function () { if (ws.readyState === 1) { clock.ping(); if (++n >= 30) clearInterval(p); } }, 90);
      setInterval(function () { if (ws.readyState === 1) clock.ping(); }, 3000);
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'sync') { clock.onReply(m.c0, m.s1); $('sync').textContent = clock.ready ? 'locked' : 'syncing…'; return; }
      if (m.t === 'index') { total = Math.max(1, m.total | 0); $('count').textContent = total; return; }
      if (m.t === 'preset') { preset = (m.type === 'off' || !P.PRESETS[m.type]) ? null : { type: m.type, params: m.params, startedAt: m.startedAt, epoch: m.epoch }; return; }
      if (m.t === 'paramUpdate') { if (preset && m.epoch === preset.epoch) preset.params[m.key] = m.value; return; }
    };
    ws.onclose = function () { $('sync').textContent = 'offline'; setTimeout(connect, 1500); };
    ws.onerror = function () {};
    requestAnimationFrame(drawCrowd);
  }

  // ---- crowd preview: a wall of GRID tiles, each running the live preset off the
  //      synced clock at its own index (so spatial presets visibly split). ----
  var cv = $('crowd'), cx = cv.getContext('2d');
  var cols = Math.ceil(Math.sqrt(GRID * 1.6)), rows = Math.ceil(GRID / cols);
  function drawCrowd() {
    requestAnimationFrame(drawCrowd);
    var W = cv.width, H = cv.height, tw = W / cols, th = H / rows;
    if (!preset || !(clock && clock.ready)) { cx.fillStyle = '#0a0a0a'; cx.fillRect(0, 0, W, H); return; }
    var pos = clock.serverNow() - preset.startedAt;
    for (var i = 0; i < GRID; i++) {
      var rgb = P.clampColor(P.PRESETS[preset.type](pos, preset.params, i, GRID));
      cx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      var x = (i % cols) * tw, y = Math.floor(i / cols) * th;
      cx.fillRect(x + 1, y + 1, tw - 2, th - 2);
    }
  }

  // Optional pre-rendered "real crowd" video (operator supplies the asset). If present,
  // show it under the live preview; if missing (404), keep just the canvas.
  (function () {
    var v = $('crowdVid'); var src = '/static/crowd-demo.mp4';
    fetch(src, { method: 'HEAD' }).then(function (r) { if (r.ok) { v.src = src; v.classList.remove('hidden'); v.play().catch(function () {}); } }).catch(function () {});
  })();
})();
