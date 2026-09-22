"""RN-03 - numeracao sequencial reiniciada a cada ano.

Nunca MAX(numero)+1, nunca SEQUENCE nativa, nunca UUID. O numero e consumido
somente no ato que o gasta (emissao do parecer, abertura da turma);
cancelamento vira estado e nao reaproveita o numero.

A transacao imediata (`BEGIN IMMEDIATE`) e emitida pelo proprio engine para
TODA transacao - ver app/banco.py. Por isso as funcoes abaixo rodam dentro da
transacao de quem chama: pegar uma segunda conexao aqui produziria deadlock
consigo mesmo quando a sessao ja tivesse escrito algo.

A funcao e generica desde a fatia 2 de Certificados. Cinco tabelas de sequencia
estao previstas nos tres modulos que vem do IntegraSST (`turma_sequencia`,
`certificado_sequencia`, `epi_requisicao_sequencia`, `acidente_sequencia`,
`acidente_relatorio_sequencia`), e a alternativa era escrever cinco copias
deste laco — uma delas fatalmente divergindo na hora de pular numero ocupado.
"""

from __future__ import annotations

import time

from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

TENTATIVAS = 5
ESPERA_BASE = 0.05

# Nome de tabela NAO aceita bind parameter: ele entra no SQL por interpolacao.
# Esta lista fechada e o que impede a funcao mais transacional do sistema de
# virar superficie de injecao. Sequencia nova se declara aqui, junto do alvo —
# declarar o par tambem impede consumir a sequencia de um e conferir a ocupacao
# no outro, que produziria numero repetido sem erro nenhum.
SEQUENCIAS: dict[str, str] = {
    "parecer_sequencia": "parecer_tecnico",
    "turma_sequencia": "turma",
    "certificado_sequencia": "certificado",
    "epi_requisicao_sequencia": "epi_requisicao",
}

COLUNAS_ADMITIDAS: frozenset[str] = frozenset({"numero"})


class NumeracaoIndisponivel(RuntimeError):
    pass


class SequenciaDesconhecida(ValueError):
    """Tabela fora de `SEQUENCIAS`. Nunca interpolar nome que veio de fora."""


def _e_lock(erro: Exception) -> bool:
    mensagem = str(erro).lower()
    return "locked" in mensagem or "busy" in mensagem


def _conferir(tabela_sequencia: str, tabela_alvo: str, coluna: str) -> None:
    esperado = SEQUENCIAS.get(tabela_sequencia)
    if esperado is None:
        raise SequenciaDesconhecida(
            f"tabela de sequencia nao declarada: {tabela_sequencia!r}"
        )
    if esperado != tabela_alvo:
        raise SequenciaDesconhecida(
            f"{tabela_sequencia!r} numera {esperado!r}, nao {tabela_alvo!r}"
        )
    if coluna not in COLUNAS_ADMITIDAS:
        raise SequenciaDesconhecida(f"coluna de numeracao nao admitida: {coluna!r}")


def proximo_numero(
    s: Session,
    ano: int,
    *,
    tabela_sequencia: str,
    tabela_alvo: str,
    coluna: str = "numero",
) -> int:
    """Consome o proximo numero do ano dentro da transacao corrente.

    Numeros ja gravados na tabela alvo sao pulados — inclusive os RESERVADO que
    a migracao da planilha criou. Pular e o que permite conviver com numero que
    nasceu fora do sistema sem duplicar ninguem.
    """
    _conferir(tabela_sequencia, tabela_alvo, coluna)
    ultimo_erro: Exception | None = None
    for tentativa in range(TENTATIVAS):
        try:
            s.execute(
                text(
                    f"INSERT INTO {tabela_sequencia} (ano, ultimo_numero) "  # noqa: S608
                    "VALUES (:ano, 0) ON CONFLICT(ano) DO NOTHING"
                ),
                {"ano": ano},
            )
            while True:
                numero = s.execute(
                    text(
                        f"UPDATE {tabela_sequencia} "  # noqa: S608
                        "SET ultimo_numero = ultimo_numero + 1 "
                        "WHERE ano = :ano RETURNING ultimo_numero"
                    ),
                    {"ano": ano},
                ).scalar_one()
                ocupado = s.execute(
                    text(
                        f"SELECT 1 FROM {tabela_alvo} "  # noqa: S608
                        f"WHERE {coluna} = :n AND ano = :a"
                    ),
                    {"n": numero, "a": ano},
                ).first()
                if not ocupado:
                    return int(numero)
        except OperationalError as erro:  # SQLITE_BUSY
            if not _e_lock(erro):
                raise
            ultimo_erro = erro
            s.rollback()
            time.sleep(ESPERA_BASE * (2**tentativa))
    raise NumeracaoIndisponivel(
        f"nao foi possivel obter numero de {tabela_alvo} para {ano}: {ultimo_erro}"
    )


