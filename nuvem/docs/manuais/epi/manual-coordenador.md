# Manual do Coordenador — Gestão de EPI (Sistema SISA)

## Para quem é este manual

Este manual é para quem **responde pelo módulo Gestão de EPI**: a coordenação, a superintendência e o técnico de segurança que fazem a gestão. Aqui você encontra o que cabe a você decidir, o que acompanhar todo dia, toda semana e todo mês, e como conferir que o módulo está saudável.

Se você só precisa pedir um EPI, entregar no balcão ou consultar a própria ficha, use o manual do usuário.

Os exemplos (nomes, SIAPE, lotes, protocolos) são fictícios.

## Antes de começar

**O que o módulo faz.** Controla o catálogo de EPI, o estoque por lote, os pedidos (requisições), as entregas, a ficha de EPI de cada servidor e os indicadores. A entrega gera a prova legal: uma linha na ficha com os dados do equipamento congelados no momento.

**Perfis e o que cada um pode.** O acesso do módulo é dado por permissão. Os perfis do sistema já trazem as permissões abaixo.

| Permissão | O que libera |
|---|---|
| Ver catálogo, estoque e pedidos de EPI | Abrir Painel, Requisições, Catálogo, Estoque (leitura) e Minha ficha |
| Gerenciar o catálogo de EPI | Cadastrar e editar itens, categorias, motivos de recusa, foto, PDF e treinamentos |
| Registrar entrada, ajuste e descarte de estoque | Dar entrada, Ajustar, Descartar, corrigir documento do lote, reservar e separar |
| Registrar entrega e emitir a ficha de EPI | Entregar, devolução, estorno, anexar comprovante, tratar comunicação, recusa de balcão |
| Ver a ficha de EPI de qualquer servidor | Fichas de EPI e identificação nominal |
| Abrir e enviar pedido de EPI | Nova requisição, editar rascunho, enviar, cancelar |
| Analisar pedido de EPI | Iniciar análise, aprovar, recusar, indeferir, devolver à fila, reabrir |
| Indicadores | Relatórios |

| Perfil | O que tem no módulo |
|---|---|
| Coordenador, Superintendente, Técnico de Segurança | Tudo |
| Engenheiro de Segurança | Analisa, mexe no catálogo, vê fichas, requisita. **Não** entrega e **não** mexe em estoque |
| Médico do Trabalho | Analisa, vê fichas, requisita. Sem catálogo, entrega ou estoque |
| Secretaria da CSSO | Requisita e vê. Vê o requerente como "SRV-xxxx" (sem nome) e não abre fichas |
| Almoxarife do SESMT | Entrega, estoque, fichas. **Não** requisita, **não** analisa e não vê Relatórios |
| Servidor | Pede EPI e vê só os próprios pedidos e a própria ficha |
| Auditor interno e Consulta PROGEP | Somente leitura (fichas, pedidos, indicadores) |
| Administrador do sistema (TI) | Sem acesso ao módulo de EPI: recebe "403" |

**Uma ligação importante.** A "Minha ficha de EPI" só abre para quem tem a conta ligada a um cadastro de servidor. Quem não tem vê um aviso orientando a informar os dados em "Meu perfil", opção "Sou servidor da UFVJM". Confira isso para a equipe que também recebe EPI.

## Sumário

1. Suas responsabilidades
2. Rotina de acompanhamento
3. Painel
4. Catálogo
5. Estoque e lotes
6. Requisições: análise e decisão
7. Reserva e entrega do pedido
8. Entrega direta no balcão
9. Fichas de EPI, devolução, estorno e comunicações
10. Relatórios e indicadores
11. Prazos, pendências, auditoria e privacidade
12. Como saber se o módulo está saudável
13. Mensagens comuns e o que fazer
14. Glossário
15. Limites conhecidos

---

## 1. Suas responsabilidades

- **Acessos.** Garantir que cada pessoa tenha o perfil certo. Atenção a quem concentra funções: o almoxarife entrega e mexe em estoque, mas não analisa; a secretaria pede, mas não vê nomes.
- **Catálogo.** Manter itens com CA válido, quantidade padrão e máxima, vida útil e treinamento exigido.
- **Decisões.** Aprovar, recusar ou indeferir pedidos com motivo do catálogo; autorizar (ou não) exceções ao máximo.
- **Estoque.** Conferir que os lotes têm CA válido e que o saldo bate com a prateleira.
- **Prazos.** Comprovantes assinados (10 dias), CA a vencer, trocas devidas.
- **Privacidade.** Não deixar dado de saúde, CPF ou CID em texto livre.
- **Correções.** Estornar, ajustar, descartar e cancelar quando houver erro.

---

## 2. Rotina de acompanhamento

### Todo dia
1. Abra **Painel**. Olhe os cartões **Pedidos a analisar**, **Comunicações do titular a tratar** e **Itens sem estoque**.
2. Abra **Requisições** e veja a coluna **Parado há**. Pedido parado precisa de dono.
3. Confira as pendências no sino ("Pendências"): comprovantes, comunicações e itens sem estoque.

