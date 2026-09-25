# ROPA — emenda da instalação na nuvem (Netlify + Supabase)

**Complementa** `docs/ROPA.md` (v1.6, 04/09/2026) e `docs/POLITICA_RETENCAO.md`
do sistema Python. Finalidades, bases legais por categoria de dado, categorias
de titulares e de dados continuam as de lá: o porte (`nuvem/`) traduz o sistema
e não cria finalidade nem categoria nova. O que muda — e é o que esta emenda
registra — é **onde o dado está, quem o processa em nome da UFVJM e por qual
caminho ele passa**.

**Versão:** 1.0, de 25/09/2026 (revisão de privacidade para produção).
**Controlador:** UFVJM. **Unidade:** CSSO/Sisa. **Encarregado (DPO):** pendente
(ROPA §9, item 3) — continua pendente.

---

## 1. A decisão de 24/09/2026

Em 24/09/2026 o responsável pelo sistema decidiu **carregar dados reais de
servidores** na instalação da nuvem. Até então a instalação era de
homologação, só com dados inventados (`PORTE.md`, ambiente de teste).

Essa decisão **contraria duas condições que o próprio registro do sistema
escreveu**, e por isso fica dita aqui, e não subentendida:

- ROPA §5 e §5.1: "Não há transferência internacional. Não há operador
  terceirizado. Não há uso de nuvem." — e "ligar qualquer serviço externo exige
  emenda **prévia** deste registro".
- POLITICA_RETENCAO §3: "Qualquer destino em nuvem exige **autorização formal da
  UFVJM e contrato de operador** (LGPD arts. 33 a 36, 39 e 46)."

**Ressalvas vigentes na data desta emenda:**

1. A **autorização formal da UFVJM** para tratar os dados na nuvem **não
   existe ainda**.
2. O **encarregado (DPO)** da UFVJM **não foi indicado/consultado**.
3. Os contratos com Netlify e Supabase são de **conta pessoal**, e não da UFVJM:
   não há hoje instrumento entre o controlador e esses operadores (§3).

O que foi feito para reduzir o risco enquanto isso está na §5. O que falta
providenciar está na §7.

## 2. Onde o dado está e por onde passa

| Componente | Provedor | Onde | O que guarda ou processa |
|---|---|---|---|
| Banco de dados (Postgres) | Supabase | **São Paulo** (região da AWS no Brasil) | Todo o dado estruturado: cadastro de servidores, processos, pareceres, exposição, fichas de EPI, turmas, certificados, demandas, trilha de auditoria, `acesso_dado_sensivel`, sessões, registro de acesso |
| Arquivos (Storage) | Supabase | **São Paulo** | Bucket **privado**: `anexos/` (inclusive comprovante de EPI assinado), `documentos/` (.docx gerados), `backups/` (cifrados), `exportacoes/` (zip em claro, apagado em 24 h), `entrada/` (cópia da planilha/JSON importados) |
| Aplicação (função) | Netlify Functions | **EUA** hoje (região padrão do Netlify); **São Paulo** planejado | Processa cada requisição **em memória**: recebe o formulário, consulta o banco, monta a página. Não grava dado em disco (a função não tem disco persistente) |
| Arquivos estáticos (CSS, JS, ícones) | Netlify CDN | Global | Nenhum dado pessoal |
| Logs da função | Netlify | EUA | Só o que o código escreve em `console` — ver §5.4 |

### 2.1 Transferência internacional

**Enquanto a função rodar nos EUA, há transferência internacional** (LGPD
art. 33): o dado pessoal repousa no Brasil, mas **transita e é processado** nos
EUA a cada tela aberta — nome, SIAPE, lotação, exposição, texto de formulário.
Não é só "trânsito de rede": a função lê o dado em claro para montar a página.

- Não há decisão de adequação da ANPD para os EUA.
- A hipótese que caberia é a de **cláusulas contratuais** (art. 33, II, "b"),
  hoje regulada pela ANPD (Regulamento de Transferência Internacional de
  Dados e cláusulas-padrão — **a conferir com o encarregado** qual instrumento se
  exige de órgão público).
- **Mover a função para São Paulo** encerra a transferência pelo caminho da
  requisição. Não encerra a questão do operador estrangeiro: Supabase e Netlify
  são empresas dos EUA, e o acesso administrativo delas aos sistemas não
  depende de onde o disco está. Isso também é tema do instrumento com o
  operador (§3).
- Os **logs da função** ficam no Netlify (EUA) pelo prazo do plano. Por isso a
  regra do §5.4: nada pessoal vai para o log.

