# ROPA — Registro das Operações de Tratamento de Dados Pessoais

**Sistema:** Sistema de Gestão da CSSO/Sisa — módulos Adicional Ocupacional,
Certificados e Treinamentos, e Gestão de EPI (ver §0)
**Controlador:** Universidade Federal dos Vales do Jequitinhonha e Mucuri (UFVJM)
**Unidade responsável pelo tratamento:** Coordenadoria de Segurança e Saúde
Ocupacional (CSSO), da Superintendência Integrada de Saúde (Sisa)
**Contato do setor:** `csso.sisa@ufvjm.edu.br`
**Encarregado (DPO):** indicar o encarregado institucional da UFVJM — pendente
(ver `PENDENCIAS.md`)
**Versão deste registro:** 1.6, de 04/09/2026 — o titular alcança o que é dele, e
a validação de certificado por chave passou a existir, pública e sem nome (§0.5) ·
revisar a cada mudança de finalidade, de categoria de dado ou de local de
armazenamento.

---

## 0. Emenda de 13/08/2026 — os módulos novos

Até a versão 1.0 este registro descrevia um sistema que só fazia adicional
ocupacional. Isso deixou de ser verdade hoje, 13/08/2026, quando a primeira
fatia do módulo **Certificados e Treinamentos** entrou em produção (v1.8.0), e
vai deixar de ser mais duas vezes: **Gestão de EPI** e **Acidentes em Serviço
(CAT/SP)** estão desenhados e vêm atrás.

Emendar antes de o módulo subir é método, não zelo. Um registro que descreve o
futuro como presente é pior que um registro desatualizado, porque o
desatualizado se percebe. Daí a convenção que vale do §1 em diante:

> **O que não traz marca é vigente hoje.** O que traz **(previsto)** ainda não
> existe em código: passa a valer **a partir de** a fatia correspondente entrar
> em produção, e até lá o sistema **não faz aquilo**. Cada trecho previsto diz
> qual módulo o traz.

Adiantando as duas dúvidas que aparecem primeiro:

- **Hoje o sistema não trata nenhum dado de saúde.** Nem CID, nem diagnóstico,
  nem parte do corpo, nem afastamento. O §4.4 descreve o que passará a ser
  tratado quando o módulo de Acidentes chegar, e o que continua fora dele para
  sempre.
- **Hoje não há operador terceirizado nem transferência internacional.** O §5
  transforma isso de constatação em condição.

### 0.1 Emenda de 18/08/2026 — a ficha de EPI

O que era previsto virou vigente em parte. Duas fatias do módulo **Gestão de
EPI** entraram em produção: o catálogo (v1.20.0, 18/08/2026) e **a ficha de
EPI** — o registro nominal da entrega, com o comprovante assinado anexado.

Três coisas mudam neste registro, e uma delas é nova:

1. **A finalidade "controle de fornecimento de EPI" deixa de ser prevista**
   (§1.2). O sistema passa a tratar item entregue, CA, lote e data de entrega,
   nominalmente, por servidor.
2. **Nenhuma categoria de titular é acrescentada.** As decisões 3 e 7 fixaram
   que a UFVJM não fornece EPI a terceirizado, nem a estudante, nem a bolsista:
   o módulo atende só servidor com SIAPE. Isso continua exatamente como o §3 já
   dizia — e a recusa fundamentada, que agora existe em código, é o que deixa
   rastro contável de quantas vezes o caso aparece.
3. **O comprovante assinado é dado novo** (decisão 8, 18/08/2026): o PDF
   digitalizado do papel que o servidor assinou, guardado como
   `Anexo(categoria='FICHA_EPI', assinado=True)`, com SHA-256, nascendo
   `RESTRITO`. É a primeira vez que este sistema guarda a **assinatura do
   próprio titular** — o parecer é assinado pelo técnico, e a rubrica do
   instrutor é de quem ministra, não de quem é avaliado. O §4.3 e o §6 passam a
   dizer isso.

E uma consequência que não é de dado, é de processo, e está registrada como
pendência no §9, item 8: **a partir de agora a ficha existe, e vai ser pedida**
— por PROGEP, pela procuradoria, eventualmente pela Justiça do Trabalho. O §5
ganhou a linha; quem responde e por qual canal é decisão do setor.

O que **continua previsto** no módulo: a tela de estoque, a requisição com
protocolo e análise, e a ligação com o adicional ocupacional.

### 0.2 Emenda de 20/08/2026 — a requisição, a reserva e a consulta do parecer

O que o §0.1 deixou como previsto virou vigente: as fatias 4, 5 e 6 do módulo
**Gestão de EPI** entraram em produção (v1.23.0 a v1.25.0). O pedido de EPI passa
a existir no sistema com protocolo, decisão item a item e reserva de lote, e o
parecer técnico passa a **consultar a ficha de EPI** para avaliar neutralização.

Três coisas mudam neste registro:

1. **Uma categoria de dado é nova, e é a que merece atenção**: a rotina de
   trabalho e os riscos alegados **pelo próprio requerente**, em texto livre. É a
   única parte do módulo escrita pelo titular sobre si mesmo, e é justamente onde
   dado de saúde entra por engano. A proteção é técnica — o filtro da RN-21 —, e
   não um aviso no rodapé do formulário. Detalhes no §1.2.1 e no §4.3.
2. **Nenhuma categoria de titular é acrescentada.** Continua só servidor com
   SIAPE, pelas decisões 3 e 7.
3. **Um uso novo de dado que já existia**: a ficha de EPI passa a ser lida dentro
   do fluxo do adicional ocupacional, e o resultado dessa leitura fica congelado
   no parecer emitido. É uso compatível com a finalidade — a IN 15/2022 exige a
   avaliação —, e continua sob o registro de acesso do §6.

Uma negativa vale registro, porque é escolha de arquitetura e não acaso: **o
módulo de EPI não escreve em `adicional_vigencia`**. Nenhuma entrega, nenhuma
recusa e nenhuma reserva altera o direito de alguém — a decisão continua com quem
subscreve laudo e assina parecer. A restrição é verificada por teste automático,
não confiada à disciplina de quem programa.

---

### 0.3 Emenda de 23/08/2026 — a rede do setor e o registro de acesso

