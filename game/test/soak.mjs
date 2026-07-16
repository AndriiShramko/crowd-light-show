// §28 Soak: 200 клиентов × 10 мин на ЛОКАЛЬНОМ сервере (текущий код) — 0 крашей, 0 внеплановых
// дропов, RSS-ассерт, tick p95. Запуск: node game/test/soak.mjs [clients] [minutes]
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';

const N = Number(process.argv[2] || 200);
const MIN = Number(process.argv[3] || 10);
const PORT = 8095, SECRET = 'soak-test';
const HTTP = `http://127.0.0.1:${PORT}`;
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../server/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, PORT: String(PORT), GAME_SESSION_SECRET: SECRET, SPAWN_R: '30', DATA_DIR: OUT + 'soak-' + Date.now() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvDied = false;
srv.on('exit', () => { srvDied = true; });
await sleep(1500);

function dbgToken() { const p = Buffer.from(JSON.stringify({ role: 'debug', exp: Date.now() + 3600e3 })).toString('base64url'); return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); }

const clients = [];
let drops = 0;
for (let i = 0; i < N; i++) {
  const j = await fetch(`${HTTP}/api/join?room=MAIN`).then((r) => r.json());
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${j.token}`, { perMessageDeflate: false });
  const c = { ws, num: null, seat: -1, tail: null, pos: null, closedPlanned: false };
  ws.binaryType = 'nodebuffer';
  ws.on('message', (d, bin) => {
    if (bin) { const cnt = d.readUInt16LE(5); for (let k = 0; k < cnt; k++) { const o = 7 + k * 10; if (d.readUInt32LE(o) === c.num) c.pos = { x: d.readInt16LE(o + 4) / 32, z: d.readInt16LE(o + 6) / 32 }; } return; }
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'hello') c.num = m.num;
    if (m.t === 'joined') c.seat = m.seat;
    if (m.t === 'tail' || (m.t === 'err' && m.code === 'too_far')) c.tail = m.tail;
  });
  ws.on('close', () => { if (!c.closedPlanned) drops++; });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  clients.push(c);
  if (i % 25 === 0) await sleep(100);
}
console.log(`soak: ${N} clients connected, ${MIN} min...`);

// половина строит цепь, половина бродит; чат/purr/identify изредка
const drv = setInterval(() => {
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    if (c.ws.readyState !== 1) continue;
    const send = (o) => c.ws.send(JSON.stringify(o));
    if (i % 2 === 0) {
      if (c.seat < 0 && c.pos && c.tail) {
        const d = Math.hypot(c.tail.x - c.pos.x, c.tail.z - c.pos.z);
        if (d < 3.5) send({ t: 'join_tail' }); else send({ t: 'intent', x: (c.tail.x - c.pos.x) / d, z: (c.tail.z - c.pos.z) / d });
      } else if (c.seat === 0 && c.pos) { const a = Date.now() / 1700; send({ t: 'intent', x: 3 * Math.cos(a) - c.pos.x, z: 3 * Math.sin(a) - c.pos.z }); }
    } else {
      const a = (Date.now() / 900 + i);
      send({ t: 'intent', x: Math.cos(a), z: Math.sin(a) });
      if (Math.random() < 0.005) send({ t: 'chat', i: i % 12 });
      if (Math.random() < 0.003) send({ t: 'purr' });
      if (Math.random() < 0.002) send({ t: 'identify' });
    }
  }
}, 250);

const rss = [], ticks = [];
const t0 = Date.now();
while (Date.now() - t0 < MIN * 60 * 1000 && !srvDied) {
  await sleep(60000);
  try {
    const m = await fetch(`${HTTP}/metrics?token=${dbgToken()}`).then((r) => r.json());
    rss.push(m.rssMB); ticks.push(m.tickP95);
    console.log(`t=${Math.round((Date.now() - t0) / 60000)}min rss=${m.rssMB}MB tickP95=${m.tickP95}ms clients=${m.clients} chain=${m.chain?.members ?? 0}`);
  } catch (e) { console.log('metrics err', e.message); }
}
clearInterval(drv);
const alive = clients.filter((c) => c.ws.readyState === 1).length;
for (const c of clients) { c.closedPlanned = true; try { c.ws.close(); } catch {} }
await sleep(500);

const report = { soak: {
  clients: N, durationMin: MIN, rssMB_series: rss,
  rss_stable: rss.length >= 2 && (rss[rss.length - 1] - Math.min(...rss)) < 60,
  tickP95ms: Math.max(...ticks),
  crashes: srvDied ? 1 : 0, drops, aliveAtEnd: alive,
  pass: !srvDied && drops === 0 && alive === N && rss.length >= 2 && (rss[rss.length - 1] - Math.min(...rss)) < 60,
} };
srv.kill();
fs.writeFileSync(OUT + 'soak_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.soak.pass ? 0 : 1);
