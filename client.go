package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	authWait   = 10 * time.Second

	// Teto de quadros por conexão, somando todos os tipos. Estourar isto é
	// flood automatizado: a conexão cai. Os limites por tipo (abaixo) são
	// mais finos e só descartam o excesso.
	limiteMensagens = 150
	janelaLimite    = 10 * time.Second

	// Recusas (quadro inválido, sem autorização, acima do limite) toleradas
	// por minuto antes de a conexão ser encerrada por abuso.
	maxViolacoesPorMinuto = 30
)

// LimitesPorTipo aplica limites por conta (uid) e por tipo de quadro. Por
// conta, e não por conexão: abrir dez abas não multiplica o limite.
type LimitesPorTipo struct {
	porTipo map[string]*LimitadorPorChave
}

func NovosLimitesPorTipo() *LimitesPorTipo {
	return &LimitesPorTipo{porTipo: map[string]*LimitadorPorChave{
		// Cliente antigo manda um aviso por participante num grupo (até 19).
		tipoChat:            NovoLimitadorPorChave(240, 60),
		tipoDigitando:       NovoLimitadorPorChave(240, 40),
		tipoParouDigitando:  NovoLimitadorPorChave(240, 40),
		tipoStatusCheck:     NovoLimitadorPorChave(120, 40),
		tipoStatusLote:      NovoLimitadorPorChave(20, 6),
		tipoChamada:         NovoLimitadorPorChave(12, 4),
		tipoCancelarChamada: NovoLimitadorPorChave(60, 20),
		// Candidatos ICE chegam em rajadas e a oferta é reenviada até a
		// resposta chegar.
		tipoWebRTC: NovoLimitadorPorChave(1200, 300),
		tipoPing:   NovoLimitadorPorChave(30, 10),
	}}
}

func (l *LimitesPorTipo) Permitir(uid, tipo string) bool {
	lim := l.porTipo[tipo]
	if lim == nil {
		return false
	}
	return lim.Permitir(uid)
}

// servicosWS são as dependências de uma conexão autenticada.
type servicosWS struct {
	autorizador *Autorizador
	limites     *LimitesPorTipo
	seguranca   *RegistroDeSeguranca
}

type Client struct {
	Username string
	UID      string
	IP       string
	Conn     *websocket.Conn
	Send     chan Message
	hub      *Hub
	svc      *servicosWS

	// fechado é lido e escrito apenas pela goroutine Hub.Run.
	fechado bool

	// conectadoEm marca o fim do handshake. O hub descarta avisos de
	// digitação colados nele e fecha a aba mais antiga acima do teto.
	conectadoEm time.Time

	// Tocados apenas pela readPump.
	janelaInicio   time.Time
	contador       int
	violacoes      int
	violacoesDesde time.Time
	ultimoErro     time.Time

	aoFechar       func()
	aoFecharUmaVez sync.Once
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

// processar valida, limita e autoriza um quadro. Devolve o que o hub deve
// rotear, ou o código de erro a devolver ao cliente.
func (c *Client) processar(ctx context.Context, bruto Message) (*entrega, string) {
	q, err := validarQuadro(bruto, c.Username)
	if err != nil {
		return nil, erroQuadroInvalido
	}
	if c.svc != nil && c.svc.limites != nil && !c.svc.limites.Permitir(c.UID, q.msg.Type) {
		return nil, erroLimite
	}

	e := &entrega{msg: q.msg, from: c, alvos: q.alvos}
	if q.conversa == "" {
		return e, ""
	}
	if c.svc == nil || c.svc.autorizador == nil {
		return nil, erroNaoAutorizado
	}

	info, err := c.svc.autorizador.Autorizar(ctx, c.UID, q.conversa)
	switch {
	case err == nil:
		e.conversa = &info
		return e, ""
	case errors.Is(err, ErrMuitasConsultas):
		return nil, erroLimite
	case errors.Is(err, ErrSemConversa), errors.Is(err, ErrNaoParticipante), errors.Is(err, ErrConversaInvalida):
		return nil, erroNaoAutorizado
	default:
		// Firestore fora do ar: nega (fecha o repasse), mas sem culpar o cliente.
		slog.Warn("falha ao consultar conversa", "erro", err)
		return nil, erroIndisponivel
	}
}

// registrarViolacao conta recusas; devolve true quando passou do tolerável.
func (c *Client) registrarViolacao(codigo, tipo string) bool {
	if codigo == erroIndisponivel {
		return false
	}
	agora := time.Now()
	if agora.Sub(c.violacoesDesde) > time.Minute {
		c.violacoesDesde = agora
		c.violacoes = 0
	}
	c.violacoes++
	if c.svc != nil && c.svc.seguranca != nil {
		evento := "ws_negado"
		if codigo == erroLimite {
			evento = "ws_limite"
		} else if codigo == erroQuadroInvalido {
			evento = "ws_quadro_invalido"
		}
		c.svc.seguranca.RegistrarComIntervalo(evento+"|"+c.UID, 10*time.Second, EventoDeSeguranca{
			Tipo: evento, UID: c.UID, IP: c.IP, Detalhe: tipo,
		})
	}
	return c.violacoes > maxViolacoesPorMinuto
}

// avisarErro devolve o código de recusa ao próprio cliente (no máximo um por
// segundo), sempre pelo hub: só a goroutine dele escreve no canal Send.
func (c *Client) avisarErro(codigo, tipo string) {
	agora := time.Now()
	if agora.Sub(c.ultimoErro) < time.Second {
		return
	}
	c.ultimoErro = agora
	select {
	case c.hub.Direto <- envioDireto{para: c, msgs: []Message{quadroDeErro(codigo, tipo)}}:
	default:
	}
}

// fecharComMotivo manda o quadro de fechamento. WriteControl pode ser chamado
// junto com a writePump (o gorilla/websocket garante isso só para ele).
func (c *Client) fecharComMotivo(codigo int, motivo string) {
	c.Conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(codigo, motivo), time.Now().Add(writeWait))
}

