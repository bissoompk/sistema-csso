# Avisar o visitante de que já tem cadastro, sem divulgar nada

Análise somente de leitura feita em 23/10/2026 sobre `nuvem/` (branch `feat/sisa-textos-sem-rn`). Nenhum arquivo do repositório foi alterado. Foram usadas três lentes em paralelo (UX/fluxo; segurança/LGPD/abuso; viabilidade técnica). Os trechos centrais foram conferidos no código.

Os caminhos citados são relativos a `/home/fabricio/projetos/ufvjm/sistema-csso/nuvem/`.

## Resposta curta

**Dá para fazer, no padrão «esqueci a senha».**

- **Na tela:** a mesma frase para todos, sem nunca dizer «você já tem cadastro».
- **O aviso de verdade:** vai **só para o e-mail que já está no cadastro**, nunca para o digitado. Sai pela fila de e-mail que já existe e tem limite por destinatário.
- **Para a equipe:** vê «parece com PTC-XXXX» na conferência dos pedidos.

Assim só o **dono da caixa** fica sabendo que existe cadastro. Ele é o próprio titular, e para ele isso não é vazamento: é transparência.

---

## 1. Como é hoje (conferido)

| Ponto | Situação |
|---|---|
| Tela ao visitante | Sempre `RESPOSTA_PADRAO` (`src/servicos/inscricao_publica.ts:52-54`). Vale para quem casou, quem não casou, quem já estava inscrito e o robô. A tela repete só o nome e o e-mail digitados (`templates/paginas/inscricao_publica.html:58-68`). **Não há oráculo de conteúdo.** |
| Casamento (`inscricao_publica.ts:294-318`) | Em ordem: <br>1. SIAPE + `mesmo_nome`; <br>2. e-mail + `mesmo_nome`; <br>3. pedido em espera desta turma com o nome inteiro igual; <br>4. senão, cria um externo. <br>Quando casa (1 ou 2), **o e-mail digitado é descartado**. |
| Já inscrito na turma | `return` silencioso (`:363`): mesma tela, mas a resposta é **mais rápida**. É um oráculo de tempo, pequeno. |
| E-mail no pedido | Nenhum sai hoje. O comentário em `:7-9` chama isso de «canhão de spam». Só saem o aceite e a recusa (`src/servicos/avisos_inscricao.ts`), para o e-mail do cadastro. |
| Fila de e-mail | `email.enfileirar` só faz um INSERT em `email_saida` (`src/servicos/email.ts:122-138`). O envio real fica numa função de fundo. `acordar_envio()` leva até 3 s (`:253-266`) e hoje só a rota de acesso o chama. Sem SMTP configurado, as mensagens ficam pendentes. |
| Anti-abuso da inscrição | • 8 POSTs por IP a cada 10 min, **em memória da instância** (`:391-409`), que se perde no arranque a frio e vale por instância; <br>• campo escondido `site`; <br>• teto de 200 pedidos em espera por turma; <br>• token do link com hash. <br>**Não há limite por e-mail nem por SIAPE, nem captcha.** |
| Modelo pronto | `/certificados/acesso` (`src/servicos/acesso_participante.ts`) já faz o «esqueci a senha»: <br>• frase única (`:49-51`); <br>• 3 links por hora por e-mail, contados **no banco** (`:99-103`); <br>• envio só ao e-mail do cadastro; <br>• «se não foi você, ignore»; <br>• token de 2 h guardado como SHA-256. |
| `confirmado_em` | Nunca é gravado. As colunas `inscricao.confirmacao_token_hash`, `email_confirmado_em` e `confirmacao_expira_em` existem e também estão ociosas. `ck_inscricao_email_confirmado` (`src/db/esquema/treinamento.ts:651-657`) já aceita `email_confirmado_em` como alternativa à conferência. |
| Conferência | `PedidoNaFila` (`src/servicos/pedidos_link.ts:30-40`, laço em `:85-99`) não diz se o pedido casou com um cadastro nem se parece com outro. A única pista é a nota «SIAPE não confere» (`:308`). `participante.parecidos` (`participante.ts:423-466`) já filtra pela RN-19. |

**Brecha achada de passagem (corrigir de qualquer jeito).**

