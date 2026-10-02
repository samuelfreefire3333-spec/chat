// Testes das regras do Firestore (firestore.rules) no emulador oficial.
//
// Rodar (precisa de Java 21+ e Node 22+):
//   cd testes/regras && npm ci && npm test
//
// Cada teste descreve um ataque (ou um uso normal que precisa continuar
// funcionando) e confere a resposta do emulador — é o mesmo motor de regras
// do Firestore de produção.

import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, query, where,
  limit, getDocs, serverTimestamp, Timestamp, deleteField,
} from "firebase/firestore";

const PROJETO = "demo-sinex-regras";
const GRUPO = "GrupoDeTeste00000001"; // 20 caracteres, como um ID automático
const UUID = "0b9d3a1c-6f0e-4c3b-9f9a-1c2d3e4f5a6b";
const DISPOSITIVO = "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CHAVE_PUBLICA = "B".repeat(87); // P-256 não comprimida em base64url

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJETO,
    firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8") },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await semear();
});

// --------------------------------------------------------------------------
// Pessoas e dados de partida
// --------------------------------------------------------------------------

const PESSOAS = {
  ana: "uidAna",
  bruno: "uidBruno",
  carla: "uidCarla",
  davi: "uidDavi",
};

function como(nome, extras = {}) {
  return env.authenticatedContext(PESSOAS[nome] || nome, {
    email: `${nome}@exemplo.com`,
    email_verified: true,
    ...extras,
  }).firestore();
}

const anonimo = () => env.unauthenticatedContext().firestore();
const admin = () => env.authenticatedContext("uidAdmin", { admin: true, email: "adm@exemplo.com" }).firestore();

async function semRegras(fn) {
  await env.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore()));
}

async function semear() {
  await semRegras(async (db) => {
    for (const [nome, uid] of Object.entries(PESSOAS)) {
      await setDoc(doc(db, "usuarios", nome), {
        usuario: nome, uid, nome: nome.toUpperCase(), foto: "", bio: "",
        dataCriacao: Timestamp.now(), lastSeen: 0,
      });
      await setDoc(doc(db, "contas", uid), { usuario: nome, email: `${nome}@exemplo.com`, criadoEm: Timestamp.now() });
    }
    // Perfil antigo, ainda sem uid (ligado pelo e-mail).
    await setDoc(doc(db, "usuarios", "antigo"), {
      usuario: "antigo", nome: "Antigo", email: "antigo@exemplo.com", foto: "", bio: "",
      dataCriacao: Timestamp.now(),
    });

    await setDoc(doc(db, "chats", "ana_bruno"), {
      tipo: "direto", usuarios: ["ana", "bruno"], uids: ["uidAna", "uidBruno"],
      criadoEm: Timestamp.now(), timestamp: Timestamp.now(), ultimaMensagem: "",
    });
    await setDoc(doc(db, "chats", "ana_bruno", "mensagens", "m1"), {
      remetente: "bruno", remetenteUid: "uidBruno", texto: "oi", tipo: "texto", timestamp: Timestamp.now(),
    });
    await setDoc(doc(db, "chats", GRUPO), {
      tipo: "grupo", nome: "Grupo", usuarios: ["ana", "bruno", "carla"], uids: ["uidAna", "uidBruno", "uidCarla"],
      criadoPor: "ana", criadoPorUid: "uidAna", criadoEm: Timestamp.now(), timestamp: Timestamp.now(),
      ultimaMensagem: "", ultimoRemetente: "",
    });
    await setDoc(doc(db, "chats", GRUPO, "mensagens", "g1"), {
      remetente: "carla", remetenteUid: "uidCarla", texto: "olá grupo", tipo: "texto", timestamp: Timestamp.now(),
    });
    // Conversa protegida (E2EE ligada).
    await setDoc(doc(db, "chats", "ana_carla"), {
      tipo: "direto", usuarios: ["ana", "carla"], uids: ["uidAna", "uidCarla"],
      criadoEm: Timestamp.now(), timestamp: Timestamp.now(), ultimaMensagem: "",
      e2ee: { ativo: true, ativadoPor: "uidAna", desde: Timestamp.now() },
    });
    await setDoc(doc(db, "seguidores", "bruno_ana"), {
      seguidor: "bruno", seguidorUid: "uidBruno", seguindo: "ana", criadoEm: Timestamp.now(),
    });
  });
}

