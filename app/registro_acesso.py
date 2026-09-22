"""Registro de acesso HTTP: quem bateu na porta, de onde, quando e com o que
saiu de la.

**Nao substitui a trilha de auditoria, e nao e substituido por ela.**
`historico_evento` e `acesso_dado_sensivel` respondem "quem fez o que no
sistema" e "quem leu o dado de quem" — ficam dentro do banco, sob o mesmo RBAC e
sob a mesma cifra de backup, e por isso podem carregar identificacao nominal.
Este arquivo aqui responde outra pergunta, que numa maquina so nao precisava ser
feita: **quem bateu na porta**. Uma varredura de `/anexos/1`, `/anexos/2`,
`/anexos/3`... nao e ato de negocio nenhum e nao deixava rastro em lugar nenhum.

E ele vive **em disco, fora de todo controle do sistema**: quem administra a
maquina le, o backup do TI copia, um anexo de e-mail o carrega. Por isso a regra
do que pode entrar aqui e mais estreita que a da trilha, e ela e do
`docs/ROPA.md` §6 — nao e preferencia de quem escreveu.

NUNCA entram, e cada um por um motivo proprio:

  * **nome de servidor** — e o dado que a RN-19 esconde na tela; escreve-lo aqui
    refaz em texto puro o que a supressao custou a construir;
  * **matricula SIAPE** — e a chave de identificacao do titular;
  * **conteudo de parecer, recomendacao, fundamentacao, rotina de trabalho** —
    e a caracterizacao da exposicao a agente nocivo, e e onde dado de saude entra
    por engano;
  * **corpo da requisicao** — contem a senha em `/login`;
  * **query string** — contem o filtro digitado nas telas de busca, que e o nome;
  * **caminho concreto da requisicao** — veja abaixo, e e a decisao que custou
    mais argumento.

Entram: identificador de correlacao, endereco de origem, id numerico da conta,
metodo, **forma da rota**, status e duracao.

**Por que a forma da rota, e nao o caminho.** `/servidores/12` e identificador:
com a tabela na mao, o 12 e uma pessoa, e o par (IP, 12) num arquivo de texto e
exatamente o cruzamento que o `SRV-xxxx` por sessao existe para impedir. O que
se registra e `/servidores/{servidor_id}` — que e a linha que o §L-2 do
levantamento autoriza, "o caminho da rota com o `{id}` **nao** substituido".

E a pergunta seguinte e a boa: perde-se a investigacao? Nao, e por duas razoes.
A primeira e que a leitura de dado nominal ja e registrada com o titular, com a
finalidade e sob RBAC, em `acesso_dado_sensivel` — e la o "sobre quem" esta no
lugar certo. A segunda e que **a varredura nao precisa dos ids para aparecer**:
quatro mil linhas de `/anexos/{anexo_id}` da mesma conta e do mesmo IP em dois
minutos e um desenho inconfundivel, e o `403`/`200` de cada uma diz o que ela
levou. O que o log perde e a capacidade de reconstruir a lista de quem foi
lido — que e precisamente a capacidade que ele nao deve ter.

**Caminho sem rota (404) sai como `-`.** URL que nao casou com rota nenhuma e
texto livre escolhido por quem chamou: bastaria pedir
`/fulano-de-tal-tem-insalubridade` para plantar uma frase nominal dentro do
arquivo que o ROPA governa. O sinal que importa — muitos 404 da mesma origem —
sobrevive inteiro sem o texto.

**Retencao: 90 dias, o mesmo prazo de `sessao`.** Nao e coincidencia e nao e
palpite: `docs/POLITICA_RETENCAO.md` da 90 dias a `sessao` por causa do **IP**
que a tabela guarda, e este arquivo guarda o mesmo IP. Dois prazos diferentes
para o mesmo dado pessoal na mesma instalacao seria uma politica que se
contradiz. E aqui o prazo e **cumprido pelo mecanismo**, nao declarado: a
rotacao e diaria e o `backupCount` apaga o 91o arquivo sozinho — que e a
diferenca, numa fiscalizacao, entre uma politica escrita e uma politica
cumprida. A de `sessao` continua so escrita (§I-5 do levantamento).
"""

from __future__ import annotations

import logging
import logging.handlers
import secrets
import time
from pathlib import Path

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import obter_config

log = logging.getLogger("csso.acesso")

ARQUIVO = "acesso.log"

# Sem milissegundo e sem virgula: o campo de data ja e o mais largo da linha, e
# a duracao — que e o numero pelo qual se procura — vem no fim em ms.
_FORMATO = logging.Formatter(
    "%(asctime)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S%z"
)


