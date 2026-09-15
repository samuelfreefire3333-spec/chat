import { storage } from "./firebase.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import Core, {
  sessao, urlSegura, definirAvatar, horaCurta, tempoRelativo,
  buscarPerfilPorUsername, idDoChat, AVATAR_PADRAO, montarAvatarNav
} from "./core.js";
import Radar from "./radar.js";
import {
  escutarMensagens, enviarMensagem, enviarMensagemNoGrupo, garantirChat,
  obterChat, reagirMensagem, resumo
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
let ultimoTsRenderizado = 0;

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
  if (elRespostaPreview) elRespostaPreview.style.display = "flex";
  elTexto?.focus();
}

function cancelarResposta() {
  respondendoA = null;
  if (elRespostaPreview) elRespostaPreview.style.display = "none";
}

btnCancelarResposta?.addEventListener("click", cancelarResposta);

// ==========================================================================
// MENU DE AÇÕES DA MENSAGEM (responder / reagir)
// ==========================================================================

let menuMensagemAtual = null;

function fecharMenuDeMensagem() {
  menuMensagemAtual?.remove();
  menuMensagemAtual = null;
}

async function alternarReacao(msg, emoji) {
  const emojiAtual = msg.reacoes?.[sessaoAtual.user.uid] || null;
  try {
    await reagirMensagem(chatId, msg.id, sessaoAtual.user.uid, emojiAtual, emoji);
  } catch (err) {
    console.error("Erro ao reagir:", err);
    Core.aviso("Não foi possível reagir agora.", "#ed4956");
  }
}

function abrirMenuDeMensagem(ponto, msg) {
  if (msg.tipo === "sistema") return;
  fecharMenuDeMensagem();

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
  if (menuMensagemAtual && !menuMensagemAtual.contains(e.target)) fecharMenuDeMensagem();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharMenuDeMensagem(); });

/** Toque longo (touch) para abrir o menu de ações — espelha o padrão já usado no inbox. */
function ligarPressaoLonga(elemento, callback) {
  let timer = null;
  let ponto = null;

  const iniciar = (e) => {
    ponto = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => callback(ponto), 500);
  };
  const cancelar = () => clearTimeout(timer);

  elemento.addEventListener("pointerdown", iniciar);
  elemento.addEventListener("pointerup", cancelar);
  elemento.addEventListener("pointerleave", cancelar);
  elemento.addEventListener("pointercancel", cancelar);
  elemento.addEventListener("pointermove", cancelar);
}

// ==========================================================================
// RENDERIZAÇÃO
// ==========================================================================
// Estas funções estavam vazias no arquivo original — só havia o comentário
// "Coloque aqui a sua lógica de desenhar os balões". Nada aparecia na tela.
//
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

/** Nome do remetente (só em grupo) e citação da resposta (se houver), no topo da bolha. */
function prepararCabecalhoDaBolha(bolha, msg, souEu) {
  if (modoGrupo && !souEu) {
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

function criarBolhaDeTexto(msg, souEu) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine" : "msg-bubble msg-other";
  prepararCabecalhoDaBolha(bolha, msg, souEu);

  const corpo = document.createElement("span");
  corpo.className = "msg-texto";
  corpo.textContent = msg.texto;
  bolha.appendChild(corpo);

  return bolha;
}

function criarBolhaDeImagem(msg, souEu) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine msg-midia" : "msg-bubble msg-other msg-midia";
  prepararCabecalhoDaBolha(bolha, msg, souEu);

  const img = document.createElement("img");
  img.src = urlSegura(msg.texto, "");
  img.alt = "Imagem enviada na conversa";
  img.loading = "lazy";
  img.className = "msg-imagem";
  img.addEventListener("click", () => window.open(img.src, "_blank", "noopener"));

  bolha.appendChild(img);
  return bolha;
}

