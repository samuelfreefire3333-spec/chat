package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"
)

// Presenca persiste e consulta o "visto por último". Em produção é o Firestore
// (identity.go); nos testes, um dublê.
type Presenca interface {
	RegistrarSaida(username string, quando int64)
	RegistrarSaidas(ctx context.Context, saidas map[string]int64) error
	UltimosAcessos(ctx context.Context, usernames []string) map[string]int64
}

// recursosDoServidor vai no auth_ok. O cliente só liga o que o servidor
// anuncia — assim um front-end novo continua funcionando contra um backend
// antigo (e vice-versa) durante a janela entre os dois deploys.
//
//	aviso-por-conversa: o aviso "chat" pode ir sem destinatário; o servidor
//	                    entrega a todos os participantes da conversa.
//	erros:              recusas voltam como {"type":"erro","content":código}.
var recursosDoServidor = json.RawMessage(`{"versao":3,"recursos":["ping","status-lote","presenca-graca","visto-no-aviso","aviso-por-conversa","erros"]}`)

const (
	// Tempo que alguém continua "online" depois de a última aba cair. Trocar
	// de tela no app fecha um WebSocket e abre outro um instante depois; sem
	// esta folga, cada navegação virava um "ficou offline" + "ficou online".
	gracaPadrao = 6 * time.Second

	// Um cliente antigo guardava avisos de digitação na fila de reenvio e os
	// despejava todos de uma vez logo depois de autenticar.
	carenciaDigitacao = 1500 * time.Millisecond

	// Cliente saudável avisa "digitando" no máximo uma vez por segundo.
	intervaloDigitando = 700 * time.Millisecond

	// Consultas simultâneas de "visto por último" ao Firestore.
	maxConsultasPresenca = 8
)

type entrega struct {
	msg  Message
	from *Client
	// conversa que autorizou o repasse (nil para ping e presença).
	conversa *InfoConversa
	// alvos de presença já validados.
	alvos []string
}

// envioDireto permite que outra goroutine peça ao hub para entregar algo, sem
// tocar no mapa de conexões por fora da goroutine Run.
type envioDireto struct {
	para *Client
	msgs []Message
}

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
	Clients    map[string]map[*Client]bool // @ -> abas
	porUID     map[string]map[*Client]bool // uid -> abas
	Register   chan *Client
	Unregister chan *Client
	Broadcast  chan entrega
	Direto     chan envioDireto

	// Kick força a desconexão de todas as abas de um @ (banimento) e KickUID
	// de todas as abas de um uid (sessões revogadas).
	Kick    chan string
	KickUID chan string

	expirou chan expiracao
	parar   chan chan struct{}

	presenca Presenca

	graca         time.Duration
	maxPorUsuario int
	saidas        map[string]*saidaPendente
	geracao       uint64
	visto         map[string]int64     // lastSeen recente, em memória
	digitando     map[string]time.Time // "de\x00para" -> último "digitando" repassado

	// Consultas de presença que vão ao Firestore, por uid.
	orcamentoPresenca *LimitadorPorChave
	semaforoPresenca  chan struct{}

	agora func() time.Time
}

// NovoHub cria o hub. presenca pode ser nil (testes): aí o "visto por último"
// só vem da memória.
func NovoHub(presenca Presenca) *Hub {
	return &Hub{
		Clients:           make(map[string]map[*Client]bool),
		porUID:            make(map[string]map[*Client]bool),
		Register:          make(chan *Client, 64),
		Unregister:        make(chan *Client, 64),
		Broadcast:         make(chan entrega, 256),
		Direto:            make(chan envioDireto, 256),
		Kick:              make(chan string, 64),
		KickUID:           make(chan string, 64),
		expirou:           make(chan expiracao, 256),
		parar:             make(chan chan struct{}),
		presenca:          presenca,
		graca:             gracaPadrao,
		maxPorUsuario:     10,
		saidas:            make(map[string]*saidaPendente),
		visto:             make(map[string]int64),
		digitando:         make(map[string]time.Time),
		orcamentoPresenca: NovoLimitadorPorChave(1200, 400),
		semaforoPresenca:  make(chan struct{}, maxConsultasPresenca),
		agora:             time.Now,
	}
}

// DesconectarUsuario agenda o fechamento de todas as abas de um @. Seguro de
// chamar de qualquer goroutine.
func (h *Hub) DesconectarUsuario(username string) {
	select {
	case h.Kick <- username:
	default:
		slog.Warn("fila de desconexão cheia", "usuario", username)
	}
}