### Toda semana
1. No **Painel**, veja **CA a vencer em 60 dias** e a tabela **CA a vencer**.
2. Em **Fichas de EPI**, veja a faixa "N entrega(s) sem comprovante assinado" e cobre o almoxarifado.
3. Em **Estoque**, olhe o cartão **Presas em lote impedido** e a faixa vermelha dos lotes com CA vencido.
4. Veja **Trocas devidas** (lembre que a ficha e o Painel podem divergir; ver "Limites conhecidos").
5. Em **Requisições**, filtre por **Indeferida** e **Cancelada** e confira se os motivos fazem sentido.

### Todo mês
1. Veja **Entregas do mês** no Painel.
2. Em **Relatórios**, confira peças entregues, recusas por motivo e custo por empenho. Exporte o CSV para arquivo, se for o caso.
3. Revise exceções ao máximo e entregas "sem treinamento em vigor" na **Auditoria** (ver seção 11).
4. Revise o **Catálogo**: faixas vermelha e amarela devem estar limpas.

---

## 3. Painel

**Caminho:** Gestão de EPI > **Painel**.

O Painel mostra "o que está parado, o que falta comprar, o que vence e o que já venceu". Os números são calculados na hora em que a tela abre; nada fica gravado e não há atualização automática. Para atualizar, abra a tela de novo.

**Cartões** (cada um tem um "i" com a explicação da regra):

| Cartão | O que significa |
|---|---|
| Pedidos a analisar | Pedidos enviados ou em análise. Botão "Abrir a fila" |
| Comunicações do titular a tratar | Extravio ou pedido de troca esperando o almoxarifado. "Ver onde tratar" |
| Requisições em trâmite | Pedidos ainda em andamento |
| Itens sem estoque | Itens aprovados e sem lote para entregar |
| CA a vencer em 60 dias | Mostra também quantos já venceram |
| Entregas do mês | Não conta as estornadas |
| Trocas devidas | Equipamentos com vida útil esgotada |

**Gráfico "Requisições por estado":** cada estado é um link para a fila já filtrada.

**Tabelas:** Trocas devidas (com "Abrir ficha"), Itens esperando estoque, CA a vencer (com "Extrato") e Entregas do mês.

**Atalhos:** "Analisar requisições", "Controle de estoque", "Catálogo de EPIs", "Relatórios e indicadores", "Fichas de EPI" e o botão "Registrar entrega". Aparecem conforme a permissão de cada um.

---

## 4. Catálogo

**Caminho:** Gestão de EPI > **Catálogo**. Três abas: **Itens de EPI**, **Categorias (NR-6)** e **Motivos de recusa**. Quem não tem a permissão de catálogo vê tudo em "somente leitura".

### 4.1 Itens de EPI

**Faixas de aviso no topo (acompanhe sempre):**
- Vermelha: "N item(ns) ativo(s) com CA vencido ou sem validade informada". Resolva primeiro, pois o CA vencido impede a entrega.
- Amarela: "N item(ns) exige(m) treinamento, mas nenhum está vinculado". Enquanto não houver vínculo, o sistema não confere o treinamento.

**Cadastrar um item**
1. Clique em **Cadastrar EPI**.
2. Preencha "Nome", "Categoria (NR-6)", "Unidade de medida".
3. Se exige CA, marque "Exige Certificado de Aprovação (CA)" e informe "Número do CA" e "Validade do CA".
4. Defina "Quantidade padrão", "Quantidade máxima" e "Período da máxima (meses)". Máxima e período andam juntos ("2 por 12 meses").
5. Informe "Vida útil (meses)". É ela que define quando a troca fica devida.
6. Informe "Tamanhos (um por linha)". Também aceita "P, M, G".
7. Marque "exige justificativa na requisição" e/ou "exige treinamento comprovado", se for o caso.
8. Salve. Mensagem: "'<nome>' cadastrado."

Para **editar**, use **Editar** na linha do item. Para tirar um item de uso, desmarque "ativo": ele sai do pedido e do balcão. **Itens não se excluem, só se inativam.** A edição grava na trilha cada campo alterado.

**Atenção:** o sistema aceita cadastrar um CA já vencido sem avisar na hora; só a faixa vermelha acusa depois. Confira a validade ao digitar.

**Foto e orientação.** Botão **Foto e orientação**: foto JPEG, PNG ou WEBP até 2 MB; PDF de orientação até 4 MB. O sistema confere o conteúdo do arquivo, não só o nome. Quem já recebeu o EPI continua com o PDF do dia da entrega.

**Treinamentos.** Botão **Treinamentos**: **Vincular** marca o item como "exige treinamento" e liga a um certificado do catálogo (por exemplo "Uso e conservação de EPI — NR-6"). **Desvincular** retira. Havendo mais de um vínculo, todos são exigidos. Na análise e na entrega aparece a etiqueta "sem treinamento em vigor". A entrega **não é bloqueada**: quem entrega precisa confirmar de forma expressa (ver capítulo 8).

