"""/servidores - cadastro com SIAPE como chave. RN-19 aplicado na exibicao."""

from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Form, Request
from urllib.parse import quote, urlencode

from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AdicionalVigencia,
    Cargo,
    ParecerTecnico,
    PostoTrabalho,
    Processo,
    Servidor,
    ServidorLotacao,
    UnidadeUorg,
)
from app.servicos import (
    auditoria,
    epi_ficha as servico_epi_ficha,
    identificacao,
    servidores as servico_servidores,
    textos,
)
from app.servicos.rbac import aplicar_escopo
from app.web import numero_da_pagina, pagina, recortar

rotas = APIRouter(tags=["servidores"])

# O `_rotulo` que morava aqui era a única implementação correta da RN-19 no
# sistema — e por morar aqui, valia só nesta tela. Virou
# `servicos.identificacao.identificar`, exposto ao Jinja como `identificar(...)`
# e usado por toda tela que mostra servidor.


# A regra da busca por nome — o oráculo que a RN-19 tem de fechar — mora em
# `servicos.identificacao.casa_a_busca`. Ela nasceu aqui e valia só nesta tela;
# a fila de EPI reescreveu a mesma coisa, e a busca global seria a terceira
# cópia. A cópia que esquecesse `pode_ver_nominal` é justamente o oráculo.


def _servidor_no_escopo(s, usuario, servidor_id: int) -> Servidor | None:
    """A ficha desta URL, no escopo de quem pediu — ou `None`.

    A única leitura de `Servidor` por id das telas de cadastro. Escrita aqui e
    não em cada rota porque era exatamente o `s.get` espalhado que fazia a lista
    apertar e a ficha continuar aberta.
    """
    return s.execute(
        aplicar_escopo(select(Servidor).where(Servidor.id == servidor_id), usuario, Servidor)
    ).scalar_one_or_none()


