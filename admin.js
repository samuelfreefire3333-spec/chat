import { db } from "./firebase.js";
import {
  collection, query, orderBy, limit, startAfter, startAt, endAt, getDocs, doc, updateDoc, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { sessao, definirAvatar, montarAvatarNav, mostrar } from "./core.js";
import { URL_BACKEND_HTTP } from "./radar.js";

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
const elConteudo = document.getElementById("conteudoAdmin");
const elVerificando = document.getElementById("verificandoAdmin");
const elSemResultado = document.getElementById("semResultadoAdmin");
const elContagem = document.getElementById("contagemListaAdmin");
const btnMais = document.getElementById("btnCarregarMais");

let sessaoAtual = null;
let ultimoDoc = null;
let carregando = false;
let acabou = false;

function cartaoDeUsuario(dados) {
  const card = document.createElement("div");
  card.className = dados.status === "banido" ? "admin-user-card banido" : "admin-user-card";
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
    marca.className = dados.status === "suspenso" ? "admin-marca admin-marca-suspenso" : "admin-marca";
    marca.textContent = dados.status;
    arroba.appendChild(marca);
  }

  texto.append(nome, arroba);
  info.append(img, texto);
  card.appendChild(info);

  if (dados.usuario === sessaoAtual.username) {
    const marca = document.createElement("span");
    marca.className = "admin-proprio";
    marca.textContent = "Você";
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
      ? "A pessoa perde o acesso ao chat na hora e não consegue entrar de novo até ser reativada."
      : "A pessoa volta a conseguir entrar e conversar normalmente.",
    {
      titulo: banindo ? `Banir @${usuario}?` : `Reativar @${usuario}?`,
      confirmarTexto: banindo ? "Banir" : "Reativar",
      perigo: banindo,
    }
  );
  if (!ok) return;

  btn.disabled = true;

  try {
    await updateDoc(doc(db, "usuarios", usuario), { status: novoStatus });

    // Além de bloquear a PRÓXIMA tentativa de handshake (Identity.Verificar
    // já recusava conta banida/suspensa), avisamos o backend pra derrubar
    // AGORA qualquer aba que a pessoa já tenha aberta. Sem isso, quem já
    // estava conectado seguia normalmente até o token expirar (até 1h).
    if (banindo) await desconectarSessaoAtiva(usuario);

    Core.aviso(
      banindo ? `@${usuario} foi banido.` : `@${usuario} foi reativado.`,
      "sucesso"
    );

    card.replaceWith(cartaoDeUsuario({
      usuario,
      nome: card.querySelector("strong")?.textContent,
      status: novoStatus,
      foto: card.querySelector("img")?.src,
    }));
  } catch (erro) {
    console.error("Erro ao alterar status:", erro);
    Core.aviso("Permissão negada pelo servidor.", "erro");
    btn.disabled = false;
  }
}

/**
 * Pede ao backend Go pra fechar qualquer conexão WebSocket ativa de
 * `usuario`. Falha aqui não desfaz o banimento — ele já está gravado no
 * Firestore — só significa que a sessão em aberto (se existir) vai durar
 * até expirar sozinha em vez de cair na hora. Por isso o erro é só logado,
 * nunca interrompe o fluxo de banir.
 */
