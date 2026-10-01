// ==========================================================================
// Criptografia de ponta a ponta — integração (aparelho, chaves, conversas)
// ==========================================================================
// O núcleo criptográfico está em e2ee-cripto.js. Aqui:
//   - as chaves do aparelho ficam no IndexedDB deste navegador, como
//     CryptoKey NÃO EXTRAÍVEL (nem script da página lê os bytes da privada);
//   - só as chaves PÚBLICAS vão para o Firestore
//     (chavesPublicas/{uid}/dispositivos/{id});
//   - cada mensagem de conversa protegida é cifrada para todos os aparelhos
//     das duas pessoas no momento do envio;
//   - o número de segurança permite conferir, fora do app, que ninguém trocou
//     as chaves no caminho; se as chaves de alguém mudarem depois de
//     verificadas, o app avisa.
//
// Modelo de ameaça e limitações: SEGURANCA.md.

import { db } from "./firebase.js";
import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, query, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  gerarChavesDoAparelho, importarChaveKem, importarChaveDeAssinatura, cifrarMensagem,
  decifrarMensagem, validarConteudo, numeroDeSeguranca, resumoDosAparelhos, ErroE2EE,
} from "./e2ee-cripto.js";
import { idAleatorio } from "./midia-validacao.js";

export { ErroE2EE };

const NOME_BANCO = "sinex-e2ee";
const VERSAO_BANCO = 1;
const MAXIMO_APARELHOS = 20;
const VALIDADE_LISTA = 60 * 1000;
const RE_ID = /^[A-Za-z0-9-]{36}$/;
const RE_CHAVE = /^[A-Za-z0-9_-]{80,100}$/;

// --------------------------------------------------------------------------
// IndexedDB
// --------------------------------------------------------------------------

let promessaBanco = null;

function abrirBanco() {
  if (promessaBanco) return promessaBanco;
  promessaBanco = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new ErroE2EE("sem-armazenamento", "Este navegador não guarda chaves com segurança (modo privado?)."));
      return;
    }
    const pedido = indexedDB.open(NOME_BANCO, VERSAO_BANCO);
    pedido.onupgradeneeded = () => {
      const banco = pedido.result;
      if (!banco.objectStoreNames.contains("aparelhos")) banco.createObjectStore("aparelhos", { keyPath: "uid" });
      if (!banco.objectStoreNames.contains("contatos")) banco.createObjectStore("contatos", { keyPath: "uid" });
      if (!banco.objectStoreNames.contains("chavesVistas")) banco.createObjectStore("chavesVistas", { keyPath: "chave" });
    };
    pedido.onsuccess = () => resolve(pedido.result);
    pedido.onerror = () => reject(new ErroE2EE("sem-armazenamento", "Não foi possível abrir o armazenamento de chaves."));
  });
  promessaBanco.catch(() => { promessaBanco = null; });
  return promessaBanco;
}

