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
