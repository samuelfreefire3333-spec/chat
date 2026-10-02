// Testes do núcleo de criptografia de ponta a ponta.
// Rodar: node --test testes/js/   (Node 20 ou mais novo)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  gerarChavesDoAparelho, importarChaveKem, importarChaveDeAssinatura,
  cifrarMensagem, decifrarMensagem, cifrarArquivo, decifrarArquivo,
  numeroDeSeguranca, resumoDosAparelhos, validarConteudo, b64u, deB64u, ErroE2EE,
} from "../../e2ee-cripto.js";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes256Gcm } from "../../vendor/hpke-1.9.0.js";

const hex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const paraHex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function novoAparelho(id) {
  const chaves = await gerarChavesDoAparelho();
  return { id, ...chaves };
}

async function destinatario(ap) {
  return { id: ap.id, kem: await importarChaveKem(ap.publicas.kem) };
}

const ID_A1 = "11111111-1111-4111-8111-111111111111";
const ID_A2 = "22222222-2222-4222-8222-222222222222";
const ID_B1 = "33333333-3333-4333-8333-333333333333";
const ID_C1 = "44444444-4444-4444-8444-444444444444";

// --------------------------------------------------------------------------
// A biblioteca empacotada bate com o vetor oficial do RFC 9180
// --------------------------------------------------------------------------

test("HPKE empacotado confere com o vetor de teste do RFC 9180 (P-256/SHA-256/AES-256-GCM)", async () => {
  const caminho = fileURLToPath(new URL("../dados/hpke-rfc9180-p256-sha256-aes256gcm.json", import.meta.url));
  const v = JSON.parse(readFileSync(caminho, "utf8"));
  const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });

  // Lado de quem recebe: chave privada do vetor.
  const skR = await suite.kem.importKey("raw", hex(v.skRm).buffer, false);
  const pkR = await suite.kem.importKey("raw", hex(v.pkRm).buffer, true);
  const recebedor = await suite.createRecipientContext({ recipientKey: { privateKey: skR, publicKey: pkR }, enc: hex(v.enc).buffer, info: hex(v.info).buffer });
  for (const e of v.encryptions) {
    const pt = await recebedor.open(hex(e.ct).buffer, hex(e.aad).buffer);
    assert.equal(paraHex(pt), e.pt);
  }

  // Lado de quem envia, com a chave efêmera determinística do vetor.
  const remetente = await suite.createSenderContext({ recipientPublicKey: pkR, info: hex(v.info).buffer, ekm: hex(v.ikmE).buffer });
  assert.equal(paraHex(remetente.enc), v.enc);
  for (const e of v.encryptions) {
    const ct = await remetente.seal(hex(e.pt).buffer, hex(e.aad).buffer);
    assert.equal(paraHex(ct), e.ct);
  }
});

// --------------------------------------------------------------------------
// Ida e volta, multi-aparelho
// --------------------------------------------------------------------------

test("cifra para vários aparelhos e cada um abre o seu", async () => {
  const a1 = await novoAparelho(ID_A1);
  const a2 = await novoAparelho(ID_A2);
  const b1 = await novoAparelho(ID_B1);
  const cabecalho = { chatId: "ana_bruno", remetenteUid: "uid-ana", dispositivo: ID_A1 };

  const envelope = await cifrarMensagem({
    cabecalho,
    conteudo: { t: "texto", x: "oi, Bruno 👋 — acentuação e emoji" },
    destinatarios: [await destinatario(a1), await destinatario(a2), await destinatario(b1)],
    aparelho: a1,
  });

  // O servidor não vê o texto.
  assert.ok(!JSON.stringify(envelope).includes("Bruno"));
  assert.equal(Object.keys(envelope.chaves).length, 3);

  const chaveDoRemetente = await importarChaveDeAssinatura(a1.publicas.sig);
  for (const ap of [a1, a2, b1]) {
    const c = await decifrarMensagem({ cabecalho, envelope, aparelho: ap, chaveDoRemetente });
    assert.deepEqual(c, { t: "texto", x: "oi, Bruno 👋 — acentuação e emoji" });
  }
});

