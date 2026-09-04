import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, collection, query,
  orderBy, limit, onSnapshot, getDocs, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { idDoChat, buscarPerfilPorUsername, paraMillis } from "./core.js";

// As mensagens ficam em chats/{id}/mensagens/{msgId}, uma por documento.
//
// Antes tudo era um array dentro de um único documento, com arrayUnion. Isso
// tinha dois problemas fatais: o documento estoura o limite de 1 MiB do
// Firestore e a conversa morre; e cada mensagem nova fazia o onSnapshot baixar
// o histórico inteiro de novo.

export const LIMITE_HISTORICO = 200;

/** Resumo curto exibido na lista de conversas. */
function resumo(tipo, texto) {
  switch (tipo) {
    case "audio": return "🎤 Mensagem de voz";
    case "imagem": return "📷 Foto";
    case "sistema": return texto;
    default: return texto;
  }
}

/**
 * Garante que o documento do chat existe, com os dois participantes e os dois
 * uids — os uids são o que as regras do Firestore usam para autorizar acesso.
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
    usuarios: [meu, outro].sort(),
    uids: [sessao.user.uid, perfilOutro.uid].sort(),
    criadoEm: serverTimestamp(),
    timestamp: serverTimestamp(),
    ultimaMensagem: "",
  });

  return { chatId, ref };
}

/**
 * Grava uma mensagem. O timestamp é o do servidor — o relógio do aparelho não
 * é confiável e as regras exigem request.time.
 */
export async function enviarMensagem(sessao, outroUsername, { texto, tipo = "texto" }) {
  const conteudo = String(texto || "").trim();
  if (!conteudo) return null;

  const { chatId, ref } = await garantirChat(sessao, outroUsername);

  const mensagem = {
    remetente: sessao.username,
    remetenteUid: sessao.user.uid,
    texto: conteudo,
    tipo,
    timestamp: serverTimestamp(),
  };

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

/** Mensagem automática do sistema (chamada perdida, recusada). */
export async function registrarEventoDeChamada(sessao, outroUsername, texto) {
  try {
    await enviarMensagem(sessao, outroUsername, { texto, tipo: "sistema" });
  } catch (err) {
    console.error("Não foi possível registrar o evento da chamada:", err);
  }
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
      const lista = snap.docs.map((d) => {
        const dados = d.data();
        return {
          id: d.id,
          ...dados,
          // Enquanto o servidor não confirma, timestamp vem null.
          timestampMs: paraMillis(dados.timestamp),
          pendente: dados.timestamp === null,
        };
      });
      lista.reverse();
      aoAtualizar(lista);
    },
    (err) => console.error("Erro ao escutar mensagens:", err)
  );
}

/**
 * Apaga a conversa. Uma exclusão de documento no Firestore não remove a
 * subcoleção, então as mensagens saem em lotes antes do documento pai.
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