- **O caminho:** quando o SIAPE casa e o servidor ainda não tem participante, `de_servidor` grava o e-mail institucional.
- **O vazamento:** se esse e-mail estiver mal formado, a exceção `E-mail inválido: '<endereço>'` (`participante.ts:171`) vira `PedidoInvalido` e aparece com 422 ao visitante. Isso vaza o e-mail do servidor e confirma o SIAPE.
- **Correção:** a mensagem deve ser genérica, ou o e-mail ruim deve ser ignorado nesse caminho.
- **Esforço:** P.

---

## 2. Alternativas

| # | Alternativa | O que o visitante vê | O que vaza | Esforço | Arquivos |
|---|---|---|---|---|---|
| **A** | **Tela idêntica + aviso só ao e-mail já cadastrado** («esqueci a senha») | A frase de sempre, mais uma linha igual para todos: «se já fez curso conosco, pode chegar uma mensagem no e-mail que usou antes». | Nada na tela. O dono da caixa sabe que alguém usou os dados dele, e esse é o alerta desejado. | **M** | `servicos/inscricao_publica.ts` (`_participante` devolve se casou e por qual chave; `pedir` enfileira); texto novo ao lado de `servicos/avisos_inscricao.ts`; `rotas/inscricao_publica.ts`; `templates/paginas/inscricao_publica.html` |
| A1 | ...casando pelo **e-mail digitado + nome** | Igual. | Nada. Quem digitou já conhecia o endereço, e o aviso cai na própria caixa. | (dentro de A) | idem |
| A2 | ...casando pelo **SIAPE + nome**, com envio ao institucional | Igual. | Nada na tela. **Vetor de abuso:** SIAPE e nome são públicos (Portal da Transparência), então um terceiro dispara e-mails da CSSO para qualquer servidor. | (dentro de A) | idem + limite por destinatário |
| A3 | ...casando **só por nome** (e-mail diferente ou vazio) | Igual. | Nada na tela, mas homônimos recebem o aviso. Também é vetor de abuso por lista de nomes, e é o casamento mais fraco. | (dentro de A) | idem |
| B | Mostrar **dados mascarados** (`f***@gmail.com`, «Maria S.») | O pedaço do dado. | **Vaza.** Confirma que a pessoa existe (enumeração) e entrega fragmentos de dado pessoal a quem não está autorizado, contra a RN-19 e a minimização. Com poucas tentativas e dados públicos, o resto se completa. | P | — (descartar) |
| C | **Tempo de resposta constante** | Nada muda. | Fecha o oráculo de tempo. | **P** | `rotas/inscricao_publica.ts` (chamar `acordar_envio()` sempre, sem `await` ou sem depender do ramo); `inscricao_publica.ts` (o ramo «já inscrito» também enfileira ou grava trilha; opcionalmente um piso de cerca de 300 ms com variação) |
| D | **Limites persistentes** | Excedeu: a tela atual de «envios demais» (`html:13-15`). | Nada. Protege a caixa de terceiros e a cota do SMTP. | **P–M** | `inscricao_publica.ts`: <br>• 1 aviso por destinatário a cada 24 h (ou 7 dias), contado em `email_saida` por `tipo` e `destinatario`, como `acesso_participante.ts:99-103`; <br>• teto diário de avisos por turma; <br>• levar o limite por IP para o banco (como `limite_login_ip`, `servicos/autenticacao.ts:553`). <br>Captcha só se o abuso aparecer. |
| E | **«Parece com PTC-XXXX» só para a equipe**, na conferência | Nada muda. | Zero. Só aparece a quem tem leitura nominal (RN-19). | **P** | `servicos/pedidos_link.ts:85-99` (campos `casou_com`, `parecidos`, `selo`); `templates/paginas/turmas_pedidos.html:66-78`; botão «usar este cadastro», que chama `mesclagem.mesclar` com motivo pré-preenchido; «é outra pessoa» |
| F | **Ligar automaticamente** o pedido ao cadastro quando o e-mail **confirmado** bate | Nada muda. | Nada na tela. Riscos: <br>• e-mail compartilhado; <br>• alguém inscrever outra pessoa conhecendo o e-mail dela; <br>• o pedido entra no histórico do dono. | P no código, **ganho nulo hoje** | `_participante` (ramo «confirmado vence», como `_donos` em `acesso_participante.ts:65-74`). Depende de G. |
| G | **Gravar `confirmado_em`** | Na página do link do e-mail: «Pronto, confirmado». | Nada. | **M** | <br>• `acesso_participante.ts:173` (`abrir`, quando não é ambíguo); <br>• o link «sou eu» do aviso A; <br>• `registrar_email(..., {confirmado_em})`. <br>Tratar o conflito com `uq_email_confirmado` quando o e-mail está em dois cadastros: aí não confirma e vai para a junção. |
| H | Externo **sem e-mail** | A frase de sempre. | Nada. Não há canal seguro: **nunca** mostrar «achamos alguém parecido». | — | Fica com E: a equipe vê a semelhança e decide. |

