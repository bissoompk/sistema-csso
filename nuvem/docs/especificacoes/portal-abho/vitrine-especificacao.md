# Vitrine de cursos da SISA: especificação

Data: 22/10/2026. Projeto: `/home/fabricio/projetos/ufvjm/sistema-csso/nuvem`. Protótipo: `vitrine-prototipo.html` (mesma pasta).
Inspiração: página "Cursos e Eventos" da ABHO (capturas 10 a 13). Sem preço, sem loja e sem inscrição fora do sistema.

## 0. Decisões que valem para tudo

| Tema | Decisão |
|---|---|
| Endereço | `/cursos` (lista) e `/cursos/:codigo` (ficha, ex.: `/cursos/TUR-2026-0027`). Não há login. |
| O que entra na vitrine | A turma com `divulgar_na_vitrine = true` e situação diferente de CANCELADA. A aba depende da situação e das datas (ver 1.2). |
| Inscrição | O botão "Inscrever-se" leva a `/cursos/:codigo#inscricao`, que mostra **o mesmo formulário** de `inscricao_publica.html` e grava pelo mesmo `inscricao_publica.pedir()` (mesmo limite por IP, mesmo campo-isca, mesma resposta padrão). O token `/inscricao/:token` continua servindo para a turma **não** divulgada (só para convidados). Motivo: o banco guarda só o hash do token, então a vitrine não consegue montar o link. A turma divulgada é pública por definição. |
| Regra de "aberta" | Uma só função, `vitrine.inscricao_aberta(turma, hoje)`. Ela devolve verdadeiro quando a situação é `INSCRICOES_ABERTAS`, a turma ainda não começou, `inscricao_aberta_ate >= hoje` e a turma está divulgada. `link_no_ar()` e `turmas_abertas()` passam a reaproveitar o mesmo miolo, para não haver duas regras. |
| CSP | Sem `<script>` nem `style=""` inline. As abas e os filtros são links ou formulário GET. "Copiar link" é um `<input readonly>` com o endereço. Compartilhar é um link `wa.me` (não precisa de JS). Se houver JS, ele fica em `public/estaticos/js/vitrine.js` como melhoria progressiva. |
| Cores por setor | Uma cor e um ícone por setor promotor, guardados em `unidade_uorg` (`cor_vitrine`, `icone_vitrine`). Sem valor, usa `--sisa-azul`. Sugestão inicial: CSSO `#0058a3`, CSQV `#3a7a1c`, CPOS `#08669a`, CPEL `#6b3fa0`, SecSisa `#0a2a5c`. Todas com contraste maior ou igual a 4,5:1 com o texto branco. |
| Textos fixos "CSSO" | Saem da inscrição pública e da vitrine. Usa-se `turma.unidade_promotora.sigla` e, sem ela, "SISA / UFVJM". |
| Indexação | `/cursos` e `/cursos/:codigo` podem ser indexados (`robots` liberado, Open Graph). Turma encerrada há mais de 90 dias deixa de ter ficha: a rota responde 410 com "Esta turma já foi realizada" e um link para `/cursos`. |

## 1. Página `/cursos` (vitrine)

### 1.1 Desenho
- **Cabeçalho**: cartão com faixa superior no degradê `--sisa-marinho` → `--sisa-azul` → `--sisa-ciano`, ícone redondo (capelo), título "Cursos da SISA" e a frase "Capacitações em saúde, segurança e qualidade de vida para quem trabalha e estuda na UFVJM." Acima dele, a trilha "Início › Cursos".
- **Abas de situação** (links): **Inscrições abertas** (padrão) · **Em breve** · **Realizados**. Cada aba mostra a contagem: "Inscrições abertas (4)".
- **Filtros** (formulário GET, botão "Filtrar"; no celular ficam dentro de `<details>` "Filtrar"): setor promotor, campus, modalidade e público. A URL fica compartilhável: `/cursos?aba=abertas&setor=csso&campus=jk&modalidade=presencial`.
- **Grade de cartões**: 1 coluna até 600px, 2 até 960px, 3 acima disso e 4 acima de 1280px.
- **Rodapé**: "Sistema SISA · UFVJM", link para a política de privacidade e o link "Receber avisos de novos cursos" (vai para o formulário de aviso geral).