async function operacao(loja, modo, fn) {
  const banco = await abrirBanco();
  return new Promise((resolve, reject) => {
    const t = banco.transaction(loja, modo);
    const pedido = fn(t.objectStore(loja));
    t.oncomplete = () => resolve(pedido?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const ler = (loja, chave) => operacao(loja, "readonly", (s) => s.get(chave));
const gravar = (loja, valor) => operacao(loja, "readwrite", (s) => s.put(valor));
const apagar = (loja, chave) => operacao(loja, "readwrite", (s) => s.delete(chave));

// --------------------------------------------------------------------------
// Este aparelho
// --------------------------------------------------------------------------

function nomeDoAparelho() {
  const ua = navigator.userAgent || "";
  const navegador = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const sistema = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return (sistema ? `${navegador} no ${sistema}` : navegador).slice(0, 60);
}

function refDoAparelho(uid, id) {
  return doc(db, "chavesPublicas", uid, "dispositivos", id);
}

/** Aparelho já criado neste navegador para a conta (ou null). */
export async function aparelhoAtual(sessao) {
  try {
    return (await ler("aparelhos", sessao.user.uid)) || null;
  } catch (_) {
    return null;
  }
}

async function comTrava(fn) {
  // Duas abas abrindo ao mesmo tempo não podem criar dois aparelhos.
  if (navigator.locks?.request) return navigator.locks.request("sinex-e2ee-aparelho", fn);
  return fn();
}

/**
 * Garante que este navegador tem chaves e que a parte pública está
 * publicada. Se o documento público sumiu (aparelho removido em "Sair de
 * todos os aparelhos"), as chaves antigas são descartadas e nasce outro
 * aparelho — mensagens cifradas para o antigo não voltam.
 */
export function garantirAparelho(sessao) {
  return comTrava(async () => {
    const uid = sessao.user.uid;
    let ap = await ler("aparelhos", uid);

    if (ap) {
      let publicado = null;
      try {
        publicado = await getDoc(refDoAparelho(uid, ap.id));
      } catch (err) {
        // Sem rede: segue com a chave local; publica na próxima.
        if (err?.code === "unavailable") return ap;
        throw err;
      }
      if (publicado.exists()) {
        const d = publicado.data();
        if (d.kem === ap.publicas.kem && d.sig === ap.publicas.sig) {
          if (!ap.publicado) {
            ap.publicado = true;
            await gravar("aparelhos", ap);
          }
          return ap;
        }
      } else if (!ap.publicado) {
        await publicar(uid, ap);
        return ap;
      }
      // Revogado em outro aparelho, ou documento que não é o nosso.
      await apagar("aparelhos", uid);
      ap = null;
    }

    const chaves = await gerarChavesDoAparelho();
    ap = { uid, id: idAleatorio(), kem: chaves.kem, sig: chaves.sig, publicas: chaves.publicas, criadoEm: Date.now(), publicado: false };
    await gravar("aparelhos", ap);
    await publicar(uid, ap);
    return ap;
  });
}

async function publicar(uid, ap) {
  await setDoc(refDoAparelho(uid, ap.id), {
    v: 1,
    kem: ap.publicas.kem,
    sig: ap.publicas.sig,
    nome: nomeDoAparelho(),
    criadoEm: serverTimestamp(),
  });
  ap.publicado = true;
  await gravar("aparelhos", ap);
  cacheDeAparelhos.delete(uid);
}

// --------------------------------------------------------------------------
// Aparelhos das pessoas
// --------------------------------------------------------------------------

const cacheDeAparelhos = new Map(); // uid -> { lidoEm, lista }

/** Aparelhos (chaves públicas) de uma conta. */
export async function listarAparelhos(uid, { forcar = false } = {}) {
  const emCache = cacheDeAparelhos.get(uid);
  if (!forcar && emCache && Date.now() - emCache.lidoEm < VALIDADE_LISTA) return emCache.lista;

  const snap = await getDocs(query(collection(db, "chavesPublicas", uid, "dispositivos"), limit(MAXIMO_APARELHOS)));
  const lista = [];
  snap.forEach((d) => {
    const dados = d.data();
    if (RE_ID.test(d.id) && dados.v === 1 && RE_CHAVE.test(dados.kem || "") && RE_CHAVE.test(dados.sig || "")) {
      lista.push({ id: d.id, kem: dados.kem, sig: dados.sig, nome: String(dados.nome || "").slice(0, 60), criadoEm: dados.criadoEm || null });
    }
  });
  cacheDeAparelhos.set(uid, { lidoEm: Date.now(), lista });

  // Guarda as chaves vistas: se o aparelho for removido depois, as mensagens
  // antigas dele continuam verificáveis por quem já as viu.
  for (const a of lista) {
    gravar("chavesVistas", { chave: `${uid}/${a.id}`, kem: a.kem, sig: a.sig }).catch(() => {});
  }
  return lista;
}

async function chaveDeAssinaturaDoRemetente(uid, dispositivo) {
  let lista = await listarAparelhos(uid);
  let achado = lista.find((a) => a.id === dispositivo);
  if (!achado) {
    lista = await listarAparelhos(uid, { forcar: true });
    achado = lista.find((a) => a.id === dispositivo);
  }
  if (!achado) {
    achado = await ler("chavesVistas", `${uid}/${dispositivo}`).catch(() => null);
  }
  if (!achado) throw new ErroE2EE("remetente-desconhecido", "Não foi possível confirmar de qual aparelho esta mensagem veio.");
  return importarChaveDeAssinatura(achado.sig);
}

// --------------------------------------------------------------------------
// Verificação (número de segurança) e troca de chaves
// --------------------------------------------------------------------------

async function lerContato(uid) {
  return (await ler("contatos", uid).catch(() => null)) || { uid, verificado: false, resumo: null };
}

/**
 * Estado da confiança nas chaves de outra pessoa:
 *   { verificado, mudou }  — "mudou" quando as chaves são diferentes das que
 *   estavam lá na última vez (verificadas ou não).
 */
export async function estadoDoContato(uid) {
  const contato = await lerContato(uid);
  const aparelhos = await listarAparelhos(uid);
  const resumo = await resumoDosAparelhos(aparelhos);
  const mudou = !!contato.resumo && contato.resumo !== resumo;
  if (!contato.resumo) {
    contato.resumo = resumo;
    await gravar("contatos", contato).catch(() => {});
  }
  return { verificado: contato.verificado && !mudou, mudou, aparelhos: aparelhos.length };
}

/** Aceita as chaves atuais (sem verificar) — apaga o aviso de "mudou". */
export async function aceitarChavesAtuais(uid) {
  const aparelhos = await listarAparelhos(uid, { forcar: true });
  await gravar("contatos", { uid, verificado: false, resumo: await resumoDosAparelhos(aparelhos) });
}

export async function marcarVerificado(uid, verificado = true) {
  const aparelhos = await listarAparelhos(uid, { forcar: true });
  await gravar("contatos", { uid, verificado, resumo: await resumoDosAparelhos(aparelhos), verificadoEm: Date.now() });
}

/** Número de segurança entre a sessão e outra pessoa (60 dígitos). */
export async function numeroDaConversa(sessao, outroUid) {
  const ap = await garantirAparelho(sessao);
  const meus = await listarAparelhos(sessao.user.uid, { forcar: true });
  if (!meus.some((a) => a.id === ap.id)) meus.push({ id: ap.id, ...ap.publicas });
  const deles = await listarAparelhos(outroUid, { forcar: true });
  if (!deles.length) throw new ErroE2EE("sem-aparelho-do-outro", "A outra pessoa ainda não tem chaves.");
  return numeroDeSeguranca(sessao.user.uid, meus, outroUid, deles);
}

// --------------------------------------------------------------------------
// Conversas
// --------------------------------------------------------------------------

/**
 * Liga a proteção numa conversa direta. As regras só aceitam ligar (nunca
 * desligar), e só pelo próprio participante.
 */
export async function ativarProtecao(sessao, chatId, outroUid) {
  await garantirAparelho(sessao);
  const deles = await listarAparelhos(outroUid, { forcar: true });
  if (!deles.length) {
    throw new ErroE2EE("sem-aparelho-do-outro", "A outra pessoa precisa abrir a versão nova do app uma vez antes.");
  }
  await updateDoc(doc(db, "chats", chatId), {
    e2ee: { ativo: true, ativadoPor: sessao.user.uid, desde: serverTimestamp() },
  });
}

/**
 * Cifra o conteúdo para todos os aparelhos das pessoas da conversa.
 * Devolve o envelope para o campo "e2ee" da mensagem.
 */
export async function cifrarParaConversa(sessao, chat, conteudo) {
  const ap = await garantirAparelho(sessao);
  const meuUid = sessao.user.uid;
  const uids = [meuUid, ...(chat.uids || []).filter((u) => u !== meuUid)];

  const destinatarios = [];
  for (const uid of uids) {
    const lista = await listarAparelhos(uid);
    if (uid !== meuUid && !lista.length) {
      throw new ErroE2EE("sem-aparelho-do-outro", "A outra pessoa não tem nenhum aparelho com chaves.");
    }
    for (const a of lista) destinatarios.push({ id: a.id, kem: await importarChaveKem(a.kem) });
  }
  if (!destinatarios.some((d) => d.id === ap.id)) {
    destinatarios.push({ id: ap.id, kem: await importarChaveKem(ap.publicas.kem) });
  }

  return cifrarMensagem({
    cabecalho: { chatId: chat.id, remetenteUid: meuUid, dispositivo: ap.id },
    conteudo,
    destinatarios,
    aparelho: { id: ap.id, sig: ap.sig },
  });
}

const decifradas = new Map(); // id da mensagem -> Promise<conteúdo>

/** Abre uma mensagem "cifrada". O resultado já passou por validarConteudo. */
export function decifrarDaConversa(sessao, chatId, msg) {
  const chave = `${chatId}/${msg.id}`;
  if (decifradas.has(chave)) return decifradas.get(chave);

  const promessa = (async () => {
    const ap = await aparelhoAtual(sessao);
    if (!ap) throw new ErroE2EE("sem-aparelho", "Este aparelho ainda não tem chaves.");
    const e = msg.e2ee;
    if (!e || !RE_ID.test(e.dispositivo || "")) throw new ErroE2EE("envelope", "Mensagem protegida malformada.");
    const chaveDoRemetente = await chaveDeAssinaturaDoRemetente(msg.remetenteUid, e.dispositivo);
    const conteudo = await decifrarMensagem({
      cabecalho: { chatId, remetenteUid: msg.remetenteUid, dispositivo: e.dispositivo },
      envelope: e,
      aparelho: { id: ap.id, kem: ap.kem },
      chaveDoRemetente,
    });
    return validarConteudo(conteudo);
  })();
  decifradas.set(chave, promessa);
  if (decifradas.size > 2000) decifradas.delete(decifradas.keys().next().value);
  return promessa;
}

// --------------------------------------------------------------------------
// Revogação
// --------------------------------------------------------------------------

/** Remove as chaves deste navegador e o registro público dele (ao sair). */
export async function revogarEsteAparelho(sessao) {
  const uid = sessao.user.uid;
  const ap = await aparelhoAtual(sessao);
  if (ap) {
    try { await deleteDoc(refDoAparelho(uid, ap.id)); } catch (err) { console.warn("Não foi possível remover a chave pública:", err?.code || err); }
    await apagar("aparelhos", uid).catch(() => {});
  }
  cacheDeAparelhos.clear();
  decifradas.clear();
}

/** Remove das listas públicas todos os aparelhos da conta, menos este. */
export async function revogarOutrosAparelhos(sessao) {
  const uid = sessao.user.uid;
  const ap = await aparelhoAtual(sessao);
  const lista = await listarAparelhos(uid, { forcar: true });
  let removidos = 0;
  for (const a of lista) {
    if (ap && a.id === ap.id) continue;
    await deleteDoc(refDoAparelho(uid, a.id));
    removidos++;
  }
  cacheDeAparelhos.delete(uid);
  return removidos;
}
