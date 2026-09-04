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
  } catch (_) {}

  if (raiz.getAttribute("data-exige-login") === "sim" && !temCache) {
    window.location.replace("login.html");
  }

  if (raiz.getAttribute("data-so-deslogado") === "sim" && temCache) {
    window.location.replace("inbox.html");
  }
})();
