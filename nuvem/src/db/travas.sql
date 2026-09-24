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
-- O que continua impossivel e o que importa: **nenhuma das 26 colunas de
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
