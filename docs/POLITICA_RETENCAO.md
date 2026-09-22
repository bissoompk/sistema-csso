# Política de retenção, guarda e descarte

Sistema de Gestão da CSSO/Sisa — módulos Adicional Ocupacional, Certificados e
Treinamentos, e Gestão de EPI, mais a base compartilhada.

**Emenda de 03/09/2026 — as demandas recebidas por fora do SEI.** Nasceram
`demanda` e `demanda_encaminhamento`, na base compartilhada do sistema. O §2.6 é
novo e vale **hoje**; a revisão sai na mesma entrega da fatia que cria a tabela,
como o §6 obriga. O prazo delas **não é um só**, e é a única novidade de método
desta emenda: a demanda que virou processo tem o destino amarrado ao processo, e
as demais são registro administrativo comum — o §2.6 argumenta os dois.

**Emenda de 18/08/2026 — a ficha de EPI entrou em produção.** O §2.3 deixa de
ser previsto na parte que a fatia criou: `epi_ficha_registro`,
`epi_movimento_estoque` e o anexo `FICHA_EPI` passam a valer **hoje**, em guarda
permanente, e a revisão sai na mesma entrega da fatia, como o §6 já obrigava.
Uma linha nova entra: o **comprovante impresso** que ainda não foi assinado, que
é arquivo de trabalho e não documento — o §2.3 explica por quê.

**Emenda de 13/08/2026.** A primeira fatia do módulo Certificados e Treinamentos
entrou em produção hoje (v1.8.0), e os módulos de EPI e de Acidentes em Serviço
vêm atrás. Vale aqui a mesma convenção do `ROPA.md`, §0: **o que não traz marca
é vigente**; o que traz **(previsto)** passa a valer a partir de a fatia
correspondente entrar em produção, e até lá o sistema não guarda aquilo porque
aquilo não existe. Os prazos novos estão nos §2.2 a §2.4, e o que eu **não**
consegui fixar está no §2.5, dito como dúvida em vez de número inventado.

## 1. Princípio

Este sistema é **apoio**. O documento de valor probatório é o que está no SEI.
Ainda assim, o que existe aqui contém dados pessoais — de servidores e, desde
13/08/2026, também de quem não é servidor — e recebe o mesmo cuidado: guarda
pelo prazo necessário, descarte documentado, nada em nuvem pessoal.

**(previsto)** Esse princípio ganha uma exceção, e ela é conhecida: a CAT/SP do
módulo de Acidentes **é ela mesma prova para fins legais** (Lei 8.112/90, art.
214), e não a cópia de apoio de um documento que vive noutro lugar. Onde o resto
do sistema é apoio, ali ele é o original — e o §2.4 trata disso.

## 2. Prazos de guarda

Alinhados à tabela de temporalidade das atividades-meio da administração pública
federal (CONARQ) e à natureza previdenciária da informação de exposição.

### 2.1 Adicional ocupacional e base do sistema

| Conjunto | Prazo corrente | Destinação | Justificativa |
|---|---|---|---|
| Parecer técnico e laudo técnico | Permanente | Guarda permanente | Sustentam direito previdenciário (aposentadoria especial, PPP) e podem ser exigidos décadas depois |
| Histórico de exposição (`exposicao`, `adicional_vigencia`) | Permanente | Guarda permanente | Mesma razão |
| Processo (metadados, estado, prazos) | Enquanto durar o vínculo + 5 anos | Eliminação após avaliação | Apoio operacional; o processo oficial permanece no SEI |
| Anexos operacionais (`RELATORIO_CAMPO`, `FOTO`, `OUTRO`) | 5 anos após a conclusão | Eliminação | Instrução já refletida no parecer |
| Anexos `PARECER_ASSINADO`, `LAUDO`, `PORTARIA`, `FORMULARIO` | Permanente | Guarda permanente | Comprovam a decisão e a declaração das chefias |
| Trilha de auditoria (`historico_evento`) | 5 anos, no mínimo | Avaliação | LGPD art. 37; append-only, nunca apagada por rotina |
| Registro de acesso a dado sensível (`acesso_dado_sensivel`) | 5 anos | Eliminação | Prestação de contas |
| Sessões (`sessao`) | 90 dias após expirar | Eliminação | Segurança |
| Registro de acesso (`dados/logs/acesso.log`) | 90 dias | Eliminação **cumprida pelo mecanismo** (rotação diária, 90 arquivos) | Segurança |
| Staging da migração (`stg_*`) | Até o encerramento da migração | Eliminação | Dado bruto, já normalizado no sistema |
| `migracao_rejeitada.payload` | **90 dias após o encerramento da migração** | Expurgo automático (`expurgar_apos`) | Contém payload bruto do Trello/planilha |

