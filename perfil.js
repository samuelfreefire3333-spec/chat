import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, deleteDoc, collection, query, where,
  getDocs, getCountFromServer, serverTimestamp, limit, documentId
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, {
  sessao, definirAvatar, montarAvatarNav, buscarPerfilPorUsername,
  mostrar, paraMillis, copiarTexto, compartilharLink
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
    return null;
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
let perfilAlvo = null;
let ehMeuPerfil = false;
let meSegue = false;

const el = (id) => document.getElementById(id);

function elementos() {
  return {
    username: el("headerUsername"),
    nome: el("myDisplayName"),
    bio: el("myBio"),
    foto: el("myProfilePic"),
    seguidores: el("myFollowersCount"),
    rotuloSeguidores: el("rotuloSeguidores"),
    seguindo: el("myFollowingCount"),
    botoesMeu: el("botoesMeuPerfil"),
    botoesOutro: el("botoesOutroPerfil"),
    btnVoltar: el("btnVoltar"),
    btnMenu: el("btnAbrirMenu"),
    btnSeguir: el("btnSeguirPerfil"),
    btnMensagem: el("btnMensagemPerfil"),
    btnCompartilhar: el("btnCompartilharPerfil"),
    seloSegueVoce: el("seloSegueVoce"),
    desde: el("perfilDesde"),
    desdeTexto: el("perfilDesdeTexto"),
    conteudo: el("conteudoPerfil"),
    estado: el("perfilEstado"),
  };
}

function ajustarLayout(e) {
  mostrar(e.botoesMeu, ehMeuPerfil);
  mostrar(e.botoesOutro, !ehMeuPerfil);
  // Pela barra de navegação o próprio perfil é uma tela raiz: sem "voltar".
  mostrar(e.btnVoltar, !ehMeuPerfil);
  mostrar(el("btnMenuConfiguracoes"), ehMeuPerfil);
}

// 1.234 por extenso; de 10 mil para cima, "12,5 mil" (como no Instagram).
const formatoCompacto = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
function formatarContagem(n) {
  if (!Number.isFinite(n)) return "–";
  return n < 10000 ? n.toLocaleString("pt-BR") : formatoCompacto.format(n);
}

async function atualizarContadores(e) {
  const [seguidores, seguindo] = await Promise.all([
    contar("seguindo", usuarioAlvo),
    contar("seguidor", usuarioAlvo),
  ]);
  if (e.seguidores) e.seguidores.textContent = formatarContagem(seguidores);
  if (e.seguindo) e.seguindo.textContent = formatarContagem(seguindo);
  if (e.rotuloSeguidores) e.rotuloSeguidores.textContent = seguidores === 1 ? "seguidor" : "seguidores";
  el("btnAbrirSeguidores")?.setAttribute("aria-label", `${formatarContagem(seguidores)} ${seguidores === 1 ? "seguidor" : "seguidores"}: ver lista`);
  el("btnAbrirSeguindo")?.setAttribute("aria-label", `Seguindo ${formatarContagem(seguindo)}: ver lista`);
}

function pintarBotaoSeguir(btn, seguindo) {
  btn.dataset.seguindo = seguindo ? "sim" : "nao";
  btn.setAttribute("aria-pressed", seguindo ? "true" : "false");
  btn.textContent = seguindo ? "Seguindo" : (meSegue ? "Seguir de volta" : "Seguir");
}

async function configurarBotaoSeguir(e) {
  if (!e.btnSeguir || ehMeuPerfil) return;

  const [euSigo, eleMeSegue] = await Promise.all([
    estaSeguindo(sessaoAtual.username, usuarioAlvo),
    estaSeguindo(usuarioAlvo, sessaoAtual.username),
  ]);
  meSegue = eleMeSegue;
  mostrar(e.seloSegueVoce, meSegue);
  pintarBotaoSeguir(e.btnSeguir, euSigo);

  e.btnSeguir.addEventListener("click", async () => {
    const seguindoAgora = e.btnSeguir.dataset.seguindo === "sim";
    e.btnSeguir.disabled = true;

    // UI otimista: pinta antes de a rede confirmar.
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
      Core.aviso("Não foi possível concluir a ação.", "erro");
    } finally {
      e.btnSeguir.disabled = false;
    }
  });
}

