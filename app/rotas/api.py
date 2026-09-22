"""`/api/v1` — a mesma regra, em JSON, para o balcão de EPI e a chamada.

**Por que existe.** É a fase 2 do plano de adesão (`PENDENCIAS.md`, "Amigável
não é SPA"): antes de decidir se o sistema ganha um front separado, o desenho
é testado num pedaço pequeno — as duas telas que se usam em pé, longe da mesa,
num tablet ou celular: entregar EPI no balcão e transcrever a folha de presença.
A tela de celular (`/celular`) consome só isto. Se um dia houver um front
inteiro, ele nasce em cima do que está aqui, e não do zero.

**O que a API NÃO é.** Não é uma segunda implementação. Cada rota chama o
MESMO serviço que a tela chama (`epi_ficha.registrar_entrega`,
`presenca.lancar_presenca`, `servidores.buscar`), com as mesmas recusas e a
mesma trilha de auditoria. O que muda é a forma da resposta: JSON no lugar de
HTML. Uma regra que só valesse na tela — ou só na API — seria a forma mais
barata de a ficha de EPI passar a ter duas verdades.

**Autenticação e privacidade, iguais às da tela.**

- A sessão é o MESMO cookie da tela: quem entrou pelo `/login` está logado na
  API, e quem não entrou recebe 401 em JSON (não um 303 para o login — o
  cliente de API não segue redirecionamento para ler HTML). O tratador em
  `principal.py` decide pelo caminho (`/api/`).
- A RN-19 vale linha a linha, pela MESMA função da tela (`identificar`): o
  seletor de quem recebe devolve o nome com SIAPE a quem pode ler o nome e o
  identificador opaco a quem não pode. O campo `nominal` diz qual dos dois foi.
- Todo POST exige `X-Requested-With: fetch`. É a guarda contra CSRF de quem
  usa cookie: um `<form>` de outro site consegue postar para cá com o cookie
  da pessoa (SameSite=lax deixa passar navegação de topo), mas não consegue
  escrever esse cabeçalho — só `fetch` da própria origem escreve, e a CSP
  (`connect-src 'self'`) impede o `fetch` de outra origem de chegar aqui.

**Sem Swagger, de propósito.** `docs_url=None` em `principal.py` é decisão
antiga (a versão exata e a lista de rotas são o que se usa para escolher a
vulnerabilidade certa), e a API a respeita: o contrato está em
`app/esquemas/api.py`, e o único índice é `GET /api/v1`, que exige sessão.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.config import VERSAO
from app.dependencias import SessaoDep, UsuarioDep
from app.esquemas import api as contrato
from app.modelos import EpiEntradaEstoque, EpiItem, Servidor, Turma
from app.modelos.estados import ROTULO_INSCRICAO, ROTULO_TURMA
from app.servicos import auditoria, epi_estoque, epi_ficha, identificacao
from app.servicos import pendencias as servico_pendencias
from app.servicos import presenca as servico_presenca
from app.servicos import servidores as servico_servidores
from app.servicos import turma as servico_turma
from app.servicos.textos import TextoProibido

rotas = APIRouter(prefix="/api/v1", tags=["api"])

CABECALHO_FETCH = "x-requested-with"


class RecusaDaApi(Exception):
    """Uma recusa com status e motivos — vira `Erro` em JSON no tratador."""

    def __init__(self, status: int, erro: str, motivos: list[str] | None = None):
        super().__init__(erro)
        self.status = status
        self.erro = erro
        self.motivos = motivos or []


def recusa_em_json(erro: RecusaDaApi) -> JSONResponse:
    return JSONResponse(
        contrato.Erro(erro=erro.erro, motivos=erro.motivos).model_dump(),
        status_code=erro.status,
    )


def exigir_fetch(request: Request) -> None:
    """A guarda de CSRF dos POSTs — ver o cabeçalho do módulo."""
    if request.headers.get(CABECALHO_FETCH, "").lower() != "fetch":
        raise RecusaDaApi(
            403,
            "Cabeçalho X-Requested-With: fetch obrigatório nos envios da API.",
            ["É a guarda contra envio forjado por outro site. Use fetch() da própria origem."],
        )


SoFetch = Depends(exigir_fetch)


def _iso(quando: date | None) -> str | None:
    return quando.isoformat() if quando else None


# =====================================================================
# Índice e identidade
# =====================================================================
@rotas.get("")
def indice(usuario: UsuarioDep) -> dict:
    """O índice da API — só para quem entrou. Lista o que existe, e nada mais."""
    return {
        "versao": VERSAO,
        "rotas": [
            "GET  /api/v1/eu",
            "GET  /api/v1/pendencias",
            "GET  /api/v1/epis/servidores?q=",
            "GET  /api/v1/epis/itens",
            "GET  /api/v1/epis/itens/{item_id}/lotes",
            "POST /api/v1/epis/entregas",
            "GET  /api/v1/epis/fichas/{servidor_id}",
            "GET  /api/v1/turmas?situacao=EM_ANDAMENTO",
            "GET  /api/v1/turmas/{turma_id}/presencas",
            "POST /api/v1/turmas/{turma_id}/presencas",
        ],
        "envios": "todo POST exige o cabeçalho X-Requested-With: fetch",
    }


@rotas.get("/eu", response_model=contrato.Eu)
def eu(usuario: UsuarioDep):
    return contrato.Eu(
        id=usuario.id,
        nome=usuario.nome,
        login=usuario.login,
        perfis=list(usuario.perfis),
        permissoes=sorted(usuario.permissoes),
        servidor_id=usuario.servidor_id,
        versao=VERSAO,
    )


# =====================================================================
# A fila de pendências — o "o que eu faço agora?" do app
# =====================================================================
# A âncora de cada pendência vai para o SISTEMA COMPLETO, porque é lá que o
# trabalho se faz. O mapa é o mesmo de `paginas/pendencias.html`, inclusive a
# permissão que cada porta exige — oferecer porta trancada é a mesma mentira
# do menu, em JSON.
_ANCORAS_POR_ENTIDADE = {
    "epi_ficha_registro": ("/epis/fichas/registros/", "", "epi.ficha"),
    "epi_entrada_estoque": ("/epis/estoque/", "/movimentos", "epi.ver"),
    "epi_requisicao": ("/epis/requisicoes/", "", "epi.ver"),
    "demanda": ("/demandas/", "", "demanda.ver"),
    "turma": ("/turmas/", "?aba=inscricoes", "turma.inscrever"),
}


def _onde(p, usuario) -> str | None:
    if p.processo_id and usuario.pode("processo.ver"):
        return f"/processos/{p.processo_id}"
    if p.parecer_id and usuario.pode("parecer.ver"):
        return f"/pareceres/{p.parecer_id}"
    if p.laudo_id and usuario.pode("laudo.ver"):
        return f"/laudos/{p.laudo_id}"
    ancora = _ANCORAS_POR_ENTIDADE.get(p.entidade or "")
    if ancora and p.entidade_id and usuario.pode(ancora[2]):
        return f"{ancora[0]}{p.entidade_id}{ancora[1]}"
    return None


@rotas.get("/pendencias", response_model=contrato.Pendencias)
def pendencias(s: SessaoDep, usuario: UsuarioDep):
    """A fila de quem entrou, por escopo — a mesma de `/pendencias`."""
    servico_pendencias.exigir_ver(usuario)
    itens = servico_pendencias.abertas(s, usuario)
    de_quem = servico_pendencias.titular_de(s, itens)
    hoje = date.today()
    linhas = [
        contrato.PendenciaResumo(
            id=p.id,
            tipo=p.tipo,
            rotulo_tipo=servico_pendencias.TIPOS.get(p.tipo, (p.tipo,))[0],
            # a descricao pode citar nome e SIAPE: passa pela RN-19 como na tela
            descricao=str(identificacao.texto_livre(p.descricao, usuario, sobre=de_quem.get(p.id))),
            prazo=p.prazo,
            atrasada=bool(p.prazo and p.atrasada(hoje)),
            responsavel=p.responsavel.nome if p.responsavel else None,
            onde=_onde(p, usuario),
        )
        for p in itens
    ]
    return contrato.Pendencias(
        abertas=len(linhas), atrasadas=sum(1 for l in linhas if l.atrasada), itens=linhas
    )


# =====================================================================
# O balcão de EPI
# =====================================================================
@rotas.get("/epis/servidores", response_model=list[contrato.ServidorResumo])
def servidores(request: Request, s: SessaoDep, usuario: UsuarioDep, q: str = ""):
    """Quem pode receber — a busca de `/epis/entregas/servidores`, em JSON.

    Mesma permissão do balcão (`epi.entregar`) e mesma RN-19 por linha: o
    SIAPE acha para todo mundo, o nome só acha para quem pode lê-lo.
    """
    usuario.exigir("epi.entregar")
    semente = identificacao.semente_de(request)
    saida = []
    for sv in servico_servidores.buscar(s, q, usuario):
        quem = identificacao.identificar(sv, usuario, semente)
        saida.append(contrato.ServidorResumo(id=sv.id, rotulo=quem.com_siape, nominal=quem.nominal))
    return saida


def _item_resumo(item: EpiItem) -> contrato.ItemResumo:
    return contrato.ItemResumo(
        id=item.id,
        nome=item.nome,
        unidade_medida=item.unidade_medida,
        quantidade_padrao=item.quantidade_padrao,
        quantidade_maxima=item.quantidade_maxima,
        regra_de_quantidade=item.regra_de_quantidade,
        tamanhos=list(item.lista_de_tamanhos),
        exige_ca=item.exige_ca,
        numero_ca=item.numero_ca,
        validade_ca=item.validade_ca,
    )


@rotas.get("/epis/itens", response_model=list[contrato.ItemResumo])
def itens(s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("epi.entregar")
    ativos = s.execute(
        select(EpiItem).where(EpiItem.ativo.is_(True)).order_by(EpiItem.nome)
    ).scalars()
    return [_item_resumo(item) for item in ativos]


@rotas.get("/epis/itens/{item_id}/lotes", response_model=list[contrato.LoteResumo])
def lotes(s: SessaoDep, usuario: UsuarioDep, item_id: int):
    """Os lotes do item, inclusive os impedidos — com o motivo escrito (RN-25).

    O lote com CA vencido não some da lista, pela mesma razão da tela: sumir
    seria saldo mudando sem rastro, e quem opera procuraria defeito no sistema.
    """
    usuario.exigir("epi.entregar")
    item = s.get(EpiItem, item_id)
    if item is None:
        raise RecusaDaApi(404, "Item não encontrado no catálogo.")
    return [
        contrato.LoteResumo(
            entrada_id=lote.entrada.id,
            rotulo=lote.rotulo,
            saldo=lote.saldo,
            impedimento=lote.impedimento,
            pode_sair=lote.pode_sair,
            tamanho=lote.entrada.tamanho,
            numero_ca=lote.entrada.numero_ca,
            validade_ca=lote.entrada.validade_ca,
        )
        for lote in epi_estoque.lotes_de(s, item)
    ]


@rotas.post(
    "/epis/entregas",
    response_model=contrato.EntregaRegistrada,
    status_code=201,
    dependencies=[SoFetch],
)
def registrar_entrega(s: SessaoDep, usuario: UsuarioDep, corpo: contrato.NovaEntrega):
    """A entrega inteira, pelo MESMO serviço do balcão — ficha, baixa de
    estoque e trilha numa transação. As três conferências de forma que a tela
    faz antes do serviço (quem recebe, item, data futura) são as mesmas aqui,
    com as mesmas frases; o resto — RN-24, RN-25, RN-26 — é do serviço."""
    usuario.exigir("epi.entregar")
    servidor = s.get(Servidor, corpo.servidor_id)
    if servidor is None:
        raise RecusaDaApi(422, "Escolha o servidor que vai receber o EPI.")
    item = s.get(EpiItem, corpo.item_id)
    if item is None:
        raise RecusaDaApi(422, "Escolha o item do catálogo.")
    entrada = s.get(EpiEntradaEstoque, corpo.entrada_id) if corpo.entrada_id else None
    if corpo.entrada_id and entrada is None:
        raise RecusaDaApi(422, "Lote de estoque não encontrado.")
    if corpo.data_evento and corpo.data_evento > date.today():
        raise RecusaDaApi(422, "A entrega não pode ter data futura.")
    try:
        registro = epi_ficha.registrar_entrega(
            s,
            usuario,
            servidor=servidor,
            item=item,
            quantidade=corpo.quantidade,
            entrada=entrada,
            tamanho=corpo.tamanho,
            data_evento=corpo.data_evento,
            observacao=corpo.observacao,
            justificativa_excecao=corpo.justificativa_excecao,
        )
    except (epi_ficha.EntregaBloqueada, TextoProibido) as falha:
        s.rollback()
        motivos = getattr(falha, "motivos", None) or [str(falha)]
        raise RecusaDaApi(422, "A entrega foi recusada.", list(motivos)) from falha
    s.commit()
    return contrato.EntregaRegistrada(
        registro_id=registro.id,
        servidor_id=servidor.id,
        ficha=f"/epis/fichas/{servidor.id}",
        comprovante=f"/epis/fichas/registros/{registro.id}/comprovante",
        mensagem=(
            f"Entrega registrada (registro {registro.id}). Imprima o comprovante, "
            "colha a assinatura e anexe o digitalizado."
        ),
    )


@rotas.get("/epis/fichas/{servidor_id}", response_model=contrato.Ficha)
def ficha(request: Request, s: SessaoDep, usuario: UsuarioDep, servidor_id: int):
    """A ficha do servidor — `epi.ficha` ou o próprio titular, como na tela."""
    epi_ficha.exigir_leitura_da_ficha(usuario, servidor_id)
    servidor = s.get(Servidor, servidor_id)
    if servidor is None:
        raise RecusaDaApi(404, "Servidor não encontrado.")
    # a MESMA linha de leitura nominal da tela (`/epis/fichas/{id}`): quem leu a
    # ficha de quem fica na trilha, pela API como pela tela — o campo e a
    # finalidade são os de lá, para a consulta de acesso não distinguir a porta
    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="epi_ficha",
        servidor_id=servidor.id,
        finalidade="consulta da ficha de EPI do servidor (API)",
    ):
        s.commit()
    quem = identificacao.identificar(servidor, usuario, identificacao.semente_de(request))
    hoje = date.today()
    linhas = []
    for linha in epi_ficha.linha_do_tempo(s, servidor_id):
        r = linha.registro
        linhas.append(
            contrato.LinhaFicha(
                registro_id=r.id,
                tipo=r.tipo,
                data=r.data_evento,
                epi=r.nome_epi_snapshot,
                quantidade=r.quantidade,
                tamanho=r.tamanho_snapshot,
                numero_ca=r.numero_ca_snapshot,
                validade_ca=r.validade_ca_snapshot,
                lote=r.lote_snapshot,
                previsao_troca=r.previsao_troca,
                estornado=linha.estornado,
                sem_comprovante=linha.sem_comprovante,
                ca_vencido=linha.ca_vencido_em(hoje),
                troca_vencida=linha.troca_vencida_em(hoje),
            )
        )
    return contrato.Ficha(
        servidor_id=servidor.id, servidor=quem.com_siape, nominal=quem.nominal, linhas=linhas
    )


# =====================================================================
# A chamada
# =====================================================================
def _turma_resumo(s, turma: Turma) -> contrato.TurmaResumo:
    return contrato.TurmaResumo(
        id=turma.id,
        codigo=turma.codigo,
        treinamento=turma.treinamento.nome,
        situacao=turma.situacao,
        data_inicio=turma.data_inicio,
        data_fim=turma.data_fim,
        dias=servico_presenca.dias_da_turma(turma),
        carga_efetiva=servico_presenca.numero(turma.carga_efetiva),
        inscritos=servico_turma.inscricoes_que_ocupam_vaga(s, turma),
    )


@rotas.get("/turmas", response_model=list[contrato.TurmaResumo])
def turmas(s: SessaoDep, usuario: UsuarioDep, situacao: str = "EM_ANDAMENTO"):
    """As turmas no escopo de quem pede, por situação — em andamento por padrão,
    que é a única em que se lança presença sem retificar."""
    usuario.exigir("turma.avaliar")
    if situacao not in ROTULO_TURMA:
        raise RecusaDaApi(422, f"Situação desconhecida: {situacao}.", sorted(ROTULO_TURMA))
    consulta = (
        servico_turma.consulta_no_escopo(usuario)
        .where(Turma.situacao == situacao)
        .order_by(Turma.data_inicio.desc())
    )
    return [_turma_resumo(s, turma) for turma in s.execute(consulta).scalars()]


def _linha_presenca(turma: Turma, linha, pode_nominal: bool) -> contrato.LinhaPresenca:
    participante = linha.inscricao.participante
    return contrato.LinhaPresenca(
        inscricao_id=linha.inscricao.id,
        participante=(
            participante.nome_exibicao if pode_nominal else participante.identificador_publico
        ),
        nominal=pode_nominal,
        por_dia={
            dia.isoformat(): contrato.PresencaDia(
                presente=p.presente, horas=servico_presenca.numero(p.horas)
            )
            for dia, p in linha.por_dia.items()
        },
        horas=servico_presenca.numero(linha.horas),
        frequencia=servico_presenca.numero(linha.frequencia),
        aprovado=linha.avaliacao.aprovado,
        situacao=ROTULO_INSCRICAO.get(linha.inscricao.situacao, linha.inscricao.situacao),
    )


def _grade(s, turma: Turma, usuario) -> contrato.GradePresenca:
    # a grade e a lista de chamada transcrita: nomeia a mesma gente que a aba de
    # inscricoes, e a permissao que a abre e a que baixa a folha nominal (.docx)
    pode_nominal = usuario.pode("turma.avaliar")
    return contrato.GradePresenca(
        turma_id=turma.id,
        codigo=turma.codigo,
        dias=servico_presenca.dias_da_turma(turma),
        carga_efetiva=servico_presenca.numero(turma.carga_efetiva),
        retificando=turma.situacao != "EM_ANDAMENTO",
        linhas=[
            _linha_presenca(turma, linha, pode_nominal)
            for linha in servico_presenca.grade_da_turma(s, turma)
        ],
    )


@rotas.get("/turmas/{turma_id}/presencas", response_model=contrato.GradePresenca)
def grade(s: SessaoDep, usuario: UsuarioDep, turma_id: int):
    usuario.exigir("turma.avaliar")
    turma = servico_turma.no_escopo(s, usuario, turma_id)
    if turma is None:
        raise RecusaDaApi(404, "Turma não encontrada ou fora do seu escopo.")
    return _grade(s, turma, usuario)


@rotas.post(
    "/turmas/{turma_id}/presencas",
    response_model=contrato.GradePresenca,
    dependencies=[SoFetch],
)
def lancar_presenca(
    s: SessaoDep, usuario: UsuarioDep, turma_id: int, corpo: contrato.NovaPresenca
):
    """Um dia, um inscrito — pelo MESMO serviço da grade. Relançar corrige.

    Devolve a grade inteira, e não só a linha: no celular a lista é a folha do
    dia, e a frequência de quem acabou de ser marcado muda ao lado do nome.
    """
    usuario.exigir("turma.avaliar")
    turma = servico_turma.no_escopo(s, usuario, turma_id)
    if turma is None:
        raise RecusaDaApi(404, "Turma não encontrada ou fora do seu escopo.")
    inscricao = next(
        (i for i in servico_turma.inscricoes_da_turma(s, turma) if i.id == corpo.inscricao_id),
        None,
    )
    if inscricao is None:
        raise RecusaDaApi(422, "Inscrição não encontrada nesta turma.")
    horas = None
    if corpo.horas.strip():
        try:
            horas = servico_presenca.para_decimal(corpo.horas.replace(",", "."))
        except Exception as erro:  # noqa: BLE001 - a frase é da rota, como na tela
            raise RecusaDaApi(422, "Horas do dia inválidas: informe um número.") from erro
    try:
        servico_presenca.lancar_presenca(
            s,
            usuario,
            inscricao,
            data=corpo.data,
            presente=corpo.presente,
            horas=horas,
            justificativa=corpo.justificativa.strip() or None,
            motivo=corpo.motivo.strip() or None,
        )
    except ValueError as erro:
        # RegraDaTurma e TransicaoInvalida sao ValueError; a frase e a do servico
        s.rollback()
        raise RecusaDaApi(422, "O lançamento foi recusado.", [str(erro)]) from erro
    s.commit()
    return _grade(s, turma, usuario)
