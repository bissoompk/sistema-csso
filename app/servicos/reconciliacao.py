"""Fase 4 - os cinco relatorios de reconciliacao da migracao.

  1. orfaos de processo    - cartoes/linhas sem NUP
  2. orfaos de parecer     - pareceres sem processo, e processos que deveriam
                             ter parecer e nao tem
  3. conflito de numeracao - o mesmo numero apontando para coisas diferentes
  4. NUPs com DV invalido  - digitados sem conferencia
  5. divergencia de marco  - marco inicial que nao bate com a portaria

Nenhum deles resolve nada sozinho: expoem para o Fabricio decidir.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    MigracaoRejeitada,
    ParecerTecnico,
    Processo,
    StgPlanilhaParecer,
    StgTrelloCartao,
)
from app.servicos import datas_br, nup as servico_nup
from app.servicos.importacao_trello import parecer_candidato


@dataclass
class Achado:
    referencia: str
    detalhe: str
    processo_id: int | None = None
    parecer_id: int | None = None


@dataclass
class Reconciliacao:
    orfaos_processo: list[Achado] = field(default_factory=list)
    orfaos_parecer: list[Achado] = field(default_factory=list)
    conflitos_numeracao: list[Achado] = field(default_factory=list)
    nups_dv_invalido: list[Achado] = field(default_factory=list)
    divergencias_marco: list[Achado] = field(default_factory=list)

    @property
    def total(self) -> int:
        return sum(
            len(x)
            for x in (
                self.orfaos_processo,
                self.orfaos_parecer,
                self.conflitos_numeracao,
                self.nups_dv_invalido,
                self.divergencias_marco,
            )
        )

    def como_secoes(self) -> list[tuple[str, str, list[Achado]]]:
        return [
            (
                "Órfãos de processo",
                "cartões e linhas sem NUP — precisam do número real para virar processo",
                self.orfaos_processo,
            ),
            (
                "Órfãos de parecer",
                "pareceres sem processo vinculado, e o contrário",
                self.orfaos_parecer,
            ),
            (
                "Conflito de numeração",
                "o mesmo número apontando para coisas diferentes — não resolver "
                "automaticamente, decidir caso a caso",
                self.conflitos_numeracao,
            ),
            (
                "NUPs com dígito verificador inválido",
                "entraram com a flag de dispensa; confirmar no SEI",
                self.nups_dv_invalido,
            ),
            (
                "Divergência de marco inicial",
                "a data do marco não bate com a publicação da portaria (RN-05)",
                self.divergencias_marco,
            ),
        ]


def _orfaos_processo(s: Session) -> list[Achado]:
    achados: list[Achado] = []
    for cartao in s.execute(select(StgTrelloCartao)).scalars():
        if not servico_nup.extrair(cartao.descricao):
            achados.append(
                Achado(
                    referencia=f"trello:{cartao.card_id}",
                    detalhe=f"cartão '{cartao.nome}' na lista '{cartao.lista}' sem NUP",
                )
            )
    for linha in s.execute(select(StgPlanilhaParecer)).scalars():
        if linha.col_b_numero_parecer and not linha.col_k_numero_processo:
            achados.append(
                Achado(
                    referencia=f"{linha.arquivo}:{linha.linha_origem}",
                    detalhe=(
                        f"parecer {linha.col_b_numero_parecer}/{linha.col_d_ano or '?'} "
                        "sem nº de processo na planilha"
                    ),
                )
            )
    # NUPs sinteticos criados na migracao do Trello (ano 1900)
    for processo in s.execute(
        select(Processo).where(Processo.nup.like("23086.%/1900-%"))
    ).scalars():
        achados.append(
            Achado(
                referencia=processo.nup,
                detalhe="NUP sintético gerado na migração — substituir pelo número real",
                processo_id=processo.id,
            )
        )
    return achados


def _orfaos_parecer(s: Session) -> list[Achado]:
    achados: list[Achado] = []
    for parecer in s.execute(select(ParecerTecnico)).scalars():
        if parecer.situacao == "RESERVADO":
            continue
        if parecer.processo_id is None:
            achados.append(
                Achado(
                    referencia=f"{parecer.numero}/{parecer.ano}",
                    detalhe="parecer sem processo vinculado",
                    parecer_id=parecer.id,
                )
            )
        if parecer.laudo_id is None and parecer.situacao != "RASCUNHO":
            achados.append(
                Achado(
                    referencia=f"{parecer.numero}/{parecer.ano}",
                    detalhe="parecer sem laudo — não há peça que caracterize a exposição",
                    parecer_id=parecer.id,
                )
            )
    return achados


def _conflitos_numeracao(s: Session) -> list[Achado]:
    achados: list[Achado] = []
    pareceres = {
        (p.numero, p.ano): p for p in s.execute(select(ParecerTecnico)).scalars()
    }
    for cartao in s.execute(
        select(StgTrelloCartao).where(StgTrelloCartao.parecer_candidato.isnot(None))
    ).scalars():
        candidato = cartao.parecer_candidato or parecer_candidato(cartao.nome)
        if not candidato or "/" not in candidato:
            continue
        numero, ano = candidato.split("/")
        parecer = pareceres.get((int(numero), int(ano)))
        if parecer is None:
            achados.append(
                Achado(
                    referencia=f"trello:{cartao.card_id}",
                    detalhe=(
                        f"o título '{cartao.nome}' aponta o parecer {candidato}, "
                        "que não existe na planilha"
                    ),
                )
            )
            continue
        nome_no_cartao = (cartao.nome or "").upper()
        nome_no_parecer = (parecer.servidor.nome if parecer.servidor else "").upper()
        if nome_no_parecer and nome_no_parecer.split()[0] not in nome_no_cartao:
            achados.append(
                Achado(
                    referencia=f"{candidato}",
                    detalhe=(
                        f"o cartão '{cartao.nome}' aponta o parecer {candidato}, "
                        f"mas na planilha esse número é de '{parecer.servidor.nome}'"
                    ),
                    parecer_id=parecer.id,
                )
            )
    for parecer in s.execute(
        select(ParecerTecnico).where(ParecerTecnico.situacao == "RESERVADO")
    ).scalars():
        achados.append(
            Achado(
                referencia=f"{parecer.numero}/{parecer.ano}",
                detalhe=(
                    "número reservado e nunca preenchido — conferir se não existe "
                    "parecer assinado com ele"
                ),
                parecer_id=parecer.id,
            )
        )
    return achados


def _nups_dv_invalido(s: Session) -> list[Achado]:
    achados: list[Achado] = []
    for processo in s.execute(select(Processo)).scalars():
        resultado = servico_nup.validar(processo.nup)
        if not resultado.dv_ok:
            achados.append(
                Achado(
                    referencia=processo.nup,
                    detalhe=(
                        "dígito verificador não confere"
                        + (" (dispensa registrada)" if processo.nup_dv_dispensado else "")
                    ),
                    processo_id=processo.id,
                )
            )
    return achados


def _divergencias_marco(s: Session) -> list[Achado]:
    achados: list[Achado] = []
    for parecer in s.execute(select(ParecerTecnico)).scalars():
        if parecer.data_marco_inicial is None or parecer.tipo_marco is None:
            continue
        if parecer.tipo_marco.codigo != "PORTARIA_LOCALIZACAO":
            if not parecer.justificativa_marco:
                achados.append(
                    Achado(
                        referencia=f"{parecer.numero}/{parecer.ano}",
                        detalhe=(
                            f"marco '{parecer.tipo_marco.rotulo}' em "
                            f"{datas_br.numerica(parecer.data_marco_inicial)} sem justificativa"
                        ),
                        parecer_id=parecer.id,
                    )
                )
            continue
        if parecer.portaria is None:
            achados.append(
                Achado(
                    referencia=f"{parecer.numero}/{parecer.ano}",
                    detalhe="marco é a portaria de localização, mas não há portaria vinculada",
                    parecer_id=parecer.id,
                )
            )
        elif parecer.data_marco_inicial != parecer.portaria.data_publicacao:
            achados.append(
                Achado(
                    referencia=f"{parecer.numero}/{parecer.ano}",
                    detalhe=(
                        f"marco {datas_br.numerica(parecer.data_marco_inicial)} × portaria "
                        f"{datas_br.numerica(parecer.portaria.data_publicacao)}"
                    ),
                    parecer_id=parecer.id,
                )
            )
    return achados


def reconciliar(s: Session) -> Reconciliacao:
    return Reconciliacao(
        orfaos_processo=_orfaos_processo(s),
        orfaos_parecer=_orfaos_parecer(s),
        conflitos_numeracao=_conflitos_numeracao(s),
        nups_dv_invalido=_nups_dv_invalido(s),
        divergencias_marco=_divergencias_marco(s),
    )


def rejeitadas(s: Session, limite: int = 200) -> list[MigracaoRejeitada]:
    return list(
        s.execute(
            select(MigracaoRejeitada).order_by(MigracaoRejeitada.id.desc()).limit(limite)
        ).scalars()
    )
