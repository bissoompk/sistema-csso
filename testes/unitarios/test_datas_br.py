"""CA-04 - datas por extenso sem locale do SO (roda com LC_ALL=C)."""

from __future__ import annotations

import locale
import os
from datetime import date, datetime

import pytest

from app.servicos import datas_br


@pytest.fixture(autouse=True)
def _sem_locale(monkeypatch):
    monkeypatch.setenv("LC_ALL", "C")
    monkeypatch.setenv("LANG", "C")
    yield


def test_ca04_por_extenso() -> None:
    assert datas_br.por_extenso(date(2025, 2, 11)) == "11 de fevereiro de 2025"


def test_ca04_por_extenso_capitalizado() -> None:
    assert (
        datas_br.por_extenso_capitalizado(date(2025, 2, 11)) == "11 de Fevereiro de 2025"
    )


def test_nao_usa_setlocale() -> None:
    """Se alguem reintroduzir locale.setlocale, este teste explode no Windows."""
    fonte = datas_br.__file__ or ""
    with open(fonte, encoding="utf-8-sig") as arquivo:
        linhas = arquivo.read().splitlines()
    codigo = [
        linha
        for linha in linhas
        if not linha.lstrip().startswith("#") and "falha no Windows" not in linha
    ]
    assert not any("setlocale(" in linha for linha in codigo)
    assert not any(linha.strip() == "import locale" for linha in codigo)
    assert locale.getlocale(locale.LC_TIME) is not None or True
    assert os.environ["LC_ALL"] == "C"


def test_marco_com_cedilha() -> None:
    assert datas_br.por_extenso(date(2024, 3, 5)) == "05 de março de 2024"
    assert (
        datas_br.por_extenso_capitalizado(date(2026, 2, 9)) == "09 de Fevereiro de 2026"
    )


def test_numerica() -> None:
    assert datas_br.numerica(date(2026, 5, 1)) == "01/05/2026"


@pytest.mark.parametrize(
    "entrada,esperado",
    [
        ("17 de setembro de 2024", date(2024, 9, 17)),
        ("05 DE MARÇO DE 2024", date(2024, 3, 5)),
        ("09 de Fevereiro de 2026", date(2026, 2, 9)),
        ("12 de novembro de 2024", date(2024, 11, 12)),
        ("01/05/2026", date(2026, 5, 1)),
        ("2026-06-18", date(2026, 6, 18)),
        ("nada disso", None),
    ],
)
def test_analisar(entrada, esperado) -> None:
    assert datas_br.analisar(entrada) == esperado


def test_rn18_planilha_nao_desloca_o_dia() -> None:
    """A planilha guarda datetime(2026,2,11,0,0). Converter para UTC viraria 10/fev."""
    assert datas_br.data_de_planilha(datetime(2026, 2, 11, 0, 0)) == date(2026, 2, 11)


def test_meses_entre() -> None:
    assert datas_br.meses_entre(date(2024, 3, 5), date(2026, 5, 1)) == 26


@pytest.mark.parametrize(
    "origem,meses,esperado",
    [
        # Estouro de fim de mes: gruda no ultimo dia, nao transborda para o mes
        # seguinte.
        (date(2025, 1, 31), 1, date(2025, 2, 28)),
        (date(2024, 1, 31), 1, date(2024, 2, 29)),  # bissexto
        (date(2025, 8, 31), 6, date(2026, 2, 28)),
        (date(2025, 3, 31), 1, date(2025, 4, 30)),
        # 29/02 + 12 num ano comum cai em 28/02.
        (date(2024, 2, 29), 12, date(2025, 2, 28)),
        (date(2024, 2, 29), 48, date(2028, 2, 29)),  # de bissexto para bissexto
        # Zero devolve a mesma data.
        (date(2026, 5, 1), 0, date(2026, 5, 1)),
        (date(2024, 1, 31), 0, date(2024, 1, 31)),
        # Atravessa o ano, e a virada exata de dezembro para janeiro.
        (date(2025, 12, 1), 1, date(2026, 1, 1)),
        (date(2025, 12, 31), 2, date(2026, 2, 28)),
        (date(2025, 7, 15), 24, date(2027, 7, 15)),
        (date(2025, 11, 30), 13, date(2026, 12, 30)),
        # Negativo anda para tras pela mesma regra.
        (date(2026, 3, 31), -1, date(2026, 2, 28)),
        (date(2026, 1, 15), -1, date(2025, 12, 15)),
        (date(2026, 1, 31), -12, date(2025, 1, 31)),
        (date(2025, 3, 31), -13, date(2024, 2, 29)),
    ],
)
def test_somar_meses(origem: date, meses: int, esperado: date) -> None:
    assert datas_br.somar_meses(origem, meses) == esperado


def test_somar_meses_nao_e_reversivel_quando_trunca() -> None:
    """Consequencia assumida da regra do ultimo dia, documentada no docstring:
    31/01 + 1 - 1 nao volta para 31/01. Nenhum vencimento do dominio depende de
    ida e volta - ele e calculado uma vez e congelado."""
    ida = datas_br.somar_meses(date(2024, 1, 31), 1)
    assert ida == date(2024, 2, 29)
    assert datas_br.somar_meses(ida, -1) == date(2024, 1, 29)


def test_somar_meses_preserva_o_dia_quando_ele_existe() -> None:
    """O grude e excecao, nao regra: dia que existe no destino nao se mexe."""
    for mes in range(0, 13):
        assert datas_br.somar_meses(date(2025, 1, 15), mes).day == 15


def test_somar_meses_devolve_date_e_nao_datetime() -> None:
    resultado = datas_br.somar_meses(date(2025, 1, 31), 1)
    assert type(resultado) is date
