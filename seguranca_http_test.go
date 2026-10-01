package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func requisicao(t *testing.T, a *ambienteDeTeste, metodo, caminho, token, tipo, corpo string, origem string) *http.Response {
	t.Helper()
	var leitor io.Reader
	if corpo != "" {
		leitor = strings.NewReader(corpo)
	}
	req, err := http.NewRequest(metodo, a.http.URL+caminho, leitor)
	if err != nil {
		t.Fatalf("requisição: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if tipo != "" {
		req.Header.Set("Content-Type", tipo)
	}
	if origem != "" {
		req.Header.Set("Origin", origem)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("requisição: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func codigoDeErro(t *testing.T, resp *http.Response) string {
	t.Helper()
	var corpo respostaDeErro
	_ = json.NewDecoder(resp.Body).Decode(&corpo)
	return corpo.Erro
}

func TestHTTPEndpointsPrivadosExigemToken(t *testing.T) {
	a := novoAmbiente(t)
	for _, rota := range []struct{ metodo, caminho string }{
		{http.MethodPost, "/admin/kick"},
		{http.MethodPost, "/admin/status"},
		{http.MethodGet, "/admin/seguranca"},
		{http.MethodGet, "/admin/contadores"},
		{http.MethodPost, "/sessoes/revogar"},
	} {
		// Sem token: 401.
		resp := requisicao(t, a, rota.metodo, rota.caminho, "", "application/json", `{}`, origemDoApp)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s sem token: esperava 401, veio %d", rota.caminho, resp.StatusCode)
		}
		// Token inválido: 401.
		resp = requisicao(t, a, rota.metodo, rota.caminho, "forjado.jwt.token", "application/json", `{}`, origemDoApp)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s com token inválido: esperava 401, veio %d", rota.caminho, resp.StatusCode)
		}
	}
}

func TestHTTPTokenExpiradoOuRevogadoRecebe401(t *testing.T) {
	a := novoAmbiente(t)
	a.tokens.falhar("tok-velho", ErrTokenInvalido)
	resp := requisicao(t, a, http.MethodPost, "/sessoes/revogar", "tok-velho", "", "", origemDoApp)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("esperava 401, veio %d", resp.StatusCode)
	}
}

func TestHTTPAdministrativoRecusaUsuarioComum(t *testing.T) {
	a := novoAmbiente(t)
	for _, rota := range []struct{ metodo, caminho, corpo string }{
		{http.MethodPost, "/admin/kick", `{"username":"bruno"}`},
		{http.MethodPost, "/admin/status", `{"username":"bruno","status":"banido"}`},
		{http.MethodGet, "/admin/seguranca", ""},
		{http.MethodGet, "/admin/contadores", ""},
	} {
		resp := requisicao(t, a, rota.metodo, rota.caminho, "tok-ana", "application/json", rota.corpo, origemDoApp)
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s por usuário comum: esperava 403, veio %d", rota.caminho, resp.StatusCode)
		}
	}
	if len(a.admin.statuses) != 0 {
		t.Fatalf("usuário comum conseguiu mudar status: %v", a.admin.statuses)
	}
}

func TestHTTPAdminBaneEDerrubaConexoes(t *testing.T) {
	a := novoAmbiente(t)
	bruno := a.conectar("tok-bruno")

	resp := requisicao(t, a, http.MethodPost, "/admin/status", "tok-admin", "application/json", `{"username":"bruno","status":"banido"}`, origemDoApp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("esperava 200, veio %d (%s)", resp.StatusCode, codigoDeErro(t, resp))
	}
	if a.admin.statuses["bruno"] != "banido" {
		t.Fatalf("status não foi aplicado: %v", a.admin.statuses)
	}
	if codigo, _ := esperarFechamento(t, bruno, 2*time.Second); codigo == -1 {
		t.Fatalf("a conexão do banido deveria cair na hora")
	}
	resumo := a.srv.seguranca.Resumo(10)
	if resumo.Contadores["admin_status"] != 1 {
		t.Fatalf("a ação do admin deveria ficar na trilha de auditoria: %+v", resumo.Contadores)
	}
}

func TestHTTPAdminNaoAlteraAPropriaConta(t *testing.T) {
	a := novoAmbiente(t)
	resp := requisicao(t, a, http.MethodPost, "/admin/status", "tok-admin", "application/json", `{"username":"chefe","status":"banido"}`, origemDoApp)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("esperava 400, veio %d", resp.StatusCode)
	}
}

