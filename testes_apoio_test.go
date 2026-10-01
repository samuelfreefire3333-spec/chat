package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ==========================================================================
// Dublês dos contratos com o Firebase (contratos.go)
// ==========================================================================

type verificadorFalso struct {
	mu     sync.Mutex
	contas map[string]Identidade // token -> identidade
	erros  map[string]error      // token -> erro
}

func novoVerificadorFalso() *verificadorFalso {
	return &verificadorFalso{contas: map[string]Identidade{}, erros: map[string]error{}}
}

func (v *verificadorFalso) conta(token, username, uid string, admin bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.contas[token] = Identidade{Username: username, UID: uid, Admin: admin}
}

func (v *verificadorFalso) falhar(token string, err error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.erros[token] = err
}

func (v *verificadorFalso) Verificar(_ context.Context, token string) (Identidade, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if err, ok := v.erros[token]; ok {
		return Identidade{}, err
	}
	if id, ok := v.contas[token]; ok {
		return id, nil
	}
	return Identidade{}, ErrTokenInvalido
}

func (v *verificadorFalso) VerificarToken(ctx context.Context, token string) (TokenVerificado, error) {
	v.mu.Lock()
	err, temErro := v.erros[token]
	id, temConta := v.contas[token]
	v.mu.Unlock()
	if temErro && err != ErrSemIdentidade {
		return TokenVerificado{}, err
	}
	if !temConta {
		return TokenVerificado{}, ErrTokenInvalido
	}
	return TokenVerificado{UID: id.UID, Admin: id.Admin}, nil
}

type adminFalso struct {
	mu        sync.Mutex
	uids      map[string]string // @ -> uid
	statuses  map[string]string // @ -> status
	revogados []string
	falha     error
}

func novoAdminFalso() *adminFalso {
	return &adminFalso{uids: map[string]string{}, statuses: map[string]string{}}
}

func (a *adminFalso) UIDDoUsername(_ context.Context, username string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	uid, ok := a.uids[username]
	if !ok {
		return "", ErrUsuarioNaoEncontrado
	}
	return uid, nil
}

func (a *adminFalso) DefinirStatus(_ context.Context, username, _, status string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.falha != nil {
		return a.falha
	}
	a.statuses[username] = status
	return nil
}

func (a *adminFalso) Contadores(context.Context) (int64, int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.falha != nil {
		return 0, 0, a.falha
	}
	return int64(len(a.uids)), 2, nil
}

func (a *adminFalso) RevogarSessoes(_ context.Context, uid string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.falha != nil {
		return a.falha
	}
	a.revogados = append(a.revogados, uid)
	return nil
}

type conversasFalsas struct {
	mu        sync.Mutex
	chats     map[string]InfoConversa
	consultas int
}

func novasConversasFalsas() *conversasFalsas {
	return &conversasFalsas{chats: map[string]InfoConversa{}}
}

func (c *conversasFalsas) criar(id, tipo string, uids ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	info := InfoConversa{Existe: true, Tipo: tipo, UIDs: map[string]bool{}}
	for _, u := range uids {
		info.UIDs[u] = true
	}
	c.chats[id] = info
}

func (c *conversasFalsas) Conversa(_ context.Context, id string) (InfoConversa, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consultas++
	info, ok := c.chats[id]
	if !ok {
		return InfoConversa{Existe: false}, nil
	}
	return info, nil
}

func (c *conversasFalsas) totalConsultas() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.consultas
}

type presencaFalsa struct {
	mu        sync.Mutex
	vistos    map[string]int64
	consultas int
	lidos     int
}

func (p *presencaFalsa) RegistrarSaida(username string, quando int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.vistos == nil {
		p.vistos = map[string]int64{}
	}
	p.vistos[username] = quando
}

func (p *presencaFalsa) RegistrarSaidas(_ context.Context, saidas map[string]int64) error {
	for u, q := range saidas {
		p.RegistrarSaida(u, q)
	}
	return nil
}

func (p *presencaFalsa) UltimosAcessos(_ context.Context, usernames []string) map[string]int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.consultas++
	p.lidos += len(usernames)
	saida := map[string]int64{}
	for _, u := range usernames {
		saida[u] = p.vistos[u]
	}
	return saida
}

// ==========================================================================
// Servidor de teste
// ==========================================================================

const origemDoApp = "https://sinexchat.netlify.app"

type ambienteDeTeste struct {
	t         *testing.T
	srv       *servidor
	http      *httptest.Server
	tokens    *verificadorFalso
	admin     *adminFalso
	conversas *conversasFalsas
	presenca  *presencaFalsa
}

func configDeTeste(t *testing.T, extra map[string]string) Config {
	t.Helper()
	env := map[string]string{
		"APP_ENV":             "production",
		"TRUST_PROXY_HEADERS": "false",
		"PRESENCE_GRACE_MS":   "0",
	}
	for k, v := range extra {
		env[k] = v
	}
	cfg, err := CarregarConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	return cfg
}

