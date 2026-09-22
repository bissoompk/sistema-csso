# Pendências — perguntas ao Fabrício

Nenhuma delas bloqueia o uso do sistema. Cada uma está implementada com um
**default explícito**, que é o que está rodando hoje. Ao confirmar, ajuste o
catálogo pela tela `/catalogos` (ou os seeds em `app/servicos/sementes.py`).

| # | Pergunta | Default assumido | Onde muda |
|---|---|---|---|
| 1 | O `.docx` modelo e o PDF assinado 1/2025 | **Recebidos e em uso.** `entrada/CSSO_Modelo_Parecer_Adicionais.docx` e `entrada/Parecer_Tecnico_01-2025_assinado.pdf`; o CA-01 compara com o assinado | — |
| 2 | Percentuais confirmados com a PROGEP | Insalubridade 5/10/20%; irradiação ionizante 5/10/20%; periculosidade 10%; raios X 10%. Base: vencimento do cargo efetivo | `/catalogos/percentuais` |
| 3 | Data de corte `SEST/DASA/PROGEP` → `CSSO/Sisa` | **18/06/2026** como último dia do SEST (o parecer 8/2026, de 18/06/2026, ainda saiu com a sigla antiga); CSSO a partir de 19/06/2026 | `/config` → setor emissor |
| 3b | O cabeçalho do SEST mudou de texto entre 2025 e 2026 — está certo? | **Sim, duas vigências.** Até 2025: `Serviço Especializado em Segurança do Trabalho` (parecer 1/2025). Em 2026: `Seção de Segurança do Trabalho` (pareceres 1, 2 e 8 de 2026 assinados). Mesma sigla, cabeçalho diferente | `/config` → setor emissor |
| 4 | Códigos UORG de FCBS e FCA | **Sem código.** As duas unidades existem por sigla e nome; a coluna `codigo_uorg` está vazia | `/catalogos/unidades-uorg` |
| 5 | Quais campi são "avançados" | **JAN (Janaúba) e UNA (Unaí)** avançados; DIA (Diamantina) e MUC (Teófilo Otoni) sede | seeds `campus` |
| 6 | O rodapé do art. 17 fica literal ou é corrigido? | **Literal.** O texto atual cita o art. 17 da IN 15/2022 para o "Formulário", mas o art. 17 trata da responsabilização de peritos e dirigentes. O texto está preservado byte a byte em `texto_padrao / RODAPE_RESPONSABILIDADE / FORMULARIO_ART17 v1`. Junto: autorizar ou não o `modelo_parecer_v2.docx`, que corrige `Nº do Laudo Técnico:` para `Nº do Parecer Técnico:` | `/catalogos/textos-padrao` e o seletor de modelo no editor |
| 7 | Significado do prefixo `26255` no número do laudo | **Código da UFVJM no SIAPE** (assumido). Só documental: o sistema valida o formato, não o significado | — |
| 8 | De-para de agentes nocivos sinônimos | `Manuseio de substâncias químicas` → `Manipulação de produtos químicos`. **É o único de-para que altera semântica** e precisa de aprovação explícita | `/catalogos/agentes-nocivos` |
| 9 | Haverá irradiação ionizante ou raios X no piloto? | **Não.** Os dois tipos estão cadastrados e com as regras da RN-22 implementadas, mas marcados como inativos | `/catalogos` |
| 10 | Encarregado (DPO) da UFVJM | Campo em branco no `docs/ROPA.md` | `docs/ROPA.md` |
| 11 | Tamanho mínimo de senha | **6 caracteres**, a seu pedido (era 12). Continua exigindo mistura de letras e números e recusando senhas triviais | `app/servicos/autenticacao.py` |

### Sobre a senha de 6 caracteres

Você pediu e está feito. Registro a ressalva de uma linha, porque o sistema
guarda dado pessoal de servidor: 6 caracteres é curto para resistir a um ataque
de força bruta offline caso o arquivo `csso.db` vaze. O que segura o risco hoje:

- a senha é guardada em **Argon2id** com sal — o `.db` não contém senha em claro;
- **5 tentativas erradas bloqueiam a conta por 15 minutos**, o que inviabiliza
  força bruta pela tela de login;
- o sistema roda em `127.0.0.1`, sem exposição de rede.

Se um dia o sistema for exposto na rede institucional (`CSSO_HOST=0.0.0.0`),
vale rever isto junto com o TI. O valor está em uma constante única:
`TAMANHO_MINIMO_SENHA`, em `app/servicos/autenticacao.py`.

