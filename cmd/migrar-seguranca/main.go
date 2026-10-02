// Comando migrar-seguranca aplica, nos dados que já existem, as mudanças de
// segurança do app. Rode UMA vez depois de publicar as regras novas (e de novo
// sempre que quiser: todas as etapas podem ser repetidas sem estrago).
//
// Por padrão NÃO grava nada: só mostra o que faria. Para gravar, -aplicar.
//
//	go run ./cmd/migrar-seguranca                      # simulação
//	go run ./cmd/migrar-seguranca -aplicar             # todas as etapas
//	go run ./cmd/migrar-seguranca -aplicar -etapas midia -limite 20
//	go run ./cmd/migrar-seguranca -aplicar -etapas orfaos -apagar-orfaos
//
// Etapas, na ordem:
//
//	uid     perfis antigos sem uid: acha a conta no Firebase Auth pelo e-mail
//	        e grava o uid (o mesmo que o backend faz na primeira conexão).
//	contas  cria contas/{uid} (@ e e-mail, privados) para quem ainda não tem —
//	        é o que faz valer a regra "um perfil por conta" para contas antigas.
//	email   tira o e-mail do perfil PÚBLICO (qualquer pessoa logada lia).
//	foto    troca o avatar hospedado no site de ícones pelo avatar local.
//	midia   move fotos e áudios antigos (imagens/, audios/ — com link público
//	        permanente) para midia/{chatId}/{uid}/{uuid}, privado; atualiza a
//	        mensagem e apaga o original, o que invalida o link antigo.
//	tokens  remove o token de download (link público) dos arquivos em midia/.
//	        O app não usa esses links; pode rodar periodicamente.
//	orfaos  lista (e, com -apagar-orfaos, apaga) arquivos que nada usa:
//	        imagens/ e audios/ sem mensagem, mídia de conversas apagadas e
//	        fotos de perfil substituídas.
//
// Credenciais: FIREBASE_SERVICE_ACCOUNT_JSON (conteúdo do JSON de uma service
// account) ou as Application Default Credentials (gcloud auth
// application-default login). Nada é escrito em disco.
//
// Nunca imprime e-mail inteiro, token nem conteúdo de mensagem.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"cloud.google.com/go/firestore"
	gcs "cloud.google.com/go/storage"
	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	avatarPadrao       = "/assets/avatar-padrao.svg"
	cacheDaMidia       = "private, max-age=86400"
	maximoDeAvisos     = 500
	metadadoDoToken    = "firebaseStorageDownloadTokens"
	etapasPadrao       = "uid,contas,email,foto,midia,tokens,orfaos"
	projetoPadrao      = "chat-parameuamor"
	bucketPadrao       = "chat-parameuamor.firebasestorage.app"
	tempoMaximoPadrao  = 2 * time.Hour
	carenciaDosOrfaos  = 24 * time.Hour
	tiposDeMidiaAntiga = "imagem,audio"
)

var ordemDasEtapas = []string{"uid", "contas", "email", "foto", "midia", "tokens", "orfaos"}

type migrador struct {
	fs  *firestore.Client
	au  *auth.Client
	bkt *gcs.BucketHandle

	bucket          string
	aplicar         bool
	apagarOrfaos    bool
	manterOriginais bool
	limite          int

	contagem  map[string]int
	avisos    int
	uidPorArr map[string]string // @ -> uid (cache da etapa midia)
}

