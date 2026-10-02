// Testes da validação de mídia. Rodar: node --test testes/js/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectarTipo, tipoAceito, normalizarTipoDeAudio, dimensoesReduzidas,
  idAleatorio, caminhoDeMidiaValido,
} from "../../midia-validacao.js";

const bytes = (...partes) => new Uint8Array(partes.flatMap((p) => (typeof p === "string" ? Array.from(p, (c) => c.charCodeAt(0)) : p)));

test("detecta o tipo real pelos primeiros bytes", () => {
  assert.equal(detectarTipo(bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF")), "image/jpeg");
  assert.equal(detectarTipo(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), "image/png");
  assert.equal(detectarTipo(bytes("GIF89a", [1, 0])), "image/gif");
  assert.equal(detectarTipo(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")), "image/webp");
  assert.equal(detectarTipo(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f])), "audio/webm");
  assert.equal(detectarTipo(bytes("OggS", [0, 2])), "audio/ogg");
  assert.equal(detectarTipo(bytes([0, 0, 0, 0x20], "ftypM4A ")), "audio/mp4");
  assert.equal(detectarTipo(bytes("ID3", [4, 0])), "audio/mpeg");
  assert.equal(detectarTipo(bytes([0xff, 0xf1, 0x50, 0x80])), "audio/aac");
});

test("não aceita arquivo disfarçado", () => {
  // HTML/SVG/script com extensão de imagem: não tem assinatura de imagem.
  assert.equal(detectarTipo(bytes("<!DOCTYPE html><script>alert(1)</script>")), null);
  assert.equal(detectarTipo(bytes("<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\">")), null);
  assert.equal(detectarTipo(bytes("MZ", [0x90, 0])), null); // executável do Windows
  assert.equal(detectarTipo(bytes("%PDF-1.7")), null);
  assert.equal(detectarTipo(bytes("PK", [3, 4])), null); // zip
  assert.equal(detectarTipo(new Uint8Array(2)), null);
  assert.equal(detectarTipo("não é bytes"), null);

  // RIFF que não é WEBP (WAV) não passa como imagem.
  assert.equal(detectarTipo(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), null);

  // Tipo certo na categoria errada.
  assert.equal(tipoAceito("audio/webm", "imagem"), false);
  assert.equal(tipoAceito("image/png", "audio"), false);
  assert.equal(tipoAceito(null, "imagem"), false);
  assert.equal(tipoAceito("image/png", "imagem"), true);
});

test("normaliza o tipo informado pelo gravador de áudio", () => {
  assert.equal(normalizarTipoDeAudio("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normalizarTipoDeAudio("audio/mp4"), "audio/mp4");
  assert.equal(normalizarTipoDeAudio("audio/x-m4a"), "audio/mp4");
  assert.equal(normalizarTipoDeAudio("text/html"), null);
  assert.equal(normalizarTipoDeAudio(""), null);
});

test("reduz dimensões mantendo a proporção", () => {
  assert.deepEqual(dimensoesReduzidas(4000, 3000, 2048), { largura: 2048, altura: 1536 });
  assert.deepEqual(dimensoesReduzidas(1000, 800, 2048), { largura: 1000, altura: 800 });
  assert.deepEqual(dimensoesReduzidas(1, 10000, 2048), { largura: 1, altura: 2048 });
});

test("IDs aleatórios são UUID v4 e não se repetem", () => {
  const vistos = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = idAleatorio();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vistos.add(id);
  }
  assert.equal(vistos.size, 1000);
});

test("caminho de mídia privada: só dentro da conversa, sem travessia", () => {
  const uuid = "0b9d3a1c-6f0e-4c3b-9f9a-1c2d3e4f5a6b";
  assert.equal(caminhoDeMidiaValido(`midia/ana_bruno/uidAna123/${uuid}`, "ana_bruno"), true);
  assert.equal(caminhoDeMidiaValido(`midia/ana_bruno/uidAna123/${uuid}`, "bruno_carla"), false);
  for (const ruim of [
    `midia/../usuarios/x/${uuid}`,
    `midia/ana_bruno/uidAna123/../../${uuid}`,
    `imagens/uidAna123/${uuid}`,
    `midia/ana_bruno/uidAna123/${uuid}.html`,
    `https://evil.example/midia/ana_bruno/uid/${uuid}`,
    `midia/ana_bruno/uid-com-hifen/${uuid}`,
    `midia/../uidAna123/${uuid}`,
    `midia/./uidAna123/${uuid}`,
    "",
    null,
  ]) {
    assert.equal(caminhoDeMidiaValido(ruim), false, String(ruim));
  }
});
