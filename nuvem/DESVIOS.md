# Desvios do comportamento Python

Onde a nuvem obrigou o porte a fazer diferente do sistema Python. Cada item
repete, em uma linha, o comentário que está no código.

## Núcleo (autenticação, RBAC, módulos, saúde, sementes)

- **`/saude/db` sem `PRAGMA integrity_check`** (`src/rotas/saude.ts`). O
  Postgres do Supabase não tem conferência de integridade barata; a
  integridade física é do provedor. A rota confere que o banco responde e que
  as travas de `travas.sql` estão instaladas (`integrity_check: "ok"` quando há
  trigger). Deixa de existir o `s.commit()` antes da conferência: não há lock
  de escrita a soltar.
- **Primeiro acesso "só na própria máquina"** (`src/rotas/autenticacao.ts`).
  Na nuvem não há 127.0.0.1: requisição com `x-nf-client-connection-ip`
  (Netlify) é tratada como remota e recebe a tela "Indisponível". Local
  (`npm run dev`) e testes continuam liberados. Para criar o primeiro
  superintendente na nuvem: `CSSO_PRIMEIRO_ACESSO_REMOTO=sim` só durante a
  implantação, ou povoar pela linha de comando.
- **`aplicar_escopo` devolve a condição, não a consulta** (`src/servicos/rbac.ts`).
  O Drizzle não estende uma `select` já montada; a função devolve
  `SQL | undefined` (`undefined` = sem filtro, `sql\`false\`` = nada) e quem
  consulta faz `where(and(escopo, ...))`.
- **`PermissaoNegada` é uma só** (`src/nucleo/erros.ts`, reexportada por
  `rbac.ts`). A mensagem padrão passou a "Permissão necessária: x" (a do
  núcleo); a do Python era "Permissao negada: x".
- **"Hoje" das vigências é o dia em America/Sao_Paulo** (`hoje_iso`), e não o
  `date.today()` do processo, que na função do Netlify está em UTC.
- **`semear()` não dá commit** (`src/servicos/sementes.ts`): serviço recebe o
  executor e não fecha transação (PORTE.md §2). Quem chama fecha:
  `ferramentas/semear.ts` e o `globalSetup` dos testes.
- **`buscar_por_login`**: o recuo sem caixa é feito no banco (`lower(...) =`)
  em vez de varrer a tabela em Python. Mesmo resultado; se e-mail de uma conta
  for igual ao login de outra, vence o casamento pelo e-mail (no Python,
  `scalar_one_or_none` levantaria).
- **Erros de política** viram classes (`SenhaRecusada`, `PrimeiroAcessoRecusado`)
  no lugar de `ValueError`/`PermissionError`. A mensagem é a mesma.
- **`log_retencao_dias`** (prazo do expurgo de sessão) é lido de
  `CSSO_LOG_RETENCAO_DIAS` (padrão 90) dentro de `autenticacao.ts`, porque
  `src/config.ts` não tem o campo.
- **Globais de template registrados pelo dono**: `porta_de_entrada` em
  `src/modulos.ts` e `POLITICA_SENHA` em `src/servicos/autenticacao.ts`, e não
  em `web.ts` — importá-los em `web.ts` fecharia ciclo de importação. Novo
  global `dias_entre(inicio, fim)` substitui `(fim - inicio).days` nos
  templates (datas são texto `AAAA-MM-DD`).
- **Ambiente de teste** (`ferramentas/ambiente-teste.ts`): não há pasta
  `dados-teste/` nem `.env` descartável; o ambiente é o banco do `.env`,
  recriado (DROP SCHEMA) — e por isso recusa banco fora de localhost sem
  `--permitir-remoto`. As oito contas compartilham um hash (mesma senha). Só a
  base é povoada por enquanto (ver o TODO no cabeçalho do arquivo).
- **Tela de erro lê o usuário num SAVEPOINT da transação da requisição**
  (`src/app.ts`), em vez de abrir outra transação: com `CSSO_POOL_MAX=1` a
  segunda transação esperava para sempre a conexão da primeira.

## Núcleo B (datas, textos, auditoria, identificação, numeração, anexos, documento, PDF)

