# ROPA — emenda da instalação na nuvem (Netlify + Supabase)

**Complementa** `docs/ROPA.md` (v1.6, 04/09/2026) e `docs/POLITICA_RETENCAO.md`
do sistema Python. Finalidades, bases legais por categoria de dado, categorias
de titulares e de dados continuam as de lá: o porte (`nuvem/`) traduz o sistema
e não cria finalidade nem categoria nova. O que muda — e é o que esta emenda
registra — é **onde o dado está, quem o processa em nome da UFVJM e por qual
caminho ele passa**.

**Versão:** 1.7, de 23/10/2026 — prevenção de cadastros duplicados: o aviso
de cadastro existente ao e-mail do próprio cadastro, o limite por IP no
banco e o tempo de resposta constante do link público (§5.8), o aviso que
vence em 24 h e a confirmação do e-mail pelo link de acesso (§5.9 e §5.10),
e o registro do que cada junção move (§5.11). Sem finalidade nova.
Versão 1.6, de 20/10/2026 — acrescenta a correção de dados do
participante, com reemissão do certificado, e a junção de cadastros duplicados
(§5.11). Versão 1.5, de 20/10/2026: acrescenta ao §5.9 o aviso de reciclagem
por e-mail ao participante (manual, ou automático quando a CSSO o liga).
Versão 1.4, de 20/10/2026: acrescenta o acesso do participante sem
conta aos próprios certificados, por link enviado ao e-mail cadastrado (§5.10
e §6). Versão 1.3, de 20/10/2026: o envio de e-mail (certificado e
aviso da inscrição pelo link; §3, §5.9 e §6), **desligado até o controlador
escolher e registrar o provedor de SMTP**. Versão 1.2, de 20/10/2026: a
inscrição pública por link, um canal de coleta aberto a quem não tem conta
(§5.8 e §6). Versão 1.1, de
20/10/2026: o Google como operador (conversor de PDF do certificado, §2, §3 e
§5.7). Versão 1.0, de 25/09/2026 (revisão de
privacidade para produção).
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
| Conversor de PDF (desde 20/10/2026) | Google Cloud Run | **São Paulo** (`southamerica-east1`) | Recebe o .docx de um certificado de modelo enviado, devolve o PDF e descarta os dois — em memória, sem disco persistente. Ver §5.7 |

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
| Google LLC (EUA) | Cloud Run (projeto `csso-conversor-pdf`, serviço `csso-conversor-pdf`) | Converte o certificado .docx em PDF, por ordem do controlador; não guarda o documento | Termos do Google Cloud da conta pessoal (a mesma do Netlify), com o Cloud Data Processing Addendum do Google; **não firmado em nome da UFVJM** |

| *a definir* (§5.9) | SMTP (institucional, Gmail do setor ou serviço de envio) | Entrega o e-mail, por ordem do controlador | **Nenhum ainda: o envio fica desligado até o provedor ser escolhido e registrado nesta tabela** |

O conversor de PDF (§5.7) e o SMTP (§5.9) são as **únicas** chamadas do código
a serviço de terceiro fora da hospedagem. Fora delas, o sistema não chama API
de terceiro e não usa IA (ROPA §5.1 continua valendo para o resto).

**Registro tardio:** o conversor foi ligado em 20/10/2026, às 12h19, e esta
emenda é do mesmo dia, depois — o ROPA §5.1 pede emenda **prévia**. Fica dito.

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

Até 19/10/2026 o sistema **não tinha coluna de CPF**. Desde então há duas, e
só duas, com uma finalidade só — ver §5.5.1. Fora delas, **CPF digitado em qualquer
campo livre é mascarado na entrada** (`***.***.***-**`, sem dígito nenhum) — em
todo formulário, toda chamada da API, nomes de arquivo enviados e nas
importações de planilha e Trello. A RN-21 continua recusando a palavra "cpf"
nos campos que filtra. `ferramentas/procurar-cpf.ts` conta, sem imprimir o
valor, CPF que já esteja no banco (rodar depois de carregar os dados reais e a
cada restauração), excluídas as colunas do §5.5.1. **Não alcança o conteúdo de
anexo** (PDF digitalizado pode trazer CPF impresso).

