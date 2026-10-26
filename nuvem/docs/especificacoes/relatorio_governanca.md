# Verificação: Usuários e governança de acesso (CSSO / Sisa)

## Veredito geral

**Não, a governança não cobre todas as situações do sistema, e o fluxo tem quebras.**

Cada perfil, quando é o único da conta, está correto:
- toda rota de escrita da área exige a permissão certa (por curl, 403 para coordenador, admin e servidor);
- as permissões são relidas a cada requisição;
- inativar e redefinir senha derrubam as sessões;
- a troca obrigatória de senha vale em todas as rotas;
- a trava D66 funciona no caso simples (ninguém inativa a si mesmo nem a última conta que concede).

As falhas estão em quatro lugares:
1. **Combinação de perfis.** O escopo e os campi valem para a conta inteira, não para cada perfil. Isso vaza dado da RN-19.
2. **Segregação de funções.** Quem concede perfil e atesta habilitação pode fazer as duas coisas para si mesmo. E o admin_ti pode tomar contas técnicas redefinindo a senha delas.
3. **Ciclo de vida.** Não há como encerrar uma habilitação nem corrigir nome, e-mail ou login. O bloqueio por tentativas e a troca de senha têm falhas de lógica.
4. **Clareza da tela.** O campus da concessão não aparece. O alvo da concessão já vem pré-selecionado. Não há validação de datas, de duplicidade nem de perfil inativo.

## Mapa do fluxo atual

| Etapa | Onde | O que está certo | Onde quebra |
|---|---|---|---|
| **Criação** | POST /usuarios (usuarios.ts:333-422) | Recusa duplicado com o popup reaberto; perfil e servidor entram na mesma transação; senha provisória com `no-store` | Duplicidade comparada com maiúsculas e minúsculas (:351-355), mas o login ignora a caixa (autenticacao.ts:262-271). Não existe edição de nome, e-mail ou login. A conta criada pelo admin_ti nasce sem perfil e ninguém é avisado |
| **Vínculo com servidor** | POST /usuarios/:id/servidor (:442) | Exige perfil.conceder; recusa servidor já ligado a outra conta | Quem concede pode ligar a própria conta a outro servidor (melhoria). A lista não mostra contas sem vínculo |
| **Senha** | /usuarios/:id/senha (:475), /trocar-senha, autenticar | Revoga sessões; protege as contas de governo; troca obrigatória | O admin_ti redefine a senha de coordenador, engenheiro e médico (**alta**). A troca aceita repetir a senha provisória. Depois que o bloqueio vence, um único erro bloqueia de novo. A etiqueta "bloqueado" fica para sempre. O texto da tela de troca diz o contrário do que acontece. Não há confirmação antes de redefinir |
| **Perfis** | /usuarios/:id/atribuicoes (:539), _conceder (:181), encerrar (:577), ato (:613) | Trava da última conta que concede; ato normativo "pendente" auditado | Pode conceder a si mesmo (**alta**). O escopo da conta é o mais largo entre os perfis, e os campi são somados (**alta**). Não valida datas, duplicidade nem perfil inativo. O alvo vem pré-selecionado. O campus não aparece |
| **Habilitação** | /habilitacoes (:697), /habilitacoes/:id/conta (:647) | Exige habilitacao.atestar; tudo vai para a trilha | Pode atestar a si mesmo ou ligar a habilitação de outra pessoa à própria conta (**alta**). Não há como encerrar nem corrigir. Não confere se a conta está ativa nem se já tem outra habilitação |
| **Desativação** | /usuarios/:id/inativar (:513) | Travas D66; derruba sessões | Não avisa sobre processos e demandas que ficam órfãos. A trava só olha o dia de hoje: não vê vigência que vence sozinha nem concessão futura, e não há trava contra dois encerramentos ao mesmo tempo |

## Defeitos confirmados, por gravidade

### ALTA

**D1. Somar perfis amplia o alcance: escopo e leitura nominal valem para a conta inteira.** CONFIRMADO. (Junta "cobertura 1", "perfis 1 e 2".)
- Evidência:
  - `rbac.ts:826-838`: o escopo é o mais largo entre os perfis, na ordem S>E>A>P.
  - `rbac.ts:996`: com `ESCOPO_AGREGADO`, `aplicar_escopo` devolve `undefined`, ou seja, nenhum filtro.
  - `rbac.ts:847-849`: `ve_dado_nominal = exposicao.ver || epi.ficha`.
  - `rbac.ts:518`: o almoxarife tem `epi.ficha`.
  - `rbac.ts:631`: `servidor_consulta` traz `processo.ver` e `parecer.ver`.
  - `_conceder` não confere nenhuma combinação.