### 1.2 Regras das abas
| Aba | Regra | Ordem |
|---|---|---|
| Inscrições abertas | `inscricao_aberta()` | `inscricao_aberta_ate` asc, depois `data_inicio` |
| Em breve | Divulgada, com situação PLANEJADA, ou INSCRICOES_ABERTAS e ainda sem prazo. Mostra "Inscrições em breve" e o botão "Quero ser avisado" no lugar de "Inscrever-se". | `data_inicio` asc |
| Realizados | CONCLUIDA ou EM_ANDAMENTO, com `data_fim` nos últimos 12 meses | `data_fim` desc |

A turma lotada fica em "Inscrições abertas", no fim da lista, com o selo "Turma cheia" e o botão "Avise-me da próxima turma".

### 1.3 Cartão do curso
| Elemento | Origem | Observação |
|---|---|---|
| Arte (proporção 4:5) | Anexo `turma_arte` e, sem ele, `treinamento_arte`. Na falta dos dois, **capa gerada**. | A capa gerada é HTML/CSS com fundo na cor do setor, ícone do setor, sigla, nome do treinamento e NR. Não precisa de imagem. `alt` = nome do curso. |
| Selos | calculados | "Encerra em N dias" (N ≤ 7), "Últimas vagas" (restantes ≤ 20% ou ≤ 5), "Turma cheia", "Certificado incluso" (sempre que o treinamento emite certificado), "Gratuito", "Vale como reciclagem NR-xx" (quando `validade_meses > 0`) |
| Setor | `unidade_promotora.sigla` | Etiqueta com a cor do setor |
| Título | `turma.titulo_vitrine ?? treinamento.nome` | Até 2 linhas, com reticências |
| Datas e horário | `data_inicio`–`data_fim` + `horario` | "18 e 19/11/2026 · 8h às 17h" |
| Local | `local` + `campus.nome` + `modalidade` | "Online" quando a modalidade é EAD; o link da sala só vai para o inscrito aceito, nunca na vitrine |
| Carga horária | `carga_efetiva` | "16 h" |
| Vagas | `vagas_restantes()` | "12 de 30 vagas"; sem limite, "Vagas abertas". Nunca nomes. |
| Inscrições até | `inscricao_aberta_ate` | "Inscrições até 11/11" |
| Público | `publico_alvo[]` | Etiquetas: Servidores, Terceirizados, Estudantes, Comunidade |
| Botão | — | "Inscrever-se" → `/cursos/:codigo#inscricao`. Link secundário "Detalhes". |

### 1.4 Dados, esquema e migração
Próxima migração livre (hoje seria `0013_vitrine_cursos.sql`; conferir o `_journal.json` na hora, porque há outros lotes na fila).

```sql
-- turma
ALTER TABLE turma ADD COLUMN divulgar_na_vitrine boolean NOT NULL DEFAULT false;
ALTER TABLE turma ADD COLUMN divulgada_em timestamptz;           -- 1ª publicação (dispara o aviso)
ALTER TABLE turma ADD COLUMN titulo_vitrine varchar(160);        -- opcional; padrão = treinamento.nome
ALTER TABLE turma ADD COLUMN horario varchar(80);                -- texto curto: "8h às 12h e 13h às 17h"
ALTER TABLE turma ADD COLUMN modalidade varchar(12) NOT NULL DEFAULT 'PRESENCIAL'
  CHECK (modalidade IN ('PRESENCIAL','EAD','HIBRIDO'));
ALTER TABLE turma ADD COLUMN publico_alvo varchar(16)[] NOT NULL DEFAULT '{}';  -- SERVIDOR, TERCEIRIZADO, DISCENTE, COMUNIDADE
ALTER TABLE turma ADD COLUMN pre_requisito varchar(300);
ALTER TABLE turma ADD COLUMN inscricao_abre_em date;            -- opcional, para "Em breve: inscrições a partir de"
CREATE INDEX turma_vitrine_idx ON turma (divulgar_na_vitrine, situacao, data_inicio) WHERE divulgar_na_vitrine;

-- treinamento (padrões herdados pela turma)
ALTER TABLE treinamento ADD COLUMN publico_alvo_padrao varchar(16)[] NOT NULL DEFAULT '{}';
ALTER TABLE treinamento ADD COLUMN pre_requisito_padrao varchar(300);

-- setor promotor
ALTER TABLE unidade_uorg ADD COLUMN cor_vitrine char(7);
ALTER TABLE unidade_uorg ADD COLUMN icone_vitrine varchar(24);

-- equipe do setor promotor (multissetor; ver 6.2)
CREATE TABLE equipe_setor_promotor (
  usuario_id integer NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  unidade_id integer NOT NULL REFERENCES unidade_uorg(id),
  PRIMARY KEY (usuario_id, unidade_id)
);
```
O Drizzle acompanha a mudança em `src/db/esquema/treinamento.ts` e `seguranca.ts`. O público-alvo usa a lista fixa `PUBLICOS` em `src/servicos/vitrine.ts`, com os rótulos.

