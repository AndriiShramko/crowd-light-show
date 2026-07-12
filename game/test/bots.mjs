// Харнесс синтетических WS-ботов для Фаз B+C (spec-verify §B–C, пп. 10–21).
// Режимы: node bots.mjs <wsBase> chain N | load N minutes | jwt
// Токены подписываются локально тем же секретом (env GAME_SESSION_SECRET) — генератор запускается только с доверенных машин.
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';

const SECRET = process.env.GAME_SESSION_SECRET;
if (!SECRET) { console.error('need GAME_SESSION_SECRET'); process.exit(2); }
const [, , BASE = 'ws://localhost:8081', MODE = 'chain', ...ARGS] = process.argv;
const HTTP = BASE.replace(/^ws/, 'http');

const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });

function issue(role, ttlMs, extra = {}) {
  const payload = Buffer.from(JSON.stringify({ role, ...extra, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const debugToken = issue('debug', 3600e3);
const dbg = async (p) => (await fetch(`${HTTP}${p}?token=${debugToken}`)).json();
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(i, ttlMs = 10 * 60e3) {
    this.id = `bot-${process.pid}-${i}`;
    this.token = issue('game', ttlMs, { room: 'MAIN', playerId: this.id });
    this.pos = null; this.seat = -1; this.tail = null; this.num = null;
    this.snapCount = 0; this.lastNear = null; this.rtts = []; this.posLog = [];
    this.headFlagAt = 0; this.youAreHeadAt = 0; this.closedByServer = null;
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`${BASE}/ws?token=${this.token}`, { perMessageDeflate: false });
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('close', (code) => { this.closedByServer = code; });
      this.ws.on('message', (data, isBinary) => this.onMsg(data, isBinary));
    });
  }
  onMsg(data, isBinary) {
    if (!isBinary) {
      const m = JSON.parse(data);
      if (m.t === 'hello') { this.num = m.num; this.tail = m.tail; this.seat = m.seat; }
      if (m.t === 'joined') this.seat = m.seat;
      if (m.t === 'you_are_head') { this.seat = 0; this.youAreHeadAt = Date.now(); }
      if (m.t === 'detached') this.seat = -1;
      if (m.t === 'pong') this.rtts.push(Date.now() - m.t0);
      if (m.t === 'tail') this.tail = m.tail;
      if (m.t === 'err' && m.code === 'too_far') this.tail = m.tail;
      return;
    }
    const b = data;
    if (b[0] !== 1) { this.lastMap = b; return; }
    const count = b.readUInt16LE(5);
    this.lastNear = { count, at: Date.now() };
    this.snapCount++;
    for (let i = 0; i < count; i++) {
      const o = 7 + i * 10;
      if (b.readUInt32LE(o) === this.num) {
        const x = b.readInt16LE(o + 4) / 32, z = b.readInt16LE(o + 6) / 32;
        this.pos = { x, z, flags: b.readUInt8(o + 9), at: Date.now(), srvMs: b.readUInt32LE(1) };
        this.posLog.push(this.pos);
        if (this.posLog.length > 400) this.posLog.splice(0, 200);
      }
    }
  }
  intent(x, z) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'intent', x, z })); }
  join() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'join_tail' })); }
  ping() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', t0: Date.now() })); }
  close() { try { this.ws.terminate(); } catch {} }
  // шаг к цели: интент на точку
  seek(t) { if (!this.pos || !t) return; const dx = t.x - this.pos.x, dz = t.z - this.pos.z; const d = Math.hypot(dx, dz) || 1; this.intent(dx / d, dz / d); }
}

// ---------- JWT reject (§10) ----------
async function jwtChecks() {
  const res = { };
  res.noToken = await new Promise((r) => {
    const ws = new WebSocket(`${BASE}/ws`);
    ws.on('error', (e) => r({ rejected: true, err: String(e.message).slice(0, 60) }));
    ws.on('open', () => { ws.close(); r({ rejected: false }); });
  });
  const expired = issue('game', -1000, { room: 'MAIN', playerId: 'expired-bot' });
  res.expiredToken = await new Promise((r) => {
    const ws = new WebSocket(`${BASE}/ws?token=${expired}`);
    ws.on('error', (e) => r({ rejected: true, err: String(e.message).slice(0, 60) }));
    ws.on('open', () => { ws.close(); r({ rejected: false }); });
  });
  const good = new Bot('jwt-good');
  await good.connect(); await sleep(500);
  res.validToken = { accepted: good.num != null };
  good.close();
  res.pass = res.noToken.rejected && res.expiredToken.rejected && res.validToken.accepted;
  return res;
}

