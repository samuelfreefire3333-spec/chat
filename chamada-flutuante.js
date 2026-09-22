// ==========================================================================
// CHAMADA FLUTUANTE (PICTURE-IN-PICTURE)
// ==========================================================================
// Uma chamada WebRTC vive no contexto JavaScript de UMA página. Navegar para
// outra tela destrói a conexão — por isso, antes, sair de chamada.html
// derrubava a chamada na hora.
//
// A solução tem três camadas:
//
//  1. A chamada roda numa JANELA PRÓPRIA (window.open com nome fixo). O resto
//     do app navega à vontade na janela principal sem tocar na chamada.
//  2. Toda página do app mostra uma BARRA FLUTUANTE enquanto há chamada em
//     andamento, com o tempo, "voltar" e "encerrar".
//  3. Dentro da janela da chamada, o botão de minimizar usa Picture-in-Picture
//     de verdade (Document PiP quando existe, senão PiP do elemento de vídeo),
//     que é uma janela do sistema operacional: fica por cima do navegador e de
//     qualquer outro programa.
//
// A conversa entre as janelas passa por BroadcastChannel; o localStorage
// guarda o último estado conhecido para quem acabou de abrir uma página.

import { urlSegura, AVATAR_PADRAO } from "./core.js";

export const NOME_JANELA_CHAMADA = "sinex-chamada";
const NOME_CANAL = "sinex-chamada";
const CHAVE_ESTADO = "chamada_em_andamento";

// A janela da chamada publica um sinal de vida a cada 3s. Acima deste limite o
// estado é considerado obsoleto — cobre o caso de a janela ser fechada no "x",
// sem chance de avisar ninguém.
const VALIDADE_ESTADO = 12000;

// --------------------------------------------------------------------------
// Canal entre as janelas
// --------------------------------------------------------------------------

let canal;

export function canalDeChamada() {
  if (canal !== undefined) return canal;
  try {
    canal = new BroadcastChannel(NOME_CANAL);
  } catch (_) {
    canal = null; // navegador antigo: sobra o localStorage
  }
  return canal;
}

export function avisarJanelas(mensagem) {
  try { canalDeChamada()?.postMessage(mensagem); } catch (_) {}
}

// --------------------------------------------------------------------------
// Estado compartilhado
// --------------------------------------------------------------------------

export function lerEstadoDaChamada() {
  let bruto = null;
  try { bruto = localStorage.getItem(CHAVE_ESTADO); } catch (_) { return null; }
  if (!bruto) return null;

  try {
    const estado = JSON.parse(bruto);
    if (!estado?.comQuem) return null;
    if (Date.now() - (estado.sinalDeVida || 0) > VALIDADE_ESTADO) return null;
    return estado;
  } catch (_) {
    return null;
  }
}

export function publicarEstadoDaChamada(estado) {
  const completo = { ...estado, sinalDeVida: Date.now() };
  try { localStorage.setItem(CHAVE_ESTADO, JSON.stringify(completo)); } catch (_) {}
  avisarJanelas({ tipo: "estado", estado: completo });
}

export function limparEstadoDaChamada() {
  try { localStorage.removeItem(CHAVE_ESTADO); } catch (_) {}
  avisarJanelas({ tipo: "encerrada" });
}

// --------------------------------------------------------------------------
// Abrir a chamada na janela dela
// --------------------------------------------------------------------------

/** Estamos dentro da janela dedicada à chamada? */
export function estouNaJanelaDaChamada() {
  return window.name === NOME_JANELA_CHAMADA
    || window.location.pathname.includes("chamada.html");
}

/**
 * Abre (ou traz para a frente) a janela da chamada.
 * Devolve false quando o navegador bloqueia a janela — aí quem chamou decide
 * o que fazer (normalmente, navegar na própria aba, como era antes).
 *
 * Precisa ser chamada de dentro de um clique: fora disso o bloqueador de
 * pop-ups recusa.
 */
export function abrirJanelaDeChamada(params) {
  const url = `chamada.html?${params.toString()}`;

  const largura = 420;
  const altura = 660;
  const esquerda = Math.max(0, (window.screen?.availWidth || 1280) - largura - 40);
  const recursos = [
    "popup=yes",
    `width=${largura}`,
    `height=${altura}`,
    `left=${esquerda}`,
    "top=60",
    "menubar=no",
    "toolbar=no",
    "location=no",
    "status=no",
  ].join(",");

  let janela = null;
  try {
    janela = window.open(url, NOME_JANELA_CHAMADA, recursos);
  } catch (_) {
    return false;
  }

  if (!janela) return false;
  try { janela.focus(); } catch (_) {}
  return true;
}

