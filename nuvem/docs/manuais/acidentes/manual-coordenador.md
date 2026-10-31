# Manual do Coordenador: módulo Análise de Acidentes (Sistema SISA)

Versão de referência: teste de 29/10/2026, com dados fictícios. Tudo o que está aqui foi visto funcionando, exceto onde o texto diz o contrário.

## Para quem é este manual

Para quem responde pelo módulo "Análise de Acidentes" na UFVJM: a coordenação da segurança do trabalho (e, quando atua no lugar dela, a superintendência). O módulo registra a comunicação de acidentes em serviço, a triagem, a investigação, o plano de ação, o relatório técnico, o encaminhamento ao SIASS e a conclusão. A base legal que a tela mostra é a Lei 8.112, arts. 211 a 214. O art. 214 dá 10 dias, contados da data do acidente, para a equipe encaminhar a comunicação.

Este manual trata do que a coordenação decide e acompanha. Quem faz o trabalho do dia a dia (comunicar, triar, investigar) tem manuais próprios.

## Antes de começar

- O módulo só aparece se estiver ligado no ambiente. Se estiver desligado, o menu mostra "em desenvolvimento" e todo endereço do módulo dá "não encontrado".
- A coordenação tem o conjunto completo de permissões: ver, comunicar, triar, investigar, emitir relatório, encaminhar ao SIASS, ver saúde (resumo e detalhe), ver identificação e exportar indicadores.
- O menu do módulo tem: "Painel", "Comunicar acidente", "Fila de ocorrências", "Plano de ação" e "Indicadores". O "Link de comunicação" não está no menu: abre-se pelo cartão do Painel.
- **Acesso ao módulo.** O acesso vem do perfil de cada pessoa (tabela abaixo) e pode ser ajustado em "Acesso por módulo" (menu Usuários, endereço `/perfis/niveis`). Para o módulo "Análise de Acidentes" há quatro escolhas por perfil: "Padrão do perfil", "Sem acesso", "Consulta" (só leitura) e "Operação" (com o teto do perfil: por exemplo, a secretaria em Operação fica "sem investigar, encaminhar ao SIASS"). Na tela de cada conta (Usuários, botão **Gerir**, bloco "Acesso por módulo", botão "Salvar acesso por módulo") dá-se ou retira-se o módulo só daquela pessoa; "Conceder perfil a esta conta…" também fica ali. **Quem grava essas mudanças é o Administrador do sistema ou o Superintendente.** A coordenação abre a tela de perfis e a de "Acesso por módulo", mas só para consultar (não há botão de gravar para ela) e não abre a lista de Usuários (acesso negado). O nível do módulo não altera as permissões de saúde, identificação e emissão de relatório: essas seguem o cargo do perfil. Este manual não descreve tela para editar catálogos do módulo (natureza da lesão, agentes, tabelas do Anexo III), modelos ou parâmetros, porque não há. Prazos (10 dias, 2 dias de triagem, 5 de resposta, 30 de investigação, 60 de perícia) são fixos no sistema e não se mudam pela tela. Se precisar de mudança, leve ao responsável técnico do sistema.

## Sumário

1. Quem pode o quê
2. As situações de uma ocorrência
3. Rotina de acompanhamento (diária, semanal, mensal)
4. Painel e Fila de ocorrências
5. Triagem: o que a coordenação decide
6. Link público de comunicação
7. Investigação e plano de ação
8. Saúde e identificação (acesso restrito)
9. Relatório técnico
10. SIASS, decisão da perícia e conclusão
11. Indicadores
12. Trilha de auditoria (aba "Histórico") e privacidade
13. Tarefas (pendências) que o módulo gera
14. Erros e mensagens comuns
15. Glossário
16. Limites conhecidos
17. E-mails e expurgo

---

## 1. Quem pode o quê

| Perfil | O que faz no módulo |
|---|---|
| Coordenador, engenheiro, técnico, superintendente | Triar, investigar, emitir relatório, encaminhar ao SIASS, ver o resumo da saúde. |
| Médico | Vê as abas, registra a saúde, abre o detalhe da saúde (nível 2), encaminha ao SIASS. Lê, sem editar, investigação, checklist, entrevistas, plano de ação e histórico. Não investiga, não emite relatório e não gera o link público (acesso negado). |
| Secretaria | Comunica, vê a fila e faz a triagem (assumir, mudar a situação, pedir complementação, prorrogar, retificar, cancelar). Gera o link público e vê os indicadores (sem exportar). Não acessa Plano de ação (acesso negado), SIASS, saúde, identificação, relatório, entrevistas, histórico nem exportação. |
| Servidor com conta ligada | Comunica, vê "Minhas comunicações", responde complementação. O servidor acidentado lê a própria saúde e a própria identificação. Não vê a fila, o plano de ação, os indicadores nem o link público (acesso negado). |
| Almoxarife e administrador de TI sem servidor ligado | Sem acesso ao módulo. |

Pontos que importam para quem coordena:

- O detalhe da saúde (nível 2) e a identificação pessoal só abrem para médico, coordenação e superintendência. O técnico e o engenheiro veem apenas o resumo da saúde.
- Ocorrência de menor de idade é "restrita": só a equipe de segurança do trabalho a abre. Para a secretaria, ela não existe.
- Nenhuma lista mostra nome. O nome aparece só na ficha, aba "Envolvidos", para quem tria, investiga ou encaminha. Quem comunicou um acidente que não é seu vê o envolvido como código (exemplo: "SRV-947b").

