"""/epis/estoque — o saldo por item e por lote, e o livro razão de cada um.

Fatia 3 do desenho (`entrada/integrasst/desenho_epi.md`). Está separada de
`epis.py` (o catálogo) e de `epi_fichas.py` (a prova de entrega) pela mesma razão
que separa aqueles dois: um arquivo é o que o setor fornece, outro é o documento
que sai dele, e este é o que existe na prateleira.

Três coisas que esta tela existe para tornar visíveis:

1. **Saldo é soma de movimentos, e a tela mostra a soma, não uma célula.** No
   legado `Qtd_Estoque` era coluna que se sobrescrevia: duas entregas
   simultâneas perdiam uma, sem rastro do que baixou. Aqui cada número tem um
   extrato atrás dele, e o extrato é append-only.
2. **O lote vencido continua no estoque, marcado.** Ele tem saldo, é patrimônio,
   e alguém vai ter de dar baixa nele. Some da lista de entrega, não desta.
3. **Quantidade não se edita.** Nota fiscal, contato e observação sim — são
   transcrição de papel. Quantidade muda por movimento, porque é o movimento que
   diz quando mudou e por quê. Um campo de saldo editável seria o `Qtd_Estoque`
   de volta.
4. **A coluna "reservado" deixou de ser zero** (fatia 5). Ela é a soma de
   `epi_requisicao_item.quantidade_reservada` dos itens em `RESERVADO`, e não sai
   do razão: reservar não tira nada da prateleira. Físico, reservado e disponível
   aparecem lado a lado porque quem conta a prateleira encontra o **físico**, e é
   contra ele que a conferência se faz (RN-24).
"""

from __future__ import annotations

from datetime import date

from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import EpiEntradaEstoque, EpiItem, Usuario
from app.servicos import epi_requisicao
from app.servicos import epi_estoque as servico
from app.servicos.textos import TextoProibido
from app.web import pagina

rotas = APIRouter(tags=["epis"])

ESTOQUE = "/epis/estoque"
NOVA_ENTRADA = ESTOQUE + "/nova-entrada"


def _aviso(destino: str, campo: str, mensagem: str) -> RedirectResponse:
    """Codificado: item, lote, empenho e fornecedor entram na mensagem, e um
    `&` no nome do fornecedor cortava o recado no `Location`."""
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    separador = "&" if "?" in destino else "?"
    return RedirectResponse(f"{destino}{separador}{parametros}", status_code=303)


def _volta(mensagem: str, destino: str = ESTOQUE) -> RedirectResponse:
    return _aviso(destino, "mensagem", mensagem)


def _erro(mensagem: str, destino: str = ESTOQUE) -> RedirectResponse:
    return _aviso(destino, "erro", mensagem)


def _inteiro(bruto: str) -> int | None:
    """Inteiro não negativo, ou `None` quando o campo veio vazio ou com lixo.

    Quem chama distingue os dois casos olhando o texto bruto antes — só ele sabe
    se o campo é obrigatório. Mesmo critério de `epis.py`.
    """
    limpo = (bruto or "").strip()
    return int(limpo) if limpo.isdigit() else None


def _data(bruto: str) -> date | None:
    limpo = (bruto or "").strip()
    if not limpo:
        return None
    try:
        return date.fromisoformat(limpo[:10])
    except ValueError:
        return None


def _lote(s, entrada_id: int) -> EpiEntradaEstoque | None:
    return s.get(EpiEntradaEstoque, entrada_id)


def _nomes_de(s, ids: list[int | None]) -> dict[int, str]:
    """`{usuario_id: nome}` para o extrato. Uma consulta, não uma por linha."""
    alvos = {i for i in ids if i is not None}
    if not alvos:
        return {}
    return {
        usuario.id: usuario.nome
        for usuario in s.execute(select(Usuario).where(Usuario.id.in_(alvos))).scalars()
    }


