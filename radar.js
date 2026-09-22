import Core, { sessao, urlSegura, AVATAR_PADRAO, buscarPerfilPorUsername } from "./core.js";
import { registrarEventoDeChamada } from "./mensagens.js";
import { abrirJanelaDeChamada, ligarBarraDeChamada } from "./chamada-flutuante.js";

const URL_BACKEND = "wss://sinex-backend-go.onrender.com/ws";

// Mesmo host do WebSocket, mas em HTTP — usado pelos poucos endpoints
// administrativos do backend (hoje só /admin/kick, ver admin.js).
export const URL_BACKEND_HTTP = "https://sinex-backend-go.onrender.com";

const DURACAO_CHAMADA = 30000; // tempo para atender antes de virar perdida
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;

// ==========================================================================
// CONEXÃO
// ==========================================================================
// Diferenças em relação à versão anterior:
//  - o token vai numa mensagem "auth" depois do handshake, não na query string
//    (a URL aparece nos logs do servidor e em proxies);
//  - onAuthStateChanged é registrado UMA vez, no módulo. Antes era registrado a
//    cada tentativa de reconexão e nunca desinscrito, o que acumulava callbacks
//    e abria vários WebSockets em paralelo;
//  - a reconexão usa backoff exponencial com jitter, em vez de bater de 3 em 3
//    segundos para sempre enquanto o servidor gratuito acorda.

// Eventos que só fazem sentido no instante em que acontecem. Guardá-los na
// fila para reenviar depois era o que fazia "fulano está digitando..." brotar
// do nada: o servidor gratuito dorme, o cliente acumula avisos de digitação, e
// quando a conexão volta a fila inteira é despejada de uma vez do outro lado.
// O mesmo valia para sinalização de chamada, que chegava atrasada e sem
// sentido nenhum.
const TIPOS_EFEMEROS = new Set([
  "digitando",
  "parou_digitando",
  "status_check",
  "webrtc",
  "chamada",
  "cancelar_chamada",
]);

const Radar = {
  estado: "desconectado", // desconectado | conectando | conectado
  socket: null,
  fila: [],

  emit(dados) {
    if (this.estado === "conectado" && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(dados));
      return;
    }

    // Só o que ainda vale a pena entregar mais tarde entra na fila (máximo de
    // 100 itens, para não crescer sem limite offline).
    if (!TIPOS_EFEMEROS.has(dados.type) && this.fila.length < 100) {
      this.fila.push(dados);
    }
    agendarReconexao();
  },

  /** Pergunta ao servidor se alguém está online. */
  verificarStatus(username) {
    if (!username) return;
    this.emit({ type: "status_check", to: username });
  },

  encerrar() {
    pararReconexao();
    encerradoDeProposito = true;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close(1000, "logout");
      this.socket = null;
    }
    this.estado = "desconectado";
  },
};

window.Radar = Radar;
export default Radar;
export { Radar };

let tentativas = 0;
let timerReconexao = null;
let conectando = false;
let encerradoDeProposito = false;

function pararReconexao() {
  clearTimeout(timerReconexao);
  timerReconexao = null;
}

function agendarReconexao() {
  if (encerradoDeProposito || timerReconexao || conectando) return;
  if (Radar.estado === "conectado") return;

  // Exponencial com jitter: 1s, 2s, 4s... até 30s, com variação para não
  // sincronizar todos os clientes na mesma batida.
  const base = Math.min(BACKOFF_MIN * 2 ** tentativas, BACKOFF_MAX);
  const espera = base * (0.7 + Math.random() * 0.6);
  tentativas++;

  timerReconexao = setTimeout(() => {
    timerReconexao = null;
    conectar();
  }, espera);
}