- Cenários:
  - O admin_ti recebe `servidor_consulta` para se inscrever em turma. O escopo vira A, sem filtro, e ele lê processos e pareceres de todos os campi.
  - O almoxarife recebe `servidor_consulta`. O escopo vira E com leitura nominal, e ele lê processos e pareceres com nome, contra a base normativa "não lê parecer, não vê exposição" (rbac.ts:490).
- Correção:
  - Calcular o escopo por permissão de origem, ou criar `processo.ver_proprio` e `parecer.ver_proprio`.
  - No mínimo: tratar A como `sql\`false\`` nas leituras linha a linha, e recusar ou avisar ao combinar `servidor_consulta` com outro perfil.
  - Teste de combinação.

**D2. Quem concede perfil concede a si mesmo, inclusive um perfil com mais poder que o próprio.** CONFIRMADO.
- Evidência:
  - `usuarios.ts:539-570` só faz `exigir("perfil.conceder")` e não compara o alvo com `usuario.id`.
  - Inativar e redefinir senha fazem essa comparação (:267, :299).
  - O superintendente fica de propósito sem `parecer.assinar` e `laudo.criar` (`SO_DO_TECNICO_HABILITADO`, rbac.ts:304).
- Cenário: o superintendente concede a si mesmo `coordenador_csso` ou `engenheiro_seguranca` e passa a ter `parecer.assinar`. Se conceder a si mesmo `auditor_interno`, ganha escopo total.
- Correção: recusar quando o alvo é o próprio usuário e quando o perfil concedido tem permissão que quem concede não tem. Gravar um evento próprio se houver exceção. Testes.

**D3. Quem atesta habilitação atesta a si mesmo e pode ligar a habilitação de outra pessoa à própria conta.** CONFIRMADO.
- Evidência:
  - `usuarios.ts:738` grava `usuario_id` direto do formulário, com `atestado_por = usuario.id` (:740).
  - `usuarios.ts:647-695` troca o `usuario_id` de qualquer habilitação, sem conferir SIAPE nem `servidor_id`.
  - `pode_subscrever` (rbac.ts:946) aceita qualquer habilitação vigente ligada à conta.
- Cenário: combinado com D2, uma única pessoa passa a assinar parecer e laudo. Isso contorna a RN-01 e a IN 15/2022, art. 10, §2º, I.
- Correção: recusar quando o titular é quem atesta, ou quando a conta escolhida é a de quem pede. Exigir que o SIAPE bata com o servidor vinculado à conta, ou uma justificativa.

**D4. O admin_ti redefine a senha de coordenador, engenheiro e médico e passa a operar como eles.** CONFIRMADO (código e servidor).
- Evidência:
  - `usuarios.ts:298-306`: a trava só protege `eh_conta_de_governo`.
  - `PERMISSOES_DE_GOVERNO` (rbac.ts:858-864) não inclui `exposicao.ver`, `parecer.assinar`, `laudo.criar` nem `epi.ficha`.
  - GET /usuarios como admin mostra `action="/usuarios/{2,3,4,5,6,8}/senha"` nas linhas de coordenador, engenheiro, técnico, médico, secretaria e almoxarife.
- Cenário: o admin_ti redefine a senha do médico, entra com a provisória e faz ele mesmo a troca obrigatória. A partir daí lê exposição nominal e assina parecer, porque a habilitação está ligada à conta.
- Correção: só redefinir quando as permissões do alvo estiverem contidas nas de quem redefine, ou exigir `perfil.conceder`. Revisar DESVIOS.md:579-586 e o teste "admin_ti redefine a conta comum".

### MÉDIA

**D5. A troca obrigatória aceita repetir a senha provisória.** CONFIRMADO.
- Evidência: nem `trocar_senha` (autenticacao.ts:588-601) nem POST /trocar-senha (rotas/autenticacao.ts:213-243) comparam a senha nova com a atual. A provisória `xxxx-xxxx-99` passa na política.
- Efeito: anula a premissa citada em usuarios.ts:293-295, de que a troca obrigatória contém a redefinição.
- Correção: recusar quando `conferir_senha(hash_atual, nova)` for verdadeiro. Teste.