### 1.5 Serviço e rotas
- `src/servicos/vitrine.ts` (novo): `listar(tx, {aba, setor, campus, modalidade, publico}, hoje)`, `ficha(tx, codigo, hoje)`, `inscricao_aberta()`, `selos(turma, hoje)`, `capa(turma)`, `PUBLICOS`, `MODALIDADES`. Expõe só um DTO público (`TurmaVitrine`), sem `id` interno, sem instrutor com registro de conselho quando o instrutor não autorizou, e sem contagem por nome.
- `src/rotas/vitrine.ts` (novo), montada em `src/rotas/index.ts` **antes** do middleware de sessão, como `/inscricao`:
  - `GET /cursos` → `paginas/vitrine.html`
  - `GET /cursos/:codigo` → `paginas/vitrine_curso.html`
  - `POST /cursos/:codigo/inscricao` → `inscricao_publica.pedir()` por turma (sem token), com o mesmo PRG e o mesmo cookie curto de "pedido recebido"
  - `GET /cursos/:codigo/arte` → a imagem (ver 7)
  - `GET /cursos/:codigo.ics` → o calendário (ver 2.4)
  - `GET /cursos/:codigo/cartaz.pdf` e `/cursos/:codigo/post.png?formato=feed|story` (ver 2.5)
  - `GET /cursos.json` (opcional, lote 6): feed para o portal da UFVJM
- Cabeçalhos: `Cache-Control: public, max-age=300` na lista e na ficha. O POST e o cookie seguem as regras da inscrição pública (`no-store`).
- Template base público: `templates/base_publica.html`, novo, a partir do já usado em `inscricao_publica.html`, com a marca SISA, sem lateral e com a mesma CSP.
- CSS: `public/estaticos/css/vitrine.css`, com os tokens de `tema.css` e sem cor solta.

### 1.6 Permissões
Leitura pública. Nenhum dado pessoal aparece na vitrine. O nome do instrutor aparece só se `assinatura_instrutor.exibir_na_vitrine` estiver marcado (campo novo, padrão `false`). O registro no conselho nunca aparece.

### 1.7 LGPD
- A vitrine não tem cookie de rastreio, contador por visitante nem pixel de rede social. A prévia do WhatsApp vem de `og:image`, servida pelo próprio sistema.
- O texto de finalidade da inscrição continua o de hoje. O aviso legal ganha um link para a política.
- Fotos de pessoas na arte: o envio pede a marcação "As pessoas que aparecem autorizaram o uso da imagem ou não há pessoas" (ver 7).

### 1.8 Celular (390px)
Uma coluna. As abas rolam na horizontal dentro de uma faixa própria, sem rolagem da página. Os filtros ficam recolhidos em `<details>`. O botão "Inscrever-se" ocupa a largura toda, com 44px de altura. A arte limita-se a 4:5, sem passar de 60vh. A fonte base é de 16px.

### 1.9 Testes (`testes/vitrine.test.ts`)
- Turma não divulgada não aparece, nem em `/cursos/:codigo` (404).
- Cada aba recebe as turmas certas, contando o dia de corte de `inscricao_aberta_ate` (inclusive) e o dia de início.
- Turma lotada vai para o fim e mostra "Turma cheia". Turma sem vagas definidas mostra "Vagas abertas".
- Filtros por setor, campus e modalidade, combinados.
- O HTML da vitrine não tem e-mail, SIAPE nem nomes de inscritos (procura por padrões no HTML gerado).
- A CSP sai igual à das outras páginas, e não há `style=` nem `<script>` inline (teste de varredura do template).
- Os textos usam o setor promotor e nunca "CSSO" fixo quando o setor é outro.

