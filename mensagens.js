import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, deleteField, collection, query,
  orderBy, limit, startAfter, onSnapshot, getDocs, serverTimestamp, writeBatch, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { idDoChat, buscarPerfilPorUsername, paraMillis } from "./core.js";

// As mensagens ficam em chats/{id}/mensagens/{msgId}, uma por documento.
//
// Antes tudo era um array dentro de um único documento, com arrayUnion. Isso
// tinha dois problemas fatais: o documento estoura o limite de 1 MiB do
// Firestore e a conversa morre; e cada mensagem nova fazia o onSnapshot baixar
// o histórico inteiro de novo.
//
// "chats/{id}" agora também pode ser um grupo (tipo: "grupo"), com 3 ou mais
// pessoas em "uids"/"usuarios" em vez de exatamente 2. O restante do modelo —
// mensagens, reações, respostas — é o mesmo para os dois casos.

export const LIMITE_HISTORICO = 200;
export const TAMANHO_PAGINA_HISTORICO = 50; // quantas mensagens "carregar mais" busca por vez
export const MINIMO_MEMBROS_GRUPO = 3; // eu + pelo menos 2 pessoas
export const MAXIMO_MEMBROS_GRUPO = 20; // ver nota de escalabilidade em enviar() no chat.js

/** Resumo curto exibido na lista de conversas e nas prévias de resposta. */
export function resumo(tipo, texto) {
  switch (tipo) {
    case "audio": return "🎤 Mensagem de voz";
    case "imagem": return "📷 Foto";
    case "sistema": return texto;
    default: return texto;
  }
}

/**
 * Garante que o documento do chat DIRETO (1 para 1) existe, com os dois
 * participantes e os dois uids — os uids são o que as regras do Firestore
 * usam para autorizar acesso. Para grupos, veja criarGrupo().
 */
export async function garantirChat(sessao, outroUsername) {
  const meu = sessao.username;
  const outro = String(outroUsername).toLowerCase().trim();
  const chatId = idDoChat(meu, outro);
  const ref = doc(db, "chats", chatId);

  const atual = await getDoc(ref);
  if (atual.exists()) return { chatId, ref };

  const perfilOutro = await buscarPerfilPorUsername(outro);
  if (!perfilOutro) {
    throw new Error(`Usuário @${outro} não encontrado.`);
  }
  if (!perfilOutro.uid) {
    // Conta anterior à migração de uid. O backend grava o uid na primeira
    // conexão da pessoa; até lá não há como autorizar o chat com segurança.
    throw new Error(
      `A conta de @${outro} ainda não foi migrada. Peça para essa pessoa abrir o app uma vez.`
    );
  }

  await setDoc(ref, {
    tipo: "direto",
    usuarios: [meu, outro].sort(),
    uids: [sessao.user.uid, perfilOutro.uid].sort(),
    criadoEm: serverTimestamp(),
    timestamp: serverTimestamp(),
    ultimaMensagem: "",
  });

  return { chatId, ref };
}

/**
 * Cria um chat em grupo com 3 ou mais participantes (eu + membros).
 * Diferente do chat direto, o ID não é derivado dos nomes: é um ID aleatório
 * do Firestore, porque um grupo não tem um par fixo de usuários.
 */
