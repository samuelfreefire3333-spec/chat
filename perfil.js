import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, deleteDoc, collection, query, where, onSnapshot,
  getDocs, getCountFromServer, serverTimestamp, limit, documentId
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, {
  sessao, definirAvatar, montarAvatarNav, buscarPerfilPorUsername, AVATAR_PADRAO
} from "./core.js";

// ==========================================================================
// MODELO DE SEGUIDORES
// ==========================================================================
// Antes havia DOIS sistemas convivendo: um array `seguidores`/`seguindo`
// dentro do documento do usuário e uma coleção `seguidores` legada. Toda
// abertura de perfil reconciliava os dois, gastando quatro consultas extras.
//
// Ficou só a coleção de arestas, por dois motivos:
//  1. Segurança — o array vivia no documento de OUTRA pessoa, então seguir
//     alguém exigia permissão de escrita no perfil alheio. Com uma aresta por
//     documento, cada escrita é autorizada pelo próprio uid de quem segue.
//  2. Escala — um array dentro do documento cresce sem limite até estourar.

const idAresta = (seguidor, seguindo) => `${seguidor}_${seguindo}`;

async function contar(campo, username) {
  try {
    const q = query(collection(db, "seguidores"), where(campo, "==", username));
    const snap = await getCountFromServer(q);
    return snap.data().count;
  } catch (err) {
    console.error("Erro ao contar seguidores:", err);
    return 0;
  }
}

async function estaSeguindo(seguidor, seguindo) {
  try {
    const snap = await getDoc(doc(db, "seguidores", idAresta(seguidor, seguindo)));
    return snap.exists();
  } catch (_) {
    return false;
  }
}

// ==========================================================================
// PÁGINA
// ==========================================================================

const params = new URLSearchParams(window.location.search);

let sessaoAtual = null;
let usuarioAlvo = null;
let ehMeuPerfil = false;
let pararDeEscutar = null;

const el = (id) => document.getElementById(id);

// Os IDs abaixo são os que existem em perfil.html. A versão anterior tentava
// cada elemento em duas grafias (`el("myBio") || el("bioPerfil")`), resquício
// de uma marcação antiga que não está mais no projeto.
function elementos() {
  return {
    username: el("headerUsername"),
    nome: el("myDisplayName"),
    bio: el("myBio"),
    foto: el("myProfilePic"),
    seguidores: el("myFollowersCount"),
    seguindo: el("myFollowingCount"),
    botoesMeu: el("botoesMeuPerfil"),
    botoesOutro: el("botoesOutroPerfil"),
    btnVoltar: el("btnVoltar"),
    btnMenu: el("btnAbrirMenu"),
    btnSeguir: el("btnSeguirPerfil"),
    btnMensagem: el("btnMensagemPerfil"),
  };
}

function ajustarLayout(e) {
  if (ehMeuPerfil) {
    if (e.botoesMeu) e.botoesMeu.style.display = "flex";
    if (e.botoesOutro) e.botoesOutro.style.display = "none";
    return;
  }
  if (e.botoesMeu) e.botoesMeu.style.display = "none";
  if (e.botoesOutro) e.botoesOutro.style.display = "flex";
  if (e.btnVoltar) e.btnVoltar.style.display = "block";
  if (e.btnMenu) e.btnMenu.style.display = "none";
}

async function atualizarContadores(e) {
  const [seguidores, seguindo] = await Promise.all([
    contar("seguindo", usuarioAlvo),
    contar("seguidor", usuarioAlvo),
  ]);
  if (e.seguidores) e.seguidores.textContent = String(seguidores);
  if (e.seguindo) e.seguindo.textContent = String(seguindo);
}

function pintarBotaoSeguir(btn, seguindo) {
  btn.textContent = seguindo ? "Seguindo" : "Seguir";
  btn.dataset.seguindo = seguindo ? "sim" : "nao";
  btn.classList.toggle("btn-seguindo", seguindo);
}