## 2. Ficha do curso `/cursos/:codigo`

### 2.1 Desenho (de cima para baixo)
1. Trilha "Início › Cursos › NR-35 Trabalho em altura".
2. Faixa superior: arte (ou capa gerada) à esquerda. À direita, o título, o setor, os selos e um quadro-resumo: datas e horário, local e campus, modalidade, carga horária, vagas, inscrições até, público e pré-requisito. Botão grande "Inscrever-se". No celular, tudo vira uma coluna e o botão fica fixo no pé da tela (`position: sticky`) enquanto o formulário não aparece.
3. **Sobre o curso**: `turma.descricao`.
4. **Conteúdo programático**: `treinamento.conteudo_programatico`, um item por linha.
5. **Instrutor**: nome e título, se autorizado.
6. **Certificado**: "Certificado digital com QR de validação, emitido pela SISA. Vale X meses (NR-xx)". Quando `validade_meses = 0`, "Não tem prazo de validade".
7. **Pré-requisitos**: `pre_requisito` (ex.: "Ter concluído o NR-35 básico; apresentar ASO com aptidão para trabalho em altura").
8. **Divulgue**: QR da ficha, "Baixar cartaz (PDF A4)", "Post para feed (1080×1350)", "Story (1080×1920)", "Compartilhar no WhatsApp", campo "Copiar link" e "Adicionar à agenda (.ics)".
9. **Inscrição** (`#inscricao`): o formulário atual, com o setor certo nos textos. Se a turma estiver cheia ou fechada, o formulário dá lugar ao "Quero ser avisado da próxima turma deste curso".

### 2.2 Dados
Todos já existem, exceto os da seção 1.4. O QR usa `qr.ts` com a URL absoluta da ficha (`config.url_publica`).

### 2.3 Open Graph
`og:title` = título; `og:description` = "18 e 19/11 · Campus JK · Inscrições até 11/11"; `og:image` = `/cursos/:codigo/post.png?formato=feed`; `og:url` = a ficha; `twitter:card=summary_large_image`.

### 2.4 Calendário `.ics`
- `src/servicos/ics.ts` (novo, sem dependência): um VEVENT por dia, ou um evento com DTSTART/DTEND quando o horário é um só. Leva UID estável `turma-<codigo>@sisa.ufvjm`, LOCATION = local e campus e DESCRIPTION = a URL da ficha.
- Os horários, por ser texto livre, não vão para o `.ics` como hora: na falta de `hora_inicio`/`hora_fim` estruturados, o evento ocupa o dia inteiro. **Decisão em aberto**: guardar `hora_inicio` e `hora_fim` (time) além do texto `horario`. Recomendo os dois campos de hora e gerar o texto a partir deles.
- O mesmo `.ics` vai anexo ao e-mail de inscrição aceita (`avisos_inscricao.ts`, via `registrar_anexador`).

### 2.5 Artes prontas para divulgar (cartaz, feed e story)
- Cartaz A4 em PDF, por `pdf.ts`: logo SISA, faixa do setor, título, datas, local, carga, "Inscrições até", QR grande e URL curta.
- Post PNG em 1080×1350 e 1080×1920: o servidor gera a imagem com o mesmo conteúdo. **Questão técnica**: hoje não há renderizador de imagem. As opções são (a) gerar SVG e converter com `resvg` (WASM, sem processo externo), ou (b) entregar só SVG e PDF. Recomendo a (a), em lote separado, sem bloquear a vitrine.
- Se a turma tiver arte enviada, o post usa a arte como fundo e põe por cima uma tarja com datas e QR. A informação continua vindo dos campos.

### 2.6 Compartilhar
`https://wa.me/?text=` + `encodeURIComponent("Inscrições abertas: NR-35 Trabalho em altura · 18 e 19/11 · Campus JK. Inscreva-se: https://…/cursos/TUR-2026-0031")`, montado no servidor. Há também o link `mailto:` e o "Copiar link" (input readonly, com `vitrine.js` opcional para o botão de copiar).

