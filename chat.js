import { storage } from "./firebase.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import Core, {
  sessao, urlSegura, definirAvatar, horaCurta, vistoPorUltimo, paraMillis,
  buscarPerfilPorUsername, idDoChat, AVATAR_PADRAO, AVATAR_GRUPO, montarAvatarNav, mostrar
} from "./core.js";
import Radar, { zerarNotificacoes } from "./radar.js";
import { abrirJanelaDeChamada, lerEstadoDaChamada, voltarParaAChamada } from "./chamada-flutuante.js";
import {
  escutarMensagens, escutarChat, enviarMensagem, enviarMensagemNoGrupo, garantirChat,
  obterChat, reagirMensagem, resumo, carregarMensagensAntigas, TAMANHO_PAGINA_HISTORICO,
  marcarRecibos, estadoDoRecibo, quantosLeram, LIMITE_HISTORICO
} from "./mensagens.js";

const params = new URLSearchParams(window.location.search);
const outroUsuario = (params.get("u") || "").toLowerCase().trim();
const grupoDaURL = (params.get("g") || "").trim();
const modoGrupo = !!grupoDaURL;

if (!outroUsuario && !modoGrupo) {
  window.location.replace("inbox.html");
}

const elMensagens = document.getElementById("mensagens");
const elTexto = document.getElementById("texto");
const elNome = document.getElementById("nomeContato");
const elFoto = document.getElementById("fotoContato");
const elStatus = document.getElementById("statusContato");
const elDigitando = document.getElementById("indicador-digitando");
const elRespostaPreview = document.getElementById("respostaPreview");
const elRespostaAutor = document.getElementById("respostaPreviewAutor");
const elRespostaTexto = document.getElementById("respostaPreviewTexto");
const btnCancelarResposta = document.getElementById("btnCancelarResposta");
const elPill = document.querySelector(".input-pill");
const elAnexos = document.getElementById("anexosPendentes");
const elEnvioAndamento = document.getElementById("envioEmAndamento");
const elEnvioAndamentoTexto = document.getElementById("envioEmAndamentoTexto");
const elBarraGravacao = document.getElementById("barraGravacao");
const elTempoGravacao = document.getElementById("tempoGravacao");
const elOndasGravacao = document.getElementById("ondasGravacao");
const elPainelEmojis = document.getElementById("painelEmojis");
const botoesDeEmoji = [...document.querySelectorAll('[data-acao="emojis"]')];

// Mouse como entrada principal? É a mesma regra do chat.css, que troca a
// câmera pelo emoji (à esquerda) e o emoji do fim pelo coração.
const MIDIA_MOUSE = window.matchMedia?.("(hover: hover) and (pointer: fine)");
const ehToque = () => !MIDIA_MOUSE?.matches;

let sessaoAtual = null;
let chatId = null;
let fotoDoContato = AVATAR_PADRAO;
let pararDeEscutar = null;
let pararDeEscutarChat = null;
let idUltimaRenderizada = null;

// Documento do chat (confirmações de entrega/leitura e participantes).
let chatDoc = null;

// Enquanto carregarMaisAntigas() está recolocando a tela na posição de antes,
// atualizarDOM() não deve mexer no scroll — as duas brigando era o que fazia
// a conversa saltar para o fim ao tocar em "carregar mensagens anteriores".
let ancorandoScroll = false;

// Mensagens que chegaram enquanto a pessoa lia o histórico mais acima.
let novasNaoVistas = 0;
let elPilulaNovas = null;

// A animação de entrada da bolha só vale para mensagem que acabou de chegar.
// Aplicada na carga inicial, ela animava as 200 mensagens do histórico de uma
// vez — e voltava a animar toda vez que alguém reagia a uma mensagem antiga.
let cargaInicialFeita = false;

// Estado do que já está desenhado na tela, pro diff de atualizarDOM(): id da
// mensagem -> { elemento, assinatura, agrupada }. "elemento" é o nó de mais
// alto nível já inserido em #mensagens (a .msg-coluna, ou o .msg-wrapper-other
// que a envolve num chat direto), "assinatura" resume o conteúdo renderizado
// (pra saber se precisa redesenhar) e "agrupada" guarda se a mensagem ficou
// colada na de cima (mesma pessoa, pouco tempo depois).
const rendorizadas = new Map();
let ultimoDiaRenderizado = null;

// Agrupamento visual: mensagens da mesma pessoa dentro dessa janela de tempo
// ficam coladas (sem repetir nome, com menos espaço acima) — é a mesma ideia
// do Telegram/WhatsApp.
const JANELA_AGRUPAMENTO = 5 * 60 * 1000; // 5 minutos
let ultimoRemetenteAgrupamento = null;
let ultimoTimestampAgrupamento = 0;

// Paginação do histórico: escutarMensagens() mantém a "janela ao vivo" (as
// LIMITE_HISTORICO mais recentes, em tempo real); carregarMaisAntigas() vai
// empilhando páginas mais antigas na frente dela.
let mensagensAoVivo = [];
let historicoAntigo = [];
let carregandoHistorico = false;
let todoHistoricoCarregado = false;
let elBtnCarregarMais = null;

// Grupo: lista de participantes (todos, incluindo eu) e nomes de exibição
// conhecidos (contato direto ou membros do grupo) — usados nas bolhas e nas
// respostas.
let participantesDoGrupo = [];
let participantesValidos = new Set(); // quem pode gerar eventos "de" válidos pelo WS
const nomesConhecidos = new Map();

function nomeDeExibicao(username) {
  if (sessaoAtual && username === sessaoAtual.username) return "Você";
  return nomesConhecidos.get(username) || username;
}

const ICONE_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';
const ICONE_PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
const REACOES_RAPIDAS = ["❤️", "😂", "😮", "😢", "👍", "🔥"];

// Ícones das confirmações (ficam ao lado do horário, só nas minhas mensagens).
const ICONES_RECIBO = {
  pendente: '<svg class="recibo" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  enviada: '<svg class="recibo" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6l2.9 2.9 6.6-6.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  entregue: '<svg class="recibo recibo-duplo" viewBox="0 0 20 16" aria-hidden="true"><path d="M1.6 8.6l2.9 2.9 6.6-6.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 11.5l.9.9 6.6-6.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
ICONES_RECIBO.lida = ICONES_RECIBO.entregue;
const ROTULOS_RECIBO = { pendente: "Enviando", enviada: "Enviada", entregue: "Entregue", lida: "Vista" };

// ==========================================================================
// RESPONDER A UMA MENSAGEM
// ==========================================================================

let respondendoA = null; // { id, autor, texto, tipo }

function iniciarResposta(msg) {
  respondendoA = { id: msg.id, autor: msg.remetente, texto: msg.texto, tipo: msg.tipo };
  if (elRespostaAutor) elRespostaAutor.textContent = nomeDeExibicao(msg.remetente);
  if (elRespostaTexto) elRespostaTexto.textContent = resumo(msg.tipo, msg.texto);
  if (elRespostaPreview) elRespostaPreview.classList.add("aberta");
  elTexto?.focus();
}

function cancelarResposta() {
  respondendoA = null;
  if (elRespostaPreview) elRespostaPreview.classList.remove("aberta");
}

btnCancelarResposta?.addEventListener("click", cancelarResposta);

// ==========================================================================
// MENU DE AÇÕES DA MENSAGEM (responder / reagir)
// ==========================================================================

let menuMensagemAtual = null;
let overlayMenuMensagem = null;
let bolhaEmDestaque = null;

function fecharMenuDeMensagem() {
  menuMensagemAtual?.remove();
  menuMensagemAtual = null;
  overlayMenuMensagem?.remove();
  overlayMenuMensagem = null;
  bolhaEmDestaque?.classList.remove("msg-em-destaque");
  bolhaEmDestaque = null;
}

async function alternarReacao(msg, emoji) {
  const emojiAtual = msg.reacoes?.[sessaoAtual.user.uid] || null;
  try {
    navigator.vibrate?.(15);
    await reagirMensagem(chatId, msg.id, sessaoAtual.user.uid, emojiAtual, emoji);
  } catch (err) {
    console.error("Erro ao reagir:", err);
    Core.aviso("Não foi possível reagir agora.", "erro");
  }
}

// Momento em que o menu foi aberto. O "pointerup" que encerra o toque longo
// gera um "click" logo em seguida, fora do menu — sem esta trava o menu
// fechava no mesmo instante em que aparecia, em todo celular.
let menuAbertoEm = 0;

function itemDeMenu(texto, icone, acao) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "menu-item";
  btn.setAttribute("role", "menuitem");
  btn.innerHTML = icone; // ícone fixo do app, nunca conteúdo do banco
  const rotulo = document.createElement("span");
  rotulo.textContent = texto;
  btn.appendChild(rotulo);
  btn.addEventListener("click", acao);
  return btn;
}

const ICONE_RESPONDER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>';
const ICONE_COPIAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

function abrirMenuDeMensagem(ponto, msg, elementoBolha) {
  if (msg.tipo === "sistema") return;
  fecharMenuDeMensagem();
  menuAbertoEm = Date.now();

  // Fundo escurecido/borrado atrás do menu — e a bolha escolhida flutua por
  // cima dele (ver .msg-em-destaque no chat.css).
  const overlay = document.createElement("div");
  overlay.className = "menu-mensagem-overlay";
  document.body.appendChild(overlay);
  overlayMenuMensagem = overlay;

  if (elementoBolha) {
    elementoBolha.classList.add("msg-em-destaque");
    bolhaEmDestaque = elementoBolha;
  }

  const menu = document.createElement("div");
  menu.className = "menu-mensagem";
  menu.setAttribute("role", "menu");

  const linhaEmojis = document.createElement("div");
  linhaEmojis.className = "menu-mensagem-emojis";
  const minha = msg.reacoes?.[sessaoAtual.user.uid];
  REACOES_RAPIDAS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = emoji === minha ? "menu-mensagem-emoji selecionado" : "menu-mensagem-emoji";
    btn.textContent = emoji;
    btn.setAttribute("aria-label", `Reagir com ${emoji}`);
    btn.addEventListener("click", () => { fecharMenuDeMensagem(); alternarReacao(msg, emoji); });
    linhaEmojis.appendChild(btn);
  });

  menu.append(linhaEmojis, itemDeMenu("Responder", ICONE_RESPONDER, () => { fecharMenuDeMensagem(); iniciarResposta(msg); }));

  // Copiar: a bolha tem user-select desligado no celular (senão o menu nativo
  // de "Copiar" abre por cima deste), então sem esta opção não havia nenhum
  // jeito de copiar o texto de uma mensagem pelo telefone.
  if (msg.tipo === "texto" || !msg.tipo) {
    menu.appendChild(itemDeMenu("Copiar", ICONE_COPIAR, async () => {
      fecharMenuDeMensagem();
      try {
        await navigator.clipboard.writeText(msg.texto || "");
        Core.aviso("Mensagem copiada.", "sucesso");
      } catch (_) {
        Core.aviso("Não foi possível copiar.", "erro");
      }
    }));
  }
  document.body.appendChild(menu);

  const largura = menu.offsetWidth || 240;
  const altura = menu.offsetHeight || 96;
  const x = ponto ? Math.min(ponto.x, window.innerWidth - largura - 8) : (window.innerWidth - largura) / 2;
  const y = ponto ? Math.min(ponto.y, window.innerHeight - altura - 8) : (window.innerHeight - altura) / 2;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  menuMensagemAtual = menu;
  menu.querySelector("button")?.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  if (!menuMensagemAtual || menuMensagemAtual.contains(e.target)) return;
  // Ignora o clique que o próprio toque longo produz ao soltar o dedo.
  if (Date.now() - menuAbertoEm < 350) return;
  fecharMenuDeMensagem();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharMenuDeMensagem(); });

/**
 * Toque longo (touch) para abrir o menu de ações — tolera um pequeno tremor
 * do dedo (LIMIAR_MOVIMENTO) e dá feedback tátil (a bolha "afunda" e depois
 * vibra) assim que o toque é reconhecido.
 */
