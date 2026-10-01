/* E-Rechnung – offline app shell (ZUGFeRD / Factur-X) */
const CACHE = 'e-rechnung-v34';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './css/extra.css',
  './js/app.js',
  './js/parse.js',
  './js/zugferd.js',
  './js/embed.js',
  './js/settings.js',
  './manifest.webmanifest',
  './vendor/pdf-lib.min.js',
  './vendor/fontkit.umd.min.js',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './fonts/Calibri.subset.ttf',
  './fonts/Calibri-Bold.subset.ttf',
  './fonts/Aeonis.subset.ttf',
  './fonts/Constantia-Bold.subset.ttf',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/settings_btn.png',
  './icons/settings_btn_hover.png',
  './apple-touch-icon.png',
  './favicon.png',
  './apple-touch-icon-precomposed.png',
  './apple-touch-icon-167.png',
  './apple-touch-icon-152.png',
  './apple-touch-icon-120.png',
];

function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  if (request.destination === 'document') return true;
  if (request.destination && request.destination !== '') return false;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

function isIconOrTouchAsset(url) {
  const p = url.pathname || '';
  return (
    /apple-touch-icon/i.test(p) ||
    /\/favicon\.png$/i.test(p) ||
    /\/icons\/icon-\d+/i.test(p) ||
    /\/icons\/apple-touch/i.test(p)
  );
}

function isServiceWorkerScript(url) {
  return /\/sw\.js$/i.test(url.pathname);
}

function matchCache(request) {
  return caches.match(request, { ignoreSearch: true });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (!res.ok) {
              console.warn('[SW] skip asset (HTTP ' + res.status + '):', url);
              return;
            }
            await cache.put(url, res);
          } catch (err) {
            console.warn('[SW] skip missing asset:', url, err);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isIconOrTouchAsset(url)) return;

  if (isNavigationRequest(req) || isServiceWorkerScript(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && isNavigationRequest(req)) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => {
              cache.put('./index.html', clone);
              cache.put('./', clone.clone());
            });
          }
          return res;
        })
        .catch(async () => {
          if (isNavigationRequest(req)) {
            const shell = (await matchCache('./index.html')) || (await matchCache('./'));
            if (shell) return shell;
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        })
    );
    return;
  }

  event.respondWith(
    matchCache(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          new Response('', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain' },
          })
        );
    })
  );
});
