import { db } from "./firebase.js";
import {
  collection, query, orderBy, startAt, endAt, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { sessao, definirAvatar, montarAvatarNav } from "./core.js";
import { criarGrupo, MINIMO_MEMBROS_GRUPO, MAXIMO_MEMBROS_GRUPO } from "./mensagens.js";

const elNome = document.getElementById("inputNomeGrupo");
const elBusca = document.getElementById("inputBuscaGrupo");
const elResultados = document.getElementById("resultadosGrupo");
const elSelecionados = document.getElementById("membrosSelecionados");
const btnCriar = document.getElementById("btnCriarGrupo");

let sessaoAtual = null;
let temporizador = null;
let buscaEmCurso = 0;
const selecionados = new Map(); // username -> { nome, foto }

function atualizarBotao() {
  const membrosOk = selecionados.size >= MINIMO_MEMBROS_GRUPO - 1
    && selecionados.size <= MAXIMO_MEMBROS_GRUPO - 1;
  btnCriar.disabled = !(elNome.value.trim() && membrosOk);
}

function renderizarSelecionados() {
  elSelecionados.replaceChildren();

  selecionados.forEach((dados, username) => {
    const chip = document.createElement("div");
    chip.className = "membro-chip";

    const span = document.createElement("span");
    span.textContent = dados.nome || username;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Remover ${username}`);
    btn.textContent = "×";
    btn.addEventListener("click", () => {
      selecionados.delete(username);
      renderizarSelecionados();
      atualizarMarcacaoDosResultados();
      atualizarBotao();
    });

    chip.append(span, btn);
    elSelecionados.appendChild(chip);
  });
}

function atualizarMarcacaoDosResultados() {
  elResultados.querySelectorAll(".resultado-item[data-usuario]").forEach((item) => {
    item.classList.toggle("selecionado", selecionados.has(item.dataset.usuario));
  });
}

function linhaDeResultado(dados) {
  const item = document.createElement("div");
  item.className = "resultado-item";
  item.dataset.usuario = dados.usuario;
  if (selecionados.has(dados.usuario)) item.classList.add("selecionado");

  const check = document.createElement("div");
  check.className = "resultado-check";

  const img = document.createElement("img");
  img.alt = "";
  definirAvatar(img, dados.foto);

  const info = document.createElement("div");
  info.className = "resultado-info";
  const nome = document.createElement("strong");
  nome.textContent = dados.nome || dados.usuario;
  const arroba = document.createElement("span");
  arroba.textContent = `@${dados.usuario}`;
  info.append(nome, arroba);

  item.append(check, img, info);

  item.addEventListener("click", () => {
    if (selecionados.has(dados.usuario)) {
      selecionados.delete(dados.usuario);
    } else {
      if (selecionados.size >= MAXIMO_MEMBROS_GRUPO - 1) {
        Core.aviso(`Grupos podem ter no máximo ${MAXIMO_MEMBROS_GRUPO} pessoas.`, "#e0a800");
        return;
      }
      selecionados.set(dados.usuario, { nome: dados.nome, foto: dados.foto });
    }
    item.classList.toggle("selecionado");
    renderizarSelecionados();
    atualizarBotao();
  });

  return item;
}

function renderizarResultados(lista) {
  elResultados.replaceChildren();

  if (!lista.length) {
    elResultados.appendChild(mensagemAjuda("Nenhum usuário encontrado."));
    return;
  }

  const fragmento = document.createDocumentFragment();
  lista.forEach((dados) => fragmento.appendChild(linhaDeResultado(dados)));
  elResultados.appendChild(fragmento);
}

function mensagemAjuda(texto) {
  const span = document.createElement("span");
  span.className = "helper-text";
  span.textContent = texto;
  return span;
}

async function buscar(termo) {
  const estaBusca = ++buscaEmCurso;
  try {
    const snap = await getDocs(
      query(
        collection(db, "usuarios"),
        orderBy("usuario"),
        startAt(termo),
        endAt(`${termo}\uf8ff`),
        limit(20)
      )
    );
    if (estaBusca !== buscaEmCurso) return;

    const encontrados = snap.docs
      .map((d) => d.data())
      .filter((u) => u.usuario && u.usuario !== sessaoAtual.username);

    renderizarResultados(encontrados);
  } catch (erro) {
    console.error("Erro na busca:", erro);
    if (estaBusca !== buscaEmCurso) return;
    elResultados.replaceChildren(mensagemAjuda("Erro ao buscar. Tente de novo."));
  }
}

function aoDigitarBusca() {
  clearTimeout(temporizador);
  const termo = elBusca.value.toLowerCase().trim();

  if (!termo) {
    buscaEmCurso++;
    elResultados.replaceChildren(mensagemAjuda("Digite para encontrar pessoas para o grupo."));
    return;
  }

  temporizador = setTimeout(() => buscar(termo), 400);
}

async function criar() {
  const nome = elNome.value.trim();
  const membros = [...selecionados.keys()];

  btnCriar.disabled = true;
  btnCriar.textContent = "Criando...";

  try {
    const { chatId } = await criarGrupo(sessaoAtual, nome, membros);
    window.location.href = `chat.html?g=${encodeURIComponent(chatId)}`;
  } catch (erro) {
    console.error("Erro ao criar grupo:", erro);
    Core.aviso(erro.message || "Não foi possível criar o grupo.", "#ed4956");
    btnCriar.textContent = "Criar grupo";
    atualizarBotao();
  }
}

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  elNome.addEventListener("input", atualizarBotao);
  elBusca.addEventListener("input", aoDigitarBusca);
  btnCriar.addEventListener("click", criar);

  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
    if (document.referrer) window.history.back();
    else window.location.href = "inbox.html";
  });
}

iniciar();