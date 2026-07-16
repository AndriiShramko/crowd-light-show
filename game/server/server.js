// lightshow-game WS-сервер (Фазы B+C): authoritative tick 8 Гц, AOI+NEAR-cap, хоровод с сегмент-лидерами.
// Паттерны лайтшоу: hub/rooms, HMAC-токены, governor. Спека: vault spec-arch. deflate OFF, backpressure, SQLite-снапшот.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { verifyToken, issueToken } from './auth.js';
import { loadMask } from './mask.js';
import { Chain, SPACING, SEG, JOIN_RADIUS } from './chain.js';

const PORT = Number(process.env.PORT || 8081);
const TICK_HZ = 8, DT = 1 / TICK_HZ;
const SPEED = 2.0;                       // м/с, кламп сервера
const NEAR_CAP = Number(process.env.NEAR_CAP || 48);
const CELL_AOI = 24;                     // м, ячейка AOI (подписка 3×3)
const STALL_MS = 5000, GRACE_MS = 15000;
const BP_SOFT = 256 * 1024, BP_HARD = 1024 * 1024; // backpressure
const Q = 32;                            // квантование позиций (1/32 м)
const DATA_DIR = process.env.DATA_DIR || './data';
const MASK_PATH = process.env.MASK_PATH || '../static/worlds/arena-mask-v1.bin';
// Фаза 2 за фиче-флагами (тёмный код до юр/операторского гейта — [[spec-legal]])
const INVITES_ENABLED = process.env.INVITES_ENABLED === '1';
const INSCRIPTIONS_ENABLED = process.env.INSCRIPTIONS_ENABLED === '1';

const mask = loadMask(new URL(MASK_PATH, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_PATH = path.join(DATA_DIR, 'state.json');

// ---------- состояние ----------
const players = new Map();  // playerId -> P
let chain = null;           // MVP: одна цепочка на комнату
let nextNum = 1;
const numOf = new Map();    // playerId -> u32 для бинарного протокола
const CHAT_PHRASES = 12;    // индексов пресет-чата (тексты — на клиенте, PL/EN/RU/UA)
const chatBubbles = [];     // {num,i,at,x,z} — раздаём соседям, живут ~4 с
const purrs = [];           // {num,x,z,at} — волна мурлыка
const reports = [];         // {by,targetNum,at,snapshot} — лог оператору
let milestoneHit = 0;       // последний достигнутый milestone длины цепи
let pendingMilestone = 0;   // milestone к рассылке в ближайшем broadcast
const MILESTONES = [50, 100, 500, 1000];
// Игровые метрики события (§D): агрегаты для отчёта оператору
const metrics = { joins: 0, attaches: 0, identifies: 0, maxChainLen: 0, uniquePlayers: 0, worldLoadedBeacons: 0, fallback2dBeacons: 0 };

const SPAWN_R = Number(process.env.SPAWN_R || 60);
const MAGNET_MS = Number(process.env.MAGNET_MS || 30000); // «магнит» новичка (онбординг)
const HINT_MS = Number(process.env.HINT_MS || 60000);     // телепорт-подсказка без цепи
function spawnPos() {
  for (let i = 0; i < 100; i++) {
    const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * SPAWN_R;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (mask.walkable(x, z)) return { x, z };
  }
  return { x: 0, z: 0 };
}

function restore() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (s.chain && s.chain.members?.length) {
      chain = Object.assign(Object.create(Chain.prototype), s.chain);
    }
    console.log('restored: chain members =', chain?.length ?? 0);
  } catch (e) { console.error('restore failed', e.message); }
}
let saveTimer = null;
function scheduleSave() {                              // debounced атомарный JSON-снапшот (crash-recovery)
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = { chain: chain ? { id: chain.id, colorId: chain.colorId, members: chain.members, path: chain.path, cum: chain.cum } : null };
    const tmp = STATE_PATH + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, STATE_PATH); } catch (e) { console.error('save failed', e.message); }
  }, 5000);
}
restore();

