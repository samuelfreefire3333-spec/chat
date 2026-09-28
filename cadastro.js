import { db, auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { AVATAR_PADRAO, configurarCamposDeSenha } from "./core.js";

const form = document.getElementById("formCadastro");
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
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // "joão" vira "joao", e não "joo"
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

let enviando = false;

function restaurarBotao() {
  enviando = false;
  btn.textContent = "Criar conta";
  btn.disabled = false;
}

function marcarInvalido(campo, invalido) {
  if (invalido) campo.setAttribute("aria-invalid", "true");
  else campo.removeAttribute("aria-invalid");
}

async function fazerCadastro() {
  if (enviando) return;
  const nome = elNome.value.trim();
  const email = elEmail.value.trim().toLowerCase();
  const senha = elSenha.value;
  const usuario = normalizarUsuario(elUsuario.value);

  const faltando = [[elNome, !nome], [elUsuario, !elUsuario.value.trim()], [elEmail, !email], [elSenha, !senha]];
  faltando.forEach(([campo, vazio]) => marcarInvalido(campo, vazio));
  const primeiroVazio = faltando.find(([, vazio]) => vazio);
  if (primeiroVazio) {
    Core.aviso("Preencha todos os campos para continuar.", "alerta");
    primeiroVazio[0].focus();
    return;
  }
  if (usuario.length < 3 || usuario.length > 30) {
    marcarInvalido(elUsuario, true);
    elUsuario.focus();
    Core.aviso("O nome de usuário deve ter de 3 a 30 letras, números, ponto, hífen ou _.", "alerta");
    return;
  }
  if (senha.length < 6) {
    marcarInvalido(elSenha, true);
    elSenha.focus();
    Core.aviso("A senha deve ter no mínimo 6 caracteres.", "alerta");
    return;
  }

  enviando = true;
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
      marcarInvalido(elUsuario, true);
      elUsuario.focus();
      Core.aviso("Este nome de usuário já está em uso.", "alerta");
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

    // O cache de exibição precisa existir ANTES de sair desta página: as telas
    // internas ficam escondidas até a sessão resolver, e a conta recém-criada
    // ainda não passou por Core.sessao() nenhuma vez.
    try {
      localStorage.setItem("usuario", usuario);
      localStorage.setItem("nome", nome);
      localStorage.setItem("foto", AVATAR_PADRAO);
    } catch (_) { /* modo privado do navegador */ }

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

    if (erro.code === "auth/email-already-in-use" || erro.code === "auth/invalid-email") marcarInvalido(elEmail, true);
    if (erro.code === "auth/weak-password") marcarInvalido(elSenha, true);
    Core.aviso(mensagemDeErro(erro.code), "erro");
    restaurarBotao();
  }
}

// Força da senha, só como orientação (a regra de verdade é o mínimo de 6).
function avaliarSenha(senha) {
  if (!senha) return { nivel: 0, texto: "Use 8 ou mais caracteres, misturando letras e números." };
  if (senha.length < 6) return { nivel: 1, texto: `Faltam ${6 - senha.length} caractere(s) para o mínimo.` };
  let pontos = 0;
  if (senha.length >= 8) pontos++;
  if (senha.length >= 12) pontos++;
  if (/[a-z]/.test(senha) && /[A-Z]/.test(senha)) pontos++;
  if (/\d/.test(senha)) pontos++;
  if (/[^A-Za-z0-9]/.test(senha)) pontos++;
  if (pontos >= 3) return { nivel: 3, texto: "Senha forte." };
  if (pontos >= 1) return { nivel: 2, texto: "Senha razoável. Misture letras, números e símbolos para reforçar." };
  return { nivel: 1, texto: "Senha fraca. Use 8 ou mais caracteres, com letras e números." };
}

const elForca = document.querySelector(".forca-senha");
const elForcaTexto = document.getElementById("forcaSenhaTexto");
elSenha.addEventListener("input", () => {
  const { nivel, texto } = avaliarSenha(elSenha.value);
  if (elForca) elForca.dataset.nivel = String(nivel);
  if (elForcaTexto) elForcaTexto.textContent = texto;
});

// O nome de usuário já aparece como será salvo: minúsculas, sem espaço nem
// acento. Antes a correção só acontecia ao sair do campo.
function limparUsuarioNoCampo() {
  const bruto = elUsuario.value;
  const limpo = normalizarUsuario(bruto.replace(/^@+/, ""));
  if (limpo !== bruto) {
    const pos = elUsuario.selectionStart ?? limpo.length;
    const diferenca = bruto.length - limpo.length;
    elUsuario.value = limpo;
    try { elUsuario.setSelectionRange(Math.max(0, pos - diferenca), Math.max(0, pos - diferenca)); } catch (_) {}
  }
}
// Durante a composição de acentos (teclas mortas, teclado do celular) o
// campo não pode ser mexido: espera a letra ficar pronta.
elUsuario.addEventListener("input", (e) => { if (!e.isComposing) limparUsuarioNoCampo(); });
elUsuario.addEventListener("compositionend", limparUsuarioNoCampo);
elUsuario.addEventListener("blur", limparUsuarioNoCampo);

[elNome, elUsuario, elEmail, elSenha].forEach((campo) => {
  campo.addEventListener("input", () => marcarInvalido(campo, false));
});

// O <form> cuida do Enter em qualquer campo e do gerenciador de senhas.
form.addEventListener("submit", (e) => {
  e.preventDefault();
  fazerCadastro();
});
configurarCamposDeSenha();

