# Produção — runbook

Como pôr o CSSO na nuvem com **dado real de servidor** (LGPD) e mantê-lo de pé.
Site: `https://cssosisa.netlify.app` (Netlify, função `csso` + duas rotinas) e
banco/arquivos no Supabase. Decisões técnicas em `DESVIOS.md`, seções
"Produção — segurança" e "Produção — operação".

> Hoje o banco do Supabase tem **dados de teste**. A implantação (§3) apaga
> tudo e recomeça vazio, com a marca de produção. Depois dela, nenhuma
> ferramenta deste repositório apaga aquele banco.

## 1. Antes de tudo: trocar a senha do banco

A senha atual do Postgres vazou em conversa. Troque **antes** de entrar dado real:

1. Supabase > Project Settings > Database > **Reset database password**. Gere
   uma forte; guarde onde a instituição guarda segredo.
2. Atualize `DATABASE_URL` no Netlify (§2) com a senha nova.
3. Troque também a `SUPABASE_SERVICE_ROLE_KEY` se ela passou por chat
   (Project Settings > API > *Roll* da service_role) e atualize no Netlify.
4. Apague `nuvem/.env.supabase` de qualquer máquina onde ele não precise estar.

## 2. Variáveis no Netlify

Site configuration > Environment variables. Marque as secretas como *secret*
(escopo: Builds **e** Functions — o build migra o banco).

| Variável | Valor | Obrigatória |
|---|---|---|
| `DATABASE_URL` | Supabase > Connect > **Transaction pooler** (porta 6543), com a senha nova | sim |
| `CSSO_AMBIENTE` | `producao` | sim |
| `CSSO_CHAVE_SECRETA` | 32+ caracteres aleatórios¹ | sim² |
| `CSSO_BACKUP_SENHA` | 16+ caracteres, **guardada também fora do Netlify** — backup sem a senha é lixo | sim² |
| `CSSO_ROTINA_SEGREDO` | 32+ caracteres aleatórios¹, diferente da chave | sim (sem ela o backup diário não roda) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | sim |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings > API > service_role | sim |
| `CSSO_BUCKET` | `csso-producao` (bucket novo e vazio; o `csso` antigo tem arquivos de teste) | sim |
| `CSSO_URL_PUBLICA` | a mesma URL passada ao `producao-iniciar` (recuo; o que vale é o parâmetro do banco) | recomendada |
| `CSSO_COOKIE_SEGURO` | `auto` (padrão) ou `sim`; **nunca** `nao` (produção recusa subir)² | não |
| `CSSO_SESSAO_HORAS`, `CSSO_MAX_TENTATIVAS`, `CSSO_BLOQUEIO_MINUTOS`, `CSSO_MAX_FALHAS_IP`, `CSSO_JANELA_IP_MINUTOS`, `CSSO_LOG_RETENCAO_DIAS`, `CSSO_EPI_LOCAL_RETIRADA`, `CSSO_FUSO_EXIBICAO` | padrões servem | não |

**Não** defina `CSSO_PRIMEIRO_ACESSO_REMOTO` (o primeiro acesso é pela linha de
comando, §3) nem `CSSO_DIR_ARQUIVOS` (é de desenvolvimento).

¹ `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

² Com `CSSO_AMBIENTE=producao` o sistema **recusa atender** (toda requisição
dá erro, e as rotinas falham) enquanto faltar `DATABASE_URL`, a
`CSSO_CHAVE_SECRETA` tiver menos de 32 caracteres ou for a de exemplo, a
`CSSO_BACKUP_SENHA` tiver menos de 16, ou `CSSO_COOKIE_SEGURO=nao`. A mensagem
no log da função diz qual variável (nunca o valor).

**Região da função** (Netlify Pro): Site configuration > Build & deploy >
**Functions > Region** (ou Cloud compute > Functions > Region) > **São Paulo
(`gru`)** — a mesma região do Supabase (`sa-east-1`). Cada requisição faz várias
idas ao banco; entre `us-east` e São Paulo isso é ~120 ms a cada uma. Depois de
trocar, publique de novo.

## 3. Implantar (uma vez)

Da sua máquina, na pasta `nuvem/`, com a URL de **Session pooler** (porta 5432)
ou a conexão direta — DDL e transação longa não combinam com o pooler de
transação:

```bash
DATABASE_URL='postgresql://postgres.<ref>:<senha>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres' \
npm run producao-iniciar -- \
  --login <seu.login> --nome "<Seu Nome>" --email <voce>@ufvjm.edu.br \
  --url-publica https://<endereço DEFINITIVO do sistema>
