# Precisa da tela «Juntar cadastros duplicados»? Ou basta avisar na entrada?

Análise somente de leitura, feita em 23/10/2026 sobre `nuvem/` (branch `feat/sisa-textos-sem-rn`). Nenhum arquivo do repositório foi alterado.

## Resposta curta

**Avisar na entrada é melhor, e o sistema já faz isso em uma porta.** Mas só o aviso não basta para remover a tela. Há três motivos:

1. **O formulário público não pode avisar quem está preenchendo.** Dizer «você já tem cadastro» revela que a pessoa existe. É o oráculo de enumeração que a RN-19 e o `RESPOSTA_PADRAO` fecham hoje.
2. **Alguns duplicados nascem sem que ninguém esteja digitando nada.** Exemplo: o externo que depois vira servidor pela importação SIAPE.
3. **Com as chaves que o sistema aceita guardar, a confiança é baixa.** São nome e e-mail não confirmado. Não há CPF como chave, nem data de nascimento. Por isso sempre sobra o caso descoberto depois.

**Recomendação: opção (b).** Reforçar a prevenção em cada porta e manter a junção como exceção, com estas mudanças:

- tirar a junção do menu;
- mostrar um contador de suspeitos;
- oferecer «juntar» na própria ficha ou na conferência, onde a suspeita aparece.

---

## 1. Como os duplicados nascem hoje, porta por porta

### Chaves de identificação que existem (valem para todas as portas)

| Chave | Situação real no código |
|---|---|
| **CPF** | `participante.cpf` existe desde 19/10/2026, mas **só para o certificado**. Os detalhes: <br>• fica em `servicos/cpf_certificado.ts`; <br>• não tem UNIQUE, índice nem hash; <br>• nunca é usado para procurar pessoa; <br>• o link público recusa o CPF digitado (`inscricao_publica.ts:217`) e o lote o ignora (`inscricao_lote.ts:91`). <br>A única leitura do CPF é na mesclagem, para **recusar** a junção quando os dois CPFs diferem. <br>Há comentários desatualizados que ainda dizem «não há coluna de CPF»: `db/esquema/treinamento.ts:292` e `DESVIOS.md:718`. |
| **SIAPE** | UNIQUE em `servidor`. O participante do servidor é único por `uq_participante_servidor`, e `de_servidor` é idempotente. **Não existe duplicado servidor × servidor.** |
| **E-mail** | Fica numa tabela filha. A normalização é só caixa e espaço (`trim().toLowerCase()`). Isso é de propósito: o CHANGELOG explica que tirar ponto do Gmail ou o sufixo `+` juntaria pessoas diferentes. <br>**Achado importante:** nenhum código grava `participante_email.confirmado_em`. Todos os `registrar_email` são chamados sem esse campo. Por isso: <br>• o índice `uq_email_confirmado` nunca atua; <br>• o mesmo e-mail pode estar em vários participantes; <br>• em `/certificados/acesso`, dois cadastros com o mesmo e-mail **bloqueiam** a lista de certificados, que fica «ambíguo, procure a CSSO». |
| **Nome** | `textos.chave_busca` tira acento e caixa e junta os espaços. Há três regras de comparação diferentes: <br>• `mesmo_nome`: só o primeiro e o último nome; <br>• nome inteiro igual: lote e pedido em espera; <br>• nome sem as palavras de até 2 letras: sugestões da mesclagem. <br>Além disso, o SQL de `parecidos` usa um `translate` com lista fixa de acentos: ñ, ý e outros escapam. |
| **Data de nascimento, RG** | Não existem no esquema. `matricula_externa` é opcional e não tem UNIQUE. |

### Porta a porta