function ligarPressaoLonga(elemento, callback) {
  const LIMIAR_MOVIMENTO = 10; // px

  let timer = null;
  let inicio = null;

  const limpar = () => {
    clearTimeout(timer);
    timer = null;
    elemento.classList.remove("pressionando");
  };

  const iniciar = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    inicio = { x: e.clientX, y: e.clientY };
    elemento.classList.add("pressionando");
    timer = setTimeout(() => {
      elemento.classList.remove("pressionando");
      navigator.vibrate?.(25);
      callback(inicio);
    }, 450);
  };

  const mover = (e) => {
    if (!timer || !inicio) return;
    const dx = e.clientX - inicio.x;
    const dy = e.clientY - inicio.y;
    if (Math.hypot(dx, dy) > LIMIAR_MOVIMENTO) limpar();
  };

  elemento.addEventListener("pointerdown", iniciar);
  elemento.addEventListener("pointermove", mover);
  elemento.addEventListener("pointerup", limpar);
  elemento.addEventListener("pointerleave", limpar);
  elemento.addEventListener("pointercancel", limpar);
}

// ==========================================================================
// RENDERIZAÇÃO
// ==========================================================================
// Tudo é montado com createElement/textContent. Nenhum conteúdo vindo do banco
// passa por innerHTML, então texto de mensagem não vira HTML executável.

function montarCitacao(msg) {
  if (!msg.respostaId) return null;

  const citacao = document.createElement("div");
  citacao.className = "msg-citacao";
  citacao.setAttribute("role", "button");
  citacao.tabIndex = 0;

  const autor = document.createElement("strong");
  autor.textContent = nomeDeExibicao(msg.respostaAutor);

  const texto = document.createElement("span");
  texto.textContent = msg.respostaTexto || "";

  citacao.append(autor, texto);

  const irParaOriginal = (e) => {
    e.stopPropagation();
    const alvo = document.getElementById(`msg-${msg.respostaId}`);
    if (!alvo) {
      Core.aviso("A mensagem original está mais acima no histórico.", "info");
      return;
    }
    alvo.scrollIntoView({ behavior: "smooth", block: "center" });
    alvo.classList.add("msg-destacada");
    setTimeout(() => alvo.classList.remove("msg-destacada"), 1200);
  };
  citacao.addEventListener("click", irParaOriginal);
  citacao.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") irParaOriginal(e); });

  return citacao;
}

/** Nome do remetente (só em grupo, e só na primeira de um cluster) e citação
 *  da resposta (se houver), no topo da bolha. */
function prepararCabecalhoDaBolha(bolha, msg, souEu, agrupada) {
  if (modoGrupo && !souEu && !agrupada) {
    const nome = document.createElement("div");
    nome.className = "msg-remetente";
    nome.textContent = nomeDeExibicao(msg.remetente);
    bolha.appendChild(nome);
  }

  const citacao = montarCitacao(msg);
  if (citacao) bolha.appendChild(citacao);
}

function montarChipsDeReacao(msg) {
  const entradas = Object.entries(msg.reacoes || {});
  if (!entradas.length) return null;

  const agrupado = new Map();
  entradas.forEach(([, emoji]) => agrupado.set(emoji, (agrupado.get(emoji) || 0) + 1));

  const linha = document.createElement("div");
  linha.className = "msg-reacoes";

  agrupado.forEach((quantidade, emoji) => {
    const minhaReacao = msg.reacoes?.[sessaoAtual.user.uid] === emoji;

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = minhaReacao ? "reacao-chip reacao-chip-minha" : "reacao-chip";
    chip.textContent = quantidade > 1 ? `${emoji} ${quantidade}` : emoji;
    chip.setAttribute("aria-label", `${emoji} ${quantidade}${minhaReacao ? " (sua reação)" : ""}`);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      alternarReacao(msg, emoji);
    });

    linha.appendChild(chip);
  });

  return linha;
}

// Mensagem só de emoji (até 3) aparece grande e sem balão, como no
// Instagram (™, © e ® sozinhos continuam texto: não são desenhados como
// emoji). As expressões ficam num try: num navegador antigo, sem \p{…}, só o
// efeito deixa de existir — o chat.js inteiro continua carregando.
let RE_SO_EMOJI = null;
let RE_ALGUM_EMOJI = null;
try {
  RE_SO_EMOJI = new RegExp("^(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|[\\u200D\\uFE0F\\u20E3\\s])+$", "u");
  RE_ALGUM_EMOJI = new RegExp("\\p{Emoji_Presentation}|\\uFE0F|\\p{Regional_Indicator}", "u");
} catch (_) { /* sem suporte: nada de emoji grande */ }
const segmentadorDeGrafemas = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter("pt-BR", { granularity: "grapheme" })
  : null;

/** Quantos emojis a mensagem tem, se for SÓ emoji; 0 se tiver outra coisa. */
function quantosEmojisSozinhos(texto) {
  const t = String(texto || "").trim();
  if (!RE_SO_EMOJI || !t || t.length > 40 || !RE_SO_EMOJI.test(t) || !RE_ALGUM_EMOJI.test(t)) return 0;
  const semEspacos = t.replace(/\s+/g, "");
  if (segmentadorDeGrafemas) return [...segmentadorDeGrafemas.segment(semEspacos)].length;
  return Array.from(semEspacos).length; // aproximado: emoji composto conta mais de um
}

function criarBolhaDeTexto(msg, souEu, agrupada) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine" : "msg-bubble msg-other";
  prepararCabecalhoDaBolha(bolha, msg, souEu, agrupada);

  // Numa resposta a citação precisa do balão: aí fica como texto normal.
  const emojis = msg.respostaId ? 0 : quantosEmojisSozinhos(msg.texto);
  if (emojis > 0 && emojis <= 3) {
    bolha.classList.add("msg-so-emoji", emojis === 1 ? "msg-so-emoji-um" : "msg-so-emoji-varios");
  }

  const corpo = document.createElement("span");
  corpo.className = "msg-texto";
  corpo.textContent = msg.texto;
  bolha.appendChild(corpo);

  return bolha;
}

function criarBolhaDeImagem(msg, souEu, agrupada) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine msg-midia" : "msg-bubble msg-other msg-midia";
  prepararCabecalhoDaBolha(bolha, msg, souEu, agrupada);

  const img = document.createElement("img");
  img.src = urlSegura(msg.texto, "");
  img.alt = "Imagem enviada na conversa";
  img.loading = "lazy";
  img.decoding = "async";
  img.className = "msg-imagem";
  img.addEventListener("click", () => abrirImagem(img.src));

  bolha.appendChild(img);
  return bolha;
}

// Visualizador de imagem em tela cheia (antes abria uma aba nova).
function abrirImagem(src) {
  if (!src) return;
  const fundo = document.createElement("div");
  fundo.className = "visualizador-imagem";
  fundo.setAttribute("role", "dialog");
  fundo.setAttribute("aria-label", "Imagem");
  const img = document.createElement("img");
  img.src = src;
  img.alt = "Imagem enviada na conversa";
  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "visualizador-fechar";
  fechar.setAttribute("aria-label", "Fechar imagem");
  fechar.textContent = "×";
  const abrirOriginal = document.createElement("a");
  abrirOriginal.className = "visualizador-original";
  abrirOriginal.href = src;
  abrirOriginal.target = "_blank";
  abrirOriginal.rel = "noopener";
  abrirOriginal.textContent = "Abrir original";
  fundo.append(img, fechar, abrirOriginal);
  document.body.appendChild(fundo);
  requestAnimationFrame(() => fundo.classList.add("aberto"));

  const sair = () => {
    fundo.classList.remove("aberto");
    setTimeout(() => fundo.remove(), 200);
    document.removeEventListener("keydown", aoTeclar);
  };
  const aoTeclar = (e) => { if (e.key === "Escape") sair(); };
  fundo.addEventListener("click", (e) => { if (e.target === fundo || e.target === img) sair(); });
  fechar.addEventListener("click", sair);
  document.addEventListener("keydown", aoTeclar);
  fechar.focus();
}

function criarBolhaDeAudio(msg, souEu, agrupada) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine msg-bolha-audio" : "msg-bubble msg-other msg-bolha-audio";
  prepararCabecalhoDaBolha(bolha, msg, souEu, agrupada);

  const player = document.createElement("div");
  player.className = "custom-audio-player";

  const audio = document.createElement("audio");
  audio.src = urlSegura(msg.texto, "");
  audio.preload = "metadata";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "audio-play-btn";
  btn.setAttribute("aria-label", "Reproduzir mensagem de voz");
  btn.innerHTML = ICONE_PLAY;

  const barra = document.createElement("div");
  barra.className = "audio-wave-container";
  const progresso = document.createElement("div");
  progresso.className = "audio-progress-bar";
  barra.appendChild(progresso);

  const duracao = document.createElement("span");
  duracao.className = "audio-duration";
  duracao.textContent = "0:00";

  const formatar = (s) => {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const seg = Math.floor(s % 60);
    return `${m}:${String(seg).padStart(2, "0")}`;
  };

  const mostrarPlay = () => {
    btn.innerHTML = ICONE_PLAY;
    btn.setAttribute("aria-label", "Reproduzir mensagem de voz");
  };
  const mostrarPause = () => {
    btn.innerHTML = ICONE_PAUSE;
    btn.setAttribute("aria-label", "Pausar mensagem de voz");
  };

  audio.addEventListener("loadedmetadata", () => { duracao.textContent = formatar(audio.duration); });
  audio.addEventListener("timeupdate", () => {
    if (audio.duration) progresso.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    duracao.textContent = formatar(audio.duration - audio.currentTime);
  });

  // O ícone acompanha o estado real do elemento, e não só o clique no botão.
  audio.addEventListener("play", mostrarPause);
  audio.addEventListener("pause", mostrarPlay);
  audio.addEventListener("ended", () => {
    mostrarPlay();
    progresso.style.width = "0%";
    duracao.textContent = formatar(audio.duration);
  });

  btn.addEventListener("click", () => {
    if (audio.paused) {
      // Pausa qualquer outro áudio tocando na conversa.
      elMensagens.querySelectorAll("audio").forEach((a) => { if (a !== audio) a.pause(); });
      audio.play().catch(() => Core.aviso("Não foi possível reproduzir o áudio.", "erro"));
    } else {
      audio.pause();
    }
  });

  // Tocar na barra pula para aquele ponto do áudio.
  barra.addEventListener("click", (e) => {
    if (!audio.duration) return;
    const caixa = barra.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - caixa.left) / caixa.width)) * audio.duration;
  });

  player.append(btn, barra, duracao, audio);
  bolha.appendChild(player);
  return bolha;
}

function criarMensagemDeSistema(msg) {
  const linha = document.createElement("div");
  linha.className = "msg-sistema";
  linha.id = `msg-${msg.id}`;
  linha.textContent = msg.texto;
  const hora = horaCurta(msg.timestampMs);
  if (hora) {
    const h = document.createElement("span");
    h.className = "msg-sistema-hora";
    h.textContent = hora;
    linha.appendChild(h);
  }
  return linha;
}

/** Estado da confirmação de uma mensagem minha. */
function reciboDe(msg) {
  if (msg.pendente) return "pendente";
  return estadoDoRecibo(msg.timestampMs, chatDoc, sessaoAtual.user.uid);
}

function montarHorario(msg, souEu) {
  const hora = document.createElement("span");
  hora.className = "msg-time";

  const texto = document.createElement("span");
  texto.textContent = horaCurta(msg.timestampMs) || "agora";
  hora.appendChild(texto);

  if (souEu) {
    const estado = reciboDe(msg);
    const icone = document.createElement("span");
    icone.className = `msg-recibo recibo-${estado}`;
    icone.innerHTML = ICONES_RECIBO[estado];
    icone.setAttribute("role", "img");
    icone.setAttribute("aria-label", ROTULOS_RECIBO[estado]);
    icone.title = ROTULOS_RECIBO[estado];
    hora.appendChild(icone);
  }
  return hora;
}

