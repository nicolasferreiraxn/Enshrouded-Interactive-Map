<p align="center">
  <img src=".github/capa.png" alt="Mapa Interativo Enshrouded" width="100%">
</p>

<h1 align="center">Mapa Interativo Enshrouded</h1>

<p align="center">
  <b>O mapa do Enshrouded que sabe o que está acontecendo no seu jogo — agora.</b><br>
  Sua posição, seus amigos e tudo o que você já fez, ao vivo, no segundo monitor.
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/nicolasferreiraxn/Enshrouded-Interactive-Map?style=for-the-badge&label=baixar&color=d4a537" alt="Baixar"></a>
  <a href="../../actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/nicolasferreiraxn/Enshrouded-Interactive-Map/build.yml?style=for-the-badge&label=build" alt="Build"></a>
  <img src="https://img.shields.io/badge/Enshrouded-1.0-8b3fd1?style=for-the-badge" alt="Enshrouded 1.0">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-2b6cb0?style=for-the-badge&logo=windows" alt="Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/licença-MIT-3c9d5d?style=for-the-badge" alt="MIT"></a>
</p>

<p align="center">
  🇧🇷 Português · 🇺🇸 <a href="README.md">English</a> · 🇪🇸 Español · 🇩🇪 Deutsch · 🇨🇳 简体中文
</p>

---

## 🔥 De onde veio

Procurei mapas interativos do Enshrouded e nenhum me agradou. Então fiz o meu.

No começo era só um mapa mostrando onde estava cada coisa, com o visual do mapa do jogo. Jogando com os amigos
no nosso servidor, fui acrescentando o que fazia falta: a minha posição em tempo real, saber o que já tinha sido
feito — o baú que um amigo abriu, a planta colhida, a porta secreta usada —, os amigos no mapa, as criaturas
vivas, os pins sincronizados com o jogo.

A ideia é simples: **o jogo já sabe tudo isso**, porque precisa saber para desenhar o mundo. O mapa só confere
cada marcador na memória e tira o que não existe mais.

## ✨ O que ele faz

| | |
|---|---|
| 🗺️ **O mesmo mapa da tecla M** | relevo, isolinhas e névoa, desenhados com o shader do próprio jogo |
| 🧭 **Você em tempo real** | posição e direção, sem precisar abrir o mapa do jogo |
| 👥 **Seus amigos** | todo mundo do servidor no mapa, com nome |
| ✅ **Some o que já foi feito** | baús abertos, itens pegos, plantas colhidas, botões, barreiras, portas trancadas e secretas |
| 🐺 **Criaturas vivas** | na posição real, com a vida do alvo ao vivo |
| ⛏️ **Minério esgotado** | o node sai do mapa quando você termina de minerar |
| 📍 **Pins sincronizados** | criar, apagar ou renomear no app muda no mapa do jogo — e vice-versa |
| 🔎 **Busca inteligente** | ache qualquer item e veja quem dropa; **Meu filtro** mostra só o que você está caçando |
| 🌍 **5 idiomas** | com os nomes **oficiais** do jogo em cada um |
| 🧵 **Rota e atalhos** | rota até qualquer ponto; **F8** esconde o ponto mais perto |

## 🚀 Começando

1. Baixe o `.zip` na página de **[Releases](../../releases/latest)** e extraia.
2. Abra o **`Mapa Interactive Enshrouded.exe`** com o jogo aberto.
3. Pronto — em poucos segundos ele acha você no mapa.

> 💡 Funciona melhor num segundo monitor, com o jogo em **janela sem bordas**.

**Requisitos:** Windows 10/11 · Enshrouded 1.0 (Steam). Testado em outubro de 2026 — uma atualização do jogo
pode quebrar partes até sair versão nova.

**Privacidade:** nada sai da sua máquina. Sem internet, sem telemetria, sem conta.

## ⚙️ Como funciona

<details>
<summary><b>Leitura da memória</b> (o mapa só lê)</summary>
<br>