O sistema deixou de atender só a máquina em que roda e passou a atender as
estações da CSSO/Sisa. **O dado não mudou de lugar** — mesmo disco, mesma
máquina, mesmo controlador —, e por isso não há operador novo, nem transferência,
nem base legal nova. O que mudou foi **quem alcança**, e isso traz três coisas:

1. **Categoria de dado nova: o registro de acesso.** `dados/logs/acesso.log`
   guarda endereço de origem, identificador da conta, rota, horário, resposta e
   duração — por **90 dias**, o mesmo prazo de `sessao`, e pelo mesmo motivo (o
   IP). Base legal: art. 7º, II, e o próprio art. 37, que é o que este registro
   existe para tornar possível — sem ele não há como responder "quem acessou o
   quê" diante de um incidente.
   **O que ele deliberadamente não guarda:** nome, SIAPE, conteúdo de parecer,
   query string, corpo de requisição, nem o `login` (que é `nome.sobrenome`). O
   caminho vai na **forma** da rota, `/servidores/{servidor_id}`, e nunca
   `/servidores/12` — o par (IP, 12) num arquivo de texto é exatamente o
   cruzamento que a supressão de identificação existe para impedir. URL que não
   casa rota nenhuma sai como `-`, porque é texto escrito por quem chamou.
2. **A conexão não é criptografada.** Enquanto não houver TLS, senha e sessão
   viajam em claro na rede do setor. Está registrado como decisão, avisado na tela
   e listado como dívida em `entrada/implantacao/00_PRONTIDAO.md` (T-1).
3. **O acesso a anexo passou a ser registrado sempre**, e não só quando o anexo
   era marcado restrito — ver §6. A trilha ganhou `ANEXO_BAIXADO`, que responde
   qual arquivo saiu, e o registro do comprovante de EPI deixou de sair com o
   titular em branco.

Uma negativa que vale registro: **ir para servidor institucional ou para a
internet é outra emenda**, não esta. A seção (c) de `00_PRONTIDAO.md` diz por que
a internet aberta muda o perfil de risco do sistema inteiro, e a recomendação
técnica, se um dia houver validação pública de certificado, é publicar **um
serviço separado** em vez de abrir este.

---

### 0.4 Emenda de 03/09/2026 — as demandas que chegam por fora do SEI

Entrou em produção a funcionalidade de **Demandas**, na base compartilhada do
sistema (ao lado de Pendências, e não dentro de módulo nenhum). Ela registra o
pedido que chega **por e-mail ou presencialmente** e que ainda não virou — ou
nunca vai virar — processo SEI: quem pediu, por onde, o quê, o que se
encaminhou, e como aquilo terminou.

O que muda neste registro:

1. **Uma categoria de dado é nova, e é a que exige atenção**: a identificação de
   **quem demanda**, em texto livre, mais o texto do pedido e o canal por onde
   ele chegou. É a segunda parte do sistema escrita em texto corrido sobre uma
   pessoa (a primeira foi a rotina de trabalho da requisição de EPI, §1.2.1), e é
   a mais exposta das duas: ela é digitada com pressa, no balcão, por quem acabou
   de ouvir a pessoa falar. Detalhes no §4.6.
2. **Uma categoria de titular é nova**: quem demanda **pode não ser servidor**.
   Chefia de unidade já estava no §3; o que passa a existir é o registro de um
   pedido feito por alguém de fora da universidade ou de outro órgão. Ver §3.
3. **Nenhuma base legal nova.** O tratamento é o do art. 7º, II: atender pedido
   dirigido ao setor é a atividade-meio que a CSSO exerce por competência
   regimental, e o registro é o que permite responder — e provar que se
   respondeu. Ver §2.

**A negativa de sempre, e aqui ela é a proteção principal.** Não há CPF, CID,
diagnóstico, atestado, gestação nem qualquer dado de saúde em coluna nenhuma
destas duas tabelas, e **todo campo de texto livre passa pelo filtro da RN-21
antes de gravar** — a descrição da demanda, o que foi pedido no encaminhamento e
o motivo do desfecho. A recusa devolve o formulário com o texto intacto, de
propósito: recusa que apaga o que a pessoa escreveu ensina a escrever menos, e
não a escrever melhor. O filtro nunca foi o único controle — o acesso é
restrito por permissão e a leitura nominal segue a supressão da RN-19 —, mas
neste campo ele é o que está entre o balcão e o banco.

**Uma negativa de arquitetura, que vale registro:** a demanda **não escreve em
`processo`**. Encerrá-la como "virou processo" apenas APONTA para um processo
que já existe (chave estrangeira para `processo.id`); não cria processo, não
consome NUP e não muda estado de processo nenhum. Sem isso, um encerramento de
demanda no balcão poderia autuar processo SEI sem tipo, sem etapa e sem os
avisos da RN-10.

---

### 0.5 Emenda de 04/09/2026 — o servidor comum, e a validação de certificado

Duas mudanças, e a segunda contraria uma recomendação registrada no §0.3 — o que
obriga a dizê-lo por escrito, e não a deixar passar.

**1. O titular passou a alcançar o que é dele.** O próprio certificado e a própria
ficha de EPI ganharam porta (`/certificados/meus`, `/epis/fichas/minha`). **Não há
dado novo, nem finalidade nova, nem titular novo** — é o exercício do art. 18, II
sobre dado que este registro já descreve. A permissão de ler o certificado **dos
outros** não foi concedida a ninguém: a regra é "tem a permissão, **ou** é o
titular", como a ficha de EPI já fazia. Ler o próprio dado **não** gera linha em
`acesso_dado_sensivel`, pela decisão da 1.35.0; ler de terceiro gera.

**2. A validação de certificado por chave existe, e é pública.** `GET /validar` e
`/validar/{chave}` respondem **sem sessão**.

- **Ela não expõe o nome de quem se formou.** Conferido: com a chave real, o corpo
  traz treinamento, norma de referência, carga horária, término, vencimento,
  instrutor, emissor e o **código opaco** do participante — e nem o nome nem o
  SIAPE aparecem. Quem tem o papel confere digitando o nome e recebe apenas
  *confere / não confere*. Quem só tem a chave não recebe identificação nenhuma.
- Chave inexistente, malformada e com dígito verificador errado respondem igual —
  a página não é oráculo de existência.
- Limite por endereço de origem, `noindex`, `no-store`, sem listagem e sem busca
  por nome.

