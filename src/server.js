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
import { db, getOrCreateDefaultShow, listTracks, uploadsUsage, now } from './db.js';
import { issueToken, verifyToken } from './auth.js';
import { analyze } from './audio.js';
import { compileFromEnvelope } from './compiler.js';
import { hub, serverClock } from './show.js';

const ALLOWED_AUDIO = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.aac', '.flac']);
const MAGIC = [
  { ext: '.mp3', test: (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { ext: '.wav', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' },
  { ext: '.ogg', test: (b) => b.toString('ascii', 0, 4) === 'OggS' },
  { ext: '.flac', test: (b) => b.toString('ascii', 0, 4) === 'fLaC' },
  { ext: '.m4a', test: (b) => b.toString('ascii', 4, 8) === 'ftyp' },
];

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

function joinUrl(show) {
  const base = config.publicBaseUrl || '';
  return `${base}/join?s=${show.join_code}`;
}

// ---------- public pages ----------
app.get('/', (req, reply) => reply.type('text/html').send(fs.readFileSync(path.join(config.publicDir, 'index.html'))));
app.get('/join', (req, reply) => reply.type('text/html').send(fs.readFileSync(path.join(config.publicDir, 'audience.html'))));
app.get('/about', (req, reply) => reply.type('text/html').send(fs.readFileSync(path.join(config.publicDir, 'about.html'))));
app.get('/healthz', () => ({ ok: true, freeDiskBytes: freeDiskBytes(), audience: hub.audience.size, status: hub.state.status }));
app.get('/api/public/show', () => { const s = getOrCreateDefaultShow(); return { code: s.join_code, status: hub.state.status }; });

// ---------- operator console (HTTP Basic gate -> serves console + token) ----------
app.get('/operator', (req, reply) => {
  const s = bearer(req);
  if (!s || s.role !== 'operator') {
    return reply.code(401).header('WWW-Authenticate', 'Basic realm="Crowd Light Show operator"').type('text/html')
      .send('<h1>401</h1><p>Operator console — authentication required.</p>');
  }
  const token = issueToken('operator');
  let html = fs.readFileSync(path.join(config.publicDir, 'operator.html'), 'utf8');
  html = html.replace('@@OPTOKEN@@', token);
  return reply.type('text/html').send(html);
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
  const ext = path.extname(mp.filename || '').toLowerCase();
  if (!ALLOWED_AUDIO.has(ext)) return reply.code(415).send({ error: 'unsupported type' });
  const buf = await mp.toBuffer();
  if (mp.file.truncated) return reply.code(413).send({ error: 'file too large' });
  const head = buf.subarray(0, 16);
  const magic = MAGIC.find((m) => m.ext === ext);
  if (magic && !magic.test(head)) return reply.code(415).send({ error: 'content does not match extension' });

  const id = crypto.randomBytes(6).toString('hex');
  const filePath = path.join(config.dataDir, 'uploads', `${id}${ext}`);
  fs.writeFileSync(filePath, buf);

  const info = db.prepare(`INSERT INTO track (show_id, title, source_type, file_path, bytes, position, analysis_status, created_at)
    VALUES (?, ?, 'upload', ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM track WHERE show_id=?), 'pending', ?)`)
    .run(show.id, (mp.filename || 'track').replace(/\.[^.]+$/, ''), filePath, buf.length, show.id, now());
  const trackId = info.lastInsertRowid;

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
  }
  return { ok: true };
});

app.post('/api/operator/track/:id/attest', (req, reply) => {
  if (!requireOperator(req, reply)) return;
  db.prepare('UPDATE track SET license_attested=1 WHERE id=?').run(Number(req.params.id));
  return { ok: true };
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
app.post('/api/operator/arm', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.arm(Number(req.body.trackId)); });
app.post('/api/operator/go', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.go(serverClock() + config.startLeadMs); });
app.post('/api/operator/pause', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.pause(); });
app.post('/api/operator/stop', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.stop(); });
app.post('/api/operator/blackout', (req, reply) => { if (!requireOperator(req, reply)) return; return hub.blackout(); });

await app.ready();

// ---------- WebSocket hub ----------
const wss = new WebSocketServer({ noServer: true });
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
        hub.addAudience(ws);
      }
      return;
    }
    if (!ws.role) return;
    if (m.t === 'sync') { hub.send(ws, { t: 'sync', c0: m.c0, s1: serverClock() }); return; }
    if (ws.role === 'operator' && m.t === 'op') {
      const c = m.cmd;
      if (c === 'arm') hub.arm(Number(m.trackId));
      else if (c === 'go') hub.go(Number(m.T0));
      else if (c === 'pause') hub.pause();
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

getOrCreateDefaultShow();
app.listen({ port: config.port, host: config.host }).then(() => {
  app.log.info(`crowd-light-show on ${config.host}:${config.port}`);
  if (config.operatorPassIsDev) app.log.warn('OPERATOR PASSWORD IS THE DEV DEFAULT — set OPERATOR_PASS_HASH in production');
});