```

- A ferramenta mostra o banco e o que há nele, e pede que você **digite a
  referência do projeto** (`<ref>`). Errou: nada é apagado.
- **A URL pública fica congelada no QR de todo certificado.** Decida o
  endereço definitivo antes (domínio institucional, se vier). Se for o
  `*.netlify.app`, ele vale para sempre nos certificados já emitidos. Sem ela,
  em produção, a emissão fica bloqueada.
- Ela apaga as tabelas, migra, aplica as travas, semeia catálogos e perfis,
  grava a URL, **marca o banco como produção** e cria você como primeiro
  superintendente. A **senha provisória aparece uma vez** na tela.

O bucket `csso-producao` nasce privado no primeiro upload; confira em
Supabase > Storage que ele está **privado**. O bucket antigo (`csso`, só teste)
pode ser apagado depois.

## 4. Primeiro login

1. Publique o site (Deploys > Trigger deploy) com as variáveis do §2.
2. Entre com o login e a senha provisória. O sistema manda para
   `/trocar-senha`: troque.
3. Em `/usuarios`, substitua o ato "BOOTSTRAP — substituir pelo ato real" pelo
   ato normativo verdadeiro e cadastre as demais contas.
4. `GET /saude/db` (logado como superintendente/admin_ti/auditor) deve mostrar
   `"producao": true`.
5. **Depois de carregar os dados reais** (importação da planilha/Trello), rode
   `npx tsx ferramentas/procurar-cpf.ts` (com a `DATABASE_URL` de produção):
   ele só CONTA CPF perdido em coluna de texto, nunca mostra o valor. Resultado
   diferente de zero: tratar linha a linha pelo `id`.
6. **Ao encerrar a migração de dados**, apague as cópias brutas das planilhas e
   do JSON do Trello que a importação guarda em `entrada/` no bucket
   (Supabase > Storage > `csso-producao` > `entrada`) — são dado bruto, já
   normalizado no sistema (POLITICA_RETENCAO §2.1, staging). Registre em ata.

## 5. Backup e restauração

**Automático, todo dia às 01h30 (Brasília).** A função agendada
`rotina-noturna` acorda a função de fundo `backup-background` (até 15 min),
que:

- grava `backups/csso-AAAAMMDD-HHMMSS.enc` no bucket: o banco inteiro (retrato
  consistente, REPEATABLE READ) cifrado com AES-256-GCM (`CSSO_BACKUP_SENHA`);
- cifra cada anexo **uma vez** em `backups/anexos/<sha256>.enc` (os de ontem já
  estão lá; só o novo é copiado);
- aplica a retenção da `POLITICA_RETENCAO.md` §4: todos os dos últimos 90 dias
  + o primeiro de cada mês por 5 anos (e nunca menos de 7).

A mesma passada (a própria `rotina-noturna`, 30 s) expurga sessões vencidas
(90 dias) e janelas de limite de login por IP vencidas, roda os expurgos de
privacidade (registro de acesso, cópias de exportação), varre as pendências de
EPI (CA a vencer, troca devida) e confere a cadeia inteira da trilha.

**Backup na hora:** `npm run rotinas -- backup` (com as variáveis de produção
no ambiente) ou o botão de /config.

**O backup mora no mesmo Supabase.** Se o projeto for perdido, ele vai junto.
Uma vez por mês, baixe o `.enc` mais recente e a pasta `backups/anexos/`
(Supabase > Storage, ou `supabase storage cp -r --experimental
ss:///csso-producao/backups ./backups`) para disco **institucional** — nunca
nuvem pessoal (LGPD). Registre em ata.

**Restaurar** (sempre num banco NOVO; conferir antes de trocar):

