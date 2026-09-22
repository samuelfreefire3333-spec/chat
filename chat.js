import { storage } from "./firebase.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import Core, {
  sessao, urlSegura, definirAvatar, horaCurta, tempoRelativo,
  buscarPerfilPorUsername, idDoChat, AVATAR_PADRAO, montarAvatarNav
} from "./core.js";
import Radar, { zerarNotificacoes } from "./radar.js";
import { abrirJanelaDeChamada } from "./chamada-flutuante.js";
import {
  escutarMensagens, enviarMensagem, enviarMensagemNoGrupo, garantirChat,
  obterChat, reagirMensagem, resumo, carregarMensagensAntigas, TAMANHO_PAGINA_HISTORICO
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

let sessaoAtual = null;
let chatId = null;
let fotoDoContato = AVATAR_PADRAO;
let pararDeEscutar = null;
let timerStatus = null;
let idUltimaRenderizada = null;

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
// colada na de cima (mesma pessoa, pouco tempo depois) — precisa ser
// lembrado porque, quando só o conteúdo muda (uma reação nova, por exemplo),
// a mensagem é redesenhada sem recalcular o agrupamento a partir do zero.
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
// empilhando páginas mais antigas na frente dela — essas não mudam mais,
// então não precisam de listener, só de uma busca pontual.
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
    Core.aviso("Não foi possível reagir agora.", "#ed4956");
  }
}

// Momento em que o menu foi aberto. O "pointerup" que encerra o toque longo
// gera um "click" logo em seguida, fora do menu — sem esta trava o menu
// fechava no mesmo instante em que aparecia, em todo celular.
let menuAbertoEm = 0;

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
  REACOES_RAPIDAS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-mensagem-emoji";
    btn.textContent = emoji;
    btn.setAttribute("aria-label", `Reagir com ${emoji}`);
    btn.addEventListener("click", () => { fecharMenuDeMensagem(); alternarReacao(msg, emoji); });
    linhaEmojis.appendChild(btn);
  });

  const btnResponder = document.createElement("button");
  btnResponder.type = "button";
  btnResponder.className = "menu-item";
  btnResponder.setAttribute("role", "menuitem");
  btnResponder.textContent = "↩️  Responder";
  btnResponder.addEventListener("click", () => { fecharMenuDeMensagem(); iniciarResposta(msg); });

  menu.append(linhaEmojis, btnResponder);

  // Copiar: a bolha tem user-select desligado no celular (senão o menu nativo
  // de "Copiar" abre por cima deste), então sem esta opção não havia nenhum
  // jeito de copiar o texto de uma mensagem pelo telefone.
  if (msg.tipo === "texto" || !msg.tipo) {
    const btnCopiar = document.createElement("button");
    btnCopiar.type = "button";
    btnCopiar.className = "menu-item";
    btnCopiar.setAttribute("role", "menuitem");
    btnCopiar.textContent = "📋  Copiar";
    btnCopiar.addEventListener("click", async () => {
      fecharMenuDeMensagem();
      try {
        await navigator.clipboard.writeText(msg.texto || "");
        Core.aviso("Mensagem copiada.", "#00a884");
      } catch (_) {
        Core.aviso("Não foi possível copiar.", "#ed4956");
      }
    });
    menu.appendChild(btnCopiar);
  }
  document.body.appendChild(menu);

  const largura = menu.offsetWidth || 240;
  const altura = menu.offsetHeight || 96;
  const x = ponto ? Math.min(ponto.x, window.innerWidth - largura - 8) : (window.innerWidth - largura) / 2;
  const y = ponto ? Math.min(ponto.y, window.innerHeight - altura - 8) : (window.innerHeight - altura) / 2;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  menuMensagemAtual = menu;
}

document.addEventListener("click", (e) => {
  if (!menuMensagemAtual || menuMensagemAtual.contains(e.target)) return;
  // Ignora o clique que o próprio toque longo produz ao soltar o dedo.
  if (Date.now() - menuAbertoEm < 350) return;
  fecharMenuDeMensagem();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharMenuDeMensagem(); });