**D6. Depois que o bloqueio vence, um único erro bloqueia a conta de novo, com uma mensagem falsa.** CONFIRMADO.
- Evidência:
  - `autenticacao.ts:337-340`: `tentativas = conta.tentativas_falhas + 1`, sem zerar quando `bloqueado_ate` já passou. O contador só zera no login certo (:357) ou na redefinição.
  - A mensagem em :329-334 fala em "5 tentativas seguidas".
  - O mesmo acontece em `conferir_senha_atual` (:560-572), que nesse caso ainda derruba as sessões.
- Correção: se `bloqueado_ate` já passou, recomeçar com `tentativas = 1` e `bloqueado_ate = null`. Teste com o relógio adiantado.

**D7. A etiqueta "bloqueado" em /usuarios fica para sempre, e não há como desbloquear sem trocar a senha.** CONFIRMADO.
- Evidência: `usuarios.html:96` usa `{% if u.bloqueado_ate %}` sem comparar com a hora atual. Não existe rota de desbloqueio.
- Correção: mostrar "bloqueado até HH:MM" só quando `bloqueado_ate > agora`. Criar a ação "Desbloquear", auditada.

**D8. O texto da tela de troca de senha diz que as sessões continuam abertas, mas as outras caem.** CONFIRMADO.
- Evidência: `trocar_senha.html:26` diz uma coisa; `trocar_senha` chama `revogar_do_usuario(..., token_atual)`.
- Correção: corrigir o texto e mostrar quantas sessões foram encerradas, em vez de redirecionar para /inicio sem aviso.

**D9. O campus de uma concessão restringe ou estende todos os perfis da conta.** CONFIRMADO.
- Evidência:
  - `rbac.ts:898`: só entra na união a concessão que tem campus; "todos" é ignorado.
  - `rbac.ts:1017-1019`: o filtro usa os campi da conta.
- Cenários:
  - O coordenador sem campus recebe técnico no campus JK e passa a ver só JK.
  - Uma conta com secretaria no campus A e coordenador no campus B anula parecer também em A.
- Correção: guardar o escopo por perfil e aplicá-lo por permissão (mesmo redesenho de D1). No mínimo, avisar na concessão.

**D10. Habilitação técnica não se encerra nem se corrige.** CONFIRMADO.
- Evidência: o único `update(profissional_habilitado)` está em `usuarios.ts:675-678` e troca só a conta. A coluna `vigencia_fim` existe (esquema/seguranca.ts:137), mas nada a preenche.
- Cenário: o engenheiro se aposenta e a habilitação continua escolhível como signatário (pareceres.ts:425).
- Correção:
  - Criar POST /habilitacoes/:id/encerrar, com evento `HABILITACAO_ENCERRADA` e valor anterior e novo.
  - Permitir corrigir título, conselho e registro, com auditoria.

**D11. Não há como corrigir nome, e-mail ou login de uma conta.** CONFIRMADO.
- Evidência: a lista de rotas de usuarios.ts (:327-784) não tem edição.
- Efeito: o e-mail é a credencial de entrada e a base do vínculo automático com o servidor.
- Correção: POST /usuarios/:id/dados, com conferência de duplicidade sem diferenciar maiúsculas e auditoria campo a campo. Exigir `perfil.conceder` quando o alvo for conta de governo.

**D12. Login e e-mail são únicos só com a mesma caixa, mas a entrada ignora a caixa.** CONFIRMADO.
- Evidência:
  - `usuarios.ts:351-355` usa `eq` exato.
  - `autenticacao.ts:262-271` compara em minúsculas e fica com o menor id.
- Efeito: duas contas disputam a mesma credencial, e as falhas de uma bloqueiam a outra.
- Correção: conferir com `lower()` e criar UNIQUE em `lower(login)` e `lower(email)`.

**D13. "Conceder perfil" já vem com a primeira conta selecionada.** CONFIRMADO.
- Evidência: `usuarios.html:371-372`: `<select name="usuario_alvo" required>` sem opção vazia. A lista também traz contas inativas sem marca.
- Efeito: a recusa "Escolha a conta" (usuarios.ts:561) nunca acontece pela tela, e o perfil pode ir para a pessoa errada.
- Correção:
  - Colocar uma opção vazia `disabled selected`.
  - Marcar ou tirar as contas inativas.
  - Oferecer "Conceder" dentro do Gerir, com o alvo já preenchido.

