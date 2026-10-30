# Manual do Coordenador: Ocorrências de Urgência e Emergência

Sistema SISA, UFVJM. Versão de 29/10/2026.

## Para quem é este manual

Para quem responde pelo módulo **Ocorrências de Urgência e Emergência**. Cabe a você cuidar de quem tem acesso, acompanhar o que chega, decidir como encerrar cada caso, olhar os números e zelar pela privacidade. Quem só registra uma ocorrência deve ler o manual do usuário.

## Antes de começar

- O módulo registra desmaio, queda, corte, crise convulsiva, acidente e situações parecidas de **qualquer pessoa** na universidade: servidor, estudante, terceirizado ou visitante.
- Ele **não é a CAT/SP**. A comunicação de acidente do servidor continua no módulo Análise de Acidentes. A ocorrência pode ser **vinculada** a ela.
- Se o módulo não aparecer ou toda página der "Página não encontrada.", ele pode não estar ligado no ambiente. Isso é uma configuração do servidor, feita pela TI.
- Perfis da equipe, com as três permissões (registrar, ver e tratar): coordenador, engenheiro, técnico, médico do trabalho, secretaria e superintendente.
- A **secretaria** faz tudo, menos exportar a planilha (CSV).
- O **servidor** comum só registra e vê o que ele mesmo registrou.
- **Almoxarife** e **administrador de TI** não têm acesso por padrão, nem para registrar.
- Perfis e permissões são concedidos na tela **Usuários**, por quem tem a permissão de conceder perfil, sempre com o ato normativo que autoriza.

## Sumário

1. Rotina de acompanhamento
2. O Painel
3. A Fila e seus filtros
4. A ficha da ocorrência e as decisões
5. Ocorrência de servidor em acidente de serviço (CAT/SP)
6. Indicadores
7. Planilha (CSV)
8. Acessos e privacidade
9. Auditoria e prazo de guarda
10. E-mails
11. Situações (estados)
12. Erros e mensagens comuns
13. Glossário
14. Limites conhecidos

## 1. Rotina de acompanhamento

O sistema **não envia alerta** nem controla prazo de ocorrência parada. A única campainha é você abrir o Painel. Por isso, combine uma rotina com a equipe.

**Todo dia, no início do turno**
1. Abra o módulo e o **Painel**.
2. Olhe o cartão **A assumir**. Ele mostra quantas ocorrências aguardam a equipe.
3. Se houver alguma, clique nele. A **Fila** abre já filtrada por "Registrada".
4. Abra cada ficha, confira o telefone de quem registrou, ligue, clique em **Assumir a ocorrência** e registre o que for sendo feito.

**Toda semana**
- Veja o cartão **Em acompanhamento**. Abra a Fila com Situação "Em acompanhamento" e confira se algum caso está parado. O sistema não mostra há quantos dias a ocorrência está aberta, então olhe a data do fato e os acompanhamentos.
- Peça que concluam o que já foi resolvido.

**Todo mês**
- Abra **Indicadores** com o período (De/Até) do mês e, se quiser, o campus.
- Exporte a planilha da Fila para o relatório, se precisar.

**Uma vez por ano, ou quando mudar a equipe**
- Revise quem tem perfil de equipe em **Usuários**.

## 2. O Painel

Menu **Painel** do módulo. Título: "Ocorrências de urgência e emergência". O Painel mostra só números, nunca nomes.

Cartões:
- **Registrar ocorrência**
- **Minhas ocorrências**: as que você mesmo registrou.
- **A assumir**: quantas aguardam a equipe.
- **Em acompanhamento**
- **Todas**: o total.
- **Indicadores**: só aparece para quem tem a permissão de ver indicadores.

## 3. A Fila e seus filtros

Menu **Fila de ocorrências**. A lista mostra protocolo e fatos. O nome da pessoa e o relato ficam só na ficha.

Colunas: Protocolo, Data e hora, Campus, Tipos, Vínculo, Situação.

Filtros (botão **Filtrar**): Situação, Campus, Tipo, Vínculo, De e Até. Se você digitar um valor inválido, o filtro é ignorado em silêncio e a lista mostra tudo.