```bash
# 1. banco novo (projeto Supabase novo, ou Postgres local), só migrado
DATABASE_URL=<url do banco novo> npm run db:migrar
# 2. restaurar — anexos da pasta baixada, ou do bucket configurado se omitir --anexos
DATABASE_URL=<url do banco novo> CSSO_BACKUP_SENHA=<senha> \
  npm run backup:restaurar -- backups/csso-AAAAMMDD-HHMMSS.enc --anexos backups/anexos [--permitir-remoto]
# 3. conferir: contagens, cadeia íntegra
DATABASE_URL=<url do banco novo> npm run rotinas -- noturnas   # CONFERENCIA_CADEIA ok
```

Saída 5 = algum anexo faltou ou não conferiu o SHA-256 (a mensagem diz quais).
Depois de restaurar, rode também `npx tsx ferramentas/procurar-cpf.ts` no
banco restaurado (backup antigo pode trazer CPF de antes da máscara).
O banco restaurado chega **com a marca de produção** (ela vai no backup). A
restauração usa `session_replication_role = replica`; se o Supabase recusar,
restaure num Postgres local, confira, e só então decida.

**Medido** (Postgres local, máquina com 4 núcleos ocupada por outros testes):

| Volume | Backup 1ª passada | Backup seguinte | Restaurar |
|---|---|---|---|
| ambiente de teste (12 servidores, 11 processos, 893 linhas, 14 anexos) | 0,6–1,3 s | 0,55 s | 3 s |
| sintético (1.020 servidores, 49 mil eventos, 54 mil linhas, 2.014 anexos de 400 KB = 790 MB) | 10–24 s | 3–9 s | 34 s |

Estimativa para ~1.000 servidores / 640 processos na nuvem: a passada diária
(banco ~5 MB cifrado + anexos novos do dia) leva **~15–40 s**; a **primeira**
(todo o acervo de anexos, ida e volta ao Storage) leva **~3–8 min** — dentro dos
15 min. O que não couber em 10 min fica para a noite seguinte (o backup sai
"PARCIAL" em `/saude/db`). Memória: ~430 MB (a função de fundo tem 1 GB).

**Capacidade do Supabase Free**: 500 MB de banco, **1 GB de Storage**, 50 MB
por arquivo. Anexos + a cópia cifrada deles + 90 backups diários de ~5 MB
estouram 1 GB por volta de 300–400 MB de anexos. Acompanhe (Supabase > Usage) e
planeje o Pro antes.

## 6. O que monitorar

- **`/saude/db`** (JSON; superintendente, admin_ti ou auditor): `rotinas` (a
  última passada de cada uma) e `alertas` — vazio é o esperado. Alerta: sem
  backup, backup falho/parcial, backup com mais de 36 h, cadeia rompida.
- **Cadeia rompida é incidente**: não se conserta pela tela. Preserve o banco
  (faça um backup na hora) e investigue.
- **Netlify > Logs > Functions**: `rotina-noturna` e `backup-background`
  (erros saem com `FALHA`). Netlify > Functions mostra o próximo agendamento.
- **Supabase > Usage**: tamanho do banco e do Storage, egress. Projeto Free
  sem atividade por 7 dias é pausado — a rotina diária mantém a atividade.
- Deploy que falhou na migração não vai ao ar (a versão anterior continua).

## 7. Atualizar

`git push` na branch publicada. O build (`npm run build`) **migra o banco e
semeia** antes de publicar; se a migração falhar, a publicação falha e a
versão anterior continua no ar. Migração nova é gerada com `npm run db:gerar`,
revisada à mão e testada (`npx vitest run`) antes do push.

## 8. Voltar atrás

- **Código**: Netlify > Deploys > escolha o deploy anterior > **Publish
  deploy**. É instantâneo e **não roda o build** — o banco fica como está.
- **Migração**: o Drizzle não tem "down". As migrações deste projeto são
  aditivas (tabela/coluna nova), e o código anterior convive com elas — então
  voltar o código basta. Migração que apaga ou transforma dado precisa de plano
  próprio **antes** do push: backup na hora (`npm run rotinas -- backup`) e,
  se der errado, restaurar esse backup num projeto novo (§5) e trocar a
  `DATABASE_URL`.
- **Desfazer a marca de produção** (só se o banco deixar de ser produção, por
  decisão registrada): no editor SQL do Supabase,
  `ALTER TABLE instalacao DISABLE TRIGGER USER; DELETE FROM instalacao; ALTER TABLE instalacao ENABLE TRIGGER USER;`.
  Nenhuma ferramenta faz isso por você, de propósito.
