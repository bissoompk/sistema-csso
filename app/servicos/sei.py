"""Interface com o SEI - DEFINIDA E VAZIA, de proposito.

A v1 NAO integra com o SEI: nenhuma API, nenhum scraping. O numero do processo
e digitado (validado em app/servicos/nup.py) e `numero_documento_sei` /
`url_permanente` sao campos manuais.

Este modulo existe para que, quando a integracao for autorizada, exista um unico
ponto de acoplamento - e para deixar explicito que hoje nada aqui esta ligado.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

VERSAO_SEI_ALVO = "4.0.12.15"
BASE_SEI = "sei.ufvjm.edu.br"
UNIDADE_SEI = "csso.sisa"

PASSOS_INCLUSAO = (
    "No SEI, abra o processo pelo NUP.",
    "Incluir Documento -> Externo.",
    "Tipo do Documento: Parecer Técnico.",
    "Anexe o PDF gerado pelo sistema e assine no SEI.",
    "Volte aqui e preencha o nº do documento SEI, a data e o link permanente.",
)


class NaoImplementadoNaV1(NotImplementedError):
    """Integracao com o SEI esta fora do escopo da v1 (SS1 do prompt)."""


@dataclass(frozen=True)
class DocumentoSei:
    numero: str
    url_permanente: str | None = None


class ClienteSei(Protocol):
    """Contrato que uma futura integracao devera cumprir."""

    def incluir_documento_externo(
        self, nup: str, caminho_pdf: str, tipo: str
    ) -> DocumentoSei: ...

    def consultar_processo(self, nup: str) -> dict: ...


class ClienteSeiIndisponivel:
    """Implementacao padrao: recusa qualquer chamada, com mensagem clara."""

    def incluir_documento_externo(self, nup: str, caminho_pdf: str, tipo: str):
        raise NaoImplementadoNaV1(
            "A v1 nao integra com o SEI. Inclua o documento manualmente: "
            + " ".join(PASSOS_INCLUSAO)
        )

    def consultar_processo(self, nup: str) -> dict:
        raise NaoImplementadoNaV1("A v1 nao consulta o SEI. Digite o NUP.")


def obter_cliente() -> ClienteSei:
    return ClienteSeiIndisponivel()
