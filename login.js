import { auth } from "./firebase.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import Core from "./core.js";

const elEmail = document.getElementById("email");
const elSenha = document.getElementById("senha");
const btn = document.getElementById("btnEntrar");

function mensagemDeErro(codigo) {
  switch (codigo) {
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "E-mail ou senha incorretos.";
    case "auth/too-many-requests":
      return "Muitas tentativas. Aguarde um momento.";
    case "auth/invalid-email":
      return "Formato de e-mail inválido.";
    case "auth/user-disabled":
      return "Esta conta foi desativada.";
    case "auth/network-request-failed":
      return "Sem conexão. Verifique sua internet.";
    default:
      return "Erro ao entrar. Tente novamente.";
  }
}

async function fazerLogin() {
  const email = elEmail.value.trim();
  const senha = elSenha.value;

  if (!email || !senha) {
    Core.aviso("Preencha todos os campos para entrar.");
    return;
  }

  btn.textContent = "Entrando...";
  btn.disabled = true;

  try {
    await signInWithEmailAndPassword(auth, email, senha);

    // O nome de usuário sai do perfil ligado ao uid — não do e-mail nem de
    // qualquer coisa digitada. Core.sessao() cuida disso e alimenta o cache.
    const s = await Core.sessao({ exigirLogin: false });
    if (!s) {
      Core.aviso("Não encontramos seu perfil. Fale com o suporte.", "#ed4956");
      btn.textContent = "Entrar";
      btn.disabled = false;
      return;
    }

    window.location.replace("inbox.html");
  } catch (erro) {
    console.error("Erro no login:", erro);
    Core.aviso(mensagemDeErro(erro.code));
    btn.textContent = "Entrar";
    btn.disabled = false;
  }
}

btn.addEventListener("click", fazerLogin);

[elEmail, elSenha].forEach((campo) => {
  campo.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fazerLogin();
    }
  });
});
