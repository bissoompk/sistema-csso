"""/demandas — o que chegou por e-mail ou no balcão e ainda não é processo SEI.

A tela é da **base compartilhada**, ao lado de Pendências, e não de Processos
SEI: a demanda é transversal — pode ser sobre adicional, EPI, treinamento ou
sobre nada disso. Quem diz isso é `app/modulos.py`, onde ela entra na tupla
`BASE`, e é de lá que saem os dois primeiros níveis da trilha.

A regra de negócio inteira mora em `servicos/demandas.py`; aqui só chegam a
leitura da fila, a montagem da tela e a tradução do que veio do formulário —
inclusive a única tradução que tem substância, que é resolver o NUP digitado
para o `processo.id` real do desfecho `VIROU_PROCESSO`.
"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    Atribuicao,
    Demanda,
    Perfil,
    Permissao,
    Processo,
    Servidor,
    UnidadeUorg,
    Usuario,
)
from app.modelos.estados import (
    CANAIS_DEMANDA,
    DESFECHOS_DEMANDA,
    ROTULO_CANAL_DEMANDA,
    ROTULO_DEMANDA,
    ROTULO_DESFECHO_DEMANDA,
    TransicaoInvalida,
)
from app.servicos import demandas as servico
from app.servicos import nup as servico_nup
from app.servicos.textos import TextoProibido
from app.web import numero_da_pagina, pagina, recortar

rotas = APIRouter(tags=["demandas"])

# As fichas de filtro da fila, na ordem da máquina. "Em aberto" vem primeiro e é
# o padrão da tela: é a pergunta de quem abre a lista na segunda-feira, e uma
# tela que abrisse mostrando as encerradas junto responderia a pergunta errada
# com o dobro das linhas.
VISOES: tuple[tuple[str, str], ...] = (
    ("", "Em aberto"),
    ("ABERTA", "Abertas"),
    ("EM_ANDAMENTO", "Em andamento"),
    ("ENCERRADA", "Encerradas"),
)


def _voltar(destino: str, mensagem: str | None = None, erro: str | None = None):
    """Redireciona com o recado. Codificado, pelo mesmo motivo de `salvar_com_diff`:
    um `&` no meio da mensagem encerraria a query string ali e o recado sumiria."""
    parametros = {k: v for k, v in {"mensagem": mensagem, "erro": erro}.items() if v}
    sufixo = f"?{urlencode(parametros, quote_via=quote)}" if parametros else ""
    return RedirectResponse(destino + sufixo, status_code=303)


def _pessoas(s) -> list[Usuario]:
    """Quem pode receber uma demanda: conta ativa que ABRE a tela de demandas.

    O filtro é por `demanda.ver`, e não por conta ativa, pelo motivo que o
    `almoxarife_sesmt` ensinou em `rbac.py`: **tarefa com dono que o dono não
    consegue abrir é lista que ninguém lê**. Atribuir a demanda ao administrador
    de TI — que por decisão de projeto não vê conteúdo técnico — lhe daria uma
    linha no sino, o nome em `responsavel_id` e 403 no link dela.

    O filtro NÃO é por `demanda.registrar`, e a diferença é deliberada: quem lê
    a fila pode ser dono do acompanhamento (o coordenador, o superintendente,
    o auditor), e quem escreve o desfecho pode ser outra pessoa do setor.
    Estreitar aqui tiraria do seletor justamente quem costuma responder pelo
    caso sem digitar nada.

    A vigência da atribuição entra na consulta porque perfil concedido com
    `vigencia_fim` no passado não vale mais — é a mesma conta que
    `carregar_usuario_atual` faz a cada requisição, e reescrevê-la em Python
    aqui custaria uma consulta por conta só para desenhar um `<select>`.
    """
    hoje = date.today()
    com_a_permissao = (
        select(Atribuicao.usuario_id)
        .join(Perfil, Perfil.id == Atribuicao.perfil_id)
        .where(
            Perfil.ativo.is_(True),
            Perfil.permissoes.any(Permissao.codigo == servico.PERMISSAO_VER),
            Atribuicao.vigencia_inicio <= hoje,
            (Atribuicao.vigencia_fim.is_(None)) | (Atribuicao.vigencia_fim >= hoje),
        )
    )
    return list(
        s.execute(
            select(Usuario)
            .where(Usuario.ativo.is_(True), Usuario.id.in_(com_a_permissao))
            .order_by(Usuario.nome)
        ).scalars()
    )


def _tela_lista(
    request: Request,
    s,
    usuario,
    estado: str = "",
    minhas: str = "",
    q: str = "",
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A fila, com o popup de cadastro em branco ou com o que foi digitado.

    Espelha `laudos._tela_lista`: `digitado` não entra na URL (é dicionário, e o
    FastAPI o leria como parâmetro de query), e por isso a recusa RENDERIZA esta
    mesma tela em vez de redirecionar. Aqui isso pesa mais do que em qualquer
    outra tela do sistema: o campo que a RN-21 recusa é justamente o texto longo
    que alguém acabou de escrever ouvindo a pessoa falar, e perdê-lo na recusa
    ensinaria a escrever menos — que é o oposto do que o filtro quer.
    """
    lista = servico.listar(
        s,
        estado=estado,
        responsavel_id=usuario.id if minhas == "1" else None,
        busca=q,
    )
    if not estado:
        # "Em aberto" é a visão padrão: encerrada não some da tela — tem ficha
        # própria — mas sai da fila, que é a lista do que ainda cobra alguém.
        lista = [d for d in lista if d.estado != "ENCERRADA"]

    recorte = recortar(lista, numero_da_pagina(request))
    hoje = date.today()
    return pagina(
        request,
        "paginas/demandas.html",
        usuario=usuario,
        demandas=recorte.itens,
        recorte=recorte,
        contagem=servico.contar_por_estado(s),
        visoes=VISOES,
        filtro_estado=estado,
        apenas_minhas=minhas == "1",
        q=q,
        hoje=hoje,
        atrasadas=sum(1 for d in lista if d.atrasada(hoje)),
        canais=CANAIS_DEMANDA,
        rotulo_canal=ROTULO_CANAL_DEMANDA,
        rotulo_estado_demanda=ROTULO_DEMANDA,
        rotulo_desfecho=ROTULO_DESFECHO_DEMANDA,
        servidores=list(
            s.execute(select(Servidor).order_by(Servidor.id)).scalars()
        ),
        unidades=list(
            s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()
        ),
        pessoas=_pessoas(s),
        pode_escrever=usuario.pode(servico.PERMISSAO_ESCREVER),
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
    )


