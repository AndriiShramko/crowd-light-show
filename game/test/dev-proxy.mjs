// dev-прокси: статика game/ + /api/join,/ws,/metrics,/debug → игровой сервер :8081. Только для локального теста.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const UP = 'localhost:8081';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.sog': 'application/octet-stream', '.bin': 'application/octet-stream', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/') || u.pathname === '/metrics' || u.pathname.startsWith('/debug')) {
    const p = http.request({ host: 'localhost', port: 8081, path: req.url, method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    req.pipe(p); p.on('error', () => { res.writeHead(502); res.end('upstream'); }); return;
  }
  let fp = path.join(ROOT, u.pathname === '/' ? '/play.html' : u.pathname);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, data) => { if (e) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(data); });
});
// WS-прокси /ws → :8081
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, (client) => {
    const up = new WebSocket('ws://' + UP + req.url, { perMessageDeflate: false });
    up.binaryType = 'arraybuffer';
    up.on('open', () => {
      client.on('message', (d, bin) => up.readyState === 1 && up.send(d, { binary: bin }));
      up.on('message', (d, bin) => client.readyState === 1 && client.send(d, { binary: bin }));
    });
    const close = () => { try { client.close(); } catch {} try { up.close(); } catch {} };
    client.on('close', close); up.on('close', close); up.on('error', close); client.on('error', close);
  });
});
server.listen(8124, () => console.log('dev-proxy on :8124 → game :8081'));