| Porta | Como casa a pessoa | Como o duplicado nasce (exemplos concretos) |
|---|---|---|
| **Link público** `/inscricao/:token` (`servicos/inscricao_publica.ts:294-318`) | Em ordem: <br>1. SIAPE + `mesmo_nome`; <br>2. e-mail + `mesmo_nome`; <br>3. pedido em espera **desta turma** com o nome inteiro igual; <br>4. senão, cria um externo novo. Servidor que não casou entra como `OUTRO`/«UFVJM». | • A servidora «Maria Aparecida Souza Lima» digita «Maria Souza» e o SIAPE certo. O último nome difere, então nasce um externo `OUTRO` paralelo ao cadastro de servidor. <br>• Um externo sem e-mail pede em duas turmas. O passo 3 só olha a turma atual, então nasce um externo por turma. <br>• «Zé Santos» e «José Santos» com o mesmo e-mail: o primeiro nome difere, nasce o segundo, e o e-mail fica repetido. <br>• «Joana Silva» e «Joana da Silva», ambas sem e-mail: nasce o segundo. <br>• Caixa ou acento no nome ou no e-mail **não** geram duplicado. |
| **Equipe na ficha da turma** (`rotas/turmas.ts:1167-1262`) | Três caminhos: <br>• escolher um participante na busca; <br>• escolher um servidor da base, que passa por `de_servidor`; <br>• digitar um externo novo. <br>**Já existe o aviso «é a mesma pessoa?»** (`participante.parecidos`), com primeiro e último nome iguais ou mesmo e-mail, e o botão «Não é: cadastrar como pessoa nova». | • Operador sem leitura nominal: `parecidos` sai vazio por RN-19 e o externo é criado em silêncio. <br>• O operador clica «não é». <br>• Sobrenome final diferente (nome de casada). <br>• **Escolher o servidor da base de quem já tem cadastro externo não mostra aviso nenhum**, porque `parecidos` só roda para externo novo. É aí que nasce o par externo + servidor. |
| **Lote / lista colada** (`servicos/inscricao_lote.ts:140-194`) | Em ordem: <br>1. SIAPE: precisa existir, senão a linha é recusada; <br>2. e-mail: `por_email` pega **um**, sem conferir o nome; <br>3. nome inteiro exato, só para quem lê nomes; homônimo leva à recusa; <br>4. senão, cria um externo (TERCEIRIZADO por padrão). | • «Maria Souza» × «Maria de Souza»: nasce um externo novo. Se for servidora, nasce como TERCEIRIZADO. <br>• Operador sem leitura nominal: todo nome sem SIAPE e sem e-mail conhecido vira externo novo. <br>• E-mail compartilhado (do setor, da mãe): a linha **cai na pessoa errada**. É o erro inverso do duplicado. |
| **Inscrever-me** (servidor logado) | `de_servidor(usuario.servidor_id)`. | Não duplica. |
| **Importação de servidores SIAPE** (`importacao_servidores.ts`), `cadastrar_basico` do balcão de EPI | Chave SIAPE. **Não toca em `participante`.** | Caso clássico: alguém fez curso como externo antes de estar no cadastro. A importação cria o `servidor`, mas não liga ao externo. Na próxima inscrição, `de_servidor` cria o segundo cadastro. A tela de junção é a **única** ponte entre os dois. |
| **Migração IntegraSST / certificados antigos** | **Não existe importador.** O Apps Script está em `entrada/integrasst`, fora do git, e `inscricao.origem` só aceita `INTERNA`/`PUBLICA`. `ferramentas/povoar/treinamentos.ts` chama `criar_externo` sem conferir nada, mas só para teste. | Se houver carga futura de certificados antigos com só o nome, cada linha vira um externo novo. Pode gerar dezenas ou centenas de duplicados de uma vez. |
| **`/certificados/acesso`** | Não cria cadastro. Casa por e-mail exato e responde sempre `RESPOSTA_PADRAO`. | Não gera duplicado, mas **sofre** com ele: dois cadastros com o mesmo e-mail e nenhum confirmado levam a «procure a CSSO». |
| **Celular, API, reconciliação, Trello, planilha de processos** | Não criam participante. A reconciliação é só de processos e pareceres. | O Trello casa **servidor** pelo nome do cartão, com o primeiro igual, mas isso é outro problema (processo ligado a homônimo). |

---

## 2. Dá para avisar na entrada? Com que confiança? E a privacidade?

