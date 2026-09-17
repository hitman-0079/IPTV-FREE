const CACHE_NAME = 'streamflix-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  'https://cdn.plyr.io/3.7.8/plyr.css',
  'https://cdn.jsdelivr.net/npm/hls.js@latest',
  'https://cdn.plyr.io/3.7.8/plyr.polyfilled.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Only cache static web app files, do not cache video stream chunks
  if (e.request.url.includes('.m3u') || e.request.url.includes('.ts') || e.request.url.includes('.m3u8')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
