/* Climb service worker. Same split Bloom and Peak settled on:
   - Navigations are NETWORK-FIRST, so index.html (which carries the ?v=N references) is never stale.
   - Versioned assets are CACHE-FIRST, matched exactly including the query (never ignoreSearch).
   - deadlock-api.com requests are not touched. Freshness lives in the app's own localStorage cache. */
const CACHE = 'climb-v1';
const SHELL = [
  './', 'index.html', 'style.css?v=1',
  'js/engine.js?v=1', 'js/store.js?v=1', 'js/api.js?v=1', 'js/charts.js?v=1', 'js/app.js?v=1',
  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => { if (r.ok) return c.put(u, r); }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return r;
    }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  })));
});
