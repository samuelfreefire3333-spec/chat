package main

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ==========================================================================
// Handshake e autenticação do WebSocket
// ==========================================================================

func TestWSSemAutenticacaoEhRecusado(t *testing.T) {
	a := novoAmbiente(t)
	conn, _, err := a.discar(origemDoApp)
	if err != nil {
		t.Fatalf("discar: %v", err)
	}
	defer conn.Close()

	// Primeiro quadro que não é "auth": fecha na hora.
	enviarJSON(t, conn, map[string]string{"type": "chat", "to": "bruno"})
	codigo, _ := esperarFechamento(t, conn, 2*time.Second)
	if codigo != websocket.ClosePolicyViolation {
		t.Fatalf("esperava 1008, veio %d", codigo)
	}
}

func TestWSSemQuadroNenhumExpira(t *testing.T) {
	if testing.Short() {
		t.Skip("espera o prazo de autenticação")
	}
	a := novoAmbiente(t)
	conn, _, err := a.discar(origemDoApp)
	if err != nil {
		t.Fatalf("discar: %v", err)
	}
	defer conn.Close()
	codigo, _ := esperarFechamento(t, conn, authWait+3*time.Second)
	if codigo != websocket.ClosePolicyViolation && codigo != -1 {
		t.Fatalf("conexão sem autenticação deveria ser encerrada, veio %d", codigo)
	}
}

func TestWSComTokensInvalidos(t *testing.T) {
	a := novoAmbiente(t)
	a.tokens.falhar("tok-expirado", ErrTokenInvalido)
	a.tokens.falhar("tok-revogado", ErrTokenInvalido)
	a.tokens.falhar("tok-banido", ErrContaBloqueada)
	a.tokens.falhar("tok-sem-perfil", ErrSemIdentidade)

	casos := map[string]string{
		"tok-inexistente": "Sessão expirada",
		"tok-expirado":    "Sessão expirada",
		"tok-revogado":    "Sessão expirada",
		"tok-banido":      "suspensa ou banida",
		"tok-sem-perfil":  "Perfil não encontrado",
	}
	for token, motivoEsperado := range casos {
		t.Run(token, func(t *testing.T) {
			conn, _, err := a.discar(origemDoApp)
			if err != nil {
				t.Fatalf("discar: %v", err)
			}
			defer conn.Close()
			enviarJSON(t, conn, map[string]string{"type": "auth", "token": token})
			codigo, motivo := esperarFechamento(t, conn, 2*time.Second)
			if codigo != websocket.ClosePolicyViolation {
				t.Fatalf("esperava 1008, veio %d (%s)", codigo, motivo)
			}
			if !strings.Contains(motivo, motivoEsperado) {
				t.Fatalf("motivo %q não contém %q", motivo, motivoEsperado)
			}
			// O motivo nunca expõe o erro interno.
			if strings.Contains(motivo, "token invalido:") || strings.Contains(strings.ToLower(motivo), "firebase") {
				t.Fatalf("motivo vaza detalhe interno: %q", motivo)
			}
		})
	}
}

func TestWSOrigemDesconhecidaRecebe403(t *testing.T) {
	a := novoAmbiente(t)
	for _, origem := range []string{"https://site-malicioso.example", "null", "http://localhost:5500", ""} {
		_, resp, err := a.discar(origem)
		if err == nil {
			t.Fatalf("origem %q deveria ser recusada", origem)
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("origem %q: esperava 403, veio %v", origem, resp)
		}
	}
}

func TestWSQuadroDeAuthGrandeDemaisEhRecusado(t *testing.T) {
	a := novoAmbiente(t)
	conn, _, err := a.discar(origemDoApp)
	if err != nil {
		t.Fatalf("discar: %v", err)
	}
	defer conn.Close()
	enorme := strings.Repeat("a", maxTamanhoQuadroAuth+100)
	conn.WriteJSON(map[string]string{"type": "auth", "token": enorme})
	codigo, _ := esperarFechamento(t, conn, 2*time.Second)
	if codigo == websocket.CloseNormalClosure {
		t.Fatalf("quadro de auth gigante não pode ser aceito")
	}
}