### 4.2 Categorias (NR-6)
São as nove categorias do Anexo I da NR-6, já cadastradas. Não se criam categorias novas. Pelo botão **Editar** você muda nome, ordem, referência e se está ativa, e depois **Salvar**. A entrega grava o nome da categoria na ficha; mudar o nome depois não altera o que já foi entregue.

### 4.3 Motivos de recusa
São oito motivos prontos (por exemplo "Acima da quantidade máxima", "Dentro da vida útil", "EPI inadequado ao risco", "Treinamento não comprovado", "Outro motivo (exige complemento)").
- **Cadastrar** (código em letras maiúsculas, números e sublinhado; rótulo; texto da negativa; base normativa; se exige complemento).
- **Editar**: o código não muda e o texto novo **não reescreve** negativa já emitida.
- Motivo não se exclui, só se inativa.
- O texto da negativa é o que o servidor recebe por escrito. Escreva de forma clara e com orientação do que fazer a seguir.

---

## 5. Estoque e lotes

**Caminho:** Gestão de EPI > **Estoque**.

O saldo é a **soma dos movimentos** (entrada, saída, devolução, ajuste, descarte). Nenhuma linha do extrato se altera ou se apaga. **Disponível = físico − reservado.** Lote com CA vencido ou sem CA continua com saldo (é patrimônio), mas **não sai e não pode ser reservado**.

**Cartões:** Itens com lote, Unidades em estoque, Podem ser entregues hoje, Presas em lote impedido.

**Busca:** "Buscar por item, lote, empenho, pregão, CA ou fornecedor", botão **Buscar**.

**Botões por lote:** **Extrato**, **Ajustar**, **Descartar**, **Corrigir nota, contato ou situação**. Botão do topo: **Dar entrada em lote**.

### 5.1 Dar entrada em lote
1. Clique em **Dar entrada em lote**.
2. Em "A caixa que chegou": Item do catálogo, Quantidade recebida, Tamanho, Data de entrada, Número do CA do lote, Validade do CA, Fabricação, Lote.
3. Em "O papel da compra": Pregão, Item do pregão, Empenho, Quantidade empenhada, Nota fiscal, Nº do ofício, Valor unitário (R$), Fornecedor, CNPJ, Contato do fornecedor, Observação.
4. Clique em **Dar entrada em lote**.

**O sistema impede:** quantidade zero; tamanho que não existe no catálogo; CNPJ com dígito verificador errado; receber mais do que o empenhado; valor negativo; **lote duplicado** (mesmo item, lote e tamanho já registrados). Se chegou mais da mesma caixa, use **Ajustar**; se é outra compra, informe a nota fiscal diferente.

**Avisos na gravação:**
- "ATENÇÃO: o lote não pode ser entregue — o CA ... venceu" ou "o lote não tem número de CA registrado". O lote é gravado, mas fica impedido.
- "N item(ns) de pedido(s) esperam este equipamento — a reserva não é automática". Abra o pedido e reserve o lote.

**Importante:** depois de gravada, a quantidade recebida nunca muda. **CA, validade, lote, tamanho, item e empenho também não podem ser corrigidos.** Confira tudo antes de gravar (ver "Limites conhecidos").

### 5.2 Ajustar (inventário)
Use quando a contagem física diverge do sistema.
1. Em **Ajustar**, informe "Contagem" (quantas unidades você contou) e "Motivo" (obrigatório).
2. Mensagem de sucesso: "Inventário registrado no lote ...: -2, saldo agora 18. O extrato do lote guarda a contagem, o motivo e o seu nome."
Se a contagem confere com o saldo, o sistema avisa que não há o que ajustar.

### 5.3 Descartar
Em **Descartar**, informe "Quantidade" e "Motivo" (obrigatório). O saldo não pode ficar negativo; se a prateleira discorda do sistema, use **Ajustar**.

### 5.4 Corrigir nota, contato ou situação
Altera apenas Nota fiscal, Nº do ofício, Contato do fornecedor, Observação e a caixa "lote ativo". Para inativar o lote é obrigatório o "Motivo da inativação". Inativar **solta toda reserva** do lote. Lote não se exclui.

### 5.5 Extrato
Botão **Extrato** (também aberto pelo Painel): mostra o lote, os indicadores (Recebido, Físico, Reservado, Disponível), a situação do CA e cada movimento com quem registrou.

---

## 6. Requisições: análise e decisão

**Caminho:** Gestão de EPI > **Requisições**.

### 6.1 Estados do pedido

| Estado | O que significa |
|---|---|
| Rascunho | Ainda não enviado. Sem protocolo ("Rascunho #n") |
| Enviada | Esperando análise. Recebe o protocolo EPI-AAAA-NNNN |
| Em análise | Um analista pegou o pedido |
| Analisada | Análise concluída; ainda não houve reserva nem entrega |
| Em atendimento | Começa na primeira reserva ou entrega. É automático |
| Atendida | Tudo entregue. É automático e final |
| Indeferida | Nenhum item foi aprovado |
| Cancelada | Desistência. Final |

