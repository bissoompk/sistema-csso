# Manual do Coordenador: módulo Processos SEI (Sistema SISA)

## Para quem é este manual

Para quem responde pelo módulo "Processos SEI": a coordenação da CSSO e, no que couber, a superintendência. Aqui você encontra o que cabe a você (liberar acessos, manter catálogos e prazos, decidir, anular, conferir), a rotina de acompanhamento e como saber se o módulo está saudável. O passo a passo de quem instrui o processo no dia a dia está no manual do usuário do módulo.

Os exemplos usam dados fictícios. Este manual não traz senhas, CPF nem e-mails.

## Antes de começar

- **Perfil necessário:** coordenador (ou superintendente, que faz quase tudo igual, mas não assina parecer nem registra laudo).
- **O sistema não se comunica com o SEI.** O número do processo (NUP) é digitado e o parecer é assinado no próprio SEI. O SISA guarda o controle, o parecer em rascunho e a marcação de que foi assinado.
- **Menu lateral do módulo:** Painel, Kanban, Processos, Laudos, Adicionais, Relatórios e Importar. Fora do menu do módulo, mas ligadas a ele: Pendências, Demandas, Auditoria, Catálogos, Usuários e a Configuração (engrenagem no topo, onde ficam os prazos).
- **Quem entra em cada tela** (resumo):

| Perfil | O que faz no módulo |
|---|---|
| Coordenador, engenheiro de segurança, médico do trabalho | Acesso total ao módulo e ao ciclo do parecer. Registram laudo (exige habilitação), anulam parecer e assinam parecer só se forem o signatário ou substituírem declarando motivo. |
| Técnico de segurança | Cria e instrui processo, edita e emite parecer, move estados, anexa, propõe e concede adicional. Não registra laudo, não assina e não anula parecer. |
| Secretaria | Cria e instrui processo, anexa. Só lê parecer e laudo. Não exporta a lista em CSV e não atribui responsável em lote. Vê o servidor apenas como código (SRV-xxxx). |
| Superintendente | Como o coordenador (inclusive anular parecer, atribuir responsável, importar e ajustar prazos e catálogos), sem assinar nem registrar laudo. |
| Almoxarife e administrador de TI | Sem acesso ao módulo. O administrador de TI também não vê Pendências nem Demandas. |
| Servidor (consulta) | Não tem as telas do módulo. Hoje ele não acompanha o próprio processo de adicional. |

- **Só coordenador e superintendente** abrem "Importar" e a Reconciliação.
- Concessão e retirada de acessos ficam na tela **Usuários** ("Contas, perfis e permissões"). Quem recebe um perfil herda as permissões da tabela acima.

## Sumário

1. O que é só seu
2. Rotina de acompanhamento (diária, semanal, mensal)
3. Painel
4. Processos: lista, criação, correção e estados
5. Kanban
6. Laudos
7. Pareceres: emitir, assinar e anular
8. Adicionais
9. Pendências
10. Demandas
11. Relatórios e exportação
12. Importar e Reconciliação
13. Prazos (SLA) e catálogos
14. Privacidade e auditoria
15. Situações (estados) e o que significam
16. Mensagens comuns e o que fazer
17. Glossário
18. Limites conhecidos

---

## 1. O que é só seu

| Decisão ou ação | Onde |
|---|---|
| Anular parecer (também engenheiro, médico e superintendente; técnico e secretaria não) | Parecer > "Anular parecer" (só parecer Emitido ou Assinado) |
| Atribuir responsável em lote (também engenheiro, médico, superintendente) | Processos > "Ações em lote" |
| Importar planilha e quadro do Trello; abrir Reconciliação | "Importar" |
| Ajustar os prazos por coluna (SLA) e os catálogos | Configuração (engrenagem) e "Catálogos" |
| Conceder e retirar perfis | "Usuários" |
| Cessar adicional, suspender, retomar, conceder | "Adicionais" > "Gerir" (também o técnico faz) |
| Marcar laudo como superado | Ficha do laudo (só quem tem habilitação técnica vigente) |
| Consultar a trilha de acessos a dado sensível | "Auditoria" |

## 2. Rotina de acompanhamento

**Todo dia (5 a 10 minutos)**
1. Abra o **Painel**. Veja "Acima do SLA" e "Precisam de você hoje".
2. Clique em "ver a fila" (cartão "Acima do SLA") e distribua ou cobre os processos parados.
3. Abra **Pendências** com o filtro "Todas" e veja o aviso "N de M passaram do prazo".

