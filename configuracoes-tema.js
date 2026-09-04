import Core, { montarAvatarNav, sessao } from "./core.js";

const btnClaro = document.getElementById("btnClaro");
const btnEscuro = document.getElementById("btnEscuro");

function marcar(tema) {
  btnClaro.classList.toggle("active-theme", tema === "claro");
  btnEscuro.classList.toggle("active-theme", tema !== "claro");
  btnClaro.setAttribute("aria-pressed", tema === "claro" ? "true" : "false");
  btnEscuro.setAttribute("aria-pressed", tema !== "claro" ? "true" : "false");
}

function definirTema(tema) {
  const html = document.documentElement;
  const claro = tema === "claro";

  html.classList.toggle("light-theme", claro);
  html.classList.toggle("dark-theme", !claro);

  try { localStorage.setItem("tema", claro ? "claro" : "escuro"); } catch (_) {}

  marcar(tema);
  Core.aviso(claro ? "Modo Claro ativado!" : "Modo Escuro ativado!", "#00a884");
}

btnClaro.addEventListener("click", () => definirTema("claro"));
btnEscuro.addEventListener("click", () => definirTema("escuro"));

document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
  if (document.referrer) window.history.back();
  else window.location.href = "configuracoes.html";
});

let temaSalvo = "escuro";
try { temaSalvo = localStorage.getItem("tema") || "escuro"; } catch (_) {}
marcar(temaSalvo);

sessao().then(montarAvatarNav);