Itens (linhas) têm seus próprios estados: Solicitado, Aprovado, Recusado, Reservado, Sem estoque, Entregue, Cancelado. **Recusado, Entregue e Cancelado são finais.**

No envio, lotação, cargo e função do servidor ficam **congelados** ("Contexto congelado"), assim como a declaração do termo NR-06.

### 6.2 A fila
- Abas "Por estado" (Todas, Rascunho, Enviada, Em análise etc.).
- Busca "por protocolo, nome, SIAPE ou e-mail". **Nunca por CPF**: o sistema recusa.
- Colunas: Protocolo, Requerente, Campus · unidade, Itens, Estado, Parado há.
- **Abrir** leva à ficha do pedido, com as seções "Quem pediu, e por quê", "Quem tocou, e quando", "Trâmite", "Itens do pedido" e "Histórico do pedido".
- Botão **Exportar planilha (CSV)** na própria fila, que respeita a aba escolhida (colunas: Protocolo, Requisitante, SIAPE, Campus, Unidade, Situação do pedido, Enviado em, EPI, Tamanho, Solicitada, Aprovada, Entregue, Situação do item, Motivo da recusa). Disponível para coordenação, superintendente, técnico, engenheiro e médico; secretaria, almoxarife e servidor recebem "403".
- Abrir a ficha de um pedido é leitura nominal e fica registrada na trilha (mostra rotina de trabalho e riscos declarados).

### 6.3 Analisar um pedido
1. Abra o pedido e clique em **Iniciar análise** ("Pegar para análise"). Quem pega assume o nome no pedido.
2. Em cada item, clique em **ações** e escolha:
   - **Aprovar**: informe "Quantidade aprovada" (em branco = a pedida; mais que a pedida o sistema recusa, e zero não é aprovar) e "Justificativa da decisão". Clique em **Aprovar item**.
   - **Recusar**: escolha o "Motivo do catálogo" e, se pedir, o "Complemento". Clique em **Recusar item**. O texto vai ao requerente.
   - **Cancelar a linha**: informe o "Motivo". Cancelar é desistência; recusar é decisão técnica.
3. Se o pedido está todo certo, use **Aprovar tudo como pedido**: aprova tudo na quantidade pedida e conclui. Funciona já no pedido Enviada, sem **Iniciar análise** (quem clica assume o pedido), e é tudo ou nada: se qualquer item estourar o máximo, nada é aprovado e o pedido fica como estava.
4. Para fechar, clique em **Concluir análise** (campo "Parecer", opcional; o requerente vê o parecer). Só funciona com todos os itens decididos e pelo menos um aprovado.

**Exceção ao máximo.** O sistema compara com o que a ficha registra nos últimos meses. Se a aprovação ultrapassa o máximo, ele bloqueia e mostra a conta. Para aprovar mesmo assim, marque "Autorizar a exceção ao máximo" e escreva a justificativa. Ela fica registrada com o seu nome. No "Aprovar tudo como pedido", o item que estoura o máximo bloqueia e precisa ser decidido item a item.

### 6.4 Outras decisões
| Ação | Quando usar | Observações |
|---|---|---|
| **Indeferir o pedido inteiro** | Nenhum item é devido | Exige motivo do catálogo. Só com análise iniciada e **sem item aprovado**. Itens sem decisão são recusados com o mesmo motivo |
| **Devolver à fila** | Você não vai continuar | Motivo obrigatório. Outro analista pode pegar |
| **Reabrir para análise** (janela "Reconsiderar") | Reconsiderar indeferido | Motivo obrigatório. **Não reabre as linhas recusadas** (ver "Limites conhecidos") |
| **Cancelar o pedido** | Desistência ou erro | Quem cancela: o servidor beneficiário, quem abriu o pedido ou quem analisa (a secretaria só os que abriu). Motivo obrigatório. Itens não entregues são cancelados e a reserva volta ao estoque. Pedido indeferido ou atendido não se cancela |

### 6.5 Boas práticas de governança
- A regra do sistema é que **ninguém analisa o próprio pedido**. Como a conferência olha o servidor beneficiário, adote como regra da coordenação: **quem abre um pedido para outra pessoa não o analisa**.
- Pegar o pedido não é exclusivo. Combine com a equipe que só decide item quem pegou o pedido, para o campo "Analisado por" refletir quem decidiu.
- Uma aprovação concluída **não pode ser corrigida**. Antes de concluir, releia quantidades e itens. Se errar, o caminho é cancelar a linha ou o pedido.
- Pedido de servidor pode vir com quantidade acima do máximo; quem decide é a análise.

---

## 7. Reserva e entrega do pedido

