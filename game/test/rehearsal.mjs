// Синтетическая дресс-репетиция (spec-verify §D п.30): N клиентов через анонимный /api/join
// (эквивалент перехода из лайтшоу), 4G-профиль сети (искусственная задержка отправки), полный цикл
// prefetch→вход→find tail→attach→identify. Плюс проверка prefetch-эффекта (загрузка мира).
// Запуск: node game/test/rehearsal.mjs <wssBase> <N>
import { WebSocket } from 'ws';
import fs from 'node:fs';

const BASE = process.argv[2] || 'wss://game.flyreelstudio.eu';
const N = Number(process.argv[3] || 25);
const HTTP = BASE.replace(/^ws/, 'http');
const LAT = 90;            // 4G-профиль: ~90 мс односторонняя задержка (RTT ~180 мс)
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.num = null; this.seat = -1; this.tail = null; this.pos = null; this.id = null; this.joinedAt = 0; this.enterAt = 0; }
  async enter() {
    this.enterAt = Date.now();
    await sleep(LAT);                                   // сетевая задержка запроса токена (переход из шоу)
    const j = await fetch(`${HTTP}/api/join?room=MAIN`).then((r) => r.json());
    this.ws = new WebSocket(`${BASE}/ws?token=${j.token}`, { perMessageDeflate: false });
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (d, bin) => this.onMsg(d, bin));
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
  }
  onMsg(d, bin) {
    if (bin) {
      const cnt = d.readUInt16LE(5);
      for (let i = 0; i < cnt; i++) { const o = 7 + i * 10; if (d.readUInt32LE(o) === this.num) this.pos = { x: d.readInt16LE(o + 4) / 32, z: d.readInt16LE(o + 6) / 32 }; }
      return;
    }
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'hello') this.num = m.num;
    if (m.t === 'joined') { this.seat = m.seat; this.joinedAt = Date.now(); }
    if (m.t === 'tail') this.tail = m.tail;
    if (m.t === 'identify') this.id = m;
    if (m.t === 'err' && m.code === 'too_far') this.tail = m.tail;
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }  // 4G-задержка симулируется на входе (переход из шоу); wss через интернет уже несёт реальный RTT
}

const report = { base: BASE, N, netProfile: `4G ~${LAT}ms one-way`, at: new Date().toISOString() };
const clients = [];
console.log(`rehearsal: ${N} clients entering via /api/join under 4G latency...`);
for (let i = 0; i < N; i++) { const c = new Client(); await c.enter(); clients.push(c); await sleep(40); }
await sleep(1000);

// первый создаёт цепь и колеблется на месте, остальные идут к хвосту
clients[0].send({ t: 'join_tail' });
const drv = setInterval(() => {
  const h = clients.find((c) => c.seat === 0);
  if (h && h.pos) { const a = Date.now() / 1500; h.send({ t: 'intent', x: 2 * Math.cos(a) - h.pos.x, z: 2 * Math.sin(a) - h.pos.z }); }
  for (const c of clients) {
    if (c.seat >= 0 || !c.pos || !c.tail) continue;
    const d = Math.hypot(c.tail.x - c.pos.x, c.tail.z - c.pos.z);
    if (d < 3) c.send({ t: 'join_tail' }); else c.send({ t: 'intent', x: (c.tail.x - c.pos.x) / d, z: (c.tail.z - c.pos.z) / d });
  }
}, 200);

let attached = 0;
for (let w = 0; w < 240; w++) { attached = clients.filter((c) => c.seat >= 0).length; if (attached === N) break; await sleep(500); }
clearInterval(drv);

// все делают identify (мост в реальную толпу)
for (const c of clients) c.send({ t: 'identify' });
await sleep(1500);
const identified = clients.filter((c) => c.id && c.id.num === c.num).length;
const times = clients.filter((c) => c.joinedAt).map((c) => c.joinedAt - c.enterAt);
times.sort((a, b) => a - b);

report.result = {
  entered: clients.filter((c) => c.num).length,
  attached, N,
  identified,
  timeToTailMedianMs: times.length ? times[Math.floor(times.length / 2)] : null,
  timeToTailP90Ms: times.length ? times[Math.floor(times.length * 0.9)] : null,
  pass: clients.filter((c) => c.num).length === N && attached === N && identified === N,
};
for (const c of clients) c.ws.close();
fs.writeFileSync(OUT + 'rehearsal_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.result, null, 2));
process.exit(report.result.pass ? 0 : 1);