async function configurarBotaoSeguir(e) {
  if (!e.btnSeguir || ehMeuPerfil) return;

  pintarBotaoSeguir(e.btnSeguir, await estaSeguindo(sessaoAtual.username, usuarioAlvo));

  e.btnSeguir.addEventListener("click", async () => {
    const seguindoAgora = e.btnSeguir.dataset.seguindo === "sim";
    e.btnSeguir.disabled = true;

    // Pinta antes de confirmar: se der erro, volta atrás.
    pintarBotaoSeguir(e.btnSeguir, !seguindoAgora);

    const ref = doc(db, "seguidores", idAresta(sessaoAtual.username, usuarioAlvo));

    try {
      if (seguindoAgora) {
        await deleteDoc(ref);
      } else {
        await setDoc(ref, {
          seguidor: sessaoAtual.username,
          seguidorUid: sessaoAtual.user.uid,
          seguindo: usuarioAlvo,
          criadoEm: serverTimestamp(),
        });
      }
      await atualizarContadores(e);
    } catch (err) {
      console.error("Erro ao atualizar seguidores:", err);
      pintarBotaoSeguir(e.btnSeguir, seguindoAgora);
      Core.aviso("Não foi possível concluir a ação.", "#ed4956");
    } finally {
      e.btnSeguir.disabled = false;
    }
  });
}

// ==========================================================================
// MODAL DE SEGUIDORES / SEGUINDO
// ==========================================================================
// Estava embutido no perfil.html; veio para cá para a página ficar sem
// script inline.

let sessaoModal = 0;

async function abrirListaDeUsuarios(titulo, tipo) {
  const modal = el("modalListaUsuarios");
  const tituloEl = el("modalListaTitulo");
  const conteudo = el("modalListaConteudo");
  if (!modal || !conteudo) return;

  const estaSessao = Date.now();
  sessaoModal = estaSessao;

  tituloEl.textContent = titulo;
  conteudo.replaceChildren(mensagemDoModal("Carregando..."));
  modal.style.display = "flex";
  requestAnimationFrame(() => { modal.style.opacity = "1"; });

  // tipo "seguidores": quem segue o alvo. tipo "seguindo": quem o alvo segue.
  const campoConsulta = tipo === "seguidores" ? "seguindo" : "seguidor";
  const campoNome = tipo === "seguidores" ? "seguidor" : "seguindo";

  let usernames = [];
  try {
    const snap = await getDocs(
      query(collection(db, "seguidores"), where(campoConsulta, "==", usuarioAlvo), limit(500))
    );
    usernames = snap.docs.map((d) => d.data()[campoNome]).filter(Boolean);
  } catch (err) {
    console.error("Erro ao carregar a lista:", err);
    if (sessaoModal === estaSessao) {
      conteudo.replaceChildren(mensagemDoModal("Erro ao carregar a lista.", true));
    }
    return;
  }

  if (sessaoModal !== estaSessao) return;

  if (!usernames.length) {
    conteudo.replaceChildren(mensagemDoModal("Ninguém por aqui ainda."));
    return;
  }

  conteudo.replaceChildren();

  // Desenha em lotes de 20 para não travar aparelhos mais simples.
  for (let i = 0; i < usernames.length; i += 20) {
    if (sessaoModal !== estaSessao) return;

    const lote = usernames.slice(i, i + 20);
    let perfis = [];
    try {
      const snap = await getDocs(
        query(collection(db, "usuarios"), where(documentId(), "in", lote))
      );
      perfis = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.warn("Erro no lote:", err);
      perfis = lote.map((u) => ({ id: u, usuario: u, nome: u }));
    }

    if (sessaoModal !== estaSessao) return;

    const fragmento = document.createDocumentFragment();
    perfis.forEach((p) => fragmento.appendChild(linhaDeUsuario(p)));
    conteudo.appendChild(fragmento);

    await new Promise((r) => setTimeout(r, 30));
  }
}

function mensagemDoModal(texto, erro = false) {
  const span = document.createElement("span");
  span.className = erro ? "modal-msg modal-msg-erro" : "modal-msg";
  span.textContent = texto;
  return span;
}

function linhaDeUsuario(perfil) {
  const username = perfil.usuario || perfil.id;

  const link = document.createElement("a");
  link.className = "lista-usuario-item";
  link.href = `perfil.html?u=${encodeURIComponent(username)}`;

  const img = document.createElement("img");
  img.alt = "";
  definirAvatar(img, perfil.foto);

  const info = document.createElement("div");
  info.className = "lista-usuario-info";

  const forte = document.createElement("strong");
  forte.textContent = username;

  const span = document.createElement("span");
  span.textContent = perfil.nome || "";

  info.append(forte, span);
  link.append(img, info);
  return link;
}

function fecharModalLista() {
  sessaoModal = 0;
  const modal = el("modalListaUsuarios");
  if (!modal) return;
  modal.style.opacity = "0";
  setTimeout(() => { modal.style.display = "none"; }, 200);
}

