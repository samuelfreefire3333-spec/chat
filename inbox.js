import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, onSnapshot, getDocs, documentId, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, {
  sessao, definirAvatar, horaCurta, tempoRelativo, paraMillis,
  montarAvatarNav, AVATAR_PADRAO
} from "./core.js";
import Radar from "./radar.js";
import { apagarChat } from "./mensagens.js";

const listaEl = document.getElementById("listaConversas");
let sessaoAtual = null;
let pararDeEscutar = null;
let conversas = [];
const cachePerfis = new Map();

// Presença recebida pelo WebSocket, guardada fora do DOM. A lista inteira é
// redesenhada a cada atualização do Firestore; sem esta memória, todo mundo
// voltava para "Offline" sempre que qualquer conversa recebia uma mensagem.
const presenca = new Map(); // username -> "online" | "offline"

// Estado do modo de seleção múltipla.
let modoSelecao = false;
const selecionados = new Set();

// ==========================================================================
// PERFIS DOS CONTATOS
// ==========================================================================

/**
 * Busca os perfis que faltam em UMA consulta com "in", em vez de uma consulta
 * por conversa. Antes cada card disparava um getDocs próprio.
 * Só se aplica a chats diretos – um grupo não tem "o outro perfil", ele tem
 * nome e (por enquanto) avatar genérico próprios.
 */
