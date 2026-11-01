-- =====================================================================
-- Travas de banco — ultima linha de defesa (nao substituem servico nem rota).
-- Porte de `app/banco.py` (TRIGGERS_ESQUEMA_INICIAL, TRIGGERS_EPI,
-- TRIGGERS_EPI_FICHA_COMPLETAVEL, TRIGGERS_DEMANDA) para PL/pgSQL.
--
-- IDEMPOTENTE: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS antes de
-- cada CREATE TRIGGER. E aplicado depois de TODA migracao (`src/db/migrar.ts`),
-- porque o drizzle-kit nao enxerga trigger — nem para criar, nem para avisar
-- que uma tabela recriada perdeu a sua. Foi exatamente o que o Python viveu com
-- o `batch_alter_table` do SQLite: reconstruir a tabela levava as triggers
-- junto, em silencio. Reaplicar tudo a cada migracao e a forma de nunca
-- depender de alguem lembrar.
--
-- Diferencas de dialeto, e por que cada uma preserva a regra:
--
-- * `IS NOT` do SQLite -> `IS DISTINCT FROM`. No SQLite `IS NOT` e a
--   desigualdade que trata NULL como valor; no PostgreSQL `IS NOT` so existe
--   antes de NULL/TRUE/FALSE, e `<>` com NULL devolve NULL — a trava da ficha
--   deixaria passar a troca de nulo por valor numa coluna congelada.
-- * `SELECT RAISE(ABORT, 'msg')` -> `RAISE EXCEPTION 'msg'`, com SQLSTATE
--   23000 (integrity_constraint_violation): o RAISE(ABORT) do SQLite chegava ao
--   Python como IntegrityError, e o texto da mensagem e o MESMO — os testes
--   casam por "append-only".
-- * `date('now')` do SQLite e a data em UTC. `CURRENT_DATE` do PostgreSQL
--   depende do fuso da SESSAO; `(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`
--   e a mesma data do SQLite qualquer que seja o fuso configurado.
-- * `WHEN (...)` de trigger nao aceita subconsulta no PostgreSQL, entao o
--   `NOT EXISTS` das travas de habilitacao mora dentro da funcao. As triggers
--   continuam duas por tabela (_ins e _upd), com os nomes do Python.
-- * TRUNCATE (NOVO): no SQLite nao existe TRUNCATE, e `DELETE FROM t` sem WHERE
--   passa pela trigger de DELETE linha a linha. No PostgreSQL o TRUNCATE nao
--   dispara trigger de linha nenhuma — sem a trava de TRUNCATE, "append-only"
--   teria uma porta dos fundos que o original nao tinha.
--
-- As listas de colunas da ficha estao tambem em `src/db/travas.ts`, e um teste
-- confere as duas contra o esquema.
-- =====================================================================


-- ---------------------------------------------------------------------
-- A recusa generica: a mensagem vem como argumento da trigger, e e a mesma do
-- Python, letra por letra.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION csso_recusar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'integrity_constraint_violation';
END;
$$;


-- =====================================================================
-- historico_evento — append-only (CA-16)
-- =====================================================================
DROP TRIGGER IF EXISTS trg_historico_sem_update ON historico_evento;
CREATE TRIGGER trg_historico_sem_update
  BEFORE UPDATE ON historico_evento
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('historico_evento e append-only: UPDATE proibido');

DROP TRIGGER IF EXISTS trg_historico_sem_delete ON historico_evento;
CREATE TRIGGER trg_historico_sem_delete
  BEFORE DELETE ON historico_evento
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('historico_evento e append-only: DELETE proibido');

DROP TRIGGER IF EXISTS trg_historico_sem_truncate ON historico_evento;
CREATE TRIGGER trg_historico_sem_truncate
  BEFORE TRUNCATE ON historico_evento
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('historico_evento e append-only: TRUNCATE proibido');


-- =====================================================================
-- RN-01, terceira trava: IN 15/2022 art. 10 SS2 I — so profissional habilitado
-- e VIGENTE na data do documento assina parecer emitido e subscreve laudo.
-- Sem data de emissao, vale a data de hoje (em UTC, como o `date('now')`).
-- =====================================================================
CREATE OR REPLACE FUNCTION csso_parecer_signatario_habilitado() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  referencia date := COALESCE(NEW.data_emissao, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date);
BEGIN
  IF NEW.situacao IN ('EMITIDO','ASSINADO')
     AND NOT EXISTS (
       SELECT 1 FROM profissional_habilitado ph
        WHERE ph.id = NEW.signatario_id
          AND ph.vigencia_inicio <= referencia
          AND (ph.vigencia_fim IS NULL OR ph.vigencia_fim >= referencia))
  THEN
    RAISE EXCEPTION 'IN 15/2022 art.10 SS2 I: signatario nao habilitado'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_parecer_signatario_habilitado_ins ON parecer_tecnico;
CREATE TRIGGER trg_parecer_signatario_habilitado_ins
  BEFORE INSERT ON parecer_tecnico
  FOR EACH ROW EXECUTE FUNCTION csso_parecer_signatario_habilitado();

DROP TRIGGER IF EXISTS trg_parecer_signatario_habilitado_upd ON parecer_tecnico;
CREATE TRIGGER trg_parecer_signatario_habilitado_upd
  BEFORE UPDATE ON parecer_tecnico
  FOR EACH ROW EXECUTE FUNCTION csso_parecer_signatario_habilitado();

