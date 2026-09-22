# Changelog

Formato: o que mudou e o que ficou pendente, a cada entrega.

## [1.43.0] — 2026-09-22

### Blindar a rede do setor: HTTPS, edição simultânea e retenção de sessão
O sistema atende a rede do setor desde a 1.32.0. Das lacunas que a auditoria de
prontidão deixou para essa situação, três seguiam abertas. Esta versão fecha as
três. (O `/auditoria` recalculando a cadeia inteira, que o `PENDENCIAS.md` ainda
listava, já tinha sido resolvido: a tela confere só a janela exibida.)

#### HTTPS servido pelo próprio sistema, com uma AC do setor restrita por nome
Senha e cookie de sessão viajavam em claro pela rede. Agora, com
`CSSO_TLS_CERTIFICADO` e `CSSO_TLS_CHAVE` preenchidos, o uvicorn fala TLS na
própria porta. `python -m ferramentas.certificado_tls <IP>` cria os arquivos.

**Uma AC, e não um certificado autoassinado.** O autoassinado põe o aviso
vermelho em toda estação, todo dia, e ensina a equipe a clicar em "continuar
mesmo assim", que é exatamente o gesto de que um ataque na rede precisa. A raiz
é instalada uma vez por estação (`certutil -addstore -f Root ca.crt`, ou GPO).
Renovar reaproveita a AC, e as estações não precisam de nada.

**Restrita por nome (Name Constraints crítica).** Instalar uma raiz é dizer ao
navegador "confie em tudo que esta chave assinar". Sem restrição, quem copiasse
`ca.key` forjaria o HTTPS de qualquer site nas estações. **O primeiro desenho
tinha esse buraco, e foi o teste que o pegou:** a restrição vale *por tipo* de
nome (RFC 5280 §4.2.1.10), então uma AC que só permitia o IP `10.0.73.198` não
dizia nada sobre nomes DNS, e assinava `banco.exemplo` sem objeção. Agora o tipo
não pedido é fechado com um nome que não existe (`invalid`, `0.0.0.0/32`). O
teste forja certificados com a chave da AC, nos quatro cruzamentos IP/DNS, e
exige que o OpenSSL recuse cada um num handshake de verdade.

Um segundo defeito apareceu só no sistema real, e não no teste: com a folha
contendo apenas o IP, o OpenSSL conferia o CN `127.0.0.1` **como se fosse nome
DNS** contra a restrição, e recusava o próprio certificado legítimo
("permitted subtree violation"). A folha saiu sem CN, já que os navegadores
ignoram o CN há anos e o nome vale pelo SAN. Ganhou teste próprio, com só IP e
só nome.

O `cookie_seguro=auto` já acerta sozinho: o esquema da requisição passa a ser
`https`, o cookie sai `Secure` e o HSTS da 1.32.0 passa a valer. Conferido de
ponta a ponta no ambiente de teste: `http://` na porta TLS não responde, cliente
sem a raiz é recusado, e o login entrega `Secure` e `strict-transport-security`.

O aviso "senha e sessão viajam em claro" deixa de aparecer quando há TLS. No
lugar dele entram três avisos: TLS pela metade (só uma das duas variáveis),
arquivo ausente e certificado vencendo em 30 dias ou já vencido. A folha dura
397 dias, o teto dos navegadores. Passo a passo em `docs/HTTPS_NA_REDE.md`,
com a tabela dos erros do navegador e o que cada um quer dizer.

`dados/tls/` entrou no `.gitignore`: tem a chave da AC.

#### Duas pessoas no mesmo parecer: quem salva por último não apaga mais quem salvou antes
O formulário do parecer leva a `versao` que estava gravada quando a tela foi
desenhada, e a rota recusa se o banco já está em outra. Antes, o segundo
salvamento gravava por cima e o texto do primeiro sumia em silêncio, com as
duas pessoas achando que o delas valeu.