Quem tem permissão de estoque reserva; quem tem permissão de entregar entrega. Na seção "Itens do pedido". A reserva só vale com o pedido **Analisada** ou **Em atendimento** e é **opcional**: o item Aprovado pode ser entregue direto, escolhendo o lote na hora (baixa o lote do mesmo jeito). Estando **Reservado**, a entrega tem de sair do lote reservado e dentro da quantidade reservada; para trocar de lote, solte a reserva com motivo.

- **Separar todos**: reserva cada item no lote que vence primeiro. Mostra "N itens separados..." ou "Nenhum item separado" com o motivo.
- **Reservar lote** (por item, em **ações**): informe "Quantidade" e "Lote". Reserva **não é movimento**: as unidades saem do disponível, mas continuam no saldo físico.
- **Marcar como sem estoque**: só para o que foi aprovado e não tem lote elegível (campo "Complemento" opcional). Havendo lote com saldo, o sistema recusa e manda reservar o que houver.
- **Soltar reserva**: motivo obrigatório; o item volta a "Sem estoque".
- **Entregar**: informe "Quantidade", "Lote", "Observação". Se o item exige treinamento e quem recebe não tem, aparece a caixa "Entrego mesmo sem treinamento em vigor".

A entrega do pedido é a mesma do balcão: grava a ficha, baixa o lote e abre a pendência do comprovante. Entrega parcial é possível; o pedido fica "Em atendimento" e vira "Atendida" sozinho quando tudo sai.

**Guia de entrega:** em cada pedido com item aprovado, o botão **Imprimir guia** abre a guia, uma página para imprimir do navegador (botão **Imprimir**) com quem recebe, o que foi decidido, o que falta entregar e linhas de assinatura. A guia **não é a prova de entrega**; a prova é o comprovante da ficha. A impressão fica registrada na auditoria.

---

## 8. Entrega direta no balcão

**Caminho:** Gestão de EPI > **Entregar EPI**. Não exige pedido nem lote.

1. Em "Buscar servidor", digite o SIAPE (nome só aparece a quem lê identificação nominal). Escolha em "Quem recebe".
2. Escolha o "Equipamento". Preencha "Quantidade", "Tamanho", "Data da entrega" (em branco vale hoje) e, se houver, "Observação" (sai impressa no comprovante).
3. **Escolha o "Lote de estoque"** (o CA que vale é o do lote; sem lote, o do catálogo). Se deixar "Sem lote — entrega de balcão", **o estoque não é baixado** e a ficha fica sem lote (ver "Limites conhecidos").
4. Clique em **Registrar entrega**.

**O sistema barra:** CA vencido ("EPI com CA vencido não se entrega"); data futura; lote de outro item; ultrapassar o máximo sem justificativa; falta de treinamento sem confirmação.

**Exceções ao máximo e sem treinamento:** quem entrega pode informar "Justificativa da exceção ao máximo" ou marcar a confirmação de treinamento. Ficam registradas com o nome de quem fez (evento "EPI_SEM_TREINAMENTO_CONFIRMADO"). Como coordenador, **revise essas exceções com regularidade**, pois o balcão não passa por análise.

**Recusa fundamentada:** na mesma tela, seção "Recusa fundamentada" (A quem, Item, Unidade, Motivo, Complemento). Serve para negar fornecimento a quem não é servidor (terceirizado, estudante, bolsista). Fica na trilha e conta em Relatórios > "Recusas por motivo". Não gera documento impresso.

**Cadastro rápido de servidor:** o bloco "Cadastrar servidor agora" (SIAPE de 7 dígitos e Nome, botão "Cadastrar e escolher") só aparece quando a busca não acha ninguém; no balcão vale para quem pode entregar, no pedido para quem pode requisitar. O sistema só confere o formato do SIAPE, não se ele existe. Cargo e lotação se completam depois na ficha.

**Pendências abertas por cada entrega:** comprovante assinado (prazo de 10 dias, dono: almoxarife) e, se o servidor tem adicional ocupacional vigente, "reavaliar adicional por EPI".

---

## 9. Fichas de EPI, devolução, estorno e comunicações

**Caminho:** Gestão de EPI > **Fichas de EPI** (lista) e **Abrir ficha**. Cada abertura da ficha de outra pessoa fica registrada na auditoria, com finalidade.

A lista mostra Servidor, Unidade, Registros, Sem comprovante e a faixa "N entrega(s) sem comprovante assinado".

A linha da ficha é **congelada no ato** (nome, categoria, CA, validade, fabricante, lote, tamanho). Não se altera nem se exclui. **Correção se faz por estorno.**

### 9.1 Comprovante
1. Na linha, clique em **Imprimir**. Sai um arquivo **Word (.docx)**, não PDF, com os dados congelados, termo de responsabilidade e duas linhas de assinatura. Pode ser reimpresso; cada impressão fica na trilha, e se o texto reimpresso divergir da primeira impressão (modelo trocado fora do sistema) a via sai com aviso e o evento "Comprovante de EPI divergente" é registrado. O servidor comum não baixa o arquivo.
2. Colha as assinaturas.
3. Clique em **Anexar** e envie o digitalizado (PDF, PNG ou JPEG; outro tipo é recusado). Mensagem: "Comprovante anexado (SHA-256 …). A entrega está completa."
4. O comprovante **não se troca**. Arquivo errado só se desfaz estornando a entrega (ver abaixo). Confira o arquivo antes de enviar.