CREATE OR REPLACE FUNCTION csso_laudo_subscritor_habilitado() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  referencia date := COALESCE(NEW.data_emissao, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date);
BEGIN
  IF NEW.subscritor_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM profissional_habilitado ph
        WHERE ph.id = NEW.subscritor_id
          AND ph.vigencia_inicio <= referencia
          AND (ph.vigencia_fim IS NULL OR ph.vigencia_fim >= referencia))
  THEN
    RAISE EXCEPTION 'IN 15/2022 art.10 SS2 I: subscritor nao habilitado'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_laudo_subscritor_habilitado_ins ON laudo_tecnico;
CREATE TRIGGER trg_laudo_subscritor_habilitado_ins
  BEFORE INSERT ON laudo_tecnico
  FOR EACH ROW EXECUTE FUNCTION csso_laudo_subscritor_habilitado();

DROP TRIGGER IF EXISTS trg_laudo_subscritor_habilitado_upd ON laudo_tecnico;
CREATE TRIGGER trg_laudo_subscritor_habilitado_upd
  BEFORE UPDATE ON laudo_tecnico
  FOR EACH ROW EXECUTE FUNCTION csso_laudo_subscritor_habilitado();


-- =====================================================================
-- RN-31 — a ficha de EPI e o razao do estoque. Os dois valem como prova, e
-- prova que se edita nao e prova. Correcao e linha nova — `ESTORNO` na ficha,
-- `AJUSTE` no razao —, nunca rasura na linha errada.
-- =====================================================================

-- A trava da ficha, na forma revista da fatia 2 do EPI (TRIGGERS_EPI_FICHA_
-- COMPLETAVEL, que substituiu o `sem_update` total de TRIGGERS_EPI).
--
-- A linha da ficha nasce e, so depois de existir, descobre tres coisas sobre
-- si mesma: `evento_id` (o evento da cadeia precisa do id da linha, que so
-- existe depois do INSERT — sorteia-lo antes por MAX(id)+1 e o que a RN-03
-- proibe), `comprovante_anexo_id` (o papel assinado e digitalizado depois,
-- decisao 8) e `recebimento_confirmado_em` (quando a prova chegou).
--
-- O que continua impossivel e o que importa: **nenhuma das 28 colunas de
-- conteudo muda**, e as tres acima sao de escrita unica — de nulo para valor.
-- Completar um registro nao e reescreve-lo.
CREATE OR REPLACE FUNCTION csso_epi_ficha_sem_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.servidor_id IS DISTINCT FROM OLD.servidor_id
     OR NEW.epi_item_id IS DISTINCT FROM OLD.epi_item_id
     OR NEW.requisicao_item_id IS DISTINCT FROM OLD.requisicao_item_id
     OR NEW.entrada_id IS DISTINCT FROM OLD.entrada_id
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.quantidade IS DISTINCT FROM OLD.quantidade
     OR NEW.data_evento IS DISTINCT FROM OLD.data_evento
     OR NEW.nome_epi_snapshot IS DISTINCT FROM OLD.nome_epi_snapshot
     OR NEW.categoria_snapshot IS DISTINCT FROM OLD.categoria_snapshot
     OR NEW.numero_ca_snapshot IS DISTINCT FROM OLD.numero_ca_snapshot
     OR NEW.validade_ca_snapshot IS DISTINCT FROM OLD.validade_ca_snapshot
     OR NEW.fabricante_snapshot IS DISTINCT FROM OLD.fabricante_snapshot
     OR NEW.lote_snapshot IS DISTINCT FROM OLD.lote_snapshot
     OR NEW.tamanho_snapshot IS DISTINCT FROM OLD.tamanho_snapshot
     OR NEW.nome_servidor_snapshot IS DISTINCT FROM OLD.nome_servidor_snapshot
     OR NEW.siape_snapshot IS DISTINCT FROM OLD.siape_snapshot
     OR NEW.cargo_snapshot IS DISTINCT FROM OLD.cargo_snapshot
     OR NEW.unidade_snapshot IS DISTINCT FROM OLD.unidade_snapshot
     OR NEW.posto_snapshot IS DISTINCT FROM OLD.posto_snapshot
     OR NEW.contexto_congelado IS DISTINCT FROM OLD.contexto_congelado
     OR NEW.previsao_troca IS DISTINCT FROM OLD.previsao_troca
     OR NEW.entregue_por IS DISTINCT FROM OLD.entregue_por
     OR NEW.motivo IS DISTINCT FROM OLD.motivo
     OR NEW.registro_estornado_id IS DISTINCT FROM OLD.registro_estornado_id
     OR NEW.registrado_em IS DISTINCT FROM OLD.registrado_em
     OR NEW.motivo_codigo IS DISTINCT FROM OLD.motivo_codigo
     OR NEW.orientacao_anexo_id IS DISTINCT FROM OLD.orientacao_anexo_id
     OR (OLD.evento_id IS NOT NULL AND NEW.evento_id IS DISTINCT FROM OLD.evento_id)
     OR (OLD.comprovante_anexo_id IS NOT NULL AND NEW.comprovante_anexo_id IS DISTINCT FROM OLD.comprovante_anexo_id)
     OR (OLD.recebimento_confirmado_em IS NOT NULL AND NEW.recebimento_confirmado_em IS DISTINCT FROM OLD.recebimento_confirmado_em)
  THEN
    RAISE EXCEPTION 'epi_ficha_registro e append-only: o conteudo nao se altera, e evento_id, comprovante_anexo_id e recebimento_confirmado_em se preenchem uma unica vez. Correcao e linha nova de tipo ESTORNO, com motivo.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_epi_ficha_sem_update ON epi_ficha_registro;
CREATE TRIGGER trg_epi_ficha_sem_update
  BEFORE UPDATE ON epi_ficha_registro
  FOR EACH ROW EXECUTE FUNCTION csso_epi_ficha_sem_update();