#### 5.5.1 CPF só para certificado (19/10/2026)

Decisão do dono do sistema: "guardar CPF só para certificado". O certificado
de Brigadista Orgânico segue a norma do CBMMG, que exige o CPF do participante
e o do responsável pela formação.

| Item | Registro |
|---|---|
| Dado | CPF do participante de treinamento (servidor ou externo) e do instrutor |
| Onde | `participante.cpf`, `assinatura_instrutor.cpf` (só dígitos, CHECK de formato); cópia congelada em `certificado.contexto_congelado` **só** quando o modelo do treinamento tem marcador para o CPF |
| Finalidade | Emitir o certificado cuja norma exige o CPF; nada mais (não é chave de busca nem de identificação) |
| Base legal | Art. 7º, II (cumprimento de obrigação legal ou regulatória — a regulamentação do CBMMG para o certificado de brigadista) e art. 23 (execução de competência legal do serviço público) |
| Minimização | Opcional; só entra pelo campo próprio, com dígito verificador conferido; só é congelado quando o modelo o pede |
| Exibição | Nenhuma tela mostra dígito: só `***.***.***-**`. Fora de lista, busca, CSV, API, log e trilha (a trilha registra "CPF informado/substituído/apagado", sem o valor). A validação pública não o mostra |
| Saída | Só o documento do certificado (.docx/.pdf), baixado por quem tem `certificado.ver` (ou o próprio titular). No modelo enviado, o PDF passa pelo conversor do Google (§5.7), que recebe o .docx com o CPF |
| Exportação | A exportação em claro (`/config/exportar-tudo`) sai **sem** o CPF; o backup cifrado o leva |
| Quem altera | Quem gerencia a pessoa: `turma.inscrever` (participante), `assinatura.gerenciar` (instrutor) |
| Retenção | A do certificado que o exige; apagar é ato próprio na tela (auditado). Certificado já emitido guarda o CPF congelado pelo prazo do certificado |

### 5.6 Backup

Backup lógico cifrado (AES-256-GCM, PBKDF2-SHA256 390 mil, o mesmo envelope do
Python) em `backups/`, com a senha em variável de ambiente e retenção de 90
dias + 1 mensal por 5 anos. Fica **no mesmo provedor e na mesma região** do
banco: protege contra erro e corrupção, não contra perda da conta — ver §7.

### 5.7 Conversor de PDF do certificado (20/10/2026)

O modelo de certificado enviado pela tela (`/treinamentos/modelos`) é um .docx
com o layout do setor; a Netlify não roda LibreOffice, e o PDF da casa não
reproduz esse layout. O PDF fiel sai de um **Gotenberg** (LibreOffice atrás de
uma API) no Cloud Run do Google (`servicos/conversor_pdf.ts`; implantação em
`PRODUCAO.md` §2.1).

| Item | Registro |
|---|---|
| O que vai | O .docx de **um** certificado: nome do participante, dados da turma, notas e frequência e, quando o modelo pede (Brigadista, §5.5.1), o CPF do participante e o do instrutor |
| Quando | Só quando alguém com acesso ao certificado (`certificado.ver` ou o titular) pede o PDF de um certificado de modelo enviado **e** ele ainda não foi convertido; certificado do modelo da casa não passa por lá |
| Onde | Cloud Run em São Paulo (`southamerica-east1`); a função da Netlify (§2) chama o conversor |
| O que fica lá | Nada do documento: a conversão é em memória e o serviço não tem disco persistente. O arquivo vai com nome neutro (`certificado.docx`), para que nome de pessoa não chegue ao log do Cloud Run, que registra só a requisição (hora, status, duração) |
| O que fica aqui | O PDF convertido, no Storage do Supabase (`certificados-pdf/`, bucket privado, São Paulo), servido pela função depois do RBAC; é regenerável do congelado |
| Acesso | Autenticação básica com senha só do sistema (variável secreta no Netlify); sem ela o conversor recusa (401). TLS no caminho |
| Base legal | A do certificado (ROPA §2; para o CPF, §5.5.1): o conversor é meio de emitir o documento, não finalidade nova |
| Sem o conversor | Desligar é apagar `CSSO_CONVERSOR_PDF_URL` no Netlify: o certificado de modelo enviado volta a sair só em Word, e nada vai ao Google |

