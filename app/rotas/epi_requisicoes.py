"""/epis/requisicoes — o pedido formal de EPI: fila, formulário e análise.

Fatia 4 do desenho (`entrada/integrasst/desenho_epi.md`, §9). Está separada de
`epi_fichas.py` e de `epi_estoque.py` pela mesma razão que separa aquelas duas:
uma tela é a prova de entrega, outra é o que existe na prateleira, e esta é o
trâmite — o documento com protocolo, prazo e decisão fundamentada.

Quatro coisas que estas telas existem para tornar visíveis, e que o "requisição"
do legado não tornava:

1. **A decisão é POR ITEM, e a tela mostra isso.** Aprovar a luva e recusar o
   respirador do mesmo pedido é o caso comum; a tela do legado já fazia, e a
   máquina dele é que não acompanhava. Aqui cada linha carrega o próprio estado,
   a própria quantidade aprovada e o próprio motivo congelado.
2. **A recusa é um seletor, nunca uma caixa vazia.** O motivo vem do catálogo, o
   texto que vai sair para o requerente aparece embaixo da escolha antes de
   alguém clicar, e a caixa de complemento só surge quando o motivo a exige. É o
   que faz a negativa sair fundamentada sem depender da memória de quem está com
   pressa.
3. **O bloqueio da RN-26 tem caminho de saída na própria tela.** Estourar a
   janela não é bloqueio duro: o formulário já traz a caixa de autorização e a
   justificativa ao lado do erro, dizendo por escrito que quem marcar assume o
   nome. Erro sem caminho de saída é o que faz o analista resolver o caso por
   fora do sistema.
4. **CA vencido é etiqueta vermelha e botão desabilitado COM o motivo ao lado.**
   Botão que some sem explicação faz quem opera procurar defeito no sistema —
   mesma disciplina de `/epis/entregas/nova`.

**O que estas rotas deliberadamente não oferecem:** botão para `EM_ATENDIMENTO`
e para `ATENDIDA`. As duas transições são do sistema (`sincronizar_atendimento`),
e um botão para elas produziria o defeito que o §4.1 do desenho aponta em
"liberada": um estado que a tela mostra e que não corresponde a fato nenhum.
"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import desc, or_, select

from app.config import obter_config
from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    EpiEntradaEstoque,
    EpiItem,
    EpiMotivoRecusa,
    EpiRequisicao,
    EpiRequisicaoItem,
    HistoricoEvento,
    Servidor,
    Usuario,
)
from app.modelos.epi import FINALIDADES_REQUISICAO, URGENCIAS_REQUISICAO
from app.modelos.estados import (
    EPI_REQUISICAO_CANCELAVEL,
    ROTULO_EPI_ITEM,
    ROTULO_EPI_REQUISICAO,
    TransicaoInvalida,
)
from app.servicos import auditoria, epi_estoque, epi_ficha, identificacao, textos
from app.servicos import epi_requisicao as servico
from app.servicos import servidores as servico_servidores
from app.servicos.rbac import PermissaoNegada
from app.servicos.textos import TextoProibido
from app.web import fragmento, pagina

rotas = APIRouter(tags=["epis"])

FILA = "/epis/requisicoes"
NOVA = "/epis/requisicoes/nova"

# Rótulo da finalidade e da urgência na tela. Ficam aqui, e não no template,
# porque o vocabulário fechado mora em `modelos/epi.py` em ASCII (ele vai para o
# `CHECK` do banco) e a tela escreve "Substituição" com cedilha.
ROTULO_FINALIDADE: dict[str, str] = {
    "PRIMEIRA_ENTREGA": "Primeira entrega",
    "ROTINA": "Reposição de rotina",
    "SUBSTITUICAO": "Substituição por desgaste",
    "DANO": "Dano",
    "PERDA": "Perda",
}

ROTULO_URGENCIA: dict[str, str] = {"NORMAL": "Normal", "URGENTE": "Urgente"}


def _aviso(
    destino: str, campo: str, mensagem: str, *, ancora: str = ""
) -> RedirectResponse:
    """O recado vai codificado na query string.

    As mensagens daqui carregam texto digitado — nome de item de catálogo,
    complemento da recusa, lote —, e `&`, `#` ou `%` no meio dele encerrava a
    query string ali: o recado chegava cortado exatamente na palavra que a
    pessoa escreveu. `quote_via=quote` e não o `+` padrão porque quem lê o
    `Location` só desfaz `%XX`, e "Escolha+o+lote" não é português.

    A ÂNCORA VAI DEPOIS DA QUERY STRING, e por isso é parâmetro daqui: o
    fragmento encerra a URL, e `#itens&mensagem=…` faria o recado virar parte do
    nome da âncora. Ela existe porque a ficha do pedido é longa — o cartão de
    trâmite, a lista de itens, o cartão de acrescentar e a trilha —, e um 303
    para o topo devolve à primeira tela quem estava decidindo o sétimo item.
    """
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    separador = "&" if "?" in destino else "?"
    return RedirectResponse(f"{destino}{separador}{parametros}{ancora}", status_code=303)


def _volta(destino: str, mensagem: str, *, ancora: str = "") -> RedirectResponse:
    return _aviso(destino, "mensagem", mensagem, ancora=ancora)


def _erro(destino: str, mensagem: str, *, ancora: str = "") -> RedirectResponse:
    return _aviso(destino, "erro", mensagem, ancora=ancora)


# O destino do 303 das ações de item: a lista de itens, e não o topo da ficha.
ANCORA_ITENS = "#itens-do-pedido"


def _motivos(falha: Exception) -> str:
    """A lista inteira de motivos, e não o primeiro.

    Mesmo formato de `/epis/estoque` e de `/epis/entregas`: quem está
    preenchendo precisa saber tudo o que falta numa passada, e não descobrir um
    problema por tentativa.
    """
    return " · ".join(getattr(falha, "motivos", None) or [str(falha)])


def _recusa(destino: str, falha: Exception) -> RedirectResponse:
    return _erro(destino, _motivos(falha))


# =====================================================================
# A troca parcial da lista de itens
# =====================================================================
# São seis formulários por linha — aprovar, recusar, cancelar, reservar, marcar
# sem estoque e soltar reserva —, e cada um era um POST com recarga de página
# inteira: um pedido de dez itens custava dez recargas para ser aprovado, cada
# uma voltando ao topo de uma ficha longa. A conta que torna isto barato foi
# paga na 1.27.0 — o tratador global dos três estados da troca parcial em
# `base.html` vale para todo `hx-*` sem marcação nova.
#
# O ALVO É A SEÇÃO INTEIRA, e não a linha: a pílula "N sem decisão" do cabeçalho
# conta as linhas pendentes, e trocar só a `<tr>` a deixaria mentindo ao lado da
# decisão recém-tomada. O argumento longo está em `partes/itens_do_pedido.html`,
# junto com o motivo de a ENTREGA continuar fora disto.
#
# `HX-Request` decide o formato, e não uma rota separada: sem JavaScript a mesma
# rota responde o 303 de sempre. Duas rotas para a mesma ação dariam duas
# guardas de permissão para manter, e a segunda é a que esquece.
def _e_htmx(request: Request) -> bool:
    return request.headers.get("HX-Request") == "true"


def _secao_dos_itens(
    request: Request,
    s,
    usuario,
    requisicao: EpiRequisicao,
    *,
    recusa: str | None = None,
    linha_id: int | None = None,
):
    """A lista de itens do pedido, pronta para substituir a que está na tela.

    Monta o MESMO subconjunto de contexto que `_tela_ficha` monta para a ficha
    inteira — lotes candidatos, reserva de cada linha e o impedimento dela hoje.
    Reusar as expressões, e não escrever uma segunda versão "mais leve", é o que
    impede o fragmento de discordar da página que ele está dentro: o CA
    reconferido na data de hoje (RN-25, segundo momento) é justamente o tipo de
    conta que uma cópia esqueceria.
    """
    hoje = date.today()
    lotes = {
        linha.id: epi_estoque.lotes_de(
            s, linha.item, quando=hoje, tamanho=linha.tamanho or None
        )
        for linha in requisicao.itens
        if linha.estado in ("APROVADO", "RESERVADO", "SEM_ESTOQUE")
    }
    reservas = {
        linha.id: s.get(EpiEntradaEstoque, linha.entrada_id)
        for linha in requisicao.itens
        if linha.estado == "RESERVADO" and linha.entrada_id
    }
    return fragmento(
        request,
        "partes/itens_do_pedido.html",
        usuario=usuario,
        requisicao=requisicao,
        itens=requisicao.itens,
        hoje=hoje,
        rotulos=ROTULO_EPI_REQUISICAO,
        rotulos_item=ROTULO_EPI_ITEM,
        motivos=_motivos_ativos(s),
        lotes=lotes,
        reservas=reservas,
        reservas_impedidas={
            linha_id: epi_estoque.impedimento_do_lote(
                entrada, _item_da_linha(requisicao, linha_id), hoje
            )
            for linha_id, entrada in reservas.items()
        },
        nomes=_nomes_de(
            s,
            [linha.decidido_por for linha in requisicao.itens]
            + [linha.autorizado_por for linha in requisicao.itens],
        ),
        editavel=requisicao.estado in servico.EDITAVEL,
        pode_requisitar=usuario.pode("epi.requisitar"),
        pode_analisar=usuario.pode("epi.analisar"),
        pode_entregar=usuario.pode("epi.entregar"),
        pode_estocar=usuario.pode("epi.estoque"),
        # A GAVETA DA LINHA QUE FOI RECUSADA REABRE. A troca redesenha a seção
        # inteira, e com ela os `<details class="acoes-linha">` de todas as
        # linhas — que nascem fechados. Quem clicou "Aprovar" dentro de uma
        # gaveta e recebeu o motivo da recusa ficaria olhando a lista com a
        # gaveta fechada, e teria de reabri-la para achar o campo a corrigir. É
        # o mesmo `d.forma` que a recusa sem JavaScript já usa; aqui ele volta
        # sem os campos, porque o que a pessoa digitou está na recusa e o resto
        # a linha já traz gravado.
        digitado={"forma": f"item-{linha_id}"} if linha_id is not None else {},
        recusa=recusa,
    )


def _parcial_ou_erro(
    request: Request,
    s,
    usuario,
    requisicao: EpiRequisicao,
    mensagem: str,
    parcial: bool,
    linha_id: int | None = None,
):
    """A recusa, no formato de quem chamou.

    Em HTMX ela volta em **200** com o motivo escrito no topo da seção que a
    pessoa estava olhando; sem HTMX, no 303 e na faixa vermelha de sempre.
    Devolver 4xx no caminho parcial faria o tratador global de `base.html`
    escrever "não deu para atualizar este trecho (erro 422)" por cima de um
    motivo que o serviço sabe dizer com todas as letras — e é justamente o texto
    do motivo que diz o que fazer a seguir.
    """
    if parcial:
        return _secao_dos_itens(
            request, s, usuario, requisicao, recusa=mensagem, linha_id=linha_id
        )
    return _erro(_ficha(requisicao.id), mensagem, ancora=ANCORA_ITENS)


def _inteiro(bruto: str) -> int | None:
    limpo = (bruto or "").strip()
    return int(limpo) if limpo.isdigit() else None


def _marcado(valor: str) -> bool:
    return valor == "1"


def _ficha(requisicao_id: int) -> str:
    return f"{FILA}/{requisicao_id}"


def _itens_ativos(s) -> list[EpiItem]:
    return list(
        s.execute(
            select(EpiItem).where(EpiItem.ativo.is_(True)).order_by(EpiItem.nome)
        ).scalars()
    )


def _motivos_ativos(s) -> list[EpiMotivoRecusa]:
    return list(
        s.execute(
            select(EpiMotivoRecusa)
            .where(EpiMotivoRecusa.ativo.is_(True))
            .order_by(EpiMotivoRecusa.rotulo)
        ).scalars()
    )


def _nomes_de(s, ids) -> dict[int, str]:
    """`{usuario_id: nome}` para a ficha. Uma consulta, não uma por linha.

    O nome, e não o id: "analisado por 4" não é informação para quem lê a
    decisão depois — e é a decisão que se tem de poder defender.
    """
    alvos = {i for i in ids if i is not None}
    if not alvos:
        return {}
    return {
        u.id: u.nome
        for u in s.execute(select(Usuario).where(Usuario.id.in_(alvos))).scalars()
    }


# =====================================================================
# A busca da fila — e o que ela recusa
# =====================================================================
# A detecção de CPF mora em `textos.parece_cpf`: onze dígitos seguidos só podem
# ser uma coisa nesta casa, e essa coisa não existe aqui. A saída continua sendo
# desta tela, porque as chaves que ela oferece são as dela — responder "nada
# encontrado" deixaria a pessoa concluindo que não há pedido, quando o que não
# existe é a busca.
RECADO_CPF = (
    "A busca não aceita CPF: o sistema não armazena CPF em campo nenhum "
    "(decisão 1 do desenho — quem pede EPI é servidor, e servidor se identifica "
    "por SIAPE). Procure pelo protocolo, pelo nome, pelo SIAPE ou pelo e-mail."
)


def _casa_a_busca(requisicao: EpiRequisicao, alvo: str, usuario) -> bool:
    """Protocolo para todo mundo; a identificação do servidor pela regra da RN-19.

    O protocolo é a chave do documento e não nomeia ninguém. Do servidor em
    diante quem decide é `identificacao.casa_a_busca`, que é a mesma regra de
    `/servidores` e da busca global — e que existe justamente para não haver uma
    terceira leitura do que "casar por nome" pode revelar.
    """
    if alvo in textos.chave_busca(requisicao.protocolo or ""):
        return True
    return identificacao.casa_a_busca(alvo, requisicao.servidor, usuario)


# =====================================================================
# A fila
# =====================================================================
@rotas.get(FILA)
def fila(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    q: str = "",
    estado: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    """Abre em leitura para quem tem `epi.ver`; pedir e decidir pedem as suas."""
    usuario.exigir("epi.ver")
    estados = (estado,) if estado in ROTULO_EPI_REQUISICAO else ()
    linhas = servico.fila(s, usuario, estados=estados)

    recado = erro
    if q.strip():
        if textos.parece_cpf(q):
            linhas = []
            recado = recado or RECADO_CPF
        else:
            alvo = textos.chave_busca(q)
            linhas = [r for r in linhas if _casa_a_busca(r, alvo, usuario)]

    return pagina(
        request,
        "paginas/epis_requisicoes.html",
        usuario=usuario,
        linhas=linhas,
        q=q,
        estado=estado,
        # §9 pede as requisições por estado no painel do módulo; enquanto `/epis`
        # não existe, a contagem mora onde ela é operacional — em cima da própria
        # fila, e cada número é o filtro que leva às linhas dele.
        resumo=servico.resumo_de_estados(s, usuario),
        rotulos=ROTULO_EPI_REQUISICAO,
        rotulos_finalidade=ROTULO_FINALIDADE,
        # dias parados, calculado agora e nunca gravado — a mesma escolha de
        # `EpiItem.ca_vencido_em`: estado gravado é estado que envelhece em
        # silêncio
        dias={r.id: servico.prazo_em_analise(r) for r in linhas},
        hoje=date.today(),
        pode_requisitar=usuario.pode("epi.requisitar"),
        pode_analisar=usuario.pode("epi.analisar"),
        mensagem=mensagem,
        erro=recado,
    )


# =====================================================================
# O formulário do pedido
#
# Declarado ANTES de `/epis/requisicoes/{requisicao_id}`: o roteador atende na
# ordem em que se declara, e "nova" não converte para `int` — a rota da ficha
# responderia 422 em vez de a rota certa atender. Mesmo cuidado que
# `/epis/fichas/registros` já toma em `epi_fichas.py`.
# =====================================================================
@rotas.get(NOVA)
def formulario(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    q: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("epi.requisitar")
    return _tela_nova(request, s, usuario, q=q, mensagem=mensagem, erro=erro)


def _tela_nova(
    request,
    s,
    usuario,
    *,
    q: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A tela do pedido novo, em branco ou com o que foi digitado de volta.

    Uma função só para a abertura limpa e para a recusa que reabre a tela, pelo
    mesmo motivo de `processos._tela_novo`: duplicá-las é o que faz a recusa
    esquecer metade dos campos. `digitado` não entra na assinatura da rota GET —
    dicionário em parâmetro de rota o FastAPI leria como corpo, e esta rota não
    tem corpo.
    """
    return pagina(
        request,
        "paginas/epis_requisicao_nova.html",
        usuario=usuario,
        servidores=_busca_de_servidores(s, q, usuario),
        nota=NOTA_SERVIDOR,
        q=q,
        finalidades=[(c, ROTULO_FINALIDADE.get(c, c)) for c in FINALIDADES_REQUISICAO],
        urgencias=[(c, ROTULO_URGENCIA.get(c, c)) for c in URGENCIAS_REQUISICAO],
        digitado=digitado or {},
        mensagem=mensagem,
        erro=erro,
    )