const formatoMesAno = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
function mostrarDesde(e, perfil) {
  const ms = paraMillis(perfil.dataCriacao);
  if (!ms || !e.desde || !e.desdeTexto) return;
  e.desdeTexto.textContent = `No Sinex desde ${formatoMesAno.format(new Date(ms))}`;
  mostrar(e.desde, true);
}

function mostrarEstado(e, { titulo, texto, erro = false }) {
  mostrar(e.conteudo, false);
  if (!e.estado) return;

  const caixa = document.createElement("div");
  caixa.className = erro ? "estado-vazio estado-erro" : "estado-vazio";

  const icone = document.createElement("div");
  icone.className = "estado-vazio-icone";
  icone.innerHTML = erro
    ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
    : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle><line x1="3" y1="3" x2="21" y2="21"></line></svg>';

  const forte = document.createElement("strong");
  forte.textContent = titulo;
  const span = document.createElement("span");
  span.textContent = texto;

  const acao = document.createElement(erro ? "button" : "a");
  acao.className = "btn-primario btn-pequeno";
  if (erro) {
    acao.type = "button";
    acao.textContent = "Tentar de novo";
    acao.addEventListener("click", () => window.location.reload());
  } else {
    acao.href = "explorar.html";
    acao.textContent = "Pesquisar pessoas";
  }

  caixa.append(icone, forte, span, acao);
  e.estado.replaceChildren(caixa);
  mostrar(e.estado, true);
}

// ==========================================================================
// COMPARTILHAR E MENU "MAIS OPÇÕES"
// ==========================================================================

const linkDoPerfil = () => `${window.location.origin}/perfil.html?u=${encodeURIComponent(usuarioAlvo)}`;

function compartilharPerfil() {
  const nome = perfilAlvo?.nome || usuarioAlvo;
  return compartilharLink({
    titulo: `${nome} no Sinex Chat`,
    texto: ehMeuPerfil ? "Fale comigo no Sinex Chat" : `Veja o perfil de @${usuarioAlvo} no Sinex Chat`,
    url: linkDoPerfil(),
  });
}

async function copiarLinkDoPerfil() {
  const ok = await copiarTexto(linkDoPerfil());
  Core.aviso(ok ? "Link do perfil copiado." : "Não foi possível copiar o link.", ok ? "sucesso" : "erro");
}

const menu = el("menuHamburguer");
const fundoDoMenu = el("overlayHamburguer");
const btnMenu = el("btnAbrirMenu");
const telaGrande = window.matchMedia("(min-width: 850px)");

const itensDoMenu = () => [...(menu?.querySelectorAll(".menu-item") || [])]
  .filter((item) => !item.classList.contains("u-hidden") && item.offsetParent !== null);

function posicionarMenu() {
  if (!menu || !btnMenu) return;
  if (telaGrande.matches) {
    const r = btnMenu.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  } else {
    menu.style.removeProperty("top");
    menu.style.removeProperty("right");
  }
}

function menuAberto() {
  return menu?.classList.contains("aberto");
}

function abrirMenu() {
  if (!menu || menuAberto()) return;
  posicionarMenu();
  menu.classList.add("aberto");
  fundoDoMenu?.classList.add("aberto");
  menu.setAttribute("aria-hidden", "false");
  btnMenu?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => itensDoMenu()[0]?.focus({ preventScroll: true }));
}

function fecharMenu({ devolverFoco = true } = {}) {
  if (!menuAberto()) return;
  menu.classList.remove("aberto");
  fundoDoMenu?.classList.remove("aberto");
  menu.setAttribute("aria-hidden", "true");
  btnMenu?.setAttribute("aria-expanded", "false");
  if (devolverFoco) btnMenu?.focus({ preventScroll: true });
}

