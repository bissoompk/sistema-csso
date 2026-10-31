# Manual do usuário: Análise de Acidentes (Sistema SISA)

## Para quem é este manual

Para quem usa o módulo "Análise de Acidentes" no dia a dia:

- **Quem comunica um acidente**: servidor, chefia ou qualquer pessoa com conta, ou qualquer pessoa pelo link público. O acidentado, porém, tem de ser servidor: acidente com terceirizado, estudante, visitante etc. é registrado em Ocorrências, não aqui.
- **Secretaria**: recebe e faz a triagem das comunicações.
- **Equipe de segurança do trabalho** (técnico, engenheiro, coordenação, superintendência): investiga, emite o relatório, encaminha ao SIASS e conclui.
- **Médico do trabalho**: registra a saúde e encaminha ao SIASS.

Este manual explica "como faço X". Não trata de configuração nem de decisões de gestão.

Base legal que aparece na tela: Lei 8.112, arts. 211 a 214. A equipe tem **10 dias, contados da data do acidente**, para encaminhar a comunicação.

## Antes de começar

- O módulo aparece no menu **Acidentes** da Página inicial. Se o módulo não estiver liberado na sua instituição, o menu mostra "em desenvolvimento".
- Você precisa de conta no Sistema SISA ligada à sua pessoa. Quem não tem conta comunica pelo link público (capítulo 2).
- O que você enxerga depende do seu perfil:

| Perfil | O que faz no módulo |
|---|---|
| Servidor (com conta) | Comunica; vê "Minhas comunicações"; responde pedido de complementação. O servidor que é o acidentado lê a própria saúde e a própria identificação (sem informar finalidade). Não vê a fila, o Plano de ação, os indicadores nem o link público (acesso negado). A tela das abas "Relatórios" e "Histórico" diz "Restrito à equipe que investiga" |
| Secretaria | Comunica; vê a fila; faz a triagem; gera o link público; vê os indicadores (sem exportar). Não lê saúde ("Seu perfil não abre a saúde."), identificação, plano de ação (acesso negado), SIASS, relatório, entrevistas nem histórico |
| Técnico, engenheiro | Tudo da triagem, investigação, plano de ação, relatório e SIASS; resumo da saúde (nível 1). Não abrem o detalhe da saúde, a identificação nem o Anexo III em PDF |
| Médico | Vê as abas; registra saúde; encaminha ao SIASS; baixa o Anexo III. Lê (sem editar) a investigação, o checklist, as entrevistas, o plano de ação e o histórico. Não investiga nem emite relatório; não gera link público |
| Coordenação e superintendência | Conjunto completo, inclusive detalhe da saúde |
| Almoxarife, administrador de TI sem vínculo de servidor | Sem acesso ao módulo (tela de acesso negado) |

Os perfis acima são o padrão. Quem ajusta o nível de acesso de um perfil ou de uma pessoa ao módulo é o Administrador do sistema ou o Superintendente (assunto do manual do coordenador).

- **Nenhuma lista mostra nome.** A fila mostra só protocolo, espécie, data, situação, prazo e quem conduz. O nome aparece dentro da ficha, na aba "Envolvidos", só para quem tria, investiga ou encaminha. Quem comunicou acidente de outra pessoa vê o envolvido por um código (por exemplo "SRV-947b").
- Ocorrência de **menor de idade** é restrita à equipe de segurança do trabalho. A secretaria recebe "não encontrado" ao tentar abri-la.

## Sumário

1. Comunicar um acidente (quem tem conta)
2. Comunicar sem conta (link público)
3. Acompanhar e responder complementação ("Minhas comunicações")
4. Triagem (secretaria e equipe)
5. Investigação, checklist, entrevistas e evidências
6. Saúde e identificação (acesso restrito)
7. Plano de ação
8. Relatório técnico
9. SIASS, decisão da perícia e conclusão
10. Painel, fila e indicadores
11. Situações da ocorrência
12. Erros e mensagens comuns
13. Glossário
14. Limites conhecidos
15. E-mails do módulo

---

## 1. Comunicar um acidente (quem tem conta)

**Quem pode:** qualquer perfil com conta ligada a uma pessoa. **Onde:** menu "Comunicar acidente".

A tela "Comunicar acidente" tem seções recolhíveis. O sistema guarda um rascunho no navegador até o envio (comportamento descrito pela tela, não exercitado no teste: não conte com ele para textos longos).

1. Abra "Comunicar acidente".
2. Na seção **1. Quem se envolveu**, preencha o "Envolvido 1". Use o botão **+ Outro envolvido** para incluir "Envolvido 2", "Envolvido 3" etc. (até 20).
   - **Sou eu o envolvido** (a caixa aparece só para contas de servidor ou de externo; conta de externo não é servidor, então o envio com ela é recusado e o caso vai para Ocorrências) **já vem marcada** em um formulário novo. Marcada, o sistema usa o seu cadastro e você dispensa o SIAPE. **Se você está comunicando o acidente de outra pessoa, desmarque.**
   - Servidor que marca "Sou eu" e está sem cargo ou lotação no cadastro precisa informar os dois ("Cargo e lotação (só se o cadastro estiver sem)"; escolha na lista ou digite em "Não está na lista?"). Sem isso o envio é recusado: "Informe o cargo e a lotação no seu cadastro (escolha na lista ou digite em «Não está na lista?») antes de comunicar." Para outro servidor, esses campos só valem se o cadastro dele estiver sem.
   - **Vínculo**: só "Servidor". Acidentes e CAT/SP valem só para servidor: se o envolvido não é servidor (terceirizado, estudante, bolsista, residente, visitante etc.), o envio é recusado com a mensagem "A análise de acidentes e a CAT/SP valem só para servidor. Para quem não é servidor (do envolvido N), use o módulo Ocorrências." e o caso deve ser registrado no módulo Ocorrências.
   - **Condição no acidente**: Servidor acidentado, Servidor envolvido sem lesão, Condutor, Passageiro, Pedestre, Ciclista, Motociclista, Testemunha envolvida ou Outro.
   - **Houve lesão?**: Sim, Não ou Não sei.
   - **SIAPE** (7 dígitos): só para vínculo Servidor.
   - **Contato para a investigação (opcional)**: e-mail institucional ou ramal.
   - Blocos opcionais: "Dados pessoais do envolvido — Anexo III da CAT/SP (opcional)" e "O que você sabe sobre a lesão (opcional)" (atendimento, afastamento, internação, óbito, parte do corpo atingida).
