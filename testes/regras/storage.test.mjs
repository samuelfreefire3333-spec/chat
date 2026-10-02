// Testes das regras do Storage (storage.rules) no emulador oficial.
// A regra de mídia consulta o Firestore (participante da conversa), por isso
// os dois emuladores sobem juntos. Rodar: cd testes/regras && npm test

import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from "@firebase/rules-unit-testing";
import { doc, setDoc, Timestamp } from "firebase/firestore";
import { ref, uploadBytes, getBytes, deleteObject, listAll } from "firebase/storage";

const PROJETO = "demo-sinex-regras";
const UUID = "0b9d3a1c-6f0e-4c3b-9f9a-1c2d3e4f5a6b";
const OUTRO_UUID = "5d6e7f80-1a2b-4c3d-9e8f-7a6b5c4d3e2f";
const EXISTENTE = `midia/ana_bruno/uidAna/${OUTRO_UUID}`;

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJETO,
    firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8") },
    storage: { rules: readFileSync(new URL("../../storage.rules", import.meta.url), "utf8") },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "chats", "ana_bruno"), {
      tipo: "direto", usuarios: ["ana", "bruno"], uids: ["uidAna", "uidBruno"],
      criadoEm: Timestamp.now(), timestamp: Timestamp.now(), ultimaMensagem: "",
    });
    await uploadBytes(ref(ctx.storage(), EXISTENTE), jpeg(), { contentType: "image/jpeg" });
  });
});

const armazenamento = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();

function jpeg(tamanho = 2048) {
  const b = new Uint8Array(tamanho);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

const enviar = (uid, caminho, bytes, contentType) => uploadBytes(ref(armazenamento(uid), caminho), bytes, { contentType });

// ==========================================================================
// Mídia das conversas
// ==========================================================================

test("participante envia foto para a pasta dele na conversa", async () => {
  await assertSucceeds(enviar("uidAna", `midia/ana_bruno/uidAna/${UUID}`, jpeg(), "image/jpeg"));
});

test("IDOR: quem não participa não envia nem baixa mídia da conversa", async () => {
  await assertFails(enviar("uidDavi", `midia/ana_bruno/uidDavi/${UUID}`, jpeg(), "image/jpeg"));
  await assertFails(getBytes(ref(armazenamento("uidDavi"), EXISTENTE)));
  await assertFails(getBytes(ref(armazenamento(null), EXISTENTE)));
});

test("participante baixa com login (sem link público)", async () => {
  await assertSucceeds(getBytes(ref(armazenamento("uidBruno"), EXISTENTE)));
});

test("áudio: mesma regra — participante envia e baixa, quem não participa não", async () => {
  const audio = `midia/ana_bruno/uidBruno/${UUID}`;
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
  await assertSucceeds(enviar("uidBruno", audio, webm, "audio/webm"));
  await assertSucceeds(getBytes(ref(armazenamento("uidAna"), audio)));
  await assertFails(getBytes(ref(armazenamento("uidDavi"), audio)));
  await assertFails(enviar("uidBruno", `midia/ana_bruno/uidBruno/${OUTRO_UUID}`, new Uint8Array(15 * 1024 * 1024), "audio/webm"));
});

test("ninguém envia na pasta de outra pessoa nem sobrescreve arquivo", async () => {
  await assertFails(enviar("uidAna", `midia/ana_bruno/uidBruno/${UUID}`, jpeg(), "image/jpeg"));
  await assertFails(enviar("uidAna", EXISTENTE, jpeg(), "image/jpeg")); // já existe: seria update
});

test("nome aleatório obrigatório; tipos perigosos recusados", async () => {
  await assertFails(enviar("uidAna", "midia/ana_bruno/uidAna/pagina.html", jpeg(), "image/jpeg"));
  await assertFails(enviar("uidAna", `midia/ana_bruno/uidAna/${UUID}`, jpeg(), "text/html"));
  await assertFails(enviar("uidAna", `midia/ana_bruno/uidAna/${UUID}`, jpeg(), "image/svg+xml"));
  await assertFails(enviar("uidAna", `midia/ana_bruno/uidAna/${UUID}`, jpeg(), "application/javascript"));
});

test("limites de tamanho por tipo", async () => {
  await assertFails(enviar("uidAna", `midia/ana_bruno/uidAna/${UUID}`, jpeg(10 * 1024 * 1024), "image/jpeg"));
  await assertFails(enviar("uidAna", `midia/ana_bruno/uidAna/${UUID}`, new Uint8Array(0), "image/jpeg"));
  // Arquivo cifrado (conversa protegida): octet-stream até 16 MB.
  await assertSucceeds(enviar("uidAna", `midia/ana_bruno/uidAna/${UUID}`, new Uint8Array(4096), "application/octet-stream"));
});

test("só o dono apaga o próprio arquivo; ninguém lista a pasta", async () => {
  await assertFails(deleteObject(ref(armazenamento("uidBruno"), EXISTENTE)));
  await assertFails(listAll(ref(armazenamento("uidAna"), "midia/ana_bruno")));
  await assertSucceeds(deleteObject(ref(armazenamento("uidAna"), EXISTENTE)));
});

// ==========================================================================
// Fotos de perfil
// ==========================================================================

test("avatar: só JPEG pequeno, com nome aleatório, na pasta do próprio uid", async () => {
  await assertSucceeds(enviar("uidAna", `avatares/uidAna/${UUID}.jpg`, jpeg(), "image/jpeg"));
  await assertFails(enviar("uidAna", `avatares/uidBruno/${UUID}.jpg`, jpeg(), "image/jpeg"));
  await assertFails(enviar("uidAna", `avatares/uidAna/${OUTRO_UUID}.png`, jpeg(), "image/png"));
  await assertFails(enviar("uidAna", `avatares/uidAna/${OUTRO_UUID}.jpg`, jpeg(2 * 1024 * 1024), "image/jpeg"));
  await assertFails(listAll(ref(armazenamento("uidAna"), "avatares/uidAna")));
});

// ==========================================================================
// Caminhos antigos e o resto
// ==========================================================================

test("caminhos antigos (imagens/, audios/) e desconhecidos: nada entra nem sai", async () => {
  await assertFails(enviar("uidAna", "imagens/uidAna/ana_bruno_1.jpg", jpeg(), "image/jpeg"));
  await assertFails(enviar("uidAna", "audios/uidAna/ana_bruno_1.webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), "audio/webm"));
  await assertFails(getBytes(ref(armazenamento("uidAna"), "imagens/uidAna/ana_bruno_1.jpg")));
  await assertFails(enviar("uidAna", "qualquer/coisa.txt", new Uint8Array(4), "text/plain"));
});
