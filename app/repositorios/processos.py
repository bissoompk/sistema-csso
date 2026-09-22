"""Consultas de processo. Toda funcao publica aplica o filtro de escopo.

Terceira camada da checagem de acesso (SS6). O teste
testes/unitarios/test_repositorios.py falha se alguma funcao publica daqui
deixar de invocar `aplicar_escopo`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.modelos import (
    LaudoTecnico,
    ParecerTecnico,
    Processo,
    Servidor,
    TipoProcesso,
    UnidadeUorg,
)
from app.modelos.estados import COLUNAS_KANBAN, ESTADO_PARA_COLUNA, coluna_de
from app.servicos.rbac import UsuarioAtual, aplicar_escopo
from app.servicos.identificacao import pode_ver_nominal
from app.servicos.textos import chave_busca


@dataclass
class Filtro:
    q: str | None = None
    estado: str | None = None
    coluna: str | None = None
    tipo: str | None = None
    exercicio: int | None = None
    responsavel_id: int | None = None
    unidade_id: int | None = None
    atrasados: bool = False
    # a visao do cartao "Precisam de voce hoje" do painel. Existe como filtro, e
    # nao so como laco no painel, porque o numero do cartao e o link dele tem de
    # levar a MESMA lista — era a falta desta visao que fazia "Ver todos" abrir
    # um recorte diferente do que o cartao contava.
    precisam: bool = False
    sem_numero_sei: bool = False
    # `False` (o padrao) e o FLUXO; `True` e o cadastro historico migrado; `None`
    # e "os dois", e existe para a busca global. Nas telas a particao e o que se
    # quer — contar 381 registros de arquivo como pendencia esvazia o painel —,
    # mas a busca global responde "onde esta este NUP", e metade deles esta no
    # repositorio: devolver "nada encontrado" para um NUP que o sistema tem e a
    # mesma mentira que a caixa do cabecalho acabou de parar de contar.
    repositorio: bool | None = False
    # visoes salvas que precisam de consulta propria
    dias_parado: int | None = None
    sem_percentual: bool = False
    reavaliacao_pendente: bool = False
    sem_parecer_assinado: bool = False
    agrupar: str | None = None
    pagina: int = 1
    por_pagina: int = 50

    def como_query_string(self, **troca) -> str:
        base = {
            "q": self.q,
            "estado": self.estado,
            "tipo": self.tipo,
            "exercicio": self.exercicio,
            "responsavel_id": self.responsavel_id,
            "unidade_id": self.unidade_id,
            "atrasados": "1" if self.atrasados else None,
            "precisam": "1" if self.precisam else None,
            "sem_numero_sei": "1" if self.sem_numero_sei else None,
            "repositorio": "1" if self.repositorio else None,
            "dias": self.dias_parado,
            "sem_percentual": "1" if self.sem_percentual else None,
            "reavaliacao_pendente": "1" if self.reavaliacao_pendente else None,
            "sem_parecer_assinado": "1" if self.sem_parecer_assinado else None,
            "agrupar": self.agrupar,
        }
        base.update(troca)
        return "&".join(f"{k}={v}" for k, v in base.items() if v not in (None, "", False))

    @property
    def tem_pos_filtro(self) -> bool:
        """Filtros que dependem de dados derivados e rodam apos a consulta."""
        return bool(
            self.atrasados
            or self.precisam
            or self.dias_parado
            or self.sem_percentual
            or self.reavaliacao_pendente
            or self.sem_parecer_assinado
        )


def _base(usuario: UsuarioAtual):
    consulta = select(Processo)
    return aplicar_escopo(consulta, usuario, Processo)


def _aplicar_filtro(consulta, s: Session, filtro: Filtro, usuario: UsuarioAtual):
    if filtro.q:
        alvo = f"%{filtro.q.strip()}%"
        # RN-19 no FILTRO, e nao so na exibicao. A lista de processos suprime a
        # identificacao de quem nao tem permissao nominal, mas o filtro casava
        # por nome para todo mundo: digitar "Marco" devolvia a linha dele e
        # amarrava o nome ao `SRV-xxxx` da sessao — a ligacao exata que a
        # supressao existe para impedir, e que `/servidores` ja tinha fechado.
        # Passou despercebido aqui porque a caixa do cabecalho despejava nesta
        # tela: era o oraculo com o atalho de teclado por cima.
        ids_servidor = [
            sid
            for (sid, nome) in s.execute(select(Servidor.id, Servidor.nome)).all()
            if chave_busca(filtro.q) in chave_busca(nome)
            and pode_ver_nominal(usuario, sid)
        ]
        condicoes = [
            Processo.nup.like(alvo),
            Processo.observacoes.like(alvo),
            Processo.url_permanente.like(alvo),
        ]
        if ids_servidor:
            condicoes.append(Processo.servidor_id.in_(ids_servidor))
        laudos = [
            lid
            for (lid,) in s.execute(
                select(LaudoTecnico.id).where(LaudoTecnico.numero_siape.like(alvo))
            ).all()
        ]
        if laudos:
            pareceres = s.execute(
                select(ParecerTecnico.processo_id).where(
                    ParecerTecnico.laudo_id.in_(laudos)
                )
            ).scalars()
            ids = [p for p in pareceres if p]
            if ids:
                condicoes.append(Processo.id.in_(ids))
        consulta = consulta.where(or_(*condicoes))

    if filtro.estado:
        consulta = consulta.where(Processo.estado_tecnico == filtro.estado)
    if filtro.coluna:
        estados = [e for e, c in ESTADO_PARA_COLUNA.items() if c == filtro.coluna]
        consulta = consulta.where(Processo.estado_tecnico.in_(estados))
    if filtro.tipo:
        tipo = s.execute(
            select(TipoProcesso).where(TipoProcesso.codigo == filtro.tipo)
        ).scalar_one_or_none()
        consulta = consulta.where(Processo.tipo_processo_id == (tipo.id if tipo else -1))
    if filtro.exercicio:
        consulta = consulta.where(Processo.ano_referencia == filtro.exercicio)
    if filtro.responsavel_id:
        consulta = consulta.where(Processo.responsavel_id == filtro.responsavel_id)
    if filtro.unidade_id:
        consulta = consulta.where(Processo.unidade_uorg_id == filtro.unidade_id)
    if filtro.sem_numero_sei:
        consulta = consulta.where(
            or_(Processo.url_permanente.is_(None), Processo.url_permanente == "")
        )
    if filtro.repositorio is not None:
        consulta = consulta.where(Processo.origem_repositorio.is_(filtro.repositorio))
    return consulta


def _passa_no_pos_filtro(s: Session, processo: Processo, filtro: Filtro) -> bool:
    """Visoes que dependem de dado derivado (SLA, exposicao, anexo)."""
    from app.modelos import Anexo, Exposicao
    from app.servicos.processo import precisa_de_atencao, resumir

    if filtro.atrasados or filtro.precisam or filtro.dias_parado:
        resumo = resumir(s, processo)
        if filtro.atrasados and not resumo.atrasado:
            return False
        # o criterio mora em `servicos.processo`, e nao aqui: e o mesmo que o
        # painel usa para montar o cartao, e duas copias dele divergiriam na
        # primeira correcao — que e como o cartao e o link passaram a contar
        # coisas diferentes
        if filtro.precisam and not precisa_de_atencao(resumo):
            return False
        if filtro.dias_parado and resumo.dias_no_estado < filtro.dias_parado:
            return False

    pareceres = list(
        s.execute(
            select(ParecerTecnico).where(ParecerTecnico.processo_id == processo.id)
        ).scalars()
    )

    if filtro.sem_percentual:
        # nenhum parecer com exposicao que tenha percentual
        com_percentual = any(
            s.execute(
                select(func.count())
                .select_from(Exposicao)
                .where(Exposicao.parecer_id == p.id)
            ).scalar_one()
            for p in pareceres
        )
        if com_percentual:
            return False

    if filtro.reavaliacao_pendente:
        pendente = any(
            e.agente_nocivo.exige_reavaliacao_quantitativa
            for p in pareceres
            for e in p.exposicoes
        )
        if not pendente:
            return False

    if filtro.sem_parecer_assinado:
        if not pareceres:
            return False
        tem_anexo = any(
            s.execute(
                select(func.count())
                .select_from(Anexo)
                .where(
                    Anexo.entidade == "parecer_tecnico",
                    Anexo.entidade_id == p.id,
                    Anexo.categoria == "PARECER_ASSINADO",
                    Anexo.ativo.is_(True),
                )
            ).scalar_one()
            for p in pareceres
        )
        if tem_anexo:
            return False

    return True


def listar(s: Session, usuario: UsuarioAtual, filtro: Filtro) -> tuple[list[Processo], int]:
    consulta = _aplicar_filtro(_base(usuario), s, filtro, usuario)

    if filtro.tem_pos_filtro:
        # o pos-filtro depende de dado derivado: filtra tudo e pagina depois,
        # senao o contador mente e a paginacao pula registros
        todos = [
            p
            for p in s.execute(consulta.order_by(Processo.entrou_na_etapa_em.asc())).scalars()
            if _passa_no_pos_filtro(s, p, filtro)
        ]
        inicio = (max(filtro.pagina, 1) - 1) * filtro.por_pagina
        return todos[inicio : inicio + filtro.por_pagina], len(todos)

    total = s.execute(select(func.count()).select_from(consulta.subquery())).scalar_one()
    pagina = (
        consulta.order_by(Processo.entrou_na_etapa_em.asc())
        .limit(filtro.por_pagina)
        .offset((max(filtro.pagina, 1) - 1) * filtro.por_pagina)
    )
    return list(s.execute(pagina).scalars().all()), total




def buscar(s: Session, usuario: UsuarioAtual, q: str, limite: int) -> list[Processo]:
    """O bloco de processo da busca global (`/buscar`).

    Existe como funcao publica, e nao como chamada de `_aplicar_filtro` a partir
    da outra camada, por dois motivos. O primeiro e a terceira camada de acesso:
    `test_funcao_publica_aplica_escopo` cobra `aplicar_escopo` de tudo o que sai
    daqui, e uma busca que atravessa o sistema e exatamente onde escopo mal
    aplicado apareceria primeiro. O segundo e que o criterio de "achar processo"
    passa a ser um so — NUP, observacao, URL do SEI, numero do laudo e o nome do
    servidor de quem tem processo —, e nao dois que divergem.

    Devolve ate `limite + 1` linhas de proposito: a linha excedente e como a tela
    sabe dizer "ha mais" sem uma segunda consulta so para contar.
    """
    consulta = _aplicar_filtro(_base(usuario), s, Filtro(q=q, repositorio=None), usuario)
    pagina = consulta.order_by(Processo.entrou_na_etapa_em.desc()).limit(limite + 1)
    return list(s.execute(pagina).scalars().all())


def por_id(s: Session, usuario: UsuarioAtual, processo_id: int) -> Processo | None:
    consulta = aplicar_escopo(
        select(Processo).where(Processo.id == processo_id), usuario, Processo
    )
    return s.execute(consulta).scalar_one_or_none()


def por_nup(s: Session, usuario: UsuarioAtual, nup: str) -> Processo | None:
    consulta = aplicar_escopo(select(Processo).where(Processo.nup == nup), usuario, Processo)
    return s.execute(consulta).scalar_one_or_none()


def kanban(
    s: Session, usuario: UsuarioAtual, filtro: Filtro
) -> dict[str, list[Processo]]:
    consulta = _aplicar_filtro(_base(usuario), s, filtro, usuario)
    processos = list(s.execute(consulta.order_by(Processo.entrou_na_etapa_em)).scalars())
    colunas: dict[str, list[Processo]] = {codigo: [] for codigo, _ in COLUNAS_KANBAN}
    for processo in processos:
        colunas.setdefault(coluna_de(processo.estado_tecnico), []).append(processo)
    return colunas


def contar_por_coluna(s: Session, usuario: UsuarioAtual, filtro: Filtro) -> dict[str, int]:
    consulta = _aplicar_filtro(_base(usuario), s, filtro, usuario)
    contagem = {codigo: 0 for codigo, _ in COLUNAS_KANBAN}
    sub = consulta.subquery()
    linhas = s.execute(
        select(sub.c.estado_tecnico, func.count()).group_by(sub.c.estado_tecnico)
    ).all()
    for estado, quantidade in linhas:
        coluna = coluna_de(estado)
        contagem[coluna] = contagem.get(coluna, 0) + quantidade
    return contagem


def indicadores(s: Session, usuario: UsuarioAtual, exercicio: int | None = None) -> dict:
    """Indicadores do FLUXO. O repositório (cadastro histórico migrado) fica de
    fora: contá-lo transforma 381 registros de arquivo em 381 'pendências' e o
    painel deixa de significar alguma coisa."""
    from app.servicos.processo import resumir

    consulta = _base(usuario).where(Processo.origem_repositorio.is_(False))
    processos = list(s.execute(consulta).scalars())
    ano = exercicio or date.today().year

    resumos = [resumir(s, p) for p in processos]
    concluidos = [
        p
        for p in processos
        if p.estado_tecnico == "CONCLUIDO"
        and p.data_conclusao
        and p.data_conclusao.year == ano
    ]
    return {
        "em_andamento": sum(1 for r in resumos if r.coluna == "EM_ANDAMENTO"),
        "aguardando": sum(1 for r in resumos if r.coluna == "AGUARDANDO"),
        "a_fazer": sum(1 for r in resumos if r.coluna == "A_FAZER"),
        "atrasados": sum(1 for r in resumos if r.atrasado),
        "concluidos_no_exercicio": len(concluidos),
        "total": len(processos),
    }


def unidades_com_processo(s: Session, usuario: UsuarioAtual) -> list[UnidadeUorg]:
    consulta = _base(usuario)
    ids = {p.unidade_uorg_id for p in s.execute(consulta).scalars() if p.unidade_uorg_id}
    if not ids:
        return []
    return list(
        s.execute(
            select(UnidadeUorg).where(UnidadeUorg.id.in_(ids)).order_by(UnidadeUorg.nome_extenso)
        ).scalars()
    )
