// Cat Conga — игровой клиент (Фаза D): Spark-мир + коты + джойстик + стрелка-компас на хвост,
// identify me, пресет-чат, «мурлык», milestone. Бинарный NEAR-протокол, интерполяция.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { CatLayer, chainColorHex } from './cat.js';

const qs = new URLSearchParams(location.search);
const WORLD = qs.get('world') || './static/worlds/dubai-b5-v1.sog';
const ROOM = qs.get('room') || 'MAIN';
const Q = 32, CATS_MAX = 2000;
const CHAT = ['coffee? ☕', 'ice cream? 🍦', 'a drink? 🥤', 'where are you?', 'over here!', 'follow me', 'nice chain!', 'hi 👋', 'lol', 'wait for me', 'cool 😎', 'bye 👋'];

const $ = (id) => document.getElementById(id);
const stage = $('stage'), statusEl = $('status'), loader = $('loader'), errBox = $('err');
window.__probe = { mode: 'loading', num: null, seat: -1, splatCount: 0, chatSeen: 0, purrSeen: 0, milestones: [], identify: null, errors: [] };
window.addEventListener('error', (e) => window.__probe.errors.push(String(e.message || e.type)));
const setMode = (m) => { document.body.dataset.mode = m; window.__probe.mode = m; };
function toast(t) { const s = $('toastmsg'); s.textContent = t; s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 1400); }

// wake lock + no-scroll
navigator.wakeLock?.request('screen').catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').catch(() => {}); });

// ---------- сеть: join → ws ----------
let ws = null, myNum = null, mySeat = -1, chainColorId = 0;
const others = new Map();  // num -> {x,z,heading,flags, px,pz, tx,tz, at}
let selfPos = { x: 0, z: 0, heading: 0 };
let tail = null, tailColor = null, chainLen = 0;
const rtt = { last: 0 };

async function connect() {
  const j = await fetch(`/api/join?room=${encodeURIComponent(ROOM)}`).then((r) => { if (!r.ok) throw new Error('join ' + r.status); return r.json(); });
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + j.ws + '?token=' + j.token);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = onMsg;
  ws.onclose = () => { if (window.__probe.mode !== 'error') setTimeout(reconnect, 1500); };
  ws.onerror = () => {};
  await new Promise((res, rej) => { ws.onopen = res; ws.addEventListener('error', rej, { once: true }); });
  setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'ping', t0: performance.now() })); }, 4000);
}
async function reconnect() { try { await connect(); } catch { setTimeout(reconnect, 2000); } }

function onMsg(ev) {
  if (typeof ev.data !== 'string') { onSnapshot(new Uint8Array(ev.data), new DataView(ev.data)); return; }
  const m = JSON.parse(ev.data);
  if (m.t === 'hello') { myNum = m.num; mySeat = m.seat; window.__probe.num = myNum; window.__probe.seat = mySeat; }
  else if (m.t === 'pong') rtt.last = performance.now() - m.t0;
  else if (m.t === 'tail') { tail = m.tail; tailColor = m.color; chainLen = m.len; }
  else if (m.t === 'joined') { mySeat = m.seat; window.__probe.seat = mySeat; toast(m.head ? "you're the head! 🐈‍⬛" : 'latched on! 🎉'); if (navigator.vibrate) navigator.vibrate(30); }
  else if (m.t === 'detached') { mySeat = -1; window.__probe.seat = -1; }
  else if (m.t === 'you_are_head') { mySeat = 0; window.__probe.seat = 0; toast('you lead now! 🚂'); if (navigator.vibrate) navigator.vibrate([20, 40, 20]); }
  else if (m.t === 'chat') { window.__probe.chatSeen++; showBubble(m.num, CHAT[m.i] || '?'); }
  else if (m.t === 'purr') { window.__probe.purrSeen++; }
  else if (m.t === 'milestone') { window.__probe.milestones.push(m.ms); toast('chain reached ' + m.ms + '! ✨'); if (navigator.vibrate) navigator.vibrate([30, 60, 30]); }
  else if (m.t === 'identify') { showIdentify(m.num, m.colorId, m.ttl); }
  else if (m.t === 'hint') { window.__probe.hint = m.kind; toast('🐾'); if (navigator.vibrate) navigator.vibrate(40); } // телепорт к хвосту — бессловесно
  else if (m.t === 'err') { if (m.code === 'too_far') tail = m.tail; }
}