3. Na seção **2. O que aconteceu**, preencha:
   - **Espécie**: Típico, Trajeto, Doença relacionada ao trabalho, Incidente / quase acidente ou Outro.
   - **Data do acidente**, Hora (opcional), Tempo de jornada (opcional, HH:MM), Último dia trabalhado (opcional).
   - **Tipo de local**, Campus (opcional; em branco vale o campus de lotação do acidentado; há a opção "Fora de campus / não sei"), Município (opcional), UF (já vem MG), **Onde foi**, CNPJ da empresa contratada (só se o local for dela).
   - Se o local for de trânsito, aparecem: "Houve registro policial?", "Número do boletim" e "Vítima de terceiros?".
   - Agente causador, Situação geradora, Agente da doença (para doença relacionada ao trabalho) e Atividade no momento (opcionais).
   - **O que aconteceu** (obrigatório, até 4000 caracteres).
4. Na seção **3. Testemunhas (opcional)**, informe nome, vínculo e contato (e-mail institucional ou ramal), até 5 testemunhas. Há um bloco "Endereço e telefone da testemunha" (opcional): ele vai para a identificação restrita, não para a ficha comum.
5. Na seção **4. Declaração e envio**:
   - Marque "Sou a chefia imediata de quem se acidentou", se for o caso.
   - Marque **Declaro que as informações são verdadeiras.** (obrigatória).
   - Clique em **Enviar comunicação**.

**O que acontece depois**

- Você vê a ficha com a mensagem "Comunicação CAT-2026-0001 enviada à equipe de segurança do trabalho. O prazo legal (10 dias da data do acidente) é acompanhado por ela." (o número é de exemplo).
- O sistema cria o protocolo `CAT-AAAA-NNNN`, calcula o prazo (data do acidente mais 10 dias) e abre as tarefas da equipe: "Triar a comunicação CAT-..." (2 dias) e "Prazo legal de comunicação de CAT-... (art. 214 da Lei 8.112)". Se você declarou lesão, abre também a tarefa "Confirmar a saúde declarada em CAT-..." para o médico.
- Se o acidentado é menor de idade, a mensagem avisa que a ocorrência fica restrita e que o responsável legal precisa ser avisado. Quem avisa é a equipe, por fora do sistema. Quem não é da equipe de segurança do trabalho volta para "Minhas comunicações" e não vê a ficha. Informar uma data de nascimento que torna a pessoa menor na data do acidente também restringe a ocorrência.

**Dicas**

- Descreva o evento (o que aconteceu, onde, com que equipamento). **Não escreva diagnóstico, CID nem CPF** no relato. A parte do corpo atingida se marca na lista do envolvido. A saúde é registrada depois, pelo médico.
- Se o relato for recusado, o formulário volta preenchido. Só o CPF digitado não volta; digite de novo.
- O sistema **não avisa se o mesmo acidente já foi comunicado**. Antes de comunicar, confira com colegas e com "Minhas comunicações" para não gerar protocolos repetidos.
- Se você comunica o acidente de outra pessoa, desmarque "Sou eu o envolvido". Mesmo assim, a menos que você marque "Sou a chefia imediata" ou tenha perfil de triagem (equipe), a ficha escreve "Pelo próprio acidentado" na origem: é erro de rótulo, só a equipe tem como saber quem de fato comunicou (ver capítulo 14).
- Os rótulos de condição "Servidor acidentado" e "Servidor envolvido sem lesão" são coerentes com a regra: o acidentado é sempre servidor.

---

## 2. Comunicar sem conta (link público)

Serve para servidores sem conta, ou para quem comunica por eles. O acidentado informado tem de ser servidor: a comunicação pelo link também recusa terceirizado, estudante, visitante etc., com a mesma mensagem "A análise de acidentes e a CAT/SP valem só para servidor. Para quem não é servidor (do envolvido N), use o módulo Ocorrências.", e manda registrar em Ocorrências.

### 2.1 Quem gera o link (secretaria ou equipe)

Quem pode triar gera o link. O atalho **não está no menu do módulo**: use o cartão "Link de comunicação" no **Painel**.

1. No Painel, abra o cartão "Link de comunicação" ("Para quem não tem conta comunicar").
2. Em **Gerar link**, no campo **Para**, escolha "Toda a UFVJM (geral)" ou um campus.
3. Clique em **Gerar**.
4. A tela mostra o endereço **uma única vez**: "Link gerado. Copie agora: ele não aparece de novo." Copie na hora.
5. Divulgue só internamente (intranet, e-mail institucional, cartaz no setor).

Regras:

- Gerar de novo para o mesmo recorte (geral ou o mesmo campus) **desliga o anterior**. Cartazes já impressos com o endereço antigo deixam de funcionar.
- Em "Links em uso", o botão **Desligar** encerra um link. Quem abrir o endereço antigo vê "link inválido".
- O contador "Comunicações por link a triar: N de 30" mostra quantas estão sem triagem. **Ao chegar a 30, o link para de receber** até a equipe triar.
- Se o link se perder, gere outro. Não há como ver o endereço de novo.

### 2.2 Quem preenche (sem login)

1. Abra o endereço recebido.
2. Seção **1. Quem está comunicando**: Seu nome, Seu e-mail (só para a equipe falar com você; nada é enviado automaticamente) e Seu vínculo.
3. Seção **2. Quem se envolveu**: três quadros; o primeiro é obrigatório e os outros dois opcionais (Nome, Vínculo [só "Servidor"], "SIAPE, matrícula ou crachá (opcional)", Condição, Houve lesão?, Empresa contratada, Menor de idade).
4. Seção **3. O que aconteceu** (mesmos campos do capítulo 1).
5. Seção **4. Testemunhas (opcional)**: até 2, com nome e contato (e-mail ou ramal).
6. Seção **5. Privacidade e envio**: marque **Li o aviso de privacidade.** e **Declaro que as informações são verdadeiras.** (as duas são obrigatórias) e clique em **Enviar comunicação**.

**O que você vê depois:** a tela "Comunicação recebida" com o protocolo (por exemplo CAT-2026-0008). **Anote o protocolo**: é por ele que a equipe identifica sua comunicação. O formulário não envia e-mail automático. A equipe pode procurar você pelo e-mail informado.

O formulário público não aceita anexos, dados de saúde, CPF, endereço nem telefone pessoal. O endereço de rede de quem envia é guardado por 90 dias, contra abuso, e depois apagado (texto do aviso de privacidade da própria tela).

**Erros comuns**

| Mensagem | O que fazer |
|---|---|
| "Informe o seu nome: a equipe precisa saber a quem voltar." | Preencha seu nome |
| "Informe um e-mail válido para contato." | Corrija o e-mail |
| "Marque que leu o aviso de privacidade para enviar a comunicação." | Marque a caixa |
| "Marque a declaração de que as informações são verdadeiras para enviar a comunicação." | Marque a declaração |
| "Envios demais deste endereço. Espere alguns minutos e tente de novo." (limite de 5 por endereço de rede em 10 minutos) | Aguarde; se for urgente, avise a chefia ou a equipe de segurança do trabalho |
| Título "Link inválido" | O link foi desligado, trocado ou digitado errado; peça outro à secretaria |