### 5.8 Inscrição pública por link (20/10/2026)

A CSSO pode ligar, por turma, um link (e o QR dele) em que qualquer pessoa,
sem conta, pede a vaga (`/inscricao/{token}`; `servicos/inscricao_publica.ts`).
É o canal da fatia 6 do desenho, com uma diferença: lá o pedido se confirmava
por e-mail; a nuvem não envia e-mail, e **quem confere cada pedido é a CSSO**.

| Item | Registro |
|---|---|
| Titulares | Servidores, terceirizados, discentes e visitantes que pedem vaga em treinamento — as mesmas categorias da inscrição interna |
| O que se coleta | Nome, vínculo, SIAPE (só servidor), organização e, opcional, e-mail; o **IP** de onde o pedido saiu. **Sem CPF**: o formulário não tem o campo e recusa o número digitado em outro |
| Finalidade e base legal | As da inscrição em treinamento (ROPA §2: execução de política pública e obrigação legal da NR — LGPD art. 7º, II e III, e art. 23). O IP serve só para apurar abuso do link (art. 7º, IX, legítimo interesse do controlador na segurança do canal). A página diz isso a quem pede, antes do envio, e exige a marcação de ciência |
| Trava contra pedido em nome alheio | O pedido nasce "a conferir" e **não ocupa vaga**; abre pendência do setor; só vira inscrição quando alguém com `turma.inscrever` o aceita (`conferida_por`, `conferida_em`). O SIAPE ou o e-mail digitados só ligam o pedido a um cadastro existente se o nome parecer o do cadastro (critério único de `servicos/duplicados.ts`, 23/10/2026); senão nasce um participante novo, e a conferência mostra à CSSO com quem ele parece ("parece com PTC-…", com o nome só para quem pode lê-lo — RN-19) |
| Sem oráculo | A resposta pública é sempre a mesma frase, mais uma linha igual para todos ("se você já tem cadastro, pode chegar uma mensagem no e-mail que usou antes"): de fora não se sabe se a pessoa já estava inscrita, se tem cadastro nem se o SIAPE existe. O tempo da resposta também não diz (piso de tempo constante, 23/10/2026). A recusa de dado é genérica e nunca repete dado do cadastro |
| Aviso de cadastro existente (23/10/2026) | Modelo "esqueci a senha": quando o pedido casa com um cadastro pelo e-mail + nome ou pelo SIAPE + nome, um aviso informativo vai **só ao e-mail que já está no cadastro** (nunca ao digitado), pela caixa de saída (§5.9), sem nome, SIAPE, IP, dado digitado nem turma; quem já estava na turma recebe "não precisa pedir de novo". Teto: 1 por destinatário em 24 h no caso do SIAPE (dado público), 3 no do e-mail; não sai quando o casamento é só pelo nome nem quando o e-mail está em mais de um cadastro sem confirmação. É medida de segurança e de transparência ao titular (LGPD art. 6º, III, IV e VI, e art. 46): avisa o dono do dado de que alguém o usou, **sem finalidade nova** |
| O link | Token de 192 bits mostrado uma vez; o banco guarda só o SHA-256. Para de funcionar no fim do dia de "inscrições até", quando a turma sai de "inscrições abertas", ou quando a CSSO o troca ou desliga. Página com `noindex`, `no-store` e `no-referrer` |
| Abuso | Limite de envios por IP **no banco** desde 23/10/2026 (`limite_login_ip`, chave `inscricao:<ip>`, apagada pela rotina noturna um dia depois — o IP é dado pessoal); limite de avisos por destinatário (contado na caixa de saída); teto de 200 pedidos em espera por turma; campo-armadilha para robô. Sem captcha, a menos que a trilha mostre abuso |