function onSnapshot(u8, dv) {
  if (u8[0] === 2) return; // MAP-кадр (zoom-out) — упрощённо игнор в этом MVP-рендере NEAR
  const count = dv.getUint16(5, true);
  const now = performance.now();
  for (let i = 0; i < count; i++) {
    const o = 7 + i * 10;
    const num = dv.getUint32(o, true);
    const x = dv.getInt16(o + 4, true) / Q, z = dv.getInt16(o + 6, true) / Q;
    const heading = dv.getUint8(o + 8) / 255 * 2 * Math.PI - Math.PI;
    const flags = dv.getUint8(o + 9);
    if (num === myNum) { selfPos = { x, z, heading }; continue; }   // себя ищем по num (в общем кадре ячейки бита 128 нет)
    let e = others.get(num);
    if (!e) { e = { px: x, pz: z, tx: x, tz: z, heading, flags, at: now, colorId: 0 }; others.set(num, e); }
    e.px = e.tx; e.pz = e.tz; e.tx = x; e.tz = z; e.heading = heading; e.flags = flags; e.at = now;
    e.colorId = (flags & 1) ? (chainColorId || 1) : 0;
  }
  for (const [num, e] of others) if (now - e.at > 3000) others.delete(num);
}

// ---------- ввод: джойстик ----------
let intent = { x: 0, z: 0 };
(function joystick() {
  const joy = $('joy'), knob = $('knob'); let active = false, cx = 60, cy = 60;
  const set = (dx, dy) => { const d = Math.hypot(dx, dy), max = 40; const k = d > max ? max / d : 1; knob.style.left = (40 + dx * k) + 'px'; knob.style.top = (40 + dy * k) + 'px'; intent = { x: (dx * k) / max, z: (dy * k) / max }; };
  joy.addEventListener('pointerdown', (e) => { active = true; const r = joy.getBoundingClientRect(); cx = r.left + 60; cy = r.top + 60; set(e.clientX - cx, e.clientY - cy); joy.setPointerCapture(e.pointerId); });
  joy.addEventListener('pointermove', (e) => { if (active) set(e.clientX - cx, e.clientY - cy); });
  const up = () => { active = false; knob.style.left = '40px'; knob.style.top = '40px'; intent = { x: 0, z: 0 }; };
  joy.addEventListener('pointerup', up); joy.addEventListener('pointercancel', up);
})();
setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'intent', x: intent.x, z: intent.z })); }, 100);

// ---------- кнопки ----------
$('bChat').onclick = () => $('chatbar').classList.toggle('show');
CHAT.forEach((txt, i) => { const b = document.createElement('button'); b.textContent = txt; b.onclick = () => { audioUnlock(); ws?.send(JSON.stringify({ t: 'chat', i })); showBubble(myNum, txt); $('chatbar').classList.remove('show'); }; $('chatgrid').appendChild(b); });
$('bPurr').onclick = () => { audioUnlock(); ws?.send(JSON.stringify({ t: 'purr' })); if (navigator.vibrate) navigator.vibrate(15); };
$('bId').onclick = () => { audioUnlock(); ws?.send(JSON.stringify({ t: 'identify' })); };
$('bMap').onpointerdown = () => ws?.send(JSON.stringify({ t: 'map', on: true }));
$('bMap').onpointerup = () => ws?.send(JSON.stringify({ t: 'map', on: false }));