Como conferir:
- A ordem é fixa: a mais recente primeiro, pela data do **fato** (não pela chegada nem pela urgência).
- O limite é de 500 linhas. Para recortes grandes, use os filtros de data.
- Não há coluna de "quem assumiu".
- Lista vazia: "Nenhuma ocorrência neste recorte".

## 4. A ficha da ocorrência e as decisões

Clique no protocolo (por exemplo OCO-2026-0001). Na ficha você vê o relato, a pessoa atendida, o socorro, o telefone e o e-mail de quem registrou, e o cartão **Acompanhamento da equipe**.

Os formulários aparecem nesta ordem, enquanto a ocorrência não estiver encerrada.

### 4.1 Assumir
1. Na situação "Registrada", clique em **Assumir a ocorrência**.
2. Mensagem: "OCO-… assumida: a ocorrência está em acompanhamento."
3. Se outra pessoa já assumiu: "OCO-… já foi assumida."

Registrar o primeiro acompanhamento também assume a ocorrência, em nome de quem escreveu.

### 4.2 Registrar acompanhamento
1. Escreva no campo de acompanhamento (até 4000 caracteres).
2. Clique em **Registrar**.
3. Mensagem: "Acompanhamento registrado."

Cada acompanhamento fica com data, hora e autor. **Não pode ser editado nem apagado.** Releia antes de enviar. Não escreva CPF nem código de doença (CID).

### 4.3 Vincular à comunicação de acidente
Veja o capítulo 5.

### 4.4 Concluir
1. Preencha **Concluir: o que foi feito** (obrigatório).
2. Clique em **Concluir**.
3. Mensagem: "OCO-… concluída."

### 4.5 Cancelar
1. Use somente para registro **feito por engano** ou duplicado.
2. Preencha **Cancelar (registro feito por engano): motivo** (obrigatório, até 400 caracteres).
3. Clique em **Cancelar a ocorrência**.
4. Mensagem: "OCO-… cancelada."

**Atenção, decisões sem volta.** Concluída e Cancelada são finais: não há reabrir, editar nem desfazer. Antes de clicar, confira se é a ocorrência certa. Depois de encerrada, a ficha não oferece mais nenhum formulário, nem o de vincular à CAT: **vincule antes de concluir ou cancelar**. O número de uma ocorrência cancelada não é reaproveitado.

Qualquer pessoa da equipe pode concluir ou cancelar uma ocorrência assumida por colega. Combine na equipe quem decide encerrar.

## 5. Ocorrência de servidor em acidente de serviço (CAT/SP)

Quando quem registra marca vínculo Servidor e "É um acidente em serviço? Sim", a ficha mostra a faixa: "Foi marcada como acidente em serviço de servidor: a comunicação da CAT/SP tem prazo de 10 dias." O link **Comunicar o acidente** aparece na faixa para qualquer pessoa com permissão de comunicar acidentes (você e quem registrou). A faixa some quando a ocorrência é vinculada a uma CAT. Quem registrou não vê o formulário de vincular, então ele depende de você ou da equipe.

Passos para você:
1. Garanta que a CAT/SP seja comunicada dentro do prazo de 10 dias. O sistema mostra a faixa, mas não controla o prazo.
2. Comunicar o acidente é outro formulário (em Análise de Acidentes). **Nada é preenchido a partir da ocorrência**, então os dados são digitados de novo.
3. Com o protocolo CAT-AAAA-NNNN em mãos, volte à ficha da ocorrência.
4. No formulário **Vincular à comunicação de acidente (protocolo CAT)**, digite o protocolo e clique em **Vincular**. Aceita minúsculas. Exige também a permissão de ver acidentes. **Só enquanto a ocorrência estiver aberta**: depois de Concluída ou Cancelada a tela não mostra mais o formulário. O formulário também some depois de vinculada.
5. Mensagem: "OCO-… vinculada à comunicação de acidente." A ficha passa a dizer "Vinculada à comunicação de acidente CAT-…", com link.

Cuidados:
- Protocolo inexistente: "Não há comunicação de acidente com esse protocolo."
- O sistema aceita qualquer CAT existente, **inclusive de outra pessoa**. Confira se o protocolo é do mesmo caso.
- O vínculo não pode ser desfeito pela tela.
- A ficha da CAT não mostra a ocorrência ligada.

