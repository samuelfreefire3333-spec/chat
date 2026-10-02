package main

import (
	"regexp"
	"strings"
	"testing"
)

const bucketDeTeste = "chat-parameuamor.firebasestorage.app"

func TestCaminhoDoLinkSoAceitaOBucketDoProjeto(t *testing.T) {
	bom := "https://firebasestorage.googleapis.com/v0/b/" + bucketDeTeste +
		"/o/imagens%2FuidAna123%2Fana_bruno_1726000000000.jpg?alt=media&token=abc-123"
	caminho, ok := caminhoDoLink(bom, bucketDeTeste)
	if !ok || caminho != "imagens/uidAna123/ana_bruno_1726000000000.jpg" {
		t.Fatalf("link válido recusado: %q %v", caminho, ok)
	}

	for _, ruim := range []string{
		"http://firebasestorage.googleapis.com/v0/b/" + bucketDeTeste + "/o/imagens%2Fu%2Fa.jpg",
		"https://evil.example/v0/b/" + bucketDeTeste + "/o/imagens%2Fu%2Fa.jpg",
		"https://firebasestorage.googleapis.com/v0/b/outro-bucket/o/imagens%2Fu%2Fa.jpg",
		"https://user@firebasestorage.googleapis.com/v0/b/" + bucketDeTeste + "/o/imagens%2Fu%2Fa.jpg",
		"https://firebasestorage.googleapis.com/v0/b/" + bucketDeTeste + "/o/imagens%2F..%2F..%2Fsegredo",
		"https://firebasestorage.googleapis.com/v0/b/" + bucketDeTeste + "/o/",
		"texto qualquer",
		"",
	} {
		if c, ok := caminhoDoLink(ruim, bucketDeTeste); ok {
			t.Fatalf("link %q deveria ser recusado (veio %q)", ruim, c)
		}
	}
}

func TestArquivoAntigoIdentificaPastaEDono(t *testing.T) {
	pasta, uid, nome, ok := arquivoAntigo("audios/uidBruno9/ana_bruno_1726.webm")
	if !ok || pasta != "audios" || uid != "uidBruno9" || nome != "ana_bruno_1726.webm" {
		t.Fatalf("não reconheceu: %q %q %q %v", pasta, uid, nome, ok)
	}
	for _, ruim := range []string{
		"midia/ana_bruno/uid/0b9d3a1c-6f0e-4c3b-9f9a-1c2d3e4f5a6b",
		"imagens/uid/sub/pasta.jpg",
		"imagens/uid/..",
		"imagens/uid-com-hifen/a.jpg",
		"avatares/uid/a.jpg",
	} {
		if _, _, _, ok := arquivoAntigo(ruim); ok {
			t.Fatalf("%q não é mídia antiga", ruim)
		}
	}
	if dono, ok := donoDoAvatar("avatares/uidAna123/1726000000000.jpg"); !ok || dono != "uidAna123" {
		t.Fatalf("avatar não reconhecido")
	}
}

func TestCaminhoNovoSegueAsRegras(t *testing.T) {
	// O mesmo formato que storage.rules e firestore.rules (midiaValida) aceitam.
	formato := regexp.MustCompile(`^midia/[A-Za-z0-9._-]{1,150}/[A-Za-z0-9]{1,128}/[A-Za-z0-9-]{36}$`)
	vistos := map[string]bool{}
	for i := 0; i < 200; i++ {
		c, err := caminhoNovo("ana_bruno", "uidAna123")
		if err != nil || !formato.MatchString(c) {
			t.Fatalf("caminho fora do formato: %q %v", c, err)
		}
		if vistos[c] {
			t.Fatalf("caminho repetido: %q", c)
		}
		vistos[c] = true
	}
	for _, chat := range []string{"..", ".", "a/b", ""} {
		if _, err := caminhoNovo(chat, "uid"); err == nil {
			t.Fatalf("conversa %q deveria ser recusada", chat)
		}
	}
	if _, err := caminhoNovo("ana_bruno", "uid/../x"); err == nil {
		t.Fatalf("uid com barra deveria ser recusado")
	}
}

func TestDetectarTipoIgualAoDoNavegador(t *testing.T) {
	casos := map[string]string{
		"\xff\xd8\xff\xe0JFIF":             "image/jpeg",
		"\x89PNG\r\n\x1a\n\x00\x00":        "image/png",
		"GIF89a\x01\x00":                   "image/gif",
		"RIFF\x00\x00\x00\x00WEBPVP8 ":     "image/webp",
		"\x1a\x45\xdf\xa3\x9f":             "audio/webm",
		"OggS\x00\x02":                     "audio/ogg",
		"\x00\x00\x00\x20ftypM4A ":         "audio/mp4",
		"ID3\x04\x00":                      "audio/mpeg",
		"\xff\xf1\x50\x80":                 "audio/aac",
		"<svg onload=alert(1)>":            "",
		"<!DOCTYPE html><script>":          "",
		"RIFF\x00\x00\x00\x00WAVEfmt ":     "",
		"\x00\x00\x00\x18ftypheic\x00\x00": "audio/mp4", // HEIC é ISO-BMFF: por isso a checagem por tipo de mensagem
	}
	for entrada, esperado := range casos {
		if veio := detectarTipo([]byte(entrada)); veio != esperado {
			t.Fatalf("%q: esperava %q, veio %q", entrada, esperado, veio)
		}
	}
	if tipoAceito("audio/mp4", "imagem") || tipoAceito("image/png", "audio") || !tipoAceito("image/png", "imagem") {
		t.Fatalf("tipoAceito errado")
	}
}

func TestFotoDeTerceirosEMascara(t *testing.T) {
	if !fotoDeTerceiros("https://cdn-icons-png.flaticon.com/512/149/149071.png") {
		t.Fatalf("avatar do flaticon não reconhecido")
	}
	if fotoDeTerceiros("/assets/avatar-padrao.svg") || fotoDeTerceiros("https://firebasestorage.googleapis.com/x") {
		t.Fatalf("falso positivo")
	}
	m := mascararEmail("samuel.silva@exemplo.com")
	if strings.Contains(m, "samuel.silva") || !strings.HasSuffix(m, "@exemplo.com") || !strings.HasPrefix(m, "sa") {
		t.Fatalf("máscara ruim: %q", m)
	}
	if mascararEmail("sem-arroba") != "***" {
		t.Fatalf("máscara de texto sem @")
	}
}
