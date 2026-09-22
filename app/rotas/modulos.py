"""/modulos - o mapa do sistema - e /inicio, o despachante da porta da frente."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from app import modulos
from app.dependencias import UsuarioDep
from app.web import pagina

rotas = APIRouter(tags=["modulos"])


@rotas.get("/modulos")
def listar(request: Request, usuario: UsuarioDep):
    # sem exigir permissao: e a tela que explica onde ficam as coisas, e cada
    # item ja se esconde sozinho de quem nao pode ve-lo
    return pagina(request, "paginas/modulos.html", usuario=usuario)


@rotas.get("/inicio")
def inicio(usuario: UsuarioDep):
    """Onde o sistema comeca para QUEM entrou — nao e tela, e desvio.

    `/` e o painel de Processos SEI e exige `processo.ver`. Enquanto todo perfil
    tinha essa permissao isso passou; o `almoxarife_sesmt` foi o primeiro que nao
    tem, e para ele a primeira tela depois do login era um 403 — e a marca da
    lateral, que aponta para o comeco, era 403 em toda tela.

    Mover o painel de lugar resolveria tambem, e custaria mais: `/` e o caminho
    de sete telas de menu, de link no painel e de teste. O desvio deixa o painel
    onde esta e conserta o que estava errado, que era a porta da frente ser a
    tela de um modulo so.

    Nao exige permissao alem da sessao — como `/modulos`, e pelo mesmo motivo:
    quem chega aqui esta pedindo para ser levado a algum lugar, e negar seria
    negar a saida.
    """
    return RedirectResponse(modulos.primeira_tela(usuario), status_code=303)
