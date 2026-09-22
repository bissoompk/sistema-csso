"""NUP - Numero Unico de Protocolo (Portaria Interministerial MJ/MP 1.677/2015).

Formato: OOOOO.SSSSSS/AAAA-DD  ->  23086.021284/2024-56

Algoritmo dos digitos verificadores (modulo 11 com a regra especifica do NUP;
a variante generica "resto 0 ou 1 -> digito 0" erra 4 dos 16 NUPs reais):

    base15 = orgao(5) || sequencial(6) || ano(4)
    DV1: soma = SUM(digito[i] * peso[i]) com pesos 16..2
         dv = 11 - (soma mod 11); DV1 = 1 se dv == 11, 0 se dv == 10, senao dv
    DV2: mesma conta sobre base15||DV1 com pesos 17..2
"""

from __future__ import annotations

import re
from dataclasses import dataclass

PADRAO = re.compile(r"^(\d{5})\.(\d{6})/(\d{4})-(\d{2})$")
ORGAO_UFVJM = "23086"


def _digito(base: str, peso_inicial: int) -> int:
    soma = sum(int(d) * (peso_inicial - i) for i, d in enumerate(base))
    dv = 11 - (soma % 11)
    if dv == 11:
        return 1
    if dv == 10:
        return 0
    return dv


def nup_dv(base15: str) -> str:
    """Recebe os 15 digitos (orgao+sequencial+ano) e devolve os 2 DV."""
    if not re.fullmatch(r"\d{15}", base15):
        raise ValueError("base do NUP deve ter exatamente 15 digitos")
    dv1 = _digito(base15, 16)
    dv2 = _digito(base15 + str(dv1), 17)
    return f"{dv1}{dv2}"


def normalizar(bruto: str | None) -> str:
    """Aceita colagem suja ('23086 021284 2024 56', sem pontuacao, com espacos)
    e devolve no formato canonico. Levanta ValueError se nao der 17 digitos."""
    if not bruto:
        raise ValueError("NUP vazio")
    digitos = re.sub(r"\D", "", str(bruto))
    if len(digitos) != 17:
        raise ValueError(
            f"NUP deve ter 17 digitos (encontrados {len(digitos)}): {bruto!r}"
        )
    return f"{digitos[:5]}.{digitos[5:11]}/{digitos[11:15]}-{digitos[15:]}"


def formato_ok(nup: str | None) -> bool:
    return bool(nup) and PADRAO.fullmatch(nup) is not None


def dv_ok(nup: str) -> bool:
    m = PADRAO.fullmatch(nup)
    if not m:
        return False
    orgao, seq, ano, dv = m.groups()
    return nup_dv(orgao + seq + ano) == dv


@dataclass(frozen=True)
class ResultadoNup:
    valor: str
    formato_ok: bool
    dv_ok: bool
    aviso: str | None = None

    @property
    def valido(self) -> bool:
        return self.formato_ok and self.dv_ok


def validar(bruto: str | None) -> ResultadoNup:
    """RN-10: formato invalido bloqueia; DV invalido e aviso NAO bloqueante."""
    try:
        valor = normalizar(bruto)
    except ValueError as erro:
        return ResultadoNup(str(bruto or ""), False, False, str(erro))
    if not dv_ok(valor):
        return ResultadoNup(
            valor,
            True,
            False,
            "dígito verificador não confere — confirme no SEI",
        )
    return ResultadoNup(valor, True, True, None)


def extrair(texto: str | None) -> list[str]:
    """Todos os NUPs da UFVJM presentes num texto livre (descricao de cartao)."""
    if not texto:
        return []
    return re.findall(r"23086\.\d{6}/\d{4}-\d{2}", texto)
