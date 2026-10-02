// ==========================================================================
// Mídia privada das conversas (fotos e áudios)
// ==========================================================================
// Os arquivos ficam no Cloudinary (cloudinary.js), porque o plano gratuito do
// Firebase não tem Storage:
//   - o backend confere que quem envia participa da conversa e assina o
//     envio para midia/{chatId}/{uid}/{uuid} — o UUID é sorteado no servidor;
//   - a mensagem guarda o CAMINHO, não um link;
//   - quem recebe baixa pelo caminho, confere a assinatura real do arquivo e
//     mostra por uma URL blob: local, que só existe naquela aba;
//   - na conversa protegida o arquivo sobe cifrado;
//   - limitação: fora da conversa protegida, quem souber o link (que tem o
//     UUID aleatório) abre o arquivo sem login — ver SEGURANCA.md;
//   - fotos são redesenhadas no navegador antes de subir: some o EXIF (GPS,
//     modelo do celular, data) e qualquer coisa escondida no arquivo.
//
// Mensagens antigas continuam com o link antigo até a migração
// (cmd/migrar-seguranca) mover os arquivos e revogar os links.

import { reservarMidia, urlDoArquivo, ErroDeEnvio } from "./cloudinary.js";
import {
  detectarTipo, tipoAceito, normalizarTipoDeAudio, dimensoesReduzidas,
  caminhoDeMidiaValido, LIMITE_IMAGEM, LIMITE_AUDIO, LIMITE_CIFRADO, PIXELS_MAXIMOS,
} from "./midia-validacao.js";
import { cifrarArquivo, decifrarArquivo } from "./e2ee-cripto.js";

export class ErroDeMidia extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = "ErroDeMidia";
  }
}

async function cabeca(blob, n = 64) {
  return new Uint8Array(await blob.slice(0, n).arrayBuffer());
}

function carregarImagem(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ErroDeMidia("Formato de imagem não suportado."));
    };
    img.src = url;
  });
}

function canvasParaBlob(canvas, tipo, qualidade) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ErroDeMidia("Falha ao processar a imagem."))), tipo, qualidade);
  });
}

/**
 * Prepara uma foto para envio. Redesenha no canvas (o que descarta EXIF/GPS
 * e bytes extras), reduz para no máximo 2048 px no maior lado e confere o
 * resultado. GIF passa como está, para não perder a animação — GIF não
 * carrega GPS.
 */
export async function prepararImagem(arquivo) {
  if (!arquivo || !arquivo.size) throw new ErroDeMidia("Arquivo vazio.");
  // Teto de entrada generoso (a foto ainda vai encolher), mas finito.
  if (arquivo.size > 3 * LIMITE_IMAGEM) throw new ErroDeMidia("A imagem é grande demais.");

  const tipoOriginal = detectarTipo(await cabeca(arquivo));
  if (tipoOriginal === "image/gif") {
    if (arquivo.size >= LIMITE_IMAGEM) throw new ErroDeMidia("O GIF precisa ter menos de 10 MB.");
    return { blob: arquivo, mime: "image/gif" };
  }

  // HEIC e afins: quem decide se decodifica é o navegador (o Safari decodifica).
  const img = await carregarImagem(arquivo);
  const larguraOriginal = img.naturalWidth;
  const alturaOriginal = img.naturalHeight;
  if (!larguraOriginal || !alturaOriginal) throw new ErroDeMidia("Imagem inválida.");
  if (larguraOriginal * alturaOriginal > PIXELS_MAXIMOS) throw new ErroDeMidia("A imagem tem resolução grande demais.");

  const { largura, altura } = dimensoesReduzidas(larguraOriginal, alturaOriginal);
  const canvas = document.createElement("canvas");
  canvas.width = largura;
  canvas.height = altura;
  const ctx = canvas.getContext("2d");
  const comTransparencia = tipoOriginal === "image/png";
  if (!comTransparencia) {
    // JPEG não tem transparência: fundo branco em vez de preto.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, largura, altura);
  }
  ctx.drawImage(img, 0, 0, largura, altura);

  let blob = await canvasParaBlob(canvas, comTransparencia ? "image/png" : "image/jpeg", 0.85);
  if (blob.size >= LIMITE_IMAGEM && comTransparencia) {
    blob = await canvasParaBlob(canvas, "image/jpeg", 0.85);
  }
  const mime = detectarTipo(await cabeca(blob));
  if (!tipoAceito(mime, "imagem")) throw new ErroDeMidia("Falha ao processar a imagem.");
  if (blob.size >= LIMITE_IMAGEM) throw new ErroDeMidia("A imagem precisa ter menos de 10 MB.");
  return { blob, mime, largura, altura };
}

/** Confere um áudio gravado pelo MediaRecorder antes de subir. */
export async function prepararAudio(blob, tipoDoGravador) {
  if (!blob || !blob.size) throw new ErroDeMidia("Áudio vazio.");
  if (blob.size >= LIMITE_AUDIO) throw new ErroDeMidia("O áudio ficou grande demais.");
  const detectado = detectarTipo(await cabeca(blob));
  const informado = normalizarTipoDeAudio(tipoDoGravador);
  const mime = tipoAceito(detectado, "audio") ? detectado : null;
  if (!mime) throw new ErroDeMidia("Formato de áudio não reconhecido.");
  if (informado && informado !== mime) {
    // O gravador rotulou diferente do que gravou: vale o conteúdo.
    console.warn(`Áudio rotulado como ${informado}, mas o conteúdo é ${mime}.`);
  }
  return { blob, mime };
}

