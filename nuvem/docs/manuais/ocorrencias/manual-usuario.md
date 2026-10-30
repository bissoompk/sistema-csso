# Manual do Usuário: Ocorrências de Urgência e Emergência

Sistema SISA, UFVJM.

## Para quem é este manual

Para quem registra ou trata ocorrências no dia a dia:

- **Quem registra:** servidor, terceirizado ou estudante (as contas desses perfis já trazem a permissão de registrar, desde que o módulo esteja ligado no ambiente). Registra e acompanha só o que ele mesmo registrou.
- **Equipe:** coordenador, engenheiro, técnico, médico, secretaria e superintendente. Vê todas as ocorrências, assume, acompanha, conclui, cancela e vincula à comunicação de acidente.

Este manual não trata de configuração nem de decisões de gestão.

## Antes de começar

**O que o módulo é.** Um registro de desmaio, queda, corte, crise convulsiva, acidente e situações parecidas com **qualquer pessoa da universidade**: servidor, estudante, terceirizado ou visitante. Guarda o socorro prestado e o acompanhamento da equipe.

**O que o módulo não é.** Não substitui a CAT/SP (comunicação de acidente em serviço do servidor). Ela continua no módulo de acidentes, e a ocorrência pode ser **vinculada** a ela (capítulo 6).

**Em risco de vida, ligue antes.** SAMU: 192. Corpo de Bombeiros: 193. O registro pode ser feito depois, com calma.

**Quem tem acesso.**

| Perfil | O que consegue fazer |
|---|---|
| Coordenador, engenheiro, técnico, médico, superintendente | Tudo: registrar, ver todas, tratar, indicadores, planilha |
| Secretaria | Igual aos anteriores, **exceto** baixar a planilha (CSV) |
| Servidor | Registrar e ver só as próprias ocorrências |
| Almoxarife e administrador de TI | Sem acesso ao módulo, nem para registrar |

Se aparecer "403 — acesso negado", seu perfil não tem essa permissão. Perfil e permissão são concedidos em "Usuários", por quem tem esse poder. Peça à coordenação. Não há o que fazer pela tela.

**Protocolo.** Cada ocorrência recebe um número no formato `OCO-AAAA-NNNN` (exemplo fictício: OCO-2026-0001). A numeração é sequencial por ano, e o número de uma ocorrência cancelada não volta.

**Onde fica no menu.**

- Quem registra: grupo lateral **Ocorrências**, com **Registrar ocorrência** e **Minhas ocorrências**.
- Equipe: módulo **Ocorrências de Urgência e Emergência** (em "Módulos" ou na tela inicial), com **Painel**, **Registrar ocorrência**, **Fila de ocorrências** e **Indicadores**. O atalho **Minhas ocorrências** está em um cartão do Painel.

## Sumário

1. Registrar uma ocorrência
2. Acompanhar o que eu registrei
3. Painel da equipe
4. Fila de ocorrências
5. Tratar uma ocorrência (equipe)
6. Ocorrência de servidor que vira CAT/SP
7. Planilha (CSV) e Indicadores
8. Situações e o que cada uma significa
9. Erros e mensagens comuns
10. Glossário
11. Limites conhecidos

---

## 1. Registrar uma ocorrência

Quem pode: todos com acesso ao módulo (veja a tabela acima).

1. No menu, clique em **Registrar ocorrência**.
2. O formulário tem quatro seções abertas. Os campos com `*` são obrigatórios. Preencha na ordem.

**Seção "1. Onde e quando"**

- **Data e hora \*:** quando aconteceu (horário de Brasília). Não pode ser futura nem de mais de um ano atrás.
- **Campus \*:** Campus Avançado de Janaúba, Campus Avançado de Unaí, Campus do Mucuri ou Campus JK / Diamantina.
- **Local exato \*:** prédio, sala, laboratório, pátio etc. (até 200 caracteres).

**Seção "2. O que aconteceu"**