- **A cadeia de `historico_evento` é serializada por `pg_advisory_xact_lock`**
  (`src/servicos/auditoria.ts`). No SQLite o escritor era um só (`BEGIN
  IMMEDIATE`); no Postgres duas requisições leriam o mesmo "anterior" e a
  cadeia bifurcaria. A trava sai no COMMIT: quem grava na trilha espera quem
  gravou antes terminar a requisição. O digest é calculado sobre a
  serialização canônica em código (`corpo`, o `json.dumps(sort_keys,
  ensure_ascii=False, default=str)` do Python — mesmo SHA-256 para o mesmo
  evento, conferido por teste), nunca sobre o texto que o jsonb devolve.
- **`JSONTexto` deixou de usar o `jsonb()` do Drizzle** (`src/db/esquema/base.ts`).
  Com o postgres.js o Drizzle reparseava toda string: `'50.00'` voltava `50`,
  `'1110654'` voltava inteiro, `'true'` voltava booleano — o defeito que o
  Python corrigiu no seu `JSONTexto` e que acusaria adulteração falsa na
  trilha. Agora é um `customType` que grava com `JSON.stringify` e lê sem
  reparsear. O DDL (jsonb) não muda. Afeta TODA coluna `JSONTexto`, para melhor.
- **A trava de valor não auditável recusa também `NaN`, `Infinity` e `\u0000`**:
  o jsonb não os guarda (no Python, o TEXT guardava `NaN`).
- **`conferir_fora_da_transacao` não comita nem abre conexão AUTOCOMMIT**. No
  Postgres leitura não bloqueia escrita (MVCC), então o passe completo roda na
  transação da requisição, em lotes de 1000 por id. "Uma conferência por vez"
  era `threading.Lock` do processo; virou `pg_try_advisory_xact_lock`, que vale
  entre instâncias da função. O teto do passe passa a ser os 60 s da função.
- **Numeração sem laço de tentativas** (`src/servicos/numeracao.ts`): o
  `UPDATE ... RETURNING` na linha do ano trava a linha e a segunda transação
  espera a primeira; não há SQLITE_BUSY a repetir (e transação abortada não se
  repete por dentro no Postgres). `recontar_sequencia` usa `GREATEST` no lugar
  do `MAX(a, b)` escalar do SQLite.
- **Arquivos no Supabase Storage** (`src/servicos/armazenamento.ts`): bucket
  privado (`CSSO_BUCKET`, criado na primeira gravação), chave de serviço. Sem
  `SUPABASE_URL`, pasta local (`.dados/` ou `CSSO_DIR_ARQUIVOS`). O
  `storage_key` do anexo é o mesmo do Python (`ab/abcdef...`), sob o prefixo
  `anexos/` no armazenamento. `caminho_do_blob`/`caminho_absoluto`/`copiar_para`
  viraram `chave_do_blob`/`ler_conteudo`/`ler_blob`.
- **Limite de 4 MB por anexo** (`anexos.LIMITE_BYTES`). O Python não tinha
  limite; a função do Netlify recebe no máximo 6 MB de corpo (≈4,5 MB de
  binário). Acima de 4 MB a recusa é `AnexoGrandeDemais`, com a saída escrita
  ("reduza o PDF ou divida-o").
- **`anexo_acesso`: a regra do dono entra por `PORTAS`**. Os quatro
  resolvedores e a lista fechada continuam no arquivo; a consulta de escopo de
  cada dono (processo, parecer, ficha de EPI, certificado) é declarada pelo
  módulo dono com `declarar_porta(...)` ao ser portado. Porta não declarada
  nega (`DonoNaoDeclarado`), o mesmo lado seguro do Python.
- **`identificacao.COOKIE_SESSAO` é uma cópia** de `autenticacao.COOKIE_SESSAO`
  (um teste confere): importar `autenticacao` fecharia o ciclo
  web → identificacao → autenticacao → web.
- **`identificar(...)` não carrega relação**: sem o `servidor` carregado pela
  rota (`with: { servidor: true }`), o resultado é o código opaco mesmo para
  quem pode ver o nome (no Python o SQLAlchemy carregava sob demanda). Erra
  para o lado seguro; a rota tem de carregar o que o template lê.
