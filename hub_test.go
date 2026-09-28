package main

import (
	"testing"
	"time"
)

// clienteFake cria um Client sem conexão de rede, suficiente para exercitar o
// roteamento do hub.
func clienteFake(username string, buffer int) *Client {
	return &Client{
		Username:     username,
		Send:         make(chan Message, buffer),
		janelaInicio: time.Now(),
	}
}

// recebe espera uma mensagem no canal do cliente ou falha por timeout.
func recebe(t *testing.T, c *Client) Message {
	t.Helper()
	select {
	case msg := <-c.Send:
		return msg
	case <-time.After(time.Second):
		t.Fatalf("nenhuma mensagem recebida por %s", c.Username)
		return Message{}
	}
}

func semMensagem(t *testing.T, c *Client) {
	t.Helper()
	select {
	case msg := <-c.Send:
		t.Fatalf("mensagem inesperada para %s: %+v", c.Username, msg)
	case <-time.After(50 * time.Millisecond):
	}
}

func hubDeTeste(t *testing.T) *Hub {
	t.Helper()
	return hubComGraca(t, 0)
}

// hubComGraca cria um hub com a folga de presença indicada. Os testes
// antigos usam folga zero: o "offline" sai no instante em que a última aba cai.
func hubComGraca(t *testing.T, graca time.Duration) *Hub {
	t.Helper()
	h := NovoHub(nil)
	h.graca = graca
	go h.Run()
	return h
}

func registrar(t *testing.T, h *Hub, c *Client) {
	t.Helper()
	h.Register <- c
	// Dá um instante para a goroutine Run processar o registro.
	time.Sleep(20 * time.Millisecond)
}

func TestPrimeiraAbaAnunciaOnline(t *testing.T) {
	h := hubDeTeste(t)

	observador := clienteFake("ana", 8)
	registrar(t, h, observador)

	entrante := clienteFake("bruno", 8)
	registrar(t, h, entrante)

	msg := recebe(t, observador)
	if msg.Type != "status_update" || msg.From != "bruno" || msg.Content != "online" {
		t.Fatalf("esperava bruno online, veio %+v", msg)
	}

	// Quem entrou não recebe aviso sobre si mesmo.
	semMensagem(t, entrante)
}

func TestSegundaAbaNaoReanunciaOnline(t *testing.T) {
	h := hubDeTeste(t)

	observador := clienteFake("ana", 8)
	registrar(t, h, observador)

	aba1 := clienteFake("bruno", 8)
	registrar(t, h, aba1)
	recebe(t, observador) // o "online" da primeira aba

	aba2 := clienteFake("bruno", 8)
	registrar(t, h, aba2)

	// Abrir uma segunda aba não é um novo evento de presença.
	semMensagem(t, observador)
}

func TestOfflineSomenteQuandoUltimaAbaSai(t *testing.T) {
	h := hubDeTeste(t)

	observador := clienteFake("ana", 8)
	registrar(t, h, observador)

	aba1 := clienteFake("bruno", 8)
	aba2 := clienteFake("bruno", 8)
	registrar(t, h, aba1)
	recebe(t, observador) // online
	registrar(t, h, aba2)

	h.Unregister <- aba1
	time.Sleep(20 * time.Millisecond)
	semMensagem(t, observador) // ainda há uma aba viva

	h.Unregister <- aba2
	msg := recebe(t, observador)
	if msg.Type != "status_update" || msg.From != "bruno" || msg.Content != "offline" {
		t.Fatalf("esperava bruno offline, veio %+v", msg)
	}
}

func TestStatusCheckRespondeOnlineEOffline(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana) // "bruno online"

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "bruno"}}
	msg := recebe(t, ana)
	if msg.Type != "status_reply" || msg.From != "bruno" || msg.Content != "online" {
		t.Fatalf("esperava status_reply online, veio %+v", msg)
	}

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "carlos"}}
	msg = recebe(t, ana)
	if msg.Type != "status_reply" || msg.From != "carlos" || msg.Content != "offline" {
		t.Fatalf("esperava status_reply offline, veio %+v", msg)
	}
}

