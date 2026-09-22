"""/turmas — turma de treinamento, inscrição interna, presença e nota.

Módulo Certificados e Treinamentos. A ficha da turma tem as quatro abas do
fluxo do legado, que acertou a sequência do trabalho; hoje estão entregues as
três primeiras (Turma, Inscrições, Presença e notas) e a quarta fica declarada.

Nenhuma regra mora aqui: as rotas leem o formulário, chamam
`app/servicos/turma.py` ou `app/servicos/presenca.py` e traduzem a recusa em
mensagem na tela. A guarda que importa é a do serviço — a revisão da fatia 1
mostrou o que acontece quando ela vive só no template.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AssinaturaInstrutor,
    Campus,
    Inscricao,
    Servidor,
    Treinamento,
    Turma,
    UnidadeUorg,
)
from app.modelos.estados import (
    ESTADOS_TURMA,
    ROTULO_INSCRICAO,
    ROTULO_TURMA,
    TransicaoInvalida,
    destinos_de_turma,
)
from app.modelos.treinamento import ROTULO_VINCULO, VINCULOS_PARTICIPANTE
from app.servicos import emissao_certificado as servico_emissao
from app.servicos import lista_presenca as servico_lista
from app.servicos import participante as servico_participante
from app.servicos import presenca as servico_presenca
from app.servicos import turma as servico_turma
from app.servicos.participante import DadosDoParticipante
from app.servicos.turma import RegraDaTurma
from app.web import fragmento, pagina

rotas = APIRouter(tags=["turmas"])

TURMAS = "/turmas"
ABAS = (
    ("turma", "Turma"),
    ("inscricoes", "Inscrições"),
    ("presencas", "Presença e notas"),
    ("emissao", "Emissão"),
)

# A aba 1 é o CARTAZ: código, treinamento, período, local, vagas, situação e os
# instrutores — que já vão assinados no certificado. Não nomeia participante
# nenhum, e é por isso que ela abre para quem só tem `treinamento.ver`.
#
# As outras três são NOMINAIS: a lista de inscritos, a grade de presença e a
# fila de emissão dizem quem está na turma. Elas exigem uma das permissões
# abaixo, e a lista não é arbitrária — `certificado.ver` é, na própria definição
# em `rbac.PERMISSOES`, "ver certificado nominal e dados do participante"; as
# outras duas são de quem OPERA a turma e precisa ver a quem está inscrevendo ou
# de quem está lançando presença.
#
# Hoje isso separa exatamente uma conta de todas as outras: `servidor_consulta`
# é o único perfil com `treinamento.ver` que não tem nenhuma das três. Antes da
# correção de escopo ele não chegava aqui — a ficha respondia 303 em silêncio —,
# e a guarda existe para que abrir a lista de turmas não abra junto a lista de
# quem está nelas. Ver que o curso existe e ver quem está nele são duas
# perguntas diferentes.
PERMISSOES_DAS_ABAS_NOMINAIS = ("certificado.ver", "turma.inscrever", "turma.avaliar")
# as quatro abas do fluxo do legado estão entregues; a tupla continua aqui para
# que a próxima fatia que trouxer aba declare a dela em vez de escondê-la
ABAS_PREVISTAS: tuple[tuple[str, str], ...] = ()


def _texto(valor: str | None) -> str | None:
    return (valor or "").strip() or None


def _marcado(valor: str) -> bool:
    return valor == "1"


def _aviso(
    destino: str, campo: str, mensagem: str, *, ancora: str = ""
) -> RedirectResponse:
    """O destino da aba já leva `?aba=…`; um segundo `?` engoliria o aviso.

    Sem o `&`, a mensagem viraria parte do valor de `aba`: a pessoa voltaria
    para a aba errada e sem saber por que a ação não aconteceu.

    E o texto vai **codificado**. A mensagem daqui carrega o que foi digitado —
    nome de turma, motivo de cancelamento, código de treinamento —, e um `&` ou
    um `#` no meio dela encerrava a query string ali: o recado chegava cortado
    na palavra em que a pessoa tinha escrito o símbolo, que é justamente onde
    ela olharia para entender o que deu errado. `quote_via=quote` e não o `+`
    padrão porque o espaço tem de voltar espaço em quem só desfaz `%XX`.

    A ÂNCORA VAI POR ÚLTIMO, e por isso é parâmetro daqui e não do chamador: o
    fragmento encerra a URL, então `?aba=presencas#grade&mensagem=…` faria o
    recado virar parte do nome da âncora e sumir da tela. Escrita à mão, essa é
    a inversão que se erra uma vez por rota.
    """
    separador = "&" if "?" in destino else "?"
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    return RedirectResponse(f"{destino}{separador}{parametros}{ancora}", status_code=303)


def _volta(destino: str, mensagem: str, *, ancora: str = "") -> RedirectResponse:
    """Deu certo. Sai no banner verde (`base.html`, `.aviso-ok`)."""
    return _aviso(destino, "mensagem", mensagem, ancora=ancora)


def _erro(destino: str, mensagem: str, *, ancora: str = "") -> RedirectResponse:
    """Não deu. Sai no banner vermelho — e a cor é a informação.

    Este módulo teve um canal só, `mensagem=`, e o `base.html`
    pinta `mensagem` de verde. "Informe a data de início (AAAA-MM-DD)." e
    "Ninguém apto a emitir nesta turma." chegavam à tela com a mesma cor de
    "Turma T-2026-004 aberta." Numa turma, a diferença entre emitiu e não emitiu
    estava na cor de uma caixa, e a cor estava errada.

    Não faz `rollback`: há recusa que acontece antes de qualquer escrita (o
    parâmetro que nem chegou ao serviço). Quem escreveu antes de ser recusado
    usa `_recusar`.
    """
    return _aviso(destino, "erro", mensagem, ancora=ancora)


def _recusar(s, destino: str, mensagem: str, *, ancora: str = "") -> RedirectResponse:
    """Desfaz o que a ação já tinha escrito e volta com o motivo.

    O `rollback` não é zelo: a sessão do FastAPI dá **commit** ao terminar a
    rota (`dependencias.obter_sessao`), inclusive quando a rota devolveu um
    aviso de recusa. Sem desfazer, cadastrar um externo e esbarrar na turma
    lotada gravaria a pessoa — nome e e-mail — sem inscrição nenhuma, e a
    segunda tentativa criaria a mesma pessoa de novo. Guardar dado pessoal de
    quem nem chegou a se inscrever é exatamente o que a minimização proíbe.
    """
    s.rollback()
    return _erro(destino, mensagem, ancora=ancora)


def _id_opcional(valor: str) -> int | None:
    return int(valor) if (valor or "").strip().isdigit() else None


class CampoInvalido(ValueError):
    """Formato que a rota recusa antes de chegar ao serviço."""


def _data(valor: str, rotulo: str, *, obrigatoria: bool = True) -> date | None:
    """Campo de data vazio NÃO vira hoje nem 01/01: vira recusa.

    O `Form` de todos os campos abaixo tem default `""` de propósito — o
    FastAPI troca string vazia pelo default antes de a rota rodar, e um default
    plausível ("0", "hoje") transforma campo apagado em valor gravado sem que
    ninguém tenha digitado nada. Foi assim que uma validade de 24 meses virou
    "não expira" na fatia 1.
    """
    bruto = (valor or "").strip()
    if not bruto:
        if obrigatoria:
            raise CampoInvalido(f"Informe {rotulo} (AAAA-MM-DD).")
        return None
    try:
        return date.fromisoformat(bruto)
    except ValueError:
        raise CampoInvalido(f"{rotulo.capitalize()} inválida: use AAAA-MM-DD.") from None


def _decimal(valor: str, rotulo: str, *, padrao: Decimal | None = None) -> Decimal | None:
    """Aceita 8, 8,5 e 8.5 — a vírgula é o separador que o setor digita."""
    bruto = (valor or "").strip().replace(",", ".")
    if not bruto:
        return padrao
    try:
        return Decimal(bruto)
    except (InvalidOperation, ValueError):
        raise CampoInvalido(f"{rotulo.capitalize()} inválida: informe um número.") from None


def _inteiro(valor: str, rotulo: str) -> int | None:
    bruto = (valor or "").strip()
    if not bruto:
        return None
    if not bruto.isdigit():
        raise CampoInvalido(f"{rotulo.capitalize()} inválido: informe um número inteiro.")
    return int(bruto)


def _turma_no_escopo(s, usuario, turma_id: int) -> Turma | None:
    """Uma leitura só, pela porta do serviço (`turma.no_escopo`).

    O docstring desta função afirmava que `turma.campus_id` existia "exatamente
    para isto: sem ele, `aplicar_escopo` cairia em `where(False)` e o perfil de
    escopo próprio veria a tela vazia sem nenhum erro". **Era falso**, e o modo
    de falha que ele dizia prevenir era o que este perfil encontrava todos os
    dias: `campus_id` só socorre `ESCOPO_UNIDADE` (`rbac.aplicar_escopo`), e
    para `ESCOPO_PROPRIO` ele não faz nada — `Turma` não tem `servidor_id`,
    então a consulta caía no `where(False)` e `/turmas` abria 200 dizendo
    "nenhuma turma aberta ainda" com uma turma de vinte vagas na frente.

    A decisão que substituiu o comentário está em `turma.consulta_no_escopo`: a
    oferta é cartaz, o que tem titular é a inscrição.
    """
    return servico_turma.no_escopo(s, usuario, turma_id)


# =====================================================================
# Lista
# =====================================================================
@rotas.get(TURMAS)
def listar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    situacao: str = "",
    treinamento_id: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    """Abre em leitura para quem tem `treinamento.ver`; criar pede
    `turma.criar`, como acontece em /catalogos."""
    usuario.exigir("treinamento.ver")
    return _tela_lista(
        request,
        s,
        usuario,
        situacao=situacao,
        treinamento_id=treinamento_id,
        mensagem=mensagem,
        erro=erro,
    )


def _tela_lista(
    request,
    s,
    usuario,
    *,
    situacao: str = "",
    treinamento_id: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A lista, com o cartão "Nova turma" em branco ou como foi digitado.

    Uma função só para a abertura e para a recusa da abertura de turma, pelo
    mesmo motivo de `processos._tela_novo`. `digitado` não entra na assinatura da
    rota GET — dicionário em parâmetro de rota o FastAPI leria como corpo.
    """
    consulta = servico_turma.consulta_no_escopo(usuario)
    if situacao in ESTADOS_TURMA:
        consulta = consulta.where(Turma.situacao == situacao)
    alvo = _id_opcional(treinamento_id)
    if alvo is not None:
        consulta = consulta.where(Turma.treinamento_id == alvo)
    itens = list(
        s.execute(consulta.order_by(Turma.ano.desc(), Turma.numero.desc())).scalars()
    )
    return pagina(
        request,
        "paginas/turmas.html",
        usuario=usuario,
        itens=itens,
        inscritos={
            turma.id: servico_turma.inscricoes_que_ocupam_vaga(s, turma)
            for turma in itens
        },
        # só treinamento ativo entra no seletor de nova turma: abrir turma de
        # curso desativado é o que o serviço recusa, e oferecer a opção só para
        # recusar depois é fazer a pessoa digitar duas vezes
        treinamentos=list(
            s.execute(
                select(Treinamento)
                .where(Treinamento.ativo.is_(True))
                .order_by(Treinamento.nome)
            ).scalars()
        ),
        # o filtro precisa listar todos, inclusive os desativados: turma antiga
        # de curso hoje desativado continua existindo e precisa ser encontrável
        treinamentos_do_filtro=list(
            s.execute(select(Treinamento).order_by(Treinamento.nome)).scalars()
        ),
        campi=list(s.execute(select(Campus).order_by(Campus.nome)).scalars()),
        unidades=list(
            s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()
        ),
        situacoes=[(codigo, ROTULO_TURMA[codigo]) for codigo in ESTADOS_TURMA],
        filtro_situacao=situacao,
        filtro_treinamento=treinamento_id,
        digitado=digitado or {},
        mensagem=mensagem,
        erro=erro,
    )


