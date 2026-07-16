// Дресс-репетиция v2 (spec-verify Трек E + §22/§23): ПОЛНЫЙ цикл от лайтшоу —
// N audience-клиентов (4G-профиль) на ЛОКАЛЬНОМ лайтшоу → operator prefetch (рандомизация по окну,
// реальная закачка мира) → operator game push (T0) → джиттер входа <5с → prod game: join→attach→identify.
// Запуск: node game/test/rehearsal2.mjs [N] [gameBase]
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';

const N = Number(process.argv[2] || 25);
const GAME = process.argv[3] || 'wss://game.flyreelstudio.eu';
const GHTTP = GAME.replace(/^ws/, 'http');
const LS = 'http://127.0.0.1:3021';
const LAT = () => 70 + Math.random() * 60;        // 4G: 70–130 мс односторонняя
const PREFETCH_WIN_MS = 15000;                    // окно рандомизации в тесте (в проде 240с)
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { at: new Date().toISOString(), N, netProfile: '4G 70-130ms one-way', game: GAME, checks: {} };

// ---- локальный лайтшоу ----
const ls = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, PORT: '3021', OPERATOR_PASS: 'devpass', DATA_DIR: OUT + 'ls-data-' + Date.now() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
ls.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stdout.write('[ls!] ' + s); });
let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`${LS}/healthz`)).ok; } catch {} if (!up) await sleep(500); }
if (!up) { console.error('local lightshow did not start'); ls.kill(); process.exit(1); }

// ---- N зрителей: лайтшоу-WS (как audience.js: hello → index; ждут prefetch/game) ----
class Viewer {
  constructor(i) { this.i = i; this.idx = -1; this.prefetch = null; this.game = null; this.fetchedAt = null; this.fetchMs = null; }
  async enter() {
    this.ws = new WebSocket(LS.replace(/^http/, 'ws') + '/ws');
    this.ws.on('message', async (d) => {
      await sleep(LAT());                                          // сетевая задержка доставки
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.t === 'index') this.idx = m.index | 0;
      if (m.t === 'prefetch' && !this.prefetch) {
        // та же формула джиттера, что в public/audience.js (myIndex*2654435761 >>> 0 % window)
        const delay = ((Math.max(0, this.idx) * 2654435761) >>> 0) % PREFETCH_WIN_MS;
        this.prefetch = { at: Date.now(), delay };
        setTimeout(async () => {
          const t0 = Date.now();
          try { const r = await fetch(m.sceneUrl); await r.arrayBuffer(); this.fetchMs = Date.now() - t0; this.fetchedAt = Date.now(); } catch {}
        }, delay);
      }
      if (m.t === 'game' && !this.game) {
        const jit = ((Math.max(0, this.idx) * 2654435761) >>> 0) % 5000;
        this.game = { url: m.url, T0: +m.T0, jit };
        const wait = Math.max(0, +m.T0 - Date.now()) + jit;
        setTimeout(() => this.enterGame().catch(() => {}), wait);
      }
    });
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.send(JSON.stringify({ t: 'hello', room: 'main', platform: 'other' }));
  }
  async enterGame() {
    this.gameEnterAt = Date.now();
    await sleep(LAT());
    const j = await fetch(`${GHTTP}/api/join?room=MAIN`).then((r) => r.json());
    this.g = { num: null, seat: -1, tail: null, pos: null, id: null };
    this.gws = new WebSocket(`${GAME}/ws?token=${j.token}`, { perMessageDeflate: false });
    this.gws.binaryType = 'nodebuffer';
    this.gws.on('message', (d, bin) => {
      if (bin) { const cnt = d.readUInt16LE(5); for (let k = 0; k < cnt; k++) { const o = 7 + k * 10; if (d.readUInt32LE(o) === this.g.num) this.g.pos = { x: d.readInt16LE(o + 4) / 32, z: d.readInt16LE(o + 6) / 32 }; } return; }
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.t === 'hello') this.g.num = m.num;
      if (m.t === 'joined') { this.g.seat = m.seat; this.attachedAt = Date.now(); }
      if (m.t === 'tail') this.g.tail = m.tail;
      if (m.t === 'err' && m.code === 'too_far') this.g.tail = m.tail;
      if (m.t === 'identify') this.g.id = m;
    });
    await new Promise((res, rej) => { this.gws.on('open', res); this.gws.on('error', rej); });
  }
  gsend(o) { if (this.gws?.readyState === 1) this.gws.send(JSON.stringify(o)); }
}