---

## Decisão que contraria a especificação (a seu pedido)

**RN-07 dizia: a classificação do art. 9º é calculada, nunca digitada.** Você
pediu para poder selecionar eventual/habitual/permanente, e faz sentido: nem
todo posto tem jornada medida, e sem essa saída o parecer empaca.

O que fiz, para atender sem perder o critério legal: quando há horas
informadas, a classificação continua sendo **calculada** e a medição prevalece
sobre a escolha; sem medição, vale o que o técnico selecionar. O campo
`exposicao.classificacao_origem` guarda qual dos dois foi — `CALCULADA` ou
`INFORMADA` — para que a auditoria saiba depois o que foi medido e o que foi
julgado. Se as duas existirem e divergirem, fica registrado o evento
`CLASSIFICACAO_DIVERGENTE`.

Se preferir que a escolha manual sobreponha a medição, é uma linha em
`app/servicos/parecer.py::aplicar_classificacao`.

---

## Como trazer o Trello (falta uma credencial sua)

O quadro é privado e retorna `401` sem sessão. O Chrome, sob automação, bloqueia
tanto download por script quanto navegação para `127.0.0.1`, então não deu para
fazer a ponte pelo navegador. O caminho definitivo é uma credencial de API sua:

1. Abra <https://trello.com/power-ups/admin>, crie um Power-Up qualquer e pegue
   a **API key**; na mesma tela, gere o **Token** a partir dela.
2. Escreva os dois no `.env` (já tem os campos prontos) — **nunca** em linha de
   comando, nunca no repositório:
   `CSSO_TRELLO_KEY=` e `CSSO_TRELLO_TOKEN=`
3. Rode, nesta ordem:

```
python -m ferramentas.baixar_trello KBZgbh38
python -m ferramentas.importar_trello_cli entrada/trello_KBZgbh38.json --anexos entrada/anexos_trello
python -m ferramentas.importar_trello_cli entrada/trello_KBZgbh38.json --anexos entrada/anexos_trello --aplicar
```

O segundo comando é simulação: mostra o relatório inteiro e desfaz. Só o
terceiro grava. **Apague a chave e o token do `.env` quando a migração
terminar** — eles dão acesso a todos os seus quadros.

São 102 anexos, 136,6 MB. As URLs do Trello expiram: baixe antes do corte.

## O quadro real do Trello (lido em 11/08/2026)

O quadro é o **"SEI"** (`KBZgbh38`), e ele é bem maior do que a especificação
dizia: **23 listas e 727 cartões abertos**, não 8 listas e 475. Os números que a
especificação citava batem todos — 381 Adicional Ocupacional, 10 Campus
Avançados, 50 Aposentadoria Especial, 3/5/4/4 nas listas de fluxo, 18 no
Concluído 2026 —, mas faltavam 15 listas e 252 cartões.

O de-para foi estendido para as 23 listas e há teste que quebra se alguma for
renomeada. Três decisões precisam do seu aval:

| Lista | Cartões | O que fiz | Confirmar |
|---|---|---|---|
| `Entrada`, `Processos`, `Delegar` | 19 | Viram fila `A fazer`, estado `RECEBIDO` | São mesmo fila de trabalho, ou são anotação? |
| `Adicional Ocupacional - Digitalizados` | 12 | Repositório de adicional, como o backlog principal | Digitalizado = já concluído, ou é fila? |
| `Comissões` | 6 | Tipo `CONSULTA_NORMATIVA`, fila `A fazer` | É outro assunto; fica no módulo? |
| `Painel Geral`, `Painel de Controle`, `Processos Geral - Informação` | 12 | **Não viram processo** — entram como `LISTA_DE_ANOTACAO` no relatório de rejeitados | Confere? |
| `Processos Concluidos - 2022` (53) e `Concluído 2022` (12) | 65 | Ambas viram exercício 2022 | São dois exercícios de 2022 mesmo, ou uma é duplicata? |

### A separação do backlog

O backlog `Adicional Ocupacional` tem **382 cartões, idade mediana de 3 anos e
3 meses**, e 92% deles não têm anexo, checklist, comentário nem descrição além
do número do processo. Não é fila de trabalho: é o cadastro histórico de quem já
teve adicional.