## 2. As situações de uma ocorrência

| Situação | Significado | Próximos passos possíveis |
|---|---|---|
| Recebida | Comunicação entrou e ninguém assumiu. | Em triagem, ou Cancelada. |
| Em triagem | Alguém da equipe conduz. | Aguardando complementação, Em investigação, Cancelada. |
| Aguardando complementação | Foi pedida informação a quem comunicou (prazo de resposta: 5 dias). | Em triagem (com a resposta, ou se a equipe retomar sem esperar), ou Cancelada. |
| Em investigação | Análise em curso. | Relatório emitido (botão "Emitir relatório"). Não volta para a triagem. |
| Relatório emitido | Relatório técnico gerado. A investigação fica travada. | Encaminhada ao SIASS, ou Concluída (só se a investigação marcou que não requer CAT/SP no SIASS). A coordenação pode reabrir a investigação (botão "Reabrir a investigação"). |
| Encaminhada ao SIASS | Encaminhamento registrado. | Concluída. A coordenação pode reabrir a investigação (botão "Reabrir a investigação"). |
| Concluída | Final. A investigação não reabre. | Se o caso voltou, comunique de novo: é uma ocorrência nova, com novo protocolo e novo prazo. |
| Cancelada | Final. O registro fica, com o motivo. | Nenhum. |

Cancelar só cabe antes da investigação.

## 3. Rotina de acompanhamento

**Todos os dias (5 minutos)**

1. Abra o "Painel". Olhe os cartões "Triagem" (novas), "Prazo do art. 214 vencendo" e "Aguardando complementação".
2. Se houver comunicação em "Recebida", confira que alguém a assumiu. O prazo de triagem é de 2 dias.
3. Para ocorrência com prazo vencendo (próximos 3 dias ou já vencido), confirme quem conduz e se o encaminhamento está a caminho.
4. Olhe o cartão "Link de comunicação": quantas comunicações por link esperam triagem (limite de 30).

**Toda semana (30 minutos)**

1. Na "Fila de ocorrências", filtre Situação "Em aberto" e percorra a coluna "Condução" e "Prazo de comunicação". Procure ocorrência sem quem conduza ou marcada "vencido".
2. Abra "Plano de ação" com o filtro "Vencidas". Cobre responsáveis.
3. Confira "Aguardando complementação": se a resposta demora mais de 5 dias, ligue para quem comunicou ou retome a triagem ("Mudar a situação" para "Em triagem").
4. Em "Em investigação", veja se alguma passa de 30 dias (prazo da tarefa "Investigar").
5. Em "Aguardando perícia", veja se alguma passa de 60 dias desde o encaminhamento.
6. Peça ao médico que confirme a saúde das ocorrências com lesão declarada (a tarefa "Confirmar a saúde declarada em CAT-..." tem prazo de 5 dias). Veja o limite conhecido sobre isso, na seção 16.

**Todo mês (1 hora)**

1. Abra "Indicadores" com o período do mês e do ano. Compare com o mês anterior.
2. Use "Exportar CSV" para o relatório mensal.
3. Confira por amostragem quem abriu saúde e identificação e com qual finalidade. A finalidade só aparece em "Auditoria" (menu do sistema; a coordenação abre), bloco "Acessos a dado sensível": quem leu, campo, número do acidentado e finalidade, da leitura mais recente para a mais antiga. A aba "Histórico" da ocorrência mostra apenas que alguém "que não conduz o caso" abriu a saúde, sem a finalidade (seção 12).
4. Revise os links públicos em uso (cartão "Link de comunicação", lista "Links em uso") e desligue os que não são mais divulgados.
5. Procure duplicadas na fila (mesmo evento, vários protocolos) e cancele com o motivo "Comunicação duplicada".

**Como saber que o módulo está saudável**

- Nenhuma ocorrência em "Recebida" há mais de 2 dias.
- Nenhuma ocorrência com prazo "vencido" sem prorrogação registrada e sem motivo.
- Plano de ação sem ações vencidas, ou com as vencidas justificadas.
- Poucas ocorrências paradas em "Aguardando complementação".
- Nenhum cartão do Painel com número crescendo semana após semana.

## 4. Painel e Fila de ocorrências

**Painel** ("Painel" no menu, endereço `/acidentes`). Os cartões "Plano de ação" e "Indicadores" só aparecem para quem tem acesso a eles (a secretaria não vê o do plano). Cartões: "Comunicar acidente", "Triagem", "Em investigação", "Fila de ocorrências", "Link de comunicação", "Plano de ação" (com o número de vencidas), "Indicadores", "Encaminhar ao SIASS" (no prazo dos próximos 3 dias). Também mostra "Prazo do art. 214 vencendo", "Aguardando complementação", "Aguardando perícia" e a contagem por situação.

"Prazo vencendo" vale para ocorrência ainda não encaminhada nem encerrada, com o prazo efetivo (o prorrogado, se houver) nos próximos 3 dias ou já vencido.

