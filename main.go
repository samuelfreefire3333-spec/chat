package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type servidor struct {
	cfg      Config
	hub      *Hub
	tokens   VerificadorDeTokens
	admin    AdministracaoDeContas
	svc      *servicosWS
	upgrader websocket.Upgrader

	conexoes   *ContadorDeConexoes
	handshakes *LimitadorPorChave // por IP
	falhasAuth *ContadorDeFalhas  // por IP
	httpPorIP  *LimitadorPorChave // endpoints HTTP, por IP
	revogacoes *LimitadorPorChave // "sair de todos os aparelhos", por uid
	relatosCSP *LimitadorPorChave // relatórios de CSP, por IP
	seguranca  *RegistroDeSeguranca
}

// mensagemAuth é o primeiro quadro que o cliente deve enviar após o handshake.
// O token vem por aqui, e não na URL, para não vazar em logs e proxies.
type mensagemAuth struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

func novoServidor(cfg Config, tokens VerificadorDeTokens, admin AdministracaoDeContas, conversas FonteDeConversas, presenca Presenca) *servidor {
	seguranca := NovoRegistroDeSeguranca(500, slog.Default())
	hub := NovoHub(presenca)
	hub.graca = cfg.GracaPresenca
	hub.maxPorUsuario = cfg.MaxConexoesPorUsuario

	s := &servidor{
		cfg:    cfg,
		hub:    hub,
		tokens: tokens,
		admin:  admin,
		svc: &servicosWS{
			autorizador: NovoAutorizador(conversas),
			limites:     NovosLimitesPorTipo(),
			seguranca:   seguranca,
		},
		conexoes:   NovoContadorDeConexoes(cfg.MaxConexoes, cfg.MaxConexoesPorIP),
		handshakes: NovoLimitadorPorChave(60, 20),
		falhasAuth: NovoContadorDeFalhas(20, 10*time.Minute, 15*time.Minute),
		httpPorIP:  NovoLimitadorPorChave(60, 20),
		revogacoes: NovoLimitadorPorChave(6, 3),
		relatosCSP: NovoLimitadorPorChave(30, 10),
		seguranca:  seguranca,
	}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			origem := r.Header.Get("Origin")
			if cfg.OrigensPermitidas[origem] {
				return true
			}
			s.seguranca.RegistrarComIntervalo("origem|"+origem, time.Minute, EventoDeSeguranca{
				Tipo: "ws_origem_recusada", IP: ipDoCliente(r, cfg.ConfiarProxy), Detalhe: origem,
			})
			return false
		},
	}
	return s
}

// rotas monta o roteamento com os middlewares de segurança.
func (s *servidor) rotas() http.Handler {
	mux := http.NewServeMux()
	o := s.cfg.OrigensPermitidas

	mux.HandleFunc("/ws", s.serveWs)
	mux.HandleFunc("/admin/kick", comCORS(o, "POST", s.serveAdminKick))
	mux.HandleFunc("/admin/status", comCORS(o, "POST", s.serveAdminStatus))
	mux.HandleFunc("/admin/seguranca", comCORS(o, "GET", s.serveAdminSeguranca))
	mux.HandleFunc("/admin/contadores", comCORS(o, "GET", s.serveAdminContadores))
	mux.HandleFunc("/sessoes/revogar", comCORS(o, "POST", s.serveRevogarSessoes))
	// report-to (Reporting API) entrega com pré-verificação CORS; report-uri
	// chega sem Origin. Origem desconhecida não entra (evita que outro site
	// aponte a CSP dele para cá e encha o registro).
	mux.HandleFunc("/seguranca/csp", comCORS(o, "POST", s.serveRelatorioCSP))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			responderErro(w, http.StatusNotFound, "nao_encontrado")
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("Sinex Chat Backend ativo"))
	})

	return comRecuperacao(comCabecalhosDeSeguranca(s.cfg.Producao(), mux))
}

// ==========================================================================
// WebSocket
// ==========================================================================