**A recomendação do §0.3 NÃO está revogada.** Ela dizia que, havendo validação
pública, o certo é publicar **um serviço separado** em vez de abrir este sistema —
e ela continua valendo, com uma diferença de momento:

- **Hoje** a rota não muda exposição nenhuma: o sistema só é alcançável pela rede
  do setor, e ela é alcançável de onde todas as outras já são. O que a rota
  conserta é concreto — a URL é **impressa em todo certificado emitido**, e até
  hoje respondia 404. Cada documento que já circulou carrega um endereço quebrado.
- **No dia em que o certificado precisar ser validado de fora da UFVJM**, a
  recomendação do §0.3 é a que vale: o que se publica é a validação, não o sistema.
  A rota foi construída para tornar isso barato — é leitura pura, sem nome, sem
  listagem e sem dependência do resto —, mas **extrair não é o mesmo que já estar
  extraído**, e a decisão continua sendo institucional.

---

## 1. Finalidade

Instruir, decidir e documentar os processos administrativos de **adicionais
ocupacionais** (insalubridade, periculosidade, irradiação ionizante e
gratificação por raios X) dos servidores da UFVJM: caracterizar a exposição a
agentes nocivos, emitir laudo técnico e parecer técnico, e informar à
Pró-Reitoria de Gestão de Pessoas para concessão, revisão ou cessação do direito.

Este sistema é **apoio interno da CSSO**. O processo oficial é o SEI.

### 1.1 Capacitação em SST — Certificados e Treinamentos

Registrar o catálogo dos treinamentos de segurança e saúde no trabalho que a
CSSO ministra, o modelo do certificado que sai no fim e quem o assina;
**(previsto)** conduzir a turma, registrar presença e nota, emitir o certificado
e controlar a reciclagem obrigatória — quem venceu, quem vence e quem nunca fez.

O que existe hoje, da fatia 1, são três coisas: `treinamento` (o que se ensina,
com carga horária e prazo de reciclagem), `certificado_modelo` com o dicionário
de tags (o layout do papel e qual dado alimenta qual marcador) e
`assinatura_instrutor` (quem assina). **Não existem ainda** turma, inscrição,
participante, presença nem certificado emitido — e, portanto, **não há nenhum
participante de treinamento no sistema**, nem interno nem externo. Também não há
inscrição pública, nem página pública de validação, nem envio de e-mail.

### 1.2 Controle de fornecimento de EPI

Registrar o catálogo de EPI com CA e validade, e a **ficha de EPI** — a prova de
que o equipamento foi entregue a um servidor determinado, em data determinada,
com o CA e o lote congelados no ato e o comprovante assinado por ele anexado.

**Vigente desde 18/08/2026.** O que existe hoje: o catálogo (item, categoria da
NR-6, CA e validade, quantidade padrão e máxima), o catálogo de motivos de
recusa, a ficha nominal de entrega e o comprovante assinado. A negativa
fundamentada de fornecimento a quem não é servidor também é registrada, na
trilha de auditoria, com o texto da norma congelado no ato.

**Também vigente desde 20/08/2026** (v1.23.0 a v1.25.0): a tela de estoque com
entrada por pregão e empenho, a requisição com protocolo e análise item a item,
a reserva de lote, e a consulta que o parecer técnico faz para avaliar se o EPI
neutraliza o agente nocivo. O que cada uma acrescenta está no §1.2.1.

**(previsto)** — no mesmo módulo, e ainda não existe: os indicadores agregados
com supressão estatística, e a exportação.

### 1.2.1 O que a requisição acrescenta (desde 20/08/2026)

O pedido de EPI passa a existir no sistema com protocolo, e com ele três coisas
que a ficha sozinha não trazia:

- **A declaração do próprio requerente sobre o trabalho dele** — rotina de
  trabalho e riscos alegados, em texto livre. É a única parte do módulo escrita
  pelo titular sobre si mesmo, e é onde o risco de dado sensível por engano mora:
  é exatamente o campo em que alguém escreve "tenho problema de coluna" ou
  "estou grávida e não posso pegar peso". Por isso passa pelo filtro da RN-21
  (`textos.exigir_texto_limpo`), como os demais textos livres do módulo — a
  proteção é técnica, não uma instrução no rodapé do formulário.
- **A decisão sobre o pedido, item a item**, com o motivo da recusa e o texto da
  norma congelado no ato, e o nome de quem decidiu. É registro funcional de
  pedido e decisão administrativa, na mesma classe da linha `Processo`.
- **O contexto de lotação congelado no envio**: unidade, campus, posto, cargo e
  função como estavam naquele dia. Nenhuma categoria de dado nova — é o mesmo
  conjunto que a ficha já congelava, agora também no pedido.

**Nenhuma categoria de titular é acrescentada.** Continua só servidor com SIAPE.
A negativa a quem não é servidor agora sai catalogada e contável, e continua sem
nomear quem não está no cadastro.

Sobre a **reserva de lote**: não trata dado pessoal novo. É a promessa de um
lote a um pedido — quantidade e lote, ligados ao pedido que já existe.

Sobre a **consulta que o parecer faz** (`entregas_ate`): não cria dado, e é
leitura. O que ela acrescenta a este registro é que a ficha de EPI de um servidor
passa a ser **lida dentro do fluxo do adicional ocupacional**, por quem edita o
parecer, e que o resultado dessa leitura é **congelado no parecer emitido**
(`contexto_congelado["epi"]`) como prova do que sustentou a conclusão. É uso
compatível com a finalidade — a IN 15/2022 exige avaliar se o EPI neutraliza o
agente nocivo —, e o §6 vale: ler ficha de outra pessoa continua registrado.

### 1.3 (previsto) Apuração de acidente em serviço

Registrar a comunicação de acidente em serviço no prazo do art. 214 da Lei
8.112/90, emitir a **CAT/SP** — Comunicação de Acidente em Serviço do Serviço
Público Federal, que não se confunde com a CAT do RGPS da Lei 8.213 —, produzir
a investigação técnica que instrui a perícia oficial em saúde, e prevenir a
repetição.

O nexo causal **não é conclusão deste sistema**. Quem o estabelece é a perícia
oficial em saúde (SIASS); a CSSO instrui, e registra o que a perícia decidiu.
Isso importa para este registro porque delimita a finalidade: o sistema não
produz juízo sobre a saúde de ninguém.