# A nota de rodapé do seletor. Sai daqui e não do fragmento porque o fragmento
# passou a servir DUAS telas — o pedido e o balcão —, e a RN-28 é assunto do
# pedido: no balcão ela não tem o que dizer. Vive num nome só porque a página e a
# rota HTMX da busca escrevem a mesma linha, e duas grafias divergiriam no
# primeiro conserto.
NOTA_SERVIDOR = (
    "A RN-28 não se aplica a quem digita, e sim a quem vai usar: "
    "a chefia pode abrir o pedido da equipe."
)


def _busca_de_servidores(s, q: str, usuario) -> list[Servidor]:
    """Quem pode receber o EPI, filtrado pela mesma regra de `/servidores`.

    O corpo desta função virou `servicos.servidores.buscar`: ela era a QUARTA
    escrita da RN-19 do lado do filtro, e a única das quatro que não casava
    e-mail institucional — uma divergência que ninguém tinha como notar, porque
    nada ligava as quatro. O nome fica como ponte para as chamadas desta tela.
    """
    return servico_servidores.buscar(s, q, usuario)


@rotas.get("/epis/requisicoes/servidores")
def buscar_servidor(request: Request, s: SessaoDep, usuario: UsuarioDep, q: str = ""):
    """Fragmento HTMX: a busca de servidor sem recarregar o formulário.

    Recarregar a página inteira a cada tentativa perderia a rotina de trabalho e
    os riscos já digitados — que são os campos longos deste formulário. Mesma
    técnica do seletor de item de `/epis/entregas/nova`.
    """
    usuario.exigir("epi.requisitar")
    return fragmento(
        request,
        "partes/epi_requisicao_servidores.html",
        usuario=usuario,
        servidores=_busca_de_servidores(s, q, usuario),
        nota=NOTA_SERVIDOR,
        q=q,
    )


