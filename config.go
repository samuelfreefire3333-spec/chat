package main

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Ambientes aceitos em APP_ENV. O padrão é produção: esquecer a variável nunca
// pode abrir o servidor para origens de desenvolvimento.
const (
	AmbienteProducao        = "production"
	AmbienteDesenvolvimento = "development"
)

// Onde o app está publicado. Antes a lista vivia só na variável
// ALLOWED_ORIGINS do Render: se ela sumisse, ninguém mais conectava.
var origensDeProducao = []string{
	"https://sinexchat.netlify.app",
	"https://chat-parameuamor.web.app",
	"https://chat-parameuamor.firebaseapp.com",
}

// Só valem com APP_ENV=development. Em produção, uma página qualquer servida
// em localhost na máquina de alguém não tem por que falar com este servidor.
var origensDeDesenvolvimento = []string{
	"http://localhost:8080",
	"http://localhost:3000",
	"http://localhost:5500",
	"http://127.0.0.1:8080",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:5500",
}

// Config reúne tudo o que vem do ambiente. Nenhum segredo tem valor padrão.
type Config struct {
	Ambiente        string
	Porta           string
	ProjetoFirebase string
	CredenciaisJSON string

	OrigensPermitidas map[string]bool

	// ConfiarProxy: o Render (e a Cloudflare na frente dele) informam o IP
	// real do cliente em cabeçalhos. Fora de um proxy confiável esses
	// cabeçalhos são forjáveis e o IP da conexão é o que vale.
	ConfiarProxy bool

	// ExigirHTTPS recusa conexões que o proxy informa terem chegado sem TLS
	// (X-Forwarded-Proto diferente de https).
	ExigirHTTPS bool

	GracaPresenca         time.Duration
	MaxConexoes           int
	MaxConexoesPorIP      int
	MaxConexoesPorUsuario int
}

// Producao diz se o servidor está no ar para o público.
func (c Config) Producao() bool { return c.Ambiente == AmbienteProducao }

// CarregarConfig lê e valida a configuração. getenv é os.Getenv em produção e
// um mapa nos testes.
func CarregarConfig(getenv func(string) string) (Config, error) {
	cfg := Config{
		Ambiente:        strings.ToLower(strings.TrimSpace(getenv("APP_ENV"))),
		Porta:           strings.TrimSpace(getenv("PORT")),
		ProjetoFirebase: strings.TrimSpace(getenv("FIREBASE_PROJECT_ID")),
		CredenciaisJSON: getenv("FIREBASE_SERVICE_ACCOUNT_JSON"),
	}

	switch cfg.Ambiente {
	case "", "prod", AmbienteProducao:
		cfg.Ambiente = AmbienteProducao
	case "dev", AmbienteDesenvolvimento:
		cfg.Ambiente = AmbienteDesenvolvimento
	default:
		return Config{}, fmt.Errorf("APP_ENV inválido: %q (use production ou development)", cfg.Ambiente)
	}

	if cfg.Porta == "" {
		cfg.Porta = "8080"
	}
	if p, err := strconv.Atoi(cfg.Porta); err != nil || p < 1 || p > 65535 {
		return Config{}, fmt.Errorf("PORT inválida: %q", cfg.Porta)
	}
	if cfg.ProjetoFirebase == "" {
		cfg.ProjetoFirebase = "chat-parameuamor"
	}

	origens := append([]string{}, origensDeProducao...)
	if !cfg.Producao() {
		origens = append(origens, origensDeDesenvolvimento...)
	}
	if extra := strings.TrimSpace(getenv("ALLOWED_ORIGINS")); extra != "" {
		origens = append(origens, strings.Split(extra, ",")...)
	}
	cfg.OrigensPermitidas = make(map[string]bool, len(origens))
	for _, bruta := range origens {
		bruta = strings.TrimSpace(bruta)
		if bruta == "" {
			continue
		}
		origem, err := normalizarOrigem(bruta, cfg.Producao())
		if err != nil {
			return Config{}, fmt.Errorf("ALLOWED_ORIGINS: %w", err)
		}
		cfg.OrigensPermitidas[origem] = true
	}

	var err error
	if cfg.ConfiarProxy, err = lerBool(getenv, "TRUST_PROXY_HEADERS", cfg.Producao()); err != nil {
		return Config{}, err
	}
	if cfg.ExigirHTTPS, err = lerBool(getenv, "REQUIRE_HTTPS", false); err != nil {
		return Config{}, err
	}

	graca, err := lerInteiro(getenv, "PRESENCE_GRACE_MS", 6000, 0, 60000)
	if err != nil {
		return Config{}, err
	}
	cfg.GracaPresenca = time.Duration(graca) * time.Millisecond

	if cfg.MaxConexoes, err = lerInteiro(getenv, "MAX_CONNECTIONS", 5000, 1, 1000000); err != nil {
		return Config{}, err
	}
	if cfg.MaxConexoesPorIP, err = lerInteiro(getenv, "MAX_CONNECTIONS_PER_IP", 30, 1, 100000); err != nil {
		return Config{}, err
	}
	if cfg.MaxConexoesPorUsuario, err = lerInteiro(getenv, "MAX_CONNECTIONS_PER_USER", 10, 1, 1000); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// normalizarOrigem aceita só "esquema://host[:porta]", sem caminho, usuário,
// consulta ou curinga. "*" e "null" nunca entram: com eles qualquer site
// abriria WebSocket e chamaria os endpoints em nome de quem visita.
func normalizarOrigem(bruta string, producao bool) (string, error) {
	if bruta == "*" || strings.EqualFold(bruta, "null") {
		return "", fmt.Errorf("origem %q não é permitida", bruta)
	}
	u, err := url.Parse(bruta)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return "", fmt.Errorf("origem malformada: %q", bruta)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("origem deve ser só esquema://host[:porta]: %q", bruta)
	}
	if strings.Contains(u.Host, "*") {
		return "", fmt.Errorf("curinga não é aceito em origem: %q", bruta)
	}
	esquema := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Host)
	switch esquema {
	case "https":
	case "http":
		local := strings.HasPrefix(host, "localhost") || strings.HasPrefix(host, "127.0.0.1")
		if producao && !local {
			return "", fmt.Errorf("origem sem HTTPS não é aceita em produção: %q", bruta)
		}
	default:
		return "", fmt.Errorf("esquema não suportado em origem: %q", bruta)
	}
	return esquema + "://" + host, nil
}

func lerBool(getenv func(string) string, nome string, padrao bool) (bool, error) {
	v := strings.ToLower(strings.TrimSpace(getenv(nome)))
	switch v {
	case "":
		return padrao, nil
	case "1", "true", "sim", "yes", "on":
		return true, nil
	case "0", "false", "nao", "não", "no", "off":
		return false, nil
	}
	return false, fmt.Errorf("%s inválido: %q", nome, v)
}

func lerInteiro(getenv func(string) string, nome string, padrao, minimo, maximo int) (int, error) {
	v := strings.TrimSpace(getenv(nome))
	if v == "" {
		return padrao, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s inválido: %q", nome, v)
	}
	if n < minimo || n > maximo {
		return 0, fmt.Errorf("%s fora do intervalo [%d, %d]: %d", nome, minimo, maximo, n)
	}
	return n, nil
}