btnMenu?.addEventListener("click", () => (menuAberto() ? fecharMenu() : abrirMenu()));
fundoDoMenu?.addEventListener("click", () => fecharMenu());
menu?.querySelector("[data-fechar-menu]")?.addEventListener("click", () => fecharMenu());
el("btnCopiarLink")?.addEventListener("click", () => { fecharMenu(); copiarLinkDoPerfil(); });
el("btnCompartilharMenu")?.addEventListener("click", () => { fecharMenu(); compartilharPerfil(); });
window.addEventListener("resize", () => { if (menuAberto()) posicionarMenu(); });

// Setas percorrem as opções, como num menu do sistema.
menu?.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const itens = itensDoMenu();
  if (!itens.length) return;
  e.preventDefault();
  const atual = itens.indexOf(document.activeElement);
  let proximo = 0;
  if (e.key === "ArrowDown") proximo = (atual + 1) % itens.length;
  else if (e.key === "ArrowUp") proximo = (atual - 1 + itens.length) % itens.length;
  else if (e.key === "End") proximo = itens.length - 1;
  itens[proximo].focus();
});
menu?.addEventListener("focusout", (e) => {
  // Tab para fora do menu fecha o menu (sem roubar o foco de volta).
  if (menuAberto() && e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== btnMenu) {
    fecharMenu({ devolverFoco: false });
  }
});

// ==========================================================================
// MODAL DE SEGUIDORES / SEGUINDO (COM ABAS)
// ==========================================================================

// Contador simples, e não Date.now(): duas trocas de aba no mesmo
// milissegundo recebiam o mesmo "ticket" e a renderização antiga continuava
// escrevendo por cima da nova.
let sessaoModal = 0;
let tabAtual = "seguidores";
let focoAntesDoModal = null;

const modalLista = el("modalListaUsuarios");
const conteudoLista = el("modalListaConteudo");
const tituloModal = el("modalListaTitulo");
const tabSeguidores = el("tabSeguidores");
const tabSeguindo = el("tabSeguindo");

function mensagemDoModal(texto, erro = false) {
  const span = document.createElement("span");
  span.className = erro ? "modal-msg modal-msg-erro" : "modal-msg";
  span.textContent = texto;
  return span;
}

function esqueletoDaLista(quantos = 6) {
  const fragmento = document.createDocumentFragment();
  for (let i = 0; i < quantos; i++) {
    const item = document.createElement("div");
    item.className = "skeleton-item";
    item.setAttribute("aria-hidden", "true");
    item.innerHTML = '<div class="skeleton skeleton-avatar"></div><div class="skeleton-linhas"><div class="skeleton skeleton-linha curta"></div><div class="skeleton skeleton-linha"></div></div>';
    fragmento.appendChild(item);
  }
  return fragmento;
}

function listaVazia(tipo) {
  const caixa = document.createElement("div");
  caixa.className = "estado-vazio";
  const forte = document.createElement("strong");
  const span = document.createElement("span");

  if (tipo === "seguidores") {
    forte.textContent = ehMeuPerfil ? "Nenhum seguidor ainda" : "Nenhum seguidor";
    span.textContent = ehMeuPerfil
      ? "Quando alguém seguir você, a pessoa aparece aqui."
      : `Quem seguir @${usuarioAlvo} aparece aqui.`;
  } else {
    forte.textContent = ehMeuPerfil ? "Você ainda não segue ninguém" : "Não segue ninguém";
    span.textContent = ehMeuPerfil
      ? "Encontre amigos pelo nome ou @usuário."
      : `Quando @${usuarioAlvo} seguir alguém, a pessoa aparece aqui.`;
  }
  caixa.append(forte, span);

  if (tipo === "seguindo" && ehMeuPerfil) {
    const link = document.createElement("a");
    link.className = "btn-primario btn-pequeno";
    link.href = "explorar.html";
    link.textContent = "Encontrar pessoas";
    caixa.appendChild(link);
  }
  return caixa;
}

function alternarTab(tipo) {
  tabAtual = tipo;
  [[tabSeguidores, "seguidores"], [tabSeguindo, "seguindo"]].forEach(([aba, nome]) => {
    if (!aba) return;
    const ativa = nome === tipo;
    aba.classList.toggle("ativa", ativa);
    aba.setAttribute("aria-selected", ativa ? "true" : "false");
    aba.tabIndex = ativa ? 0 : -1;
  });
  conteudoLista?.setAttribute("aria-labelledby", tipo === "seguidores" ? "tabSeguidores" : "tabSeguindo");
  carregarListaDeUsuarios(tipo);
}

