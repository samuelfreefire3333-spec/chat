import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, onSnapshot, getDocs, documentId, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, {
  sessao, definirAvatar, horaCurta, vistoPorUltimo, paraMillis,
  montarAvatarNav, AVATAR_PADRAO, AVATAR_GRUPO, mostrar
} from "./core.js";
import Radar from "./radar.js";
import { apagarChat, estadoDoRecibo, marcarRecibos } from "./mensagens.js";

const listaEl = document.getElementById("listaConversas");
const elBusca = document.getElementById("buscaConversas");
const elFiltros = document.getElementById("filtrosConversas");
let sessaoAtual = null;
let pararDeEscutar = null;
let conversas = [];
const cachePerfis = new Map();

// Presença recebida pelo WebSocket, guardada fora do DOM. A lista inteira é
// redesenhada a cada atualização do Firestore; sem esta memória, todo mundo
// voltava para "Offline" sempre que qualquer conversa recebia uma mensagem.
const presenca = new Map(); // username -> { estado: "online" | "offline", lastSeen, em }
const presencaPedidaEm = new Map(); // username -> quando pedimos por último

// "digitando…" na lista, com a mesma validade por relógio da conversa.
const VALIDADE_DIGITANDO = 3000;
const digitandoAte = new Map(); // username -> ms

// Estado do modo de seleção múltipla.
let modoSelecao = false;
const selecionados = new Set();

// Filtro e busca locais.
let filtroAtual = "todas"; // todas | naoLidas | grupos
let termoBusca = "";

// ==========================================================================
// PERFIS DOS CONTATOS
// ==========================================================================

/**
 * Busca os perfis que faltam em UMA consulta com "in", em vez de uma consulta
 * por conversa. Só se aplica a chats diretos — um grupo não tem "o outro
 * perfil".
 */
async function carregarPerfis(usernames) {
  const faltando = usernames.filter((u) => !cachePerfis.has(u));
  if (!faltando.length) return;

  // O operador "in" aceita no máximo 30 valores por consulta.
  for (let i = 0; i < faltando.length; i += 30) {
    const lote = faltando.slice(i, i + 30);
    try {
      // Perfis antigos podem ter o ID do documento diferente do campo
      // "usuario": consultamos pelos dois caminhos em paralelo.
      // As regras exigem limite em toda listagem de perfis (anti-raspagem).
      const qPorId = getDocs(query(collection(db, "usuarios"), where(documentId(), "in", lote), limit(30)));
      const qPorCampo = getDocs(query(collection(db, "usuarios"), where("usuario", "in", lote), limit(30)));

      const [snapId, snapCampo] = await Promise.all([qPorId, qPorCampo]);

      const popularCache = (snap) => {
        snap.forEach((d) => {
          const dados = d.data();
          const username = dados.usuario || d.id;
          if (!cachePerfis.has(username)) cachePerfis.set(username, { id: d.id, ...dados });
          if (!cachePerfis.has(d.id)) cachePerfis.set(d.id, { id: d.id, ...dados });
        });
      };

      popularCache(snapId);
      popularCache(snapCampo);
    } catch (err) {
      console.error("Erro ao carregar perfis:", err);
    }

    // Quem não voltou (perfil apagado) recebe um espaço reservado.
    lote.forEach((u) => {
      if (!cachePerfis.has(u)) {
        cachePerfis.set(u, { id: u, usuario: u, nome: u, foto: AVATAR_PADRAO, lastSeen: 0 });
      }
    });
  }
}

// ==========================================================================
// RENDERIZAÇÃO
// ==========================================================================

