# Manual do Coordenador: Treinamentos, turmas e inscrições

Sistema SISA (UFVJM), módulo **Certificados e Treinamentos**, parte de turmas e inscrições.

## Para quem é este manual

Para quem responde pelo módulo de turmas: a coordenação da CSSO, a superintendência e quem faz o papel de coordenador em um setor promotor. Aqui você encontra o que cabe a você decidir, configurar e conferir. O passo a passo de quem opera o dia a dia (abrir turma, inscrever, lançar presença) está no manual do usuário. Este manual repete esses passos só quando você precisa conhecer a regra para decidir ou corrigir.

Todos os exemplos usam nomes e códigos fictícios.

## Antes de começar

**Acesso.** Entre no sistema e abra, na lateral, o módulo **Certificados e Treinamentos**. Os itens que você vai usar:

| Menu | O que é |
|---|---|
| Início | Painel do módulo |
| Turmas (grupo "Turmas e inscrições") | Lista e ficha de cada turma |
| Pedidos pelo link | Pedidos de vaga feitos pelo link público, à espera de conferência |
| Treinamentos (grupo "Cadastros") | Catálogo de treinamentos |
| Instrutores | Quem ministra e assina o certificado |
| Setores promotores | Setores que aparecem em "Unidade promotora" |
| Locais | Salas e locais de treinamento |
| Meus treinamentos | A sua própria área, como participante |
| Avaliação de reação | Resultado consolidado das avaliações dos participantes |

**Quem pode o quê no módulo.**

- **Coordenador e superintendente:** fazem tudo no módulo.
- **Engenheiro e médico do trabalho:** fazem tudo, inclusive anular certificado.
- **Técnico de segurança:** faz tudo, menos anular certificado. Inclui cadastrar local, incluir e retirar setor promotor e abrir "Modelos" (tem a permissão de gerenciar o catálogo), mas o catálogo e as turmas seguem a regra do dono.
- **Secretaria da CSSO:** abre Início, Turmas, Pedidos pelo link, Catálogo (só leitura), Locais (só leitura), Setores e Avaliação de reação. Cria turma, inscreve, lança presença, conclui e emite. Não abre Instrutores nem Modelos (403), não cadastra local e não anula certificado.
- **Servidor:** usa "Meus treinamentos", vê a ficha da turma só para leitura, inscreve-se (também pelo botão "Inscrever-se" da ficha), desiste e avalia. Abre "Setores promotores" só para ler e não abre Início (403).
- **Almoxarife e administrador de TI:** não têm acesso a nada deste módulo (403 em todas as telas, inclusive "Meus treinamentos").

**Início do módulo.** A tela "Início" (**/treinamentos**) tem dez cartões na ordem do trabalho (com os mesmos nomes e ícones da lateral, conforme o perfil: Treinamentos, Modelos, Instrutores, Turmas, Pedidos pelo link, Presença e notas, Fila de emissão, Emitidos, Envios por e-mail, Reciclagem, Possíveis duplicados (só aparece quando há o que conferir), Indicadores, Setores promotores e Locais), muitos deles com a contagem do que espera, mais as listas "Turmas encerrando" e "Próximas turmas". Use-a como ponto de partida da rotina (capítulo 13). "Turmas encerrando" inclui turmas planejadas que vão acabar logo, marcadas "nada pendente: só concluir no término": isso não é alarme de problema.
- **Terceirizado e discente:** podem ver treinamentos e se inscrever. Este manual não cobre a tela deles, porque não foi possível testá-los.

**Concessão de acesso.** O acesso é dado pelo perfil da conta. Se alguém precisa abrir uma tela e recebe "403 — acesso negado", o perfil dela não tem a permissão. As permissões do módulo, pelos nomes que o sistema usa:

- "Ver treinamentos, turmas e certificados"
- "Gerenciar catálogo de treinamento e modelo de certificado"
- "Cadastrar assinatura de instrutor"
- "Criar e editar turma"
- "Inscrever e confirmar participante"
- "Concluir ou cancelar turma"
- "Lançar presença e nota"
- "Inscrever-se em turma aberta (só a si mesmo)"

Emitir, anular e ver certificado são permissões à parte, tratadas no manual de Certificados.

**A regra do dono.** Ter a permissão não basta para alterar uma turma ou um treinamento do catálogo. Quem pode alterar:

1. O **dono**, que é quem criou (aparece em "Responsável (dono)" na ficha).
2. O **superintendente**, em tudo.
3. A **coordenação do mesmo setor promotor**, quando o dono é de perfil abaixo dela. Entre coordenadores, só o dono altera.
4. O **ajudante** que o dono designou, só nos papéis dados.
5. Os demais só consultam. A ficha mostra "Só consulta. Esta turma é de {nome}; só ele ou a coordenação acima pode alterar.", os botões somem, e quem tentar alterar recebe 403. Isso vale também para a secretaria diante de turma de técnico, engenheiro ou médico.

As turmas e os treinamentos de exemplo que vêm com o sistema não têm dono, ou pertencem à coordenadora. O técnico só consulta esses. Se um técnico precisa mexer em um treinamento do catálogo, peça ao dono ou à coordenação.

## Sumário

1. Visão geral e situações da turma
2. Catálogo de treinamentos
3. Instrutores e qualificações
4. Locais
5. Setores promotores
6. Acompanhar e decidir sobre turmas (abertura, edição, ajudantes)
7. Inscrições e pedidos pelo link
8. Link público, QR e vitrine pública
9. Presença, notas, conclusão e correções
10. Cancelar e excluir turma
11. Avaliação de reação
12. Privacidade e auditoria
13. Rotina de acompanhamento (diária, semanal, mensal)
14. Como conferir que o módulo está saudável
15. Erros e mensagens comuns
16. Glossário
17. Limites conhecidos

---

## 1. Visão geral e situações da turma

Uma **turma** é uma oferta de um treinamento: quando, onde, com quem e para quantos. O código tem o formato TUR-AAAA-NNNN (por exemplo, TUR-2026-0006), a sequência é por ano do **início** e o código nunca volta nem muda. Uma turma planejada em dezembro para janeiro consome o número do ano seguinte.

**Situações da turma:**

