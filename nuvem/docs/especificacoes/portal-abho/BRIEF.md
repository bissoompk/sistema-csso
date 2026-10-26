# Portal do servidor (22/10/2026), briefing comum aos subagentes

Projeto: `/home/fabricio/projetos/ufvjm/sistema-csso/nuvem` (Hono + Nunjucks + Drizzle/Postgres + vitest). Tudo em português do Brasil: código, comentários, textos de tela e relatório.

Leia antes:
- Especificação: `/tmp/claude-1000/-home-fabricio-projetos-ufvjm-sistema-csso/6e533084-0d01-4788-b6c2-d68106604be4/scratchpad/abho/especificacao.md`. Ela foi escrita ANTES de várias entregas; valem as decisões abaixo quando divergirem.
- Protótipo visual: `.../scratchpad/abho/prototipo.html` e as capturas `proto-*.png` no mesmo diretório.
- `DESVIOS.md` e `PORTE.md` do projeto, para saber o tom e as convenções.

## Decisões do usuário (não pergunte; aplique)
- Número de certificado NOVO = SIGLA DO SETOR PROMOTOR + CÓDIGO CURTO DO TREINAMENTO + ANO + sequência anual de 4 dígitos (`CSSO-NR35-2026-0001`). Os já emitidos mantêm o rótulo `27/2026`.
- Link e QR de validação = número + 5 sorteados (`CSSO-NR35-2026-0001-K7QMX`). `/validar` continua aceitando a chave antiga (`CSSO-2026-XXXXX-XXXXX-D`).
- Conteúdo programático fica POR TREINAMENTO (do congelado).
- Prazo "a vencer": único de 60 dias (`JANELA_A_VENCER_DIAS` em `src/dominio/treinamento.ts`). `DIAS_AVISO_RECICLAGEM`, a janela do painel, a de governança e a do CA já apontam para ela.
- "Minha atividade" mostra "Equipe {sigla do setor}" e NUNCA o nome de quem operou (RN-19).
- Consultas a dados sensíveis do servidor NÃO aparecem para o servidor.
- Turma tem `hora_inicio`/`hora_fim` (time, opcionais) e `aceita_comunidade_externa` (boolean).
- "Comunidade externa" (vínculos VISITANTE/OUTRO na inscrição pública) só quando a turma tiver `aceita_comunidade_externa`.
- Cor/ícone por setor promotor: paleta fechada (`CORES_SETOR`, `ICONES_SETOR` em `src/dominio/organizacao.ts`), configurável no cadastro do setor promotor.
- Endereço público: NUNCA fixar "cssosisa" em QR, cartaz ou e-mail; use `emissao_certificado.url_base_validacao(tx)` (parâmetro `certificado.url_publica`, `CSSO_URL_PUBLICA` ou `URL`).
- "Meu perfil" do portal É `/minha-conta` (já existe, com telefone e ramal; não duplique). A lista de sessões foi RETIRADA por decisão do usuário (há desligamento por inatividade em 60 min); não a recoloque.

## O que já está pronto (base feita pelo coordenador; não refaça)
- Migração `src/db/migracoes/0016_portal_servidor.sql` (+ snapshot e `_journal.json`), aplicada no banco local. **Não crie outra migração e não rode `npm run db:gerar`.** Se precisar de mudança de esquema, NÃO faça: descreva no relatório final.
  - `treinamento.codigo_curto` varchar(10) NOT NULL, único, `^[A-Z0-9]{2,10}$`. Inserir sem ele (ou com '') recebe a sugestão pela trava `trg_treinamento_codigo_curto` (`travas.sql`), mesma regra de `sugerir_codigo_curto()`.
  - `turma.hora_inicio`, `turma.hora_fim` (time, `ck_turma_horas`: fim exige início e é maior), `turma.aceita_comunidade_externa` (as turmas que já tinham link público foram marcadas `true`).
  - `certificado.numero_impresso` varchar(40) único (NULL nos antigos), `chave_validacao` varchar(48), CHECK aceita a chave antiga OU a nova, e `ck_certificado_chave_do_numero`.
  - tabela `certificado_sequencia_prefixo (prefixo, ano, ultimo_numero)`.
  - `unidade_uorg.cor_setor`, `unidade_uorg.icone_setor` (CHECK na paleta; os 5 setores da Sisa já receberam a proposta: CSSO azul/shield-plus, CSQV verde/heart-pulse, CPOS petroleo/clipboard2-check, CPEL roxo/mortarboard, SecSisa marinho/building; a semente faz o mesmo no banco novo).
  - índice `ix_hist_entidade_quando` em `historico_evento(entidade, entidade_id, ocorrido_em)`.
  - trava `trg_certificado_numero_imutavel`: numero, ano, numero_impresso e chave_validacao não mudam depois de gravados.