# =====================================================================
# "Meus treinamentos" — a tela do próprio servidor
# =====================================================================
# **Declarada ANTES de `/turmas/{turma_id}`**: `minhas` não é inteiro, e com a
# ordem trocada o FastAPI tentaria casá-la com a ficha e responderia 422.
#
# Tela separada de `/turmas`, e não a mesma com um filtro, pelas três razões de
# `/certificados/meus` — e a primeira delas é a que o menu cobra: `/turmas` é a
# lista do setor, com o cartão "Abrir turma" e as quatro situações; esta
# responde "o que é meu e o que posso pedir", e a consulta dela é presa ao
# `servidor_id` da conta, não ao escopo do perfil. Uma tela que servisse aos
# dois públicos decidiria escopo por ramo, que é como o defeito da fila de EPI
# nasceu.
MINHAS = TURMAS + "/minhas"


@rotas.get(MINHAS)
def minhas(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    """O cartaz das turmas abertas e a lista das minhas inscrições."""
    usuario.exigir("treinamento.ver")
    hoje = date.today()
    minhas_inscricoes = servico_turma.inscricoes_do_titular(s, usuario)
    ja_inscrito = {i.turma_id for i in minhas_inscricoes}
    abertas = servico_turma.turmas_abertas(s, hoje)
    return pagina(
        request,
        "paginas/turmas_minhas.html",
        usuario=usuario,
        hoje=hoje,
        abertas=abertas,
        # "18 de 20" diz mais do que "18": a vaga livre é a decisão de quem lê
        inscritos={
            turma.id: servico_turma.inscricoes_que_ocupam_vaga(s, turma)
            for turma in abertas
        },
        vagas_restantes={
            turma.id: servico_turma.vagas_restantes(s, turma) for turma in abertas
        },
        ja_inscrito=ja_inscrito,
        inscricoes=minhas_inscricoes,
        desistivel={
            i.id: servico_turma.pode_desistir(i, hoje) for i in minhas_inscricoes
        },
        pode_pedir=usuario.pode("turma.inscrever_se"),
        # conta sem cadastro de servidor não é erro nem 403: é a tela dizendo por
        # que está vazia, em vez de deixar a pessoa concluir que nunca fez curso
        sem_servidor=usuario.servidor_id is None,
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post(TURMAS + "/{turma_id}/inscrever-me")
def inscrever_me(s: SessaoDep, usuario: UsuarioDep, turma_id: int):
    """O servidor pede a própria vaga.

    **A rota não aceita "quem", e é essa a propriedade de segurança.** Não há
    `participante_id`, `servidor_id` nem `inscricao_id` no formulário nem na
    URL: o único parâmetro é a turma, e o titular sai de `usuario.servidor_id`,
    que veio da sessão. Não é uma comparação dentro do serviço que alguém pode
    esquecer numa refatoração — é a ausência do parâmetro. Quem tem
    `turma.inscrever_se` e tenta inscrever outra pessoa não recebe uma recusa:
    não tem onde escrever o pedido.
    """
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(MINHAS, status_code=303)
    try:
        servico_turma.inscrever_se(s, usuario, turma)
    except RegraDaTurma as erro:
        return _recusar(s, MINHAS, str(erro))
    s.commit()
    return _volta(
        MINHAS,
        f"Inscrição pedida em {turma.codigo}. A vaga já está reservada para você "
        "e a CSSO confirma — enquanto isso a inscrição fica como “inscrita”.",
    )


@rotas.post(TURMAS + "/{turma_id}/desistir")
def desistir(
    s: SessaoDep, usuario: UsuarioDep, turma_id: int, motivo: str = Form("")
):
    """A própria desistência. Mesma disciplina: nenhum "quem" entra por aqui."""
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(MINHAS, status_code=303)
    minha = next(
        (
            i
            for i in servico_turma.inscricoes_do_titular(s, usuario)
            if i.turma_id == turma.id
        ),
        None,
    )
    if minha is None:
        return _erro(MINHAS, f"Você não tem inscrição em {turma.codigo}.")
    try:
        servico_turma.desistir(s, usuario, minha, motivo=_texto(motivo))
    except (RegraDaTurma, TransicaoInvalida) as erro:
        return _recusar(s, MINHAS, str(erro))
    s.commit()
    return _volta(
        MINHAS,
        f"Desistência registrada em {turma.codigo}. A vaga voltou para a turma e "
        "o motivo ficou escrito — nada foi apagado.",
    )


@rotas.post(TURMAS)
def criar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    treinamento_id: str = Form(...),
    data_inicio: str = Form(""),
    data_fim: str = Form(""),
    local: str = Form(""),
    campus_id: str = Form(""),
    unidade_promotora_id: str = Form(""),
    carga_horaria_horas: str = Form(""),
    data_base_vencimento: str = Form(""),
    vagas: str = Form(""),
    inscricao_aberta_ate: str = Form(""),
    nota_minima_aprovacao: str = Form(""),
    frequencia_minima_percentual: str = Form(""),
    observacoes: str = Form(""),
):
    usuario.exigir("turma.criar")
    # Tudo o que foi digitado, guardado antes da primeira recusa — o padrão de
    # `processos.criar`. São treze campos, e a recusa mais frequente aqui é de
    # formato de data: perder local, campus, unidade, vagas, nota mínima e
    # observações por causa de um "12/03/2026" digitado no lugar de
    # "2026-03-12" é o atrito que faz quem monta turma voltar para a planilha.
    digitado = {
        "treinamento_id": treinamento_id,
        "data_inicio": data_inicio,
        "data_fim": data_fim,
        "local": local,
        "campus_id": campus_id,
        "unidade_promotora_id": unidade_promotora_id,
        "carga_horaria_horas": carga_horaria_horas,
        "data_base_vencimento": data_base_vencimento,
        "vagas": vagas,
        "inscricao_aberta_ate": inscricao_aberta_ate,
        "nota_minima_aprovacao": nota_minima_aprovacao,
        "frequencia_minima_percentual": frequencia_minima_percentual,
        "observacoes": observacoes,
    }

    def recusar(mensagem: str):
        """Desfaz o que já tinha sido escrito e reabre a tela com o digitado.

        O `rollback` é o de `_recusar`, e pelo mesmo motivo: a sessão do FastAPI
        dá commit ao terminar a rota, inclusive quando ela devolveu uma recusa.
        """
        s.rollback()
        return _tela_lista(request, s, usuario, erro=mensagem, digitado=digitado)

    treinamento = s.get(Treinamento, _id_opcional(treinamento_id) or 0)
    if treinamento is None:
        return recusar("Escolha o treinamento da turma.")
    try:
        inicio = _data(data_inicio, "a data de início")
        fim = _data(data_fim, "a data de término")
        turma = servico_turma.criar_turma(
            s,
            usuario,
            treinamento=treinamento,
            data_inicio=inicio,
            data_fim=fim,
            local=_texto(local),
            campus_id=_id_opcional(campus_id),
            unidade_promotora_id=_id_opcional(unidade_promotora_id),
            carga_horaria_horas=_decimal(carga_horaria_horas, "a carga horária"),
            data_base_vencimento=_data(
                data_base_vencimento, "a data base", obrigatoria=False
            ),
            vagas=_inteiro(vagas, "o número de vagas"),
            inscricao_aberta_ate=_data(
                inscricao_aberta_ate, "o fim das inscrições", obrigatoria=False
            ),
            nota_minima_aprovacao=_decimal(nota_minima_aprovacao, "a nota mínima"),
            frequencia_minima_percentual=_decimal(
                frequencia_minima_percentual, "a frequência mínima", padrao=Decimal(75)
            ),
            observacoes=_texto(observacoes),
        )
    except (CampoInvalido, RegraDaTurma) as erro:
        return recusar(str(erro))
    s.commit()
    return _volta(f"{TURMAS}/{turma.id}", f"Turma {turma.codigo} aberta.")


# =====================================================================
# Ficha da turma
# =====================================================================
@rotas.get(TURMAS + "/{turma_id}")
def ficha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    aba: str = "turma",
    busca: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("treinamento.ver")
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    # Ver `PERMISSOES_DAS_ABAS_NOMINAIS`: quem só lê o cartaz recebe uma aba só,
    # e as três nominais não são só escondidas — a rota não chega a carregá-las.
    # Esconder aba nunca foi guarda: `?aba=inscricoes` continua chegando.
    ve_nominal = any(usuario.pode(p) for p in PERMISSOES_DAS_ABAS_NOMINAIS)
    abas = ABAS if ve_nominal else ABAS[:1]
    if aba not in dict(abas):
        aba = "turma"
    inscricoes = servico_turma.inscricoes_da_turma(s, turma) if ve_nominal else []
    return pagina(
        request,
        "paginas/turma_ficha.html",
        usuario=usuario,
        turma=turma,
        aba=aba,
        abas=abas,
        abas_previstas=ABAS_PREVISTAS,
        inscricoes=inscricoes,
        # `rotulo_inscricao` e `rotulo_turma` saíram: a ficha escreve os dois
        # pelos mapas acentuados de `macros.html` (`ROTULO_TURMA_TELA`,
        # `pilula_inscricao`), e o que continuava chegando aqui era o ASCII da
        # trilha de auditoria, à espera de que alguém o imprimisse por engano.
        rotulo_vinculo=ROTULO_VINCULO,
        vinculos=[v for v in VINCULOS_PARTICIPANTE if v != "SERVIDOR"],
        vagas_restantes=servico_turma.vagas_restantes(s, turma),
        destinos=[
            (codigo, ROTULO_TURMA[codigo]) for codigo in destinos_de_turma(turma.situacao)
        ],
        permissao_por_destino=servico_turma.PERMISSAO_POR_SITUACAO_TURMA,
        instrutores_livres=_instrutores_livres(s, turma),
        # duas listas para uma busca só: quem já é participante e o servidor da
        # base que ainda não é. Sem a segunda, inscrever um servidor pela
        # primeira vez não acharia ninguém e a saída natural seria recadastrá-lo
        # como externo — a mesma pessoa duas vezes, uma com SIAPE e outra sem.
        # a busca de quem inscrever é nominal por natureza: ela devolve pessoas.
        # Passa pela mesma porta das abas, senão `?busca=silva` continuaria
        # respondendo a quem a aba já não abre.
        # `usuario=` NÃO é opcional aqui, e o padrão da função é fechado de
        # propósito: sem ele a busca casa por SIAPE e por `PTC-`, e **não casa
        # por nome** — para todo mundo, inclusive a coordenação. Medido: o
        # coordenador procurando "Adelaide" recebia 0 achados, e passando o
        # usuário recebe 1. `ve_nominal` acima decide SE a busca acontece; este
        # argumento decide COMO ela casa, e são duas perguntas diferentes.
        achados=(
            servico_participante.buscar(s, busca, usuario=usuario)
            if busca.strip() and ve_nominal
            else []
        ),
        servidores_achados=(
            servico_participante.buscar_servidores(s, busca, usuario=usuario)
            if busca.strip() and ve_nominal
            else []
        ),
        busca=busca,
        campi=list(s.execute(select(Campus).order_by(Campus.nome)).scalars()),
        unidades=list(
            s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()
        ),
        # --- aba 3 ---
        # `dias` é do calendário da turma e não nomeia ninguém; a grade e a
        # contagem são de PESSOAS, e param na mesma porta das abas. Não é só
        # zelo: o que não é carregado não escapa por um `{% if %}` que alguém
        # mova de lugar depois.
        dias=servico_presenca.dias_da_turma(turma),
        grade=servico_presenca.grade_da_turma(s, turma) if ve_nominal else [],
        contagem=(
            servico_presenca.contagem_por_situacao(s, turma) if ve_nominal else {}
        ),
        carga_efetiva=turma.carga_efetiva,
        # a tela distingue lançar de retificar porque o formulário muda: turma
        # concluída passa a exigir motivo, e um campo que aparece sem
        # explicação é um campo que a pessoa preenche com "correção"
        retificando=turma.situacao == "CONCLUIDA",
        # --- aba 4 ---
        # A mesma função que a emissão usa decide quem aparece como apto: uma
        # segunda conta para a tela seria a forma mais barata de a tela dizer
        # "apto" e a emissão recusar.
        #
        # Só na aba de emissão, e o `if` não é zelo: `validar` abre o .docx do
        # modelo para conferir os marcadores, uma vez por inscrito. Numa turma de
        # trinta, calcular isso ao abrir a aba de presença seriam trinta leituras
        # de arquivo para uma tela que nem mostra o resultado.
        aptidao=(
            {inscricao.id: servico_emissao.validar(s, inscricao) for inscricao in inscricoes}
            if aba == "emissao"
            else {}
        ),
        certificados=(
            servico_emissao.certificados_da_turma(s, turma) if aba == "emissao" else {}
        ),
        mensagem=mensagem,
        erro=erro,
    )


def _instrutores_livres(s, turma: Turma) -> list[AssinaturaInstrutor]:
    """Quem ainda pode ser vinculado: ativo, vigente na data e não vinculado.

    Vigência entra no filtro porque o serviço recusa a assinatura que não
    vigora no início da turma — oferecer para depois recusar faz a pessoa
    acreditar que o sistema quebrou.
    """
    ja = {vinculo.assinatura_instrutor_id for vinculo in turma.instrutores}
    todos = s.execute(
        select(AssinaturaInstrutor)
        .where(AssinaturaInstrutor.ativo.is_(True))
        .order_by(AssinaturaInstrutor.nome)
    ).scalars()
    return [
        instrutor
        for instrutor in todos
        if instrutor.id not in ja and instrutor.vigente_em(turma.data_inicio)
    ]


@rotas.post(TURMAS + "/{turma_id}")
def editar(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    data_inicio: str = Form(""),
    data_fim: str = Form(""),
    local: str = Form(""),
    campus_id: str = Form(""),
    unidade_promotora_id: str = Form(""),
    carga_horaria_horas: str = Form(""),
    data_base_vencimento: str = Form(""),
    vagas: str = Form(""),
    inscricao_aberta_ate: str = Form(""),
    nota_minima_aprovacao: str = Form(""),
    frequencia_minima_percentual: str = Form(""),
    observacoes: str = Form(""),
):
    """O código, o número e o ano não se editam: já foram divulgados.

    O treinamento também não: trocá-lo transformaria a turma de NR-35 em turma
    de brigada com os mesmos inscritos, e é a pior das trocas silenciosas.
    """
    usuario.exigir("turma.criar")
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    destino = f"{TURMAS}/{turma_id}"
    try:
        campos = {
            "data_inicio": _data(data_inicio, "a data de início"),
            "data_fim": _data(data_fim, "a data de término"),
            "local": _texto(local),
            "campus_id": _id_opcional(campus_id),
            "unidade_promotora_id": _id_opcional(unidade_promotora_id),
            "carga_horaria_horas": _decimal(carga_horaria_horas, "a carga horária"),
            "data_base_vencimento": _data(
                data_base_vencimento, "a data base", obrigatoria=False
            ),
            "vagas": _inteiro(vagas, "o número de vagas"),
            "inscricao_aberta_ate": _data(
                inscricao_aberta_ate, "o fim das inscrições", obrigatoria=False
            ),
            "nota_minima_aprovacao": _decimal(nota_minima_aprovacao, "a nota mínima"),
            "frequencia_minima_percentual": _decimal(
                frequencia_minima_percentual, "a frequência mínima", padrao=Decimal(75)
            ),
            "observacoes": _texto(observacoes),
        }
        servico_turma.editar_turma(s, usuario, turma, campos)
    except (CampoInvalido, RegraDaTurma) as erro:
        return _recusar(s, destino, str(erro))
    s.commit()
    return _volta(destino, "Turma atualizada.")


@rotas.post(TURMAS + "/{turma_id}/situacao")
def mudar_situacao(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    destino: str = Form(...),
    motivo: str = Form(""),
):
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}"
    try:
        servico_turma.mudar_situacao(s, usuario, turma, destino, motivo=motivo)
    except (RegraDaTurma, TransicaoInvalida) as erro:
        return _recusar(s, volta, str(erro))
    s.commit()
    return _volta(volta, f"{turma.codigo}: {ROTULO_TURMA[turma.situacao].lower()}.")