A regra que implementei: **qualquer rastro de trabalho mantém o cartão na fila** —
anexo, checklist, comentário, prazo em aberto, descrição com conteúdo ou
movimento nos últimos 365 dias. O que sobra vira cadastro histórico, no
repositório, fora do kanban e **fora dos indicadores**.

Rodada contra o quadro real: **28 pendentes, 354 histórico**. Os 28 incluem
justamente quem importa — Jaqueline e Gabriela (pareceres 1 e 2 de 2026), Ana
Mara (prazo vencido há 115 dias), Juliana. Dois deles (`1-Modelo` e
`ADICIONAL DE INSALUBRIDADE ANTIGO`) são recusados antes, pela regra de
`CARTAO_NAO_PROCESSO` — sobram 26 processos reais.

Se o corte de 365 dias não for o certo, é uma constante: `DIAS_PARA_HISTORICO`,
em `app/servicos/importacao_trello.py`.

---

## Divergências encontradas nos documentos de origem

Registradas aqui porque **não foram corrigidas por conta própria**.

1. **Aspas no parecer 1/2025.** O PDF assinado usa aspas **retas** (`"`) na
   citação do Anexo 14 da NR-15, enquanto o catálogo padroniza aspas **curvas**
   (`“ ”`), como manda a especificação. São dois caracteres. A fixture de ouro
   (`testes/fixtures/ouro_parecer_1_2025.txt`) foi gerada do PDF assinado com as
   aspas normalizadas para curvas — a conversão está isolada em
   `ferramentas/gerar_ouro_do_pdf.py::normalizar_aspas`. **Confirmar qual forma
   vale daqui para frente.**

2. **Rótulo do laudo no modelo v1.** O modelo imprime `Nº do Laudo Técnico:`
   seguido do número do **parecer** (`Nº 1/2025`), enquanto o laudo real é
   `26255-000.125/2019`, impresso mais abaixo. O defeito é **preservado** no
   `modelo_parecer_v1.docx` por fidelidade documental e corrigido no
   `modelo_parecer_v2.docx`. Ver pendência 6.

3. **Cabeçalho do modelo atual.** O `.docx` recebido traz na 4ª linha
   `Seção de Segurança do Trabalho`, enquanto o parecer 1/2025 assinado traz
   `Serviço Especializado em Segurança do Trabalho`. Conferindo os assinados de
   2026 (1, 2 e 8), todos usam `Seção de Segurança do Trabalho` — ou seja, não é
   erro do modelo: **o texto mudou entre 2025 e 2026, mantendo a mesma sigla.**
   A linha virou campo (`nome_extenso_emissor`) e o catálogo tem as duas
   vigências. **Confirmar.**

3b. **PARECER 7/2026 EXISTE ASSINADO MAS ESTÁ COMO RESERVA NA PLANILHA.**
   O arquivo `Parecer_Tecnico_08-2026_SEST-_Juliana.pdf` contém, no corpo, o
   parecer **nº 7/2026** (a numeração impressa é 7/2026 em todas as três
   posições: linha-título, tabela e rodapé). A planilha registra a linha 8 com
   apenas o número 7 e nenhum dado — classificada como `RESERVADO`. Ou seja:
   **um parecer foi emitido e assinado sem entrar na planilha.** O sistema
   expõe o conflito e não resolve sozinho; rode
   `python -m ferramentas.conferir_reimpressao` para ver. Decidir com a Juliana
   e a PROGEP qual número vale antes do corte.

4. **Marco inicial do 8/2026.** Usou "data da solicitação 01/05/2026" com
   portaria de 05/03/2024 — 26 meses de diferença, sem justificativa registrada.
   Daqui para frente a RN-05 exige justificativa quando o marco não é a portaria.

5. **Assinatura e destinatário eram texto fixo no `.docx`.** Foram convertidos em
   campos (`assinante_nome`, `assinante_matricula`, `assinante_titulo`,
   `tratamento_destinatario`, `pro_reitor_cargo`). Sem isso, um segundo
   profissional habilitado não conseguiria assinar e a tabela
   `autoridade_destinataria` não teria efeito no documento. **A saudação
   "Prezada Pró-Reitora," continua fixa** — confirmar se deve variar com o
   gênero da autoridade.

6. **Planilha de 2026 tem mais reservas do que o esperado.** A especificação
   citava as linhas 8, 10, 11 e 12 como `RESERVADO`; o arquivo real
   (`1 -2026-PAR-000-Modelo.xlsx`) traz reservas também nas linhas 13, 14 e 15
   (pareceres 12, 13 e 14 de 2026). O importador classifica por regra, não por
   número de linha, então todas entraram corretamente — mas vale conferir se
   esses números foram mesmo reservados.