## 6. Indicadores

Menu **Indicadores**. Filtros: Campus, De e Até. Não há filtro por tipo, vínculo ou situação.

Mostra: "N ocorrência(s) no recorte (as canceladas não contam); N levada(s) a pronto atendimento." Depois quatro tabelas: Por tipo, Por campus, Por vínculo da pessoa e Por mês.

Como ler:
- **"Por tipo" soma mais que o total.** Cada tipo marcado conta, então uma ocorrência com Queda e Corte entra nas duas linhas. Isso é normal.
- Não há gráfico, nem tabela por situação, nem tempo até assumir ou concluir, nem "durante o trabalho".
- Só números, sem nomes.

## 7. Planilha (CSV)

Na Fila, botão **Exportar planilha (CSV)**. Aparece só para quem tem permissão de exportar (a secretaria não tem).

- Respeita os filtros que estiverem aplicados.
- Arquivo `ocorrencias-AAAA-MM-DD.csv`, separador ponto e vírgula, abre no Excel.
- Colunas: Protocolo, Data e hora, Campus, Local, Tipos, Vínculo da pessoa, Durante o trabalho/estudo, Encaminhada a pronto atendimento, Meio de deslocamento, Situação.
- Não traz nome nem relato.
- Mesmo assim, o arquivo baixado sai do sistema. Guarde-o com cuidado e apague quando não precisar mais.

## 8. Acessos e privacidade

- **Quem vê o quê.** Lista, indicadores e planilha não têm nome nem relato. A ficha tem, e só a equipe e quem registrou a veem.
- **Quem registra** (fora da equipe) vê só as suas ocorrências. Uma ocorrência alheia aparece como "A ocorrência não existe ou não é sua." Quem registrou **não** vê o acompanhamento da equipe nem o telefone e o e-mail.
- **Conceder ou retirar acesso:** em **Usuários**, por quem pode conceder perfil, informando o ato normativo. Quem tentar abrir o módulo sem perfil verá "403 — acesso negado".
- Dê perfil de equipe só a quem precisa ver nome e relato de saúde.
- **Texto digitado** não pode ter CPF nem CID. A trava é parcial: "CID-10 G40" é recusado, mas "J45.0" passa. Oriente a equipe a não escrever diagnóstico.
- O formulário de registro guarda um rascunho no navegador até fechar a aba. Em computador compartilhado, oriente a fechar a aba após registrar.

## 9. Auditoria e prazo de guarda

- Em **Auditoria**, entidade "ocorrencia", ficam os eventos: registrada, assumida, acompanhada, concluída, cancelada, vinculada a acidente e expurgada. As descrições trazem só o protocolo, nunca nome nem relato.
- A leitura da ficha **não** é registrada nessa trilha.
- **Guarda de 5 anos.** Uma ocorrência **encerrada** há mais de 5 anos tem os dados pessoais apagados automaticamente, numa rotina noturna. Somem nome, descrição, observações, conclusão, curso, setor, empresa, função, contato e acompanhamentos. Ficam protocolo, data, campus, local, tipos, vínculo, socorro e situação, para a estatística. A ficha avisa: "Os dados pessoais e o relato desta ocorrência foram apagados em dd/mm/aaaa, pelo prazo de guarda."
- Ocorrência aberta nunca é apagada.
- O campo **Local exato** não é apagado. Oriente a equipe a não colocar nome de pessoa nele.

## 10. E-mails

Por padrão os e-mails estão **desligados**. A TI pode ligá-los. Quando ligados, ao registrar uma ocorrência o sistema avisa a equipe e confirma a quem registrou, só com protocolo e link. Não há e-mail ao assumir, concluir ou cancelar. Pergunte à TI se estão ligados no seu ambiente. Se não estiverem, vale a rotina do capítulo 1.

## 11. Situações (estados)

| Situação | Significa | Próximos passos |
|---|---|---|
| Registrada | Chegou e ninguém assumiu | Assumir, acompanhar, concluir, cancelar |
| Em acompanhamento | A equipe assumiu e está tratando | Acompanhar, concluir, cancelar |
| Concluída | Encerrada com o que foi feito | Nada pela tela (vincule à CAT antes) |
| Cancelada | Registro feito por engano | Nada pela tela (vincule à CAT antes) |