**Fila de ocorrências.** Filtros: Situação (Todas, Em aberto, Prazo vencendo ou vencido, e cada situação), Espécie, Campus, "Acidente a partir de", "até", Protocolo e a caixa "Só as que eu conduzo". Botões "Filtrar" e "Limpar". Mostra 50 por página, da data de acidente mais recente para a mais antiga. Colunas: Protocolo, Espécie, Data do acidente, Situação, Prazo de comunicação, Condução.

Não existe busca por nome nem por SIAPE, só por protocolo. É de propósito, para não expor identidade em lista.

## 5. Triagem: o que a coordenação decide

Na ficha da ocorrência, os botões do topo mudam conforme a situação: "Assumir", "Mudar a situação", "Pedir complementação", "Prorrogar o prazo", "Retificar a CAT/SP", "Cancelar".

**Assumir.** Abre uma caixa "Você passa a conduzir CAT-...": define "Quem conduz" e entrega a quem assume a tarefa do prazo. Se a ocorrência está Recebida, vai para Em triagem; em qualquer outra situação aberta (inclusive Em investigação e Relatório emitido) o botão continua aparecendo e só troca quem conduz, sem mudar a situação. Cuidado: quem tem permissão de triar pode assumir de novo e tomar o caso de quem já conduz, sem aviso a ele e sem a caixa dizer quem conduzia. Fica na trilha como "assumida (passou de outra pessoa da equipe)". Combine com a equipe que ninguém assume caso de colega sem conversar. Quem leva um caso adiante pelo "Mudar a situação" sem que ninguém o tenha assumido passa a ser "Quem conduz" automaticamente.

**Quem deve conduzir.** A secretaria pode assumir, mas não pode investigar. Se ela conduz um caso que vai para investigação, ela continua como "Quem conduz". Prefira que o caso seja conduzido por quem investiga (técnico, engenheiro, coordenador).

**Mudar a situação.** Só lista os destinos permitidos (veja a seção 2).

**Pedir complementação.** Só existe com a ocorrência em Em triagem. Campo "O que falta na comunicação" (obrigatório, até 2000 caracteres, sem termo de saúde). Prazo de resposta: 5 dias. O texto do pedido não vai no e-mail: fica só no sistema. Não funciona para comunicação vinda do link público (a pessoa não tem conta para responder): nesse caso fale pelo e-mail que ela deixou e use "Retificar a CAT/SP" com a resposta.

**Prorrogar o prazo.** Campos "Nova data" e "Motivo". A nova data tem de ser depois do prazo legal e o motivo é obrigatório. O prazo legal continua registrado e o novo aparece como prazo efetivo. Não há limite de prorrogações nem aprovação de outra pessoa: a decisão e a responsabilidade são suas. Exija motivo claro da equipe.

**Retificar a CAT/SP.** Reabre os campos de fatos e o relato, com "Motivo" obrigatório. Grava uma nova versão da CAT/SP (a anterior continua guardada) e não muda a situação. Se mudar a data do acidente, recalcula o prazo de comunicação. Não altera envolvidos, saúde nem identificação.

**Cancelar.** Campo "Motivo": "Comunicação duplicada", "Comunicação indevida", "Não é acidente em serviço", "Outro motivo" (este exige texto). O registro fica, nada é apagado. Depois de Em investigação não se cancela: se não era acidente em serviço, isso vai no relatório.

**Se duas pessoas mexem ao mesmo tempo.** O sistema avisa: "A ocorrência ... foi alterada por outra pessoa depois que você abriu a tela. Recarregue a ficha, confira o que mudou e refaça o que pretendia." Recarregue e confira.

**Comunicação duplicada.** O sistema não detecta duplicadas: o mesmo evento comunicado cinco vezes gera cinco protocolos. A triagem deve conferir e cancelar as repetidas com o motivo "Comunicação duplicada".

**Espécie "Incidente / quase acidente".** Segue o mesmo fluxo de um acidente com CAT: mesmo prazo de 10 dias, mesma exigência de SIASS. Decida com a equipe como tratar esses casos (veja a seção 16).

## 6. Link público de comunicação

Serve para servidores sem conta, ou quem comunica por eles. O formulário só oferece o vínculo "Servidor" e a comunicação pelo link recusa terceirizado, estudante, visitante etc. com a mensagem "A análise de acidentes e a CAT/SP valem só para servidor. Para quem não é servidor (do envolvido N), use o módulo Ocorrências." Quem gera: quem tem permissão de triar (coordenação, secretaria, técnico etc.).

Passos para gerar:

1. No "Painel", abra o cartão "Link de comunicação" (tela "Link de comunicação de acidente").
2. Na seção "Gerar link", escolha em "Para": "Toda a UFVJM (geral)" ou um campus.
3. Clique em "Gerar".
4. Copie o endereço na hora. A tela avisa: "Link gerado. Copie agora: ele não aparece de novo."

Pontos de decisão:

- Gerar de novo para o mesmo recorte (geral ou o mesmo campus) desliga o anterior. Cartazes e e-mails com o endereço antigo deixam de funcionar. Planeje antes de gerar.
- Para parar de receber, vá em "Links em uso" e clique em "Desligar". Quem abrir o endereço antigo vê "link inválido".
- Divulgue só internamente (intranet, e-mail institucional, cartaz no setor).
- Limite de proteção: ao chegar a 30 comunicações por link ainda "Recebida", o link para de receber até a equipe triar. O contador aparece como "Comunicações por link a triar: N de 30". Triar rápido mantém o link aberto.
- O formulário público limita 5 envios por endereço de rede em 10 minutos. Não aceita anexos, saúde nem CPF. O comunicante do link nunca recebe e-mail do sistema.
- Quem comunica pelo link vê um protocolo (exemplo CAT-2026-0008) e é só. Na ficha da equipe aparece "Pelo formulário por link", com nome, vínculo e e-mail informados. O e-mail é só para a equipe falar com a pessoa.