async function conectar() {
  if (conectando || encerradoDeProposito) return;
  if (Radar.socket?.readyState === WebSocket.OPEN) return;
  if (!navigator.onLine) return;

  // A marcação vem ANTES do await. Antes ela vinha depois, e duas chamadas
  // quase simultâneas (visibilitychange junto com o evento "online", por
  // exemplo) passavam as duas pela checagem acima e abriam DOIS WebSockets.
  // Cada um com seu onmessage, e cada evento do servidor chegava duplicado
  // na página.
  conectando = true;
  Radar.estado = "conectando";

  const s = await sessao({ exigirLogin: false });
  if (!s) {
    conectando = false;
    Radar.estado = "desconectado";
    return;
  }

  let token;
  try {
    // Um token novo a cada conexão: o anterior expira em uma hora e a versão
    // antiga reusava para sempre o token pego no primeiro carregamento.
    token = await s.user.getIdToken();
  } catch (err) {
    console.error("Falha ao obter o token do Firebase:", err);
    conectando = false;
    agendarReconexao();
    return;
  }

  let ws;
  try {
    ws = new WebSocket(URL_BACKEND);
  } catch (err) {
    console.error("Falha ao abrir o WebSocket:", err);
    conectando = false;
    agendarReconexao();
    return;
  }

  // Um socket anterior que ainda não fechou de vez continuaria despachando
  // eventos por conta própria.
  if (Radar.socket && Radar.socket !== ws) {
    const anterior = Radar.socket;
    anterior.onmessage = null;
    anterior.onclose = null;
    anterior.onerror = null;
    try { anterior.close(1000, "substituido"); } catch (_) {}
  }

  Radar.socket = ws;

  ws.onopen = () => {
    // Autentica antes de qualquer outra coisa; o servidor derruba a conexão
    // se este quadro não chegar em 10 segundos.
    ws.send(JSON.stringify({ type: "auth", token }));
  };

  ws.onmessage = (evento) => {
    let msg;
    try {
      msg = JSON.parse(evento.data);
    } catch (_) {
      return;
    }

    if (msg.type === "auth_ok") {
      console.log("Conectado ao Sinex como", msg.content);
      conectando = false;
      tentativas = 0;
      Radar.estado = "conectado";

      const pendentes = Radar.fila.splice(0);
      pendentes.forEach((d) => ws.send(JSON.stringify(d)));

      window.dispatchEvent(new CustomEvent("radar_conectado"));
      return;
    }

    window.dispatchEvent(new CustomEvent("mensagem_servidor", { detail: msg }));
    tratarMensagem(msg);
  };

  ws.onclose = (evento) => {
    conectando = false;
    Radar.estado = "desconectado";
    Radar.socket = null;
    window.dispatchEvent(new CustomEvent("radar_desconectado"));

    // 1008 = política violada: token recusado ou conta bloqueada. Insistir
    // não resolve, então mandamos a pessoa refazer o login.
    if (evento.code === 1008) {
      console.warn("Conexão recusada pelo servidor:", evento.reason);
      Core.aviso(evento.reason || "Sessão expirada. Entre novamente.", "#ed4956");
      return;
    }

    if (!encerradoDeProposito) agendarReconexao();
  };

  ws.onerror = () => {
    // onclose sempre vem em seguida e cuida da reconexão.
    conectando = false;
  };
}

// ==========================================================================
// NOTIFICAÇÕES E CHAMADAS RECEBIDAS
// ==========================================================================

let somNotificacao = null;
let somToque = null;

function tocarNotificacao() {
  try {
    if (!somNotificacao) somNotificacao = new Audio("/assets/notificacao.wav");
    somNotificacao.currentTime = 0;
    somNotificacao.play().catch(() => {});
  } catch (_) {}
}

function tratarMensagem(msg) {
  if (msg.type === "chat") {
    const params = new URLSearchParams(window.location.search);
    const naPaginaDeChat = window.location.pathname.includes("chat.html");

    // Chat direto: sabemos que é a conversa aberta comparando "u=" com quem
    // mandou. Em grupo não dá pra usar "from" (várias pessoas mandam na
    // mesma conversa), então o remetente manda o chatId junto no payload e
    // comparamos com "g=" da URL.
    const chatIdDaMensagem = msg.payload?.chatId;
    const estouNesteChatDireto = params.get("u") === msg.from;
    const estouNesteGrupo = !!params.get("g") && params.get("g") === chatIdDaMensagem;
    const estouNesteChat = naPaginaDeChat && (estouNesteChatDireto || estouNesteGrupo);

    if (!estouNesteChat) {
      const naoLidas = (parseInt(localStorage.getItem("naoLidas"), 10) || 0) + 1;
      try { localStorage.setItem("naoLidas", String(naoLidas)); } catch (_) {}
      atualizarBadge();
      tocarNotificacao();
    }
    return;
  }

  if (msg.type === "chamada") {
    mostrarChamadaRecebida(msg);
    return;
  }

  if (msg.type === "cancelar_chamada") {
    try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
    removerBalaoChamada();
  }
}

export function atualizarBadge() {
  const badge = document.getElementById("badgeGlobal");
  if (!badge) return;

  const naoLidas = parseInt(localStorage.getItem("naoLidas"), 10) || 0;
  if (naoLidas > 0) {
    badge.textContent = naoLidas > 99 ? "99+" : String(naoLidas);
    badge.style.display = "flex";
  } else {
    badge.style.display = "none";
  }
}

export function zerarNotificacoes() {
  try { localStorage.setItem("naoLidas", "0"); } catch (_) {}
  atualizarBadge();
}

window.atualizarBadge = atualizarBadge;
window.zerarNotificacoes = zerarNotificacoes;

async function mostrarChamadaRecebida(msg) {
  let foto = AVATAR_PADRAO;
  try {
    const perfil = await buscarPerfilPorUsername(msg.from);
    if (perfil?.foto) foto = perfil.foto;
  } catch (_) {}

  const dados = { quemLiga: msg.from, tipo: msg.content, foto, inicio: Date.now() };
  try { localStorage.setItem("chamada_ativa", JSON.stringify(dados)); } catch (_) {}
  renderizarBalaoChamada();
}

let timeoutChamada = null;

/**
 * Desenha o balão de chamada recebida.
 * A marcação é construída com createElement — a versão anterior injetava a
 * pessoa que liga via innerHTML e reinjetava um bloco <style> inteiro a cada
 * chamada.
 */