- **Tipo de ocorrência \* (marque um ou mais):** Acidente com material perfurocortante; Corte; Desmaio; Parada cardiorrespiratória; Queda; Acidente com veículo; Crise convulsiva; Fratura; Picada de animal peçonhento; Queimadura; Mal-estar súbito; Outra ocorrência.
- **Qual outra ocorrência?:** aparece só se marcar "Outra ocorrência". Nesse caso é obrigatório.
- **Descrição do que aconteceu \*:** descreva os fatos e o socorro prestado (até 4000 caracteres). **Não escreva CPF nem código de doença (CID).**
- **Observações (opcional).**
- **Aconteceu durante o horário de trabalho ou de estudo?:** Sim, Não ou Não sei.

**Seção "3. Quem foi atendido"**

- Caixa **"A ocorrência aconteceu comigo"**. Se marcada, o nome da pessoa passa a ser o seu.
- **Nome da pessoa atendida \*:** para quando a ocorrência foi com outra pessoa. **Atenção:** pela leitura do código da tela, este campo fica escondido o tempo todo, esteja a caixa "comigo" marcada ou não, e o sistema continua exigindo o nome. Se ele não aparecer para você, não é engano seu: veja o capítulo 11. (Pelo envio direto do formulário, sem a tela, o registro para outra pessoa funciona; o defeito está só na exibição do campo.)
- **Vínculo com a UFVJM \*:** Estudante (já vem marcado), Servidor, Terceirizado ou Outro. **Confira sempre**, porque o sistema não usa o seu cadastro para preencher.
- Conforme o vínculo, aparecem campos extras:
  - Outro: "Quem é a pessoa?" (visitante, acompanhante, participante de evento etc.).
  - Estudante: "Nível de ensino" (Graduação, Pós-graduação, Não sei) e "Curso".
  - Servidor: "Setor de lotação" e "É um acidente em serviço?" (Sim, Não, Não sei).
  - Terceirizado: "Empresa" e "Função".
- O sistema guarda **só** os campos do vínculo escolhido. Se trocar de vínculo, o que digitou nos outros é descartado.

**Seção "4. O socorro prestado e o seu contato"**

- **A pessoa foi levada a um pronto atendimento?:** Não (já vem marcado) ou Sim.
- Se Sim: **O deslocamento foi feito por \*:** Corpo de Bombeiros, SAMU, Veículo da UFVJM, Veículo particular ou Outro. Com "Outro", preencha também "Qual?".
- **Telefone para a equipe falar com você (opcional):** se ficar vazio, o sistema usa o telefone do seu cadastro, se houver. Seu nome e e-mail vêm da sua conta.

3. Clique em **Registrar ocorrência**. Para desistir, clique em **Cancelar** (volta ao painel).

**O que acontece depois**

- Aparece a mensagem verde "Ocorrência OCO-2026-000N registrada. A equipe foi avisada pela fila e vai acompanhar." (O número aqui é só exemplo.)
- A equipe é levada à ficha da ocorrência. Quem não é da equipe vai para **Minhas ocorrências**.
- A situação inicial é **Registrada**.
- Anote o protocolo: é ele que identifica a ocorrência.

**Dicas e cuidados**

- Se o formulário der erro, ele volta com tudo o que você digitou, com uma faixa vermelha no topo explicando o problema.
- O formulário guarda um rascunho no navegador enquanto a aba está aberta. Ele some ao fechar a aba e é apagado quando o envio dá certo. Em computador compartilhado, registre e feche a aba.
- **Clique uma vez só.** O sistema não avisa de duplicidade: dois cliques, ou duas testemunhas registrando o mesmo fato, geram dois protocolos.
- **Várias vítimas no mesmo evento:** registre uma ocorrência por pessoa. O formulário tem um único campo de nome.
- **Privacidade:** o nome e o relato aparecem só na ficha. Nunca aparecem na lista nem na planilha.

## 2. Acompanhar o que eu registrei

1. No menu, clique em **Minhas ocorrências**.
2. A tabela mostra: **Protocolo** (é um link), **Data e hora**, **Tipos** e **Situação**.
3. Clique no protocolo para abrir a ficha.
4. Para registrar outra, use o botão **Registrar ocorrência** no alto da tela.

Quem não é da equipe também tem um **Painel pessoal** (o botão **Cancelar** do formulário leva a ele), com os cartões "Registrar ocorrência" e "Minhas ocorrências" (com a contagem das suas).