// ==========================================================================
// MENU DE OPÇÕES
// ==========================================================================

function abrirMenuOpcoes() {
  const overlay = el("overlayHamburguer");
  const menu = el("menuHamburguer");
  if (overlay) overlay.style.display = "block";
  requestAnimationFrame(() => {
    if (overlay) overlay.style.opacity = "1";
    if (menu) menu.style.bottom = "0";
  });
}

function fecharMenuOpcoes() {
  const overlay = el("overlayHamburguer");
  const menu = el("menuHamburguer");
  if (overlay) overlay.style.opacity = "0";
  if (menu) menu.style.bottom = "-100%";
  setTimeout(() => { if (overlay) overlay.style.display = "none"; }, 300);
}

async function copiarLinkPerfil() {
  const link = `${window.location.origin}/perfil.html?u=${encodeURIComponent(usuarioAlvo)}`;
  try {
    await navigator.clipboard.writeText(link);
    Core.aviso("Link copiado!", "#00a884");
  } catch (_) {
    Core.aviso("Não foi possível copiar o link.", "#ed4956");
  }
}

// ==========================================================================
// INICIALIZAÇÃO
// ==========================================================================

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  const daURL = params.get("u");
  usuarioAlvo = (daURL || sessaoAtual.username).toLowerCase().trim();
  ehMeuPerfil = usuarioAlvo === sessaoAtual.username;

  const e = elementos();
  ajustarLayout(e);
  if (e.username) e.username.textContent = usuarioAlvo;

  const perfil = await buscarPerfilPorUsername(usuarioAlvo);
  if (!perfil) {
    Core.aviso(`O perfil de @${usuarioAlvo} não foi encontrado.`, "#ed4956");
    setTimeout(() => window.location.replace("inbox.html"), 1800);
    return;
  }

  // Mantém o perfil em tempo real (nome, bio e foto).
  pararDeEscutar = onSnapshot(doc(db, "usuarios", perfil.id), (snap) => {
    if (!snap.exists()) return;
    const dados = snap.data();
    if (e.username) e.username.textContent = dados.usuario || usuarioAlvo;
    if (e.nome) e.nome.textContent = dados.nome || usuarioAlvo;
    if (e.bio) e.bio.textContent = dados.bio || "Sem bio definida.";
    if (dados.foto) definirAvatar(e.foto, dados.foto);
  });

  await atualizarContadores(e);
  await configurarBotaoSeguir(e);

  if (e.btnMensagem) {
    e.btnMensagem.addEventListener("click", () => {
      window.location.href = `chat.html?u=${encodeURIComponent(usuarioAlvo)}`;
    });
  }

  // Ligação dos controles da página (nenhum onclick no HTML).
  el("btnAbrirSeguidores")?.addEventListener("click", () => abrirListaDeUsuarios("Seguidores", "seguidores"));
  el("btnAbrirSeguindo")?.addEventListener("click", () => abrirListaDeUsuarios("Seguindo", "seguindo"));
  el("btnFecharModalLista")?.addEventListener("click", fecharModalLista);
  el("modalListaUsuarios")?.addEventListener("click", (ev) => {
    if (ev.target === el("modalListaUsuarios")) fecharModalLista();
  });

  el("btnAbrirMenu")?.addEventListener("click", abrirMenuOpcoes);
  el("overlayHamburguer")?.addEventListener("click", fecharMenuOpcoes);
  el("btnCopiarLink")?.addEventListener("click", () => { copiarLinkPerfil(); fecharMenuOpcoes(); });
  el("btnBloquear")?.addEventListener("click", () => {
    Core.aviso("Bloqueio ainda não implementado.", "#e0a800");
    fecharMenuOpcoes();
  });
  el("btnDenunciar")?.addEventListener("click", () => {
    Core.aviso("Denúncia ainda não implementada.", "#e0a800");
    fecharMenuOpcoes();
  });

  el("btnCompartilharPerfil")?.addEventListener("click", copiarLinkPerfil);
  el("btnPosts")?.addEventListener("click", () => Core.aviso("Posts em breve!"));

  el("btnVoltar")?.addEventListener("click", () => {
    if (document.referrer && !document.referrer.includes("perfil.html")) window.history.back();
    else window.location.href = "inbox.html";
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { fecharModalLista(); fecharMenuOpcoes(); }
  });
}

window.addEventListener("pagehide", () => {
  if (pararDeEscutar) pararDeEscutar();
});

iniciar();