func (s *servidor) serveWs(w http.ResponseWriter, r *http.Request) {
	ip := ipDoCliente(r, s.cfg.ConfiarProxy)

	if s.cfg.ExigirHTTPS && !requisicaoSegura(r, s.cfg.ConfiarProxy) {
		responderErro(w, http.StatusForbidden, "use_wss")
		return
	}
	if s.falhasAuth.Bloqueado(ip) {
		w.Header().Set("Retry-After", "900")
		responderErro(w, http.StatusTooManyRequests, "muitas_tentativas")
		return
	}
	if !s.handshakes.Permitir(ip) {
		s.seguranca.RegistrarComIntervalo("handshake|"+ip, time.Minute, EventoDeSeguranca{Tipo: "ws_limite_handshake", IP: ip})
		w.Header().Set("Retry-After", "30")
		responderErro(w, http.StatusTooManyRequests, "muitas_conexoes")
		return
	}
	if !s.conexoes.Reservar(ip) {
		s.seguranca.RegistrarComIntervalo("conexoes|"+ip, time.Minute, EventoDeSeguranca{Tipo: "ws_limite_conexoes", IP: ip})
		w.Header().Set("Retry-After", "30")
		responderErro(w, http.StatusServiceUnavailable, "muitas_conexoes")
		return
	}
	liberar := true
	defer func() {
		if liberar {
			s.conexoes.Liberar(ip)
		}
	}()

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Origem recusada ou handshake malformado: o gorilla já respondeu.
		return
	}

	// O cliente tem uma janela curta, e um quadro pequeno, para se identificar.
	conn.SetReadLimit(maxTamanhoQuadroAuth)
	if err := conn.SetReadDeadline(time.Now().Add(authWait)); err != nil {
		conn.Close()
		return
	}

	var quadro mensagemAuth
	if err := conn.ReadJSON(&quadro); err != nil || quadro.Type != "auth" || quadro.Token == "" || len(quadro.Token) > 4096 {
		s.falhasAuth.Registrar(ip)
		fecharCom(conn, websocket.ClosePolicyViolation, "Autenticação ausente.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	ident, err := s.tokens.Verificar(ctx, quadro.Token)
	cancel()
	if err != nil {
		motivo, categoria := "Sessão expirada. Entre novamente.", "token_invalido"
		switch {
		case errors.Is(err, ErrContaBloqueada):
			motivo, categoria = "Conta suspensa ou banida.", "conta_bloqueada"
		case errors.Is(err, ErrSemIdentidade):
			motivo, categoria = "Perfil não encontrado.", "sem_perfil"
		case errors.Is(err, ErrTokenInvalido):
		default:
			// Falha do Firebase (rede, cota): não é culpa do cliente.
			slog.Error("falha ao verificar token", "erro", err)
			fecharCom(conn, websocket.CloseTryAgainLater, "Servidor indisponível. Tente de novo.")
			return
		}
		bloqueado := s.falhasAuth.Registrar(ip)
		s.seguranca.RegistrarComIntervalo("auth|"+ip+"|"+categoria, 10*time.Second, EventoDeSeguranca{
			Tipo: "auth_recusada", IP: ip, Detalhe: categoria,
		})
		if bloqueado {
			s.seguranca.RegistrarComIntervalo("bloqueio|"+ip, time.Minute, EventoDeSeguranca{Tipo: "auth_bloqueio_ip", IP: ip})
		}
		fecharCom(conn, websocket.ClosePolicyViolation, motivo)
		return
	}

	agora := time.Now()
	client := &Client{
		Username:     ident.Username,
		UID:          ident.UID,
		IP:           ip,
		Conn:         conn,
		Send:         make(chan Message, 256),
		hub:          s.hub,
		svc:          s.svc,
		janelaInicio: agora,
		conectadoEm:  agora,
		aoFechar:     func() { s.conexoes.Liberar(ip) },
	}
	liberar = false

	// auth_ok vai para o buffer ANTES do registro: é sempre o primeiro quadro.
	client.Send <- Message{Type: "auth_ok", To: ident.Username, Content: ident.Username, Payload: recursosDoServidor}
	s.hub.Register <- client

	go client.writePump()
	go client.readPump()
}

func fecharCom(conn *websocket.Conn, codigo int, motivo string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(codigo, motivo), time.Now().Add(writeWait))
	conn.Close()
}

// ==========================================================================
// Endpoints HTTP autenticados
// ==========================================================================

