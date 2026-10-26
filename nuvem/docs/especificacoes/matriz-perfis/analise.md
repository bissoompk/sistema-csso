# Matriz de perfis × Acesso por módulo — análise de harmonia

23/10/2026 · somente leitura. Feita em três recortes paralelos: (A) os dados no código, (B) telas e textos, (C) banco e branches. Scripts de apoio em `scratchpad/matriz/{A,B,C}/`.

Telas analisadas:
- **Matriz de perfis**: `/perfis`, montada em `src/rotas/usuarios.ts:1446-1478` com o template `templates/paginas/perfis.html`.
- **Acesso por módulo**: `/perfis/niveis`, montada em `usuarios.ts:~1505` com `perfis_niveis.html`.
- **Exceção por pessoa**: `/usuarios`, em `usuarios.html:221-252`.
- **Minha conta**: `/minha-conta`.

## 0. Resumo

- **A estrutura está sã.**
  - Toda permissão de `PERMISSOES` está em exatamente um lugar: um módulo de `MODULOS_NIVELADOS` ou `PERMISSOES_SO_DO_PERFIL`. `_conferir_niveis` (rbac.ts:828) trava isso na carga do módulo.
  - O padrão de cada perfil reproduz a matriz.
  - `parecer.assinar` e `laudo.criar`, a administração de acesso e as permissões de governo nunca vêm por nível.
  - A única permissão retirada (`admin_ti/indicador.ver`) não volta por nenhum caminho.
  - Os 124 testes de rbac, níveis e módulos passam.
- **O banco local está igual ao código**: 11 perfis, 46 permissões e `perfil_permissao` idêntico à matriz. As tabelas `perfil_nivel_modulo` e `usuario_nivel_modulo` estão vazias.
- **A desarmonia está em três lugares:**
  1. **"Operação" desfaz exclusões deliberadas da matriz.** O nível não conhece o "teto" do perfil (§2.1). É a divergência mais séria.
  2. **As duas telas recortam o mundo de formas diferentes:**
     - a Matriz agrupa por `GRUPOS_PERMISSAO_TELA` (7 grupos) e a outra tela por `MODULOS_NIVELADOS` (4 módulos);
     - existe um terceiro mapa, `MODULO_POR_PERMISSAO`, com outros códigos;
     - a Matriz mistura permissões "só do perfil" dentro dos módulos;
     - nenhuma tela mostra o que é do titular (§3).
  3. **Textos desatualizados ou que os níveis desmentem**, e um texto que vem do banco e não se atualiza pela semente (§4).

**Fontes da verdade recomendadas**

| Assunto | Fonte |
|---|---|
| O que o perfil pode por ofício (inclusive o que nunca pode) | `MATRIZ_PERFIS` |
| Quais permissões formam cada módulo e o que é consulta ou escrita | `MODULOS_NIVELADOS` + `PERMISSOES_SO_DO_PERFIL` |
| Efeito por perfil | `liberacao_modulo.perfis_com_niveis` |
| Efeito por pessoa | `rbac.perfis_vigentes` + `PERMISSOES_DO_TITULAR` |
| Texto de cada permissão | `GRUPOS_PERMISSAO_TELA`, só como dicionário de rótulos e não como agrupamento |

## 1. Leitura do padrão: perfil × módulo

Resultado de `nivel_lido` sobre `MATRIZ_PERFIS`. Escopos: S = total, E = equipe/unidade, P = próprio, A = agregado.