Tentar mudar uma ocorrência encerrada dá: "OCO-AAAA-NNNN já está encerrada e não muda mais."

## 12. Erros e mensagens comuns

| Mensagem | O que fazer |
|---|---|
| "403 — acesso negado" | A pessoa não tem o perfil. Conceda em Usuários, com o ato normativo, se couber. |
| "A ocorrência não existe ou não é sua." | Quem não é da equipe tentou abrir ocorrência alheia. Nada a corrigir. |
| "Página não encontrada." em todo o módulo | O módulo pode estar desligado no ambiente. Acione a TI. |
| "Informe o acompanhamento." / "Informe a conclusão." / "Informe o motivo do cancelamento." | O campo está vazio. Preencha. |
| "OCO-… já foi assumida." | Outra pessoa assumiu antes. Abra a ficha e acompanhe. |
| "OCO-… já está encerrada e não muda mais." | Não há como corrigir. Veja os Limites conhecidos. |
| "Não há comunicação de acidente com esse protocolo." | Confira o protocolo CAT digitado. |
| "O campo … não pode ter CPF nem código de doença (CID)…" | Tire o número e descreva o fato com palavras. A frase da mensagem sai um pouco truncada, mas o sentido é esse. |

## 13. Glossário

- **Protocolo:** número da ocorrência, no formato OCO-2026-0001.
- **Ficha:** a página de uma ocorrência, com nome e relato.
- **Fila:** lista de todas as ocorrências.
- **CAT/SP:** comunicação de acidente em serviço do servidor.
- **CID:** código de doença. Não deve ser escrito nos campos.
- **Expurgo:** apagamento automático dos dados pessoais após o prazo de guarda.
- **Equipe:** perfis com permissão de ver e tratar ocorrências.

## 14. Limites conhecidos

Conheça estes pontos para planejar a rotina e evitar surpresas.

1. **Sem correção.** Não existe reabrir, editar ou desfazer. Erros de conclusão ou de cancelamento não têm saída pela tela. Tratar um erro desses exige a TI.
2. **Sem alerta e sem prazo.** Nada avisa que uma ocorrência está parada em "Registrada". Dependa da rotina do capítulo 1.
3. **Não mostra quem assumiu.** A ficha e a Fila não indicam o responsável, e não há como passar para outro colega. Registre no primeiro acompanhamento quem está cuidando.
4. **Quem registrou não acompanha.** Ele vê só a mudança de situação, não os acompanhamentos nem a conclusão. Dê o retorno por telefone, se for o caso.
5. **Digitação em dobro** na CAT/SP: o link "Comunicar o acidente" abre em branco, e o vínculo é manual.
6. **Sem aviso de duplicidade.** Duas pessoas, ou um clique duplo, geram dois protocolos. Cancele o repetido, com motivo. Um evento com várias vítimas exige um registro por vítima.
7. **Quem registra "comigo"** precisa escolher de novo o vínculo (o padrão é Estudante) e digitar o setor, mesmo tendo cadastro.
8. **Almoxarife e administrador de TI** não conseguem registrar ocorrência.
9. **Leitura da ficha sem registro** de acesso a dado sensível.
10. **Registrar para outra pessoa:** o campo "Nome da pessoa atendida" fica escondido o tempo todo pela regra da tela (conferido no código, não visto em navegador real), o que impede registrar uma ocorrência que não é "comigo": o formulário diz "Informe o nome da pessoa atendida." e não há campo para digitar. Registrar "comigo" funciona. Enquanto não for corrigido, quem atende outra pessoa precisa de alternativa combinada com a equipe. Peça a correção à TI.
11. A busca global e o modo celular não encontram o protocolo OCO nem têm atalho para a equipe. Use o menu do módulo.
12. Os indicadores não têm filtros de tipo, vínculo ou situação, e "Por tipo" soma mais que o total.
13. A trava de CID é parcial.
14. Algumas mensagens de validação têm redação truncada.
15. **Vincular à CAT só com a ocorrência aberta:** depois de encerrada, a ficha não tem mais formulário nenhum.
16. **A equipe vê todos os campi:** não há recorte por campus para quem trata, e o filtro De/Até conta pela data do fato.
