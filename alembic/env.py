"""Ambiente do Alembic. A URL vem do .env - nunca do alembic.ini."""

from __future__ import annotations

import sys
from contextlib import contextmanager
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import obter_config  # noqa: E402
from app.modelos import Base  # noqa: E402

config = context.config
if config.config_file_name is not None:
    # `disable_existing_loggers=False` nao e detalhe: o padrao do fileConfig e
    # DESLIGAR todo logger ja criado que nao esteja no .ini, e o alembic.ini so
    # declara root, sqlalchemy e alembic. Como `migrar()` roda no boot da
    # aplicacao (`principal.ciclo_de_vida`), o logger 'csso' — criado no import,
    # antes — ficava desligado pelo resto do processo. Era o
    # `log.error("PRAGMA integrity_check falhou")` que nunca chegava a lugar
    # nenhum: o sistema perdia a voz exatamente na hora de avisar.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

config.set_main_option("sqlalchemy.url", obter_config().url_sqlalchemy)
target_metadata = Base.metadata


def _incluir_objeto(objeto, nome, tipo, reflexo, comparado):
    """CHECKs marcados como exclusivos do PostgreSQL nao entram no SQLite."""
    dialetos = (getattr(objeto, "info", {}) or {}).get("dialects")
    if dialetos and "sqlite" not in dialetos:
        return False
    return True


def _remover_checks_de_outro_dialeto(_contexto, _revisao, diretivas) -> None:
    """Tira do autogenerate os CHECK marcados como exclusivos do PostgreSQL.

    `include_object` nao e chamado para CheckConstraint, entao a limpeza acontece
    aqui: sem isso o SQLite recebe `CHECK (siape ~ '\\d{7}')` e quebra na criacao.
    """
    from alembic.operations import ops

    dialeto = _contexto.dialect.name

    def _limpar(operacao) -> None:
        if isinstance(operacao, ops.OpContainer):
            for filha in operacao.ops:
                _limpar(filha)
            return
        colecao = getattr(operacao, "columns", None)
        if colecao is None:
            return
        operacao.columns = [
            item
            for item in colecao
            if dialeto
            in ((getattr(item, "info", {}) or {}).get("dialects") or [dialeto])
        ]

    for diretiva in diretivas:
        _limpar(diretiva.upgrade_ops)


def migrar_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
        include_object=_incluir_objeto,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


@contextmanager
def _fk_suspensas(conexao):
    """SQLite: batch recria a tabela, e recriar exige soltar as FKs por um instante.

    O `batch_alter_table` copia os dados para uma tabela nova e DERRUBA a antiga.
    Com `PRAGMA foreign_keys=ON` esse DROP falha assim que alguem referencia a
    tabela — que e o caso de `servidor`. Desligamos so durante a migracao e
    conferimos a integridade referencial antes de dar por encerrado; se a
    migracao deixou orfaos, e melhor descobrir aqui do que em producao.

    O PRAGMA e ignorado dentro de transacao: por isso vai no driver, antes do
    `begin_transaction()`.
    """
    if conexao.dialect.name != "sqlite":
        yield
        return
    bruta = conexao.connection.driver_connection
    bruta.execute("PRAGMA foreign_keys=OFF")
    try:
        yield
    finally:
        orfaos = list(bruta.execute("PRAGMA foreign_key_check"))
        bruta.execute("PRAGMA foreign_keys=ON")
        if orfaos:
            tabelas = sorted({str(linha[0]) for linha in orfaos})
            raise RuntimeError(
                "a migracao deixou referencias orfas em: " + ", ".join(tabelas)
            )


def migrar_online() -> None:
    engine = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with engine.connect() as conexao:
        context.configure(
            connection=conexao,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite: ALTER TABLE via tabela temporaria
            include_object=_incluir_objeto,
            compare_type=True,
            process_revision_directives=_remover_checks_de_outro_dialeto,
        )
        with _fk_suspensas(conexao), context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    migrar_offline()
else:
    migrar_online()