function mensagemDeTexto(de, uid, texto = "olá") {
  return { remetente: de, remetenteUid: uid, texto, tipo: "texto", timestamp: serverTimestamp() };
}

function envelope() {
  return {
    v: 1, dispositivo: DISPOSITIVO, iv: "AAAAAAAAAAAAAAAA", ct: "Y2lmcmFkbw",
    chaves: { [DISPOSITIVO]: "enc.ct" }, sig: "c2ln",
  };
}

// ==========================================================================
// Autenticação
// ==========================================================================

test("sem login não lê nem escreve nada", async () => {
  const db = anonimo();
  await assertFails(getDoc(doc(db, "usuarios", "ana")));
  await assertFails(getDoc(doc(db, "chats", "ana_bruno")));
  await assertFails(getDocs(query(collection(db, "usuarios"), limit(10))));
  await assertFails(setDoc(doc(db, "usuarios", "intruso"), { usuario: "intruso" }));
});

test("coleção não declarada é negada", async () => {
  await assertFails(getDoc(doc(como("ana"), "chamadas", "x")));
  await assertFails(setDoc(doc(como("ana"), "qualquer", "x"), { a: 1 }));
});

// ==========================================================================
// Perfis e cadastro
// ==========================================================================

test("perfil: logado lê; busca só paginada (anti-raspagem)", async () => {
  const db = como("bruno");
  await assertSucceeds(getDoc(doc(db, "usuarios", "ana")));
  await assertSucceeds(getDocs(query(collection(db, "usuarios"), limit(50))));
  await assertFails(getDocs(query(collection(db, "usuarios"), limit(51))));
  await assertFails(getDocs(collection(db, "usuarios")));
});

function cadastro(db, uid, nome, extrasPerfil = {}, extrasConta = {}) {
  const lote = writeBatch(db);
  lote.set(doc(db, "usuarios", nome), {
    usuario: nome, uid, nome: "Nova Pessoa", foto: "", bio: "", // como o cadastro.js grava
    dataCriacao: serverTimestamp(), lastSeen: 0, ...extrasPerfil,
  });
  lote.set(doc(db, "contas", uid), { usuario: nome, email: `${nome}@exemplo.com`, criadoEm: serverTimestamp(), ...extrasConta });
  return lote.commit();
}

test("cadastro: perfil + conta no mesmo lote funciona", async () => {
  const db = env.authenticatedContext("uidNova", { email: "nova@exemplo.com" }).firestore();
  await assertSucceeds(cadastro(db, "uidNova", "nova"));
});

test("cadastro: sem foto ou com o avatar padrão antigo no campo foto", async () => {
  // Conta nova nasce com foto vazia; o caminho do avatar padrão, gravado
  // pelas versões anteriores do cadastro, continua aceito.
  const nova = env.authenticatedContext("uidNova", { email: "nova@exemplo.com" }).firestore();
  await assertSucceeds(cadastro(nova, "uidNova", "nova", { foto: "" }));
  const outra = env.authenticatedContext("uidOutra", { email: "outra@exemplo.com" }).firestore();
  await assertSucceeds(cadastro(outra, "uidOutra", "outra", { foto: "/assets/avatar-padrao.svg" }));
});

test("cadastro: não dá para nascer admin, com status ou com campo extra", async () => {
  const db = env.authenticatedContext("uidNova", { email: "nova@exemplo.com" }).firestore();
  await assertFails(cadastro(db, "uidNova", "nova", { status: "ativo" }));
  await assertFails(cadastro(db, "uidNova", "nova", { admin: true }));
  await assertFails(cadastro(db, "uidNova", "nova", { email: "nova@exemplo.com" })); // e-mail não vai ao perfil público
  await assertFails(cadastro(db, "uidNova", "nova", { dataCriacao: Timestamp.fromDate(new Date(2000, 0, 1)) }));
  await assertFails(cadastro(db, "uidNova", "nova", { foto: "https://rastreador.example/p.gif" }));
});

