"""/laudos - laudo tecnico. Sem data de validade (IN 15/2022, art. 10, SS3)."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    LaudoPosto,
    LaudoTecnico,
    ParecerTecnico,
    PostoTrabalho,
    ProfissionalHabilitado,
    TipoAdicional,
    UnidadeUorg,
)
from app.servicos import datas_br, parecer as servico_parecer
from app.servicos.nup import PADRAO as _PADRAO_NUP  # noqa: F401  (mantem simetria de import)
from app.web import numero_da_pagina, pagina, recortar

rotas = APIRouter(tags=["laudos"])

RODAPE_FILA = (
    "o laudo não tem prazo de validade (IN 15/2022, art. 10, §3º); esta lista é "
    "apenas fila de trabalho, não vencimento."
)


SITUACOES_LAUDO = (("VIGENTE", "Vigentes"), ("SUPERADO", "Superados"))


def _tela_lista(
    request: Request,
    s,
    usuario,
    situacao: str = "",
    q: str = "",
    *,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A fila, com o popup de cadastro em branco ou com o que foi digitado.

    Espelha `processos._tela_novo`: `digitado` nao entra na URL, e por isso a
    recusa renderiza a propria tela em vez de redirecionar. Antes ela trocava a
    fila inteira pela pagina de erro do sistema, e o "voltar" do navegador nao
    devolve formulario enviado por POST — tipo, unidade, subscritor, data e a
    marca de coletivo eram redigitados por causa da pontuacao de um numero.
    """
    todos = list(
        s.execute(select(LaudoTecnico).order_by(LaudoTecnico.numero_siape.desc())).scalars()
    )
    resumo = {codigo: 0 for codigo, _ in SITUACOES_LAUDO}
    for laudo in todos:
        resumo[laudo.status] = resumo.get(laudo.status, 0) + 1

    busca = q.strip().lower()
    laudos = [
        laudo
        for laudo in todos
        if (not situacao or laudo.status == situacao)
        and (
            not busca
            or busca in laudo.numero_siape.lower()
            or (laudo.unidade is not None and busca in laudo.unidade.nome_extenso.lower())
            or (laudo.subscritor is not None and busca in laudo.subscritor.nome.lower())
        )
    ]
    # O recorte entra ANTES do laco de `derivados`, e nao depois: aquele laco e
    # uma consulta por laudo — a unica consulta por linha que sobrou nas listas
    # deste sistema —, e com 200 laudos na fila eram 200 idas ao banco para
    # desenhar uma tela de 50 linhas. Paginando primeiro, sao 50. Filtrar antes
    # de recortar continua obrigatorio: a busca casa por unidade e subscritor,
    # que sao relacionamentos, e nao cabe na consulta de cima.
    recorte = recortar(laudos, numero_da_pagina(request))
    derivados = {}
    for laudo in recorte.itens:
        derivados[laudo.id] = s.execute(
            select(ParecerTecnico).where(ParecerTecnico.laudo_id == laudo.id)
        ).scalars().all()
    return pagina(
        request,
        "paginas/laudos.html",
        usuario=usuario,
        laudos=recorte.itens,
        recorte=recorte,
        derivados=derivados,
        situacoes=SITUACOES_LAUDO,
        filtro_situacao=situacao,
        resumo=resumo,
        total=len(todos),
        q=q,
        unidades=list(s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()),
        tipos=list(s.execute(select(TipoAdicional)).scalars()),
        subscritores=list(s.execute(select(ProfissionalHabilitado)).scalars()),
        rodape_fila=RODAPE_FILA,
        erro=erro,
        digitado=digitado or {},
    )


@rotas.get("/laudos")
def listar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    situacao: str = "",
    q: str = "",
):
    """A fila dos laudos.

    Ate aqui era a unica lista longa do sistema SEM recorte nenhum: nem as
    fichas de situacao que /adicionais, /certificados, /turmas e a fila de EPI
    usam, nem a barra de filtros de /processos. Quem chegava com um numero na
    mao lia a lista inteira. O recorte e de UMA dimensao (a situacao do laudo,
    que a norma fecha em duas), entao ele e fileira de fichas com contagem, e o
    numero e a busca livre entram no `filtro-inline` ao lado — que e a regra
    escrita em `csso.css`, na fileira de fichas.

    A contagem sai da lista COMPLETA, e nao da filtrada: uma ficha "Superados
    (0)" que so diz zero porque o filtro vigente ja excluiu os superados nao
    informa nada e ainda contradiz a tela seguinte.
    """
    usuario.exigir("laudo.ver")
    return _tela_lista(request, s, usuario, situacao, q)


