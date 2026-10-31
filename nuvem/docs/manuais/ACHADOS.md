# Achados dos testes do Sistema SISA

Consolidação dos testes por módulo (ambiente de teste, por HTTP, com os perfis de cada módulo). Ordem: bloqueador, alto, médio, baixo. Cada item traz módulo, onde, o que acontece e sugestão. Manuais: [README.md](README.md).

Siglas dos módulos: PRO (Processos SEI), EPI, TUR (Turmas), CER (Certificados), ACI (Acidentes), OCO (Ocorrências), TRA (Transversal), PGR (CISSP e PGR).

## O que muda o uso do sistema já

> **Regra nova (30/10/2026, no lote em preparo): Acidentes e CAT/SP só para acidentado servidor.** A comunicação, com login ou pelo link público, recusa envolvido terceirizado, estudante, visitante e outros, e manda registrar em Ocorrências. Os manuais de Acidentes ainda descrevem envolvidos externos e precisam ser ajustados.

Pontos que alteram o jeito de trabalhar hoje. Orientação provisória até a correção.

1. **Bloqueador: médico não abre o Detalhe da saúde (nível 2) sem natureza da lesão (ACI).** Dava erro 500. **Situação: CORRIGIDO em 30/10/2026** (o template trata o nulo; teste em acidente_saude.test.ts). Histórico: o contorno era gravar a natureza antes.
2. **Campo "Nome da pessoa atendida" ficava oculto (OCO).** **Situação: CORRIGIDO em 30/10/2026** (csso.js: caixa sem marca vale como vazio; o campo aparece com "comigo" desmarcado e some ao marcar). Falta só conferir em navegador real; o manual já descreve o comportamento atual.
3. **Concluída e Cancelada ainda são finais em parte.** Mudou em 30/10/2026: ocorrência concluída ou cancelada (OCO) é reaberta pela coordenação, com motivo; inscrição cancelada (TUR) é reativada por quem responde pela turma; linha recusada de EPI volta ao reconsiderar o pedido; caso de acidente com relatório emitido ou encaminhado ao SIASS (ACI) tem a investigação reaberta pela coordenação. **Continuam sem volta:** processo Arquivado (PRO), caso de acidente Concluído (ACI; o que volta é ocorrência nova) e certificado anulado. Confira duas vezes antes de arquivar, concluir um caso ou anular.
4. **Tipo e NUP do processo não se corrigem (PRO).** Confira o tipo na criação. NUP de arquivado continua bloqueado.
5. **Depois de "Aguardando inspeção" o processo não arquivava nem indeferia (PRO).** **Situação: CORRIGIDO em 30/10/2026**: arquivar e indeferir cabem depois da triagem (até o parecer em elaboração; de parecer pronto para assinatura em diante só arquiva), e "Voltar uma etapa" (com motivo) existe no meio do trabalho técnico (src/dominio/estados.ts).
6. **Conceder adicional sobre outro vigente exige tela que não existe (PRO).** Contorno: cessar o antigo antes.
7. **Anular parecer não mexia no adicional nem nas pendências (PRO).** **Situação: CORRIGIDO em 30/10/2026**: anular fecha as pendências do parecer e leva o adicional ligado a "Em reavaliação", com pendência de decisão (conforme o lote; código em parecer.ts e direito.ts). Revise a decisão pendente.
8. **Lote de EPI com CA ou validade errados não se corrigia (EPI).** **Situação: CORRIGIDO em 30/10/2026**: CA e validade do CA se corrigem, com a diferença na trilha. Continuam sem correção lote e tamanho, e "renovar o CA" fica para depois.
9. **Reconsiderar pedido de EPI indeferido não reabria as linhas (EPI).** **Situação: CORRIGIDO em 30/10/2026**: reconsiderar reabre as linhas recusadas com o motivo do indeferimento (teste em epi_requisicao.test.ts).
10. **Turma cancelada deixava participantes "Confirmada" e ninguém era avisado (TUR).** **Situação: CORRIGIDO em 30/10/2026**: cancelar a turma cancela as inscrições vivas, com o motivo da turma, e avisa por e-mail quem tem endereço (o motivo não vai no e-mail); teste em correcoes_turmas.test.ts. Sem e-mail cadastrado, avise por fora.
11. **Desistência ou cancelamento de inscrição não tinha volta (TUR).** **Situação: CORRIGIDO em 30/10/2026**: quem responde pela turma (`turma.concluir`) reativa a inscrição, com motivo e trilha; volta confirmada se houver vaga (teste em correcoes_turmas.test.ts).
12. **Inscrição em sala pelo QR passa só 8 pedidos por 10 minutos por rede (TUR).** Em turma presencial, use a inscrição em lote pela equipe.
13. **"Assina o certificado" e vigência do instrutor (TUR, CER).** Confira a caixa ao vincular o instrutor (não se altera depois) e a vigência na data da emissão. Senão a emissão trava.
14. **Servidor inscrito sem e-mail não recebe certificado por e-mail (CER).** Depois da conclusão da turma não há onde corrigir. Cadastre o e-mail antes de inscrever.
15. **Aviso de reciclagem conta como envio do certificado (CER).** Depois de avisar pela Reciclagem, o envio do certificado é barrado. Reciclagem também mostra "Vencido" para quem tem certificado válido se o mais novo foi emitido antes.
16. **Identificação pessoal do Anexo III só entrava na comunicação (ACI).** **Situação: CORRIGIDO em 30/10/2026**: completa-se na aba Identificação, por quem tem `acidente.identificacao_ver`; só o digitado entra (teste em acidente_identificacao.test.ts).
17. **Anexo III em PDF só o médico (e coordenação) gera (ACI).** O técnico que encaminha ao SIASS precisa pedir ao médico.
18. **Quem registra ocorrência não vê o acompanhamento nem a conclusão (OCO).** (Segue assim; conferido na ficha atual.) Não há e-mail de retorno. Avise por fora.
19. **Ficha de ocorrência não mostra quem assumiu (OCO).** Combine por fora quem cuida de cada uma. Não há alerta de ocorrência parada em "Registrada".
20. **Pendências fecham sem conferir o trabalho e não fecham sozinhas (PRO, TRA).** Não confie na lista como prova de que algo foi feito.
21. **Lotação futura digitada errada é irreversível (TRA).** Confira a data ao registrar mudança de lotação.
22. **Autocadastro de servidor e conta automática não verificam SIAPE nem domínio do e-mail (TRA, EPI).** Confira SIAPE e e-mail antes de cadastrar. O cadastro rápido do balcão também aceita qualquer SIAPE de 7 dígitos.
23. **Filtro de dado de saúde é limitado em todos os módulos.** Passam "CID F32", "depressão", "alergia", "queimadura", "fratura". Oriente a equipe a não escrever dado de saúde nos campos livres.
24. **Gestão de contas depende do superintendente e do administrador do sistema (TRA).** Se ambos faltarem, ninguém concede perfil. Coordenador recebe 403 em /usuarios.
25. **CISSP e PGR não existem (PGR).** Atas, mandato e inventário de riscos seguem por planilha, SEI e papel.