# =====================================================================
# A tela
# =====================================================================
@rotas.get(ESTOQUE)
def estoque(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    q: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    """Abre em leitura para quem tem `epi.ver`; escrever pede `epi.estoque`."""
    usuario.exigir("epi.ver")
    return _tela_estoque(request, s, usuario, q=q, mensagem=mensagem, erro=erro)


def _tela_estoque(
    request,
    s,
    usuario,
    *,
    q: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    """O panorama. Só isso: o formulário de entrada mora em `/nova-entrada`.

    A lista deixou de carregar o cadastro e deixou de carregar o catálogo junto
    com ele — a consulta de `EpiItem` existia só para preencher o `<select>` do
    popup, e quem abre esta tela vem conferir saldo.
    """
    hoje = date.today()
    linhas = servico.panorama(s, quando=hoje, busca=q)
    lotes_impedidos = [
        lote for linha in linhas for lote in linha.lotes if lote.impedido and lote.fisico
    ]
    return pagina(
        request,
        "paginas/epis_estoque.html",
        usuario=usuario,
        linhas=linhas,
        q=q,
        hoje=hoje,
        # o que pede decisão, contado no topo: saldo que existe e não pode sair
        lotes_impedidos=lotes_impedidos,
        preso=sum(lote.fisico for lote in lotes_impedidos),
        pode_escrever=usuario.pode("epi.estoque"),
        mensagem=mensagem,
        erro=erro,
    )


# =====================================================================
# A entrada de lote — página, e não popup
#
# Dezenove campos. Mesmo na variante larga do `popup_cadastro` o corpo pedia
# 864px contra os 577 visíveis num 1366x768, que é a tela do setor: uma tela e
# meia de rolagem DENTRO de um diálogo, que é a única coisa de que um popup não
# dispõe (o argumento está escrito em `partes/macros.html`, no fim da seção
# `largo`). O pedido que criou o padrão continua atendido — a lista voltou a ser
# só a lista —, e a resposta para o formulário que não cabe é esta: página
# dedicada, como `/processos/novo` e `/epis/requisicoes/nova`.
#
# Declarada ANTES de qualquer rota com `{entrada_id}` no mesmo nível: hoje não
# há GET que colida, mas "nova-entrada" não converte para `int`, e o dia em que
# a ficha do lote ganhar um GET a ordem é o que impede um 422 no lugar da tela.
# =====================================================================
@rotas.get(NOVA_ENTRADA)
def formulario_de_entrada(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """A mesma permissão da POST que grava — conferida, não presumida."""
    usuario.exigir("epi.estoque")
    return _tela_nova_entrada(request, s, usuario)


def _tela_nova_entrada(
    request,
    s,
    usuario,
    *,
    erro: str | None = None,
    campo_com_erro: str | None = None,
    digitado: dict | None = None,
):
    """O formulário em branco, ou de volta como foi digitado depois da recusa.

    Uma função só para a abertura e para a recusa, pelo mesmo motivo de
    `processos._tela_novo`: duplicá-las é o que faz a recusa esquecer metade dos
    campos. `digitado` não entra na assinatura da rota GET — dicionário em
    parâmetro de rota o FastAPI leria como corpo, e esta rota não tem corpo.
    """
    return pagina(
        request,
        "paginas/epis_estoque_nova_entrada.html",
        usuario=usuario,
        hoje=date.today(),
        itens=list(
            s.execute(
                select(EpiItem).where(EpiItem.ativo.is_(True)).order_by(EpiItem.nome)
            ).scalars()
        ),
        digitado=digitado or {},
        campo_com_erro=campo_com_erro,
        erro=erro,
    )


@rotas.post(ESTOQUE)
def registrar_entrada(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    # `Form("")` e não `Form(...)` nos campos obrigatórios: o FastAPI trata campo
    # de texto vazio como AUSENTE e responde 422 em JSON, que é o que quem está
    # no balcão veria no lugar da tela. Obrigatório aqui é conferido pelo
    # serviço, que devolve o motivo escrito em português.
    item_id: str = Form(""),
    quantidade_recebida: str = Form(""),
    data_entrada: str = Form(""),
    tamanho: str = Form(""),
    pregao: str = Form(""),
    item_pregao: str = Form(""),
    empenho: str = Form(""),
    nota_fiscal: str = Form(""),
    quantidade_empenhada: str = Form(""),
    valor_unitario: str = Form(""),
    fornecedor_nome: str = Form(""),
    fornecedor_cnpj: str = Form(""),
    fornecedor_contato: str = Form(""),
    lote: str = Form(""),
    numero_ca: str = Form(""),
    validade_ca: str = Form(""),
    data_fabricacao: str = Form(""),
    observacao: str = Form(""),
):
    """A entrada do lote: a compra pública e o primeiro movimento do razão."""
    usuario.exigir("epi.estoque")
    # Tudo o que foi digitado, guardado antes da primeira recusa — o padrão de
    # `processos.criar`. São dezenove campos transcritos de uma nota fiscal e de
    # uma etiqueta que estão em cima da mesa: uma validade de CA mal digitada
    # apagava pregão, empenho, nota, fornecedor, CNPJ e valor, e a conferência
    # papel-a-papel recomeçava do zero.
    digitado = {
        "item_id": item_id,
        "quantidade_recebida": quantidade_recebida,
        "data_entrada": data_entrada,
        "tamanho": tamanho,
        "pregao": pregao,
        "item_pregao": item_pregao,
        "empenho": empenho,
        "nota_fiscal": nota_fiscal,
        "quantidade_empenhada": quantidade_empenhada,
        "valor_unitario": valor_unitario,
        "fornecedor_nome": fornecedor_nome,
        "fornecedor_cnpj": fornecedor_cnpj,
        "fornecedor_contato": fornecedor_contato,
        "lote": lote,
        "numero_ca": numero_ca,
        "validade_ca": validade_ca,
        "data_fabricacao": data_fabricacao,
        "observacao": observacao,
    }

    # `campo` é o nome do <input> que a tela vai marcar e focar. A rota recusa em
    # seis lugares e cada um sabe qual campo o produziu — na página cabem os
    # dezenove de uma vez, então dizer só "não deu" no topo faria procurar o
    # problema em dezenove. Onde quem recusa é o SERVIÇO, o motivo pode ser mais
    # de um e cruzar campos ("recebeu mais do que se empenhou" fala de dois):
    # ali `campo` fica em branco de propósito, e o que orienta é o texto.
    def recusar(mensagem: str, campo: str | None = None):
        return _tela_nova_entrada(
            request, s, usuario, erro=mensagem, campo_com_erro=campo, digitado=digitado
        )

    item = s.get(EpiItem, int(item_id)) if item_id.strip().isdigit() else None
    if item is None:
        return recusar("Escolha o item do catálogo a que o lote pertence.", "item_id")

    recebida = _inteiro(quantidade_recebida)
    if recebida is None or recebida <= 0:
        return recusar(
            "Quantidade recebida inválida: informe um número maior que zero.",
            "quantidade_recebida",
        )
    empenhada = _inteiro(quantidade_empenhada)
    if quantidade_empenhada.strip() and empenhada is None:
        return recusar("Quantidade empenhada inválida.", "quantidade_empenhada")

    quando = _data(data_entrada)
    if data_entrada.strip() and quando is None:
        return recusar("Data de entrada inválida.", "data_entrada")
    validade = _data(validade_ca)
    if validade_ca.strip() and validade is None:
        return recusar("Validade do CA inválida.", "validade_ca")
    fabricacao = _data(data_fabricacao)
    if data_fabricacao.strip() and fabricacao is None:
        return recusar("Data de fabricação inválida.", "data_fabricacao")

    # A MESMA função que o serviço usa para gravar, chamada aqui só para APONTAR
    # o campo. A autoridade continua sendo o serviço — quem grava é ele, e ele
    # normaliza de novo —; o que a rota acrescenta é dizer qual dos dezenove
    # campos produziu a recusa, que é o que ela já faz com as três datas. Uma
    # segunda regra de CNPJ escrita aqui divergiria da primeira no dia em que
    # alguém mexesse num lado só.
    try:
        servico.normalizar_cnpj(fornecedor_cnpj)
    except servico.EstoqueBloqueado as falha:
        return recusar(" · ".join(falha.motivos), "fornecedor_cnpj")

    # RN-25 no cadastro: o CA do lote é o que decide a entrega, e um lote sem
    # ele nasce impedido. Não é recusa — é aviso, porque a caixa já está na
    # prateleira e o estoque tem de conhecê-la.
    try:
        valor = servico.valor_decimal(valor_unitario)
        entrada = servico.registrar_entrada(
            s,
            usuario,
            item=item,
            quantidade_recebida=recebida,
            data_entrada=quando,
            tamanho=tamanho,
            pregao=pregao,
            item_pregao=item_pregao,
            empenho=empenho,
            nota_fiscal=nota_fiscal,
            fornecedor_nome=fornecedor_nome,
            fornecedor_cnpj=fornecedor_cnpj,
            fornecedor_contato=fornecedor_contato,
            quantidade_empenhada=empenhada,
            valor_unitario=valor,
            lote=lote,
            numero_ca=numero_ca,
            validade_ca=validade,
            data_fabricacao=fabricacao,
            observacao=observacao,
        )
    except (servico.EstoqueBloqueado, TextoProibido) as falha:
        s.rollback()
        return recusar(" · ".join(getattr(falha, "motivos", None) or [str(falha)]))
    s.commit()

    recado = (
        f"Lote {entrada.lote or 'sem número'} de '{item.nome}' registrado com "
        f"{recebida} em estoque."
    )
    impedimento = servico.impedimento_do_lote(entrada, item, date.today())
    if impedimento:
        recado += f" ATENÇÃO: o lote não pode ser entregue — {impedimento}."
    else:
        # O substituto da reserva automática (§4.3, aresta `SEM_ESTOQUE →
        # RESERVADO`): o sistema **avisa** quem está esperando e a reserva
        # continua sendo ato de gente. Reservar sozinho aqui mudaria o disponível
        # do lote que acabou de entrar, por decisão que não está nesta tela — e
        # escolher qual pedido fica com estoque escasso é decisão, não ordem de
        # laço por `id`.
        esperando = epi_requisicao.itens_esperando_estoque(
            s, epi_item_id=item.id, tamanho=entrada.tamanho
        )
        if esperando:
            recado += (
                f" {len(esperando)} item(ns) de pedido(s) esperam este "
                "equipamento — a reserva não é automática: abra o pedido e "
                "reserve o lote, para que fique registrado quem decidiu."
            )
    return _volta(recado)


@rotas.post(ESTOQUE + "/{entrada_id}")
def editar_lote(
    s: SessaoDep,
    usuario: UsuarioDep,
    entrada_id: int,
    nota_fiscal: str = Form(""),
    fornecedor_contato: str = Form(""),
    observacao: str = Form(""),
    ativo: str = Form(""),
    motivo_inativacao: str = Form(""),
):
    # a permissão vem ANTES da busca, nas três rotas de escrita: quem não pode
    # escrever recebe a mesma resposta para lote que existe e para lote que não
    # existe. Distinguir os dois transformaria a URL num contador de lotes —
    # mesmo cuidado que `ficha_do_servidor` já toma com o cadastro de pessoas.
    usuario.exigir("epi.estoque")
    entrada = _lote(s, entrada_id)
    if entrada is None:
        return RedirectResponse(ESTOQUE, status_code=303)
    try:
        servico.atualizar_lote(
            s,
            usuario,
            entrada=entrada,
            nota_fiscal=nota_fiscal,
            fornecedor_contato=fornecedor_contato,
            observacao=observacao,
            ativo=ativo == "1",
            motivo_inativacao=motivo_inativacao,
        )
    except (servico.EstoqueBloqueado, TextoProibido) as falha:
        s.rollback()
        return _erro(" · ".join(getattr(falha, "motivos", None) or [str(falha)]))
    s.commit()
    return _volta(f"Lote {entrada.lote or entrada.id} atualizado.")


@rotas.post(ESTOQUE + "/{entrada_id}/ajuste")
def ajustar(
    s: SessaoDep,
    usuario: UsuarioDep,
    entrada_id: int,
    contagem: str = Form(""),
    motivo: str = Form(""),
):
    """A única forma legítima de o saldo do sistema encontrar a prateleira."""
    usuario.exigir("epi.estoque")
    entrada = _lote(s, entrada_id)
    if entrada is None:
        return RedirectResponse(ESTOQUE, status_code=303)
    contada = _inteiro(contagem)
    if contada is None:
        return _erro("Contagem inválida: informe quantas unidades você contou.")
    try:
        movimento = servico.ajustar(
            s, usuario, entrada=entrada, contagem=contada, motivo=motivo
        )
    except (servico.EstoqueBloqueado, TextoProibido) as falha:
        s.rollback()
        return _erro(" · ".join(getattr(falha, "motivos", None) or [str(falha)]))
    s.commit()
    return _volta(
        f"Inventário registrado no lote {entrada.lote or entrada.id}: "
        f"{movimento.quantidade:+d}, saldo agora {contada}. "
        "A linha do razão guarda a contagem, o motivo e o seu nome."
    )


@rotas.post(ESTOQUE + "/{entrada_id}/descarte")
def descartar(
    s: SessaoDep,
    usuario: UsuarioDep,
    entrada_id: int,
    quantidade: str = Form(""),
    motivo: str = Form(""),
):
    usuario.exigir("epi.estoque")
    entrada = _lote(s, entrada_id)
    if entrada is None:
        return RedirectResponse(ESTOQUE, status_code=303)
    quantas = _inteiro(quantidade)
    if quantas is None:
        return _erro("Quantidade a descartar inválida.")
    try:
        servico.descartar(
            s, usuario, entrada=entrada, quantidade=quantas, motivo=motivo
        )
    except (servico.EstoqueBloqueado, TextoProibido) as falha:
        s.rollback()
        return _erro(" · ".join(getattr(falha, "motivos", None) or [str(falha)]))
    s.commit()
    return _volta(
        f"{quantas} unidade(s) descartada(s) do lote {entrada.lote or entrada.id}. "
        "O descarte é decisão registrada: a linha fica no razão, com o motivo."
    )


@rotas.get(ESTOQUE + "/{entrada_id}/movimentos")
def movimentos(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    entrada_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    """O extrato do lote: cada movimento, o motivo e o saldo que ele deixou."""
    usuario.exigir("epi.ver")
    entrada = _lote(s, entrada_id)
    if entrada is None:
        return RedirectResponse(ESTOQUE, status_code=303)
    hoje = date.today()
    linhas = servico.extrato(s, entrada.id)
    return pagina(
        request,
        "paginas/epis_estoque_movimentos.html",
        usuario=usuario,
        entrada=entrada,
        item=entrada.item,
        linhas=linhas,
        # o nome de quem registrou, e não o id: "registrado por 4" não é
        # informação para quem confere o extrato
        nomes=_nomes_de(s, [l.movimento.registrado_por for l in linhas]),
        fisico=servico.saldo_fisico(s, entrada.id),
        reservado=servico.reservado(s, entrada.id),
        impedimento=servico.impedimento_do_lote(entrada, entrada.item, hoje),
        hoje=hoje,
        pode_escrever=usuario.pode("epi.estoque"),
        mensagem=mensagem,
        erro=erro,
    )