**Toda semana**
1. Em **Processos**, use as visões prontas: "Atrasados", "Parados há mais de 90 dias", "Sem nº SEI", "Sem percentual" e "Sem parecer assinado anexado".
2. Em **Adicionais**, confira o bloco "Pareceres emitidos sem direito registrado" e dê o encaminhamento ("Propor direito").
3. Em **Pendências**, confira se o que foi concluído foi mesmo feito (o sistema não confere por você).
4. Em **Demandas**, veja as "Em aberto" e as que passaram do prazo.
5. No Painel, veja o bloco "Laudos sem conferência".
6. Confira se os processos com parecer emitido ou assinado estão mesmo em "Parecer pronto para assinatura" ou "Parecer assinado": se o parecer foi emitido com o processo em outro ponto, o estado não acompanha e ninguém é avisado.

**Todo mês**
1. Em **Relatórios**, escolha o "Exercício" e clique em "Ver". Leia "Lacunas de numeração" e "Laudos nunca conferidos ou há mais de 24 meses".
2. Em **Importar > Reconciliação**, veja os achados abertos (NUP com dígito verificador inválido, órfãos, conflito de numeração).
3. Em **Auditoria**, olhe os "Acessos a dado sensível" e as linhas de "Assinatura negada".
4. Revise com a equipe os processos em "Sobrestado" e os adicionais em "Em reavaliação".

**Como saber que o módulo está saudável**
- "Acima do SLA" baixo e sem processos parados há mais de 90 dias.
- Nenhum adicional vigente com parecer anulado ou laudo superado sem tratamento.
- Todo parecer emitido com sua pendência "Incluir o parecer assinado no SEI" concluída de fato.
- Lacunas de numeração explicadas (parecer anulado ou número reservado).
- Reconciliação sem achados novos.

## 3. Painel

Menu "Painel". Cartões:
- "Em andamento" e "Aguardando" (laudo, documento ou SEI).
- "Acima do SLA", com o link "ver a fila".
- "Concluídos em 2026" e "Dias médios até a emissão".
- "Subscritores habilitados": quantos profissionais podem assinar laudo e parecer. Se este número cair para zero, ninguém consegue registrar laudo nem assinar.
- "Precisam de você hoje" (link "Ver todos"): processos acima do SLA ou ainda em "A fazer".

Quem opera também o módulo Gestão de EPI vê o cartão "EPI · pedidos a analisar" (atalho "Abrir a fila"). Também há os gráficos "Pareceres emitidos por mês" e "Distribuição por tipo de risco", o bloco "Laudos sem conferência" e "Últimos eventos". O botão "Novo processo" fica no topo e o sino "Minhas pendências" leva às suas tarefas.

Observação: o laudo não tem prazo de validade (IN 15/2022, art. 10, §3º). A lista de laudos sem conferência é fila de trabalho, não vencimento.

## 4. Processos

### 4.1 Lista

Menu "Processos". Há o alternador **Quadro | Tabela**.
- **Visões prontas:** "Minha fila", "Precisam de você hoje", "Atrasados", "Parados há mais de 90 dias", "Sem nº SEI", "Sem percentual", "Reavaliação pendente – químicos", "Campus Avançados", "Sem parecer assinado anexado". "Limpar" desfaz.
- **Filtros:** "Buscar (servidor, SIAPE, NUP, laudo)" (atalho Ctrl+K), "Estado técnico", "Tipo", "Unidade", "Responsável", "Agrupar por". Botões "Filtrar" e "Limpar".
- Cartões vindos de repositório ou Trello ("Campus Avançados") ficam fora da lista padrão. Só aparecem pela visão "Campus Avançados".

### 4.2 Ações em lote

1. Marque os processos nas caixas à esquerda.
2. No painel "Ações em lote", escolha a "Ação": "Mover estado", "Atribuir responsável" ou "Definir prazo".
3. Preencha "Estado de destino", "Inciso do art. 11", "Responsável", "Prazo" ou "Comentário", conforme a ação.
4. Clique em "Aplicar aos selecionados".

Cada processo é avaliado sozinho: o que a regra recusar volta com o motivo e o resto passa. Mensagens: "N processo(s) atualizado(s)." e "N não passaram: ..." (mostra até 5).

Atenção:
- Deixar "Responsável" em branco **retira** o responsável.
- O responsável precisa ser uma conta ativa que trabalhe processos.
- O "Prazo" aceita data passada e não dispara alerta. Ele só aparece na lista e no CSV.

### 4.3 Criar um processo