## Corrigido no lote de 30/10/2026

Decisões do usuário, já no código (cada uma com teste). Os manuais ainda descrevem o comportamento antigo e serão ajustados.

- **Turma cancelada** cancela as inscrições vivas, com o motivo da turma, e avisa por e-mail quem tem endereço (o motivo não vai no e-mail).
- **Inscrição cancelada** pode ser reativada por quem responde pela turma (`turma.concluir`), com motivo e trilha; volta confirmada se houver vaga.
- **Ocorrências** concluídas ou canceladas são reabertas pela coordenação, com motivo (entra no acompanhamento).
- **Acidentes**: a coordenação reabre a investigação de caso com relatório emitido ou encaminhado ao SIASS, com motivo da lista. **Concluída continua final** (o banco recusa sair dela): o caso que volta é ocorrência nova.
- **Acidentes**: identificação pessoal do Anexo III se completa na aba Identificação (`acidente.identificacao_ver`); só o digitado entra.
- **Processos**: arquivar e indeferir cabem depois da triagem; "Voltar uma etapa" (com motivo) no meio do trabalho técnico; anular parecer fecha as pendências dele e leva o adicional ligado a "Em reavaliação", com pendência de decisão.
- **EPI**: reconsiderar pedido indeferido reabre as linhas recusadas com o motivo do indeferimento; CA e validade do CA do lote se corrigem, com a diferença na trilha (renovar CA fica para depois).
- **Certificados**: exclusão de modelo nunca usado (sem certificado emitido e fora do catálogo).

## Bloqueador

- **[ACI] Detalhe da saúde (nível 2) dá erro 500 com natureza da lesão vazia.**
  - **Situação: CORRIGIDO em 30/10/2026: o template trata o nulo; teste em acidente_saude.test.ts.**
  - Onde: aba Saúde, Finalidade "Investigar o acidente", O que abrir "Detalhe (nível 2)"; templates/partes/acidente_aba_saude.html, filtro `|string` sobre null.
  - O que acontece: médico recebe 500 nas CAT-0006 a 0009. É o único caminho para confirmar a saúde declarada e fechar a tarefa. POST direto funciona, a tela não.
  - Sugestão: tratar o null antes do filtro, por exemplo `(sd.natureza_lesao_id or l.natureza_lesao_id or '')|string`. Revisar outros `|string`, `|momento` e `momento_campo` sobre null. Cobrir o nível 2 sem natureza em teste. Datas de afastamento invertidas também dão 500, deveriam dar 422.
- **[OCO] Campo "Nome da pessoa atendida" provavelmente fica oculto sempre.** (Por leitura de código, não visto em navegador.)
  - **Situação: CORRIGIDO em 30/10/2026: caixa ou rádio sem marca vale como vazio em `data-mostra-quando` (csso.js). Falta conferir em navegador.**
  - Onde: templates/paginas/ocorrencias_registrar.html linha 82 (`data-mostra-quando="eh_a_pessoa="`) e csso.js (`valoresDe`, `avaliarMostraQuando`).
  - O que acontece: caixa desmarcada não gera valor, marcada gera "1"; a regra espera vazio. O servidor exige o nome, e a recusa 422 reexibe o formulário com o campo ainda oculto.
  - Sugestão: confirmar em navegador; tratar caixa desmarcada como "" ou trocar por rádio "Eu / Outra pessoa"; teste de interface.

## Alto

### Processos SEI
- **Tipo do processo e NUP não se corrigem; NUP de arquivado continua bloqueado.** Onde: /processos/N (Corrigir dados), /processos/novo. Acontece: tipo errado muda toda a máquina de estados e não há saída; criar de novo com o mesmo NUP dá "já existe processo com este NUP". Sugestão: permitir alterar tipo (em Recebido/Em triagem) e NUP com justificativa na trilha; permitir reabrir arquivado.
- **Depois de "Aguardando inspeção" não há como arquivar, indeferir nem voltar.** Onde: src/dominio/estados.ts, Mover de estado. Acontece: "Transição proibida: Parecer em elaboração → Arquivado"; sem retrocesso, só Sobrestado. Sugestão: liberar Arquivado e Indeferido a partir dos estados intermediários; criar "Voltar uma etapa" com motivo.
  - **Situação: CORRIGIDO em 30/10/2026: arquivar e indeferir cabem depois da triagem e há "Voltar uma etapa" com motivo (estados.ts).**
- **Conceder adicional sobre outro vigente exige "registro de opção" sem tela.** Onde: /adicionais > Gerir > Conceder; src/servicos/direito.ts. Acontece: o campo registro_opcao_anexo_id nunca é preenchido; a pendência REGISTRO_DE_OPCAO "ainda não nasce". Sugestão: upload do registro na ficha do direito proposto; dispensar para revisão do mesmo tipo. Contorno: cessar o antigo antes.
- **Anular parecer deixa adicional vigente e pendências apontando para o anulado.** Onde: /pareceres/N/anular, /adicionais, /pendencias. Acontece: adicional segue Vigente; pendências seguem abertas citando o parecer anulado. Sugestão: ao anular, listar direitos e pendências vinculados e exigir decisão; fechar as pendências do parecer.
  - **Situação: CORRIGIDO em 30/10/2026: anular fecha as pendências do parecer e leva o adicional ligado a "Em reavaliação", com pendência de decisão.**