@rotas.get("/epis/requisicoes/item-opcoes")
def opcoes_do_item(
    request: Request, s: SessaoDep, usuario: UsuarioDep, item_id: str = ""
):
    """Fragmento HTMX: escolhido o item, aparecem quantidade, tamanhos e a RN-29.

    A justificativa só surge quando `exige_justificativa` está marcado no
    catálogo — e surge no ato da escolha, e não no envio: descobrir no `enviar`
    que faltava a justificativa manda a pessoa de volta a uma linha que ela já
    achava pronta.
    """
    usuario.exigir("epi.requisitar")
    item = s.get(EpiItem, int(item_id)) if item_id.strip().isdigit() else None
    return fragmento(
        request,
        "partes/epi_requisicao_opcoes.html",
        item=item,
        hoje=date.today(),
    )


@rotas.get("/epis/requisicoes/item-saldo")
def saldo_do_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    item_id: str = "",
    tamanho: str = "",
):
    """Fragmento HTMX: escolhido o tamanho, o saldo daquele tamanho.

    "40 luvas" não quer dizer nada se são todas P (§12.4 do desenho). O saldo
    aqui é informativo — pedir não reserva nada, e a fatia 4 não tem reserva —,
    mas é ele que evita o pedido que o setor já sabe que não terá como atender.
    """
    usuario.exigir("epi.requisitar")
    item = s.get(EpiItem, int(item_id)) if item_id.strip().isdigit() else None
    limpo = (tamanho or "").strip()
    return fragmento(
        request,
        "partes/epi_requisicao_saldo.html",
        item=item,
        tamanho=limpo,
        lotes=(
            epi_estoque.lotes_de(s, item, tamanho=limpo or None)
            if item is not None
            else []
        ),
        hoje=date.today(),
    )