## 7. Investigação e plano de ação

**Quem investiga:** coordenador, engenheiro, técnico, superintendente. Médico e secretaria: na aba "Investigação" e "Entrevistas" a secretaria vê "Restrito à equipe que investiga"; o médico lê, mas não edita.

**O que a coordenação confere na aba "Investigação":**

- Os campos de análise (objetivo, equipe, trabalho habitual, prescrito e real, mudanças, relatos de campo, evidências, síntese explicativa, recomendações).
- As três escolhas, que definem o rumo do caso: "O ambiente de trabalho foi fator do acidente?" (Sim, Não, Não sei); "Caracterizado como acidente em serviço (parecer da SST)?" (Sim, Não, Inconclusivo); "Requer abertura da CAT/SP no SIASS?" (Sim, Não, Não sei). A última decide se o caso pode ser concluído sem passar pelo SIASS.
- Botão "Salvar a investigação". Se outra pessoa salvou antes, nada do que você digitou é gravado e a tela mostra seu texto ao lado do gravado.
- A aba "Análise" faz uma conferência automática contra os itens do Anexo III e lista "Falta (Anexo III)", "Atenção" e "Próximo passo".
- A aba "Checklist" (campo) e a aba "Entrevistas" (relatos, áudio com consentimento, evidências em PDF ou imagem de até 4 MB). Não existe editar nem excluir entrevista ou evidência, nem editar ou reordenar a linha do tempo.

**Regra de trava.** Só se edita com a ocorrência em Em triagem ou Em investigação. Depois de "Relatório emitido", investigação, checklist, entrevistas e evidências travam: "A investigação de ... está travada: o relatório já foi emitido." O que o relatório diz muda-se apenas retificando o relatório, e isso não reabre o texto da investigação (veja seção 16). Por isso, revise a síntese e as três escolhas antes de mandar emitir.

**Plano de ação** (menu "Plano de ação", endereço `/acidentes/acoes`). Lista as ações de todos os casos, com filtros "Em aberto", "Vencidas", "Todas". A ação se cria, edita e conclui na aba "Ações" da ficha, em qualquer situação menos Cancelada (continua depois da conclusão do caso).

- Campos: "Achado que motiva a ação", "Ação", Tipo, Prioridade, Prazo, "Conta responsável" ("Quem conduz o caso" ou "Eu"), "Unidade responsável" e responsável em texto livre.
- Ciclo: Pendente, "Iniciar" (Em andamento), "Concluir" (só aparece depois de Iniciar; exige "o que foi feito"; evidência opcional) ou "Cancelar" (vale também para Pendente; exige motivo; a ação fica riscada). Os textos da ação recusam CPF e termos de saúde. O médico lê o plano, mas não cria nem altera ação.
- "Editar" só vale enquanto a ação está aberta. Não existe reabrir ação concluída ou cancelada, nem atribuir a ação a outra pessoa com conta.
- O plano de ação não é pré-requisito para emitir o relatório. A coordenação decide se exige o plano antes.
- Cada ação cria uma tarefa com o prazo nas pendências.

## 8. Saúde e identificação (acesso restrito)

**Aba "Saúde".** Quem abre (e não é o próprio acidentado) escolhe:

- "Finalidade": Investigar o acidente, Classificar a gravidade, Instruir a perícia do SIASS, Atender o próprio acidentado, Auditoria.
- "O que abrir": "Resumo (nível 1)" ou "Detalhe (nível 2)" (este só com permissão).

Sem finalidade, a tela recusa: "Escolha a finalidade antes de abrir a saúde: ela fica registrada junto com a sua leitura." Toda abertura é gravada. Se quem abriu não é "Quem conduz" o caso, entra um evento na trilha dizendo isso (sem nome e sem dado clínico).

O resumo (nível 1) mostra natureza da lesão, partes do corpo, lateralidade, atendimento, afastamento, internação, óbito e sequela, marcados como "Declarado por quem comunicou (a confirmar)" ou "Registrado pelo médico do trabalho". O detalhe (nível 2) traz dias de afastamento, primeiro socorro, descrição da lesão, diagnóstico provável, CID e observações. O médico registra com o botão "Salvar saúde".

Atenção: no teste (repetido em 30/10/2026), o médico não conseguiu abrir o detalhe (nível 2) enquanto a natureza da lesão estava vazia: a página dá erro 500. O resumo (nível 1) abre normalmente e mostra "—" nos campos vazios, mas o formulário "Salvar saúde" só existe com o detalhe aberto. Até a correção, o registro inicial da saúde pode ficar indisponível pela tela. Acompanhe com o médico e com o responsável técnico do sistema.

O próprio acidentado servidor lê a própria saúde sem informar finalidade. Quem só comunicou o acidente de outra pessoa não abre a saúde.

