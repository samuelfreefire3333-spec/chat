import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, where, limit, getDocs, doc, getDoc, terminate, clearIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Avatar local: o anterior vinha de um site de ícones de terceiros, e bastava
// ele demorar (ou cair) para todo avatar sem foto virar uma imagem quebrada.
// Perfis antigos que gravaram o endereço externo continuam funcionando.
export const AVATAR_PADRAO = "/assets/avatar-padrao.svg";
// Grupos não têm foto: um desenho próprio, para não parecer uma pessoa sem foto.
export const AVATAR_GRUPO = "/assets/avatar-grupo.svg";

// ==========================================================================
// 1. SESSÃO
// ==========================================================================
// A identidade do app vem do Firebase Auth, nunca do localStorage. O
// localStorage é só cache de exibição (nome e foto) para a tela não piscar —
// se ele for adulterado, nada de importante muda, porque as regras do
// Firestore e o backend Go validam pelo uid do token.

let promessaSessao = null;

// Resolve o estado de autenticação uma única vez e desinscreve em seguida.
// A versão anterior registrava um listener por chamada e nunca limpava.
function esperarAuth() {
  return new Promise((resolve) => {
    const parar = onAuthStateChanged(auth, (user) => {
      parar();
      resolve(user);
    });
  });
}

async function carregarPerfil(uid) {
  const q = query(collection(db, "usuarios"), where("uid", "==", uid), limit(1));
  const snap = await getDocs(q);
  if (!snap.empty) {
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  // Conta criada antes de o campo uid existir: localiza pelo e-mail e deixa o
  // backend Go gravar o uid na próxima conexão.
  const email = (auth.currentUser?.email || "").toLowerCase().trim();
  if (!email) return null;

  const porEmail = await getDocs(
    query(collection(db, "usuarios"), where("email", "==", email), limit(5))
  );
  // Só um perfil SEM dono pode ser desta conta. Um perfil com uid de outra
  // conta e o mesmo e-mail é de outra pessoa — nunca "vira" esta sessão.
  const semDono = porEmail.docs.find((d) => !d.data().uid);
  if (!semDono) return null;
  return { id: semDono.id, ...semDono.data() };
}

// Preferências do aparelho (não da conta): sobrevivem ao sair da conta.
// Antes o logout apagava tudo e o app voltava para o tema do sistema.
const PREFERENCIAS_LOCAIS = ["tema", "somMensagens"];

function limparCacheLocal() {
  try {
    const guardadas = PREFERENCIAS_LOCAIS
      .map((chave) => [chave, localStorage.getItem(chave)])
      .filter(([, valor]) => valor !== null);
    localStorage.clear();
    guardadas.forEach(([chave, valor]) => localStorage.setItem(chave, valor));
  } catch (_) {}
}

/**
 * Devolve a sessão corrente: { user, username, perfil }.
 * Sem login, redireciona para login.html — a menos que exigirLogin seja false,
 * caso em que devolve null.
 */
export function sessao({ exigirLogin = true } = {}) {
  if (!promessaSessao) {
    promessaSessao = (async () => {
      const user = await esperarAuth();
      if (!user) return null;

      const perfil = await carregarPerfil(user.uid);
      if (!perfil) return null;

      // Atualiza o cache de exibição.
      try {
        localStorage.setItem("usuario", perfil.usuario || perfil.id);
        if (perfil.nome) localStorage.setItem("nome", perfil.nome);
        if (perfil.foto) localStorage.setItem("foto", perfil.foto);
      } catch (_) { /* modo privado do navegador */ }

      return { user, username: (perfil.usuario || perfil.id).toLowerCase(), perfil };
    })();
  }

  return promessaSessao.then((s) => {
    // tema.js esconde a tela até aqui (ver a classe "aguardando-sessao").
    if (s || !exigirLogin) {
      document.documentElement.classList.remove("aguardando-sessao");
    }

    if (!s && exigirLogin) {
      limparCacheLocal();
      window.location.replace("login.html");
      // Promise que nunca resolve: impede o código seguinte de rodar durante
      // o redirecionamento.
      return new Promise(() => {});
    }
    return s;
  });
}

/** Limpa o cache de sessão (usado no logout). */
export function encerrarSessao() {
  promessaSessao = null;
  limparCacheLocal();
}

/**
 * Apaga a cópia offline das conversas guardada neste navegador.
 *
 * O Firestore roda com cache persistente (IndexedDB) para o app abrir sem
 * rede. Esse cache fica no aparelho mesmo depois de sair da conta — num
 * computador compartilhado, a próxima pessoa conseguia ler as mensagens pelo
 * DevTools. Sair agora apaga essa cópia.
 *
 * O Firestore só deixa apagar com ele parado nesta aba e sem outra aba do app
 * aberta. Por isso:
 *   - ao sair, encerrar=true para o Firestore desta aba (a página muda logo
 *     em seguida para o login);
 *   - a tela de login tenta de novo sem encerrar (lá o Firestore ainda não
 *     começou), o que cobre a sessão que caiu por expiração ou por "sair de
 *     todos os aparelhos" em outro lugar.
 * Devolve false quando não deu (outra aba aberta); nunca lança.
 */
export function apagarCopiaOffline({ encerrar = false } = {}) {
  const tentativa = (async () => {
    try {
      if (encerrar) await terminate(db);
      await clearIndexedDbPersistence(db);
      return true;
    } catch (erro) {
      console.warn("A cópia offline das conversas não pôde ser apagada agora:", erro?.code || erro);
      return false;
    }
  })();
  // O IndexedDB espera as outras abas soltarem o banco; login e logout não
  // podem ficar presos esperando por isso.
  const limite = new Promise((resolve) => setTimeout(() => resolve(false), 4000));
  return Promise.race([tentativa, limite]);
}

/**
 * Atualiza o perfil já resolvido nesta aba, sem uma nova ida ao Firestore.
 * Sem isto, salvar nome ou foto só aparecia depois de recarregar a página,
 * porque a promessa de sessão fica em cache no módulo.
 */
export function atualizarPerfilEmCache(campos) {
  if (!promessaSessao || !campos) return;

  promessaSessao = promessaSessao.then((s) => {
    if (s?.perfil) Object.assign(s.perfil, campos);
    return s;
  });

  try {
    if (campos.nome) localStorage.setItem("nome", campos.nome);
    if (campos.foto) localStorage.setItem("foto", campos.foto);
  } catch (_) {}
}

// ==========================================================================
// 2. SANITIZAÇÃO
// ==========================================================================

/** Escapa texto para interpolação em HTML. Prefira criar nós com textContent. */
export function escaparTexto(texto) {
  if (texto === null || texto === undefined) return "";
  const mapa = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
  return String(texto).replace(/[&<>"']/g, (c) => mapa[c]);
}

/**
 * Valida uma URL para uso em src/href.
 *
 * Diferente da versão anterior, NÃO escapa caracteres: escapar '&' quebrava as
 * URLs assinadas do Firebase Storage (era o bug da foto de perfil). Aqui o que
 * se faz é recusar esquemas perigosos e devolver a URL intacta.
 */
// Hosts de onde o app aceita carregar imagem e áudio. É o mesmo conjunto que a
// CSP (netlify.toml) libera; o que estiver fora cai no avatar padrão em vez de
// virar uma imagem quebrada (ou um rastreador de quem abriu o perfil).
const HOSTS_DE_MIDIA = ["firebasestorage.googleapis.com"];
const SUFIXOS_DE_MIDIA = [".firebasestorage.app"];

export function urlSegura(url, alternativa = AVATAR_PADRAO) {
  if (typeof url !== "string" || !url.trim()) return alternativa;

  try {
    const parsed = new URL(url, window.location.origin);
    // Arquivos do próprio app (avatar padrão, ícones).
    if (parsed.origin === window.location.origin && (parsed.protocol === "https:" || parsed.protocol === "http:")) return parsed.href;
    // URL blob: criada nesta aba (mídia privada já baixada e conferida).
    if (parsed.protocol === "blob:" && url.startsWith(`blob:${window.location.origin}/`)) return url;
    if (parsed.protocol === "https:"
      && (HOSTS_DE_MIDIA.includes(parsed.hostname) || SUFIXOS_DE_MIDIA.some((s) => parsed.hostname.endsWith(s)))) {
      return url;
    }
    // data: só para imagem rasterizada — nunca data:text/html nem SVG.
    if (parsed.protocol === "data:" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(url)) return url;
  } catch (_) { /* URL malformada */ }

  // O avatar padrão antigo vinha de um site de ícones de terceiros.
  if (!/cdn-icons-png\.flaticon\.com/.test(url)) console.warn("URL bloqueada por segurança.");
  return alternativa;
}

/**
 * Valida um destino de redirecionamento interno. Impede open redirect
 * (//site-externo) e javascript: vindos de parâmetros de URL.
 */
export function destinoSeguro(destino, alternativa = "inbox.html") {
  if (typeof destino !== "string" || !destino) return alternativa;
  // Recusa qualquer coisa com esquema, barras iniciais duplas ou barra à ré.
  if (/^[a-z][a-z0-9+.-]*:/i.test(destino)) return alternativa;
  if (destino.startsWith("//") || destino.startsWith("\\")) return alternativa;
  if (destino.includes("..")) return alternativa;
  // Só páginas do próprio app.
  if (!/^[a-z0-9._-]+\.html(\?[^#]*)?(#.*)?$/i.test(destino)) return alternativa;
  return destino;
}

// ==========================================================================
// 3. AVISOS (TOAST)
// ==========================================================================

let timeoutToast = null;

// O visual de cada tipo mora no style.css (#toast-aviso[data-tipo]).
// Antes cada chamada passava uma cor em hexadecimal, e aviso sem cor saía
// vermelho — "Enviando imagem..." tinha a mesma cara de um erro.
const TIPOS_DE_AVISO = new Set(["info", "sucesso", "alerta", "erro"]);

// Compatibilidade: as cores antigas continuam aceitas e viram o tipo
// equivalente, para nenhuma chamada esquecida mudar de aparência.
const COR_PARA_TIPO = { "#00a884": "sucesso", "#e0a800": "alerta", "#ed4956": "erro" };

/**
 * Mostra um aviso rápido na base da tela.
 * @param {string} mensagem
 * @param {"info"|"sucesso"|"alerta"|"erro"} [tipo="info"]
 */
export function aviso(mensagem, tipo = "info") {
  let toast = document.getElementById("toast-aviso");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast-aviso";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }

  const chave = String(tipo).trim();
  const tipoFinal = COR_PARA_TIPO[chave.toLowerCase()] || chave;

  toast.textContent = mensagem;
  if (TIPOS_DE_AVISO.has(tipoFinal)) {
    toast.dataset.tipo = tipoFinal;
    toast.style.removeProperty("background");
    toast.style.removeProperty("color");
  } else {
    // Cor personalizada: mantém o comportamento antigo.
    toast.dataset.tipo = "personalizado";
    toast.style.background = chave;
    toast.style.color = "var(--text-on-color)";
  }
  toast.classList.add("show");

  // Mensagem longa fica mais tempo na tela: 3 s eram pouco para ler uma
  // frase inteira, e o aviso agora quebra linha em vez de cortar o texto.
  const duracao = Math.min(6000, Math.max(3000, 1800 + String(mensagem).length * 45));
  clearTimeout(timeoutToast);
  timeoutToast = setTimeout(() => toast.classList.remove("show"), duracao);
}

/**
 * Confirmação em modal, substituindo o confirm() nativo.
 *
 * Numa ação de perigo o foco começa em "Cancelar": antes começava no botão de
 * confirmar e um Enter distraído apagava a conversa. Tab fica preso dentro do
 * modal e o foco volta para onde estava ao fechar.
 */
export function confirmar(texto, { confirmarTexto = "Confirmar", perigo = true, titulo = "" } = {}) {
  return new Promise((resolve) => {
    const focoAnterior = document.activeElement;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const caixa = document.createElement("div");
    caixa.className = "modal-confirmacao";
    caixa.setAttribute("role", "alertdialog");
    caixa.setAttribute("aria-modal", "true");

    const idTexto = `modal-texto-${Date.now()}`;
    caixa.setAttribute("aria-describedby", idTexto);

    if (titulo) {
      const h = document.createElement("h2");
      h.className = "modal-titulo";
      h.id = `${idTexto}-titulo`;
      h.textContent = titulo;
      caixa.setAttribute("aria-labelledby", h.id);
      caixa.appendChild(h);
    }

    const p = document.createElement("p");
    p.id = idTexto;
    p.textContent = texto;

    const acoes = document.createElement("div");
    acoes.className = "modal-acoes";

    const btnCancelar = document.createElement("button");
    btnCancelar.type = "button";
    btnCancelar.className = "btn-modal";
    btnCancelar.textContent = "Cancelar";

    const btnOk = document.createElement("button");
    btnOk.type = "button";
    btnOk.className = perigo ? "btn-modal btn-modal-perigo" : "btn-modal btn-modal-primario";
    btnOk.textContent = confirmarTexto;

    acoes.append(btnCancelar, btnOk);
    caixa.append(p, acoes);
    overlay.appendChild(caixa);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("aberto"));
    (perigo ? btnCancelar : btnOk).focus();

    let fechado = false;
    const fechar = (resultado) => {
      if (fechado) return;
      fechado = true;
      overlay.classList.remove("aberto");
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener("keydown", aoTeclar, true);
      try { focoAnterior?.focus?.(); } catch (_) {}
      resolve(resultado);
    };
    const aoTeclar = (e) => {
      if (e.key === "Escape") { e.preventDefault(); fechar(false); return; }
      if (e.key === "Tab") {
        // Mantém o Tab entre os dois botões.
        e.preventDefault();
        (document.activeElement === btnOk ? btnCancelar : btnOk).focus();
      }
    };

    btnCancelar.addEventListener("click", () => fechar(false));
    btnOk.addEventListener("click", () => fechar(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(false); });
    document.addEventListener("keydown", aoTeclar, true);
  });
}

// ==========================================================================
// 4. TEMPO
// ==========================================================================

export function tempoRelativo(timestamp) {
  if (!timestamp) return "";

  const ms = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return "";

  const diff = Date.now() - ms;
  if (diff < 0) return "agora mesmo"; // relógio adiantado do dispositivo

  const minutos = Math.floor(diff / 60000);
  if (minutos < 1) return "agora mesmo";
  if (minutos < 60) return `há ${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;

  const dias = Math.floor(horas / 24);
  if (dias === 1) return "ontem";
  if (dias < 7) return `há ${dias} dias`;

  return new Date(ms).toLocaleDateString("pt-BR");
}

const DIAS_DA_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/**
 * "visto por último há 5 min", "visto por último ontem às 21:40"...
 *
 * Até 24 horas o texto é relativo (é o que muda a cada minuto e que a pessoa
 * lê de relance); depois disso vira data e hora, como nos mensageiros
 * conhecidos. Com { curto: true } sai "visto há 5 min", para listas.
 * Sem horário conhecido devolve "" — quem chama decide o que mostrar.
 */
export function vistoPorUltimo(timestamp, { curto = false } = {}) {
  const ms = paraMillis(timestamp);
  if (!ms) return "";

  const prefixo = curto ? "visto" : "visto por último";
  const diff = Date.now() - ms;

  if (diff < 60_000) return `${prefixo} agora mesmo`;

  const minutos = Math.floor(diff / 60_000);
  if (minutos < 60) return `${prefixo} há ${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${prefixo} há ${horas} h`;

  const quando = new Date(ms);
  const hora = quando.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);
  if (quando.toDateString() === ontem.toDateString()) return `${prefixo} ontem às ${hora}`;

  const dias = Math.floor(horas / 24);
  if (dias < 7) return `${prefixo} ${DIAS_DA_SEMANA[quando.getDay()]} às ${hora}`;

  const data = quando.toLocaleDateString("pt-BR", curto ? { day: "2-digit", month: "2-digit" } : undefined);
  return `${prefixo} em ${data}`;
}

export function horaCurta(timestamp) {
  if (!timestamp) return "";
  const ms = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Converte Timestamp do Firestore, Date ou número em milissegundos. */
export function paraMillis(valor) {
  if (!valor) return 0;
  if (typeof valor === "number") return valor;
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor.toMillis === "function") return valor.toMillis();
  if (typeof valor.seconds === "number") return valor.seconds * 1000;
  return 0;
}

// ==========================================================================
// 5. UTILITÁRIOS
// ==========================================================================

/** ID da sala de chat: sempre a combinação alfabética dos dois usuários. */
export function idDoChat(a, b) {
  return [a, b].map((u) => String(u).toLowerCase().trim()).sort().join("_");
}

export async function buscarPerfilPorUsername(username) {
  const alvo = String(username).toLowerCase().trim();

  const direto = await getDoc(doc(db, "usuarios", alvo));
  if (direto.exists()) return { id: direto.id, ...direto.data() };

  const snap = await getDocs(
    query(collection(db, "usuarios"), where("usuario", "==", alvo), limit(1))
  );
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/** Aplica no elemento a foto do avatar já validada. */
export function definirAvatar(elemento, url) {
  if (!elemento) return;
  elemento.src = urlSegura(url, AVATAR_PADRAO);
  elemento.addEventListener("error", () => { elemento.src = AVATAR_PADRAO; }, { once: true });
}

/**
 * Mostrar/esconder usam a classe .u-hidden (display: none !important no
 * style.css). Antes cada tela alternava style.display na mão, e a classe
 * perdia para o display do próprio componente: o link "Painel Profissional"
 * aparecia para todo mundo e o botão de câmera aparecia em chamada de voz.
 */
export function mostrar(elemento, visivel = true) {
  elemento?.classList.toggle("u-hidden", !visivel);
}

export function esconder(elemento) {
  elemento?.classList.add("u-hidden");
}

/**
 * Copia texto para a área de transferência. Usa a API moderna quando existe
 * e, sem ela (navegador antigo ou página fora de HTTPS), o caminho antigo com
 * um campo escondido. Devolve true se copiou.
 */
export async function copiarTexto(texto) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch (_) { /* sem permissão: tenta o caminho antigo */ }

  try {
    const campo = document.createElement("textarea");
    campo.value = texto;
    campo.setAttribute("readonly", "");
    campo.className = "sr-only";
    document.body.appendChild(campo);
    campo.select();
    const ok = document.execCommand("copy");
    campo.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

/**
 * Compartilha um link pela folha nativa do sistema (celular, Windows, macOS)
 * e, onde ela não existe, copia o link e avisa.
 * Devolve "compartilhado", "cancelado", "copiado" ou "falhou".
 */
export async function compartilharLink({ titulo = "", texto = "", url }) {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: titulo, text: texto, url });
      return "compartilhado";
    } catch (erro) {
      if (erro?.name === "AbortError") return "cancelado";
      // Qualquer outro erro (sem permissão, sem gesto do usuário): copia.
    }
  }
  const ok = await copiarTexto(url);
  aviso(ok ? "Link copiado." : "Não foi possível copiar o link.", ok ? "sucesso" : "erro");
  return ok ? "copiado" : "falhou";
}

/**
 * Botões de "mostrar senha" (olho) ligados por data-alvo ao id do campo.
 * O texto do rótulo acompanha o estado, para leitores de tela.
 */
export function configurarCamposDeSenha(raiz = document) {
  raiz.querySelectorAll(".btn-ver-senha[data-alvo]").forEach((btn) => {
    const campo = document.getElementById(btn.dataset.alvo);
    if (!campo || btn.dataset.ligado) return;
    btn.dataset.ligado = "sim";
    btn.addEventListener("click", () => {
      const mostrando = campo.type === "text";
      campo.type = mostrando ? "password" : "text";
      btn.setAttribute("aria-pressed", mostrando ? "false" : "true");
      btn.setAttribute("aria-label", mostrando ? "Mostrar senha" : "Esconder senha");
      btn.classList.toggle("mostrando", !mostrando);
      // Mantém o cursor no campo, no fim do texto.
      campo.focus({ preventScroll: true });
      try { campo.setSelectionRange(campo.value.length, campo.value.length); } catch (_) {}
    });
  });
}

/** Preenche o avatar da barra lateral a partir do cache e depois da sessão. */
export async function montarAvatarNav() {
  const nav = document.getElementById("navAvatar");
  if (!nav) return;

  try {
    const cache = localStorage.getItem("foto");
    if (cache) definirAvatar(nav, cache);
  } catch (_) {}

  const s = await sessao({ exigirLogin: false });
  if (s?.perfil?.foto) definirAvatar(nav, s.perfil.foto);
}

// ==========================================================================
// 6. SERVICE WORKER
// ==========================================================================

if ("serviceWorker" in navigator) {
  // Havia um controlador antes desta página carregar? Se não havia, a troca de
  // controle abaixo é só a primeira instalação — não é atualização e não deve
  // recarregar nada.
  const jaTinhaControlador = !!navigator.serviceWorker.controller;
  let recarregando = false;

  // O Service Worker novo chama skipWaiting() assim que instala, então ele
  // assume o controle na hora. Só que a página ABERTA continua rodando os
  // arquivos antigos até alguém recarregar.
  //
  // Sem isto, uma correção publicada podia demorar várias visitas para
  // aparecer — a pessoa continuava vendo o bug já corrigido e jurando que
  // nada tinha mudado.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!jaTinhaControlador || recarregando) return;

    // A janela da chamada NUNCA recarrega sozinha: recarregar destrói a
    // conexão WebRTC e derruba a chamada. Ela já abre a versão nova na
    // próxima chamada (ou quando volta para a conversa ao encerrar).
    if (document.documentElement.dataset.semRecargaAutomatica === "sim") return;

    recarregando = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then((registro) => {
        // Procura versão nova a cada carregamento e de hora em hora, para quem
        // deixa o app aberto o dia inteiro.
        registro?.update?.().catch(() => {});
        setInterval(() => registro?.update?.().catch(() => {}), 60 * 60 * 1000);
      })
      .catch((err) => {
        console.error("Falha ao registrar o Service Worker:", err);
      });
  });
}

const Core = {
  AVATAR_PADRAO,
  AVATAR_GRUPO,
  sessao,
  encerrarSessao,
  escaparTexto,
  urlSegura,
  destinoSeguro,
  aviso,
  confirmar,
  tempoRelativo,
  vistoPorUltimo,
  horaCurta,
  paraMillis,
  idDoChat,
  buscarPerfilPorUsername,
  definirAvatar,
  montarAvatarNav,
  atualizarPerfilEmCache,
  apagarCopiaOffline,
  mostrar,
  esconder,
  copiarTexto,
  compartilharLink,
  configurarCamposDeSenha,
};

export default Core;