const ICONES_RECIBO = {
  enviada: '<svg class="recibo" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6l2.9 2.9 6.6-6.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  entregue: '<svg class="recibo recibo-duplo" viewBox="0 0 20 16" aria-hidden="true"><path d="M1.6 8.6l2.9 2.9 6.6-6.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 11.5l.9.9 6.6-6.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
ICONES_RECIBO.lida = ICONES_RECIBO.entregue;
const ROTULOS_RECIBO = { enviada: "Enviada", entregue: "Entregue", lida: "Vista" };

function textoDePresenca(username) {
  const p = presenca.get(username);
  if (p?.estado === "online") return "Online";
  const lastSeen = p?.lastSeen || paraMillis(cachePerfis.get(username)?.lastSeen);
  return vistoPorUltimo(lastSeen, { curto: true }) || "offline";
}

function estaDigitando(username) {
  return (digitandoAte.get(username) || 0) > Date.now();
}

/** Status do item (linha do meio): digitando > online > visto por último. */
function pintarStatus(el, username) {
  if (!el) return;
  const digitando = estaDigitando(username);
  const online = presenca.get(username)?.estado === "online";
  el.textContent = digitando ? "digitando…" : textoDePresenca(username);
  el.dataset.online = online ? "true" : "false";
  el.classList.toggle("online", online && !digitando);
  el.classList.toggle("digitando", digitando);
  const item = el.closest(".chat-item");
  item?.classList.toggle("contato-online", online);
}

function ultimaLeituraMinha(chat) {
  const local = parseInt(localStorage.getItem(`last_read_${chat.id}`), 10) || 0;
  // A marca no Firestore vale entre aparelhos: ler no celular apaga o ponto
  // de "não lida" no computador também.
  return Math.max(local, paraMillis(chat.leituras?.[sessaoAtual.user.uid]));
}

function temNovidade(chat) {
  const souEuUltimo = chat.ultimoRemetente === sessaoAtual.username;
  return !souEuUltimo && !!chat.ultimaMensagem && chat.timestampMs > ultimaLeituraMinha(chat);
}

function horaDaLista(ms) {
  if (!ms) return "";
  const data = new Date(ms);
  const hoje = new Date();
  if (data.toDateString() === hoje.toDateString()) return horaCurta(ms);
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);
  if (data.toDateString() === ontem.toDateString()) return "Ontem";
  if (Date.now() - ms < 6 * 86400000) {
    const dia = data.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
    return dia.charAt(0).toUpperCase() + dia.slice(1);
  }
  return data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function nomeDoChat(chat) {
  if (chat.tipo === "grupo") return chat.nome;
  const perfil = cachePerfis.get(chat.outroUsuario) || {};
  return perfil.nome || chat.outroUsuario;
}

function montarCard(chat) {
  const ehGrupo = chat.tipo === "grupo";
  const perfil = ehGrupo ? null : (cachePerfis.get(chat.outroUsuario) || {});
  const nomeVisivel = nomeDoChat(chat);
  const novidade = temNovidade(chat);

  const item = document.createElement("div");
  item.className = "chat-item";
  item.id = `chat-card-${chat.id}`;
  item.dataset.chatId = chat.id;
  item.dataset.tipo = chat.tipo;
  if (!ehGrupo) item.dataset.usuario = chat.outroUsuario;
  if (novidade) item.classList.add("nao-lida");
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-label", `${ehGrupo ? "Grupo" : "Conversa com"} ${nomeVisivel}${novidade ? ", mensagem nova" : ""}`);

  const check = document.createElement("div");
  check.className = "chat-checkbox";
  item.appendChild(check);

  const moldura = document.createElement("div");
  moldura.className = "chat-avatar-moldura";
  const avatar = document.createElement("img");
  avatar.className = "chat-avatar";
  avatar.alt = "";
  avatar.loading = "lazy";
  definirAvatar(avatar, ehGrupo ? AVATAR_GRUPO : perfil.foto);
  moldura.appendChild(avatar);
  if (!ehGrupo) {
    const pontoOnline = document.createElement("span");
    pontoOnline.className = "chat-online-ponto";
    pontoOnline.setAttribute("aria-hidden", "true");
    moldura.appendChild(pontoOnline);
  }
  item.appendChild(moldura);

  const info = document.createElement("div");
  info.className = "chat-info";

  const linhaTopo = document.createElement("div");
  linhaTopo.className = "chat-linha-topo";

  const nome = document.createElement("strong");
  nome.className = "chat-name";
  nome.textContent = nomeVisivel;

  const hora = document.createElement("span");
  hora.className = "chat-hora";
  hora.textContent = horaDaLista(chat.timestampMs);

  linhaTopo.append(nome, hora);

  const status = document.createElement("span");
  status.className = "chat-status";
  if (ehGrupo) {
    status.textContent = `${chat.participantes.length} participantes`;
  } else {
    status.id = `status-inbox-${chat.outroUsuario}`;
    pintarStatus(status, chat.outroUsuario);
  }

  const linhaPrevia = document.createElement("div");
  linhaPrevia.className = "chat-linha-previa";

  const previa = document.createElement("span");
  previa.className = "chat-preview";

  const souEuUltimo = chat.ultimoRemetente === sessaoAtual.username;
  if (souEuUltimo && chat.ultimaMensagem && chat.ultimoTipo !== "sistema") {
    // Confirmação da minha última mensagem, direto na lista.
    const estado = estadoDoRecibo(chat.timestampMs, chat.raw, sessaoAtual.user.uid);
    const recibo = document.createElement("span");
    recibo.className = `chat-recibo recibo-${estado}`;
    recibo.innerHTML = ICONES_RECIBO[estado];
    recibo.setAttribute("role", "img");
    recibo.setAttribute("aria-label", ROTULOS_RECIBO[estado]);
    previa.appendChild(recibo);
  }
  const primeiroNome = (u) => String(cachePerfis.get(u)?.nome || u).trim().split(/\s+/)[0];
  const prefixo = souEuUltimo
    ? "Você: "
    : (ehGrupo && chat.ultimoRemetente && chat.ultimoTipo !== "sistema" ? `${primeiroNome(chat.ultimoRemetente)}: ` : "");
  const textoPrevia = document.createElement("span");
  textoPrevia.className = "chat-preview-texto";
  textoPrevia.textContent = chat.ultimaMensagem ? prefixo + chat.ultimaMensagem : "Toque para conversar";
  previa.appendChild(textoPrevia);

  if (novidade) {
    previa.classList.add("nao-lida");
    hora.classList.add("nao-lida");
  }

  linhaPrevia.appendChild(previa);
  if (novidade) {
    const ponto = document.createElement("span");
    ponto.className = "chat-dot";
    ponto.setAttribute("aria-hidden", "true");
    linhaPrevia.appendChild(ponto);
  }

  info.append(linhaTopo, status, linhaPrevia);
  item.appendChild(info);

  return item;
}

function passaNoFiltro(chat) {
  if (filtroAtual === "naoLidas" && !temNovidade(chat)) return false;
  if (filtroAtual === "grupos" && chat.tipo !== "grupo") return false;
  if (!termoBusca) return true;
  const alvo = [
    nomeDoChat(chat),
    chat.outroUsuario || "",
    chat.ultimaMensagem || "",
  ].join(" ").toLocaleLowerCase("pt-BR");
  return alvo.includes(termoBusca);
}

function estadoVazio(titulo, texto, acao) {
  const caixa = document.createElement("div");
  caixa.className = "estado-vazio";
  caixa.setAttribute("role", "status");
  const icone = document.createElement("div");
  icone.className = "estado-vazio-icone";
  icone.setAttribute("aria-hidden", "true");
  icone.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';
  const h = document.createElement("strong");
  h.textContent = titulo;
  const p = document.createElement("span");
  p.textContent = texto;
  caixa.append(icone, h, p);
  if (acao) {
    const a = document.createElement("a");
    a.className = "btn-primario btn-pequeno";
    a.href = acao.href;
    a.textContent = acao.rotulo;
    caixa.appendChild(a);
  }
  return caixa;
}

function renderizar() {
  if (!conversas.length) {
    listaEl.replaceChildren(estadoVazio(
      "Nenhuma conversa ainda",
      "Encontre pessoas pelo nome ou @usuário e mande a primeira mensagem.",
      { href: "explorar.html", rotulo: "Encontrar pessoas" }
    ));
    atualizarContadores();
    return;
  }

  const visiveis = conversas.filter(passaNoFiltro);
  if (!visiveis.length) {
    const mensagem = termoBusca
      ? ["Nada encontrado", `Nenhuma conversa com “${elBusca?.value.trim() || termoBusca}”.`]
      : filtroAtual === "naoLidas"
        ? ["Tudo em dia", "Você não tem mensagens não lidas."]
        : ["Nenhum grupo", "Crie um grupo para conversar com várias pessoas."];
    listaEl.replaceChildren(estadoVazio(mensagem[0], mensagem[1],
      filtroAtual === "grupos" && !termoBusca ? { href: "grupo-novo.html", rotulo: "Criar grupo" } : null));
    atualizarContadores();
    return;
  }

  const fragmento = document.createDocumentFragment();
  visiveis.forEach((chat) => fragmento.appendChild(montarCard(chat)));
  listaEl.replaceChildren(fragmento);

  aplicarEstadoDeSelecao();
  atualizarContadores();
}

function atualizarContadores() {
  const naoLidas = conversas.filter(temNovidade).length;
  const chip = elFiltros?.querySelector('[data-filtro="naoLidas"] .filtro-contagem');
  if (chip) {
    chip.textContent = naoLidas ? String(naoLidas) : "";
    mostrar(chip, naoLidas > 0);
  }
}

// ==========================================================================
// PRESENÇA
// ==========================================================================

const VALIDADE_PRESENCA = 120000;

/** Pede presença só de quem ainda não sabemos (ou sabemos há muito tempo). */
function pedirPresenca({ todos = false } = {}) {
  // Desconectado não adianta marcar como pedido: a conexão, quando voltar,
  // dispara "radar_conectado" e pede todo mundo de uma vez.
  if (Radar.estado !== "conectado") return;
  const agora = Date.now();
  const alvos = conversas
    .filter((c) => c.tipo === "direto")
    .map((c) => c.outroUsuario)
    .filter((u) => todos || agora - (presencaPedidaEm.get(u) || 0) > VALIDADE_PRESENCA);
  if (!alvos.length) return;
  alvos.forEach((u) => presencaPedidaEm.set(u, agora));
  Radar.verificarStatusLote(alvos);
}

function repintarStatus(username) {
  pintarStatus(document.getElementById(`status-inbox-${username}`), username);
}

window.addEventListener("mensagem_servidor", (e) => {
  const msg = e.detail;
  if (!msg) return;

  if (msg.type === "status_update" || msg.type === "status_reply") {
    if (msg.content === "online") {
      presenca.set(msg.from, { estado: "online", em: Date.now() });
    } else {
      const perfil = cachePerfis.get(msg.from);
      // O servidor manda o lastSeen junto; se não vier, usa o do cache.
      const lastSeen = msg.lastSeen || paraMillis(perfil?.lastSeen) || 0;
      if (perfil && lastSeen) perfil.lastSeen = lastSeen;
      presenca.set(msg.from, { estado: "offline", lastSeen, em: Date.now() });
      digitandoAte.delete(msg.from);
    }
    repintarStatus(msg.from);
    return;
  }

  if (msg.type === "digitando" || msg.type === "parou_digitando") {
    // Só conversa direta anuncia digitação; e o aviso precisa ser da
    // conversa com essa pessoa (clientes novos mandam o chatId junto).
    const chat = conversas.find((c) => c.tipo === "direto" && c.outroUsuario === msg.from);
    if (!chat) return;
    if (msg.payload?.chatId && msg.payload.chatId !== chat.id) return;
    if (msg.type === "digitando") {
      digitandoAte.set(msg.from, Date.now() + VALIDADE_DIGITANDO);
      presenca.set(msg.from, { estado: "online", em: Date.now() });
    } else {
      digitandoAte.delete(msg.from);
    }
    repintarStatus(msg.from);
    return;
  }

  if (msg.type === "chat") {
    digitandoAte.delete(msg.from);
    presenca.set(msg.from, { estado: "online", em: Date.now() });
    repintarStatus(msg.from);
  }
});

// Ao reconectar (inclusive quando o servidor gratuito acorda), pergunta tudo
// de novo em vez de deixar a lista congelada no último estado conhecido.
window.addEventListener("radar_conectado", () => pedirPresenca({ todos: true }));

// Sem conexão, "digitando…" não vale mais nada.
window.addEventListener("radar_desconectado", () => {
  const eram = [...digitandoAte.keys()];
  digitandoAte.clear();
  eram.forEach(repintarStatus);
});

// Relógio único da lista: expira "digitando…" e atualiza os "visto há...".
let ultimoRepintarCompleto = Date.now();
setInterval(() => {
  const agora = Date.now();
  for (const [username, ate] of digitandoAte) {
    if (ate <= agora) {
      digitandoAte.delete(username);
      repintarStatus(username);
    }
  }
  if (agora - ultimoRepintarCompleto >= 30000 && document.visibilityState === "visible") {
    ultimoRepintarCompleto = agora;
    document.querySelectorAll("[id^='status-inbox-']").forEach((el) => {
      pintarStatus(el, el.id.replace("status-inbox-", ""));
    });
  }
}, 1000);

// ==========================================================================
// ENTREGA
// ==========================================================================
// A mensagem apareceu na caixa de entrada = chegou ao aparelho. Marca como
// entregue (as duas marquinhas cinza do lado de quem mandou).

const JANELA_ENTREGA = 7 * 24 * 60 * 60 * 1000;

function marcarEntregues(docs) {
  const agora = Date.now();
  docs.forEach((c) => {
    if (c.ultimoRemetente === sessaoAtual.username || !c.raw?.timestamp || !c.ultimaMensagem) return;
    // Conversa parada há dias não precisa de confirmação — e sem este corte a
    // primeira abertura depois da atualização gravaria em todas de uma vez.
    if (agora - c.timestampMs > JANELA_ENTREGA) return;
    marcarRecibos(sessaoAtual, c.id, c.raw, { entregueAte: c.raw.timestamp });
  });
}

// ==========================================================================
// SELEÇÃO MÚLTIPLA E EXCLUSÃO
// ==========================================================================

function aplicarEstadoDeSelecao() {
  const barra = document.getElementById("selectionBar");
  const contador = document.getElementById("selectionCount");

  mostrar(barra, modoSelecao);
  if (contador) contador.textContent = selecionados.size === 1 ? "1 selecionada" : `${selecionados.size} selecionadas`;

  document.querySelectorAll(".chat-item").forEach((item) => {
    const id = item.dataset.chatId;
    const marcado = selecionados.has(id);
    item.classList.toggle("selecionavel", modoSelecao);
    item.classList.toggle("selecionado", marcado);
    item.setAttribute("aria-selected", marcado ? "true" : "false");
  });
}

// Momento em que a seleção foi ligada pelo toque longo. Ao soltar o dedo o
// navegador dispara um "click" no mesmo card: sem esta trava, esse clique
// desmarcava na hora o item recém-selecionado.
let selecaoAtivadaEm = 0;

function ativarModoSelecao(chatId) {
  if (modoSelecao) return;
  modoSelecao = true;
  selecaoAtivadaEm = Date.now();
  selecionados.add(chatId);
  navigator.vibrate?.(50);
  aplicarEstadoDeSelecao();
}

function alternarSelecao(chatId) {
  if (selecionados.has(chatId)) selecionados.delete(chatId);
  else selecionados.add(chatId);

  if (selecionados.size === 0) cancelarSelecao();
  else aplicarEstadoDeSelecao();
}

function cancelarSelecao() {
  modoSelecao = false;
  selecionados.clear();
  aplicarEstadoDeSelecao();
}

/**
 * Grupo só quem criou apaga (as regras do Firestore conferem). Conversa
 * direta, qualquer um dos dois — o aviso deixa claro que é para os dois.
 */
function podeApagar(chat) {
  if (!chat || chat.tipo !== "grupo") return true;
  const raw = chat.raw || {};
  if (raw.criadoPorUid) return raw.criadoPorUid === sessaoAtual.user.uid;
  return raw.criadoPor === sessaoAtual.username;
}

async function apagarConversas(todos) {
  const ids = todos.filter((id) => podeApagar(conversas.find((c) => c.id === id)));
  if (ids.length < todos.length) {
    Core.aviso(ids.length
      ? "Grupos criados por outras pessoas não entram: só quem criou pode apagar."
      : "Só quem criou o grupo pode apagá-lo.", "alerta");
  }
  if (!ids.length) return;

  const algumGrupo = ids.some((id) => conversas.find((c) => c.id === id)?.tipo === "grupo");
  const plural = ids.length > 1;

  const ok = await Core.confirmar(
    plural
      ? `As mensagens de ${ids.length} conversas serão excluídas para todos os participantes.`
      : algumGrupo
        ? "As mensagens do grupo serão excluídas para todos os participantes."
        : "As mensagens serão excluídas para você e para o outro participante.",
    { confirmarTexto: "Apagar", titulo: plural ? `Apagar ${ids.length} conversas?` : (algumGrupo ? "Apagar grupo?" : "Apagar conversa?") }
  );
  if (!ok) return;

  Core.aviso(plural ? "Apagando conversas…" : "Apagando conversa…");
  const falhas = [];

  for (const id of ids) {
    try {
      await apagarChat(id);
    } catch (err) {
      console.error(`Erro ao apagar ${id}:`, err);
      falhas.push(id);
    }
  }

  cancelarSelecao();

  if (falhas.length) {
    Core.aviso(`Não foi possível apagar ${falhas.length} conversa(s).`, "erro");
  } else {
    Core.aviso(plural ? "Conversas apagadas." : "Conversa apagada.", "sucesso");
  }
}

// --------------------------------------------------------------------------
// Menu de contexto
// --------------------------------------------------------------------------

let menuContexto = null;

function fecharMenuContexto() {
  menuContexto?.remove();
  menuContexto = null;
}

function abrirMenuContexto(evento, chatId, usuario, tipo) {
  evento.preventDefault();
  fecharMenuContexto();

  const ehGrupo = tipo === "grupo";
  const linkDaConversa = ehGrupo
    ? `chat.html?g=${encodeURIComponent(chatId)}`
    : `chat.html?u=${encodeURIComponent(usuario)}`;

  const menu = document.createElement("div");
  menu.className = "menu-contexto";
  menu.setAttribute("role", "menu");

  const opcoes = [
    { rotulo: "Abrir conversa", acao: () => { window.location.href = linkDaConversa; } },
  ];

  if (!ehGrupo) {
    opcoes.push({
      rotulo: "Ver perfil",
      acao: () => { window.location.href = `perfil.html?u=${encodeURIComponent(usuario)}`; },
    });
  }

  opcoes.push({ rotulo: "Selecionar", acao: () => ativarModoSelecao(chatId) });
  if (podeApagar(conversas.find((c) => c.id === chatId))) {
    opcoes.push({ rotulo: ehGrupo ? "Apagar grupo para todos" : "Apagar conversa", perigo: true, acao: () => apagarConversas([chatId]) });
  }

  opcoes.forEach(({ rotulo, acao, perigo }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = perigo ? "menu-item menu-item-perigo" : "menu-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = rotulo;
    btn.addEventListener("click", () => { fecharMenuContexto(); acao(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  // Mantém o menu dentro da janela.
  const largura = menu.offsetWidth || 220;
  const altura = menu.offsetHeight || 200;
  const x = Math.min(evento.clientX, window.innerWidth - largura - 8);
  const y = Math.min(evento.clientY, window.innerHeight - altura - 8);

  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  menuContexto = menu;
  menu.querySelector("button")?.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  if (menuContexto && !menuContexto.contains(e.target)) fecharMenuContexto();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (menuContexto) fecharMenuContexto();
  else if (modoSelecao) cancelarSelecao();
});

window.addEventListener("scroll", fecharMenuContexto, true);

// --------------------------------------------------------------------------
// Eventos da lista (delegação, nenhum onclick no HTML gerado)
// --------------------------------------------------------------------------

let timerPressao = null;
let inicioPressao = null;

// Um dedo nunca fica perfeitamente parado: tolerância antes de cancelar o
// toque longo. Mesma tolerância já usada no chat.
const LIMIAR_MOVIMENTO = 10; // px

function itemAlvo(evento) {
  return evento.target.closest(".chat-item");
}

listaEl?.addEventListener("click", (e) => {
  const item = itemAlvo(e);
  if (!item) return;

  if (modoSelecao) {
    e.preventDefault();
    // Ignora o clique gerado pelo próprio toque longo que abriu a seleção.
    if (Date.now() - selecaoAtivadaEm < 400) return;
    alternarSelecao(item.dataset.chatId);
  } else if (item.dataset.tipo === "grupo") {
    window.location.href = `chat.html?g=${encodeURIComponent(item.dataset.chatId)}`;
  } else {
    window.location.href = `chat.html?u=${encodeURIComponent(item.dataset.usuario)}`;
  }
});

listaEl?.addEventListener("keydown", (e) => {
  const item = itemAlvo(e);
  if (!item) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    item.click();
  }
});

listaEl?.addEventListener("contextmenu", (e) => {
  const item = itemAlvo(e);
  if (!item || modoSelecao) return;
  abrirMenuContexto(e, item.dataset.chatId, item.dataset.usuario, item.dataset.tipo);
});

function iniciarPressaoLonga(e) {
  const item = itemAlvo(e);
  if (!item || modoSelecao) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;

  clearTimeout(timerPressao);
  inicioPressao = { x: e.clientX, y: e.clientY };
  item.classList.add("pressionando");

  timerPressao = setTimeout(() => {
    item.classList.remove("pressionando");
    ativarModoSelecao(item.dataset.chatId);
  }, 500);
}

function moverDurantePressao(e) {
  if (!timerPressao || !inicioPressao) return;
  const dx = e.clientX - inicioPressao.x;
  const dy = e.clientY - inicioPressao.y;
  if (Math.hypot(dx, dy) > LIMIAR_MOVIMENTO) cancelarPressaoLonga();
}

function cancelarPressaoLonga() {
  clearTimeout(timerPressao);
  timerPressao = null;
  inicioPressao = null;
  listaEl?.querySelectorAll(".chat-item.pressionando")
    .forEach((el) => el.classList.remove("pressionando"));
}

listaEl?.addEventListener("pointerdown", iniciarPressaoLonga);
listaEl?.addEventListener("pointerup", cancelarPressaoLonga);
listaEl?.addEventListener("pointerleave", cancelarPressaoLonga);
listaEl?.addEventListener("pointercancel", cancelarPressaoLonga);
listaEl?.addEventListener("pointermove", moverDurantePressao);

// --------------------------------------------------------------------------
// Busca e filtros
// --------------------------------------------------------------------------

let timerBusca = null;
elBusca?.addEventListener("input", () => {
  clearTimeout(timerBusca);
  timerBusca = setTimeout(() => {
    termoBusca = elBusca.value.trim().toLocaleLowerCase("pt-BR");
    renderizar();
  }, 120);
});
elBusca?.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && elBusca.value) {
    e.stopPropagation();
    elBusca.value = "";
    termoBusca = "";
    renderizar();
  }
});

elFiltros?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filtro]");
  if (!chip) return;
  filtroAtual = chip.dataset.filtro;
  elFiltros.querySelectorAll("[data-filtro]").forEach((c) => {
    const ativo = c === chip;
    c.classList.toggle("ativo", ativo);
    c.setAttribute("aria-pressed", ativo ? "true" : "false");
  });
  renderizar();
});

