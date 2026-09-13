// `__APP_HTML__` is substituted with the emitted page's filename by scripts/build.mjs
// (APP_HTML). This file is never served from src/ -- only the built copy runs.
const CACHE = 'ciq-stats-v2';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./__APP_HTML__']))); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('./__APP_HTML__'))));
});
