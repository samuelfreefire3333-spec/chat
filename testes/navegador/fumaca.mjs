// Teste de fumaça no Chromium (Playwright). Serve os arquivos que o Netlify
// publica, com a MESMA CSP e os mesmos headers do netlify.toml, e confere em
// cada página: erro de módulo, import quebrado, violação de CSP, exceção não
// tratada e arquivo 404. A rede para o Firebase e o backend é cortada, então
// as telas internas terminam no login (fluxo deslogado).
//
// No navegador de verdade também confere: chaves E2EE não extraíveis no
// IndexedDB, ida e volta cifrada, envelope preso à conversa, remoção de
// EXIF/GPS, arquivo disfarçado recusado, limite de áudio, CSP barrando
// handler inline (XSS), intenção de chamada de uso único e avatar padrão no
// lugar de foto ausente, inválida ou quebrada.
//
// Rodar:
//   cd testes/navegador && npm ci && npx playwright install chromium && npm test
//
// Sem acesso ao www.gstatic.com, aponte FIREBASE_SHIMS para uma pasta com
// firebase-app.js, firebase-firestore.js, firebase-storage.js e
// firebase-auth.js (SDK 10.12.2 empacotado localmente).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const RAIZ = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SHIMS = process.env.FIREBASE_SHIMS || null;

