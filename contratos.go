package main

import (
	"context"
	"errors"
)

// Contratos entre o servidor HTTP/WebSocket e o Firebase. identity.go é a
// implementação de produção; os testes usam dublês — assim toda a lógica de
// autenticação, autorização e limites é testável sem rede.

// Identidade é o resultado de um token verificado de uma conta com perfil.
type Identidade struct {
	Username string
	UID      string
	Admin    bool
}

// TokenVerificado é o mínimo que os endpoints HTTP precisam.
type TokenVerificado struct {
	UID   string
	Admin bool
}

var (
	// ErrTokenInvalido cobre token malformado, expirado, de outro projeto ou
	// revogado. O cliente recebe só "sessão expirada".
	ErrTokenInvalido = errors.New("token invalido")
	// ErrContaBloqueada: perfil suspenso/banido ou conta desativada no Auth.
	ErrContaBloqueada = errors.New("conta suspensa ou banida")
	// ErrSemIdentidade: token válido, mas sem perfil no app.
	ErrSemIdentidade = errors.New("nenhum perfil encontrado para este uid")
	// ErrNaoAdmin: token válido sem a claim "admin".
	ErrNaoAdmin = errors.New("token nao possui permissao de administrador")
	// ErrUsuarioNaoEncontrado: @ que não existe (operações de admin).
	ErrUsuarioNaoEncontrado = errors.New("usuario nao encontrado")
)

// VerificadorDeTokens confere ID tokens do Firebase Auth.
type VerificadorDeTokens interface {
	// Verificar exige token válido e não revogado, conta ativa e perfil no app
	// (handshake do WebSocket).
	Verificar(ctx context.Context, idToken string) (Identidade, error)
	// VerificarToken exige só token válido e não revogado (endpoints HTTP).
	VerificarToken(ctx context.Context, idToken string) (TokenVerificado, error)
}

// AdministracaoDeContas executa ações privilegiadas com o Admin SDK.
type AdministracaoDeContas interface {
	UIDDoUsername(ctx context.Context, username string) (string, error)
	// DefinirStatus grava o status do perfil e liga/desliga a conta no Auth.
	// Bloquear também revoga os refresh tokens: a pessoa perde o acesso ao
	// Firestore quando o ID token atual expirar (até 1 h) e não entra de novo.
	DefinirStatus(ctx context.Context, username, uid, status string) error
	// RevogarSessoes invalida todos os refresh tokens da conta ("sair de todos
	// os aparelhos").
	RevogarSessoes(ctx context.Context, uid string) error
	// Contadores conta perfis e conversas no servidor. O painel admin usava
	// uma consulta direta a "chats" — o que exigia que as regras deixassem o
	// admin ler todas as conversas (e as prévias das mensagens).
	Contadores(ctx context.Context) (usuarios, conversas int64, err error)
}

var statusDePerfilValidos = map[string]bool{"ativo": true, "suspenso": true, "banido": true}