### 5.9 Envio de e-mail (20/10/2026)

| Item | Registro |
|---|---|
| O que sai | (a) O certificado, com o PDF (ou o Word) anexado, ao e-mail do próprio participante — pedido por quem tem `certificado.emitir`, um a um (ficha) ou os da turma (aba Emissão); (b) o aviso de "inscrição confirmada" ou "pedido não aceito" a quem pediu vaga pelo link público (§5.8) e deixou e-mail; (c) o aviso de reciclagem — certificado a vencer ou vencido —, um por certificado, marcado no monitor de reciclagem por quem tem `certificado.emitir` ou, se alguém com `treinamento.gerenciar` ligar o **aviso automático** (desligado de saída; a mudança fica na trilha), mandado pela varredura noturna no dia em que o certificado entra na janela de 30 dias. Nada sai sem um ato de alguém da CSSO: no automático, o ato é ligá-lo; (d) desde 23/10/2026, o aviso de cadastro existente do link público (§5.8), ao e-mail do cadastro, disparado pelo pedido de vaga |
| Para quem | Só o titular do dado, no endereço que ele ou a CSSO cadastrou. Sem cópia a terceiros |
| Validade (23/10/2026) | O aviso de cadastro existente vence em 24 h (`email_saida.expira_em`): com o envio desligado ou atrasado, ele sai da fila como cancelado, sem envio, em vez de chegar dias depois |
| O que leva | Nome, treinamento, turma, período, número e chave do certificado; no anexo, o certificado inteiro (com CPF, quando o modelo o exige — §5.5.1). O aviso de recusa **não** leva o motivo escrito na trilha |
| Base legal | A do certificado e da inscrição (ROPA §2): o e-mail é meio de entregar o documento ao titular, não finalidade nova |
| Onde fica | A caixa de saída (`email_saida`, Supabase, São Paulo): destinatário, assunto, texto, situação e o erro (sem dado pessoal). O anexo não fica: é montado na hora do envio |
| Provedor | SMTP configurado no Netlify (`PRODUCAO.md` §2.2). **Pendente**: escolher e registrar no §3 — o institucional, se o TI da UFVJM liberar, é o que não acrescenta operador |
| Desligar | Apagar `CSSO_SMTP_URL` no Netlify: os pedidos ficam na fila e nada sai |

### 5.10 Acesso do participante sem conta aos certificados (20/10/2026)

| Item | Registro |
|---|---|
| O que é | Em `/certificados/acesso` a pessoa digita o e-mail; se ele está no cadastro de algum participante com certificado emitido, o sistema envia (§5.9) um link que vale 2 horas e lista e baixa esses certificados (`servicos/acesso_participante.ts`) |
| Quem prova ser o titular | A posse da caixa de e-mail: o link só vai ao endereço que já está no cadastro, nunca a um digitado de novo |
| Sem oráculo | A resposta é sempre a mesma frase; de fora não se sabe se o e-mail existe nem se há certificado |
| Abuso | Até 3 links por hora por endereço; limite de pedidos por IP; o banco guarda só o SHA-256 do token |
| O que se guarda | E-mail normalizado, IP e horários do pedido do link, por 7 dias; a segunda via baixada entra na trilha do certificado como "pelo link de acesso do participante" (sem usuário) |
| Base legal | A do certificado (ROPA §2): é o titular recebendo o próprio documento (LGPD art. 18, II) |
| E-mail confirmado (23/10/2026) | Abrir o link prova a posse da caixa: o endereço do cadastro (o mesmo que recebeu o link) passa a confirmado (`participante_email.confirmado_em`), só quando leva a um cadastro só. Nenhum dado novo: só a data |
| Limite conhecido | Um e-mail ainda não confirmado pode estar em mais de um participante (duplicata a mesclar); o link mostra os certificados de todos eles. Quem recebe é sempre o dono da caixa — o risco é ver o certificado de um homônimo cadastrado por engano com o e-mail dele, e a correção é a mesclagem/limpeza do cadastro |
| Depende de | O envio de e-mail ligado (§5.9). Desligado, a página diz que o acesso está indisponível |