DROP TRIGGER IF EXISTS trg_epi_ficha_sem_delete ON epi_ficha_registro;
CREATE TRIGGER trg_epi_ficha_sem_delete
  BEFORE DELETE ON epi_ficha_registro
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('epi_ficha_registro e append-only: DELETE proibido');

DROP TRIGGER IF EXISTS trg_epi_ficha_sem_truncate ON epi_ficha_registro;
CREATE TRIGGER trg_epi_ficha_sem_truncate
  BEFORE TRUNCATE ON epi_ficha_registro
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('epi_ficha_registro e append-only: TRUNCATE proibido');

DROP TRIGGER IF EXISTS trg_epi_movimento_sem_update ON epi_movimento_estoque;
CREATE TRIGGER trg_epi_movimento_sem_update
  BEFORE UPDATE ON epi_movimento_estoque
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('epi_movimento_estoque e append-only: UPDATE proibido');

DROP TRIGGER IF EXISTS trg_epi_movimento_sem_delete ON epi_movimento_estoque;
CREATE TRIGGER trg_epi_movimento_sem_delete
  BEFORE DELETE ON epi_movimento_estoque
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('epi_movimento_estoque e append-only: DELETE proibido');

DROP TRIGGER IF EXISTS trg_epi_movimento_sem_truncate ON epi_movimento_estoque;
CREATE TRIGGER trg_epi_movimento_sem_truncate
  BEFORE TRUNCATE ON epi_movimento_estoque
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('epi_movimento_estoque e append-only: TRUNCATE proibido');


-- =====================================================================
-- RN-31 no encaminhamento da demanda. A linha diz que em 12/03 se pediu tal
-- coisa a tal pessoa, e uma linha dessas que se possa reescrever nao serve
-- para cobrar ninguem — inclusive porque quem cobra e quem escreveu.
--
-- A demanda em si NAO e append-only: ela e o registro vivo; o encaminhamento
-- e o fato datado. (Consequencia herdada do Python: apagar uma demanda que ja
-- tem encaminhamento e recusado, porque o ON DELETE CASCADE bate nesta trava.)
-- =====================================================================
DROP TRIGGER IF EXISTS trg_demanda_encaminhamento_sem_update ON demanda_encaminhamento;
CREATE TRIGGER trg_demanda_encaminhamento_sem_update
  BEFORE UPDATE ON demanda_encaminhamento
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('demanda_encaminhamento e append-only: UPDATE proibido. Correcao e encaminhamento novo, dizendo o que mudou.');

DROP TRIGGER IF EXISTS trg_demanda_encaminhamento_sem_delete ON demanda_encaminhamento;
CREATE TRIGGER trg_demanda_encaminhamento_sem_delete
  BEFORE DELETE ON demanda_encaminhamento
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('demanda_encaminhamento e append-only: DELETE proibido.');

DROP TRIGGER IF EXISTS trg_demanda_encaminhamento_sem_truncate ON demanda_encaminhamento;
CREATE TRIGGER trg_demanda_encaminhamento_sem_truncate
  BEFORE TRUNCATE ON demanda_encaminhamento
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('demanda_encaminhamento e append-only: TRUNCATE proibido.');


-- =====================================================================
-- A marca de producao (`instalacao`, gravada por ferramentas/producao-iniciar.ts)
-- nao se desfaz pela aplicacao. E ela que faz `ambiente-teste` e
-- `producao-iniciar` recusarem o banco — uma marca que um UPDATE apagasse nao
-- travaria nada. Desfazer e gesto manual no editor SQL (PRODUCAO.md):
-- ALTER TABLE instalacao DISABLE TRIGGER USER; DELETE ...; ENABLE TRIGGER USER.
-- =====================================================================
DROP TRIGGER IF EXISTS trg_instalacao_sem_update ON instalacao;
CREATE TRIGGER trg_instalacao_sem_update
  BEFORE UPDATE ON instalacao
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('instalacao: a marca de producao nao se altera pela aplicacao');

DROP TRIGGER IF EXISTS trg_instalacao_sem_delete ON instalacao;
CREATE TRIGGER trg_instalacao_sem_delete
  BEFORE DELETE ON instalacao
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('instalacao: a marca de producao nao se apaga pela aplicacao');

DROP TRIGGER IF EXISTS trg_instalacao_sem_truncate ON instalacao;
CREATE TRIGGER trg_instalacao_sem_truncate
  BEFORE TRUNCATE ON instalacao
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('instalacao: a marca de producao nao se apaga pela aplicacao');


-- =====================================================================
-- 0015 (paridade com o IntegraSST, 22/10/2026): a comunicacao do titular
-- sobre o EPI que esta com ele. Ela nao e append-only — o titular a RETIRA (ate
-- 24 h) e a equipe a TRATA, colunas que se preenchem —, mas nao se apaga: a
-- linha e o registro de que a pessoa comunicou, e quando.
-- =====================================================================
DROP TRIGGER IF EXISTS trg_epi_comunicacao_sem_delete ON epi_comunicacao_titular;
CREATE TRIGGER trg_epi_comunicacao_sem_delete
  BEFORE DELETE ON epi_comunicacao_titular
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('epi_comunicacao_titular: a comunicacao nao se apaga. O titular a retira, a equipe a trata.');

DROP TRIGGER IF EXISTS trg_epi_comunicacao_sem_truncate ON epi_comunicacao_titular;
CREATE TRIGGER trg_epi_comunicacao_sem_truncate
  BEFORE TRUNCATE ON epi_comunicacao_titular
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('epi_comunicacao_titular: a comunicacao nao se apaga.');

