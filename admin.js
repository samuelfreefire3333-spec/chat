import { db } from "./firebase.js";
import {
  collection, query, orderBy, limit, startAfter, getDocs, doc, updateDoc, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { sessao, definirAvatar, montarAvatarNav } from "./core.js";

// ==========================================================================
// PAINEL ADMINISTRATIVO
// ==========================================================================
// Importante: esconder ou mostrar esta tela no navegador NÃO é a proteção.
// Quem autoriza é a custom claim "admin" no token, verificada pelas regras do
// Firestore. Sem a claim, o updateDoc abaixo é recusado pelo servidor mesmo
// que alguém force a página a aparecer.
//
// Para conceder a permissão:  go run ./cmd/setadmin -email pessoa@exemplo.com
//
// A versão anterior comparava localStorage.getItem("usuario") com uma string
// fixa — bastava digitar no console do navegador para virar administrador.

const POR_PAGINA = 50;

const elLista = document.getElementById("listaAdmin");
const elBusca = document.getElementById("inputBuscaAdmin");
const elTotalUsuarios = document.getElementById("totalUsuarios");
const elTotalChats = document.getElementById("totalChats");
const elPainel = document.getElementById("mainAdmin");

let sessaoAtual = null;
let ultimoDoc = null;
let carregando = false;
let acabou = false;

function cartaoDeUsuario(dados) {
  const card = document.createElement("div");
  card.className = "admin-user-card";
  card.dataset.username = dados.usuario;
  card.dataset.nome = (dados.nome || "").toLowerCase();

  const info = document.createElement("div");
  info.className = "admin-user-info";

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  definirAvatar(img, dados.foto);

  const texto = document.createElement("div");
  texto.className = "admin-user-text";

  const nome = document.createElement("strong");
  nome.textContent = dados.nome || dados.usuario;

  const arroba = document.createElement("span");
  arroba.textContent = `@${dados.usuario}`;
  if (dados.status === "banido" || dados.status === "suspenso") {
    const marca = document.createElement("span");
    marca.className = "admin-marca";
    marca.textContent = ` • ${dados.status}`;
    arroba.appendChild(marca);
  }

  texto.append(nome, arroba);
  info.append(img, texto);
  card.appendChild(info);

  if (dados.usuario === sessaoAtual.username) {
    const marca = document.createElement("span");
    marca.className = "admin-proprio";
    marca.textContent = "VOCÊ";
    card.appendChild(marca);
  } else {
    const banido = dados.status === "banido";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = banido ? "btn-ban btn-ban-desfazer" : "btn-ban";
    btn.textContent = banido ? "Reativar" : "Banir";
    btn.addEventListener("click", () => alterarStatus(dados.usuario, banido ? "ativo" : "banido", btn, card));
    card.appendChild(btn);
  }

  return card;
}

async function alterarStatus(usuario, novoStatus, btn, card) {
  const banindo = novoStatus === "banido";

  const ok = await Core.confirmar(
    banindo
      ? `Banir @${usuario}? A pessoa perde o acesso ao chat.`
      : `Reativar a conta de @${usuario}?`,
    { confirmarTexto: banindo ? "Banir" : "Reativar", perigo: banindo }
  );
  if (!ok) return;

  btn.disabled = true;

  try {
    await updateDoc(doc(db, "usuarios", usuario), { status: novoStatus });

    // O backend derruba a conexão de quem foi banido na próxima tentativa,
    // porque Identity.Verificar recusa contas com status banido/suspenso.
    Core.aviso(
      banindo ? `@${usuario} foi banido.` : `@${usuario} foi reativado.`,
      "#00a884"
    );

    card.replaceWith(cartaoDeUsuario({
      usuario,
      nome: card.querySelector("strong")?.textContent,
      status: novoStatus,
      foto: card.querySelector("img")?.src,
    }));
  } catch (erro) {
    console.error("Erro ao alterar status:", erro);
    Core.aviso("Permissão negada pelo servidor.", "#ed4956");
    btn.disabled = false;
  }
}

async function carregarPagina() {
  if (carregando || acabou) return;
  carregando = true;

  try {
    // Paginado: a versão anterior baixava a coleção "usuarios" inteira de uma
    // vez para o navegador.
    let consulta = query(collection(db, "usuarios"), orderBy("usuario"), limit(POR_PAGINA));
    if (ultimoDoc) {
      consulta = query(
        collection(db, "usuarios"),
        orderBy("usuario"),
        startAfter(ultimoDoc),
        limit(POR_PAGINA)
      );
    }

    const snap = await getDocs(consulta);

    if (snap.empty) {
      acabou = true;
      if (!ultimoDoc) {
        elLista.replaceChildren();
        const vazio = document.createElement("p");
        vazio.className = "lista-vazia";
        vazio.textContent = "Nenhum usuário cadastrado.";
        elLista.appendChild(vazio);
      }
      return;
    }

    if (!ultimoDoc) elLista.replaceChildren();

    const fragmento = document.createDocumentFragment();
    snap.docs.forEach((d) => fragmento.appendChild(cartaoDeUsuario({ id: d.id, ...d.data() })));
    elLista.appendChild(fragmento);

    ultimoDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < POR_PAGINA) acabou = true;
  } catch (erro) {
    console.error("Erro ao carregar usuários:", erro);
    elLista.replaceChildren();
    const falha = document.createElement("p");
    falha.className = "lista-vazia lista-erro";
    falha.textContent = "Falha ao carregar. Verifique suas permissões.";
    elLista.appendChild(falha);
    acabou = true;
  } finally {
    carregando = false;
  }
}

function filtrar() {
  const termo = elBusca.value.toLowerCase().trim();
  elLista.querySelectorAll(".admin-user-card").forEach((card) => {
    const bate =
      !termo ||
      card.dataset.username.includes(termo) ||
      card.dataset.nome.includes(termo);
    card.style.display = bate ? "flex" : "none";
  });
}

async function carregarContadores() {
  try {
    const [usuarios, chats] = await Promise.all([
      getCountFromServer(collection(db, "usuarios")),
      getCountFromServer(collection(db, "chats")),
    ]);
    // getCountFromServer conta no servidor: não traz os documentos só para
    // usar o .size, como era feito antes.
    elTotalUsuarios.textContent = String(usuarios.data().count);
    elTotalChats.textContent = String(chats.data().count);
  } catch (erro) {
    console.error("Erro ao contar:", erro);
    elTotalUsuarios.textContent = "–";
    elTotalChats.textContent = "–";
  }
}

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  const token = await sessaoAtual.user.getIdTokenResult();
  if (token.claims.admin !== true) {
    window.location.replace(
      "aviso.html?type=error&t=Acesso%20negado&m=Voc%C3%AA%20n%C3%A3o%20tem%20permiss%C3%A3o%20para%20esta%20p%C3%A1gina.&r=inbox.html"
    );
    return;
  }

  elPainel.style.display = "flex";

  carregarContadores();
  await carregarPagina();

  elBusca.addEventListener("input", filtrar);

  // Carrega mais ao chegar perto do fim da lista.
  elLista.addEventListener("scroll", () => {
    if (elLista.scrollTop + elLista.clientHeight >= elLista.scrollHeight - 200) {
      carregarPagina();
    }
  });

  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
    if (document.referrer) window.history.back();
    else window.location.href = "configuracoes.html";
  });
}

iniciar();
