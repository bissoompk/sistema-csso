"""O que vale para TODA resposta: o `Secure` do cookie e os cabecalhos.

Vive fora de `web.py` porque `web.py` e apresentacao — Jinja, filtros, recorte
de lista — e o que esta aqui e transporte: decisoes que nao dependem de qual
tela esta sendo montada. As duas so se encontram num ponto, o `set_cookie` do
cookie de modulo em `web.pagina`, e e por isso que a funcao do cookie e
importada la em vez de reescrita — foi a reescrita que criou o defeito que este
modulo conserta.
"""

from __future__ import annotations

import logging
import secrets

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import obter_config

log = logging.getLogger("csso")

# As tres respostas aceitas em `CSSO_COOKIE_SEGURO`. Sao palavras e nao um
# booleano porque "auto" nao e nem sim nem nao: e "pergunte a requisicao".
COOKIE_AUTO = "auto"
COOKIE_SIM = "sim"
COOKIE_NAO = "nao"
COOKIE_VALORES = (COOKIE_AUTO, COOKIE_SIM, COOKIE_NAO)

# Aviso de descompasso e uma vez por processo, e nao uma por resposta: ele
# descreve a CONFIGURACAO, que nao muda enquanto o processo vive. Repetido a
# cada tela ele enterraria em ruido o proprio recado — e o recado e o que evita
# a manha inteira gasta num laco de login sem mensagem nenhuma.
_avisado: set[str] = set()


def _avisar_uma_vez(chave: str, mensagem: str, *args: object) -> None:
    if chave in _avisado:
        return
    _avisado.add(chave)
    log.warning(mensagem, *args)


def modo_do_cookie() -> str:
    """O valor efetivo de `CSSO_COOKIE_SEGURO`, ja normalizado.

    Valor torto cai em `auto` em vez de derrubar o boot: quem errou uma letra na
    variavel merece um aviso na tela, nao um sistema que nao sobe. O aviso sai
    em `Config.inseguro`, que aparece no /saude, no console do INICIAR.bat e na
    casca de toda tela.
    """
    bruto = (obter_config().cookie_seguro or "").strip().lower()
    return bruto if bruto in COOKIE_VALORES else COOKIE_AUTO


def cookie_seguro(request: Request) -> bool:
    """Decide o atributo `Secure` do cookie pela CONEXAO, nunca pelo endereco
    de ligacao.

    Ate a 1.31.0 isto era `cfg.host not in ("127.0.0.1", "localhost")`, e o
    endereco de ligacao **nao sabe** se a conexao e segura. Com
    `CSSO_HOST=0.0.0.0` — que e o que o manual mandava fazer, dizendo que
    nenhuma linha de codigo mudava — o cookie saia `Secure` sem haver TLS: o
    navegador o recebe, nao o devolve por HTTP, e a pessoa volta para a tela de
    login sem mensagem nenhuma. Laco de login, ninguem entra. E errava tambem no
    outro sentido: atras de um proxy que termina TLS na mesma maquina, `cfg.host`
    continua `127.0.0.1` e o cookie saia SEM `Secure`, que e a configuracao
    certa perdendo a protecao que merecia.

    Quem sabe se a conexao e segura e a requisicao. `request.url.scheme` e
    `https` quando o TLS termina aqui, e tambem quando termina num proxy que o
    uvicorn confia — o `ProxyHeadersMiddleware` reescreve o esquema a partir do
    `X-Forwarded-Proto`, e por isso o `X-Forwarded-Proto` nao e lido a mao aqui:
    duas leituras do mesmo cabecalho divergiriam no dia em que uma das duas
    ganhasse uma condicao a mais.

    **A saida explicita existe porque o automatico tem um ponto cego**: proxy em
    OUTRA maquina, com o `forwarded_allow_ips` do uvicorn ainda em `127.0.0.1`,
    faz o `X-Forwarded-Proto` ser descartado e o esquema chegar aqui como `http`
    mesmo havendo TLS de verdade la na frente. Nesse dia, `CSSO_COOKIE_SEGURO=sim`
    e a resposta — e ela e uma declaracao de quem instalou, que e quem sabe.

    **E o padrao falha para o lado que deixa entrar.** `auto` sobre HTTP devolve
    `False`: numa rede de setor, cookie sem `Secure` e um risco declarado e
    contornavel (o TLS no proxy o fecha); cookie `Secure` sem TLS e um sistema
    que ninguem abre e que nao diz por que. Quem prefere o outro lado escreve
    `CSSO_COOKIE_SEGURO=sim` — e recebe, tanto no /saude quanto no log, a frase
    que descreve o laco antes de ele acontecer.
    """
    modo = modo_do_cookie()
    esquema = request.url.scheme
    if modo == COOKIE_SIM:
        if esquema != "https":
            _avisar_uma_vez(
                "sim-sem-tls",
                "CSSO_COOKIE_SEGURO=sim, mas esta requisicao chegou por %s. O "
                "cookie sai Secure e o navegador nao o devolve por HTTP: o "
                "login vai entrar em laco. Ou ponha TLS a frente, ou volte a "
                "variavel para auto.",
                esquema,
            )
        return True
    if modo == COOKIE_NAO:
        if esquema == "https":
            _avisar_uma_vez(
                "nao-com-tls",
                "CSSO_COOKIE_SEGURO=nao numa conexao https: a sessao viaja sem "
                "o atributo Secure e um pedido acidental em http:// a entrega em "
                "claro. Volte a variavel para auto.",
            )
        return False
    return esquema == "https"


