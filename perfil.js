import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, deleteDoc, collection, query, where,
  getDocs, getCountFromServer, serverTimestamp, limit, documentId
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, {
  sessao, definirAvatar, montarAvatarNav, buscarPerfilPorUsername, AVATAR_PADRAO
} from "./core.js";

// ==========================================================================
// MODELO DE SEGUIDORES
// ==========================================================================

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
// PÁGINA (ESTADO E LAYOUT)
// ==========================================================================

const params = new URLSearchParams(window.location.search);
let sessaoAtual = null;
let usuarioAlvo = null;
let ehMeuPerfil = false;

const el = (id) => document.getElementById(id);

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
    if (e.btnVoltar) e.btnVoltar.style.display = "none"; // Oculta seta de voltar se for o próprio perfil abrindo pela Nav
    if (e.btnMenu) e.btnMenu.style.display = "block";
  } else {
    if (e.botoesMeu) e.botoesMeu.style.display = "none";
    if (e.botoesOutro) e.botoesOutro.style.display = "flex";
    if (e.btnVoltar) e.btnVoltar.style.display = "block";
    if (e.btnMenu) e.btnMenu.style.display = "none";
  }
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
  // Modifica aspecto visual (Você pode adicionar classes específicas no CSS para 'btn-seguindo')
  btn.style.background = seguindo ? "var(--bg-panel-2)" : "var(--primary-accent)";
  btn.style.color = seguindo ? "var(--text-main)" : "white";
  btn.style.border = seguindo ? "1px solid var(--border-color)" : "none";
}

async function configurarBotaoSeguir(e) {
  if (!e.btnSeguir || ehMeuPerfil) return;
  
  pintarBotaoSeguir(e.btnSeguir, await estaSeguindo(sessaoAtual.username, usuarioAlvo));

  e.btnSeguir.addEventListener("click", async () => {
    const seguindoAgora = e.btnSeguir.dataset.seguindo === "sim";
    e.btnSeguir.disabled = true;
    
    // UI Otimista: Pinta antes de confirmar a rede
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
      // Reverte em caso de falha
      pintarBotaoSeguir(e.btnSeguir, seguindoAgora);
      Core.aviso("Não foi possível concluir a ação.", "#ed4956");
    } finally {
      e.btnSeguir.disabled = false;
    }
  });
}

// ==========================================================================
// MODAL DE SEGUIDORES / SEGUINDO (ARQUITETURA INSTAGRAM TABS)
// ==========================================================================

let sessaoModal = 0;
let tabAtual = "seguidores"; 

const modalLista = el("modalListaUsuarios");
const conteudoLista = el("modalListaConteudo");
const tituloModal = el("modalListaTitulo");
const tabSeguidores = el("tabSeguidores");
const tabSeguindo = el("tabSeguindo");

function mensagemDoModal(texto, erro = false) {
  const span = document.createElement("span");
  span.className = erro ? "modal-msg modal-msg-erro" : "modal-msg";
  span.style.textAlign = "center";
  span.style.marginTop = "30px";
  span.style.color = erro ? "var(--primary-accent)" : "var(--text-sec)";
  span.style.fontSize = "14px";
  span.textContent = texto;
  return span;
}

function alternarTab(tipo) {
  tabAtual = tipo;
  
  // Atualiza UI das Guias (Tabs) simulando transição nativa
  const ativo = "var(--text-main)";
  const inativo = "var(--text-sec)";
  
  tabSeguidores.style.color = tipo === "seguidores" ? ativo : inativo;
  tabSeguidores.style.borderBottomColor = tipo === "seguidores" ? "var(--primary-accent)" : "transparent";
  
  tabSeguindo.style.color = tipo === "seguindo" ? ativo : inativo;
  tabSeguindo.style.borderBottomColor = tipo === "seguindo" ? "var(--primary-accent)" : "transparent";

  carregarListaDeUsuarios(tipo);
}