// ==========================================================================
// BARRA DE SELEÇÃO
// ==========================================================================

function montarBarraDeSelecao() {
  const cabecalho = document.querySelector(".inbox-header");
  if (!cabecalho || document.getElementById("selectionBar")) return;

  const barra = document.createElement("div");
  barra.id = "selectionBar";
  barra.className = "selection-bar u-hidden";

  const esquerda = document.createElement("div");
  esquerda.className = "selection-esquerda";

  const btnFechar = document.createElement("button");
  btnFechar.type = "button";
  btnFechar.className = "selection-btn";
  btnFechar.setAttribute("aria-label", "Cancelar seleção");
  btnFechar.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  btnFechar.addEventListener("click", cancelarSelecao);

  const contador = document.createElement("span");
  contador.id = "selectionCount";
  contador.className = "selection-contador";
  contador.setAttribute("aria-live", "polite");
  contador.textContent = "0";

  esquerda.append(btnFechar, contador);

  const btnApagar = document.createElement("button");
  btnApagar.type = "button";
  btnApagar.className = "selection-btn";
  btnApagar.setAttribute("aria-label", "Apagar conversas selecionadas");
  btnApagar.title = "Apagar";
  btnApagar.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
  btnApagar.addEventListener("click", () => apagarConversas([...selecionados]));

  barra.append(esquerda, btnApagar);
  cabecalho.parentElement.insertBefore(barra, cabecalho);
}

