# Segunda rodada — "digitando" preso e chamada flutuante

## 1. "Fulano está digitando..." que nunca sumia

Eram **duas** causas somadas, e as duas precisavam ir embora.

### Causa A — a fila de reenvio guardava avisos de digitação (`radar.js`)

`Radar.emit()` guardava até 100 mensagens quando o WebSocket estava fora do ar
e despejava tudo de uma vez ao reconectar. O backend está no plano gratuito do
Render, que dorme o tempo todo — então a fila enchia de avisos de digitação e,
quando o servidor acordava, o outro lado recebia uma enxurrada de "estou
digitando" de coisas que tinham acontecido minutos antes.

Agora existe uma lista de tipos efêmeros (`digitando`, `parou_digitando`,
`status_check`, `webrtc`, `chamada`, `cancelar_chamada`) que **nunca** entram
na fila. Só valem no instante em que acontecem. Mensagem de verdade (`chat`)
continua sendo guardada normalmente.

### Causa B — o timer de esconder era congelado pelo navegador (`chat.js`)

O indicador sumia com um `setTimeout(esconderDigitando, 2500)`. O navegador
**congela os timers** de uma aba em segundo plano ou no cache de retorno.
Bastava um aviso chegar pouco antes de você minimizar o app: o timer nunca
disparava e o "digitando..." ficava colado na tela por tempo indeterminado.

Agora o controle é por relógio (`digitandoAte = agora + 3s`), conferido por um
intervalo curto e também a cada volta para o app (`visibilitychange`). Timer
congelado não consegue mais deixar nada preso.

### De quebra

- **Aviso de "parei de digitar"**: antes só existia "estou digitando" e a outra
  ponta adivinhava pelo tempo. Agora o app avisa quando você apaga tudo, sai do
  campo ou envia a mensagem. Tipo novo `parou_digitando` liberado no `hub.go`.
- **Perder a conexão apaga o indicador**: sem WebSocket não há como saber se a
  pessoa ainda está digitando; manter aceso seria inventar informação.
- **Dois WebSockets abertos ao mesmo tempo** (`radar.js`): `conectar()` só
  marcava `conectando = true` **depois** de um `await`. Duas chamadas quase
  simultâneas (voltar para a aba + evento "online", por exemplo) passavam as
  duas pela checagem e abriam duas conexões, cada uma despachando os mesmos
  eventos para a página — tudo chegava duplicado. A marcação subiu para antes
  do `await`, e um socket substituído tem os handlers desligados.

---

## 2. Chamada flutuante (Picture-in-Picture)

O problema de fundo: uma conexão WebRTC vive no contexto JavaScript de **uma**
página. Navegar para outra tela destrói a conexão — por isso sair de
`chamada.html` derrubava a chamada na hora.

A solução tem três camadas:

### Camada 1 — a chamada roda em janela própria

`chat.js` e `radar.js` agora abrem `chamada.html` com `window.open` e um nome
fixo (`sinex-chamada`), em vez de navegar na aba atual. A janela principal fica
livre para ir para a caixa de entrada, o perfil, as configurações — a chamada
continua intacta na janela dela. Se o navegador bloquear o pop-up, o
comportamento antigo (navegar na própria aba) continua valendo como reserva.

### Camada 2 — barra de chamada em todas as telas

Módulo novo: **`chamada-flutuante.js`**, carregado pelo `radar.js` (que já está
em todas as páginas). Enquanto houver chamada viva, aparece no topo de qualquer
tela uma barra verde com a foto, o nome, o cronômetro e os botões **Voltar** e
**Encerrar**.

A conversa entre as janelas passa por `BroadcastChannel`, com `localStorage` de
reserva para quem acabou de abrir uma página. A janela da chamada publica um
sinal de vida a cada 3 s — se ela for fechada no "x", a barra some sozinha em
poucos segundos, sem ficar um fantasma na tela.

### Camada 3 — Picture-in-Picture de verdade

Botão novo na barra de controles da chamada. Dois caminhos, do melhor para o
mais compatível:

1. **Document Picture-in-Picture** — leva a interface **inteira** (vídeo + mudo
   + câmera + desligar) para uma janela do sistema operacional, que flutua por
   cima do navegador e de qualquer outro programa. Chrome e Edge no computador.
2. **PiP clássico do `<video>`** — só a imagem, mas funciona em quase tudo,
   incluindo Android e Safari.

Em **chamada de voz** não existe faixa de vídeo e o PiP exige uma: o app desenha
o nome e o cronômetro num canvas e usa o fluxo dele, então a janelinha funciona
também nas ligações só de áudio.

---

## Limites honestos

- **No computador funciona completo**: janela separada + PiP do sistema, que
  flutua sobre qualquer programa.
- **No celular**, `window.open` abre uma **aba** nova, não uma janela flutuante.
  A chamada sobrevive enquanto a aba estiver viva em segundo plano, e a barra
  em todas as telas leva de volta com um toque. O PiP do vídeo flutua sobre
  outros aplicativos no Android; no iOS o Safari só faz PiP de vídeo.
- **Sem TURN a chamada continua não conectando em parte das redes móveis.**
  Isso é independente de tudo acima — o PiP flutua uma chamada que conectou; ele
  não faz a conexão acontecer.

---

## Para publicar

```bash
firebase deploy --only hosting
```

O `sw.js` subiu para `v4` (arquivo novo no pré-cache), então quem já tem o app
instalado recebe a atualização. O **backend Go precisa de redeploy** para o tipo
`parou_digitando` ser aceito — sem isso o servidor descarta esse aviso em
silêncio e o indicador volta a depender só do tempo.
