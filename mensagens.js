import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, collection, query,
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
//
// Confirmações de entrega e leitura moram no documento do chat, e não em cada
// mensagem (mensagem enviada não se reescreve):
//   entregas.{uid} = Timestamp da mensagem mais recente que chegou ao aparelho
//   leituras.{uid} = Timestamp da mensagem mais recente que a pessoa viu
// Uma mensagem com timestamp T foi entregue/lida por alguém quando a marca
// dessa pessoa é >= T. É uma escrita por conversa aberta, não uma por mensagem.

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

  let atual = null;
  try {
    atual = await getDoc(ref);
  } catch (err) {
    // As regras publicadas em 17/09/2026 leem resource.data.uids também num
    // documento que ainda não existe — e isso é erro, que o Firestore devolve
    // como "permission-denied" em vez de "não existe". Era por isso que
    // começar uma conversa com alguém novo falhava com "Missing or
    // insufficient permissions".
    //
    // Quem participa da conversa nunca tem esta leitura negada. Então, aqui,
    // negado quer dizer "ainda não existe" — ou "existe e é de outras
    // pessoas", caso em que a criação logo abaixo também é negada e o erro
    // chega a quem chamou.
    if (err?.code !== "permission-denied") throw err;
  }
  if (atual?.exists()) return { chatId, ref };

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
 * Escuta o documento do chat — é dele que vêm as confirmações de entrega e
 * leitura. Retorna a função de cancelamento.
 */
