"""Validadores Pydantic dos formatos que o SQLite não consegue impor.

Toda CHECK com o operador `~` do PostgreSQL vira dois artefatos: a constraint
declarada como exclusiva daquele dialeto (`app/modelos/base.check_regex`) e um
validador aqui, que roda antes de qualquer escrita.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modelos.organizacao import PADRAO_SIAPE
from app.modelos.processo import PADRAO_LAUDO, PADRAO_NUP, PADRAO_PARECER
from app.servicos import nup as servico_nup
from app.servicos.textos import exigir_texto_limpo

Siape = Annotated[str, Field(pattern=f"^{PADRAO_SIAPE}$")]
NumeroLaudo = Annotated[str, Field(pattern=f"^{PADRAO_LAUDO}$")]
NumeroParecer = Annotated[str, Field(pattern=f"^{PADRAO_PARECER}$")]


class Base(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class ServidorEntrada(Base):
    siape: Siape
    nome: str = Field(min_length=3, max_length=160)
    cargo_id: int | None = None
    funcao: str | None = Field(default=None, max_length=120)
    unidade_uorg_id: int | None = None
    email: str | None = None

    @field_validator("nome", "funcao")
    @classmethod
    def _sem_dado_de_saude(cls, valor: str | None) -> str | None:
        return exigir_texto_limpo(valor, "nome/função")


class ProcessoEntrada(Base):
    nup: str
    tipo_processo_id: int
    servidor_id: int | None = None
    unidade_uorg_id: int | None = None
    data_autuacao: date | None = None
    observacoes: str | None = None
    dv_dispensado: bool = False

    @field_validator("nup")
    @classmethod
    def _nup(cls, valor: str) -> str:
        resultado = servico_nup.validar(valor)
        if not resultado.formato_ok:
            raise ValueError(resultado.aviso or "NUP em formato inválido")
        return resultado.valor

    @field_validator("observacoes")
    @classmethod
    def _observacoes(cls, valor: str | None) -> str | None:
        return exigir_texto_limpo(valor, "observações")


class LaudoEntrada(Base):
    numero_siape: NumeroLaudo
    tipo_adicional_id: int
    unidade_uorg_id: int
    subscritor_id: int | None = None
    data_emissao: date | None = None
    coletivo: bool = False
    # NAO existe data_validade: o laudo nao tem prazo (IN 15/2022, art. 10, §3º)

    @field_validator("numero_siape")
    @classmethod
    def _ano_bate_com_o_numero(cls, valor: str) -> str:
        if not re.fullmatch(PADRAO_LAUDO, valor):
            raise ValueError("número de laudo fora do padrão 26255-000.125/2019")
        return valor

    @property
    def ano(self) -> int:
        return int(self.numero_siape[-4:])


class ExposicaoEntrada(Base):
    agente_nocivo_id: int
    percentual_id: int
    principal: bool = False
    horas_exposicao_mensais: float | None = Field(default=None, ge=0)
    jornada_mensal_horas: float | None = Field(default=None, gt=0)
    excecao_art9_par_unico: bool = False
    justificativa_art9: str | None = None

    @field_validator("justificativa_art9")
    @classmethod
    def _justificativa(cls, valor: str | None) -> str | None:
        return exigir_texto_limpo(valor, "justificativa da exceção do art. 9º")

    def conferir_excecao(self) -> None:
        if self.excecao_art9_par_unico and not (self.justificativa_art9 or "").strip():
            raise ValueError(
                "a exceção do art. 9º, parágrafo único exige a justificativa com o "
                "anexo/tabela da NR-15 ou NR-16 que dispensa a habitualidade"
            )


class PortariaEntrada(Base):
    texto_original: str = Field(min_length=5)
    unidade_emissora_id: int
    numero: str | None = None
    data_publicacao: date | None = None

    @field_validator("numero")
    @classmethod
    def _sem_zeros_a_esquerda(cls, valor: str | None) -> str | None:
        """RN-10: 001, 01 e 1 são a mesma portaria."""
        if valor is None:
            return None
        return valor.strip().lstrip("0") or "0"


__all__ = [
    "ExposicaoEntrada",
    "LaudoEntrada",
    "NumeroLaudo",
    "NumeroParecer",
    "PortariaEntrada",
    "ProcessoEntrada",
    "ServidorEntrada",
    "Siape",
    "PADRAO_NUP",
]
