// Crowd Light Show — VJ Bridge.
//
// Runs on the VJ's OWN laptop (NOT on the show server). It listens for OSC over UDP from professional
// VJ software (Resolume, TouchOSC, Bitfocus Companion, Chataigne, QLC+ …) and forwards each mapped
// message OUTBOUND over HTTPS to the show's existing, safety-gated External Control API. Nothing inbound
// is opened on the show host; the only socket bound here is the laptop's own local UDP port. Every
// command is re-validated and re-governed server-side (<=3 flashes/s, no saturated red, room-scoped by
// the console token), so even hostile OSC cannot make the crowd unsafe.
//
// Usage (console room — drive a /studio room):
//   node bridge.mjs --api https://lightshow.flyreelstudio.eu --token "$CLS_CONSOLE_TOKEN" --osc-port 9000
// Usage (main show — operator):
//   node bridge.mjs --api https://lightshow.flyreelstudio.eu --operator-pass "$OP_PASS" --osc-port 9000
//
// See README.md for the OSC address map and how to wire Resolume / Companion / TouchOSC.

import dgram from 'node:dgram';
import { decode } from './osc.mjs';

// ---- arg parsing ----
const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def; }
function flag(name) { return argv.indexOf('--' + name) >= 0; }

const API = (arg('api', 'http://localhost:3080') || '').replace(/\/$/, '');
const TOKEN = arg('token', process.env.CLS_CONSOLE_TOKEN || '');
const OP_PASS = arg('operator-pass', process.env.OPERATOR_PASS || '');
const OSC_PORT = Number(arg('osc-port', '9000'));
const OSC_HOST = arg('osc-host', '127.0.0.1');
const RATE_HZ = Number(arg('rate', '20'));
const VERBOSE = flag('verbose');

const redact = (s) => (s ? s.slice(0, 4) + '…(' + s.length + ')' : '(none)');
const MODE = TOKEN ? 'console' : (OP_PASS ? 'operator' : null);
if (!MODE) { console.error('VJ Bridge: provide either --token <consoleToken> (console room) or --operator-pass <pass> (main show).'); process.exit(2); }

let opToken = null; // for operator mode (obtained via /api/login)
const base = MODE === 'console' ? '/api/console' : '/api/operator';

async function login() {
  if (MODE !== 'operator') return;
  const r = await fetch(API + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: OP_PASS }) });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('operator login failed');
  opToken = j.token;
}
function authToken() { return MODE === 'console' ? TOKEN : opToken; }

// ---- HTTP forward with a tiny retry ----
async function post(path, body) {
  const url = API + base + path;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + authToken(), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (r.status === 401 && MODE === 'operator') { await login(); continue; } // token expired -> re-login once
      if (VERBOSE) console.log('->', base + path, JSON.stringify(body || {}), r.status);
      return r.ok;
    } catch (e) { if (attempt === 1) { console.error('forward error', e.message); return false; } }
  }
  return false;
}

// ---- manual coalescer: a VJ sweeps a fader fast; collapse to <=RATE_HZ, last-value-wins per field ----
let pendingManual = null, manualTimer = null;
function sendManual(patch) {
  pendingManual = Object.assign(pendingManual || {}, patch);
  if (manualTimer) return;
  manualTimer = setTimeout(() => { const p = pendingManual; pendingManual = null; manualTimer = null; post('/manual', p); }, Math.max(20, Math.round(1000 / RATE_HZ)));
}

// edge-trigger for button-like OSC (a held fader at 1.0 should fire FX once, not every packet)
const edge = {};
function rising(key, v) { const was = !!edge[key]; const now = v >= 0.5; edge[key] = now; return now && !was; }

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (a, d) => (a && a.length ? Number(a[0]) : (d == null ? 0 : d));
function parseHexList(s) {
  const out = []; String(s || '').split(/[\s,]+/).forEach((t) => { t = t.replace('#', '').trim(); if (/^[0-9a-fA-F]{3}$/.test(t)) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2]; if (/^[0-9a-fA-F]{6}$/.test(t) && out.length < 8) out.push([parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)]); });
  return out;
}

// ---- the /cls/* OSC address map -> External Control API ----
function handle(address, args) {
  switch (address) {
    // continuous manual values (faders 0..1). Any move auto-enables the manual layer.
    case '/cls/manual/hue': return sendManual({ on: true, hue: clamp01(num(args)) * 360 });
    case '/cls/manual/sat': return sendManual({ on: true, sat: clamp01(num(args)) });
    case '/cls/manual/bri': return sendManual({ on: true, bri: clamp01(num(args)) });
    case '/cls/manual/flash': return sendManual({ on: true, flash: clamp01(num(args)) });
    case '/cls/manual/on': return post('/manual', { on: num(args) >= 0.5 });
    case '/cls/manual/mode': return post('/manual', { mode: String(args[0] || 'intervene') });
    // palette: a string of hex colours, or off
    case '/cls/palette': return post('/palette', { on: true, colors: parseHexList(args[0]) });
    case '/cls/palette/off': return post('/palette', { on: false, colors: [] });
    // discrete show commands
    case '/cls/preset': return post('/preset', { type: String(args[0] || '') });
    case '/cls/torch': return post('/preset', { channel: 'torch', type: String(args[0] || '') });
    case '/cls/fx': { // fire on a string name, or on a button's rising edge (so a held fader fires once)
      const fired = (typeof args[0] === 'string') || (args.length ? rising('fx', num(args)) : true);
      return fired ? post('/fx', { name: (typeof args[0] === 'string' ? args[0] : 'salute') }) : null;
    }
    case '/cls/blackout': return (!args.length || num(args) >= 0.5) ? post('/blackout', {}) : null;
    case '/cls/stop': return post('/stop', {});
    case '/cls/go': return post('/go', {});
    case '/cls/pause': return post('/pause', {});
    case '/cls/resume': return post('/resume', {});
    case '/cls/seek': return post('/seek', { offsetMs: num(args) });
    case '/cls/mute': return post('/mute-all', { muted: num(args) >= 0.5 });
    case '/cls/marquee': return post('/marquee', { text: String(args[0] || '') });
    default: if (VERBOSE) console.log('unmapped OSC', address, args); return null;
  }
}

// ---- boot ----
const sock = dgram.createSocket('udp4');
sock.on('message', (msg) => { try { const { address, args } = decode(msg); handle(address, args); } catch (e) { if (VERBOSE) console.error('OSC decode error', e.message); } });
sock.on('error', (e) => { console.error('UDP error', e.message); });
sock.on('listening', () => {
  const a = sock.address();
  console.log(`VJ Bridge listening for OSC on ${a.address}:${a.port}  ->  ${API}${base}  [mode=${MODE}, token=${redact(authToken())}]`);
  if (process.send) process.send('listening'); // for in-process test harnesses
});

(async () => { try { await login(); } catch (e) { console.error(e.message); process.exit(1); } sock.bind(OSC_PORT, OSC_HOST); })();