// identify me: цепочка ОДНА, цвет не различает людей → различает УНИКАЛЬНЫЙ ПАТТЕРН мигания
// (8 слотов из хеша номера) + гигантский номер. Шаг ≥334 мс = кламп ≤3 Гц (эпилепси-duty-of-care,
// как governor лайтшоу). TTL 60 с; тап по крестику = panic-сброс.
const ID_STEP_MS = 350; // 1/0.35 ≈ 2.86 Гц < 3 Гц
function identPattern(num) {
  let bits = ((num * 2654435761) >>> 0) & 0xff;
  if (bits === 0 || bits === 0xff) bits = 0b10110100; // гарантируем переходы (не ровный свет/тьма)
  return bits;
}
function showIdentify(num, colorId, ttl) {
  const col = colorId ? chainColorHex(colorId) : '#ffc93c';
  const el = $('ident'); $('idnum').textContent = '#' + num; el.classList.add('show'); $('idclose').classList.add('show');
  const pattern = identPattern(num);
  let step = 0;
  clearInterval(showIdentify._blink);
  const paint = () => { el.style.background = (pattern >> (step & 7)) & 1 ? col : '#0d0c10'; step++; };
  paint();
  showIdentify._blink = setInterval(paint, ID_STEP_MS);
  window.__probe.identify = { num, colorId, color: col, pattern, stepMs: ID_STEP_MS, hz: +(1000 / ID_STEP_MS / 1).toFixed(2) };
  clearTimeout(showIdentify._t); showIdentify._t = setTimeout(closeId, (ttl || 60) * 1000);
}
function closeId() { clearInterval(showIdentify._blink); $('ident').classList.remove('show'); $('idclose').classList.remove('show'); }
$('idclose').onclick = closeId;

// чат-бабблы над котами (упрощённо — тост)
const bubbleEls = new Map();
function showBubble(num, txt) { if (num === myNum) toast(txt); else toast('#' + num + ': ' + txt); }

// audio unlock на первый жест (autoplay-закон)
let audioCtx = null;
function audioUnlock() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (audioCtx?.state === 'suspended') audioCtx.resume(); }
document.addEventListener('pointerdown', audioUnlock, { once: true });

// ---------- рендер ----------
// §D метрики события: beacon серверу (conversion / time-to-world / % 2D-fallback)
function beacon(kind) {
  try {
    const ms = Math.round(performance.now());
    (navigator.sendBeacon && navigator.sendBeacon(`/api/metric?k=${kind}&ms=${ms}`)) || fetch(`/api/metric?k=${kind}&ms=${ms}`).catch(() => {});
  } catch {}
}
async function boot() {
  errBox.classList.remove('show');
  try {
    await connect();
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) { start2D(); return; }
    await start3D();
    loader.classList.add('hidden');
    setMode('play');
    beacon('world_loaded');
  } catch (e) {
    window.__probe.errors.push('boot: ' + (e && e.message || e));
    setMode('error'); loader.classList.add('hidden'); errBox.classList.add('show');
  }
}
$('retry').onclick = () => { setMode('loading'); loader.classList.remove('hidden'); boot(); };