/**
 * Toque longo (touch) para abrir o menu de ações — espelha o padrão já usado
 * no inbox, com duas correções sobre a versão anterior:
 *  - tolera um pequeno tremor do dedo (LIMIAR_MOVIMENTO) em vez de cancelar
 *    no primeiro pointermove, o que fazia o menu quase nunca abrir num
 *    celular de verdade;
 *  - dá feedback tátil (a bolha "afunda" e depois vibra) assim que o toque
 *    é reconhecido, em vez de nada acontecer até o menu aparecer do nada.
 * A cópia de texto que aparecia no celular ao segurar a mensagem vinha da
 * seleção nativa do navegador, agora bloqueada em .msg-bubble no chat.css
 * (-webkit-touch-callout / user-select: none).
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

  const autor = document.createElement("strong");
  autor.textContent = nomeDeExibicao(msg.respostaAutor);

  const texto = document.createElement("span");
  texto.textContent = msg.respostaTexto || "";

  citacao.append(autor, texto);

  citacao.addEventListener("click", (e) => {
    e.stopPropagation();
    const alvo = document.getElementById(`msg-${msg.respostaId}`);
    if (!alvo) return;
    alvo.scrollIntoView({ behavior: "smooth", block: "center" });
    alvo.classList.add("msg-destacada");
    setTimeout(() => alvo.classList.remove("msg-destacada"), 1200);
  });

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
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      alternarReacao(msg, emoji);
    });

    linha.appendChild(chip);
  });

  return linha;
}

function criarBolhaDeTexto(msg, souEu, agrupada) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine" : "msg-bubble msg-other";
  prepararCabecalhoDaBolha(bolha, msg, souEu, agrupada);

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
  img.className = "msg-imagem";
  img.addEventListener("click", () => window.open(img.src, "_blank", "noopener"));

  bolha.appendChild(img);
  return bolha;
}

function criarBolhaDeAudio(msg, souEu, agrupada) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine" : "msg-bubble msg-other";
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

  // O ícone acompanha o estado real do elemento, e não só o clique no botão:
  // quando um áudio novo começava, o botão do anterior continuava mostrando
  // "pause" para sempre, porque a pausa vinha de fora.
  audio.addEventListener("play", mostrarPause);
  audio.addEventListener("pause", mostrarPlay);
  audio.addEventListener("ended", () => {
    mostrarPlay();
    progresso.style.width = "0%";
    // Sem isto, a duração ficava travada em 0:00 depois da primeira escuta.
    duracao.textContent = formatar(audio.duration);
  });

  btn.addEventListener("click", () => {
    if (audio.paused) {
      // Pausa qualquer outro áudio tocando na conversa.
      elMensagens.querySelectorAll("audio").forEach((a) => { if (a !== audio) a.pause(); });
      audio.play().catch(() => Core.aviso("Não foi possível reproduzir o áudio."));
    } else {
      audio.pause();
    }
  });

  player.append(btn, barra, duracao, audio);
  bolha.appendChild(player);
  return bolha;
}

function criarMensagemDeSistema(msg) {
  const linha = document.createElement("div");
  linha.className = "msg-sistema";
  linha.textContent = msg.texto;
  return linha;
}

function renderizarMensagem(msg, souEu, agrupada = false, animar = false) {
  if (msg.tipo === "sistema") return criarMensagemDeSistema(msg);

  let bolha;
  if (msg.tipo === "audio") bolha = criarBolhaDeAudio(msg, souEu, agrupada);
  else if (msg.tipo === "imagem") bolha = criarBolhaDeImagem(msg, souEu, agrupada);
  else bolha = criarBolhaDeTexto(msg, souEu, agrupada);

  if (animar) bolha.classList.add("msg-nova");

  const hora = document.createElement("span");
  hora.className = "msg-time";
  hora.textContent = msg.pendente ? "enviando…" : horaCurta(msg.timestampMs);
  bolha.appendChild(hora);

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

  // Chat direto, mensagem do contato: acompanha o avatar. Em grupo, o nome
  // acima da bolha já identifica quem mandou — mostrar N avatares diferentes
  // por mensagem lotaria a tela.
  const wrapper = document.createElement("div");
  wrapper.className = "msg-wrapper-other";
  if (agrupada) wrapper.classList.add("msg-agrupada");

  const avatar = document.createElement("img");
  avatar.alt = "";
  definirAvatar(avatar, fotoDoContato);

  wrapper.append(avatar, coluna);
  return wrapper;
}

function separadorDeData(ms) {
  const div = document.createElement("div");
  div.className = "msg-separador";

  const hoje = new Date();
  const data = new Date(ms);
  const mesmoDia = (a, b) => a.toDateString() === b.toDateString();

  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);

  if (mesmoDia(data, hoje)) div.textContent = "Hoje";
  else if (mesmoDia(data, ontem)) div.textContent = "Ontem";
  else div.textContent = data.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });

  return div;
}

// Assinatura barata do que foi desenhado pra uma mensagem — usada só pra
// decidir se ela precisa ser redesenhada (mudou reação, texto de citação,
// ou saiu do estado "enviando..." pra confirmada), sem comparar DOM.
function assinaturaDe(msg) {
  return JSON.stringify([
    msg.texto, msg.tipo, msg.pendente, msg.timestampMs,
    msg.reacoes, msg.respostaId, msg.respostaTexto,
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
  if (todoHistoricoCarregado) {
    elBtnCarregarMais.style.display = "none";
    return;
  }
  elBtnCarregarMais.style.display = "block";
  elBtnCarregarMais.disabled = carregandoHistorico;
  elBtnCarregarMais.textContent = carregandoHistorico
    ? "Carregando..."
    : "Carregar mensagens anteriores";
}

/** Reconstrói tudo do zero — usada na primeira carga do chat e sempre que o
 *  diff incremental não dá pra aplicar com segurança (ver atualizarDOM). */