### 2.7 Permissões, LGPD, celular e testes
- Públicas como a lista. O POST da inscrição herda todas as travas de `inscricao_publica.pedir` e passa a receber `turma` em vez de `token`. Refatorar para `pedir(tx, turma, dados, origem)`, com `origem = "TOKEN" | "VITRINE"` gravada no pedido para a trilha.
- Testes:
  - POST em turma não divulgada → resposta padrão, sem gravar.
  - POST em turma fechada → idem.
  - Limite por IP compartilhado entre `/inscricao` e `/cursos`.
  - `.ics` válido: CRLF, linhas dobradas em 75 octetos e escape de `,;\`.
  - O QR decodifica para a URL da ficha.
  - Open Graph presente.
  - A ficha de turma encerrada há mais de 90 dias responde 410.

## 3. "Quero ser avisado"

### 3.1 Onde aparece
- No estado vazio de cada aba e de cada filtro de setor ("Nenhum curso com inscrições abertas no momento. Novas turmas estão sendo preparadas.") vem o formulário, já com o setor do filtro marcado.
- Na ficha da turma cheia ou encerrada, com o interesse no treinamento.
- No rodapé da vitrine, como aviso geral ("qualquer curso").

### 3.2 Formulário
Campos: nome (obrigatório, até 120), e-mail (obrigatório), interesse (radio: "Este curso" / "Cursos do setor X" / "Qualquer curso da SISA"), campus (opcional, select; serve para filtrar o aviso), campo-isca invisível e a caixa **desmarcada** "Concordo em receber e-mails da SISA sobre a abertura de turmas". Junto do botão, o texto de finalidade: "Usaremos seu nome e e-mail só para avisar quando abrir turma do interesse escolhido. Você confirma pelo e-mail e pode sair a qualquer momento pelo link em cada aviso. O cadastro expira em 12 meses." **Sem telefone** (RN-19: o aviso é só por e-mail).

Resposta, sempre a mesma: "Se o e-mail for válido, você receberá uma mensagem para confirmar. O aviso só começa depois da confirmação."

### 3.3 Esquema
```sql
CREATE TABLE aviso_interesse (
  id serial PRIMARY KEY,
  nome varchar(120) NOT NULL,
  email varchar(254) NOT NULL,
  email_normalizado varchar(254) NOT NULL,
  tipo varchar(12) NOT NULL CHECK (tipo IN ('TREINAMENTO','SETOR','QUALQUER')),
  treinamento_id integer REFERENCES treinamento(id),
  unidade_id integer REFERENCES unidade_uorg(id),
  campus_id integer REFERENCES campus(id),
  consentimento_em timestamptz NOT NULL,
  consentimento_versao varchar(16) NOT NULL,      -- versão do texto de finalidade
  ip_consentimento inet,                           -- apagado em 90 dias (rotina de privacidade)
  confirmacao_hash char(64),                       -- SHA-256 do token; null depois de confirmado
  confirmado_em timestamptz,
  descadastro_hash char(64) NOT NULL,
  cancelado_em timestamptz,
  ultimo_aviso_em timestamptz,
  expira_em date NOT NULL,                         -- confirmado_em + 12 meses
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo='TREINAMENTO') = (treinamento_id IS NOT NULL)),
  CHECK ((tipo='SETOR') = (unidade_id IS NOT NULL))
);
CREATE UNIQUE INDEX aviso_interesse_unico ON aviso_interesse
  (email_normalizado, tipo, coalesce(treinamento_id,0), coalesce(unidade_id,0)) WHERE cancelado_em IS NULL;