function renderizarMensagem(msg, souEu, agrupada = false, animar = false) {
  if (msg.tipo === "sistema") return criarMensagemDeSistema(msg);

  let bolha;
  if (msg.tipo === "audio") bolha = criarBolhaDeAudio(msg, souEu, agrupada);
  else if (msg.tipo === "imagem") bolha = criarBolhaDeImagem(msg, souEu, agrupada);
  else bolha = criarBolhaDeTexto(msg, souEu, agrupada);

  if (animar) bolha.classList.add("msg-nova");
  bolha.appendChild(montarHorario(msg, souEu));

  // Responder e reagir: toque longo (touch) ou clique direito (mouse).
  bolha.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    abrirMenuDeMensagem({ x: e.clientX, y: e.clientY }, msg, bolha);
  });
  ligarPressaoLonga(bolha, (ponto) => abrirMenuDeMensagem(ponto, msg, bolha));

  const coluna = document.createElement("div");
  coluna.id = `msg-${msg.id}`;
  coluna.className = souEu ? "msg-coluna msg-coluna-minha" : "msg-coluna msg-coluna-outro";
  if (agrupada) coluna.classList.add("msg-agrupada");
  coluna.appendChild(bolha);

  const chips = montarChipsDeReacao(msg);
  if (chips) coluna.appendChild(chips);

  if (souEu || modoGrupo) return coluna;

  // Chat direto, mensagem do contato: acompanha o avatar — só na última de
  // cada sequência, como nos mensageiros conhecidos (a coluna de avatares
  // repetidos poluía a conversa).
  const wrapper = document.createElement("div");
  wrapper.className = "msg-wrapper-other";
  if (agrupada) wrapper.classList.add("msg-agrupada");

  const avatar = document.createElement("img");
  avatar.alt = "";
  avatar.loading = "lazy";
  definirAvatar(avatar, fotoDoContato);

  wrapper.append(avatar, coluna);
  return wrapper;
}

function separadorDeData(ms) {
  const div = document.createElement("div");
  div.className = "msg-separador";
  div.setAttribute("role", "separator");

  const hoje = new Date();
  const data = new Date(ms);
  const mesmoDia = (a, b) => a.toDateString() === b.toDateString();

  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);

  if (mesmoDia(data, hoje)) div.textContent = "Hoje";
  else if (mesmoDia(data, ontem)) div.textContent = "Ontem";
  else if (data.getFullYear() === hoje.getFullYear()) div.textContent = data.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
  else div.textContent = data.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

  return div;
}

// Assinatura barata do que foi desenhado pra uma mensagem — usada só pra
// decidir se ela precisa ser redesenhada (mudou reação, citação, confirmação
// de entrega/leitura...), sem comparar DOM.
function assinaturaDe(msg) {
  const souEu = sessaoAtual && msg.remetenteUid === sessaoAtual.user.uid;
  return JSON.stringify([
    msg.texto, msg.tipo, msg.pendente, msg.timestampMs,
    msg.reacoes, msg.respostaId, msg.respostaTexto,
    souEu && msg.tipo !== "sistema" ? reciboDe(msg) : null,
  ]);
}

/** Insere um nó logo antes do indicador de "digitando", que fica sempre por
 *  último em #mensagens (ver mostrarDigitando/atualizarDOM). */
function inserirAntesDoIndicador(no) {
  if (elDigitando?.parentElement === elMensagens) {
    elMensagens.insertBefore(no, elDigitando);
  } else {
    elMensagens.appendChild(no);
  }
}

function inserirMensagem(msg) {
  const ms = msg.timestampMs || Date.now();
  const dia = new Date(ms).toDateString();
  if (dia !== ultimoDiaRenderizado) {
    inserirAntesDoIndicador(separadorDeData(ms));
    ultimoDiaRenderizado = dia;
    ultimoRemetenteAgrupamento = null; // novo dia nunca "cola" com o anterior
  }

  const agrupada = msg.tipo !== "sistema" && !!(
    ultimoRemetenteAgrupamento === msg.remetenteUid &&
    ms - ultimoTimestampAgrupamento < JANELA_AGRUPAMENTO
  );

  const souEu = msg.remetenteUid === sessaoAtual.user.uid;
  const no = renderizarMensagem(msg, souEu, agrupada, cargaInicialFeita);
  inserirAntesDoIndicador(no);
  rendorizadas.set(msg.id, { elemento: no, assinatura: assinaturaDe(msg), agrupada });

  // Uma mensagem de sistema (ex.: "chamada perdida") sempre quebra o
  // agrupamento — a próxima mensagem real começa um cluster novo.
  if (msg.tipo === "sistema") {
    ultimoRemetenteAgrupamento = null;
  } else {
    ultimoRemetenteAgrupamento = msg.remetenteUid;
    ultimoTimestampAgrupamento = ms;
  }
}

// ==========================================================================
// ROLAGEM
// ==========================================================================

function estaNoFim() {
  return elMensagens.scrollHeight - elMensagens.scrollTop - elMensagens.clientHeight < 120;
}

function irParaOFim(suave = false) {
  if (suave && typeof elMensagens.scrollTo === "function") {
    elMensagens.scrollTo({ top: elMensagens.scrollHeight, behavior: "smooth" });
  } else {
    elMensagens.scrollTop = elMensagens.scrollHeight;
  }
  esconderPilulaDeNovas();
}

/**
 * Botão flutuante "novas mensagens". Antes, qualquer mensagem que chegasse
 * arrastava a tela para o fim à força — mesmo com a pessoa lendo o histórico
 * lá em cima, que é exatamente quando isso mais atrapalha.
 */
function pilulaDeNovas() {
  if (elPilulaNovas) return elPilulaNovas;

  const area = document.querySelector(".chat-input-area");
  if (!area) return null;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "btnNovasMensagens";
  btn.className = "btn-novas-mensagens";
  btn.addEventListener("click", () => irParaOFim(true));
  area.appendChild(btn);

  elPilulaNovas = btn;
  return btn;
}

function mostrarPilulaDeNovas() {
  const btn = pilulaDeNovas();
  if (!btn) return;
  btn.textContent = novasNaoVistas > 1
    ? `${novasNaoVistas} novas mensagens ↓`
    : "Nova mensagem ↓";
  btn.classList.add("visivel");
}

function esconderPilulaDeNovas() {
  novasNaoVistas = 0;
  elPilulaNovas?.classList.remove("visivel");
}

/** Cria (uma vez) o botão "carregar mensagens anteriores" do topo. */
function elementoCarregarMais() {
  if (elBtnCarregarMais) return elBtnCarregarMais;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "btnCarregarMaisAntigas";
  btn.className = "btn-carregar-mais";
  btn.textContent = "Carregar mensagens anteriores";
  btn.addEventListener("click", carregarMaisAntigas);

  elBtnCarregarMais = btn;
  return btn;
}

function atualizarBotaoCarregarMais() {
  if (!elBtnCarregarMais) return;
  // Com menos mensagens do que cabem na janela ao vivo, a conversa inteira
  // já está na tela: o botão só aparece quando pode haver mais.
  const podeTerMais = mensagensAoVivo.length >= LIMITE_HISTORICO || historicoAntigo.length > 0;
  if (todoHistoricoCarregado || !podeTerMais) {
    mostrar(elBtnCarregarMais, false);
    return;
  }
  mostrar(elBtnCarregarMais, true);
  elBtnCarregarMais.disabled = carregandoHistorico;
  elBtnCarregarMais.textContent = carregandoHistorico
    ? "Carregando…"
    : "Carregar mensagens anteriores";
}

/** Primeira conversa (ainda sem mensagens): um convite em vez do vazio. */
function atualizarEstadoVazio(mensagens) {
  let vazio = document.getElementById("conversaVazia");
  if (mensagens.length) {
    vazio?.remove();
    return;
  }
  if (vazio) return;
  vazio = document.createElement("div");
  vazio.id = "conversaVazia";
  vazio.className = "conversa-vazia";
  const img = document.createElement("img");
  img.alt = "";
  definirAvatar(img, modoGrupo ? AVATAR_GRUPO : fotoDoContato);
  const titulo = document.createElement("strong");
  titulo.textContent = modoGrupo ? (elNome?.textContent || "Grupo") : (nomesConhecidos.get(outroUsuario) || `@${outroUsuario}`);
  const texto = document.createElement("span");
  texto.textContent = modoGrupo ? "O grupo foi criado. Diga oi para todo mundo!" : "Nenhuma mensagem ainda. Que tal começar com um oi?";
  vazio.append(img, titulo, texto);
  inserirAntesDoIndicador(vazio);
}

/** Reconstrói tudo do zero — usada na primeira carga do chat e sempre que o
 *  diff incremental não dá pra aplicar com segurança (ver atualizarDOM). */
function reconstruirTudo(mensagens) {
  elMensagens.replaceChildren();
  rendorizadas.clear();
  ultimoDiaRenderizado = null;
  ultimoRemetenteAgrupamento = null;
  ultimoTimestampAgrupamento = 0;

  elMensagens.appendChild(elementoCarregarMais());
  atualizarBotaoCarregarMais();

  // Reconstrução inteira (primeira carga, ou histórico antigo entrando no
  // topo) nunca anima: seriam dezenas de bolhas pulando na tela de uma vez.
  const animavaAntes = cargaInicialFeita;
  cargaInicialFeita = false;
  mensagens.forEach(inserirMensagem);
  cargaInicialFeita = animavaAntes;

  if (elDigitando) elMensagens.appendChild(elDigitando);
}

/** Junta o histórico paginado (estático) com a janela ao vivo, remove
 *  duplicata na emenda e redesenha. */
function redesenharComHistorico() {
  const idsAoVivo = new Set(mensagensAoVivo.map((m) => m.id));
  const combinadas = [
    ...historicoAntigo.filter((m) => !idsAoVivo.has(m.id)),
    ...mensagensAoVivo,
  ];
  atualizarDOM(combinadas);
}

async function carregarMaisAntigas() {
  if (carregandoHistorico || todoHistoricoCarregado || !chatId) return;
  if (mensagensAoVivo.length < LIMITE_HISTORICO && !historicoAntigo.length) return;

  const maisAntigaCarregada = historicoAntigo[0] || mensagensAoVivo[0];
  if (!maisAntigaCarregada) return;

  carregandoHistorico = true;
  atualizarBotaoCarregarMais();

  try {
    const pagina = await carregarMensagensAntigas(
      chatId,
      maisAntigaCarregada.timestampMs,
      TAMANHO_PAGINA_HISTORICO
    );

    if (pagina.length < TAMANHO_PAGINA_HISTORICO) todoHistoricoCarregado = true;
    if (!pagina.length) return;

    const alturaAntes = elMensagens.scrollHeight;
    const topoAntes = elMensagens.scrollTop;

    historicoAntigo = [...pagina, ...historicoAntigo];

    // A bandeira impede que atualizarDOM() mande a tela para o fim no meio
    // desta operação.
    ancorandoScroll = true;
    redesenharComHistorico();
    ancorandoScroll = false;

    // Mantém o trecho que a pessoa estava olhando na mesma posição visual.
    elMensagens.scrollTop = topoAntes + (elMensagens.scrollHeight - alturaAntes);
  } catch (err) {
    console.error("Erro ao carregar mensagens antigas:", err);
    Core.aviso("Não foi possível carregar mensagens antigas.", "erro");
  } finally {
    carregandoHistorico = false;
    atualizarBotaoCarregarMais();
  }
}

/**
 * Redesenha a lista de mensagens SEM reconstruir o DOM inteiro a cada
 * atualização do Firestore.
 *
 * Caminho rápido (o caso de longe mais comum): a lista antiga continua sendo
 * um prefixo exato da nova — nada sumiu nem mudou de posição, só pode ter
 * (a) conteúdo de mensagens existentes mudado (reação, confirmação) e/ou
 * (b) mensagens novas no fim. Fora desse caso cai no reconstruirTudo().
 */
function atualizarDOM(mensagens) {
  const estavaNoFim = estaNoFim();

  const idsAntigos = [...rendorizadas.keys()];
  const prefixoIgual =
    idsAntigos.length > 0 && idsAntigos.every((id, i) => mensagens[i]?.id === id);

  if (!prefixoIgual) {
    reconstruirTudo(mensagens);
  } else {
    mensagens.slice(0, idsAntigos.length).forEach((msg) => {
      const registro = rendorizadas.get(msg.id);
      const assinatura = assinaturaDe(msg);
      if (registro.assinatura === assinatura) return;

      const souEu = msg.remetenteUid === sessaoAtual.user.uid;
      // Redesenho de uma mensagem que já estava na tela: nunca anima de novo.
      const novoNo = renderizarMensagem(msg, souEu, registro.agrupada, false);
      registro.elemento.replaceWith(novoNo);
      rendorizadas.set(msg.id, { elemento: novoNo, assinatura, agrupada: registro.agrupada });
    });

    mensagens.slice(idsAntigos.length).forEach(inserirMensagem);
    const idsNovos = new Set(mensagens.map((m) => m.id));
    idsAntigos.forEach((id) => {
      if (idsNovos.has(id)) return;
      rendorizadas.get(id)?.elemento.remove();
      rendorizadas.delete(id);
    });

    if (elDigitando) elMensagens.appendChild(elDigitando);
  }

  atualizarBotaoCarregarMais();
  atualizarEstadoVazio(mensagens);
  atualizarRotuloDeLeitura(mensagens);

  const ultima = mensagens[mensagens.length - 1];
  // Comparar por ID, e não por timestamp: mensagem ainda não confirmada pelo
  // servidor tem timestamp estimado.
  const chegouCoisaNova = !!ultima && ultima.id !== idUltimaRenderizada;
  const ultimaEhMinha = !!ultima && ultima.remetenteUid === sessaoAtual.user.uid;
  if (ultima) idUltimaRenderizada = ultima.id;

  cargaInicialFeita = true;

  if (ancorandoScroll) {
    // carregarMaisAntigas() está cuidando da posição.
  } else if (estavaNoFim || (chegouCoisaNova && ultimaEhMinha)) {
    irParaOFim();
  } else if (chegouCoisaNova) {
    novasNaoVistas++;
    mostrarPilulaDeNovas();
  }

  marcarComoLido();
  agendarConfirmacao();
}

