/*
 * Service worker of Eddie D-Lab: the app opens without a network after the first visit (design §6).
 * Same-origin GETs come from the cache at once and are refreshed from the network in the background
 * (stale-while-revalidate), so a new version shows on the next start. Bump VERSION to drop old caches.
 */
const VERSION = 'eddie-remote-v1';
const SHELL = ['./', './index.html', './ble-app.js', './epd-core.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];

self.addEventListener('install', event => {
  // epd-core.js sits next to the page only in the packed build (dist/pwa); in the source tree it is
  // ../epd-image/epd-core.js and gets cached on first use instead. A missing file must not stop the install.
  event.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !fonts) return;
  event.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: url.origin === location.origin });
    const fresh = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
