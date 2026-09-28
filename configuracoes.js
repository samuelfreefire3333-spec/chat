import { auth } from "./firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import Core, { sessao, encerrarSessao, montarAvatarNav, definirAvatar, mostrar } from "./core.js";
import Radar from "./radar.js";

async function sairDaConta() {
  const confirmar = await Core.confirmar("Você vai precisar entrar de novo para ver suas conversas.", {
    titulo: "Sair da conta?",
    confirmarTexto: "Sair",
  });
  if (!confirmar) return;

  try {
    // O lastSeen é gravado pelo servidor quando o WebSocket cai — por isso
    // encerramos a conexão antes de deslogar.
    //
    // Antes havia aqui um import() cujo endereço era um link em markdown
    // colado no código:
    //   await import("[https://...](https://...)")
    // Isso lançava exceção na primeira linha do try, caía no catch e ninguém
    // conseguia sair da conta.
    Radar.encerrar();
    await signOut(auth);
    encerrarSessao();
    window.location.replace("login.html");
  } catch (erro) {
    console.error("Erro ao sair:", erro);
    Core.aviso("Erro ao desconectar. Tente novamente.", "erro");
  }
}

function nomeDoTema() {
  let tema = null;
  try { tema = localStorage.getItem("tema"); } catch (_) {}
  if (tema === "claro") return "Claro";
  if (tema === "escuro") return "Escuro";
  return "Automático (igual ao sistema)";
}

// Liga/desliga o som de mensagem nova (lido pelo radar.js a cada aviso).
function configurarSom() {
  const alternador = document.getElementById("alternarSom");
  if (!alternador) return;
  let ligado = true;
  try { ligado = localStorage.getItem("somMensagens") !== "desligado"; } catch (_) {}
  alternador.checked = ligado;
  alternador.addEventListener("change", () => {
    try { localStorage.setItem("somMensagens", alternador.checked ? "ligado" : "desligado"); } catch (_) {}
    Core.aviso(alternador.checked ? "Som de mensagem ligado." : "Som de mensagem desligado.");
  });
}

async function iniciar() {
  const temaAtual = document.getElementById("temaAtual");
  if (temaAtual) temaAtual.textContent = nomeDoTema();
  configurarSom();
  document.querySelector('[data-acao="sair"]')?.addEventListener("click", sairDaConta);

  const s = await sessao();
  montarAvatarNav();

  const nome = document.getElementById("configNome");
  const usuario = document.getElementById("configUsuario");
  if (nome) nome.textContent = s.perfil?.nome || s.username;
  if (usuario) usuario.textContent = `@${s.username}`;
  definirAvatar(document.getElementById("configFoto"), s.perfil?.foto);

  // A seção do painel só aparece para administradores. Isto é conveniência
  // visual: quem autoriza de verdade é a custom claim "admin" verificada nas
  // regras do Firestore. Esconder o botão não protege nada sozinho.
  try {
    const token = await s.user.getIdTokenResult();
    mostrar(document.getElementById("secaoAdmin"), token.claims.admin === true);
  } catch (erro) {
    console.error("Erro ao ler as permissões:", erro);
  }
}

iniciar();