def _tela_lista(
    request: Request,
    s,
    usuario,
    q: str = "",
    *,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A lista, com o popup de cadastro em branco ou com o que foi digitado.

    Espelha `processos._tela_novo`, e pelo mesmo motivo: `digitado` NAO entra na
    URL. O SIAPE e o nome de uma pessoa nao podem viajar no `Location`, que vai
    parar no log do servidor e no historico do navegador — e um dicionario nao
    atravessa redirecionamento nenhum. Recusar e renderizar a propria tela de
    novo, com o popup reaberto por cima da lista.
    """
    # A lista aberta é ferramenta de trabalho para quem instrui processo, e não
    # tem finalidade nenhuma para quem não instrui o de ninguém: `ESCOPO_PROPRIO`
    # devolve o titular e mais nada. A RN-19 mascarava o nome dos outros 11 e
    # deixava passar cargo, unidade, UORG, situação e o id de banco no `href` —
    # supressão de nome não é supressão de pessoa.
    consulta = aplicar_escopo(select(Servidor), usuario, Servidor).order_by(Servidor.nome)
    itens = list(s.execute(consulta).scalars())
    if q:
        alvo = textos.chave_busca(q)
        itens = [sv for sv in itens if identificacao.casa_a_busca(alvo, sv, usuario)]
    # O recorte vem DEPOIS do filtro, e nao pode vir antes: `casa_a_busca` aplica
    # a RN-19 linha a linha e nao cabe na consulta. Paginar no banco recortaria o
    # conjunto errado — ver o docstring de `web.recortar`.
    recorte = recortar(itens, numero_da_pagina(request))
    return pagina(
        request,
        "paginas/servidores.html",
        usuario=usuario,
        servidores=recorte.itens,
        recorte=recorte,
        busca=q,
        cargos=list(s.execute(select(Cargo).order_by(Cargo.nome)).scalars()),
        unidades=list(s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()),
        postos=list(s.execute(select(PostoTrabalho).order_by(PostoTrabalho.nome)).scalars()),
        erro=erro,
        digitado=digitado or {},
    )


@rotas.get("/servidores")
def listar(request: Request, s: SessaoDep, usuario: UsuarioDep, q: str = ""):
    usuario.exigir("processo.ver")
    return _tela_lista(request, s, usuario, q)


@rotas.post("/servidores")
async def criar(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("processo.criar")
    dados = await request.form()
    siape = str(dados.get("siape") or "")
    nome = str(dados.get("nome") or "")
    cargo_id = str(dados.get("cargo_id") or "")
    funcao = str(dados.get("funcao") or "")
    unidade_uorg_id = str(dados.get("unidade_uorg_id") or "")
    uorg_id = str(dados.get("uorg_id") or "")
    email = str(dados.get("email") or "")
    postos = [int(v) for v in dados.getlist("posto_id") if str(v).isdigit()]
    siape = siape.strip()
    # Tudo o que foi digitado, guardado antes da primeira recusa. O SIAPE mal
    # digitado levava a pagina de erro do sistema — a tela inteira trocada por
    # uma frase e um "voltar" —, e o voltar do navegador nao devolve um formulario
    # enviado por POST: nome, cargo, funcao, unidade, UORG, e-mail e a selecao de
    # postos eram redigitados do zero por causa de um digito.
    digitado = {
        "siape": siape,
        "nome": nome,
        "cargo_id": cargo_id,
        "funcao": funcao,
        "unidade_uorg_id": unidade_uorg_id,
        "uorg_id": uorg_id,
        "email": email,
        "posto_id": postos,
    }
    if not re.fullmatch(r"\d{7}", siape):
        return _tela_lista(
            request,
            s,
            usuario,
            erro="A matrícula SIAPE tem exatamente 7 dígitos, sem ponto nem traço.",
            digitado=digitado,
        )
    existente = s.execute(select(Servidor).where(Servidor.siape == siape)).scalar_one_or_none()
    if existente is not None:
        # Redirecionava em silêncio para a ficha do existente, e a pessoa
        # concluía que tinha cadastrado — inclusive os oito campos que acabara
        # de digitar e que NÃO foram gravados em lugar nenhum. A ficha é o
        # destino certo; o que faltava era dizer por que se está nela.
        aviso = urlencode(
            {
                "mensagem": (
                    f"O SIAPE {siape} já estava cadastrado — esta é a ficha dele. "
                    "Nada foi criado: o que você digitou não substituiu o cadastro."
                )
            },
            quote_via=quote,
        )
        return RedirectResponse(f"/servidores/{existente.id}?{aviso}", status_code=303)

    servidor = Servidor(
        siape=siape,
        nome=nome.strip(),
        cargo_id=int(cargo_id) if cargo_id else None,
        funcao=funcao or None,
        unidade_uorg_id=int(unidade_uorg_id) if unidade_uorg_id else None,
        uorg_id=int(uorg_id) if uorg_id else None,
        email=email or None,
    )
    s.add(servidor)
    s.flush()
    auditoria.registrar(
        s,
        entidade="servidor",
        entidade_id=servidor.id,
        tipo_evento="SERVIDOR_CRIADO",
        descricao=f"Servidor SIAPE {siape} cadastrado.",
        usuario=usuario,
    )
    # abre o primeiro periodo da linha do tempo com o que foi cadastrado
    servico_servidores.registrar_lotacao_inicial(s, servidor, usuario, postos=postos)
    s.commit()
    return RedirectResponse(f"/servidores/{servidor.id}", status_code=303)


@rotas.post("/servidores/{servidor_id}")
async def editar_cadastro(
    request: Request, s: SessaoDep, usuario: UsuarioDep, servidor_id: int
):
    """Corrige nome, SIAPE, e-mail e situação. Lotação muda pelo histórico."""
    servidor = _servidor_no_escopo(s, usuario, servidor_id)
    if servidor is None:
        return RedirectResponse("/servidores", status_code=303)
    dados = await request.form()
    try:
        servico_servidores.atualizar_cadastro(
            s,
            servidor,
            usuario,
            nome=str(dados.get("nome") or ""),
            siape=str(dados.get("siape") or ""),
            email=str(dados.get("email") or ""),
            situacao=str(dados.get("situacao") or "ATIVO"),
        )
    except servico_servidores.LotacaoInvalida as erro:
        return ficha(request, s, usuario, servidor_id, erro=str(erro))
    s.commit()
    return RedirectResponse(
        f"/servidores/{servidor_id}?mensagem=Cadastro atualizado.", status_code=303
    )


@rotas.post("/servidores/{servidor_id}/lotacao")
async def alterar_lotacao(
    request: Request, s: SessaoDep, usuario: UsuarioDep, servidor_id: int
):
    """Muda unidade/UORG/postos/cargo abrindo um período novo — nada é sobrescrito."""
    servidor = _servidor_no_escopo(s, usuario, servidor_id)
    if servidor is None:
        return RedirectResponse("/servidores", status_code=303)
    dados = await request.form()

    def inteiro(chave: str) -> int | None:
        valor = str(dados.get(chave) or "")
        return int(valor) if valor.isdigit() else None

    try:
        servico_servidores.alterar_lotacao(
            s,
            servidor,
            usuario,
            unidade_uorg_id=inteiro("unidade_uorg_id"),
            uorg_id=inteiro("uorg_id"),
            postos=[int(v) for v in dados.getlist("posto_id") if str(v).isdigit()],
            cargo_id=inteiro("cargo_id"),
            funcao=str(dados.get("funcao") or ""),
            a_partir_de=date.fromisoformat(str(dados.get("a_partir_de"))),
            documento=str(dados.get("documento") or ""),
            observacao=str(dados.get("observacao") or ""),
        )
    except servico_servidores.LotacaoInvalida as erro:
        return ficha(request, s, usuario, servidor_id, erro=str(erro))
    s.commit()
    return RedirectResponse(
        f"/servidores/{servidor_id}?mensagem=Lotação alterada.", status_code=303
    )


@rotas.post("/servidores/{servidor_id}/lotacao/{lotacao_id}")
def corrigir_lotacao(
    s: SessaoDep,
    usuario: UsuarioDep,
    servidor_id: int,
    lotacao_id: int,
    documento: str = Form(""),
    observacao: str = Form(""),
):
    lotacao = s.get(ServidorLotacao, lotacao_id)
    if lotacao is not None and lotacao.servidor_id == servidor_id:
        servico_servidores.corrigir_lotacao(
            s, lotacao, usuario, documento=documento, observacao=observacao
        )
        s.commit()
    return RedirectResponse(f"/servidores/{servidor_id}", status_code=303)


@rotas.get("/servidores/{servidor_id}")
def ficha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    servidor_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("processo.ver")
    # Mesma resposta para "não existe" e "fora do seu escopo": a ficha lista os
    # processos, os pareceres e as vigências da pessoa, e o `href` da lista já
    # publicava o id sequencial do banco ao lado do código opaco. Responder
    # coisas diferentes devolveria de graça o que a numeração sequencial só
    # tornaria fácil.
    servidor = _servidor_no_escopo(s, usuario, servidor_id)
    if servidor is None:
        return RedirectResponse("/servidores", status_code=303)

    if auditoria.registrar_leitura_nominal(
        s, usuario, campo="servidor.ficha", servidor_id=servidor.id
    ):
        s.commit()

    processos = list(
        s.execute(select(Processo).where(Processo.servidor_id == servidor.id)).scalars()
    )
    pareceres = list(
        s.execute(
            select(ParecerTecnico)
            .where(ParecerTecnico.servidor_id == servidor.id)
            .order_by(ParecerTecnico.ano.desc(), ParecerTecnico.numero.desc())
        ).scalars()
    )
    vigencias = list(
        s.execute(
            select(AdicionalVigencia).where(AdicionalVigencia.servidor_id == servidor.id)
        ).scalars()
    )
    # A ficha de EPI entra como seção desta tela (§9 do desenho do módulo): é a
    # mesma pessoa, e obrigar a trocar de tela para ver o EPI dela fragmenta o
    # que a base compartilhada existe para manter junto. A visibilidade segue a
    # mesma regra da tela do módulo — `epi.ficha`, ou ser o próprio titular —, e
    # não `processo.ver`: quem não pode abrir /epis/fichas não passa a poder
    # porque entrou por outra porta.
    epi_visivel = usuario.pode("epi.ficha") or (
        usuario.servidor_id is not None and usuario.servidor_id == servidor.id
    )
    epi_linhas = servico_epi_ficha.linha_do_tempo(s, servidor.id) if epi_visivel else []
    return pagina(
        request,
        "paginas/servidor_ficha.html",
        usuario=usuario,
        servidor=servidor,
        epi_visivel=epi_visivel,
        # só as cinco últimas: o resumo aponta para a tela do módulo, e uma
        # tabela longa aqui empurraria as outras seções para fora da dobra
        epi_linhas=epi_linhas[:5],
        epi_total=len(epi_linhas),
        epi_pendentes=sum(1 for linha in epi_linhas if linha.sem_comprovante),
        processos=processos,
        pareceres=pareceres,
        vigencias=vigencias,
        lotacoes=list(reversed(servico_servidores.historico(s, servidor.id))),
        postos_atuais=servico_servidores.postos_atuais(s, servidor.id),
        inconsistencias=servico_servidores.inconsistencias(s, servidor.id),
        situacoes=("ATIVO", "APOSENTADO", "EXONERADO", "CEDIDO", "LICENCA"),
        unidades=list(s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()),
        postos=list(s.execute(select(PostoTrabalho).order_by(PostoTrabalho.nome)).scalars()),
        cargos=list(s.execute(select(Cargo).order_by(Cargo.nome)).scalars()),
        hoje=date.today(),
        mensagem=mensagem,
        erro=erro,
    )