### 9.2 Devolução
Em **mais**, escolha devolução. Informe "Quantidade", "Data", "Motivo" e "Por que voltou". Cria uma linha nova de devolução e **o saldo volta ao lote**, sempre que a entrega teve lote e seja qual for o motivo (inclusive "Extraviado" e "Desgaste físico": a unidade é somada ao saldo como se estivesse utilizável). Se não está, use **Descartar** ou **Ajustar** em seguida; oriente o almoxarifado. Data não pode ser futura nem anterior à entrega. A entrega original continua na ficha. A devolução também trata sozinha a comunicação do titular aberta para aquela linha. Confira a quantidade: o sistema limita ao total que a pessoa tem consigo, não à quantidade daquela linha.

### 9.3 Estorno
Em **mais**, escolha **Estornar**, com "Motivo" obrigatório. Nasce uma linha nova apontando para a original; a original continua marcada. **O estorno não devolve saldo ao lote**, porque nada voltou da prateleira. Se a mercadoria não saiu de fato, acerte o saldo depois com **Ajustar**. Não dá para estornar registro que já teve devolução. Depois do estorno a ficha mostra o aviso "O saldo do lote … não foi reposto", com o link "Ajustar o inventário do lote".

### 9.4 Troca devida
Quando a vida útil do catálogo vence sem substituto, devolução ou estorno, a ficha mostra "N item(ns) com troca vencida" e o servidor vê o botão **Pedir troca**. O Painel conta essas trocas no cartão **Trocas devidas**.

### 9.5 Comunicação do titular
O servidor, pelo botão **Comunicar** na própria ficha, informa extravio ou necessidade de troca. A equipe vê no Painel ("Comunicações do titular a tratar") e usa **Tratar**, escrevendo o que foi feito. A comunicação **não altera ficha nem estoque**: devolução e substituição são feitas à parte. Só há uma comunicação aberta por linha. O titular pode **Retirar** em até 24 horas; a equipe, a qualquer tempo. Para tratar, a equipe usa **Tratar** (janela "Tratar a comunicação", campo "O que foi feito", botão **Gravar**).

---

## 10. Relatórios e indicadores

**Caminho:** Gestão de EPI > **Relatórios** (permissão de indicadores).

- Em "Recorte", escolha um Exercício (2026 e anteriores, até 2019) ou Período livre (De, Até) e clique em **Ver**.
- Blocos: Peças entregues, Servidores atendidos, Entregue por EPI, por cargo, por categoria da NR-6, Devoluções e extravios, Recusas por motivo, Entregue por campus e por unidade, Custo por empenho, Recusas por unidade.
- "Cada célula conta servidores atendidos, não peças", com duas exceções: "Recusas por motivo" e "Recusas por unidade" contam negativas (a recusa de balcão entra, porque a contagem sai da trilha de auditoria), e "Custo por empenho" nunca é suprimido. "Extravios" são as devoluções com motivo "Extraviado".
- **Peças entregues** soma as entregas não estornadas; devoluções não abatem (aparecem em "Devoluções e extravios").
- **Custo por empenho:** "—" indica lote sem valor informado; o total é um piso quando há lote sem valor.
- Para quem não vê dados nominais (secretaria), células com menos de 5 servidores aparecem como "—". Coordenação, técnico, engenheiro, médico e superintendente veem tudo.
- Botão **Exportar (CSV)** gera `epi-indicadores-AAAA.csv` (separador ";", UTF-8). Não aparece para a secretaria.
- Erros: "O início do período não pode ser depois do fim."

---

## 11. Prazos, pendências, auditoria e privacidade

**Pendências geradas (sino/"Pendências"):**
| Pendência (como aparece) | Quem cuida | Prazo |
|---|---|---|
| Anexar o comprovante assinado de EPI | Quem tem permissão de entregar (almoxarife) | 10 dias após a entrega |
| Certificado de Aprovação do lote a vencer | Quem tem permissão de entregar | A validade do CA (padrão 60 dias) |
| Tratar a comunicação do titular sobre o EPI | Quem tem permissão de entregar (nasce sem responsável) | 10 dias |
| Item de requisição de EPI esperando estoque | Quem tem permissão de entregar | 30 dias |
| Troca de EPI vencida (vida útil esgotada) | Quem tem permissão de entregar | A previsão de troca (padrão 30 dias) |
| Ler a decisão do seu pedido de EPI / Retirar o EPI reservado para você | Requerente (só aparece se ele tem conta) | 15 dias |
| Reavaliar o adicional após entrega de EPI | Quem trabalha com processos de adicional (permissão de editar processo), não o módulo de EPI | 90 dias; só nasce se o servidor tem adicional ocupacional vigente |

