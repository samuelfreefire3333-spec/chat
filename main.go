package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var origensPadrao = []string{
	"https://chat-parameuamor.firebaseapp.com",
	"https://chat-parameuamor.web.app",
	"http://localhost:8080",
	"http://localhost:3000",
	"http://localhost:5500",
	"http://127.0.0.1:5500",
	"http://127.0.0.1:3000",
}

func origensPermitidas() map[string]bool {
	lista := origensPadrao
	if extra := os.Getenv("ALLOWED_ORIGINS"); extra != "" {
		lista = append(lista, strings.Split(extra, ",")...)
	}

	set := make(map[string]bool, len(lista))
	for _, o := range lista {
		if o = strings.TrimSpace(o); o != "" {
			set[o] = true
		}
	}
	return set
}

type servidor struct {
	hub      *Hub
	identity *Identity
	upgrader websocket.Upgrader
}

// mensagemAuth é o primeiro quadro que o cliente deve enviar após o handshake.
// O token vem por aqui, e não na query string, para não vazar em logs de
// acesso e proxies.
type mensagemAuth struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

func (s *servidor) serveWs(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	// O cliente tem uma janela curta para se identificar.
	conn.SetReadLimit(maxMessageSize)
	if err := conn.SetReadDeadline(time.Now().Add(authWait)); err != nil {
		conn.Close()
		return
	}

	var quadro mensagemAuth
	if err := conn.ReadJSON(&quadro); err != nil || quadro.Type != "auth" || quadro.Token == "" {
		fecharCom(conn, websocket.ClosePolicyViolation, "handshake de autenticacao ausente")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	ident, err := s.identity.Verificar(ctx, quadro.Token)
	if err != nil {
		motivo := "token invalido"
		switch {
		case errors.Is(err, ErrContaBloqueada):
			motivo = "conta suspensa ou banida"
		case errors.Is(err, ErrSemIdentidade):
			motivo = "perfil nao encontrado"
		}
		log.Printf("[auth] recusado (%s): %v", motivo, err)
		fecharCom(conn, websocket.ClosePolicyViolation, motivo)
		return
	}

	client := &Client{
		Username:     ident.Username,
		UID:          ident.UID,
		Conn:         conn,
		Send:         make(chan Message, 256),
		hub:          s.hub,
		janelaInicio: time.Now(),
	}

	s.hub.Register <- client

	// Confirma para o cliente qual identidade o servidor reconheceu.
	client.Send <- Message{Type: "auth_ok", To: ident.Username, Content: ident.Username}

	go client.writePump()
	go client.readPump()
}

func fecharCom(conn *websocket.Conn, codigo int, motivo string) {
	conn.SetWriteDeadline(time.Now().Add(writeWait))
	conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(codigo, motivo))
	conn.Close()
}

// pedidoKick é o corpo esperado por /admin/kick.
type pedidoKick struct {
	Username string `json:"username"`
}

// serveAdminKick força a desconexão imediata de todas as abas de um usuário.
// Chamado pelo painel admin (admin.js) logo depois de banir/suspender uma
// conta no Firestore — sem isso, uma sessão já aberta continuava válida até
// o token expirar (até 1h), mesmo com a conta suspensa.
//
// Como o upgrade do WebSocket não passa por aqui, este endpoint é a única
// porta HTTP "de verdade" do backend, então a autorização é conferida do
// zero: o token tem que ser válido E carregar o custom claim "admin" — a
// mesma claim que as regras do Firestore já exigem para banir alguém.
func (s *servidor) serveAdminKick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := s.identity.VerificarAdmin(ctx, token); err != nil {
		log.Printf("[admin] /admin/kick recusado: %v", err)
		w.WriteHeader(http.StatusForbidden)
		return
	}

	var corpo pedidoKick
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&corpo); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	username := strings.ToLower(strings.TrimSpace(corpo.Username))
	if username == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.hub.DesconectarUsuario(username)
	w.WriteHeader(http.StatusOK)
}

// comCORS libera as mesmas origens já aceitas pelo WebSocket para endpoints
// HTTP comuns, e responde ao preflight que o navegador manda por causa do
// header Authorization.
func comCORS(permitidas map[string]bool, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if permitidas[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

func main() {
	ctx := context.Background()

	projectID := os.Getenv("FIREBASE_PROJECT_ID")
	if projectID == "" {
		projectID = "chat-parameuamor"
	}

	identity, err := NovaIdentity(ctx, projectID, os.Getenv("FIREBASE_SERVICE_ACCOUNT_JSON"))
	if err != nil {
		log.Fatalf("nao foi possivel inicializar o Firebase Admin: %v", err)
	}
	defer identity.Close()

	hub := NovoHub(identity)
	go hub.Run()

	permitidas := origensPermitidas()
	s := &servidor{
		hub:      hub,
		identity: identity,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				if permitidas[origin] {
					return true
				}
				log.Printf("[bloqueio] origem nao autorizada: %q", origin)
				return false
			},
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.serveWs)
	mux.HandleFunc("/admin/kick", comCORS(permitidas, s.serveAdminKick))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Sinex Chat Backend ativo"))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}

	log.Printf("Servidor WebSocket do Sinex Chat iniciado na porta %s", port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("Erro fatal no servidor: ", err)
	}
}
