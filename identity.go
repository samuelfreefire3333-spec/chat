package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"google.golang.org/api/option"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Identity é a implementação de produção dos contratos (contratos.go) sobre o
// Firebase Admin SDK. O Admin SDK ignora as regras do Firestore — por isso
// este arquivo só faz o que as regras não conseguem: verificar tokens, ler
// participantes, gravar lastSeen/uid/status e administrar contas.
type Identity struct {
	authClient *auth.Client
	fsClient   *firestore.Client

	mu    sync.RWMutex
	cache map[string]cacheEntry // uid -> username

	muVisto sync.Mutex
	visto   map[string]cacheVisto // username -> lastSeen

	muContas         sync.Mutex
	contasGarantidas map[string]bool
}

type cacheEntry struct {
	username string
	expiraEm time.Time
}

type cacheVisto struct {
	valor  int64
	expira time.Time
}

const (
	cacheTTL      = 30 * time.Minute
	cacheVistoTTL = time.Minute
)

// NovaIdentity inicializa o Firebase Admin SDK. As credenciais vêm de
// FIREBASE_SERVICE_ACCOUNT_JSON (conteúdo do JSON, nunca um arquivo no
// repositório) ou das Application Default Credentials.
func NovaIdentity(ctx context.Context, projectID, serviceAccountJSON string) (*Identity, error) {
	cfg := &firebase.Config{ProjectID: projectID}

	var opts []option.ClientOption
	if strings.TrimSpace(serviceAccountJSON) != "" {
		// Só aceita JSON do tipo "service_account". WithCredentialsJSON (a
		// forma antiga, marcada como obsoleta pelo Google por segurança)
		// aceitava qualquer tipo de credencial — inclusive configurações
		// "external_account", que mandam o SDK ler arquivos locais ou chamar
		// URLs arbitrárias para obter o token.
		opts = append(opts, option.WithAuthCredentialsJSON(option.ServiceAccount, []byte(serviceAccountJSON)))
	}

	app, err := firebase.NewApp(ctx, cfg, opts...)
	if err != nil {
		return nil, err
	}
	authClient, err := app.Auth(ctx)
	if err != nil {
		return nil, err
	}
	fsClient, err := app.Firestore(ctx)
	if err != nil {
		return nil, err
	}
	return &Identity{
		authClient:       authClient,
		fsClient:         fsClient,
		cache:            make(map[string]cacheEntry),
		visto:            make(map[string]cacheVisto),
		contasGarantidas: make(map[string]bool),
	}, nil
}

func (i *Identity) Close() {
	if i.fsClient != nil {
		i.fsClient.Close()
	}
}

// ==========================================================================
// Tokens
// ==========================================================================

// verificarNoAuth confere assinatura, validade, projeto, revogação e conta
// desativada. Os detalhes do erro ficam no erro embrulhado (para o log);
// quem chama só enxerga ErrTokenInvalido/ErrContaBloqueada.
func (i *Identity) verificarNoAuth(ctx context.Context, idToken string) (*auth.Token, error) {
	tok, err := i.authClient.VerifyIDTokenAndCheckRevoked(ctx, idToken)
	if err == nil {
		return tok, nil
	}
	switch {
	case auth.IsUserDisabled(err):
		return nil, ErrContaBloqueada
	case auth.IsIDTokenRevoked(err), auth.IsIDTokenExpired(err), auth.IsIDTokenInvalid(err):
		return nil, fmt.Errorf("%w: %s", ErrTokenInvalido, resumoDeErro(err))
	case auth.IsCertificateFetchFailed(err):
		return nil, err // indisponibilidade, não culpa do cliente
	}
	return nil, fmt.Errorf("%w: %s", ErrTokenInvalido, resumoDeErro(err))
}

// Verificar é o handshake do WebSocket: token válido E perfil ativo no app.
func (i *Identity) Verificar(ctx context.Context, idToken string) (Identidade, error) {
	tok, err := i.verificarNoAuth(ctx, idToken)
	if err != nil {
		return Identidade{}, err
	}
	username, err := i.usernameDoUID(ctx, tok)
	if err != nil {
		return Identidade{}, err
	}
	admin, _ := tok.Claims["admin"].(bool)
	return Identidade{Username: username, UID: tok.UID, Admin: admin}, nil
}

// VerificarToken serve aos endpoints HTTP.
func (i *Identity) VerificarToken(ctx context.Context, idToken string) (TokenVerificado, error) {
	tok, err := i.verificarNoAuth(ctx, idToken)
	if err != nil {
		return TokenVerificado{}, err
	}
	admin, _ := tok.Claims["admin"].(bool)
	return TokenVerificado{UID: tok.UID, Admin: admin}, nil
}

