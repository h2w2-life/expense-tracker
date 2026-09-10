// Network-first service worker for the static app shell. Always tries the
// network first so a normal reload picks up the latest deployed files —
// falls back to the cached copy only when the network request fails (i.e.
// actually offline), which is what makes the installed PWA still usable
// with no server running.

const CACHE_NAME = 'expense-tracker-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/dom.js',
  './js/money.js',
  './js/calc.js',
  './js/db.js',
  './js/tags.js',
  './js/entry.js',
  './js/list.js',
  './js/analysis.js',
  './js/filters.js',
  './js/recurring.js',
  './js/backup.js',
  './js/settings.js',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    // `cache: 'no-store'` bypasses the browser's own HTTP cache, not just
    // this service worker's cache — without it, `fetch()` here can still
    // hand back a stale response for a dev server that sends no
    // Cache-Control header, defeating the whole point of "network-first."
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
