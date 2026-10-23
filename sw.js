// Trackly service worker
//  - app files: stale-while-revalidate (open instantly from the saved copy, quietly fetch the new one for next time)
//  - libraries + fonts from the CDN: cache-first (their web addresses include the version, so they never change)
//  - live data (Supabase, map tiles, place search): always from the network
const APP = 'trackly-app-v17';
const LIBS = 'trackly-libs-v1';
const SHELL = [
  './', './index.html', './share.html', './landing.html', './privacy.html', './admin.html',
  './css/styles.css', './js/config.js', './js/fake-backend.js', './js/i18n.js', './js/app.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './data/speed-cameras.json', './found.html', './place.html', './js/mini-route.js'
];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  // each file on its own: one missing file must not stop the others from being saved
  event.waitUntil(caches.open(APP).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== LIBS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.open(LIBS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;   // Supabase, tiles, search: network only

  event.respondWith(caches.open(APP).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
    const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { event.waitUntil(fresh); return hit; }
    return (await fresh) || (await c.match('./index.html')) || Response.error();
  }));
});

// phone notifications (sent by the send-alerts Edge Function)
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Trackly', {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: data.tag,
      data: { url: data.url || './' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // switch to Trackly if it's already open, otherwise open it
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