def _tela_ficha(
    request: Request,
    s,
    usuario,
    demanda: Demanda,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    return pagina(
        request,
        "paginas/demanda_ficha.html",
        usuario=usuario,
        demanda=demanda,
        hoje=date.today(),
        rotulo_canal=ROTULO_CANAL_DEMANDA,
        rotulo_estado_demanda=ROTULO_DEMANDA,
        rotulo_desfecho=ROTULO_DESFECHO_DEMANDA,
        desfechos=DESFECHOS_DEMANDA,
        pessoas=_pessoas(s),
        pode_escrever=usuario.pode(servico.PERMISSAO_ESCREVER),
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
    )


# ---------------------------------------------------------------------
# A fila
# ---------------------------------------------------------------------
@rotas.get("/demandas")
def listar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    estado: str = "",
    minhas: str = "",
    q: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir(servico.PERMISSAO_VER)
    return _tela_lista(
        request, s, usuario, estado, minhas, q, mensagem=mensagem, erro=erro
    )


@rotas.post("/demandas")
def criar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    assunto: str = Form(""),
    canal: str = Form("EMAIL"),
    solicitante_nome: str = Form(""),
    data_chegada: str = Form(""),
    descricao: str = Form(""),
    solicitante_servidor_id: str = Form(""),
    solicitante_unidade_uorg_id: str = Form(""),
    responsavel_id: str = Form(""),
    prazo: str = Form(""),
):
    usuario.exigir(servico.PERMISSAO_VER)
    # Tudo o que foi digitado, guardado ANTES da primeira recusa.
    d = {
        "assunto": assunto,
        "canal": canal,
        "solicitante_nome": solicitante_nome,
        "data_chegada": data_chegada,
        "descricao": descricao,
        "solicitante_servidor_id": solicitante_servidor_id,
        "solicitante_unidade_uorg_id": solicitante_unidade_uorg_id,
        "responsavel_id": responsavel_id,
        "prazo": prazo,
    }
    try:
        demanda = servico.registrar(
            s,
            usuario,
            assunto=assunto,
            canal=canal,
            solicitante_nome=solicitante_nome,
            data_chegada=_data(data_chegada),
            descricao=descricao,
            solicitante_servidor_id=_id(solicitante_servidor_id),
            solicitante_unidade_uorg_id=_id(solicitante_unidade_uorg_id),
            responsavel_id=_id(responsavel_id),
            prazo=_data(prazo),
        )
    except (servico.RegraDaDemanda, TextoProibido, ValueError) as falha:
        return _tela_lista(request, s, usuario, erro=str(falha), digitado=d)
    s.commit()
    return _voltar(f"/demandas/{demanda.id}", mensagem="Demanda registrada.")