- **Documento: docxtemplater no lugar do docxtpl.** Os `.docx` de
  `app/templates/` são convertidos por `ferramentas/converter-modelos-docx.ts`
  para `modelos-docx/` (rode de novo quando um modelo mudar; um teste acusa
  cópia velha). `modelo_sha256` continua sendo o SHA-256 do modelo de ORIGEM
  (via `modelos-docx/manifesto.json`). O texto extraído — e portanto o
  `hash_conteudo` — sai idêntico ao do Python (conferido no parecer 1/2025 e
  nos outros quatro modelos contra o docxtpl real). `renderizar_modelo`
  devolve bytes e grava no armazenamento quando recebe `destino` (chave).
- **Imagem em linha feita à mão** (`docx_baixo_nivel.embutir_imagens`): o
  módulo de imagem do docxtemplater é pago. Mesmo tamanho do `InlineImage`
  (largura em mm, altura na proporção). `ImagemEmLinha` recebe a chave no
  armazenamento (ou os bytes) no lugar do `Path`.
- **`&` e `<` nos valores saem certos**: o docxtpl sem autoescape os perdia
  ("Segurança & Saúde" virava "Segurança  Saúde"). E `None` num marcador sai
  vazio (o Jinja escrevia "None"); nenhum modelo do sistema dependia disso.
- **PDF: `pdf.disponivel()` é sempre falso** (`src/servicos/pdf.ts`). Não há
  LibreOffice na função do Netlify. `converter`/`converter_fora_da_transacao`
  devolvem o que o Python devolvia numa máquina sem LibreOffice
  (`gerado=false`, `AVISO_SEM_PDF`, `indisponivel=true`) — sai o .docx com o
  aviso, e a trilha não ganha `PDF_NAO_GERADO`.

## Treinamentos e Certificados (turma, participante, presença, certificado, emissão, lista de presença, validação)

- **Decimal vira texto + conta inteira** (`src/servicos/presenca.ts`: `escalado`,
  `comparar`, `numero`, `para_decimal`). Horas, carga, nota e frequência andam
  como o texto que o driver devolve para `numeric`; as contas são em
  milionésimos (`BigInt`), a frequência é arredondada meio-para-cima em
  centésimos, e `numero()` imita o `f"{Decimal:.2f}"`. O que vai para a trilha é
  o mesmo `str(Decimal)` do Python ('75.00', '8.5').
- **O `rollback` da recusa virou SAVEPOINT** (`src/rotas/turmas.ts`,
  `certificados.ts`): a ação que pode ser recusada roda em `tx.transaction(...)`
  aninhada; a recusa desfaz só ela, e a tela seguinte lê o banco de antes.
- **Emissão em lote: um SAVEPOINT por certificado** (`emissao_certificado.emitir_lote`),
  no lugar do `s.commit()` por item. O item que trava desfaz só o que escreveu
  (número inclusive) e os outros ficam — mas nada do lote é gravado se a
  requisição inteira cair depois (o Python já teria comitado os primeiros).
- **A última vaga: `SELECT ... FOR UPDATE` na linha da turma** (`turma._conferir_vaga`),
  no lugar do `BEGIN IMMEDIATE` do SQLite. Duas inscrições simultâneas na
  última vaga passam a esperar uma a outra.
- **Sem PDF do certificado**: `pdf.disponivel()` é falso na nuvem, então a
  emissão sai só com o `.docx` e o `AVISO_SEM_PDF`, sem anexo `CERTIFICADO` e sem
  `PDF_NAO_GERADO` na trilha (o ramo "sem LibreOffice" do Python).
- **Documentos no armazenamento, não em disco**: o certificado vai para
  `documentos/certificados/{ano}/Certificado_....docx` e a lista de presença para
  `documentos/listas_presenca/{ano}/Lista_Presenca_TUR-....docx`
  (`armazenamento.ts`); a rubrica é lida pela chave do blob do anexo.
