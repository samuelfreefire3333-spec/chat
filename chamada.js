import Core, { sessao, definirAvatar, buscarPerfilPorUsername, AVATAR_PADRAO, urlSegura, mostrar } from "./core.js";
import Radar from "./radar.js";
import { registrarEventoDeChamada } from "./mensagens.js";
import {
  NOME_JANELA_CHAMADA, publicarEstadoDaChamada, limparEstadoDaChamada, ouvirJanelas,
} from "./chamada-flutuante.js";

// ==========================================================================
// CHAMADAS DE VOZ E VÍDEO (WebRTC)
// ==========================================================================
// Estados (data-estado em .call-wrapper, que o CSS usa para a aparência):
//   preparando   pedindo câmera e microfone
//   chamando     oferta enviada, o aparelho da outra pessoa ainda não deu sinal
//   tocando      está tocando lá (ou "em outra chamada")
//   conectando   atendeu; trocando os últimos dados da conexão
//   conectada    em chamada (cronômetro)
//   reconectando a rede oscilou; tentando retomar sem derrubar
//   encerrada    tela final, antes de fechar a janela

const params = new URLSearchParams(window.location.search);
const outroUsuario = (params.get("u") || "").toLowerCase().trim();
const apenasAudio = params.get("audio") === "true";
const souQuemLigou = params.get("papel") !== "receptor";

if (!outroUsuario) window.location.replace("inbox.html");

const CONFIG_ICE = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ],
};

const TEMPO_LIMITE_ATENDER = 45000;
// Quem atendeu também precisa de um teto: se a oferta nunca chegar (o outro
// lado desistiu, ficou sem rede, fechou a aba), a tela ficava presa em
// "Conectando..." para sempre.
const TEMPO_LIMITE_RECEPTOR = 30000;
// Rede oscilando: quanto tempo tentamos retomar antes de desistir.
const TEMPO_PARA_DESISTIR = 20000;
const TEMPO_TELA_FINAL = 1600;
const TEMPO_OCULTAR_CONTROLES = 4000;

const $ = (id) => document.getElementById(id);
const elWrapper = $("callWrapper");
const elFundo = $("chamadaFundo");
const elVideoRemoto = $("videoRemoto");
const elAudioRemoto = $("audioRemoto");
const elVideoLocal = $("videoLocal");
const elContainerLocal = $("localVideoContainer");
const elNome = $("nomeContatoChamada");
const elFoto = $("fotoContatoChamada");
const elStatus = $("statusChamada");
const elMudoRemoto = $("indicadorMudoRemoto");
const elAvisoSom = $("avisoSom");
const elFim = $("chamadaFim");
const elFimTitulo = $("fimTitulo");
const elFimDetalhe = $("fimDetalhe");
const elAvisoPip = $("avisoPip");
const btnMute = $("btnMute");
const btnVideo = $("btnVideo");
const btnEncerrar = $("btnEndCall");
const btnPip = $("btnPip");
const btnVirarCamera = $("btnVirarCamera");
const btnAtivarSom = $("btnAtivarSom");
const btnTrazerDeVolta = $("btnTrazerDeVolta");

let sessaoAtual = null;
let conexao = null;
let streamLocal = null;
let streamRemoto = null;
let encerrada = false;
let estado = "preparando";
let outroOcupado = false;
let inicioDaConversa = 0;

let temporizadorLimite = null;
let cronometro = null;
let sinalDeVida = null;
let reenvioDeOferta = null;
let timerRecuperacao = null;
let timerDesistencia = null;
let reiniciosIce = 0;

// Esta página está na janela dedicada à chamada (aberta por window.open) ou
// foi carregada na aba principal? No primeiro caso, encerrar fecha a janela;
// no segundo, volta para a conversa como antes.
const emJanelaPropria = window.name === NOME_JANELA_CHAMADA || !!window.opener;

// Dados do contato, usados na barra flutuante das outras telas e no quadro do
// Picture-in-Picture de chamada de voz.
let nomeDoContato = "";
let fotoDoContato = AVATAR_PADRAO;

// Candidatos que chegam antes de a descrição remota estar aplicada precisam
// esperar; adicioná-los cedo demais lança erro.
const candidatosPendentes = [];
let descricaoRemotaAplicada = false;

// Estado da outra ponta (microfone/câmera), anunciado por ela.
let micRemotoLigado = true;
let camRemotaLigada = true;

// O aparelho da outra pessoa pode avisar que está tocando antes de esta
// janela terminar de preparar a câmera: o aviso fica guardado.
let toqueRecebido = null; // { ocupado }

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function formatarDuracao(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const horas = Math.floor(total / 3600);
  const minutos = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const segundos = String(total % 60).padStart(2, "0");
  return horas ? `${horas}:${minutos}:${segundos}` : `${minutos}:${segundos}`;
}

// --------------------------------------------------------------------------
// Estado e textos
// --------------------------------------------------------------------------

function textoDoEstado() {
  switch (estado) {
    case "preparando": return "Preparando…";
    case "chamando": return "Chamando…";
    case "tocando": return outroOcupado ? "Em outra chamada…" : "Tocando…";
    case "conectando": return "Conectando…";
    case "conectada": return formatarDuracao(Date.now() - inicioDaConversa);
    case "reconectando": return "Reconectando…";
    case "encerrada": return "Chamada encerrada";
    default: return "";
  }
}

function renderizarStatus() {
  if (elStatus) elStatus.textContent = textoDoEstado();
}