| Situação | O que significa | Para onde pode ir |
|---|---|---|
| Planejada | Turma criada. A equipe inscreve; o link só funciona depois de aberta. | Inscrições abertas, Em andamento, Concluída (só se o término já passou), Cancelada |
| Inscrições abertas | Recebe pedidos de vaga, inclusive pelo link e pela vitrine. | Planejada (é a forma de fechar inscrições sem cancelar), Em andamento, Cancelada |
| Em andamento | A turma começou. Aceita ainda inscrição pela equipe (retardatário). | Concluída, Cancelada. **Não volta** |
| Concluída | Foi apurada. Final. | Nenhuma. Corrige-se por "Corrigir dados da turma" |
| Cancelada | Final. Leva junto as inscrições vivas (capítulo 10.1). | Nenhuma |

**Situações da inscrição:**

| Situação | Significado | Ocupa vaga? |
|---|---|---|
| Pedido pelo link, a conferir | Pedido que a equipe ainda não aceitou | Não |
| Inscrita / Confirmada | Vaga garantida | Sim |
| Presente / Ausente | Presença lançada | Sim |
| Aprovado / Reprovado | Resultado após a conclusão | Sim |
| Cancelada | Desistência ou cancelamento. Quem responde pela turma pode **reativar** (capítulo 7.2) | Não |

A inscrição feita pela equipe, pelo próprio participante logado ou pelo aceite de um pedido nasce **Confirmada**.

---

## 2. Catálogo de treinamentos

Caminho: **Treinamentos** (grupo "Cadastros"). Colunas: Código, Código curto, Nome, Carga, Reciclagem, Certificado, Situação, Ações.

### 2.1 Cadastrar um treinamento

1. Abra **Treinamentos** e clique em **"Cadastrar treinamento"**.
2. Preencha:
   - "Nome (sai no certificado)".
   - "Carga horária (horas)".
   - "Validade da reciclagem (meses)". Vazio ou 0 significa que não vence.
   - "Código (opcional)". Em branco, sai do nome. Não muda depois.
   - "Código curto (entra no número do certificado)". De 2 a 10 letras ou algarismos, sem traço, único. Se ficar em branco, o sistema sugere um a partir do nome.
   - "Norma de referência", "exigido por norma" e "Conteúdo programático (um tópico por linha)".
3. Salve. Mensagem esperada: "Treinamento “Brigada de Incêndio” cadastrado (código BRIGADA_DE_INCENDIO)."

Ao editar, aparecem também "Modelo do certificado", "Instrutor padrão" e "ativo".

**Por que o código curto importa:** ele entra no número impresso do certificado (CSSO-NR35-2026-0001). Escolha com cuidado, porque cada treinamento tem o seu.

### 2.2 Tirar um treinamento de uso

- Um treinamento que já tem turma **não pode ser excluído**. Desmarque "ativo": ele sai das listas de escolha, e as turmas existentes continuam.
- Treinamento inativo não abre turma. Mensagem: "'Brigada de Incêndio' está inativo no catálogo — reative-o antes de abrir turma."

### 2.3 Cuidados do coordenador

- Confira a carga horária do catálogo. Ela é a carga que uma turma herda quando o campo fica em branco (ver capítulo 6).
- Antes de salvar uma edição, olhe se "Modelo do certificado", "Norma" e "ativo" continuam como você quer. Use sempre a tela do sistema para editar, não tente alterar por outros meios.
- Mensagens comuns: "Informe o nome do treinamento." / "Carga horária inválida: informe um número maior que zero." / "Validade inválida: informe meses inteiros, ou 0 para não expira." / "Já existe treinamento com esse código ou nome (...)." / "O código curto NR35 já é do treinamento “...”: ... Escolha outro."

---

## 3. Instrutores e qualificações

Caminho: **Instrutores** (grupo "Cadastros"). Exige a permissão de cadastrar assinatura de instrutor. A secretaria não abre esta tela.

### 3.1 Cadastrar instrutor

1. Clique em **"Cadastrar instrutor"**.
2. Para instrutor da UFVJM, escolha em "Instrutor da UFVJM" (lista de servidores). Para externo, marque "instrutor externo" e preencha "Nome (só para externo)".
3. Preencha "Título de assinatura", "Conselho", "Registro" e "Organização".
4. "CPF (só se o certificado exigir)": a tela nunca mostra o número depois de gravado.
5. "Vigência — início" e "Vigência — fim". Vazio no início significa "desde sempre"; vazio no fim, "sem termo".
6. Para a rubrica, use o link **"enviar rubrica"** na linha (imagem PNG ou JPEG; PNG com fundo transparente, de proporção próxima de 3:1, é o ideal, e vale só para os certificados emitidos daí em diante).
7. No instrutor da UFVJM, o nome vem do cadastro de servidores e não se edita aqui; no externo, o nome se corrige no "Editar" da linha.

**Atenção:** o sistema **não impede cadastrar a mesma pessoa duas vezes** e deixa o título em branco. Antes de cadastrar, procure o nome na lista. Se achar duplicados, desmarque "ativa" em um deles (instrutor que já esteve em turma não se exclui). Preencha sempre o título, porque ele sai no certificado.

### 3.2 Vigência e situação

Só um instrutor **ativo** e **vigente no dia do início da turma** pode ser vinculado a ela. Mensagens: "A assinatura de {nome} não vigora em 15/12/2026, quando a turma começa." / "A assinatura de {nome} está inativa — reative-a antes de vinculá-la à turma."

Na edição, se a caixa "ativa" não estiver marcada ao salvar, a assinatura fica inativa.

### 3.3 Qualificações do instrutor

Link **"qualificações"** na linha do instrutor, depois **"Cadastrar qualificação"**. Campos: "Descrição", "Treinamento que habilita", "Norma", "Instituição emissora", "Data de emissão", "Válida até" e "Comprovante (PDF, PNG ou JPEG)" (até 4 MB).

Efeitos que interessam a você:

- Ao vincular o instrutor a uma turma, se não houver qualificação ativa que cubra o treinamento (ou a norma) em todo o período da turma, o sistema mostra "Atenção: {nome} não tem qualificação cadastrada que o habilite para ...". **O aviso não bloqueia.** Decidir se a turma segue é responsabilidade sua.
- Trinta dias antes do vencimento de uma qualificação, nasce uma tarefa em Pendências.
- O comprovante só é baixado por quem gerencia instrutores, e cada download fica na trilha.

---

## 4. Locais

Caminho: **Locais** (grupo "Cadastros"), tela "Locais de treinamento". Cadastrar, editar e inativar exigem a permissão de gerenciar o catálogo (a secretaria só lê).