# =====================================================================
# Instrutores
# =====================================================================
@rotas.post(TURMAS + "/{turma_id}/instrutores")
def instrutores(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    assinatura_instrutor_id: str = Form(""),
    assina_certificado: str = Form(""),
    remover: str = Form(""),
):
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}"
    alvo = _id_opcional(assinatura_instrutor_id)
    if alvo is None:
        return _erro(volta, "Escolha o instrutor.")
    try:
        if _marcado(remover):
            servico_turma.desvincular_instrutor(s, usuario, turma, alvo)
            s.commit()
            return _volta(volta, "Instrutor desvinculado da turma.")
        instrutor = s.get(AssinaturaInstrutor, alvo)
        if instrutor is None:
            return _erro(volta, "Assinatura de instrutor não encontrada.")
        servico_turma.vincular_instrutor(
            s,
            usuario,
            turma,
            instrutor,
            assina_certificado=_marcado(assina_certificado),
        )
    except RegraDaTurma as erro:
        return _recusar(s, volta, str(erro))
    s.commit()
    return _volta(volta, f"{instrutor.nome_exibicao} vinculado à turma.")


# =====================================================================
# Inscrições — aba 2
# =====================================================================
@rotas.post(TURMAS + "/{turma_id}/inscricoes")
def inscrever(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    participante_id: str = Form(""),
    servidor_id: str = Form(""),
    nome: str = Form(""),
    vinculo: str = Form(""),
    email: str = Form(""),
    organizacao: str = Form(""),
    matricula_externa: str = Form(""),
    observacao: str = Form(""),
):
    """Três portas para a mesma coisa: participante já cadastrado, servidor da
    base, ou externo novo.

    A ordem importa. Servidor da base vira ponteiro (`participante.servidor_id`)
    e nunca cópia de nome — o cadastro externo é a última opção justamente para
    que ninguém redigite como "visitante" alguém que tem SIAPE.
    """
    usuario.exigir("turma.inscrever")
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}?aba=inscricoes"
    try:
        pessoa = _resolver_participante(
            s,
            usuario,
            participante_id=participante_id,
            servidor_id=servidor_id,
            nome=nome,
            vinculo=vinculo,
            email=email,
            organizacao=organizacao,
            matricula_externa=matricula_externa,
        )
        servico_turma.inscrever(s, usuario, turma, pessoa, observacao=_texto(observacao))
    except (CampoInvalido, DadosDoParticipante, RegraDaTurma) as erro:
        # aqui o rollback é o que impede o pior caso desta rota: o participante
        # externo já foi gravado antes de a inscrição ser recusada
        return _recusar(s, volta, str(erro))
    s.commit()
    return _volta(volta, f"{pessoa.nome_exibicao} inscrito(a) em {turma.codigo}.")