async function desconectarSessaoAtiva(usuario) {
  try {
    const token = await sessaoAtual.user.getIdToken();
    const resposta = await fetch(`${URL_BACKEND_HTTP}/admin/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username: usuario }),
    });
    if (!resposta.ok) {
      console.warn(`/admin/kick respondeu ${resposta.status} para @${usuario}`);
    }
  } catch (erro) {
    console.error("Não foi possível desconectar a sessão ativa:", erro);
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
    snap.docs.forEach((d) => {
      const dados = { id: d.id, ...d.data() };
      if (!dados.usuario || elLista.querySelector(`[data-username="${CSS.escape(dados.usuario)}"]`)) return;
      fragmento.appendChild(cartaoDeUsuario(dados));
    });
    elLista.appendChild(fragmento);

    ultimoDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < POR_PAGINA) acabou = true;
    filtrar();
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
    mostrar(btnMais, !acabou);
    atualizarContagem();
  }
}

function atualizarContagem() {
  if (!elContagem) return;
  const total = elLista.querySelectorAll(".admin-user-card").length;
  elContagem.textContent = total ? `${total} ${total === 1 ? "carregado" : "carregados"}${acabou ? "" : "+"}` : "";
}

// Filtra o que já está na tela e, se ainda houver páginas não carregadas,
// procura o @ digitado direto no servidor — antes a busca só achava quem já
// estava entre os primeiros 50.
let buscaNoServidor = 0;
let temporizadorBusca = null;

function filtrar() {
  const termo = elBusca.value.toLowerCase().trim().replace(/^@/, "");
  let visiveis = 0;
  elLista.querySelectorAll(".admin-user-card").forEach((card) => {
    const bate =
      !termo ||
      card.dataset.username.includes(termo) ||
      card.dataset.nome.includes(termo);
    card.classList.toggle("u-hidden", !bate);
    if (bate) visiveis++;
  });

  const semNada = !!termo && visiveis === 0;
  if (elSemResultado) {
    elSemResultado.textContent = semNada
      ? (acabou ? `Ninguém encontrado para “${termo}”.` : `Procurando “${termo}” no servidor...`)
      : "";
    mostrar(elSemResultado, semNada);
  }
  return { termo, visiveis };
}

async function procurarNoServidor(termo) {
  const esta = ++buscaNoServidor;
  try {
    const snap = await getDocs(query(
      collection(db, "usuarios"), orderBy("usuario"), startAt(termo), endAt(`${termo}\uf8ff`), limit(20)
    ));
    if (esta !== buscaNoServidor) return;
    const fragmento = document.createDocumentFragment();
    snap.docs.forEach((d) => {
      const dados = { id: d.id, ...d.data() };
      if (!dados.usuario || elLista.querySelector(`[data-username="${CSS.escape(dados.usuario)}"]`)) return;
      fragmento.appendChild(cartaoDeUsuario(dados));
    });
    elLista.appendChild(fragmento);
  } catch (erro) {
    console.error("Erro na busca do admin:", erro);
  }
  if (esta !== buscaNoServidor) return;
  const { termo: atual, visiveis } = filtrar();
  if (atual && !visiveis && elSemResultado) {
    elSemResultado.textContent = `Ninguém encontrado para “${atual}”.`;
    mostrar(elSemResultado, true);
  }
  atualizarContagem();
}

function aoBuscar() {
  const { termo } = filtrar();
  clearTimeout(temporizadorBusca);
  if (termo && !acabou) temporizadorBusca = setTimeout(() => procurarNoServidor(termo), 350);
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
  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
    if (document.referrer && window.history.length > 1) window.history.back();
    else window.location.href = "configuracoes.html";
  });

  sessaoAtual = await sessao();
  montarAvatarNav();

  const token = await sessaoAtual.user.getIdTokenResult();
  if (token.claims.admin !== true) {
    window.location.replace(
      "aviso.html?type=error&t=Acesso%20negado&m=Voc%C3%AA%20n%C3%A3o%20tem%20permiss%C3%A3o%20para%20esta%20p%C3%A1gina.&r=inbox.html"
    );
    return;
  }

  mostrar(elPainel, true);
  mostrar(elVerificando, false);
  mostrar(elConteudo, true);

  carregarContadores();
  await carregarPagina();

  elBusca.addEventListener("input", aoBuscar);
  btnMais?.addEventListener("click", carregarPagina);

  // Carrega mais ao chegar perto do fim. Quem rola é o painel inteiro — a
  // versão anterior ouvia a rolagem da lista, que nunca rola sozinha, e a
  // segunda página jamais carregava.
  elPainel.addEventListener("scroll", () => {
    if (elPainel.scrollTop + elPainel.clientHeight >= elPainel.scrollHeight - 200) {
      carregarPagina();
    }
  }, { passive: true });
}

iniciar();