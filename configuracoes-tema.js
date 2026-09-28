import Core, { montarAvatarNav, sessao } from "./core.js";

const opcoes = [...document.querySelectorAll(".tema-opcao[data-tema]")];

const NOMES = { auto: "Automático", claro: "Claro", escuro: "Escuro" };

function preferenciaAtual() {
  if (window.sinexTema) return window.sinexTema.preferencia();
  try { return localStorage.getItem("tema") || "auto"; } catch (_) { return "auto"; }
}

function marcar(preferencia) {
  opcoes.forEach((btn) => {
    const ativo = btn.dataset.tema === preferencia;
    btn.classList.toggle("active-theme", ativo);
    btn.setAttribute("aria-checked", ativo ? "true" : "false");
    // Num grupo de rádio só a opção marcada entra no Tab; as setas trocam.
    btn.tabIndex = ativo ? 0 : -1;
  });
}

function definirTema(preferencia) {
  if (window.sinexTema) {
    window.sinexTema.definir(preferencia);
  } else {
    // tema.js não carregou: aplica aqui mesmo.
    const claro = preferencia === "claro"
      || (preferencia === "auto" && window.matchMedia?.("(prefers-color-scheme: light)").matches);
    document.documentElement.classList.toggle("light-theme", claro);
    document.documentElement.classList.toggle("dark-theme", !claro);
    try {
      if (preferencia === "auto") localStorage.removeItem("tema");
      else localStorage.setItem("tema", preferencia);
    } catch (_) {}
  }
  marcar(preferencia);
  Core.aviso(`Tema ${NOMES[preferencia].toLowerCase()} ativado.`, "sucesso");
}

opcoes.forEach((btn, i) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tema !== preferenciaAtual()) definirTema(btn.dataset.tema);
  });
  btn.addEventListener("keydown", (e) => {
    const passo = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!passo) return;
    e.preventDefault();
    const proximo = opcoes[(i + passo + opcoes.length) % opcoes.length];
    proximo.focus();
    definirTema(proximo.dataset.tema);
  });
});

// Outra aba trocou o tema: marca a opção certa aqui também.
window.addEventListener("storage", (e) => {
  if (e.key === "tema" || e.key === null) marcar(preferenciaAtual());
});

document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
  if (document.referrer && window.history.length > 1) window.history.back();
  else window.location.href = "configuracoes.html";
});

marcar(preferenciaAtual());

sessao().then(montarAvatarNav);