def _resolver_participante(
    s,
    usuario,
    *,
    participante_id: str,
    servidor_id: str,
    nome: str,
    vinculo: str,
    email: str,
    organizacao: str,
    matricula_externa: str,
):
    from app.modelos import Participante

    escolhido = _id_opcional(participante_id)
    if escolhido is not None:
        pessoa = s.get(Participante, escolhido)
        if pessoa is None:
            raise CampoInvalido("Participante não encontrado.")
        # e-mail digitado junto com participante já existente é endereço novo
        # da mesma pessoa: é assim que o histórico se reconcilia em vez de
        # virar um segundo cadastro
        servico_participante.registrar_email(s, pessoa, email)
        return pessoa

    alvo_servidor = _id_opcional(servidor_id)
    if alvo_servidor is not None:
        servidor = s.get(Servidor, alvo_servidor)
        if servidor is None:
            raise CampoInvalido("Servidor não encontrado.")
        pessoa = servico_participante.de_servidor(s, servidor, usuario)
        servico_participante.registrar_email(s, pessoa, email)
        return pessoa

    if not (nome or "").strip():
        raise CampoInvalido(
            "Escolha alguém já cadastrado, um servidor da base, ou informe o nome "
            "de um participante externo."
        )
    return servico_participante.criar_externo(
        s,
        nome=nome,
        vinculo=(vinculo or "OUTRO").strip().upper(),
        usuario=usuario,
        email=email,
        organizacao=organizacao,
        matricula_externa=matricula_externa,
    )