function reconstruirTudo(mensagens) {
  elMensagens.replaceChildren();
  rendorizadas.clear();
  ultimoDiaRenderizado = null;
  ultimoRemetenteAgrupamento = null;
  ultimoTimestampAgrupamento = 0;

  // Grupos ainda não têm histórico paginável hoje — carregarMensagensAntigas
  // já funciona pra grupo (é a mesma subcoleção), mas o botão só aparece pra
  // quem realmente pode ter mais de LIMITE_HISTORICO mensagens acumuladas.
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
    // desta operação — era o motivo de "carregar mensagens anteriores" jogar
    // a conversa lá para baixo em vez de manter o ponto de leitura.
    ancorandoScroll = true;
    redesenharComHistorico();
    ancorandoScroll = false;

    // Mantém o trecho que a pessoa estava olhando na mesma posição visual.
    elMensagens.scrollTop = topoAntes + (elMensagens.scrollHeight - alturaAntes);
  } catch (err) {
    console.error("Erro ao carregar mensagens antigas:", err);
    Core.aviso("Não foi possível carregar mensagens antigas.", "#ed4956");
  } finally {
    carregandoHistorico = false;
    atualizarBotaoCarregarMais();
  }
}

/**
 * Redesenha a lista de mensagens SEM reconstruir o DOM inteiro a cada
 * atualização do Firestore — só a mensagem 200 chegando fazia essa função
 * recriar as outras 199 do zero antes.
 *
 * Caminho rápido (o caso de longe mais comum): a lista antiga continua sendo
 * um prefixo exato da nova — ou seja, nada sumiu nem mudou de posição, só
 * pode ter (a) conteúdo de mensagens existentes mudado (reação, confirmação
 * de "enviando..." -> enviada) e/ou (b) mensagens novas no fim. Nesse caso só
 * tocamos exatamente o que mudou — e reaproveitamos o "agrupada" já decidido
 * pra cada mensagem existente, já que o agrupamento de quem já foi desenhado
 * nunca muda (depende só de mensagens anteriores, que são fixas).
 *
 * Fora desse caso (primeira carga do chat, ou qualquer coisa que reordene ou
 * remova algo do meio) cai no reconstruirTudo() de sempre — mais caro, mas
 * correto, e raro na prática.
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
      // Redesenho de uma mensagem que já estava na tela (reação nova, envio
      // confirmado): nunca anima de novo.
      const novoNo = renderizarMensagem(msg, souEu, registro.agrupada, false);
      registro.elemento.replaceWith(novoNo);
      rendorizadas.set(msg.id, { elemento: novoNo, assinatura, agrupada: registro.agrupada });
    });

    mensagens.slice(idsAntigos.length).forEach(inserirMensagem);
    // Mensagens que saíram da lista (não existe exclusão individual hoje,
    // mas mantém o diff correto se um dia existir, ou se a paginação mudar
    // a janela carregada).
    const idsNovos = new Set(mensagens.map((m) => m.id));
    idsAntigos.forEach((id) => {
      if (idsNovos.has(id)) return;
      rendorizadas.get(id)?.elemento.remove();
      rendorizadas.delete(id);
    });

    if (elDigitando) elMensagens.appendChild(elDigitando);
  }

  const ultima = mensagens[mensagens.length - 1];
  // Comparar por ID, e não por timestamp: mensagem ainda não confirmada pelo
  // servidor tem timestamp estimado, e a comparação numérica dava falso
  // negativo justamente na mensagem que a pessoa acabou de enviar.
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
// STATUS DO CONTATO (ONLINE / VISTO POR ÚLTIMO) — só em chat direto
// ==========================================================================

// O texto do cabeçalho tem duas fontes: a presença (Online / Visto há...) e o
// "digitando…", que tem prioridade enquanto dura. Sem este controle, uma
// resposta de presença chegando no meio apagava o "digitando…" — e vice-versa.
let statusDePresenca = "";

function aplicarStatusDoCabecalho() {
  if (!elStatus) return;
  if (digitandoAte && Date.now() < digitandoAte) {
    elStatus.textContent = "digitando…";
    return;
  }
  elStatus.textContent = statusDePresenca || "…";
}

function mostrarOnline() {
  clearTimeout(timerStatus);
  statusDePresenca = "Online";
  elStatus.classList.add("status-online");
  aplicarStatusDoCabecalho();
}

async function mostrarOffline(lastSeenDoServidor) {
  clearTimeout(timerStatus);

  let lastSeen = lastSeenDoServidor;
  if (!lastSeen) {
    // O servidor não sabia: cai para o valor gravado no perfil.
    try {
      const perfil = await buscarPerfilPorUsername(outroUsuario);
      lastSeen = perfil?.lastSeen || 0;
    } catch (_) {}
  }

  const relativo = tempoRelativo(lastSeen);
  statusDePresenca = relativo ? `Visto ${relativo}` : "Offline";
  elStatus.classList.remove("status-online");
  aplicarStatusDoCabecalho();
}

function pedirStatus() {
  statusDePresenca = "…";
  elStatus.classList.remove("status-online");
  aplicarStatusDoCabecalho();

  Radar.verificarStatus(outroUsuario);

  // Se o backend estiver dormindo (plano gratuito do Render), não deixamos a
  // tela presa em "…".
  clearTimeout(timerStatus);
  timerStatus = setTimeout(() => mostrarOffline(), 5000);
}

window.addEventListener("mensagem_servidor", (e) => {
  const msg = e.detail;
  if (!msg || !participantesValidos.has(msg.from)) return;

  if (msg.type === "status_reply" || msg.type === "status_update") {
    if (modoGrupo) return; // presença individual não se aplica a grupos
    if (msg.content === "online") mostrarOnline();
    else mostrarOffline(msg.lastSeen);
    return;
  }

  if (msg.type === "chat") {
    // pararDeMostrarDigitando(), e não só esconderDigitando(): esconder a
    // bolha deixava digitandoAte no futuro, então aplicarStatusDoCabecalho()
    // continuava escrevendo "digitando…" por até 3 s depois de a mensagem
    // chegar — e o mostrarOnline() logo abaixo não conseguia sobrescrever.
    pararDeMostrarDigitando();
    // A mensagem em si chega pelo Firestore; aqui só reagimos ao sinal.
    if (!modoGrupo) mostrarOnline();
    return;
  }

  if (msg.type === "digitando" || msg.type === "parou_digitando") {
    // O app não anuncia digitação em grupo (ver aoDigitar). Logo, um
    // "digitando" que chega enquanto você olha um GRUPO veio de uma conversa
    // privada com essa pessoa: acender a bolha do grupo seria inventar
    // informação — e era mais um jeito de o indicador aparecer sozinho.
    if (modoGrupo) return;

    if (msg.type === "digitando") receberDigitando();
    else pararDeMostrarDigitando();
  }
});

// Ao (re)conectar, pergunta o status de novo — inclusive depois de o servidor
// gratuito acordar. Não se aplica a grupos (sem presença individual).
window.addEventListener("radar_conectado", () => { if (!modoGrupo) pedirStatus(); });

// O indicador some por TEMPO DE RELÓGIO, e não por um setTimeout solto.
//
// Era esse o bug de "aparece que a outra pessoa está digitando a todo momento
// mas ela não está": o navegador congela os timers de uma aba que vai para
// segundo plano ou entra no cache de retorno. Bastava um aviso de digitação
// chegar pouco antes de você minimizar o app para o setTimeout de 2,5 s nunca
// disparar — e o "digitando..." ficava colado na tela por tempo indeterminado.
//
// (A outra metade do bug estava no radar.js: avisos de digitação ficavam
// guardados na fila de reenvio e eram despejados minutos depois, quando o
// servidor gratuito acordava.)
const VALIDADE_DIGITANDO = 3000;
let digitandoAte = 0;
let vigiaDigitando = null;

function receberDigitando() {
  // Receber este aviso já prova que a pessoa está conectada agora.
  if (!modoGrupo) mostrarOnline();

  digitandoAte = Date.now() + VALIDADE_DIGITANDO;
  mostrarDigitando();
  if (!vigiaDigitando) vigiaDigitando = setInterval(conferirDigitando, 700);
}

function conferirDigitando() {
  if (Date.now() < digitandoAte) return;
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

  // O balão de bolinhas sozinho não diz nada a quem vê pela primeira vez. O
  // cabeçalho dizer "digitando…" deixa claro de quem é e o que está
  // acontecendo — é o mesmo padrão do WhatsApp.
  if (!modoGrupo) aplicarStatusDoCabecalho();

  const acompanhando = estaNoFim();
  elDigitando.style.display = "flex";
  elMensagens.appendChild(elDigitando);
  // Só acompanha se a pessoa já estava no fim — senão o indicador puxava a
  // tela para baixo no meio da leitura do histórico.
  if (acompanhando) elMensagens.scrollTop = elMensagens.scrollHeight;
}

function esconderDigitando() {
  if (elDigitando) elDigitando.style.display = "none";
}

// Voltar para o app confere na hora se aquele "digitando..." ainda vale, sem
// depender de nenhum timer que possa ter sido congelado.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") conferirDigitando();
});

// Sem conexão não há como saber se a pessoa ainda está digitando. Manter o
// indicador aceso seria inventar uma informação que não temos.
window.addEventListener("radar_desconectado", pararDeMostrarDigitando);

// ==========================================================================
// ENVIO
// ==========================================================================

let ultimoAvisoDigitando = 0;
let anunciandoDigitacao = false;

/**
 * O campo cresce junto com o texto (até um teto), como em qualquer mensageiro.
 * Antes era um <input> de uma linha só: não dava para escrever um parágrafo,
 * e quebra de linha era simplesmente impossível.
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

function aoDigitar() {
  atualizarBotoesDeEnvio();
  ajustarAlturaDoCampo();

  // Em grupo, um evento "digitando" viraria N mensagens WebSocket (uma por
  // participante) a cada tecla — o limite de taxa da conexão é por conexão,
  // não por destinatário, então isso estouraria rápido num grupo com mais de
  // uma dúzia de pessoas. Melhor não anunciar "digitando" em grupo por
  // enquanto do que arriscar a conexão cair.
  if (modoGrupo) return;

  // Apagar tudo é o contrário de estar digitando. Antes não existia nenhum
  // aviso de "parei": a outra ponta só descobria pelo tempo passando.
  if (!elTexto.value.trim()) {
    avisarQueParei();
    return;
  }

  // No máximo um aviso por segundo, em vez de um a cada tecla.
  const agora = Date.now();
  if (agora - ultimoAvisoDigitando > 1000) {
    ultimoAvisoDigitando = agora;
    anunciandoDigitacao = true;
    Radar.emit({ type: "digitando", to: outroUsuario });
  }
}

/** Avisa a outra ponta que parei de digitar — só se eu tinha avisado antes. */
function avisarQueParei() {
  if (modoGrupo || !anunciandoDigitacao) return;
  anunciandoDigitacao = false;
  ultimoAvisoDigitando = 0;
  Radar.emit({ type: "parou_digitando", to: outroUsuario });
}