As pendências abrem quando alguém registra algo (entrega, entrada de lote etc.). O sistema **não tem relógio próprio**: ele não "acorda" sozinho para avisar prazos. Por isso a rotina de olhar o Painel é sua.

**E-mails.** Os e-mails do módulo vêm **desligados** por padrão. Se você espera avisos por e-mail, confirme com a TI que estão ativados. Enquanto isso, o acompanhamento é pela tela e pelas pendências.

**Auditoria.** Fica no menu geral do sistema, fora do módulo de EPI: **Auditoria** (permissão de ver a trilha; coordenação e superintendência têm, o técnico de segurança não). Use os filtros **Entidade** (por exemplo `epi_ficha_registro`, `epi_requisicao`, `epi_entrada_estoque`) e **Tipo de evento**. Eventos a revisar: "Máximo de EPI excedido" (exceção ao máximo, com a justificativa e o nome de quem a assinou), "Entrega sem treinamento em vigor confirmada", "Estoque de EPI ajustado", "Lote de EPI descartado", "Registro de EPI estornado" e "Comprovante de EPI divergente". A trilha registra, só com identificadores (protocolo, lote, CA, número do servidor), quem criou, alterou, decidiu, entregou, estornou, recusou e confirmou exceções. Nunca guarda valores de saúde. A leitura nominal (ficha de outra pessoa, pedido com rotina e riscos, impressão da guia) também é registrada, com finalidade.

**Privacidade (LGPD).**
- Nos campos de texto livre, **não escreva diagnóstico, CID, doença, gestação nem CPF**. O sistema recusa vários desses termos, mas o filtro **não é completo**: orientem a equipe a não depender dele.
- Nas telas de EPI **não existe** a caixa "confirmo que a menção é necessária" (ela existe em outros módulos): a mensagem de erro a menciona, mas o texto só é aceito se for reescrito sem o termo. CPF e CID não passam de jeito nenhum.
- A secretaria não vê nome do servidor; a busca não aceita CPF.

---

## 12. Como saber se o módulo está saudável

Faça esta lista de conferência (ideal: uma vez por semana):

- [ ] Faixa **vermelha** do Catálogo: nenhum item ativo com CA vencido ou sem validade.
- [ ] Faixa **amarela** do Catálogo: itens que exigem treinamento têm vínculo.
- [ ] Painel: **Pedidos a analisar** perto de zero e nenhum pedido com "Parado há" alto.
- [ ] Painel: **Itens sem estoque** com compra ou lote a caminho.
- [ ] Estoque: cartão **Presas em lote impedido** zerado ou com plano (corrigir ou descartar).
- [ ] Fichas: "entrega(s) sem comprovante assinado" baixo e sem prazos de 10 dias estourados.
- [ ] Comunicações do titular tratadas.
- [ ] Entregas de balcão com lote informado (compare o Extrato do lote com a contagem física).
- [ ] Exceções ao máximo e "sem treinamento" revisadas na trilha.
- [ ] Relatórios: recusas por motivo coerentes; sem pico de "Outro motivo".

---

## 13. Mensagens comuns e o que fazer

| Mensagem | O que fazer |
|---|---|
| "Item que exige CA precisa do número do CA..." | Informe o número do CA no cadastro |
| "Já existe '<nome>' com esse modelo..." | Informe o modelo que distingue o item |
| "EPI com CA vencido não se entrega" | Lote: o lote fica impedido. Catálogo: atualize o CA do item (precisa da permissão de catálogo) |
| "o lote LT-1 no tamanho M já tem entrada..." | Use **Ajustar** ou informe nota fiscal diferente |
| "o empenho é de 3 e a entrada registra 5..." | Confira a quantidade; receber mais que o empenhado é erro |
| "aprovar zero não é aprovar..." | Recuse com motivo do catálogo |
| "A exceção exige a justificativa por escrito..." | Escreva a justificativa, ela leva o seu nome |
| "ainda há item sem decisão..." | Decida todos os itens antes de concluir |
| "nenhum item foi aprovado..." | Indefira o pedido com motivo |
| "Transição proibida: Recusado → Aprovado..." | Recusado é final. Peça um novo pedido |
| "só fica sem estoque o que foi aprovado" | Existe lote elegível: reserve-o |
| "a reserva é de N … e a entrega pede M: o que passa da reserva não está prometido a este pedido" | Entregue só o reservado, ou reserve o restante antes (se o lote tiver saldo) |
| "está reservado no lote …, e a entrega tem de sair dele" | Entregue do lote reservado, ou solte a reserva com motivo e reserve no lote certo |
| "entregar exige a requisição analisada, e … está em …" | O pedido já foi atendido, cancelado ou ainda não teve a análise concluída |
| "O campo … menciona dado de saúde" / "termo proibido" | Reescreva o texto sem o termo; não há caixa de confirmação nas telas de EPI |
| "motivo do cancelamento é obrigatório" | Escreva o motivo |
| "o registro N já tem comprovante anexado, e o comprovante não se troca..." | Comprovante não se troca; estorne e registre de novo |
| "estornar exige o motivo..." | Escreva o motivo |
| "o registro N já teve X devolvido(s)..." | Corrija com **Ajustar** (contagem e motivo) |
| "A busca não aceita CPF..." | Busque por protocolo, nome, SIAPE ou e-mail |
| "Pedido recusado: veio de outra origem..." | Recarregue a página e tente de novo |