function definirEstado(novo) {
  if (encerrada && novo !== "encerrada") return;
  if (novo === "chamando" && toqueRecebido) {
    outroOcupado = !!toqueRecebido.ocupado;
    novo = "tocando";
  }
  if (estado === novo) return;
  estado = novo;
  elWrapper.dataset.estado = novo;
  renderizarStatus();

  if (novo === "chamando" || novo === "tocando") iniciarSomDeChamada();
  else pararSomDeChamada();

  atualizarAutoOcultar();
  publicarEstado();
}

/**
 * Conta às outras telas do app que existe uma chamada rolando. É isto que
 * alimenta a barra flutuante — sem ela, sair de chamada.html simplesmente
 * apagava qualquer vestígio de que havia uma chamada.
 */
function publicarEstado() {
  if (encerrada) return;
  publicarEstadoDaChamada({
    comQuem: outroUsuario,
    nome: nomeDoContato || `@${outroUsuario}`,
    foto: fotoDoContato,
    tipo: apenasAudio ? "audio" : "video",
    papel: souQuemLigou ? "emissor" : "receptor",
    estado,
    status: estado === "conectada" ? "em chamada" : textoDoEstado(),
    conectadaEm: inicioDaConversa,
    mudo,
    pip: !!pipAberto,
  });
}

function sinalizar(tipo, dados) {
  Radar.emit({
    type: "webrtc",
    to: outroUsuario,
    content: tipo,
    payload: dados ?? null,
  });
}

function anunciarMeuEstado() {
  sinalizar("estado", { mic: !mudo, cam: !apenasAudio && temCamera() && !cameraDesligada });
}

// --------------------------------------------------------------------------
// Som de "chamando" (quem liga ouve o tu... tu...)
// --------------------------------------------------------------------------

let somDeChamada = null;

function iniciarSomDeChamada() {
  if (!souQuemLigou || somDeChamada || encerrada) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 425; // tom de chamada brasileiro
    ganho.gain.value = 0.0001;
    osc.connect(ganho).connect(ctx.destination);
    osc.start();
    const toque = () => {
      const t = ctx.currentTime;
      ganho.gain.cancelScheduledValues(t);
      ganho.gain.setValueAtTime(0.0001, t);
      ganho.gain.exponentialRampToValueAtTime(0.06, t + 0.03);
      ganho.gain.setValueAtTime(0.06, t + 1);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t + 1.06);
    };
    toque();
    somDeChamada = { ctx, osc, intervalo: setInterval(toque, 5000) };
  } catch (_) {
    somDeChamada = null; // sem Web Audio (ou bloqueado): segue em silêncio
  }
}

function pararSomDeChamada() {
  if (!somDeChamada) return;
  clearInterval(somDeChamada.intervalo);
  try { somDeChamada.osc.stop(); } catch (_) {}
  try { somDeChamada.ctx.close(); } catch (_) {}
  somDeChamada = null;
}

// --------------------------------------------------------------------------
// Mídia local
// --------------------------------------------------------------------------

function temCamera() {
  return !!streamLocal?.getVideoTracks().length;
}

async function capturarMidia() {
  const restricoes = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: apenasAudio ? false : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
  };

  try {
    streamLocal = await navigator.mediaDevices.getUserMedia(restricoes);
  } catch (err) {
    console.error("Acesso à mídia negado:", err);
    if (!apenasAudio) {
      // Sem câmera, ainda dá para seguir só com voz.
      try {
        streamLocal = await navigator.mediaDevices.getUserMedia({ audio: true });
        Core.aviso("Câmera indisponível. Seguindo só com áudio.", "alerta");
      } catch (err2) {
        console.error("Microfone também negado:", err2);
        Core.aviso("Libere o microfone para fazer chamadas.", "erro");
        encerrar(true, "sem-midia");
        return false;
      }
    } else {
      Core.aviso("Libere o microfone para fazer chamadas.", "erro");
      encerrar(true, "sem-midia");
      return false;
    }
  }

  if (temCamera()) {
    elVideoLocal.srcObject = streamLocal;
    elVideoLocal.play().catch(() => {});
    elWrapper.dataset.videoLocal = "sim";
    mostrar(btnVideo, true);
  } else {
    elWrapper.dataset.videoLocal = "nao";
    mostrar(btnVideo, false);
  }

  detectarCameras();
  return true;
}

async function detectarCameras() {
  if (!temCamera() || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const dispositivos = await navigator.mediaDevices.enumerateDevices();
    const cameras = dispositivos.filter((d) => d.kind === "videoinput");
    mostrar(btnVirarCamera, cameras.length > 1);
  } catch (_) {}
}

let cameraFrontal = true;

async function virarCamera() {
  if (!temCamera() || !conexao) return;
  const atual = streamLocal.getVideoTracks()[0];
  const proximo = cameraFrontal ? "environment" : "user";
  let novoStream;
  try {
    novoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: proximo } } });
  } catch (_) {
    // Sem facingMode (computador com duas webcams): troca pela próxima.
    try {
      const dispositivos = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const idAtual = atual?.getSettings?.().deviceId;
      const i = dispositivos.findIndex((d) => d.deviceId === idAtual);
      const alvo = dispositivos[(i + 1) % dispositivos.length];
      novoStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: alvo.deviceId } } });
    } catch (err) {
      Core.aviso("Não foi possível trocar de câmera.", "erro");
      return;
    }
  }

  const trilha = novoStream.getVideoTracks()[0];
  trilha.enabled = !cameraDesligada;
  const emissor = conexao.getSenders().find((s) => s.track?.kind === "video");
  try { await emissor?.replaceTrack(trilha); } catch (_) {}

  if (atual) {
    streamLocal.removeTrack(atual);
    atual.stop();
  }
  streamLocal.addTrack(trilha);
  elVideoLocal.srcObject = streamLocal;
  elVideoLocal.play().catch(() => {});

  cameraFrontal = (trilha.getSettings?.().facingMode || proximo) !== "environment";
  elContainerLocal.dataset.espelhar = cameraFrontal ? "sim" : "nao";
}