**Nada é apagado por clique.** Parecer, laudo, anexo e evento nunca são
deletados: são marcados como `ANULADO`, `SUPERADO` ou `ativo=false`, sempre com
motivo registrado. A regra vale para todos os módulos, e a emenda de 13/08/2026
não a afrouxa em ponto nenhum — no §2.4 ela aperta.

### 2.2 Certificados e Treinamentos

**Vigente desde 13/08/2026** — o que a fatia 1 criou:

| Conjunto | Prazo corrente | Destinação | Justificativa |
|---|---|---|---|
| `treinamento` (catálogo) | Enquanto o treinamento existir; quando sai de uso é **desativado, não eliminado** | Avaliação | O certificado cita o treinamento pelo nome e pela carga horária. Eliminar o catálogo deixa o documento órfão da coisa que ele atesta |
| `certificado_modelo` e `certificado_modelo_tag`, **inclusive as versões não vigentes** | Permanente | Guarda permanente | A versão antiga é o layout **e o mapa de tags** sob os quais um certificado foi emitido. Sem ela a segunda via sai diferente da primeira — que é exatamente o que o congelamento existe para impedir |
| `assinatura_instrutor` e a rubrica anexada | Permanente | Guarda permanente | É a prova de quem assinou, e dura o mesmo que o certificado que ela assina |

> **Aviso operacional, com janela curta.** A rubrica do instrutor ainda **não
> tem categoria própria** em `anexo`. Se ela for anexada como `OUTRO` ou `FOTO`,
> cai na regra de eliminação em 5 anos do §2.1 — e apaga a assinatura de um
> documento de guarda permanente. A categoria `RUBRICA_INSTRUTOR` precisa existir
> **antes do primeiro upload de rubrica**. Hoje não há upload implementado, então
> nada se perdeu; a janela está aberta e fecha na primeira imagem enviada.

**(previsto)** — fatias 2 a 7, quando cada uma entrar:

| Conjunto | Prazo corrente | Destinação | Justificativa |
|---|---|---|---|
| `certificado` emitido, `certificado_sequencia` e o anexo `CERTIFICADO` | **Permanente** | Guarda permanente | Um certificado **vencido não perde valor probatório**: ele prova que, naquela data, a capacitação existiu. É disso que se pergunta depois de um acidente, numa fiscalização ou num processo — e se pergunta justamente do treinamento que já venceu. **Vencimento é regra de reciclagem, não de descarte.** Soma-se que a validação pública por chave precisa continuar respondendo anos depois, e que anular preserva o histórico em vez de apagá-lo |
| `turma`, `turma_instrutor`, presença e nota (`turma_presenca`) | **Permanente quando houve certificado emitido** | Guarda permanente | São o lastro do certificado. Sem a frequência apurada, o documento afirma sem provar |
| `inscricao` de servidor, inclusive `AUSENTE` e `CANCELADA` | Enquanto durar o vínculo + 5 anos — **proposto**, ver §2.5 | Avaliação | É registro funcional: a ausência em treinamento obrigatório é o que gera a pendência |
| `participante` **externo** sem certificado emitido, só com inscrição `AUSENTE` ou `CANCELADA` | **Nome, e-mail e organização apagados 90 dias após o fim da turma** | Expurgo por `expurgar_apos`, o mesmo mecanismo da linha `migracao_rejeitada` do §2.1 | Sem certificado e sem vínculo funcional não há obrigação legal que justifique guardar. Minimização, LGPD art. 6º, III |
| `participante` de **inscrição pública nunca confirmada** | **Nome e e-mail apagados 7 dias após o token expirar** | Expurgo | A pessoa nunca chegou a se inscrever — **pode nem ter sido ela quem digitou**. É lixo com dado pessoal dentro, e lixo não se acumula |
| `participante_email` | Acompanha o participante | — | É o que reconcilia o histórico de quem se inscreveu com o e-mail pessoal e depois com o institucional |
| Endereço IP da inscrição pública | **Sem prazo fixado** — §2.5 | — | — |

