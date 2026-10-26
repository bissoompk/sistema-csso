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