// ---------- HTTP ----------
const t0boot = Date.now();
const tickLags = [];       // джиттер интервала sim (вторичное — включает конкуренцию за event loop)
const worldLoadMs = [];    // §D метрика: time-to-world-loaded (beacon клиента)
const timeToTailMs = [];   // §D метрика: вход→прицепился
const tickWork = [];       // ВРЕМЯ ВЫПОЛНЕНИЯ sim-тика (первичное: справляется ли sim в бюджете)
const bcWork = [];         // время выполнения broadcast
function pct(arr, p) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; }
function rec(arr, v) { arr.push(v); if (arr.length > 2000) arr.splice(0, 1000); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  // Анонимный вход: после handoff из лайтшоу клиент дёргает /api/join и получает game-токен (уникальный playerId).
  // Игра анонимна — auth-gate избыточен; токен подписан игровым секретом (celebrant playerId + room).
  if (u.pathname === '/api/join') {
    if (process.env.GAME_ENABLED === '0') { res.writeHead(503); return res.end('game disabled'); }
    const room = (u.searchParams.get('room') || 'MAIN').slice(0, 32);
    const playerId = 'p' + crypto.randomUUID();
    metrics.joins++;
    const token = issueToken('game', 10 * 60 * 1000, { room, playerId }); // TTL 10 мин
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ token, playerId, room, ws: '/ws' }));
  }
  // Клиентский beacon метрик (world-loaded / 2D-fallback) — для conversion-статистики
  if (u.pathname === '/api/metric') {
    const kind = u.searchParams.get('k');
    if (kind === 'world_loaded') { metrics.worldLoadedBeacons++; const ms = Number(u.searchParams.get('ms')); if (ms > 0 && ms < 600000) rec(worldLoadMs, ms); }
    else if (kind === 'fallback_2d') metrics.fallback2dBeacons++;
    res.writeHead(204); return res.end();
  }
  // Фаза 2 фиче-флаги: выключены → 403 (тест §29). При включении подключается модерация ([[spec-moderation]] Ф1).
  if (u.pathname === '/api/invite') { res.writeHead(INVITES_ENABLED ? 501 : 403); return res.end(INVITES_ENABLED ? 'not-impl' : 'invites disabled'); }
  if (u.pathname === '/api/inscription') { res.writeHead(INSCRIPTIONS_ENABLED ? 501 : 403); return res.end(INSCRIPTIONS_ENABLED ? 'not-impl' : 'inscriptions disabled'); }
  const tok = verifyToken(u.searchParams.get('token'));
  if (!tok || tok.role !== 'debug') { res.writeHead(401); return res.end('unauthorized'); }
  if (u.pathname === '/debug/reports') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ count: reports.length, recent: reports.slice(-5) }));
  }
  if (u.pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      uptimeSec: Math.round((Date.now() - t0boot) / 1000), clients: wss.clients.size,
      // ПЕРВИЧНОЕ: время обработки sim-тика (справляется ли в бюджете 125 мс)
      tickP50: pct(tickWork, 0.5), tickP95: pct(tickWork, 0.95), tickMax: +Math.max(0, ...tickWork).toFixed(1),
      // время выполнения рассылки снапшотов (бюджет 200 мс при 5 Гц)
      bcWorkP95: pct(bcWork, 0.95), bcWorkMax: +Math.max(0, ...bcWork).toFixed(1),
      // ВТОРИЧНОЕ: джиттер интервала (sim ждёт синхронный broadcast в том же потоке — не отставание)
      loopJitterP95: pct(tickLags, 0.95),
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      chain: chain ? { members: chain.length, pathPoints: chain.path.length, maxGap: chain.maxGap() } : null,
      game: { ...metrics, uniquePlayers: numOf.size,
        worldLoadedMsP50: pct(worldLoadMs, 0.5), timeToTailMsP50: pct(timeToTailMs, 0.5), timeToTailMsP90: pct(timeToTailMs, 0.9),
        identifyPct: numOf.size ? Math.round(100 * metrics.identifies / numOf.size) : 0,
        fallback2dPct: metrics.worldLoadedBeacons + metrics.fallback2dBeacons ? Math.round(100 * metrics.fallback2dBeacons / (metrics.worldLoadedBeacons + metrics.fallback2dBeacons)) : 0 },
    }));
  }
  if (u.pathname === '/debug/chain') {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!chain) return res.end(JSON.stringify({ chain: null }));
    const seats = chain.members.map((id, seat) => ({
      seat, playerId: id, leader: chain.isLeaderSeat(seat), head: seat === 0,
      ghost: players.get(id)?.ghost ?? true, connected: !!players.get(id)?.ws,
    }));
    // проверка циклов/сирот: уникальность id + все члены существуют в players (или ghost)
    const uniq = new Set(chain.members);
    return res.end(JSON.stringify({
      chain: { id: chain.id, colorId: chain.colorId, members: chain.length, pathPoints: chain.path.length, totalLen: chain.totalLen(), maxGap: chain.maxGap() },
      seats, unique: uniq.size === chain.members.length,
      orphans: chain.members.filter((id) => !players.has(id)),
      leadersEverySeg: seats.filter((s) => s.leader).map((s) => s.seat),
    }));
  }
  res.writeHead(404); res.end();
});