### Por que o mascaramento (B) também vaza

`f***@gmail.com` responde «sim, essa pessoa tem cadastro». Isso já é a enumeração. Além disso:

- o domínio e o tamanho estreitam a busca;
- «Maria S.» junto com o SIAPE confirma o vínculo com a UFVJM.

Qualquer resposta que **dependa** de existir cadastro é um oráculo, mascarada ou não.

---

## 3. Cuidado crítico no link «sou eu» do e-mail

A lente de UX sugeriu que, ao clicar «sim, sou eu», **o e-mail novo digitado entre no cadastro antigo como endereço extra**. **Não fazer isso automaticamente.** É um caminho de tomada de conta:

1. O atacante pede a vaga com o nome (e o SIAPE) da vítima e o **e-mail dele**.
2. A vítima recebe o aviso e clica «sou eu» por engano ou desatenção.
3. O e-mail do atacante passa a pertencer ao cadastro da vítima.
4. Por `/certificados/acesso`, o atacante recebe o link e **vê os certificados da vítima**.

**Regra:** o «sou eu» só faz o seguinte:

- liga o pedido ao cadastro existente;
- confirma o e-mail **que já era do cadastro** (`confirmado_em`, o próprio endereço que recebeu o link).

O e-mail digitado só entra no cadastro de duas formas: depois da conferência da equipe, ou depois de confirmado por um link enviado **a ele próprio**. O «sou eu» também **não aceita a vaga**: a conferência continua.

**«Não fui eu»:** o pedido fica com o selo «titular negou» na conferência, e a recusa já vem com o motivo pré-preenchido.

---

## 4. Recomendação

**Fazer A1 + A2 (com D) + C + E + a correção da brecha. Deixar G para a segunda etapa. Não fazer B. Fazer F só como sugestão para a equipe.**

### O que o visitante vê

- **No formulário, preventivo, igual para todos:**
  - no topo: «Já fez curso com a gente? Use o mesmo nome e o mesmo e-mail da outra vez: assim os certificados ficam juntos.»;
  - no SIAPE: «Servidor: informe o SIAPE; é por ele que achamos o seu cadastro, mesmo que o e-mail tenha mudado.»
- **Na tela de sucesso, igual para todos:** `RESPOSTA_PADRAO` mais «Se você já tem cadastro com a gente, pode chegar uma mensagem no e-mail que usou antes. Não chegou nada? Tudo bem: a equipe confere o pedido do mesmo jeito.» A frase «você já tem cadastro» nunca aparece como afirmação.

### Quando sai o e-mail

Sai só ao endereço principal **do cadastro**, pela fila, dentro da mesma transação:

| Caso | Envia? |
|---|---|
| Casou por e-mail + nome (A1) | Sim. |
| Casou por SIAPE + nome (A2) | Sim, mas só com o limite por destinatário. |
| Casou só por nome (A3) | **Não.** Vai só para a equipe, via E. |
| Já inscrito nesta turma | Sim, para quem casou, com o texto «você já tem pedido/vaga nesta turma, não precisa pedir de novo» e o mesmo limite. Isso também iguala o tempo (C). |
| E-mail do cadastro ambíguo (em mais de um cadastro, nenhum confirmado) | Não. Fica para a equipe. |

### Texto do e-mail