func resumoDeErro(err error) string {
	s := err.Error()
	if len(s) > 160 {
		s = s[:160]
	}
	return s
}

// usernameDoUID mapeia uid -> @. Consulta "usuarios" por uid; se o perfil
// ainda não tiver o campo (contas anteriores à migração), cai para o e-mail
// do token — mas só aceita um perfil SEM dono, e grava o uid numa transação
// que confere de novo que ele continua sem dono. A versão anterior
// sobrescrevia o uid de qualquer perfil com aquele e-mail: uma conta nova com
// o e-mail antigo de alguém assumia o perfil dessa pessoa.
func (i *Identity) usernameDoUID(ctx context.Context, tok *auth.Token) (string, error) {
	i.mu.RLock()
	emCache, achou := i.cache[tok.UID]
	i.mu.RUnlock()

	if achou && time.Now().Before(emCache.expiraEm) {
		// O @ não muda, mas o status pode ter mudado há um segundo: uma
		// leitura pontual por conexão mantém o banimento imediato.
		doc, err := i.fsClient.Collection("usuarios").Doc(emCache.username).Get(ctx)
		if err != nil {
			if status.Code(err) == codes.NotFound {
				i.esquecer(tok.UID)
				return "", ErrSemIdentidade
			}
			return "", err
		}
		if uid, _ := doc.Data()["uid"].(string); uid != tok.UID {
			i.esquecer(tok.UID)
			return "", ErrSemIdentidade
		}
		if contaBloqueada(doc.Data()) {
			i.esquecer(tok.UID)
			return "", ErrContaBloqueada
		}
		i.completarStatus(doc)
		return emCache.username, nil
	}

	docs, err := i.fsClient.Collection("usuarios").
		Where("uid", "==", tok.UID).Limit(1).Documents(ctx).GetAll()
	if err != nil {
		return "", err
	}

	var doc *firestore.DocumentSnapshot
	if len(docs) > 0 {
		doc = docs[0]
	} else {
		doc, err = i.migrarPorEmail(ctx, tok)
		if err != nil {
			return "", err
		}
	}

	if contaBloqueada(doc.Data()) {
		return "", ErrContaBloqueada
	}
	i.completarStatus(doc)

	username := doc.Ref.ID
	if u, ok := doc.Data()["usuario"].(string); ok && u != "" {
		username = strings.ToLower(strings.TrimSpace(u))
	}
	if !usernameValido(username) {
		// Um @ fora do formato não pode virar chave de roteamento.
		slog.Warn("perfil com @ fora do formato", "doc", doc.Ref.ID)
		return "", ErrSemIdentidade
	}

	email, _ := tok.Claims["email"].(string)
	i.garantirConta(tok.UID, username, email)

	i.mu.Lock()
	if len(i.cache) > 10000 {
		i.cache = make(map[string]cacheEntry)
	}
	i.cache[tok.UID] = cacheEntry{username: username, expiraEm: time.Now().Add(cacheTTL)}
	i.mu.Unlock()

	return username, nil
}

// migrarPorEmail liga uma conta antiga (perfil sem uid) ao uid do token.
func (i *Identity) migrarPorEmail(ctx context.Context, tok *auth.Token) (*firestore.DocumentSnapshot, error) {
	email, _ := tok.Claims["email"].(string)
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return nil, ErrSemIdentidade
	}
	porEmail, err := i.fsClient.Collection("usuarios").
		Where("email", "==", email).Limit(5).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}

	var candidato *firestore.DocumentSnapshot
	for _, d := range porEmail {
		if uid, _ := d.Data()["uid"].(string); uid == "" {
			candidato = d
			break
		}
	}
	if candidato == nil {
		// Perfis com este e-mail já têm dono (outra conta): não é esta.
		return nil, ErrSemIdentidade
	}

	err = i.fsClient.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		atual, err := tx.Get(candidato.Ref)
		if err != nil {
			return err
		}
		if uid, _ := atual.Data()["uid"].(string); uid != "" {
			return ErrSemIdentidade
		}
		return tx.Update(candidato.Ref, []firestore.Update{{Path: "uid", Value: tok.UID}})
	})
	if err != nil {
		if errors.Is(err, ErrSemIdentidade) {
			return nil, ErrSemIdentidade
		}
		return nil, err
	}
	slog.Info("perfil antigo ligado ao uid", "doc", candidato.Ref.ID, "uid", tok.UID)
	return i.fsClient.Collection("usuarios").Doc(candidato.Ref.ID).Get(ctx)
}