| perfil | escopo | aceita nível | Processos SEI | Gestão de EPI | Certificados | Demandas |
|---|---|---|---|---|---|---|
| superintendente | E | sim | Operação | Operação | Operação | Operação |
| coordenador_csso | E | sim | Operação | Operação | Operação | Operação |
| engenheiro_seguranca | E | sim | Operação | Parcial (−entregar, −estoque) | Operação | Operação |
| medico_trabalho | E | sim | Operação | Parcial (−catalogo, −entregar, −estoque) | Operação | Operação |
| tecnico_seguranca | E | sim | Parcial (−atribuir, −parecer.anular) | Operação | Parcial (−certificado.anular, −mesclar) | Operação |
| secretaria_csso | E | sim | Parcial (sem parecer.*, −atribuir) | Parcial | Parcial (−gerenciar, −anular, −mesclar) | Operação |
| almoxarife_sesmt | E | sim | Sem acesso | Parcial (−catalogo, −requisitar, −analisar) | Sem acesso | Operação |
| consulta_progep | E | sim | Consulta | Consulta | Consulta | Sem acesso |
| auditor_interno | S | sim | Consulta | Consulta | Consulta | Consulta |
| servidor_consulta | P | não | (Parcial) | (Parcial) | (Parcial) | Sem acesso |
| admin_ti | A | não | Sem acesso | Sem acesso | Sem acesso | Sem acesso |

Os 10 "Parcial" dos perfis de equipe são todos deliberados, e cada um tem um comentário em rbac.ts:
- :397-404, o engenheiro "não opera o balcão";
- :447, o médico;
- :463 e :480, o técnico "emite e não anula";
- :510, o almoxarife;
- :542 e :571, a secretaria, "decidir é ato técnico" e sem exposição.

## 2. Divergências de comportamento (dado × dado, nível × rota)

### 2.1 "Operação" devolve o que a matriz tirou de propósito (grave)

- **Onde:** `niveis_modulo.ts`, `permissoes_do_nivel` e `permissoes_com_niveis`. Operação é "todas as do módulo", sem teto por perfil.
- **Efeito:** o superintendente pode, pela tela, dar a um perfil exatamente o que a matriz diz que ele não deve ter. A trava D2 deixa passar porque os perfis são E.

| perfil / módulo | o que Operação acrescenta | regra contrariada |
|---|---|---|
| tecnico / Certificados | certificado.anular, participante.mesclar | rbac.ts:480 "emite e não anula" |
| tecnico / Processos SEI | parecer.anular, processo.atribuir | idem, por simetria |
| engenheiro / EPI | epi.entregar, epi.estoque | :404 |
| medico / EPI | epi.catalogo, entregar, estoque | :447 |
| secretaria / EPI | epi.analisar, epi.ficha, catalogo, entregar, estoque | :571 RN-28; :542 sem exposição |
| secretaria / Processos SEI | parecer.criar, editar, emitir, anular | ato técnico |
| almoxarife / Processos SEI e Certificados | o módulo inteiro, inclusive parecer.* | :510 "não lê parecer" |
| almoxarife / EPI | epi.analisar, epi.catalogo | :510 "não decide o direito" |
| consulta_progep e auditor_interno | escrita em todos os módulos | :583, :666 "escrita nenhuma" |

- **O inverso também ocorre:**
  - "Consulta" num módulo Parcial pode acrescentar leitura: a secretaria em EPI "Consulta" ganha `epi.ficha`, que é dado nominal (§2.4).
  - Não existe nível que volte a um Parcial; só "Padrão" volta a ele.
- **Correção proposta:**
  - Criar em `niveis_modulo.ts` um teto por perfil, `NUNCA_POR_NIVEL: Record<perfil, permissao[]>`, com as exclusões que hoje estão só nos comentários.
  - Fazer `permissoes_com_niveis` aplicar Operação = (consulta ∪ escrita) − teto.
  - Fazer `_conferir_niveis` exigir que todo perfil que aceita nível tenha o teto declarado.
  - A tela /perfis/niveis passa a mostrar "Operação (até o teto do perfil)".
  - Para PROGEP e auditor, o teto equivale a "máximo Consulta".
- **Fonte da verdade:** a matriz.

### 2.2 Perfis que não são de equipe aceitam nível

- **Onde:** `aceita_nivel_modulo` (rbac.ts:854) decide pelo escopo (recusa P e A), não pela natureza do perfil. O comentário diz "só os de equipe".
- **Efeito:**
  - `consulta_progep` (E) pode receber Operação do superintendente.
  - `auditor_interno` (S) aparece com a opção na tela, embora a D2 impeça na prática.
