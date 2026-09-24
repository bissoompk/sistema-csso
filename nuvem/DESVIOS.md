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
