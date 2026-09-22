"""/kanban - operacao diaria. Drag-and-drop por `fetch`, no script da propria tela.

O docstring dizia "via HTMX" e mandava quem fosse consertar procurar `hx-post`
que nao existe: o arrastar-e-soltar e HTML5 drag-and-drop mais um `fetch` em
`paginas/kanban.html`. HTMX entra em outras quatro telas, nao nesta.

`mover_cartao` responde **fragmento**, e nao redirect, dos dois lados: o cartao
novo quando passa, e `partes/erro_movimento.html` com 422 quando a maquina de
estados recusa. Quem coloca a recusa na tela e o script, e ele a escreve dentro
da coluna onde o cartao foi solto — nao numa faixa no topo da pagina, que num
quadro de cinco colunas longas fica fora da tela justamente quando e precisa.

A excecao e o formulario comum: o cartao ganhou um menu "mover para…" que e um
`<form method="post">` de verdade, para o toque e o teclado, e sem JavaScript
ele submete como qualquer formulario. Para ESSE pedido a rota devolve o quadro
inteiro (303), com a mensagem ou a recusa na faixa — um fragmento de cartao
solto no navegador nao e tela nenhuma. Quem distingue os dois e `_quer_pagina`.
"""

from __future__ import annotations

from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import TipoProcesso, Usuario
from app.modelos.estados import (
    COLUNAS_KANBAN,
    ESTADO_PARA_COLUNA,
    TransicaoInvalida,
    coluna_de,
)
from app.repositorios import processos as repo
from app.servicos.processo import RequisitoDeSaidaNaoAtendido, mover, resumir
from app.web import fragmento, pagina

rotas = APIRouter(tags=["kanban"])

# Estado padrao ao soltar um cartao numa coluna (a coluna e visao; o estado e verdade)
ESTADO_PADRAO_DA_COLUNA: dict[str, str] = {
    "NAO_INICIADO": "NAO_INICIADO",
    "A_FAZER": "EM_TRIAGEM",
    "EM_ANDAMENTO": "AGUARDANDO_INSPECAO",
    "AGUARDANDO": "PENDENTE_DOCUMENTO",
    "CONCLUIDO": "CONCLUIDO",
}


def _quer_pagina(request: Request) -> bool:
    """Pedido de formulario comum (sem JavaScript), e nao do `fetch` do quadro.

    O `fetch` do script manda `X-Requested-With: fetch` e aceita qualquer coisa;
    o navegador submetendo um `<form>` nao manda cabecalho nenhum e pede
    `text/html`. A suite, que chama a rota direto, aceita `*/*` — e continua
    recebendo o fragmento, que e o contrato que ela prova.
    """
    if request.headers.get("x-requested-with") == "fetch":
        return False
    if request.headers.get("hx-request") == "true":
        return False
    return "text/html" in request.headers.get("accept", "")


def _de_volta_ao_quadro(campo: str, texto: str) -> RedirectResponse:
    return RedirectResponse(
        "/kanban?" + urlencode({campo: texto}, quote_via=quote), status_code=303
    )


def _filtro(request: Request) -> repo.Filtro:
    p = request.query_params
    return repo.Filtro(
        q=p.get("q") or None,
        tipo=p.get("tipo") or None,
        exercicio=int(p["exercicio"]) if p.get("exercicio", "").isdigit() else None,
        responsavel_id=int(p["responsavel_id"]) if p.get("responsavel_id", "").isdigit() else None,
        atrasados=p.get("atrasados") == "1",
        # `precisam` entra aqui pela mesma razão de `atrasados`: o alternador
        # Quadro/Tabela reproduz o filtro pela querystring, e o que o quadro não
        # lê ele não devolve — ir à tabela filtrada, olhar o quadro e voltar
        # perderia a visão em que a pessoa estava.
        precisam=p.get("precisam") == "1",
        repositorio=p.get("repositorio") == "1",
    )


@rotas.get("/kanban")
def quadro(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("processo.ver")
    filtro = _filtro(request)
    colunas = repo.kanban(s, usuario, filtro)
    resumos = {
        codigo: [resumir(s, p) for p in lista] for codigo, lista in colunas.items()
    }
    return pagina(
        request,
        "paginas/kanban.html",
        usuario=usuario,
        resumos=resumos,
        filtro=filtro,
        busca=filtro.q,
        tipos=list(s.execute(select(TipoProcesso).order_by(TipoProcesso.nome)).scalars()),
        responsaveis=list(s.execute(select(Usuario).order_by(Usuario.nome)).scalars()),
        estados_disponiveis=sorted(ESTADO_PARA_COLUNA),
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post("/kanban/mover/{processo_id}")
def mover_cartao(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    processo_id: int,
    coluna: str = Form(...),
    estado: str | None = Form(None),
    inciso_art11: str | None = Form(None),
    comentario: str | None = Form(None),
):
    pagina_inteira = _quer_pagina(request)
    processo = repo.por_id(s, usuario, processo_id)
    if processo is None:
        if pagina_inteira:
            return _de_volta_ao_quadro("erro", "Processo não encontrado.")
        return HTMLResponse("<div class='aviso aviso-erro'>Processo não encontrado.</div>", 404)

    destino = estado or ESTADO_PADRAO_DA_COLUNA.get(coluna, "EM_TRIAGEM")
    try:
        mover(
            s,
            processo,
            destino,
            usuario,
            comentario=comentario,
            inciso_art11=inciso_art11,
        )
    except (TransicaoInvalida, RequisitoDeSaidaNaoAtendido) as erro:
        motivos = getattr(erro, "motivos", None) or [str(erro)]
        if pagina_inteira:
            return _de_volta_ao_quadro("erro", " · ".join(motivos))
        return HTMLResponse(
            fragmento(
                request, "partes/erro_movimento.html", motivos=motivos, processo=processo
            ).body,
            status_code=422,
        )
    s.commit()
    if pagina_inteira:
        rotulo = dict(COLUNAS_KANBAN).get(coluna_de(processo.estado_tecnico), coluna)
        return _de_volta_ao_quadro(
            "mensagem", f"Processo {processo.nup} movido para “{rotulo}”."
        )
    return fragmento(
        request,
        "partes/cartao_kanban.html",
        r=resumir(s, processo),
        usuario=usuario,
        coluna=coluna_de(processo.estado_tecnico),
    )