- **Correção:** o teto de §2.1, ou restringir `aceita_nivel_modulo` a `PERFIS_DA_EQUIPE_CSSO` + superintendente.
- **Fonte:** a matriz.

### 2.3 Itens e rotas de módulo guardados por permissão "só do perfil" (o caso do "Sem acesso" que não esconde)

Registro como divergência entre Matriz e Acesso por módulo. A correção do menu já está em `fix/sisa-sem-acesso-esconde-modulo`, por isso não proponho outra aqui.

Itens de módulo cuja permissão é só do perfil e, por isso, não acompanham o nível. Eles fazem o módulo continuar no menu com "Sem acesso":

| Módulo | Item / rota | Permissão (só do perfil) | Quem tem | Efeito com o módulo em "Sem acesso" |
|---|---|---|---|---|
| Processos SEI | Importar `/importar` (modulos.ts:236-241; rotas em importacao.ts:60-135, inclusive o POST /importar/trello, que grava processos) | `catalogo.gerenciar` | superintendente, coordenador | o módulo continua no menu, e a rota ainda importa ou atualiza processos |
| Certificados | Instrutores `/treinamentos/assinaturas` (modulos.ts:459-463; treinamentos.ts:1212) | `assinatura.gerenciar` | super, coord, engenheiro, médico, técnico | o módulo continua no menu, e a rota ainda cadastra rubrica |
| EPI | CSV `/epis/relatorios/exportar` (epi_indicadores.ts:456-462, :533) | `indicador.ver` + `exportar` | 7 perfis | o menu fica certo (o item tem `tambem:["epi.ver"]`), mas a rota baixa o CSV agregado sem exigir `epi.ver` na equipe |
| Processos SEI | `/relatorios/exportar-processos` (relatorios.ts:239) | `indicador.ver` + `exportar` | idem | falta a exigência de `processo.ver`. O dano é menor, porque a listagem é filtrada pelo escopo |

Os itens Relatórios e Indicadores (modulos.ts:235, :345, :434) estão corretos: declaram `tambem` com a leitura do módulo.

**Dependência cruzada que a tela não conta:**
- Servidores, Catálogos e o Painel/Início de equipe (BASE) exigem `processo.ver`.
- O cadastro de servidor exige `processo.criar` e `processo.editar`.
- Logo, Processos SEI em "Sem acesso" tira essas telas de quem trabalha só com EPI ou Treinamentos, e "Consulta" tira o cadastro de servidor.
- **Decisão D4.**

**Na Matriz:**
- `GRUPOS_PERMISSAO_TELA` põe `exposicao.ver` em "Processos" e `assinatura.gerenciar`, `turma.inscrever_se` e `turma.todos_os_setores` em "Treinamentos".
- Quem põe Certificados em "Sem acesso" volta à Matriz e ainda vê, no grupo "Treinamentos e certificados", "Ver e gerir as turmas de todos os setores" e "Cadastrar a assinatura de instrutor".
- Parece que o nível não foi aplicado. É o mesmo sintoma, agora na tela (§3.1).

### 2.4 `epi.ficha` como "Consulta"

- **Onde:** niveis_modulo.ts:86-93.
- **O que acontece:** `epi.ficha` é a ficha nominal de outro servidor. Pôr a secretaria em EPI "Consulta" dá a ela um dado nominal que a base dela exclui (rbac.ts:542).
- **Decisão D3.** O teto de §2.1 resolve isso sem reclassificar.

### 2.5 Concessão de perfil conferida sobre as permissões cruas

- **Onde:** `_recusa_de_segregacao` (usuarios.ts:386-405) usa `_perfis_com_permissoes` (usuarios.ts:76), que ignora os níveis.
- **Efeito:** "ninguém concede mais do que tem" não enxerga o nível do perfil concedido. Hoje o risco é baixo, porque só o superintendente concede.
- **Correção:** aplicar `permissoes_com_niveis` antes de `_alem_do_que_tem`.
- **Fonte:** o efeito (`perfis_com_niveis`).

## 3. Divergências entre as telas

