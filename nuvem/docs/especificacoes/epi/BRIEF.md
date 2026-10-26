# Paridade de EPI (SISA x IntegraSST) — regras comuns a TODAS as fatias

Projeto: /home/fabricio/projetos/ufvjm/sistema-csso/nuvem (Hono + Nunjucks + Drizzle/Postgres + vitest).
Legado (só leitura): /home/fabricio/projetos/ufvjm/sistema-csso/entrada/integrasst (EPI_Backend.js, EPI_Frontend.html, UI_EPI_Usuario.html, Core.js).
Plano completo (leia a sua fatia e a seção 4, Decisões): /tmp/claude-1000/-home-fabricio-projetos-ufvjm-sistema-csso/6e533084-0d01-4788-b6c2-d68106604be4/scratchpad/paridade_epi.md
(prefixos L: = legado, S: = nuvem/). O plano fala em "migração 0012/0013": IGNORE, o esquema já foi feito (ver abaixo).

## Português (pt-BR) em tudo: código novo, comentários, mensagens, relatório.

## O esquema JÁ ESTÁ PRONTO e aplicado no banco local (migração 0015_epi_paridade). NÃO crie migração, NÃO edite src/db/esquema/*, src/db/travas.*, src/db/migracoes/*.
- `epi_comunicacao_titular` (A): id, registro_id, servidor_id, tipo (TIPOS_COMUNICACAO_TITULAR), observacao, criado_por, criado_em, retirada_em/retirada_por, tratada_em/tratada_por, tratamento, requisicao_id. CHECKs: retirada e tratada se excluem; DELETE/TRUNCATE recusados por trigger.
- `epi_ficha_registro.motivo_codigo` (A; MOTIVOS_FICHA, nulo permitido) e `epi_ficha_registro.orientacao_anexo_id` (C; FK anexo) — as DUAS congeladas na trigger (só se gravam no INSERT).
- `epi_requisicao_item.motivo` (B; MOTIVOS_ITEM_REQUISICAO; nulo no banco, itens antigos preenchidos pela finalidade; o SERVIÇO recusa item novo sem motivo).
- `epi_requisicao.termo_exigido` (default true; false só nos pedidos anteriores à 0015), `termo_aceito_em`, `termo_aceito_por`, `termo_versao`. CHECK `ck_req_termo`: `NOT termo_exigido OR estado='RASCUNHO' OR termo_aceito_em IS NOT NULL` e `ck_req_termo_inteiro` (os três juntos). => HOJE `enviar()` falha no banco até a fatia B gravar o termo.
- `epi_item.imagem_anexo_id`, `epi_item.orientacao_anexo_id` (C; FK anexo). Categoria de anexo nova `EPI_CATALOGO` (já em CATEGORIAS_ANEXO, anexos.CATEGORIAS_EPI e rótulo de tela).
- `epi_item_treinamento (epi_item_id, treinamento_id, vinculado_por, vinculado_em)` (E).
- Constantes em src/dominio/epi.ts (final do arquivo): TIPOS_COMUNICACAO_TITULAR + ROTULO_COMUNICACAO_TITULAR, JANELA_RETIRADA_COMUNICACAO_HORAS=24, MOTIVOS_FICHA + ROTULO_MOTIVO_FICHA, MOTIVOS_ITEM_REQUISICAO + ROTULO_MOTIVO_ITEM, MOTIVO_ITEM_POR_FINALIDADE, MOTIVO_ITEM_POR_COMUNICACAO, TERMOS_NR06 / TERMO_NR06_VIGENTE / texto_termo_nr06(), EPI_CATALOGO_IMAGEM_TIPOS, EPI_CATALOGO_IMAGEM_MAX_BYTES (2 MB), EPI_CATALOGO_PDF_MAX_BYTES (4 MB), ENTIDADE_ANEXO_EPI_ITEM='epi_item'.
- Eventos de auditoria novos JÁ com rótulo em src/servicos/auditoria.ts (ROTULO_EVENTO): EPI_COMUNICACAO_REGISTRADA, EPI_COMUNICACAO_RETIRADA, EPI_COMUNICACAO_TRATADA, EPI_REQUISICAO_TERMO_ACEITO, EPI_ITEM_IMAGEM_ENVIADA, EPI_ITEM_ORIENTACAO_ENVIADA, EPI_ITEM_TREINAMENTO_VINCULADO, EPI_ITEM_TREINAMENTO_DESVINCULADO, EPI_SEM_TREINAMENTO_CONFIRMADO, EPI_EMAIL_ENFILEIRADO. Use estes códigos (declare a constante string no seu serviço, como os existentes fazem). Se precisar de OUTRO evento, NÃO edite auditoria.ts: anote no relatório (código + rótulo) que eu acrescento. Textos de auditoria já gravados nunca mudam.
- Pendência nova `EPI_COMUNICACAO_A_TRATAR` (10 dias, concluída com `epi.entregar`) já em src/servicos/pendencias.ts.
- Config (src/config.ts): `epiEmailLigado` (CSSO_EPI_EMAIL=sim; padrão DESLIGADO), `epiEmailSetor` (CSSO_EPI_EMAIL_SETOR).
- NENHUMA permissão nova foi criada. Use as existentes (epi.ver, epi.ficha, epi.requisitar, epi.entregar, epi.estoque, epi.catalogo, epi.analisar, indicador.ver, exportar). Se achar indispensável criar uma, NÃO crie: justifique no relatório (há conferência em src/servicos/niveis_modulo.ts + rbac._conferir_niveis que derruba o sistema se a permissão ficar fora do mapeamento).

