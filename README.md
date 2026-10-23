# 🎬 Sinexflix

[![Versão](https://img.shields.io/badge/vers%C3%A3o-3.1.0-ff4060?style=flat-square)](#)
[![Web App PWA](https://img.shields.io/badge/PWA-samuelfreefire3333--spec.github.io-ffb030?style=flat-square)](https://samuelfreefire3333-spec.github.io/sinexflix/)
[![Kodi](https://img.shields.io/badge/Kodi-19%2B%20(Matrix%20%7C%20Nexus%20%7C%20Omega)-17b2e7?style=flat-square)](#instalação-no-kodi)
[![Licença](https://img.shields.io/badge/licen%C3%A7a-GPL--3.0-3ddc84?style=flat-square)](LICENSE)

**Descubra filmes e séries, saiba onde assistir no Brasil, veja clássicos completos de domínio público e canais abertos de TV ao vivo — direto no navegador (PWA) ou no Kodi.**

---

## ✨ Recursos Principais

| Recurso | Web App (PWA) | Add-on para Kodi (`v3.1.0`) |
| :--- | :---: | :---: |
| **Catálogo de Filmes e Séries** (Populares, Mais Bem Avaliados, Ano e Gênero via *Cinemeta*) | ✅ | ✅ |
| **Onde Assistir no Brasil** (Disponibilidade *JustWatch / TMDB* + atalhos diretos sem chave) | ✅ | ✅ |
| **Clássicos Completos Grátis** (Acervo público do *Internet Archive* com suporte a múltiplas partes e legendas `.srt`/`.vtt`) | ✅ | ✅ |
| **Player Avançado Sem Anúncios** (Velocidade `0.75x–2x`, Qualidade `Auto/1080p/720p/480p`, `±10s`, `PiP`, Legendas e *Continuar de onde parou*) | ✅ | ✅ *(Player nativo do Kodi)* |
| **TV Aberta ao Vivo** (Canais públicos do Brasil via *iptv-org*, busca instantânea, favoritos `★` e verificação automática de sinal) | ✅ | ✅ |
| **Minha Lista & Calendário de Episódios** (Barra de progresso nos cartões, próximos episódios e sincronização `.strm`/`.nfo` com a biblioteca do Kodi) | ✅ | ✅ |
| **Modo Infantil com Senha** (Filtro seguro para animação, família e desenhos clássicos protegido por PIN `SHA-256`) | ✅ | ✅ |
| **Backup Portátil (`.json`) & Funcionamento Offline** (Service Worker `sinexflix-v4` + catálogo de reserva local) | ✅ | ✅ |

---

## 🌐 1. Como Usar o Web App (Celular, Computador ou Smart TV)

Acesse diretamente pelo navegador:
👉 **[https://samuelfreefire3333-spec.github.io/sinexflix/](https://samuelfreefire3333-spec.github.io/sinexflix/)**

### Instalar como Aplicativo (PWA)
* **Android (Chrome / Edge / Brave):** Toque no menu `⋮` (ou no botão em **Ajustes → Instalar o Sinexflix**) e selecione **Instalar aplicativo** / **Adicionar à tela inicial**.
* **iPhone / iPad (Safari):** Toque no botão **Compartilhar** e escolha **Adicionar à Tela de Início**.
* **Computador (Chrome / Edge):** Clique no ícone de instalação na barra de endereços para abrir o Sinexflix em janela dedicada.

---

## 📺 2. Instalação no Kodi (`Kodi 19, 20 e 21+`)

Você pode instalar o **Repositório do Sinexflix** para receber atualizações automáticas:

### Passo a passo pelo Gerenciador de Arquivos do Kodi
1. No Kodi, abra **Configurações (⚙️) → Sistema → Add-ons** e ative **Fontes desconhecidas**.
2. Volte para **Configurações (⚙️) → Gerenciador de arquivos → Adicionar fonte**.
3. Digite exatamente o endereço abaixo como caminho da fonte:
   ```text
   https://samuelfreefire3333-spec.github.io/sinexflix/
   ```
4. Dê o nome **`Sinexflix`** e confirme em **OK**.
5. Vá em **Add-ons → Instalar a partir de um arquivo ZIP**, escolha **`Sinexflix`** e instale:
   * `repository.sinexflix-1.0.0.zip`
6. Em seguida, clique em **Instalar do repositório → Sinexflix Repository → Add-ons de vídeo → Sinexflix → Instalar**.

> **Download direto (opcional):** Você também pode baixar [`repository.sinexflix-1.0.0.zip`](repository.sinexflix-1.0.0.zip) ou [`plugin.video.sinexflix-3.1.0.zip`](plugin.video.sinexflix/plugin.video.sinexflix-3.1.0.zip) diretamente deste repositório.

---

## 🗂️ Estrutura do Repositório

```text
sinexflix/
├── index.html                  # Entrada principal do Web App (PWA)
├── app.css                     # Estilos responsivos (Mobile, Tablet, Desktop e TV Box)
├── app.js                      # Lógica do Web App (Catálogo, Player, TV ao Vivo, Minha Lista)
├── sw.js                       # Service Worker (cache offline da interface e capas)
├── manifest.webmanifest        # Manifesto de instalação PWA
├── app/                        # Espelho sincronizado do Web App para sub-rotas (/app/)
├── addons.xml                  # Manifesto de versões do repositório Kodi
├── addons.xml.md5              # Hash MD5 de verificação de atualização do Kodi
├── repository.sinexflix/       # Pacote do repositório oficial para Kodi
├── plugin.video.sinexflix/     # Pacotes distribuíveis (.zip) do add-on para Kodi
├── patches/                    # Histórico de patches evolutivos (fase1.diff a fase4.diff)
├── scripts/
│   └── sync_and_verify.py      # Script de sincronização (/ -> /app/), cálculo de MD5 e validação
└── .github/workflows/
    └── ci-deploy.yml           # Integração contínua (validação JS/Python + sincronização automática)
```

---

## 🛠️ Manutenção e Desenvolvimento

Para validar o código, sincronizar a pasta `/app/` com a raiz e atualizar automaticamente o hash `addons.xml.md5`, execute na raiz do projeto:

```bash
python3 scripts/sync_and_verify.py
```

O workflow do GitHub Actions (`.github/workflows/ci-deploy.yml`) também executa essa verificação automaticamente a cada `push` na branch `main`.

---

## 📄 Licença e Fontes de Dados

Distribuído sob a licença **GNU General Public License v3.0 (`GPL-3.0-only`)**. Veja o arquivo [`LICENSE`](LICENSE) para mais detalhes.

* **Catálogo e Metadados:** [Cinemeta](https://v3-cinemeta.strem.io) & [TMDB](https://www.themoviedb.org/)
* **Disponibilidade em Streaming ("Onde Assistir"):** [JustWatch](https://www.justwatch.com/br) (via API do TMDB)
* **Filmes e Desenhos Clássicos em Domínio Público:** [Internet Archive](https://archive.org/)
* **Lista de Canais Abertos e Públicos:** [iptv-org](https://github.com/iptv-org/iptv)