func main() {
	projeto := flag.String("projeto", projetoPadrao, "ID do projeto Firebase")
	bucket := flag.String("bucket", bucketPadrao, "bucket do Storage")
	aplicar := flag.Bool("aplicar", false, "grava as mudanças (sem isto, só simula)")
	etapas := flag.String("etapas", etapasPadrao, "etapas separadas por vírgula: "+etapasPadrao)
	apagarOrfaos := flag.Bool("apagar-orfaos", false, "na etapa orfaos, apaga de fato (exige -aplicar)")
	manterOriginais := flag.Bool("manter-originais", false, "na etapa midia, não apaga o arquivo antigo (o link público continua valendo)")
	limite := flag.Int("limite", 0, "máximo de itens por etapa (0 = sem limite), para testar aos poucos")
	tempoMaximo := flag.Duration("tempo-maximo", tempoMaximoPadrao, "tempo máximo de execução")
	flag.Parse()

	escolhidas := map[string]bool{}
	for _, e := range strings.Split(*etapas, ",") {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if !contem(ordemDasEtapas, e) {
			fmt.Fprintf(os.Stderr, "etapa desconhecida: %q (use: %s)\n", e, etapasPadrao)
			os.Exit(2)
		}
		escolhidas[e] = true
	}
	if *apagarOrfaos && !*aplicar {
		fmt.Fprintln(os.Stderr, "-apagar-orfaos só vale junto com -aplicar")
		os.Exit(2)
	}

	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()
	ctx, cancelar := context.WithTimeout(ctx, *tempoMaximo)
	defer cancelar()

	var opts []option.ClientOption
	if json := strings.TrimSpace(os.Getenv("FIREBASE_SERVICE_ACCOUNT_JSON")); json != "" {
		// Só credencial do tipo service_account (ver identity.go).
		opts = append(opts, option.WithAuthCredentialsJSON(option.ServiceAccount, []byte(json)))
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: *projeto, StorageBucket: *bucket}, opts...)
	falhar("inicializar o Firebase", err)
	au, err := app.Auth(ctx)
	falhar("abrir o Firebase Auth", err)
	fs, err := app.Firestore(ctx)
	falhar("abrir o Firestore", err)
	defer fs.Close()
	st, err := app.Storage(ctx)
	falhar("abrir o Storage", err)
	bkt, err := st.Bucket(*bucket)
	falhar("abrir o bucket", err)

	m := &migrador{
		fs: fs, au: au, bkt: bkt,
		bucket: *bucket, aplicar: *aplicar, apagarOrfaos: *apagarOrfaos,
		manterOriginais: *manterOriginais, limite: *limite,
		contagem: map[string]int{}, uidPorArr: map[string]string{},
	}

	if m.aplicar {
		fmt.Println("MODO: aplicando mudanças.")
	} else {
		fmt.Println("MODO: simulação (nada é gravado). Use -aplicar para gravar.")
	}

	for _, etapa := range ordemDasEtapas {
		if !escolhidas[etapa] {
			continue
		}
		fmt.Printf("\n== etapa %s ==\n", etapa)
		var err error
		switch etapa {
		case "uid":
			err = m.etapaUID(ctx)
		case "contas":
			err = m.etapaContas(ctx)
		case "email":
			err = m.etapaEmail(ctx)
		case "foto":
			err = m.etapaFoto(ctx)
		case "midia":
			err = m.etapaMidia(ctx)
		case "tokens":
			err = m.etapaTokens(ctx)
		case "orfaos":
			err = m.etapaOrfaos(ctx)
		}
		if err != nil {
			m.imprimirResumo()
			fmt.Fprintf(os.Stderr, "\netapa %s interrompida: %v\n", etapa, err)
			os.Exit(1)
		}
	}
	m.imprimirResumo()
}

func falhar(oque string, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "falha ao %s: %v\n", oque, err)
		os.Exit(1)
	}
}

func contem(lista []string, s string) bool {
	for _, x := range lista {
		if x == s {
			return true
		}
	}
	return false
}

func (m *migrador) contar(chave string) { m.contagem[chave]++ }

func (m *migrador) avisar(formato string, args ...any) {
	m.avisos++
	if m.avisos <= maximoDeAvisos {
		fmt.Fprintf(os.Stderr, "  aviso: "+formato+"\n", args...)
	} else if m.avisos == maximoDeAvisos+1 {
		fmt.Fprintln(os.Stderr, "  (mais avisos omitidos — veja as contagens no resumo)")
	}
}

// estourou diz se a etapa já atingiu o -limite.
func (m *migrador) estourou(feitos int) bool { return m.limite > 0 && feitos >= m.limite }

func (m *migrador) imprimirResumo() {
	fmt.Println("\n== resumo ==")
	chaves := make([]string, 0, len(m.contagem))
	for k := range m.contagem {
		chaves = append(chaves, k)
	}
	sort.Strings(chaves)
	for _, k := range chaves {
		fmt.Printf("  %-40s %d\n", k, m.contagem[k])
	}
	fmt.Printf("  %-40s %d\n", "avisos", m.avisos)
	if !m.aplicar {
		fmt.Println("\nNada foi gravado (simulação).")
	}
}