// ---------- WS ----------
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  if (process.env.GAME_ENABLED === '0') { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
  const tok = verifyToken(u.searchParams.get('token'));
  if (!tok || tok.role !== 'game' || !tok.playerId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConn(ws, tok));
});

function onConn(ws, tok) {
  const pid = String(tok.playerId);
  let p = players.get(pid);
  if (p && p.ghost) {                    // reconnect в grace: тот же seat
    p.ghost = false; p.ghostAt = 0;
    if (p.ws) try { p.ws.terminate(); } catch {}
    p.ws = ws;
  } else if (p && p.ws) {                // дубль-коннект того же playerId: новый вытесняет старый
    try { p.ws.close(4000, 'replaced'); } catch {}
    p.ws = ws;
  } else {
    const s = spawnPos();
    p = { id: pid, num: numOf.get(pid) ?? nextNum++, x: s.x, z: s.z, heading: 0,
      ix: 0, iz: 0, lastIntentAt: 0, lastMoveAt: Date.now(), intents: 0, joins: 0,
      enteredAt: Date.now(), hinted: false,               // онбординг: «магнит» 30 с + телепорт-подсказка 60 с
      ghost: false, ghostAt: 0, ws, mapOnly: false };
    numOf.set(pid, p.num);
    players.set(pid, p);
  }
  ws._pid = pid;
  const seat = chain ? chain.seatOf(pid) : -1;
  send(ws, { t: 'hello', num: p.num, playerId: pid, tick: TICK_HZ, spacing: SPACING, seg: SEG,
    seat, chainColor: chain?.colorId ?? null,
    mask: { url: '/static/worlds/arena-mask-v1.bin' }, tail: chain ? chain.tailPos() : null });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    if (m.t === 'ping') return send(ws, { t: 'pong', t0: m.t0, srv: now });
    if (m.t === 'intent') {
      if (++p.intents > 30) return;                       // governor 30/тик-окно (сбрасывается в тике)
      let ix = Number(m.x) || 0, iz = Number(m.z) || 0;
      const len = Math.hypot(ix, iz);
      if (len > 1) { ix /= len; iz /= len; }              // кламп интента
      p.ix = ix; p.iz = iz; p.lastIntentAt = now;
      return;
    }
    if (m.t === 'join_tail') {
      if (now - (p.lastJoinAt || 0) < 1000) return; p.lastJoinAt = now;
      if (chain && chain.seatOf(pid) >= 0) return send(ws, { t: 'err', code: 'already_in_chain' });
      if (!chain) {
        chain = new Chain('c1', 1 + Math.floor(Math.random() * 7), p);
        scheduleSave();
        return send(ws, { t: 'joined', seat: 0, head: true });
      }
      const tail = chain.tailPos();
      if (Math.hypot(p.x - tail.x, p.z - tail.z) > JOIN_RADIUS) {
        return send(ws, { t: 'err', code: 'too_far', tail });
      }
      const seat2 = chain.attach(pid);
      metrics.attaches++;
      rec(timeToTailMs, now - (p.enteredAt || now));       // §D метрика time-to-tail
      scheduleSave();
      return send(ws, { t: 'joined', seat: seat2, head: false, leader: chain.isLeaderSeat(seat2) });
    }
    if (m.t === 'detach') { leaveChain(pid); return; }
    if (m.t === 'map') { p.wantMap = !!m.on; return; }    // zoom-out подписка
    if (m.t === 'chat') {                                 // пресет-чат: только индекс фразы (не свободный текст)
      if (now - (p.lastChatAt || 0) < 2000) return;       // rate-limit 1 msg/2 с
      const idx = m.i | 0;
      if (idx < 0 || idx >= CHAT_PHRASES) return;
      p.lastChatAt = now;
      chatBubbles.push({ num: p.num, i: idx, at: now, x: p.x, z: p.z });
      return;
    }
    if (m.t === 'identify') {                             // identify me: цвет цепи (или свой) + номер, TTL 60 с, cooldown 10 с
      if (now - (p.lastIdAt || 0) < 10000) return send(ws, { t: 'err', code: 'id_cooldown' });
      p.lastIdAt = now;
      metrics.identifies++;
      const seatI = chain ? chain.seatOf(pid) : -1;
      return send(ws, { t: 'identify', num: p.num, colorId: seatI >= 0 ? chain.colorId : 0, ttl: 60 });
    }
    if (m.t === 'purr') {                                 // «мурлык»: волна по соседям (микро-агентность звена)
      if (now - (p.lastPurrAt || 0) < 1500) return;
      p.lastPurrAt = now;
      purrs.push({ num: p.num, x: p.x, z: p.z, at: now });
      return;
    }
    if (m.t === 'report') {                               // жалоба: снапшот последних чат-событий рядом → оператору-логу
      if (now - (p.lastReportAt || 0) < 5000) return;
      p.lastReportAt = now;
      const near = chatBubbles.filter((c) => now - c.at < 60000).slice(-20);
      reports.push({ by: p.num, targetNum: m.target | 0, at: now, snapshot: near });
      if (reports.length > 500) reports.splice(0, 250);
      return send(ws, { t: 'report_ack' });
    }
  });
  ws.on('close', () => {
    if (players.get(pid)?.ws !== ws) return;              // уже replaced
    p.ws = null;
    if (chain && chain.seatOf(pid) >= 0) { p.ghost = true; p.ghostAt = Date.now(); } // держим слот grace
    else players.delete(pid);
  });
}

