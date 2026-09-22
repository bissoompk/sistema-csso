"""Datas em portugues sem depender de locale do SO.

locale.setlocale(LC_TIME, "pt_BR.UTF-8") falha no Windows - por isso a lista
literal de meses. CA-04 roda com LC_ALL=C.
"""

from __future__ import annotations

import calendar
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

MESES: tuple[str, ...] = (
    "janeiro",
    "fevereiro",
    "marco",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)

# Com acento, como sai no documento.
MESES_ACENTUADOS: tuple[str, ...] = (
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)

try:
    FUSO_BR: ZoneInfo | timezone = ZoneInfo("America/Sao_Paulo")
except Exception:  # pragma: no cover - Windows sem tzdata
    FUSO_BR = timezone(timedelta(hours=-3), "America/Sao_Paulo")

UTC = timezone.utc


def _sem_acento(texto: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn"
    )


def por_extenso(quando: date) -> str:
    """11 de fevereiro de 2025 (mes minusculo, dia com zero a esquerda)."""
    return f"{quando.day:02d} de {MESES_ACENTUADOS[quando.month - 1]} de {quando.year}"


def por_extenso_capitalizado(quando: date) -> str:
    """11 de Fevereiro de 2025 (variante usada em parte dos pareceres)."""
    mes = MESES_ACENTUADOS[quando.month - 1]
    return f"{quando.day:02d} de {mes[0].upper()}{mes[1:]} de {quando.year}"


def por_extenso_cidade(cidade: str, quando: date) -> str:
    """Diamantina, 11 de fevereiro de 2025"""
    return f"{cidade}, {por_extenso(quando)}"


def numerica(quando: date) -> str:
    return f"{quando.day:02d}/{quando.month:02d}/{quando.year}"


_RE_EXTENSO = re.compile(
    r"(?P<dia>\d{1,2})\s+de\s+(?P<mes>[A-Za-zÀ-ÿ]+)\s+de\s+(?P<ano>\d{4})",
    re.IGNORECASE,
)
_RE_NUMERICA = re.compile(r"(?P<dia>\d{1,2})/(?P<mes>\d{1,2})/(?P<ano>\d{4})")
_RE_ISO = re.compile(r"(?P<ano>\d{4})-(?P<mes>\d{2})-(?P<dia>\d{2})")


def indice_mes(nome: str) -> int | None:
    alvo = _sem_acento(nome).strip().lower()
    for i, mes in enumerate(MESES, start=1):
        if _sem_acento(mes) == alvo:
            return i
    return None


def analisar(texto: str | None) -> date | None:
    """Aceita '17 de setembro de 2024', '05 DE MARCO DE 2024', '01/05/2026',
    ISO e datetime da planilha. Devolve None quando nao reconhece."""
    if texto is None:
        return None
    if isinstance(texto, datetime):
        return texto.date()
    if isinstance(texto, date):
        return texto
    bruto = str(texto).strip()
    if not bruto:
        return None

    m = _RE_EXTENSO.search(bruto)
    if m:
        mes = indice_mes(m.group("mes"))
        if mes:
            return date(int(m.group("ano")), mes, int(m.group("dia")))

    m = _RE_NUMERICA.search(bruto)
    if m:
        return date(int(m.group("ano")), int(m.group("mes")), int(m.group("dia")))

    m = _RE_ISO.search(bruto)
    if m:
        return date(int(m.group("ano")), int(m.group("mes")), int(m.group("dia")))

    return None


def data_de_planilha(valor) -> date | None:
    """RN-18: a planilha guarda datetime(2026,2,11,0,0).

    Converter ingenuamente para UTC transforma 11/fev em 10/fev. Aqui a parte
    de data e tomada literalmente, sem qualquer conversao de fuso.
    """
    if valor is None:
        return None
    if isinstance(valor, datetime):
        return valor.date()
    if isinstance(valor, date):
        return valor
    return analisar(str(valor))


def local(momento: datetime | None) -> datetime | None:
    """Timestamp UTC do sistema exibido em America/Sao_Paulo."""
    if momento is None:
        return None
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=UTC)
    return momento.astimezone(FUSO_BR)


def local_formatado(momento: datetime | None, com_hora: bool = True) -> str:
    dt = local(momento)
    if dt is None:
        return ""
    return dt.strftime("%d/%m/%Y %H:%M") if com_hora else dt.strftime("%d/%m/%Y")


def dias_desde(momento: datetime | None, referencia: datetime | None = None) -> int:
    if momento is None:
        return 0
    ref = referencia or datetime.now(tz=UTC)
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=UTC)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=UTC)
    return max(0, (ref - momento).days)


def meses_entre(inicio: date, fim: date) -> int:
    return (fim.year - inicio.year) * 12 + (fim.month - inicio.month)


def somar_meses(quando: date, meses: int) -> date:
    """Soma meses a uma data; quando o dia nao existe no mes de destino, usa o
    ultimo dia desse mes.

    31/01 + 1 mes nao existe, e a escolha entre 28/02 e 03/03 e de negocio, nao
    de aritmetica. Aqui o resultado *gruda no ultimo dia do mes de destino*
    (28/02, ou 29/02 em bissexto). Transbordar para marco jogaria o vencimento
    para fora do mes que a administracao contou: validade de CA, reciclagem de
    treinamento e previsao de troca de EPI sao prazos contados "em meses", e o
    ultimo dia do mes e o limite daquele mes - nao o primeiro do seguinte.
    Grudar tambem mantem o resultado dentro do prazo, que e o lado seguro para
    quem fiscaliza.

    Consequencia assumida: a operacao NAO e reversivel quando houve
    truncamento. somar_meses(31/01/2024, 1) da 29/02/2024, e somar_meses de
    volta com -1 da 29/01/2024. Nenhum uso do dominio depende de ida e volta -
    o vencimento e calculado uma vez, na emissao, e congelado na linha.

    `meses` negativo e suportado e anda para tras pela mesma regra (util para
    janelas do tipo "seis meses antes do vencimento"); zero devolve a data
    igual.

    31/01/2025 + 1  = 28/02/2025
    31/01/2024 + 1  = 29/02/2024   (bissexto)
    29/02/2024 + 12 = 28/02/2025
    31/08/2025 + 6  = 28/02/2026
    """
    total = quando.month - 1 + meses
    ano = quando.year + total // 12
    mes = total % 12 + 1
    ultimo_dia = calendar.monthrange(ano, mes)[1]
    return date(ano, mes, min(quando.day, ultimo_dia))