function atualizarBotoesDeEnvio() {
  const temTexto = elTexto.value.trim().length > 0;
  const acoes = document.getElementById("action-buttons");
  const btnEnviar = document.getElementById("btnEnviar");
  acoes?.classList.toggle("oculto", temTexto);
  btnEnviar?.classList.toggle("mostrar", temTexto);
}

async function enviar(conteudo = null, tipo = "texto") {
  const texto = conteudo ?? elTexto.value.trim();
  if (!texto) return;

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
    // Firestore. Em grupo, avisamos cada participante individualmente — o
    // backend não precisa mudar, cada emit é só mais uma entrega "de-para"
    // (por isso o grupo tem um teto de participantes: ver MAXIMO_MEMBROS_GRUPO
    // em mensagens.js).
    const outrosParticipantes = modoGrupo
      ? participantesDoGrupo.filter((u) => u !== sessaoAtual.username)
      : [outroUsuario];

    outrosParticipantes.forEach((usuario) => {
      Radar.emit({ type: "chat", to: usuario, content: texto, payload: { chatId } });
    });
  } catch (err) {
    console.error("Falha ao enviar:", err);
    Core.aviso(err.message || "Não foi possível enviar a mensagem.", "#ed4956");
    if (conteudo === null) {
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
  }
}
// ==========================================================================
// MÍDIA
// ==========================================================================

