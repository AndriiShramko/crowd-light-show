import Fastify from 'fastify';
import fstatic from '@fastify/static';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { config, scryptVerify } from './config.js';
import { db, getOrCreateDefaultShow, listTracks, uploadsUsage, now, getPublicConfig, listPublicTracks } from './db.js';
import { issueToken, verifyToken } from './auth.js';
import { analyze } from './audio.js';
import { compileFromEnvelope } from './compiler.js';
import { hub, serverClock } from './show.js';
import { notifyTelegram } from './notify.js';
import { validatePreset, validateParam, PARAM_SCHEMA, PRESET_TYPES, DEFAULT_PRESET } from './presets.js';
import { validateTorchPreset, validateTorchParam, TORCH_SCHEMA, TORCH_TYPES, DEFAULT_TORCH } from './presets.js';

// A built-in, always-looping demo light show so anyone can try it with zero setup
// (the "Try it" QR / /join?demo=1). Synthetic, safety-clamped, ~24s loop.
function buildDemoTimeline() {
  const durationMs = 24000;
  const env = [];
  for (let t = 0; t < durationMs; t += 40) {
    const swell = 0.45 + 0.35 * Math.sin((2 * Math.PI * t) / 12000);
    const beat = Math.pow(Math.max(0, Math.sin((2 * Math.PI * t) / 1000)), 8);
    const build = t > 17000 ? 1.0 : 0.72;
    env.push({ t, rms: Math.min(1, (swell * 0.55 + beat * 0.75) * build) });
  }
  const beats = [];
  for (let t = 0; t < durationMs; t += 1000) beats.push(t);
  return { version: 1, fps: 25, durationMs, cues: compileFromEnvelope(env, { durationMs, beats }), beats };
}
const DEMO = buildDemoTimeline();
const DEMO_T0 = serverClock();

// Detect the actual audio format from magic bytes. The filename/extension is
// intentionally ignored — users routinely have misnamed files (e.g. an MP4/AAC
// file named .mp3), and ffmpeg decodes by content anyway. We only need to confirm
// it is a supported audio container (security), then let ffmpeg do the rest.
function sniffAudio(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';            // ID3v2-tagged MP3
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';                    // raw MPEG frame sync
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'm4a';                       // ISO-BMFF: MP4/M4A (AAC/ALAC)
  return null;
}
const EXT_FOR = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', flac: '.flac', m4a: '.m4a' };

function freeDiskBytes() {
  try { const s = fs.statfsSync(config.dataDir); return s.bsize * s.bavail; }
  catch { return Number.MAX_SAFE_INTEGER; }
}