func naoExiste(err error) bool { return status.Code(err) == codes.NotFound }

func texto(d map[string]any, campo string) string {
	s, _ := d[campo].(string)
	return strings.TrimSpace(s)
}

// usernameDoPerfil segue o backend (identity.go): o campo "usuario" ou o ID.
func usernameDoPerfil(doc *firestore.DocumentSnapshot) string {
	if u := texto(doc.Data(), "usuario"); u != "" {
		return strings.ToLower(u)
	}
	return doc.Ref.ID
}

// --------------------------------------------------------------------------
// Etapa uid
// --------------------------------------------------------------------------

var errJaTemDono = errors.New("perfil já tem dono")

func (m *migrador) etapaUID(ctx context.Context) error {
	it := m.fs.Collection("usuarios").Documents(ctx)
	defer it.Stop()
	feitos := 0
	for !m.estourou(feitos) {
		doc, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return err
		}
		d := doc.Data()
		if texto(d, "uid") != "" {
			continue
		}
		email := strings.ToLower(texto(d, "email"))
		if email == "" {
			m.contar("uid: perfil sem uid e sem e-mail")
			m.avisar("perfil %q não tem uid nem e-mail: ligue manualmente ou apague", doc.Ref.ID)
			continue
		}
		usuario, err := m.au.GetUserByEmail(ctx, email)
		if auth.IsUserNotFound(err) {
			m.contar("uid: e-mail sem conta no Auth")
			m.avisar("perfil %q: nenhuma conta com o e-mail %s", doc.Ref.ID, mascararEmail(email))
			continue
		}
		if err != nil {
			return fmt.Errorf("consultar o Auth: %w", err)
		}
		outros, err := m.fs.Collection("usuarios").Where("uid", "==", usuario.UID).Limit(1).Documents(ctx).GetAll()
		if err != nil {
			return err
		}
		if len(outros) > 0 {
			m.contar("uid: conta já tem outro perfil")
			m.avisar("perfil %q: a conta de %s já é dona do perfil %q — não ligado", doc.Ref.ID, mascararEmail(email), outros[0].Ref.ID)
			continue
		}
		feitos++
		m.contar("uid: perfis ligados à conta")
		if !m.aplicar {
			continue
		}
		err = m.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
			atual, err := tx.Get(doc.Ref)
			if err != nil {
				return err
			}
			if texto(atual.Data(), "uid") != "" {
				return errJaTemDono
			}
			return tx.Update(doc.Ref, []firestore.Update{{Path: "uid", Value: usuario.UID}})
		})
		if errors.Is(err, errJaTemDono) {
			m.avisar("perfil %q ganhou dono durante a migração — ignorado", doc.Ref.ID)
			continue
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// --------------------------------------------------------------------------
// Etapa contas
// --------------------------------------------------------------------------

func (m *migrador) etapaContas(ctx context.Context) error {
	it := m.fs.Collection("usuarios").Documents(ctx)
	defer it.Stop()
	perfisDoUID := map[string][]string{}
	feitos := 0
	for !m.estourou(feitos) {
		doc, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return err
		}
		d := doc.Data()
		uid := texto(d, "uid")
		if uid == "" {
			m.contar("contas: perfil ainda sem uid")
			continue
		}
		username := usernameDoPerfil(doc)
		if !usernameValido(username) {
			m.contar("contas: @ fora do formato")
			m.avisar("perfil %q com @ fora do formato — conta não criada", doc.Ref.ID)
			continue
		}
		perfisDoUID[uid] = append(perfisDoUID[uid], username)

		ref := m.fs.Collection("contas").Doc(uid)
		atual, err := ref.Get(ctx)
		if err != nil && !naoExiste(err) {
			return err
		}
		if err == nil && atual.Exists() {
			if u := texto(atual.Data(), "usuario"); u != username {
				m.contar("contas: conta aponta para outro @")
				m.avisar("conta %s aponta para @%s, mas o perfil @%s também é dela", uid, u, username)
			}
			continue
		}

		email := strings.ToLower(texto(d, "email"))
		if email == "" {
			if u, err := m.au.GetUser(ctx, uid); err == nil {
				email = strings.ToLower(strings.TrimSpace(u.Email))
			}
		}
		feitos++
		m.contar("contas: contas criadas")
		if !m.aplicar {
			continue
		}
		dados := map[string]any{"usuario": username, "criadoEm": firestore.ServerTimestamp}
		if email != "" {
			dados["email"] = email
		}
		if _, err := ref.Create(ctx, dados); err != nil && status.Code(err) != codes.AlreadyExists {
			return err
		}
	}
	for uid, nomes := range perfisDoUID {
		if len(nomes) > 1 {
			m.contar("contas: uid com mais de um perfil")
			m.avisar("a conta %s é dona de %d perfis (%s) — decida qual fica", uid, len(nomes), strings.Join(nomes, ", "))
		}
	}
	return nil
}

