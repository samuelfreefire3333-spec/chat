package main

import (
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 65536 // 64KB — cabe uma oferta SDP folgada
	authWait       = 10 * time.Second

	// Limite de taxa: 30 mensagens por janela de 10s por conexão.
	limiteMensagens = 30
	janelaLimite    = 10 * time.Second
)

type Client struct {
	Username string
	UID      string
	Conn     *websocket.Conn
	Send     chan Message
	hub      *Hub

	// fechado é lido e escrito apenas pela goroutine Hub.Run.
	fechado bool

	// Controle de taxa, tocado apenas pela readPump.
	janelaInicio time.Time
	contador     int
}

// permitido implementa uma janela fixa simples de limite de taxa.
func (c *Client) permitido() bool {
	agora := time.Now()
	if agora.Sub(c.janelaInicio) > janelaLimite {
		c.janelaInicio = agora
		c.contador = 0
	}
	c.contador++
	return c.contador <= limiteMensagens
}

func (c *Client) readPump() {
	defer func() {
		c.hub.Unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		var msg Message
		if err := c.Conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[ws] leitura de %s encerrada: %v", c.Username, err)
			}
			return
		}

		if !c.permitido() {
			log.Printf("[ws] limite de taxa excedido por %s", c.Username)
			return
		}

		select {
		case c.hub.Broadcast <- entrega{msg: msg, from: c}:
		default:
			// Hub congestionado: descarta em vez de bloquear a leitura.
			log.Printf("[ws] fila do hub cheia, descartando mensagem de %s", c.Username)
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteJSON(msg); err != nil {
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