Recarregar a página de confirmação não reenvia. O botão "Comunicar outro acidente" reabre o formulário.

---

## 3. Acompanhar e responder complementação ("Minhas comunicações")

**Onde:** menu "Minhas comunicações". Mostra o que você comunicou ou em que foi acidentado. A coluna "O que falta" diz:

- "com a equipe de segurança do trabalho": nada a fazer.
- "nada: encerrada".
- link **Responder à complementação**: a equipe pediu mais informações.

**Para responder**

1. Clique em **Responder à complementação**.
2. Na tela "Complementar a comunicação CAT-...", leia "O que a equipe pediu" e escreva no campo **Sua resposta** (até 2000 caracteres; sem CPF e sem diagnóstico, o filtro de termos de saúde também vale aqui).
3. Clique em **Enviar resposta**.

Resultado: "Resposta enviada. A CAT/SP de CAT-... ganhou a versão 2." A ocorrência volta para "Em triagem". O prazo da resposta é de 5 dias.

| Mensagem | O que significa |
|---|---|
| "Escreva a sua resposta." | O campo está vazio |
| "Só quem comunicou o acidente, ou o próprio acidentado, responde a complementação." | Você não é nenhum dos dois |
| "A ocorrência CAT-... não está aguardando complementação." | Já foi respondida, ou a equipe retomou o caso |

Quem comunicou pelo link público **não responde pelo sistema**: a equipe fala com a pessoa pelo e-mail informado.

---

## 4. Triagem (secretaria e equipe)

**Onde:** no Painel, cartão "Triagem" (fila já filtrada em "Recebida"), ou "Fila de ocorrências". Abra a ocorrência pelo protocolo. Os botões ficam no topo da ficha e mudam conforme a situação: **Assumir**, **Mudar a situação**, **Pedir complementação**, **Prorrogar o prazo**, **Retificar a CAT/SP** e **Cancelar**.

### 4.1 Assumir

1. Abra a ficha da ocorrência.
2. Clique em **Assumir** (aparece em qualquer situação aberta, inclusive "Em investigação" e "Relatório emitido"). Abre uma caixa com o texto "Você passa a conduzir CAT-...". Confirme no botão **Assumir** da caixa.

Resultado: "Você assumiu CAT-... O prazo legal passa a ser acompanhado por você." Você aparece em "Quem conduz" e a tarefa do prazo legal passa a ser sua. Se a ocorrência estava "Recebida", vai para "Em triagem"; nas outras situações, a situação **não muda**, só troca quem conduz.

Atenção:

- Quem tem permissão de triar pode assumir um caso que já é de **outra pessoa**, sem aviso a ela e sem tela que mostre quem era. Confira "Quem conduz" na ficha antes de clicar. A trilha registra "assumida (passou de outra pessoa da equipe)".
- Se a secretaria assumir, ela continua como "Quem conduz" mesmo quando o caso passa à investigação, mas não pode investigar. Nesse caso a equipe técnica deve apertar **Assumir** também.
- Quem leva um caso adiante pelo **Mudar a situação** sem que ninguém o tenha assumido passa a ser "Quem conduz". Se alguém (a secretaria, por exemplo) já assumiu, o técnico só passa a conduzir se apertar **Assumir**.

### 4.2 Mudar a situação

1. Clique em **Mudar a situação**.
2. Escolha o destino. A lista traz só o que é permitido (de "Recebida" para "Em triagem"; de "Em triagem" para "Em investigação"; de "Aguardando complementação" para "Em triagem").
3. Confirme (botão **Mudar**). Mensagem: "CAT-...: situação alterada para Em investigação." Ao ir para "Em investigação" o sistema abre a tarefa "Investigar CAT-... e emitir o relatório" (30 dias).

### 4.3 Pedir complementação

Só existe com a ocorrência **Em triagem**.

1. Clique em **Pedir complementação**.
2. Em **O que falta na comunicação** (obrigatório, até 2000 caracteres), escreva o que precisa. Não use termos de saúde.
3. Confirme. Mensagem: "Complementação pedida a quem comunicou CAT-.... O prazo da resposta é de 5 dias."

O pedido aparece como tarefa "Complementar a comunicação CAT-..." para quem comunicou. **O texto do pedido não vai por e-mail**; fica só no sistema. Em ocorrência vinda do link público o pedido é recusado ("Esta comunicação não veio de uma conta do sistema, então ninguém poderia responder por aqui. Peça o que falta pelo canal por onde ela chegou e retifique a CAT/SP com a resposta."): fale por e-mail e use **Retificar a CAT/SP**. O campo recusa termos de saúde, com a mensagem "O campo ... tem termo de saúde ou dado sensível. Escreva o que falta sobre o EVENTO...".

Se quiser seguir sem esperar a resposta, use **Mudar a situação** para "Em triagem". A tarefa de quem comunicou é fechada.

### 4.4 Prorrogar o prazo

1. Clique em **Prorrogar o prazo**.
2. Preencha **Nova data** e **Motivo**.
3. Confirme (botão **Prorrogar**).

A nova data tem de ser depois do prazo legal ("A nova data tem de ser depois do prazo legal (06/11/2026)."). O motivo é obrigatório ("Escreva o motivo da prorrogação."). O prazo legal continua registrado; o novo aparece como prazo efetivo no cabeçalho. O sistema não limita quantas vezes se prorroga.

### 4.5 Retificar a CAT/SP

Use quando o relato ou os fatos estão errados ou incompletos.

1. Clique em **Retificar a CAT/SP**.
2. Corrija os campos (Espécie, Data, Hora, Jornada, Local, Campus, Município, UF, CNPJ, trânsito, Agente, Situação, Atividade, O que aconteceu).
3. Preencha **Motivo** (obrigatório: "Escreva o motivo da retificação.").
4. Confirme.

O botão **Retificar a CAT/SP** aparece em todas as situações abertas, inclusive depois do relatório emitido. O sistema grava uma nova versão da CAT/SP (a anterior continua guardada) e **não muda a situação**. Mudar a data do acidente recalcula o prazo. **A retificação não altera envolvidos, saúde nem identificação.**

### 4.6 Cancelar

Só é possível **antes da investigação**.

1. Clique em **Cancelar**.
2. Escolha o **Motivo**: Comunicação duplicada, Comunicação indevida, Não é acidente em serviço ou Outro motivo. Com "Outro motivo" é preciso explicar.
3. Confirme. Mensagem: "CAT-... cancelada. O registro fica, com o motivo — nada foi apagado."