func TestHTTPValidacaoDoCorpo(t *testing.T) {
	a := novoAmbiente(t)
	casos := []struct {
		nome, tipo, corpo string
		status            int
	}{
		{"sem content-type", "", `{"username":"bruno","status":"banido"}`, http.StatusUnsupportedMediaType},
		{"texto puro", "text/plain", `{"username":"bruno","status":"banido"}`, http.StatusUnsupportedMediaType},
		{"json quebrado", "application/json", `{"username":`, http.StatusBadRequest},
		{"campo desconhecido", "application/json", `{"username":"bruno","status":"banido","admin":true}`, http.StatusBadRequest},
		{"lixo depois do objeto", "application/json", `{"username":"bruno","status":"banido"}{"x":1}`, http.StatusBadRequest},
		{"status inventado", "application/json", `{"username":"bruno","status":"superadmin"}`, http.StatusBadRequest},
		{"@ com caminho", "application/json", `{"username":"../contas/uid-ana","status":"banido"}`, http.StatusBadRequest},
		{"@ com injeção", "application/json", `{"username":"bruno\" || \"1\"==\"1","status":"banido"}`, http.StatusBadRequest},
		{"@ inexistente", "application/json", `{"username":"fantasma","status":"banido"}`, http.StatusNotFound},
		{"corpo gigante", "application/json", `{"username":"` + strings.Repeat("a", 10000) + `","status":"banido"}`, http.StatusRequestEntityTooLarge},
	}
	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			resp := requisicao(t, a, http.MethodPost, "/admin/status", "tok-admin", c.tipo, c.corpo, origemDoApp)
			if resp.StatusCode != c.status {
				t.Fatalf("esperava %d, veio %d (%s)", c.status, resp.StatusCode, codigoDeErro(t, resp))
			}
		})
	}
}

func TestHTTPMetodoErradoRecebe405(t *testing.T) {
	a := novoAmbiente(t)
	resp := requisicao(t, a, http.MethodGet, "/admin/kick", "tok-admin", "", "", origemDoApp)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("esperava 405, veio %d", resp.StatusCode)
	}
}

func TestHTTPErroNaoVazaDetalheInterno(t *testing.T) {
	a := novoAmbiente(t)
	a.admin.falha = errors.New("rpc error: code = PermissionDenied desc = projects/chat-parameuamor/databases/(default)/documents/usuarios/bruno")
	resp := requisicao(t, a, http.MethodPost, "/admin/status", "tok-admin", "application/json", `{"username":"bruno","status":"banido"}`, origemDoApp)
	corpo, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("esperava 503, veio %d", resp.StatusCode)
	}
	for _, proibido := range []string{"rpc error", "projects/", "usuarios/", "PermissionDenied", "goroutine"} {
		if strings.Contains(string(corpo), proibido) {
			t.Fatalf("resposta vaza %q: %s", proibido, corpo)
		}
	}
}

func TestHTTPCORSSoParaOrigensConhecidas(t *testing.T) {
	a := novoAmbiente(t)

	// Preflight da origem do app: liberado, sem credenciais.
	resp := requisicao(t, a, http.MethodOptions, "/admin/kick", "", "", "", origemDoApp)
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != origemDoApp {
		t.Fatalf("preflight do app deveria passar: %d %v", resp.StatusCode, resp.Header)
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("o backend não usa cookie; não deve liberar credenciais")
	}
	if metodos := resp.Header.Get("Access-Control-Allow-Methods"); strings.Contains(metodos, "DELETE") || strings.Contains(metodos, "PUT") {
		t.Fatalf("métodos liberados demais: %q", metodos)
	}

	// Origem desconhecida: nada de Allow-Origin, e a requisição de verdade é
	// recusada (proteção contra requisição cruzada).
	resp = requisicao(t, a, http.MethodOptions, "/admin/kick", "", "", "", "https://evil.example")
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("origem desconhecida recebeu Allow-Origin")
	}
	resp = requisicao(t, a, http.MethodPost, "/sessoes/revogar", "tok-ana", "", "", "https://evil.example")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST de origem desconhecida deveria ser 403, veio %d", resp.StatusCode)
	}
	if len(a.admin.revogados) != 0 {
		t.Fatalf("requisição cruzada revogou sessões")
	}
}

func TestHTTPCabecalhosDeSeguranca(t *testing.T) {
	a := novoAmbiente(t)
	resp := requisicao(t, a, http.MethodGet, "/healthz", "", "", "", "")
	esperados := map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "no-referrer",
		"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
		"Cache-Control":             "no-store",
	}
	for nome, valor := range esperados {
		if resp.Header.Get(nome) != valor {
			t.Fatalf("%s: esperava %q, veio %q", nome, valor, resp.Header.Get(nome))
		}
	}
	if !strings.Contains(resp.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("CSP do backend ausente")
	}
}

func TestHTTPRotaInexistenteDevolve404Generico(t *testing.T) {
	a := novoAmbiente(t)
	resp := requisicao(t, a, http.MethodGet, "/../../etc/passwd", "", "", "", "")
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMovedPermanently {
		t.Fatalf("esperava 404, veio %d", resp.StatusCode)
	}
	resp = requisicao(t, a, http.MethodGet, "/.env", "", "", "", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("esperava 404, veio %d", resp.StatusCode)
	}
}

func TestHTTPRevogacaoTemLimite(t *testing.T) {
	a := novoAmbiente(t, func(s *servidor) { s.revogacoes = NovoLimitadorPorChave(1, 2) })
	codigos := []int{}
	for i := 0; i < 4; i++ {
		resp := requisicao(t, a, http.MethodPost, "/sessoes/revogar", "tok-ana", "", "", origemDoApp)
		codigos = append(codigos, resp.StatusCode)
	}
	if codigos[len(codigos)-1] != http.StatusTooManyRequests {
		t.Fatalf("esperava 429 no excesso, veio %v", codigos)
	}
}

