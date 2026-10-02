# Segurança do Sinex Chat

Este documento registra a auditoria de segurança, o que foi corrigido, como
cada proteção funciona, o modelo de ameaça da criptografia de ponta a ponta, a
configuração de produção e o que ainda depende de ação fora do código.

Leia junto com o `README.md` (arquitetura e operação do dia a dia).

---

## 1. Visão geral

```
Navegador (PWA, Netlify)
  ├── Firebase Auth ....... identidade (uid). Senha com hash do Google (scrypt).
  ├── Firestore ........... perfis, conversas, mensagens  ← firestore.rules
  ├── Storage ............. fotos de perfil e mídia       ← storage.rules
  └── Backend Go (Render) . WebSocket: presença, digitando, avisos, chamada
                            + endpoints de admin e de sessão
```

**Fronteiras de confiança**

- O navegador fala direto com o Firestore e o Storage. Por isso **as regras
  (`firestore.rules` e `storage.rules`) são a barreira real** — o JavaScript
  pode ser alterado por quem usa o app e nunca é confiável.
- O backend Go **não guarda mensagens**. Ele confere o ID token de cada
  conexão com o Admin SDK, ignora qualquer identidade que o cliente declare e
  autoriza cada quadro contra o documento da conversa no Firestore.
- A configuração do Firebase em `firebase.js` (apiKey, projectId…) é pública
  por natureza. Ela não dá acesso a nada que as regras não permitam; mesmo
  assim, a chave deve ser restrita no Google Cloud (seção 15).

**Prioridade usada em todas as decisões:** segurança real > compatibilidade >
desempenho > estética.

---

## 2. Auditoria inicial — o que foi encontrado e o que foi feito

Legenda: ✅ corrigido no código · 🟡 mitigado (resta ação fora do código ou
limitação documentada) · ⚙️ depende de configuração no Console/Render.

### Crítico

| # | Problema | Situação | Onde |
|---|---|---|---|
| 1 | WebSocket sem autorização por conversa: qualquer conta mandava `chamada`, `webrtc`, `digitando` e `chat` para qualquer @, com `chatId` inventado | ✅ Cada quadro é reconstruído (`validarQuadro`) e autorizado contra `chats/{id}.uids` (`Autorizador`); o destino precisa participar da conversa; `from` é sempre o do token | `protocolo.go`, `autorizacao.go`, `hub.go`, `client.go` |
| 2 | Link de chamada ligava câmera e microfone sem consentimento (`chamada.html?u=…&papel=receptor`) | ✅ A janela da chamada só liga mídia com uma "intenção" de uso único (60 s) criada pelo próprio app ao tocar em ligar/atender | `chamada-flutuante.js`, `chamada.js`, `radar.js`, `chat.js` |
| 3 | Fotos e áudios com URL pública permanente (token de download) e Storage legível por qualquer conta | ✅ Mídia nova em `midia/{chatId}/{uid}/{uuid}`, baixada com login (`getBlob`) e só por participantes; 🟡 arquivos antigos até rodar `cmd/migrar-seguranca` | `midia.js`, `storage.rules`, `firestore.rules`, `cmd/migrar-seguranca` |
| 4 | Backend podia ligar uma conta ao perfil de outra (fallback por e-mail sobrescrevia `uid`) | ✅ Só adota perfil **sem** dono, em transação que confere de novo | `identity.go` |
| 5 | Banimento não barrava o Firestore (conta seguia lendo/escrevendo) | ✅ Banir desativa a conta no Auth e revoga os refresh tokens; 🟡 o ID token já emitido vale até 1 h no Firestore (seção 4) | `identity.go`, `main.go`, `admin.js` |
| 6 | E-mail de todos os usuários exposto em `usuarios/{@}` (listável por qualquer conta) | ✅ Contas novas guardam o e-mail em `contas/{uid}` (só o dono lê); 🟡 perfis antigos até rodar a etapa `email` da migração | `cadastro.js`, `firestore.rules`, `cmd/migrar-seguranca` |

### Alto

| # | Problema | Situação | Onde |
|---|---|---|---|
| 7 | Mensagens sem esquema: texto até 1 MiB, `tipo` livre (golpe como mensagem "de sistema"), URL arbitrária, reação/citação sem limite | ✅ Lista fechada de campos, tipos conhecidos, texto ≤ 8000, sistema só com os textos de chamada, mídia só por caminho privado, reação ≤ 16 | `firestore.rules` |
| 8 | Qualquer membro apagava um grupo inteiro | ✅ Só quem criou (`criadoPorUid`) | `firestore.rules`, `inbox.js`, `mensagens.js` |
| 9 | Criação de conversa/grupo aceitava campos arbitrários (`leituras` de outra pessoa, `criadoPor` falso) | ✅ Lista fechada; horários do servidor; `criadoPorUid` = quem cria | `firestore.rules` |
| 10 | Uma conta registrava vários @; cadastro aceitava campos extras | ✅ Perfil nasce no mesmo lote que `contas/{uid}`, que só nasce uma vez | `firestore.rules`, `cadastro.js` |
| 11 | Amplificação de custo: `status_lote` → ~30.000 leituras/10 s por conexão; sem limite de conexões | ✅ Limites por tipo e por conta, orçamento de consultas de presença, leitura em lote com cache, teto de conexões por IP/conta/total | `client.go`, `hub.go`, `identity.go`, `limites.go` |
| 12 | Texto da mensagem passava em claro pelo servidor de WebSocket | ✅ O aviso `chat` leva só o `chatId`; o servidor descarta qualquer conteúdo | `protocolo.go`, `radar.js` |
| 13 | Não existia "sair de todos os aparelhos" nem revogação de sessão | ✅ `POST /sessoes/revogar` + remoção das chaves dos outros aparelhos | `main.go`, `configuracoes.js` |

### Médio

