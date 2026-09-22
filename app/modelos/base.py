"""Base declarativa, tipos portateis e sessao.

Regra de portabilidade (SS5 do prompt): o DDL de referencia e PostgreSQL, mas
rodamos em SQLite. Nada de SQL cru especifico de dialeto - os tipos abaixo
fazem a traducao.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Text, TypeDecorator, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase


def agora_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


class Base(DeclarativeBase):
    pass


class MomentoUTC(TypeDecorator):
    """timestamptz -> TEXT ISO-8601 UTC. Comparavel lexicograficamente."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            value = datetime.fromisoformat(value)
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()

    def process_result_value(self, value: Any, dialect) -> datetime | None:
        if value is None:
            return None
        dt = datetime.fromisoformat(value)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class DataPura(TypeDecorator):
    """DATE de negocio: sem hora, sem fuso (RN-18).

    A planilha guarda datetime(2026,2,11,0,0); converter para UTC vira 10/fev.
    Aqui a data e gravada como 'AAAA-MM-DD' literal, nunca convertida.
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> str | None:
        if value is None:
            return None
        if isinstance(value, datetime):
            value = value.date()
        if isinstance(value, str):
            value = date.fromisoformat(value[:10])
        return value.isoformat()

    def process_result_value(self, value: Any, dialect) -> date | None:
        return None if value is None else date.fromisoformat(value[:10])


class JSONTexto(TypeDecorator):
    """jsonb -> TEXT com JSON serializado.

    Texto tambem e serializado — nao vai cru para a coluna. Havia aqui um atalho
    que devolvia `str` sem passar pelo `json.dumps`, tratando toda string como
    JSON ja pronto, e ele reinterpretava silenciosamente o valor na LEITURA:
    `'50.00'` (nota) voltava como o float `50.0`, `'1110654'` (SIAPE) como o
    inteiro `1110654`, `'true'` como booleano e `'null'` como `None`.

    Onde isso doi de verdade e em `historico_evento.valor_anterior/valor_novo`:
    o digest de cada evento e calculado sobre o valor em memoria e conferido
    sobre o valor lido do banco. Sendo dois valores diferentes, a cadeia de
    hashes acusa ADULTERACAO onde ninguem tocou em nada — e corrigir um SIAPE
    digitado errado bastava para disparar o alarme falso.

    Nenhum ponto do sistema depende do atalho: todo escritor de coluna
    `JSONTexto` passa `dict`, `list` ou escalar. Linhas gravadas antes desta
    correcao continuam sendo lidas como sempre foram (a leitura nao mudou); o
    que muda e a forma como as novas sao gravadas.

    `default=str` continua: `Decimal` e `date` viram texto na ida e voltam texto.
    E perda de tipo, mas ESTAVEL — o digest fecha —, e quem precisa do tipo de
    volta converte explicitamente (ver `ContextoCertificado.congelar`).
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> str | None:
        if value is None:
            return None
        return json.dumps(value, ensure_ascii=False, default=str, sort_keys=True)

    def process_result_value(self, value: Any, dialect) -> Any:
        if value is None:
            return None
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value


class Inet(TypeDecorator):
    impl = Text
    cache_ok = True


def ancorar(padrao: str) -> str:
    """Prende o padrao a string inteira, para o `~` casar o que `fullmatch` casa.

    O operador `~` do PostgreSQL casa **substring**, nao string inteira: sem
    ancora, `siape ~ '\\d{7}'` aceita 'abc1234567xyz'. Como `confere_regex` usa
    `re.fullmatch`, o banco ficava mais frouxo que o validador Python — e
    constraint que nao constrange e pior que constraint nenhuma, porque da
    confianca falsa a quem le o esquema.

    O grupo `(?:…)` nao e enfeite: e ele que faz a ancora valer para a
    alternancia inteira. Em `^a|b$` o `^` prende so o `a` e o `$` so o `b`, e o
    padrao passa a aceitar qualquer coisa terminada em 'b'.

    Padrao que ja traga ancora propria ganha a segunda de graca — `^(?:^x$)$`
    casa exatamente o que `^x$` casava. Detectar isso exigiria saber se o `|` do
    meio e de topo, o que pede um analisador de regex; duplicar e mais barato e
    nunca esta errado.
    """
    return f"^(?:{padrao})$"


def check_regex(nome: str, coluna: str, padrao: str) -> CheckConstraint:
    """CHECK com operador ~ nao existe em SQLite.

    Declaramos a constraint marcada como exclusiva do PostgreSQL (nao entra na
    migracao SQLite) e a validacao real vive no validador Pydantic/servico.

    `info["regex"]` guarda o padrao **sem** ancora de proposito: quem o consome
    e `confere_regex`, que ja casa a string inteira por `fullmatch`. Ancorado vai
    so o texto que chega ao banco.
    """
    return CheckConstraint(
        f"{coluna} ~ '{ancorar(padrao)}'",
        name=nome,
        info={"dialects": ["postgresql"], "regex": padrao, "coluna": coluna},
    ).ddl_if(dialect="postgresql")


def confere_regex(valor: str | None, padrao: str) -> bool:
    return valor is not None and re.fullmatch(padrao, valor) is not None


# ---------------------------------------------------------------------
# PRAGMAs obrigatorios em toda conexao SQLite
# ---------------------------------------------------------------------
@event.listens_for(Engine, "connect")
def _pragmas_sqlite(dbapi_conn, _record):  # pragma: no cover - efeito de driver
    if type(dbapi_conn).__module__.split(".")[0] not in ("sqlite3", "pysqlite3"):
        return
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


__all__ = [
    "Base",
    "DataPura",
    "Inet",
    "JSONTexto",
    "MomentoUTC",
    "agora_utc",
    "ancorar",
    "check_regex",
    "confere_regex",
    "DateTime",
]