// autenticar confere o Bearer token: 401 sem token ou com token inválido,
// 403 quando exigeAdmin e a claim não está lá. Devolve false se já respondeu.
func (s *servidor) autenticar(w http.ResponseWriter, r *http.Request, exigeAdmin bool) (TokenVerificado, bool) {
	ip := ipDoCliente(r, s.cfg.ConfiarProxy)
	if s.falhasAuth.Bloqueado(ip) {
		w.Header().Set("Retry-After", "900")
		responderErro(w, http.StatusTooManyRequests, "muitas_tentativas")
		return TokenVerificado{}, false
	}
	if !s.httpPorIP.Permitir(ip) {
		w.Header().Set("Retry-After", "30")
		responderErro(w, http.StatusTooManyRequests, "muitas_requisicoes")
		return TokenVerificado{}, false
	}
	token := tokenDoCabecalho(r)
	if token == "" {
		responderErro(w, http.StatusUnauthorized, "nao_autenticado")
		return TokenVerificado{}, false
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	tok, err := s.tokens.VerificarToken(ctx, token)
	if err != nil {
		if errors.Is(err, ErrTokenInvalido) || errors.Is(err, ErrContaBloqueada) {
			s.falhasAuth.Registrar(ip)
			s.seguranca.RegistrarComIntervalo("http401|"+ip, 10*time.Second, EventoDeSeguranca{Tipo: "http_nao_autenticado", IP: ip, Detalhe: r.URL.Path})
			responderErro(w, http.StatusUnauthorized, "nao_autenticado")
			return TokenVerificado{}, false
		}
		slog.Error("falha ao verificar token", "erro", err)
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return TokenVerificado{}, false
	}
	if exigeAdmin && !tok.Admin {
		s.seguranca.Registrar(EventoDeSeguranca{Tipo: "http_proibido", UID: tok.UID, IP: ip, Detalhe: r.URL.Path})
		responderErro(w, http.StatusForbidden, "sem_permissao")
		return TokenVerificado{}, false
	}
	return tok, true
}

type pedidoKick struct {
	Username string `json:"username"`
}

// serveAdminKick derruba na hora todas as abas de um @ (depois de banir).
func (s *servidor) serveAdminKick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		responderErro(w, http.StatusMethodNotAllowed, "metodo_nao_permitido")
		return
	}
	tok, ok := s.autenticar(w, r, true)
	if !ok {
		return
	}
	var corpo pedidoKick
	if status, codigo := lerJSON(w, r, 4096, &corpo); status != 0 {
		responderErro(w, status, codigo)
		return
	}
	username := strings.ToLower(strings.TrimSpace(corpo.Username))
	if !usernameValido(username) {
		responderErro(w, http.StatusBadRequest, "usuario_invalido")
		return
	}
	s.hub.DesconectarUsuario(username)
	s.seguranca.Registrar(EventoDeSeguranca{Tipo: "admin_kick", UID: tok.UID, IP: ipDoCliente(r, s.cfg.ConfiarProxy), Alvo: username})
	responderJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type pedidoStatus struct {
	Username string `json:"username"`
	Status   string `json:"status"`
}