### 5.11 Correção de dados e junção de cadastros (20/10/2026)

| Item | Registro |
|---|---|
| Correção (LGPD art. 18, III) | O nome, o vínculo, a organização e o CPF do certificado do participante externo se corrigem na inscrição (`turma.inscrever`) ou na ficha do certificado. Na ficha, o certificado antigo é anulado e sai um substituto com número e chave novos (`certificado.anular` + `certificado.emitir`). O nome de servidor se corrige no cadastro de servidores |
| O que fica do dado antigo | O certificado anulado guarda o nome com que saiu (é o papel que circulou, e a validação pública passa a dizer "anulado, substituído por N/AAAA"). A trilha registra **que** o nome foi corrigido, nunca qual era (RN-19) |
| Junção de cadastros | `participante.mesclar`: inscrições, certificados e e-mails do cadastro duplicado passam para o que fica; o duplicado sai das listas, aponta para o que ficou e **perde o CPF** (minimização). Nada se apaga |
| Travas | Não se juntam dois servidores, cadastros com CPFs diferentes, nem dois inscritos na mesma turma |
| Registro da junção (23/10/2026) | Cada junção guarda o que moveu (`participante_mesclagem`: ids de inscrições, certificados e e-mails, campos herdados e se havia CPF — o booleano, nunca o número), para poder ser desfeita. "Não é a mesma pessoa" fica gravado como par (`participante_par_distinto`), só com os ids, quem decidiu e quando |
| Efeito no §5.10 | A junção resolve o limite conhecido do acesso por link: depois dela, o e-mail aponta para uma pessoa só |

### 5.12 Cadastre-se do terceirizado e do discente, e Esqueci minha senha (23/10/2026)

