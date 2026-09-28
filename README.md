# Sinex Chat

Aplicativo de mensagens (PWA) com chat em tempo real, presença online,
confirmações de entrega e leitura, grupos e chamadas de voz e vídeo.
Front-end estático no Netlify (<https://sinexchat.netlify.app>), dados no
Firestore e um backend Go no Render que cuida do WebSocket.

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
                                wss://sinex-backend-go.onrender.com/ws
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
| `usuarios/{username}` | perfil | `uid` liga ao Firebase Auth; `status` (`ativo`/`suspenso`/`banido`) só admin altera; `lastSeen` (ms) é gravado pelo backend |
| `chats/{chatId}` | conversa | direta: `chatId` = os dois usernames em ordem alfabética unidos por `_`; grupo: ID aleatório. `uids` é o que as regras conferem. Resumo: `ultimaMensagem`, `ultimoRemetente`, `ultimoTipo`, `timestamp`. Confirmações: `entregas.{uid}` e `leituras.{uid}` (Timestamp da última mensagem entregue/lida por aquela pessoa) |
| `chats/{chatId}/mensagens/{id}` | mensagem | uma por documento, `timestamp` do servidor; `reacoes.{uid}` = emoji |
| `seguidores/{seguidor}_{seguindo}` | aresta | criada e removida só por quem segue |

A mensagem e o resumo da conversa são gravados no **mesmo lote**
(`writeBatch`), então os dois têm exatamente o mesmo `timestamp` — é isso que
permite comparar "até onde a pessoa leu" com cada mensagem.

Estados da confirmação (conversa direta): **enviada** (✓, o servidor aceitou),
**entregue** (✓✓, algum aparelho da pessoa recebeu) e **vista** (✓✓ colorido,
a conversa esteve aberta e visível). No grupo, "vista" só quando todos leram;
antes disso aparece "Vista por N".

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
pelo Netlify (`netlify.toml`; o `firebase.json` tem o equivalente para o
Firebase Hosting), então num servidor estático simples ele não estará ativo.

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

### Front-end

O Netlify publica sozinho a cada commit na branch `main` do GitHub. Só vão
para o ar os `.html`, `.css`, `.js`, o `manifest.json` e a pasta `assets/`
(ver `[build]` no `netlify.toml`).

### Regras e índices do Firestore

```bash
firebase deploy --only firestore,storage
```

Ou cole o conteúdo de `firestore.rules` em *Firebase Console → Firestore →
Regras* e publique. Publicar as regras é obrigatório: sem elas o banco fica
aberto. Antes de publicar, dá para testar cada operação no *Simulador de
regras* da mesma tela.

### Backend (Render)

Variáveis de ambiente:

| Variável | Para quê |
|---|---|
| `PORT` | definida automaticamente pelo Render |
| `FIREBASE_PROJECT_ID` | padrão `chat-parameuamor` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | JSON da service account, em uma linha |
| `ALLOWED_ORIGINS` | origens extras para o WebSocket, separadas por vírgula |
| `PRESENCE_GRACE_MS` | folga antes de anunciar "offline" (padrão 6000). Evita piscar offline/online ao trocar de tela |

O servidor encerra com calma no `SIGTERM` (deploy/reinício do Render): grava o
`lastSeen` de quem estava online e fecha as conexões; os clientes reconectam
sozinhos.

### Publicando uma versão nova do PWA

Suba `VERSAO` em `sw.js`. Sem isso o Service Worker continua servindo os
arquivos em cache e os usuários não veem a atualização. As páginas abertas
recarregam sozinhas quando a versão nova assume — menos a janela da chamada
(`data-sem-recarga-automatica`), que nunca recarrega no meio de uma ligação.

---

## Protocolo do WebSocket

1. O cliente abre `wss://.../ws` e manda **primeiro** `{"type":"auth","token":"<ID token>"}`.
2. O servidor responde `auth_ok` com `payload: {"versao":2,"recursos":[...]}`.
   Os recursos atuais: `ping`, `status-lote`, `presenca-graca`, `visto-no-aviso`.
   O cliente só usa o que o servidor anunciou, então front e back podem ser
   publicados em qualquer ordem.
3. Batimento: o cliente manda `ping` a cada 25 s parado; sem `pong` em 10 s,
   reconecta.

| Tipo | Direção | Para quê |
|---|---|---|
| `status_check` / `status_lote` | cliente → servidor | presença de 1 pessoa / de várias num quadro só |
| `status_update` / `status_reply` | servidor → cliente | `online` ou `offline` + `lastSeen` |
| `digitando` / `parou_digitando` | ida e volta | com `payload.chatId`; o servidor limita a 1 aviso a cada 700 ms e descarta rajadas logo após conectar |
| `chat` | ida e volta | aviso de mensagem nova, com o `chatId` (a mensagem em si está no Firestore); serve também para marcar "entregue" |
| `webrtc`, `chamada`, `cancelar_chamada` | ida e volta | sinalização da chamada (oferta, resposta, candidatos, `consultar_toque`/`tocando`) |

"Digitando" e presença nunca entram na fila offline do cliente: reentregar
isso depois de uma queda era o que fazia aparecer "digitando..." do nada.

### Chamadas

A chamada roda numa janela própria (`chamada.html`, nome `sinex-chamada`). As
outras abas falam com ela por `BroadcastChannel("sinex-chamada")` — a barra
verde no topo mostra o tempo e o botão "Voltar" traz a janela para a frente
**sem navegar nela** (`window.open("", nome)`), o que antes derrubava a
ligação. O "minimizar" usa o Picture-in-Picture de documento (a interface
inteira vai para a janelinha) e, onde ele não existe, o PiP de vídeo.

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

chamada.js ......... a janela da chamada (WebRTC, PiP, estados)
chamada-flutuante.js barra de chamada em andamento e conversa entre janelas

main.go ............ HTTP, handshake e autenticação do WebSocket
hub.go ............. roteamento de mensagens e presença
client.go .......... pumps de leitura/escrita e limite de taxa
identity.go ........ verificação de token e persistência do lastSeen
cmd/setadmin ....... concede/revoga permissão de admin
assets/ ............ ícones do PWA, sons e avatares padrão (pessoa e grupo)
```

---

## Convenções

- Nada de `onclick` no HTML e nada de `<script>` inline: é isso que permite ao
  CSP recusar `'unsafe-inline'` em `script-src`.
- Nada de `style=""` no HTML nem de `<style>` criado por script: o CSP também
  recusa `'unsafe-inline'` em `style-src`. Para mostrar/esconder, use
  `Core.mostrar(elemento, visivel)` (classe `.u-hidden`), não `style.display`.
- Conteúdo vindo do banco entra no DOM por `textContent` ou `createElement`,
  nunca por `innerHTML`.
- Timestamps são do servidor (`serverTimestamp()`), não do relógio do
  aparelho.