Botão "Novo processo". O número é digitado ("a v1 não integra com o SEI").
1. **NUP:** cole do SEI. Formato `23086.NNNNNN/AAAA-DD`. Pontuação, espaço e traço são acertados sozinhos.
2. **Tipo:** Acidente em Serviço, Adicional Ocupacional (já vem escolhido), Aposentadoria Especial, Consulta Normativa, Parecer Técnico, PGD, PGR, Revezamento, RITS.
3. **Data de autuação:** a do SEI. Não pode ser futura.
4. **Servidor:** use "Buscar servidor" e confira pelo SIAPE, nunca pelo nome.
5. **Unidade / UORG:** preencha sempre. O laudo vale pela unidade e, sem ela, o processo de adicional não chega a "Laudo emitido".
6. **Observações:** sem estado de saúde, diagnóstico ou gestação. CPF e CID nunca.
7. Clique em "Criar". O processo nasce em "Recebido" e o responsável é quem criou.

**Confira o NUP e o tipo antes de "Criar": depois não se corrigem (ver Limites conhecidos).**

Caixa "dígito verificador diverge, mas confirmei o número no SEI": use só depois de conferir no SEI. A dispensa fica na auditoria e o processo reaparece em Importar > Reconciliação.

### 4.4 Ficha do processo

Abas: **Dados**, **Parecer**, **Anexos**, **Checklist**, **Histórico**.
- **Dados:** blocos "Identificação" (link "Corrigir dados"), "Estado técnico" (botão "Mover de estado") e "Caminho até o SEI" (com "NUP para copiar" e botão "Salvar link do SEI").
- **Corrigir dados:** troca o servidor, a unidade, a data de autuação, a "Solicitação no SEST" e as observações. Cada mudança vira linha no Histórico. Não corrige NUP, tipo nem responsável.
- **Salvar link do SEI:** o link deve começar com `https://sei.`. Campo vazio remove o link. O botão "Abrir no SEI" só aparece depois que o link é salvo.
- **Anexos:** botão "Enviar anexo" (campos Arquivo, Categoria, "Nº do documento SEI"). Categorias: Parecer assinado, Laudo, Portaria de localização, Despacho, Formulário, Relatório de campo, Foto, Outro. Limite de 4 MB por arquivo. Arquivo idêntico já anexado é ignorado. Não existe botão para remover ou trocar um anexo.
- **Checklist:** "Criar checklist avulso" ou modelo. O checklist não trava nenhum estado. Os modelos ficam em Catálogos > Checklists modelo.
- **Histórico:** botão "Comentar". O comentário vira linha de auditoria, então não escreva dado de saúde.

### 4.5 Mover de estado

Botão "Mover de estado". Há "Próximo passo" (só os destinos permitidos agora, mais "Sobrestar") e "Avançar vários passos > Ir direto para", que exige marcar "Confirmo pular etapas". Para indeferir, informe o "Inciso do art. 11". Clique em "Mover".

Exigências do adicional ocupacional que você precisa conhecer para decidir exceções:
- **Sair da triagem** (de "Recebido" ou "Em triagem") para frente, **inclusive para "Indeferido tecnicamente"**: anexar "Portaria de localização" e "Formulário" assinado pelo servidor e pela chefia (art. 17).
- **Sair de "Aguardando quantificação":** anexo "Relatório de campo" **ou** comentário de pelo menos 20 caracteres justificando a avaliação qualitativa.
- **Ir a "Laudo emitido":** precisa haver laudo que sirva ao processo: laudo vinculado a ele, laudo usado por parecer dele (não anulado) ou laudo vigente da mesma unidade.
- **"Parecer pronto para assinatura" e "Parecer assinado"** não se escolhem à mão: vêm da emissão e da assinatura do parecer. Só vêm se o processo ainda estiver atrás e as exigências do caminho estiverem cumpridas (se estiver mais atrás, o sistema avança vários estados de uma vez). Se não puder, o parecer é emitido ou assinado do mesmo jeito, o processo **fica onde estava** e a mensagem de sucesso não avisa. Confira na ficha, sobretudo depois de anular e reemitir (o processo continua em "Parecer assinado" e não volta).
- **"Inserido no SEI" e "Concluído":** só depois do parecer assinado.
- **Indeferimento técnico:** exige o inciso do art. 11 (I exposição eventual; II atividade-meio sem exposição ao agente nocivo; III local inadequado por gestão deficiente, sanável por medida administrativa; IV chefia sem comprovação individual de exposição).
- **Sobrestar** não pede motivo. Para sair, use "Voltar do sobrestamento", que devolve o processo ao estado anterior. Peça sempre um comentário.
- **"Arquivado" é definitivo:** não tem saída.
- Não existe retrocesso de estado. "Concluído" e "Indeferido tecnicamente" podem ir a "Em recurso", que volta a "Em triagem".

Os outros tipos de processo (PGR, RITS, acidente, consulta, parecer técnico, aposentadoria especial etc.) usam um caminho curto: Recebido, Em triagem, Pendente de documento, Concluído ou Arquivado. Recebido e Em triagem vão e voltam, dá para concluir direto de Recebido, e um processo concluído só reabre em "Em triagem" (não há "Em recurso"). Esse caminho não tem exigências de saída. No Kanban, "Em triagem" desses processos fica na coluna "Em andamento".

