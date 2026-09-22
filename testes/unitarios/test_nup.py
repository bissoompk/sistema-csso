"""CA-08 - os 16 NUPs reais validam 16/16."""

from __future__ import annotations

import pytest

from app.servicos import nup

NUPS_REAIS = [
    "23086.000608/2026-84",
    "23086.000540/2026-33",
    "23086.055766/2024-18",
    "23086.002365/2016-47",
    "23086.002359/2011-85",
    "23086.021284/2024-56",
    "23086.003498/2015-50",
    "23086.003496/2015-61",
    "23086.140575/2025-23",
    "23086.140572/2025-90",
    "23086.140267/2025-06",
    "23086.138170/2025-25",
    "23086.009245/2026-42",
    "23086.005413/2026-21",
    "23086.008530/2026-46",
    "23086.001198/2008-15",
]

# Estes quatro provam que a variante generica de modulo 11
# ("resto 0 ou 1 -> digito 0") nao foi usada.
PROVAM_A_REGRA_ESPECIFICA = [
    "23086.055766/2024-18",
    "23086.003496/2015-61",
    "23086.005413/2026-21",
    "23086.001198/2008-15",
]


@pytest.mark.parametrize("valor", NUPS_REAIS)
def test_dv_dos_nups_reais(valor: str) -> None:
    assert nup.validar(valor).valido, valor


def test_todos_os_dezesseis() -> None:
    assert sum(nup.validar(v).valido for v in NUPS_REAIS) == 16


def _dv_variante_generica(base15: str) -> str:
    def digito(base: str, peso_inicial: int) -> int:
        soma = sum(int(d) * (peso_inicial - i) for i, d in enumerate(base))
        resto = soma % 11
        return 0 if resto in (0, 1) else 11 - resto

    d1 = digito(base15, 16)
    return f"{d1}{digito(base15 + str(d1), 17)}"


@pytest.mark.parametrize("valor", PROVAM_A_REGRA_ESPECIFICA)
def test_variante_generica_erraria(valor: str) -> None:
    digitos = valor.replace(".", "").replace("/", "").replace("-", "")
    assert _dv_variante_generica(digitos[:15]) != digitos[15:]


def test_normalizacao_de_colagem() -> None:
    assert nup.normalizar("23086 021284 2024 56") == "23086.021284/2024-56"
    assert nup.normalizar("23086021284202456") == "23086.021284/2024-56"


def test_formato_invalido_nao_e_valido() -> None:
    resultado = nup.validar("2308.21284/2024-56")
    assert not resultado.formato_ok
    assert not resultado.valido


def test_dv_invalido_gera_aviso_nao_bloqueante() -> None:
    resultado = nup.validar("23086.021284/2024-99")
    assert resultado.formato_ok
    assert not resultado.dv_ok
    assert "dígito verificador" in (resultado.aviso or "")


def test_extrair_de_texto_livre() -> None:
    texto = "Processo 23086.003498/2015-50 e tambem 23086.002359/2011-85."
    assert nup.extrair(texto) == ["23086.003498/2015-50", "23086.002359/2011-85"]