O expurgo do participante apaga o conteúdo e **mantém o `id` e o identificador
público**: as chaves estrangeiras continuam íntegras, nenhum relatório histórico
quebra, e o próprio expurgo é registrado na trilha. Descarte que ninguém
consegue provar que aconteceu não é descarte documentado.

### 2.3 Gestão de EPI

**Vigente desde 18/08/2026** — o que a ficha criou:

| Conjunto | Prazo corrente | Destinação | Justificativa |
|---|---|---|---|
| `epi_ficha_registro`, **inclusive as linhas estornadas e os estornos** | **Permanente** | Guarda permanente | **É prova legal de entrega.** É o documento que PROGEP, procuradoria ou Justiça do Trabalho pedem anos depois, e é ele que sustenta o PPP e a aposentadoria especial — a mesma razão do histórico de exposição no §2.1. Ficha eliminada equivale, para todo efeito, a entrega que não aconteceu. A linha estornada fica junto porque é ela que prova o histórico da correção, que é o que separa retificação de reescrita silenciosa — mesmo critério da CAT/SP no §2.4 |
| `epi_movimento_estoque` | **Permanente** | Guarda permanente | É o livro razão que amarra a ficha ao lote e ao CA. Sem ele a ficha afirma a entrega, mas não prova qual equipamento saiu nem se o CA estava válido |
| Anexo `FICHA_EPI` (comprovante assinado) | **Permanente**, nasce `RESTRITO` | Guarda permanente | Mesma razão, com a assinatura do servidor. É o único documento deste sistema assinado pelo **próprio titular**, e sem ele a ficha tem o registro e não tem a prova |
| Recusa fundamentada de fornecimento a quem não é servidor | Segue a trilha de auditoria: 5 anos, no mínimo | Avaliação | As decisões 3 e 7 assumiram esse risco por escrito **e quiseram o rastro**: é ele que permite contar quantas vezes o caso aparece e revisar a política com número, não com impressão |
| Comprovante **impresso e ainda não assinado** (`dados/documentos/epi/`) | Enquanto for útil; sem prazo próprio | Eliminação a qualquer tempo | Não é documento, é arquivo de trabalho: o sistema o **regera idêntico** a partir dos dados congelados na linha da ficha, sempre. O que precisa ser guardado é o digitalizado com a assinatura, que é a linha acima. Apagar a pasta não perde prova nenhuma — o que perderia prova é apagar a ficha |

**(previsto)** — as fatias de estoque e requisição, quando entrarem:

| Conjunto | Prazo corrente | Destinação | Justificativa |
|---|---|---|---|
| `epi_entrada_estoque` (o lote, com pregão, empenho e fornecedor) | **Permanente** | Guarda permanente | É a rastreabilidade da compra pública que a ficha cita, e responde "esse capacete veio de qual empenho" — pergunta de auditoria de contrato, que não prescreve junto com o equipamento |
| Anexo `MANUAL_EPI` | Enquanto o item existir no catálogo | Avaliação | Não é dado pessoal; é documentação do equipamento. **Ainda não há upload implementado** |
| `epi_requisicao` e `epi_requisicao_item`, com o texto congelado da recusa | Vínculo + 5 anos — **proposto**, ver §2.5 | Avaliação | É registro funcional de pedido e decisão, na mesma classe da linha `Processo` do §2.1. Não achei norma que fixe prazo, e analogia não é fundamento |

### 2.4 (previsto) Acidentes em Serviço

Aqui a exceção anunciada no §1 se concretiza: **registro de acidente não se
expurga.** Duas razões somadas, e cada uma sozinha bastaria.