CREATE TABLE aviso_interesse_envio (            -- um aviso por pessoa por turma
  aviso_id integer NOT NULL REFERENCES aviso_interesse(id) ON DELETE CASCADE,
  turma_id integer NOT NULL REFERENCES turma(id),
  email_id integer REFERENCES email_saida(id),
  PRIMARY KEY (aviso_id, turma_id)
);
```

### 3.4 Serviço e rotas
`src/servicos/aviso_interesse.ts` (novo):
- `cadastrar(tx, dados, ip)`:
  - valida;
  - reaproveita `dentro_do_limite(ip)`;
  - se já houver um cadastro ativo igual, não cria outro, e reenvia a confirmação no máximo 1 vez por hora;
  - enfileira o e-mail de confirmação (`email.enfileirar`, tipo `AVISO_INTERESSE_CONFIRMAR`);
  - devolve sempre `RESPOSTA_PADRAO`.
- `confirmar(tx, token)`: grava `confirmado_em` e `expira_em`, apaga `confirmacao_hash` e mostra a página "Pronto, você será avisado".
- `descadastrar(tx, token)`: grava `cancelado_em`. A operação é idempotente e não pede login. A página tem o botão "Confirmar saída" (POST), para o pré-carregamento de link do cliente de e-mail não descadastrar ninguém sozinho. O e-mail leva o cabeçalho `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- `avisar_turma(tx, turma)`:
  - chamado **na mesma transação** em que a turma é publicada com inscrição aberta;
  - procura os interesses confirmados, não cancelados e não expirados que casem por treinamento, por setor ou por "qualquer", e pelo campus quando informado;
  - insere em `aviso_interesse_envio` com `ON CONFLICT DO NOTHING` e enfileira um e-mail (tipo `AVISO_INTERESSE_TURMA`), com a ficha, as datas, o "Inscrições até" e o link de descadastro;
  - a pessoa continua cadastrada até expirar ou sair.
- Chave de ligar: `configuracao.aviso_interesse_ativo` (padrão desligado, como `aviso_reciclagem`). Com ela desligada, o cadastro funciona, mas `avisar_turma` não enfileira nada. Se o e-mail do sistema não estiver configurado (`email.configurado()` falso), os e-mails ficam PENDENTES na caixa de saída e saem quando ele for ligado. Recomenda-se descartar o aviso de turma cujo prazo de inscrição já passou antes do envio (anexador ou checagem em `processar_fila`).

Rotas públicas:
- `POST /cursos/avise-me`
- `GET /cursos/avise-me/confirmar/:token`
- `GET|POST /cursos/avise-me/sair/:token`

### 3.5 LGPD
- Base legal: consentimento (art. 7º, I).
- Finalidade única e versão do texto gravada.
- Retenção:
  - o cadastro não confirmado é apagado em 7 dias;
  - o confirmado expira em 12 meses (é apagado no dia seguinte);
  - o cancelado é apagado em 30 dias;
  - o IP é apagado em 90 dias.

  Tudo na rotina noturna (`rotinas.ts` → `privacidade.ts`).
- Trilha: `AVISO_INTERESSE_CRIADO`, `_CONFIRMADO` e `_CANCELADO`, só com o `id`, nunca o e-mail.
- Entrada nova no inventário (ROPA). Atendimento ao titular: a busca por e-mail em `privacidade.ts` passa a incluir `aviso_interesse`.
- A equipe vê **só contagens** ("37 pessoas aguardando NR-35"), nunca a lista. Exportar a lista não é permitido.

### 3.6 Celular e testes
- No celular, o formulário fica em uma coluna dentro do cartão de estado vazio, e o select de interesse vem marcado conforme o contexto.
- Testes:
  - mesma resposta para e-mail novo, repetido e inválido (inclusive no tempo de resposta, sem atalho para o caso repetido);
  - nada é enviado antes da confirmação;
  - o token de confirmação expira em 7 dias;
  - o descadastro por GET não cancela, só o POST;
  - `avisar_turma` não duplica o envio na republicação;
  - casamento por treinamento, por setor, por qualquer e por campus;
  - chave desligada → nenhum envio;
  - expurgo nos prazos;
  - a trilha não contém e-mail.

## 4. "Inscrições abertas para você" no Meu espaço

- **Onde**: `inicio_do_servidor()` em `src/rotas/painel.ts` (tela `painel.html` no modo `so_o_proprio`) e, se houver, `/turmas/minhas`.
- **O que mostra**: até 3 cartões compactos das turmas com `inscricao_aberta()` e divulgadas, com o botão "Quero participar". O botão segue o fluxo de `turma.inscrever_se`, que já existe e grava a inscrição pela conta, sem o formulário público. Há também o link "Ver todos os cursos" para `/cursos`.
- **Prioridade**, sem usar dado sensível:
  1. reciclagem: o servidor tem certificado do mesmo treinamento vencendo em até 90 dias (`reciclagem.ts`). Mostra o selo "Seu certificado vence em 12/2026";
  2. treinamento marcado `obrigatorio` para o cargo ou setor, se esse vínculo existir;
  3. mesmo campus;
  4. a data mais próxima.