@rotas.post(FILA)
def criar_rascunho(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    # `Form("")` e não `Form(...)` nos obrigatórios: campo de texto vazio o
    # FastAPI trata como AUSENTE e responde 422 em JSON, que é o que a pessoa
    # veria no lugar da tela. Quem cobra o obrigatório é o serviço, que devolve o
    # motivo escrito em português.
    servidor_id: str = Form(""),
    chefia_servidor_id: str = Form(""),
    finalidade: str = Form("ROTINA"),
    descricao_atividade: str = Form(""),
    riscos_declarados: str = Form(""),
    urgencia: str = Form("NORMAL"),
    justificativa_urgencia: str = Form(""),
    # a caixa de busca do servidor mora dentro do formulário e vem no POST:
    # devolvê-la é o que faz a lista voltar filtrada como estava
    q: str = Form(""),
):
    """O rascunho. **Não consome protocolo** — quem o consome é o envio (RN-03)."""
    usuario.exigir("epi.requisitar")
    # Tudo o que foi digitado, guardado antes da primeira recusa — o padrão de
    # `processos.criar`. Aqui o custo é o maior do módulo: "Rotina de trabalho" e
    # "Riscos declarados" são dois textos longos, e o comentário do template já
    # dizia que recarregar a página os perderia. O caminho de erro fazia
    # exatamente isso, e quem redigita escreve menos na segunda vez — justo os
    # dois campos que fundamentam a decisão de quem vai analisar.
    digitado = {
        "servidor_id": servidor_id,
        "chefia_servidor_id": chefia_servidor_id,
        "finalidade": finalidade,
        "descricao_atividade": descricao_atividade,
        "riscos_declarados": riscos_declarados,
        "urgencia": urgencia,
        "justificativa_urgencia": justificativa_urgencia,
    }
    servidor = s.get(Servidor, int(servidor_id)) if servidor_id.strip().isdigit() else None
    if servidor is None:
        return _tela_nova(
            request,
            s,
            usuario,
            q=q,
            erro="Escolha o servidor que vai usar o equipamento.",
            digitado=digitado,
        )
    chefia = (
        s.get(Servidor, int(chefia_servidor_id))
        if chefia_servidor_id.strip().isdigit()
        else None
    )
    try:
        requisicao = servico.criar_rascunho(
            s,
            usuario,
            servidor=servidor,
            chefia_servidor_id=chefia.id if chefia else None,
            finalidade=finalidade,
            descricao_atividade=descricao_atividade,
            riscos_declarados=riscos_declarados,
            urgencia=urgencia,
            justificativa_urgencia=justificativa_urgencia,
        )
    except (servico.RequisicaoBloqueada, TextoProibido) as falha:
        s.rollback()
        return _tela_nova(
            request, s, usuario, q=q, erro=_motivos(falha), digitado=digitado
        )
    s.commit()
    return _volta(
        _ficha(requisicao.id),
        "Rascunho aberto. Acrescente os itens e envie — o protocolo é consumido "
        "no envio, e rascunho abandonado não gasta número.",
    )


# =====================================================================
# A ficha do pedido
# =====================================================================
def _requisicao(s, usuario, requisicao_id: int) -> EpiRequisicao | None:
    """A requisição desta URL, no escopo de quem pediu — ou `None`.

    Era `s.get(EpiRequisicao, id)` puro, e por isso `aplicar_escopo` não era
    chamado **uma única vez** neste módulo, contra o que `desenho_epi.md:1129`,
    `rbac.py:389` e `modulos.py:149` afirmavam. Toda rota do módulo passa por
    aqui — leitura e escrita —, e é isso que faz a regra valer para a próxima
    rota também: quem escreveu a decisão de item nunca precisou lembrar dela.
    """
    return servico.no_escopo(s, usuario, requisicao_id)


def _linha(s, usuario, requisicao_id: int, linha_id: int) -> EpiRequisicaoItem | None:
    """A linha, conferida contra a requisição da URL — e contra o escopo dela.

    Sem a conferência, `/requisicoes/7/itens/99` decidiria a linha do pedido 12 a
    partir da tela do pedido 7 — e a trilha registraria a decisão no lugar certo,
    o que tornaria o engano invisível para quem lesse depois.

    O escopo vem por `_requisicao`, e não por uma segunda regra escrita aqui:
    hoje toda rota que chega por este caminho exige `epi.analisar`, `epi.estoque`
    ou `epi.entregar`, que nenhum perfil de escopo próprio tem — mas amarrar a
    linha ao pedido alcançável é o que faz a próxima permissão do módulo nascer
    fechada em vez de repetir esta correção.
    """
    if _requisicao(s, usuario, requisicao_id) is None:
        return None
    linha = s.get(EpiRequisicaoItem, linha_id)
    if linha is None or linha.requisicao_id != requisicao_id:
        return None
    return linha


def _item_da_linha(requisicao: EpiRequisicao, linha_id: int) -> EpiItem:
    """O item do catálogo de uma linha já carregada. Sem ida ao banco.

    `requisicao.itens` vem com `lazy="selectin"` e `EpiRequisicaoItem.item`
    também: procurar na coleção é de graça, e um `s.get` por linha aqui seria uma
    consulta por item da tela para chegar ao mesmo objeto.
    """
    return next(linha.item for linha in requisicao.itens if linha.id == linha_id)


def _trilha(s, requisicao: EpiRequisicao) -> list[HistoricoEvento]:
    """O envelope e os itens na mesma linha do tempo.

    Duas máquinas, uma história: separar as trilhas obrigaria quem lê a
    intercalar duas listas de cabeça para responder "o que aconteceu com este
    pedido", que é a única pergunta que se faz aqui.
    """
    ids_de_item = [linha.id for linha in requisicao.itens]
    condicao = (HistoricoEvento.entidade == servico.ENTIDADE) & (
        HistoricoEvento.entidade_id == requisicao.id
    )
    if ids_de_item:
        condicao = or_(
            condicao,
            (HistoricoEvento.entidade == servico.ENTIDADE_ITEM)
            & (HistoricoEvento.entidade_id.in_(ids_de_item)),
        )
    return list(
        s.execute(
            select(HistoricoEvento)
            .where(condicao)
            .order_by(desc(HistoricoEvento.ocorrido_em), desc(HistoricoEvento.id))
        ).scalars()
    )


@rotas.get(FILA + "/{requisicao_id}")
def ficha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    """O pedido inteiro: contexto congelado, decisão por item, trilha embaixo.

    Layout de `processo_ficha.html` (§9): cabeçalho com a identificação e a
    pílula do estado, dados congelados de um lado, ações do outro, e a linha do
    tempo no fim. É a mesma pergunta que as duas telas respondem — em que ponto
    isto está, e por quê —, e responder com dois desenhos diferentes obrigaria
    quem opera os dois módulos a reaprender a leitura.
    """
    usuario.exigir("epi.ver")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)

    # A fila não registra e esta tela registra, e a diferença é a pergunta que
    # cada uma responde. A fila mostra identificação já suprimida pela RN-19, e
    # uma linha por pessoa por abertura de tela afogaria o sinal; aqui a URL
    # nomeia UMA pessoa, e o que se lê dela é cargo, unidade, rotina de trabalho
    # e os riscos que ela mesma declarou — o texto que o `docs/ROPA.md` §0.2
    # identifica como onde dado de saúde entra por engano. É desta linha que sai
    # a resposta do art. 37: quem abriu a ficha de quantas pessoas.
    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="epi_requisicao.nominal",
        servidor_id=requisicao.servidor_id,
        finalidade=(
            "consulta da requisição de EPI — rotina de trabalho e riscos "
            "declarados pelo requerente"
        ),
    ):
        # grava e solta: a leitura não pode segurar o `BEGIN IMMEDIATE` que a
        # transação da requisição já tomou no SELECT do cookie (RN-03)
        s.commit()

    return _tela_ficha(request, s, usuario, requisicao, mensagem=mensagem, erro=erro)