async function subirArquivo(pasta, arquivo, extensao) {
  const caminho = `${pasta}/${sessaoAtual.user.uid}/${chatId}_${Date.now()}.${extensao}`;
  const destino = ref(storage, caminho);
  // Cada envio gera um nome de arquivo novo (Date.now()) — o conteúdo nunca
  // é sobrescrito, então o CDN pode cachear "pra sempre" sem risco de servir
  // uma versão velha.
  await uploadBytes(destino, arquivo, { cacheControl: "public, max-age=31536000, immutable" });
  return getDownloadURL(destino);
}

let gravador = null;
let pedacos = [];

async function gravarAudio() {
  const btn = document.querySelector('[data-acao="audio"]');

  if (gravador && gravador.state === "recording") {
    gravador.stop();
    btn?.classList.remove("gravando");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("Microfone negado:", err);
    Core.aviso("Libere o acesso ao microfone no navegador.");
    return;
  }

  try {
    // Deixar o formato a cargo do navegador: o Safari do iPhone não grava
    // webm, e forçar esse tipo produzia um arquivo que nenhum aparelho
    // conseguia reproduzir depois.
    gravador = new MediaRecorder(stream);
  } catch (err) {
    console.error("MediaRecorder indisponível:", err);
    Core.aviso("Seu navegador não suporta gravação de áudio.");
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  pedacos = [];
  gravador.ondataavailable = (ev) => { if (ev.data?.size > 0) pedacos.push(ev.data); };

  gravador.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    if (!pedacos.length) return;

    try {
      Core.aviso("Enviando áudio...");

      // O tipo real vem do gravador (audio/webm no Chrome, audio/mp4 no
      // Safari). Antes tudo virava "webm" na marra e o áudio gravado no
      // iPhone chegava quebrado do outro lado.
      const tipo = (gravador?.mimeType || pedacos[0]?.type || "audio/webm").split(";")[0];
      const extensao = tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm";

      const blob = new Blob(pedacos, { type: tipo });
      const url = await subirArquivo("audios", blob, extensao);
      await enviar(url, "audio");
      Core.aviso("Áudio enviado!", "#00a884");
    } catch (err) {
      console.error("Erro no upload do áudio:", err);
      Core.aviso("Erro ao enviar o áudio.", "#ed4956");
    }
  };

  gravador.start();
  btn?.classList.add("gravando");
  Core.aviso("Gravando... toque no microfone de novo para enviar.", "#00a884");
}

