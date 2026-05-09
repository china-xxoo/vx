const CACHE_NAME = "vx-pwa-shell-default-hall-24h-20260509-1";

const APP_SHELL = [
  "/vx/",
  "/vx/index.html",
  "/vx/manifest.webmanifest",
  "/vx/vx-logo-180.png",
  "/vx/vx-logo-192.png",
  "/vx/vx-logo-512.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL).catch(() => null);
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => {
        return Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin || !url.pathname.startsWith("/vx/")) {
    return;
  }

  if (
    req.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/vx/"
  ) {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then(res => {
          const copy = res.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(req, copy);
          });

          return res;
        })
        .catch(() => {
          return caches.match(req).then(cached => {
            return cached || caches.match("/vx/index.html");
          });
        })
    );

    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req)
        .then(res => {
          const copy = res.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(req, copy);
          });

          return res;
        })
        .catch(() => cached);

      return cached || fresh;
    })
  );
});
