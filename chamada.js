import Core, { sessao, definirAvatar, buscarPerfilPorUsername, AVATAR_PADRAO } from "./core.js";
import Radar from "./radar.js";
import { registrarEventoDeChamada } from "./mensagens.js";
import {
  NOME_JANELA_CHAMADA, canalDeChamada,
  publicarEstadoDaChamada, limparEstadoDaChamada,
} from "./chamada-flutuante.js";

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
// Quem atendeu também precisa de um teto: se a oferta nunca chegar (o outro
// lado desistiu, ficou sem rede, fechou a aba), a tela ficava presa em
// "Conectando..." para sempre, sem nenhum caminho de saída além do botão de
// encerrar.
const TEMPO_LIMITE_RECEPTOR = 45000;

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
const btnPip = document.getElementById("btnPip");

let sessaoAtual = null;
let conexao = null;
let streamLocal = null;
let streamRemoto = null;
let encerrada = false;
let temporizadorLimite = null;
let cronometro = null;
let inicioDaConversa = 0;

// Esta página está na janela dedicada à chamada (aberta por window.open) ou
// foi carregada na aba principal? No primeiro caso, encerrar fecha a janela;
// no segundo, volta para a conversa como antes.
const emJanelaPropria = window.name === NOME_JANELA_CHAMADA || !!window.opener;

// Dados do contato, usados na barra flutuante das outras telas e no quadro do
// Picture-in-Picture de chamada de voz.
let nomeDoContato = "";
let fotoDoContato = AVATAR_PADRAO;
let sinalDeVida = null;

// Candidatos que chegam antes de a descrição remota estar aplicada precisam
// esperar; adicioná-los cedo demais lança erro.
const candidatosPendentes = [];
let descricaoRemotaAplicada = false;

function definirStatus(texto) {
  if (elStatus) elStatus.textContent = texto;
}

/**
 * Conta às outras telas do app que existe uma chamada rolando. É isto que
 * alimenta a barra flutuante — sem ela, sair de chamada.html simplesmente
 * apagava qualquer vestígio de que havia uma chamada.
 */
function publicarEstado(status) {
  if (encerrada) return;
  publicarEstadoDaChamada({
    comQuem: outroUsuario,
    nome: nomeDoContato || `@${outroUsuario}`,
    foto: fotoDoContato,
    tipo: apenasAudio ? "audio" : "video",
    papel: souQuemLigou ? "emissor" : "receptor",
    status: status || (inicioDaConversa ? "em chamada" : "chamando…"),
    conectadaEm: inicioDaConversa,
  });
}

// Encerrar a chamada a partir da barra flutuante de outra tela.
canalDeChamada()?.addEventListener("message", (evento) => {
  if (evento.data?.tipo === "encerrar") encerrar(true);
});

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
    if (elVideoRemoto) {
      elVideoRemoto.srcObject = streamRemoto;
      // O atributo autoplay não basta: a política de reprodução automática do
      // navegador bloqueia mídia com som numa página que ainda não recebeu
      // nenhum toque — e quem atende chega aqui vindo de OUTRA página, então
      // esta não tem gesto nenhum registrado. O resultado era a chamada
      // conectar normalmente e simplesmente não sair som nenhum.
      elVideoRemoto.play().catch(() => {
        definirStatus("Toque na tela para ouvir");
        const liberar = () => {
          elVideoRemoto.play().catch(() => {});
          document.removeEventListener("pointerdown", liberar);
        };
        document.addEventListener("pointerdown", liberar, { once: true });
      });
    }
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
  publicarEstado("em chamada");
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