## 5. Kanban

Menu "Kanban". Colunas: Não iniciado, A fazer, Em andamento, Aguardando, Concluído. A coluna é só visão; o estado técnico é a verdade.
- Arraste o cartão ou use os botões "Mover para…". Soltar numa coluna usa o primeiro passo permitido (em "A fazer" vai para "Em triagem"; em "Aguardando" vai para "Pendente de documento").
- As mesmas exigências de anexo valem. Estados que dependem de documento (parecer) não aparecem como destino.
- Filtros: Buscar, Tipo, Exercício, Responsável e "só acima do SLA". O link "Backlog" mostra cartões de repositório.
- Use o Kanban para ver gargalo por coluna. Para decisões, prefira a ficha do processo.

## 6. Laudos

Menu "Laudos". Filtro de situação: Todos, Vigentes, Superados. Busca por número SIAPE, unidade ou subscritor.

**Cadastrar laudo** (só quem tem habilitação técnica vigente: coordenador, engenheiro, médico): botão "Cadastrar laudo" com Nº SIAPE (formato `26255-000.125/2019`), Data de emissão, Tipo de adicional, Unidade, "Subscritor habilitado" e a caixa "laudo coletivo (cobre um posto inteiro, não um servidor)".

**Ficha do laudo:**
- **Editar dados do laudo:** data de emissão, data da avaliação (não pode ser depois da emissão), subscritor e nº do documento SEI (só dígitos, até 10). Número, tipo e unidade não se editam: corrigir isso é cadastrar laudo novo que supera o antigo.
- **Registrar conferência:** exige o campo "Motivo".
- **Vincular posto:** sem posto o laudo não alcança nenhum servidor. O sistema não confere se o posto é da mesma unidade do laudo, então confira você.
- **Marcar como superado:** informe o "Motivo" e marque a caixa de ciência. Efeito imediato: o laudo vira "superado", cada adicional vigente que dependia dele passa a "Em reavaliação" e nasce a pendência "Reavaliação por laudo superado" (90 dias). **Não há como desfazer.** Os pareceres derivados continuam aparecendo como "Assinado".

## 7. Pareceres

O parecer é criado na aba **Parecer** do processo (botão "Novo parecer") e editado em tela própria. Situações: Rascunho, Emitido, Assinado, Anulado.

### 7.1 O que você confere antes de emitir

O painel de validação mostra "N bloqueio(s)" ou "pronto para emitir". Bloqueios típicos: falta laudo, portaria de localização, marco inicial, data do marco, recomendação, signatário, tipo de adicional ou exposição.

O sistema **deixa** emitir com laudo superado ou de unidade diferente da do processo. Quando você revisa, confira por conta própria: o laudo é vigente e da mesma unidade do processo.

**EPI na exposição:** abaixo da tabela de exposições há um painel de EPI por agente, com as entregas do servidor e a pergunta "O EPI neutraliza este agente?". Alegar neutralização (parcial ou total) exige justificativa escrita e habilitação técnica vigente; para periculosidade o sistema só aceita "não avaliado" ou "não neutraliza". O sistema marca como "não sustenta" a entrega com CA vencido na data da avaliação, troca vencida ou equipamento devolvido. Ao revisar, leia essa avaliação: ela reduz ou cessa direito de alguém.

Dica: se o parecer emitido depende de agente químico, o texto de reavaliação é obrigatório e nasce a pendência "Avaliação quantitativa de agente químico" (180 dias).

### 7.2 Emitir

Botão "Emitir (consome número)…" e confirmação. O número é o próximo da sequência do ano. Efeitos: o conteúdo fica congelado ("Parecer emitido é imutável. Crie uma nova versão."), o processo vai sozinho a "Parecer pronto para assinatura" e abre a pendência "Incluir o parecer assinado no SEI" (10 dias).

**PDF:** a versão em nuvem não gera PDF. Use "Gerar DOCX", abra no Word, "Salvar como PDF" e suba no SEI. O .docx traz nome e matrícula do servidor mesmo para quem não os vê na tela; o download fica registrado.

### 7.3 Assinar

A assinatura é feita no SEI. No sistema, só o signatário clica em "Marcar como assinado". Outra pessoa habilitada pode assinar como substituta, informando o motivo; fica na trilha como substituição. O técnico não pode marcar (a recusa fica na trilha como "Assinatura negada"). O processo avança sozinho para "Parecer assinado".

Não há envio do PDF assinado nessa tela. O anexo "Parecer assinado" é feito na aba Anexos do processo, e nada exige que ele exista.