| # | Problema | Situação | Onde |
|---|---|---|---|
| 14 | CSP liberava `www.gstatic.com` inteiro, `ws://localhost` e um site de ícones | ✅ Só `/firebasejs/10.12.2/`; sem localhost; sem terceiros; relatórios de violação | `netlify.toml`, `firebase.json` |
| 15 | Faltavam HSTS, X-Frame-Options, CORP; backend sem headers/timeouts, 403 onde devia ser 401 | ✅ | `netlify.toml`, `firebase.json`, `seguranca_http.go`, `main.go` |
| 16 | Upload confiava no Content-Type, aceitava SVG, mantinha GPS/EXIF, nome previsível | ✅ Foto redesenhada (sem EXIF), assinatura real conferida por quem envia e por quem recebe, nome UUID, SVG/HTML recusados | `midia.js`, `midia-validacao.js`, `storage.rules` |
| 17 | Listagem de `usuarios` sem teto (raspagem); `foto` aceitava qualquer URL | ✅ `limit <= 50`; foto só do próprio uid no bucket do projeto | `firestore.rules`, `core.js` |
| 18 | Sem trilha de auditoria | ✅ Log estruturado + eventos de segurança no painel admin | `auditoria.go`, `admin.js` |
| 19 | Senha mínima de 6; enumeração e cota de cadastro dependiam do Console | ✅ Mínimo 8 no cadastro; ⚙️ política de senha, proteção contra enumeração e cota no Console (seção 15) | `cadastro.js` |

### Encontrados durante a correção

| Problema | Situação | Onde |
|---|---|---|
| Cópia offline das conversas (cache do Firestore no IndexedDB) ficava no navegador depois de sair da conta | ✅ Apagada ao sair e na tela de login | `core.js`, `configuracoes.js`, `login.js` |
| O SDK de Auth carregava, em celulares/Safari, um iframe de `firebaseapp.com` e `apis.google.com/js/api.js` sem necessidade (login é só e-mail/senha) | ✅ `initializeAuth` sem o módulo de popup/redirect | `firebase.js` |
| `aviso.html` exibia título e texto livres vindos da URL (página oficial com texto de golpe) | ✅ Só mensagens pré-definidas por código | `aviso.js`, `admin.js` |
| Mensagem cifrada podia apontar para arquivo de outra conversa (o caminho fica dentro da cifra, fora do alcance das regras) | ✅ O caminho precisa ser da conversa aberta | `midia.js`, `midia-validacao.js`, `chat.js` |
| Credencial do Google aceita em qualquer formato (`WithCredentialsJSON`, marcada como obsoleta por risco) | ✅ Só `service_account` | `identity.go`, `cmd/*` |
| Marcas de leitura podiam ser gravadas no futuro | ✅ Regra limita a "agora + 10 min" | `firestore.rules` |

### Informativo