- **É prova.** O art. 214 da Lei 8.112/90 diz que, na falta de outra prova, a
  CAT/SP constitui prova para fins legais. Documento probatório que o próprio
  emissor descarta por rotina deixa de provar — e quem perde primeiro é o
  acidentado, não a Administração.
- **A repercussão previdenciária dura décadas.** Aposentadoria por incapacidade,
  pensão, revisão de benefício e reconhecimento de sequela são pedidos que
  chegam vinte ou trinta anos depois do fato. É a mesma razão que já põe o
  parecer técnico e o histórico de exposição em guarda permanente no §2.1, e
  aqui ela pesa mais, porque lá o dado sustenta um direito e aqui sustenta a
  prova do evento que o originou.

| Conjunto | Prazo corrente | Destinação | Justificativa |
|---|---|---|---|
| `acidente_cat_sp`, **todas as versões, inclusive as retificadas e as anuladas** | **Permanente** | Guarda permanente | Constitui prova para fins legais (art. 214). E as versões retificadas provam o histórico da correção, que é o que separa retificação de reescrita silenciosa |
| `acidente_ocorrencia`, `acidente_investigacao`, `acidente_relatorio`, `acidente_decisao_pericial` | **Permanente** | Guarda permanente | Sustentam o direito do acidentado e podem ser exigidos décadas depois. A decisão pericial é o desfecho: sem ela o registro fica pela metade |
| `acidentado` | Acompanha a ocorrência — permanente | Guarda permanente | Inclusive quando não é servidor: é o único lugar onde a identificação dele existe |
| `acidente_saude` — **núcleo**: parte do corpo, natureza da lesão, houve afastamento, óbito, sequela, dias de afastamento e dias debitados | **Permanente**, com o acesso restrito do `ROPA.md` §4.4 | Guarda permanente | É o que prova o direito e o que alimenta a série histórica. Apagar prejudicaria o titular — e uma taxa de gravidade que perde os dados de cinco anos atrás não é série histórica |
| `acidente_saude` — **detalhe restante**: dias de internação, datas de início e retorno, data do óbito, quem prestou o primeiro socorro e em que unidade | **Proposta:** expurgo parcial 5 anos após a conclusão, com marca em `detalhe_expurgado_em` — **pendente**, §2.5 | Expurgo parcial, executado pelo setor e registrado em ata | A duração já está guardada em dias, e a fonte primária está no SIASS. Mas o prazo é proposta de desenho, não norma conferida |
| `acidente_entrevista.relato` | Permanente, restrito | Guarda permanente | É a base da caracterização. Apagá-lo destruiria o fundamento do relatório — e é dado de terceiro, que merece o mesmo cuidado que a lesão |
| `acidente_unidade_exposicao` | Permanente | Guarda permanente | Para doença relacionada ao trabalho, é a prova de **onde** a exposição aconteceu, que é dado previdenciário |
| `acidente_acao` (plano de ação) | Permanente | Guarda permanente | Prova do que foi determinado e do que foi cumprido — é o que uma auditoria pede primeiro |
| `acidente_evidencia` citada no relatório | Permanente | Guarda permanente | Faz parte do relatório |
| `acidente_evidencia` **não** citada, e o anexo `FOTO` correspondente | 5 anos após a conclusão | Eliminação | Já é a regra dos anexos `FOTO` no §2.1. E não há foto de lesão a considerar: ela é proibida em qualquer hipótese (`ROPA.md` §4.4) |
| `acesso_dado_sensivel` deste módulo | 5 anos | Eliminação | Igual ao que já vale |

**Nada é apagado por clique — e aqui a regra vale duas vezes.** A CAT/SP tem
regime próprio, mais duro: **não existe caminho de edição nem de exclusão em
camada nenhuma** — nem rota, nem serviço, nem tela. Correção é retificação, e a
retificação preserva a versão anterior. Documento que constitui prova legal e
que pode ser silenciosamente reescrito não prova nada.