### 7.4 Anular

Botão "Anular parecer" (só aparece para parecer Emitido ou Assinado e para quem tem a permissão: coordenador, engenheiro, médico e superintendente), com o campo "Motivo" obrigatório. Resultado: "Parecer anulado." O número não volta (a reemissão recebe outro) e o conteúdo fica preservado. O estado do processo também não muda.

**Depois de anular, você precisa tratar à mão:**
1. Em **Adicionais**, o direito proposto ou vigente que vinha do parecer anulado continua lá. Ajuste-o (por exemplo, "Cessar") se for o caso.
2. Em **Pendências**, as pendências abertas do parecer não se fecham sozinhas.
3. Na aba **Parecer** do processo, clique em "Novo parecer". O novo rascunho **começa em branco**: não copia o anulado, então a pessoa precisa digitar de novo.

## 8. Adicionais

Menu "Adicionais". Mostra o direito concedido: servidor, estado, tipo e percentual, laudo, portaria de concessão e vigência. Filtro "Estados": Todos, Proposto, Vigente, Suspenso, Em reavaliação, Alterado, Cessado.

Regra: no máximo um adicional vigente por servidor (IN 15/2022, art. 4º).

**Propor direito:** no bloco "Pareceres emitidos sem direito registrado", botão "Propor direito". Aparece já para parecer só emitido, antes da assinatura. O direito fica "proposto", aguardando a portaria.

**Em "Gerir":**
- **Conceder:** campos "Portaria de concessão", "Data da portaria" e "Efeito financeiro a partir de" (vem com a data do marco). Botão "Conceder". Resultado: "Adicional em vigor." O parecer informa; o direito só existe depois da portaria da PROGEP.
- **Suspender:** escolha o "Motivo" e a "Base legal". A tela não pergunta a data da suspensão.
- **Alterar percentual:** novo percentual e motivo. O estado vira "Alterado".
- **Retomar:** campo "Vigente a partir de". A data digitada **substitui** a data de início exibida em "Vigência". A original só fica na Auditoria.
- **Cessar:** data de término, motivo e a caixa "Confirmo a cessação deste adicional." Cessado não se retoma: voltar a receber exige parecer novo.

**Quando o servidor já tem adicional vigente:** a mensagem pede o "registro de opção do servidor", mas **não existe tela para anexá-lo**. O caminho que funciona hoje é cessar o adicional antigo primeiro e depois conceder o novo.

"Em reavaliação" só se sai por "Retomar" ou "Cessar". Ele vem sozinho quando o laudo é marcado como superado.

Cuidado: a tela aceita data da portaria no futuro. Confira a data na portaria antes de conceder.

## 9. Pendências

Menu da base, "Pendências". São tarefas que nascem de uma regra, com dono e prazo. Não se criam à mão. Filtros "Todas" e "Só as minhas". Botão "concluir" para o responsável ou quem tem permissão no módulo.

Tipos do módulo (prazo padrão):
- "Incluir o parecer assinado no SEI" (10 dias).
- "Avaliação quantitativa de agente químico" (180 dias).
- "Reavaliação por laudo superado" (90 dias).
- "Reavaliar o adicional após entrega de EPI" (90 dias).
- "Resolver conflito de numeração da migração" (30 dias).
- "Demanda com prazo a cumprir" e "Ler o desfecho da sua demanda" (15 dias).

Pontos de atenção para você:
- Concluir **não confere** se o trabalho foi feito. A pendência "Incluir o parecer assinado no SEI" fecha mesmo sem nº do documento SEI.
- As pendências **não se fecham sozinhas** quando o processo vai a "Inserido no SEI" ou "Concluído", nem quando o parecer é anulado. Peça à equipe para fechar, e confira na revisão semanal.
- Fechar a pendência apaga a regra que a abriu: só conclua depois de fazer.
- "Conferir laudo sem conferência há mais de 24 meses" e "Anexar o registro de opção do servidor" estão declaradas, mas ainda não nascem sozinhas.
- A lista traz também tarefas de outros módulos (EPI: "Certificado de Aprovação do lote a vencer", "Anexar o comprovante assinado de EPI", "Troca de EPI vencida"). "Reavaliar o adicional após entrega de EPI" (90 dias) nasce no módulo de EPI mas a reavaliação é trabalho deste módulo, num parecer novo com movimento "reavaliação".

## 10. Demandas

Menu da base, "Demandas": o que chegou por e-mail ou balcão e ainda não é processo SEI. Situações: Em aberto, Abertas, Em andamento, Encerradas.