- Domínio (`src/dominio/treinamento.ts`, fim do arquivo): `JANELA_A_VENCER_DIAS`, `PADRAO_CODIGO_CURTO`, `PADRAO_NUMERO_IMPRESSO`, `PADRAO_CHAVE_ANTIGA`, `PADRAO_CHAVE_NOVA`, `PADRAO_CHAVE_VALIDACAO` (as duas), `sugerir_codigo_curto(nome, codigo?)`, `sigla_para_numero`, `prefixo_do_numero`, `montar_numero_impresso`, `situacao_do_cartao(cert, hoje)` → `{tipo:'valido'|'a_vencer'|'vencido'|'indeterminado'|'anulado', dias}`, `dias_entre`. `Certificado.rotulo(c)` agora EXIGE `numero_impresso` no objeto (devolve o número novo ou `n/ano`).
- `src/servicos/certificado.ts`: `normalizar_chave`/`chave_valida` aceitam a nova; `gerar_chave_do_numero()`; `ContextoCertificado.numero_impresso` (congelado) e `.rotulo`.
- `src/servicos/numeracao.ts`: `proximo_numero_impresso(tx, prefixo, ano, montar)` (UPDATE … RETURNING com trava de linha; pula número já gravado).
- `src/servicos/emissao_certificado.ts` `emitir()`: já grava `numero_impresso` e a chave nova (prefixo = sigla da unidade promotora da turma, ou SISA; + código curto).
- `src/servicos/datas_br.ts`: `periodo_curto(inicio, fim)` ("02 e 03/09/2026", "02 a 06/09/2026", "30/09 a 02/10/2026") e `tempo_relativo(momento, agora)` ("agora", "há 5 min", "há 3 h", "ontem", "há 4 dias", data).
- `src/servicos/certificados_titular.ts`: `do_titular(tx, servidor_id, hoje)` → `{ cartoes, anulados, em_emissao, resumo }` (DTO `CartaoCertificado` do congelado, setor com sigla/cor/ícone, `superado_por`, `resumo.proximo_a_vencer`), `em_vigor(linhas)`.
- `templates/partes/cartao_certificado.html`: macro `cartao_certificado(c, compacto=false, sem_reciclagem=false)` (versão inicial).
- `templates/partes/macros.html`: macro `ui.selo_setor(setor, classe='')` com `setor = {sigla, nome, cor, icone}` → `<span class="selo-setor setor--{cor|padrao}">`.
- Rotas novas vazias, já registradas em `src/rotas/index.ts`: `src/rotas/meu_espaco.ts` (`MINHA_ATIVIDADE = "/minha-atividade"`) e `src/rotas/setores_aparencia.ts`.
- CSS: em `public/estaticos/css/csso.css`, ANTES do bloco `/* ===== CELULAR (lote 0) =====`, há subseções marcadas `/* ---------- PORTAL/XXX ... */` e `/* ---------- fim PORTAL/XXX ---------- */` (COMUM, SETOR, CERTIFICADOS, PAINEL, ATIVIDADE, TURMAS, VALIDACAO). **Cada frente escreve SÓ dentro da sua subseção** (inclusive os `@media` de celular das suas classes). `PORTAL/COMUM` já tem `.filtro-pilulas` (links GET, `aria-current="true"` no ativo); classes existentes reutilizáveis: `.selo`, `.selo.ok/.info/.alerta/.erro`, `.vazio`, `.botao`, `.secundario`, `.compacto`, `.discreto`, `.mono`, `.cartao`. O `@media print` continua sendo o ÚLTIMO bloco da folha (os testes `celular_casca` conferem).

## Regras
- **Não faça commit, não troque de branch** (branch `feat/sisa-epi-paridade`).
- **Posse exclusiva de arquivos:** edite SÓ os arquivos listados na sua tarefa (e arquivos novos que você criar). Precisa de algo em arquivo de outra frente? Não edite; diga no relatório final o que precisa. Exceção: testes EXISTENTES que quebrarem por causa da SUA mudança, você corrige (com Edit pontual, porque outro agente pode estar editando o mesmo arquivo de teste; se o Edit reclamar que o arquivo mudou, leia de novo e refaça).
- **CSP estrita:** nada de `style=`, `<style>` ou `<script>` inline. Comportamento só por `data-` em `public/estaticos/js/csso.js` (dono: frente de NUMERAÇÃO; as outras frentes não devem precisar de JS novo — use `<details>`, links GET e o `data-copiar` que já existe).
- Popups de cadastro: `ui.botao_cadastro`/`ui.popup_cadastro` de `templates/partes/macros.html`.
- **Auditoria:** texto de evento já gravado nunca muda; evento NOVO precisa de rótulo em `auditoria.ROTULO_EVENTO` (`src/servicos/auditoria.ts`, dono: frente de ATIVIDADE). As outras frentes devem preferir `auditoria.registrar_diferencas` (evento `CAMPO_ALTERADO`, que já existe) e não criar tipo novo.
- **RN-19:** nome de pessoa só para quem pode ver; nunca nome de operador na tela do titular; nunca CPF.
- **Permissões:** não crie permissão nova. Se for inevitável, ela precisa entrar em `src/servicos/rbac.ts` e no mapeamento de `src/servicos/niveis_modulo.ts`; diga no relatório.
- Celular: alvos de toque de 44px, grades viram uma coluna, `table.empilhavel` onde houver tabela.
- Testes: rode SÓ os seus arquivos (`npx vitest run testes/arquivo.test.ts ...`), nunca a suíte inteira (o coordenador roda no fim). Os testes clonam um banco-modelo migrado; olhe `testes/ajuda.ts`, `testes/ajuda_certificado.ts` e um teste parecido antes de escrever o seu. `npx tsc --noEmit` precisa ficar limpo para os seus arquivos.
- Servidor de desenvolvimento já roda em http://localhost:8766 (tsx watch). Contas: coordenador, engenheiro, tecnico, medico, secretaria, almoxarife, admin, servidor, superintendente; senha `teste-csso-2026`.
- Relatório final (curto, em pt-BR): arquivos alterados/criados, o que entrou, eventos/permissões novos (se houver), testes criados e o resultado exato (`N passed`), pendências e o que precisa de outra frente.