Depois de "Em investigação" o cancelamento é recusado. Se não era acidente em serviço, isso vai no relatório.

### 4.7 Se a tela mostra erro de versão

"A ocorrência ... foi alterada por outra pessoa depois que você abriu a tela. Recarregue a ficha, confira o que mudou e refaça o que pretendia." Recarregue e repita o ato.

Se uma ação for tentada com a tela desatualizada (por exemplo, Pedir complementação com o caso já em investigação), o sistema pode mostrar uma tela de erro genérica em vez de mensagem explicativa. Recarregue a ficha e veja a situação atual.

---

## 5. Investigação, checklist, entrevistas e evidências

**Quem faz:** técnico, engenheiro, coordenação e superintendência. Médico e secretaria: a secretaria vê "Restrito à equipe que investiga" nas abas Análise ("Sem acesso"), Investigação, Checklist, Entrevistas, Relatórios, Ações, SIASS e Histórico; o médico enxerga o conteúdo (a Investigação aparece como "Somente leitura"), mas não edita.

**Quando se edita:** só com a ocorrência "Em triagem" ou "Em investigação". Depois de "Relatório emitido", tudo trava: "A investigação de CAT-... está travada: o relatório já foi emitido. Mudar o que ele diz é retificar o relatório." (ver capítulo 14: o texto da investigação não pode mais ser corrigido).

### 5.1 Aba Análise (só leitura)

É a conferência automática do que a comunicação, os envolvidos e a investigação já trazem, contra os itens do Anexo III da CAT/SP. Mostra "Falta (Anexo III)", "Atenção" e "Próximo passo", com link **abrir** para a aba certa. Use como lista do que falta.

### 5.2 Aba Investigação

1. Abra a aba "Investigação".
2. Preencha os campos de texto: Objetivo da análise, Equipe da análise, Trabalho habitual, Prescrito e real, Mudanças no indivíduo, Mudanças na tarefa, Mudanças no material, Mudanças no meio, Relatos de campo, Evidências, Síntese explicativa, Ampliação conceitual, Recomendações e observações. Cada campo tem um "i" com ajuda.
3. Responda as três escolhas:
   - "O ambiente de trabalho foi fator do acidente?" (Sim, Não, Não sei).
   - "Caracterizado como acidente em serviço (parecer da SST)?" (Sim, Não, Inconclusivo).
   - "Requer abertura da CAT/SP no SIASS?" (Sim, Não, Não sei).
4. Clique em **Salvar a investigação**. A tela mostra "Versão N, salva em ...".

Para emitir o relatório, **a Síntese explicativa e a caracterização como acidente em serviço são obrigatórias**.

Cuidados:

- Descreva o trabalho, o material e o meio. Não escreva CPF, diagnóstico nem CID. Mensagem: "O campo objetivo da análise tem termo de saúde ou dado sensível (cpf). A análise descreve o trabalho, o material e o meio; a saúde é do médico do trabalho, em campo próprio." Mesmo assim, evite palavras clínicas em geral (queimadura, fratura): o filtro pode deixá-las passar, mas elas não pertencem a este campo.
- Depois de cada **Salvar**, a versão sobe. Se salvar de novo com a tela antiga, aparece o erro 409: "A investigação de CAT-... foi salva por outra pessoa depois que você abriu a tela. Nada do que você digitou foi gravado: compare com o que está salvo, ajuste e salve de novo." A tela mostra o seu texto ao lado do gravado. Recarregue a aba antes de continuar editando.

**Linha do tempo:** em "Quando" ponha a hora (09:40) ou o momento relativo (T-10min, véspera); em "O que aconteceu", descreva; clique em **Acrescentar**. **Tirar** retira o item da lista (continua na trilha). A ordem é a de inclusão e **não dá para editar nem reordenar**. Erro: "Diga quando: a hora (09:40) ou o momento relativo (T-10min, véspera)."

**Barreiras:** escolha Tipo (Física, Funcional, Simbólica, Administrativa), Situação (Existia e funcionou, Existia e falhou, Ausente) e "Qual"; clique em **Acrescentar**. **Tirar** remove.

### 5.3 Aba Checklist

Checklist de campo em seções ("0. Preparação", "1. Trabalho habitual", "2. Mudanças", "3. Barreiras", "4. Sinais de alerta"...).

1. Marque os itens e escreva a observação de cada um.
2. Clique em **Salvar o checklist**. Mensagem: "Checklist salvo."
3. Para incluir um item seu, use "Acrescentar item": escolha a **Seção** (há também "8. Pontos específicos do caso"), escreva o **Item** (até 300 caracteres) e clique em **Acrescentar**. Mensagem: "Item acrescentado."

Só o item acrescentado pela equipe pode ser tirado: "Só o item acrescentado pela equipe sai da lista; os da base ficam (use a observação)." Há o botão **Imprimir o checklist** para levar a campo.

### 5.4 Aba Entrevistas (entrevistas e evidências)

A aba se chama **Entrevistas** e tem duas partes: "Entrevistas" e "Evidências".

**Registrar entrevista**

1. Preencha **Entrevistado** (obrigatório: "Informe quem foi entrevistado."), Vínculo, Quando, Entrevistadores e **Relato** (até 20 mil caracteres, sem CPF nem saúde).
2. Se for anexar áudio, marque **Consentimento para gravar obtido do entrevistado**. Use Gravar/Parar, ou "Ou anexe o áudio (até 4 MB)". Formatos aceitos: WebM, Ogg, WAV, MP3, M4A.
3. Clique em **Registrar a entrevista**.

Sem consentimento marcado: "A gravação só entra com o consentimento do entrevistado registrado: marque “consentimento obtido” ou registre a entrevista sem o áudio."

**Anexar evidência**

1. Escolha o arquivo (PDF ou imagem PNG, JPEG, GIF ou WebP, até 4 MB).
2. Escreva a **Descrição**. Fotografe o local, o equipamento e as condições, **nunca a lesão**.
3. Clique em **Anexar**.

Recusas: "A evidência vai em PDF ou imagem (PNG, JPEG, GIF, WebP).", "Este arquivo já está entre as evidências do caso.", "Escolha o arquivo da evidência."

**Entrevistas e evidências não podem ser editadas nem excluídas** depois de salvas. Confira antes.

---

## 6. Saúde e identificação (acesso restrito)

Toda abertura de saúde ou de identificação **fica registrada** junto com a sua finalidade e o seu nome.

### 6.1 Abrir a saúde

