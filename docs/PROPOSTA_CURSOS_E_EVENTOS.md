# Proposta — Cursos e Eventos em cards

> **ATUALIZAÇÃO — leia isto primeiro.** Este documento foi escrito sem saber
> que `nuvem/` (TypeScript/Hono, Netlify + Supabase — o Sistema CSSO *na
> internet*, documentado no comentário de `netlify.toml`) já tem exatamente
> esta funcionalidade construída, com o nome **vitrine** (`/cursos`,
> `/cursos/:codigo`, serviço em `nuvem/src/servicos/vitrine.ts`, rota em
> `nuvem/src/rotas/vitrine.ts`). Ela cobre tudo que este documento propõe, e
> mais: abas abertas/em breve/realizados, filtro por setor/campus/modalidade,
> capa de imagem, inscrição pública com limite por IP + honeypot + piso de
> tempo de resposta, contador de capacitados com piso de anonimato,
> QR/PDF/ICS/WhatsApp, "quero ser avisado" com confirmação em duas etapas.
>
> **Duas correções ao que este documento afirmava:**
> - "Administrador do sistema é o coordenador_csso" — **errado para o
>   `nuvem/`**. Lá já existe `administrador_sistema` (`nuvem/src/servicos/rbac.ts`),
>   papel dedicado no topo da hierarquia, acima do superintendente, concedido só
>   por linha de comando (`ferramentas/conceder-administrador.ts`).
> - "Não há serviço de e-mail no sistema" — **errado para o `nuvem/`**, que
>   usa `nodemailer` + `CSSO_SMTP_URL` com caixa de saída própria
>   (`nuvem/src/servicos/email.ts`). É verdade só para `app/` (Python, a rede
>   do setor), que continua sem SMTP.
>
> O que a seção 2 abaixo chama de "Trilha A" foi implementado em `app/`
> (Python) — a tela `/turmas/minhas` da rede do setor virou cards. Isso é uma
> melhoria legítima e separada, para quem já está na rede interna; **não é**
> a mesma coisa que a vitrine pública do `nuvem/`, e não substitui revisá-la.
> Antes de pedir qualquer mudança na vitrine, vale ler o que já existe lá — o
> resto deste documento ficou como registro do raciocínio original, não como
> plano a seguir.
>
> **Revisão completa feita em 2026-10-28** (sem alterar código): serviços
> (`vitrine.ts`, `vitrine_arte.ts`, `vitrine_divulgacao.ts`,
> `vitrine_para_voce.ts`, `inscricao_publica.ts`, `aviso_interesse.ts`,
> `email.ts`), templates (`vitrine.html`, `vitrine_curso.html`,
> `vitrine_avise.html`, `vitrine_cartao.html`, `inscricao_formulario.html`),
> tela de cadastro (`turma_ficha.html`, seção "Vitrine de cursos" na aba
> Inscrições) e os testes (`vitrine.test.ts`, `vitrine_para_voce.test.ts`,
> `vitrine_aviso.test.ts`). Nenhum `TODO`/pendência encontrada nos arquivos
> nem nas migrações 0035-0037. **Terceira correção**, a mais importante: o
> RBAC real (`nuvem/src/servicos/rbac.ts`) não segue o padrão que eu assumi a
> partir do sistema Python. Lá, `superintendente = PERMISSOES_COORDENADOR +
> perfil.conceder + habilitacao.atestar + governança de conta` — ele **tem**
> `turma.criar` e publica na vitrine como o coordenador, não é "só leitura".
> A mudança é documentada no próprio código (comentário em `rbac.ts`, decisão
> de 19/10/2026): o desenho "vê tudo, opera nada" travou o sistema recém-
> implantado, porque a única conta existente era a do superintendente e ela
> não criava nada. Quem publica turma na vitrine (`vitrine.pode_divulgar`) é
> então: `administrador_sistema` (tudo), `superintendente` e
> `coordenador_csso` (turma do próprio setor, ou de qualquer setor se tiver
> `turma.todos_os_setores`) — os três papéis do seu pedido original, já
> cobertos, com a hierarquia que você descreveu.

---

Desenhado a partir de duas pesquisas paralelas: (1) o padrão visual real da
ABHO em `/product-category/eventos-apoiados/` (não `/eventos-apoiados/`, que
está com bug/vazia hoje), e (2) o que já existe no CSSO para autoinscrição em
turma. Nada neste documento foi implementado — é a proposta a validar antes de
tocar em código.

## 1. O que a ABHO tem — e o que NÃO se aplica aqui

A página real da ABHO (`/product-category/eventos-apoiados/`, categoria de
produto WooCommerce) mostra 4 cards num grid de 4 colunas: imagem de capa +
título + um bloco de texto livre (status/data/local/preço, sem rótulo fixo,
porque é descrição de produto digitada por quem cadastrou) + botão
"Inscreva-se". **O botão sempre leva para FORA do site da ABHO** — Sympla,
Eventize, formulário de outro organizador. A ABHO só divulga; quem administra
a inscrição é o organizador do evento.