test("cadastro: perfil sem a conta (fora do lote) é recusado", async () => {
  const db = env.authenticatedContext("uidNova", { email: "nova@exemplo.com" }).firestore();
  await assertFails(setDoc(doc(db, "usuarios", "nova"), {
    usuario: "nova", uid: "uidNova", nome: "Nova", foto: "", bio: "", dataCriacao: serverTimestamp(), lastSeen: 0,
  }));
});

test("cadastro: uma conta não cria um segundo perfil", async () => {
  // Ana já tem contas/uidAna: um segundo @ para o mesmo uid é recusado.
  await assertFails(cadastro(como("ana"), "uidAna", "ana2"));
});

test("cadastro: não cria perfil com o uid de outra pessoa nem toma um @ existente", async () => {
  const db = env.authenticatedContext("uidNova", { email: "nova@exemplo.com" }).firestore();
  await assertFails(cadastro(db, "uidAna", "nova"));
  await assertFails(cadastro(db, "uidNova", "bruno"));
  await assertFails(cadastro(db, "uidNova", "Maiusculo"));
});

test("cadastro: e-mail da conta tem de ser o do token", async () => {
  const db = env.authenticatedContext("uidNova", { email: "nova@exemplo.com" }).firestore();
  await assertFails(cadastro(db, "uidNova", "nova", {}, { email: "outra@exemplo.com" }));
});

test("perfil: dono edita nome, bio e foto; não mexe em uid, @ ou status", async () => {
  const db = como("ana");
  await assertSucceeds(updateDoc(doc(db, "usuarios", "ana"), { nome: "Ana Maria", bio: "oi" }));
  await assertFails(updateDoc(doc(db, "usuarios", "ana"), { uid: "uidBruno" }));
  await assertFails(updateDoc(doc(db, "usuarios", "ana"), { usuario: "admin" }));
  await assertFails(updateDoc(doc(db, "usuarios", "ana"), { status: "ativo" }));
  await assertFails(updateDoc(doc(db, "usuarios", "ana"), { nome: "x".repeat(61) }));
  await assertFails(updateDoc(doc(db, "usuarios", "ana"), { foto: "https://evil.example/a.png" }));
});

test("perfil: foto só do próprio uid no bucket do projeto", async () => {
  const db = como("ana");
  const base = "https://firebasestorage.googleapis.com/v0/b/chat-parameuamor.firebasestorage.app/o/avatares%2F";
  await assertSucceeds(updateDoc(doc(db, "usuarios", "ana"), { foto: `${base}uidAna%2F${UUID}.jpg?alt=media&token=abc-123` }));
  await assertFails(updateDoc(doc(db, "usuarios", "ana"), { foto: `${base}uidBruno%2F${UUID}.jpg?alt=media&token=abc-123` }));
});

test("perfil: IDOR — ninguém edita o perfil de outra pessoa", async () => {
  await assertFails(updateDoc(doc(como("bruno"), "usuarios", "ana"), { nome: "hackeado" }));
  await assertFails(deleteDoc(doc(como("bruno"), "usuarios", "ana")));
});

test("perfil antigo: dono pelo e-mail só com e-mail verificado", async () => {
  const verificado = env.authenticatedContext("uidAntigo", { email: "antigo@exemplo.com", email_verified: true }).firestore();
  const naoVerificado = env.authenticatedContext("uidOutro", { email: "antigo@exemplo.com", email_verified: false }).firestore();
  await assertSucceeds(updateDoc(doc(verificado, "usuarios", "antigo"), { bio: "voltei" }));
  await assertFails(updateDoc(doc(naoVerificado, "usuarios", "antigo"), { bio: "tomei a conta" }));
});

test("admin: modera status e nome; não troca uid; não lê conversas", async () => {
  const db = admin();
  await assertSucceeds(updateDoc(doc(db, "usuarios", "bruno"), { status: "banido" }));
  await assertFails(updateDoc(doc(db, "usuarios", "bruno"), { status: "rei" }));
  await assertFails(updateDoc(doc(db, "usuarios", "bruno"), { uid: "uidAdmin" }));
  await assertFails(getDoc(doc(db, "chats", "ana_bruno")));
  await assertFails(getDocs(collection(db, "chats", "ana_bruno", "mensagens")));
});