Se a lista estiver vazia, aparece "Nenhuma ocorrência sua. Quando registrar uma, ela aparece aqui." Para a equipe, esta lista mostra só as ocorrências que a própria pessoa registrou. Para ver todas, use a **Fila de ocorrências**.

**O que a ficha mostra a quem registrou**

- O protocolo, a situação e a data e hora do registro.
- Os cartões "O que aconteceu", "Quem foi atendido" e "Socorro e contato" (neste, "Quem registrou", com "(a própria pessoa)" quando foi registrada "comigo"). Telefone e e-mail de quem registrou **não** aparecem para você, só para a equipe.
- Se a ocorrência foi vinculada a uma CAT: "Vinculada à comunicação de acidente CAT-AAAA-NNNN", com link.

**O que a ficha não mostra a quem registrou**

- O acompanhamento feito pela equipe e o texto da conclusão. Você só enxerga a **mudança de situação**. Para saber o que foi feito, fale com a equipe.

Se a ocorrência for de servidor marcada como "acidente em serviço: Sim" e ainda não houver CAT, aparece a faixa "Foi marcada como acidente em serviço de servidor: a comunicação da CAT/SP tem prazo de 10 dias." Veja o capítulo 6.

## 3. Painel da equipe

Caminho: **Painel** (título "Ocorrências de urgência e emergência"). Mostra só números, nunca nomes. Cartões:

- **Registrar ocorrência**
- **Minhas ocorrências** (as que eu registrei)
- **A assumir:** quantas aguardam a equipe. Abre a fila já filtrada por "Registrada".
- **Em acompanhamento:** quantas estão em andamento.
- **Todas:** o total.
- **Indicadores:** só aparece para quem tem essa permissão.

O painel não mostra prazo, tempo de espera nem destaque de atraso. **O sistema não avisa quando uma ocorrência fica parada em "Registrada".** Abra o painel no começo de cada turno e olhe o cartão "A assumir".

## 4. Fila de ocorrências

Caminho: **Fila de ocorrências**. Lista todas as ocorrências, mostrando só protocolo e fatos. O nome da pessoa e o relato ficam na ficha.

**Colunas:** Protocolo, Data e hora, Campus, Tipos, Vínculo e Situação.

**Filtros** (depois de escolher, clique em **Filtrar**): Situação (Todas, Registrada, Em acompanhamento, Concluída, Cancelada), Campus, Tipo, Vínculo, De e Até (datas, dia inteiro, contadas pela **data do fato**, não pela do registro).

Pontos de atenção:

- A equipe vê as ocorrências de **todos os campi**: não há recorte por campus para quem trata. Use o filtro Campus.
- A ordem é fixa: a **mais recente primeiro pela data do fato**, não pela chegada nem pela urgência. Para achar as paradas há mais tempo, filtre por "Registrada" e leia as datas.
- Se escolher um valor inválido no filtro, o sistema o ignora sem avisar e mostra tudo.
- A lista mostra no máximo 500 ocorrências. Use os filtros.
- Não há coluna "quem assumiu".
- Sem resultado: "Nenhuma ocorrência neste recorte".
- Botões no alto: **Registrar ocorrência** e **Exportar planilha (CSV)** (este só para quem tem permissão de exportar).

Para abrir uma ocorrência, clique no protocolo.

## 5. Tratar uma ocorrência (equipe)

Quem pode: equipe com permissão de tratar. Na ficha, os formulários aparecem **só enquanto a ocorrência não estiver encerrada**.

A ficha da equipe mostra, além do que o registrante vê: o cartão **Acompanhamento da equipe**, com cada acompanhamento (data, hora e autor), o telefone e o e-mail de quem registrou e, ao final, a "Conclusão:" ou o "Cancelamento:". **A ficha não mostra quem assumiu a ocorrência.** Combine isso com a equipe por fora do sistema.

### 5.1 Assumir

1. Abra a ficha de uma ocorrência **Registrada**.
2. Se precisar, ligue para quem registrou (telefone na ficha).
3. Clique em **Assumir a ocorrência**.
4. Aparece "OCO-… assumida: a ocorrência está em acompanhamento." A situação passa a **Em acompanhamento**.

Se outra pessoa já assumiu, a tela avisa: "OCO-2026-0001 já foi assumida." Qualquer integrante da equipe pode concluir ou cancelar uma ocorrência assumida por colega. Não há como passar a ocorrência de uma pessoa para outra.