def configurar_arquivo(cfg=None) -> Path | None:
    """Instala o arquivo com rotacao diaria. Idempotente.

    Chamada no `lifespan` da aplicacao, e nao no `INICIAR.bat`, porque o log tem
    de existir por qualquer caminho que suba a aplicacao — inclusive o dia em
    que o TI trocar o `.bat` por um servico do Windows chamando o uvicorn direto.

    Idempotente porque a suite constroi uma aplicacao por teste: sem a conferencia
    seriam centenas de descritores abertos no mesmo arquivo, e cada linha sairia
    repetida uma vez por aplicacao ja construida.

    `propagate` fica ligado de proposito. Em producao a raiz nao tem tratador
    nenhum e nada se duplica; em teste e o que permite `caplog` ler a linha sem
    o teste ter de saber onde o arquivo mora.
    """
    cfg = cfg or obter_config()
    if not cfg.log_acesso:
        return None
    if any(
        isinstance(h, logging.handlers.TimedRotatingFileHandler) for h in log.handlers
    ):
        return None

    destino = cfg.caminho(cfg.dir_logs)
    destino.mkdir(parents=True, exist_ok=True)
    alvo = destino / ARQUIVO

    tratador = logging.handlers.TimedRotatingFileHandler(
        alvo,
        when="midnight",
        backupCount=max(1, cfg.log_retencao_dias),
        encoding="utf-8",
        delay=True,
    )
    tratador.setFormatter(_FORMATO)
    tratador.setLevel(logging.INFO)
    log.addHandler(tratador)
    log.setLevel(logging.INFO)
    return alvo


def forma_da_rota(scope: Scope) -> str:
    """A rota com o `{id}` no lugar do numero, ou `-` quando nao casou nenhuma.

    `path_format` e o que o Starlette guarda ao compilar a rota, e existe tanto
    em `Route` quanto em `Mount` — e por isso todo `/estaticos/...` sai como
    `/estaticos`, que e o agrupamento certo: ninguem investiga qual `.woff2` foi
    pedido.
    """
    rota = scope.get("route")
    return getattr(rota, "path_format", None) or "-"


def _linha(scope: Scope, estado: dict, status: int, duracao_ms: int) -> None:
    cliente = scope.get("client")
    log.info(
        "req=%s ip=%s conta=%s %s %s %s %dms",
        estado.get("id_requisicao", "-"),
        cliente[0] if cliente else "-",
        estado.get("conta_id", "-"),
        scope.get("method", "-"),
        forma_da_rota(scope),
        status or 0,
        duracao_ms,
    )


class RegistroDeAcesso:
    """Middleware ASGI cru, pelo mesmo motivo do de cabecalhos: o corpo da
    resposta nao pode ser bufferizado para se medir o tempo dela.

    Fica por FORA do middleware de cabecalhos (e o ultimo `add_middleware`, que
    e o mais externo) para que a duracao medida seja a da requisicao inteira e o
    status registrado seja o que de fato saiu — inclusive o 403 e o 404 que os
    tratadores de excecao montam.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        estado = scope.setdefault("state", {})
        # Oito digitos hexadecimais: o bastante para nao repetir dentro de um dia
        # de trabalho deste setor, e curto o bastante para alguem ditar por
        # telefone quando estiver comparando duas linhas.
        estado["id_requisicao"] = secrets.token_hex(4)
        visto = {"status": 0}
        inicio = time.perf_counter()

        async def enviar(mensagem: Message) -> None:
            if mensagem["type"] == "http.response.start":
                visto["status"] = mensagem["status"]
            await send(mensagem)

        try:
            await self.app(scope, receive, enviar)
        finally:
            # `finally` e nao depois da chamada: requisicao que estoura sem
            # resposta e justamente a que mais interessa a uma investigacao, e
            # ela sairia do arquivo se a linha dependesse do retorno normal.
            #
            # `or 500` porque a excecao nao tratada sobe alem deste middleware:
            # quem a converte em resposta e o `ServerErrorMiddleware`, que o
            # Starlette monta POR FORA de todo middleware de usuario. Daqui nao
            # se ve o `http.response.start` dele — mas o que o navegador recebe
            # e 500, e uma linha dizendo `0` obrigaria quem investiga a saber
            # disto para nao ler "nao houve resposta".
            _linha(
                scope,
                estado,
                visto["status"] or 500,
                int((time.perf_counter() - inicio) * 1000),
            )