def _tela_ficha(
    request: Request,
    s,
    usuario,
    requisicao: EpiRequisicao,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
    item_escolhido: EpiItem | None = None,
):
    """A ficha, em leitura ou com o que foi digitado de volta.

    Uma função só para os dois casos, como `processos._tela_novo`: a recusa que
    redesenha a tela e a abertura normal. Duplicá-las é o que faz a recusa
    esquecer metade do contexto — e aqui o contexto são vinte e poucas variáveis.

    `digitado` traz uma FORMA e os campos dela (`{"forma": "cabecalho", ...}`).
    Esta tela tem cerca de vinte formulários, e um dicionário plano faria o texto
    de um reaparecer dentro do outro: quem tentasse editar a linha 7 e fosse
    recusado veria a justificativa dela também na linha 3 e no cartão de
    acrescentar. A forma é o que diz de qual formulário aquele texto voltou.
    """
    hoje = date.today()
    pode_entregar = usuario.pode("epi.entregar")
    # O lote candidato aparece ao lado do item para QUEM LÊ, e não só para quem
    # entrega (§9): saldo e CA do lote são a diferença entre uma aprovação que
    # vai virar equipamento na mão da pessoa e uma que vai ficar esperando
    # compra — e quem analisou precisa dessa informação tanto quanto quem separa
    # a caixa. Saldo de bota não nomeia ninguém, e já abre em `/epis/estoque`
    # para o mesmo `epi.ver`.
    #
    # Só das linhas que ainda esperam alguma coisa da prateleira: montar para
    # item recusado, cancelado ou já entregue seria consulta de estoque para
    # decidir nada.
    lotes = {
        linha.id: epi_estoque.lotes_de(
            s, linha.item, quando=hoje, tamanho=linha.tamanho or None
        )
        for linha in requisicao.itens
        if linha.estado in ("APROVADO", "RESERVADO", "SEM_ESTOQUE")
    }
    reservas = {
        linha.id: s.get(EpiEntradaEstoque, linha.entrada_id)
        for linha in requisicao.itens
        if linha.estado == "RESERVADO" and linha.entrada_id
    }
    return pagina(
        request,
        "paginas/epis_requisicao_ficha.html",
        usuario=usuario,
        requisicao=requisicao,
        itens=requisicao.itens,
        hoje=hoje,
        dias_no_estado=servico.prazo_em_analise(requisicao),
        rotulos=ROTULO_EPI_REQUISICAO,
        rotulos_item=ROTULO_EPI_ITEM,
        rotulo_finalidade=ROTULO_FINALIDADE.get(
            requisicao.finalidade, requisicao.finalidade
        ),
        rotulo_urgencia=ROTULO_URGENCIA.get(requisicao.urgencia, requisicao.urgencia),
        finalidades=[(c, ROTULO_FINALIDADE.get(c, c)) for c in FINALIDADES_REQUISICAO],
        urgencias=[(c, ROTULO_URGENCIA.get(c, c)) for c in URGENCIAS_REQUISICAO],
        catalogo=_itens_ativos(s),
        motivos=_motivos_ativos(s),
        lotes=lotes,
        nomes=_nomes_de(
            s,
            [requisicao.analisado_por, requisicao.solicitado_por_id]
            + [linha.decidido_por for linha in requisicao.itens]
            + [linha.autorizado_por for linha in requisicao.itens],
        ),
        eventos=_trilha(s, requisicao),
        servidores=list(s.execute(select(Servidor).order_by(Servidor.nome)).scalars()),
        editavel=requisicao.estado in servico.EDITAVEL,
        # o estado admite cancelar E nada saiu ainda: o que foi entregue não se
        # desfaz por cancelamento, e oferecer o botão assim mesmo seria a porta
        # trancada que o menu do sistema já aprendeu a não oferecer
        cancelavel=(
            requisicao.estado in EPI_REQUISICAO_CANCELAVEL
            and not any(linha.quantidade_entregue > 0 for linha in requisicao.itens)
        ),
        pode_requisitar=usuario.pode("epi.requisitar"),
        pode_analisar=usuario.pode("epi.analisar"),
        pode_entregar=pode_entregar,
        # reservar, soltar reserva e marcar falta de estoque são do almoxarifado
        # (§4.3), e não de quem analisa: quem decide o direito ao item não é quem
        # promete a caixa da prateleira
        pode_estocar=usuario.pode("epi.estoque"),
        # o lote em que cada item está reservado, para a tela dizer QUAL é sem
        # uma consulta por linha dentro do template
        reservas=reservas,
        # e o impedimento DELE hoje, conferido de novo: entre a reserva e o
        # balcão o CA pode ter vencido (RN-25, segundo momento). É este texto que
        # explica o botão desabilitado — botão que some sem explicação faz quem
        # opera procurar defeito no sistema.
        reservas_impedidas={
            linha_id: epi_estoque.impedimento_do_lote(
                entrada, _item_da_linha(requisicao, linha_id), hoje
            )
            for linha_id, entrada in reservas.items()
        },
        # ONDE RETIRAR. A ficha dizia o lote e o CA e não dizia a que porta ir —
        # a auditoria da jornada procurou "retirada", "balcão" e "almoxarifado"
        # no corpo da página e não achou nenhum dos três. O sistema não sabia
        # responder: não há coluna de localização em lote nenhum, e o endereço do
        # setor emissor é o de quem assina parecer, não o do balcão. É parâmetro
        # de instalação (`CSSO_EPI_LOCAL_RETIRADA`), e vazio a tela diz que não
        # sabe em vez de inventar endereço.
        local_retirada=obter_config().epi_local_retirada.strip(),
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
        # o item que a pessoa tinha escolhido quando a gravação foi recusada:
        # sem ele o bloco `#opcoes-do-item` — que na tela é preenchido por HTMX
        # ao trocar o seletor — voltaria vazio, e a quantidade, o tamanho e a
        # justificativa não teriam onde reaparecer.
        item_escolhido=item_escolhido,
    )


@rotas.get(FILA + "/{requisicao_id}/guia")
def guia_de_entrega(
    request: Request, s: SessaoDep, usuario: UsuarioDep, requisicao_id: int
):
    """A guia de entrega, para imprimir e levar ao balcão.

    Sai do **congelado** — protocolo, lotação e cargo do envio, e o texto da
    recusa como ele foi decidido —, nunca do cadastro de hoje: é o mesmo
    princípio do comprovante da ficha (RN-15, RN-27). Quem imprimir a guia de um
    pedido de novembro em março tem de ler novembro.

    É HTML e não .docx de propósito: a guia é papel de conferência de balcão, não
    documento assinado. O documento assinado deste módulo é o comprovante da
    ficha, e ele já sai do modelo .docx com hash conferido.
    """
    usuario.exigir("epi.ver")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)

    # Registro PRÓPRIO, e não herdado da ficha: a guia é o papel nominal que
    # circula no balcão — nome, SIAPE, cargo e lotação congelados —, e sai por
    # uma URL que se abre sem passar pela ficha. Contar com o registro da tela
    # ao lado seria a mesma folga que deixava o `.docx` do parecer sair sem
    # rastro enquanto a tela dele já registrava.
    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="epi_requisicao.guia",
        servidor_id=requisicao.servidor_id,
        finalidade="impressão da guia de entrega de EPI para conferência no balcão",
    ):
        s.commit()

    return pagina(
        request,
        "paginas/epis_requisicao_guia.html",
        usuario=usuario,
        requisicao=requisicao,
        itens=requisicao.itens,
        hoje=date.today(),
        rotulos=ROTULO_EPI_REQUISICAO,
        rotulos_item=ROTULO_EPI_ITEM,
        rotulo_finalidade=ROTULO_FINALIDADE.get(
            requisicao.finalidade, requisicao.finalidade
        ),
        nomes=_nomes_de(s, [requisicao.analisado_por]),
    )


