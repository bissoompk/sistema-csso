# Produção — runbook

Como pôr o Sistema SISA na nuvem com **dado real de servidor** (LGPD) e mantê-lo de pé.
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
| `DATABASE_URL` | Supabase > Connect > **Session pooler** (porta 5432), com a senha nova. Na porta 6543 (modo transação) o sistema funciona, mas sem consulta preparada: cada tela fica 2 a 4 vezes mais lenta (`src/db/cliente.ts`) | sim |
| `CSSO_AMBIENTE` | `producao` | sim |
| `CSSO_CHAVE_SECRETA` | 32+ caracteres aleatórios¹ | sim² |
| `CSSO_BACKUP_SENHA` | 16+ caracteres, **guardada também fora do Netlify** — backup sem a senha é lixo | sim² |
| `CSSO_ROTINA_SEGREDO` | 32+ caracteres aleatórios¹, diferente da chave | sim (sem ela o backup diário não roda) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | sim |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings > API > service_role | sim |
| `CSSO_BUCKET` | `csso-producao` (bucket novo e vazio; o `csso` antigo tem arquivos de teste) | sim |
| `CSSO_URL_PUBLICA` | a mesma URL passada ao `producao-iniciar` (recuo; o que vale é o parâmetro do banco) | recomendada |
| `CSSO_CONVERSOR_PDF_URL`, `CSSO_CONVERSOR_PDF_USUARIO`, `CSSO_CONVERSOR_PDF_SENHA` | o conversor de PDF do modelo enviado (§2.1) | não (sem ele, o modelo enviado sai em Word) |
| `CSSO_SMTP_URL` (secret), `CSSO_EMAIL_REMETENTE`, `CSSO_EMAIL_RESPONDER_PARA` | o envio de e-mail (§2.2, «Configurar o envio de e-mail») | não, mas sem elas **nenhum e-mail sai**, nem o link de «Ativar meu acesso» (os pedidos ficam na fila) |
| `CSSO_EPI_EMAIL` (`sim` liga; padrão desligado), `CSSO_EPI_EMAIL_SETOR` | e-mail do pedido de EPI: aviso ao setor na abertura e ao requerente na abertura e na decisão (paridade com o IntegraSST, 22/10/2026) | não (desligado, só o sino avisa) |
| `CSSO_COOKIE_SEGURO` | `auto` (padrão) ou `sim`; **nunca** `nao` (produção recusa subir)² | não |
| `CSSO_SESSAO_HORAS` (12), `CSSO_SESSAO_INATIVIDADE_MINUTOS` (60; 0 desliga), `CSSO_MAX_TENTATIVAS`, `CSSO_BLOQUEIO_MINUTOS`, `CSSO_MAX_FALHAS_IP`, `CSSO_JANELA_IP_MINUTOS`, `CSSO_LOG_RETENCAO_DIAS`, `CSSO_EPI_LOCAL_RETIRADA`, `CSSO_FUSO_EXIBICAO` | padrões servem | não |

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

### 2.1 Conversor de PDF do modelo enviado (opcional)

O modelo enviado pela tela (`/treinamentos/modelos`) é um .docx com o layout
do setor. O PDF da casa não o reproduz, e a Netlify não roda LibreOffice; o
PDF fiel sai de um **Gotenberg** (LibreOffice atrás de uma API) no Google
Cloud Run, em São Paulo. Sem ele, o certificado de modelo enviado sai só em
Word — nada quebra. O conversor não guarda nada: recebe o .docx, devolve o
PDF; o sistema guarda o PDF no Storage e não converte de novo.

Uma vez, com o `gcloud` num projeto com faturamento (o uso do setor cabe na
camada gratuita do Cloud Run):

```sh
SENHA=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
gcloud run deploy csso-conversor-pdf \
  --image=gotenberg/gotenberg:8 --region=southamerica-east1 \
  --port=3000 --memory=2Gi --cpu=1 --min-instances=0 --max-instances=2 \
  --allow-unauthenticated \
  --set-env-vars=GOTENBERG_API_BASIC_AUTH_USERNAME=csso,GOTENBERG_API_BASIC_AUTH_PASSWORD=$SENHA \
  --command=gotenberg --args=--api-enable-basic-auth
```

