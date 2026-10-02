package main

// Funções sem rede nem Firebase — testadas em puro_test.go.

import (
	"crypto/rand"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var (
	reUsername     = regexp.MustCompile(`^[a-z0-9._-]{1,64}$`)
	reIDDeConversa = regexp.MustCompile(`^[A-Za-z0-9._-]{1,150}$`)
	reUID          = regexp.MustCompile(`^[A-Za-z0-9]{1,128}$`)
	// imagens/{uid}/{chatId}_{Date.now()}.{ext} e audios/{uid}/... (app antigo).
	reCaminhoAntigo = regexp.MustCompile(`^(imagens|audios)/([A-Za-z0-9]{1,128})/([A-Za-z0-9._-]{1,200})$`)
	reAvatar        = regexp.MustCompile(`^avatares/([A-Za-z0-9]{1,128})/([A-Za-z0-9._-]{1,200})$`)
)

func usernameValido(s string) bool { return reUsername.MatchString(s) }

func idDeConversaValido(s string) bool {
	return reIDDeConversa.MatchString(s) && s != "." && s != ".."
}

// caminhoDoLink extrai o caminho do objeto de um link de download do
// Firebase Storage (https://firebasestorage.googleapis.com/v0/b/{bucket}/o/
// {caminho codificado}?alt=media&token=...). Só aceita o bucket do projeto.
func caminhoDoLink(link, bucket string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme != "https" || u.Host != "firebasestorage.googleapis.com" || u.User != nil {
		return "", false
	}
	prefixo := "/v0/b/" + bucket + "/o/"
	bruto := u.EscapedPath()
	if !strings.HasPrefix(bruto, prefixo) {
		return "", false
	}
	caminho, err := url.PathUnescape(strings.TrimPrefix(bruto, prefixo))
	if err != nil || caminho == "" {
		return "", false
	}
	for _, parte := range strings.Split(caminho, "/") {
		if parte == "" || parte == "." || parte == ".." {
			return "", false
		}
	}
	return caminho, true
}

// arquivoAntigo diz se o caminho é de uma mídia do app antigo e de quem é.
func arquivoAntigo(caminho string) (pasta, uid, nome string, ok bool) {
	m := reCaminhoAntigo.FindStringSubmatch(caminho)
	if m == nil || m[3] == "." || m[3] == ".." {
		return "", "", "", false
	}
	return m[1], m[2], m[3], true
}

// donoDoAvatar devolve o uid dono de um arquivo em avatares/.
func donoDoAvatar(caminho string) (string, bool) {
	m := reAvatar.FindStringSubmatch(caminho)
	if m == nil || m[2] == "." || m[2] == ".." {
		return "", false
	}
	return m[1], true
}

// caminhoNovo monta midia/{chatId}/{uid}/{uuid} — o formato que as regras do
// Storage e do Firestore aceitam.
func caminhoNovo(chatID, uid string) (string, error) {
	if !idDeConversaValido(chatID) || !reUID.MatchString(uid) {
		return "", fmt.Errorf("conversa ou uid fora do formato")
	}
	id, err := novoUUID()
	if err != nil {
		return "", err
	}
	return "midia/" + chatID + "/" + uid + "/" + id, nil
}

// novoUUID gera um UUID v4 com crypto/rand.
func novoUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

var (
	tiposDeImagem = map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true}
	tiposDeAudio  = map[string]bool{"audio/webm": true, "audio/ogg": true, "audio/mp4": true, "audio/mpeg": true, "audio/aac": true}
)

func comeca(b []byte, assinatura string, deslocamento int) bool {
	if len(b) < deslocamento+len(assinatura) {
		return false
	}
	return string(b[deslocamento:deslocamento+len(assinatura)]) == assinatura
}

// detectarTipo é o mesmo detector do midia-validacao.js (assinatura real do
// arquivo, não o contentType declarado).
func detectarTipo(b []byte) string {
	if len(b) < 4 {
		return ""
	}
	switch {
	case comeca(b, "\xff\xd8\xff", 0):
		return "image/jpeg"
	case comeca(b, "\x89PNG\r\n\x1a\n", 0):
		return "image/png"
	case comeca(b, "GIF87a", 0) || comeca(b, "GIF89a", 0):
		return "image/gif"
	case comeca(b, "RIFF", 0) && comeca(b, "WEBP", 8):
		return "image/webp"
	case comeca(b, "\x1a\x45\xdf\xa3", 0):
		return "audio/webm"
	case comeca(b, "OggS", 0):
		return "audio/ogg"
	case comeca(b, "ftyp", 4):
		return "audio/mp4"
	case comeca(b, "ID3", 0):
		return "audio/mpeg"
	case b[0] == 0xff && b[1]&0xf6 == 0xf0:
		return "audio/aac"
	case b[0] == 0xff && b[1]&0xe0 == 0xe0:
		return "audio/mpeg"
	}
	return ""
}

// tipoAceito confere o tipo detectado contra o tipo da mensagem.
func tipoAceito(tipo, tipoDaMensagem string) bool {
	switch tipoDaMensagem {
	case "imagem":
		return tiposDeImagem[tipo]
	case "audio":
		return tiposDeAudio[tipo]
	}
	return false
}

// limiteDeTamanho segue as regras do Storage (e o teto de 16 MiB do Firestore).
func limiteDeTamanho(tipoDaMensagem string) int64 {
	if tipoDaMensagem == "audio" {
		return 15 * 1024 * 1024
	}
	return 10 * 1024 * 1024
}

// fotoDeTerceiros identifica o avatar antigo hospedado num site de ícones.
func fotoDeTerceiros(foto string) bool {
	u, err := url.Parse(strings.TrimSpace(foto))
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "cdn-icons-png.flaticon.com" || strings.HasSuffix(host, ".flaticon.com")
}

// mascararEmail deixa o e-mail reconhecível para quem administra sem
// expor o endereço inteiro no terminal ou em log.
func mascararEmail(email string) string {
	arroba := strings.LastIndex(email, "@")
	if arroba <= 0 {
		return "***"
	}
	usuario, dominio := email[:arroba], email[arroba+1:]
	if len(usuario) <= 2 {
		return strings.Repeat("*", len(usuario)) + "@" + dominio
	}
	return usuario[:2] + strings.Repeat("*", len(usuario)-2) + "@" + dominio
}