### 5.2 Registrar acompanhamento

1. No formulário **Registrar acompanhamento**, escreva o que foi feito ou combinado (até 4000 caracteres). Não use CPF nem CID.
2. Clique em **Registrar**. Aparece "Acompanhamento registrado."

Se a ocorrência ainda estava **Registrada**, o primeiro acompanhamento a assume automaticamente em nome de quem escreveu. **O acompanhamento não pode ser editado nem apagado.** Releia antes de enviar.

### 5.3 Vincular à comunicação de acidente (CAT)

Necessário só quando a ocorrência de um servidor gerou uma CAT/SP. Exige também a permissão de ver acidentes. Veja o capítulo 6.

1. No formulário **Vincular à comunicação de acidente (protocolo CAT)**, digite o protocolo, por exemplo `CAT-2026-0001`. Pode ser em minúsculas.
2. Clique em **Vincular**.
3. Aparece "OCO-… vinculada à comunicação de acidente." O formulário some, e a ficha passa a dizer "Vinculada à comunicação de acidente CAT-…", com link.

**Faça o vínculo antes de concluir ou cancelar.** Na tela, o formulário de vincular desaparece quando a ocorrência fica Concluída ou Cancelada (como todos os outros formulários da ficha), então depois disso não há onde digitar o protocolo. O formulário também some depois de vinculada. **Confira o protocolo antes de clicar:** o sistema aceita qualquer CAT que exista, inclusive de outra pessoa, e o vínculo **não pode ser desfeito pela tela**.

### 5.4 Concluir

1. No formulário **Concluir: o que foi feito**, descreva o desfecho.
2. Clique em **Concluir**. Aparece "OCO-… concluída." A situação passa a **Concluída**.

O campo é obrigatório. Se vier vazio: "Informe a conclusão."

### 5.5 Cancelar

Use **só para registro feito por engano** (por exemplo, duplicado).

1. No formulário **Cancelar (registro feito por engano): motivo**, escreva o motivo (até 400 caracteres).
2. Clique em **Cancelar a ocorrência**. Aparece "OCO-… cancelada."

Se vier vazio: "Informe o motivo do cancelamento."

**Atenção: Concluída e Cancelada são finais.** Não existe reabrir, editar ou desfazer. Se errar, não há correção pela tela. Procure a coordenação e registre uma nova ocorrência se necessário. Qualquer tentativa de assumir, acompanhar, concluir ou cancelar depois disso mostra: "OCO-AAAA-NNNN já está encerrada e não muda mais."

## 6. Ocorrência de servidor que vira CAT/SP

1. Quem registra escolhe o vínculo **Servidor** e responde **"É um acidente em serviço?"** com **Sim**.
2. A ficha (para quem registrou e para a equipe) mostra a faixa avisando o prazo de **10 dias** para a CAT/SP, com o link **Comunicar o acidente** (só para quem tem permissão de comunicar acidentes). A faixa some depois que a ocorrência é vinculada a uma CAT. Quem registrou também encontra **Comunicar acidente** no grupo lateral **Acidentes**.
3. O link abre o formulário de comunicação de acidente **em branco**. **Os dados da ocorrência não são copiados**: é preciso digitá-los de novo.
4. Com o protocolo `CAT-AAAA-NNNN` em mãos, a equipe volta à ocorrência e usa **Vincular à comunicação de acidente (protocolo CAT)** (item 5.3), **enquanto ela ainda estiver aberta**. Quem registrou não vê esse formulário. Avise a equipe do protocolo.
5. A ficha da CAT não mostra a ocorrência ligada. O vínculo aparece só na ficha da ocorrência.

## 7. Planilha (CSV) e Indicadores

Quem pode: equipe. A planilha exige a permissão de exportar (a secretaria não tem). Os Indicadores exigem a permissão de indicadores.

### 7.1 Exportar planilha (CSV)

1. Em **Fila de ocorrências**, aplique os filtros desejados e clique em **Filtrar**.
2. Clique em **Exportar planilha (CSV)**. A planilha respeita os filtros atuais.
3. O arquivo se chama `ocorrencias-AAAA-MM-DD.csv`, separado por ponto e vírgula, e abre no Excel.