1. Clique em **"Cadastrar local"**. O nome basta.
2. Campos: "Nome", "Campus", "Capacidade (pessoas)", "Endereço, bloco ou sala", "Observações".
3. Na linha, use "Editar", "inativar" ou "reativar".

Regras:

- A repetição é conferida por nome mais campus. O mesmo nome em outro campus é aceito.
- Editar o nome renomeia as turmas ainda não encerradas que usam o local.
- Local inativado não aparece em turma nova. As turmas que já o têm continuam com ele.
- A turma de um campus só oferece os locais desse campus e os sem campus.
- Sem nenhum local cadastrado, o campo "Local" da turma é texto livre.

**Avisos ao salvar turma (não bloqueiam):** "Atenção: Vagas acima da capacidade: ..." e "Choque de sala: a turma TUR-... também usa “Sala 12” de ... a ...". Quando o aviso aparecer, decida se ajusta vagas, horário ou sala.

---

## 5. Setores promotores

Caminho: **Setores promotores**. Lista os setores que aparecem no campo "Unidade promotora" da turma. O setor define também a sigla do número do certificado (CSSO-NR35-2026-0001).

- **"Incluir setor promotor":** escolha a "Unidade" (de Catálogos > Unidades).
- Incluir e retirar exigem a permissão de gerenciar o catálogo (coordenação, superintendência, engenheiro, médico e técnico); a secretaria e o servidor só leem a lista.
- **"retirar da lista":** o setor não aparece mais em turma novo. As turmas que já o têm continuam, e os certificados emitidos não mudam.
- **"Aparência":** cor e ícone do selo.

**Cuidado ao retirar um setor.** Se você retirar o setor da própria equipe (por exemplo, a CSSO), o técnico deixa de conseguir abrir turma, e o sistema não avisa na hora de retirar. A mensagem que ele recebe diz que o setor "não está entre os setores que promovem treinamentos" e manda pedir a quem gerencia o catálogo para incluí-lo em Setores promotores.

**Qual setor entra na turma:**

- Conta ligada a um só setor: o setor entra sozinho.
- Conta ligada a mais de um: "Escolha o setor promotor da turma: a sua conta está vinculada a mais de um setor."
- Setor de fora das suas vinculações: "Você só pode atribuir a turma a um dos setores promotores a que a sua conta está vinculada."
- Coordenador e superintendente veem todos os setores e podem deixar em branco. Nesse caso o número do certificado usa a sigla padrão do sistema.

---

## 6. Acompanhar e decidir sobre turmas

### 6.1 A lista de turmas

Caminho: **Turmas**. Filtros: Situação, "Filtrar por treinamento", "Filtrar por turno", "Filtrar por setor promotor", botão "Filtrar". Colunas: Treinamento, Período, Local, Inscritos (por exemplo, "3 de 10"), Situação e Ações. Quando há pedidos pelo link à espera, a linha mostra "N a conferir".

### 6.2 Abrir turma (o que você precisa saber para orientar a equipe)

Botão **"Abrir turma"**. Duas formas de começar:

- **Planejada:** a equipe inscreve, e o link pode ser ligado depois.
- **Aberta com link público:** inscrições abertas e link com QR já na tela seguinte. Exige "Inscrições até". A turma tem de começar depois de hoje.

Campos principais: "Treinamento", "Início", "Término", "Carga horária da turma", "Hora de início", "Hora de término", "Local", "Campus", "Unidade promotora", "Vagas", "Inscrições até", "Nota mínima (0 a 10)", "Frequência mínima (%)" (padrão 75), "Aceita comunidade externa", "Data base do vencimento", "Descrição do evento" e "Observações".

Pontos de decisão que costumam gerar dúvida:

- **Carga horária da turma.** Em branco, a turma herda a do catálogo (o campo mostra "usa a do catálogo", mas a ficha, a lista de presença e a vitrine exibem só o número que vale, sem dizer que é herdado). A frequência é calculada sobre essa carga. Oriente a equipe a preencher sempre que a carga for diferente da do catálogo e a conferir o número na ficha.
- **"Aceita comunidade externa".** Marcada, o link público aceita visitantes e outros de fora da UFVJM; desmarcada, só servidores, terceirizados e discentes. É este o controle que vale (ver 8.2).
- **"Unidade promotora".** O formulário só oferece os setores promotores a que a conta de quem abre está vinculada.
- **Nota mínima.** Vazio significa que a turma não avalia por nota. Com nota mínima, quem ficar sem nota sai reprovado (ver capítulo 9).
- **Data base do vencimento.** Em branco, usa o término. Só se preenche quando a norma conta a validade da avaliação prática.
- **"Inscrições até"** não pode passar do início da turma.
- Curso já dado pode ser aberto com datas passadas, e a turma segue direto para concluída.

### 6.3 Editar a turma

Na ficha, botão **"Editar dados da turma"**. O código e o treinamento não mudam depois de aberta. Turma concluída ou cancelada não se edita ("... o que ela diz já foi comunicado a quem participou."). Reduzir vagas abaixo do número de inscritos é recusado.

### 6.4 Mudar a situação

Na ficha da turma, os botões: **"Abrir inscrições"**, **"Fechar inscrições"** (volta a turma para Planejada), **"Iniciar turma"**, **"Concluir turma…"** (só aparece a partir do último dia da turma; antes dele a ficha explica quando ele aparece), **"Cancelar turma"** e **"Excluir turma"**.

**Decisão importante: "Iniciar turma" é irreversível.** O sistema não confere a data: dá para iniciar uma turma que começa daqui a 40 dias, e ela não volta a "Inscrições abertas" nem a "Planejada". O link público fecha. **Só inicie no dia em que a turma começa** (o passo é opcional; a presença pode ser lançada mesmo sem iniciar). Se iniciou por engano, o caminho é concluir ou cancelar a turma.

Para fechar inscrições sem cancelar, use **"Fechar inscrições"**, que volta a turma para **Planejada** (disponível enquanto está em "Inscrições abertas"). O link e a vitrine deixam de aceitar pedidos (o link fica "ligado, mas fora do prazo ou da situação" e a turma publicada mostra "As inscrições ainda não abriram"), mas continuam ligados e publicados: ao reabrir as inscrições, voltam a funcionar com o mesmo endereço. Ver 8.2.

### 6.5 Ajudantes (delegar sem perder o controle)