function leaveChain(pid) {
  if (!chain) return;
  const seat = chain.seatOf(pid);
  if (seat < 0) return;
  if (seat === 0 && chain.length > 1) chain.transferHead();
  else chain.detach(pid);
  if (chain.length === 0) chain = null;
  const p = players.get(pid);
  if (p) send(p.ws, { t: 'detached' });
  scheduleSave();
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---------- тик ----------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  rec(tickLags, now - lastTick - 1000 / TICK_HZ);
  lastTick = now;
  const workStart = performance.now();

  // 0) холодный старт: мира без цепи не бывает — первый вошедший через 5 с автоматически
  // становится головой (иначе клиенты, ждущие «хвоста», никогда не создадут цепь — ноль инструкций)
  if (!chain && players.size > 0) {
    let first = null;
    for (const p of players.values()) if (!p.ghost && (!first || (p.enteredAt || 0) < (first.enteredAt || 0))) first = p;
    if (first && now - (first.enteredAt || 0) > 5000) {
      chain = new Chain('c1', 1 + Math.floor(Math.random() * 7), first);
      send(first.ws, { t: 'joined', seat: 0, head: true });
      send(first.ws, { t: 'you_are_head' });
      scheduleSave();
    }
  }

  // 1) интеграция свободных игроков и головы
  for (const p of players.values()) {
    p.intents = 0;
    const seat = chain ? chain.seatOf(p.id) : -1;
    const isFollower = seat > 0;
    if (isFollower) continue;                             // ведомых двигает полилиния
    if (p.ghost) continue;
    const step = SPEED * DT;
    let ix = p.ix, iz = p.iz;
    // онбординг-«магнит» (без слов): свободный новичок БЕЗ ввода первые 30 с дрейфует к хвосту.
    // Скорость = тот же SPEED-кламп (анти-чит §15 не ослабляем), просто интент подставляется сервером.
    if (seat < 0 && chain && chain.length > 0 && !ix && !iz && now - (p.enteredAt || 0) < MAGNET_MS) {
      const t = chain.tailPos();
      if (t) { const d = Math.hypot(t.x - p.x, t.z - p.z); if (d > 2.2) { ix = (t.x - p.x) / d; iz = (t.z - p.z) / d; } }
    }
    const nx = p.x + ix * step, nz = p.z + iz * step;
    if ((ix || iz)) {
      if (mask.walkable(nx, nz)) { p.x = nx; p.z = nz; p.lastMoveAt = now; }
      else if (mask.walkable(nx, p.z)) { p.x = nx; p.lastMoveAt = now; }   // скольжение вдоль стены
      else if (mask.walkable(p.x, nz)) { p.z = nz; p.lastMoveAt = now; }
      p.heading = Math.atan2(iz, ix);
    }
    // телепорт-подсказка: 60 с так и не в цепи → одноразовый перенос к хвосту + бессловесный тост 🐾
    if (seat < 0 && chain && chain.length > 0 && !p.hinted && now - (p.enteredAt || 0) > HINT_MS) {
      const t = chain.tailPos();
      if (t) {
        const tx = t.x + 1.5, tz = t.z + 1.5;
        if (mask.walkable(tx, tz)) { p.x = tx; p.z = tz; } else if (mask.walkable(t.x, t.z)) { p.x = t.x; p.z = t.z; }
      }
      p.hinted = true;
      send(p.ws, { t: 'hint', kind: 'teleport' });
    }
    if (seat === 0 && chain) chain.appendHead(p.x, p.z);
  }

  // 2) ведомые: позиция строго по полилинии
  if (chain) {
    for (let seat = 1; seat < chain.members.length; seat++) {
      const p = players.get(chain.members[seat]);
      if (!p) continue;
      const t = chain.pointBehind(seat * SPACING);
      p.heading = Math.atan2(t.z - p.z, t.x - p.x) || p.heading;
      p.x = t.x; p.z = t.z;
    }
    // 3) stalled-голова → авто-передача
    const head = players.get(chain.headId);
    if (chain.length > 1 && head && (head.ghost || now - Math.max(head.lastMoveAt, head.lastIntentAt) > STALL_MS)) {
      chain.transferHead();
      const nh = players.get(chain.headId);
      if (nh) send(nh.ws, { t: 'you_are_head' });
      scheduleSave();
    }
  }

  // 4) grace-истечение призраков
  for (const p of players.values()) {
    if (p.ghost && now - p.ghostAt > GRACE_MS) { leaveChain(p.id); players.delete(p.id); }
  }

  // 5) milestone цепи (эффекты ТОЛЬКО на 50/100/500/1000 — не на каждый attach)
  if (chain) {
    const len = chain.length;
    if (len > metrics.maxChainLen) metrics.maxChainLen = len;
    for (const ms of MILESTONES) {
      if (len >= ms && milestoneHit < ms) { milestoneHit = ms; pendingMilestone = ms; }
    }
  } else { milestoneHit = 0; }

  rec(tickWork, performance.now() - workStart);
}, 1000 / TICK_HZ);