// --------------------------------------------------------------------------
// Áudio e vídeo da outra ponta
// --------------------------------------------------------------------------

function tocarAudioRemoto() {
  if (!elAudioRemoto?.srcObject) return;
  elAudioRemoto.play()
    .then(() => mostrar(elAvisoSom, false))
    .catch(() => {
      // Política de reprodução automática: a janela da chamada abriu sem
      // nenhum toque nela, e o navegador pode segurar o som. Um toque libera.
      mostrar(elAvisoSom, true);
      document.addEventListener("pointerdown", tocarAudioRemoto, { once: true });
    });
}

function retomarMidia() {
  elVideoRemoto?.play().catch(() => {});
  elVideoLocal?.play().catch(() => {});
  if (elAudioRemoto?.paused && elAudioRemoto.srcObject) tocarAudioRemoto();
}

function atualizarVideoRemoto() {
  const trilhas = streamRemoto?.getVideoTracks() || [];
  const temVideo = !apenasAudio && camRemotaLigada && trilhas.some((t) => t.readyState === "live" && !t.muted);
  elWrapper.dataset.videoRemoto = temVideo ? "sim" : "nao";
  atualizarAutoOcultar();
}

function atualizarIndicadoresRemotos() {
  mostrar(elMudoRemoto, !micRemotoLigado && estado !== "encerrada");
  atualizarVideoRemoto();
}

// --------------------------------------------------------------------------
// Conexão WebRTC
// --------------------------------------------------------------------------

function criarConexao() {
  conexao = new RTCPeerConnection(CONFIG_ICE);

  streamLocal.getTracks().forEach((faixa) => conexao.addTrack(faixa, streamLocal));

  conexao.onicecandidate = (evento) => {
    if (evento.candidate) sinalizar("ice", evento.candidate.toJSON());
  };

  conexao.ontrack = (evento) => {
    const stream = evento.streams[0] || streamRemoto || new MediaStream();
    if (!evento.streams[0]) stream.addTrack(evento.track);
    if (streamRemoto !== stream) {
      streamRemoto = stream;
      elVideoRemoto.srcObject = stream;
      elAudioRemoto.srcObject = stream;
    }
    elVideoRemoto.play().catch(() => {});
    tocarAudioRemoto();

    evento.track.addEventListener("mute", atualizarVideoRemoto);
    evento.track.addEventListener("unmute", atualizarVideoRemoto);
    evento.track.addEventListener("ended", atualizarVideoRemoto);
    atualizarVideoRemoto();
  };

  conexao.onconnectionstatechange = () => {
    if (!conexao) return;
    switch (conexao.connectionState) {
      case "connected":
        clearTimeout(timerRecuperacao);
        timerRecuperacao = null;
        clearTimeout(timerDesistencia);
        timerDesistencia = null;
        reiniciosIce = 0;
        aoConectar();
        break;
      case "disconnected":
        // Pode voltar sozinho em segundos; se não voltar, pedimos um
        // reinício de ICE (novos caminhos de rede) em vez de desligar.
        if (inicioDaConversa) definirEstado("reconectando");
        agendarRecuperacao(3000);
        break;
      case "failed":
        if (inicioDaConversa) definirEstado("reconectando");
        agendarRecuperacao(0);
        break;
      default:
        break;
    }
  };
}

function agendarRecuperacao(atraso) {
  if (encerrada) return;
  if (!timerDesistencia) {
    timerDesistencia = setTimeout(() => {
      timerDesistencia = null;
      if (conexao?.connectionState === "connected") return;
      Core.aviso("A conexão caiu.", "erro");
      encerrar(true, "falha");
    }, TEMPO_PARA_DESISTIR);
  }
  if (timerRecuperacao) return;
  timerRecuperacao = setTimeout(async () => {
    timerRecuperacao = null;
    if (encerrada || !conexao || conexao.connectionState === "connected") return;
    // Só quem ligou reinicia (evita as duas pontas oferecendo ao mesmo tempo).
    if (!souQuemLigou || reiniciosIce >= 3) return;
    if (conexao.signalingState !== "stable") return;
    reiniciosIce++;
    try {
      const oferta = await conexao.createOffer({ iceRestart: true });
      await conexao.setLocalDescription(oferta);
      sinalizar("oferta", { sdp: oferta.sdp, type: oferta.type });
    } catch (err) {
      console.warn("Reinício de ICE falhou:", err);
    }
    // Se não voltar, tenta de novo daqui a pouco (até 3 vezes).
    if (conexao && conexao.connectionState !== "connected") agendarRecuperacao(5000);
  }, atraso);
}

function aoConectar() {
  if (encerrada) return;
  if (!inicioDaConversa) {
    inicioDaConversa = Date.now();
    clearTimeout(temporizadorLimite);
    clearInterval(reenvioDeOferta);
    reenvioDeOferta = null;
    clearInterval(cronometro);
    cronometro = setInterval(renderizarStatus, 1000);
    anunciarMeuEstado();
  }
  definirEstado("conectada");
  renderizarStatus();
  publicarEstado();
}

async function aplicarCandidatosPendentes() {
  while (candidatosPendentes.length) {
    const candidato = candidatosPendentes.shift();
    try {
      await conexao.addIceCandidate(new RTCIceCandidate(candidato));
    } catch (err) {
      console.warn("Candidato ICE recusado:", err);
    }
  }
}

