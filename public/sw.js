// CPM · Peso de Materiais — service worker
// Página: rede primeiro (sempre a versão mais nova), com cópia para usar sem internet.
// Ícones, fontes e bibliotecas: cache primeiro, atualizando em segundo plano.
// /api nunca passa pelo cache.
const VERSAO = "cpm-v19";
// a biblioteca do Excel (grande) entra no cache na primeira vez que for usada
const BASE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-32.png", "/vendor/chart-4.4.1.min.js", "/fonts/archivo-var.woff2", "/fonts/plex-sans-400.woff2", "/fonts/plex-sans-500.woff2", "/fonts/plex-sans-600.woff2", "/fonts/plex-sans-700.woff2", "/fonts/plex-mono-500.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSAO).then(async (c) => {
      await c.addAll(BASE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSAO).then((c) => c.put("/", copy)); return res; })
        .catch(() => caches.match("/"))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(VERSAO).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