// A função abrirGaleria() era chamada pelo botão de imagem mas nunca havia
// sido escrita — o botão não fazia absolutamente nada.
function abrirGaleria() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";

  input.addEventListener("change", async () => {
    const arquivo = input.files?.[0];
    if (!arquivo) return;

    if (arquivo.size > 10 * 1024 * 1024) {
      Core.aviso("A imagem precisa ter no máximo 10 MB.", "#ed4956");
      return;
    }

    try {
      Core.aviso("Enviando imagem...");

      // A extensão sai do tipo real do arquivo: um PNG ou um WebP eram
      // salvos como ".jpg", o que confundia quem baixasse a imagem depois.
      const mapaExtensao = { "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic" };
      const extensao = mapaExtensao[arquivo.type] || "jpg";

      const url = await subirArquivo("imagens", arquivo, extensao);
      await enviar(url, "imagem");
      Core.aviso("Imagem enviada!", "#00a884");
    } catch (err) {
      console.error("Erro no upload da imagem:", err);
      Core.aviso("Erro ao enviar a imagem.", "#ed4956");
    }
  });

  input.click();
}

// ==========================================================================
// CHAMADAS (só em chat direto — ver botões escondidos em iniciarComoGrupo)
// ==========================================================================

function iniciarChamada(tipo) {
  Radar.emit({ type: "chamada", to: outroUsuario, content: tipo });

  const params = new URLSearchParams({ u: outroUsuario, papel: "emissor" });
  if (tipo === "audio") params.set("audio", "true");

  // A chamada abre numa janela própria: assim ela continua viva enquanto você
  // navega pelo app. Antes, sair de chamada.html derrubava a chamada na hora,
  // porque a conexão WebRTC vive no contexto daquela página.
  //
  // Se o navegador bloquear a janela (pop-up recusado), cai no comportamento
  // antigo de navegar na própria aba.
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

  elNome.textContent = outroUsuario;

  try {
    const perfil = await buscarPerfilPorUsername(outroUsuario);
    if (perfil) {
      if (perfil.nome) {
        elNome.textContent = perfil.nome;
        nomesConhecidos.set(outroUsuario, perfil.nome);
      }
      if (perfil.foto) {
        fotoDoContato = perfil.foto;
        definirAvatar(elFoto, perfil.foto);
        definirAvatar(document.getElementById("fotoDigitando"), perfil.foto);
      }
    } else {
      Core.aviso("Este usuário não existe mais.", "#ed4956");
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
    Core.aviso(err.message, "#ed4956");
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
    .forEach((el) => { el.style.display = "none"; });

  const chat = await obterChat(chatId);
  if (!chat || chat.tipo !== "grupo" || !(chat.usuarios || []).includes(sessaoAtual.username)) {
    Core.aviso("Este grupo não existe mais ou você não faz parte dele.", "#ed4956");
    window.location.replace("inbox.html");
    throw new Error("grupo inacessível");
  }

  participantesDoGrupo = chat.usuarios;
  participantesValidos = new Set(participantesDoGrupo.filter((u) => u !== sessaoAtual.username));

  elNome.textContent = chat.nome || "Grupo";
  definirAvatar(elFoto, AVATAR_PADRAO);
  elStatus.classList.remove("status-online");
  elStatus.textContent = `${participantesDoGrupo.length} participantes`;

  const outrosParticipantes = [...participantesValidos];
  const perfis = await Promise.all(
    outrosParticipantes.map((u) => buscarPerfilPorUsername(u).catch(() => null))
  );
  perfis.forEach((perfil, i) => {
    if (perfil?.nome) nomesConhecidos.set(outrosParticipantes[i], perfil.nome);
  });
}

async function iniciar() {
  ajustarAlturaDoCampo();
  sessaoAtual = await sessao();
  montarAvatarNav();

  try {
    if (modoGrupo) await iniciarComoGrupo();
    else await iniciarComoDireto();
  } catch (_) {
    return; // erro já tratado e avisado dentro da função específica
  }

  escutarConversa();
}

/**
 * Liga a escuta em tempo real. Separada de iniciar() porque o listener é
 * desligado ao sair da página e precisa voltar quando a pessoa retorna sem
 * recarregar (minimizar o navegador e abrir de novo).
 */
function escutarConversa() {
  if (pararDeEscutar || !chatId || !sessaoAtual) return;
  pararDeEscutar = escutarMensagens(chatId, (lista) => {
    mensagensAoVivo = lista;
    redesenharComHistorico();
  });
}

function pararEscuta() {
  if (!pararDeEscutar) return;
  pararDeEscutar();
  pararDeEscutar = null;
}

// --------------------------------------------------------------------------
// Ligação dos eventos: sem onclick no HTML, para o CSP poder recusar
// 'unsafe-inline' em script-src.
// --------------------------------------------------------------------------

elTexto?.addEventListener("input", aoDigitar);
// Sair do campo também encerra o aviso: antes, se você digitasse e saísse sem
// mandar nada, a outra ponta ficava esperando o tempo correr.
elTexto?.addEventListener("blur", avisarQueParei);

// Enter envia; Shift+Enter (ou Ctrl+Enter) quebra a linha. keydown em vez de
// keypress, que está depreciado e não dispara em parte dos teclados virtuais.
// isComposing evita enviar no meio de um acento sendo composto.
elTexto?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.isComposing) return;
  e.preventDefault();
  enviar();
});