1. **Agrupamentos diferentes.**
   - A Matriz tem 7 grupos (`GRUPOS_PERMISSAO_TELA`, rbac.ts:189) e o Acesso por módulo tem 4 módulos.
   - "Processos e adicional" + "Pareceres e laudos" formam um módulo só, "Processos SEI".
   - Os nomes também diferem: "Treinamentos e certificados" na Matriz, "Certificados e Treinamentos" no Acesso por módulo.
   - **Correção:** a Matriz agrupa por `MODULOS_NIVELADOS` (mesmo nome, mesma ordem) + um grupo "Sempre do perfil" + um grupo "Do titular". `GRUPOS_PERMISSAO_TELA` fica só como dicionário de rótulos.
   - **Fonte:** `MODULOS_NIVELADOS`.
2. **A Matriz não mostra o nível que vale em cada módulo.**
   - Só mostra a pílula "ajustado por módulo" (perfis.html:50).
   - A rota recalcula o efeito por conta própria (usuarios.ts:1462-1463), em vez de usar `perfis_com_niveis`: duas implementações do mesmo cálculo.
   - **Correção:** reaproveitar `perfis_com_niveis` e mostrar a pílula Consulta, Operação ou Parcial por módulo.
3. **As permissões do titular não aparecem.** `PERMISSOES_DO_TITULAR` (rbac.ts:968) são processo.ver, parecer.ver, treinamento.ver, turma.inscrever_se, epi.ver e epi.requisitar, em escopo próprio.
   - Na Matriz, o almoxarife parece não ver processo nenhum.
   - Em /usuarios, a exceção "Sem acesso" diz que "retira o módulo só para esta conta" (usuarios.html:231), mas não retira o que é do titular.
   - Em /minha-conta, quem não tem perfil lê "Nenhum perfil concedido".
   - **Correção:** um cartão fixo "Toda conta ligada a servidor (titular)" e a frase "o nível não retira o que é do titular".
4. **A exceção por pessoa não mostra o efeito e oferece opções sem efeito.**
   - Para conta sem perfil de equipe, a tela oferece Consulta e Operação, que o serviço recusa (liberacao_modulo.ts:279), e "Sem acesso", que é gravado e não muda nada (rbac.ts:1392).
   - Há três rótulos para a mesma coisa: "Seguir o perfil", "Padrão (x)" e "Padrão do perfil (X)".
   - **Correção:** mostrar a coluna "vale hoje", desabilitar o formulário para conta sem perfil de equipe e usar um rótulo só.
5. **Os perfis listados e a ordem diferem.**
   - /perfis lista os 11, inclusive os inativos sem marcação, por código.
   - /perfis/niveis lista 9 abas, por nome; admin_ti e servidor_consulta só aparecem no rodapé.
   - **Correção:** mesma ordem nas duas, marcar os inativos, e dizer "não se ajusta por módulo" nos cartões desses dois perfis.
6. **O escopo aparece pela metade.**
   - A Matriz mostra o alcance; as abas de /perfis/niveis não mostram.
   - O recorte por setor promotor (`equipe_setor_promotor`) não aparece em nenhuma das duas.
   - /minha-conta não mostra escopo nem nível.
   - **Correção:** repetir o alcance no cabeçalho de cada aba e criar um "Meu acesso" na Minha conta, a partir de `perfis_vigentes`.
7. **"O que cada nível abre" mostra só códigos** (perfis_niveis.html:105-117), sem o texto da permissão. Também não diz que Processos SEI em "Sem acesso" tira as telas da BASE (§2.3).
8. **Link para uma tela que dá 403.** O técnico abre /perfis/niveis (a rota pede `processo.ver`), mas o link "fica em Usuários" (perfis_niveis.html:21) leva a /usuarios, que lhe dá 403. **Correção:** mostrar o link só para quem tem `perfil.conceder`.

## 4. Textos × código