## 2. Base legal do tratamento (LGPD)

| Dado | Base legal | Norma |
|---|---|---|
| Dados funcionais (nome, SIAPE, cargo, função, lotação, posto) | Art. 7º, II — cumprimento de obrigação legal e regulatória pelo controlador | Lei 8.112/90, arts. 68-70; Lei 8.270/91, art. 12; IN SGP/SEDGG/ME 15/2022; Decreto 97.458/89 |
| Dados de exposição a agente nocivo | Art. 7º, II e art. 11, II, "a" e "b" — obrigação legal e tutela da saúde em procedimento realizado por profissionais da área da saúde/segurança do trabalho | IN 15/2022, arts. 4º a 17 |
| Registros de acesso e auditoria | Art. 7º, II e art. 37 — o controlador deve manter registro das operações | LGPD art. 37 |
| Dados do instrutor de treinamento (nome, título, conselho e registro profissional, organização, rubrica) | Art. 7º, II — obrigação legal e regulatória | A norma é declarada treinamento a treinamento em `treinamento.norma_referencia`; a âncora normativa geral da capacitação no regime estatutário está **pendente** (§9, item 1) |
| (previsto) Dados de participante de treinamento, inclusive externo (nome, e-mail, organização, matrícula externa, IP da inscrição pública) | Art. 7º, II | Mesma âncora e mesma pendência da linha acima |
| Fornecimento de EPI (item entregue, CA, lote, data) e o **comprovante assinado** pelo servidor | Art. 7º, II — cumprimento de obrigação legal e regulatória pelo controlador | NR-6; Lei 8.112/90, art. 68 e ss.; IN 15/2022 — **citação a confirmar** (§9, item 1) |
| (previsto) Acidente em serviço — dados não sensíveis | Art. 7º, II | Lei 8.112/90, arts. 212 a 214 |
| (previsto) Acidente em serviço — **dado de saúde** | Art. 11, II, "a", "d" e "f" | Detalhado no §4.4, que é onde esta linha se justifica campo a campo |
| Demanda recebida por e-mail ou presencialmente (identificação de quem pediu, canal, texto do pedido, encaminhamentos e desfecho) | Art. 7º, II — obrigação legal e regulatória, e o próprio art. 37 quanto ao registro | Competência regimental da CSSO/Sisa (Resolução Consu UFVJM 11/2026, art. 20); Lei 9.784/99, arts. 48 e 49 — o dever de decidir e de responder ao que é dirigido à Administração |

Não há tratamento fundado em consentimento: a atividade é vinculada e decorre de
obrigação legal. Isso vale com força redobrada para o dado de saúde do §4.4 —
consentimento seria a base **errada** ali, porque há desequilíbrio entre o
servidor acidentado e a Administração, o que fragiliza a livre manifestação, e
porque consentimento revogável não combina com documento que constitui prova
legal.

## 3. Categorias de titulares

- Servidores públicos federais lotados na UFVJM que requerem, mantêm ou têm
  revisto adicional ocupacional.
- Chefias de unidade que emitem portaria de localização e coassinam o formulário
  do art. 17.
- Servidores da CSSO/Sisa e usuários do sistema (dados de conta e auditoria).

Acrescentadas pela emenda de 13/08/2026:

- **Instrutor de treinamento externo à UFVJM** — **vigente desde 13/08/2026**.
  É a categoria que a fatia 1 já criou e a que passa mais despercebida, porque
  ninguém a procura: `assinatura_instrutor` aceita instrutor sem SIAPE, e dele
  guarda nome, título, conselho e registro profissional, organização de origem e
  vigência. Do instrutor interno nada disso se copia — nome e vínculo continuam
  sendo lidos do cadastro de servidor.
- **(previsto — Certificados, fatia 2) Participante externo de treinamento** —
  terceirizado, discente, visitante ou outro, que não é servidor da UFVJM e não
  tem conta no sistema. Identificado por e-mail confirmado e por um
  identificador público interno, **nunca por CPF**.
- **(previsto — Acidentes) Acidentado que não é servidor** — empregado de
  empresa contratada, estudante, bolsista, residente, visitante. A UFVJM é
  controladora nesta operação ainda que não seja empregadora: acidente com
  terceirizado no campus acontece, e o registro é a única forma de a
  universidade saber que aconteceu.
- **(previsto — Acidentes) Comunicante e testemunha** — terceiros cujos dados
  entram no registro sem que peçam, por terem comunicado ou presenciado o
  acidente. Base legal pendente (§9, item 5).

Acrescentada pela emenda de 03/09/2026:

- **Quem demanda, e não é servidor** — **vigente desde 03/09/2026**. A demanda
  registra quem pediu em **texto livre obrigatório**, e o vínculo com o cadastro
  de servidor é opcional, justamente porque metade dos pedidos vem de quem não
  está lá: chefia de outra unidade, colega de outro órgão, empregado de empresa
  contratada que aparece no balcão, familiar de servidor. Do não-servidor o
  sistema guarda **só o que a pessoa disse ser** — o nome, ou a descrição do
  cargo ou do setor —, nunca CPF, documento, endereço ou telefone. Exigir
  cadastro para poder anotar o pedido seria o atrito que devolveria a demanda ao
  post-it; guardar mais do que o nome seria abrir um cadastro paralelo de
  terceiros, que é exatamente o que as decisões 3 e 7 recusaram no EPI.

**O módulo de EPI não acrescenta categoria de titular nenhuma.** As decisões 3 e
7 fixaram que a UFVJM não fornece EPI a terceirizado, nem a estudante, nem a
bolsista: o módulo atende **só servidor com SIAPE**, e o pedido de quem não é
servidor é recusado com motivo fundamentado, ficando a recusa na trilha de
auditoria. Não é descuido de redação, é o desenho — e, se a política mudar, esta
linha muda junto com ela, e não antes.

## 4. Categorias de dados tratados

### 4.1 Adicional ocupacional, conta e auditoria

**Tratados:**
nome; matrícula SIAPE; cargo; função; unidade de lotação (UORG); posto de
trabalho; número do processo (NUP); portaria de localização; agente nocivo;
tipo de risco; percentual; tempo/percentual de jornada exposta; datas do
processo; número e ano do parecer; número do laudo; e-mail institucional;
endereço IP e user agent das sessões (segurança).