Colunas: Protocolo; Data e hora; Campus; Local; Tipos (separados por " | "); Vínculo da pessoa; Durante o trabalho/estudo; Encaminhada a pronto atendimento; Meio de deslocamento; Situação. **Não há nome da pessoa nem relato.**

### 7.2 Indicadores

1. Clique em **Indicadores**.
2. Se quiser, escolha **Campus**, **De** e **Até**, e filtre. Não há filtro por tipo, vínculo ou situação.
3. A tela mostra "N ocorrência(s) no recorte (as canceladas não contam)" e quantas foram levadas a pronto atendimento. Depois, quatro tabelas: **Por tipo**, **Por campus**, **Por vínculo da pessoa** e **Por mês**.

**Cuidado ao ler "Por tipo":** a ocorrência conta uma vez em cada tipo marcado. Uma queda com corte entra em "Queda" e em "Corte". Por isso a soma dessa tabela pode ser **maior** que o total de ocorrências. É normal.

Não há gráfico, nem tempo até assumir ou concluir.

## 8. Situações e o que cada uma significa

| Situação | Significado | O que vem depois |
|---|---|---|
| **Registrada** | Chegou e aguarda a equipe. | Assumir ou registrar o primeiro acompanhamento; concluir; cancelar |
| **Em acompanhamento** | A equipe assumiu e está cuidando. | Mais acompanhamentos; concluir; cancelar |
| **Concluída** | Encerrada, com a conclusão registrada. Final. | Nada pela tela (vincule à CAT antes de concluir) |
| **Cancelada** | Registro feito por engano. Final. | Nada pela tela (vincule à CAT antes de cancelar) |

**Guarda dos dados.** Uma ocorrência encerrada há mais de 5 anos tem os dados pessoais apagados automaticamente: nome, descrição, observações, conclusão, curso, setor, empresa, função, contato e acompanhamentos. Ficam protocolo, data, campus, local, tipos, vínculo, socorro e situação, só para estatística. A ficha avisa: "Os dados pessoais e o relato desta ocorrência foram apagados em dd/mm/aaaa, pelo prazo de guarda. Ficam só os dados para a estatística." Ocorrência aberta nunca é apagada.

**Avisos por e-mail.** Normalmente estão desligados. Se estiverem ligados, a equipe recebe aviso de nova ocorrência e quem registrou recebe uma confirmação, só com protocolo e link, nunca com nome ou relato. Não há e-mail ao assumir, concluir ou cancelar. Não conte com e-mail: consulte o Painel.

## 9. Erros e mensagens comuns

| Mensagem | O que fazer |
|---|---|
| "Informe a data e a hora em que aconteceu." | Preencha "Data e hora". |
| "A data e a hora não podem ser futuras." | Corrija para o momento real do fato. |
| "A ocorrência é de mais de um ano atrás: procure a CSSO." | Fato antigo demais para este formulário. Procure a CSSO. |
| "Escolha o campus onde aconteceu." | Selecione o campus. |
| "Informe o local exato." | Preencha o local. |
| "Marque ao menos um tipo de ocorrência." | Marque pelo menos um tipo. |
| "Descreva a «outra ocorrência» marcada." | Preencha "Qual outra ocorrência?". |
| "Informe a descrição do que aconteceu." | Preencha a descrição. |
| "Informe o nome da pessoa atendida." | Preencha o nome. Se o campo não aparecer, veja o capítulo 11. |
| "Escolha o meio de deslocamento." | Se marcou pronto atendimento "Sim", escolha o meio. |
| "Informe o meio de deslocamento «outro»." | Preencha "Qual?". |
| "A descrição do que aconteceu passa de 4000 caracteres." | Resuma o texto. |
| "O campo … não pode ter CPF nem código de doença (CID): descreva o que aconteceu, sem identificar por número." | Apague números de CPF e códigos como "CID-10 G40". A frase vale para descrição, observações, local, acompanhamento e conclusão. |
| "OCO-… já foi assumida." | Alguém da equipe já assumiu. Abra a ficha e siga com acompanhamento. |
| "OCO-… já está encerrada e não muda mais." | A ocorrência é final. Não há reabertura. |
| "Informe o acompanhamento." / "Informe a conclusão." / "Informe o motivo do cancelamento." | Preencha o campo antes de enviar. |
| "Não há comunicação de acidente com esse protocolo." | Confira o número da CAT. |
| "A ocorrência não existe ou não é sua." | Você abriu uma ocorrência que não registrou. Use **Minhas ocorrências**. |
| "403 — acesso negado" | Seu perfil não tem a permissão. Fale com a coordenação. |
| "Página não encontrada." | O módulo pode não estar ligado neste ambiente. Avise a coordenação. |

