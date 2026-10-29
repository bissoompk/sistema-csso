# Proposta — simplificar `nuvem/src/servicos/rbac.ts` sem perder coerência

Análise feita com 4 agentes em paralelo, cada um sobre uma frente do arquivo
(1977 linhas): catálogo de permissões, matriz de perfis/débito histórico,
sistema de escopo/alcance/hierarquia, e mapeamento de uso real + testes.
Nenhum código foi alterado — isto é só a proposta, para você escolher o que
aplicar.

**Conclusão geral:** a maior parte da densidade do arquivo é proposital —
várias coisas que parecem duplicação são na verdade garantias distintas de
segurança/LGPD (RN-19, `PERMISSOES_RETIRADAS`, a separação `cobre_inteiro` /
`_cobre`). As simplificações reais e de baixo risco estão concentradas em um
número pequeno de pontos.

## O que simplificar (proposto)

**Itens 1–4 já aplicados em `rbac.ts` (2026-10-28)** — type-check limpo e os
171 testes dos arquivos focados em RBAC (`rbac.test.ts`,
`correcoes_base.test.ts`, `perfil_admin_sistema.test.ts`,
`governanca_acesso.test.ts`, `sementes.test.ts`, `escopo_por_permissao.test.ts`,
`niveis_modulo.test.ts`) passaram sem alteração. A suíte completa do projeto
está rodando para confirmação final.

### 1. [BAIXO risco] Corrigir comentário desatualizado
`rbac.ts:228` diz "rbac.test.ts confere", mas quem checa
`PERMISSOES`↔`GRUPOS_PERMISSAO_TELA` hoje é `testes/correcoes_base.test.ts:471-474`.
Só acerto de comentário, zero mudança de comportamento.

### 2. [BAIXO risco] Remover `PERFIS_PREVISTOS_NA_HIERARQUIA`
`rbac.ts:1101-1102` é um "forward declare" para um perfil de outra branch
(`feat/sisa-dono-treinamento`) que já foi incorporada neste branch —
`administrador_sistema` já está em `MATRIZ_PERFIS` e em `_conferir_hierarquia`.
A entrada no Set nunca é mais exercitada. Proposta: remover a constante e o
filtro que a usa, atualizar o comentário em `rbac.ts:1074-1076`.
**Única ressalva:** se esse padrão de "forward-declare para a próxima branch"
é algo que você quer manter como mecanismo geral (não só para este caso já
resolvido), melhor deixar o Set vazio e documentado do que apagar tudo.

### 3. [BAIXO risco] Extrair o trio `ocorrencia.*` repetido
As permissões `ocorrencia.registrar/ver/tratar` (patch de 28/10/2026) estão
byte-idênticas em 5 perfis: `coordenador_csso`, `engenheiro_seguranca`,
`medico_trabalho`, `tecnico_seguranca`, `secretaria_csso`. Extrair como
`PERMISSOES_OCORRENCIA_EQUIPE` e espalhar (`...PERMISSOES_OCORRENCIA_EQUIPE`)
nos 5 arrays. Conteúdo idêntico, não só parecido — risco mínimo, e evita que
o próximo patch tenha que tocar 5 lugares à mão (como o de 28/10 já teve que
fazer).

### 4. [BAIXO risco] Compor `servidor_consulta` a partir de `PERMISSOES_DO_EXTERNO`
`servidor_consulta` (rbac.ts:880-890) é hoje uma cópia manual de
`PERMISSOES_DO_EXTERNO` + `epi.ver` + `epi.requisitar`. Trocar para
`[...PERMISSOES_DO_EXTERNO, "epi.ver", "epi.requisitar"]` remove a duplicação
silenciosa sem mudar nada observável.

### 5. [MÉDIO risco] Compor `engenheiro_seguranca`/`medico_trabalho`/`tecnico_seguranca`
a partir de uma base comum + delta, em vez de arrays de 35–55 linhas
digitados à mão cada um. É aqui que o débito histórico mais aparece: cada
patch de 2026 (acidentes 23/10, ocorrências 28/10) precisou repetir manualmente
em 3–5 arrays. **Mas** a subdivisão de dados de saúde entre engenheiro/médico
(engenheiro vê `saude_ver` mas não `saude_detalhe_ver`/`saude_registrar`) é
conteúdo normativo LGPD, não acidente de cópia — qualquer composição precisa
reproduzir essa exceção explicitamente, não "deduzir" por subtração mecânica
(ao contrário do `administrador_sistema`, que É uma subtração mecânica válida).
Recomendo fazer isso com testes (`matriz_harmonia.test.ts`, `rbac.test.ts`)
rodando a cada passo, não de uma vez.

