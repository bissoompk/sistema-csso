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
