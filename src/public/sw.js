// HCI Service Worker — Progressive Web App
const CACHE = 'hci-v3.6.0';

const PRE_CACHE = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png'
];

// Install — pre-cache shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRE_CACHE).catch(() => {}))
  );
  self.skipWaiting();
});

// Activate — purge old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first for API, cache first for static
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip cross-origin requests (fonts, CDNs, external images)
  if (url.origin !== self.location.origin) return;

  // API calls — network only, no cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // Static assets — cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      });
      return cached || fetchPromise;
    }).catch(() => {
      // Network failed and not in cache — return cached or offline
      return cached || new Response('Offline', { status: 503 });
    })
  );
});