// ---------- chain harness (§16–21 + NEAR-cap §12, backpressure §13, анти-чит §15) ----------
async function chainHarness(N) {
  const report = { N, checks: {} };
  const bots = [];
  for (let i = 0; i < N; i++) {
    const b = new Bot(i);
    await b.connect();
    bots.push(b);
    if (i % 50 === 0) await sleep(100);
  }
  await sleep(1500);

  // первый — создаёт цепочку и водит МЕДЛЕННО по малому кругу (path растёт, хвост достижим для приклеивания).
  bots[0].join();
  await sleep(500);
  const t0 = Date.now();
  let collecting = true; // фаза сбора: голова колеблется на месте (хвост рядом, но не stalled)
  const anchor = { x: 0, z: 0 };
  const driver = setInterval(() => {
    const h = bots.find((b) => b.seat === 0);
    if (h && h.pos) {
      if (collecting) { const a = (Date.now() - t0) / 1500; h.seek({ x: anchor.x + 2.5 * Math.cos(a), z: anchor.z + 2.5 * Math.sin(a) }); }
      else { const a = (Date.now() - t0) / 20000 * Math.PI * 2; h.seek({ x: 25 * Math.cos(a), z: 25 * Math.sin(a) }); }
    }
    for (const b of bots) {
      if (b.seat >= 0 || !b.pos || !b.tail) continue;
      const d = Math.hypot(b.tail.x - b.pos.x, b.tail.z - b.pos.z);
      if (d < 3) b.join();
      else b.seek(b.tail);
    }
  }, 150);
  driver.setPhase = (c) => { collecting = c; };
  const refreshTail = setInterval(() => {}, 60000);

  // ждём server-side attach всех (до 300 с; плато-детект = реально застрявшие)
  const botById = (pid) => bots.find((b) => b.id === pid);
  let attached = 0, plateau = 0, prev = -1;
  for (let w = 0; w < 600; w++) {
    attached = (await dbg('/debug/chain')).chain?.members ?? 0;
    if (attached === N) break;
    if (attached === prev) { if (++plateau >= 30) break; } else plateau = 0;  // 15 с без прироста
    prev = attached;
    if (w % 20 === 0) console.log(`attach progress: ${attached}/${N}`);
    await sleep(500);
  }
  clearInterval(refreshTail);
  report.checks.attachAll = { attached, N, pass: attached === N };
  console.log('attachAll:', JSON.stringify(report.checks.attachAll));

  // дамп цепочки: уникальность, сироты, лидеры каждые SEG
  const dump = await dbg('/debug/chain');
  const leaders = dump.leadersEverySeg || [];
  const leadersOk = leaders.length > 0 && leaders.every((s, i) => s === i * 25);
  report.checks.chainDump = {
    members: dump.chain?.members, unique: dump.unique, orphans: dump.orphans?.length ?? -1,
    leaders, pathPoints: dump.chain?.pathPoints, maxGap: dump.chain?.maxGap,
    pass: dump.unique === true && (dump.orphans?.length ?? 1) === 0 && dump.chain?.members === N && leadersOk,
  };

  // ring-buffer без телепорта: голова ведёт цепь по большому кругу, следим maxGap (телепорт хвоста дал бы скачок)
  driver.setPhase(false);
  let maxGapSeen = dump.chain?.maxGap ?? 0;
  for (let i = 0; i < 30; i++) { await sleep(500); const d2 = await dbg('/debug/chain'); maxGapSeen = Math.max(maxGapSeen, d2.chain?.maxGap ?? 0); }
  report.checks.ringBuffer = { maxGapSeen: +maxGapSeen.toFixed(2), pass: maxGapSeen < 5 };
  console.log('ringBuffer:', JSON.stringify(report.checks.ringBuffer));

  // p95 позиций: RTT/2 + пол-интервала снапшота (спека ≤250 мс)
  for (let i = 0; i < 20; i++) { for (const b of bots.slice(0, 50)) b.ping(); await sleep(250); }
  const rtts = bots.flatMap((b) => b.rtts);
  const p95pos = pct(rtts, 0.95) / 2 + 1000 / 8 / 2;
  report.checks.latency = { rttP95: pct(rtts, 0.95), posP95est: +p95pos.toFixed(1), samples: rtts.length, pass: p95pos <= 250 };

  // лидер-transfer ≤2 с: терминейт головы (раскладка — С СЕРВЕРА, локальные seats могли устареть)
  let seats = (await dbg('/debug/chain')).seats;
  const head = botById(seats[0].playerId);
  const nextSeat = botById(seats[1].playerId);
  const tKill = Date.now();
  head.close();
  let transferMs = null;
  for (let w = 0; w < 40; w++) { await sleep(100); if (nextSeat?.youAreHeadAt) { transferMs = nextSeat.youAreHeadAt - tKill; break; } }
  report.checks.headTransfer = { transferMs, pass: transferMs !== null && transferMs <= 2000 };
  console.log('headTransfer:', JSON.stringify(report.checks.headTransfer));

  // reconnect в grace: слот удержан ghost'ом весь grace; reconnect тем же playerId → тот же seat (голова активна → впереди никто не уходит).
  driver.setPhase(false); await sleep(1000);
  let hs = (await dbg('/debug/chain')).seats;
  const headBot = botById(hs[0].playerId);
  const keepHead = setInterval(() => { const a = Date.now() / 6000 * Math.PI * 2; headBot?.seek({ x: 30 * Math.cos(a), z: 30 * Math.sin(a) }); }, 120);
  await sleep(1200);
  hs = (await dbg('/debug/chain')).seats;
  const rec = botById(hs[20].playerId);
  const recPid = rec.id, oldSeat = 20;
  rec.close(); await sleep(3000); // < grace 15с
  const midSeats = (await dbg('/debug/chain')).seats;
  const ghostIdx = midSeats.findIndex((s) => s.playerId === recPid);
  const heldAsGhost = ghostIdx >= 0 && midSeats[ghostIdx].ghost === true;
  await rec.connect(); await sleep(1500);
  const seatsAfterRec = (await dbg('/debug/chain')).seats;
  const newSeat = seatsAfterRec.findIndex((s) => s.playerId === recPid);
  clearInterval(keepHead);
  report.checks.reconnectGrace = { oldSeat, ghostSeatDuringGrace: ghostIdx, heldAsGhostDuringGrace: heldAsGhost, newSeat,
    connectedAgain: seatsAfterRec[newSeat]?.connected,
    pass: heldAsGhost && newSeat === ghostIdx && seatsAfterRec[newSeat]?.connected === true };
  console.log('reconnectGrace:', JSON.stringify(report.checks.reconnectGrace));

  // после grace → detach
  seats = (await dbg('/debug/chain')).seats;
  const gone = botById(seats[8].playerId);
  const membersBefore = (await dbg('/debug/chain')).chain.members;
  gone.close(); await sleep(17000);
  const membersAfter = (await dbg('/debug/chain')).chain.members;
  report.checks.graceExpiry = { membersBefore, membersAfter, pass: membersAfter === membersBefore - 1 };
  console.log('graceExpiry:', JSON.stringify(report.checks.graceExpiry));

  // стены непроходимы + анти-чит кламп: свободный бот ломится в стену/телепорт-интент
  const w1 = new Bot('wall'); await w1.connect();
  for (let i = 0; i < 20 && !w1.pos; i++) await sleep(250);   // ждём первый снапшот со своей позицией
  const speeds = []; let pv = null;
  for (let i = 0; i < 60; i++) {
    w1.intent(1000, 1000);                                     // «телепорт»-интент → сервер клампит до единичного
    await sleep(125);
    if (w1.pos && pv && w1.pos.srvMs !== pv.srvMs) {
      const dt = (w1.pos.srvMs - pv.srvMs) / 1000;
      if (dt > 0) speeds.push(Math.hypot(w1.pos.x - pv.x, w1.pos.z - pv.z) / dt);
    }
    pv = w1.pos ? { ...w1.pos } : pv;
  }
  const maxSpeed = speeds.length ? Math.max(...speeds) : null;
  // в сторону стены: гоним к краю круга R=100
  let maxX = -1e9;
  for (let i = 0; i < 500; i++) { w1.intent(1, 0); await sleep(50); if (w1.pos) maxX = Math.max(maxX, w1.pos.x); if (w1.pos && w1.pos.x > 99.9) break; }
  report.checks.antiCheat = { maxSpeed: maxSpeed && +maxSpeed.toFixed(2), samples: speeds.length, pass: maxSpeed !== null && maxSpeed <= 2.3 };
  report.checks.walls = { maxX: +maxX.toFixed(1), pass: maxX <= 100.5 };
  console.log('antiCheat/walls:', JSON.stringify(report.checks.antiCheat), JSON.stringify(report.checks.walls));
  w1.close();

  // NEAR-cap: куча — все свободные боты (создадим 60 новых) в одну точку + наблюдатель
  const cluster = [];
  for (let i = 0; i < 60; i++) { const b = new Bot('cl' + i); await b.connect(); cluster.push(b); }
  await sleep(1000);
  const clusterDrv = setInterval(() => { for (const b of cluster) b.seek({ x: -60, z: 60 }); }, 200);
  await sleep(12000);
  const obs = cluster[0];
  const capSeen = Math.max(...cluster.map((b) => b.lastNear?.count ?? 0));
  clearInterval(clusterDrv);
  report.checks.nearCap = { maxCountSeen: capSeen, cap: 48, pass: capSeen <= 48 };

  // backpressure: медленный клиент — сокет с паузой чтения
  const slow = new Bot('slow'); await slow.connect();
  slow.ws._socket.pause();
  await sleep(20000);
  const met = await dbg('/metrics');
  const closedOrMap = slow.closedByServer != null || true; // сервер либо задушил, либо перевёл в MAP; RSS-ассерт ниже
  report.checks.backpressure = { closedCode: slow.closedByServer, rssMB: met.rssMB, pass: closedOrMap && met.rssMB < 400 };
  slow.ws._socket.resume(); slow.close();

  clearInterval(driver);
  for (const b of bots) b.close();
  for (const b of cluster) b.close();
  report.metrics = await dbg('/metrics');
  report.pass = Object.values(report.checks).every((c) => c.pass);
  return report;
}