**D14. A Consulta PROGEP lê parecer em RASCUNHO, embora a base do perfil diga "lê apenas parecer assinado".** CONFIRMADO.
- Evidência:
  - `rbac.ts:563` diz a regra.
  - `parecer.no_escopo` (parecer.ts:176-179) só filtra pelo escopo.
  - GET /pareceres/:id (pareceres.ts:222-226) não olha o estado.
  - `consulta_progep` não é usado em nenhum lugar fora de rbac.ts.
- Correção: exigir estado EMITIDO ou ASSINADO para quem não tem `parecer.editar`.

**D15. O almoxarife vê o nome de quem demanda, inclusive em demanda de adicional.** CONFIRMADO.
- Evidência: `demandas.ts:146-148` usa `ve_dado_nominal`, que inclui `epi.ficha`.
- Efeito: a secretaria, que atende a mesma fila, vê só o código opaco. A regra fica invertida.
- Correção: usar `pode("exposicao.ver")` fora das telas de EPI. Revisar os outros usos de `ve_dado_nominal`.

**D16. Funções do titular não chegam a quem tem perfil de equipe.** CONFIRMADO.
- Evidência:
  - `turma.inscrever_se` só existe em `servidor_consulta` (rbac.ts:631).
  - `turmas.ts:446` e `:466` exigem essa permissão.
  - Almoxarife e admin_ti não têm `treinamento.ver` nem `epi.requisitar`.
- Efeito: o único remédio é somar `servidor_consulta`, o que cai em D1.
- Correção: um conjunto de permissões "do titular", sempre em escopo próprio, ou rotas do titular liberadas por ter `servidor_id` vinculado.

**D17. Ninguém é avisado de que a última concessão de `perfil.conceder` vai vencer pela data, e a trava não tem bloqueio de concorrência.** CONFIRMADO.
- Evidência:
  - `_contas_que_concedem` (usuarios.ts:213-233) só olha `vigente_em(a, hoje)` e não pega lock.
  - `_conceder` aceita `vigencia_fim` para o superintendente sem conferir se sobra alguém depois.
- Efeito: o sistema fica sem ninguém que conceda perfil, e a linha de comando só redefine senha.
- Correção:
  - Calcular a cobertura depois da data de fim e avisar no sino.
  - Usar `pg_advisory_xact_lock` no encerramento, na inativação e na concessão.
  - Incluir na ferramenta de linha de comando uma opção para conceder superintendente.

**D18. As travas de governo ignoram concessões com início futuro.** CONFIRMADO.
- Evidência: as recusas usam `perfis_vigentes` (só o dia de hoje), e `_conceder` aceita início futuro (usuarios.ts:194).
- Cenário: a conta recebe superintendente com início na semana que vem. Hoje o admin_ti redefine a senha dela e, no dia do início, tem uma conta com `perfil.conceder`.
- Correção: nas travas, considerar atribuições vigentes ou futuras.

**D19. "Resetar senha" age com um clique, sem confirmação.** CONFIRMADO.
- Evidência: `usuarios.html:120-126` posta direto. Inativar e encerrar perfil pedem confirmação.
- Correção: usar o mesmo padrão `botao_cadastro` + popup de confirmação.

**D20. O campus (escopo) da concessão não aparece em nenhum lugar da tela.** CONFIRMADO.
- Evidência: a pílula (usuarios.html:82-83) e o Gerir (:135-141) mostram só o nome do perfil e a vigência.
- Correção: mostrar "Perfil · campus" (ou "· todos") na pílula e no cartão do Gerir.

**D21. A trilha não registra login, falha, bloqueio nem a troca de senha pelo próprio dono, e não filtra pela conta afetada.** CONFIRMADO.
- Evidência:
  - Nenhum `auditoria.registrar` em `autenticar`, `trocar_senha` ou `conferir_senha_atual`.
  - /auditoria filtra só por quem agiu.
  - `semear_rbac` acrescenta permissões a perfis já gravados sem gravar evento.
- Correção: eventos `SENHA_TROCADA`, `CONTA_BLOQUEADA` e `PERMISSAO_ACRESCENTADA_AO_PERFIL` (são textos novos, nada já gravado muda), e um link "Histórico desta conta".

