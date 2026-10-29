/* Climb service worker. Same split Bloom and Peak settled on:
   - Navigations are NETWORK-FIRST, so index.html (which carries the ?v=N references) is never stale.
   - Versioned assets are CACHE-FIRST, matched exactly including the query (never ignoreSearch).
   - deadlock-api.com and helper (127.0.0.1) requests are not touched. Freshness lives in the app's own localStorage cache. */
const CACHE = 'climb-v25';
const SHELL = [
  './', 'index.html', 'style.css?v=25',
  'js/changelog.js?v=25', 'js/engine.js?v=25', 'js/store.js?v=25', 'js/api.js?v=25', 'js/play.js?v=25', 'js/charts.js?v=25', 'js/wpmodel.js?v=25', 'js/coach.js?v=25', 'js/views.js?v=25', 'js/app.js?v=25',
  'ingest.html', 'js/guide.js?v=25', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png',
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
    // Only the app itself is saved as the offline index.html; other pages (ingest.html) are
    // cached under their own path, or opening the guide would replace the offline app with it.
    const isApp = /\/(index\.html)?$/.test(url.pathname);
    const key = isApp ? 'index.html' : e.request;
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  })));
});
