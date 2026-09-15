# Sinex Chat

Aplicativo de mensagens (PWA) com chat em tempo real, presença online,
chamadas de voz e vídeo. Front-end estático servido pelo Firebase Hosting,
dados no Firestore e um backend Go que cuida do WebSocket.

---

## Arquitetura

```
Navegador (PWA)
  │
  ├── Firebase Auth ........... identidade (uid). É a fonte da verdade.
  ├── Firestore ............... perfis, conversas, mensagens, seguidores
  ├── Firebase Storage ........ avatares, áudios e imagens do chat
  │
  └── Backend Go (WebSocket) .. presença online/offline, "digitando",
                                notificação de mensagem, sinalização WebRTC
```

O backend **não** guarda mensagens: elas vivem no Firestore. O WebSocket serve
para o que precisa ser instantâneo e efêmero.

### Quem autoriza o quê

Como o navegador fala direto com o Firestore, **as regras em
`firestore.rules` e `storage.rules` são a única barreira real**. O JavaScript
esconde botões por conveniência visual; ele não protege nada sozinho.

- Toda autorização se apoia no `uid` do token do Firebase.
- O documento em `usuarios/{username}` guarda o campo `uid` que liga o perfil
  à conta de autenticação.
- O backend Go verifica o ID token com o Admin SDK e ignora qualquer
  identidade que o cliente afirme ter.

---

## Modelo de dados (Firestore)

| Coleção | Documento | Observações |
|---|---|---|
| `usuarios/{username}` | perfil | `uid` liga ao Firebase Auth; `status` (`ativo`/`suspenso`/`banido`) só admin altera |
| `chats/{chatId}` | conversa | `chatId` = os dois usernames em ordem alfabética unidos por `_`; `uids` é o que as regras conferem |
| `chats/{chatId}/mensagens/{id}` | mensagem | uma por documento, `timestamp` do servidor |
| `seguidores/{seguidor}_{seguindo}` | aresta | criada e removida só por quem segue |

Índice composto necessário (já em `firestore.indexes.json`):
`chats` → `uids` (array-contains) + `timestamp` (desc).

---

## Rodando localmente

### Front-end

Qualquer servidor estático serve:

```bash
python -m http.server 5500
```

Abra <http://localhost:5500>. Note que o CSP é entregue como **header HTTP**
pelo Firebase Hosting (`firebase.json`), então num servidor estático simples
ele não estará ativo.

### Backend

Precisa de uma service account do projeto Firebase:

```bash
cp .env.example .env   # preencha FIREBASE_SERVICE_ACCOUNT_JSON
go run .
```

O servidor **se recusa a subir** sem credenciais válidas — sem elas não há
como verificar tokens, e subir assim significaria aceitar qualquer conexão.

Testes:

```bash
go test ./...
```

---

## Deploy

### Front-end, regras e índices

```bash
firebase deploy --only hosting,firestore,storage
```

Publicar as regras é obrigatório. Sem elas o banco fica aberto.

### Backend (Render)

Variáveis de ambiente:

| Variável | Para quê |
|---|---|
| `PORT` | definida automaticamente pelo Render |
| `FIREBASE_PROJECT_ID` | padrão `chat-parameuamor` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | JSON da service account, em uma linha |
| `ALLOWED_ORIGINS` | origens extras para o WebSocket, separadas por vírgula |

### Publicando uma versão nova do PWA

Suba `VERSAO` em `sw.js`. Sem isso o Service Worker continua servindo os
arquivos em cache e os usuários não veem a atualização.

---

## Administração

A permissão de admin é uma *custom claim* no token, verificada pelas regras
do Firestore:

```bash
go run ./cmd/setadmin -email pessoa@exemplo.com
go run ./cmd/setadmin -email pessoa@exemplo.com -revogar
```

A pessoa precisa sair e entrar de novo para o token novo valer.

---

## Migração de contas antigas

Contas criadas antes desta versão não têm o campo `uid` no perfil. O backend
grava esse campo sozinho na primeira vez que a pessoa conecta (localizando o
perfil pelo e-mail do token).

Enquanto uma conta não tiver `uid`, não é possível **iniciar uma conversa
nova** com ela — as regras não teriam como autorizar o acesso. Basta a pessoa
abrir o app uma vez.

As mensagens antigas ficavam num array dentro de `chats/{id}`. Este código lê
e escreve a subcoleção `mensagens`; conversas antigas aparecem vazias até
serem migradas. Se isso importar, escreva um script que percorra os
documentos de `chats` e mova cada item do array para a subcoleção.

---

## Estrutura

```
core.js ............ sessão, sanitização, avisos, formatação de tempo
tema.js ............ aplica o tema antes da primeira pintura
radar.js ........... WebSocket, presença, chamadas recebidas, notificações
mensagens.js ....... leitura e escrita das conversas
firebase.js ........ inicialização do SDK

<página>.js ........ um módulo por tela (login, cadastro, chat, inbox, ...)

main.go ............ HTTP, handshake e autenticação do WebSocket
hub.go ............. roteamento de mensagens e presença
client.go .......... pumps de leitura/escrita e limite de taxa
identity.go ........ verificação de token e persistência do lastSeen
cmd/setadmin ....... concede/revoga permissão de admin
```

---

## Convenções

- Nada de `onclick` no HTML e nada de `<script>` inline: é isso que permite ao
  CSP recusar `'unsafe-inline'` em `script-src`.
- Conteúdo vindo do banco entra no DOM por `textContent` ou `createElement`,
  nunca por `innerHTML`.
- Timestamps são do servidor (`serverTimestamp()`), não do relógio do
  aparelho.