func TestWSLimiteDeHandshakesPorIP(t *testing.T) {
	a := novoAmbiente(t, func(s *servidor) { s.handshakes = NovoLimitadorPorChave(60, 3) })
	recusados := 0
	for i := 0; i < 6; i++ {
		conn, resp, err := a.discar(origemDoApp)
		if err != nil {
			if resp != nil && resp.StatusCode == http.StatusTooManyRequests {
				recusados++
				continue
			}
			t.Fatalf("erro inesperado: %v", err)
		}
		conn.Close()
	}
	if recusados == 0 {
		t.Fatalf("rajada de handshakes do mesmo IP deveria receber 429")
	}
}

func TestWSBloqueiaIPDepoisDeFalhasDeAutenticacao(t *testing.T) {
	a := novoAmbiente(t, func(s *servidor) { s.falhasAuth = NovoContadorDeFalhas(3, time.Minute, time.Minute) })
	for i := 0; i < 3; i++ {
		conn, _, err := a.discar(origemDoApp)
		if err != nil {
			t.Fatalf("discar: %v", err)
		}
		enviarJSON(t, conn, map[string]string{"type": "auth", "token": "chute"})
		esperarFechamento(t, conn, 2*time.Second)
		conn.Close()
	}
	_, resp, err := a.discar(origemDoApp)
	if err == nil || resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("depois de 3 tokens inválidos o IP deveria ficar bloqueado (429), veio %v", resp)
	}
	// E um token válido também não passa durante o bloqueio.
	if a.srv.falhasAuth.Bloqueado("127.0.0.1") == false {
		t.Fatalf("o bloqueio deveria valer para o IP")
	}
}

func TestWSTetoDeConexoesPorIP(t *testing.T) {
	a := novoAmbiente(t, func(s *servidor) { s.conexoes = NovoContadorDeConexoes(100, 2) })
	a.conectar("tok-ana")
	a.conectar("tok-bruno")
	_, resp, err := a.discar(origemDoApp)
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("terceira conexão do mesmo IP deveria ser recusada, veio %v", resp)
	}
}

// ==========================================================================
// Autorização por conversa (IDOR pelo WebSocket)
// ==========================================================================

func TestWSAvisoSoChegaParaQuemParticipaDaConversa(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")
	carla := a.conectar("tok-carla")

	// Ana avisa mensagem na conversa ana_bruno: só Bruno recebe.
	enviarJSON(t, ana, Message{Type: "chat", Payload: payload(map[string]string{"chatId": "ana_bruno"})})
	msg := lerAte(t, bruno, "chat", 2*time.Second)
	if msg.From != "ana" {
		t.Fatalf("remetente errado: %+v", msg)
	}
	nadaDoTipo(t, carla, "chat", 300*time.Millisecond)
}

func TestWSNaoRepassaParaConversaDeOutros(t *testing.T) {
	a := novoAmbiente(t)
	a.conversas.criar("bruno_carla", "direto", "uid-bruno", "uid-carla")
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")
	carla := a.conectar("tok-carla")

	// Ana tenta usar o chatId da conversa de Bruno e Carla (IDOR).
	enviarJSON(t, ana, Message{Type: "chat", Payload: payload(map[string]string{"chatId": "bruno_carla"})})
	erro := lerAte(t, ana, "erro", 2*time.Second)
	if erro.Content != erroNaoAutorizado {
		t.Fatalf("esperava nao_autorizado, veio %+v", erro)
	}
	nadaDoTipo(t, bruno, "chat", 300*time.Millisecond)
	nadaDoTipo(t, carla, "chat", 100*time.Millisecond)

	// Mesmo mirando só a Carla, pelo formato antigo.
	enviarJSON(t, ana, Message{Type: "chat", To: "carla", Payload: payload(map[string]string{"chatId": "ana_bruno"})})
	nadaDoTipo(t, carla, "chat", 300*time.Millisecond)
}