func (c *Client) readPump() {
	defer func() {
		c.hub.Unregister <- c
		c.Conn.Close()
		c.aoFecharUmaVez.Do(func() {
			if c.aoFechar != nil {
				c.aoFechar()
			}
		})
	}()

	c.Conn.SetReadLimit(maxTamanhoQuadro)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		var msg Message
		if err := c.Conn.ReadJSON(&msg); err != nil {
			// JSON quebrado ou com tipo trocado ({"to": {"$gt": ""}}, por
			// exemplo) não sai de cliente honesto: encerra com motivo e
			// registra, em vez de só cair em silêncio.
			var errSintaxe *json.SyntaxError
			var errTipo *json.UnmarshalTypeError
			if errors.As(err, &errSintaxe) || errors.As(err, &errTipo) {
				if c.svc != nil && c.svc.seguranca != nil {
					c.svc.seguranca.Registrar(EventoDeSeguranca{Tipo: "ws_quadro_malformado", UID: c.UID, IP: c.IP})
				}
				c.fecharComMotivo(websocket.CloseInvalidFramePayloadData, "quadro inválido")
				return
			}
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Debug("leitura encerrada", "usuario", c.Username, "erro", err)
			}
			return
		}
		// Qualquer quadro prova que a conexão está viva.
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))

		if !c.permitido() {
			if c.svc != nil && c.svc.seguranca != nil {
				c.svc.seguranca.Registrar(EventoDeSeguranca{Tipo: "ws_flood", UID: c.UID, IP: c.IP})
			}
			c.fecharComMotivo(websocket.ClosePolicyViolation, "limite de mensagens")
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		e, codigo := c.processar(ctx, msg)
		cancel()

		if codigo != "" {
			if c.registrarViolacao(codigo, msg.Type) {
				if c.svc != nil && c.svc.seguranca != nil {
					c.svc.seguranca.Registrar(EventoDeSeguranca{Tipo: "ws_abuso", UID: c.UID, IP: c.IP})
				}
				c.fecharComMotivo(websocket.ClosePolicyViolation, "abuso detectado")
				return
			}
			c.avisarErro(codigo, msg.Type)
			continue
		}

		select {
		case c.hub.Broadcast <- *e:
		default:
			// Hub congestionado: descarta em vez de bloquear a leitura.
			slog.Warn("fila do hub cheia, descartando quadro", "usuario", c.Username)
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