async function start3D() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
  stage.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223, 1.0)); const dl = new THREE.DirectionalLight(0xfff2d0, 1.0); dl.position.set(3, 6, 2); scene.add(dl);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 500);
  scene.add(new SparkRenderer({ renderer }));
  // мир
  try {
    const bytes = new Uint8Array(await fetch(WORLD).then((r) => r.arrayBuffer()));
    const splats = new SplatMesh({ fileBytes: bytes, fileName: WORLD.split('/').pop() });
    await splats.initialized; splats.rotation.x = Math.PI; scene.add(splats);
    window.__probe.splatCount = splats.numSplats ?? 0;
  } catch (e) { window.__probe.errors.push('world: ' + e.message); }
  const cats = new CatLayer(scene, CATS_MAX);
  // стрелка-компас на хвост
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.7, 4), new THREE.MeshBasicMaterial({ color: 0xffc93c }));
  arrow.rotation.x = Math.PI / 2; scene.add(arrow);
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  let camYaw = 0;
  const SPECTATE = qs.get('spectate') === '1';   // обзор сверху для приёмки/проектора (не боевой)
  function tick(tms) {
    if (SPECTATE) {
      // камера сверху над центром сцены — видно весь хоровод
      let cx = selfPos.x, cz = selfPos.z, n = 1;
      for (const [, e] of others) { cx += e.tx; cz += e.tz; n++; }
      cx /= n; cz /= n;
      camera.position.set(cx, 55, cz + 0.01); camera.lookAt(cx, 0, cz);
      const list = [];
      for (const [num, e] of others) list.push({ x: e.tx, z: e.tz, heading: e.heading, preset: (num % 2) ? 'A' : 'B', colorId: e.colorId || 1 });
      list.push({ x: selfPos.x, z: selfPos.z, heading: selfPos.heading, preset: 'A', colorId: 1 });
      cats.update(list, camera.position);
      arrow.visible = false;
      renderer.render(scene, camera);
      window.__probe.cats = list.length;
      return;
    }
    // сгладить свою позицию
    const me = selfPos;
    // камера — сзади-сверху за котом, поворачивается по heading
    camYaw += ((me.heading + Math.PI) - camYaw) * 0.08;
    const cd = 4.5, ch = 2.4;
    camera.position.set(me.x - Math.cos(me.heading) * cd, ch, me.z - Math.sin(me.heading) * cd);
    camera.lookAt(me.x, 0.9, me.z);
    // собрать котов для рендера (интерполяция others + свой)
    const now = performance.now();
    const list = [];
    for (const [num, e] of others) {
      const a = Math.min(1, (now - e.at) / 125);
      list.push({ x: e.px + (e.tx - e.px) * a, z: e.pz + (e.tz - e.pz) * a, heading: e.heading, preset: (num % 2) ? 'A' : 'B', colorId: e.colorId || 1 });
    }
    list.push({ x: me.x, z: me.z, heading: me.heading, preset: (myNum % 2) ? 'A' : 'B', colorId: mySeat >= 0 ? (chainColorId || 1) : 1 });
    cats.update(list, camera.position);
    // стрелка на хвост (если не в цепи)
    if (mySeat < 0 && tail) {
      const dx = tail.x - me.x, dz = tail.z - me.z, d = Math.hypot(dx, dz);
      arrow.visible = d > 1.5;
      arrow.position.set(me.x + dx / d * 1.6, 0.8, me.z + dz / d * 1.6);
      arrow.rotation.z = -Math.atan2(dz, dx);
      statusEl.textContent = 'to the tail: ' + Math.round(d) + ' m' + (chainLen ? '  · chain ' + chainLen : '');
    } else {
      arrow.visible = false;
      statusEl.textContent = mySeat === 0 ? '🚂 you lead · chain ' + chainLen : (mySeat > 0 ? 'in the conga · #' + myNum + ' · chain ' + chainLen : 'Cat Conga');
    }
    // авто-join при близости к хвосту
    if (mySeat < 0 && tail) { const d = Math.hypot(tail.x - me.x, tail.z - me.z); if (d < 2.5) ws?.send(JSON.stringify({ t: 'join_tail' })); }
    renderer.render(scene, camera);
    window.__probe.cats = list.length;
  }
  renderer.setAnimationLoop(tick);
  tick(performance.now());                       // гарантированный первый кадр (headless/скрытая вкладка морозит rAF)
  window.__renderTick = () => { tick(performance.now()); return window.__probe.cats; };
  window.__renderReady = true;
}

function start2D() {
  beacon('fallback_2d');
  // облегчённый режим — топ-даун точки (fallback)
  stage.replaceChildren(); const cv = document.createElement('canvas'); stage.appendChild(cv);
  const ctx = cv.getContext('2d');
  function size() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; } addEventListener('resize', size); size();
  rendererLoop();
  function rendererLoop() {
    ctx.fillStyle = '#07080c'; ctx.fillRect(0, 0, cv.width, cv.height);
    const sc = 6 * devicePixelRatio, ox = cv.width / 2 - selfPos.x * sc, oy = cv.height / 2 - selfPos.z * sc;
    const now = performance.now();
    for (const [num, e] of others) { const a = Math.min(1, (now - e.at) / 125); ctx.fillStyle = e.colorId ? chainColorHex(e.colorId) : '#888'; ctx.beginPath(); ctx.arc(ox + (e.px + (e.tx - e.px) * a) * sc, oy + (e.pz + (e.tz - e.pz) * a) * sc, 4, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#ffc93c'; ctx.beginPath(); ctx.arc(ox + selfPos.x * sc, oy + selfPos.z * sc, 6, 0, 7); ctx.fill();
    if (mySeat < 0 && tail) { ctx.strokeStyle = '#ffc93c'; ctx.beginPath(); ctx.moveTo(ox + selfPos.x * sc, oy + selfPos.z * sc); ctx.lineTo(ox + tail.x * sc, oy + tail.z * sc); ctx.stroke(); if (Math.hypot(tail.x - selfPos.x, tail.z - selfPos.z) < 2.5) ws?.send(JSON.stringify({ t: 'join_tail' })); }
    requestAnimationFrame(rendererLoop);
  }
  loader.classList.add('hidden'); setMode('play2d'); window.__renderReady = true;
}

boot();