// ==========================================================================
// INICIALIZAÇÃO
// ==========================================================================

let iniciando = false;

async function iniciar() {
  // Guarda contra duas chamadas simultâneas (pageshow + visibilitychange
  // disparam quase juntos ao voltar para o app), que abririam dois listeners.
  if (iniciando || pararDeEscutar) return;
  iniciando = true;

  sessaoAtual = await sessao();
  montarBarraDeSelecao();
  montarAvatarNav();

  const cabecalhoNome = document.getElementById("headerNomeUsuario");
  if (cabecalhoNome) {
    const alvo = cabecalhoNome.querySelector("[data-nome]") || cabecalhoNome;
    alvo.textContent = sessaoAtual.perfil?.nome || sessaoAtual.username;
  }

  // Zera o contador de não lidas ao abrir a caixa de entrada.
  try { localStorage.setItem("naoLidas", "0"); } catch (_) {}
  window.atualizarBadge?.();

  // Autorização pelo uid: é o mesmo campo que as regras do Firestore checam.
  // Funciona igual para chats diretos e para grupos – "uids" existe nos dois.
  const consulta = query(
    collection(db, "chats"),
    where("uids", "array-contains", sessaoAtual.user.uid),
    orderBy("timestamp", "desc"),
    limit(100)
  );

  pararDeEscutar = onSnapshot(
    consulta,
    async (snap) => {
      conversas = snap.docs
        .map((d) => {
          const dados = d.data({ serverTimestamps: "estimate" });

          if (dados.tipo === "grupo") {
            return {
              id: d.id,
              tipo: "grupo",
              nome: dados.nome || "Grupo",
              participantes: dados.usuarios || [],
              ultimaMensagem: dados.ultimaMensagem || "",
              ultimoRemetente: dados.ultimoRemetente || "",
              ultimoTipo: dados.ultimoTipo || "",
              timestampMs: paraMillis(dados.timestamp),
              leituras: dados.leituras || {},
              raw: dados,
            };
          }

          const outro = (dados.usuarios || []).find((u) => u !== sessaoAtual.username);
          if (!outro) return null;

          // Abrir a tela de uma conversa já cria o documento dela; sem
          // mensagem nenhuma, ela aparecia no topo da lista dos DOIS lados
          // como "Toque para conversar" — inclusive para quem só teve o perfil
          // visitado. Conversa direta só entra na lista depois da 1ª mensagem.
          if (!dados.ultimaMensagem) return null;

          return {
            id: d.id,
            tipo: "direto",
            outroUsuario: outro,
            ultimaMensagem: dados.ultimaMensagem || "",
            ultimoRemetente: dados.ultimoRemetente || "",
            ultimoTipo: dados.ultimoTipo || "",
            timestampMs: paraMillis(dados.timestamp),
            leituras: dados.leituras || {},
            raw: dados,
          };
        })
        .filter(Boolean);

      // Diretos: o perfil do outro. Grupos: quem mandou a última mensagem,
      // para a prévia mostrar "Pedro: ..." em vez do @.
      await carregarPerfis([...new Set([
        ...conversas.filter((c) => c.tipo === "direto").map((c) => c.outroUsuario),
        ...conversas
          .filter((c) => c.tipo === "grupo" && c.ultimoRemetente && c.ultimoRemetente !== sessaoAtual.username)
          .map((c) => c.ultimoRemetente),
      ])]);

      listaEl.setAttribute("aria-busy", "false");
      renderizar();
      pedirPresenca();
      marcarEntregues(conversas);
    },
    (err) => {
      console.error("Erro ao escutar conversas:", err);
      listaEl.setAttribute("aria-busy", "false");
      const erro = estadoVazio("Não foi possível carregar", "Verifique sua conexão e tente de novo.", { href: "inbox.html", rotulo: "Tentar de novo" });
      erro.classList.add("estado-erro");
      listaEl.replaceChildren(erro);
    }
  );

  iniciando = false;
}

window.addEventListener("pagehide", () => {
  if (pararDeEscutar) pararDeEscutar();
  pararDeEscutar = null;
});

// Voltar do cache de retorno (minimizar e reabrir o navegador) não recarrega
// a página, e o listener já tinha sido desligado acima.
window.addEventListener("pageshow", (evento) => {
  if (evento.persisted) iniciar();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") iniciar();
});

iniciar();