### Gestão de EPI
- **Reconsiderar pedido indeferido não permite aprovar nada.** Onde: POST /epis/requisicoes/{id}/reconsiderar. Acontece: pedido volta a Em análise, linhas seguem Recusadas e finais ("Transição proibida: Recusado → Aprovado"); depois nem cancela. Sugestão: reabrir também as linhas recusadas no indeferimento global ou "desfazer recusa" item a item com motivo.
  - **Situação: CORRIGIDO em 30/10/2026: reconsiderar reabre as linhas recusadas com o motivo do indeferimento.**
- **Lote com CA, validade, lote ou tamanho errados não se corrige; "renovar o CA" não existe.** Onde: Estoque > Corrigir nota, contato ou situação. Acontece: só altera nota, ofício, contato, observação e ativo; lote impedido não reserva nem entrega; reentrada exige outra nota fiscal. Sugestão: permitir corrigir CA e validade (e renovar CA) com diferença na trilha.
  - **Situação: PARCIAL, CORRIGIDO em 30/10/2026 para CA e validade do CA (com a diferença na trilha). Lote e tamanho seguem sem correção; renovar CA fica para depois.**

### Treinamentos: turmas
- **Inscrição cancelada ou desistente não tem volta.** Onde: /turmas/minhas (desistir), /turmas/{id}/inscricoes. Acontece: "já consta ... como cancelada"; "Cancelada é situação final". Sugestão: permitir CANCELADA → INSCRITA com motivo e trilha, ou trocar o texto "fale com a equipe".
  - **Situação: CORRIGIDO em 30/10/2026: quem responde pela turma (`turma.concluir`) reativa a inscrição, com motivo e trilha; volta confirmada se houver vaga.**
- **Cancelar a turma não cancela as inscrições nem avisa ninguém.** Onde: /turmas/{id}/situacao (CANCELADA); /turmas/minhas. Acontece: participante vê "Confirmada · a turma já começou"; nenhum e-mail na fila. Sugestão: cancelar as inscrições vivas (ou exibir "Turma cancelada: motivo") e enfileirar e-mail.
  - **Situação: CORRIGIDO em 30/10/2026: cancela as inscrições vivas, com o motivo da turma, e avisa por e-mail quem tem endereço.**

### Certificados
- **Servidor inscrito sem e-mail não recebe certificado e não há onde corrigir.** Onde: /certificados/{id}, inscrição copia servidor.email só no ato. Acontece: "O participante não tem e-mail cadastrado."; turma concluída recusa nova inscrição; a rota de correção só vale para externo. Sugestão: usar servidor.email como destinatário ou campo editável na linha da inscrição.
- **Aviso de reciclagem é tratado como envio do certificado.** Onde: src/servicos/envio_certificado.ts. Acontece: "0 certificado(s) na fila; 1 já enviado(s) antes" sem nunca ter enviado. Sugestão: filtrar por tipo = CERTIFICADO e rotular o tipo na ficha.
  - **Situação: CORRIGIDO em 30/10/2026: o envio e a ficha olham só e-mails do tipo CERTIFICADO (sem teste próprio ainda).**
- **Reciclagem usa o último emitido, não o curso mais recente.** Onde: src/servicos/reciclagem.ts, /certificados/vencimentos. Acontece: mostra "Vencido" para quem tem certificado válido. Sugestão: ordenar por data base de vencimento; aplicar também em Meus certificados.
- **Busca e nome dos arquivos usam o número interno, não o impresso.** Onde: src/rotas/certificados.ts, emissao_certificado.ts:346. Acontece: impresso SISA-NR32-2026-0001 baixa como Certificado_0003-2026_...; busca "1/2026" acha outro. Sugestão: usar numero_impresso na busca e no nome do arquivo.

### Análise de Acidentes
- **Trilha grava o texto da investigação e das ações.** Onde: acidente_investigacao.ts, acidente_acao.ts; aba Histórico. Acontece: valores como "objetivo: None -> Entender o respingo; vitima com queimadura" ficam imutáveis. Sugestão: gravar só nome do campo e versão; limpar eventos já gravados.
  - **Situação: CORRIGIDO em 30/10/2026 para os registros novos: a trilha diz só `<campo> alterado`. Eventos antigos seguem na cadeia de hash e não foram limpos.**
- **Identificação pessoal do Anexo III não pode ser informada nem completada depois.** Onde: aba Identificação (somente leitura). Acontece: CPF, nascimento, endereço etc. só entram no Comunicar; o PDF sai em branco; link público nem tem o bloco. Sugestão: POST e formulário na aba, restrito a acidente.identificacao_ver, com trilha de identificadores.
  - **Situação: CORRIGIDO em 30/10/2026: completa-se na aba Identificação (`acidente.identificacao_ver`); só o digitado entra.**
- **Indicador "Por unidade do local" sempre "Sem unidade informada".** Onde: acidente_indicadores.ts; local_unidade_uorg_id nunca gravado. Sugestão: derivar da lotação ou oferecer o campo; esconder o recorte enquanto isso.
- **Depois do relatório emitido não se corrige a investigação, e caso concluído não reabre.** Onde: acidente_investigacao.ts, acidente_relatorio.ts. Acontece: "Retificar o relatório" só regenera; Relatório emitido → Em investigação não existe; reabertura é nova ocorrência com novo prazo de 10 dias. Sugestão: "Reabrir a investigação" e "Reabrir ocorrência" com motivo e trilha.
  - **Situação: PARCIAL, CORRIGIDO em 30/10/2026: a coordenação reabre a investigação de caso com relatório emitido ou encaminhado ao SIASS, com motivo da lista. Concluída continua final; o caso que volta é ocorrência nova.**