// serveAdminStatus bane, suspende ou reativa uma conta de verdade: além do
// perfil, desativa a conta no Firebase Auth, revoga as sessões e derruba as
// conexões abertas. Antes o banimento só barrava o WebSocket — a conta banida
// continuava lendo e escrevendo no Firestore.
func (s *servidor) serveAdminStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		responderErro(w, http.StatusMethodNotAllowed, "metodo_nao_permitido")
		return
	}
	tok, ok := s.autenticar(w, r, true)
	if !ok {
		return
	}
	var corpo pedidoStatus
	if status, codigo := lerJSON(w, r, 4096, &corpo); status != 0 {
		responderErro(w, status, codigo)
		return
	}
	username := strings.ToLower(strings.TrimSpace(corpo.Username))
	if !usernameValido(username) || !statusDePerfilValidos[corpo.Status] {
		responderErro(w, http.StatusBadRequest, "pedido_invalido")
		return
	}
	if s.admin == nil {
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	uid, err := s.admin.UIDDoUsername(ctx, username)
	if errors.Is(err, ErrUsuarioNaoEncontrado) {
		responderErro(w, http.StatusNotFound, "usuario_nao_encontrado")
		return
	}
	if err != nil {
		slog.Error("falha ao localizar usuario", "erro", err)
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return
	}
	if uid == tok.UID {
		responderErro(w, http.StatusBadRequest, "nao_pode_alterar_a_propria_conta")
		return
	}
	if err := s.admin.DefinirStatus(ctx, username, uid, corpo.Status); err != nil {
		slog.Error("falha ao definir status", "erro", err, "alvo", username)
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return
	}
	if corpo.Status != "ativo" {
		s.hub.DesconectarUsuario(username)
	}
	s.seguranca.Registrar(EventoDeSeguranca{
		Tipo: "admin_status", UID: tok.UID, IP: ipDoCliente(r, s.cfg.ConfiarProxy), Alvo: username, Detalhe: corpo.Status,
	})
	responderJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// serveAdminSeguranca mostra ao admin os eventos de segurança recentes.
func (s *servidor) serveAdminSeguranca(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		responderErro(w, http.StatusMethodNotAllowed, "metodo_nao_permitido")
		return
	}
	if _, ok := s.autenticar(w, r, true); !ok {
		return
	}
	resumo := s.seguranca.Resumo(100)
	responderJSON(w, http.StatusOK, map[string]any{
		"conexoesAtivas": s.conexoes.Ativas(),
		"seguranca":      resumo,
	})
}

// serveAdminContadores devolve os totais do painel (perfis e conversas).
func (s *servidor) serveAdminContadores(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		responderErro(w, http.StatusMethodNotAllowed, "metodo_nao_permitido")
		return
	}
	if _, ok := s.autenticar(w, r, true); !ok {
		return
	}
	if s.admin == nil {
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	usuarios, conversas, err := s.admin.Contadores(ctx)
	if err != nil {
		slog.Error("falha ao contar", "erro", err)
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return
	}
	responderJSON(w, http.StatusOK, map[string]int64{"usuarios": usuarios, "conversas": conversas})
}

