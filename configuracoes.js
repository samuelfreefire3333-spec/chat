import { auth } from "./firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import Core, { sessao, encerrarSessao, montarAvatarNav } from "./core.js";
import Radar from "./radar.js";

async function sairDaConta() {
  const confirmar = await Core.confirmar("Deseja sair da sua conta?", {
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
    Core.aviso("Erro ao desconectar. Tente novamente.", "#ed4956");
  }
}

async function iniciar() {
  const s = await sessao();
  montarAvatarNav();

  // O item "Aparência e Tema" agora é um link para configuracoes-tema.html,
  // que existia no projeto mas estava órfã: nenhuma página levava até ela.
  document.querySelector('[data-acao="sair"]')?.addEventListener("click", sairDaConta);

  // O botão do painel só aparece para administradores. Isto é conveniência
  // visual: quem autoriza de verdade é a custom claim "admin" verificada nas
  // regras do Firestore. Esconder o botão não protege nada sozinho.
  try {
    const token = await s.user.getIdTokenResult();
    if (token.claims.admin === true) {
      const btn = document.getElementById("btnPainelAdmin");
      if (btn) btn.style.display = "flex";
    }
  } catch (erro) {
    console.error("Erro ao ler as permissões:", erro);
  }
}

iniciar();