// --------------------------------------------------------------------------
// Etapa email
// --------------------------------------------------------------------------

func (m *migrador) etapaEmail(ctx context.Context) error {
	it := m.fs.Collection("usuarios").Documents(ctx)
	defer it.Stop()
	feitos := 0
	for !m.estourou(feitos) {
		doc, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return err
		}
		d := doc.Data()
		if _, tem := d["email"]; !tem {
			continue
		}
		uid := texto(d, "uid")
		if uid == "" {
			// Sem uid, o e-mail ainda é o que liga o perfil à conta.
			m.contar("email: mantido (perfil sem uid)")
			continue
		}
		conta, err := m.fs.Collection("contas").Doc(uid).Get(ctx)
		if naoExiste(err) {
			m.contar("email: mantido (sem contas/{uid})")
			continue
		}
		if err != nil {
			return err
		}
		feitos++
		m.contar("email: removidos do perfil público")
		if !m.aplicar {
			continue
		}
		if email := strings.ToLower(texto(d, "email")); email != "" && texto(conta.Data(), "email") == "" {
			if _, err := conta.Ref.Set(ctx, map[string]any{"email": email}, firestore.MergeAll); err != nil {
				return err
			}
		}
		_, err = doc.Ref.Update(ctx, []firestore.Update{{Path: "email", Value: firestore.Delete}}, firestore.LastUpdateTime(doc.UpdateTime))
		if err != nil {
			if status.Code(err) == codes.FailedPrecondition {
				m.avisar("perfil %q mudou durante a migração — rode de novo", doc.Ref.ID)
				continue
			}
			return err
		}
	}
	return nil
}

// --------------------------------------------------------------------------
// Etapa foto
// --------------------------------------------------------------------------

func (m *migrador) etapaFoto(ctx context.Context) error {
	it := m.fs.Collection("usuarios").Documents(ctx)
	defer it.Stop()
	feitos := 0
	for !m.estourou(feitos) {
		doc, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return err
		}
		d := doc.Data()
		foto := texto(d, "foto")
		if foto == "" || foto == avatarPadrao {
			continue
		}
		if !fotoDeTerceiros(foto) {
			if caminho, ok := caminhoDoLink(foto, m.bucket); ok {
				if dono, ok := donoDoAvatar(caminho); ok && dono == texto(d, "uid") {
					continue // foto da própria pessoa no bucket do projeto
				}
			}
			m.contar("foto: fora do padrão (não alterada)")
			m.avisar("perfil %q tem foto fora do padrão — o app mostra o avatar padrão; troque pelo painel se precisar", doc.Ref.ID)
			continue
		}
		feitos++
		m.contar("foto: avatar de terceiros trocado")
		if !m.aplicar {
			continue
		}
		_, err = doc.Ref.Update(ctx, []firestore.Update{{Path: "foto", Value: avatarPadrao}}, firestore.LastUpdateTime(doc.UpdateTime))
		if err != nil {
			if status.Code(err) == codes.FailedPrecondition {
				m.avisar("perfil %q mudou durante a migração — rode de novo", doc.Ref.ID)
				continue
			}
			return err
		}
	}
	return nil
}

// --------------------------------------------------------------------------
// Etapa midia
// --------------------------------------------------------------------------

type referencia struct {
	chatID string
	uid    string
	tipo   string
	msg    *firestore.DocumentSnapshot
}