// ---------- рассылка снапшотов ОТДЕЛЬНО от sim-тика (спека: снапшоты 5 Гц) ----------
const SNAP_HZ = Number(process.env.SNAP_HZ || 5);
setInterval(() => {
  const s = performance.now();
  broadcast(Date.now());
  rec(bcWork, performance.now() - s);
}, 1000 / SNAP_HZ);

// ---------- снапшоты: AOI grid, буфер один раз на ячейку ----------
const cellKey = (x, z) => `${Math.floor(x / CELL_AOI)}:${Math.floor(z / CELL_AOI)}`;
let mapBuf = null, mapBuiltAt = 0;

function buildMapBuf(now) {
  // MAP-уровень: полилинии цепочек (RDP до ≤20 точек), 1 Гц
  const chains = chain ? [chain] : [];
  let size = 6;
  const simp = chains.map((c) => {
    const pts = simplify(c.path, 20);
    size += 5 + pts.length * 4;
    return { c, pts };
  });
  const b = Buffer.alloc(size);
  let o = 0;
  b.writeUInt8(2, o); o += 1; b.writeUInt32LE(now >>> 0, o); o += 4; b.writeUInt8(simp.length, o); o += 1;
  for (const { c, pts } of simp) {
    b.writeUInt8(c.colorId, o); o += 1; b.writeUInt16LE(c.length, o); o += 2; b.writeUInt16LE(pts.length, o); o += 2;
    for (const p of pts) { b.writeInt16LE(Math.round(p.x * Q) | 0, o); o += 2; b.writeInt16LE(Math.round(p.z * Q) | 0, o); o += 2; }
  }
  return b;
}
function writeSelf(b, o, p, seat) {
  let flags = 128; // бит «это ты»
  if (seat >= 0) flags |= 1;
  if (seat >= 0 && chain.isLeaderSeat(seat)) flags |= 2;
  if (seat === 0) flags |= 4;
  b.writeUInt32LE(p.num, o);
  b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p.x * Q))), o + 4);
  b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p.z * Q))), o + 6);
  b.writeUInt8(((p.heading + Math.PI) / (2 * Math.PI) * 255) | 0, o + 8);
  b.writeUInt8(flags, o + 9);
}
function simplify(pts, maxN) {
  if (pts.length <= maxN) return pts;
  const step = (pts.length - 1) / (maxN - 1);
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

function broadcast(now) {
  // Канал событий (JSON, редкий): чат/мурлык/milestone. Соседям по AOI (чат/мурлык), всем (milestone).
  const freshChat = chatBubbles.filter((c) => now - c.at < 800);   // новые за окно снапшота
  if (chatBubbles.length > 400) chatBubbles.splice(0, 200);
  const freshPurr = purrs.filter((c) => now - c.at < 800);
  if (purrs.length > 400) purrs.splice(0, 200);
  let msMsg = null;
  if (pendingMilestone) { msMsg = JSON.stringify({ t: 'milestone', ms: pendingMilestone, len: chain?.length ?? 0 }); pendingMilestone = 0; }

  // соберём игроков по ячейкам + бинарные подбуферы per cell (сериализация 1 раз на ячейку)
  const cells = new Map();
  for (const p of players.values()) {
    if (p.ghost) continue;
    const k = cellKey(p.x, p.z);
    let c = cells.get(k); if (!c) { c = []; cells.set(k, c); }
    c.push(p);
  }
  const cellBuf = new Map();
  for (const [k, list] of cells) {
    const b = Buffer.alloc(list.length * 10);
    let o = 0;
    for (const p of list) {
      const seat = chain ? chain.seatOf(p.id) : -1;
      let flags = 0;
      if (seat >= 0) flags |= 1;
      if (seat >= 0 && chain.isLeaderSeat(seat)) flags |= 2;
      if (seat === 0) flags |= 4;
      b.writeUInt32LE(p.num, o); o += 4;
      b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p.x * Q))), o); o += 2;
      b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p.z * Q))), o); o += 2;
      b.writeUInt8(((p.heading + Math.PI) / (2 * Math.PI) * 255) | 0, o); o += 1;
      b.writeUInt8(flags, o); o += 1;
    }
    cellBuf.set(k, { buf: b, count: list.length });
  }
  if (!mapBuf || now - mapBuiltAt >= 1000) { mapBuf = buildMapBuf(now); mapBuiltAt = now; }

  // позиция хвоста (для стрелки-компаса свободных игроков) — раз в ~400 мс; JSON сериализуем ОДИН раз
  const sendTail = now - (broadcast._tailAt || 0) >= 400;
  let tailMsg = null;
  if (sendTail) {
    broadcast._tailAt = now;
    tailMsg = JSON.stringify({ t: 'tail', tail: chain ? chain.tailPos() : null, color: chain?.colorId ?? null, len: chain?.length ?? 0 });
  }

  // ШАРИМ NEAR-кадр по ЯЧЕЙКЕ: один merged-3×3 буфер на occupied-ячейку (сериализация 1 раз на ячейку, спека).
  // Клиенту с num вне кадра (переполнение капа в куче) — индивидуальный вариант с собой первым.
  const RING = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const frames = new Map(); // cellKey -> {buf, nums:Set}
  function frameFor(cx, cz) {
    const key = `${cx}:${cz}`;
    let f = frames.get(key);
    if (f) return f;
    const buf = Buffer.alloc(7 + NEAR_CAP * 10);
    const nums = new Set();
    let o = 7, total = 0;
    for (let r = 0; r < 9 && total < NEAR_CAP; r++) {
      const cb = cellBuf.get(`${cx + RING[r][0]}:${cz + RING[r][1]}`);
      if (!cb) continue;
      for (let i = 0; i < cb.count && total < NEAR_CAP; i++) {
        cb.buf.copy(buf, o, i * 10, i * 10 + 10);
        nums.add(cb.buf.readUInt32LE(i * 10));
        o += 10; total++;
      }
    }
    buf.writeUInt8(1, 0); buf.writeUInt32LE(now >>> 0, 1); buf.writeUInt16LE(total, 5);
    f = { buf: buf.subarray(0, o), nums };
    frames.set(key, f);
    return f;
  }
  const scratch = broadcast._scratch || (broadcast._scratch = Buffer.alloc(7 + (NEAR_CAP + 1) * 10));

  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    const p = players.get(ws._pid);
    if (!p) continue;
    if (ws.bufferedAmount > BP_HARD) { ws.terminate(); continue; }   // backpressure: hard → drop
    const mapOnly = ws.bufferedAmount > BP_SOFT;
    if (mapOnly || p.wantMap) {
      if (now - (p.lastMapAt || 0) >= 900) { p.lastMapAt = now; ws.send(mapBuf); }
      if (mapOnly) continue;   // soft backpressure: только MAP
    }
    if (tailMsg && ws.bufferedAmount < BP_SOFT && (!chain || chain.seatOf(p.id) < 0)) ws.send(tailMsg);
    // события (редкие, JSON): milestone всем; чат/мурлык — если источник в NEAR-радиусе
    if (ws.bufferedAmount < BP_SOFT) {
      if (msMsg) ws.send(msMsg);
      for (const c of freshChat) { if (c.num !== p.num && Math.abs(c.x - p.x) < CELL_AOI && Math.abs(c.z - p.z) < CELL_AOI) ws.send(JSON.stringify({ t: 'chat', num: c.num, i: c.i })); }
      for (const c of freshPurr) { if (c.num !== p.num && Math.abs(c.x - p.x) < CELL_AOI && Math.abs(c.z - p.z) < CELL_AOI) ws.send(JSON.stringify({ t: 'purr', num: c.num })); }
    }
    const cx = Math.floor(p.x / CELL_AOI), cz = Math.floor(p.z / CELL_AOI);
    const f = frameFor(cx, cz);
    if (f.nums.has(p.num)) { ws.send(f.buf); continue; }             // общий кадр ячейки (без копии)
    // редкий путь: кап вытеснил самого игрока → кадр «я первым» (в толпе твой кот не исчезает)
    let o = 7;
    writeSelf(scratch, o, p, chain ? chain.seatOf(p.id) : -1); o += 10;
    const room = Math.min(f.buf.length - 7, (NEAR_CAP - 1) * 10);
    f.buf.copy(scratch, o, 7, 7 + room); o += room;
    scratch.writeUInt8(1, 0); scratch.writeUInt32LE(now >>> 0, 1); scratch.writeUInt16LE(1 + room / 10, 5);
    ws.send(Buffer.from(scratch.subarray(0, o)));
  }
}

server.listen(PORT, () => console.log(`game-ws on :${PORT}, tick ${TICK_HZ} Hz, near-cap ${NEAR_CAP}, deflate OFF`));
