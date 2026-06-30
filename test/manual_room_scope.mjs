// ROUND 14 — the VJ manual override + palette are room-scoped via the signed console token (read
// server-side, never from the body), exactly like preset/fx. A console can only ever drive its OWN
// room: setting manual+palette in room A must NEVER reach a phone in room B. Mirrors public_console.mjs.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3080';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function mintRoom(b) {
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  return await con.evaluate(() => window.__SESSION__);
}
const post = (sess, p, body) => fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(j);

async function main() {
  const b = await chromium.launch();
  const A = await mintRoom(b);
  const B = await mintRoom(b);
  check('two_distinct_rooms', A.room !== B.room, `A=${A.room} B=${B.room}`);

  // a phone in room B
  const phB = await (await b.newContext()).newPage();
  await phB.goto(`${BASE}/join?room=${B.room}&auto=1`);
  await phB.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(500);

  // drive manual + palette in room A only
  await post(A, '/api/console/manual', { on: true, mode: 'full', hue: 300, sat: 1, bri: 1 });
  await post(A, '/api/console/palette', { on: true, colors: [[255, 0, 255]] });
  await sleep(700);

  const seen = await phB.evaluate(() => ({ m: window.__cls.manual, p: window.__cls.palette }));
  check('room_B_unaffected', !seen.m.on && !seen.p.on, `room B phone saw manual=${JSON.stringify(seen.m)} palette=${JSON.stringify(seen.p)}`);

  // and a phone in room A DOES see it (positive control)
  const phA = await (await b.newContext()).newPage();
  await phA.goto(`${BASE}/join?room=${A.room}&auto=1`);
  await phA.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(700);
  const seenA = await phA.evaluate(() => ({ m: window.__cls.manual, p: window.__cls.palette }));
  check('room_A_receives', seenA.m.on && seenA.p.on, `room A phone manual=${JSON.stringify(seenA.m)} palette=${JSON.stringify(seenA.p)}`);

  await b.close();
  if (fails.length) { console.error('MANUAL ROOM-SCOPE FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('MANUAL ROOM-SCOPE PASS: manual+palette set in room A never reached room B; room A inherited it on late join.');
}
main().catch((e) => { console.error(e); process.exit(1); });