## 3. Operadores (LGPD art. 5º, VII, e art. 39)

| Operador | Serviço | Papel | Instrumento hoje |
|---|---|---|---|
| Supabase Inc. (EUA) | Postgres gerenciado e Storage | Armazena e processa, por ordem do controlador | Termos de uso da conta pessoal. O Supabase publica DPA; **não firmado em nome da UFVJM** |
| Netlify Inc. (EUA) | Funções e CDN | Processa em trânsito; guarda logs | Termos de uso da conta pessoal. O Netlify publica DPA; **não firmado em nome da UFVJM** |

Não há suboperador acrescentado pelo código: o sistema não chama API de
terceiro, não envia e-mail e não usa IA (ROPA §5.1 continua valendo para tudo o
que **não** é a hospedagem).

## 4. Bases legais

**Não mudam** (ROPA §2): art. 7º, II, e art. 11, II, "a" (e "b" para dado de
exposição, pendência §9 item 2 de lá). O registro de acesso (§5.3) segue a base
do Python: art. 7º, II, e art. 37. A mudança de hospedagem **não cria base
nova**, mas acrescenta as exigências dos arts. 33 a 36 (transferência) e 39
(operador), que dependem do controlador — não de código.

## 5. Medidas técnicas na instalação da nuvem

### 5.1 Acesso ao banco e aos arquivos

- **RLS ligado em todas as tabelas, sem política**, e privilégios dos papéis
  `anon`/`authenticated` revogados (`src/db/travas.sql`): a API REST pública do
  Supabase não enxerga linha nenhuma. O sistema fala com o banco como dono das
  tabelas, por conexão cifrada.
- **Bucket privado**. O código cria o bucket como privado e, desde esta revisão,
  **recusa usar um bucket que exista como público** (`armazenamento.ts`).
- **Anexos e documentos saem pela função**, depois do RBAC e do registro de
  acesso (`anexo_acesso.ts`, `acesso_dado_sensivel`). A única URL assinada é a
  da exportação completa: **60 s**, e só para quem tem `exportar` **e**
  `exposicao.ver`.
- **Cópia da exportação completa** (zip em claro com o banco inteiro): apagada
  pela rotina noturna **24 h** depois de gerada (`servicos/privacidade.ts`).
  Desvio do Python, onde a cópia ficava no disco do setor.
- Criptografia em repouso e em trânsito: a do provedor (Supabase/AWS) e TLS em
  toda conexão (navegador ↔ Netlify, Netlify ↔ Supabase).

### 5.2 Minimização na exibição (RN-19)

- Sem `exposicao.ver` nem `epi.ficha`, nome e SIAPE do servidor viram
  identificador opaco por sessão (`SRV-xxxx`), nunca máscara parcial.
- **Varredura automática** (`testes/privacidade_varredura.test.ts`): povoa o
  ambiente de teste inteiro, percorre cada tela, fragmento HTMX, rota da
  `/api/v1`, busca, exportação e documento gerado (abrindo .docx/.xlsx/.zip por
  dentro), com quatro contas sem permissão nominal, e falha se aparecer nome ou
  SIAPE de terceiro fora das **saídas nominais deliberadas**, que estão listadas
  no próprio teste com o motivo de cada uma (instrutor, abas nominais da turma,
  certificado, `.docx` oficial do parecer com registro de acesso, nome de
  conta).
- Vazamentos corrigidos nesta revisão: ver `DESVIOS.md`, "Produção —
  privacidade".

### 5.3 Registro de acesso

Porte de `app/registro_acesso.py`: tabela `registro_acesso` (migração 0004),
com correlação, IP (cabeçalho do Netlify), **id numérico** da conta, método,
**forma** da rota (`/servidores/{id}`), status e duração. Nunca nome, SIAPE,
login, query string, corpo ou caminho concreto; rota desconhecida sai `-`.
Retenção **90 dias** (`CSSO_LOG_RETENCAO_DIAS`, o mesmo prazo de `sessao`),
**cumprida pela rotina noturna**. Fica no banco em São Paulo, sob RLS e no
backup cifrado — e não no log do Netlify.

Marco Civil, art. 15 (6 meses): alcança o provedor de aplicação constituído como
pessoa jurídica **com fins econômicos**; a POLITICA_RETENCAO §2.5, item 2, já
registra a dúvida de que alcance autarquia federal. Não foi fixado aqui. Se o
encarregado/procuradoria concluir pelos 6 meses, basta
`CSSO_LOG_RETENCAO_DIAS=180` (vale para `sessao` e `registro_acesso`).

