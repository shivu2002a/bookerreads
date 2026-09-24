/* BookerReads service worker (Requirement 14.5).
 *
 * Strategy, kept deliberately small:
 *  - App shell (offline page, icons, manifest): precached on install.
 *  - Navigations and RSC payloads: network first, fall back to the cached copy
 *    of that URL, then to /offline. So the app opens to a usable shell offline.
 *  - Next static chunks (/_next/static): cache first; they are content-hashed.
 *  - Book covers and listing photos: cache first with a size cap.
 *  - API, webhooks, auth, server actions (POST): never cached.
 *
 * Handoff confirmations queue in IndexedDB on the page side (lib/offline) and
 * replay on `online`; the worker does not intercept them.
 */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const PAGES = `pages-${VERSION}`;
const STATIC = `static-${VERSION}`;
const IMAGES = `images-${VERSION}`;
const IMAGE_LIMIT = 200;

const PRECACHE = [
  "/offline",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => ![SHELL, PAGES, STATIC, IMAGES].includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

function isImage(url) {
  return (
    url.pathname.startsWith("/_next/image") ||
    url.hostname === "covers.openlibrary.org" ||
    url.hostname.startsWith("books.google") ||
    url.pathname.includes("/storage/v1/object/public/")
  );
}

async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > limit)
    await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (
    sameOrigin &&
    (url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/auth/") ||
      url.pathname.startsWith("/admin"))
  )
    return;

  if (sameOrigin && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches
        .open(STATIC)
        .then((c) =>
          c
            .match(req)
            .then((hit) => hit || fetch(req).then((res) => (c.put(req, res.clone()), res))),
        ),
    );
    return;
  }

  if (isImage(url)) {
    event.respondWith(
      caches.open(IMAGES).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) {
                c.put(req, res.clone());
                trim(IMAGES, IMAGE_LIMIT);
              }
              return res;
            }),
        ),
      ),
    );
    return;
  }

  const isNavigation = req.mode === "navigate";
  const isRsc = req.headers.get("RSC") === "1";
  if (sameOrigin && (isNavigation || isRsc)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(PAGES).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          if (isNavigation) return caches.match("/offline");
          return new Response("", { status: 503 });
        }),
    );
  }
});