| Onde | Texto | Problema | Correção |
|---|---|---|---|
| rbac.ts:583 `consulta_progep.base_normativa` | "Lê apenas parecer assinado" | O perfil lê processo, laudo, exposição, exporta, vê indicadores, certificados e ficha de EPI | Reescrever |
| rbac.ts:666 `auditor_interno` | "Leitura ampla, escrita nenhuma" | Bate com a matriz, mas o nível permite desmentir | O teto de §2.1, ou acrescentar "salvo liberação por módulo" |
| rbac.ts:510 `almoxarife_sesmt` | "não lê parecer, não vê exposição" | O teste niveis_modulo.test.ts:248 dá Consulta em Processos SEI a ele de propósito | Idem |
| rbac.ts:542 `secretaria_csso` | "Sem acesso a exposicao (dado mascarado - RN-19)" | Falso com EPI em Consulta ou Operação (epi.ficha). Ainda cita RN-19, que a branch textos-sem-rn tira de outros textos | Idem; tirar "RN-19" (ver §5.b) |
| rbac.ts:164, :239 `turma.todos_os_setores` | "Ver e gerir as turmas de todos os setores" | É só alcance: o auditor e a PROGEP não gerem nada | "Alcançar as turmas de todos os setores (gerir exige as permissões de turma)" |
| `servidor_consulta.nome` | "Servidor (consulta do próprio processo)" | Também cobre EPI e inscrição em turma | Ex.: "Servidor (os próprios dados)" |
| usuarios.ts:63 ESCOPO_TELA; perfis_niveis.html:121; liberacao_modulo.ts:196 | "agregado — só contagens" e "só agregado" | Depois da retirada de indicador.ver, o admin_ti não tem contagem nenhuma. São dois rótulos para a mesma coisa | Ex.: "sem dado — só administração técnica" |
| niveis_modulo.ts:4; usuarios.ts:1459; minha_conta.html:190 | "A coordenação escolhe" e "fale com a coordenação" | Só o superintendente tem `perfil.conceder` | "quem administra acesso (o superintendente)" |
| rbac.ts:728-732 | "NADA lê esta coluna… para quando existir a tela por módulo" | A tela existe e usa outro mapa | Atualizar (ver §5.a) |
| niveis_modulo.ts:190 (`nivel_lido`) | Cita só o técnico como exemplo de Parcial | Há 10 casos de Parcial | Comentário |
| perfis.html:33 | "doze perfis" | São 11 (12 com o administrador_sistema) | Comentário |
| usuarios.ts:1475 | passa `matriz: MATRIZ_PERFIS` | O template não usa | Remover |

## 5. Banco × código

- **Igualdade:** o banco está igual ao código, nos perfis, nos nomes, nas permissões, na `descricao`, na coluna `modulo` e em `perfil_permissao`. A retirada já foi aplicada. As tabelas de níveis estão vazias, e nenhuma linha é inválida.
- **a) Terceiro mapa de módulos.**
  - `permissao.modulo` vem de `MODULO_POR_PERMISSAO` (rbac.ts:734), com os códigos ADICIONAL, TREINAMENTOS, EPI e BASE. Os módulos nivelados usam processos-sei, certificados, epis e demandas.
  - As 12 permissões só do perfil caem em ADICIONAL ou TREINAMENTOS, e o próprio código diz que isso é "mentir na coluna".
  - Nada lê a coluna, por isso o efeito é nulo hoje.
  - **Correção:** derivar o mapa de `modulo_de_permissao(p)?.codigo ?? "PERFIL"` (e ajustar rbac.test.ts:108), ou apagar o mapa e a coluna.
  - **Fonte:** `MODULOS_NIVELADOS`.
- **b) A semente não atualiza `base_normativa`.**
  - `semear_rbac` (sementes.ts:111) só grava `base_normativa` quando cria o perfil, e a Matriz lê esse texto do banco (perfis.html:53).
  - Qualquer correção de texto da §4 no rbac.ts **não chega à tela** em bancos já semeados.
  - **Correção:** a semente atualizar `base_normativa` como já faz com `nome`.
  - **Fonte:** o código.
- **c) Sobras que a semente não remove.** A semente não apaga sobras de `perfil_permissao` que não estejam em `PERMISSOES_RETIRADAS`, nem desativa um perfil que saia da matriz. É risco latente, sem caso hoje.

