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

function mensagem(texto, erro = false) {
  const div = document.createElement("div");
  div.className = erro ? "lista-vazia lista-erro" : "lista-vazia";
  div.setAttribute("role", "status");
  div.textContent = texto;
  return div;
}

function linhaDeUsuario(dados) {
  const link = document.createElement("a");
  link.className = "lista-usuario-item";
  link.href = `perfil.html?u=${encodeURIComponent(dados.usuario)}`;

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
  nome.textContent = dados.nome || dados.usuario;

  const arroba = document.createElement("span");
  arroba.textContent = `@${dados.usuario}`;

  info.append(nome, arroba);
  link.append(img, info);
  return link;
}

async function buscar(termo) {
  const estaBusca = ++buscaEmCurso;

  try {
    // Busca por prefixo: U+F8FF fica no fim da área de uso privado, então o
    // intervalo [termo, termo+U+F8FF] pega tudo que começa com o digitado.
    //
    // O endAt() estava sem o sufixo U+F8FF (endAt(`${termo}`) é só o próprio
    // termo), então a consulta só batia com usuário == termo exato — a busca
    // "por prefixo" na prática só funcionava para o nome de usuário completo.
    const snap = await getDocs(
      query(
        collection(db, "usuarios"),
        orderBy("usuario"),
        startAt(termo),
        endAt(`${termo}\uf8ff`),
        limit(20)
      )
    );

    if (estaBusca !== buscaEmCurso) return; // chegou uma busca mais nova

    const encontrados = snap.docs
      .map((d) => d.data())
      .filter((u) => u.usuario && u.usuario !== sessaoAtual.username);

    if (!encontrados.length) {
      elLista.replaceChildren(mensagem("Nenhum usuário encontrado."));
      return;
    }

    const fragmento = document.createDocumentFragment();
    encontrados.forEach((u) => fragmento.appendChild(linhaDeUsuario(u)));
    elLista.replaceChildren(fragmento);
  } catch (erro) {
    console.error("Erro na busca:", erro);
    if (estaBusca !== buscaEmCurso) return;
    elLista.replaceChildren(mensagem("Erro ao buscar. Tente de novo.", true));
  }
}

function aoDigitar() {
  clearTimeout(temporizador);

  const termo = elBusca.value.toLowerCase().trim();

  if (!termo) {
    buscaEmCurso++; // cancela o que estiver em voo
    elLista.replaceChildren(mensagem("Digite para procurar novos contatos."));
    return;
  }

  elLista.replaceChildren(mensagem("Buscando..."));

  // Espera meio segundo depois da última tecla, para não disparar uma
  // consulta por caractere.
  temporizador = setTimeout(() => buscar(termo), 500);
}

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();
  elBusca.addEventListener("input", aoDigitar);
}

iniciar();