// O remetente não pode escolher quem ele é: o hub sobrescreve From com o
// usuário autenticado da conexão.
func TestRemetenteNaoPodeFalsificarFrom(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana) // presença

	h.Broadcast <- entrega{
		from: ana,
		msg:  Message{Type: "chat", From: "administrador", To: "bruno", Content: "oi"},
	}

	msg := recebe(t, bruno)
	if msg.From != "ana" {
		t.Fatalf("From deveria ser sobrescrito para 'ana', veio %q", msg.From)
	}
}

func TestTipoDesconhecidoEhDescartado(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana)

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "apagar_tudo", To: "bruno"}}
	semMensagem(t, bruno)
}

func TestChatEcoaParaOutrasAbasDoRemetente(t *testing.T) {
	h := hubDeTeste(t)

	celular := clienteFake("ana", 8)
	notebook := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, celular)
	registrar(t, h, notebook)
	registrar(t, h, bruno)
	recebe(t, celular) // presença de bruno
	recebe(t, notebook)

	h.Broadcast <- entrega{from: celular, msg: Message{Type: "chat", To: "bruno", Content: "oi"}}

	if msg := recebe(t, bruno); msg.Content != "oi" {
		t.Fatalf("bruno deveria receber a mensagem, veio %+v", msg)
	}
	if msg := recebe(t, notebook); msg.Content != "oi" {
		t.Fatalf("a outra aba de ana deveria ecoar a mensagem, veio %+v", msg)
	}
	semMensagem(t, celular) // a aba que enviou não recebe o eco
}

// Regressão: um cliente com o buffer cheio era capaz de travar a goroutine do
// hub inteiro. Agora ele é desconectado e os demais seguem recebendo.
func TestClienteLentoNaoTravaOHub(t *testing.T) {
	h := hubDeTeste(t)

	lento := clienteFake("lento", 1)
	saudavel := clienteFake("saudavel", 8)
	remetente := clienteFake("remetente", 8)

	registrar(t, h, lento)
	registrar(t, h, saudavel)
	registrar(t, h, remetente)

	// Enche o buffer do cliente lento sem nunca drenar.
	for i := 0; i < 10; i++ {
		h.Broadcast <- entrega{from: remetente, msg: Message{Type: "chat", To: "lento", Content: "x"}}
	}

	// O hub continua vivo e atendendo os outros.
	h.Broadcast <- entrega{from: remetente, msg: Message{Type: "chat", To: "saudavel", Content: "segue vivo"}}

	prazo := time.After(2 * time.Second)
	for {
		select {
		case msg := <-saudavel.Send:
			if msg.Type == "chat" && msg.Content == "segue vivo" {
				return
			}
		case <-prazo:
			t.Fatal("o hub travou por causa de um cliente lento")
		}
	}
}

// Regressão: banir uma conta precisa derrubar sessões já abertas, não só
// bloquear a próxima tentativa de handshake — é o que o endpoint HTTP
// /admin/kick (main.go) aciona através de Hub.DesconectarUsuario.
func TestKickDesconectaTodasAsAbas(t *testing.T) {
	h := hubDeTeste(t)

	observador := clienteFake("ana", 8)
	registrar(t, h, observador)

	aba1 := clienteFake("bruno", 8)
	aba2 := clienteFake("bruno", 8)
	registrar(t, h, aba1)
	recebe(t, observador) // "bruno online"
	registrar(t, h, aba2)

	h.DesconectarUsuario("bruno")

	msg := recebe(t, observador)
	if msg.Type != "status_update" || msg.From != "bruno" || msg.Content != "offline" {
		t.Fatalf("esperava bruno offline apos o kick, veio %+v", msg)
	}

	if _, ok := <-aba1.Send; ok {
		t.Fatalf("aba1 de bruno deveria ter o canal fechado apos o kick")
	}
	if _, ok := <-aba2.Send; ok {
		t.Fatalf("aba2 de bruno deveria ter o canal fechado apos o kick")
	}
}