| Item | Registro |
|---|---|
| O que é | Em `/cadastre-se` ("Primeiro acesso / Cadastre-se" no login) a pessoa escolhe o vínculo. O servidor segue para o primeiro acesso pelo cadastro de servidores (§ "Ativar meu acesso"). Terceirizado e discente fazem um **pedido de conta** (`servicos/pedido_conta.ts`) |
| Dados do pedido | Nome, e-mail, empresa (terceirizado) ou curso (discente), setor ou matrícula (opcional), a declaração de ter 18 anos ou mais, a senha escolhida (só o hash argon2, nunca a senha) e o IP do pedido. CPF não entra (recusado na tela) |
| Senha escolhida no pedido (24/10/2026) | A pessoa escolhe a senha na tela; o pedido só vai à equipe depois de ela confirmar o e-mail num link (24 h, um botão: abrir o link não confirma). O hash da senha sai do pedido na decisão; o pedido não confirmado é apagado em 3 dias. No primeiro acesso do servidor vale o mesmo, e só para a conta a criar ou ainda sem senha: quem já tem senha recebe o link que pede a senha de novo. Depois de ativar por confirmação, sai um aviso ao e-mail ("se não foi você, use Esqueci minha senha") |
| Finalidade | A equipe conferir o vínculo e criar a conta, com que a pessoa se inscreve em treinamento, vê os certificados e comunica acidente. Pedido de EPI continua só de servidor |
| Quem confere | Quem cria conta (`usuario.criar_conta`), na fila "Pedidos de conta" de Usuários, avisada por pendência. **Nenhuma conta nasce do pedido sozinho**; aprovada, nasce sem senha, com o perfil do vínculo, nunca ligada a servidor, e o link de definir a senha (3 dias, uso único) vai ao e-mail do pedido |
| Quem prova ser o titular | A posse da caixa de e-mail: quem digitou o e-mail de outra pessoa não ganha acesso, porque o link vai ao dono. Discente só com e-mail institucional (@ufvjm.edu.br) |
| Menores de idade | Fora deste fluxo (LGPD art. 14): o pedido exige a declaração de 18 anos ou mais; menor procura a equipe |
| Sem oráculo | A tela responde a mesma frase a todo pedido, com piso de tempo; e-mail que já está no sistema (conta, servidor, pedido na fila) não abre pedido: o dono recebe uma mensagem neutra com o caminho certo |
| Abuso | 5 pedidos por hora por IP; o teto por destinatário dos e-mails de acesso |
| Recusa | A pessoa recebe um aviso neutro, **sem o motivo**; o motivo fica no pedido, para a equipe, até o expurgo |
| Liberação automática (24/10/2026) | Por decisão da coordenação, a conta é liberada assim que a pessoa confirma o e-mail, sem a conferência prévia da equipe. A posse do e-mail continua provada pelo link; o vínculo declarado (empresa, curso) não é conferido antes. Quem cria conta bloqueia, desbloqueia ou exclui depois, em "Contas do Cadastre-se". Excluir apaga a conta sem registros (perfil, sessões e a própria conta, com um evento só com o número); a que já tem registros é bloqueada, e os registros ficam pela política deles |
| Esqueci minha senha | `/esqueci-senha`, só com o e-mail, para qualquer conta: o link (1 h, uso único) vai ao e-mail **da conta**. Conta inativa e de administração recebem o aviso neutro de "procure a equipe" |
| Troca do e-mail em Meus dados | O endereço novo só vale depois que o link enviado a ele (24 h) é aberto pela própria conta |
| Trilha | Número do pedido e vínculo; nunca nome nem e-mail |
| Retenção | O pedido (qualquer situação) é apagado 90 dias depois de feito; a conta criada segue a política das contas |
| Base legal | Execução de política pública e obrigação de SST da UFVJM em relação a quem trabalha ou estuda nela (como §4); depende da autorização do §7 |

### 5.13 Avaliação de reação do treinamento (24/10/2026)

| Item | Registro |
|---|---|
| O que é | A pesquisa de satisfação do fim da turma (`servicos/avaliacao_reacao.ts`): seis notas de 1 a 5 e um comentário opcional, respondida por quem frequentou, pela conta (Meus treinamentos) ou por um link de uso único enviado por e-mail na conclusão da turma (§5.9) |
| Dado pessoal novo | Nenhum na resposta: ela é **anônima por construção** — só turma, versão do questionário, notas, comentário e o dia, sem ligação com inscrição, participante ou conta, com chave sorteada. Na inscrição fica só o fato "já respondeu" (sem hora). O convite guarda a inscrição e o SHA-256 do token até o fim do prazo |
| Comentário | Texto livre opcional, até 1000 caracteres; recusa CPF e termo de saúde (RN-21). A tela pede que não se escrevam nomes; quem escreve pode, mesmo assim, se identificar no texto — é a única porta para dado pessoal, e é escolha do titular |
| Quem lê | Só quem opera turmas (`turma.criar`, `turma.inscrever`, `turma.avaliar`, `turma.concluir`), no escopo e no setor; **piso de 3 respostas** por turma (e por linha do consolidado) antes de qualquer média ou comentário; comentários em ordem embaralhada |
| Trilha | "A turma recebeu uma avaliação de reação", sem conta e sem IP; e quantos convites saíram, sem endereço |
| Base legal | Execução de política pública de capacitação em SST (como §4): avaliar o treinamento para melhorá-lo; responder é voluntário |
| Retenção | Resposta: a da turma (sai com ela e com a limpeza do módulo). Convite: até o fim do prazo da avaliação (60 dias após o fim da turma), apagado pela rotina noturna; o texto do e-mail, como os demais (§5.9) |

