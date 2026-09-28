import { db } from "./firebase.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { sessao, montarAvatarNav, atualizarPerfilEmCache, definirAvatar } from "./core.js";

const LIMITE_NOME = 60;
const LIMITE_BIO = 200;

const form = document.getElementById("formPerfil");
const elNome = document.getElementById("inputNome");
const elBio = document.getElementById("inputBio");
const elUsuario = document.getElementById("inputUsuario");
const contadorNome = document.getElementById("contadorNome");
const contadorBio = document.getElementById("contadorBio");
const btn = document.getElementById("btnSalvar");

let sessaoAtual = null;
let original = { nome: "", bio: "" };
let salvando = false;

const valores = () => ({ nome: elNome.value.trim(), bio: elBio.value.trim() });
const temAlteracao = () => {
  const v = valores();
  return v.nome !== original.nome || v.bio !== original.bio;
};

function pintarContador(el, campo, limite) {
  if (!el) return;
  const usados = campo.value.length;
  el.textContent = `${usados}/${limite}`;
  el.classList.toggle("perto-do-limite", usados >= limite * 0.9 && usados < limite);
  el.classList.toggle("no-limite", usados >= limite);
}

function atualizarEstado() {
  pintarContador(contadorNome, elNome, LIMITE_NOME);
  pintarContador(contadorBio, elBio, LIMITE_BIO);
  if (!salvando) btn.disabled = !temAlteracao() || !valores().nome;
}

function voltar() {
  if (document.referrer && !document.referrer.includes("foto.html") && window.history.length > 1) window.history.back();
  else window.location.href = "perfil.html";
}

async function salvarPerfil() {
  // Ctrl+Enter não passa pelo botão desabilitado: sem esta trava, apertar
  // duas vezes (ou segurar a tecla) gravava duas vezes e voltava duas telas.
  if (salvando) return;
  const { nome, bio } = valores();

  if (!nome) {
    Core.aviso("O nome não pode ficar vazio.", "alerta");
    elNome.focus();
    return;
  }
  if (nome.length > LIMITE_NOME) {
    Core.aviso(`O nome deve ter no máximo ${LIMITE_NOME} caracteres.`, "alerta");
    return;
  }
  if (bio.length > LIMITE_BIO) {
    Core.aviso(`A bio deve ter no máximo ${LIMITE_BIO} caracteres.`, "alerta");
    return;
  }
  if (!temAlteracao()) return;

  salvando = true;
  btn.textContent = "Salvando...";
  btn.disabled = true;

  try {
    // O documento é localizado pelo perfil da sessão, não por um nome de
    // usuário lido do localStorage.
    await updateDoc(doc(db, "usuarios", sessaoAtual.perfil.id), { nome, bio });

    // Atualiza o perfil já resolvido nesta aba; antes, voltar para a tela de
    // perfil sem recarregar ainda mostrava o nome e a bio antigos.
    atualizarPerfilEmCache({ nome, bio });
    original = { nome, bio };
    Core.aviso("Perfil atualizado.", "sucesso");
    setTimeout(voltar, 900);
  } catch (erro) {
    console.error("Erro ao salvar perfil:", erro);
    Core.aviso("Erro ao atualizar. Tente novamente.", "erro");
    salvando = false;
    btn.textContent = "Salvar alterações";
    atualizarEstado();
  }
}

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  original = { nome: (sessaoAtual.perfil.nome || "").trim(), bio: (sessaoAtual.perfil.bio || "").trim() };
  elNome.value = original.nome;
  elBio.value = original.bio;
  if (elUsuario) elUsuario.value = `@${sessaoAtual.username}`;
  definirAvatar(document.getElementById("fotoAtual"), sessaoAtual.perfil.foto);

  elNome.maxLength = LIMITE_NOME;
  elBio.maxLength = LIMITE_BIO;

  elNome.addEventListener("input", atualizarEstado);
  elBio.addEventListener("input", atualizarEstado);
  atualizarEstado();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    salvarPerfil();
  });

  // Ctrl/⌘ + Enter salva de dentro da bio (Enter sozinho quebra a linha).
  elBio.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!e.repeat) salvarPerfil();
    }
  });

  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", async () => {
    if (temAlteracao() && !salvando) {
      const descartar = await Core.confirmar("As mudanças que você fez ainda não foram salvas.", {
        titulo: "Descartar alterações?",
        confirmarTexto: "Descartar",
      });
      if (!descartar) return;
    }
    voltar();
  });
}

iniciar();
