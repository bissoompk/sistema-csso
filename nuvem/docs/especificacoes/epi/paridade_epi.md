# Gestão de EPI: mapa de paridade IntegraSST → Sistema SISA e plano de implantação

Data: 22/10/2026. A análise parte dos três inventários do IntegraSST (backend, telas de equipe e portal do servidor) e do inventário do SISA. Conferi no código de `nuvem/` todo item que marquei como "falta" ou "parcial". Não editei nenhum arquivo dos dois projetos.

Caminhos: `L:` = `entrada/integrasst/` (IntegraSST) e `S:` = `nuvem/` (Sistema SISA).

**Resumo.** O SISA já cobre todo o fluxo do IntegraSST e vai além dele: razão de estoque que só recebe lançamentos novos, reserva, lote com CA, comprovante com hash, entrega de balcão e ligação com o adicional ocupacional. Restam **seis lacunas reais**:

1. O titular não tem como comunicar o EPI que está com ele (extravio ou troca por um dos quatro motivos), nem a janela de 24 h.
2. O pedido não tem motivo por item, e o termo NR-06 não é gravado no envio.
3. O catálogo não tem foto nem PDF de orientação.
4. Os relatórios não têm recorte por EPI, por cargo nem por período livre.
5. `exige_treinamento` é gravado e não é conferido em lugar nenhum. Essa lacuna é do SISA, não do legado.
6. Não há e-mail no fluxo do pedido. A recusa foi decidida antes de o SISA ter caixa de saída de e-mail, então pede nova decisão.

---

## 1. Tabela de paridade

### 1.1 Catálogo, estoque e configuração (equipe)

