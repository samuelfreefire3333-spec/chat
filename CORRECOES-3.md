# Terceira rodada — por que o "digitando" continuou infinito

A segunda rodada corrigiu a lógica do indicador, e a lógica estava certa: com
`digitandoAte` conferido por relógio, não existe caminho no `chat.js` em que a
bolha sobreviva mais de 3 segundos sem chegar um quadro `digitando` novo.

Mesmo assim o bug continuou aparecendo **para os outros usuários**. A causa não
estava na lógica — estava na entrega.

---

## 1. O Service Worker pré-cacheava a versão ANTIGA (`sw.js` + `firebase.json`)

Duas linhas se combinavam contra a publicação:

```js
cache.add(url)                                              // sw.js, install
```
```json
{ "source": "**/*.@(js|css)",
  "headers": [{ "key": "Cache-Control", "value": "public, max-age=3600" }] }
```

`cache.add(url)` faz um `fetch` comum, e um `fetch` comum **passa pelo cache
HTTP do navegador**. Com `max-age=3600` nos js/css, quem tinha baixado o
`chat.js` havia menos de uma hora instalava o Service Worker novo e enchia o
cache `v5` com o **arquivo velho**.

O handler de `fetch` é *stale-while-revalidate*:

```js
return emCache || (await daRede) || Response.error();
```

Ele devolve o que está no cache na hora e só atualiza por trás — ou seja, ainda
era preciso mais um carregamento depois disso. Resultado prático: quem já usava
o app ficava com o bug já corrigido na tela por mais de uma hora, enquanto quem
deu recarregamento forçado (você) via tudo funcionando.

**Corrigido:**

- `sw.js` → `cache.add(new Request(url, { cache: "reload" }))`, que ignora o
  cache HTTP e busca da rede de verdade.
- `firebase.json` → js/css passam a `no-cache`. O arquivo continua guardado,
  mas é revalidado a cada carregamento (resposta 304, barata). Sem nome
  versionado nos arquivos, `max-age` cego é o que atrasa correção.
- `sw.js` → `VERSAO` subiu para `v6`.

## 2. O backend Go precisa de redeploy

`parou_digitando` está em `tiposPermitidos` no `hub.go` **local**. Se o serviço
no Render ainda roda o binário antigo, o servidor descarta esse aviso em
silêncio e o indicador volta a depender só do relógio de 3 segundos. Publicar
só o Hosting não resolve esta metade.

---

## Falhas que sobraram no `chat.js` (corrigidas nesta rodada)

### Cabeçalho preso em "digitando…" depois da mensagem chegar

`msg.type === "chat"` chamava `esconderDigitando()`, que só apaga a bolha e
deixa `digitandoAte` no futuro. Como `aplicarStatusDoCabecalho()` lê essa
variável, o cabeçalho seguia escrito "digitando…" por até 3 s — e o
`mostrarOnline()` da linha seguinte não conseguia sobrescrever. Agora chama
`pararDeMostrarDigitando()`.

### Volta do cache de retorno (bfcache)

Os timers ficam congelados enquanto a página está no bfcache, e o Safari do
iPhone **não dispara `visibilitychange`** ao voltar pelo histórico. Um
"digitando…" de minutos antes reaparecia aceso na tela. O `pageshow` agora
chama `conferirDigitando()` junto com `escutarConversa()`.

### Sair da conversa não avisava nada

`avisarQueParei()` só era chamado ao apagar o campo, ao sair dele e ao enviar.
Fechar a aba ou voltar para a caixa de entrada no meio de uma frase deixava a
outra ponta esperando o relógio. O `pagehide` agora avisa antes de o socket
cair.

### Digitação privada acendendo a bolha de um grupo

O app não anuncia digitação em grupo (ver `aoDigitar`), mas o receptor não
filtrava: um `digitando` de alguém que também é membro do grupo aberto — e que
estava digitando numa conversa **privada** com você — acendia a bolha na tela
do grupo. Agora `digitando` e `parou_digitando` são ignorados em `modoGrupo`.

---

## Para publicar

```bash
firebase deploy --only hosting
```

E, no Render, **redeploy do backend Go** — sem ele o tipo `parou_digitando`
continua sendo descartado.

## Para conferir que chegou

Num navegador de usuário comum (sem recarregamento forçado), DevTools →
Application → Cache Storage → `sinex-estatico-v6`, e procure `VALIDADE_DIGITANDO`
dentro do `chat.js` servido. Se o cache ainda for `v5`, o Service Worker novo
não ativou.