**Aba "Identificação".** Somente leitura. Escolha a "Finalidade" (Contatar o envolvido ou a testemunha, Investigar o acidente, Emitir a CAT/SP no formato do Anexo III, Instruir a perícia do SIASS, Auditoria) e clique em "Abrir identificação". Mostra sexo, data de nascimento, CPF mascarado, RG, endereço, telefone, e-mail e contatos das testemunhas. A secretaria não acessa.

**Completar a identificação.** Quem tem a permissão acidente.identificacao_ver (coordenação, superintendência, engenheiro, médico e técnico de segurança) completa o Anexo III depois da comunicação: em cada envolvido, "Completar a identificação" (sexo, data de nascimento, CPF, RG, endereço, telefone, e-mail) e "Salvar a identificação". Só o digitado entra; o que já estava gravado e fica em branco continua como estava, e campo em branco não apaga. Recusas: nenhum campo preenchido ("Preencha ao menos um campo para completar a identificação."), ocorrência cancelada e identificação já expurgada. A trilha registra só os grupos de campo, nunca o valor. A "Retificar a CAT/SP" continua sem incluir a identificação.

**CAT/SP no formato do Anexo III (PDF).** Botão "Baixar a CAT/SP no formato do Anexo III (para o SIASS)" na aba "Identificação". Exige identificação e detalhe da saúde, então só médico, coordenador e superintendente baixam. Para técnico e engenheiro o link nem aparece na aba (o endereço direto responde acesso negado). É o único lugar em que o CPF sai por inteiro. O arquivo não é guardado no sistema: cada geração fica registrada na trilha. Campos não informados saem em branco.

**Privacidade, resumo para a coordenação:**

- Dê acesso ao detalhe da saúde e à identificação só a quem precisa.
- Peça que a "Finalidade" seja sempre verdadeira: ela é o que a auditoria lê.
- Os textos livres não devem trazer diagnóstico, CID ou CPF: o sistema recusa esses termos, mas não pega palavras clínicas comuns como "queimadura" ou "fratura". Oriente a equipe a descrever o evento, não o corpo.
- Anexos (entrevistas, evidências) abrem para coordenador, engenheiro, técnico, médico e superintendente; para secretaria e servidor não existem.

## 9. Relatório técnico

Aba "Relatórios", botão "Emitir relatório". Quem emite: coordenador, engenheiro, técnico, superintendente.

Condições (com a mensagem se faltar):

- Ocorrência em Em investigação: "O relatório só se emite com o caso em investigação."
- Síntese preenchida: "Preencha a síntese explicativa na Investigação antes de emitir o relatório."
- Caracterização escolhida: "Diga na Investigação se o evento se caracteriza como acidente em serviço antes de emitir o relatório."

O sistema emite duas variantes juntas, versão 1:

- "Completa (para a perícia do SIASS)", com o resumo da saúde.
- "Sem dados de saúde (contratada e fiscal)".

A emissão leva o caso a Relatório emitido e trava a investigação. A tabela "Relatório técnico" mostra Versão, Variante, Emitido, Situação (vigente ou retificada) e Arquivo ("Baixar PDF"). O PDF indica que a assinatura oficial é feita no SEI, no processo do caso.

**Quem baixa.** A variante Completa: engenheiro, técnico, médico, coordenador e superintendente; secretaria e servidor recebem recusa. A variante "Sem dados de saúde", pela permissão, também pode ser baixada pela secretaria e pelo próprio acidentado servidor, mas a tela deles não traz a tabela nem o botão (a aba Relatórios diz "Restrito à equipe que investiga"); só o endereço direto do arquivo abre. Emitir a variante completa lê a saúde e registra essa leitura em nome de quem emitiu.

Cuidado: a variante "Sem dados de saúde" leva nome, SIAPE, o relato do evento e o texto da análise do trabalho. Ela não tem saúde, mas não é anônima. Não a trate como pública, mesmo com a contratada ou o fiscal.

**Retificar o relatório.** Campo "Motivo da retificação" (pelo menos uma frase: "Diga o motivo da retificação (pelo menos uma frase)."). Gera a versão seguinte das duas variantes, com o que está vigente (CAT/SP, plano de ação, saúde). A anterior fica "retificada". O texto da investigação não é reaberto. Depois de Concluída: "O caso está concluído: o relatório não se retifica mais."

Atenção à data: o PDF mostra "emitido em" com o dia seguinte quando a emissão ocorre entre 21h e 23h59. A tabela da aba mostra a data certa. Em caso de dúvida, vale a da tabela e a da trilha.

## 10. SIASS, decisão da perícia e conclusão

Aba "SIASS" (coordenador, engenheiro, técnico, médico, superintendente).

**Encaminhar ao SIASS** (só com Relatório emitido):

1. Escolha o "Meio": Processo no SEI, Sistema do SIASS, E-mail institucional ou Presencial.
2. Se for SEI, informe o "NUP do SEI" (17 dígitos, exemplo fictício 23086.000000/2026-00).
3. Informe a "Data do encaminhamento" (não pode ser futura) e, se quiser, "Observação".
4. Clique em "Registrar encaminhamento".

Atenção: o sistema só registra. Ele não envia nada ao SIASS nem anexa o Anexo III. O envio real (SEI, e-mail, etc.) é feito por fora. O primeiro encaminhamento leva o caso a Encaminhada ao SIASS, fecha a tarefa do prazo de comunicação e abre a tarefa "Aguardar a decisão da perícia".