# ---------------------------------------------------------------------
# A ficha
# ---------------------------------------------------------------------
@rotas.get("/demandas/{demanda_id}")
def ficha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    demanda_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir(servico.PERMISSAO_VER)
    demanda = s.get(Demanda, demanda_id)
    if demanda is None:
        return _voltar("/demandas", erro="Demanda não encontrada.")
    return _tela_ficha(request, s, usuario, demanda, mensagem=mensagem, erro=erro)


@rotas.post("/demandas/{demanda_id}/iniciar")
def iniciar(s: SessaoDep, usuario: UsuarioDep, demanda_id: int):
    demanda = s.get(Demanda, demanda_id)
    if demanda is None:
        usuario.exigir(servico.PERMISSAO_VER)
        return _voltar("/demandas", erro="Demanda não encontrada.")
    try:
        servico.iniciar(s, usuario, demanda)
    except (servico.RegraDaDemanda, TransicaoInvalida) as falha:
        return _voltar(f"/demandas/{demanda_id}", erro=str(falha))
    s.commit()
    return _voltar(f"/demandas/{demanda_id}", mensagem="Demanda em andamento.")


@rotas.post("/demandas/{demanda_id}/atribuir")
def atribuir(
    s: SessaoDep,
    usuario: UsuarioDep,
    demanda_id: int,
    responsavel_id: str = Form(""),
):
    demanda = s.get(Demanda, demanda_id)
    if demanda is None:
        usuario.exigir(servico.PERMISSAO_VER)
        return _voltar("/demandas", erro="Demanda não encontrada.")
    try:
        servico.atribuir(s, usuario, demanda, responsavel_id=_id(responsavel_id))
    except servico.RegraDaDemanda as falha:
        return _voltar(f"/demandas/{demanda_id}", erro=str(falha))
    s.commit()
    return _voltar(f"/demandas/{demanda_id}", mensagem="Responsável alterado.")


@rotas.post("/demandas/{demanda_id}/encaminhar")
def encaminhar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    demanda_id: int,
    para_quem: str = Form(""),
    pedido: str = Form(""),
    data_encaminhamento: str = Form(""),
):
    demanda = s.get(Demanda, demanda_id)
    if demanda is None:
        usuario.exigir(servico.PERMISSAO_VER)
        return _voltar("/demandas", erro="Demanda não encontrada.")
    d = {
        "forma": "encaminhar",
        "para_quem": para_quem,
        "pedido": pedido,
        "data_encaminhamento": data_encaminhamento,
    }
    try:
        servico.encaminhar(
            s,
            usuario,
            demanda,
            para_quem=para_quem,
            pedido=pedido,
            data_encaminhamento=_data(data_encaminhamento),
        )
    except (servico.RegraDaDemanda, TextoProibido, ValueError) as falha:
        return _tela_ficha(request, s, usuario, demanda, erro=str(falha), digitado=d)
    s.commit()
    return _voltar(f"/demandas/{demanda_id}", mensagem="Encaminhamento registrado.")


