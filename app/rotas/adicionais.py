"""/adicionais - maquina B do direito, e /pendencias - o sino."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AdicionalVigencia,
    ParecerTecnico,
    Pendencia,
    PercentualAplicavel,
    Servidor,
)
from app.modelos.estados import TransicaoInvalida
from app.servicos import direito, pendencias as servico_pendencias
from app.servicos.rbac import aplicar_escopo
from app.web import numero_da_pagina, pagina, recortar

rotas = APIRouter(tags=["adicionais"])


def _voltar(destino: str, mensagem: str | None = None, erro: str | None = None):
    from urllib.parse import urlencode

    parametros = {k: v for k, v in {"mensagem": mensagem, "erro": erro}.items() if v}
    sufixo = f"?{urlencode(parametros)}" if parametros else ""
    return RedirectResponse(destino + sufixo, status_code=303)


@rotas.get("/adicionais")
def listar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    estado: str | None = None,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("processo.ver")
    # `order_by` explicito: sem ele o SQLite devolve na ordem que quiser, e uma
    # lista paginada sem ordem definida pode repetir uma linha na pagina 2 e
    # perder outra — o defeito mais dificil de reproduzir que a paginacao produz.
    # O `id` e a ordem que a tela ja mostrava (o rowid), entao a ordenacao virou
    # explicita sem mudar nada do que se ve.
    # `AdicionalVigencia` tem `servidor_id`, que e a coluna que `aplicar_escopo`
    # procura: a vigencia diz quem recebe adicional, por qual agente nocivo e em
    # que percentual — a mesma classe de dado do parecer que a fundamenta.
    consulta = aplicar_escopo(
        select(AdicionalVigencia), usuario, AdicionalVigencia
    ).order_by(AdicionalVigencia.id)
    if estado:
        consulta = consulta.where(AdicionalVigencia.estado == estado)
    vigencias = list(s.execute(consulta).scalars())

    propostas_possiveis = [
        p
        for p in s.execute(
            aplicar_escopo(
                select(ParecerTecnico).where(
                    ParecerTecnico.situacao.in_(("EMITIDO", "ASSINADO"))
                ),
                usuario,
                ParecerTecnico,
            )
        ).scalars()
        if not s.execute(
            select(AdicionalVigencia).where(AdicionalVigencia.parecer_id == p.id)
        ).scalar_one_or_none()
    ]

    lacunas: dict[int, list[str]] = {}
    for servidor_id in {v.servidor_id for v in vigencias}:
        achadas = direito.lacunas_na_linha_do_tempo(s, servidor_id)
        if achadas:
            lacunas[servidor_id] = achadas

    # O recorte so entra DEPOIS de `lacunas`: aquele aviso vermelho declara a
    # linha do tempo inconsistente (RN-09) do recorte inteiro, e um aviso de
    # integridade que encolhesse ao virar de pagina seria pior do que aviso
    # nenhum — quem virasse a pagina concluiria que a inconsistencia sumiu.
    recorte = recortar(vigencias, numero_da_pagina(request))
    return pagina(
        request,
        "paginas/adicionais.html",
        usuario=usuario,
        vigencias=recorte.itens,
        recorte=recorte,
        propostas_possiveis=propostas_possiveis,
        percentuais=list(s.execute(select(PercentualAplicavel)).scalars()),
        motivos=direito.MOTIVOS_SUSPENSAO,
        lacunas=lacunas,
        filtro_estado=estado,
        hoje=date.today(),
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post("/adicionais/propor/{parecer_id}")
def propor(s: SessaoDep, usuario: UsuarioDep, parecer_id: int):
    parecer = s.get(ParecerTecnico, parecer_id)
    if parecer is None:
        return _voltar("/adicionais", erro="Parecer não encontrado.")
    try:
        direito.propor(s, parecer, usuario)
    except direito.RegraDoDireito as falha:
        return _voltar("/adicionais", erro=str(falha))
    s.commit()
    return _voltar("/adicionais", mensagem=f"Direito proposto a partir de {parecer.rotulo}.")


@rotas.post("/adicionais/{vigencia_id}/conceder")
def conceder(
    s: SessaoDep,
    usuario: UsuarioDep,
    vigencia_id: int,
    portaria_concessao: str = Form(...),
    data_portaria: str = Form(...),
    data_inicio: str = Form(...),
):
    vigencia = s.get(AdicionalVigencia, vigencia_id)
    if vigencia is None:
        return _voltar("/adicionais", erro="Adicional não encontrado.")
    try:
        direito.conceder(
            s,
            vigencia,
            usuario,
            portaria_concessao=portaria_concessao,
            data_portaria=date.fromisoformat(data_portaria),
            data_inicio=date.fromisoformat(data_inicio),
        )
    except (direito.RegraDoDireito, TransicaoInvalida) as falha:
        return _voltar("/adicionais", erro=str(falha))
    s.commit()
    return _voltar("/adicionais", mensagem="Adicional em vigor.")


@rotas.post("/adicionais/{vigencia_id}/suspender")
def suspender(
    s: SessaoDep,
    usuario: UsuarioDep,
    vigencia_id: int,
    motivo: str = Form(...),
    base_legal: str = Form(""),
):
    vigencia = s.get(AdicionalVigencia, vigencia_id)
    if vigencia is None:
        return _voltar("/adicionais", erro="Adicional não encontrado.")
    try:
        direito.suspender(
            s, vigencia, usuario, motivo=motivo, base_legal=base_legal or None
        )
    except (direito.RegraDoDireito, TransicaoInvalida) as falha:
        return _voltar("/adicionais", erro=str(falha))
    s.commit()
    return _voltar("/adicionais", mensagem="Adicional suspenso.")


@rotas.post("/adicionais/{vigencia_id}/cessar")
def cessar(
    s: SessaoDep,
    usuario: UsuarioDep,
    vigencia_id: int,
    data_fim: str = Form(...),
    motivo: str = Form("CESSACAO_RISCO"),
):
    vigencia = s.get(AdicionalVigencia, vigencia_id)
    if vigencia is None:
        return _voltar("/adicionais", erro="Adicional não encontrado.")
    try:
        direito.cessar(
            s, vigencia, usuario, data_fim=date.fromisoformat(data_fim), motivo=motivo
        )
    except (direito.RegraDoDireito, TransicaoInvalida) as falha:
        return _voltar("/adicionais", erro=str(falha))
    s.commit()
    return _voltar("/adicionais", mensagem="Adicional cessado.")


@rotas.post("/adicionais/{vigencia_id}/retomar")
def retomar(
    s: SessaoDep, usuario: UsuarioDep, vigencia_id: int, data_inicio: str = Form(...)
):
    vigencia = s.get(AdicionalVigencia, vigencia_id)
    if vigencia is None:
        return _voltar("/adicionais", erro="Adicional não encontrado.")
    try:
        direito.retomar(s, vigencia, usuario, date.fromisoformat(data_inicio))
    except (direito.RegraDoDireito, TransicaoInvalida) as falha:
        return _voltar("/adicionais", erro=str(falha))
    s.commit()
    return _voltar("/adicionais", mensagem="Adicional retomado.")


@rotas.post("/adicionais/{vigencia_id}/alterar")
def alterar(
    s: SessaoDep,
    usuario: UsuarioDep,
    vigencia_id: int,
    percentual_id: int = Form(...),
    motivo: str = Form(...),
):
    vigencia = s.get(AdicionalVigencia, vigencia_id)
    if vigencia is None:
        return _voltar("/adicionais", erro="Adicional não encontrado.")
    try:
        direito.alterar(s, vigencia, usuario, percentual_id=percentual_id, motivo=motivo)
    except (direito.RegraDoDireito, TransicaoInvalida) as falha:
        return _voltar("/adicionais", erro=str(falha))
    s.commit()
    return _voltar("/adicionais", mensagem="Percentual alterado.")


# ---------------------------------------------------------------------
# Pendencias (o sino)
# ---------------------------------------------------------------------
@rotas.get("/pendencias")
def listar_pendencias(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    minhas: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    servico_pendencias.exigir_ver(usuario)
    itens = servico_pendencias.abertas(s, usuario, apenas_minhas=minhas == "1")
    concluidas = list(
        s.execute(
            servico_pendencias.no_escopo(
                select(Pendencia).where(Pendencia.concluida.is_(True)), usuario
            ).limit(30)
        ).scalars()
    )
    return pagina(
        request,
        "paginas/pendencias.html",
        usuario=usuario,
        pendencias=itens,
        concluidas=concluidas,
        tipos=servico_pendencias.TIPOS,
        # De quem e o texto de cada linha, quando a ancora sabe dizer. E o que
        # devolve ao TITULAR a leitura da propria tarefa: sem isto a fatia do
        # requerente nasceria avisando "conteudo suprimido (RN-19)" sobre o
        # proprio pedido dele. Ver `pendencias.titular_de`.
        de_quem=servico_pendencias.titular_de(s, itens + concluidas),
        # o botao aparece pendencia a pendencia: o dono fecha a dele mesmo sem
        # permissao de escrita, e esconder botao nunca foi a checagem — a rota
        # refaz a mesma conta
        concluiveis={
            p.id for p in itens if servico_pendencias.pode_concluir(usuario, p)
        },
        apenas_minhas=minhas == "1",
        hoje=date.today(),
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post("/pendencias/{pendencia_id}/concluir")
def concluir_pendencia(s: SessaoDep, usuario: UsuarioDep, pendencia_id: int):
    pendencia = s.get(Pendencia, pendencia_id)
    if pendencia is None:
        # 403 antes de 404: quem nao pode ver a tela nao descobre por aqui
        # quais ids existem
        servico_pendencias.exigir_ver(usuario)
        return _voltar("/pendencias", erro="Pendência não encontrada.")
    servico_pendencias.exigir_concluir(usuario, pendencia)
    servico_pendencias.concluir(s, pendencia, usuario)
    s.commit()
    return _voltar("/pendencias", mensagem="Pendência concluída.")


_ = Servidor
