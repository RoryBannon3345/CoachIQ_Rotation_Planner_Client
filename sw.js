// Replaces the old CoachIQ Stats service worker and stays installed, so an old home-screen icon
// keeps opening (online or offline). It deletes the old app's caches (ciq-*, which may hold a
// cached 404 of this address), takes over open pages and reloads them, and answers every page
// load with a redirect to SixUpIQ Stats. The redirect needs no network, so offline it lands on the
// new address, where the new app's own service worker serves it. It keeps no cache of its own: the
// new app deletes every cache that is not its own.
var NEW = 'https://rorybannon3345.github.io/SixUpIQ_Stats/SixUpIQ_Stats.html';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k.indexOf('ciq-') === 0; }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
    var list = await self.clients.matchAll({ type: 'window' });
    list.forEach(function (client) { client.navigate(client.url); });
  })());
});

// The query string is passed on. The #hash is not in request.url; the browser carries it over a
// redirect whose Location has none.
self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(Response.redirect(NEW + new URL(event.request.url).search, 302));
});
