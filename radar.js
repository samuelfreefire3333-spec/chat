import Core, { sessao, urlSegura, AVATAR_PADRAO, buscarPerfilPorUsername } from "./core.js";
import { registrarEventoDeChamada, marcarEntregueDoAviso } from "./mensagens.js";
import {
  abrirJanelaDeChamada, ligarBarraDeChamada, lerEstadoDaChamada,
  avisarJanelas, focarJanelaDaChamada,
} from "./chamada-flutuante.js";

const URL_BACKEND = "wss://sinex-backend-go.onrender.com/ws";

// Mesmo host do WebSocket, mas em HTTP — usado pelos poucos endpoints
// administrativos do backend (hoje só /admin/kick, ver admin.js).
export const URL_BACKEND_HTTP = "https://sinex-backend-go.onrender.com";

// Quanto tempo o balão de chamada recebida fica na tela. Quem liga desiste em
// 45 s e avisa; isto é só a rede de segurança para um aviso que se perdeu.
const DURACAO_CHAMADA = 50000;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;

// Batimento: sem ele, um socket morto (troca de Wi-Fi para 4G, celular que
// dormiu) continuava "aberto" para o navegador por minutos — e a presença,
// o "digitando" e as chamadas simplesmente paravam de chegar.
const INTERVALO_PING = 25000;
const LIMITE_SEM_RESPOSTA = 10000;

// ==========================================================================
// CONEXÃO
// ==========================================================================
//  - o token vai numa mensagem "auth" depois do handshake, não na query string
//    (a URL aparece nos logs do servidor e em proxies);
//  - onAuthStateChanged é resolvido UMA vez (core.js), não a cada reconexão;
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
  "status_lote",
  "ping",
]);

// Sinalização de chamada tem vida curta: vale esperar a conexão por alguns
// segundos — a janela da chamada abre um socket novo, e a oferta WebRTC e os
// candidatos saíam antes de ele autenticar e se perdiam —, mas nunca
// reentregar algo velho.
const TIPOS_DE_VIDA_CURTA = new Set(["webrtc", "chamada", "cancelar_chamada"]);
const VIDA_CURTA_MS = 10000;

