// CPM · Peso de Materiais — service worker
// Página: rede primeiro (sempre a versão mais nova), com cópia para usar sem internet.
// Ícones, fontes e bibliotecas: cache primeiro, atualizando em segundo plano.
// /api nunca passa pelo cache.
const VERSAO = "cpm-v4";
const BASE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
const CDN = [
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSAO).then(async (c) => {
      await c.addAll(BASE);
      await Promise.all(CDN.map((u) => c.add(new Request(u, { mode: "no-cors" })).catch(() => {})));
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
