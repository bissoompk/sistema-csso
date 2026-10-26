
## Configurações conforme o perfil (23/10/2026)

Pedido: «a parte de configurações do sistema deve aparecer só as informações conforme perfil de acesso liberado». `/config` passou a montar bloco por bloco; o mapa bloco → módulo/permissão está num lugar só, `blocos_config` em `src/rotas/configuracao.ts`. A rota GET, as rotas POST, o template e a engrenagem do cabeçalho (`ve_config`, global dos templates, usado em `base.html`) leem desse mapa.

| Bloco | Módulo | Permissão | Dado que expõe |
|---|---|---|---|
| Setor emissor + Autoridade destinatária (leitura) | Processos SEI liberado | `processo.editar` ou `catalogo.gerenciar` | sigla, nome e vigência do setor; nome e cargo da autoridade |
| Links para os catálogos de setor e autoridade | Processos SEI | o mesmo, mais `catalogo.gerenciar` | — |
| SLA por coluna (leitura) | Processos SEI | `processo.editar` ou `catalogo.gerenciar` | prazo de cada coluna |
| Editar os prazos (formulário + `POST /config/sla`) | Processos SEI em Operação | `catalogo.gerenciar` e `processo.editar` | grava `parametro` |
| Integração com o SEI + passo a passo | Processos SEI | `processo.editar` ou `catalogo.gerenciar` | versão do SEI alvo, passos de inclusão |
| Retirada de EPI | Gestão de EPI liberado | gestão de EPI na equipe: `epi.catalogo`, `epi.entregar`, `epi.estoque` ou `epi.analisar` | `CSSO_EPI_LOCAL_RETIRADA` |
| Onde o dado mora | administração do sistema | `backup.executar` | host/porta/banco do Postgres, bucket e prefixos |
| Backup cifrado (botão + `POST /config/backup`) | administração do sistema | `backup.executar` | gera `.enc` |
| Exportar tudo (botão + `POST /config/exportar-tudo`) | transversal | `pode_exportar_tudo` (`exportar` + `perfil.conceder`/`catalogo.gerenciar`) e `exposicao.ver` | o banco inteiro em claro |

- **Módulo liberado**: a conta tem alguma permissão do módulo, já com o nível aplicado (`niveis_modulo.ts`; «Sem acesso» tira todas), **no trabalho da equipe** (`pode_na_equipe`). As funções do titular sozinhas não contam. A função `tem_acesso_ao_modulo` de `configuracao.ts` é o ponto de troca: quando a função única da liberação «Sem acesso esconde o módulo» existir, o corpo dela passa a ser só a chamada.
- **Seções**: o título «Configuração do setor» ou «Sistema» só sai se a seção tiver algum bloco. A **Integração com o SEI** mudou de «Sistema» para «Configuração do setor», porque é do módulo Processos SEI. Por isso o `admin_ti` deixou de vê-la.
- **Sem bloco nenhum**: `GET /config` responde 403 com o recado curto «Não há configuração liberada para o seu perfil de acesso.», e a engrenagem some. Hoje isso vale para `servidor_consulta`, `auditor_interno` e `consulta_progep`, e para qualquer conta que fique sem bloco depois do nível por módulo.
- **DESVIO do comportamento anterior**: o `almoxarife_sesmt` **passou a entrar** em `/config` e vê só a «Retirada de EPI», que é dele, porque é quem atende o pedido. Os testes que pediam 403 para ele foram trocados para o `servidor_consulta` e o `auditor_interno`. A `secretaria_csso` deixou de ver a Retirada de EPI, porque não gere EPI. O `admin_ti` deixou de ver a Integração com o SEI.
- **POST**: `/config/sla` também exige o módulo Processos SEI em Operação (antes bastava `catalogo.gerenciar`, mesmo com o módulo em «Sem acesso»). `/config/backup` e `/config/exportar-tudo` já recusavam com 403 e foram conferidos. Testes em `testes/config_por_perfil.test.ts`.
- `PERMISSOES_CONFIG` foi removido. O invariante «engrenagem = rota» agora é cobrado perfil a perfil, comparando a engrenagem com o status de `GET /config` (`testes/correcoes_visual.test.ts`).