// serveRevogarSessoes é o "sair de todos os aparelhos": invalida os refresh
// tokens da própria conta e derruba as conexões abertas. Qualquer outro
// aparelho perde o acesso quando o ID token dele expirar (até 1 h) — o
// WebSocket, que confere revogação, cai na hora.
func (s *servidor) serveRevogarSessoes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		responderErro(w, http.StatusMethodNotAllowed, "metodo_nao_permitido")
		return
	}
	tok, ok := s.autenticar(w, r, false)
	if !ok {
		return
	}
	if !s.revogacoes.Permitir(tok.UID) {
		w.Header().Set("Retry-After", "600")
		responderErro(w, http.StatusTooManyRequests, "muitas_requisicoes")
		return
	}
	if s.admin == nil {
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.admin.RevogarSessoes(ctx, tok.UID); err != nil {
		slog.Error("falha ao revogar sessoes", "erro", err)
		responderErro(w, http.StatusServiceUnavailable, "indisponivel")
		return
	}
	s.hub.DesconectarUID(tok.UID)
	s.seguranca.Registrar(EventoDeSeguranca{Tipo: "sessoes_revogadas", UID: tok.UID, IP: ipDoCliente(r, s.cfg.ConfiarProxy)})
	responderJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ==========================================================================
// Relatórios de violação de CSP
// ==========================================================================
// O navegador manda um relatório quando a CSP bloqueia algo. Em uso normal
// não chega nenhum: um pico aqui é sinal de tentativa de XSS ou de extensão
// injetando script — vale olhar.

type relatorioCSPAntigo struct {
	Relatorio struct {
		Documento string `json:"document-uri"`
		Diretiva  string `json:"effective-directive"`
		Violada   string `json:"violated-directive"`
		Bloqueado string `json:"blocked-uri"`
	} `json:"csp-report"`
}

type relatorioCSPNovo struct {
	Tipo  string `json:"type"`
	Corpo struct {
		Documento string `json:"documentURL"`
		Diretiva  string `json:"effectiveDirective"`
		Bloqueado string `json:"blockedURL"`
	} `json:"body"`
}

func (s *servidor) serveRelatorioCSP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		responderErro(w, http.StatusMethodNotAllowed, "metodo_nao_permitido")
		return
	}
	ip := ipDoCliente(r, s.cfg.ConfiarProxy)
	if !s.relatosCSP.Permitir(ip) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	tipo, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	corpo, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024))
	if err != nil {
		responderErro(w, http.StatusRequestEntityTooLarge, "corpo_grande_demais")
		return
	}

	var violacoes [][3]string // documento, diretiva, bloqueado
	switch tipo {
	case "application/csp-report", "application/json":
		var rel relatorioCSPAntigo
		if json.Unmarshal(corpo, &rel) == nil && rel.Relatorio.Documento != "" {
			diretiva := rel.Relatorio.Diretiva
			if diretiva == "" {
				diretiva = rel.Relatorio.Violada
			}
			violacoes = append(violacoes, [3]string{rel.Relatorio.Documento, diretiva, rel.Relatorio.Bloqueado})
		}
	case "application/reports+json":
		var lista []relatorioCSPNovo
		if json.Unmarshal(corpo, &lista) == nil {
			for i, rel := range lista {
				if i >= 10 {
					break
				}
				if rel.Tipo == "csp-violation" {
					violacoes = append(violacoes, [3]string{rel.Corpo.Documento, rel.Corpo.Diretiva, rel.Corpo.Bloqueado})
				}
			}
		}
	}

	for _, v := range violacoes {
		s.seguranca.RegistrarComIntervalo("csp|"+v[1]+"|"+semConsulta(v[2]), time.Minute, EventoDeSeguranca{
			Tipo: "csp_violacao", IP: ip, Alvo: semConsulta(v[0]), Detalhe: v[1] + " " + semConsulta(v[2]),
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// semConsulta tira a query string e o fragmento de uma URL antes de logar: é
// ali que costumam aparecer tokens e códigos de uso único.
func semConsulta(bruta string) string {
	u, err := url.Parse(bruta)
	if err != nil || u.Scheme == "" {
		if i := strings.IndexAny(bruta, "?#"); i >= 0 {
			return bruta[:i]
		}
		return bruta
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.User = nil
	return u.String()
}

// ==========================================================================
// main
// ==========================================================================

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg, err := CarregarConfig(os.Getenv)
	if err != nil {
		slog.Error("configuração inválida", "erro", err)
		os.Exit(1)
	}

	ctx := context.Background()
	identity, err := NovaIdentity(ctx, cfg.ProjetoFirebase, cfg.CredenciaisJSON)
	if err != nil {
		// Sem credenciais não há como verificar token: subir assim seria
		// aceitar qualquer conexão.
		slog.Error("não foi possível inicializar o Firebase Admin", "erro", err)
		os.Exit(1)
	}
	defer identity.Close()

	s := novoServidor(cfg, identity, identity, identity, identity)
	go s.hub.Run()

	srv := &http.Server{
		Addr:              ":" + cfg.Porta,
		Handler:           s.rotas(),
		ReadHeaderTimeout: 10 * time.Second,
		// Valem para as requisições HTTP comuns. O WebSocket, depois do
		// upgrade, controla os próprios prazos (o gorilla limpa estes).
		ReadTimeout:    20 * time.Second,
		WriteTimeout:   20 * time.Second,
		IdleTimeout:    90 * time.Second,
		MaxHeaderBytes: 16 * 1024,
	}

	// Desligamento limpo: o Render manda SIGTERM a cada deploy.
	sinal, pararSinal := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer pararSinal()
	encerrado := make(chan struct{})
	go func() {
		<-sinal.Done()
		slog.Info("desligando: gravando presença e fechando conexões")
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		s.hub.Encerrar(10 * time.Second)
		close(encerrado)
	}()

	origens := make([]string, 0, len(cfg.OrigensPermitidas))
	for o := range cfg.OrigensPermitidas {
		origens = append(origens, o)
	}
	slog.Info("servidor do Sinex Chat iniciado", "porta", cfg.Porta, "ambiente", cfg.Ambiente, "origens", origens, "confiarProxy", cfg.ConfiarProxy)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("erro fatal no servidor", "erro", err)
		os.Exit(1)
	}
	<-encerrado
}