const vs = [];
for (let i = 0; i < N; i++) { const v = new Viewer(i); await v.enter(); vs.push(v); await sleep(30); }
await sleep(1200);

// ---- оператор: login → prefetch → game ----
const login = await fetch(`${LS}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'devpass' }) }).then((r) => r.json());
const op = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
const worldUrl = 'https://game.flyreelstudio.eu/static/worlds/dubai-b5-v1.sog';
await fetch(`${LS}/api/operator/game-prefetch`, { method: 'POST', headers: op, body: JSON.stringify({ sceneUrl: worldUrl }) });
await sleep(PREFETCH_WIN_MS + 8000);              // даём окну рандомизации отработать + закачка

const delays = vs.filter((v) => v.prefetch).map((v) => v.prefetch.delay).sort((a, b) => a - b);
const fetched = vs.filter((v) => v.fetchMs != null).length;
report.checks.prefetch = {
  received: vs.filter((v) => v.prefetch).length, fetched,
  delaySpreadMs: delays.length ? [delays[0], delays[delays.length - 1]] : null,
  distinctDelays: new Set(delays).size,
  fetchMsMedian: (() => { const f = vs.map((v) => v.fetchMs).filter((x) => x != null).sort((a, b) => a - b); return f.length ? f[Math.floor(f.length / 2)] : null; })(),
  pass: fetched === N && new Set(delays).size >= Math.min(N, 10) && delays[delays.length - 1] - delays[0] > PREFETCH_WIN_MS * 0.5,
};

const T0 = Date.now() + 3000;
await fetch(`${LS}/api/operator/game-launch`, { method: 'POST', headers: op, body: JSON.stringify({ url: 'https://game.flyreelstudio.eu/play.html?room=MAIN', inSec: 3 }) });

// ---- вход в игру по T0+джиттер; затем find-tail→attach (магнит сервера помогает без интента) ----
await sleep(3000 + 5000 + 2000);                  // T0 + джиттер-окно + запас
const entered = vs.filter((v) => v.g?.num != null).length;
const jits = vs.filter((v) => v.game).map((v) => v.game.jit).sort((a, b) => a - b);

vs[0]?.gsend({ t: 'join_tail' });                 // существующая цепь MAIN подхватит; если пусто — первый создаст
const drv = setInterval(() => {
  for (const v of vs) {
    const g = v.g; if (!g || g.seat >= 0 || !g.pos) continue;
    if (!g.tail) { v.gsend({ t: 'join_tail' }); continue; }   // спросить хвост (err too_far вернёт tail)
    const d = Math.hypot(g.tail.x - g.pos.x, g.tail.z - g.pos.z);
    if (d < 3.5) v.gsend({ t: 'join_tail' }); else v.gsend({ t: 'intent', x: (g.tail.x - g.pos.x) / d, z: (g.tail.z - g.pos.z) / d });
  }
}, 220);
let attached = 0;
for (let w = 0; w < 240; w++) { attached = vs.filter((v) => v.g?.seat >= 0).length; if (attached === entered) break; await sleep(500); }
clearInterval(drv);
for (const v of vs) v.gsend({ t: 'identify' });
await sleep(2000);
const identified = vs.filter((v) => v.g?.id && v.g.id.num === v.g.num).length;
const t2t = vs.filter((v) => v.attachedAt && v.gameEnterAt).map((v) => v.attachedAt - v.gameEnterAt).sort((a, b) => a - b);

report.checks.transition = {
  entered, attached, identified,
  entryJitterSpreadMs: jits.length ? [jits[0], jits[jits.length - 1]] : null,
  distinctJitters: new Set(jits).size,
  timeToTailMedianMs: t2t.length ? t2t[Math.floor(t2t.length / 2)] : null,
  timeToTailP90Ms: t2t.length ? t2t[Math.floor(t2t.length * 0.9)] : null,
  pass: entered === N && attached === N && identified === N && new Set(jits).size >= Math.min(N, 10),
};

report.pass = Object.values(report.checks).every((c) => c.pass);
for (const v of vs) { try { v.ws.close(); v.gws?.close(); } catch {} }
ls.kill();
fs.writeFileSync(OUT + 'rehearsal2_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