1. Na ficha, abra a aba **Saúde**.
2. Escolha a **Finalidade**: Investigar o acidente, Classificar a gravidade, Instruir a perícia do SIASS, Atender o próprio acidentado ou Auditoria.
3. Em **O que abrir**, escolha "Resumo (nível 1)" ou "Detalhe (nível 2)" (o detalhe só aparece para quem tem a permissão).
4. Clique em **Abrir saúde**.

- Sem finalidade: "Escolha a finalidade antes de abrir a saúde: ela fica registrada junto com a sua leitura."
- Técnico e engenheiro: a lista "O que abrir" só traz o "Resumo (nível 1)"; a opção "Detalhe (nível 2)" não aparece para eles. Quem não tem acesso nenhum à saúde (secretaria) lê "Seu perfil não abre a saúde."
- O **próprio acidentado servidor** abre sem finalidade e vê tudo da sua ocorrência (marcada "é você"), inclusive o Detalhe (nível 2).
- Quem só comunicou o acidente de outra pessoa **não abre a saúde**.

O nível 1 mostra: Natureza da lesão, Partes do corpo, Lateralidade, Atendimento, Afastamento, Internação, Óbito e Sequela, com a marca "Declarado por quem comunicou (a confirmar)" ou "Registrado pelo médico do trabalho".

O nível 2 acrescenta: dias de afastamento, afastamento (início a retorno), dias de internação, data do óbito, dias debitados, primeiro socorro, atendimento em, duração provável do tratamento, deve afastar-se, descrição da lesão, diagnóstico provável, CID e observações.

### 6.2 Registrar a saúde (médico)

1. Abra a aba Saúde, com o **Detalhe (nível 2)**.
2. Confirme ou corrija os dados declarados. O formulário "Confirmar ou corrigir" (ou "Registrar", se ainda não há nada) traz: Natureza da lesão, Lateralidade, Atendimento/Afastamento/Internação/Óbito/Sequela (Sim, Não, Não sei), Dias de afastamento, Início do afastamento, Retorno, Dias de internação, Data do óbito, Dias debitados, Primeiro socorro (quem e onde), Atendimento em, Duração provável do tratamento (dias), Deve afastar-se durante o tratamento, CID, Diagnóstico provável, Descrição da lesão e Observações. O formulário só aparece com o **Detalhe (nível 2)** aberto.
3. Clique em **Salvar saúde**.

Se a lista de Natureza da lesão vier vazia, a tela avisa "A tabela oficial de natureza da lesão ainda não foi carregada; o campo fica sem opções até lá."

Resultado: a origem passa a "Registrado pelo médico do trabalho" e a tarefa "Confirmar a saúde declarada em CAT-..." fecha.

| Mensagem | Solução |
|---|---|
| "CID: use o formato da CID-10, por exemplo S61.0." | Corrija o CID |
| "O retorno do afastamento não pode ser antes do início." | Ajuste as datas |
| "A data do óbito só vale quando o óbito está marcado como «Sim»." | Marque o óbito ou apague a data |
| "Outra pessoa alterou esta saúde enquanto a tela estava aberta. Abra de novo e refaça a alteração." | Reabra a aba e refaça |

**Aviso importante:** hoje, se a ocorrência ainda **não tem a "Natureza da lesão" preenchida**, abrir o Detalhe (nível 2) dá tela de erro. Enquanto isso não for corrigido, o registro inicial da saúde pela tela fica indisponível. Avise a coordenação (capítulo 14).

### 6.3 Identificação pessoal (Anexo III)

1. Abra a aba **Identificação**.
2. Escolha a **Finalidade**: Contatar o envolvido ou a testemunha, Investigar o acidente, Emitir a CAT/SP no formato do Anexo III, Instruir a perícia do SIASS ou Auditoria.
3. Clique em **Abrir identificação**.

Mostra sexo, data de nascimento, CPF mascarado, RG, endereço, telefone, e-mail e contatos das testemunhas. A secretaria não acessa. O próprio acidentado servidor abre a sua sem informar finalidade (se nada foi informado, a tela diz "Nada foi informado para este envolvido.").

**Completar a identificação.** Quem tem a permissão de ver a identificação (acidente.identificacao_ver) completa o que faltou no Anexo III depois da comunicação: na aba Identificação, em cada envolvido, abra "Completar a identificação", preencha só o que falta (sexo, data de nascimento, CPF, RG, endereço, telefone, e-mail) e clique em **Salvar a identificação**. Só o que foi digitado entra: o que já estava gravado e fica em branco continua como estava, e campo em branco não apaga. Sem nenhum campo preenchido a tela recusa ("Preencha ao menos um campo para completar a identificação."). Não se completa em ocorrência cancelada nem em identificação já expurgada. A mensagem de sucesso é "Identificação completada. O que já estava gravado e não foi digitado continua como estava." A trilha registra só os grupos de campo, nunca o valor. A "Retificar a CAT/SP" continua sem incluir esses dados.

### 6.4 CAT/SP no formato do Anexo III (PDF)

Na aba Identificação, clique em "Baixar a CAT/SP no formato do Anexo III (para o SIASS)".

- Só **médico, coordenação e superintendência** conseguem (exige identificação e detalhe da saúde). Para técnico e engenheiro o link nem aparece na aba (e o endereço direto responde acesso negado): peça a um deles.
- O PDF tem 3 páginas e **não é guardado**: é gerado a cada pedido, e cada emissão fica registrada. É o único lugar em que o CPF sai por inteiro. Trate como documento restrito.
- Campos que não foram informados saem em branco (por exemplo, matrícula SIAPE de quem não é servidor, "Após quantas horas", "Houve morte").
- O nexo causal sai "Encaminhar" enquanto não há decisão da perícia.

---

## 7. Plano de ação

**Quem usa:** quem investiga (técnico, engenheiro, coordenação, superintendência). O médico lê a lista e a aba Ações, mas não cria nem altera ação. A secretaria não acessa o menu (acesso negado) e vê "Restrito à equipe que investiga" na aba Ações.

**Onde:** menu **Plano de ação** (lista geral de todos os casos, com filtros "Em aberto", "Vencidas" e "Todas") e aba **Ações** dentro da ficha. A ação é criada, editada e concluída na aba Ações, em qualquer situação, **menos Cancelada**. Continua possível depois de "Concluída".

**Criar uma ação**

1. Na aba Ações, preencha:
   - Achado que motiva a ação (opcional);
   - **Ação** (obrigatória);
   - **Tipo** (Engenharia / proteção coletiva, Organização do trabalho, Sinalização, Manutenção, Procedimento, Treinamento / orientação, EPI, Gestão / planejamento, Outra);
   - **Prioridade** (Alta, Média, Baixa);
   - **Prazo** (não pode ser no passado);
   - "Conta responsável" ("Quem conduz o caso" ou "Eu"), "Unidade responsável" e responsável em texto livre.
