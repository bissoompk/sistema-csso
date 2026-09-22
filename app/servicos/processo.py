"""Servico do processo: transicoes de estado, kanban e SLA."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modelos import (
    Anexo,
    FluxoEtapa,
    LaudoTecnico,
    Processo,
    agora_utc,
)
from app.modelos.estados import (
    ATALHO_REUSO_LAUDO,
    INCISOS_ART11,
    ROTULO_ESTADO,
    ROTULO_ESTADO_TELA,
    TransicaoInvalida,
    coluna_de,
    exigir_transicao,
)
from app.servicos import auditoria, datas_br
from app.servicos.rbac import UsuarioAtual

# RN-16 - SLA por coluna (dias). O padrao abaixo vale enquanto ninguem editar
# em /config; a partir dai, quem manda e a tabela `parametro`.
SLA_PADRAO: dict[str, int] = {
    "NAO_INICIADO": 0,
    "A_FAZER": 15,
    "EM_ANDAMENTO": 30,
    "AGUARDANDO": 20,
    "CONCLUIDO": 0,
}

PREFIXO_SLA = "sla."


def sla_vigente(s: Session) -> dict[str, int]:
    """Le os parametros e cai no padrao para o que nao estiver configurado."""
    from app.modelos import Parametro

    tabela = dict(SLA_PADRAO)
    for parametro in s.execute(select(Parametro)).scalars():
        if not parametro.chave.startswith(PREFIXO_SLA):
            continue
        coluna = parametro.chave[len(PREFIXO_SLA) :]
        if coluna in tabela:
            try:
                tabela[coluna] = max(0, int(parametro.valor))
            except (TypeError, ValueError):
                continue
    return tabela


def gravar_sla(s: Session, valores: dict[str, int], usuario: UsuarioAtual) -> dict[str, int]:
    from app.modelos import Parametro

    usuario.exigir("catalogo.gerenciar")
    for coluna, dias in valores.items():
        if coluna not in SLA_PADRAO:
            continue
        chave = f"{PREFIXO_SLA}{coluna}"
        parametro = s.get(Parametro, chave)
        anterior = parametro.valor if parametro else str(SLA_PADRAO[coluna])
        if parametro is None:
            parametro = Parametro(
                chave=chave, valor=str(int(dias)), descricao=f"SLA da coluna {coluna} (dias)"
            )
            s.add(parametro)
        else:
            parametro.valor = str(int(dias))
        if anterior != parametro.valor:
            auditoria.registrar(
                s,
                entidade="parametro",
                entidade_id=0,
                tipo_evento="SLA_ALTERADO",
                descricao=f"SLA de {coluna}: {anterior} -> {parametro.valor} dias",
                campo=chave,
                valor_anterior=anterior,
                valor_novo=parametro.valor,
                usuario=usuario,
            )
    s.flush()
    return sla_vigente(s)


class RequisitoDeSaidaNaoAtendido(ValueError):
    def __init__(self, motivos: list[str]):
        self.motivos = motivos
        super().__init__("; ".join(motivos))


@dataclass(frozen=True)
class ResumoCartao:
    processo: Processo
    coluna: str
    dias_no_estado: int
    sla: int
    atrasado: bool
    anexos: int
    checklist_feitos: int
    checklist_total: int


def precisa_de_atencao(resumo: ResumoCartao) -> bool:
    """"Precisa de voce hoje": passou do SLA, ou ainda nao saiu do "A fazer".

    Uma funcao, e nao tres criterios parecidos. O cartao do painel ja escrevia
    este criterio inline, o contador ao lado dele contava outra coisa
    (`atrasado`, sobre todos os processos) e o link "Ver todos" levava a uma
    lista que aplicava um terceiro (`?atrasados=1`, so o SLA). Tres definicoes de
    um fato so, lado a lado, na tela de entrada - e a de menor numero era a que
    tinha o link.

    O criterio inclui `A_FAZER` de proposito: processo recem-autuado nao tem
    dias no estado para estourar SLA nenhum, e mesmo assim e exatamente o que
    ninguem pegou ainda. Um cartao que so mostrasse atraso so mostraria o
    trabalho depois de ele ja estar atrasado.
    """
    return resumo.atrasado or resumo.coluna == "A_FAZER"


# ---------------------------------------------------------------------
# Requisitos de saida (SS4)
# ---------------------------------------------------------------------
def requisitos_de_saida(s: Session, processo: Processo, destino: str) -> list[str]:
    faltas: list[str] = []
    origem = processo.estado_tecnico

    if origem == "EM_TRIAGEM" and destino not in ("ARQUIVADO", "SOBRESTADO"):
        categorias = _categorias_anexadas(s, processo.id)
        if "PORTARIA" not in categorias:
            faltas.append("anexe a portaria de localização")
        if "FORMULARIO" not in categorias:
            faltas.append(
                "anexe o formulário assinado pelo servidor e pela chefia (art. 17)"
            )

    if origem == "AGUARDANDO_QUANTIFICACAO":
        categorias = _categorias_anexadas(s, processo.id)
        if "RELATORIO_CAMPO" not in categorias and not processo.observacoes:
            faltas.append(
                "anexe o relatório de ensaio ou registre a justificativa formal de "
                "avaliação qualitativa"
            )

    if (origem, destino) == ATALHO_REUSO_LAUDO:
        if not _tem_laudo_vigente(s, processo):
            faltas.append(
                "o atalho para elaboração de parecer exige um laudo VIGENTE do mesmo "
                "posto vinculado (IN 15/2022, art. 10, §3º)"
            )
    return faltas


def _categorias_anexadas(s: Session, processo_id: int) -> set[str]:
    linhas = s.execute(
        select(Anexo.categoria).where(
            Anexo.entidade == "processo", Anexo.entidade_id == processo_id, Anexo.ativo
        )
    ).scalars()
    return set(linhas)


def _tem_laudo_vigente(s: Session, processo: Processo) -> bool:
    if processo.unidade_uorg_id is None:
        return False
    return (
        s.execute(
            select(func.count())
            .select_from(LaudoTecnico)
            .where(
                LaudoTecnico.unidade_uorg_id == processo.unidade_uorg_id,
                LaudoTecnico.status == "VIGENTE",
            )
        ).scalar_one()
        > 0
    )


# ---------------------------------------------------------------------
# Transicao
# ---------------------------------------------------------------------
def mover(
    s: Session,
    processo: Processo,
    destino: str,
    usuario: UsuarioAtual,
    *,
    comentario: str | None = None,
    inciso_art11: str | None = None,
    laudo_reusado: LaudoTecnico | None = None,
    forcar: bool = False,
) -> Processo:
    usuario.exigir("processo.status")
    origem = processo.estado_tecnico
    if origem == destino:
        return processo

    exigir_transicao(origem, destino)

    if not forcar:
        faltas = requisitos_de_saida(s, processo, destino)
        if faltas:
            raise RequisitoDeSaidaNaoAtendido(faltas)

    if destino == "INDEFERIDO_TECNICAMENTE" and inciso_art11 not in INCISOS_ART11:
        raise RequisitoDeSaidaNaoAtendido(
            [
                "indeferimento técnico exige o inciso do art. 11: "
                + "; ".join(f"{k} — {v}" for k, v in INCISOS_ART11.items())
            ]
        )

    if destino == "SOBRESTADO":
        processo.estado_anterior = origem
    elif origem == "SOBRESTADO":
        processo.estado_anterior = None

    processo.estado_tecnico = destino
    processo.entrou_na_etapa_em = agora_utc()
    processo.etapa_id = _etapa_da_coluna(s, coluna_de(destino))
    processo.situacao = "CONCLUIDO" if destino == "CONCLUIDO" else "EM_ANDAMENTO"
    processo.data_conclusao = date.today() if destino == "CONCLUIDO" else None
    processo.versao += 1

    auditoria.registrar(
        s,
        entidade="processo",
        entidade_id=processo.id,
        processo_id=processo.id,
        tipo_evento=auditoria.ESTADO_ALTERADO,
        descricao=(
            f"{ROTULO_ESTADO.get(origem, origem)} -> {ROTULO_ESTADO.get(destino, destino)}"
            + (f" — {comentario}" if comentario else "")
        ),
        campo="estado_tecnico",
        valor_anterior=origem,
        valor_novo=destino,
        comentario=comentario,
        usuario=usuario,
    )

    if (origem, destino) == ATALHO_REUSO_LAUDO:
        auditoria.registrar(
            s,
            entidade="processo",
            entidade_id=processo.id,
            processo_id=processo.id,
            tipo_evento=auditoria.REUSO_DE_LAUDO,
            descricao=(
                "Parecer em elaboração por reúso de laudo vigente "
                f"({laudo_reusado.numero_siape if laudo_reusado else 'laudo do posto'}) "
                "— IN 15/2022, art. 10, §3º."
            ),
            usuario=usuario,
        )

    s.flush()
    return processo


def voltar_do_sobrestamento(
    s: Session, processo: Processo, usuario: UsuarioAtual
) -> Processo:
    if processo.estado_tecnico != "SOBRESTADO":
        raise TransicaoInvalida("o processo não está sobrestado")
    destino = processo.estado_anterior or "EM_TRIAGEM"
    return mover(s, processo, destino, usuario, forcar=True)


def _etapa_da_coluna(s: Session, coluna: str) -> int:
    etapa = s.execute(
        select(FluxoEtapa).where(FluxoEtapa.codigo == coluna)
    ).scalar_one_or_none()
    if etapa is None:  # pragma: no cover
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
    return etapa.id


# ---------------------------------------------------------------------
# Kanban / SLA
# ---------------------------------------------------------------------
CHAVES_AGRUPAMENTO: dict[str, str] = {
    "estado": "Estado técnico",
    "unidade": "Unidade",
    "responsavel": "Responsável",
    "tipo": "Tipo de processo",
}


def agrupar(processos: list[Processo], chave: str) -> dict[str, list[Processo]]:
    """Agrupa uma lista JA filtrada pelo repositório — não consulta nada, por
    isso vive aqui e não em app/repositorios (onde todo acesso passa pelo escopo)."""

    def rotulo(p: Processo) -> str:
        if chave == "unidade":
            return p.unidade.nome_extenso if p.unidade else "(sem unidade)"
        if chave == "responsavel":
            return p.responsavel.nome if p.responsavel else "(sem responsável)"
        if chave == "tipo":
            return p.tipo_processo.nome if p.tipo_processo else "(sem tipo)"
        # o rotulo do grupo e o <summary> que a pessoa le em /processos, e nao
        # texto de trilha: sai acentuado como o resto da tela
        return ROTULO_ESTADO_TELA.get(p.estado_tecnico, p.estado_tecnico)

    grupos: dict[str, list[Processo]] = {}
    for processo in processos:
        grupos.setdefault(rotulo(processo), []).append(processo)
    return dict(sorted(grupos.items()))


def aplicar_checklist_modelo(
    s: Session, processo: Processo, modelo, usuario: UsuarioAtual
):
    """Instancia um modelo de checklist no processo (catalogo /checklists-modelo)."""
    from app.modelos import Checklist, ChecklistItem

    usuario.exigir("processo.editar")
    existente = s.execute(
        select(Checklist).where(
            Checklist.processo_id == processo.id, Checklist.nome == modelo.nome
        )
    ).scalar_one_or_none()
    if existente is not None:
        return existente

    checklist = Checklist(processo_id=processo.id, nome=modelo.nome)
    s.add(checklist)
    s.flush()
    for ordem, descricao in enumerate(modelo.lista_de_itens, start=1):
        s.add(
            ChecklistItem(checklist_id=checklist.id, descricao=descricao, ordem=ordem)
        )
    auditoria.registrar(
        s,
        entidade="checklist",
        entidade_id=checklist.id,
        processo_id=processo.id,
        tipo_evento="CHECKLIST_APLICADO",
        descricao=f"Modelo '{modelo.nome}' aplicado ({len(modelo.lista_de_itens)} itens).",
        usuario=usuario,
    )
    s.flush()
    return checklist


def resumir(s: Session, processo: Processo, sla: dict[str, int] | None = None) -> ResumoCartao:
    from app.modelos import Checklist, ChecklistItem

    tabela_sla = sla or sla_vigente(s)
    coluna = coluna_de(processo.estado_tecnico)
    dias = datas_br.dias_desde(processo.entrou_na_etapa_em)
    limite = tabela_sla.get(coluna, 0)

    anexos = s.execute(
        select(func.count())
        .select_from(Anexo)
        .where(Anexo.entidade == "processo", Anexo.entidade_id == processo.id, Anexo.ativo)
    ).scalar_one()

    total = s.execute(
        select(func.count())
        .select_from(ChecklistItem)
        .join(Checklist, Checklist.id == ChecklistItem.checklist_id)
        .where(Checklist.processo_id == processo.id)
    ).scalar_one()
    feitos = s.execute(
        select(func.count())
        .select_from(ChecklistItem)
        .join(Checklist, Checklist.id == ChecklistItem.checklist_id)
        .where(Checklist.processo_id == processo.id, ChecklistItem.concluido)
    ).scalar_one()

    return ResumoCartao(
        processo=processo,
        coluna=coluna,
        dias_no_estado=dias,
        sla=limite,
        atrasado=bool(limite) and dias > limite,
        anexos=anexos,
        checklist_feitos=feitos,
        checklist_total=total,
    )