### 4.2 Certificados e Treinamentos — o que a fatia 1 de fato trata

**Tratados desde 13/08/2026:** nome do instrutor; título; conselho profissional
e número de registro; organização de origem, quando externo; período de vigência
da assinatura; vínculo com o cadastro de servidor, quando interno; e o
identificador do usuário que criou cada modelo de certificado.

O catálogo em si — nome do treinamento, carga horária, conteúdo programático,
validade da reciclagem — **não é dado pessoal**, e o dicionário de tags também
não: ele diz qual marcador do `.docx` recebe qual campo do sistema, o que é
metadado de layout, não dado de pessoa alguma.

**Ainda não tratados, porque não existem:** participante (interno ou externo),
e-mail de participante, inscrição, presença, nota, certificado emitido, endereço
IP de inscrição pública. A coluna da rubrica do instrutor existe no modelo, mas
**não há upload implementado**, então nenhuma imagem de assinatura está
guardada. Quando cada um deles nascer, esta seção cresce antes, não depois.

### 4.3 EPI (vigente) e Acidentes (previsto) — dados não sensíveis

#### Gestão de EPI — o que a ficha de fato trata

**Tratados desde 18/08/2026**, e o titular é sempre servidor identificado por
SIAPE, como no adicional:

- **Congelados na linha da ficha**, porque descrevem a entrega como ela foi:
  nome e SIAPE do servidor, cargo, unidade e posto de trabalho **na data da
  entrega**; nome do EPI, categoria da NR-6, número e validade do CA,
  fabricante, lote e tamanho; quantidade, data do evento e previsão de troca.
- **Da compra pública**, no contexto congelado da mesma linha: pregão, item do
  pregão, empenho, nota fiscal e fornecedor. Não é dado pessoal — é
  rastreabilidade de contrato —, mas viaja junto da linha nominal e por isso
  fica declarado aqui.
- **Quem entregou**: o identificador e o nome do usuário que registrou a
  entrega, também congelado, porque é o nome que sai no papel assinado.
- **O comprovante assinado**: o PDF digitalizado do papel, com a **assinatura
  manuscrita do próprio servidor**, guardado como `Anexo` da categoria
  `FICHA_EPI`, com SHA-256, nascendo `RESTRITO`. É dado pessoal e é o item mais
  sensível do módulo — a assinatura é biométrica comportamental, e por isso ele
  não é público nem se baixa sem registro de acesso (§6).
- **A recusa fundamentada**, na trilha de auditoria: o código e o texto do
  motivo, a unidade e a descrição de a quem a negativa se dirigiu. **Sem nome de
  pessoa que não esteja no cadastro** — descreve-se o pedido, não o indivíduo,
  justamente porque quem não é servidor não tem por que entrar neste sistema.

**Acrescentados em 20/08/2026, com a requisição** (§1.2.1): a rotina de trabalho
e os riscos alegados **pelo próprio requerente**, em texto livre filtrado pela
RN-21; a decisão item a item com o motivo congelado e o nome de quem decidiu; e o
contexto de lotação congelado no envio do pedido — que é o mesmo conjunto de
campos que a ficha já congelava.

**Não tratados, porque não existem:** qualquer identificação de terceirizado,
estudante ou bolsista.

#### (previsto — Acidentes) Dados não sensíveis do acidente

**Acidentes:** nome e identificação externa do acidentado quando não for
servidor (matrícula de estudante, matrícula na contratada, crachá de visitante
— **nunca CPF e nunca documento de identidade**); ocupação; contato para a
investigação; empresa contratada e fiscal do contrato; data, hora e local do
evento; espécie e consequência; nome e contato de comunicante e de testemunha;
relato de entrevista. Sem sexo e sem data de nascimento: num universo de dezenas
de casos por ano, qualquer recorte por sexo e idade reidentifica.

### 4.4 (previsto — Acidentes) Dado de saúde: o que entra e o que fica fora

Esta é a mudança mais séria da emenda, e é a razão de a convenção do §0 existir.

**Hoje, 13/08/2026, a CSSO não trata nenhum dado de saúde neste sistema.** O que
segue passa a valer **a partir de** a fatia do módulo de Acidentes que cria a
tabela `acidente_saude` entrar em produção, e nada antes disso.

**O que passará a ser tratado**, e só isto:

| Nível | Campos | Quem vê |
|---|---|---|
| **1 — a lesão, em categoria fechada** | parte do corpo e natureza da lesão, **escolhidas de catálogo, nunca digitadas**; lateralidade; e os fatos administrativos: houve atendimento médico, houve afastamento, houve internação, houve óbito, houve sequela permanente | `acidente.saude_ver` |
| **2 — a medida do afastamento** | dias de afastamento, data de início e de retorno, dias de internação, data do óbito, dias debitados, quem prestou o primeiro socorro e em que unidade | `acidente.saude_detalhe_ver` |

**O que continua fora, para sempre e em todos os módulos: nunca CID, nunca
diagnóstico, nunca texto clínico livre, nunca fotografia de lesão.** Não é
omissão de desenho, é a decisão 5 do coordenador. Não haverá coluna de CID a
preencher nem campo de texto clínico a preencher; a evidência fotográfica de um
acidente documenta o local, o equipamento e a condição, não o corpo de quem se
acidentou.

**Base legal — art. 11, II, alíneas "a", "d" e "f" da LGPD:**

- **"a"**, cumprimento de obrigação legal pelo controlador: a Lei 8.112/90,
  arts. 212 a 214, obriga a Administração a apurar o acidente em serviço e a
  comunicá-lo em 10 dias, prorrogáveis;
- **"d"**, exercício regular de direitos: na falta de outra prova, a CAT/SP
  constitui prova para fins legais (art. 214) — do direito do próprio
  acidentado, antes do de qualquer outro;
- **"f"**, tutela da saúde exclusivamente em procedimento realizado por
  profissionais de saúde: é o que sustenta o nível 2 na mão do médico do
  trabalho, e só dele.

**Finalidade:** instruir a perícia oficial em saúde do SIASS, que é quem
estabelece o nexo causal; preencher a CAT/SP; e prevenir a repetição —
classificar a gravidade, escolher a medida de controle e apurar as taxas de
frequência e de gravidade, que saem agregadas e com a supressão de células com
menos de 5 casos que o §6 já exige.

