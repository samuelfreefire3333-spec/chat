package main

import (
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
)

// Message é o envelope trocado com o cliente pelo WebSocket. From é sempre
// preenchido pelo servidor a partir do token verificado — o valor que o
// cliente mandar em From é descartado.
type Message struct {
	Type      string          `json:"type"`
	From      string          `json:"from"`
	To        string          `json:"to"`
	Content   string          `json:"content,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Timestamp int64           `json:"timestamp,omitempty"`
	LastSeen  int64           `json:"lastSeen,omitempty"`
}

const (
	// Teto de um quadro depois de autenticado: cabe uma oferta SDP folgada.
	maxTamanhoQuadro = 64 * 1024
	// Antes da autenticação só é aceito o quadro {"type":"auth","token":...}.
	// Um ID token do Firebase tem por volta de 1 KB.
	maxTamanhoQuadroAuth = 8 * 1024

	maxTamanhoSDP        = 32 * 1024
	maxTamanhoCandidato  = 1024
	maxAlvosStatusLote   = 200
	maxTamanhoIDConversa = 150
)

// Códigos devolvidos ao cliente em {"type":"erro","content":<código>}.
// Nunca carregam detalhe interno.
const (
	erroQuadroInvalido = "quadro_invalido"
	erroNaoAutorizado  = "nao_autorizado"
	erroLimite         = "limite_excedido"
	erroIndisponivel   = "indisponivel"
)

var (
	reUsername = regexp.MustCompile(`^[a-z0-9._-]{1,64}$`)
	reIDDoc    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,150}$`)
)

// usernameValido confere o formato de um @. Só letras minúsculas, dígitos,
// ponto, hífen e sublinhado — o mesmo que o cadastro produz. Nada de "/"
// (que viraria caminho no Firestore) nem de caracteres de controle.
func usernameValido(u string) bool {
	return reUsername.MatchString(u) && u != "." && u != ".."
}

// idDeConversaValido confere um ID de documento de "chats". Os IDs reservados
// do Firestore (__nome__) e "."/".." são recusados.
func idDeConversaValido(id string) bool {
	if !reIDDoc.MatchString(id) || id == "." || id == ".." {
		return false
	}
	return !(strings.HasPrefix(id, "__") && strings.HasSuffix(id, "__"))
}

// IDConversaDireta é o mesmo idDoChat() do core.js: os dois @ em ordem
// alfabética unidos por "_".
func IDConversaDireta(a, b string) string {
	par := []string{strings.ToLower(strings.TrimSpace(a)), strings.ToLower(strings.TrimSpace(b))}
	sort.Strings(par)
	return par[0] + "_" + par[1]
}

// Tipos de quadro aceitos de um cliente.
const (
	tipoChat            = "chat"
	tipoDigitando       = "digitando"
	tipoParouDigitando  = "parou_digitando"
	tipoStatusCheck     = "status_check"
	tipoStatusLote      = "status_lote"
	tipoChamada         = "chamada"
	tipoCancelarChamada = "cancelar_chamada"
	tipoWebRTC          = "webrtc"
	tipoPing            = "ping"
)

var conteudosWebRTC = map[string]bool{
	"oferta": true, "resposta": true, "ice": true, "pronto": true,
	"estado": true, "tocando": true, "consultar_toque": true,
}

var conteudosCancelar = map[string]bool{"recusada": true, "encerrada": true, "cancelada": true}

var conteudosChamada = map[string]bool{"audio": true, "video": true}

// quadroValidado é o resultado da validação: a mensagem já reconstruída (só
// com campos conhecidos) e a conversa que autoriza o repasse, se houver.
type quadroValidado struct {
	msg Message
	// conversa a conferir antes de repassar ("" = não repassa a ninguém,
	// como ping e presença).
	conversa string
	// alvos de presença (status_check/status_lote), já validados.
	alvos []string
}

var errQuadroInvalido = errors.New("quadro invalido")

type payloadConversa struct {
	ChatID string `json:"chatId"`
}