async function carregarListaDeUsuarios(tipo) {
  if (!modalLista || !conteudoLista) return;

  const estaSessao = Date.now();
  sessaoModal = estaSessao; // Trava contra Race Conditions
  
  conteudoLista.replaceChildren(mensagemDoModal("Carregando..."));

  // Lógica relacional: "seguidores" (quem segue o alvo), "seguindo" (quem o alvo segue).
  const campoConsulta = tipo === "seguidores" ? "seguindo" : "seguidor";
  const campoNome = tipo === "seguidores" ? "seguidor" : "seguindo";

  let usernames = [];
  try {
    const snap = await getDocs(
      query(collection(db, "seguidores"), where(campoConsulta, "==", usuarioAlvo), limit(500))
    );
    usernames = snap.docs.map((d) => d.data()[campoNome]).filter(Boolean);
  } catch (err) {
    console.error("Erro ao consultar grafo de relações:", err);
    if (sessaoModal === estaSessao) {
      conteudoLista.replaceChildren(mensagemDoModal("Erro de conexão.", true));
    }
    return;
  }

  if (sessaoModal !== estaSessao) return; // Aborta se a aba foi trocada durante a requisição

  if (!usernames.length) {
    conteudoLista.replaceChildren(mensagemDoModal("Nenhum usuário encontrado."));
    return;
  }

  conteudoLista.replaceChildren();

  // Virtualização rudimentar (Paginação visual por lotes)
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
      perfis = lote.map((u) => ({ id: u, usuario: u, nome: u }));
    }

    if (sessaoModal !== estaSessao) return;

    const fragmento = document.createDocumentFragment();
    perfis.forEach((p) => {
      const username = p.usuario || p.id;
      
      const link = document.createElement("a");
      link.className = "lista-usuario-item";
      link.href = `perfil.html?u=${encodeURIComponent(username)}`;
      link.style.cssText = "display: flex; align-items: center; gap: 12px; padding: 10px; text-decoration: none; color: var(--text-main); border-radius: 12px; transition: background 0.2s;";
      
      const img = document.createElement("img");
      img.alt = "";
      definirAvatar(img, p.foto);
      img.style.cssText = "width: 44px; height: 44px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-color); flex-shrink: 0;";
      
      const info = document.createElement("div");
      info.style.cssText = "display: flex; flex-direction: column; overflow: hidden;";
      
      const forte = document.createElement("strong");
      forte.textContent = username;
      forte.style.cssText = "font-size: 14px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden;";
      
      const span = document.createElement("span");
      span.textContent = p.nome || "";
      span.style.cssText = "font-size: 12px; color: var(--text-sec); white-space: nowrap; text-overflow: ellipsis; overflow: hidden;";
      
      info.append(forte, span);
      link.append(img, info);
      fragmento.appendChild(link);
    });
    
    conteudoLista.appendChild(fragmento);
    await new Promise((r) => setTimeout(r, 20)); // Cede a main thread para não dropar FPS
  }
}

function abrirModal(tipo) {
  if (!usuarioAlvo) return;
  tituloModal.textContent = usuarioAlvo; // Nome no topo do modal
  modalLista.style.display = "flex";
  requestAnimationFrame(() => { modalLista.style.opacity = "1"; });
  alternarTab(tipo);
}

function fecharModal() {
  modalLista.style.opacity = "0";
  setTimeout(() => { modalLista.style.display = "none"; }, 200);
  sessaoModal = 0; // Desativa renderizações pendentes
}

// ==========================================================================
// INICIALIZAÇÃO CRÍTICA (BOOTSTRAP DE EVENTOS)
// ==========================================================================

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  // Verifica URL param para definir se é o perfil alheio ou o próprio
  usuarioAlvo = params.get("u") ? String(params.get("u")).toLowerCase().trim() : sessaoAtual.username;
  ehMeuPerfil = usuarioAlvo === sessaoAtual.username;
  
  const ui = elementos();
  ajustarLayout(ui);

  try {
    const perfil = await buscarPerfilPorUsername(usuarioAlvo);
    if (!perfil) {
      Core.aviso("Usuário não encontrado.", "#ed4956");
      if (ui.nome) ui.nome.textContent = "Usuário não encontrado";
      return;
    }

    if (ui.username) ui.username.textContent = usuarioAlvo;
    if (ui.nome) ui.nome.textContent = perfil.nome || usuarioAlvo;
    if (ui.bio) ui.bio.textContent = perfil.bio || "";
    if (ui.foto) definirAvatar(ui.foto, perfil.foto);

    atualizarContadores(ui);
    configurarBotaoSeguir(ui);

    if (ui.btnMensagem) {
      ui.btnMensagem.addEventListener("click", () => {
        window.location.href = `chat.html?u=${encodeURIComponent(usuarioAlvo)}`;
      });
    }

    // Acoplamento de Eventos da Interface de Abas
    el("btnAbrirSeguidores")?.addEventListener("click", () => abrirModal("seguidores"));
    el("btnAbrirSeguindo")?.addEventListener("click", () => abrirModal("seguindo"));
    el("btnFecharModalLista")?.addEventListener("click", fecharModal);
    
    tabSeguidores?.addEventListener("click", () => alternarTab("seguidores"));
    tabSeguindo?.addEventListener("click", () => alternarTab("seguindo"));

    ui.btnVoltar?.addEventListener("click", () => {
      if (document.referrer && !document.referrer.includes("editar-perfil.html")) window.history.back();
      else window.location.href = "inbox.html";
    });

  } catch (err) {
    console.error("Falha ao montar o perfil:", err);
    Core.aviso("Erro ao carregar os dados.", "#ed4956");
  }
}

iniciar();