// Rótulo embaixo da última mensagem MINHA, quando ela é a última da conversa:
// "Enviada", "Entregue", "Vista" (ou "Vista por 2" num grupo) — como nos
// mensageiros conhecidos, para ninguém precisar decifrar os tracinhos.
let elRotuloLeitura = null;

function atualizarRotuloDeLeitura(mensagens) {
  const ultima = mensagens[mensagens.length - 1];
  const minha = ultima && ultima.tipo !== "sistema" && ultima.remetenteUid === sessaoAtual.user.uid;
  const coluna = minha ? document.getElementById(`msg-${ultima.id}`) : null;

  if (!coluna) {
    elRotuloLeitura?.remove();
    return;
  }
  if (!elRotuloLeitura) {
    elRotuloLeitura = document.createElement("div");
    elRotuloLeitura.className = "msg-status-leitura";
    elRotuloLeitura.setAttribute("aria-live", "polite");
  }

  const estado = reciboDe(ultima);
  let texto = ROTULOS_RECIBO[estado];
  if (estado === "pendente") texto = "Enviando…";
  if (modoGrupo && estado === "lida") texto = "Vista por todos";
  if (modoGrupo && estado !== "lida" && estado !== "pendente") {
    const leram = quantosLeram(ultima.timestampMs, chatDoc, sessaoAtual.user.uid);
    if (leram > 0) texto = `Vista por ${leram}`;
  }
  elRotuloLeitura.textContent = texto;
  elRotuloLeitura.dataset.estado = estado;
  if (elRotuloLeitura.parentElement !== coluna) coluna.appendChild(elRotuloLeitura);
}

function marcarComoLido() {
  if (!chatId) return;
  try {
    localStorage.setItem(`last_read_${chatId}`, String(Date.now()));
  } catch (_) {}

  // O contador do ícone de mensagens só era zerado na caixa de entrada: quem
  // entrava direto numa conversa pela notificação ficava com o número preso.
  zerarNotificacoes();
}

// ==========================================================================
// CONFIRMAÇÕES DE ENTREGA E LEITURA
// ==========================================================================
// "Vista" só quando a pessoa pode estar vendo de verdade: aba visível, com
// foco, e a conversa rolada até o fim. Fora disso a mensagem conta só como
// entregue (chegou ao aparelho).

let timerConfirmacao = null;

function agendarConfirmacao() {
  clearTimeout(timerConfirmacao);
  timerConfirmacao = setTimeout(confirmarRecebimento, 250);
}

function ultimaDosOutros() {
  for (let i = mensagensAoVivo.length - 1; i >= 0; i--) {
    const m = mensagensAoVivo[i];
    if (m.remetenteUid !== sessaoAtual.user.uid && !m.pendente && m.timestamp) return m;
  }
  return null;
}

function podeEstarVendo() {
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  return estaNoFim();
}

function confirmarRecebimento() {
  if (!chatId || !sessaoAtual || !chatDoc) return;
  const ultima = ultimaDosOutros();
  if (!ultima) return;
  if (podeEstarVendo()) marcarRecibos(sessaoAtual, chatId, chatDoc, { lidoAte: ultima.timestamp });
  else marcarRecibos(sessaoAtual, chatId, chatDoc, { entregueAte: ultima.timestamp });
}

window.addEventListener("focus", agendarConfirmacao);

// ==========================================================================
// STATUS DO CONTATO (ONLINE / VISTO POR ÚLTIMO) — só em chat direto
// ==========================================================================
// O texto do cabeçalho tem duas fontes: a presença e o "digitando…", que tem
// prioridade enquanto dura. A presença é um estado (e não um texto): o
// "visto por último há 5 min" é recalculado sozinho a cada 30 segundos.

let presenca = { tipo: "desconhecida" }; // | { tipo: "online" } | { tipo: "offline", lastSeen }
let timerStatus = null;
let timerConectando = null;
let conectandoAoServidor = false;

function textoDaPresenca() {
  if (conectandoAoServidor) return "conectando…";
  if (presenca.tipo === "online") return "Online";
  if (presenca.tipo === "offline") return vistoPorUltimo(presenca.lastSeen) || "offline";
  // Ainda sem resposta: um espaço segura a altura do cabeçalho (o nome não
  // pula quando o status chega).
  return "\u00a0";
}

function aplicarStatusDoCabecalho() {
  if (!elStatus || modoGrupo) return;
  const digitando = digitandoAte && Date.now() < digitandoAte;
  elStatus.classList.toggle("status-digitando", !!digitando);
  elStatus.classList.toggle("status-online", !digitando && presenca.tipo === "online" && !conectandoAoServidor);
  elStatus.classList.toggle("status-conectando", !digitando && conectandoAoServidor);
  elStatus.textContent = digitando ? "digitando…" : textoDaPresenca();
}

function mostrarOnline() {
  clearTimeout(timerStatus);
  presenca = { tipo: "online" };
  aplicarStatusDoCabecalho();
}

async function mostrarOffline(lastSeenDoServidor) {
  clearTimeout(timerStatus);

  let lastSeen = lastSeenDoServidor;
  if (!lastSeen) {
    // Servidor antigo (ou dormindo): cai para o valor gravado no perfil.
    try {
      const perfil = await buscarPerfilPorUsername(outroUsuario);
      lastSeen = paraMillis(perfil?.lastSeen) || 0;
    } catch (_) {}
  }

  // Uma resposta "online" pode ter chegado durante a leitura acima.
  if (presenca.tipo === "online" && !lastSeenDoServidor) return;
  presenca = { tipo: "offline", lastSeen };
  aplicarStatusDoCabecalho();
}

function pedirStatus() {
  if (modoGrupo) return;
  aplicarStatusDoCabecalho();
  Radar.verificarStatus(outroUsuario);

  // Se o backend estiver dormindo (plano gratuito do Render), não deixamos a
  // tela presa sem status: mostra o último "visto" gravado no perfil.
  clearTimeout(timerStatus);
  timerStatus = setTimeout(() => { if (presenca.tipo !== "online") mostrarOffline(); }, 5000);
}

// "visto por último há 5 min" envelhece sozinho.
setInterval(() => {
  if (document.visibilityState === "visible" && presenca.tipo === "offline") aplicarStatusDoCabecalho();
}, 30000);

window.addEventListener("mensagem_servidor", (e) => {
  const msg = e.detail;
  if (!msg || !participantesValidos.has(msg.from)) return;

  if (msg.type === "status_reply" || msg.type === "status_update") {
    if (modoGrupo) return; // presença individual não se aplica a grupos
    if (msg.content === "online") {
      mostrarOnline();
    } else {
      // Saiu do app: não há mais como estar digitando.
      pararDeMostrarDigitando();
      mostrarOffline(msg.lastSeen);
    }
    return;
  }

  if (msg.type === "chat") {
    // Só a mensagem DESTA conversa encerra o "digitando…": um aviso de
    // mensagem num grupo em comum não diz nada sobre esta conversa.
    const deOutroChat = msg.payload?.chatId && msg.payload.chatId !== chatId;
    if (!deOutroChat) pararDeMostrarDigitando();
    // A mensagem em si chega pelo Firestore; aqui só reagimos ao sinal.
    if (!modoGrupo) mostrarOnline();
    return;
  }

  if (msg.type === "digitando" || msg.type === "parou_digitando") {
    // O app não anuncia digitação em grupo (ver aoDigitar). Logo, um
    // "digitando" que chega enquanto você olha um GRUPO veio de uma conversa
    // privada com essa pessoa: acender a bolha do grupo seria inventar
    // informação.
    if (modoGrupo) return;
    // Clientes novos dizem de qual conversa é o aviso.
    if (msg.payload?.chatId && msg.payload.chatId !== chatId) return;

    if (msg.type === "digitando") receberDigitando();
    else pararDeMostrarDigitando();
  }
});

// Ao (re)conectar, pergunta o status de novo — inclusive depois de o servidor
// gratuito acordar.
window.addEventListener("radar_conectado", () => {
  clearTimeout(timerConectando);
  conectandoAoServidor = false;
  if (!modoGrupo) pedirStatus();
  // O que eu estava anunciando se perdeu com a conexão antiga.
  anunciandoDigitacao = false;
  ultimoAvisoDigitando = 0;
});

// O indicador some por TEMPO DE RELÓGIO, e não por um setTimeout solto: o
// navegador congela os timers de uma aba em segundo plano ou no cache de
// retorno, e um setTimeout de 2,5 s podia nunca disparar — o "digitando..."
// ficava colado na tela por tempo indeterminado.
const VALIDADE_DIGITANDO = 3000;
let digitandoAte = 0;
let vigiaDigitando = null;

function receberDigitando() {
  // Receber este aviso já prova que a pessoa está conectada agora.
  if (!modoGrupo) presenca = { tipo: "online" };

  digitandoAte = Date.now() + VALIDADE_DIGITANDO;
  mostrarDigitando();
  if (!vigiaDigitando) vigiaDigitando = setInterval(conferirDigitando, 700);
}

function conferirDigitando() {
  if (digitandoAte && Date.now() < digitandoAte) return;
  pararDeMostrarDigitando();
}

function pararDeMostrarDigitando() {
  digitandoAte = 0;
  clearInterval(vigiaDigitando);
  vigiaDigitando = null;
  esconderDigitando();
  aplicarStatusDoCabecalho();
}

function mostrarDigitando() {
  if (!elDigitando) return;

  // O cabeçalho dizer "digitando…" deixa claro de quem é e o que está
  // acontecendo — é o mesmo padrão do WhatsApp.
  aplicarStatusDoCabecalho();

  const acompanhando = estaNoFim();
  mostrar(elDigitando, true);
  elMensagens.appendChild(elDigitando);
  // Só acompanha se a pessoa já estava no fim — senão o indicador puxava a
  // tela para baixo no meio da leitura do histórico.
  if (acompanhando) elMensagens.scrollTop = elMensagens.scrollHeight;
}

function esconderDigitando() {
  mostrar(elDigitando, false);
}

// Voltar para o app confere na hora se aquele "digitando..." ainda vale, sem
// depender de nenhum timer que possa ter sido congelado.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    conferirDigitando();
    aplicarStatusDoCabecalho();
    agendarConfirmacao();
  } else {
    // Saí da aba no meio de uma frase: paro de anunciar na hora, em vez de a
    // outra ponta esperar o relógio correr.
    avisarQueParei();
  }
});

// Sem conexão não há como saber se a pessoa ainda está digitando. Manter o
// indicador aceso seria inventar uma informação que não temos. Se a queda
// durar, o cabeçalho avisa que estamos reconectando.
window.addEventListener("radar_desconectado", () => {
  pararDeMostrarDigitando();
  anunciandoDigitacao = false;
  ultimoAvisoDigitando = 0;
  clearTimeout(timerConectando);
  timerConectando = setTimeout(() => {
    if (Radar.estado === "conectado") return;
    conectandoAoServidor = true;
    aplicarStatusDoCabecalho();
  }, 4000);
});

// ==========================================================================
// ENVIO
// ==========================================================================

let ultimoAvisoDigitando = 0;
let anunciandoDigitacao = false;
let timerReanuncioDigitando = null;
// O servidor repassa no máximo um "digitando" a cada 700 ms (hub.go).
const INTERVALO_DIGITANDO_SERVIDOR = 700;

// Estado da barra de envio (aqui em cima porque atualizarBotoesDeEnvio,
// logo abaixo, depende dele).
let gravacaoAtual = null;  // { gravador, inicio, fim, descartar } enquanto grava
let anexosPendentes = [];  // [{ arquivo, url, el }]: imagens coladas ou arrastadas