**Decisão da perícia** (só depois do encaminhamento). Campos: Resultado (Acidente em serviço reconhecido, Não reconhecido, Outro resultado), data da decisão, "CAT no SIASS" (número) e observação. Registrar de novo marca a anterior como "corrigida" e vale a última. A decisão alimenta o nexo causal do PDF do Anexo III.

**Concluir ocorrência.** Botão na seção "Concluir a ocorrência", com campo "Motivo".

- Com encaminhamento: exige a decisão da perícia ou o motivo de concluir sem ela.
- Sem encaminhar: só se a investigação marcou "Requer abertura da CAT/SP no SIASS?" = Não, e com motivo.
- Antes do relatório não se conclui.
- Mensagem de sucesso: "Ocorrência concluída."

Concluída é final: a investigação não reabre. A saída é uma nova comunicação.

**Reabrir a investigação (coordenação).** Com o caso em "Relatório emitido" ou "Encaminhada ao SIASS", a aba Comunicação mostra o botão "Reabrir a investigação" (rota `/acidentes/:id/reabrir`), só para a coordenação. Escolha o Motivo na lista: Corrigir a investigação ou o relatório, Informação nova sobre o caso, Encerrado por engano ou Outro motivo. O caso volta para "Em investigação", a investigação destrava, o responsável é mantido (ou passa a ser quem reabriu, se não havia) e a tarefa "Investigar ... e emitir o relatório" reabre com novo prazo. O relatório novo sai pela retificação e a CAT/SP mantém o mesmo número. O motivo fica na trilha só pelo código da lista. Fora desses estados, a recusa é "A ocorrência ... não está num ponto em que se reabra a investigação."; fora da coordenação, "Reabrir a investigação é com a coordenação."

## 11. Indicadores

Menu "Indicadores". Escolha o período por Ano (os 4 últimos) ou "Período livre" (De/Até), e clique em "Aplicar". "Exportar CSV" exige a permissão de exportar (coordenação, superintendência, engenheiro, técnico e médico têm; secretaria e servidor não). O arquivo traz colunas `dimensao;categoria;casos` separadas por ponto e vírgula, com o período, ano, espécie, campus, unidade e afastamento, e repete o sigilo ("—"). Atenção: "Por unidade do local" mostra "Sem unidade informada" com o total de casos (veja a seção 16).

Mostra: Ocorrências no período, "Casos com afastamento" e "Dias perdidos" (só para quem lê o nível 2 da saúde), Por ano, Por espécie, Por campus, Por unidade do local. Ocorrências canceladas ficam fora.

**Sigilo estatístico.** Recorte com menos de 5 casos aparece como "—". Quando só um recorte ficaria escondido, o menor dos outros também se esconde, para não dar para descobrir o número por subtração. Não tente contornar.

Como ler com cuidado:

- "Por unidade do local" sempre sai "Sem unidade informada", porque nenhum formulário grava essa informação. Não use esse recorte.
- As taxas de frequência e de gravidade ainda não existem (dependem das horas trabalhadas por unidade).
- Período invertido ou inválido: a tela recusa.

## 12. Trilha de auditoria (aba "Histórico") e privacidade

A aba "Histórico" da ficha lista (os 200 mais recentes, do mais novo ao mais antigo, com data, hora e quem agiu) os eventos da ocorrência: comunicação, assumir, mudança de situação, complementação, prorrogação (com motivo), retificação (com os campos e o motivo), investigação salva, checklist salvo, entrevistas e evidências, saúde alterada, aberturas de saúde por quem não conduz o caso, Anexo III emitido, relatório emitido, ações, encaminhamento, decisão, conclusão e envio de e-mail. Quem investiga ou encaminha ao SIASS vê (inclui o médico); a secretaria vê "Restrito à equipe que investiga".

O que a aba **não** mostra: o conteúdo de saúde e de identificação (de propósito) e **a finalidade** das aberturas. As aberturas de saúde e de identificação feitas por quem conduz o caso nem aparecem na aba; as feitas por quem não conduz aparecem como "Saúde do acidentado aberta por quem não conduz o caso" (e o equivalente para identificação), só com o nome de quem abriu.

**Onde está a finalidade:** em "Auditoria" (a coordenação, a superintendência e o administrador abrem; engenheiro, técnico e médico não), bloco "Acessos a dado sensível". Cada leitura mostra quando, quem, o campo (`acidente_saude_nivel_1`, `acidente_saude_nivel_2`, `acidente_identificacao`), o número do acidentado e a finalidade escolhida. A tela não traz o protocolo: cruze pelo número do acidentado e pela hora.

Uso pela coordenação: auditar quem abriu dado sensível e com qual finalidade (Auditoria), e se prazos foram prorrogados com motivo (Histórico da ocorrência).

Atenção: nos eventos "investigação salva" e "ação alterada", a trilha grava o texto antes e depois dos campos, e não só o nome do campo. Isso vai contra a regra de que a trilha guarda só identificadores. Por enquanto, trate a aba "Histórico" como restrita à equipe que investiga, não a mostre fora dela e comunique o responsável técnico.

## 13. Tarefas (pendências) que o módulo gera