- **Marcadores e SHA-256 do modelo de certificado vêm de `modelos-docx/manifesto.json`**
  (`certificado.marcadores_do_arquivo`, `sha256_do_modelo`): o docxtpl não
  existe aqui. O SHA é o do `.docx` de ORIGEM, como no Python. Modelo novo tem
  de passar por `ferramentas/converter-modelos-docx.ts` (e entrar na lista
  `MODELOS` de lá); sem isso a tela do modelo o mostra como "arquivo ausente" e
  a emissão bloqueia.
- **URL impressa no QR** (`emissao_certificado.url_base_validacao`): continua
  vindo do parâmetro `certificado.url_publica`. Sem ele, o Python caía em
  `http(s)://{host}:{porta}` do `.env`; na nuvem cai em `CSSO_URL_PUBLICA`,
  depois na `URL` que o Netlify define, e só então em `http://127.0.0.1:8765`.
  **Defina o parâmetro antes de emitir certificado de verdade**: a URL fica
  congelada no papel.
- **Limite por IP da validação pública em memória da instância**
  (`validacao_certificado.dentro_do_limite`): no Python o processo era único;
  no Netlify cada instância da função tem o seu contador, e instâncias
  paralelas/recicladas afrouxam o limite. O IP vem de `x-nf-client-connection-ip`.
  Para apertar, use o rate limiting da borda do Netlify em `/validar/*`.
- **Propriedades do ORM viram getters** (`src/rotas/treinamento_vistas.ts`):
  `t.topicos`, `m.rotulo`, `a.nome_exibicao`, `a.vigente_em(d)`,
  `i.participante.nome_exibicao`... são definidas sobre o registro do Drizzle
  antes de ir ao template. `LinhaDaGrade.frequencia_baixa` substitui a
  comparação `linha.frequencia < turma.frequencia_minima_percentual` do
  template (entre textos ela diria que 100 < 75).
- **Templates**: tuplas `in ('A', 'B')` viraram listas `in ['A', 'B']` — no
  Nunjucks o parêntese com vírgula devolve só o último valor e o teste dava
  sempre falso; `for x in y if cond` virou `for` + `if` (o Nunjucks ignora o
  `if` e não itera nada); `rejectattr(..., 'in', ...)` e `map(attribute=0)`
  viraram laços; `.get(k, d)` virou `(x[k] or d)`; `x is true` virou
  `x === true` (o Nunjucks não tem o teste `true`).
- **`salvar_com_diff` duplicado** em `src/rotas/treinamento_vistas.ts` (TODO:
  trocar pelo de `web.ts` quando existir).

## Gestão de EPI (ficha, comprovante, estoque, catálogo, requisição, indicadores)

- **Filtro `cnpj` registrado de dentro de `src/servicos/epi_estoque.ts`**, e
  não em `web.ts`: importar o serviço em `web.ts` fecharia o ciclo
  web → epi_estoque → pendencias → web (`pendencias.ts` usa `ganchos` de
  `web.ts` no carregamento). Vale porque as rotas carregam o serviço.
- **Teste `null` registrado em `web.ts`**: o parser do Nunjucks lê `x is none`
  como o teste embutido `null` (=== null), e o `none` registrado nunca era
  chamado — atributo ausente (undefined, o `None` de `dict.get` no Python)
  passava por `is not none`. Agora `null` também casa undefined.
- **A recusa que já escreveu é um SAVEPOINT** (`src/rotas/epi_fichas.ts`): o
  serviço roda em `tx.transaction(...)`; a recusa desfaz só o que ele gravou e a
  tela de volta ainda lê o banco — o `s.rollback()` do Python.
- **`epi_ficha.imprimir` devolve `{destino, aviso, bytes, nome}`** no lugar de
  `(Path, aviso)`. O .docx vai para o armazenamento em
  `documentos/epi/{ano}/Comprovante_EPI_000123.docx` (`comprovante_epi.caminho_saida`
  devolve a chave). PDF não há; o comprovante já era .docx.
- **`epi_ficha.conferir` compara pela serialização canônica** (`auditoria.corpo`)
  e não pela igualdade de dicionário: o jsonb reordena chaves.
- **`epi_ficha._posto_e_unidade`/`montar_contexto_para_entregar` leem categoria,
  cargo e unidade do banco** (no Python vinham por relação sob demanda).