// DesconectarUID agenda o fechamento de todas as abas de uma conta.
func (h *Hub) DesconectarUID(uid string) {
	select {
	case h.KickUID <- uid:
	default:
		slog.Warn("fila de desconexão cheia", "uid", uid)
	}
}

// Encerrar grava o lastSeen de quem ainda está conectado e fecha todas as
// conexões (SIGTERM do Render a cada deploy).
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

// enviar entrega sem nunca bloquear. Um cliente que não acompanha o próprio
// buffer é desconectado, em vez de travar o hub inteiro.
func (h *Hub) enviar(c *Client, msg Message) {
	if c == nil || c.fechado {
		return
	}
	select {
	case c.Send <- msg:
	default:
		slog.Warn("buffer cheio, desconectando", "usuario", c.Username)
		h.remover(c, false)
	}
}

func (h *Hub) indexar(c *Client) {
	conns, ok := h.Clients[c.Username]
	if !ok {
		conns = make(map[*Client]bool)
		h.Clients[c.Username] = conns
	}
	conns[c] = true
	if c.UID != "" {
		porUID, ok := h.porUID[c.UID]
		if !ok {
			porUID = make(map[*Client]bool)
			h.porUID[c.UID] = porUID
		}
		porUID[c] = true
	}
}

// remover tira a conexão dos mapas e fecha o canal exatamente uma vez.
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
	if c.UID != "" {
		if porUID := h.porUID[c.UID]; porUID != nil {
			delete(porUID, c)
			if len(porUID) == 0 {
				delete(h.porUID, c.UID)
			}
		}
	}
	if !c.fechado {
		c.fechado = true
		close(c.Send)
	}

	if len(conns) > 0 {
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
	if h.presenca != nil {
		h.presenca.RegistrarSaida(username, desde)
	}
}

// broadcastPresenca avisa todo mundo (menos a própria pessoa) que alguém mudou
// de estado. O offline leva o lastSeen junto.
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

// registrar coloca a aba nova no ar. Acima do teto de abas por conta, a mais
// antiga é fechada: é o comportamento de "sessão aberta em outro lugar" e
// impede que uma conta sozinha ocupe centenas de conexões.
func (h *Hub) registrar(client *Client) {
	if conns := h.Clients[client.Username]; h.maxPorUsuario > 0 && len(conns) >= h.maxPorUsuario {
		var maisAntiga *Client
		for c := range conns {
			if maisAntiga == nil || c.conectadoEm.Before(maisAntiga.conectadoEm) {
				maisAntiga = c
			}
		}
		if maisAntiga != nil {
			slog.Info("teto de abas por conta, fechando a mais antiga", "usuario", client.Username)
			// Continua havendo abas (a nova entra logo abaixo): não é saída.
			delete(conns, maisAntiga)
			if porUID := h.porUID[maisAntiga.UID]; porUID != nil {
				delete(porUID, maisAntiga)
			}
			if !maisAntiga.fechado {
				maisAntiga.fechado = true
				close(maisAntiga.Send)
			}
		}
	}

	h.indexar(client)
	conns := h.Clients[client.Username]

	if s := h.saidas[client.Username]; s != nil {
		// Voltou dentro da folga: para os outros, nunca saiu.
		s.timer.Stop()
		delete(h.saidas, client.Username)
		return
	}

	// Só avisa o mundo na primeira aba.
	if len(conns) == 1 {
		delete(h.visto, client.Username)
		h.broadcastPresenca(client.Username, "online", 0)
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.Register:
			h.registrar(client)

		case client := <-h.Unregister:
			h.remover(client, false)

		case username := <-h.Kick:
			for c := range copiar(h.Clients[username]) {
				h.remover(c, true)
			}
			if s := h.saidas[username]; s != nil {
				s.timer.Stop()
				delete(h.saidas, username)
				h.finalizarSaida(username, s.desde)
			}

		case uid := <-h.KickUID:
			for c := range copiar(h.porUID[uid]) {
				h.remover(c, true)
			}

		case e := <-h.Broadcast:
			h.rotear(e)

		case d := <-h.Direto:
			for _, msg := range d.msgs {
				h.enviar(d.para, msg)
			}

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
	h.porUID = make(map[string]map[*Client]bool)

	if len(saidas) > 0 && h.presenca != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := h.presenca.RegistrarSaidas(ctx, saidas); err != nil {
			slog.Error("falha ao gravar lastSeen no desligamento", "erro", err)
		}
	}
	slog.Info("hub encerrado", "usuarios", len(saidas))
}