const app = Fastify({ bodyLimit: 1024 * 1024, trustProxy: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
await app.register(fstatic, { root: config.publicDir, prefix: '/static/' });

function bearer(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return verifyToken(h.slice(7));
  if (h.startsWith('Basic ')) {
    try {
      const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      if (pass && scryptVerify(pass, config.operatorPassHash)) return { role: 'operator' };
    } catch { /* ignore */ }
  }
  return null;
}

function requireOperator(req, reply) {
  const s = bearer(req);
  if (!s || s.role !== 'operator') { reply.code(401).send({ error: 'unauthorized' }); return null; }
  return s;
}

// ---------- ROUND 9: public operator console (/studio) ----------
const ROOM_RE = /^[a-z0-9]{6,24}$/;
// Public console auth: a signed CONSOLE token whose `room` claim is read here, on the
// server, from the verified token — NEVER from the request body. A public console can
// therefore only ever drive its own ephemeral room.
function consoleRoom(req, reply) {
  if (!config.studioEnabled) { reply.code(503).send({ error: 'studio disabled' }); return null; }
  const s = bearer(req);
  if (!s || s.role !== 'console' || !s.room || !ROOM_RE.test(s.room)) { reply.code(401).send({ error: 'unauthorized' }); return null; }
  return s.room;
}
// Per-IP cap on how many public sessions one client may mint per minute (anti-flood;
// the hard room ceiling is enforced separately in hub.getRoom).
const _mintLog = new Map(); // ip -> [timestamps]
function mintGuard(ip) {
  const t = Date.now(), win = 60000;
  const arr = (_mintLog.get(ip) || []).filter((x) => t - x < win);
  if (arr.length >= config.publicMintPerIpPerMin) { _mintLog.set(ip, arr); return false; }
  arr.push(t); _mintLog.set(ip, arr);
  if (_mintLog.size > 5000) { for (const [k, v] of _mintLog) if (!v.some((x) => t - x < win)) _mintLog.delete(k); }
  return true;
}
// Read public_config and RE-VALIDATE everything (defense in depth — never trust the stored
// snapshot; a preset could have been poisoned, a track could have gone private). Returns a
// safe subset the public session/console may use.
function readValidatedDefaults() {
  const pc = getPublicConfig() || {};
  const out = {
    brand_name: pc.brand_name || 'Crowd Light Show',
    welcome_text: pc.welcome_text || '',
    allow_torch: pc.allow_torch !== 0,
    allow_upload: !!pc.allow_upload && config.publicUploadEnabled,
  };
  if (pc.default_screen_preset) {
    let params = {}; try { params = pc.default_screen_params ? JSON.parse(pc.default_screen_params) : {}; } catch { /* bad json */ }
    const v = validatePreset(pc.default_screen_preset, params); if (v.ok) out.screen = { type: v.type, params: v.params };
  }
  if (pc.default_torch_preset) {
    let params = {}; try { params = pc.default_torch_params ? JSON.parse(pc.default_torch_params) : {}; } catch { /* bad json */ }
    const v = validateTorchPreset(pc.default_torch_preset, params); if (v.ok) out.torch = { type: v.type, params: v.params };
  }
  if (pc.default_track_id) {
    const t = db.prepare("SELECT id FROM track WHERE id=? AND is_public=1 AND analysis_status='done' AND timeline_path IS NOT NULL").get(pc.default_track_id);
    if (t) out.default_track_id = t.id;
  }
  return out;
}
function personalSession(token) {
  return {
    mode: 'personal', token, room: null, apiBase: '/api/operator', lead: config.startLeadMs,
    features: { applications: true, upload: true, torch: true, transport: true, publicConfig: true, playlist: false, defaultMusic: false },
    brand: 'Crowd Light Show',
  };
}
function publicSession(room, token) {
  const d = readValidatedDefaults();
  return {
    mode: 'public', token, room, apiBase: '/api/console', lead: config.startLeadMs,
    features: { applications: false, upload: d.allow_upload, torch: d.allow_torch, transport: true, publicConfig: false, playlist: true, defaultMusic: true },
    brand: d.brand_name, welcome: d.welcome_text,
    defaults: { screen: d.screen || null, torch: d.torch || null, default_track_id: d.default_track_id || null },
    playlist: listPublicTracks(),
  };
}
// ONE renderer for BOTH consoles: the same operator.html, parameterized by the session
// JSON. /operator => personal (auth); /studio => public (no auth, room-bound token).
function renderConsole(session) {
  let html = fs.readFileSync(path.join(config.publicDir, 'operator.html'), 'utf8');
  html = html.replace('@@SESSION@@', JSON.stringify(session));
  html = html.replaceAll('@@LEAD@@', String(config.startLeadMs));
  html = html.replaceAll('@@SHARE@@', SHARE_PARTIAL);
  return html;
}

function joinUrl(show) {
  const base = config.publicBaseUrl || '';
  return `${base}/join?s=${show.join_code}`;
}

// ---------- public pages ----------
// One renderer for EVERY public page (round 8C) so the shared lead/contact block
// (@@CONTACT@@) and the studio flag (@@STUDIO@@) are injected consistently. Before 8C only
// "/" did token replacement; /try /join /about /studio were served raw, so a @@CONTACT@@
// there would have rendered as literal text. The contact partial is read once at boot.
const CONTACT_PARTIAL = fs.readFileSync(path.join(config.publicDir, 'partials', 'contact.html'), 'utf8');
// Share block (round 9) — injected into the consoles + /join via @@SHARE@@. Defensive read
// so the server still boots before the partial is added.
const SHARE_PARTIAL = (() => { try { return fs.readFileSync(path.join(config.publicDir, 'partials', 'share.html'), 'utf8'); } catch { return ''; } })();
function renderPage(file, extra) {
  let html = fs.readFileSync(path.join(config.publicDir, file), 'utf8');
  const tokens = Object.assign({
    '@@STUDIO@@': config.studioEnabled ? 'true' : 'false',
    '@@CONTACT@@': CONTACT_PARTIAL,
    '@@SHARE@@': SHARE_PARTIAL,
  }, extra || {});
  for (const [k, v] of Object.entries(tokens)) html = html.replaceAll(k, String(v));
  return html;
}
app.get('/', (req, reply) => reply.type('text/html').send(renderPage('index.html')));
app.get('/join', (req, reply) => reply.type('text/html').send(renderPage('audience.html')));
app.get('/about', (req, reply) => reply.type('text/html').send(renderPage('about.html')));
app.get('/try', (req, reply) => reply.type('text/html').send(renderPage('try.html')));
app.get('/privacy', (req, reply) => reply.type('text/html').send(renderPage('privacy.html')));

// SEO / answer-engine files MUST be reachable at the ROOT (crawlers fetch /robots.txt and
// /sitemap.xml; the OG image must resolve). They live in public/ — round 9 fixes them being
// reachable only under /static/ (they 404'd at the root, so robots.txt was never effective).
const ROOT_FILES = {
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
  '/sitemap.xml': ['sitemap.xml', 'application/xml; charset=utf-8'],
  '/llms.txt': ['llms.txt', 'text/plain; charset=utf-8'],
  '/og-cover.png': ['og-cover.png', 'image/png'],
};
for (const [route, [file, mime]] of Object.entries(ROOT_FILES)) {
  app.get(route, (req, reply) => {
    const fp = path.join(config.publicDir, file);
    if (!fs.existsSync(fp)) return reply.code(404).send({ error: 'not found' });
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.type(mime).send(fs.createReadStream(fp));
  });
}
// Studio = the PUBLIC operator console (round 9). One CTA on the landing opens this: the
// SAME console as /operator MINUS the leads, on its own ephemeral room, no auth. The room
// is bound into a signed console token (read server-side, never from the body).
app.get('/studio', (req, reply) => {
  if (!config.studioEnabled) return reply.code(503).type('text/html').send('<h1>Studio is currently disabled.</h1>');
  const ip = String(req.headers['x-real-ip'] || req.ip || '');
  if (!mintGuard(ip)) return reply.code(429).type('text/html').send('<h1>Too many sessions from your network — please try again in a minute.</h1>');
  const room = crypto.randomBytes(8).toString('hex');
  const token = issueToken('console', 12 * 3600 * 1000, { room });
  return reply.type('text/html').send(renderConsole(publicSession(room, token)));
});
app.get('/healthz', () => ({ ok: true, freeDiskBytes: freeDiskBytes(), audience: hub.audience.size, status: hub.state.status }));
app.get('/api/public/show', () => { const s = getOrCreateDefaultShow(); return { code: s.join_code, status: hub.state.status }; });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- demo: a zero-setup, always-looping show anyone can join (the "Try it" QR) ----
// Prefer a REAL admin-uploaded track (its lights match its music); the demo then plays
// that track's audio too, looped + synced. Falls back to the synthetic light loop if the
// playlist is empty or crowd audio is disabled.
function demoTrack() {
  if (!config.crowdAudioEnabled) return null;
  try { return db.prepare("SELECT * FROM track WHERE analysis_status='done' AND timeline_path IS NOT NULL ORDER BY position ASC, id ASC LIMIT 1").get(); } catch { return null; }
}
app.get('/api/demo', () => {
  const t = demoTrack();
  if (t) {
    const tl = hub.loadTimeline(t.id);
    if (tl) return { timeline: tl, T0: DEMO_T0, duration: tl.durationMs, loop: true, hasAudio: !!(t.file_path && fs.existsSync(t.file_path)), serverTime: serverClock() };
  }
  return { timeline: DEMO, T0: DEMO_T0, duration: DEMO.durationMs, loop: true, hasAudio: false, serverTime: serverClock() };
});
// Public, rate-limited demo audio = the demo track's file (the operator's deliberate
// showcase choice; landing carries the disclaimers). Decoded + looped on the phone.
app.get('/api/demo/audio', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, (req, reply) => {
  if (!config.crowdAudioEnabled) return reply.code(503).send({ error: 'crowd audio disabled' });
  const t = demoTrack();
  if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: 'no demo audio' });
  reply.header('Accept-Ranges', 'bytes').header('Cache-Control', 'public, max-age=3600');
  return reply.type('application/octet-stream').send(fs.createReadStream(t.file_path));
});
app.get('/api/demo/qr', async (req, reply) => {
  const png = await QRCode.toBuffer(`${config.publicBaseUrl || ''}/join?demo=1`, { width: 600, margin: 2 });
  return reply.type('image/png').send(png);
});

