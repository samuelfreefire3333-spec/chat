// Aplica o tema antes da primeira pintura, evitando o "flash" de tela clara.
// Precisa ser um script clássico e síncrono no <head> — por isso não é módulo.
//
// Este arquivo substitui o bloco inline que estava copiado em 13 páginas e que
// obrigava o CSP a liberar 'unsafe-inline' em script-src.
(function () {
  "use strict";

  var raiz = document.documentElement;
  var tema;

  try {
    tema = localStorage.getItem("tema");
  } catch (_) {
    // Navegador em modo privado ou com armazenamento bloqueado.
    tema = null;
  }

  if (!tema) {
    // Sem preferência salva, segue o sistema operacional.
    tema = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "claro"
      : "escuro";
  }

  raiz.classList.toggle("light-theme", tema === "claro");
  raiz.classList.toggle("dark-theme", tema !== "claro");

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