7. **A cidade do parecer é a do setor emissor, não a do campus avaliado.**
   O parecer 2/2026 é da Faculdade de Medicina do Mucuri (Teófilo Otoni) e, no
   assinado, está datado em **Diamantina** — onde a CSSO funciona. O sistema
   passou a derivar a cidade de `setor_emissor.cidade`. Confirmar se algum
   parecer é datado fora de Diamantina.

8. **Rodapé do modelo tinha um `MERGEFIELD` órfão.** Entre o número e o ano do
   parecer havia `Data_da_Solicitação_no_SEST`, sem resultado. Virou o campo
   `data_solicitacao_sest_rodape`, sempre renderizado vazio, para que o rodapé
   saia exatamente `LT Nº 1/2025`. **Confirmar se pode ser removido do modelo.**

---

## RN-19 — o que ainda está em aberto

A supressão do nome foi unificada num helper único (1.15.1) e a busca deixou de
ser oráculo (1.19.1). Três pontos seguem de fora **de propósito**, porque a
decisão é de política de acesso, não de template. Precisam da sua palavra:

- **O parecer e a prévia mostram nome, matrícula e o agente nocivo** sob
  `parecer.ver`, que a secretaria tem. Suprimir quebraria o documento, e os
  testes-ouro o comparam byte a byte. A decisão aqui é se a secretaria deve ter
  `parecer.ver`, não o que o template imprime.
- **"Últimos eventos" no painel** imprime a descrição do evento sem filtro, e a
  auditoria grava frases como `"Servidor SIAPE 1110654 cadastrado."` e
  `nome: 'X' → 'Y'`. O helper não alcança texto já formatado.
- **O backup exporta nome e SIAPE** sob `backup.executar`, que só o `admin_ti`
  tem — e ele por projeto não vê conteúdo técnico. Suprimir corromperia o backup;
  a questão é se o perfil deve ter a permissão.

**A regra em si nunca foi escrita.** Não há RN-19 em `docs/` nem no `CHANGELOG`;
o que existe são rastros na descrição da permissão `exposicao.ver` e no
cabeçalho do gerador de identificador opaco. Vale escrevê-la de uma vez, agora
que há uma implementação única para descrever.

## Amigável não é SPA — a decisão de fundo do plano de adesão

Em 06/09/2026, comparando com um sistema comercial de SST (React + API), a
pergunta foi se o CSSO precisava virar SPA para ter adesão do setor e ser
replicável em outras universidades. A resposta registrada: **não agora, e não
por preferência**. O que faz alguém dizer "não é intuitivo" são quatro coisas
que a pessoa sente — resposta lenta, trabalho digitado que some, recusa que não
diz a saída e tela que não diz por onde começar —, e nenhuma delas depende de
framework. As auditorias de `entrada/ux/` e `entrada/marca/` mediram
exatamente essas quatro; a 1.40.0 fechou o que restava delas.

O plano tem três fases e só a primeira é certa:

1. **Interação no que existe** — feita na 1.40.0.
2. **API JSON e tela de celular num pedaço pequeno** (EPI e presença) — feita na
   1.41.0: `/api/v1` e `/celular`. O desenho rendeu para o trabalho em pé; o
   custo é a tela desenhada em JavaScript, que cada tela nova pagaria de novo.
3. **Front separado como produto** — feito na 1.42.0 como `frontend/` (React +
   Vite), servido em `/app`, com cinco telas em cima da API. Nada foi apagado:
   o sistema completo, a tela de bolso e o app coexistem. **A decisão que fica
   é qual dos três leva a replicação** — e ela é sua, com a medição abaixo.

**Por que não há framework de front-end, e não vai haver por gosto:** a CSP é
`script-src 'self' 'nonce-…'`, sem `'unsafe-eval'`. Todo framework que avalia
expressão escrita em atributo (Alpine, Vue, o JSX em runtime) precisa do
`'unsafe-eval'` para existir. Abrir isso para ganhar uma sintaxe é trocar a
proteção contra exfiltração por comodidade de escrita. O argumento está no
cabeçalho de `app/estaticos/js/csso.js`, e a fase 3, se vier, é um front
COMPILADO (React/Vite) servido de outro lugar — que a CSP de lá decide.