# =====================================================================
# Cabecalhos de seguranca
# =====================================================================
# A CSP e barata NESTE sistema por um motivo medido: nao ha CDN nenhum. Todo
# estatico e local (`app/estaticos/`: htmx.min.js, csso.css e quatro .woff2),
# nao ha nenhuma URI `data:` em folha nem em template, e nao ha bloco `<style>`.
# Entao `default-src 'self'` nao quebra recurso nenhum.
#
# O que atrapalhava, contado antes de declarar: 7 `<script>` embutidos, 3
# atributos `on*=`, 39 atributos `style="..."` — e uma quarta coisa, que so
# apareceu porque se foi medir em vez de estimar: **o proprio HTMX injeta um
# `<style>`** ao carregar (`includeIndicatorStyles`, ligado por padrao). Era o
# unico recurso que a politica de fato quebrava, e ele nao pintava nada aqui:
# `hx-indicator` nao aparece em atributo nenhum dos templates e `csso.css` nao
# tem regra de `.htmx-indicator`. Desligado por `<meta name="htmx-config">` no
# `base.html`, com o argumento e o teste ao lado.
#
#   * Os 7 scripts embutidos ganharam `nonce` (a marca por resposta, abaixo), e
#     por isso `script-src` NAO tem `'unsafe-inline'`. Nonce e unsafe-inline nao
#     convivem: havendo nonce, o navegador ignora o unsafe-inline — o que e
#     exatamente o que se quer, porque script injetado nao adivinha a marca do
#     minuto.
#   * Os 3 `on*=` sairam dos templates para tratadores delegados no `base.html`.
#     Atributo de evento nao e alcancado por nonce: ou ele sai, ou a politica
#     precisaria de `script-src-attr 'unsafe-inline'`, que e a porta pela qual a
#     injecao em atributo passa. Sairam.
#   * Os 39 `style="..."` ficam. **Este e o unico afrouxamento, e e no estilo.**
#     Reescrever 39 atributos em classes utilitarias e mexer em 20 telas para
#     fechar uma superficie que, sem `script-src` frouxo, rende exfiltracao por
#     seletor e nao execucao de codigo — e trabalho grande para o ganho menor da
#     lista. O afrouxamento fica cercado: `style-src-elem 'self'` recusa
#     `<style>` embutido e folha de fora (dos quais ha zero hoje), e o
#     `'unsafe-inline'` sobra so para o atributo. A forma esta escrita nesta
#     ordem de proposito: navegador que nao conhece `style-src-elem` cai em
#     `style-src`, onde o `'unsafe-inline'` ainda esta, e a tela nao desmonta —
#     o inverso (`style-src 'self'` + `style-src-attr 'unsafe-inline'`) protege
#     igual no navegador novo e apaga as 39 larguras de barra no velho.
#
# `frame-ancestors 'none'` e o controle de enquadramento que vale; o
# `X-Frame-Options: DENY` vai junto porque e o que navegador velho entende, e as
# duas linhas dizem a mesma coisa.
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'nonce-{nonce}'; "
    "style-src 'self' 'unsafe-inline'; "
    "style-src-elem 'self'; "
    "img-src 'self'; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "object-src 'none'"
)

# `same-origin` e nao `strict-origin-when-cross-origin`: a URL deste sistema
# carrega o `{id}` do processo e, nas telas de busca, o que a pessoa digitou no
# filtro — que pode ser um nome. Mandar so a origem para fora ainda contaria a
# terceiros que a UFVJM opera este sistema; `same-origin` nao manda nada.
_REFERRER = "same-origin"

# Um ano, e so sobre https. Emitido em http o cabecalho e ignorado pelo
# navegador, mas emiti-lo assim mesmo seria escrever no codigo uma promessa que
# a instalacao nao cumpre — e no dia em que houvesse TLS ninguem saberia se ele
# valia por decisao ou por descuido. Sem `includeSubDomains` e sem `preload`:
# os dois comprometem nomes que nao sao deste sistema, e essa decisao e do TI.
_HSTS = "max-age=31536000"


def cabecalhos(nonce: str, https: bool) -> tuple[tuple[str, str], ...]:
    fixos = (
        ("content-security-policy", _CSP.format(nonce=nonce)),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", _REFERRER),
        ("x-frame-options", "DENY"),
    )
    return fixos + ((("strict-transport-security", _HSTS),) if https else ())


class CabecalhosDeSeguranca:
    """Middleware ASGI cru, e nao `BaseHTTPMiddleware`.

    `BaseHTTPMiddleware` monta a resposta inteira num par de tarefas para poder
    entregar um objeto `Response` ao tratador — e este sistema devolve
    `FileResponse` de anexo e de exportacao, que sao justamente o que nao se quer
    bufferizar. Aqui so se mexe no `http.response.start`, que e a unica mensagem
    onde cabecalho existe; o corpo passa reto.

    `setdefault` e nao atribuicao: rota que um dia precise de uma politica propria
    (uma tela de impressao, um relatorio embutido) escreve o cabecalho dela e
    este middleware nao o sobrescreve.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # A marca do nonce vive no estado da requisicao porque quem a escreve no
        # HTML e o Jinja, la em `web.nonce()`, e o Jinja so alcanca o `request`.
        # `setdefault` porque sob uvicorn o `state` ja chega preenchido com uma
        # copia do estado do lifespan.
        nonce = secrets.token_urlsafe(16)
        scope.setdefault("state", {})["nonce_csp"] = nonce
        https = scope.get("scheme") == "https"

        async def enviar(mensagem: Message) -> None:
            if mensagem["type"] == "http.response.start":
                cabecalho = MutableHeaders(scope=mensagem)
                for nome, valor in cabecalhos(nonce, https):
                    cabecalho.setdefault(nome, valor)
            await send(mensagem)

        await self.app(scope, receive, enviar)
