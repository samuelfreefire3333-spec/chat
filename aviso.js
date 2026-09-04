import { destinoSeguro } from "./core.js";

const ICONES = { error: "❌", success: "✅", ban: "🚫", info: "ℹ️" };

const params = new URLSearchParams(window.location.search);

const titulo = params.get("t");
const mensagem = params.get("m");
const tipo = params.get("type");

// textContent, e não innerHTML: o conteúdo vem da URL, que qualquer um
// consegue montar.
if (titulo) document.getElementById("avisoTitulo").textContent = titulo;
if (mensagem) document.getElementById("avisoMensagem").textContent = mensagem;

const iconeEl = document.getElementById("avisoIcon");
iconeEl.textContent = ICONES[tipo] || "⚠️";

document.getElementById("btnFecharAviso").addEventListener("click", () => {
  const pedido = params.get("r");

  // destinoSeguro só aceita páginas locais do app. Antes o valor de ?r= ia
  // direto para location.replace(), o que permitia tanto redirecionar para
  // fora (?r=//site-externo) quanto executar script (?r=javascript:...).
  if (pedido) {
    window.location.replace(destinoSeguro(pedido));
    return;
  }

  if (document.referrer && !document.referrer.includes("aviso.html")) {
    window.history.back();
  } else {
    window.location.replace("inbox.html");
  }
});