2. Salve. Mensagem: "Ação acrescentada ao plano." Cada ação gera uma tarefa "Cumprir a ação nº N de CAT-..." com o prazo.

**Ciclo:** Pendente, então **Iniciar** ("Ação em andamento."), então **Concluir** (descreva "o que foi feito", obrigatório, com evidência opcional em PDF ou imagem; o botão Concluir só aparece depois de Iniciar) ou **Cancelar** (vale também para ação ainda Pendente; motivo obrigatório; a ação continua no plano, riscada). **Editar** só enquanto a ação está aberta ("Ação alterada."). Os textos da ação recusam CPF ("... tem um número com formato de CPF. CPF não entra no plano.") e termos de saúde.

Recusas comuns: "Informe a ação.", "Escolha o tipo da ação.", "O prazo de uma ação nova não pode ser no passado.", "A ação já terminou: não se altera.", "Informe o que foi feito.", "Informe o motivo do cancelamento.", "Uma ação nesse estado não pode ir para esse estado." Erro de versão: "Outra pessoa alterou esta ação enquanto a tela estava aberta. Abra de novo e refaça a alteração."

Não existe reabrir ação concluída ou cancelada, nem atribuir a ação a outra pessoa com conta (só a si mesmo, a quem conduz, a uma unidade ou texto livre).

O plano de ação **não é exigido** para emitir o relatório.

---

## 8. Relatório técnico

**Quem emite:** técnico, engenheiro, coordenação e superintendência (e precisa do resumo da saúde). O médico não emite.

**Antes de emitir, confira:**

- A ocorrência está **Em investigação** ("O relatório só se emite com o caso em investigação.").
- A **Síntese explicativa** está preenchida ("Preencha a síntese explicativa na Investigação antes de emitir o relatório.").
- A caracterização como acidente em serviço foi escolhida ("Diga na Investigação se o evento se caracteriza como acidente em serviço antes de emitir o relatório.").

**Passos**

1. Abra a aba **Relatórios**.
2. Clique em **Emitir relatório**.

O sistema gera **duas variantes ao mesmo tempo**, versão 1:

- **Completa (para a perícia do SIASS)**: com resumo de saúde.
- **Sem dados de saúde (contratada e fiscal)**.

A ocorrência passa para "Relatório emitido" e a investigação e o checklist travam. A tabela "Relatório técnico" mostra Versão, Variante, Emitido (data, hora e quem emitiu), Situação (vigente ou retificada) e Arquivo (**Baixar PDF**, com um código curto de conferência abaixo). Emitir a variante completa lê a saúde do acidentado, e essa leitura fica registrada em seu nome.

**Quem baixa**

- Completa: quem investiga ou encaminha e tem acesso à saúde (técnico, engenheiro, médico, coordenação, superintendência). Secretaria e servidor acidentado recebem acesso negado.
- Sem dados de saúde: as mesmas pessoas, e também, pela permissão, a secretaria e o próprio acidentado servidor. Porém a tela da secretaria e a do acidentado **não mostram a tabela nem o botão Baixar PDF** (a aba Relatórios diz "Restrito à equipe que investiga"): só quem investiga ou encaminha vê a tabela. Na prática, quem precisa do arquivo o pede à equipe. Mesmo essa variante leva nome, SIAPE e relato do acidente: trate com cuidado.
- Quem só comunicou outro acidente não baixa.

O PDF tem 2 páginas e traz identificação, envolvidos, o que aconteceu, saúde (só na completa), análise do trabalho, linha do tempo, barreiras, checklist, contagem de entrevistas e evidências e conclusão técnica. O rodapé lembra: "A assinatura oficial deste relatório é feita no SEI, no processo do caso."

**Retificar o relatório**

1. Na aba Relatórios, preencha **Motivo da retificação** (pelo menos uma frase: "Diga o motivo da retificação (pelo menos uma frase).").
2. Clique em **Retificar relatório**.

Gera a versão seguinte das duas variantes com o que está vigente hoje (CAT/SP, plano de ação, saúde). A anterior fica "retificada". **O texto da investigação não é reaberto.** Com o caso concluído: "O caso está concluído: o relatório não se retifica mais."

Atenção à data: entre 21h e 23h59 (horário de Brasília) o PDF pode imprimir o "emitido em" com o **dia seguinte**. A tabela da aba mostra a data correta. Se precisar da data exata, use a tabela.

---

## 9. SIASS, decisão da perícia e conclusão

**Quem faz:** técnico, engenheiro, coordenação, superintendência e médico. A secretaria não acessa. Abra a aba **SIASS**.

### 9.1 Encaminhar ao SIASS

Só com o caso em "Relatório emitido".

1. Escolha o **Meio**: Processo no SEI, Sistema do SIASS, E-mail institucional ou Presencial.
2. Se o meio for SEI, informe o **NUP do SEI** (17 dígitos, no formato 23086.000000/2026-00).
3. Informe a **Data do encaminhamento** (não pode ser futura).
4. Escreva a **Observação**, se houver.
5. Clique em **Registrar encaminhamento**.

O primeiro encaminhamento leva o caso a "Encaminhada ao SIASS", fecha a tarefa do prazo de comunicação e abre a tarefa "Aguardar a decisão da perícia sobre CAT-...". **O sistema não envia nada ao SIASS**: ele só registra o que você fez por fora (SEI, e-mail etc.). O Anexo III também não é anexado automaticamente.

Mensagens: "O NUP do SEI deve ter 17 dígitos (23086.000000/2026-00).", "Pelo SEI, informe o NUP do processo.", "A data do encaminhamento não pode ser no futuro."

### 9.2 Registrar a decisão da perícia

Só depois do encaminhamento ("A decisão da perícia se registra depois do encaminhamento ao SIASS.").

1. Escolha o **Resultado**: Acidente em serviço reconhecido, Não reconhecido ou Outro resultado.
2. Informe a data da decisão, o número da "CAT no SIASS" (letras, números, ponto, barra e hífen) e a observação.
3. Clique em **Registrar decisão**.

Registrar de novo marca a anterior como "corrigida"; vale a última.

### 9.3 Concluir a ocorrência

1. No bloco "Concluir a ocorrência", escreva o **Motivo**, se for pedido.
2. Clique em **Concluir ocorrência**. Mensagem: "Ocorrência concluída."

Regras:

- Com encaminhamento: precisa da decisão da perícia **ou** de um motivo ("Registre a decisão da perícia ou diga o motivo de concluir sem ela.").
- Sem encaminhamento: só se a investigação marcou "Requer abertura da CAT/SP no SIASS?" como **Não**, e com motivo.
- Antes do relatório: "O caso só se conclui depois de emitido o relatório."
- Repetir: "O caso já está concluído."