const Radar = {
  estado: "desconectado", // desconectado | conectando | conectado
  socket: null,
  fila: [],
  /** O que o servidor anunciou no auth_ok (ver hub.go, recursosDoServidor). */
  recursos: new Set(),

  emit(dados) {
    if (this.estado === "conectado" && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(dados));
      return true;
    }

    // Só o que ainda vale a pena entregar mais tarde entra na fila (máximo de
    // 100 itens, para não crescer sem limite offline).
    if (!TIPOS_EFEMEROS.has(dados.type) && this.fila.length < 100) {
      const item = TIPOS_DE_VIDA_CURTA.has(dados.type)
        ? { dados, expiraEm: Date.now() + VIDA_CURTA_MS }
        : { dados, expiraEm: 0 };
      this.fila.push(item);
    }
    agendarReconexao();
    return false;
  },

  /** Pergunta ao servidor se alguém está online. */
  verificarStatus(username) {
    if (!username) return;
    this.emit({ type: "status_check", to: username });
  },

  /**
   * Presença de várias pessoas. Com servidor novo vai num quadro só; com o
   * antigo, em pedidos individuais espaçados — a caixa de entrada chegava a
   * mandar 200 pedidos em um segundo e estourava o limite de taxa da
   * conexão, que o servidor derruba.
   */
  verificarStatusLote(usernames) {
    const lista = [...new Set((usernames || []).filter(Boolean))];
    if (!lista.length) return;
    // Antes do auth_ok ainda não se sabe o que o servidor aceita, e o pedido
    // se perderia de qualquer jeito (presença não entra na fila). Quem chama
    // pede de novo no evento "radar_conectado". Sem esta saída, pedidos
    // avulsos agendados aqui escapavam logo depois da conexão e duplicavam o
    // pedido em lote.
    if (this.estado !== "conectado") return;
    if (this.recursos.has("status-lote")) {
      this.emit({ type: "status_lote", payload: lista });
      return;
    }
    lista.forEach((u, i) => setTimeout(() => this.verificarStatus(u), Math.floor(i / 20) * 1000));
  },

  encerrar() {
    pararReconexao();
    pararBatimento();
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

let timerBatimento = null;
let ultimaAtividade = 0;
let pingPendenteDesde = 0;

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

function pararBatimento() {
  clearInterval(timerBatimento);
  timerBatimento = null;
  pingPendenteDesde = 0;
}

function enviarPing() {
  if (!Radar.recursos.has("ping")) return;
  if (Radar.estado !== "conectado" || Radar.socket?.readyState !== WebSocket.OPEN) return;
  if (!pingPendenteDesde) pingPendenteDesde = Date.now();
  try { Radar.socket.send(JSON.stringify({ type: "ping" })); } catch (_) {}
}

function conferirBatimento() {
  if (!pingPendenteDesde) return;
  if (Date.now() - pingPendenteDesde < LIMITE_SEM_RESPOSTA) return;
  if (ultimaAtividade > pingPendenteDesde) { pingPendenteDesde = 0; return; }
  // Nada chegou desde o ping: o socket está morto, só o navegador não sabe.
  console.warn("Sem resposta do servidor: reconectando.");
  pingPendenteDesde = 0;
  try { Radar.socket?.close(4000, "sem batimento"); } catch (_) {}
}

function iniciarBatimento() {
  pararBatimento();
  if (!Radar.recursos.has("ping")) return;
  timerBatimento = setInterval(() => {
    conferirBatimento();
    if (Date.now() - ultimaAtividade >= INTERVALO_PING) enviarPing();
  }, 5000);
}

async function conectar() {
  if (conectando || encerradoDeProposito) return;
  if (Radar.socket?.readyState === WebSocket.OPEN) return;
  if (!navigator.onLine) return;

  // A marcação vem ANTES do await: duas chamadas quase simultâneas
  // (visibilitychange junto com o evento "online", por exemplo) passavam as
  // duas pela checagem acima e abriam DOIS WebSockets — cada evento do
  // servidor chegava duplicado na página.
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
    // Um token novo a cada conexão: o anterior expira em uma hora.
    token = await s.user.getIdToken();
  } catch (err) {
    console.error("Falha ao obter o token do Firebase:", err);
    conectando = false;
    Radar.estado = "desconectado";
    agendarReconexao();
    return;
  }

  let ws;
  try {
    ws = new WebSocket(URL_BACKEND);
  } catch (err) {
    console.error("Falha ao abrir o WebSocket:", err);
    conectando = false;
    Radar.estado = "desconectado";
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
    if (Radar.socket !== ws) return;
    ultimaAtividade = Date.now();

    let msg;
    try {
      msg = JSON.parse(evento.data);
    } catch (_) {
      return;
    }

    if (msg.type === "auth_ok") {
      conectando = false;
      tentativas = 0;
      Radar.estado = "conectado";
      Radar.recursos = new Set(msg.payload?.recursos || []);
      iniciarBatimento();

      const agora = Date.now();
      const pendentes = Radar.fila.splice(0);
      pendentes
        .filter((item) => !item.expiraEm || item.expiraEm > agora)
        .forEach((item) => ws.send(JSON.stringify(item.dados)));

      window.dispatchEvent(new CustomEvent("radar_conectado", { detail: { recursos: [...Radar.recursos] } }));
      return;
    }

    if (msg.type === "pong") {
      pingPendenteDesde = 0;
      return;
    }

    window.dispatchEvent(new CustomEvent("mensagem_servidor", { detail: msg }));
    tratarMensagem(msg);
  };

  ws.onclose = (evento) => {
    if (Radar.socket !== ws) return;
    conectando = false;
    Radar.estado = "desconectado";
    Radar.socket = null;
    pararBatimento();
    window.dispatchEvent(new CustomEvent("radar_desconectado"));

    // 1008 = política violada: token recusado ou conta bloqueada. Insistir
    // não resolve, então mandamos a pessoa refazer o login.
    if (evento.code === 1008) {
      console.warn("Conexão recusada pelo servidor:", evento.reason);
      Core.aviso(evento.reason || "Sessão expirada. Entre novamente.", "erro");
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
  // Configurações > "Som de nova mensagem". O toque de chamada não depende
  // disto: desligar o som de mensagem não pode fazer ninguém perder ligação.
  try { if (localStorage.getItem("somMensagens") === "desligado") return; } catch (_) {}
  try {
    if (!somNotificacao) somNotificacao = new Audio("/assets/notificacao.wav");
    somNotificacao.currentTime = 0;
    somNotificacao.play().catch(() => {});
  } catch (_) {}
}

// Um aviso por conversa a cada instante basta para marcar a entrega.
const entregasAgendadas = new Map();

function agendarEntrega(chatId) {
  if (!chatId || entregasAgendadas.has(chatId)) return;
  entregasAgendadas.set(chatId, setTimeout(async () => {
    entregasAgendadas.delete(chatId);
    const s = await sessao({ exigirLogin: false });
    if (s) marcarEntregueDoAviso(s, chatId);
  }, 800));
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

      // Entregue: a caixa de entrada e a própria conversa marcam sozinhas;
      // nas outras telas quem marca é o aviso.
      const naCaixaDeEntrada = window.location.pathname.includes("inbox.html");
      if (!naCaixaDeEntrada) agendarEntrega(chatIdDaMensagem);
    }
    return;
  }

  if (msg.type === "chamada") {
    mostrarChamadaRecebida(msg);
    return;
  }

  // Quem liga pergunta se o balão já está tocando aqui (o primeiro aviso
  // pode ter saído antes de a janela da chamada de lá conectar).
  if (msg.type === "webrtc" && msg.content === "consultar_toque") {
    let dados = null;
    try { dados = JSON.parse(localStorage.getItem("chamada_ativa") || "null"); } catch (_) {}
    if (dados?.quemLiga === msg.from && document.getElementById("incomingCallUI")) {
      Radar.emit({ type: "webrtc", to: msg.from, content: "tocando", payload: { ocupado: !!dados.ocupado } });
    }
    return;
  }

  if (msg.type === "cancelar_chamada") {
    let dados = null;
    try { dados = JSON.parse(localStorage.getItem("chamada_ativa") || "null"); } catch (_) {}
    // Só fecha o balão se o cancelamento for de quem está ligando.
    if (!dados || dados.quemLiga === msg.from) {
      try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
      removerBalaoChamada();
    }
  }
}