function itemDeUsuario(p) {
  const username = p.usuario || p.id;

  const link = document.createElement("a");
  link.className = "lista-usuario-item";
  link.href = `perfil.html?u=${encodeURIComponent(username)}`;

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  definirAvatar(img, p.foto);

  const info = document.createElement("div");
  info.className = "lista-usuario-info";

  const forte = document.createElement("strong");
  forte.textContent = username;

  const span = document.createElement("span");
  span.textContent = p.nome || "";

  info.append(forte, span);
  link.append(img, info);

  if (username === sessaoAtual?.username) {
    const voce = document.createElement("span");
    voce.className = "selo-segue-voce";
    voce.textContent = "Você";
    link.appendChild(voce);
  }
  return link;
}

async function carregarListaDeUsuarios(tipo) {
  if (!modalLista || !conteudoLista) return;

  const estaSessao = ++sessaoModal; // trava contra respostas fora de ordem
  conteudoLista.setAttribute("aria-busy", "true");
  conteudoLista.replaceChildren(esqueletoDaLista());

  // "seguidores" = quem segue o alvo; "seguindo" = quem o alvo segue.
  const campoConsulta = tipo === "seguidores" ? "seguindo" : "seguidor";
  const campoNome = tipo === "seguidores" ? "seguidor" : "seguindo";

  let usernames = [];
  try {
    const snap = await getDocs(
      query(collection(db, "seguidores"), where(campoConsulta, "==", usuarioAlvo), limit(500))
    );
    usernames = [...new Set(snap.docs.map((d) => d.data()[campoNome]).filter(Boolean))];
  } catch (err) {
    console.error("Erro ao consultar seguidores:", err);
    if (sessaoModal === estaSessao) {
      conteudoLista.replaceChildren(mensagemDoModal("Não foi possível carregar a lista. Verifique a conexão.", true));
      conteudoLista.removeAttribute("aria-busy");
    }
    return;
  }

  if (sessaoModal !== estaSessao) return; // a aba mudou durante a consulta

  if (!usernames.length) {
    conteudoLista.replaceChildren(listaVazia(tipo));
    conteudoLista.removeAttribute("aria-busy");
    return;
  }

  let primeiroLote = true;

  // Em lotes de 20 (limite do "in" com folga), cedendo a vez entre lotes.
  for (let i = 0; i < usernames.length; i += 20) {
    if (sessaoModal !== estaSessao) return;
    const lote = usernames.slice(i, i + 20);
    let perfis = [];

    try {
      const snap = await getDocs(query(collection(db, "usuarios"), where(documentId(), "in", lote)));
      const porId = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
      // Mantém a ordem da consulta e não some com quem não tem perfil.
      perfis = lote.map((u) => porId.get(u) || { id: u, usuario: u, nome: "" });
    } catch (_) {
      perfis = lote.map((u) => ({ id: u, usuario: u, nome: "" }));
    }

    if (sessaoModal !== estaSessao) return;

    if (primeiroLote) {
      conteudoLista.replaceChildren();
      conteudoLista.removeAttribute("aria-busy");
      primeiroLote = false;
    }

    const fragmento = document.createDocumentFragment();
    perfis.forEach((p) => fragmento.appendChild(itemDeUsuario(p)));
    conteudoLista.appendChild(fragmento);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function modalAberto() {
  return modalLista?.classList.contains("aberto");
}

function abrirModal(tipo) {
  if (!usuarioAlvo || !modalLista) return;
  focoAntesDoModal = document.activeElement;
  tituloModal.textContent = usuarioAlvo;
  modalLista.classList.add("aberto");
  modalLista.setAttribute("aria-hidden", "false");
  alternarTab(tipo);
  requestAnimationFrame(() => (tipo === "seguindo" ? tabSeguindo : tabSeguidores)?.focus({ preventScroll: true }));
}

function fecharModal() {
  if (!modalAberto()) return;
  modalLista.classList.remove("aberto");
  modalLista.setAttribute("aria-hidden", "true");
  sessaoModal++; // desativa renderizações pendentes
  try { focoAntesDoModal?.focus?.({ preventScroll: true }); } catch (_) {}
}

// Esc fecha o que estiver aberto; clique no fundo fecha o modal.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (menuAberto()) { e.preventDefault(); fecharMenu(); return; }
    if (modalAberto()) { e.preventDefault(); fecharModal(); }
    return;
  }

  // Tab fica preso dentro do modal enquanto ele está aberto.
  if (e.key === "Tab" && modalAberto()) {
    const focaveis = [...modalLista.querySelectorAll('button:not([disabled]), a[href]')]
      .filter((n) => n.tabIndex !== -1 && n.offsetParent !== null);
    if (!focaveis.length) return;
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
    else if (!modalLista.contains(document.activeElement)) { e.preventDefault(); primeiro.focus(); }
  }
});
modalLista?.addEventListener("click", (e) => {
  if (e.target === modalLista) fecharModal();
});