**Recorte de acesso, em três permissões (decisão 5):**

- `acidente.saude_ver` — nível 1. Engenheiro de segurança, técnico de segurança
  e coordenador. Têm porque classificar gravidade e escolher EPI são atos deles
  e dependem de saber **o quê** e **onde**; exigir médico do trabalho para
  qualquer leitura travaria o laudo numa universidade de cinco campi.
- `acidente.saude_detalhe_ver` — nível 2. **Só o médico do trabalho.** O número
  exato de dias não muda decisão de prevenção; muda a taxa de gravidade, que
  sai agregada.
- `acidente.saude_registrar` — quem digita a lesão é profissional de saúde. Só
  o médico do trabalho.

A separação é **física**: tabela própria, serviço de leitura único, dois níveis.
Apertar o recorte depois — tirar o nível 1 do engenheiro, por exemplo — são duas
linhas na matriz de perfis, não uma migração.

**Todo acesso é auditado**, nos dois níveis e sem exceção. Cada abertura grava
`acesso_dado_sensivel` com o nível efetivamente entregue, sobre quem, e com a
**finalidade escolhida em lista fechada antes de o conteúdo aparecer** — não
presumida depois. Acesso por quem não é o responsável pela ocorrência gera, além
disso, evento próprio na trilha, visível em `/auditoria`: não bloqueia, porque
substituição de férias existe; aparece, porque curiosidade não é finalidade.

### 4.5 Expressamente não tratados

**Em módulo nenhum** (proibição implementada em código e testada):
CPF; CID; diagnóstico; atestado médico; gestação, gravidez ou
lactação de forma explícita; endereço residencial; telefone pessoal; dados
biométricos; origem racial ou étnica; convicção religiosa; opinião política;
filiação sindical; dados de menores.

**"Estado de saúde" saiu desta lista em 13/08/2026** e passou a ter tratamento
próprio no §4.4. Hoje continua não sendo tratado em lugar nenhum do sistema —
mas deixará de ser assim quando o módulo de Acidentes entrar, e a lista não pode
prometer o contrário. O que dela **não** sai — CID, diagnóstico, atestado
médico, texto clínico — continua valendo lá dentro também.

Uma nota sobre a palavra "doença", para quem for conferir o filtro de texto
livre: ela é termo proibido em todos os campos do sistema, e o filtro já prevê
**uma** dispensa, por contexto declarado, para os campos narrativos do módulo de
Acidentes. Como o módulo ainda não existe, hoje **nenhum campo usa essa
dispensa** — ela está pronta, e inerte. A razão dela é estreita e vale
registrar: "doença relacionada ao trabalho" é o **nome jurídico de uma das três
espécies de acidente em serviço**, do mesmo naipe de "acidente de trajeto" — não
é diagnóstico de ninguém. A dispensa é do contexto, não da frase, e alcança só
essa palavra: "enfermidade", CID, diagnóstico, atestado médico e CPF seguem
barrados em todos os contextos, sem exceção declarada nem possível.

O afastamento do art. 69, parágrafo único, da Lei 8.112/90 é registrado como
`AFASTAMENTO_LEGAL` com a base legal citada — **nunca** como gestação.

### 4.6 Demandas — o que chega por fora do SEI

**Tratados desde 03/09/2026**, em `demanda` e `demanda_encaminhamento`:

- **Quem demandou**, em texto livre obrigatório: o nome, ou a descrição de quem
  é ("Chefia da FAMED", "Encarregado da empresa contratada"). É a única
  identificação quando a pessoa não está no cadastro, e é por isso que ela é
  livre.
- **O vínculo, quando existe**: `servidor_id` e `unidade_uorg_id` do cadastro. A
  tela lê o vínculo por `identificar(...)` e não pelo texto — quem não tem
  `exposicao.ver` vê o identificador opaco da RN-19, como em toda outra tela.
- **O canal** por onde chegou: e-mail, presencial, telefone, ofício ou outro.
  Vocabulário fechado, porque a pergunta que ele responde é contável — "quanto
  do trabalho do setor entra por fora do SEI?".
- **O assunto e a descrição**, em texto livre, filtrados pela RN-21.
- **O encaminhamento**: data, para quem, e o que foi pedido — texto livre,
  filtrado, e **append-only** (trava de banco, não disciplina).
- **O desfecho**: como terminou, e a prova que cada tipo cobra — o que foi
  feito, o processo SEI gerado (por chave estrangeira), o setor e a data do
  encaminhamento, ou o motivo de não haver providência.
- **Quem registrou, quem é responsável e quem encerrou**: identificadores de
  conta, como no resto do sistema.

**Não tratados, e a lista importa aqui mais do que em qualquer outra seção:**
CPF, documento de identidade, endereço residencial, telefone pessoal e e-mail
pessoal de quem demanda — nem sequer há coluna. O contato de retorno, quando
existe, é o e-mail institucional que já está no cadastro do servidor; para quem
não é servidor, o retorno se dá pelo mesmo canal por onde o pedido chegou, e o
sistema não guarda esse endereço.

**E a negativa que a tabela do §4.4 tornaria confusa se ficasse subentendida:**
a demanda **não é campo de saúde disfarçado**. Quando o pedido tem origem numa
condição de saúde — e tem, com frequência, porque é o que leva alguém à CSSO —
o que se registra é o **pedido** e o **ambiente**, nunca a condição. O filtro da
RN-21 recusa a gravação, com a saída escrita na própria mensagem de recusa.

## 5. Compartilhamento

