package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"time"
)

// Message é o envelope trocado com o cliente. From é sempre preenchido pelo
// servidor a partir do token verificado — o valor que o cliente mandar em From
// é descartado, para que ninguém consiga se passar por outra pessoa.
type Message struct {
	Type      string          `json:"type"`
	From      string          `json:"from"`
	To        string          `json:"to"`
	Content   string          `json:"content,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Timestamp int64           `json:"timestamp,omitempty"`
	LastSeen  int64           `json:"lastSeen,omitempty"`
}

// tiposPermitidos são os únicos Type que o servidor aceita de um cliente.
// Qualquer outro é descartado em silêncio.
var tiposPermitidos = map[string]bool{
	"chat":             true,
	"digitando":        true,
	"parou_digitando":  true,
	"status_check":     true,
	"status_lote":      true,
	"chamada":          true,
	"cancelar_chamada": true,
	"webrtc":           true,
	"ping":             true,
}

// recursosDoServidor vai no auth_ok. O cliente só liga o que o servidor
// anuncia — assim um front-end novo continua funcionando contra um backend
// antigo (e vice-versa) durante a janela entre os dois deploys.
var recursosDoServidor = json.RawMessage(`{"versao":2,"recursos":["ping","status-lote","presenca-graca","visto-no-aviso"]}`)

const (
	// Tempo que alguém continua "online" depois de a última aba cair. Trocar
	// de tela no app fecha um WebSocket e abre outro um instante depois; sem
	// esta folga, cada navegação virava um "ficou offline" + "ficou online"
	// para todo mundo (a pessoa piscava no cabeçalho da conversa) e uma
	// escrita de lastSeen no Firestore.
	gracaPadrao = 6 * time.Second

	// Um cliente antigo guardava avisos de digitação na fila de reenvio e os
	// despejava todos de uma vez logo depois de autenticar. Nada que chega
	// nesse primeiro instante é digitação de verdade.
	carenciaDigitacao = 1500 * time.Millisecond

	// Cliente saudável avisa "digitando" no máximo uma vez por segundo.
	// Rajadas acima disso são descartadas.
	intervaloDigitando = 700 * time.Millisecond

	// Teto do pedido de presença em lote (a caixa de entrada mostra até 100).
	maxStatusLote = 200
)

type entrega struct {
	msg  Message
	from *Client
}

// envioDireto permite que uma goroutine auxiliar (por exemplo, a que consulta
// o lastSeen no Firestore) peça ao hub para entregar algo, sem tocar no mapa
// de conexões por fora da goroutine Run.
type envioDireto struct {
	para *Client
	msg  Message
}

// saidaPendente é alguém cuja última aba caiu há menos de h.graca.
type saidaPendente struct {
	desde   int64 // quando a última aba caiu (ms) — é o lastSeen de verdade
	geracao uint64
	timer   *time.Timer
}

type expiracao struct {
	username string
	geracao  uint64
}

// Hub mantém o conjunto de conexões vivas. Todo o estado é tocado
// exclusivamente pela goroutine Run, o que dispensa mutex.
type Hub struct {
	Clients    map[string]map[*Client]bool
	Register   chan *Client
	Unregister chan *Client
	Broadcast  chan entrega
	Direto     chan envioDireto

	// Kick força a desconexão de todas as abas de um usuário — usado pelo
	// endpoint administrativo de banimento (ver main.go, /admin/kick).
	Kick chan string

	expirou chan expiracao
	parar   chan chan struct{}

	identity *Identity

	graca     time.Duration
	saidas    map[string]*saidaPendente
	geracao   uint64
	visto     map[string]int64     // lastSeen recente, em memória
	digitando map[string]time.Time // "de\x00para" -> último "digitando" repassado

	agora func() time.Time
}

func NovoHub(identity *Identity) *Hub {
	graca := gracaPadrao
	if v, err := strconv.Atoi(os.Getenv("PRESENCE_GRACE_MS")); err == nil && v >= 0 {
		graca = time.Duration(v) * time.Millisecond
	}
	return &Hub{
		Clients:    make(map[string]map[*Client]bool),
		Register:   make(chan *Client, 64),
		Unregister: make(chan *Client, 64),
		Broadcast:  make(chan entrega, 256),
		Direto:     make(chan envioDireto, 256),
		Kick:       make(chan string, 64),
		expirou:    make(chan expiracao, 256),
		parar:      make(chan chan struct{}),
		identity:   identity,
		graca:      graca,
		saidas:     make(map[string]*saidaPendente),
		visto:      make(map[string]int64),
		digitando:  make(map[string]time.Time),
		agora:      time.Now,
	}
}

// DesconectarUsuario agenda o fechamento de todas as abas de um usuário.
// Seguro pra chamar de qualquer goroutine (por exemplo, de um handler HTTP) —
// só a goroutine Run toca o mapa de conexões de verdade; isso apenas
// enfileira o pedido.
func (h *Hub) DesconectarUsuario(username string) {
	select {
	case h.Kick <- username:
	default:
		log.Printf("[hub] fila de kick cheia, descartando pedido para %s", username)
	}
}

// Encerrar grava o lastSeen de quem ainda está conectado e fecha todas as
// conexões. Chamado no desligamento do servidor (o Render manda SIGTERM a cada
// deploy e quando o plano gratuito adormece): sem isto, todo mundo que estava
// online ficava com o "visto por último" da sessão anterior.
func (h *Hub) Encerrar(limite time.Duration) {
	pronto := make(chan struct{})
	select {
	case h.parar <- pronto:
	case <-time.After(limite):
		return
	}
	select {
	case <-pronto:
	case <-time.After(limite):
	}
}

// enviar entrega sem nunca bloquear. Um cliente que não consegue acompanhar o
// próprio buffer é desconectado, em vez de travar o hub inteiro.
func (h *Hub) enviar(c *Client, msg Message) {
	if c == nil || c.fechado {
		return
	}
	select {
	case c.Send <- msg:
	default:
		log.Printf("[hub] buffer cheio, desconectando %s", c.Username)
		h.remover(c, false)
	}
}

// remover tira a conexão do mapa e fecha o canal exatamente uma vez.
// imediato pula a folga de presença (banimento, por exemplo).
func (h *Hub) remover(c *Client, imediato bool) {
	conns, ok := h.Clients[c.Username]
	if !ok {
		return
	}
	if _, existe := conns[c]; !existe {
		return
	}

	delete(conns, c)
	if !c.fechado {
		c.fechado = true
		close(c.Send)
	}

	if len(conns) > 0 {
		log.Printf("[-] aba de %s encerrada (restam %d)", c.Username, len(conns))
		return
	}

	delete(h.Clients, c.Username)
	agora := h.agora().UnixMilli()

	if imediato || h.graca <= 0 {
		h.finalizarSaida(c.Username, agora)
		return
	}

	// Ainda não avisa ninguém: se uma aba nova chegar dentro da folga, para
	// os outros a pessoa nunca saiu.
	h.geracao++
	s := &saidaPendente{desde: agora, geracao: h.geracao}
	username, geracao := c.Username, h.geracao
	s.timer = time.AfterFunc(h.graca, func() {
		h.expirou <- expiracao{username: username, geracao: geracao}
	})
	if anterior := h.saidas[username]; anterior != nil {
		anterior.timer.Stop()
	}
	h.saidas[username] = s
}

// finalizarSaida é o "ficou offline" de verdade.
func (h *Hub) finalizarSaida(username string, desde int64) {
	if len(h.visto) > 50000 {
		h.visto = make(map[string]int64)
	}
	h.visto[username] = desde
	h.broadcastPresenca(username, "offline", desde)
	h.identity.RegistrarSaida(username, desde)
	log.Printf("[-] %s ficou offline", username)
}

// broadcastPresenca avisa todo mundo (menos a própria pessoa) que alguém mudou
// de estado. O offline leva o lastSeen junto: antes o cliente ia buscar no
// Firestore e, como a gravação é assíncrona, podia ler o valor da sessão
// ANTERIOR — "visto ontem" de alguém que tinha acabado de sair.
func (h *Hub) broadcastPresenca(username, status string, lastSeen int64) {
	msg := Message{Type: "status_update", From: username, Content: status}
	if status == "offline" {
		msg.LastSeen = lastSeen
	}

	for outroUser, conns := range h.Clients {
		if outroUser == username {
			continue
		}
		for c := range copiar(conns) {
			h.enviar(c, msg)
		}
	}
}

func copiar(conns map[*Client]bool) map[*Client]bool {
	saida := make(map[*Client]bool, len(conns))
	for c := range conns {
		saida[c] = true
	}
	return saida
}

// online considera a folga: quem acabou de trocar de tela continua online.
func (h *Hub) online(username string) bool {
	return len(h.Clients[username]) > 0 || h.saidas[username] != nil
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.Register:
			conns, ok := h.Clients[client.Username]
			if !ok {
				conns = make(map[*Client]bool)
				h.Clients[client.Username] = conns
			}
			conns[client] = true
			log.Printf("[+] %s conectou (abas: %d)", client.Username, len(conns))

			if s := h.saidas[client.Username]; s != nil {
				// Voltou dentro da folga: para os outros, nunca saiu.
				s.timer.Stop()
				delete(h.saidas, client.Username)
				continue
			}

			// Só avisa o mundo na primeira aba: abrir a segunda aba não é
			// um novo "ficou online".
			if len(conns) == 1 {
				delete(h.visto, client.Username)
				h.broadcastPresenca(client.Username, "online", 0)
			}

		case client := <-h.Unregister:
			h.remover(client, false)

		case username := <-h.Kick:
			// Sem isso, uma conta banida com uma aba já aberta continuava
			// conectada normalmente até o token expirar (até 1h).
			for c := range copiar(h.Clients[username]) {
				h.remover(c, true)
			}
			if s := h.saidas[username]; s != nil {
				s.timer.Stop()
				delete(h.saidas, username)
				h.finalizarSaida(username, s.desde)
			}

		case e := <-h.Broadcast:
			h.rotear(e)

		case d := <-h.Direto:
			h.enviar(d.para, d.msg)

		case x := <-h.expirou:
			s := h.saidas[x.username]
			if s == nil || s.geracao != x.geracao {
				continue // voltou antes da hora, ou já foi tratado
			}
			delete(h.saidas, x.username)
			h.finalizarSaida(x.username, s.desde)

		case pronto := <-h.parar:
			h.desligar()
			close(pronto)
		}
	}
}

// desligar persiste o lastSeen de todo mundo e fecha as conexões. Não avisa
// "offline" a ninguém: os clientes reconectam sozinhos na instância nova.
func (h *Hub) desligar() {
	agora := h.agora().UnixMilli()
	saidas := make(map[string]int64, len(h.Clients)+len(h.saidas))
	for username := range h.Clients {
		saidas[username] = agora
	}
	for username, s := range h.saidas {
		s.timer.Stop()
		saidas[username] = s.desde
	}
	h.saidas = make(map[string]*saidaPendente)

	for username, conns := range h.Clients {
		for c := range conns {
			if !c.fechado {
				c.fechado = true
				close(c.Send)
			}
		}
		delete(h.Clients, username)
	}

	if len(saidas) > 0 && h.identity != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := h.identity.RegistrarSaidas(ctx, saidas); err != nil {
			log.Printf("[presenca] falha ao gravar lastSeen no desligamento: %v", err)
		}
	}
	log.Printf("[hub] encerrado (%d usuários tinham sessão)", len(saidas))
}

// responderStatus devolve a presença de alvo para quem perguntou.
func (h *Hub) responderStatus(de *Client, alvo string) {
	resposta := Message{Type: "status_reply", From: alvo, To: de.Username, Content: "offline"}

	if h.online(alvo) {
		resposta.Content = "online"
		h.enviar(de, resposta)
		return
	}

	// Saiu há pouco: o valor em memória é o mais fresco que existe (a escrita
	// no Firestore pode nem ter terminado ainda).
	if visto, ok := h.visto[alvo]; ok {
		resposta.LastSeen = visto
		h.enviar(de, resposta)
		return
	}

	if h.identity == nil {
		h.enviar(de, resposta)
		return
	}

	// A consulta ao Firestore roda fora da goroutine do hub e a resposta
	// volta pelo canal Direto.
	go func() {
		resposta.LastSeen = h.identity.UltimoAcesso(alvo)
		select {
		case h.Direto <- envioDireto{para: de, msg: resposta}:
		default:
		}
	}()
}

func (h *Hub) rotear(e entrega) {
	msg := e.msg

	// A identidade do remetente vem do token, não do payload.
	msg.From = e.from.Username

	if !tiposPermitidos[msg.Type] {
		return
	}

	switch msg.Type {
	case "ping":
		h.enviar(e.from, Message{Type: "pong", Timestamp: h.agora().UnixMilli()})
		return

	case "status_lote":
		var alvos []string
		if err := json.Unmarshal(msg.Payload, &alvos); err != nil {
			return
		}
		vistos := make(map[string]bool, len(alvos))
		for _, alvo := range alvos {
			if len(vistos) >= maxStatusLote {
				break
			}
			if alvo == "" || alvo == msg.From || vistos[alvo] {
				continue
			}
			vistos[alvo] = true
			h.responderStatus(e.from, alvo)
		}
		return
	}

	if msg.To == "" || msg.To == msg.From {
		return
	}

	switch msg.Type {
	case "status_check":
		h.responderStatus(e.from, msg.To)
		return

	case "digitando", "parou_digitando":
		agora := h.agora()
		if !e.from.conectadoEm.IsZero() && agora.Sub(e.from.conectadoEm) < carenciaDigitacao {
			return
		}
		chave := msg.From + "\x00" + msg.To
		if msg.Type == "digitando" {
			if ultimo, ok := h.digitando[chave]; ok && agora.Sub(ultimo) < intervaloDigitando {
				return
			}
			if len(h.digitando) > 20000 {
				h.digitando = make(map[string]time.Time)
			}
			h.digitando[chave] = agora
		} else {
			delete(h.digitando, chave)
		}
	}

	// Entrega em todas as abas/dispositivos do destinatário.
	for c := range copiar(h.Clients[msg.To]) {
		h.enviar(c, msg)
	}

	// Ecoa para as outras abas do próprio remetente, para que uma mensagem
	// enviada no celular apareça na aba aberta no computador.
	if msg.Type == "chat" {
		for c := range copiar(h.Clients[msg.From]) {
			if c != e.from {
				h.enviar(c, msg)
			}
		}
	}
}
