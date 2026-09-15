import { db } from "./firebase.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { sessao, montarAvatarNav } from "./core.js";

const LIMITE_NOME = 60;
const LIMITE_BIO = 200;

const elNome = document.getElementById("inputNome");
const elBio = document.getElementById("inputBio");
const btn = document.getElementById("btnSalvar");

let sessaoAtual = null;

async function salvarPerfil() {
  const nome = elNome.value.trim();
  const bio = elBio.value.trim();

  if (!nome) {
    Core.aviso("O nome de exibição não pode ficar vazio.");
    return;
  }
  if (nome.length > LIMITE_NOME) {
    Core.aviso(`O nome deve ter no máximo ${LIMITE_NOME} caracteres.`);
    return;
  }
  if (bio.length > LIMITE_BIO) {
    Core.aviso(`A bio deve ter no máximo ${LIMITE_BIO} caracteres.`);
    return;
  }

  btn.textContent = "Salvando...";
  btn.disabled = true;

  try {
    // O documento é localizado pelo perfil da sessão, não por um nome de
    // usuário lido do localStorage.
    await updateDoc(doc(db, "usuarios", sessaoAtual.perfil.id), { nome, bio });

    try { localStorage.setItem("nome", nome); } catch (_) {}
    Core.aviso("Perfil atualizado com sucesso!", "#00a884");

    setTimeout(() => {
      if (document.referrer && !document.referrer.includes("foto.html")) window.history.back();
      else window.location.href = "perfil.html";
    }, 900);
  } catch (erro) {
    console.error("Erro ao salvar perfil:", erro);
    Core.aviso("Erro ao atualizar. Tente novamente.", "#ed4956");
    btn.textContent = "Salvar Alterações";
    btn.disabled = false;
  }
}

async function iniciar() {
  sessaoAtual = await sessao();
  montarAvatarNav();

  elNome.value = sessaoAtual.perfil.nome || "";
  elBio.value = sessaoAtual.perfil.bio || "";

  elNome.maxLength = LIMITE_NOME;
  elBio.maxLength = LIMITE_BIO;

  btn.addEventListener("click", salvarPerfil);

  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
    if (document.referrer) window.history.back();
    else window.location.href = "perfil.html";
  });
}

iniciar();