- **Esconde** a turma em que o servidor já está inscrito e mostra "Você já pediu vaga" no lugar.
- **Permissões**: precisa de `turma.inscrever_se`. Sem ela, mostra só o link para a vitrine.
- **LGPD**: o cálculo da reciclagem usa dados do próprio titular, sem novo tratamento.
- **Testes**: a ordem por prioridade, a turma já inscrita e a ausência de `inscrever_se`.

## 5. Ligação com a reciclagem
`aviso_reciclagem.ts` passa a incluir no e-mail o link da próxima turma divulgada do mesmo treinamento, quando houver. Não cria tratamento novo.

## 6. Gestão pela equipe

### 6.1 Na ficha da turma (`turma_ficha.html`)
- Novo bloco **"Vitrine de cursos"**:
  - interruptor "Divulgar na vitrine pública" (POST `/turmas/:id/vitrine`, com `publicar=1|0`);
  - campos título na vitrine, horário (ou hora início e fim), modalidade, público-alvo (caixas) e pré-requisito;
  - envio de arte;
  - prévia do cartão, igual à da vitrine;
  - os links "Ver na vitrine", "Baixar cartaz", "Post feed", "Story" e o QR.
- **Conferência antes de publicar.** A tela lista o que falta e não deixa publicar enquanto houver pendência:
  - setor promotor definido;
  - `inscricao_aberta_ate` preenchido, se a situação for aberta;
  - local ou modalidade EAD;
  - público-alvo com pelo menos 1 item;
  - descrição com pelo menos 40 caracteres.
- Ao publicar pela primeira vez com inscrição aberta, `divulgada_em` é gravado e `aviso_interesse.avisar_turma` é chamado. Despublicar não apaga nada, mas a ficha pública passa a dar 404.
- Mudança de situação para CANCELADA → despublica automaticamente e mostra "Turma cancelada" para quem tiver o link (410).
- Trilha: `TURMA_VITRINE_PUBLICADA`, `_DESPUBLICADA` e `TURMA_ARTE_ENVIADA` / `_REMOVIDA`.

### 6.2 Permissão multissetor
- Permissão nova `turma.divulgar` ("Publicar turma na vitrine e enviar arte"), concedida aos perfis que têm `turma.criar`.
- **Recorte por setor promotor**: hoje `aplicar_escopo` recorta por campus ou por dono, e não existe vínculo entre conta e setor promotor. Proposta: a tabela `equipe_setor_promotor` (1.4), mantida em `/treinamentos/setores-promotores` por quem tem `treinamento.gerenciar`. Regra em `vitrine.pode_divulgar(usuario, turma)`:
  - ESCOPO_TOTAL: passa;
  - nos demais casos, a conta precisa estar em `equipe_setor_promotor` com `unidade_id = turma.unidade_promotora_id`;
  - turma sem setor promotor só pode ser publicada por quem tem ESCOPO_TOTAL.
- A mesma regra vale para editar os campos da vitrine e a arte. Fica registrado em `DESVIOS.md` como recorte novo, ao lado do escopo de campus.
- A lista de turmas ganha o filtro "Na vitrine" e uma coluna com um ícone.
- **Contagem de interessados** (só número) por treinamento e por setor, em `/treinamentos/indicadores`.

### 6.3 Testes
- O membro da CSQV não publica uma turma da CSSO (403 e trilha da recusa).
- O ESCOPO_TOTAL publica qualquer turma.
- A conferência bloqueia a publicação incompleta.
- A primeira publicação dispara o aviso uma vez só.
- O cancelamento despublica.
- A arte de outra turma não pode ser vinculada.

## 7. Arte da turma

