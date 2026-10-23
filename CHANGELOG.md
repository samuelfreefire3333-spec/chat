# Changelog — Sinexflix

Todas as mudanças relevantes do **Sinexflix** (Web App PWA e Add-on para Kodi) estão documentadas neste arquivo.

## [3.1.0] — 2026-10-23 (Fase 4 — Edição Profissional)

### Adicionado
* **Layout Responsivo Desktop, TV Box e Mobile (`app.css`, `index.html`):** Barra de navegação superior integrada para telas grandes (`>= 860px`), fichas de detalhes em modal centralizado e efeitos de foco/hover para controle remoto e mouse.
* **Pool Multi-Servidor com Saúde Automática (`TRAILER_SERVERS` + `serverHealth`):** Múltiplas instâncias Piped e Invidious com ordenação automática por latência, *cooldown* de 10 minutos para servidores instáveis e suporte a URLs personalizadas em **Ajustes**.
* **Reprodução Completa de Clássicos Multi-Partes (`openWatch`):** Clássicos do Internet Archive divididos em múltiplos arquivos agora exibem seletores `Parte 1/N`, `Parte 2/N` no player e avançam automaticamente ao fim de cada parte.
* **Controles Extras no Player (`mountControls`):** Botões de toque `⏪ 10s` e `10s ⏩`, seletor para múltiplas faixas de legenda (`<select data-pc="cc-sel">`) e limpeza automática de `Blob URLs`.
* **Onde Assistir sem Fricção (`renderProviders`):** Atalhos diretos de 1 clique para *JustWatch Brasil*, *Google Assistir* e *Internet Archive* mesmo sem chave do TMDB configurada; ícones clicáveis quando a chave está ativa.
* **TV ao Vivo com Busca, Favoritos (`★`) e Troca Rápida:** Filtro por nome em tempo real, botão de favoritar canais (`★`) nos cartões e no player, aba `★ Favoritos` e botões `⏮ Canal anterior` / `Próximo canal ⏭`.
* **Barras de Progresso nos Cartões e Backup Portátil (`.json`):** Exibição visual da porcentagem assistida e último episódio (`T1·E2`) nos cartões, além de exportação/importação completa de dados em **Ajustes**.
* **Add-on Kodi `v3.1.0` (`plugin.video.sinexflix`):** Episódios de séries agora são clicáveis (`episode_play` com busca no acervo público de TV e provedores), priorização de legendas em português em `archive.py`, filtro `PAY_TV` + `LIVE_SEED` em `live.py` e correção de abertura de filmes/séries em *Assistidos recentemente*.
* **Infraestrutura do Repositório:** Adicionados `README.md`, `CHANGELOG.md`, `LICENSE` (`GPL-3.0`), `.gitignore`, `scripts/sync_and_verify.py` e workflow `.github/workflows/ci-deploy.yml`.

### Corrigido
* Restauração das regras CSS da Fase 2 (`.pc-bar`, `.pc-btn`, `.pc-sel`, `.pc-resume`, `.sr`) na raiz `app.css` que haviam sido sobrescritas na Fase 3.
* Sincronização integral entre os arquivos da raiz (`/`) e a subpasta `/app/`.
* Proteção de `history.pushState` / `history.replaceState` em WebViews e iframes restritos e carregamento não-bloqueante de fontes externas.

---

## [3.0.0] — 2026-10-20 (Fases 1, 2 e 3)

### Adicionado
* **Fase 3:** Botão *Assistir* unificado com busca automática no Internet Archive e canais verificados do YouTube, metadados e episódios em português via TMDB.
* **Fase 2:** Barra de controles de velocidade, qualidade, legendas `.srt`/`.vtt` convertidas em tempo real para `WEBVTT`, Picture-in-Picture e *Continuar de onde parou*.
* **Fase 1:** Resolução de trailers sem anúncio via Piped/Invidious com abertura instantânea do player.
* **Kodi Add-on v3.0.0:** Integração *Onde Assistir* (TMDB/JustWatch), modo infantil com senha fora das configurações, teste de canais ao vivo e sincronização de clássicos com a biblioteca do Kodi.