// ---------------------------------------------------------------------------
// Presença com folga
// ---------------------------------------------------------------------------

// Trocar de tela fecha um WebSocket e abre outro: para quem observa, a pessoa
// não pode piscar offline/online.
func TestFolgaEvitaPiscarAoTrocarDeTela(t *testing.T) {
	h := hubComGraca(t, 200*time.Millisecond)

	observador := clienteFake("ana", 8)
	registrar(t, h, observador)

	tela1 := clienteFake("bruno", 8)
	registrar(t, h, tela1)
	recebe(t, observador) // online

	h.Unregister <- tela1
	time.Sleep(40 * time.Millisecond)
	tela2 := clienteFake("bruno", 8)
	registrar(t, h, tela2)

	// Nem offline nem um segundo online — e nada depois que a folga venceria.
	time.Sleep(300 * time.Millisecond)
	semMensagem(t, observador)
}

func TestOfflineDepoisDaFolgaLevaLastSeen(t *testing.T) {
	h := hubComGraca(t, 80*time.Millisecond)

	observador := clienteFake("ana", 8)
	registrar(t, h, observador)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, bruno)
	recebe(t, observador) // online

	saiuEm := time.Now().UnixMilli()
	h.Unregister <- bruno
	semMensagem(t, observador) // ainda dentro da folga

	msg := recebe(t, observador)
	if msg.Type != "status_update" || msg.Content != "offline" || msg.From != "bruno" {
		t.Fatalf("esperava bruno offline, veio %+v", msg)
	}
	// O lastSeen é o instante em que a aba caiu, não o fim da folga.
	if msg.LastSeen < saiuEm-5 || msg.LastSeen > saiuEm+60 {
		t.Fatalf("lastSeen %d fora do esperado (saiu em %d)", msg.LastSeen, saiuEm)
	}
}

func TestStatusDuranteFolgaContinuaOnline(t *testing.T) {
	h := hubComGraca(t, 300*time.Millisecond)

	ana := clienteFake("ana", 8)
	registrar(t, h, ana)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, bruno)
	recebe(t, ana)

	h.Unregister <- bruno
	time.Sleep(20 * time.Millisecond)

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "bruno"}}
	if msg := recebe(t, ana); msg.Content != "online" {
		t.Fatalf("durante a folga bruno ainda conta como online, veio %+v", msg)
	}
}

func TestStatusLogoDepoisDeSairUsaAMemoria(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 8)
	registrar(t, h, ana)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, bruno)
	recebe(t, ana)

	h.Unregister <- bruno
	offline := recebe(t, ana)

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "bruno"}}
	msg := recebe(t, ana)
	if msg.Type != "status_reply" || msg.Content != "offline" || msg.LastSeen != offline.LastSeen || msg.LastSeen == 0 {
		t.Fatalf("status_reply deveria trazer o lastSeen em memória (%d), veio %+v", offline.LastSeen, msg)
	}
}

func TestKickIgnoraAFolga(t *testing.T) {
	h := hubComGraca(t, 5*time.Second)

	observador := clienteFake("ana", 8)
	registrar(t, h, observador)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, bruno)
	recebe(t, observador)

	h.DesconectarUsuario("bruno")
	msg := recebe(t, observador)
	if msg.Content != "offline" || msg.From != "bruno" {
		t.Fatalf("banimento precisa derrubar na hora, veio %+v", msg)
	}
}

