// Keeps the app itself on the phone, so it opens with no signal. Data is never cached here:
// it lives in IndexedDB (js/store.js), and every call to the server goes straight out.
const VERSION = 'et-20261027174437';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/store.js', 'js/calc.js', 'js/writes.js',
  'fonts/DMMono-Regular.ttf', 'fonts/DMMono-Medium.ttf',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // 'reload' skips the browser's HTTP cache, where GitHub Pages lets a file sit for 10 minutes:
  // a copy from there could be older than the rest and leave the app half updated.
  event.waitUntil(caches.open(VERSION)
    .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The app's own files: network first so an update shows on the next open, cache when offline.
// 'no-cache' asks the server every time (a short "not modified" when nothing changed), so the
// phone never runs one file from this version with another from the last.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('index.html'))),
  );
});