**O que se mede antes de qualquer reescrita:** tempo e cliques das seis tarefas
reais de `entrada/ux/02_NAVEGACAO.md` §6, com três pessoas do setor, antes e
depois. Se cair pela metade, o problema era interação.

## Correções de rota ainda abertas

Nenhuma. As três dos lotes de redesign fecharam na 1.19; `/pareceres/{id}/docx`,
`/pdf` e `/previa` com id inexistente são 404 desde a 1.3x (`_exigir_parecer`);
`/login` devolve o identificador digitado desde a 1.36.

## Dívidas técnicas abertas nos módulos novos

- **Duas categorias de anexo têm prazo condicional na política de retenção**
  (`EVIDENCIA_ACIDENTE` e `LISTA_PRESENCA`): "permanente se citada no relatório",
  "permanente quando houve certificado emitido". Isso é propriedade da linha, e
  categoria é o que decide o descarte. Hoje não apaga nada porque não existe
  rotina de eliminação; a fatia que criar essa rotina precisa resolver antes de
  rodá-la pela primeira vez. Na mesma conferência apareceu que `DESPACHO` não
  está em nenhuma das duas linhas de prazo — defeito anterior.
- **Publicar a v2 de um modelo de certificado não move `treinamento.modelo_vigente_id`**
  para a versão nova. A tela avisa com o rótulo `(superada)`, mas na emissão isso
  decide com qual layout o certificado sai. Repontar automaticamente tem
  implicação de auditoria — é decisão de desenho, não conserto de defeito.
- **`pendencias.abertas()` não filtra por escopo.** O plano consolidado registra
  que isso precisa ser escolha, não descoberta.
- **O vínculo entre a linha da ficha de EPI e o item da requisição não entrou na
  cadeia de hash.** A coluna `requisicao_item_id` existe, tem chave estrangeira e
  está protegida pela trigger append-only, mas **não** foi acrescentada a
  `epi_ficha.forma_canonica` — fazê-lo faria `conferir()` acusar divergência em
  toda linha de ficha já gravada. É lacuna consciente, não esquecimento. O
  conserto sem falso positivo é versionar a forma canônica (linha com `versao`
  antiga confere pelo conjunto antigo de campos), e vale fazer antes de a ficha
  ser usada como prova em algum lugar que dependa do vínculo.
- **A fila de `/epis/requisicoes` não aplica `aplicar_escopo`.**
  `epi_requisicao.campus_id` é nulo enquanto o pedido é rascunho, então filtrar
  por unidade esconderia do autor o próprio rascunho. Hoje o portão é `epi.ver` e
  a RN-19 mascara a identificação. Se o escopo por campus for para valer aqui, a
  saída provável é escopar pelo campus **do servidor** enquanto não há snapshot.
- **Pendência de EPI dependia de escrita para nascer — fechado na 1.42.0** para
  `CA_A_VENCER` e `TROCA_EPI_DEVIDA`: `ferramentas/varrer_pendencias.py` é a
  varredura noturna, a agendar na máquina que vale (o `schtasks` está no
  cabeçalho). `EPI_SEM_ESTOQUE` continua nascendo da escrita (entrada de lote,
  transição de item), e ali está certo: é a chegada do estoque que muda a
  resposta, não o relógio.
- **A supressão em margem tem um resíduo declarado.** Duas tabelas do mesmo
  relatório particionam a mesma população, então a soma de uma é margem da outra.
  Com a supressão secundária valendo, o que se recupera daí é a **soma de duas**
  células suprimidas, nunca uma — o que não nomeia ninguém. A exceção é a
  distribuição de célula única, em que não há o que suprimir sem apagar a tabela.
  E a terceira regra é conservadora: num recorte com só dois campi e um pequeno,
  ela suprime a tabela inteira. Com os quatro campi reais isso não acontece.
- **`assinatura.gerenciar` deveria chamar-se `instrutor.gerenciar`** pela
  convenção de prefixo por módulo, mas já foi semeada: renomear agora custa
  apagar linhas de `permissao` e `perfil_permissao`. `vencimento.ver` ainda não
  existe e continua barato.

## Achados da auditoria de ergonomia que precisam da sua decisão

A auditoria de front-end de 20/08/2026 (relatórios em `entrada/ux/`) corrigiu o
que era defeito. Das três que dependiam de você, **duas foram feitas na 1.29.0**
— a busca global que atravessa o sistema e a porta do `/config` para quem opera o
backup. Resta uma:

- **O painel conta exposições por risco e `/relatorios` conta pareceres** — dois
  recortes quase iguais com nomes quase iguais, na mesma casa. Escolher qual dos
  dois vale é decisão de indicador, não conserto de defeito: alguém precisa dizer
  se a pergunta é "quantas exposições existem" ou "quantos pareceres tratam
  daquele risco". Enquanto não se decide, quem lê os dois números lado a lado
  acha que um deles está errado.

## Abrir o sistema para servidores comuns — o que falta depois da 1.35.0

As auditorias estão em `entrada/servidor/`. Os três itens que **bloqueavam** —
registro de acesso, escopo e os furos da RN-19 — foram feitos na 1.35.0. O que
resta, na ordem em que rende:

**Ainda protege menos do que devia:**
- **A demanda continua gravando o nome de quem demandou** (`demandas.py`), e é o
  único ponto de prosa que a 1.39.0 deixou aberto de propósito: **não há id para
  onde cair** — o solicitante é coluna de texto livre, e o vínculo com servidor é
  opcional e quase sempre nulo, porque quem demanda muitas vezes não está no
  cadastro (chefia de outra unidade, PROGEP, alguém de fora). A supressão na
  leitura cobre. Fechar exige decidir um identificador para a demanda na frase — é
  decisão de desenho, não conserto.
- **Custo aceito, com conserto conhecido:** `Pendencia` não tem vínculo com
  servidor, então a descrição sai suprimida **inclusive para o próprio titular**.
  Quando `pendencias.abrir` ganhar o vínculo, basta passar quem é o titular.

**Para a jornada dele terminar** (itens 4 a 6 do plano, ainda não feitos):
- **A porta para o que é dele**: `certificado.ver` para o titular (o escopo já
  está pronto — `Certificado.servidor_id` existe exatamente para isso, e
  `aplicar_escopo` já é chamado; só a permissão nunca foi concedida), link para a
  própria ficha de EPI (a regra "ou próprio" existe e não tem porta no menu), e a
  **rota `/validar/{chave}` que é impressa em todo certificado e não existe** —
  404 num documento que já circulou.
- **A auto-inscrição em treinamento.** Hoje `/turmas` responde 200 e vem
  **sempre vazia** para ele: o escopo procura `servidor_id` em `Turma`, não acha,
  e devolve nada — e o docstring de `turmas.py:182-187` afirma que `campus_id`
  previne isso, o que é falso (`campus_id` é do escopo de unidade). A saída
  proposta é uma permissão que nasce "inscrita" e a CSSO confirma: resolve sem
  SMTP e sem exposição de rede, mais barato que a fatia de inscrição pública.
- **Avisar o requerente da decisão.** Ele protocola em 5 ações e depois o sino
  marca zero — ao enviar, ao aprovar, ao recusar. Ninguém o avisa, e a tela nunca
  diz onde retirar.

**Antes de conceder as permissões que faltam**, a auditoria de privacidade pediu
duas coisas: a lista de chamada da turma não tem guarda de RN-19 (está em
dispensa), e a busca de participante vira oráculo nome↔SIAPE sobre o cadastro
inteiro.

## Agora existem duas cópias da pasta, e só uma pode valer

Em 05/09/2026 a pasta inteira foi copiada para outro computador, para continuar
o desenvolvimento. `dados/csso.db` é um arquivo: **existem duas cópias dele**, e
trabalhar nas duas as faz divergir sem volta.

- a numeração de parecer é sequencial por RN-03 (nunca `MAX+1`): as duas máquinas
  emitiriam o **mesmo número** para pareceres diferentes;
- a trilha de auditoria é encadeada por SHA-256: duas cadeias que partem do mesmo
  ponto não se fundem — uma teria de ser descartada inteira;
- anexos e documentos gerados ficam no disco de quem os gerou.

**Decida qual máquina vale**, e anote no cabeçalho de `MUDAR-DE-PC.md`. Na outra,
use o `RECRIAR-TESTE.bat` (banco separado, gente inventada, porta 8766) e não
trabalhe com dado real. O passo a passo da mudança, com as quatro coisas que não
atravessam a cópia, está em `MUDAR-DE-PC.md`.

Duas tarefas que **não** viajam na pasta e precisam ser refeitas na máquina que
passar a valer: as tarefas agendadas do Windows do backup diário e da conferência
da cadeia às 3h30 (o comando está no cabeçalho de
`ferramentas/conferir_cadeia.py`).