- **Presença é visível para qualquer conta logada** ("online / visto por
  último"). É comportamento do produto; o custo de consulta foi limitado.
  Tornar opcional exige uma preferência de privacidade (ver seção 17).
- Não há SQL, ID sequencial, template no servidor nem execução de comando: as
  classes de injeção correspondentes não se aplicam. Caminhos de arquivo são
  validados por expressão regular nas regras, no front e no Go.

---

## 3. Autorização

**Regra de ouro:** tudo se apoia no `uid` do token verificado — nunca em um
@, e-mail ou ID vindo do cliente.

### No Firestore (`firestore.rules`)

Funções reutilizáveis no topo do arquivo: `autenticado()`, `ehAdmin()`
(custom claim `admin`), `meuUID()`, `ehMeuNome(@)` (o @ pertence a quem
escreve, pelo perfil ou por `contas/{uid}`), `mudou()`, validações de formato.

- Negação por padrão (`match /{document=**}` no fim).
- Toda escrita tem lista fechada de campos (`hasOnly`) com tipo e tamanho.
- Horários sempre `request.time` (`serverTimestamp()` no cliente).
- Conversa: só quem está em `uids` lê/escreve; `uids` nunca muda. Uma
  conversa que não existe responde "sem permissão" (não revela se duas
  pessoas conversam).
- O admin modera perfis, **não lê conversas** (os contadores do painel vêm do
  backend).

### No backend Go

- `autenticar()` (HTTP): **401** sem token ou com token inválido/revogado/conta
  desativada; **403** quando falta a permissão de admin; **429** com
  `Retry-After` quando passa do limite; **503** quando o Firebase está fora.
  Respostas de erro são JSON genérico (`{"erro":"codigo"}`), sem detalhes
  internos.
- `Autorizador.Autorizar(ctx, uid, chatId)`: a camada única que decide se um
  uid participa de uma conversa. Cache positivo de 5 min e negativo de 3 s,
  orçamento de consultas por conta (anti-amplificação).
- `validarQuadro()`: reconstrói cada quadro do WebSocket a partir de uma lista
  de campos permitidos por tipo — nada do cliente é repassado "como veio".

---

## 4. Autenticação e sessões

| Tema | Como está |
|---|---|
| Hash de senha | Firebase Auth (scrypt modificado, gerido pelo Google). O app nunca vê nem guarda senha. |
| Tokens | ID token (JWT) de 1 h + refresh token, renovados pelo SDK. O backend usa `VerifyIDTokenAndCheckRevoked` (assinatura, validade, projeto, revogação, conta desativada). |
| Token em URL | Nunca. WebSocket autentica no **primeiro quadro** (`{"type":"auth","token":…}`), HTTP pelo cabeçalho `Authorization`. |
| Cookies | Não são usados (sem cookie, não há CSRF clássico; ver seção 9). |
| Logout | Apaga as chaves E2EE deste aparelho, a cópia offline das conversas e o cache local; encerra o WebSocket. |
| Sair de todos os aparelhos | `POST /sessoes/revogar`: revoga os refresh tokens no Auth e derruba os WebSockets da conta; remove as chaves públicas dos outros aparelhos. |
| Troca de senha / recuperação | Feitas pelo Firebase Auth (links de uso único, com validade, enviados por e-mail). Trocar a senha revoga as sessões antigas no Firebase. A tela diz a mesma coisa exista a conta ou não. |
| Banimento/suspensão | `POST /admin/status`: grava o status, **desativa a conta no Auth** e revoga os tokens; o WebSocket cai na hora. |
| MFA | Não implementado. O Firebase oferece segundo fator por SMS/TOTP com o upgrade para Identity Platform — recomendado para contas admin (seção 15). |

**Limitação conhecida:** o Firestore aceita um ID token até ele expirar (no
máximo 1 hora), mesmo depois de revogado — é assim que o Firebase funciona.
Depois de banir ou de "sair de todos", o acesso ao Firestore termina em até
1 h; o WebSocket e os endpoints do backend param na hora. Para corte
imediato também no Firestore seria preciso checar o status do perfil em cada
regra (um `get()` extra por operação) — trade-off de custo documentado aqui.

---

## 5. WebSocket (`/ws`)

1. `wss://` apenas (`REQUIRE_HTTPS=true` recusa o que chegou sem TLS no proxy).
2. `Origin` precisa estar na lista de `config.go` (+ `ALLOWED_ORIGINS`).
3. Primeiro quadro em até 10 s, no máximo 8 KB: `auth` com o ID token.
   Token inválido fecha com a mensagem "Sessão expirada. Entre novamente.";
   conta banida, "Conta suspensa ou banida.".
4. Depois disso, quadros de até 64 KB (SDP até 32 KB, candidato ICE até 1 KB).
5. `from` é sempre o @ do token. `chat`, `digitando`, `chamada`, `webrtc` e
   `cancelar_chamada` só passam se remetente **e** destinatário participam da
   conversa (conferido no Firestore).
6. Recusas voltam como `{"type":"erro","content":"<código>"}` (no máximo 1
   por segundo), com códigos genéricos: `quadro_invalido`, `nao_autorizado`,
   `limite_excedido`, `indisponivel`. JSON quebrado ou com tipo trocado nos
   campos do quadro encerra a conexão (1007, "quadro inválido").
7. Batimento: ping do servidor a cada 54 s (pong em 60 s) e `ping` do
   cliente a cada 25 s.

### Limites e anti-abuso

| O quê | Limite |
|---|---|
| Handshakes por IP | 60/min (rajada 20) |
| Falhas de autenticação por IP | 20 em 10 min → bloqueio de 15 min (429) |
| Conexões | total 5000, por IP 30, por conta 10 (a mais antiga cai) |
| Quadros por conexão | 150 a cada 10 s → conexão encerrada ("limite de mensagens") |
| Recusas por conexão | mais de 30/min → conexão encerrada ("abuso detectado", 1008) |
| `chat` / `digitando` | 240/min por conta |
| `status_check` / `status_lote` | 120/min / 20/min por conta (lote até 200 alvos) |
| `chamada` | 12/min por conta |
| `webrtc` | 1200/min por conta |
| Consultas de autorização | 120/min por conta |
| Endpoints HTTP autenticados | 60/min por IP |
| `/sessoes/revogar` | 6/min por conta |
| Relatórios de CSP | 30/min por IP |

Os limites são por **conta** (uid), não por conexão: abrir dez abas não
multiplica nada. Tudo em memória (uma instância no Render); com mais de uma
instância, mover para Redis (seção 17).

---

## 6. Mídia privada e uploads

**Arquitetura escolhida:** "endpoint protegido que confere a autorização antes
de entregar o arquivo" — o próprio endpoint do Firebase Storage, que avalia
`storage.rules` em **cada** download com o ID token de quem pede (que expira
em 1 h). Não existe URL para vazar: sem token válido de um participante, o
arquivo não sai. URLs assinadas não foram usadas porque exigiriam um backend
emitindo-as (e o link, enquanto válido, funciona para qualquer um).

**Caminho:** `midia/{chatId}/{uidDeQuemEnvia}/{uuid}` — nome aleatório, sem
extensão, sem link público. O nome e a extensão do arquivo original são
ignorados: o tipo sai dos bytes (magic bytes), nunca do nome.

- **Download:** `getBlob()` com login; as regras do Storage consultam o
  Firestore (`firestore.get(chats/{chatId}).uids`) a cada acesso. O arquivo
  vira uma URL `blob:` que só existe naquela aba (cache de 150 itens).
- **Conferência do tipo real:** os primeiros bytes (magic bytes) são
  conferidos **por quem recebe**, antes de exibir — é essa checagem que
  protege, porque o `contentType` é declarado pelo cliente.
- **Fotos:** redesenhadas no navegador (canvas) → some EXIF/GPS/modelo do
  aparelho e qualquer coisa escondida no arquivo; lado máximo 2048 px;
  imagens acima de 40 megapixels recusadas (bomba de descompressão). GIF passa
  como está (não carrega GPS).
- **Tipos aceitos:** JPEG, PNG, WebP, GIF; áudio WebM, Ogg, MP4/M4A, MP3,
  AAC. SVG, HTML, scripts e executáveis são recusados nas regras e no
  aparelho.
- **Tamanhos:** imagem < 10 MB, áudio < 15 MB, arquivo cifrado < 16 MB;
  avatar < 2 MB (só JPEG).
- **Sem sobrescrever:** `update` negado; só o dono apaga o próprio arquivo;
  listar pastas é negado.
- **Cabeçalhos:** `Cache-Control: private` (nenhum cache compartilhado guarda
  a resposta).

**Fotos de perfil** continuam com link de download (são públicas para quem
está logado, como o perfil), mas só JPEG, com nome aleatório e na pasta do
próprio uid.

**Observação honesta:** o Firebase deixa qualquer um que **pode ler** um
arquivo gerar um link de download para ele (`getDownloadURL`). O app nunca faz
isso para mídia de conversa, e a etapa `tokens` da migração remove os tokens
existentes; mas um participante com o app adulterado consegue criar um link
— o que não dá a ele nada além do que já tem (ele pode baixar o arquivo).

**CORS do bucket:** o `getBlob()` precisa da configuração de `cors.json`
aplicada ao bucket (seção 15). Sem ela, a mídia nova não abre no navegador.

---

## 7. Criptografia de ponta a ponta (E2EE)

### O que é

Conversas diretas podem ser **protegidas**: o texto, as fotos e os áudios são
cifrados no aparelho de quem envia e só abrem nos aparelhos das duas pessoas.
O Firestore, o Storage, o backend Go e quem administra o projeto veem só
dados cifrados. Liga pelo escudo no topo da conversa; **não desliga** (as
regras impedem que um participante rebaixe a conversa em silêncio).

### Por que opcional

Ligar para todo mundo de uma vez quebraria o histórico (mensagens antigas
estão em claro), o uso em aparelho novo (não há como levar chaves antigas sem
um sistema de backup) e grupos (ainda sem suporte). Opcional e explícito
evita prometer uma proteção que não existe.

### Protocolo (nada inventado)

| Peça | Padrão | Implementação |
|---|---|---|
| Entrega da chave de cada mensagem para cada aparelho | **HPKE** (RFC 9180), modo base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM | `@hpke/core` 1.9.0 (`vendor/`), validado com o vetor oficial da RFC nos testes |
| Cifragem do conteúdo | AES-256-GCM (cifragem autenticada), IV aleatório de 96 bits | Web Crypto |
| Autenticidade do remetente | ECDSA P-256 / SHA-256 sobre o envelope inteiro | Web Crypto |
| Número de segurança | SHA-512 iterado 5200× sobre uid + chaves de todos os aparelhos (como o Signal); 60 dígitos | `e2ee-cripto.js` |

**Por mensagem:** gera-se uma chave de conteúdo aleatória (32 bytes); o
conteúdo JSON é cifrado com AES-256-GCM; a chave é **selada com HPKE** para
cada aparelho de cada participante (inclusive os outros aparelhos de quem
envia); o envelope inteiro é assinado com a chave do aparelho que enviou.

**Dados associados (AAD):** `chatId`, uid de quem envia e aparelho. Copiar o
envelope para outra conversa, ou trocar o remetente no banco, faz a abertura
falhar. A assinatura é conferida **antes** de decifrar.

**Arquivos:** cada foto/áudio é cifrado com chave própria (AES-256-GCM, AAD =
caminho do arquivo) e sobe como `application/octet-stream`. A chave do
arquivo viaja **dentro** da mensagem cifrada.

**O que o servidor guarda de uma mensagem protegida:**
`{remetente, remetenteUid, tipo:"cifrada", timestamp, e2ee:{v, dispositivo,
iv, ct, chaves, sig}}`. As regras recusam texto, mídia ou prévia de resposta
em claro numa conversa protegida, e o resumo da conversa vira
"🔒 Mensagem protegida".

### Chaves e aparelhos

- Cada navegador/aparelho gera **dois pares P-256** (ECDH para HPKE, ECDSA
  para assinar) como `CryptoKey` **não extraível**, guardados no IndexedDB.
  Nem o próprio app (nem um script injetado) consegue ler os bytes da chave
  privada. **A chave privada nunca sai do aparelho.**
- Só as chaves **públicas** vão para `chavesPublicas/{uid}/dispositivos/{id}`.
  As regras deixam só o dono publicar/apagar, e publicar não edita (rotação
  = aparelho novo).
- **Aparelho novo:** gera as próprias chaves e passa a receber as mensagens
  **enviadas depois**. Não lê o histórico protegido anterior.
- **Revogação:** sair da conta apaga as chaves deste aparelho e o registro
  público dele. "Sair de todos os aparelhos" remove os registros dos outros;
  eles deixam de receber mensagens novas e, ao abrir, geram chaves novas.
- **Rotação:** sair e entrar gera um par novo. Não há rotação automática
  periódica (ver limitações).
- **Troca de chaves detectada:** o app guarda o "retrato" das chaves de cada
  contato; se mudarem (aparelho novo, reinstalação — ou alguém inserindo um
  aparelho falso), a conversa mostra um aviso até a pessoa aceitar ou
  verificar de novo.
- **Verificação:** o número de segurança de 60 dígitos é igual nos dois
  aparelhos; conferido pessoalmente ou por outro canal, prova que ninguém
  (nem o servidor) trocou chaves no meio.

### Modelo de ameaça

**Protege contra:**
- leitura das mensagens por quem tem acesso ao banco, ao Storage, aos logs, ao
  backend ou à conta do projeto (inclusive um admin do app);
- vazamento de backup ou de export do Firestore;
- adulteração de mensagem armazenada (integridade + assinatura);
- mensagem copiada para outra conversa ou atribuída a outra pessoa;
- troca de chave pelo servidor **quando o número de segurança foi
  verificado** (e aviso de troca em qualquer caso).

**Não protege contra:**
- **aparelho comprometido** (malware, extensão maliciosa do navegador, alguém
  com o celular desbloqueado): lê o que a pessoa lê;
- **o próprio código do app**: numa aplicação web, quem controla o servidor
  que entrega o JavaScript (Netlify/GitHub) pode entregar uma versão que vaza
  chaves. É a limitação estrutural de E2EE em navegador; mitigações na seção
  17;
- **metadados**: quem conversa com quem, quando, quantas mensagens, tamanho
  aproximado, tipo (texto/foto/áudio pelo tamanho), reações (emoji e quem
  reagiu ficam em claro), eventos de chamada e presença;
- **servidor malicioso sem verificação**: sem conferir o número de segurança,
  o servidor poderia inserir um aparelho dele antes da primeira mensagem (o
  aviso de troca só dispara depois do primeiro contato);
- **chamadas de voz/vídeo**: a mídia é cifrada ponto a ponto pelo WebRTC
  (DTLS-SRTP), mas a sinalização passa pelo backend sem assinatura das
  impressões DTLS — um backend comprometido poderia se colocar no meio.

### Limitações (sem maquiagem)

1. **Sem sigilo futuro por mensagem** (não há *ratchet* como no Signal/Double
   Ratchet): quem roubar a chave privada de um aparelho — o que exige
   comprometer o aparelho, porque ela não é extraível — lê tudo o que foi
   cifrado para aquele aparelho enquanto ele existiu. A mitigação é
   revogar aparelhos (sair) com frequência.
2. **Sem backup/recuperação de chaves:** perder o aparelho (ou limpar os dados
   do site) = perder o acesso ao histórico protegido daquele aparelho.
   Arquitetura correta para quando for implementar: backup cifrado com chave
   derivada de uma frase de recuperação (Argon2id), guardado no servidor sem
   que ele consiga abrir — nos moldes do backup cifrado do WhatsApp.
3. **Só conversas diretas.** Grupos exigem gerenciamento de membros com chave
   de grupo (MLS, RFC 9420); o esquema atual (selar para cada aparelho) até
   funcionaria para poucos membros, mas não foi habilitado para não prometer
   o que não foi testado.
4. **Aparelhos por conta:** até 20 listados; envelope com até 64 aparelhos.
5. Mensagens protegidas não aparecem na busca/visualização de outras telas
   como texto (a caixa de entrada mostra "🔒 Mensagem protegida").

---

## 8. Front-end

### Headers (Netlify e Firebase Hosting, idênticos)

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://www.gstatic.com/firebasejs/10.12.2/;
  style-src 'self'; font-src 'self';
  img-src 'self' data: blob: https://firebasestorage.googleapis.com https://*.firebasestorage.app;
  media-src 'self' blob: https://firebasestorage.googleapis.com https://*.firebasestorage.app;
  connect-src 'self' wss://sinex-backend-go.onrender.com https://sinex-backend-go.onrender.com
              https://firestore.googleapis.com https://identitytoolkit.googleapis.com
              https://securetoken.googleapis.com https://firebasestorage.googleapis.com
              https://*.firebasestorage.app https://www.googleapis.com;
  worker-src 'self'; manifest-src 'self'; frame-src 'none'; base-uri 'self';
  form-action 'self'; object-src 'none'; frame-ancestors 'none';
  upgrade-insecure-requests;
  report-uri https://sinex-backend-go.onrender.com/seguranca/csp; report-to csp
Reporting-Endpoints: csp="https://sinex-backend-go.onrender.com/seguranca/csp"
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(self), microphone=(self), display-capture=(), geolocation=(), …
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

- **Sem `'unsafe-inline'` e sem `'unsafe-eval'`** em lugar nenhum. Não há
  `<script>` inline, `onclick=`, `style=""`, `eval`, `new Function` nem
  `setTimeout("texto")`.
- `innerHTML` só recebe **constantes do próprio código** (ícones SVG,
  esqueletos de carregamento). Conteúdo do banco entra por `textContent` /
  `createElement`. URLs passam por `urlSegura()` (lista de hosts) e destinos
  de navegação por `destinoSeguro()` (só páginas locais).
- Conteúdo decifrado (E2EE) também é validado (`validarConteudo`) antes de ir
  para a tela — quem cifra pode ter o app adulterado.
- Violações de CSP chegam ao backend e aparecem no painel admin.

### Armazenamento no navegador

| Onde | O quê | Ao sair da conta |
|---|---|---|
| IndexedDB do Firebase Auth | sessão (refresh token) | apagada pelo `signOut` |
| IndexedDB do Firestore | cópia offline de perfis e conversas | **apagada** (`apagarCopiaOffline`) |
| IndexedDB `sinex-e2ee` | chaves do aparelho (não extraíveis), chaves vistas dos contatos | chaves do aparelho apagadas; registro público removido |
| localStorage | nome/foto para a tela não piscar, preferências (tema, som), rascunhos de UI | apagado, menos tema e som |
| sessionStorage | intenção de chamada (60 s), marca "chaves prontas" | some ao fechar a aba |
| Cache do Service Worker | só arquivos estáticos do próprio site | — (nunca guarda dado de conta nem mídia) |

Se outra aba do app estiver aberta, o Firestore não deixa apagar a cópia
offline naquele momento; a tela de login tenta de novo.

---

## 9. CSRF, CORS e injeção

- **CSRF:** não há cookies de sessão; toda requisição autenticada leva o
  token no cabeçalho `Authorization`, que um site de terceiros não consegue
  pôr numa requisição cruzada. Além disso, endpoints que mudam estado
  recusam `Origin` fora da lista e só aceitam `application/json` (forçando
  pré-verificação CORS).
- **CORS do backend:** lista explícita de origens, sem curinga, sem `null`,
  sem credenciais; origem desconhecida recebe 403.
- **Corpo das requisições:** só JSON, tamanho máximo (413), campos
  desconhecidos recusados, lixo depois do JSON recusado.
- **Injeção:** Firestore não interpreta texto como consulta (os valores vão
  tipados pelo SDK); não há SQL, shell nem template no servidor; caminhos de
  Storage e IDs de conversa são validados por regex (sem `..`).

---

## 10. Logs e auditoria

- Logs em JSON (`log/slog`) no stdout do Render.
- **Nunca** vão para o log: senha, token (nem pedaço), chave privada, conteúdo
  de mensagem, e-mail completo. URLs são registradas sem query string
  (`semConsulta`), porque é lá que costumam aparecer tokens.
- **Eventos de segurança** (memória, últimos 500, com contagem por tipo),
  visíveis em *Painel admin → Eventos de segurança*: `auth_recusada`,
  `auth_bloqueio_ip`, `ws_origem_recusada`, `ws_limite_handshake`,
  `ws_limite_conexoes`, `ws_negado`, `ws_limite`, `ws_quadro_invalido`,
  `ws_quadro_malformado`, `ws_flood`, `ws_abuso`, `http_nao_autenticado`,
  `http_proibido`, `admin_kick`, `admin_status`, `sessoes_revogadas`,
  `csp_violacao`. Eventos repetidos são agregados por minuto.
- Retenção longa: o Render guarda logs por pouco tempo. Para auditoria de
  verdade, envie o stdout para um serviço de logs (Log Streams do Render →
  Datadog, Better Stack, Grafana Loki…) com retenção e alertas.

---

## 11. Segredos e configuração

- Nenhum segredo no front-end nem no repositório. `.gitignore` bloqueia
  `.env`, chaves e JSONs de service account; o build do Netlify publica só
  uma lista explícita de arquivos.
- Backend: `.env.example` lista todas as variáveis. A credencial é
  `FIREBASE_SERVICE_ACCOUNT_JSON` (só tipo `service_account`) no Render.
- **Credencial exposta no passado:** o `firebase-key.json` chegou a ser
  publicado quando a pasta inteira ia para o ar. Pelo registro do incidente
  (25/09/2026), a chave vazada (`cc305ef4…`) e a enviada por chat
  (`2ad949d0…`) foram revogadas, e a de produção (`87c5f764…`) só existe na
  variável do Render. A chave revogada continua no histórico do Git e nos
  deploys antigos do Netlify — sem efeito, porque não vale mais. Mantenha a
  rotina: conferir em *IAM → Contas de serviço → Chaves* que só existe uma
  chave ativa, e trocá-la periodicamente (ex.: a cada 90 dias) ou sempre que
  alguém que teve acesso sair do projeto.
- Nenhuma outra credencial real foi encontrada no código. A `apiKey` do
  `firebase.js` é pública por design — restrinja-a (seção 15).

---

## 12. Banco de dados

- **Menor privilégio:** a service account do backend precisa só de
  `Firebase Authentication Admin` e `Cloud Datastore User`. O papel
  `Storage Object Admin` só é necessário para rodar `cmd/migrar-seguranca`;
  use uma conta separada para isso e remova o papel depois.
- **Criptografia em repouso:** o Google cifra Firestore e Storage em repouso
  por padrão.
- **Backups:** ative o *Point-in-time recovery* (7 dias) e exportações
  agendadas do Firestore para um bucket separado, com retenção e acesso
  restrito:
  `gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14d`.
  **Teste a restauração** num projeto de teste pelo menos uma vez — backup
  que nunca foi restaurado não é backup. Lembre que o backup contém dados
  pessoais (perfis, e-mails em `contas/`) e mensagens não protegidas.
- **Migrações:** `cmd/migrar-seguranca` (seção 14). Não há outra mudança de
  esquema obrigatória.

---

## 13. Dependências

| Dependência | Versão | Situação |
|---|---|---|
| Firebase JS SDK (CDN gstatic) | 10.12.2 | Duas versões principais atrás da atual (12.x). **Não atualizado** nesta fase para não quebrar o app sem teste em navegador real. Recomendado migrar numa fase própria, testando login, Firestore offline, Storage e chamadas. |
| `@hpke/core` + `@hpke/common` (vendor) | 1.9.0 + 1.10.1 | Versão atual; `npm audit`: 0 vulnerabilidades. Build reproduzível (abaixo). |
| Go | 1.26.5 | atual |
| `firebase.google.com/go/v4` | 4.21.0 | atual |
| `github.com/gorilla/websocket` | 1.5.3 | atual |
| `golang.org/x/time` | 0.15.0 | limitadores de taxa |
| Ferramentas de teste das regras (`testes/regras`) | firebase-tools 15.32.0 | `npm audit`: 5 moderadas em dependências transitivas (`uuid` via `gaxios`); só ferramenta de desenvolvimento, não vai para produção. |

`govulncheck` não pôde rodar no ambiente desta auditoria (o banco de
vulnerabilidades do Go estava bloqueado). Rode localmente:
`go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...`.

### Dependências do front-end: como atualizar a biblioteca HPKE

O arquivo `vendor/hpke-1.9.0.js` é gerado assim (e confere com o SHA-256 do
cabeçalho, calculado com fim de linha LF):

```bash
mkdir /tmp/hpke && cd /tmp/hpke && npm init -y
npm install @hpke/core@1.9.0 esbuild@0.25.12
echo 'export { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";' > entrada.js
npx esbuild entrada.js --bundle --format=esm --target=es2020 --legal-comments=inline --outfile=hpke.js
sha256sum hpke.js   # d6f3c8fa…bc05499 para 1.9.0
```

Para uma versão nova: gere o arquivo com outro nome (`hpke-X.Y.Z.js`),
atualize o cabeçalho, o `import` em `e2ee-cripto.js`, a lista do `sw.js` e
rode `node --test "testes/js/*.test.mjs"` (inclui o vetor oficial da RFC 9180).
O `.gitattributes` impede que o Git troque o fim de linha desse arquivo.

---

## 14. Migração dos dados existentes (`cmd/migrar-seguranca`)

Rode **depois** de publicar as regras novas. Padrão: simulação.

```bash
export FIREBASE_SERVICE_ACCOUNT_JSON="$(cat /caminho/fora/do/repo/chave.json)"
go run ./cmd/migrar-seguranca                           # 1) simula e mostra o que faria
go run ./cmd/migrar-seguranca -aplicar -limite 20       # 2) aplica em poucos itens
go run ./cmd/migrar-seguranca -aplicar                  # 3) aplica tudo
go run ./cmd/migrar-seguranca -aplicar -etapas orfaos -apagar-orfaos   # 4) limpa o que sobrou
```

| Etapa | O que faz |
|---|---|
| `uid` | liga perfis antigos (sem `uid`) à conta do Auth pelo e-mail |
| `contas` | cria `contas/{uid}` para quem não tem (fecha o "um perfil por conta" para contas antigas) |
| `email` | remove o e-mail do perfil público (fica em `contas/{uid}`) |
| `foto` | troca o avatar do site de ícones pelo avatar local |
| `midia` | copia fotos/áudios antigos para `midia/…` (privado, sem token), atualiza a mensagem e apaga o original — o que **invalida o link público antigo**. HEIC e arquivos fora do padrão ficam como estão e aparecem nos avisos |
| `tokens` | remove tokens de download de `midia/` (pode rodar periodicamente) |
| `orfaos` | lista/apaga arquivos que nada usa: `imagens/`/`audios/` sem mensagem, mídia de conversas apagadas, avatares substituídos (carência de 24 h) |

Todas as etapas podem ser repetidas. O comando nunca imprime e-mail inteiro,
token nem conteúdo de mensagem. Opções: `-manter-originais` (não apaga o
arquivo antigo), `-limite N`, `-etapas a,b`, `-tempo-maximo 2h`.

---

## 15. Configuração de produção (passo a passo)

1. **Regras:** `firebase deploy --only firestore:rules,storage` (ou colar no
   Console). Na primeira publicação do Storage, o Console pede permissão para
   as regras do Storage lerem o Firestore — aceite (é o que faz a regra de
   participante funcionar).
2. **CORS do bucket** (sem isso a mídia nova não abre):
   `gcloud storage buckets update gs://chat-parameuamor.firebasestorage.app --cors-file=cors.json`
   (ou `gsutil cors set cors.json gs://chat-parameuamor.firebasestorage.app`).
   Para testar em `localhost`, acrescente a origem num arquivo separado — não
   deixe localhost em produção.
3. **Backend (Render):** variáveis do `.env.example`, com
   `APP_ENV=production`, `REQUIRE_HTTPS=true`, `TRUST_PROXY_HEADERS=true`.
   Publique o backend **antes** do front (o front novo usa
   `/sessoes/revogar`, `/admin/status` e o protocolo v3; o antigo continua
   funcionando contra o backend novo).
4. **Front (Netlify):** o build já copia `vendor/`. Confira os headers com
   `curl -I https://sinexchat.netlify.app/` e em securityheaders.com.
5. **Migração:** seção 14.
6. **Firebase Authentication (Console → Authentication → Configurações):**
   - **Política de senha** (*Password policy*): mínimo 8 (ou mais), exigida
     no cadastro e na troca de senha — o mínimo do `cadastro.js` é só
     conveniência, quem garante é o Firebase;
   - **Proteção contra enumeração de e-mail** (*Email enumeration
     protection*): ligada;
   - **Cota de cadastro** (*Sign-up quota*): limite de contas novas por IP;
   - **Domínios autorizados**: só os de produção (tire `localhost` se não
     usar);
   - MFA (Identity Platform) ao menos para contas admin.
7. **App Check** (reCAPTCHA Enterprise ou v3) para Firestore, Storage e Auth:
   primeiro em modo de monitoramento, depois *Enforce*. Reduz scripts
   automatizados usando a configuração pública do app.
8. **Chave de API** (Google Cloud → Credenciais): restrição por *HTTP
   referrer* (`https://sinexchat.netlify.app/*`,
   `https://chat-parameuamor.web.app/*`, `https://chat-parameuamor.firebaseapp.com/*`)
   e por API (Identity Toolkit, Token Service, Firestore, Storage).
9. **Orçamento e alertas** de cobrança no Google Cloud (defesa contra abuso
   de custo).
10. **Backups:** seção 12.
11. **Service account antiga:** seção 11.

---

## 16. Testes

| Suíte | Como rodar | Cobertura |
|---|---|---|
| Backend Go (unidade + integração com servidor HTTP/WebSocket real e Firebase simulado) | `go test -race ./...` | handshake, token inválido/revogado/banido, origem, limites, IDOR em conversas, chatId manipulado, `from` forjado, texto descartado, grupos, WebRTC, flood, abuso, orçamento de presença, tetos de conexão, 401/403/429/405/413, CORS, headers, CSP report, endpoints admin |
| Migração (funções puras) | `go test ./cmd/...` | links antigos, travessia de caminho, formato novo, detecção de tipo, máscara de e-mail |
| Criptografia e mídia (Node ≥ 22) | `node --test "testes/js/*.test.mjs"` | vetor oficial RFC 9180, ida e volta, adulteração (conteúdo, AAD, assinatura, remetente, conversa), aparelho sem chave, arquivo cifrado, número de segurança, magic bytes, arquivo disfarçado, caminhos |
| Navegador (Chromium, Playwright) | `cd testes/navegador && npm ci && npx playwright install chromium && npm test` | todas as páginas com a CSP e os headers de produção (erro de módulo, import quebrado, violação de CSP, 404), aviso sem texto livre, chamada sem intenção recusada; no navegador: chave privada não extraível no IndexedDB, ida e volta cifrada, envelope preso à conversa, EXIF/GPS removido, arquivo disfarçado e áudio grande recusados, handler inline bloqueado pela CSP, intenção de chamada de uso único |
| Regras do Firestore e do Storage (emuladores oficiais; Java 21+) | `cd testes/regras && npm ci && npm test` | leitura/escrita sem login, IDOR, cadastro, perfis, admin, contas, seguidores, chaves públicas, criação de conversa/grupo, resumo, recibos, E2EE, apagar, mensagens forjadas, sistema, mídia, conversa protegida, reações, upload/download por participante, tipos e tamanhos, avatares, caminhos antigos |

**Rode a suíte de regras antes de publicar qualquer mudança em
`firestore.rules`/`storage.rules`.**

---

## 17. Riscos residuais e próximos passos

1. **Janela de até 1 h** no Firestore após banir/revogar (seção 4).
2. **E2EE em navegador** depende da integridade do JavaScript entregue.
   Mitigações possíveis: publicar hashes das versões, Subresource Integrity
   para o SDK do Firebase (hoje carregado por `import` ES, que não aceita
   `integrity` sem import maps), empacotar o SDK junto do app (remove
   `gstatic.com` do `script-src`), e um app instalável assinado no futuro.
3. **Sem sigilo futuro e sem backup de chaves** (seção 7).
4. **Chamadas:** assinar as impressões DTLS do SDP com a chave do aparelho
   para impedir que um backend comprometido fique no meio.
5. **Presença pública** para quem está logado: criar preferência "mostrar
   visto por último" e respeitá-la no backend.
6. **Limites em memória:** com mais de uma instância do backend, mover
   limitadores e cache de autorização para Redis.
7. **Firebase JS 10.12.2**: planejar a atualização (seção 13).
8. **Trusted Types:** hoje todo `innerHTML` recebe constantes; ativar
   `require-trusted-types-for 'script'` (primeiro em Report-Only) travaria
   isso no navegador.
9. **Mídia antiga em HEIC** não é convertida pela migração: fica com o link
   antigo até alguém reenviar.

### Limitações da arquitetura (e a arquitetura correta)

Estas proteções pedidas **não foram implementadas de forma parcial ou falsa**,
porque a arquitetura atual (navegador falando direto com Firestore/Storage)
não permite fazê-las direito:

**a) Limite de taxa para mensagens, uploads e downloads no Firestore/Storage.**
As regras não têm contador: uma conta autenticada consegue gravar mensagens e
subir arquivos o mais rápido que o Firebase deixar (o backend só limita o que
passa por ele — WebSocket e endpoints HTTP). Hoje a defesa é: App Check
(bloqueia clientes que não são o app), orçamento/alertas de cobrança e
tetos de tamanho nas regras.
*Arquitetura correta:* uploads e envio de mensagem por um endpoint do backend
(ou Cloud Functions) com limite por uid — o backend grava no Firestore com o
Admin SDK e emite, para mídia, uma **URL assinada V4 de upload** com validade
curta, tipo e tamanho fixos; as regras passam a negar `create` direto do
cliente em `mensagens` e `midia/`.
*Arquivos:* `mensagens.js` (`enviarMensagemEmChat`), `midia.js`
(`enviarMidia`, `enviarMidiaCifrada`), `main.go` (novas rotas),
`firestore.rules` e `storage.rules` (negar `create` direto).
Alternativa intermediária, só com regras: documento `limites/{uid}` gravado no
mesmo lote de cada mensagem, com a regra exigindo intervalo mínimo desde a
última escrita — custa uma escrita extra por mensagem e precisa ser testada no
emulador antes de ir ao ar.