// ---- studio guest demo: ephemeral, no-auth, room-scoped live presets ----
// A guest on the landing mints a private room id, points their own phones at it via
// QR, and switches presets live. Switches reach ONLY phones that joined that room
// (server-mediated fan-out — a guest can never touch the real show or other rooms),
// and every cue still passes server-side validatePreset (safety is never bypassed).
app.get('/api/demo/room', (req, reply) => {
  if (!config.studioEnabled) return reply.code(503).send({ error: 'studio disabled' });
  const room = crypto.randomBytes(8).toString('hex');
  const url = `${config.publicBaseUrl || ''}/join?room=${room}`;
  return { room, joinUrl: url, types: PRESET_TYPES, schema: PARAM_SCHEMA, default: DEFAULT_PRESET };
});
app.get('/api/demo/room-qr', async (req, reply) => {
  const room = String(req.query.room || '');
  if (!ROOM_RE.test(room)) return reply.code(400).send({ error: 'bad room' });
  const png = await QRCode.toBuffer(`${config.publicBaseUrl || ''}/join?room=${room}`, { width: 600, margin: 2 });
  return reply.type('image/png').send(png);
});
app.post('/api/demo/preset', (req, reply) => {
  if (!config.studioEnabled) return reply.code(503).send({ error: 'studio disabled' });
  const room = String((req.body && req.body.room) || '');
  if (!ROOM_RE.test(room)) return reply.code(400).send({ error: 'bad room' });
  if (hub.rooms.size > 2000) return reply.code(429).send({ error: 'too many rooms' });
  const v = validatePreset(String((req.body && req.body.type) || ''), (req.body && req.body.params) || {});
  if (!v.ok) return reply.code(400).send({ error: v.error });
  return hub.setPreset(room, v); // -> { ok, epoch, members }
});
app.post('/api/demo/preset/param', (req, reply) => {
  if (!config.studioEnabled) return reply.code(503).send({ error: 'studio disabled' });
  const room = String((req.body && req.body.room) || '');
  if (!ROOM_RE.test(room)) return reply.code(400).send({ error: 'bad room' });
  const r = hub.rooms.get(room);
  if (!r || !r.preset) return reply.code(409).send({ error: 'no active preset' });
  const v = validateParam(r.preset.type, String((req.body && req.body.key) || ''), (req.body && req.body.value));
  if (!v.ok) return reply.code(400).send({ error: v.error });
  return hub.setParam(room, v.key, v.value);
});

