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
		UID:          "uid-" + username,
		Send:         make(chan Message, buffer),
		janelaInicio: time.Now(),
	}
}

// conversaDe monta a autorização que a readPump anexaria à entrega.
func conversaDe(usernames ...string) *InfoConversa {
	info := &InfoConversa{Existe: true, UIDs: map[string]bool{}}
	for _, u := range usernames {
		info.UIDs["uid-"+u] = true
	}
	return info
}

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
	semMensagem(t, entrante)
}

func TestSegundaAbaNaoReanunciaOnline(t *testing.T) {
	h := hubDeTeste(t)
	observador := clienteFake("ana", 8)
	registrar(t, h, observador)
	aba1 := clienteFake("bruno", 8)
	registrar(t, h, aba1)
	recebe(t, observador)
	aba2 := clienteFake("bruno", 8)
	registrar(t, h, aba2)
	semMensagem(t, observador)
}

func TestOfflineSomenteQuandoUltimaAbaSai(t *testing.T) {
	h := hubDeTeste(t)
	observador := clienteFake("ana", 8)
	registrar(t, h, observador)
	aba1 := clienteFake("bruno", 8)
	aba2 := clienteFake("bruno", 8)
	registrar(t, h, aba1)
	recebe(t, observador)
	registrar(t, h, aba2)

	h.Unregister <- aba1
	time.Sleep(20 * time.Millisecond)
	semMensagem(t, observador)

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
	recebe(t, ana)

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "bruno"}, alvos: []string{"bruno"}}
	if msg := recebe(t, ana); msg.Type != "status_reply" || msg.From != "bruno" || msg.Content != "online" {
		t.Fatalf("esperava status_reply online, veio %+v", msg)
	}
	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "carlos"}, alvos: []string{"carlos"}}
	if msg := recebe(t, ana); msg.Type != "status_reply" || msg.From != "carlos" || msg.Content != "offline" {
		t.Fatalf("esperava status_reply offline, veio %+v", msg)
	}
}

// O remetente não escolhe quem ele é: o hub sobrescreve From.
func TestRemetenteNaoPodeFalsificarFromNoHub(t *testing.T) {
	h := hubDeTeste(t)
	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana)

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "chat", From: "administrador", To: "bruno"}, conversa: conversaDe("ana", "bruno")}
	if msg := recebe(t, bruno); msg.From != "ana" {
		t.Fatalf("From deveria ser sobrescrito para 'ana', veio %q", msg.From)
	}
}

// Defesa em profundidade: mesmo que uma entrega chegue ao hub sem autorização
// (bug na leitura), ele não repassa.
func TestHubNaoRepassaSemConversaAutorizada(t *testing.T) {
	h := hubDeTeste(t)
	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana)

	for _, e := range []entrega{
		{from: ana, msg: Message{Type: "chamada", To: "bruno", Content: "audio"}},                                         // sem conversa
		{from: ana, msg: Message{Type: "chamada", To: "bruno", Content: "audio"}, conversa: conversaDe("bruno", "carla")}, // ana fora
		{from: ana, msg: Message{Type: "webrtc", To: "bruno", Content: "oferta"}, conversa: conversaDe("ana", "carla")},   // bruno fora
	} {
		h.Broadcast <- e
	}
	semMensagem(t, bruno)
}

func TestTipoDesconhecidoEhDescartado(t *testing.T) {
	h := hubDeTeste(t)
	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana)
	h.Broadcast <- entrega{from: ana, msg: Message{Type: "apagar_tudo", To: "bruno"}, conversa: conversaDe("ana", "bruno")}
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
	recebe(t, celular)
	recebe(t, notebook)

	h.Broadcast <- entrega{from: celular, msg: Message{Type: "chat", To: "bruno"}, conversa: conversaDe("ana", "bruno")}
	if msg := recebe(t, bruno); msg.Type != "chat" {
		t.Fatalf("bruno deveria receber o aviso, veio %+v", msg)
	}
	if msg := recebe(t, notebook); msg.Type != "chat" {
		t.Fatalf("a outra aba de ana deveria receber o eco, veio %+v", msg)
	}
	semMensagem(t, celular)
}

func TestClienteLentoNaoTravaOHub(t *testing.T) {
	h := hubDeTeste(t)
	lento := clienteFake("lento", 1)
	saudavel := clienteFake("saudavel", 8)
	remetente := clienteFake("remetente", 8)
	registrar(t, h, lento)
	registrar(t, h, saudavel)
	registrar(t, h, remetente)

	for i := 0; i < 10; i++ {
		h.Broadcast <- entrega{from: remetente, msg: Message{Type: "chat", To: "lento"}, conversa: conversaDe("remetente", "lento")}
	}
	h.Broadcast <- entrega{from: remetente, msg: Message{Type: "chat", To: "saudavel"}, conversa: conversaDe("remetente", "saudavel")}

	prazo := time.After(2 * time.Second)
	for {
		select {
		case msg := <-saudavel.Send:
			if msg.Type == "chat" && msg.From == "remetente" {
				return
			}
		case <-prazo:
			t.Fatal("o hub travou por causa de um cliente lento")
		}
	}
}