@rotas.post(TURMAS + "/{turma_id}/inscricoes/{inscricao_id}")
def mudar_situacao_inscricao(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    inscricao_id: int,
    destino: str = Form(...),
    motivo: str = Form(""),
):
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}?aba=inscricoes"
    inscricao = s.get(Inscricao, inscricao_id)
    if inscricao is None or inscricao.turma_id != turma.id:
        return RedirectResponse(volta, status_code=303)
    try:
        servico_turma.mudar_situacao_inscricao(
            s, usuario, inscricao, destino, motivo=motivo
        )
    except (RegraDaTurma, TransicaoInvalida) as erro:
        return _recusar(s, volta, str(erro))
    s.commit()
    return _volta(
        volta,
        f"{inscricao.participante.nome_exibicao}: "
        f"{ROTULO_INSCRICAO[inscricao.situacao].lower()}.",
    )


# =====================================================================
# Presença e notas — aba 3
# =====================================================================
PRESENCAS = "?aba=presencas"
# A âncora do 303. Toda ação bem-sucedida termina num redirecionamento para o
# topo de uma página nova, e quem estava na linha 27 da grade volta à linha 1 —
# num formulário que se preenche linha a linha isso é a viagem inteira de novo.
# Uma f-string por rota devolve o lugar. Não substitui a troca parcial: este é o
# caminho de quem não tem JavaScript, e o de quem marcou a coluna inteira.
ANCORA_GRADE = "#grade-presenca"


