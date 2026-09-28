// Aplica o tema antes da primeira pintura, evitando o "flash" de tela clara.
// Precisa ser um script clássico e síncrono no <head> — por isso não é módulo.
//
// Este arquivo substitui o bloco inline que estava copiado em 13 páginas e que
// obrigava o CSP a liberar 'unsafe-inline' em script-src.
//
// Preferências possíveis (localStorage "tema"):
//   "claro" | "escuro"  → tema fixo
//   ausente             → automático: segue o sistema e muda junto com ele
(function () {
  "use strict";

  var raiz = document.documentElement;
  var consultaClaro = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  function lerPreferencia() {
    try {
      var salvo = localStorage.getItem("tema");
      return salvo === "claro" || salvo === "escuro" ? salvo : "auto";
    } catch (_) {
      // Navegador em modo privado ou com armazenamento bloqueado.
      return "auto";
    }
  }

  function temaEfetivo(preferencia) {
    if (preferencia === "claro" || preferencia === "escuro") return preferencia;
    return consultaClaro && consultaClaro.matches ? "claro" : "escuro";
  }

  // Cor da barra do navegador/sistema no celular. Páginas com cor fixa (a da
  // chamada é sempre escura) já trazem a própria <meta> e ficam como estão.
  function pintarBarraDoSistema(tema) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && !meta.hasAttribute("data-tema-auto")) return;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.setAttribute("data-tema-auto", "");
      (document.head || raiz).appendChild(meta);
    }
    meta.content = tema === "claro" ? "#ffffff" : "#000000";
  }

  function aplicar(preferencia) {
    var tema = temaEfetivo(preferencia);
    raiz.classList.toggle("light-theme", tema === "claro");
    raiz.classList.toggle("dark-theme", tema !== "claro");
    pintarBarraDoSistema(tema);
    return tema;
  }

  aplicar(lerPreferencia());

  // No automático, acompanha a troca de tema do sistema com a página aberta.
  if (consultaClaro) {
    var aoMudarSistema = function () {
      if (lerPreferencia() === "auto") aplicar("auto");
    };
    if (consultaClaro.addEventListener) consultaClaro.addEventListener("change", aoMudarSistema);
    else if (consultaClaro.addListener) consultaClaro.addListener(aoMudarSistema);
  }

  // Usado pela tela de Aparência: grava a escolha e aplica na hora.
  window.sinexTema = {
    preferencia: lerPreferencia,
    definir: function (preferencia) {
      try {
        if (preferencia === "claro" || preferencia === "escuro") localStorage.setItem("tema", preferencia);
        else localStorage.removeItem("tema");
      } catch (_) {}
      return aplicar(preferencia);
    }
  };

  // Outra aba trocou o tema: esta acompanha.
  window.addEventListener("storage", function (e) {
    if (e.key === "tema" || e.key === null) aplicar(lerPreferencia());
  });

  // Atalhos de UX (NÃO são controle de segurança): evitam piscar a interface
  // errada por um instante. Quem decide de verdade é Core.sessao(), validando
  // o token do Firebase — adulterar o localStorage não dá acesso a nada,
  // porque as regras do Firestore e o backend Go conferem o uid do token.
  var temCache = false;
  try {
    temCache = !!localStorage.getItem("usuario");
  } catch (_) {
    // Armazenamento bloqueado (aba anônima, navegador com escudos ligados):
    // aqui não dá para saber nada. Tratado como "sem cache" — e, justamente
    // por isso, nunca como motivo para expulsar ninguém.
  }

  // A sessão de verdade vive no IndexedDB do Firebase Auth, que não dá para
  // ler de forma síncrona neste ponto. A versão anterior mandava para o login
  // sempre que o cache de exibição faltava: isso derrubava quem estava logado
  // com o armazenamento limpo e, em aba anônima, criava um ping-pong infinito
  // entre login.html e inbox.html (o cadastro nunca conseguia gravar o cache).
  //
  // Agora a página apenas fica escondida até Core.sessao() decidir. Quem não
  // estiver logado é redirecionado de lá, onde a informação é confiável.
  if (raiz.getAttribute("data-exige-login") === "sim" && !temCache) {
    raiz.classList.add("aguardando-sessao");
    // Rede de segurança: se o módulo falhar ao carregar, a tela não fica
    // escondida para sempre.
    setTimeout(function () { raiz.classList.remove("aguardando-sessao"); }, 4000);
  }

  // Na direção contrária o atalho é seguro: se o cache estiver velho,
  // Core.sessao() limpa tudo e devolve a pessoa ao login.
  if (raiz.getAttribute("data-so-deslogado") === "sim" && temCache) {
    window.location.replace("inbox.html");
  }
})();
