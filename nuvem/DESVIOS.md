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

- **Política de senha**: mínimo de **10** caracteres e 5 diferentes, **sem**
  regra de composição (NIST SP 800-63B), e lista de senhas vazadas e de
  contexto (UFVJM, campi, CSSO). **Desvio do Python** (6, letras e números).
  A senha que entra certa mas não passa na política de hoje vira troca
  obrigatória no próprio login — é o único momento em que o sistema a conhece.
  A provisória passou a `xxxx-xxxx-99` (≈ 43 bits, contra 26).
- **Redefinição de senha**: a própria, nunca (troca-se sabendo a atual);
  conta de administração (`PERMISSOES_DE_GOVERNO`: conceder perfil, atestar
  habilitação, criar conta, redefinir senha, backup) só por quem tem
  `perfil.conceder`; as demais, pelo `admin_ti` como antes. A regra "só quem
  alcança tudo o que o alvo alcança" foi descartada: só o `admin_ti` tem
  `usuario.resetar_senha`, e ele não alcança nada de técnico — ninguém mais
  teria a senha redefinida. Recusa grava `SENHA_RESET_RECUSADO`.
- **Sessão por inatividade**: `CSSO_SESSAO_INATIVIDADE_MINUTOS`, 120 por
  padrão (0 desliga), além das 12 h absolutas. Coluna nova
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

- **O sistema não guarda CPF**: não há coluna em tabela nenhuma (conferido no
  esquema) e o ambiente de teste inteiro povoado não tem CPF em coluna de texto
  ou jsonb (`testes/privacidade_varredura.test.ts`).
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