**Reabrir a investigação (só a coordenação).** Na aba Comunicação, o botão **Reabrir a investigação** aparece para a coordenação quando o caso está em "Relatório emitido" ou "Encaminhada ao SIASS". Escolha o **Motivo** na lista (Corrigir a investigação ou o relatório; Informação nova sobre o caso; Encerrado por engano; Outro motivo) e clique em **Reabrir**. O caso volta para "Em investigação", a investigação destrava e abre-se de novo a tarefa de investigar com prazo; o relatório novo sai pela retificação. Se você não é da coordenação, peça a ela.

**"Concluída" é final.** A investigação de um caso concluído não reabre: "Se o caso voltou, comunique de novo: a reabertura é uma ocorrência nova." (novo protocolo, novo prazo de 10 dias).

---

## 10. Painel, fila e indicadores

### 10.1 Painel

Menu "Painel" (para quem é só servidor, a página é mais simples: "Comunicar acidente" e "Minhas comunicações"). Traz cartões de acesso rápido (Comunicar acidente, Triagem, Em investigação, Fila de ocorrências, Link de comunicação, Plano de ação, Indicadores, Encaminhar ao SIASS) e contadores: "Prazo do art. 214 vencendo" (próximos 3 dias ou já vencido, em casos ainda não encaminhados nem encerrados), "Aguardando complementação", "Aguardando perícia" e contagem por situação.

### 10.2 Fila de ocorrências

Menu "Fila de ocorrências". Filtros: Situação (Todas, Em aberto, Prazo vencendo ou vencido e cada situação), Espécie, Campus, "Acidente a partir de" e "até", Protocolo e a caixa "Só as que eu conduzo". Botões **Filtrar** e **Limpar**. Mostra 50 por página, da data mais recente para a mais antiga. A coluna "Prazo de comunicação" marca "vencido" (não marca casos já encaminhados ao SIASS, concluídos ou cancelados). A coluna "Condução" mostra "com você", "assumida" (por outra pessoa; o nome só aparece na ficha) ou "ninguém ainda". O filtro Protocolo aceita parte do número.

**Não há busca por nome nem por SIAPE**, de propósito: só por protocolo. Se você só sabe o nome, pergunte o protocolo a quem comunicou ou filtre por data e espécie.

### 10.3 Tarefas

Em "Pendências" aparecem as tarefas do módulo, com estes nomes: "Triar a comunicação CAT-..." (2 dias), "Prazo legal de comunicação de CAT-... (art. 214 da Lei 8.112)" (10 dias da data do acidente), "Confirmar a saúde declarada em CAT-..." (médico, 5 dias), "Complementar a comunicação CAT-..." (quem comunicou, 5 dias), "Investigar CAT-... e emitir o relatório" (30 dias), "Cumprir a ação nº N de CAT-..." e "Aguardar a decisão da perícia sobre CAT-..." (60 dias). Fecham sozinhas quando o ato é feito. A tarefa de triar uma ocorrência restrita (menor de idade) pode aparecer para a secretaria, que não consegue abrir a ficha. Nesse caso, avise a equipe técnica.

### 10.4 Indicadores

Menu "Indicadores". Escolha o período por **Ano** (os 4 últimos) ou "Período livre" (De/Até) e clique em **Aplicar**. **Exportar CSV** só para quem tem permissão de exportar (a secretaria não tem; coordenação, superintendência, engenheiro, técnico e médico exportam). O arquivo usa ponto e vírgula como separador, abre direto no Excel e repete os mesmos números da tela, com o mesmo sigilo ("—").

Mostra: Ocorrências no período, "Casos com afastamento" e "Dias perdidos" (só para quem lê o nível 2 da saúde), Por ano, Por espécie, Por campus e Por unidade do local. Cancelados ficam fora.

Sigilo estatístico: recortes com menos de 5 casos aparecem como "—". Quando só um recorte ficaria escondido, o menor dos outros também é escondido, para não permitir descobrir o número.

Período invertido ou inválido é recusado.

---

## 11. Situações da ocorrência

| Situação | O que significa | Próximos passos possíveis |
|---|---|---|
| Recebida | Comunicação chegou, ninguém assumiu | Assumir ou Mudar a situação (Em triagem); Cancelar |
| Em triagem | Equipe conferindo a comunicação | Pedir complementação; Mudar a situação (Em investigação); Cancelar |
| Aguardando complementação | Esperando a resposta de quem comunicou | Resposta (volta a Em triagem), Mudar a situação (Em triagem) ou Cancelar |
| Em investigação | Equipe técnica analisando o trabalho | Emitir relatório. Não volta à triagem; não cancela |
| Relatório emitido | Relatório pronto, investigação travada | Encaminhar ao SIASS; ou Concluir (só se a investigação marcou que não requer CAT no SIASS) |
| Encaminhada ao SIASS | Registrado o encaminhamento | Decisão da perícia; Concluir ocorrência |
| Concluída | Encerrada | Nada. Nova comunicação se o caso voltou |
| Cancelada | Encerrada antes da investigação, com motivo | Nada |

---

## 12. Erros e mensagens comuns

| Mensagem | O que fazer |
|---|---|
| "Marque a declaração de que as informações são verdadeiras para enviar a comunicação." | Marque a declaração e envie |
| "Descreva o que aconteceu." | Preencha o relato |
| "Escolha a espécie do acidente na lista." | Escolha a espécie |
| "Diga onde foi o acidente (sala, prédio, trecho)." | Preencha "Onde foi" |
| "a data do acidente não pode ser depois de hoje." | Corrija a data |
| "O SIAPE 9999999 do envolvido 1 não está no cadastro de servidores. Confira o número ou, se a pessoa não for servidora, escolha outro vínculo e informe o nome." | Confira o SIAPE (só servidor entra aqui; quem não é servidor vai para Ocorrências) |
| "Informe o SIAPE (7 dígitos) do envolvido 1." | Digite os 7 dígitos |
| "Informe o nome do envolvido 1 (quem não é servidor entra pelo nome)." | Informe o nome |
| "O CNPJ da contratada vai como 00.000.000/0000-00." | Use esse formato |
| "O envolvido N repete você, já informado." / "O envolvido N repete um servidor já informado." | Você marcou "Sou eu" e também digitou o seu SIAPE (ou o mesmo SIAPE duas vezes): retire a repetição |
| "Informe o cargo e a lotação no seu cadastro (escolha na lista ou digite em «Não está na lista?») antes de comunicar." | Preencha cargo e lotação no bloco do envolvido 1 |
| "Sua conta não está ligada a um cadastro de servidor: informe o seu SIAPE no envolvido." | Desmarque "Sou eu" e digite o SIAPE |
| "Uma ação ... não pode ir para esse estado." | A ação já terminou ou pulou uma etapa (por exemplo concluir sem iniciar) |
| "CPF inválido: confira os dígitos (11 números, com o verificador)." | Corrija o CPF |
| "O campo o que aconteceu tem termo de saúde ou dado sensível ..." | Tire diagnóstico, CID e CPF do texto; descreva o evento |
| Erro de versão (409) em ocorrência, investigação, saúde ou ação | Alguém alterou antes de você; recarregue e refaça |
| "A ocorrência ... está encerrada. Se o caso voltou, comunique de novo: a reabertura é uma ocorrência nova." | Faça nova comunicação |
| "Escolha a finalidade antes de abrir a saúde ..." | Escolha a finalidade e abra de novo |
| Tela de erro genérica após um clique | Recarregue a ficha e confira a situação; pode ter sido uma transição que não vale mais |
| "Seu perfil não abre a saúde." / "Restrito à equipe que investiga" | O perfil não lê aquela aba; peça a quem tem |
| Acesso negado (sem permissão) | O perfil não tem esse ato; peça a quem tem |

