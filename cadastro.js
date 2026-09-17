import { db, auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { AVATAR_PADRAO } from "./core.js";

const elNome = document.getElementById("nome");
const elUsuario = document.getElementById("usuario");
const elEmail = document.getElementById("email");
const elSenha = document.getElementById("senha");
const btn = document.getElementById("btnCadastrar");

/**
 * Normaliza o nome de usuário.
 */
export function normalizarUsuario(entrada) {
  return String(entrada || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, "");
}

function mensagemDeErro(codigo) {
  switch (codigo) {
    case "auth/email-already-in-use":
      return "Este e-mail já está cadastrado.";
    case "auth/invalid-email":
      return "Formato de e-mail inválido.";
    case "auth/weak-password":
      return "Senha muito fraca. Use ao menos 6 caracteres.";
    case "auth/network-request-failed":
      return "Sem conexão. Verifique sua internet.";
    default:
      return "Erro ao criar conta. Tente novamente.";
  }
}

function restaurarBotao() {
  btn.textContent = "Criar Conta";
  btn.disabled = false;
}

async function fazerCadastro() {
  const nome = elNome.value.trim();
  const email = elEmail.value.trim().toLowerCase();
  const senha = elSenha.value;
  const usuario = normalizarUsuario(elUsuario.value);

  if (!nome || !elUsuario.value.trim() || !email || !senha) {
    Core.aviso("Preencha todos os campos para continuar.");
    return;
  }
  if (senha.length < 6) {
    Core.aviso("A senha deve ter no mínimo 6 caracteres.");
    return;
  }
  if (usuario.length < 3 || usuario.length > 30) {
    Core.aviso("O nome de usuário deve ter de 3 a 30 letras, números, ponto, hífen ou _.");
    return;
  }

  btn.textContent = "Criando...";
  btn.disabled = true;

  let credencial = null;

  try {
    // A regra do Firestore exige login pra ler qualquer documento
    // (request.auth != null). Por isso a conta no Firebase Auth precisa
    // ser criada ANTES de checar se o nome de usuário já existe — antes
    // essa checagem rodava sem ninguém logado, a leitura era sempre
    // negada, e o cadastro travava pra qualquer pessoa nova.
    credencial = await createUserWithEmailAndPassword(auth, email, senha);

    const ref = doc(db, "usuarios", usuario);
    if ((await getDoc(ref)).exists()) {
      // Nome já em uso: desfaz a conta que acabou de ser criada.
      await deleteUser(credencial.user);
      Core.aviso("Este nome de usuário já está em uso.");
      restaurarBotao();
      return;
    }

    // O uid é o que liga o perfil ao token. Sem ele, as regras do Firestore e
    // o backend Go não têm como autorizar nada em nome desta conta.
    await setDoc(ref, {
      usuario,
      uid: credencial.user.uid,
      nome,
      email,
      foto: AVATAR_PADRAO,
      bio: "Olá! Estou usando o Sinex Chat.",
      dataCriacao: serverTimestamp(),
      lastSeen: Date.now(),
    });

    window.location.replace("inbox.html");
  } catch (erro) {
    console.error("Erro no cadastro:", erro);

    // Se a conta de autenticação foi criada mas o perfil falhou, ficaria um
    // login órfão sem perfil — impossível de usar e de recadastrar.
    if (credencial?.user) {
      try {
        await deleteUser(credencial.user);
      } catch (limpeza) {
        console.error("Não foi possível desfazer a conta parcial:", limpeza);
      }
    }

    Core.aviso(mensagemDeErro(erro.code));
    restaurarBotao();
  }
}

btn.addEventListener("click", fazerCadastro);

// Mostra ao vivo como o nome de usuário será salvo.
elUsuario.addEventListener("blur", () => {
  const limpo = normalizarUsuario(elUsuario.value);
  if (limpo && limpo !== elUsuario.value.trim()) elUsuario.value = limpo;
});

[elNome, elUsuario, elEmail, elSenha].forEach((campo) => {
  campo.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fazerCadastro();
    }
  });
});

