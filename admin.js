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
    // 1) Perfil: vale na hora (as regras deixam o admin mudar só o status) e
    //    o backend já recusa o próximo WebSocket dessa conta.
    await updateDoc(doc(db, "usuarios", usuario), { status: novoStatus });

    // 2) Backend: desativa (ou reativa) a conta no Firebase Auth, revoga as
    //    sessões e derruba as conexões abertas. Sem isto a conta banida
    //    continuava lendo e escrevendo no Firestore com o token que já tinha.
    const confirmado = await aplicarStatusNoServidor(usuario, novoStatus);

    if (confirmado) {
      Core.aviso(banindo ? `@${usuario} foi banido.` : `@${usuario} foi reativado.`, "sucesso");
    } else {
      Core.aviso(banindo
        ? `@${usuario} foi marcado como banido, mas o servidor não confirmou a revogação das sessões. Tente de novo.`
        : `@${usuario} foi marcado como ativo, mas o servidor não reativou a conta de login. Tente de novo.`, "alerta");
    }

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

async function chamarBackend(caminho, { metodo = "POST", corpo = null } = {}) {
  const token = await sessaoAtual.user.getIdToken();
  const opcoes = { method: metodo, headers: { Authorization: `Bearer ${token}` } };
  if (corpo) {
    opcoes.headers["Content-Type"] = "application/json";
    opcoes.body = JSON.stringify(corpo);
  }
  return fetch(`${URL_BACKEND_HTTP}${caminho}`, opcoes);
}

/**
 * Aplica o status também no Firebase Auth pelo backend (com o Admin SDK).
 * Backend antigo, sem /admin/status: pelo menos derruba as conexões abertas.
 * Devolve true se o servidor confirmou tudo.
 */
async function aplicarStatusNoServidor(usuario, status) {
  try {
    const resposta = await chamarBackend("/admin/status", { corpo: { username: usuario, status } });
    if (resposta.ok) return true;
    console.warn(`/admin/status respondeu ${resposta.status} para @${usuario}`);
    if (resposta.status === 404 && status !== "ativo") {
      await chamarBackend("/admin/kick", { corpo: { username: usuario } });
    }
  } catch (erro) {
    console.error("Backend indisponível ao aplicar o status:", erro);
  }
  return false;
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

/**
 * Totais do painel. Contar conversas no navegador exigia que as regras
 * deixassem o admin ler TODAS as conversas (com as prévias das mensagens);
 * agora o backend conta no servidor. Sem backend, só os perfis.
 */
async function carregarContadores() {
  try {
    const resposta = await chamarBackend("/admin/contadores", { metodo: "GET" });
    if (!resposta.ok) throw new Error(`contadores respondeu ${resposta.status}`);
    const dados = await resposta.json();
    elTotalUsuarios.textContent = Number.isFinite(dados.usuarios) ? String(dados.usuarios) : "–";
    elTotalChats.textContent = Number.isFinite(dados.conversas) ? String(dados.conversas) : "–";
    return;
  } catch (erro) {
    console.warn("Contadores do backend indisponíveis:", erro);
  }
  try {
    const usuarios = await getCountFromServer(collection(db, "usuarios"));
    elTotalUsuarios.textContent = String(usuarios.data().count);
  } catch (erro) {
    console.error("Erro ao contar:", erro);
    elTotalUsuarios.textContent = "–";
  }
  elTotalChats.textContent = "–";
}

const NOMES_DE_EVENTOS = {
  auth_recusada: "Login recusado no WebSocket",
  auth_bloqueio_ip: "IP bloqueado por tentativas",
  ws_negado: "Acesso negado a conversa",
  ws_limite: "Limite de envio atingido",
  ws_quadro_invalido: "Quadro inválido",
  ws_quadro_malformado: "Quadro malformado (conexão encerrada)",
  ws_abuso: "Conexão encerrada por abuso",
  ws_flood: "Flood de mensagens",
  ws_origem_recusada: "Origem desconhecida",
  ws_limite_conexoes: "Conexões demais do mesmo IP",
  ws_limite_handshake: "Reconexões demais",
  http_nao_autenticado: "Token inválido na API",
  http_proibido: "Tentativa em área de admin",
  admin_status: "Status alterado por admin",
  admin_kick: "Sessão derrubada por admin",
  sessoes_revogadas: "Saiu de todos os aparelhos",
  csp_violacao: "Bloqueio da CSP (possível XSS)",
};

/** Eventos de segurança recentes, registrados pelo backend. */
async function carregarSeguranca() {
  const lista = document.getElementById("listaSeguranca");
  const resumo = document.getElementById("resumoSeguranca");
  if (!lista) return;
  try {
    const resposta = await chamarBackend("/admin/seguranca", { metodo: "GET" });
    if (!resposta.ok) throw new Error(`seguranca respondeu ${resposta.status}`);
    const dados = await resposta.json();
    const eventos = Array.isArray(dados?.seguranca?.recentes) ? dados.seguranca.recentes.slice(0, 20) : [];
    if (resumo) resumo.textContent = `${Number(dados.conexoesAtivas) || 0} conexões agora`;
    lista.replaceChildren();
    if (!eventos.length) {
      const li = document.createElement("li");
      li.className = "evento-vazio";
      li.textContent = "Nenhum evento desde o último reinício do servidor.";
      lista.appendChild(li);
      return;
    }
    eventos.forEach((e) => {
      const li = document.createElement("li");
      const tipo = document.createElement("span");
      tipo.className = "evento-tipo";
      tipo.textContent = NOMES_DE_EVENTOS[e.tipo] || String(e.tipo || "evento");
      const hora = document.createElement("span");
      hora.className = "evento-hora";
      const quando = new Date(e.quando);
      hora.textContent = Number.isNaN(quando.getTime()) ? "" : quando.toLocaleString("pt-BR");
      const detalhe = document.createElement("span");
      detalhe.textContent = [e.alvo ? `@${e.alvo}` : "", e.detalhe || "", e.ip || ""].filter(Boolean).join(" · ");
      li.append(tipo, hora, detalhe);
      lista.appendChild(li);
    });
  } catch (erro) {
    console.warn("Eventos de segurança indisponíveis:", erro);
    lista.replaceChildren();
    const li = document.createElement("li");
    li.className = "evento-vazio";
    li.textContent = "Não foi possível falar com o servidor agora.";
    lista.appendChild(li);
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
      "aviso.html?c=acesso-negado&r=inbox.html"
    );
    return;
  }

  mostrar(elPainel, true);
  mostrar(elVerificando, false);
  mostrar(elConteudo, true);

  carregarContadores();
  carregarSeguranca();
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