// uidDoRemetente resolve o uid de mensagens antigas que só têm o @.
func (m *migrador) uidDoRemetente(ctx context.Context, d map[string]any) (string, error) {
	if uid := texto(d, "remetenteUid"); uid != "" {
		return uid, nil
	}
	arroba := strings.ToLower(texto(d, "remetente"))
	if !usernameValido(arroba) {
		return "", nil
	}
	if uid, ok := m.uidPorArr[arroba]; ok {
		return uid, nil
	}
	uid := ""
	perfil, err := m.fs.Collection("usuarios").Doc(arroba).Get(ctx)
	switch {
	case err == nil:
		uid = texto(perfil.Data(), "uid")
	case !naoExiste(err):
		return "", err
	}
	m.uidPorArr[arroba] = uid
	return uid, nil
}

// referenciasAntigas varre as mensagens e junta, por arquivo antigo, quem o
// usa. Referências que não podem ser migradas entram vazias (msg nil): o
// arquivo continua "em uso" e nunca é apagado. avisar=false na etapa orfaos,
// que só precisa do conjunto de caminhos.
func (m *migrador) referenciasAntigas(ctx context.Context, avisar bool) (map[string][]referencia, error) {
	refs := map[string][]referencia{}
	chats := m.fs.Collection("chats").Documents(ctx)
	defer chats.Stop()
	for {
		chat, err := chats.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		msgs := chat.Ref.Collection("mensagens").Where("tipo", "in", strings.Split(tiposDeMidiaAntiga, ",")).Documents(ctx)
		for {
			msg, err := msgs.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				msgs.Stop()
				return nil, err
			}
			d := msg.Data()
			if _, tem := d["midia"]; tem {
				continue // já está no formato novo
			}
			tipo := texto(d, "tipo")
			link := texto(d, "texto")
			caminho, ok := caminhoDoLink(link, m.bucket)
			if !ok {
				if avisar {
					m.contar("midia: link fora do padrão (ignorado)")
					m.avisar("mensagem %s/%s: link de mídia fora do padrão", chat.Ref.ID, msg.Ref.ID)
				}
				continue
			}
			pasta, dono, _, ok := arquivoAntigo(caminho)
			if !ok || (tipo == "imagem") != (pasta == "imagens") {
				if avisar {
					m.contar("midia: caminho inesperado (ignorado)")
					m.avisar("mensagem %s/%s aponta para %q", chat.Ref.ID, msg.Ref.ID, caminho)
				}
				// Continua referenciado: a etapa orfaos não pode apagar.
				refs[caminho] = append(refs[caminho], referencia{})
				continue
			}
			uid, err := m.uidDoRemetente(ctx, d)
			if err != nil {
				msgs.Stop()
				return nil, err
			}
			if uid == "" || uid != dono || !idDeConversaValido(chat.Ref.ID) {
				if avisar {
					m.contar("midia: arquivo de outra conta (ignorado)")
					m.avisar("mensagem %s/%s usa um arquivo que não é de quem enviou", chat.Ref.ID, msg.Ref.ID)
				}
				refs[caminho] = append(refs[caminho], referencia{})
				continue
			}
			refs[caminho] = append(refs[caminho], referencia{chatID: chat.Ref.ID, uid: uid, tipo: tipo, msg: msg})
		}
		msgs.Stop()
	}
	return refs, nil
}