Na ficha, bloco **"Ajudantes"**, botão **"Designar ajudante"**. Só o dono ou quem está acima dele designa.

1. Escolha a conta em "Conta da equipe do setor".
2. Marque os papéis:
   - **Inscrições:** inscrever, aceitar ou recusar pedidos (também os do link), cancelar inscrição.
   - **Presença e notas:** lançar presença e notas.
   - **Emissão:** emitir, anular, reemitir e enviar os certificados da turma.
3. Clique em **"Designar"**.

Para trocar os papéis, designe de novo a mesma conta. Para retirar, use **"retirar"**: "Ajudante retirado: a conta volta a só consultar a turma."

Ficam só com o dono ou superior: editar a turma, mudar a situação, vincular instrutores, link público, vitrine, excluir, registrar como realizada, corrigir dados e designar ajudantes. Ajudante não designa ninguém.

**Cuidado:** a lista de contas inclui perfis sem acesso ao módulo (como o almoxarife). Quem for designado sem ter acesso continua recebendo 403 em tudo. Escolha coordenador, engenheiro, médico, técnico ou secretaria.

### 6.6 Instrutores na turma

Na aba **Turma**, bloco "Instrutores", botão **"Vincular instrutor"**.

**Armadilha:** a caixa **"assina o certificado"** vem **marcada**, mas quem a desmarca (instrutor que só dá aula) pode esquecer que, sem ninguém marcado para assinar, a emissão trava com a mensagem "... não tem nenhum instrutor marcado para assinar o certificado". Essa marcação **não pode ser alterada depois** (a tabela mostra "assina" ou "não assina"). Para corrigir, remova o instrutor (botão **"tirar"** na linha: "Instrutor desvinculado da turma.") e vincule de novo marcando a caixa. Dá para vincular instrutor até em turma concluída, enquanto nenhum certificado tiver saído.

Depois do primeiro certificado emitido (mesmo que anulado) a turma não muda de instrutor: "Turma encerrada não muda de instrutor." Turma cancelada nunca muda.

---

## 7. Inscrições e pedidos pelo link

### 7.1 O que a equipe faz na aba "Inscrições"

Exige a permissão de inscrever e o papel "Inscrições" (se for ajudante). O cabeçalho mostra "N vaga(s) livre(s) de M". A turma aceita inscrição pela equipe em Planejada, Inscrições abertas e Em andamento. Concluída ou cancelada, não.

Formas de inscrever:

- **Um por um:** "Procurar por" (nome, SIAPE, e-mail ou PTC-...) e "inscrever". Se a pessoa não existir, use "Cadastrar participante externo" (Nome, Vínculo, Organização, E-mail, Matrícula ou nº do contrato e, só se o certificado exigir, CPF), depois "Cadastrar e inscrever". Nunca registre CPF ou RG nos campos de matrícula.
- **Em lote:** botão **"Inscrever em lote"**. Cole a lista (uma pessoa por linha, até 300) e use **"Conferir a lista"** antes de **"Inscrever todos"**. 7 dígitos são lidos como SIAPE.

Dicas: a busca da aba Inscrições **não ignora acento** (procure "Cíntia" com acento, ou use parte do nome ou o SIAPE). No lote, a busca por nome ignora acento. Uma linha só com nome, sem SIAPE, é procurada entre os servidores e, se houver um só com esse nome, entra esse servidor ("servidor, pelo nome" na coluna "Como foi achado"); se não houver, entra como externo novo. Confira essa coluna antes de gravar, porque homônimo ou grafia diferente leva à pessoa errada ou a um cadastro duplicado. Prefira o SIAPE.

### 7.2 Cancelar e reativar inscrição

Na linha da pessoa, **"Cancelar a inscrição"** exige o "Motivo do cancelamento". O cancelamento devolve a vaga.

**Reativar.** Quem responde pela turma (permissão de concluir turma) desfaz o cancelamento, seja desistência do próprio participante em "Meus treinamentos", seja engano da equipe. Na linha da inscrição **cancelada**, abra o painel (**"reativar"**, com a nota "cancelada"), escreva o **"Motivo"** (obrigatório) e clique em **"Reativar inscrição"**. Resposta: "{nome}: inscrição reativada."

- A pessoa volta **Confirmada**, o motivo do cancelamento é apagado da linha e o motivo da reativação fica na trilha de auditoria (evento "INSCRICAO_REATIVADA").
- **Só se houver vaga.** Sem vaga: "TUR-... não tem vaga: N de N ocupadas." Aumente as vagas e tente de novo.
- **Só em turma que ainda recebe inscrição.** Em turma concluída ou cancelada: "TUR-... está concluída e não recebe inscrição." / "... está cancelada ...". A inscrição cancelada por causa do cancelamento da turma, portanto, não se reativa.
- Sem motivo: "Reativar a inscrição exige o motivo: fica na trilha." Em inscrição que não está cancelada: "Só inscrição cancelada se reativa."
- O botão só aparece com a turma Planejada ou com Inscrições abertas. Em outras situações a tela não o oferece.
- Inscrever de novo a mesma pessoa pelo botão de inscrever continua recusado ("... já consta em TUR-... como cancelada."): use a reativação.

Cancelar continua exigindo o motivo e devolvendo a vaga; a reativação ocupa uma vaga de novo.

### 7.3 Pedidos pelo link: conferir e decidir

Caminho: **Pedidos pelo link** (ou a mesma lista na aba Inscrições). Cada pedido gera uma Pendência "Confirmar inscrição pedida pelo próprio participante", fechada quando você decide.

**Todo pedido pelo link nasce como "Pedido pelo link, a conferir"** e aparece na lista, **sem ocupar vaga**, até alguém decidir:

- Pedido **com e-mail**: a pessoa recebe uma mensagem, clica em "Confirmar" e fica **Confirmada** na hora, sem passar pela equipe (o link vale uma vez e por 48 horas; cada e-mail recebe no máximo 3 confirmações por dia). Isso vale mesmo quando o SIAPE informado não confere com o cadastro. Enquanto ela não confirma, o pedido continua na sua lista e você pode aceitá-lo.
- Pedido **sem e-mail**, ou com SIAPE que não casa: só sai da lista quando você decide. Avisos comuns: "Pedido pelo link: o SIAPE ... informado não confere com o cadastro de servidor." (o vínculo aparece como "Outro", porque "Servidor da UFVJM" só vem do cadastro de servidores) e "Parece com PTC-...".
- Cada turma guarda no máximo 200 pedidos em espera. O texto de resposta ao público é sempre o mesmo, para não revelar quem já está cadastrado.

