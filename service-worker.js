const CACHE_VERSION = "vx-cache-20260509-01";
const APP_SCOPE = "/vx/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_VERSION) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  if (url.pathname.endsWith("/index.html") || url.pathname === APP_SCOPE || url.pathname === "/vx") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request).then((response) => {
        const copy = response.clone();

        if (
          url.origin === location.origin &&
          (
            url.pathname.endsWith(".png") ||
            url.pathname.endsWith(".webmanifest") ||
            url.pathname.endsWith(".css") ||
            url.pathname.endsWith(".js")
          )
        ) {
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(request, copy);
          });
        }

        return response;
      });
    })
  );
});
