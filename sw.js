// Service Worker do Sinex Chat.
//
// Suba este número a cada publicação. Sem isso — e sem o handler de activate
// que existia antes — o cache antigo nunca era removido e quem já tinha
// instalado o app continuava com o HTML velho até limpar os dados do site.
const VERSAO = "v12";
const CACHE_ESTATICO = `sinex-estatico-${VERSAO}`;

const ARQUIVOS = [
  "/",
  "/index.html",
  "/login.html",
  "/cadastro.html",
  "/inbox.html",
  "/chat.html",
  "/perfil.html",
  "/explorar.html",
  "/configuracoes.html",
  "/configuracoes-tema.html",
  "/editar-perfil.html",
  "/foto.html",
  "/chamada.html",
  "/aviso.html",
  "/grupo-novo.html",

  // O style.css é o único compartilhado; sem os CSS de cada tela, quem abrisse
  // o app offline pela primeira vez via a página sem estilo nenhum.
  "/style.css",
  "/inbox.css",
  "/chat.css",
  "/perfil.css",
  "/explorar.css",
  "/chamada.css",
  "/cadastro.css",
  "/login.css",
  "/configuracoes.css",
  "/configuracoes-tema.css",
  "/editar-perfil.css",
  "/foto.css",
  "/aviso.css",
  "/grupo-novo.css",
  "/index.css",

  // Módulos compartilhados
  "/tema.js",
  "/core.js",
  "/firebase.js",
  "/radar.js",
  "/mensagens.js",
  "/chamada-flutuante.js",
  "/midia.js",
  "/cloudinary.js",
  "/midia-validacao.js",
  "/e2ee.js",
  "/e2ee-cripto.js",
  "/vendor/hpke-1.9.0.js",

  // Um módulo por tela
  "/index.js",
  "/login.js",
  "/cadastro.js",
  "/aviso.js",
  "/inbox.js",
  "/chat.js",
  "/perfil.js",
  "/explorar.js",
  "/chamada.js",
  "/configuracoes.js",
  "/configuracoes-tema.js",
  "/editar-perfil.js",
  "/foto.js",
  "/grupo-novo.js",

  "/manifest.json",
  "/assets/icone-192.png",
  "/assets/icone-512.png",
  "/assets/icone-maskable-512.png",
  "/assets/apple-touch-icon.png",
  "/assets/avatar-padrao.svg",
  "/assets/avatar-grupo.svg",
  "/assets/notificacao.wav",
  "/assets/toque.wav",
];
// admin.html e admin.js ficam de fora de propósito: são de uso raro e não
// precisam ocupar o cache de todo mundo.

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_ESTATICO);

      // cache.addAll é tudo-ou-nada: um único 404 na lista derrubava a
      // instalação inteira em silêncio. Aqui cada arquivo é independente.
      //
      // { cache: "reload" } é obrigatório: cache.add(url) passa pelo cache
      // HTTP do navegador, então o Service Worker novo pré-cacheava a versão
      // ANTIGA dos arquivos que ainda estivessem dentro do max-age. Era isso
      // que fazia uma correção publicada não chegar em quem já usava o app —
      // o bug continuava na tela dos outros por mais uma hora, no mínimo.
      await Promise.all(
        ARQUIVOS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn(`[sw] não foi possível pré-cachear ${url}:`, err);
          })
        )
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(
        nomes
          .filter((nome) => nome.startsWith("sinex-") && nome !== CACHE_ESTATICO)
          .map((nome) => caches.delete(nome))
      );
      await self.clients.claim();
    })()
  );
});

// Permite que a página peça a troca imediata de versão.
self.addEventListener("message", (evento) => {
  if (evento.data === "pular-espera") self.skipWaiting();
});

function ehNavegacao(request) {
  return request.mode === "navigate";
}

function ehEstatico(url) {
  return /\.(css|js|png|jpg|jpeg|svg|webp|wav|woff2?)$/i.test(url.pathname);
}

self.addEventListener("fetch", (evento) => {
  const { request } = evento;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Nada de origem externa entra no cache: Firestore, Storage e o WebSocket
  // precisam sempre ir à rede.
  if (url.origin !== self.location.origin) return;

  // Navegação: rede primeiro (para pegar deploys novos), cache como reserva.
  //
  // A chave do cache é só o caminho, sem a query. Guardar a URL inteira criava
  // uma entrada nova para CADA conversa aberta (chat.html?u=fulano,
  // chat.html?u=ciclano, ...) e o cache crescia sem limite, enquanto o mesmo
  // chat.html era baixado de novo a cada contato diferente.
  if (ehNavegacao(request)) {
    const chave = new Request(url.origin + url.pathname);

    evento.respondWith(
      (async () => {
        try {
          const resposta = await fetch(request);
          if (resposta && resposta.ok && resposta.type === "basic") {
            const cache = await caches.open(CACHE_ESTATICO);
            cache.put(chave, resposta.clone());
          }
          return resposta;
        } catch (_) {
          return (
            (await caches.match(chave)) ||
            (await caches.match("/index.html")) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // Estáticos: responde do cache na hora e atualiza por trás
  // (stale-while-revalidate), em vez de esperar a rede a cada navegação.
  if (ehEstatico(url)) {
    evento.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_ESTATICO);
        const emCache = await cache.match(request);

        const daRede = fetch(request)
          .then((resposta) => {
            if (resposta && resposta.status === 200) cache.put(request, resposta.clone());
            return resposta;
          })
          .catch(() => null);

        return emCache || (await daRede) || Response.error();
      })()
    );
    return;
  }

  evento.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (_) {
        // caches.match devolve uma promessa que pode resolver em undefined —
        // e respondWith(undefined) quebra a requisição em vez de falhar
        // graciosamente.
        return (await caches.match(request)) || Response.error();
      }
    })()
  );
});
