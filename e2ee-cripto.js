// ==========================================================================
// Criptografia de ponta a ponta — núcleo (sem Firebase e sem DOM)
// ==========================================================================
// Nada aqui é criptografia inventada. As peças são padrões:
//   - HPKE (RFC 9180), modo base, DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 +
//     AES-256-GCM, pela biblioteca @hpke/core (vendor/). É o "envelope" que
//     entrega a chave de cada mensagem a cada aparelho.
//   - AES-256-GCM (Web Crypto) para o conteúdo: cifragem autenticada, que
//     também garante a integridade.
//   - ECDSA P-256 com SHA-256 (Web Crypto) para assinar a mensagem com a
//     chave do aparelho que enviou: quem recebe sabe de qual aparelho veio.
//
// Por mensagem: uma chave de conteúdo aleatória (32 bytes) cifra o texto; essa
// chave vai "selada" com HPKE para cada aparelho de cada participante (e para
// os outros aparelhos de quem envia). O servidor guarda só o envelope.
//
// O que isto NÃO tem (ver SEGURANCA.md): sigilo futuro por mensagem (não há
// catraca/ratchet como no Signal — quem roubar a chave privada de um aparelho
// lê o que foi cifrado para ele), nem histórico em aparelho novo.

import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes256Gcm } from "./vendor/hpke-1.9.0.js";

export const VERSAO = 1;

const subtle = globalThis.crypto.subtle;
const codificador = new TextEncoder();
const decodificador = new TextDecoder("utf-8", { fatal: true });

const INFO_HPKE = codificador.encode("sinex/e2ee/v1/chave-de-conteudo");
const ROTULO_ASSINATURA = codificador.encode("sinex/e2ee/v1/assinatura");
const ROTULO_ARQUIVO = codificador.encode("sinex/e2ee/v1/arquivo");

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

const ECDH = { name: "ECDH", namedCurve: "P-256" };
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const ASSINATURA = { name: "ECDSA", hash: "SHA-256" };

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------

export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deB64u(texto) {
  if (typeof texto !== "string" || !/^[A-Za-z0-9_-]*$/.test(texto)) {
    throw new ErroE2EE("codificacao", "Texto base64url inválido.");
  }
  const b64 = texto.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((texto.length + 3) % 4);
  const bin = atob(b64);
  const saida = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) saida[i] = bin.charCodeAt(i);
  return saida;
}

function juntar(...partes) {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

// Campos de tamanho variável entram com o comprimento na frente: sem isso,
// "ab"+"c" e "a"+"bc" dariam os mesmos bytes assinados.
function campo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : codificador.encode(String(bytes));
  const tamanho = new Uint8Array(4);
  new DataView(tamanho.buffer).setUint32(0, b.length);
  return juntar(tamanho, b);
}

export class ErroE2EE extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = "ErroE2EE";
    this.codigo = codigo;
  }
}

function aleatorio(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// --------------------------------------------------------------------------
// Chaves do aparelho
// --------------------------------------------------------------------------

/**
 * Gera as chaves de um aparelho. As privadas nascem NÃO EXTRAÍVEIS: nem o
 * próprio app (nem um script injetado) consegue ler os bytes delas — só
 * usá-las enquanto a página está aberta.
 */
export async function gerarChavesDoAparelho() {
  const kem = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  const sig = await subtle.generateKey(ECDSA, false, ["sign", "verify"]);
  const kemPublica = new Uint8Array(await subtle.exportKey("raw", kem.publicKey));
  const sigPublica = new Uint8Array(await subtle.exportKey("raw", sig.publicKey));
  return { kem, sig, publicas: { kem: b64u(kemPublica), sig: b64u(sigPublica) } };
}

function bytesDeChavePublica(b64) {
  const bytes = deB64u(b64);
  // Ponto P-256 não comprimido: 0x04 || X (32) || Y (32).
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new ErroE2EE("chave", "Chave pública em formato inesperado.");
  }
  return bytes;
}

