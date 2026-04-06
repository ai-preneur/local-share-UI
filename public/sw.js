// sw.js — Local Share Service Worker
// Caches the app shell so the page loads instantly and is installable.
// NOTE: actual file transfers still require a live server connection.

const CACHE = 'localshare-v2';  // bumped: CSS/JS now external files
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/favicon.svg',
  '/favicon-96.png',
  '/favicon-180.png',
  '/manifest.json',
  // Google Fonts removed — app now uses system fonts
];

// Install: pre-cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      // Use individual adds so a single CDN failure doesn't break install
      Promise.allSettled(SHELL.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

// Activate: remove old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API/uploads, cache-first for shell assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/uploads/')) return;
  if (url.pathname.startsWith('/upload') || url.pathname.startsWith('/api')) return;

  // NETWORK-FIRST for HTML navigations:
  // Always fetch fresh HTML so the server can inject a new CSP nonce.
  // Cache the result so offline users get the last-seen version.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
          return resp;
        })
        .catch(() =>
          caches.match(e.request).then(cached =>
            cached || new Response('Offline — please check your connection.', { status: 503 })
          )
        )
    );
    return;
  }

  // CACHE-FIRST for static assets (CSS, JS, images):
  // Serve instantly from cache; update cache on miss.
  // Guard: only cache non-HTML responses to avoid accidentally storing
  // a dynamic HTML page in the static asset cache.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const ct = resp.headers.get('content-type') || '';
          if (!ct.includes('text/html')) {          // never cache HTML as a static asset
            const clone = resp.clone();
            caches.open(CACHE).then(cache => cache.put(e.request, clone));
          }
        }
        return resp;
      }).catch(() => new Response('', { status: 503 }));
    })
  );
});