func TestEncerrarFechaTudoSemAvisarOffline(t *testing.T) {
	h := hubComGraca(t, 5*time.Second)

	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana) // bruno online

	h.Encerrar(time.Second)

	for _, c := range []*Client{ana, bruno} {
		for {
			msg, ok := <-c.Send
			if !ok {
				break
			}
			if msg.Type == "status_update" {
				t.Fatalf("desligar o servidor não é 'ficou offline': %+v", msg)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Presença em lote e batimento
// ---------------------------------------------------------------------------

func TestStatusLoteRespondeCadaUm(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 16)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana)

	h.Broadcast <- entrega{from: ana, msg: Message{
		Type:    "status_lote",
		Payload: []byte(`["bruno","carla","bruno","ana",""]`),
	}}

	vistos := map[string]string{}
	for i := 0; i < 2; i++ {
		msg := recebe(t, ana)
		if msg.Type != "status_reply" {
			t.Fatalf("esperava status_reply, veio %+v", msg)
		}
		vistos[msg.From] = msg.Content
	}
	semMensagem(t, ana) // duplicado, vazio e a própria pessoa ficam de fora
	if vistos["bruno"] != "online" || vistos["carla"] != "offline" {
		t.Fatalf("respostas erradas: %+v", vistos)
	}
}

func TestPingRespondePong(t *testing.T) {
	h := hubDeTeste(t)
	ana := clienteFake("ana", 8)
	registrar(t, h, ana)

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "ping"}}
	if msg := recebe(t, ana); msg.Type != "pong" {
		t.Fatalf("esperava pong, veio %+v", msg)
	}
}

// ---------------------------------------------------------------------------
// Digitação
// ---------------------------------------------------------------------------

func clienteConectadoHa(username string, ha time.Duration) *Client {
	c := clienteFake(username, 32)
	c.conectadoEm = time.Now().Add(-ha)
	return c
}

// Regressão: cliente antigo despejava a fila de "digitando" logo depois de
// autenticar, e o outro lado via "digitando..." sem ninguém digitar.
func TestDigitacaoColadaNoHandshakeEhDescartada(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 8)
	registrar(t, h, ana)
	bruno := clienteConectadoHa("bruno", 0)
	registrar(t, h, bruno)
	recebe(t, ana) // online

	for i := 0; i < 5; i++ {
		h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}}
	}
	h.Broadcast <- entrega{from: bruno, msg: Message{Type: "parou_digitando", To: "ana"}}
	semMensagem(t, ana)
}

func TestRajadaDeDigitandoViraUmAviso(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 32)
	registrar(t, h, ana)
	bruno := clienteConectadoHa("bruno", 5*time.Second)
	registrar(t, h, bruno)
	recebe(t, ana)

	for i := 0; i < 10; i++ {
		h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}}
	}
	if msg := recebe(t, ana); msg.Type != "digitando" {
		t.Fatalf("esperava um digitando, veio %+v", msg)
	}
	semMensagem(t, ana)

	// Parar sempre passa, e libera o próximo "digitando" na hora.
	h.Broadcast <- entrega{from: bruno, msg: Message{Type: "parou_digitando", To: "ana"}}
	if msg := recebe(t, ana); msg.Type != "parou_digitando" {
		t.Fatalf("esperava parou_digitando, veio %+v", msg)
	}
	h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}}
	if msg := recebe(t, ana); msg.Type != "digitando" {
		t.Fatalf("depois de parar, digitar de novo precisa avisar, veio %+v", msg)
	}
}

func TestDigitandoNoRitmoNormalPassaSempre(t *testing.T) {
	h := hubDeTeste(t)

	ana := clienteFake("ana", 32)
	registrar(t, h, ana)
	bruno := clienteConectadoHa("bruno", 5*time.Second)
	registrar(t, h, bruno)
	recebe(t, ana)

	for i := 0; i < 3; i++ {
		h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}}
		if msg := recebe(t, ana); msg.Type != "digitando" {
			t.Fatalf("aviso %d perdido: %+v", i, msg)
		}
		time.Sleep(intervaloDigitando + 50*time.Millisecond)
	}
}