// Carrega mais histórico automaticamente perto do topo, além do botão
// manual — o botão continua existindo pra quem preferir tocar nele.
elMensagens?.addEventListener("scroll", () => {
  if (elMensagens.scrollTop < 80) carregarMaisAntigas();
  // Chegou no fim por conta própria: o aviso de novas mensagens já cumpriu
  // o papel dele.
  if (estaNoFim()) esconderPilulaDeNovas();
});

document.getElementById("btnEnviar")?.addEventListener("click", () => enviar());
document.querySelector('[data-acao="audio"]')?.addEventListener("click", gravarAudio);
document.querySelector('[data-acao="galeria"]')?.addEventListener("click", abrirGaleria);
document.querySelector('[data-acao="chamada-audio"]')?.addEventListener("click", () => iniciarChamada("audio"));
document.querySelector('[data-acao="chamada-video"]')?.addEventListener("click", () => iniciarChamada("video"));
document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
  if (document.referrer && !document.referrer.includes("chat.html")) window.history.back();
  else window.location.href = "inbox.html";
});
const elCabecalhoContato = document.querySelector('[data-acao="abrir-perfil"]');

function abrirPerfilDoContato() {
  if (modoGrupo) {
    Core.aviso("Informações do grupo em breve.", "#e0a800");
    return;
  }
  window.location.href = `perfil.html?u=${encodeURIComponent(outroUsuario)}`;
}

