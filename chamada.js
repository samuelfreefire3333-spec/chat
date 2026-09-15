import Core, { sessao, definirAvatar, buscarPerfilPorUsername } from "./core.js";
import Radar from "./radar.js";
import { registrarEventoDeChamada } from "./mensagens.js";

// ==========================================================================
// CHAMADAS DE VOZ E VÍDEO (WebRTC)
// ==========================================================================

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

const elVideoRemoto = document.getElementById("videoRemoto");
const elVideoLocal = document.getElementById("videoLocal");
const elVideoLayer = document.getElementById("videoLayer");
const elContainerLocal = document.getElementById("localVideoContainer");
const elNome = document.getElementById("nomeContatoChamada");
const elFoto = document.getElementById("fotoContatoChamada");
const elStatus = document.getElementById("statusChamada");
const elAvatar = document.getElementById("avatarContainer");
const btnMute = document.getElementById("btnMute");
const btnVideo = document.getElementById("btnVideo");
const btnEncerrar = document.getElementById("btnEndCall");

let sessaoAtual = null;
let conexao = null;
let streamLocal = null;
let streamRemoto = null;
let encerrada = false;
let temporizadorLimite = null;
let cronometro = null;
let inicioDaConversa = 0;

// Candidatos que chegam antes de a descrição remota estar aplicada precisam
// esperar; adicioná-los cedo demais lança erro.
const candidatosPendentes = [];
let descricaoRemotaAplicada = false;

function definirStatus(texto) {
  if (elStatus) elStatus.textContent = texto;
}

function sinalizar(tipo, dados) {
  Radar.emit({
    type: "webrtc",
    to: outroUsuario,
    content: tipo,
    payload: dados ?? null,
  });
}

// --------------------------------------------------------------------------
// Mídia local
// --------------------------------------------------------------------------

async function capturarMidia() {
  const restricoes = {
    audio: { echoCancellation: true, noiseSuppression: true },
    video: apenasAudio ? false : { width: { ideal: 1280 }, height: { ideal: 720 } },
  };

  try {
    streamLocal = await navigator.mediaDevices.getUserMedia(restricoes);
  } catch (err) {
    console.error("Acesso à mídia negado:", err);
    if (!apenasAudio) {
      // Sem câmera, ainda dá para seguir só com voz.
      try {
        streamLocal = await navigator.mediaDevices.getUserMedia({ audio: true });
        Core.aviso("Câmera indisponível. Seguindo só com áudio.", "#e0a800");
      } catch (err2) {
        console.error("Microfone também negado:", err2);
        Core.aviso("Libere o microfone para fazer chamadas.", "#ed4956");
        encerrar(false);
        return false;
      }
    } else {
      Core.aviso("Libere o microfone para fazer chamadas.", "#ed4956");
      encerrar(false);
      return false;
    }
  }

  if (elVideoLocal && streamLocal.getVideoTracks().length) {
    elVideoLocal.srcObject = streamLocal;
    if (elVideoLayer) elVideoLayer.style.display = "block";
    if (btnVideo) btnVideo.style.display = "flex";
  }

  return true;
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
    streamRemoto = evento.streams[0];
    if (elVideoRemoto) elVideoRemoto.srcObject = streamRemoto;
    const temVideo = streamRemoto.getVideoTracks().length > 0;
    if (temVideo && elVideoLayer) {
      elVideoLayer.style.display = "block";
      if (elAvatar) elAvatar.style.display = "none";
    }
    aoConectar();
  };

  conexao.onconnectionstatechange = () => {
    switch (conexao.connectionState) {
      case "connected":
        aoConectar();
        break;
      case "disconnected":
        definirStatus("Reconectando...");
        break;
      case "failed":
        Core.aviso("A conexão caiu.", "#ed4956");
        encerrar(true);
        break;
      case "closed":
        break;
    }
  };
}