Como decidir:

1. Marque os pedidos.
2. **"Aceitar os marcados"**: viram inscrições **Confirmadas** e ocupam vaga. Se marcar mais do que as vagas livres, nenhum é aceito ("... 5 pedidos marcados e 3 vagas livres — nenhum foi aceito; desmarque 2 e aceite de novo.").
3. **"Recusar os marcados"**: exige o "Motivo da recusa", que fica registrado e **não vai no e-mail** do participante.
4. Em pedido com "Parece com PTC-...", escolha usar o cadastro existente ou "não é a mesma pessoa".

Quem não deixou e-mail não recebe aviso nenhum: a equipe precisa avisar por outro meio. A retirada do pedido pelo próprio servidor ("Pedido de vaga em TUR-... retirado.") mantém o registro.

---

## 8. Link público, QR e vitrine pública

### 8.1 Link público de inscrição

Na aba **Inscrições**, bloco **"Inscrição pública por link"** (estados: "desligado", "ligado", "ligado, mas fora do prazo ou da situação").

Para gerar: a turma precisa estar em **Inscrições abertas** e ter "Inscrições até" definido. Se faltar a data, o sistema avisa: "Defina antes até quando ... recebe inscrição (aba Turma, “inscrições até”) ...".

Ao gerar, a tela mostra o endereço com "Copiar link" e "Abrir o formulário", uma "Mensagem pronta" com "Copiar mensagem" e o QR com **"Baixar o QR (PNG)"**. Depois, "Ver o link e o QR" mostra tudo de novo (para quem pode editar a turma; cada consulta fica na trilha). Se a mensagem disser "Este link não pode ser revisto...", gere um novo (vale para links de antes de 29/10/2026).

Outras ações: **"Gerar um link novo (o atual para de funcionar)"** e **"Desligar o link"**. Cuidado: acionar de novo o botão de gerar também troca o endereço, e o cartaz ou a mensagem já divulgados passam a mostrar "Link de inscrição inválido". Gere uma vez só e use "Ver o link e o QR" depois.

O link deixa de funcionar quando: passa "Inscrições até", as vagas esgotam, a turma sai de "Inscrições abertas", ou o link é desligado ou trocado. Uma chave inexistente mostra "Link de inscrição inválido".

**Atenção ao QR em sala:** o formulário aceita **no máximo 8 envios por 10 minutos por rede**, e erros de preenchimento contam. Em sala com todos na mesma rede da universidade, só os 8 primeiros passam, e os demais veem "Envios demais deste endereço. Espere alguns minutos...". Para turma presencial grande, prefira inscrever em lote antes do evento, ou peça ao pessoal para usar a rede do celular.

### 8.2 Vitrine pública (/cursos)

A vitrine ("Cursos da SISA", sem login) lista turmas publicadas em abas **"Inscrições abertas"**, **"Em breve"** e **"Realizados"**, com filtros de Setor, Campus e Modalidade.

Para publicar uma turma (permissão de criar turma, dono ou superior), na aba **Inscrições**, bloco **"Vitrine de cursos"**:

1. Preencha "Título na vitrine (opcional)", "Modalidade" (Presencial, Online, Híbrido), "Público" (Servidores, Terceirizados, Estudantes, Comunidade) e "Pré-requisito (opcional)".
2. Marque **"Divulgar na vitrine pública"** e clique em **"Salvar"**.

Condições para publicar ("Falta para publicar:"): setor promotor da turma ("Informe o setor promotor da turma."), data de "inscrições até", ao menos um público, descrição do curso (a "Descrição do evento") com no mínimo 40 caracteres, e local (ou modalidade online). Turma sem "Unidade promotora" não publica. Para retirar, salve sem a caixa marcada: a ficha pública passa a dar "não encontrado", e nada é apagado.

A ficha pública (/cursos/{código}) oferece "Compartilhar no WhatsApp", "Enviar por e-mail", "Baixar cartaz (PDF A4)" e "Adicionar à agenda (.ics)", além do formulário "Pedir a vaga".

**Arte da turma** (bloco "Arte da turma"): PNG, JPEG ou WEBP até 3 MB, entre 600 x 750 e 2160 x 2700 px, de preferência na proporção 4:5; o "Texto alternativo (opcional)" descreve a imagem para leitor de tela. É obrigatório marcar a declaração de que não há pessoas identificáveis ou de que elas autorizaram o uso da imagem. O sistema remove os metadados da imagem (como localização). "Retirar" volta à capa gerada.

**Duas portas, dois controles de público.**

- "Desligar o link" **não fecha a vitrine**, e retirar da vitrine não desliga o link. São duas portas independentes. Se quer encerrar as inscrições de verdade, volte a turma para Planejada, ou desligue as duas.
- O "Público" marcado na vitrine é **só informativo**. Quem decide, de fato, é a caixa **"Aceita comunidade externa"** da turma. Mantenha os dois coerentes, para que a vitrine não prometa o que a turma não aceita.

### 8.3 "Quero ser avisado" (aviso de interesse)

No rodapé da vitrine, o visitante pode pedir aviso de novas turmas (com confirmação por e-mail, descadastro pelo próprio aviso, validade de 12 meses; o cadastro que não for confirmado é apagado em 7 dias). Na aba **Inscrições** você liga ou desliga o recurso em **"Ligar o aviso de interesse"** (permissão de gerenciar o catálogo). A equipe vê só a contagem em "Quem pediu aviso". Ao abrir inscrições de uma turma publicada, quem confirmou é avisado uma vez.

**Atenção:** com o recurso **desligado**, o formulário continua aparecendo na vitrine e continua guardando nome e e-mail ("Aguardando confirmação"), sem que o aviso saia. Decida se mantém o recurso ligado ou trate esses registros como pedido de apagamento.

**Pedido do titular (LGPD):** link **"Pedido do titular"** (rodapé da área de aviso). **"Consultar por e-mail"** mostra só a contagem por tipo, e **"apagar"** remove os registros. Consulta e apagamento ficam na trilha sem o e-mail.

---

## 9. Presença, notas, conclusão e correções

### 9.1 Lançamento (visão do coordenador)

Aba **"Presença e notas"** (permissão de lançar presença e nota, papel "Presença" se for ajudante). Uma coluna por dia, com "presente" e "ajustar horas"; depois "Horas", "Frequência", "Nota" e "Situação". Botão **"Salvar folha"**.