Aparecem em "Pendências" (menu Meu espaço) com os nomes abaixo e fecham sozinhas quando o ato acontece:

| Tarefa | Prazo | Para quem |
|---|---|---|
| Triar a comunicação CAT-... | 2 dias | Equipe (sem dono até alguém assumir) |
| Prazo legal de comunicação de CAT-... (art. 214 da Lei 8.112) | 10 dias da data do acidente (ou o prorrogado) | Quem assume |
| Confirmar a saúde declarada em CAT-... | 5 dias | Médico (se houve lesão declarada) |
| Complementar a comunicação CAT-... | 5 dias | Quem comunicou |
| Investigar CAT-... e emitir o relatório | 30 dias | Quem conduz o caso |
| Cumprir a ação nº N de CAT-... | O da ação | Responsável |
| Aguardar a decisão da perícia sobre CAT-... | 60 dias | Quem conduz o caso (ou quem encaminhou) |

Detalhe: a tarefa de triar uma ocorrência restrita (menor de idade) aparece também para a secretaria, com o protocolo, mas ela não consegue abrir a ocorrência.

## 14. Erros e mensagens comuns

| Mensagem ou situação | O que significa e o que fazer |
|---|---|
| "A ocorrência ... foi alterada por outra pessoa depois que você abriu a tela..." | Alguém mexeu antes. Recarregue a ficha, confira e refaça. |
| "A investigação de ... foi salva por outra pessoa..." | Nada do que você digitou foi gravado. Compare, ajuste e salve de novo. Depois de cada "Salvar a investigação" a versão sobe: não salve duas vezes com a mesma tela antiga. |
| "A ocorrência ... está encerrada. Se o caso voltou, comunique de novo..." | Ocorrência Concluída ou Cancelada. Faça nova comunicação. |
| "Escolha a finalidade antes de abrir a saúde..." | Informe a finalidade antes de abrir. |
| "O relatório só se emite com o caso em investigação." | A situação não é Em investigação. |
| "A decisão da perícia se registra depois do encaminhamento ao SIASS." | Registre primeiro o encaminhamento. |
| "O NUP do SEI deve ter 17 dígitos (23086.000000/2026-00)." | Corrija o número do processo. |
| "A nova data tem de ser depois do prazo legal (...)." | Escolha data posterior ao prazo legal. |
| "Escreva o motivo da prorrogação." / "...da retificação." | O motivo é obrigatório. |
| "O campo ... tem termo de saúde ou dado sensível (...)." | Reescreva descrevendo o evento, sem diagnóstico, CID ou CPF. |
| "A ocorrência ... já está em investigação: cancelar só cabe antes disso." | Não dá para cancelar. Registre no relatório que não era acidente em serviço. |
| "O plano de ação é da equipe que investiga os acidentes." | Perfil sem acesso ao plano (secretaria). |
| Recusa de acesso ao baixar um PDF | O perfil não tem a permissão. O Anexo III em PDF exige permissão de identificação e de detalhe da saúde; para técnico e engenheiro o link nem aparece. |
| "Seu perfil não abre a saúde." / "Restrito à equipe que investiga" | O perfil não lê aquela aba. Se for necessário, ajuste o perfil em "Acesso por módulo" (Administrador do sistema ou Superintendente). |
| "Envios demais deste endereço." (link público) | Mais de 5 envios em 10 minutos do mesmo endereço de rede; a pessoa espera alguns minutos. |
| Tela de erro ao tentar um ato que não vale mais para a situação | Pode acontecer com tela antiga aberta ou duas pessoas mexendo. Recarregue a ficha e veja a situação atual. |
| Link público: "link inválido" | Link desligado, substituído ou digitado errado. Gere outro e redivulgue. |
| Link público parou de receber | Atingiu 30 comunicações a triar. Triar as pendentes. |
| Tela de erro ao abrir o detalhe da saúde | Veja a seção 8 e a seção 16. |

## 15. Glossário

- **CAT/SP:** Comunicação de Acidente em Serviço do servidor público. O sistema guarda versões; a anterior nunca se apaga.
- **Anexo III:** modelo de CAT/SP exigido pelo SIASS, com dados pessoais completos.
- **SIASS:** Subsistema Integrado de Atenção à Saúde do Servidor, que faz a perícia.
- **MAPA:** método de análise usado na aba "Investigação".
- **Protocolo:** número da ocorrência, no formato CAT-AAAA-NNNN (exemplo: CAT-2026-0001).
- **Prazo legal (art. 214):** 10 dias da data do acidente.
- **Prazo efetivo:** o prazo vigente: o prorrogado, se houver.
- **Ocorrência restrita:** de menor de idade; só a equipe de segurança do trabalho abre.
- **Quem conduz:** pessoa responsável pelo caso e pelo prazo.
- **Finalidade:** motivo declarado ao abrir saúde ou identificação; fica registrado.
- **Nível 1 e nível 2 (saúde):** resumo e detalhe.
- **Retificar:** gerar nova versão corrigida, sem apagar a anterior.

## 16. Limites conhecidos

Estas limitações foram observadas no teste. Leia antes de decidir como operar.

