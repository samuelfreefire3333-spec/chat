import { db, storage } from "./firebase.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import Core, { sessao, definirAvatar } from "./core.js";

const TAMANHO_MAXIMO = 400; // lado maior da imagem final
const LIMITE_ARQUIVO = 10 * 1024 * 1024;

const elPreview = document.getElementById("previewImg");
const elArquivo = document.getElementById("fileInput");
const btnSalvar = document.getElementById("btnSalvar");
const btnEscolher = document.getElementById("btnEscolher");

let sessaoAtual = null;
let blobFinal = null;

/** Redimensiona no navegador para não subir uma foto de 8 MP como avatar. */
function redimensionar(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();

    leitor.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Arquivo de imagem inválido."));
      img.onload = () => {
        let { width, height } = img;

        if (width > height && width > TAMANHO_MAXIMO) {
          height = Math.round(height * (TAMANHO_MAXIMO / width));
          width = TAMANHO_MAXIMO;
        } else if (height >= width && height > TAMANHO_MAXIMO) {
          width = Math.round(width * (TAMANHO_MAXIMO / height));
          height = TAMANHO_MAXIMO;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);

        // toBlob em vez de toDataURL: sobe os bytes direto, sem inflar 33%
        // em base64 no meio do caminho.
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Falha ao processar a imagem."))),
          "image/jpeg",
          0.85
        );
      };
      img.src = leitor.result;
    };

    leitor.readAsDataURL(arquivo);
  });
}

async function prepararFoto(evento) {
  const arquivo = evento.target.files?.[0];
  if (!arquivo) return;

  if (!arquivo.type.startsWith("image/")) {
    Core.aviso("Escolha um arquivo de imagem.", "#ed4956");
    return;
  }
  if (arquivo.size > LIMITE_ARQUIVO) {
    Core.aviso("A imagem precisa ter no máximo 10 MB.", "#ed4956");
    return;
  }

  try {
    blobFinal = await redimensionar(arquivo);
    elPreview.src = URL.createObjectURL(blobFinal);
    btnSalvar.style.display = "flex";
  } catch (erro) {
    console.error("Erro ao preparar a foto:", erro);
    Core.aviso(erro.message, "#ed4956");
  }
}

async function salvarFoto() {
  if (!blobFinal) return;

  btnSalvar.textContent = "Enviando...";
  btnSalvar.disabled = true;

  try {
    // O uid está no caminho: é assim que as regras do Storage sabem que o
    // arquivo é de quem está enviando. cacheControl agressivo porque cada
    // envio gera um nome novo (Date.now()) — o conteúdo nunca muda depois.
    const destino = ref(storage, `avatares/${sessaoAtual.user.uid}/${Date.now()}.jpg`);
    await uploadBytes(destino, blobFinal, {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    });
    const url = await getDownloadURL(destino);

    await updateDoc(doc(db, "usuarios", sessaoAtual.perfil.id), { foto: url });

    try { localStorage.setItem("foto", url); } catch (_) {}
    Core.aviso("Foto atualizada com sucesso!", "#00a884");

    setTimeout(() => {
      if (document.referrer && !document.referrer.includes("foto.html")) window.history.back();
      else window.location.href = "perfil.html";
    }, 900);
  } catch (erro) {
    console.error("Erro ao salvar foto:", erro);
    Core.aviso("Erro ao enviar a foto. Tente novamente.", "#ed4956");
    btnSalvar.textContent = "Salvar Nova Foto";
    btnSalvar.disabled = false;
  }
}

async function iniciar() {
  sessaoAtual = await sessao();
  if (sessaoAtual.perfil.foto) definirAvatar(elPreview, sessaoAtual.perfil.foto);

  elArquivo.addEventListener("change", prepararFoto);
  btnEscolher?.addEventListener("click", () => elArquivo.click());
  btnSalvar.addEventListener("click", salvarFoto);

  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", () => {
    if (document.referrer) window.history.back();
    else window.location.href = "perfil.html";
  });
}

iniciar();