func TestKickDesconectaTodasAsAbas(t *testing.T) {
	h := hubDeTeste(t)
	observador := clienteFake("ana", 8)
	registrar(t, h, observador)
	aba1 := clienteFake("bruno", 8)
	aba2 := clienteFake("bruno", 8)
	registrar(t, h, aba1)
	recebe(t, observador)
	registrar(t, h, aba2)

	h.DesconectarUsuario("bruno")
	if msg := recebe(t, observador); msg.Type != "status_update" || msg.Content != "offline" {
		t.Fatalf("esperava bruno offline apos o kick, veio %+v", msg)
	}
	for _, aba := range []*Client{aba1, aba2} {
		if _, ok := <-aba.Send; ok {
			t.Fatalf("aba de bruno deveria ter o canal fechado apos o kick")
		}
	}
}

func TestKickPorUIDDesconectaAConta(t *testing.T) {
	h := hubDeTeste(t)
	aba := clienteFake("bruno", 8)
	registrar(t, h, aba)
	h.DesconectarUID("uid-bruno")
	select {
	case _, ok := <-aba.Send:
		if ok {
			t.Fatalf("esperava o canal fechado")
		}
	case <-time.After(time.Second):
		t.Fatalf("a aba não foi desconectada")
	}
}

// ---------------------------------------------------------------------------
// Presença com folga
// ---------------------------------------------------------------------------

func TestFolgaEvitaPiscarAoTrocarDeTela(t *testing.T) {
	h := hubComGraca(t, 200*time.Millisecond)
	observador := clienteFake("ana", 8)
	registrar(t, h, observador)
	tela1 := clienteFake("bruno", 8)
	registrar(t, h, tela1)
	recebe(t, observador)

	h.Unregister <- tela1
	time.Sleep(40 * time.Millisecond)
	tela2 := clienteFake("bruno", 8)
	registrar(t, h, tela2)
	time.Sleep(300 * time.Millisecond)
	semMensagem(t, observador)
}

func TestOfflineDepoisDaFolgaLevaLastSeen(t *testing.T) {
	h := hubComGraca(t, 80*time.Millisecond)
	observador := clienteFake("ana", 8)
	registrar(t, h, observador)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, bruno)
	recebe(t, observador)

	saiuEm := time.Now().UnixMilli()
	h.Unregister <- bruno
	semMensagem(t, observador)

	msg := recebe(t, observador)
	if msg.Type != "status_update" || msg.Content != "offline" || msg.From != "bruno" {
		t.Fatalf("esperava bruno offline, veio %+v", msg)
	}
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
	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "bruno"}, alvos: []string{"bruno"}}
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
	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_check", To: "bruno"}, alvos: []string{"bruno"}}
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
	if msg := recebe(t, observador); msg.Content != "offline" || msg.From != "bruno" {
		t.Fatalf("banimento precisa derrubar na hora, veio %+v", msg)
	}
}

func TestEncerrarFechaTudoSemAvisarOffline(t *testing.T) {
	h := hubComGraca(t, 5*time.Second)
	ana := clienteFake("ana", 8)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana)

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

func TestStatusLoteRespondeCadaUm(t *testing.T) {
	h := hubDeTeste(t)
	ana := clienteFake("ana", 16)
	bruno := clienteFake("bruno", 8)
	registrar(t, h, ana)
	registrar(t, h, bruno)
	recebe(t, ana)

	h.Broadcast <- entrega{from: ana, msg: Message{Type: "status_lote"}, alvos: []string{"bruno", "carla"}}
	vistos := map[string]string{}
	for i := 0; i < 2; i++ {
		msg := recebe(t, ana)
		if msg.Type != "status_reply" {
			t.Fatalf("esperava status_reply, veio %+v", msg)
		}
		vistos[msg.From] = msg.Content
	}
	semMensagem(t, ana)
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

func TestDigitacaoColadaNoHandshakeEhDescartada(t *testing.T) {
	h := hubDeTeste(t)
	ana := clienteFake("ana", 8)
	registrar(t, h, ana)
	bruno := clienteConectadoHa("bruno", 0)
	registrar(t, h, bruno)
	recebe(t, ana)

	conv := conversaDe("ana", "bruno")
	for i := 0; i < 5; i++ {
		h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}, conversa: conv}
	}
	h.Broadcast <- entrega{from: bruno, msg: Message{Type: "parou_digitando", To: "ana"}, conversa: conv}
	semMensagem(t, ana)
}

func TestRajadaDeDigitandoViraUmAviso(t *testing.T) {
	h := hubDeTeste(t)
	ana := clienteFake("ana", 32)
	registrar(t, h, ana)
	bruno := clienteConectadoHa("bruno", 5*time.Second)
	registrar(t, h, bruno)
	recebe(t, ana)

	conv := conversaDe("ana", "bruno")
	for i := 0; i < 10; i++ {
		h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}, conversa: conv}
	}
	if msg := recebe(t, ana); msg.Type != "digitando" {
		t.Fatalf("esperava um digitando, veio %+v", msg)
	}
	semMensagem(t, ana)

	h.Broadcast <- entrega{from: bruno, msg: Message{Type: "parou_digitando", To: "ana"}, conversa: conv}
	if msg := recebe(t, ana); msg.Type != "parou_digitando" {
		t.Fatalf("esperava parou_digitando, veio %+v", msg)
	}
	h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}, conversa: conv}
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

	conv := conversaDe("ana", "bruno")
	for i := 0; i < 3; i++ {
		h.Broadcast <- entrega{from: bruno, msg: Message{Type: "digitando", To: "ana"}, conversa: conv}
		if msg := recebe(t, ana); msg.Type != "digitando" {
			t.Fatalf("aviso %d perdido: %+v", i, msg)
		}
		time.Sleep(intervaloDigitando + 50*time.Millisecond)
	}
}