### Ocorrências
- **Concluída e Cancelada são finais.** Onde: src/servicos/ocorrencia.ts (_tratavel). Acontece: sem reabrir, editar, corrigir nome/tipo/campus, nem acompanhamento tardio. Sugestão: reabrir pela coordenação com motivo; retificação com trilha de identificadores.
  - **Situação: CORRIGIDO em 30/10/2026: coordenador e superintendente reabrem ocorrência concluída ou cancelada, com motivo; volta a Em acompanhamento e o motivo entra no acompanhamento (`reabrir` em ocorrencia.ts; teste em ocorrencias.test.ts). Editar nome, tipo e campus continua sem tela.**
- **Quem registrou não vê acompanhamento nem conclusão.** Onde: ocorrencia_ficha.html (blocos só para equipe). Acontece: só vê a situação; nenhum e-mail ao assumir ou concluir. Sugestão: mostrar retorno ao notificante e avisar por e-mail (só protocolo e link).
- **Nenhum alerta ou prazo para ocorrência parada em "Registrada".** Onde: painel, fila, rotinas. Acontece: fila ordena pela data do fato; sem idade, sem pendência noturna; e-mail da equipe desligado por padrão. Sugestão: mostrar idade, destacar atraso, ordenar por chegada, criar pendência e ligar o e-mail.

### Transversal
- **/usuarios sem busca, filtro nem paginação.** Onde: /usuarios. Acontece: 342 KB para 17 contas; ?q= ignorado. Sugestão: busca e paginação; popups sob demanda.
- **Lotação futura digitada errada é irreversível.** Onde: POST /servidores/:id/lotacao. Acontece: 2027-01-01 aceito como "atual"; mudanças seguintes recusadas; corrigir_lotacao só edita documento e observação; data em ISO. Sugestão: permitir corrigir ou excluir lotação futura; formato dd/mm/aaaa.

### CISSP e PGR
- **CISSP e PGR não existem.** Onde: src/modulos.ts (disponivel:false); /cissp e /pgr dão 404. Acontece: sem composição e mandato, atas, recomendações, inventário de riscos nem plano de ação. Sugestão: priorizar PGR (inventário por posto, reaproveitando posto_trabalho, agente_nocivo, laudo_posto) e depois CISSP; até lá, manuais dizem "previsto".

## Médio

### Processos SEI
- **Parecer emitido com laudo superado ou de unidade diferente.** Onde: /pareceres/N. Acontece: "pronto para emitir" e emite; percentual de periculosidade aceito para agente químico. Sugestão: bloquear laudo superado, alertar outra unidade/posto, validar percentual contra o tipo de adicional.
- **"Laudo emitido" e reúso conferem só a unidade, não o posto.** Onde: src/servicos/processo.ts (_tem_laudo_vigente). Acontece: a mensagem diz "mesmo posto"; processo_id do laudo nunca é preenchido. Sugestão: checar vínculo laudo-posto ou corrigir o texto.
- **"Inserido no SEI" e "Concluído" sem nº do documento SEI nem parecer assinado.** Onde: /processos/N/estado, aba Anexos. Acontece: não existe campo de data; o nº é opcional no upload. Sugestão: exigir link permanente e/ou nº para sair de "Inserido no SEI"; corrigir a ajuda.
- **Pendências do SEI nunca fecham sozinhas e "concluir" não confere.** Onde: /pendencias; src/servicos/pendencias.ts. Acontece: "Incluir o parecer assinado no SEI" fica aberta e atrasa; técnico fechou pendência de troca de EPI do almoxarife. Sugestão: ligar a pendência ao salvamento do link/nº SEI; pedir nota ao concluir à mão.
- **Filtro de saúde não pega "CID F32" nem "depressão".** Onde: src/servicos/textos.ts. Sugestão: regex para CID seguido de código e termos de risco; avisar que a conferência é limitada.
- **Retomar sobrescreve a data de início do adicional; suspender não pede data.** Onde: /adicionais > Gerir. Acontece: vigência mostra a última retomada; AFASTAMENTO_LEGAL aceita base legal em branco; alterar percentual não exige parecer; "Retomar" para voltar de "Alterado". Sugestão: histórico de vigências; validar base legal; renomear a ação.
- **Portaria com data futura aceita.** Onde: /adicionais/N/conceder. Sugestão: data_portaria <= hoje; avisar efeito anterior ao marco do parecer.
- **Histórico da secretaria mostra "conteúdo suprimido" até para mudança de estado.** Onde: /processos/N?aba=historico. Sugestão: mascarar só campo sensível; manter "A → B" e autor.
- **Parecer novo depois de anular começa em branco; "Novo parecer" duplica rascunhos.** Onde: aba Parecer. Sugestão: "Criar nova versão a partir deste" (parecer_anterior_id já existe); avisar rascunho existente.
- **Indeferir exige anexar portaria e formulário antes.** Onde: Mover de estado > Indeferido tecnicamente. Sugestão: incluir o estado em SAIDAS_DA_TRIAGEM_SEM_DOCUMENTO ou exigir só o documento do inciso.
- **Erro enganoso ao mover para o estado atual ou estado sem saída.** Sugestão: mensagens claras e esconder o botão quando não há destinos.