def _inscricao_da_turma(s, turma: Turma, inscricao_id: int | None) -> Inscricao | None:
    """A inscrição precisa ser DESTA turma.

    Sem a conferência, um `inscricao_id` de outra turma passaria pelo escopo
    (que filtra a turma, não a inscrição) e a presença seria lançada na turma
    errada — com a frequência de outra carga horária.
    """
    if inscricao_id is None:
        return None
    inscricao = s.get(Inscricao, inscricao_id)
    if inscricao is None or inscricao.turma_id != turma.id:
        return None
    return inscricao


# =====================================================================
# A troca parcial da grade — uma linha de cada vez
# =====================================================================
# Turma de 30 pessoas × 5 dias são 150 lançamentos, e cada um era um POST com
# recarga de página inteira: 150 voltas ao topo de uma grade de 30 linhas, sem
# âncora e sem devolver o foco. A conta que torna isto barato foi paga na
# 1.27.0 — o tratador global dos três estados da troca parcial em `base.html`
# vale para todo `hx-*` sem marcação nova —, e o que faltava era usá-la.
#
# O QUE DECIDE O FORMATO DA RESPOSTA É O CABEÇALHO, e não uma rota separada:
# `HX-Request` só existe quando quem chamou foi o htmx. Sem ele — sem
# JavaScript, ou com o navegador enviando o `<form>` de verdade — a rota
# responde o mesmo 303 de sempre. Duas rotas para a mesma ação dariam duas
# guardas de permissão para manter, e a segunda é a que esquece.
#
# E A RECUSA DE REGRA VOLTA EM 200. "Informe as horas deste dia" e "o total
# passaria da carga da turma" são respostas do serviço, não falhas de rede: o
# fragmento sai com o motivo escrito dentro da célula acionada e com o que foi
# digitado ainda no campo. Devolvendo 4xx, o tratador global escreveria "não deu
# para atualizar este trecho (erro 422)" por cima de um motivo que o sistema
# sabia dizer com todas as letras.
def _e_htmx(request: Request) -> bool:
    return request.headers.get("HX-Request") == "true"


