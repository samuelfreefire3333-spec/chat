// Comando setadmin concede ou revoga a permissão de administrador de uma conta.
//
// A permissão vira uma custom claim no token do Firebase, que as regras do
// Firestore conseguem verificar no servidor. É isso que torna o painel admin
// de verdade — a checagem no navegador é apenas para esconder o botão.
//
// Uso:
//
//	go run ./cmd/setadmin -email pessoa@exemplo.com
//	go run ./cmd/setadmin -email pessoa@exemplo.com -revogar
//
// Requer credenciais de service account em FIREBASE_SERVICE_ACCOUNT_JSON ou
// GOOGLE_APPLICATION_CREDENTIALS.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	firebase "firebase.google.com/go/v4"
	"google.golang.org/api/option"
)

func main() {
	email := flag.String("email", "", "e-mail da conta")
	revogar := flag.Bool("revogar", false, "remove a permissão em vez de conceder")
	projeto := flag.String("projeto", "chat-parameuamor", "ID do projeto Firebase")
	flag.Parse()

	if strings.TrimSpace(*email) == "" {
		flag.Usage()
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var opts []option.ClientOption
	if json := os.Getenv("FIREBASE_SERVICE_ACCOUNT_JSON"); strings.TrimSpace(json) != "" {
		opts = append(opts, option.WithCredentialsJSON([]byte(json)))
	}

	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: *projeto}, opts...)
	if err != nil {
		log.Fatalf("falha ao inicializar o Firebase: %v", err)
	}

	client, err := app.Auth(ctx)
	if err != nil {
		log.Fatalf("falha ao abrir o cliente de auth: %v", err)
	}

	user, err := client.GetUserByEmail(ctx, *email)
	if err != nil {
		log.Fatalf("usuário não encontrado: %v", err)
	}

	claims := map[string]any{}
	for k, v := range user.CustomClaims {
		claims[k] = v
	}

	if *revogar {
		delete(claims, "admin")
	} else {
		claims["admin"] = true
	}

	if err := client.SetCustomUserClaims(ctx, user.UID, claims); err != nil {
		log.Fatalf("falha ao gravar a permissão: %v", err)
	}

	acao := "concedida a"
	if *revogar {
		acao = "revogada de"
	}
	fmt.Printf("Permissão de admin %s %s (uid %s).\n", acao, *email, user.UID)
	fmt.Println("A pessoa precisa sair e entrar de novo para o token novo valer.")
}
