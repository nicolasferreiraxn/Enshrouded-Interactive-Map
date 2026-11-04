# Mudanças

*Read this in [English](CHANGELOG.md).*

## 1.1.1 — 04/11/2026

- **Francês.** O mapa agora está disponível em francês (Français), o 6º idioma: interface traduzida e nomes do
  jogo (itens, criaturas, lugares, missões) tirados dos textos oficiais do jogo em francês. Escolhido
  sozinho quando o sistema está em francês; também dá para escolher no menu de idioma.

## 1.1.0 — 04/11/2026

- **Os monstros voltaram.** Depois da atualização do jogo de novembro de 2026 (build 1285601), o mapa parou de
  mostrar criaturas: o jogo mudou de lugar a tabela que descreve cada tipo de entidade. Agora o mapa procura essa
  tabela pelo conteúdo, e não num endereço fixo, então a próxima mudança não deve quebrá-lo de novo.
- **Portas destrancadas, botões e alavancas acionados, barreiras abertas e portas secretas** voltaram a ser
  marcados; dependiam da mesma tabela.
- **Aviso de versão nova:** ao abrir, o mapa consulta o GitHub e, se houver versão mais nova, mostra uma faixa
  com o link para a página de download. Nunca baixa nada; "Dispensar" esconde até a próxima versão.
- **Linux (Proton/Wine):** o mapa não carrega mais o seu ajudante de pins dentro do jogo lá, o passo apontado
  como o que quebrava o mapa com o jogo aberto. O mapa ao vivo (posição, monstros, baús) continua funcionando; só
  a sincronização de pins com o mapa do jogo fica indisponível, e a aba Pins avisa isso uma vez, no seu idioma, em
  vez de tentar de novo para sempre. Ainda não testado no Linux; relatos são bem-vindos.
- As mensagens técnicas de erro da conexão com o jogo agora são em inglês, e não em português.

## 1.0.2 — 25/10/2026

- Quando o Windows não deixa o mapa ler o jogo (jogo ou Steam rodando como administrador), o mapa avisa e
  oferece um botão para reabrir como administrador.
- Avisa quando o jogo está aberto mas nenhum personagem aparece por um tempo.
- Acha a Steam em qualquer disco.

## 1.0.1 — 25/10/2026

- Acha o personagem mesmo com o mapa aberto antes do jogo: agora ele espera o tempo que for preciso.

## 1.0.0 — 24/10/2026

Primeira versão: mapa do Enshrouded em tempo real no segundo monitor — sua posição, amigos, monstros, baús e
tudo o que já foi feito, em 5 idiomas, com os pins sincronizados com o mapa do jogo.