func TestWSChatIDManipuladoEhRecusado(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	for _, chatID := range []string{
		"inexistente_0000",          // não existe
		"../usuarios/bruno",         // caminho
		"chats/ana_bruno/mensagens", // caminho
		"__name__",                  // ID reservado do Firestore
		"ana_bruno' || true",        // injeção
		strings.Repeat("x", 300),    // gigante
	} {
		enviarJSON(t, ana, Message{Type: "chat", Payload: payload(map[string]string{"chatId": chatID})})
		time.Sleep(1100 * time.Millisecond) // o aviso de erro sai no máximo 1 por segundo
		erro := lerAte(t, ana, "erro", 2*time.Second)
		if erro.Content != erroNaoAutorizado && erro.Content != erroQuadroInvalido {
			t.Fatalf("chatId %q: esperava recusa, veio %+v", chatID, erro)
		}
	}
}

// Operadores de consulta (estilo NoSQL) e tipos trocados dentro do quadro:
// nada vira consulta nem é repassado.
func TestWSOperadoresETiposTrocadosNaoPassam(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")

	for _, bruto := range []map[string]any{
		{"type": "chat", "payload": map[string]any{"chatId": map[string]string{"$ne": ""}}},
		{"type": "chat", "payload": map[string]any{"chatId": map[string]any{"$regex": ".*"}}},
		{"type": "digitando", "payload": map[string]any{"chatId": []string{"ana_bruno", "bruno_carla"}}},
	} {
		enviarJSON(t, ana, bruto)
		time.Sleep(1100 * time.Millisecond) // o aviso de erro sai no máximo 1 por segundo
		erro := lerAte(t, ana, "erro", 2*time.Second)
		if erro.Content != erroQuadroInvalido && erro.Content != erroNaoAutorizado {
			t.Fatalf("%v: esperava recusa, veio %+v", bruto, erro)
		}
	}
	nadaDoTipo(t, bruno, "chat", 300*time.Millisecond)

	// Tipo trocado num campo do próprio quadro (não do payload): a conexão é
	// encerrada com motivo e o evento fica registrado.
	intruso := a.conectar("tok-ana")
	enviarJSON(t, intruso, map[string]any{"type": "chamada", "to": map[string]string{"$gt": ""}, "payload": map[string]string{"chatId": "ana_bruno"}})
	codigo, motivo := esperarFechamento(t, intruso, 2*time.Second)
	if codigo != websocket.CloseInvalidFramePayloadData || motivo != "quadro inválido" {
		t.Fatalf("esperava 1007 \"quadro inválido\", veio %d %q", codigo, motivo)
	}
	resumo := a.srv.seguranca.Resumo(20)
	achou := false
	for _, e := range resumo.Recentes {
		if e.Tipo == "ws_quadro_malformado" {
			achou = true
		}
	}
	if !achou {
		t.Fatalf("quadro malformado não foi registrado: %+v", resumo.Recentes)
	}
}

func TestWSChamadaSoEntreQuemTemConversa(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")
	carla := a.conectar("tok-carla")

	// Com conversa direta: toca.
	enviarJSON(t, ana, Message{Type: "chamada", To: "bruno", Content: "video"})
	if msg := lerAte(t, bruno, "chamada", 2*time.Second); msg.Content != "video" || msg.From != "ana" {
		t.Fatalf("chamada errada: %+v", msg)
	}

	// Sem conversa direta com Carla (só o grupo): não toca.
	enviarJSON(t, ana, Message{Type: "chamada", To: "carla", Content: "audio"})
	nadaDoTipo(t, carla, "chamada", 400*time.Millisecond)

	// Sinalização WebRTC para quem não tem conversa: também não passa.
	enviarJSON(t, ana, Message{Type: "webrtc", To: "carla", Content: "oferta", Payload: payload(map[string]string{"type": "offer", "sdp": "v=0\r\n"})})
	nadaDoTipo(t, carla, "webrtc", 400*time.Millisecond)
}

func TestWSRemetenteNaoPodeFalsificarFrom(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")
	enviarJSON(t, ana, map[string]any{"type": "chamada", "from": "administrador", "to": "bruno", "content": "audio"})
	if msg := lerAte(t, bruno, "chamada", 2*time.Second); msg.From != "ana" {
		t.Fatalf("From deveria vir do token (ana), veio %q", msg.From)
	}
}