### Gestão de EPI
- **Ficha mostra "troca vencida" depois da troca; o Painel mostra 0.** Onde: /epis/fichas/{id}, Minha ficha vs /epis (troca_devida_em x troca_vencida_em). Sugestão: usar a mesma função nos dois.
- **Quem abre pedido para outro servidor pode analisá-lo (RN-28 só confere o beneficiário).** Onde: POST /epis/requisicoes e /analise. Sugestão: bloquear análise quando criado_por é quem analisa.
- **Entrega de balcão com "Sem lote" como padrão não baixa estoque.** Onde: /epis/entregas/nova. Sugestão: pré-selecionar o lote que vence primeiro; confirmar e justificar "Sem lote" havendo saldo.
- **Devolução não respeita a quantidade da linha.** Onde: registrar_devolucao usa em_poder_de. Acontece: duas devoluções de 1 sobre linha de 1; o estorno depois recusa. Sugestão: limitar à quantidade da linha menos devoluções ligadas.
- **Comprovante com arquivo errado não se troca; estorno não devolve saldo.** Onde: Ficha > Anexar; estornar. Sugestão: substituir anexo com motivo; estorno com opção "devolver saldo ao lote".
- **Aprovação concluída não se corrige.** Onde: máquina de estados do pedido e do item. Sugestão: "reabrir análise" enquanto nada reservado ou entregue.
- **Filtro de saúde deixa passar "alergia" e "CID L23".** Onde: TERMOS_PROIBIDOS. Sugestão: ampliar lista e padrão de CID.
- **Almoxarife autoriza sozinho exceção ao máximo no balcão.** Onde: POST /epis/entregas com justificativa_excecao. Sugestão: exigir epi.analisar ou segunda assinatura.

### Turmas
- **Limite de 8 envios por 10 minutos por rede trava inscrição presencial por QR.** Onde: /inscricao/{chave}, /cursos/{codigo}/inscricao. Sugestão: contar só envios válidos ou subir o limite (ex.: 60), manter limite por e-mail/chave.
- **"Assina o certificado" e alternância.** Onde: Vincular instrutor. Acontece: a caixa não se altera depois ("já é instrutor desta turma"); só tirar e vincular de novo. Sugestão: alternador "assina/não assina" e mensagem com o caminho. (O manual diz que a caixa vem marcada; no teste inicial vinha desmarcada. Conferir.)
- **Instrutor cadastrado em duplicidade e sem título.** Onde: /treinamentos/assinaturas. Sugestão: uma assinatura por servidor, alertar nome igual, título obrigatório.
- **Busca de participante na aba Inscrições não ignora acento (o lote ignora).** Onde: /turmas/{id}?aba=inscricoes. Acontece: "Cintia" não acha "Cíntia"; leva a duplicidade externo x servidor. Sugestão: normalizar acento e caixa.
- **"Iniciar turma" é irreversível, não confere a data.** Onde: /turmas/{id}/situacao. Acontece: turma de 10/12 iniciada em 29/10 fecha o link; só cancelando. Sugestão: confirmar ou permitir voltar sem presença; rótulos com acento.
- **Concluir não avisa de quem está sem nota e o deixa reprovado.** Onde: popup "Concluir". Sugestão: contar "N inscrito(s) sem nota" no popup.
- **Formulário "Quero ser avisado" coleta nome e e-mail com o aviso desligado.** Onde: /cursos, /cursos/avise-me. Sugestão: ocultar o formulário quando desligado.
- **403 de turma alheia orienta pelo caminho errado.** Acontece: cita "turma.dono" e concessão de perfil; o caminho real é o dono designar ajudante. Sugestão: texto próprio e pronome neutro.

### Certificados
- **"Aplicar sugestões" do mapa de marcadores liga dados errados.** Onde: POST /treinamentos/modelos/{id}/tags/sugeridas. Acontece: «DATA DE HOJE» ligada a lotação (bloqueia); segundo «DD/MM/AAAA» vira data do curso. Sugestão: reduzir heurísticas, selo "sugerido, confirme", não marcar "bloqueia" por padrão.
- **Modelo ou versão nova não vale até apontar no catálogo.** Onde: /treinamentos/modelos, /treinamentos/catalogo. Sugestão: oferecer "Usar este modelo no treinamento" e mover o apontamento ao publicar nova versão.
- **Instrutor sem vigência na data da emissão trava curso já realizado.** Acontece: vínculo confere vigência no início da turma, a emissão na data de emissão. Sugestão: conferir na data de término da turma ou alinhar mensagens.
- **Anular certificado não cancela e-mail na fila.** Acontece: pedidos ficam "Na fila" e caem em "Falhou" após 5 tentativas. Sugestão: cancelar pendentes ao anular.
- **"Enviar de novo" duplica o pedido; "já enviado" inclui o que está só na fila.** Sugestão: bloquear reenvio com pendente; separar "já na fila" de "já enviado".
- **Resumo do módulo promete "quem nunca fez"; a Reciclagem não mostra.** Sugestão: retirar do texto ou criar a visão "Nunca fez".
- **Na fila, quem não é dono vê "pronto para emitir" e só descobre a recusa depois.** Sugestão: linha "só consulta" sem caixa de seleção.
- **Mensagem de modelo sem mapa é técnica.** Sugestão: dizer quantos marcadores faltam e o caminho (Cadastros > Modelos > ficha > Aplicar sugestões).

### Análise de Acidentes
- **Transição inválida por tela antiga ou duas pessoas dá 500.** Onde: acidente_triagem.ts, rotas/acidentes.ts (_ato só captura RegraViolada). Sugestão: TransicaoInvalida herdar de RegraViolada; 409 com texto amigável.
- **Data "emitido em" do PDF sai no dia seguinte entre 21h e 23h59.** Onde: acidente_relatorio_pdf.ts. Sugestão: usar data local America/Sao_Paulo, como no Anexo III.
- **Aviso do responsável legal de menor nunca zera.** Onde: acidente_analise.ts; responsavel_legal_solicitado_em nunca gravado. Sugestão: ato "Registrar aviso ao responsável legal" com trilha.
- **Secretaria e acidentado baixam o relatório "Sem saúde" com nome, SIAPE e síntese, apesar da ficha dizer restrito.** Onde: rotas/acidente_relatorio.ts (download só com acidente.ver). Sugestão: decidir quem recebe a variante; restringir ou pseudonimizar.
- **Secretaria pode ser "Quem conduz" e assumir toma o caso sem confirmação.** Sugestão: atribuir ao passar para Em investigação; confirmar ao tomar caso alheio; permitir atribuir.
- **Origem "Pelo próprio acidentado" para quem comunica por outra pessoa.** Causa provável: "Sou eu" pré-marcada. Sugestão: origem COLEGA.
- **Triagem não detecta comunicação duplicada.** Acontece: cinco protocolos do mesmo evento. Sugestão: aviso por (acidentado, data, local) e destaque na triagem.
- **Técnico não gera o Anexo III (403 cru) e o link fica longe da aba SIASS.** Sugestão: link na aba SIASS, tarefa para o médico ou liberar ao técnico.
- **"Incidente / quase acidente" segue fluxo de CAT, 10 dias e SIASS.** Sugestão: fluxo reduzido, sem prazo do art. 214.