def proximo_numero_parecer(s: Session, ano: int) -> int:
    return proximo_numero(
        s, ano, tabela_sequencia="parecer_sequencia", tabela_alvo="parecer_tecnico"
    )


def proximo_numero_turma(s: Session, ano: int) -> int:
    return proximo_numero(
        s, ano, tabela_sequencia="turma_sequencia", tabela_alvo="turma"
    )


def proximo_numero_certificado(s: Session, ano: int) -> int:
    """O numero do certificado. Anular NAO devolve o numero a sequencia.

    E a mesma disciplina da RN-03 no parecer: o numero e gasto no ato que o
    consome, e a reemissao recebe um numero novo. Reaproveitar o numero de um
    certificado anulado faria dois papeis diferentes circularem como "27/2026".
    """
    return proximo_numero(
        s, ano, tabela_sequencia="certificado_sequencia", tabela_alvo="certificado"
    )


def proximo_numero_requisicao_epi(s: Session, ano: int) -> int:
    """O numero do protocolo `EPI-AAAA-NNNN`, consumido no ENVIO.

    Nao na criacao do rascunho: rascunho e o pedido em digitacao, ainda nao e
    documento de ninguem e e o unico estado que pode ser apagado (RN-31). Gastar
    numero na abertura do formulario abriria um buraco na sequencia a cada
    formulario abandonado — e buraco em numeracao de documento e a primeira
    pergunta que a auditoria faz.

    Cancelar tambem nao devolve o numero: o protocolo circulou, e reaproveita-lo
    faria dois pedidos diferentes serem citados como "EPI-2026-0007".
    """
    return proximo_numero(
        s,
        ano,
        tabela_sequencia="epi_requisicao_sequencia",
        tabela_alvo="epi_requisicao",
    )


def recontar_sequencia(s: Session) -> dict[int, int]:
    """Apos a importacao: ultimo_numero = max(numero) por ano."""
    resultado: dict[int, int] = {}
    linhas = s.execute(
        text("SELECT ano, MAX(numero) FROM parecer_tecnico GROUP BY ano")
    ).all()
    for ano, maximo in linhas:
        s.execute(
            text(
                "INSERT INTO parecer_sequencia (ano, ultimo_numero) "
                "VALUES (:a, :m) ON CONFLICT(ano) DO UPDATE "
                "SET ultimo_numero = MAX(ultimo_numero, excluded.ultimo_numero)"
            ),
            {"a": int(ano), "m": int(maximo or 0)},
        )
        resultado[int(ano)] = int(maximo or 0)
    return resultado


def lacunas_de_numeracao(s: Session, ano: int) -> list[int]:
    """Relatorio /relatorios: numeros nao usados dentro do intervalo do ano."""
    usados = {
        int(n)
        for (n,) in s.execute(
            text("SELECT numero FROM parecer_tecnico WHERE ano = :a"), {"a": ano}
        ).all()
    }
    teto = s.execute(
        text("SELECT ultimo_numero FROM parecer_sequencia WHERE ano = :a"), {"a": ano}
    ).scalar()
    limite = max([*usados, int(teto or 0)] or [0])
    return [n for n in range(1, limite + 1) if n not in usados]