`--allow-unauthenticated` só abre o endereço: a senha (autenticação básica)
continua exigida em toda conversão. No Netlify: `CSSO_CONVERSOR_PDF_URL` = a
URL que o comando imprime, `CSSO_CONVERSOR_PDF_USUARIO=csso` e
`CSSO_CONVERSOR_PDF_SENHA` = a senha (secret). Publique de novo.

Com o conversor fora do ar (ou a primeira conversão passando de 20 s, o que
pode acontecer no primeiro acesso depois de um tempo parado), o botão de PDF
leva ao Word e o log da função registra o motivo; tentar de novo costuma
resolver. LGPD: o .docx leva nome e, se o modelo pedir, CPF — o Cloud Run fica
em São Paulo e não grava o documento; o Google está registrado como operador
em `docs/ROPA_NUVEM.md` §3 e §5.7.

### 2.2 Configurar o envio de e-mail

O sistema envia e-mail em quatro situações: o **link «Ativar meu acesso /
Esqueci minha senha»** (tela de entrada), o **certificado com o PDF anexado**, o
**aviso a quem pediu vaga pelo link público** e, se ligado, o **pedido de EPI**.
Tudo passa por uma fila (`email_saida`) e sai por **SMTP**: o do Google
Workspace da UFVJM, o de outro provedor ou o do próprio e-mail institucional.
**Enquanto o envio não estiver configurado nada quebra, mas nada sai**: os
e-mails ficam parados na fila (pendentes) e saem sozinhos quando o envio for
ligado. Os e-mails de «Ativar meu acesso» **vencem em 1 hora**: com o envio
desligado, o link vence na fila e a pessoa precisa pedir de novo depois que o
envio for ligado.

**Variáveis de ambiente do Netlify** (Site configuration > Environment
variables; as secretas marcadas como *secret*, escopo Builds **e** Functions):

| Variável | Obrigatória | O que faz | Exemplo (sem segredo) |
|---|---|---|---|
| `CSSO_SMTP_URL` (**secret**) | sim | Endereço do servidor de e-mail **com usuário e senha**. Sem ela o envio fica desligado. O `@` do usuário vira `%40`. A senha de app do Google só tem letras: cole **sem espaços**. | `smtps://csso.sisa%40ufvjm.edu.br:<SENHA_DE_APP_sem_espacos>@smtp.gmail.com:465` |
| `CSSO_EMAIL_REMETENTE` | sim | O «De:» das mensagens: nome entre aspas e o endereço. Sem ela o envio fica desligado. | `"Sistema SISA" <csso.sisa@ufvjm.edu.br>` |
| `CSSO_EMAIL_RESPONDER_PARA` | não | Para onde vai a resposta de quem apertar «Responder» (o e-mail do setor que lê). Vazio: responde ao remetente. | `sisa@ufvjm.edu.br` |
| `CSSO_ROTINA_SEGREDO` (**secret**) | sim, para sair na hora | O mesmo segredo de 32+ caracteres da tabela da §2. Com ele cada pedido «acorda» o envio imediatamente; sem ele os e-mails só saem na rotina agendada, a cada 10 minutos. | (o mesmo da §2) |
| `CSSO_URL_PUBLICA` | recomendada | O endereço do sistema que vai nos links dos e-mails. Sem ela vale a `URL` que o próprio Netlify define para o site. | `https://sisa.ufvjm.edu.br` |
| `CSSO_EPI_EMAIL` | não | `sim` liga o e-mail do pedido de EPI (aviso ao setor e ao requerente). Padrão: desligado. | `sim` |
| `CSSO_EPI_EMAIL_SETOR` | não | Endereço do setor que recebe o aviso de pedido de EPI. | `sesmt@ufvjm.edu.br` |

Essas são **todas** as variáveis de e-mail; não existe `SMTP_HOST`,
`SMTP_USER` etc.: servidor, porta, usuário e senha vão dentro da
`CSSO_SMTP_URL`.

**Mudou uma variável no Netlify? Publique de novo** (Deploys > Trigger deploy >
*Deploy site*). A função só enxerga o valor novo depois de um novo deploy.

#### Gmail / Google Workspace da UFVJM (conta `csso.sisa@ufvjm.edu.br`)

