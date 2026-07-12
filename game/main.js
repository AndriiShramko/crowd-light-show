// Cat Conga — Phase A: 3DGS world preview (Spark 2.x + Three.js, vanilla ES modules).
// Contract for tests (spec-verify §A): body[data-mode], window.__probe, #err, ?force2d=1 / ?fpsprobe=N.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const qs = new URLSearchParams(location.search);
const WORLD_URL = qs.get('world') || './static/worlds/dubai-b5-v1.sog';
const PROBE_SECONDS = Number(qs.get('fpsprobe')) > 0 ? Number(qs.get('fpsprobe')) : 10;
const FPS_FLOOR = 20; // ниже за окно пробы → авто-2D

const stage = document.getElementById('stage');
const loader = document.getElementById('loader');
const loadBar = document.querySelector('#bar i');
const loadMsg = document.getElementById('loadmsg');
const errBox = document.getElementById('err');
const statusEl = document.getElementById('status');

window.__probe = { mode: 'loading', fps: null, frames: 0, splatCount: 0, worldBytes: 0, errors: [] };
window.addEventListener('error', (e) => window.__probe.errors.push(String(e.message || e.type)));

const setMode = (m) => { document.body.dataset.mode = m; window.__probe.mode = m; };

// -------- wake lock (телефон не должен гасить экран в толпе) --------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* не критично */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
keepAwake();

// -------- загрузка мира с прогрессом (через fetch → Cache API уже прогрет SW) --------
async function fetchWorld(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('world http ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) { const b = await res.arrayBuffer(); window.__probe.worldBytes = b.byteLength; return new Uint8Array(b); }
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.byteLength;
    if (total) loadBar.style.width = Math.round((got / total) * 100) + '%';
  }
  const out = new Uint8Array(got);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  window.__probe.worldBytes = got;
  return out;
}

// -------- 2D fallback: тёмный дот-филд (он же debug-вид Фазы A) --------
function start2D(reason) {
  stage.replaceChildren();
  const cv = document.createElement('canvas'); stage.appendChild(cv);
  const ctx = cv.getContext('2d');
  const dots = Array.from({ length: 220 }, () => ({
    x: Math.random(), y: Math.random(), r: 0.5 + Math.random() * 1.8, s: 0.02 + Math.random() * 0.12,
  }));
  function size() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; }
  addEventListener('resize', size); size();
  let t = 0;
  (function loop() {
    t += 0.016;
    ctx.fillStyle = '#07080c'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = 'rgba(255,201,60,.10)'; ctx.lineWidth = 1;
    for (let gx = 0; gx < cv.width; gx += 90 * devicePixelRatio) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, cv.height); ctx.stroke(); }
    ctx.fillStyle = '#ffc93c';
    for (const d of dots) {
      const y = (d.y + t * d.s) % 1;
      ctx.globalAlpha = 0.35 + 0.5 * Math.sin((y + d.x) * Math.PI);
      ctx.beginPath(); ctx.arc(d.x * cv.width, y * cv.height, d.r * devicePixelRatio, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(loop);
  })();
  statusEl.textContent = 'Cat Conga · 2D mode' + (reason ? ' (' + reason + ')' : '');
  loader.classList.add('hidden');
  setMode('2d');
}

// -------- 3D: Spark сцена + минимальные тач-орбит контролы --------
async function start3D() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  stage.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 400);
  scene.add(new SparkRenderer({ renderer }));

  const bytes = await fetchWorld(WORLD_URL);
  loadMsg.textContent = 'unpacking splats…';
  const fileName = WORLD_URL.split('/').pop();
  const splats = new SplatMesh({ fileBytes: bytes, fileName });
  await splats.initialized;
  // 3DGS-тренеры дают Y вниз (OpenCV) — переворачиваем в OpenGL-ориентацию.
  splats.rotation.x = Math.PI;
  splats.updateMatrixWorld(true);
  scene.add(splats);
  const n = splats.numSplats ?? splats.packedSplats?.numSplats ?? 0;
  window.__probe.splatCount = n;
  statusEl.textContent = 'Cat Conga · ' + (n ? (n / 1000).toFixed(0) + 'k splats' : '3D');

  // Авто-фрейминг по манифесту мира (<world>.json: center/radius из исходного PLY).
  const target = new THREE.Vector3(0, 0, 0);
  let radius = 8;
  try {
    const mf = await fetch(WORLD_URL.replace(/\.\w+$/, '.json')).then((r) => (r.ok ? r.json() : null));
    if (mf && mf.center) {
      target.copy(splats.localToWorld(new THREE.Vector3(...mf.center)));
      radius = mf.radius || radius;
    }
  } catch { /* дефолтный фрейминг */ }
  camera.near = Math.max(0.02, radius / 500);
  camera.far = radius * 10;
  camera.updateProjectionMatrix();

  // Орбита вокруг центра сцены: 1 палец — вращение, 2 пальца — пинч-зум, авто-дрейф без касаний.
  let theta = 0.6, phi = 1.15, dist = radius * 0.9, auto = true;
  const ptrs = new Map(); let pinch0 = 0, dist0 = dist;
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { ptrs.set(e.pointerId, [e.clientX, e.clientY]); auto = false; });
  el.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) {
      theta -= (e.clientX - prev[0]) * 0.005;
      phi = Math.min(2.9, Math.max(0.25, phi - (e.clientY - prev[1]) * 0.005));
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (!pinch0) { pinch0 = d; dist0 = dist; }
      dist = Math.min(radius * 3, Math.max(radius * 0.05, dist0 * (pinch0 / d)));
    }
  });
  const lift = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = 0; };
  el.addEventListener('pointerup', lift); el.addEventListener('pointercancel', lift);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // FPS-probe: первые PROBE_SECONDS после первого кадра; провал → авто-2D.
  let frames = 0, probeStart = 0, probed = false, firstFrameAt = 0;
  function tick(tms) {
    if (!firstFrameAt) { firstFrameAt = tms; probeStart = tms; loader.classList.add('hidden'); setMode('3d'); }
    if (auto) theta += 0.0012;
    camera.position.set(
      target.x + dist * Math.sin(phi) * Math.cos(theta),
      target.y + dist * Math.cos(phi),
      target.z + dist * Math.sin(phi) * Math.sin(theta));
    camera.lookAt(target);
    renderer.render(scene, camera);
    frames++; window.__probe.frames = frames;
    if (!probed && tms - probeStart >= PROBE_SECONDS * 1000) {
      probed = true;
      const fps = frames / ((tms - probeStart) / 1000);
      window.__probe.fps = Math.round(fps * 10) / 10;
      if (fps < FPS_FLOOR) { renderer.setAnimationLoop(null); renderer.dispose(); start2D('low fps ' + window.__probe.fps); }
    }
  }
  renderer.setAnimationLoop(tick);
  // Гарантированный первый кадр даже там, где rAF заморожен (скрытая вкладка/headless-смоук):
  tick(performance.now());
  window.__renderOnce = () => { tick(performance.now()); return frames; };
}

async function boot() {
  errBox.classList.remove('show');
  if (qs.get('force2d') === '1') { start2D('forced'); return; }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) { start2D('no webgl2'); return; }
    await start3D();
  } catch (e) {
    window.__probe.errors.push('boot: ' + (e && e.message || e));
    setMode('error');
    loader.classList.add('hidden');
    errBox.classList.add('show');
  }
}
document.getElementById('retry').addEventListener('click', () => { setMode('loading'); loader.classList.remove('hidden'); boot(); });
boot();