**D22. Marcar parecer como assinado não confere se quem marca é o signatário.** PLAUSÍVEL (a área é vizinha; pode haver substituição prevista).
- Evidência: `parecer.ts:910-921` exige só `parecer.assinar` e alguma habilitação vigente da conta. O documento sai com o nome do signatário (:668-670).
- Correção: exigir `parecer.signatario.usuario_id === usuario.id`, ou um evento explícito de substituição.

### BAIXA

**D23. A concessão aceita fim antes do início, concessão duplicada e perfil inativo; e "Encerrar" uma concessão futura grava fim anterior ao início.** CONFIRMADO.
- Evidência:
  - `_conceder` (usuarios.ts:181-207) não valida.
  - O select do popup lista todos os perfis (:92).
  - Encerrar (:586-598) grava "ontem" sem olhar o início.
- Correção: validar e reabrir o popup com a recusa; para concessão futura, "Cancelar" com evento próprio.

**D24. O admin_ti, que cria contas, recebe 403 em /perfis.** CONFIRMADO (curl: /perfis 403, /usuarios 200).
- Evidência: `usuarios.ts:786` exige `processo.ver`; o link está em `usuarios.html:49`. Além disso, `perfis.html` não mostra o escopo de cada perfil.
- Correção: liberar para `usuario.criar_conta` ou `perfil.conceder` e mostrar o escopo de cada perfil.

**D25. O cadastro de habilitação não valida a conta escolhida.** CONFIRMADO.
- Evidência: com conta inexistente, a mensagem crua do Postgres aparece (usuarios.ts:744-748). Conta inativa ou já ligada a outra habilitação é aceita.
- Correção: validar como já se faz em `/habilitacoes/:id/conta`.

**D26. O login revela que a conta existe pela mensagem de bloqueio.** CONFIRMADO.
- Evidência: `autenticacao.ts:325-335` só responde "bloqueada" para conta que existe e está ativa.
- Correção: resposta genérica, ou simular o bloqueio também para login inexistente.

**D27. O evento `PERFIL_CONCEDIDO` não diz a que conta o perfil foi dado; `USUARIO_CRIADO` usa o login sem aparar.** CONFIRMADO.
- Evidência: `usuarios.ts:204` e `:405` (`f.texto("login")`, em vez do login aparado).
- Correção: daqui para a frente, gravar o login do alvo, o campus e a vigência. Os registros antigos ficam como estão.

**D28. No bootstrap, o superintendente é obrigado a trocar a senha que acabou de escolher, e a mensagem diz que ela é "provisória".** CONFIRMADO.
- Evidência: `autenticacao.ts:627` grava `precisa_trocar_senha: true`.
- Correção: gravar `false`, ou registrar o motivo em DESVIOS.md e ajustar a mensagem.

**D29. A secretaria vê o nome do inscrito na turma, mas não consegue inscrever em lote pelo nome.** PLAUSÍVEL.
- Evidência: `inscricao_lote.ts:126-128` decide por `ve_dado_nominal`, enquanto `participante.pode_identificar` libera o nome a quem tem `certificado.ver`. Não conferi linha a linha.

## Lacunas de cobertura

- **Funções do titular.** Não há perfil-base de "servidor" que se some a um perfil de equipe sem mudar o escopo (ver D1 e D16).
- **Encerramentos que faltam:**
  - não há como encerrar ou corrigir uma habilitação;
  - não há como editar a conta;
  - não há como desbloquear sem trocar a senha;
  - não há como cancelar uma concessão futura.
- **Substituto.** `perfil.conceder` e `habilitacao.atestar` estão concentrados no superintendente. Nas férias dele, a entrada de pessoal para. O coordenador recebe 403 em /usuarios.
- **Visibilidade:**
  - o escopo efetivo e as permissões da conta não aparecem no Gerir;
  - não há a vista inversa "quem tem a permissão X";
  - as concessões futuras e as encerradas ficam ocultas.
- **Ambiente local.** Nenhuma conta de teste documentada tem `perfil.conceder`. Por isso conceder, vincular e atestar não se testam pela tela.
- **Testes.** Não há testes de combinação de perfis, de concessão a si mesmo, de admin_ti contra conta técnica, de troca para a mesma senha, de bloqueio vencido nem de concessão futura.
- **Permissões consultadas pelo código.** As 44 conferem com o catálogo hoje, mas não há teste que garanta isso.