function criarBolhaDeAudio(msg, souEu) {
  const bolha = document.createElement("div");
  bolha.className = souEu ? "msg-bubble msg-mine" : "msg-bubble msg-other";
  prepararCabecalhoDaBolha(bolha, msg, souEu);

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

  audio.addEventListener("loadedmetadata", () => { duracao.textContent = formatar(audio.duration); });
  audio.addEventListener("timeupdate", () => {
    if (audio.duration) progresso.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    duracao.textContent = formatar(audio.duration - audio.currentTime);
  });
  audio.addEventListener("ended", () => {
    btn.innerHTML = ICONE_PLAY;
    btn.setAttribute("aria-label", "Reproduzir mensagem de voz");
    progresso.style.width = "0%";
  });

  btn.addEventListener("click", () => {
    if (audio.paused) {
      // Pausa qualquer outro áudio tocando na conversa.
      elMensagens.querySelectorAll("audio").forEach((a) => { if (a !== audio) a.pause(); });
      audio.play().catch(() => Core.aviso("Não foi possível reproduzir o áudio."));
      btn.innerHTML = ICONE_PAUSE;
      btn.setAttribute("aria-label", "Pausar mensagem de voz");
    } else {
      audio.pause();
      btn.innerHTML = ICONE_PLAY;
      btn.setAttribute("aria-label", "Reproduzir mensagem de voz");
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

function renderizarMensagem(msg, souEu) {
  if (msg.tipo === "sistema") return criarMensagemDeSistema(msg);

  let bolha;
  if (msg.tipo === "audio") bolha = criarBolhaDeAudio(msg, souEu);
  else if (msg.tipo === "imagem") bolha = criarBolhaDeImagem(msg, souEu);
  else bolha = criarBolhaDeTexto(msg, souEu);

  const hora = document.createElement("span");
  hora.className = "msg-time";
  hora.textContent = msg.pendente ? "enviando…" : horaCurta(msg.timestampMs);
  bolha.appendChild(hora);

  // Responder e reagir: toque longo (touch) ou clique direito (mouse).
  bolha.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    abrirMenuDeMensagem({ x: e.clientX, y: e.clientY }, msg);
  });
  ligarPressaoLonga(bolha, (ponto) => abrirMenuDeMensagem(ponto, msg));

  const coluna = document.createElement("div");
  coluna.id = `msg-${msg.id}`;
  coluna.className = souEu ? "msg-coluna msg-coluna-minha" : "msg-coluna msg-coluna-outro";
  coluna.appendChild(bolha);

  const chips = montarChipsDeReacao(msg);
  if (chips) coluna.appendChild(chips);

  if (souEu || modoGrupo) return coluna;

  // Chat direto, mensagem do contato: acompanha o avatar. Em grupo, o nome
  // acima da bolha já identifica quem mandou — mostrar N avatares diferentes
  // por mensagem lotaria a tela.
  const wrapper = document.createElement("div");
  wrapper.className = "msg-wrapper-other";

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

function atualizarDOM(mensagens) {
  const coladoNoFim =
    elMensagens.scrollHeight - elMensagens.scrollTop - elMensagens.clientHeight < 120;

  // Preserva o indicador de "digitando" entre as re-renderizações.
  if (elDigitando?.parentElement) elDigitando.remove();
  elMensagens.replaceChildren();

  let diaAnterior = null;

  mensagens.forEach((msg) => {
    const ms = msg.timestampMs || Date.now();
    const dia = new Date(ms).toDateString();
    if (dia !== diaAnterior) {
      elMensagens.appendChild(separadorDeData(ms));
      diaAnterior = dia;
    }

    const souEu = msg.remetenteUid === sessaoAtual.user.uid;
    elMensagens.appendChild(renderizarMensagem(msg, souEu));
  });

  if (elDigitando) elMensagens.appendChild(elDigitando);

  const ultima = mensagens[mensagens.length - 1];
  const chegouCoisaNova = ultima && ultima.timestampMs > ultimoTsRenderizado;
  if (ultima) ultimoTsRenderizado = ultima.timestampMs;

  if (coladoNoFim || chegouCoisaNova) {
    elMensagens.scrollTop = elMensagens.scrollHeight;
  }

  marcarComoLido();
}

function marcarComoLido() {
  if (!chatId) return;
  try {
    localStorage.setItem(`last_read_${chatId}`, String(Date.now()));
  } catch (_) {}
}

// ==========================================================================
// STATUS DO CONTATO (ONLINE / VISTO POR ÚLTIMO) — só em chat direto
// ==========================================================================

function mostrarOnline() {
  clearTimeout(timerStatus);
  elStatus.textContent = "Online";
  elStatus.style.color = "#00a884";
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
  elStatus.textContent = relativo ? `Visto ${relativo}` : "Offline";
  elStatus.style.color = "var(--text-sec)";
}

function pedirStatus() {
  elStatus.textContent = "…";
  elStatus.style.color = "var(--text-sec)";

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
    esconderDigitando();
    // A mensagem em si chega pelo Firestore; aqui só reagimos ao sinal.
    if (!modoGrupo) mostrarOnline();
    return;
  }

  if (msg.type === "digitando") {
    mostrarDigitando();
    clearTimeout(window.__timeoutDigitando);
    window.__timeoutDigitando = setTimeout(esconderDigitando, 2500);
  }
});

// Ao (re)conectar, pergunta o status de novo — inclusive depois de o servidor
// gratuito acordar. Não se aplica a grupos (sem presença individual).
window.addEventListener("radar_conectado", () => { if (!modoGrupo) pedirStatus(); });

function mostrarDigitando() {
  if (!elDigitando) return;
  elDigitando.style.display = "flex";
  elMensagens.appendChild(elDigitando);
  elMensagens.scrollTop = elMensagens.scrollHeight;
}

function esconderDigitando() {
  if (elDigitando) elDigitando.style.display = "none";
}

// ==========================================================================
// ENVIO
// ==========================================================================

let ultimoAvisoDigitando = 0;

function aoDigitar() {
  atualizarBotoesDeEnvio();

  // Em grupo, um evento "digitando" viraria N mensagens WebSocket (uma por
  // participante) a cada tecla — o limite de taxa da conexão é por conexão,
  // não por destinatário, então isso estouraria rápido num grupo com mais de
  // uma dúzia de pessoas. Melhor não anunciar "digitando" em grupo por
  // enquanto do que arriscar a conexão cair.
  if (modoGrupo) return;

  // No máximo um aviso por segundo, em vez de um a cada tecla.
  const agora = Date.now();
  if (agora - ultimoAvisoDigitando > 1000) {
    ultimoAvisoDigitando = agora;
    Radar.emit({ type: "digitando", to: outroUsuario });
  }
}

function atualizarBotoesDeEnvio() {
  const temTexto = elTexto.value.trim().length > 0;
  const acoes = document.getElementById("action-buttons");
  const btnEnviar = document.getElementById("btnEnviar");
  if (acoes) acoes.style.display = temTexto ? "none" : "flex";
  if (btnEnviar) btnEnviar.style.display = temTexto ? "flex" : "none";
}

async function enviar(conteudo = null, tipo = "texto") {
  const texto = conteudo ?? elTexto.value.trim();
  if (!texto) return;

  // Mídia (áudio/imagem) não carrega o contexto de resposta — só texto.
  const respostaEnviada = conteudo === null ? respondendoA : null;

  if (conteudo === null) {
    elTexto.value = "";
    atualizarBotoesDeEnvio();
    cancelarResposta();
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
      if (respostaEnviada) {
        respondendoA = respostaEnviada;
        if (elRespostaAutor) elRespostaAutor.textContent = nomeDeExibicao(respostaEnviada.autor);
        if (elRespostaTexto) elRespostaTexto.textContent = resumo(respostaEnviada.tipo, respostaEnviada.texto);
        if (elRespostaPreview) elRespostaPreview.style.display = "flex";
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
  await uploadBytes(destino, arquivo);
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
      const blob = new Blob(pedacos, { type: "audio/webm" });
      const url = await subirArquivo("audios", blob, "webm");
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
      const url = await subirArquivo("imagens", arquivo, "jpg");
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

  const url = new URLSearchParams({ u: outroUsuario, papel: "emissor" });
  if (tipo === "audio") url.set("audio", "true");
  window.location.href = `chamada.html?${url.toString()}`;
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
  elStatus.style.color = "var(--text-sec)";
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
  sessaoAtual = await sessao();
  montarAvatarNav();

  try {
    if (modoGrupo) await iniciarComoGrupo();
    else await iniciarComoDireto();
  } catch (_) {
    return; // erro já tratado e avisado dentro da função específica
  }

  pararDeEscutar = escutarMensagens(chatId, atualizarDOM);
}

// --------------------------------------------------------------------------
// Ligação dos eventos: sem onclick no HTML, para o CSP poder recusar
// 'unsafe-inline' em script-src.
// --------------------------------------------------------------------------

elTexto?.addEventListener("input", aoDigitar);
elTexto?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    enviar();
  }
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
document.querySelector('[data-acao="abrir-perfil"]')?.addEventListener("click", () => {
  if (modoGrupo) {
    Core.aviso("Informações do grupo em breve.", "#e0a800");
    return;
  }
  window.location.href = `perfil.html?u=${encodeURIComponent(outroUsuario)}`;
});

// pagehide é mais confiável que beforeunload no Safari do iPhone, onde
// beforeunload muitas vezes não dispara.
window.addEventListener("pagehide", () => {
  if (pararDeEscutar) pararDeEscutar();
  marcarComoLido();
});

iniciar();