// novoAmbiente sobe um servidor completo com dublês. Os ajustes rodam antes
// de o hub e o servidor HTTP começarem (mexer depois seria corrida de dados).
func novoAmbiente(t *testing.T, ajustes ...func(*servidor)) *ambienteDeTeste {
	t.Helper()
	a := &ambienteDeTeste{
		t:         t,
		tokens:    novoVerificadorFalso(),
		admin:     novoAdminFalso(),
		conversas: novasConversasFalsas(),
		presenca:  &presencaFalsa{},
	}
	a.srv = novoServidor(configDeTeste(t, nil), a.tokens, a.admin, a.conversas, a.presenca)
	for _, ajuste := range ajustes {
		ajuste(a.srv)
	}
	go a.srv.hub.Run()
	a.http = httptest.NewServer(a.srv.rotas())
	t.Cleanup(a.http.Close)

	// Três pessoas e as conversas entre elas:
	//   ana_bruno (direta), grupo "G" com ana, bruno e carla.
	a.tokens.conta("tok-ana", "ana", "uid-ana", false)
	a.tokens.conta("tok-bruno", "bruno", "uid-bruno", false)
	a.tokens.conta("tok-carla", "carla", "uid-carla", false)
	a.tokens.conta("tok-admin", "chefe", "uid-chefe", true)
	a.admin.uids["ana"] = "uid-ana"
	a.admin.uids["bruno"] = "uid-bruno"
	a.admin.uids["carla"] = "uid-carla"
	a.admin.uids["chefe"] = "uid-chefe"
	a.conversas.criar("ana_bruno", "direto", "uid-ana", "uid-bruno")
	a.conversas.criar("GrupoAleatorio000001", "grupo", "uid-ana", "uid-bruno", "uid-carla")
	return a
}

func (a *ambienteDeTeste) urlWS() string {
	return "ws" + strings.TrimPrefix(a.http.URL, "http") + "/ws"
}

// discar abre o WebSocket sem autenticar.
func (a *ambienteDeTeste) discar(origem string) (*websocket.Conn, *http.Response, error) {
	cab := http.Header{}
	if origem != "" {
		cab.Set("Origin", origem)
	}
	return websocket.DefaultDialer.Dial(a.urlWS(), cab)
}

// conectar abre o WebSocket, autentica e espera o auth_ok.
func (a *ambienteDeTeste) conectar(token string) *websocket.Conn {
	a.t.Helper()
	conn, _, err := a.discar(origemDoApp)
	if err != nil {
		a.t.Fatalf("discar: %v", err)
	}
	a.t.Cleanup(func() { conn.Close() })
	if err := conn.WriteJSON(map[string]string{"type": "auth", "token": token}); err != nil {
		a.t.Fatalf("auth: %v", err)
	}
	msg := lerQuadro(a.t, conn, 2*time.Second)
	if msg.Type != "auth_ok" {
		a.t.Fatalf("esperava auth_ok, veio %+v", msg)
	}
	return conn
}

func lerQuadro(t *testing.T, conn *websocket.Conn, prazo time.Duration) Message {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(prazo))
	var msg Message
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatalf("nenhum quadro recebido: %v", err)
	}
	return msg
}

// lerAte descarta quadros (presença, por exemplo) até achar o tipo pedido.
func lerAte(t *testing.T, conn *websocket.Conn, tipo string, prazo time.Duration) Message {
	t.Helper()
	fim := time.Now().Add(prazo)
	for time.Now().Before(fim) {
		conn.SetReadDeadline(fim)
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			t.Fatalf("esperava %q, conexão terminou: %v", tipo, err)
		}
		if msg.Type == tipo {
			return msg
		}
	}
	t.Fatalf("esperava %q e não chegou", tipo)
	return Message{}
}

// nadaDoTipo garante que nenhum quadro do tipo chega dentro do prazo.
func nadaDoTipo(t *testing.T, conn *websocket.Conn, tipo string, prazo time.Duration) {
	t.Helper()
	fim := time.Now().Add(prazo)
	for {
		conn.SetReadDeadline(fim)
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			return // prazo acabou sem o quadro
		}
		if msg.Type == tipo {
			t.Fatalf("não devia ter chegado %q: %+v", tipo, msg)
		}
	}
}

// esperarFechamento lê até a conexão fechar e devolve o código e o motivo.
func esperarFechamento(t *testing.T, conn *websocket.Conn, prazo time.Duration) (int, string) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(prazo))
	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err == nil {
			continue
		}
		if ce, ok := err.(*websocket.CloseError); ok {
			return ce.Code, ce.Text
		}
		return -1, err.Error()
	}
}

func enviarJSON(t *testing.T, conn *websocket.Conn, v any) {
	t.Helper()
	if err := conn.WriteJSON(v); err != nil {
		t.Fatalf("enviar: %v", err)
	}
}

func payload(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