/** Traz de volta a janela de uma chamada já em andamento. */
function voltarParaAChamada(estado) {
  const params = new URLSearchParams({
    u: estado.comQuem,
    papel: estado.papel || "emissor",
  });
  if (estado.tipo === "audio") params.set("audio", "true");

  // Sem URL, window.open só foca a janela existente. Se ela não existir mais,
  // o navegador abre uma em branco — por isso a URL vai junto como reserva.
  if (!abrirJanelaDeChamada(params)) {
    window.location.href = `chamada.html?${params.toString()}`;
  }
}

// --------------------------------------------------------------------------
// Barra flutuante (todas as telas, menos a da própria chamada)
// --------------------------------------------------------------------------

let barra = null;
let elTempo = null;
let relogio = null;
let estadoAtual = null;

function formatarDuracao(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutos = String(Math.floor(total / 60)).padStart(2, "0");
  const segundos = String(total % 60).padStart(2, "0");
  return `${minutos}:${segundos}`;
}

function montarBarra() {
  if (barra) return barra;

  barra = document.createElement("div");
  barra.id = "barraChamada";
  barra.className = "barra-chamada";
  barra.setAttribute("role", "status");

  const avatar = document.createElement("img");
  avatar.className = "barra-chamada-avatar";
  avatar.alt = "";

  const texto = document.createElement("div");
  texto.className = "barra-chamada-texto";

  const nome = document.createElement("strong");
  elTempo = document.createElement("span");
  elTempo.className = "barra-chamada-tempo";
  texto.append(nome, elTempo);

  const btnVoltar = document.createElement("button");
  btnVoltar.type = "button";
  btnVoltar.className = "barra-chamada-btn";
  btnVoltar.textContent = "Voltar";
  btnVoltar.addEventListener("click", () => {
    if (estadoAtual) voltarParaAChamada(estadoAtual);
  });

  const btnEncerrar = document.createElement("button");
  btnEncerrar.type = "button";
  btnEncerrar.className = "barra-chamada-btn barra-chamada-btn-encerrar";
  btnEncerrar.setAttribute("aria-label", "Encerrar chamada");
  btnEncerrar.textContent = "Encerrar";
  btnEncerrar.addEventListener("click", () => {
    avisarJanelas({ tipo: "encerrar" });
    esconderBarra();
  });

  barra.append(avatar, texto, btnVoltar, btnEncerrar);
  barra._avatar = avatar;
  barra._nome = nome;

  document.body.appendChild(barra);
  return barra;
}

function atualizarTempo() {
  if (!estadoAtual || !elTempo) return;

  if (!estadoAtual.conectadaEm) {
    elTempo.textContent = estadoAtual.status || "chamando…";
    return;
  }
  elTempo.textContent = formatarDuracao(Date.now() - estadoAtual.conectadaEm);
}

function mostrarBarra(estado) {
  if (estouNaJanelaDaChamada()) return;
  if (!document.body) return;

  estadoAtual = estado;
  const el = montarBarra();

  el._nome.textContent = estado.nome || `@${estado.comQuem}`;
  el._avatar.src = urlSegura(estado.foto, AVATAR_PADRAO);
  el.classList.add("visivel");
  document.body.classList.add("com-barra-chamada");

  atualizarTempo();
  clearInterval(relogio);
  relogio = setInterval(() => {
    // O estado some sozinho se a janela da chamada morrer sem avisar.
    if (!lerEstadoDaChamada()) {
      esconderBarra();
      return;
    }
    atualizarTempo();
  }, 1000);
}

function esconderBarra() {
  estadoAtual = null;
  clearInterval(relogio);
  relogio = null;
  barra?.classList.remove("visivel");
  document.body?.classList.remove("com-barra-chamada");
}

/**
 * Liga a barra flutuante nesta página. Chamada pelo radar.js, que já é
 * carregado em todas as telas.
 */
export function ligarBarraDeChamada() {
  if (estouNaJanelaDaChamada()) return;

  const aplicar = () => {
    const estado = lerEstadoDaChamada();
    if (estado) mostrarBarra(estado);
    else esconderBarra();
  };

  canalDeChamada()?.addEventListener("message", (evento) => {
    const dados = evento.data;
    if (!dados) return;
    if (dados.tipo === "estado" && dados.estado) mostrarBarra(dados.estado);
    if (dados.tipo === "encerrada") esconderBarra();
  });

  // Reserva para navegadores sem BroadcastChannel: o evento "storage" dispara
  // nas outras abas/janelas da mesma origem.
  window.addEventListener("storage", (evento) => {
    if (evento.key === CHAVE_ESTADO) aplicar();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", aplicar, { once: true });
  } else {
    aplicar();
  }
}
