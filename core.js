import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, where, limit, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const AVATAR_PADRAO = "https://cdn-icons-png.flaticon.com/512/149/149071.png";

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
    query(collection(db, "usuarios"), where("email", "==", email), limit(1))
  );
  if (porEmail.empty) return null;
  return { id: porEmail.docs[0].id, ...porEmail.docs[0].data() };
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
    if (!s && exigirLogin) {
      try { localStorage.clear(); } catch (_) {}
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
  try { localStorage.clear(); } catch (_) {}
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
export function urlSegura(url, alternativa = AVATAR_PADRAO) {
  if (typeof url !== "string" || !url.trim()) return alternativa;

  try {
    const parsed = new URL(url, window.location.origin);
    const esquemasOk = ["http:", "https:", "blob:"];
    if (esquemasOk.includes(parsed.protocol)) return url;
    // data: só para imagem, nunca data:text/html.
    if (parsed.protocol === "data:" && /^data:image\//i.test(url)) return url;
  } catch (_) { /* URL malformada */ }

  console.warn("URL bloqueada por segurança:", url);
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

export function aviso(mensagem, cor = "var(--primary-accent)") {
  let toast = document.getElementById("toast-aviso");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast-aviso";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }

  toast.textContent = mensagem;
  toast.style.background = cor;
  toast.classList.add("show");

  clearTimeout(timeoutToast);
  timeoutToast = setTimeout(() => toast.classList.remove("show"), 3000);
}

/** Confirmação em modal, substituindo o confirm() nativo. */
export function confirmar(texto, { confirmarTexto = "Confirmar", perigo = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const caixa = document.createElement("div");
    caixa.className = "modal-confirmacao";
    caixa.setAttribute("role", "alertdialog");
    caixa.setAttribute("aria-modal", "true");

    const p = document.createElement("p");
    p.textContent = texto;

    const acoes = document.createElement("div");
    acoes.className = "modal-acoes";

    const btnCancelar = document.createElement("button");
    btnCancelar.type = "button";
    btnCancelar.className = "btn-modal";
    btnCancelar.textContent = "Cancelar";

    const btnOk = document.createElement("button");
    btnOk.type = "button";
    btnOk.className = perigo ? "btn-modal btn-modal-perigo" : "btn-modal";
    btnOk.textContent = confirmarTexto;

    acoes.append(btnCancelar, btnOk);
    caixa.append(p, acoes);
    overlay.appendChild(caixa);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("aberto"));
    btnOk.focus();

    const fechar = (resultado) => {
      overlay.classList.remove("aberto");
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener("keydown", aoTeclar);
      resolve(resultado);
    };
    const aoTeclar = (e) => {
      if (e.key === "Escape") fechar(false);
      if (e.key === "Enter") fechar(true);
    };

    btnCancelar.addEventListener("click", () => fechar(false));
    btnOk.addEventListener("click", () => fechar(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(false); });
    document.addEventListener("keydown", aoTeclar);
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
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Falha ao registrar o Service Worker:", err);
    });
  });
}

const Core = {
  AVATAR_PADRAO,
  sessao,
  encerrarSessao,
  escaparTexto,
  urlSegura,
  destinoSeguro,
  aviso,
  confirmar,
  tempoRelativo,
  horaCurta,
  paraMillis,
  idDoChat,
  buscarPerfilPorUsername,
  definirAvatar,
  montarAvatarNav,
};

export default Core;