- **Registrar demanda:** Assunto (obrigatório), Como chegou, Data de chegada, Prazo, quem demandou, Descrição e Responsável.
- **Na ficha:** "Marcar em andamento", "Encaminhar" (exige "O que foi pedido"), "Trocar responsável" e "Encerrar demanda".
- **Desfechos:** Resolvida; Virou processo SEI (pede NUP e tipo); Encaminhada a outro setor (setor e data); Sem providência (escreva o motivo). Encerrar é definitivo: não reabre e não permite editar o assunto.
- Demanda com prazo abre a pendência "Demanda com prazo a cumprir".
- A tela diz que o nome de quem demandou é obrigatório, mas o sistema registra sem nome ("Quem pediu: não identificado").

## 11. Relatórios e exportação

Menu "Relatórios", com seletor "Exercício" e botão "Ver". Blocos:
- "Processos por unidade" (inclui "(sem unidade)"): confira os processos sem unidade e corrija.
- "Pareceres por tipo de risco" (sem os anulados).
- "Lacunas de numeração": números da sequência do ano que nenhum parecer usa.
- "Laudos nunca conferidos ou há mais de 24 meses".
- "Adicionais vigentes por laudo".

**Exportar processos:** gera `processos.csv` (separador ponto e vírgula) com NUP, Estado, Servidor, SIAPE, Unidade, Responsável, Autuação e Prazo. Aceita o filtro da lista. Nome e SIAPE só aparecem para quem lê dado nominal; a secretaria vê o relatório mas não exporta.

Não há exportação de pareceres, laudos nem adicionais.

## 12. Importar e Reconciliação

Menu "Importar" (só coordenador e superintendente). Etapas: Escolher o arquivo, Simular, Revisar o relatório, Aplicar. Nada é descartado em silêncio.

- **Quadro do Trello (.json):** campos "Arquivo exportado do quadro", "aplicar de verdade" e "baixar os anexos agora (as URLs do Trello expiram)". **Sem marcar "aplicar de verdade", só simula**: nada é gravado. Reaplicar não duplica o histórico.
- **Planilha de pareceres (.xlsx):** campo "Arquivo da planilha" e caixa "aplicar de verdade". Esta função ainda não foi conferida com a planilha real: simule sempre primeiro e leia o relatório.
- A simulação mostra, entre outros, "Cartões lidos", "Processos", "Órfãos de processo" (cartão sem NUP), "Listas não mapeadas" e "Conflito de numeração".
- O painel "Rejeitados" guarda a linha que não entrou, com o motivo. O conteúdo bruto é apagado 90 dias após o fim da migração.

**Reconciliação** (`Importar` > link de Reconciliação): cinco relatórios, "Órfãos de processo", "Órfãos de parecer", "Conflito de numeração", "NUPs com dígito verificador inválido" e "Divergência de marco inicial", mais os "Rejeitados na carga". Cada achado tem o link "abrir processo", e há exportação `reconciliacao.csv`. **A Reconciliação só lê**: nenhum achado se resolve sozinho e não existe botão para marcá-lo como conferido. O achado de dígito verificador dispensado continua na lista para sempre.

## 13. Prazos (SLA) e catálogos

- **SLA por coluna:** em Configuração, "SLA por coluna", em dias corridos, edita quem tem permissão de gerir catálogos. Padrão: A fazer 15, Em andamento 30, Aguardando 20. "Não iniciado" e "Concluído" têm 0 (alerta desligado).
- O contador de dias reinicia a cada mudança de **estado** (o texto da tela diz "coluna").
- Os catálogos (campi, unidades, postos, cargos, agentes nocivos, textos padrão, checklists modelo) ficam em "Catálogos". Mantenha as unidades e os postos atualizados: o laudo e o parecer dependem deles.
- O catálogo de profissionais habilitados define quem pode ser subscritor. Confira os dados de cada um, inclusive a matrícula do signatário, que aparece na linha de assinatura do parecer.
- Em Configuração aparecem ainda, só para leitura, o **Setor emissor** (com histórico de siglas e vigências: reimprimir parecer antigo sai com o cabeçalho antigo) e a **Autoridade destinatária** do parecer. Para cadastrar ou editar esses dois, use Catálogos. Alterar o prazo de coluna exige gerir catálogos **e** operar o módulo (coordenador e superintendente).
- O botão **"Exportar tudo (.zip)"**, em Configuração, leva dados pessoais de servidores: nunca copie o pacote nem os anexos para nuvem pessoal ou de terceiros sem autorização formal da UFVJM.
- O "Prazo" do processo (campo da lista) é só informativo: não dispara alerta. Para controlar prazo de verdade, use o SLA e as pendências.

## 14. Privacidade e auditoria

