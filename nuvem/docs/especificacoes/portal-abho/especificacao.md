# Meu espaço do titular no SISA, com referência na área de membros da ABHO

Este documento especifica como adaptar ao SISA o que funciona na área de membros da ABHO. Ele trata da tela que o servidor comum (escopo próprio) vê e é complementado por:

- protótipo estático: `prototipo.html`, no mesmo diretório;
- capturas de referência: `01-…07-*.jpg` (ABHO) e `sisa-*.png` (estado atual).

As capturas da ABHO têm dados pessoais. Elas serviram só como referência visual, e todos os dados do protótipo são fictícios.

**Princípios:**
- **Um olhar responde três perguntas:** quem sou, como estou e o que preciso fazer.
- **O cartão lê do congelado.** Ele mostra o que está impresso no papel (RN-15), e não a tabela viva.
- **Nome só para quem pode ver (RN-19).** O titular vê os próprios dados. Ninguém vê o nome de operadores ou de outras pessoas na atividade dele.
- **CSP estrita.** Nada de `style`/`script` inline: classes em `tema.css`, recolher com `<details>` e copiar link com o JS já existente em arquivo.
- **Celular primeiro.** As grades viram uma coluna e a área de toque tem no mínimo 44px.
- **Uma janela única de "a vencer".** Criar `JANELA_A_VENCER_DIAS = 60` em `src/dominio/treinamento.ts`. Ela substitui os 60 de `certificados.ts`, os 90 de `painel.ts` e os 30 de `DIAS_AVISO_RECICLAGEM`; este último continua existindo só para o e-mail.

---

## 1. Menu do Meu espaço

**Hoje:** lateral escura com 9 itens. Não tem cartão de identidade, nem "Minha conta" ou "Sair" no menu. O "Início" exige `processo.ver`.

**Proposta, no topo da lateral (`templates/base.html`, ramo `meu_espaco`):**