1. **Verificação em duas etapas ligada** na conta (Conta Google > Segurança).
   Sem ela o Google não oferece a senha de app.
2. **O administrador do Workspace precisa permitir senhas de app** (Console de
   administração > Segurança > Autenticação > Verificação em duas etapas). Se a
   opção «Senhas de app» não aparecer na conta, é isso que está faltando: peça à
   TI da UFVJM.
3. Na conta `csso.sisa@ufvjm.edu.br`: Conta Google > Segurança > **Senhas de
   app** > nome «Sistema SISA» > **Criar**. O Google mostra 16 letras em
   blocos de 4: copie **sem os espaços**. Ela aparece uma vez só.
4. No Netlify, crie as variáveis (a primeira como *secret*):
   - `CSSO_SMTP_URL` = `smtps://csso.sisa%40ufvjm.edu.br:<SENHA_DE_APP_sem_espacos>@smtp.gmail.com:465`
   - `CSSO_EMAIL_REMETENTE` = `"Sistema SISA" <csso.sisa@ufvjm.edu.br>`
5. Publique de novo (novo deploy).
6. Teste, na pasta `nuvem/`, com as mesmas variáveis exportadas no terminal ou
   num `.env` local (que **não vai para o git**):

   ```sh
   npm run testar-email -- --para seu.email@ufvjm.edu.br
   ```

   Ele confere a conexão e o login, envia um e-mail de teste e diz «ENVIADO»
   ou o motivo da falha. **Nunca imprime a senha nem a URL inteira.** Depois,
   em **Configurações** (`/config`, bloco «Envio de e-mail», para quem pode
   fazer backup), o sistema deve dizer **configurado**, com a fila de
   pendentes e falhos.

**Porta e criptografia.** `smtps://…:465` abre a conexão já criptografada (TLS):
é a forma recomendada e a do exemplo. `smtp://…:587` abre a conexão e **sobe
para TLS (STARTTLS)** se o servidor oferecer; funciona no Gmail e na maioria
dos provedores, mas prefira a 465. Não use a porta 25 (quase todo provedor a
bloqueia).

**O Gmail reescreve o remetente.** Pelo SMTP do Gmail o «De:» sai sempre como a
**própria conta autenticada** (`csso.sisa@ufvjm.edu.br`), mesmo que a
`CSSO_EMAIL_REMETENTE` diga outro endereço (a não ser que o outro esteja
cadastrado como «Enviar como» naquela conta). O nome entre aspas é mantido.

**Limite diário.** O Google Workspace limita o envio por conta a cerca de 2.000
mensagens por dia (confira o valor atual na ajuda do Google). Para o uso do
setor sobra; o que passar do limite volta para a fila e tenta de novo (1, 5, 15
e 60 minutos; depois da quinta tentativa fica como *falhou*, com o motivo, em
`/certificados/emails`, de onde se devolve à fila).

**SPF e DKIM, em linguagem simples.** São dois «selos» que a UFVJM publica no
DNS do domínio `ufvjm.edu.br` para provar que o e-mail que diz vir de
`@ufvjm.edu.br` veio de um servidor autorizado. O **SPF** lista quem pode
enviar em nome do domínio (o Google já deve estar incluído:
`include:_spf.google.com`). O **DKIM** é uma assinatura digital que o Google
coloca em cada mensagem; ela é ativada no Console de administração do
Workspace (Aplicativos > Google Workspace > Gmail > Autenticar e-mail) e a TI
publica a chave no DNS. Sem eles o e-mail pode cair no **spam** ou ser recusado
por quem confere (Gmail, Outlook). Como o envio sai pelo próprio Workspace da
UFVJM com remetente `@ufvjm.edu.br`, em geral já está certo: confirme com a TI
e use `npm run testar-email` para um endereço de fora da UFVJM, olhando se
caiu no spam. Com um serviço de envio (Brevo, Resend…), é ele quem entrega os
registros SPF/DKIM para a TI publicar.

**Outros provedores.** Qualquer SMTP serve (o institucional, Brevo, Resend…):
troque só servidor, porta e credenciais da `CSSO_SMTP_URL`
(`smtps://usuario:senha@servidor:465`) e use um remetente que o provedor aceite.

