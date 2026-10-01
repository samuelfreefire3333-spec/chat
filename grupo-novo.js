import { db } from "./firebase.js";
import {
  collection, query, orderBy, startAt, endAt, limit, getDocs, where, documentId
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { sessao, definirAvatar, montarAvatarNav } from "./core.js";
import { criarGrupo, MINIMO_MEMBROS_GRUPO, MAXIMO_MEMBROS_GRUPO } from "./mensagens.js";

const elNome = document.getElementById("inputNomeGrupo");
const elContadorNome = document.getElementById("contadorNomeGrupo");
const elBusca = document.getElementById("inputBuscaGrupo");
const elResultados = document.getElementById("resultadosGrupo");
const elSelecionados = document.getElementById("membrosSelecionados");
const elContagem = document.getElementById("contagemMembros");
const btnCriar = document.getElementById("btnCriarGrupo");

const MAX_ESCOLHIDOS = MAXIMO_MEMBROS_GRUPO - 1; // eu já conto
const MIN_ESCOLHIDOS = MINIMO_MEMBROS_GRUPO - 1;

let sessaoAtual = null;
let temporizador = null;
let buscaEmCurso = 0;
let sugestoes = [];
let criando = false;
const selecionados = new Map(); // username -> { nome, foto }

const ICONE_FECHAR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

function atualizarBotao() {
  const n = selecionados.size;
  const membrosOk = n >= MIN_ESCOLHIDOS && n <= MAX_ESCOLHIDOS;
  if (!criando) btnCriar.disabled = !(elNome.value.trim() && membrosOk);
  btnCriar.textContent = criando ? "Criando..." : (n ? `Criar grupo (${n + 1} pessoas)` : "Criar grupo");
  if (elContagem) elContagem.textContent = `${n} de ${MAX_ESCOLHIDOS}`;
  if (elContadorNome) elContadorNome.textContent = `${elNome.value.length}/60`;
}

function alternar(dados) {
  if (selecionados.has(dados.usuario)) {
    selecionados.delete(dados.usuario);
  } else {
    if (selecionados.size >= MAX_ESCOLHIDOS) {
      Core.aviso(`Grupos podem ter no máximo ${MAXIMO_MEMBROS_GRUPO} pessoas.`, "alerta");
      return false;
    }
    selecionados.set(dados.usuario, { nome: dados.nome, foto: dados.foto });
  }
  renderizarSelecionados();
  atualizarMarcacaoDosResultados();
  atualizarBotao();
  return true;
}

function renderizarSelecionados() {
  elSelecionados.replaceChildren();

  selecionados.forEach((dados, username) => {
    const chip = document.createElement("div");
    chip.className = "membro-chip";

    const img = document.createElement("img");
    img.alt = "";
    definirAvatar(img, dados.foto);

    const span = document.createElement("span");
    span.textContent = dados.nome || username;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Remover ${dados.nome || username} do grupo`);
    btn.innerHTML = ICONE_FECHAR;
    btn.addEventListener("click", () => {
      selecionados.delete(username);
      renderizarSelecionados();
      atualizarMarcacaoDosResultados();
      atualizarBotao();
      elBusca.focus({ preventScroll: true });
    });

    chip.append(img, span, btn);
    elSelecionados.appendChild(chip);
  });
}

function atualizarMarcacaoDosResultados() {
  elResultados.querySelectorAll(".resultado-item[data-usuario]").forEach((item) => {
    const marcado = selecionados.has(item.dataset.usuario);
    item.classList.toggle("selecionado", marcado);
    item.setAttribute("aria-checked", marcado ? "true" : "false");
  });
}

function linhaDeResultado(dados) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "resultado-item";
  item.setAttribute("role", "checkbox");
  item.dataset.usuario = dados.usuario;
  const marcado = selecionados.has(dados.usuario);
  item.classList.toggle("selecionado", marcado);
  item.setAttribute("aria-checked", marcado ? "true" : "false");

  const check = document.createElement("span");
  check.className = "resultado-check";
  check.setAttribute("aria-hidden", "true");

  const img = document.createElement("img");
  img.alt = "";
  definirAvatar(img, dados.foto);

  const info = document.createElement("span");
  info.className = "resultado-info";
  const nome = document.createElement("strong");
  nome.textContent = dados.nome || dados.usuario;
  const arroba = document.createElement("span");
  arroba.textContent = `@${dados.usuario}`;
  info.append(nome, arroba);

  item.append(check, img, info);
  item.addEventListener("click", () => alternar(dados));
  return item;
}

function mensagemAjuda(texto) {
  const span = document.createElement("span");
  span.className = "helper-text";
  span.textContent = texto;
  return span;
}

function esqueleto(quantos = 4) {
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

function renderizarResultados(lista, { titulo = "" } = {}) {
  elResultados.replaceChildren();

  if (!lista.length) {
    elResultados.appendChild(mensagemAjuda("Nenhum usuário encontrado."));
    return;
  }

  const fragmento = document.createDocumentFragment();
  if (titulo) {
    const h = document.createElement("h3");
    h.className = "grupo-lista-titulo";
    h.textContent = titulo;
    fragmento.appendChild(h);
  }
  lista.forEach((dados) => fragmento.appendChild(linhaDeResultado(dados)));
  elResultados.appendChild(fragmento);
}

function mostrarSugestoes() {
  if (sugestoes.length) renderizarResultados(sugestoes, { titulo: "Pessoas que você segue" });
  else elResultados.replaceChildren(mensagemAjuda("Digite para encontrar pessoas para o grupo."));
}

function consultaDePrefixo(campo, prefixo) {
  return getDocs(
    query(collection(db, "usuarios"), orderBy(campo), startAt(prefixo), endAt(`${prefixo}`), limit(20))
  ).catch(() => null);
}

async function buscar(termo) {
  const estaBusca = ++buscaEmCurso;
  try {
    // Nome de usuário e nome de exibição (digitado e com inicial maiúscula),
    // como na tela Pesquisar.
    const capitalizado = termo.charAt(0).toUpperCase() + termo.slice(1);
    const variantes = capitalizado === termo ? [termo] : [termo, capitalizado];
    const respostas = await Promise.all([
      consultaDePrefixo("usuario", termo),
      ...variantes.map((v) => consultaDePrefixo("nome", v)),
    ]);
    if (estaBusca !== buscaEmCurso) return;

    if (respostas.every((r) => r === null)) {
      elResultados.replaceChildren(mensagemAjuda("Erro ao buscar. Tente de novo."));
      return;
    }

    const porUsuario = new Map();
    respostas.forEach((snap) => snap?.docs.forEach((d) => {
      const u = d.data();
      if (u.usuario && u.usuario !== sessaoAtual.username) porUsuario.set(u.usuario, u);
    }));

    const encontrados = [...porUsuario.values()]
      .sort((a, b) => String(a.nome || a.usuario).localeCompare(String(b.nome || b.usuario), "pt-BR"))
      .slice(0, 20);
    renderizarResultados(encontrados);
  } catch (erro) {
    console.error("Erro na busca:", erro);
    if (estaBusca !== buscaEmCurso) return;
    elResultados.replaceChildren(mensagemAjuda("Erro ao buscar. Tente de novo."));
  }
}

function aoDigitarBusca() {
  clearTimeout(temporizador);
  const termo = elBusca.value.toLowerCase().trim().replace(/^@/, "");

  if (!termo) {
    buscaEmCurso++;
    mostrarSugestoes();
    return;
  }

  elResultados.replaceChildren(esqueleto());
  temporizador = setTimeout(() => buscar(termo), 350);
}

// Sugestões: quem você segue (até 30), para montar o grupo sem digitar.
async function carregarSugestoes() {
  try {
    const arestas = await getDocs(
      query(collection(db, "seguidores"), where("seguidor", "==", sessaoAtual.username), limit(30))
    );
    const nomes = [...new Set(arestas.docs.map((d) => d.data().seguindo).filter(Boolean))];
    const perfis = [];
    for (let i = 0; i < nomes.length; i += 10) {
      const lote = nomes.slice(i, i + 10);
      const snap = await getDocs(query(collection(db, "usuarios"), where(documentId(), "in", lote), limit(10)));
      snap.docs.forEach((d) => {
        const u = d.data();
        if (u.usuario && u.usuario !== sessaoAtual.username) perfis.push(u);
      });
    }
    sugestoes = perfis.sort((a, b) => String(a.nome || a.usuario).localeCompare(String(b.nome || b.usuario), "pt-BR"));
  } catch (erro) {
    console.warn("Sem sugestões para o grupo:", erro);
    sugestoes = [];
  }
  if (!elBusca.value.trim()) mostrarSugestoes();
}

async function criar() {
  if (criando) return;
  const nome = elNome.value.trim();
  const membros = [...selecionados.keys()];

  criando = true;
  btnCriar.disabled = true;
  atualizarBotao();

  try {
    const { chatId } = await criarGrupo(sessaoAtual, nome, membros);
    window.location.href = `chat.html?g=${encodeURIComponent(chatId)}`;
  } catch (erro) {
    console.error("Erro ao criar grupo:", erro);
    Core.aviso(erro.message || "Não foi possível criar o grupo.", "erro");
    criando = false;
    atualizarBotao();
  }
}

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  elNome.addEventListener("input", atualizarBotao);
  elBusca.addEventListener("input", aoDigitarBusca);
  elBusca.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Enter com um único resultado: adiciona a pessoa direto.
    const itens = elResultados.querySelectorAll(".resultado-item");
    if (itens.length === 1) itens[0].click();
  });
  elNome.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); elBusca.focus(); }
  });
  btnCriar.addEventListener("click", criar);
  atualizarBotao();
  carregarSugestoes();

  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
    if (document.referrer && window.history.length > 1) window.history.back();
    else window.location.href = "inbox.html";
  });
}

iniciar();