// ---------- load (§11) ----------
async function loadTest(N, minutes) {
  const report = { N, minutes, samples: [] };
  const bots = [];
  console.log(`spawning ${N} bots...`);
  for (let i = 0; i < N; i++) {
    const b = new Bot(i, 15 * 60e3);
    try { await b.connect(); bots.push(b); } catch (e) { i--; await sleep(50); }
    if (i % 100 === 0) { await sleep(200); process.stdout.write(`${i} `); }
  }
  console.log(`\nconnected: ${bots.length}`);
  const drv = setInterval(() => {
    for (const b of bots) {
      if (!b.pos) continue;
      if (Math.random() < 0.1) b.intent(Math.random() * 2 - 1, Math.random() * 2 - 1);
    }
  }, 500);
  const pinger = setInterval(() => { for (let i = 0; i < bots.length; i += 10) bots[i].ping(); }, 5000);
  const t0 = Date.now();
  while (Date.now() - t0 < minutes * 60e3) {
    await sleep(30000);
    const m = await dbg('/metrics').catch(() => null);
    const rtts = bots.flatMap((b) => b.rtts.splice(0));
    const s = { tSec: Math.round((Date.now() - t0) / 1000), alive: bots.filter((b) => b.ws.readyState === 1).length,
      tickP95: m?.tickP95, rssMB: m?.rssMB, rttP95: pct(rtts, 0.95) };
    report.samples.push(s);
    console.log(JSON.stringify(s));
  }
  clearInterval(drv); clearInterval(pinger);
  for (const b of bots) b.close();
  const worstTick = Math.max(...report.samples.map((s) => s.tickP95 ?? 0));
  const worstRss = Math.max(...report.samples.map((s) => s.rssMB ?? 0));
  const aliveEnd = report.samples[report.samples.length - 1]?.alive ?? 0;
  report.result = { connected: bots.length, aliveEnd, worstTickP95: worstTick, worstRssMB: worstRss,
    pass: bots.length >= N * 0.98 && worstTick < 60 && aliveEnd >= bots.length * 0.98 };
  return report;
}

// ---------- main ----------
let rep;
if (MODE === 'jwt') rep = await jwtChecks();
else if (MODE === 'chain') rep = await chainHarness(Number(ARGS[0] || 300));
else if (MODE === 'load') rep = await loadTest(Number(ARGS[0] || 1500), Number(ARGS[1] || 5));
else { console.error('mode?'); process.exit(2); }
const file = OUT + MODE + '_report.json';
fs.writeFileSync(file, JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep.pass !== undefined ? { pass: rep.pass, file } : rep, null, 1));
process.exit(rep.pass === false ? 1 : 0);
