"""Aplicacao FastAPI do Sistema CSSO."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

from app.banco import criar_esquema, integridade_ok, migrar, obter_engine, sessao
from app.config import RAIZ, VERSAO, obter_config
from app.dependencias import RedirecionaParaLogin, usuario_opcional
from app.registro_acesso import RegistroDeAcesso, configurar_arquivo
from app.seguranca import CabecalhosDeSeguranca
from app.rotas import (
    adicionais as rota_adicionais,
    api as rota_api,
    aplicativo as rota_aplicativo,
    auditoria as rota_auditoria,
    autenticacao as rota_autenticacao,
    busca as rota_busca,
    catalogos as rota_catalogos,
    celular as rota_celular,
    certificados as rota_certificados,
    configuracao as rota_configuracao,
    demandas as rota_demandas,
    epi_estoque as rota_epi_estoque,
    epi_fichas as rota_epi_fichas,
    epi_indicadores as rota_epi_indicadores,
    epi_requisicoes as rota_epi_requisicoes,
    epis as rota_epis,
    importacao as rota_importacao,
    kanban as rota_kanban,
    laudos as rota_laudos,
    modulos as rota_modulos,
    painel as rota_painel,
    pareceres as rota_pareceres,
    processos as rota_processos,
    relatorios as rota_relatorios,
    saude as rota_saude,
    servidores as rota_servidores,
    treinamentos as rota_treinamentos,
    turmas as rota_turmas,
    usuarios as rota_usuarios,
    validacao as rota_validacao,
)
from app.rotas.api import RecusaDaApi, recusa_em_json
from app.servicos.autenticacao import expurgar_sessoes
from app.servicos.rbac import PermissaoNegada
from app.servicos.sementes import semear
from app.web import pagina

log = logging.getLogger("csso")


@asynccontextmanager
async def ciclo_de_vida(app: FastAPI):
    cfg = obter_config()
    cfg.preparar_diretorios()
    # Antes do engine e antes das seeds: o registro de acesso tem de existir
    # para a PRIMEIRA requisicao, e nao a partir da segunda. Quem anuncia o
    # caminho ao operador e o `ferramentas/servidor.py`, que e a janela que ele
    # olha — aqui so se instala.
    configurar_arquivo(cfg)
    engine = obter_engine()
    try:
        migrar()
    except Exception as erro:  # pragma: no cover - fallback de bootstrap local
        log.warning("Alembic indisponível (%s); criando o esquema direto.", erro)
        criar_esquema(engine)
    # seeds sao idempotentes: catalogos, perfis e permissoes ficam sempre em dia
    with sessao() as s:
        semear(s)
        # a retencao de `sessao` tambem roda a cada login; aqui cobre a
        # instalacao que ficou meses sem ninguem entrar
        expurgar_sessoes(s)

    ok, detalhe = integridade_ok(engine)
    if not ok:  # pragma: no cover
        log.error("PRAGMA integrity_check falhou: %s", detalhe)
    for aviso in cfg.inseguro:
        log.warning("configuracao: %s", aviso)
    yield


def usuario_do_erro(request: Request):
    """Quem está logado, para a tela de erro sair com a casca.

    Tratador de exceção do FastAPI não recebe dependência injetada — não há
    `UsuarioDep` aqui —, então a sessão do cookie é resolvida à mão, com a mesma
    função que a dependência usa. A sessão de banco da requisição já foi fechada
    quando o tratador roda (a pilha de saída das dependências fica por dentro
    dele), por isso abre-se uma nova, curta e só de leitura — o mesmo que o sino
    já faz em `web._sino`.

    Falhar aqui devolve `None` e a tela sai sem casca. Sem casca é ruim; 500
    dentro do tratador de 404 é pior, e o caso mais comum de falha é o legítimo:
    erro antes de logar, quando não há sessão nenhuma para resolver.
    """
    try:
        with sessao() as s:
            return usuario_opcional(request, s)
    except Exception:  # pragma: no cover - defensivo
        log.warning("tela de erro sem casca: falhou resolver o usuário", exc_info=True)
        return None


def criar_app() -> FastAPI:
    app = FastAPI(
        title="Sistema CSSO",
        version=VERSAO,
        docs_url=None,
        redoc_url=None,
        lifespan=ciclo_de_vida,
    )
    # A ordem importa e e o inverso da leitura: o ULTIMO `add_middleware` fica
    # por FORA. O registro de acesso tem de ser o mais externo para medir a
    # requisicao inteira e ver o status que de fato saiu — inclusive o 403 e o
    # 404 que os tratadores de excecao la embaixo montam.
    app.add_middleware(CabecalhosDeSeguranca)
    app.add_middleware(RegistroDeAcesso)
    app.mount(
        "/estaticos",
        StaticFiles(directory=str(RAIZ / "app" / "estaticos")),
        name="estaticos",
    )

    for modulo in (
        rota_saude,
        rota_autenticacao,
        rota_api,
        rota_aplicativo,
        rota_celular,
        # a segunda rota sem sessao do sistema, e a excecao esta declarada no
        # docstring dela e conferida por `test_so_estas_rotas_abrem_sem_sessao`
        rota_validacao,
        rota_painel,
        rota_modulos,
        rota_busca,
        rota_kanban,
        rota_processos,
        rota_pareceres,
        rota_laudos,
        rota_adicionais,
        rota_servidores,
        rota_catalogos,
        rota_treinamentos,
        rota_turmas,
        rota_certificados,
        rota_epis,
        rota_epi_fichas,
        rota_epi_estoque,
        rota_epi_requisicoes,
        rota_epi_indicadores,
        rota_demandas,
        rota_usuarios,
        rota_relatorios,
        rota_auditoria,
        rota_configuracao,
        rota_importacao,
    ):
        app.include_router(modulo.rotas)

    def _pede_json(request: Request) -> bool:
        """`/api/` responde JSON sempre — o cliente de API nao segue um 303
        para ler a tela de login, e um 403 em HTML e ruido para quem fez
        `fetch`."""
        return request.url.path.startswith("/api/")

    @app.exception_handler(RedirecionaParaLogin)
    async def _login(request: Request, erro: RedirecionaParaLogin):
        if _pede_json(request):
            return JSONResponse(
                {"erro": "Sessão ausente ou expirada: entre pelo /login.", "motivos": []},
                status_code=401,
            )
        return RedirectResponse(erro.destino, status_code=303)

    @app.exception_handler(RecusaDaApi)
    async def _recusa_da_api(request: Request, erro: RecusaDaApi):
        return recusa_em_json(erro)

    def _tela_de_erro(request: Request, titulo: str, detalhe: str, codigo, status: int):
        """A tela de erro é tela: sai com a lateral, o menu e o caminho de volta.

        Sem `usuario=` o `base.html` não desenha casca nenhuma — o usuário lia o
        motivo do erro e só saía dali pelo botão do navegador.
        """
        return HTMLResponse(
            pagina(
                request,
                "paginas/erro.html",
                usuario=usuario_do_erro(request),
                titulo=titulo,
                detalhe=detalhe,
                codigo=codigo,
            ).body,
            status_code=status,
        )

    # O 422 do FastAPI — `Form(...)` obrigatório que não veio — chegava à tela
    # como um despejo de validação em JSON, sem casca e sem saída. O sistema já
    # sabe o conserto caso a caso (`Form("")` e validar no serviço, comentado em
    # três rotas), mas são 115 `Form(...)` e a próxima rota nasce com o padrão
    # antigo. Este tratador é a rede embaixo de todos eles: quem pediu HTML
    # recebe a tela de erro com a lateral, o nome dos campos que faltaram em
    # português e o caminho de volta. Quem não pediu HTML continua recebendo o
    # JSON — é o contrato de quem chama a API direto, e dos testes.
    @app.exception_handler(RequestValidationError)
    async def _formulario_incompleto(request: Request, erro: RequestValidationError):
        if _pede_json(request):
            # o mesmo formato de `Erro` das outras recusas da API: um formato so
            campos = []
            for problema in erro.errors():
                loc = [str(parte) for parte in problema.get("loc", ()) if parte != "body"]
                campos.append(f"{' › '.join(loc) or 'corpo'}: {problema.get('msg', '')}")
            return JSONResponse(
                {"erro": "O envio não tem a forma esperada.", "motivos": campos},
                status_code=422,
            )
        quer_html = "text/html" in (request.headers.get("accept") or "")
        if not quer_html:
            return await request_validation_exception_handler(request, erro)
        campos = []
        for problema in erro.errors():
            loc = [str(parte) for parte in problema.get("loc", ()) if parte not in ("body", "query", "path")]
            if loc:
                campos.append(" › ".join(loc))
        lista = ", ".join(dict.fromkeys(campos)) or "um campo obrigatório"
        return _tela_de_erro(
            request,
            "422 — formulário incompleto",
            f"O envio chegou sem {lista}. Volte, preencha o que falta e envie de novo — "
            "nada foi gravado.",
            None,
            422,
        )

    @app.exception_handler(PermissaoNegada)
    async def _negado(request: Request, erro: PermissaoNegada):
        if _pede_json(request):
            return JSONResponse(
                {"erro": str(erro), "motivos": [f"permissão exigida: {erro.codigo}"]},
                status_code=403,
            )
        return _tela_de_erro(
            request, "403 — acesso negado", str(erro), erro.codigo, 403
        )

    # Registrado na HTTPException do Starlette, não na do FastAPI: o 404 de URL
    # inexistente — o 404 que o usuário de fato encontra — é levantado pelo
    # roteador como a do Starlette, que não é subclasse da outra. Registrado na
    # do FastAPI, como estava, este tratador nunca rodava e a "tela de 404" era
    # código morto: o navegador recebia `{"detail":"Not Found"}`.
    @app.exception_handler(HTTPException)
    async def _http(request: Request, erro: HTTPException):
        quer_html = "text/html" in (request.headers.get("accept") or "")
        if quer_html and erro.status_code in (401, 403):
            return _tela_de_erro(
                request,
                f"{erro.status_code} — acesso negado",
                str(erro.detail),
                None,
                erro.status_code,
            )
        if quer_html and erro.status_code == 404:
            return _tela_de_erro(
                request, "404 — não encontrado", str(erro.detail), None, 404
            )
        # Quem não pediu HTML recebe o JSON de sempre. Relançar aqui faria o
        # tratador ser chamado de novo pela camada de fora e terminar em 500.
        return await http_exception_handler(request, erro)

    return app


app = criar_app()