---

## 13. Glossário

- **CAT/SP**: Comunicação de Acidente em Serviço Público, a base do protocolo `CAT-AAAA-NNNN`.
- **Anexo III**: modelo de CAT/SP usado para o SIASS, com identificação pessoal e dados de saúde.
- **SIASS**: Subsistema Integrado de Atenção à Saúde do Servidor (perícia).
- **SEI**: sistema de processos; o NUP é o número do processo.
- **Triagem**: conferência inicial da comunicação.
- **MAPA**: método de análise de acidentes usado na aba Investigação.
- **Nível 1 / nível 2 (saúde)**: resumo / detalhe clínico.
- **Finalidade**: motivo informado para abrir saúde ou identificação, registrado junto com a leitura.
- **Prazo legal / prazo efetivo**: 10 dias da data do acidente / prazo prorrogado, se houver.
- **Quem conduz**: pessoa da equipe responsável pela ocorrência.
- **Restrita**: ocorrência de menor de idade, visível só à equipe de segurança do trabalho.

---

## 14. Limites conhecidos

Para você não ser pego de surpresa. Quando um destes pontos o afetar, avise a coordenação.

1. **Registro inicial da saúde.** Abrir o Detalhe (nível 2) como médico, com a "Natureza da lesão" ainda vazia, dá erro e a página não abre. Até a correção, o registro inicial da saúde pela tela fica indisponível.
2. **Identificação do Anexo III.** Pode entrar na comunicação (bloco "Dados pessoais do envolvido") e ser completada depois na aba Identificação, por quem tem a permissão de ver a identificação (ver 6.3). A "Retificar a CAT/SP" não inclui esses dados.
3. **Depois do relatório emitido**, não se corrige a síntese nem as escolhas da investigação, e um caso concluído não reabre (só nova comunicação). Com o relatório emitido ou encaminhado ao SIASS, a coordenação pode reabrir a investigação (ver o capítulo 9). Revise a investigação antes de clicar em **Emitir relatório**.
4. **Indicador "Por unidade do local"** sempre mostra "Sem unidade informada". As taxas de frequência e de gravidade ainda não existem.
5. **Aviso de responsável legal (menor de idade)** continua aparecendo, e não há onde registrar que o responsável foi avisado. Registre fora do sistema.
6. **Telas desatualizadas ou duas pessoas ao mesmo tempo** podem gerar tela de erro em vez de mensagem clara. Recarregue.
7. **Data do PDF do relatório** pode sair com o dia seguinte entre 21h e 23h59.
8. **Relatório "Sem dados de saúde"** inclui nome, SIAPE e relato. Pela permissão, a secretaria e o acidentado servidor conseguem baixá-lo (a tela deles não mostra o botão, mas o endereço do arquivo abre). Compartilhe só com quem precisa.
9. **Quem conduz o caso** pode ser a secretaria, sem permissão de investigar, e **Assumir** toma o caso de outra pessoa sem confirmação.
10. **Origem da comunicação**: a caixa "Sou eu o envolvido" já vem marcada, e quem comunica o acidente de outra pessoa (sem ser chefia nem equipe de triagem) fica registrado como "Pelo próprio acidentado", mesmo desmarcando a caixa.
11. **Comunicação duplicada** não é detectada. A saída é cancelar com o motivo "Comunicação duplicada".
12. **Incidente / quase acidente** segue o mesmo fluxo de um acidente com CAT: mesmo prazo de 10 dias e mesmo caminho até o SIASS.
13. Acidente de quem não é servidor não entra neste módulo: a comunicação é recusada e o caso vai para Ocorrências.
14. A aba Análise pede "Município e UF" mesmo quando a UF já vem preenchida.
15. O **Anexo III em PDF** é gerado pelo médico, pela coordenação ou pela superintendência; técnico e engenheiro não veem o link na aba Identificação.
16. **Linha do tempo, entrevistas e evidências** não se editam nem se reordenam. O **link público** não aparece de novo depois de gerado.
17. O filtro que barra termos de saúde nos textos livres não pega todas as palavras clínicas comuns (por exemplo "queimadura", "fratura"). Quem escreve deve evitá-las.
18. A frase do formulário "o responsável legal é avisado" (menor de idade) não corresponde a nenhum aviso: o sistema não envia nada ao responsável.
19. A trilha da aba Histórico não mostra a finalidade com que a saúde ou a identificação foi aberta; ela fica só na tela de Auditoria, que só coordenação, superintendência e administrador veem.
20. A importação de dados antigos e a limpeza de registros não fazem parte deste manual e não foram verificadas. Sobre os e-mails, ver o capítulo 15.

---

## 15. E-mails do módulo (lido no código, não exercitado)

No teste o envio de e-mail estava desligado. Pelo que o código diz, ele só funciona se a instituição ligar o recurso e configurar o servidor de e-mail; ligado, o e-mail leva **só protocolo e endereço da ocorrência** (nunca nome, relato ou saúde) e é mensagem automática, sem resposta. Quem recebe:

- **Comunicação nova**: o endereço do setor e quem comunicou com conta (confirmação de recebimento).
- **Pedido de complementação**: quem comunicou com conta (o texto do pedido não vai no e-mail).
- **Relatório emitido** e **caso concluído**: o acidentado que é servidor e tem conta (apenas "há novidade na sua ocorrência").
- Quem comunicou pelo link público **nunca** recebe e-mail.

Se um e-mail esperado não chegou, abra a aba Histórico da ocorrência: cada tentativa deixa um evento dizendo para quem foi ou por que não foi.
