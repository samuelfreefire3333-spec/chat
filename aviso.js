import { destinoSeguro } from "./core.js";

// Ícones desenhados (antes eram emojis, que mudam de cara em cada sistema).
const ICONES = {
  error: { cor: "erro", rotulo: "Erro", svg: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>' },
  success: { cor: "sucesso", rotulo: "Sucesso", svg: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>' },
  ban: { cor: "erro", rotulo: "Conta bloqueada", svg: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>' },
  info: { cor: "info", rotulo: "Informação", svg: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>' },
};
const ALERTA = { cor: "alerta", rotulo: "Atenção", svg: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' };

// Mensagens conhecidas, escolhidas pelo código em ?c=.
//
// Antes o título e o texto vinham livres pela URL (?t=...&m=...): qualquer
// pessoa montava um link do domínio oficial com o texto que quisesse ("Sua
// conta será bloqueada, fale com o suporte em ..."). Não havia XSS (era
// textContent), mas é exatamente o tipo de página que dá credibilidade a um
// golpe. Agora a URL só escolhe uma mensagem desta lista.
const MENSAGENS = {
  "acesso-negado": { tipo: "error", titulo: "Acesso negado", texto: "Você não tem permissão para esta página." },
};

function temChave(objeto, chave) {
  return typeof chave === "string" && Object.prototype.hasOwnProperty.call(objeto, chave);
}

const params = new URLSearchParams(window.location.search);
const codigo = params.get("c");
const escolhida = temChave(MENSAGENS, codigo) ? MENSAGENS[codigo] : null;

if (escolhida) {
  document.getElementById("avisoTitulo").textContent = escolhida.titulo;
  document.getElementById("avisoMensagem").textContent = escolhida.texto;
  document.title = `${escolhida.titulo} - Sinex Chat`;
}

// O innerHTML só recebe os ícones fixos deste arquivo.
const icone = escolhida && temChave(ICONES, escolhida.tipo) ? ICONES[escolhida.tipo] : ALERTA;
const iconeEl = document.getElementById("avisoIcon");
iconeEl.innerHTML = icone.svg;
iconeEl.setAttribute("aria-label", icone.rotulo);
document.getElementById("avisoCaixa").dataset.tipo = icone.cor;

const btn = document.getElementById("btnFecharAviso");

// Enter ou Esc também fecham (sem precisar focar o botão, o que desenhava o
// anel de foco nele assim que a tela abria).
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === "Escape") && document.activeElement === document.body) {
    e.preventDefault();
    btn.click();
  }
});

btn.addEventListener("click", () => {
  const pedido = params.get("r");

  // destinoSeguro só aceita páginas locais do app. Antes o valor de ?r= ia
  // direto para location.replace(), o que permitia tanto redirecionar para
  // fora (?r=//site-externo) quanto executar script (?r=javascript:...).
  if (pedido) {
    window.location.replace(destinoSeguro(pedido));
    return;
  }

  if (document.referrer && !document.referrer.includes("aviso.html")) {
    window.history.back();
  } else {
    window.location.replace("inbox.html");
  }
});
