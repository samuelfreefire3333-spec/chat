# Análise e correções — Sinex Chat

Varredura completa do projeto (21 módulos JS, telas HTML/CSS, regras do
Firestore/Storage e o backend Go). Abaixo, o que estava quebrado, por que
quebrava e o que mudou. 21 arquivos alterados.

---

## 1. Bugs que impediam o app de funcionar

### 1.1 Apagar conversa nunca funcionava — `firestore.rules`

A regra permitia apagar mensagem só ao próprio remetente:

```
allow delete: if participanteDoChat() && resource.data.remetenteUid == meuUID();
```

Mas `apagarChat()` apaga as mensagens em lotes (`writeBatch`), e um lote no
Firestore é tudo-ou-nada. Bastava **uma** mensagem da outra pessoa para o lote
inteiro ser recusado. Na prática: toda conversa com resposta do outro lado era
impossível de apagar, e a tela só mostrava "não foi possível apagar".

Agora qualquer participante pode apagar mensagens daquela conversa — que é
exatamente o que a confirmação na tela já prometia ("serão excluídas para todos
os participantes").

### 1.2 Cadastro novo caía direto no login — `cadastro.js` + `tema.js`

Duas coisas combinadas:

- `tema.js` mandava para `login.html` toda vez que `localStorage.usuario`
  estivesse vazio;
- `cadastro.js` ia para `inbox.html` **antes** de qualquer coisa gravar esse
  cache.

Resultado: quem criava a conta era cuspido de volta para o login. Em aba
anônima (onde `localStorage` lança exceção) isso virava um ping-pong infinito
entre as duas telas, e derrubava também quem já estava logado com o
armazenamento limpo — a sessão de verdade vive no IndexedDB do Firebase Auth,
que aquele trecho nem consultava.

Agora `tema.js` apenas **esconde** a tela até `Core.sessao()` decidir (com um
fallback de 4 s caso o módulo não carregue), e o cadastro grava o cache antes
de sair da página.

### 1.3 A conversa congelava ao minimizar o navegador — `chat.js`, `inbox.js`

`pagehide` desligava o listener do Firestore, mas nada religava. E `pagehide`
dispara ao minimizar: o celular volta do cache de retorno (bfcache) sem
recarregar a página, então a conversa ficava parada — nenhuma mensagem nova
aparecia até recarregar na mão. Agora há `pageshow` + `visibilitychange`
religando a escuta (com trava contra listener duplicado).

### 1.4 Toque longo não funcionava no celular — `chat.js`, `inbox.js`

Dois problemas distintos:

- **No chat**: o menu de reagir/responder abria e fechava no mesmo instante. O
  `pointerup` que encerra o toque longo gera um `click`, e o handler de
  "clicou fora, fecha" matava o menu recém-aberto.
- **Na caixa de entrada**: pior ainda. Qualquer `pointermove` cancelava o
  timer — e um dedo nunca fica parado, então os 500 ms quase nunca eram
  atingidos. Quando eram, o `click` seguinte desmarcava o item e o modo de
  seleção fechava sozinho.

Agora ambos ignoram o clique imediatamente posterior à abertura, e a caixa de
entrada usa a mesma tolerância de 10 px que o chat já usava, com retorno visual
(o card afunda enquanto o dedo está pressionado).

### 1.5 Banimento demorava até 30 minutos para valer — `identity.go`

O cache `uid → username` era consultado antes da checagem de status. Uma conta
banida continuava conseguindo abrir conexões novas por até 30 minutos, porque
o caminho que lê `status` nem era percorrido. `/admin/kick` derruba quem está
conectado, mas não impede a reconexão logo em seguida.

Agora um acerto no cache faz uma leitura pontual do documento para conferir o
status (mais barata que a consulta por campo do caminho completo). Também há um
teto de 10.000 entradas — o mapa antes só crescia.

### 1.6 Enviar em grupo derrubava a conexão — `client.go`

O limite era 30 mensagens por 10 s por conexão. Mas o cliente avisa **cada**
participante individualmente: num grupo de 20 pessoas, um único envio gasta 19
quadros. Duas mensagens seguidas estouravam o limite e o servidor fechava o
WebSocket de quem estava só conversando. Limite subiu para 150/10 s — ainda
barra flood automatizado.

### 1.7 Áudio gravado no iPhone chegava quebrado — `chat.js`

O blob era forçado para `audio/webm` e salvo como `.webm`. O Safari do iPhone
não grava webm (grava mp4), então o arquivo saía inconsistente. Agora o tipo e
a extensão vêm do próprio `MediaRecorder`. Imagens também: PNG e WebP eram
salvos como `.jpg`.

### 1.8 Chamada conectava sem som — `chamada.js`

`autoplay` no `<video>` não basta: a política de reprodução automática bloqueia
mídia com som numa página sem nenhum gesto do usuário — e quem atende chega ali
vindo de **outra** página. A chamada conectava e simplesmente não saía som.
Agora há um `play()` explícito e, se for bloqueado, a tela pede um toque.

Também: quem atende não tinha nenhum tempo limite. Se a oferta nunca chegasse,
a tela ficava presa em "Conectando..." para sempre. Agora há teto de 45 s.

### 1.9 Mensagem recém-enviada podia sumir — `mensagens.js`

Enquanto o servidor não confirma, `serverTimestamp()` vinha `null`, o
`timestampMs` ficava 0 e a mensagem caía para o começo da ordenação. Numa
conversa com mais de 200 mensagens ela não aparecia até o servidor responder.
Agora o SDK devolve uma estimativa local (`serverTimestamps: "estimate"`) e o
estado "enviando" vem de `metadata.hasPendingWrites`, que é a informação certa.

---

## 2. Comportamentos que atrapalhavam o uso

| O que acontecia | Onde | Agora |
|---|---|---|
| Carregar histórico antigo jogava a tela para o fim | `chat.js` | A posição de leitura é mantida |
| Mensagem nova arrastava a tela para baixo no meio da leitura | `chat.js` | Pílula "novas mensagens ↓" flutuante |
| Indicador "digitando" também puxava a tela | `chat.js` | Só acompanha quem já estava no fim |
| As 200 bolhas do histórico animavam juntas ao abrir | `chat.css` | Animação só em mensagem recém-chegada |
| Reagir a uma mensagem reanimava a bolha | `chat.js` | Redesenho não anima |
| Impossível copiar o texto de uma mensagem | `chat.css` | Seleção no desktop + "Copiar" no menu |
| Campo de mensagem de uma linha só, sem quebra de linha | `chat.html` | Textarea que cresce; Shift+Enter quebra linha |
| Corretor e maiúsculas desligados no campo | `chat.html` | `autocapitalize="sentences"`, corretor ligado |
| Botão de pause travado no áudio anterior | `chat.js` | Ícone segue o estado real do player |
| Duração do áudio presa em 0:00 após ouvir | `chat.js` | Volta ao total |
| Status online sumia a cada mensagem recebida | `inbox.js` | Presença guardada fora do DOM |
| A setinha do `<h1>` desaparecia ao carregar | `inbox.html` | Nome vai num `<span>` próprio |
| Buscar "Maria" não achava quem tem @ diferente | `explorar.js` | Busca também pelo nome de exibição |
| Salvar nome/foto só aparecia após recarregar | `core.js`, `foto.js`, `editar-perfil.js` | Perfil em cache é atualizado na hora |
| Contador de não lidas ficava preso | `chat.js` | Zera ao abrir a conversa |
| Abrir o perfil do contato não respondia a teclado | `chat.js` | Enter/Espaço funcionam |
| Modal de seguidores só fechava pelo "x" | `perfil.js` | Esc e clique fora fecham |
| Prévia da foto vazava memória a cada troca | `foto.js` | `revokeObjectURL` |
| `keypress` (depreciado) no login e no cadastro | `login.js`, `cadastro.js` | `keydown`, com `isComposing` |

**Service worker** (`sw.js`, versão `v2` → `v3`): faltavam `grupo-novo.html`,
`grupo-novo.js` e **todos** os CSS de tela no pré-cache — offline, as páginas
abriam sem estilo. E o cache de navegação guardava uma entrada por URL
completa: `chat.html?u=fulano`, `chat.html?u=ciclano`... crescendo sem limite
enquanto rebaixava o mesmo arquivo. Agora a chave é só o caminho.

> Lembre: **suba o `VERSAO` no `sw.js` a cada publicação**, senão quem já tem o
> app instalado continua com os arquivos antigos.

---

## 3. Coisas que encontrei e **não** mexi

Não são bugs de código — são decisões de produto ou de infraestrutura:

1. **Chamadas só têm STUN, sem TURN.** Em rede móvel e NAT simétrico, a
   chamada simplesmente não conecta para uma parcela real dos usuários. Resolver
   exige um servidor TURN (serviço pago ou um coturn próprio). É a maior
   limitação técnica do projeto hoje.
2. **`firebase-key.json` está dentro da pasta do projeto.** Ele está no
   `ignore` do Hosting, então não vai para o ar — mas é a chave de service
   account com poder total sobre o Firebase. Se essa pasta for para um
   repositório público, a conta inteira está comprometida. Vale tirar dali e
   deixar só na variável de ambiente.
3. **Presença é transmitida para todo mundo conectado.** `broadcastPresenca`
   avisa cada usuário online quando qualquer outro entra ou sai — inclusive
   estranhos. Funciona com poucos usuários; com muitos, vira custo e vazamento
   de presença. Consertar exige um grafo de contatos no servidor.
4. **Apagar conversa apaga para todos, sem opção de "apagar só para mim".**
   Está coerente com o que a tela promete, mas é uma escolha forte.
5. **Não há notificação push de verdade.** O aviso só chega com o app aberto.
   Isso pede FCM + Web Push no service worker.
6. **Grupos não têm tela de informações, sair do grupo nem adicionar membro** —
   a lista de participantes é imutável por regra do Firestore.

---

## Depois de publicar

```bash
firebase deploy --only hosting,firestore
```

O deploy das **regras é obrigatório** nesta leva: sem ele, apagar conversa
continua falhando. O backend Go precisa de um redeploy para o limite de taxa e a
checagem de banimento valerem.