def _linha_trocada(
    request: Request,
    turma: Turma,
    inscricao: Inscricao,
    *,
    recusa: str | None = None,
    recusa_onde: str | None = None,
    digitado_horas: str = "",
    digitado_nota: str = "",
):
    """A linha da grade daquele inscrito, pronta para substituir a que está lá."""
    return fragmento(
        request,
        "partes/linha_presenca.html",
        turma=turma,
        linha=servico_presenca.linha_da_grade(turma, inscricao),
        dias=servico_presenca.dias_da_turma(turma),
        # A linha só é trocada para quem acabou de acionar o controle que ela
        # redesenha, e a guarda que decide isso é a do serviço
        # (`_exigir_lancamento`), que já correu acima. Devolvê-la sem os botões
        # apagaria o controle debaixo do cursor de quem tem permissão.
        pode_lancar=True,
        retificando=turma.situacao == "CONCLUIDA",
        recusa=recusa,
        recusa_onde=recusa_onde,
        digitado_horas=digitado_horas,
        digitado_nota=digitado_nota,
    )


@rotas.post(TURMAS + "/{turma_id}/presencas")
def lancar_presenca(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    inscricao_id: str = Form(""),
    data: str = Form(""),
    presente: str = Form(""),
    horas: str = Form(""),
    justificativa: str = Form(""),
    motivo: str = Form(""),
):
    """Um dia, um inscrito. Relançar o mesmo dia corrige o lançamento.

    `horas` em branco não vira zero nem "o dia todo" por acaso: só a turma de um
    dia assume a carga efetiva, porque ali o dia É o curso inteiro; na de vários
    dias o serviço recusa e pede o número. O default do `Form` é `""` pelo mesmo
    motivo da fatia 2 — default plausível grava valor que ninguém digitou.
    """
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}{PRESENCAS}"
    inscricao = _inscricao_da_turma(s, turma, _id_opcional(inscricao_id))
    if inscricao is None:
        # inscrição de outra turma não tem linha nesta grade para trocar: aqui a
        # resposta é a página inteira, com a faixa vermelha, nos dois caminhos
        return _erro(volta, "Inscrição não encontrada nesta turma.", ancora=ANCORA_GRADE)
    parcial = _e_htmx(request)
    try:
        dia = _data(data, "o dia do lançamento")
        servico_presenca.lancar_presenca(
            s,
            usuario,
            inscricao,
            data=dia,
            presente=_marcado(presente),
            horas=_decimal(horas, "as horas do dia"),
            justificativa=_texto(justificativa),
            motivo=_texto(motivo),
        )
    except (CampoInvalido, RegraDaTurma, TransicaoInvalida) as erro:
        s.rollback()
        if parcial:
            return _linha_trocada(
                request,
                turma,
                inscricao,
                recusa=str(erro),
                recusa_onde=(data or "").strip(),
                digitado_horas=horas,
            )
        return _erro(volta, str(erro), ancora=ANCORA_GRADE)
    s.commit()
    if parcial:
        return _linha_trocada(request, turma, inscricao)
    return _volta(
        volta,
        f"{inscricao.participante.nome_exibicao}: "
        f"{servico_presenca.numero(inscricao.frequencia_percentual)}% de frequência.",
        ancora=ANCORA_GRADE,
    )


@rotas.post(TURMAS + "/{turma_id}/presencas/todos")
def marcar_todos_presentes(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    motivo: str = Form(""),
):
    """Curso de um dia: todo mundo presente, com a carga efetiva da turma."""
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}{PRESENCAS}"
    try:
        alcancadas = servico_presenca.marcar_todos_presentes(
            s, usuario, turma, motivo=_texto(motivo)
        )
    except (RegraDaTurma, TransicaoInvalida) as erro:
        return _recusar(s, volta, str(erro), ancora=ANCORA_GRADE)
    s.commit()
    return _volta(
        volta, f"{len(alcancadas)} presença(s) lançada(s).", ancora=ANCORA_GRADE
    )