- **Rotas com `:id{[0-9]+}`**: id que não é número dá 404, não 422. Campo
  obrigatório ausente em formulário do catálogo é recusado com a mensagem
  escrita, e não com o 422 do `Form(...)`. O `File(...)`/`Form(...)` obrigatórios
  da ficha (comprovante, estorno) continuam respondendo 422.
- **`salvar_com_diff` duplicado** em `src/rotas/epis.ts` (TODO: trocar pelo de
  `web.ts` quando existir).
- **Decimal vira texto**: `epi_estoque.valor_decimal` devolve string (o
  `str(Decimal)`); aceita só dígitos com uma vírgula ou ponto (o `Decimal`
  aceitava `1e3`, `NaN`, `Infinity`). `valor_em_estoque` e o custo por empenho
  (`epi_indicadores`) somam em inteiro na escala 10⁻⁴, sem float; `custo_texto`
  dá o `:.2f` arredondando metade para o par, como o Decimal.
- **`atualizar_lote` faz UPDATE e também atualiza o objeto recebido** (o
  `setattr` do Python).
- **Supressão RN-19 dos relatórios duplicada em `src/rotas/epi_indicadores.ts`**
  (`suprimir`, `suprimir_aninhado`, constantes; TODO: importar de
  `src/rotas/relatorios.ts` quando o Processos o portar).
- **`EVENTOS_DE_RECUSA` com literais** em `epi_indicadores.ts`: ler constante
  alheia no carregamento, num ciclo de import ESM, não tem garantia.
- **CSV da exportação escrito à mão** (`;`, aspas mínimas, `\r\n`, BOM).
- **Testes**: banco limpo por teste (`beforeEach` → `bancoLimpo()`), como o
  fixture `banco` do pytest. Em `epi_adicional.test.ts` o ouvinte de mapper do
  SQLAlchemy virou um gatilho de banco que conta toda escrita em
  `adicional_vigencia`, e a prova estática por AST virou busca por regex do
  verbo do Drizzle/SQL sobre a tabela; as partes do parecer
  (`registrar_avaliacao_de_epi`, congelado `epi` na emissão, telas do editor)
  ficam com o porte de Processos.
- **Horas presentes sempre com uma casa** (`dominio/treinamento.Inscricao.horas_presentes`):
  a linha da grade mostra "8.0h" onde o Python, com o `Decimal('8')` ainda em
  memória, mostrava "8h". O valor é o mesmo.

## Base compartilhada e Demandas (servidores, pendências, demandas, catálogos, usuários, config, auditoria, backup)

- **Backup sem arquivo de banco** (`src/servicos/backup.ts`). No lugar do
  `VACUUM INTO` do SQLite, um dump lógico: uma entrada `banco/<tabela>.json`
  por tabela de `public`, gerada pelo Postgres (`json_agg(t)::text`) na
  transação da requisição (retrato consistente por MVCC) e nunca reparseada
  (numeric, jsonb da trilha e timestamptz voltam como foram). O envelope é o
  MESMO do Python (`CSSOBK01` + sal + nonce + AES-256-GCM, PBKDF2-SHA256 390 mil,
  mágico como AAD): um lê o do outro. `restaurar` abre também os backups do
  Python (`.db` cru e zip com `csso.db`) — mas SQLite não volta ao Postgres
  por aqui.
- **Restauração em banco vazio** (`restaurar_no_banco`,
  `ferramentas/restaurar-backup.ts`): `json_populate_recordset` com
  `session_replication_role = replica` (travas de append-only e FKs não
  disparam durante a carga; a trilha volta como era) e sequências postas no
  máximo. Exige banco migrado e sem dados. O CA-13 virou "backup → banco novo
  → restaurar → a cadeia confere e o comprovante volta com o mesmo SHA-256".
- **Backup leva os anexos, não os documentos gerados.** O armazenamento não se
  lista; os `.docx` gerados se regeneram do contexto congelado, que vai no
  banco. Todo anexo (inclusive comprovante de EPI e parecer assinado em PDF)
  vai em `anexos/<storage_key>`. Blob ausente não derruba o backup.