export function escutarChat(chatId, aoAtualizar, aoErro) {
  return onSnapshot(
    doc(db, "chats", chatId),
    (snap) => aoAtualizar(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    (err) => {
      console.error("Erro ao escutar o chat:", err);
      aoErro?.(err);
    }
  );
}

/**
 * Grava uma mensagem num chat já resolvido (chatId + ref do documento pai).
 * Usada tanto pelo envio direto quanto pelo envio em grupo — a diferença
 * entre os dois está só em como o chat foi resolvido antes de chegar aqui.
 *
 * Mensagem e resumo do chat vão num lote só: ou os dois são gravados, ou
 * nenhum. E, no mesmo lote, os dois serverTimestamp() recebem exatamente o
 * mesmo horário — é isso que permite à caixa de entrada saber se a última
 * mensagem já foi lida comparando só o documento do chat.
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

  const refMensagem = doc(collection(db, "chats", chatId, "mensagens"));
  const lote = writeBatch(db);
  lote.set(refMensagem, mensagem);
  // Resumo no documento pai, para a caixa de entrada não precisar ler as
  // mensagens de cada conversa.
  lote.update(ref, {
    ultimaMensagem: resumo(tipo, conteudo).slice(0, 120),
    ultimoRemetente: sessao.username,
    ultimoTipo: tipo,
    timestamp: serverTimestamp(),
  });
  await lote.commit();

  return { id: refMensagem.id, chatId };
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

/** Mensagem automática do sistema (chamada perdida, recusada, encerrada). */
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

// ==========================================================================
// CONFIRMAÇÕES DE ENTREGA E LEITURA
// ==========================================================================

function marca(chat, campo, uid) {
  return paraMillis(chat?.[campo]?.[uid]);
}

/** Marca de entrega de alguém, considerando que ler implica ter recebido. */
function entregaDe(chat, uid) {
  return Math.max(marca(chat, "entregas", uid), marca(chat, "leituras", uid));
}

/**
 * Estado de uma mensagem MINHA com timestamp msgMs:
 *   "enviada"  — o servidor gravou;
 *   "entregue" — chegou ao aparelho de todos os outros participantes;
 *   "lida"     — todos os outros participantes viram.
 * Em grupo vale a regra dos mensageiros conhecidos: só fica "lida" quando
 * todo mundo leu.
 */
export function estadoDoRecibo(msgMs, chat, meuUid) {
  if (!chat || !msgMs) return "enviada";
  const outros = (chat.uids || []).filter((u) => u !== meuUid);
  if (!outros.length) return "enviada";
  if (outros.every((u) => marca(chat, "leituras", u) >= msgMs)) return "lida";
  if (outros.every((u) => entregaDe(chat, u) >= msgMs)) return "entregue";
  return "enviada";
}

/** Quantos dos outros participantes já leram até msgMs (para grupos). */
export function quantosLeram(msgMs, chat, meuUid) {
  if (!chat || !msgMs) return 0;
  return (chat.uids || []).filter((u) => u !== meuUid && marca(chat, "leituras", u) >= msgMs).length;
}

// Últimas marcas gravadas por esta aba. O snapshot do chat demora um
// instante para refletir a própria escrita, e sem isto a mesma marca era
// gravada duas ou três vezes seguidas.
const marcasGravadas = new Map(); // chatId -> { entregue, lido }

/**
 * Avança as marcas desta pessoa num chat. Nunca retrocede e não escreve
 * nada se não houver avanço. entregueAte/lidoAte são Timestamps do
 * Firestore (o horário de servidor de uma mensagem que chegou).
 */
export async function marcarRecibos(sessao, chatId, chatAtual, { entregueAte = null, lidoAte = null } = {}) {
  const uid = sessao?.user?.uid;
  if (!uid || !chatId) return false;

  const gravadas = marcasGravadas.get(chatId) || { entregue: 0, lido: 0 };
  const jaEntregue = Math.max(entregaDe(chatAtual, uid), gravadas.entregue);
  const jaLido = Math.max(marca(chatAtual, "leituras", uid), gravadas.lido);

  // Ler implica ter recebido.
  let entrega = entregueAte;
  if (lidoAte && paraMillis(lidoAte) > paraMillis(entrega)) entrega = lidoAte;

  const campos = {};
  if (entrega && paraMillis(entrega) > jaEntregue) campos[`entregas.${uid}`] = entrega;
  if (lidoAte && paraMillis(lidoAte) > jaLido) campos[`leituras.${uid}`] = lidoAte;
  if (!Object.keys(campos).length) return false;

  marcasGravadas.set(chatId, {
    entregue: Math.max(gravadas.entregue, paraMillis(entrega)),
    lido: Math.max(gravadas.lido, paraMillis(lidoAte)),
  });

  try {
    await updateDoc(doc(db, "chats", chatId), campos);
    return true;
  } catch (err) {
    // Deixa tentar de novo na próxima oportunidade.
    marcasGravadas.set(chatId, gravadas);
    console.warn("Não foi possível gravar a confirmação de leitura:", err?.code || err);
    return false;
  }
}

/**
 * Chegou o aviso (WebSocket) de mensagem nova numa conversa que não está
 * aberta: marca como entregue usando o horário gravado no próprio chat.
 */
export async function marcarEntregueDoAviso(sessao, chatId) {
  if (!sessao || !chatId) return;
  try {
    const chat = await obterChat(chatId);
    if (!chat || chat.ultimoRemetente === sessao.username || !chat.timestamp) return;
    await marcarRecibos(sessao, chatId, chat, { entregueAte: chat.timestamp });
  } catch (err) {
    console.warn("Não foi possível confirmar a entrega:", err?.code || err);
  }
}

/**
 * Converte um QueryDocumentSnapshot de mensagem no formato que a UI usa.
 *
 * serverTimestamps: "estimate" faz o SDK devolver uma estimativa local
 * enquanto o servidor não confirma o horário. Sem isso o campo vinha null, a
 * mensagem recém-enviada ficava com timestamp 0 e caía para o começo da
 * ordenação — numa conversa com mais de LIMITE_HISTORICO mensagens ela
 * simplesmente não aparecia até o servidor responder.
 *
 * "pendente" passa a vir de metadata.hasPendingWrites, que é a informação
 * correta para isso (com a estimativa ligada, o timestamp nunca mais é null).
 */
function paraMensagem(d) {
  const dados = d.data({ serverTimestamps: "estimate" });
  return {
    id: d.id,
    ...dados,
    timestampMs: paraMillis(dados.timestamp),
    pendente: d.metadata.hasPendingWrites,
  };
}

/**
 * Escuta o histórico recente em ordem cronológica.
 * Retorna a função de cancelamento do listener.
 */
export function escutarMensagens(chatId, aoAtualizar, { maximo = LIMITE_HISTORICO, aoErro = null } = {}) {
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
    (err) => {
      console.error("Erro ao escutar mensagens:", err);
      aoErro?.(err);
    }
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