test("aparelho que não estava na lista não abre", async () => {
  const a1 = await novoAparelho(ID_A1);
  const b1 = await novoAparelho(ID_B1);
  const intruso = await novoAparelho(ID_C1);
  const cabecalho = { chatId: "ana_bruno", remetenteUid: "uid-ana", dispositivo: ID_A1 };
  const envelope = await cifrarMensagem({ cabecalho, conteudo: { t: "texto", x: "segredo" }, destinatarios: [await destinatario(b1)], aparelho: a1 });
  const chaveDoRemetente = await importarChaveDeAssinatura(a1.publicas.sig);

  await assert.rejects(
    decifrarMensagem({ cabecalho, envelope, aparelho: intruso, chaveDoRemetente }),
    (e) => e instanceof ErroE2EE && e.codigo === "sem-chave",
  );

  // Nem copiando a chave selada de outro aparelho para o próprio ID.
  const roubado = { ...envelope, chaves: { ...envelope.chaves, [ID_C1]: envelope.chaves[ID_B1] } };
  await assert.rejects(decifrarMensagem({ cabecalho, envelope: roubado, aparelho: intruso, chaveDoRemetente }), ErroE2EE);
});

// --------------------------------------------------------------------------
// Integridade, autenticidade e amarração ao contexto
// --------------------------------------------------------------------------

test("qualquer alteração no envelope é detectada", async () => {
  const a1 = await novoAparelho(ID_A1);
  const b1 = await novoAparelho(ID_B1);
  const cabecalho = { chatId: "ana_bruno", remetenteUid: "uid-ana", dispositivo: ID_A1 };
  const envelope = await cifrarMensagem({ cabecalho, conteudo: { t: "texto", x: "pague 10" }, destinatarios: [await destinatario(b1)], aparelho: a1 });
  const chaveDoRemetente = await importarChaveDeAssinatura(a1.publicas.sig);

  const ct = deB64u(envelope.ct);
  ct[0] ^= 1;
  const adulterados = [
    { ...envelope, ct: b64u(ct) },
    { ...envelope, iv: b64u(new Uint8Array(12)) },
    { ...envelope, sig: b64u(new Uint8Array(64)) },
    { ...envelope, chaves: {} },
  ];
  for (const e of adulterados) {
    await assert.rejects(decifrarMensagem({ cabecalho, envelope: e, aparelho: b1, chaveDoRemetente }), ErroE2EE);
  }
});

test("envelope copiado para outra conversa ou atribuído a outra pessoa não abre", async () => {
  const a1 = await novoAparelho(ID_A1);
  const b1 = await novoAparelho(ID_B1);
  const cabecalho = { chatId: "ana_bruno", remetenteUid: "uid-ana", dispositivo: ID_A1 };
  const envelope = await cifrarMensagem({ cabecalho, conteudo: { t: "texto", x: "x" }, destinatarios: [await destinatario(b1)], aparelho: a1 });
  const chaveDoRemetente = await importarChaveDeAssinatura(a1.publicas.sig);

  for (const outro of [
    { ...cabecalho, chatId: "bruno_carla" },
    { ...cabecalho, remetenteUid: "uid-carla" },
  ]) {
    await assert.rejects(decifrarMensagem({ cabecalho: outro, envelope, aparelho: b1, chaveDoRemetente }), ErroE2EE);
  }
});

test("assinatura de outro aparelho é recusada (remetente falsificado)", async () => {
  const a1 = await novoAparelho(ID_A1);
  const b1 = await novoAparelho(ID_B1);
  const falsario = await novoAparelho(ID_C1);
  const cabecalho = { chatId: "ana_bruno", remetenteUid: "uid-ana", dispositivo: ID_A1 };
  // O falsário cifra e assina com a chave DELE, mas diz ser o aparelho a1.
  const envelope = await cifrarMensagem({
    cabecalho, conteudo: { t: "texto", x: "sou a Ana" }, destinatarios: [await destinatario(b1)],
    aparelho: { ...falsario, id: ID_A1 },
  });
  const chaveVerdadeiraDaAna = await importarChaveDeAssinatura(a1.publicas.sig);
  await assert.rejects(
    decifrarMensagem({ cabecalho, envelope, aparelho: b1, chaveDoRemetente: chaveVerdadeiraDaAna }),
    (e) => e.codigo === "assinatura",
  );
});

