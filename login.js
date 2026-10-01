import { auth } from "./firebase.js";
import {
  signInWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import Core, { configurarCamposDeSenha } from "./core.js";

const form = document.getElementById("formLogin");
const elEmail = document.getElementById("email");
const elSenha = document.getElementById("senha");
const btn = document.getElementById("btnEntrar");
const btnEsqueci = document.getElementById("btnEsqueci");

let enviando = false;

// Quem está na tela de login não tem sessão: nada da conta anterior deve
// continuar guardado neste navegador. Precisa terminar antes do login, que
// volta a usar o Firestore (ver apagarCopiaOffline no core.js).
const limpezaDoAparelho = auth.authStateReady()
  .then(() => (auth.currentUser ? false : Core.apagarCopiaOffline()))
  .catch(() => false);

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

function marcarInvalido(campo, invalido) {
  if (invalido) campo.setAttribute("aria-invalid", "true");
  else campo.removeAttribute("aria-invalid");
}

[elEmail, elSenha].forEach((campo) => campo.addEventListener("input", () => marcarInvalido(campo, false)));

async function fazerLogin() {
  if (enviando) return;
  const email = elEmail.value.trim();
  const senha = elSenha.value;

  marcarInvalido(elEmail, !email);
  marcarInvalido(elSenha, !senha);
  if (!email || !senha) {
    Core.aviso("Preencha todos os campos para entrar.", "alerta");
    (!email ? elEmail : elSenha).focus();
    return;
  }

  enviando = true;
  btn.textContent = "Entrando...";
  btn.disabled = true;

  try {
    await limpezaDoAparelho;
    await signInWithEmailAndPassword(auth, email, senha);

    // O nome de usuário sai do perfil ligado ao uid — não do e-mail nem de
    // qualquer coisa digitada. Core.sessao() cuida disso e alimenta o cache.
    const s = await Core.sessao({ exigirLogin: false });
    if (!s) {
      Core.aviso("Não encontramos seu perfil. Fale com o suporte.", "erro");
      enviando = false;
      btn.textContent = "Entrar";
      btn.disabled = false;
      return;
    }

    window.location.replace("inbox.html");
  } catch (erro) {
    console.error("Erro no login:", erro);
    const credencialErrada = ["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password"].includes(erro.code);
    if (credencialErrada) { marcarInvalido(elEmail, true); marcarInvalido(elSenha, true); }
    if (erro.code === "auth/invalid-email") marcarInvalido(elEmail, true);
    Core.aviso(mensagemDeErro(erro.code), "erro");
    enviando = false;
    btn.textContent = "Entrar";
    btn.disabled = false;
  }
}

// "Esqueci minha senha": o Firebase manda o link de redefinição por e-mail.
// A resposta é a mesma exista a conta ou não — dizer "este e-mail não tem
// conta" ajudaria quem tenta descobrir quem usa o app.
async function recuperarSenha() {
  const email = elEmail.value.trim();
  if (!email) {
    marcarInvalido(elEmail, true);
    elEmail.focus();
    Core.aviso("Digite seu e-mail acima e toque de novo em “Esqueci minha senha”.", "alerta");
    return;
  }

  btnEsqueci.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    Core.aviso("Se houver uma conta com este e-mail, enviamos um link para criar uma nova senha.", "sucesso");
  } catch (erro) {
    console.error("Erro ao pedir nova senha:", erro);
    if (erro.code === "auth/invalid-email") {
      marcarInvalido(elEmail, true);
      Core.aviso("Formato de e-mail inválido.", "erro");
    } else if (erro.code === "auth/user-not-found") {
      Core.aviso("Se houver uma conta com este e-mail, enviamos um link para criar uma nova senha.", "sucesso");
    } else {
      Core.aviso(mensagemDeErro(erro.code), "erro");
    }
  } finally {
    // Evita vários e-mails seguidos por clique repetido.
    setTimeout(() => { btnEsqueci.disabled = false; }, 4000);
  }
}

// O <form> faz o Enter funcionar em qualquer campo e deixa o gerenciador de
// senhas do navegador oferecer para salvar a senha.
form.addEventListener("submit", (e) => {
  e.preventDefault();
  fazerLogin();
});
btnEsqueci?.addEventListener("click", recuperarSenha);
configurarCamposDeSenha();
