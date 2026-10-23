/* Sinexflix: guarda a "casca" do app para abrir rápido e funcionar sem internet. */
const VERSION = "sinexflix-v5";
const SHELL = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Arquivos do próprio app: rede primeiro (pega atualizações), cache se estiver sem internet.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("index.html"))));
    return;
  }
  // Catálogo (Cinemeta) e capas: mostra o que tem guardado e atualiza por trás.
  if (/cinemeta\.strem\.io|metahub\.space|archive\.org\/services\/img/.test(url.href)) {
    e.respondWith(caches.open(VERSION + "-data").then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
  // Vídeos, TV ao vivo e demais: direto da rede, sem guardar.
});