- **Destino = armazenamento** (`backups/csso-<carimbo>.enc`, bucket privado),
  e não pasta. A senha é `CSSO_BACKUP_SENHA` (o `config.ts` não tem o campo). A
  trava de "nuvem sincronizada pessoal" continua para destino explícito. O
  backup físico do Postgres é do Supabase; este é o do setor.
- **Exportar-tudo**: mesmo conteúdo do Python com `banco/` no lugar de
  `csso.db`; uma cópia fica em `exportacoes/` (como no Python). Com o Storage a
  resposta é um 303 para URL assinada de 60 s (o corpo da função do Netlify
  para em 6 MB); na pasta local o zip sai na própria resposta. Os testes de
  WAL/lock do Python não têm objeto aqui.
- **/config "Onde o dado mora"** mostra o host/banco do Postgres (sem senha),
  o bucket (ou a pasta local) e os prefixos `backups/` e `exportacoes/`, no
  lugar dos caminhos de disco.
- **`pendencias.no_escopo` devolve a condição** (como `rbac.aplicar_escopo`), e
  o módulo liga `ganchos.sino`/`ganchos.podeVerPendencias` de `web.ts` ao ser
  carregado (as rotas da base o importam).
- **`servidores.historico` devolve os períodos com `unidade`, `uorg`, `cargo` e
  `postos` já carregados** (a `@property postos` vira campo). Serviços que
  mutavam o objeto fazem UPDATE e também atualizam o objeto recebido.
- **`alterar_lotacao` com data inválida** volta à ficha com a recusa escrita
  (o `date.fromisoformat` do Python dava 500).
- **`salvar_com_diff`** mora em `src/rotas/catalogos.ts` (exportado), e não em
  `web.ts`: é a única tela da base que o usa, e mexer em `web.ts` agora
  arriscaria os outros trechos. (O EPI tem uma cópia; unificar depois.)
- **Templates**: `for ... if` do Jinja não existe no Nunjucks — a rota entrega
  a lista já filtrada (`vigentes_por_usuario` em /usuarios, `titulo_catalogo` em
  /catalogos). `editavel` vai no contexto da rota porque o macro do Nunjucks
  não enxerga o `set` do bloco. `d.get('x')` virou `d['x']` (chave ausente é
  `undefined`), e por isso o macro compartilhado `ui.sel` passou a comparar
  com `!= none` (frouxo, casa `null` e `undefined`) e `!== ''`; `x is none` no
  Nunjucks é `x === null` e NÃO casa `undefined`.
- **Demanda: `atrasada(hoje)`** vai como método no objeto que a rota entrega;
  `(hoje - prazo).days` virou `dias_entre(prazo, hoje)`.
- **Habilitação com vocabulário fora do CHECK** responde 422 com a recusa do
  banco (no FastAPI viraria 500 no flush).

## Processos SEI / Adicional Ocupacional (processo, parecer, direito, NUP, SEI, importação, reconciliação)

- **Verdade do Jinja nos templates** (`src/web.ts`, mudança GLOBAL): o Nunjucks
  compilava `{% if x %}`, `x if c`, `not x`, `a or b`, `a and b` com a verdade
  do JavaScript, em que `[]` e `{}` são verdadeiros — "Nada pendente", o quadro
  vazio e toda lista vazia dos templates vindos do Jinja nunca apareciam. O
  compilador foi remendado para passar a condição por `runtime.verdade`: array,
  `Map`/`Set` e objeto SIMPLES vazios são falsos; `Date`, instância de classe e
  o resto seguem a verdade de sempre; `or`/`and` devolvem o operando.
- **`dicionario()`** (`src/dicionario.ts`): o `dict` do Python para a tela —
  objeto simples com `get/items/keys/values` não enumeráveis, para `d.get(k)`,
  `d.items()`, `d.values()|sum`, `d[k]` e `d|length` dos templates portados.
- **Tupla literal no template não existe no Nunjucks**: `('A','B')` avalia para
  `'B'` (grupo), e `x in ('A','B')` virava busca de substring. Nos templates do
  módulo as tuplas viraram listas `[...]`; `x.append()` virou `x.push()`;
  `for x in y if c` (que o Nunjucks lê como if-expressão, silenciosamente
  errado) virou `for` + `if`; `[:n]` virou `.slice(0, n)`; `.isoformat()` saiu
  (a data já é texto ISO); `split(' — ', 1)` é remontado com `slice(1).join`
  (no JS o limite corta o resto).