- **Armazenamento**: `anexos.ts` (Storage), com dono `turma` (tipo `turma_arte`) ou `treinamento` (tipo `treinamento_arte`, usada como padrão das turmas daquele curso). Uma arte ativa por dono; enviar outra substitui a anterior, que fica na trilha.
- **Aceita** PNG, JPEG e WebP, até 3 MB. O tipo é conferido pelos bytes iniciais, não pela extensão. **SVG e GIF não são aceitos.** As dimensões ficam entre 600×750 e 2160×2700, e a proporção recomendada é 4:5 (a tela mostra um aviso se fugir mais de 10%). Na gravação, remover os metadados EXIF (localização da foto). Se não houver biblioteca para isso, recusar JPEG com bloco GPS.
- **Declaração obrigatória** no envio: "Não há pessoas identificáveis na arte ou elas autorizaram o uso da imagem."
- **Acesso público**: `anexo_acesso.ts` ganha a regra declarada para `turma_arte` e `treinamento_arte`. A leitura é pública **somente** pela rota `/cursos/:codigo/arte`, e só enquanto a turma estiver divulgada. Pela rota interna de anexos vale a regra de `treinamento.ver`. A resposta leva `Content-Type` fixo do tipo conferido, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Cache-Control: public, max-age=86400` e ETag pelo hash.
- **Texto alternativo**: campo `alt` opcional; padrão = título do curso.
- **Fallback**: a capa gerada da seção 1.3, igual em HTML e no gerador do post.
- **Testes**:
  - SVG renomeado para .png → recusado;
  - turma despublicada → a arte dá 404;
  - EXIF removido;
  - outro setor não envia arte (403).

## 8. Plano de implementação em lotes (depois da fila atual)

Cada lote é um PR pequeno, com migração própria, testes e uma entrada em `DESVIOS.md` quando for o caso.

| Lote | Conteúdo | Depende de | Tamanho |
|---|---|---|---|
| **V0. Correções na inscrição pública** | Tirar o "CSSO" fixo (usar o setor promotor). Mostrar o conteúdo programático, a validade e as vagas restantes. Compactar o "Saiba mais sobre os dados" em 390px. | — | P |
| **V1. Dados e permissão** | Migração da seção 1.4. Drizzle. Permissão `turma.divulgar` e `equipe_setor_promotor` com a tela de manutenção. `vitrine.pode_divulgar`. Campos novos no formulário da turma e do treinamento (herança). Testes de permissão. | V0 | M |
| **V2. Vitrine e ficha (sem arte)** | `servicos/vitrine.ts`, `rotas/vitrine.ts`, `base_publica.html`, `vitrine.html`, `vitrine_curso.html` e `vitrine.css`. Capa gerada. Abas, filtros, selos e vagas. Refatoração de `pedir()` para aceitar a turma (origem VITRINE). Open Graph. Bloco de gestão "Divulgar na vitrine" com conferência e prévia. Link "Cursos" na tela de entrada e no rodapé. | V1 | G |
| **V3. Arte** | Envio, validação por bytes, EXIF, regra em `anexo_acesso`, rota pública da arte, prévia na ficha interna. | V2 | M |
| **V4. Quero ser avisado** | Tabelas `aviso_interesse` e `_envio`, serviço, rotas, e-mails de confirmação, aviso e descadastro (List-Unsubscribe), chave de ligar, expurgos em `rotinas.ts`/`privacidade.ts`, ROPA, contagens nos indicadores. | V2 (o e-mail sai quando o SMTP for configurado) | G |
| **V5. Divulgação** | QR na ficha, cartaz PDF A4, `.ics` (rota e anexo do e-mail de aceite), link de WhatsApp e "Copiar link" (`vitrine.js` opcional). | V2 | M |
| **V6. Meu espaço e reciclagem** | Bloco "Inscrições abertas para você", com prioridade pela reciclagem. Link da próxima turma no `aviso_reciclagem`. | V2 | P |
| **V7. Imagens de post (opcional)** | Geração de PNG feed e story (SVG → resvg-wasm), `og:image`. Feed `/cursos.json` para o portal. Contador agregado de capacitados no ano em "Realizados". | V3, V5 | M |

Ordem sugerida: V0 → V1 → V2 → V5 → V3 → V6 → V4 → V7. O V4 pode subir antes de o e-mail estar configurado, com a chave desligada.

### Questões em aberto para decidir
1. A hora fica só como texto (`horario`) ou também como `hora_inicio`/`hora_fim`? Recomendo as duas, para o `.ics` ficar certo.
2. As cores e os ícones de cada setor: confirmar com cada setor, inclusive a cor do CPEL.
3. O público "Comunidade" entra em toda turma ou só por marcação? Proposta: só por marcação.
4. Domínio público definitivo (`config.url_publica`): define o QR, o cartaz e o Open Graph.
5. O nome do instrutor aparece na vitrine? Proposta: só com a autorização dele (`exibir_na_vitrine`).