@rotas.post(TURMAS + "/{turma_id}/presencas/dia")
def marcar_dia_presente(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    data: str = Form(""),
    horas: str = Form(""),
    motivo: str = Form(""),
):
    """Uma COLUNA da grade: todo mundo presente naquele dia.

    A unidade do meio entre a célula e a turma inteira, e é a unidade em que a
    folha de presença existe em papel — uma folha por dia, assinada por quem
    esteve. O argumento de por que isto é legítimo onde "marcar todos presentes"
    é recusado está em `servicos/presenca.marcar_dia_presente`.

    Não tem caminho de troca parcial, e a assimetria é deliberada: marcar a
    coluna mexe em todas as linhas, então o alvo da troca seria a grade inteira —
    um fragmento a mais para manter e um realce que cobriria as trinta linhas sem
    dizer o que mudou. São cinco cliques numa turma de cinco dias, contra os 150
    da célula; a recarga volta com a âncora na grade.
    """
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}{PRESENCAS}"
    try:
        dia = _data(data, "o dia da coluna")
        alcancadas = servico_presenca.marcar_dia_presente(
            s,
            usuario,
            turma,
            data=dia,
            horas=_decimal(horas, "as horas do dia"),
            motivo=_texto(motivo),
        )
    except (CampoInvalido, RegraDaTurma, TransicaoInvalida) as erro:
        return _recusar(s, volta, str(erro), ancora=ANCORA_GRADE)
    s.commit()
    return _volta(
        volta,
        f"{len(alcancadas)} presença(s) em {dia.strftime('%d/%m/%Y')}.",
        ancora=ANCORA_GRADE,
    )


@rotas.post(TURMAS + "/{turma_id}/notas")
def lancar_nota(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    inscricao_id: str = Form(""),
    nota: str = Form(""),
    apagar: str = Form(""),
    motivo: str = Form(""),
):
    """Nota de 0 a 10, ou o pedido explícito de apagá-la.

    Campo vazio **não** apaga a nota: apagar tem botão próprio. Foi campo vazio
    virando valor gravado que transformou uma validade de 24 meses em "não
    expira" na fatia 1, e aqui o estrago seria reprovar quem passou.
    """
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}{PRESENCAS}"
    inscricao = _inscricao_da_turma(s, turma, _id_opcional(inscricao_id))
    if inscricao is None:
        return _erro(volta, "Inscrição não encontrada nesta turma.", ancora=ANCORA_GRADE)
    parcial = _e_htmx(request)
    try:
        if _marcado(apagar):
            valor = None
        else:
            valor = _decimal(nota, "a nota")
            if valor is None:
                raise CampoInvalido(
                    "Informe a nota (0 a 10) ou use “apagar nota” — campo em "
                    "branco não apaga o que já está lançado."
                )
        servico_presenca.lancar_nota(s, usuario, inscricao, valor, motivo=_texto(motivo))
    except (CampoInvalido, RegraDaTurma, TransicaoInvalida) as erro:
        s.rollback()
        if parcial:
            return _linha_trocada(
                request,
                turma,
                inscricao,
                recusa=str(erro),
                recusa_onde="nota",
                digitado_nota=nota,
            )
        return _erro(volta, str(erro), ancora=ANCORA_GRADE)
    s.commit()
    if parcial:
        return _linha_trocada(request, turma, inscricao)
    return _volta(
        volta,
        f"{inscricao.participante.nome_exibicao}: nota "
        f"{servico_presenca.numero(inscricao.nota_final)}.",
        ancora=ANCORA_GRADE,
    )


# =====================================================================
# Emissão — aba 4
# =====================================================================
@rotas.post(TURMAS + "/{turma_id}/certificados")
def emitir_certificados(
    s: SessaoDep,
    usuario: UsuarioDep,
    turma_id: int,
    inscricao_id: str = Form(""),
):
    """Emite um certificado, ou o lote inteiro quando `inscricao_id` vem vazio.

    O lote **comita por certificado**, dentro do serviço: um item que trava no
    meio não derruba os que já saíram. Por isso esta rota não comita o lote de
    novo no fim — ela só comita o caminho de um item só, que é uma transação
    única como qualquer outra escrita do sistema.
    """
    usuario.exigir("certificado.emitir")
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    volta = f"{TURMAS}/{turma_id}?aba=emissao"

    alvo = _id_opcional(inscricao_id)
    if alvo is not None:
        inscricao = _inscricao_da_turma(s, turma, alvo)
        if inscricao is None:
            return _erro(volta, "Inscrição não encontrada nesta turma.")
        try:
            resultado = servico_emissao.emitir(s, usuario, inscricao)
        except servico_emissao.EmissaoBloqueada as erro:
            return _recusar(s, volta, str(erro))
        s.commit()
        aviso = f" {resultado.aviso_pdf}" if resultado.aviso_pdf else ""
        return _volta(
            volta,
            f"Certificado {resultado.certificado.rotulo} emitido para "
            f"{inscricao.participante.nome_exibicao}.{aviso}",
        )

    relatorio = servico_emissao.emitir_lote(s, usuario, turma)
    s.commit()
    if not relatorio.itens:
        # Nada foi emitido: nenhum inscrito passou na aptidão. Sai em vermelho
        # porque é o retorno de uma ação que não aconteceu — verde aqui era o
        # sistema dizendo "pronto" para quem continuou sem certificado nenhum.
        return _erro(volta, "Ninguém apto a emitir nesta turma.")
    return _volta(volta, f"{turma.codigo}: {relatorio.resumo}.")


@rotas.get(TURMAS + "/{turma_id}/lista-presenca")
def baixar_lista_presenca(s: SessaoDep, usuario: UsuarioDep, turma_id: int):
    """A folha que vai ao campo para assinar, em .docx.

    Regerada a cada pedido: quem entrou na turma na véspera precisa estar nela,
    e uma folha guardada seria uma folha desatualizada.
    """
    usuario.exigir("turma.avaliar")
    turma = _turma_no_escopo(s, usuario, turma_id)
    if turma is None:
        return RedirectResponse(TURMAS, status_code=303)
    resultado = servico_lista.gerar(s, usuario, turma)
    s.commit()
    caminho = resultado["arquivo"]
    return FileResponse(
        caminho, filename=caminho.name, media_type=servico_lista.TIPO_DOCX
    )