test("chaves privadas não são extraíveis", async () => {
  const a1 = await novoAparelho(ID_A1);
  await assert.rejects(globalThis.crypto.subtle.exportKey("pkcs8", a1.kem.privateKey));
  await assert.rejects(globalThis.crypto.subtle.exportKey("jwk", a1.sig.privateKey));
});

test("chave pública malformada é recusada", async () => {
  await assert.rejects(importarChaveKem(b64u(new Uint8Array(65))), Error); // ponto fora da curva
  await assert.rejects(importarChaveKem(b64u(new Uint8Array(33))), ErroE2EE);
  await assert.rejects(importarChaveKem("não é base64url"), ErroE2EE);
});

// --------------------------------------------------------------------------
// Arquivos
// --------------------------------------------------------------------------

test("arquivo cifrado abre só com a chave e no mesmo caminho", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
  const caminho = "midia/ana_bruno/uid-ana/0b9d3a1c-6f0e-4c3b-9f9a-1c2d3e4f5a6b";
  const { cifrado, chave, iv } = await cifrarArquivo(bytes, caminho);
  assert.notDeepEqual(cifrado.slice(0, 4), bytes.slice(0, 4));
  assert.deepEqual(await decifrarArquivo(cifrado, caminho, chave, iv), bytes);
  await assert.rejects(decifrarArquivo(cifrado, caminho.replace("ana_bruno", "bruno_carla"), chave, iv), ErroE2EE);
  cifrado[cifrado.length - 1] ^= 1;
  await assert.rejects(decifrarArquivo(cifrado, caminho, chave, iv), ErroE2EE);
});

// --------------------------------------------------------------------------
// Conteúdo decifrado continua sendo entrada não confiável
// --------------------------------------------------------------------------

test("validarConteudo recusa formatos inesperados e corta excessos", () => {
  assert.throws(() => validarConteudo({ t: "html", x: "<script>" }), ErroE2EE);
  assert.throws(() => validarConteudo({ t: "texto", x: "a".repeat(8001) }), ErroE2EE);
  assert.throws(() => validarConteudo({ t: "imagem", m: { caminho: 1 } }), ErroE2EE);
  const ok = validarConteudo({ t: "texto", x: "<img src=x onerror=alert(1)>", extra: "x", r: { a: "bruno", x: "y".repeat(900), t: "texto", z: 1 } });
  assert.equal(ok.x, "<img src=x onerror=alert(1)>"); // vai para textContent, não para HTML
  assert.equal(ok.extra, undefined);
  assert.equal(ok.r.x.length, 400);
  assert.equal(ok.r.z, undefined);
});

// --------------------------------------------------------------------------
// Número de segurança
// --------------------------------------------------------------------------

test("número de segurança é igual nos dois lados e muda quando uma chave muda", async () => {
  const a1 = await novoAparelho(ID_A1);
  const b1 = await novoAparelho(ID_B1);
  const pa = [{ id: a1.id, ...a1.publicas }];
  const pb = [{ id: b1.id, ...b1.publicas }];

  const n1 = await numeroDeSeguranca("uid-ana", pa, "uid-bruno", pb);
  const n2 = await numeroDeSeguranca("uid-bruno", pb, "uid-ana", pa);
  assert.equal(n1, n2);
  assert.match(n1, /^(\d{5} ){11}\d{5}$/);

  const trocado = await novoAparelho(ID_B1);
  const n3 = await numeroDeSeguranca("uid-ana", pa, "uid-bruno", [{ id: trocado.id, ...trocado.publicas }]);
  assert.notEqual(n1, n3);

  assert.notEqual(await resumoDosAparelhos(pb), await resumoDosAparelhos([{ id: trocado.id, ...trocado.publicas }]));
  assert.equal(await resumoDosAparelhos([...pa, ...pb]), await resumoDosAparelhos([...pb, ...pa]));
});