/**
 * O campo cresce junto com o texto (até um teto), como em qualquer mensageiro.
 */
const ALTURA_MINIMA_CAMPO = 40;
const ALTURA_MAXIMA_CAMPO = 120;

function ajustarAlturaDoCampo() {
  if (!elTexto) return;
  elTexto.style.height = "auto";
  const altura = Math.min(
    Math.max(elTexto.scrollHeight, ALTURA_MINIMA_CAMPO),
    ALTURA_MAXIMA_CAMPO
  );
  elTexto.style.height = `${altura}px`;
  elTexto.style.overflowY = elTexto.scrollHeight > ALTURA_MAXIMA_CAMPO ? "auto" : "hidden";
}

// O campo muda de largura quando os ícones da direita saem ou voltam (com
// animação) e quando a janela muda de tamanho; a altura é refeita junto.
// Sem isto, colar uma frase inteira media o campo ainda estreito e ele
// ficava com uma linha sobrando até a próxima tecla.
let larguraDoCampo = 0;
if (elTexto && "ResizeObserver" in window) {
  new ResizeObserver((entradas) => {
    const largura = Math.round(entradas[0]?.contentRect.width || 0);
    if (!largura || largura === larguraDoCampo) return;
    larguraDoCampo = largura;
    requestAnimationFrame(ajustarAlturaDoCampo);
  }).observe(elTexto);
}

function aoDigitar(evento) {
  atualizarBotoesDeEnvio();
  ajustarAlturaDoCampo();

  // Em grupo, um evento "digitando" viraria N mensagens WebSocket (uma por
  // participante) a cada tecla — melhor não anunciar do que arriscar o
  // limite de taxa da conexão.
  if (modoGrupo || !chatId) return;

  // Só digitação de verdade anuncia: um "input" disparado por script (uma
  // extensão do navegador, por exemplo) não é a pessoa digitando.
  if (evento && evento.isTrusted === false) return;

  // Apagar tudo é o contrário de estar digitando.
  if (!elTexto.value.trim()) {
    avisarQueParei();
    return;
  }

  if (document.visibilityState !== "visible") return;

  // No máximo um aviso por segundo, em vez de um a cada tecla.
  const agora = Date.now();
  if (agora - ultimoAvisoDigitando > 1000) {
    ultimoAvisoDigitando = agora;
    if (Radar.emit({ type: "digitando", to: outroUsuario, payload: { chatId } })) anunciandoDigitacao = true;
  }
}

/** Avisa a outra ponta que parei de digitar — só se eu tinha avisado antes. */
function avisarQueParei() {
  if (modoGrupo || !anunciandoDigitacao) return;
  anunciandoDigitacao = false;
  ultimoAvisoDigitando = 0;
  Radar.emit({ type: "parou_digitando", to: outroUsuario, payload: { chatId } });
}

/** Com texto, áudio gravando ou imagem anexada, os ícones dão lugar ao enviar. */
function atualizarBotoesDeEnvio() {
  const temTexto = elTexto.value.trim().length > 0;
  const gravando = estaGravando();
  const mostrarEnviar = temTexto || gravando || anexosPendentes.length > 0;
  const acoes = document.getElementById("action-buttons");
  const btnEnviar = document.getElementById("btnEnviar");
  acoes?.classList.toggle("oculto", mostrarEnviar);
  btnEnviar?.classList.toggle("mostrar", mostrarEnviar);

  const rotulo = gravando ? "Enviar áudio" : (!temTexto && anexosPendentes.length ? "Enviar imagem" : "Enviar mensagem");
  btnEnviar?.setAttribute("aria-label", rotulo);
  btnEnviar?.setAttribute("title", gravando ? "Enviar áudio" : "Enviar");
}

/** Envia texto (do campo, se conteudo for null) ou mídia. Devolve se deu certo. */
async function enviar(conteudo = null, tipo = "texto") {
  const texto = conteudo ?? elTexto.value.trim();
  if (!texto || !sessaoAtual || !chatId) return false;

  // Mídia (áudio/imagem) não carrega o contexto de resposta — só texto.
  const respostaEnviada = conteudo === null ? respondendoA : null;

  if (conteudo === null) {
    elTexto.value = "";
    atualizarBotoesDeEnvio();
    ajustarAlturaDoCampo();
    cancelarResposta();
    avisarQueParei();
  }

  try {
    const opcoes = { texto, tipo, respondendoA: respostaEnviada };
    if (modoGrupo) await enviarMensagemNoGrupo(sessaoAtual, chatId, opcoes);
    else await enviarMensagem(sessaoAtual, outroUsuario, opcoes);

    // O WebSocket serve para notificar na hora; o que aparece na tela vem do
    // Firestore. Em grupo, avisamos cada participante individualmente.
    const outrosParticipantes = modoGrupo
      ? participantesDoGrupo.filter((u) => u !== sessaoAtual.username)
      : [outroUsuario];

    outrosParticipantes.forEach((usuario) => {
      Radar.emit({ type: "chat", to: usuario, content: resumo(tipo, texto).slice(0, 120), payload: { chatId } });
    });

    // Quem já começou a próxima mensagem continua "digitando" do outro lado:
    // o aviso "chat" desta aqui apaga o indicador lá e pode chegar depois do
    // "digitando" da seguinte (o envio espera a gravação no banco). O aviso
    // repetido espera a janela do servidor, que descartaria um "digitando"
    // colado no anterior.
    if (!modoGrupo && anunciandoDigitacao && elTexto.value.trim()) {
      const espera = Math.max(0, INTERVALO_DIGITANDO_SERVIDOR + 50 - (Date.now() - ultimoAvisoDigitando));
      clearTimeout(timerReanuncioDigitando);
      timerReanuncioDigitando = setTimeout(() => {
        if (!anunciandoDigitacao || !elTexto.value.trim()) return;
        ultimoAvisoDigitando = 0;
        aoDigitar();
      }, espera);
    }
    return true;
  } catch (err) {
    console.error("Falha ao enviar:", err);
    Core.aviso(err.code === "permission-denied"
      ? "Sem permissão para enviar nesta conversa."
      : (err.message || "Não foi possível enviar a mensagem."), "erro");
    if (conteudo === null && !elTexto.value) {
      elTexto.value = texto;
      atualizarBotoesDeEnvio();
      ajustarAlturaDoCampo();
      if (respostaEnviada) {
        respondendoA = respostaEnviada;
        if (elRespostaAutor) elRespostaAutor.textContent = nomeDeExibicao(respostaEnviada.autor);
        if (elRespostaTexto) elRespostaTexto.textContent = resumo(respostaEnviada.tipo, respostaEnviada.texto);
        if (elRespostaPreview) elRespostaPreview.classList.add("aberta");
      }
    }
    return false;
  }
}

/**
 * Enter ou o botão redondo: termina o áudio que está gravando, ou manda o
 * texto e as imagens anexadas (o texto primeiro, as fotos em seguida).
 */
function enviarDoCompositor() {
  fecharPainelDeEmojis();
  if (estaGravando()) {
    pararGravacao(true);
    return;
  }
  if (!sessaoAtual || !chatId) return;

  const imagens = anexosPendentes.map((item) => item.arquivo);
  if (imagens.length) limparAnexos();
  enviar();
  if (imagens.length) enviarImagens(imagens);
}

// ==========================================================================
// MÍDIA
// ==========================================================================

async function subirArquivo(pasta, arquivo, extensao) {
  const caminho = `${pasta}/${sessaoAtual.user.uid}/${chatId}_${Date.now()}.${extensao}`;
  const destino = ref(storage, caminho);
  // Cada envio gera um nome de arquivo novo (Date.now()) — o conteúdo nunca
  // é sobrescrito, então o CDN pode cachear "pra sempre".
  await uploadBytes(destino, arquivo, { cacheControl: "public, max-age=31536000, immutable" });
  return getDownloadURL(destino);
}

// Chip "Enviando foto…" acima da barra enquanto o arquivo sobe (antes eram
// dois avisos na base da tela, um ao começar e outro ao terminar).
const enviosEmAndamento = new Map();
let proximoEnvio = 0;

function comecarEnvio(tipo) {
  const id = ++proximoEnvio;
  enviosEmAndamento.set(id, tipo);
  pintarEnviosEmAndamento();
  return () => {
    enviosEmAndamento.delete(id);
    pintarEnviosEmAndamento();
  };
}

function pintarEnviosEmAndamento() {
  const tipos = [...enviosEmAndamento.values()];
  mostrar(elEnvioAndamento, tipos.length > 0);
  if (!tipos.length || !elEnvioAndamentoTexto) return;
  if (tipos.length === 1) {
    elEnvioAndamentoTexto.textContent = tipos[0] === "audio" ? "Enviando áudio…" : "Enviando foto…";
  } else {
    elEnvioAndamentoTexto.textContent = tipos.every((t) => t === "imagem")
      ? `Enviando ${tipos.length} fotos…`
      : `Enviando ${tipos.length} arquivos…`;
  }
}

// --------------------------------------------------------------------------
// Fotos: câmera, galeria (várias de uma vez), colar e arrastar
// --------------------------------------------------------------------------

const TAMANHO_MAXIMO_IMAGEM = 10 * 1024 * 1024;
const LIMITE_IMAGENS_POR_VEZ = 10;
const EXTENSAO_DA_IMAGEM = { "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif" };

/** Confere tipo e tamanho; quando recusa, diz o motivo. */
function imagemAceita(arquivo) {
  if (!arquivo?.type?.startsWith("image/")) {
    Core.aviso("Só dá para enviar imagens por aqui.", "alerta");
    return false;
  }
  // As regras do Storage aceitam "menos de 10 MB" (exatos 10 MB é recusado).
  if (arquivo.size >= TAMANHO_MAXIMO_IMAGEM) {
    Core.aviso("A imagem precisa ter no máximo 10 MB.", "erro");
    return false;
  }
  return true;
}

/** Sobe e envia as fotos uma de cada vez, na ordem em que foram escolhidas. */
async function enviarImagens(arquivos) {
  if (!sessaoAtual || !chatId) return;
  if (arquivos.length > LIMITE_IMAGENS_POR_VEZ) {
    Core.aviso(`Dá para mandar até ${LIMITE_IMAGENS_POR_VEZ} fotos por vez.`, "alerta");
  }
  const aceitas = arquivos.slice(0, LIMITE_IMAGENS_POR_VEZ).filter(imagemAceita);
  const terminar = aceitas.map(() => comecarEnvio("imagem"));
  const falharam = [];

  for (let i = 0; i < aceitas.length; i++) {
    try {
      // A extensão sai do tipo real do arquivo.
      const extensao = EXTENSAO_DA_IMAGEM[aceitas[i].type] || "jpg";
      const url = await subirArquivo("imagens", aceitas[i], extensao);
      if (!(await enviar(url, "imagem"))) falharam.push(aceitas[i]);
    } catch (err) {
      console.error("Erro no upload da imagem:", err);
      falharam.push(aceitas[i]);
    } finally {
      terminar[i]();
    }
  }

  // O que não foi volta para a caixa, pronto para tentar de novo com o
  // Enviar (o texto que falha também volta para o campo).
  if (falharam.length) {
    adicionarAnexos(falharam);
    Core.aviso(falharam.length > 1
      ? `${falharam.length} fotos não foram enviadas. Elas ficaram na caixa para tentar de novo.`
      : "A foto não foi enviada. Ela ficou na caixa para tentar de novo.", "erro");
  }
}

function escolherImagens({ camera = false } = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  // No celular, "capture" abre direto a câmera; a galeria aceita várias
  // fotos de uma vez, como no Instagram.
  if (camera) input.setAttribute("capture", "environment");
  else input.multiple = true;

  input.addEventListener("change", () => {
    const arquivos = [...(input.files || [])];
    if (arquivos.length) enviarImagens(arquivos);
  });
  input.click();
}

function abrirGaleria() {
  fecharPainelDeEmojis();
  escolherImagens();
}

function abrirCamera() {
  fecharPainelDeEmojis();
  escolherImagens({ camera: true });
}

/**
 * Imagem colada ou arrastada vira miniatura dentro da caixa e só sai com o
 * Enviar — dá para conferir (e tirar) antes, como no Instagram.
 */