### Ocorrências
- **Ficha não mostra quem assumiu e não há reatribuição.** Sugestão: "Assumida por X em dd/mm", filtro "Minhas assumidas", ação "Passar para…".
- **Leitura da ficha (nome e relato de saúde) não entra no registro de acesso a dado sensível.** Acontece: acesso_dado_sensivel com 0 linhas. Sugestão: registrar a leitura pela equipe, como nos Acidentes.
- **Dado digitado duas vezes: "Comunicar o acidente" abre em branco; vínculo à CAT é manual.** Acontece: aceita CAT de outra pessoa, sem desfazer; a ficha da CAT não mostra a ocorrência. Sugestão: pré-preencher e vincular automaticamente; validar acidentado; permitir desvincular.
- **Almoxarife e administrador de TI não registram ocorrência (403).** Sugestão: dar ocorrencia.registrar a todo perfil interno ou registro por link.
- **Quem registra "comigo" reescolhe vínculo e redigita setor.** Sugestão: pré-preencher pelo cadastro e ligar ao servidor.

### Transversal
- **Autocadastro de servidor sem verificar o SIAPE.** Onde: /cadastre-se, /ativar-acesso, /minha-conta/sou-servidor. Acontece: SIAPE inexistente com e-mail @ufvjm.edu.br cria servidor ativo e conta; sem excluir ou mesclar. Sugestão: exigir SIAPE já cadastrado ou aprovação.
- **Pendência concluída sem pré-requisito, sem reabrir e sem reatribuir.** Onde: POST /pendencias/:id/concluir. Sugestão: validar o pré-requisito; criar reabrir e reatribuir.
- **Trilha guarda valores pessoais (nome, e-mail, SIAPE).** Onde: /auditoria; CAMPO_ALTERADO, USUARIO_ALTERADO, EMAIL_ALTERADO_PELO_TITULAR, USUARIO_EXCLUIDO. Sugestão: gravar só nomes de campo e ids.
- **Exportação CSV de processos sem rastro.** Onde: GET /relatorios/exportar-processos. Sugestão: registrar evento de exportação.
- **Conta automática para qualquer e-mail de servidor.** Onde: conferir_email. Sugestão: validar domínio institucional ou confirmar o e-mail.
- **LGPD sem canal e sem pedidos do titular.** Onde: /minha-conta (Privacidade). Sugestão: contato do encarregado e formulário de pedido.
- **Busca confunde prefixo do NUP com CPF.** Onde: /busca. Sugestão: testar padrão do NUP antes do de CPF; normalizar pontuação.
- **Secretaria cria servidor sem poder conferir ou corrigir.** Onde: /servidores. Sugestão: mostrar o dado na criação ou permitir correção por quem criou.
- **Gestão de contas depende de uma única pessoa (ou duas).** Sugestão: avaliar delegação ao coordenador com limites.

### CISSP e PGR
- **O PGR é tratado como processo SEI de rastreio, sem inventário.** Onde: /processos/novo (tipo PGR), estados.ts. Sugestão: deixar claro no tipo e no manual; ligar ao posto quando o módulo existir.

## Baixo

### Processos SEI
- [PRO] Reatribuir responsável só existe no lote da lista. Sugestão: botão na ficha e no Kanban.
- [PRO] Reconciliação é só leitura; DV dispensado nunca sai da lista; órfãos do Trello sem tela para receber o NUP. Sugestão: "Marcar como conferido" e "Informar NUP".
- [PRO] Anexo não se remove nem se substitui; qualquer extensão aceita (.exe). Sugestão: desativar com motivo e lista de extensões.
- [PRO] Conferência e cadastro de laudo sem trilha; posto de outra unidade vinculável sem aviso. Sugestão: LAUDO_CRIADO e LAUDO_CONFERIDO.
- [PRO] 403 mostra o nome técnico da permissão. Sugestão: frases de negócio.
- [PRO] Textos que não batem: SLA reinicia por estado e não por coluna; demandas "nome obrigatório" mas aceitam sem; pré-visualização rotula "Nº do Laudo Técnico" para o parecer; ajuda cita "data" do SEI inexistente; duas linhas "SEST/DASA/PROGEP" (versões históricas, vale CSSO/Sisa); "Em reavaliacao" sem acento e "None -> ..."; "Backlog" x "Campus Avançados"; "publico" sem acento; "parecer 0/2026" nas pendências.
- [PRO] Prazo do processo sem efeito e aceita data passada. Sugestão: validar data futura e incluir em "Atrasados".
- [PRO] Servidor requerente não acompanha o próprio processo (403). Sugestão: avaliar cartão "Meu pedido de adicional".
- [PRO] Relatórios não extraem pareceres, laudos nem adicionais. Sugestão: CSV de pareceres e adicionais.
- [PRO] Seed com nome que parece real e pareceres sem matrícula do signatário. Sugestão: dado fictício e matrícula preenchida.
- [PRO] Numeração de parecer: id 3 recebeu 5/2026, com "já usados: 0, 1, 2, 4". Coordenação conferir número reservado ou pulado.

### Gestão de EPI
- [EPI] Qualquer analista decide itens de pedido assumido por colega. Sugestão: restringir ao analista que pegou.
- [EPI] Entrega com data retroativa aceita mesmo antes da entrada do lote. Sugestão: recusar e exigir justificativa.
- [EPI] Comprovante diz "Sistema CSSO" e sai em Word. Sugestão: "Sistema SISA" e oferecer PDF.
- [EPI] Mensagens técnicas ou enganosas (transição, 422 JSON cru, CPF com mensagem de saúde, link do catálogo para quem só lê).
- [EPI] Guia de entrega sem lote reservado; "Finalidade" e "Motivo do item" repetidos.
- [EPI] Cadastro rápido aceita qualquer SIAPE de 7 dígitos; rascunho de terceiros visível e excluível pela equipe.
- [EPI] Devolução credita o lote mesmo com motivo "Extraviado" ou "Desgaste físico". Decisão do produto.
- [EPI] Mensagem de saúde manda marcar caixa que as telas de EPI não têm.