## O banco vivo está vazio, e o trabalho do setor está num backup de 12/08

Conferido em 24/08/2026, com o sistema já na rede do setor. `dados/csso.db` tem
**1 usuário, 1 servidor, 4 eventos** e os catálogos semeados (15 unidades UORG, 4
campi, 3 cargos, 7 postos). **Zero** processos, pareceres, laudos, adicionais,
exposições, anexos, turmas, certificados e tudo de EPI.

O backup preservado `dados/backups_preservados/csso-20260812-115750.db.enc` tem
**640 processos, 14 pareceres, 5 laudos, 4 servidores, 4 exposições, 78 anexos e
7.634 eventos** — o resultado da importação do Trello. O esquema dele é
`9305283613f3`; o de hoje é `f3a6b21d9c85`, **quinze migrações à frente**.

**O caminho de volta foi ensaiado e funciona.** Num banco descartável, decifrado
em memória e sem tocar em `dados/`: as quinze migrações rodaram com código de
saída 0 e **nenhuma linha se perdeu** — os 640 processos, os 14 pareceres, os 78
anexos e os 7.634 eventos chegaram inteiros ao esquema de hoje, com
`integrity_check ok` e `foreign_key_check` vazio.

**Duas coisas ficam para quem decidir, porque restaurar sobrescreve:**

1. **As contas voltam às de 12/08.** O banco vivo tem uma conta; o backup tem
   outra. Toda conta criada depois de 12 de agosto se perde, e quem restaurar
   precisa conferir que ainda consegue entrar **antes** de a equipe tentar.
2. **Os arquivos dos anexos não estão dentro do backup.** Ele é do formato antigo
   (banco cru), anterior à correção da 1.31.0 que passou a empacotar
   `dados/anexos` junto. As 78 linhas de anexo apontariam para arquivos que
   precisam ser postos em `dados/anexos/` — os 171 arquivos (258 MB) estão em
   `entrada/anexos_trello/`, e a conciliação entre linha e arquivo precisa ser
   conferida pelo `sha256`, não pelo nome.

**Se o banco vazio for intencional** — e pode ser, se a importação de 12/08 foi um
ensaio e a carga de verdade ainda vai acontecer —, nada disto é problema, e o que
vale é a segunda metade: a importação sabe ser refeita a partir de
`entrada/anexos_trello/` e da planilha, com o código de hoje, que tem dezenas de
correções que o de 12 de agosto não tinha.

## Tirar o sistema do `localhost` — o que falta, e o que é decisão sua

A auditoria completa está em `entrada/implantacao/00_PRONTIDAO.md`. Os defeitos
que valiam **já na máquina do setor** foram corrigidos na 1.31.0. O que resta:

**Decisões suas, que mudam o resto:**
- **Para onde.** Rede do setor, servidor institucional da UFVJM com acesso pela
  rede ou VPN, ou internet aberta. A auditoria diz: os dois primeiros são viáveis;
  o terceiro **não é recomendado** sem 2FA, WAF, teste de invasão e troca do banco
  — e o `ROPA.md` §6 já registrou que expor muda o perfil de risco do sistema
  inteiro. Se um dia houver validação pública de certificado, o caminho é publicar
  **um serviço separado**, não abrir este.
- **Quantas pessoas ao mesmo tempo.** Medido: o SQLite atual **aguenta a equipe**
  (8 escritas simultâneas, pior caso 717 ms, zero erros; 6 logins juntos em 2,1 s).
  Para dezenas de pessoas, muda o dimensionamento e provavelmente o banco.
- **Quatro cópias do banco em claro** em `dados/`, feitas antes de migrações. Foram
  classificadas **pelo conteúdo**: as quatro têm exatamente o mesmo conteúdo do
  banco vivo — uma conta, um servidor, quatro eventos, e nenhum processo, parecer
  ou comprovante. O único item com peso é o hash Argon2id da conta, que é material
  de força bruta fora de linha. A proposta é eliminar as quatro com ata (§5 da
  política); **nada foi apagado** — a remoção é sua.

**Obrigação legal antes de o sistema sair da máquina:**
- **Encarregado (DPO) indicado** — art. 41. Está em branco no `ROPA.md`, e **trava
  os outros itens**: sem encarregado não há a quem comunicar incidente.
- ROPA emendado com o novo local de armazenamento (art. 37) e política de retenção
  revista — ela própria exige isso a cada mudança de local.