O expurgo parcial do detalhe de saúde, **se for confirmado**, é a única
eliminação nova que **não** roda sozinha — e é assim de propósito. Ao contrário
do expurgo de participante do §2.2, que é rotina automática sobre dado de quem
nunca chegou a se inscrever, este toca o registro de uma pessoa que se
acidentou. Por isso é executado pelo setor, com simulação por padrão; alcança só
ocorrências concluídas há mais de cinco anos **e que já tenham decisão pericial
registrada** — enquanto a perícia não decidiu, o detalhe ainda pode ser
necessário ao titular; grava na trilha quantas linhas e quais campos; e vai a
ata, como esta política já exige de qualquer eliminação.

### 2.5 Os prazos que eu não fixei

Cinco, e é melhor que fiquem em aberto do que fechados com número inventado.

| # | O que | Por que não fixei | Quem fecha |
|---|---|---|---|
| 1 | **`inscricao` de servidor sem certificado emitido** (ausente, reprovado, cancelada) | Proponho vínculo + 5 anos, por analogia com a linha `Processo` do §2.1. Não achei norma que fixe prazo para registro de participação em capacitação, e analogia não é fundamento | Arquivo institucional da UFVJM / tabela CONARQ |
| 2 | **Endereço IP da inscrição pública** | Duas âncoras possíveis e não sei qual vale. Ou são os 90 dias da linha `sessao` do §2.1, tratando-o como registro de segurança; ou são os **6 meses do art. 15 do Marco Civil da Internet**, que obriga a guarda de registro de acesso a aplicação — mas o artigo alcança o provedor constituído como pessoa jurídica que exerça a atividade **com fins econômicos**, e é esse recorte que torna duvidosa a aplicação a um sistema interno de universidade federal. Não chuto. Enquanto não houver resposta, vale lembrar que a inscrição pública **já depende** de decisão institucional de exposição de rede, então não há urgência | Encarregado, com a procuradoria |
| 3 | **Detalhe de saúde de nível 2 — o expurgo parcial em 5 anos** | É proposta do desenho de Acidentes, não norma que eu tenha conferido, e depende da tabela de temporalidade da UFVJM. **Se o arquivo institucional exigir guarda permanente de tudo, o expurgo sai** — e a proteção do detalhe passa a depender só do controle de acesso, que é menos do que as duas coisas juntas | Encarregado, com o arquivo institucional |
| 4 | **Certificado de participante externo** | Proponho permanente, pela mesma razão do certificado de servidor. Mas há uma diferença que não quero esconder: o externo não tem vínculo com a UFVJM e não tem conta, e guardar o nome dele por décadas precisa que a finalidade sustente o prazo. A finalidade que sustenta é a validação pública do documento que ele carrega. Se o setor decidir que certificado de externo deixa de se validar publicamente depois de N anos, este prazo muda com essa decisão | Encarregado, com o Fabrício |
| 5 | **`epi_requisicao` sem entrega** (indeferida, cancelada) — a fatia que a cria ainda não chegou | Proponho vínculo + 5 anos, pela mesma analogia da linha `Processo` do §2.1, e com a mesma fragilidade: analogia não é fundamento. A **recusa** em si já tem prazo, porque vive na trilha de auditoria; o que está em aberto é o envelope do pedido. Como a tabela não existe, não há nada guardado errado hoje — e é por isso que o momento de perguntar é agora | Arquivo institucional da UFVJM / tabela CONARQ |

### 2.6 Demandas recebidas por e-mail ou presencialmente

**Vigente desde 03/09/2026.**

Aqui o prazo **não é um só, e não deve ser**: o que a demanda virou muda o que
ela é. Copiar para todas o prazo do registro administrativo comum guardaria de
menos justamente na única em que ela deixou de ser administrativa; copiar para
todas a guarda permanente do processo guardaria por décadas o e-mail em que
alguém perguntou a validade de um CA.

