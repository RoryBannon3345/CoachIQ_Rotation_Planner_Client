// `__APP_HTML__` is substituted with the emitted page's filename by scripts/build.mjs
// (APP_HTML). This file is never served from src/ -- only the built copy runs.
const CACHE = 'ciq-stats-v11';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./__APP_HTML__']))); });
// Old caches are deleted on activate, and the offline match below is scoped to CACHE: an unscoped
// caches.match searches every cache in creation order and could serve the OLDEST build offline, one
// that cannot read a newer save and would overwrite it on the next tap.
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true, cacheName: CACHE }).then((m) => m || caches.match('./__APP_HTML__', { cacheName: CACHE }))));
});