// ====================== PUBLIC CONSOLE API (/studio) — round 9 ======================
// All routes: room comes from the verified console TOKEN (consoleRoom), never the body.
// Every preset/torch is RE-VALIDATED here (validatePreset/validateTorchPreset) — the safety
// governor sits BELOW the room layer and is never bypassed on the public surface.
app.get('/api/console/presets', (req, reply) => {
  const room = consoleRoom(req, reply); if (!room) return;
  const r = hub.rooms.get(room);
  return {
    types: PRESET_TYPES, schema: PARAM_SCHEMA, default: DEFAULT_PRESET, active: (r && r.preset) || null,
    torchTypes: TORCH_TYPES, torchSchema: TORCH_SCHEMA, torchDefault: DEFAULT_TORCH, torchActive: (r && r.torch) || null,
  };
});
app.get('/api/console/playlist', (req, reply) => {
  const room = consoleRoom(req, reply); if (!room) return;
  const d = readValidatedDefaults();
  return { tracks: listPublicTracks(), defaults: { default_track_id: d.default_track_id || null, screen: d.screen || null, torch: d.torch || null, allow_torch: d.allow_torch, brand_name: d.brand_name } };
});
app.post('/api/console/preset', (req, reply) => {
  const room = consoleRoom(req, reply); if (!room) return;
  const channel = (req.body && req.body.channel) === 'torch' ? 'torch' : 'screen';
  const type = String((req.body && req.body.type) || '');
  const params = (req.body && req.body.params) || {};
  const v = channel === 'torch' ? validateTorchPreset(type, params) : validatePreset(type, params);
  if (!v.ok) return reply.code(400).send({ error: v.error });
  return hub.setPreset(room, v, channel);
});
app.post('/api/console/preset/param', (req, reply) => {
  const room = consoleRoom(req, reply); if (!room) return;
  const channel = (req.body && req.body.channel) === 'torch' ? 'torch' : 'screen';
  const r = hub.rooms.get(room);
  const active = r ? (channel === 'torch' ? r.torch : r.preset) : null;
  if (!active) return reply.code(409).send({ error: 'no active preset' });
  const v = channel === 'torch'
    ? validateTorchParam(active.type, String((req.body && req.body.key) || ''), (req.body && req.body.value))
    : validateParam(active.type, String((req.body && req.body.key) || ''), (req.body && req.body.value));
  if (!v.ok) return reply.code(400).send({ error: v.error });
  return hub.setParam(room, v.key, v.value, channel);
});
// PUBLIC console may ONLY arm a curated is_public track (never a private one).
app.post('/api/console/arm', (req, reply) => {
  const room = consoleRoom(req, reply); if (!room) return;
  const trackId = Number((req.body && req.body.trackId));
  const t = db.prepare("SELECT id FROM track WHERE id=? AND is_public=1 AND analysis_status='done' AND timeline_path IS NOT NULL").get(trackId);
  if (!t) return reply.code(403).send({ error: 'not a public track' });
  return hub.arm(trackId, { keepPreset: !!(req.body && req.body.keepPreset) }, room);
});
app.post('/api/console/go', (req, reply) => { const room = consoleRoom(req, reply); if (!room) return; return hub.go(serverClock() + config.startLeadMs, room); });
app.post('/api/console/pause', (req, reply) => { const room = consoleRoom(req, reply); if (!room) return; return hub.pause(room); });
app.post('/api/console/resume', (req, reply) => { const room = consoleRoom(req, reply); if (!room) return; return hub.resume(room); });
app.post('/api/console/stop', (req, reply) => { const room = consoleRoom(req, reply); if (!room) return; return hub.stop(room); });
app.post('/api/console/blackout', (req, reply) => { const room = consoleRoom(req, reply); if (!room) return; return hub.blackout(room); });
app.get('/api/console/qr', async (req, reply) => {
  const room = consoleRoom(req, reply); if (!room) return;
  const png = await QRCode.toBuffer(`${config.publicBaseUrl || ''}/join?room=${room}`, { width: 600, margin: 2 });
  return reply.type('image/png').send(png);
});
// Console-side synced audio: serve a CURATED (is_public) track's audio only, rate-limited.
// No private track can be enumerated; not a general file host.
app.get('/api/console/audio/:id', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, (req, reply) => {
  const room = consoleRoom(req, reply); if (!room) return;
  const t = db.prepare('SELECT * FROM track WHERE id=? AND is_public=1').get(Number(req.params.id));
  if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: 'no audio' });
  reply.header('Accept-Ranges', 'bytes').header('Cache-Control', 'public, max-age=3600');
  return reply.type('application/octet-stream').send(fs.createReadStream(t.file_path));
});