@rotas.post("/laudos")
def criar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    numero_siape: str = Form(...),
    tipo_adicional_id: int = Form(...),
    unidade_uorg_id: int = Form(...),
    subscritor_id: str = Form(""),
    data_emissao: str = Form(""),
    coletivo: str = Form(""),
):
    usuario.exigir("laudo.criar")
    import re

    # Tudo o que foi digitado, guardado antes da primeira recusa.
    digitado = {
        "numero_siape": numero_siape,
        "tipo_adicional_id": tipo_adicional_id,
        "unidade_uorg_id": unidade_uorg_id,
        "subscritor_id": subscritor_id,
        "data_emissao": data_emissao,
        "coletivo": coletivo,
    }
    if not re.fullmatch(r"\d{5}-\d{3}\.\d{3}/\d{4}", numero_siape.strip()):
        return _tela_lista(
            request,
            s,
            usuario,
            erro="Número de laudo inválido — o formato do laudo SIAPE é 26255-000.125/2019.",
            digitado=digitado,
        )
    ano = int(numero_siape.strip()[-4:])
    laudo = LaudoTecnico(
        numero_siape=numero_siape.strip(),
        ano=ano,
        tipo_adicional_id=tipo_adicional_id,
        unidade_uorg_id=unidade_uorg_id,
        subscritor_id=int(subscritor_id) if subscritor_id else None,
        data_emissao=date.fromisoformat(data_emissao) if data_emissao else None,
        coletivo=coletivo == "1",
    )
    s.add(laudo)
    s.commit()
    return RedirectResponse(f"/laudos/{laudo.id}", status_code=303)


@rotas.get("/laudos/{laudo_id}")
def ficha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    laudo_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("laudo.ver")
    laudo = s.get(LaudoTecnico, laudo_id)
    if laudo is None:
        return RedirectResponse("/laudos", status_code=303)
    derivados = list(
        s.execute(select(ParecerTecnico).where(ParecerTecnico.laudo_id == laudo.id)).scalars()
    )
    meses = (
        datas_br.meses_entre(laudo.data_ultima_conferencia, date.today())
        if laudo.data_ultima_conferencia
        else None
    )
    return pagina(
        request,
        "paginas/laudo_ficha.html",
        usuario=usuario,
        laudo=laudo,
        derivados=derivados,
        meses_desde_conferencia=meses,
        postos=list(s.execute(select(PostoTrabalho).order_by(PostoTrabalho.nome)).scalars()),
        rodape_fila=RODAPE_FILA,
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post("/laudos/{laudo_id}/postos")
def vincular_posto(
    s: SessaoDep, usuario: UsuarioDep, laudo_id: int, posto_trabalho_id: int = Form(...)
):
    usuario.exigir("laudo.criar")
    ja = s.get(LaudoPosto, (laudo_id, posto_trabalho_id))
    if ja is None:
        s.add(LaudoPosto(laudo_id=laudo_id, posto_trabalho_id=posto_trabalho_id))
        s.commit()
    return RedirectResponse(f"/laudos/{laudo_id}", status_code=303)


@rotas.post("/laudos/{laudo_id}/conferencia")
def registrar_conferencia(
    s: SessaoDep, usuario: UsuarioDep, laudo_id: int, motivo: str = Form(...)
):
    usuario.exigir("laudo.criar")
    laudo = s.get(LaudoTecnico, laudo_id)
    if laudo is not None:
        laudo.data_ultima_conferencia = date.today()
        laudo.motivo_ultima_conferencia = motivo
        s.commit()
    return RedirectResponse(f"/laudos/{laudo_id}?mensagem=Conferência registrada.", status_code=303)


@rotas.post("/laudos/{laudo_id}/superar")
def superar(
    s: SessaoDep,
    usuario: UsuarioDep,
    laudo_id: int,
    motivo: str = Form(...),
    substituto_id: str = Form(""),
):
    laudo = s.get(LaudoTecnico, laudo_id)
    if laudo is None:
        return RedirectResponse("/laudos", status_code=303)
    substituto = s.get(LaudoTecnico, int(substituto_id)) if substituto_id else None
    derivados = servico_parecer.marcar_laudo_superado(s, laudo, usuario, motivo, substituto)
    s.commit()
    return RedirectResponse(
        f"/laudos/{laudo_id}?mensagem=Laudo superado; "
        f"{len(derivados)} parecer(es) em reavaliação.",
        status_code=303,
    )
