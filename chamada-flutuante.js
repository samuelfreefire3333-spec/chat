// ==========================================================================
// CHAMADA FLUTUANTE (PICTURE-IN-PICTURE)
// ==========================================================================
// Uma chamada WebRTC vive no contexto JavaScript de UMA página. Navegar para
// outra tela — ou RECARREGAR a própria tela da chamada — destrói a conexão.
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
//
// Mensagens no canal "sinex-chamada":
//   da janela da chamada:  { tipo: "estado", estado } · { tipo: "encerrada" }
//   para a janela:         { tipo: "encerrar" } · { tipo: "restaurar" }
//                          { tipo: "atender-outra", params }

import { definirAvatar, aviso } from "./core.js";

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
  // O BroadcastChannel não entrega a mensagem para a própria página que a
  // mandou. Quando o balão de chamada em espera aparece DENTRO da janela da
  // chamada, é ela mesma que precisa ouvir o pedido.
  try { window.dispatchEvent(new CustomEvent("sinex-chamada-local", { detail: mensagem })); } catch (_) {}
}

/** Ouve as mensagens do canal da chamada, venham de outra janela ou desta. */
export function ouvirJanelas(callback) {
  canalDeChamada()?.addEventListener("message", (evento) => {
    if (evento.data) callback(evento.data);
  });
  window.addEventListener("sinex-chamada-local", (evento) => {
    if (evento.detail) callback(evento.detail);
  });
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
// Intenção de chamada (uso único)
// --------------------------------------------------------------------------
// A tela da chamada liga câmera e microfone e conecta sozinha. Antes bastava
// alguém mandar um link "chamada.html?u=atacante&papel=receptor" para que um
// clique da vítima entregasse a câmera dela a quem mandou o link.
//
// Agora a tela só liga a mídia se ESTE navegador registrou, segundos antes,
// que a pessoa tocou em "ligar" ou "atender" dentro do app. O registro é um
// número aleatório de uso único, guardado no armazenamento do próprio site —
// que um link vindo de fora não tem como escrever.

const CHAVE_INTENCAO = "chamada_intencao";
const VALIDADE_INTENCAO = 60000;

function gravarIntencao(valor) {
  try {
    localStorage.setItem(CHAVE_INTENCAO, valor);
    return true;
  } catch (_) {
    try {
      sessionStorage.setItem(CHAVE_INTENCAO, valor);
      return true;
    } catch (_) {
      return false;
    }
  }
}

function lerEApagarIntencao() {
  let bruto = null;
  try { bruto = localStorage.getItem(CHAVE_INTENCAO); } catch (_) {}
  if (!bruto) {
    try { bruto = sessionStorage.getItem(CHAVE_INTENCAO); } catch (_) {}
  }
  try { localStorage.removeItem(CHAVE_INTENCAO); } catch (_) {}
  try { sessionStorage.removeItem(CHAVE_INTENCAO); } catch (_) {}
  try { return JSON.parse(bruto || "null"); } catch (_) { return null; }
}

/**
 * Registra que a pessoa pediu esta chamada agora (clique em ligar/atender).
 * Devolve o número de uso único que vai no endereço da tela da chamada.
 */
export function registrarIntencaoDeChamada({ com, papel, audio }) {
  const nonce = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  gravarIntencao(JSON.stringify({ nonce, com, papel, audio: !!audio, criadaEm: Date.now() }));
  return nonce;
}

/** Confere e consome a intenção. Qualquer divergência: false. */
export function consumirIntencaoDeChamada({ nonce, com, papel, audio }) {
  const dados = lerEApagarIntencao();
  if (!dados || typeof nonce !== "string" || !nonce) return false;
  const idade = Date.now() - Number(dados.criadaEm);
  return dados.nonce === nonce
    && dados.com === com
    && dados.papel === papel
    && dados.audio === !!audio
    && idade >= 0
    && idade < VALIDADE_INTENCAO;
}

// --------------------------------------------------------------------------
// Abrir a chamada na janela dela
// --------------------------------------------------------------------------

/** Estamos dentro da janela dedicada à chamada? */
export function estouNaJanelaDaChamada() {
  return window.name === NOME_JANELA_CHAMADA
    || window.location.pathname.includes("chamada.html");
}

function recursosDaJanela() {
  const largura = 420;
  const altura = 700;
  const esquerda = Math.max(0, (window.screen?.availWidth || 1280) - largura - 40);
  return [
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
}

/**
 * Abre a janela de uma chamada NOVA.
 * Devolve false quando o navegador bloqueia a janela — aí quem chamou decide
 * o que fazer (normalmente, navegar na própria aba, como era antes).
 *
 * Nunca use isto para voltar a uma chamada em andamento: window.open com um
 * endereço NAVEGA a janela que já existe com aquele nome, ou seja, recarrega
 * a tela da chamada e derruba a ligação. Para voltar, use
 * focarJanelaDaChamada().
 *
 * Precisa ser chamada de dentro de um clique: fora disso o bloqueador de
 * pop-ups recusa.
 */
export function abrirJanelaDeChamada(params) {
  const url = `chamada.html?${params.toString()}`;

  let janela = null;
  try {
    janela = window.open(url, NOME_JANELA_CHAMADA, recursosDaJanela());
  } catch (_) {
    return false;
  }

  if (!janela) return false;
  try { janela.focus(); } catch (_) {}
  return true;
}

/**
 * Traz para a frente a janela de uma chamada que já existe, SEM navegar nela.
 *
 * window.open("", nome) devolve a janela com aquele nome sem tocar no que ela
 * está mostrando. Se não existir janela com esse nome ao alcance desta aba
 * (por exemplo, a chamada está em outra aba aberta à mão), o navegador cria
 * uma em branco — que fechamos na hora.
 *
 * Devolve true se encontrou a janela.
 */
export function focarJanelaDaChamada() {
  let janela = null;
  try {
    janela = window.open("", NOME_JANELA_CHAMADA, recursosDaJanela());
  } catch (_) {
    janela = null;
  }
  if (!janela) return false;

  let emBranco = false;
  try {
    emBranco = janela.location.href === "about:blank";
  } catch (_) {
    emBranco = false;
  }

  if (emBranco) {
    try { janela.close(); } catch (_) {}
    return false;
  }

  try { janela.focus(); } catch (_) {}
  return true;
}

/** Volta para uma chamada em andamento (barra flutuante, notificação...). */
export function voltarParaAChamada() {
  // Se a interface estiver no Picture-in-Picture, a janela da chamada
  // recolhe o PiP e mostra a chamada inteira de novo.
  avisarJanelas({ tipo: "restaurar" });

  if (focarJanelaDaChamada()) return true;

  // A chamada está numa aba que esta janela não alcança. O pedido de
  // "restaurar" acima já chegou lá pelo canal; resta avisar onde ela está.
  aviso("A chamada está aberta em outra aba ou janela do navegador.", "info");
  return false;
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
  const horas = Math.floor(total / 3600);
  const minutos = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const segundos = String(total % 60).padStart(2, "0");
  return horas ? `${horas}:${minutos}:${segundos}` : `${minutos}:${segundos}`;
}

const ICONE_VOLTAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
const ICONE_DESLIGAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';

function montarBarra() {
  if (barra) return barra;

  barra = document.createElement("div");
  barra.id = "barraChamada";
  barra.className = "barra-chamada";
  barra.setAttribute("role", "region");
  barra.setAttribute("aria-label", "Chamada em andamento");

  // A área inteira (menos o botão de encerrar) volta para a chamada — é um
  // alvo grande, como a barra verde dos mensageiros de celular.
  const principal = document.createElement("button");
  principal.type = "button";
  principal.className = "barra-chamada-principal";
  principal.setAttribute("aria-label", "Voltar para a chamada");

  const indicador = document.createElement("span");
  indicador.className = "barra-chamada-indicador";
  indicador.setAttribute("aria-hidden", "true");

  const avatar = document.createElement("img");
  avatar.className = "barra-chamada-avatar";
  avatar.alt = "";

  const texto = document.createElement("span");
  texto.className = "barra-chamada-texto";

  const nome = document.createElement("strong");
  elTempo = document.createElement("span");
  elTempo.className = "barra-chamada-tempo";
  elTempo.setAttribute("aria-live", "off");
  texto.append(nome, elTempo);

  const dica = document.createElement("span");
  dica.className = "barra-chamada-btn";
  dica.setAttribute("aria-hidden", "true");
  dica.innerHTML = `${ICONE_VOLTAR}<span>Voltar</span>`;

  principal.append(indicador, avatar, texto, dica);
  principal.addEventListener("click", () => {
    if (estadoAtual) voltarParaAChamada();
  });

  const btnEncerrar = document.createElement("button");
  btnEncerrar.type = "button";
  btnEncerrar.className = "barra-chamada-btn barra-chamada-btn-encerrar";
  btnEncerrar.setAttribute("aria-label", "Encerrar chamada");
  btnEncerrar.title = "Encerrar chamada";
  btnEncerrar.innerHTML = ICONE_DESLIGAR;
  btnEncerrar.addEventListener("click", () => {
    avisarJanelas({ tipo: "encerrar" });
    esconderBarra();
  });

  barra.append(principal, btnEncerrar);
  barra._avatar = avatar;
  barra._nome = nome;

  document.body.appendChild(barra);
  return barra;
}

function atualizarTempo() {
  if (!estadoAtual || !elTempo) return;

  const status = estadoAtual.status || "";
  if (estadoAtual.conectadaEm && !/reconect/i.test(status)) {
    elTempo.textContent = formatarDuracao(Date.now() - estadoAtual.conectadaEm);
  } else {
    elTempo.textContent = status || "chamando…";
  }
  barra?.classList.toggle("barra-chamada-alerta", /reconect/i.test(status));
}

function mostrarBarra(estado) {
  if (estouNaJanelaDaChamada()) return;
  if (!document.body) return;

  estadoAtual = estado;
  const el = montarBarra();

  el._nome.textContent = estado.nome || `@${estado.comQuem}`;
  definirAvatar(el._avatar, estado.foto);
  el.dataset.tipo = estado.tipo === "audio" ? "audio" : "video";
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

  ouvirJanelas((dados) => {
    if (dados.tipo === "estado" && dados.estado) mostrarBarra(dados.estado);
    if (dados.tipo === "encerrada") esconderBarra();
  });

  // Reserva para navegadores sem BroadcastChannel: o evento "storage" dispara
  // nas outras abas/janelas da mesma origem.
  window.addEventListener("storage", (evento) => {
    if (evento.key === CHAVE_ESTADO) aplicar();
  });

  // Voltar do cache de retorno (bfcache) com a barra desatualizada.
  window.addEventListener("pageshow", (evento) => { if (evento.persisted) aplicar(); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", aplicar, { once: true });
  } else {
    aplicar();
  }
}
