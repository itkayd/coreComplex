/*
 * Offline-first service worker (spec p.25 "installable PWA, offline-first";
 * p.24 "Plan enough work for the bounded offline session").
 *
 * Two caches, deliberately separate:
 *
 *   dyr-shell-v1          the app shell and the pack JSON — cache-first, because
 *                         a pack is immutable and versioned, so a cached read is
 *                         never stale.
 *   dyr-pack-<version>    that pack's canonical recordings, installed on demand
 *                         when the app tells the worker which pack it verified.
 *
 * Splitting them is what lets a bigger future pack be installed or evicted on its
 * own without touching the shell — and it keeps the worker out of the business of
 * knowing what content exists, which only the verified pack can say. Nothing from
 * the source inbox is ever cached; only built, content-addressed runtime assets.
 */
const CACHE = "dyr-shell-v1";
const PACK_PREFIX = "dyr-pack-";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // Pack caches survive activation; they are evicted by version instead.
          .filter((k) => k !== CACHE && !k.startsWith(PACK_PREFIX))
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

/**
 * Install one pack's audio, and drop every other pack's.
 *
 * Content-addressed URLs mean a recording that survives into the next pack
 * version is simply re-fetched under the same name, and one that was replaced
 * disappears with its cache.
 */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "dyr:install-pack") return;
  const cacheName = `${PACK_PREFIX}${data.packVersion}`;
  event.waitUntil(
    caches.open(cacheName)
      .then((cache) => cache.addAll(data.urls).catch(() => {}))
      .then(() => caches.keys())
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(PACK_PREFIX) && k !== cacheName).map((k) => caches.delete(k)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    // `caches.match` without a cache name searches every cache, so a recording
    // installed into the pack cache is served offline exactly like the shell.
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