Regra de cálculo: frequência = soma das horas presentes dividida pela carga da turma. **Falta justificada continua falta.** Aprovado exige frequência no mínimo igual à mínima e, quando há nota mínima, nota no mínimo igual à mínima.

Presença só se lança de dia que já aconteceu. Em turma de 1 dia há o botão "Marcar todos presentes (N h)"; em turma de vários dias ele não existe, e o atalho é "Lançar a folha de um dia", que marca todo mundo presente naquele dia (sobrescreve até faltas já lançadas, com registro na trilha). Depois de salvar, a coluna "Situação" da grade mostra o que falta a cada pessoa ("Falta presença", "Falta a nota", "Faltam presença e nota").

A **"Lista de presença"** (botão no topo da ficha) gera um arquivo Word na hora, com os inscritos do momento. Ele tem **uma só coluna de assinatura** para o período inteiro. Em turma de vários dias, imprima uma folha por dia ou anote o dia na própria folha.

### 9.2 Concluir turma

1. A partir do último dia da turma, clique em **"Concluir turma…"**.
2. O popup mostra a prévia ("... X aprovado(s) e Y reprovado(s). N inscrito(s) ainda sem nenhuma presença lançada — sairá reprovado.").
3. Confirme em **"Concluir e apurar os N"**.

Concluir é **um ato só**: apura todos e grava Aprovado ou Reprovado. **Atenção:** a faixa de alerta do popup destaca só quem está sem presença. Quem está **sem nota**, quando a turma exige nota mínima, aparece apenas na lista de reprovados logo abaixo (até 10 nomes, cada um com o motivo, por exemplo "nota não lançada, e a turma exige no mínimo 7"), sem alerta próprio, e sai Reprovado. **Antes de concluir, leia essa lista e confira na aba "Presença e notas" se todos têm nota** (a coluna "Situação" diz "Falta a nota"). Se concluiu e ficou alguém reprovado por falta de nota, use a retificação (9.4).

Mensagem de conclusão: "TUR-...: concluída. Confira os dados e emita os certificados." Antes do último dia: "... termina em ...: só se conclui turma que já aconteceu."

### 9.3 "Registrar turma já realizada"

Atalho para curso que já foi dado e não teve presença lançada. Marca todos presentes pela carga inteira e conclui a turma. Só funciona em turma **sem nenhuma presença lançada**. Quem faltou precisa ter a presença lançada antes. Se a turma exige nota mínima, o atalho só lança presença, e você lança as notas e conclui depois.

### 9.4 Corrigir depois de concluída

- **Presença ou nota (retificação).** Depois da conclusão, qualquer alteração exige **motivo por escrito** (campo "Motivo da retificação"), e o resultado é reapurado (por exemplo, de Reprovado para Aprovado). Quem já tem certificado válido não pode ter presença ou nota alteradas: **anule o certificado com motivo, corrija e reemita**.
- **Dados da turma.** Botão **"Corrigir dados da turma"** (permissão de concluir/cancelar). Corrige datas, local, descrição, campus, unidade promotora, carga horária, data base e observações, com "motivo" obrigatório e botão "Gravar a correção". Se a nova carga mudar o resultado de quem já tem certificado em vigor, o sistema pede para corrigir a presença ou anular o certificado antes.
- **Certificados já emitidos continuam com o dado antigo.** Use **"Reemitir os certificados…"** na aba Emissão. Esse botão só aparece para quem pode anular e emitir (o técnico não tem). Ele anula e reemite com motivo, e os números antigos não voltam ("2 certificado(s) reemitido(s): ... → ...").

### 9.5 Emissão (só o que toca a turma)

Aba **"Emissão"**. A emissão exige turma concluída e ao menos um instrutor marcado para assinar. "Emitir N certificado(s)…" consome números da sequência do ano, e **número consumido não volta**. O detalhe do certificado, anulação, segunda via e reciclagem pertence ao manual de Certificados.

Mensagens comuns: "Ninguém apto a emitir nesta turma." / "Emissão bloqueada: ... está reprovado(a): nota 5 abaixo da mínima 7" / "Emissão bloqueada: ... já tem o certificado ...: anule-o com o motivo antes de reemitir."

"Enviar por e-mail os não enviados" não alcança quem não tem e-mail cadastrado ("... N sem e-mail cadastrado"). Entregue o PDF a essas pessoas por outro meio. O nome do arquivo Word dentro do .zip de certificados usa uma sequência interna que pode diferir do número impresso no certificado. Vale o número impresso.

---

## 10. Cancelar e excluir turma

### 10.1 Cancelar turma

1. Na ficha, clique em **"Cancelar turma"**.
2. Informe o motivo (obrigatório: "Cancelar exige o motivo: é o único registro que sobra para quem perguntar depois por que a turma não aconteceu.").

**Atenção, o cancelamento é só da turma:**

- O cancelamento da turma **cancela junto as inscrições vivas** (pedido pelo link a conferir, Inscrita e Confirmada). Cada uma fica "Cancelada" com o motivo "Turma cancelada: {motivo que você escreveu}" e entra na trilha ("... (turma cancelada)"). Em "Meus treinamentos", a pessoa vê "Cancelada" com esse motivo.
- **Quem tem e-mail no cadastro recebe aviso** ("Turma cancelada — {treinamento}", com o código e o período, dizendo que a inscrição não vale mais). **O motivo não vai no e-mail**: fica só na trilha e na ficha.
- Quem **não tem e-mail** não é avisado: avise por outro meio (telefone, mensagem). Confira também a coluna de e-mail da aba Inscrições antes de cancelar.
- Turma cancelada não reabre e as inscrições canceladas por ela não se reativam (capítulo 7.2).

Se a turma estava publicada na vitrine, confira se saiu de "Inscrições abertas". Se o link estava ligado, a turma cancelada deixa de aceitar pedidos, mas confira a página pública.

### 10.2 Excluir turma

Só vale para turma **Planejada** ou **Inscrições abertas** e **sem história**. O botão "Excluir turma" exige o "Motivo da exclusão". O código excluído não volta para a sequência, e as inscrições lançadas pela equipe vão junto com a turma.