## 6. Branches em andamento

Nenhuma tem commit além de main. O trabalho está sem commit nos worktrees em `.claude/worktrees/agent-*`.

- **`feat/sisa-perfil-admin-sistema`**
  - `administrador_sistema` tem todas as permissões menos `SO_DO_TECNICO_HABILITADO`: 44 de 46, e permissão nova entra sozinha nele. Escopo S.
  - `aceita_nivel_modulo` é falso para ele, por meio de `PERFIS_NO_NIVEL_MAIS_ALTO`, e `nivel_lido` dá Operação nos 4 módulos.
  - Está coerente com o modelo. Pendências para a harmonia:
    - a `base_normativa` dele terá o problema de §5.b;
    - a Matriz precisa marcá-lo como "não se ajusta por módulo";
    - o valor `OPERACAO` do mapa nunca é lido, só as chaves;
    - no teto de §2.1, ele seria o único perfil sem teto, e convém dizer isso no código.
- **`feat/sisa-dono-treinamento`**
  - Não cria permissão; o ajudante usa `turma.criar`, e `_conferir_niveis` fica intacto.
  - A hierarquia é uma camada a mais: é preciso ter a permissão **e** ser dono, superior ou ajudante. Um coordenador rebaixado a Consulta perde o ato, o que está coerente.
  - Na fusão com a branch do admin, unificar `ORDEM_HIERARQUICA` com `TOPO_DA_HIERARQUIA` e remover `PERFIS_PREVISTOS_NA_HIERARQUIA`.
- **`feat/sisa-login-email`:** não afeta a matriz. Vai dar conflito de texto com a do admin em `POST /usuarios/:id/dados`, e as migrações 0017, 0018 e 0020 vão dar conflito no `_journal.json` (não existe 0019).
- **`feat/sisa-duplicados`:** `turma.inscrever` passa a permitir uma junção restrita sem `participante.mesclar`. Fica no mesmo módulo, mas a Matriz não mostra essa nuance.
- **`feat/sisa-textos-sem-rn`** (working tree): só tira "(RN-19)" do motivo de `exposicao.ver`. Ficam "RN-19" na `base_normativa` da secretaria, que está no banco (§5.b), e em comentários.
- **`fix/sisa-sem-acesso-esconde-modulo`:** trata o menu de §2.3. Os itens daquela tabela servem para conferir a cobertura dela, sobretudo a rota de Importar, a de Instrutores e o CSV de EPI, que são **rotas** além do menu.

## 7. Como garantir a harmonia daqui para frente

1. **Uma fonte, telas derivadas.**
   - A Matriz e o Acesso por módulo passam a ser duas vistas do mesmo objeto: `perfis_com_niveis(perfil)` → por módulo, {nível lido, efetivo, permissões} + "sempre do perfil" + "do titular".
   - A Matriz é a vista "todos os perfis, só leitura"; o Acesso por módulo é "um perfil, editável".
   - Some o agrupamento próprio da Matriz, e `GRUPOS_PERMISSAO_TELA` vira só `TEXTO_PERMISSAO`.
2. **Um mapa só de permissão → módulo.** `MODULO_POR_PERMISSAO` derivado de `MODULOS_NIVELADOS`, ou removido.
3. **Novas conferências na carga do módulo**, junto de `_conferir_niveis`:
   - todo perfil que aceita nível tem teto declarado (`NUNCA_POR_NIVEL`), e o teto ∩ padrão = ∅;
   - nenhum perfil cujo texto diz "escrita nenhuma" pode chegar a escrita por nível.
4. **Testes que falham quando as duas divergem:**
   - para todo perfil × módulo × nível, `permissoes_com_niveis` ⊆ (matriz do perfil ∪ consulta do módulo), salvo o que o teto liberar explicitamente;
   - todo item de menu de um módulo nivelado exige, no `permissao` ou no `tambem`, uma permissão daquele módulo; e toda rota sob o prefixo do módulo chama `exigir_na_equipe(<leitura do módulo>)`. Isso pega Importar, Instrutores e o CSV;
   - o HTML de /perfis e o de /perfis/niveis, renderizados para o mesmo perfil com níveis gravados, listam o mesmo conjunto efetivo de permissões;
   - a semente seguida de SELECT dá `perfil.base_normativa` = código.