// O destino vem do servidor; confere que é desta conversa e desta conta antes
// de gravar o caminho na mensagem.
async function reservar(chatId, uid) {
  let reserva;
  try {
    reserva = await reservarMidia(chatId);
  } catch (err) {
    if (err instanceof ErroDeEnvio) throw new ErroDeMidia(err.message);
    throw err;
  }
  if (!caminhoDeMidiaValido(reserva.caminho, chatId) || reserva.caminho.split("/")[2] !== uid) {
    throw new ErroDeMidia("O envio de arquivos está indisponível agora.");
  }
  return reserva;
}

async function subir(reserva, blob) {
  try {
    await reserva.enviar(blob);
  } catch (err) {
    if (err instanceof ErroDeEnvio) throw new ErroDeMidia(err.message);
    throw err;
  }
}

/** Sobe a mídia de uma conversa comum. Devolve o descritor da mensagem. */
export async function enviarMidia({ chatId, uid, blob, mime, extras = {} }) {
  const reserva = await reservar(chatId, uid);
  await subir(reserva, blob);
  return { caminho: reserva.caminho, mime, tamanho: blob.size, ...extras };
}

/**
 * Sobe a mídia de uma conversa protegida: cifrada no aparelho, com chave
 * própria que viaja DENTRO da mensagem cifrada. O Cloudinary só vê bytes
 * aleatórios.
 */
export async function enviarMidiaCifrada({ chatId, uid, blob, mime, extras = {} }) {
  const reserva = await reservar(chatId, uid);
  const caminho = reserva.caminho;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { cifrado, chave, iv } = await cifrarArquivo(bytes, caminho);
  if (cifrado.length >= LIMITE_CIFRADO) throw new ErroDeMidia("O arquivo ficou grande demais.");
  await subir(reserva, new Blob([cifrado], { type: "application/octet-stream" }));
  return { caminho, mime, k: chave, iv, tamanho: blob.size, ...extras };
}

// --------------------------------------------------------------------------
// Download com cache por aba
// --------------------------------------------------------------------------

const MAXIMO_EM_CACHE = 150;
const cache = new Map(); // caminho -> { promessa, url }

function guardar(caminho, item) {
  cache.set(caminho, item);
  while (cache.size > MAXIMO_EM_CACHE) {
    const [maisAntigo, dados] = cache.entries().next().value;
    cache.delete(maisAntigo);
    if (dados.url) URL.revokeObjectURL(dados.url);
  }
}

/**
 * Devolve uma URL blob: com a mídia, pronta para <img>/<audio>.
 * categoria: "imagem" | "audio". cifra: { k, iv } na conversa protegida.
 * chatId: a conversa aberta — a mídia tem de ser dela.
 */
export function urlDaMidia(caminho, categoria, cifra = null, chatId = null) {
  if (!caminhoDeMidiaValido(caminho, chatId)) return Promise.reject(new ErroDeMidia("Mídia com caminho inválido."));

  // A chave do cache inclui a chave de cifra: outra mensagem apontando para o
  // mesmo arquivo com outra chave não reaproveita o que já foi aberto.
  const chave = cifra ? `${caminho}#${cifra.k}#${cifra.iv}` : caminho;
  const existente = cache.get(chave);
  if (existente) {
    // Reposiciona no fim (usado há pouco).
    cache.delete(chave);
    cache.set(chave, existente);
    return existente.promessa;
  }

  const item = { url: null, promessa: null };
  item.promessa = (async () => {
    const maximo = cifra ? LIMITE_CIFRADO : (categoria === "audio" ? LIMITE_AUDIO : LIMITE_IMAGEM);
    let resposta;
    try {
      // Sem cookies nem cabeçalhos: é um GET simples ao link do arquivo.
      resposta = await fetch(urlDoArquivo(caminho), { credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (err) {
      console.error("Falha ao baixar mídia:", err);
      throw new ErroDeMidia("Não foi possível carregar a mídia.");
    }
    if (resposta.status === 404) throw new ErroDeMidia("Esta mídia não existe mais.");
    if (!resposta.ok) throw new ErroDeMidia("Não foi possível carregar a mídia.");
    const blob = await resposta.blob();
    if (blob.size > maximo) throw new ErroDeMidia("O arquivo recebido é grande demais.");
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (cifra) bytes = await decifrarArquivo(bytes, caminho, cifra.k, cifra.iv);

    // Quem recebe confere o tipo real. É esta checagem que protege: um cliente
    // adulterado consegue subir qualquer coisa com o contentType que quiser.
    const tipo = detectarTipo(bytes.subarray(0, 64));
    if (!tipoAceito(tipo, categoria)) throw new ErroDeMidia("O arquivo recebido não é uma mídia válida.");

    item.url = URL.createObjectURL(new Blob([bytes], { type: tipo }));
    return item.url;
  })();
  item.promessa.catch(() => cache.delete(chave));
  guardar(chave, item);
  return item.promessa;
}

/** Solta as URLs blob: desta aba (ao sair da conversa). */
export function liberarMidias() {
  for (const item of cache.values()) {
    if (item.url) URL.revokeObjectURL(item.url);
  }
  cache.clear();
}