## Melhorias recomendadas (priorizadas)

1. Ao conceder um perfil, mostrar o escopo e a leitura nominal que a conta vai ter, e as permissões efetivas no Gerir.
2. Criar o teste que extrai os códigos de `pode`, `exigir` e `Item` de `src/` e `templates/` e confronta com `PERMISSOES`.
3. Gravar IP e user-agent nos eventos de governança (`auditoria.registrar` já aceita esses campos).
4. Busca, filtros (situação, perfil, campus) e paginação em /usuarios. Hoje são 66 KB para 11 contas.
5. Avisar sobre processos e demandas atribuídos a quem é inativado ou perde o perfil.
6. Avisar quando uma conta ligada a habilitação não tem perfil que assina.
7. Etiqueta "sem servidor vinculado" na lista. Depois que o admin_ti cria uma conta, avisar que é preciso pedir o perfil a quem concede.
8. Trocar `?mensagem=` e `?erro=` por códigos ou flash na sessão.
9. Mascarar o SIAPE dos habilitados para quem não tem `ve_dado_nominal`.
10. Ler `x-nf-client-connection-ip` só quando a execução for no Netlify. Cookie com prefixo `__Host-`.
11. Bloqueio por par conta+IP, ou atraso progressivo, em vez de bloqueio duro.
12. Mostrar à pessoa as próprias sessões abertas, com "encerrar as outras".
13. Atualizar os textos de `treinamento.gerenciar` e `catalogo.gerenciar`. Avaliar se a secretaria deve manter a lista de setores promotores e se o engenheiro deve ter `catalogo.gerenciar`.
14. Na /auditoria, tratar o autor nominal da mesma forma que o painel trata (`atores_para_tela`).
15. Fechar por URL as telas internas que o servidor comum hoje abre (/catalogos, /epis/estoque, /treinamentos/catalogo).
16. Na senha provisória, usar PRG ou botão de copiar, para que um F5 não gere outra senha.
17. Não renderizar popups de confirmação que nenhum botão abre.

## Itens descartados ou rebaixados

- "Login da conta superintendente recusado": é do ambiente de teste (a senha foi trocada por outros testes), não do sistema.
- "Nenhuma conta de teste tem `perfil.conceder`": fato do ambiente; foi para lacunas.
- "`matriz` passada a perfis.html sem uso": inofensivo; entrou em D24 como melhoria de exibição.
- "Superintendente pode vincular a própria conta a outro servidor": é real, mas o efeito é limitado; ficou como melhoria (D2 cobre a segregação).
- "Aviso de desfecho de demanda para conta sem /pendencias": caso raro; ficou como melhoria, sem defeito comprovado.
- "admin_ti vê o SIAPE dos habilitados", "IP forjável fora do Netlify", "cookie sem `__Host-`": endurecimento, rebaixados a melhoria.
- Duplicados juntados:
  - combinação de escopo: cobertura 1 + perfis 1 e 2 → D1;
  - campus somado: três lentes → D9;
  - encerrar habilitação: quatro lentes → D10;
  - redefinição pelo admin_ti: ciclo + segurança → D4;
  - concessão sem validação: três lentes → D23;
  - autoconcessão: segurança + perfis → D2 e D3;
  - etiqueta "bloqueado": ciclo + tela → D7.

Evidência local:
- /tmp/claude-1000/-home-fabricio-projetos-ufvjm-sistema-csso/6e533084-0d01-4788-b6c2-d68106604be4/scratchpad/v_us.html (GET /usuarios como admin, com os formulários de redefinição de senha nas contas técnicas)
- /tmp/claude-1000/-home-fabricio-projetos-ufvjm-sistema-csso/6e533084-0d01-4788-b6c2-d68106604be4/scratchpad/v_admin.txt (cookie)

Arquivos principais:
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/rotas/usuarios.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/servicos/rbac.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/servicos/autenticacao.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/rotas/autenticacao.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/templates/paginas/usuarios.html
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/templates/paginas/trocar_senha.html
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/servicos/parecer.ts
- /home/fabricio/projetos/ufvjm/sistema-csso/nuvem/src/rotas/demandas.ts

Nenhum arquivo do projeto foi editado.