// Setas trocam de aba (padrão de abas acessíveis).
[tabSeguidores, tabSeguindo].forEach((aba) => {
  aba?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const outra = aba === tabSeguidores ? tabSeguindo : tabSeguidores;
    alternarTab(outra === tabSeguidores ? "seguidores" : "seguindo");
    outra.focus();
  });
});

// ==========================================================================
// INICIALIZAÇÃO
// ==========================================================================

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  // Sem ?u= (ou com o próprio nome) é o perfil de quem está logado.
  usuarioAlvo = params.get("u") ? String(params.get("u")).toLowerCase().trim() : sessaoAtual.username;
  ehMeuPerfil = usuarioAlvo === sessaoAtual.username;

  const ui = elementos();
  ajustarLayout(ui);

  ui.btnVoltar?.addEventListener("click", () => {
    if (document.referrer && !document.referrer.includes("editar-perfil.html") && window.history.length > 1) window.history.back();
    else window.location.href = "inbox.html";
  });

  try {
    const perfil = ehMeuPerfil && sessaoAtual.perfil ? sessaoAtual.perfil : await buscarPerfilPorUsername(usuarioAlvo);
    if (ui.username) ui.username.textContent = usuarioAlvo;

    if (!perfil) {
      document.title = "Conta não encontrada - Sinex Chat";
      mostrar(btnMenu, false);
      mostrarEstado(ui, {
        titulo: "Esta conta não existe",
        texto: `Não encontramos ninguém com o usuário @${usuarioAlvo}. O link pode estar errado ou a conta pode ter mudado de nome.`,
      });
      return;
    }

    perfilAlvo = perfil;
    const nome = perfil.nome || usuarioAlvo;
    document.title = `${nome} (@${usuarioAlvo}) - Sinex Chat`;

    if (ui.nome) ui.nome.textContent = nome;
    if (ui.bio) ui.bio.textContent = perfil.bio || "";
    if (ui.foto) {
      definirAvatar(ui.foto, perfil.foto);
      ui.foto.alt = `Foto de ${nome}`;
    }
    mostrarDesde(ui, perfil);

    atualizarContadores(ui);
    configurarBotaoSeguir(ui);

    ui.btnMensagem?.addEventListener("click", () => {
      window.location.href = `chat.html?u=${encodeURIComponent(usuarioAlvo)}`;
    });
    ui.btnCompartilhar?.addEventListener("click", compartilharPerfil);

    el("btnAbrirSeguidores")?.addEventListener("click", () => abrirModal("seguidores"));
    el("btnAbrirSeguindo")?.addEventListener("click", () => abrirModal("seguindo"));
    el("btnFecharModalLista")?.addEventListener("click", fecharModal);
    tabSeguidores?.addEventListener("click", () => alternarTab("seguidores"));
    tabSeguindo?.addEventListener("click", () => alternarTab("seguindo"));
  } catch (err) {
    console.error("Falha ao montar o perfil:", err);
    mostrarEstado(ui, {
      titulo: "Não foi possível carregar o perfil",
      texto: "Verifique sua conexão e tente de novo.",
      erro: true,
    });
  }
}

iniciar();