func TestWSTextoDaMensagemNaoPassaPeloServidor(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")
	enviarJSON(t, ana, Message{Type: "chat", To: "bruno", Content: "segredo do Bruno", Payload: payload(map[string]any{"chatId": "ana_bruno", "texto": "vazado"})})
	msg := lerAte(t, bruno, "chat", 2*time.Second)
	if msg.Content != "" || strings.Contains(string(msg.Payload), "vazado") {
		t.Fatalf("o servidor repassou conteúdo da mensagem: %+v", msg)
	}
}

func TestWSAvisoPorConversaChegaNoGrupoEEcoaNasOutrasAbas(t *testing.T) {
	a := novoAmbiente(t)
	anaCelular := a.conectar("tok-ana")
	anaComputador := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")
	carla := a.conectar("tok-carla")

	enviarJSON(t, anaCelular, Message{Type: "chat", Payload: payload(map[string]string{"chatId": "GrupoAleatorio000001"})})
	for nome, conn := range map[string]*websocket.Conn{"bruno": bruno, "carla": carla, "outra aba da ana": anaComputador} {
		msg := lerAte(t, conn, "chat", 2*time.Second)
		if msg.From != "ana" {
			t.Fatalf("%s recebeu remetente errado: %+v", nome, msg)
		}
	}
	nadaDoTipo(t, anaCelular, "chat", 200*time.Millisecond)
}

func TestWSSinalizacaoWebRTCEhReconstruida(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")

	enviarJSON(t, ana, map[string]any{
		"type": "webrtc", "to": "bruno", "content": "ice",
		"payload": map[string]any{"candidate": "candidate:1 1 udp 1 1.2.3.4 5 typ host", "sdpMid": "0", "sdpMLineIndex": 0, "extra": "<script>"},
	})
	msg := lerAte(t, bruno, "webrtc", 2*time.Second)
	if strings.Contains(string(msg.Payload), "extra") || strings.Contains(string(msg.Payload), "<script>") {
		t.Fatalf("campo desconhecido atravessou o servidor: %s", msg.Payload)
	}

	// SDP que não é SDP não passa.
	enviarJSON(t, ana, map[string]any{"type": "webrtc", "to": "bruno", "content": "oferta", "payload": map[string]string{"type": "offer", "sdp": "<img src=x onerror=alert(1)>"}})
	nadaDoTipo(t, bruno, "webrtc", 300*time.Millisecond)
}

// ==========================================================================
// Limites e abuso
// ==========================================================================

func TestWSExcessoDeChamadasEhDescartado(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	bruno := a.conectar("tok-bruno")

	for i := 0; i < 10; i++ {
		enviarJSON(t, ana, Message{Type: "chamada", To: "bruno", Content: "audio"})
	}
	recebidas := 0
	fim := time.Now().Add(700 * time.Millisecond)
	for time.Now().Before(fim) {
		bruno.SetReadDeadline(fim)
		var msg Message
		if bruno.ReadJSON(&msg) != nil {
			break
		}
		if msg.Type == "chamada" {
			recebidas++
		}
	}
	if recebidas == 0 || recebidas > 4 {
		t.Fatalf("o limite de chamadas (rajada de 4) não foi aplicado: %d recebidas", recebidas)
	}
	if erro := lerAte(t, ana, "erro", time.Second); erro.Content != erroLimite {
		t.Fatalf("esperava limite_excedido, veio %+v", erro)
	}
}

func TestWSFloodDerrubaAConexao(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	for i := 0; i < limiteMensagens+20; i++ {
		if err := ana.WriteJSON(Message{Type: "ping"}); err != nil {
			break
		}
	}
	codigo, _ := esperarFechamento(t, ana, 3*time.Second)
	if codigo != websocket.ClosePolicyViolation {
		t.Fatalf("flood deveria fechar com 1008, veio %d", codigo)
	}
}