**b) Refresh token rotativo e cookie `HttpOnly`.** O Firebase Auth guarda o
refresh token no IndexedDB (acessível a JavaScript da página) e não o rotaciona
a cada uso. A defesa hoje é impedir XSS (CSP estrita, sem `innerHTML` com
dado), revogar sessões ("sair de todos", banimento) e o backend checar
revogação em cada token.
*Arquitetura correta:* *session cookies* do Admin SDK (`createSessionCookie`,
`HttpOnly; Secure; SameSite=Strict`) com o backend como intermediário de
todas as leituras/escritas — o que tira o Firestore do navegador. É uma
reescrita da camada de dados (`core.js`, `mensagens.js`, `inbox.js`,
`chat.js`, `perfil.js`, `explorar.js`, `grupo-novo.js`, `admin.js` e um
backend de API), por isso não foi feita nesta fase.

**c) Log de login, logout, troca de senha e recuperação.** Esses eventos
acontecem entre o navegador e o Google, sem passar pelo backend. Para
registrá-los: fazer o upgrade para **Identity Platform** e ligar os *audit
logs* de autenticação no Cloud Logging; para uploads e downloads, ligar os
*Data Access audit logs* do Cloud Storage. O backend já registra o que passa
por ele (seção 10).

## 18. Recomendações para pentest / auditoria futura

