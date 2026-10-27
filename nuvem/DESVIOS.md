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
  `--permitir-remoto`. As oito contas compartilham um hash (mesma senha).
  Povoa tudo o que o Python povoa, na mesma ordem (base → Processos →
  Treinamentos → EPI → Demandas → envelhecer pendências): o resumo impresso é
  o mesmo número a número, e as 73 tabelas e os tipos de evento da trilha saem
  com as mesmas contagens do `ambiente_teste_cli.py` (conferido na integração).
  O resumo não tem mais as chaves `contas`/`habilitacoes`, que o Python não
  imprime.
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
- **Decimal vira texto**: `epi_estoque.valor_decimal` devolve string (o
  `str(Decimal)`); aceita só dígitos com uma vírgula ou ponto (o `Decimal`
  aceitava `1e3`, `NaN`, `Infinity`). `valor_em_estoque` e o custo por empenho
  (`epi_indicadores`) somam em inteiro na escala 10⁻⁴, sem float; `custo_texto`
  dá o `:.2f` arredondando metade para o par, como o Decimal.
- **`atualizar_lote` faz UPDATE e também atualiza o objeto recebido** (o
  `setattr` do Python).
- **Supressão RN-19**: `src/rotas/epi_indicadores.ts` reexporta a de
  `src/rotas/relatorios.ts` (uma cópia só da regra de privacidade).
- **`EVENTOS_DE_RECUSA` com literais** em `epi_indicadores.ts`: ler constante
  alheia no carregamento, num ciclo de import ESM, não tem garantia.
- **CSV da exportação escrito à mão** (`;`, aspas mínimas, `\r\n`, BOM).
- **Requisição: a escrita atualiza a linha e o objeto recebido**
  (`src/servicos/epi_requisicao.ts`). O ORM do Python carregava relação sob
  demanda (`linha.requisicao`, `requisicao.itens`) e dava flush depois; aqui o
  serviço recarrega o que precisa e grava com UPDATE + `Object.assign`. Quem
  guarda outra cópia da linha tem de relê-la.
- **Campos vão no MESMO UPDATE da troca de estado** (`_mover`/`_mover_item`
  com `campos`): o Postgres confere CHECK a cada UPDATE (`ck_req_protocolo`,
  `ck_item_lote`), e o flush do Python gravava tudo junto. `liberar_reserva`
  passou a gravar no banco na hora (no Python só mexia na memória).
- **Reserva trava a linha do lote com `SELECT ... FOR UPDATE`** antes de ler
  `disponivel` — o lugar do `BEGIN IMMEDIATE` do SQLite; duas reservas
  simultâneas passam uma depois da outra (testado com duas conexões).
- **Ficha da requisição e guia não dão `s.commit()` próprio**: a requisição
  inteira é uma transação; a recusa que redesenha a tela usa SAVEPOINT
  (`tentar()` na rota). `AutoanaliseProibida` (RN-28) continua chegando ao
  `onError` como 403 com a mensagem inteira.
- **Templates da requisição leem `dict` do Python por `dicionario()`**
  (`src/dicionario.ts`, apelido `dic`); a rota registra o global
  `sem_digitado` no lugar de `digitado or {}`. Tuplas viraram listas,
  `{% with %}` virou `{% set %}`, `resumo.values()|sum` virou `total_resumo`.
- **O teste de 50 protocolos simultâneos usa o ano 2031**: o banco do arquivo é
  compartilhado e os outros testes esperam `EPI-AAAA-0001`.
- **Testes**: banco limpo por teste (`beforeEach` → `bancoLimpo()`), como o
  fixture `banco` do pytest. Em `epi_adicional.test.ts` o ouvinte de mapper do
  SQLAlchemy virou um gatilho de banco que conta toda escrita em
  `adicional_vigencia`, e a prova estática por AST virou busca por regex do
  verbo do Drizzle/SQL sobre a tabela; as partes do parecer
  (`registrar_avaliacao_de_epi`, congelado `epi` na emissão, telas do editor)
  ficam com o porte de Processos.
- **Decimais das telas de turma e certificado em português** (filtro `num`, de
  `presenca.numero`): horas, frequência e notas saem "8,3 h", "100%", "7" — e
  não "8.3h", "100.00%", "7.00" (o texto cru do `numeric`). O valor gravado não
  muda; os campos de digitar continuam aceitando ponto ou vírgula.

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

- **Aviso do desfecho a quem demandou** (18/10/2026; não existe no Python):
  ao encerrar, `demandas.avisar_quem_demandou` abre `DEMANDA_DESFECHO_A_LER`
  para a conta ativa vinculada a `solicitante_servidor_id`, com o desfecho e
  o relato na própria descrição — quem demandou não tem `demanda.ver`, e a
  frase é tudo o que ele lê. `pendencias.titular_de` passou a resolver a
  entidade `demanda` pelo solicitante, para o titular ler a frase sem
  supressão. Quem encerra a própria demanda não é avisado.

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

## Busca global, API, app e tela de bolso (`/buscar`, `/api/v1`, `/app`, `/celular`, `/sw.js`)

- **Busca de turma com `ILIKE`** (`src/servicos/busca.ts`): o `LIKE` do SQLite
  ignorava a caixa (`tur-2026` achava `TUR-2026-0007`); o do Postgres não. O
  laudo segue com `LIKE` (o número só tem dígitos e pontuação).
- **Blocos da busca em sequência**, não em paralelo: a transação da requisição
  é uma conexão só. Os itens do bloco de servidor e de requisição são relidos
  com as relações que o template lê (`unidade`, `servidor`); o do certificado
  ganha `rotulo` (o `@property` do modelo).
- **`achou` da busca vem da rota**: o `blocos|selectattr('itens')` do Jinja
  dependia de lista vazia ser falsa, e o `selectattr` registrado em `web.ts`
  usa `Boolean(v)` (lista vazia é verdadeira no JS). O template lê `achou`
  pronto. (O filtro em si não foi mexido: é compartilhado.)
- **Forma do corpo da API sem Pydantic** (`src/esquemas/api.ts`): leitores
  pequenos no modo "lax" do Pydantic (inteiro aceita `"5"`, booleano aceita
  `"true"`/`1`, data `AAAA-MM-DD`), com as mensagens do Pydantic v2
  (`servidor_id: Field required`). JSON quebrado vira o mesmo 422
  `{erro: "O envio não tem a forma esperada.", motivos: ["corpo: JSON decode error"]}`.
  `app/esquemas/validadores.py` não foi portado: nenhuma rota o usa.
- **Recusa da API desfaz a transação lançando** `RecusaDaApi` (o
  `s.rollback()` + `raise` do Python); o `s.commit()` do caminho feliz é o
  COMMIT do middleware. Na leitura da ficha, a linha de `acesso_dado_sensivel`
  vai no mesmo COMMIT da resposta (no Python, commit logo após gravar).
- **Ordem das guardas do POST**: `X-Requested-With` primeiro, depois sessão,
  depois forma do corpo — a ordem das dependências do FastAPI.
- **`POST /api/v1/turmas/{id}/presencas`** devolve a grade relida do banco
  (`no_escopo` de novo); a recusa pega `RegraViolada` e `TransicaoInvalida`
  (os `ValueError` do Python). Horas inválidas: `para_decimal` devolve `null`
  em vez de lançar.
- **"Hoje" da API** (data futura da entrega, CA/troca vencidos da ficha,
  pendência atrasada) é `datas_br.hoje()` (America/Sao_Paulo), não o
  `date.today()` do processo.
- **`/api/v1/pendencias`**: o nome do responsável é lido numa consulta só por
  `responsavel_id` (sem relação preguiçosa `p.responsavel`).
- **`/app` e `/sw.js` leem o arquivo do bundle da função**: na nuvem `public/`
  vai para o CDN e não está no disco da função. `netlify.toml` (raiz do repo)
  passou a incluir `public/estaticos/app/index.html` e
  `public/estaticos/js/sw.js` em `included_files`; a pasta é achada como a de
  templates (`CSSO_ESTATICOS`, `public/estaticos`, `nuvem/public/estaticos`,
  relativa ao módulo — `pastaDeEstaticos()` em `src/rotas/aplicativo.ts`). Os
  assets do bundle (`/estaticos/app/assets/…`) seguem no CDN. `/sw.js`
  responde `application/javascript; charset=utf-8`.
- **`/app/{resto:path}`** virou `/app/*` (Hono). O teste que trocava
  `aplicativo.ENTRADA` usa `_definir_entrada()`.
- **`celular.html`**: `usuario.nome.split()[0]` virou
  `usuario.nome.trim().split(' ')[0]` (o `split()` sem argumento do JS não
  quebra nada).
- **Testes que faziam monkeypatch** (`identificacao.pode_ver_nominal`,
  `pendencias.pode_ver`) provam o mesmo pelo banco do teste: o perfil do
  coordenador perde `exposicao.ver`/`epi.ficha`; uma conta sem perfil
  nenhum pede as pendências. Os assets de `/estaticos/` são conferidos no
  disco (`public/`), não por GET no app — na nuvem eles não passam por ele.

## Integração (ambiente de teste, dívidas cruzadas, suíte, publicação)

- **`uq_parecer` passou a valer só para parecer numerado** (`numero > 0`;
  migração `0001_parecer_rascunhos_sem_numero`). CORRIGE um defeito que o
  Python também tem: o rascunho nasce com número 0 (o número só é consumido na
  emissão, RN-03) e o UNIQUE(numero, ano) deixava existir UM rascunho por ano
  no sistema inteiro — com um rascunho aberto, `GET /processos/{id}/parecer` de
  qualquer outro processo dava 500 (IntegrityError), no Python e aqui (o
  ambiente de teste já nasce com um rascunho). O número emitido continua único
  por ano. **Levar a mesma correção ao Python.**
- **`.docx` de parecer incompleto responde 422** (`/pareceres/{id}/docx` e
  `/pdf`), com a frase de `DadosIncompletos` (o que falta). CORRIGE defeito do
  Python, onde o `ValueError` não tinha tratador e a resposta era 500 (ex.: o
  `.docx` de um rascunho recém-aberto).
- **`salvar_com_diff` mora em `src/web.ts`**, como o `web.salvar_com_diff` do
  Python; as três cópias (base, EPI, treinamentos) viraram import. A entidade
  da trilha é o nome da tabela; coluna `numeric` que muda só a grafia ('8.0' →
  '8') não vira diferença (no Python o `Decimal` comparava igual).
- **Métodos de `dict`/`str` do Python dentro do template** (`src/web.ts`,
  mudança GLOBAL): o `memberLookup` do Nunjucks supre `get/items/keys/values`
  para objeto simples e `Map` que não tenham o membro, e
  `upper/lower/strip/startswith/endswith` para texto. Antes, rota que esquecia
  o `dicionario()` dava 500 só no ramo do template que lia o método.
- **`{{ dicionario }}` sai como o `str(dict)` do Python** (`reprPython` no
  `suppressValue`), e não `[object Object]` — o caso era `valor_novo` jsonb de
  `EPI_ITEM_RECUSADO` na `/auditoria`. Lista continua saindo como o Nunjucks a
  escreve.
- **`selectattr`/`rejectattr` sem teste e `default(x, y, true)`** usam a verdade
  do Jinja (lista/dict vazios são falsos), como o compilador já fazia com `if`.
- **Testes: o banco do arquivo é restaurado no lugar, não clonado de novo**
  (`testes/ajuda.ts`, `testes/modelo.ts`). O modelo guarda um retrato de si
  (esquema `_csso_modelo`: cópia das tabelas semeadas, estado das sequências,
  impressão digital do esquema); `bancoLimpo()` a partir da segunda chamada
  apaga os dados de `public` e recoloca o retrato com os gatilhos desligados
  (`session_replication_role = replica`), e o NOME do banco não muda. Se um
  teste mexeu no esquema, clona-se um novo, como antes. Os clones são apagados
  todos no teardown (todo `DROP DATABASE` força um CHECKPOINT, que com a suíte
  inteira escrevendo levava segundos e travava os outros arquivos), e o clone
  roda com `synchronous_commit = off`. A suíte foi de ~9 min para ~3 min.
  Consequência: quem guardou o `nome`/`url` de um banco anterior do mesmo
  arquivo vê o banco restaurado (o `db` antigo já não servia antes).
- **`netlify serve`/`netlify dev` acrescentam `.netlify` ao `.gitignore` da
  RAIZ do repositório** (o `nuvem/.gitignore` já o tem). A integração desfez a
  mudança; quem rodar o CLI localmente vai vê-la de novo.


## Produção — segurança (revisão de 25/09/2026, exposição na internet pública)

O sistema Python atendia só a rede do setor; na nuvem qualquer pessoa na
internet chega ao `/login`. O que mudou por isso (testes em
`testes/seguranca_producao.test.ts` e `testes/seguranca_autorizacao.test.ts`):

- **CSRF por origem** (`nucleo/seguranca.origemCruzada`, middleware em
  `src/app.ts`). POST/PUT/PATCH/DELETE com `Sec-Fetch-Site` diferente de
  `same-origin`/`none`, ou com `Origin`/`Referer` de outro host, recebe 403
  antes de tocar no banco. O `SameSite=Lax` sozinho não bastava: é por SITE —
  num domínio próprio sob `ufvjm.edu.br`, qualquer subdomínio irmão é "o mesmo
  site" (o `netlify.app` está na Public Suffix List, então lá os irmãos já eram
  outro site). `same-site` é recusado de propósito. Sem nenhum dos três
  cabeçalhos (curl, testes) passa: não é navegador, não há cookie de vítima.
- **Produção recusa subir com segredo de exemplo** (`config.exigirConfiguracaoDeProducao`,
  chamado em `obterConfig`). Com `CSSO_AMBIENTE=producao` (ou `produção`),
  lança `ConfiguracaoInsegura` — e toda requisição dá erro até corrigir — se
  `CSSO_CHAVE_SECRETA` faltar, for a de exemplo ou tiver menos de 32
  caracteres; se `CSSO_BACKUP_SENHA` faltar, for a de exemplo ou tiver menos
  de 16; com `CSSO_COOKIE_SEGURO=nao`; ou sem `DATABASE_URL`. A mensagem diz o
  NOME da variável, nunca o valor. Fora de produção continuam avisos. Também:
  `CSSO_CHAVE_SECRETA=` vazia (como no `.env.exemplo`) passava calada com HMAC
  de chave vazia; agora vale como ausente. `CSSO_PRIMEIRO_ACESSO_REMOTO=sim`
  vira aviso na tela.
- **Login com o mesmo custo para conta que existe e que não existe**
  (`autenticacao._gastar_argon2`): recusa sem conta, conta inativa e conta
  bloqueada conferem a senha contra um hash descartável. Antes, o cronômetro
  separava e-mail cadastrado de não cadastrado.
- **Bloqueio por conta sem corrida**: a linha do usuário é lida com
  `SELECT ... FOR UPDATE`. Antes, N tentativas em paralelo liam o mesmo
  `tentativas_falhas` e passavam todas pelo bloqueio.
- **Teto de falhas por endereço** (tabela nova `limite_login_ip`, migração
  `0003_limite_login_ip`). Não existia no Python. 30 falhas (em qualquer
  conta) na janela de 15 min bloqueiam o endereço por 15 min, antes do Argon2
  — corta a tentativa de "uma senha em cada conta" e o custo de 64 MiB por
  tentativa anônima. `CSSO_MAX_FALHAS_IP` (0 desliga) e
  `CSSO_JANELA_IP_MINUTOS`. Folgado por causa do NAT da UFVJM (o campus sai
  por poucos endereços). O endereço vem de `x-nf-client-connection-ip`, que a
  borda do Netlify escreve; se um dia houver outro proxy/CDN na frente do
  Netlify, o endereço vira o do proxy e o teto tem de ser revisto. As linhas
  somem um dia depois (IP é dado pessoal), no login seguinte.
- **A troca de senha provisória vale em toda rota** (`dependencias.usuarioLogado`):
  com `precisa_trocar_senha`, só `/trocar-senha` e `/sair` abrem (a API
  responde 403). No Python o login redirecionava uma vez e bastava digitar
  outro endereço.
- **Senha provisória no corpo, não na URL** (`rotas/usuarios.ts`): criar conta
  e redefinir senha respondem a tela direto (com `cache-control: no-store`),
  em vez do 303 para `/usuarios?mensagem=...senha...`, que deixava a senha no
  histórico do navegador. Recarregar a página reenvia o formulário (gera outra
  provisória) — preço aceito.
- **Exportação completa só para quem responde pelo sistema**
  (`configuracao.pode_exportar_tudo`): `exportar` E (`perfil.conceder` ou
  `catalogo.gerenciar`) — superintendência e coordenação. No Python bastava
  `exportar`, que sete perfis têm (técnico, engenheiro, médico, consulta
  PROGEP, auditor...), e o zip em claro traz o banco inteiro: hash de senha de
  todas as contas, anexos restritos, nomes sem a RN-19. O ideal é uma
  permissão própria na matriz (ver recomendações).
- **Escritas do parecer respeitam o escopo da leitura** (`rotas/pareceres.ts`,
  `adicionais.ts /adicionais/propor`): salvar, portaria, exposições, EPI,
  emitir, assinar e anular carregam por `servico.no_escopo`, não por
  `carregar`. No Python (`s.get`) quem não abria o parecer ainda podia
  anulá-lo ou emiti-lo pelo id.
- **RN-14 na portaria e na exclusão de exposição**: parecer EMITIDO/ASSINADO
  recusa trocar portaria (e com ela o marco inicial) e excluir agente. No
  Python as duas rotas não olhavam a situação.
- **Download de anexo do Trello preso ao Trello** (`importacao_trello.baixar_url`):
  só `https`, só `trello.com`/`*.trello.com`/`*.trellocdn.com`/
  `trello-attachments.s3.amazonaws.com`, redirecionamento seguido à mão e
  conferido a cada salto, credencial (`CSSO_TRELLO_KEY/TOKEN`) só para
  `trello.com`, corpo cortado em 4 MB, prazo de 15 s. Antes a URL do JSON
  enviado levava a credencial a qualquer host (SSRF).
- **`?proximo=` do login recusa caractere de controle e barra invertida em
  qualquer posição** (`destino_seguro`): o navegador apaga TAB/LF da URL, e
  `/<TAB>/atacante.example` virava `//atacante.example`.
- **Log de erro não tratado sem dado** (`nucleo/seguranca.resumoDoErro`): o
  `console.error` do `onError` leva tipo, SQL com `$1`, código/restrição do
  Postgres e a pilha — sem os `params` da consulta (que o `DrizzleQueryError`
  põe no texto) nem o `detail` do Postgres ("Key (email)=(...)").
- **Prévia do parecer escapa a fundamentação legal** (`partes/previa_parecer.html`):
  `|escape|nl2br` no lugar de `|replace('\n','<br>')|safe` — o texto vem do
  catálogo, digitado.
- **Link "Abrir no SEI" só para `http(s)://`** (`paginas/processo_ficha.html`):
  o campo é digitado; `javascript:` num `href` é script (a CSP já barrava).

### Recomendações aplicadas no endurecimento de 18/10/2026

Estavam aqui como "não aplicadas (decisão do dono)"; o dono decidiu aplicar.
Testes em `testes/endurecimento.test.ts`.

- **Política de senha**: mínimo de **6** caracteres (era 10 até 22/10/2026,
  ver abaixo) e 5 diferentes, **sem** regra de composição (NIST SP 800-63B),
  e lista de senhas vazadas e de contexto (UFVJM, campi, CSSO). **Desvio do
  Python** (6, letras e números): o tamanho voltou a ser o dele, a regra de
  composição continua fora.
  A senha que entra certa mas não passa na política de hoje vira troca
  obrigatória no próprio login — é o único momento em que o sistema a conhece.
  A provisória passou a `xxxx-xxxx-99` (≈ 43 bits, contra 26).
  - **Mínimo de 10 → 6, a pedido do usuário (22/10/2026).** Dez caracteres
    era a queixa de quem usa o sistema, e o setor pediu a volta ao tamanho
    do sistema da rede. O que segura a
    senha curta é o resto da política: a lista de triviais e de contexto, os
    5 caracteres diferentes (`aaaaaa` e `121212` não passam), o bloqueio por
    tentativas seguidas na conta (também na conta inexistente, D26) e o teto
    por IP. A senha de 6 já gravada passa a valer sem troca obrigatória; a
    provisória continua `xxxx-xxxx-99`. `TAMANHO_MINIMO_SENHA` em
    `src/servicos/autenticacao.ts`; a barra de força da tela lê o mesmo
    número (`POLITICA_SENHA`).
- **Redefinição de senha**: a própria, nunca (troca-se sabendo a atual);
  conta de administração (`PERMISSOES_DE_GOVERNO`: conceder perfil, atestar
  habilitação, criar conta, redefinir senha, backup) só por quem tem
  `perfil.conceder`; as demais, pelo `admin_ti` como antes. (Substituído em
  22/10/2026 pela regra "só a conta cujas permissões estão contidas nas de
  quem redefine": ver "Governança de acesso: escopo por permissão e
  titular".) A regra "só quem alcança tudo o que o alvo alcança" foi
  descartada: só o `admin_ti` tem
  `usuario.resetar_senha`, e ele não alcança nada de técnico — ninguém mais
  teria a senha redefinida. Recusa grava `SENHA_RESET_RECUSADO`.
- **Sessão por inatividade**: `CSSO_SESSAO_INATIVIDADE_MINUTOS`, 120 por
  padrão (60 desde 22/10/2026: ver "Desligamento por inatividade") (0 desliga), além das 12 h absolutas. Coluna nova
  `sessao.ultimo_uso_em` (migração 0005), regravada no máximo uma vez por
  minuto. Duas horas, e não quinze minutos: o parecer se escreve com o SEI
  aberto ao lado, e a sessão vencida no salvamento perderia o texto.
- **GET que escrevia**: `/sair` é POST (o GET mostra o botão) e o rascunho de
  parecer nasce de `POST /processos/{id}/parecer` (o GET volta à ficha). O
  app compilado (`/app`) ainda aponta o "sair" para o GET — cai na tela do
  botão; trocar por formulário pede recompilar o `frontend/` e um
  `POST /sair` no Python, que usa o mesmo bundle.
- **CSV com fórmula**: `servicos/csv.ts`, um gerador só (eram três), prefixa
  `'` em célula que começa por `= + - @`, tabulação ou `\r` — exceto número.
- **Anexo**: sai com o tipo declarado só se ele estiver em
  `anexos.TIPOS_SERVIDOS` (pdf, imagens, office, texto); fora disso,
  `application/octet-stream`. O `mime_type` gravado não muda.
- **Planilha**: `servicos/arquivo_zip.conferir_zip` descompacta cada parte com
  `maxOutputLength` (64 MB no total, 2.000 partes) antes do ExcelJS, e a
  importação recusa mais de 5.000 linhas. Vale pelo que descompacta, não pelo
  tamanho que o zip declara.
- **Exportação completa**: o zip sai sem `sessao` e `limite_login_ip` e com
  `usuario.senha_hash` vazio (e troca obrigatória). Restaurado dele, ninguém
  entra até a redefinição; a cópia fiel é o backup cifrado. A permissão
  própria (`exportar.tudo`) não foi criada: a rota já exige `exportar` +
  `exposicao.ver` + (`perfil.conceder` ou `catalogo.gerenciar`).

### Recomendações que continuam NÃO aplicadas

- **Mensagem "Conta bloqueada até..."** (baixa): confirma que o e-mail existe
  (CA-12 pede a mensagem). Se o risco pesar mais que a instrução, trocar pela
  genérica.
- **Teto por endereço e `/validar`** não seguram ataque distribuído: para isso,
  regra de rate limit/WAF na borda do Netlify.
- **Varredura de `pendencias` (qualquer permissão de escrita fecha pendência de
  qualquer módulo), painel `/` mostrando eventos e laudos a `servidor_consulta`,
  e `/auditoria` exibindo `valor_anterior/valor_novo` sem máscara RN-19**:
  vazamentos de baixa monta, do escopo da revisão de privacidade.
- **Dependências**: `npm audit --omit=dev` acusa `uuid <11.1.1` (moderada, via
  `exceljs`); o defeito é em `v3/v5/v6` com `buf`, que o `exceljs` não usa. Não
  explorável aqui; resolver quando o `exceljs` subir o `uuid` (o `audit fix
  --force` rebaixaria o `exceljs` para 3.4).

## Produção — operação (implantação, backup diário, rotinas agendadas)

- **Marca de produção no banco** (tabela `instalacao`, migração `0002`,
  `src/servicos/instalacao.ts`). No Python produção e teste eram pastas
  diferentes; aqui a mesma `DATABASE_URL` pode apontar para qualquer um, então
  o banco diz de si o que é. `ferramentas/apagar-banco.ts` (o DROP das tabelas
  de `public` + `drizzle`, usado por `ambiente-teste` e `producao-iniciar`)
  confere a marca **na mesma transação** do DROP, com a tabela travada, e
  recusa — não há bandeira que passe por cima (`--permitir-remoto` libera
  banco remoto, não banco de produção). `travas.sql` recusa UPDATE/DELETE/
  TRUNCATE na marca. `CSSO_AMBIENTE=producao` também faz o `ambiente-teste`
  recusar, com ou sem marca. A marca vai no backup: um backup de produção
  restaurado noutro banco chega marcado (e protegido).
- **`ferramentas/producao-iniciar.ts`** substitui o `/primeiro-acesso` na
  internet: pede a identidade do banco digitada (ref do projeto Supabase, ou
  host/banco), apaga, migra, semeia, grava `certificado.url_publica`, a marca e
  o primeiro superintendente (`criar_primeiro_superintendente`, com
  `precisa_trocar_senha`), numa transação. A senha provisória tem 20 caracteres
  (não os 6 da `senha_provisoria` ditada pelo coordenador) e sai só na tela.
  Fala com o banco por `abrirBancoAvulso` (novo em `src/db/cliente.ts`):
  `obterBanco(url)` devolve o singleton já aberto e ignora a `url`.
- **Certificado em produção exige URL pública declarada**
  (`emissao_certificado.url_publica_declarada`, bloqueio em `validar`). O recuo
  para a `URL` do Netlify/127.0.0.1 continua fora de produção. No Python não
  havia o bloqueio (o recuo era host:porta da máquina do setor).
- **Backup diário com anexos separados** (`backup.fazer_backup_diario`). O
  `fazer_backup` (anexos dentro do pacote) continua para o botão de /config e
  para o CA-13, mas não escala: o pacote passa inteiro pela memória e o Storage
  do Supabase Free recusa arquivo > 50 MB. O diário leva o banco + `anexos.json`
  (índice) e cifra cada anexo UMA vez em `backups/anexos/<sha256>.enc`
  (conteúdo imutável: a cópia de ontem vale hoje). Mesmo envelope `CSSOBK01`
  por arquivo; um sal por passada e a derivação PBKDF2 memorizada (sem isso,
  ~0,25 s por anexo). Cópias em paralelo (6) com prazo de 10 min: o que não
  coube fica `pendente`, a passada sai `ok = false` ("PARCIAL") e continua no
  dia seguinte; o índice cita os pendentes, e restaurar esse pacote avisa.
- **Dump em REPEATABLE READ, só leitura.** A DESVIOS da Base dizia "retrato
  consistente por MVCC", mas em READ COMMITTED cada `json_agg` vê um instante;
  o backup da rotina roda com `isolationLevel: "repeatable read"`.
- **Restauração lê os anexos separados** (`restaurar-backup.ts --anexos
  <pasta>`, ou do armazenamento configurado), recalcula a chave a partir do
  `storage_key` (não confia no índice) e confere o SHA-256 de cada arquivo;
  faltou ou não confere → saída 5.
- **Retenção** (`rotinas.backups_a_apagar`), a regra da POLITICA_RETENCAO §4
  que no Python era manual: todos dos últimos 90 dias; o primeiro de cada mês
  por 5 anos; sempre os 7 mais recentes; nome que não é de backup nunca é
  tocado; só roda depois de um backup completo. As cópias de anexo
  (`backups/anexos/`) não expiram — anexo não se apaga (§2).
- **Rotinas agendadas** (`src/servicos/rotinas.ts`,
  `netlify/functions/rotina-noturna.mts` agendada às 04h30 UTC = 01h30 BRT, e
  `backup-background.mts`, função de fundo): substituem o `csso-backup.timer`,
  as Tarefas Agendadas `conferir_cadeia`/`varrer_pendencias` e o
  `expurgar_sessoes` do boot. A varredura de pendências é o
  `ferramentas/varrer_pendencias.py` portado (`rotinas.varrer_pendencias`). O
  expurgo das janelas de `limite_login_ip` vencidas e os expurgos de
  privacidade (registro de acesso — a rotação de 90 dias do `acesso.log` — e
  cópias de exportação) entram na mesma passada. Cada passada vira linha em
  `rotina_execucao` (tabela nova) e aparece em `/saude/db` (`rotinas`,
  `alertas`, `producao`).
- **Gatilho da função de fundo protegido** por `CSSO_ROTINA_SEGREDO`
  (cabeçalho `x-csso-rotina`, `timingSafeEqual`, 32+ caracteres). A URL de uma
  função de fundo é pública e o Netlify responde 202 antes do código rodar:
  sem o segredo, a função sai sem abrir o banco.
- **Faixa "Ambiente de HOMOLOGAÇÃO"** em toda tela quando
  `CSSO_AMBIENTE=homologacao` (`templates/base.html`): a instalação de teste
  tem a mesma cara da de produção. Não aparece em `producao`, `local` nem nos
  testes (`teste`).

## Produção — privacidade (revisão LGPD de 25/09/2026)

Revisão feita quando o dono decidiu carregar dados reais de servidores
(24/09/2026). O registro de tratamento da nuvem está em `docs/ROPA_NUVEM.md`
(operadores, localização, transferência internacional, pendências).

**CPF**

- **CPF não é chave de ninguém.** Na revisão de 25/09/2026 não havia coluna de
  CPF. Desde 19/10/2026 há **uma**, `participante.cpf`, opcional e **só para o
  certificado** cuja norma exige o número (brigadista, CBMMG), lida e gravada
  só por `servicos/cpf_certificado.ts`; nada busca, casa ou compara pessoas por
  ela — a mesclagem só a usa para RECUSAR juntar dois CPFs diferentes
  (reafirmado na prevenção de duplicados, 23/10/2026: CPF não vira chave de
  identificação). Fora dessa coluna, o ambiente de teste inteiro povoado não tem
  CPF em coluna de texto ou jsonb (`testes/privacidade_varredura.test.ts`).
- **CPF digitado em campo livre é MASCARADO na entrada** (`textos.mascarar_cpf`,
  `***.***.***-**`, nenhum dígito), num lugar só: `dependencias.formulario`
  (todo campo de todo formulário, e o nome do arquivo enviado; os campos de
  senha — `senha*`, `nova`, `confirmacao` — e `token`, `csrf`, `nonce` passam
  intactos: campo de senha novo tem de entrar em `INTOCAVEIS`), `esquemas/api.corpo_json` (todo
  texto do JSON da API), a leitura da planilha (`importacao_planilha.valor_da_celula`)
  e o JSON do Trello (`rotas/importacao.ts`). Forma pontuada mascara sempre;
  onze dígitos soltos só com dígito verificador válido (telefone com DDD também
  tem onze); colado a letra ou dígito não casa (hash hexadecimal, código).
  **Desvio**: o Python não detectava o NÚMERO em lugar nenhum — a
  RN-21 recusa a palavra "cpf", e só nos campos que filtra. Mascarar e não
  recusar porque a recusa precisa de tela que devolva o formulário, e isso só
  existe nos campos da RN-21; nos outros (observação, motivo, justificativa,
  nome de arquivo) mascarar é a única saída que não perde o resto do texto.
  Máscara sem dígito nenhum, e não `***.456.789-**`: o ROPA §6 já recusa
  máscara parcial de matrícula. **Levar ao Python.**
- `ferramentas/procurar-cpf.ts`: conta CPF já gravado em qualquer coluna de
  texto (sem imprimir o valor) — para rodar depois da carga real e de cada
  restauração. Não lê o conteúdo de anexo.
- Resíduo: a cópia bruta do upload em `entrada/` (planilha/JSON) é gravada antes
  da máscara, como o arquivo original. Apagar ao encerrar a migração
  (ROPA_NUVEM §6).

**RN-19 — vazamentos achados pela varredura e corrigidos**

A varredura (`testes/privacidade_varredura.test.ts`) povoa o ambiente de teste,
deixa o coordenador seguir todo link/`hx-get`, soma toda rota GET do app com
os ids do banco e as buscas, e repete tudo com `secretaria`, `admin`,
`servidor` (titular: o próprio nome pode) e `sem_nominal` (perfil sintético
com TODA permissão menos `exposicao.ver`/`epi.ficha`), abrindo .docx/.xlsx/.zip
por dentro e olhando cabeçalhos. As saídas nominais deliberadas estão listadas
no teste (`DELIBERADAS`), cada uma com o motivo.

- **Trilha `/auditoria`: o "antes → depois" levava nome e SIAPE** (o retrato da
  linha da ficha de EPI no `valor_novo`) para `admin_ti`, que tem
  `auditoria.ver` e não tem permissão nominal. O Python tem o mesmo buraco.
  `identificacao.valor_da_trilha` suprime valor que é objeto/lista e valor de
  campo nominal (`nome`, `siape`, `email`, `*_snapshot`, `solicitante_nome`)
  para quem não lê nome; a janela da cadeia continua conferindo o gravado.
- **Ficha da requisição de EPI: "Aberto por" e a trilha da tela** escreviam o
  nome da CONTA que abriu — que é a do próprio requerente (`servidor_consulta`)
  —, desfazendo o `SRV-xxxx` do titular na mesma tela (secretaria). Conta
  vinculada a servidor passa por `pode_ver_nominal`/`identificador_opaco`
  (`epi_requisicoes._nomes_de`, `_trilha_para_tela`). Mesmo defeito no Python.
- **Comprovante de EPI (`/epis/fichas/registros/{id}/comprovante`)** exigia só
  `epi.entregar`; agora exige também ler a ficha (`exigir_leitura_da_ficha`:
  `epi.ficha` ou titular). Na matriz as duas andam juntas; perfil montado sem
  `epi.ficha` imprimia o papel nominal de qualquer um.
- **`/config/exportar-tudo`** exigia só `exportar`; agora também
  `exposicao.ver` (o zip é o banco em claro). Mesmo raciocínio.
- **`/treinamentos/assinaturas`**: a lista de servidores para vincular o
  instrutor saía com nome e SIAPE para quem tem `assinatura.gerenciar`; agora
  `identificar(sv).com_siape` (opaco sem permissão nominal).
- **Painel (`/`), "Últimos eventos"**: mostrava os dez últimos eventos do
  sistema inteiro a todo `processo.ver`, inclusive ao `servidor_consulta` — com
  o nome da conta de quem agiu, que, quando é outro titular, diz quem pediu
  EPI ou se inscreveu. Agora quem tem escopo próprio vê só os próprios eventos,
  e o nome de conta vinculada a servidor passa pela RN-19
  (`privacidade.atores_para_tela`). A fila "Laudos sem conferência" só aparece
  com `laudo.ver` (antes abria link que dava 403). O Python mostra os dois.
- Saídas nominais **mantidas** (deliberadas, como no Python): nome do
  instrutor; abas nominais da turma para `certificado.ver`/`turma.inscrever`/
  `turma.avaliar`; certificado para `certificado.ver`; `.docx`/`.pdf` do
  parecer para `parecer.ver`, com linha em `acesso_dado_sensivel`; nome de
  conta em `/usuarios`, no filtro/coluna de usuário da trilha e no filtro de
  responsável de `/processos` e `/kanban`. **Recomendação**: o filtro de
  responsável lista toda conta ativa, inclusive as `servidor_consulta` — com
  conta para cada servidor, vira a lista nominal do quadro; filtrar por quem
  tem `processo.editar`.

**Registro de acesso e logs**

- **`registro_acesso` (tabela, migração `0004_registro_acesso`) no lugar de
  `dados/logs/acesso.log`** (`servicos/registro_acesso.ts`,
  `db/esquema/privacidade.ts`). Mesmo conteúdo do Python (correlação, IP, id
  da conta, método, forma da rota — `/servidores/{id}` —, status, duração) e
  as mesmas exclusões (nome, SIAPE, login, query, corpo, caminho concreto;
  rota desconhecida = `-`). IP só de `x-nf-client-connection-ip`. Tabela e não
  `console`: o log do Netlify fica nos EUA, com prazo do plano e sem RBAC.
  Grava fora da transação da requisição (a que falhou também fica) e, na
  função, por `context.waitUntil` (`netlify/functions/csso.mts` passa o
  contexto ao Hono), sem atrasar a resposta. `CSSO_LOG_ACESSO=nao` desliga.
- **Retenção de 90 dias cumprida pela rotina noturna** (`EXPURGO_PRIVACIDADE`,
  `servicos/privacidade.ts`), com `CSSO_LOG_RETENCAO_DIAS` — o mesmo prazo e a
  mesma variável de `sessao`, pelo motivo do Python (o mesmo IP). Marco Civil
  art. 15 (6 meses) não foi adotado: é para provedor "com fins econômicos", e a
  dúvida já está na POLITICA_RETENCAO §2.5, item 2; se o encarregado decidir
  por 6 meses, `CSSO_LOG_RETENCAO_DIAS=180`.
- **Mensagens de falha das rotinas sem `params:`** (`privacidade.mensagem_sem_dados`
  em `rotinas.ts`): o Drizzle anexa os valores da consulta que falhou à
  mensagem, e ela ia para o log do Netlify e para `rotina_execucao.detalhe`.

**Armazenamento**

- **A cópia da exportação completa é apagada em 24 h** (`expurgar_exportacoes`,
  na rotina noturna). **Desvio**: no Python "uma cópia fica e não é apagada
  sozinha" — no disco do setor; aqui é zip em claro com o banco inteiro num
  bucket de terceiro, e a cópia só existe para servir a URL assinada de 60 s.
- **Bucket público é recusado** (`ArmazenamentoSupabase.obter`): se o bucket já
  existir e estiver público, o sistema não grava nem lê.
- Anexos e documentos saem pela função (RBAC + registro); a única URL assinada é
  a da exportação (60 s).

**Direitos do titular (só recomendação)**

O `servidor_consulta` vinculado ao próprio servidor alcança: os próprios
processos e pareceres (inclusive o `.docx`), a própria ficha de servidor, a
própria ficha de EPI, as próprias requisições, os próprios certificados e
treinamentos, `/api/v1/eu`. Falta: (1) exportar os próprios dados de uma vez
(art. 18, II e V) — hoje é tela a tela; (2) pedir correção pelo sistema
(art. 18, III) — hoje só pelo e-mail do setor; (3) ver quem leu o próprio dado
(`acesso_dado_sensivel` sobre si) e com quem foi compartilhado (art. 18, VII);
(4) conta para cada servidor — sem conta vinculada, nada disso existe para ele.

## Dívidas técnicas fechadas só na nuvem (18/10/2026)

O Python continua com as três; a nuvem diverge dele aqui de propósito.

- **Ficha de EPI: forma canônica v2** (`epi_ficha.VERSAO_FORMA_CANONICA`).
  Linha nova grava `forma: 2` e `requisicao_item` no evento; `conferir()`
  escolhe a versão pelo que o evento registrou. Backup do Python restaurado
  aqui confere pela v1, sem falso positivo.
- **Fila de pedidos de EPI**: o rascunho, sem `campus_id`, entra no escopo de
  unidade pelo campus ATUAL do servidor (cadastro) ou pela autoria
  (`epi_requisicao._no_escopo`). Antes aparecia para toda unidade.
- **Modelo de certificado**: publicar a versão nova pode levar junto os
  treinamentos que emitem com a atual (`repontar`, marcado por padrão), com
  um `TREINAMENTO_MODELO_REPONTADO` por treinamento.

## Simplificação para a implantação (19/10/2026)

O banco de produção nasce com uma única conta e nada cadastrado; a revisão de 19/10/2026 tirou as travas que impediam o primeiro uso, mantendo as de base legal (IN 15/2022, NR-6, LGPD) e as de integridade (trilha, ficha de EPI e estoque só por acréscimo, certificado com chave de validação).

### Acesso e administração

- **Superintendente operacional.** No Python ele "vê tudo e opera nada"; na nuvem tem tudo do coordenador_csso exceto `parecer.assinar` e `laudo.criar`, mais criar conta, redefinir senha e executar backup. Motivo: o banco de produção nasce com uma única conta, e o sistema ficava travado até ela se conceder outro perfil. Assinar e registrar laudo seguem exigindo perfil técnico e habilitação vigente (IN 15/2022, art. 10, §2º, I). O `semear_rbac` acrescenta as permissões ao banco existente no próximo deploy.
- **Ato normativo opcional.** O Python recusa concessão sem ato; na nuvem o ato em branco vira "Pendente — informado por <login> em dd/mm/aaaa", corrigível em Gerir. A portaria costuma sair depois da necessidade de acesso; a trilha registra quem concedeu e quando.
- **Encerrar concessão e corrigir ato** (não existe no Python): `POST /usuarios/atribuicoes/{id}/encerrar` (vigência termina ontem, porque inclui o último dia) e `POST /usuarios/atribuicoes/{id}/ato` (inclusive o "BOOTSTRAP"). Exigem `perfil.conceder` e são auditadas. Não se encerra a última concessão vigente de quem concede perfil.
- **Conta com perfil e servidor.** No Python nada grava `usuario.servidor_id`, e o escopo PRÓPRIO ("minha ficha de EPI", "meus certificados") ficava sem efeito. Na nuvem o cadastro aceita perfil, campus, ato e servidor no mesmo envio; em branco, vincula o servidor de mesmo e-mail. `POST /usuarios/{id}/servidor` vincula ou desvincula depois. Vincular exige `perfil.conceder` (quem vincula a conta a outro servidor passa a ler os dados dele) e um servidor fica em uma conta só.
- **Senha do backup fora da validação de subida.** Antes, produção sem `CSSO_BACKUP_SENHA` forte não atendia requisição nenhuma; agora recusa só o backup (rotina diária e botão de /config), com aviso na casca.
- **`npm run redefinir-senha -- --login X [--reativar]`** (não existe no Python): senha provisória, troca obrigatória, desbloqueio, sessões derrubadas, auditado com o ator "linha de comando". Para o superintendente único que esquece a senha.

### Treinamentos e certificados

- **Modelo genérico semeado.** `sementes.semear` cria, se não houver NENHUM modelo genérico, o "Padrão da casa" sobre `certificado_padrao_v1.docx` com os 23 marcadores mapeados (`MAPA_SUGERIDO`/`OBRIGATORIOS`, agora em `servicos/certificado.ts`). A semente roda no build de cada publicação, então o modelo chega ao banco de produção existente. O povoamento de teste usa a mesma função.
- **Tela de modelos.** O arquivo é escolhido numa lista do `manifesto.json`, não mais digitado. "Mapear sugeridos" mapeia num POST todos os marcadores ainda sem linha que têm sugestão (um `MODELO_TAG_MAPEADA` por tag).
- **Escolha do genérico e URL pública.** Com dois ou mais genéricos vigentes a emissão não para: usa o mais recente cujo mapa cobre o arquivo (se nenhum cobre, o mais recente, e a validação diz o que falta). `url_publica_declarada` aceita também a `URL` que o Netlify define.
- **Valores padrão.** Validade em branco no cadastro do treinamento vale 0 ("não expira"); na edição, apagar continua recusado. Assinatura de instrutor sem início de vigência vale "desde sempre" (gravada 2000-01-01; a coluna é NOT NULL), para que um curso dado no mês passado possa ser assinado. Sem servidores cadastrados, o formulário abre como "externo".
- **Instrutor padrão na turma.** `criar_turma` vincula o `instrutor_padrao_id` do treinamento quando a assinatura está ativa e vigente no início da turma.
- **Curso já realizado.** PLANEJADA → CONCLUIDA só com `data_fim` passada; PLANEJADA já iniciada aceita presença e nota. "Registrar turma já realizada" (datas passadas, sem presença lançada) marca, numa transação, todos presentes pela carga inteira (vários dias: carga repartida em décimos de hora) e conclui com a apuração; evento `TURMA_REALIZADA_REGISTRADA`. Com nota mínima, só lança a presença, passa a turma a em andamento e pede as notas.

### Processos, pareceres e demandas

- **Máquina por tipo de processo.** No Python todo processo percorre a cadeia do adicional ocupacional e só sai da triagem com PORTARIA e FORMULÁRIO anexados — um PGR nunca concluía. Na nuvem a cadeia longa e os requisitos da IN 15/2022 valem só para o adicional ocupacional (aposentadoria especial fica de fora: a base é LTCAT/PPP). Os demais tipos (PGR, RITS, acidente, consulta…) andam pela máquina curta: recebido → em andamento (EM_TRIAGEM, que o quadro mostra na coluna "Em andamento") → concluído, com pendência de documento, ida e volta e reabertura; sobrestar vale de qualquer estado não final. Processo de tipo curto parado num estado da cadeia longa sai para a máquina curta.
- **RECEBIDO com as saídas da triagem.** O clique RECEBIDO → EM_TRIAGEM não registrava fato e virou opcional.
- **Salto na cadeia longa.** O processo de adicional avança vários estados num só movimento (inclusive arrastando no quadro para coluna não vizinha) quando os requisitos de saída dos estados pulados estão cumpridos; senão a mensagem diz o que falta. Desvio (pendência, indeferimento, arquivo) continua um passo só, e soltar em "Concluído" nunca arquiva nem indefere.
- **Parecer move o processo.** Emitir o parecer leva o processo a PRONTO_P_ASSINATURA e assinar a ASSINADO, se ele estiver atrás, auditado; requisito de saída faltando vira aviso, não erro.
- **Rascunho de parecer pré-preenchido.** Signatário: a habilitação vigente de quem cria; senão, a única vigente. Tipo de movimento: concessão.
- **RN-21 como aviso fora do parecer e do laudo.** Na demanda, no pedido de EPI e na observação/comentário do processo, termo de saúde ("gestante", "doença"…) mostra aviso e passa com a confirmação "a menção é necessária", que vai para a trilha (um evento por campo). No parecer e no laudo continua recusado; CPF e CID são recusados em todo contexto.
- **Demandas.** "Quem demandou" em branco vale o nome do servidor escolhido, ou "não identificado". Encerrar como RESOLVIDA dispensa o relato (grava a frase-padrão; "sem providência" continua pedindo o motivo). Encerrar como VIROU_PROCESSO cadastra o processo ali mesmo (NUP + tipo, com a confirmação do dígito), na mesma transação.
- **Autoridade destinatária e setor emissor em /catalogos.** Antes só existiam na semente. Troca de gestão é registro novo com vigência, não edição: o parecer emitido guarda o destinatário da data dele.

### EPI e servidores

- **Carga de servidores por planilha** (`/servidores`, .csv ou .xlsx; colunas SIAPE; Nome; Cargo; UORG; E-mail e Campus opcionais), com modelo para baixar e prévia por linha antes de gravar (a prévia roda o mesmo código e desfaz a transação). Chave: SIAPE — reimportar só atualiza. Cargo desconhecido é criado; UORG desconhecida só é criada no formato do SIAPE ("250 - NOME") com campus resolvido, senão o servidor entra sem lotação e a linha avisa. Lotação de quem já existe muda pelo histórico. Um evento na trilha por importação, com as contagens.
- **Cadastrar servidor na hora.** Na entrega e no pedido de EPI, a busca sem resultado oferece cadastrar (SIAPE + nome) e volta ao fluxo.
- **"Aprovar tudo como pedido"** no pedido de EPI: inicia a análise, aprova cada item na quantidade pedida e conclui, numa transação, cada passo auditado como antes; RN-28 continua valendo.
- **CA no catálogo.** A caixa "exige CA" ficou visível com a dica para itens sem CA; a recusa de entrega por falta de CA aponta para a edição do item. A entrega direta (sem pedido) é a primeira opção da tela de EPI.

### Certificado em PDF com QR (19/10/2026)

- **PDF sem LibreOffice.** O Python converte o .docx com o `soffice`; a nuvem não o tem (`pdf.ts`). O PDF passou a ser desenhado com o pdf-lib (`servicos/certificado_pdf.ts`) a partir do contexto CONGELADO, com o mesmo texto do `certificado_padrao_v1.docx`: frente com emissor, certificação, local e data, rubrica e assinante, instrutores e rodapé com número, validade, endereço, chave e o QR; verso com o conteúdo programático, quando há. Carta paisagem, como o .docx; Helvetica padrão (caractere fora do WinAnsi sai "?"). O layout é o da casa e não segue um modelo personalizado — para esse, o .docx continua sendo a fonte.
- **Não é gravado.** Sai na hora: `GET /certificados/{id}/pdf` e `GET /turmas/{id}/certificados.pdf` (todos os vigentes da turma num arquivo). Os dois passam pela segunda via (regra de leitura, conferência do texto contra a emissão, `CERTIFICADO_SEGUNDA_VIA` na trilha). A emissão deixou de dar o aviso "PDF indisponível".
- **QR.** Nível M, desenhado em vetor no PDF, abre `/validar/{chave}`. O marcador `certificado_qrcode` (que no Python "chegava na fatia 5") agora rende a imagem PNG de 25 mm no .docx de quem o mapear; o modelo padrão não tem esse marcador.

## Telas mais objetivas (19/10/2026)

Revisão do frontend em produção (itens 2 a 7):

- **Módulos à vista**: o seletor suspenso de módulo deu lugar a uma lista lateral com todos os módulos disponíveis para a conta; o atual abre seus itens logo abaixo. Módulos "em breve" saem do menu.
- **Primeiros passos**: `/turmas` vazia (para quem cria turma) e o painel de EPI com catálogo vazio mostram um cartão com a sequência de cadastro, marcando o que já foi feito.
- **Itens do titular** ("Minha ficha de EPI", "Meus treinamentos", "Meus certificados") só aparecem para conta vinculada a um servidor.
- **"Assinaturas" virou "Instrutores"** no menu e na tela; a vigência em branco é explicada como "desde sempre".
- **Nomes legíveis**: perfis com acento (a semente atualiza `perfil.nome` existente) e habilitações pelo rótulo, não pelo código; o painel de EPI deixa de citar "RN-32".
- **Código do treinamento opcional**: o formulário começa pelo nome; código em branco é gerado do nome (ASCII, maiúsculas, até 26 caracteres, sufixo `_2`, `_3`… se repetir). Continua imutável depois.
- **Habilitação ligada à conta**: `POST /habilitacoes/:id/conta` (exige `habilitacao.atestar`) define ou limpa `profissional_habilitado.usuario_id`, com trilha `HABILITACAO_VINCULADA` / `HABILITACAO_DESVINCULADA`. Sem conta ligada o profissional não assina parecer, e a tela de usuários diz isso.

## Desempenho: idas ao banco (19/10/2026)

A função do Netlify roda em Ohio e o banco em São Paulo (~150 ms por ida e volta); as telas levavam de 2 a 25 s. A causa não era o volume de dados, era o número de idas:

- **Consulta preparada.** O Drizzle chama `sql.unsafe`, que no postgres.js sai com `prepare: false`: cada consulta com parâmetro custava DUAS idas (descreve, executa) e não seguia em paralelo com outra. `db/cliente.ts` passa `prepare: true` em todo `unsafe` (inclusive no da transação e do savepoint) — salvo na porta 6543, o pooler em modo transação, que não aceita *prepared statement*. Produção passa a usar o pooler em modo sessão (porta 5432). A conexão ociosa dura 2 min (era 20 s) para as consultas preparadas sobreviverem entre um clique e outro.
- **Casca numa ida só.** Sessão, conta, perfis, habilitações e o sino eram cinco idas em sequência; agora saem juntas (`autenticacao.conta_da_sessao` é a conta como subconsulta da sessão; a identidade só vale se a sessão valer). O sino lê as pendências abertas sem recorte e recorta em memória, com a mesma regra de `no_escopo`.
- **Cartão de processo em lote.** `processo.resumir_varios` faz SLA, tipo, anexos e checklist de N processos em quatro consultas paralelas — o painel fazia quatro por processo (101 consultas). O pós-filtro de `/processos` deixa de ler pareceres quando nenhum filtro de parecer foi pedido.
- **Leituras independentes em paralelo** (`Promise.all`) no painel, na lista e na ficha de turma, no painel de EPI e na ficha de processo.

Medido localmente com 70 ms de atraso em cada sentido (`testes/idas_ao_banco.test.ts` fixa o teto de consultas por tela): o conjunto de 22 telas foi de 110 s para 28 s (instância aquecida); o painel, de 25 s para 1 s.

## Modelo de certificado enviado pela tela (20/10/2026)

No Python o .docx de certificado entra em `app/templates/certificados/` pela mão de quem programa; aqui ele também pode vir pela tela de modelos (`servicos/modelo_certificado_envio.ts`). Os embutidos de `modelos-docx/certificados/` continuam funcionando como antes.

- **Upload**: multipart, até 4 MB (o teto do anexo — o corpo da função do Netlify para em 6 MB); só `.docx` que abre como zip com `word/document.xml`, sem macro, até 60 MB descompactado. Recusa com mensagem para quem não programa (PDF, `.doc`, arquivo sem marcador, chave `{`/`}` solta, `{% %}`).
- **Dois formatos de marcador**: `{{ nome }}` (o do sistema) e `«texto livre»` (o dos modelos que o setor preenchia à mão). O texto de cada parágrafo é juntado antes da busca, então marcador partido em vários runs do Word é achado; o convertido grava `{nome}` num run só.
- **Uma ocorrência, um marcador.** «x» vira `x` em ASCII minúsculo com `_` (vazio ou começando por dígito ganha `campo_`); a 2ª ocorrência de algo que daria o mesmo nome vira `x_2`, a 3ª `x_3`, na ordem do documento (corpo, cabeçalhos, rodapés). Motivo: o mesmo texto significa coisas diferentes no mesmo modelo («000.000.000-00» é o CPF do participante e o do responsável; «DD/MM/AAAA», início e fim). O rótulo original e um trecho de ~60 caracteres antes e depois ficam guardados e aparecem na tela para dizer qual é qual. `{{ x }}` repetido continua sendo um marcador só.
- **Coluna nova** `certificado_modelo.arquivo_enviado` (jsonb; migração `0006_modelo_certificado_enviado`): SHA-256 do convertido, tamanho e a lista de marcadores com rótulo/trecho/ocorrência. NULL = embutido (vale o `manifesto.json`). `arquivo` guarda o nome como chegou e `arquivo_sha256` o SHA-256 do arquivo enviado.
- **Armazenamento**: o convertido mora em `anexos/<sha[:2]>/<sha>` — o endereçamento do blob de anexo, sem linha em `anexo` —, e por isso `backup._chaves_de_arquivo` o inclui no backup completo, no diário e na exportação; a restauração já devolve tudo o que está sob `anexos/`.
- **Emissão**: o contexto congelado ganhou `modelo_chave` (a chave do convertido; null = embutido). A segunda via abre o arquivo pela chave congelada; como o endereço é o conteúdo, publicar outro .docx nunca muda papel já emitido. Certificado antigo, sem a chave, segue no embutido.
- **Mapa**: a ficha lista um marcador por linha (rótulo, trecho, seletor do campo, "vazio bloqueia", situação) e salva tudo num POST (`/treinamentos/modelos/{id}/mapa`; um `MODELO_TAG_MAPEADA` por linha nova, diff na troca, `MODELO_TAG_REMOVIDA` ao esvaziar). O seletor lê `CAMPOS_CERTIFICADO` a cada vez: campo novo aparece sozinho.
- **Sugestão** (`sugerir_campo`): nome igual a campo ou ao `MAPA_SUGERIDO`; regras pelo texto («DD/MM/AAAA» 1ª = início, 2ª = fim; «nº» = número; «AAAA» = ano; «Cidade»…); para «___ %» e «000.000.000-00», o texto logo antes (nota × frequência; CPF do participante na 1ª, do assinante depois — só se o vocabulário tiver campo com `cpf`); por fim, semelhança de palavras com rótulo e código do campo (metade das palavras do marcador). "Aplicar sugestões" grava só os sem dado.
- **Vocabulário**: `certificado_dia` e `certificado_mes_extenso` (o «DD» de «mês» de «AAAA»), `turma_campus` (já ia no congelado) e `em_branco` ("Deixar em branco": o marcador que o setor decidiu não preencher, como as notas por disciplina; nunca bloqueia a emissão).
- **"Baixar exemplo preenchido"** (`GET /treinamentos/modelos/{id}/exemplo`): o .docx com o `exemplo` de cada campo; marcador sem dado sai "[falta: rótulo]". Não grava nada nem entra na trilha (não há dado pessoal).
- **Versão nova** pode trazer outro .docx; vai junto só o mapa dos marcadores que o arquivo novo ainda tem. O arquivo enviado não se troca na edição do modelo.
## Campos do certificado além do sistema (19/10/2026)

Não existe no Python. O modelo de Brigadista Orgânico pede dados que o sistema não tem (local de atuação, nota de cada disciplina, carga em "tempos"); criar coluna para cada curso não escala.

- **Preenchimento do marcador** (`certificado_modelo_tag.tipo`): `SISTEMA` (o `campo` do vocabulário, como antes), `TEXTO_FIXO` (`texto_fixo`, digitado na ficha do modelo, igual em todo certificado), `TURMA` e `PARTICIPANTE` (o modelo declara o `rotulo`; o valor é digitado na aba Emissão da turma, por turma ou por inscrição). Fora de `SISTEMA`, `campo` fica `''`. `CertificadoModelo.mapa_de_tags` passou a devolver só os campos do sistema; a conferência com o .docx usa `marcadores_mapeados` (todas as linhas).
- **Valores** em `certificado_valor_turma` e `certificado_valor_inscricao`, com chave no MARCADOR (não na linha do dicionário): a versão nova do modelo clona o dicionário com tipo, texto e rótulo (`/treinamentos/modelos/:id/versao`), e o que as turmas já digitaram continua valendo. Migração `0006_campos_livres_certificado`.
- **Congelado**: a emissão resolve tudo em `ContextoCertificado.campos_livres` (`{marcador: {tipo, rotulo, valor}}`); a segunda via e o hash leem dali. Certificado antigo, sem a chave, reimprime igual.
- **Recusa**: campo obrigatório em branco entra nos bloqueios de `validar` ("falta preencher “…” da turma/deste participante"), na coluna "O que falta" da aba Emissão; o lote trava só quem não tem o valor.
- **Quem preenche**: campo da turma, `turma.criar` ou `certificado.emitir`; campo do participante, `turma.avaliar` (a regra da nota final), recusado quando a inscrição já tem certificado válido (anula e reemite). A grade da aba Emissão mostra o participante pela mesma regra RN-19 da tabela de emissão. Cada alteração vai para a trilha (`CERTIFICADO_CAMPO_TURMA_ALTERADO`, `CERTIFICADO_CAMPO_PARTICIPANTE_ALTERADO`; a do participante leva o identificador público, não o nome) e a aba mostra "Alterações nestes dados", com o ator pela RN-19.
- **Campos de sistema novos**: `turma_campus` (nome do campus da turma) e `turma_campus_cidade` (também congelado).
- **PDF**: o layout da casa (`certificado_pdf.ts`) não desenha os campos livres — para modelo personalizado o .docx continua sendo a fonte.
- O povoamento de teste põe um campo de turma e um de participante (opcionais) no modelo "Padrão NR-35", para a varredura de privacidade passar pela grade.
## CPF só para certificado (19/10/2026)

Decisão do dono do sistema: "guardar CPF só para certificado". O certificado de Brigadista Orgânico (norma do CBMMG) traz o CPF do participante e o do responsável pela formação. O Python não guarda CPF em lugar nenhum; a nuvem passa a guardar nestes dois pontos, e só neles. Base legal: LGPD art. 7º, II (obrigação regulatória do CBMMG para o certificado) e art. 23; registro em `docs/ROPA_NUVEM.md` §5.5.1.

- **Onde mora.** `participante.cpf` e `assinatura_instrutor.cpf` (migração `0006_cpf_certificado`), opcionais, só dígitos, com CHECK de formato. No participante e não em `servidor`: o participante é uma linha por pessoa (servidor ou externo), então serve aos dois casos sem cópia, e o cadastro de servidor — o mais exposto — continua sem CPF. Instrutor interno que também faz curso tem os dois registros (papéis diferentes; nenhum lê o outro).
- **Entrada.** Só pelo campo `cpf_certificado` (`dependencias.CAMPO_CPF_CERTIFICADO`), o único nome acrescentado a `INTOCAVEIS`, que escapa da máscara de `semCpf`; todo outro campo continua mascarado. Dígito verificador conferido (`textos.cpf_digitos`); recusa sem eco do número. Em branco não mexe; apagar é caixa própria. Quem altera: `turma.inscrever` (participante — popup "CPF" na aba Inscrições e campo no cadastro de externo) e `assinatura.gerenciar` (tela Instrutores).
- **Exibição.** Nenhuma tela mostra dígito: só `***.***.***-**` ou "não informado" (`cpf_certificado.exibir`; `tem_cpf`/`cpf_exibicao` nas vistas). Fora de lista, busca (o CPF não é chave de busca), CSV, API (que continua mascarando o corpo) e log. A trilha (`PARTICIPANTE_CPF_ALTERADO`, `ASSINATURA_INSTRUTOR_CPF_ALTERADO`) diz "CPF informado/substituído/apagado", sem o valor; o CPF fica fora do `salvar_com_diff` da edição do instrutor, que gravaria antes → depois.
- **Certificado.** Campos novos no vocabulário: `participante_cpf` e, no grupo "Responsável pela formação" (o instrutor principal = o primeiro que assina, o mesmo de `assinante_*`), `instrutor_nome`, `instrutor_titulo`, `instrutor_registro`, `instrutor_cpf`; o CPF sai formatado `000.000.000-00`. **Minimização:** o CPF só é congelado (`participante_cpf`, `instrutores[0].cpf`) quando o modelo do treinamento mapeia o campo; nos demais certificados o congelado fica sem ele. Congelado, não muda com o cadastro (RN-15). Marcador obrigatório sem CPF no cadastro bloqueia a emissão, como qualquer outro.
- **PDF.** O layout da casa (`certificado_pdf.ts`) acrescenta ", CPF 000.000.000-00" ao parágrafo do participante e uma linha discreta "CPF …" sob o assinante — só quando o congelado tem o CPF, isto é, quando o modelo o pede. Assim o PDF do brigadista sai completo sem levar CPF aos demais certificados.
- **Validação pública** (`/validar/...`) não mostra CPF (mostra só nome e título do instrutor, como antes); a ficha do certificado diz só que há CPF congelado, mascarado.
- **Exportação em claro** (`/config/exportar-tudo`) sai sem o CPF (colunas nulas, chaves tiradas do congelado — `cpf_certificado.sem_cpf_no_dump`); o backup cifrado leva tudo.
- **`ferramentas/procurar-cpf.ts`** passa a ignorar as duas colunas e o CPF do congelado do certificado; o resto do banco continua tendo de dar zero.
- **Testes.** `testes/privacidade_cpf.test.ts` (entrada, máscara, trilha, congelamento, PDF, validação pública, exportação, nenhum template imprime `.cpf`) e, em `privacidade_varredura.test.ts`, todo participante e instrutor do ambiente povoado ganha CPF e nenhum GET (de coordenador, secretaria, `sem_nominal` e titular) o devolve fora de `/certificados/{id}/documento|pdf` e `/turmas/{id}/certificados.pdf`.
- **Pendências.** Não há expurgo automático do CPF (o expurgo do participante externo ainda não foi portado); apagar é manual. O modelo do brigadista precisa mapear `participante_cpf`/`instrutor_cpf` para que o CPF saia.

## Paridade com o IntegraSST (20/10/2026)

Nada disto existe no Python. Saiu da comparação, função por função, com o módulo de Certificados e Inscrições do IntegraSST. Cada item tem teste em `testes/` (`certificados`, `treinamentos`, `turmas`, `email`).

- **Rubrica do instrutor pela tela** (`POST /treinamentos/assinaturas/:id/rubrica`): PNG ou JPEG, conferido pelos primeiros bytes e não pela extensão, guardado como anexo `RUBRICA_INSTRUTOR`. A emissão já lia a imagem; faltava a porta de entrada.
- **Monitor de reciclagem** (`/certificados/vencimentos`, `servicos/reciclagem.ts`): o certificado em vigor (o último emitido, não anulado) de cada pessoa em cada treinamento, com a situação Vencido, A vencer em 30 dias ou Válido. A varredura noturna abre a pendência `CERTIFICADO_A_VENCER`, sem responsável e sem nome, só para quem **entra** na janela; ela se fecha sozinha quando a pessoa se recicla ou o certificado é anulado.
- **Inscrição em lote** (`/turmas/:id/inscricoes/lote`, `servicos/inscricao_lote.ts`): a lista colada da planilha, com cada célula reconhecida pelo conteúdo. «Conferir» é um savepoint desfeito; «Inscrever» grava cada linha no seu savepoint, até 300 linhas. CPF, telefone e cargo são lidos e descartados com aviso; o nome só casa para quem pode ver nomes.
- **Indicadores de treinamento** (`/treinamentos/indicadores`): o recorte é a turma (período pela data de início, setor promotor); contagens de pessoas abaixo de 5 suprimidas pela RN-19 para quem não vê nomes, como em `/relatorios`.
- **Fila de emissão entre turmas** (`/certificados/fila`, `servicos/fila_emissao.ts`): a etapa de cada inscrição. «Travado» usa a mesma validação da emissão, com os motivos dela. Emitir os marcados agrupa por turma em `emitir_lote`. Na etapa Emitidos, «Enviar por e-mail os marcados».
- **Descrição do evento** (`turma.descricao`, migração `0007`): texto livre, com «usar a da última turma deste treinamento», e campo de certificado `turma_descricao`.
- **Busca de `/certificados`** (`filtro_da_busca`): além da chave inteira, o número `12/2026` e, palavra por palavra, o nome congelado ou o atual, o SIAPE, o `PTC-…`, a turma e o treinamento. Sem acento por `translate()`, porque o Supabase não tem `unaccent` ligado. CPF não é busca e a tela avisa.
- **Inscrição pública por link** (`/inscricao/:token`, `servicos/inscricao_publica.ts`, migração `0008`):
  - O desenho da fatia 6 confirmava por e-mail. Aqui a trava é a **conferência da CSSO**: o pedido nasce `AGUARDANDO_EMAIL` («pedido pelo link, a conferir»), não ocupa vaga, abre a pendência e só vira `INSCRITA` quando alguém com `turma.inscrever` o aceita (`conferida_por`/`conferida_em`).
  - A CHECK `ck_inscricao_email_confirmado` passou a aceitar a conferência e a recusa (`CANCELADA`).
  - O token de 192 bits é mostrado uma vez; fica só o SHA-256 e ele expira no fim do dia de «inscrições até».
  - Resposta pública única (sem oráculo); SIAPE ou e-mail só ligam a um cadastro existente se o nome conferir.
  - Limite por IP, teto de 200 pedidos em espera, campo-armadilha, sem CPF. O IP sai em 90 dias.
- **Envio de e-mail** (`servicos/email.ts`, `envio_certificado.ts`, `avisos_inscricao.ts`, migração `0009`):
  - O Python registrava «sem SMTP». Aqui há uma caixa de saída (`email_saida`) e qualquer SMTP (`CSSO_SMTP_URL`, `CSSO_EMAIL_REMETENTE`).
  - Quem envia é a função de fundo `email-background`, acordada no pedido e que olha a fila de novo por um minuto, porque o pedido ainda não deu COMMIT quando ela chega. De reserva, a agendada `email-agendado`, a cada 10 min.
  - Posse da linha por `proxima_tentativa_em` com `SKIP LOCKED`; até 5 tentativas com espera crescente.
  - O anexo do certificado é montado na hora, como segunda via de quem pediu (`carregar_usuario_atual` do `criado_por`).
  - O texto sai em 90 dias. **Desligado em produção até o SMTP ser configurado.**
- **Acesso do participante sem conta** (`/certificados/acesso`, `servicos/acesso_participante.ts`, migração `0010`):
  - Um link de 2 h vai ao e-mail **já cadastrado**; ele lista e baixa os certificados emitidos de todo participante com aquele e-mail.
  - A segunda via é `segunda_via_do_titular`, sem usuário na trilha.
  - Até 3 links por hora por endereço, mais o limite por IP; o registro sai em 7 dias.
  - Limite conhecido: e-mail não confirmado em duplicata mostra os certificados das duas linhas (ROPA §5.10).
- **Aviso de reciclagem por e-mail** (`servicos/aviso_reciclagem.ts`): um por certificado. Ou marcado no monitor (`certificado.emitir`), ou automático na varredura, no dia em que o certificado entra na janela. O automático depende do parâmetro `reciclagem.aviso_email_automatico`, desligado de saída e ligado só por `treinamento.gerenciar`, com trilha.

**Ficou de fora, por decisão:** RG (LGPD) e WhatsApp ou telefone do participante (a lista em lote os descarta com aviso). **Diferente de propósito:** PDFs no Storage, e não em pasta do Drive; a data é gerada do início e do fim, e não texto livre; emitir é um passo só (número e chave), com o e-mail à parte.

## Corrigir e excluir (20/10/2026)

- **Corrigir certificado** (`POST /certificados/:id/corrigir`, `servicos/retificacao.ts`). O Python só anulava; a reemissão era outro passo, na turma, e o vínculo `substituido_por_id` existia sem tela que o preenchesse.
  - Aqui é **um ato**: grava a correção no cadastro do externo (nome, vínculo, organização, CPF do certificado), anula o antigo com o motivo «Retificação: …», emite o substituto com número e chave novos e aponta o antigo para ele.
  - Tudo num savepoint: se o substituto travar (assinatura fora da vigência, modelo quebrado), nada muda.
  - O certificado continua imutável. A página pública da chave antiga diz «anulado» e o **número** do substituto (a chave dele não, porque é do titular).
  - Nome de servidor não se corrige aqui: ele mora no cadastro de servidores, com permissão própria. A tela aponta para lá.
  - A trilha registra que o nome foi corrigido, mas não qual era (RN-19 na escrita). O nome antigo fica no congelado do certificado anulado.
  - Permissões: `certificado.anular` **e** `certificado.emitir`.
- **Corrigir o participante pela inscrição** (`POST /turmas/:id/inscricoes/:iid/participante`, `turma.inscrever`): nome, vínculo e organização do externo, para o que ainda vai sair. Se a pessoa já tem certificado emitido, a resposta avisa que ele continua com o dado antigo.
- **Excluir turma** (`POST /turmas/:id/excluir`, `turma.concluir`, com motivo). O Python só cancelava. A exclusão vale só para a turma **planejada ou com inscrições abertas** que não tem:
  - presença ou nota;
  - certificado, mesmo anulado;
  - e-mail enviado a inscrito;
  - pedido do próprio participante (link público ou «inscrever-me»).

  As inscrições lançadas pela CSSO, os instrutores vinculados e os campos do certificado saem em cascata. As tarefas abertas sobre a turma são fechadas e o e-mail ainda na fila é cancelado. O código não volta para a sequência; a trilha guarda o retrato e o motivo. A turma com história continua se cancelando.
- **Excluir treinamento e instrutor** (`POST /treinamentos/catalogo/:id/excluir`, `/treinamentos/assinaturas/:id/excluir`, `servicos/exclusao_cadastro.ts`): só o que nunca serviu a turma.
  - O treinamento não pode ter turma, certificado nem modelo próprio.
  - O instrutor não pode estar em turma. Se ele era o instrutor padrão de algum treinamento, o treinamento só perde a sugestão.
  - O resto se desativa, como antes.
- **Corrigir turma concluída** (`POST /turmas/:id/retificar`, `retificacao.retificar_turma`, `turma.concluir`, com motivo). No Python, turma concluída não se editava.
  - Aqui se corrige o que sai no papel: período (no mesmo ano), carga, local, campus, unidade promotora, data base, descrição e observações.
  - Vagas, prazo de inscrição, nota e frequência mínimas ficam de fora, porque mudariam quem passou.
  - Travas: o período novo tem de conter todo dia de presença lançado, e a carga nova não pode mudar o resultado de quem já tem certificado em vigor.
  - Sem certificado, a carga nova recalcula a frequência e o resultado (`presenca.reapurar_inscricao`, com `RESULTADO_RETIFICADO`).
  - Os certificados emitidos não mudam.
- **Reemitir os certificados da turma** (`POST /turmas/:id/certificados/retificar`): cada certificado em vigor passa pela `retificar` de sempre, cada um no seu savepoint. O que trava fica como estava, e o relatório diz qual e por quê.
- **Juntar cadastros** (`/treinamentos/participantes`, `servicos/mesclagem.ts`, permissão nova `participante.mesclar` nos perfis com `certificado.anular`).
  - A fatia 6 do desenho previa a mesclagem; o esquema (`mesclado_em_id`, origem `MESCLAGEM`) já existia, mas faltava o código.
  - Inscrições, certificados (`participante_id` e `servidor_id`) e e-mails passam para quem fica. O absorvido aponta para ele, sai das listas e perde o CPF.
  - O congelado e a chave de cada certificado não mudam.
  - Recusa: dois servidores, CPFs diferentes, os dois na mesma turma, e servidor como absorvido (o cadastro de servidor é sempre o que fica).
  - A tela sugere os possíveis duplicados (mesmo nome sem acento e sem partícula, ou mesmo e-mail) e tem busca para os nomes que não batem.

## Aparência do IntegraSST e o fluxo do link (21/10/2026)

O pedido foi deixar o sistema com a cara do IntegraSST e fechar o que ainda faltava no fluxo do link público. A comparação, feita sobre o código baixado do Apps Script (`entrada/integrasst`, fora do git), achou o resto do módulo coberto.

- **Tema** (`public/estaticos/css/tema.css`, carregado depois de `csso.css`): fonte Inter, o verde-azulado do IntegraSST, cantos de 8 a 14 px, sombra macia, lateral em ardósia com o item ativo preenchido, títulos de página coloridos e popup com cabeçalho escuro. `csso.css` continua sendo a estrutura; trocar a aparência é trocar um arquivo.
  - O verde do IntegraSST (`#0d9488`) dá 3,7:1 com branco. Ele ficou para ícone, borda e barra; texto e botão usam `#0f766e` (5,5:1).
- **Ícones** (`public/estaticos/img/icones.svg`): os mesmos Bootstrap Icons (MIT), numa folha de símbolos servida pelo sistema, porque a CSP é `'self'` e fonte de ícone por CDN não carrega. A lista fica em `ferramentas/icones.txt`, e `node ferramentas/gerar-icones.mjs` refaz a folha. O ícone de cada tela está em `modulos.ts` (`ICONES`, global `icone_de`); no template, `ui.icone('nome')`.
- **Início do módulo** (`/treinamentos`, `servicos/hub_treinamentos.ts`, `certificado.ver`): o "Centro de Certificações e Inscrições", com os 4 passos e os cartões numerados. Cada cartão traz a contagem da tela de destino (fila de emissão, monitor de reciclagem, caixa de e-mails, pedidos a conferir), calculada pela mesma função dela. É a porta de entrada de quem opera; o servidor comum continua entrando por `/turmas`.
- **Pedidos pelo link** (`/turmas/pedidos`, `servicos/pedidos_link.ts`, `turma.inscrever`): os pedidos a conferir de todas as turmas, agrupados, para aceitar ou recusar marcando de uma vez. Na ficha da turma há também «Aceitar os N pedidos». Cada pedido roda a regra de sempre (`mudar_situacao_inscricao`, com a vaga conferida sob trava) no seu savepoint; quem não coube fica a conferir, com o motivo. No IntegraSST o link inscrevia sem conferência; a trava da CSSO (fatia 6) continua.
- **Turma lotada fecha o link** (`inscricao_publica.turma_do_token` e `pedir`). Antes a pessoa recebia «pedido recebido» e a recusa só aparecia no aceite. Conta só quem já foi aceito, porque o pedido em espera não ocupa vaga.
- **Abrir a turma já com link** (o choice-card do IntegraSST): no «Abrir turma», «Aberta com link público» cria a turma em inscrições abertas e gera o link num savepoint só (tudo ou nada). Exige «inscrições até».
- **Tela do link**: «Copiar link» (`data-copiar` em `csso.js`, que nasce oculto e funciona sem JavaScript), «Abrir o formulário», «Baixar o QR (PNG)» e uma mensagem pronta para o grupo ou o e-mail. O link continua aparecendo uma vez só.
- **Lista de turmas**: o instrutor e o setor promotor na linha, os pedidos a conferir como pílula, «link no ar até…» ou «prazo de inscrição acabou», ações rápidas (inscrições, presença, emissão) e o filtro por setor promotor.
- **Cartaz público**: instrutor, setor promotor e o aviso de que o nome sai no certificado como for digitado.
- **Ficou como estava, de propósito:** a validação pública continua sem mostrar nome, nota ou PDF (`validacao_certificado.ts`), e inscrição não se apaga, só se cancela com motivo.

## Correções do teste completo (21/10/2026)

O teste completo do sistema achou 71 defeitos e sugeriu 87 melhorias de tela. As correções foram feitas por lotes em paralelo (casca e visual; processos, quadro e painel; pareceres, laudos, adicionais e pendências; EPI; turmas e inscrições; certificados, treinamentos e validação; base e administração) e integradas no fim. Ficaram de fora, de propósito, a saída nominal do parecer (D1, ver abaixo) e a montagem dos perfis por blocos (M86): cada perfil tem a sua base normativa e as permissões dele continuam listadas uma a uma, porque um bloco compartilhado concederia permissão a vários perfis sem ninguém perceber, e `semear_rbac` levaria isso às contas de produção no próximo deploy. A leitura da matriz melhorou pela tela (/perfis em português, M75), sem mexer nela.

### A casca

- **Menu do servidor comum («Meu espaço»).** Quem tem só escopo próprio (todos os perfis em `ESCOPO_PROPRIO`, como `servidor_consulta`) já não recebe a lateral da equipe. Recebe um bloco único (`src/modulos.ts`, `MEU_ESPACO` e `meu_espaco_de`): Início, Meus treinamentos, Meus certificados, Minha ficha de EPI, Meus pedidos de EPI, Pedir EPI, Meu adicional, Meus processos e Meus dados (`/servidores/{servidor_id}`). Cada item declara a permissão que a rota exige, e os itens do titular só aparecem para quem tem servidor vinculado. O RBAC das rotas não mudou, só o que o menu oferece. Kanban, Laudos, Catálogos, a lista de Servidores, Estoque, Módulos e a engrenagem saem do menu dele. A trilha usa os nomes deste menu, e `/epis/fichas/{o próprio id}`, para onde «minha ficha» redireciona, aparece como «Minha ficha de EPI». O item Pendências passou a usar `pendencias.PERMISSOES_VER`, a mesma tupla da rota, no lugar de uma cópia que já tinha divergido (faltava `demanda.ver`). Perfil sem escopo declarado não derruba a casca: o menu cai no da equipe (filtrado pela permissão), e a consulta no escopo nega com a tela que nomeia o perfil (`EscopoNaoDeclarado`).
- **Engrenagem e sino.** A engrenagem de /config aparece para `processo.editar`, `catalogo.gerenciar` ou `backup.executar`, a mesma tupla de `PERMISSOES_CONFIG`; `processo.ver` deixou de bastar, porque é a permissão de leitura do servidor comum e do auditor. O sino conta só as pendências cujo responsável é a própria conta e leva a /pendencias?minhas=1; a fila do setor continua em /pendencias.
- **Ações da tela.** O bloco `acoes_cabecalho` saiu do cabeçalho de 62px para a faixa `.acoes-pagina`, logo abaixo dele, porque com dois botões o cabeçalho quebrava em 81px a 1366px. Abaixo de 900px a lateral fica só com a marca e um botão «Menu»: um `<details>` sem JS, irmão dos blocos da lateral, que um `:has` esconde enquanto o menu está fechado (um `<details>` envolvendo a lateral não serviria: fechado, ele não desenha o conteúdo, e na mesa a lateral precisa ficar aberta). No celular, a rolagem interna das listas some. O campo `.oculto` tem 1px de largura também quando é input de texto; antes ele herdava `width:100%` e esticava a página.
- **Peças compartilhadas.** `table.empilhavel` (cada linha vira cartão no celular, com `td[data-coluna]` e `td.acao-linha`), `.tabela-cartao.sem-altura`, `.grade-resumo`, `details.recolhido`, `tr.linha-atencao`/`linha-anulada`, `.botao-icone`/`.acao-rotulada`. No `csso.js`: `data-mostra-quando` (tira o `required` do campo oculto e o devolve quando ele reaparece), `data-marca-grupo`/`data-grupo`, `data-barra-lote`/`data-conta-grupo` (a barra de lote e o contador, que eram `<script>` na lista de processos), `data-nup-dispensa` e `data-cnpj`.
- **Popup sobre popup.** O `Esc` fecha o popup de CIMA (a confirmação aberta sobre a gaveta «Gerir»), e não o primeiro do documento; quem abriu cada um fica numa pilha, e o foco volta ao botão de dentro da camada de baixo.
- **Tela de bolso.** O service worker deixou de guardar /celular, e a rota responde com `cache-control: no-store`: a página leva o nome de quem entrou e ficava no disco do aparelho depois de sair. Sem rede, o worker responde uma página fixa, sem dado pessoal. O cache subiu para a v3, e a ativação apaga a v2. Para quem não tem balcão nem chamada, /celular mostra atalhos e já não cita códigos de permissão.
- **«Somente leitura» sem código.** A pílula diz a permissão que falta pelo texto de /perfis (`texto_permissao`), e não pelo código interno.
- **Erro de link abre a tela.** Um GET com `Accept: */*`, sem HTMX nem fetch e fora de /api, recebe a tela de 403/404, e não JSON.

### Processos, quadro e painel

- **Estados do parecer só com o parecer (corrige o salto).** «Laudo emitido» exige laudo do processo: vinculado a ele, usado por parecer dele ou VIGENTE da unidade, o mesmo critério do atalho de reúso. «Parecer pronto para assinatura» exige parecer EMITIDO ou ASSINADO. «Parecer assinado», «Inserido no SEI» e «Concluído» (cadeia do adicional) exigem parecer ASSINADO. Como o salto confere os requisitos de cada estado pulado, ele não atravessa mais esses estados sem o documento. A ficha, o lote e o quadro não os oferecem enquanto o parecer não existe: um processo novo do adicional não ganha «Concluído» no menu do cartão. Quem os alcança é o próprio parecer, ao ser emitido ou assinado (`acompanhar_parecer`). Com o documento presente, o passo manual continua valendo, para o processo que ficou para trás. Arquivar, sobrestar, indeferir, a máquina curta e a importação com `forcar` seguem como estavam.
- **Salto confirmado.** Na ficha, «Mover de estado» separa o próximo passo (saídas diretas, com o seguinte da cadeia já escolhido) de «Avançar vários passos», que fica recolhido e exige a caixa «Confirmo pular etapas», conferida no servidor. O inciso do art. 11 só aparece, e só vale, para o indeferimento técnico. Quando não há passo manual (o parecer é que leva adiante), a primeira opção é «nenhum passo manual agora», e não «Sobrestar»: um «Mover» distraído não sobresta o processo. A recusa aparece uma vez só, no popup reaberto com o que foi digitado; no sucesso, a ficha continua na mesma aba e diz «Processo movido para “X”.».
- **Justificativa da avaliação qualitativa no ato.** Sair de «Aguardando quantificação» sem relatório de campo exige justificativa de ao menos 20 caracteres no comentário do próprio movimento, e ela fica no evento da trilha. A observação escrita na criação do processo deixou de valer.
- **Datas do processo.** A data de autuação é fato ocorrido: data real e nunca depois de hoje. A regra está no serviço, então vale também para a demanda que vira processo. O prazo do lote pode ser futuro, mas tem de ser data real. No painel, a média de dias até a emissão descarta pares com autuação posterior à emissão.
- **Trilha de estado acentuada só na tela.** O texto gravado continua em ASCII com «->» (cadeia de hash). A aba Histórico e os «Últimos eventos» do painel convertem com `rotulo_tela_do_ascii`, com acento e «→».
- **Responsável.** Só contas ativas com `processo.editar` ou `processo.status` (perfil ativo, atribuição vigente) aparecem e são aceitas na lista, no lote e no quadro.
- **Lista e início do servidor.** A busca de /processos aceita SIAPE para todos os perfis; o nome continua só para quem pode lê-lo (RN-19). O NUP colado sem pontuação casa na lista como na busca global (`nup.termo_de_busca`). Caixas de seleção e ações em lote só aparecem para quem tem alguma ação de lote, e o POST do lote recusa com 403, antes de ler o formulário, quem não tem nenhuma. Quem tem escopo próprio não vê as visões do setor, e o «/» dele é o «Início»: meu adicional, meus processos, próximo treinamento, certificados a vencer e EPI com troca vencida. Os números institucionais do painel do setor passaram a respeitar o escopo de quem lê.
- **Link do SEI e anexos.** O link permanente precisa começar com `https://sei.`, e o botão só aparece com `processo.editar`. A categoria do anexo aparece com rótulo legível. O reenvio idêntico em outra categoria oferece reclassificar; a troca vai para a trilha, segue a RN-12 para PARECER_ASSINADO e nunca baixa o nível de acesso.
- **Importação.** Arquivo inválido ou JSON que não é export do Trello volta para /importar com a mensagem. O CSV da reconciliação exige `catalogo.gerenciar`, a mesma permissão da tela.

### Pareceres, laudos, adicionais e pendências

- **Quem conclui pendência de outra pessoa** (`servicos/pendencias.ts`, `PERMISSAO_CONCLUIR_POR_TIPO`). Antes valia uma lista única (processo.editar, treinamento.gerenciar, epi.entregar) para todo tipo, e a secretaria via «concluir» em troca de EPI que nem consegue ler. Agora cada tipo exige a permissão de escrita do módulo onde a tarefa se cumpre: `processo.editar` para processo e parecer, inclusive a reavaliação do adicional depois de entrega de EPI; `epi.entregar` para EPI; `demanda.registrar` para demanda; `turma.inscrever` para confirmar inscrição (é a secretaria quem confirma); `treinamento.gerenciar` para reciclagem de certificado; `laudo.criar` para conferir laudo. A pendência também tem de estar no escopo de leitura (`no_escopo`), e fora dele «não existe». O responsável continua fechando a própria. Tipo fora do mapa só o responsável fecha. Concluir de novo responde «Esta pendência já estava concluída.» e não grava nada.
- **A linha da pendência para quem não lê nome** (`pendencias.leitura`, usado pela tela e por `/api/v1/pendencias`). «conteúdo suprimido (RN-19)» deu lugar a uma frase neutra montada do tipo e da âncora, que não passa pela descrição gravada. A descrição gravada não muda, porque entra no digest. A coluna «Onde» mostra rótulo legível, o NUP e o número do laudo só aparecem para quem pode lê-los, e o link só aparece para quem a rota deixa entrar.
- **Laudo.** Número repetido volta à tela com o que foi digitado; emissão é fato ocorrido (até hoje) e o ano do número não pode ser futuro; o subscritor é obrigatório e precisa de habilitação vigente; ação em laudo inexistente é 404 antes de gravar. «Editar dados do laudo» (emissão, avaliação, subscritor, nº SEI) grava pela trilha campo a campo. Número, tipo e unidade não se editam, porque corrigi-los é laudo novo que supera este. «Desvincular posto» pede confirmação e fica na trilha, junto com o vínculo (LAUDO_POSTO_VINCULADO/DESVINCULADO). Superar com pareceres derivados pede, além do motivo, a caixa de ciência, conferida também no servidor (`ciente=1`): o `required` do HTML não protege quem posta direto.
- **Adicionais.** Toda ação exige `parecer.emitir` na primeira linha (403, não 422). Alterar percentual só aceita outro percentual do mesmo adicional; trocar de adicional é cessar e propor (RN-09). Cessar pede confirmação escrita, conferida também no servidor (`ciente=1`). Propor de novo responde «Este parecer já tem direito registrado.». O titular vê um cartão com a frase do próprio adicional, não a tabela de gestão; a tabela da equipe vira cartões no celular.
- **Editor do parecer.** Quem não tem `parecer.editar` vê o rascunho desligado (`fieldset disabled`), sem botão que grava. O titular vê só a prévia e o documento, sem o quadro de validação. As seções seguem a ordem do trabalho (objeto/laudo → exposição → marco → textos), e o seletor de laudo separa os superados e sugere o vigente da unidade do processo. Modelo de recomendação sem exposição principal (ou sem tipo, sem marco, ou com recomendação literal) grava o resto e diz o que falta, em vez de ignorar em silêncio.
- **O documento do parecer continua nominal para `parecer.ver` (D1 não feito).** É a saída nominal deliberada registrada em «RN-19 — vazamentos achados pela varredura e corrigidos»: o parecer é ato oficial que a secretaria leva ao SEI, e uma versão mascarada não serviria para isso; o acesso fica em `acesso_dado_sensivel`. O que mudou é o aviso ao lado do download, para quem não lê o nome: o documento traz o nome do servidor e o download fica registrado.
- **Relatórios.** «Adicionais vigentes por laudo» passa pela mesma supressão n<5 dos outros cartões, e o total some quando há célula suprimida. O exercício vale para processos (ano de autuação) e pareceres (ano do parecer, sem os anulados). Laudos e vigentes continuam como retrato de hoje. O CSV sai com o rótulo de tela do estado e com datas em dd/mm/aaaa.
- **Assinar pede `parecer.ver` na rota, e não `parecer.assinar`, de propósito:** quem lê o parecer e não pode assiná-lo chega ao serviço, que grava a recusa na trilha (ASSINATURA_NEGADA, RN-01). Uma recusa por `parecer.assinar` na rota apagaria esse registro. Quem nem lê pareceres recebe 403 antes de qualquer consulta.

### EPI

- **Cancelar pedido de EPI** (`epi_requisicao.pode_cancelar`): podem cancelar o requerente (a conta ligada ao servidor do pedido), quem abriu o pedido ou quem tem `epi.analisar`. Só `epi.requisitar` (o caso da secretaria) não basta para cancelar pedido alheio. A regra vale para o envelope e para a linha, e só em estado que ainda admite cancelamento. Antes a secretaria cancelava pedido de outra pessoa já analisado, e as reservas eram soltas.
- **Para quem se pede EPI** (`exigir_requerente_permitido`): conta de escopo próprio pede só para o próprio servidor (outro id dá 403; conta sem servidor ligado recebe recado). Escopo de unidade com campus pede só para servidor lotado num desses campi, ou ainda sem lotação. Para o servidor comum, a tela nova trava o próprio nome, sem busca e sem chefia, e traz o primeiro item e o botão «Enviar pedido» na mesma tela. O modelo continua sendo rascunho + itens. O pedido que alguém abriu para outra pessoa antes desta regra continua visível a quem o abriu (`solicitado_por_id` no escopo próprio), com a identificação do requerente suprimida pela RN-19.
- **Indeferir o pedido inteiro** recusa os itens ainda sem decisão com o mesmo motivo e complemento (um evento EPI_ITEM_RECUSADO por item) e indefere o pedido. Item aprovado continua impedindo; item cancelado deixou de impedir. O recado só menciona as recusas feitas no ato quando havia item pendente.
- **Comprovante de EPI**: conferido pelos bytes (PDF, PNG ou JPEG) e gravado com o tipo dos bytes. O anexo continua sem troca, por causa da trava de banco (`travas.sql`: a ficha é prova legal e só cresce), e a tela avisa antes do envio. Arquivo errado se corrige estornando e registrando de novo.
- **Entrega de balcão**: herda o tamanho do lote e recusa tamanho digitado diferente. Sem lote, só aceita tamanho da lista do item. Data futura também é recusada no serviço.
- **Entrada de lote**: tamanho obrigatório e da lista do item quando ele tem tamanhos. O CNPJ tem o dígito verificador conferido no servidor, com a mesma conta do aviso `data-cnpj`, e o CNPJ alfanumérico da Receita (IN RFB 2.229/2024, emitido desde julho de 2026) entra: letras nas 12 primeiras posições, cada posição valendo o código ASCII menos 48, os dois verificadores sempre números. O campo perdeu o teclado numérico do celular, que não digita letra. O mesmo lote + item + tamanho só entra de novo quando as duas entradas têm nota fiscal e as notas diferem: é uma segunda compra, com empenho e custo próprios, e o ajuste de inventário apagaria essa ligação. Nesse caso a nota aparece no rótulo do lote (reserva e entrega) e separa as opções. Sem nota em algum dos lados, nada distingue as entradas, e a recusa indica o ajuste (mais unidades da mesma caixa) ou a nota da nova compra.
- **Painel de EPI**: os pedidos e a fila de falta são contados no escopo de quem lê. A conta de escopo próprio vê um painel pessoal (Meus pedidos, Minhas trocas vencidas, Falta assinar). Quem não tem `epi.ficha` e pede o anexo de ficha alheia volta para /epis/fichas/minha com recado, a mesma resposta de registro inexistente.
- **Ficha em modo titular**: a própria ficha fala com o titular (avisos na linguagem dele, comprovante em palavras, «Pedir troca») só para quem não opera o balcão. Quem tem `epi.entregar` vê a própria ficha como operador, porque é ali que se anexa, devolve e estorna.
- **Custo nos indicadores**: sai em R$ pt-BR na tela (formatação manual, como `datas_br`, sem depender do ICU). O CSV mantém o número cru.

### Turmas e inscrições

- **Datas da turma.** Só se conclui uma turma depois que o curso terminou (`data_fim` ≤ hoje), qualquer que seja a situação de origem. A ficha esconde «Concluir» até o último dia e diz a data em que ele aparece. Presença é fato: só se lança em dia que já chegou, seja uma a uma, na coluna, no lote de um dia ou na folha. «Inscrições até» é planejamento e pode ser futuro, mas nunca depois do início da turma, no cadastro e na edição; na edição só se confere quando o prazo ou o início mudam, e a turma antiga com o prazo gravado depois do início continua editável. A turma concluída não é conferida. Prazo já passado é recusado antes de criar a turma, sem citar código. O pedido próprio e o link público fecham quando a turma começa (já no dia do início), qualquer que seja o prazo gravado, e o retardatário é inscrito pela CSSO. Turma aberta com link precisa começar depois de hoje. Na retificação, o período invertido é recusado antes da trava da presença, também no serviço.
- **A folha de presença num envio** (`POST /turmas/:id/presencas/folha`, `presenca.salvar_folha`). Uma caixa por dia, que vale a carga do dia (`horas_por_dia`), e «ajustar horas» para quem chegou atrasado (a frequência continua por hora). A nota fica no mesmo formulário, e um único «Salvar folha» grava tudo. Só se grava o que mudou, cada célula no seu savepoint. A caixa desmarcada só vira falta em dia já lançado. As rotas de uma célula (com htmx) continuam.
- **Pedidos pelo link.** As caixas nascem desmarcadas, com «marcar todos desta turma». Se uma turma recebe mais aceites do que tem de vaga livre, nenhum deles é aceito (antes aceitava na ordem da lista): quem escolhe quem fica de fora é quem confere.
- **Pedido público repetido.** O e-mail é procurado em todos os participantes que o usam. O pedido em espera da mesma pessoa na turma (mesmo nome inteiro, sem acento) é reaproveitado antes de criar outro participante, exceto quando os dois lados trazem e-mails diferentes: aí são duas pessoas de mesmo nome, e a duplicata vai para a mesclagem em vez de o segundo pedido sumir. O envio aceito responde 303 (PRG), e o cartaz mostra o nome e o e-mail recebidos, guardados num cookie HttpOnly de 15 min preso ao caminho do token, nunca na URL. A resposta continua a mesma para todos. Nome e organização recusam `< > { }`. O vínculo nasce sem escolha, e o SIAPE só aparece para servidor.
- **O titular.** A tela diz a situação real («Inscrita, aguardando a CSSO», «Pedido em análise», «Você desistiu — fale com a CSSO»). A desistência continua definitiva nesta turma, agora com confirmação. O pedido feito pelo link e ainda não conferido também pode ser retirado pelo próprio (`pode_desistir` aceita `AGUARDANDO_EMAIL`). Na ficha, quem não opera a turma vê só a situação e a própria inscrição.
- **Externo parecido.** Antes de cadastrar um participante externo, a tela pergunta «é a mesma pessoa?» quando já existe na base alguém com o mesmo primeiro e último nome ou o mesmo e-mail (`participante.parecidos`; o curinga digitado é escapado no SQL). A pergunta só aparece para quem pode ler os nomes (RN-19): para os outros, ela seria o oráculo que a busca fecha.
- **Permissão por destino.** A rota de mudança de situação da turma recusa com 403, antes de ler o formulário, quem não tem nenhuma das permissões de destino; depois exige a do destino pedido, procurando com `Object.hasOwn`, como o serviço.
- **Rótulos.** `ROTULO_INSCRICAO_TELA` em `dominio/treinamento.ts` serve às mensagens. `ROTULO_INSCRICAO` e `ROTULO_TURMA`, usados na trilha, não mudaram.

### Certificados, treinamentos e validação

- **Certificado padrão v2 e a redação do PDF.** O `certificado_padrao_v1.docx` escrevia «concluiu o treinamento {{ curso }} {{ norma }}», «, promovido por {{ promotora }}» e «válido até {{ vencimento }}». Como os nomes do catálogo já trazem a NR, saía «NR-6 NR-6»; na turma sem unidade promotora saía «promovido por ,»; no treinamento sem reciclagem, «válido até não expira». O v1 não foi alterado: é dele que a segunda via dos emitidos reimprime, e o hash é o do texto dele (RN-15). Nasceu o `certificado_padrao_v2.docx`, com frases inteiras montadas pelo sistema: `treinamento_nome_e_norma` (a norma só entra quando o nome não a traz), `turma_trecho_promotora` («, promovido por X» ou vazio) e `certificado_frase_validade` («válido até dd/mm/aaaa» ou «Validade: indeterminada»). A semente publica o «Padrão da casa v2» vigente e aposenta a v1, uma vez só, levando o mapa que o setor ajustou. Os treinamentos que apontam para a v1 não são reapontados: publicar versão nova não move o ponteiro de ninguém, e o catálogo avisa. O PDF da casa ganhou o campo congelado `redacao`, que vale 2 nas emissões novas; o congelado de antes lê como 1 e sai com o texto do v1, como saiu no dia. O «local e data» continua sendo a data do documento (emissão e assinatura), e não a de conclusão: é a mesma data da validação pública e da numeração, e a conclusão já está no período.
- **Tarja do anulado.** A segunda via do certificado ANULADO continua saindo, porque quem junta ao processo precisa do papel, agora com a tarja «ANULADO em dd/mm/aaaa — substituído por N/AAAA» («— este certificado não vale mais» quando não há substituto). No Word é um parágrafo em destaque no topo; no PDF, uma faixa no topo e a marca d'água diagonal. A tarja é aplicada na saída, depois do cálculo do hash: o congelado e o `hash_conteudo` não mudam. O PDF guardado do conversor tem chave própria para o anulado.
- **O reprovado na aba Emissão** recebe um bloqueio só, com os motivos do fecho e o gênero neutro («está reprovado(a): frequência de 50% abaixo do mínimo de 75%»); as conferências de frequência e nota não repetem os mesmos motivos. O aviso de «sem modelo próprio» sai uma vez no topo da aba.
- **Acesso do participante pelo link do e-mail.** O link não lista mais os certificados de qualquer participante que tenha o e-mail. O e-mail confirmado (único por regra) leva só aos certificados desse participante. Sem confirmação e com um cadastro só, leva aos dele. Sem confirmação e com mais de um cadastro (a duplicata não mesclada, ou duas pessoas com o mesmo endereço), não lista nenhum e orienta a procurar a CSSO, porque a caixa de e-mail não diz qual das pessoas a abriu. A página mostra o nome do titular e quanto falta para o link vencer. O convite do /validar e o «Pedir um link novo» só aparecem quando o envio de e-mail está configurado.
- **Chave de validação.** `normalizar_chave` aceita a chave sem traços, com espaços, com en dash e sem o «CSSO», e devolve o formato CSSO-AAAA-XXXXX-XXXXX-D, como a página pública prometia. A busca interna de /certificados também acha por trecho da chave, mas só a partir de 5 caracteres (um bloco inteiro): «csso», o ano ou uma sílaba de nome casariam com a chave de quase todo certificado. Caractere ambíguo continua sem conserto.
- **Indicadores.** A taxa de aprovação mostra «—» quando aprovados ou reprovados estão suprimidos (RN-19), e o cartão «Pendentes» só acende pelo valor exibido. Intervalo invertido é recusado com mensagem, sem trocar as datas em silêncio.
- **Porta de desenvolvimento.** Sem endereço público declarado, o recuo é http://127.0.0.1:${PORTA}, com 8766 como padrão (a porta do servidor local, que define PORTA quando falta). Antes era 8765, que ninguém servia.

### Base e administração

- **/config em duas seções.** Até aqui a tela abria para quem tinha `processo.ver` ou `backup.executar`, e o servidor comum lia o host do banco e os caminhos de disco da instalação. Agora a rota aceita `processo.editar`, `catalogo.gerenciar` ou `backup.executar` (`PERMISSOES_CONFIG`). «Configuração do setor» (setor emissor, autoridade destinatária, SLA com os rótulos do quadro, local de retirada de EPI) aparece para quem instrui processo ou gere catálogo. «Sistema» (onde o dado mora e backup) aparece só com `backup.executar`; sem essa permissão, os caminhos nem entram no contexto da página. A exportação completa continua com quem `pode_exportar_tudo`, que não vê os caminhos.
- **Inativar conta tem as mesmas travas da senha e do perfil.** A própria conta não se inativa. Conta de administração (`eh_conta_de_governo`) só é inativada ou reativada por quem concede perfil. A última conta ativa com `perfil.conceder` não se inativa. Nesses casos a tela esconde o botão, e antes de inativar e de encerrar perfil ela pede confirmação em camada.
- **Campus com sigla repetida é recusado.** O cadastro com uma sigla existente atualizava o campus em silêncio e sem trilha («como no Python»); agora ele recusa e indica a edição, que registra o diff. Sigla, nome e cidade são obrigatórios depois do trim.
- **Servidor: nome, e-mail e situação conferidos.** O nome não pode ficar em branco no cadastro. O e-mail precisa ter formato de endereço e não pode repetir o de outro servidor, porque é ele que liga a conta ao servidor; a recusa cita o SIAPE, não o nome (RN-19). Na edição, o e-mail só é conferido quando muda: um cadastro antigo com e-mail repetido não trava a correção do nome ou da situação. A situação só aceita o vocabulário do select.
- **Datas uniformes** (`datas_br.ler_data_formulario`, `exigir_ate_hoje`, `exigir_ordem`): data inválida é recusada em português, com o rótulo do campo. Na demanda, a chegada não passa de hoje; o prazo pode ser futuro ou já vencido, mas não anterior à chegada; encaminhamento e desfecho «encaminhada» ficam entre a chegada e hoje. O responsável da demanda só pode ser escolhido entre quem abre a tela de demandas. Quem não vê nome identifica o servidor solicitante pelo SIAPE, conferido no cadastro.
- **A permissão vem antes do formulário.** Toda rota POST chama `usuario.exigir(...)` antes de ler o formulário ou consultar o banco. Quem não tem acesso recebe 403, e não mais o 422 «campo obrigatório ausente», que revelava o formato da rota. `testes/permissao_primeiro.test.ts` deriva a tabela rota × perfil de `app.routes` e cobre todos os módulos.
- **Trilha legível para quem audita acesso.** Os eventos de conta, senha, vínculo, perfil, backup e exportação estão numa lista explícita de tipos, e quem tem `auditoria.ver` lê a descrição deles. A exceção é a conta ligada a servidor cujo nome quem lê não pode ver, o de hoje ou o de antes/depois de um vínculo: ali a descrição continua suprimida pela RN-19. O texto gravado e o hash não mudam; muda só a cópia que vai para a tela. Os acessos a dado sensível mostram o nome da conta e são paginados.
- **Senha atual errada na troca conta tentativa.** A senha atual errada em /trocar-senha usa o mesmo contador e o mesmo teto do login. No teto, a conta é bloqueada pelo mesmo tempo e todas as sessões caem, inclusive a de quem testava senhas numa sessão aberta.

## Marca da Sisa nos documentos (22/10/2026)

O papel que o sistema gera passa a levar a marca da Sisa (Superintendência Integrada de Saúde / UFVJM). O arquivo é um só, `public/estaticos/img/logo-sisa.png` (600 × 230 px, recortado e reduzido do original de `entrada/`). Nos `.docx` ela vai embutida no cabeçalho do Word do modelo, como o brasão e a marca da UFVJM no parecer: é parte do modelo e repete em toda página, e a função do Netlify não precisa ler o PNG do disco.

- **Certificado: não muda, por decisão.** O certificado segue o modelo cadastrado pelo setor (Treinamentos › Modelos); quem quiser a marca a põe no próprio `.docx` do modelo. Os padrões da casa (`certificado_padrao_v1/v2`) ficam como estão.
- **Parecer técnico: `modelo_parecer_v3.docx`.** É o v2 com uma quarta coluna no cabeçalho: brasão | texto | UFVJM | Sisa (31 mm de largura, menor que a das duas marcas, para as três se equilibrarem). A coluna do texto cedeu largura sem quebrar nenhuma linha. O rascunho novo nasce no v3, e o editor oferece v1, v2 e v3. O modelo é congelado no parecer (`modelo_arquivo`, RN-15): o emitido no v1 ou no v2 é reimpresso no seu modelo, sem a marca, e o v1 e o v2 não foram tocados. A prévia em HTML mostra a marca só quando o parecer é do v3, para não prometer um papel diferente do que sai no `.docx`.
- **Lista de presença e comprovante de EPI: `lista_presenca_v2.docx` e `comprovante_epi_v2.docx`.** Nenhum dos dois congela o modelo: a lista é regerada a cada pedido, e o comprovante guarda o contexto e o hash do texto, não o modelo. Editar o v1 seria permitido, mas o `.docx` de origem em `app/templates/` é também o do sistema da rede, então nasceu um v2 ao lado, e só a nuvem passou a usá-lo. A marca é imagem, não texto: o hash do texto do v2 é igual ao do v1, e a segunda via de um comprovante impresso antes não acusa divergência. Na lista, a linha das assinaturas passou a ficar na mesma folha do rótulo (`keepNext`), porque a marca empurra cada folha alguns milímetros para baixo.
- **Papel impresso pelo navegador.** `base.html` tem a marca no alto de toda tela, com `.so-papel`: não aparece na tela, só no papel (ficha de EPI, guia de entrega, ficha do servidor, relatórios, listas, a validação pública). Fica fora da casca, porque a tela sem lateral também é impressa. Sai só na primeira folha: o Chrome não desenha `@page { @top-center }`, e `position: fixed` repetiria a marca por cima do texto. Sobre a prévia do parecer ela não sai, porque a prévia já é papel timbrado.
- **Os modelos novos** estão em `app/templates/` (origem), espelhados em `nuvem/templates/` e convertidos para `modelos-docx/` por `ferramentas/converter-modelos-docx.ts`, com `manifesto.json` atualizado.

## Setores promotores (22/10/2026)

A unidade promotora da turma continua aparecendo onde já aparecia: «, promovido por X» no certificado, a lista de turmas, o «Promoção» da inscrição pública, a lista de presença, os indicadores e os filtros. O que muda é o que se **escolhe**. Até aqui o seletor oferecia a estrutura inteira da UFVJM (`unidade_uorg`, que serve à lotação, ao parecer e ao EPI). Agora ele oferece só os setores cadastrados para promover treinamento.

- **Uma coluna, e não uma tabela.** `unidade_uorg.promove_treinamento` (booleano, falso por padrão, migração `0011_setor_promotor`). A turma continua apontando para `unidade_uorg`, então o certificado, a inscrição pública, a lista de presença e os indicadores não mudaram.
- **Os da Sisa, uma vez só.** Sisa, CSSO, SecSisa, CSQV, CPOS e CPEL nascem promotores (`sementes.SETORES_PROMOTORES_INICIAIS`). No banco que já tinha essas unidades (produção), quem as marca é a própria migração 0011 (um `UPDATE` pelo nome oficial, escrito à mão depois do drizzle-kit), e a migração roda uma vez. No banco novo, a semente marca ao **criar** a unidade, e `_obter_ou_criar` não reescreve quem já existe. Assim o deploy, que roda migração e semente a cada publicação, não remarca um setor que foi desmarcado. O padrão «só quando nenhum estiver marcado» não serviria: o setor que esvaziasse a lista a veria voltar no deploy seguinte.
- **Onde se mantém a lista:** Treinamentos → Setores promotores (`/treinamentos/setores-promotores`). Vê com `treinamento.ver`. «Incluir setor promotor» e «retirar da lista» pedem `treinamento.gerenciar`, a mesma permissão do catálogo de treinamentos. A tela não ficou em Catálogos → Unidades / UORG porque ela pede `processo.ver`/`catalogo.gerenciar`, que o técnico e o engenheiro que abrem turma não têm. A lista é vocabulário do módulo de Treinamentos. Em Unidades / UORG a coluna «Promove treinamento» aparece só para leitura, com link para a tela, e o «salvar» da linha não mexe nela. Incluir e retirar deixam o diff na trilha (`CAMPO_ALTERADO`, campo `promove_treinamento`), como as edições em linha dos catálogos. Unidade inativa não se inclui.
- **Turma nova, edição e correção** (`turma.criar_turma`, `turma.editar_turma`, por onde passa também a retificação da turma concluída): o seletor lista os promotores pelo nome, com a dica «Só aparecem os setores cadastrados para promover treinamentos (Treinamentos → Setores promotores)». O servidor recusa unidade fora da lista com mensagem em português. A exceção é a turma antiga que já aponta para uma unidade fora da lista: ela fica com essa unidade. O seletor mostra o valor como «(fora da lista atual)», e editar outro campo não obriga a trocar. Retirar um setor da lista não mexe em turma nenhuma, e certificados e documentos já emitidos não mudam. A API (`rotas/api.ts`) não grava unidade promotora, e a turma nova continua nascendo sem unidade padrão.
- **Filtros.** O «Setor promotor» de /turmas lista os promotores de hoje e qualquer unidade que já promoveu turma no escopo de quem vê, para o histórico continuar encontrável. O dos indicadores já listava só as unidades usadas em turma e ficou como estava.

## Identidade visual da Sisa (22/10/2026)

A tela troca o verde-azulado do IntegraSST pelas cores do símbolo da Sisa (as quatro pessoas em roda), e o símbolo passa a identificar o sistema na aba, no atalho do celular e na lateral. Os documentos impressos e os `.docx` não mudam.

- **Ícones** (`public/estaticos/img/`): `favicon-16/32/48.png`, `apple-touch-icon.png` (180, fundo branco, opaco), `icone-192.png` e `icone-512.png` (transparentes) e `icone-maskable-512.png` (fundo branco, símbolo em 72% do lado, dentro da zona segura). Recortados do original (1264 × 1264, fundo branco) com o branco feito transparente pela distância ao branco, e a cor da borda "descomposta" do branco, para não sobrar halo claro sobre fundo escuro. `public/favicon.ico` (16/32/48) atende quem pede o caminho fixo; no Netlify `public/` é a raiz publicada. O servidor local só serve `/estaticos/`, então ali `/favicon.ico` é 404 — a aba usa o `<link rel="icon">`. O `icone.svg` antigo (o documento em chapa) e `partes/marca.svg` saíram: nada mais os usava.
- **A casca** (`base.html`, no `<head>`): os `<link rel="icon">`, o `apple-touch-icon` e `<meta name="theme-color" content="#0a2a5c">`, ANTES do bloco `cabeca` — a primeira `theme-color` vale, e a de `celular.html` (#0f2a4a) ficou redundante. O manifesto aponta para os PNG (com o `maskable`) e tem a mesma cor; o `index.html` do app compilado também (é cópia: um novo build do `frontend/` precisa repor essas linhas).
- **Marca da lateral e do cabeçalho sem casca:** o símbolo (`marca-sisa.png`, 80 px para 34 px em tela 2x, `alt=""`) numa chapa branca de canto arredondado, com o "CSSO / Sisa · UFVJM" ao lado. A chapa existe porque a pessoa da esquerda é azul-marinho e sumiria na lateral do mesmo tom. Sob o cabeçalho das telas sem casca (login, validação, celular), um fio com o degradê das cores do símbolo.
- **Paleta** (`tema.css`, só tokens e os poucos valores escritos à mão): acento azul #0058a3 (7,18:1 com branco), hover #004a8a (8,95), ciano #1a96c0 só para desenho (3,40 — nunca texto pequeno), "ok" verde #2f6b17 (6,49; 5,65 no fundo verde), verde-claro #8dc63f só preenchimento, info #08669a (6,22), lateral #0a2a5c (texto 9,35, texto fraco 6,50, "CSSO" branco 14,0). O item ativo da lateral é o azul com um fio ciano à esquerda: azul contra marinho dá 1,95:1, e a forma precisava de mais que a cor. Alerta, erro e roxo continuam os de antes. Topo do popup: degradê marinho → azul. Os cartões `.acao-hub.teal` mantêm o nome da classe (usado nos templates) e passam a ciano.
- **Service worker:** `marca-sisa.png` entrou na casca e a versão subiu para `csso-celular-v4`; a ativação apaga a v3.
- `csso.css` não foi tocado: o teal só aparece lá em dois comentários (o do número do filtro ativo), que falam do valor de antes.

## Edição em popup (22/10/2026)

- **A lista é só de leitura; editar abre popup.** Como no Catálogo de EPI e no de treinamentos: cada linha tem «Editar» (`ui.botao_cadastro`, só para quem tem a permissão), que abre um `ui.popup_cadastro` fora de `.tela`; a recusa do servidor responde 200 com aquele popup aberto, a mensagem e o que foi digitado (`editando_id`; o CPF nunca volta). Ajustadas: Instrutores, mapa de marcadores do modelo de certificado, Catálogo de treinamentos (gaveta → popup), os catálogos de `/catalogos/<nome>` (o «salvar» da linha de Unidades / UORG citado acima virou esse «Editar»), categorias e motivos de recusa de EPI e a conta ligada ao profissional habilitado em Usuários. Lançamentos em massa, filtros e ações de um clique ficaram como estavam.

## Menu de Certificados e Treinamentos em grupos (22/10/2026)

As quinze telas do módulo eram uma coluna só. Agora a lateral as mostra em blocos com subtítulo: o «Início» no topo, sem título, e depois **Turmas e inscrições** (Turmas, Pedidos pelo link), **Certificados** (Fila de emissão, Emitidos, Envios por e-mail), **Acompanhamento** (Reciclagem, Indicadores), **Cadastros** (Treinamentos, Modelos, Instrutores, Setores promotores, Juntar duplicados) e **Meu espaço** (Meus treinamentos, Meus certificados), este por último e só para conta vinculada a servidor. Nenhum caminho e nenhuma permissão mudaram.

- **Os grupos ficam declarados no módulo** (`Modulo.grupos`, `GrupoMenu`), e não em cada `Item`: o construtor de `Item`, a BASE, o MEU_ESPACO e o celular ficam como estavam. `Modulo.itens` passa a ser derivado dos grupos e continua decidindo a porta de entrada, o destaque e a trilha. Declarar `grupos` e `itens` juntos lança erro. Processos SEI e EPI não se dividem, caem num grupo único sem título e saem com o HTML de antes.
- **`grupos_de(usuario)`** descarta o grupo que fica vazio e tira o subtítulo quando sobra um grupo só. O admin de TI, que só vê Indicadores, não recebe um «Acompanhamento» em cima de um item. O primeiro item visível de cada perfil é o mesmo de antes (Início, Turmas ou Indicadores), então `/inicio` e o link do módulo não mudaram.
- **Rótulos.** Só mudaram os que enganavam. «Certificados» virou **Emitidos**, porque repetia o nome do módulo e ficava ao lado de «Meus certificados». «E-mails» virou **Envios por e-mail**, porque parecia caixa de entrada. «Catálogo» virou **Treinamentos**, porque ficava perto de «Catálogos», da base, e do «Catálogo» do EPI. «Participantes» virou **Juntar duplicados**, porque a tela só faz isso. O hub (`hub_treinamentos.ts`) e os `<h1>` acompanham: «Certificados emitidos», «Envios por e-mail», «Juntar cadastros duplicados» e o cartão «Treinamentos e modelos». O rótulo de menu não vai para a trilha de auditoria, então nenhum texto gravado mudou.
- **Marcação** (`base.html`): o bloco do módulo ganhou `role="group"`, sem o qual o `aria-label` da `<div>` era ignorado, e cada grupo com título é um `role="group"` com `aria-labelledby` apontando para o subtítulo. O subtítulo é `<span class="rotulo-grupo">`, e não `<h2>`/`<h3>`. Assim ele não entra no esqueleto de títulos da tela, não recebe foco e a contagem de Tab do salto não muda. Em `/modulos` o mesmo agrupamento sai com `<h3 class="rotulo-grupo-mapa">`, porque ali fica abaixo do `<h2>` do cartão.
- **CSS:** o subtítulo é mono, 10,5px, em caixa alta, na cor `--lateral-texto-fraco` (6,52:1; 6,50 no tema), mais leve que o `.rotulo-secao` de «Módulos» e «Base compartilhada». Ele fica recuado até o texto do item, depois do ícone (39px em `tema.css`). Na faixa do celular (≤900px) cada grupo ocupa a linha inteira e os itens quebram dentro dele.
- **Ficaram de fora:** contagens no menu (seria uma consulta ao banco em toda página), Cadastros recolhido num `<details>` (esconderia o destaque de onde a pessoa está) e esconder da PROGEP ou da secretaria telas que a rota abre para elas (o item repete a permissão da rota).

## Governança de acesso: escopo por permissão e titular (22/10/2026)

A verificação de governança de acesso achou 29 defeitos (D1–D29) na forma como a conta ganha, soma e perde acesso. As correções foram feitas em quatro lotes (núcleo do RBAC, concessão e contas, autenticação, leitura nominal e assinatura), revistas por um revisor adversarial e fechadas numa segunda rodada. Nenhum texto já gravado na trilha mudou: os eventos novos têm texto novo, e o que muda na tela é só a cópia exibida.

### Escopo por permissão, e não por conta (D1, D9, D16)

- **O alcance acompanha a permissão.** O escopo (S/E/A/P) e os campi eram da CONTA: o mais largo entre os perfis e a soma dos campi de todas as atribuições. Somar perfis alargava os outros: o `admin_ti` que ganhava `servidor_consulta` para se inscrever em turma virava escopo A ("sem filtro") e lia processo e parecer de todos os campi; o almoxarife virava E com leitura nominal; o coordenador sem campus que recebia técnico no campus JK passava a ver só JK. Agora cada atribuição vigente é uma `Concessao { perfil, campus_id, permissoes }`, e o alcance de uma permissão é a soma das concessões que a deram, e só delas (`usuario.alcance(p)`, `usuario.escopo_de(p)`, `aplicar_escopo(usuario, tabela, permissao)`). Não houve migração: o alcance sai de `atribuicao.campus_id` e de `ESCOPO_POR_PERFIL`.
- **O agregado (A) nunca é linha.** `aplicar_escopo` devolve `false` para A, e não mais "sem filtro". O número agregado (indicadores) se recorta pelo alcance de `indicador.ver`: o agregado, o total e a unidade sem campus contam tudo; o campus da concessão recorta pelo campus da turma. Para a leitura nominal, o agregado só é coberto pelo total ou pela unidade sem campus (`_cobre`).
- **O ato acha a linha pelo alcance do ato.** Cada porta recebe a permissão do ato, e não a de leitura: `epi.analisar`, `epi.estoque`, `epi.entregar` (no cancelar, `epi.requisitar` ou `epi.analisar`); `certificado.anular` para anular e corrigir (ninguém anula nem corrige o próprio certificado); `certificado.emitir` na emissão pela fila; `turma.inscrever` nos pedidos pelo link e no cartão "Pedidos pelo link" do hub de treinamentos; `turma.avaliar` nas presenças da API. Isso fecha a brecha em que o perfil recortado num campus agia fora dele sobre o próprio pedido de EPI ou o próprio certificado.
- **Ficha de EPI por campus.** Ler a ficha de outra pessoa exige que o alcance de `epi.ficha` cubra o campus de lotação do servidor (sem lotação conhecida, a permissão basta). Vale para a ficha, a API, o comprovante, o anexo e a lista /epis/fichas.
- **Pendências.** A fila inteira do setor só vai para quem tem alguma das `PERMISSOES_VER` em escopo S ou E. Quem só alcança o próprio dado ou o agregado (o `admin_ti`) vê as pendências de que é responsável. O titular continua abrindo /pendencias, porque recebe tarefa própria (decisão de EPI, retirada disponível, desfecho de demanda).
- **Compatibilidade.** `usuario.escopo` (o nível da conta) ficou só para o que é da conta e não de uma leitura; `usuario.campi` só para exibição; `usuario.ve_dado_nominal` (sem argumento) mantém a semântica antiga para os chamadores que não leem linha.

### A concessão do titular (D16)

- **Toda conta ligada a servidor recebe as funções do titular**, numa concessão à parte (`CONCESSAO_DO_TITULAR = "@titular"`), sempre em escopo próprio: `processo.ver`, `parecer.ver`, `treinamento.ver`, `turma.inscrever_se`, `epi.ver` e `epi.requisitar` — o mesmo conjunto do `servidor_consulta`, que continua existindo. O almoxarife e o `admin_ti` ligados a servidor abrem as telas do titular sem somar outro perfil, e a soma não lhes alarga nada.
- **Telas de equipe pedem a permissão por perfil de equipe.** /catalogos, /kanban, /treinamentos/catalogo, /epis/estoque e /perfis (para quem não governa contas) usam `exigir_na_equipe`, que ignora a concessão do titular e o escopo P. Desvio: o `servidor_consulta` também perdeu essas telas, inclusive a leitura de /epis/estoque, que um teste antigo garantia (melhoria 15 do relatório).
- **O menu segue a mesma regra** (`modulos.ts`). `Item.visivel_para` só mostra a tela da equipe a quem tem alguma das permissões dela por perfil de equipe (`UsuarioAtual.pode_na_equipe`); a tela do titular (`do_titular`) continua pedindo só a permissão. `so_o_proprio` passou a ser "nenhuma permissão por perfil de equipe", e não mais "o escopo da conta é P". Antes disso, o almoxarife ligado a servidor via no menu Kanban, Processos, Catálogos e Turmas, que abriam vazios ou com 403.
- **"Meu espaço" ao lado da lateral da equipe.** A conta de equipe ligada a servidor recebe a lateral de sempre e, depois da base, o bloco "Meu espaço" com o que é do titular (Meus treinamentos, Meus certificados, Minha ficha de EPI, Pedir EPI, Meus dados…). Sai do bloco o item cujo caminho a lateral já oferece como tela da equipe: para o coordenador, `/` é o Painel e `/epis/requisicoes` é a fila do setor, e chamá-los de "Início" e "Meus pedidos de EPI" afirmaria um recorte que a tela não faz. As telas do titular declaradas dentro dos módulos (o grupo "Meu espaço" de Certificados, a "Minha ficha de EPI" do EPI) saem da lateral quando o bloco está ao lado, para não aparecerem duas vezes; continuam declaradas porque dizem a que módulo o caminho pertence. Quem só tem o próprio continua só com o "Meu espaço", e entra pelo Início dele. A trilha diz "Meu espaço" quando a tela é uma do bloco.

### Segregação de funções (D2, D3, D4, D7)

- **Ninguém concede mais do que tem.** Quem concede perfil não concede à própria conta, nem perfil que dê permissão que o seu alcance de equipe não cobre — o escopo do perfil e o campus escolhido. O superintendente recortado num campus não concede `auditor_interno` nem perfil sem campus. Ficam fora da conta `parecer.assinar`/`laudo.criar` (só valem com habilitação atestada por terceiro) e as permissões do titular. A recusa grava `PERFIL_CONCESSAO_RECUSADA`.
- **Habilitação atestada por terceiro.** Quem atesta não liga a habilitação à própria conta, não atesta o próprio SIAPE, não corrige a própria, e não a liga a conta que criou ou cuja senha redefiniu (a conta-fantoche). A conta precisa existir, estar ativa, ter trocado a senha provisória e não ter outra habilitação vigente ou futura. A habilitação interna exige SIAPE e conta ligada ao servidor do mesmo SIAPE; só a externa, com a justificativa do art. 10, §5º, se liga a conta sem servidor. A recusa grava `HABILITACAO_RECUSADA`. Desvio: não se recusa quem concedeu o perfil técnico, porque com um único superintendente isso travaria o fluxo normal (o `admin_ti` cria a conta, o superintendente concede e atesta).
- **Redefinir senha** sem `perfil.conceder` exige que as permissões da conta-alvo (vigentes ou futuras) estejam contidas no alcance de quem redefine. O `admin_ti` segue atendendo a senha esquecida da conta comum, mas não toma conta técnica nem de equipe. Substitui a regra de 18/10/2026 ("as demais, pelo `admin_ti`"). Desbloquear conta segue a mesma trava.

### Travas de governo com concessões futuras (D17, D18, D23)

- Redefinir senha, inativar/reativar e a etiqueta "conta de administração" consideram as concessões vigentes **ou futuras**: o `admin_ti` inativava hoje a conta que vira superintendente na semana que vem. A trava "última conta que concede" continua olhando só as vigentes.
- Conceder, encerrar e inativar tomam `pg_advisory_xact_lock(TRAVA_GOVERNANCA)`. `fim_da_cobertura` soma as concessões vigentes e as futuras que emendam nelas; com a cobertura de quem concede perfil acabando em até 30 dias, cada conta que concede recebe a pendência `COBERTURA_DE_CONCESSAO_A_VENCER`, que fecha sozinha quando outra concessão emenda. Cobertura já acabada se remedeia por `npm run redefinir-senha -- --login X --conceder-superintendente [--manter-senha]`.
- A concessão futura se cancela (`PERFIL_CANCELADO`): o fim vira a véspera do início, um intervalo vazio que diz "nunca valeu", sem coluna nova. A concessão é validada (fim antes do início, fim passado, duplicada, perfil ou conta inativos), os selects oferecem só perfis ativos com o escopo ao lado, e `campus_id` inválido é recusado em vez de virar "todos os campi".

### Habilitação encerrável, contas e unicidade (D7, D10–D13, D19, D20, D24, D25)

- POST /habilitacoes/:id/encerrar e /corrigir gravam `HABILITACAO_ENCERRADA` e `HABILITACAO_CORRIGIDA` (um evento por campo).
- POST /usuarios/:id/desbloquear zera as tentativas sem trocar a senha (`CONTA_DESBLOQUEADA`); a etiqueta "bloqueado até HH:MM" só aparece enquanto o bloqueio vale. POST /usuarios/:id/dados grava um `USUARIO_ALTERADO` por campo.
- Login e e-mail são únicos sem caixa (migração 0012, índices em `lower(login)` e `lower(email)`); a duplicata antiga recebe o sufixo `~dup<id>` na conta de id maior, com `RAISE WARNING`, fora da trilha (a migração não calcula o hash da cadeia). O login de uma conta também não pode ser o e-mail de outra.
- Tela: conceder perfil começa sem conta escolhida e lista só contas ativas, sem a própria; resetar senha pede confirmação; o campus aparece na pílula e no Gerir; /perfis abre para quem cria conta ou concede perfil e mostra o alcance de cada perfil; o Gerir tem o link "Histórico desta conta".

### Autenticação e trilha (D5, D6, D8, D21, D26, D28)

- A troca recusa a senha nova igual à atual e confirma quantas sessões caíram. O bloqueio vencido recomeça a contagem do zero. Conta inexistente ou inativa tem o mesmo bloqueio encenado da conta real (contador por HMAC do identificador em `limite_login_ip`, sem gravar o texto digitado). A tela /primeiro-acesso cria o superintendente sem troca obrigatória.
- Eventos novos: `SENHA_TROCADA`, `CONTA_BLOQUEADA`, `PERMISSAO_ACRESCENTADA_AO_PERFIL` e `PERMISSAO_RETIRADA_DO_PERFIL` (ver abaixo), além de `PERFIL_CANCELADO`, `PERFIL_CONCESSAO_RECUSADA`, `USUARIO_ALTERADO`, `CONTA_DESBLOQUEADA`, `HABILITACAO_ENCERRADA`, `HABILITACAO_CORRIGIDA`, `HABILITACAO_RECUSADA` e `ASSINATURA_REGISTRADA_POR_SUBSTITUTO`, todos com rótulo e legíveis por quem audita acesso. /auditoria ganhou o filtro "Conta afetada" (`?conta_id=`); o antigo virou "Quem agiu". `PERFIL_CONCEDIDO` diz agora a conta, o campus e a vigência.
- **D21, parcial: login não vai para a trilha.** O login certo e cada falha isolada continuam fora da trilha encadeada. Cada entrada tomaria a trava da cadeia (`pg_advisory_xact_lock`) e encheria a trilha de linhas que não dizem nada sobre acesso concedido. O login certo já fica em `sessao` (IP, user-agent, hora), e a falha conta no contador da conta e no teto por IP. Vai para a trilha o fato relevante: o bloqueio.

### Leitura nominal e assinatura (D14, D15, D22, D29)

- **A Consulta PROGEP lê o parecer como documento** (`parecer.escopo_de_leitura`): para as concessões de `PERFIS_QUE_LEEM_SO_O_DOCUMENTO`, só abre parecer emitido, assinado ou anulado depois de emitido, na ficha, no .docx, no PDF, na prévia, no anexo, na lista da ficha do processo e nos eventos de parecer da trilha. Desvio da correção proposta ("emitido/assinado para quem não tem `parecer.editar`"): foi por perfil, porque a secretaria e o titular leem rascunho de propósito.
- **Quem marca como assinado é o signatário.** Outra conta só marca com substituição declarada, com motivo, e grava `ASSINATURA_REGISTRADA_POR_SUBSTITUTO` além do `PARECER_ASSINADO` de sempre.
- **`epi.ficha` só é nominal nas telas de EPI** (`NOMINAIS_FORA_DO_EPI = ["exposicao.ver"]`, chave de contexto `nominais_rn19`). /relatorios e /epis/relatorios, sem recorte de linha, suprimem para quem não lê o nome em todo campus (`ve_dado_nominal_sem_recorte`). O lote de inscrição casa pelo nome com `certificado.ver` ou `exposicao.ver`.

### O `admin_ti` perde `indicador.ver` (decisão do usuário, 22/10/2026)

- O perfil fica com conta, senha, auditoria e backup. Os indicadores (/relatorios, /treinamentos/indicadores, /epis/relatorios) deixam de abrir para ele, e o menu não os oferece; o `/inicio` dele passa a cair em /auditoria.
- **A retirada chega ao banco já gravado pelo semeio, declarada.** `semear_rbac` continua sem tirar permissão por omissão: uma linha apagada da matriz por engano não pode encolher em silêncio o acesso de quem trabalha. A retirada mora em `rbac.PERMISSOES_RETIRADAS` (perfil, permissão, data e motivo); no próximo deploy o semeio apaga a linha de `perfil_permissao` e grava `PERMISSAO_RETIRADA_DO_PERFIL` (autor "sistema", `valor_anterior` = a permissão). Fica na lista para sempre: um banco restaurado de backup antigo volta a ter a permissão, e o semeio seguinte a tira de novo, com outro evento. `_conferir_retiradas` recusa, na importação, retirada que a matriz ainda concede. Não houve migração SQL: a semente roda a cada publicação.

### Ficou de fora, e por quê

- **D2 (parte):** o superintendente ainda pode vincular a própria conta a outro servidor. Bloquear impediria ligar a própria conta ao próprio servidor; o relatório a classificou como melhoria.
- **D3 (parte):** não há justificativa para SIAPE divergente — a divergência é recusada.
- **Recusar a entrega do próprio pedido de EPI:** a brecha nova (o próprio pedido em outro campus) fechou com o alcance de `epi.entregar`, e analisar o próprio pedido já é barrado pela RN-28. Barrar a entrega no próprio campus pararia o técnico que opera sozinho o balcão.
- **Tirar /pendencias de quem só tem as permissões do titular:** deixaria sem dono que a abra a tarefa atribuída a ele. O vazamento fechou em `no_escopo`, que decide por permissão.
- **Teste de concorrência com dois pedidos simultâneos:** o pool do app tem uma conexão (`CSSO_POOL_MAX=1`). O teste segura a trava numa conexão à parte e confere que conceder, encerrar e inativar esperam por ela.
- **Usos restantes de `ve_dado_nominal` sem argumento** (busca só por SIAPE em /processos, /servidores, `privacidade.atores_para_tela`, `identificacao.valor_da_trilha`, `pendencias` com a família padrão): ou são telas que o almoxarife abre só com as próprias linhas, ou trocar só o texto deixaria a ajuda inconsistente com a busca. `adicionais.ts:109` (leitura de vigência por id em rota de equipe) e o processo sem `campus_id` (o campus da concessão não recorta processo) ficaram como estavam.
- **Contas de teste montadas à mão** (`UsuarioAtual` sem `concessoes`) caem no modo de compatibilidade: o alcance é o do nível da conta, com A = `false`. Conta assim sem perfil é de quem só tem o próprio: o menu da equipe não lhe aparece.

## Sistema SISA: o nome do sistema (22/10/2026)

Decisão do usuário: o sistema passa a se chamar **Sistema SISA** e atende todos os setores da Sisa (CSSO, CSQV, CPOS, CPEL, SecSisa), não só a CSSO. A regra aplicada:

- **Muda para SISA, o nome do sistema.** As abas trocam `· CSSO` por `· SISA` em todas as telas. A marca da lateral e do cabeçalho passa a ser «**Sistema SISA** / UFVJM», e o título padrão e o rodapé impresso dizem «Sistema SISA · UFVJM». `RODAPE_INSTITUCIONAL` passa a «Sistema de apoio da SISA». No manifesto do PWA ficam «SISA no celular» / `short_name` «SISA», e a página offline do `sw.js` também muda. O app compilado (`frontend/` e a cópia em `public/estaticos/app/`) passa a «SISA · app». O PDF do certificado sai com criador/produtor «Sistema SISA». Também mudam o assunto e a assinatura dos e-mails do sistema, o log do servidor local e o título de `PRODUCAO.md`.
- **Neutraliza o que é de qualquer setor.** Em turmas, inscrição pública, pedidos pelo link, certificados, validação, demandas e pendências, o texto deixa de dizer «a CSSO». Quando a turma tem promotor, passa a dizer «a equipe da {sigla}». Sem promotor, diz «a equipe responsável» ou «o setor que promoveu o treinamento». O «Fale com a CSSO.» do serviço de turma virou a constante `turma.FALE_COM_A_EQUIPE`, que a inscrição pública também usa para tirar a frase da mensagem.
- **Fica com CSSO o que é competência da CSSO ou identificador.** Isso vale para o adicional, os processos SEI, o parecer (fallback `"CSSO"` da sigla emissora, data em Diamantina), os laudos e a habilitação técnica. No EPI ficam o termo do comprovante, a reconsideração do pedido (`epi_requisicao.ts`) e o «procure a CSSO antes de ir» da guia, todos tratados como competência. Ficam também os perfis `*_csso` e seus nomes («Coordenador da CSSO»), as variáveis `CSSO_*`, os cookies `csso_*`, as chaves `csso:` do navegador, o cabeçalho `x-csso-rotina`, as funções SQL `csso_*` e o prefixo `CSSO-AAAA-` da chave de certificado (já impresso, com CHECK na migração 0000). O mesmo vale para `CSSOBK01` e `csso-AAAAMMDD-HHMMSS.enc` do backup, o `VERSAO` do service worker, `csso.css`/`csso.js`, o site Netlify `cssosisa`, os dados institucionais semeados (a unidade CSSO, `CSSO/Sisa` como setor emissor, `csso.sisa` no SEI e no e-mail), a trilha já gravada, os modelos `.docx`, os dados fictícios do povoamento e os comentários que contam a história.

Desvios e escolhas:

- **Grafia.** «SISA», em maiúsculas, só no nome do sistema. A superintendência continua «Sisa», nas assinaturas «Superintendência Integrada de Saúde (Sisa) — UFVJM», em «Sisa/UFVJM» no acesso do participante, em «Fez treinamento com a Sisa e não tem conta?» no login e em «o que os setores da Sisa oferecem».
- **Artigo do nome do setor.** Onde o texto cita o setor, usa-se a sigla («a equipe da CSQV») ou a forma «o setor que promoveu o treinamento (Nome)». «Procure a {nome}» erraria com unidade de nome masculino, como «Serviço Especializado…». Sem sigla, fica o texto genérico. As constantes (`RESPOSTA_PADRAO` da inscrição pública) continuam genéricas.
- **Assinatura de e-mail.** A de inscrição, certificado e reciclagem leva o nome extenso do setor promotor quando existe e, sem ele, a da Sisa, seguida de «Mensagem enviada pelo Sistema SISA.». O e-mail de acesso do participante assina sempre pela Sisa, porque pode trazer certificados de vários setores.
- **Remetente.** O nome que aparece como remetente vem só de `CSSO_EMAIL_REMETENTE`. O código não o define, e a troca para `"Sistema SISA · UFVJM" <…>` é feita no painel do Netlify (`PRODUCAO.md` §2.2).
- **Exportação completa** passa a baixar `sisa-export-AAAAMMDD-HHMMSS.zip`. A limpeza de 24 h (`privacidade.NOME_EXPORTACAO`) aceita os dois prefixos e continua apagando as `csso-export-` antigas. O backup cifrado manteve o nome, porque a retenção por regex e a restauração documentada dependem dele.
- **Trilha de auditoria.** Nada gravado foi reescrito (hash encadeado). `ROTULO_EVENTO` é só exibição, não entra no hash, e por isso `INSCRICAO_PEDIDO_CONFERIDO` virou «Pedido do link público aceito pela equipe». A descrição nova da exclusão de turma diz «lançada(s) pela equipe», e os eventos antigos continuam com «pela CSSO». A pendência de desfecho de demanda passa a pedir «fale com a equipe que registrou a demanda», mas só nas criadas daqui em diante.
- **Banco: sem migração.** Nenhum texto semeado sobre o sistema dizia «CSSO»: só dados institucionais e nomes de perfil, que a semente já sincroniza. A última migração continua a 0012.
- **App compilado.** O nome foi trocado no fonte (`frontend/`) e, por troca literal, no `index.html` e no bundle já construídos. Um build novo sai igual.
- **PWA instalado.** Alguns sistemas guardam o `short_name` antigo até o atalho ser reinstalado. O service worker se atualiza porque o `sw.js` mudou, mesmo com o `VERSAO` igual.

## Lateral recolhível (22/10/2026)

- No computador (> 900px) a lateral recolhe a uma faixa de ícones pelo botão do alto dela ou por Ctrl+B / Cmd+B. A escolha fica no cookie `csso_lateral=recolhida` (1 ano, `SameSite=Lax`) e a casca (`base.html`) já a desenha com a classe no `<html>`. No celular e na impressão nada muda (`csso.css`, bloco «LATERAL RECOLHIDA»; teste em `testes/lateral_recolher.test.ts`).

## Minha conta (22/10/2026)

Pedido do usuário: uma tela em que **toda conta logada** cuida de si mesma. Rota `/minha-conta` (`src/rotas/minha_conta.ts`, `templates/paginas/minha_conta.html`; testes em `testes/minha_conta.test.ts`).

- **Portas.** O nome e o avatar no cabeçalho (`base.html`, link `.conta-propria`) levam à tela em qualquer conta. Abaixo de 1040px o nome some e o avatar é o alvo; o nome acessível vem do `aria-label`. Em «Meu espaço» (`modulos.meu_espaco_de`) o item «Minha conta» fecha o bloco, **só para quem já tem o bloco**: a equipe sem vínculo de servidor continuaria sem «Meu espaço» e ganharia a lateral de um item só. Para ela a porta é o nome. O item não exige permissão (`Item(..., null)`).
- **Sem `exigir(...)`, de propósito.** Toda rota usa só o id da sessão. Nenhum id de conta vem da URL ou do formulário, e nada daqui toca em perfil, atribuição, vínculo de servidor ou habilitação, que continuam em /usuarios com as permissões de governança. CSRF: o middleware de origem de `app.ts`, como nas outras rotas POST.
- **Dados pessoais.** Nome, telefone e ramal. Telefone e ramal são colunas novas em `usuario` (migração **0013_usuario_telefone_ramal**, gerada pelo drizzle-kit, com snapshot e `_journal.json`), opcionais, e o campo em branco apaga. Validação: só dígitos, espaço, parênteses, hífen e `+`. O telefone tem de 8 a 15 dígitos (fixo sem DDD até E.164) e no máximo 30 caracteres; o ramal, de 1 a 8 dígitos e no máximo 12 caracteres. A finalidade aparece na tela antes do campo (LGPD art. 6º, I): «usados só para a equipe do setor falar com você sobre treinamentos, EPIs e processos». Eles **não** aparecem em outra tela por enquanto. Expor o contato à equipe (na ficha do servidor, na turma) fica para quando houver o pedido, e a finalidade já declarada cobre esse uso.
- **E-mail.** Trocar o e-mail pede a **senha atual**, conferida por `autenticacao.conferir_senha_atual`. É o mesmo teto de tentativas da troca de senha (M74): errar conta como tentativa de entrada, e no teto a conta bloqueia e as sessões caem. A unicidade reaproveita `_duplicada` de /usuarios (agora exportada): sem caixa e cruzada com o login (D12, índices da 0012). A recusa **não diz de quem é** o e-mail, porque a tela abre para qualquer conta e não pode virar consulta de dono de e-mail. Ela manda falar com a coordenação. As outras sessões não caem: a senha não mudou.
- **Senha.** A tela leva a `/trocar-senha` em vez de repetir o formulário, porque lá já estão a política, a barra de força e o encerramento das outras sessões. Um segundo formulário seria um segundo lugar para a mesma regra.
- **Sessões.** A lista de sessões abertas (com «encerrar» uma ou todas as outras) entrou e saiu no mesmo dia, antes de qualquer implantação, por decisão do usuário. No lugar, a sessão parada cai sozinha em 60 minutos, com aviso no navegador: ver «Desligamento por inatividade (22/10/2026)». Saíram as rotas `POST /minha-conta/sessoes/...`, os resumos de navegador e de rede e o tipo de evento `SESSAO_ENCERRADA_PELO_TITULAR` (nenhum evento dele chegou a ser gravado fora dos testes).
- **Perfis e vínculo de servidor: só leitura.** Aparecem os perfis vigentes e os futuros («começa em»), com coordenadoria, campus («todos os campi» quando a concessão não tem) e período. Do servidor vinculado aparecem nome, SIAPE, cargo, lotação e postos atuais. O titular vê o próprio SIAPE (art. 18, II), e a leitura não gera registro de acesso a dado sensível, como em «Meus certificados». As duas seções dizem «para corrigir, fale com a coordenação».
- **Trilha: dois tipos novos**, com rótulo em `ROTULO_EVENTO`, sem reescrever nada gravado: `CONTA_DADOS_ALTERADOS_PELO_TITULAR` e `EMAIL_ALTERADO_PELO_TITULAR` (o terceiro, `SESSAO_ENCERRADA_PELO_TITULAR`, saiu com a lista de sessões). Não se usou `USUARIO_ALTERADO`, que é o ato de quem administra contas: «quem mudou meu e-mail?» tem resposta diferente quando foi o titular. Os dados pessoais geram **um** evento por envio, com `campo` = os nomes dos campos mudados («nome,telefone,ramal») e **sem valores**, porque o telefone não vai para uma trilha que não se apaga. O e-mail grava antes e depois, como o `USUARIO_ALTERADO` de /usuarios, por ser credencial. Envio sem mudança não gera evento.
- **Máscara de CPF na porta.** O telefone passa pela máscara de CPF de `dependencias.formulario`, como todo campo livre. Onze dígitos seguidos que formem um CPF válido viriam mascarados e seriam recusados pela validação. Quem cair nisso escreve com a formatação («(38) 99999-1234»), que a máscara não pega. A exceção não foi aberta para o campo.
- **Ícone.** `person-gear` entrou em `ferramentas/icones.txt` (folha regerada).

## Desligamento por inatividade (22/10/2026)

Pedido do usuário, no lugar da lista de sessões de «Minha conta»: a conta parada se desconecta sozinha, com aviso. Testes em `testes/inatividade.test.ts`.

- **Limite.** `CSSO_SESSAO_INATIVIDADE_MINUTOS` passou de 120 para **60** por padrão (0 continua desligando). O teto absoluto de 12 h (`CSSO_SESSAO_HORAS`) não mudou. O argumento das duas horas era o parecer escrito com o SEI aberto ao lado; ele agora é coberto pela renovação ao digitar (abaixo) e pelo aviso.
- **Tolerância de um passo no servidor.** O `ultimo_uso_em` só é regravado de minuto em minuto, então pode estar até 1 min atrás do último pedido. `sessao_valida` derruba quando a coluna passa de `limite + 1 min`: a sessão nunca cai antes dos 60 minutos que o aviso promete, e cai no máximo aos 61.
- **O atributo.** A casca escreve `data-sessao-inatividade="60"` no `<body>` só em página logada e só com o limite ligado (`web.ts` põe `sessao_inatividade_minutos` no contexto de toda página).
- **O aviso** (`csso.js`, bloco 12, e `csso.css`, «O AVISO DE INATIVIDADE»). Aos 55 minutos sem atividade abre um `<dialog role="alertdialog">` com «Por segurança, você será desconectado em 5 minutos por inatividade.», contagem regressiva e dois botões. «Continuar conectado» (com o foco ao abrir) faz `GET /quem-sou-eu`, que passa por `sessao_valida` e regrava o último uso. Não foi preciso rota nova: é GET, que não escreve dado de negócio, e por isso não pede CSRF. «Sair agora» é um formulário `POST /sair` comum. `Esc` não desconecta: vale como «continuar». No celular o aviso fica uma caixa centrada, e não a tela inteira dos outros popups. Com `prefers-reduced-motion` a contagem mostra minutos em vez de correr por segundo. O leitor de tela ouve o texto ao abrir e um lembrete por minuto.
- **No prazo**, a página faz `POST /sair` (a sessão não fica viva no servidor) e vai a `/login?motivo=inatividade&proximo=<a tela>`. O login mostra «Sua sessão foi encerrada por inatividade.» O texto vem da tabela `MOTIVOS` e nunca da URL. A consulta passou a usar `Object.hasOwn`, porque `?motivo=toString` achava o método herdado.
- **O que conta como atividade** é o que o servidor conta, ou seja, pedido: carregar página, enviar formulário, troca parcial do HTMX, o download do bloco 4 e o botão do aviso. Mexer o mouse não conta, porque o servidor não o vê. A exceção decidida é **digitar num campo de formulário** (ou no editor do parecer): isso dispara o mesmo `GET /quem-sou-eu`, no máximo um a cada 5 minutos. Quem escreve um parecer longo sem enviar não é desconectado no meio do texto. Se essa renovação falhar, nada acontece na tela, para não tirar a pessoa do texto.
- **Várias abas.** O horário da última atividade fica no `localStorage` (`sisa.sessao.ultima-atividade`, com `try/catch`). Cada aba conta a partir do mais recente, então a aba esquecida não derruba a sessão que outra está usando. O evento `storage` fecha o aviso nas outras abas quando uma renova. Valor do futuro na chave é ignorado.


## Liberação de módulos e turmas por setor (22/10/2026)

Decisões do usuário: (A) liberar o acesso módulo por módulo, por perfil e por pessoa; (B) a equipe de cada setor promotor vê e gere só as turmas do próprio setor. Migração **0014_niveis_modulo_setores** (drizzle-kit, com snapshot e `_journal.json`; o `INSERT` do fim é escrito à mão).

### A) Liberação por módulo

- **O mapa mora num lugar só**: `src/servicos/niveis_modulo.ts` (`MODULOS_NIVELADOS`). Três níveis, *sem acesso*, *consulta* (as de leitura) e *operação* (leitura e escrita):
  - **Processos SEI** — consulta: `processo.ver`, `parecer.ver`, `laudo.ver`; operação acrescenta `processo.criar`, `processo.editar`, `processo.status`, `processo.atribuir`, `parecer.criar`, `parecer.editar`, `parecer.emitir`, `parecer.anular`, `anexo.enviar`.
  - **Gestão de EPI** — consulta: `epi.ver`, `epi.ficha` (ler a ficha de outro continua indo para `acesso_dado_sensivel`); operação acrescenta `epi.catalogo`, `epi.entregar`, `epi.estoque`, `epi.requisitar`, `epi.analisar`.
  - **Certificados e Treinamentos** — consulta: `treinamento.ver`, `certificado.ver`; operação acrescenta `treinamento.gerenciar`, `turma.criar`, `turma.inscrever`, `turma.concluir`, `turma.avaliar`, `certificado.emitir`, `certificado.anular`, `participante.mesclar`.
  - **Demandas** (base, mas é item de menu e tem leitura/escrita limpas) — consulta: `demanda.ver`; operação: `demanda.registrar`.
  - Acidentes, CISSP e PGR ainda não têm permissão e não aparecem.
- **Só do perfil, nunca do módulo** (`PERMISSOES_SO_DO_PERFIL`): `parecer.assinar`, `laudo.criar` (habilitação, IN 15/2022), `assinatura.gerenciar` (assinatura), `perfil.conceder`, `usuario.criar_conta`, `usuario.resetar_senha`, `habilitacao.atestar`, `auditoria.ver`, `backup.executar` (administração), `exposicao.ver` (dado nominal, RN-19: segue o cargo), `indicador.ver` e `exportar` (transversais), `catalogo.gerenciar` (configuração do setor), `turma.inscrever_se` (titular) e `turma.todos_os_setores` (alcance de setor). `rbac._conferir_niveis` derruba a importação se uma permissão de `PERMISSOES` não estiver num módulo nem nesta lista, ou estiver em dois lugares: permissão nova obriga a decidir.
- **Padrão = como era.** Linha ausente em `perfil_nivel_modulo` é o padrão do perfil (as permissões de `perfil_permissao`); linha ausente em `usuario_nivel_modulo` é «seguir o perfil». Por isso a migração não insere nível nenhum e **nenhum acesso muda no dia da implantação** (teste em `niveis_modulo.test.ts`). Como o padrão de vários perfis é um pedaço do módulo (o técnico emite e não anula certificado), a tela mostra a opção «Padrão (parcial)», além dos três níveis; escolher «Padrão» apaga a linha.
- **`semear_rbac` não desfaz o ajuste**: ele continua cuidando só de `perfil_permissao` (o padrão) e nunca toca as tabelas de nível. Permissão que o semeio acrescente a um perfil com nível gravado naquele módulo não tem efeito: o nível vence.
- **Cálculo efetivo**: `rbac.perfis_vigentes` aplica, em cada concessão de perfil, perfil → nível do módulo → exceção da pessoa (`niveis_modulo.permissoes_com_niveis`). O `UsuarioAtual`, o menu, as rotas, o `pode()` dos templates e as travas de governança (D2/D4, que usam `perfis_vigentes`) enxergam o efeito sem mudança. Os níveis vêm na mesma consulta das atribuições (relações do Drizzle): nenhuma ida a mais ao banco por pedido.
- **Escopo vem do perfil**: o nível muda *quais* permissões a concessão traz, nunca o alcance dela (campus, unidade). A exceção da pessoa vale sobre cada concessão de equipe da conta. Perfis de **escopo próprio ou agregado** (`servidor_consulta`, `admin_ti`) **não se ajustam por módulo** (`rbac.aceita_nivel_modulo`): operação em escopo próprio daria, por exemplo, entregar EPI a si mesmo, e o agregado não lê linha. A concessão do titular (`@titular`) também não muda. Conta sem perfil de equipe não recebe módulo pela exceção («conceda um perfil antes»); «sem acesso» e «seguir o perfil» são sempre aceitos.
- **Relatório do módulo**: `indicador.ver` é transversal e ficou no perfil, mas «sem acesso» a um módulo tem de fechar o relatório dele. `/relatorios` exige também `processo.ver` de equipe, `/epis/relatorios` `epi.ver` e `/treinamentos/indicadores` `treinamento.ver`; o item de menu declara as duas (`Item.tambem`, novo parâmetro de `modulos.ts`). Nenhum perfil semeado perde nada com isso (todos que têm `indicador.ver` têm as três).
- **Quem grava**: só quem tem `perfil.conceder` (o superintendente). A tela `/perfis/niveis` abre para quem abre a matriz, só leitura para os demais. **Ninguém eleva o próprio acesso**: a exceção e os setores da própria conta não se editam; o nível de um perfil que a pessoa tem (vigente ou futuro) só desce. **Ninguém dá mais do que tem** (D2): cada permissão acrescentada tem de estar no alcance de equipe de quem age, cobrindo o alcance da concessão. Um envio é tudo ou nada (ponto de salvamento): a recusa de um módulo desfaz os outros do mesmo formulário.
- **Telas**: `/perfis/niveis` (nova, abas por perfil; tabela módulo × nível com as quatro opções em pílulas, 2 × 2 no computador e empilhada no celular; ao lado, o que vale hoje; embaixo, o mapa e a lista do que é só do perfil). `/perfis` passa a mostrar as permissões efetivas e marca «ajustado por módulo». Em `/usuarios`, o «Gerir» da conta ganhou «Acesso por módulo» (seguir o perfil / sem acesso / consulta / operação) e «Setores promotores».
- **Trilha**: tipos novos `NIVEL_MODULO_PERFIL_ALTERADO` (entidade `perfil`) e `NIVEL_MODULO_PESSOA_ALTERADO` (entidade `usuario`, aparece no «Histórico desta conta»), com `campo` = `modulo:<código>`, `valor_anterior`/`valor_novo` = o nível ou `PADRAO`, e a descrição com os rótulos («Padrão do perfil (Parcial) → Consulta»). Um evento por módulo mudado; envio sem mudança não grava.

### B) Turmas por setor promotor

- **Vínculo conta × setor**: tabela `equipe_setor_promotor` (uma conta pode estar em vários setores). Quem vincula é quem administra acesso (`perfil.conceder`), no «Gerir» da conta em `/usuarios` (caixas dos setores com `promove_treinamento`); a própria conta não se edita. Cada setor que entra ou sai é um evento `SETOR_PROMOTOR_VINCULADO` / `SETOR_PROMOTOR_DESVINCULADO` (entidade `usuario`, `campo` = `setor_promotor`, valor = a sigla).
- **Ninguém perde acesso no dia**: a migração 0014 vincula ao setor CSSO toda conta com concessão vigente ou futura dos perfis da equipe da CSSO (`coordenador_csso`, `engenheiro_seguranca`, `medico_trabalho`, `tecnico_seguranca`, `secretaria_csso`, `almoxarife_sesmt` — `rbac.PERFIS_DA_EQUIPE_CSSO`), com `vinculado_por` nulo (= «pela migração»; SQL de migração não grava na trilha encadeada). O povoamento do ambiente de teste e o `criarUsuario` dos testes fazem o mesmo (opção `setores` para outro setor ou nenhum).
- **Quem vê todas**: permissão nova `turma.todos_os_setores`, concedida a `coordenador_csso` e `superintendente` (a coordenação) e a `auditor_interno` e `consulta_progep` (leem o módulo inteiro por ofício). O semeio a acrescenta aos perfis já gravados no deploy, com `PERMISSAO_ACRESCENTADA_AO_PERFIL` na trilha. Não se libera por módulo.
- **O recorte** (`src/servicos/setor_equipe.ts`) entra nas portas centrais: `turma.consulta_no_escopo`/`no_escopo` (lista, ficha e todos os atos de turma, pedidos pelo link, fila de emissão, hub, API), `emissao_certificado.no_escopo` (ficha, segunda via, PDF, anular, corrigir, anexo, envio), a lista `/certificados`, reciclagem (`/certificados/vencimentos`), indicadores, a caixa de e-mails e a busca global. A turma de outro setor some da lista, e a ficha e os atos seguem o padrão já existente das rotas quando `no_escopo` não acha (redirecionam à lista, 303), como para turma de outro campus.
- **Turma sem setor promotor** (as de antes da 0011) conta como **da CSSO**: até ali só a CSSO operava o módulo. Os dados não foram reescritos (o «promovido por» do certificado não muda). Certificado e e-mail seguem a turma da inscrição; o e-mail que não aponta para turma nenhuma (o link de acesso aos certificados) fica com a CSSO.
- **Conta de equipe sem setor** e sem `turma.todos_os_setores`: nenhuma turma, e as telas da equipe do módulo mostram o aviso «Sua conta não está vinculada a nenhum setor promotor… Peça à coordenação para vincular você ao seu setor» (`templates/partes/aviso_sem_setor.html`). O titular puro nunca vê o aviso.
- **O titular** continua vendo as próprias inscrições e certificados de qualquer setor e o cartaz das turmas abertas (`/turmas/minhas`, `/certificados/meus`, inscrever-se): o recorte só vale para o alcance de equipe. O membro da equipe que fez curso de outro setor lê o próprio certificado pela ficha e por «Meus certificados», mas ele não aparece nas listas da equipe.
- **Criar e editar turma**: quem não vê todos só escolhe entre os seus setores (o seletor só os oferece; com um setor só, ele já vem marcado; em branco com vários, recusa). Na edição não pode mover a turma para setor alheio nem apagar o setor gravado; a turma antiga sem setor pode ser editada sem escolher.
- **Fora do recorte**, de propósito: a mesclagem de participantes (a pessoa não é de setor), o catálogo de treinamentos, os modelos de certificado e a contagem de turmas por unidade em `/treinamentos/setores-promotores` (catálogo). O processamento manual da fila de e-mails (`POST /certificados/emails/processar`) continua global.
- **Modo compatibilidade**: `UsuarioAtual` montado à mão nos testes (`concessoes === null`) não sofre recorte de setor.

## Celular lotes A–F (22/10/2026)

Execução do plano de celular (P1 a P20) em lote 0 (casca, `csso.css`, `csso.js`) e seis lotes de tela, sem mudar a mesa (toda regra nova fica em faixa de largura, `(pointer: coarse)` ou `(hover: hover)`, antes do `@media print`, que continua sendo o último bloco).

- **Lotes de tela**: A, certificados (listas empilháveis, `curta`, `marca-linha` nas filas); B, turmas e treinamentos (inscrições, instrutores, participantes com Manter/Juntar em `acao-linha`, teclado certo em carga/vagas/nota); C, processos, pareceres, demandas, pendências, laudos e kanban (`title` na trilha de título livre, listas empilháveis, fichas que rolam de lado); D, EPIs (fichas empilháveis, `coluna-fixa` em relatórios e movimentos, valor unitário decimal); E, servidores e administração (servidores e auditoria empilháveis, `coluna-fixa` em relatórios e config, /perfis em `details.cartao.perfil`); F, telas públicas (`autocapitalize`/`autocorrect`/`spellcheck` nos campos de identificação). Testes em `testes/celular_*.test.ts`.
- **Fechamento (ajustes que os lotes deixaram para a folha e para outros arquivos)**:
  - Abaixo de 480px, `.tela-auxiliar .cartao` (20px 12px) e `.cartao-erro` (22px 14px): a 360px sobram ao menos 300px de área útil.
  - Kanban: a coluna passou de `86%` do quadro (78% da tela) para `calc(86vw - 4px)` (≈85% da tela).
  - A cor do tipo no cartão do kanban saiu de `style="--cor-tipo: …"` para `data-cor-tipo`: o `csso.css` traduz as nove cores semeadas e o `csso.js` aplica pelo CSSOM um hexadecimal que a folha não conheça. Caiu a exceção de `testes/celular_processos.test.ts`.
  - No cartão empilhado: `td.numerico` à esquerda; o `.recorte` (26ch e reticências) é liberado (a unidade em /laudos); a célula `acao-linha` que abre o cartão não leva o divisor de cima; o «ações» da gaveta (`.abre-gaveta`) divide a linha com o vizinho quando cabe. Em /treinamentos/participantes o rádio e a caixa ficam com 22px dentro de `label.alvo-marca` de 44×44 (classe neutra na mesa).
  - Grade de presenças da turma com `table.coluna-fixa` (o nome do participante fica parado ao rolar os dias).
  - Itens do pedido de EPI (`partes/itens_do_pedido.html`, 847px a 390): `table.empilhavel`, com o equipamento como título, tamanho/quantidades/estado em `curta` e o «ações» em `acao-linha`. A troca parcial (HTMX) devolve o mesmo arquivo; o teste de EPI passou a esperar `<table class="empilhavel">`.
  - Texto de apoio de 13px (`.discreto`, `.quebra`, `.nota`, `.mono`, rótulo de campo, botão secundário, avatar e afins) sobe para 14px abaixo de 600px: as ocorrências abaixo de 14px a 390 caíram de 29.005 para 3.462. As regras mais específicas que encolhem de propósito (NUP do kanban, selo, versalete) continuam valendo.
  - O teste `celular_casca.test.ts` passou a aceitar a faixa de 480px e a classe-contrato `label.alvo-marca`.
  - /auditoria: **páginas menores para todos** (eventos 100 → 50, acessos 50 → 25, `src/rotas/auditoria.ts`). No telefone cada linha vira cartão e a tela tinha 47 mil px (agora cerca de 24 mil); não se diferencia por user-agent. A célula da conta continua `<td>` puro (exceção da RN-19 em `privacidade_varredura.test.ts`).

## Paridade de EPI com o IntegraSST (22/10/2026)

Fecha as seis lacunas do mapa de paridade (EPI do IntegraSST × Gestão de EPI do SISA), com as cinco decisões do usuário. Migração única **0015_epi_paridade** (drizzle-kit, com snapshot e `_journal.json`; duas partes escritas à mão: `termo_exigido` nasce `false` nos pedidos antigos e o `motivo` dos itens antigos é preenchido pela finalidade). **Nenhuma permissão nova**: tudo usa `epi.*`, `indicador.ver` e `exportar`, e o mapa de `niveis_modulo.ts` não mudou.

- **A — o titular comunica o EPI que está com ele.** Em «Minha ficha», cada entrega vigente tem «Comunicar»: extraviado, ou troca por desgaste físico, tempo de uso, perda de eficácia ou alterações no trabalho (`L:EPI_Frontend.html:976-1005`). Tabela nova `epi_comunicacao_titular`, que não se apaga (trigger de DELETE/TRUNCATE): o titular **retira** em até 24 h (conferido no servidor, não só no navegador como no legado) e a equipe (`epi.entregar`) **trata** a qualquer tempo. A comunicação abre a pendência `EPI_COMUNICACAO_A_TRATAR` (10 dias, sem responsável) e oferece o pedido de troca já preenchido (`/epis/requisicoes/nova?item=&tamanho=&motivo=&finalidade=&comunicacao=`, que liga o pedido à comunicação). **Desvio do legado:** a comunicação não muda a ficha nem o estoque — a ficha é prova, append-only, e a devolução física continua ato da equipe. «Extraviado» tem texto neutro e não gera cobrança (Decisão 5). A devolução da equipe grava também `motivo_codigo` (a mesma lista, mais desligamento e outro), coluna congelada na trava da ficha. **Devolver uma entrega com comunicação aberta trata a comunicação** (decisão do usuário): marca tratada, fecha a pendência e grava `EPI_COMUNICACAO_TRATADA` com `campo` = `origem` e `valor_novo` = `DEVOLUCAO` (o rótulo do evento não muda), citando o número da devolução.
- **B — motivo por item e termo NR-06.** `epi_requisicao_item.motivo` (uso inicial, desgaste, dano, extravio — `L:EPI_Frontend.html:704`); item novo sem motivo é recusado; a finalidade do pedido continua (os indicadores a leem). O termo (`L:EPI_Frontend.html:727-732`) vem **desmarcado** e é declarado por **quem envia** (Decisão 3; pode ser a chefia): grava conta, instante e versão (`TERMOS_NR06`, versionado em `dominio/epi.ts` — texto publicado não muda, muda a versão). CHECK `ck_req_termo` só para pedidos novos (`termo_exigido`). **Desvio do legado:** o legado não gravava o aceite.
- **C — foto e PDF de orientação no catálogo.** Categoria de anexo nova `EPI_CATALOGO`; o tipo é conferido pelos bytes (PDF, PNG, JPEG, WEBP), foto até 2 MB e PDF até 4 MB. Anexo nunca é substituído: trocar é apontar para um anexo novo. A entrega **congela** o PDF vigente em `epi_ficha_registro.orientacao_anexo_id` (Decisão 4; coluna congelada na trava), e a ficha antiga continua no PDF antigo. **Desvio do legado:** nada de link público do Drive; os arquivos ficam no Storage atrás de rota com login (`/epis/catalogo/{id}/imagem`, `/orientacao`, `/epis/fichas/registros/{id}/orientacao`). O download genérico `/anexos/{id}` continua negando anexos de `epi_item` (sem resolvedor em `anexo_acesso.ts`).
- **D — indicadores por período, por EPI e por cargo.** `/epis/relatorios` aceita período livre (`inicio`/`fim`, até 5 anos, 422 para período invertido ou data inválida), mantendo o exercício. Blocos novos: total entregue, ranking por EPI, distribuição por cargo (`cargo_snapshot`) e devoluções/extravios; estornos fora. Supressão RN-19 abaixo de 5 pessoas, com supressão secundária; no ranking a linha suprimida vai para o fim, para a posição não revelar o valor. CSV com os mesmos blocos. Os blocos novos usam barras (`ui.distribuicao`), não tabela, porque a tela já trava duas tabelas `coluna-fixa` no celular.
- **E — `exige_treinamento` passa a valer** (lacuna do SISA, não do legado). Tabela `epi_item_treinamento`, configurada no catálogo. Na análise e na entrega aparece «sem treinamento em vigor» (certificado `EMITIDO`, vigente na data); a equipe de EPI vê só sim/não, nunca o certificado. **Não bloqueia** (Decisão 2): sem a caixa «Entrego mesmo sem treinamento em vigor» a entrega volta com o aviso; com ela, evento `EPI_SEM_TREINAMENTO_CONFIRMADO` e a confirmação congelada em `contexto_congelado` (a ficha mostra a pílula para a equipe). A recusa pelo motivo `SEM_TREINAMENTO` continua possível. Vincular marca o item como «exige»; desvincular o último não desmarca, e o catálogo avisa que não há o que conferir.
- **F — e-mail (Decisão 1), DESLIGADO por padrão.** Retoma o que a versão 1.36.0 recusara (antes de existir a caixa de saída): na abertura do pedido avisa o setor (`CSSO_EPI_EMAIL_SETOR`) e o requerente; na decisão (e na retirada disponível, repetindo o sino) avisa o requerente. Liga com `CSSO_EPI_EMAIL=sim`; sai pela caixa de saída (`email_saida`) quando `CSSO_SMTP_URL` e `CSSO_EMAIL_REMETENTE` estiverem configurados — até lá fica PENDENTE. Texto puro (sem o HTML sem escape do legado), sem nome, CPF, riscos nem o texto da recusa. **Sem falha silenciosa** (o legado engolia o erro): cada aviso grava `EPI_EMAIL_ENFILEIRADO` no histórico do pedido dizendo o que foi e o que não foi enfileirado e por quê; endereço inválido não derruba o pedido. Nada na entrega (como já decidido em 1.36.0). O aviso de retirada é **um e-mail por pedido e por ato de reserva** (decisão do usuário), listando todos os itens do pedido já separados naquele momento; itens reservados no mesmo ato saem na mesma mensagem (a segunda reserva reescreve o corpo ainda na fila), e reservas em atos diferentes geram um e-mail cada. O sino continua com uma pendência por item.
- **G — contagem de pedidos a analisar.** Cartões no painel `/epis` («Pedidos a analisar», para `epi.analisar`, com o escopo da fila; «Comunicações do titular a tratar», para `epi.entregar`) e no Início (só quando há o que fazer). **Continua fora do menu**, como decidido em «Menu de Certificados e Treinamentos em grupos». No Início as duas contagens saem numa consulta só (a rota está em 29 de 30 idas ao banco).
- **Trilha (tipos novos, com rótulo):** `EPI_COMUNICACAO_REGISTRADA`, `EPI_COMUNICACAO_RETIRADA`, `EPI_COMUNICACAO_TRATADA`, `EPI_REQUISICAO_TERMO_ACEITO`, `EPI_ITEM_IMAGEM_ENVIADA`, `EPI_ITEM_ORIENTACAO_ENVIADA`, `EPI_ITEM_TREINAMENTO_VINCULADO`, `EPI_ITEM_TREINAMENTO_DESVINCULADO`, `EPI_SEM_TREINAMENTO_CONFIRMADO`, `EPI_EMAIL_ENFILEIRADO`. Pendência nova: `EPI_COMUNICACAO_A_TRATAR`.
- **Ajustes decididos pelo usuário (22/10/2026, mesma data):**
  - **«Separar todos» no pedido** (`POST /epis/requisicoes/{id}/separar-todos`, permissão `epi.estoque`, a mesma da reserva): num único ato, reserva todo item APROVADO ou SEM_ESTOQUE com quantidade devida que tenha lote que a cubra inteira — lote ativo, com CA do LOTE válido (RN-25), do mesmo tamanho, com disponível = físico − reservado; ganha o CA que vence primeiro. Cada reserva passa por `reservar_item` (mesmo `EPI_ITEM_RESERVADO`, mesma pendência de retirada). Item sem lote suficiente fica como está e o recado diz quais faltaram e por quê; não há reserva parcial automática (a parte que existe se reserva item a item, que continua possível). Como é um ato só, sai **um** e-mail de retirada com a lista.
  - **Catálogo: um envio por arquivo.** Foto (`POST /epis/catalogo/{id}/imagem`) e PDF (`POST /epis/catalogo/{id}/orientacao`) têm cada um o seu formulário e botão, no popup «Foto e orientação» da linha; mandar os dois na mesma requisição é recusado sem gravar nada, e a edição do item voltou a ser formulário comum (arquivo nela é recusado com aviso). Assim nenhum corpo passa dos 6 MB da função do Netlify. A rota `POST /epis/catalogo/{id}/anexos` saiu. Conferência por bytes e limites (2 MB, 4 MB) inalterados.
  - **Balcão: a etiqueta de treinamento acompanha o servidor.** Trocar quem recebe dispara de novo o `hx-get` do bloco do item já escolhido (contrato `data-ao-trocar-dispara` no contêiner do seletor de servidor, tratado em `csso.js`; o contêiner, e não o `<select>`, porque a busca HTMX substitui o seletor inteiro). A conferência ao gravar continua.

## Portal do servidor (22/10/2026)

Área do titular inspirada na área de membros da ABHO: Início com o resumo do servidor, Meus certificados em cartões, comprovante de treinamentos, Minha atividade, Meus treinamentos com .ics e Meu perfil (que é a página `/minha-conta`, sem uma segunda tela). Migração única **0016_portal_servidor** (drizzle-kit, com snapshot e `_journal.json`, e partes escritas à mão, descritas abaixo). **Nenhuma permissão nova e nenhum tipo de evento novo**: a trilha de `CERTIFICADO_EMITIDO` passa a levar também `numero_impresso` em `valor_novo`, e a aparência do setor grava `CAMPO_ALTERADO`. Textos de auditoria já gravados não mudam.

- **Número do certificado (decisão do usuário).** Certificado emitido daqui em diante: `SIGLA-CÓDIGO-ANO-SEQ`. São a sigla do setor promotor da turma (até 12), o código curto do treinamento (2 a 10, letras e algarismos), o ano e uma sequência anual de 4 dígitos (ex.: `CSSO-NR35-2026-0001`). Fica em `certificado.numero_impresso` (UNIQUE, CHECK de formato). A sequência é por prefixo e ano, na tabela `certificado_sequencia_prefixo`, com `UPDATE … RETURNING` (RN-03: sem MAX+1 e sem buracos por concorrência). O número entra no congelado (RN-15), e o trigger `trg_certificado_numero_imutavel` recusa mudar `numero_impresso`, `chave_validacao`, `numero` e `ano`. Certificado antigo mantém o que foi impresso (`n/ano`). **Turma sem setor promotor usa o prefixo `SISA`** (`SIGLA_PADRAO_NUMERO`), e isso precisa de decisão do usuário. Pendências: os campos `certificado_numero`/`certificado_ano` do modelo .docx continuam devolvendo o número interno (convém um aviso na tela de modelos ou um campo novo), e o nome do arquivo .docx também usa o número interno.
- **Chave de validação.** A chave do QR e do link é o número mais 5 caracteres sorteados, sem os ambíguos (ex.: `CSSO-NR35-2026-0001-K7QMX`), para não ser adivinhável. O número sozinho não valida. `/validar` continua aceitando as chaves antigas (`CSSO-AAAA-…`) e aceita a nova sem traços quando há exatamente um certificado que bate; essa busca não tem índice, o que é aceitável no volume atual. A página diz «{sigla do setor} confirma». `textos.parece_cpf` deixou de tratar número ou chave de certificado como CPF (a chave nova pode somar 11 algarismos por acaso, e a busca deixava de filtrar).
- **Código curto do treinamento (obrigatório).** `treinamento.codigo_curto` (UNIQUE, CHECK `[A-Z0-9]{2,10}`). O catálogo sugere o código a partir do nome (`sugerir_codigo_curto`: NR citada → `NR35`; senão o código do catálogo sem pontuação; senão as iniciais), com `data-sugerir-codigo-curto` em `csso.js`, e a equipe pode editar. A migração preencheu os treinamentos existentes pelas funções SQL `csso_sugerir_codigo_curto`/`csso_codigo_curto_livre` (iguais às de `travas.sql`). O trigger `trg_treinamento_codigo_curto` preenche a sugestão quando o código chega vazio (inserção direta, sementes).
- **Janela «a vencer» única de 60 dias** (`JANELA_A_VENCER_DIAS` em `dominio/treinamento.ts`). Unificou o aviso de reciclagem, o card do painel (era **90**), o filtro de certificados, o aviso de CA de EPI e **o aviso de vencimento da governança de acesso (era 30)**. A mudança na governança precisa de confirmação do usuário.
- **Turma com hora.** `turma.hora_inicio`/`hora_fim` (`time`, opcionais, CHECK fim > início quando as duas existem). Turmas antigas ficam sem hora e continuam válidas. Há filtro por turno (`?turno=`) e .ics por turma (`/turmas/minhas/{id}/agenda.ics`, anexo também ao e-mail de aceite; o UID é estável por dia em turmas de vários dias). Pendências: o link dentro do .ics aponta para `/turmas/{id}`, que pede login; a lista de presença, a retificação e o texto do e-mail ainda não mostram a hora; o rótulo «Comunidade externa» falta em `turmas_pedidos`.
- **Comunidade externa só quando a equipe marca.** `turma.aceita_comunidade_externa` (padrão `false`). **A migração marcou `true` nas turmas que já tinham `inscricao_publica`**, para os links públicos já divulgados continuarem abertos; isso precisa de confirmação do usuário.
- **Cor e ícone por setor**: paleta da subseção seguinte, aprovada pelo usuário em 23/10/2026. Também confirmados em 23/10: turmas com link público já divulgado ficam abertas à comunidade externa; a janela única de 60 dias vale para o aviso de vencimento de acesso (antes 30) e para o cartão do painel (antes 90); turma sem setor promotor emite com prefixo SISA.
- **Minha atividade.** Linha do tempo do titular (UNION ALL sobre a trilha, `EVENTOS_DO_TITULAR`). O agente aparece como «Você», «Equipe {sigla}» ou «Equipe SISA», **nunca o nome de quem operou**. As consultas a dados sensíveis do servidor (leitura nominal, auditoria de acesso) **não aparecem** para ele. Índice novo `ix_hist_entidade_quando`.
- **Início do servidor.** Saudação, chips (lotação, cargo, campus, último acesso anterior, que vem da penúltima sessão), avisos, cartões, últimos certificados e atalhos; na lateral, o cartão «Meu espaço» com iniciais e lotação, preenchido pelo gancho novo `cartaoMeuEspaco` da casca (`web.ts`, ligado em `modulos.ts`).
- **Meus certificados.** Cartões com situação, filtros em pílulas (Todos, Válidos, A vencer, Vencidos), ficha leve do titular, comprovante imprimível (`/certificados/meus/comprovante`, com `@page` e sem `@media print` no meio da folha) e anulados recolhidos. O certificado superado por reciclagem só aparece em «Todos». Os mesmos cartões valem no acesso sem conta. **Ficaram de fora** o comprovante e o conteúdo programático em PDF (opcionais na especificação). O conteúdo programático é por treinamento, como decidido, e não houve migração de dados. O ícone de reciclagem é `clock-history`, porque o sprite não tem `arrow-repeat`.
- **Meu perfil.** São as seções de `/minha-conta` (o telefone e o ramal já existiam). Pendências: **o contato do encarregado de dados (LGPD) não existe na configuração**, e **a data de ingresso do servidor não existe no esquema**. As duas ficaram fora da tela.
- **Endereço público**: QR, cartaz e e-mail usam a URL base configurada (`CSSO_URL_PUBLICA`), nunca um domínio fixo.
- **Celular**: todas as telas do servidor foram conferidas a 360 px sem rolagem lateral; as pílulas de filtro rolam dentro da própria faixa. O CSS novo está no bloco «PORTAL DO SERVIDOR», antes de «CELULAR (lote 0)», e o `@media print` continua o último.

### Proposta de cor e ícone por setor (aprovada em 23/10/2026)

Cada setor promotor tem cor e ícone de uma **paleta fechada** (`CORES_SETOR` e `ICONES_SETOR` em `src/dominio/organizacao.ts`; CHECK em `unidade_uorg.cor_setor`/`icone_setor`). A migração 0016 e a semente aplicam a proposta abaixo nos cinco setores da Sisa; a equipe troca em **Treinamentos → Setores promotores → Aparência** (permissão `treinamento.gerenciar`, a mesma da tela; `POST /treinamentos/setores-promotores/{id}/aparencia`), com prévia do selo, cada cor com o **nome escrito** ao lado da amostra e «Cor do sistema» (vazio = `--acento`). Valor fora da paleta é recusado com aviso. Cada mudança grava `CAMPO_ALTERADO` (campos `cor_setor` e `icone_setor`), sem tipo de evento novo.

Contrastes medidos pela luminância relativa da WCAG 2.x (o teste `testes/setor_aparencia.test.ts` recalcula a partir do `csso.css` e exige 4,5:1 nos dois pares). «Sólido» é o fundo de cabeçalho/capa com texto branco (`.selo-setor.solido`); «pastel» é o selo em página clara, com o texto escuro da mesma cor.

| Setor | Chave | Sólido × branco | Pastel / texto | Texto × pastel | Ícone |
|---|---|---|---|---|---|
| CSSO | `azul` | `#0058a3` — 7,18 | `#e3eefa` / `#00467f` | 8,19 | `shield-plus` (escudo) |
| CSQV | `verde` | `#2f6b17` — 6,49 | `#e5f2da` / `#24540f` | 7,68 | `heart-pulse` (coração) |
| CPOS | `petroleo` | `#00666b` — 6,75 | `#dcf1f0` / `#004f53` | 7,97 | `clipboard2-check` (prancheta) |
| CPEL | `roxo` | `#8a52c8` — 5,10 | `#f1e9fa` / `#5c2f94` | 7,76 | `mortarboard` (capelo) |
| SecSisa | `marinho` | `#0a2a5c` — 14,01 | `#e2e7f0` / `#0a2a5c` | 11,29 | `building` (prédio) |
| (livre) | `vinho` | `#8c1d40` — 8,88 | `#f8e4ea` / `#741634` | 9,06 | — |
| (livre) | `ambar` | `#8a4b00` — 6,80 | `#fbefd9` / `#6e3c00` | 7,99 | — |
| (livre) | `grafite` | `#414b59` — 8,84 | `#e9ecf0` / `#353d49` | 9,25 | — |
| sem cor | (padrão) | `--acento` `#0058a3` — 7,18 | `--acento-suave` / `--acento-forte` | 8,14 | — |

- **Base**: as cores da marca (`tema.css`: acento `#0058a3`, verde `#2f6b17`, marinho `#0a2a5c`) e a sugestão da vitrine. **Dois desvios da vitrine:** a CPOS saiu do azul `#08669a` (perto demais do azul da CSSO) para um verde-petróleo `#00666b`; e a CPEL saiu de `#6b3fa0` para `#8a52c8`, mais claro, porque na deuteranopia e na protanopia roxo e azul viram o mesmo matiz e só a claridade os separa (ΔE simulado entre CSSO e CPEL: 5,7 e 8,9 com o roxo da vitrine; 11,9 e 17,2 com o proposto). O verde da CSQV é o `--ok` do sistema (`#2f6b17`), e não o `#3a7a1c` da vitrine, que dá só 5,3:1 com branco.
- **Distinção entre os cinco** (ΔE76 em Lab; simulação de Viénot 1999, aproximada): o par mais próximo em visão comum é CSSO × SecSisa (23,6, separados pela claridade); em protanopia e deuteranopia, CSSO × CPEL (17,2 e 11,9). Nenhum par abaixo de 10. A cor só ajuda a achar: **a sigla escrita é o sinal principal**, o ícone o segundo, e o nome inteiro vai no `title`.
- **Sem tema escuro**: o sistema não tem, então não há `prefers-color-scheme`; a versão para fundo escuro é a sólida (branco sobre a cor).
- **Como mudar**: um tom → os hexadecimais `--paleta-{chave}`, `-fundo`, `-texto` e `-borda` no `:root` da subseção PORTAL/SETOR do `csso.css` (o teste recusa o que não passar de 4,5:1); a cor ou o ícone de um setor → a tela Aparência, sem deploy; uma chave nova na paleta → `CORES_SETOR`/`ICONES_SETOR`, migração do CHECK e as regras `.setor--{chave}` e da prévia no CSS.

## Início com os cartões dos módulos (23/10/2026)

Pedido: «faça uma tela da home do sistema com os cards dos módulos como eu havia feito no IntegraSST» (`entrada/integrasst/Index.html`, `#home-view` e `.dashboard-module-card`).

- **Onde mora.** `/inicio`, que era só despachante (303 para a primeira tela), passa a ser a **Visão geral** da equipe (`src/rotas/modulos.ts`, `src/servicos/visao_geral.ts`, `templates/paginas/visao_geral.html`). O login continua levando a `/inicio`, então o destino depois de entrar é a Visão geral, como no IntegraSST, onde todo mundo caía na «Visão Geral».
- **Quem tem um módulo só também cai nela.** Considerei mandar direto para o módulo quem tem um só (o almoxarife), mas aí a Visão geral existiria só para alguns, e quem tem um módulo deixaria de ver os previstos e o «Meu espaço». No IntegraSST não havia exceção, e aqui também não. O cartão leva à mesma porta de entrada de antes (`porta_de_entrada`).
- **O titular puro não muda.** Quem só tem o próprio (`so_o_proprio`) continua recebendo o 303 de `/inicio` para a primeira tela dele, que é o Início do portal (`/`). A lateral dele não ganha a Visão geral.
- **Lateral.** O primeiro item da lateral da equipe agora é «Visão geral» (`/inicio`), com o desenho de link de módulo. O nome é «Visão geral», e não «Início», porque o «Início» do bloco «Meu espaço» (`/`) é outra tela e os dois apareceriam lado a lado. A marca do topo já apontava para `/inicio`. Na Visão geral, a trilha começa por «Visão geral» (`trilha_href`, variável nova e opcional da casca, que antes sempre ligava a raiz a `/modulos`).
- **Quem vê qual cartão.** Um cartão por módulo disponível que abre ao menos uma tela para a pessoa (`Modulo.itens_de`, o mesmo filtro da lateral). Além deles: **Demandas** (se `/demandas` está na base da pessoa), **Meu espaço** (conta de equipe ligada a servidor, `meu_espaco_de`) e **Administração** (quem abre `/usuarios`, ou seja, cria conta ou concede perfil, ou quem tem `backup.executar`, que vai para `/config`). O coordenador não recebe o cartão Administração: a configuração do setor dele é um parâmetro, não administração do sistema.
- **O nível «Sem acesso» tira o cartão.** Além do `itens_de`, o cartão de um módulo (e o de Demandas) exige ao menos uma permissão **do módulo** (`niveis_modulo.MODULOS_NIVELADOS`), por perfil de equipe. As permissões efetivas já vêm com o nível do perfil e a exceção da pessoa aplicados. As transversais (`indicador.ver`, `catalogo.gerenciar`, `exportar`, `exposicao.ver`) **não** abrem cartão: com Processos SEI em «Sem acesso», o «Importar» (`catalogo.gerenciar`) continua no menu, mas o cartão some. A outra branch (`fix/sisa-sem-acesso-esconde-modulo`) cria a função única de «tem acesso ao módulo». Quando ela entrar, `visao_geral._tem_o_modulo` deve passar a usar essa função.
- **Previstos.** Análise de Acidentes, CISSP e PGR (todo `disponivel: false` de `modulos.ts`) ficam na seção «Outros módulos (em desenvolvimento)»: cinza, tracejados, com cadeado, o resumo do módulo e «Em desenvolvimento — ainda não disponível» escrito. Não têm link nem script.
- **Selos.** Todos são consultas baratas. A tela do superintendente tem no máximo 12 idas ao banco (teste).
  - **EPI**: pedidos a analisar e comunicações a tratar, pela `epi_contagens.contagens_numa_ida`, que é uma consulta só.
  - **Certificados**: certificados a emitir (aprovado em turma concluída sem certificado em vigor, que corresponde ao «aguardando» mais o «travado» da fila, sem a validação item a item) e pedidos de inscrição a decidir. As duas contagens saem numa consulta só.
  - **Processos SEI e Demandas**: as pendências **da própria pessoa** dos tipos de cada módulo. Saem da leitura que a casca já faz para o sino (`sino_antecipado`, que passou a trazer o `tipo`), sem nenhuma ida a mais ao banco.
  - Desvio do IntegraSST: lá, Processos tinha prazos. Aqui o «precisam de você» do painel (`repo.listar` com `precisam`) é caro demais para a porta de entrada e ficou no painel.
- **Cores.** Tokens `--mod-*` no `:root` do bloco «VISAO GERAL» do `csso.css`. Esse bloco fica antes de «CELULAR (lote 0)», e o `@media print` continua o último. O template só escolhe a classe `mod-{codigo}`, sem `style=`.
  - O texto branco passa de 4,5:1 nas duas pontas de cada gradiente.
  - O teal do IntegraSST (`#0d9488`, 3,7:1) foi escurecido para `#0f766e`.
  - O roxo, que ia até `#8b5cf6` (4,2:1), agora vai até `#7c3aed`.
  - Os números de contraste estão no comentário do bloco.
- **Comportamento e celular.** O cartão sobe ao passar o mouse só em `(hover: hover)`, e não se move com `prefers-reduced-motion`. A 360 px a grade fica em uma coluna (`minmax(min(100%, 290px), 1fr)`), sem rolagem lateral (medido: `scrollWidth` 360).
- **`/modulos`** continua igual e é o botão «Ver todas as telas» da Visão geral.
- **Testes.** `testes/home_modulos.test.ts`. Em `testes/modulos.test.ts`, «/inicio despacha…» virou «/inicio abre a Visão geral…», e em `testes/seguranca.test.ts` a sessão por http espera 200 em `/inicio` (era 303): o caminho para o módulo agora está no botão do cartão, e o admin_ti, sem módulo, tem o cartão Administração.

## Perfil Administrador do sistema (23/10/2026)

Pedido do dono do sistema: um perfil **acima de todos**, código `administrador_sistema`, nome «Administrador do sistema» (`rbac.PERFIL_ADMINISTRADOR_SISTEMA`). Não há equivalente no Python.

- **Permissões derivadas, nunca copiadas** (`rbac.permissoes_do_administrador_sistema`): toda chave de `PERMISSOES` — o que cobre a união de todos os perfis da matriz, inclusive `perfil.conceder`, `habilitacao.atestar`, `usuario.*`, `auditoria.ver`, `backup.executar`, `turma.todos_os_setores`, a configuração e a leitura nominal — **menos** `SO_DO_TECNICO_HABILITADO` (`parecer.assinar`, `laudo.criar`; IN 15/2022, art. 10, §2º, I), que continuam exigindo perfil técnico E habilitação. Permissão nova entra sozinha; `semear_rbac` a acrescenta ao perfil já gravado no deploy (`npm run build` → `ferramentas/semear.ts`), por isso **não há migração**. `testes/perfil_admin_sistema.test.ts` confere.
- **Escopo total** (`S`), o mais amplo. **Nível mais alto (Operação) em todo módulo, fixo** (`niveis_modulo.PERFIS_NO_NIVEL_MAIS_ALTO`): `aceita_nivel_modulo` devolve `false`, e nem o nível do perfil nem a exceção da pessoa o rebaixam; a tela de níveis recusa ajustá-lo.
- **Só quem o tem o concede** (`rotas/usuarios._recusa_de_segregacao`): o superintendente não o concede a ninguém, nem a si mesmo, nem ao criar conta; o `<select>` de perfil nem o oferece a quem não o tem. A conta que o tem (vigente ou futuro) só é alterada, redefinida, desbloqueada, inativada, vinculada a servidor, ajustada por módulo/setor ou tem o perfil encerrado por **outro** Administrador do sistema (`rbac.recusa_do_administrador_sistema`).
- **Primeira concessão pela linha de comando**: `npm run conceder-administrador -- --email <e-mail> [--nome "..."]` (`ferramentas/conceder-administrador.ts`; ver PRODUCAO.md §4). A conta é achada pelo e-mail (login = e-mail); `--login` vale como sinônimo para conta antiga.
- **Hierarquia de dono de turma/treinamento**: ao juntar com a branch `feat/sisa-dono-treinamento` (hierarquia «Superintendente > Coordenador > demais», migração 0017), **`administrador_sistema` vem ACIMA do superintendente** — usar `rbac.TOPO_DA_HIERARQUIA` (`[administrador_sistema, superintendente]`) como topo da ordem.
- **Conta de teste**: `administrador_sistema` entrou em `testes/ajuda.PERFIS_DE_TESTE`. O `ambiente-teste` (contas de demonstração) não ganhou conta desse perfil.

## Dono de treinamento e turma (23/10/2026)

Decisão do usuário: no módulo Certificados e Treinamentos, **só o dono altera**. O dono de um treinamento do catálogo e de uma turma é a **conta que o criou**. A regra é **uma camada a mais** sobre o RBAC: o ato continua pedindo a permissão de sempre (`turma.criar`, `turma.inscrever`, `turma.avaliar`, `turma.concluir`, `certificado.emitir`, `certificado.anular`, `treinamento.gerenciar`), e só passa quem tem a permissão **e** é dono, está acima dele ou é ajudante no papel. A leitura não muda, e o titular continua com o que é dele (inscrever-se, desistir, o próprio certificado). Migração única **0017_dono_treinamento** (drizzle-kit, com snapshot e `_journal.json`; os dois `UPDATE` do fim são escritos à mão). **Nenhuma permissão nova** (designar ajudante usa `turma.criar`), por isso `niveis_modulo.ts` não mudou. Textos de auditoria já gravados não mudam.

- **A decisão mora num lugar só**: `src/servicos/dono_turma.ts`. `direito_na_turma(tx, usuario, turma)` devolve o direito (motivo, papéis, dono, aviso); `pode_alterar_turma(tx, usuario, turma, papel)` é a pergunta curta; `exigir_alterar_turma` é a porta dos atos (lança `AlteracaoRecusada`, subclasse de `PermissaoNegada` com o código `turma.dono`: **403** com o aviso na tela de erro, ou JSON 403 na API, e a transação da requisição é desfeita, nada gravado). O template da ficha recebe `direito` e `pode_aqui(permissão)`, que é `usuario.pode(permissão)` **e** o papel da permissão na turma (`PAPEL_DA_PERMISSAO`). Por isso todo `usuario.pode(...)` de `turma_ficha.html` virou `pode_aqui(...)` e os botões somem para quem não pode. O treinamento tem `direito_no_treinamento`/`exigir_alterar_treinamento`, e o certificado segue a turma dele (`direito_no_certificado`/`exigir_alterar_certificado`).
- **A hierarquia mora num lugar só**: `rbac.NIVEL_HIERARQUICO_POR_PERFIL` e `rbac.nivel_hierarquico(perfis)`. A ordem, do topo para baixo, é a constante `rbac.ORDEM_HIERARQUICA`: **administrador do sistema = 4** (`administrador_sistema`, o perfil que a branch do perfil de administração cria; enquanto ele não existe nesta branch, a entrada é inofensiva e está em `PERFIS_PREVISTOS_NA_HIERARQUIA`; altera tudo, como o superintendente), **superintendente = 3**, **coordenação = 2** (`coordenador_csso`; o perfil de coordenação de outro setor que vier a existir entra ali com 2), **demais = 1** (todo perfil fora da lista: engenheiro, médico, técnico, secretaria, almoxarife, consulta etc.). Vale o perfil mais alto entre os vigentes da conta, e o do dono é lido do jeito que está **hoje** (o dono que perdeu o perfil de coordenação passa a ser «abaixo»). `_conferir_hierarquia` derruba a importação se a lista citar perfil que não existe.
- **Quem altera** (`direito_na_turma`, nesta ordem): (1) o **dono**; (2) o **superintendente**, sempre; (3) a **coordenação** quando a turma é do setor promotor a que a conta **está vinculada** (`equipe_setor_promotor`; a turma sem setor é da CSSO, como em `setor_equipe.ts`) e o dono é de nível abaixo dela, ou não há dono. Ver todos os setores (`turma.todos_os_setores`) **não** é ser do setor: o coordenador da CPEL vê a turma da CSSO e não a altera. **Entre coordenadores, só o dono.** (4) O **ajudante**, só nos papéis que recebeu. (5) O resto só consulta. No treinamento do catálogo, que não tem setor, a coordenação altera o do dono abaixo dela **que tenha um setor promotor em comum** com ela, e o sem dono; não há ajudante no catálogo.
- **Sem dono.** A migração preencheu `criado_por` dos treinamentos e das turmas existentes pela trilha, com a conta do primeiro evento `TREINAMENTO_CRIADO`/`TURMA_CRIADA` que tem `usuario_id`. Sem evento (ou evento sem conta, como o da importação), fica **nulo = «sem dono»**: só a coordenação do setor (no catálogo, qualquer coordenação) e a superintendência alteram, e a ficha mostra «sem dono registrado». Quem está acima pode designar ajudantes nessa turma. A coluna da turma já existia (`turma.criado_por`, gravada desde a criação); a do treinamento é nova e tem o **mesmo nome**, `criado_por` (e não `criado_por_id`), para as duas lerem igual.
- **O dono não se troca**: trava nova `csso_dono_imutavel` (`travas.sql`, `BEFORE UPDATE OF criado_por` em `treinamento` e `turma`). O nulo pode ser preenchido uma vez, mas o dono gravado não muda nem se apaga.
- **Papéis do ajudante** (tabela `turma_ajudante`: turma, conta, uma coluna booleana por papel, quem designou e quando; CHECK de pelo menos um papel; a turma excluída leva os ajudantes junto). Três papéis, para ficar simples: **Inscrições** (inscrever, uma a uma e em lote; aceitar e recusar pedidos, inclusive os do link público; cancelar inscrição; corrigir o cadastro e o CPF do inscrito), **Presença e notas** (lançamentos, folha, dia, «todos presentes», notas, também pela API do celular) e **Emissão** (emitir, anular, reemitir em lote, enviar por e-mail e os campos que o modelo pede; a correção do certificado pela ficha dele também). O papel **GERAL**, que não se delega, fica só com o dono e com quem está acima dele: editar a turma, mudar a situação (abrir inscrições, concluir, cancelar), excluir, «turma já realizada», instrutores, link público, corrigir a turma concluída e designar ou retirar ajudantes. **Ajudante não designa ninguém.**
- **Designar**: cartão «Ajudantes» na aba Turma da ficha, com popup «Designar ajudante» (`ui.botao_cadastro`/`ui.popup_cadastro`): conta ativa vinculada ao setor promotor da turma, fora o dono, e os papéis em caixas. Designar de novo a mesma conta troca os papéis. «retirar» na linha apaga a designação. Rotas `POST /turmas/{id}/ajudantes` e `POST /turmas/{id}/ajudantes/{conta}/retirar`. Eventos novos, entidade `turma`: **`TURMA_AJUDANTE_DESIGNADO`** («Ajudante designado na turma»; descrição `TUR-… · ajudante {nome} ({login}) · {papéis}`, `valor_anterior`/`valor_novo` com os três papéis) e **`TURMA_AJUDANTE_RETIRADO`** («Ajudante retirado da turma»). Designar sem mudança não grava.
- **Onde a regra entra**: todos os POST de `/turmas/{id}/…` (por `_turma_para_alterar`, logo depois do escopo e antes de qualquer gravação; também o GET da tela de inscrição em lote); `POST /turmas/pedidos` (o pedido de turma que a conta só consulta fica como estava, na lista dos «não puderam», com o aviso; a tela de pedidos mostra a turma sem caixa de marcar e com o aviso); a fila de emissão (`/certificados/fila/emitir`: os marcados dessa turma travam com o aviso) e o envio em lote (`envio_certificado.pedir_envio`: conta «de turma que você só consulta»); `POST /certificados/{id}/anular`, `/corrigir` e `/email`; a API `POST /api/v1/turmas/{id}/presencas`; `POST /treinamentos/catalogo/{id}` e `/excluir`. O catálogo esconde «Editar»/«Excluir» e mostra «só consulta · de {dono}». A ficha da turma e a do certificado mostram «**Só consulta.** Esta turma é de {dono}; só ele ou a coordenação acima pode alterar.», e o ajudante lê em que papéis ajuda. A ficha da turma ganhou «Responsável (dono)» em Dados da turma.
- **O nome do dono (RN-19)**: é o nome da **conta** (`usuario.nome`), o mesmo nome de quem opera que a trilha já mostra. A RN-19 protege o titular (servidor e participante), e nenhum dado dele sai no aviso.
- **Modo compatibilidade**: o `UsuarioAtual` montado à mão nos testes de serviço (`concessoes === null`) não é recortado, como no resto do RBAC. A regra só olha a conta real.
- **Fora da regra**, de propósito: a criação (turma e treinamento novos; quem cria vira dono), os modelos de certificado e as assinaturas de instrutor (têm vida própria, fora da turma), a mesclagem de participantes, os setores promotores, os avisos de reciclagem e a caixa de saída de e-mails (`/certificados/emails`, que é do setor). As rotinas automáticas não passam por conta nenhuma.
- **Testes**: `testes/dono_treinamento.test.ts` (coordenador B recusado em cada POST sem gravar nada, superintendente, coordenador × técnico do mesmo setor e de outro, técnico só consulta, ajudante nos papéis dados, ajudante não designa, turma sem dono, a migração pela trilha, pedido do link público, eventos novos, botões escondidos). `testes/ajuda.ts` ganhou `designarAjudante` para os testes que abrem a turma com uma conta e operam com outra.
- **CSS**: bloco «DONO DE TREINAMENTO E TURMA», antes de «CELULAR (lote 0)» e do `@media print`. Popup e cartão conferidos a 360 px.

## Sem acesso esconde o módulo (23/10/2026)

**Defeito relatado:** gravar «Sem acesso» num módulo para um perfil (`/perfis/niveis`) ou na exceção da pessoa (`/usuarios`, «Gerir») e o módulo continuar no menu de quem tem o perfil.

- **Causa raiz.** O nível tirava as permissões *do módulo* (`niveis_modulo.permissoes_com_niveis`), mas dois itens do menu eram guardados só por permissões que não se liberam por módulo (`PERMISSOES_SO_DO_PERFIL`): **«Instrutores»** (`/treinamentos/assinaturas`, `assinatura.gerenciar`) segurava **Certificados e Treinamentos** para técnico, engenheiro, médico, coordenador e superintendente; **«Importar»** (`/importar`, `catalogo.gerenciar`) segurava **Processos SEI** para coordenador e superintendente. Bastava um item visível para o módulo ficar no seletor, na lateral e no mapa `/modulos`. As rotas desses itens, o CSV de EPI (`/epis/relatorios/exportar`, só `indicador.ver` + `exportar`) e a exportação de processos (`/relatorios/exportar-processos`, só `exportar`) também abriam sem a leitura do módulo. A Gestão de EPI já sumia do menu; faltava fechar o CSV.
- **A regra única: `tem_acesso_ao_modulo(usuario, codigo)`** (`src/servicos/acesso_modulo.ts`, reexportada por `src/modulos.ts` e global dos templates). A conta tem acesso quando **alguma concessão de equipe** (escopo total, de unidade ou agregado; nem a do titular nem a do `servidor_consulta`) lhe dá **alguma permissão do módulo**. `Modulo.itens_de`/`grupos_de` exigem essa regra para toda tela da equipe. Daí saem o seletor, a lateral, o mapa (o módulo sem tela nenhuma não aparece, com uma nota curta), o `/inicio` (`primeira_tela`) e a home por módulos. As rotas guardadas por permissão transversal chamam `exigir_acesso_ao_modulo`, que dá 403: Importar e reconciliação, Instrutores (tela e ações), CSV de EPI e exportação de processos. Relatórios de Processos SEI e de EPI e Indicadores de treinamento já pediam a leitura do módulo na equipe. O botão «Exportar CSV» de `/processos` só aparece com acesso ao módulo.
- **União das concessões (confirmado, não mudou).** Duas concessões somam. Se o técnico também é almoxarife e só o perfil de técnico está «Sem acesso» a EPI, o de almoxarife ainda dá o EPI. A exceção da **pessoa** vale para todas as concessões dela. As duas telas de nível dizem isso numa nota.
- **Exceção consciente: o que é do titular.** As permissões do titular (`PERMISSOES_DO_TITULAR`) continuam no «Meu espaço» e no portal: a própria ficha de EPI, os próprios pedidos, os treinamentos, os certificados, os processos, o adicional e o Início. Pela URL, `/epis` abre o painel **pessoal**, `/processos` mostra só os dele e o catálogo de EPI abre em leitura, como para qualquer servidor (não nomeia ninguém). Nenhum desses aparece como módulo no menu.
- **A base compartilhada não depende de Processos SEI** (decisão do usuário, 23/10/2026). Servidores e Catálogos eram guardados por `processo.ver`. Agora usam a permissão **derivada** `@base` (`niveis_modulo.PERMISSAO_DA_BASE`). Ela não fica no banco nem em `UsuarioAtual.permissoes`, e a API não muda. Fica só na concessão que já lia a base (`processo.ver` do perfil, antes ou depois do nível) **e** ainda dá algum módulo (Processos SEI, EPI ou Certificados), com o mesmo alcance dessa concessão. Quem não lia a base (o almoxarife) continua sem ela; sem módulo nenhum, a base fecha. Na ficha do servidor, processos, pareceres e adicionais só aparecem com Processos SEI na equipe (ou na própria ficha). **Editar** o cadastro continua pedindo `processo.criar`/`processo.editar`, que são do módulo. O Painel `/` é de Processos SEI. Sem ele, quem tem vínculo abre o Início do titular, e quem não tem é levado pelo `/inicio` à primeira tela que abre.
- **Testes:** `testes/sem_acesso_modulo.test.ts` cobre perfil e pessoa, os três módulos, menu, `/modulos`, rota direta, `/inicio`, união, titular preservado e base.

## Configurações conforme o perfil (23/10/2026)

Pedido: «a parte de configurações do sistema deve aparecer só as informações conforme perfil de acesso liberado». `/config` passou a montar bloco por bloco; o mapa bloco → módulo/permissão está num lugar só, `blocos_config` em `src/rotas/configuracao.ts`. A rota GET, as rotas POST, o template e a engrenagem do cabeçalho (`ve_config`, global dos templates, usado em `base.html`) leem desse mapa.

| Bloco | Módulo | Permissão | Dado que expõe |
|---|---|---|---|
| Setor emissor + Autoridade destinatária (leitura) | Processos SEI liberado | `processo.editar` ou `catalogo.gerenciar` | sigla, nome e vigência do setor; nome e cargo da autoridade |
| Links para os catálogos de setor e autoridade | Processos SEI | o mesmo, mais `catalogo.gerenciar` | — |
| SLA por coluna (leitura) | Processos SEI | `processo.editar` ou `catalogo.gerenciar` | prazo de cada coluna |
| Editar os prazos (formulário + `POST /config/sla`) | Processos SEI em Operação | `catalogo.gerenciar` e `processo.editar` | grava `parametro` |
| Integração com o SEI + passo a passo | Processos SEI | `processo.editar` ou `catalogo.gerenciar` | versão do SEI alvo, passos de inclusão |
| Retirada de EPI | Gestão de EPI liberado | gestão de EPI na equipe: `epi.catalogo`, `epi.entregar`, `epi.estoque` ou `epi.analisar` | `CSSO_EPI_LOCAL_RETIRADA` |
| Onde o dado mora | administração do sistema | `backup.executar` | host/porta/banco do Postgres, bucket e prefixos |
| Backup cifrado (botão + `POST /config/backup`) | administração do sistema | `backup.executar` | gera `.enc` |
| Exportar tudo (botão + `POST /config/exportar-tudo`) | transversal | `pode_exportar_tudo` (`exportar` + `perfil.conceder`/`catalogo.gerenciar`) e `exposicao.ver` | o banco inteiro em claro |

- **Módulo liberado**: a conta tem alguma permissão do módulo, já com o nível aplicado (`niveis_modulo.ts`; «Sem acesso» tira todas), **no trabalho da equipe** (`pode_na_equipe`). As funções do titular sozinhas não contam. O teste de módulo liberado é a função única `tem_acesso_ao_modulo` (`servicos/acesso_modulo.ts`).
- **Seções**: o título «Configuração do setor» ou «Sistema» só sai se a seção tiver algum bloco. A **Integração com o SEI** mudou de «Sistema» para «Configuração do setor», porque é do módulo Processos SEI. Por isso o `admin_ti` deixou de vê-la.
- **Sem bloco nenhum**: `GET /config` responde 403 com o recado curto «Não há configuração liberada para o seu perfil de acesso.», e a engrenagem some. Hoje isso vale para `servidor_consulta`, `auditor_interno` e `consulta_progep`, e para qualquer conta que fique sem bloco depois do nível por módulo.
- **DESVIO do comportamento anterior**: o `almoxarife_sesmt` **passou a entrar** em `/config` e vê só a «Retirada de EPI», que é dele, porque é quem atende o pedido. Os testes que pediam 403 para ele foram trocados para o `servidor_consulta` e o `auditor_interno`. A `secretaria_csso` deixou de ver a Retirada de EPI, porque não gere EPI. O `admin_ti` deixou de ver a Integração com o SEI.
- **POST**: `/config/sla` também exige o módulo Processos SEI em Operação (antes bastava `catalogo.gerenciar`, mesmo com o módulo em «Sem acesso»). `/config/backup` e `/config/exportar-tudo` já recusavam com 403 e foram conferidos. Testes em `testes/config_por_perfil.test.ts`.
- `PERMISSOES_CONFIG` foi removido. O invariante «engrenagem = rota» agora é cobrado perfil a perfil, comparando a engrenagem com o status de `GET /config` (`testes/correcoes_visual.test.ts`).

## Prevenção de cadastros duplicados (23/10/2026)

Etapa 1 das decisões do usuário de 23/10/2026: a prevenção passa a morar em cada porta por onde a pessoa entra, e juntar cadastros vira exceção. Migração **0018_prevencao_duplicados** (drizzle-kit, com snapshot e `_journal.json`; a função SQL `csso_nome_chave` escrita à mão). **Nenhuma permissão nova.** Tipos de evento novos, com rótulo em `auditoria.ts`: `PARTICIPANTES_DISTINTOS`, `PARTICIPANTE_SUSPEITO_DUPLICADO`, `AVISO_CADASTRO_EXISTENTE` e `EMAIL_CONFIRMADO_PELO_LINK`. Textos de eventos já gravados não mudam.

- **Critério único de «parecido»** (`servicos/duplicados.ts`), usado pelo link público, pela ficha da turma, pelo lote, pela importação SIAPE, pela conferência dos pedidos e pela tela de juntar. Nome parecido = o mesmo primeiro nome e, depois dele, o mesmo último sobrenome **ou** todos os sobrenomes do nome mais curto dentro do mais longo, sem acento, caixa, pontuação nem partícula («Maria Souza» parece «Maria Aparecida Souza Lima»; «Joana Silva» parece «Joana da Silva»). SIAPE com nome parecido é o sinal forte; o mesmo e-mail com nome parecido vem logo depois; e-mail sozinho ou nome sozinho só avisam. Substitui as três regras antigas (`mesmo_nome`, nome inteiro, nome sem palavras curtas) e o `translate` com lista curta de acentos: o recorte SQL usa `csso_nome_chave` (lista larga, com ñ, ý, å, ø, ł, ș…). `participante.mesmo_nome` continua existindo, mas ninguém decide mais por ela. **Desvio**: o link público casa agora pelo critério único, um pouco mais largo que o antigo (primeiro e último nome iguais continua casando).
- **«Não é a mesma pessoa»** fica gravado (`participante_par_distinto`, sempre `a < b`, com a origem da decisão: conferência, ficha da turma, lote ou tela de juntar). O par não volta em porta nenhuma nem no contador.
- **A junção registra o que moveu** (`participante_mesclagem.movido`, jsonb): ids das inscrições, dos certificados (com o `servidor_id` de antes), dos e-mails movidos, dos e-mails repetidos que saíram (origem e confirmação, nunca o endereço), o principal herdado, os campos herdados e se o absorvido tinha CPF (booleano, nunca o número). É o que permite desfazer depois; **o botão de desfazer não existe ainda**.
- **Link público no modelo «esqueci a senha»** (`aviso_cadastro_existente.ts`). A tela responde a mesma frase a todo mundo, mais uma linha neutra igual para todos («se você já tem cadastro, pode chegar uma mensagem no e-mail que usou antes»). O aviso de verdade vai **só ao e-mail que já está no cadastro**, nunca ao digitado, pela fila de e-mail (como `acesso_participante.ts`), sem nome, SIAPE, IP, dado digitado nem turma. Sai quando o pedido casou por e-mail + nome (até 3 por destinatário em 24 h) ou por SIAPE + nome (**1 por destinatário em 24 h**: SIAPE e nome são públicos). O já inscrito recebe «não precisa pedir de novo». Não sai quando casou só pelo nome, quando o cadastro não tem e-mail, ou quando o e-mail está em mais de um cadastro sem confirmação. Os botões «sou eu»/«não fui eu» ficam para a etapa 2.
- **Aviso que vence.** `email_saida.expira_em`: o aviso vale 24 h; vencido sem sair, `email.vencer` o passa a CANCELADO («Venceu antes do envio.»), mesmo com o envio desligado. Sem SMTP, nada chega dias depois.
- **Tempo de resposta constante.** O POST do link tem piso (450 ms + até 150 ms sorteados, `tempo_de_resposta`), contado do começo da requisição, e o ramo «já inscrito» também enfileira o aviso: o tempo não diz mais quem já estava na turma. `acordar_envio()` é chamado sempre, sem esperar.
- **Limite por IP no banco.** Era um mapa na memória da instância (zerava a cada arranque a frio). Agora usa `limite_login_ip` com chave própria (`inscricao:<ip>`), o mesmo truque do bloqueio encenado; a rotina noturna (`expurgar_limites_ip`) apaga a linha um dia depois. O limite por destinatário conta em `email_saida`. `limpar_limites()` ficou como função vazia, para quem a chamava.
- **Brecha corrigida.** Com o SIAPE certo e o e-mail institucional mal formado no cadastro, a recusa `E-mail inválido: '<endereço>'` chegava ao visitante com 422 — vazava o e-mail do servidor e confirmava o SIAPE. `de_servidor` deixa de lado o endereço mal formado, e o pedido público responde uma recusa genérica (`RECUSA_GENERICA`) a qualquer erro de cadastro.
- **Conferência dos pedidos** (`/turmas/pedidos`): cada pedido mostra «parece com PTC-…», o motivo, e o nome do outro cadastro **só para quem pode lê-lo** (RN-19). «Usar este» junta o cadastro do pedido ao existente (o de servidor sempre fica) e o pedido continua a conferir; basta `turma.inscrever` quando o cadastro que se junta é o que o próprio pedido criou (só este pedido, nenhum certificado), e juntar dois cadastros com história continua pedindo `participante.mesclar`. «Não é a mesma pessoa» grava o par. Rotas em `rotas/duplicados.ts`.
- **Ficha da turma, servidor da base**: escolher um servidor que já tem cadastro de externo parecido mostra a pergunta antes de criar o ponteiro — «Sim: juntar e inscrever» (com `participante.mesclar`), «Não é a mesma pessoa» (grava o par) ou, sem a permissão de juntar, «inscrever e deixar a junção para depois». Era assim que nascia o par externo + servidor.
- **Ficha da turma, externo novo**: a pergunta de sempre, pelo critério único; «Não é: cadastrar como pessoa nova» grava o par com cada parecido mostrado. **Quem não lê nomes** não recebe a pergunta (RN-19): o cadastro nasce e, havendo parecido que ele não pode ver, fica marcado como suspeito (`participante.suspeita_duplicado_em`), em silêncio; na tela de juntar ele aparece com a pílula «a conferir». A marca sai quando alguém junta ou marca «não é a mesma pessoa».
- **Prévia do lote**: a linha que criaria externo novo e parece cadastro existente, e a linha que casaria **só pelo e-mail com outro nome** (o e-mail do setor, da família), não são inscritas sozinhas: viram «a decidir», com «parece com …» e a escolha «usar este» / «criar novo (não é a mesma pessoa)» linha a linha. A escolha se prende à linha pelo **texto** dela (`chave_da_linha`), não pelo número, e sobrevive à lista renumerada. «Criar novo» grava o par. Sem leitura nominal, o lote cria o externo e o marca como suspeito, sem dizer nada na tela.
- **Importação SIAPE**: ao fim (na prévia e na gravação), o relatório lista os servidores novos que parecem externos já cadastrados (`externos_parecidos_em_lote`: uma consulta só, o critério em memória). **Não liga ninguém sozinho.**
- **E-mail confirmado.** Abrir o link mágico de `/certificados/acesso` grava `participante_email.confirmado_em` do endereço do cadastro (o mesmo que recebeu o link), só quando ele leva a um cadastro só. A partir daí `uq_email_confirmado` vale para ele, e o acesso deixa de ser «ambíguo» quando outro cadastro tiver o mesmo endereço sem confirmação.
- **A tela de juntar saiu do menu.** «Juntar duplicados» não está mais na lateral; a rota `/treinamentos/participantes` continua. Abre pelo cartão **«Possíveis duplicados»** do Início de Treinamentos (só com `participante.mesclar`, e só quando há o que conferir; o número é o da tela), e pelo atalho «Juntar com outro cadastro» nas ações de cada inscrição da ficha da turma (`?de=<id>`: a pessoa e quem parece com ela). Cada grupo ganhou «Não são a mesma pessoa».
- **CPF**: continua só para o certificado, e não vira chave. Corrigidos os comentários que diziam «não há coluna de CPF» (`db/esquema/treinamento.ts` e a seção de privacidade deste arquivo).
- **Ficou para depois**: a etapa 2 («sou eu» / «não fui eu» no aviso, com token), o desfazer da junção e a carga de certificados antigos (IntegraSST/planilhas), que vai precisar do mesmo casamento com relatório de ambíguos. O atalho de junção não foi posto na ficha do servidor (`/servidores/{id}`), que não mostra o participante.

## Login é o e-mail (23/10/2026)

Pedido do usuário: «no Cadastrar conta o login sempre vai ser o e-mail cadastrado».

- **Contas novas.** O login é o e-mail cadastrado, aparado e em minúsculas (`autenticacao.login_do_email`, que substitui `usuario_a_partir_do_email`, que guardava só a parte antes do `@`). O campo «Login» saiu do Cadastrar conta e do popup Editar dados; um `login` que ainda venha no formulário é ignorado. Vale para `/usuarios`, `/primeiro-acesso` e `producao-iniciar`. A coluna `usuario.login` continua obrigatória e única e passou de 64 para 160 caracteres, o tamanho do e-mail (migração 0019).
- **Editar o e-mail.** O login acompanha: em `/usuarios` (evento `USUARIO_ALTERADO` com o campo `login`, além do `email`) e em `/minha-conta` (o `EMAIL_ALTERADO_PELO_TITULAR` diz que o login acompanhou). Se o e-mail não muda, o login fica como está.
- **Unicidade.** E-mail repetido, sem diferenciar maiúsculas, é recusado com «o e-mail X já é o login da conta de Fulano. Cada conta entra com um e-mail próprio.» O que não tem cara de e-mail também é recusado. Em `/minha-conta` a recusa continua sem dizer de quem é o e-mail.
- **Contas que já existem.** A publicação (`preparar-publicacao.mjs`) roda `ferramentas/converter-logins.ts` depois de semear. Ele só age no banco com a **marca de produção** (`instalacao`): lá troca o login de cada conta pelo e-mail e grava o evento novo `LOGIN_CONVERTIDO_PARA_EMAIL` («Login convertido para o e-mail»), com o antes e o depois. No banco de teste e no local, nada muda: as contas de teste (`coordenador_csso` etc.) seguem com o nome de usuário. A conversão é idempotente. Conta com e-mail vazio, com o mesmo e-mail de outra conta, ou cujo e-mail já é o login de outra conta **não é convertida**. Ela aparece no log do deploy (`[logins] ATENÇÃO: …`) e não vai à trilha, para não gravar o mesmo evento a cada publicação. Corrigido o e-mail, a publicação seguinte converte. As sessões abertas não caem. Os textos antigos da trilha não mudam.
- **Entrada.** O rótulo passou de «E-mail ou usuário» (M77) para «E-mail». A rota continua aceitando o login antigo (`buscar_por_login`) para as contas de teste e as puladas por conflito.
- **Linha de comando.** `producao-iniciar` não pede mais `--login`: quem o passa recebe um aviso e o valor é ignorado. `redefinir-senha` aceita `--email` ou `--login` e acha a conta pelo e-mail ou pelo login antigo, sem diferenciar maiúsculas. `criar_primeiro_superintendente(tx, nome, email, senha)` perdeu o parâmetro `login`.
- **Telas.** Em `/usuarios`, as colunas Login e E-mail viraram «E-mail (login)». A conta que ainda tem login diferente do e-mail mostra «login antigo: …» embaixo. A senha provisória mostrada na criação e na redefinição diz com qual e-mail a pessoa entra. **Não existe e-mail automático** de conta criada ou de senha redefinida: os dois avisos são só na tela.

## Matriz de perfis e Acesso por módulo harmonizados (23/10/2026)

Pedido do usuário, decisões D1 a D10 da análise de harmonia (D11: feito depois de admin → dono → login → sem-acesso, que já estão na main).

- **D1, teto por perfil.** `niveis_modulo.NUNCA_POR_NIVEL`: as permissões que nenhum nível devolve ao perfil, porque a matriz as tirou de propósito (o técnico não anula certificado nem parecer nem atribui; engenheiro e médico não operam o balcão do almoxarifado; a secretaria não analisa EPI, não cria nem emite parecer e não lê a ficha nominal; o almoxarife não lê parecer nem decide o direito ao item). «Operação» passou a ser o módulo **menos o teto**, e «Consulta», a leitura menos o teto. O teto vale também sobre a exceção da pessoa. A conferência é no carregamento (`rbac._conferir_niveis`): todo perfil que aceita nível declara o teto (`[]` = nenhum), o teto só tem permissão de módulo e não cobre o que o perfil já tem. **Efeito colateral bom**: com o teto o padrão dos perfis de equipe se lê sempre como um nível, e «Parcial» deixou de aparecer neles (o técnico em Certificados é «Operação (sem anular certificado, juntar cadastros)»). O rótulo único está em `niveis_modulo.rotulo_do_nivel`. **Desvio**: o teto do almoxarife inclui `epi.requisitar` (ele não tem, e o padrão dele só se lê como Operação com ela fora). O nível Operação num módulo sem teto (superintendente, coordenador) não mudou.
- **D2.** PROGEP e auditor interno têm por teto TODA a escrita: o máximo é Consulta. A tela não oferece «Operação» a eles e o servidor recusa o POST (nível do perfil, e exceção da pessoa cujos perfis só vão até Consulta). `nivel_maximo` diz isso por perfil e módulo.
- **D3.** `epi.ficha` continua sendo Consulta; a secretaria é excluída pelo teto. **D4.** A base comum já estava feita (permissão derivada `@base`, `concessao_da_a_base`): Servidores, Catálogos e o Painel seguem o módulo que a pessoa usa, e «Sem acesso» em Processos SEI esconde só o que é de processo. Confirmado; a tela de níveis passou a dizer isso. `@base` nunca aparece nas telas como permissão (teste).
- **D5/D6, uma organização, um cálculo.** `liberacao_modulo.perfis_com_niveis` é o único cálculo: por módulo (nível em vigor, rótulo, permissões), «Sempre do perfil» e o teto. As duas telas usam a mesma organização, em macros comuns (`templates/partes/perfil_permissoes.html`): os quatro módulos, «Sempre do perfil» e «Do titular» (o que toda conta ligada a servidor recebe, `PERMISSOES_DO_TITULAR`). A Matriz (`/perfis`) só lê; o Acesso por módulo (`/perfis/niveis`) edita, e uma leva à outra. A rota deixou de recalcular os níveis por conta própria e o agrupamento em sete grupos da Matriz saiu. `GRUPOS_PERMISSAO_TELA` ficou só como dicionário de texto (`TEXTO_PERMISSAO`). As duas listam os mesmos perfis, na mesma ordem (por nome), com os inativos marcados. O Acesso por módulo mostra também os perfis que não se ajustam (Administrador do sistema «sempre em Operação», admin_ti, servidor), só em leitura e com a nota. Cada permissão traz `data-perm` e `data-bloco`: `testes/matriz_harmonia.test.ts` falha se as duas telas divergirem.
- **D7.** `permissao.modulo` é derivado dos módulos nivelados (`processos-sei`, `epis`, `certificados`, `demandas`; `PERFIL` para as só do perfil), e `MODULO_POR_PERMISSAO` e `MODULO_PADRAO` foram apagados. A coluna continua existindo (nada a lê); `semear_rbac` a regrava no próximo deploy. Sem migração.
- **D8.** `semear_rbac` passa a atualizar também `perfil.base_normativa` (como já fazia com `nome`). Textos corrigidos: Secretaria sem «RN-19»; PROGEP não «lê apenas parecer assinado»; admin_ti sem «só contagens» (`ESCOPO_TELA` agregado diz «sem dado — só a administração técnica»); «a coordenação ajusta o acesso» vira «o Administrador do sistema ou o Superintendente»; o Administrador do sistema ganhou «não se ajusta por módulo»; `servidor_consulta` chama-se «Servidor (os próprios dados)»; `turma.todos_os_setores` é «alcançar» as turmas (gerir exige as permissões de turma). `testes/textos_sem_rn.test.ts` perdeu a exceção e varre `/perfis`, `/perfis/niveis` e `/usuarios`.
- **D9.** A exceção por pessoa (`/usuarios`, «Gerir») só mostra o formulário a quem tem perfil de equipe; as outras contas veem a explicação. **D10.** O rótulo é «Padrão do perfil (x)» nas duas telas e na trilha, e «Consulta», «Operação», «Sem acesso», «Parcial».
- **Não feito (fora do pedido).** A conferência de «ninguém concede mais do que tem» em `_recusa_de_segregacao` ainda usa as permissões cruas do perfil concedido, sem os níveis. As rotas Importar, Instrutores e o CSV de EPI (análise §2.3) não foram tocadas aqui.

## Ativar meu acesso e esqueci minha senha (23/10/2026)

Pedido do usuário: hoje só a equipe cria conta e entrega senha provisória; não havia autocadastro nem «esqueci minha senha». Decisão: uma tela pública que serve aos dois, no modelo anti-enumeração de `acesso_participante.ts` e do aviso do link público.

- **Tela.** `/ativar-acesso` (link «Ativar meu acesso / Esqueci minha senha» no login). O servidor informa **SIAPE + e-mail institucional**. A tela responde **a mesma frase e o mesmo status** a qualquer pedido, com **piso de tempo** (1,2 s; `ativar_acesso.ajuste.piso_ms`) e sem captcha. Só SIAPE fora de 7 dígitos e e-mail sem cara de e-mail têm erro (422), igual para todos.
- **Quando sai e-mail.** Só se SIAPE e e-mail digitado batem com o cadastro `servidor`. Vai **ao e-mail do cadastro, nunca ao digitado**, pela fila `email_saida` (tipos `ATIVAR_ACESSO` e `ATIVAR_ACESSO_NEUTRO`), sem nome, SIAPE ou qualquer dado no texto, e **vence em 1 h** na fila (o link idem). Com o envio desligado, a mensagem fica pendente, vence, a tela responde igual e o log da função registra «envio de e-mail não está configurado».
- **Tetos no banco.** Por IP: 8 pedidos por hora (tabela nova `ativacao_acesso`, migração **0020**; só IP e hora, sem SIAPE nem e-mail digitados; apagada em 7 dias pela rotina de privacidade). Por destinatário: 2 por hora e 5 por dia, contados na própria `email_saida`. Passado o teto, nada sai e a tela é a mesma.
- **Token.** 24 bytes aleatórios; o banco guarda o SHA-256. **Abrir o link (GET) não o gasta** (leitor de e-mail pré-visualiza); gasta o POST da senha nova, de forma atômica (de dois envios, um ganha), e os outros links do mesmo servidor caem junto. Senha fora da política (`politica_de_senha`) ou confirmação diferente **não gasta** o link.
- **O que o link faz** (decidido de novo na hora de gravar, `decidir`): sem conta, **cria** (login = e-mail do cadastro, nome do cadastro, `servidor_id`, perfil `servidor_consulta` com o ato «Ativação do próprio acesso pelo titular», sem troca obrigatória porque a senha foi escolhida agora); conta ativa, **só redefine a senha** (revoga as sessões, zera tentativas e bloqueio) e nunca concede perfil — conta de equipe redefine a dela e segue com o que tinha. Em seguida volta ao **login** com um aviso (`?motivo=ativada` / `redefinida`): o link de e-mail não vira sessão (o caminho mais simples e seguro).
- **O que não é atendido** (a tela é igual; o e-mail diz, neutro, «procure a equipe»): conta **inativa** (nunca reativada por aqui), conta de **Administrador do sistema** ou **superintendente** (ou com `perfil.conceder`, vigente ou futura — a mesma ideia da segregação de `rotas/usuarios.ts`), conta de **outro servidor** com o mesmo e-mail, mais de uma conta casando, e cadastro de servidor aposentado/exonerado sem conta. Esses ficam com a equipe ou com `npm run redefinir-senha`.
- **Servidor sem e-mail no cadastro.** Nada é enviado. O pedido fica marcado (`ativacao_acesso.resultado = SEM_EMAIL`) e `/config` (bloco «Envio de e-mail») mostra quantos servidores ativos estão sem e-mail e, a quem lê dado nominal, os SIAPE (sem nome) de quem pediu nos últimos 7 dias. Mínimo viável: não há lista própria em `/servidores`.
- **Auditoria.** Eventos novos com rótulo: `ACESSO_ATIVADO`, `SENHA_REDEFINIDA_POR_LINK` e `PEDIDO_DE_ACESSO_RECUSADO` (só quando o e-mail neutro é enfileirado, para não encher a trilha de pedido que não casou). Ator «o próprio titular»; a descrição não leva nome, SIAPE nem e-mail. Textos antigos intactos (cadeia de hash).
- **Texto do login.** Os avisos de bloqueio de `autenticacao.ts` diziam «não há redefinição por e-mail»; passaram a apontar «Esqueci minha senha» (o trecho «quem administra o sistema redefine» ficou).
- **Permissões.** Nenhuma nova: é fluxo público (entra em `SEM_PERMISSAO_DE_RBAC` e `ABERTAS_SEM_SESSAO` dos testes).

### Envio de e-mail: configuração e diagnóstico

O envio não estava configurado em produção. Entregues: **PRODUCAO.md §2.2 «Configurar o envio de e-mail»** (todas as variáveis, exemplo do Gmail/Workspace com senha de app, porta 465/587, remetente reescrito pelo Gmail, limite diário, SPF/DKIM, «publique de novo»); a ferramenta **`npm run testar-email -- --para <e-mail>`** (confere conexão e login, envia o teste, imprime servidor/porta/protocolo e o resultado; **nunca** senha, usuário ou a URL inteira — `email.sem_segredos` mascara qualquer erro do nodemailer, e o mesmo mascaramento vale para o `ultimo_erro` da fila); e o bloco **«Envio de e-mail» de `/config`** (para quem tem `backup.executar`): «configurado» ou «não configurado» (com os NOMES das variáveis que faltam, nunca valores) e a fila de pendentes e falhos. O código não mudou o jeito de enviar (`smtp://…:587` continua com STARTTLS oportunista, não obrigatório).

## Limpeza de treinamentos (23/10/2026)

Pedido do usuário: apagar do sistema de produção as turmas, treinamentos e inscrições para recomeçar o cadastro com dados corretos. Ferramenta `ferramentas/limpar-treinamentos.ts` (`npm run limpar-treinamentos`, runbook em PRODUCAO.md §9). Quem a escreveu não a rodou em produção; os testes (`testes/limpar_treinamentos.test.ts`) rodam no banco de teste.

- **O que sai.** `treinamento`, `turma`, `turma_instrutor`, `turma_ajudante`, `turma_presenca`, `inscricao` (a nota, a frequência e os pedidos pelo link, `origem = 'PUBLICA'`, moram nela: não há tabela própria de avaliação nem de pedido), `participante`, `participante_email`, `participante_mesclagem`, `participante_par_distinto`, `certificado`, `certificado_valor_turma`, `certificado_valor_inscricao`, `assinatura_instrutor`, `acesso_participante` e `epi_item_treinamento`. Das tabelas compartilhadas sai só o que é do módulo: `email_saida` (ligado a certificado ou inscrição, ou de tipo CERTIFICADO, RECICLAGEM_AVISO, AVISO_CADASTRO_EXISTENTE, AVISO_PEDIDO_REPETIDO; os e-mails de EPI ficam), `pendencia` (ancorada em certificado, turma, inscrição, treinamento, participante ou instrutor) e `anexo` (entidades do módulo e os PDFs/rubricas apontados por `certificado` e `assinatura_instrutor`).
- **Decisões a conferir.** (1) `epi_item_treinamento` (o vínculo «este EPI exige tal treinamento») também sai, porque aponta para o treinamento; o item de EPI fica. (2) `certificado_modelo.treinamento_id` é zerado: o modelo é mantido, como pedido, e passa a ser genérico; sem isso a chave estrangeira impediria apagar o treinamento. (3) `acesso_dado_sensivel` e `registro_acesso` (registros de acesso) ficam, como a trilha.
- **Numeração.** `certificado_sequencia*` e `turma_sequencia` ficam, e os `id` do banco continuam de onde pararam (nenhuma sequência é reiniciada): uma turma nova sai com o próximo número da sequência, não com o 0001.
- **Travas.** Nenhuma trava de `travas.sql` recusa DELETE nessas tabelas (a do número do certificado e a do dono só valem em UPDATE). A ferramenta consulta o catálogo e **recusa rodar** se achar gatilho de DELETE/TRUNCATE em tabela da lista; não desliga gatilho nenhum. A trilha só recebe o INSERT de `auditoria.registrar` (tipo `DADOS_DE_TREINAMENTO_APAGADOS`, entidade `instalacao`, ator «linha de comando (limpeza de treinamentos)»).
- **Garantias.** O grafo de chaves estrangeiras é lido do catálogo; tabela fora da lista que referencie linhas apagadas aborta antes de gravar, listando. A ordem dos DELETEs é topológica, calculada do catálogo (o ciclo `participante`/`participante_email` se resolve pela cascata). A transação trava as tabelas, grava a cópia, apaga, registra o evento e confere que tudo zerou e que o resto ficou igual (modelos, numeração, servidores, usuários, EPI, processos; a trilha +1); qualquer divergência desfaz tudo.
- **Armazenamento.** Depois do commit: blobs dos anexos apagados (só se nenhum anexo que fica usa o mesmo blob), `certificado.arquivo_docx`, `certificados-pdf/<id>-*.pdf` e as listas de presença `documentos/listas_presenca/...`. Falha vira aviso e código de saída 5; o banco já foi apagado. Arquivo solto, sem referência no banco, não é encontrado.
- **Cópia local.** JSON com as linhas apagadas, permissão 600, em `--copia` (recusa pasta dentro de um repositório git). Tem dado pessoal. Não inclui os arquivos. A simulação não grava cópia nem pede confirmação.

## Acesso automático do servidor (23/10/2026)

Decisão do usuário: todo servidor pode solicitar EPI e se inscrever em cursos, então **não há separação entre servidor e conta**. Escolhas: o acesso nasce automático no cadastro, e os servidores já cadastrados ganham acesso por ferramenta de uso único.

- **Cadastro.** `ativar_acesso.garantir_acesso` roda ao cadastrar servidor (`POST /servidores`, importação de planilha, correção do cadastro que põe ou muda o e-mail). Servidor **ativo com e-mail institucional válido** e sem conta ganha conta com login = e-mail, perfil `servidor_consulta` e `servidor_id`. Mesma regra de `decidir`: conta que já existe (por vínculo, e-mail ou login) não é tocada, nem a de equipe que usa o mesmo e-mail.
- **Sem senha utilizável.** `usuario.senha_hash = '!sem-senha'` (`SEM_SENHA`). Não começa com `$argon2`, então `conferir_senha` recusa sem verificar: nenhuma senha digitada entra. Sem migração (a coluna continua `NOT NULL`).
- **Nenhum e-mail sai.** O titular define a senha por «Ativar meu acesso» ou «Esqueci minha senha». Como a conta já existe, o link cai no ramo «redefinir»; quando a conta ainda está sem senha, o evento é `ACESSO_ATIVADO` (e não `SENHA_REDEFINIDA_POR_LINK`). Evento novo na criação: `ACESSO_CRIADO_NO_CADASTRO`.
- **Ficha do servidor.** Mostra «Acesso: ativo / aguardando ativação / sem acesso — motivo» (falta e-mail, não está ativo, conta inativa), a quem tem `processo.editar`.
- **Servidores já cadastrados.** `npm run criar-acessos -- --simular` e depois sem a flag. Idempotente, não envia e-mail, imprime as contagens (criados, já tinham conta, sem e-mail, recusados). Quem escreveu não a rodou em produção.
- **Não feito.** Mudar o e-mail de um servidor que já tem conta não atualiza o e-mail da conta; servidor sem e-mail institucional segue sem acesso (aparece na ficha e em `/config`).

## Módulo Acidentes — F0 (23/10/2026)

Fundação do módulo «Análise de Acidentes» (CAT/SP, Lei 8.112 arts. 212-214), fatia F0, feita sobre `especificacao.md` §3, §4 e §7 (decisões D1–D14 do usuário). Migração **0021_acidentes**. O que difere da especificação, ou que a fatia seguinte precisa saber:

- **Natureza da lesão: catálogo VAZIO.** A lista oficial (NBR 14280 / Tabela 17 do eSocial) não veio com o legado nem estava no repositório, e não se inventa tabela oficial. A tabela `acidente_natureza_lesao` existe e `NATUREZAS_DA_LESAO` (`dominio/acidente_catalogos.ts`) é a lista a preencher; `semear_acidentes` a grava quando houver itens. **Pendente do usuário.** A tela de saúde (F3) fica sem opção neste campo até lá.
- **Catálogos reconstruídos.** Das listas do legado (44/199/30/30), o texto cortado foi completado nos agentes causadores 107 («…CHAVE, INTERRUPTOR, ETC», grupo EQUIPAMENTO ELÉTRICO), 108 («REÓSTATO, DISPOSITIVO DE PARTIDA E APARELHO DE CONTROLE, CAPACITOR, RETIFICADOR, ETC»), 134 («FONTE DE RADIOISÓTOPO», grupo de radiação ionizante) e 165 («…HALOGENADO (TRICLORETILENO, ETC)»); o 127 teve o travessão corrigido e o grupo EQUIPAMENTO DE AQUECIMENTO. **Conferir esses cinco com a tabela oficial.** Acentos e erros de digitação foram corrigidos (`SUSBSTÂNCIA`, `MASARICO`, `DESLISANTE`…); o texto original, com o «N. », está em `rotulo_legado` (chave de casamento da migração da planilha). O número do legado virou `ordem`, não `codigo_oficial` (que fica nulo). A classe grudada no agente virou `grupo`.
- **Tabelas e colunas além da especificação.** `acidente_complementacao` (pedido e resposta da complementação, com trava: o pedido não se reescreve e a resposta se preenche uma vez); em `acidente_ocorrencia`: `prazo_prorrogado_ate`, `prorrogacao_motivo`, `prorrogado_por`, `prorrogado_em` (a prorrogação nunca mexe em `prazo_comunicacao`, que é sempre a data do acidente + 10), `conclusao_motivo`, `restrita_sst` (D14a, acidentado menor de idade) e `cat_sp_versao`; em `acidentado`: `menor_de_idade` e `responsavel_legal_solicitado_em`. `acidente_link_publico` (F2) já foi criada, para a F2 não precisar de migração.
- **CAT/SP versionada e colunas congeladas.** A ocorrência espelha a CAT/SP vigente. Os **fatos do evento** (`OCORRENCIA_FATOS` em `travas.ts`) só mudam quando `cat_sp_versao` sobe para uma versão que existe em `acidente_cat_sp`: a retificação grava a linha nova da CAT/SP e atualiza a ocorrência na MESMA transação. Identidade (`OCORRENCIA_IDENTIDADE`) nunca muda; trâmite (`OCORRENCIA_TRAMITE`) muda livremente. Um teste confere que as três listas cobrem todas as colunas, cada uma uma vez.
- **Máquina de estados** no `dominio/estados.ts` (G), junto das outras, e não em arquivo próprio: `exigir_transicao_acidente`, `ACIDENTE_ENCERRADO`, `ACIDENTE_CANCELAVEL`. Reabrir é ocorrência nova (`tipo_cat = REABERTURA`).
- **Permissões.** O almoxarife NÃO recebeu `acidente.comunicar` na matriz do perfil (a especificação o listava): sozinho, sem `acidente.ver`, o módulo lê «Parcial» no perfil e entra na lateral dele; ele comunica como titular (`PERMISSOES_DO_TITULAR`), se a conta estiver ligada a um servidor. A especificação previa um `MODULO_POR_PERMISSAO`; aqui o módulo da permissão é derivado de `MODULOS_NIVELADOS` (`modulo_da_permissao`), então o mapeamento está em `niveis_modulo.ts`: consulta `acidente.ver`; escrita `comunicar`, `triar`, `investigar`, `siass`. **Só do perfil** (sem nível por módulo): `relatorio_emitir`, `saude_ver`, `saude_detalhe_ver`, `saude_registrar`. Teto por perfil (`NUNCA_POR_NIVEL`): médico sem triar/investigar; secretaria sem investigar/siass; almoxarife sem triar/investigar/siass. `acidente.ver` e `acidente.comunicar` entram nas funções do titular (servidor vê e comunica o que é dele). `acidentes` entra em `MODULOS_QUE_SUSTENTAM_A_BASE`.
- **Anexos.** Resolvedor `acidente_ocorrencia` em `anexo_acesso.ts`: exige `acidente.ver` no escopo da ocorrência; ocorrência restrita só para quem investiga ou encaminha ao SIASS (`servicos/acidente_acesso.ts`, também usado pela ficha); relatório na variante COMPLETA exige `acidente.saude_ver`. `acesso_dado_sensivel` ganhou `acidente_id` e `acidentado_id` (o «sobre quem» do acidentado que não é servidor), e `registrar_leitura_nominal` registra a leitura dele mesmo sem `servidor_id`.
- **Auditoria.** 33 eventos `ACIDENTE_*` com rótulo (≤ 40 caracteres), nenhum texto antigo alterado. A descrição não leva nome, fato nem dado de saúde.
- **Pendências.** Tipos `ACIDENTE_TRIAR` (2 dias), `PRAZO_COMUNICACAO` (10), `COMPLEMENTACAO` (5), `SAUDE_REGISTRAR` (5), `INVESTIGAR` (30), `ACAO_PRAZO` (30) e `AGUARDA_PERICIA` (60).
- **Esqueleto.** `rotas/acidentes.ts` (painel, fila, minhas, ficha com as dez abas; comunicar, plano de ação e indicadores respondem 200 com aviso de «próxima etapa»). Cada aba da ficha é um `include ... ignore missing` de `partes/acidente_aba_<nome>.html`: as fatias criam o parcial sem editar a ficha. Sem CSS novo além do cartão do módulo e dos tokens de cor (`.mod-acidentes`); ícones já existentes.
- **Fora desta fatia (costura final).** `rotinas.ts` (`TIPOS_VARRIDOS`, `EVENTOS_DO_TITULAR`), `atividade_titular`, a política de retenção e o ROPA (`docs/`) não foram editados: a fatia que ativa a gravação e a rotina de privacidade os altera. O `node_modules` do worktree é um link simbólico para o do repositório principal e **não entra em commit**.
- **E-mail corrigido antes da ativação.** Conta ainda sem senha acompanha a correção do e-mail no cadastro (e-mail e login; evento `ACESSO_EMAIL_ACOMPANHOU_CADASTRO`), salvo colisão com outra conta. Conta com senha não é tocada.
- **Saída do quadro (decisão do usuário).** Ao corrigir a situação do servidor para APOSENTADO ou EXONERADO (`atualizar_cadastro`), a conta ligada é inativada e as sessões, encerradas (`ACESSO_ENCERRADO_NA_SAIDA`). LICENÇA e CEDIDO não mexem. **Exceção:** conta de administração e a última que concede perfil ficam como estão, com o evento `ACESSO_MANTIDO_NA_SAIDA` e aviso na ficha — inativá-las tira o governo do sistema, e quem decide é quem concede perfil, em Usuários. Voltar a ATIVO no cadastro **não reativa** a conta: reativar é ato da equipe. Importação de planilha não altera situação, então não passa por aqui.

## Análise de Acidentes — F1: comunicar, fila e triagem (23/10/2026)

Feita sobre `entrada/acidentes_especificacao.md` §3, §4 e §7. O que difere ou precisa de aval:

- **Origem.** TITULAR quando a própria pessoa é um dos envolvidos («sou eu»); CHEFIA com «sou a chefia imediata» (D9); SST quando quem comunica tria; o colega que viu e comunica com a própria conta fica como TITULAR (o legado não tinha origem para ele). **Confirmar.**
- **Escopo próprio alargado.** O servidor comum vê a ocorrência em que é o acidentado principal E a que ele mesmo comunicou (`criado_por`), em `acidente_acesso.escopo_ocorrencias`. Sem isso, a chefia e o colega perdiam de vista o que enviaram.
- **Menor de idade (D14a).** A ocorrência fica restrita; quem comunicou sem ser da SST é levado a «Minhas comunicações» (a ficha é 404 para ele) com o aviso. `responsavel_legal_solicitado_em` fica nulo: o pedido ao responsável legal não tem fluxo ainda.
- **Saúde declarada (D4)** vai só na CAT/SP congelada, chave `saude_declarada` (origem DECLARADO_COMUNICANTE). Nenhuma linha em `acidente_saude` e nenhuma pendência ACIDENTE_SAUDE_REGISTRAR: as duas são da F3, que lê dali.
- **CPF.** A borda (`dependencias.formulario`) já mascara CPF em todo campo; o serviço recusa o que sobrar (número ou o termo) e a recusa devolve o digitado JÁ mascarado.
- **Retificação** muda os fatos do evento e o relato (CAT/SP N+1, origem RETIFICACAO_SST, motivo obrigatório); envolvidos e testemunhas ainda não se retificam por tela. Data do acidente nova move o prazo legal e a pendência.
- **Prorrogação do prazo** (D13): fica ao lado do prazo legal, com motivo, e move a pendência; evento ACIDENTE_PRAZO_PRORROGADO.
- **Complementação** só se pede quando a comunicação veio de uma conta (é ela que responde). A resposta vira CAT/SP N+1 (origem COMPLEMENTACAO) e volta à triagem; a equipe pode retomar sem resposta, e a tarefa do comunicante fecha.
- **Ir à investigação** abre a pendência ACIDENTE_INVESTIGAR (30 dias); quem fecha é o relatório (F6).
- **E-mail** (`acidente_email.ts`), atrás de `CSSO_ACIDENTE_EMAIL=sim` e `CSSO_ACIDENTE_EMAIL_SETOR` (config nova): comunicação nova ao setor e confirmação ao comunicante; pedido de complementação ao comunicante. Só protocolo e link.
- **Não feito nesta fatia.** O anexo opcional na comunicação (≤4 MB) e o autocompletar de servidor (o servidor entra pelo SIAPE); a varredura noturna do prazo (`TIPOS_VARRIDOS`) e `EVENTOS_DO_TITULAR` ficam para a costura, que é dona desses arquivos.
- **Armadilha de template.** `base.html` faz `{% set partes = ... %}` com o nome do usuário; uma variável de contexto `partes` é sobrescrita em toda página logada. O catálogo de partes do corpo se chama `partes_corpo`.
- **Módulo seguro na produção (decisão do usuário, 23/10/2026).** Até a F6 e a emenda da ROPA (§4 da especificação), `config.acidentesLiberado()`: em produção o módulo só vale com `CSSO_MODULO_ACIDENTES=sim`. Sem ela, o cartão aparece «em desenvolvimento» (`disponivel: false`), o grupo «Acidentes» sai do Meu espaço e toda rota `/acidentes*` responde 404. Fora da produção vale por padrão; `CSSO_MODULO_ACIDENTES=nao` desliga em qualquer ambiente. O menu é decidido ao carregar a função (a variável muda com a publicação); a rota confere a cada pedido.

## Análise de Acidentes — F2: comunicação por link, sem conta (23/10/2026)

D1b. `/acidente/:token` (`servicos/acidente_publico.ts`, `rotas/acidente_publico.ts`) e a tela da equipe `/acidentes/link` (`acidente.triar`).

- **Link.** Geral ou por campus; token de 24 bytes mostrado UMA vez, o banco guarda o SHA-256. Gerar de novo para o mesmo recorte desliga o anterior. Sem validade: dura até ser trocado ou desligado. O link de campus grava a ocorrência com o campus dele.
- **Anti-abuso, nesta ordem.** Limite por IP (5 envios em 10 min, contador próprio `acidente:` em `limite_login_ip`; `inscricao_publica.dentro_do_limite` ganhou `prefixo` e `limite`) ANTES de olhar o token; campo-isca `site` (mesma resposta 303, só o evento `ACIDENTE_PUBLICO_HONEYPOT`, sem conteúdo); teto de 30 comunicações por link ainda RECEBIDAS (`ajuste.teto_em_espera`) — cheio, 503 com a saída ("comunique à equipe ou à chefia").
- **Sem oráculo de cadastro.** O formulário não consulta o cadastro: todo envolvido entra pelo nome; um campo "SIAPE, matrícula ou crachá" guarda 7 dígitos em `acidentado.siape` (não conferido, a ficha diz isso) e o resto em `identificacao_externa`. A vinculação ao cadastro (`ACIDENTE_ACIDENTADO_VINCULADO`) fica para depois: até lá, o servidor que se acidentou e foi comunicado pelo link não vê a ocorrência em «Minhas comunicações».
- **Comunicante** se identifica por nome, e-mail e vínculo (`acidente_comunicante`, D14b); o IP é apagado em 90 dias (`privacidade.expurgar_ip_de_acidente`, na rotina). Consentimento ("li o aviso de privacidade") e declaração obrigatórios. Nenhum e-mail ao comunicante (D6); o setor recebe, como na F1.
- **Minimização.** Sem anexo e sem saúde declarada no link (a ROPA pede o mínimo para quem não tem conta); quem conduz pergunta à pessoa.
- **Complementação.** Não se pede a quem comunicou sem conta: o botão some e a aba explica o caminho (e-mail + retificação da CAT/SP).
- **PRG.** O envio responde 303 para o próprio link; o protocolo viaja num cookie de 30 min preso ao caminho. O robô recebe a mesma tela "recebida", sem protocolo.
- **Trava.** Segue `acidentesLiberado()`: com o módulo seguro na produção, `/acidente/*` também é 404.

## Análise de Acidentes — F4: investigação MAPA (23/10/2026)

`servicos/acidente_investigacao.ts`, `acidente_checklist.ts`, `acidente_entrevista.ts`, `rotas/acidente_investigacao.ts`, abas Investigação, Checklist e Entrevistas da ficha, `public/estaticos/js/gravador.js`.

- **Quem vê e quem edita.** As três abas são de quem investiga ou encaminha ao SIASS (`pode_ver_restrita_sst`): relato e evidência são dado de terceiro. Edita quem tem `acidente.investigar`, na triagem e na investigação; depois do relatório (e no caso encerrado) trava — mudar o que o relatório disse é retificar o relatório (F6).
- **Controle otimista** no MAPA: a tela velha volta com 409, o que foi digitado ao lado do gravado, e nada sobrescreve. Diff por campo na trilha (`registrar_diferencas`, evento `ACIDENTE_INVESTIGACAO_SALVA`). No lugar do autosave do legado, rascunho local no navegador (`data-rascunho-local`) e o "Salvar".
- **Os valores dos campos do MAPA vão para a trilha** (o diff tem antes e depois). Os campos recusam CPF e termo de saúde, mas texto livre pode citar pessoas: a trilha é lida por quem tem `auditoria.ver`. **Confirmar** se basta, ou se a trilha deve guardar só o nome do campo, como a saúde.
- **Checklist**: base nas seções 0 a 7 e pontos específicos na 8, por espécie (trajeto), óbito declarado e PALAVRA INTEIRA do caso (relato, local, atividade, agente causador) — sem os falsos positivos do legado. **Os textos dos itens foram escritos nesta fatia** a partir das seções do legado (que não estavam no repositório): a equipe de SST deve revisá-los (`ESPECIFICOS` e `BASE` em `acidente_checklist.ts`). Item da equipe (MANUAL) sai; os da base e os específicos ficam (a observação diz "não se aplica").
- **Entrevistas**: gravação só com "consentimento obtido" marcado (o gravador não liga sem a caixa; o servidor recusa o áudio sem ela; o banco guarda quem registrou). Tipo pelos bytes (áudio WebM, Ogg, WAV, MP3, M4A; evidência PDF, PNG, JPEG, GIF, WebP), teto de 4 MB. Sem transcrição automática (era Web Speech, API externa).
- **Anexos `EVIDENCIA_ACIDENTE`** (evidência e gravação) passaram a baixar só para quem investiga ou encaminha ao SIASS (`anexo_acesso.dono_acidente`); antes, qualquer um no escopo da ocorrência, inclusive o titular, os baixaria.
- **Não feito.** Unidade de exposição (doença do trabalho), marcar evidência "citada no relatório" (é da F6) e o link para a ficha de EPI do acidentado.

## Primeiro acesso / Cadastre-se e Esqueci minha senha para todos (23/10/2026)

Pedido do usuário: "permitir fazer cadastro no sistema com botão de cadastro, e analisar a necessidade do botão de ativar meu acesso". Três análises (experiência, código e segurança) chegaram ao mesmo desenho, escolhido pelo usuário ("Pedido conferido"):

- **Login.** O link «Ativar meu acesso / Esqueci minha senha» virou dois: **«Primeiro acesso / Cadastre-se»** (`/cadastre-se`) e **«Esqueci minha senha»** (`/esqueci-senha`).
- **`/cadastre-se` pergunta o vínculo.** Servidor segue para `/ativar-acesso` (agora «Primeiro acesso do servidor»): a conta dele já nasce do cadastro de servidores, e o botão continua necessário porque é por ele que a conta sem senha ganha a primeira. Terceirizado e discente preenchem um **pedido** (`pedido_conta`, migração **0023**): nome, e-mail, empresa ou curso, setor ou matrícula, «tenho 18 anos ou mais». Discente só com `@ufvjm.edu.br` (`pedido_conta.DOMINIO_DISCENTE`).
- **Nada nasce do pedido.** Ele entra na fila **Usuários → Pedidos de conta** (`/usuarios/pedidos`, `usuario.criar_conta`) com a pendência nova `CONTA_A_CONFERIR` (sem responsável, 5 dias, fecha sozinha na decisão). **Aprovar** cria a conta sem senha (`SEM_SENHA`), com o perfil do vínculo (`terceirizado`/`discente`, ato «Pedido de conta nº N conferido pela equipe»), sem servidor, e manda ao e-mail do pedido o link de definir a senha (72 h). **Recusar** pede o motivo (fica no pedido) e avisa a pessoa sem ele. A aprovação reconfere se o e-mail ganhou conta ou é de servidor.
- **Sem oráculo.** Mesma frase e piso de tempo para todo pedido. E-mail que já é de conta, de servidor ou de pedido na fila não abre outro: vira um registro `DESCARTADO` (só para o teto por IP, sem dado) e o dono recebe a mensagem neutra `PEDIDO_CONTA_NEUTRO`, que conta no teto por destinatário. Teto de 5 pedidos por hora por IP.
- **«Esqueci minha senha» por e-mail, para qualquer conta** (`ativar_acesso.pedir_por_email`). Conta de servidor segue a regra do servidor (o e-mail do cadastro); e-mail sem conta mas de servidor do cadastro vira o primeiro acesso dele; as outras contas recebem o link no e-mail delas (`ativacao_acesso.usuario_id`, novo); inativa e de administração recebem o neutro. O link (`/ativar-acesso/:token`) é o mesmo: com `usuario_id`, só define a senha da conta (`ACESSO_ATIVADO` na primeira, `SENHA_REDEFINIDA_POR_LINK` nas outras).
- **Furo 1 fechado: o link do servidor não adota conta externa.** `decidir` recusava só a conta ligada a OUTRO servidor; a conta sem servidor com perfil `terceirizado`/`discente` e o mesmo e-mail era redefinida pelo link do servidor. Agora é «recusar» (neutro, a equipe decide).
- **Furo 2 fechado: a troca do e-mail em Meus dados pede confirmação.** Além da senha atual, o endereço novo recebe um link de 24 h (`TROCA_EMAIL`, `ativacao_acesso.email_novo`) que **a própria conta** abre (`/minha-conta/email/:token`, com sessão); só então e-mail e login mudam (`EMAIL_ALTERADO_PELO_TITULAR`). O pedido grava `TROCA_DE_EMAIL_PEDIDA`. O link de troca nunca serve para definir senha.
- **Privacidade.** ROPA §5.12 e a linha de retenção (pedido apagado em 90 dias, `pedido_conta.expurgar` na rotina `EXPURGO_PRIVACIDADE`). Trilha só com o número do pedido e o vínculo.
- **Testes.** `testes/cadastre_se.test.ts` (novo); `ABERTAS_SEM_SESSAO` e `SEM_PERMISSAO_DE_RBAC` com as duas telas novas; `minha_conta`, `login_email` e `ativar_acesso` ajustados ao novo texto e à confirmação do e-mail.
- **Terceirizado e discente por dentro** (mesma entrega): Meu espaço com treinamentos, certificados (com o comprovante), comunicar acidente e minhas comunicações, sem EPI, processo nem adicional; a primeira tela deles é `/turmas/minhas`; a inscrição em turma liga a conta a um participante (`participante.usuario_id`); o «Sou eu» do comunicar acidente usa o nome da conta e o vínculo do perfil.

## A senha é escolhida no pedido, e o link só confirma o e-mail (24/10/2026)

Pedido do usuário: "no cadastro já não seria melhor o usuário escolher a sua senha ao invés de receber um link para definir a senha?". Escolhido: no cadastro (terceirizado e discente) e no primeiro acesso do servidor.

- **O link continua, mas só confirma.** É ele que prova a posse do e-mail: sem ele, quem digitasse o e-mail de outra pessoa com uma senha sua entraria como ela depois da aprovação. Abrir o link mostra um botão "Confirmar" (o POST é que confirma: leitor de e-mail pré-visualiza links), e a tela e o e-mail dizem "se não foi você, não confirme".
- **Cadastre-se** (migração **0024**): o formulário pede a senha e a confirmação (a política de `politica_de_senha`, com a barra de força). O pedido nasce `AGUARDANDO_EMAIL`, com `senha_hash` (argon2) e o link `/cadastre-se/confirmar/:token` (24 h, tipo `PEDIDO_CONTA_CONFIRMAR`, que conta no teto por destinatário). Só o clique o leva a `PENDENTE`, com a pendência e o evento `PEDIDO_DE_CONTA_RECEBIDO`; a fila da equipe só mostra o confirmado. Um novo pedido do mesmo e-mail descarta o não confirmado (ninguém bloqueia o e-mail alheio pedindo antes). **Aprovar** cria a conta com a senha escolhida e manda o aviso "conta liberada, entre com a sua senha" (`PEDIDO_CONTA_APROVADO`), sem link; o pedido antigo, sem senha, segue com o link de definir. A senha sai do pedido na decisão; o não confirmado sai em 3 dias (`DIAS_SEM_CONFIRMACAO`).
- **Primeiro acesso do servidor**: SIAPE, e-mail e senha numa tela. Batendo com o cadastro, o link (24 h) só confirma (`ativacao_acesso.senha_hash`) e a conta nasce, ou a conta ainda sem senha recebe, a senha escolhida; sai o aviso `ACESSO_ATIVADO_AVISO` ("se não foi você, use Esqueci minha senha"). **Conta que já tem senha não a troca por um clique**: a senha digitada é ignorada e o link volta a pedir a senha, como o "Esqueci" — senão bastaria pedir com o SIAPE e o e-mail de outra pessoa e convencê-la a clicar. O formulário sem os campos de senha (o caminho antigo) continua aceito pelo servidor, com o link que pede a senha.
- **Esqueci minha senha** não muda: o link pede a senha nova (a conta já existe; uma senha escolhida antes do link seria trocada por um clique).
- **Testes.** `testes/cadastre_se.test.ts` cobre os dois fluxos (abrir não confirma, o botão confirma, senha fraca, o não confirmado que dá lugar ao novo, conta com senha que não troca por clique, aviso depois da ativação, expurgo em 3 dias).

## A conta do Cadastre-se é liberada sozinha; a equipe bloqueia ou exclui (24/10/2026)

Pedido do usuário: "aprove automaticamente todo pedido de conta, não preciso autorizar todos, pode colocar a possibilidade de bloquear ou excluir".

- **Liberação automática.** Ao clicar em "Confirmar o e-mail", o pedido vira conta na hora (`pedido_conta.confirmar_email` → `_liberar`): senha escolhida, perfil do vínculo, sem servidor, ator «liberação automática do Cadastre-se» na trilha (`concedido_por` e `decidido_por` nulos). A tela diz «Conta liberada» e leva à entrada; não sai e-mail de aprovação (a pessoa está na tela). Não abre mais a pendência `CONTA_A_CONFERIR`. O link do e-mail continua sendo a prova da posse do e-mail; o vínculo declarado deixa de ser conferido antes.
- **Contas do Cadastre-se** (`/usuarios/pedidos`, era «Pedidos de conta»; botão em Usuários): lista as contas de terceirizado e discente (perfil vigente, sem servidor), com a empresa ou o curso do pedido, e as ações **Bloquear / Desbloquear** (inativa e encerra as sessões; eventos `USUARIO_INATIVADO`/`USUARIO_ATIVADO`) e **Excluir**. Só para conta externa pura: conta de servidor ou com outro perfil é recusada (422) e fica em Usuários.
- **Excluir** apaga, num savepoint, as atribuições, as sessões e a conta; o pedido perde o elo (`usuario_id` nulo) e o evento `USUARIO_EXCLUIDO` leva só o número. Se algum registro aponta para a conta (inscrição, certificado, comunicação, trilha — 70 chaves estrangeiras), o banco recusa e a conta é **bloqueada no lugar**, com a mensagem dizendo por quê.
- **Pedidos antigos** que ficaram `PENDENTE` (de antes desta mudança) ainda aparecem em «A conferir», com Aprovar e Recusar.

## Avaliação de reação (24/10/2026)

`servicos/avaliacao_reacao.ts`, `rotas/avaliacao_reacao.ts`, `avaliacao_reacao.html`, `turma_avaliacao_reacao.html`, `treinamentos_avaliacao_reacao.html`, migração **0025** (`avaliacao_reacao`).

- **Questionário fixo no código**, versão `v1` (`ITENS`): conteúdo e objetivos, instrutor(es), material e recursos, local e infraestrutura, carga horária adequada, "recomendaria a um colega?" (todos de 1 a 5, obrigatórios) e o comentário opcional (até 1000 caracteres; recusa CPF — a máscara da porta vira recusa — e termo de saúde por `textos.exigir_texto_limpo` com o rótulo "Comentário"). A resposta guarda a versão: item novo é versão nova.
- **Quem responde**: a inscrição que FREQUENTOU (fora de cancelada e de "em análise", e ao menos um dia presente — `Inscricao.compareceu`), na turma que terminou (concluída, ou `data_fim` passou; nunca a cancelada), até **60 dias** depois do fim (`PRAZO_DIAS`). Sem prazo, o "Avaliar" ficaria para sempre nas turmas antigas importadas. Uma resposta por inscrição: o `UPDATE ... WHERE NOT avaliacao_respondida` é a trava (duplo clique, conta e link ao mesmo tempo).
- **Pela conta**: "Avaliar" em Meus treinamentos (`/turmas/minhas/:turma_id/avaliar`, `treinamento.ver`); a rota não aceita "quem". Depois de respondida, a linha diz "avaliação enviada".
- **Sem conta**: um convite por inscrição (`avaliacao_reacao_convite`: a inscrição, o SHA-256 do token de 192 bits e o último dia), enfileirado em `turma.mudar_situacao` logo depois da apuração, a quem pode avaliar e tem e-mail. **Idempotente** (quem tem convite ou já respondeu não recebe outro). **Só com o envio de e-mail ligado** (`email.configurado()`): sem ele não nasce token, e quem tem conta avalia do mesmo jeito. Quem passa a ter frequência por retificação depois da conclusão não recebe link (avalia pela conta). O e-mail vence com o prazo (`expira_em`). `/avaliacao/:token`: sem sessão, `noindex`, `no-store`, `no-referrer`; o GET não gasta, o POST apaga o convite (DELETE condicional) e grava; a recusa (nota faltando) não gasta. Token desconhecido, usado ou vencido: a MESMA página 404 — por isso a rota não entra em `ABERTAS_SEM_SESSAO` (o teste mede 200 com o token `1`), como `/certificados/acesso/{token}`; o POST está em `SEM_PERMISSAO_DE_RBAC`. Responder pela conta apaga o convite que sobrou. O convite vencido sai na rotina de privacidade (`expurgar_convites`).
- **Anonimato**: `avaliacao_reacao_resposta` tem só turma, versão, notas, comentário e o DIA, sem chave para inscrição, participante ou conta, e com chave **uuid sorteada** — um id sequencial diria a ordem de chegada, e a ordem casaria com a trilha e com o `registro_acesso` (que tem a conta e a hora do POST). Na inscrição, só o booleano `avaliacao_respondida`, **sem hora** (a hora casaria com o dia da resposta). A trilha (`AVALIACAO_REACAO_RECEBIDA`) diz "TUR-…: recebeu uma avaliação de reação", com `usuario` nulo, `usuario_nome` "avaliação anônima" e sem IP. **Limite conhecido**: a hora do evento na trilha e a do POST no `registro_acesso` dizem QUE a conta respondeu naquela hora — o que a inscrição já diz —, não O QUE respondeu. `AVALIACAO_REACAO_CONVITES` conta os convites, sem endereço.
- **Resultado**: página própria `/turmas/:id/avaliacao`, ligada como aba "Avaliação de reação" na barra da ficha, para quem opera turmas (`turma.criar`, `turma.inscrever`, `turma.avaliar` ou `turma.concluir` — o `PERMISSOES_DE_QUEM_GERENCIA` da ficha), com a turma recortada pelo escopo e pelo setor dessas permissões. Página própria, e não `?aba=`, para não mexer no corpo da ficha. Mostra respostas ÷ elegíveis (quem frequentou), média e distribuição por item e os comentários **embaralhados** (`crypto.randomInt`). **Piso de 3**: abaixo, só a contagem. Auditor e PROGEP (só `certificado.ver`) não leem: o resultado é instrumento de quem dá o treinamento — **confirmar** com a coordenação se devem ler.
- **Consolidado** `/treinamentos/avaliacao-de-reacao` (link no resultado da turma): média de cada item por treinamento e por instrutor, só das turmas no escopo de quem lê, com o mesmo piso por linha. Na turma com dois instrutores a nota "instrutor(es)" conta para os dois — o questionário não separa (seria uma pergunta por instrutor, versão nova).
- **Limpeza de treinamentos**: as duas tabelas entram em `TABELAS_APAGAR` e o tipo de e-mail `AVALIACAO_REACAO` nos apagados.
- **Integração**: a migração foi gerada como 0025 em paralelo com outras; quem junta renumera. Nos arquivos compartilhados: uma chamada em `turma.mudar_situacao`, o `avaliavel` de Meus treinamentos e o `ve_avaliacao_reacao` da ficha em `rotas/turmas.ts`, o link na barra de abas de `turma_ficha.html` e o botão em `turmas_minhas.html`.

## Locais de treinamento e «Turmas encerrando» (24/10/2026)

Migração **0025_locais_treinamento** (o número pode colidir com outras fatias do mesmo dia: quem integra renumera). `servicos/local_treinamento.ts`, `rotas/locais_treinamento.ts`, `paginas/treinamentos_locais.html`, `partes/local_turma.html`.

- **Cadastro.** Tabela `local_treinamento` (nome, campus opcional, endereço/sala, capacidade opcional, observações, ativo, `criado_por`). Tela **Cadastros → Locais** (`/treinamentos/locais`): a leitura é da equipe (`exigir_na_equipe("treinamento.ver")`, como o catálogo de treinamentos); cadastrar, editar e inativar/reativar pedem `treinamento.gerenciar` (a do catálogo). Não se apaga: o inativo sai da escolha. O mesmo nome no mesmo campus (sem diferença de caixa ou espaço) é recusado; noutro campus, ou sem campus, é outro lugar (a regra é do serviço, sem UNIQUE no banco). Trilha: `LOCAL_TREINAMENTO_CRIADO/INATIVADO/REATIVADO` e o diff campo a campo da edição.
- **A turma guarda o nome no texto livre.** `turma.local_id` (FK opcional). Com local escolhido, `turma.local` recebe o NOME do local — por isso o certificado (`turma_local`), a agenda .ics, o e-mail de inscrição, a lista de presença, a inscrição pública, Meus treinamentos, as listas e o painel mostram o cadastrado **sem mudar nenhum leitor**. Sem local (turma antiga, «outro local»), o texto é o de sempre. A ficha mostra também o endereço e a capacidade (relação `turma.local_cadastrado`, em `COM_TURMA`).
- **Renomear o local** leva o nome novo às turmas PLANEJADA/INSCRIÇÕES ABERTAS/EM ANDAMENTO (cada uma com o diff de `local` na trilha); a concluída e a cancelada ficam com o nome do dia, como o certificado emitido. **Conferir** se é o que o setor quer.
- **Formulário.** Com algum local cadastrado, o campo «Local» vira seletor (os ativos, e o inativo que a turma já tem) mais «outro local», que mostra o texto livre (`data-mostra-quando`). A lista segue o campus escolhido no formulário (`data-filtra-campus`, novo no csso.js); o servidor recusa o local de outro campus e o inativo que a turma ainda não tinha. Sem local cadastrado, o campo é o texto de antes. Regra de `editar_turma`: `local_id` no formulário decide; sem ele (formulário antigo, retificação da concluída), o texto diferente do atual solta o vínculo. A retificação continua só com o texto.
- **Avisos, não recusas.** Vagas acima da capacidade; e **choque de sala**: outra turma não cancelada no mesmo local, com datas que se cruzam e horários que se cruzam (sem hora = dia inteiro; sem hora de fim = até o fim do dia; 8h–12h e 12h–17h não se chocam). A concluída conta como ocupante. Saem no recado de quem salva («… Atenção: …») e num bloco «Aviso(s) do local» na ficha (só para quem opera a turma); a turma concluída ou cancelada não recebe aviso. O atalho «turma aberta com link» vai à tela do link e não repete o aviso ali (a ficha o mostra).
- **Turmas encerrando** (Início de Treinamentos, `hub_treinamentos.turmas_encerrando`): turmas PLANEJADA/INSCRIÇÕES ABERTAS/EM ANDAMENTO com término até hoje + 30 dias, inclusive as que já terminaram sem ser concluídas («atrasada», primeiro, por ordem de término). Escopo `consulta_no_escopo(usuario, "treinamento.ver")` — o mesmo das «Próximas turmas» (campus e setor promotor). Até 15 na tela, e «e mais N». Pendências, sobre quem ocupa vaga: **presença** = inscritos com menos lançamentos do que dias da turma (todos os dias, inclusive os que ainda não chegaram); **nota** = inscritos sem nota, só quando a turma tem nota mínima; **certificados** = inscritos sem certificado em vigor (AUSENTE e REPROVADO não contam) — na turma não concluída é, por construção, quase todo mundo; a atrasada ganha «concluir a turma».
- **Também.** `local_treinamento` entrou em `TABELAS_MANTIDAS` da limpeza de treinamentos (é cadastro, como os modelos). O item novo do menu ajustou `modulos`, `menu_certificados` e `treinamentos.test.ts`. O teto de `/turmas` em `idas_ao_banco.test.ts` subiu de 20 para 21 (a consulta dos locais do seletor da turma nova). Testes em `testes/locais_treinamento.test.ts`.

## Qualificação do instrutor (24/10/2026)

Pedido: NR-10, NR-33 e NR-35 cobram que o instrutor do treinamento seja comprovadamente qualificado, e o sistema não guardava isso.

- **Tabela `instrutor_qualificacao`** (migração `qualificacao_instrutor`, gerada como **0025**): instrutor, descrição, o treinamento que habilita (FK opcional) e/ou a norma (texto), instituição emissora, emissão, válida até (nula = sem validade), o comprovante (`comprovante_anexo_id`), ativo, quem cadastrou e quem inativou. CHECK: treinamento ou norma (ao menos um); validade não antes da emissão. O comprovante é nulo só entre o INSERT e o anexo (que pede o id da linha); a rota grava os dois num savepoint e recusa o cadastro sem arquivo. Não se apaga: inativa.
- **Comprovante**: categoria de anexo nova `QUALIFICACAO_INSTRUTOR` (entra no `ck_anexo_cat`), **RESTRITO**; PDF, PNG ou JPEG conferidos pelos primeiros bytes; teto de 4 MB. Baixa pelo `/anexos/:id` de sempre, com o resolvedor novo `instrutor_qualificacao` em `anexo_acesso.ts`: só `assinatura.gerenciar` com acesso ao módulo Certificados (quem vê turma ou certificado não baixa). O download vai à trilha (`ANEXO_BAIXADO`) e, para instrutor servidor, a `acesso_dado_sensivel`.
- **Permissão**: `assinatura.gerenciar` (a da tela de Instrutores), mais o acesso ao módulo, como as outras ações de instrutor. A ficha é `/treinamentos/assinaturas/:id/qualificacoes` (a lista de instrutores ganhou o link, com "N a renovar" quando alguma vence ou venceu); cadastrar e inativar são POST nela. `/treinamentos/qualificacoes/:id` só redireciona à linha da qualificação (é o link da pendência).
- **"Habilita"**: a qualificação aponta para o treinamento, ou a norma dela é uma das de `treinamento.norma_referencia`. A norma se compara sem acento, caixa, espaço e pontuação ("NR-35" = "nr 35"); a referência pode listar várias separadas por `/`, `,`, `;`, `+` ou " e ".
- **Aviso ao escalar** (não bloqueia): o instrutor sem qualificação ativa que habilite o treinamento e que cubra a turma inteira (emitida até o primeiro dia e válida até o último) recebe aviso na mensagem do "Vincular", na linha dele na ficha da turma e na lista de escolha ("sem qualificação para este treinamento"). Treinamento sem norma e sem qualificação ativa vinculada a ele (de instrutor nenhum) não avisa. O aviso só sai para quem gerencia a turma. Na turma só se tocou na parte do instrutor; o instrutor padrão que entra sozinho na turma nova não gera mensagem (a ficha mostra o aviso).
- **Pendência `INSTRUTOR_QUALIFICACAO_A_VENCER`** (prazo = a validade, sem responsável; quem fecha a dos outros: `assinatura.gerenciar`; âncora `instrutor_qualificacao`, que leva à ficha do instrutor). A rotina noturna (`varrer_pendencias`) a abre quando a validade entra nos 30 dias; o cadastro também, se já nasce na janela. Idempotente pela chave `instrutor-qualificacao-<id>-a-vencer` (não reabre). Fecha sozinha (`concluir_pela_rotina`) quando há outra qualificação ativa do mesmo instrutor para o mesmo fim (mesmo treinamento ou mesma norma) válida além desta, quando ela é inativada ou quando o instrutor é inativado. A já vencida quando a rotina passa não abre (como a reciclagem). A descrição não leva o nome do instrutor, só o número.
- **Exclusão**: instrutor ou treinamento com qualificação cadastrada não se exclui (a mensagem diz para desmarcar "ativo"). `limpar-treinamentos` apaga a tabela, os anexos e as pendências dela junto com o módulo.
- **Privacidade**: ROPA §5.13 e a linha de retenção.
- **Testes**: `testes/qualificacao_instrutor.test.ts` (novo); `limpar_treinamentos` com a qualificação no cenário.


## Trava do envio duplicado e mostrar/ocultar senha (24/10/2026)

Pedido do usuário ("faça as melhorias"), a partir da comparação com o eSocial Brasil (só a ideia; nenhum código de lá).

- **Trava do envio duplicado** (`csso.js`, bloco 13). Enviado um formulário POST, o botão que o enviou vira «Aguarde…» (`aria-busy`, `aria-disabled`, anúncio `role=status`) e o segundo envio do mesmo formulário é recusado até a página trocar. Só trava o que saiu de fato: se outro tratador cancelou o envio (o HTMX, uma conferência) ou se a validação do navegador barrou, nada muda. Não usa `disabled` (o botão sumiria do envio e do teclado). Formulário GET (filtros, busca) e com `target` não travam; `data-sem-trava` no form ou no botão desliga. Formulário que responde com arquivo não troca de página: a trava se desfaz em 8 s; voltar pelo navegador (bfcache) também desfaz. No HTMX, só o «Aguarde…» enquanto a requisição está no ar. É uma exceção consciente à regra 4 do cabeçalho do `csso.js` («nenhum bloqueia um envio»): o que se recusa é o REPETIDO, não o primeiro; o servidor continua sendo quem impede o registro em dobro.
- **Mostrar/ocultar senha** (bloco 14). Contrato `data-mostrar-senha` nos campos de senha (entrar, primeiro acesso, cadastre-se, definir senha, trocar senha, Meus dados e o bootstrap): um botão «Mostrar»/«Ocultar» dentro do campo, com `aria-pressed` e o nome do campo para o leitor de tela. Ao enviar, o campo volta a `password`. Sem script, o campo é o de sempre.
- **CSS** antes do bloco de impressão (`@page`/`@media print` continuam os últimos, como o teste de `celular_casca` exige); o giro do «Aguarde…» herda a cor da letra e para com `prefers-reduced-motion`.

## Limpar dados de teste (24/10/2026)

Pedido: uma tela para o **Administrador do sistema** zerar os dados de movimento depois dos testes no ambiente de produção. `servicos/limpeza.ts` (o motor), `rotas/limpar_dados.ts`, `paginas/limpar_dados.html`, migração **0026**, `testes/limpar_dados.test.ts`.

- **O motor é o de `limpar-treinamentos`, generalizado.** Um *plano* diz o que sai inteiro (`apagar`), o que sai em parte (`parciais`: `onde`, `seguir` uma chave estrangeira, `exceto`), o que fica e perde o vínculo (`desvincular`, `tabela.coluna` zerada) e quais gatilhos de DELETE do módulo se suspendem (`travas`). Numa transação: trava (ACCESS EXCLUSIVE) tudo o que o plano toca; lê as chaves estrangeiras do catálogo e recusa se uma linha que FICA aponta para linha que SAI sem estar declarada, ou se há gatilho de DELETE fora das travas; fixa os ids das parciais ANTES de mexer; (backup); suspende as travas, desvincula, apaga por DELETE em ordem topológica (nunca TRUNCATE), religa as travas e confere que todo gatilho do esquema está ligado; registra UM evento pela via oficial; confere que zerou e que **toda** outra tabela do banco tem a mesma contagem (menos as que mudam sozinhas: sessão, registro de acesso, limite de login, rotinas, conferência da cadeia, ativação, pedido de conta, acesso de participante, leitura de dado sensível, fila de e-mail — `TABELAS_VOLATEIS`). `anexo` e `pendencia` ganham sozinhos a âncora (`entidade`/`entidade_id`) de tudo o que sai; o anexo apontado por chave estrangeira de linha que sai sai junto, e o anexo que uma linha que fica aponta — ou ancorado numa tabela que fica — fica (a orientação do catálogo de EPI que a ficha apontava). O blob só sai do armazenamento se nenhum anexo que fica, nem modelo de certificado enviado, usa o mesmo conteúdo. Os arquivos órfãos saem **depois do COMMIT**: o middleware da transação ganhou `depoisDoCommit` (`nucleo/contexto.ts`), que roda só se gravou; falha ali vai ao log, não desfaz o banco.
- **A ferramenta de linha de comando usa o motor** com o plano de treinamentos **menos os locais** (ela sempre os manteve; a tela os apaga, como pedido). Mudou pouco: apaga também os e-mails `INSCRICAO_ACEITA`, `INSCRICAO_RECUSADA` e `ACESSO_CERTIFICADOS` (eram do módulo e ficavam), desvincula `acidentado.participante_id` em vez de recusar, e o grafo passou a olhar só gatilho de DELETE (TRUNCATE não se usa). O evento continua `DADOS_DE_TREINAMENTO_APAGADOS`, na âncora `instalacao`. `testes/limpar_treinamentos.test.ts` passa sem mudança.
- **O que cada módulo apaga (e o que fica).**
  - *Treinamentos e certificados*: treinamento, turma, instrutor/ajudante da turma, presença, inscrição, participante (e-mails, juntados, pares), certificado (e valores por turma/inscrição), assinatura de instrutor, qualificação de instrutor, acesso do participante, vínculo EPI × treinamento, avaliação de reação (convite e resposta), **local de treinamento**; e-mails CERTIFICADO, RECICLAGEM_AVISO, AVISO_CADASTRO_EXISTENTE, AVISO_PEDIDO_REPETIDO, AVALIACAO_REACAO, INSCRICAO_ACEITA/RECUSADA, ACESSO_CERTIFICADOS; os .docx/.pdf de certificado e a lista de presença. **Fica**: o modelo de certificado (sem o vínculo com o treinamento) e a numeração (`certificado_sequencia*`, `turma_sequencia`).
  - *Acidentes*: ocorrência, acidentado, testemunha, comunicante, complementação, saúde (e partes do corpo), CAT/SP, investigação, linha do tempo, barreira, checklist, entrevista, evidência, unidade de exposição, ação do plano, relatório, encaminhamento ao SIASS, decisão pericial, link público; e-mails ACIDENTE_*. Suspende as doze travas `*_sem_delete` do módulo. **Fica**: os catálogos e `acidente_cat_sp_sequencia`.
  - *EPI*: requisição e itens, ficha (entregas, devoluções, estornos), entrada de estoque (lotes), movimento, comunicação do titular; e-mails EPI_*; o comprovante .docx. Suspende `trg_epi_ficha_sem_delete`, `trg_epi_movimento_sem_delete` e `trg_epi_comunicacao_sem_delete`. **Fica**: o catálogo (item, categoria, motivo de recusa, foto e orientação) e `epi_requisicao_sequencia`.
  - *Processos e demandas*: processo, checklist e itens, parecer (postos e exposições), adicional (vigências), laudo (e postos), demanda e encaminhamento da demanda; o .docx do parecer (pela listagem de `documentos/<ano>/Parecer_Tecnico_<NN>-<ano>_`). Suspende `trg_demanda_encaminhamento_sem_delete`. **Fica**: catálogos do adicional, setor emissor, autoridade, profissional habilitado, portaria de localização e `parecer_sequencia`.
  - Em todos: os anexos, as pendências e os e-mails da fila ligados ao que sai. A leitura de dado sensível (`acesso_dado_sensivel`, RN-23) **fica** — quem leu e quando — e perde só o vínculo com a ocorrência, o acidentado ou o processo.
- **"Apagar também servidores e contas"** só vai com os quatro módulos (servidor e conta são citados por todos eles; apagar a pessoa deixando o processo dela não fecha). Apaga contas e servidores, com atribuições, sessões, níveis por módulo, equipe de setor, lotações (e postos), portaria × servidor, pedidos de conta, links de ativação, leituras de dado sensível feitas pelas contas que saem e os e-mails de conta (ATIVAR_ACESSO*, ACESSO_ATIVADO_AVISO, TROCA_EMAIL, PEDIDO_CONTA_*). **Nunca** sai: a conta de quem limpa e toda conta com atribuição — vigente, futura **ou passada** — de perfil do topo (`TOPO_DA_HIERARQUIA`) ou de perfil com `perfil.conceder` (conservador de propósito), e os servidores ligados a elas. O que fica e apontava para conta que saiu perde o vínculo (quem concedeu, quem vinculou, quem alterou o nível, quem criou o modelo, quem enviou o anexo, o responsável da pendência, a habilitação técnica, a lotação registrada, a conferência da cadeia). No fim, confere que há conta ativa que concede perfil (`governanca.contas_que_concedem`).
- **A trilha perdeu a chave estrangeira para `processo` e `usuario` (migração 0026).** Ela é append-only e não se reescreve para deixar de apontar, então com a chave nenhum processo nem conta citados nela saíam nunca. É o mesmo raciocínio de `conferencia_cadeia`: o laudo não impede que o objeto saia. Nenhuma das duas colunas entra no digest. O "Excluir" de Contas do Cadastre-se dependia da chave para recusar a conta citada na trilha: a conferência ficou escrita em `pedido_conta.excluir` (o teste de lá passa igual). **Conferir** ao integrar: é a única mudança de esquema.
- **As travas do módulo se suspendem; a da trilha nunca.** A CAT/SP, a ficha de EPI, o encaminhamento etc. não se apagam pela aplicação; a limpeza faz `ALTER TABLE ... DISABLE TRIGGER <nome>` só das travas de DELETE declaradas no plano, dentro da transação (com a tabela já em ACCESS EXCLUSIVE: ninguém mais a vê desligada), e `ENABLE` antes do evento; um rollback desfaz as duas. `historico_evento` e `instalacao` estão em `TABELAS_INTOCAVEIS` (recusa até se alguém as puser no plano); gatilho de UPDATE nunca se suspende (tabela a desvincular com UPDATE travado é recusa). Exige que a conta do banco seja dona das tabelas — é (`postgres`, como em `travas.sql`). `ferramentas/apagar-banco.ts` não foi tocado.
- **Permissão `dados.limpar`**, só do perfil (`PERMISSOES_SO_DO_PERFIL`), entre as de governo (`PERMISSOES_DE_GOVERNO`), sem perfil nenhum na matriz: só o Administrador do sistema a tem, porque a dele é derivada de `PERMISSOES`. Chega ao banco de produção pelo `semear_rbac` do build (sem migração). A rota confere também o perfil vigente (`tem_administrador_sistema`): a permissão posta à mão noutro perfil não abre. O bloco "Limpar dados de teste" de /config é só dele (`config_por_perfil.test.ts` ganhou o bloco).
- **Confirmação forte e backup.** A simulação é o motor inteiro num savepoint desfeito (nem o evento fica). Executar pede a frase `APAGAR DADOS DE TESTE`, a identidade do banco (`identidadeDoBanco`) e a senha atual (`conferir_senha_atual`: errar conta tentativa, e o contador é gravado; a frase e a identidade são conferidas antes, para errar o que se copia não gastar tentativa). Os módulos são revalidados no POST. O backup é o de /config (`fazer_backup`, com `conferir_senha_do_backup`), feito **dentro da trava e da mesma transação** (o pacote leva exatamente o que sai) e antes de qualquer DELETE, com o evento `BACKUP_EXECUTADO`; falha nele desfaz tudo. Recusado sem armazenamento persistente (em produção, ou no Netlify, sem `SUPABASE_URL`). Com tudo vazio a execução não faz nada — nem backup nem evento (`NadaAApagar`).
- **Tempo (Netlify).** Medido nos testes, com dezenas de linhas por módulo: ~0,5–0,6 s por limpeza (um módulo ou os quatro), quase tudo leitura do catálogo, contagem das ~120 tabelas antes e depois e o backup. Cresce com o volume (DELETE e contagens, lineares) e, principalmente, com o backup, que põe todos os anexos no pacote — o mesmo teto do botão de /config. É UMA transação por limpeza, de propósito: se a função morrer no meio, a conexão cai e o Postgres desfaz tudo (o backup já gravado fica, inofensivo). Enquanto roda, as tabelas tocadas ficam travadas para os outros usuários. Se o acervo de anexos passar do que cabe no tempo da função, o caminho é a linha de comando, que não tem esse teto (hoje só para treinamentos).
- **Ficaram de fora, por dúvida** (não saem em módulo nenhum): `stg_planilha_parecer`, `stg_trello_cartao`, `stg_trello_acao` e `migracao_rejeitada` (a importação; o export usa a planilha), `portaria_localizacao`, `profissional_habilitado`, as sequências de numeração e — sem a caixa de contas — `servidor_lotacao`/`lotacao_posto`. Com a caixa de contas, `registro_acesso` (o log de pedidos, com `conta_id` sem chave e o IP; sai na rotina de privacidade) e `limite_login_ip` ficam. **Confirmar** com o dono se a numeração deve recomeçar depois dos testes: hoje não recomeça (e não recomeçar evita colidir com o arquivo do número já usado no armazenamento).

## As 3 falhas de `correcoes_certificados` eram do Node, não do certificado (25/10/2026)

Os testes D28–D31 falhavam só em alguns ambientes (a nuvem do Claude Code) e passavam na máquina do setor. Causa: o teste lia o texto do PDF com `TextDecoder("windows-1252")`, e o Node compilado com ICU reduzido trata esse rótulo como latin1 puro — o travessão (0x97 no WinAnsi da Helvetica) virava o controle invisível U+0097, e «Trabalho — CREA» chegava como «Trabalho  CREA». O PDF estava certo. `src/dominio/winansi.ts` (`decodificar_windows_1252`) faz a conversão sem depender do ICU, e passou a ser usado também na importação de servidores (CSV do Excel): lá, num Node assim, travessão, aspas curvas, reticências e euro chegariam como controle invisível. Teste próprio em `testes/winansi.test.ts`.

## Limpeza dos testes zera a numeração; anexo do certificado para a conta externa (25/10/2026)

- **Numeração volta a zero** (decisão do usuário). A tela «Limpar dados de teste» passa a apagar, de cada módulo marcado, a tabela da sua numeração (`limpeza.NUMERACAO`): treinamentos — `turma_sequencia`, `certificado_sequencia`, `certificado_sequencia_prefixo`; acidentes — `acidente_cat_sp_sequencia`; EPI — `epi_requisicao_sequencia`; processos — `parecer_sequencia`. Sem a linha do ano, o próximo número é o 1 (`numeracao.proximo_numero`). Os arquivos com o número antigo (DOCX do certificado, comprovante de EPI, DOCX do parecer) já saem na mesma limpeza, depois do commit, então o número reaproveitado não encontra arquivo velho; o certificado de teste que alguém tenha impresso deixa de validar (a chave tem sufixo sorteado). A ferramenta `npm run limpar-treinamentos` continua mantendo a numeração (`MANTER`): ela recomeça o cadastro, não apaga teste.
- **Anexo do certificado para terceirizado e discente.** `anexo_acesso.dono_certificado` reconhecia o dono só pelo `servidor_id`; agora, para a conta externa, pergunta a `emissao_certificado.do_titular_externo_por_id` (o participante ligado à conta) — a mesma regra da ficha e da segunda via — e exige `treinamento.ver`. O certificado de outra pessoa continua recusado. Observação: hoje nenhuma tela grava anexo em certificado (o PDF e o Word saem do congelado e a conta externa já os abre); a regra vale para quando houver.

## O titular baixa só PDF; o comprovante só com certificado (25/10/2026)

- **Sem Word para o titular** (decisão do usuário). O servidor, o terceirizado e o discente baixam o próprio certificado só em PDF; o .docx fica para a equipe (`certificado.ver`). `/certificados/:id/documento` aberto pelo titular redireciona para `/pdf` (o link antigo não quebra), e a ficha leve e o cartão de "Meus certificados" não oferecem mais o Word. No certificado de **modelo enviado**, o PDF fiel é o do conversor; sem ele, ou com ele fora do ar, a equipe continua indo ao Word, e o titular — inclusive pelo link do e-mail (`arquivo_do_titular`) — recebe o PDF da casa, que traz os dados do congelado e o QR de validação, mas não o layout nem os campos livres do modelo. **Conferir**: com o conversor ligado em produção (PRODUCAO.md §2.1), o titular recebe o PDF fiel.
- **"Comprovante de treinamentos" some do menu da conta externa sem certificado.** Novo marcador `Item.exige_certificado`; a marca `UsuarioAtual.com_certificado_externo` sai na mesma consulta da conta (um `exists` em `carregar_usuario_atual`, sem ida a mais ao banco). O servidor continua vendo o item sempre.
- **Minha atividade**: o subtítulo da conta externa não promete EPI nem processos.

## O "Quadro" de /processos só para a equipe (25/10/2026)

O teste das telas do usuário no navegador achou, na lista de processos do servidor, o alternador "Quadro | Tabela", cujo link (`/kanban`) dava 403: o quadro é da equipe (`exigir_na_equipe("processo.ver")`). O alternador agora só aparece com `pode_na_equipe("processo.ver")` (`com_quadro`); teste em `correcoes_processos.test.ts`.

## A janela de concluir turma prevê a apuração (25/10/2026)

No teste das telas da equipe, concluir uma turma sem presença lançada reprovou todo mundo, e a janela só avisava em geral ("quem não tiver presença lançada é apurado com o que há"). Agora ela mostra a prévia com os lançamentos de agora — quantos sairão aprovados e reprovados, a lista dos reprovados com o motivo (até 10; o nome segue a mesma regra nominal da ficha) e, em vermelho, quantos ainda não têm nenhuma presença, com o link para a aba Presença e notas. A conta é a da grade (`presenca.avaliar`), a mesma da apuração; só tela, sem mudança de regra. Teste em `turmas.test.ts`.

## A aba da ocorrência ainda sem parcial avisa que chega depois (25/10/2026)

No teste das telas de acidentes, as abas Saúde, Relatórios, Ações, SIASS e Histórico (fatias seguintes) abriam em branco, só com o cabeçalho, o que parecia defeito. A ficha (`acidente_ficha.html`) agora captura o `include ... ignore missing` e, se ele não desenha nada, mostra «Esta parte da ocorrência chega numa etapa seguinte do módulo» — o mesmo tom de Plano de ação e Indicadores. A regra das fatias continua: quem criar o parcial não edita a ficha, e o aviso some sozinho. Teste em `acidente_rotas.test.ts`.

## O cadastro funcional é do servidor ou da equipe; o sistema não lê o SIAPE (25/10/2026)

Decisão do usuário: nenhuma informação vem do SIAPE; tudo é cadastrado pelo próprio servidor ou pela equipe da Sisa. O número SIAPE continua sendo a chave do cadastro.

- **Meu perfil**: «Dados funcionais» deixou de ser só leitura. O servidor corrige cargo, função e lotação (o campus vem da unidade) em «Corrigir cargo, função ou lotação» (`POST /minha-conta/funcionais`, `servidores.corrigir_pelo_titular`). É a mesma linha do tempo da equipe (`_alterar_lotacao`): período a partir de hoje (no mesmo dia, corrige o período em vez de abrir outro), nada sobrescrito, `LOTACAO_ALTERADA` e `CAMPO_ALTERADO` na trilha, observação «Informado pelo próprio servidor em Meu perfil». Os postos de trabalho ficam enquanto a unidade não muda (são da equipe). SIAPE, nome, e-mail e situação continuam com a equipe. Saiu o texto «Fonte: SIAPE / Pró-Reitoria de Gestão de Pessoas».
- **Autocadastro no primeiro acesso** (`/ativar-acesso`): a tela pede também nome (obrigatório), cargo e lotação (opcionais). SIAPE fora do cadastro + e-mail `@ufvjm.edu.br` + senha → o pedido guarda os dados em `ativacao_acesso.dados_cadastro` (migração **0027**, jsonb) e o link vai ao e-mail DIGITADO; o cadastro de servidor e a conta só nascem quando o link é confirmado (`SERVIDOR_AUTOCADASTRADO`, sem nome/SIAPE/e-mail na descrição, e o período inicial de lotação). SIAPE já cadastrado segue como antes (o link vai ao e-mail do cadastro; o nome digitado não muda nada). A tela responde igual a todo pedido; nome e domínio do e-mail são conferidos para todo pedido que traz nome (não denunciam quem está no cadastro). E-mail que já é de outro servidor ou de uma conta → e-mail neutro, sem link. SIAPE ou e-mail que viraram de outro entre o pedido e a confirmação invalidam o link. Pedido sem nome (só chega assim de fora da tela) continua só ativando quem já está no cadastro. Os dados do pedido saem da linha ao usar o link e no expurgo de 7 dias.
- **Textos**: «o nome dele vem do SIAPE» (juntar cadastros), «atualizado pelo SIAPE» (importação), a opção Servidor do Cadastre-se e as notas do primeiro acesso.
- **Conferir**: a equipe acompanha os autocadastros pela trilha (evento «Servidor cadastrado pelo próprio servidor no primeiro acesso»); não há fila própria nem pendência.

## Inscrição sem aprovação: confirmada sozinha (25/10/2026)

Decisão do usuário: o sistema não depende de alguém para o que é simples.

- **A inscrição com vaga nasce CONFIRMADA.** O pedido do próprio servidor/terceirizado/discente (`inscrever_se`), a inscrição pela equipe e em lote (`inscrever`) e o pedido do link que a equipe aceita (`mudar_situacao_inscricao`, de `AGUARDANDO_EMAIL` direto para `CONFIRMADA`) saem confirmados, com `confirmada_em`/`confirmada_por`. A vaga continua conferida sob trava (`_conferir_vaga`). O pedido próprio não abre mais a tarefa «confirmar inscrição». A transição `INSCRITA → CONFIRMADA` e o botão «Confirmar» continuam para o que ainda estiver como inscrita. Migração **0028** (só dados): as inscrições `INSCRITA` em turma planejada, com inscrições abertas ou em andamento passam a `CONFIRMADA`, e as tarefas de confirmar delas fecham.
- **Pedido pelo link público confirmado pelo e-mail.** Volta a ideia da fatia 6, com as travas da nuvem: quem informa e-mail recebe um link (`/inscricao/confirmar/:token`, 48 h, uso único, guardado só o SHA-256 em `inscricao.confirmacao_token_hash`); abrir não confirma, o botão confirma. Confirmado, com vaga e a turma ainda recebendo pedido, a inscrição sai `CONFIRMADA` (com `email_confirmado_em`, o que a CHECK `ck_inscricao_email_confirmado` pede) e a tarefa da equipe fecha (`concluir_pela_rotina`); sem vaga ou com a turma fechada, o e-mail fica confirmado e o pedido continua com a equipe. Não recebem o link: o pedido sem e-mail e o que casou com um servidor PELO SIAPE com outro endereço (o e-mail digitado não prova ser o do servidor). Quando o pedido casou pelo e-mail, o aviso de cadastro existente não vai junto (seria o mesmo endereço). A tela continua respondendo igual a todos. **Desvio consciente** do cuidado antigo («e-mail a endereço digitado por anônimo é canhão de spam»): o limite por IP continua e há um teto de 3 confirmações por dia por endereço (`CONFIRMACOES_POR_DIA`).

## Teste do ciclo de treinamento com modelo enviado (25/10/2026)

Ciclo completo no navegador: treinamento novo, o modelo do Brigadista enviado e mapeado, turma, as sete formas de inscrição (equipe pela busca, externo cadastrado, lote, o próprio servidor, o terceirizado, o link com e-mail confirmado e o link sem e-mail aceito), presença por folha do dia, nota, falta, concluir, emitir. Achados corrigidos:

- **Editar a turma com o link público ligado e sem «inscrições até» dava erro 500** (`ck_turma_inscricao_publica`). `editar_turma` agora recusa com a frase: informe a data ou desligue o link.
- **A aba Emissão dizia «apto» e o lote travava sem dizer por quê.** `validar` passa a conferir os marcadores obrigatórios que vêm do cadastro (o CPF do participante e o do instrutor, que o Brigadista exige), montando o contexto de conferência (`montar_contexto_para_emitir` com número fictício); a frase diz o que falta e onde se corrige (`frase_dos_obrigatorios`). O resultado do lote diz o motivo de quem travou (sem nome: a mensagem vai na URL).
- **O código impresso não batia com o número da validação.** O modelo monta o código em pedaços («CSSO-BRIG-«AAAA»-«nº»») e a sugestão ligava «nº» à contagem interna do ano (`certificado_numero`, «3»). Novo campo `certificado_sequencia` (o «0001» do número impresso) e a sugestão o escolhe quando o «nº» vem logo depois de um hífen. **Conferir na produção**: o modelo já mapeado lá continua com `certificado_numero` — trocar para «Sequência do número (0001)» na tela do modelo. O código só bate com o número oficial quando o setor promotor da turma é o do prefixo escrito no .docx (CSSO).

## «Sou servidor da UFVJM» e os avisos que supunham o cadastro carregado (25/10/2026)

O sistema não tem a base de servidores carregada: o cadastro é feito pelo próprio servidor ou pela equipe da Sisa. Os avisos da conta sem servidor ligado («peça a quem tem `usuario.criar_conta`, informando o seu SIAPE», «peça à coordenação que ligue a sua conta») mandavam pedir a outra pessoa uma ligação que agora a própria conta faz.

- **Meu perfil → «Sou servidor da UFVJM»** (`POST /minha-conta/sou-servidor`, `servidores.ligar_pela_propria_conta`): a conta sem servidor que não é de terceirizado/discente informa SIAPE, nome, cargo e lotação. SIAPE novo → o cadastro nasce com o e-mail da conta (`SERVIDOR_AUTOCADASTRADO`, período inicial de lotação) e a conta é ligada (`SERVIDOR_VINCULADO`). SIAPE que já está no cadastro → só liga quando o e-mail de lá é o da conta (a prova de que é dela; o e-mail da conta já foi confirmado); com outro e-mail, ou já ligado a outra conta, recusa e manda procurar a equipe. Ligar dá à conta a concessão do titular (`carregar_usuario_atual`), como a ligação feita em Usuários.
- **Os avisos** de Meus treinamentos, Meus certificados, Minha ficha de EPI, painel e pedido de EPI, Minha atividade e as recusas de serviço (pedir vaga, pedir EPI) apontam para «Meu perfil → Sou servidor da UFVJM». Saiu o «Dados funcionais, só leitura. Para corrigir, fale com a coordenação.» da conta sem servidor. A frase «Fonte: SIAPE / Pró-Reitoria de Gestão de Pessoas» já tinha saído no PR #36 — se ainda aparece em produção, é publicação antiga.

## Teste do ciclo de EPI no navegador (25/10/2026)

Ciclo completo pela tela: item no catálogo (com CA e tamanhos), entrada de lote (NF, fornecedor, valor), pedido da servidora, aprovação, reserva do lote, entrega, comprovante (.docx) e o assinado anexado, ficha da equipe e a da servidora (celular), entrega direta no balcão, devolução (o saldo volta ao lote), indicadores e exportação CSV, e o balcão da tela de bolso. Varredura de /epis com coordenação, administrador, superintendente, a servidora e o terceirizado (403, como deve), no computador e no celular, sem erro. Achados corrigidos:

- **Tamanhos com vírgula.** O campo pede «um por linha», mas «P, M, G» virava UM tamanho chamado «P, M, G», e a entrada de lote não tinha o que escolher. `tamanhos_digitados` (rotas/epis.ts) separa também por ponto e vírgula e pela vírgula entre palavras — não pela do número («8,5» fica). Itens já gravados assim se corrigem salvando de novo na tela.
- **«2 unidade» no comprovante.** `unidade_no_plural` (comprovante_epi.ts): «2 unidades», «3 pares», «1 caixa».

## Teste do ciclo de Processos no navegador (25/10/2026)

Ciclo completo pela tela, num processo do adicional para a servidora: processo novo (DV errado, data futura, NUP colado com espaços, NUP repetido), anexos (portaria, formulário, o mesmo arquivo em outra categoria), a máquina de estados da triagem à quantificação (com a justificativa qualitativa no comentário), o laudo cadastrado em Laudos (formato SIAPE, data corrigida), o parecer (laudo, portaria de localização, posto, exposição, recomendação), a emissão, a habilitação ligada à conta, a assinatura, o link do SEI, Inserido no SEI → Devolvido à PROGEP → Concluído, o direito proposto e concedido em Adicionais, e o que a servidora vê (processo, parecer, «Seu adicional ocupacional», Minha atividade) no celular. Varredura de /processos, /kanban, /laudos, /adicionais, /relatorios, /importar, /demandas e /pendencias com coordenação, administrador, superintendente, a servidora e o terceirizado, no computador e no celular, antes e depois de haver dados, sem erro. Achados corrigidos:

- **Não havia como corrigir o processo depois de criado.** O processo autuado sem unidade ficava preso em «Laudo em elaboração»: «Laudo emitido» pede o laudo da unidade do processo. A ficha ganha **«Corrigir dados»** (`POST /processos/:id/dados`, `processo.corrigir_dados`, exige `processo.editar`): unidade, data de autuação, solicitação no SEST, observações (mesmas regras do processo novo: data nunca futura, RN-21) e o servidor, este só enquanto não há parecer (o parecer já o traz no corpo). NUP e tipo ficam de fora — o NUP é a identidade, o tipo escolhe a máquina. Cada campo alterado vai para a trilha. O servidor se troca pela busca do processo novo, sem carregar o cadastro inteiro na ficha (`idas_ao_banco` continua em 20).
- **NUP repetido sem saída.** A recusa «já existe processo com este NUP» traz o link para o processo que já o tem (`ProcessoRecusado.existente_id`).
- **O aviso de pendências da triagem desmentia a tela.** No Recebido ele dizia que «a máquina de estados recusa a saída», e «Em triagem» passava (a portaria e o formulário não travam entrar na triagem, pedir documento, sobrestar nem arquivar). O aviso agora diz quais saídas continuam abertas.
- **«Este mesmo arquivo também está em 2 processos»** sem outro processo com ele: a conta somava o comprovante de EPI e outros donos de fora, e contava o próprio processo. Conta só processos, e a frase diz os OUTROS.
- **A trilha do processo mostrava o `repr` do Python** (`url_permanente: None -> 'https://…'`, `laudo_id: None -> 1`, o texto inteiro da recomendação entre aspas). A descrição gravada não muda (entra na cadeia de hash); a ficha escreve «Link do SEI: https://…», «Laudo técnico: preenchido», «Data de autuação: 02/01/2025 → 03/01/2025» (`servicos/trilha_tela.ts`).
- **«Repus N campo(s) que você tinha digitado» no parecer já emitido.** O envio da camada «Emitir» guardava o rascunho local, a emissão não muda a versão, e o rascunho voltava por cima do parecer imutável. O editor só liga o rascunho local quando o parecer é editável, e o `csso.js` ignora campo dentro de `<fieldset disabled>`.
- **«Instale o LibreOffice»** no aviso do PDF do parecer: na nuvem não há o que instalar. O aviso diz só para abrir o .docx no Word e salvar como PDF.

## Servidor e discente sem Processos SEI nem Adicionais por padrão (25/10/2026)

Decisão do usuário: por padrão, o servidor e o discente não têm acesso ao módulo Processos SEI nem a Adicionais. O discente já não tinha (`PERMISSOES_DO_EXTERNO`). O servidor tinha `processo.ver` e `parecer.ver` pela concessão do titular (D16) e pelo perfil `servidor_consulta`, em escopo próprio: via «Meus processos», «Meu adicional», o próprio parecer, o processo na Minha atividade e no Início.

- **Saíram do padrão.** `PERMISSOES_DO_TITULAR` e a matriz de `servidor_consulta` não trazem mais `processo.ver` nem `parecer.ver`; a retirada está declarada em `PERMISSOES_RETIRADAS` e o semeio do deploy a tira do banco já gravado, com `PERMISSAO_RETIRADA_DO_PERFIL` na trilha.
- **A exceção da pessoa devolve os próprios.** Em Usuários, a conta do servidor sem perfil de equipe ganha «Processos SEI e Adicionais (os próprios)»: «Sem acesso (padrão)» ou «Consulta dos próprios». Gravada como `usuario_nivel_modulo` (processos-sei = CONSULTA), `rbac.permissoes_do_titular` soma `processo.ver` e `parecer.ver` à concessão do titular, sempre em escopo próprio (nunca o processo de outra pessoa). Operação é recusada sem perfil de equipe; a conta sem servidor ligado e a do terceirizado/discente também. Na conta de equipe, a exceção continua com o sentido de sempre (vale sobre o perfil, com o alcance dele).
- **O que some por padrão:** «Meu adicional» e «Meus processos» do Meu espaço e da tela de bolso, os cartões de adicional e processos do Início do servidor, os eventos de processo e o filtro «Processos» da Minha atividade, a busca e a ficha em /servidores (a do próprio continua em Meu perfil).
- **O Início de quem só tem o próprio** abre mesmo sem `processo.ver` e sem servidor ligado (antes vinha da permissão): a conta de servidor ainda sem vínculo vê o Início e o «Sou servidor da UFVJM», em vez do 403.

## Teste do ciclo de um treinamento de NR-12 (25/10/2026)

Ciclo completo pela tela, com o modelo padrão da casa: treinamento «Segurança no Trabalho em Máquinas e Equipamentos (NR-12)» (8 h, validade de 24 meses, conteúdo programático do item 12.16 e do Anexo II), instrutora padrão, turma de um dia na oficina com inscrições abertas, inscrição pela equipe (servidor pela busca e terceirizado cadastrado na hora) e o pedido da própria servidora no celular (confirmado sozinho), início, todos presentes, notas (o terceirizado com 6, abaixo da mínima 7), a prévia da apuração no «Concluir», a emissão em lote (2 emitidos, o reprovado travado com o motivo), o PDF pela equipe e pela servidora e a validação pública. Achados corrigidos:

- **«realizado 25 de outubro de 2026»** na turma de um dia só: o período de vários dias já vinha com o «de» («de 03 a 05 de março»). Desde a redação 3, o de um dia vem com «em».
- **«…(NR-12) NR-12 (Portaria MTP…)»**: a norma que não aparece inteira no nome era emendada só com um espaço; o exemplo do próprio campo é «Trabalho em Altura — NR-35». Desde a redação 3, vem com travessão.
- As duas mudam o texto dos campos, e por isso entram com **`REDACAO_ATUAL = 3`**: o certificado já emitido (redação 1 ou 2) reimprime igual (RN-15), e o .docx da casa e os modelos enviados emitidos daqui em diante ganham as frases certas.
- **O código gerado do nome cortava no meio da palavra** («SEGURANCA_NO_TRABALHO_EM_M»): corta na palavra. **A mensagem do cadastro** dizia só esse código; diz o nome digitado.
- Fica como está: o certificado identifica o participante pelo código público («PTC-…»), e não pelo SIAPE ou CPF — o CPF só sai quando o modelo o pede.

## Teste do módulo Demandas no navegador (25/10/2026)

Varredura de /demandas e /pendencias com coordenação, administrador, superintendente, a servidora e o terceirizado (403, como deve), no computador e no celular, sem erro. Ciclo pela tela: registrar (assunto vazio, chegada no futuro, prazo antes da chegada e menção a saúde recusados dentro da camada, com a confirmação RN-21 aparecendo e gravando), por e-mail com servidor e unidade, no balcão sem servidor, ofício já atrasado (o aviso de atraso e a tarefa no sino), marcar em andamento, encaminhar, trocar o responsável, e os desfechos: virou processo (sem NUP, DV errado com o «confirmei no SEI» na recusa, e o processo cadastrado no mesmo ato), encaminhada (sem setor e com data futura recusados), resolvida; o aviso do desfecho chega à servidora no sino e em Pendências. Achados corrigidos:

- **«Nenhuma demanda registrada. Registre a primeira…»** na fila padrão («Em aberto») com todas as demandas encerradas: diz «Nenhuma demanda em aberto.» e aponta para «Encerradas».
- **O processo que nasceu de uma demanda não levava de volta a ela** (a origem só aparecia na trilha). A ficha do processo mostra «Origem» com o link, lido na mesma consulta da ficha (`processos.por_id`, campo extra `demanda_de_origem_id`), para quem tem `demanda.ver`.

## Primeiro acesso do servidor: confirma o e-mail e já entra (26/10/2026)

Decisão do usuário: simplificar o primeiro acesso. O servidor preenche os dados e a senha, recebe um e-mail só para confirmar o cadastro e, ao clicar em «Confirmar e ativar o acesso», **já entra logado** — sem voltar à tela de entrada para digitar e-mail e senha outra vez.

- **A sessão abre no clique do botão**, não ao abrir o link: o cuidado de antes continua (leitor de e-mail que pré-visualiza links só vê a página, nunca ativa nem entra). `definir_senha` passa a devolver `{ resultado, sessao }`; a sessão vem pela mesma `autenticacao.abrir_sessao` da entrada com senha (extraída de `autenticar`), e `ultimo_login_em` acompanha. A rota grava o cookie com as mesmas flags do login e leva ao Início do servidor, com a faixa «Acesso ativado. Bem-vindo(a) ao Sistema SISA.» (`/?ativado=1`).
- **Só nesse caso.** O link que ainda pede a senha (Esqueci minha senha, convite do Cadastre-se) continua voltando ao login com «redefinida»/«ativada»: ali a senha é digitada na hora, e a troca de senha encerra as sessões abertas. O link usado de novo responde 404 e não abre sessão.
- **Os textos acompanham:** a página do link («você já entra no sistema, sem digitar nada de novo»), a tela «Verifique o seu e-mail», os dois e-mails de confirmação («você entra no sistema na hora») e o aviso de acesso ativado («nas próximas vezes, entre em…/login»).
- **Desvio consciente** do cuidado de que «o link de e-mail não é credencial de sessão»: aqui a credencial é o clique de quem recebeu o link de uso único (24 h) no e-mail institucional, com a senha que ele mesmo escolheu no pedido — o mesmo que a tela de entrada provaria logo em seguida.

## Teste das telas de relatórios no navegador (26/10/2026)

Relatórios de Processos (`/relatorios` e o CSV), Indicadores de EPI (`/epis/relatorios` e o CSV), Indicadores de treinamento e Indicadores de acidentes, com coordenação, administrador, superintendente, a servidora e o terceirizado (403, como deve), no computador e no celular. Os números das telas foram cruzados com o banco (processos por unidade, pareceres, turmas por situação, inscrições, certificados, entregas de EPI); filtros com ano sem dados, ano absurdo, exercício torto, intervalo invertido e setor inexistente; CSVs com BOM, `;`, acentos e a supressão da RN-19 já cobertas pelo código. Indicadores de acidentes continua como o aviso «chegam numa etapa seguinte». Achados corrigidos:

- **«Participantes 17» eram 10 pessoas.** O cartão conta inscrições que ocupam vaga: quem faz três turmas conta três vezes. O rótulo continua, e o cartão passa a dizer «17 inscrições · 10 pessoa(s) distinta(s)» (`pessoas_distintas`, uma contagem a mais no serviço, com a mesma supressão de RN-19 das outras pessoas).
- **Indicadores de EPI com período que não fecha** (início depois do fim, data torta, mais de 5 anos) levavam à página «422 — formulário incompleto → Ir para Painel». A tela agora abre no exercício corrente, com a frase no alto; a exportação continua recusando com 422.
- No celular, as tabelas largas dos relatórios (fila de laudos, empenhos de EPI) rolam para o lado com a primeira coluna fixa: é o desenho de propósito (P8, `celular_epis.test.ts`), e não ficou nenhuma página transbordando.

## Cadastre-se como única porta de entrada (26/10/2026)

Decisão do usuário: sai a opção «Primeiro acesso» e fica só o **Cadastre-se**. O servidor informa **SIAPE** (7 dígitos), **e-mail institucional** (@ufvjm.edu.br, será o login), **nome completo** e **senha**; os outros vínculos, **e-mail**, **nome completo** e **senha**. Trabalho dividido entre agentes: o núcleo no código, dois agentes nos testes (arquivos separados), um na revisão de segurança e um no teste de navegador.

- **Uma porta só.** O servidor escolhe «Servidor» em `/cadastre-se` (`?vinculo=SERVIDOR`); o formulário dele posta no mesmo `/cadastre-se` e usa o mesmo serviço de antes (`ativar_acesso.pedir`: confirmação pelo e-mail, conta criada e entrada direta ao clicar). `GET /ativar-acesso` virou redirecionamento para esse formulário; o `POST /ativar-acesso` segue como alias (formulário em cache); os links `/ativar-acesso/:token` dos e-mails seguem iguais. O botão da entrada é só «Cadastre-se». O `/primeiro-acesso` do primeiro superintendente (instalação local) não foi tocado: é outra coisa.
- **Terceirizado e discente**: o formulário perde Empresa/Curso e Matrícula (`organizacao` passa a ser opcional no serviço; as telas que a mostram já tratavam vazio). A caixa «Tenho 18 anos ou mais» ficou (é a barreira de LGPD para menores); o terceirizado usa «E-mail» (qualquer endereço) e o discente, o institucional de discente.
- **Cargo e lotação** deixam de ser pedidos no cadastro do servidor (ele os completa em Meu perfil).
- **Revisão de segurança**: nenhum oráculo novo (a 422 só diz formato), senha nunca volta à tela, cabeçalhos sem rastro e piso de tempo mantidos. Corrigido o que ela apontou: o nome do servidor passa pelas mesmas regras de terceirizado e discente (5+ caracteres, com espaço, sem números); a tela de confirmação avisa que, ao confirmar, a pessoa entra na hora («confirme só se foi você que acabou de preencher»); imports sem uso saíram.
- **Teste de navegador**: o erro do pedido aparecia duas vezes no computador (na casca e no formulário) e sai uma vez só; a mensagem do navegador para o SIAPE saía em inglês, e o campo passou a depender da mensagem do servidor («Digite o SIAPE com 7 dígitos.»). A trilha e a lotação inicial dizem «Cadastre-se», e não mais «primeiro acesso».
- **Risco herdado, registrado**: quem sabe o SIAPE e o e-mail institucional de outro servidor ainda cadastrado sem conta pode pedir com uma senha dele; a pessoa só ativa se clicar no link que chega ao e-mail dela, e o aviso de «acesso ativado» sai depois. A frase da confirmação ficou mais forte; exigir a senha de novo ou amarrar o link ao navegador fica como decisão futura.

## Teste das telas de configurações no navegador (26/10/2026)

`/config` (setor emissor, SLA, retirada de EPI, onde o dado mora, e-mail, backup, exportação, limpeza de dados de teste — só as telas e as recusas, sem apagar) com administrador, superintendência, coordenação, a servidora e o terceirizado (403), no computador e no celular; e a administração ao lado: os 13 catálogos (cadastro e edição com entradas boas e ruins), Usuários, Perfis, Acesso por módulo e Auditoria. Backup (arquivo cifrado gravado, trilha `BACKUP_EXECUTADO`) e exportação completa (zip) funcionam; a coordenação exporta tudo e não faz backup, como o desenho manda. Achados corrigidos:

- **SLA**: o limite de 3650 dias só existia no navegador (o servidor aceitava 99999999999), campo vazio ou torto era ignorado e a tela dizia «SLA atualizado». Agora o servidor recusa o que não for dia inteiro de 0 a 3650, dizendo qual coluna e que nada foi gravado; campo vazio mantém o prazo; sem mudança, «Nada mudou: os prazos já eram esses.».
- **500 em campo longo**: sigla de campus maior que a coluna (12) derrubava a tela com «erro interno», e os formulários dos catálogos não limitavam o tamanho. Os formulários de campus, unidade e cargo ganham `maxlength` das colunas, e o tratador de erros responde **422 com a frase** («Um dos campos passa do tamanho permitido…») para texto maior que a coluna (22001) ou número fora do limite (22003) em qualquer tela.
- **Cargo repetido por caixa/acento** («tecnico de laboratorio area» ao lado de «TECNICO DE LABORATORIO AREA»): a unicidade do banco é byte a byte. O cadastro e a edição comparam sem caixa nem acento.
- **Unidade com o nome oficial de outra** (uma segunda «COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL»): o nome oficial é a chave que acha a CSSO, e o cadastro aceitava a cópia. Agora recusa no cadastro e na edição, dizendo qual é a existente.
- **Fim de vigência antes do início** em autoridade destinatária e setor emissor era aceito: recusa no cadastro e na edição.
- **Texto de e-mail** em `/config` e na ficha do servidor ainda falava em «Ativar meu acesso» (o primeiro acesso saiu); fala de «Cadastre-se». O rótulo da trilha também.
- **Fica como está, para decisão**: autoridades e setores emissores com vigências que se sobrepõem são aceitos (a transição entre duas pessoas costuma ter dias em comum); o código do cargo no SIAPE aceita letras (o formato real não está confirmado).

## 26/10/2026 — Lentidão no Netlify: leitura sem transação

- **GET/HEAD sem BEGIN/COMMIT** (`src/app.ts`): a função roda nos EUA e o banco em São Paulo (~150 ms por ida). Cada tela abria e fechava uma transação — duas idas a mais (~300 ms) só para ler. Medido com proxy de 75 ms por sentido: `/login` 0,62 s → 0,32 s; as demais telas ficaram ~0,3 s mais rápidas. Quem escreve (POST etc.) segue na transação da requisição. Risco aceito: uma leitura que grava (registro de visualização) e falha depois não desfaz mais a gravação.
- **Fora do código**: a maior fatia continua sendo a distância função↔banco. No Netlify, mudar a região das funções para a mais próxima de São Paulo (se o plano permitir) ou usar o Supabase em região dos EUA corta cada ida de ~150 ms para poucos ms.

## 26/10/2026 — Telas de login (teste no navegador)

- **«Voltar» depois de sair reabria a tela protegida**: as páginas HTML não mandavam `Cache-Control`, e o navegador guardava a tela (ex.: Turmas) para a seta de voltar, mesmo com a sessão encerrada. Agora toda tela HTML sai com `no-store` (estáticos seguem com o cache deles). Custo: voltar numa tela refaz a consulta.
- **/login para quem já está dentro** mostrava o formulário (favorito do /login, aba antiga). Agora vai ao início, ou ao `proximo` do sistema (mesma regra de `destino_seguro`).
- **Sem defeito**: campos obrigatórios, senha/e-mail errados (mesma mensagem, o e-mail volta e a senha não), e-mail em maiúscula/com espaço, 5 mil caracteres, injeção, `proximo` externo/`//`/`\`/`javascript:` (volta ao início), avisos de `motivo` (valor desconhecido ou HTML não aparece), bloqueio por 5 tentativas (com a mensagem do horário certo, inclusive com a senha certa durante o bloqueio), links de Esqueci/Cadastre-se/certificados, `/primeiro-acesso` cai no login, celular sem rolagem lateral, Enter envia.

## 26/10/2026 — Cargo e lotação pedidos no uso, não no cadastro

- **Cadastre-se não pergunta cargo nem lotação** (já era assim desde o #44): quem só quer se inscrever em curso não precisa. **Pedir EPI** exige os dois; **comunicar acidente** exige quando o envolvido é a própria pessoa e o cadastro dela está sem; para outro envolvido servidor é opcional e só preenche o que está vazio (quem comunica pode não saber a lotação do colega). Meu perfil (Corrigir dados funcionais e «Sou servidor») aceita o mesmo.
- **Escolher ou digitar** (`partes/cargo_lotacao.html`, `servicos/dados_funcionais.ts`): a lista traz o catálogo; «Não está na lista?» abre o campo de texto (a lotação digitada pede o campus). A mesma grafia, sem contar caixa/acento/espaço, devolve a linha que já existe (cargo; lotação por nome extenso, oficial ou sigla) — nunca duplica. O que nasce de digitação entra `a_conferir` (migração 0029), com trilha `CARGO_CRIADO`/`UNIDADE_CRIADA`, e aparece com a etiqueta «a conferir» em /catalogos; abrir e salvar a linha tira a marca.
- **Nunca sobrescreve**: o que já está no cadastro do servidor só muda em Meu perfil (com a linha do tempo de lotação) ou pela equipe. Pedido de EPI, comunicação e perfil gravam num savepoint: recusa não deixa cargo/lotação digitados no catálogo.
- **Riscos aceitos/para decidir**: a lotação digitada nasce com tipo «OUTRO», sem UORG/sigla (a equipe completa ao conferir); o catálogo pode juntar variações de grafia que a comparação sem caixa/acento não pega («Téc. Lab.» × «Técnico de Laboratório») — por isso a conferência. O formulário público de acidente (sem conta) não mexe em cadastro.

## 26/10/2026 — Catálogos (teste no navegador)

Testados: as 13 telas (lista, cadastrar, editar), permissões (coordenação edita; servidor e terceirizado recebem 403; leitura sem botões) e celular (sem rolagem lateral). Achados, nos catálogos de parecer:

- **Agente nocivo** aceitava descrição em branco («   » virava linha vazia) e o mesmo nome em outra caixa/acento (só o idêntico esbarrava na unicidade do banco); texto acima de 200 caracteres era 500/422 sem explicação. Agora: em branco, igual a outro (sem caixa/acento/espaço) e longo demais voltam como recusa no popup de onde vieram, no cadastro e na edição.
- **Tipo de risco** e **percentual**: nome/rótulo igual ao de outro aceito (ficavam dois «Agente Físico»); acima de 60/40 caracteres dava erro. Idem **fundamentação** (norma 40, anexo 20, texto em branco) e **portaria** (número só dígitos, até 10; texto em branco).
- **Texto padrão** aceitava código «  » (só espaços), com acento e espaços (o parecer procura o código pela chave `TENDO_EM_VISTA`): agora letras sem acento, dígitos e «_», até 40; texto em branco ou acima de 20.000 caracteres recusado.
- **Checklist modelo**: cadastrar com **nome já existente** sobrescrevia, em silêncio, os itens do modelo antigo («Modelo atualizado»). Agora recusa («Já existe …»; para mudar, use o Editar). Também recusados: sem itens, item repetido (sem contar caixa), item acima de 300 caracteres e mais de 100 itens.
- Os campos dos formulários ganharam `maxlength` do tamanho da coluna. **Para decisão**: tipo de risco, fundamentação e percentual não têm «Cadastrar» (só editar) — parece intencional (são fixos pela norma), então não mudei.

## 26/10/2026 — «Esqueci minha senha» também para a conta de administração

- **Antes**: superintendente, administrador do sistema e quem concede perfil recebiam o e-mail neutro («não pode ser atendido por este caminho») e só a linha de comando redefinia. Decisão do dono do sistema: liberar pelo e-mail da própria conta.
- **Agora**, só no «Esqueci minha senha» (o Cadastre-se e o resto seguem recusando administração): link de **30 minutos** (`VALIDADE_ADMINISTRACAO_MS`; o prazo é a marca do link — um link de 1 h emitido quando a conta ainda era comum não serve se ela virou administração antes do uso), **aviso por e-mail** à conta depois da troca («se não foi você, avise a equipe»), as outras sessões são encerradas (já era), trilha com «CONTA DE ADMINISTRAÇÃO» e os tetos por IP/e-mail de sempre. Conta inativa continua sem link.
- **Risco aceito**: quem controla o e-mail institucional do administrador passa a controlar a conta. Mitigações acima + 2FA do próprio e-mail da UFVJM. A linha de comando continua como plano B (§3 de PRODUCAO.md).

## 26/10/2026 — Duplicados, etapa 2: «sou eu» / «não fui eu»

Segue o `docs/especificacoes/duplicados/aviso_visitante.md` (§3 e §4, etapa 2). Migração **0030_aviso_cadastro_resposta** (tabela `aviso_cadastro`, drizzle-kit). Tipo de evento novo, com rótulo em `auditoria.ts`: `AVISO_CADASTRO_RESPONDIDO`. **Nenhuma permissão nova.**

- **O e-mail do aviso leva um link** (`/aviso-cadastro/:token`, 7 dias, só o hash do token no banco). Abrir o link **não responde** (leitor de e-mail pré-visualiza links); a página mostra os dois botões e responde por POST. Link desconhecido e vencido são o mesmo 404; a rota passa pelo limite por IP (20 por 10 min, chave `aviso:<ip>`). Sem SMTP o aviso continua vencendo em 24 h na fila.
- **O e-mail passa a dizer o nome do treinamento** (decisão 3 da etapa 1: "na etapa 2, citar só o nome do treinamento"), e nada mais da turma — nem código, data ou local. Continua sem nome, SIAPE, IP nem dado digitado. A página dos botões diz o mesmo e só isso.
- **«Sim, fui eu» faz uma coisa só**: confirma o e-mail do cadastro **que recebeu o aviso** (`aviso_cadastro.email_id`), e só se nenhum outro cadastro tem o mesmo endereço (a caixa não diz de qual das pessoas ela é, e `uq_email_confirmado` não deixaria). **Não aceita a vaga** e **nunca acrescenta o e-mail digitado** ao cadastro: seria tomada de conta (quem digitasse o nome e o SIAPE de outro, com um e-mail seu, o levaria para o cadastro da vítima e depois leria os certificados por `/certificados/acesso`).
- **«Não fui eu» só grava o selo.** Não recusa o pedido nem mexe no cadastro.
- **A primeira resposta vale.** A gravação é condicionada a `resposta IS NULL` (dois cliques ao mesmo tempo não gravam duas); o outro botão depois devolve o que ficou, e o «sou eu» que não valeu não confirma e-mail nenhum.
- **Selo na conferência** (`/turmas/pedidos`, `PedidoNaFila.titular`): «o titular do cadastro disse “sou eu”» ou «“não fui eu”», com a sugestão de motivo para a recusa («o titular do cadastro disse que não pediu»). Havendo dois avisos do mesmo pedido, «não fui eu» pesa mais. É pista, nunca decisão: aceitar e recusar continuam atos da equipe.
- **Desvio da especificação**: a especificação pedia a recusa «já com o motivo pré-preenchido». O formulário da conferência tem **um** campo de motivo para o lote todo, e preencher esse campo por um único pedido apagaria o que a pessoa já tivesse digitado; por isso o motivo vai como **sugestão ao lado do selo**, e não dentro do campo. Também não reaproveitei `inscricao.confirmacao_*` (sugestão da especificação): são do link de confirmação do e-mail **digitado** (`/inscricao/confirmar`), e um pedido pode ter os dois links ao mesmo tempo.
- **`aviso_cadastro` entra na limpeza de dados de teste** (`limpeza.ts`, módulo Treinamentos), antes de `inscricao`.
- **Ficou para depois**: o botão de desfazer a junção, a carga de certificados antigos (IntegraSST/planilhas), e ligar o pedido sozinho pelo e-mail confirmado (F da especificação), que só vale a pena depois de ver o selo em uso.

## 26/10/2026 — Desfazer a junção de cadastros

Última pendência da prevenção de duplicados que não dependia de material novo. Migração **0031_desfazer_juncao** (três colunas em `participante_mesclagem`: `desfeita_em`, `desfeita_por`, `desfeita_motivo`, com `ck_mesclagem_desfeita`). Tipo de evento novo, com rótulo em `auditoria.ts`: `PARTICIPANTE_MESCLAGEM_DESFEITA`. **Nenhuma permissão nova**: quem junta (`participante.mesclar`) desfaz.

- **Onde**: `/treinamentos/participantes?feitas=1` («Junções feitas», ao lado de «Possíveis duplicados»): as 50 últimas, da mais nova à mais antiga, com o que cada uma moveu e o formulário de desfazer (motivo obrigatório). A rota é `POST /treinamentos/participantes/desfazer`.
- **O que volta** (`mesclagem.desfazer`, a partir de `participante_mesclagem.movido`): as inscrições, os certificados (com o `servidor_id` de antes), os e-mails que a junção moveu, a conta de terceirizado/discente e o CPF; o cadastro juntado é reativado. O que o cadastro que ficou ganhou **depois** da junção (inscrição, certificado, e-mail novos) não é tocado.
- **Só volta o que ainda está com o mantido.** O que a junção moveu e depois mudou de mãos fica onde está; a mensagem e a trilha dizem quantos itens foram.
- **Recusa** quando desfazer seria desfazer uma história que andou: o cadastro que ficou foi juntado a um terceiro depois (**desfaz-se primeiro a mais nova**: a tela mostra o motivo no lugar do botão), qualquer um dos dois foi expurgado, ou a junção já foi desfeita.
- **Limites do registro** (o `movido` guarda ids e nomes de campo, nunca o CPF nem o endereço — RN-19). Por isso: (a) o **CPF** volta a partir do que está no cadastro que ficou, que o herdou ou já tinha o mesmo; se alguém o alterou depois da junção, o valor que volta é o alterado; (b) o **e-mail repetido** que a junção apagou é recriado com o endereço do cadastro que ficou a que era igual (confirmado só se esse não o confirma agora, por `uq_email_confirmado`); (c) o **e-mail principal** do cadastro devolvido é o que a junção herdou, ou o primeiro que voltou; (d) a **organização** e a matrícula herdadas só saem do mantido se ainda são iguais às do absorvido.
- **«Gravar que não são a mesma pessoa»** vem marcado de saída (desfazer costuma ser a correção de quem juntou errado): grava o par (`participante_par_distinto`, origem `JUNCAO`), e o aviso de parecido não volta. Desmarcado, o par pode voltar a aparecer como parecido.
- **A linha da junção não se apaga**: fica com quem desfez, quando e por quê, e o `movido` segue dizendo o que foi movido. Juntar de novo cria uma linha nova.
- **Ficou para depois**: a carga de certificados antigos (IntegraSST/planilhas), que precisa de amostra dos arquivos.

## 26/10/2026 — Acidentes F3: a saúde do acidentado

Aba **Saúde** da ficha da ocorrência, sobre as tabelas `acidente_saude*` já existentes (**sem migração**). Serviço `acidente_saude.ts` (leitura única `ler`, escrita `registrar`, `declarar`, `painel`), rotas `GET|POST /acidentes/:id/saude` (`rotas/acidente_saude.ts`), parcial `acidente_aba_saude.html`.

- **A declaração do comunicante vira linha.** Na comunicação, quem declarou partes do corpo ou algum fato SIM/NÃO gera uma linha `DECLARADO_COMUNICANTE` por acidentado e a pendência `ACIDENTE_SAUDE_REGISTRAR` (texto só com o protocolo). O médico confirma pelo registro: a origem passa a `REGISTRADO_MEDICO` e, não restando declaração a confirmar na ocorrência, a pendência fecha.
- **Leitura.** Nível 1 exige `acidente.saude_ver`; nível 2 exige também `acidente.saude_detalhe_ver`. A finalidade (lista fechada) se escolhe antes: sem ela, nada é aberto e nada é registrado. Cada abertura grava `acesso_dado_sensivel` (com `acidentado_id` e a ocorrência); quem abre sem ser o responsável pelo caso deixa também `ACIDENTE_SAUDE_FORA_RESPONSAVEL`, sem valores. O **próprio acidentado servidor** lê tudo da sua ocorrência, sem finalidade e sem registro. Ocorrência restrita (menor de idade) só se abre a quem instrui o caso, ou ao titular.
- **Escrita.** Só `acidente.saude_registrar`, com controle de versão (409 se a tela estiver velha). A trilha lista **nomes de campos**, nunca valores. O nível 2 já preenchido **não se apaga** por aqui (a trigger só o deixa ir a NULL com o expurgo parcial): o serviço recusa antes, com a frase certa.
- **Natureza da lesão: catálogo vazio.** A tabela oficial (NBR 14280 / eSocial 17) ainda não foi fornecida; o campo aparece sem opções, com aviso na tela. Quando vier, entra por semente, sem mudar código.
- **Teste de ficha**: a aba usada como «sem parcial» passou de Saúde para Relatórios.
- **Ficou para depois**: expurgo parcial por tela (hoje só ato manual, POLITICA §2.4), F5, F6 (relatório) e a emenda da ROPA sobre dado de saúde antes de ligar Acidentes em produção.

## 27/10/2026 — Acidentes F5: o plano de ação

Aba **Plano de ação** da ficha e lista geral `/acidentes/acoes` (antes «em construção»), sobre a tabela `acidente_acao` já existente (**sem migração**). Serviço `acidente_acao.ts`, rotas `POST /acidentes/:id/acoes[/:aid/(editar|iniciar|concluir|cancelar)]` (`rotas/acidente_acoes.ts`), parcial `acidente_aba_acoes.html`, página `acidentes_acoes.html`. Permissão única: `acidente.investigar` (a leitura exige quem investiga ou encaminha ao SIASS, como a investigação).

- **Número estável por caso** (`numero` sequencial) e **uma pendência por ação** (`ACIDENTE_ACAO_PRAZO`, chave por ação, prazo da ação; responsável = conta escolhida ou quem conduz o caso). Mudar prazo ou responsável na edição move a pendência junto; concluir ou cancelar a fecha.
- **Máquina de estado** PENDENTE → EM_ANDAMENTO → CONCLUIDA; PENDENTE/EM_ANDAMENTO → CANCELADA. Concluir exige «o que foi feito» e aceita uma evidência (PDF ou imagem, categoria `EVIDENCIA_ACIDENTE`); cancelar exige o motivo. **Nunca se apaga** (trigger): a ação cancelada continua na lista, riscada.
- **O plano continua depois do relatório**: ação nova vale até o caso ser cancelado (a prevenção acompanha o que foi emitido). Prazo de ação nova não pode ser no passado.
- **Controle de versão** em editar, iniciar, concluir e cancelar (409 com tela velha); diff por campo na trilha (`ACIDENTE_ACAO_ALTERADA`). Texto passa pelo filtro de saúde (nexo ocupacional) e recusa CPF.
- **Responsável na tela**: «quem conduz o caso» (padrão), «eu», unidade e nome livre. A escolha de outra conta do sistema existe no serviço, mas a tela ainda não a oferece (falta uma lista de equipe).
- **Lista geral**: em aberto (padrão), vencidas e todas, no escopo e na regra de ocorrência restrita da conta; só mostra protocolo, nunca nome de acidentado. A secretaria (que só tria) recebe 403; o teste de telas foi ajustado.
- **Ficou para depois**: o e-mail de prazo pela rotina, o link «Plano de ação» no hub (F8), F6 (relatório) e F7 (SIASS).

## 27/10/2026 — Acidentes F6: o relatório técnico em PDF

Aba **Relatórios** da ficha, sobre a tabela `acidente_relatorio` já existente (**sem migração**). Serviço `acidente_relatorio.ts` (emitir, retificar, versões, baixar), desenho `acidente_relatorio_pdf.ts` (pdf-lib, Helvetica/WinAnsi, como o certificado), rotas `POST /acidentes/:id/relatorio[/retificar]` e `GET /acidentes/:id/relatorio/:versao/:VARIANTE.pdf` (`rotas/acidente_relatorio.ts`), parcial `acidente_aba_relatorios.html`. Permissão: `acidente.relatorio_emitir` (só do perfil) **e** `acidente.saude_ver` para emitir e retificar.

- **Duas variantes no mesmo ato**: COMPLETA (perícia do SIASS, com o resumo de saúde — nível 1) e SEM_SAUDE (contratada e fiscal). A sem saúde é montada **sem o campo `saude`**, não «limpa depois»; o teste confere o texto extraído do PDF e o contexto congelado.
- **Contexto congelado com hash** (SHA-256 do JSON de chaves ordenadas), guardado em `acidente_relatorio`; o PDF vai como anexo `RELATORIO_INVESTIGACAO` (restrito). Append-only: retificar gera a versão seguinte das duas variantes com motivo (mín. uma frase) e `substitui_id`; a anterior continua legível, marcada «retificada».
- **Emitir** exige a síntese explicativa e a caracterização na Investigação, o caso em EM_INVESTIGACAO e leva-o a RELATORIO_EMITIDO (fecha a pendência de investigar, grava a mudança de estado e o evento). Retificar mantém o estado e vale em RELATORIO_EMITIDO e ENCAMINHADA_SIASS. As evidências ficam marcadas como citadas.
- **A saúde da variante completa é uma leitura**: passa por `acidente_saude.ler` (finalidade «instrução da perícia», `acesso_dado_sensivel` por acidentado, evento se quem emite não conduz o caso). Só o resumo (nível 1) entra; o detalhe clínico (nível 2) fica com o médico.
- **Download** só pela porta dos anexos: escopo da ocorrência, `acidente.saude_ver` para a completa, leitura registrada (`ANEXO_BAIXADO`). A reimpressão devolve os mesmos bytes.
- **O que o relatório diz das entrevistas**: que houve, com que vínculo e quando; o relato de cada uma fica arquivado no caso (não vai no PDF).
- **Limite assumido**: a investigação continua travada depois do relatório, então a retificação congela de novo o que está vigente (CAT/SP retificada, plano de ação, saúde), sem reabrir o texto do MAPA.
- **Caracteres fora do WinAnsi** saem como «?» em vez de derrubar a emissão. A assinatura oficial segue no SEI.
- **Teste de ficha**: a aba usada como «sem parcial» passou de Relatórios para SIASS.
- **Ficou para depois**: F7 (SIASS e conclusão), F8 (hub e indicadores), e um .docx editável opcional (D3).

## 27/10/2026 — Acidentes F7: SIASS e conclusão

Aba **SIASS** da ficha, sobre as tabelas `acidente_encaminhamento` e `acidente_decisao_pericial` já existentes (**sem migração**). Serviço `acidente_siass.ts`, rotas `POST /acidentes/:id/siass[/decisao|/concluir]` (`rotas/acidente_siass.ts`), parcial `acidente_aba_siass.html`. Permissão: `acidente.siass`; a leitura segue a regra das abas da investigação.

- **Encaminhar** (RELATORIO_EMITIDO → ENCAMINHADA_SIASS): meio, NUP do SEI (normalizado e validado; obrigatório pelo SEI), data (não futura) e a **versão vigente do relatório completo**, que é a que a perícia recebe. Fecha o prazo legal de comunicação e abre `ACIDENTE_AGUARDA_PERICIA` (60 dias). Já encaminhado, um novo encaminhamento só acrescenta a linha (append-only; o estado não muda).
- **Decisão pericial**: append-only; a correção é linha nova com `substitui_id`, e a tela marca a vigente. Número da CAT no SIASS em campo próprio (letras, números, ponto, barra, hífen). **A observação recusa «doença»** e qualquer termo de saúde (contexto padrão da RN-21, sem a dispensa do nexo ocupacional) e CPF. Fecha a espera da perícia.
- **Concluir**: de ENCAMINHADA_SIASS exige a decisão registrada **ou** o motivo; de RELATORIO_EMITIDO só para o caso que a investigação marcou como «não requer CAT no SIASS», com motivo. Grava `concluida_em` e `conclusao_motivo`, fecha as pendências do caso e registra a mudança de estado (versão otimista da ocorrência). O plano de ação continua depois da conclusão.
- A trilha diz o meio, a versão do relatório e o rótulo do resultado; nunca a observação, o NUP nem número de CAT.
- **Ficou para depois**: F8 (hub e indicadores), e-mail de aviso ao acidentado servidor no relatório emitido/concluído (D6, desligado até configurar).

## 27/10/2026 — Acidentes F8: hub e indicadores

Fecha o módulo. **Sem migração.** Serviços `acidente_contagens.ts` e `acidente_indicadores.ts`, rotas `GET /acidentes/indicadores` e `GET /acidentes/indicadores/exportar` (`rotas/acidente_indicadores.ts`, no lugar do «em construção»), página `acidentes_indicadores.html` e dois atalhos novos no hub. As entradas de menu «Plano de ação» e «Indicadores» já existiam.

- **Hub**: «Plano de ação» (com as ações vencidas, linkando a lista já filtrada; só para quem investiga ou encaminha ao SIASS) e «Indicadores» (`indicador.ver`). A versão pessoal (escopo próprio) continua só com comunicar e as próprias.
- **Indicadores**: ocorrências pela data do acidente, no alcance de quem pede (escopo e restrita), sem as canceladas, por **ano, espécie, campus e unidade do local**, com seletor de ano ou período livre (o mesmo de `/epis/relatorios`).
- **RN-19**: toda célula com menos de 5 casos sai «—», com a supressão secundária do sistema (`suprimir`: nunca sobra uma célula escondida sozinha). O total também. A tela explica que, com poucos casos por ano, o recorte por unidade fica quase todo suprimido.
- **Afastamentos e dias perdidos** (D12): só para quem tem `acidente.saude_detalhe_ver`, e suprimidos quando os casos com afastamento são menos de 5 (a soma de dias identificaria quem se afastou). **Taxas de frequência e de gravidade ficam de fora**: pedem horas-homem trabalhadas por unidade, que o SISA não tem (parâmetro anual por campus, depois).
- **CSV**: exige `indicador.ver` e `exportar`; UTF-8 com BOM, ponto e vírgula, `linha_csv` neutraliza fórmula. A permissão vem **antes** do período (403, e não o 422 da data torta).
- **Fechamento do módulo**: o que o módulo ainda pede é a tabela oficial de natureza da lesão, a emenda da ROPA sobre dado de saúde, a decisão sobre ligar `CSSO_MODULO_ACIDENTES` em produção e os e-mails (D6, desligados até configurar).

## 27/10/2026 — Acidentes F9: migração dos casos do CAT/SP antigo

Última fatia do módulo. **Sem migração de esquema.** Serviço `servicos/acidente_importacao.ts` (a lógica, testável), ferramenta `ferramentas/importar-catsp.ts` (`npm run importar-catsp`) e `testes/acidente_importacao.test.ts` (17, com planilha fictícia). D5 (b): só os campos permitidos, com o protocolo original.

- **Entrada**: as abas `COMUNICACOES`, `ANALISES_MAPA` e `PLANO_ACAO` exportadas como CSV numa pasta **fora do repositório** (a ferramenta recusa pasta dentro dele). A conta que conduz entra em `--por <login>`. `--simular` faz tudo e desfaz. Sem ele, pede a identidade do banco.
- **Nunca chegam ao banco**: CPF, RG, data de nascimento (lida só para saber se o acidentado era **menor de idade** na data — e então a ocorrência fica restrita à SST), sexo, endereço, telefones e e-mail do acidentado, endereço e telefone das testemunhas, URLs e IDs do Drive, e as anotações livres da SST. CPF no meio de um texto vira «[CPF removido]». O teste varre as tabelas do módulo e a trilha atrás de cada valor proibido.
- **Protocolo e sequência**: o protocolo `CAT-AAAA-NNNN` é o original (ano e número saem dele); a sequência do ano sobe para o maior número migrado, e a numeração nova continua dali.
- **Cada caso**: origem `MIGRACAO`, tipo INICIAL, a CAT/SP versão 1 (origem `MIGRACAO`, contexto congelado e hash), o estado da planilha («Em análise SST» virou EM_INVESTIGACAO; concluída e cancelada entram com motivo «antes da migração») e um evento `ACIDENTE_IMPORTADO` na trilha, sem nome nem texto. **Não abre pendência**: o caso é histórico.
- **Envolvidos**: casados com `servidor` pelo SIAPE. SIAPE que não existe no cadastro entra pelo nome (como no formulário por link), com o SIAPE guardado, e o relatório avisa. Testemunha: só o nome.
- **Catálogos**: casados pelo texto original (`rotulo_legado`); a lista de partes do corpo vem numa célula só e os rótulos têm vírgula, então a ferramenta procura os rótulos conhecidos (do mais longo ao mais curto) em vez de dividir. O que não casa fica vazio, com aviso.
- **Saúde**: o que a planilha declarava (afastamento, internação, óbito, atendimento e as partes do corpo) entra como DECLARADA, nível 1, na ficha do acidentado principal, **sem** a pendência de confirmação (o caso é histórico). O nível 2 (dias, datas, unidade de atendimento) não vem: o médico registra se for o caso.
- **Análise (MAPA)**: vira `acidente_investigacao`. As barreiras do legado eram texto sem situação (existia/falhou/ausente), e inventar a situação seria mentir: ficam **rotuladas dentro das evidências**. A linha do tempo vira uma linha só, «Planilha antiga». Não vêm o nexo causal do perito (nexo é da perícia oficial), transcrições, gravações, o checklist e a retificação do relatório; o relatório avisa quando havia conteúdo ali.
- **Plano de ação**: ações numeradas por caso, com tipo, prioridade, prazo e estado; o responsável era texto livre e segue como texto (`responsavel_texto`).
- **Idempotente e por linha**: protocolo que já existe é pulado; cada linha roda num ponto de salvamento, e a linha com defeito é recusada e relatada sem derrubar as outras. O terminal mostra só protocolos e códigos.
- **Fora**: os PDFs de relatório e os anexos do Drive. A CAT/SP antiga é prova: baixa-se o PDF à mão e se anexa ao caso (categoria `CAT_SP`). A reabertura do legado (`TipoCAT = Reabertura`, que ele nunca ligava ao caso anterior) entra como INICIAL, com aviso.
- **Depois de rodar**: apagar a pasta com os CSV (dados pessoais), registrar em ata (risco 11) e **revogar o link público e trocar a senha do legado**.

## 27/10/2026 — Acidentes: tabelas do Anexo III.2 conferidas com o Manual de Perícia Oficial

O usuário trouxe o Manual de Perícia Oficial em Saúde do Servidor Público Federal (3ª ed., 2017) — guardado em `entrada/` (ignorada pelo git). O **Anexo III.2** traz as Tabelas I a IV da CAT/SP. Conferência linha a linha com os catálogos semeados (a partir do legado):

- **Tabela I (partes do corpo)**: igual, 44 itens. Os dois erros de digitação do PDF («PUNHO A O OMBRO», «PARTE MÚLTIPLAS») ficam corrigidos como já estavam.
- **Tabela II (agente causador do acidente)**: igual nos 198 itens que o manual traz; o PDF tem texto quebrado por OCR («ÍÉ», «IÍQUIDO»), e o catálogo do sistema está certo. Os itens 107 e 108 vêm **cortados no próprio manual** (terminam em «RETIFICADOR,» e «ÍÉ»): o texto completo continua sendo o que foi reconstruído e **segue para conferir com a NBR 14280**. **O catálogo tem 1 item que o manual não traz: «ARQUIBANCADA, ESTÁDIO - EDIFÍCIO OU ESTRUTURA»**; ficou como está (pode ser da NBR 14280) e a equipe confirma.
- **Tabela III (agente da doença)**: faltava o primeiro item oficial, «REAÇÃO DO CORPO A SEUS MOVIMENTOS - MOVIMENTO INVOLUNTÁRIO (ESCORREGÃO SEM QUEDA, ETC)». **Incluído** (agora 31).
- **Tabela IV (situação geradora)**: faltava «IMPACTO DE PESSOA CONTRA OBJETO PARADO». **Incluído** (agora 31).
- Os dois itens novos têm `ordem` 0 (aparecem primeiro, como na tabela oficial), `rotulo_legado` nulo (a planilha antiga não os tinha) e entram pela semeadura idempotente, sem renumerar nada nem migração de esquema.

## 27/10/2026 — Acidentes: identificação pessoal do Anexo III (bloco restrito), fatias 1 e 2

O Anexo III do Manual de Perícia (a CAT/SP oficial) pede a identificação do servidor (sexo, CPF, nascimento, RG, endereço, telefone, e-mail) e o endereço das testemunhas. **Decisão do dono do sistema**: coletar tudo, num bloco restrito, com a ROPA ganhando emenda. Isto **reverte** a minimização da F1 (ROPA §4.3/§4.5), que cobrava que não se coletasse nada disso. **Migração 0032.**

- **Onde mora.** `acidente_identificacao` (1:1 com `acidentado`) e `acidente_testemunha_contato` (1:1 com a testemunha). Tabelas próprias: nada disto está em `acidentado`, na ocorrência, na CAT/SP congelada, no relatório (nenhuma das duas variantes) nem na trilha. CPF só com 11 dígitos (CHECK) e verificador conferido pelo serviço. Sem trigger de DELETE: dado pessoal tem de poder ser apagado (expurgo/pedido do titular, ainda por fazer).
- **Por onde entra.** Só pela comunicação **com conta** (`comunicar`; o formulário por link não pede). Tudo opcional: o Anexo III não marca estes campos como obrigatórios. CPF só pelo campo `env_<n>_cpf`, o segundo (depois do `cpf_certificado`) a escapar da máscara que a porta aplica a todo texto (`dependencias.INTOCAVEIS`); a rota nunca o devolve ao formulário numa recusa, nem mascarado. CPF no meio de endereço, complemento etc. é recusado. Identificação inválida recusa a comunicação inteira (a transação desfaz).
- **Menor de idade.** A data de nascimento, comparada com a data do acidente, marca o envolvido como menor e a ocorrência como restrita à SST (D14a), mesmo que ninguém tenha marcado «menor de idade». A data em si só vai para o bloco restrito.
- **Quem lê.** Permissão nova **`acidente.identificacao_ver`** (coordenação, superintendência, engenharia, técnico de segurança e médico do trabalho — os cargos que já veem saúde ou instruem o caso). Finalidade escolhida ANTES (lista fechada `FINALIDADES_IDENTIFICACAO`), uma linha em `acesso_dado_sensivel` a cada abertura (`campo = acidente_identificacao`), e evento na trilha (sem dado) quando quem abre não conduz o caso. O próprio acidentado lê a sua sem finalidade e sem registro. Ocorrência restrita segue só para quem instrui. Serviço único: `servicos/acidente_identificacao.ts` (`ler`).
- **O que sai.** Na tela (nova aba **Identificação** da ficha) o CPF aparece só mascarado, como no certificado; os demais campos, para quem tem a permissão. O CPF inteiro só sairá no PDF da CAT/SP no formato do Anexo III, para o SIASS (fatia 4, ainda não feita). A exportação em claro leva só as chaves das duas tabelas (o backup cifrado leva tudo). A limpeza de dados de teste as inclui.
- **Trilha.** `ACIDENTE_IDENTIFICACAO_REGISTRADA` diz **quais grupos de campo** foram informados («sexo, CPF, endereço…»), nunca o valor.
- **Ainda não feito (fatias 3 a 5).** Os campos de saúde do Anexo III (duração provável do tratamento, deve afastar-se, descrição da lesão, diagnóstico provável, CID, observações) e o nexo causal; o PDF no formato do Anexo III; **a emenda da ROPA** (§4.3/§4.5/§9, com base legal e prazo de expurgo da identificação) e o expurgo. **A emenda da ROPA tem de sair antes de ligar `CSSO_MODULO_ACIDENTES` em produção:** hoje o módulo continua travado lá, e esta coleta só passa a valer quando ele for liberado.
- **Campos com asterisco no Anexo III** (hora, tempo de jornada, parte do corpo, situação geradora, afastamento, óbito, UF e município): o formulário os aceita em branco, como antes. Torná-los obrigatórios muda a comunicação e fica para uma decisão à parte.

## Acidentes: campos de saúde do Anexo III e nexo causal (fatia 3)

Decisão de 27/10/2026. Migração 0033: `acidente_saude` ganha, no **nível 2**
(só o médico lê, o expurgo parcial leva a NULL, trigger conferida), a duração
provável do tratamento, «deve afastar-se», a descrição da lesão, o diagnóstico
provável, o CID (CID-10, normalizado para `S61.0`) e as observações. A trilha
guarda só os nomes dos campos.

- O **nexo causal** não tem coluna: deriva da decisão pericial
  (`acidente_decisao_pericial`: reconhecido = Sim, não reconhecido = Não,
  encaminhado ao SIASS = Encaminhar) e será mapeado no PDF do Anexo III (fatia 4).
- O comunicante **não** declara estes campos clínicos: o Anexo III os atribui ao
  serviço de saúde e o nível 2 é restrito ao médico. Quem comunica continua
  informando só os fatos do nível 1.

## Acidentes: emenda da ROPA e PDF no formato do Anexo III (fatia 4)

Decisão de 27/10/2026.

- **ROPA v1.7 (`docs/ROPA.md` §0.6) e POLITICA_RETENCAO §2.4.** A emenda registra
  a identificação pessoal restrita, os campos clínicos do nível 2 (revogando, só
  no módulo de Acidentes, a frase «nunca CID, nunca diagnóstico, nunca texto
  clínico»), a base legal, a retenção e as pendências novas (§9 itens 10 e 11).
  Cumpre o bloqueador da emenda, mas o módulo continua travado em produção até a
  revogação do legado e a tabela de natureza da lesão.
- **Expurgo da identificação**: proposta de 5 anos após a conclusão, ato manual do
  setor com simulação e ata, **sem ferramenta ainda** (a do detalhe de saúde também
  não existe). O prazo depende do arquivo institucional (ROPA §9, item 10).
- **PDF do Anexo III** (`servicos/acidente_anexo_iii.ts`, rota
  `GET /acidentes/:id/anexo-iii/:acidentado.pdf`): um acidentado por vez, **montado a
  cada pedido e nunca guardado**, porque é o único lugar em que o CPF sai por
  inteiro (`identificacao.ler_para_siass`). Exige `acidente.identificacao_ver` e
  `acidente.saude_detalhe_ver` (na prática, o médico do trabalho), grava os dois
  acessos com a finalidade «instruir a perícia» e o evento
  `ACIDENTE_ANEXO_III_EMITIDO`, sem dado. O titular não o emite por aqui.
- O leiaute segue os campos do Anexo III em blocos, sem reproduzir a grade do
  formulário. «Data/carimbo» e «Assinatura» ficam para o papel do SIASS. O nexo
  causal vem da decisão pericial vigente.

## Acidentes: auxílio à análise (fatia 5)

Decisão de 27/10/2026. Aba **Análise** na ficha (`servicos/acidente_analise.ts`):
conferência por **regras fixas** (D2: sem IA, sem API externa, ROPA §5.1) que
aponta, em quatro níveis, o que **não fecha**, o que **falta do Anexo III**
(itens com asterisco), o que pede **atenção** (prazo do art. 214, menor sem
responsável, ações vencidas) e o **próximo passo** pelo estado do caso.

- **Só aponta.** Não grava nada nem muda estado; quem decide é a equipe.
- **Não abre dado restrito.** Para saber se há identificação e saúde usa
  `presenca()` de cada serviço (sim/não, confirmada pelo médico, com parte do
  corpo), sem conteúdo e sem gravar `acesso_dado_sensivel`.
- **Quem vê:** quem investiga ou encaminha ao SIASS (mesma regra das abas da
  investigação); aos demais a aba diz que é da equipe.
- **Fora desta fatia:** sugerir ação ou barreira a partir do agente causador
  (exigiria uma tabela de correspondência que a equipe de segurança ainda não
  definiu; inventá-la seria pior que não ter) e qualquer leitura de texto livre.
