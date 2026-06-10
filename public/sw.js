/* Mood service worker — cache-first for media, network for everything else. */
const MEDIA_CACHE = "mood-media-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname.endsWith(".supabase.co") && url.pathname.includes("/storage/")) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) {
          cache.put(req, res.clone());
          cache.keys().then((keys) => {
            if (keys.length > 600) cache.delete(keys[0]);
          });
        }
        return res;
      })
    );
  }
});