**Categoria de dado nova na nuvem:** `limite_login_ip` guarda o endereço de
origem e a contagem de falhas de login por até um dia (proteção contra
tentativa de senha em massa, que na rede do setor não existia). Mesma base do
registro de acesso (art. 7º, II, e art. 46 — segurança). Não guarda login nem
conta.

### 5.4 Logs da plataforma

O que o código escreve em `console` vai para o Netlify (EUA). Regra: **só
identificadores técnicos** — tipo e código do erro, id numérico de conta,
contagens. O erro não tratado sai sem os parâmetros da consulta
(`resumoDoErro`), e o detalhe das rotinas também (`mensagem_sem_dados`). O
registro de acesso não usa `console`.

### 5.5 CPF

O sistema **não tem coluna de CPF** em tabela nenhuma (conferido no esquema e
no ambiente de teste povoado). Desde esta revisão, **CPF digitado em qualquer
campo livre é mascarado na entrada** (`***.***.***-**`, sem dígito nenhum) — em
todo formulário, toda chamada da API, nomes de arquivo enviados e nas
importações de planilha e Trello. A RN-21 continua recusando a palavra "cpf"
nos campos que filtra. `ferramentas/procurar-cpf.ts` conta, sem imprimir o
valor, CPF que já esteja no banco (rodar depois de carregar os dados reais e a
cada restauração). **Não alcança o conteúdo de anexo** (PDF digitalizado pode
trazer CPF impresso).

### 5.6 Backup

Backup lógico cifrado (AES-256-GCM, PBKDF2-SHA256 390 mil, o mesmo envelope do
Python) em `backups/`, com a senha em variável de ambiente e retenção de 90
dias + 1 mensal por 5 anos. Fica **no mesmo provedor e na mesma região** do
banco: protege contra erro e corrupção, não contra perda da conta — ver §7.

## 6. Retenção — o que a nuvem acrescenta à política

| Conjunto | Prazo | Mecanismo |
|---|---|---|
| `registro_acesso` | 90 dias (`CSSO_LOG_RETENCAO_DIAS`) | Rotina noturna (`EXPURGO_PRIVACIDADE`) |
| `limite_login_ip` (IP e contagem de falhas de login, tabela nova da migração 0003) | 1 dia | `autenticacao.expurgar_limites_ip` |
| `exportacoes/` (zip em claro) | 24 h | Rotina noturna (`EXPURGO_PRIVACIDADE`) |
| `backups/` | 90 dias + 1 mensal por 5 anos | Rotina de retenção de backup |
| `entrada/` (cópia da planilha/JSON importados) | Até o encerramento da migração, como `stg_*` (POLITICA §2.1) | **Manual**: apagar no painel do Storage ao encerrar a migração |
| `documentos/` (.docx gerados) | Regeneráveis do contexto congelado; sem prazo próprio | — |
| Logs da função no Netlify | Prazo do plano do Netlify | Fora do controle do setor; por isso nada pessoal vai para lá |

## 7. O que falta providenciar (responsável: controlador)

1. **Autorização formal da UFVJM** para hospedar o sistema em nuvem de
   terceiro, com os dados reais — antes, e não depois, de ampliar o uso.
2. **Indicação e ciência do encarregado (DPO)**, com esta emenda e o ROPA.
3. **Instrumento com os operadores** (art. 39): aceitar/firmar os DPAs do
   Supabase e do Netlify **em nome de quem contrata**, e resolver quem contrata
   — hoje é conta pessoal. Com isso, as cláusulas de transferência
   internacional (art. 33).
4. **Região**: mover a função do Netlify para São Paulo (encerra a
   transferência pelo caminho da requisição); confirmar a região do projeto
   Supabase no painel.
5. **Conferir com o TI da UFVJM as normas de nuvem da administração pública
   federal** (a IN GSI/PR nº 5/2021 trata de requisitos de segurança para
   nuvem, inclusive onde o dado pode residir) — a conferir, não conferido.
6. **Cópia do backup fora do provedor** (rede institucional), para que a perda
   da conta não seja perda do acervo.
7. **Prazo do registro de acesso** (90 dias × 6 meses do Marco Civil): decisão
   do encarregado com a procuradoria (§5.3).
8. **Apagar `entrada/`** quando a migração do legado for dada por encerrada.
9. **Divulgar o canal do titular** (e-mail do setor) onde o servidor o encontre
   (ROPA §7).