Isso **não serve de modelo para o fluxo de inscrição do CSSO** — aqui a
inscrição é interna, o CSSO é quem organiza a turma, tem vaga, frequência e
certificado para controlar. O que se aproveita da ABHO é só a **forma visual**
do card (capa + título + informação curta + botão), não o padrão de link
externo.

## 2. O que já existe no CSSO (não precisa reconstruir)

| Peça | Onde está | Estado |
|---|---|---|
| Catálogo do que se ensina | `Treinamento` (`app/modelos/treinamento.py`) | completo |
| Oferta de uma turma (data, local, vagas) | `Turma` | completo |
| Autoinscrição do próprio servidor | `turma.inscrever_se`, rota `/turmas/{id}/inscrever-me`, serviço `inscrever_se()` | completo, só falta a tela em card |
| Desistência | rota `/turmas/{id}/desistir`, serviço `desistir()` | completo |
| Lista de turmas abertas | `servico_turma.turmas_abertas()` | completo |
| Inscrição pública (sem conta) | colunas `Turma.inscricao_publica`, `inscricao_token_hash`; `Inscricao.origem="PUBLICA"`, `confirmacao_token_hash`, `email_confirmado_em` | **só o esquema existe — nenhuma rota usa isso ainda** |
| Componente visual de card | CSS `.cartao` (+ `.compacto`, `.link`, `.destaque`) e grid `.grade`/`.grade-3` | existe, hoje só usado em `catalogos.html` |
| RBAC coordenador | `coordenador_csso`: `treinamento.gerenciar`, `turma.criar`, `turma.concluir` | completo |
| RBAC superintendente | só `treinamento.ver`, `certificado.ver` — **leitura, nenhuma escrita**, igual a todo outro módulo que ele vê | completo, por desenho |

A tela atual de autoinscrição (`turmas_minhas.html`) é uma **tabela**, sem
`hx-*`, com formulário POST comum por linha. É isso que vira card.

## 3. Duas trilhas, como você pediu ("as duas coisas")

### Trilha A — quem já tem conta (restyle, baixo risco)

Pega exatamente o que `turmas.py::minhas` já monta (`abertas`,
`vagas_restantes`, `ja_inscrito`, `pode_pedir`, `inscricoes`, `desistivel`) e
troca o HTML de `turmas_minhas.html` de tabela para grid de cards, reaproveitando
`.grade.grade-3` (ou um `.grade-4` novo, se quiser 4 colunas como a ABHO) e
`.cartao`. Nenhuma rota, serviço ou migração muda — é só template + CSS.

**Card por turma aberta:**
- capa (campo novo opcional em `Treinamento` ou `Turma` — ver §5)
- título = `treinamento.nome`
- selo de situação: "Inscrições abertas" / "Vagas esgotadas" / "Inscrições encerram em N dias"
- linha de dados estruturados (não texto livre como a ABHO, porque aqui o dado é real): período, local, carga horária, vagas restantes
- botão "Inscrever-se" (form POST para `/turmas/{id}/inscrever-me`, igual hoje) — some e mostra "Já inscrito" quando `ja_inscrito`
- "Minhas inscrições" continua como está hoje (tabela), ou vira uma segunda fileira de cards menores com o selo de situação da inscrição e o botão "Desistir"

**Estado vazio:** ícone + título + subtítulo, no mesmo espírito do padrão que a
ABHO usa quando não há evento.

### Trilha B — visitante sem conta (novo, maior escopo)

Hoje **só existe uma rota sem login no sistema inteiro**: `/validar`, e há um
teste (`test_so_estas_rotas_abrem_sem_sessao`) que trava isso por padrão e
documenta por que a exceção existe. Abrir "Cursos e Eventos" para quem não tem
conta é adicionar a **segunda** exceção — merece o mesmo tratamento que
`/validar` teve: decisão registrada, teste de invariante atualizado, e o
esquema `PUBLICA` que já existe no banco passa a ser realmente usado.

Proposta de rotas novas:
- `GET /cursos-eventos` — pública, lista só as turmas com `inscricao_publica = true` e situação que aceita inscrição. Mesmos campos de card da trilha A, sem nenhum dado nominal de quem já se inscreveu.
- `GET /cursos-eventos/{turma_id}` — página pública com detalhe e formulário de inscrição (nome, e-mail, vínculo, telefone — os campos de `Participante`/`ParticipanteEmail`).
- `POST /cursos-eventos/{turma_id}/inscrever` — cria `Participante` (se o e-mail já existir, reconcilia pelo fluxo de mesclagem que já existe) + `Inscricao` com `origem="PUBLICA"`, `situacao="AGUARDANDO_EMAIL"`, `confirmacao_token_hash` preenchido; dispara e-mail de confirmação.
- `GET /cursos-eventos/confirmar/{token}` — pública, confirma o e-mail e move a inscrição para `INSCRITA`, só então ocupando vaga de fato — a trava `ck_inscricao_email_confirmado` já existe no banco para isso.