- **Variável de `for` com duas variáveis não chega ao `include`** no Nunjucks:
  `kanban.html` faz `{% set coluna = codigo %}` antes de incluir o cartão.
- **Filtro `estado`** (rótulo de tela do estado do processo) registrado em
  `web.ts`, como o `filters["estado"]` do `web.py`.
- **Busca de processo com `ILIKE`** (`repositorios/processos.ts`): o `LIKE` do
  SQLite ignorava a caixa das letras ASCII; o do PostgreSQL não. O `ILIKE`
  devolve o comportamento — e também ignora a caixa de letra acentuada, o que o
  SQLite não fazia.
- **Repositório devolve o processo com as relações** (`COM_PROCESSO`: tipo,
  etapa, servidor+cargo, unidade, responsável), no lugar da carga preguiçosa. O
  parecer idem (`parecer.carregar`/`no_escopo`, `COM_PARECER`); exposições em
  ordem de `id`, postos em `parecer_posto.ordem`.
- **Recusas que o Python comitava antes de relançar** (`ASSINATURA_NEGADA` na
  emissão e na assinatura): lançar desfaz a transação da requisição
  (`app.ts`); a rota desenha a tela de 403 e RETORNA, e o evento fica gravado.
- **Documento do parecer no armazenamento** (`documentos/<ano>/<nome>.docx`),
  não em disco. `/pareceres/{id}/pdf` entrega o `.docx` (sem LibreOffice,
  DESVIOS do núcleo); o `_pdf_depois_da_emissao` fica pelo contrato, sem
  `PDF_NAO_GERADO` (indisponível não é incidente).
- **Anexo acima de 4 MB** (`anexos.LIMITE_BYTES`): no envio pela ficha volta
  como recusa na aba Anexos, sem gravar; na carga do Trello entra no relatório
  de perdidos e em `migracao_rejeitada` em vez de derrubar a carga.
- **Importação sem pasta `entrada/`**: a planilha e o JSON do Trello são
  processados da memória (`importacao_planilha.importar(tx, {nome, conteudo},
  ...)`, `importacao_trello.importar(tx, dados, ...)`); a cópia do upload vai
  para `entrada/<nome>` no armazenamento, e a tela `/importar` não lista mais
  "arquivos em entrada/" (armazenamento não é pasta que se liste). JSON
  inválido responde 422 (no Python, 500). Planilha lida pelo exceljs (fórmula
  vale pelo resultado gravado, como `data_only=True`).
- **NUP sintético do Trello com `BigInt`**: os dígitos do id do cartão passam
  de 2^53 (o Python tem inteiro de precisão livre).
- **`registrar_diferencas` do editor**: a descrição de campo `date` sai
  `'2025-02-11'` (a data é texto), onde o Python escrevia
  `datetime.date(2025, 2, 11)`. Valor anterior/novo no JSON são os mesmos.
- **Editor do parecer (`POST /pareceres/{id}`)**: o marco da portaria (RN-05) e
  a recomendação montada do catálogo leem o tipo de marco, a portaria e o tipo
  de adicional pelos ids NOVOS do formulário. No Python a relação do ORM ainda
  era a carregada antes da atribuição (o valor antigo) — nenhum teste portado
  exercita a diferença.
- **Anular com motivo em branco** volta ao editor com a frase do serviço (no
  Python era `ValueError` sem tratamento, 500). Os 422 das rotas do editor
  (`_incompleto`) dizem que nada foi gravado, como o `principal.py`.
- **"Hoje"** de SLA, conclusão, conferência de laudo, emissão, prescrição e
  expurgo de rejeitada é `datas_br.hoje()` (America/Sao_Paulo), não o
  `date.today()` do processo.
- **`/pendencias`**: `atrasada(hoje)` vai como método no objeto e
  `(hoje - prazo).days` virou `dias_entre(prazo, hoje)`; `TELA_DA_ANCORA.get`
  virou indexação.