### Turmas
- [TUR] Ajudantes: lista inclui contas sem permissão no módulo (almoxarife). Sugestão: filtrar por treinamento.ver.
- [TUR] Lista de presença .docx com uma só coluna de assinatura para vários dias. Sugestão: coluna por dia.
- [TUR] Carga horária da turma em branco é herdada do catálogo sem pré-preencher (o manual já descreve).
- [TUR] Trilha grava valores de nota e frequência ligados ao PTC. Sugestão: registrar só que houve lançamento ou retificação.
- [TUR] Mensagens imprecisas ("aberta" para planejada, título "Pedido recebido" com 422, "inscrita" x "Confirmada", cancelar duas vezes sem aviso, código interno na página pública).
- [TUR] Nome do arquivo do certificado em Word usa sequência diferente do impresso.
- [TUR] Avaliação de reação só por e-mail e só se o e-mail estiver ligado ao concluir. Sugestão: convites retroativos; QR na sala.
- [TUR] Hub dá alarme falso ("Turmas encerrando" com turma futura); contador de Inscrições conta canceladas; "DIA" sem explicação.
- [TUR] Editar treinamento ou instrutor sem os campos de caixa apaga dados (POST sem as caixas). Sugestão: campo ausente mantém o valor.
- [TUR] Dois controles de público (vitrine x "Aceita comunidade externa") e pedido com SIAPE divergente confirmado sozinho. Sugestão: unificar; SIAPE divergente fica "a conferir".

### Certificados
- [CER] Janela de reciclagem: textos dizem 30 dias, a regra é 60 (src/modulos.ts:495, hub_treinamentos.ts:339).
- [CER] Anulação e correção aceitam motivo de um caractere. Sugestão: mínimo e aviso de não escrever dado pessoal.
- [CER] Cadastro de instrutor aceita duplicado e título em branco.
- [CER] Ajuda do catálogo cita CSSO, mas turma sem unidade promotora emite SISA. Sugestão: explicar a regra e avisar antes de emitir.
- [CER] Frases de resultado vagas ("já não estava apto" para turma em andamento; URL "vencimentos?&mensagem="; pronome "ele" para dona).
- [CER] PDF da casa em Carta (792x612), não A4. Sugestão: 842x595.
- [CER] Validação pública limita 10 consultas por minuto por IP; atrás de NAT de campus bloqueia uso legítimo. Sugestão: subir limite ou contar só chaves inexistentes.
- [CER] Motivo de anulação fica na trilha como texto livre. Sugestão: advertência e campo restrito.
- [CER] Tela de Instrutores cita IntegraSST/Google Drive (templates/paginas/assinaturas.html:218).
- [CER] Reemissão pela fila não liga o certificado novo ao antigo (só "Corrigir certificado" e "Reemitir os certificados…" ligam). Sugestão: preencher substituido_por_id.
- [CER] Trilha ganha evento "Aviso" de modelo genérico em toda emissão. Sugestão: remover quando o genérico é o padrão.

### Acidentes
- [ACI] Rótulos "Servidor acidentado" e "Servidor envolvido sem lesão" para terceirizado, estudante e visitante. Sugestão: "Acidentado" e "Envolvido sem lesão".
- [ACI] Aba Análise pede "Município e UF" com UF preenchida; 403 expõe permissão técnica; "a data do acidente..." com minúscula; termos proibidos repetidos.
- [ACI] Tarefa "Triar" de ocorrência restrita (menor) visível à secretaria, que recebe 404. Sugestão: filtrar pendências restritas pelo escopo.
- [ACI] Linha do tempo, entrevistas e evidências não se editam nem reordenam; link público some depois de gerado e gerar outro desliga o anterior; "Link de comunicação" fora do menu.
- [ACI] Filtro de saúde deixa passar "queimadura" e "fratura". Sugestão: lista mínima definida com o médico do trabalho.

### Ocorrências
- [OCO] "Por tipo" nos indicadores soma mais que o total, sem explicação; faltam filtros e tempo até assumir/concluir.
- [OCO] Mensagens de validação com gramática truncada ("O campo a descrição do que aconteceu...").
- [OCO] Trava de CID inconsistente ("CID-10 G40" recusado, "J45.0 diagnosticado" aceito).
- [OCO] Sem aviso de duplicidade e sem múltiplas vítimas; sem destino do atendimento.
- [OCO] Rascunho do formulário guarda nome e relato no sessionStorage. Sugestão: excluir esses campos.
- [OCO] Busca global não acha protocolo OCO; /celular sem atalho para a equipe; "Local exato" pode ter nome de pessoa.
- [OCO] ID gigante devolve 422 em vez de 404.

### Transversal
- [TRA] Texto do Limpar dados diz quatro módulos, mas são cinco.
- [TRA] Domínio do discente inconsistente (Cadastre-se rejeita @aluno.ufvjm.edu.br; o admin aceita qualquer).
- [TRA] Terceirizado e discente com selo "Conta de equipe" e coordenadoria CSSO.
- [TRA] Mensagens expõem códigos de permissão ("e mais 41") e frase truncada ("a redefine").
- [TRA] Erros de data e nível devolvem JSON cru.
- [TRA] Conta sem perfil: a mensagem manda ir a Usuários, que a pessoa não abre.
- [TRA] Sigla duplicada no seletor de unidade ("(IECT) (IECT)").
- [TRA] Coluna morta "Empresa ou curso"; Configuração diz "v1 não integra com o SEI" (sistema é v2.0.0).
- [TRA] Importação Trello sem tela de de-para.
- [TRA] Oráculos de existência de conta (5ª senha errada, e-mail duplicado, "Esqueci" para conta inativa).
- [TRA] Regra de exclusão de conta inconsistente (conta 11 recusada, conta 13 excluída).
- [TRA] Importação CSV de servidores altera dados silenciosamente (SIAPE curto vira 0000123; nomes atualizados só aparecem como "atualiza").