// ---- per-phone synchronized audio: serve ONLY the currently-armed track, no auth,
// rate-limited, and ONLY if the operator attested the licence (crowd-wide public
// performance is a bigger footprint than one PA). No :id param => can't enumerate
// arbitrary uploads. Phones opt in client-side and schedule it off the synced clock.
app.get('/api/audience/audio', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, (req, reply) => {
  if (!config.crowdAudioEnabled) return reply.code(503).send({ error: 'crowd audio disabled' });
  const trackId = hub.state.trackId;
  if (trackId == null) return reply.code(409).send({ error: 'no armed track' });
  const t = db.prepare('SELECT * FROM track WHERE id=?').get(trackId);
  if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: 'no audio' });
  if (!t.license_attested) return reply.code(403).send({ error: 'track not licensed for crowd playback' });
  reply.header('Accept-Ranges', 'bytes').header('Cache-Control', 'public, max-age=3600');
  return reply.type('application/octet-stream').send(fs.createReadStream(t.file_path));
});

// ---- lead capture from the landing (public, rate-limited, honeypot) ----
app.post('/api/apply', async (req, reply) => {
  const b = req.body || {};
  if (b.website) return { ok: true }; // honeypot — silently drop bots
  const name = String(b.name || '').trim().slice(0, 200);
  const email = String(b.email || b.contact || '').trim().slice(0, 200);  // 'contact' kept for back-compat
  const phone = String(b.phone || '').trim().slice(0, 80);
  const company = String(b.company || '').trim().slice(0, 200);
  const eventType = String(b.eventType || '').trim().slice(0, 80);
  const tier = String(b.tier || '').trim().slice(0, 40);
  const source = String(b.source || '').trim().slice(0, 80);
  const message = String(b.message || '').trim().slice(0, 2000);
  // RODO minimization: required = name + email only (phone/company optional).
  if (!name || !email) return reply.code(400).send({ error: 'name and email are required' });
  const ip = String(req.headers['x-real-ip'] || req.ip || '').slice(0, 64);
  const info = db.prepare(`INSERT INTO application (name, contact, email, phone, company, event_type, source, tier, message, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, email, email, phone, company, eventType, source, tier, message, ip, now());
  // RODO minimization: the Telegram DM does NOT carry the lead's PII (it leaves the EU to a
  // third-party processor) — it only nudges the owner to open the authed admin panel to view it.
  notifyTelegram('🎆 <b>New Crowd Light Show lead</b> — open the operator console → Applications to view it (no personal data is sent over Telegram).')
    .then((ok) => { if (ok) db.prepare('UPDATE application SET notified=1 WHERE id=?').run(info.lastInsertRowid); });
  return { ok: true };
});

// ---------- operator console (HTTP Basic gate -> serves console + token) ----------
app.get('/operator', (req, reply) => {
  const s = bearer(req);
  if (!s || s.role !== 'operator') {
    return reply.code(401).header('WWW-Authenticate', 'Basic realm="Crowd Light Show operator"').type('text/html')
      .send('<h1>401</h1><p>Operator console — authentication required.</p>');
  }
  // Round 9: the SAME operator component, parameterized by a personal session.
  return reply.type('text/html').send(renderConsole(personalSession(issueToken('operator'))));
});

app.post('/api/login', async (req, reply) => {
  const pass = (req.body && req.body.password) || '';
  if (!scryptVerify(pass, config.operatorPassHash)) return reply.code(401).send({ error: 'bad password' });
  return { token: issueToken('operator') };
});

// ---------- operator API (all gated) ----------
app.get('/api/operator/state', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const show = getOrCreateDefaultShow();
  return { show, tracks: listTracks(show.id), state: hub.publicState(), joinUrl: joinUrl(show),
    audience: hub.audience.size, freeDiskBytes: freeDiskBytes(), uploadsUsage: uploadsUsage() };
});

app.get('/api/operator/join-url', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  return { url: joinUrl(getOrCreateDefaultShow()) };
});

app.get('/api/operator/qr', async (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const png = await QRCode.toBuffer(joinUrl(getOrCreateDefaultShow()), { width: 600, margin: 2 });
  return reply.type('image/png').send(png);
});

app.post('/api/operator/upload', async (req, reply) => {
  if (!requireOperator(req, reply)) return;
  if (freeDiskBytes() < config.diskGuardMinBytes) return reply.code(507).send({ error: 'disk guard: low space' });
  const show = getOrCreateDefaultShow();
  if (listTracks(show.id).length >= config.maxTracksPerShow) return reply.code(409).send({ error: 'track limit reached' });
  if (uploadsUsage() >= config.uploadsBudgetBytes) return reply.code(507).send({ error: 'uploads budget reached' });

  const mp = await req.file();
  if (!mp) return reply.code(400).send({ error: 'no file' });
  const buf = await mp.toBuffer();
  if (mp.file.truncated) return reply.code(413).send({ error: 'file too large (max 50 MB)' });
  const kind = sniffAudio(buf.subarray(0, 16));
  if (!kind) return reply.code(415).send({ error: 'not a supported audio file (mp3, m4a/mp4, wav, ogg, flac)' });

  const id = crypto.randomBytes(6).toString('hex');
  const filePath = path.join(config.dataDir, 'uploads', `${id}${EXT_FOR[kind]}`);
  fs.writeFileSync(filePath, buf);

  const info = db.prepare(`INSERT INTO track (show_id, title, source_type, file_path, bytes, position, analysis_status, created_at)
    VALUES (?, ?, 'upload', ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM track WHERE show_id=?), 'pending', ?)`)
    .run(show.id, (mp.filename || 'track').replace(/\.[^.]+$/, ''), filePath, buf.length, show.id, now());
  const trackId = info.lastInsertRowid;
  hub.evictTimeline(trackId);   // a reused row id must never serve a previous track's cached cues

  try {
    const { durationMs, envelope, beats } = await analyze(filePath);
    const cues = compileFromEnvelope(envelope, { durationMs, beats });
    const timeline = { version: 1, trackId, fps: config.cueFps, durationMs, cues, beats };
    const tlPath = path.join(config.dataDir, 'timelines', `${id}.json`);
    fs.writeFileSync(tlPath, JSON.stringify(timeline));
    db.prepare(`UPDATE track SET duration_ms=?, analysis_status='done', timeline_path=?, cue_count=? WHERE id=?`)
      .run(durationMs, tlPath, cues.length, trackId);
    return { ok: true, trackId, durationMs, cueCount: cues.length, beats: beats.length };
  } catch (e) {
    db.prepare(`UPDATE track SET analysis_status='failed' WHERE id=?`).run(trackId);
    req.log.error(e);
    return reply.code(500).send({ error: 'analysis failed', detail: String(e.message || e) });
  }
});

app.get('/api/operator/timeline/:id', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const t = db.prepare('SELECT * FROM track WHERE id=?').get(Number(req.params.id));
  if (!t || !t.timeline_path || !fs.existsSync(t.timeline_path)) return reply.code(404).send({ error: 'no timeline' });
  return reply.type('application/json').send(fs.readFileSync(t.timeline_path));
});

// Operator console plays the track as the master audio source (P0-1).
app.get('/api/operator/audio/:id', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const t = db.prepare('SELECT * FROM track WHERE id=?').get(Number(req.params.id));
  if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: 'no audio' });
  return reply.type('application/octet-stream').send(fs.createReadStream(t.file_path));
});

app.delete('/api/operator/track/:id', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const t = db.prepare('SELECT * FROM track WHERE id=?').get(Number(req.params.id));
  if (t) {
    for (const p of [t.file_path, t.timeline_path]) { try { if (p) fs.unlinkSync(p); } catch {} }
    db.prepare('DELETE FROM track WHERE id=?').run(t.id);
    hub.evictTimeline(t.id);                       // drop cached cues (id may be reused)
    if (hub.state.trackId === t.id) hub.stop();    // don't leave a deleted track armed
  }
  return { ok: true };
});

app.post('/api/operator/track/:id/attest', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  db.prepare('UPDATE track SET license_attested=1 WHERE id=?').run(Number(req.params.id));
  return { ok: true };
});

// Round 9 — Andrii curates a track into the PUBLIC playlist. Flipping is_public=1 requires
// the track to be analyzed AND licence-attested (he holds the rights to play it publicly).
app.post('/api/operator/track/:id/public', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const id = Number(req.params.id);
  const on = !!(req.body && req.body.is_public);
  if (on) {
    const t = db.prepare('SELECT analysis_status, license_attested FROM track WHERE id=?').get(id);
    if (!t || t.analysis_status !== 'done' || !t.license_attested) return reply.code(409).send({ error: 'analyze + attest the licence before making a track public' });
  }
  db.prepare('UPDATE track SET is_public=? WHERE id=?').run(on ? 1 : 0, id);
  return { ok: true, is_public: on ? 1 : 0 };
});

// Round 9 — Andrii sets the PUBLIC console defaults from his OWN authed console. Read-only
// to the public side; every preset is validated on write so a bad default can't be stored.
app.get('/api/operator/public-config', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  return { config: getPublicConfig(), publicTracks: listPublicTracks(), uploadEnabled: config.publicUploadEnabled };
});
app.post('/api/operator/public-config', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const b = req.body || {};
  const set = {};
  if (b.brand_name != null) set.brand_name = String(b.brand_name).slice(0, 80) || 'Crowd Light Show';
  if (b.welcome_text != null) set.welcome_text = String(b.welcome_text).slice(0, 300);
  if (b.allow_torch != null) set.allow_torch = b.allow_torch ? 1 : 0;
  if (b.allow_upload != null) set.allow_upload = b.allow_upload ? 1 : 0;
  if (b.default_screen_preset != null) {
    const v = validatePreset(String(b.default_screen_preset), b.default_screen_params || {});
    if (!v.ok) return reply.code(400).send({ error: 'screen default: ' + v.error });
    set.default_screen_preset = v.type; set.default_screen_params = JSON.stringify(v.params);
  }
  if (b.default_torch_preset != null) {
    const v = validateTorchPreset(String(b.default_torch_preset), b.default_torch_params || {});
    if (!v.ok) return reply.code(400).send({ error: 'torch default: ' + v.error });
    set.default_torch_preset = v.type; set.default_torch_params = JSON.stringify(v.params);
  }
  if (b.default_track_id != null) {
    const id = Number(b.default_track_id);
    if (id) { const t = db.prepare("SELECT id FROM track WHERE id=? AND is_public=1 AND analysis_status='done'").get(id); if (!t) return reply.code(400).send({ error: 'default track must be a public, analyzed track' }); set.default_track_id = id; }
    else set.default_track_id = null;
  }
  set.updated_at = now();
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE public_config SET ${keys.map((k) => k + '=?').join(', ')} WHERE id = 1`).run(...keys.map((k) => set[k]));
  return { ok: true, config: getPublicConfig() };
});