## Regras do projeto
- CSP estrita: nada de `style=`, `<style>` ou `<script>` inline em template. Comportamento só por atributos `data-` tratados em public/estaticos/js/csso.js. Leia csso.js antes: quase tudo já existe (popups, confirmações, gavetas, envio automático de select etc.).
- csso.css / csso.js são COMPARTILHADOS: só os edite se o seu briefing disser que você é o dono deles. Se não for o dono e precisar de regra nova, prefira classes já existentes; se for indispensável, escreva o trecho em /tmp/claude-1000/-home-fabricio-projetos-ufvjm-sistema-csso/6e533084-0d01-4788-b6c2-d68106604be4/scratchpad/epi/propostas_<fatia>.css (ou .js) e diga no relatório; eu integro. Regra nova de CSS fica ANTES do `@media print` (ele tem de ser o último bloco).
- Telas: macros em templates/partes/macros.html (ui.botao_cadastro / ui.popup_cadastro para formulários em popup, ui.info, ui.vazio_de_lista, ui.abas…). Telas novas usáveis a 360px: tabela com `class="empilhavel"`, cada `<td data-coluna="Rótulo">`, célula de botões `class="acao-linha"`, `td.curta` etc. (contrato em csso.css perto da linha 2820). Veja telas EPI existentes como modelo.
- RN-19: nome de pessoa só aparece para quem pode (src/servicos/identificacao.ts, `pode_ver_nominal`); na ESCRITA da auditoria, identifique servidor por id (#123), como o código existente faz. Indicadores: supressão de contagens < 5.
- Sem CPF/CID em lugar nenhum (RN-21).
- NÃO faça commit. NÃO mexa em git (stash, checkout, reset).
- Servidor dev já roda na porta 8766 (tsx watch). NÃO mate nem reinicie. Se uma rota .ts nova não recarregar, só anote.
- Contas do dev (senha teste-csso-2026): coordenador, engenheiro, tecnico, medico, secretaria, almoxarife, admin, servidor, superintendente.
- Testes: escreva os SEUS em testes/epi_<fatia>_*.test.ts (veja testes/ajuda.ts, testes/ajuda_epi_ficha.ts, testes/ajuda_epi_requisicao.ts como modelo; cada arquivo clona o banco-modelo, então podem rodar em paralelo com outros agentes). Rode SÓ os seus e os afetados: `cd nuvem && npx vitest run testes/<arquivo>.test.ts ...`. NUNCA rode a suíte inteira (o coordenador roda no fim). `npx tsc --noEmit` deve ficar limpo nos SEUS arquivos (erros em arquivos de outra fatia em andamento: só anote).
- Posse exclusiva de arquivos: edite SOMENTE os arquivos que o seu briefing lista como seus (e arquivos novos que você criar). Ler qualquer arquivo pode. Se precisar mudar arquivo de outro dono, NÃO mude: descreva a mudança exata no relatório.
- Relatório final (em pt-BR, conciso): arquivos alterados/criados, o que entregou, testes (nomes dos arquivos e números exatos de aprovados/falhos), pendências, mudanças pedidas em arquivos de outros donos, eventos/CSS/JS propostos.