export function renderizarBalaoChamada() {
  let dados;
  try {
    const bruto = localStorage.getItem("chamada_ativa");
    if (!bruto) return;
    dados = JSON.parse(bruto);
  } catch (_) {
    return;
  }

  const restante = DURACAO_CHAMADA - (Date.now() - dados.inicio);
  if (restante <= 0) {
    try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
    removerBalaoChamada();
    return;
  }

  document.getElementById("incomingCallUI")?.remove();

  const ehAudio = dados.tipo === "audio";

  const caixa = document.createElement("div");
  caixa.id = "incomingCallUI";
  caixa.className = "chamada-recebida";
  caixa.setAttribute("role", "alertdialog");
  caixa.setAttribute("aria-label", `Chamada recebida de ${dados.quemLiga}`);

  const avatar = document.createElement("img");
  avatar.className = "chamada-avatar";
  avatar.alt = "";
  avatar.src = urlSegura(dados.foto, AVATAR_PADRAO);

  const info = document.createElement("div");
  info.className = "chamada-info";
  const nome = document.createElement("h4");
  nome.textContent = dados.quemLiga; // textContent: nada de HTML aqui
  const tipo = document.createElement("p");
  tipo.textContent = ehAudio ? "Chamada de voz..." : "Chamada de vídeo...";
  info.append(nome, tipo);

  const acoes = document.createElement("div");
  acoes.className = "chamada-acoes";

  const btnRecusar = document.createElement("button");
  btnRecusar.type = "button";
  btnRecusar.className = "btn-chamada btn-recusar";
  btnRecusar.setAttribute("aria-label", "Recusar chamada");
  btnRecusar.innerHTML = iconeTelefone(true);

  const btnAtender = document.createElement("button");
  btnAtender.type = "button";
  btnAtender.className = "btn-chamada btn-atender";
  btnAtender.setAttribute("aria-label", "Atender chamada");
  btnAtender.innerHTML = iconeTelefone(false);

  acoes.append(btnRecusar, btnAtender);
  caixa.append(avatar, info, acoes);
  document.body.appendChild(caixa);

  btnAtender.addEventListener("click", () => {
    try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
    removerBalaoChamada();

    const params = new URLSearchParams({ u: dados.quemLiga, papel: "receptor" });
    if (ehAudio) params.set("audio", "true");

    // A chamada vai para uma janela própria: assim ela sobrevive a qualquer
    // navegação no app. Se o navegador bloquear a janela, cai no
    // comportamento antigo de navegar na própria aba.
    if (!abrirJanelaDeChamada(params)) {
      window.location.href = `chamada.html?${params.toString()}`;
    }
  });

  btnRecusar.addEventListener("click", async () => {
    try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
    removerBalaoChamada();

    Radar.emit({ type: "cancelar_chamada", to: dados.quemLiga });

    const s = await sessao({ exigirLogin: false });
    if (s) {
      await registrarEventoDeChamada(
        s,
        dados.quemLiga,
        ehAudio ? "📞 Chamada de voz recusada" : "📹 Chamada de vídeo recusada"
      );
    }
  });

  try {
    if (!somToque) {
      somToque = new Audio("/assets/toque.wav");
      somToque.loop = true;
    }
    somToque.play().catch(() => {});
  } catch (_) {}

  clearTimeout(timeoutChamada);
  timeoutChamada = setTimeout(async () => {
    try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
    removerBalaoChamada();

    const s = await sessao({ exigirLogin: false });
    if (s) {
      await registrarEventoDeChamada(
        s,
        dados.quemLiga,
        ehAudio ? "📞 Chamada de voz perdida" : "📹 Chamada de vídeo perdida"
      );
    }
  }, restante);
}

export function removerBalaoChamada() {
  clearTimeout(timeoutChamada);
  if (somToque) {
    somToque.pause();
    somToque.currentTime = 0;
  }
  document.getElementById("incomingCallUI")?.remove();
}

function iconeTelefone(recusar) {
  const rotacao = recusar ? ' transform="rotate(135 12 12)"' : "";
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"${rotacao}/></svg>`;
}

// ==========================================================================
// CICLO DE VIDA
// ==========================================================================

window.addEventListener("online", () => {
  tentativas = 0;
  conectar();
});

window.addEventListener("offline", () => {
  Core.aviso("Você está offline. As mensagens ficam na fila.", "#e0a800");
  Radar.estado = "desconectado";
  Radar.socket?.close();
});

// Ao voltar para a aba, reconecta na hora em vez de esperar o backoff — em
// celular o sistema costuma matar o socket em segundo plano.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Radar.estado !== "conectado") {
    tentativas = 0;
    pararReconexao();
    conectar();
  }
});

// O lastSeen agora é gravado pelo servidor Go quando a última aba cai. O
// cliente não escreve mais no Firestore de minuto em minuto (eram cerca de
// 1.440 escritas por dia por pessoa ativa).

// A barra de "chamada em andamento" precisa existir em toda tela. radar.js já
// é carregado em todas elas, então é daqui que ela sobe.
ligarBarraDeChamada();

sessao({ exigirLogin: false }).then((s) => {
  if (!s) return;
  conectar();
  atualizarBadge();
  renderizarBalaoChamada();
});