func (m *migrador) etapaMidia(ctx context.Context) error {
	refs, err := m.referenciasAntigas(ctx, true)
	if err != nil {
		return err
	}
	caminhos := make([]string, 0, len(refs))
	for c := range refs {
		caminhos = append(caminhos, c)
	}
	sort.Strings(caminhos)

	feitos := 0
	for _, caminho := range caminhos {
		if m.estourou(feitos) {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		// Grupos de mensagens que podem compartilhar a mesma cópia.
		grupos := map[string][]referencia{}
		var ordem []string
		bloqueado := false
		for _, r := range refs[caminho] {
			if r.msg == nil {
				bloqueado = true // alguma referência não pôde ser migrada
				continue
			}
			k := r.chatID + "|" + r.uid + "|" + r.tipo
			if _, ok := grupos[k]; !ok {
				ordem = append(ordem, k)
			}
			grupos[k] = append(grupos[k], r)
		}
		if len(ordem) == 0 {
			continue
		}

		origem := m.bkt.Object(caminho)
		attrs, err := origem.Attrs(ctx)
		if errors.Is(err, gcs.ErrObjectNotExist) {
			m.contar("midia: arquivo antigo não existe mais")
			m.avisar("%s não existe (a mensagem continua com o link quebrado)", caminho)
			continue
		}
		if err != nil {
			return err
		}
		leitor, err := origem.NewRangeReader(ctx, 0, 64)
		if err != nil {
			return err
		}
		cabeca, err := io.ReadAll(io.LimitReader(leitor, 64))
		leitor.Close()
		if err != nil {
			return err
		}
		tipoReal := detectarTipo(cabeca)

		feitos++
		todasMigradas := !bloqueado
		for _, k := range ordem {
			grupo := grupos[k]
			r0 := grupo[0]
			if !tipoAceito(tipoReal, r0.tipo) {
				todasMigradas = false
				m.contar("midia: formato não suportado (mantido)")
				m.avisar("%s: conteúdo não é %s aceito (%q) — mantido no link antigo", caminho, r0.tipo, attrs.ContentType)
				continue
			}
			if attrs.Size <= 0 || attrs.Size >= limiteDeTamanho(r0.tipo) {
				todasMigradas = false
				m.contar("midia: tamanho fora do limite (mantido)")
				m.avisar("%s: %d bytes — fora do limite", caminho, attrs.Size)
				continue
			}
			novo, err := caminhoNovo(r0.chatID, r0.uid)
			if err != nil {
				todasMigradas = false
				m.avisar("%s: %v", caminho, err)
				continue
			}
			if !m.aplicar {
				m.contar("midia: arquivos a copiar para midia/")
				m.contagem["midia: mensagens a atualizar"] += len(grupo)
				continue
			}
			if !m.copiarPrivado(ctx, origem, novo, tipoReal) {
				todasMigradas = false
				continue
			}
			m.contar("midia: arquivos copiados para midia/")
			atualizadas := 0
			for _, r := range grupo {
				_, err := r.msg.Ref.Update(ctx, []firestore.Update{
					{Path: "midia", Value: map[string]any{"caminho": novo, "mime": tipoReal, "tamanho": attrs.Size}},
					{Path: "texto", Value: firestore.Delete},
				}, firestore.LastUpdateTime(r.msg.UpdateTime))
				if err != nil {
					todasMigradas = false
					m.avisar("mensagem %s/%s não atualizada (%v) — rode de novo", r.chatID, r.msg.Ref.ID, status.Code(err))
					continue
				}
				atualizadas++
			}
			m.contagem["midia: mensagens atualizadas"] += atualizadas
			if atualizadas == 0 {
				// Nenhuma mensagem aponta para a cópia: não deixa lixo.
				_ = m.bkt.Object(novo).Delete(ctx)
			}
		}

		if m.aplicar && todasMigradas && !m.manterOriginais {
			if err := origem.Delete(ctx); err != nil && !errors.Is(err, gcs.ErrObjectNotExist) {
				m.avisar("%s: não foi possível apagar o original (%v)", caminho, err)
				continue
			}
			m.contar("midia: originais apagados (links antigos invalidados)")
		}
	}
	return nil
}

// copiarPrivado copia no próprio Storage (sem baixar), com tipo conferido,
// cache privado e SEM token de download.
func (m *migrador) copiarPrivado(ctx context.Context, origem *gcs.ObjectHandle, destino, tipo string) bool {
	dst := m.bkt.Object(destino).If(gcs.Conditions{DoesNotExist: true})
	copiador := dst.CopierFrom(origem)
	copiador.ContentType = tipo
	copiador.CacheControl = cacheDaMidia
	if _, err := copiador.Run(ctx); err != nil {
		m.avisar("falha ao copiar para %s: %v", destino, err)
		return false
	}
	// Metadata vazio apaga os metadados personalizados — entre eles o token
	// que o Firebase usa para montar links públicos.
	attrs, err := m.bkt.Object(destino).Update(ctx, gcs.ObjectAttrsToUpdate{Metadata: map[string]string{}})
	if err != nil || attrs.Metadata[metadadoDoToken] != "" {
		m.avisar("cópia %s ficou com token de download; rode a etapa tokens", destino)
	}
	return true
}

// --------------------------------------------------------------------------
// Etapa tokens
// --------------------------------------------------------------------------

func (m *migrador) etapaTokens(ctx context.Context) error {
	it := m.bkt.Objects(ctx, &gcs.Query{Prefix: "midia/"})
	feitos := 0
	for !m.estourou(feitos) {
		obj, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return err
		}
		if obj.Metadata[metadadoDoToken] == "" {
			continue
		}
		feitos++
		m.contar("tokens: links públicos removidos")
		if !m.aplicar {
			continue
		}
		_, err = m.bkt.Object(obj.Name).If(gcs.Conditions{MetagenerationMatch: obj.Metageneration}).
			Update(ctx, gcs.ObjectAttrsToUpdate{Metadata: map[string]string{}})
		if err != nil {
			m.avisar("%s: token não removido (%v)", obj.Name, err)
		}
	}
	return nil
}