export async function importarChaveKem(b64) {
  // importKey confere que o ponto está na curva.
  return subtle.importKey("raw", bytesDeChavePublica(b64), ECDH, true, []);
}

export async function importarChaveDeAssinatura(b64) {
  return subtle.importKey("raw", bytesDeChavePublica(b64), ECDSA, true, ["verify"]);
}

// --------------------------------------------------------------------------
// Mensagens
// --------------------------------------------------------------------------

function validarCabecalho(c) {
  const ok = c && typeof c.chatId === "string" && c.chatId
    && typeof c.remetenteUid === "string" && c.remetenteUid
    && typeof c.dispositivo === "string" && /^[A-Za-z0-9-]{36}$/.test(c.dispositivo);
  if (!ok) throw new ErroE2EE("cabecalho", "Cabeçalho da mensagem incompleto.");
}

// Dados associados (autenticados, não cifrados): prendem o conteúdo a ESTA
// conversa, a ESTA pessoa e a ESTE aparelho. Copiar o envelope para outra
// conversa, ou trocar o remetente no banco, faz a abertura falhar.
function dadosAssociados(c) {
  return juntar(codificador.encode("sinex-e2ee"), campo(String(VERSAO)), campo(c.chatId), campo(c.remetenteUid), campo(c.dispositivo));
}

function bytesAssinados(c, envelope) {
  const ids = Object.keys(envelope.chaves).sort();
  const partes = [ROTULO_ASSINATURA, dadosAssociados(c), campo(envelope.iv), campo(envelope.ct)];
  for (const id of ids) partes.push(campo(id), campo(envelope.chaves[id]));
  return juntar(...partes);
}

/**
 * Cifra "conteudo" (qualquer objeto JSON) para uma lista de aparelhos.
 *
 * destinatarios: [{ id, kem: CryptoKey pública ECDH }]
 * aparelho: { id, sig: CryptoKeyPair ECDSA } — quem assina (este aparelho)
 */
export async function cifrarMensagem({ cabecalho, conteudo, destinatarios, aparelho }) {
  validarCabecalho(cabecalho);
  if (cabecalho.dispositivo !== aparelho?.id) throw new ErroE2EE("cabecalho", "Aparelho não confere com o cabeçalho.");
  if (!Array.isArray(destinatarios) || !destinatarios.length) throw new ErroE2EE("destinatarios", "Nenhum aparelho para receber.");
  if (destinatarios.length > 64) throw new ErroE2EE("destinatarios", "Aparelhos demais nesta conversa.");

  const aad = dadosAssociados(cabecalho);
  const chaveBruta = aleatorio(32);
  const iv = aleatorio(12);
  try {
    const chave = await subtle.importKey("raw", chaveBruta, "AES-GCM", false, ["encrypt"]);
    const texto = codificador.encode(JSON.stringify(conteudo));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, chave, texto));

    const chaves = {};
    for (const d of destinatarios) {
      if (!/^[A-Za-z0-9-]{36}$/.test(d.id) || chaves[d.id]) continue;
      const selado = await suite.seal(
        { recipientPublicKey: d.kem, info: INFO_HPKE },
        chaveBruta,
        juntar(aad, campo(d.id)),
      );
      chaves[d.id] = `${b64u(new Uint8Array(selado.enc))}.${b64u(new Uint8Array(selado.ct))}`;
    }

    const envelope = { v: VERSAO, dispositivo: aparelho.id, iv: b64u(iv), ct: b64u(ct), chaves };
    const assinatura = await subtle.sign(ASSINATURA, aparelho.sig.privateKey, bytesAssinados(cabecalho, envelope));
    envelope.sig = b64u(new Uint8Array(assinatura));
    return envelope;
  } finally {
    chaveBruta.fill(0);
  }
}

/**
 * Abre um envelope. Confere a assinatura ANTES de decifrar.
 *
 * aparelho: { id, kem: CryptoKeyPair ECDH } — este aparelho
 * chaveDoRemetente: CryptoKey pública ECDSA do aparelho que enviou
 */