| Conjunto | Prazo corrente | Destinação | Justificativa |
|---|---|---|---|
| `demanda` encerrada como **`VIROU_PROCESSO`** | **Segue o processo que ela gerou** — hoje, "enquanto durar o vínculo + 5 anos", a linha `Processo` do §2.1 | Eliminação após avaliação, **junto com o processo** | Ela é a **origem** de um processo que existe: é ela que responde "de onde veio isto?", pergunta que aparece na instrução, no recurso e na auditoria. Eliminá-la antes do processo deixaria o processo sem procedência; guardá-la depois seria guardar o rastro de uma coisa que já foi eliminada. O vínculo é chave estrangeira, então o destino é conferível — não depende de alguém lembrar |
| `demanda` encerrada como **`RESOLVIDA`**, **`ENCAMINHADA`** ou **`SEM_PROVIDENCIA`** | **5 anos após o encerramento** | Eliminação após avaliação | É registro administrativo comum: a prova de que o setor respondeu ao que lhe foi dirigido, e do que respondeu (Lei 9.784/99, arts. 48 e 49). Cinco anos é o prazo da linha `acesso_dado_sensivel` do §2.1 e o da prescrição quinquenal que o resto do sistema já usa como régua. **`SEM_PROVIDENCIA` é a que mais precisa do prazo cheio**: é a decisão de não fazer nada, e é dela que se cobra explicação depois |
| `demanda` **ainda aberta ou em andamento** | Enquanto não encerrar | — | Demanda sem desfecho é trabalho pendente, e trabalho pendente não se descarta: descarta-se depois de decidido |
| `demanda_encaminhamento` | **Acompanha a demanda**, sempre | Eliminação junto | É o histórico do que se pediu a quem, e sozinho não diz nada — separá-lo da demanda produziria linhas órfãs sem objeto. **Append-only por trigger** (RN-31): não se edita nem se apaga por clique, e a eliminação, quando vier, é a da demanda inteira |
| Pendência aberta pelo prazo da demanda (`DEMANDA_COM_PRAZO`) | Segue `pendencia`, como qualquer outra tarefa | — | Ela é tarefa, não registro: o registro é a demanda |
| Trilha de auditoria das demandas (`historico_evento`) | 5 anos, no mínimo — a linha do §2.1 | Avaliação | Já valia; nada aqui a afrouxa. É onde ficam o encaminhamento, o desfecho e quem os escreveu |

**Nada é apagado por clique, e aqui também não.** Não existe rota, serviço nem
tela que apague demanda ou encaminhamento; encerrar é escrever o desfecho, e o
desfecho não se reabre. A eliminação, quando o prazo vencer, é ato de descarte
documentado do §5, com ata — como todas as outras.

**Uma ressalva honesta sobre os cinco anos.** Não achei norma que fixe prazo
para registro de pedido dirigido a setor técnico, e a analogia com a prescrição
quinquenal é analogia, não fundamento — a mesma fragilidade que os itens 1 e 5
do §2.5 já declaram. A diferença é que aqui o risco de errar é baixo dos dois
lados: guardar demais custa pouco (são linhas de texto, sem anexo), e guardar de
menos não perde prova de direito nenhum — a demanda que sustenta direito é
justamente a que virou processo, e essa segue o processo. Fica na fila do
arquivo institucional junto com as outras.

## 3. Onde os dados ficam

| Conteúdo | Local | Regra |
|---|---|---|
| Banco ativo (`dados/csso.db`) | Disco local da máquina do setor | **Nunca** em pasta sincronizada: OneDrive, Google Drive, Dropbox e iCloud corrompem SQLite e expõem dado pessoal |
| Documentos gerados (`dados/documentos/`) | Disco local | Nunca sincronizados |
| Anexos (`dados/anexos/`) | Disco local | Nunca sincronizados |
| Backups | `CSSO_BACKUP_DESTINO` do `.env` — por padrão disco local; em produção, rede institucional | Sempre cifrados (AES-256-GCM), e desde a 1.31.0 **levam os anexos junto** — antes restauravam a ficha sem o comprovante assinado |
| Registro de acesso (`dados/logs/`) | Disco local da máquina do setor | Nunca sincronizado. Guarda endereço de origem, que é dado pessoal |

O sistema recusa ativamente destinos de backup e exportação cujo caminho
contenha `onedrive`, `dropbox`, `google drive`, `meu drive` ou `icloud`, e avisa
na tela de saúde se o próprio banco estiver numa dessas pastas.

**Qualquer destino em nuvem exige autorização formal da UFVJM e contrato de
operador** (LGPD arts. 33 a 36, 39 e 46). A decisão, se houver, é registrada em
`LEIA-ME.txt`.

