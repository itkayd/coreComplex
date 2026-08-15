/*
 * Offline-first service worker (spec p.25 "installable PWA, offline-first";
 * p.24 "Plan enough work for the bounded offline session").
 *
 * Cache-first for the app shell and the immutable content pack — the pack is
 * versioned, so a new pack version is a new URL/content and never a stale read.
 * The learning event log lives in IndexedDB, not here.
 */
const CACHE = "dyr-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((hit) =>
      hit ??
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html")),
    ),
  );
});