export async function decifrarMensagem({ cabecalho, envelope, aparelho, chaveDoRemetente }) {
  validarCabecalho(cabecalho);
  if (!envelope || envelope.v !== VERSAO || envelope.dispositivo !== cabecalho.dispositivo) {
    throw new ErroE2EE("envelope", "Envelope de versão desconhecida.");
  }
  if (typeof envelope.sig !== "string" || typeof envelope.iv !== "string" || typeof envelope.ct !== "string" || !envelope.chaves) {
    throw new ErroE2EE("envelope", "Envelope incompleto.");
  }

  const valida = await subtle.verify(ASSINATURA, chaveDoRemetente, deB64u(envelope.sig), bytesAssinados(cabecalho, envelope));
  if (!valida) throw new ErroE2EE("assinatura", "A assinatura da mensagem não confere.");

  const minha = envelope.chaves[aparelho.id];
  if (typeof minha !== "string") throw new ErroE2EE("sem-chave", "Esta mensagem não foi cifrada para este aparelho.");
  const [enc, selado] = minha.split(".");
  if (!enc || !selado) throw new ErroE2EE("envelope", "Chave selada malformada.");

  const aad = dadosAssociados(cabecalho);
  let chaveBruta;
  try {
    chaveBruta = new Uint8Array(await suite.open(
      { recipientKey: aparelho.kem, enc: deB64u(enc), info: INFO_HPKE },
      deB64u(selado),
      juntar(aad, campo(aparelho.id)),
    ));
  } catch (_) {
    throw new ErroE2EE("abrir", "Não foi possível abrir a chave desta mensagem.");
  }

  try {
    if (chaveBruta.length !== 32) throw new ErroE2EE("abrir", "Chave de conteúdo inválida.");
    const chave = await subtle.importKey("raw", chaveBruta, "AES-GCM", false, ["decrypt"]);
    let texto;
    try {
      texto = await subtle.decrypt({ name: "AES-GCM", iv: deB64u(envelope.iv), additionalData: aad, tagLength: 128 }, chave, deB64u(envelope.ct));
    } catch (_) {
      throw new ErroE2EE("integridade", "O conteúdo foi alterado ou não pertence a esta conversa.");
    }
    return JSON.parse(decodificador.decode(texto));
  } finally {
    chaveBruta.fill(0);
  }
}

// --------------------------------------------------------------------------
// Arquivos (fotos e áudios de conversa protegida)
// --------------------------------------------------------------------------

/** Cifra os bytes de um arquivo com chave própria, presa ao caminho. */
export async function cifrarArquivo(bytes, caminho) {
  const chaveBruta = aleatorio(32);
  const iv = aleatorio(12);
  try {
    const chave = await subtle.importKey("raw", chaveBruta, "AES-GCM", false, ["encrypt"]);
    const aad = juntar(ROTULO_ARQUIVO, campo(caminho));
    const cifrado = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, chave, bytes));
    return { cifrado, chave: b64u(chaveBruta), iv: b64u(iv) };
  } finally {
    chaveBruta.fill(0);
  }
}

export async function decifrarArquivo(cifrado, caminho, chaveB64, ivB64) {
  const chaveBruta = deB64u(chaveB64);
  try {
    if (chaveBruta.length !== 32) throw new ErroE2EE("arquivo", "Chave de arquivo inválida.");
    const chave = await subtle.importKey("raw", chaveBruta, "AES-GCM", false, ["decrypt"]);
    const aad = juntar(ROTULO_ARQUIVO, campo(caminho));
    try {
      return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: deB64u(ivB64), additionalData: aad, tagLength: 128 }, chave, cifrado));
    } catch (_) {
      throw new ErroE2EE("integridade", "O arquivo foi alterado ou não pertence a esta mensagem.");
    }
  } finally {
    chaveBruta.fill(0);
  }
}

// --------------------------------------------------------------------------
// Conteúdo decifrado: nunca se confia nele só porque abriu
// --------------------------------------------------------------------------
// Quem cifra é o aparelho de um participante — que pode estar adulterado. O
// que sai daqui vai para textContent/URL de blob, mas o formato é conferido
// antes de chegar à tela.