- A secretaria não lê o nome do servidor: vê o código SRV-xxxx e, no Histórico, as linhas aparecem como "conteúdo suprimido" (mesmo para mudança de estado). Isso é proposital.
- Técnico, engenheiro, médico e coordenador leem nome e SIAPE. Cada leitura nominal e cada download de anexo ficam em "Acessos a dado sensível" (menu "Auditoria").
- O download do .docx do parecer traz o nome do servidor e fica registrado.
- Campos de texto livre (Observações, Comentário, Descrição de demanda) barram termos como "cid-10", "cpf", "diagnóstico" e "doença", e pedem confirmação para "gestante". A confirmação fica na auditoria.
- A trava não reconhece tudo: "CID F32" ou "depressão" passam. Oriente a equipe a descrever o agente nocivo e o ambiente de trabalho, não a pessoa.
- Pendências, Demandas e a trilha de Auditoria seguem o mesmo cuidado.
- Páginas de recusa mostram "403 — acesso negado". Quando alguém reclamar disso, confira o perfil em "Usuários".

## 15. Situações (estados) e o que significam

**Adicional ocupacional (caminho longo):**

| Estado | Coluna no Kanban | Significado |
|---|---|---|
| Recebido | A fazer | Processo recém-criado. |
| Em triagem | A fazer | Conferência inicial dos documentos. |
| Aguardando inspeção | Em andamento | Inspeção marcada. Daqui só se segue para "Inspecionado" (ver Limites). |
| Inspecionado | Em andamento | Inspeção feita. |
| Aguardando quantificação | Aguardando | Esperando medição do agente. |
| Laudo em elaboração | Em andamento | Laudo sendo redigido. |
| Laudo emitido | Em andamento | Existe laudo vigente na unidade. |
| Parecer em elaboração | Em andamento | Rascunho do parecer. |
| Parecer pronto para assinatura | Aguardando | Parecer emitido. |
| Parecer assinado | Em andamento | Signatário marcou a assinatura. |
| Inserido no SEI | Em andamento | Documento incluído no SEI. |
| Devolvido à PROGEP | Aguardando | Processo devolvido. |
| Concluído | Concluído | Fim do processo. |
| Pendente de documento | Aguardando | Falta documento. |
| Sobrestado | Aguardando | Parado. |
| Indeferido tecnicamente | Concluído | Indeferido com inciso do art. 11. |
| Arquivado | Concluído | Definitivo. |
| Em recurso | Em andamento | Reaberto por recurso. |

**Parecer:** Rascunho, Emitido, Assinado, Anulado.
**Adicional:** Proposto, Vigente, Suspenso, Em reavaliação, Alterado, Cessado.
**Laudo:** vigente, superado.
**Demanda:** Em aberto, Abertas, Em andamento, Encerradas.

## 16. Mensagens comuns e o que fazer

| Mensagem | O que fazer |
|---|---|
| "NUP deve ter 17 digitos..." | Cole o número completo do SEI. |
| "NUP dígito verificador não confere..." | Confirme no SEI. Se estiver certo, marque "confirmei no SEI". |
| "NUP já existe processo com este NUP" | Use o link "Abrir o processo que já tem este NUP". Vale também para processo arquivado. |
| "Para avançar vários passos de uma vez, marque “Confirmo pular etapas”." | Marque a caixa. A frase também aparece, de forma enganosa, ao tentar mover para o estado em que o processo já está ou para um estado sem saída. |
| "Transição proibida: A → B..." | A mensagem lista os destinos permitidos. Escolha um deles. |
| "anexe a portaria de localização" / "anexe o formulário..." | Envie os anexos na aba Anexos e repita. |
| "“Laudo emitido” exige o laudo no sistema..." | Cadastre o laudo em Laudos, na mesma unidade do processo. |
| "sem parecer assinado neste processo..." | O parecer precisa ser emitido e marcado como assinado. |
| "Bloqueado: a IN SGP/SEDGG/ME nº 15/2022, art. 10, §2º, I..." | Quem não tem habilitação não assina. Encaminhe ao signatário. |
| "Parecer emitido é imutável. Crie uma nova versão." | Anule o parecer (coordenador) e crie "Novo parecer". |
| "PDF indisponível — abra o .docx no Word..." | Use "Gerar DOCX" e salve como PDF no Word. |
| "o servidor já tem adicional vigente..." | Cesse o antigo primeiro (ver capítulo 8). |
| "o agente 'X' exige avaliação quantitativa..." | Preencha o texto de reavaliação. |
| "não há laudo que caracterize a exposição nesta data..." | O marco inicial é anterior à emissão do laudo. Use marco igual ou posterior. |
| "não consegui ler a data no texto da portaria..." | Preencha a data no campo "Publicação" (a leitura automática só entende o mês por extenso). |
| "Você não tem permissão para atribuir responsável: nenhum processo foi alterado." | Peça a quem tenha a permissão (coordenador, engenheiro, médico, superintendente). |
| "Responsável inválido..." | Escolha uma conta ativa que trabalhe processos. |
| "O arquivo tem N MB e o limite é 4 MB..." | Reduza o PDF e envie de novo. |
| "Você mesmo salvou este parecer em outra aba..." | Nada foi gravado. Copie o que está no quadro "Não gravado" e reabra o parecer. |
| "O campo ... contém termo proibido..." | Reescreva sem dado de saúde. |

