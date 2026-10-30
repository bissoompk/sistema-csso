# Manuais do Sistema SISA

Cada módulo tem dois manuais: o do **usuário** (quem opera no dia a dia) e o do **coordenador** (quem decide, confere, corrige e responde pelo módulo). Os achados dos testes estão em [ACHADOS.md](ACHADOS.md).

## Índice por módulo

| Módulo | Pasta | Manual do usuário | Manual do coordenador |
|---|---|---|---|
| Processos SEI (processos, laudos, pareceres, adicionais, pendências, relatórios, importação) | `processos/` | [manual-usuario.md](processos/manual-usuario.md) | [manual-coordenador.md](processos/manual-coordenador.md) |
| Gestão de EPI (catálogo, estoque, requisições, balcão, fichas, painel) | `epi/` | [manual-usuario.md](epi/manual-usuario.md) | [manual-coordenador.md](epi/manual-coordenador.md) |
| Treinamentos: turmas e inscrições | `turmas/` | [manual-usuario.md](turmas/manual-usuario.md) | [manual-coordenador.md](turmas/manual-coordenador.md) |
| Treinamentos: certificados | `certificados/` | [manual-usuario.md](certificados/manual-usuario.md) | [manual-coordenador.md](certificados/manual-coordenador.md) |
| Análise de Acidentes | `acidentes/` | [manual-usuario.md](acidentes/manual-usuario.md) | [manual-coordenador.md](acidentes/manual-coordenador.md) |
| Ocorrências de Urgência e Emergência | `ocorrencias/` | [manual-usuario.md](ocorrencias/manual-usuario.md) | [manual-coordenador.md](ocorrencias/manual-coordenador.md) |
| Acesso, conta e administração (login, conta, usuários, perfis, servidores, busca, pendências, configuração, auditoria, importação, limpeza, celular) | `transversal/` | [manual-usuario.md](transversal/manual-usuario.md) | [manual-coordenador.md](transversal/manual-coordenador.md) |
| CISSP e PGR (ainda não existem como módulos; o manual cobre o que há hoje: processo SEI tipo PGR e a vitrine "em desenvolvimento") | `cissp_pgr/` | [manual-usuario.md](cissp_pgr/manual-usuario.md) | [manual-coordenador.md](cissp_pgr/manual-coordenador.md) |

## Qual manual ler

Regra geral: leia primeiro o manual do **usuário** do módulo que você usa. O do **coordenador** só é necessário para quem decide, corrige, anula, configura ou audita. Todos devem ler `transversal/` (conta, busca, pendências).

| Perfil | Leia sempre | Leia também, conforme o trabalho |
|---|---|---|
| Coordenador | `transversal/manual-coordenador.md` e o manual do coordenador de todos os módulos | Manuais do usuário de Processos SEI, Acidentes e Treinamentos, para saber o que a equipe vê. `cissp_pgr/manual-coordenador.md` traz as decisões pendentes |
| Engenheiro | `processos/manual-usuario.md` (laudos, pareceres, adicionais), `acidentes/manual-usuario.md` | `transversal/manual-usuario.md`; `turmas/` e `certificados/` (usuário); `ocorrencias/manual-usuario.md`. Coordenador de `processos/` para anulação e correção |
| Técnico | `processos/`, `epi/` (análise de pedidos, reserva, entrega), `turmas/`, `certificados/`, `acidentes/`, `ocorrencias/` (todos do usuário) | `transversal/manual-usuario.md`. Consulte o do coordenador de `turmas/` e `certificados/` para a regra do dono da turma |
| Médico | `acidentes/manual-usuario.md` (saúde, nível 2, Anexo III), `ocorrencias/manual-usuario.md`, `processos/manual-usuario.md` (parecer) | `epi/manual-usuario.md` (análise); `transversal/manual-usuario.md` |
| Secretaria | `processos/manual-usuario.md` (Kanban, anexos, SEI), `turmas/manual-usuario.md`, `certificados/manual-usuario.md` | `transversal/manual-usuario.md`; `acidentes/manual-usuario.md` (comunicação) e `ocorrencias/manual-usuario.md`. Veja no módulo de turmas e certificados a regra do dono: ela só altera turmas que abriu ou em que é ajudante |
| Almoxarife | `epi/manual-usuario.md` (estoque, balcão, entrega, devolução, inventário) | `transversal/manual-usuario.md`. Não tem acesso a Processos SEI, Turmas nem Ocorrências (403) |
| Admin (administrador de TI e administrador do sistema) | `transversal/manual-coordenador.md` (usuários, perfis, configuração, auditoria, backup, limpeza, importação) | `transversal/manual-usuario.md`. O administrador de TI não abre EPI, Processos nem Turmas |
| Superintendente | Manuais do coordenador de todos os módulos; `transversal/manual-coordenador.md` (concessão de perfil e habilitação) | Manuais do usuário dos módulos que supervisiona |
| Servidor | `epi/manual-usuario.md` (Meu EPI, pedidos, ficha, comunicação), `turmas/manual-usuario.md` (Meus treinamentos), `certificados/manual-usuario.md` (Meus certificados) | `acidentes/manual-usuario.md` (comunicar acidente); `ocorrencias/manual-usuario.md` (registrar ocorrência); `transversal/manual-usuario.md` |
| Participante (inscrito em turma, com ou sem conta) | `turmas/manual-usuario.md` (link público, vitrine /cursos, pedido de vaga, desistência, avaliação) | `certificados/manual-usuario.md` (receber, baixar e validar o certificado) |

Observações:

- Consulta PROGEP e auditor interno apenas leem. Seguem o manual do usuário do módulo e o `transversal/manual-coordenador.md` (auditoria).
- Terceirizado e discente têm acesso restrito (cadastro próprio, EPI só para servidor, ocorrências conforme o módulo). Leia `transversal/manual-usuario.md`.
- Funcionalidades não testadas estão listadas no fim de [ACHADOS.md](ACHADOS.md). Os manuais declaram esses itens como não verificados.

## Sobre as imagens

As capturas de tela são da instalação de teste (30/10/2026), só com registros fictícios. Várias listas aparecem vazias de propósito. Telas com nomes ou e-mails de pessoas reais (por exemplo, a lista de usuários e a página Minha conta) ficaram sem imagem. Acidentes e Ocorrências estão travados em produção e não têm imagem.