export async function criarGrupo(sessao, nome, usernames) {
  const nomeLimpo = String(nome || "").trim();
  if (!nomeLimpo) {
    throw new Error("Dê um nome ao grupo.");
  }
  if (nomeLimpo.length > 60) {
    throw new Error("O nome do grupo deve ter no máximo 60 caracteres.");
  }

  const membros = [...new Set(
    (usernames || []).map((u) => String(u).toLowerCase().trim()).filter(Boolean)
  )].filter((u) => u !== sessao.username);

  if (membros.length < MINIMO_MEMBROS_GRUPO - 1) {
    throw new Error(`Escolha pelo menos ${MINIMO_MEMBROS_GRUPO - 1} pessoas para criar um grupo.`);
  }
  if (membros.length > MAXIMO_MEMBROS_GRUPO - 1) {
    throw new Error(`Grupos podem ter no máximo ${MAXIMO_MEMBROS_GRUPO} pessoas.`);
  }

  const perfis = await Promise.all(membros.map((u) => buscarPerfilPorUsername(u)));

  const naoEncontrados = [];
  const naoMigrados = [];
  perfis.forEach((perfil, i) => {
    if (!perfil) naoEncontrados.push(membros[i]);
    else if (!perfil.uid) naoMigrados.push(membros[i]);
  });

  if (naoEncontrados.length) {
    throw new Error(`Usuário(s) não encontrado(s): ${naoEncontrados.map((u) => `@${u}`).join(", ")}.`);
  }
  if (naoMigrados.length) {
    throw new Error(
      `${naoMigrados.map((u) => `@${u}`).join(", ")} ainda não migrou a conta. Peça para a pessoa abrir o app uma vez.`
    );
  }

  const usuarios = [sessao.username, ...membros].sort();
  const uids = [sessao.user.uid, ...perfis.map((p) => p.uid)].sort();

  // ID aleatório: doc(collection(...)) sem 3º argumento gera um ID novo sem
  // gravar nada ainda.
  const ref = doc(collection(db, "chats"));

  await setDoc(ref, {
    tipo: "grupo",
    nome: nomeLimpo,
    usuarios,
    uids,
    criadoPor: sessao.username,
    criadoEm: serverTimestamp(),
    timestamp: serverTimestamp(),
    ultimaMensagem: "",
    ultimoRemetente: "",
  });

  return { chatId: ref.id };
}