function enviarOfertaAtual() {
  if (!conexao?.localDescription || descricaoRemotaAplicada) return;
  // localDescription já inclui os candidatos reunidos até aqui: reenviar a
  // oferta também recupera candidatos que se perderam no caminho.
  sinalizar("oferta", { sdp: conexao.localDescription.sdp, type: conexao.localDescription.type });
}

async function iniciarComoEmissor() {
  const oferta = await conexao.createOffer();
  await conexao.setLocalDescription(oferta);
  sinalizar("oferta", { sdp: oferta.sdp, type: oferta.type });

  // A sinalização é "de vida curta": se o socket desta janela ainda não
  // autenticou, ou se a outra ponta abriu a página depois, a oferta pode não
  // ter chegado. Reenviamos até a resposta vir.
  clearInterval(reenvioDeOferta);
  reenvioDeOferta = setInterval(() => {
    if (descricaoRemotaAplicada || encerrada) {
      clearInterval(reenvioDeOferta);
      reenvioDeOferta = null;
      return;
    }
    enviarOfertaAtual();
  }, 4000);
}

async function tratarOferta(oferta) {
  // A mesma oferta pode chegar repetida (ela é reenviada até a resposta
  // vir): aplicar de novo seria renegociar à toa.
  if (conexao.remoteDescription?.sdp === oferta?.sdp) return;
  if (conexao.signalingState !== "stable") {
    console.warn("Ignorando oferta recebida em estado de sinalização inválido:", conexao.signalingState);
    return;
  }

  await conexao.setRemoteDescription(new RTCSessionDescription(oferta));
  descricaoRemotaAplicada = true;
  await aplicarCandidatosPendentes();

  const resposta = await conexao.createAnswer();
  await conexao.setLocalDescription(resposta);
  sinalizar("resposta", { sdp: resposta.sdp, type: resposta.type });
}

async function tratarResposta(resposta) {
  if (conexao.remoteDescription?.sdp === resposta?.sdp) return;
  if (conexao.signalingState !== "have-local-offer") {
    console.warn("Ignorando resposta recebida sem oferta local pendente:", conexao.signalingState);
    return;
  }

  await conexao.setRemoteDescription(new RTCSessionDescription(resposta));
  descricaoRemotaAplicada = true;
  await aplicarCandidatosPendentes();
}

// A sinalização é tratada estritamente em ordem, uma de cada vez. Tratar em
// paralelo deixava duas ofertas repetidas entrarem juntas em
// setRemoteDescription, e a segunda quebrava a primeira ("Called in wrong
// state") — a chamada ficava presa em "Conectando…".
let filaDeSinalizacao = Promise.resolve();

window.addEventListener("mensagem_servidor", (evento) => {
  const msg = evento.detail;
  if (!msg || msg.from !== outroUsuario || encerrada) return;

  if (msg.type === "cancelar_chamada") {
    encerrar(false, msg.content === "recusada" ? "recusada" : "outro");
    return;
  }

  if (msg.type !== "webrtc") return;

  if (msg.content === "tocando") {
    if (!souQuemLigou || inicioDaConversa) return;
    toqueRecebido = { ocupado: !!msg.payload?.ocupado };
    if (estado === "chamando" || estado === "tocando") {
      outroOcupado = toqueRecebido.ocupado;
      estado = "";
      definirEstado("tocando");
    }
    return;
  }

  filaDeSinalizacao = filaDeSinalizacao
    .then(() => tratarSinalizacao(msg))
    .catch((err) => console.error("Erro na sinalização WebRTC:", err));
});

async function tratarSinalizacao(msg) {
  if (!conexao || encerrada) return;
  switch (msg.content) {
    case "pronto":
      // Quem atende acabou de abrir a página. Se a oferta já tinha sido
      // enviada antes disso, ela se perdeu — reenviamos.
      if (souQuemLigou) {
        if (!inicioDaConversa) definirEstado("conectando");
        enviarOfertaAtual();
      }
      break;
    case "oferta":
      await tratarOferta(msg.payload);
      break;
    case "resposta":
      await tratarResposta(msg.payload);
      break;
    case "ice":
      if (descricaoRemotaAplicada) {
        await conexao.addIceCandidate(new RTCIceCandidate(msg.payload));
      } else {
        candidatosPendentes.push(msg.payload);
      }
      break;
    case "estado":
      micRemotoLigado = msg.payload?.mic !== false;
      camRemotaLigada = msg.payload?.cam !== false;
      atualizarIndicadoresRemotos();
      break;
    default:
      break;
  }
}

// O socket desta janela (re)conectou: repete o que pode ter se perdido.
window.addEventListener("radar_conectado", () => {
  if (encerrada || !conexao) return;
  if (souQuemLigou && !inicioDaConversa) sinalizar("consultar_toque", null);
  if (souQuemLigou) enviarOfertaAtual();
  else if (!descricaoRemotaAplicada) sinalizar("pronto", null);
  if (inicioDaConversa) anunciarMeuEstado();
});

// --------------------------------------------------------------------------
// Controles
// --------------------------------------------------------------------------

let mudo = false;
let cameraDesligada = false;

function alternarMicrofone() {
  if (!streamLocal) return;
  mudo = !mudo;
  streamLocal.getAudioTracks().forEach((f) => { f.enabled = !mudo; });
  btnMute?.classList.toggle("active-muted", mudo);
  const rotulo = mudo ? "Ativar microfone" : "Desativar microfone";
  btnMute?.setAttribute("aria-label", rotulo);
  btnMute?.setAttribute("title", rotulo);
  btnMute?.setAttribute("aria-pressed", mudo ? "true" : "false");
  elWrapper.dataset.mudo = mudo ? "sim" : "nao";
  sincronizarMediaSession();
  anunciarMeuEstado();
  publicarEstado();
}

