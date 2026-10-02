// ==========================================================================
// Validação de mídia (sem Firebase e sem DOM — testável no Node)
// ==========================================================================
// O navegador informa um "type" que vem da extensão do arquivo, e o Storage
// guarda o contentType que o cliente declarar. Nenhum dos dois prova nada. O
// que vale aqui é a ASSINATURA do arquivo (os primeiros bytes), conferida:
//   - por quem envia, antes de subir (erro amigável para arquivo estranho);
//   - por quem RECEBE, antes de exibir — é essa que protege, porque um cliente
//     adulterado pode subir o que quiser com o contentType que quiser.

export const TIPOS_IMAGEM = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const TIPOS_AUDIO = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac"];

export const LIMITE_IMAGEM = 10 * 1024 * 1024; // mesmo teto das regras do Storage
// O Cloudinary (plano gratuito) recusa arquivo bruto acima de 10 MB.
export const LIMITE_AUDIO = 10 * 1024 * 1024;
export const LIMITE_CIFRADO = 10 * 1024 * 1024;

// Maior lado da foto enviada no chat. Acima disso ninguém enxerga diferença
// no celular, e o arquivo fica pesado para quem recebe.
export const LADO_MAXIMO_IMAGEM = 2048;
// Imagens com mais pixels que isto nem são decodificadas (bomba de
// descompressão: um PNG pequeno que ocupa gigabytes na memória).
export const PIXELS_MAXIMOS = 40 * 1000 * 1000;

function comeca(bytes, assinatura, deslocamento = 0) {
  if (bytes.length < deslocamento + assinatura.length) return false;
  for (let i = 0; i < assinatura.length; i++) {
    if (assinatura[i] !== null && bytes[deslocamento + i] !== assinatura[i]) return false;
  }
  return true;
}

const ascii = (texto) => Array.from(texto, (c) => c.charCodeAt(0));

/**
 * Descobre o tipo real pelos primeiros bytes. Devolve um dos TIPOS_IMAGEM /
 * TIPOS_AUDIO ou null. Recebe Uint8Array (bastam os primeiros 64 bytes).
 */
export function detectarTipo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;

  if (comeca(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (comeca(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (comeca(bytes, ascii("GIF87a")) || comeca(bytes, ascii("GIF89a"))) return "image/gif";
  if (comeca(bytes, ascii("RIFF")) && comeca(bytes, ascii("WEBP"), 8)) return "image/webp";

  // Áudio gravado pelo MediaRecorder: WebM/Matroska (Chrome), Ogg (Firefox),
  // MP4/M4A (Safari). MP3 e AAC para completar.
  if (comeca(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
  if (comeca(bytes, ascii("OggS"))) return "audio/ogg";
  if (comeca(bytes, ascii("ftyp"), 4)) return "audio/mp4";
  if (comeca(bytes, ascii("ID3"))) return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac"; // ADTS
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg"; // quadro MPEG

  return null;
}

/** O tipo detectado é aceitável para a categoria esperada ("imagem"/"audio")? */
export function tipoAceito(tipoDetectado, categoria) {
  if (!tipoDetectado) return false;
  if (categoria === "imagem") return TIPOS_IMAGEM.includes(tipoDetectado);
  if (categoria === "audio") return TIPOS_AUDIO.includes(tipoDetectado);
  return false;
}

/**
 * Normaliza o tipo informado pelo gravador ("audio/webm;codecs=opus") para
 * um dos TIPOS_AUDIO, ou null.
 */
export function normalizarTipoDeAudio(tipo) {
  const base = String(tipo || "").split(";")[0].trim().toLowerCase();
  if (base === "audio/x-m4a" || base === "audio/m4a") return "audio/mp4";
  if (base === "video/webm") return "audio/webm"; // alguns navegadores rotulam assim
  return TIPOS_AUDIO.includes(base) ? base : null;
}

/** Dimensões finais de uma imagem mantendo a proporção. */
export function dimensoesReduzidas(largura, altura, ladoMaximo = LADO_MAXIMO_IMAGEM) {
  const l = Math.max(1, Math.round(largura));
  const a = Math.max(1, Math.round(altura));
  const maior = Math.max(l, a);
  if (maior <= ladoMaximo) return { largura: l, altura: a };
  const escala = ladoMaximo / maior;
  return { largura: Math.max(1, Math.round(l * escala)), altura: Math.max(1, Math.round(a * escala)) };
}

/** Identificador aleatório (UUID v4) para nomes de arquivo e de aparelho. */
export function idAleatorio() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const RE_CAMINHO = /^midia\/([A-Za-z0-9._-]{1,150})\/([A-Za-z0-9]{1,128})\/([A-Za-z0-9-]{36})$/;

/**
 * Confere um caminho de mídia privada: midia/{chatId}/{uid}/{uuid}.
 * chatIdEsperado: a conversa aberta. Numa conversa protegida o caminho vem de
 * dentro da mensagem cifrada — as regras do Firestore não o enxergam — então
 * é aqui que se garante que a mensagem só aponta para arquivos DESTA conversa.
 */
export function caminhoDeMidiaValido(caminho, chatIdEsperado) {
  const m = RE_CAMINHO.exec(String(caminho || ""));
  if (!m) return false;
  if (m[1] === "." || m[1] === "..") return false;
  return !chatIdEsperado || m[1] === chatIdEsperado;
}
