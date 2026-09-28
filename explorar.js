import { db } from "./firebase.js";
import {
  collection, query, orderBy, startAt, endAt, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { sessao, definirAvatar, montarAvatarNav } from "./core.js";

// Nota: existia um explorar.js no projeto que nenhuma página carregava — ele
// procurava os elementos "inputPesquisa" e "resultadosPesquisa", que não
// existem neste HTML. A busca real estava embutida no explorar.html. Este
// arquivo é a versão única e de fato conectada à página.

const elBusca = document.getElementById("inputBusca");
const elLista = document.getElementById("listaResultados");

let sessaoAtual = null;
let temporizador = null;
let buscaEmCurso = 0;

const ICONE_BUSCA = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
const ICONE_MENSAGEM = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.928c0-3.66-3.08-6.66-6.88-6.66H8.88C5.08 5.268 2 8.268 2 11.928c0 3.66 3.08 6.66 6.88 6.66h.273l3.655 3.32a.75.75 0 0 0 1.25-.563v-2.757h1.062c3.8 0 6.88-3 6.88-6.66Z"></path></svg>';
const ICONE_FECHAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

// ==========================================================================
// RECENTES (só neste aparelho; o logout apaga junto com o resto do cache)
// ==========================================================================

const CHAVE_RECENTES = "buscasRecentes";
const MAX_RECENTES = 8;

function lerRecentes() {
  try {
    const lista = JSON.parse(localStorage.getItem(CHAVE_RECENTES) || "[]");
    return Array.isArray(lista) ? lista.filter((u) => u && typeof u.usuario === "string") : [];
  } catch (_) {
    return [];
  }
}

function gravarRecentes(lista) {
  try { localStorage.setItem(CHAVE_RECENTES, JSON.stringify(lista.slice(0, MAX_RECENTES))); } catch (_) {}
}

function lembrar(dados) {
  const item = { usuario: dados.usuario, nome: dados.nome || "", foto: dados.foto || "" };
  gravarRecentes([item, ...lerRecentes().filter((u) => u.usuario !== item.usuario)]);
}

function esquecer(usuario) {
  gravarRecentes(lerRecentes().filter((u) => u.usuario !== usuario));
  mostrarInicio();
}

// ==========================================================================
// DESENHO
// ==========================================================================

function estadoVazio(titulo, texto, erro = false) {
  const caixa = document.createElement("div");
  caixa.className = erro ? "estado-vazio estado-erro" : "estado-vazio";
  caixa.setAttribute("role", "status");
  const icone = document.createElement("div");
  icone.className = "estado-vazio-icone";
  icone.innerHTML = ICONE_BUSCA;
  const forte = document.createElement("strong");
  forte.textContent = titulo;
  const span = document.createElement("span");
  span.textContent = texto;
  caixa.append(icone, forte, span);
  return caixa;
}

function esqueleto(quantos = 5) {
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

/** Escreve o texto destacando o trecho do começo que bate com a busca. */
function textoComDestaque(el, texto, termo) {
  const t = String(texto || "");
  if (termo && t.toLowerCase().startsWith(termo)) {
    const mark = document.createElement("mark");
    mark.textContent = t.slice(0, termo.length);
    el.append(mark, document.createTextNode(t.slice(termo.length)));
  } else {
    el.textContent = t;
  }
}

function linhaDeUsuario(dados, { termo = "", recente = false } = {}) {
  const linha = document.createElement("div");
  linha.className = "explorar-item";

  const link = document.createElement("a");
  link.className = "lista-usuario-item";
  link.href = `perfil.html?u=${encodeURIComponent(dados.usuario)}`;
  link.addEventListener("click", () => lembrar(dados));

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  // definirAvatar valida o esquema da URL sem escapar caracteres. A versão
  // anterior passava a foto por um escape de HTML, o que trocava "&" por
  // "&amp;" e quebrava as URLs assinadas do Firebase Storage.
  definirAvatar(img, dados.foto);

  const info = document.createElement("div");
  info.className = "lista-usuario-info";

  const nome = document.createElement("strong");
  textoComDestaque(nome, dados.nome || dados.usuario, termo);

  const arroba = document.createElement("span");
  arroba.append("@");
  const resto = document.createElement("span");
  textoComDestaque(resto, dados.usuario, termo);
  arroba.appendChild(resto);

  info.append(nome, arroba);
  link.append(img, info);
  linha.appendChild(link);

  if (recente) {
    const remover = document.createElement("button");
    remover.type = "button";
    remover.className = "btn-icone explorar-remover";
    remover.setAttribute("aria-label", `Remover @${dados.usuario} das recentes`);
    remover.innerHTML = ICONE_FECHAR;
    remover.addEventListener("click", () => esquecer(dados.usuario));
    linha.appendChild(remover);
  } else {
    const conversar = document.createElement("a");
    conversar.className = "btn-icone explorar-acao";
    conversar.href = `chat.html?u=${encodeURIComponent(dados.usuario)}`;
    conversar.title = "Enviar mensagem";
    conversar.setAttribute("aria-label", `Enviar mensagem para @${dados.usuario}`);
    conversar.innerHTML = ICONE_MENSAGEM;
    conversar.addEventListener("click", () => lembrar(dados));
    linha.appendChild(conversar);
  }

  return linha;
}

function mostrarInicio() {
  const recentes = lerRecentes().filter((u) => u.usuario !== sessaoAtual?.username);
  if (!recentes.length) {
    elLista.replaceChildren(estadoVazio(
      "Encontre pessoas no Sinex",
      "Pesquise pelo nome ou pelo @usuário para ver o perfil ou começar uma conversa."
    ));
    return;
  }

  const topo = document.createElement("div");
  topo.className = "explorar-secao-topo";
  const titulo = document.createElement("h2");
  titulo.textContent = "Recentes";
  const limpar = document.createElement("button");
  limpar.type = "button";
  limpar.className = "btn-texto";
  limpar.textContent = "Limpar tudo";
  limpar.addEventListener("click", () => { gravarRecentes([]); mostrarInicio(); elBusca.focus(); });
  topo.append(titulo, limpar);

  const fragmento = document.createDocumentFragment();
  fragmento.appendChild(topo);
  recentes.forEach((u) => fragmento.appendChild(linhaDeUsuario(u, { recente: true })));
  elLista.replaceChildren(fragmento);
}

// ==========================================================================
// BUSCA
// ==========================================================================

/**
 * Busca por prefixo: U+F8FF fica no fim da área de uso privado, então o
 * intervalo [termo, termo+U+F8FF] pega tudo que começa com o digitado.
 */
function consultaDePrefixo(campo, prefixo) {
  return getDocs(
    query(
      collection(db, "usuarios"),
      orderBy(campo),
      startAt(prefixo),
      endAt(`${prefixo}`),
      limit(20)
    )
  ).catch(() => null);
}

async function buscar(termo) {
  const estaBusca = ++buscaEmCurso;

  try {
    // A busca só olhava o nome de usuário: procurar por "Maria" não achava
    // ninguém se o @ dela fosse "mari_98". Agora o nome de exibição também
    // entra na conta.
    //
    // O Firestore compara texto byte a byte, então o prefixo do nome precisa
    // respeitar maiúsculas. Tentamos a forma digitada e a forma capitalizada,
    // que cobre o jeito como as pessoas de fato escrevem o próprio nome.
    const capitalizado = termo.charAt(0).toUpperCase() + termo.slice(1);
    const variantesDeNome = capitalizado === termo ? [termo] : [termo, capitalizado];

    const respostas = await Promise.all([
      consultaDePrefixo("usuario", termo),
      ...variantesDeNome.map((v) => consultaDePrefixo("nome", v)),
    ]);

    if (estaBusca !== buscaEmCurso) return; // chegou uma busca mais nova

    if (respostas.every((r) => r === null)) {
      elLista.replaceChildren(estadoVazio("Não foi possível pesquisar", "Verifique sua conexão e tente de novo.", true));
      return;
    }

    // Um mesmo perfil pode voltar em mais de uma consulta.
    const porUsuario = new Map();
    respostas.forEach((snap) => {
      snap?.docs.forEach((d) => {
        const dados = d.data();
        if (dados.usuario) porUsuario.set(dados.usuario, dados);
      });
    });

    const encontrados = [...porUsuario.values()]
      .filter((u) => u.usuario !== sessaoAtual.username)
      .sort((a, b) => String(a.nome || a.usuario).localeCompare(String(b.nome || b.usuario), "pt-BR"))
      .slice(0, 20);

    if (!encontrados.length) {
      elLista.replaceChildren(estadoVazio(
        "Ninguém encontrado",
        `Não achamos ninguém com nome ou usuário começando por “${termo}”.`
      ));
      return;
    }

    const fragmento = document.createDocumentFragment();
    encontrados.forEach((u) => fragmento.appendChild(linhaDeUsuario(u, { termo })));
    elLista.replaceChildren(fragmento);
  } catch (erro) {
    console.error("Erro na busca:", erro);
    if (estaBusca !== buscaEmCurso) return;
    elLista.replaceChildren(estadoVazio("Não foi possível pesquisar", "Verifique sua conexão e tente de novo.", true));
  }
}

function aoDigitar() {
  clearTimeout(temporizador);

  const termo = elBusca.value.toLowerCase().trim().replace(/^@/, "");

  if (!termo) {
    buscaEmCurso++; // cancela o que estiver em voo
    mostrarInicio();
    return;
  }

  elLista.replaceChildren(esqueleto());

  // Espera um instante depois da última tecla, para não disparar uma
  // consulta por caractere.
  temporizador = setTimeout(() => buscar(termo), 350);
}

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();
  elBusca.addEventListener("input", aoDigitar);
  // Enter no teclado do celular: busca na hora e fecha o teclado.
  elBusca.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(temporizador);
    const termo = elBusca.value.toLowerCase().trim().replace(/^@/, "");
    if (termo) buscar(termo);
    elBusca.blur();
  });
  mostrarInicio();
  // No computador o cursor já começa na busca.
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) elBusca.focus({ preventScroll: true });
}

iniciar();