Se a tela pedir login, entre no sistema e tente de novo.

## 10. Glossário

- **Ocorrência:** registro de um evento de urgência, emergência ou acidente.
- **Protocolo:** número `OCO-AAAA-NNNN` que identifica a ocorrência.
- **Ficha:** a tela de uma ocorrência, com todos os detalhes. Só aqui aparecem nome e relato.
- **Fila:** lista de todas as ocorrências, sem dados pessoais.
- **Assumir:** a equipe toma a ocorrência para si.
- **CAT/SP:** comunicação de acidente em serviço do servidor. Tem protocolo `CAT-AAAA-NNNN`.
- **Vincular:** ligar a ocorrência ao protocolo da CAT.
- **CID:** código de doença. Não pode ser escrito nos textos.
- **CSV:** planilha simples que abre no Excel.
- **Expurgo:** apagamento automático dos dados pessoais após 5 anos do encerramento.

## 11. Limites conhecidos

Pontos que afetam o uso. Saiba deles antes de começar.

- **Campo "Nome da pessoa atendida" não aparece.** Quando a caixa "A ocorrência aconteceu comigo" está desmarcada, o campo deveria aparecer, mas a regra da tela o esconde nos dois casos (marcada ou desmarcada). Confirmado pela leitura do código; não foi visto em navegador real, porque o ambiente de teste não abre o Chrome. Resultado esperado: ao registrar para outra pessoa, o envio recusa com "Informe o nome da pessoa atendida." sem campo para digitar. Registrar **comigo** (a própria pessoa) funciona normalmente. Para outra pessoa, avise a coordenação e procure a equipe por outro meio até a correção.
- **Vincular à CAT só antes de encerrar.** Depois de Concluída ou Cancelada, a tela não oferece mais o formulário de vínculo.
- **Número de ocorrência absurdo na barra de endereço** (por exemplo, com mais de 18 dígitos) devolve erro 422 em vez de "não existe". Só acontece digitando o endereço à mão.
- **Não há como corrigir.** Concluída e Cancelada são finais. Não dá para editar, reabrir ou apagar acompanhamentos. Revise antes de enviar.
- **Quem registra não vê o acompanhamento nem a conclusão**, só a mudança de situação.
- **Sem alerta de ocorrência parada.** Não há prazo, aviso nem destaque de atraso. A equipe precisa abrir o Painel ou a Fila.
- **A ficha não mostra quem assumiu**, e não há reatribuição.
- **Dado digitado duas vezes.** O link "Comunicar o acidente" abre em branco, e o vínculo à CAT é manual.
- **Sem acesso para almoxarife e administrador de TI**, nem para registrar. Eles devem pedir a outra pessoa para registrar, ou solicitar o perfil adequado à coordenação.
- **Quem registra "comigo" precisa escolher o vínculo e digitar o setor de novo**, mesmo tendo cadastro. O vínculo já vem como "Estudante": troque se for outro.
- **Sem aviso de duplicidade e sem várias vítimas num só registro.**
- **A trava de CID é parcial.** "CID-10 G40" é recusado, mas "J45.0" e "CID J45" passam. Não escreva código de doença de nenhuma forma.
- **As mensagens de erro da trava de CPF/CID** têm redação truncada, como "O campo a descrição…". A orientação continua valendo.
- **"Por tipo" nos Indicadores soma mais que o total** (capítulo 7.2).
- **Busca global e modo celular.** A busca global não encontra protocolo `OCO`, e o modo celular não tem atalho para a equipe. Use o menu do módulo.
- **O rascunho do formulário fica no navegador** até fechar a aba. Evite usar computador de uso comum.
- **Sem anexos, fotos nem PDF** neste módulo.
- O campo "Local exato" não é apagado na guarda de 5 anos.