1. **Saúde, registro inicial.** O médico não consegue abrir o detalhe da saúde (nível 2) quando a natureza da lesão está vazia: a página dá erro. Enquanto não for corrigido, o registro inicial da saúde fica indisponível pela tela e a tarefa "Confirmar a saúde declarada" não fecha.
2. **Trilha com texto.** A aba "Histórico" guarda o texto da investigação e das ações, e não só identificadores. Trate-a como restrita.
3. **Identificação do Anexo III.** Pode entrar na comunicação e ser completada depois na aba Identificação (permissão acidente.identificacao_ver). A "Retificar a CAT/SP" não a inclui.
4. **Indicador "Por unidade do local".** Sempre "Sem unidade informada". Taxas de frequência e gravidade não existem ainda.
5. **Depois do relatório.** Não há como corrigir a síntese ou as escolhas da investigação, e o caso concluído não reabre. Com o relatório emitido ou encaminhado ao SIASS, a coordenação pode reabrir a investigação. Revise antes de emitir.
6. **Atos fora de hora.** Em tela antiga ou com duas pessoas mexendo, um ato que já não vale pode dar tela de erro em vez de mensagem. Recarregue a ficha.
7. **Data do PDF do relatório.** Entre 21h e 23h59 mostra o dia seguinte.
8. **Responsável legal de menor de idade.** O aviso "o responsável legal precisa ser avisado" não some e não há onde registrar que ele foi avisado. Registre o aviso por fora (SEI ou ofício).
9. **Relatório "Sem dados de saúde".** Leva nome, SIAPE e o texto do caso. A secretaria e o acidentado têm permissão de baixá-lo (a tela deles não mostra o botão, mas o endereço direto do arquivo abre), mesmo que a ficha o descreva como restrito.
10. **Quem conduz.** A secretaria pode conduzir sem poder investigar, e "Assumir" toma o caso de outra pessoa sem confirmar.
11. **Rótulo de origem.** A caixa "Sou eu o envolvido" já vem marcada. Quem comunica o acidente de outra pessoa com a própria conta (sem ser chefia nem de perfil de triagem) aparece como "Pelo próprio acidentado", mesmo desmarcando a caixa.
12. **Duplicadas.** Não são detectadas. Cancele com "Comunicação duplicada".
13. **Anexo III em PDF.** Só médico, coordenador e superintendente baixam; técnico e engenheiro não veem o link.
14. **Incidente / quase acidente.** Segue o fluxo de CAT, com prazo de 10 dias e SIASS.
15. **Só servidor.** Acidente de quem não é servidor é recusado na comunicação (com conta ou por link) e vai para Ocorrências.
16. **Aba "Análise".** Pede "Município e UF" mesmo com a UF já preenchida, e algumas mensagens de recusa usam termos internos (nomes de permissão).
17. **Tarefa de ocorrência restrita.** A secretaria vê a tarefa "Triar" de menor de idade, mas não consegue abrir a ocorrência.
18. **Itens que não se editam.** Linha do tempo, entrevistas e evidências não se editam nem se reordenam. O link público não reaparece depois de gerado.
19. **Filtro de saúde.** O sistema barra "diagnóstico", "CID" e "CPF", mas deixa passar termos como "queimadura" e "fratura". A conferência é da equipe.
20. **Encaminhar ao SIASS** só registra; não envia nada.
21. **Finalidade das leituras de saúde e identificação.** A aba "Histórico" não a mostra; só a tela "Auditoria", que engenheiro, técnico e médico não abrem. A leitura feita por quem conduz o caso não deixa evento na aba.
22. **Aviso de menor de idade.** A dica do formulário diz que "o responsável legal é avisado", mas o sistema não avisa ninguém.
23. **Acesso por módulo.** A coordenação só consulta; quem grava é o Administrador do sistema ou o Superintendente.

## 17. E-mails e expurgo (lido no código, não exercitado)

**E-mails.** O recurso nasce desligado e só envia se for ligado na instalação e houver servidor de e-mail configurado e um endereço do setor definido. Ligado, a mensagem leva só protocolo e endereço da ocorrência, nunca nome, relato nem saúde. Destinos: comunicação nova (endereço do setor e quem comunicou com conta); pedido de complementação (quem comunicou com conta); relatório emitido e caso concluído (acidentado servidor com conta, só "há novidade"). Quem comunicou pelo link público nunca recebe. Cada tentativa deixa um evento no Histórico dizendo para quem foi e para quem não foi, e por quê. Se o setor não receber os avisos de comunicação nova, confira com o responsável técnico se o endereço do setor está configurado.

**Expurgo.** Não há tela. É um ato manual do responsável técnico, em simulação por padrão e com ata, e só alcança ocorrência concluída há mais de 5 anos (padrão ainda a confirmar pelo encarregado de dados) e com decisão da perícia registrada. Apaga a identificação pessoal do acidentado, o endereço e telefone das testemunhas e o detalhe da saúde (nível 2); ficam parte do corpo, natureza da lesão, afastamento, óbito, sequela e dias debitados. Depois do expurgo a tela da saúde avisa "O detalhe (nível 2) foi expurgado e não se preenche de novo." Cabe à coordenação decidir quando pedir o expurgo.

**O que não foi testado e este manual, portanto, não descreve com certeza:** o envio real dos e-mails, a importação de registros antigos, o expurgo, o gravador de áudio do navegador, o rascunho local do formulário e o botão "Imprimir o checklist".
