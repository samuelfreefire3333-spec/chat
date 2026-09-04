package main

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"google.golang.org/api/option"
)

// ErrSemIdentidade indica que o token é válido mas não há perfil correspondente
// na coleção "usuarios" — a conexão deve ser recusada.
var ErrSemIdentidade = errors.New("nenhum perfil encontrado para este uid")

// ErrContaBloqueada indica que o perfil existe mas está suspenso ou banido.
var ErrContaBloqueada = errors.New("conta suspensa ou banida")

// Identidade é o resultado da verificação de um ID token: o username canônico
// do app (que é também o ID do documento em "usuarios") e o uid do Firebase.
type Identidade struct {
	Username string
	UID      string
}

// Identity resolve tokens do Firebase em identidades do app e persiste presença.
// Todos os métodos são seguros para uso concorrente.
type Identity struct {
	authClient *auth.Client
	fsClient   *firestore.Client

	mu    sync.RWMutex
	cache map[string]cacheEntry // uid -> username
}

type cacheEntry struct {
	username string
	expiraEm time.Time
}

const cacheTTL = 30 * time.Minute

// NovaIdentity inicializa o Firebase Admin SDK. As credenciais vêm de
// FIREBASE_SERVICE_ACCOUNT_JSON (conteúdo do JSON) ou, se vazio, das
// Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS).
func NovaIdentity(ctx context.Context, projectID, serviceAccountJSON string) (*Identity, error) {
	cfg := &firebase.Config{ProjectID: projectID}

	var opts []option.ClientOption
	if strings.TrimSpace(serviceAccountJSON) != "" {
		opts = append(opts, option.WithCredentialsJSON([]byte(serviceAccountJSON)))
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
		authClient: authClient,
		fsClient:   fsClient,
		cache:      make(map[string]cacheEntry),
	}, nil
}

func (i *Identity) Close() {
	if i.fsClient != nil {
		i.fsClient.Close()
	}
}

// Verificar checa a assinatura e a validade do ID token e devolve a identidade
// do app. Um token expirado, revogado ou de outro projeto é recusado aqui.
func (i *Identity) Verificar(ctx context.Context, idToken string) (Identidade, error) {
	tok, err := i.authClient.VerifyIDTokenAndCheckRevoked(ctx, idToken)
	if err != nil {
		return Identidade{}, err
	}

	username, err := i.usernameDoUID(ctx, tok)
	if err != nil {
		return Identidade{}, err
	}

	return Identidade{Username: username, UID: tok.UID}, nil
}

// usernameDoUID mapeia uid -> username. Consulta "usuarios" por uid; se o perfil
// ainda não tiver o campo (contas criadas antes desta versão), cai para o e-mail
// do token e grava o uid no documento para as próximas conexões.
func (i *Identity) usernameDoUID(ctx context.Context, tok *auth.Token) (string, error) {
	i.mu.RLock()
	if e, ok := i.cache[tok.UID]; ok && time.Now().Before(e.expiraEm) {
		i.mu.RUnlock()
		return e.username, nil
	}
	i.mu.RUnlock()

	docs, err := i.fsClient.Collection("usuarios").
		Where("uid", "==", tok.UID).Limit(1).Documents(ctx).GetAll()
	if err != nil {
		return "", err
	}

	var doc *firestore.DocumentSnapshot
	if len(docs) > 0 {
		doc = docs[0]
	} else {
		// Migração: conta antiga, sem uid gravado. Localiza pelo e-mail do token.
		email, _ := tok.Claims["email"].(string)
		if email == "" {
			return "", ErrSemIdentidade
		}
		porEmail, err := i.fsClient.Collection("usuarios").
			Where("email", "==", strings.ToLower(strings.TrimSpace(email))).Limit(1).Documents(ctx).GetAll()
		if err != nil {
			return "", err
		}
		if len(porEmail) == 0 {
			return "", ErrSemIdentidade
		}
		doc = porEmail[0]

		// Backfill do uid, em background — falha aqui não impede o login.
		go func(ref *firestore.DocumentRef, uid string) {
			c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, err := ref.Update(c, []firestore.Update{{Path: "uid", Value: uid}}); err != nil {
				log.Printf("[identity] falha ao gravar uid em %s: %v", ref.ID, err)
			}
		}(doc.Ref, tok.UID)
	}

	if status, _ := doc.Data()["status"].(string); status == "banido" || status == "suspenso" {
		return "", ErrContaBloqueada
	}

	username := doc.Ref.ID
	if u, ok := doc.Data()["usuario"].(string); ok && u != "" {
		username = strings.ToLower(strings.TrimSpace(u))
	}

	i.mu.Lock()
	i.cache[tok.UID] = cacheEntry{username: username, expiraEm: time.Now().Add(cacheTTL)}
	i.mu.Unlock()

	return username, nil
}

// RegistrarSaida grava o lastSeen no Firestore quando a última aba do usuário
// desconecta. É isto que substitui a escrita de 1 minuto em 1 minuto que o
// cliente fazia — agora só há uma escrita por sessão encerrada.
func (i *Identity) RegistrarSaida(username string) {
	if i == nil || i.fsClient == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		_, err := i.fsClient.Collection("usuarios").Doc(username).Update(ctx, []firestore.Update{
			{Path: "lastSeen", Value: time.Now().UnixMilli()},
		})
		if err != nil {
			log.Printf("[presenca] falha ao gravar lastSeen de %s: %v", username, err)
		}
	}()
}

// UltimoAcesso lê o lastSeen persistido para responder a um status_check de um
// usuário offline, evitando uma leitura extra no cliente.
func (i *Identity) UltimoAcesso(username string) int64 {
	if i == nil || i.fsClient == nil {
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	doc, err := i.fsClient.Collection("usuarios").Doc(username).Get(ctx)
	if err != nil {
		return 0
	}
	switch v := doc.Data()["lastSeen"].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	}
	return 0
}