| Destinatário | O que | Por quê |
|---|---|---|
| PROGEP / DASA | Parecer técnico nominal, laudo e recomendação | Instruir a concessão e o lançamento no SIAPE |
| SEI (sei.ufvjm.edu.br) | PDF do parecer, anexado **manualmente** pelo servidor da CSSO | O SEI é o sistema oficial de processo |
| Auditoria interna / órgãos de controle | Trilha de auditoria e relatórios | Dever de prestação de contas |
| PROGEP, procuradoria e órgãos judiciais, **sob pedido** | Ficha de EPI nominal e o comprovante assinado | É a prova de que o equipamento foi entregue; sustenta o PPP, a aposentadoria especial e a defesa da instituição em fiscalização ou demanda judicial. **Quem responde e por qual canal ainda não está definido** (§9, item 8) |
| (previsto) Perícia oficial em saúde — SIASS | CAT/SP e relatório de investigação na versão **completa**, inclusive o bloco de saúde | É quem estabelece o nexo causal; decidiria com menos do que a Administração sabe |
| (previsto) Empresa contratada e fiscal do contrato | Registro do acidente com terceirizado, na versão **sem saúde** | O fiscal cobra da contratada a CAT do RGPS, que é obrigação dela, e recebe o achado de EPI não fornecido |
| (previsto) Público em geral, pela página de validação de certificado | Existência e validade de um certificado, a partir da chave impressa nele | Um certificado que só se confirma por telefone não se confirma |

A página pública de validação **não exibe o nome** de quem se formou: mostra o
identificador público do participante e oferece conferência por digitação —
confere ou não confere. Ver a ressalva do §6 sobre esse identificador, que é
estável de propósito e não se confunde com o identificador opaco por sessão.

**Não há** transferência internacional. **Não há** operador terceirizado. **Não
há** uso de nuvem: o banco, os documentos e os backups ficam em disco local ou
em rede institucional (ver `POLITICA_RETENCAO.md`).

### 5.1 E isso é condição, não constatação

Nenhum módulo — nem os três novos — chama serviço de terceiro. Enquanto for
assim, o parágrafo acima se sustenta sozinho. **Ligar qualquer API externa a
este sistema exige emenda prévia deste registro.** A emenda é o portão: sem ela,
a ligação não se faz. Vale, sem exceção, para os três casos que já se sabe que
vão ser propostos:

- **Inteligência artificial.** A decisão 6 fixou que IA não é prioridade e que
  nada de terceiro está ligado — os motores que o desenho previa e que não
  precisam de IA nenhuma viraram código comum. Se um dia houver, a ordem de
  preferência é **modelo local**, que é a única opção compatível com este
  registro como ele está; depois, API de terceiro, que exigiria contrato de
  operador assinado pela UFVJM (LGPD arts. 39 e 46), avaliação do encarregado e
  este registro emendado **antes** do primeiro envio; e, na falta das duas
  coisas, nada, que é o padrão.
- **Consulta automática de CNPJ** na abertura de acidente com empresa
  contratada. É dado de pessoa jurídica, não pessoal, e por isso a tentação de
  tratá-la como detalhe — mas seria a primeira saída de rede do sistema, e é a
  frase acima que ela contradiz. O preenchimento manual continua disponível de
  qualquer modo: acidente às 3h da manhã não pode depender de API de terceiro
  estar no ar.
- **Envio de e-mail por SMTP**, de que a inscrição pública de Certificados
  depende. O servidor de e-mail institucional não é operador de terceiro, mas
  passa a transitar nome e e-mail de participante externo, e mudança de fluxo se
  declara aqui.

Chave de API, quando houver, **nunca em banco de dados nem em planilha**: só em
variável de ambiente, fora do repositório (decisão 9).

## 6. Medidas de segurança

- Autenticação própria com senha em Argon2id; sessão server-side revogável;
  bloqueio após 5 tentativas; troca obrigatória de senha provisória.
- Controle de acesso por perfil, em três camadas (rota, serviço e repositório),
  negado por padrão.
- Minimização na exibição: sem a permissão `exposicao.ver`, a identificação do
  servidor é substituída por identificador opaco por sessão (`SRV-xxxx`), nunca
  por máscara parcial.
- Supressão estatística: visões agregadas ocultam células com menos de 5
  servidores, com supressão secundária.
- Registro de todo acesso a dado sensível em `acesso_dado_sensivel` (quem, qual
  campo, sobre quem, com que finalidade).
- Trilha de auditoria append-only, com encadeamento de hashes SHA-256 (o banco
  recusa `UPDATE` e `DELETE`).
- Backup cifrado em AES-256-GCM com chave derivada por PBKDF2-SHA256.
- Anexos identificados por SHA-256; anexos das categorias `FORMULARIO` e
  `FICHA_EPI` nascem `RESTRITO`.

Acrescentado pela emenda de 18/08/2026, com a ficha de EPI:

- **Ler a ficha de EPI de outra pessoa entra em `acesso_dado_sensivel`**, com
  `campo='epi_ficha'` e a finalidade declarada — mesmo tratamento da exposição a
  agente nocivo (RN-23). Baixar o comprovante assinado entra separado, com
  `campo='anexo.FICHA_EPI'`, porque é o arquivo com a assinatura manuscrita e
  não a listagem. **Ler a própria ficha não registra e não exige permissão de
  módulo**: é o art. 18, II da LGPD, e o escopo próprio já a resolve.
- **A linha da ficha é append-only por trava de banco**, como a trilha de
  auditoria. O conteúdo não se altera em camada nenhuma; três colunas se
  **completam** uma única vez (o evento da trilha, o anexo do comprovante e o
  momento em que ele chegou), e correção é linha nova de tipo `ESTORNO`, com
  motivo, ao lado da errada. Cada linha é amarrada, pela sua forma canônica, ao
  `hash_atual` do evento que a registrou — há função que refaz essa forma e
  acusa divergência.

Acrescentado e ressalvado pela emenda de 13/08/2026:

- **O identificador opaco descrito acima é por sessão; o do participante não é,
  e a diferença é proposital.** `SRV-xxxx` muda a cada sessão justamente para não
  ser correlacionável entre telas. **(previsto)** O identificador público do
  participante de treinamento (`PTC-xxxxxxxx`) é **estável e público** — tem de
  ser, porque uma chave de validação que muda a cada consulta não valida coisa
  alguma. São dois mecanismos com propósitos opostos, e este registro passa a
  distingui-los em vez de prometer um só. O que continua valendo para os dois:
  **nunca máscara parcial de matrícula ou de nome.**
- **(previsto)** Leitura de dado de saúde em dois níveis, por serviço único, com
  finalidade declarada antes do conteúdo e auditoria por nível — §4.4.
- **(previsto)** As páginas públicas de validação e de inscrição **mudam o
  perfil de risco do sistema inteiro**. Hoje ele é um programa de mesa em
  `127.0.0.1`, e é isso que sustenta várias das escolhas atuais de autenticação.
  Expor `/publico` e `/validar` é decisão institucional a tomar com o TI, com
  reavaliação dessas escolhas — não efeito colateral de uma entrega.
