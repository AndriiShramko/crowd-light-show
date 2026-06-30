// ROUND 14 — prove the WHOLE pro-VJ chain by fact: a real OSC UDP packet -> the standalone bridge
// (spawned as it would run on a VJ's laptop) -> the show's External Control API -> a real connected
// phone's state changes. Also proves the server still clamps a hostile value (governor not bypassed).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '../tools/vj-bridge/osc.mjs';

const BASE = process.env.BASE || 'http://localhost:3080';
const dir = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };
const OSC_PORT = 9933;
const udp = dgram.createSocket('udp4');
const sendOsc = (addr, args) => new Promise((res) => udp.send(encode(addr, args || []), OSC_PORT, '127.0.0.1', () => res()));

async function main() {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const con = await (await b.newContext()).newPage();
  await con.goto(BASE + '/studio');
  await con.waitForFunction(() => window.__SESSION__ && window.__SESSION__.room, { timeout: 12000 });
  const sess = await con.evaluate(() => window.__SESSION__);
  await con.click('#playSound').catch(() => {});
  await con.waitForFunction(() => window.__cls && window.__cls.status === 'running', { timeout: 12000 }).catch(() => {});

  const ph = await (await b.newContext()).newPage();
  await ph.goto(`${BASE}/join?room=${sess.room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await sleep(500);

  // spawn the bridge exactly as a VJ would, pointed at this room's console token
  const bridge = spawn(process.execPath, [path.join(dir, '..', 'tools', 'vj-bridge', 'bridge.mjs'),
    '--api', BASE, '--token', sess.token, '--osc-port', String(OSC_PORT), '--osc-host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let bootErr = '';
  bridge.stderr.on('data', (d) => { bootErr += d.toString(); });
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('bridge did not start: ' + bootErr)), 8000); bridge.stdout.on('data', (d) => { if (/listening/i.test(d.toString())) { clearTimeout(to); res(); } }); });
  check('bridge_started', true, 'bridge listening on UDP ' + OSC_PORT);

  // 1) /cls/preset s "rainbow_chase" -> phone switches preset
  await sendOsc('/cls/preset', [{ type: 's', value: 'rainbow_chase' }]);
  await ph.waitForFunction(() => window.__cls.screen.preset === 'rainbow_chase', { timeout: 4000 }).catch(() => {});
  check('osc_preset', (await ph.evaluate(() => window.__cls.screen.preset)) === 'rainbow_chase', 'phone preset=' + (await ph.evaluate(() => window.__cls.screen.preset)));

  // 2) /cls/manual/hue f 0.5 -> phone manual on, hue ~180
  await sendOsc('/cls/manual/hue', [{ type: 'f', value: 0.5 }]);
  await sleep(600);
  const m = await ph.evaluate(() => window.__cls.manual);
  check('osc_manual_hue', m && m.on && Math.abs(m.hue - 180) < 8, 'phone manual=' + JSON.stringify(m));

  // 3) /cls/palette s "0000ff" -> phone palette on with 1 colour
  await sendOsc('/cls/palette', [{ type: 's', value: '0000ff' }]);
  await sleep(600);
  const pal = await ph.evaluate(() => window.__cls.palette);
  check('osc_palette', pal && pal.on && pal.colors.length === 1, 'phone palette=' + JSON.stringify(pal));

  // 4) /cls/fx s "salute" -> phone plays the firework
  await sendOsc('/cls/fx', [{ type: 's', value: 'salute' }]);
  await sleep(700);
  check('osc_fx', (await ph.evaluate(() => window.__cls.fx && window.__cls.fx.name)) === 'salute', 'phone fx=' + JSON.stringify(await ph.evaluate(() => window.__cls.fx)));

  // 5) SAFETY: a hostile /cls/manual/hue 9.9 is clamped server-side (clamp01 -> 1 -> 360 -> 0), never bypassing the governor
  await sendOsc('/cls/manual/hue', [{ type: 'f', value: 9.9 }]);
  await sleep(500);
  const clampedHue = await ph.evaluate(() => window.__cls.manual.hue);
  check('osc_value_clamped', clampedHue >= 0 && clampedHue < 1, 'hostile hue 9.9 clamped to ' + clampedHue.toFixed(1));

  // 6) /cls/blackout -> phone goes dark (lights only)
  await sendOsc('/cls/blackout', []);
  await ph.waitForFunction(() => window.__cls.status === 'blackout', { timeout: 4000 }).catch(() => {});
  check('osc_blackout', (await ph.evaluate(() => window.__cls.status)) === 'blackout', 'phone status=' + (await ph.evaluate(() => window.__cls.status)));

  try { bridge.kill(); } catch (e) {}
  try { udp.close(); } catch (e) {}
  await b.close();
  if (fails.length) { console.error('VJ BRIDGE E2E FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('VJ BRIDGE E2E PASS: real OSC UDP -> bridge -> API -> phone (preset / manual hue / palette / fx / blackout); hostile value clamped by the server.');
}
main().catch((e) => { console.error(e); process.exit(1); });