### 6. [MÉDIO risco] Eliminar o "modo de compatibilidade" (`concessoes === null`) de `UsuarioAtual`
Confirmado por grep: em produção, `concessoes` nunca é `null` (só 2 sites em
`src/`, ambos sempre populados). O ramo `null` existe só porque ~69 arquivos
de teste constroem `UsuarioAtual` à mão sem passar `concessoes`. Proposta:
um helper central em `testes/ajuda.ts` que sempre deriva `concessoes` a partir
de `permissoes`/`perfis`/`campi`, eliminando o ramo de compatibilidade da
classe inteira (`#alcance`, `pode()`, `ve_nome_na_linha`, `setor_equipe.ve_todos`).
Ganho real de clareza, mas é mecânico em 69 call sites — não é um ajuste de
uma linha, e alguns testes podem depender propositalmente do comportamento
antigo (há um bug D1/D9 documentado que o modo "com concessões" corrigiu;
testes que ainda simulam isso precisam de concessões explícitas, não do modo
antigo). Fazer com cautela, revisando teste por teste.

## O que NÃO simplificar (risco alto / já é mínimo necessário)

- **`PERMISSOES` vs `GRUPOS_PERMISSAO_TELA`** — parecem duplicadas, mas uma é
  texto já gravado em banco de produção (ASCII, não pode mudar sem migração)
  e a outra é texto de tela, livre para reformular. Juntar as duas re-acopla
  algo deliberadamente separado.
- **`PERMISSOES_RETIRADAS` + "semeadura nunca remove"** — é uma decisão
  explícita contra remoção silenciosa de permissão (proteção contra apagar
  uma linha da matriz por engano, ou restaurar um backup antigo que
  resenhuliente uma permissão já revogada). Custo atual real: 2 entradas depois
  de meses de patches — não é fardo.
- **`cobre_inteiro` vs `_cobre`** — parecem a mesma coisa, mas
  `_cobre` deliberadamente NUNCA deixa o alcance agregado cobrir outro
  agregado (evita o bug D9/D15 de vazar contagem pequena entre campi),
  enquanto `cobre_inteiro` (checagem de governança "ninguém concede mais do
  que tem") permite. Unificar arriscaria reintroduzir o bug que a separação
  corrigiu.
- **As 4 variantes de RN-19** (`ve_dado_nominal`, `_em`, `_sem_recorte`,
  `ve_nome_na_linha`) — grep de uso confirma que cada uma resolve uma forma
  de tela diferente (conta inteira / leitura específica / tela agregada sem
  recorte / linha individual) sem overlap real de chamadores. Colapsar
  perderia a granularidade que corrigiu os bugs D9/D15.
- **Exports hoje sem uso fora de `rbac.ts`** (`DadosPerfil`, `PermissaoRetirada`,
  `ESCOPOS_VALIDOS`, `alcanca_algo`, `PERMISSOES_DE_GOVERNO`,
  `_conferir_hierarquia`, `NIVEL_HIERARQUICO_POR_PERFIL`, entre outros) — a
  lógica é usada internamente; só a palavra `export` é desnecessária. Proposta
  (opcional, risco baixíssimo): remover o `export` onde nada de fora importa,
  sem apagar o código. Não essencial, mas reduz a superfície de API visível.

## Ordem sugerida, se você quiser aplicar

1. Itens 1–4 (baixo risco) de uma vez, com os testes existentes passando.
2. Item 5 (perfis técnicos), um perfil por vez, confirmando com
   `matriz_harmonia.test.ts`/`rbac.test.ts` a cada um.
3. Item 6 (modo de compatibilidade), separado, por ser o de maior superfície
   de mudança (69 arquivos de teste).

Nada disso foi aplicado ainda — me diga quais itens você quer que eu
implemente e eu faço um a um, testando a cada passo.