// --------------------------------------------------------------------------
// Etapa orfaos
// --------------------------------------------------------------------------

func (m *migrador) etapaOrfaos(ctx context.Context) error {
	agora := time.Now()
	apagar := m.aplicar && m.apagarOrfaos

	// 1. imagens/ e audios/ que nenhuma mensagem usa. Nada novo entra ali
	//    (as regras bloqueiam), mas os links antigos continuam públicos.
	refs, err := m.referenciasAntigas(ctx, false)
	if err != nil {
		return err
	}
	for _, prefixo := range []string{"imagens/", "audios/"} {
		n, err := m.varrerOrfaos(ctx, prefixo, apagar, func(obj *gcs.ObjectAttrs) bool {
			_, usado := refs[obj.Name]
			return !usado
		})
		if err != nil {
			return err
		}
		m.contagem["orfaos: "+prefixo+" sem mensagem"] += n
	}

	// 2. midia/{chatId}/... de conversas que não existem mais.
	existe := map[string]bool{}
	n, err := m.varrerOrfaos(ctx, "midia/", apagar, func(obj *gcs.ObjectAttrs) bool {
		if agora.Sub(obj.Created) < carenciaDosOrfaos {
			return false
		}
		partes := strings.Split(obj.Name, "/")
		if len(partes) != 4 {
			return false
		}
		chatID := partes[1]
		if !idDeConversaValido(chatID) {
			return false
		}
		if v, ok := existe[chatID]; ok {
			return !v
		}
		_, err := m.fs.Collection("chats").Doc(chatID).Get(ctx)
		existe[chatID] = !naoExiste(err) // em erro de rede, trata como existente
		return !existe[chatID]
	})
	if err != nil {
		return err
	}
	m.contagem["orfaos: midia/ de conversas apagadas"] += n

	// 3. avatares/ que nenhum perfil usa (fotos trocadas).
	usados := map[string]bool{}
	it := m.fs.Collection("usuarios").Documents(ctx)
	for {
		doc, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			it.Stop()
			return err
		}
		if caminho, ok := caminhoDoLink(texto(doc.Data(), "foto"), m.bucket); ok {
			usados[caminho] = true
		}
	}
	it.Stop()
	n, err = m.varrerOrfaos(ctx, "avatares/", apagar, func(obj *gcs.ObjectAttrs) bool {
		if _, ok := donoDoAvatar(obj.Name); !ok {
			return false
		}
		return !usados[obj.Name] && agora.Sub(obj.Created) >= carenciaDosOrfaos
	})
	if err != nil {
		return err
	}
	m.contagem["orfaos: avatares/ sem perfil"] += n

	if !apagar {
		fmt.Println("  (órfãos só listados; para apagar: -aplicar -apagar-orfaos)")
	}
	return nil
}

func (m *migrador) varrerOrfaos(ctx context.Context, prefixo string, apagar bool, orfao func(*gcs.ObjectAttrs) bool) (int, error) {
	it := m.bkt.Objects(ctx, &gcs.Query{Prefix: prefixo})
	achados := 0
	for !m.estourou(achados) {
		obj, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return achados, err
		}
		if !orfao(obj) {
			continue
		}
		achados++
		if !apagar {
			continue
		}
		err = m.bkt.Object(obj.Name).If(gcs.Conditions{GenerationMatch: obj.Generation}).Delete(ctx)
		if err != nil && !errors.Is(err, gcs.ErrObjectNotExist) {
			m.avisar("%s: não apagado (%v)", obj.Name, err)
		}
	}
	return achados, nil
}