/** Carrega os metadados de um chat (direto ou grupo) pelo ID. */
export async function obterChat(chatId) {
  const snap = await getDoc(doc(db, "chats", chatId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Grava uma mensagem num chat já resolvido (chatId + ref do documento pai).
 * Usada tanto pelo envio direto quanto pelo envio em grupo — a diferença
 * entre os dois está só em como o chat foi resolvido antes de chegar aqui.
 *
 * O timestamp é o do servidor — o relógio do aparelho não é confiável e as
 * regras exigem request.time.
 */
async function enviarMensagemEmChat(sessao, chatId, ref, { texto, tipo = "texto", respondendoA = null }) {
  const conteudo = String(texto || "").trim();
  if (!conteudo) return null;

  const mensagem = {
    remetente: sessao.username,
    remetenteUid: sessao.user.uid,
    texto: conteudo,
    tipo,
    timestamp: serverTimestamp(),
  };

  // Resposta a outra mensagem: guardamos uma prévia junto (denormalizado) em
  // vez de só o ID, para desenhar a citação na hora sem mais uma leitura no
  // Firestore por mensagem exibida.
  if (respondendoA?.id) {
    mensagem.respostaId = respondendoA.id;
    mensagem.respostaAutor = respondendoA.autor;
    mensagem.respostaTexto = resumo(respondendoA.tipo, respondendoA.texto).slice(0, 120);
    mensagem.respostaTipo = respondendoA.tipo;
  }

  const criada = await addDoc(collection(db, "chats", chatId, "mensagens"), mensagem);

  // Resumo no documento pai, para a caixa de entrada não precisar ler as
  // mensagens de cada conversa.
  await updateDoc(ref, {
    ultimaMensagem: resumo(tipo, conteudo).slice(0, 120),
    ultimoRemetente: sessao.username,
    timestamp: serverTimestamp(),
  });

  return { id: criada.id, chatId };
}

/** Envia uma mensagem num chat direto (1 para 1), criando o chat se preciso. */
export async function enviarMensagem(sessao, outroUsername, opcoes) {
  const { chatId, ref } = await garantirChat(sessao, outroUsername);
  return enviarMensagemEmChat(sessao, chatId, ref, opcoes);
}

/** Envia uma mensagem num grupo já existente (o grupo é criado por criarGrupo()). */
export async function enviarMensagemNoGrupo(sessao, chatId, opcoes) {
  const ref = doc(db, "chats", chatId);
  return enviarMensagemEmChat(sessao, chatId, ref, opcoes);
}

/** Mensagem automática do sistema (chamada perdida, recusada). */
export async function registrarEventoDeChamada(sessao, outroUsername, texto) {
  try {
    await enviarMensagem(sessao, outroUsername, { texto, tipo: "sistema" });
  } catch (err) {
    console.error("Não foi possível registrar o evento da chamada:", err);
  }
}

/**
 * Alterna a reação da pessoa logada numa mensagem. Tocar de novo no mesmo
 * emoji remove a reação; tocar num emoji diferente troca.
 *
 * Recebe o emoji atual (o que já está renderizado na tela) em vez de ler o
 * documento de novo — quem chama já tem esse dado da própria escuta em
 * tempo real, então economiza uma leitura por toque.
 */
export async function reagirMensagem(chatId, mensagemId, uid, emojiAtual, emojiEscolhido) {
  const ref = doc(db, "chats", chatId, "mensagens", mensagemId);
  const campo = `reacoes.${uid}`;

  if (emojiAtual === emojiEscolhido) {
    await updateDoc(ref, { [campo]: deleteField() });
  } else {
    await updateDoc(ref, { [campo]: emojiEscolhido });
  }
}

/** Converte um QueryDocumentSnapshot de mensagem no formato que a UI usa. */
function paraMensagem(d) {
  const dados = d.data();
  return {
    id: d.id,
    ...dados,
    // Enquanto o servidor não confirma, timestamp vem null.
    timestampMs: paraMillis(dados.timestamp),
    pendente: dados.timestamp === null,
  };
}

/**
 * Escuta o histórico recente em ordem cronológica.
 * Retorna a função de cancelamento do listener.
 */
export function escutarMensagens(chatId, aoAtualizar, { maximo = LIMITE_HISTORICO } = {}) {
  // Ordenamos por timestamp decrescente para pegar as N mais recentes e
  // invertemos no cliente — buscar as primeiras N traria o início da conversa.
  const q = query(
    collection(db, "chats", chatId, "mensagens"),
    orderBy("timestamp", "desc"),
    limit(maximo)
  );

  return onSnapshot(
    q,
    (snap) => {
      const lista = snap.docs.map(paraMensagem);
      lista.reverse();
      aoAtualizar(lista);
    },
    (err) => console.error("Erro ao escutar mensagens:", err)
  );
}

/**
 * Busca uma página de mensagens mais antigas que `antesDeMs`, pra alimentar o
 * "carregar mensagens anteriores" no topo da conversa. Diferente de
 * escutarMensagens(), isto é uma consulta única (getDocs), não um listener —
 * histórico antigo não muda, não precisa ficar sendo re-observado.
 *
 * Retorna em ordem cronológica (mais antiga primeiro), pronta pra ser
 * colocada na frente da lista já carregada.
 */
export async function carregarMensagensAntigas(chatId, antesDeMs, quantidade = TAMANHO_PAGINA_HISTORICO) {
  const q = query(
    collection(db, "chats", chatId, "mensagens"),
    orderBy("timestamp", "desc"),
    startAfter(Timestamp.fromMillis(antesDeMs)),
    limit(quantidade)
  );

  const snap = await getDocs(q);
  const lista = snap.docs.map(paraMensagem);
  lista.reverse();
  return lista;
}

/**
 * Apaga a conversa. Uma exclusão de documento no Firestore não remove a
 * subcoleção, então as mensagens saem em lotes antes do documento pai.
 * Vale tanto para chat direto quanto para grupo — apagar um grupo remove a
 * conversa para todo mundo (sair sem apagar fica para uma versão futura).
 */
export async function apagarChat(chatId) {
  const mensagens = collection(db, "chats", chatId, "mensagens");

  for (;;) {
    const lote = await getDocs(query(mensagens, orderBy("timestamp", "desc"), limit(300)));
    if (lote.empty) break;

    const batch = writeBatch(db);
    lote.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    if (lote.size < 300) break;
  }

  await deleteDoc(doc(db, "chats", chatId));
}