@rotas.post("/demandas/{demanda_id}/encerrar")
def encerrar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    demanda_id: int,
    desfecho: str = Form(""),
    relato: str = Form(""),
    nup: str = Form(""),
    setor: str = Form(""),
    data_desfecho: str = Form(""),
):
    demanda = s.get(Demanda, demanda_id)
    if demanda is None:
        usuario.exigir(servico.PERMISSAO_VER)
        return _voltar("/demandas", erro="Demanda não encontrada.")
    d = {
        "forma": "encerrar",
        "desfecho": desfecho,
        "relato": relato,
        "nup": nup,
        "setor": setor,
        "data_desfecho": data_desfecho,
    }
    processo_id = None
    if desfecho == "VIROU_PROCESSO":
        processo_id, recusa = _processo_do_nup(s, nup)
        if recusa:
            return _tela_ficha(request, s, usuario, demanda, erro=recusa, digitado=d)
    try:
        servico.encerrar(
            s,
            usuario,
            demanda,
            desfecho=desfecho,
            relato=relato,
            processo_id=processo_id,
            setor=setor,
            data_desfecho=_data(data_desfecho),
        )
    except (
        servico.RegraDaDemanda,
        TextoProibido,
        TransicaoInvalida,
        ValueError,
    ) as falha:
        return _tela_ficha(request, s, usuario, demanda, erro=str(falha), digitado=d)
    s.commit()
    return _voltar(f"/demandas/{demanda_id}", mensagem="Demanda encerrada.")


# ---------------------------------------------------------------------
# Traduções do formulário
# ---------------------------------------------------------------------
def _id(bruto: str) -> int | None:
    return int(bruto) if bruto and bruto.isdigit() else None


def _data(bruto: str) -> date | None:
    """`<input type=date>` manda AAAA-MM-DD ou vazio. Vazio é ausência, não erro."""
    texto = (bruto or "").strip()
    return date.fromisoformat(texto[:10]) if texto else None


def _processo_do_nup(s, bruto: str) -> tuple[int | None, str | None]:
    """O NUP digitado vira o `processo.id` real — ou uma recusa que diz o caminho.

    **A decisão que este trecho carrega.** O desfecho `VIROU_PROCESSO` promete
    rastreabilidade: clicar na demanda e chegar no processo. Isso exige uma
    chave estrangeira, e chave estrangeira exige que o processo exista. As três
    saídas possíveis eram gravar o NUP como texto (uma segunda fonte para o
    mesmo número, sem `unique` e sem o CHECK de formato que `processo.nup` tem),
    criar o processo aqui (um cadastro de processo SEI escondido dentro do
    encerramento de uma demanda, sem tipo, sem etapa e sem os avisos da RN-10),
    ou **recusar dizendo onde cadastrar** — que é o que está escrito abaixo.

    O NUP é aceito colado sujo (`nup.normalizar` tira pontuação e espaço),
    porque ele vem de um copiar-e-colar do SEI, e o dígito verificador NÃO
    bloqueia: a RN-10 já decidiu que DV é aviso, e aqui ele nem chega a ser
    aviso — quem manda é a existência do processo no cadastro.
    """
    texto = (bruto or "").strip()
    if not texto:
        return None, (
            "Informe o NUP do processo que a demanda gerou — é ele que liga uma "
            "coisa à outra."
        )
    try:
        valor = servico_nup.normalizar(texto)
    except ValueError:
        return None, (
            f"“{texto}” não é um NUP: o formato é 23086.021284/2024-56, com 17 "
            "dígitos."
        )
    processo = s.execute(
        select(Processo).where(Processo.nup == valor)
    ).scalar_one_or_none()
    if processo is None:
        return None, (
            f"Não há processo {valor} cadastrado no sistema. Cadastre-o em “Novo "
            "processo” e volte para encerrar a demanda — assim ela vira um link "
            "para o processo, e não um número anotado."
        )
    return processo.id, None