A exclusão é recusada, com os motivos listados na própria janela, quando há presença ou nota lançada, certificado (mesmo anulado), e-mail já enviado a algum inscrito, ou pedido feito pelo próprio participante ("... essa pessoa precisa ler o cancelamento. Cancele a turma, com o motivo."); turma concluída ou cancelada não se exclui. Dado errado em turma concluída se corrige por "Corrigir dados da turma".

---

## 11. Avaliação de reação

É a avaliação do treinamento pelo participante (conteúdo, instrutor, material, local, carga horária e se recomendaria, além de um comentário opcional).

- **Participante com conta:** em "Meus treinamentos", na turma encerrada em que frequentou, botão **"Avaliar"**. O prazo é de 60 dias após o fim da turma.
- **Participante sem conta:** o convite sai **por e-mail** no momento em que a turma é concluída. Participante sem e-mail cadastrado nunca é convidado. **Se o e-mail do sistema estiver desligado na hora de concluir, nenhum convite é gerado** e não há como reenviar depois. Confirme que o envio de e-mail está ativo antes de concluir turmas em que a avaliação importa.
- **Para você:** aba **"Avaliação de reação"** da turma e a tela consolidada **Avaliação de reação** (por treinamento e por instrutor).

**Anonimato:** a resposta não tem nome nem hora. Com **menos de 3 respostas**, aparece só a contagem ("menos de 3 respostas: médias não exibidas"), e os comentários são embaralhados. Não tente identificar quem respondeu.

---

## 12. Privacidade e auditoria

**O que o sistema protege:**

- O CPF nunca aparece em tela depois de gravado (aparece mascarado). O formulário aceita CPF só quando o certificado exige. Para gravar, use "CPF" > "Gravar" na linha do participante, e para apagar, marque "apagar".
- O nome do participante externo existe apenas no cadastro dele. Servidor entra pelo cadastro de servidores, e o nome vem de lá (para corrigir, corrija lá).
- No link público, o participante dá o consentimento ("Li e concordo com o uso dos dados"). O endereço de rede (IP) do pedido, usado para apurar abuso, é apagado após 90 dias.
- Comprovantes de qualificação só são baixados por quem gerencia instrutores, com registro na trilha.

**Trilha de auditoria.** O módulo registra, entre outros: criação e correção de turma (com motivo), exclusão (com motivo), mudança de situação (origem e destino), vínculo de instrutor, designação de ajudante, inscrição, pedido pelo link, geração do link, lançamento de nota, retificação de resultado (com motivo), apuração da turma, emissão de certificado, alteração de CPF (sem o número) e cadastro de qualificação.

A trilha **não grava e-mail nem CPF**. Ela grava, porém, a nota e a frequência como valores, ligadas ao código do participante (PTC). Trate o acesso à trilha com o mesmo cuidado que dá às notas.

**Decisões de privacidade que cabem a você:**

- Manter ou desligar o aviso de interesse (capítulo 8.3).
- Atender pedidos do titular pelo link "Pedido do titular".
- Revisar quem tem perfis que veem os dados de participantes.

---

## 13. Rotina de acompanhamento

### Diária (ou a cada dia de funcionamento)

1. Abra **Pedidos pelo link** e decida os pedidos pendentes. Pedido sem e-mail só ocupa vaga depois que você aceita.
2. Veja as **Pendências** do módulo ("Confirmar inscrição pedida pelo próprio participante").
3. Nos dias de treinamento: confira se a lista de presença foi impressa e se a presença está sendo lançada.
4. Se houve cancelamento de turma, confirme que os inscritos foram avisados.

### Semanal

1. Em **Turmas**, filtre por "Inscrições abertas" e veja o que precisa de ação: prazo de "Inscrições até" perto do fim, turmas com muitas vagas livres, turmas lotadas (considere nova turma).
2. Veja turmas que já passaram do último dia e ainda não foram concluídas.
3. Confira as turmas concluídas sem certificados emitidos.
4. Confira a vitrine pública: só devem estar publicadas turmas reais, com descrição e prazos corretos.
5. Revise a lista de turmas "Em andamento": alguma foi iniciada por engano?

### Mensal

1. **Instrutores:** qualificações próximas do vencimento (também aparecem em Pendências 30 dias antes), vigências que acabam, duplicados, títulos em branco.
2. **Catálogo:** treinamentos ativos que ninguém mais oferece, cargas horárias e validades de reciclagem.
3. **Locais:** locais fora de uso (inativar) e capacidades.
4. **Setores promotores:** a lista está correta e inclui o setor da equipe.
5. **Avaliação de reação:** veja a tela consolidada por treinamento e por instrutor e use os resultados nas decisões.
6. **Aviso de interesse:** confirme se continua ligado ou desligado conforme a decisão tomada.
7. **Ajudantes:** retire quem não precisa mais operar turmas.

---

## 14. Como conferir que o módulo está saudável

- Nenhum pedido pelo link parado há dias em "Pedidos pelo link".
- Nenhuma turma passada do último dia sem conclusão.
- Nenhuma turma concluída com participantes aprovados e sem certificado, a não ser por motivo conhecido.
- Todo instrutor ativo tem título preenchido e não está duplicado.
- Cada turma em andamento ou com inscrições abertas tem ao menos um instrutor marcado "assina" (se for concluir em breve).
- Nenhum inscrito sem e-mail de turma cancelada continua sem aviso (quem tem e-mail é avisado pelo sistema).
- A vitrine só mostra turmas que de fato recebem inscrição, e o público marcado combina com "Aceita comunidade externa".
- O setor da própria equipe está em "Setores promotores".
- O e-mail do sistema está ativo, se você depende de confirmação de inscrição, aceite e avaliação de reação.

---

## 15. Erros e mensagens comuns