const TIPOS_CONTEUDO = new Set(["texto", "imagem", "audio"]);

export function validarConteudo(c) {
  if (!c || typeof c !== "object" || !TIPOS_CONTEUDO.has(c.t)) {
    throw new ErroE2EE("conteudo", "Conteúdo protegido em formato desconhecido.");
  }
  const saida = { t: c.t };
  if (c.t === "texto") {
    if (typeof c.x !== "string" || !c.x || c.x.length > 8000) throw new ErroE2EE("conteudo", "Texto inválido.");
    saida.x = c.x;
  } else {
    const m = c.m;
    if (!m || typeof m.caminho !== "string" || typeof m.mime !== "string"
      || typeof m.k !== "string" || typeof m.iv !== "string") {
      throw new ErroE2EE("conteudo", "Mídia protegida incompleta.");
    }
    saida.m = { caminho: m.caminho, mime: m.mime, k: m.k, iv: m.iv };
    for (const n of ["tamanho", "largura", "altura", "duracao"]) {
      if (Number.isInteger(m[n]) && m[n] >= 0 && m[n] <= 1e9) saida.m[n] = m[n];
    }
  }
  if (c.r && typeof c.r === "object") {
    const r = {};
    if (typeof c.r.a === "string" && c.r.a.length <= 64) r.a = c.r.a;
    if (typeof c.r.x === "string") r.x = c.r.x.slice(0, 400);
    if (typeof c.r.t === "string" && ["texto", "imagem", "audio", "sistema", "cifrada"].includes(c.r.t)) r.t = c.r.t;
    saida.r = r;
  }
  return saida;
}

// --------------------------------------------------------------------------
// Número de segurança (verificação fora do app, como no Signal/WhatsApp)
// --------------------------------------------------------------------------
// Cada pessoa tem uma "impressão" de 30 dígitos derivada do uid e das chaves
// públicas de TODOS os aparelhos dela (SHA-512 repetido 5200 vezes, como o
// Signal faz, para encarecer a busca por colisão). O número da conversa é a
// junção das duas impressões, em ordem — igual nos dois aparelhos. Se alguém
// no meio (inclusive o servidor) trocar uma chave, o número muda.

const ITERACOES_IMPRESSAO = 5200;

async function impressao(uid, aparelhos) {
  const chaves = aparelhos
    .map((a) => `${a.id}:${a.kem}:${a.sig}`)
    .sort();
  let hash = juntar(codificador.encode("sinex/e2ee/v1/numero"), campo(uid), ...chaves.map((k) => campo(k)));
  const chavesBytes = codificador.encode(chaves.join("|"));
  for (let i = 0; i < ITERACOES_IMPRESSAO; i++) {
    hash = new Uint8Array(await subtle.digest("SHA-512", juntar(hash, chavesBytes)));
  }
  let digitos = "";
  for (let i = 0; i < 30; i += 5) {
    const bloco = hash.slice(i, i + 5);
    let n = 0n;
    for (const byte of bloco) n = (n << 8n) | BigInt(byte);
    digitos += String(n % 100000n).padStart(5, "0");
  }
  return digitos;
}

/**
 * Número de segurança entre duas pessoas. aparelhos: [{ id, kem, sig }].
 * Devolve 60 dígitos em 12 grupos de 5.
 */
export async function numeroDeSeguranca(uidA, aparelhosA, uidB, aparelhosB) {
  const a = await impressao(uidA, aparelhosA);
  const b = await impressao(uidB, aparelhosB);
  const [primeiro, segundo] = uidA < uidB ? [a, b] : [b, a];
  const tudo = primeiro + segundo;
  return tudo.match(/.{5}/g).join(" ");
}

/** Resumo estável do conjunto de aparelhos (para detectar troca de chave). */
export async function resumoDosAparelhos(aparelhos) {
  const texto = aparelhos.map((a) => `${a.id}:${a.kem}:${a.sig}`).sort().join("|");
  return b64u(new Uint8Array(await subtle.digest("SHA-256", codificador.encode(texto))));
}