- Rodar a suíte de regras e tentar variações que ela não cobre (campos
  aninhados, tipos inesperados, consultas com filtros combinados).
- Testar o WebSocket com cliente próprio: quadros malformados, grandes,
  Unicode estranho, reconexões em massa, muitas abas, tokens expirando no
  meio da conexão.
- Testar CORS e CSP em navegadores reais (Chrome, Safari iOS, Firefox) —
  inclusive o recebimento dos relatórios de CSP.
- Revisar o fluxo E2EE com outra pessoa: troca de aparelho, revogação,
  aviso de troca de chave, número de segurança, mensagens de aparelho
  removido.
- Tentar abuso de custo (leituras/escritas em massa com a config pública) com
  e sem App Check.
- Revisar IAM do projeto (quem é Owner/Editor, chaves de service account
  ativas) e os logs de acesso do Google Cloud.

---

## Adendo (02/10/2026): mídia no Cloudinary

O projeto Firebase está no plano gratuito, que não inclui Storage. Fotos de
perfil e mídia das conversas passaram para o Cloudinary (`cloudinary.js`,
`midia_http.go`). O que muda em relação ao que este documento descreve:

- **Envio:** sempre assinado pelo backend (`POST /midia/assinar`, com ID
  token). O servidor sorteia o nome do arquivo, só assina para a pasta da
  própria conta (`avatares/{uid}/…`) ou de uma conversa de que a pessoa
  participa (`midia/{chatId}/{uid}/…`), e não permite sobrescrever. O segredo
  da conta fica só na variável `CLOUDINARY_API_SECRET` do Render.
- **Leitura — limitação conhecida:** o Cloudinary entrega por link. A mídia
  de conversa comum pode ser aberta, sem login, por quem tiver o link
  (caminho com UUID aleatório, que só aparece dentro da conversa). Deixou de
  valer a garantia de "só participante baixa" das regras do Storage.
- **Conversa protegida (E2EE):** o arquivo continua subindo cifrado; o link
  só entrega bytes ilegíveis.
- **Sem efeito:** `storage.rules`, `cors.json` e a etapa de mídia da
  migração (seção 15). A CSP ganhou `res.cloudinary.com` e
  `api.cloudinary.com`.
- **Limite:** 10 MB por arquivo (plano gratuito do Cloudinary).
- **Apagar:** apagar a conversa não apaga os arquivos no Cloudinary; isso
  exigiria uma rota de exclusão no backend, ainda não feita.
