"""Infraestrutura de apresentacao: Jinja2, filtros e helpers de template."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

from fastapi import Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from jinja2 import pass_context
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import modulos
from app.config import RAIZ, RODAPE_INSTITUCIONAL, VERSAO, obter_config
from app.modelos.estados import COLUNAS_KANBAN, ROTULO_ESTADO_TELA
from app.seguranca import cookie_seguro
from app.servicos import (
    auditoria,
    autenticacao,
    datas_br,
    epi_estoque,
    identificacao,
)
from app.servicos.rbac import UsuarioAtual

templates = Jinja2Templates(directory=str(RAIZ / "app" / "templates"))

templates.env.filters["data"] = lambda d: datas_br.numerica(d) if d else ""
templates.env.filters["data_extenso"] = lambda d: datas_br.por_extenso(d) if d else ""
templates.env.filters["momento"] = lambda m: datas_br.local_formatado(m)
# O CNPJ e guardado so em digito (a coluna e String(14) e o servico normaliza),
# porque pontuacao nao e dado; ela e leitura. Quatorze digitos corridos numa
# celula sao exatamente o que ninguem confere contra a nota fiscal, entao a
# pontuacao volta AQUI, na saida — filtro e nao coluna, pelo mesmo motivo de
# `estado`: um caminho unico do dado ate a tela.
templates.env.filters["cnpj"] = epi_estoque.formatar_cnpj
# `ROTULO_ESTADO_TELA` e nao `ROTULO_ESTADO`: o mapa ASCII continua sendo o que
# a mensagem de servico e a descricao da trilha escrevem (o texto delas entra no
# digest da auditoria), e este filtro e o caminho unico do estado ate a tela —
# pilula, cartao do kanban, seletor de destino e filtro de lista.
templates.env.filters["estado"] = lambda e: ROTULO_ESTADO_TELA.get(e, e or "")
# O tipo de evento tambem e chave de banco, e pela mesma razao ganha filtro em
# vez de mapa por template: a trilha aparece em quatro telas de tres modulos.
templates.env.filters["evento"] = auditoria.rotulo_evento
templates.env.globals["VERSAO"] = VERSAO
templates.env.globals["RODAPE"] = RODAPE_INSTITUCIONAL
templates.env.globals["COLUNAS_KANBAN"] = COLUNAS_KANBAN
# O seletor da lateral precisa saber por onde se entra em cada módulo, e isso
# depende do usuário. Vai como global pelo mesmo motivo de COLUNAS_KANBAN: e
# constante de apresentacao, nao contexto de tela, e a decisao de qual e a
# primeira tela visivel tem de ser a mesma que `/inicio` toma — duas respostas
# para "onde comeca o modulo de EPI" divergiriam no primeiro item novo.
templates.env.globals["porta_de_entrada"] = modulos.porta_de_entrada

# A barra de forca da senha (primeiro acesso e troca) mede a politica de
# verdade, e nao uma nocao propria de "senha forte". Para isso ela precisa dos
# mesmos numeros e da mesma lista que `autenticacao.politica_de_senha` usa —
# reescrever qualquer um dos dois no JavaScript criaria uma segunda regra, que
# divergiria da primeira no dia em que alguem mexesse so num lado. Vai como
# global do Jinja pelo mesmo motivo de COLUNAS_KANBAN: e constante de
# apresentacao, nao contexto de tela, e nenhuma rota precisa lembrar de passar.
# A validacao que vale continua sendo a do servidor: aqui e so o aviso previo.
templates.env.globals["POLITICA_SENHA"] = {
    "minimo": autenticacao.TAMANHO_MINIMO_SENHA,
    "triviais": sorted(autenticacao.SENHAS_TRIVIAIS),
}


@pass_context
def _identificar(contexto, alvo, vazio: str = identificacao.SEM_SERVIDOR):
    """RN-19 no template sem a tela precisar carregar nada.

    E global de contexto, e nao parametro de `pagina()`, exatamente para a tela
    nova nao poder esquecer: `usuario` e `request` ja estao no contexto de toda
    pagina e de todo fragmento, entao o template escreve `identificar(x)` e
    pronto. Nao havendo `usuario` no contexto (tela de erro antes do login), a
    decisao cai no lado seguro — identificador opaco.
    """
    return identificacao.identificar(
        alvo,
        contexto.get("usuario"),
        identificacao.semente_de(contexto.get("request")),
        vazio=vazio,
    )


templates.env.globals["identificar"] = _identificar


@pass_context
def _texto_livre(contexto, texto, sobre=None, vazio: str = identificacao.SEM_SERVIDOR):
    """A irma de `identificar` para a frase que o sistema gravou.

    Global de contexto pelo mesmo motivo, e com mais razao: `descricao` de
    trilha e de pendencia e renderizada em sete telas de quatro modulos, e a que
    esquecesse de chamar seria justamente o vazamento — foi assim que o nome com
    SIAPE continuou saindo na ficha da requisicao depois de a RN-19 estar de pe
    em toda coluna de nome do sistema.
    """
    return identificacao.texto_livre(
        texto,
        contexto.get("usuario"),
        sobre=sobre,
        vazio=vazio,
    )


templates.env.globals["texto_livre"] = _texto_livre


@pass_context
def _nonce(contexto) -> str:
    """A marca do `<script>` embutido desta resposta.

    E global de contexto pelo mesmo motivo de `identificar`: `request` ja esta no
    contexto de toda pagina, entao o template escreve `nonce="{{ nonce() }}"` e
    pronto — nenhuma rota precisa lembrar de passar nada. Quem escreve o valor e
    o middleware `CabecalhosDeSeguranca`, uma vez por resposta, e o mesmo valor
    vai para o cabecalho `Content-Security-Policy`.

    Fora de requisicao com middleware (um `TemplateResponse` montado a mao num
    teste) devolve vazio: sem cabecalho de CSP nao ha o que casar, e uma marca
    inventada aqui daria a impressao de que o script esta autorizado quando o
    que o autoriza e o cabecalho.
    """
    estado = getattr(contexto.get("request"), "state", None)
    return getattr(estado, "nonce_csp", "") if estado is not None else ""


templates.env.globals["nonce"] = _nonce


def _sino(
    usuario: UsuarioAtual | None, s_requisicao: Session | None = None
) -> tuple[int, int]:
    """Contagem do sino: (abertas, atrasadas). Falha em silencio - o sino nunca
    pode derrubar a tela que ele decora.

    **Conta pela sessao da requisicao quando ela existe.** Antes o sino abria
    sempre uma sessao propria, e isso era o deadlock consigo mesmo que o
    `banco.py` avisa em `_transacao_imediata`: a sessao da requisicao ja tomou o
    lock de escrita com `BEGIN IMMEDIATE`, entao a segunda conexao esperava o
    `busy_timeout` inteiro e terminava em "database is locked" — capturado aqui
    pelo `except`. Resultado: **toda tela HTML demorava ~5,6 s a mais e o sino
    marcava zero**, sempre, para todo mundo. O silencio do `except` e que fez
    isso durar: o sino nao pode derrubar a tela, mas tambem nao pode mentir em
    silencio, e ele mentia.

    O `no_autoflush` e deliberado: contar pendencia e leitura de decoracao de
    cabecalho e nao pode arrastar para o banco um flush do que a rota ainda
    estava montando.
    """
    if usuario is None:
        return 0, 0
    try:
        from app.servicos.pendencias import contar_abertas

        if s_requisicao is not None:
            with s_requisicao.no_autoflush:
                return contar_abertas(s_requisicao, usuario)

        # fora de requisicao (tela de erro, com a sessao ja encerrada) nao ha
        # lock para disputar: abrir uma curta e o certo.
        from app.banco import sessao

        with sessao() as s:
            return contar_abertas(s, usuario)
    except Exception:  # pragma: no cover - defensivo
        return 0, 0


def pagina(
    request: Request,
    template: str,
    usuario: UsuarioAtual | None = None,
    **contexto: Any,
):
    from app.dependencias import sessao_da_requisicao
    from app.servicos.busca import pode_buscar
    from app.servicos.pendencias import pode_ver as pode_ver_pendencias

    cfg = obter_config()
    # o sino e um link para /pendencias: quem nao pode abrir a tela nao ganha o
    # link. Menu que oferece porta trancada e a mesma mentira do item de modulo.
    sino_visivel = pode_ver_pendencias(usuario)
    abertas, atrasadas = (
        _sino(usuario, sessao_da_requisicao(request)) if sino_visivel else (0, 0)
    )
    origem = request.cookies.get(modulos.COOKIE_MODULO)
    navegacao = modulos.navegacao(request.url.path, usuario, origem=origem)
    dados = {
        "request": request,
        "usuario": usuario,
        "avisos_config": cfg.inseguro,
        "ambiente": cfg.ambiente,
        "sino_visivel": sino_visivel,
        "sino_abertas": abertas,
        "sino_atrasadas": atrasadas,
        # a caixa do cabeçalho, pela mesma regra do sino: quem não abre nenhum
        # bloco de `/buscar` não ganha o campo. Vai daqui, e não de um
        # `usuario.pode(...)` no template, porque a lista de blocos cresce a cada
        # módulo — a caixa tem de acompanhar sozinha, sem ninguém lembrar.
        "busca_visivel": pode_buscar(usuario),
        **navegacao,
        **contexto,
    }
    resposta = templates.TemplateResponse(request, template, dados)
    # Toda tela de módulo anota de onde a pessoa está vindo, para que a lateral
    # não a expulse do módulo quando ela abre um cadastro da base. Só grava
    # quando muda: um `Set-Cookie` em toda resposta HTML atrapalharia cache
    # intermediário sem trocar informação nenhuma.
    lembrar = navegacao["modulo_a_lembrar"]
    if lembrar and lembrar != origem:
        resposta.set_cookie(
            modulos.COOKIE_MODULO,
            lembrar,
            httponly=True,
            samesite="lax",
            path="/",
            max_age=cfg.sessao_horas * 3600,
            # mesma decisao, mesma funcao: era aqui que o calculo do `Secure`
            # estava DUPLICADO, e duplicata e como o defeito de `/login` chegou
            # tambem ao cookie de modulo.
            secure=cookie_seguro(request),
        )
    return resposta


def marcar_download(resposta, request: Request):
    """Devolve ao navegador a marca que a página mandou junto com o pedido.

    Um download não dispara evento nenhum na página que o pediu: o "Gerar
    PDF" chamava o LibreOffice por até 180 s e o botão continuava clicável,
    sem sinal de que algo estava acontecendo. A página manda `?baixar=<token>`
    no clique; esta função grava o mesmo token num cookie que a página observa
    (`csso.js`, bloco 4) e, ao vê-lo, religa o botão. Sem `baixar` na query —
    link colado, teste, quem está sem JavaScript — não grava nada.

    `httponly=False` de propósito: o cookie existe para ser LIDO pela página.
    Não carrega informação nenhuma além do token que a própria página gerou,
    e morre em 60 s.
    """
    # a rota chamada direto (teste, ferramenta) nao tem requisicao: nada a marcar
    token = request.query_params.get("baixar", "") if request is not None else ""
    if token and re.fullmatch(r"[A-Za-z0-9]{1,64}", token):
        resposta.set_cookie(
            "csso_baixou", token, max_age=60, path="/", httponly=False, samesite="lax",
            secure=cookie_seguro(request),
        )
    return resposta


def fragmento(request: Request, template: str, **contexto: Any):
    return templates.TemplateResponse(request, template, {"request": request, **contexto})


# =====================================================================
# Paginacao de lista ja materializada
# =====================================================================
POR_PAGINA = 50


@dataclass(frozen=True)
class Recorte:
    """Uma pagina de uma lista, com a escala que a tela precisa dizer.

    O custo que isto resolve e o que esta medido no achado que originou a
    paginacao: `/servidores` com 975 linhas de seis colunas e um `title` por
    celula devolve ~1MB de HTML. E tamanho de PAGINA, nao de consulta — o sistema
    declara `lazy="selectin"` em 86 relacionamentos e as listas nao tem N+1.
    Cinquenta `<tr>` no lugar de 975 e a correcao inteira.

    **`pagina` E APARADA**, e essa e a diferenca para a paginacao cega de
    `/auditoria`. Aqui o total e conhecido, entao `?pagina=999` numa lista de
    tres paginas nao pode devolver uma tela vazia sem explicacao: ela volta para
    a pagina 3. Numero zero ou negativo volta para a 1 — sem isto o `itens[-100:]`
    do Python devolveria silenciosamente o FIM da lista, que e o pior resultado
    possivel: uma pagina plausivel e errada. Em `/auditoria` a contagem nao existe
    de proposito (contar doze mil eventos a cada abertura da trilha sairia caro),
    e por isso la a passagem do fim continua sendo uma pagina vazia com o aviso
    escrito na tela.
    """

    itens: list
    pagina: int
    por_pagina: int
    total: int


def _aparar(pagina, total: int, por_pagina: int) -> int:
    ultima = max(1, (total + por_pagina - 1) // por_pagina)
    return min(max(int(pagina or 1), 1), ultima)


def recortar(itens: list, pagina: int = 1, por_pagina: int = POR_PAGINA) -> Recorte:
    """Recorta uma lista JA MATERIALIZADA.

    **Existe porque nem todo filtro cabe na consulta.** `/servidores` casa a
    busca por `casa_a_busca`, que aplica a RN-19 linha a linha (o SIAPE acha para
    todo mundo, o nome so para quem ja podia le-lo); `/epis/fichas` filtra sobre
    uma linha derivada de tres consultas; `/laudos` casa por unidade e por
    subscritor, que sao relacionamentos. Empurrar o LIMIT para o banco antes
    desses filtros pagina o conjunto ERRADO — a pagina 1 sairia com quatro linhas
    porque as outras 46 foram recortadas depois.

    Onde o filtro CABE na consulta, o certo e `recortar_consulta`, abaixo: ali o
    banco devolve so as 50 linhas, e nao as 975.
    """
    total = len(itens)
    pagina = _aparar(pagina, total, por_pagina)
    inicio = (pagina - 1) * por_pagina
    return Recorte(itens[inicio : inicio + por_pagina], pagina, por_pagina, total)


def recortar_consulta(
    s: Session, consulta, pagina: int = 1, por_pagina: int = POR_PAGINA
) -> Recorte:
    """Recorta no BANCO: uma contagem e um LIMIT/OFFSET.

    Serve a lista cujo filtro inteiro ja esta na consulta — `/certificados` e o
    caso: situacao, treinamento e chave de validacao sao todos `where`. Ali
    materializar 975 registros para jogar fora 925 seria trabalho que o banco faz
    melhor.

    O `order_by(None)` na contagem nao e zelo: ordenar uma subconsulta de COUNT e
    trabalho puro (o SQLite chega a montar um indice temporario para isso) e nao
    muda o numero.
    """
    total = s.execute(
        select(func.count()).select_from(consulta.order_by(None).subquery())
    ).scalar_one()
    pagina = _aparar(pagina, total, por_pagina)
    itens = list(
        s.execute(consulta.limit(por_pagina).offset((pagina - 1) * por_pagina)).scalars()
    )
    return Recorte(itens, pagina, por_pagina, total)


def numero_da_pagina(request: Request) -> int:
    """O `?pagina=` da URL, ou 1.

    Sai de `query_params` e nao da assinatura da rota — em toda rota deste
    sistema `pagina` e o nome do ajudante que RENDERIZA a tela, e um parametro
    com esse nome o sombrearia dentro da funcao. E o mesmo motivo pelo qual
    `processos._filtro` ja lia a pagina dali.
    """
    bruto = request.query_params.get("pagina", "")
    return int(bruto) if bruto.isdigit() else 1


def salvar_com_diff(
    s,
    usuario: UsuarioAtual,
    modelo,
    registro_id: int,
    campos: dict,
    *,
    permissao: str,
    rotulo: str,
    volta: str,
):
    """Edição de catálogo: exige a permissão, grava e audita campo a campo.

    Vive aqui, e não em cada arquivo de rota, porque a regra é a mesma em todo
    catálogo do sistema — o que muda de um para outro é só a permissão exigida.
    Duplicar isto foi como o menu passou a mentir na 1.6.0.
    """
    usuario.exigir(permissao)
    registro = s.get(modelo, registro_id)
    if registro is None:
        return RedirectResponse(volta, status_code=303)
    antes = {campo: getattr(registro, campo) for campo in campos}
    for campo, valor in campos.items():
        setattr(registro, campo, valor)
    auditoria.registrar_diferencas(
        s,
        entidade=modelo.__tablename__,
        entidade_id=registro.id,
        antes=antes,
        depois={campo: getattr(registro, campo) for campo in campos},
        usuario=usuario,
    )
    s.commit()
    # codificado: `rotulo` é o nome do catálogo e chega ao `Location` dentro da
    # mensagem. Sem isso, um `&` no rótulo encerra a query string ali e o recado
    # some — a mesma correção que os helpers `_aviso` das rotas receberam.
    parametros = urlencode({"mensagem": f"{rotulo} atualizado."}, quote_via=quote)
    separador = "&" if "?" in volta else "?"
    return RedirectResponse(f"{volta}{separador}{parametros}", status_code=303)
