package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestValidarQuadroRecusaDestinosEIdsForjados(t *testing.T) {
	invalidos := []Message{
		{Type: "chamada", To: "../usuarios/bruno", Content: "audio"},
		{Type: "chamada", To: "bruno/../../x", Content: "audio"},
		{Type: "chamada", To: "BRUNO\n", Content: "audio"}, // vira "bruno"? não: \n some no TrimSpace, mas maiúsculas caem
		{Type: "chamada", To: "ana", Content: "audio"},     // para si mesma
		{Type: "chamada", To: "bruno", Content: "<script>"},
		{Type: "cancelar_chamada", To: "bruno", Content: "qualquer"},
		{Type: "webrtc", To: "bruno", Content: "executar"},
		{Type: "chat", Payload: json.RawMessage(`{"chatId":"__name__"}`)},
		{Type: "chat", Payload: json.RawMessage(`{"chatId":"a/b"}`)},
		{Type: "chat", Payload: json.RawMessage(`{"chatId":".."}`)},
		{Type: "chat", Payload: json.RawMessage(`{"chatId":{"$ne":null}}`)}, // injeção NoSQL
		{Type: "chat", Payload: json.RawMessage(`{"chatId":"` + strings.Repeat("a", 151) + `"}`)},
		{Type: "chat"},
		{Type: "status_check", To: "a b"},
		{Type: "digitando", To: ""},
		{Type: "apagar_tudo", To: "bruno"},
		{Type: "auth", To: "bruno"},
		{Type: "status_update", To: "bruno"}, // tipo que só o servidor emite
	}
	for _, m := range invalidos {
		if q, err := validarQuadro(m, "ana"); err == nil {
			// "BRUNO\n" normaliza para "bruno", que é válido — aceitável.
			if m.To == "BRUNO\n" && q.msg.To == "bruno" {
				continue
			}
			t.Fatalf("quadro deveria ser recusado: %+v -> %+v", m, q.msg)
		}
	}
}

func TestValidarQuadroReconstroiEDescartaOExtra(t *testing.T) {
	q, err := validarQuadro(Message{
		Type: "chat", From: "admin", To: "bruno", Content: "texto secreto",
		Payload:   json.RawMessage(`{"chatId":"ana_bruno","texto":"vazado","__proto__":{"x":1}}`),
		Timestamp: 99, LastSeen: 99,
	}, "ana")
	if err != nil {
		t.Fatalf("quadro válido recusado: %v", err)
	}
	if q.msg.From != "ana" || q.msg.Content != "" || q.msg.Timestamp != 0 || q.msg.LastSeen != 0 {
		t.Fatalf("campos do cliente atravessaram: %+v", q.msg)
	}
	if string(q.msg.Payload) != `{"chatId":"ana_bruno"}` {
		t.Fatalf("payload não foi reconstruído: %s", q.msg.Payload)
	}
	if q.conversa != "ana_bruno" {
		t.Fatalf("conversa errada: %q", q.conversa)
	}
}

func TestValidarQuadroChamadaUsaAConversaDireta(t *testing.T) {
	q, err := validarQuadro(Message{Type: "chamada", To: "Bruno", Content: "video"}, "ana")
	if err != nil {
		t.Fatalf("recusado: %v", err)
	}
	if q.conversa != "ana_bruno" || q.msg.To != "bruno" {
		t.Fatalf("conversa/destino errados: %+v", q)
	}
	// A ordem é alfabética, não de quem liga.
	q, _ = validarQuadro(Message{Type: "chamada", To: "ana", Content: "video"}, "zeca")
	if q.conversa != "ana_zeca" {
		t.Fatalf("esperava ana_zeca, veio %q", q.conversa)
	}
}

func TestValidarQuadroDigitandoSemChatIdVaiParaAConversaDireta(t *testing.T) {
	q, err := validarQuadro(Message{Type: "digitando", To: "bruno"}, "ana")
	if err != nil || q.conversa != "ana_bruno" {
		t.Fatalf("cliente antigo sem chatId: %v %+v", err, q)
	}
}