function alternarVideo() {
  if (!temCamera()) return;
  cameraDesligada = !cameraDesligada;
  streamLocal.getVideoTracks().forEach((f) => { f.enabled = !cameraDesligada; });
  btnVideo?.classList.toggle("active-muted", cameraDesligada);
  const rotulo = cameraDesligada ? "Ligar câmera" : "Desligar câmera";
  btnVideo?.setAttribute("aria-label", rotulo);
  btnVideo?.setAttribute("title", rotulo);
  btnVideo?.setAttribute("aria-pressed", cameraDesligada ? "true" : "false");
  elWrapper.dataset.cameraDesligada = cameraDesligada ? "sim" : "nao";
  sincronizarMediaSession();
  anunciarMeuEstado();
}

// Controles somem sozinhos numa chamada de vídeo (a imagem ocupa a tela
// inteira) e voltam ao primeiro toque, como nos apps de chamada conhecidos.
let timerOcultar = null;

function atualizarAutoOcultar() {
  clearTimeout(timerOcultar);
  const podeOcultar = estado === "conectada" && elWrapper.dataset.videoRemoto === "sim" && !document.body.classList.contains("chamada-no-pip");
  if (!podeOcultar) {
    elWrapper.dataset.controles = "visiveis";
    return;
  }
  timerOcultar = setTimeout(() => { elWrapper.dataset.controles = "ocultos"; }, TEMPO_OCULTAR_CONTROLES);
}

function mostrarControles() {
  if (elWrapper.dataset.controles === "ocultos") elWrapper.dataset.controles = "visiveis";
  atualizarAutoOcultar();
}

elWrapper.addEventListener("pointerdown", mostrarControles);
elWrapper.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") mostrarControles(); });
elWrapper.addEventListener("keydown", mostrarControles);

// Prévia da própria câmera: arrasta e encaixa no canto mais próximo.
(function ligarArrasteDaPrevia() {
  if (!elContainerLocal) return;
  let inicio = null;

  elContainerLocal.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const caixa = elContainerLocal.getBoundingClientRect();
    inicio = { x: e.clientX, y: e.clientY, dx: e.clientX - caixa.left, dy: e.clientY - caixa.top, moveu: false };
    elContainerLocal.setPointerCapture?.(e.pointerId);
  });

  elContainerLocal.addEventListener("pointermove", (e) => {
    if (!inicio) return;
    if (!inicio.moveu && Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y) < 6) return;
    inicio.moveu = true;
    elContainerLocal.classList.add("arrastando");
    elContainerLocal.style.left = `${e.clientX - inicio.dx}px`;
    elContainerLocal.style.top = `${e.clientY - inicio.dy}px`;
    elContainerLocal.style.right = "auto";
    elContainerLocal.style.bottom = "auto";
  });

  const soltar = (e) => {
    if (!inicio) return;
    const moveu = inicio.moveu;
    inicio = null;
    elContainerLocal.classList.remove("arrastando");
    if (!moveu) return;
    const vista = elContainerLocal.ownerDocument.defaultView || window;
    const direita = e.clientX > vista.innerWidth / 2;
    const baixo = e.clientY > vista.innerHeight / 2;
    elContainerLocal.dataset.canto = `${baixo ? "i" : "s"}${direita ? "d" : "e"}`;
    ["left", "top", "right", "bottom"].forEach((p) => elContainerLocal.style.removeProperty(p));
  };
  elContainerLocal.addEventListener("pointerup", soltar);
  elContainerLocal.addEventListener("pointercancel", soltar);
})();

// --------------------------------------------------------------------------
// PICTURE-IN-PICTURE
// --------------------------------------------------------------------------
// Dois caminhos, do melhor para o mais compatível:
//
//  1. Document Picture-in-Picture: leva a interface INTEIRA da chamada
//     (vídeo + botões de mudo, câmera e desligar) para uma janela do sistema
//     que fica por cima de qualquer programa. Hoje, Chrome/Edge no computador.
//  2. PiP clássico do elemento <video>: uma janelinha só com a imagem, mas
//     funciona em quase todo lugar, inclusive Android e Safari. Os botões de
//     microfone, câmera e desligar aparecem nela via Media Session.
//
// O som nunca passa pelo elemento que vai para o PiP (ver <audio> no HTML):
// fechar a janelinha no "x" pausa aquele vídeo, e antes isso cortava a voz —
// parecia que a chamada tinha caído.

let pipAberto = null; // null | "documento" | "video"
let canvasPip = null;
let videoDoCanvas = null;
let desenhoDoCanvas = null;