O aviso não leva nome, SIAPE, IP, o que foi digitado nem a organização. A turma pode ficar de fora (ver decisão 3).

> **Assunto:** Pedido de vaga em treinamento: Sistema SISA · UFVJM
>
> Olá. Recebemos pelo link público um pedido de vaga em treinamento com dados ligados a este e-mail. Você já tem cadastro conosco e não precisa criar outro: a equipe vai conferir o pedido e avisar por aqui.
>
> Não foi você? Ignore esta mensagem: nada é confirmado sem a conferência da equipe. Se receber avisos repetidos, responda a este e-mail.
>
> *(Na etapa 2: [Sim, fui eu] · [Não fui eu], com link válido por 7 dias.)*

### Ordem de entrega

| Etapa | O que entra | Esforço |
|---|---|---|
| **Etapa 1** | E, a brecha de `participante.ts:171`, C, D e A sem botões, só informativo | P + P + P + M |
| **Etapa 2** | Botões «sou eu» / «não fui eu» com token (reaproveitar `inscricao.confirmacao_*`), gravação de `confirmado_em` (G) e selo na conferência | M |
| **Depois** | F, ligar sozinho pelo e-mail confirmado, só se a etapa 2 mostrar que o selo é confiável | P |

**Arquivos da etapa 1:**

- `src/servicos/inscricao_publica.ts`
- `src/rotas/inscricao_publica.ts`
- `src/servicos/avisos_inscricao.ts` (ou um serviço novo `aviso_cadastro_existente.ts`)
- `src/servicos/participante.ts`
- `src/servicos/pedidos_link.ts`
- `templates/paginas/inscricao_publica.html`
- `templates/paginas/turmas_pedidos.html`
- testes
- `docs/ROPA_NUVEM.md` §5.8/§5.9: acrescentar «aviso de cadastro existente» como meio de segurança e transparência ao titular, sem finalidade nova (LGPD art. 6º, III, IV e VI, e art. 46)

### O que não resolve

Não resolve quem **trocou de e-mail e não é servidor**. O aviso vai para a caixa antiga e pode não chegar. Esse caso continua com a equipe (E) e com a junção.

---

## 5. Decisões pequenas para o usuário

1. **Casar e avisar também pelo SIAPE (A2)?** Sim, com 1 aviso por destinatário a cada 24 h, ou não (só e-mail + nome). **Recomendo sim, com o limite:** é o caso que mais evita duplicado de servidor e o dano do abuso é baixo.
2. **Avisar quando só o nome bate (A3)?** **Recomendo não.** Vai só à equipe; homônimos e listas de nomes tornariam o aviso spam.
3. **O e-mail cita a turma (nome e data)?** **Recomendo não na etapa 1** (texto genérico), por causa de caixas compartilhadas. Na etapa 2, citar só o nome do treinamento.
4. **Janela do limite por destinatário:** 24 h ou 7 dias. **Recomendo 24 h**, mais um teto diário por turma (ex.: 50).
5. **Avisar o já inscrito nesta turma** («não precisa pedir de novo»)? **Recomendo sim.** Ajuda o visitante e iguala o tempo.
6. **Botões «sou eu» / «não fui eu» já na etapa 1 ou depois?** **Recomendo depois** (etapa 2), junto com a gravação de `confirmado_em`.
7. **O «sou eu» acrescenta o e-mail digitado ao cadastro?** **Recomendo não** (risco de tomada de conta, seção 3). Só liga o pedido e confirma o e-mail que já era do cadastro.
8. **Ligar automaticamente pelo e-mail confirmado (F)?** **Recomendo só sugerir à equipe** por enquanto. Automático só depois da etapa 2, e sempre com o pedido «a conferir».
9. **Limite por IP no banco em vez da memória?** **Recomendo sim** (P). O limite atual zera a cada instância ou arranque.
10. **Captcha?** **Recomendo não agora.** Só se a trilha mostrar abuso.
11. **Sem SMTP configurado:** os avisos ficam pendentes na fila e, ao ligar o SMTP, sairiam atrasados. **Recomendo dar validade de 24 h ao aviso na fila** (descartar se vencido), ou não enfileirar enquanto `configurado()` for falso.
