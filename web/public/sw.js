/**
 * Service worker minimale per rendere Babyl installabile (PWA) e utilizzabile
 * come shell offline. NON è una cache aggressiva: l'app è real-time, quindi il
 * codice va sempre preso dalla rete quando c'è, con la cache solo come fallback.
 *
 * Il WebSocket (/ws) e gli endpoint diagnostici non vengono mai intercettati.
 */
const CACHE = "babyl-v1";
const SHELL = "/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Solo la stessa origine; mai il segnaling o gli endpoint di servizio.
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname === "/ws" ||
    url.pathname === "/healthz" ||
    url.pathname === "/metrics"
  ) {
    return;
  }

  // Navigazioni: rete-prima, con la shell in cache come fallback offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r || Response.error())),
    );
    return;
  }

  // Asset statici: stale-while-revalidate leggero (i nomi sono con hash, quindi
  // le versioni vecchie vengono comunque ripulite al cambio di CACHE).
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