function adicionarAnexos(arquivos) {
  const aceitas = arquivos.filter(imagemAceita);
  if (!aceitas.length || !elAnexos) return;

  const espaco = LIMITE_IMAGENS_POR_VEZ - anexosPendentes.length;
  if (aceitas.length > espaco) Core.aviso(`Dá para mandar até ${LIMITE_IMAGENS_POR_VEZ} fotos por vez.`, "alerta");

  aceitas.slice(0, Math.max(0, espaco)).forEach((arquivo) => {
    const item = { arquivo, url: URL.createObjectURL(arquivo), el: null };
    item.el = criarMiniaturaDeAnexo(item);
    elAnexos.appendChild(item.el);
    anexosPendentes.push(item);
  });
  atualizarAnexos();
  if (!ehToque()) elTexto?.focus();
}

function criarMiniaturaDeAnexo(item) {
  const miniatura = document.createElement("div");
  miniatura.className = "anexo-miniatura";

  const img = document.createElement("img");
  img.src = item.url;

  const remover = document.createElement("button");
  remover.type = "button";
  remover.className = "anexo-remover";
  remover.textContent = "×";
  remover.addEventListener("click", () => {
    removerAnexo(item);
    if (!ehToque()) elTexto?.focus();
  });

  miniatura.append(img, remover);
  return miniatura;
}

function removerAnexo(item) {
  const i = anexosPendentes.indexOf(item);
  if (i === -1) return;
  anexosPendentes.splice(i, 1);
  item.el?.remove();
  URL.revokeObjectURL(item.url);
  atualizarAnexos();
}

function limparAnexos() {
  anexosPendentes.forEach((item) => URL.revokeObjectURL(item.url));
  anexosPendentes = [];
  elAnexos?.replaceChildren();
  atualizarAnexos();
}

/** Numera as miniaturas para o leitor de tela e mostra/esconde a fileira. */
function atualizarAnexos() {
  const total = anexosPendentes.length;
  anexosPendentes.forEach((item, i) => {
    const img = item.el?.querySelector("img");
    const remover = item.el?.querySelector("button");
    if (img) img.alt = total > 1 ? `Imagem ${i + 1} de ${total} para enviar` : "Imagem para enviar";
    remover?.setAttribute("aria-label", total > 1 ? `Remover imagem ${i + 1}` : "Remover imagem");
  });
  mostrar(elAnexos, total > 0);
  atualizarBotoesDeEnvio();
}

// --------------------------------------------------------------------------
// Áudio: toque no microfone para gravar; a barra mostra o tempo e o nível
// da voz; a lixeira descarta e o botão de enviar manda.
// --------------------------------------------------------------------------

const DURACAO_MINIMA_AUDIO = 700;            // um toque sem querer não vira áudio
const DURACAO_MAXIMA_AUDIO = 5 * 60 * 1000;  // depois de 5 minutos, envia sozinho

let relogioGravacao = null;
let iniciandoGravacao = false;
let ondas = null; // medidor de volume da gravação atual

function estaGravando() {
  return gravacaoAtual?.gravador.state === "recording";
}

function formatarDuracao(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function atualizarIndicadorDeGravacao(gravando) {
  const btn = document.querySelector('[data-acao="audio"]');
  btn?.classList.toggle("gravando", gravando);
  elPill?.classList.toggle("gravando", gravando);
  mostrar(elBarraGravacao, gravando);
  atualizarBotoesDeEnvio();

  clearInterval(relogioGravacao);
  relogioGravacao = null;
  if (!gravando) {
    pararOndas();
    if (elTempoGravacao) elTempoGravacao.textContent = "0:00";
    return;
  }

  const atualizar = () => {
    if (!gravacaoAtual) return;
    const decorrido = Date.now() - gravacaoAtual.inicio;
    if (elTempoGravacao) elTempoGravacao.textContent = formatarDuracao(decorrido);
    if (decorrido >= DURACAO_MAXIMA_AUDIO) pararGravacao(true);
  };
  atualizar();
  relogioGravacao = setInterval(atualizar, 250);
}

async function gravarAudio() {
  if (estaGravando()) {
    pararGravacao(true);
    return;
  }
  if (iniciandoGravacao) return; // dois toques enquanto o navegador pede permissão
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    Core.aviso("Seu navegador não suporta gravação de áudio.", "alerta");
    return;
  }

  fecharPainelDeEmojis();
  iniciandoGravacao = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("Microfone negado:", err);
    Core.aviso("Libere o acesso ao microfone no navegador.", "alerta");
    return;
  } finally {
    iniciandoGravacao = false;
  }

  const desligarMicrofone = () => stream.getTracks().forEach((t) => t.stop());

  // A permissão pode ter chegado com a pessoa já fora da conversa (outra
  // aba, app em segundo plano) ou gravando por outro caminho.
  if (document.visibilityState === "hidden" || gravacaoAtual) {
    desligarMicrofone();
    return;
  }

  // Cada gravação guarda o próprio estado: o evento "stop" chega depois, e
  // uma gravação nova pode ter começado nesse meio-tempo.
  const esta = { gravador: null, desligarMicrofone, inicio: 0, fim: 0, descartar: false };
  const pedacos = [];
  try {
    // Deixar o formato a cargo do navegador: o Safari do iPhone não grava
    // webm, e forçar esse tipo produzia um arquivo que nenhum aparelho
    // conseguia reproduzir depois.
    const gravador = new MediaRecorder(stream);
    gravador.ondataavailable = (ev) => { if (ev.data?.size > 0) pedacos.push(ev.data); };
    gravador.onstop = () => {
      desligarMicrofone();
      // Parou sozinho (microfone desconectado, permissão retirada, erro do
      // gravador): a barra sai e nada é enviado sem a pessoa pedir.
      if (gravacaoAtual === esta) {
        gravacaoAtual = null;
        esta.descartar = true;
        atualizarIndicadorDeGravacao(false);
        Core.aviso("A gravação foi interrompida.", "alerta");
      }
      if (esta.descartar || !pedacos.length) return;
      if ((esta.fim || Date.now()) - esta.inicio < DURACAO_MINIMA_AUDIO) {
        Core.aviso("Áudio muito curto.", "info");
        return;
      }
      enviarAudioGravado(pedacos, gravador.mimeType);
    };
    gravador.start();
    esta.gravador = gravador;
  } catch (err) {
    console.error("Gravação indisponível:", err);
    Core.aviso("Não foi possível gravar áudio neste navegador.", "alerta");
    desligarMicrofone();
    return;
  }

  gravacaoAtual = esta;
  esta.inicio = Date.now();
  atualizarIndicadorDeGravacao(true);
  iniciarOndas(stream); // depois de mostrar a barra: a onda ocupa a largura dela
  // O microfone some durante a gravação; o foco vai para o enviar.
  if (!ehToque()) document.getElementById("btnEnviar")?.focus();
}

/** Termina a gravação: true envia o áudio, false descarta. */
function pararGravacao(enviarDepois) {
  const esta = gravacaoAtual;
  if (!esta) return;
  gravacaoAtual = null;
  esta.descartar = !enviarDepois;
  esta.fim = Date.now();
  try {
    if (esta.gravador.state !== "inactive") esta.gravador.stop();
  } catch (err) {
    console.error("Erro ao parar a gravação:", err);
  }
  // O microfone desliga na hora (o "stop" do gravador chega depois, e ao
  // sair da página pode nem chegar).
  esta.desligarMicrofone();
  atualizarIndicadorDeGravacao(false);
  if (!ehToque()) elTexto?.focus();
}

async function enviarAudioGravado(pedacos, mimeType) {
  const terminar = comecarEnvio("audio");
  try {
    // O tipo real vem do gravador (audio/webm no Chrome, audio/mp4 no
    // Safari).
    const tipo = (mimeType || pedacos[0]?.type || "audio/webm").split(";")[0];
    const extensao = tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm";
    const url = await subirArquivo("audios", new Blob(pedacos, { type: tipo }), extensao);
    await enviar(url, "audio");
  } catch (err) {
    console.error("Erro no upload do áudio:", err);
    Core.aviso("Erro ao enviar o áudio.", "erro");
  } finally {
    terminar();
  }
}

/** Uma barrinha a cada 5 px (3 de barra + 2 de espaço), ocupando o espaço livre. */
function barrasQueCabem() {
  return Math.max(12, Math.min(120, Math.floor(elOndasGravacao.clientWidth / 5)));
}

function prepararBarrasDaOnda(quantas = barrasQueCabem()) {
  if (elOndasGravacao.childElementCount !== quantas) {
    elOndasGravacao.replaceChildren(...Array.from({ length: quantas }, () => document.createElement("span")));
  }
  return [...elOndasGravacao.children];
}

/** Barrinhas que sobem e descem com a voz (Web Audio, ~14 quadros/s). */
function iniciarOndas(stream) {
  pararOndas();
  if (!elOndasGravacao) return;
  let barras = prepararBarrasDaOnda();
  const Contexto = window.AudioContext || window.webkitAudioContext;
  if (!Contexto) return;

  const niveis = new Array(barras.length).fill(0.12);
  let contexto = null;
  try {
    contexto = new Contexto();
    const analisador = contexto.createAnalyser();
    // ~43 ms de som por leitura: entre um quadro e outro (70 ms) quase nada
    // escapa, e a barra não pisca com picos curtos.
    analisador.fftSize = 2048;
    contexto.createMediaStreamSource(stream).connect(analisador);
    if (contexto.state === "suspended") contexto.resume().catch(() => {});

    const amostras = new Uint8Array(analisador.fftSize);
    const estas = { contexto, quadro: 0 };
    let ultimo = 0;
    const desenhar = (agora) => {
      if (ondas !== estas) return;
      estas.quadro = requestAnimationFrame(desenhar);
      if (agora - ultimo < 70) return;
      ultimo = agora;

      // A barra ainda estava se abrindo na primeira medida (os ícones saem
      // com animação) e a janela pode mudar de tamanho: refaz a quantidade.
      const quantas = barrasQueCabem();
      if (quantas !== barras.length) {
        barras = prepararBarrasDaOnda(quantas);
        while (niveis.length < quantas) niveis.unshift(0.12);
        niveis.splice(0, niveis.length - quantas);
      }

      analisador.getByteTimeDomainData(amostras);
      let soma = 0;
      for (let i = 0; i < amostras.length; i++) {
        const v = (amostras[i] - 128) / 128;
        soma += v * v;
      }
      niveis.shift();
      niveis.push(Math.min(1, Math.max(0.12, Math.sqrt(soma / amostras.length) * 5)));
      barras.forEach((barra, i) => { barra.style.transform = `scaleY(${niveis[i].toFixed(2)})`; });
    };
    ondas = estas;
    estas.quadro = requestAnimationFrame(desenhar);
  } catch (err) {
    console.warn("Sem medidor de volume:", err);
    try { contexto?.close().catch(() => {}); } catch (_) {}
  }
}

function pararOndas() {
  if (ondas) {
    cancelAnimationFrame(ondas.quadro);
    try { ondas.contexto.close().catch(() => {}); } catch (_) {}
    ondas = null;
  }
  elOndasGravacao?.querySelectorAll("span").forEach((barra) => barra.style.removeProperty("transform"));
}

// ==========================================================================
// EMOJIS E CORAÇÃO
// ==========================================================================

const CHAVE_EMOJIS_RECENTES = "emojisRecentes";
const MAXIMO_EMOJIS_RECENTES = 32;
const CORACAO = "❤️";

