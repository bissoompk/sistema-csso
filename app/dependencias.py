"""Dependencias do FastAPI: sessao de banco, usuario atual e permissao.

Primeira das tres camadas de checagem (rota -> servico -> repositorio).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.banco import sessao as abrir_sessao
from app.servicos import autenticacao
from app.servicos.rbac import UsuarioAtual, carregar_usuario_atual


class RedirecionaParaLogin(Exception):
    def __init__(self, destino: str = "/login"):
        self.destino = destino


def obter_sessao(request: Request) -> Iterator[Session]:
    """A sessão da requisição. Dá **commit** quando a rota retorna normalmente.

    Quem desfaz é o `except` de `banco.sessao`, e ele só roda quando a rota
    LEVANTA exceção: o FastAPI joga a exceção na dependência (a pilha de saída
    fica por dentro do tratador) antes de o tratador montar a página de erro.
    Retorno normal, não — e recusa é retorno normal. Rota que escreveu alguma
    coisa e depois devolveu um aviso de recusa tem o que escreveu COMMITADO;
    foi assim que inscrever em turma lotada gravava o participante externo que
    nunca chegou a se inscrever.

    Por isso a recusa que já escreveu precisa chamar `s.rollback()` antes de
    devolver o aviso — é o que faz o `_recusar` de `rotas/turmas.py`. Decidir
    isso aqui não dá: em `POST /login` a recusa TEM de gravar. O contador de
    tentativas falhas é escrito por `servicos.autenticacao.autenticar` logo
    antes do `raise`, e desfazê-lo desligaria o bloqueio por força bruta. Só a
    rota sabe se o que ficou pendente é lixo da operação recusada ou o próprio
    registro da recusa.

    **Ela também se publica em `request.state` enquanto está aberta**, e some de
    lá ao fechar. Não é conveniência: é a única forma de quem não é rota — o
    sino do cabeçalho, montado em `web.pagina` — enxergar a sessão que já existe
    em vez de abrir uma segunda. Segunda sessão dentro da requisição nasce com
    `BEGIN IMMEDIATE` (RN-03) e disputa o lock de escrita com ESTA aqui: espera
    o `busy_timeout` inteiro e termina em "database is locked". O aviso está em
    `banco.py` desde sempre; o sino não o seguia, e custou ~5,6 s em toda tela.

    Vai em `request.state`, e não numa variável de módulo, porque o escopo certo
    é a requisição: duas requisições concorrentes têm cada uma o seu.
    """
    with abrir_sessao() as s:
        request.state.sessao_db = s
        try:
            yield s
        finally:
            # limpa ANTES de o `with` fechar a sessão: quem consultar
            # `request.state` depois (os tratadores de erro, que rodam com a
            # sessão da requisição já encerrada) precisa receber "não há" e
            # abrir a sua própria — que aí é segura, porque não há mais lock.
            request.state.sessao_db = None


SessaoDep = Annotated[Session, Depends(obter_sessao)]


def sessao_da_requisicao(request: Request) -> Session | None:
    """A sessão aberta desta requisição, ou `None` fora dela.

    `getattr` com padrão porque `request.state` levanta `AttributeError` para
    chave ausente — e "ausente" é o caso legítimo de toda tela renderizada por
    tratador de exceção.
    """
    return getattr(request.state, "sessao_db", None)


def usuario_opcional(request: Request, s: SessaoDep) -> UsuarioAtual | None:
    token = request.cookies.get(autenticacao.COOKIE_SESSAO)
    registro = autenticacao.sessao_valida(s, token)
    if registro is None:
        return None
    # O id da conta para a linha do registro de acesso. Vai daqui porque este e o
    # unico ponto do sistema em que o cookie vira identidade, e o middleware que
    # escreve a linha roda por fora das dependencias — ele nao tem sessao de
    # banco nem cookie resolvido. **Id numerico, e nunca `login`**: o `login` sai
    # da parte local do e-mail institucional, ou seja, tipicamente
    # `nome.sobrenome`, e nome de pessoa nao entra em arquivo de log (ROPA §6).
    request.state.conta_id = registro.usuario_id
    try:
        return carregar_usuario_atual(s, registro.usuario_id)
    except Exception:
        return None


UsuarioOpcional = Annotated["UsuarioAtual | None", Depends(usuario_opcional)]


def destino_de_login(request: Request) -> str:
    """O `/login?proximo=...` de quem chegou sem sessão — com a query e o motivo.

    Duas coisas que o `f"/login?proximo={request.url.path}"` de antes perdia:

    - **A query string.** Sessão expirada em `/processos?estado=X&pagina=3`
      voltava para `/processos`: o filtro que a pessoa tinha montado sumia no
      exato momento em que ela tinha acabado de entrar de novo para vê-lo.
      Por isso `proximo` vai codificado (`urlencode`): ele carrega `?` e `&`
      dentro de si, e cru quebraria a própria URL do login.
    - **O motivo.** Chegar ao login sem cookie é chegar; chegar COM cookie que
      não vale mais é a sessão ter expirado. A tela dizia a mesma coisa nos
      dois casos — nada —, e quem estava no meio de um POST (o editor do
      parecer aberto desde a manhã) recebia a tela de login e descobria depois
      que o envio não foi gravado. `motivo=sessao` e `motivo=envio` são o que
      a tela precisa para dizer isso por escrito.

    Num POST o `proximo` não é a rota do POST (voltar por GET a
    `/kanban/mover/3` é 405): é a tela de onde o formulário partiu, lida do
    `Referer` quando ele é um caminho deste mesmo sistema.
    """
    from urllib.parse import quote, urlencode, urlsplit

    if request.method in ("GET", "HEAD"):
        proximo = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    else:
        referer = urlsplit(request.headers.get("referer", ""))
        proprio = not referer.netloc or referer.netloc == request.headers.get("host", "")
        proximo = (
            referer.path + (f"?{referer.query}" if referer.query else "")
            if proprio and referer.path.startswith("/")
            else "/inicio"
        )
    parametros = {"proximo": proximo}
    if request.cookies.get(autenticacao.COOKIE_SESSAO):
        parametros["motivo"] = "sessao" if request.method in ("GET", "HEAD") else "envio"
    return "/login?" + urlencode(parametros, quote_via=quote)


def usuario_logado(request: Request, atual: UsuarioOpcional) -> UsuarioAtual:
    if atual is None:
        raise RedirecionaParaLogin(destino_de_login(request))
    return atual


UsuarioDep = Annotated[UsuarioAtual, Depends(usuario_logado)]


def exigir(*codigos: str):
    """Dependencia de rota: 403 duro quando falta permissao."""

    def _dependencia(usuario: UsuarioDep) -> UsuarioAtual:
        for codigo in codigos:
            if not usuario.pode(codigo):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Permissão necessária: {codigo}",
                )
        return usuario

    return Depends(_dependencia)


def redirecionar(destino: str, status_code: int = status.HTTP_303_SEE_OTHER):
    return RedirectResponse(destino, status_code=status_code)
