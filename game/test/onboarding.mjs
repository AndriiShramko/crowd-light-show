// §D-факты: онбординг («магнит» 30с / телепорт-подсказка 60с — здесь ускорены env) + milestone-ассерт §26
// (события ТОЛЬКО на 50/100/500/1000, не на каждый attach). Поднимает ЛОКАЛЬНЫЙ сервер сам.
// Запуск: node game/test/onboarding.mjs
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';

const PORT = 8091;
const HTTP = `http://127.0.0.1:${PORT}`;
const WSB = `ws://127.0.0.1:${PORT}`;
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { at: new Date().toISOString(), checks: {} };

// свежий DATA_DIR — чтобы не реставрировать старую цепь
const dataDir = OUT + 'onb-data-' + Date.now();
const srv = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../server/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, PORT: String(PORT), GAME_SESSION_SECRET: 'onb-test', SPAWN_R: '10', MAGNET_MS: '8000', HINT_MS: '14000', DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
await sleep(1200);

class C {
  constructor() { this.num = null; this.seat = -1; this.tail = null; this.pos = null; this.milestones = []; this.hint = null; }
  async enter() {
    const j = await fetch(`${HTTP}/api/join?room=MAIN`).then((r) => r.json());
    this.ws = new WebSocket(`${WSB}/ws?token=${j.token}`, { perMessageDeflate: false });
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (d, bin) => this.onMsg(d, bin));
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
  }
  onMsg(d, bin) {
    if (bin) { const cnt = d.readUInt16LE(5); for (let i = 0; i < cnt; i++) { const o = 7 + i * 10; if (d.readUInt32LE(o) === this.num) this.pos = { x: d.readInt16LE(o + 4) / 32, z: d.readInt16LE(o + 6) / 32 }; } return; }
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'hello') this.num = m.num;
    if (m.t === 'joined') this.seat = m.seat;
    if (m.t === 'tail') this.tail = m.tail;
    if (m.t === 'err' && m.code === 'too_far') this.tail = m.tail;
    if (m.t === 'milestone') this.milestones.push(m.ms);
    if (m.t === 'hint') { this.hint = m.kind; if (this.onHint) this.onHint(); }
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  d2tail() { return (this.pos && this.tail) ? Math.hypot(this.tail.x - this.pos.x, this.tail.z - this.pos.z) : null; }
}

// ---- голова: создаёт цепь и колеблется ----
const H = new C(); await H.enter(); await sleep(300);
H.send({ t: 'join_tail' });
const drvH = setInterval(() => { if (H.pos) { const a = Date.now() / 1600; H.send({ t: 'intent', x: 2 * Math.cos(a) - H.pos.x, z: 2 * Math.sin(a) - H.pos.z }); } }, 200);
await sleep(800);

// ---- 1) МАГНИТ: новичок БЕЗ intent должен дрейфовать к хвосту ----
const M = new C(); await M.enter(); await sleep(1200);
const d1 = M.d2tail();
await sleep(5000);                    // магнит-окно 8с — дрейф без единого intent
const d2 = M.d2tail();
const magnetPass = d1 != null && d2 != null && (d1 - d2 > 2.5 || d2 < 2.6);
report.checks.magnet = { dStart: +(+d1).toFixed(1), dAfter5s: +(+d2).toFixed(1), pass: magnetPass };
if (d2 != null && d2 < 3.5) M.send({ t: 'join_tail' });
await sleep(500);
report.checks.magnet.attached = M.seat >= 0;

// ---- 2) ТЕЛЕПОРТ-ПОДСКАЗКА: >HINT_MS без цепи → hint + перенос к хвосту ----
const T = new C(); await T.enter(); await sleep(500);
const drvT = setInterval(() => { if (T.pos && T.tail) { const dx = T.pos.x - T.tail.x, dz = T.pos.z - T.tail.z, d = Math.hypot(dx, dz) || 1; T.send({ t: 'intent', x: dx / d, z: dz / d }); } }, 250); // убегает ОТ хвоста
T.onHint = () => clearInterval(drvT); // по подсказке замираем — меряем ЭФФЕКТ телепорта, не дальнейший бег
await sleep(16000);                   // HINT_MS=14с
clearInterval(drvT);
await sleep(800);
const dT = T.d2tail();
report.checks.teleportHint = { hint: T.hint, dToTailAfter: dT == null ? null : +dT.toFixed(1), pass: T.hint === 'teleport' && dT != null && dT < 10 };

// ---- 3) MILESTONE §26: догнать цепь до 60 — ровно ОДНО событие, ровно на 50 ----
const bots = [H, M];
for (let i = bots.length; i < 60; i++) { const c = new C(); await c.enter(); bots.push(c); await sleep(25); }
const drv = setInterval(() => {
  for (const c of bots) {
    if (c.seat >= 0 || !c.pos || !c.tail) continue;
    const d = c.d2tail();
    if (d < 3.5) c.send({ t: 'join_tail' }); else c.send({ t: 'intent', x: (c.tail.x - c.pos.x) / d, z: (c.tail.z - c.pos.z) / d });
  }
}, 200);
let attached = 0;
for (let w = 0; w < 240; w++) { attached = bots.filter((c) => c.seat >= 0).length; if (attached === 60) break; await sleep(500); }
clearInterval(drv); clearInterval(drvH);
await sleep(1000);
const msH = H.milestones;             // голова онлайн с самого начала — видела все события
const only50 = msH.length === 1 && msH[0] === 50;
const noneOther = bots.every((c) => c.milestones.every((m) => [50, 100, 500, 1000].includes(m)));
report.checks.milestone = { attached, headSaw: msH, exactlyOneAt50: only50, allEventsAreCanon: noneOther, pass: attached === 60 && only50 && noneOther };

report.pass = Object.values(report.checks).every((c) => c.pass);
for (const c of bots) { try { c.ws.close(); } catch {} }
try { T.ws.close(); } catch {}
srv.kill();
fs.writeFileSync(OUT + 'onboarding_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