app.post('/api/operator/nudge', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  const ms = Math.max(-1000, Math.min(1000, Number((req.body && req.body.ms) || 0)));
  db.prepare('UPDATE show SET nudge_ms=? WHERE id=?').run(ms, getOrCreateDefaultShow().id);
  return { ok: true, ms };
});

// HTTP control (gated). go() is server-timed here (used by the sync harness and as
// a fallback); the live operator console uses the WS go with a browser-computed,
// audio-aligned T0 (P0-1).
app.post('/api/operator/arm', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.arm(Number(req.body.trackId), { keepPreset: !!(req.body && req.body.keepPreset) }); });
app.post('/api/operator/go', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.go(serverClock() + config.startLeadMs); });
app.post('/api/operator/pause', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.pause(); });
app.post('/api/operator/resume', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.resume(); });
app.post('/api/operator/stop', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.stop(); });
app.post('/api/operator/blackout', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.blackout(); });

// ---- live parametric presets (studio channel) — operator-controlled, main room ----
// Catalog + param schema for the console/studio UI.
app.get('/api/operator/presets', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  return {
    types: PRESET_TYPES, schema: PARAM_SCHEMA, default: DEFAULT_PRESET, active: hub.preset,
    // round 8B — autonomous torch channel catalog + its active preset
    torchTypes: TORCH_TYPES, torchSchema: TORCH_SCHEMA, torchDefault: DEFAULT_TORCH, torchActive: hub.torchPreset,
  };
});
// Switch preset on a channel ('screen' default | 'torch') — epoch++ -> instant flip, all in sync.
app.post('/api/operator/preset', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  if (!config.studioEnabled) return reply.code(503).send({ error: 'studio disabled' });
  const channel = (req.body && req.body.channel) === 'torch' ? 'torch' : 'screen';
  const type = String((req.body && req.body.type) || '');
  const params = (req.body && req.body.params) || {};
  const v = channel === 'torch' ? validateTorchPreset(type, params) : validatePreset(type, params);
  if (!v.ok) return reply.code(400).send({ error: v.error });
  return hub.setPreset('main', v, channel); // -> { ok, epoch }
});
// Live param tweak on a channel — morph WITHOUT restarting the preset (epoch/phase preserved).
app.post('/api/operator/preset/param', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  if (!config.studioEnabled) return reply.code(503).send({ error: 'studio disabled' });
  const channel = (req.body && req.body.channel) === 'torch' ? 'torch' : 'screen';
  const active = channel === 'torch' ? hub.torchPreset : hub.preset;
  if (!active) return reply.code(409).send({ error: 'no active preset' });
  const key = String((req.body && req.body.key) || '');
  const v = channel === 'torch'
    ? validateTorchParam(active.type, key, (req.body && req.body.value))
    : validateParam(active.type, key, (req.body && req.body.value));
  if (!v.ok) return reply.code(400).send({ error: v.error });
  return hub.setParam('main', v.key, v.value, channel);
});