## 17. Glossário

- **NUP:** número único do processo no SEI.
- **SEI:** sistema de processos eletrônicos da universidade.
- **Parecer técnico:** documento da CSSO que fundamenta o adicional.
- **Laudo:** avaliação técnica do ambiente. Um laudo sustenta vários pareceres.
- **Posto:** local de trabalho coberto pelo laudo.
- **UORG:** código da unidade de lotação no SIAPE.
- **Marco inicial:** data de onde o direito conta (portaria de localização, de concessão, solicitação ou início do exercício no posto).
- **SLA:** prazo em dias para um processo ficar em cada coluna.
- **Sobrestar:** pausar o processo.
- **Adicional vigente:** direito em vigor, depois da portaria de concessão.
- **PROGEP:** Pró-Reitoria de Gestão de Pessoas.

## 18. Limites conhecidos

O módulo funciona, mas tem pontos em que você precisa agir à mão ou ficar atento. Eles estão em ordem de importância para o seu trabalho.

**Os que mais atrapalham**
1. **Tipo do processo e NUP não se corrigem.** O NUP de um processo arquivado continua bloqueado e não pode ser reutilizado. Confira antes de criar.
2. **Depois de "Aguardando inspeção" só se segue para "Inspecionado".** Daí não se arquiva, não se indefere e não se volta. A saída é "Sobrestar". Não existe retrocesso de estado em lugar nenhum.
3. **Conceder adicional sobre outro vigente** exige um "registro de opção" que não tem tela. Cesse o antigo antes.
4. **Anular parecer não mexe no adicional nem nas pendências.** Trate os dois à mão (capítulo 7.4). O parecer novo começa em branco e "Novo parecer" permite criar rascunhos duplicados: confira a aba antes.

**Os que pedem conferência sua**
5. O parecer pode ser emitido com laudo superado ou de unidade diferente da do processo. "Laudo emitido" e o atalho de reúso conferem a unidade, mas não o posto, apesar do que a mensagem diz.
6. O processo vai a "Inserido no SEI" e "Concluído" sem nº do documento SEI e sem o parecer assinado anexado. Use a visão "Sem parecer assinado anexado" e "Sem nº SEI" na revisão semanal.
7. As pendências do SEI não fecham sozinhas e "concluir" não confere o trabalho.
8. O filtro de dado de saúde não reconhece tudo (por exemplo, "CID F32", "depressão").
9. "Retomar" sobrescreve a data de início exibida do adicional e "Suspender" não pergunta a data. A data original fica só na Auditoria.
10. "Conceder" aceita data da portaria no futuro.
11. Indeferir já na triagem exige anexar a portaria e o formulário antes.
12. A mensagem de erro ao mover para o estado atual ou para um sem saída é enganosa (pede "Confirmo pular etapas").

**Os de menor impacto**
13. A secretaria vê "conteúdo suprimido" até para mudança de estado no Histórico.
14. Atribuir responsável a um processo só existe pelas ações em lote da lista (não há campo na ficha).
15. Anexos não podem ser removidos nem trocados e aceitam qualquer tipo de arquivo.
16. O cadastro e a conferência de laudo não deixam linha própria na trilha de auditoria.
17. O "Prazo" do processo não tem efeito e aceita data passada.
18. O servidor requerente não acompanha o próprio processo de adicional.
19. Os relatórios não extraem pareceres, laudos nem adicionais.
20. As telas de recusa mostram o nome técnico da permissão.
21. Alguns textos da tela não batem com o comportamento (por exemplo, o SLA fala em "mudança de coluna" mas reinicia por mudança de estado; a pré-visualização do parecer escreve "Nº do Laudo Técnico" onde o .docx escreve "Nº do Parecer Técnico").
22. Na Reconciliação, o achado dispensado nunca sai da lista.
23. A importação da planilha .xlsx ainda não foi conferida com um arquivo real.
24. A lista de setor emissor mostra duas linhas "SEST/DASA/PROGEP": são versões históricas, de propósito; o rascunho já vem com "CSSO/Sisa", o único em vigor.
25. Dados de teste (nomes de profissionais habilitados, matrícula do signatário em branco) precisam ser revistos antes de emitir pareceres de verdade.