// garantirConta cria contas/{uid} (dados privados: @ e e-mail) para perfis
// criados antes dessa coleção existir. Sem ele, a regra "um perfil por conta"
// não teria como valer para contas antigas.
func (i *Identity) garantirConta(uid, username, email string) {
	i.muContas.Lock()
	if i.contasGarantidas[uid] {
		i.muContas.Unlock()
		return
	}
	if len(i.contasGarantidas) > 100000 {
		i.contasGarantidas = make(map[string]bool)
	}
	i.contasGarantidas[uid] = true
	i.muContas.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		dados := map[string]interface{}{"usuario": username, "criadoEm": firestore.ServerTimestamp}
		if email != "" {
			dados["email"] = strings.ToLower(strings.TrimSpace(email))
		}
		_, err := i.fsClient.Collection("contas").Doc(uid).Create(ctx, dados)
		if err != nil && status.Code(err) != codes.AlreadyExists {
			slog.Warn("falha ao criar contas/{uid}", "uid", uid, "erro", err)
			i.muContas.Lock()
			delete(i.contasGarantidas, uid)
			i.muContas.Unlock()
		}
	}()
}

// completarStatus grava status "ativo" em perfis que ainda não têm o campo,
// com pré-condição de última alteração (não desfaz um banimento concorrente).
func (i *Identity) completarStatus(doc *firestore.DocumentSnapshot) {
	if doc == nil || !doc.Exists() {
		return
	}
	if _, tem := doc.Data()["status"]; tem {
		return
	}
	go func(ref *firestore.DocumentRef, versao time.Time) {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := ref.Update(c, []firestore.Update{{Path: "status", Value: "ativo"}}, firestore.LastUpdateTime(versao))
		if err != nil {
			slog.Warn("falha ao completar o status", "doc", ref.ID, "erro", err)
		}
	}(doc.Ref, doc.UpdateTime)
}

// contaBloqueada diz se o perfil está suspenso ou banido.
func contaBloqueada(dados map[string]interface{}) bool {
	s, _ := dados["status"].(string)
	return s == "banido" || s == "suspenso"
}

func (i *Identity) esquecer(uid string) {
	i.mu.Lock()
	delete(i.cache, uid)
	i.mu.Unlock()
}

// ==========================================================================
// Conversas (autorização do WebSocket)
// ==========================================================================

// Conversa lê os participantes de chats/{id}.
func (i *Identity) Conversa(ctx context.Context, chatID string) (InfoConversa, error) {
	if !idDeConversaValido(chatID) {
		return InfoConversa{}, ErrConversaInvalida
	}
	doc, err := i.fsClient.Collection("chats").Doc(chatID).Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return InfoConversa{Existe: false}, nil
		}
		return InfoConversa{}, err
	}
	dados := doc.Data()
	info := InfoConversa{Existe: true, Tipo: "direto", UIDs: make(map[string]bool)}
	if t, _ := dados["tipo"].(string); t == "grupo" {
		info.Tipo = "grupo"
	}
	if lista, ok := dados["uids"].([]interface{}); ok {
		for _, v := range lista {
			if uid, ok := v.(string); ok && uid != "" {
				info.UIDs[uid] = true
			}
		}
	}
	return info, nil
}

// ==========================================================================
// Presença
// ==========================================================================

// RegistrarSaida grava o lastSeen quando a última aba cai de vez.
func (i *Identity) RegistrarSaida(username string, quando int64) {
	if i == nil || i.fsClient == nil || !usernameValido(username) {
		return
	}
	i.muVisto.Lock()
	i.visto[username] = cacheVisto{valor: quando, expira: time.Now().Add(cacheVistoTTL)}
	i.muVisto.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := i.fsClient.Collection("usuarios").Doc(username).Update(ctx, []firestore.Update{
			{Path: "lastSeen", Value: quando},
		})
		if err != nil {
			slog.Warn("falha ao gravar lastSeen", "usuario", username, "erro", err)
		}
	}()
}

// RegistrarSaidas grava o lastSeen de vários usuários (desligamento).
func (i *Identity) RegistrarSaidas(ctx context.Context, saidas map[string]int64) error {
	if i == nil || i.fsClient == nil || len(saidas) == 0 {
		return nil
	}
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		primeiro error
		semaforo = make(chan struct{}, 16)
	)
	for nome, quando := range saidas {
		if !usernameValido(nome) {
			continue
		}
		wg.Add(1)
		semaforo <- struct{}{}
		go func(nome string, quando int64) {
			defer wg.Done()
			defer func() { <-semaforo }()
			_, err := i.fsClient.Collection("usuarios").Doc(nome).Update(ctx, []firestore.Update{
				{Path: "lastSeen", Value: quando},
			})
			if err != nil {
				mu.Lock()
				if primeiro == nil {
					primeiro = err
				}
				mu.Unlock()
			}
		}(nome, quando)
	}
	wg.Wait()
	return primeiro
}

