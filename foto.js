import { db } from "./firebase.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import Core, { sessao, definirAvatar, atualizarPerfilEmCache, mostrar, temFotoPropria } from "./core.js";
import { enviarAvatar } from "./cloudinary.js";

const TAMANHO_MAXIMO = 400; // lado maior da imagem final
const LIMITE_ARQUIVO = 10 * 1024 * 1024;

const elPreview = document.getElementById("previewImg");
const elArquivo = document.getElementById("fileInput");
const btnSalvar = document.getElementById("btnSalvar");
const btnEscolher = document.getElementById("btnEscolher");
const btnRemover = document.getElementById("btnRemoverFoto");
const areaFoto = document.getElementById("areaFoto");
const textoEscolher = document.getElementById("textoEscolher");

let sessaoAtual = null;
let blobFinal = null;
let previewObjectURL = null;
let ocupado = false;

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

async function prepararArquivo(arquivo) {
  if (!arquivo || ocupado) return;

  if (!arquivo.type.startsWith("image/")) {
    Core.aviso("Escolha um arquivo de imagem.", "erro");
    return;
  }
  if (arquivo.size > LIMITE_ARQUIVO) {
    Core.aviso("A imagem precisa ter no máximo 10 MB.", "erro");
    return;
  }

  try {
    blobFinal = await redimensionar(arquivo);

    // Cada troca de imagem criava um objeto novo e o anterior ficava preso na
    // memória até a página ser fechada.
    if (previewObjectURL) URL.revokeObjectURL(previewObjectURL);
    previewObjectURL = URL.createObjectURL(blobFinal);

    definirAvatar(elPreview, previewObjectURL);
    mostrar(btnSalvar, true);
    mostrar(btnRemover, false);
    if (textoEscolher) textoEscolher.textContent = "Escolher outra";
    btnSalvar.focus({ preventScroll: true });
  } catch (erro) {
    console.error("Erro ao preparar a foto:", erro);
    Core.aviso(erro.message, "erro");
  }
}

function prepararFoto(evento) {
  prepararArquivo(evento.target.files?.[0]);
  // Permite escolher o mesmo arquivo de novo depois de trocar de ideia.
  evento.target.value = "";
}

function voltar() {
  if (document.referrer && !document.referrer.includes("foto.html") && window.history.length > 1) window.history.back();
  else window.location.href = "perfil.html";
}

function travar(travado, texto) {
  ocupado = travado;
  btnSalvar.disabled = travado;
  btnEscolher.disabled = travado;
  if (btnRemover) btnRemover.disabled = travado;
  areaFoto?.classList.toggle("enviando", travado);
  if (texto) btnSalvar.textContent = texto;
}

async function salvarFoto() {
  if (!blobFinal || ocupado) return;
  travar(true, "Enviando...");

  try {
    // O backend assina o envio para avatares/{uid}/{uuid}: é assim que as
    // regras do Firestore sabem que a foto é de quem está gravando, e o nome
    // aleatório impede adivinhar os avatares antigos de alguém.
    const url = await enviarAvatar(blobFinal);

    await updateDoc(doc(db, "usuarios", sessaoAtual.perfil.id), { foto: url });

    // Atualiza também o perfil já carregado nesta aba: sem isso, voltar para
    // o perfil sem recarregar continuava mostrando a foto antiga.
    atualizarPerfilEmCache({ foto: url });
    Core.aviso("Foto atualizada.", "sucesso");
    setTimeout(voltar, 900);
  } catch (erro) {
    console.error("Erro ao salvar foto:", erro);
    Core.aviso("Erro ao enviar a foto. Tente novamente.", "erro");
    travar(false, "Salvar nova foto");
  }
}

async function removerFoto() {
  if (ocupado) return;
  const ok = await Core.confirmar("Seu perfil volta a mostrar o avatar padrão.", {
    titulo: "Remover foto?",
    confirmarTexto: "Remover",
  });
  if (!ok) return;

  travar(true);
  try {
    await updateDoc(doc(db, "usuarios", sessaoAtual.perfil.id), { foto: "" });
    atualizarPerfilEmCache({ foto: "" });
    try { localStorage.removeItem("foto"); } catch (_) {}
    definirAvatar(elPreview, "");
    mostrar(btnRemover, false);
    Core.aviso("Foto removida.", "sucesso");
  } catch (erro) {
    console.error("Erro ao remover a foto:", erro);
    Core.aviso("Não foi possível remover a foto.", "erro");
  } finally {
    travar(false);
  }
}

// Arrastar e soltar (computador)
function configurarArrastar() {
  if (!areaFoto) return;
  let profundidade = 0;
  const temArquivo = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

  areaFoto.addEventListener("dragenter", (e) => {
    if (!temArquivo(e)) return;
    e.preventDefault();
    profundidade++;
    areaFoto.classList.add("arrastando");
  });
  areaFoto.addEventListener("dragover", (e) => {
    if (!temArquivo(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  areaFoto.addEventListener("dragleave", () => {
    profundidade = Math.max(0, profundidade - 1);
    if (!profundidade) areaFoto.classList.remove("arrastando");
  });
  areaFoto.addEventListener("drop", (e) => {
    e.preventDefault();
    profundidade = 0;
    areaFoto.classList.remove("arrastando");
    prepararArquivo(e.dataTransfer?.files?.[0]);
  });

  // Solto fora do círculo: não deixa o navegador abrir a imagem no lugar do app.
  window.addEventListener("dragover", (e) => { if (temArquivo(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => { if (temArquivo(e)) e.preventDefault(); });
}

async function iniciar() {
  sessaoAtual = await sessao();
  definirAvatar(elPreview, sessaoAtual.perfil.foto);
  // "Remover foto" só aparece para quem tem uma foto própria (e não o
  // avatar padrão gravado no perfil).
  mostrar(btnRemover, temFotoPropria(sessaoAtual.perfil.foto));

  elArquivo.addEventListener("change", prepararFoto);
  btnEscolher?.addEventListener("click", () => elArquivo.click());
  areaFoto?.addEventListener("click", () => { if (!ocupado) elArquivo.click(); });
  btnSalvar.addEventListener("click", salvarFoto);
  btnRemover?.addEventListener("click", removerFoto);
  configurarArrastar();

  document.querySelector('[data-acao="voltar"]')?.addEventListener("click", voltar);
}

iniciar();