5. **Textos que restringem ficam com teste.** Uma lista curta de "frases de restrição" por perfil, ligada a permissões. Ex.: almoxarife "não lê parecer" ↔ `parecer.ver` ∉ efetivo em qualquer nível. Se a frase não vale mais, o teste obriga a reescrevê-la.

## 8. Decisões que você precisa tomar

**D1. "Operação" pode passar do que a matriz exclui deliberadamente?**
- (a) Não: um teto por perfil (`NUNCA_POR_NIVEL`), e Operação = módulo − teto.
- (b) Sim, mas com aviso na tela listando o que se acrescenta além do padrão.
- (c) Manter como está.
- **Recomendação: (a).** As exclusões têm base normativa (ato técnico, "emite e não anula", segregação do almoxarifado). Hoje elas existem só nos comentários e um clique as desfaz.

**D2. PROGEP e auditor podem receber nível?**
- (a) Só até Consulta.
- (b) Não aceitam nível nenhum.
- (c) Como está, até Operação.
- **Recomendação: (a).** Permite fechar módulo para eles sem nunca dar escrita. Se D1 = (a), sai de graça pelo teto.

**D3. `epi.ficha` (ficha nominal de outro servidor) é "Consulta"?**
- (a) Continua consulta, e o teto da secretaria a exclui.
- (b) Vira escrita, ou "só do perfil".
- **Recomendação: (a).** Para EPI, ler a ficha é consulta; o problema é só a secretaria, e o teto resolve.

**D4. Processos SEI em "Sem acesso" deve levar junto Servidores, Catálogos e o Painel da base?**
- (a) Não: essas telas passam a exigir "qualquer leitura de módulo de equipe".
- (b) Sim, como hoje, mas a tela avisa.
- (c) Criar um "módulo" Base nivelável.
- **Recomendação: (a).** Quem trabalha só com EPI ou Treinamentos precisa achar o servidor.

**D5. Como a Matriz se organiza?**
- (a) Pelos 4 módulos + "Sempre do perfil" + "Do titular", com a pílula do nível em cada módulo.
- (b) Manter os 7 grupos e só marcar as permissões só do perfil.
- **Recomendação: (a).** É o que torna as duas telas a mesma coisa.

**D6. Fundir as telas?**
- (a) Duas vistas do mesmo objeto: a Matriz lê, os Níveis editam, e uma leva à outra.
- (b) Uma tela só com abas.
- **Recomendação: (a)** agora, e reavaliar depois do admin_sistema.

**D7. A coluna `permissao.modulo`.**
- (a) Derivar dos módulos nivelados, com "PERFIL" para as só do perfil.
- (b) Remover a coluna e `MODULO_POR_PERMISSAO`.
- **Recomendação: (a)**, se algum relatório ou a auditoria puder usá-la; senão, (b).

**D8. A semente deve sobrescrever `base_normativa`?**
- (a) Sim, como faz com `nome`, porque o código é a fonte.
- (b) Uma migração a cada texto mudado.
- **Recomendação: (a).** Sem isso, nenhuma correção de texto da §4 chega à tela.

**D9. Exceção por pessoa em conta sem perfil de equipe.**
- (a) Esconder o formulário.
- (b) Mostrar, mas explicar que não tem efeito.
- **Recomendação: (a).**

**D10. Rótulos.** Adotar: "Padrão do perfil (x)"; "Certificados e Treinamentos"; "quem administra acesso (o superintendente)"; e a nova `base_normativa` da PROGEP. **Recomendação:** aprovar em bloco junto com D8.

**D11. Ordem de fusão das branches.**
- Sugestão: admin-sistema → dono-treinamento (unificando a hierarquia) → login-email (resolver /usuarios/:id/dados e renumerar as migrações) → depois as correções desta análise.
- Assim o teto de D1 já nasce sabendo que o administrador_sistema não tem teto.