function aoConectar() {
  if (inicioDaConversa) return;
  clearTimeout(temporizadorLimite);
  inicioDaConversa = Date.now();
  cronometro = setInterval(() => {
    const s = Math.floor((Date.now() - inicioDaConversa) / 1000);
    const m = String(Math.floor(s / 60)).padStart(2, "0");
    definirStatus(`${m}:${String(s % 60).padStart(2, "0")}`);
  }, 1000);
  definirStatus("00:00");
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

async function iniciarComoEmissor() {
  definirStatus("Chamando...");
  const oferta = await conexao.createOffer();
  await conexao.setLocalDescription(oferta);
  sinalizar("oferta", { sdp: oferta.sdp, type: oferta.type });
}

async function tratarOferta(oferta) {
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
  if (conexao.signalingState !== "have-local-offer") {
    console.warn("Ignorando resposta recebida sem oferta local pendente:", conexao.signalingState);
    return;
  }

  await conexao.setRemoteDescription(new RTCSessionDescription(resposta));
  descricaoRemotaAplicada = true;
  await aplicarCandidatosPendentes();
}

window.addEventListener("mensagem_servidor", async (evento) => {
  const msg = evento.detail;
  if (!msg || msg.from !== outroUsuario) return;

  if (msg.type === "cancelar_chamada") {
    Core.aviso("A chamada foi encerrada.", "#e0a800");
    encerrar(false);
    return;
  }

  if (msg.type !== "webrtc" || !conexao) return;

  try {
    if (msg.content === "pronto") {
      // Quem atende acabou de abrir a página. Se a oferta já tinha sido
      // enviada antes disso, ela se perdeu — reenviamos.
      if (souQuemLigou && conexao.localDescription && !descricaoRemotaAplicada) {
        sinalizar("oferta", {
          sdp: conexao.localDescription.sdp,
          type: conexao.localDescription.type,
        });
      }
    } else if (msg.content === "oferta") {
      await tratarOferta(msg.payload);
    } else if (msg.content === "resposta") {
      await tratarResposta(msg.payload);
    } else if (msg.content === "ice") {
      if (descricaoRemotaAplicada) {
        await conexao.addIceCandidate(new RTCIceCandidate(msg.payload));
      } else {
        candidatosPendentes.push(msg.payload);
      }
    }
  } catch (err) {
    console.error("Erro na sinalização WebRTC:", err);
  }
});

// Se quem atende só abriu a página depois, avisa que já está pronto para
// receber a oferta.
window.addEventListener("radar_conectado", () => {
  if (!souQuemLigou && conexao) sinalizar("pronto", null);
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
  btnMute?.setAttribute("aria-label", mudo ? "Ativar microfone" : "Desativar microfone");
  btnMute?.setAttribute("aria-pressed", mudo ? "true" : "false");
}

function alternarVideo() {
  if (!streamLocal) return;
  const faixas = streamLocal.getVideoTracks();
  if (!faixas.length) return;
  cameraDesligada = !cameraDesligada;
  faixas.forEach((f) => { f.enabled = !cameraDesligada; });
  btnVideo?.classList.toggle("active-muted", cameraDesligada);
  btnVideo?.setAttribute("aria-label", cameraDesligada ? "Ligar câmera" : "Desligar câmera");
  btnVideo?.setAttribute("aria-pressed", cameraDesligada ? "true" : "false");
  if (elContainerLocal) elContainerLocal.style.display = cameraDesligada ? "none" : "block";
}

/**
 * Encerra a chamada e libera câmera e microfone. Sem isso o LED da câmera
 * continua aceso depois de sair da página.
 */
async function encerrar(avisarOutroLado = true) {
  if (encerrada) return;
  encerrada = true;

  clearTimeout(temporizadorLimite);
  clearInterval(cronometro);

  if (avisarOutroLado) {
    Radar.emit({ type: "cancelar_chamada", to: outroUsuario });
  }

  streamLocal?.getTracks().forEach((f) => f.stop());
  streamRemoto?.getTracks().forEach((f) => f.stop());

  if (conexao) {
    conexao.onicecandidate = null;
    conexao.ontrack = null;
    conexao.onconnectionstatechange = null;
    conexao.close();
    conexao = null;
  }

  try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
  window.location.replace(`chat.html?u=${encodeURIComponent(outroUsuario)}`);
}

btnMute?.addEventListener("click", alternarMicrofone);
btnVideo?.addEventListener("click", alternarVideo);
btnEncerrar?.addEventListener("click", () => encerrar(true));

// Sair da página por qualquer caminho precisa desligar a mídia.
window.addEventListener("pagehide", () => {
  streamLocal?.getTracks().forEach((f) => f.stop());
  conexao?.close();
});

// --------------------------------------------------------------------------
// Inicialização
// --------------------------------------------------------------------------

async function iniciar() {
  sessaoAtual = await sessao();

  if (sessaoAtual.username === outroUsuario) {
    window.location.replace("inbox.html");
    return;
  }

  elNome.textContent = outroUsuario;

  try {
    const perfil = await buscarPerfilPorUsername(outroUsuario);
    if (perfil?.nome) elNome.textContent = perfil.nome;
    if (perfil?.foto) definirAvatar(elFoto, perfil.foto);
  } catch (err) {
    console.error("Erro ao carregar o contato:", err);
  }

  if (!(await capturarMidia())) return;

  criarConexao();

  if (souQuemLigou) {
    await iniciarComoEmissor();
    temporizadorLimite = setTimeout(async () => {
      if (inicioDaConversa) return;
      Core.aviso("Ninguém atendeu.", "#e0a800");
      await registrarEventoDeChamada(
        sessaoAtual,
        outroUsuario,
        apenasAudio ? "📞 Chamada de voz não atendida" : "📹 Chamada de vídeo não atendida"
      );
      encerrar(true);
    }, TEMPO_LIMITE_ATENDER);
  } else {
    definirStatus("Conectando...");
    // A oferta pode ter sido enviada antes desta página abrir; avisamos que
    // já estamos prontos para que ela seja reenviada, se necessário.
    sinalizar("pronto", null);
  }
}

iniciar();