elCabecalhoContato?.addEventListener("click", abrirPerfilDoContato);
// O elemento tem role="button" e tabindex="0" no HTML, mas não respondia a
// teclado nenhum — quem navega por Tab não conseguia abrir o perfil.
elCabecalhoContato?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  abrirPerfilDoContato();
});

// pagehide é mais confiável que beforeunload no Safari do iPhone, onde
// beforeunload muitas vezes não dispara.
window.addEventListener("pagehide", () => {
  // Fechar a aba, voltar para a caixa de entrada ou trocar de app no meio de
  // uma frase não avisava nada: a outra ponta ficava com a bolha acesa até o
  // relógio de 3 s correr. O aviso sai antes de o socket cair.
  avisarQueParei();
  pararEscuta();
  marcarComoLido();
});

// Minimizar o navegador e voltar NÃO recarrega a página: ela volta do cache de
// retorno (bfcache) com o listener já desligado pelo pagehide acima. Sem
// religar aqui, a conversa ficava congelada — nenhuma mensagem nova aparecia
// até recarregar na mão.
window.addEventListener("pageshow", (evento) => {
  if (!evento.persisted) return;
  escutarConversa();

  // Os timers ficam CONGELADOS enquanto a página está no cache de retorno, e
  // o Safari do iPhone não dispara visibilitychange ao voltar pelo histórico.
  // Sem esta conferência, um "digitando…" de minutos atrás reaparecia aceso e
  // só sumia no primeiro tique do intervalo — quando ele voltava a correr.
  conferirDigitando();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") escutarConversa();
});

iniciar();

    