## 6. Retenção — o que a nuvem acrescenta à política

| Conjunto | Prazo | Mecanismo |
|---|---|---|
| `registro_acesso` | 90 dias (`CSSO_LOG_RETENCAO_DIAS`) | Rotina noturna (`EXPURGO_PRIVACIDADE`) |
| `limite_login_ip` (IP e contagem de falhas de login, tabela nova da migração 0003) | 1 dia | `autenticacao.expurgar_limites_ip` |
| `exportacoes/` (zip em claro) | 24 h | Rotina noturna (`EXPURGO_PRIVACIDADE`) |
| `backups/` | 90 dias + 1 mensal por 5 anos | Rotina de retenção de backup |
| `entrada/` (cópia da planilha/JSON importados) | Até o encerramento da migração, como `stg_*` (POLITICA §2.1) | **Manual**: apagar no painel do Storage ao encerrar a migração |
| `documentos/` (.docx gerados) | Regeneráveis do contexto congelado; sem prazo próprio | — |
| `certificados-pdf/` (PDF do conversor, §5.7) | Regeneráveis do contexto congelado; sem prazo próprio | — |
| Documento no conversor do Google (§5.7) | Nenhum: descartado ao fim da conversão | O serviço não grava; log só da requisição, sem dado pessoal |
| IP do pedido pelo link público (§5.8) | 90 dias do pedido | Rotina noturna (`EXPURGO_PRIVACIDADE`, `expurgar_ip_de_inscricao`) |
| Participante e pedido recusado pelo link (§5.8) | Os da inscrição (POLITICA §2) | O pedido recusado fica cancelado com o motivo, como a inscrição interna |
| Texto do e-mail na caixa de saída (§5.9) | 90 dias do pedido (enviado, falhado ou cancelado) | Rotina noturna (`EXPURGO_PRIVACIDADE`, `email.expurgar_corpos`); a linha fica sem o texto, como registro do envio |
| Pedido de link de acesso do participante (§5.10): e-mail, IP, horários | 7 dias | Rotina noturna (`EXPURGO_PRIVACIDADE`, `acesso_participante.expurgar`) |
| Pedido de conta do Cadastre-se (§5.12): nome, e-mail, empresa ou curso, matrícula, IP, motivo da recusa | 90 dias do pedido | Rotina noturna (`EXPURGO_PRIVACIDADE`, `pedido_conta.expurgar`) |
| Convite da avaliação de reação (§5.13): inscrição e hash do token | Até o fim do prazo da avaliação (60 dias após o fim da turma) | Rotina noturna (`EXPURGO_PRIVACIDADE`, `avaliacao_reacao.expurgar_convites`) |
| CPF do certificado (§5.5.1) | Enquanto houver certificado que o exija; apagável pela tela | Manual (auditado) |
| Logs da função no Netlify | Prazo do plano do Netlify | Fora do controle do setor; por isso nada pessoal vai para lá |

## 7. O que falta providenciar (responsável: controlador)

1. **Autorização formal da UFVJM** para hospedar o sistema em nuvem de
   terceiro, com os dados reais — antes, e não depois, de ampliar o uso.
2. **Indicação e ciência do encarregado (DPO)**, com esta emenda e o ROPA —
   inclusive do CPF guardado para o certificado de brigadista (§5.5.1).
3. **Instrumento com os operadores** (art. 39): aceitar/firmar os DPAs do
   Supabase, do Netlify e do Google Cloud (§5.7) **em nome de quem contrata**, e resolver quem contrata
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
9. **Escolher o provedor de SMTP** (§5.9) e registrá-lo no §3, com o
   instrumento dele, antes de configurar o envio de e-mail.
10. **Divulgar o canal do titular** (e-mail do setor) onde o servidor o encontre
   (ROPA §7).