| Porta | Avisar? | Confiança | Privacidade / RN-19 | Homônimo (é outra pessoa) |
|---|---|---|---|---|
| **Link público** | **Não** a quem preenche. «Você já tem cadastro» confirma a terceiros que Fulano existe e é participante da UFVJM. É enumeração de pessoas: a RN-19 e o `RESPOSTA_PADRAO` existem para fechar isso, e o limite por IP não basta. <br>**Sim, à equipe**, na conferência do pedido (`pedidos_link.ts`): o pedido já nasce «a conferir», e hoje essa tela não mostra parecidos. Ela pode mostrar «parece PTC-XXXX (mesmo nome / mesmo e-mail / SIAPE informado não confere com o nome)», com o botão «é a mesma: usar o cadastro existente». | Média. Nome + e-mail + SIAPE digitado juntos dão um bom sinal, mas não são prova. | Sem risco: só quem tem `turma.inscrever` e leitura nominal vê. | «Não é a mesma» mantém o cadastro novo e grava a decisão, para o par não voltar como suspeito. |
| **Equipe, externo novo** | Já avisa. Falta ampliar o critério: <br>• aceitar nome do meio diferente com o mesmo primeiro nome e o mesmo sobrenome em qualquer posição; <br>• trocar o `translate` por `unaccent` ou pela mesma `chave_busca` do JS. | Média. | Já respeita a RN-19: quem não lê nomes não recebe a pergunta. Nesse caso, em vez de silêncio, o cadastro pode nascer **marcado como suspeito** para quem lê nomes conferir. | Botão «não é» já existe. Falta lembrar a decisão. |
| **Equipe, escolher servidor da base** | **Sim, falta.** Antes de criar o participante do servidor, perguntar «há o externo PTC-XXXX com nome/e-mail parecido; é a mesma pessoa? Juntar agora». | Média-alta: o lado servidor tem o nome oficial do SIAPE. | Mesma regra da RN-19. | «Não é», com a decisão lembrada. |
| **Lote** | Sim, na **prévia** (o lote já roda em savepoint de conferência). A linha que cairia em externo novo mostra «parece com PTC-XXXX», com «usar este» ou «criar novo». A linha casada **só por e-mail com nome diferente** também deveria avisar, em vez de casar calada. | Média. | Igual. | «Criar novo» linha a linha. |
| **Importação SIAPE** | Não é aviso de entrada (ninguém digita a pessoa). O que cabe é um **relatório ao fim da importação**: «N servidores novos parecem externos já cadastrados (nome/e-mail institucional)», com o link para juntar. Junção automática, não: o nome igual não é prova. | Média. | Só para quem tem `exposicao.ver` / `participante.mesclar`. | Fica como suspeito até alguém decidir. |
| **Migração futura de certificados** | Casar na carga com relatório de ambíguos. Não criar às cegas. | Baixa (só o nome). | Carga interna. | Ambíguo não entra junto: fica para revisão. |

**Sobre usar o CPF como chave:** daria confiança alta, mas contraria a decisão de 19/10/2026 («CPF só para o certificado») e a ROPA. Guardar hash de CPF de todo externo seria um tratamento novo, porque o hash de CPF é reidentificável por força bruta (são só 10⁹ combinações). **Não recomendo.** O que dá confiança sem dado novo é **confirmar o e-mail**: o campo existe e nunca é preenchido.

---

## 3. O que a prevenção NÃO resolve (continua exigindo juntar depois)

1. **Duplicados que já existem** na base. A tela atual lista os grupos com o mesmo nome (sem partículas) ou o mesmo e-mail.
2. **Externo que vira servidor**: entra pela importação SIAPE, sem ninguém digitando, e anos depois.
3. **Troca de nome** (casamento, divórcio, nome social). Nome e e-mail mudam e nenhum aviso de entrada pega.
4. **Homônimo descoberto depois**: alguém respondeu «é a mesma» errado e juntou duas pessoas, ou respondeu «não é» errado. O primeiro caso pede **separar**, e hoje não há desfazer (o absorvido perde o CPF). O segundo pede juntar.
5. **Operador sem leitura nominal**: a RN-19 impede a pergunta, então o duplicado nasce e alguém com permissão precisa juntar.
6. **Migração de certificados antigos**, se vier: ambíguos em lote.
7. **E-mail compartilhado**: o duplicado aparece e a decisão é humana (pode ser outra pessoa).

Portanto **a capacidade de juntar tem de continuar existindo**. O que pode mudar é o lugar e o peso que ela tem na interface.

---

## 4. Recomendação

### (a) Só prevenção e remover a tela — **não**
Deixa sem saída os casos do item 3: externo → servidor, troca de nome, operador sem RN-19, base existente. O acesso a certificados por e-mail ficaria bloqueado para sempre nos e-mails duplicados.

### (b) Prevenção na entrada + junção como exceção — **recomendada**

**O que mudar em cada porta:**

| # | Mudança | Esforço |
|---|---|---|
| 1 | **Ficha da turma, escolher servidor**: rodar `parecidos` também quando se escolhe um servidor da base, procurando **externos**. Oferecer «juntar agora» com o externo, que chama o mesmo `mesclagem.mesclar`, com motivo pré-preenchido. | P |
| 2 | **Conferência dos pedidos pelo link** (`pedidos_link.ts`): mostrar «parece PTC-…» em cada pedido, com «é a mesma pessoa: usar o cadastro existente». Na prática, juntar o externo recém-criado ao existente antes de aceitar. O visitante continua vendo a mesma resposta de sempre. | M |
| 3 | **Prévia do lote**: marcar «parece com…» na linha que criaria externo novo e na que casou só por e-mail com nome diferente. Escolha linha a linha. | M |
| 4 | **Critério único de «parecido»**, usado nas portas e na tela de suspeitos. Hoje são três regras diferentes (`mesmo_nome`, nome inteiro, nome sem partículas) mais o `translate` incompleto. Uma função só, com um índice/coluna de nome normalizado (`unaccent`). | M |
| 5 | **Lembrar «não é a mesma pessoa»**: uma tabela de pares descartados, para o homônimo não voltar a cada inscrição nem na lista de suspeitos. | P |
| 6 | **Importação SIAPE**: no relatório final, mostrar «N servidores novos parecem externos já cadastrados», com o link. | P |
| 7 | **Confirmar o e-mail** quando a pessoa usa o link recebido (`/certificados/acesso`, link de confirmação do pedido) e gravar `confirmado_em`. Isso aumenta a confiança do casamento por e-mail e faz o `uq_email_confirmado` passar a valer. | M |
| 8 | Corrigir os comentários desatualizados sobre CPF (`treinamento.ts:292`, `DESVIOS.md:718`). | P |