**Quem envia.** A função de fundo `email-background`, acordada a cada pedido
(precisa de `CSSO_ROTINA_SEGREDO`), e a agendada `email-agendado`, a cada 10
minutos. **LGPD:** o provedor é **operador**; registre qual em
`docs/ROPA_NUVEM.md` §3 antes de ligar.

**«Ativar meu acesso» sem e-mail configurado.** A tela pública continua
respondendo igual (por segurança ela nunca diz se algo foi enviado), mas nenhum
link chega. O sinal está em dois lugares: o log da função (`[ativar-acesso]
pedido recebido, mas o envio de e-mail não está configurado`) e o bloco «Envio
de e-mail» de `/config`, que mostra «não configurado» e quantos e-mails estão
parados na fila.

## 3. Implantar (uma vez)

Da sua máquina, na pasta `nuvem/`, com a URL de **Session pooler** (porta 5432)
ou a conexão direta — DDL e transação longa não combinam com o pooler de
transação:

```bash
DATABASE_URL='postgresql://postgres.<ref>:<senha>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres' \
npm run producao-iniciar -- \
  --nome "<Seu Nome>" --email <voce>@ufvjm.edu.br \
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
2. Entre com o seu e-mail (é o login) e a senha provisória. O sistema manda para
   `/trocar-senha`: troque. A senha precisa de **10 caracteres** (uma frase
   curta serve). Conta trazida de banco antigo com senha de 6 caracteres
   entra uma vez e é mandada trocar.
3. **Senha esquecida**: toda conta, inclusive a de administração, usa **«Esqueci
   minha senha»** na tela de entrada: o link vai ao e-mail da conta. Na conta
   de administração (superintendente, `admin_ti`, quem concede perfil) o link
   vale **30 minutos**, a redefinição encerra as outras sessões, avisa por
   e-mail («se não foi você…») e fica na trilha. O `admin_ti` também redefine a
   de conta comum em `/usuarios`; a de administração só o superintendente. Se o
   e-mail da conta não chega mais (ou a conta está inativa), pela linha de
   comando, com a `DATABASE_URL` de produção (registre em ata):
   `npm run redefinir-senha -- --email <e-mail>` (`--reativar` se a conta
   também estiver inativa). A senha provisória aparece uma vez.
4. Em `/usuarios` > Gerir, corrija o ato "BOOTSTRAP — substituir pelo ato
   real" para o ato normativo verdadeiro e cadastre as demais contas (perfil e
   servidor já no cadastro). O superintendente opera o sistema inteiro, menos
   assinar parecer e laudo — isso exige perfil técnico e habilitação atestada.
   Os servidores entram por planilha em `/servidores` > Importar.
   **Administrador do sistema** — o perfil acima de todos (tudo, em todos os
   módulos e setores, menos assinar parecer e registrar laudo). Só quem o tem
   o concede (o superintendente não), e a conta dele só é alterada,
   redefinida ou inativada por outro Administrador do sistema. A primeira
   concessão é pela linha de comando, com a `DATABASE_URL` de produção no
   ambiente (registre em ata):

   ```
   npm run conceder-administrador -- --email <seu e-mail> [--nome "Nome completo"]
   ```

   A ferramenta mostra a identidade do banco e pede que você a digite antes
   de gravar. Conta que já existe (achada pelo e-mail; `--login` vale para
   conta antiga) só recebe o perfil, em todos os campi e sem termo, sem mudar
   a senha. Conta que não existe é criada se vier `--nome`, com login = e-mail,
   senha provisória forte mostrada **uma vez** e troca obrigatória no primeiro
   login. A trilha registra `PERFIL_CONCEDIDO` (e `USUARIO_CRIADO`) com o ator
   "linha de comando"; corrija o ato depois em Gerir.
5. `GET /saude/db` (logado como superintendente/admin_ti/auditor) deve mostrar
   `"producao": true`.
6. **Depois de carregar os dados reais** (importação da planilha/Trello), rode
   `npx tsx ferramentas/procurar-cpf.ts` (com a `DATABASE_URL` de produção):
   ele só CONTA CPF perdido em coluna de texto, nunca mostra o valor. Resultado
   diferente de zero: tratar linha a linha pelo `id`.
7. **Ao encerrar a migração de dados**, apague as cópias brutas das planilhas e
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

Depois de semear, o build roda `ferramentas/converter-logins.ts` (login é o
e-mail, 23/10/2026): **só no banco com a marca de produção**, troca o login
de cada conta antiga pelo e-mail cadastrado (minúsculas), com o evento
"Login convertido para o e-mail" na trilha. Idempotente: na publicação
seguinte não há o que converter. A conta com e-mail vazio, repetido ou já
usado como login de outra **não** é convertida; o log do deploy mostra
`[logins] ATENÇÃO: conta N ... NÃO convertida: <motivo>` — corrija o e-mail
em Usuários e a próxima publicação a converte. Até lá ela entra pelo login
antigo, que a tela continua aceitando. As sessões abertas não caem.

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

## 9. Recomeçar o cadastro de treinamentos (limpeza)

`npm run limpar-treinamentos` apaga os dados do módulo Certificados e
Treinamentos (treinamentos, turmas, inscrições, presenças, certificados
emitidos e seus arquivos, participantes e e-mails, instrutores/assinaturas,
duplicados, acessos de participante e os avisos de e-mail e pendências ligados
a isso). **Mantém** os modelos de certificado, a numeração (número usado não se
reaproveita), servidores, usuários, perfis, setores promotores, catálogos, EPI,
processos e a trilha, que ganha um evento `DADOS_DE_TREINAMENTO_APAGADOS` (só
contagens). Os modelos continuam, mas deixam de apontar para um treinamento.

```
# 1. simular: tudo numa transação, com rollback; imprime as contagens
npm run limpar-treinamentos -- --copia ~/copias-sisa --simular

