"""/processos e /processos/{id} - lista, ficha, anexos, checklist e histórico."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import desc, select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    Anexo,
    Checklist,
    ChecklistItem,
    FluxoEtapa,
    HistoricoEvento,
    ParecerTecnico,
    Processo,
    Servidor,
    TipoProcesso,
    UnidadeUorg,
    Usuario,
    agora_utc,
)
from app.modelos.estados import (
    INCISOS_ART11,
    ROTULO_ESTADO_TELA,
    TRANSICOES,
    TransicaoInvalida,
)
from app.repositorios import processos as repo
from app.servicos import (
    anexo_acesso,
    anexos as servico_anexos,
    auditoria,
    nup as servico_nup,
    sei,
    textos,
)
from app.servicos.rbac import PermissaoNegada
from app.servicos.processo import (
    CHAVES_AGRUPAMENTO,
    RequisitoDeSaidaNaoAtendido,
    agrupar,
    mover,
    requisitos_de_saida,
    resumir,
    voltar_do_sobrestamento,
)
from app.web import pagina

rotas = APIRouter(tags=["processos"])

VISOES_SALVAS = [
    ("Minha fila", "?responsavel_id=eu"),
    # A visão que o cartão "Precisam de você hoje" do painel conta. Ela entra na
    # lista salva porque o link do cartão precisa de um destino que aplique o
    # MESMO critério — e uma visão que só existe como querystring escondida é uma
    # visão que ninguém acha depois.
    ("Precisam de você hoje", "?precisam=1"),
    ("Atrasados", "?atrasados=1"),
    ("Parados há mais de 90 dias", "?dias=90"),
    ("Sem nº SEI", "?sem_numero_sei=1"),
    ("Sem percentual", "?sem_percentual=1"),
    ("Reavaliação pendente – químicos", "?reavaliacao_pendente=1"),
    ("Campus Avançados", "?repositorio=1"),
    ("Sem parecer assinado anexado", "?sem_parecer_assinado=1"),
]


def _codigos_por_rotulo() -> list[str]:
    """Os estados na ordem em que a tela os escreve — só os códigos.

    A lista era de pares `(codigo, rotulo)` tirados do `ROTULO_ESTADO` ASCII.
    Desde que o `<option>` passou a escrever `{{ codigo|estado }}`, o segundo
    elemento virou carona: viajava até o template para ninguém ler, e deixava a
    próxima pessoa que mexesse no `<select>` com dois rótulos à escolha, um
    deles o do banco. O par ainda servia à ordenação — e a ordenação fica, agora
    pela chave certa, o rótulo de TELA, que é o texto que se lê na lista. As
    duas ordens são idênticas: o acento só aparece depois do trecho que já
    separa cada estado do vizinho.
    """
    return [
        codigo
        for codigo, _ in sorted(ROTULO_ESTADO_TELA.items(), key=lambda kv: kv[1])
    ]


def _filtro(request: Request, usuario) -> repo.Filtro:
    p = request.query_params
    responsavel = p.get("responsavel_id")
    if responsavel == "eu":
        responsavel_id = usuario.id
    elif (responsavel or "").isdigit():
        responsavel_id = int(responsavel)
    else:
        responsavel_id = None
    return repo.Filtro(
        q=p.get("q") or None,
        estado=p.get("estado") or None,
        tipo=p.get("tipo") or None,
        exercicio=int(p["exercicio"]) if p.get("exercicio", "").isdigit() else None,
        responsavel_id=responsavel_id,
        unidade_id=int(p["unidade_id"]) if p.get("unidade_id", "").isdigit() else None,
        atrasados=p.get("atrasados") == "1",
        precisam=p.get("precisam") == "1",
        sem_numero_sei=p.get("sem_numero_sei") == "1",
        repositorio=p.get("repositorio") == "1",
        dias_parado=int(p["dias"]) if p.get("dias", "").isdigit() else None,
        sem_percentual=p.get("sem_percentual") == "1",
        reavaliacao_pendente=p.get("reavaliacao_pendente") == "1",
        sem_parecer_assinado=p.get("sem_parecer_assinado") == "1",
        agrupar=p.get("agrupar") or None,
        pagina=int(p["pagina"]) if p.get("pagina", "").isdigit() else 1,
    )


@rotas.get("/processos")
def listar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("processo.ver")
    filtro = _filtro(request, usuario)
    itens, total = repo.listar(s, usuario, filtro)
    # A pagina passou a ser APARADA, e ela so pode ser aparada depois: o total
    # sai da propria consulta. Enquanto a tela escrevia so "pagina 3", passar do
    # fim devolvia uma lista vazia com o vazio de "o filtro esta errado" — e
    # agora escreveria "pagina 99 de 15", que e pior, porque afirma a escala e
    # mente sobre a posicao. A segunda consulta so acontece quando alguem digita
    # um numero fora da faixa na URL; pelos links da tela ela nunca roda.
    ultima = max(1, -(-total // filtro.por_pagina))
    if filtro.pagina > ultima:
        filtro.pagina = ultima
        itens, total = repo.listar(s, usuario, filtro)
    grupos = agrupar(itens, filtro.agrupar) if filtro.agrupar in CHAVES_AGRUPAMENTO else None
    return pagina(
        request,
        "paginas/processos.html",
        usuario=usuario,
        resumos=[resumir(s, p) for p in itens],
        grupos={
            rotulo: [resumir(s, p) for p in lista] for rotulo, lista in (grupos or {}).items()
        }
        if grupos
        else None,
        chaves_agrupamento=CHAVES_AGRUPAMENTO,
        total=total,
        filtro=filtro,
        busca=filtro.q,
        estados_lote=_codigos_por_rotulo(),
        tipos=list(s.execute(select(TipoProcesso).order_by(TipoProcesso.nome)).scalars()),
        unidades=repo.unidades_com_processo(s, usuario),
        responsaveis=list(s.execute(select(Usuario).order_by(Usuario.nome)).scalars()),
        estados=_codigos_por_rotulo(),
        visoes=VISOES_SALVAS,
        incisos=INCISOS_ART11,
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post("/processos/lote")
async def acao_em_lote(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """Ação em lote que não mente: relata um a um o que passou e o que não."""
    dados = await request.form()
    ids = [int(v) for v in dados.getlist("processo_id") if str(v).isdigit()]
    acao = dados.get("acao") or ""
    feitos: list[str] = []
    recusados: list[str] = []

    for processo_id in ids:
        processo = repo.por_id(s, usuario, processo_id)
        if processo is None:
            recusados.append(f"#{processo_id}: fora do seu escopo")
            continue
        try:
            if acao == "estado":
                mover(
                    s,
                    processo,
                    dados.get("destino") or "",
                    usuario,
                    comentario=dados.get("comentario") or None,
                    inciso_art11=dados.get("inciso_art11") or None,
                )
            elif acao == "responsavel":
                usuario.exigir("processo.atribuir")
                processo.responsavel_id = (
                    int(dados["responsavel_id"])
                    if str(dados.get("responsavel_id", "")).isdigit()
                    else None
                )
                auditoria.registrar(
                    s,
                    entidade="processo",
                    entidade_id=processo.id,
                    processo_id=processo.id,
                    tipo_evento="RESPONSAVEL_ALTERADO",
                    descricao=f"Responsável definido em lote.",
                    usuario=usuario,
                )
            elif acao == "prazo":
                usuario.exigir("processo.editar")
                processo.prazo = (
                    date.fromisoformat(dados["prazo"]) if dados.get("prazo") else None
                )
            else:
                recusados.append(f"{processo.nup}: ação desconhecida")
                continue
            feitos.append(processo.nup)
        except (TransicaoInvalida, RequisitoDeSaidaNaoAtendido) as erro:
            motivos = getattr(erro, "motivos", None) or [str(erro)]
            recusados.append(f"{processo.nup}: {'; '.join(motivos)}")
        except PermissaoNegada as erro:
            recusados.append(f"{processo.nup}: {erro}")

    s.commit()
    mensagem = f"{len(feitos)} processo(s) atualizado(s)." if feitos else None
    erro = (
        f"{len(recusados)} não passaram — " + " · ".join(recusados[:5])
        if recusados
        else None
    )
    destino = "/processos?" + (dados.get("voltar_para") or "")
    # `quote_via=quote` para o espaço sair `%20` e não `+`: é o mesmo encode dos
    # helpers `_aviso` das outras rotas, e um sistema que codifica o espaço de
    # dois jeitos obriga quem lê o `Location` a saber qual rota o escreveu.
    from urllib.parse import quote, urlencode

    parametros = {k: v for k, v in {"mensagem": mensagem, "erro": erro}.items() if v}
    if parametros:
        destino += ("&" if destino.endswith("?") is False else "") + urlencode(
            parametros, quote_via=quote
        )
    return RedirectResponse(destino, status_code=303)


@rotas.get("/processos/novo")
def tela_novo(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("processo.criar")
    return _tela_novo(request, s, usuario)


@rotas.post("/processos/novo")
def criar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nup: str = Form(...),
    tipo_processo_id: int = Form(...),
    servidor_id: str = Form(""),
    unidade_uorg_id: str = Form(""),
    data_autuacao: str = Form(""),
    observacoes: str = Form(""),
    dispensar_dv: str = Form(""),
):
    usuario.exigir("processo.criar")
    # Tudo o que foi digitado, guardado antes da primeira recusa. Recusar sem
    # devolver o formulário obrigava a redigitar observação, tipo, servidor,
    # unidade, data e a marca de dispensa por causa de um dígito verificador —
    # e quem redigita erra de novo.
    digitado = {
        "nup": nup,
        "tipo_processo_id": tipo_processo_id,
        "servidor_id": servidor_id,
        "unidade_uorg_id": unidade_uorg_id,
        "data_autuacao": data_autuacao,
        "observacoes": observacoes,
        "dispensar_dv": dispensar_dv,
    }
    resultado = servico_nup.validar(nup)
    if not resultado.formato_ok:
        return _erro_novo(
            request, s, usuario, resultado.aviso or "NUP inválido", digitado
        )
    # do formato em diante vale o NUP normalizado: é ele que o sistema gravaria,
    # e devolver o texto cru faria a pessoa conferir a pontuação de novo
    digitado["nup"] = resultado.valor
    if not resultado.dv_ok and dispensar_dv != "1":
        return _erro_novo(
            request,
            s,
            usuario,
            f"{resultado.aviso}. Marque 'confirmei no SEI' para prosseguir.",
            digitado,
        )
    if repo.por_nup(s, usuario, resultado.valor) is not None:
        return _erro_novo(
            request, s, usuario, "já existe processo com este NUP", digitado
        )

    try:
        textos.exigir_texto_limpo(observacoes, "observações")
    except textos.TextoProibido as erro:
        return _erro_novo(request, s, usuario, str(erro), digitado)

    etapa = s.execute(select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")).scalar_one()
    processo = Processo(
        nup=resultado.valor,
        tipo_processo_id=tipo_processo_id,
        etapa_id=etapa.id,
        estado_tecnico="RECEBIDO",
        servidor_id=int(servidor_id) if servidor_id else None,
        unidade_uorg_id=int(unidade_uorg_id) if unidade_uorg_id else None,
        data_autuacao=date.fromisoformat(data_autuacao) if data_autuacao else None,
        ano_referencia=date.today().year,
        observacoes=observacoes or None,
        nup_dv_dispensado=not resultado.dv_ok,
        responsavel_id=usuario.id,
    )
    s.add(processo)
    s.flush()

    auditoria.registrar(
        s,
        entidade="processo",
        entidade_id=processo.id,
        processo_id=processo.id,
        tipo_evento="PROCESSO_CRIADO",
        descricao=f"Processo {processo.nup} criado.",
        usuario=usuario,
    )
    if not resultado.dv_ok:
        auditoria.registrar(
            s,
            entidade="processo",
            entidade_id=processo.id,
            processo_id=processo.id,
            tipo_evento=auditoria.NUP_DV_DISPENSADO,
            descricao=f"DV do NUP {processo.nup} dispensado por confirmação manual.",
            usuario=usuario,
        )
    s.commit()
    return RedirectResponse(f"/processos/{processo.id}", status_code=303)


def _tela_novo(request, s, usuario, *, erro: str | None = None, digitado: dict | None = None):
    """A tela do processo novo, em branco ou com o que foi digitado de volta.

    Uma função só para os dois casos: a recusa que reabre a tela e a abertura
    limpa. Duplicá-las foi o que fez a recusa esquecer metade dos campos.
    """
    return pagina(
        request,
        "paginas/processo_novo.html",
        usuario=usuario,
        erro=erro,
        digitado=digitado or {},
        tipos=list(s.execute(select(TipoProcesso).order_by(TipoProcesso.nome)).scalars()),
        servidores=list(s.execute(select(Servidor).order_by(Servidor.nome)).scalars()),
        unidades=list(s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()),
    )


def _erro_novo(request, s, usuario, mensagem: str, digitado: dict | None = None):
    return _tela_novo(request, s, usuario, erro=mensagem, digitado=digitado)


@rotas.get("/processos/{processo_id}")
def ficha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    processo_id: int,
    aba: str = "dados",
    mensagem: str | None = None,
    erro: str | None = None,
    # O que a pessoa escreveu no comentário e o filtro da RN-21 recusou. Volta
    # para dentro do campo, pelo mesmo motivo do `digitado` de `/processos/novo`:
    # a recusa é deliberada, mas apagar o texto de quem escreveu não faz parte
    # dela — e quem redigita de memória escreve pior na segunda vez.
    comentario_digitado: str = "",
):
    usuario.exigir("processo.ver")
    processo = repo.por_id(s, usuario, processo_id)
    if processo is None:
        # A tela estava certa e o status mentia: `pagina()` sai 200, então o
        # navegador guardava "404 — processo não encontrado" no histórico como
        # sucesso e nenhum monitor ou script de conferência via o erro. Quem
        # desenha a tela agora é o tratador de HTTPException em `principal.py`,
        # que já sai com a casca — e devolve JSON com 404 a quem não pediu HTML,
        # que é o outro lado da mesma queixa.
        raise HTTPException(
            status_code=404,
            detail="O processo não existe ou está fora do seu escopo.",
        )

    # Quem decide e a relacao titular/terceiro, e nao `ve_dado_nominal`: a
    # permissao dizia quem VE o nome, e a tela entregava a linha nominal a quem
    # nao a tem. O argumento inteiro esta em `auditoria.registrar_leitura_nominal`.
    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="processo.servidor",
        servidor_id=processo.servidor_id,
        processo_id=processo.id,
    ):
        s.commit()

    pareceres = list(
        s.execute(
            select(ParecerTecnico)
            .where(ParecerTecnico.processo_id == processo.id)
            .order_by(ParecerTecnico.ano.desc(), ParecerTecnico.numero.desc())
        ).scalars()
    )
    eventos = list(
        s.execute(
            select(HistoricoEvento)
            .where(HistoricoEvento.processo_id == processo.id)
            .order_by(desc(HistoricoEvento.ocorrido_em))
        ).scalars()
    )
    checklists = list(
        s.execute(
            select(Checklist).where(Checklist.processo_id == processo.id).order_by(Checklist.ordem)
        ).scalars()
    )
    from app.modelos import ChecklistModelo, Pendencia

    modelos = [
        m
        for m in s.execute(
            select(ChecklistModelo).where(ChecklistModelo.ativo)
        ).scalars()
        if m.tipo_processo_id in (None, processo.tipo_processo_id)
    ]
    pendencias_do_processo = list(
        s.execute(
            select(Pendencia).where(
                Pendencia.processo_id == processo.id, Pendencia.concluida.is_(False)
            )
        ).scalars()
    )

    return pagina(
        request,
        "paginas/processo_ficha.html",
        usuario=usuario,
        processo=processo,
        resumo=resumir(s, processo),
        aba=aba,
        pareceres=pareceres,
        eventos=eventos,
        checklists=checklists,
        modelos_checklist=modelos,
        pendencias_do_processo=pendencias_do_processo,
        anexos=servico_anexos.listar(s, "processo", processo.id),
        categorias=servico_anexos.CATEGORIAS_PROCESSO,
        destinos=sorted(TRANSICOES.get(processo.estado_tecnico, frozenset())),
        incisos=INCISOS_ART11,
        faltas_saida=requisitos_de_saida(s, processo, ""),
        passos_sei=sei.PASSOS_INCLUSAO,
        mensagem=mensagem,
        erro=erro,
        comentario_digitado=comentario_digitado,
    )


@rotas.post("/processos/{processo_id}/estado")
def mudar_estado(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    processo_id: int,
    destino: str = Form(...),
    comentario: str = Form(""),
    inciso_art11: str = Form(""),
):
    processo = repo.por_id(s, usuario, processo_id)
    if processo is None:
        return RedirectResponse("/processos", status_code=303)
    try:
        if destino == "__voltar__":
            voltar_do_sobrestamento(s, processo, usuario)
        else:
            mover(
                s,
                processo,
                destino,
                usuario,
                comentario=comentario or None,
                inciso_art11=inciso_art11 or None,
            )
        s.commit()
        return RedirectResponse(f"/processos/{processo_id}?aba=historico", status_code=303)
    except (TransicaoInvalida, RequisitoDeSaidaNaoAtendido) as erro:
        motivos = getattr(erro, "motivos", None) or [str(erro)]
        return ficha(request, s, usuario, processo_id, erro=" · ".join(motivos))


@rotas.post("/processos/{processo_id}/sei")
def registrar_sei(
    s: SessaoDep,
    usuario: UsuarioDep,
    processo_id: int,
    url_permanente: str = Form(""),
):
    usuario.exigir("processo.editar")
    processo = repo.por_id(s, usuario, processo_id)
    if processo is not None:
        antes = processo.url_permanente
        processo.url_permanente = url_permanente or None
        auditoria.registrar_diferencas(
            s,
            entidade="processo",
            entidade_id=processo.id,
            antes={"url_permanente": antes},
            depois={"url_permanente": processo.url_permanente},
            usuario=usuario,
            processo_id=processo.id,
        )
        s.commit()
    return RedirectResponse(f"/processos/{processo_id}", status_code=303)


@rotas.post("/processos/{processo_id}/anexos")
async def enviar_anexo(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    processo_id: int,
    categoria: str = Form("OUTRO"),
    numero_documento_sei: str = Form(""),
    arquivo: UploadFile = File(...),
):
    usuario.exigir("anexo.enviar")
    processo = repo.por_id(s, usuario, processo_id)
    if processo is None:
        return RedirectResponse("/processos", status_code=303)
    conteudo = await arquivo.read()
    resultado = servico_anexos.guardar(
        s,
        entidade="processo",
        entidade_id=processo.id,
        nome_original=arquivo.filename or "arquivo",
        conteudo=conteudo,
        mime_type=arquivo.content_type or "application/octet-stream",
        categoria=categoria,
        usuario=usuario,
        processo_id=processo.id,
        numero_documento_sei=numero_documento_sei or None,
    )
    s.commit()
    if resultado.duplicado:
        mensagem = "Arquivo idêntico já anexado neste processo — ignorado."
    elif resultado.tambem_em > 1:
        mensagem = f"Anexado. Este mesmo arquivo também está em {resultado.tambem_em} processos."
    else:
        mensagem = "Anexo enviado."
    return ficha(request, s, usuario, processo_id, aba="anexos", mensagem=mensagem)


@rotas.get("/anexos/{anexo_id}")
def baixar_anexo(s: SessaoDep, usuario: UsuarioDep, anexo_id: int):
    """O download herda a autorização do dono do anexo — `servicos.anexo_acesso`.

    A rota não tem regra própria e não deve ganhar uma: ela resolve o id, delega
    e serve o arquivo. Aqui mora só a **forma da recusa**, e ela é uma só para
    os quatro casos (id inexistente, anexo desativado, dono fora do escopo,
    entidade sem regra declarada). Responder 404 num e 403 noutro devolveria a
    enumeração pela porta dos fundos: quem varre `1, 2, 3…` deixaria de baixar o
    parecer e passaria a descobrir quantos existem e de que tipo — e "este id
    existe e você não pode" já é informação sobre a pessoa por trás dele.

    O 404 com o motivo escrito é o mesmo que a ficha do processo devolve para
    processo fora do escopo, e pela mesma razão.
    """
    anexo = s.get(Anexo, anexo_id)
    try:
        anexo_acesso.liberar(s, usuario, anexo)
    except PermissaoNegada:
        raise HTTPException(
            status_code=404, detail=anexo_acesso.INDISPONIVEL
        ) from None
    s.commit()
    return FileResponse(
        servico_anexos.caminho_absoluto(anexo),
        media_type=anexo.mime_type,
        filename=anexo.nome_original,
    )


@rotas.post("/processos/{processo_id}/checklist")
def criar_checklist(
    s: SessaoDep,
    usuario: UsuarioDep,
    processo_id: int,
    nome: str = Form(...),
    itens: str = Form(""),
):
    usuario.exigir("processo.editar")
    checklist = Checklist(processo_id=processo_id, nome=nome)
    s.add(checklist)
    s.flush()
    for ordem, linha in enumerate(
        [l.strip() for l in itens.splitlines() if l.strip()], start=1
    ):
        s.add(ChecklistItem(checklist_id=checklist.id, descricao=linha, ordem=ordem))
    s.commit()
    return RedirectResponse(f"/processos/{processo_id}?aba=checklist", status_code=303)


@rotas.post("/processos/{processo_id}/checklist-modelo")
def aplicar_modelo(
    s: SessaoDep, usuario: UsuarioDep, processo_id: int, modelo_id: int = Form(...)
):
    from app.modelos import ChecklistModelo
    from app.servicos.processo import aplicar_checklist_modelo

    usuario.exigir("processo.editar")
    processo = repo.por_id(s, usuario, processo_id)
    modelo = s.get(ChecklistModelo, modelo_id)
    if processo is not None and modelo is not None:
        aplicar_checklist_modelo(s, processo, modelo, usuario)
        s.commit()
    return RedirectResponse(f"/processos/{processo_id}?aba=checklist", status_code=303)


@rotas.post("/checklist-item/{item_id}")
def marcar_item(s: SessaoDep, usuario: UsuarioDep, item_id: int):
    usuario.exigir("processo.editar")
    item = s.get(ChecklistItem, item_id)
    if item is None:
        return RedirectResponse("/processos", status_code=303)
    item.concluido = not item.concluido
    item.concluido_em = agora_utc() if item.concluido else None
    item.concluido_por = usuario.id if item.concluido else None
    processo_id = s.get(Checklist, item.checklist_id).processo_id
    s.commit()
    return RedirectResponse(f"/processos/{processo_id}?aba=checklist", status_code=303)


@rotas.post("/processos/{processo_id}/comentario")
def comentar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    processo_id: int,
    comentario: str = Form(...),
):
    """Comentário no histórico, com o filtro da RN-21 antes de gravar.

    A recusa é **deliberada e tem motivo bom**: comentário vira linha de
    auditoria, e auditoria não guarda dado de saúde (RN-21; LGPD art. 11). O que
    estava errado era a forma de recusar. `TextoProibido` é `ValueError`, e
    `principal.py` só trata `RedirecionaParaLogin`, `PermissaoNegada` e
    `HTTPException` — então escrever "atestado médico" aqui devolvia a página
    branca do Starlette, sem casca, sem saída e sem o texto digitado. A mesma
    chamada já estava protegida dez linhas acima, em `criar`; o que faltava era
    a proteção, não a regra.
    """
    usuario.exigir("processo.editar")
    try:
        textos.exigir_texto_limpo(comentario, "comentário")
    except textos.TextoProibido as recusa:
        return ficha(
            request,
            s,
            usuario,
            processo_id,
            aba="historico",
            erro=str(recusa),
            comentario_digitado=comentario,
        )
    auditoria.registrar(
        s,
        entidade="processo",
        entidade_id=processo_id,
        processo_id=processo_id,
        tipo_evento="COMENTARIO",
        descricao=comentario.strip(),
        comentario=comentario.strip(),
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(f"/processos/{processo_id}?aba=historico", status_code=303)
