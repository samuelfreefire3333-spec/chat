package main

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
)

// ==========================================================================
// Cabeçalhos, CORS, IP do cliente e respostas JSON
// ==========================================================================

// comCabecalhosDeSeguranca vale para toda resposta do backend. O backend não
// serve HTML: a CSP "default-src 'none'" garante que, mesmo que algum dia
// sirva por engano, nada ali executa.
func comCabecalhosDeSeguranca(producao bool, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cab := w.Header()
		cab.Set("X-Content-Type-Options", "nosniff")
		cab.Set("X-Frame-Options", "DENY")
		cab.Set("Referrer-Policy", "no-referrer")
		cab.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		cab.Set("Cross-Origin-Opener-Policy", "same-origin")
		cab.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		cab.Set("Cache-Control", "no-store")
		if producao {
			cab.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		h.ServeHTTP(w, r)
	})
}

// comRecuperacao transforma pânico em 500 genérico. O detalhe (e a pilha)
// fica só no log interno.
func comRecuperacao(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				slog.Error("panico no handler", "rota", r.URL.Path, "erro", rec, "pilha", string(debug.Stack()))
				responderErro(w, http.StatusInternalServerError, "interno")
			}
		}()
		h.ServeHTTP(w, r)
	})
}

// comCORS libera só as origens configuradas, só os métodos pedidos, só
// Authorization e Content-Type, e nunca credenciais (o backend não usa
// cookie — a autenticação é o ID token no cabeçalho Authorization).
func comCORS(permitidas map[string]bool, metodos string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origem := r.Header.Get("Origin")
		w.Header().Add("Vary", "Origin")
		if origem != "" && permitidas[origem] {
			w.Header().Set("Access-Control-Allow-Origin", origem)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", metodos+", OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			if origem != "" && !permitidas[origem] {
				responderErro(w, http.StatusForbidden, "origem_nao_permitida")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// Defesa em profundidade contra requisição cruzada: se o navegador
		// disse de onde vem, tem que ser de uma origem conhecida. Clientes
		// fora do navegador não mandam Origin e ainda precisam do token.
		if origem != "" && !permitidas[origem] {
			responderErro(w, http.StatusForbidden, "origem_nao_permitida")
			return
		}
		h(w, r)
	}
}

// ipDoCliente devolve o IP de quem conectou. Atrás do Render/Cloudflare o IP
// da conexão é o do proxy; aí vale CF-Connecting-IP (a Cloudflare sobrescreve
// o que o cliente mandar) ou o último item de X-Forwarded-For (o que o proxy
// acrescentou). Sem proxy confiável, esses cabeçalhos são forjáveis e são
// ignorados.
func ipDoCliente(r *http.Request, confiarProxy bool) string {
	if confiarProxy {
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("CF-Connecting-IP"))); ip != nil {
			return ip.String()
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			partes := strings.Split(xff, ",")
			if ip := net.ParseIP(strings.TrimSpace(partes[len(partes)-1])); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// requisicaoSegura diz se a requisição chegou por HTTPS (direto ou pelo proxy).
func requisicaoSegura(r *http.Request, confiarProxy bool) bool {
	if r.TLS != nil {
		return true
	}
	return confiarProxy && strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// tokenDoCabecalho lê "Authorization: Bearer <token>".
func tokenDoCabecalho(r *http.Request) string {
	valor := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(valor) < 8 || !strings.EqualFold(valor[:7], "bearer ") {
		return ""
	}
	token := strings.TrimSpace(valor[7:])
	if len(token) > 4096 || strings.ContainsAny(token, " \t\r\n") {
		return ""
	}
	return token
}

type respostaDeErro struct {
	Erro string `json:"erro"`
}

// responderErro manda só um código curto. Nada de mensagem de exceção, pilha,
// caminho ou nome de coleção: o detalhe vai para o log interno.
func responderErro(w http.ResponseWriter, status int, codigo string) {
	responderJSON(w, status, respostaDeErro{Erro: codigo})
}

func responderJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// lerJSON exige Content-Type JSON, corta o corpo em "maximo" bytes, recusa
// campo desconhecido e lixo depois do objeto.
func lerJSON(w http.ResponseWriter, r *http.Request, maximo int64, destino any) (int, string) {
	tipo, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || tipo != "application/json" {
		return http.StatusUnsupportedMediaType, "tipo_de_conteudo_invalido"
	}
	r.Body = http.MaxBytesReader(w, r.Body, maximo)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(destino); err != nil {
		var grande *http.MaxBytesError
		if errors.As(err, &grande) {
			return http.StatusRequestEntityTooLarge, "corpo_grande_demais"
		}
		return http.StatusBadRequest, "json_invalido"
	}
	if _, err := dec.Token(); err != io.EOF {
		return http.StatusBadRequest, "json_invalido"
	}
	return 0, ""
}