async function carregarPerfis(usernames) {
  const faltando = usernames.filter((u) => !cachePerfis.has(u));
  if (!faltando.length) return;

  // O operador "in" aceita no máximo 30 valores por consulta.
  for (let i = 0; i < faltando.length; i += 30) {
    const lote = faltando.slice(i, i + 30);
    try {
      // Eng. de Software Avançada: Busca paralela para mitigar anomalias de Document ID vs Campo Username
      const qPorId = getDocs(query(collection(db, "usuarios"), where(documentId(), "in", lote)));
      const qPorCampo = getDocs(query(collection(db, "usuarios"), where("usuario", "in", lote)));
      
      const [snapId, snapCampo] = await Promise.all([qPorId, qPorCampo]);

      // Função auxiliar para popular o cache com os resultados
      const popularCache = (snap) => {
        snap.forEach((d) => {
          const dados = d.data();
          const username = dados.usuario || d.id; // Fallback seguro
          
          // Garante a existência do objeto usando a chave de Username e a de Document ID.
          // Isso imuniza a renderização contra desalinhamentos estruturais.
          if (!cachePerfis.has(username)) {
            cachePerfis.set(username, { id: d.id, ...dados });
          }
          if (!cachePerfis.has(d.id)) {
            cachePerfis.set(d.id, { id: d.id, ...dados });
          }
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

function textoDeStatus(perfil) {
  const relativo = tempoRelativo(perfil?.lastSeen);
  return relativo ? `Visto ${relativo}` : "Offline";
}

function montarCard(chat) {
  const ehGrupo = chat.tipo === "grupo";
  const perfil = ehGrupo ? null : (cachePerfis.get(chat.outroUsuario) || {});
  
  const item = document.createElement("div");
  item.className = "chat-item";
  item.id = `chat-card-${chat.id}`;
  item.dataset.chatId = chat.id;
  item.dataset.tipo = chat.tipo;
  if (!ehGrupo) item.dataset.usuario = chat.outroUsuario;
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-label", `Conversa com ${ehGrupo ? chat.nome : (perfil.nome || chat.outroUsuario)}`);

  const check = document.createElement("div");
  check.className = "chat-checkbox";
  item.appendChild(check);

  const avatar = document.createElement("img");
  avatar.className = "chat-avatar";
  avatar.alt = "";
  definirAvatar(avatar, ehGrupo ? AVATAR_PADRAO : perfil.foto);
  item.appendChild(avatar);

  const info = document.createElement("div");
  info.className = "chat-info";

  const linhaTopo = document.createElement("div");
  linhaTopo.className = "chat-linha-topo";

  const nome = document.createElement("strong");
  nome.className = "chat-name";
  nome.textContent = ehGrupo ? chat.nome : (perfil.nome || chat.outroUsuario);

  const hora = document.createElement("span");
  hora.className = "chat-hora";
  hora.textContent = horaCurta(chat.timestampMs);

  linhaTopo.append(nome, hora);

  const status = document.createElement("span");
  status.className = "chat-status";
  if (ehGrupo) {
    status.textContent = `${chat.participantes.length} participantes`;
  } else {
    const online = presenca.get(chat.outroUsuario) === "online";
    status.id = `status-inbox-${chat.outroUsuario}`;
    status.dataset.online = online ? "true" : "false";
    status.classList.toggle("online", online);
    status.textContent = online ? "Online" : textoDeStatus(perfil);
  }

  const previa = document.createElement("span");
  previa.className = "chat-preview";
  
  const souEuUltimo = chat.ultimoRemetente === sessaoAtual.username;
  const prefixo = souEuUltimo
    ? "Você: "
    : (ehGrupo && chat.ultimoRemetente ? `${chat.ultimoRemetente}: ` : "");
  previa.textContent = prefixo + (chat.ultimaMensagem || "Abra para conversar");

  // A chave de "último lido" usa o ID do chat (funciona igual para grupo e
  // direto) em vez do username do outro contato como era antes.
  const ultimoAcesso = parseInt(localStorage.getItem(`last_read_${chat.id}`), 10) || 0;
  const temNovidade = !souEuUltimo && chat.timestampMs > ultimoAcesso;

  if (temNovidade) {
    previa.classList.add("nao-lida");
    hora.classList.add("nao-lida");
  }

  info.append(linhaTopo, status, previa);
  item.appendChild(info);

  if (temNovidade) {
    const ponto = document.createElement("div");
    ponto.className = "chat-dot";
    item.appendChild(ponto);
  }

  return item;
}

function renderizar() {
  if (!conversas.length) {
    listaEl.replaceChildren();
    const vazio = document.createElement("p");
    vazio.className = "lista-vazia";
    vazio.setAttribute("role", "status");
    vazio.textContent = "Nenhuma mensagem ainda.";
    listaEl.appendChild(vazio);
    return;
  }

  const fragmento = document.createDocumentFragment();
  conversas.forEach((chat) => fragmento.appendChild(montarCard(chat)));
  listaEl.replaceChildren(fragmento);

  aplicarEstadoDeSelecao();
  pedirPresencaDeTodos();
}

function pedirPresencaDeTodos() {
  // Presença é de chat direto – um grupo não tem "um" status online.
  conversas.filter((c) => c.tipo === "direto").forEach((chat) => Radar.verificarStatus(chat.outroUsuario));
}

// ==========================================================================
// PRESENÇA
// ==========================================================================

window.addEventListener("mensagem_servidor", (e) => {
  const msg = e.detail;
  if (!msg || (msg.type !== "status_update" && msg.type !== "status_reply")) return;

  const el = document.getElementById(`status-inbox-${msg.from}`);
  if (!el) return;

  if (msg.content === "online") {
    presenca.set(msg.from, "online");
    el.textContent = "Online";
    el.dataset.online = "true";
    el.classList.add("online");
    return;
  }

  presenca.set(msg.from, "offline");
  el.dataset.online = "false";
  el.classList.remove("online");
  const perfil = cachePerfis.get(msg.from);
  // O servidor manda o lastSeen junto na resposta; se não vier, usa o do cache.
  const lastSeen = msg.lastSeen || perfil?.lastSeen || 0;
  if (perfil) perfil.lastSeen = lastSeen;
  el.textContent = textoDeStatus({ lastSeen });
});

// Ao reconectar (inclusive quando o servidor gratuito acorda), pergunta tudo
// de novo em vez de deixar a lista congelada no último estado conhecido.
window.addEventListener("radar_conectado", pedirPresencaDeTodos);

// Atualiza os textos relativos ("há 5 min") de quem está offline.
setInterval(() => {
  document.querySelectorAll("[id^='status-inbox-']").forEach((el) => {
    if (el.dataset.online === "true") return;
    const username = el.id.replace("status-inbox-", "");
    const perfil = cachePerfis.get(username);
    if (perfil?.lastSeen) el.textContent = textoDeStatus(perfil);
  });
}, 60000);

// ==========================================================================
// SELEÇÃO MÚLTIPLA E EXCLUSÃO
// ==========================================================================

function aplicarEstadoDeSelecao() {
  const barra = document.getElementById("selectionBar");
  const contador = document.getElementById("selectionCount");

  if (barra) barra.style.display = modoSelecao ? "flex" : "none";
  if (contador) contador.textContent = String(selecionados.size);

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
// desmarcava na hora o item recém-selecionado e o modo de seleção fechava
// sozinho — no celular era impossível selecionar qualquer conversa.
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

async function apagarConversas(ids) {
  if (!ids.length) return;

  const algumGrupo = ids.some((id) => conversas.find((c) => c.id === id)?.tipo === "grupo");
  const plural = ids.length > 1;

  const ok = await Core.confirmar(
    plural
      ? `Apagar ${ids.length} conversas? As mensagens serão excluídas para todos os participantes.`
      : algumGrupo
        ? "Apagar este grupo? As mensagens serão excluídas para todos os participantes."
        : "Apagar esta conversa? As mensagens serão excluídas para você e para o outro participante.",
    { confirmarTexto: "Apagar" }
  );
  if (!ok) return;

  Core.aviso(plural ? "Apagando conversas..." : "Apagando conversa...");
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
    Core.aviso(`Não foi possível apagar ${falhas.length} conversa(s).`, "#ed4956");
  } else {
    Core.aviso("Conversa apagada.", "#00a884");
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
    {
      rotulo: "Abrir conversa",
      acao: () => { window.location.href = linkDaConversa; },
    },
  ];

  if (!ehGrupo) {
    opcoes.push({
      rotulo: "Ver perfil",
      acao: () => { window.location.href = `perfil.html?u=${encodeURIComponent(usuario)}`; },
    });
  }

  opcoes.push(
    {
      rotulo: "Selecionar",
      acao: () => ativarModoSelecao(chatId),
    },
    {
      rotulo: ehGrupo ? "Apagar grupo para todos" : "Apagar conversa",
      perigo: true,
      acao: () => apagarConversas([chatId]),
    }
  );

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

// Um dedo nunca fica perfeitamente parado. A versão anterior cancelava o
// toque longo no primeiro pointermove, então ele praticamente nunca chegava
// aos 500 ms num celular de verdade. Mesma tolerância já usada no chat.
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

// ==========================================================================
// BARRA DE SELEÇÃO
// ==========================================================================

function montarBarraDeSelecao() {
  const cabecalho = document.querySelector(".inbox-header");
  if (!cabecalho || document.getElementById("selectionBar")) return;

  const barra = document.createElement("div");
  barra.id = "selectionBar";
  barra.className = "selection-bar";
  barra.style.display = "none";

  const esquerda = document.createElement("div");
  esquerda.className = "selection-esquerda";

  const btnFechar = document.createElement("button");
  btnFechar.type = "button";
  btnFechar.className = "selection-btn";
  btnFechar.setAttribute("aria-label", "Cancelar seleção");
  btnFechar.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  btnFechar.addEventListener("click", cancelarSelecao);

  const contador = document.createElement("span");
  contador.id = "selectionCount";
  contador.className = "selection-contador";
  contador.textContent = "0";

  esquerda.append(btnFechar, contador);

  const btnApagar = document.createElement("button");
  btnApagar.type = "button";
  btnApagar.className = "selection-btn";
  btnApagar.setAttribute("aria-label", "Apagar conversas selecionadas");
  btnApagar.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
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

  // textContent apagava o <svg> da setinha que está dentro do <h1>. O nome
  // agora vai num <span> próprio e o ícone continua onde estava.
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
          const dados = d.data();
          
          if (dados.tipo === "grupo") {
            return {
              id: d.id,
              tipo: "grupo",
              nome: dados.nome || "Grupo",
              participantes: dados.usuarios || [],
              ultimaMensagem: dados.ultimaMensagem || "",
              ultimoRemetente: dados.ultimoRemetente || "",
              timestampMs: paraMillis(dados.timestamp),
            };
          }
          
          const outro = (dados.usuarios || []).find((u) => u !== sessaoAtual.username);
          if (!outro) return null;

          return {
            id: d.id,
            tipo: "direto",
            outroUsuario: outro,
            ultimaMensagem: dados.ultimaMensagem || "",
            ultimoRemetente: dados.ultimoRemetente || "",
            timestampMs: paraMillis(dados.timestamp),
          };
        })
        .filter(Boolean);

      await carregarPerfis(
        conversas.filter((c) => c.tipo === "direto").map((c) => c.outroUsuario)
      );

      renderizar();
    },
    (err) => {
      console.error("Erro ao escutar conversas:", err);
      listaEl.replaceChildren();
      const erro = document.createElement("p");
      erro.className = "lista-vazia lista-erro";
      erro.textContent = "Não foi possível carregar suas conversas.";
      listaEl.appendChild(erro);
    }
  );

  iniciando = false;
}

window.addEventListener("pagehide", () => {
  if (pararDeEscutar) pararDeEscutar();
  pararDeEscutar = null;
});

// Voltar do cache de retorno (minimizar e reabrir o navegador) não recarrega
// a página, e o listener já tinha sido desligado acima. Sem religar aqui, a
// caixa de entrada ficava congelada no estado de antes.
window.addEventListener("pageshow", (evento) => {
  if (evento.persisted) iniciar();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") iniciar();
});

iniciar();