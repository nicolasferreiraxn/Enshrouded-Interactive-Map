# Mapa Interativo Enshrouded

Mapa interativo do **Enshrouded** para o segundo monitor. Lê a memória do jogo para mostrar onde você e seus
amigos estão e tira do mapa o que já foi pego, aberto, derrotado ou minerado. O mapa é desenhado com o mesmo
shader do mapa da tecla M.

*Read this in [English](README.md).*

> **Sem suporte.** Publicado para a comunidade usar, ler e melhorar. Não há atendimento nem cronograma de
> versões. A licença permite pegar, modificar e publicar.

## De onde veio

Procurei mapas interativos do Enshrouded e nenhum me agradou. Fiz o meu: no começo, só um mapa mostrando onde
estava cada coisa, com o visual do mapa do jogo. Jogando com os amigos no nosso servidor, fui acrescentando o que
fazia falta — minha posição em tempo real, saber o que já tinha sido feito (o baú que um amigo abriu, a planta
colhida, a porta secreta usada), os amigos no mapa, as criaturas vivas, os pins sincronizados com o jogo.

A ideia central é simples: o jogo já sabe tudo isso, porque precisa saber para desenhar o mundo. O mapa só
confere cada marcador na memória e tira o que não existe mais.

## O que ele faz

- Mapa igual ao da tecla M (relevo, isolinhas, névoa), com sua posição e direção em tempo real.
- Amigos no mapa, com nome.
- Todos os marcadores com o texto exato do jogo, em **5 idiomas**: Português, English, Español, Deutsch, 简体中文.
- Some sozinho o que já foi feito: baús, itens, plantas, botões, barreiras, portas trancadas e secretas.
- Criaturas vivas na posição real, com a vida do alvo ao vivo.
- Minério esgotado sai do mapa quando você termina o node.
- Busca de item com quem dropa; **Meu filtro** para mostrar só o que você está caçando.
- Pins sincronizados com o mapa do jogo: criar, apagar ou renomear de um lado muda do outro.
- Rota até qualquer ponto; **F8** esconde o ponto mais perto.

## Como funciona

**Leitura.** O exe abre o jogo com `PROCESS_VM_READ` e lê com `ReadProcessMemory`:

| dado | origem |
|---|---|
| posição e câmera | endereços que o app procura e valida sozinho ao abrir — costuma sobreviver a atualizações |
| baús, itens, plantas | entidades do ECS carregadas em volta de você (~95 m); item fixo que sumiu = pego |
| botões, barreiras, portas | componentes de alternância, trava e interação |
| criaturas | posição e vida; spawn sem criatura viva sai do mapa |
| minério | blocos de terreno (cavados + originais); esgotado = nenhum grupo de 6+ blocos do minério |
| histórias lidas, névoa | o seu save local (`.ksd`), só leitura |

O estado é lembrado depois que você se afasta e o jogo descarrega a área, então nada volta a aparecer à toa.

**Pins.** Para criar marcadores no mapa do jogo, o exe carrega uma DLL embutida dentro do processo do jogo
(`LoadLibraryW` via `CreateRemoteThread`). Ela acha as funções de marcador do próprio jogo **por padrão de bytes**
— se o padrão não aparecer exatamente uma vez, ela não faz nada — e as chama na thread do jogo, recebendo os
pedidos por um pipe local. Os pins ficam salvos no seu personagem como qualquer marcador. É a única parte que
escreve no jogo.

## Instalação

1. Baixe o `.zip` em [Releases](../../releases) e extraia.
2. Abra o `Mapa Interactive Enshrouded.exe` com o jogo aberto.

Requisitos: Windows 10/11 e Enshrouded 1.0 (Steam). Testado em outubro de 2026. Uma atualização do jogo pode
quebrar partes até sair versão nova.

Nada sai da sua máquina: sem internet, telemetria ou conta. Filtros e pins pendentes ficam no seu usuário do
Windows.

## Idiomas

| texto | origem | arquivo |
|---|---|---|
| nomes do jogo (itens, criaturas, missões…) | textos **oficiais** do jogo | `app/public/lang/<idioma>.json` |
| interface (botões, menus, dicas) | tradução nossa | `app/src/i18n/<idioma>.json` |

**Quer outro idioma?** Copie `app/src/i18n/en.json` para `<código>.json`, traduza os valores (sem mudar as
chaves), adicione o idioma em `app/src/i18n.js` e abra um pull request. Os nomes do jogo do idioma novo a gente
gera a partir dos textos oficiais; até lá aparecem em inglês.

## Compilar

Os releases são compilados pelo **GitHub Actions** a partir deste repositório, com log público
([`build.yml`](.github/workflows/build.yml)) — dá para conferir que o binário saiu deste código.

Localmente (Node 20+, Rust stable, Windows):

```
compilar.bat
```

| pasta | conteúdo |
|---|---|
| `app/src` | interface (React + Leaflet); o mapa em WebGL2 fica em `gamemap.js` |
| `app/src-tauri/src` | memória: `tracker.rs` (posição), `live.rs` (estado ao vivo), `terreno.rs` (minério), `injetor.rs` (pins) |
| `injector/marcador` | a DLL dos pins (compilada e embutida no exe automaticamente) |
| `app/public` | dados prontos: marcadores, ícones, tiles |

## Créditos

- **Keen Games** — o Enshrouded. Nomes do jogo, shader e texturas do mapa vêm dos arquivos do jogo. Sem vínculo
  com a Keen Games.
- **[kfc-parser](https://github.com/Brabb3l/kfc-parser)**, do brabb3l — usado para ler os recursos do jogo.

Projetos companheiros: **Enshrouded Save Editor** e
**Enshrouded Server Guardian**.

## Licença

Código MIT — veja [LICENSE](LICENSE). Os dados em `app/public` pertencem à Keen Games e ao enshrouded.tools e não
estão cobertos pela MIT.
