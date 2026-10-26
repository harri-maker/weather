// Caches the app's own files so it opens instantly and works offline.
// Strategy: network first (so updates show right away), falling back to the cache when offline.
// Forecast and place-name requests go to other sites and are left alone; app.js caches those.
const CACHE = "forecast-app-v9";
const SHELL = ["./", "index.html", "style.css", "sky.js", "app.js", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(event.request, { cache: "no-cache" });
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    }),
  );
});
