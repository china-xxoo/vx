const CACHE_VERSION = "vx-split-calc-v29-20260520-unreadcalc1";
const APP_CACHE = "vx-app-" + CACHE_VERSION;
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/css/calc.css",
  "./assets/css/app.css",
  "./assets/js/qrcode.js",
  "./assets/js/calc.js",
  "./assets/js/app.js",
  "./vx-logo-180.png",
  "./vx-logo-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== APP_CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith("/vx-config.json")) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true })
      .then(cached => {
        const fresh = fetch(request)
          .then(response => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(APP_CACHE).then(cache => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || fresh;
      })
  );
});

self.addEventListener("push", event => {
  const title = "Calculator";
  const options = {
    body: "有个笑话",
    icon: "./vx-logo-180.png",
    badge: "./vx-logo-180.png",
    tag: "vx-new-message",
    renotify: false,
    silent: false,
    data: { url: "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) {
          return "navigate" in client ? client.navigate(targetUrl) : client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