function iniciais(texto) {
  return String(texto || "").replace(/^@/, "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0]).join("").toUpperCase() || "?";
}

function desenharQuadroDeVoz() {
  if (!canvasPip) return;
  const ctx = canvasPip.getContext("2d");
  const { width: l, height: a } = canvasPip;

  const grad = ctx.createLinearGradient(0, 0, l, a);
  grad.addColorStop(0, "#1a1a20");
  grad.addColorStop(1, "#0b0b0e");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, l, a);

  // Monograma (desenhar a foto "sujaria" o canvas e o navegador recusaria
  // o fluxo de vídeo).
  ctx.fillStyle = "#e6002b";
  ctx.beginPath();
  ctx.arc(l / 2, a / 2 - 34, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 30px system-ui, sans-serif";
  ctx.fillText(iniciais(nomeDoContato || outroUsuario), l / 2, a / 2 - 33);

  ctx.textBaseline = "alphabetic";
  ctx.font = "600 24px system-ui, sans-serif";
  ctx.fillText(nomeDoContato || `@${outroUsuario}`, l / 2, a / 2 + 42);

  ctx.fillStyle = mudo ? "#ff6b81" : "#9aa0a6";
  ctx.font = "400 19px system-ui, sans-serif";
  const legenda = `${textoDoEstado()}${mudo ? " · microfone desligado" : ""}`;
  ctx.fillText(legenda, l / 2, a / 2 + 72);
}

/** Devolve um <video> com imagem, pronto para entrar em PiP. */
function videoParaPip() {
  if (elWrapper.dataset.videoRemoto === "sim" && elVideoRemoto) return elVideoRemoto;

  if (!canvasPip) {
    canvasPip = document.createElement("canvas");
    canvasPip.width = 480;
    canvasPip.height = 270;

    videoDoCanvas = document.createElement("video");
    videoDoCanvas.muted = true;
    videoDoCanvas.playsInline = true;
    videoDoCanvas.srcObject = canvasPip.captureStream(4);
    videoDoCanvas.play().catch(() => {});
  }

  desenharQuadroDeVoz();
  return videoDoCanvas;
}

function iniciarDesenhoDoCanvas() {
  if (!canvasPip || desenhoDoCanvas) return;
  desenhoDoCanvas = setInterval(desenharQuadroDeVoz, 500);
}

/** O PiP recusa um <video> que ainda não tem nenhum quadro. */
function prontoParaExibir(video) {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener("loadeddata", resolve, { once: true });
    setTimeout(resolve, 1200);
  });
}

function aoFecharPip() {
  pipAberto = null;
  clearInterval(desenhoDoCanvas);
  desenhoDoCanvas = null;
  document.body.classList.remove("chamada-no-pip");
  mostrar(elAvisoPip, false);
  retomarMidia();
  atualizarBotaoPip();
  atualizarAutoOcultar();
  publicarEstado();
}

/**
 * A janela do PiP nasce sem estilo nenhum: o CSS precisa ir junto.
 *
 * Primeiro caminho: as regras já carregadas viram uma folha construída
 * (adoptedStyleSheets). Não depende de rede, entra na mesma hora (sem piscar a
 * interface crua) e não é bloqueada pelo CSP — um <style> criado por script
 * seria, porque a janela herda o style-src 'self' desta página.
 * Sem suporte a isso, copia os <link>, como antes.
 */
function levarEstilosPara(janela) {
  try {
    const regras = [];
    for (const folha of document.styleSheets) {
      try { for (const regra of folha.cssRules) regras.push(regra.cssText); } catch (_) { /* folha de outra origem */ }
    }
    const construida = new janela.CSSStyleSheet({ baseURL: document.baseURI });
    construida.replaceSync(regras.join("\n"));
    janela.document.adoptedStyleSheets = [construida];
    return;
  } catch (_) { /* navegador sem folhas construídas */ }

  document.querySelectorAll('link[rel="stylesheet"]').forEach((original) => {
    const link = janela.document.createElement("link");
    link.rel = "stylesheet";
    link.href = original.href;
    janela.document.head.appendChild(link);
  });
}

async function abrirDocumentPip() {
  if (!window.documentPictureInPicture?.requestWindow) return false;

  const janela = await window.documentPictureInPicture.requestWindow({
    width: apenasAudio ? 340 : 380,
    height: apenasAudio ? 260 : 560,
  });

  levarEstilosPara(janela);
  janela.document.title = nomeDoContato ? `Chamada com ${nomeDoContato}` : "Chamada - Sinex Chat";

  // Leva o tema para a janela nova.
  janela.document.documentElement.className = document.documentElement.className;
  janela.document.body.className = "pip-chamada";
  janela.document.body.appendChild(elWrapper);

  // Mudar um <video> de documento pode deixá-lo pausado.
  retomarMidia();

  // A janela de origem mostra onde a chamada foi parar.
  document.body.classList.add("chamada-no-pip");
  mostrar(elAvisoPip, true);

  janela.addEventListener("pagehide", () => {
    // Fechou o PiP (no "x", em "voltar para a aba" ou pelo nosso botão): a
    // interface volta para esta janela, com a chamada intacta.
    document.body.prepend(elWrapper);
    aoFecharPip();
  }, { once: true });

  pipAberto = "documento";
  atualizarBotaoPip();
  atualizarAutoOcultar();
  publicarEstado();
  return true;
}

async function abrirPipDeVideo() {
  if (!document.pictureInPictureEnabled) {
    Core.aviso("Este navegador não permite janela flutuante.", "alerta");
    return;
  }
  const video = videoParaPip();
  await prontoParaExibir(video);
  await video.requestPictureInPicture();
  if (video === videoDoCanvas) iniciarDesenhoDoCanvas();
  pipAberto = "video";
  atualizarBotaoPip();
  publicarEstado();

  video.addEventListener("leavepictureinpicture", aoFecharPip, { once: true });
}

async function alternarPip() {
  try {
    if (pipAberto) {
      fecharPip();
      return;
    }
    if (await abrirDocumentPip()) return;
    await abrirPipDeVideo();
  } catch (err) {
    console.error("Erro ao abrir a janela flutuante:", err);
    Core.aviso("Não foi possível abrir a janela flutuante.", "erro");
  }
}

function atualizarBotaoPip() {
  if (!btnPip) return;
  const rotulo = pipAberto ? "Trazer a chamada de volta" : "Minimizar em janela flutuante";
  btnPip.setAttribute("aria-label", rotulo);
  btnPip.setAttribute("title", rotulo);
  btnPip.classList.toggle("pip-ativo", !!pipAberto);
}