- **Limite conhecido do registro de acesso a dado sensível:**
  `acesso_dado_sensivel.servidor_id` só aponta para `servidor`. Para titular que
  não é servidor — participante externo, acidentado terceirizado — o "sobre
  quem" não tem hoje onde ser gravado, e o registro ficaria com quem, qual campo
  e com que finalidade, mas sem o titular. Pendente (§9, item 6).

## 7. Direitos do titular (LGPD art. 18)

O servidor pode consultar seus próprios processos e pareceres pelo perfil
`servidor_consulta`, e solicitar confirmação, acesso, correção e informação
sobre compartilhamento pelo e-mail do setor. Pedidos de eliminação são
analisados à luz do art. 16, I e II: o tratamento decorre de obrigação legal e
os documentos têm valor probatório e prazo de guarda arquivístico.

O titular que **não é servidor** não tem conta e, portanto, não tem a consulta
própria do perfil `servidor_consulta`. Já vale hoje para o **instrutor externo**
do §3, e **(previsto)** valerá para o participante externo de treinamento e para
o acidentado terceirizado, estudante ou visitante. O direito de acesso deles é
atendido **pelo e-mail do setor**, e quem responde é a CSSO. Isso não é
limitação a contornar: é a consequência de não criar conta para quem não precisa
de uma. Mas exige o que não é automático — **o canal tem de estar divulgado onde
essas pessoas passam**: hoje, no convite ao instrutor externo; amanhã, na página
pública de inscrição e no próprio certificado. Direito de acesso que só existe
para quem já sabe o e-mail do setor é direito pela metade.

**(previsto)** O acidentado servidor vê a própria ocorrência inteira, inclusive
o bloco de saúde nos dois níveis (art. 18, II). Pedido de eliminação de registro
de acidente é indeferido pelo art. 16, I e II, e o fundamento aqui é próprio: a
CAT/SP constitui prova para fins legais e a repercussão previdenciária dura
décadas — apagá-la prejudicaria, antes de qualquer outro, o próprio titular.

## 8. Incidentes

Suspeita de incidente de segurança com dado pessoal deve ser comunicada
imediatamente ao encarregado da UFVJM e registrada em `historico_evento`, com
avaliação de comunicação à ANPD (LGPD art. 48).

## 9. O que esta emenda não resolveu

Está aqui em vez de decidido por conta própria. Base legal e prazo não se
inventam: onde falta certeza, o que se registra é a falta de certeza, de forma
que dê para alguém agir sobre ela.

| # | O que ficou em aberto | Por que não fechei | Quem fecha |
|---|---|---|---|
| 1 | **Âncora normativa da capacitação em SST no regime estatutário.** As NRs são instrumento da CLT, e o titular aqui é servidor estatutário. Qual norma obriga a UFVJM a capacitar e a reciclar, e em que periodicidade? | Hoje a norma é declarada treinamento a treinamento em `treinamento.norma_referencia`, o que basta para imprimir o certificado mas **não fecha a base legal deste registro**. A mesma dúvida alcança a citação da NR-6 na linha de EPI do §2 | Fabrício, com o encarregado |
| 2 | **Art. 11, II, "b" no §2.** O registro cita "a" e "b" para dado de exposição; esta emenda cita "a", "d" e "f" para dado de saúde | O plano consolidado sugeria "b" também para saúde e eu **não adotei**: "b" trata de tratamento compartilhado para execução de política pública, que não descreve o que a CSSO faz aqui. Se "b" não se sustentar no §2 tampouco, aquela linha muda junto | Encarregado |
| 3 | **Encarregado institucional da UFVJM** | Pendente desde a v1.0 deste registro. Cada item desta tabela espera por ele | Reitoria |
| 4 | **Menor de idade.** O §4.5 afirma que não se tratam dados de menores, e hoje é verdade | Um estudante de curso técnico ou um visitante de feira de ciências que se acidente no campus torna a afirmação falsa e traz o art. 14 da LGPD. **Decisão antes do primeiro caso, não depois** — depois é incidente, não decisão | Fabrício, com o encarregado |
| 5 | **Base legal para dados de comunicante e de testemunha.** Obrigação legal e exercício regular de direitos parecem ser | Não quis fixá-la sozinho: é dado de terceiro que entra sem que a pessoa peça, e é a hipótese mais frágil desta emenda | Encarregado |
| 6 | **"Sobre quem" no registro de acesso sensível, quando o titular não é servidor** | `acesso_dado_sensivel.servidor_id` é FK para `servidor`. Ou a coluna ganha um par para participante e acidentado, ou o registro fica incompleto justamente para os titulares mais vulneráveis. É decisão de esquema, e o momento certo é antes de `acidente_saude` existir | Coordenação técnica |
| 7 | **Autocadastro** (decisão 8, em aberto). Se existir, muda como a conta nasce, exige confirmação de e-mail e exige regra de qual perfil ela recebe | Nenhum dos módulos depende dele hoje, então não force a decisão — mas ela muda este registro quando vier | Fabrício |
| 8 | **Quem responde ao pedido de ficha de EPI, e por qual canal.** A linha nova do §5 registra que o compartilhamento vai existir; ela não diz quem executa | A ficha passou a existir hoje, e o §12.8 do desenho já avisava: assim que ela existir de verdade, PROGEP, procuradoria e eventualmente a Justiça do Trabalho vão pedi-la. É decisão de processo, não de engenharia — e é a diferença entre uma ficha que ajuda e uma que vira passivo. Enquanto não houver canal definido, o pedido cai em quem tiver `epi.ficha`, e cada leitura fica registrada | Fabrício, com o encarregado |
| 9 | **A assinatura manuscrita do titular é dado biométrico?** O comprovante `FICHA_EPI` carrega a assinatura do próprio servidor, digitalizada | Tratei-a como dado pessoal comum de acesso `RESTRITO`, que é o mínimo defensável, e **não** como dado sensível do art. 11. Assinatura manuscrita não está na lista fechada daquele artigo, mas é um identificador com função de autenticação, e não conferi a leitura da ANPD sobre isso. Se ela for sensível, muda a base legal desta linha no §2 e o recorte de acesso no §6 | Encarregado |