# =====================================================================
# O rascunho — o único estado em que o conteúdo se edita
# =====================================================================
@rotas.post(FILA + "/{requisicao_id}")
def atualizar_rascunho(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    chefia_servidor_id: str = Form(""),
    finalidade: str = Form("ROTINA"),
    descricao_atividade: str = Form(""),
    riscos_declarados: str = Form(""),
    urgencia: str = Form("NORMAL"),
    justificativa_urgencia: str = Form(""),
):
    # a permissão vem ANTES da busca, em toda rota de escrita: quem não pode
    # escrever recebe a mesma resposta para pedido que existe e para pedido que
    # não existe. Distinguir os dois transformaria a URL num contador de
    # requisições — mesmo cuidado de `epi_estoque.editar_lote`.
    usuario.exigir("epi.requisitar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    # A recusa aqui redesenha a tela em vez de redirecionar. Os dois campos
    # longos deste cartão — rotina de trabalho e riscos declarados — são o que
    # fundamenta a decisão de quem vai analisar, e o `rollback` que a recusa
    # exige devolve ao banco o texto ANTERIOR: o redirect relia o banco e
    # reescrevia na tela a versão velha, apagando o parágrafo recém-digitado sem
    # dizer que apagou. É o mesmo custo que `epis_requisicao_nova.html:43-44` já
    # nomeia, e o mesmo conserto de `processos.criar`.
    digitado = {
        "forma": "cabecalho",
        "chefia_servidor_id": chefia_servidor_id,
        "finalidade": finalidade,
        "urgencia": urgencia,
        "justificativa_urgencia": justificativa_urgencia,
        "descricao_atividade": descricao_atividade,
        "riscos_declarados": riscos_declarados,
    }
    try:
        servico.atualizar_rascunho(
            s,
            usuario,
            requisicao,
            chefia_servidor_id=(
                int(chefia_servidor_id)
                if chefia_servidor_id.strip().isdigit()
                else None
            ),
            finalidade=finalidade,
            descricao_atividade=descricao_atividade,
            riscos_declarados=riscos_declarados,
            urgencia=urgencia,
            justificativa_urgencia=justificativa_urgencia,
        )
    except (servico.RequisicaoBloqueada, TextoProibido) as falha:
        s.rollback()
        return _tela_ficha(
            request, s, usuario, requisicao, erro=_motivos(falha), digitado=digitado
        )
    s.commit()
    return _volta(_ficha(requisicao_id), "Rascunho atualizado.")


@rotas.post(FILA + "/{requisicao_id}/excluir")
def excluir_rascunho(s: SessaoDep, usuario: UsuarioDep, requisicao_id: int):
    """RN-31 — o único estado que some de verdade, e o evento sobrevive a ele."""
    usuario.exigir("epi.requisitar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    try:
        servico.excluir_rascunho(s, usuario, requisicao)
    except (servico.RequisicaoBloqueada, TextoProibido) as falha:
        s.rollback()
        return _recusa(_ficha(requisicao_id), falha)
    s.commit()
    return _volta(
        FILA,
        "Rascunho excluído. O evento da exclusão fica na trilha: apagar sem "
        "rastro seria repetir o defeito da planilha, em que a linha sumia e nada "
        "dizia que ela existiu.",
    )


@rotas.post(FILA + "/{requisicao_id}/itens")
def acrescentar_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    item_id: str = Form(""),
    quantidade: str = Form(""),
    tamanho: str = Form(""),
    justificativa: str = Form(""),
):
    usuario.exigir("epi.requisitar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    item = s.get(EpiItem, int(item_id)) if item_id.strip().isdigit() else None
    digitado = {
        "forma": "item-novo",
        "item_id": item_id,
        "quantidade": quantidade,
        "tamanho": tamanho,
        "justificativa": justificativa,
    }

    def recusar(mensagem: str):
        # Sem `rollback` aqui de propósito: as duas recusas de formato acontecem
        # antes de o serviço escrever qualquer coisa. Quem já escreveu e foi
        # recusado é o `except` lá embaixo.
        return _tela_ficha(
            request,
            s,
            usuario,
            requisicao,
            erro=mensagem,
            digitado=digitado,
            item_escolhido=item,
        )

    if item is None:
        return recusar("Escolha o equipamento no catálogo.")
    quantas = _inteiro(quantidade)
    if quantas is None:
        return recusar("Quantidade inválida: informe um número maior que zero.")
    try:
        servico.adicionar_item(
            s,
            usuario,
            requisicao,
            item=item,
            quantidade=quantas,
            tamanho=tamanho,
            justificativa=justificativa,
        )
    except (servico.RequisicaoBloqueada, TextoProibido) as falha:
        s.rollback()
        return recusar(_motivos(falha))
    s.commit()
    return _volta(_ficha(requisicao_id), f"'{item.nome}' acrescentado ao pedido.")


@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}")
def editar_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    quantidade: str = Form(""),
    tamanho: str = Form(""),
    justificativa: str = Form(""),
):
    usuario.exigir("epi.requisitar")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    # A forma leva o id da linha: o formulário de editar se repete uma vez por
    # item, e um `digitado` sem discriminador colocaria a justificativa desta
    # linha dentro de todas as outras.
    digitado = {
        "forma": f"item-{linha_id}",
        "quantidade": quantidade,
        "tamanho": tamanho,
        "justificativa": justificativa,
    }

    def recusar(mensagem: str):
        # relê a requisição em vez de navegar pela linha: depois do `rollback` o
        # que estiver expirado recarrega, e a ficha é montada a partir dela.
        return _tela_ficha(
            request,
            s,
            usuario,
            _requisicao(s, usuario, requisicao_id),
            erro=mensagem,
            digitado=digitado,
        )

    quantas = _inteiro(quantidade)
    if quantas is None:
        return recusar("Quantidade inválida: informe um número maior que zero.")
    try:
        servico.editar_item(
            s,
            usuario,
            linha,
            quantidade=quantas,
            tamanho=tamanho,
            justificativa=justificativa,
        )
    except (servico.RequisicaoBloqueada, TextoProibido) as falha:
        s.rollback()
        return recusar(_motivos(falha))
    s.commit()
    return _volta(destino, "Item atualizado.", ancora=ANCORA_ITENS)


@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/remover")
def remover_item(
    s: SessaoDep, usuario: UsuarioDep, requisicao_id: int, linha_id: int
):
    """Some de verdade — mas só dentro do rascunho, que também some.

    Depois do envio a linha existe dentro de documento protocolado, e sair dele é
    cancelar com motivo.
    """
    usuario.exigir("epi.requisitar")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    nome = linha.item.nome
    try:
        servico.remover_item(s, usuario, linha)
    except (servico.RequisicaoBloqueada, TextoProibido) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(destino, f"'{nome}' removido do rascunho.", ancora=ANCORA_ITENS)