// UltimosAcessos lê o lastSeen de vários @ numa leitura em lote, com cache
// curto. @ fora do formato nem chega ao Firestore.
func (i *Identity) UltimosAcessos(ctx context.Context, usernames []string) map[string]int64 {
	saida := make(map[string]int64, len(usernames))
	if i == nil || i.fsClient == nil {
		return saida
	}
	agora := time.Now()
	var faltando []string
	i.muVisto.Lock()
	for _, u := range usernames {
		if !usernameValido(u) {
			continue
		}
		if v, ok := i.visto[u]; ok && agora.Before(v.expira) {
			saida[u] = v.valor
			continue
		}
		faltando = append(faltando, u)
	}
	i.muVisto.Unlock()

	for inicio := 0; inicio < len(faltando); inicio += 100 {
		fim := inicio + 100
		if fim > len(faltando) {
			fim = len(faltando)
		}
		refs := make([]*firestore.DocumentRef, 0, fim-inicio)
		for _, u := range faltando[inicio:fim] {
			refs = append(refs, i.fsClient.Collection("usuarios").Doc(u))
		}
		docs, err := i.fsClient.GetAll(ctx, refs)
		if err != nil {
			slog.Warn("falha ao ler lastSeen em lote", "erro", err)
			break
		}
		i.muVisto.Lock()
		if len(i.visto) > 50000 {
			i.visto = make(map[string]cacheVisto)
		}
		for idx, doc := range docs {
			u := faltando[inicio+idx]
			var valor int64
			if doc != nil && doc.Exists() {
				switch v := doc.Data()["lastSeen"].(type) {
				case int64:
					valor = v
				case float64:
					valor = int64(v)
				case time.Time:
					valor = v.UnixMilli()
				}
			}
			saida[u] = valor
			i.visto[u] = cacheVisto{valor: valor, expira: agora.Add(cacheVistoTTL)}
		}
		i.muVisto.Unlock()
	}
	return saida
}

// ==========================================================================
// Administração
// ==========================================================================

func (i *Identity) UIDDoUsername(ctx context.Context, username string) (string, error) {
	if !usernameValido(username) {
		return "", ErrUsuarioNaoEncontrado
	}
	doc, err := i.fsClient.Collection("usuarios").Doc(username).Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return "", ErrUsuarioNaoEncontrado
		}
		return "", err
	}
	uid, _ := doc.Data()["uid"].(string)
	if uid == "" {
		return "", ErrUsuarioNaoEncontrado
	}
	return uid, nil
}

// DefinirStatus aplica o status no perfil e na conta do Auth. A ordem importa:
// primeiro o perfil (vale na hora para o handshake do WebSocket), depois o
// Auth (corta novos tokens), por fim a revogação (corta os refresh tokens).
func (i *Identity) DefinirStatus(ctx context.Context, username, uid, novo string) error {
	if !statusDePerfilValidos[novo] {
		return fmt.Errorf("status invalido: %q", novo)
	}
	if _, err := i.fsClient.Collection("usuarios").Doc(username).Update(ctx, []firestore.Update{
		{Path: "status", Value: novo},
	}); err != nil {
		return err
	}
	bloquear := novo != "ativo"
	if _, err := i.authClient.UpdateUser(ctx, uid, (&auth.UserToUpdate{}).Disabled(bloquear)); err != nil {
		return err
	}
	if bloquear {
		if err := i.authClient.RevokeRefreshTokens(ctx, uid); err != nil {
			return err
		}
	}
	i.esquecer(uid)
	return nil
}

// RevogarSessoes invalida todos os refresh tokens da conta.
func (i *Identity) RevogarSessoes(ctx context.Context, uid string) error {
	if err := i.authClient.RevokeRefreshTokens(ctx, uid); err != nil {
		return err
	}
	i.esquecer(uid)
	return nil
}

// Contadores usa a agregação do Firestore: conta no servidor, sem ler os
// documentos.
func (i *Identity) Contadores(ctx context.Context) (int64, int64, error) {
	contar := func(colecao string) (int64, error) {
		res, err := i.fsClient.Collection(colecao).NewAggregationQuery().WithCount("total").Get(ctx)
		if err != nil {
			return 0, err
		}
		total, _ := res.Data()["total"].(int64)
		return total, nil
	}
	usuarios, err := contar("usuarios")
	if err != nil {
		return 0, 0, err
	}
	conversas, err := contar("chats")
	if err != nil {
		return 0, 0, err
	}
	return usuarios, conversas, nil
}