type payloadTocando struct {
	Ocupado bool `json:"ocupado"`
}

type payloadEstado struct {
	Mic *bool `json:"mic,omitempty"`
	Cam *bool `json:"cam,omitempty"`
}

type payloadDescricao struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

type payloadCandidato struct {
	Candidate        string  `json:"candidate"`
	SdpMid           *string `json:"sdpMid"`
	SdpMLineIndex    *int    `json:"sdpMLineIndex"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// validarQuadro confere um quadro vindo do cliente "remetente" e devolve uma
// cópia reconstruída campo a campo. Nada do que o cliente mandou é repassado
// sem passar por aqui: campo desconhecido some, texto livre não passa.
func validarQuadro(bruto Message, remetente string) (quadroValidado, error) {
	tipo := bruto.Type
	para := strings.ToLower(strings.TrimSpace(bruto.To))
	saida := Message{Type: tipo, From: remetente}

	exigirDestino := func() error {
		if !usernameValido(para) || para == remetente {
			return errQuadroInvalido
		}
		saida.To = para
		return nil
	}

	switch tipo {
	case tipoPing:
		return quadroValidado{msg: saida}, nil

	case tipoStatusCheck:
		if err := exigirDestino(); err != nil {
			return quadroValidado{}, err
		}
		return quadroValidado{msg: saida, alvos: []string{para}}, nil

	case tipoStatusLote:
		var lista []string
		if err := json.Unmarshal(bruto.Payload, &lista); err != nil {
			return quadroValidado{}, errQuadroInvalido
		}
		vistos := make(map[string]bool, len(lista))
		alvos := make([]string, 0, len(lista))
		for _, u := range lista {
			u = strings.ToLower(strings.TrimSpace(u))
			if len(alvos) >= maxAlvosStatusLote {
				break
			}
			if !usernameValido(u) || u == remetente || vistos[u] {
				continue
			}
			vistos[u] = true
			alvos = append(alvos, u)
		}
		return quadroValidado{msg: saida, alvos: alvos}, nil

	case tipoChat:
		// Aviso de mensagem nova. O texto NUNCA passa pelo servidor: a mensagem
		// está no Firestore (e, na conversa protegida, cifrada). Clientes antigos
		// mandavam um resumo em "content"; ele é descartado aqui.
		chatID, err := lerConversa(bruto.Payload)
		if err != nil {
			return quadroValidado{}, err
		}
		if para != "" {
			if err := exigirDestino(); err != nil {
				return quadroValidado{}, err
			}
		}
		saida.Payload = mustJSON(payloadConversa{ChatID: chatID})
		return quadroValidado{msg: saida, conversa: chatID}, nil

	case tipoDigitando, tipoParouDigitando:
		if err := exigirDestino(); err != nil {
			return quadroValidado{}, err
		}
		chatID := ""
		if len(bruto.Payload) > 0 && string(bruto.Payload) != "null" {
			id, err := lerConversa(bruto.Payload)
			if err != nil {
				return quadroValidado{}, err
			}
			chatID = id
		}
		if chatID == "" {
			// Cliente antigo, sem chatId: só existe digitação em conversa direta.
			chatID = IDConversaDireta(remetente, para)
		}
		saida.Payload = mustJSON(payloadConversa{ChatID: chatID})
		return quadroValidado{msg: saida, conversa: chatID}, nil

	case tipoChamada:
		if err := exigirDestino(); err != nil {
			return quadroValidado{}, err
		}
		if !conteudosChamada[bruto.Content] {
			return quadroValidado{}, errQuadroInvalido
		}
		saida.Content = bruto.Content
		return quadroValidado{msg: saida, conversa: IDConversaDireta(remetente, para)}, nil

	case tipoCancelarChamada:
		if err := exigirDestino(); err != nil {
			return quadroValidado{}, err
		}
		if !conteudosCancelar[bruto.Content] {
			return quadroValidado{}, errQuadroInvalido
		}
		saida.Content = bruto.Content
		return quadroValidado{msg: saida, conversa: IDConversaDireta(remetente, para)}, nil

	case tipoWebRTC:
		if err := exigirDestino(); err != nil {
			return quadroValidado{}, err
		}
		if !conteudosWebRTC[bruto.Content] {
			return quadroValidado{}, errQuadroInvalido
		}
		saida.Content = bruto.Content
		payload, err := validarPayloadWebRTC(bruto.Content, bruto.Payload)
		if err != nil {
			return quadroValidado{}, err
		}
		saida.Payload = payload
		return quadroValidado{msg: saida, conversa: IDConversaDireta(remetente, para)}, nil
	}

	return quadroValidado{}, errQuadroInvalido
}

func lerConversa(payload json.RawMessage) (string, error) {
	var p payloadConversa
	if len(payload) == 0 || json.Unmarshal(payload, &p) != nil {
		return "", errQuadroInvalido
	}
	if !idDeConversaValido(p.ChatID) {
		return "", errQuadroInvalido
	}
	return p.ChatID, nil
}

// validarPayloadWebRTC reconstrói a sinalização da chamada com os campos que o
// chamada.js usa, e só eles.
func validarPayloadWebRTC(conteudo string, payload json.RawMessage) (json.RawMessage, error) {
	vazio := len(payload) == 0 || string(payload) == "null"
	switch conteudo {
	case "pronto", "consultar_toque":
		return nil, nil

	case "tocando":
		var p payloadTocando
		if !vazio && json.Unmarshal(payload, &p) != nil {
			return nil, errQuadroInvalido
		}
		return mustJSON(p), nil

	case "estado":
		var p payloadEstado
		if vazio || json.Unmarshal(payload, &p) != nil {
			return nil, errQuadroInvalido
		}
		return mustJSON(p), nil

	case "oferta", "resposta":
		var p payloadDescricao
		if vazio || json.Unmarshal(payload, &p) != nil {
			return nil, errQuadroInvalido
		}
		esperado := "offer"
		if conteudo == "resposta" {
			esperado = "answer"
		}
		if p.Type != esperado || p.SDP == "" || len(p.SDP) > maxTamanhoSDP || !strings.HasPrefix(p.SDP, "v=0") {
			return nil, errQuadroInvalido
		}
		return mustJSON(p), nil

	case "ice":
		var p payloadCandidato
		if vazio || json.Unmarshal(payload, &p) != nil {
			return nil, errQuadroInvalido
		}
		if len(p.Candidate) > maxTamanhoCandidato {
			return nil, errQuadroInvalido
		}
		if p.SdpMid != nil && len(*p.SdpMid) > 64 {
			return nil, errQuadroInvalido
		}
		if p.SdpMLineIndex != nil && (*p.SdpMLineIndex < 0 || *p.SdpMLineIndex > 64) {
			return nil, errQuadroInvalido
		}
		if p.UsernameFragment != nil && len(*p.UsernameFragment) > 256 {
			return nil, errQuadroInvalido
		}
		return mustJSON(p), nil
	}
	return nil, errQuadroInvalido
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		// Só estruturas deste arquivo passam por aqui; falhar é bug.
		panic(err)
	}
	return b
}

var tiposConhecidos = map[string]bool{
	tipoChat: true, tipoDigitando: true, tipoParouDigitando: true, tipoStatusCheck: true,
	tipoStatusLote: true, tipoChamada: true, tipoCancelarChamada: true, tipoWebRTC: true, tipoPing: true,
}

// quadroDeErro é o aviso devolvido a quem mandou algo recusado. O tipo
// original só volta se for um dos conhecidos (nada do cliente é ecoado cru).
func quadroDeErro(codigo, tipoOriginal string) Message {
	msg := Message{Type: "erro", Content: codigo}
	if tiposConhecidos[tipoOriginal] {
		msg.Payload = mustJSON(map[string]string{"tipo": tipoOriginal})
	}
	return msg
}