**O que a tela de juntar passa a ser:**

- **Sai do menu lateral** («Cadastros › Juntar duplicados»). Vira um **contador de suspeitos** no Início de Treinamentos («3 cadastros parecem repetidos»), visível só com `participante.mesclar`. Some quando é zero.
- **A lista de suspeitos continua**, porque é ela que resolve a base existente e os casos do item 3. Os pares descartados (mudança 5) não aparecem.
- **Atalho na ficha do participante / servidor**: «juntar com outro cadastro», que abre a busca já filtrada. Cobre troca de nome e homônimo descoberto depois.
- As **regras da mesclagem não mudam**:
  - nada se apaga;
  - o servidor sempre fica;
  - não junta CPFs diferentes nem duas inscrições na mesma turma.
- Talvez **desfazer a junção** (separar), porque o erro inverso, juntar duas pessoas diferentes, passa a ser mais provável quando a junção fica mais fácil na entrada. Esforço G: o absorvido perde o CPF, e as inscrições e os e-mails movidos teriam de ser registrados para poder voltar.

**Esforço total de (b):**
- **M a G** com todos os itens;
- **P + M**, com o melhor retorno, para os itens 1, 2, 5 e o contador.

### (c) Manter como está — **não**
Funciona, mas joga todo o trabalho para depois e deixa dois buracos:
- o par externo + servidor nasce sem aviso quando a equipe escolhe o servidor da base;
- os pedidos pelo link são conferidos sem mostrar a suspeita, justamente onde a equipe já está olhando um por um.

---

## 5. Decisões para o usuário

1. **O destino da tela.**
   - Alternativas: <br>(a) remover; <br>(b) sair do menu e virar contador de suspeitos + atalho na ficha; <br>(c) manter no menu.
   - **Recomendo (b).**
2. **Avisar quem preenche o link público que já tem cadastro?**
   - Alternativas: <br>(a) avisar o visitante; <br>(b) não avisar o visitante e mostrar a suspeita só à equipe na conferência; <br>(c) não fazer nada.
   - **Recomendo (b).** (a) quebra a RN-19 e abre enumeração de pessoas.
3. **Na prévia do lote, o «parece com» decide sozinho ou pergunta?**
   - Alternativas: <br>(a) casa automático; <br>(b) pergunta linha a linha; <br>(c) cria sempre e deixa para a junção.
   - **Recomendo (b).** Automático por nome junta homônimos.
4. **Ligar automaticamente o externo ao servidor novo na importação SIAPE?**
   - Alternativas: <br>(a) automático por nome e e-mail; <br>(b) só sugerir no relatório e no contador; <br>(c) nada.
   - **Recomendo (b).**
5. **Passar a confirmar o e-mail (`confirmado_em`)?**
   - Alternativas: <br>(a) confirmar quando a pessoa clica no link recebido; <br>(b) continuar sem confirmação.
   - **Recomendo (a).** Dá a chave forte que o sistema aceita ter e desbloqueia o `/certificados/acesso`.
6. **Usar o CPF (ou hash dele) como chave de identificação?**
   - Alternativas: <br>(a) sim, para externos; <br>(b) não, manter «CPF só para o certificado».
   - **Recomendo (b).** É coerente com a decisão de 19/10 e com a ROPA, e o hash de CPF é reversível na prática.
7. **Guardar «não é a mesma pessoa»?**
   - Alternativas: <br>(a) sim, uma tabela de pares descartados; <br>(b) não, e o aviso volta sempre.
   - **Recomendo (a).**
8. **Operador sem leitura nominal (RN-19) cadastrando externo.**
   - Alternativas: <br>(a) cria em silêncio, como hoje; <br>(b) cria e marca como suspeito para quem lê nomes; <br>(c) bloqueia.
   - **Recomendo (b).**
9. **Oferecer desfazer (separar) junção?**
   - Alternativas: <br>(a) agora; <br>(b) só se aparecer o caso; <br>(c) nunca.
   - **Recomendo (b)**, mas registrar já na junção o que foi movido, o que é barato e torna o desfazer possível depois.
10. **Haverá carga de certificados antigos (IntegraSST)?** Se sim, ela precisa de um casamento com relatório de ambíguos, antes de existir. Se não, nada a fazer.
