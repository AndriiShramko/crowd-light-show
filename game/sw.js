// Cat Conga Phase A — Service Worker: cache-first для мира и app shell.
// Миры версионируются именем файла (immutable) — кеш не протухает.
const CACHE = 'catconga-a-v2';
const SHELL = ['./', './index.html', './main.js',
  './vendor/three.module.min.js', './vendor/three.core.min.js', './vendor/spark.module.min.js',
  './vendor/three-addons/postprocessing/Pass.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Range-запросы не кешируем (206) — отдаём сети.
  if (req.headers.has('range')) return;

  const isWorld = url.pathname.includes('/static/worlds/');
  const isVendor = url.pathname.includes('/vendor/');

  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (isWorld || isVendor) {
      // Тяжёлое и версионированное: cache-first (повторный вход не тянет канал).
      const cached = await c.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }
    // HTML/скрипты: network-first (обновления доезжают), кеш = офлайн-fallback.
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      const cached = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (cached) return cached;
      if (req.mode === 'navigate') { const home = await c.match('./index.html'); if (home) return home; }
      throw err;
    }
  })());
});