**Quem decide marcar uma turma como pública:** proposta no §4, abaixo —
diferente de quem cria a turma.

**Cuidados a aplicar aqui — direto da revisão do site da ABHO que fizemos antes
([[metodologia-revisao-area-membros-wp]] se você quiser reler o documento
completo, mas o resumo que importa é este):**
- **Rate limit** nas três rotas novas sem sessão (por IP e por e-mail), senão
  a confirmação por e-mail vira alvo de força bruta ou de inscrição em massa
  falsa.
- **Nunca devolver, nessas rotas, se um e-mail já está cadastrado** antes da
  confirmação — é o mesmo erro de enumeração que o lookup por CPF da ABHO
  tinha. "Enviamos um e-mail de confirmação" deve ser a resposta sempre, exista
  ou não a conta.
- O token de confirmação já segue o padrão certo do projeto (hash, não valor em
  claro, como `turma.inscricao_token_hash`) — só confirmar que a expiração
  (`confirmacao_expira_em`) é checada na rota de confirmação, não só gravada.
- Se mais adiante entrar upload (ex.: comprovante de pagamento de evento
  pago), aplicar a mesma lição: validar o conteúdo real do arquivo, não
  confiar em `Content-Type` do navegador, limite de tamanho fixo no servidor.

## 4. RBAC — coordenador e superintendente com permissões diferentes

Hoje `superintendente` só tem `treinamento.ver`/`certificado.ver` (lê, não
opera) — é o mesmo padrão que ele já tem em todo outro módulo do sistema
(processo, parecer, laudo: vê e atribui, não cria nem edita). Duas formas de
"diferente" para Cursos e Eventos, coerentes com esse padrão — **escolha uma**,
isto é proposta, não decisão tomada:

**Opção recomendada — superintendente aprova a divulgação pública, não
organiza o curso:**
- `coordenador_csso` (e os perfis técnicos que já têm `treinamento.gerenciar`):
  continuam cadastrando `Treinamento`, criando `Turma`, abrindo inscrição
  interna — nada muda.
- Nova permissão `turma.publicar`: só ela autoriza marcar/desmarcar
  `inscricao_publica` numa turma (ligar o card no site público). Dar essa
  permissão a `superintendente` — ele decide o que vira público, sem entrar no
  cadastro operacional da turma. Fica simétrico ao que ele já faz em
  `processo.atribuir`: decide, não executa.

**Opção alternativa — superintendente só lê indicadores do módulo:**
Mantém `superintendente` sem nenhuma permissão de escrita em Cursos e Eventos,
igual está hoje; "diferente" seria só o relatório/indicador que ele vê
(inscritos, vagas, taxa de conclusão) e que `coordenador_csso` também vê.

**Sobre "administrador do sistema":** hoje `admin_ti` não tem nenhuma
permissão de conteúdo — só conta, senha, auditoria e backup, de propósito (é
quem cuida da infraestrutura, não do negócio). Se "administrador" no seu
pedido significa "quem manda em tudo", a leitura mais coerente com o resto do
sistema é que esse papel já é `coordenador_csso` — não recomendo dar permissão
de conteúdo a `admin_ti`, porque isso quebraria a separação que o projeto
mantém em todos os outros módulos. Me diga se você tinha outro papel em mente.

## 5. O que falta no modelo de dados (pequeno)

- Campo de imagem de capa — em `Treinamento` (serve a toda turma daquele
  curso) ou em `Turma` (uma capa por edição/evento, mais parecido com a ABHO,
  onde cada evento tem seu próprio banner). Recomendo em `Turma`: um evento
  pontual tem cara própria, e um treinamento recorrente (ex. NR-35) não
  precisaria reusar a mesma imagem comprada/desenhada todo ano.
- Nada mais muda no esquema para a Trilha A. A Trilha B usa colunas que já
  existem (fatia 6 do desenho original, "zero esquema").

## 6. Ordem sugerida de implementação

1. **Trilha A** (template + CSS, sem rota nova) — menor risco, já valida o
   visual de card com usuário real.
2. **`turma.publicar`** — nova permissão, pequena, só para decidir o §4.
3. **Trilha B** — rota pública nova, exige: migração (campo de capa, se não
   entrar no passo 1), rate limit, atualização do teste de invariante de rotas
   sem sessão, e e-mail de confirmação (checar se o projeto já tem serviço de
   envio de e-mail pronto — não verifiquei isso nesta pesquisa).

## 7. Perguntas abertas antes de implementar

- [ ] Confirma a opção do §4 (superintendente aprova publicação) ou prefere a
      alternativa?
- [ ] "Administrador do sistema" é `coordenador_csso` mesmo, ou existe outro
      papel que você tinha em mente e que não está em `MATRIZ_PERFIS` hoje?
- [ ] Capa por `Turma` ou por `Treinamento`?
- [ ] Já existe serviço de envio de e-mail no projeto para o fluxo de
      confirmação da Trilha B, ou isso também precisa ser desenhado?