// Cabeçalhos do netlify.toml (seção "/*"), lidos do próprio arquivo.
const toml = fs.readFileSync(path.join(RAIZ, "netlify.toml"), "utf8");
function valor(nome) {
  const m = toml.match(new RegExp(`^\\s*${nome}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
  return m ? m[1].replace(/\\"/g, '"') : null;
}
const CSP = valor("Content-Security-Policy")
  // Em http://127.0.0.1 o upgrade quebraria o próprio carregamento local.
  .replace(/\s*upgrade-insecure-requests;/, "");
const CABECALHOS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": valor("X-Content-Type-Options"),
  "X-Frame-Options": valor("X-Frame-Options"),
  "Referrer-Policy": valor("Referrer-Policy"),
  "Permissions-Policy": valor("Permissions-Policy"),
  "Cross-Origin-Opener-Policy": valor("Cross-Origin-Opener-Policy"),
  "Cross-Origin-Resource-Policy": valor("Cross-Origin-Resource-Policy"),
};

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wav": "audio/wav",
};

// Só o que o build do Netlify publica.
function publicado(rel) {
  if (/^[^/]+\.(html|css|js)$/.test(rel) || rel === "manifest.json") return true;
  return /^(assets|vendor)\/[^/]+$/.test(rel);
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const arquivo = path.join(RAIZ, rel);
  if (!publicado(rel) || !arquivo.startsWith(RAIZ + path.sep) || !fs.existsSync(arquivo)) {
    res.writeHead(404, CABECALHOS);
    res.end("404");
    return;
  }
  res.writeHead(200, { ...CABECALHOS, "Content-Type": TIPOS[path.extname(rel)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(arquivo).pipe(res);
});
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${servidor.address().port}`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const contexto = await browser.newContext({ serviceWorkers: "block" });

if (SHIMS) {
  await contexto.route("https://www.gstatic.com/firebasejs/10.12.2/*", async (rota) => {
    const nome = new URL(rota.request().url()).pathname.split("/").pop();
    const local = path.join(SHIMS, nome);
    if (!fs.existsSync(local)) return rota.fulfill({ status: 404, body: "" });
    return rota.fulfill({
      status: 200,
      headers: { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" },
      body: fs.readFileSync(local),
    });
  });
}
// Sem rede para fora: Firebase e backend falham como "sem conexão".
await contexto.route(/googleapis\.com|onrender\.com|firebaseapp\.com|google\.com/, (rota) => rota.abort("internetdisconnected"));

await contexto.addInitScript(() => {
  window.__violacoes = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__violacoes.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile || ""}:${e.lineNumber || ""}`);
  });
});

const PAGINAS = [
  "index.html", "login.html", "cadastro.html", "inbox.html", "chat.html?u=bruno", "perfil.html", "explorar.html",
  "configuracoes.html", "configuracoes-tema.html", "editar-perfil.html", "foto.html", "chamada.html?u=bruno&papel=receptor",
  "aviso.html?c=acesso-negado", "aviso.html?t=Golpe&m=Envie%20sua%20senha", "grupo-novo.html", "admin.html",
];

let falhas = 0;
const IGNORAR = [
  /ERR_INTERNET_DISCONNECTED/, /net::ERR_FAILED/, /Failed to load resource/, /Could not reach Cloud Firestore/,
  /auth\/network-request-failed/, /WebSocket connection to .* failed/, /FirebaseError: .*offline/i,
];

for (const pagina of PAGINAS) {
  const p = await contexto.newPage();
  const problemas = [];
  p.on("pageerror", (err) => problemas.push(`exceção: ${err.message}`));
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (IGNORAR.some((re) => re.test(t))) return;
    problemas.push(`console: ${t.slice(0, 300)}`);
  });
  p.on("requestfailed", (r) => {
    const u = r.url();
    if (u.startsWith(BASE)) problemas.push(`falha ao carregar ${u}: ${r.failure()?.errorText}`);
  });
  p.on("response", (r) => {
    if (r.url().startsWith(BASE) && r.status() >= 400) problemas.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await p.goto(`${BASE}/${pagina}`, { waitUntil: "load" }).catch((e) => problemas.push(`navegação: ${e.message}`));
  await p.waitForTimeout(2500);
  const violacoes = await p.evaluate(() => window.__violacoes || []).catch(() => []);
  for (const v of violacoes) problemas.push(`CSP: ${v}`);
  const final = p.url().replace(BASE, "");
  if (pagina.startsWith("aviso.html")) {
    const titulo = await p.textContent("#avisoTitulo").catch(() => "?");
    const texto = await p.textContent("#avisoMensagem").catch(() => "?");
    if (pagina.includes("Golpe") && (titulo.includes("Golpe") || texto.includes("senha"))) problemas.push("aviso.html ainda mostra texto livre da URL");
    if (pagina.includes("acesso-negado") && titulo !== "Acesso negado") problemas.push(`aviso por código: título ${titulo}`);
  }
  if (pagina.startsWith("chamada.html")) {
    // Sem intenção registrada pelo app, a chamada NÃO pode pedir câmera/microfone.
    const recusou = await p.evaluate(() => document.body.innerText.includes("não iniciada por você")).catch(() => false);
    if (!recusou) problemas.push("chamada.html sem intenção não mostrou a recusa");
  }
  console.log(`${problemas.length ? "✗" : "✓"} ${pagina} → ${final}`);
  for (const pr of problemas) console.log(`    ${pr}`);
  falhas += problemas.length;
  await p.close();
}

// ---------------------------------------------------------------------------
// No navegador: E2EE com chaves guardadas no IndexedDB e EXIF removido.
// ---------------------------------------------------------------------------
const p = await contexto.newPage();
const erros = [];
p.on("pageerror", (err) => erros.push(err.message));
await p.goto(`${BASE}/aviso.html?c=acesso-negado`);
const resultado = await p.evaluate(async () => {
  const c = await import("/e2ee-cripto.js");
  const saida = {};

  // Dois aparelhos; as chaves passam pelo IndexedDB (clone estruturado) como o e2ee.js faz.
  const a = await c.gerarChavesDoAparelho();
  const b = await c.gerarChavesDoAparelho();
  const banco = await new Promise((ok, erro) => {
    const r = indexedDB.open("teste-fumaca", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("aparelhos", { keyPath: "uid" });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
  const gravar = (v) => new Promise((ok, erro) => { const t = banco.transaction("aparelhos", "readwrite"); t.objectStore("aparelhos").put(v); t.oncomplete = ok; t.onerror = () => erro(t.error); });
  const ler = (k) => new Promise((ok, erro) => { const t = banco.transaction("aparelhos"); const r = t.objectStore("aparelhos").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error); });
  const idA = crypto.randomUUID(), idB = crypto.randomUUID();
  await gravar({ uid: "A", id: idA, kem: a.kem, sig: a.sig, publicas: a.publicas });
  await gravar({ uid: "B", id: idB, kem: b.kem, sig: b.sig, publicas: b.publicas });
  const apA = await ler("A"), apB = await ler("B");
  saida.chavePrivadaNaoExtraivel = apA.kem.privateKey.extractable === false && apA.sig.privateKey.extractable === false;
  try { await crypto.subtle.exportKey("pkcs8", apA.kem.privateKey); saida.exportouPrivada = true; } catch { saida.exportouPrivada = false; }

  const cabecalho = { chatId: "ana_bruno", remetenteUid: "uidAna", dispositivo: idA };
  const envelope = await c.cifrarMensagem({
    cabecalho, conteudo: { t: "texto", x: "segredo 🔒" },
    destinatarios: [{ id: idB, kem: await c.importarChaveKem(apB.publicas.kem) }, { id: idA, kem: await c.importarChaveKem(apA.publicas.kem) }],
    aparelho: { id: idA, sig: apA.sig },
  });
  saida.textoNoEnvelope = JSON.stringify(envelope).includes("segredo");
  const aberto = await c.decifrarMensagem({
    cabecalho, envelope, aparelho: { id: idB, kem: apB.kem }, chaveDoRemetente: await c.importarChaveDeAssinatura(apA.publicas.sig),
  });
  saida.abriuNoOutroAparelho = aberto.x === "segredo 🔒";
  try {
    await c.decifrarMensagem({ cabecalho: { ...cabecalho, chatId: "outra_conversa" }, envelope, aparelho: { id: idB, kem: apB.kem }, chaveDoRemetente: await c.importarChaveDeAssinatura(apA.publicas.sig) });
    saida.recusouOutraConversa = false;
  } catch { saida.recusouOutraConversa = true; }
  banco.close();

  // Foto com EXIF/GPS: prepararImagem tem de devolver sem o bloco EXIF.
  const { prepararImagem } = await import("/midia.js");
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 48;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#c33"; ctx.fillRect(0, 0, 64, 48);
  const jpeg = new Uint8Array(await (await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.9))).arrayBuffer());
  const exif = new TextEncoder().encode("Exif\0\0GPSLatitude -23.5505 GPSLongitude -46.6333 iPhone 15 Pro");
  const app1 = new Uint8Array(4 + exif.length);
  app1.set([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]);
  app1.set(exif, 4);
  const comExif = new Uint8Array(jpeg.length + app1.length);
  comExif.set(jpeg.subarray(0, 2)); comExif.set(app1, 2); comExif.set(jpeg.subarray(2), 2 + app1.length);
  const antes = new TextDecoder("latin1").decode(comExif);
  const pronto = await prepararImagem(new File([comExif], "foto.jpg", { type: "image/jpeg" }));
  const depois = new TextDecoder("latin1").decode(new Uint8Array(await pronto.blob.arrayBuffer()));
  saida.exifAntes = antes.includes("GPSLatitude");
  saida.exifDepois = depois.includes("GPSLatitude") || depois.includes("Exif");
  saida.tipoDepois = pronto.mime;

  // Arquivo disfarçado (HTML com nome .jpg) não passa.
  try {
    await prepararImagem(new File([new TextEncoder().encode("<html><script>alert(1)</script>")], "x.jpg", { type: "image/jpeg" }));
    saida.recusouDisfarce = false;
  } catch { saida.recusouDisfarce = true; }
  // Áudio acima do limite é recusado antes de subir.
  const { prepararAudio } = await import("/midia.js");
  try {
    const grande = new Uint8Array(15 * 1024 * 1024);
    grande.set([0x1a, 0x45, 0xdf, 0xa3]);
    await prepararAudio(new Blob([grande], { type: "audio/webm" }), "audio/webm");
    saida.recusouAudioGrande = false;
  } catch { saida.recusouAudioGrande = true; }

  // XSS: mesmo que um texto chegasse ao DOM como HTML, a CSP bloqueia o
  // handler inline (defesa em profundidade; o app usa textContent).
  window.__xss = 0;
  const alvo = document.createElement("div");
  alvo.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="window.__xss=1" onload="window.__xss=1">';
  document.body.appendChild(alvo);
  const s = document.createElement("script");
  s.textContent = "window.__xss = 2";
  document.body.appendChild(s);
  await new Promise((r) => setTimeout(r, 300));
  saida.xssExecutou = window.__xss !== 0;

  // Intenção de chamada: uso único e presa a quem/como.
  const { registrarIntencaoDeChamada, consumirIntencaoDeChamada } = await import("/chamada-flutuante.js");
  const nonce = registrarIntencaoDeChamada({ com: "bruno", papel: "receptor", audio: true });
  saida.intencaoOutroContato = consumirIntencaoDeChamada({ nonce, com: "carla", papel: "receptor", audio: true });
  const nonce2 = registrarIntencaoDeChamada({ com: "bruno", papel: "receptor", audio: true });
  saida.intencaoPrimeiroUso = consumirIntencaoDeChamada({ nonce: nonce2, com: "bruno", papel: "receptor", audio: true });
  saida.intencaoReuso = consumirIntencaoDeChamada({ nonce: nonce2, com: "bruno", papel: "receptor", audio: true });

  // Avatar: sem foto, valor inválido ou foto que não abre → avatar padrão do
  // Sinex. Nunca imagem quebrada, "undefined" nem círculo vazio.
  const { definirAvatar, fotoDoPerfil } = await import("/core.js");
  const semFoto = ["", "  ", null, undefined, 0, {}, "undefined", "null", "/assets/avatar-padrao.svg", "assets/avatar-padrao.svg",
    "https://cdn-icons-png.flaticon.com/512/149/149071.png", "javascript:alert(1)", "https://site-de-fora.example/x.png", "/qualquer-arquivo.png"];
  saida.avatarSemFoto = semFoto.every((v) => fotoDoPerfil(v) === "");
  const fotoDoStorage = "https://firebasestorage.googleapis.com/v0/b/x.firebasestorage.app/o/avatares%2Fa%2Fb.jpg?alt=media&token=t";
  saida.avatarAceitaFoto = fotoDoPerfil(fotoDoStorage) === fotoDoStorage;
  const mostraPadrao = (img) => img.complete && img.naturalWidth > 0 && /avatar-padrao\.svg$/.test(img.getAttribute("src") || "")
    && img.classList.contains("avatar") && img.dataset.avatar === "padrao";
  const quebrada = document.createElement("img");
  const lixo = document.createElement("img");
  const vazia = document.createElement("img");
  document.body.append(quebrada, lixo, vazia);
  definirAvatar(quebrada, fotoDoStorage); // a rede para o Storage está cortada: a foto não abre
  definirAvatar(lixo, "undefined");
  definirAvatar(vazia, undefined);
  await new Promise((r) => setTimeout(r, 1200));
  saida.avatarFotoQuebradaViraPadrao = mostraPadrao(quebrada);
  saida.avatarUndefinedViraPadrao = mostraPadrao(lixo) && mostraPadrao(vazia);
  return saida;
});
console.log("\nNo navegador:", resultado);
const esperado = {
  chavePrivadaNaoExtraivel: true, exportouPrivada: false, textoNoEnvelope: false, abriuNoOutroAparelho: true,
  recusouOutraConversa: true, exifAntes: true, exifDepois: false, tipoDepois: "image/jpeg", recusouDisfarce: true,
  recusouAudioGrande: true, xssExecutou: false, intencaoOutroContato: false, intencaoPrimeiroUso: true, intencaoReuso: false,
  avatarSemFoto: true, avatarAceitaFoto: true, avatarFotoQuebradaViraPadrao: true, avatarUndefinedViraPadrao: true,
};
for (const [k, v] of Object.entries(esperado)) {
  if (resultado[k] !== v) { console.log(`✗ ${k}: esperava ${v}, veio ${resultado[k]}`); falhas++; }
}
if (erros.length) { console.log("exceções:", erros); falhas += erros.length; }

await browser.close();
servidor.close();
console.log(falhas ? `\n${falhas} problema(s)` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