// ==========================================================================
// contas/{uid} (dados privados)
// ==========================================================================

test("contas: só o dono lê; ninguém lista nem edita", async () => {
  await assertSucceeds(getDoc(doc(como("ana"), "contas", "uidAna")));
  await assertFails(getDoc(doc(como("bruno"), "contas", "uidAna")));
  await assertFails(getDocs(query(collection(como("ana"), "contas"), limit(1))));
  await assertFails(updateDoc(doc(como("ana"), "contas", "uidAna"), { usuario: "bruno" }));
  await assertFails(deleteDoc(doc(como("ana"), "contas", "uidAna")));
});

// ==========================================================================
// Seguidores
// ==========================================================================

test("seguidores: só segue em nome próprio e só perfis que existem", async () => {
  const db = como("ana");
  await assertSucceeds(setDoc(doc(db, "seguidores", "ana_bruno"), {
    seguidor: "ana", seguidorUid: "uidAna", seguindo: "bruno", criadoEm: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db, "seguidores", "carla_bruno"), {
    seguidor: "carla", seguidorUid: "uidAna", seguindo: "bruno", criadoEm: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db, "seguidores", "ana_fantasma"), {
    seguidor: "ana", seguidorUid: "uidAna", seguindo: "fantasma", criadoEm: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(db, "seguidores", "bruno_ana")));
  await assertSucceeds(deleteDoc(doc(como("bruno"), "seguidores", "bruno_ana")));
});

// ==========================================================================
// Chaves públicas (E2EE)
// ==========================================================================

function aparelho(extras = {}) {
  return { v: 1, kem: CHAVE_PUBLICA, sig: CHAVE_PUBLICA, nome: "Chrome", criadoEm: serverTimestamp(), ...extras };
}

test("chaves públicas: cada um publica só as suas; ninguém edita", async () => {
  await assertSucceeds(setDoc(doc(como("ana"), "chavesPublicas", "uidAna", "dispositivos", DISPOSITIVO), aparelho()));
  await assertFails(setDoc(doc(como("bruno"), "chavesPublicas", "uidAna", "dispositivos", UUID), aparelho()));
  await assertFails(setDoc(doc(como("ana"), "chavesPublicas", "uidAna", "dispositivos", UUID), aparelho({ kem: "curta" })));
  await assertFails(setDoc(doc(como("ana"), "chavesPublicas", "uidAna", "dispositivos", UUID), aparelho({ privada: "x" })));
  await assertFails(updateDoc(doc(como("ana"), "chavesPublicas", "uidAna", "dispositivos", DISPOSITIVO), { kem: CHAVE_PUBLICA }));
  await assertSucceeds(getDoc(doc(como("bruno"), "chavesPublicas", "uidAna", "dispositivos", DISPOSITIVO)));
  await assertFails(deleteDoc(doc(como("bruno"), "chavesPublicas", "uidAna", "dispositivos", DISPOSITIVO)));
  await assertSucceeds(deleteDoc(doc(como("ana"), "chavesPublicas", "uidAna", "dispositivos", DISPOSITIVO)));
});

// ==========================================================================
// Conversas — IDOR
// ==========================================================================

test("IDOR: quem não participa não lê a conversa nem as mensagens", async () => {
  const db = como("davi");
  await assertFails(getDoc(doc(db, "chats", "ana_bruno")));
  await assertFails(getDoc(doc(db, "chats", "ana_bruno", "mensagens", "m1")));
  await assertFails(getDocs(collection(db, "chats", "ana_bruno", "mensagens")));
  await assertFails(getDocs(query(collection(db, "chats"), where("uids", "array-contains", "uidAna"))));
  await assertFails(getDoc(doc(db, "chats", GRUPO)));
});

test("participante lê a conversa e lista as próprias conversas", async () => {
  const db = como("bruno");
  await assertSucceeds(getDoc(doc(db, "chats", "ana_bruno")));
  await assertSucceeds(getDocs(collection(db, "chats", "ana_bruno", "mensagens")));
  await assertSucceeds(getDocs(query(collection(db, "chats"), where("uids", "array-contains", "uidBruno"))));
});

test("conversa direta: só nasce honesta (par certo, uids dos perfis)", async () => {
  const db = como("ana");
  const base = {
    tipo: "direto", usuarios: ["ana", "davi"], uids: ["uidAna", "uidDavi"],
    criadoEm: serverTimestamp(), timestamp: serverTimestamp(), ultimaMensagem: "",
  };
  // Espionar a conversa de outras duas pessoas criando-a antes delas, com o
  // próprio uid junto:
  await assertFails(setDoc(doc(como("davi"), "chats", "bruno_carla"), {
    ...base, usuarios: ["bruno", "carla"], uids: ["uidBruno", "uidCarla", "uidDavi"],
  }));
  await assertFails(setDoc(doc(como("davi"), "chats", "bruno_carla"), {
    ...base, usuarios: ["bruno", "carla"], uids: ["uidBruno", "uidDavi"],
  }));
  // uid que não é o do perfil, ID fora de ordem, campo a mais:
  await assertFails(setDoc(doc(db, "chats", "ana_davi"), { ...base, uids: ["uidAna", "uidBruno"] }));
  await assertFails(setDoc(doc(db, "chats", "davi_ana"), base));
  await assertFails(setDoc(doc(db, "chats", "ana_davi"), { ...base, leituras: { uidDavi: Timestamp.now() } }));
  await assertFails(setDoc(doc(db, "chats", "ana_davi"), { ...base, e2ee: { ativo: true, ativadoPor: "uidAna", desde: serverTimestamp() } }));
  // O uso normal continua funcionando:
  await assertSucceeds(setDoc(doc(db, "chats", "ana_davi"), base));
});

test("grupo: 3 a 20 pessoas, criado por quem diz que criou", async () => {
  const db = como("ana");
  const base = {
    tipo: "grupo", nome: "Amigos", usuarios: ["ana", "bruno", "davi"], uids: ["uidAna", "uidBruno", "uidDavi"],
    criadoPor: "ana", criadoPorUid: "uidAna", criadoEm: serverTimestamp(), timestamp: serverTimestamp(),
    ultimaMensagem: "", ultimoRemetente: "",
  };
  await assertSucceeds(setDoc(doc(db, "chats", "AbCdEfGhIjKlMnOpQrSt"), base));
  await assertFails(setDoc(doc(db, "chats", "AbCdEfGhIjKlMnOpQrS2"), { ...base, criadoPor: "bruno" }));
  await assertFails(setDoc(doc(db, "chats", "AbCdEfGhIjKlMnOpQrS3"), { ...base, criadoPorUid: "uidBruno" }));
  await assertFails(setDoc(doc(db, "chats", "AbCdEfGhIjKlMnOpQrS4"), { ...base, usuarios: ["ana", "bruno"], uids: ["uidAna", "uidBruno"] }));
  await assertFails(setDoc(doc(db, "chats", "ana_bruno_davi"), base));
});

test("conversa: participantes não mudam e o resumo é honesto", async () => {
  const db = como("ana");
  const ref = doc(db, "chats", "ana_bruno");
  await assertSucceeds(updateDoc(ref, {
    ultimaMensagem: "oi", ultimoRemetente: "ana", ultimoTipo: "texto", timestamp: serverTimestamp(),
  }));
  await assertFails(updateDoc(ref, { uids: ["uidAna", "uidBruno", "uidDavi"] }));
  await assertFails(updateDoc(ref, {
    ultimaMensagem: "oi", ultimoRemetente: "bruno", ultimoTipo: "texto", timestamp: serverTimestamp(),
  }));
  await assertFails(updateDoc(ref, {
    ultimaMensagem: "oi", ultimoRemetente: "ana", ultimoTipo: "texto", timestamp: Timestamp.fromDate(new Date(2099, 0, 1)),
  }));
  await assertFails(updateDoc(ref, {
    ultimaMensagem: "Mensagem oficial do suporte", ultimoRemetente: "ana", ultimoTipo: "sistema", timestamp: serverTimestamp(),
  }));
});

test("conversa: cada um grava só a própria marca de leitura", async () => {
  const db = como("ana");
  const ref = doc(db, "chats", "ana_bruno");
  await assertSucceeds(updateDoc(ref, { "leituras.uidAna": Timestamp.now() }));
  await assertFails(updateDoc(ref, { "leituras.uidBruno": Timestamp.now() }));
  await assertFails(updateDoc(ref, { "entregas.uidAna": "ontem" }));
  await assertFails(updateDoc(ref, { "leituras.uidAna": Timestamp.fromDate(new Date(2099, 0, 1)) }));
});

test("E2EE: liga uma vez, só em conversa direta, e não desliga", async () => {
  const ligar = { e2ee: { ativo: true, ativadoPor: "uidAna", desde: serverTimestamp() } };
  // Ligar em nome de outra pessoa, ou num grupo: não.
  await assertFails(updateDoc(doc(como("bruno"), "chats", "ana_bruno"), ligar));
  await assertFails(updateDoc(doc(como("ana"), "chats", GRUPO), ligar));
  await assertSucceeds(updateDoc(doc(como("ana"), "chats", "ana_bruno"), ligar));
  // Religar (trocar quem ativou/quando) ou desligar: não.
  await assertFails(updateDoc(doc(como("ana"), "chats", "ana_bruno"), ligar));
  await assertFails(updateDoc(doc(como("ana"), "chats", "ana_carla"), { e2ee: deleteField() }));
  await assertFails(updateDoc(doc(como("ana"), "chats", "ana_carla"), { e2ee: { ativo: false, ativadoPor: "uidAna", desde: serverTimestamp() } }));
});

test("E2EE: numa conversa protegida o resumo nunca carrega o texto", async () => {
  const ref = doc(como("carla"), "chats", "ana_carla");
  await assertSucceeds(updateDoc(ref, {
    ultimaMensagem: "🔒 Mensagem protegida", ultimoRemetente: "carla", ultimoTipo: "cifrada", timestamp: serverTimestamp(),
  }));
  await assertFails(updateDoc(ref, {
    ultimaMensagem: "segredo em claro", ultimoRemetente: "carla", ultimoTipo: "cifrada", timestamp: serverTimestamp(),
  }));
});

test("apagar: direta por qualquer um dos dois; grupo só por quem criou", async () => {
  await assertFails(deleteDoc(doc(como("bruno"), "chats", GRUPO)));
  await assertFails(deleteDoc(doc(como("bruno"), "chats", GRUPO, "mensagens", "g1")));
  await assertFails(deleteDoc(doc(como("davi"), "chats", "ana_bruno")));
  await assertSucceeds(deleteDoc(doc(como("ana"), "chats", GRUPO, "mensagens", "g1")));
  await assertSucceeds(deleteDoc(doc(como("ana"), "chats", GRUPO)));
  await assertSucceeds(deleteDoc(doc(como("bruno"), "chats", "ana_bruno", "mensagens", "m1")));
  await assertSucceeds(deleteDoc(doc(como("bruno"), "chats", "ana_bruno")));
});

// ==========================================================================
// Mensagens
// ==========================================================================

test("mensagem: ninguém escreve em nome de outra pessoa", async () => {
  const msgs = collection(como("ana"), "chats", "ana_bruno", "mensagens");
  await assertSucceeds(setDoc(doc(msgs), mensagemDeTexto("ana", "uidAna")));
  await assertFails(setDoc(doc(msgs), mensagemDeTexto("bruno", "uidAna")));
  await assertFails(setDoc(doc(msgs), mensagemDeTexto("ana", "uidBruno")));
  await assertFails(setDoc(doc(msgs), mensagemDeTexto("admin", "uidAna")));
  await assertFails(setDoc(doc(collection(como("davi"), "chats", "ana_bruno", "mensagens")), mensagemDeTexto("davi", "uidDavi")));
});

test("mensagem: hora do servidor, campos fechados, tamanho limitado", async () => {
  const msgs = collection(como("ana"), "chats", "ana_bruno", "mensagens");
  await assertFails(setDoc(doc(msgs), { ...mensagemDeTexto("ana", "uidAna"), timestamp: Timestamp.fromDate(new Date(2099, 0, 1)) }));
  await assertFails(setDoc(doc(msgs), { ...mensagemDeTexto("ana", "uidAna"), lida: true }));
  await assertFails(setDoc(doc(msgs), mensagemDeTexto("ana", "uidAna", "x".repeat(8001))));
  await assertFails(setDoc(doc(msgs), mensagemDeTexto("ana", "uidAna", "")));
  await assertFails(setDoc(doc(msgs), { ...mensagemDeTexto("ana", "uidAna"), tipo: "html" }));
});

test("mensagem de sistema: só os avisos de chamada", async () => {
  const msgs = collection(como("ana"), "chats", "ana_bruno", "mensagens");
  const sistema = (texto) => ({ remetente: "ana", remetenteUid: "uidAna", texto, tipo: "sistema", timestamp: serverTimestamp() });
  await assertSucceeds(setDoc(doc(msgs), sistema("📞 Chamada de voz · 01:23")));
  await assertSucceeds(setDoc(doc(msgs), sistema("📹 Chamada de vídeo não atendida")));
  await assertFails(setDoc(doc(msgs), sistema("⚠️ Sua conta será bloqueada. Envie sua senha ao suporte.")));
});

test("mídia: só caminho privado DESTA conversa e DE QUEM ENVIA — nunca link", async () => {
  const msgs = collection(como("ana"), "chats", "ana_bruno", "mensagens");
  const imagem = (midia) => ({ remetente: "ana", remetenteUid: "uidAna", texto: "", tipo: "imagem", timestamp: serverTimestamp(), midia });
  await assertSucceeds(setDoc(doc(msgs), imagem({ caminho: `midia/ana_bruno/uidAna/${UUID}`, mime: "image/jpeg", tamanho: 1000, largura: 10, altura: 10 })));
  await assertFails(setDoc(doc(msgs), { remetente: "ana", remetenteUid: "uidAna", tipo: "imagem", timestamp: serverTimestamp(), texto: "https://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media&token=z" }));
  await assertFails(setDoc(doc(msgs), imagem({ caminho: `midia/bruno_carla/uidAna/${UUID}`, mime: "image/jpeg" })));
  await assertFails(setDoc(doc(msgs), imagem({ caminho: `midia/ana_bruno/uidBruno/${UUID}`, mime: "image/jpeg" })));
  await assertFails(setDoc(doc(msgs), imagem({ caminho: `midia/ana_bruno/uidAna/../../x`, mime: "image/jpeg" })));
  await assertFails(setDoc(doc(msgs), imagem({ caminho: `midia/ana_bruno/uidAna/${UUID}`, mime: "text/html" })));
  await assertFails(setDoc(doc(msgs), imagem({ caminho: `midia/ana_bruno/uidAna/${UUID}`, mime: "image/svg+xml" })));
});

test("conversa protegida: texto em claro é recusado; envelope cifrado passa", async () => {
  const msgs = collection(como("carla"), "chats", "ana_carla", "mensagens");
  await assertFails(setDoc(doc(msgs), mensagemDeTexto("carla", "uidCarla", "segredo")));
  await assertSucceeds(setDoc(doc(msgs), {
    remetente: "carla", remetenteUid: "uidCarla", tipo: "cifrada", timestamp: serverTimestamp(), e2ee: envelope(),
  }));
  await assertFails(setDoc(doc(msgs), {
    remetente: "carla", remetenteUid: "uidCarla", tipo: "cifrada", timestamp: serverTimestamp(), e2ee: envelope(),
    respostaTexto: "trecho em claro",
  }));
  // Envelope numa conversa comum não faz sentido (ninguém tem a chave).
  await assertFails(setDoc(doc(collection(como("ana"), "chats", "ana_bruno", "mensagens")), {
    remetente: "ana", remetenteUid: "uidAna", tipo: "cifrada", timestamp: serverTimestamp(), e2ee: envelope(),
  }));
});

test("mensagem enviada não se reescreve; reação só a própria", async () => {
  const ref = doc(como("ana"), "chats", "ana_bruno", "mensagens", "m1");
  await assertFails(updateDoc(ref, { texto: "editado pela Ana" }));
  await assertSucceeds(updateDoc(ref, { "reacoes.uidAna": "❤️" }));
  await assertFails(updateDoc(ref, { "reacoes.uidBruno": "👍" }));
  await assertFails(updateDoc(ref, { "reacoes.uidAna": "x".repeat(17) }));
  await assertSucceeds(updateDoc(ref, { "reacoes.uidAna": deleteField() }));
});
