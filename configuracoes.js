import { auth } from "./firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import Core, { sessao, encerrarSessao, apagarCopiaOffline, montarAvatarNav, definirAvatar, mostrar } from "./core.js";
import Radar, { URL_BACKEND_HTTP } from "./radar.js";

/**
 * Sair desliga este aparelho da conta: a chave pública dele sai da lista (as
 * pessoas param de cifrar para ele) e as chaves privadas são apagadas do
 * navegador. É o que o WhatsApp Web e o Signal fazem ao desconectar.
 */
async function desvincularEsteAparelho(s) {
  try {
    const { revogarEsteAparelho } = await import("./e2ee.js");
    await revogarEsteAparelho(s);
  } catch (erro) {
    console.warn("Não foi possível remover as chaves deste aparelho:", erro?.codigo || erro?.code || erro);
  }
}

async function sairDaConta() {
  const confirmar = await Core.confirmar("Você vai precisar entrar de novo para ver suas conversas. Mensagens de conversas protegidas recebidas neste aparelho não voltam a abrir aqui.", {
    titulo: "Sair da conta?",
    confirmarTexto: "Sair",
  });
  if (!confirmar) return;

  try {
    const s = await sessao({ exigirLogin: false });
    if (s) await desvincularEsteAparelho(s);
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
    // Conversas guardadas para uso offline não ficam no aparelho.
    await apagarCopiaOffline({ encerrar: true });
    encerrarSessao();
    window.location.replace("login.html");
  } catch (erro) {
    console.error("Erro ao sair:", erro);
    Core.aviso("Erro ao desconectar. Tente novamente.", "erro");
  }
}

/**
 * "Sair de todos os aparelhos": o backend revoga os refresh tokens da conta
 * (nenhum aparelho consegue renovar a sessão) e derruba as conexões abertas;
 * aqui as chaves públicas dos outros aparelhos saem da lista, e este sai
 * também. Um aparelho roubado com a sessão aberta perde o acesso ao Firestore
 * quando o token dele expirar (no máximo 1 hora) e o WebSocket na hora.
 */
async function sairDeTodosOsAparelhos(botao) {
  const ok = await Core.confirmar(
    "Todos os aparelhos onde você entrou — inclusive este — vão precisar entrar de novo. Use se perdeu um aparelho ou acha que alguém entrou na sua conta.",
    { titulo: "Sair de todos os aparelhos?", confirmarTexto: "Sair de todos" }
  );
  if (!ok) return;

  botao.disabled = true;
  try {
    const s = await sessao();
    const token = await s.user.getIdToken();

    try {
      const { revogarOutrosAparelhos } = await import("./e2ee.js");
      await revogarOutrosAparelhos(s);
    } catch (erro) {
      console.warn("Não foi possível remover as chaves dos outros aparelhos:", erro?.codigo || erro?.code || erro);
    }

    const resposta = await fetch(`${URL_BACKEND_HTTP}/sessoes/revogar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resposta.ok) throw new Error(`revogar respondeu ${resposta.status}`);

    await desvincularEsteAparelho(s);
    Radar.encerrar();
    await signOut(auth);
    await apagarCopiaOffline({ encerrar: true });
    encerrarSessao();
    window.location.replace("login.html");
  } catch (erro) {
    console.error("Erro ao sair de todos os aparelhos:", erro);
    Core.aviso("Não foi possível sair de todos os aparelhos agora. Tente de novo em instantes.", "erro");
    botao.disabled = false;
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
  const btnSairDeTodos = document.querySelector('[data-acao="sair-de-todos"]');
  btnSairDeTodos?.addEventListener("click", () => sairDeTodosOsAparelhos(btnSairDeTodos));

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