**A recusa diz quem salvou e quando** ("Técnica de Teste salvou este parecer em
22/09/2026 14:03"), ou "Você mesmo… em outra aba" quando é a própria pessoa.
**E devolve o que ela tinha escrito** num quadro "Não gravado", com os campos
de texto que diferem da versão atual, prontos para copiar. É isso que separa
uma recusa de uma perda. A recusa não consome versão nem escreve na trilha.

Não precisa de `UPDATE … WHERE versao = ?`: toda transação abre com `BEGIN
IMMEDIATE`, então dois salvamentos simultâneos já chegam em fila, e a
comparação dentro da transação é suficiente. Formulário sem o campo (cliente
antigo, teste que posta direto) passa como antes.

#### A retenção de `sessao` passa a ser cumprida, e não só declarada
A política dá 90 dias após expirar, eliminação, por causa do IP que a linha
guarda. Até aqui a tabela crescia um registro por login, com IP, para sempre.
`autenticacao.expurgar_sessoes` apaga o que passou do prazo. Roda a cada login,
porque é o login que faz a tabela crescer e a poda não pode depender de o
servidor ser reiniciado, e também no `lifespan`. O prazo é o mesmo
`log_retencao_dias` do registro de acesso, e não um campo próprio: os dois
guardam o mesmo IP.

**Suíte: verde, sem falhas** (no Linux de desenvolvimento).

## [1.42.2] — 2026-09-09

### O PDF nunca sairia nesta pasta, e o LibreOffice não reclamava
O LibreOffice foi instalado nesta máquina (26.2.6, o ramo maduro, baixado do
espelho oficial e conferido pelo SHA-256 publicado). O sistema passou a
encontrá-lo sozinho — e a conversão continuou falhando, entregando o `.docx`
com o aviso "instale o LibreOffice" **numa máquina que o tinha instalado**.

A causa é uma linha: o caminho do perfil ia cru para dentro de um `file:///`.

```
hoje  : file:///C:/Projetos/Sistema CSSO/dados-teste/perfil_lo
certo : file:///C:/Projetos/Sistema%20CSSO/dados-teste/perfil_lo
```

**O espaço torna a URL inválida, e o LibreOffice não diz isso:** ele sai com
código 0, com `stderr` vazio, sem escrever o PDF. Medido nas duas formas, lado
a lado, com o mesmo documento e o mesmo comando — só muda o `%20`. E o caminho
de instalação documentado deste sistema é `C:\Projetos\Sistema CSSO`: ou seja,
a geração de PDF **nunca teria funcionado aqui**, e o defeito só apareceria no
dia em que alguém instalasse o LibreOffice — que é hoje. O teste-ouro do PDF
vivia pulado por falta do programa, então nada acusava.

`perfil.resolve().as_uri()` no lugar da f-string. `as_uri()` exige caminho
absoluto e percent-codifica o que precisa.

**E o aviso da falha passou a dizer o que houve.** Era `(soffice: )` quando o
`stderr` vinha vazio — que não distingue "não rodou" de "rodou e não fez", e
manda quem lê procurar no lugar errado. Agora diz o código de saída e que o
arquivo não foi escrito.

Dois testes novos: um monta uma pasta de perfil **com espaço no nome** (pelo
nome, não pelo caminho da máquina, para valer também onde o repositório não
tem espaço) e exige `%20` no comando; o outro cobre a frase da falha silenciosa.
Com o LibreOffice presente, o teste-ouro do PDF deixa de ser pulado e a suíte
passa a rodar **sem nenhum skip**.

#### A varredura da família, e o único outro lugar que a tinha
Um defeito assim não se conserta num lugar: ele nasce de novo por cópia do
vizinho. `testes/unitarios/test_uri_de_caminho.py` percorre `app/` e
`ferramentas/` por árvore de sintaxe e reprova toda URI de arquivo **montada**
— f-string ou concatenação — deixando passar quem apenas cita `file://` em
comentário ou docstring, inclusive o comentário que explica este defeito.

Ela achou um: `ferramentas/conferir_mudanca.py` abria o banco em somente-leitura
com `f"file:{caminho.as_posix()}?mode=ro"`. O SQLite tolera o espaço e a
ferramenta sempre funcionou aqui — mas não toleraria um `?` nem um `#` no
caminho, e o certo é não precisar saber quais caracteres cada leitor de URI
perdoa. Passou a `as_uri()` também, e continua lendo os dois bancos.

Varridos e limpos: só o LibreOffice é programa externo neste sistema, e as
outras montagens de caminho (`sqlite+pysqlite:///` da configuração e do
ambiente de teste, o `VACUUM INTO` do backup, os nomes dentro do `.zip`) não
são URI — foram conferidas em execução, com o espaço no caminho.

## [1.42.1] — 2026-09-08

### Recriar o ambiente de teste deixa de derrubar quem estava usando pela rede
O ambiente de teste foi aberto para a rede local (porta 8766, regra de firewall
limitada à faixa das estações, endereço divulgado aos colegas). Descoberto no
mesmo dia: **`RECRIAR-TESTE.bat` reescrevia o `.env` com `CSSO_HOST=127.0.0.1`
fixo.** Quem limpasse os dados de teste — que é exatamente para isso que o
arquivo existe — derrubaria o acesso de todo mundo, e nada na tela diria por
quê. O sintoma seria o pior tipo: "ontem funcionava".

A pasta é descartável; **a decisão de atender a rede não é, e ela não mora nos
dados**. Agora `preparar()` lê o `CSSO_HOST` do `.env` antes do `rmtree` e o
mantém, e o resumo impresso diz qual dos dois casos aconteceu — "foi o que você
pediu em `--host`" ou "ninguém pediu isso agora: o `.env` anterior desta pasta
já atendia a rede, e a recriação manteve a decisão". Quem quiser voltar ao
próprio computador recria com `--host 127.0.0.1`; um ambiente novo, sem `.env`
anterior, continua nascendo em loopback.

O endereço impresso deixou de ser `127.0.0.1` fixo, e o critério de "só a
própria máquina alcança" é o do sistema (`config.SO_LOOPBACK`), não um segundo
escrito na ferramenta.

### O caminho de pôr o ambiente de teste na rede, escrito
`ABRIR-TESTE-NA-REDE.bat` cria a regra de firewall **limitando a origem** à
faixa da rede local (e não "abrindo a porta": abrir para tudo entrega a tela de
login a qualquer máquina que alcance o computador). `SERVIR-TESTE-NA-REDE.bat`
sobe o ambiente sem abrir navegador, e um atalho na pasta Inicializar da conta
o traz de volta a cada logon — pasta Inicializar, e não Tarefa Agendada, porque
nesta máquina o Windows exige elevação para tarefa de logon e a pasta faz o
mesmo sem administrador. `AGENDAR-TESTE-NA-REDE.bat` fica para quem preferir a
tarefa. Tudo isso é do ambiente de TESTE, com gente inventada: o sistema de
verdade, na porta 8765, não é tocado por nenhum deles.

## [1.42.0] — 2026-09-06

### Fase 3 do plano de adesão: o front compilado, como produto — e o que ele responde
A fase 2 provou o desenho de front separado numa página escrita à mão. Esta
o leva ao formato de produto: **`frontend/`**, um app React + Vite +
TypeScript que consome só a `/api/v1` e é servido pelo próprio FastAPI em
`/app`. Cinco telas — Início (com as pendências por escopo), Balcão de EPI,
Chamada, Ficha de EPI e Pendências —, oito testes de front (Vitest, com a
tela do balcão renderizada) e cinco do lado do servidor.

**O que continua igual, de propósito:** nenhuma porta nova, nenhum nginx,
nenhum CDN e nenhuma cadeia de build na máquina do setor. O Vite escreve o
bundle DENTRO de `app/estaticos/app/`, e o `StaticFiles` de sempre o serve;
só o `index.html` passa por rota (`app/rotas/aplicativo.py`), porque é ele
que exige sessão. Quem instala recebe a pasta já construída — `npm` só
existe na máquina de quem desenvolve. Sem o bundle, `/app` responde 503
dizendo como montá-lo, e não uma tela em branco.

**A CSP não mudou.** O `index.html` do Vite não tem script embutido (há teste
que reprova se um dia tiver), e o bundle de produção não usa `eval`. Foi a
prova de que a decisão da 1.40.0 — sem framework que avalie expressão em
atributo — não é "sem React": é "sem React no servidor". Compilado, ele passa
pela mesma porta que o `csso.js`.

#### `ferramentas/varrer_pendencias.py` — o agendador que o código pedia
Toda pendência deste sistema nasce de uma escrita, e duas funções diziam com
todas as letras o buraco que isso deixa: um lote parado atravessa a janela dos
60 dias do CA sem abrir pendência, e um servidor que não recebe nada de novo
atravessa a data da troca sem tarefa. As telas etiquetam desde o primeiro dia;
o que atrasava era a fila. A rotina noturna chama AS MESMAS duas funções, uma
vez por lote com CA e uma por servidor com troca prevista — sem regra nova,
idempotente, e fechando pela mesma passada o que perdeu o objeto. As tarefas
que ela abre nascem **sem dono**, e as que ela fecha ficam na trilha em nome
da "rotina de varredura" (`pendencias.concluir_pela_rotina`): a rotina não é
ninguém, e pôr o nome de alguém seria mentir. `--simular` mostra e desfaz. O
`schtasks` está no cabeçalho, ao lado dos de backup e cadeia — é a terceira
tarefa agendada que não viaja com a pasta.

#### `/api/v1/pendencias`
A fila de quem entrou, por escopo, com o rótulo do tipo, o prazo, quem é o
dono e a âncora para o sistema completo — pelo mesmo mapa de permissões de
`pendencias.html`, porque oferecer porta trancada é a mesma mentira do menu,
em JSON. A descrição passa pela RN-19 (`texto_livre`) como na tela.

#### O que ficou escrito para a decisão
- **Dado pessoal não fica no navegador**: nada de `localStorage` com nome ou
  SIAPE; o service worker (o mesmo de `/celular`) guarda só a casca.
- **O cliente da API é um só** (`frontend/src/api.ts`): `X-Requested-With:
  fetch` em todo pedido, 401 vira ida ao login com a volta para o app, e toda
  recusa vira `RecusaDaApi` com `erro` e `motivos`.
- **Sem react-router**: as telas são poucas e planas; a âncora dá o botão de
  voltar e o link copiável de graça, em vinte linhas.
- **A folha é a do sistema** (`csso.css` + `celular.css`); `app.css` só
  desenha o que não existe na tela de mesa. Nenhuma cor nova.

**O que a fase 3 responde.** O front compilado rende para o trabalho em pé e
custa o esperado: cada tela é desenhada em TypeScript, e uma tela nova paga
isso de novo. Faz sentido como PRODUTO se a replicação em outras
universidades for por serviço central hospedado; para instalação em cada
universidade, a tela de bolso (sem build) e o sistema completo bastam. A
decisão é do dono, com a medição das seis tarefas de
`entrada/ux/02_NAVEGACAO.md` §6. As três fases estão entregues; nenhuma
apagou a anterior.

## [1.41.0] — 2026-09-06

### Fase 2 do plano de adesão: a API JSON e a tela de bolso
A fase 1 (1.40.0) mexeu na interação sem tocar na arquitetura. Esta mexe na
arquitetura **num pedaço pequeno o bastante para ser jogado fora**: as duas
telas que se usam em pé, longe da mesa — entregar EPI no balcão e transcrever
a folha de presença de um dia — ganharam uma versão de celular que é HTML
mínimo e consome TUDO de uma API em JSON. É a experiência de "front separado"
da fase 3, com o risco de uma página. O argumento está em `PENDENCIAS.md`,
"Amigável não é SPA".

#### `/api/v1` — a mesma regra, em JSON (`app/rotas/api.py`, `app/esquemas/api.py`)
Nove rotas: identidade (`/eu`), o balcão (busca de quem recebe, itens, lotes
de um item, registrar entrega, a ficha) e a chamada (turmas por situação, a
grade de uma turma, lançar um dia de um inscrito). **Nenhuma delas reimplementa
nada**: cada uma chama o MESMO serviço que a tela chama —
`epi_ficha.registrar_entrega`, `presenca.lancar_presenca`,
`servidores.buscar` —, com as mesmas recusas (RN-24, RN-25, RN-26, o dia fora
da turma, o certificado já emitido) e a mesma trilha de auditoria. Uma regra
que valesse só na tela, ou só na API, seria a forma mais barata de a ficha de
EPI passar a ter duas verdades.

- **A sessão é o mesmo cookie do `/login`.** Sem sessão a API responde 401 em
  JSON — não um 303 para o login, que um cliente de API não segue para ler
  HTML. Permissão negada é 403 em JSON com a permissão que faltou; corpo sem
  forma é 422 no MESMO formato de erro (`{erro, motivos}`) das recusas de
  regra. Quem consome a API lê um formato de erro, não três. O tratador em
  `principal.py` decide pelo caminho (`/api/`).
- **A RN-19 vale linha a linha, pela MESMA função da tela** (`identificar`): o
  seletor de quem recebe devolve nome com SIAPE a quem pode ler o nome e o
  identificador opaco a quem não pode; o campo `nominal` diz qual dos dois foi.
  A busca por nome não acha para quem não pode ler o nome — é
  `identificacao.casa_a_busca`, a mesma de `/servidores`.
- **Todo POST exige `X-Requested-With: fetch`.** É a guarda contra CSRF de
  quem usa cookie: um `<form>` de outro site posta para cá com o cookie da
  pessoa (SameSite=lax deixa passar navegação de topo), mas não escreve esse
  cabeçalho — só `fetch` da própria origem escreve, e a CSP (`connect-src
  'self'`) impede o `fetch` de outra origem de chegar.
- **Sem Swagger, de propósito.** `docs_url=None` é decisão antiga e a API a
  respeita: o contrato está em `app/esquemas/api.py`, e o índice (`GET
  /api/v1`) exige sessão.

#### `/celular` — a tela de bolso (`app/rotas/celular.py`, `celular.html`, `celular.js`, `celular.css`)
Uma página sem lateral, três abas na barra de baixo, onde o polegar alcança:
Início, Balcão de EPI e Chamada — as duas últimas só para quem tem
`epi.entregar` e `turma.avaliar`; quem não tem nenhuma abre a página e lê por
que ela está vazia para si.

- **O balcão em quatro passos**, um cartão por vez: quem recebe (busca por
  SIAPE ou nome, resultado em botão de 48px), equipamento, detalhes (lote com
  o impedimento escrito e desligado, quantidade padrão do catálogo, tamanho,
  data sem futuro, justificativa da exceção quando há máximo) e a confirmação
  com o link do comprovante e "Registrar outra entrega", que volta ao começo
  com a lista de itens já carregada. Provado no navegador: registro gravado,
  o mesmo que o balcão de mesa gravaria.
- **A chamada como folha do dia:** turma em andamento, dia (o de hoje já
  escolhido quando é dia de aula), horas do dia (a carga, na turma de um dia),
  e um nome por linha com dois marcadores — presente, falta. Cada toque lança
  pelo serviço e a linha muda ao lado do nome (frequência, horas, situação);
  fora de andamento a tela avisa que é retificação e pede o motivo.
- **Campos de 16px e alvos de 48px**: abaixo de 16px o iOS amplia a tela ao
  focar, e 48px é o mínimo de dedo. Nenhuma cor nova — tudo são os tokens de
  `csso.css`, que continua carregada antes.
- **PWA no que cabe.** Manifesto (`/estaticos/manifest.webmanifest`) para
  "adicionar à tela inicial", e um service worker (`/sw.js`, servido da raiz
  porque o escopo é o caminho de onde ele vem) que guarda a CASCA — a página,
  as folhas, os scripts — para ela abrir sem rede e dizer "sem rede" com as
  próprias palavras. **Os dados nunca são guardados**: a ficha de EPI e a
  lista de chamada nomeiam gente, e cache em celular compartilhado é
  exatamente onde dado pessoal não pode ficar (ROPA §6). Há teste que reprova
  `/api/` na lista de casca do worker. Dado pessoal também não vai para
  `localStorage`: o que a página guarda é só a aba em que a pessoa estava.
- O ícone do manifesto é o símbolo da marca do SISTEMA em chapa — não é brasão
  nem identidade da UFVJM, pelo motivo já escrito em `base.html`.
- `base.html` ganhou `{% block cabeca %}`: o que uma tela precisa pôr no
  `<head>` e a casca não sabe (manifesto, folha própria, cor da barra).

#### O que a fase 2 responde, e o que fica para a decisão da fase 3
O desenho de front separado **rende** para o trabalho em pé: a mesma regra,
uma tela que cabe na mão, e nenhuma linha de serviço duplicada. O custo
apareceu onde se esperava — a página desenha tudo em JavaScript (259 linhas
para duas telas), e cada tela nova pagaria o mesmo. A fase 3 (um front
compilado, React/Vite, servido de outro lugar) só faz sentido se a replicação
em outras universidades for por serviço central hospedado; para instalação em
cada universidade, o que existe hoje basta. A decisão continua sendo do dono,
com a medição das seis tarefas de `entrada/ux/02_NAVEGACAO.md` §6.

## [1.40.0] — 2026-09-06

### Fase 1 do plano de adesão: interação primeiro, na arquitetura que existe
A decisão de fundo está registrada em `PENDENCIAS.md`, seção "Amigável não é
SPA": o que faz alguém do setor dizer "não é intuitivo" são resposta lenta,
trabalho digitado que some, recusa que não diz a saída e tela que não diz por
onde começar — e nenhum desses quatro depende de framework de front-end. Esta
versão fecha o que as auditorias de `entrada/ux/` e `entrada/marca/` ainda
tinham em aberto na 1.39, sem trocar uma peça da arquitetura, e escreve por que
não vai trocar: a CSP (`script-src 'self' 'nonce-…'`, sem `'unsafe-eval'`)
é o que impede script injetado de rodar, e todo framework que avalia expressão
em atributo precisa do `'unsafe-eval'` para existir. O argumento inteiro está
no cabeçalho de `app/estaticos/js/csso.js`.

#### O quadro: mover sem arrastar, gaveta de filtros, quadro vazio que fala
- **Mover pelo menu.** O arrasto do HTML5 não existe no toque (tablet no
  balcão) nem no teclado; quem estava num deles saía do quadro e movia pela
  ficha. Cada cartão ganhou "mover para…", um `<form method="post">` de
  verdade com um botão por coluna de destino — a coluna atual fica de fora.
  Sem JavaScript ele submete e a rota devolve o quadro inteiro (303, com a
  mensagem ou a recusa na faixa); com JavaScript o envio cai em `mover()`, o
  MESMO caminho do arrasto, e a recusa aparece no mesmo lugar dos dois jeitos.
  A rota distingue os dois pelo pedido (`_quer_pagina`): o `fetch` do quadro
  manda `X-Requested-With: fetch` e continua recebendo o fragmento — o contrato
  que a suíte já provava não mudou.
- **Filtros em gaveta**, como `/processos` desde a 1.30.0: a 1366×641 o cartão
  aberto custava metade da altura útil, e o quadro rola dentro de si. Nasce
  aberto só quando um dos cinco controles carrega valor, e o `<summary>` diz
  o que está aplicado por extenso.
- **O quadro vazio** eram cinco colunas em branco, sem uma palavra, na tela
  que se abre primeiro. Agora diz por onde começar (nomeando "Novo processo"
  e "Importar") ou, com recorte aplicado, onde o filtro olhou e como limpar.
- **A recusa diz para onde dá para ir.** "Transicao proibida: Recebido ->
  Aguardando inspecao." era sem acento, com seta ASCII e muda sobre a saída —
  e é o erro mais frequente do kanban (pular a triagem). Agora: "Transição
  proibida: Recebido → Aguardando inspeção. De “Recebido” dá para ir a: Em
  triagem, Sobrestado." As saídas vêm da mesma tabela que recusou, então nunca
  divergem da máquina. Vale para as cinco máquinas de estado.

#### O que era digitado e sumia
- **Rascunho local do parecer** (`csso.js`, bloco 2). O editor tem ~25 campos
  e quatro camadas ao lado; submeter qualquer camada recarregava a tela e o
  que estava digitado no principal e não salvo sumia — o cartão da portaria
  existia para não sair da tela e produzia a perda que queria evitar. O que se
  digita vai para o `sessionStorage` sob a chave do parecer; ao recarregar, se
  a versão guardada é a que o servidor desenhou, os campos voltam com um
  aviso e a saída de descartar. A versão é a trava: o servidor a incrementa a
  cada salvamento, e um rascunho velho nunca se sobrepõe a um salvamento novo.
- **Sessão expirada dizia nada.** Chegar ao login sem cookie é chegar; chegar
  com cookie que não vale mais é ter caído. A tela passou a dizer isso — e,
  num POST, que o envio não foi gravado. O `proximo` carrega a query inteira
  (sessão expirada em `/processos?estado=X&pagina=3` voltava para
  `/processos`) e, num POST, é a tela de origem lida do `Referer`, não a rota
  do POST. **E só volta para dentro do sistema**: `proximo=https://outro.site`
  ia direto para o `Location` — redirecionamento aberto, o disfarce clássico
  de phishing. Vale só o que começa com uma barra e não com duas.
- **Conta bloqueada diz até quando** e o que fazer, em vez de
  "temporariamente".
- **SIAPE já cadastrado** redirecionava em silêncio para a ficha do outro, e a
  pessoa concluía que tinha cadastrado. Agora diz por que está ali e que nada
  foi criado.
- **O 422 do FastAPI virou tela.** `Form(...)` obrigatório que não veio
  despejava a validação em JSON, sem casca e sem saída. São 115 `Form(...)`;
  a rede é um tratador só, que para quem pediu HTML desenha a tela de erro com
  a lateral, o nome dos campos que faltaram e o caminho de volta. Quem não
  pediu HTML continua recebendo o JSON.
- **Mensagens de redirecionamento codificadas** nos quatro helpers que ainda
  montavam a URL à mão (`epi_fichas`, `epi_estoque`, `catalogos`, `pareceres`):
  um `&` no nome do fornecedor cortava o recado no `Location`.

#### O editor do parecer
- **Congelado PARECE congelado.** Só o número recebia `disabled`; os outros
  campos do emitido continuavam editáveis sem botão de salvar, e Enter em
  qualquer um submetia para receber "Parecer emitido é imutável". Um
  `<fieldset disabled>` em volta dos campos desliga todos de uma vez, e um
  aviso no alto diz por quê (RN-14) e qual é a saída.
- **"Gerar PDF" diz antes do clique se o PDF sai.** Sem LibreOffice o botão
  entregava um .docx e o aviso ia dentro da resposta, onde ninguém o lia. A
  condição é conhecida antes (`pdf.disponivel()`), então o botão diz.
- A nota da camada de exposição dizia "a classificação é calculada, nunca
  digitada" logo acima do seletor que a deixa escolher. Apagada; a frase
  certa está na própria camada desde a 1.1x.

#### O retorno do que demora
- **Download com retorno** (`csso.js`, bloco 4). "Gerar PDF" chama o
  LibreOffice por até 180 s e o gatilho era um link comum: nada mudava na tela
  e a pessoa clicava de novo. Um download não dispara evento nenhum na página;
  a única forma de saber que ele chegou é o servidor deixar uma marca que a
  página consiga ver. O link manda `?baixar=<token>`, a rota devolve o arquivo
  com um cookie de 60 s com o mesmo token (`web.marcar_download`), e a página,
  ao vê-lo, religa o botão. Token só de letra e número, até 64 — é entrada.
  Nos cinco downloads: .docx e .pdf do parecer, os dois CSVs de relatório e o
  da reconciliação.

#### Teclado, papel e larguras
- **Atalhos com lista** (`csso.js`, bloco 1): `/` foca o filtro da lista da
  tela (abre a gaveta se preciso; sem lista, a busca global), `n` aciona o
  botão de "novo" da tela, `Esc` limpa a busca com texto ou solta o foco, `?`
  abre a lista — um `<dialog>` que só existe com casca. Nunca dentro de campo
  de texto, e nunca com um popup aberto. Três atalhos sem lista eram folclore.
- **A máscara do NUP** (`csso.js`, bloco 3): a MESMA conta do DV de
  `servicos/nup.py` roda a cada tecla e escreve o aviso ao lado do campo —
  "confere", "não confere (esperado 56)", "faltam 4 dígitos". Sem bloquear o
  envio: a dispensa do DV, registrada em auditoria, continua possível. Ao sair
  do campo, a pontuação entra na forma canônica.
- **A guia de entrega tem onde assinar** — separou, conferiu, data —, só no
  papel (`.so-papel`, ligado pelo bloco de impressão). Na tela o bloco não
  existe. Continua não sendo a prova de entrega, e o aviso diz isso no papel
  também.
- **Botão de imprimir** na ficha de EPI, na ficha do servidor e no
  certificado — as três que vão para o papel, onde a pessoa tinha de saber que
  Ctrl+P produz um resultado bom. A guia já tinha o dela.
- **Vinte larguras escritas à mão viraram três nomes.** Eram
  `style="max-width:NNpx"` com doze valores distintos em cinco telas.
  `.campo-curto/.campo-medio/.campo-longo`, em `ch`, nomeadas pelo que o campo
  É. Varredura de teste reprova o próximo.
- **Voltar às pendências.** Nenhuma tela-âncora oferecia a volta à fila; era o
  botão do navegador. `?de=pendencias` viaja na âncora e a casca responde com
  o link.
- Quatro pílulas escreviam o código do banco no `title`; saiu.

#### A varredura que faltava
Um refactor do script do kanban cortou o corpo de uma função no meio, o bloco
inteiro deixou de ser analisável e **o arrasto parou de existir sem uma linha
de erro na suíte** — os testes liam a página e achavam as palavras que
procuravam. `testes/integracao/test_scripts_de_tela.py` renderiza oito telas e
passa cada `<script>` embutido (e o `csso.js`) pelo `node --check`; sem `node`
na máquina, pula dizendo por quê. Foi ele que pegou o defeito antes de esta
versão sair.

#### Dependência nova: nenhuma
O `csso.js` tem zero dependências e não há cadeia de build. O `node` é
opcional e só para a varredura de sintaxe.

## [1.39.2] — 2026-09-05

### Apontar para um `.env` que não existe agora é erro, não silêncio
A máquina nova (Desktop_Ryzen) passou a ser a de desenvolvimento, e a de origem,
na rede do setor, continua sendo a que vale — está anotado no cabeçalho de
`MUDAR-DE-PC.md`. O `RECRIAR-TESTE.bat` montou o ambiente de teste aqui
(11 processos, 3 pareceres, 12 servidores inventados, 8 contas), e foi ao subir
esse ambiente que apareceu o defeito desta versão.

**O que aconteceu.** Um lançador montou `CSSO_ENV_FILE` com `%CD%` que não
expandiu. O caminho apontado não existia; o pydantic-settings trata env_file
ausente como "sem arquivo" e segue com os padrões da classe — que são
`dados/csso.db`, `dados/documentos`, `dados/anexos`. O "ambiente de teste"
subiu na porta 8766 **lendo o banco real**, sem uma linha de erro. Quem
denunciou foi o log de acesso: cresceu o de `dados/logs`, e o de
`dados-teste/logs` nunca nasceu. Nenhuma conta real foi tocada (as duas
tentativas de login usaram nomes que só existem no ambiente de teste), mas o
modo de falha é exatamente o que o docstring de `ambiente_teste_cli.py` já
chamava de silencioso.

#### `app/config.py` — `EnvFileAusente`
Se `CSSO_ENV_FILE` está definida e o arquivo não está lá, `Config()` recusa
subir, com a mensagem dizendo o caminho apontado e o que fazer. A trava vale
**só para o arquivo apontado**: sem a variável, a raiz sem `.env` continua
sendo o caso do `INICIAR.bat` na primeira execução, que cria o arquivo. Quem
aponta explicitamente está dizendo "não leia o da raiz"; se o apontado sumiu,
parar é o único comportamento honesto.

Dois testes em `testes/test_isolamento.py`, ao lado das duas travas que já
existiam: um prova a recusa, o outro prova que a raiz sem `.env` **não**
virou exceção.

#### `.claude/launch.json` — `csso-teste`
Configuração de lançamento do ambiente de teste na 8766, sem `cmd` e sem
`%CD%`: resolve `dados-teste/.env` pelo Python, sai com mensagem se o ambiente
não foi montado, e só então sobe o uvicorn com `CSSO_ABRIR_NAVEGADOR=false`.
Mesmo que volte a apontar errado, a trava acima derruba antes de ler `dados/`.

### O que a conferência da mudança encontrou nesta máquina
Tudo do `MUDAR-DE-PC.md` passou: `.env` inteiro e sem BOM, `CSSO_HOST` em
`127.0.0.1`, banco na migração de topo com `integrity_check` ok, cadeia
íntegra, e a senha do backup provada — o `.enc` de 12/08 abriu com os mesmos
640 processos, 14 pareceres, 5 laudos e 7.634 eventos da origem. A cópia em
claro foi apagada em seguida. A diferença de contagem (392 na origem, 394
aqui) é só `conferencia_cadeia`, que cresce a cada passe.

Ficou de fora, por decisão de quem opera: apagar `.env.antes-da-rede` e as
duas chaves do Trello do `.env` (o JSON e os 171 anexos já estão em
`entrada/`, as chaves não têm mais uso), instalar o LibreOffice, e copiar a
memória do Claude Code da máquina de origem — a pasta chegou vazia.

## [1.39.1] — 2026-09-05

### Mudar o sistema de computador deixa de ser adivinhação
A pasta inteira foi copiada para outra máquina para continuar o desenvolvimento,
e copiar a pasta **não basta**. O código atravessa inteiro; o que não atravessa
são as quatro coisas que apontam para a máquina de origem — e três delas falham
com mensagem que não diz o que fazer.

**A pior é o `CSSO_HOST`.** Ele guarda `10.0.73.198`, o IP desta máquina, posto
ali na 1.31.0 quando o sistema foi aberto para a rede do setor. Na máquina nova
esse endereço não existe: o uvicorn morre com `WinError 10049 - o endereço
solicitado não é válido no contexto`, a janela preta fecha, e nada na tela liga
o erro a uma linha do `.env`.

**A que faz estrago em silêncio é o `.env` inteiro.** Se ele não for junto, o
`INICIAR.bat` cria um novo com `CSSO_BACKUP_SENHA` **nova e aleatória** — e os
backups cifrados que vieram na pasta ficam impossíveis de abrir para sempre.
Inclusive o `csso-20260812-115750.db.enc`, 18 MB, o único lugar onde os 640
processos existem. Não há recuperação: a senha é a chave. A ordem dos passos em
`MUDAR-DE-PC.md` existe por causa disso — conferir o `.env` vem antes de rodar
qualquer `.bat`.

#### `CONFERIR-MUDANCA.bat` + `ferramentas/conferir_mudanca.py`
Confere as cinco coisas que **a suíte não alcança porque nenhuma delas está no
código**: o endereço de ligação, o `.env`, o arquivo do banco (integridade,
migração e `-wal` pendente), as pastas de dados e o LibreOffice. Depois roda a
suíte inteira. Sai 1 com impedimento, e cada linha `ERRO` diz o que fazer.

A prova de endereço liga na **porta 0**, e não na 8765: o que se prova é que o
endereço pertence a esta máquina. Ligar na 8765 acusaria "em uso" justamente
quando o sistema estivesse no ar — o caso saudável, não o defeito. Sonda: com
`CSSO_HOST=10.99.99.99` a ferramenta sai 1 com a mensagem certa.

Ele imprime também a contagem de linhas por entidade, para comparar com a
máquina de origem. E o que essa contagem diz aqui é desconfortável: **392 linhas
no total, quase todas tabela de apoio.** Zero processos, zero pareceres, zero
laudos. O banco de trabalho está vazio — a decisão de restaurar o backup de
12/08 nunca foi tomada, e agora ela viaja junto com a pasta.

#### O backup de 12/08 foi provado, e abre
Restaurado num destino descartável com o `.env` atual: **640 processos, 14
pareceres, 5 laudos, 78 linhas de anexo, 7.634 eventos**, na migração
`9305283613f3` — bem atrás do `a7c4e91d0f52` de hoje. Não é mais uma suposição
(o ensaio de 24/08 provou que as migrações rodam sem perder linha; esta prova é
outra, e mais simples: que o arquivo ainda **decifra** com o `.env` que está
aqui). O passo 5 de
`MUDAR-DE-PC.md` manda repetir essa prova na máquina nova, porque é o único
teste que descobre **hoje** um estrago que só apareceria no dia em que o backup
fosse necessário.

#### `MUDAR-DE-PC.md`
Os nove passos na ordem, o que apagar antes (`.venv` guarda o caminho absoluto
do Python desta conta de usuário), a tabela de contagens para comparar, o que
fazer conforme o **meio** pelo qual a pasta viajou (pen drive, nuvem, rede
institucional — LGPD arts. 33-36, 39 e 46), a tabela de sintomas quando a suíte
falha, e onde fica a memória do Claude Code, que **não** está na pasta do
sistema.

E o aviso que abre o arquivo: `dados/csso.db` agora existe em duas cópias.
Trabalhar nas duas as faz divergir sem volta — a numeração de parecer é
sequencial por RN-03 e emitiria o mesmo número duas vezes, e a trilha encadeada
por SHA-256 vira duas cadeias que não se fundem.

### Pendente
Nada novo. As decisões de sempre continuam em `PENDENCIAS.md` — e a de restaurar
os 640 processos ganhou um argumento a favor: o backup foi aberto e está inteiro.

## [1.39.0] — 2026-09-05

### A RN-19 fecha a metade da escrita
A supressão da 1.35.0 tapava na **leitura** — a única metade capaz de alcançar o
que já está gravado, porque trilha e razão são append-only, com digest encadeado
num caso e trigger no outro. Faltava parar de **gravar** identificação em prosa
nova. Feito isso, a supressão vira rede de segurança do histórico em vez de regra
de operação.

**33 pontos levantados, e o levantamento tinha falso positivo — 15 eram nome de
coisa.** `campus.nome`, `posto.nome`, `item.nome`, `treinamento.nome`,
`fornecedor_nome` não são dado pessoal e não foram tocados. E um que enganava de
verdade: `laudo_reusado.numero_siape` **não é matrícula de gente** — é o número do
laudo.

**Três são pessoa e continuam nominais, por decisão argumentada:** quem *operou* a
ação (a trilha já imprime o nome do usuário numa coluna ao lado; repetir na prosa
não expõe nada novo) e o **instrutor** em dois pontos — assinante, não servidor sob
avaliação, e o nome é o que vai impresso na rubrica. É a mesma razão que a
dispensa de `assinaturas.html` já registrava.

**Snapshot em coluna fica.** `nome_servidor_snapshot` e `siape_snapshot` são a
RN-15, e é o que faz o comprovante reimprimir igual anos depois. O que sai é o nome
dentro de **texto livre**. A varredura tem sonda própria provando que ela não
confunde os dois.

#### O caso que eu tinha fechado pela metade
A 1.38.0 corrigiu `"entrega ao SIAPE {siape}"` no razão do lote — e **deixou passar
a devolução**, três linhas de código adiante, gravando exatamente o mesmo
vazamento na mesma tabela, lida pela mesma tela, sob a mesma permissão. O teste da
1.38.0 cobria a entrega e não a devolução, e por isso passou verde com o defeito ao
lado.

Fechou junto com os outros seis pontos do arquivo: entrega, estorno, o motivo da
devolução, a trilha da devolução, o comprovante impresso, o anexado e a pendência
do comprovante — todos referenciando `servidor #{id}`.

#### A decisão de não resolver o id de volta em nome
`"Entregue a Joana Ribeiro"` virou `"entregue ao servidor #12"`, e a pergunta
óbvia é se a tela não deveria traduzir de volta para quem **pode** ler. **Não**, e
por três razões somadas:

1. Só ajudaria quem já tem a permissão — e para essa pessoa a ficha está a um
   clique pela âncora. **É lá que a leitura nominal fica registrada**, e não na
   lista. Resolver o nome dentro da trilha entregaria dado identificado por uma
   tela que a 1.38.0 decidiu **não** registrar: seria o "35 leituras, tabela de 0
   a 0" voltando pela porta dos fundos.
2. É a mesma substituição-por-padrão que a supressão recusa fazer para raspar
   nome, com o erro invertido e igualmente grave: `Registro 12`, `pedido #45` e
   `lote #7` se parecem, e resolver errado põe o nome da **pessoa errada** numa
   linha de auditoria.
3. Custaria uma consulta por linha da trilha.

#### A trava é por árvore de sintaxe, não por expressão regular
E isso resolve de graça o problema que a guarda dos templates precisou consertar à
mão: comentário e literal não são expressão, então prosa que **explica** a regra
escrevendo `servidor.nome` nunca é acusada — e um `#` dentro de f-string não
engole o resto da linha.

**Cinco sondas**, porque varredura que não consegue falhar não vale nada: uma
repõe as linhas reais de antes e exige acusação de cada uma; outra passa os oito
casos de nome de coisa, o ator e o instrutor; outra prova que o snapshot em coluna
passa; e a quarta **lê o arquivo de verdade**, exige que ele passe hoje, repõe a
frase antiga em memória e exige acusação — com uma asserção extra para que a sonda
não passe por vazio se a frase mudar de forma.

A lista de dispensas está **vazia**, e há teste que é a condição de qualquer
entrada futura nela.

#### Ficou de fora, com argumento
`demandas.py` grava o nome de quem demandou, e **não há id para onde cair**: o
solicitante é coluna de texto, e o vínculo com servidor é opcional e quase sempre
nulo. A demanda é correspondência administrativa transversal, o titular não é
definido pelo registro, e a supressão na leitura cobre. Fechar exige decidir um
identificador de demanda para a frase.

**Suíte: 2150 passados, 1 pulado.**

## [1.38.0] — 2026-09-05

### O EPI passa a deixar rastro de quem leu o quê
Fecha a metade restante do achado G-3. Medido: o almoxarife abria as **9
requisições nominais** do ambiente de teste e `acesso_dado_sensivel` ficava em
**zero**. Agora são **9** — uma por servidor —, mais uma por guia de entrega
impressa.

**A fila continua não gravando, e é decisão.** `/servidores`, `/processos` e a
fila de EPI mostram identificação **já suprimida pela RN-19**, e uma linha por
pessoa por abertura de tela afogaria exatamente o sinal que a tabela existe para
dar — o mesmo argumento que a busca global usou. O que a investigação do art. 37
procura não é "abri a lista": é **abrir o registro de alguém**, e esse ato tem
tela própria.

**Uma correção ao levantamento, feita por quem foi conferir.** Eu tinha apontado o
extrato do lote como leitura nominal. Não é: as colunas são quando, movimento,
quantidade, saldo, motivo, vínculo e **quem registrou** — o operador do balcão,
não quem recebeu. Gravar ali daria `servidor_id` nulo, e linha sem "sobre quem"
não sustenta investigação nenhuma.

**As duas buscas por HTMX também não gravam**, e a terceira razão é a que decide:
são fragmentos disparados a cada tecla, com o lock de escrita na mão, no balcão
com fila de pé.

#### Cinco redações da mesma pergunta viraram uma
Cinco pontos ainda decidiam por conta própria se a leitura era de terceiro — três
com redações diferentes da mesma condição, e **dois contrariando a 1.35.0**: quem
tirava a segunda via do **próprio** comprovante entrava na tabela como suspeito, e
o download de anexo passou a gravar a leitura do próprio dado quando a 1.36.0
abriu as portas do titular. Todos passaram por `registrar_leitura_nominal`.

A trilha continua gravando **sempre**: "qual documento saiu e quantas vias" é
outra pergunta, e essa vale para o titular também.

#### Uma lacuna que ninguém tinha visto
`/pareceres/{id}/docx`, `/pdf` e `/previa` — **a evidência do vazamento original,
com o nome do terceiro no nome do arquivo** — não deixavam linha nenhuma, enquanto
a tela que os gera registrava desde a 1.35.0. O registro foi para a porta única
das três.

#### A matrícula que escapava pela prosa
Achado no caminho, e ele valia mais que a tarefa: o razão do lote gravava a saída
como `"entrega ao SIAPE 7654321"`, e o extrato imprimia **cru** — sob `epi.ver`,
que é a permissão do **servidor comum**. Quem abrisse o extrato de um lote lia a
matrícula de todos que receberam dele, por fora de toda a supressão que a RN-19
aplica em coluna de nome.

As duas metades, como na 1.35.0: a **escrita** passou a referenciar
`servidor #{id}`, e a **leitura** ganhou `texto_livre()` — a única que alcança o
que já está gravado, porque o razão é append-only com trigger e reescrever o
passado não é opção.

#### A trava
Varredura nova, irmã da de escopo. Ela separa lista de pessoa pelo único critério
mecânico honesto — rota `GET` cujo caminho tem `{...}` — e sabe que a rota chegou
a alguém por dois sinais: leitura direta de modelo nominal **ou** passagem por
porta de escopo por linha. É isso que amarra as duas varreduras uma na outra:
**quem fechar o escopo de uma rota nova cai automaticamente sob esta**.

Provada de duas formas: sondas de fonte, e na prática — removendo a gravação de
uma rota real e exigindo que a varredura a acusasse pelo nome. Mais
`test_toda_gravacao_de_acesso_passa_pela_decisao`, que proíbe a chamada crua fora
de `auditoria.py` e impede a **sexta** redação da mesma pergunta.

**Suíte: 2141 passados, 1 pulado.**

## [1.37.0] — 2026-09-05

### O servidor comum se inscreve sozinho — e a turma para de nomear quem não deve
Fecha a jornada aberta na 1.35.0. Duas correções de privacidade primeiro, porque
a auditoria foi explícita: **o perigo não são as permissões novas, é o escopo que
precisa mudar para elas funcionarem.**

#### A lista de chamada nomeava a turma inteira
O que ela diz não é "fulano existe": é **fulano fez NR-35** — ou seja, em que
atividade de risco a pessoa trabalha. A tela saía nominal para qualquer conta com
`treinamento.ver`, o que descrevia bem enquanto toda conta era da CSSO.

O que separa é `certificado.ver` — cuja descrição é literalmente *"certificado
nominal e dados do participante"* —, que todo perfil da CSSO já tem e que a
1.35.0 manteve fora do servidor comum de propósito.

**O papel não mudou.** A folha que circula em campo para assinar continua
nominal: é documento, e nomeia quem assina por definição. Mesma divisão que a
1.35.0 fez entre a prévia do parecer e o `.docx` emitido.

**E o código `PTC-` cai junto com o nome** — achado no caminho. Ele é sorteado e
não enumerável, mas, ao contrário do `SRV-` (que troca a cada sessão, por
desenho), é **estável para sempre** e sai impresso **ao lado do nome** na folha
que passa de mão em mão. Uma única folha assinada resolve o apelido em toda tela
do sistema, para sempre. *Opaco na construção não é opaco no efeito.*

#### A busca casava por nome onde a tela já não mostrava nome
Digitar um nome e receber uma linha **diz de quem é o código opaco** — o oráculo
que a supressão existe para impedir. Agora a busca casa por nome exatamente onde
a tela escreve o nome: **uma regra só**, consultada pelo template e pelo filtro.
`PTC-` e SIAPE continuam achando para todos, porque quem os tem já os trouxe de
outro lugar.

Medido: o servidor comum identificava **4 de 4** pela lista e **6 de 6** pela
busca; agora, **0 e 0**. A CSSO perde uma coisa só — a secretaria não acha mais
**pelo nome** servidor que nunca fez treinamento —, e é a regra que ela já vive
em `/servidores` e na fila de EPI.

#### A lista de turmas vinha sempre vazia, e o comentário jurava o contrário
`/turmas` respondia 200 com *"Nenhuma turma aberta ainda"* **havendo turma com 20
vagas abertas**: o escopo procurava `servidor_id` em `Turma`, não achava, e
devolvia nada. O docstring afirmava que `campus_id` prevenia exatamente esse modo
de falha — e não previne, porque `campus_id` é de outro escopo.

A correção veio de responder o que ninguém tinha perguntado: **uma turma não é
dado pessoal de ninguém.** É cartaz — código, curso, período, vagas. O que tem
titular é a **inscrição**. Então a lista de ofertas não passa por escopo, e "as
minhas" passa.

Isso não reabriu leitura de terceiro: a ficha da turma tem três abas nominais, e
a rota **não chega a carregá-las** para quem só lê o cartaz. Esconder aba nunca
foi guarda — `?aba=inscricoes` continua chegando.

#### A inscrição própria, sem SMTP e sem inscrição pública
Permissão nova que **só inscreve a si mesmo** — a rota não aceita "quem" como
parâmetro, e há teste que tenta inscrever outra pessoa e exige recusa. Vaga
ocupada no pedido, com corrida real testada em duas conexões: duas pessoas
disputando a última vaga, uma entra e uma é recusada.

Estado `INSCRITA`, sem estado novo: a máquina já tinha `INSCRITA → CONFIRMADA`.
Desistir vale até a véspera — depois disso faltar deixa de ser decisão e vira
fato, que se registra em vez de se desfazer. A CSSO confirma pelo sino, com a
pendência descrita pelo **identificador**, não pelo nome.

#### Duas coisas que quase passaram, e uma que eu quebrei
**A CSSO tinha perdido a busca por nome na ficha da turma.** Dois agentes
corrigiram a mesma linha de lados diferentes: um fechou o padrão da busca, o
outro guardou *se* ela acontece — e ninguém repassou **quem** está olhando.
`ve_nominal` decide SE a busca roda; o usuário decide COMO ela casa, e são
perguntas diferentes. Medido: o coordenador procurando "Adelaide" recebia zero.
Nenhum teste cobria isso, e por isso a regressão passou verde.

O teste que agora a guarda **precisou de três tentativas para morder**: a
primeira criava um servidor e exercitava a outra busca; a segunda inscrevia a
pessoa na própria turma, e o nome aparecia na lista de inscritos sem a busca ter
casado nada. Só a terceira — pessoa inscrita em **outra** turma — falha quando o
defeito volta. Teste que não consegue falhar não vale nada, e descobrir isso
custou duas versões.

**E eu corrompi `app/rotas/turmas.py` sondando o teste**: reescrevi o arquivo pelo
PowerShell, que o leu com a codificação errada e o regravou com **481 ocorrências
de mojibake** — `inscriÃ§Ã£o` no lugar de `inscrição`. Nove testes caíram, todos
afirmando sobre mensagens acentuadas. A reversão foi byte a byte, porque a
corrupção era mista, e só foi gravada depois de provar que o arquivo compilava e
que o texto voltava a ler português.

**Suíte: 2100 passados, 1 pulado.**

## [1.36.0] — 2026-09-04

### A jornada do servidor comum passa a terminar
A 1.35.0 fechou o que vazava. Esta abre o que é dele — e faz o sistema avisar.

#### O próprio certificado: "ou próprio", e não permissão larga
`Certificado.servidor_id` existia **exatamente** para o escopo próprio, e
`aplicar_escopo` já era chamado — mas `exigir("certificado.ver")` barrava antes.
Fechadura instalada, chave nunca entregue.

A saída de uma linha seria conceder `certificado.ver` ao perfil. **Não foi essa.**
Essa permissão significa "ler o certificado dos outros", e `semear_rbac` nunca
remove permissão de perfil: concedê-la mudaria o que ela quer dizer **para
sempre**, e toda rota futura guardada por ela passaria a abrir para milhares de
contas, dependendo de a rota lembrar de filtrar. Essa dependência é exatamente a
folga que a 1.35.0 fechou.

Foi replicado o padrão que a casa já tinha: **"tem a permissão, ou é o titular"** —
gêmeo de `epi_ficha.exigir_leitura_da_ficha`. Custa 40 linhas em vez de 1, e a
lista do setor não abre junto. O anexo do PDF passou pela mesma função, e deixou
de ser mais fechado que o `.docx` reimpresso do mesmo certificado.

#### Duas portas que não existiam
**"Meus certificados"** e **"Minha ficha de EPI"** entraram no menu. A regra "ou
próprio" da ficha de EPI estava construída e **testada desde a fatia 3** — e só se
chegava nela por `/servidores` ou pela busca global, ambas exigindo `processo.ver`,
permissão de outro módulo. Recurso construído, testado e invisível: é a quarta vez
que este sistema tem um.

#### `/validar` existia impresso em todo certificado, e era 404
A URL é gravada no documento na emissão. **Cada certificado já emitido carregava
um link quebrado, para sempre.**

A página **não mostra o nome de quem se formou** — é o que o desenho manda, e foi
conferido: com a chave real ela devolve treinamento, norma, carga horária,
vencimento, instrutor, emissor e o código opaco do participante, e **nem o nome
nem o SIAPE aparecem no corpo**. No lugar disso, conferência por digitação: quem
tem o papel na mão confere; quem só tem a chave não recebe o nome de presente.

**Ficou pública, e o argumento é que exigir login não a tornaria mais segura — a
tornaria inútil.** Ela serve a quem *não tem conta*; quem tem já abre a lista.
Chave inexistente, malformada e com dígito errado respondem igual. Junto vieram
limite por IP, `noindex`, `no-store`, sem listagem e sem busca por nome. E um
invariante novo varre o esquema OpenAPI inteiro e exige que **só cinco rotas**
respondam 200 sem sessão, cada uma com o motivo por escrito.

#### O requerente de EPI passa a ser avisado
Medido antes: o sino marcava **zero** ao enviar, zero ao aprovar, zero ao recusar,
zero ao reservar. Ele protocolava em 5 ações e ficava sem notícia.

Dois avisos novos, no mecanismo que já existe — o sino —, e **não um segundo
canal**: o pedido decidido (uma tarefa por pedido, não por item: cinco itens
decididos no mesmo ato dariam cinco linhas idênticas) e o item reservado, que é o
único momento em que há equipamento separado com o nome daquela pessoa.

**O que deliberadamente não avisa** importa tanto quanto: não avisa o envio (foi
ele quem enviou), não avisa a entrega (ele estava no balcão e assinou), não avisa
aprovação isolada (aprovação é promessa; o aviso útil é a reserva). Pendência que
nasce por qualquer coisa vira ruído, e ruído faz parar de olhar o sino.

As duas fecham sozinhas, e reabrem se o fato voltar.

#### "Onde retirar": o sistema não sabia, e não se inventou
A ficha dizia o lote e o CA, e as palavras "retirada", "balcão" e "almoxarifado"
não apareciam em tela nenhuma. Era o ponto exato em que a jornada voltava para o
telefone.

Não havia de onde deduzir: o lote guarda pregão e fornecedor, `unidade_uorg` é a
lotação de **quem pede**, e o endereço do setor emissor é o de quem assina parecer.
Usar qualquer um dos três mandaria gente ao lugar errado **com a aparência de
informação do sistema** — pior que não ter. Virou parâmetro de instalação
(`CSSO_EPI_LOCAL_RETIRADA`), preenchido uma vez; vazio, a tela **diz que não sabe**
e manda procurar a CSSO.

#### A RN-19 na leitura ganhou o titular de volta
A supressão da 1.35.0 era tão certa que apagava a frase **também para o dono da
tarefa** — o aviso nasceria dizendo "conteúdo suprimido" sobre o próprio pedido
dele. `pendencias.titular_de` resolve de quem é a tarefa pela âncora e passa isso
por linha. Não alarga nada: frase de terceiro continua exigindo `exposicao.ver`;
só o titular deixa de ser tratado como terceiro sobre o próprio dado (art. 18, II).

**Suíte: 2031 passados, 1 pulado.**

## [1.35.0] — 2026-09-04

### O sistema deixa de ser seguro por contexto e passa a ser seguro por construção
O dono quis abrir o sistema para **servidores comuns** — gente de outro setor,
que entra para pedir EPI e se inscrever em treinamento. Três auditorias mediram
o que aconteceria, e a resposta foi **não abra ainda**.

O diagnóstico, numa frase: **o sistema era seguro porque todo mundo com conta era
da CSSO.** Nunca por construção.

**O fato que dimensiona:** nenhuma conta jamais teve o perfil `servidor_consulta`
em produção — a única conta é a do coordenador. **O vazamento existia no código e
nunca aconteceu.** Isto foi consertar antes de abrir, não responder a incidente.

#### O registro de acesso vinha antes, e a ordem não foi capricho
`acesso_dado_sensivel` era condicionado a `ve_dado_nominal` — a permissão que
justamente **o perfil de fora não tem**. Medido: 35 leituras nominais, a tabela
foi de 0 a 0. *O único perfil capaz de ler parecer alheio era o único que não
deixava rastro* (LGPD art. 37).

Consertar o registro antes do escopo é o que preserva a capacidade de saber o que
foi lido — fechar primeiro apagaria a pergunta junto com a resposta.

E a correção pegou mais do que se procurava: **a secretaria também era
invisível.** Lia 3 pareceres, 12 fichas e 11 processos deixando **zero** linha.
Agora deixa 15 e 11.

**A leitura do próprio titular não grava**, e é decisão argumentada: gravar quem
exerce o art. 18, II transformaria em suspeita o ato que a lei garante; e com
milhares de contas o próprio dado seria a esmagadora maioria do tráfego, afogando
o sinal que é a leitura de terceiro. Não é critério novo — a ficha de EPI já
decidia assim desde a fatia 3.

#### O escopo alcançava três modelos em dez pontos
O que estava aberto para uma conta de fora, medido e depois medido de novo:

| rota | antes | depois |
|---|---|---|
| `/pareceres/{id}` · `/docx` · `/previa` | **3 de 3**, com agente nocivo, percentual e fundamentação | 1 de 3 |
| `/epis/requisicoes` e `/{id}` · `/guia` | **9 de 9**, com "rotina de trabalho" e "riscos declarados" | 1 de 9 |
| `/servidores` e `/{id}` | **12 de 12** | 1 de 12 |
| `/pendencias` | **15, nominais** | 0 |

`aplicar_escopo` **não era chamado uma única vez** em `app/rotas/epi_*.py` —
contra o que três lugares do código e do desenho afirmavam. Os comentários que
prometiam a proteção inexistente foram corrigidos junto: comentário que mente é
pior que comentário nenhum.

Uma porta por modelo, no serviço e nunca na tela — e `anexo_acesso` perdeu a
segunda cópia da regra do parecer, que agora é uma só. **A equipe da CSSO não
perdeu nada**: os sete perfis foram medidos um a um contra a linha de base.

#### A RN-19 tinha três portas que passavam ao largo dela
A supressão estava de pé na tela, com teste que reprova template lendo
`servidor.nome` — e mesmo assim **10 dos 11 terceiros ficavam identificados**,
por caminhos que a função nunca via: a trilha de auditoria renderizada, o texto
da pendência, e um `nome_servidor` na prévia do parecer que escapava da guarda
**por se chamar diferente**.

**A trilha não podia ser reescrita**, e isso decidiu o conserto: `descricao` entra
no digest SHA-256, então mexer no passado derrubaria a conferência que dá valor
probatório à trilha. A supressão passou a ser **na leitura** — a única metade que
alcança o que já está gravado. Suprime-se a frase inteira, e não o nome dentro
dela: texto livre não tem esquema, e uma varredura que tentasse raspar nomes
erraria deixando passar.

**O papel continua nominal.** O `.docx` e o PDF não passam pelo template da
prévia — o parecer emitido nomeia a pessoa, porque é isso que um parecer é. O que
mudou foi só quem vê a prévia na tela.

E a guarda passou a pegar **a classe**, não o caso: o defeito era apelido de
campo, então ela aprendeu `nome_servidor`, `servidor_nome`, `siape_servidor` — com
sonda que prova que morde os três e que não acusa comentário nem documento.

**Resultado medido: 10 de 11 → 0 de 11.** O titular continua lendo o próprio nome
em 11 telas.

#### A trava contra a quarta ocorrência
`test_repositorios.py` varria **só `app/repositorios/`** — e os quatro vazamentos
graves estavam todos fora dele. Agora varre `app/rotas/`, seguindo as chamadas
dentro do módulo (o `s.get` morava numa função auxiliar, não na rota), e cobra que
toda rota que alcança modelo nominal passe por porta de escopo ou conste de uma
dispensa **com frase conferível**.

Três provas, porque varredura que não consegue falhar não vale nada: uma reproduz
a rota de antes e exige acusação; outra absolve a rota correta; e a terceira **abre
o código de cada porta declarada** — sem ela, esvaziar uma porta devolveria o
vazamento com o teste passando.

Deliberadamente **não** se seguiu o grafo para dentro de `app/servicos/`: uma porta
em qualquer galho absolveria a rota inteira, e absolvição fácil é pior que
cobertura curta.

**Suíte: 1983 passados, 1 pulado.**

## [1.34.0] — 2026-09-03

### Demandas: o que chega por fora do SEI e não pode se perder
A pedido do dono, e a partir de uma dor nomeada:

> *"quero ter a possibilidade de colocar demandas que chegaram para mim por email
> ou presencialmente, que ainda não viraram ou não vão virar processo SEI, mas
> precisam de encaminhamentos, como organizar isso para eu não perder essa
> demanda"*

**Por que não deu para reaproveitar nada**, e vale registrar para ninguém tentar
de novo:

- `Processo.nup` é obrigatório, único e com formato travado. Um processo **é** um
  processo SEI, e os 19 estados dele são do fluxo do adicional. Demanda ali
  poluiria o kanban, o SLA e todas as contagens.
- `pendencia` nasce **de regra**, ancorada em algo que já existe, e é **tarefa**,
  não registro. A demanda que chegou por e-mail não tem âncora — e o que ela
  precisa guardar é quem pediu, por onde, o quê, o que foi feito e como terminou.

Mora na **base compartilhada**, ao lado de Pendências, e não dentro de Processos
SEI: a demanda é transversal — pode ser sobre adicional, EPI, treinamento, ou
sobre nada disso.

**O desfecho é obrigatório, e é onde está o valor.** Encerrar exige dizer como:
resolvida (com o que foi feito), **virou processo SEI** (apontando para o
processo, e daí a demanda para de cobrar), encaminhada (para qual setor) ou sem
providência (com o motivo escrito). É isso que transforma uma caixa de entrada
numa prestação de contas — e o vínculo com o processo dá a rastreabilidade "esta
demanda gerou aquele processo".

**Com prazo, entra no sino.** Opcional por demanda: as que têm prazo aparecem
junto das outras pendências e ficam vermelhas quando atrasam; as que não têm
ficam na lista de abertas. Era esse o pedido — não perder.

**Encaminhamentos são append-only** (RN-31): cada um com data, para quem e o que
foi pedido. Nada se apaga.

**O campo mais perigoso do sistema inteiro nasceu aqui.** "O que foi pedido" é
texto livre escrito sobre uma pessoa por outra — é exatamente onde alguém digita
*"a servidora está grávida e pediu remoção"* ou *"tem laudo de depressão"*. Todo
texto livre da demanda passa pelo filtro da RN-21, e a recusa preserva o que foi
digitado, como em todo formulário desde a 1.27.0.

Duas permissões novas (`demanda.ver`, `demanda.registrar`), e o ROPA foi à
**versão 1.5** com a política de retenção emendada **na mesma entrega** — a
cadência que o próprio documento obriga. O prazo das demandas não é um só, e essa
é a novidade de método: a que virou processo tem o destino amarrado ao processo;
as demais são registro administrativo comum.

O ambiente de teste ganhou **7 demandas**, cobrindo os quatro desfechos e uma
atrasada, para dar para clicar no mesmo dia.

**Suíte: 1894 passados, 1 pulado.**

## [1.33.0] — 2026-08-24

### O sistema deixou de explicar tudo ao mesmo tempo
A pedido do dono: *"fica muito poluído o sistema dessa forma"*. Ele tinha razão, e
o número era maior do que se esperava — **227 parágrafos longos, 88 dicas e 99
avisos** em 64 telas, com as três fichas mais pesadas carregando mais de 3.000
caracteres de prosa cada.

Duas mudanças, e **nenhuma palavra foi apagada**: o texto mudou de lugar.

#### Um (i) para o que explica
Componente novo, reusando o mecanismo de popup que já existia — `:target` para
funcionar **sem JavaScript**, `showModal()` como melhoria, `Esc` e devolução de
foco de graça. O que muda em relação ao popup de cadastro: a caixa é `<div>` e não
`<form>` (não há gravação), a largura é de **coluna de texto (560px, ~72
caracteres)** e não de três campos, e a classe é `popup popup-info` — não `popup`
cru, porque há teste que se apoia nessa assinatura exata para provar que a entrada
de lote não voltou a ser popup. Herdar a classe teria acusado defeito inexistente,
ou feito alguém afrouxar o teste.

O alvo de clique é **24×24px**, o piso da norma. O "×" do cadastro tem 30 porque é
um por tela; um (i) de 30 repetido vinte vezes competiria com o texto que ele
explica. E o foco entra **no corpo**, não no "×": sem isso o leitor de tela
anunciava "Fechar" no lugar da explicação.

#### A distinção que decidiu o que ia e o que ficava
Tratar todo texto como poluição produziria um sistema mais limpo e **mais
perigoso**. O corte:

**Foi para o (i)** — o que explica: IN 15/2022 art. 4º, art. 10 §2º e §3º, NR-6 e
o art. 9º, Lei 8.270/91, de onde vem o número da turma e do parecer, o que o
certificado congela, o passo a passo do SEI, por que o sistema não apaga lote
vencido sozinho, a história do legado.

**Ficou na tela** — o que muda a decisão no instante dela: "o número é consumido
no envio e não volta", a lista dos lotes impedidos com saldo e o caminho de saída,
"copie o CA da etiqueta, não do catálogo", a RN-26 ao lado do botão de aprovar,
"Validade 0 = não expira", "esta turma está X e não recebe inscrição",
"retificação pode virar o resultado", e a contagem no rótulo — *Emitir 7
certificado(s)*.

O critério: **se a pessoa nunca abrir este (i), ela pode decidir errado?** Se sim,
fica na tela. As `.dica` sob campo ficaram todas — são `aria-describedby`, e
escondê-las tiraria a descrição acessível e a leitura no instante da digitação.

#### As ações saíram da tela
Formulários abertos: `processo_ficha` **7 → 0**, `turma_ficha` **14 → 3**,
`epis_requisicao_ficha` **10 → 0**, `parecer_editor` **8 → 1**, `adicionais`
**6 → 0**, `laudo_ficha` **3 → 0**, `servidor_ficha` **2 → 0**. São 59 popups de
cadastro, 9 gavetas e 65 (i) no sistema.

**Isto contraria uma decisão tomada há dois dias** — "ficha não vira popup, porque
o formulário compõe o registro e é usado várias vezes seguidas". O dono repetiu o
pedido em outras palavras, e a decisão é dele. Mas o custo que motivara aquela
escolha era real, e a resposta foi de desenho, não de exceção: **na linha, o que
virou camada foi a gaveta inteira, não cada ação dentro dela**. Medido, num pedido
de cinco itens: antes 12 cliques, agora 14 — os dois a mais são de envelope, e o
**custo por item não mudou**. Um popup por ação teria dado 19, mais um clique por
item para sempre.

**O editor de parecer não virou camada**, e o argumento está escrito no arquivo: a
coluna da direita existe para ser lida **ao mesmo tempo** que o formulário — a
Validação diz o que falta enquanto se preenche, a Pré-visualização mostra o que
sai no `.docx`. Uma modal cobriria as duas. Viraram camada só as ações que
orbitam.

**O par da turma foi resolvido sem se quebrar**: "Cadastrar participante externo"
e "Inscrever quem já está na base" eram lidos juntos — procure primeiro, cadastre
só se não achar. Viraram um cartão só, com o cadastro no pé da busca. A ordem que
dependia do olho virou estrutura.

#### O resultado, medido
**Prosa visível na tela, no sistema inteiro: 32.771 → 12.405 caracteres.** E a
distribuição ficou plana — a tela mais carregada tem hoje **938 caracteres**;
antes as três primeiras tinham 3.831, 3.677 e 3.397.

Altura do documento, mesmo dado dos dois lados, em 1366×768:

| tela | antes | depois | |
|---|---|---|---|
| ficha do pedido de EPI | 2337px | **1411px** | −40% |
| editor de parecer | 4124px | **3040px** | −26% |
| ficha da turma | 1247px | **909px** | −27% |

Nenhum popup rola: o corpo mais alto tem 552px contra 577 visíveis.

**Suíte: 1839 passados, 1 pulado.** Três testes tiveram o mecanismo atualizado —
o invariante de cada um é idêntico e um deles ficou mais forte (passou a conferir
**qual** linha volta com a gaveta aberta).

## [1.32.0] — 2026-08-23

### O sistema passa a atender a rede do setor
De um operador na própria máquina para as estações da CSSO. **O dado não muda de
lugar** — mesmo disco, mesmo controlador —, e é isso que faz o passo caber sem
base legal nova. O que muda é quem alcança a porta, e três coisas tinham de mudar
antes de o primeiro colega conseguir entrar.

#### O cookie que trancaria todo mundo do lado de fora
O `LEIA-ME` mandava pôr `CSSO_HOST=0.0.0.0` **dizendo que "nenhuma linha de código
muda"**. Mudava: o atributo `Secure` do cookie era decidido pelo endereço de
ligação, então sair do `127.0.0.1` marcava o cookie como `Secure` sem haver TLS, o
navegador parava de devolvê-lo, e **ninguém entrava** — o login parecia dar certo
e voltava para a tela de entrada, sem mensagem nenhuma.

O endereço de ligação **não sabe** se a conexão é segura; quem sabe é a
requisição. A decisão passou a sair do esquema efetivo — que é onde o
`X-Forwarded-Proto` já chega corrigido, e por isso o cabeçalho **não** é lido à
mão: duas leituras divergiriam. Os dois pontos que duplicavam o cálculo agora
chamam a mesma função.

Há saída explícita (`CSSO_COOKIE_SEGURO`) para o ponto cego real — TLS num proxy
que o servidor não confia. **O padrão falha para o lado que deixa entrar**, e quem
escolher o outro lado lê isso escrito em três lugares antes de descobrir pelo
laço: no `/saude`, no console do `INICIAR.bat` e numa faixa no alto de toda tela.

#### A conversão de PDF segurava o lock de escrita — a terceira vez que este
#### sistema tropeça na mesma pedra
A emissão convertia o documento **com a transação aberta**, e o LibreOffice leva
segundos. Como o `BEGIN IMMEDIATE` toma o lock já na leitura do cookie, quem
emitia bloqueava todo mundo.

Medido, com uma pessoa emitindo e as outras só abrindo uma tela: **a partir da
segunda pessoa, todas travavam** — 5 de 5 com `database is locked`, esperando os
5 s inteiros do `busy_timeout`. A retenção do lock ia a **4.203 ms**. Depois:
**141–391 ms, e o tempo parou de depender do LibreOffice.** Zero falhas com 8
pessoas.

É a mesma doença de duas correções anteriores — o sino de pendências e o
`wal_checkpoint` do backup —, e por isso o conserto veio com uma trava: uma
varredura de AST que falha se alguém chamar a conversão direto de dentro de
requisição. **Este defeito não deixa rastro**: nada quebra, e a tela até fica mais
rápida para quem emite; ele só aparece na tela dos outros. Nenhum teste funcional
o pegaria.

A janela de "converteu depois do commit e falhou" **não é nova** — numa máquina
sem LibreOffice toda emissão sempre terminou assim. Desfazer seria pior: abriria
buraco na sequência (RN-03) e apagaria eventos encadeados. O PDF é renderização
derivada do contexto congelado e se refaz sem consumir número; quando a máquina
tem LibreOffice e mesmo assim falha, entra `PDF_NAO_GERADO` na trilha.

#### Cabeçalhos de segurança, e o que a CSP realmente quebrava
As respostas traziam **só `content-length` e `content-type`**. Agora há CSP,
`X-Content-Type-Options`, `Referrer-Policy` e controle de enquadramento.

`script-src` ficou **sem `'unsafe-inline'`**, com nonce por resposta; três
atributos `on*=` viraram tratadores delegados, porque nonce não alcança atributo
de evento. E a medição achou um obstáculo que ninguém tinha contado: **o próprio
HTMX injeta um `<style>` ao carregar**. Era o único recurso que a política de fato
quebrava — e como ele não pinta nada aqui, foi desligado por configuração.

O único afrouxamento é no estilo, e está cercado: `style-src-elem 'self'` com o
`'unsafe-inline'` sobrevivendo só no `style-src` de recuo, para que navegador
velho não desmonte a tela. Estilo embutido, sem script frouxo, rende exfiltração
por seletor — não execução.

#### Registro de acesso, e o que ele deliberadamente não guarda
Não havia nenhum. Com a equipe na rede, investigar incidente exige saber quem
chamou o quê, de onde e quando (LGPD art. 37).

**O caminho vai na forma da rota — `/servidores/{servidor_id}`, nunca
`/servidores/12`.** O par (IP, 12) num arquivo de texto é exatamente o cruzamento
que a supressão de identificação existe para impedir, e não se perde investigação:
quem leu a ficha de quem já é registrado com titular e finalidade, sob RBAC e sob
a cifra do backup — e quatro mil linhas de `/anexos/{id}` da mesma conta em dois
minutos são inconfundíveis sem nenhum id. **URL que não casa rota sai como `-`**:
é texto livre de quem chamou, e bastaria pedir `/fulano-tem-insalubridade` para
plantar frase nominal no arquivo. Sem query string, sem corpo, e sem o `login`,
que é `nome.sobrenome` — corrigido junto um ponto que já o escrevia em log.

Retenção de 90 dias, o mesmo prazo de `sessao` e pelo mesmo motivo (o IP), e aqui
**cumprida pelo mecanismo**, não só declarada.

#### `GET /config/exportar-tudo` virou POST
Com `SameSite=lax` o cookie vai em navegação de topo, então uma página externa
podia fazer o navegador de quem tem `exportar` gerar o pacote — que sai em claro,
com o banco, os CSVs nominais e todos os comprovantes assinados. Numa máquina só
era teórico. Com a equipe na rede, não era.

#### Documentação
O `LEIA-ME` teve a seção de rede reescrita, com o desmentido explícito do "nenhuma
linha de código muda". E `entrada/implantacao/01_REDE_DO_SETOR.md` traz o passo a
passo para quem vai executar — com o que se deve ver em cada passo, e uma seção
"Quando dá errado" que abre pelo laço de login.

ROPA na versão 1.4 e política de retenção emendada **antes** do passo, não depois:
categoria de dado nova, prazo, e o registro de que a conexão não é criptografada.

**Suíte: 1818 passados, 1 pulado.**

## [1.31.0] — 2026-08-23

> **Ao subir esta versão, quem estiver logado cai uma vez.** É esperado: o token
> de sessão passou a ser assinado com `CSSO_CHAVE_SECRETA`, e as sessões antigas
> não conferem com a assinatura nova. Basta entrar de novo.

### O anexo passou a herdar a autorização de quem o carrega
Levantado por uma auditoria de prontidão pedida para avaliar tirar o sistema do
`localhost` — e **este defeito não tinha nada a ver com a rede: estava valendo na
máquina do setor.**

`GET /anexos/{id}` exigia **só estar logado**. Apenas anexo marcado `RESTRITO`
cobrava permissão; todo o resto saía livre por enumeração do id inteiro, **sem
registro de acesso**. Foi medido: `almoxarife_sesmt` e `servidor_consulta`
baixavam **o parecer assinado de qualquer servidor**. O `servidor_consulta` existe
para o titular consultar o próprio processo (LGPD art. 18, II) — e lia o de todos.

O que torna isso grave neste sistema em particular: o parecer **nomeia um servidor
e descreve a exposição dele a agente nocivo**, e é o documento que fundamenta o
adicional. O comprovante de EPI carrega **assinatura manuscrita digitalizada**,
que o `ROPA.md` classifica como o item mais sensível do módulo.

**A correção não foi apertar o nível de acesso — foi tirar dele a decisão.** O
`nivel_acesso` sempre quis dizer **retenção**, e era ele que liberava o parecer
assinado. Agora o anexo **não tem autorização própria: herda a do dono**.
`entidade` + `entidade_id` resolvem quem o carrega, e cada dono delega à regra que
já governa a tela dele — processo, parecer, ficha de EPI, certificado. Entidade
sem resolvedor **nega**, inclusive para a coordenação: regra que não existe não
pode ser permissiva por omissão.

Duas funções de autorização que viviam dentro de rotas foram para o serviço, para
que o download e a tela usem **a mesma**, e não duas que divergiriam na primeira
correção.

**A recusa é uma só para os quatro casos** — id inexistente, anexo desativado,
dono fora do escopo, entidade sem regra. Responder 404 num e 403 noutro devolveria
a enumeração pela porta dos fundos: quem varre `1, 2, 3…` deixaria de baixar o
parecer e passaria a **descobrir quantos existem e de que tipo**, e "este id existe
e você não pode" já é informação sobre a pessoa por trás dele.

**O registro de acesso passou a valer para todo anexo**, não só para o `RESTRITO`,
e a porta de trás do comprovante de EPI — que gravava `servidor_id=None` e
finalidade genérica — acabou. Registro que não diz de quem é o dado lido não
sustenta investigação nenhuma (LGPD art. 37). A trilha encadeada ganhou
`ANEXO_BAIXADO`, que responde **qual arquivo** saiu.

O teste varre **os 11 perfis contra os 5 donos** e exige que o download responda
exatamente o que a tela do dono responde — mais a sonda, que monta uma porta
deliberadamente aberta e cobra que a varredura a pegue.

### `/saude` deixou de contar a versão a quem não entrou
E `/saude/db`, que rodava `integrity_check` **sem login e segurando o lock de
escrita** (248 ms num banco de 16,7 MB), passou a exigir permissão e a soltar o
lock antes de verificar. Era negação de serviço de graça.

### `CSSO_CHAVE_SECRETA` não assinava nada — e o `/saude` dizia que ela importava
Conferido: o campo aparecia em `config.py` e no aviso "ainda é o valor de
exemplo", e **nada no sistema o lia**. Quem trocou a chave achando que fortalecia
a sessão não fortaleceu nada.

O defeito não era a chave ser inútil; era o aviso **afirmar que ela protegia
alguma coisa**. Aviso de saúde que mente é pior que aviso nenhum, porque produz
confiança que não se paga.

**A chave foi ligada, não removida**: o token de sessão passou de SHA-256 puro a
HMAC-SHA256 com ela. O ganho não é sigilo — 48 bytes de `token_urlsafe` já são
aleatórios demais para o digest ser invertido. O ganho é passar a **existir algo
que se rotacione depois de um incidente**: trocar a chave derruba toda sessão de
todo mundo no ato, sem tocar no banco. O `LEIA-ME` sempre mandou trocá-la ao pôr o
sistema na rede; agora isso faz alguma coisa.

### O backup restaurava a ficha e perdia o comprovante
`exportar` levava só o banco. Restaurar devolvia a linha da ficha de EPI **sem o
PDF assinado** e o parecer sem o documento — a metade que não prova nada, no
sistema cuja razão de existir é a prova.

Agora o pacote leva `anexos/` e `documentos/`, e **o arquivo cifrado encolheu**:
de 835.636 para 381.217 bytes, porque o recheio passou a ser deflacionado e antes
era o `.db` cru. Levar os anexos ficou mais barato que não levar. Os `.enc`
antigos continuam restaurando — há teste.

O teste de restauração foi estendido para **apagar o banco e o arquivo**, restaurar,
e exigir que o `sha256` do arquivo restaurado confira com o que o banco declara.
Um teste que só conferisse existência passaria com PDF truncado.

**O `EXPORTAR-TUDO` continua em claro, e agora a tela diz isso.** Ele existe para
um critério declarado — "desligue o sistema para sempre; com este zip o setor
trabalha amanhã" — e cifrá-lo com a senha que mora na mesma máquina não protegeria
nada e destruiria a única função que justifica o botão. O defeito de verdade estava
na tela, que anunciava "o arquivo sai cifrado" **para os dois botões**. Agora cada
um declara o que produz.

### Trocar a própria senha derruba as outras sessões
O reset por administrador já revogava; a autotroca, não. Quem trocava a senha
porque desconfiava que alguém a tinha visto continuava com a sessão do outro
aberta. A sessão de quem troca sobrevive — expulsar a própria pessoa no ato
ensinaria a não trocar senha.

**Suíte: 1765 passados, 1 pulado.**

## [1.30.0] — 2026-08-23

### Rebranding: identidade nova, e sete reprovações de contraste que ninguém tinha visto
A pedido do dono. O registro foi decidido antes de mexer numa cor: **institucional,
sóbrio, de altíssima legibilidade**. Este sistema emite parecer que fundamenta
adicional de insalubridade e ficha que é prova de entrega em fiscalização — cara
de startup enfraquece o documento. A personalidade vem de proporção, ritmo e
contenção, não de cor forte.

A folha tinha **45 tokens bem nomeados e ~400 chamadas `var()` em 62 templates**,
e foi isso que tornou o rebranding barato e seguro: **trocaram-se os valores,
nenhum nome**. Nome novo obrigaria a varrer 62 templates; valor novo muda o
sistema inteiro de uma vez.

**A paleta virou sistema, e cada decisão nasceu de defeito medido:**
- **Uma matiz, degraus regulares.** Havia cinco superfícies dentro de 1,5 ponto de
  L\* — `--papel` e `--neutra-fundo` diferiam por **0,08**, e a consequência era a
  pílula neutra sobre o papel em **1,00:1**, isto é, invisível.
- **As quatro famílias no mesmo peso.** Estavam em 8,56 / 7,40 / 6,39 / 5,32 sobre
  o cartão: numa fila de pílulas o verde recuava e o vermelho gritava **sem
  ninguém ter decidido isso**. Agora as quatro em ~8,05:1.
- **A borda que limita um controle passou a ser visível** (WCAG 1.4.11): de
  **1,26:1** para 3,57:1.

**Os 66 pares frente/fundo que a folha usa foram calculados um a um, e nenhum
regrediu.** A tinta principal subiu de 16,38 para 18,84; a fraca, de 5,50 para
9,20.

**E apareceram sete reprovações que a passagem da 1.27.0 não viu — porque conferiu
fundos claros, e estas estão na lateral escura.** `.rotulo-secao` em 3,06:1, o
rodapé em 3,96:1, a versão em 3,06:1, tudo por causa de **nove opacidades de
branco sem nome nenhum**; viraram tokens e foram a 6,52. Mais: a chapa do item
ativo (1,92 → 9,10, invertida para chapa clara com tinta escura), a barra do
gráfico de meses (1,19 → 4,70) e — a mais irônica — **a borda do campo recusado,
que era a mais fraca da tela em 1,46 e agora é a mais forte em 9,72**.

**Tipografia**: duas rampas com razão declarada, no lugar de **vinte tamanhos, seis
deles com meio pixel**. `h3` subiu de 14 para 15 — era *menor* que o texto que
encabeça. **Forma**: quatro raios com degrau de 2px, e o cartão passa a ser
definido pelo fio, não pela sombra.

**A marca** é SVG embutido de um caminho só, em `currentColor`: serve branca na
lateral, azul no papel e preta na impressora monocromática. **Não é brasão nem
identidade oficial da UFVJM** — marca de universidade federal é ato de quem tem
competência para isso, e inventar uma seria falsificação institucional. O lugar do
brasão oficial está **reservado e dimensionado**, à esquerda e separado por um
fio: instituição primeiro, sistema depois, como em papel timbrado.

**Modo escuro foi recomendado e não feito**, de propósito: os 66 pares virariam
132, a lateral escura deixa de contrastar com a área útil, e a prévia do parecer
não pode inverter. O caminho ficou aberto — nenhuma cor de interface fora do
`:root`, salvo três literais deliberadas e comentadas.

### Melhorias gerais: a tabela, o trabalho repetitivo e o acesso
**`<thead>` e `scope` nas 89 tabelas.** Eram **zero de cada um**, e isso tirava
três coisas do sistema. Medido: `position: sticky` num `<th>` solto **não gruda** —
o topo vai parar a −503px —, dentro de `<thead>` gruda em 62px; **no papel, o
navegador só repete cabeçalho que esteja em `<thead>`**, e a guia de entrega tem
sete colunas de números que chegavam sem nome na página 2 do documento que
circula no balcão; e `scope` é o que faz o leitor de tela dizer de que coluna é a
célula — o que mais rende na grade de presença, que tem uma coluna por dia de
aula.

**Colunas de conferência em `.numerico`** — direita, mono e dígito de largura
fixa. As quatro do estoque primeiro: aquela tela existe para bater contra a
contagem da prateleira, e numa coluna à esquerda `9` e `148` não terminam no
mesmo lugar.

**Presença e decisão de item passaram a trocar só a linha.** Uma turma de 30
pessoas × 5 dias eram **150 recargas de página**. A infraestrutura de HTMX estava
pronta desde a 1.27.0 e ociosa. Um `<tbody>` por linha, e não um em volta da grade:
medido, um `outerHTML` sobre o `<tr>` deixa o tratador global realçando um nó já
desligado do documento, e a troca sai sem nenhum sinal de que algo mudou.

**O `<select>` com o cadastro inteiro saiu do balcão.** Com um servidor no banco
não custava nada; com **745 cartões de Trello e 975 linhas de planilha** esperando
importação, custaria. Virou busca por HTMX — e sem JavaScript o `<select>`
completo continua lá, então nada se perde.

**O CNPJ que truncava em silêncio.** `maxlength="14"` num campo preenchido copiando
de nota fiscal, onde o CNPJ vem formatado com 18 caracteres, e **sem normalização
no servidor**: aceitava, cortava, gravava truncado e não avisava ninguém. Era o
único dos dez achados que **corrompia dado**.

Junto: filtros de `/processos` em `<details>` (a 1366×641 aquela tela mostrava **4
das 50 linhas**; sem o cartão, 8), barra de ações em lote grudada no rodapé, estado
vazio nas listas que faltavam, ~15 atributos de entrada em campos de código, salto
para o conteúdo, suporte a `forced-colors` e três glifos em SVG — **só três**, que
a política do sistema é texto inequívoco.

**A lista de pendência que existia para ser apagada foi apagada.** Sete tabelas
ficaram de fora da passada geral porque os dois arquivos estavam sendo reescritos
noutra frente ao mesmo tempo, e marcação escrita por duas mãos é conflito
garantido. A guarda foi escrita **por continência**, para continuar passando
quando elas fechassem. Fecharam, e agora as duas varreduras valem para o diretório
inteiro, **sem isenção nenhuma**.

**Suíte: 1739 passados, 1 pulado.** A folha continua com **uma única
`!important`**, que é a que esconde o popup na impressão.

## [1.29.0] — 2026-08-21

### A busca atravessa o sistema, o backup ganha porta, e o formulário que não cabia saiu do popup
Três recomendações que estavam em `PENDENCIAS.md` esperando a palavra do dono.

#### A busca deixou de ser só de processo
A caixa do cabeçalho chegou a prometer "Buscar servidor, nº SEI, laudo…" e
entregar lista vazia para servidor sem processo; na 1.27.0 o rótulo foi corrigido
para dizer a verdade, e a caixa passou a aparecer só para quem tem
`processo.ver`. Era honesto e era pouco: **o almoxarife não tinha `Ctrl+K`
nenhum.**

Agora `/buscar` cobre seis entidades — servidor, processo, laudo, requisição de
EPI, turma e certificado —, **cada bloco guardado pela permissão que a sua rota
de destino exige**. A tela não exige permissão nenhuma, de propósito: a permissão
vive nos blocos, que é onde ela pode negar alguma coisa, e um 403 na tela inteira
devolveria ao almoxarife exatamente o campo de texto que responde "acesso
negado". Sem nenhum bloco visível, a tela abre e diz isso em português.

**O que fica de fora não é nomeado.** Dizer "há um bloco de laudos que você não
vê" já é dizer que há laudos. A tela conta onde procurou — não onde não procurou.

**Não grava `acesso_dado_sensivel`, e é decisão, não esquecimento.** A RN-23
registra a leitura do dado sensível, e é por isso que `/servidores/{id}` e
`/epis/fichas/{id}` gravam; nenhuma lista grava. Três razões: o que se registra é
a porta, não o índice, e quem achou o nome aqui ainda vai clicar numa rota que já
conta; registrar tudo afogaria as leituras de verdade em ruído, e diluir a trilha
é custo de privacidade, não ganho; e a gravação abriria transação de escrita
(`BEGIN IMMEDIATE`) na tela mais acionada do sistema, disputando o lock com quem
está gravando um parecer.

Quem digita algo com cara de CPF recebe um recado: o sistema não armazena CPF, e
a caixa não pode sugerir que armazena.

#### Quem faz backup alcança a tela do backup
`/config` exigia `processo.ver`, e `admin_ti` — o único perfil que existe para o
backup — não a tem. A rota passou a aceitar `("processo.ver", "backup.executar")`,
e a tela **se reparte**: os cartões de processo continuam pedindo `processo.ver`,
os de máquina abrem para quem opera a máquina. Abrir demais é tão defeito quanto
trancar demais. O item de menu segue exatamente a mesma tupla, que é o invariante
que impede menu de oferecer porta trancada.

#### A entrada de lote virou página
É o **único cadastro do sistema que não é popup**, e a exceção tem número:
dezenove campos, e mesmo na variante larga o corpo pedia **864px contra os 577
visíveis** de um 1366×768 — uma tela e meia de rolagem dentro da camada, que é a
única coisa de que um diálogo não dispõe. O pedido que criou os popups continua
atendido, porque o que ele pedia era que **a lista deixasse de carregar o
formulário**, e a página dedicada faz isso igual.

A lista ficou mais leve do que só perder o formulário: a consulta ao catálogo de
EPI existia apenas para preencher o `<select>` do popup, e morreu junto — quem
abre aquela tela vem conferir saldo.

Os campos foram reagrupados pelo que a pessoa tem na mão: o que vem da **nota
fiscal e do empenho** é uma leitura, o que vem da **etiqueta do equipamento** (CA,
validade, tamanho) é outra. Quem digita alterna entre dois papéis na mesa, e a
ordem dos campos passou a seguir isso em vez da ordem das colunas do banco. E a
recusa continua devolvendo os dezenove campos preenchidos, com o foco no que
errou — conquista da 1.27.0 que sobreviveu a duas mudanças de casa.

#### Uma guarda de privacidade que acusava a própria prosa
`test_rn19_nenhum_template_le_nome_de_servidor_direto` reprovou `busca.html` por
ler `servidor.nome` — e a ocorrência estava **dentro do comentário que explica a
regra**, que escreve a expressão proibida no meio da frase. A guarda passou a
descartar comentário Jinja antes de varrer, o que é estritamente correto:
comentário não chega a página nenhuma e não pode vazar nada.

O caminho errado seria dispensar o arquivo — a tela de busca é justamente onde
vazamento de nome mais importa, e ela ficaria sem guarda por causa de um
comentário. E como afrouxar guarda de privacidade é barato demais para ficar sem
prova, ela ganhou uma **sonda**: a varredura tem de continuar acusando
`{{ servidor.nome }}`, `{{ p.servidor.siape }}` e `{{ sv.nome }}`, e tem de
acusar o código de verdade mesmo quando há um comentário ao lado servindo de
esconderijo. Guarda que deixou de acusar não avisa ninguém: ela passa, e o
silêncio se lê como "está tudo certo".

## [1.28.0] — 2026-08-21

### Cadastro entra por popup: a tela de lista deixa de carregar o formulário
A pedido do dono do sistema. **20 popups em 11 telas** — e a parte difícil não foi
abrir a caixa, foi não desfazer o que a 1.27.0 tinha acabado de consertar.

**O que virou popup, e o que deliberadamente não virou.** Só o formulário que
**cria registro novo** e que hoje ficava aberto ocupando a tela. Continuam como
estavam: a **edição em linha** de registro existente (`catalogo_lista.html` tem 18
formulários, quase todos assim — ali o formulário aberto *é* o recurso, e a
auditoria de ergonomia elogiou o padrão); as **ações de trâmite** (aprovar,
recusar, reservar, entregar, concluir, emitir); e as **páginas dedicadas** cujo
formulário é a tela inteira. A regra que separou os casos: **tela de lista ganha
popup; ficha de um registro, não** — na ficha o formulário compõe aquele registro
e é usado várias vezes seguidas, e o popup cobraria um clique a mais por linha,
tirando da vista justamente a lista de onde a próxima linha é lida.

**O popup funciona sem JavaScript, e isso decidiu a técnica.** `showModal()` é
script, e um `<dialog>` sem `open` é invisível — depender só dele não deixaria o
cadastro feio sem script, deixaria **impossível**. Então o botão é um link para o
`id` do diálogo, a folha abre em `:target`, a recusa volta com `open` escrito pelo
servidor, e o `<dialog>` é a **camada** enquanto o `<form>` é a caixa — é isso que
dá aparência idêntica nos dois caminhos, já que `::backdrop` só existe depois de
`showModal()`. Havendo script, o clique vira `showModal()` e ganha camada de topo,
`Esc` e foco preso.

**A recusa reabre o popup com o que foi digitado**, o erro dentro dele e o foco no
campo do problema — **sem JavaScript também**. Sem isso, a 1.27.0 seria desfeita
em silêncio: o popup fecharia e levaria junto os treze campos. Onze rotas ganharam
`digitado`; duas delas (`/servidores` e `/laudos`) **trocavam a lista inteira pela
tela de erro do sistema**, e o "voltar" do navegador não devolve POST.

**Duas larguras, e o número tem razão de ser.** A largura única de 720px cabe três
campos por linha; os formulários de compra pública têm cinco, que quebravam em 3+2
e **dobravam de altura**. A variante larga é **1062px** porque essa é a área útil
de conteúdo a 1366px, a tela do setor (1366 − 252 da lateral − 52 de recuo): o
popup cobre exatamente a coluna que a pessoa estava lendo, e não mais que ela. Em
1920 ele não estica. Medido em navegador real: abrir turma caiu de 722px para 609,
cadastrar EPI de 843 para 613. A largura é parâmetro do macro, nunca `style=` na
tela — foi `style=` embutido que produziu a deriva de largura fechada na 1.27.0.

**O foco não voltava ao botão ao fechar, e a causa não era a que parecia.** O
código de devolução existia, ligado ao evento `close` do `<dialog>` — que é onde a
especificação põe o assunto e **onde ele não dispara**. Medido em Chrome 148 e
151, no diálogo, na captura do documento e em `onclose`, com controle no `toggle`
de um `<details>` para provar que não era instrumentação. O requisito existia só no
código. Agora os dois caminhos de fechar passam por uma função só. Sem script o
fechamento é âncora, e restaurar foco é por definição ação de script — o que
mitiga é o × e o Cancelar serem links visíveis e alcançáveis por Tab.

**Três defeitos caíram junto**, todos porque o popup se propôs a funcionar sem
script: "Conceder perfil" reescrevia o `action` em JavaScript, e sem script a
concessão ia para o id 0 e morria em violação de chave estrangeira; `ato_normativo`
com espaço passava pelo `required` e gravava concessão sem autorização; e um
`{#…#}` dentro do exemplo de uso do macro derrubava `macros.html` inteiro,
devolvendo 500 em toda tela que o importa — o Jinja não aninha comentários, e nada
parecia errado a olho nu.

**Cinco varreduras de invariante** protegem o padrão de nascer torto no próximo
módulo: todo botão tem o popup que ele abre e vice-versa; nenhuma tela escreve
`<dialog>` à mão; nenhuma tela escreve largura; linha de cinco campos usa a
variante larga; e todo template compila.

**Uma medição que pede decisão do dono:** a entrada de lote tem 19 campos e, mesmo
larga, precisa de **864px contra os 577 visíveis** — 1,5 tela de rolagem dentro do
popup, e só caberia num monitor de 1057px de altura útil, que não existe no parque.
É o formulário mais caro de redigitar do módulo. A recomendação é convertê-lo em
página dedicada `/epis/estoque/nova-entrada`, que atende o mesmo pedido — a lista
deixa de carregar o formulário — e já é padrão da casa. Não foi convertido: a
escolha é do dono.

**Suíte: 1695 passados, 1 pulado.**

## [1.27.0] — 2026-08-21

### Auditoria de ergonomia: o sistema para de desorientar quem o usa
O dono do sistema disse que ele estava *"confuso, com telas repetindo, não
amigável, não intuitivo"*. Quatro auditorias independentes — inventário,
navegação, consistência visual e interação — levantaram o porquê, com evidência
linha a linha. Os relatórios ficam em `entrada/ux/`.

**O diagnóstico contrariou a suspeita.** O redesenho de `entrada/redesign/` foi
aplicado **por inteiro**: os sete lotes fecharam entre a 1.13.0 e a 1.19.0, os 39
tokens existem, 204 das 207 classes são usadas, e há **zero `!important`** em
1.634 declarações. O CSS não era o problema. Duas coisas eram: o módulo de EPI
nasceu depois, sem maquete, imitando padrões — e a imitação derivou; e a
navegação mentia sobre onde a pessoa estava.

#### A navegação mentia, e era a causa principal
O seletor de módulo apontava para o **mapa**, não para o módulo. Lá o
`modulo_ativo()` não casava nada, caía no padrão `PROCESSOS_SEI`, e clicar em
"Gestão de EPI" deixava o seletor escrito "Processos SEI". Agora ele leva à
**primeira tela daquele módulo que abre para aquela pessoa**: trocar de módulo
passou de 3 cliques para 1.

E sair do módulo para a base apagava o módulo da lateral — quem estava em
`/epis/fichas/12` e clicava "Ver o cadastro" perdia as oito telas de EPI, a 3
cliques de distância. A correção não foi mentir menos: `modulo_ativo()` continua
devolvendo `None` na base, porque **a base não é de módulo nenhum e isso é fato**.
O que mudou foi quem responde "qual menu mostrar" — a origem, preservada. A
lateral tem dois blocos que respondem a duas perguntas diferentes ("qual é o seu
trabalho" e "onde você está agora"), e o defeito nunca foi haver um módulo no
bloco de cima: foi ele ser **inventado**.

**O almoxarife tomava 403 na porta da frente.** O login mandava para `/`, que
exige `processo.ver`, que o perfil `almoxarife_sesmt` não tem — e a marca da
lateral era 403 em toda tela. Nasceu `/inicio`, um despachante que leva cada
pessoa à primeira tela que ela pode abrir. O teste que devia ter pego isso
**excluía `/` da parametrização**: o único item fora do invariante era o único que
o violava. O buraco está fechado.

**`/config` não tinha porta nenhuma** — nenhum menu, nenhum link, só quem digita
a URL. Guarda o SLA que pinta o vermelho de todas as listas, o backup cifrado e a
exportação total.

**A busca global prometia servidor e entregava processo.** Agora diz o que faz.
A busca que atravessa o sistema está desenhada e anotada; é funcionalidade, não
conserto, e virá inteira.

**A trilha do EPI oferecia porta trancada** — e o invariante que o sistema já
aplicava ao menu e ao sino nunca fora aplicado às trilhas escritas à mão. Agora
um teste renderiza 27 telas para 5 perfis, extrai todo `href` de dentro da trilha
e cobra que abra.

#### Um defeito de privacidade achado de passagem
O macro `distribuicao` estava **copiado três vezes**, e a cópia do painel
entregava **contagem crua, sem supressão**, sob permissão mais larga que as
outras duas. Mesma classe de defeito que a 1.26.0 corrigira do lado Python, uma
semana depois de o sistema aprender a lição. Implementação única agora, reusando
a função Python que já decide — decidir supressão em Jinja seria a terceira
implementação.

E **três números do mesmo fato discordavam lado a lado na tela de entrada**: o
KPI contava todos os processos, o cartão ao lado usava outro critério sobre a
primeira página de 50 (o contador nunca passava de 8), e o link levava a uma lista
com um terceiro critério. Um fato, uma função, e o link leva à lista que o número
conta.

#### Recusa saía no banner verde de sucesso
"Informe a data de início" e "Ninguém apto a emitir nesta turma" apareciam
pintadas como se tivessem dado certo. Corrigido em sete arquivos de rota, e o que
impede a volta é um invariante: **toda rota GET que aceita `mensagem` tem de
aceitar `erro`**.

#### Sete formulários grandes apagavam tudo no erro
Nova requisição de EPI, nova turma, entrega de balcão, entrada de lote, recusa
fundamentada — e o `/login`. Quem digitou treze campos e perdeu tudo por uma data
mal formatada não repete o trabalho com paciência: **contorna o sistema**. O
conserto já existia pronto na casa e foi replicado, sem inventar variação. A senha
nunca volta preenchida; só o e-mail.

Junto vieram as três rotas de edição do rascunho, em que o padrão precisou de
mais: o `rollback` que a recusa exige devolvia ao banco o texto **anterior**, e o
redirecionamento reescrevia a versão velha por cima do parágrafo recém-digitado —
apagava sem dizer que apagou.

#### Nenhuma ação destrutiva pedia confirmação. Nenhuma, no sistema inteiro
"Excluir rascunho" ficava colado em "Enviar pedido"; "Emitir em lote" consumia N
números de sequência sem dizer quantos; "Concluir turma", irreversível, tinha a
classe de botão **menos** enfática. As confirmações seguem o padrão que já
existia — o botão leva ao formulário — e cada uma diz **quantos**, **o quê** e **o
que não volta**. Confirmação genérica treina a pessoa a clicar em "sim" sem ler, e
aí não protege nada.

#### HTMX e kanban falhavam em silêncio
Sem indicação de carga, sem tratador de erro, e a recusa do kanban nascia numa
caixa fixa no topo — fora da tela quando o cartão era solto embaixo. Era a causa
mais provável de "o sistema não fez nada" quando ele tinha feito. Agora os três
estados são tratados globalmente, e não por elemento: a omissão era o defeito, e
`hx-indicator` obrigaria quem escrevesse o quinto uso a lembrar.

#### A língua
`ROTULO_ESTADO` escrevia "Nao iniciado" e "Concluido" na tela mais vista do
sistema — e o ASCII tinha motivo: aquele texto entra no **digest encadeado da
auditoria**, e reescrevê-lo quebraria a conferência de eventos já gravados. Então
a chave ficou e nasceu `ROTULO_ESTADO_TELA` ao lado. E `tipo_evento` aparecia
cru — `PROCESSO_CRIADO`, `NUMERO_DEFINIDO_MANUALMENTE` — em quatro telas: 109
rótulos agora, levantados por varredura AST do código, porque foi lista paralela
que deixou o defeito durar. A tela forense da auditoria continua crua **de
propósito**.

#### Acessibilidade e papel
`--tinta-dica` dava **3,50:1** — abaixo do mínimo — e é o rótulo de toda linha de
dados, o cabeçalho de toda tabela longa e todo `placeholder`. Passou para 5,01, o
que **diverge da maquete de propósito**, com os números escritos no comentário do
token. Junto caíram uma cor de 3,12 e outra de **1,94**.

**68 rótulos não tinham `for=`** — clicar não focava, leitor de tela não
anunciava. Hoje são **386 rótulos e zero órfãos**, com teste de varredura que
falha se algum voltar.

E a impressão cortava justamente o que o papel existe para levar: a guia de
entrega perdia a coluna "Decisão". Achado no caminho: o bloco `@media print`
estava **antes** das faixas de largura, e `@media print` não as desliga — o
navegador monta a página impressa em ~688px, abaixo do ponto de 900px, que
remontava a lateral que o papel acabara de desmontar.

#### A deriva do EPI, fechada
Dois idiomas de filtro viraram um — e o escolhido foi **o do EPI**, não o antigo:
a fila de EPI levou mais longe o princípio de que número que não se pode abrir é
número que ninguém confere, e `/laudos`, a única lista longa sem recorte nenhum,
recebeu esse padrão. Três telas de EPI tinham copiado a **busca global do
cabeçalho** para dentro da página: duas coisas diferentes com a mesma aparência, e
acopladas. As 19 cores literais fecharam em 6 tokens novos, com duas exceções
documentadas. E na ficha de requisição, catorze linhas de peso idêntico viraram
dois blocos com nome, o protocolo saiu (era a quarta cópia da mesma informação na
mesma tela) e o próximo passo subiu para o cartão de destaque — que existia
desde o redesenho e era usado **uma vez em todo o sistema**.

**Suíte: 1654 passados, 1 pulado.** Eram 1575 antes da auditoria.

## [1.26.0] — 2026-08-20

### Gestão de EPI, fatia 7 — o módulo fecha: painel, troca devida e indicadores
Última fatia. O painel `/epis` nasceu inteiro, a RN-32 saiu do papel, e os
indicadores entraram com uma correção que vale para o sistema todo.

**A supressão estatística não protegia margem — e agora protege.** O `suprimir`
que existia trata **uma distribuição isolada** e pressupõe que nenhum total seja
publicado ao lado; funcionava em `/relatorios` só porque o contador daquela tela
é o número de unidades, não a soma delas. Publicar "Campus JK: 12" ao lado de
"IECT: 9 · ICA: —" devolve a célula escondida por uma subtração de cabeça. Somar
célula pequena com margem intacta é a forma mais comum de reidentificação
acidental em indicador, e a mais difícil de enxergar: **cada tabela, olhada
sozinha, parece certa.** `suprimir_aninhado` fecha as três portas — secundária
dentro do grupo, total suprimido não convive com folha visível, e nunca um total
sozinho. A regra secundária foi extraída para uma implementação só, porque duas
cópias divergiriam na primeira correção.

Duas decisões que vieram junto: **a célula conta servidores distintos, não
peças** — "12 pares na Odontologia" passa em qualquer limiar e pode ser uma
pessoa só, e o limiar de cinco é sobre gente. E **custo por empenho não é
suprimido**: execução orçamentária é pública pela Lei 12.527 e não nomeia
servidor; suprimi-la esconderia o que a fiscalização precisa sem proteger
ninguém.

**RN-32 — a troca devida encerra pelos fatos certos.** Estorno, devolução
integral (parcial não) e **substituição** encerram a cobrança. A substituição é a
armadilha: ela não deixa rastro próprio, é só outra entrega do mesmo item para a
mesma pessoa. Por isso a varredura é da ficha inteira do servidor, e não da linha
recém-escrita — a entrega de hoje é o que encerra a dívida da bota de 2024.

**Item parado em `SEM_ESTOQUE` foi para o sino.** A reserva ao entrar lote
continua explícita, como na fatia 5; o que saiu da memória foi a lembrança. Isso
exigiu `pendencias.reabrir`: `abrir` é idempotente **por chave**, não por
chave-em-aberto, e o caminho reserva-solta → sem-estoque é normal aqui — sem
reabrir, o item sumiria do sino em silêncio, que é o defeito que a fatia veio
consertar. Reabrir a mesma tarefa, e não abrir outra: duas linhas para o mesmo
item fariam a fila contar duas vezes o que é uma coisa.

**Recusas contadas pelas duas portas.** O indicador da RN-27 soma
`EPI_ITEM_RECUSADO` e `EPI_ENTREGA_RECUSADA`. Contar só a primeira deixaria de
fora exatamente a recusa a terceirizado — que não vira requisição, porque quem
não é servidor não está no cadastro.

**No painel, medida e linha nominal se separam.** As cinco medidas ficam em
`epi.ver`; as duas listas de linha de ficha (trocas devidas, entregas do mês)
ficam atrás de `epi.ficha`. Publicá-las no painel abriria pela porta dos fundos o
histórico nominal que `/epis/fichas` fecha na porta da frente.

**Suíte: 1575 passados, 1 pulado.** O módulo de Gestão de EPI está completo.

## [1.25.0] — 2026-08-20

### Gestão de EPI, fatia 6 — o EPI conversa com o adicional sem decidir por ninguém
A fatia que liga o módulo à competência central do sistema. O que ela impede é
tão importante quanto o que ela permite.

**A distinção que uma integração ingênua erra: o EPI neutraliza insalubridade;
o EPI não cessa periculosidade.** A insalubridade é exposição gradual a um agente
que o equipamento pode barrar abaixo do limite de tolerância — a máscara com o
filtro certo faz a concentração inalada cair, e sem exposição efetiva não há o
que indenizar. A periculosidade é risco de acidente: inflamável, explosivo,
energia elétrica, radiação ionizante. Ali o EPI reduz a **consequência** do
sinistro, não a **existência** do risco. Um sistema que deixasse o EPI cessar
periculosidade produziria decisão ilegal em série, e por isso a regra está no
código com teste que tenta fazê-lo e exige recusa.

A lista é **branca** — `{INSALUBRIDADE}` — e não negra, para que um código novo
no catálogo não nasça neutralizável por omissão. Irradiação ionizante e raios X
ficam de fora: são adicionais próprios da Lei 8.270/91, não insalubridade, e o
desenho os nomeia como risco de acidente. Basta um dos dois caminhos (o
percentual da exposição e o tipo do parecer) não ser insalubridade para a
alegação cair: recusar por engano custa um clique, permitir por engano custa o
adicional de alguém.

**A negativa mais importante: o módulo de EPI nunca escreve em
`adicional_vigencia`.** Se uma entrega pudesse cessar um adicional, o clique de
quem opera o almoxarifado cortaria o pagamento de alguém. A negativa é **provada
em duas metades**, não comentada: um teste escuta os eventos do mapper e roda
entrega, comprovante, estorno, devolução e recusa com um adicional vigente ao
lado (zero escritas); outro varre por AST todos os arquivos do módulo proibindo
importar `direito`, construir `AdicionalVigencia`, atribuir a atributo vindo
daquela consulta, e SQL cru de escrita. **A varredura foi sondada contra
`direito.py`**, onde acha as 24 escritas reais — teste negativo que não consegue
falhar não vale nada.

**O EPI publica uma consulta; o parecer consome.** `entregas_ate` responde pela
**data da avaliação**, não por hoje: qual EPI a pessoa tinha, com que CA, e se a
troca prevista já vencia naquela data. O painel no editor do parecer **diz** que
CA vencido na data ou troca vencida não sustenta alegação de neutralização — em
vez de deixar o engenheiro concluir a partir de uma data que teria de conferir
sozinho. Devolução completa entrou na mesma lista de ressalvas, que o desenho não
previa e é a mesma classe de erro.

**A prova entra no `contexto_congelado["epi"]` na emissão.** Entrega feita depois
não reescreve o fundamento de um parecer assinado, e o parecer passa a carregar
consigo a evidência que sustentou a conclusão. Zero acoplamento de esquema entre
os módulos: três colunas em `exposicao` e **nenhuma FK** para tabela de EPI.

**No sentido inverso, pendência e não efeito colateral.** Entrega para servidor
com adicional vigente abre `REAVALIAR_ADICIONAL_POR_EPI` com dono e prazo. Quem
decide continua sendo gente.

**Suíte: 1531 passados, 1 pulado.**

## [1.24.0] — 2026-08-20

### Gestão de EPI, fatia 5 — a reserva, que impede dois pedidos de prometerem a mesma bota
Fecha o ciclo requisição → movimento → ficha. Não houve migração: as colunas e o
`CHECK` já tinham nascido na fatia 4.

**Um zero declarado virou verdade.** `epi_estoque.reservado()` existia desde a
fatia 3 devolvendo zero, com o docstring dizendo que a reserva ia morar em
`epi_requisicao_item` e que escrever `disponivel = saldo_fisico` direto
"esconderia a conta". Como `disponivel()`, `LoteDisponivel` e
`preso_em_lote_vencido` já liam dela, **as telas de estoque e de entrega
passaram a respeitar reserva sem uma linha nova** — e há teste de que a entrega
de balcão não leva o que um pedido já reservou.

**Reserva não é movimento**, e por isso não entra no razão. Reservar não tira
nada da prateleira: tira da disponibilidade. Se entrasse no razão, o saldo
físico deixaria de bater com a contagem manual — que é a conferência que o razão
existe para permitir.

**`SEM_ESTOQUE → RESERVADO` ficou explícita, não automática**, contra a letra do
desenho, que dizia "sistema, ao entrar lote". Três razões. Reserva automática
mudaria o disponível sem ninguém mandar: quem lançasse 50 pares veria 38 na
mesma tela, por decisão que não está nela — que é exatamente como a contagem
manual passa a divergir sem explicação, o defeito que este módulo existe para
consertar. Escolher quem fica com estoque escasso é decisão (urgência, risco do
posto, quem já está descalço), não `ORDER BY id`; um laço responderia isso em
silêncio e com aparência de regra. E o que faltava não era a reserva, era a
informação: a entrada de lote agora diz quantos itens esperam por aquele EPI e
avisa que a reserva não é automática, e a ação fica com nome na trilha.

**RN-25 verificada nos dois momentos, com teste do intervalo.** O CA pode vencer
entre a reserva e a entrega, e é por isso que uma verificação só não serve. Há
teste que reserva numa data em que o CA valia e tem a entrega recusada hoje, com
a data escrita na recusa.

**RN-24 sob concorrência, testada de verdade** — duas conexões, duas threads,
lote com 3, duas reservas de 2: exatamente uma passa. O `BEGIN IMMEDIATE` toma o
lock na primeira instrução, então ler o disponível e gravar a reserva cabem numa
janela que nenhum outro escritor atravessa.

**A reserva se solta sozinha quando perde o lastro**: descarte, ajuste para
menos e inativação de lote soltam o que ficou sem cobertura, da promessa mais
nova para a mais antiga; cancelar item ou pedido também solta. `entregar_item`
solta a reserva imediatamente antes de baixar o estoque — senão a RN-24 recusaria
a entrega por causa da própria promessa que ela vem cumprir.

Três eventos novos, e `EPI_ITEM_RESERVA_SOLTA` é separado de propósito:
"faltou comprar" e "prometi e não pude cumprir" são contagens diferentes, e
quem lê o indicador precisa distingui-las.

**Suíte: 1508 passados, 1 pulado.**

## [1.23.0] — 2026-08-20

### Gestão de EPI, fatia 4 — a requisição, decidida item a item
O pedido de EPI passa a ter protocolo, prazo e trilha. O que muda de verdade em
relação ao sistema antigo não é a existência do fluxo — é **onde a decisão
mora**.

**A decisão é do item, não do pedido.** O legado tinha seis estados numa fila só
misturando o envelope e o item, e por isso "aprovada" e "recusada" eram do pedido
inteiro. Mas ninguém aprova um pedido inteiro: aprova-se a luva e recusa-se o
respirador. São duas máquinas agora — a do envelope (`RASCUNHO → ENVIADA →
EM_ANALISE → ANALISADA → EM_ATENDIMENTO → ATENDIDA`, com `INDEFERIDA`,
`CANCELADA` e o caminho de reconsideração) e a do item, onde o trabalho acontece.

**"Liberada" não voltou.** É a mesma reserva vista do lado de quem entrega:
nenhuma quantidade muda, nenhum documento nasce, ninguém decide nada entre
"reservada" e "liberada". Estado que não separa dois fatos só serve para a tela
divergir do banco.

**Toda recusa é fundamentada, catalogada e congelada (RN-27).** O motivo vem do
catálogo, o texto vigente é copiado para a linha no ato da decisão, e editar o
catálogo depois **não reescreve a negativa que o requerente já recebeu** — mesmo
princípio da RN-15. Na tela a recusa é um seletor com o texto inteiro visível
antes do clique, e o complemento só aparece quando o motivo o exige: é o que faz
a negativa sair fundamentada sem depender da memória de quem está com pressa.

**A janela da RN-26 conta pela ficha, não por requisições aprovadas.** "2 por
ano" se mede pelo que a pessoa recebeu, não pelo que alguém autorizou. Estourar
não é bloqueio duro: é bloqueio até alguém marcar a exceção, escrever a
justificativa e assinar com o próprio `usuario.id` — e o formulário tem o caminho
de reenvio, porque erro sem saída faz o analista contornar o sistema por fora.

**RN-28, segregação de função: bloqueio duro, sem autoanálise.** Quem requisita
não analisa o próprio pedido, e não há exceção registrada. O motivo é que a
alternativa é pior: autoanálise gravaria "analisado por X" num pedido de X,
produzindo no banco a **aparência** de um controle que não houve. E a regra não
trava trabalho nenhum — quem tem `epi.analisar` e precisa de EPI continua
atendido pela entrega de balcão da fatia 2, que já existe e já é auditada. A
mensagem de erro diz as duas saídas legítimas em vez de só negar.

**Protocolo `EPI-AAAA-NNNN` consumido no envio, não na criação.** Rascunho não
tem protocolo — o `CHECK` `ck_req_protocolo` faz disso uma equivalência, não uma
convenção. A numeração segue a disciplina da RN-03: nunca `MAX(numero)+1`.

**O contexto vai congelado.** Lotação, campus, posto, cargo e função entram no
pedido no momento do envio. A pessoa muda de setor; o pedido não.

Nesta fatia aprova-se e entrega-se direto. `RESERVADO` e `SEM_ESTOQUE` estão
declarados e testados na máquina, mas ninguém os alcança ainda — a tela de saldo
diz por escrito que pedir não reserva nada, porque número que parece promessa e
não é seria pior que número nenhum. A reserva é a fatia 5.

Duas permissões novas: `epi.requisitar` e `epi.analisar`. 24 rotas, sete
templates, e a entrega passou a poder apontar para o item que a originou.

**Suíte: 1471 passados, 1 pulado.** Eram 1329 antes da fatia.

## [1.22.2] — 2026-08-20

### O EXPORTAR-TUDO esperava 5,7 s para NÃO fazer o checkpoint
Último caso do padrão que derrubou o sino na 1.22.1. E a causa é mais específica
do que "a sessão está aberta": `exportar_tudo` **faz `commit()`** antes de copiar
o banco — justamente para soltar o lock —, mas logo depois lê processos, laudos e
servidores para os CSVs, e cada `SELECT` **reabre a transação com `BEGIN
IMMEDIATE`** (RN-03). Quando o checkpoint rodava, o lock já tinha voltado para a
própria requisição. O commit que existia para resolver o problema não alcançava o
`PRAGMA`.

Medido: **5,664 s com a sessão aberta contra 0,001 s sem ela**, devolvendo o
sinalizador de ocupado. Esperava quase seis segundos para não fazer o checkpoint —
e ninguém lia esse retorno: aqui não havia nem `except` para engolir o erro.
Falhava em silêncio absoluto.

**O `PRAGMA` era desnecessário**, e isso foi conferido antes de remover, não
depois: exportando com 39 pareceres e um servidor commitados **apenas no WAL**, o
banco dentro do zip veio com tudo. `VACUUM INTO` lê o banco lógico, WAL incluído.
**`exportar_tudo`: 6,161 s → 0,454 s.**

O teste exige as duas coisas — o tempo, que pega a causa, e o dado do WAL dentro
do zip, que pega o **motivo** de o `PRAGMA` ter sido posto ali. Um backup que
perdesse as últimas transações seria muito pior que seis segundos de espera.

### A suíte ia à rede, e passava por acidente
O fixture de importação do Trello chamava o importador sem injetar o buscador de
anexo, e o padrão faz requisição de verdade, com DNS. Eram cinco chamadas, a ~2,7 s
cada.

**O tempo era o menor problema.** Nesta máquina a resolução falha e o teste cai no
ramo de erro — que é o desejado, por acidente. Numa rede cujo provedor resolve
NXDOMAIN para portal cativo, o download devolveria bytes de HTML, a contagem de
anexos viraria 1 em vez de 0, e a suíte passaria a falhar de forma intermitente
num arquivo que não tem nada a ver com a causa.

A injeção **levanta exceção** em vez de devolver vazio: vazio é o *outro* ramo,
com motivo diferente e caminho próprio na simulação. E as asserções que provam
"anexo perdido é registrado" moram em outro arquivo, que já injetava — foram
conferidas antes e não mudaram. **O arquivo caiu de 100,7 s para 6,4 s.**

A suíte inteira foi varrida sob um guarda que falha qualquer teste que abra socket
fora do loopback: **nenhuma outra saída para a rede**.

**1329 passados, 1 pulado, em 7:43.**

## [1.22.1] — 2026-08-20

### O sino nunca contou nada — e cobrava 5,6 s por tela para não contar
`web._sino` abria uma sessão própria para contar as pendências do cabeçalho. A
sessão da requisição já estava aberta e já havia tomado o lock de escrita — toda
transação nasce com `BEGIN IMMEDIATE` (RN-03) —, então a segunda conexão esperava
o `busy_timeout` inteiro e terminava em "database is locked". O `except` do sino
engolia o erro e devolvia zero.

O `banco.py` avisa desde a primeira versão que ninguém deve abrir uma segunda
conexão dentro de uma requisição, sob pena de deadlock consigo mesmo. **O sino
abria.** Custava duas coisas ao mesmo tempo, as duas em produção:

- **~5,6 s a mais em TODA tela HTML**, medidos — o sistema parecia pesado porque
  cada página passava cinco segundos esperando um lock que ela mesma segurava;
- **o sino marcava zero, sempre, para todo mundo.** Ele existe para avisar que há
  tarefa esperando, e nunca avisou. Está assim **desde a 1.1.0**, quando o sino
  nasceu: nunca funcionou, em nenhuma das 21 versões que o carregaram.

A sessão da requisição agora se publica em `request.state` enquanto está aberta, e
o sino conta por ela, com `no_autoflush` — contar pendência é decoração de
cabeçalho e não pode arrastar para o banco um flush do que a rota ainda montava.
Fora de requisição, na tela de erro com a sessão já encerrada, ele continua
abrindo a sua, que ali é segura porque não há lock para disputar.

Há teste que exige **as duas coisas**: o número na tela e **zero** aberturas de
sessão durante a requisição. Sem o segundo, a correção seria desfeita em silêncio
pelo mesmo `except` que escondeu o defeito por 21 versões. Provado que o guarda
morde: revertido o comportamento antigo, o teste falha e a chamada volta a 5,69 s.

### A suíte voltou a caber numa execução
De **1:04:58 para 11:39** (em regime, 12 a 20 min), mesma cobertura. Ela havia
passado do limite do executor de tarefas em segundo plano, e quem trabalha no
repositório não conseguia mais provar que não regrediu sem dividir em partes e
somar à mão — o que esconde interação entre elas.

- A correção do sino respondeu por **2085 s, 53%** do total. O defeito de
  produção era também o dominante do tempo de teste.
- **644 s, 17%**, eram Argon2id com custo de produção nos fixtures: 83 ms por
  hash, doze contas por teste de integração e login em quase todos. A suíte passa
  a usar custo mínimo; **produção não muda**. Os parâmetros viraram constante
  nomeada, com dois testes amarrados nela — um no valor, outro na fonte, para a
  constante não virar número decorativo enquanto a chamada usa outro.

Nenhum teste removido, pulado ou afrouxado, e o modelo de isolamento não mudou:
cada teste continua com o seu banco em `tmp_path`. Conferido em **ordem
embaralhada com duas sementes**, além da ordem normal. São 1327 passados e 1
pulado — **três a mais** que os 1324, e são exatamente os três testes que provam
esta correção.

## [1.22.0] — 2026-08-18

### Gestão de EPI, fatia 3: o estoque
Entrada de lote com pregão, item do pregão, empenho, nota fiscal, quantidade,
valor, fornecedor com contato — e o **CA e a validade deste lote**, que não são
os do catálogo. Lote com CA vencido entra e fica impedido: ele existe, está na
prateleira e é patrimônio. Some da lista de entrega, **nunca** da lista de
estoque.

**Saldo é soma do razão, e o razão é append-only.** No legado, `Qtd_Estoque` era
célula mutável e duas entregas simultâneas perdiam uma, sem rastro do que baixou.
Há teste que reprova coluna com "saldo" ou "estoque" no nome — a tentação de
materializar o saldo por desempenho é exatamente como o defeito voltaria.

**Devolução e estorno deixaram de poder ser confundidos.** Devolução é fato do
mundo: o equipamento voltou, a entrega continua valendo, o saldo volta ao lote.
Estorno diz que o *registro* estava errado e não devolve nada. E **estornar
entrega já devolvida passou a ser recusado** — as duas juntas criariam unidades
que nunca existiram.

**O ajuste de inventário recebe a contagem física, não a diferença.** Quem está
com a prateleira na frente não deve fazer a conta de cabeça; a linha do razão
guarda os dois números, o motivo, quem contou e quando.

**Pendência de CA a vencer** abre 60 dias antes, com prazo na própria validade, e
fecha sozinha quando o saldo zera ou o lote é inativado. Com uma limitação
escrita no código: ela é disparada por escrita, como todas as do sistema, então
um lote parado atravessa a janela sem abrir tarefa — ele aparece etiquetado na
tela desde o primeiro dia, o que atrasa é a tarefa com dono.

### O perfil que faltava, e o que ele revelou
`almoxarife_sesmt` nasceu com `epi.estoque` — adiado duas vezes de propósito,
porque o seed nunca remove permissão de perfil e meio perfil concede acesso que
só sai por SQL. Ele é o **primeiro perfil do sistema que opera um módulo sem ter
`processo.ver`**, e por isso entrou no invariante que compara menu e rota: onde
os outros veem a base inteira por causa dessa permissão, ele vê exatamente o que
o módulo lhe deu — que é a condição em que um item declarado errado passa
despercebido.

E a verificação **olhando** pegou o que nenhum teste pegou: na instância de
prova, o almoxarife via `SRV-e3eb` no lugar do nome — escolheria o servidor num
seletor de códigos opacos e entregaria a bota para o código errado. A RN-19,
corretamente aplicada, tinha tornado inútil a tela que ela não deveria alcançar.
`epi.ficha` passou a valer como permissão de leitura nominal, junto de
`exposicao.ver`: a permissão é, por definição, "ver a ficha **nominal**", e
mascarar o nome tornaria inútil a tela que ela autoriza. Não afrouxa a regra —
todo perfil com `epi.ficha` já tinha `exposicao.ver`; o almoxarife é o primeiro
que não tem, e nem deve ter, porque exposição é dado de saúde.

Uma migração (uma coluna anulável). 1324 passados, 1 pulado.

## [1.21.0] — 2026-08-18

### Gestão de EPI, fatia 2: a ficha — a prova de que o equipamento foi entregue
Até aqui a prova de entrega de EPI morava fora do sistema. Agora cada entrega é
uma linha da ficha do servidor, com nome do EPI, CA, validade, norma, fabricante
e lote **congelados no ato**. Renomear o item no catálogo amanhã não reescreve a
entrega de ontem — é a RN-15 do parecer e do certificado aplicada ao terceiro
documento, e é a lição da 1.4.0, quando editar catálogo reescrevia parecer
emitido em silêncio.

**EPI com CA vencido não sai, e o CA que decide é o do lote.** Um lote de 2023
pode estar vencido enquanto o cadastro já aponta para o CA renovado de 2026 — e é
o do lote que está na etiqueta do equipamento que a pessoa leva. O lote vencido
**não some** da tela: continua com saldo, em vermelho, com o motivo escrito e o
botão desabilitado. Sumir repetiria o defeito do legado, em que o saldo mudava
sem rastro.

**A entrega não termina no formulário.** O comprovante é papel assinado no ato: o
sistema imprime a partir dos dados congelados, o servidor assina, e o
digitalizado volta como anexo com SHA-256 e guarda permanente. Entre a entrega e
o anexo há uma janela em que a ficha tem o registro e não tem a prova — e ela é
visível de três formas: pendência com dono e prazo, etiqueta em cada linha, e
contagem no topo da ficha e da lista. Lacuna silenciosa só aparece na
fiscalização.

**Correção é estorno, nunca rasura** — e aqui a trava de banco precisou ser
revista, o que virou a migração desta fatia. A trigger antiga recusava *todo*
UPDATE, e três colunas só existem depois do INSERT: o evento da trilha (que
precisa do id da linha), o anexo do comprovante e o momento em que ele chegou. A
trava nova recusa mudança nas 26 colunas de conteúdo e recusa **reescrita**
dessas três — nulo → valor, uma vez. **Completar não é reescrever.** E há teste
comparando a lista literal da trigger com as colunas do modelo, para a coluna de
amanhã não escapar da trava por esquecimento.

**Estorno não devolve saldo.** Ele diz que o *registro* está errado, não que o
equipamento voltou; devolver é outro fato, e vem com a fatia do estoque.

**A recusa fundamentada virou ato de sistema.** O sistema não detecta sozinho quem
não é servidor — quem não é não está no cadastro, e mantê-lo fora é a decisão —,
mas a negativa, uma vez tomada por gente, sai com o texto da norma congelado no
ato, encaminha à contratante e fica contável na trilha, por motivo e por unidade.

### Conformidade antes da produção, não depois
`docs/ROPA.md` (v1.2) e a política de retenção foram emendados **nesta mesma
entrega**, como o desenho exige. A emenda de 13/08 já previa a ficha; faltavam
três coisas, e duas são perguntas de verdade:

- **Destinatário.** A ficha vai ser pedida — por PROGEP, pela procuradoria, pela
  Justiça do Trabalho. Quem responde e por qual canal é decisão de processo.
- **A assinatura manuscrita do titular é dado novo e não estava declarada.** É a
  primeira vez que o sistema guarda assinatura de quem é **avaliado** — o parecer
  é assinado pelo técnico. Foi tratada como dado pessoal comum com acesso
  restrito, que é o mínimo defensável, e **não** como sensível do art. 11; a
  dúvida ficou registrada, porque a leitura da ANPD não foi conferida.
- O comprovante impresso e ainda não assinado ganhou prazo próprio: é arquivo de
  trabalho, regerável idêntico a partir do congelado.

Uma migração. 1251 passados, 1 pulado.

## [1.20.0] — 2026-08-18

### Gestão de EPI, fatia 1: o catálogo, e as regras que o legado escondia
Nove das 22 colunas de `EPI_Cadastro` nunca apareceram no formulário do
IntegraSST — e repare no padrão: **as que governam a requisição estão entre
elas**. `Qtd_Padrao`, `Qtd_Maxima` e `Exige_Justificativa` existiam no modelo de
dados e não existiam na tela. Ou alguém editava a planilha à mão — e aí a planilha
era a interface real —, ou a regra nunca rodou. Regra que ninguém consegue ver não
é regra, é armadilha. `/epis/catalogo` expõe as três, e a máxima só se grava junto
da janela: "2 por 12 meses" é regra, "2" sozinho não é nada.

**A validade do CA é a única linha do catálogo com consequência jurídica direta, e
agora ela aparece.** Pela NR-6 o Certificado de Aprovação é o que constitui o
equipamento como EPI: entregar um com CA vencido significa que a instituição não
entregou proteção nenhuma, e a defesa dela numa fiscalização cai junto. No legado
a coluna estava no modelo e fora do formulário. Aqui é campo, é etiqueta vermelha
na lista e é aviso no topo — o bloqueio na entrega chega com a ficha, e o que vale
lá é o CA **do lote**, não o do catálogo.

**A categoria virou a taxonomia da NR-6.** Era texto livre, e a mesma tela do
legado mostrava grafias diferentes de uma lista que a norma fecha em nove. As nove
estão semeadas do Anexo I, e não se cadastra a décima pela tela: seria inventar
norma.

**A recusa virou catálogo de primeira classe.** Oito motivos semeados, cada um com
o texto que sai literal para quem pediu e a norma que o sustenta. O de vínculo não
atendido faz a sua decisão virar comportamento de sistema em vez de ausência de
cadastro: a UFVJM não fornece EPI a terceirizado, o texto cita a NR-6 — e
**encaminha**, dizendo que o pedido vai à contratante e que a fiscalização do
contrato pode ser acionada. Negativa que encaminha vale mais que um "não", e,
sendo catálogo, é contável: vira o insumo da conversa com a contratada.

### O esquema não segue a ordem das telas, e é de propósito
As telas saem em três entregas — catálogo, ficha, estoque —, mas o grafo de chaves
estrangeiras vai na direção contrária: a ficha aponta para o lote de estoque e
para o item da requisição. Criada sozinha, ela referenciaria tabela inexistente — e
o SQLite **aceita** o `CREATE TABLE`, e a conferência de integridade da migração
**não pega**, porque a tabela está vazia. O erro apareceria no primeiro registro
de entrega, que é justamente a linha que o módulo existe para provar.

**Ficha e razão do estoque nascem append-only**, com trava de banco, como o
histórico de eventos. Saldo é soma de movimentos, nunca célula que se sobrescreve
— no legado duas entregas simultâneas perdiam uma, sem rastro do que baixou.
Correção é linha nova, sempre com motivo. A trava nasce com o esquema e não com a
tela que escreve nela: uma tabela append-only que passa um mês aceitando `UPDATE`
é uma tabela cujo histórico ninguém consegue mais afirmar que está intacto.

### Uma bomba-relógio na cadeia de migrações
A migração do esquema inicial **importava a tupla viva** de triggers de
`app/banco.py` e a percorria. Acrescentar qualquer trigger de módulo novo faria a
revisão inicial tentar criá-la sobre tabela que só existe muitas revisões adiante,
e o `upgrade` desde o zero passaria a quebrar com *no such table* — num banco novo,
não no nosso. A lista foi congelada: a revisão inicial passou a importar as seis
originais, e as de EPI vivem à parte. É a única linha tocada em migração histórica,
e ela preserva exatamente o efeito que a revisão sempre teve, provado por `upgrade`
desde banco vazio.

Nenhum campo de CPF em tabela nenhuma, e nenhuma alteração na base compartilhada:
o módulo lê servidor, unidade, cargo e posto como eles estão.

Uma migração. 1201 passados, 1 pulado.

**Fica aberto:** estudante e bolsista entram no fornecimento (bloqueia a ficha);
como o comprovante de entrega é assinado; e as emendas do ROPA e da política de
retenção, exigidas **antes** de a ficha ir a produção.

## [1.19.1] — 2026-08-17

### Um número gravado como texto derrubava a prova de integridade
A causa não estava em quem chamava a auditoria: estava em `JSONTexto`, que tinha
um atalho — *string vai crua para a coluna, sem aspas de JSON, como se toda
string já fosse JSON pronto*. Na leitura o JSON a reinterpretava: `"50.00"`
voltava float, `"1110654"` voltava inteiro, `"true"` voltava booleano, `"null"`
voltava nulo. O digest de cada evento é calculado sobre o valor em memória e
reconferido sobre o valor lido do banco; sendo dois valores diferentes,
`cadeia_integra` acusava **adulteração onde ninguém tocou em nada**.

O alcance era maior que o caso conhecido — a nota de turma, corrigida na 1.11.0
gravando `Decimal`. **Corrigir um SIAPE digitado errado bastava para disparar o
alarme falso**, porque SIAPE é texto de sete dígitos e passa por
`registrar_diferencas`; o mesmo vale para o código UORG na edição de catálogo.
São os dois campos numéricos-como-texto que o sistema edita hoje, e os dois pela
tela. Treze pontos de escrita passam valor para a trilha, incluindo o genérico
que serve **todo catálogo do sistema**.

Corrigido na raiz: `JSONTexto` serializa string como serializa qualquer outra
coisa. Nenhum ponto dependia do atalho, e a **leitura não mudou** — linha já
gravada continua sendo lida como sempre foi. **Nenhum evento do banco do setor
estava afetado**: são quatro, e a cadeia fecha antes e depois. Nenhum foi tocado;
a tabela segue append-only por trigger.

A trava fica em `auditoria.registrar`, por onde toda gravação da trilha passa:
antes de montar o evento ela simula a ida e a volta **pela própria coluna** — não
por uma cópia da serialização, que é como o defeito nasceu — e recusa, na hora e
com o motivo, o valor que não voltaria igual. É simulação, e não lista de tipos
proibidos: lista envelhece e não alcança o caso que ninguém previu. Por isso não
recusa nada do que o sistema grava hoje, e há teste fixando cada um.

### `/processos/{id}` inexistente respondia 200
A tela dizia "não encontrado" e o status dizia sucesso: o navegador guardava a
página no histórico como acerto e nenhum script de conferência via o erro. Agora
levanta 404, e quem desenha é o tratador que já existia — que sai com a casca e
devolve JSON com 404 a quem não pede HTML.

As outras seis fichas **não tinham o defeito**: redirecionam para a lista,
comportamento diferente e deliberado, preservado. Um teste parametrizado passa a
exigir das sete que registro inexistente responda 303 ou 404, nunca 200.

### Formulário recusado devolve o que foi digitado
O primeiro acesso perdia nome e e-mail por causa de uma senha fraca; o processo
novo perdia observação, tipo, servidor, unidade, data e a marca de dispensa do DV
por causa de um dígito verificador — e, no erro de formato, perdia até o NUP.
Redigitar é o atrito que faz a pessoa encurtar a senha na segunda tentativa.

**Senha nunca volta ao template.** Iria em claro para o HTML e daí para o cache
do navegador. A troca de senha, cujos três campos são segredo, continua limpando
tudo: ali perder o digitado é a resposta certa, e agora há teste que fixa o
limite para uma futura "melhoria de usabilidade" não atravessá-lo.

### A busca de `/servidores` deixou de ser oráculo de nome (RN-19)
A lista suprime a identificação de quem não tem `exposicao.ver`, mas o filtro
continuava casando por nome: digitar "Marco" devolvia uma linha e amarrava o nome
ao código da sessão — a ligação exata que a supressão existe para impedir.
Esconder a coluna não serve de nada se o filtro responde "sim, é este".

O nome passa a entrar na busca **linha a linha**, pelo mesmo critério da
exibição, e não por permissão em bloco: quem tem `exposicao.ver` não nota
diferença, **o titular acha o próprio nome** (LGPD art. 18, II) e a secretaria
busca por SIAPE — a chave que a tela declara e que ela já traz do SEI. O rótulo
do campo muda junto, para a tela não prometer o que não faz.

Nenhuma migração. 1123 passados, 1 pulado.

**Fica aberto:** `/pareceres/{id}/docx`, `/pdf` e `/previa` não conferem parecer
inexistente e terminam em 500.

## [1.19.0] — 2026-08-17

### As telas de gestão — e o redesign fecha
Lote 6, o último: relatórios, importação, reconciliação, os dois relatórios de
carga, configuração e a matriz de perfis. Com ele, a casca e as seis famílias de
tela do sistema estão no mesmo vocabulário.

**Três trilhas paravam no primeiro nível ou mentiam.** `/perfis` dizia "Processos
SEI", e a matriz é de **todos** os módulos; `/config` também, e o caminho do banco
não é de Processos SEI; e `/pendencias` idem, o que deixou de ser verdade quando
a reciclagem de treinamento passou a cair no mesmo sino. Agora são "Base
compartilhada / Matriz de perfis", "Sistema / Configuração" e "Base compartilhada
/ Pendências".

**Pendências virou item da base, com menu próprio.** Até aqui só se chegava nela
pelo sino. A permissão do item é a mesma lista que a rota exige — não uma cópia
que diverge —, então quem só opera treinamento vê a fila onde a sua tarefa cai.

**Na tela de conferência da importação, a apresentação passou a servir à
conferência.** Os números da carga viraram fileira de indicadores em mono e
alinhados, a coluna de linha ficou numérica com `tabular-nums`, e cada pendência
e cada divergência sai **por extenso, uma por linha** — não em etiqueta apertada.
"Marco 2024-03-12 diverge da portaria 2024-04-01" só serve se a frase inteira for
legível; numa tela onde alguém decide o que entra no sistema, saber *que* difere
não basta. Na simulação, o aviso diz que nada foi gravado e o que conferir antes
de reenviar.

**Célula suprimida pela RN-19 não ganha barra.** Nos gráficos de distribuição, uma
barra curta afirmaria "é pouco" — que é exatamente o que a supressão existe para
não deixar deduzir. Vira travessão, com o aviso explicando a supressão
secundária.

**Relatórios ganhou a porta que faltava:** a exportação de processos em CSV era
rota sem link em tela nenhuma.

**O que o desenho propõe e não entrou:** o seletor "Exercício" em Relatórios. A
rota aceita o parâmetro, mas ele **não filtra nada** — só imprime o ano. Um
seletor ali prometeria um recorte que não acontece.

Nenhuma migração. 1056 passados, 1 pulado.

## [1.18.1] — 2026-08-16

### A suíte parou de escrever nos dados do setor
**A configuração de teste nascia apontando para produção.** O `env_file` era
resolvido no corpo da classe `Config`, ou seja, no import de `app.config` — que o
pytest faz na coleta, antes de qualquer conftest. E era pior que ordem de import:
o `CSSO_ENV_FILE` era exportado de dentro de um **fixture de sessão**, que roda no
setup do primeiro teste. O mecanismo nunca funcionou, em ordem nenhuma. O banco
escapava porque o fixture `banco` redefine o engine; as pastas não escapavam.

**O que vazava.** Documento de teste em `dados/documentos/` — os nove arquivos de
lá são saída de teste, inclusive um `.docx` de 10 bytes que diz literalmente
"docx falso" —, blobs em `dados/anexos/`, e o mais sério: **`dados/backups/`**.
`POST /config/backup` chama `fazer_backup()` sem destino, e o padrão é o do
`.env`. Cada rodada da suíte deixava um dump cifrado do banco **de teste** na
rotação de backup do coordenador.

**A correção tem duas metades.** O `env_file` passou a ser resolvido na
instanciação, não no import: vale o ambiente do momento, sem depender de ordem. E
um `conftest.py` **na raiz** monta a caixa de areia no corpo do módulo — o pytest
o importa antes de coletar qualquer coisa, que é o único ponto antes do primeiro
`import app.config`. Ele exporta o `CSSO_ENV_FILE` e também as variáveis `CSSO_*`
individuais: variável de ambiente vence o `.env` sempre, então o isolamento se
segura mesmo se o `env_file` um dia voltar a congelar.

**E uma trava para o furo não reabrir.** `Config.diretorios_de_dados` virou a
fonte única dos diretórios de escrita — o boot cria estes, a trava confere estes,
e campo novo não tem como escapar. Se qualquer caminho da config cair dentro do
repositório, `pytest_configure` **aborta a sessão antes de um único teste rodar**:
teste que falha pode ser desmarcado ou rodar depois do estrago; isto não.

Provado por hash SHA-256 das 170 entradas de `dados/` antes e depois de duas
suítes completas: idêntico. Nada mudou fora de teste. 1049 passados, 1 pulado.

### A rotação de backup foi limpa
Consequência do furo acima: **46 dos 52 backups eram dumps do banco de teste**, e
o mais recente da pasta era um deles — "restaurar o último backup" restauraria
teste por cima de produção. Cada arquivo foi classificado **pelo conteúdo**, não
pelo tamanho: dump de teste tem as dez contas `@teste.ufvjm.edu.br` e zero
processos. Seis eram reais; os 46 foram apagados.

O de 12/08 às 08:57, com 18,2 MB, saiu da rotação e foi para
`dados/backups_preservados/`, com um LEIA-ME ao lado. É a **única cópia** do
conjunto importado do Trello — 640 processos, 745 cartões, 78 anexos, 14
pareceres, 7.634 eventos — que não está no banco vivo porque o banco foi zerado a
pedido em 12/08, para recomeçar o cadastro à mão. Zerar foi deliberado; a única
cópia estar sujeita a poda por idade, não. Os 78 anexos seguem íntegros e
conferidos por hash em `entrada/anexos_trello/`.

## [1.18.0] — 2026-08-14

### As telas do módulo Certificados e Treinamentos
Lote 5 do redesign. Nenhuma rota, serviço, modelo ou regra mudou: é front-end.

**O dicionário de tags virou a tela, e não uma tabela no canto dela.** Ele sobe
para o topo da ficha do modelo e ocupa a largura inteira; os dados do modelo, que
quase nunca mudam, descem. O cabeçalho conta o confronto — 23 no mapa, 23 no
arquivo, 2 sem mapa, 1 fora do arquivo — e o marcador sai como chip em mono **com
as chaves**, do jeito que está escrito no Word: quem confere compara o chip com o
documento aberto ao lado, não um nome com outro. Marcador que existe no `.docx` e
não tem linha vai em vermelho, com a consequência escrita — sairia impresso no
papel, com as chaves e tudo — e com os nomes listados para copiar. Linha que
existe no mapa e não no arquivo vai em âmbar, porque é aviso e não bloqueio.

**A versão superada parou de ser cinza.** Ela decide com qual layout o
certificado sai, e a pílula neutra a fazia ler como "versão antiga, tanto faz".
Agora é âmbar, e o catálogo ganhou um aviso que **nomeia** os treinamentos
apontando para versão superada. Antes, o único sinal era a palavra "(superada)"
dentro de um `<select>`.

**A ficha do certificado diz o que a anulação custa.** A caixa enumera as três
consequências com os dados da própria tela: não apaga — o número continua
consultável e a segunda via continua saindo, porque quem precisa juntar ao
processo o papel anulado precisa do papel; a validação pública passa a responder
*anulado* para aquela chave; e é isso que libera a reemissão. Onde não há
substituto apontado, a tela diz "nenhum substituto está apontado", e não "não
houve reemissão": o vínculo só existe quando a anulação o declara.

**Na ficha da turma, a situação virou trilho e os botões viraram verbos** —
"Concluir turma", "Fechar inscrições", e não "Passar para concluída", que é como
o banco chama o resultado.

**A barra de frequência é pintada pela frequência, não pelo resultado.** Quem vai
reprovar só por nota tem frequência boa; pintar a barra de âmbar ali dizia que
faltou.

**Quatro consertos de casca apareceram aqui e valem para todas as telas.**
`min-width: 0` nos blocos da tela e nas colunas do lado-a-lado: sem ele, uma
tabela larga esticava o cartão para fora da janela e as últimas colunas ficavam
**inalcançáveis**, porque a página não rolava e o cartão também não. `.cartao.liso`
passou de `overflow: hidden` para `auto`. O valor da tabela de dados quebra em
qualquer ponto, porque a ficha do certificado põe ali um SHA-256 de 64 caracteres
sem espaço nenhum. E a busca do cabeçalho passou a encolher primeiro: num
container que quebra linha o navegador não encolhe nada antes de quebrar, então
era o **usuário** que caía para a segunda linha.

**O que o desenho propõe e não entrou:** pílulas de filtro com contagem por
situação (nenhuma rota conta), número ao lado de "Turmas" na lateral, busca de
turma no cabeçalho e o botão "Ajuda". Contagem inventada e botão que não faz o
que promete são piores que a ausência dos dois.

Sem rolagem horizontal em 1440, 1024 e 760px. Nenhuma migração. 1041 passados,
1 pulado.

**Pendente:** não há caminho pela interface para enviar a imagem da rubrica do
instrutor, embora a emissão a imprima; a anulação não aponta o substituto;
`/certificados` filtra pela situação gravada, e o vencido — que é estado
calculado — fica listado entre os emitidos.

## [1.17.0] — 2026-08-14

### As telas auxiliares: entrar, primeiro acesso, trocar senha, erro, módulos e pendências
Lote 4 do redesign. Nenhuma rota, serviço, modelo ou regra mudou: é front-end.

**Três telas perderam a lateral — e a casca ganhou um interruptor, não um segundo
layout.** Login, primeiro acesso e troca de senha não têm para onde navegar: duas
são anteriores à sessão e a terceira é um pedágio. Um segundo `base.html` teria
duplicado o `<head>`, os tokens, o rodapé, as faixas de aviso e o Ctrl+K só para
tirar uma `<aside>`. Em vez disso a página declara `sem_casca` no topo, uma linha
decide, e as quatro peças da casca a consultam. No lugar da lateral vem o
cabeçalho escuro de 58px, com a marca e — **só quando há sessão** — o "sair": na
troca de senha a pessoa está logada e pode desistir. A faixa de "senha
provisória" some na própria tela de troca, onde ela mandava a pessoa para onde
ela já estava.

**A tela de erro passou a dizer a saída, e a saída é conferida.** O aviso diz o
que fazer: falta a permissão tal, ela não se concede pela tela de erro, quem
concede é quem tem `perfil.conceder` e sempre com o ato normativo — e, ao pedir,
diga qual permissão falta. O botão de saída **não é um palpite**: é o primeiro
item de menu que aquele usuário enxerga, que o invariante do menu já garante que
abre; não havendo nenhum, o mapa dos módulos, que não exige permissão; sem
sessão, o login. E `"Not Found"` deixou de ser impresso como motivo: é a palavra
que o Starlette põe quando ninguém escreveu explicação, e ocupava o lugar dela.

O que a tela **não** ganhou foi o botão "Encaminhar para subscritor" do desenho —
não existe rota que faça isso, e botão que não faz o que promete é pior que botão
nenhum. No lugar dele, o critério: encaminhe para quem tem a habilitação, que é o
que confere, não o cargo (IN 15/2022, art. 10, §2º, I).

**A barra de força da senha entrou porque mede a política de verdade.** Ela
reproduz `politica_de_senha` — tamanho mínimo, mistura de letras e números, lista
de senhas triviais —, nas mesmas palavras da mensagem do servidor e nada além
delas. Os números e a lista vêm do próprio serviço por um global do Jinja, pelo
mesmo motivo do `COLUNAS_KANBAN`: reescrevê-los no JavaScript criaria uma segunda
política, que divergiria no dia em que alguém mexesse num lado só. **Não há
escala de entropia** — o servidor não tem uma, e os três degraus são contagem de
regras não atendidas, com o último dizendo "aceita pela política", não "forte".
Sem JavaScript a barra não aparece: barra que não mede nada é enfeite, e enfeite
aqui é afirmação falsa sobre o que vai ser aceito. O espelho foi conferido contra
o Python entrada por entrada, em doze casos, inclusive acento e caixa.

**Cada mensagem de erro voltou para o campo de onde veio.** Em três campos e com
uma mensagem só no topo, a pessoa tinha de adivinhar qual deles recusou — e
"Senha fraca" ainda aparecia **duas vezes**, porque o cartão e a casca desenhavam
o mesmo `erro`. O que a tela não reconhece continua sendo faixa: errar o campo é
pior que não apontar nenhum.

**O mapa dos módulos diz o que a ausência significa.** Módulo em uso que não abre
tela nenhuma para você não fica com um vão em branco: a caixa diz que o módulo
está em uso e que o que falta é permissão. E a trilha parou de mentir —
`/modulos` está **acima** dos módulos, e dizer "Processos SEI / Módulos" era o
mesmo erro que a trilha da base já evitava.

**Em pendências, tipo e descrição viraram uma coluna só.** São a mesma coisa em
dois níveis — a regra que abriu e o caso concreto —, se repetiam, e a 1024px o
botão "concluir" saía da tela. O atraso subiu para um aviso que diz a
consequência: o prazo é da regra, e vencido ele não deixa de correr — o processo
que depende dela é que para.

Sem rolagem horizontal em 1440, 1024 e 760px. Nenhuma migração. 1041 passados,
1 pulado.

**Pendente, e os três são de rota:** o primeiro acesso e a troca de senha perdem
o que foi digitado quando o servidor recusa; `/processos/{id}` inexistente
devolve a tela de 404 com **status 200**; e a trilha de `/pendencias` ainda diz
"Processos SEI", embora a pendência já não seja só do processo.

## [1.16.0] — 2026-08-14

### As telas da base compartilhada: servidores, catálogos, auditoria e usuários
Lote 3 do redesign. Nenhuma rota, serviço, modelo ou regra mudou: é front-end.

**A lista de servidores separou a chave do nome.** A coluna de identificação é o
SIAPE em mono e é ela que leva à ficha; o nome é coluna à parte. Para quem não
tem `exposicao.ver` a chave passa a ser o código opaco da sessão — que é o que
aquela pessoa tem para trabalhar — e a coluna de nome fica vazia, com a
explicação **uma única vez** no alto da tela. Repetida em cada linha seria ruído;
ausente, a coluna de traços se leria como cadastro incompleto. E a **UORG passou
a sair só como código**, com o nome por extenso no `title`: escrita inteira ela
repetia a Unidade ao lado e comia a largura de todas as outras colunas.

**A ficha do servidor virou a ficha que o histórico merece.** O `h1` é o nome —
ou o código opaco, em mono, para quem não pode lê-lo. "Lotação e cargo" é cartão
liso: a linha do tempo de ponta a ponta, o período aberto marcado com pílula, e o
formulário de mudança separado por um fio, sem parecer mais uma linha da tabela.
Quando não há processo nem parecer, o bloco diz o que a ausência significa.

**O catálogo continua sendo uma tela só para onze catálogos.** A generalidade era
o que estava em jogo: a alternativa seria onze templates que divergem no primeiro
dia em que alguém arrumar o botão de salvar de um só. Os onze ramos ficaram, e
com eles a edição em linha pelo atributo `form=`. Por dentro: o título agora é o
rótulo real ("Unidades / UORG", e não "Unidades uorg"), cada campo ganhou
`aria-label` — o cabeçalho da coluna não rotula input —, sim/não viraram pílula, e
catálogo vazio diz que está vazio em vez de mostrar cabeçalho de tabela sozinho.
O índice deixou de ser onze nomes soltos: cada cartão diz o que se decide ali.

**A auditoria põe a integridade da cadeia onde ela é lida.** O encadeamento de
hashes é o que faz a trilha valer como prova, então a verificação subiu para o
cabeçalho, em pílula; quando ela rompe, o aviso diz a consequência — do evento
tal em diante a trilha deixa de provar que nada mudou, o que veio antes continua
íntegro — e que isso não se conserta pela tela.

**Em usuários, a coluna de ações some para quem não pode agir.** Coluna vazia em
toda linha se lê como funcionalidade quebrada, e não como permissão que falta.

**A supressão da RN-19 foi conferida tela a tela, e não presumida.** Com um
perfil sem `exposicao.ver`, as cinco telas foram varridas atrás de nome e SIAPE
literais: nenhuma ocorrência, e o código opaco aparecendo onde deveria. Com o
perfil que tem a permissão, os nomes continuam lá — **o contrapeso importa**,
porque uma supressão que suprime para todo mundo passaria no teste de vazamento
com o sistema quebrado.

E a edição em linha dos catálogos foi conferida **salvando**, não só renderizando:
em cada um dos nove catálogos editáveis o formulário foi remontado como o
navegador o submeteria — inclusive os campos ligados por `form=` — e reenviado.

Sem rolagem horizontal em 1440, 1024 e 760px: as tabelas largas rolam dentro do
próprio cartão, nunca a página. Nenhuma migração. 1041 passados, 1 pulado.

**Pendente:** `/perfis` não é item de menu nem da base, então sua trilha para no
primeiro nível — dizer "Processos SEI / Matriz de perfis" seria falso, porque a
matriz é de todos os módulos. Dar lugar a ela em `app/modulos.py` é mudança de
navegação, não de tela; cabe ao lote que redesenha a gestão.

## [1.15.1] — 2026-08-14

### RN-19: o nome do servidor parou de vazar no painel e no kanban
**O painel e o cartão do kanban mostravam o nome inteiro a quem não tem
`exposicao.ver`** — as duas telas que mais gente abre. E não eram as únicas: o
formulário de identificação da ficha do servidor devolvia nome e SIAPE em
`value=` para quem tem `processo.editar` (ou seja, além de exibir, deixava
**escrever por cima**), e o `<select>` de `/processos/novo` listava o cadastro
inteiro para quem tem `processo.criar`. A secretaria da CSSO tem as duas
permissões e não tem `exposicao.ver`: é exatamente o perfil que a regra descreve.

**A regra estava decidida em quatro lugares, e três estavam errados.**
`/servidores` chamava `textos.identificador_opaco`, com semente de sessão — o
único correto. `/processos` e `/adicionais` formatavam o **próprio id do banco**
(`SRV-0007`), que não é opaco coisa nenhuma: é enumerável, é igual para todos os
usuários, é estável entre sessões e é literalmente a chave da URL da ficha — e
nunca batia com o `SRV-7f3a` que a outra tela mostrava para a mesma pessoa.
`/laudos/{id}` escrevia "identificação suprimida" sem código nenhum, então nem
dava para saber que duas linhas eram da mesma pessoa. O painel e o kanban não
decidiam nada.

Agora nenhuma tela decide. `servicos/identificacao.identificar()` recebe o
servidor — ou o processo, o parecer, a vigência, ou só o id — e devolve pronto o
que pode ser escrito; o `nome` que ele devolve **nunca** é o nome real quando a
supressão vale, então o template que só imprime `{{ identificar(x) }}` não vaza
nem esquecendo de olhar. Está registrado como global de contexto do Jinja, e não
como parâmetro de `pagina()`, para a tela nova não precisar lembrar de nada:
`usuario` e `request` já estão no contexto de toda página **e de todo fragmento**
— inclusive o cartão que o kanban devolve pelo HTMX.

**E há um teste que recusa quem esquecer**: qualquer template que leia
`servidor.nome` ou `servidor.siape` por fora do helper reprova. As duas dispensas
— instrutor de treinamento e participante de turma — estão na lista com o motivo
escrito, não subentendidas. Há também o teste positivo, que impede o modo de
falha silencioso: um helper que não achasse o usuário no contexto suprimiria
tudo, e só o teste de vazamento passaria satisfeito com o sistema quebrado.

**Corrigir a identificação passou a exigir vê-la.** `atualizar_cadastro` exige
`exposicao.ver` além de `processo.editar`: esconder formulário não é guarda — o
POST continua chegando, e sem isso a secretaria sobrescreveria às cegas o nome
que a lista ao lado se recusa a lhe mostrar.

Duas coisas que **não** são vazamento e continuam não sendo: o titular vendo o
próprio nome — `servidor_consulta` existe para a consulta do art. 18, II da LGPD
e de propósito não tem `exposicao.ver`, sem o que ele abriria o próprio processo
e leria um código —, e as telas que já conferem a permissão na porta.

### A tela de erro voltou a ser tela — e a de 404 nunca tinha rodado
Os tratadores de 403 e 404 chamavam `pagina()` sem `usuario=`, e a casca inteira
vive dentro de `{% if usuario %}`: o usuário lia o motivo do erro sem lateral,
sem menu e sem caminho de volta, e só saía dali pelo botão do navegador.
Tratador de exceção não recebe dependência injetada, então a sessão do cookie é
resolvida à mão, com a mesma função que a dependência usa. Falhar ali devolve
`None` e a tela sai sem casca — que é o caso legítimo de quem errou antes de
logar: sem casca é ruim, 500 dentro do tratador de 404 é pior.

**E o tratador de 404 era código morto.** Estava registrado na `HTTPException` do
FastAPI; o 404 de URL inexistente é levantado pelo roteador como a do Starlette,
que **não é subclasse** da outra — a busca por MRO não o encontrava, e o
navegador recebia `{"detail":"Not Found"}` cru. Registrado agora na do Starlette,
que é o superconjunto. O `raise erro` do fim virou chamada ao próprio tratador:
relançar de dentro dele faz a camada de fora chamá-lo de novo e terminar em 500.

Nenhuma migração; nenhum desenho alterado. 1041 passados, 1 pulado.

## [1.15.0] — 2026-08-14

### O resto do Processos SEI: laudos, adicionais e novo processo
Com isto o módulo está inteiro. Nenhuma rota, serviço, modelo ou regra de negócio
mudou: é front-end.

**O erro do NUP saiu da faixa do topo e virou erro de campo, em duas partes.**
Numa tela de cinco campos, "não deu" no alto da página faz o usuário adivinhar
qual campo errou — e a mensagem aparecia **duas vezes**, porque a casca já a
desenhava e a tela a repetia. Agora ela vai para o campo de onde veio: a de
RN-21 para as observações, o resto para o NUP. E o erro do dígito verificador se
divide no fato ("Dígito verificador não confere", vermelho e negrito) e na
explicação, em cinza — a divisão é do próprio serviço, que já separa as duas por
travessão. A dispensa do DV virou `checkbox` dentro de um aviso que diz o que a
marca faz: fica registrada na auditoria, com quem marcou e o número dispensado.

**A ficha do laudo ganhou as duas ações no cabeçalho**, e as duas são **âncoras**
para os formulários, não botões que disparam: ambas exigem motivo escrito, e ação
destrutiva sem motivo é o que a auditoria não perdoa. O aviso de superar passou a
**contar**: "coloca 8 parecer(es) derivado(s) em reavaliação (RN-11), abre uma
pendência para cada um e devolve à reavaliação o adicional vigente que dependa
deles. Não há como desfazer em lote". Oito, e não "todos" — "todos" não deixa
ninguém decidir.

**A lista de laudos deixou de parecer controle de vencimento.** A nota da IN
15/2022 subiu para um aviso no topo: quem lê "última conferência" como prazo
refaz laudo que não precisava.

**Adicionais desenha a máquina do direito** como fichas de filtro que a URL
reproduz. As três a quatro ações por linha viraram um "Gerir" só — abertas lado a
lado, faziam a coluna ficar mais alta que a linha inteira.

**Dois defeitos de CSS que estas telas revelaram, e o primeiro é grande.** A
folha selecionava campo por `input[type=text]`, e **98 dos 168 campos do sistema
são `<input name="…">` sem `type`** — o seletor de atributo não os alcança, e eles
ficavam com o desenho do navegador, 24px de altura e sem anel de foco, ao lado
dos campos com `type`. Uma linha (`input:not([type])`) corrigiu em todas as
telas, não só nestas quatro. O segundo é o mesmo empate de especificidade que o
`.busca` já documentava, na barra de filtros de `/processos`.

**Uma correção de conteúdo.** O rodapé da lista de laudos usava `|capitalize`, e
o filtro do Jinja levanta a primeira letra **e abaixa todas as outras**: "IN
15/2022" saía "in 15/2022". Quem levanta a inicial agora é a folha
(`::first-letter`), e o texto fica intacto para quem copia ou usa leitor de tela.

**O que o desenho propõe e o sistema não faz ficou de fora**: a contagem por
estado nas fichas de filtro dos adicionais, o "Exportar CSV" que não tem rota, e
o dígito esperado no erro do NUP — "o DV esperado é 31" — porque o serviço
devolve o aviso, não o dígito.

Sem rolagem horizontal em 1440, 1024 e 760px nas quatro telas. Nenhum teste
editado: 1026 passados, 1 pulado.

## [1.14.0] — 2026-08-13

### As cinco telas do Processos SEI foram refeitas
Painel, kanban, lista de processos, ficha e editor do parecer, sobre a casca da
1.13.0. Nenhuma rota, serviço, modelo ou regra de negócio mudou: é front-end.

**O estado virou pílula com ponto, em toda tela.** Os dezenove estados técnicos
ganharam natureza: erro para o que parou por decisão contrária ou está sendo
contestado, alerta para o que espera alguém de fora (anexo, inspeção, assinatura,
PROGEP), info para o que anda aqui dentro, ok para concluído. O mapa vive num
macro Jinja (`partes/macros.html`), não num filtro Python — escolher cor é
apresentação, e a máquina continua em `app/modelos/estados.py`. No cartão do
kanban, onde não cabe a pílula inteira, sobra o ponto, com o rótulo no `title` e
num texto só para leitor de tela: **cor sozinha não é informação**.

**O painel deixou de ser quatro tabelas.** Indicador com rótulo em versalete
acima do número, e o de SLA estourado pinta o cartão inteiro — é o único que pede
ação hoje. "Precisam de você hoje" virou fila de linhas clicáveis. A tabela de
doze células de pareceres por mês virou gráfico de doze barras, com o número
ainda escrito em cima de cada uma: nada se perde, e a forma do ano — que a tabela
escondia — passa a ser visível.

**O quadro do kanban rola dentro de si.** Cinco colunas nunca couberam em 1024px,
e até aqui era a página inteira que rolava na horizontal, o que quebra a leitura
de todo o resto. A coluna vazia diz que está vazia, e o aviso some sozinho quando
o primeiro cartão cai ali — é `:empty`, que responde ao DOM, porque o kanban move
cartão por JavaScript sem recarregar a página e um bloco de verdade no HTML
ficaria para trás. O cartão ganhou barra de progresso do checklist e perdeu os
emojis: "📎 3" virou "3 anexo(s)".

**A lista de processos ficou densa**, e as visões salvas viraram fichas com a
ativa sólida — é o único jeito de saber, olhando, que a lista abaixo não é a
lista inteira. Os filtros continuam sendo `<select>` num formulário GET: o
desenho os mostra como pílulas que abrem menu, mas é a URL que reproduz um
filtro, e sem JavaScript o menu não abre.

**A ficha trocou a tabela de duas colunas pela tabela de dados**, e as abas
ganharam contagem. O aviso de pendências passou a dizer a consequência —
enquanto elas existirem a máquina recusa a saída, o processo volta com o motivo e
nada é gravado —, e não só o fato.

**No editor do parecer, o que mudou foi a moldura.** Cinco cartões, validação com
contagem de bloqueios no título, e o botão de emitir ocupando a largura do cartão
com a consequência escrita embaixo: consome o próximo número da sequência e
congela o conteúdo (RN-14 e RN-15). A prévia ganhou moldura cinza para se ler
como folha — e a moldura some na impressão, senão o documento sairia com uma
tarja em volta. **O que a tela mostra não mudou**: os mesmos campos, as mesmas
pendências, os mesmos bloqueios, a mesma prévia.

Uma exceção deliberada ao desenho: a lista de validação **manteve ✓/✗/⚠** em vez
dos pontos coloridos. Ali o símbolo é o que diz o que a cor sozinha não diz, e é
essa lista que decide se o parecer sai.

**Três defeitos que o redesign trouxe à tona.** O rótulo de leitor de tela do
ponto de estado é absoluto e, sem bloco de contenção próprio, escapava do recorte
do quadro e esticava a rolagem horizontal da página inteira. O bloco de ações do
cabeçalho era medido pelo conteúdo: faltavam poucos pixels e o usuário caía para
uma segunda linha, esticando o cabeçalho de 62 para 81px. E o gráfico de meses,
em flex, tinha a barra de 100% encolhida pelo navegador para caber junto dos
rótulos — mentia a proporção; virou grade de três faixas.

**O que o desenho propõe e o sistema não faz ficou de fora**, em vez de virar
enfeite que mente: "salvar esta busca" (as visões são fixas), autossalvamento do
rascunho, contagem por item na lateral, mediana e variação semanal (o sistema
calcula média), progresso por coluna do kanban, e a esteira linear de estados na
ficha — a máquina tem dezenove estados num grafo, e desenhá-la como quatro passos
seria descrevê-la errado.

Sem rolagem horizontal em 1440, 1024 e 760px nas cinco telas. Nenhum teste
editado: 1026 passados, 1 pulado.

## [1.13.0] — 2026-08-13

### A navegação virou lateral, e o cabeçalho ganhou trilha
Casca do redesign, e **só** a casca: nenhuma tela foi redesenhada nesta entrega.
O desenho veio do projeto `Redesign de layout do sistema` no Claude Design; o
sistema de design está extraído em `entrada/redesign/00_SISTEMA_DE_DESIGN.md`.

**O menu horizontal acabou.** Ele já estava com onze itens em duas barras, e cada
módulo novo piorava — EPI, Acidentes, CISSP e PGR ainda vão entrar. A lateral
escura de 252px tem lugar para crescer na vertical, e separa o que é do módulo do
que é base compartilhada em duas seções visíveis, não em duas pontas da mesma
linha. O seletor de módulo continua sendo `<details>/<summary>`: abre sem
JavaScript, e o que imita o botão do desenho é o CSS.

**Cabeçalho branco de 62px com trilha de três níveis.** Os dois primeiros
`app/modulos.py` sabe — módulo e item ativo, este pelo mesmo critério de prefixo
mais longo que já mantinha `/processos/12/parecer` dentro de Processos SEI. O
terceiro só a página sabe, e entra por um bloco Jinja; o separador é gerado pelo
CSS entre irmãos, então quem não declara nada para no nome do item, sem barra
solta. Em tela da base a trilha começa em "Base compartilhada": o seletor
continua mostrando Processos SEI para não deixar ninguém sem caminho de volta,
mas a trilha não pode afirmar que `/servidores` é de Processos SEI.

**Public Sans e JetBrains Mono, servidas do próprio sistema.** 42 KB no
repositório, baixadas uma vez por `ferramentas/baixar_fontes.py`,
`font-display: swap`, e `unicode-range` para o latin-ext só ser buscado se a
página trouxer um caractere que só exista lá — confirmado no navegador que ele
não é baixado. Google Fonts está fora pelo mesmo motivo que vendorizou o HTMX, e
por um pior: cada tela faria o navegador de quem usa chamar `fonts.gstatic.com`,
e o ROPA declara que não há operador terceiro nem transferência internacional.
Todo número que se confere dígito a dígito passa a sair em mono.

**Vocabulário de componentes em classe**, para as telas usarem quando forem
refeitas: pílula de estado com ponto — é o ponto que faz o estado ser legível sem
depender só de cor —, aviso nas quatro naturezas, contador, tabela de dados de
duas colunas, campo com foco e com erro, e os quatro botões. O anel de foco do
desenho virou **foco global**: em campo ele troca a borda por `--acento` e põe o
anel de 12%; em link e botão, onde não há borda para trocar, o anel é sólido,
porque 12% de opacidade sozinho não é indicador visível. Na lateral escura ele
vira `#7fc4ee`.

**O que o desenho esquecia e continua aqui:** busca global com `Ctrl+K`, o sino
de pendências com o comportamento que a 1.8.1 lhe deu, a faixa de configuração
insegura, a de senha provisória, e o rodapé institucional — este mudou de lugar,
para o fim da lateral, porque como faixa no fim da área útil ficava abaixo da
dobra em toda lista longa, que é onde ninguém o lia. O layout continua **fluido**:
o mockup fixa 1440px porque é prancheta; aqui a lateral é fixa em 252px e o resto
acompanha a janela. Saiu também o `max-width: 1500px` que o conteúdo tinha.

Duas coisas que o desenho não trata e o sistema precisa: `@media print` esconde
lateral e cabeçalho, senão a prévia impressa do parecer sairia com uma faixa de
252px em branco; e abaixo de 900px a lateral vira faixa no topo.

**Nenhum teste foi editado.** Os que afirmam a marcação da navegação continuam
passando porque a classe `menu-base` foi mantida com o mesmo significado, e o
invariante que compara menu com rota — aparecer no menu e abrir sem 403 têm de
dar a mesma resposta — segue valendo nos 4 perfis × 10 itens.

## [1.12.0] — 2026-08-13

### O certificado sai, e a segunda via sai idêntica
Fatia 4 do módulo Certificados e Treinamentos. `certificado` e
`certificado_sequencia`, emissão individual e em lote, anulação, segunda via, e a
chave de validação com dígito verificador. A turma agora vai da abertura ao papel
na mão.

**A RN-15 aplicada ao certificado é a fatia inteira.** Um certificado emitido
reimprime do `contexto_congelado`, nunca do catálogo de hoje. Renomear o
treinamento, corrigir a carga horária, cadastrar outro instrutor ou publicar nova
versão do modelo não mexem num papel que já circulou. Não há um segundo
mecanismo de congelamento no sistema: é o mesmo do parecer, num segundo documento.

**O mapa de tags entra no congelado, e essa é a parte que não é intuitiva.**
Congelar o conteúdo é óbvio; congelar *qual campo alimenta qual marcador* não é.
Como o dicionário de tags é editável na tela, sem o mapa congelado a segunda via
sairia com o nome do instrutor no campo do participante — sem erro, sem aviso,
sem ninguém perceber.

O **teste-espelho** troca modelo, mapa, instrutor e treinamento e exige texto
idêntico; e, para não passar por acidente, monta o mesmo documento a partir do
catálogo de hoje e exige que esse **seja diferente**. Sem a segunda asserção ele
seria decoração. Conferido também por mutação: desligado o congelamento, os dois
testes falham.

**A função que obtém o valor de cada campo não recebe sessão.** Lê do contexto
congelado e de mais nada — não conhece `Turma` nem `Participante`. Uma que
recebesse a sessão teria um caminho de volta ao catálogo de hoje, e esse caminho
seria descoberto por um certificado errado, não por um teste.

**A ordem da emissão importa:** permissão, recusa de duplicata, validação
inteira, e **só então** o número. Validar depois de consumir gastaria um número
por tentativa recusada, e a numeração ficaria com buracos que ninguém sabe
explicar. Anular também não devolve o número — a reemissão recebe um novo, senão
dois papéis diferentes circulariam como "27/2026".

**O lote roda uma transação por certificado.** Numa turma de trinta, um item que
trava não derruba os que já saíram, e o relatório diz quantos saíram, quantos
travaram e por quê.

**Retificar resultado de quem já tem certificado passou a ser recusado** — a
guarda que a fatia 3 deixou marcada e não escreveu porque a tabela não existia.
Sem ela, corrigir a presença por trás do papel deixaria o certificado afirmando
um resultado que o sistema não afirma mais, e no limite um reprovado convivendo
com um certificado válido.

**A rubrica é congelada pelo SHA-256 da imagem, não pelo id do anexo:** trocar o
arquivo passa a ser detectável, enquanto um id continuaria apontando para o
registro certo com o conteúdo errado.

**O que não é congelado, de propósito:** a situação e "está vencido hoje?". São
estado, calculados na hora — congelar estado é o erro simétrico, e o certificado
apareceria válido para sempre.

## [1.11.0] — 2026-08-13

### A turma fecha com resultado, e a lista de presença sai em .docx
Fatia 3 de Certificados. `turma_presenca` guarda uma linha por inscrito e por
dia, e é dela que sai a frequência — **calculada, nunca digitada**, recalculada a
cada lançamento. O denominador é a carga da **turma**, não a do catálogo: a
reciclagem que rodou em 8h de um curso de 40h dá 75% com seis horas, e não 15%.
Usar a carga errada num número que decide se o certificado sai é o pior defeito
que este módulo poderia ter, porque não faz barulho.

**Concluir a turma passou a ser um ato só.** Antes carimbava a data e mais nada.
Agora, na mesma transação, calcula a frequência de cada inscrito e atribui
aprovado ou reprovado — quem não tem presença registrada vira ausente, e daí
reprovado. Apurar num segundo botão deixaria a turma "concluída" com gente sem
resultado, que é o estado que ninguém sabe ler.

**Aprovado e reprovado deixaram de ser terminais — e só um vira o outro.** O caso
é concreto: a turma fecha na sexta e na segunda aparece a folha de um dia que
ninguém lançou; sem a aresta, corrigir exigiria SQL à mão. Mas ela não é passagem
livre: só a **retificação** a percorre, e ela pede `turma.concluir` — não
`turma.avaliar`, porque desfazer resultado já comunicado é de quem responde pela
turma, a mesma simetria do parecer, em que o técnico emite e não anula. Exige
motivo por escrito, recalcula a frequência a partir dos lançamentos e entra na
trilha como evento próprio. Voltar para presente ou ausente continua proibido:
inscrição de turma concluída sempre tem resultado, e apagar o resultado sem pôr
outro no lugar produz um estado que ninguém explica depois.

**A `CheckConstraint` do desenho quebraria no PostgreSQL.** `presente = 1 OR
horas = 0` funciona no SQLite, onde booleano é inteiro; no dialeto de referência
do projeto, `presente` é `boolean` e não se compara com `1`. Reescrita de forma
portátil, com o DDL conferido nos dois dialetos — o mesmo tipo de armadilha do
`check_regex` sem âncora da 1.8.1, e pelo mesmo motivo: passa despercebida porque
o sistema roda em SQLite.

**A lista de presença sai pelo mecanismo que já existia.** `documento.renderizar`
virou `renderizar_modelo`, e o parecer passou a delegar para ela — dois mecanismos
de documento seriam dois lugares para o hash de integridade divergir. A folha é
regerada a cada pedido, com quem está inscrito hoje e sem quem cancelou: uma
folha guardada seria uma folha desatualizada, e o nome de quem desistiu na lista
faria alguém assinar por ele. O modelo `.docx` é gerado por script versionado —
binário no repositório que ninguém sabe reproduzir vira artefato órfão.

### Um número que virava float e quebrava a prova de integridade
Achado porque um teste da cadeia de auditoria falhou sem motivo aparente.
`HistoricoEvento.valor_anterior` e `valor_novo` são `JSONTexto`. Gravar
`str(Decimal)` — `"50.00"` — volta do banco como **float**, e o digest da trilha,
calculado sobre o valor em memória, deixa de conferir: a verificação de
integridade acusaria **adulteração onde não houve**.

Corrigido gravando `Decimal` direto. Mas a armadilha continua de pé para o
próximo serviço que gravar número como string, e isso é a espinha de integridade
do sistema — a trilha encadeada por hash é o que sustenta a auditoria inteira.
Fica registrado como dívida: falta a trava que impeça o caso de nascer de novo.

### O que ficou para a fatia 4
Retificar o resultado de uma inscrição que já tenha certificado **não anulado**
precisa ser recusado — documento que circulou se anula e se reemite, nunca se
reescreve. A guarda não foi escrita agora porque `certificado` ainda não existe,
e guarda contra tabela inexistente é código morto, que foi um dos achados da
revisão da fatia 1. O lugar dela está marcado em `app/servicos/presenca.py`.

## [1.10.0] — 2026-08-13

### A turma roda de ponta a ponta, sem certificado
Fatia 2 do módulo Certificados e Treinamentos. Seis tabelas novas — `turma`,
`turma_sequencia`, `turma_instrutor`, `participante`, `participante_email`,
`inscricao` —, duas telas e as duas máquinas de estado que faltavam. O setor abre
a turma, define instrutor e vagas, inscreve servidor e externo, confirma e
cancela. Presença, nota e certificado não; a ficha da turma **declara** as duas
abas que faltam em vez de escondê-las.

**`participante` é a peça que não é só deste módulo.** Acidentes vai apontar para
ela, então nasceu com três decisões que valem para os dois:

- **Servidor é ponteiro, não cópia.** Guarda `servidor_id` e mais nada de
  identificação; nome, cargo e lotação continuam em `servidor` e são lidos de lá.
  Copiar o nome faria os dois divergirem no dia em que alguém corrigisse um
  deles — e o certificado sairia com o errado.
- **Externo existe só aqui**, com identificador público opaco (`PTC-7F3K9Q2M`),
  no mesmo alfabeto sem `0/O`, `1/I/L` e `U` da chave de validação, porque ele é
  ditado ao telefone. Não muda nunca: nem quando o e-mail muda, nem quando o
  externo vira servidor.
- **E-mail é tabela filha, nunca coluna.** É o que reconcilia a mesma pessoa que
  se inscreve hoje com o endereço pessoal e amanhã com o institucional — com o
  e-mail como coluna seriam duas pessoas, e o monitor de reciclagem diria "nunca
  fez" de quem fez. A forma normalizada é **derivada** da bruta pelo modelo, não
  digitada: deixar as duas independentes faria a reconciliação depender de quem
  lembrou de preencher a segunda. E normaliza só caixa e espaço — tirar ponto do
  Gmail ou sufixo `+` juntaria pessoas diferentes, que é o erro pior dos dois.

Nenhuma coluna de CPF, com teste que varre as tabelas novas para continuar assim.

### O conferidor de estado que passou a ser um só
O padrão de `estados.py` existia pela metade: a máquina do processo tinha função
codificada para ela mesma, a do direito tinha tabela e nenhuma função — quem
validava era `direito.py`, com a própria cópia de `destino in tabela[origem]`. A
terceira e a quarta cópias seriam a hora de descobrir que uma delas divergiu.

Agora há `pode()` e `exigir()`, e as quatro máquinas passam por eles. `turma` e
`inscricao` tinham cinco e oito situações declaradas só em `CHECK`, o que aceita
qualquer pulo entre elas — **oito estados sem transições declaradas é onde
`APROVADO` aparece antes de `PRESENTE`**. Concluir turma que nunca começou,
reabrir turma fechada, confirmar quem cancelou: recusado no **serviço**, não
escondido no template. A lição da 1.9.0 é literal aqui — o POST continua chegando.

### A numeração deixou de ser do parecer
`proximo_numero` virou genérica e o parecer é um invólucro dela, com
comportamento idêntico. O detalhe que o desenho não tratava: **nome de tabela não
aceita bind parameter**, entra no SQL por interpolação. A função tem lista fechada
de **pares** sequência→alvo e recusa o que não estiver nela — sem isso, a função
mais transacional do sistema ganharia superfície de injeção. O par é conferido
junto porque consumir de uma sequência e checar ocupação em outra tabela
repetiria número sem erro nenhum.

**O ano da turma é o do início, não o da criação.** Planejar em dezembro uma
turma de janeiro consome o número 1 do ano seguinte, que é como ela vai ser
citada — e por isso adiar para outro ano é recusado: `TUR-2026-0007` já está no
cartaz. A saída é cancelar e abrir outra, e a mensagem diz isso.

### A recusa que gravava o que devia ter desfeito
Achado durante a fatia 2 e depois varrido no sistema inteiro. A sessão da
requisição **commita quando a rota retorna** — e recusa é retorno normal. O
rollback do context manager só roda quando a rota **levanta**, porque o FastAPI
monta a pilha de saída das dependências por dentro do tratador de exceções. O
contrato agora está escrito em `dependencias.obter_sessao`, onde eram três linhas
sem docstring; essa invisibilidade já tinha produzido quatro bugs.

`/catalogos` e `/treinamentos` foram varridas inteiras: 16 funções candidatas, 39
pontos de recusa, **nenhuma ocorrência** — as duas foram escritas na ordem
"confere tudo, depois escreve". Nenhum código mudou nelas, porque conserto
defensivo em rota sã só espalha ruído; entraram 16 testes que exigem o banco
limpo depois de cada aviso, para que a ordem não se inverta numa edição futura.

Três ocorrências reais, todas corrigidas **reordenando** e nenhuma com rollback:

- **Mudança de lotação de servidor sem histórico** deixava um período de origem
  fantasma quando a alteração era recusada. Pior: na tentativa seguinte o
  fantasma virava o "período atual" e passava a barrar datas anteriores a ele —
  bug que se agrava a cada tentativa, e o usuário tenta de novo justamente por
  ter falhado.
- **Salvar parecer com número já usado** gravava o ano novo e mantinha o número
  velho — exatamente o par que a validação existe para impedir — e descartava o
  resto do formulário.
- **Emissão bloqueada** carimbava `data_emissao` no rascunho, e essa data passava
  a alimentar a validação, a montagem do documento e a vigência do signatário
  (RN-01). Não era só lixo: contaminava a decisão seguinte.

A correção estrutural — commit condicionado ao resultado da rota — foi avaliada e
**recusada, e não por risco: como regra universal ela é errada.** `POST /login`
com senha errada é uma recusa cuja escrita **é** o ponto, porque o contador de
tentativas é gravado antes do `raise` e a rota devolve a página de erro; "recusa
⇒ rollback" desligaria o bloqueio por força bruta em silêncio. O mesmo vale para
o evento `ASSINATURA_NEGADA`. A camada de sessão não distingue lixo de operação
recusada do registro da própria recusa — só a rota sabe.

### Removido
`app/banco.py::obter_sessao`, cópia órfã da dependência de sessão que ninguém
importava. Quem fosse mexer no contrato de commit/rollback podia editar a cópia
morta e achar que tinha resolvido.

## [1.9.0] — 2026-08-13

### A revisão adversarial da 1.8.0, e os seis defeitos que ela achou
A fatia 1 de Certificados subiu com 56 testes e a suíte verde. Verde prova que
não quebrou o que já era testado — não prova que está certo. Um revisor releu o
módulo contra o desenho, reproduziu cada suspeita em banco temporário, e achou
seis defeitos reais. Cada correção começou pelo teste que reproduz o cenário.

**Publicar nova versão a partir de uma versão superada.** Três das quatro rotas
de escrita conferiam se o modelo era o vigente; a quarta, não — nem no código,
nem no template. Clonar da v1 criava uma v3 vigente com o mapa de tags da v1 e
aposentava a v2. É exatamente a falha que o desenho chama de a pior possível do
módulo: a reversão silenciosa de qual dado vai em qual marcador, que faz o
certificado sair com o nome do instrutor no campo do participante. A guarda
entrou na rota; o formulário sumiu da tela por consequência, não por conserto —
guarda que só existe no template não é guarda.

**Um modelo de outro treinamento podia virar o modelo vigente**, e o seletor da
tela chegava a oferecê-lo; id inexistente respondia 500. Agora um só conferidor
recusa, com mensagem, o modelo inexistente, o de outro treinamento, a versão
superada e a assinatura inativa — e o seletor filtra por linha.

**Renomear um modelo para um nome ocupado respondia 500**: a rota de edição não
repetia a conferência que a de criação faz. Para modelo genérico a
`UniqueConstraint` nem alcança, porque `NULL` não colide com `NULL` — ali a
conferência no serviço é a única defesa.

**A edição não validava `.docx`**, contornando pela alteração a guarda que
existia na criação.

**Validade em branco virava "não expira".** A rota tinha a guarda certa, e ela
era inalcançável: o FastAPI troca a string vazia de um `Form` pelo default antes
de o código rodar. Um NR-35 de 24 meses editado com o campo apagado passava a
nunca vencer, com mensagem de sucesso. Campo em branco agora é recusado; `0`
digitado continua significando "não expira", porque são coisas diferentes.

O mesmo default-engolindo-vazio estava na **ordem da tag** (`Form("1")`), e ali o
efeito era pior por ser invisível: limpar o campo de ordem de uma linha e salvar
mandava aquela tag para o topo do documento.

**O seletor do catálogo apagava vínculo em silêncio.** Ele listava só modelos
vigentes e instrutores ativos — publicada a v2, a v1 que o treinamento apontava
sumia da lista, o navegador selecionava "—", e salvar qualquer outro campo da
linha gravava "sem modelo". O valor atual agora permanece na lista, rotulado
`(superada)` ou `(inativa)`.

**O ciclo de chave estrangeira**, diagnosticado corretamente pela primeira vez:
o aviso não vinha do `create_all`, que é limpo nos dois dialetos, e sim do
`sorted_tables`. O que quebrava de fato era o `drop_all` — e não só das duas
tabelas do ciclo: o SQLAlchemy desistia de ordenar o esquema inteiro.
`use_alter=True` resolve, sem migração.

### Uma decisão de desenho que a correção deixou à vista
Publicar a v2 de um modelo **não** move `treinamento.modelo_vigente_id` para a
versão nova. Hoje a tela diz isso em voz alta, com o `(superada)` no seletor. Na
fatia 4 isso decide com qual layout o certificado sai, e repontar
automaticamente tem implicação de auditoria — é decisão de desenho, não conserto
de defeito. Fica registrado para ser resolvido antes da emissão existir.

## [1.8.1] — 2026-08-13

### A fundação que EPI, Certificados e Acidentes precisam ter pronta antes
Quatro peças levantadas na revisão de arquitetura dos três módulos que vêm do
IntegraSST. Nenhuma delas entrega tela; todas ficam caras — algumas
irreversíveis — se forem feitas depois da fatia que as usa. Duas se veem hoje: o
administrador de TI deixa de ter o sino no cabeçalho, e o botão "concluir" de
`/pendencias` passa a aparecer linha a linha em vez de tudo ou nada.

**As dezesseis categorias de anexo, numa reconstrução só.** `anexo.categoria`
fechava em oito valores, todos do Processos SEI, e `anexos.guardar` recusa o que
não está na lista. Os três módulos novos trazem mais oito
(`MANUAL_EPI`, `FICHA_EPI`, `RUBRICA_INSTRUTOR`, `LISTA_PRESENCA`,
`CERTIFICADO`, `CAT_SP`, `RELATORIO_INVESTIGACAO`, `EVIDENCIA_ACIDENTE`).
Estender a `CHECK` no SQLite não é `ALTER`, é **reconstruir a tabela**: copiar os
dados, derrubar a antiga, recriar — com as chaves estrangeiras suspensas
enquanto isso. Fazer isso uma vez por módulo seria repetir três vezes um risco
que só precisa existir uma. Entraram todas juntas, antes das telas que as usam.

Categoria de anexo **não é rótulo: é o que decide quando o arquivo pode ser
apagado.** A rubrica do instrutor é o caso que provocou a pressa — anexada como
`FOTO` ou `OUTRO`, ela cairia na eliminação em 5 anos da política de retenção, e
apagaria em silêncio a assinatura de um certificado de guarda permanente. Hoje
não há upload de rubrica implementado, então a janela ainda estava aberta.

A tela do processo continua oferecendo **só as oito de sempre**
(`CATEGORIAS_PROCESSO`): a constraint aceita dezesseis, mas oferecer "ficha de
EPI" num processo de adicional ocupacional é convidar ao registro errado.
Nasceram restritas as categorias que nomeiam pessoa e dizem algo sobre a
condição dela no trabalho — ficha de EPI, lista de presença, certificado e as
três de acidente. Manual do fabricante e rubrica ficam públicos: um não tem
titular, o outro já sai impresso em todo certificado.

**Pendência deixa de ser só do processo.** `Pendencia` sabia apontar para
processo, parecer e laudo — os três objetos do Processos SEI. CA a vencer aponta
para um lote de estoque, reciclagem aponta para o servidor e o treinamento,
prazo do art. 214 aponta para a ocorrência: nenhum deles cabe ali, e sem âncora
a tela mostra a descrição e não leva a lugar nenhum. Entram `entidade` e
`entidade_id`, anuláveis e indexados — o mesmo par que `historico_evento` e
`anexo` já usam —, com uma `CHECK` que recusa meia âncora, porque metade
preenchida produz link quebrado, que é pior que link nenhum. Feito agora custa
duas colunas; feito depois custa backfill em pendência já aberta, que é trabalho
de alguém e não linha de catálogo.

**Quem recebe a pendência passa a conseguir abrir e fechar a pendência.**
`/pendencias` exigia `processo.ver` para ler e `processo.editar` para concluir.
Quem opera treinamento — e amanhã EPI e acidentes — não tem nenhuma das duas:
receberia a tarefa e não veria o sino. Agora a tela abre para quem tem qualquer
permissão de **leitura de módulo**, numa lista explícita, e não para "qualquer
permissão": o administrador de TI tem `indicador.ver` e continua fora, coerente
com "sem acesso ao conteúdo técnico". Para ele o sino também some do cabeçalho —
oferecer o link de uma tela que responde 403 é a mesma mentira que fez o menu
esconder Relatórios na 1.6.0.

E **o dono fecha a própria pendência**, mesmo sem permissão de escrita. Foi a ele
que a regra atribuiu o trabalho; tarefa que o dono não consegue riscar da lista
vira lista que ninguém lê. Fechar a pendência de outra pessoa continua pedindo
escrita no módulo.

**Perfil sem escopo declarado para de falhar em silêncio.** `MATRIZ_PERFIS` e
`ESCOPO_POR_PERFIL` são dois dicionários separados, e faltar no segundo não dava
erro nenhum: o perfil caía em escopo próprio e `aplicar_escopo` sobre tabela sem
`servidor_id` devolvia `where(False)`. A pessoa abriria a tela, veria zero linhas
e concluiria que não há nada — quando o que não há é escopo. O almoxarife do EPI
era o próximo a passar por isso.

Agora as duas listas são conferidas **na importação do módulo**: quem declarar
perfil sem escopo não sobe o sistema, e descobre no primeiro `import` em vez de
descobrir meses depois por uma reclamação de tela vazia. Para o perfil inserido à
mão por SQL, que não passa por essa conferência, consultar o escopo **nega com
mensagem** em vez de esvaziar a tela. E onde o escopo próprio legitimamente não
tem como se aplicar, fica pelo menos uma linha de log dizendo por que a lista
veio vazia. Errar alto é mais barato que mentir baixo.

### O sistema perdia a voz no boot
Achado por acidente: o teste do aviso de escopo passava sozinho e falhava na
suíte inteira. A causa é anterior a tudo isto e vale para produção.

`alembic/env.py` chamava `fileConfig(alembic.ini)`, e o padrão dessa função é
**desligar todo logger já criado que não esteja declarado no arquivo**. O
`alembic.ini` declara três: `root`, `sqlalchemy` e `alembic`. O logger `csso`,
criado no import de `app/principal.py`, não estava lá — e `migrar()` roda no
`ciclo_de_vida`, a cada boot. Resultado: o `log.error` do
`PRAGMA integrity_check` e os avisos de configuração insegura nunca chegavam a
lugar nenhum, desde a primeira linha depois da migração. Um sistema que avisa em
log ficava mudo justamente na hora de avisar.

Uma palavra de correção (`disable_existing_loggers=False`), e um teste que roda
`migrar()` e confere que os loggers continuam vivos.

### A constraint que não constrangia
`check_regex` montava `CHECK (coluna ~ 'padrao')`, e no PostgreSQL o operador
`~` casa **substring**, não a string inteira: `siape ~ '\d{7}'` aceitava
`abc1234567xyz`. O validador Python ao lado usa `re.fullmatch` — ou seja, os dois
guardas da mesma regra discordavam, e o do banco era o frouxo. Vale para as
cinco constraints do sistema (`ck_siape`, `ck_nup_fmt`, `ck_laudo_fmt`,
`ck_treinamento_codigo`, `ck_modelo_tag_marcador`).

O padrão passa a sair ancorado como `^(?:…)$`. O grupo não é enfeite: é ele que
faz a âncora valer para a alternância inteira — em `^a|b$` o `^` prende só o `a`
e o `$` só o `b`, e o padrão aceitaria qualquer coisa terminada em "b".

Hoje isso não muda nada em produção, porque a constraint é marcada como
exclusiva do PostgreSQL e o sistema roda em SQLite — não houve migração. Mas o
PostgreSQL é o dialeto de referência declarado do projeto, e uma constraint que
não constrange é pior que constraint nenhuma: dá confiança falsa a quem lê o
esquema e decide não validar de novo.

### Duas migrações, e por que duas
`d30b553943d1` (categorias de anexo) e `53bb59ebfbd2` (âncora da pendência). São
independentes e revertem separadas: dobrá-las numa só obrigaria a descer as
colunas de pendência para corrigir um problema de anexo. A primeira reconstrói
`anexo`; conferido depois de aplicar que as linhas continuam lá, que os três
índices sobreviveram — inclusive o parcial `uq_parecer_assinado_ativo`, com o
`WHERE` — e que `PRAGMA foreign_key_check` não acusa nada.

O `downgrade` da primeira **recusa antes de tocar em DDL** se houver anexo
gravado numa das categorias novas, e diz quais são. Dois motivos: descer por
cima deles apagaria a prova ou mentiria sobre o que ela é; e aqui o SQLite não
tem DDL transacional, então uma cópia que estourasse no meio deixaria
`_alembic_tmp_anexo` para trás e a tentativa seguinte falharia com "table already
exists" — erro que não diz nada sobre a causa.

Registrado para quem vier: **o `--autogenerate` não vê a mudança de
`ck_anexo_cat`.** O comparador confere `CHECK` por nome, e o nome não mudou, só o
texto dentro. Essa migração foi escrita à mão inteira.

### Peças compartilhadas que três módulos iam construir cada um a sua
**`datas_br.somar_meses`.** Validade de CA, reciclagem de treinamento e previsão
de troca de EPI somam meses a uma data, e os três desenhos traziam a própria
implementação. A regra que separa uma boa de uma ruim é o estouro de fim de mês:
31 de janeiro mais um mês não existe. Aqui o dia **gruda no último dia do mês de
destino** (28, ou 29 em bissexto), e o motivo é do domínio, não da aritmética —
quem conta prazo em meses conta o mês, e transbordar para 1º de março jogaria o
vencimento para fora do mês contado, ainda por cima esticando o prazo. Grudar
mantém dentro, que é o lado seguro para quem fiscaliza.

A consequência está documentada com teste próprio, para ninguém "corrigir"
depois achando que é defeito: **a operação não volta**. 31/01 + 1 mês = 29/02, e
29/02 − 1 mês = 29/01. Nenhum uso do domínio depende de ida e volta, porque o
vencimento é calculado uma vez na emissão e congelado.

**O filtro de termos proibidos passou a conhecer o contexto.** A RN-21 barra
"doença", "enfermidade", CID, diagnóstico e atestado no parecer de adicional, e
está certa: diagnóstico de servidor não tem o que fazer num parecer de
insalubridade. Só que "doença relacionada ao trabalho" é o nome jurídico de uma
das três espécies de acidente em serviço da Lei 8.112, art. 212 — o módulo de
acidentes não conseguiria registrar a espécie que a lei define.

A saída **não** foi liberar a frase: casar "doença relacionada ao trabalho"
quebraria na primeira variação de escrita e deixaria passar texto clínico colado
nela. O filtro passou a receber um contexto, escolhido no ponto de chamada e
visível na revisão. O contexto padrão é idêntico ao comportamento anterior — os
cinco pontos que hoje validam não foram tocados. O contexto do nexo ocupacional
dispensa **uma palavra**, nos campos narrativos da ocorrência e da investigação,
e não vale no campo onde alguém colaria o laudo pericial. "Enfermidade" continua
barrada até nele: não nomeia espécie nenhuma, então quem precisa dela está
descrevendo quadro clínico. Contexto desconhecido levanta erro em vez de cair no
silêncio de um filtro mais frouxo.

### Conformidade: o ROPA já estava falso, e não pelo motivo esperado
A emenda de `docs/ROPA.md` e `docs/POLITICA_RETENCAO.md` para os módulos novos
descobriu que o documento **já não descrevia o sistema de hoje**. Não por causa
de algo previsto: a fatia 1 de Certificados, que subiu nesta mesma data, criou o
primeiro titular que não é servidor — o **instrutor externo**, cujo nome, título,
conselho, registro profissional e organização `assinatura_instrutor` guarda, e
que a tela já cadastra. Registrado como vigente, não como previsto.

O ROPA listava "estado de saúde" entre os dados **expressamente não tratados**, e
o módulo de acidentes vai tratar. A retirada ficou datada, e o bloco novo diz o
que entra (categoria fechada de parte do corpo e natureza da lesão, mais os fatos
administrativos), o que **nunca** entra (CID, diagnóstico, texto clínico,
fotografia de lesão), a base do art. 11, as três permissões e a auditoria por
nível — tudo marcado como valendo **a partir de** a tabela existir, com a
afirmação explícita de que hoje nada de saúde é tratado. Documento de
conformidade que descreve futuro como presente é pior que documento
desatualizado, e por isso o §0 novo fixa a convenção: o que não traz marca é
vigente.

"Não há operador terceirizado" continua **verdadeiro** — nada em código chama
serviço externo, e a consulta de CNPJ do legado é proposta de desenho. A frase
não foi enfraquecida: virou condição, com emenda prévia obrigatória antes de
ligar IA, consulta de CNPJ ou SMTP.

Ficaram registradas as incertezas em vez de números inventados: a âncora
normativa da capacitação em SST no regime estatutário — as NRs são instrumento da
CLT, o que também deixa a citação da NR-6 marcada como a confirmar —, **menor de
idade**, que o documento ainda nega e que o primeiro acidente com estudante de
curso técnico torna falso, e a FK de `acesso_dado_sensivel`, que aponta só para
`servidor` e não comporta participante nem acidentado externo.

**Duas categorias de anexo não fecham com a política**: `EVIDENCIA_ACIDENTE` e
`LISTA_PRESENCA` têm prazo condicional — "permanente se citada no relatório",
"permanente quando houve certificado emitido". Isso é propriedade da linha, e
categoria é o que decide o descarte. Hoje não apaga nada, porque não existe
rotina de eliminação no código; a fatia que criar essa rotina precisa resolver
isso antes de rodá-la pela primeira vez. Na mesma conferência apareceu um defeito
anterior: a categoria `DESPACHO` não está em nenhuma das duas linhas de prazo.

## [1.8.0] — 2026-08-13

### Certificados e Treinamentos entra no sistema pelo catálogo
Primeira das oito fatias do `desenho_certificados.md`. Ela entrega o que o
Fabrício precisa ver funcionando antes de qualquer turma existir: o setor
cadastra os treinamentos que já ministra, desenha o certificado no Word e diz
qual marcador do documento recebe qual dado. O módulo deixa de ser promessa no
menu e passa a ter três telas de verdade.

O IntegraSST guardava, na mesma linha da planilha, o *treinamento* (nome, carga,
conteúdo, validade) e o *modelo do documento* (arquivo do Slides, pasta de
destino, mapa de tags). São coisas de ciclo de vida diferente — o treinamento
dura anos, o layout do certificado muda quando muda a identidade visual da
universidade — e juntas obrigariam a mexer no catálogo para redesenhar o papel.
Aqui são **`treinamento`** e **`certificado_modelo`**, separados.

- **`treinamento`**: código, nome oficial, carga horária, conteúdo programático
  e a validade da reciclagem em meses. **Zero significa que não expira** — é o
  único acerto do legado nesse ponto e ficou literal. A alternativa seria uma
  data mágica de vencimento, que mente em todo relatório de reciclagem depois.
  O código não é editável: ele é citado em ofício e em planilha, e duas grafias
  do mesmo treinamento é o começo de dois históricos.
- **`certificado_modelo` + `certificado_modelo_tag`**: o dicionário de tags do
  legado virou tabela filha do modelo, e o modelo é versionado. O de-para
  `{{ marcador }}` → campo do sistema continua sendo **dado**, editável na tela
  sem deploy; o que é **código** é o vocabulário de campos
  (`app/servicos/certificado.py`), porque cada campo precisa de alguém que saiba
  onde buscar o valor. Campo fora do vocabulário é recusado, nunca chutado — a
  mesma disciplina do conversor de mala direta. A ficha do modelo lê os
  marcadores reais do `.docx` e mostra, lado a lado, o que está no arquivo e não
  está no mapa: sem isso, o certificado sairia com `{{ nome }}` impresso.
  Publicar uma versão nova clona o mapa inteiro junto — começar do zero
  convidaria a redigitar trinta linhas, e é redigitando que se troca o nome do
  instrutor pelo do participante.
- **`assinatura_instrutor`**: quem assina, com vigência. Instrutor da UFVJM
  aponta para o cadastro de servidor e o nome é **lido** de lá, não copiado;
  externo existe só aqui. A rubrica deixa de ser link do Google Drive — no
  legado, mover um arquivo na nuvem quebrava o certificado.

**Permissões.** Entram `treinamento.ver`, `treinamento.gerenciar` e
`assinatura.gerenciar`, e só elas: permissão que não protege tela nenhuma é
declaração de poder que não existe. As outras nove do desenho chegam junto com
as fatias que as usam. O `admin_ti` continua sem nada, coerente com "sem acesso
ao conteúdo técnico"; a secretaria vê o catálogo porque vai operar inscrição e
emissão, mas não edita catálogo nem cadastra rubrica.

**`permissao.modulo` passa a nascer com o valor certo.** A coluna existe desde o
esquema inicial com default `'ADICIONAL'` e ninguém a preenchia — tudo nascia
como adicional. O seed agora a grava e a reconfere em quem já existe. **Nada em
`app/` lê essa coluna hoje**: `/perfis` renderiza a partir de `MATRIZ_PERFIS`,
que é código. A mudança é preparação para quando a tela de permissões por módulo
existir — o valor fica correto desde já, em vez de exigir backfill depois. Em
compensação, descrição e módulo passam a ser **propriedade do código**: o seed os
reescreve a cada boot, então editá-los no banco não adianta. Perfil e atribuição
continuam intocados.

**O menu diz o que ainda falta.** O módulo está em uso, mas incompleto: turma,
emissão, validação pública e monitor de vencimento vêm depois. Em vez de
esconder isso, `/modulos` passa a mostrar "o que ainda vem" também para módulo
disponível — antes só módulo previsto declarava o que lhe faltava, e um módulo
entregue pela metade tinha como calar.

### O que ficou para as fatias seguintes
Registrado aqui porque quem abrir as telas vai sentir falta: **prévia do
certificado em PDF** e a conferência de SHA-256 do `.docx` dependem da máquina
de emissão (fatia 4); `CAMPOS_CERTIFICADO` traz por ora só rótulo e exemplo de
cada campo — a função que *obtém* o valor entra com o congelamento, para nascer
junto da regra que o protege. Turma, inscrição, presença, certificado, validação
pública e monitor de vencimento não foram tocados.

### Uma duplicação a menos
A edição de catálogo com diff campo a campo na auditoria virou
`web.salvar_com_diff`, parametrizada pela permissão exigida. Era o mesmo bloco
em `/catalogos`, e copiá-lo para `/treinamentos` repetiria o erro que fez o menu
mentir na 1.6.0: a regra é uma só, o que muda é quem pode.

## [1.7.0] — 2026-08-12

### A entrada passa a ser pelo e-mail
Decisão tomada olhando os módulos que vêm do IntegraSST (EPI, Certificados,
Análise de Acidentes). Eles atendem **quem não tem SIAPE** — terceirizado,
estudante, bolsista, participante externo de turma. O sistema legado resolvia
isso com CPF como login; o CSSO não guarda CPF. Sobra o e-mail, que é o que a
pessoa sabe de cor e o único identificador que todo mundo tem.

- `buscar_por_login()` aceita **e-mail ou nome de usuário**, os dois sem
  depender de caixa nem de espaço em volta. O nome de usuário antigo continua
  valendo — a troca não pode trancar quem já entrava por ele.
- A tela de login pede **E-mail**. O campo **não** é `type="email"` de
  propósito: enquanto o servidor aceitar o usuário antigo, marcar o campo como
  e-mail faria o navegador barrar quem digita por hábito, e o erro apareceria
  antes mesmo de chegar ao servidor.
- O **primeiro acesso** parou de pedir nome de usuário. A coluna `login`
  continua obrigatória e única, então sai da parte local do e-mail
  (`Fabricio.Andrade@ufvjm.edu.br` → `fabricio.andrade`) — um segundo
  identificador que ninguém volta a digitar só serve para ser esquecido.

Uma distinção que o desenho preserva: **entrar** é pelo e-mail (`Usuario`);
**identificar o servidor no domínio** continua sendo pelo SIAPE (`Servidor`).
São entidades separadas e seguem separadas. E-mail muda com o tempo, por isso é
identificador de login — único e mutável — e nunca chave primária nem FK.

## [1.6.0] — 2026-08-12

### O sistema passa a ter módulos, e o primeiro se chama Processos SEI
Tudo que existia estava num menu só, plano, como se o sistema fosse o adicional
ocupacional. Não é: EPI, treinamento, CISSP e PGR vêm depois, e sem uma divisão
declarada cada um deles chegaria trazendo o próprio cadastro de servidor.

A divisão não é por tela, é por natureza:

- **Módulo** é o fluxo de trabalho de uma competência — some inteiro se a
  competência sair do setor. **Processos SEI** reúne Painel, Kanban, Processos
  (com o editor de parecer), Laudos, Adicionais, Relatórios e Importar.
- **Base** é o que qualquer módulo pressupõe: Servidores, Catálogos, Auditoria e
  Usuários. Ficam **fora** dos módulos de propósito. Se caíssem dentro de
  Processos SEI, o módulo de EPI precisaria do próprio cadastro de servidor — e
  o mesmo SIAPE passaria a existir em dois lugares, divergindo em um. Há teste
  que exige essa separação.

Na tela: barra nova abaixo do cabeçalho, com o seletor de módulo à esquerda, os
itens do módulo ativo no meio e a base separada à direita por uma divisória.
Entrar em `/pareceres/12` continua marcando Processos SEI como ativo — abrir o
editor não te tira do módulo.

- **`/modulos`**: o mapa do sistema. Cada módulo com o que ele faz e suas telas;
  os quatro previstos aparecem marcados como *ainda não desenvolvido*, com o que
  vão precisar ter. Módulo previsto declarado desde já é melhor que módulo que
  aparece de surpresa.
- **`app/modulos.py`** é a única fonte do menu e do mapa: declarar um módulo
  novo o faz aparecer nos dois lugares.

### Três telas estavam escondidas de quem podia abri-las
Ao reescrever o menu a partir das permissões reais das rotas, apareceu que o
menu antigo mentia: **Relatórios** e **Importar** nunca estiveram nele, e
**Catálogos** era escondido de quem tem `processo.ver` — que pode abri-lo em
leitura. Agora cada item declara a permissão que a rota de fato exige, e há uma
trava: para cada perfil e cada item, *aparecer no menu* e *abrir sem 403* têm de
dar a mesma resposta. São 40 combinações verificadas a cada rodada.

## [1.5.0] — 2026-08-12

### O servidor atende mais de um posto
O posto de trabalho era coluna única no período de lotação. Não bate com a
realidade nem com o próprio parecer: o parecer 1/2025 lista **LEAC e Laboratório
de Doenças Infecciosas e Parasitárias** para o mesmo servidor, e o documento já
tratava posto como lista. O cadastro agora também.

- Nova tabela **`lotacao_posto`** (`lotacao_id`, `posto_trabalho_id`, `ordem`).
  As colunas `posto_trabalho_id` de `servidor` e de `servidor_lotacao` saíram;
  a migração copia o posto que cada período já tinha como o primeiro da lista,
  para que nenhum histórico de exposição se perca na troca de forma.
- A seleção de postos entrou **na tela de cadastro** — antes só existia depois,
  no formulário de mudança de lotação. A lista é filtrada pela unidade escolhida,
  e um posto de outra unidade continua sendo recusado.
- `postos_atuais()` lê sempre o período aberto: a ficha, o parecer e o histórico
  passam a ter uma fonte única de "onde ele trabalha hoje".

### UORG é campo próprio, não a Unidade
São coisas diferentes no documento e nem sempre apontam para o mesmo nível: a
Unidade é o lugar (`Faculdade de Medicina de Diamantina`) e a UORG é o código de
lotação no SIAPE (`250 - FACULDADE DE MEDICINA DE DIAMANTINA`). Antes a UORG era
derivada da Unidade, o que só funcionava por coincidência.

- `uorg_id` em `servidor`, `servidor_lotacao` e `parecer_tecnico`, com o campo
  na tela de cadastro, no histórico de lotação e no editor do parecer.
- **Em branco significa "usar a própria Unidade"** — é exatamente o
  comportamento anterior, por isso a migração não precisou de backfill.
- Trocar a UORG entra no histórico e no diff da auditoria como qualquer outra
  mudança de lotação.

### Identificação editável
- Nome, SIAPE, e-mail e situação passam a ser corrigíveis na ficha, com diff na
  auditoria. SIAPE é validado (7 dígitos) e recusado se já for de outro servidor.
- Unidade, UORG, postos e cargo **continuam fora dessa edição**: mudam pelo
  histórico, com a data em que passaram a valer. A ficha diz isso na tela.

### Outros
- O rascunho do parecer nasce com unidade, UORG e postos da lotação vigente.
- `alembic/env.py` suspende as FKs durante a migração no SQLite (o
  `batch_alter_table` recria a tabela, e recriar `servidor` exige derrubá-la) e
  roda `PRAGMA foreign_key_check` ao final — se a migração deixou órfãos, ela
  falha ali em vez de em produção.

## [1.4.0] — 2026-08-12

### Edição em todos os catálogos — e o que precisou vir antes
Liberar a edição dos catálogos abriu um buraco sério: o parecer lia o catálogo
**na hora de reimprimir**. Renomear um agente nocivo ou corrigir o texto de uma
fundamentação reescreveria, em silêncio, um documento já emitido e assinado.

- **`parecer_tecnico.contexto_congelado`**: na emissão, todo o conteúdo
  renderizado é congelado em JSON, e a reimpressão sai dele — não do catálogo de
  hoje. É a RN-15 levada às últimas consequências: antes só a sigla do emissor e
  o cargo eram congelados. Há teste que emite, troca agente, fundamentação,
  unidade e tipo de risco, reimprime e exige texto idêntico.
- Rascunho continua seguindo o catálogo: só congela quem foi emitido.

Com isso resolvido, ganharam edição em linha, com diff campo a campo na
auditoria: **campi, unidades/UORG, postos de trabalho, cargos, agentes nocivos,
tipos de risco, fundamentações legais, portarias e checklists modelo**.

Dois catálogos são deliberadamente diferentes:
- **Percentuais**: só o rótulo é editável. O valor é a lei — 5/10/20% para
  insalubridade e irradiação ionizante, 10% para periculosidade e raios X
  (Lei 8.270/91, art. 12) — e a base é sempre o vencimento do cargo efetivo (§3º).
- **Textos padrão**: continuam versionados. Editar cria a versão seguinte e
  desativa a anterior, em vez de sobrescrever.

## [1.3.0] — 2026-08-12

Ajustes pedidos durante o uso manual, com o banco zerado para cadastro do zero.

### Histórico de lotação e cargo
- Nova tabela `servidor_lotacao`: o servidor muda de unidade, de posto e de
  cargo, e o adicional depende de **onde e em que função** ele estava em cada
  período. Sobrescrever o cadastro apagaria a prova da exposição passada — que é
  exatamente o que a aposentadoria especial (M2) vai precisar.
- Cada alteração **fecha o período anterior na véspera e abre um novo**: sem
  lacuna e sem sobreposição, com detector de inconsistência na própria ficha.
  `lotacao_em(data)` responde onde o servidor estava naquele dia.
- Correção no mesmo dia em que o período começou **substitui** o período em vez
  de criar outro de duração zero — é o caso de cadastrar o servidor e ajustar a
  lotação em seguida, que antes era recusado.
- O posto é validado contra a unidade: posto de outra unidade é recusado, e a
  tela filtra a lista de postos pela unidade escolhida.
- Só `documento` e `observação` podem ser corrigidos depois; data e destino não —
  para isso existe um novo período, senão a linha do tempo vira ficção.

### Cadastro de campus, unidade, posto e cargo
- `/catalogos/campi`, `/catalogos/unidades-uorg`, `/catalogos/postos-trabalho` e
  `/catalogos/cargos` ganharam formulário. Antes só listavam — e `cargos` nem
  aparecia no índice, embora a rota existisse.
- Cargos podem ser renomeados na própria lista, que mostra quantos servidores
  usam cada um. Renomear é seguro para o que já saiu: o parecer congela o cargo
  em `cargo_snapshot` na emissão (RN-15), então a reimpressão de um parecer
  antigo continua trazendo o nome que valia naquele dia — há teste provando.
- Onde um seletor pode ficar vazio (cargo, portaria), a tela agora diz onde
  cadastrar em vez de deixar o campo mudo.
- A unidade tem **dois nomes**, de propósito: o oficial (caixa alta do SIAPE, que
  sai no campo UORG) e o do corpo do parecer. A caixa é preservada byte a byte.
- `Laboratório de Química` pode existir em várias unidades; o par
  (unidade, nome) é que é único.

### Três ajustes no editor do parecer
- **Número editável enquanto rascunho.** O setor já emitiu pareceres fora do
  sistema e precisa continuar a numeração. O número é conferido contra os já
  usados, a alteração vai para a auditoria e a sequência é empurrada para a
  frente do maior número — o automático não repete depois.
- **Portaria cadastrada dentro do editor.** Antes, com o catálogo vazio, a lista
  aparecia vazia sem dizer o que fazer. Agora o formulário está na própria tela,
  lê número e data do texto, e já vincula ao parecer.
- **Classificação do art. 9º selecionável.** Com horas informadas, ela continua
  sendo calculada e **a medição prevalece**; sem medição de jornada, o técnico
  escolhe. `exposicao.classificacao_origem` guarda se foi medida ou informada, e
  divergência entre as duas gera evento `CLASSIFICACAO_DIVERGENTE`.

## [1.2.1] — 2026-08-12

### Entrar tinha de funcionar, e não funcionava
- **Login passou a ignorar maiúsculas e espaços em volta.** A conta `Bisso` não
  entrava digitando `bisso`: a busca era por igualdade exata, o que produz um
  "usuário ou senha inválidos" impossível de depurar — e o contador de tentativas
  nem sobe, porque a conta sequer é encontrada. A **senha** continua sensível a
  maiúsculas; isso sim é segurança.
- A mensagem de erro aparecia **duas vezes** na tela de login: o layout e a
  própria tela desenhavam a mesma coisa.
- `ferramentas/senha_cli.py`: define a senha de uma conta local. O sistema não
  manda e-mail, então sem isto não há como recuperar acesso se ninguém entra. A
  senha é lida com `getpass` — não vai por argumento (ficaria no histórico do
  shell) nem aparece na tela. Registra `SENHA_REDEFINIDA_LOCALMENTE` e revoga as
  sessões.

### Extração
- `documento_sei_de_anexo` passou a reconhecer a segunda grafia real do quadro,
  `SEI_1486577_Oficio_24.pdf`, além de `Parecer (1234567).pdf`.

## [1.2.0] — 2026-08-12 — migração do Trello executada

Carga real do quadro **SEI** (`KBZgbh38`): 745 cartões, 8.647 ações, 99 anexos.

### O quadro real contra a especificação
- 23 listas e 727 cartões abertos, não 8 listas e 475. Os números citados na
  especificação batiam todos; faltavam 15 listas e 252 cartões. De-para
  estendido, com teste que quebra se alguma lista for renomeada.
- O regex de exercício não aceitava `Concluído - 2021` nem
  `Processos Concluidos - 2022` — 91 cartões que iriam para o rejeitado.

### Separação do backlog
- 92% dos 382 cartões do backlog só têm nome e número de processo, parados há
  3 anos em mediana. Regra nova: **qualquer rastro de trabalho** (anexo,
  checklist, comentário, prazo aberto, descrição com conteúdo, movimento em
  365 dias) mantém na fila; o resto é cadastro histórico, no repositório.
- Resultado da carga: **24 pendentes, 321 histórico**.
- `indicadores()` passou a excluir o repositório — sem isso, 321 registros de
  arquivo virariam 321 "pendências" no painel.

### Dois defeitos corrigidos, achados pela carga real
- **`CARTAO_NAO_PROCESSO` não pegava quase nada.** O padrão
  `^(1-)?modelo|MODELO|ANTIGO|desativado` usado com `.match()` ancora *todas* as
  alternativas no início da string, então `ADICIONAL DE INSALUBRIDADE ANTIGO` e
  `Laudos MODELO para Dr. Evanildo` entravam como processo. Agora é busca por
  palavra inteira em qualquer posição.
- **A simulação respondia "0 processos".** Ela saía do laço antes de classificar,
  o que torna o ensaio inútil justamente quando ele mais importa. Agora calcula
  tudo (inclusive tentando abrir cada anexo) sem gravar, e há teste provando que
  simulação e carga contam igual.

### Ferramentas de migração
- `ferramentas/baixar_trello.py` — baixa quadro, feed de ações e anexos com
  credencial do `.env`, e grava um índice `url -> arquivo` (nomes de anexo se
  repetem entre cartões; casar só por nome perderia arquivo).
- `ferramentas/importar_trello_cli.py` e `ferramentas/importar_planilha_cli.py` —
  simulação por padrão, `--aplicar` para valer.
- `ferramentas/receber_export.py` — ponte `window.name` para quando não há
  credencial de API (o Chrome sob automação bloqueia download e loopback).

### Estado do banco após a carga
640 processos (375 no repositório), 14 pareceres, 78 anexos com SHA-256,
**7.443 eventos com a data original** — o mais antigo de 09/09/2020 —,
102 registros em `migracao_rejeitada` e 2 pendências abertas.

## [1.1.0] — 2026-08-11

Fecha as lacunas que a v1.0 deixou: o direito concedido não tinha como ser
operado, os anexos do Trello não eram importados, três dos cinco relatórios de
reconciliação não existiam e quatro visões salvas apontavam para filtros que o
sistema ignorava.

### Máquina do direito (máquina B) — de modelo a funcionalidade
- `app/servicos/direito.py`: propor, conceder, suspender, reavaliar, alterar,
  cessar e retomar, cada transição validada contra `TRANSICOES_DIREITO`.
- **RN-09 com dentes**: conceder sobre adicional vigente exige o registro de
  opção anexado (Lei 8.112/90, art. 68, §1º) e encerra o anterior na véspera —
  datas encadeadas, sem lacuna nem sobreposição. `lacunas_na_linha_do_tempo()`
  denuncia o que já estiver torto.
- **RN-21 preservada**: `suspender_por_afastamento_legal()` grava
  `AFASTAMENTO_LEGAL` + `Lei 8.112/90, art. 69, p.ú.`; há teste que varre os
  eventos procurando "gesta/gravid/lacta" e falha se aparecer.
- Tela `/adicionais` com a linha do tempo por servidor e as ações por estado.

### Pendências com dono e prazo (RN-06) e o sino
- Nova tabela `pendencia`, idempotente por chave: a mesma regra não abre duas.
- A emissão passa a abrir `AVALIACAO_QUANTITATIVA` (agente químico) e
  `INCLUIR_NO_SEI`; superar laudo abre `REAVALIACAO_LAUDO` por parecer derivado.
- Sino no topo de toda tela, com contagem e destaque para as atrasadas;
  `/pendencias` lista, filtra por dono e conclui.

### Anexos do Trello — o dado que estava se perdendo
- `_importar_anexos()` baixa, calcula SHA-256, deduplica e classifica a
  categoria pelo nome; extrai o nº do documento SEI de `(1234567)`.
- **As URLs do Trello expiram**: sem o download marcado, cada anexo entra no
  relatório de perdidos com a URL e vira linha em `migracao_rejeitada`. Falha de
  rede não derruba a carga.

### Os cinco relatórios de reconciliação (Fase 4)
- `app/servicos/reconciliacao.py` e `/importar/reconciliacao`: órfãos de
  processo, órfãos de parecer, conflito de numeração, NUPs com DV inválido e
  divergência de marco inicial. Exportável em CSV. Nenhum resolve nada sozinho.

### Listas que não mentem mais
- As oito visões salvas do §7 agora filtram de verdade: `dias=90`,
  `sem_percentual`, `reavaliacao_pendente` e `sem_parecer_assinado` eram links
  decorativos. Quando o filtro depende de dado derivado, a paginação e o
  contador passam a ser calculados sobre o conjunto filtrado — senão o total
  mente e a paginação pula registros.
- Agrupamento colapsável por estado, unidade, responsável ou tipo.
- Seleção múltipla e ações em lote (estado, responsável, prazo), avaliando cada
  processo sozinho: o que a máquina de estados recusar volta com o motivo.
- `Ctrl+K` foca a busca em qualquer tela.

### Configuração
- **SLA por coluna virou parâmetro** (nova tabela `parametro`), editável em
  `/config` por quem tem `catalogo.gerenciar`, com auditoria da mudança. `0`
  desliga o alerta.
- Catálogo `checklists-modelo` e aplicação do modelo na ficha do processo.

### Senha
- Tamanho mínimo reduzido de 12 para **6 caracteres**, a pedido do coordenador.
  Mantidas a exigência de misturar letras e números, a lista de senhas triviais,
  o hash Argon2id e o bloqueio após 5 tentativas. Ressalva registrada em
  `PENDENCIAS.md`.
- Senha provisória agora é curta e ditável (4 letras + 2 dígitos, sem `0/O/1/l`).

### Também nesta versão
- A migração da planilha passa a abrir a pendência de avaliação quantitativa dos
  pareceres químicos já emitidos: o parecer saiu, mas a obrigação continua devida
  — e a migração é justamente onde essa dívida aparece.
- `cenario` e os atores dos testes saíram de `test_emissao.py` para o `conftest`
  e para `testes/integracao/papeis.py`, para que os novos arquivos de teste
  reaproveitem o caso do 1/2025 em vez de reconstruí-lo.

### Verificação
- 432 testes verdes (1 `skip`: o CA-05 completo espera LibreOffice).
- Cobertura de `app/servicos/`: **92%**.
- Três migrações Alembic encadeadas; `upgrade` chega a 47 tabelas e 6 triggers,
  `downgrade base` limpa tudo.
- Verificado no sistema rodando: primeiro acesso com senha de 6 caracteres,
  delegação de perfil com ato normativo, importação da planilha real, direito
  proposto e concedido, 2 pendências abertas pela migração dos pareceres
  químicos, os cinco relatórios de reconciliação, as visões salvas, o
  agrupamento e o SLA gravado.

## [1.0.0] — 2026-08-11

Primeira versão utilizável. Substitui Trello + planilha + mala direta no módulo
Adicional Ocupacional.

### Sprint 0 — esqueleto executável
- `uv` + FastAPI + SQLAlchemy 2 + Alembic + SQLite (WAL, `foreign_keys=ON`,
  `busy_timeout`, `BEGIN IMMEDIATE` em toda transação).
- Árvore de pastas canônica, `.env` + `config.py`, `/saude` e `/saude/db`.
- `INICIAR.bat` (instala o `uv`, cria o `.env`, sobe e abre o navegador),
  `PARAR.bat`, `BACKUP-AGORA.bat`, `EXPORTAR-TUDO.bat`.
- HTMX 2.0.4 vendorizado em `app/estaticos/htmx.min.js` — nenhum CDN.

### Sprint 1 — o documento
- `ferramentas/converter_modelo_maladireta.py`: converte o `.docx` de mala
  direta em modelo `docxtpl`. Trata `fldSimple` e a sequência
  `fldChar begin → instrText → separate → resultado → end`, inclusive quando o
  resultado atravessa parágrafos (Fundamentação Legal). Herda o `rPr` do run
  interno, preserva os asteriscos de nota, envolve a Reavaliação em
  `{%p if reavaliacao %}` e desfaz o vínculo de mala direta.
- Cabeçalho, assinatura e destinatário viraram campos: o setor emissor, o
  subscritor e a autoridade passam a vir do banco (e são congelados na emissão).
- `modelo_parecer_v1.docx` (defeito de rótulo preservado) e
  `modelo_parecer_v2.docx` (rótulo corrigido), com fixture de ouro própria.
- `servicos/documento.py`, `datas_br.py`, `textos.py`, `numeracao.py`, `pdf.py`,
  `nup.py`, `sei.py` (interface definida e vazia), `rbac.py`, `auditoria.py`.
- **CA-01 verde:** o parecer 1/2025 (Marco Antônio) é reproduzido a partir de
  dados digitados e bate com o PDF assinado.
- `docs/ROPA.md` e `docs/POLITICA_RETENCAO.md`.

### Sprint 2 — importação da planilha
- Staging com as 25 colunas como texto (a coluna Y órfã é preservada),
  classificação COMPLETA/PARCIAL/RESERVA, resolução de entidades na ordem
  UORG → posto → servidor (por SIAPE) → cargo → agente → portaria → laudo →
  processo, extração da data embutida na recomendação, recontagem da sequência,
  relatório linha a linha e tela `/importar` com modo simulação.
- **CA-06 verde** contra a planilha real de 2026.

### Sprint 3 — kanban e ficha
- `/kanban` com as 5 colunas de fluxo, aba de repositórios, arrastar e soltar,
  badges (⏱ 🕐 ≡ 📎 ☑) e recusa explicando o que falta para mudar de estado.
- `/processos/:id` com abas Dados / Parecer / Anexos / Checklist / Histórico,
  anexos com dedup por SHA-256 e linha do tempo append-only.

### Sprint 4 — RBAC e governança
- 10 perfis, 24 permissões, atribuição com escopo e `ato_normativo`,
  `/primeiro-acesso` (sem `admin/admin`), sessões revogáveis, bloqueio por
  tentativas, troca obrigatória de senha, `/usuarios`, `/perfis`, `/auditoria`.
- **As três travas da RN-01**: permissão (403), validação no serviço e trigger
  no banco. A técnica de segurança emite e move o kanban; ao assinar, recebe 403
  e o evento `ASSINATURA_NEGADA`.

### Sprint 5 — busca, listas e relatórios
- `/processos` com busca, filtros na URL, visões salvas e exportação CSV.
- `/relatorios` com lacunas de numeração, laudos sem conferência há mais de 24
  meses (com o rodapé de que laudo não vence) e adicionais vigentes por laudo.
- Supressão de célula n<5 com supressão secundária nas visões agregadas.

### Sprint 6 — importação do Trello
- JSON completo do quadro, feed `actions` com a data original preservada,
  de-para explícito das 8 listas (lista não mapeada vira `migracao_rejeitada`),
  `CARTAO_NAO_PROCESSO`, extração de candidatos a parecer e laudo (nunca
  vinculados automaticamente) e os relatórios de reconciliação.

### Sprint 7 — direito, alertas e exportação
- `adicional_vigencia` (máquina B) com cascata de reavaliação ao superar laudo,
  índice único de um adicional vigente por servidor, SLA por coluna.
- Backup `VACUUM INTO` + AES-256-GCM e restauração testada; `EXPORTAR-TUDO` com
  planilha nas 24 colunas rotuladas + `col_Y_sem_cabecalho`, CSVs UTF-8 com BOM
  e separador `;`, banco, documentos, anexos e `LEIA-ME-DO-EXPORT.txt`.

### Fase 5 — conferência da migração
- `ferramentas/conferir_reimpressao.py` reimprime pareceres migrados (modelo v1
  + `texto_recomendacao` literal) e compara com os PDFs assinados. Rodado contra
  os 10 pareceres reais de 2026: **3 idênticos**, 1 com a única divergência
  esperada (`Esterelização` → `Esterilização`, o de-para aprovado), 5 bloqueados
  por serem PARCIAL na planilha, e **1 conflito de numeração real exposto** — o
  arquivo `Parecer_Tecnico_08-2026_SEST-_Juliana.pdf` contém o parecer 7/2026,
  que a planilha registra como reserva vazia.
- Dois achados corrigidos a partir dessa conferência: a cidade do parecer é a do
  setor emissor (não a do campus avaliado — o 2/2026, da FAMMUC, é datado em
  Diamantina) e o cabeçalho do SEST tem duas vigências textuais entre 2025 e 2026.

### Sprint 8 — endurecimento
- `PRAGMA integrity_check` no boot, migração Alembic com as travas de banco,
  matriz RBAC visível em `/perfis`, `LEIA-ME.txt` e `PENDENCIAS.md`.

### Regras que o sistema torna impossíveis de violar
- Assinar sem habilitação vigente (RN-01, três camadas).
- Reemitir número de parecer já usado ou reservado (RN-03).
- Emitir com dado obrigatório faltando (RN-04, com a lista do que falta).
- Marco inicial anterior ao laudo (RN-05).
- Percentual fora do domínio legal ou de outro adicional (RN-08, RN-09).
- Editar parecer emitido (RN-14) ou apagar evento de auditoria (CA-16).
- Registrar CID, diagnóstico, gestação ou CPF em qualquer campo (RN-21).

### Verificação desta entrega
- 344 testes, todos verdes (1 `skip`: o CA-05 completo espera LibreOffice).
- Cobertura de `app/servicos/`: **91%** (meta do CA-17: ≥90%).
- Migração Alembic: `upgrade` cria 44 tabelas e 6 triggers; `downgrade` limpa tudo.
- CA-15: partida a frio respondeu `/saude` em **5,9 s** com `integrity_check: ok`.
- Planilha real de 2026 importada pela tela `/importar`: 15 linhas → 3 completas,
  5 parciais, 7 reservas; 14 pareceres e 5 processos no banco.
- Backup cifrado (432 KB) e `EXPORTAR-TUDO` (20 itens: planilha nas 25 colunas
  com BOM, CSVs, banco, documentos e anexos) gerados e conferidos.

### Pendente após a 1.0
- Confirmações do Fabrício listadas em `PENDENCIAS.md` (percentuais com a
  PROGEP, data de corte SEST→CSSO, códigos UORG de FCBS e FCA, campi avançados,
  rodapé do art. 17 e autorização do modelo v2, de-para de agentes sinônimos).
- LibreOffice não instalado na máquina de desenvolvimento: o PDF automático não
  foi exercitado ponta a ponta (o teste do CA-05 fica marcado como `skip` até
  haver `soffice`; a degradação elegante está testada).
- Importação real do Trello: o de-para e os relatórios estão testados contra um
  quadro-fixture com as 8 listas; falta rodar contra o JSON real dos 475
  cartões e baixar os anexos antes que as URLs expirem.
- Módulos M2 a M9 do roadmap: fora da v1, por decisão.