| # | Funcionalidade do IntegraSST (origem) | Status no SISA | Onde está no SISA / o que falta |
|---|---|---|---|
| 1 | Cadastrar/editar EPI (`L:EPI_Backend.js:21-47`) | **existe melhor** | `S:src/rotas/epis.ts:303,530`. Mostra as 9 colunas que o legado escondia (Qtd_Padrao, Qtd_Maxima com janela, Exige_Justificativa, Validade_CA etc.), recusa campo obrigatório vazio e não apaga colunas ao editar (CHANGELOG.md:2139-2147) |
| 2 | Categoria com 10 opções em texto (`L:EPI_Frontend.html:407`) | **recusado de propósito** | Usa as 9 categorias do Anexo I da NR-6 e não aceita uma décima (CHANGELOG.md:2156-2159; `S:src/servicos/sementes.ts:555-645`) |
| 3 | Foto do EPI e PDF de orientação/CA (`L:EPI_Backend.js:5-19`, `L:EPI_Frontend.html:380-464`) | **falta** | O `epi_item` não tem coluna de imagem nem de PDF (conferido). A infraestrutura de anexo já existe e é usada no comprovante → **Fatia C** |
| 4 | Códigos e-Campus e CATMAT | **existe igual** | `epi_item` |
| 5 | Inativar EPI (`L:EPI_Backend.js:49-64`) | **existe melhor** | Campo `ativo` na edição. Lote com CA vencido fica impedido e não some da lista (`S:src/servicos/epi_estoque.ts:171`) |
| 6 | Lista do catálogo com busca (`L:EPI_Frontend.html:305-334`) | **existe igual** | `S:templates/paginas/epis_catalogo.html`, com etiquetas |
| 7 | Ficha técnica do equipamento com anexos (`L:EPI_Frontend.html:336-378`) | **existe parcial** | Os dados estão lá. Faltam os anexos (#3) |
| 8 | Entrada de estoque: pregão, empenho, valor, fornecedor (`L:EPI_Backend.js:94-118`) | **existe melhor** | `S:src/servicos/epi_estoque.ts:602`. Tem também nota fiscal, lote, CA e validade por lote, e confere o dígito verificador do CNPJ |
| 9 | Editar lote sobrescrevendo o saldo | **recusado de propósito** | O saldo vem do razão. O inventário recebe a contagem física (CHANGELOG fatia 3, :2029-2075) |
| 10 | Anular lote sem lançamento compensatório (`L:EPI_Backend.js:120-135`) | **existe melhor** | Inativação exige motivo e solta as reservas (`S:src/rotas/epi_estoque.ts:283`) |
| 11 | Lista de entradas e saldos (`L:EPI_Backend.js:137-192`) | **existe melhor** | `/epis/estoque` (físico, reservado e disponível) e o extrato de cada lote |
| 12 | Pastas do Drive públicas por link (`L:Core.js:521-565`) | **recusado de propósito** | Os arquivos ficam no Storage, atrás de rota com login. É o mesmo desvio adotado em Certificados (DESVIOS.md:946+) |
| 13 | Permissões MOD_EPI_* conferidas só no navegador (`L:Core.js:567-654`) | **existe melhor** | 7 permissões conferidas no servidor (`S:src/servicos/rbac.ts:101-145`), mais escopo por campus |
| 14 | doPost sem autenticação (`L:Router.js:4-38`) | **recusado de propósito** | `/api/v1/epis/*` segue as mesmas regras da tela |

### 1.2 Pedido, análise e entrega

| # | Funcionalidade do IntegraSST (origem) | Status no SISA | Onde está no SISA / o que falta |
|---|---|---|---|
| 15 | Protocolo EPI-AAAA-NNNN tirado de getLastRow (`L:EPI_Backend.js:273-359`) | **existe melhor** | Sequência por ano, consumida no envio, testada com 50 envios simultâneos (`S:src/servicos/epi_requisicao.ts:915-964`) |
| 16 | Campus e lotação preenchidos pelo cadastro (`L:EPI_Backend.js:1196-1223`) | **existe melhor** | Fica congelado no envio |
| 17 | Local de trabalho, chefia, atividades e riscos | **existe igual** | Posto, chefia, `descricao_atividade` e riscos declarados. CPF e CID são recusados (RN-21) |
| 18 | Finalidade e urgência fixas no navegador | **existe melhor** | `finalidade` e urgência com justificativa |
| 19 | **Motivo por item** (uso inicial, desgaste, dano, extravio) (`L:EPI_Frontend.html:686-724`) | **existe parcial** | No SISA a finalidade é do pedido inteiro (`S:src/db/esquema/epi.ts:458`), e o item só tem `justificativa` → **Fatia B** |
| 20 | **Termo NR-06 marcado no envio** (`L:EPI_Frontend.html:727-732`) | **existe parcial** | O termo só aparece no comprovante .docx assinado na entrega. Não há aceite no pedido, e o legado também não gravava o aceite → **Fatia B** |
| 21 | Mesmo item duas vezes, sem quantidade máxima | **existe melhor** | Restrição `uq_req_item` no banco e RN-26 |
| 22 | E-mail ao SESMT e ao requerente na abertura (`L:EPI_Backend.js:319-356`) | **recusado de propósito (rever)** | CHANGELOG.md:852-870 (versão 1.36.0, 04/09): os avisos ficam só no sino. A caixa de saída de e-mail (`email_saida`) chegou depois, em 20/10 (DESVIOS.md:946+) → **Decisão 1 / Fatia F** |
| 23 | E-mail da decisão com instruções de retirada (`L:EPI_Backend.js:724-798`) | **existe parcial (sino)** | Pendências `EPI_DECISAO_A_LER` e `EPI_RETIRADA_DISPONIVEL` |
| 24 | E-mail de entrega concluída | **recusado de propósito** | CHANGELOG.md:860-862 |
| 25 | Texto fixo do local de retirada | **recusado de propósito** | Parâmetro `CSSO_EPI_LOCAL_RETIRADA` (`S:src/config.ts:140`) |
| 26 | "Minhas requisições" casadas por trecho de texto (`L:EPI_Backend.js:415-504`) | **existe melhor** | Escopo próprio, ligado ao servidor, sem vazar pedidos de outros |
| 27 | Fila do gestor sem escopo | **existe melhor** | Escopo por campus, filtro por estado e prazo |
| 28 | Busca da fila que promete CPF | **existe melhor** | `S:src/rotas/epi_requisicoes.ts:365-419` recusa CPF e explica por quê |
| 29 | Selo de pendentes no menu e no cartão (`L:Core.js:656-686`) | **existe parcial / recusado em parte** | O painel `/epis` conta os pedidos por estado. A contagem no menu foi recusada em DESVIOS (Menu de Certificados, 22/10) → **Fatia G** |
| 30 | CPF completo exibido ao gestor | **existe melhor** | Sem CPF, e a leitura nominal fica registrada |
| 31 | Análise item a item (`L:EPI_Backend.js:662-801`) | **existe melhor** | Aprovar, recusar, sem estoque, reservar e aprovar tudo (`S:src/rotas/epi_requisicoes.ts:1138-1246`) |
| 32 | Recusa em texto livre | **recusado de propósito** | Catálogo de motivos (RN-27, CHANGELOG.md:2161-2167) |
| 33 | Estado "Liberada para entrega" | **recusado de propósito** | CHANGELOG fatia 4 (:1876-1928) |
| 34 | "Aguardando estoque" nunca reprocessado | **existe melhor** | Pendência `EPI_SEM_ESTOQUE`, e a entrada de lote avisa quantos itens esperam |
| 35 | Reanálise e reabertura | **existe melhor** | Reconsiderar, devolver e cancelar. Quem pede não analisa o próprio pedido (RN-28) |
| 36 | Cancelamento pelo servidor | **existe melhor** | `pode_cancelar` |
| 37 | Baixa que deixava passar estoque insuficiente (`L:EPI_Backend.js:803-924`) | **existe melhor** | Entrega por item, com trava contra concorrência e conferência do CA do lote (RN-25) |
| 38 | Guia de retirada com linha de assinatura | **existe melhor** | `/guia` com Separou, Conferiu e Data. A assinatura do servidor fica no comprovante (`S:templates/paginas/epis_requisicao_guia.html:120-145`) |
| 39 | Gestor com MOD_EPI_ADMIN não pede EPI para si | **existe melhor** | `PERMISSOES_DO_TITULAR` (D16, 22/10) |

### 1.3 Ficha, situação de uso e relatórios

| # | Funcionalidade do IntegraSST (origem) | Status no SISA | Onde está no SISA / o que falta |
|---|---|---|---|
| 40 | Lista de fichas que incluía quem só teve aprovação | **existe melhor** | Só entra quem recebeu EPI, e a lista mostra os comprovantes que faltam |
| 41 | CA lido do catálogo atual na ficha | **recusado de propósito** | Fica congelado na entrega, e vale o CA do lote (CHANGELOG fatia 2) |
| 42 | Termo de Responsabilidade e Guarda na ficha | **existe melhor** | No comprovante .docx assinado. A ficha imprime |
| 43 | "Minha ficha" | **existe melhor** | `/epis/fichas/minha`, com o botão "Pedir troca" |
| 44 | Baixar o PDF de orientação na ficha (`L:EPI_Frontend.html:973`) | **falta** | Depende do #3 → **Fatia C** |
| 45 | **Situação de uso**: Extraviado e Troca por desgaste, tempo de uso, perda de eficácia ou alterações no trabalho (`L:EPI_Frontend.html:976-1005`, `L:EPI_Backend.js:1077-1108`) | **existe parcial** | A equipe registra a devolução com motivo em texto livre (`S:src/servicos/epi_ficha.ts:1007-1030`). O titular não consegue comunicar um extravio nem dizer por que quer trocar → **Fatia A** |
| 46 | Trava de 24 h para o titular, só no navegador | **falta (forma nova)** | Vira uma janela de 24 h em que o titular pode retirar a comunicação, conferida no servidor → **Fatia A** |
| 47 | Devolução não voltava ao estoque | **existe melhor** | A devolução gera o lançamento DEVOLUCAO |
| 48 | Relatório por período | **existe parcial** | A tela só recorta por exercício (`S:src/rotas/epi_indicadores.ts:191-195`). O serviço já aceita `inicio` e `fim` → **Fatia D** |
| 49 | Indicador com o total entregue | **existe parcial** | Só aparece no painel, para o mês → **Fatia D** |
| 50 | Ranking **por EPI** | **falta** | O relatório só agrupa por categoria (`S:src/servicos/epi_indicadores.ts:344`) → **Fatia D** |
| 51 | Distribuição **por perfil/vínculo** | **falta** | → **Fatia D**, usando `cargo_snapshot` |
| 52 | Distribuição por campus | **existe melhor** | Campus e unidade, com supressão de contagens pequenas (RN-19) |
| 53 | Data de reserva que lia a coluna errada | **existe melhor** | Usa a data do registro da ficha |

---

## 2. O que o SISA tem e o IntegraSST não tinha

- **Estoque**
  - Razão que só recebe lançamentos novos, com saldo físico, reservado e disponível.
  - Inventário pela contagem física, descarte com motivo e extrato por lote.
  - Lote com seu próprio CA e validade, e com nota fiscal.
- **Entrega e ficha**
  - Entrega de balcão sem pedido, com cadastro de servidor na hora.
  - Tamanhos e vida útil, com cobrança da troca vencida (RN-32).
  - Quantidade máxima por período, com exceção assinada (RN-26).
  - Comprovante .docx com hash, e o papel assinado digitalizado com SHA-256.
  - Estorno separado de devolução, e leitura nominal da ficha registrada.
- **Pedido**
  - Reserva com trava contra concorrência; reconsiderar, devolver, cancelar e indeferir.
  - Quem pede não analisa o próprio pedido (RN-28).
  - Catálogo de motivos de recusa com base normativa, e recusa fundamentada para terceirizado.
- **Avisos e indicadores**
  - Sino com CA a vencer, troca vencida (varredura toda noite às 03h45) e falta de estoque.
  - Custo por empenho, recusas por motivo e por unidade, exportação CSV e supressão de contagens pequenas.
- **Integração e acesso**
  - Ligação com o adicional ocupacional, sem escrever em `adicional_vigencia`.
  - API e tela de celular para o balcão, e painel pessoal do titular.
  - Perfis separados (almoxarife, analista, catálogo) e escopo por campus.

---

## 3. Fatias de implantação, em ordem de valor

**Regras para todas as fatias**

- **Migração.** A última no disco é a `0012`. As fatias A, B, C e E alteram `S:src/db/esquema/epi.ts`. Se rodarem em paralelo, um integrador junta tudo numa `0013_epi_paridade.sql` (ou numera em série) para não haver conflito no `_journal.json`.
- **Arquivos já em edição.** O working tree tem mudanças de outros agentes, ainda sem commit, em `rbac.ts`, `modulos.ts`, `sementes.ts`, `epi_requisicoes.ts` e `epi_indicadores.ts`. Releia antes de editar.
- **Níveis de acesso.**
  - **Consulta** = `epi.ver` e a própria ficha.
  - **Operação** = `epi.requisitar`, `entregar`, `estoque`, `catalogo`, `analisar` e `ficha`.
  - `epi.analisar` e `epi.ficha` continuam presas a perfis técnicos, mesmo quando outro setor recebe o nível "operação".

### Fatia A: o titular comunica o EPI que está com ele (extravio ou troca)

- **O que faz.** Em "Minha ficha", cada entrega vigente ganha a ação "Comunicar", com as opções Extraviado / Troca por desgaste físico / tempo de uso / perda de eficácia / alterações no trabalho. A comunicação:
  - abre pendência para o almoxarifado;
  - oferece um pedido de troca já preenchido;
  - pode ser retirada pelo titular em até 24 h. Depois disso, só a equipe altera.
- **Regras de origem.**
  - As situações: `L:EPI_Frontend.html:976-1005`.
  - A data da alteração: `L:EPI_Backend.js:1077-1108`. No SISA vira `retirada_em`, e nada se apaga.
  - A trava de 24 h: `L:EPI_Frontend.html:976-989`. No SISA ela é conferida no servidor, que também confere se o EPI é de quem comunica.
  - A comunicação não volta saldo ao estoque e não altera a ficha. A devolução física continua sendo ato da equipe.
- **Esquema.**
  - Nova tabela `epi_comunicacao_titular`, com `registro_id`, `servidor_id`, `tipo` (lista de 5), `observacao`, quem e quando criou, retirou e tratou, e `requisicao_id`.
  - Em `epi_ficha_registro`, a coluna `motivo_codigo` (a mesma lista mais DESLIGAMENTO e OUTRO). Como é coluna de conteúdo, precisa entrar na lista da trigger em `S:src/db/travas.sql:153-211` e no teste `S:src/db/travas.ts:56-61`.
- **Pendência.** `EPI_COMUNICACAO_A_TRATAR`, prazo de 10 dias, concluída com `epi.entregar`.
- **Rotas.**
  - `POST /epis/fichas/registros/{id}/comunicar` e `POST /epis/comunicacoes/{id}/retirar`.
  - Ação "Tratar" na ficha da equipe e contagem no painel.
  - O pedido de troca já sai preenchido: `/epis/requisicoes/nova?item=&finalidade=`.
- **Permissões.** O titular comunica. `epi.entregar` trata. `epi.ficha` vê a comunicação de outra pessoa.
- **Testes.**
  - Outra pessoa recebe 403.
  - Retirar a comunicação funciona com menos de 24 h e é recusado depois.
  - A equipe consegue alterar depois de 24 h.
  - Comunicar um registro estornado ou já devolvido é recusado.
  - A pendência abre e fecha.
  - A trigger recusa UPDATE em `motivo_codigo`.
- **Riscos.** "Extraviado" pode ter efeito disciplinar, então o texto precisa ser neutro (Decisão 5).

### Fatia B: motivo por item e termo NR-06 gravado no envio

- **Regras de origem.**
  - Os motivos: `L:EPI_Frontend.html:686-724` e `:1154-1165`.
  - O texto do termo: `L:EPI_Frontend.html:727-732`. O legado não gravava o aceite; aqui ele é gravado.
- **Esquema.**
  - `epi_requisicao_item.motivo`, com os pedidos antigos preenchidos pela finalidade do pedido: PRIMEIRA_ENTREGA → USO_INICIAL, DANO → DANO, PERDA → PERDA, ROTINA e SUBSTITUICAO → DESGASTE.
  - `epi_requisicao.termo_aceito_em`, `termo_aceito_por` e `termo_versao`, com CHECK só para pedidos novos.
  - O texto do termo fica versionado em `S:src/dominio/epi.ts`.
- **Rotas.**
  - Campo de motivo nas rotas de item.
  - Caixa de marcação no `POST /{id}/enviar` (`S:src/servicos/epi_requisicao.ts:915`).
  - O motivo aparece na ficha do pedido, na guia e na análise.
  - A finalidade do pedido continua existindo, para não quebrar os indicadores.
- **Permissões.** `epi.requisitar` (Decisão 3).
- **Testes.**
  - Envio sem termo é recusado.
  - O sistema grava a conta e a versão do termo.
  - Item sem motivo é recusado.
  - A migração preenche os pedidos antigos.
  - É preciso ajustar `epi_requisicao.test.ts` e `epi_menos_passos.test.ts`.
- **Riscos.** Um clique a mais vai contra a fatia "menos passos", e o termo não pode vir marcado de saída. Há conflito com edições em andamento em `epi_requisicoes.ts`.

### Fatia C: foto e PDF de orientação no catálogo

- **Regras de origem.** `L:EPI_Frontend.html:380-464` e `:1038-1058` (o anexo atual fica mantido se nada novo for enviado); `L:EPI_Backend.js:5-47`; o botão na ficha em `L:EPI_Frontend.html:973`. O link público do legado não deve ser trazido.
- **Esquema.**
  - `epi_item.imagem_anexo_id` e `orientacao_anexo_id`, com chave para `anexo`.
  - Nova categoria `EPI_CATALOGO` em `CATEGORIAS_ANEXO` (`S:src/dominio/auditoria.ts`) e no CHECK `ck_anexo_cat`.
  - Se a versão do PDF for congelada na entrega (Decisão 4), a ficha precisa de coluna própria, que entra na trigger.
- **Rotas.**
  - `POST /epis/catalogo/{id}/anexos`, conferindo os bytes como em `S:src/servicos/epi_ficha.ts:1202`.
  - `GET /epis/catalogo/{id}/imagem` e `GET /epis/catalogo/{id}/orientacao`.
  - Miniatura em `epi_requisicao_opcoes.html` e link em `epis_ficha.html`.
- **Permissões.** Envio com `epi.catalogo`. Leitura com `epi.ver` ou para o titular.
- **Testes.**
  - Arquivo com tipo trocado é recusado, e há tamanho máximo.
  - Uma ficha antiga continua apontando para o anexo antigo.
  - Quem não tem acesso recebe 403.
- **Riscos.** Limite de tamanho do corpo na função Netlify, custo de Storage e direito autoral de imagens de fabricante.

### Fatia D: indicadores por EPI, por cargo e por período livre (nenhum arquivo compartilhado)

- **Regras de origem.** `L:EPI_Backend.js:1110-1194` e `L:EPI_Frontend.html:1313-1339`: período padrão, soma das quantidades e rankings em ordem decrescente. Não trazer a data reserva que lia USER_ID, nem a regra de deixar passar item sem data.
- **Esquema.** Nenhum. Usa `nome_epi_snapshot`, `cargo_snapshot` e `quantidade` da ficha.
- **Rotas.**
  - `GET /epis/relatorios?inicio=&fim=`, mantendo `exercicio`; valida que `inicio` não passa de `fim` e limita a 5 anos.
  - Blocos novos em `epis_relatorios.html` e no CSV de exportação.
- **Permissões.** `indicador.ver`, mais `exportar` para o CSV, com supressão RN-19 abaixo de 5 pessoas.
- **Testes.** Período livre; `inicio` maior que `fim` devolve 422; ordenação; cargo com menos de 5 pessoas suprimido; estornos fora da contagem; CSV.
- **Riscos.** Um cargo raro pode identificar a pessoa; a supressão resolve.

### Fatia E: `exige_treinamento` passa a valer, ligado a Certificados (lacuna do SISA)

- **Situação hoje.** O campo existe na tela (`S:templates/paginas/epis_catalogo.html:129`; `S:src/rotas/epis.ts:99,198`), mas nenhum serviço o confere. É o problema que a CHANGELOG.md:2141-2146 aponta no legado: uma regra que ninguém vê não funciona como regra.
- **Esquema.** Tabela `epi_item_treinamento (epi_item_id, treinamento_id)`.
- **Telas.**
  - Escolha do treinamento no catálogo.
  - Etiqueta "sem treinamento em vigor" na análise e na entrega, em `S:src/servicos/epi_ficha.ts:523`, consultando `S:src/servicos/reciclagem.ts`.
- **Comportamento.** Aviso com confirmação gravada. A recusa continua possível pelo motivo `SEM_TREINAMENTO` (Decisão 2).
- **Permissões.** `epi.catalogo` configura. A equipe de EPI vê só se a pessoa tem ou não certificado em vigor, nunca o certificado.

### Fatia F (depende da Decisão 1): e-mail

- **O que faz.** Usa `S:src/servicos/email.ts`:
  - avisa o setor quando chega pedido, num endereço configurável (`CSSO_EPI_EMAIL_SETOR`);
  - repete por e-mail ao requerente os dois avisos do sino, desligado por padrão.
- **Regras de origem.** `L:EPI_Backend.js:319-356` e `:750-798`. Não trazer o HTML sem escape nem a falha silenciosa. O e-mail não leva o texto da recusa.

### Fatia G (opcional): contagem de pedidos a analisar

- **O que faz.** Mostra a contagem no painel `/epis` e no Início de quem tem `epi.analisar`. Não vai para o menu, que foi recusado em DESVIOS (22/10).
- **Origem.** `L:Core.js:656-686`.

### O que pode rodar em paralelo

- **D** pode ir junto com qualquer outra, porque não divide arquivos.
- **A, C e E** têm rotas próprias, mas dividem `esquema/epi.ts` e a migração. A e C também dividem `epis_ficha.html`. É preciso juntar o esquema primeiro.
- **B** é independente de A, C e D, a não ser pelo esquema.
- **F** vem depois de B, e **G** depois de D.

Ordem sugerida: **D + A**, depois **B + C**, depois **E**, e por fim **F/G**, conforme as decisões abaixo.

---

## 4. Decisões que preciso de você

1. **E-mail no EPI?** O e-mail foi recusado na versão 1.36.0, antes de o SISA ter caixa de saída.
   **Recomendo:** um e-mail ao setor, em endereço configurável, quando chega pedido. Para o requerente, só a repetição de "decisão a ler" e "retirada disponível", desligada por padrão. Nada na entrega.
2. **`exige_treinamento`: avisar ou bloquear?**
   **Recomendo:** avisar com confirmação gravada, sem bloquear. Negar o EPI deixaria a pessoa exposta.
3. **Termo NR-06 quando outra pessoa faz o pedido.**
   **Recomendo:** quem envia declara que as informações são verdadeiras. O termo de guarda continua do titular, assinado no comprovante da entrega.
4. **Congelar a versão do PDF de orientação na entrega?**
   **Recomendo:** sim. Anexo nunca é substituído, e a ficha mostra o que valia na data da entrega (RN-15).
5. **Efeito de "Extraviado" comunicado pelo titular.**
   **Recomendo:** só registrar e abrir pendência, sem cobrança automática. Nos indicadores, extravio e devolução aparecem como contagens próprias.

O mesmo conteúdo está salvo em `/tmp/claude-1000/-home-fabricio-projetos-ufvjm-sistema-csso/6e533084-0d01-4788-b6c2-d68106604be4/scratchpad/paridade_epi.md`.