@rotas.post(FILA + "/{requisicao_id}/enviar")
def enviar(s: SessaoDep, usuario: UsuarioDep, requisicao_id: int):
    """RASCUNHO → ENVIADA. É aqui que o pedido vira documento."""
    usuario.exigir("epi.requisitar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    destino = _ficha(requisicao_id)
    try:
        servico.enviar(s, usuario, requisicao)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(
        destino,
        f"Pedido protocolado como {requisicao.protocolo}. A lotação, o cargo e a "
        "função ficaram congelados como estavam hoje.",
    )


# =====================================================================
# A análise — envelope
#
# Toda rota daqui para baixo passa por `_exigir_analista_diferente` dentro do
# serviço, que é onde a RN-28 mora. `AutoanaliseProibida` é `PermissaoNegada` e
# NÃO é capturada aqui de propósito: ela sobe até o tratador do `principal.py`,
# que a rende como 403 com a mensagem inteira — e a mensagem inteira é o ponto,
# porque é ela que diz as duas saídas legítimas.
# =====================================================================
@rotas.post(FILA + "/{requisicao_id}/analise")
def iniciar_analise(s: SessaoDep, usuario: UsuarioDep, requisicao_id: int):
    usuario.exigir("epi.analisar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    destino = _ficha(requisicao_id)
    try:
        servico.iniciar_analise(s, usuario, requisicao)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(
        destino, f"{requisicao.identificacao} está em análise com você."
    )


@rotas.post(FILA + "/{requisicao_id}/devolver")
def devolver_para_fila(
    s: SessaoDep, usuario: UsuarioDep, requisicao_id: int, motivo: str = Form("")
):
    """EM_ANALISE → ENVIADA. Decidir sem base é pior do que devolver."""
    usuario.exigir("epi.analisar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    destino = _ficha(requisicao_id)
    try:
        servico.devolver_para_fila(s, usuario, requisicao, motivo)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(destino, "Pedido devolvido à fila, com o motivo na trilha.")


@rotas.post(FILA + "/{requisicao_id}/concluir")
def concluir_analise(
    s: SessaoDep, usuario: UsuarioDep, requisicao_id: int, parecer: str = Form("")
):
    usuario.exigir("epi.analisar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    destino = _ficha(requisicao_id)
    try:
        servico.concluir_analise(s, usuario, requisicao, parecer=parecer)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(
        destino,
        "Análise concluída. O que foi aprovado pode ser entregue; "
        "`EM_ATENDIMENTO` e `ATENDIDA` chegam sozinhas, conforme as entregas.",
    )


@rotas.post(FILA + "/{requisicao_id}/indeferir")
def indeferir(
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    motivo_id: str = Form(""),
    complemento: str = Form(""),
    parecer: str = Form(""),
):
    """EM_ANALISE → INDEFERIDA, com o motivo do catálogo (RN-27)."""
    usuario.exigir("epi.analisar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    destino = _ficha(requisicao_id)
    motivo = (
        s.get(EpiMotivoRecusa, int(motivo_id)) if motivo_id.strip().isdigit() else None
    )
    if motivo is None:
        return _erro(destino, "Escolha o motivo do indeferimento no catálogo.")
    try:
        servico.indeferir(
            s,
            usuario,
            requisicao,
            motivo=motivo,
            complemento=complemento,
            parecer=parecer,
        )
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(destino, f"Pedido indeferido com o motivo {motivo.codigo}.")


@rotas.post(FILA + "/{requisicao_id}/reconsiderar")
def reconsiderar(
    s: SessaoDep, usuario: UsuarioDep, requisicao_id: int, motivo: str = Form("")
):
    """INDEFERIDA → EM_ANALISE. O único caminho de volta de um terminal."""
    usuario.exigir("epi.analisar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    destino = _ficha(requisicao_id)
    try:
        servico.reconsiderar(s, usuario, requisicao, motivo)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(
        destino,
        "Pedido reaberto para análise. As recusas de item NÃO voltaram sozinhas: "
        "cada uma foi decisão própria, e desfazê-las em bloco reescreveria em "
        "silêncio negativas que talvez estivessem certas.",
    )


@rotas.post(FILA + "/{requisicao_id}/cancelar")
def cancelar(
    s: SessaoDep, usuario: UsuarioDep, requisicao_id: int, motivo: str = Form("")
):
    """A desistência, com motivo — dos dois lados.

    Aceita `epi.requisitar` **ou** `epi.analisar`: o pedido é do requerente e o
    trâmite é do SESMT, e os dois desistem por razões legítimas. A RN-28 não se
    aplica porque ela governa a decisão, não a desistência.
    """
    if not (usuario.pode("epi.requisitar") or usuario.pode("epi.analisar")):
        raise PermissaoNegada("epi.requisitar")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if requisicao is None:
        return RedirectResponse(FILA, status_code=303)
    destino = _ficha(requisicao_id)
    try:
        servico.cancelar(s, usuario, requisicao, motivo)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(destino, "Pedido cancelado, com o motivo registrado.")


# =====================================================================
# A análise — item a item (é aqui que a decisão acontece)
# =====================================================================
@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/aprovar")
def aprovar_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    quantidade_aprovada: str = Form(""),
    justificativa: str = Form(""),
    autorizar_excesso: str = Form(""),
):
    """SOLICITADO → APROVADO, com a RN-26 contada na ficha.

    `autorizar_excesso` é caixa do próprio formulário, e não uma segunda tela:
    quando a janela estoura, o serviço devolve o recado e a pessoa está a um
    clique e uma frase de resolver — na mesma tela, com o texto ao lado dizendo
    que a autorização fica registrada com o nome dela. Erro sem caminho de saída
    é o que faz o analista resolver o caso por fora do sistema.
    """
    usuario.exigir("epi.analisar")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    parcial = _e_htmx(request)
    quantas = _inteiro(quantidade_aprovada)
    if quantidade_aprovada.strip() and quantas is None:
        return _parcial_ou_erro(
            request, s, usuario, linha.requisicao, "Quantidade aprovada inválida.",
            parcial, linha_id,
        )
    try:
        servico.aprovar_item(
            s,
            usuario,
            linha,
            quantidade_aprovada=quantas,
            justificativa=justificativa,
            autorizar_excesso=_marcado(autorizar_excesso),
        )
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _parcial_ou_erro(
            request, s, usuario, linha.requisicao, _motivos(falha), parcial, linha_id
        )
    s.commit()
    if parcial:
        return _secao_dos_itens(request, s, usuario, linha.requisicao)
    recado = f"'{linha.item.nome}': {linha.quantidade_aprovada} aprovado(s)."
    if linha.excedeu_maximo:
        recado += (
            " O máximo da RN-26 foi excedido e a exceção ficou registrada com o "
            "seu nome, com a justificativa por escrito."
        )
    return _volta(destino, recado, ancora=ANCORA_ITENS)


@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/recusar")
def recusar_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    motivo_id: str = Form(""),
    complemento: str = Form(""),
):
    """SOLICITADO → RECUSADO. RN-27: fundamentada, catalogada e congelada."""
    usuario.exigir("epi.analisar")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    parcial = _e_htmx(request)
    motivo = (
        s.get(EpiMotivoRecusa, int(motivo_id)) if motivo_id.strip().isdigit() else None
    )
    if motivo is None:
        return _parcial_ou_erro(
            request,
            s,
            usuario,
            linha.requisicao,
            "Escolha o motivo da recusa no catálogo: negativa em texto livre sai "
            "diferente a cada vez, não cita norma e não se conta (RN-27).",
            parcial,
            linha_id,
        )
    try:
        servico.recusar_item(
            s, usuario, linha, motivo=motivo, complemento=complemento
        )
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _parcial_ou_erro(
            request, s, usuario, linha.requisicao, _motivos(falha), parcial, linha_id
        )
    s.commit()
    if parcial:
        return _secao_dos_itens(request, s, usuario, linha.requisicao)
    return _volta(
        destino,
        f"'{linha.item.nome}' recusado com o motivo {motivo.codigo}. "
        "O texto que vai para o requerente ficou congelado na linha.",
        ancora=ANCORA_ITENS,
    )


@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/cancelar")
def cancelar_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    motivo: str = Form(""),
):
    """A linha sai do pedido sem virar recusa. Motivo obrigatório.

    Recusa é decisão técnica fundamentada; cancelamento é desistência. Registrar
    desistência como recusa foi o que o legado fez, e por isso o relatório de
    recusas dele não valia nada.
    """
    if not (usuario.pode("epi.requisitar") or usuario.pode("epi.analisar")):
        raise PermissaoNegada("epi.analisar")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    nome = linha.item.nome
    requisicao = linha.requisicao
    parcial = _e_htmx(request)
    try:
        servico.cancelar_item(s, usuario, linha, motivo)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _parcial_ou_erro(
            request, s, usuario, requisicao, _motivos(falha), parcial, linha_id
        )
    s.commit()
    if parcial:
        return _secao_dos_itens(request, s, usuario, requisicao)
    return _volta(destino, f"'{nome}' cancelado no pedido, com o motivo na trilha.", ancora=ANCORA_ITENS)


# =====================================================================
# A reserva — o almoxarifado, entre a decisão e o balcão (fatia 5)
# =====================================================================
@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/reservar")
def reservar_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    entrada_id: str = Form(""),
    quantidade: str = Form(""),
):
    """APROVADO ou SEM_ESTOQUE → RESERVADO. RN-24 e RN-25 na porta.

    O lote é escolhido **por quem reserva**, e a tela mostra saldo e CA de cada
    candidato ao lado. Não há reserva automática na entrada de lote, e isso é
    decisão: reserva silenciosa muda o disponível sem ninguém mandar, e é assim
    que a contagem manual passa a divergir do sistema sem explicação. Ver
    `epi_requisicao.reservar_item`.
    """
    usuario.exigir("epi.estoque")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    entrada = (
        s.get(EpiEntradaEstoque, int(entrada_id))
        if entrada_id.strip().isdigit()
        else None
    )
    parcial = _e_htmx(request)
    if entrada is None:
        return _parcial_ou_erro(
            request,
            s,
            usuario,
            linha.requisicao,
            "Escolha o lote da reserva: reservar sem dizer de qual lote seria "
            "prometer um número, e o que a pessoa vai calçar é uma caixa.",
            parcial,
            linha_id,
        )
    quantas = _inteiro(quantidade)
    if quantidade.strip() and quantas is None:
        return _parcial_ou_erro(
            request, s, usuario, linha.requisicao, "Quantidade a reservar inválida.",
            parcial, linha_id,
        )
    try:
        servico.reservar_item(
            s, usuario, linha, entrada=entrada, quantidade=quantas
        )
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _parcial_ou_erro(
            request, s, usuario, linha.requisicao, _motivos(falha), parcial, linha_id
        )
    s.commit()
    if parcial:
        return _secao_dos_itens(request, s, usuario, linha.requisicao)
    return _volta(
        destino,
        f"{linha.quantidade_reservada} × '{linha.item.nome}' reservado(s) no lote "
        f"{entrada.lote or 'sem número'}. As unidades saíram do disponível dos "
        "outros pedidos e continuam no saldo físico — reserva não é movimento.",
        ancora=ANCORA_ITENS,
    )


@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/soltar-reserva")
def soltar_reserva(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    motivo: str = Form(""),
):
    """RESERVADO → SEM_ESTOQUE, com o motivo por escrito.

    Motivo obrigatório porque é o único registro que sobra: o item volta a
    aparecer esperando estoque, e quem o vir depois precisa saber se o lote foi
    descartado, se o CA venceu no intervalo ou se as unidades foram para um caso
    mais urgente.
    """
    usuario.exigir("epi.estoque")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    nome = linha.item.nome
    requisicao = linha.requisicao
    parcial = _e_htmx(request)
    try:
        servico.soltar_reserva(s, usuario, linha, motivo)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _parcial_ou_erro(
            request, s, usuario, requisicao, _motivos(falha), parcial, linha_id
        )
    s.commit()
    if parcial:
        return _secao_dos_itens(request, s, usuario, requisicao)
    return _volta(
        destino,
        f"Reserva de '{nome}' solta, com o motivo na trilha. O item voltou a "
        "esperar estoque e as unidades voltaram ao disponível.",
        ancora=ANCORA_ITENS,
    )


@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/sem-estoque")
def marcar_sem_estoque(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    complemento: str = Form(""),
):
    """APROVADO → SEM_ESTOQUE: o item é devido e a prateleira não tem.

    Recusado quando existe lote elegível com saldo — "sem estoque" com prateleira
    cheia entra no indicador de compras e vira pregão para item que já existe.
    """
    usuario.exigir("epi.estoque")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    nome = linha.item.nome
    requisicao = linha.requisicao
    parcial = _e_htmx(request)
    try:
        servico.marcar_sem_estoque(s, usuario, linha, complemento=complemento)
    except (servico.RequisicaoBloqueada, TextoProibido, TransicaoInvalida) as falha:
        s.rollback()
        return _parcial_ou_erro(
            request, s, usuario, requisicao, _motivos(falha), parcial, linha_id
        )
    s.commit()
    if parcial:
        return _secao_dos_itens(request, s, usuario, requisicao)
    return _volta(
        destino,
        f"'{nome}' marcado como sem estoque. Ele passa a aparecer na fila de quem "
        "espera lote — a reserva continua sendo ato de quem opera o almoxarifado, "
        "e não efeito automático da próxima entrada.",
        ancora=ANCORA_ITENS,
    )


@rotas.post(FILA + "/{requisicao_id}/itens/{linha_id}/entregar")
def entregar_item(
    s: SessaoDep,
    usuario: UsuarioDep,
    requisicao_id: int,
    linha_id: int,
    entrada_id: str = Form(""),
    quantidade: str = Form(""),
    observacao: str = Form(""),
):
    """APROVADO → ENTREGUE, reaproveitando a entrega da fatia 2.

    Nada de ficha nem de razão é escrito aqui: `epi_ficha.registrar_entrega` já
    sabe conferir o CA (RN-25), a janela (RN-26), congelar os snapshots, baixar o
    lote e abrir a pendência do comprovante assinado. Uma segunda implementação
    divergiria da primeira no primeiro campo que alguém acrescentasse a uma só —
    e o campo esquecido estaria numa prova legal.
    """
    usuario.exigir("epi.entregar")
    destino = _ficha(requisicao_id)
    linha = _linha(s, usuario, requisicao_id, linha_id)
    if linha is None:
        return RedirectResponse(destino, status_code=303)
    entrada = (
        s.get(EpiEntradaEstoque, int(entrada_id))
        if entrada_id.strip().isdigit()
        else None
    )
    quantas = _inteiro(quantidade)
    if quantidade.strip() and quantas is None:
        return _erro(destino, "Quantidade a entregar inválida.")
    try:
        registro = servico.entregar_item(
            s,
            usuario,
            linha,
            entrada=entrada,
            quantidade=quantas,
            observacao=observacao,
        )
    except (
        servico.RequisicaoBloqueada,
        # a entrega delegada levanta a exceção da FICHA, e não a da requisição:
        # é `epi_ficha.registrar_entrega` que confere o CA do lote e a janela, e
        # o motivo que ela escreve é o que quem está no balcão precisa ler
        epi_ficha.EntregaBloqueada,
        epi_estoque.EstoqueBloqueado,
        TextoProibido,
        TransicaoInvalida,
    ) as falha:
        s.rollback()
        return _recusa(destino, falha)
    s.commit()
    return _volta(
        destino,
        f"Entrega registrada na ficha (registro {registro.id}). Imprima o "
        "comprovante na ficha do servidor, colha a assinatura e anexe o "
        "digitalizado — sem ele a entrega tem registro e não tem prova.",
        ancora=ANCORA_ITENS,
    )