func TestHTTPExcessoDeRequisicoesPorIPRecebe429(t *testing.T) {
	a := novoAmbiente(t, func(s *servidor) { s.httpPorIP = NovoLimitadorPorChave(60, 3) })
	ultimo := 0
	for i := 0; i < 6; i++ {
		resp := requisicao(t, a, http.MethodGet, "/admin/seguranca", "tok-admin", "", "", origemDoApp)
		ultimo = resp.StatusCode
	}
	if ultimo != http.StatusTooManyRequests {
		t.Fatalf("esperava 429, veio %d", ultimo)
	}
}

func TestHTTPRelatorioDeCSPEhRegistradoSemQueryString(t *testing.T) {
	a := novoAmbiente(t)
	corpo := `{"csp-report":{"document-uri":"https://sinexchat.netlify.app/chat.html?u=bruno&token=segredo","effective-directive":"script-src-elem","blocked-uri":"https://evil.example/x.js?c=roubo"}}`
	resp := requisicao(t, a, http.MethodPost, "/seguranca/csp", "", "application/csp-report", corpo, "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("esperava 204, veio %d", resp.StatusCode)
	}
	resumo := a.srv.seguranca.Resumo(5)
	if len(resumo.Recentes) == 0 || resumo.Recentes[0].Tipo != "csp_violacao" {
		t.Fatalf("violação não registrada: %+v", resumo)
	}
	for _, e := range resumo.Recentes {
		if strings.Contains(e.Alvo+e.Detalhe, "segredo") || strings.Contains(e.Alvo+e.Detalhe, "roubo") {
			t.Fatalf("query string foi para o log: %+v", e)
		}
	}
}

func TestHTTPRelatorioDeCSPAceitaPreVerificacaoSoDoApp(t *testing.T) {
	a := novoAmbiente(t)

	// Reporting API (report-to): o Chromium pergunta antes (OPTIONS).
	resp := requisicao(t, a, http.MethodOptions, "/seguranca/csp", "", "", "", origemDoApp)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("pré-verificação do app: esperava 204, veio %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != origemDoApp {
		t.Fatalf("pré-verificação sem Access-Control-Allow-Origin: %q", resp.Header.Get("Access-Control-Allow-Origin"))
	}
	if !strings.Contains(strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers")), "content-type") {
		t.Fatalf("pré-verificação precisa liberar Content-Type: %q", resp.Header.Get("Access-Control-Allow-Headers"))
	}

	corpo := `[{"type":"csp-violation","body":{"documentURL":"https://sinexchat.netlify.app/inbox.html","effectiveDirective":"img-src","blockedURL":"https://rastreador.example/p.gif?id=1"}}]`
	resp = requisicao(t, a, http.MethodPost, "/seguranca/csp", "", "application/reports+json", corpo, origemDoApp)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("relatório do app: esperava 204, veio %d", resp.StatusCode)
	}

	// Outro site apontando a CSP dele para cá: recusado.
	resp = requisicao(t, a, http.MethodOptions, "/seguranca/csp", "", "", "", "https://outro-site.example")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pré-verificação de outra origem: esperava 403, veio %d", resp.StatusCode)
	}
	resp = requisicao(t, a, http.MethodPost, "/seguranca/csp", "", "application/reports+json", corpo, "https://outro-site.example")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("relatório de outra origem: esperava 403, veio %d", resp.StatusCode)
	}
}

func TestHTTPAdminVeEventosDeSeguranca(t *testing.T) {
	a := novoAmbiente(t)
	requisicao(t, a, http.MethodPost, "/admin/kick", "tok-ana", "application/json", `{"username":"bruno"}`, origemDoApp)
	resp := requisicao(t, a, http.MethodGet, "/admin/seguranca", "tok-admin", "", "", origemDoApp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("esperava 200, veio %d", resp.StatusCode)
	}
	var corpo struct {
		Seguranca ResumoDeSeguranca `json:"seguranca"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&corpo); err != nil {
		t.Fatalf("json: %v", err)
	}
	if corpo.Seguranca.Contadores["http_proibido"] == 0 {
		t.Fatalf("a tentativa de usuário comum no endpoint admin deveria aparecer: %+v", corpo.Seguranca.Contadores)
	}
}

func TestHTTPContadoresDoPainel(t *testing.T) {
	a := novoAmbiente(t)
	resp := requisicao(t, a, http.MethodGet, "/admin/contadores", "tok-admin", "", "", origemDoApp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("esperava 200, veio %d", resp.StatusCode)
	}
	var corpo map[string]int64
	if err := json.NewDecoder(resp.Body).Decode(&corpo); err != nil || corpo["usuarios"] != 4 || corpo["conversas"] != 2 {
		t.Fatalf("contadores errados: %v %v", corpo, err)
	}
}
