// ==========================================================================
// Cloudinary — onde ficam as fotos de perfil e a mídia das conversas
// ==========================================================================
// O plano gratuito do Firebase não tem Storage, então os arquivos vão para o
// Cloudinary. O envio é sempre ASSINADO pelo backend (POST /midia/assinar):
// o servidor confere o login, escolhe o destino do arquivo e devolve uma
// assinatura que vale só para aquele destino. O segredo da conta nunca chega
// ao navegador, e ninguém de fora consegue subir arquivo na conta.
//
// Limitação conhecida (SEGURANCA.md): no Cloudinary o arquivo é entregue por
// link. O link da mídia de conversa tem um UUID aleatório e não aparece em
// lugar público, mas quem tiver o link abre o arquivo sem login. Na conversa
// protegida (E2EE) o arquivo sobe cifrado, então o link só entrega bytes
// ilegíveis.

import { auth } from "./firebase.js";

/** Nome da conta ("cloud name"). Público: aparece em todo link de arquivo. */
export const NUVEM = "ra4qbowm";

const URL_BACKEND = "https://sinex-backend-go.onrender.com";
const HOST_ENTREGA = "res.cloudinary.com";
const HOST_ENVIO = "api.cloudinary.com";

export class ErroDeEnvio extends Error {
  constructor(mensagem, codigo = "") {
    super(mensagem);
    this.name = "ErroDeEnvio";
    this.codigo = codigo;
  }
}

/** Link de entrega de um arquivo bruto (mídia de conversa) pelo caminho. */
export function urlDoArquivo(caminho) {
  return `https://${HOST_ENTREGA}/${NUVEM}/raw/upload/${caminho.split("/").map(encodeURIComponent).join("/")}`;
}

/** true se a URL é uma foto de perfil guardada na conta do app. */
export function ehFotoDoCloudinary(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === HOST_ENTREGA
      && u.pathname.startsWith(`/${NUVEM}/image/upload/`);
  } catch (_) {
    return false;
  }
}

async function pedirAssinatura(pedido) {
  const usuario = auth.currentUser;
  if (!usuario) throw new ErroDeEnvio("Sua sessão expirou. Entre de novo.", "nao_autenticado");
  const token = await usuario.getIdToken();

  let resposta;
  try {
    resposta = await fetch(`${URL_BACKEND}/midia/assinar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(pedido),
    });
  } catch (_) {
    throw new ErroDeEnvio("Sem conexão com o servidor. Tente de novo.", "rede");
  }
  if (!resposta.ok) {
    let codigo = "";
    try { codigo = (await resposta.json()).erro || ""; } catch (_) {}
    if (resposta.status === 403) throw new ErroDeEnvio("Sem permissão para enviar nesta conversa.", codigo);
    if (resposta.status === 429) throw new ErroDeEnvio("Muitos envios em pouco tempo. Aguarde um minuto.", codigo);
    if (resposta.status === 401) throw new ErroDeEnvio("Sua sessão expirou. Entre de novo.", codigo);
    throw new ErroDeEnvio("O envio de arquivos está indisponível agora.", codigo);
  }
  const dados = await resposta.json();
  // O destino tem de ser a conta do app: nunca envia para onde uma resposta
  // adulterada mandar.
  if (dados?.nuvem !== NUVEM || !dados.assinatura || !dados.parametros?.public_id
    || (dados.recurso !== "raw" && dados.recurso !== "image")) {
    throw new ErroDeEnvio("O envio de arquivos está indisponível agora.", "resposta_invalida");
  }
  return dados;
}

async function enviar(assinado, blob) {
  const corpo = new FormData();
  for (const [chave, valor] of Object.entries(assinado.parametros)) corpo.append(chave, valor);
  corpo.append("api_key", assinado.chaveApi);
  corpo.append("signature", assinado.assinatura);
  corpo.append("file", blob);

  let resposta;
  try {
    resposta = await fetch(`https://${HOST_ENVIO}/v1_1/${NUVEM}/${assinado.recurso}/upload`, { method: "POST", body: corpo });
  } catch (_) {
    throw new ErroDeEnvio("Falha de conexão ao enviar o arquivo.", "rede");
  }
  if (!resposta.ok) {
    console.error("Cloudinary recusou o envio:", resposta.status);
    throw new ErroDeEnvio("Não foi possível enviar o arquivo.", `cloudinary_${resposta.status}`);
  }
  return resposta.json();
}

/**
 * Reserva o destino de uma mídia de conversa. Devolve o caminho
 * (midia/{chatId}/{uid}/{uuid}) e a função que envia os bytes para ele.
 * São dois passos porque a conversa protegida cifra o arquivo PRESO ao
 * caminho — o caminho precisa existir antes de cifrar.
 */
export async function reservarMidia(chatId) {
  const assinado = await pedirAssinatura({ destino: "midia", chatId });
  return {
    caminho: assinado.parametros.public_id,
    enviar: (blob) => enviar(assinado, blob),
  };
}

/** Envia a foto de perfil (JPEG) e devolve o link para gravar no perfil. */
export async function enviarAvatar(blob) {
  const assinado = await pedirAssinatura({ destino: "avatar" });
  const resultado = await enviar(assinado, blob);
  const url = resultado?.secure_url;
  if (!ehFotoDoCloudinary(url)) throw new ErroDeEnvio("Não foi possível enviar a foto.", "resposta_invalida");
  return url;
}
