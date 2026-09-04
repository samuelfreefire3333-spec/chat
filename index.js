import { sessao } from "./core.js";

// Porta de entrada: quem decide é o estado do Firebase Auth, não o
// localStorage. A versão anterior exigia as duas coisas e, quando o cache
// local sumia com a sessão ainda válida, mandava a pessoa para o login.
sessao({ exigirLogin: false }).then((s) => {
  window.location.replace(s ? "inbox.html" : "login.html");
});