---

## 14. Glossário

- **CA (Certificado de Aprovação):** documento que autoriza o uso do EPI. CA vencido impede a entrega.
- **Lote:** conjunto de unidades de uma mesma compra, com CA e validade próprios.
- **Empenho / pregão:** a compra que trouxe o lote.
- **Reserva:** separar unidades de um lote para um pedido. Não baixa o estoque.
- **Ajuste de inventário:** correção do saldo pela contagem física.
- **Estorno:** anula um registro errado da ficha por meio de uma linha nova; não devolve saldo.
- **Devolução:** equipamento que voltou; devolve saldo ao lote.
- **Ficha de EPI:** o registro de tudo que o servidor recebeu, com dados congelados.
- **Comprovante:** documento assinado de que o servidor recebeu o EPI.
- **Vida útil:** meses até a troca prevista.
- **NR-6:** norma que trata do EPI.
- **Protocolo:** número do pedido, no formato EPI-AAAA-NNNN.
- **Dado nominal:** informação que identifica o servidor.

---

## 15. Limites conhecidos

Estas situações afetam o uso hoje. Planeje a rotina levando-as em conta.

1. **Reabrir pedido indeferido não permite aprovar nada.** "Reabrir para análise" volta o pedido a "Em análise", mas as linhas continuam "Recusado" (estado final). Para atender o servidor, peça um novo pedido.
2. **Lote com dado errado não tem correção.** CA, validade, lote, tamanho, item, quantidade e empenho não se editam, e não existe tela para renovar o CA de um lote. A saída é descartar o lote e dar nova entrada com nota fiscal diferente. Confira tudo antes de gravar.
3. **Entrega de balcão "Sem lote" não baixa o estoque.** É o valor que aparece por padrão. Oriente o almoxarifado a sempre escolher o lote e, se o saldo ficar errado, acerte por **Ajustar**.
4. **Aprovação concluída não se corrige.** Revise antes de concluir; depois, só cancelando a linha ou o pedido.
5. **Comprovante errado não se troca.** Só estornando a entrega, e o estorno não devolve saldo.
6. **Devolução tem como limite o total em poder da pessoa**, não a quantidade da linha de entrega. Confira a quantidade ao registrar.
7. **Ficha e Painel podem divergir em "troca vencida".** A ficha pode continuar acusando troca vencida de uma entrega antiga mesmo depois de entregue o substituto, enquanto o Painel já mostra zero. Para decidir, considere o Painel e confira a ficha.
8. **Exceções no balcão não passam por análise.** Quem entrega pode registrar a exceção ao máximo e a confirmação de falta de treinamento. Revise-as na auditoria.
9. **Análise não é exclusiva** e a regra de "não analisar o próprio pedido" olha o servidor beneficiário. Reforce a prática descrita no item 6.5.
10. **Filtro de saúde em texto livre é incompleto.** Alguns termos passam. Não dependa dele.
11. **Entrega com data antiga** é aceita mesmo antes da entrada do lote. Confira a data digitada.
12. **O cadastro de item aceita CA já vencido** sem aviso na hora. A faixa vermelha do Catálogo mostra depois.
13. **Cadastro rápido de servidor** só confere o formato do SIAPE (7 dígitos). Rascunhos de pedidos de outras pessoas são visíveis, e excluíveis, pela equipe com acesso.
14. **Comprovante sai em Word** e o rodapé ainda traz o nome antigo "Sistema CSSO".
15. **Guia de entrega** não mostra o lote reservado nem a prateleira. A finalidade e o motivo do item se repetem no formulário de pedido.
16. **Algumas mensagens de erro são técnicas ou pouco claras** (por exemplo, a de termo proibido fala em saúde mesmo quando o termo é CPF).
17. **Os e-mails do módulo estão desligados** e não há atualização automática de prazos: o acompanhamento depende da sua rotina no Painel.
18. **Fluxo de devolução à prateleira após estorno:** não há tela própria; use **Ajustar**.
19. **A devolução sempre devolve saldo ao lote**, inclusive com motivo "Extraviado" ou "Desgaste físico", como se o equipamento voltasse utilizável. Oriente o almoxarifado a descartar ou ajustar o lote em seguida.
20. **O aviso de dado de saúde pede uma confirmação que as telas de EPI não oferecem.** O usuário precisa reescrever o texto sem o termo.
21. **O pedido de EPI aceita termos de saúde como "alergia"** e o filtro só recusa uma parte do vocabulário (confirmado em teste): reforce a orientação de não escrever nada clínico.