### Cartão de identificação
Degradê de `--lateral` (#0a2a5c) para `--acento` (#0058a3) e o símbolo SISA translúcido em marca d'água, aplicado por classe CSS. O cartão mostra:
- **Avatar** com as iniciais em círculo de 44px (ciano #1a96c0 com texto branco grande e negrito; ciano com texto pequeno não passa no contraste). Não há foto, e não vamos criar coluna para isso.
- **Nome** em uma linha, cortado com reticências, e o nome completo no `title`.
- **Linha de lotação:** "Sigla da unidade · Campus" em 12px.

### Itens, em grupos com subtítulo pequeno

| Grupo | Item | Rota | Permissão |
|---|---|---|---|
| (sem título) | Início | `/` | **titular** (nova regra, ver abaixo) |
| Treinamentos | Meus treinamentos | `/turmas/minhas` | treinamento.ver |
| | Meus certificados | `/certificados/meus` | treinamento.ver |
| | Comprovante de treinamentos | `/certificados/meus/comprovante` | treinamento.ver (fase 3) |
| EPI | Minha ficha de EPI | `/epis/fichas/minha` | epi.ver |
| | Meus pedidos de EPI | `/epis/requisicoes` | epi.ver |
| | Pedir EPI | `/epis/requisicoes/nova` | epi.requisitar |
| Adicional | Meu adicional | `/adicionais` | processo.ver |
| | Meus processos | `/processos` | processo.ver |
| Eu | Minha atividade | `/minha-atividade` | titular |
| | Meu perfil | `/minha-conta` | titular (decisão já tomada) |

"Meus dados" (`/servidores/{id}`) deixa o menu. Os dados funcionais passam a ser uma seção de **Meu perfil**, e a ficha continua acessível por link a partir dela.

### Sair
"Sair" fica no pé da lista, depois de um divisor, em vermelho (`--erro`) com ícone. O link continua levando à tela `sair.html`, que faz POST com CSRF.

### Permissão "titular"
É uma condição nova em `Item`: `usuario.servidor_id !== null`, sem permissão de catálogo. Isso entra junto com as "permissões do titular para qualquer conta vinculada a servidor", que já estão decididas. Assim o Início deixa de sumir para quem não tem `processo.ver`.

### No celular
O cartão de identificação fica compacto (só avatar e nome) no topo da gaveta "Menu", que já existe. Os itens mantêm 44px de altura.

### Acessibilidade
- `<nav aria-label="Meu espaço">`;
- `aria-current="page"` no item ativo;
- o item ativo é marcado pelo fio ciano à esquerda (forma), e não só pela cor;
- as iniciais levam `aria-hidden`.

### Diferenças em relação à ABHO
- Iniciais no lugar da foto, sem lápis sobre o avatar.
- Os itens comerciais (Pedidos pagos, Anuidade, Carteirinha de membro) são trocados pelo que o servidor tem.
- Agrupamento por assunto, porque são 11 itens contra 8 na ABHO.

---

## 2. Painel do titular (Início)

**Rota:** `/` (`src/rotas/painel.ts`, `inicio_do_servidor`). **Template:** `painel.html`, no bloco do servidor. **Permissão:** titular.

### 2.1 Boas-vindas
- **Visual:** cartão azul em degradê com o símbolo SISA translúcido à direita (classe `.boas-vindas::after` com o PNG estático).
- **Saudação:** "Olá, {primeiro nome}!". A frase de apoio é "Aqui estão seus treinamentos, certificados, EPI e pedidos."
- **Chips** (pílulas translúcidas com borda clara e ícone):
  - lotação (sigla e nome curto);
  - cargo;
  - campus;
  - "Último acesso dd/mm/aaaa hh:mm", que vem de `usuario.ultimo_login_em`, do acesso anterior.
- **Fonte dos dados:** `servidor` (nome, cargo, unidade → `unidade_uorg`, campus) e `usuario.ultimo_login_em`.
- **Mudança de esquema:** nenhuma.
- **Privacidade:** não mostrar SIAPE nem CPF. O SIAPE fica em Meu perfil.

### 2.2 Avisos por severidade
Aparecem só quando existe algo, em caixas com borda à esquerda, ícone e título, com um link de ação:
- **vermelho:** certificado de NR vencido e "EPI com troca vencida" (RN-32, que já existe);
- **amarelo:** certificado que vence em até 60 dias, com o link "Ver turmas de reciclagem";
- **azul:** inscrição confirmada em turma que começa nos próximos 7 dias.

**Fonte:** `reciclagem.monitor`, `pendencias.ts` e `epi_ficha.linha_do_tempo()`.

**Acessibilidade:** `role="status"`; os vermelhos usam `role="alert"` só quando surgem na tela.

### 2.3 Cartões de status (4)
Cada cartão tem ícone num quadrado pastel, rótulo em maiúsculas, número grande e um link com seta.

| Rótulo | Valor | Contexto e link | Fonte | Falta |
|---|---|---|---|---|
| CERTIFICADOS VÁLIDOS | N em vigor | "Ver certificados →" | nova `em_vigor(servidor_id)` em `servicos/emissao_certificado.ts`, extraída de `reciclagem.monitor` | a função |
| A VENCER | N (em 60 dias) | "Próximo: NR-35 em 14/12/2026" | `em_vigor` + janela única | constante única |
| INSCRIÇÕES ABERTAS | N turmas abertas para você | "Ver turmas →" (e "Você está inscrito em M") | `turma.turmas_abertas()` e `inscricoes_do_titular()` | só a contagem |
| EPI | N pedidos em aberto | "Trocas vencidas: K" ou "Ver ficha →" | `epi_requisicao` por `estado`; trocas RN-32 | contagem por estado |

Os cartões atuais "Meu adicional" e "Meus processos" ficam como um 5º e 6º cartão, ou na seção de atalhos, quando a conta tem `processo.ver`.

**Celular:** grade 2×2 a partir de 390px (o número cabe) e 1 coluna abaixo de 360px.

### 2.4 Últimos certificados
Mostra os 2 mais recentes no mesmo formato da seção 3, com o link "Todos os certificados (N) →". Não existe na ABHO e serve de vitrine da função principal.

### 2.5 Atalhos
Grade de 3 colunas (1 no celular), cada atalho com ícone, título e descrição de uma linha:
- Meus treinamentos — "Inscrições e turmas abertas";
- Meus certificados — "Baixar e validar";
- Minha ficha de EPI — "O que você recebeu";
- Pedir EPI — "Novo pedido ao SESMT";
- Minha atividade — "Tudo o que aconteceu";
- Meu perfil — "Contato, senha e sessões".

Os atalhos seguem as mesmas permissões dos itens do menu.

### Diferenças em relação à ABHO
- Não há bloco "Acesso exclusivo" nem botão de WhatsApp.
- Os cartões de status são de SST e servem para tomar ação, e não de associação ou pagamento.
- O número de matrícula não aparece no topo.

---

## 3. Meus certificados em cartões (referência principal)

**Rota:** `/certificados/meus` (`src/rotas/certificados.ts:344`). **Template:** `certificados_meus.html`. **Busca:** `consulta_do_titular`. **Permissão:** `treinamento.ver` e titular.

### 3.1 Cabeçalho
- Ícone num quadrado azul-claro e o título "Meus certificados".
- Subtítulo: **"N certificados emitidos · X h de capacitação"**. X é a soma de `carga_horaria` do congelado dos EMITIDOS. Essa soma serve para a progressão por capacitação.
- O ícone (i) da LGPD (art. 18, II), que já existe, continua.

### 3.2 Filtros
São links GET, sem JS, para que a URL guarde o filtro:
- **Situação:** pílulas `Todos (N) · Válidos (N) · A vencer (N) · Vencidos (N)`, por `?situacao=`. O ativo é sólido `--acento` com texto branco e `aria-current="true"`.
- **Ano:** `<select name="ano">` com os anos que existem, mais o botão "Filtrar". Com 6 itens ou menos, o seletor não aparece.
- **Busca por nome:** só a partir de 12 certificados.
- **Contagem por situação:** vem de `Certificado.situacao_publica` (VÁLIDO/VENCIDO), e "a vencer" é VÁLIDO com vencimento em até 60 dias. A contagem é feita no servidor, uma consulta por titular. O volume é pequeno.
- **Celular:** as pílulas ficam numa faixa com rolagem horizontal (`overflow-x:auto`) e o seletor de ano vai para a linha de baixo.

### 3.3 Agrupamento
Com mais de 6 itens, a lista é dividida por ano de conclusão, com o cabeçalho "2026 · 4 certificados". A ordem é a data de término, da mais recente para a mais antiga.

### 3.4 Cartão
Grade de 2 colunas a partir de 720px; abaixo disso, 1 coluna. Os campos, de cima para baixo:

1. **Selos.**
   - **Situação:**
     - "Válido" (verde #2f6b17 sobre verde-claro);
     - "Vence em N dias" (âmbar escuro sobre amarelo-claro);
     - "Vencido" (vermelho sobre rosa);
     - "Validade indeterminada" (cinza).
     - Texto de apoio: ícone e palavra, nunca só a cor.
   - **Norma:** "NR-35", vindo de `treinamento_norma`, em ciano sobre azul-claro.
   - **Superado:** "Substituído pela reciclagem", em cinza, quando `em_vigor` aponta outro certificado do mesmo treinamento. Esse cartão perde o destaque de "vencido", porque a pessoa já fez a reciclagem.
2. **Título.** `treinamento_nome`, congelado, em 15px e peso 600, com até 2 linhas e o restante com reticências (o título completo fica no `title`). A caixa é preservada.
3. **Setor promotor.** `turma_unidade_promotora` congelado. Se faltar, vem de `inscricao → turma.unidade_promotora_id`. Cinza, 13px.
4. **Metadados.** Ícones e texto, em 13px; os 11px da ABHO são pequenos demais para quem está no campo:
   - período: `turma_data_inicio`–`turma_data_fim`, no formato "17, 18 e 19/08/2026" (helper novo `periodo_curto` em `datas_br`);
   - carga horária: "16 h" (`carga_horaria`);
   - "Emitido em dd/mm/aaaa" (`data_emissao`);
   - "Válido até dd/mm/aaaa" (`data_vencimento`) ou "Sem prazo de validade".
   - Número do certificado (`C.rotulo()`) em cinza fraco no rodapé do cartão.
5. **Ações** (todas com 44px de altura no celular):
   - **principal, sólida:** "Baixar certificado" → `GET /certificados/:id/pdf`. Quando o certificado é `so_word`, o rótulo vira "Baixar certificado (Word)";
   - **secundária, contornada:** "Conteúdo programático", só quando `treinamento_conteudo` congelado não está vazio. Abre um `<details>` no próprio cartão com a lista de tópicos. Na fase 2 ganha também a rota `GET /certificados/:id/conteudo.pdf`, que gera só o verso a partir do congelado;
   - **terciária, link:** "Validar" → menu `<details>` com o código `chave_validacao` em fonte mono, "Copiar link" (botão do JS de cópia em arquivo, que já existe) e o QR (`qr_png()` como data URI, que a CSP já permite);
   - **condicional, contornada em âmbar:** "Inscrever-se na reciclagem", quando a situação é "a vencer" ou "vencido" e o certificado não foi superado. Leva a `/turmas/minhas?treinamento={id}#abertas`. Se não houver turma aberta, o texto é "Sem turma aberta de reciclagem. Avisaremos por e-mail."
6. **Anulados.** Continuam na seção recolhida, que já existe, abaixo da grade, com cartão cinza e o selo "Anulado → substituído por Nº …".

### 3.5 Estados vazios
- **Nenhum certificado:** ícone de medalha, a frase "Você ainda não tem certificados emitidos." e o texto "Quando você concluir um treinamento, o certificado aparece aqui." Botão "Ver turmas abertas".
- **Em emissão:** inscrição APROVADA sem certificado gera um cartão cinza com o selo "Em emissão" e sem botões. O texto é "A equipe do {setor promotor} está emitindo o seu certificado." Fonte: `inscricoes_do_titular()` com aprovado e sem certificado.
- **Filtro sem resultado:** "Nenhum certificado vencido. Ótimo!" e o link "Ver todos".
- **Conta sem servidor:** mantém o texto que já existe.

### 3.6 Acessibilidade
- Cada cartão é um `<article aria-labelledby="titulo-{id}">`.
- Os botões levam o nome do curso para o leitor de tela: `aria-label="Baixar certificado de NR-35 Trabalho em altura"`.
- As datas usam `<time datetime>`.
- A grade é uma lista (`<ul role="list">`).

### 3.7 Participante sem conta
Na rota `/certificados/acesso`, com o link do e-mail, entram os mesmos cartões, sem lateral, filtros nem "Inscrever-se". `ItemDoTitular` em `acesso_participante.ts` ganha `carga_horaria`, `setor_promotor`, `chave_validacao` e `conteudo`, todos tirados do congelado. Nunca entram `instrutores[].cpf` nem o CPF do titular.

### 3.8 Ficha do certificado para o titular
`/certificados/{id}`, quando aberta pelo titular, sem permissão de equipe, mostra uma versão leve:
- os dados do cartão, o QR e o conteúdo programático;
- a segunda via em PDF e Word.

Ficam de fora:
- os hashes;
- o dicionário de tags;
- a trilha técnica.

A ficha técnica atual continua para a equipe.

### Diferenças em relação à ABHO, e por quê

| ABHO | SISA | Motivo |
|---|---|---|
| Selo fixo "CERTIFICADO" | Selo de situação e de norma | O selo precisa informar algo |
| Sem carga horária | Carga horária no cartão e soma no topo | Capacitação e progressão no serviço público |
| Sem validação | Código, link e QR | A validação pública já é um diferencial do SISA |
| Sem validade | Validade e "vence em N dias" | Treinamentos de NR vencem |
| "Programação" em botão verde sólido | Conteúdo em botão contornado | Uma só ação principal por cartão |
| Metadados de 11px | 13px | Leitura no celular e acessibilidade |
| Sem filtro nem agrupamento | Filtros, ano e agrupamento | As listas de SST crescem com as reciclagens |

---

## 4. Minha atividade

**Rota nova:** `GET /minha-atividade` (`src/rotas/painel.ts`, ou um arquivo novo `src/rotas/meu_espaco.ts`). **Template:** `minha_atividade.html`. **Permissão:** titular.

### 4.1 Dados
- **Função nova:** `atividade_do_titular(usuario, filtro, pagina)` em `src/servicos/auditoria.ts`.
- **Consulta:** `UNION ALL` sobre `historico_evento` com join por entidade:
  - `certificado.servidor_id`;
  - `inscricao → participante.servidor_id`;
  - `epi_requisicao(.servidor_id)` e `epi_requisicao_item → requisicao`;
  - `epi_ficha_registro.servidor_id`;
  - `usuario` (id da conta);
  - `processo` do servidor, se houver ligação direta.
- **Lista branca de tipos:** constante `EVENTOS_DO_TITULAR`, com o grupo (Treinamentos/Certificados/EPI/Processos/Conta), o ícone e a frase para o titular. Exemplos:
  - INSCRICAO_PEDIDA_PELO_TITULAR → "Você pediu inscrição";
  - CERTIFICADO_EMITIDO → "Certificado emitido";
  - EPI_ENTREGUE → "EPI entregue";
  - SENHA_TROCADA → "Senha alterada".
- **Fora da lista:**
  - eventos de `turma`, como lote e lista de presença coletiva;
  - CERTIFICADO_DIVERGENTE e PDF_NAO_GERADO;
  - logins.
- **Texto exibido:** só o rótulo, a data e hora e o objeto: código da turma, nome congelado do treinamento, rótulo do certificado ou número do pedido.
- **Agente:**
  - "Você", quando `usuario_id` é o próprio titular;
  - caso contrário, "Equipe {sigla do setor}". O nome do operador nunca aparece (RN-19).
- **Descrição:** a `descricao` livre não aparece. Se um dia aparecer, passa por `texto_livre(..., { sobre: titular })`.

**Esquema:** nada é obrigatório. Opcional na fase 3: índice `historico_evento(entidade, entidade_id, ocorrido_em)`, se ainda não existir; conferir na migração.

### 4.2 Tela
- **Filtros:** pílulas `Tudo · Treinamentos · Certificados · EPI · Processos · Conta`, por `?tipo=` em GET, com rolagem horizontal no celular.
- **Linha do tempo agrupada por dia:**
  - cabeçalho do dia: "Hoje", "Ontem" ou "dd/mm/aaaa";
  - cada item tem um ícone num quadrado pastel com cor por grupo (Treinamentos azul, Certificados ciano, EPI verde, Processos lilás, Conta cinza), o título em negrito, o objeto em cinza e o agente;
  - à direita, a hora (`<time datetime title="22/10/2026 14:03">há 3 h</time>`). O tempo relativo é calculado no servidor; sem JS.
- **Paginação:** 30 por página, com "Carregar mais" como link `?antes=`.
- **Rodapé:** "Seus acessos (login) ficam em Meu perfil › Sessões." Opcional na fase 3: "Consultas aos seus dados sensíveis", a partir de `acesso_dado_sensivel`, mostrando só a finalidade e a data. A decisão sobre mostrar o nome de quem consultou fica pendente.
- **Estado vazio:** "Nada por aqui ainda. Quando você se inscrever, receber EPI ou um certificado, aparece aqui."
- **Acessibilidade:** `<ol>` por dia, com `<h3>` para a data.

### Diferenças em relação à ABHO
- Sem logins e sem valores em reais.
- Agente genérico (RN-19).
- Filtros pensados para SST.

---

## 5. Comprovante de treinamentos (a "carteirinha")

**Avaliação: cabe, com escopo enxuto, na fase 3.** Em campo, um auditor ou um fiscal de obra pede a prova de NR-35 ou NR-10. O SISA já tem a validação por certificado, e o comprovante só reúne as que estão em vigor.

- **Rota:** `GET /certificados/meus/comprovante`, uma página para imprimir ou exportar em PDF, e `GET /certificados/meus/comprovante.pdf`.
- **Frente:**
  - faixa SISA;
  - nome do servidor (é o próprio titular que mostra);
  - lotação e campus;
  - "Emitido em dd/mm/aaaa hh:mm".
- **Verso:** quadro "Treinamentos em vigor" com a norma, o nome curto, a validade e um QR pequeno por linha, apontando para o `/validar/{chave}` de cada certificado.
- **Sem chave própria do comprovante:** cada linha se valida sozinha. Isso evita uma tabela nova. Em `/validar` o nome não aparece; quem confere digita o nome e recebe só "confere" ou "não confere", que já existe.
- **Sem CPF e sem SIAPE.**
- **Aviso:** "Documento de conferência. Vale a validação de cada QR na data da consulta."
- **Celular:** os cartões ficam empilhados; na impressão, frente e verso ficam lado a lado em A4 deitado.
- **Esquema:** nenhum.

---

## 6. Meu perfil (Minha conta)

**Rota:** `/minha-conta` (fila já decidida). **Template:** `minha_conta.html`. **Permissão:** titular. Toda conta, inclusive de equipe, tem a parte de Contato e Segurança.

### 6.1 Cabeçalho
Cartão azul-marinho com:
- as iniciais grandes;
- o nome completo;
- chips de lotação, cargo, campus e situação funcional ("Ativo", em selo verde).

### 6.2 Seções
São `<details>` com `<summary>` estilizado, sem JS. Cada `summary` tem ícone, título e, à direita, a ação "Alterar" quando existe e a seta. A primeira seção vem com `open`.

1. **Dados funcionais** (só leitura, sem "Alterar").
   - Campos:
     - SIAPE;
     - cargo;
     - função;
     - lotação (UORG);
     - campus;
     - situação;
     - data de ingresso, se existir.
   - Nota: "Fonte: SIAPE / Pró-Reitoria de Gestão de Pessoas. Para corrigir, procure a gestão de pessoas."
   - Link "Ver minha ficha completa →", para `/servidores/{id}`.
2. **Contato e acesso** ("Alterar" abre um popup com formulário POST).
   - Campos editáveis: nome de exibição e e-mail.
   - Trocar o e-mail exige confirmação por link no e-mail novo, se o envio de e-mail estiver configurado. Se não estiver, a troca é bloqueada com uma mensagem clara.
   - Só leitura: "Conta criada em" e "Último acesso".
3. **Segurança.**
   - "Trocar senha", que reaproveita `trocar_senha.html`.
   - **Sessões ativas:** lista vinda de `sessao` com navegador e sistema (resumidos do user agent), IP parcialmente mascarado (`200.131.x.x`), "criada em" e "último uso". O botão "Encerrar" vale para cada sessão que não é a atual; existe também "Encerrar todas as outras".
4. **Treinamentos e certificados** (resumo).
   - Mostra "N certificados válidos · X h", com links para as telas.
   - Fecha a lacuna atual: "Meus dados" não tem treinamentos.
5. **Privacidade (LGPD).**
   - Texto curto sobre os direitos do art. 18.
   - Link "Minha atividade".
   - Contato do encarregado, que já existe na configuração.

**Lista rótulo e valor:** em `<dl>`, com o rótulo em maiúsculas cinza de 12px (30%) e o valor à direita. Abaixo de 600px, o rótulo fica em cima do valor.

### Diferenças em relação à ABHO
- Sem CPF, RG, data de nascimento ou telefone. O dado funcional é só leitura e tem a fonte declarada.
- Sem contador de campos.
- Sessões e segurança entram no perfil, onde a ABHO punha logins na atividade.

---

## 7. Identidade e linguagem
- **Tom:** segunda pessoa, frases curtas, verbos de ação ("Baixar certificado", "Ver turmas →") e datas dd/mm/aaaa.
- **Marca SISA:** trocar a marca antiga nessas telas.
  - `<title>`: "· SISA";
  - rodapé;
  - "a CSSO confirma" → "o {setor} confirma";
  - placeholder da validação;
  - `RESPOSTA_PADRAO` do acesso do participante.
  - O prefixo de chave `CSSO-2026-…` **não muda** nos certificados já emitidos, que são congelados. Para os novos, o prefixo novo vai para decisão à parte.
- **Componentes novos em `tema.css`:**
  - `.ident-lateral`;
  - `.boas-vindas`;
  - `.chip`;
  - `.cartao-status`;
  - `.atalhos`;
  - `.grade-cert`, `.cert`, `.selo--valido/--avencer/--vencido/--norma/--neutro`;
  - `.pilulas`;
  - `.linha-tempo`;
  - `.perfil-secao` (details);
  - `.dl-rotulo`;
  - `.vazio`.

---

## 8. Plano de implementação em lotes

Este plano roda **depois** que terminarem os trabalhos de governança de acesso e de Minha conta. Cada lote é um commit com testes verdes (`npm test`) e uma conferência visual em 1366 e 390px com o script `sisa_shots_abho2.mjs`.

### Lote 0: base de domínio (sem tela)
- `src/dominio/treinamento.ts`:
  - `JANELA_A_VENCER_DIAS = 60`;
  - `situacao_do_cartao(cert, hoje)` → `valido | a_vencer(dias) | vencido | indeterminado | anulado`.
- `src/servicos/emissao_certificado.ts`:
  - `em_vigor(servidor_id)`, extraída de `reciclagem.monitor`, que passa a usá-la;
  - `cartoes_do_titular(usuario, filtro)`, que monta o DTO a partir do congelado com fallback para o setor promotor;
  - `resumo_do_titular()`, com as contagens e a soma de horas.
- `src/servicos/datas_br` (ou equivalente): `periodo_curto(inicio, fim)` e `tempo_relativo(data, agora)`.
- `src/rotas/certificados.ts` e `painel.ts`: trocar as janelas 60/90 pela constante.
- **Testes:**
  - `testes/meu_espaco_dominio.test.ts`: situação nas fronteiras de 0, 1, 60 e 61 dias e sem vencimento; `em_vigor` com reciclagem que substitui a anterior e com anulado;
  - `periodo_curto` para mesmo dia, mesmo mês e meses diferentes;
  - a regressão de `reciclagem` continua igual.

### Lote 1: Meus certificados em cartões
- `src/rotas/certificados.ts` (rota `/meus`): filtros `situacao`, `ano` e `q` validados (lista fechada), agrupamento por ano e "em emissão".
- `templates/paginas/certificados_meus.html`: reescrita em cartões e macro `templates/parciais/cartao_certificado.html`, reaproveitada no painel e no acesso sem conta.
- `public/estaticos/css/tema.css`: componentes da seção 7.
- `public/estaticos/js/…`: reaproveitar o copiar link, sem JS novo.
- **Testes:** em `testes/certificados.test.ts`, `menu_certificados.test.ts` e `correcoes_certificados.test.ts`:
  - cartão com selo, título, carga e "Emitido em";
  - filtro "vencidos" só com vencidos;
  - conteúdo programático só quando existe;
  - "Inscrever-se na reciclagem" só em a vencer ou vencido e não superado;
  - estado vazio;
  - titular A não vê cartão de B (`seguranca_autorizacao`);
  - sem `style=`/`<script>` inline (`templates.test.ts` / `seguranca.test.ts`);
  - `privacidade_varredura` sem CPF.

### Lote 2: Painel do titular
- `src/rotas/painel.ts` (`inicio_do_servidor`): boas-vindas, avisos, 4 cartões de status, últimos 2 certificados e atalhos.
- `templates/paginas/painel.html`: bloco do servidor.
- **Testes:** em `testes/painel.test.ts`:
  - as contagens batem com a semente;
  - os chips sem SIAPE e sem CPF;
  - os atalhos respeitam as permissões;
  - aviso vermelho com NR vencida;
  - nada quando não há aviso.

### Lote 3: menu do Meu espaço
- `src/modulos.ts`:
  - `Item` aceita a condição `titular`;
  - `MEU_ESPACO` em grupos (`GrupoMenu`);
  - "Minha atividade" e "Meu perfil" entram;
  - "Meus dados" sai.
- `templates/base.html`: cartão de identificação, grupos e "Sair".
- `src/rotas/celular.ts`: a mesma lista.
- **Testes:**
  - `testes/modulos.test.ts`: titular sem `processo.ver` vê o Início; conta de equipe não vê o Meu espaço;
  - `menu_certificados.test.ts`: `aria-current`;
  - `identidade_sisa.test.ts`.

### Lote 4: Minha atividade
- `src/servicos/auditoria.ts`: `EVENTOS_DO_TITULAR` e `atividade_do_titular()`.
- Rota `/minha-atividade` em `src/rotas/painel.ts`, ou em `src/rotas/meu_espaco.ts` registrada em `src/web.ts`.
- `templates/paginas/minha_atividade.html`.
- **Testes:** em `testes/minha_atividade.test.ts`:
  - mostra os eventos do próprio titular e não os de outro;
  - não mostra o nome do operador (RN-19), nem eventos de `turma`, nem os internos;
  - o filtro por tipo funciona;
  - a paginação funciona;
  - `idas_ao_banco.test.ts`: número de consultas limitado.

### Lote 5: Meu perfil em seções
Se não vier pronto na entrega de "Minha conta", este lote acrescenta:
- `templates/paginas/minha_conta.html`: seções `<details>`, `dl.dl-rotulo`, seção de treinamentos e privacidade;
- `src/rotas/autenticacao.ts` / `usuarios.ts`: sessões com IP mascarado e encerramento.

**Testes:**
- `autenticacao_governanca.test.ts`: encerra outra sessão e não encerra a atual;
- `privacidade_*`: sem CPF, RG ou data de nascimento;
- os dados funcionais não aceitam POST.

### Lote 6: acesso sem conta e ficha leve
- `src/servicos/acesso_participante.ts`: `ItemDoTitular` ampliado.
- `templates/paginas/acesso_participante.html`: a macro de cartão.
- `templates/paginas/certificado_ficha.html`: modo do titular, sem hashes, dicionário e trilha.
- Marca SISA nos textos dessas telas.

**Testes:**
- `certificados.test.ts`: o titular não vê "SHA-256" nem "Trilha"; a equipe vê;
- `textos.test.ts`: sem "CSSO" nas telas do titular.

### Lote 7 (fase 3, opcional)
- **Comprovante:** `/certificados/meus/comprovante` (HTML e PDF, reaproveitando `certificado_pdf.ts` e `qr.ts`).
- **PDF do conteúdo:** `/certificados/:id/conteudo.pdf`.
- **Índice:** de `historico_evento` (migração e `_journal.json`).
- **Consultas a dados sensíveis:** consultas a `acesso_dado_sensivel` em Minha atividade, depois de decidido se o nome de quem consultou aparece.

**Testes:**
- o PDF é gerado;
- o QR aponta para `/validar/{chave}`;
- o comprovante não tem CPF nem SIAPE.

### Pendências de decisão (não bloqueiam os lotes 0 a 4)
1. O prefixo de chave dos novos certificados (CSSO- → SISA-?).
2. Na lista "consultas aos seus dados sensíveis", mostrar o nome de quem consultou.
3. Uma programação por turma (`turma.programacao` ou uma nova categoria de anexo, com migração).