| Mensagem ou situação | O que fazer |
|---|---|
| "403 — acesso negado" com "Esta turma é de {nome}; só ele ou a coordenação acima pode alterar." | A turma é de outra pessoa. Peça ao dono para designar a conta como ajudante, ou altere você mesmo se for da coordenação acima. O texto da tela que fala em "concessão do perfil" não é o caminho certo. |
| Almoxarife ou admin de TI recebe 403 em tudo | Esses perfis não têm acesso ao módulo. Não adianta designá-los como ajudantes. |
| "... já tem 1 turma(s): não se exclui. Desmarque “ativo” ..." | Inative em vez de excluir. |
| "Transição proibida: Em andamento → Inscricoes abertas. ..." | Não existe volta de "Em andamento". |
| "... termina em ...: só se conclui turma que já aconteceu." | Aguarde o último dia. |
| "TUR-... não tem vaga: 3 de 3 ocupadas." | Aumente as vagas ("Editar dados da turma") ou abra outra turma. |
| "... já consta em TUR-... como cancelada." | Use "reativar" na linha da inscrição cancelada (capítulo 7.2), com motivo, se a turma ainda recebe inscrição e há vaga. |
| "Defina antes até quando ... recebe inscrição ..." | Preencha "Inscrições até" na aba Turma. |
| "Envios demais deste endereço. ..." | Limite de 8 envios por 10 minutos por rede. Espere alguns minutos ou inscreva em lote. |
| "Turma com link público precisa começar depois de hoje ..." | Link só vale antes do início. Depois disso a equipe inscreve. |
| "... não tem nenhum instrutor marcado para assinar o certificado" | Remova o instrutor ("tirar") e vincule de novo com "assina o certificado" marcado. |
| "Turma encerrada não muda de instrutor." | Já houve certificado emitido. Não é possível trocar. |
| "... retificação exige o motivo por escrito ..." | Informe o motivo ao corrigir presença ou nota depois de concluída. |
| "... já tem o certificado ...: anule-o com o motivo e reemita depois de corrigir." | Anule o certificado (quem tem permissão), corrija e reemita. |
| "Falta para publicar: ..." | Complete o item citado (prazo, público, descrição, local). |
| "... não está entre os setores que promovem treinamentos ..." | Inclua o setor em Setores promotores. |
| "A assinatura de {nome} não vigora em ..." | Ajuste a vigência do instrutor ou escolha outro. |
| "Excluir exige o motivo ..." / "Cancelar exige o motivo ..." | Preencha o motivo. |

---

## 16. Glossário

- **Turma:** oferta de um treinamento, com data, local, instrutor e vagas.
- **Dono:** quem criou a turma ou o treinamento. Tem poder de alterar.
- **Ajudante:** conta que o dono autoriza a operar a turma em papéis específicos.
- **Setor promotor / Unidade promotora:** setor que realiza o treinamento. Define a sigla do certificado.
- **Código curto:** sigla do treinamento que entra no número do certificado.
- **PTC:** código interno de identificação de um participante (por exemplo, PTC-XXXXXXXX).
- **Pedido pelo link:** solicitação de vaga feita pelo formulário público.
- **Vitrine:** página pública /cursos que lista as turmas divulgadas.
- **Retificação:** correção de presença ou nota depois da conclusão, com motivo.
- **Apuração:** cálculo de frequência e nota que define Aprovado ou Reprovado, feito ao concluir a turma.
- **Avaliação de reação:** pesquisa de opinião do participante sobre o treinamento, anônima.
- **Data base do vencimento:** data de onde se conta a validade da reciclagem.

---

## 17. Limites conhecidos

Estes pontos afetam o uso hoje. Conheça-os para orientar a equipe e evitar surpresas.

**Alta atenção**

1. **Reativar inscrição exige vaga e turma que ainda recebe inscrição.** A reativação (capítulo 7.2) vale para cancelamento pela equipe e para desistência do participante, mas não para inscrição cancelada pelo cancelamento da turma, nem em turma lotada. O botão só aparece em turma Planejada ou com Inscrições abertas.
2. **O aviso de turma cancelada só chega a quem tem e-mail**, e sem o motivo. Os demais precisam ser avisados por outro meio.

**Atenção média**

3. **Limite de 8 envios por 10 minutos por rede** no link público e na vitrine. Pode travar inscrição presencial por QR numa mesma rede.
4. **"assina o certificado" não se altera depois do vínculo.** A caixa vem marcada, mas quem a desmarca por engano precisa remover ("tirar") e vincular de novo.
5. **Instrutor pode ser cadastrado em duplicidade e sem título.** Confira antes de cadastrar.
6. **A busca de participante na aba Inscrições não ignora acento**, ao contrário da inscrição em lote.
7. **"Iniciar turma" é irreversível**, não confere a data e deixa uma turma futura presa em andamento. O link público fecha.
8. **Concluir não dá alerta destacado para quem está sem nota** e o deixa reprovado ("nota não lançada, e a turma exige no mínimo ..."); o motivo só aparece na lista de reprovados da prévia.
9. **O formulário "Quero ser avisado" coleta nome e e-mail mesmo com o aviso de interesse desligado.**
10. **O texto do 403 de turma alheia orienta pelo caminho errado** e cita uma permissão que não existe. O caminho certo é pedir ao dono que designe a conta como ajudante.
11. **Dois controles de público:** o "Público" da vitrine é só informativo, e quem vale é "Aceita comunidade externa" da turma. Pedido com SIAPE divergente, confirmado pelo e-mail da própria pessoa, entra Confirmado sozinho.

**Atenção baixa**

12. A lista de ajudantes inclui contas sem acesso ao módulo (como o almoxarife).
13. A lista de presença em Word tem uma só coluna de assinatura, mesmo em turma de vários dias.
14. Carga horária da turma em branco é herdada do catálogo sem que a tela diga que foi herdada (só o campo de abrir turma sugere "usa a do catálogo"); a ficha e a vitrine mostram a carga que vale.
15. A trilha de auditoria guarda valores de nota e frequência ligados ao código do participante.
16. Algumas mensagens e rótulos são imprecisos (por exemplo, "Transição proibida" mostra os nomes das situações sem acento).
17. O nome do arquivo Word do certificado dentro do .zip usa uma sequência diferente do número impresso.
18. A avaliação de reação só chega por e-mail para quem não tem conta, e só se o e-mail estiver ligado na hora de concluir a turma.
19. O painel inicial pode dar alarme falso em "Turmas encerrando", e o contador da aba Inscrições conta também as inscrições canceladas.
20. Editar treinamento ou instrutor fora da tela do sistema, sem todos os campos, pode apagar dados e desativar o cadastro. Use sempre a tela.

**O que este manual não cobre, por não ter sido testado:** os perfis terceirizado e discente; o envio real de e-mails (confirmação, aceite, avise-me, convite de avaliação; nos testes ficaram na fila "PENDENTE"); a avaliação pelo link recebido por e-mail e o acesso do participante sem conta; a junção de participantes duplicados (botão "Juntar" na inscrição e tela de duplicados); e o conteúdo visual do PDF do certificado. Modelos de certificado, anulação individual, segunda via, reciclagem e indicadores estão no manual de Certificados.