- Contrato de operador, se houver terceiro (arts. 39, 46, 33-36).
- Plano de resposta a incidente escrito (art. 48). Hoje existe uma frase.

**Lacunas técnicas: fechadas** (situação em 22/09/2026, 1.43.0). A lista que
estava aqui foi escrita antes da 1.32.0 e ficou para trás:
- PDF fora da transação, cabeçalhos de segurança e CSP, `Secure` do cookie pelo
  esquema da requisição, registro de acesso HTTP e `exportar-tudo` como POST:
  **1.32.0**;
- `/auditoria` conferindo só a janela exibida, com o passe completo fora da
  requisição: **resolvido** (`auditoria.janela_integra`);
- **HTTPS** (AC do setor restrita por nome), **edição simultânea do parecer**
  (trava de versão, com o que não foi gravado devolvido à pessoa) e **retenção
  de `sessao`** cumprida pelo mecanismo: **1.43.0**.

**O que o HTTPS ainda pede de você**, porque é implantação e não código (passo a
passo em `docs/HTTPS_NA_REDE.md`):
- gerar o certificado na máquina do setor e instalar a raiz em cada estação (ou
  pedir ao TI que distribua por GPO);
- emendar o ROPA §6, item 2 ("a conexão não é criptografada"), com a data em que
  o HTTPS entrou.

## O que a passada de rebranding deixou encaminhado

- **Paginação larga — o único dos dez achados de `entrada/marca/01_MELHORIAS.md`
  que não foi feito.** Só 2 de ~50 telas paginam, e a escala que vem é conhecida:
  **745 cartões de Trello e 975 linhas de planilha** esperando importação. A parte
  perigosa já caiu (o `<select>` com o cadastro inteiro no balcão virou busca por
  HTMX), então o que resta é largura, não risco: dizer "página 3 de 15" em vez do
  mínimo, e estender o limite às listas que hoje trazem tudo. **Não mexer na
  paginação cega da auditoria** — o argumento está no relatório.
- **Modo escuro: recomendado, não feito.** Os 66 pares de contraste virariam 132,
  a lateral escura deixa de contrastar com a área útil e precisa de outro
  dispositivo, e a prévia do parecer não pode inverter (ela imita o `.docx`). O
  caminho está aberto: nenhuma cor de interface fora do `:root`, salvo três
  literais deliberadas e comentadas.
- **O brasão oficial da UFVJM tem lugar reservado e não tem arquivo.** A regra
  `.marca-brasao` existe, dimensionada em 30px, e a linha está comentada em
  `base.html`. Precisa da versão oficial, vinda de quem pode autorizá-la — em SVG
  ou PNG de 2×, porque a 30px um bitmap de 30px sai serrilhado no papel.

## Decisões técnicas que valem confirmação

- **Comparação do CA-01 é por fluxo de texto**, não linha a linha: o PDF quebra
  linhas onde o texto envolve na página, o `.docx` tem parágrafos lógicos.
  Comparar linha a linha compararia diagramação. A estrutura que importa (a
  célula de posto ter exatamente duas linhas, na ordem certa) tem asserção
  própria.
- **NUP sintético na migração do Trello.** Cartão de repositório sem NUP precisa
  de chave única: o sistema gera um NUP com ano `1900` e DV válido, e o cartão
  aparece no relatório de órfãos para receber o número real. Nenhum desses
  cartões é tratado como processo instruído.
- **LibreOffice instalado na 1.42.2** (26.2.6) nesta máquina de desenvolvimento,
  e a instalação revelou que a conversão **nunca teria funcionado** no caminho
  padrão do sistema: o espaço de `C:\Projetos\Sistema CSSO` entrava cru numa
  URL `file:///` e o LibreOffice saía com código 0, sem PDF e sem erro. Está
  corrigido. Na máquina de produção o programa continua ausente; instalar lá
  agora liga o PDF automático de verdade.
- **Servidores e Catálogos ficaram fora do módulo Processos SEI**, como base
  compartilhada, porque EPI, treinamento, CISSP e PGR vão precisar dos mesmos
  servidores e dos mesmos postos. Se você preferir ver tudo dentro do módulo, é
  uma linha em `app/modulos.py` — mas aí o próximo módulo vai duplicar cadastro.
- **Adicionais ficou dentro de Processos SEI.** É o direito que nasce do parecer,
  então segue o fluxo. Se um dia a concessão passar a vir de outra origem que não
  o processo SEI, ela vira base junto com Servidores.