// Só emojis de até a versão 12 do padrão: os mais novos viram quadradinhos
// no Windows 10 e em celulares antigos.
const EMOJIS_INICIAIS = "❤️ 😂 😍 🔥 😭 🙏 👍 😊 🥰 😘 😅 👏 🎉 ✨ 💯 😎".split(" ");
const CATEGORIAS_DE_EMOJI = [
  { id: "recentes", nome: "Recentes", icone: "🕘", emojis: "" },
  { id: "carinhas", nome: "Carinhas", icone: "😀", emojis: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊" },
  { id: "gestos", nome: "Gestos e pessoas", icone: "👋", emojis: "👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 👀 👁️ 👅 👄 🧠 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙋 🙆 🙅 🤷 🤦 💁 🙇 🧏 👮 🦸 🧙 🧚 🧜 💃 🕺 👯 🧘 🏃 🚶 👫 👭 👬 💏 💑 👪" },
  { id: "coracoes", nome: "Corações", icone: "❤️", emojis: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💋 😍 🥰 😘 😻 💑 💏 🌹 💐" },
  { id: "natureza", nome: "Animais e natureza", icone: "🐶", emojis: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦎 🐙 🦑 🦀 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐘 🦒 🦓 🐪 🦘 🦥 🐕 🐈 🐇 🦜 🦩 🌵 🎄 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🍃 🌺 🌻 🌹 🌷 🌼 🌸 🍄 🌎 🌙 ⭐ 🌟 ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌊 💧" },
  { id: "comida", nome: "Comida e bebida", icone: "🍔", emojis: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥬 🥦 🧄 🧅 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🥜 🍯 🥛 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊" },
  { id: "atividades", nome: "Atividades e objetos", icone: "⚽", emojis: "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🥋 ⛳ 🛹 🏄 🏊 🚴 🏋️ 🤸 🏆 🥇 🥈 🥉 🏅 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 🎯 🎳 🎮 🕹️ 🧩 🎉 🎊 🎈 🎁 🎀 📱 💻 ⌨️ 🖥️ 📷 📸 📹 🎥 📺 📻 ⏰ ⌛ 💡 🔦 🕯️ 💸 💵 💰 💳 💎 🔧 🔨 🛠️ 🔑 🚪 🛏️ 🛋️ 🧸 🛒 📚 📖 ✏️ 🖊️ 📝 📌 📎 ✂️ 📅 🚗 🚕 🚌 🏎️ 🚓 🚑 🚒 🛵 🏍️ 🚲 ✈️ 🚀 🛸 🚁 ⛵ 🚢 🏠 🏡 🏢 🏥 🏫 ⛪ 🏖️ 🏝️ ⛰️ 🗽 🗼 🎡 🎢" },
  { id: "simbolos", nome: "Símbolos e bandeiras", icone: "✨", emojis: "✨ 💫 💥 💢 💦 💨 💬 💭 💤 ✅ ✔️ ❌ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❗ 💯 🔝 🆗 🆒 🆕 🆓 🔞 🚫 ⛔ ⭕ 🛑 ⚠️ ♻️ 🔱 ⚜️ 🎵 🎶 🔔 🔕 📣 📢 🔇 🔊 ▶️ ⏸️ ⏹️ 🔁 🔄 ➡️ ⬅️ ⬆️ ⬇️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔶 🔷 ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🏳️ 🏴 🏁 🚩 🏳️‍🌈 🇧🇷 🇵🇹 🇺🇸 🇦🇷 🇯🇵 🇪🇸 🇫🇷 🇮🇹 🇩🇪 🇬🇧 🇲🇽 🇨🇦" },
].map((c) => ({ ...c, emojis: c.emojis ? c.emojis.split(" ") : [] }));
let painelDeEmojisMontado = false;
let corpoDoPainelDeEmojis = null;
let abasDoPainelDeEmojis = [];
let timerCoracao = null;
// Onde estava o cursor quando o campo perdeu o foco. No celular os emojis
// entram com o campo sem foco (o painel substitui o teclado), e o Chrome
// nem sempre mantém a seleção de um campo que já perdeu o foco.
let cursorDoCampo = null;

function lerEmojisRecentes() {
  try {
    const lista = JSON.parse(localStorage.getItem(CHAVE_EMOJIS_RECENTES) || "[]");
    if (Array.isArray(lista)) {
      return lista.filter((e) => typeof e === "string" && e.length > 0 && e.length <= 16).slice(0, MAXIMO_EMOJIS_RECENTES);
    }
  } catch (_) { /* valor estragado: começa de novo */ }
  return [];
}

function guardarEmojiRecente(emoji) {
  try {
    const lista = [emoji, ...lerEmojisRecentes().filter((e) => e !== emoji)].slice(0, MAXIMO_EMOJIS_RECENTES);
    localStorage.setItem(CHAVE_EMOJIS_RECENTES, JSON.stringify(lista));
  } catch (_) { /* navegação privada: só não lembra */ }
}

function botaoDeEmoji(emoji) {
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "painel-emoji";
  botao.textContent = emoji;
  botao.dataset.emoji = emoji;
  return botao;
}

function marcarAbaDeEmoji(id) {
  abasDoPainelDeEmojis.forEach((aba) => {
    if (aba.dataset.categoria === id) aba.setAttribute("aria-current", "true");
    else aba.removeAttribute("aria-current");
  });
}

/** Monta o painel só na primeira vez que ele abre (são ~600 botões). */
function montarPainelDeEmojis() {
  if (painelDeEmojisMontado || !elPainelEmojis) return;
  painelDeEmojisMontado = true;

  const abas = document.createElement("div");
  abas.className = "painel-emojis-abas";
  const corpo = document.createElement("div");
  corpo.className = "painel-emojis-corpo";

  CATEGORIAS_DE_EMOJI.forEach((categoria) => {
    const aba = document.createElement("button");
    aba.type = "button";
    aba.className = "painel-emojis-aba";
    aba.textContent = categoria.icone;
    aba.title = categoria.nome;
    aba.setAttribute("aria-label", categoria.nome);
    aba.dataset.categoria = categoria.id;
    abas.appendChild(aba);

    const secao = document.createElement("section");
    secao.className = "painel-emojis-secao";
    secao.dataset.categoria = categoria.id;
    secao.setAttribute("aria-label", categoria.nome);

    const titulo = document.createElement("h3");
    titulo.className = "painel-emojis-titulo";
    titulo.textContent = categoria.nome;

    const grade = document.createElement("div");
    grade.className = "painel-emojis-grade";
    categoria.emojis.forEach((emoji) => grade.appendChild(botaoDeEmoji(emoji)));

    secao.append(titulo, grade);
    corpo.appendChild(secao);
  });

  abas.addEventListener("click", (e) => {
    const aba = e.target.closest(".painel-emojis-aba");
    if (!aba) return;
    const secao = corpo.querySelector(`.painel-emojis-secao[data-categoria="${aba.dataset.categoria}"]`);
    if (secao) corpo.scrollTop = secao.offsetTop;
    marcarAbaDeEmoji(aba.dataset.categoria);
  });

  corpo.addEventListener("click", (e) => {
    const botao = e.target.closest(".painel-emoji");
    if (botao) inserirEmoji(botao.dataset.emoji, e);
  });

  // A aba acompanha a rolagem.
  corpo.addEventListener("scroll", () => {
    const secoes = corpo.querySelectorAll(".painel-emojis-secao");
    let atual = secoes[0];
    if (corpo.scrollTop + corpo.clientHeight >= corpo.scrollHeight - 2) {
      atual = secoes[secoes.length - 1];
    } else {
      for (const secao of secoes) {
        if (secao.offsetTop <= corpo.scrollTop + 4) atual = secao;
        else break;
      }
    }
    if (atual) marcarAbaDeEmoji(atual.dataset.categoria);
  }, { passive: true });

  // Clicar num emoji não tira o cursor do campo de texto (computador).
  elPainelEmojis.addEventListener("mousedown", (e) => e.preventDefault());

  elPainelEmojis.append(abas, corpo);
  corpoDoPainelDeEmojis = corpo;
  abasDoPainelDeEmojis = [...abas.children];
}

function painelDeEmojisAberto() {
  return !!elPainelEmojis && !elPainelEmojis.classList.contains("u-hidden");
}

function abrirPainelDeEmojis() {
  if (!elPainelEmojis) return;
  montarPainelDeEmojis();

  const recentes = lerEmojisRecentes();
  elPainelEmojis.querySelector('.painel-emojis-secao[data-categoria="recentes"] .painel-emojis-grade')
    ?.replaceChildren(...(recentes.length ? recentes : EMOJIS_INICIAIS).map(botaoDeEmoji));

  mostrar(elPainelEmojis, true);
  elPainelEmojis.parentElement?.classList.add("com-emojis");
  if (corpoDoPainelDeEmojis) corpoDoPainelDeEmojis.scrollTop = 0;
  marcarAbaDeEmoji("recentes");
  botoesDeEmoji.forEach((b) => b.setAttribute("aria-expanded", "true"));

  // No celular o painel faz as vezes do teclado: o do sistema desce.
  if (ehToque()) elTexto?.blur();
  document.addEventListener("pointerdown", fecharEmojisAoTocarFora, true);
  document.addEventListener("keydown", fecharEmojisComEsc, true);
}

function fecharPainelDeEmojis() {
  if (!painelDeEmojisAberto()) return;
  mostrar(elPainelEmojis, false);
  elPainelEmojis.parentElement?.classList.remove("com-emojis");
  botoesDeEmoji.forEach((b) => b.setAttribute("aria-expanded", "false"));
  document.removeEventListener("pointerdown", fecharEmojisAoTocarFora, true);
  document.removeEventListener("keydown", fecharEmojisComEsc, true);
}

function alternarPainelDeEmojis() {
  if (painelDeEmojisAberto()) {
    fecharPainelDeEmojis();
    if (!ehToque()) elTexto?.focus();
  } else {
    abrirPainelDeEmojis();
  }
}

function fecharEmojisAoTocarFora(e) {
  if (elPainelEmojis.contains(e.target) || botoesDeEmoji.some((b) => b.contains(e.target))) return;
  fecharPainelDeEmojis();
}

function fecharEmojisComEsc(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  fecharPainelDeEmojis();
  if (!ehToque()) elTexto?.focus();
}

function guardarCursorDoCampo() {
  if (!elTexto) return;
  cursorDoCampo = { inicio: elTexto.selectionStart, fim: elTexto.selectionEnd, valor: elTexto.value };
}

/** Posição para o emoji: o cursor atual, o guardado ou o fim do texto. */
function posicaoParaInserir() {
  if (document.activeElement === elTexto) return [elTexto.selectionStart, elTexto.selectionEnd];
  if (cursorDoCampo && cursorDoCampo.valor === elTexto.value) return [cursorDoCampo.inicio, cursorDoCampo.fim];
  return [elTexto.value.length, elTexto.value.length];
}

/** Põe o emoji onde está o cursor (ou no lugar do texto selecionado). */
function inserirEmoji(emoji, evento) {
  if (!elTexto || !emoji) return;
  const limite = elTexto.maxLength > 0 ? elTexto.maxLength : 4000;
  if (elTexto.value.length + emoji.length > limite) return;

  const [inicio, fim] = posicaoParaInserir();
  elTexto.setRangeText(emoji, inicio, fim, "end");
  const depois = inicio + emoji.length;
  elTexto.setSelectionRange(depois, depois);
  cursorDoCampo = { inicio: depois, fim: depois, valor: elTexto.value };
  guardarEmojiRecente(emoji);
  // setRangeText não dispara "input": o botão de enviar e a altura do campo
  // precisam saber do emoji novo.
  aoDigitar(evento);
  if (!ehToque()) elTexto.focus();
}

/** Coração do computador: manda um ❤️ na hora, com um pulinho no ícone. */
function enviarCoracao(botao) {
  if (!sessaoAtual || !chatId) return;
  enviar(CORACAO);
  botao.classList.remove("curtiu");
  void botao.offsetWidth; // reinicia a animação
  botao.classList.add("curtiu");
  clearTimeout(timerCoracao);
  timerCoracao = setTimeout(() => botao.classList.remove("curtiu"), 600);
}

// ==========================================================================
// CHAMADAS (só em chat direto — ver botões escondidos em iniciarComoGrupo)
// ==========================================================================

function iniciarChamada(tipo) {
  // Já existe uma chamada rolando: abrir outra por cima navegaria a janela da
  // chamada atual e derrubaria a ligação. Levamos a pessoa até ela.
  if (lerEstadoDaChamada()) {
    Core.aviso("Você já está em uma chamada.", "alerta");
    voltarParaAChamada();
    return;
  }

  const params = new URLSearchParams({ u: outroUsuario, papel: "emissor" });
  if (tipo === "audio") params.set("audio", "true");

  Radar.emit({ type: "chamada", to: outroUsuario, content: tipo });

  // A chamada abre numa janela própria: assim ela continua viva enquanto você
  // navega pelo app. Se o navegador bloquear a janela (pop-up recusado), cai
  // no comportamento antigo de navegar na própria aba.
  if (!abrirJanelaDeChamada(params)) {
    window.location.href = `chamada.html?${params.toString()}`;
  }
}

// ==========================================================================
// INICIALIZAÇÃO
// ==========================================================================

async function iniciarComoDireto() {
  if (sessaoAtual.username === outroUsuario) {
    window.location.replace("inbox.html");
    throw new Error("chat consigo mesmo");
  }

  chatId = idDoChat(sessaoAtual.username, outroUsuario);
  participantesValidos = new Set([outroUsuario]);
  marcarComoLido();

  elNome.textContent = `@${outroUsuario}`;

  try {
    const perfil = await buscarPerfilPorUsername(outroUsuario);
    if (perfil) {
      if (perfil.nome) {
        elNome.textContent = perfil.nome;
        nomesConhecidos.set(outroUsuario, perfil.nome);
        document.title = `${perfil.nome} - Sinex Chat`;
      }
      if (perfil.foto) {
        fotoDoContato = perfil.foto;
        definirAvatar(elFoto, perfil.foto);
        definirAvatar(document.getElementById("fotoDigitando"), perfil.foto);
      }
    } else {
      Core.aviso("Este usuário não existe mais.", "erro");
    }
  } catch (err) {
    console.error("Erro ao carregar o contato:", err);
  }

  // Cria o documento da conversa antes de escutar, para o listener não bater
  // numa subcoleção de um chat inexistente.
  try {
    await garantirChat(sessaoAtual, outroUsuario);
  } catch (err) {
    console.error("Erro ao preparar a conversa:", err);
    Core.aviso(err.code === "permission-denied"
      ? "Não foi possível abrir esta conversa (sem permissão)."
      : err.message, "erro");
    throw err;
  }

  pedirStatus();
}

async function iniciarComoGrupo() {
  chatId = grupoDaURL;
  marcarComoLido();

  // Chamada de voz/vídeo ainda é só 1 para 1 — sem sentido tentar WebRTC
  // ponto-a-ponto com N pessoas aqui, então os botões somem.
  document.querySelectorAll('[data-acao="chamada-audio"], [data-acao="chamada-video"]')
    .forEach((el) => mostrar(el, false));

  // Grupo apagado ou de que a pessoa não faz parte: as regras respondem
  // "sem permissão" (e não "não existe"). As duas coisas dão no mesmo aviso —
  // antes a recusa escapava daqui e sobrava uma conversa em branco.
  let chat = null;
  try {
    chat = await obterChat(chatId);
  } catch (err) {
    if (err?.code !== "permission-denied") {
      Core.aviso("Não foi possível abrir o grupo. Verifique sua conexão.", "erro");
      throw err;
    }
  }
  if (!chat || chat.tipo !== "grupo" || !(chat.usuarios || []).includes(sessaoAtual.username)) {
    Core.aviso("Este grupo não existe mais ou você não faz parte dele.", "erro");
    window.location.replace("inbox.html");
    throw new Error("grupo inacessível");
  }

  chatDoc = chat;
  participantesDoGrupo = chat.usuarios;
  participantesValidos = new Set(participantesDoGrupo.filter((u) => u !== sessaoAtual.username));

  elNome.textContent = chat.nome || "Grupo";
  document.title = `${chat.nome || "Grupo"} - Sinex Chat`;
  definirAvatar(elFoto, AVATAR_GRUPO);
  elStatus.classList.remove("status-online");
  elStatus.textContent = `${participantesDoGrupo.length} participantes`;

  const outrosParticipantes = [...participantesValidos];
  const perfis = await Promise.all(
    outrosParticipantes.map((u) => buscarPerfilPorUsername(u).catch(() => null))
  );
  perfis.forEach((perfil, i) => {
    if (perfil?.nome) nomesConhecidos.set(outrosParticipantes[i], perfil.nome);
  });
  const nomes = outrosParticipantes.map((u) => nomesConhecidos.get(u) || u);
  elStatus.textContent = nomes.length > 3
    ? `Você, ${nomes.slice(0, 3).join(", ")} e mais ${nomes.length - 3}`
    : `Você, ${nomes.join(", ")}`;
}

async function iniciar() {
  ajustarAlturaDoCampo();
  sessaoAtual = await sessao();
  montarAvatarNav();
  aplicarStatusDoCabecalho();

  try {
    if (modoGrupo) await iniciarComoGrupo();
    else await iniciarComoDireto();
  } catch (_) {
    elMensagens?.setAttribute("aria-busy", "false");
    return; // erro já tratado e avisado dentro da função específica
  }

  escutarConversa();
}

/**
 * Liga a escuta em tempo real (mensagens + documento do chat). Separada de
 * iniciar() porque o listener é desligado ao sair da página e precisa voltar
 * quando a pessoa retorna sem recarregar (minimizar o navegador e abrir de
 * novo).
 */
function escutarConversa() {
  if (!chatId || !sessaoAtual) return;
  if (!pararDeEscutar) {
    pararDeEscutar = escutarMensagens(chatId, (lista) => {
      elMensagens?.setAttribute("aria-busy", "false");
      mensagensAoVivo = lista;
      redesenharComHistorico();
    });
  }
  if (!pararDeEscutarChat) {
    pararDeEscutarChat = escutarChat(chatId, (chat) => {
      if (!chat) return;
      chatDoc = chat;
      if (modoGrupo && Array.isArray(chat.usuarios)) {
        participantesDoGrupo = chat.usuarios;
        participantesValidos = new Set(chat.usuarios.filter((u) => u !== sessaoAtual.username));
      }
      // As confirmações mudaram: redesenha só as bolhas afetadas.
      if (rendorizadas.size) redesenharComHistorico();
      else agendarConfirmacao();
    });
  }
}

function pararEscuta() {
  pararDeEscutar?.();
  pararDeEscutar = null;
  pararDeEscutarChat?.();
  pararDeEscutarChat = null;
}

// --------------------------------------------------------------------------
// Ligação dos eventos: sem onclick no HTML, para o CSP poder recusar
// 'unsafe-inline' em script-src.
// --------------------------------------------------------------------------

elTexto?.addEventListener("input", aoDigitar);
// Sair do campo também encerra o aviso.
elTexto?.addEventListener("blur", avisarQueParei);
elTexto?.addEventListener("blur", guardarCursorDoCampo);

// Enter envia; Shift+Enter (ou Ctrl+Enter) quebra a linha. isComposing evita
// enviar no meio de um acento sendo composto.
elTexto?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.isComposing) return;
  e.preventDefault();
  enviarDoCompositor();
});

// Colar uma imagem (print, "Copiar imagem") a anexa. Se a área de
// transferência também tem texto (células do Excel, por exemplo, vêm com uma
// imagem junto), vale o texto.
elTexto?.addEventListener("paste", (e) => {
  const dados = e.clipboardData;
  if (!dados || Array.from(dados.types || []).includes("text/plain")) return;
  const imagens = Array.from(dados.files || []).filter((f) => f.type.startsWith("image/"));
  if (!imagens.length) return;
  e.preventDefault();
  adicionarAnexos(imagens);
});

// No celular, voltar a tocar no campo troca os emojis pelo teclado.
elTexto?.addEventListener("focus", () => {
  if (ehToque()) fecharPainelDeEmojis();
});

// Carrega mais histórico automaticamente perto do topo, além do botão
// manual.
let timerRolagem = null;
elMensagens?.addEventListener("scroll", () => {
  if (elMensagens.scrollTop < 80) carregarMaisAntigas();
  if (estaNoFim()) {
    esconderPilulaDeNovas();
    clearTimeout(timerRolagem);
    timerRolagem = setTimeout(confirmarRecebimento, 200);
  }
}, { passive: true });

const btnEnviar = document.getElementById("btnEnviar");
let campoTinhaFoco = false;
btnEnviar?.addEventListener("pointerdown", () => { campoTinhaFoco = document.activeElement === elTexto; });
// Clicar no enviar não tira o cursor do campo (e no Android o teclado não
// desce e sobe de novo a cada mensagem).
btnEnviar?.addEventListener("mousedown", (e) => e.preventDefault());
btnEnviar?.addEventListener("click", () => {
  const eraAudio = estaGravando();
  enviarDoCompositor();
  // No celular, o teclado só volta se já estava aberto.
  if (!eraAudio && (!ehToque() || campoTinhaFoco)) elTexto?.focus();
});
document.querySelector('[data-acao="audio"]')?.addEventListener("click", gravarAudio);
document.querySelector('[data-acao="galeria"]')?.addEventListener("click", abrirGaleria);
document.querySelector('[data-acao="camera"]')?.addEventListener("click", abrirCamera);
document.querySelector('[data-acao="curtir"]')?.addEventListener("click", (e) => enviarCoracao(e.currentTarget));
document.querySelector('[data-acao="descartar-audio"]')?.addEventListener("click", () => pararGravacao(false));
botoesDeEmoji.forEach((botao) => {
  botao.addEventListener("click", alternarPainelDeEmojis);
  // No computador, abrir os emojis não tira o cursor do campo.
  botao.addEventListener("mousedown", (e) => e.preventDefault());
});

// Arrastar imagens para a conversa: um aviso cobre a tela e, ao soltar,
// elas entram como anexo (saem com o Enviar).
const elPainelDaConversa = document.querySelector(".chat-panel");
let timerAvisoDeSoltar = null;
const arrastandoArquivos = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

function esconderAvisoDeSoltar() {
  clearTimeout(timerAvisoDeSoltar);
  elPainelDaConversa?.classList.remove("soltando-arquivo");
}

// Enquanto o arquivo passa por cima, o navegador repete "dragover"; se ele
// parar de chegar (arraste cancelado, ou a bolha embaixo do cursor foi
// redesenhada e o "dragleave" se perdeu), o aviso sai sozinho.
function manterAvisoDeSoltar() {
  elPainelDaConversa.classList.add("soltando-arquivo");
  clearTimeout(timerAvisoDeSoltar);
  timerAvisoDeSoltar = setTimeout(esconderAvisoDeSoltar, 450);
}

elPainelDaConversa?.addEventListener("dragenter", (e) => {
  if (!arrastandoArquivos(e)) return;
  e.preventDefault();
  manterAvisoDeSoltar();
});
elPainelDaConversa?.addEventListener("dragover", (e) => {
  if (!arrastandoArquivos(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  manterAvisoDeSoltar();
});
elPainelDaConversa?.addEventListener("dragleave", (e) => {
  if (!arrastandoArquivos(e)) return;
  if (!e.relatedTarget || !elPainelDaConversa.contains(e.relatedTarget)) esconderAvisoDeSoltar();
});
elPainelDaConversa?.addEventListener("drop", (e) => {
  if (!arrastandoArquivos(e)) return;
  e.preventDefault();
  esconderAvisoDeSoltar();
  adicionarAnexos(Array.from(e.dataTransfer.files || []));
});
// Soltar fora da conversa não pode abrir o arquivo no lugar do chat.
window.addEventListener("dragover", (e) => { if (arrastandoArquivos(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!arrastandoArquivos(e)) return;
  e.preventDefault();
  esconderAvisoDeSoltar();
});
window.addEventListener("dragend", esconderAvisoDeSoltar);
document.querySelector('[data-acao="chamada-audio"]')?.addEventListener("click", () => iniciarChamada("audio"));
document.querySelector('[data-acao="chamada-video"]')?.addEventListener("click", () => iniciarChamada("video"));
document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
  if (document.referrer && new URL(document.referrer).origin === location.origin && !document.referrer.includes("chat.html")) window.history.back();
  else window.location.href = "inbox.html";
});
const elCabecalhoContato = document.querySelector('[data-acao="abrir-perfil"]');

function abrirPerfilDoContato() {
  if (modoGrupo) {
    Core.aviso(`${participantesDoGrupo.length} participantes: ${participantesDoGrupo.map((u) => nomeDeExibicao(u)).join(", ")}`, "info");
    return;
  }
  window.location.href = `perfil.html?u=${encodeURIComponent(outroUsuario)}`;
}

elCabecalhoContato?.addEventListener("click", abrirPerfilDoContato);
elCabecalhoContato?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  abrirPerfilDoContato();
});

// pagehide é mais confiável que beforeunload no Safari do iPhone.
window.addEventListener("pagehide", () => {
  // Fechar a aba, voltar para a caixa de entrada ou trocar de app no meio de
  // uma frase: o aviso de "parei" sai antes de o socket cair.
  avisarQueParei();
  pararEscuta();
  marcarComoLido();
  // Sair no meio de uma gravação descarta o áudio (antes ele saía pela
  // metade, com a página já fechando).
  if (estaGravando()) pararGravacao(false);
});

// Minimizar o navegador e voltar NÃO recarrega a página: ela volta do cache de
// retorno (bfcache) com os listeners já desligados pelo pagehide acima.
window.addEventListener("pageshow", (evento) => {
  if (!evento.persisted) return;
  escutarConversa();

  // Os timers ficam CONGELADOS enquanto a página está no cache de retorno.
  conferirDigitando();
  aplicarStatusDoCabecalho();
  pedirStatus();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") escutarConversa();
});

iniciar();