// --------------------------------------------------------------------------
// PICTURE-IN-PICTURE
// --------------------------------------------------------------------------
// Dois caminhos, do melhor para o mais compatível:
//
//  1. Document Picture-in-Picture: leva a interface INTEIRA da chamada
//     (vídeo + botões de mudo, câmera e desligar) para uma janela do sistema
//     que fica por cima de qualquer programa. Hoje só o Chrome/Edge no
//     computador.
//  2. PiP clássico do elemento <video>: uma janelinha só com a imagem, mas
//     funciona em quase todo lugar, inclusive Android e Safari.
//
// Em chamada de voz não existe faixa de vídeo, e o PiP exige uma. Nesse caso
// desenhamos o nome e o cronômetro num canvas e usamos o fluxo dele.

let pipAberto = false;
let canvasPip = null;
let videoDoCanvas = null;
let desenhoDoCanvas = null;

function desenharQuadroDeVoz() {
  if (!canvasPip) return;
  const ctx = canvasPip.getContext("2d");
  const { width: l, height: a } = canvasPip;

  ctx.fillStyle = "#101014";
  ctx.fillRect(0, 0, l, a);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = "600 30px system-ui, sans-serif";
  ctx.fillText(nomeDoContato || `@${outroUsuario}`, l / 2, a / 2 - 6);

  let legenda = "chamando…";
  if (inicioDaConversa) {
    const s = Math.floor((Date.now() - inicioDaConversa) / 1000);
    legenda = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  ctx.fillStyle = "#9aa0a6";
  ctx.font = "400 22px system-ui, sans-serif";
  ctx.fillText(legenda, l / 2, a / 2 + 34);
}

/** Devolve um <video> com imagem, pronto para entrar em PiP. */
function videoParaPip() {
  if (streamRemoto?.getVideoTracks().length && elVideoRemoto) return elVideoRemoto;

  if (!canvasPip) {
    canvasPip = document.createElement("canvas");
    canvasPip.width = 480;
    canvasPip.height = 270;

    videoDoCanvas = document.createElement("video");
    // Mudo de propósito: o som da chamada continua saindo pelo vídeo remoto
    // desta janela, que segue aberta atrás do PiP.
    videoDoCanvas.muted = true;
    videoDoCanvas.playsInline = true;
    videoDoCanvas.srcObject = canvasPip.captureStream(2);
    videoDoCanvas.play().catch(() => {});
  }

  desenharQuadroDeVoz();
  return videoDoCanvas;
}

/** O quadro só precisa ser redesenhado enquanto a janelinha está aberta. */
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

async function abrirDocumentPip() {
  const raiz = document.querySelector(".call-wrapper");
  if (!raiz || !window.documentPictureInPicture?.requestWindow) return false;

  const janela = await window.documentPictureInPicture.requestWindow({
    width: 380,
    height: 560,
  });

  // A janela do PiP nasce sem estilo nenhum: o CSS precisa ir junto.
  //
  // Copiamos os <link> e não as regras dentro de um <style>: a janela herda o
  // CSP desta página, e lá o style-src é 'self' — um bloco de estilo criado
  // por script seria recusado, mesmo sendo nosso.
  document.querySelectorAll('link[rel="stylesheet"]').forEach((original) => {
    const link = janela.document.createElement("link");
    link.rel = "stylesheet";
    link.href = original.href;
    janela.document.head.appendChild(link);
  });

  // Leva o tema (claro/escuro) para a janela nova.
  janela.document.documentElement.className = document.documentElement.className;
  janela.document.body.className = "pip-chamada";
  janela.document.body.appendChild(raiz);

  // Mudar um <video> de documento pode deixá-lo pausado.
  elVideoRemoto?.play().catch(() => {});
  elVideoLocal?.play().catch(() => {});

  // A janela de origem fica vazia enquanto isso; o aviso explica por quê.
  document.body.classList.add("chamada-no-pip");

  janela.addEventListener("pagehide", () => {
    // Fechou o PiP: a interface volta para a janela de origem.
    document.body.classList.remove("chamada-no-pip");
    document.body.appendChild(raiz);
    elVideoRemoto?.play().catch(() => {});
    elVideoLocal?.play().catch(() => {});
    pipAberto = false;
    atualizarBotaoPip();
  });

  pipAberto = true;
  atualizarBotaoPip();
  return true;
}

async function alternarPip() {
  try {
    if (pipAberto && window.documentPictureInPicture?.window) {
      window.documentPictureInPicture.window.close();
      return;
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }

    if (await abrirDocumentPip()) return;

    if (!document.pictureInPictureEnabled) {
      Core.aviso("Este navegador não permite janela flutuante.", "#e0a800");
      return;
    }

    const video = videoParaPip();
    await prontoParaExibir(video);
    await video.requestPictureInPicture();
    iniciarDesenhoDoCanvas();
    pipAberto = true;
    atualizarBotaoPip();

    video.addEventListener("leavepictureinpicture", () => {
      pipAberto = false;
      clearInterval(desenhoDoCanvas);
      desenhoDoCanvas = null;
      atualizarBotaoPip();
    }, { once: true });
  } catch (err) {
    console.error("Erro ao abrir a janela flutuante:", err);
    Core.aviso("Não foi possível abrir a janela flutuante.", "#ed4956");
  }
}

function atualizarBotaoPip() {
  if (!btnPip) return;
  const rotulo = pipAberto ? "Trazer a chamada de volta" : "Minimizar em janela flutuante";
  btnPip.setAttribute("aria-label", rotulo);
  btnPip.setAttribute("title", rotulo);
  btnPip.classList.toggle("active-muted", pipAberto);
}

function fecharPip() {
  clearInterval(desenhoDoCanvas);
  desenhoDoCanvas = null;
  try { window.documentPictureInPicture?.window?.close(); } catch (_) {}
  try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (_) {}
  pipAberto = false;
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
  clearInterval(sinalDeVida);
  fecharPip();
  limparEstadoDaChamada();

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

  // Na janela dedicada, o certo é fechar — voltar para a conversa ali dentro
  // deixaria uma janelinha órfã com um chat inutilizável.
  if (emJanelaPropria) {
    window.close();
    // Se o navegador recusar fechar (acontece quando a janela não foi aberta
    // por script), pelo menos leva para a conversa.
    setTimeout(() => {
      window.location.replace(`chat.html?u=${encodeURIComponent(outroUsuario)}`);
    }, 300);
    return;
  }

  window.location.replace(`chat.html?u=${encodeURIComponent(outroUsuario)}`);
}

btnMute?.addEventListener("click", alternarMicrofone);
btnVideo?.addEventListener("click", alternarVideo);
btnEncerrar?.addEventListener("click", () => encerrar(true));
btnPip?.addEventListener("click", alternarPip);

// Sair da página por qualquer caminho precisa desligar a mídia.
window.addEventListener("beforeunload", () => {
  streamLocal?.getTracks().forEach((f) => f.stop());
  conexao?.close();
  clearInterval(sinalDeVida);
  // Fechar a janela no "x" também precisa apagar a barra das outras telas.
  if (!encerrada) limparEstadoDaChamada();
});

// --------------------------------------------------------------------------
// Inicialização
// --------------------------------------------------------------------------

async function iniciar() {
  // location.replace() não interrompe a execução do script: sem esta saída,
  // iniciar() continuava rodando (e pedindo câmera e microfone) durante o
  // redirecionamento de uma URL sem o parâmetro "u".
  if (!outroUsuario) return;

  sessaoAtual = await sessao();

  if (sessaoAtual.username === outroUsuario) {
    window.location.replace("inbox.html");
    return;
  }

  elNome.textContent = outroUsuario;
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
    }
  } catch (err) {
    console.error("Erro ao carregar o contato:", err);
  }

  atualizarBotaoPip();

  if (!(await capturarMidia())) return;

  criarConexao();

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

    temporizadorLimite = setTimeout(() => {
      if (inicioDaConversa) return;
      Core.aviso("Não foi possível completar a chamada.", "#e0a800");
      encerrar(true);
    }, TEMPO_LIMITE_RECEPTOR);
  }
}

iniciar();