O exe abre o jogo com `PROCESS_VM_READ` e lê com `ReadProcessMemory`:

| dado | origem |
|---|---|
| posição e câmera | endereços que o app procura e valida sozinho ao abrir — costuma sobreviver a atualizações |
| baús, itens, plantas | entidades carregadas em volta de você (~95 m); item fixo que sumiu = pego |
| botões, barreiras, portas | estado de alternância, trava e interação |
| criaturas | posição e vida; spawn sem criatura viva sai do mapa |
| minério | blocos de terreno (cavados + originais); esgotado = nenhum grupo de 6+ blocos |
| histórias lidas, névoa | o seu save local (`.ksd`), só leitura |

O estado é lembrado depois que você se afasta, então nada volta a aparecer à toa.
</details>

<details>
<summary><b>Pins sincronizados</b> (a única parte que escreve no jogo)</summary>
<br>

Para criar marcadores no mapa do jogo, o exe carrega uma DLL embutida no processo do jogo
(`LoadLibraryW` via `CreateRemoteThread`). Ela acha as funções de marcador do próprio jogo **por padrão de bytes**
— se o padrão não bater exatamente uma vez, ela não faz nada — e as chama na thread do jogo, recebendo os pedidos
por um pipe local. Os pins ficam salvos no seu personagem como qualquer marcador.
</details>

## 🌍 Idiomas

| texto | origem | arquivo |
|---|---|---|
| nomes do jogo (itens, criaturas, missões…) | textos **oficiais** do jogo | `app/public/lang/<idioma>.json` |
| interface (botões, menus, dicas) | tradução nossa — correções são bem-vindas | `app/src/i18n/<idioma>.json` |

**Quer o mapa no seu idioma?** Copie `app/src/i18n/en.json` para `<código>.json`, traduza os valores (sem mudar
as chaves), adicione o idioma em `app/src/i18n.js` e abra um pull request. Os nomes do jogo a gente gera a partir
dos textos oficiais.

## 🛠️ Compilando

Os releases são compilados pelo **GitHub Actions** a partir deste repositório, com
[log público](../../actions/workflows/build.yml) — dá para conferir que o binário saiu deste código.

Localmente (Node 20+, Rust stable, Windows): rode `compilar.bat`.

<details>
<summary>Onde fica cada coisa</summary>
<br>

| pasta | conteúdo |
|---|---|
| `app/src` | interface (React + Leaflet); o mapa em WebGL2 fica em `gamemap.js` |
| `app/src-tauri/src` | `tracker.rs` (posição), `live.rs` (estado ao vivo), `terreno.rs` (minério), `injetor.rs` (pins) |
| `injector/marcador` | a DLL dos pins (compilada e embutida no exe automaticamente) |
| `app/public` | dados prontos: marcadores, ícones, tiles |
</details>

## ❤️ Créditos

- **Keen Games** — pelo Enshrouded. Nomes do jogo, shader e texturas do mapa vêm dos arquivos do jogo.
- **[kfc-parser](https://github.com/Brabb3l/kfc-parser)**, do brabb3l — usado para ler os recursos do jogo.
- E aos amigos do servidor, que testaram cada versão no meio das partidas.

## 🧩 Da mesma família

| | |
|---|---|
| 💾 **[Enshrouded Save Editor](https://github.com/nicolasferreiraxn/Enshrouded-Save-Editor)** | edite o personagem com uma interface que parece o jogo |
| 🛡️ **[Enshrouded Server Guardian](https://github.com/nicolasferreiraxn/Enshrouded-Server-Guardian)** | faz o servidor dedicado ser a autoridade sobre o personagem de cada jogador |

---

<p align="center">
  <sub>
    Projeto de fã, sem vínculo com a Keen Games. Sem suporte oficial — use, leia, modifique e publique à vontade.<br>
    Código sob <a href="LICENSE">MIT</a>. Os dados em <code>app/public</code> pertencem à Keen Games.
  </sub>
</p>