func TestWSMuitasRecusasEncerramAConexao(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	for i := 0; i < maxViolacoesPorMinuto+5; i++ {
		if err := ana.WriteJSON(Message{Type: "chat", Payload: payload(map[string]string{"chatId": "de_outros"})}); err != nil {
			break
		}
	}
	codigo, motivo := esperarFechamento(t, ana, 3*time.Second)
	if codigo != websocket.ClosePolicyViolation || !strings.Contains(motivo, "abuso") {
		t.Fatalf("esperava fechamento por abuso, veio %d %q", codigo, motivo)
	}
	if a.srv.seguranca.Resumo(10).Contadores["ws_abuso"] == 0 {
		t.Fatalf("o abuso deveria ficar registrado")
	}
}

func TestWSConsultasDeConversaTemOrcamento(t *testing.T) {
	a := novoAmbiente(t, func(s *servidor) {
		s.svc.autorizador.consultas = NovoLimitadorPorChave(60, 5)
		s.svc.limites = &LimitesPorTipo{porTipo: map[string]*LimitadorPorChave{tipoChat: NovoLimitadorPorChave(6000, 1000)}}
	})
	ana := a.conectar("tok-ana")
	for i := 0; i < 25; i++ {
		ana.WriteJSON(Message{Type: "chat", Payload: payload(map[string]string{"chatId": "aleatorio" + strings.Repeat("x", i%20) + string(rune('a'+i))})})
	}
	time.Sleep(500 * time.Millisecond)
	if n := a.conversas.totalConsultas(); n > 5 {
		t.Fatalf("chatIds aleatórios geraram %d consultas ao banco (teto 5)", n)
	}
}

func TestWSPresencaEmLoteTemOrcamentoEUsaLote(t *testing.T) {
	a := novoAmbiente(t)
	ana := a.conectar("tok-ana")
	alvos := make([]string, 0, 150)
	for i := 0; i < 150; i++ {
		alvos = append(alvos, "pessoa"+strings.Repeat("x", i%5)+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	enviarJSON(t, ana, Message{Type: "status_lote", Payload: payload(alvos)})
	respostas := 0
	fim := time.Now().Add(2 * time.Second)
	for respostas < len(alvos) && time.Now().Before(fim) {
		ana.SetReadDeadline(fim)
		var msg Message
		if ana.ReadJSON(&msg) != nil {
			break
		}
		if msg.Type == "status_reply" {
			respostas++
		}
	}
	a.presenca.mu.Lock()
	consultas := a.presenca.consultas
	a.presenca.mu.Unlock()
	if consultas != 1 {
		t.Fatalf("150 @ deveriam virar UMA consulta em lote, foram %d", consultas)
	}
	if respostas != len(alvos) {
		t.Fatalf("esperava %d respostas, vieram %d", len(alvos), respostas)
	}
}

func TestWSTetoDeAbasPorContaFechaAMaisAntiga(t *testing.T) {
	a := novoAmbiente(t, func(s *servidor) { s.hub.maxPorUsuario = 2 })
	primeira := a.conectar("tok-ana")
	a.conectar("tok-ana")
	a.conectar("tok-ana")
	codigo, _ := esperarFechamento(t, primeira, 2*time.Second)
	if codigo == -1 {
		t.Fatalf("a aba mais antiga deveria ser fechada")
	}
}

func TestWSRevogacaoDerrubaTodasAsAbas(t *testing.T) {
	a := novoAmbiente(t)
	aba1 := a.conectar("tok-ana")
	aba2 := a.conectar("tok-ana")

	req, _ := http.NewRequest(http.MethodPost, a.http.URL+"/sessoes/revogar", nil)
	req.Header.Set("Authorization", "Bearer tok-ana")
	req.Header.Set("Origin", origemDoApp)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("revogar: %v %v", err, resp)
	}
	for _, aba := range []*websocket.Conn{aba1, aba2} {
		if codigo, _ := esperarFechamento(t, aba, 2*time.Second); codigo == -1 {
			t.Fatalf("aba continuou aberta depois de revogar as sessões")
		}
	}
	if len(a.admin.revogados) != 1 || a.admin.revogados[0] != "uid-ana" {
		t.Fatalf("a revogação deveria ser da própria conta: %v", a.admin.revogados)
	}
}
