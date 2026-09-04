package main

import (
	"encoding/json"
	"log"
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
	"status_check":     true,
	"chamada":          true,
	"cancelar_chamada": true,
	"webrtc":           true,
}

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

// Hub mantém o conjunto de conexões vivas. Todo o estado (Clients) é tocado
// exclusivamente pela goroutine Run, o que dispensa mutex.
type Hub struct {
	Clients    map[string]map[*Client]bool
	Register   chan *Client
	Unregister chan *Client
	Broadcast  chan entrega
	Direto     chan envioDireto

	identity *Identity
}

func NovoHub(identity *Identity) *Hub {
	return &Hub{
		Clients:    make(map[string]map[*Client]bool),
		Register:   make(chan *Client, 64),
		Unregister: make(chan *Client, 64),
		Broadcast:  make(chan entrega, 256),
		Direto:     make(chan envioDireto, 256),
		identity:   identity,
	}
}

// enviar entrega sem nunca bloquear. Um cliente que não consegue acompanhar o
// próprio buffer é desconectado, em vez de travar o hub inteiro (era o que
// acontecia na resposta de status_check da versão anterior).
func (h *Hub) enviar(c *Client, msg Message) {
	if c == nil || c.fechado {
		return
	}
	select {
	case c.Send <- msg:
	default:
		log.Printf("[hub] buffer cheio, desconectando %s", c.Username)
		h.remover(c)
	}
}

// remover tira a conexão do mapa e fecha o canal exatamente uma vez.
func (h *Hub) remover(c *Client) {
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

	if len(conns) == 0 {
		delete(h.Clients, c.Username)
		h.broadcastPresenca(c.Username, "offline")
		h.identity.RegistrarSaida(c.Username)
		log.Printf("[-] %s ficou offline", c.Username)
	} else {
		log.Printf("[-] aba de %s encerrada (restam %d)", c.Username, len(conns))
	}
}

// broadcastPresenca avisa todo mundo (menos a própria pessoa) que alguém mudou
// de estado. Iteramos sobre uma cópia das conexões porque enviar pode remover.
func (h *Hub) broadcastPresenca(username, status string) {
	msg := Message{Type: "status_update", From: username, Content: status}

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

func (h *Hub) online(username string) bool {
	return len(h.Clients[username]) > 0
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

			// Só avisa o mundo na primeira aba: abrir a segunda aba não é
			// um novo "ficou online".
			if len(conns) == 1 {
				h.broadcastPresenca(client.Username, "online")
			}

		case client := <-h.Unregister:
			h.remover(client)

		case e := <-h.Broadcast:
			h.rotear(e)

		case d := <-h.Direto:
			h.enviar(d.para, d.msg)
		}
	}
}

func (h *Hub) rotear(e entrega) {
	msg := e.msg

	// A identidade do remetente vem do token, não do payload.
	msg.From = e.from.Username

	if !tiposPermitidos[msg.Type] {
		return
	}
	if msg.To == "" || msg.To == msg.From {
		return
	}

	if msg.Type == "status_check" {
		resposta := Message{
			Type:    "status_reply",
			From:    msg.To,
			To:      msg.From,
			Content: "offline",
		}

		if h.online(msg.To) {
			resposta.Content = "online"
			h.enviar(e.from, resposta)
			return
		}

		// Offline: buscamos o último acesso para o cliente poder mostrar
		// "visto por último" sem uma leitura extra. A consulta ao Firestore
		// roda fora da goroutine do hub e a resposta volta pelo canal Direto.
		if h.identity == nil {
			h.enviar(e.from, resposta)
			return
		}
		alvo, destino := msg.To, e.from
		go func() {
			resposta.LastSeen = h.identity.UltimoAcesso(alvo)
			select {
			case h.Direto <- envioDireto{para: destino, msg: resposta}:
			default:
			}
		}()
		return
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
