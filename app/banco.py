"""Engine, sessao e as travas de banco (triggers) do SS5 do prompt."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import obter_config
from app.modelos import Base

_engine: Engine | None = None
_Sessao: sessionmaker[Session] | None = None


def _transacao_imediata(engine: Engine) -> None:
    """RN-03 - toda transacao abre com BEGIN IMMEDIATE.

    O pysqlite emite BEGIN preguicoso (deferido), o que transforma dois
    escritores concorrentes em erro tardio. Com IMMEDIATE, o segundo espera o
    `busy_timeout` e a numeracao fica serializada de verdade. Como o lock e
    tomado pela transacao da propria sessao, os servicos NUNCA devem abrir uma
    segunda conexao para numerar - dariam deadlock consigo mesmos.
    """

    @event.listens_for(engine, "connect")
    def _sem_begin_implicito(dbapi_conn, _record):  # pragma: no cover - driver
        dbapi_conn.isolation_level = None

    @event.listens_for(engine, "begin")
    def _begin_immediate(con):  # pragma: no cover - driver
        # conexoes marcadas AUTOCOMMIT (VACUUM, PRAGMA wal_checkpoint) nao podem
        # abrir transacao: sem COMMIT correspondente, o lock ficaria preso.
        if con.get_execution_options().get("isolation_level") == "AUTOCOMMIT":
            return
        con.exec_driver_sql("BEGIN IMMEDIATE")


def obter_engine() -> Engine:
    global _engine, _Sessao
    if _engine is None:
        cfg = obter_config()
        _engine = create_engine(
            cfg.url_sqlalchemy,
            echo=False,
            future=True,
            connect_args={"timeout": 15, "check_same_thread": False},
        )
        _transacao_imediata(_engine)
        _Sessao = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def obter_fabrica() -> sessionmaker[Session]:
    obter_engine()
    assert _Sessao is not None
    return _Sessao


def redefinir_engine(url: str | None = None) -> Engine:
    """Usado pelos testes para apontar para um banco temporario."""
    global _engine, _Sessao
    if _engine is not None:
        _engine.dispose()
    _engine = create_engine(
        url or obter_config().url_sqlalchemy,
        future=True,
        connect_args={"timeout": 15, "check_same_thread": False},
    )
    _transacao_imediata(_engine)
    _Sessao = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


@contextmanager
def sessao() -> Iterator[Session]:
    fabrica = obter_fabrica()
    s = fabrica()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# A dependencia de sessao das rotas mora em `app.dependencias.obter_sessao`, e
# so la. Havia aqui uma copia orfa, que ninguem importava: quem fosse mexer no
# contrato de commit/rollback da requisicao corria o risco de editar a copia
# morta e achar que tinha resolvido.


# ---------------------------------------------------------------------
# Travas de banco - ultima linha de defesa (nao substituem servico/rota)
# ---------------------------------------------------------------------
# As travas do esquema inicial. A tupla e SEPARADA da lista completa de
# proposito: `20260811_2032_esquema_inicial.py` a percorre para criar as
# triggers daquela revisao, e migracao le o passado — se ela lesse `TRIGGERS`,
# toda trava nova de modulo futuro passaria a ser criada na revisao inicial,
# sobre tabela que ainda nao existe naquele ponto da historia, e o
# `upgrade` desde o zero quebraria com "no such table". Foi o que aconteceria
# ao acrescentar as travas da ficha de EPI.
TRIGGERS_ESQUEMA_INICIAL: tuple[tuple[str, str], ...] = (
    (
        "trg_historico_sem_update",
        """
        CREATE TRIGGER trg_historico_sem_update
        BEFORE UPDATE ON historico_evento
        BEGIN
            SELECT RAISE(ABORT, 'historico_evento e append-only: UPDATE proibido');
        END;
        """,
    ),
    (
        "trg_historico_sem_delete",
        """
        CREATE TRIGGER trg_historico_sem_delete
        BEFORE DELETE ON historico_evento
        BEGIN
            SELECT RAISE(ABORT, 'historico_evento e append-only: DELETE proibido');
        END;
        """,
    ),
    # RN-01, terceira trava: IN 15/2022 art. 10 SS2 I
    (
        "trg_parecer_signatario_habilitado_ins",
        """
        CREATE TRIGGER trg_parecer_signatario_habilitado_ins
        BEFORE INSERT ON parecer_tecnico
        WHEN NEW.situacao IN ('EMITIDO','ASSINADO')
         AND NOT EXISTS (
            SELECT 1 FROM profissional_habilitado ph
             WHERE ph.id = NEW.signatario_id
               AND ph.vigencia_inicio <= COALESCE(NEW.data_emissao, date('now'))
               AND (ph.vigencia_fim IS NULL
                    OR ph.vigencia_fim >= COALESCE(NEW.data_emissao, date('now'))))
        BEGIN
            SELECT RAISE(ABORT, 'IN 15/2022 art.10 SS2 I: signatario nao habilitado');
        END;
        """,
    ),
    (
        "trg_parecer_signatario_habilitado_upd",
        """
        CREATE TRIGGER trg_parecer_signatario_habilitado_upd
        BEFORE UPDATE ON parecer_tecnico
        WHEN NEW.situacao IN ('EMITIDO','ASSINADO')
         AND NOT EXISTS (
            SELECT 1 FROM profissional_habilitado ph
             WHERE ph.id = NEW.signatario_id
               AND ph.vigencia_inicio <= COALESCE(NEW.data_emissao, date('now'))
               AND (ph.vigencia_fim IS NULL
                    OR ph.vigencia_fim >= COALESCE(NEW.data_emissao, date('now'))))
        BEGIN
            SELECT RAISE(ABORT, 'IN 15/2022 art.10 SS2 I: signatario nao habilitado');
        END;
        """,
    ),
    (
        "trg_laudo_subscritor_habilitado_ins",
        """
        CREATE TRIGGER trg_laudo_subscritor_habilitado_ins
        BEFORE INSERT ON laudo_tecnico
        WHEN NEW.subscritor_id IS NOT NULL
         AND NOT EXISTS (
            SELECT 1 FROM profissional_habilitado ph
             WHERE ph.id = NEW.subscritor_id
               AND ph.vigencia_inicio <= COALESCE(NEW.data_emissao, date('now'))
               AND (ph.vigencia_fim IS NULL
                    OR ph.vigencia_fim >= COALESCE(NEW.data_emissao, date('now'))))
        BEGIN
            SELECT RAISE(ABORT, 'IN 15/2022 art.10 SS2 I: subscritor nao habilitado');
        END;
        """,
    ),
    (
        "trg_laudo_subscritor_habilitado_upd",
        """
        CREATE TRIGGER trg_laudo_subscritor_habilitado_upd
        BEFORE UPDATE ON laudo_tecnico
        WHEN NEW.subscritor_id IS NOT NULL
         AND NOT EXISTS (
            SELECT 1 FROM profissional_habilitado ph
             WHERE ph.id = NEW.subscritor_id
               AND ph.vigencia_inicio <= COALESCE(NEW.data_emissao, date('now'))
               AND (ph.vigencia_fim IS NULL
                    OR ph.vigencia_fim >= COALESCE(NEW.data_emissao, date('now'))))
        BEGIN
            SELECT RAISE(ABORT, 'IN 15/2022 art.10 SS2 I: subscritor nao habilitado');
        END;
        """,
    ),
)


# RN-31 — nada se apaga. A ficha de EPI e o razao do estoque sao append-only
# pelo mesmo motivo que `historico_evento`: os dois valem como prova, e prova
# que se edita nao e prova. Correcao e linha nova — `ESTORNO` na ficha, `AJUSTE`
# no razao —, nunca rasura na linha errada.
#
# As travas nascem com o esquema, e nao com a tela que escreve nessas tabelas:
# uma tabela append-only que passa um mes aceitando UPDATE e uma tabela cujo
# historico ninguem consegue mais afirmar que esta intacto.
TRIGGERS_EPI: tuple[tuple[str, str], ...] = (
    (
        "trg_epi_ficha_sem_update",
        """
        CREATE TRIGGER trg_epi_ficha_sem_update
        BEFORE UPDATE ON epi_ficha_registro
        BEGIN
            SELECT RAISE(ABORT, 'epi_ficha_registro e append-only: UPDATE proibido');
        END;
        """,
    ),
    (
        "trg_epi_ficha_sem_delete",
        """
        CREATE TRIGGER trg_epi_ficha_sem_delete
        BEFORE DELETE ON epi_ficha_registro
        BEGIN
            SELECT RAISE(ABORT, 'epi_ficha_registro e append-only: DELETE proibido');
        END;
        """,
    ),
    (
        "trg_epi_movimento_sem_update",
        """
        CREATE TRIGGER trg_epi_movimento_sem_update
        BEFORE UPDATE ON epi_movimento_estoque
        BEGIN
            SELECT RAISE(ABORT, 'epi_movimento_estoque e append-only: UPDATE proibido');
        END;
        """,
    ),
    (
        "trg_epi_movimento_sem_delete",
        """
        CREATE TRIGGER trg_epi_movimento_sem_delete
        BEFORE DELETE ON epi_movimento_estoque
        BEGIN
            SELECT RAISE(ABORT, 'epi_movimento_estoque e append-only: DELETE proibido');
        END;
        """,
    ),
)

# As colunas de `epi_ficha_registro` que NUNCA mudam depois de gravadas. E a
# lista literal, e nao uma leitura de `EpiFichaRegistro.__table__`: o DDL de
# trigger vai para dentro de uma migracao, e migracao le o passado — gerar a
# clausula a partir do modelo faria uma coluna acrescentada em 2027 reescrever,
# em silencio, o que a revisao de hoje criou. A protecao contra deriva e um
# teste que compara esta lista com as colunas do modelo.
_FICHA_CONGELADA: tuple[str, ...] = (
    "id",
    "servidor_id",
    "epi_item_id",
    "requisicao_item_id",
    "entrada_id",
    "tipo",
    "quantidade",
    "data_evento",
    "nome_epi_snapshot",
    "categoria_snapshot",
    "numero_ca_snapshot",
    "validade_ca_snapshot",
    "fabricante_snapshot",
    "lote_snapshot",
    "tamanho_snapshot",
    "nome_servidor_snapshot",
    "siape_snapshot",
    "cargo_snapshot",
    "unidade_snapshot",
    "posto_snapshot",
    "contexto_congelado",
    "previsao_troca",
    "entregue_por",
    "motivo",
    "registro_estornado_id",
    "registrado_em",
)

# As tres que a linha ainda espera quando nasce. Cada uma se preenche UMA vez:
# de nulo para valor, e nunca mais.
FICHA_COMPLETAVEL: tuple[str, ...] = (
    "evento_id",
    "comprovante_anexo_id",
    "recebimento_confirmado_em",
)

# `IS NOT` e a desigualdade que trata NULL como valor no SQLite: com `<>`, mudar
# uma coluna nula para preenchida devolveria NULL e a trava nao dispararia.
_MUDOU_CONGELADA = "\n           OR ".join(
    f"NEW.{coluna} IS NOT OLD.{coluna}" for coluna in _FICHA_CONGELADA
)
_REESCREVEU_COMPLETAVEL = "\n           OR ".join(
    f"(OLD.{coluna} IS NOT NULL AND NEW.{coluna} IS NOT OLD.{coluna})"
    for coluna in FICHA_COMPLETAVEL
)

# A trava da ficha, revista na fatia 2 do modulo de EPI. SUBSTITUI
# `trg_epi_ficha_sem_update` de `TRIGGERS_EPI`, que recusava todo UPDATE.
#
# **Por que ela precisou afrouxar, e por que isso nao afrouxa a prova.** A linha
# da ficha nasce e, so depois de existir, descobre tres coisas sobre si mesma:
#
# 1. `evento_id` — o evento da cadeia de hash que a registrou. O evento precisa
#    do `id` da linha em `entidade_id`, e o `id` so existe depois do INSERT.
#    Sem esta permissao, ou a coluna ficava eternamente nula (e o §6.2 do
#    desenho, que promete a prova "a um JOIN de distancia", virava letra morta),
#    ou o `id` teria de ser sorteado antes por `MAX(id)+1` — exatamente o que a
#    RN-03 proibe.
# 2. `comprovante_anexo_id` — o PDF assinado. A decisao 8 fixou que o servidor
#    assina em PAPEL, no ato, e que o digitalizado e anexado depois. Entre a
#    entrega e o anexo ha uma janela real, que a decisao manda tornar visivel em
#    vez de esconder; uma trava que recusasse o preenchimento obrigaria a
#    inventar uma segunda tabela so para dizer onde esta a prova.
# 3. `recebimento_confirmado_em` — o momento em que a instituicao passou a ter
#    essa prova em maos. Anda junto com o anexo, pelo mesmo motivo.
#
# O que continua impossivel e o que importa: **nenhuma das 26 colunas de
# conteudo muda**, e as tres acima sao de escrita unica — de nulo para valor.
# Completar um registro nao e reescreve-lo. Corrigir continua sendo `ESTORNO`,
# linha nova com motivo, com a errada visivel ao lado.
TRIGGERS_EPI_FICHA_COMPLETAVEL: tuple[tuple[str, str], ...] = (
    (
        "trg_epi_ficha_sem_update",
        f"""
        CREATE TRIGGER trg_epi_ficha_sem_update
        BEFORE UPDATE ON epi_ficha_registro
        WHEN {_MUDOU_CONGELADA}
           OR {_REESCREVEU_COMPLETAVEL}
        BEGIN
            SELECT RAISE(ABORT, 'epi_ficha_registro e append-only: o conteudo nao se altera, e evento_id, comprovante_anexo_id e recebimento_confirmado_em se preenchem uma unica vez. Correcao e linha nova de tipo ESTORNO, com motivo.');
        END;
        """,
    ),
)

# RN-31 no encaminhamento da demanda. Mesma trava da ficha de EPI e da trilha,
# e pelo mesmo motivo: a linha diz que em 12/03 se pediu tal coisa a tal pessoa,
# e uma linha dessas que se possa reescrever nao serve para cobrar ninguem —
# inclusive porque quem cobra e quem escreveu. Correcao e linha nova.
#
# A demanda em si NAO e append-only, e a diferenca e real: ela e o registro
# vivo (muda de estado, ganha responsavel, ganha prazo, encerra), enquanto o
# encaminhamento e o fato datado. Congelar as duas obrigaria a inventar uma
# terceira tabela so para guardar o estado atual.
TRIGGERS_DEMANDA: tuple[tuple[str, str], ...] = (
    (
        "trg_demanda_encaminhamento_sem_update",
        """
        CREATE TRIGGER trg_demanda_encaminhamento_sem_update
        BEFORE UPDATE ON demanda_encaminhamento
        BEGIN
            SELECT RAISE(ABORT, 'demanda_encaminhamento e append-only: UPDATE proibido. Correcao e encaminhamento novo, dizendo o que mudou.');
        END;
        """,
    ),
    (
        "trg_demanda_encaminhamento_sem_delete",
        """
        CREATE TRIGGER trg_demanda_encaminhamento_sem_delete
        BEFORE DELETE ON demanda_encaminhamento
        BEGIN
            SELECT RAISE(ABORT, 'demanda_encaminhamento e append-only: DELETE proibido.');
        END;
        """,
    ),
)

_SUBSTITUIDAS = {nome for nome, _ in TRIGGERS_EPI_FICHA_COMPLETAVEL}

# O conjunto que vale para o banco de verdade: `criar_esquema` (bootstrap local
# e testes) aplica todas de uma vez. Cada migracao cria as suas.
#
# A trava substituida sai da lista em vez de ser sobrescrita pela ordem do laco:
# duas entradas com o mesmo nome funcionariam (o `DROP ... IF EXISTS` de
# `aplicar_triggers` faz a ultima vencer), mas quem lesse a tupla veria duas
# definicoes e teria de deduzir qual esta no banco.
TRIGGERS: tuple[tuple[str, str], ...] = (
    TRIGGERS_ESQUEMA_INICIAL
    + tuple(t for t in TRIGGERS_EPI if t[0] not in _SUBSTITUIDAS)
    + TRIGGERS_EPI_FICHA_COMPLETAVEL
    + TRIGGERS_DEMANDA
)


def aplicar_triggers(engine: Engine | None = None) -> None:
    eng = engine or obter_engine()
    with eng.begin() as con:
        for nome, ddl in TRIGGERS:
            con.execute(text(f"DROP TRIGGER IF EXISTS {nome}"))
            con.execute(text(ddl))


def criar_esquema(engine: Engine | None = None) -> None:
    """Cria tabelas + triggers. Em producao quem manda e o Alembic;
    esta funcao serve para bootstrap local e para os testes."""
    eng = engine or obter_engine()
    Base.metadata.create_all(eng)
    aplicar_triggers(eng)


def migrar() -> None:
    """Aplica as migracoes do Alembic. E o Alembic que manda no esquema.

    Se o banco ja existir sem carimbo de versao (bancos criados antes do
    Alembic), ele e carimbado na revisao base antes do upgrade.
    """
    from alembic import command
    from alembic.config import Config

    from app.config import RAIZ

    cfg = Config(str(RAIZ / "alembic.ini"))
    cfg.set_main_option("script_location", str(RAIZ / "alembic"))
    cfg.set_main_option("sqlalchemy.url", obter_config().url_sqlalchemy)
    command.upgrade(cfg, "head")


def integridade_ok(engine: Engine | None = None) -> tuple[bool, str]:
    eng = engine or obter_engine()
    with eng.connect() as con:
        resultado = con.execute(text("PRAGMA integrity_check")).scalar_one()
    return resultado == "ok", str(resultado)