app.get('/api/operator/applications', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  return { applications: db.prepare('SELECT * FROM application ORDER BY created_at DESC LIMIT 200').all() };
});
app.delete('/api/operator/application/:id', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  db.prepare('DELETE FROM application WHERE id=?').run(Number(req.params.id));
  return { ok: true };
});

await app.ready();

// ---------- WebSocket hub ----------
// permessage-deflate (M5): the armed-timeline broadcast (a repetitive cue JSON, tens
// of KB) compresses ~10-20x. threshold skips the tiny/frequent sync & preset frames
// (compressing 30-byte frames is net-negative CPU). *NoContextTakeover is MANDATORY
// at scale — a per-socket zlib context × thousands would itself OOM the container.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: {
  threshold: 1024,
  zlibDeflateOptions: { level: 3, memLevel: 7 },
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
} });
app.server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  if (!url || !url.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') {
      if (ws.role) return;
      if (m.role === 'operator') {
        if (!verifyToken(m.token)) { hub.send(ws, { t: 'error', error: 'unauthorized' }); ws.close(); return; }
        ws.role = 'operator'; hub.addOperator(ws);
      } else {
        ws.role = 'audience'; ws.platform = String(m.platform || 'other').slice(0, 16);
        const room = (typeof m.room === 'string' && /^[a-z0-9]{6,24}$/.test(m.room)) ? m.room : 'main';
        // Capacity guard (M6): graceful "venue full" instead of OOM-killing the box.
        if (room === 'main' && hub.audience.size >= config.maxAudience) { hub.send(ws, { t: 'full' }); ws.close(); return; }
        hub.addAudience(ws, room);
      }
      return;
    }
    if (!ws.role) return;
    if (m.t === 'sync') { hub.send(ws, { t: 'sync', c0: m.c0, s1: serverClock() }); return; }
    if (ws.role === 'operator' && m.t === 'op') {
      const c = m.cmd;
      if (c === 'arm') hub.arm(Number(m.trackId), { keepPreset: !!m.keepPreset });
      else if (c === 'go') hub.go(Number(m.T0));
      else if (c === 'pause') hub.pause();
      else if (c === 'resume') hub.resume();
      else if (c === 'stop') hub.stop();
      else if (c === 'blackout') hub.blackout();
    }
  });
  ws.on('close', () => {
    if (ws.role === 'operator') hub.removeOperator(ws);
    else if (ws.role === 'audience') hub.removeAudience(ws);
  });
  ws.on('error', () => {});
});

// Heartbeat: ping every 25s (< nginx-proxy 60s idle timeout) and reap dead sockets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 25000).unref();

// Reap orphan demo rooms periodically (ephemeral guest studio rooms).
setInterval(() => hub.sweepRooms(), 60000).unref();

getOrCreateDefaultShow();
app.listen({ port: config.port, host: config.host }).then(() => {
  app.log.info(`crowd-light-show on ${config.host}:${config.port}`);
  if (config.operatorPassIsDev) app.log.warn('OPERATOR PASSWORD IS THE DEV DEFAULT — set OPERATOR_PASS_HASH in production');
});