# 2. executar (pede para digitar a identidade do banco mostrada na tela)
npm run limpar-treinamentos -- --copia ~/copias-sisa
```

- Lê o `DATABASE_URL` do ambiente (ou de `nuvem/.env`) e mostra a identidade do
  banco, nunca a URL. `--confirmar <identidade>` faz a confirmação sem teclado.
- `--copia <pasta>` é obrigatório e **fora do repositório**: grava um JSON
  (permissão 600) com todas as linhas apagadas. **Tem dados pessoais** (nome,
  CPF, e-mail): guarde em lugar seguro e apague quando não precisar mais. Não
  inclui os arquivos (PDF/DOCX), só as linhas.
- Faça `npm run rotinas -- backup` antes. A limpeza apaga no banco numa só
  transação (DELETE por tabela, nunca TRUNCATE; as travas da trilha ficam
  ligadas) e, **depois do commit**, apaga do armazenamento os arquivos que
  ficaram órfãos. Falha no armazenamento não desfaz o banco: vem relatada e o
  código de saída é 5.
- Aborta sem gravar se alguma tabela fora da lista referencia as apagadas, ou
  se houver gatilho de DELETE nelas. Rodar de novo com tudo vazio não faz nada.

### 9.1 Limpar os dados de teste pela tela (Administrador do sistema)

Depois de testar no ambiente de produção, quem tem o perfil **Administrador do
sistema** abre **Configuração → Limpar dados de teste** (`/config/limpar-dados`;
nenhum outro perfil vê o link nem abre a tela). Marque os módulos —
*Treinamentos e certificados*, *Acidentes*, *EPI* (o catálogo fica),
*Processos e demandas* — e, se quiser, *Apagar também servidores e contas*
(só junto com os quatro; ficam a sua conta, as contas com Administrador do
sistema, Superintendente ou perfil que concede perfil, e os servidores
ligados a elas). Clique **Simular**: a tela mostra, por tabela, o que sairia
(tudo numa transação desfeita) e, se o grafo de chaves estrangeiras não
fechar, os problemas — aí não há como seguir. Para apagar, digite a frase
`APAGAR DADOS DE TESTE`, a identidade do banco mostrada na tela e a sua senha
atual (errar a senha conta como tentativa de login). O sistema faz o **backup
cifrado** (o mesmo do botão de Configuração) antes de apagar e só apaga se ele
terminar bem; a tela de resultado diz a chave do backup em `backups/`. Sem o
Storage configurado (`SUPABASE_URL`) a limpeza é recusada. Perfis, setores,
campi, catálogos, configurações e a trilha de auditoria ficam sempre. A
**numeração** dos módulos marcados (turmas, certificados, CAT/SP, pedidos de EPI,
pareceres) **volta a zero**: o próximo protocolo é o 1. A trilha ganha um evento
«Dados de teste apagados» com as contagens. Os arquivos órfãos do
armazenamento saem logo depois da gravação.

## 10. Criar o acesso dos servidores já cadastrados

Desde 23/10/2026 o cadastro de servidor ativo com e-mail institucional cria a conta sozinho (sem senha utilizável, sem e-mail enviado). Para os que já estavam cadastrados antes, rode uma vez:

```
npm run criar-acessos -- --simular   # mostra as contagens e desfaz
npm run criar-acessos
```

Cada servidor define a senha em «Ativar meu acesso» (ou «Esqueci minha senha») na tela de login. Quem está sem e-mail institucional no cadastro não ganha acesso: a ficha e `/config` mostram quantos são.

## 11. Liberar o módulo de acidentes (roteiro)

O módulo fica **travado na produção**: o cartão aparece «em desenvolvimento» e as telas `/acidentes` respondem 404, até a variável `CSSO_MODULO_ACIDENTES=sim`. Siga as etapas na ordem. **Etapa A é pré-requisito: sem ela, não ligue.**

### A. Antes de ligar (decisões e ações fora do código)

- [ ] **Revogar o legado CAT/SP**: tirar o link público do Drive e trocar a senha compartilhada. O módulo novo coleta CPF e saúde; manter o legado aberto torna a ROPA falsa (ROPA §0.6).
- [ ] **O encarregado decide os itens abertos da ROPA §9**: 4 (base legal do art. 14 para o menor), 5 (base legal do comunicante e da testemunha), 10 (prazo do expurgo da identificação) e 11 (legado). O sistema já protege o dado do menor; falta a base legal escrita.
- [ ] **Conferir a natureza da lesão**: a lista é a Tabela 17 do eSocial v2.5 (29 linhas). Confirmar com a equipe se é a mesma que o Anexo III.2 do Manual de Perícia pede.
- [ ] **Conferir os itens 107 e 108 do agente causador** e o «ARQUIBANCADA, ESTÁDIO» extra (`DESVIOS.md`).
- [ ] **A equipe de segurança revisa as sugestões por família de agente** (`src/dominio/acidente_sugestoes.ts`). Não bloqueia a liberação (só aponta), mas o texto é rascunho.
- [ ] **Conferir que o último deploy rodou**: abra a aba Saúde de um caso e veja se o campo «natureza da lesão» tem opções (a lista entra pelo deploy).

### B. Quem vê o quê (conferir em Gerir antes de abrir)

| Perfil | Ficha e Análise | Identificação (CPF etc.) | Saúde nível 2 e PDF do Anexo III |
|---|---|---|---|
| Médico do trabalho, coordenação, superintendência | sim | sim | sim |
| Engenheiro e técnico de segurança | sim | sim | não |
| Secretaria | sim | não | não |
| Almoxarife, administrador | não | não | não |
| Servidor | só o caso em que é acidentado | só a dele | só a saúde dele, sem o PDF |

Confira se as atribuições vigentes estão certas: quem não devia ver CPF não pode ter o perfil de engenheiro ou técnico.

### C. Ligar

1. **Ensaie fora da produção.** Caso criado em produção **não se apaga** (a CAT/SP é append-only; correção é retificação). Um caso de teste lá fica para sempre. Use um banco de teste: `npm run ambiente-teste` com `DATABASE_URL` apontando para um banco separado, e rode `npm run dev`.
2. No painel do Netlify, acrescente `CSSO_MODULO_ACIDENTES=sim` e publique de novo.
3. Acompanhe o **primeiro caso real** de ponta a ponta (comunicação, triagem, saúde pelo médico, relatório) antes de divulgar para os demais.

### D. E-mails do módulo (opcional, desligados por padrão)

Com o módulo estável, para avisar o setor de cada comunicação nova e confirmar ao comunicante: `CSSO_ACIDENTE_EMAIL=sim` e `CSSO_ACIDENTE_EMAIL_SETOR=<endereço do setor>`, e publique. Antes, teste o envio com `npm run testar-email`. O corpo leva só protocolo, o que aconteceu e o link; nunca dado de saúde ou identificação.

### E. Casos do sistema antigo (uma vez)

Depois de ligar e **depois de revogar o legado**: a importação está na seção «Migração dos casos do CAT/SP antigo», abaixo. Rode sempre `--simular` primeiro.

### F. Depois de ligar

- **Expurgo** (seção «Expurgo parcial», abaixo): só execute com o prazo confirmado pelo encarregado. A simulação é livre.
- **Backup** do banco antes de qualquer expurgo ou importação.
- **Para voltar a segurar**: apague a variável (ou ponha `nao`) e publique. Os dados ficam; só as telas somem.

## 12. Liberar o módulo de ocorrências de urgência e emergência

O módulo (`/ocorrencias`) também fica **travado na produção**: o cartão aparece «em desenvolvimento» e as telas respondem 404 até `CSSO_MODULO_OCORRENCIAS=sim`. Ele guarda o relato de saúde de qualquer pessoa na universidade (servidor, estudante, terceirizado, visitante).

1. **Antes:** o encarregado confere a ROPA (finalidade, base legal, quem lê, prazo de guarda do relato) para estudantes, terceirizados e visitantes, e a equipe que vai tratar as ocorrências (perfis coordenação, engenharia, técnico, médico e secretaria) combina quem assume cada caso.
2. **Ligar:** no painel do Netlify, acrescente `CSSO_MODULO_OCORRENCIAS=sim` e publique de novo. A migração `0040_ocorrencias` roda no deploy.
3. **E-mail (opcional):** `CSSO_OCORRENCIA_EMAIL=sim` e `CSSO_OCORRENCIA_EMAIL_SETOR=<endereço da equipe>`. O e-mail traz só o protocolo e o link, nunca o relato. Sem o endereço da equipe, só quem registrou recebe a confirmação, e a trilha diz por quê.
4. **Guarda:** a rotina noturna anonimiza a ocorrência encerrada há mais de 5 anos (nome, relato, contato e acompanhamento); a estatística fica. O prazo é `ANOS_DE_GUARDA` em `servicos/ocorrencia_expurgo.ts`: ajuste se o encarregado decidir outro.
5. **Conferir:** com uma conta de estudante de teste, registre uma ocorrência; com a coordenação, abra a fila, assuma, acompanhe e conclua; baixe a planilha e confirme que ela não traz o nome nem o relato.

## Migração dos casos do CAT/SP antigo (uma vez)

Exporte as abas `COMUNICACOES`, `ANALISES_MAPA` e `PLANO_ACAO` da planilha como CSV, para uma pasta **fora do repositório** (os arquivos têm CPF e saúde). Depois:

```
npm run importar-catsp -- --pasta ~/catsp-csv --por <login> --simular
npm run importar-catsp -- --pasta ~/catsp-csv --por <login>
```

A simulação mostra o que entraria e desfaz. O terminal só mostra protocolos e códigos. Pode repetir: o que já entrou é pulado. Ao terminar, apague a pasta e registre em ata. Os PDFs antigos se baixam à mão e se anexam a cada caso. Detalhes em `DESVIOS.md` (F9).


## Expurgo parcial de Acidentes (ato manual, com ata)

Apaga a identificação pessoal, o contato das testemunhas e o detalhe de saúde (nível 2) das ocorrências concluídas há mais de 5 anos e com decisão pericial. **Só execute depois que o encarregado confirmar o prazo** (ROPA §9, item 10). A simulação é sempre livre:

```
npm run expurgar-acidentes                                  # simulação: nada é gravado
npm run expurgar-acidentes -- --executar --ata "Ata 3/2031" # executa, pedindo a identidade do banco
```

É **irreversível** e não copia o dado apagado: faça o backup do banco antes, se quiser poder voltar. O terminal só mostra protocolos e contagens. Cada ocorrência recebe um evento na trilha, com a ata. Registre o ato na ata do setor. Detalhes em `DESVIOS.md` e na `POLITICA_RETENCAO.md` §2.4.