### Emenda de 23/08/2026 — o sistema passou a atender a rede do setor

**O dado não mudou de lugar**, e é isso que mantém esta seção quase intacta: o
banco, os documentos e os anexos continuam no disco da mesma máquina, sob o mesmo
controlador. O que mudou foi **quem alcança a porta**: de um operador na própria
máquina para as estações da CSSO/Sisa.

Três consequências para esta política, e nenhuma delas é opcional:

1. **Nasceu uma categoria de dado**: o registro de acesso (`dados/logs/`), com
   endereço de origem, identificador da conta, rota e horário. É dado pessoal, e
   por isso entrou nas duas tabelas acima com o **mesmo prazo de `sessao`, 90
   dias** — dois prazos para o mesmo dado na mesma instalação seria política que
   se contradiz. O registro guarda a **forma** da rota (`/servidores/{id}`), nunca
   o caminho concreto, e não guarda nome, matrícula nem conteúdo.
2. **A conexão não é criptografada.** Sem TLS num proxy à frente, senha e sessão
   viajam em claro no cabo do setor. É decisão consciente de quem manda, registrada
   aqui e avisada em faixa amarela no alto de toda tela — não é descuido, e é
   dívida a cobrar.
3. **O backup deixou de ser memória de uma pessoa.** Eram um operador e uma
   máquina; agora são seis pessoas escrevendo, e a perda passou a custar o
   trabalho de todas elas.

Continua valendo, sem exceção: **nuvem pessoal ou de terceiro exige autorização
formal e contrato de operador**. Ir para servidor institucional muda esta seção e
obriga a nova revisão — o §5 já trata o que fazer com o banco local nesse dia.

**A emenda de 13/08/2026 não muda esta seção.** Conferi os três módulos novos:
nenhum deles guarda dado em lugar diferente dos que estão na tabela acima. O que
eles mudam é o §2 e, no caso das páginas públicas de Certificados, o perfil de
exposição de rede do processo — que é decisão institucional própria, tratada no
`ROPA.md` §6, e não altera onde o dado repousa.

## 4. Backup e restauração

- Frequência mínima recomendada: diária nos dias de uso (`BACKUP-AGORA.bat`).
- Método: `VACUUM INTO` (cópia consistente mesmo com WAL ativo) seguido de
  cifragem AES-256-GCM com chave derivada por PBKDF2-SHA256 (390.000 iterações).
- A senha vive no `.env`, fora do repositório. **Backup sem a senha é lixo:**
  guarde-a onde a instituição guarda segredo, não junto do arquivo.
- Retenção dos arquivos de backup: 90 dias em rotação; um backup mensal
  arquivado por 5 anos.
- A restauração é testada — há teste automatizado que faz backup, restaura e
  regera o parecer 1/2025 idêntico ao texto de ouro.

## 5. Descarte

- Eliminação de banco ou backup: sobrescrita e remoção, com registro em ata do
  setor citando esta política.
- Mídias removíveis não são usadas para dado pessoal.
- Ao migrar para servidor institucional, o banco local é apagado somente depois
  de restauração verificada no destino.

## 6. Revisão

Esta política é revista a cada mudança de finalidade, de categoria de dado ou de
local de armazenamento, e ao menos uma vez por ano, junto com o `ROPA.md`.

Com os módulos novos, "a cada mudança" ganhou cadência conhecida: **a revisão
sai na mesma entrega da fatia que cria a tabela**, nunca depois dela. A ficha de
EPI cumpriu essa cadência em 18/08/2026: o §2.3 saiu de previsto para vigente na
mesma entrega que a criou. Faltam a fatia 2 de Certificados, que cria
`participante` e traz os prazos de expurgo do §2.2; as fatias de estoque e
requisição de EPI, que trazem o resto do §2.3; e a fatia que cria
`acidente_saude`, que é a que não pode subir sem o `ROPA.md` §4.4 vigente.

Última revisão: **18/08/2026** — a ficha de EPI em produção, junto com a versão
1.2 do `ROPA.md`. Revisão anterior: 13/08/2026, emenda dos módulos novos.