function fecharPip() {
  clearInterval(desenhoDoCanvas);
  desenhoDoCanvas = null;
  try { window.documentPictureInPicture?.window?.close(); } catch (_) {}
  try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); } catch (_) {}
}

// Media Session: botões de microfone, câmera e desligar na janelinha de PiP
// do Chrome, e PiP automático ao trocar de aba quando o navegador oferece.
function configurarMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const acao = (nome, fn) => { try { ms.setActionHandler(nome, fn); } catch (_) {} };
  acao("togglemicrophone", () => alternarMicrofone());
  acao("togglecamera", () => alternarVideo());
  acao("hangup", () => encerrar(true, "voce"));
  acao("enterpictureinpicture", () => { if (!pipAberto) alternarPip(); });
  try {
    if (typeof MediaMetadata === "function") {
      ms.metadata = new MediaMetadata({ title: nomeDoContato || `@${outroUsuario}`, artist: "Sinex Chat" });
    }
  } catch (_) {}
}

function sincronizarMediaSession() {
  try { navigator.mediaSession?.setMicrophoneActive?.(!mudo); } catch (_) {}
  try { navigator.mediaSession?.setCameraActive?.(!cameraDesligada); } catch (_) {}
}

// --------------------------------------------------------------------------
// Encerramento
// --------------------------------------------------------------------------

function textoDoRegistro(motivo, duracao) {
  const rotulo = apenasAudio ? "📞 Chamada de voz" : "📹 Chamada de vídeo";
  if (duracao > 0) {
    // Quem desligou registra a duração. Se a rede derrubou, só quem ligou
    // registra — senão a conversa ganhava duas mensagens iguais.
    if (motivo === "voce" || motivo === "trocar") return `${rotulo} · ${formatarDuracao(duracao)}`;
    if (motivo === "falha" && souQuemLigou) return `${rotulo} · ${formatarDuracao(duracao)}`;
    return null;
  }
  // Não chegou a conectar: só quem ligou registra (quem recusou já registrou
  // "recusada" do lado de lá).
  if (!souQuemLigou || motivo === "recusada" || motivo === "sem-midia") return null;
  return `${rotulo} não atendida`;
}

function textoDaTelaFinal(motivo, duracao) {
  switch (motivo) {
    case "recusada": return ["Chamada recusada", ""];
    case "nao-atendida": return ["Ninguém atendeu", ""];
    case "sem-midia": return ["Sem acesso ao microfone", "Libere o microfone nas permissões do navegador."];
    case "falha": return ["A conexão caiu", duracao ? formatarDuracao(duracao) : ""];
    case "falha-conexao": return ["Não foi possível conectar", ""];
    case "outro": return duracao ? ["Chamada encerrada", formatarDuracao(duracao)] : ["Chamada cancelada", ""];
    default: return ["Chamada encerrada", duracao ? formatarDuracao(duracao) : ""];
  }
}

function liberarMidia() {
  streamLocal?.getTracks().forEach((f) => f.stop());
  streamRemoto?.getTracks().forEach((f) => f.stop());
  if (conexao) {
    conexao.onicecandidate = null;
    conexao.ontrack = null;
    conexao.onconnectionstatechange = null;
    try { conexao.close(); } catch (_) {}
    conexao = null;
  }
  try { elAudioRemoto.pause(); } catch (_) {}
}

function sairDaTela() {
  // Na janela dedicada, o certo é fechar — voltar para a conversa ali dentro
  // deixaria uma janelinha órfã com um chat inutilizável.
  if (emJanelaPropria) {
    window.close();
    // Se o navegador recusar fechar (acontece quando a janela não foi aberta
    // por script), pelo menos leva para a conversa.
    setTimeout(() => {
      window.location.replace(`chat.html?u=${encodeURIComponent(outroUsuario)}`);
    }, 400);
    return;
  }
  window.location.replace(`chat.html?u=${encodeURIComponent(outroUsuario)}`);
}

/**
 * Encerra a chamada e libera câmera e microfone. Sem isso o LED da câmera
 * continua aceso depois de sair da página.
 *
 * motivo: "voce" | "outro" | "recusada" | "nao-atendida" | "falha" |
 *         "falha-conexao" | "sem-midia" | "trocar"
 */
async function encerrar(avisarOutroLado = true, motivo = "voce", { proxima = null } = {}) {
  if (encerrada) return;
  const duracao = inicioDaConversa ? Date.now() - inicioDaConversa : 0;

  definirEstado("encerrada");
  encerrada = true;

  clearTimeout(temporizadorLimite);
  clearTimeout(timerRecuperacao);
  clearTimeout(timerDesistencia);
  clearTimeout(timerOcultar);
  clearInterval(cronometro);
  clearInterval(sinalDeVida);
  clearInterval(reenvioDeOferta);
  pararSomDeChamada();
  fecharPip();
  limparEstadoDaChamada();

  if (avisarOutroLado) {
    Radar.emit({ type: "cancelar_chamada", to: outroUsuario, content: duracao ? "encerrada" : "cancelada" });
  }

  liberarMidia();

  const [titulo, detalhe] = textoDaTelaFinal(motivo, duracao);
  if (elFimTitulo) elFimTitulo.textContent = titulo;
  if (elFimDetalhe) elFimDetalhe.textContent = detalhe;
  mostrar(elFim, true);
  mostrar(elMudoRemoto, false);

  const registro = textoDoRegistro(motivo, duracao);
  if (registro && sessaoAtual) {
    await Promise.race([registrarEventoDeChamada(sessaoAtual, outroUsuario, registro), esperar(3000)]);
  }

  await esperar(TEMPO_TELA_FINAL);

  if (proxima) {
    // Chamada em espera atendida: esta mesma janela vira a chamada nova.
    window.location.replace(`chamada.html?${proxima}`);
    return;
  }
  sairDaTela();
}

