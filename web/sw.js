// Dirigo — Service Worker (V2-4.2): оффлайн-оболочка пульта.
// Стратегия:
//   навигация (/): network-first, фолбэк на закэшированную оболочку (оффлайн);
//   статика (/web/*): cache-first с фоновым обновлением;
//   API (/api/*): НЕ кэшируем — всегда сеть (актуальные статусы сессий).
const CACHE = "dirigo-v1-shell-v11";
const SHELL = ["/", "/web/app.js", "/web/style.css", "/web/icon.svg", "/web/manifest.webmanifest",
  "/web/vendor/xterm.js", "/web/vendor/xterm.css", "/web/vendor/addon-fit.js", "/web/vendor/addon-unicode11.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // данные — только из сети

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/").then((r) => r ?? new Response("оффлайн, оболочка не закэширована", { status: 503 })))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return network;
    })
  );
});