// responderPresenca devolve a presença de cada alvo para quem perguntou. O
// que não está em memória é consultado no Firestore em lote, fora da goroutine
// do hub, com orçamento por conta: sem ele, um cliente pedindo 200 @ a cada
// quadro gerava dezenas de milhares de leituras pagas por minuto.
func (h *Hub) responderPresenca(de *Client, alvos []string) {
	var pendentes []string
	for _, alvo := range alvos {
		resposta := Message{Type: "status_reply", From: alvo, To: de.Username, Content: "offline"}
		if h.online(alvo) {
			resposta.Content = "online"
			h.enviar(de, resposta)
			continue
		}
		// Saiu há pouco: o valor em memória é o mais fresco que existe.
		if visto, ok := h.visto[alvo]; ok {
			resposta.LastSeen = visto
			h.enviar(de, resposta)
			continue
		}
		pendentes = append(pendentes, alvo)
	}
	if len(pendentes) == 0 {
		return
	}

	semConsulta := func() {
		for _, alvo := range pendentes {
			h.enviar(de, Message{Type: "status_reply", From: alvo, To: de.Username, Content: "offline"})
		}
	}
	if h.presenca == nil || !h.orcamentoPresenca.PermitirN(de.UID, len(pendentes)) {
		// Sem lastSeen: o cliente cai para o valor gravado no perfil.
		semConsulta()
		return
	}
	select {
	case h.semaforoPresenca <- struct{}{}:
	default:
		semConsulta()
		return
	}

	go func(para *Client, alvos []string) {
		defer func() { <-h.semaforoPresenca }()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		vistos := h.presenca.UltimosAcessos(ctx, alvos)
		msgs := make([]Message, 0, len(alvos))
		for _, alvo := range alvos {
			msgs = append(msgs, Message{Type: "status_reply", From: alvo, To: para.Username, Content: "offline", LastSeen: vistos[alvo]})
		}
		select {
		case h.Direto <- envioDireto{para: para, msgs: msgs}:
		case <-time.After(2 * time.Second):
		}
	}(de, pendentes)
}

// entregarNaConversa entrega msg nas abas de "username" que participam da
// conversa. É a segunda metade da autorização: o remetente já foi conferido
// na leitura do quadro; aqui se confere cada destinatário pelo uid da aba.
func (h *Hub) entregarNaConversa(username string, msg Message, conversa *InfoConversa) {
	for c := range copiar(h.Clients[username]) {
		if conversa.Participa(c.UID) {
			h.enviar(c, msg)
		}
	}
}

func (h *Hub) rotear(e entrega) {
	msg := e.msg
	// A identidade do remetente vem do token, não do quadro.
	msg.From = e.from.Username

	switch msg.Type {
	case tipoPing:
		h.enviar(e.from, Message{Type: "pong", Timestamp: h.agora().UnixMilli()})
		return

	case tipoStatusCheck, tipoStatusLote:
		h.responderPresenca(e.from, e.alvos)
		return
	}

	// Daqui para baixo tudo é repasse, e repasse só com conversa autorizada.
	if e.conversa == nil || !e.conversa.Participa(e.from.UID) {
		return
	}

	switch msg.Type {
	case tipoChat:
		if msg.To != "" {
			// Cliente antigo: um quadro por destinatário.
			h.entregarNaConversa(msg.To, msg, e.conversa)
		} else {
			// Um quadro só; o servidor entrega a todos os participantes.
			for uid := range e.conversa.UIDs {
				for c := range copiar(h.porUID[uid]) {
					if c == e.from || c.fechado {
						continue
					}
					copia := msg
					copia.To = c.Username
					h.enviar(c, copia)
				}
			}
			return
		}
		// Eco para as outras abas do próprio remetente (celular → computador).
		for c := range copiar(h.Clients[msg.From]) {
			if c != e.from {
				h.enviar(c, msg)
			}
		}
		return

	case tipoDigitando, tipoParouDigitando:
		agora := h.agora()
		if !e.from.conectadoEm.IsZero() && agora.Sub(e.from.conectadoEm) < carenciaDigitacao {
			return
		}
		chave := msg.From + "\x00" + msg.To
		if msg.Type == tipoDigitando {
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
		h.entregarNaConversa(msg.To, msg, e.conversa)

	case tipoChamada, tipoCancelarChamada, tipoWebRTC:
		h.entregarNaConversa(msg.To, msg, e.conversa)
	}
}