btnMute?.addEventListener("click", alternarMicrofone);
btnVideo?.addEventListener("click", alternarVideo);
btnEncerrar?.addEventListener("click", () => encerrar(true, "voce"));
btnPip?.addEventListener("click", alternarPip);
btnVirarCamera?.addEventListener("click", virarCamera);
btnAtivarSom?.addEventListener("click", tocarAudioRemoto);
btnTrazerDeVolta?.addEventListener("click", fecharPip);

// Pedidos de outras telas (barra flutuante, chamada em espera).
ouvirJanelas((dados) => {
  if (encerrada) return;
  if (dados.tipo === "encerrar") encerrar(true, "voce");
  if (dados.tipo === "restaurar") {
    if (pipAberto) fecharPip();
    try { window.focus(); } catch (_) {}
  }
  if (dados.tipo === "atender-outra" && dados.params) encerrar(true, "trocar", { proxima: String(dados.params) });
});

// Sair da página por qualquer caminho precisa desligar a mídia — e avisar o
// outro lado, que antes ficava olhando uma imagem congelada até a conexão
// expirar sozinha.
function aoSairDaPagina() {
  if (encerrada) return;
  encerrada = true;
  Radar.emit({ type: "cancelar_chamada", to: outroUsuario, content: inicioDaConversa ? "encerrada" : "cancelada" });
  clearInterval(sinalDeVida);
  pararSomDeChamada();
  liberarMidia();
  // Fechar a janela no "x" também precisa apagar a barra das outras telas.
  limparEstadoDaChamada();
}
window.addEventListener("pagehide", aoSairDaPagina);
window.addEventListener("beforeunload", aoSairDaPagina);

// --------------------------------------------------------------------------
// Inicialização
// --------------------------------------------------------------------------

function aplicarFotoDeFundo(url) {
  const segura = urlSegura(url, "");
  if (!segura || !elFundo) return;
  // CSSOM (e não um atributo style=""): o CSP permite.
  elFundo.style.setProperty("--foto-contato", `url(${JSON.stringify(segura)})`);
  elWrapper.dataset.fundo = "foto";
}

async function iniciar() {
  // location.replace() não interrompe a execução do script: sem esta saída,
  // iniciar() continuava rodando (e pedindo câmera e microfone) durante o
  // redirecionamento de uma URL sem o parâmetro "u".
  if (!outroUsuario) return;

  elWrapper.dataset.tipo = apenasAudio ? "audio" : "video";
  elWrapper.dataset.videoRemoto = "nao";
  elWrapper.dataset.controles = "visiveis";
  elContainerLocal.dataset.espelhar = "sim";
  renderizarStatus();

  sessaoAtual = await sessao();

  if (sessaoAtual.username === outroUsuario) {
    window.location.replace("inbox.html");
    return;
  }

  elNome.textContent = `@${outroUsuario}`;
  nomeDoContato = `@${outroUsuario}`;

  try {
    const perfil = await buscarPerfilPorUsername(outroUsuario);
    if (perfil?.nome) {
      elNome.textContent = perfil.nome;
      nomeDoContato = perfil.nome;
    }
    if (perfil?.foto) {
      fotoDoContato = perfil.foto;
      definirAvatar(elFoto, perfil.foto);
      aplicarFotoDeFundo(perfil.foto);
    }
  } catch (err) {
    console.error("Erro ao carregar o contato:", err);
  }
  document.title = `${nomeDoContato} - Chamada`;

  configurarMediaSession();
  atualizarBotaoPip();

  if (!(await capturarMidia())) return;
  if (encerrada) {
    // Encerrada (por exemplo, pela barra) enquanto o navegador pedia a câmera.
    liberarMidia();
    return;
  }

  criarConexao();
  sincronizarMediaSession();

  // Chamada de voz não tem faixa de vídeo: o quadro do PiP é desenhado num
  // canvas. Preparar isso já deixa o botão instantâneo — pedir PiP depois de
  // uma espera faria o navegador considerar que o clique já "passou".
  if (apenasAudio) videoParaPip();

  // A barra flutuante das outras telas vive deste sinal: enquanto ele chega,
  // o app inteiro sabe que existe uma chamada em andamento. Se esta janela
  // morrer de repente, o sinal para e a barra some sozinha.
  publicarEstado();
  clearInterval(sinalDeVida);
  sinalDeVida = setInterval(publicarEstado, 3000);

  if (souQuemLigou) {
    definirEstado("chamando");
    // O "tocando" do outro aparelho pode ter saído antes de o socket desta
    // janela conectar. Perguntamos de novo (o balão responde).
    sinalizar("consultar_toque", null);
    await iniciarComoEmissor();
    temporizadorLimite = setTimeout(() => {
      if (inicioDaConversa || encerrada) return;
      encerrar(true, "nao-atendida");
    }, TEMPO_LIMITE_ATENDER);
  } else {
    definirEstado("conectando");
    // A oferta pode ter sido enviada antes desta página abrir; avisamos que
    // já estamos prontos para que ela seja reenviada, se necessário.
    sinalizar("pronto", null);

    temporizadorLimite = setTimeout(() => {
      if (inicioDaConversa || encerrada) return;
      encerrar(true, "falha-conexao");
    }, TEMPO_LIMITE_RECEPTOR);
  }
}

iniciar();
