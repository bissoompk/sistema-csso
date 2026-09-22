"""/ - dashboard."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Request
from sqlalchemy import desc, func, select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AgenteNocivo,
    Exposicao,
    HistoricoEvento,
    LaudoTecnico,
    ParecerTecnico,
    ProfissionalHabilitado,
    TipoRisco,
)
from app.repositorios import processos as repo
from app.rotas.relatorios import LIMIAR_SUPRESSAO, suprimir
from app.servicos import datas_br
from app.web import pagina

rotas = APIRouter(tags=["painel"])

# Quantas linhas do cartão cabem sem o painel virar lista. O número TOTAL vai
# junto e é o que o contador publica: cortar a lista é decisão de tela, cortar o
# número é o painel mentindo.
MOSTRADOS_NO_CARTAO = 8

# A visão de `/processos` que o cartão linka. Fica numa constante porque o
# contador e o link têm de continuar apontando para o mesmo recorte.
FILA_PRECISAM = "/processos?precisam=1"


@rotas.get("/")
def painel(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("processo.ver")
    exercicio = date.today().year
    kpis = repo.indicadores(s, usuario, exercicio)

    habilitados = [
        h
        for h in s.execute(select(ProfissionalHabilitado)).scalars()
        if h.vigente_em(date.today())
    ]
    kpis["subscritores_habilitados"] = len(habilitados)

    emitidos = s.execute(
        select(ParecerTecnico).where(
            ParecerTecnico.situacao.in_(("EMITIDO", "ASSINADO")),
            ParecerTecnico.ano == exercicio,
        )
    ).scalars().all()
    tempos = [
        (p.data_emissao - p.processo.data_autuacao).days
        for p in emitidos
        if p.data_emissao and p.processo and p.processo.data_autuacao
    ]
    kpis["tempo_medio_emissao"] = round(sum(tempos) / len(tempos)) if tempos else None

    por_mes: dict[int, int] = {mes: 0 for mes in range(1, 13)}
    for parecer in emitidos:
        if parecer.data_emissao:
            por_mes[parecer.data_emissao.month] += 1

    # RN-19 também aqui, e com a MESMA funcao de `/relatorios`. O painel e a tela
    # de `processo.ver`, permissao mais larga que o `indicador.ver` da tela de
    # indicadores — publicar cru o que la sai suprimido fazia do painel a porta
    # dos fundos da supressao, e quem lesse as duas nao tinha como saber qual das
    # duas regras valia.
    contagem_por_risco = {
        nome: quantidade
        for nome, quantidade in s.execute(
            select(TipoRisco.nome, func.count())
            .select_from(Exposicao)
            .join(AgenteNocivo, AgenteNocivo.id == Exposicao.agente_nocivo_id)
            .join(TipoRisco, TipoRisco.id == AgenteNocivo.tipo_risco_id)
            .group_by(TipoRisco.nome)
        ).all()
    }
    por_risco = suprimir(contagem_por_risco, usuario.ve_dado_nominal)

    # O cartão "Precisam de você hoje" e o link dele contam a MESMA coisa, porque
    # agora são a mesma consulta: o filtro `precisam` do repositório aplica
    # `servicos.processo.precisa_de_atencao`, que é o que `/processos?precisam=1`
    # aplica. Antes o cartão filtrava a mão a primeira página de 50, cortava em
    # oito e publicava `|length` — um contador que nunca passava de 8 — enquanto
    # "Ver todos" abria `?atrasados=1`, um recorte menor e de outro critério.
    #
    # `por_pagina` alto, e não paginação: o total é o que o cartão publica, e um
    # total de página seria a mesma mentira com outro número. O custo é uma
    # passada de `resumir` por processo — a mesma que `repo.indicadores` acima já
    # faz para os KPIs, e a paginação não a evitaria (o pós-filtro é derivado).
    lista, total_precisam = repo.listar(
        s, usuario, repo.Filtro(precisam=True, por_pagina=100000)
    )
    from app.servicos.processo import resumir

    precisam_de_voce = sorted(
        (resumir(s, p) for p in lista), key=lambda r: -r.dias_no_estado
    )[:MOSTRADOS_NO_CARTAO]

    laudos_sem_conferencia = [
        laudo
        for laudo in s.execute(
            select(LaudoTecnico).where(LaudoTecnico.status == "VIGENTE")
        ).scalars()
        if laudo.data_ultima_conferencia is None
        or datas_br.meses_entre(laudo.data_ultima_conferencia, date.today()) > 24
    ]

    eventos = list(
        s.execute(
            select(HistoricoEvento).order_by(desc(HistoricoEvento.id)).limit(10)
        ).scalars()
    )

    # Primeiro acesso: a conta nasce superintendente, que governa acesso mas nao
    # opera processo. Sem esta dica o coordenador trava no primeiro minuto.
    precisa_de_perfil_operacional = usuario.pode("perfil.conceder") and not usuario.pode(
        "processo.criar"
    )

    return pagina(
        request,
        "paginas/painel.html",
        usuario=usuario,
        precisa_de_perfil_operacional=precisa_de_perfil_operacional,
        kpis=kpis,
        exercicio=exercicio,
        por_mes=por_mes,
        por_risco=por_risco,
        limiar=LIMIAR_SUPRESSAO,
        precisam_de_voce=precisam_de_voce,
        total_precisam=total_precisam,
        fila_precisam=FILA_PRECISAM,
        laudos_sem_conferencia=laudos_sem_conferencia,
        eventos=eventos,
    )