### CISSP e PGR
- [PGR] Processo tipo PGR mostra aba "Parecer" e botão "Novo parecer", que cria rascunho de parecer de adicional (GET /parecer/novo dá 404). Sugestão: esconder nos tipos da máquina curta.
- [PGR] Vitrine sem link, data nem aviso de onde registrar; seção "Outros módulos" não aparece no Início do servidor de consulta.
- [PGR] Dependências apontam para um PGR inexistente (catálogo de EPI, checklist de acidentes etapa 5). Sugestão: citar o documento do PGR vigente (data e versão).
- [PGR] Anexos de processo saem com Acesso "publico" por padrão; Arquivado não reabre.

## Funcionalidades não testadas

- **PRO:** importação de planilha .xlsx real (25 colunas); avanço automático do processo ao emitir/assinar com processo atrás ou parado (descrito pelo código); como se resolve órfão sem NUP; aparência em navegador (Chrome não abre localhost).
- **EPI:** envio de e-mail (desligado); estorno de entrega vinda de pedido; faixa de aviso do Catálogo, upload de foto e PDF do item, vínculo de treinamento do item; "troca devida" e "CA a vencer" no tempo; escopo por campus; autoanálise (RN-28) com conta ligada ao servidor do pedido (só código).
- **TUR:** perfis terceirizado e discente; e-mail real e avaliação de reação por link; função "Juntar" e tela de duplicados; aparência de telas, PDFs e .docx; acesso do participante por e-mail.
- **CER:** envio real de e-mail; /certificados/acesso; conversor de PDF (LibreOffice) e leitura visual do PDF; outros setores promotores; "Reemitir todos da turma"; perfis administrador do sistema, Consulta PROGEP e auditor (só rbac.ts).
- **ACI:** e-mails (recurso desligado); importação do legado, expurgo, gravador de áudio, rascunho local, imprimir checklist; registrar e corrigir saúde pela tela (500).
- **OCO:** campo "Nome da pessoa atendida" em navegador; e-mails ligados; módulo desligado (404); perfis engenheiro, técnico, médico e superintendente só por rbac.ts.
- **TRA:** /primeiro-acesso, inatividade de 60 min, envio real de e-mail, execução de Limpar dados, importação .xlsx, rate limit por IP, fusão real de duplicados, /api/v1, telas do administrador do sistema, ações que gravam (conceder, encerrar, resetar, aprovar, importar, exportar tudo).
- **PGR:** nada a testar além da vitrine e do processo SEI tipo PGR; perfis Consulta PROGEP e auditor só pela matriz de permissões.

## Pendências dos conferentes

Decisões do coordenador ou correções de código que os manuais só descrevem como limite.

- **PRO:** conferir numeração de parecer (5/2026 com "já usados: 0, 1, 2, 4"); decidir avisar na tela quando o processo não acompanha o parecer, tela do registro de opção, anulação que mexa no adicional, exclusão de rascunho; matrícula do signatário em branco no seed. O processo "Concluído" a partir de Recebido e o avanço automático ficaram sem teste ao vivo.
- **EPI:** decidir se devolução com "Extraviado"/"Desgaste" repõe saldo; colocar a caixa de confirmação de saúde nas telas ou mudar a mensagem; remover "renovar o CA" dos textos ou criar a função; ampliar vocabulário do filtro ("alergia"); trocar "Sistema CSSO" no comprovante.
- **TUR:** decidir se inscrição cancelada pode ser reativada; cancelar turma sem cancelar inscrições; "Iniciar turma" sem checar data; aviso de interesse ativo com a chave desligada; instrutor duplicado ou sem título; lote que casa homônimo por nome; confirmar a política do dono da turma para a secretaria.
- **CER:** não há tela para corrigir e-mail do participante depois da inscrição (turma aberta: alternativa não verificada); decidir quem é dono dos treinamentos já cadastrados (técnico não edita treinamento de outro dono); textos de 30 dias; PDF em Carta; motivo de uma letra; instrutor duplicado.
- **ACI:** corrigir erro 500 do detalhe e das transições, trilha com texto da investigação (depois revisar cap. 6.2 e 14 do usuário e 8, 12 e 16 do coordenador); decidir se secretaria e acidentado baixam o relatório "Sem saúde" (permissão existe, botão não); decidir sobre "Sou eu o envolvido" pré-marcado; pedir que a Auditoria mostre o protocolo; confirmar CSSO_ACIDENTE_EMAIL e o endereço do setor.
- **OCO:** confirmar em navegador o campo "Nome da pessoa atendida" (corrigido no código); o vínculo à CAT em ocorrência encerrada segue só depois de reabrir (a coordenação reabre, vincula e conclui de novo); mensagens "Informe a conclusão." só aparecem sem JavaScript.
- **TRA:** lotação futura irreversível, Excluir só no Cadastre-se, autocadastro sem conferir SIAPE, canal LGPD, concentração da gestão de contas e conta automática para qualquer e-mail dependem de código ou decisão; não foi confirmado por que o Cadastre-se de servidor com SIAPE novo não gerou e-mail (provável teto de 8 pedidos por hora por IP); o roteiro de referência trazia "Excluir" na tela Usuários, o que não existe.
- **PGR:** decidir onde registrar atas, mandatos e inventário de riscos enquanto os módulos não existem (cap. 8 do manual do coordenador); o NUP de teste usou dispensa de DV, a validação com número válido não foi exercitada.
- **Ambiente:** os servidores e bancos de teste foram encerrados e apagados, exceto o de Processos SEI (confirmação da remoção do banco csso_man_processos não foi vista na saída) e o de transversal (servidor da porta 3107, PID 3892510, e o banco csso_man_transversal seguiam de pé). O banco `csso` não foi tocado.