func TestValidarQuadroStatusLoteLimpaEAplicaTeto(t *testing.T) {
	lista := []string{"bruno", "Bruno", "ana", "", "a/b", "carla"}
	for i := 0; i < 300; i++ {
		lista = append(lista, "u"+strings.Repeat("x", i%10)+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	b, _ := json.Marshal(lista)
	q, err := validarQuadro(Message{Type: "status_lote", Payload: b}, "ana")
	if err != nil {
		t.Fatalf("recusado: %v", err)
	}
	if len(q.alvos) != maxAlvosStatusLote {
		t.Fatalf("esperava teto de %d alvos, veio %d", maxAlvosStatusLote, len(q.alvos))
	}
	for _, a := range q.alvos {
		if a == "ana" || a == "" || strings.Contains(a, "/") {
			t.Fatalf("alvo inválido passou: %q", a)
		}
	}
	if q.alvos[0] != "bruno" || q.alvos[1] != "carla" {
		t.Fatalf("duplicado não foi removido: %v", q.alvos[:3])
	}
}

func TestValidarPayloadWebRTC(t *testing.T) {
	sdpGrande := "v=0\r\n" + strings.Repeat("a=x\r\n", maxTamanhoSDP/5)
	casos := []struct {
		conteudo string
		payload  string
		ok       bool
	}{
		{"oferta", `{"type":"offer","sdp":"v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n"}`, true},
		{"oferta", `{"type":"answer","sdp":"v=0\r\n"}`, false},
		{"resposta", `{"type":"answer","sdp":"v=0\r\n"}`, true},
		{"oferta", `{"type":"offer","sdp":"` + strings.ReplaceAll(sdpGrande, "\r\n", `\r\n`) + `"}`, false},
		{"oferta", `{"type":"offer","sdp":"javascript:alert(1)"}`, false},
		{"ice", `{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0}`, true},
		{"ice", `{"candidate":"` + strings.Repeat("c", 2000) + `"}`, false},
		{"ice", `{"candidate":"x","sdpMLineIndex":-1}`, false},
		{"estado", `{"mic":true,"cam":false}`, true},
		{"estado", `"texto"`, false},
		{"tocando", `{"ocupado":true}`, true},
		{"pronto", `null`, true},
	}
	for _, c := range casos {
		_, err := validarPayloadWebRTC(c.conteudo, json.RawMessage(c.payload))
		if (err == nil) != c.ok {
			t.Fatalf("%s %s: esperava ok=%v, veio %v", c.conteudo, c.payload[:min(len(c.payload), 60)], c.ok, err)
		}
	}
}

func TestIDConversaDiretaIgualAoDoFront(t *testing.T) {
	// core.js: [a, b].map(lower+trim).sort().join("_")
	if IDConversaDireta(" Bruno ", "ana") != "ana_bruno" {
		t.Fatalf("id diferente do front")
	}
}

func TestQuadroDeErroNaoEcoaTipoDesconhecido(t *testing.T) {
	msg := quadroDeErro(erroQuadroInvalido, "<img src=x onerror=alert(1)>")
	if len(msg.Payload) != 0 {
		t.Fatalf("tipo desconhecido foi ecoado: %s", msg.Payload)
	}
	msg = quadroDeErro(erroLimite, "chamada")
	if !strings.Contains(string(msg.Payload), "chamada") {
		t.Fatalf("tipo conhecido deveria voltar: %s", msg.Payload)
	}
}

// ==========================================================================
// Configuração
// ==========================================================================

func TestConfigRecusaOrigensPerigosas(t *testing.T) {
	for _, origem := range []string{"*", "null", "http://site.com", "https://*.netlify.app", "https://a.com/caminho", "javascript:alert(1)", "https://user:senha@a.com"} {
		_, err := CarregarConfig(func(k string) string {
			if k == "ALLOWED_ORIGINS" {
				return origem
			}
			return ""
		})
		if err == nil {
			t.Fatalf("origem %q deveria ser recusada em produção", origem)
		}
	}
}

func TestConfigProducaoNaoAceitaLocalhostPorPadrao(t *testing.T) {
	cfg, err := CarregarConfig(func(string) string { return "" })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if !cfg.Producao() || cfg.OrigensPermitidas["http://localhost:5500"] {
		t.Fatalf("produção não pode aceitar localhost: %+v", cfg.OrigensPermitidas)
	}
	if !cfg.OrigensPermitidas["https://sinexchat.netlify.app"] {
		t.Fatalf("a origem do app precisa estar liberada")
	}
	dev, _ := CarregarConfig(func(k string) string {
		if k == "APP_ENV" {
			return "development"
		}
		return ""
	})
	if !dev.OrigensPermitidas["http://localhost:5500"] {
		t.Fatalf("desenvolvimento deveria aceitar localhost")
	}
}

func TestConfigValoresInvalidos(t *testing.T) {
	for chave, valor := range map[string]string{
		"APP_ENV":                  "staging",
		"PORT":                     "abc",
		"PRESENCE_GRACE_MS":        "-5",
		"MAX_CONNECTIONS_PER_USER": "0",
		"TRUST_PROXY_HEADERS":      "talvez",
	} {
		_, err := CarregarConfig(func(k string) string {
			if k == chave {
				return valor
			}
			return ""
		})
		if err == nil {
			t.Fatalf("%s=%q deveria ser recusado", chave, valor)
		}
	}
}

// ==========================================================================
// Limites
// ==========================================================================

func TestLimitadorPorChaveSeparaChavesERecarrega(t *testing.T) {
	l := NovoLimitadorPorChave(60, 2) // 1 por segundo, rajada 2
	agora := time.Unix(1000, 0)
	l.agora = func() time.Time { return agora }

	if !l.Permitir("a") || !l.Permitir("a") || l.Permitir("a") {
		t.Fatalf("rajada de 2 não foi respeitada")
	}
	if !l.Permitir("b") {
		t.Fatalf("chaves diferentes não podem dividir o balde")
	}
	agora = agora.Add(1100 * time.Millisecond)
	if !l.Permitir("a") {
		t.Fatalf("o balde deveria ter recarregado")
	}
}

func TestContadorDeFalhasBloqueiaEDesbloqueia(t *testing.T) {
	c := NovoContadorDeFalhas(3, time.Minute, 2*time.Minute)
	agora := time.Unix(1000, 0)
	c.agora = func() time.Time { return agora }
	c.Registrar("ip")
	c.Registrar("ip")
	if c.Bloqueado("ip") {
		t.Fatalf("bloqueou cedo demais")
	}
	if !c.Registrar("ip") || !c.Bloqueado("ip") {
		t.Fatalf("deveria bloquear na 3ª falha")
	}
	agora = agora.Add(3 * time.Minute)
	if c.Bloqueado("ip") {
		t.Fatalf("o bloqueio deveria expirar")
	}
}

func TestContadorDeConexoes(t *testing.T) {
	c := NovoContadorDeConexoes(3, 2)
	if !c.Reservar("a") || !c.Reservar("a") || c.Reservar("a") {
		t.Fatalf("teto por IP não respeitado")
	}
	if !c.Reservar("b") || c.Reservar("c") {
		t.Fatalf("teto total não respeitado")
	}
	c.Liberar("a")
	if !c.Reservar("c") {
		t.Fatalf("vaga liberada não voltou")
	}
}

// ==========================================================================
// Auditoria
// ==========================================================================

func TestRegistroDeSegurancaLimpaCamposEFazRodizio(t *testing.T) {
	r := NovoRegistroDeSeguranca(3, nil)
	r.Registrar(EventoDeSeguranca{Tipo: "teste", Detalhe: "linha1\nFALSO evento=admin"})
	if d := r.Resumo(1).Recentes[0].Detalhe; strings.Contains(d, "\n") {
		t.Fatalf("quebra de linha chegou ao log: %q", d)
	}
	for i := 0; i < 5; i++ {
		r.Registrar(EventoDeSeguranca{Tipo: "x"})
	}
	if n := len(r.Resumo(10).Recentes); n != 3 {
		t.Fatalf("a memória deveria guardar só os 3 últimos, guardou %d", n)
	}
	if r.Resumo(0).Contadores["x"] != 5 {
		t.Fatalf("contador errado")
	}
}

func TestRegistroComIntervaloNaoInundaOLog(t *testing.T) {
	r := NovoRegistroDeSeguranca(100, nil)
	for i := 0; i < 50; i++ {
		r.RegistrarComIntervalo("mesma", time.Minute, EventoDeSeguranca{Tipo: "flood"})
	}
	res := r.Resumo(100)
	if len(res.Recentes) != 1 || res.Contadores["flood"] != 50 {
		t.Fatalf("esperava 1 evento guardado e 50 contados: %d / %d", len(res.Recentes), res.Contadores["flood"])
	}
}