export function atualizarBadge() {
  const badge = document.getElementById("badgeGlobal");
  if (!badge) return;

  const naoLidas = parseInt(localStorage.getItem("naoLidas"), 10) || 0;
  const link = badge.closest("a");
  if (naoLidas > 0) {
    badge.textContent = naoLidas > 99 ? "99+" : String(naoLidas);
    badge.classList.remove("u-hidden");
    badge.classList.add("visivel");
    link?.setAttribute("aria-label", `Mensagens, ${naoLidas} ${naoLidas === 1 ? "não lida" : "não lidas"}`);
  } else {
    badge.classList.remove("visivel");
    badge.classList.add("u-hidden");
    link?.setAttribute("aria-label", "Mensagens");
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
  let nome = "";
  try {
    const perfil = await buscarPerfilPorUsername(msg.from);
    if (perfil?.foto) foto = perfil.foto;
    if (perfil?.nome) nome = perfil.nome;
  } catch (_) {}

  // Já existe uma chamada rolando neste navegador? Então é chamada em espera.
  const emAndamento = lerEstadoDaChamada();
  const ocupado = !!emAndamento;

  // Quem liga passa de "Chamando…" para "Tocando…" (ou "em outra chamada").
  Radar.emit({ type: "webrtc", to: msg.from, content: "tocando", payload: { ocupado } });

  const dados = { quemLiga: msg.from, nome, tipo: msg.content, foto, inicio: Date.now(), ocupado };
  try { localStorage.setItem("chamada_ativa", JSON.stringify(dados)); } catch (_) {}
  renderizarBalaoChamada();
}

let timeoutChamada = null;

function botaoRedondo(classe, rotulo, icone) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn-chamada ${classe}`;
  btn.setAttribute("aria-label", rotulo);
  btn.title = rotulo;
  btn.innerHTML = icone;
  return btn;
}

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
  const nomeVisivel = dados.nome || `@${dados.quemLiga}`;

  const caixa = document.createElement("div");
  caixa.id = "incomingCallUI";
  caixa.className = dados.ocupado ? "chamada-recebida chamada-recebida-espera" : "chamada-recebida";
  caixa.setAttribute("role", "alertdialog");
  caixa.setAttribute("aria-label", `${ehAudio ? "Chamada de voz" : "Chamada de vídeo"} de ${nomeVisivel}`);

  const avatar = document.createElement("img");
  avatar.className = "chamada-avatar";
  avatar.alt = "";
  avatar.src = urlSegura(dados.foto, AVATAR_PADRAO);
  avatar.addEventListener("error", () => { avatar.src = AVATAR_PADRAO; }, { once: true });

  const info = document.createElement("div");
  info.className = "chamada-info";
  const nome = document.createElement("h4");
  nome.textContent = nomeVisivel; // textContent: nada de HTML aqui
  const tipo = document.createElement("p");
  tipo.textContent = dados.ocupado
    ? `${ehAudio ? "Chamada de voz" : "Chamada de vídeo"} · você está em outra chamada`
    : (ehAudio ? "Chamada de voz recebida" : "Chamada de vídeo recebida");
  info.append(nome, tipo);

  const acoes = document.createElement("div");
  acoes.className = "chamada-acoes";

  const btnRecusar = botaoRedondo("btn-recusar", "Recusar chamada", iconeTelefone(true));
  const btnAtender = botaoRedondo(
    "btn-atender",
    dados.ocupado ? "Encerrar a chamada atual e atender" : "Atender chamada",
    ehAudio ? iconeTelefone(false) : iconeCamera()
  );

  acoes.append(btnRecusar, btnAtender);
  caixa.append(avatar, info, acoes);
  document.body.appendChild(caixa);

  btnAtender.addEventListener("click", () => {
    try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
    removerBalaoChamada();

    const params = new URLSearchParams({ u: dados.quemLiga, papel: "receptor" });
    if (ehAudio) params.set("audio", "true");

    // Chamada em espera: a janela da chamada atual encerra a ligação de
    // agora (avisando a outra pessoa) e ELA MESMA abre a nova. Abrir por aqui
    // navegaria aquela janela no meio da ligação.
    if (dados.ocupado && lerEstadoDaChamada()) {
      avisarJanelas({ tipo: "atender-outra", params: params.toString() });
      focarJanelaDaChamada();
      return;
    }

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

    Radar.emit({ type: "cancelar_chamada", to: dados.quemLiga, content: "recusada" });

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
    if (dados.ocupado) {
      // Em espera, um toque discreto em vez do toque de chamada por cima da
      // conversa em andamento.
      tocarNotificacao();
    } else {
      if (!somToque) {
        somToque = new Audio("/assets/toque.wav");
        somToque.loop = true;
      }
      somToque.play().catch(() => {});
    }
  } catch (_) {}

  // Quem liga registra "não atendida" quando desiste; aqui o balão só some.
  // (Antes os dois lados registravam, e cada aba aberta registrava de novo:
  // uma chamada perdida virava três mensagens na conversa.)
  clearTimeout(timeoutChamada);
  timeoutChamada = setTimeout(() => {
    try { localStorage.removeItem("chamada_ativa"); } catch (_) {}
    removerBalaoChamada();
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

// Atendeu ou recusou em outra aba: o balão (e o toque) somem aqui também.
window.addEventListener("storage", (evento) => {
  if (evento.key === "chamada_ativa" && !evento.newValue) removerBalaoChamada();
});

function iconeTelefone(recusar) {
  const rotacao = recusar ? ' transform="rotate(135 12 12)"' : "";
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"${rotacao}/></svg>`;
}

function iconeCamera() {
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>';
}

// ==========================================================================
// CICLO DE VIDA
// ==========================================================================

window.addEventListener("online", () => {
  tentativas = 0;
  conectar();
});

window.addEventListener("offline", () => {
  Core.aviso("Você está offline. As mensagens ficam na fila.", "alerta");
  try { Radar.socket?.close(); } catch (_) {}
});

// Ao voltar para a aba, reconecta na hora em vez de esperar o backoff — em
// celular o sistema costuma matar o socket em segundo plano. Se o socket
// parece aberto, um ping confirma que ele está vivo de verdade.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Radar.estado !== "conectado") {
    tentativas = 0;
    pararReconexao();
    conectar();
  } else {
    enviarPing();
  }
});

// O lastSeen é gravado pelo servidor Go quando a última aba cai. O cliente não
// escreve no Firestore de minuto em minuto (eram cerca de 1.440 escritas por
// dia por pessoa ativa).

// A barra de "chamada em andamento" precisa existir em toda tela. radar.js já
// é carregado em todas elas, então é daqui que ela sobe.
ligarBarraDeChamada();

sessao({ exigirLogin: false }).then((s) => {
  if (!s) return;
  conectar();
  atualizarBadge();
  renderizarBalaoChamada();
});