-- =====================================================================
-- 0016 (Portal do servidor, 22/10/2026): o codigo curto do treinamento e o
-- numero impresso do certificado.
--
-- 1. O codigo curto e obrigatorio, mas quem cadastra sem ele (ou com '')
--    recebe a sugestao — a MESMA regra de `sugerir_codigo_curto`
--    (`dominio/treinamento.ts`) e da migracao 0016 —, com algarismo no fim
--    quando ja existe.
-- 2. O numero impresso (`CSSO-NR35-2026-0001`), o numero/ano internos e a
--    chave de validacao sao CONTEUDO do papel que circula: depois de gravados,
--    nao mudam. Anular e retificar mexem em outras colunas.
-- =====================================================================
CREATE OR REPLACE FUNCTION csso_sem_acento_maiusculo(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(translate(coalesce(p, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
    'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'))
$$;

CREATE OR REPLACE FUNCTION csso_sugerir_codigo_curto(p_nome text, p_codigo text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  fonte text := csso_sem_acento_maiusculo(coalesce(p_nome, '') || ' ' || coalesce(p_codigo, ''));
  nr text[];
  base text;
  iniciais text := '';
  palavra text;
BEGIN
  nr := regexp_match(fonte, '(^|[^A-Z0-9_])NR\s*[-–—]?\s*0*([0-9]{1,2})([^A-Z0-9_]|$)');
  IF nr IS NOT NULL THEN
    RETURN 'NR' || nr[2];
  END IF;
  base := left(regexp_replace(csso_sem_acento_maiusculo(p_codigo), '[^A-Z0-9]', '', 'g'), 10);
  IF length(base) >= 2 THEN
    RETURN base;
  END IF;
  FOR palavra IN SELECT w FROM regexp_split_to_table(csso_sem_acento_maiusculo(p_nome), '[^A-Z0-9]+') AS w LOOP
    IF length(palavra) >= 3 AND palavra NOT IN ('DAS', 'DOS', 'NOS', 'NAS', 'PARA', 'COM', 'POR') THEN
      iniciais := iniciais || left(palavra, 1);
    END IF;
  END LOOP;
  iniciais := left(iniciais, 6);
  IF length(iniciais) >= 2 THEN
    RETURN iniciais;
  END IF;
  base := left(regexp_replace(csso_sem_acento_maiusculo(p_nome), '[^A-Z0-9]', '', 'g'), 4);
  IF length(base) >= 2 THEN
    RETURN base;
  END IF;
  RETURN 'TR';
END;
$$;

CREATE OR REPLACE FUNCTION csso_codigo_curto_livre(p_base text, p_id integer) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  candidato text := p_base;
  i integer := 2;
BEGIN
  WHILE EXISTS (SELECT 1 FROM treinamento WHERE codigo_curto = candidato AND id IS DISTINCT FROM p_id) LOOP
    candidato := left(p_base, 10 - length(i::text)) || i::text;
    i := i + 1;
  END LOOP;
  RETURN candidato;
END;
$$;

CREATE OR REPLACE FUNCTION csso_treinamento_codigo_curto() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.codigo_curto IS NULL OR NEW.codigo_curto = '' THEN
    NEW.codigo_curto := csso_codigo_curto_livre(csso_sugerir_codigo_curto(NEW.nome, NEW.codigo), NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_treinamento_codigo_curto ON treinamento;
CREATE TRIGGER trg_treinamento_codigo_curto
  BEFORE INSERT OR UPDATE OF codigo_curto ON treinamento
  FOR EACH ROW EXECUTE FUNCTION csso_treinamento_codigo_curto();

CREATE OR REPLACE FUNCTION csso_certificado_numero_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.numero_impresso IS DISTINCT FROM OLD.numero_impresso
     OR NEW.chave_validacao IS DISTINCT FROM OLD.chave_validacao
     OR NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.ano IS DISTINCT FROM OLD.ano THEN
    RAISE EXCEPTION 'certificado: numero e chave de validacao nao mudam depois de emitidos'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_certificado_numero_imutavel ON certificado;
CREATE TRIGGER trg_certificado_numero_imutavel
  BEFORE UPDATE ON certificado
  FOR EACH ROW EXECUTE FUNCTION csso_certificado_numero_imutavel();

-- =====================================================================
-- 0017 (Dono de treinamento e turma, 23/10/2026): o DONO nao se troca.
--
-- `criado_por` do treinamento e da turma e o dono (`servicos/dono_turma.ts`):
-- so ele, ou quem esta acima dele na hierarquia, altera. Trocar o dono depois
-- de gravado daria a qualquer um um atalho para "virar dono". O nulo (o "sem
-- dono" de antes da regra) pode ser preenchido uma vez — e o que a migracao
-- 0017 faz a partir da trilha —, mas o dono gravado nao muda nem se apaga.
-- =====================================================================
CREATE OR REPLACE FUNCTION csso_dono_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.criado_por IS NOT NULL AND NEW.criado_por IS DISTINCT FROM OLD.criado_por THEN
    RAISE EXCEPTION '%: o dono (criado_por) nao muda depois de gravado', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_treinamento_dono_imutavel ON treinamento;
CREATE TRIGGER trg_treinamento_dono_imutavel
  BEFORE UPDATE OF criado_por ON treinamento
  FOR EACH ROW EXECUTE FUNCTION csso_dono_imutavel();

DROP TRIGGER IF EXISTS trg_turma_dono_imutavel ON turma;
CREATE TRIGGER trg_turma_dono_imutavel
  BEFORE UPDATE OF criado_por ON turma
  FOR EACH ROW EXECUTE FUNCTION csso_dono_imutavel();

-- =====================================================================
-- 0021 (Modulo de acidentes, 23/10/2026): a CAT/SP e a prova, e prova nao se
-- reescreve. Tres familias de trava:
--
-- 1. APPEND-ONLY (sem UPDATE, DELETE nem TRUNCATE): a CAT/SP versionada, o
--    relatorio emitido, o encaminhamento ao SIASS e a decisao pericial. Correcao
--    e linha nova, que aponta a anterior (`substitui_id`).
-- 2. SEM DELETE nem TRUNCATE (a linha e permanente — POLITICA_RETENCAO §2.4 —,
--    mas o tramite a atualiza): a ocorrencia, o acidentado, a testemunha, o nucleo
--    de saude, a acao do plano, a entrevista, a investigacao e a complementacao.
-- 3. COLUNAS CONGELADAS na ocorrencia: a identidade (protocolo, ano, numero,
--    tipo, reabertura, origem, autor) nunca muda; os fatos do evento so mudam
--    junto com uma versao NOVA da CAT/SP (`cat_sp_versao` sobe para uma versao
--    que existe); o resto e tramite. As listas estao em `travas.ts`, e um teste
--    as confere contra o esquema e contra esta funcao.
-- =====================================================================
DROP TRIGGER IF EXISTS trg_acidente_cat_sp_sem_update ON acidente_cat_sp;
CREATE TRIGGER trg_acidente_cat_sp_sem_update
  BEFORE UPDATE ON acidente_cat_sp
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_cat_sp e append-only: UPDATE proibido. Correcao e a versao seguinte, com motivo e `substitui_id`.');

DROP TRIGGER IF EXISTS trg_acidente_cat_sp_sem_delete ON acidente_cat_sp;
CREATE TRIGGER trg_acidente_cat_sp_sem_delete
  BEFORE DELETE ON acidente_cat_sp
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_cat_sp e append-only: DELETE proibido.');

DROP TRIGGER IF EXISTS trg_acidente_cat_sp_sem_truncate ON acidente_cat_sp;
CREATE TRIGGER trg_acidente_cat_sp_sem_truncate
  BEFORE TRUNCATE ON acidente_cat_sp
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_cat_sp e append-only: TRUNCATE proibido.');

DROP TRIGGER IF EXISTS trg_acidente_relatorio_sem_update ON acidente_relatorio;
CREATE TRIGGER trg_acidente_relatorio_sem_update
  BEFORE UPDATE ON acidente_relatorio
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_relatorio e append-only: UPDATE proibido. Retificar e emitir a versao seguinte, com motivo.');

DROP TRIGGER IF EXISTS trg_acidente_relatorio_sem_delete ON acidente_relatorio;
CREATE TRIGGER trg_acidente_relatorio_sem_delete
  BEFORE DELETE ON acidente_relatorio
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_relatorio e append-only: DELETE proibido.');

DROP TRIGGER IF EXISTS trg_acidente_relatorio_sem_truncate ON acidente_relatorio;
CREATE TRIGGER trg_acidente_relatorio_sem_truncate
  BEFORE TRUNCATE ON acidente_relatorio
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_relatorio e append-only: TRUNCATE proibido.');

DROP TRIGGER IF EXISTS trg_acidente_encaminhamento_sem_update ON acidente_encaminhamento;
CREATE TRIGGER trg_acidente_encaminhamento_sem_update
  BEFORE UPDATE ON acidente_encaminhamento
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_encaminhamento e append-only: UPDATE proibido. Correcao e encaminhamento novo, dizendo o que mudou.');

DROP TRIGGER IF EXISTS trg_acidente_encaminhamento_sem_delete ON acidente_encaminhamento;
CREATE TRIGGER trg_acidente_encaminhamento_sem_delete
  BEFORE DELETE ON acidente_encaminhamento
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_encaminhamento e append-only: DELETE proibido.');

DROP TRIGGER IF EXISTS trg_acidente_encaminhamento_sem_truncate ON acidente_encaminhamento;
CREATE TRIGGER trg_acidente_encaminhamento_sem_truncate
  BEFORE TRUNCATE ON acidente_encaminhamento
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_encaminhamento e append-only: TRUNCATE proibido.');

DROP TRIGGER IF EXISTS trg_acidente_decisao_sem_update ON acidente_decisao_pericial;
CREATE TRIGGER trg_acidente_decisao_sem_update
  BEFORE UPDATE ON acidente_decisao_pericial
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_decisao_pericial e append-only: UPDATE proibido. Correcao e decisao nova, que substitui a anterior.');

DROP TRIGGER IF EXISTS trg_acidente_decisao_sem_delete ON acidente_decisao_pericial;
CREATE TRIGGER trg_acidente_decisao_sem_delete
  BEFORE DELETE ON acidente_decisao_pericial
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_decisao_pericial e append-only: DELETE proibido.');

DROP TRIGGER IF EXISTS trg_acidente_decisao_sem_truncate ON acidente_decisao_pericial;
CREATE TRIGGER trg_acidente_decisao_sem_truncate
  BEFORE TRUNCATE ON acidente_decisao_pericial
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_decisao_pericial e append-only: TRUNCATE proibido.');

CREATE OR REPLACE FUNCTION csso_acidente_ocorrencia_congelada() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- a identidade da ocorrencia nao muda nunca
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.protocolo IS DISTINCT FROM OLD.protocolo
     OR NEW.ano IS DISTINCT FROM OLD.ano
     OR NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.tipo_cat IS DISTINCT FROM OLD.tipo_cat
     OR NEW.reabre_id IS DISTINCT FROM OLD.reabre_id
     OR NEW.origem IS DISTINCT FROM OLD.origem
     OR NEW.criado_por IS DISTINCT FROM OLD.criado_por
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.token_envio IS DISTINCT FROM OLD.token_envio
  THEN
    RAISE EXCEPTION 'acidente_ocorrencia: protocolo, tipo, origem e autor nao mudam depois de gravados'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- encerrada e encerrada: o estado final nao sai do lugar
  IF OLD.estado IN ('CONCLUIDA', 'CANCELADA') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
    RAISE EXCEPTION 'acidente_ocorrencia: ocorrencia % nao sai do estado final (reabrir e abrir ocorrencia nova)', OLD.estado
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- a versao da CAT/SP que as colunas espelham so sobe, e para uma versao que existe
  IF NEW.cat_sp_versao < OLD.cat_sp_versao THEN
    RAISE EXCEPTION 'acidente_ocorrencia: a versao da CAT/SP nao volta'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.cat_sp_versao > OLD.cat_sp_versao AND NOT EXISTS (
       SELECT 1 FROM acidente_cat_sp WHERE ocorrencia_id = OLD.id AND versao = NEW.cat_sp_versao) THEN
    RAISE EXCEPTION 'acidente_ocorrencia: a versao % da CAT/SP nao existe', NEW.cat_sp_versao
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- os fatos do evento so mudam por retificacao: junto de uma versao nova da CAT/SP
  IF NEW.especie IS DISTINCT FROM OLD.especie
     OR NEW.data_evento IS DISTINCT FROM OLD.data_evento
     OR NEW.hora_evento IS DISTINCT FROM OLD.hora_evento
     OR NEW.minutos_apos_inicio_jornada IS DISTINCT FROM OLD.minutos_apos_inicio_jornada
     OR NEW.ultimo_dia_trabalho IS DISTINCT FROM OLD.ultimo_dia_trabalho
     OR NEW.local_tipo IS DISTINCT FROM OLD.local_tipo
     OR NEW.local_especificacao IS DISTINCT FROM OLD.local_especificacao
     OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
     OR NEW.local_unidade_uorg_id IS DISTINCT FROM OLD.local_unidade_uorg_id
     OR NEW.local_municipio IS DISTINCT FROM OLD.local_municipio
     OR NEW.local_uf IS DISTINCT FROM OLD.local_uf
     OR NEW.local_cnpj_contratada IS DISTINCT FROM OLD.local_cnpj_contratada
     OR NEW.transito_registro_policial IS DISTINCT FROM OLD.transito_registro_policial
     OR NEW.transito_numero_bo IS DISTINCT FROM OLD.transito_numero_bo
     OR NEW.transito_vitima_terceiros IS DISTINCT FROM OLD.transito_vitima_terceiros
     OR NEW.agente_causador_id IS DISTINCT FROM OLD.agente_causador_id
     OR NEW.agente_doenca_id IS DISTINCT FROM OLD.agente_doenca_id
     OR NEW.situacao_geradora_id IS DISTINCT FROM OLD.situacao_geradora_id
     OR NEW.servidor_id IS DISTINCT FROM OLD.servidor_id
     OR NEW.prazo_comunicacao IS DISTINCT FROM OLD.prazo_comunicacao
     OR NEW.restrita_sst IS DISTINCT FROM OLD.restrita_sst
  THEN
    IF NEW.cat_sp_versao <= OLD.cat_sp_versao THEN
      RAISE EXCEPTION 'acidente_ocorrencia: os fatos do evento so mudam por retificacao, com uma versao nova da CAT/SP'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_acidente_ocorrencia_congelada ON acidente_ocorrencia;
CREATE TRIGGER trg_acidente_ocorrencia_congelada
  BEFORE UPDATE ON acidente_ocorrencia
  FOR EACH ROW EXECUTE FUNCTION csso_acidente_ocorrencia_congelada();

DROP TRIGGER IF EXISTS trg_acidente_ocorrencia_sem_delete ON acidente_ocorrencia;
CREATE TRIGGER trg_acidente_ocorrencia_sem_delete
  BEFORE DELETE ON acidente_ocorrencia
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_ocorrencia: a ocorrencia e guardada para sempre. Cancele (com motivo) em vez de apagar.');

DROP TRIGGER IF EXISTS trg_acidente_ocorrencia_sem_truncate ON acidente_ocorrencia;
CREATE TRIGGER trg_acidente_ocorrencia_sem_truncate
  BEFORE TRUNCATE ON acidente_ocorrencia
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_ocorrencia: a ocorrencia e guardada para sempre. Cancele (com motivo) em vez de apagar.');

DROP TRIGGER IF EXISTS trg_acidentado_sem_delete ON acidentado;
CREATE TRIGGER trg_acidentado_sem_delete
  BEFORE DELETE ON acidentado
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidentado: o envolvido e guardado para sempre. Correcao e retificacao da CAT/SP.');

DROP TRIGGER IF EXISTS trg_acidentado_sem_truncate ON acidentado;
CREATE TRIGGER trg_acidentado_sem_truncate
  BEFORE TRUNCATE ON acidentado
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidentado: o envolvido e guardado para sempre. Correcao e retificacao da CAT/SP.');

DROP TRIGGER IF EXISTS trg_acidente_testemunha_sem_delete ON acidente_testemunha;
CREATE TRIGGER trg_acidente_testemunha_sem_delete
  BEFORE DELETE ON acidente_testemunha
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_testemunha: a testemunha nao se apaga. Correcao e retificacao da CAT/SP.');

DROP TRIGGER IF EXISTS trg_acidente_testemunha_sem_truncate ON acidente_testemunha;
CREATE TRIGGER trg_acidente_testemunha_sem_truncate
  BEFORE TRUNCATE ON acidente_testemunha
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_testemunha: a testemunha nao se apaga. Correcao e retificacao da CAT/SP.');

DROP TRIGGER IF EXISTS trg_acidente_investigacao_sem_delete ON acidente_investigacao;
CREATE TRIGGER trg_acidente_investigacao_sem_delete
  BEFORE DELETE ON acidente_investigacao
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_investigacao: a investigacao e guardada para sempre.');

DROP TRIGGER IF EXISTS trg_acidente_investigacao_sem_truncate ON acidente_investigacao;
CREATE TRIGGER trg_acidente_investigacao_sem_truncate
  BEFORE TRUNCATE ON acidente_investigacao
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_investigacao: a investigacao e guardada para sempre.');

DROP TRIGGER IF EXISTS trg_acidente_acao_sem_delete ON acidente_acao;
CREATE TRIGGER trg_acidente_acao_sem_delete
  BEFORE DELETE ON acidente_acao
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_acao: a acao do plano nao se apaga. Cancele (com motivo) em vez de apagar.');

DROP TRIGGER IF EXISTS trg_acidente_acao_sem_truncate ON acidente_acao;
CREATE TRIGGER trg_acidente_acao_sem_truncate
  BEFORE TRUNCATE ON acidente_acao
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_acao: a acao do plano nao se apaga. Cancele (com motivo) em vez de apagar.');

DROP TRIGGER IF EXISTS trg_acidente_entrevista_sem_delete ON acidente_entrevista;
CREATE TRIGGER trg_acidente_entrevista_sem_delete
  BEFORE DELETE ON acidente_entrevista
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_entrevista: a entrevista e dado de terceiro de guarda permanente e nao se apaga.');

DROP TRIGGER IF EXISTS trg_acidente_entrevista_sem_truncate ON acidente_entrevista;
CREATE TRIGGER trg_acidente_entrevista_sem_truncate
  BEFORE TRUNCATE ON acidente_entrevista
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_entrevista: a entrevista e dado de terceiro de guarda permanente e nao se apaga.');

DROP TRIGGER IF EXISTS trg_acidente_complementacao_sem_delete ON acidente_complementacao;
CREATE TRIGGER trg_acidente_complementacao_sem_delete
  BEFORE DELETE ON acidente_complementacao
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_complementacao: o pedido de complementacao e guardado para sempre.');

DROP TRIGGER IF EXISTS trg_acidente_complementacao_sem_truncate ON acidente_complementacao;
CREATE TRIGGER trg_acidente_complementacao_sem_truncate
  BEFORE TRUNCATE ON acidente_complementacao
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_complementacao: o pedido de complementacao e guardado para sempre.');

-- O pedido de complementacao nao se reescreve; so a resposta se preenche, UMA vez.
CREATE OR REPLACE FUNCTION csso_acidente_complementacao_resposta() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ocorrencia_id IS DISTINCT FROM OLD.ocorrencia_id
     OR NEW.pedido_texto IS DISTINCT FROM OLD.pedido_texto
     OR NEW.pedido_por IS DISTINCT FROM OLD.pedido_por
     OR NEW.pedido_em IS DISTINCT FROM OLD.pedido_em
     OR (OLD.resposta_cat_sp_id IS NOT NULL AND NEW.resposta_cat_sp_id IS DISTINCT FROM OLD.resposta_cat_sp_id)
     OR (OLD.respondida_por IS NOT NULL AND NEW.respondida_por IS DISTINCT FROM OLD.respondida_por)
     OR (OLD.respondida_em IS NOT NULL AND NEW.respondida_em IS DISTINCT FROM OLD.respondida_em)
  THEN
    RAISE EXCEPTION 'acidente_complementacao: o pedido nao se altera, e a resposta se preenche uma unica vez'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_acidente_complementacao_resposta ON acidente_complementacao;
CREATE TRIGGER trg_acidente_complementacao_resposta
  BEFORE UPDATE ON acidente_complementacao
  FOR EACH ROW EXECUTE FUNCTION csso_acidente_complementacao_resposta();

-- O nucleo de saude: o nivel 2 (dias, datas, primeiro socorro) so vai a NULL
-- junto do carimbo `detalhe_expurgado_em`, e depois do expurgo nao se preenche
-- de novo. O expurgo parcial e ato manual, com simulacao (POLITICA §2.4).
CREATE OR REPLACE FUNCTION csso_acidente_saude_expurgo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.acidentado_id IS DISTINCT FROM OLD.acidentado_id THEN
    RAISE EXCEPTION 'acidente_saude: o nucleo de saude nao muda de acidentado'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.detalhe_expurgado_em IS NOT NULL AND NEW.detalhe_expurgado_em IS DISTINCT FROM OLD.detalhe_expurgado_em THEN
    RAISE EXCEPTION 'acidente_saude: o carimbo de expurgo nao se altera'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF ((OLD.dias_afastamento IS NOT NULL AND NEW.dias_afastamento IS NULL)
       OR (OLD.afastamento_inicio IS NOT NULL AND NEW.afastamento_inicio IS NULL)
       OR (OLD.afastamento_retorno IS NOT NULL AND NEW.afastamento_retorno IS NULL)
       OR (OLD.dias_internacao IS NOT NULL AND NEW.dias_internacao IS NULL)
       OR (OLD.data_obito IS NOT NULL AND NEW.data_obito IS NULL)
       OR (OLD.dias_debitados IS NOT NULL AND NEW.dias_debitados IS NULL)
       OR (OLD.primeiro_socorro_por IS NOT NULL AND NEW.primeiro_socorro_por IS NULL)
       OR (OLD.primeiro_socorro_unidade IS NOT NULL AND NEW.primeiro_socorro_unidade IS NULL)
       OR (OLD.duracao_tratamento_dias IS NOT NULL AND NEW.duracao_tratamento_dias IS NULL)
       OR (OLD.deve_afastar IS NOT NULL AND NEW.deve_afastar IS NULL)
       OR (OLD.descricao_lesao IS NOT NULL AND NEW.descricao_lesao IS NULL)
       OR (OLD.diagnostico_provavel IS NOT NULL AND NEW.diagnostico_provavel IS NULL)
       OR (OLD.cid IS NOT NULL AND NEW.cid IS NULL)
       OR (OLD.observacoes_saude IS NOT NULL AND NEW.observacoes_saude IS NULL)
       OR (OLD.atendimento_em IS NOT NULL AND NEW.atendimento_em IS NULL))
     AND NEW.detalhe_expurgado_em IS NULL THEN
    RAISE EXCEPTION 'acidente_saude: o nivel 2 so vai a NULL junto do carimbo de expurgo (detalhe_expurgado_em)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.detalhe_expurgado_em IS NOT NULL AND (NEW.dias_afastamento IS NOT NULL
       OR NEW.afastamento_inicio IS NOT NULL
       OR NEW.afastamento_retorno IS NOT NULL
       OR NEW.dias_internacao IS NOT NULL
       OR NEW.data_obito IS NOT NULL
       OR NEW.dias_debitados IS NOT NULL
       OR NEW.primeiro_socorro_por IS NOT NULL
       OR NEW.primeiro_socorro_unidade IS NOT NULL
       OR NEW.duracao_tratamento_dias IS NOT NULL
       OR NEW.deve_afastar IS NOT NULL
       OR NEW.descricao_lesao IS NOT NULL
       OR NEW.diagnostico_provavel IS NOT NULL
       OR NEW.cid IS NOT NULL
       OR NEW.observacoes_saude IS NOT NULL
       OR NEW.atendimento_em IS NOT NULL) THEN
    RAISE EXCEPTION 'acidente_saude: o nivel 2 expurgado nao se preenche de novo'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_acidente_saude_expurgo ON acidente_saude;
CREATE TRIGGER trg_acidente_saude_expurgo
  BEFORE UPDATE ON acidente_saude
  FOR EACH ROW EXECUTE FUNCTION csso_acidente_saude_expurgo();

-- A identificacao pessoal e o contato da testemunha tem o mesmo expurgo parcial:
-- os campos vao a NULL junto de `expurgado_em`; o carimbo nao se altera e,
-- depois dele, nada se preenche de novo (POLITICA §2.4, ROPA §0.6).
CREATE OR REPLACE FUNCTION csso_acidente_identificacao_expurgo() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dados jsonb;
BEGIN
  IF OLD.expurgado_em IS NOT NULL AND NEW.expurgado_em IS DISTINCT FROM OLD.expurgado_em THEN
    RAISE EXCEPTION '%: o carimbo de expurgo nao se altera', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.expurgado_em IS NOT NULL THEN
    dados := to_jsonb(NEW) - ARRAY['acidentado_id', 'testemunha_id', 'registrado_por', 'registrado_em', 'expurgado_em'];
    IF EXISTS (SELECT 1 FROM jsonb_each(dados) WHERE value <> 'null'::jsonb) THEN
      RAISE EXCEPTION '%: o dado expurgado nao se preenche de novo', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_acidente_identificacao_expurgo ON acidente_identificacao;
CREATE TRIGGER trg_acidente_identificacao_expurgo
  BEFORE UPDATE ON acidente_identificacao
  FOR EACH ROW EXECUTE FUNCTION csso_acidente_identificacao_expurgo();

DROP TRIGGER IF EXISTS trg_acidente_testemunha_contato_expurgo ON acidente_testemunha_contato;
CREATE TRIGGER trg_acidente_testemunha_contato_expurgo
  BEFORE UPDATE ON acidente_testemunha_contato
  FOR EACH ROW EXECUTE FUNCTION csso_acidente_identificacao_expurgo();

DROP TRIGGER IF EXISTS trg_acidente_saude_sem_delete ON acidente_saude;
CREATE TRIGGER trg_acidente_saude_sem_delete
  BEFORE DELETE ON acidente_saude
  FOR EACH ROW EXECUTE FUNCTION csso_recusar('acidente_saude: o nucleo de saude e guardado para sempre. So o nivel 2 se expurga, por ato manual.');

DROP TRIGGER IF EXISTS trg_acidente_saude_sem_truncate ON acidente_saude;
CREATE TRIGGER trg_acidente_saude_sem_truncate
  BEFORE TRUNCATE ON acidente_saude
  FOR EACH STATEMENT EXECUTE FUNCTION csso_recusar('acidente_saude: o nucleo de saude e guardado para sempre. So o nivel 2 se expurga, por ato manual.');

-- =====================================================================
-- A API de dados do Supabase fica FORA do sistema.
--
-- O Supabase publica toda tabela de `public` numa API REST (PostgREST) para
-- os papeis `anon` e `authenticated`, e a chave `anon` e feita para ir no
-- navegador. Sem isto, quem tivesse a chave leria a trilha, os servidores e
-- as fichas direto, sem passar por login, RBAC nem RN-19. O sistema nao usa
-- essa API: fala com o banco como `postgres`, dono das tabelas, e o dono
-- passa por cima do RLS. Entao: RLS ligado sem politica nenhuma (a API nao
-- enxerga linha) e os privilegios desses papeis revogados. No Postgres local,
-- onde os papeis nao existem, a segunda parte nao faz nada.
-- =====================================================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    -- o esquema continua visivel para a plataforma (painel, service_role)
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
  END IF;
END $$;
