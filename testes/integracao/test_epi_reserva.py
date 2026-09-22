"""Fatia 5 de Gestão de EPI: a reserva de lote, e o que ela promete.

A reserva existe para uma coisa só: **impedir que dois pedidos prometam o mesmo
par de botas**. Tudo o que estes testes protegem sai daí, em ordem de gravidade:

1. **RN-24 — saldo nunca fica negativo.** Ela não cabe num `CHECK` (é agregado
   sobre outra tabela), então mora no serviço, e serviço sem teste é promessa.
   Inclui a corrida de verdade: duas reservas simultâneas do mesmo lote, em
   linhas de execução diferentes, não podem somar mais que o disponível.
2. **RN-25 nos DOIS momentos.** O CA é conferido na reserva e **de novo** na
   entrega, porque ele pode vencer no intervalo. Um lote prometido em agosto com
   CA vencendo em setembro não pode sair em outubro — e a recusa diz a data.
3. **`reservado()` é verdade, e a versão agregada não diverge da individual.**
   Duas funções para o mesmo número é o começo de dois números diferentes.
4. **Reserva não é movimento.** O físico do lote não muda quando alguém reserva;
   se mudasse, a contagem da prateleira deixaria de bater com o sistema — que é
   a conferência que o livro razão existe para permitir.
5. **A promessa se desfaz onde ela perdeu o lastro**, e não na frente da pessoa:
   cancelamento do item, cancelamento do pedido, descarte e inativação do lote
   soltam a reserva, com motivo na trilha.
6. **A máquina de estado é a guarda.** Toda transição não declarada é recusada,
   e `EM_ATENDIMENTO` chega sozinha na primeira reserva.
"""

from __future__ import annotations

import concurrent.futures
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.modelos import (
    Cargo,
    EpiCategoria,
    EpiEntradaEstoque,
    EpiFichaRegistro,
    EpiItem,
    EpiMotivoRecusa,
    EpiMovimentoEstoque,
    EpiRequisicaoItem,
    HistoricoEvento,
    Servidor,
    UnidadeUorg,
    Usuario,
)
from app.modelos.estados import TransicaoInvalida
from app.servicos import epi_estoque, epi_ficha
from app.servicos import epi_requisicao as servico
from app.servicos.autenticacao import gerar_hash
from app.servicos.rbac import PermissaoNegada, UsuarioAtual

HOJE = date.today()
DAQUI_A_UM_ANO = HOJE + timedelta(days=365)

# O almoxarife da §8: opera estoque e entrega, não decide o direito ao item.
ALMOXARIFE = frozenset({"epi.ver", "epi.estoque", "epi.entregar"})
# Uma conta só para os testes que precisam armar o pedido inteiro sem trocar de
# usuário três vezes. A separação de função tem teste próprio na fatia 4.
TUDO = frozenset(
    {"epi.ver", "epi.requisitar", "epi.analisar", "epi.estoque", "epi.entregar"}
)


# =====================================================================
# Montagem
# =====================================================================
def _usuario(sessao, permissoes=TUDO, login="operador") -> UsuarioAtual:
    registro = Usuario(
        login=login,
        nome=f"Operador {login}",
        email=f"{login}@teste.ufvjm.edu.br",
        senha_hash=gerar_hash("SenhaDeTeste2026"),
        precisa_trocar_senha=False,
    )
    sessao.add(registro)
    sessao.flush()
    return UsuarioAtual(
        id=registro.id,
        login=login,
        nome=registro.nome,
        permissoes=frozenset(permissoes),
        perfis=("coordenador_csso",),
        servidor_id=None,
    )


def _cenario(
    sessao,
    *,
    recebido: int = 10,
    validade_ca: date | None = None,
    com_lote: bool = True,
    siape: str = "7654321",
    nome: str = "Joana Ribeiro de Almeida",
) -> dict:
    """Um servidor, um item de catálogo com tamanhos e (talvez) um lote."""
    categoria = sessao.execute(
        select(EpiCategoria).where(EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES")
    ).scalar_one()
    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    cargo = sessao.execute(select(Cargo)).scalars().first()

    servidor = Servidor(
        siape=siape,
        nome=nome,
        cargo_id=cargo.id,
        unidade_uorg_id=unidade.id,
    )
    item = sessao.execute(
        select(EpiItem).where(EpiItem.nome == "Luva de proteção química nitrílica")
    ).scalar_one_or_none()
    if item is None:
        item = EpiItem(
            nome="Luva de proteção química nitrílica",
            categoria_id=categoria.id,
            fabricante="Fabricante Exemplo Ltda",
            modelo="NX-200",
            exige_ca=True,
            numero_ca="41234",
            validade_ca=DAQUI_A_UM_ANO,
            unidade_medida="PAR",
            tamanhos="P\nM\nG",
            quantidade_padrao=1,
        )
        sessao.add(item)
    sessao.add(servidor)
    sessao.flush()

    entrada = None
    if com_lote:
        entrada = _lote(
            sessao,
            item,
            recebido=recebido,
            validade_ca=validade_ca or DAQUI_A_UM_ANO,
        )
    return {"servidor": servidor, "item": item, "entrada": entrada}


def _lote(
    sessao,
    item: EpiItem,
    *,
    recebido: int,
    validade_ca: date,
    lote: str = "L-2026-08",
    numero_ca: str = "41234",
    tamanho: str | None = "M",
) -> EpiEntradaEstoque:
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id,
        tamanho=tamanho,
        empenho="2026NE000123",
        data_entrada=HOJE - timedelta(days=60),
        quantidade_recebida=recebido,
        lote=lote,
        numero_ca=numero_ca,
        validade_ca=validade_ca,
    )
    sessao.add(entrada)
    sessao.flush()
    sessao.add(
        EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=recebido)
    )
    sessao.flush()
    return entrada


def _pedido_analisado(
    sessao, cenario, usuario, *, quantidade: int = 2, servidor=None
) -> EpiRequisicaoItem:
    """Um pedido enviado, analisado e com a linha em APROVADO.

    Devolve a LINHA, e não o envelope, porque é sobre ela que a fatia 5 age — o
    envelope se alcança por `linha.requisicao`.
    """
    requisicao = servico.criar_rascunho(
        sessao,
        usuario,
        servidor=servidor or cenario["servidor"],
        descricao_atividade="Manipulação de reagentes no laboratório de análises",
    )
    servico.adicionar_item(
        sessao,
        usuario,
        requisicao,
        item=cenario["item"],
        quantidade=quantidade,
        tamanho="M",
    )
    servico.enviar(sessao, usuario, requisicao)
    servico.iniciar_analise(sessao, usuario, requisicao)
    linha = requisicao.itens[0]
    servico.aprovar_item(sessao, usuario, linha)
    servico.concluir_analise(sessao, usuario, requisicao)
    return linha


def _eventos_de_item(sessao, linha_id: int) -> list[str]:
    return [
        e.tipo_evento
        for e in sessao.execute(
            select(HistoricoEvento)
            .where(
                HistoricoEvento.entidade == servico.ENTIDADE_ITEM,
                HistoricoEvento.entidade_id == linha_id,
            )
            .order_by(HistoricoEvento.id)
        ).scalars()
    ]


# =====================================================================
# 1. `reservado()` deixou de ser zero
# =====================================================================
def test_reservado_bate_com_a_soma_das_linhas_em_reservado(sessao, banco):
    """A função que era um zero declarado passa a somar a verdade.

    Três linhas apontam para o lote e só as em `RESERVADO` contam: a cancelada
    zerou a promessa, e a aprovada nunca a fez.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=10)
    entrada = cenario["entrada"]

    assert epi_estoque.reservado(sessao, entrada.id) == 0

    reservada = _pedido_analisado(sessao, cenario, usuario, quantidade=3)
    servico.reservar_item(sessao, usuario, reservada, entrada=entrada)
    assert epi_estoque.reservado(sessao, entrada.id) == 3

    outra = _cenario(sessao, com_lote=False, siape="1112223", nome="Carlos Menezes")
    cancelada = _pedido_analisado(
        sessao, cenario, usuario, quantidade=2, servidor=outra["servidor"]
    )
    servico.reservar_item(sessao, usuario, cancelada, entrada=entrada)
    assert epi_estoque.reservado(sessao, entrada.id) == 5

    servico.cancelar_item(sessao, usuario, cancelada, "servidor mudou de posto")
    assert epi_estoque.reservado(sessao, entrada.id) == 3


def test_a_versao_agregada_nao_diverge_da_individual(sessao, banco):
    """Duas funções para o mesmo número são o começo de dois números diferentes.

    `reservas_de_todos` existe porque a tela do estoque lista todos os lotes e
    uma consulta por linha seria N+1 — não porque a conta seja outra. Este teste
    é o que impede que ela vire outra.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=10)
    segundo = _lote(
        sessao,
        cenario["item"],
        recebido=6,
        validade_ca=DAQUI_A_UM_ANO,
        lote="L-2026-09",
        numero_ca="41234",
    )
    terceiro = _lote(
        sessao,
        cenario["item"],
        recebido=4,
        validade_ca=DAQUI_A_UM_ANO,
        lote="L-2026-10",
        numero_ca="41234",
    )

    primeira = _pedido_analisado(sessao, cenario, usuario, quantidade=3)
    servico.reservar_item(sessao, usuario, primeira, entrada=cenario["entrada"])
    outra = _cenario(sessao, com_lote=False, siape="1112223", nome="Carlos Menezes")
    segunda = _pedido_analisado(
        sessao, cenario, usuario, quantidade=2, servidor=outra["servidor"]
    )
    servico.reservar_item(sessao, usuario, segunda, entrada=segundo)

    agregado = epi_estoque.reservas_de_todos(sessao)
    for entrada in (cenario["entrada"], segundo, terceiro):
        assert agregado.get(entrada.id, 0) == epi_estoque.reservado(
            sessao, entrada.id
        ), entrada.lote
    # o lote sem reserva nenhuma não aparece no agregado, e a tela lê zero: é o
    # mesmo contrato de `saldos_de_todos`
    assert terceiro.id not in agregado


def test_reservar_nao_mexe_no_fisico_e_desconta_do_disponivel(sessao, banco):
    """Reserva não é movimento — e é por isso que o razão continua conferindo.

    Se reservar escrevesse no livro razão, o saldo físico deixaria de bater com a
    contagem manual da prateleira, que é exatamente a conferência que o razão
    existe para permitir.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=10)
    entrada = cenario["entrada"]
    movimentos_antes = len(epi_estoque.extrato(sessao, entrada.id))

    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=4)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)

    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 10
    assert epi_estoque.reservado(sessao, entrada.id) == 4
    assert epi_estoque.disponivel(sessao, entrada.id) == 6
    assert len(epi_estoque.extrato(sessao, entrada.id)) == movimentos_antes


def test_a_tela_do_estoque_passa_a_mostrar_a_reserva_sozinha(sessao, banco):
    """`panorama` já lia `reservado()`; a fatia 5 só a tornou verdadeira.

    Nenhuma linha da tela precisou mudar para o número aparecer — o que este
    teste protege é justamente isso: `LinhaDeLote.disponivel` continua sendo
    físico menos reservado, e `LinhaDeItem.disponivel` não conta o lote impedido.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=10)
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=4)
    servico.reservar_item(sessao, usuario, linha, entrada=cenario["entrada"])

    painel = epi_estoque.panorama(sessao)
    lote = next(
        lote
        for item in painel
        for lote in item.lotes
        if lote.entrada.id == cenario["entrada"].id
    )
    assert (lote.fisico, lote.reservado, lote.disponivel) == (10, 4, 6)


# =====================================================================
# 2. RN-24 — saldo nunca fica negativo
# =====================================================================
def test_a_entrega_de_balcao_nao_leva_o_que_um_pedido_reservou(sessao, banco):
    """A tela da entrega passou a respeitar a reserva sem uma linha de código nova.

    `epi_ficha.validar` já lia `epi_estoque.disponivel`, e `disponivel` já era
    físico menos `reservado()` — o que faltava era `reservado()` ser verdade.
    Sem isso, o balcão levaria as unidades que um pedido protocolado já tinha
    prometido, e o pedido descobriria no dia da entrega.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=4)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=3)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)

    avulso = _cenario(sessao, com_lote=False, siape="1112223", nome="Carlos Menezes")
    with pytest.raises(epi_ficha.EntregaBloqueada) as falha:
        epi_ficha.registrar_entrega(
            sessao,
            usuario,
            servidor=avulso["servidor"],
            item=cenario["item"],
            quantidade=2,
            entrada=entrada,
            tamanho="M",
        )
    assert "1 disponível" in str(falha.value)

    # o que sobra do lote continua saindo pelo balcão: a reserva prende 3, não 4
    registro = epi_ficha.registrar_entrega(
        sessao,
        usuario,
        servidor=avulso["servidor"],
        item=cenario["item"],
        quantidade=1,
        entrada=entrada,
        tamanho="M",
    )
    assert registro.quantidade == 1
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 3
    assert epi_estoque.reservado(sessao, entrada.id) == 3
    assert epi_estoque.disponivel(sessao, entrada.id) == 0


def test_rn24_recusa_reservar_tres_de_um_lote_com_dois(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=2)
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=3)

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.reservar_item(
            sessao, usuario, linha, entrada=cenario["entrada"], quantidade=3
        )
    assert "RN-24" in str(falha.value)
    assert linha.estado == "APROVADO"
    assert linha.quantidade_reservada == 0


def test_rn24_recusa_entregar_tres_de_um_lote_com_dois(sessao, banco):
    """O teste que a RN-24 nomeia: tenta entregar 3 de um lote com 2.

    Vale pelos dois caminhos, e é o segundo que a fatia 5 acrescenta: sem reserva
    (`APROVADO → ENTREGUE`, que a fatia 4 já cobria) e com reserva parcial, em
    que a entrega não pode passar do que foi prometido.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=2)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=3)

    with pytest.raises(epi_ficha.EntregaBloqueada) as falha:
        servico.entregar_item(
            sessao, usuario, linha, entrada=entrada, quantidade=3
        )
    assert "2 disponível" in str(falha.value)

    # e agora com reserva: reservar o que existe, e a entrega não passa dela
    servico.reservar_item(sessao, usuario, linha, entrada=entrada, quantidade=2)
    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.entregar_item(sessao, usuario, linha, quantidade=3)
    assert "a reserva é de 2" in str(falha.value)

    servico.entregar_item(sessao, usuario, linha)
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 0
    assert epi_estoque.reservado(sessao, entrada.id) == 0
    assert linha.quantidade_entregue == 2


def test_reservar_nao_passa_do_que_outro_pedido_ja_prometeu(sessao, banco):
    """O disponível é o físico menos as promessas dos outros, não o físico."""
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    entrada = cenario["entrada"]

    primeira = _pedido_analisado(sessao, cenario, usuario, quantidade=4)
    servico.reservar_item(sessao, usuario, primeira, entrada=entrada)

    outra = _cenario(sessao, com_lote=False, siape="1112223", nome="Carlos Menezes")
    segunda = _pedido_analisado(
        sessao, cenario, usuario, quantidade=3, servidor=outra["servidor"]
    )
    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.reservar_item(sessao, usuario, segunda, entrada=entrada, quantidade=3)
    # a mensagem separa físico de prometido: quem lê precisa saber que as
    # unidades existem e são de outro pedido, não que o lote acabou
    assert "físico 5" in str(falha.value)
    assert "4 já prometido" in str(falha.value)


def test_duas_reservas_simultaneas_do_mesmo_lote_nao_somam_mais_que_o_disponivel(
    banco,
):
    """A corrida de verdade, em duas linhas de execução e duas conexões.

    `BEGIN IMMEDIATE` (app/banco.py) é o que basta aqui, e o motivo é o mesmo da
    RN-03: o lock de escrita é tomado na PRIMEIRA instrução da transação, então a
    leitura de `disponivel` e a gravação da reserva cabem dentro de uma janela que
    nenhum outro escritor atravessa. Sem ele, as duas transações leriam 3
    disponíveis e prometeriam 2 cada — 4 unidades de um lote que tem 3, que é o
    `Qtd_Estoque` do legado com outra roupa.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        usuario = _usuario(s, login="almoxarife")
        cenario = _cenario(s, recebido=3)
        outra = _cenario(s, com_lote=False, siape="1112223", nome="Carlos Menezes")
        primeira = _pedido_analisado(s, cenario, usuario, quantidade=2)
        segunda = _pedido_analisado(
            s, cenario, usuario, quantidade=2, servidor=outra["servidor"]
        )
        alvo = {
            "entrada": cenario["entrada"].id,
            "usuario": usuario.id,
            "linhas": (primeira.id, segunda.id),
        }
        s.commit()

    def reservar(linha_id: int) -> str:
        with mod_banco.sessao() as s:
            conta = s.get(Usuario, alvo["usuario"])
            operador = UsuarioAtual(
                id=conta.id,
                login=conta.login,
                nome=conta.nome,
                permissoes=ALMOXARIFE,
                perfis=("almoxarife_sesmt",),
                servidor_id=None,
            )
            linha = s.get(EpiRequisicaoItem, linha_id)
            entrada = s.get(EpiEntradaEstoque, alvo["entrada"])
            try:
                servico.reservar_item(
                    s, operador, linha, entrada=entrada, quantidade=2
                )
                return "reservou"
            except servico.RequisicaoBloqueada:
                return "recusado"

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        resultados = sorted(executor.map(reservar, alvo["linhas"]))

    assert resultados == ["recusado", "reservou"]
    with mod_banco.sessao() as s:
        assert epi_estoque.reservado(s, alvo["entrada"]) == 2
        assert epi_estoque.disponivel(s, alvo["entrada"]) == 1


# =====================================================================
# 3. RN-25 — o CA, nos DOIS momentos
# =====================================================================
def test_rn25_recusa_reservar_lote_com_ca_vencido(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5, validade_ca=HOJE - timedelta(days=10))
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.reservar_item(sessao, usuario, linha, entrada=cenario["entrada"])
    assert "venceu em" in str(falha.value)
    assert linha.estado == "APROVADO"


def test_rn25_recusa_reservar_lote_sem_validade_de_ca(sessao, banco):
    """“Não sei” não é “está válido” — e vale na reserva como vale na entrega."""
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    cenario["entrada"].validade_ca = None
    sessao.flush()
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.reservar_item(sessao, usuario, linha, entrada=cenario["entrada"])
    assert "não tem validade de CA registrada" in str(falha.value)


def test_rn25_confere_de_novo_na_entrega_quando_o_ca_vence_no_intervalo(sessao, banco):
    """Os DOIS momentos: reserva em julho, entrega em setembro, CA de agosto.

    É o caso que a RN-25 nomeia e o único que justifica conferir duas vezes.
    Pela NR-6 o Certificado de Aprovação é o que constitui o equipamento como
    EPI: entregar um vencido significa que a instituição não entregou proteção
    nenhuma, e a defesa dela numa fiscalização cai junto.
    """
    usuario = _usuario(sessao)
    venceu_ontem = HOJE - timedelta(days=1)
    cenario = _cenario(sessao, recebido=5, validade_ca=venceu_ontem)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)

    # na data da reserva o CA ainda valia
    servico.reservar_item(
        sessao,
        usuario,
        linha,
        entrada=entrada,
        quando=venceu_ontem - timedelta(days=30),
    )
    assert linha.estado == "RESERVADO"
    assert epi_estoque.reservado(sessao, entrada.id) == 2

    # e na data da entrega já não vale
    with pytest.raises(epi_ficha.EntregaBloqueada) as falha:
        servico.entregar_item(sessao, usuario, linha)
    assert "CA vencido não se entrega" in str(falha.value)


def test_lote_de_ca_vencido_continua_com_saldo_fisico_e_fica_indisponivel(
    sessao, banco
):
    """O lote vencido **não some**: é patrimônio, e alguém tem de dar baixa nele.

    Tirá-lo da prateleira é DESCARTE com motivo — decisão registrada, não
    desaparecimento automático.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=7, validade_ca=HOJE - timedelta(days=30))
    entrada = cenario["entrada"]

    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 7
    lotes = epi_estoque.lotes_de(sessao, cenario["item"], tamanho="M")
    candidato = next(lote for lote in lotes if lote.entrada.id == entrada.id)
    assert candidato.saldo == 7
    assert not candidato.pode_sair
    assert "venceu em" in candidato.impedimento

    painel = epi_estoque.panorama(sessao)
    linha_do_item = next(
        item for item in painel if item.item.id == cenario["item"].id
    )
    assert linha_do_item.preso_em_lote_vencido == 7
    assert linha_do_item.disponivel == 0


# =====================================================================
# 4. As transições da máquina D
# =====================================================================
def test_a_primeira_reserva_leva_a_requisicao_para_em_atendimento(sessao, banco):
    """§4.2: `ANALISADA → EM_ATENDIMENTO` é automática na primeira RESERVA.

    E não só na primeira entrega: é a reserva que marca o começo do atendimento,
    porque dela em diante o pedido já está segurando estoque de outro.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    requisicao = linha.requisicao
    assert requisicao.estado == "ANALISADA"

    servico.reservar_item(sessao, usuario, linha, entrada=cenario["entrada"])
    assert requisicao.estado == "EM_ATENDIMENTO"

    # e a ATENDIDA automática da fatia 4 continua valendo
    servico.entregar_item(sessao, usuario, linha)
    assert linha.estado == "ENTREGUE"
    assert requisicao.estado == "ATENDIDA"


def test_entregar_item_reservado_grava_movimento_e_ficha_na_mesma_transacao(
    sessao, banco
):
    """RESERVADO → ENTREGUE reaproveita `epi_ficha.registrar_entrega`.

    O que se confere aqui é o que a fatia 5 poderia ter duplicado e não
    duplicou: a linha da ficha, a saída no razão amarrada a ela, o vínculo com a
    linha do pedido, e a reserva zerada — tudo numa transação só.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)

    registro = servico.entregar_item(sessao, usuario, linha)

    assert isinstance(registro, EpiFichaRegistro)
    assert registro.requisicao_item_id == linha.id
    assert registro.entrada_id == entrada.id
    # o CA congelado é o DO LOTE, que é o que a RN-25 conferiu
    assert registro.numero_ca_snapshot == entrada.numero_ca
    saida = next(
        m.movimento
        for m in epi_estoque.extrato(sessao, entrada.id)
        if m.movimento.tipo == epi_estoque.SAIDA
    )
    assert saida.quantidade == -2
    assert saida.ficha_registro_id == registro.id
    assert saida.requisicao_item_id == linha.id
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 3
    assert epi_estoque.reservado(sessao, entrada.id) == 0
    assert epi_estoque.disponivel(sessao, entrada.id) == 3


def test_a_entrega_de_item_reservado_nao_troca_de_lote(sessao, banco):
    """Sair de outro lote deixaria a promessa de pé sobre saldo que ninguém busca."""
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    outro = _lote(
        sessao,
        cenario["item"],
        recebido=5,
        validade_ca=DAQUI_A_UM_ANO,
        lote="L-2026-09",
    )
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.reservar_item(sessao, usuario, linha, entrada=cenario["entrada"])

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.entregar_item(sessao, usuario, linha, entrada=outro)
    assert "L-2026-08" in str(falha.value)
    assert "solte a reserva" in str(falha.value).lower()


def test_soltar_reserva_exige_motivo_e_devolve_o_item_para_sem_estoque(sessao, banco):
    """A promessa desfeita volta para `SEM_ESTOQUE`, e não para `APROVADO`.

    `APROVADO` diria que a reserva nunca aconteceu; `SEM_ESTOQUE` é a verdade do
    momento — o item continua devido e continua sem lote.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.soltar_reserva(sessao, usuario, linha, "   ")
    assert "obrigatório" in str(falha.value)
    assert linha.estado == "RESERVADO"

    servico.soltar_reserva(
        sessao, usuario, linha, "unidades foram para a brigada de emergência"
    )
    assert linha.estado == "SEM_ESTOQUE"
    assert linha.quantidade_reservada == 0
    assert linha.entrada_id is None
    assert epi_estoque.disponivel(sessao, entrada.id) == 5
    assert servico.EPI_ITEM_RESERVA_SOLTA in _eventos_de_item(sessao, linha.id)


def test_marcar_sem_estoque_e_recusado_quando_ha_lote_elegivel(sessao, banco):
    """"Sem estoque" com prateleira cheia vira pregão para item que já existe."""
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.marcar_sem_estoque(sessao, usuario, linha)
    assert "há lote elegível" in str(falha.value)
    assert linha.estado == "APROVADO"


def test_marcar_sem_estoque_passa_quando_nao_ha_lote_elegivel(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, com_lote=False)
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)

    servico.marcar_sem_estoque(
        sessao, usuario, linha, complemento="empenho 2026NE000456 em entrega"
    )
    assert linha.estado == "SEM_ESTOQUE"
    assert servico.EPI_ITEM_SEM_ESTOQUE in _eventos_de_item(sessao, linha.id)
    # o envelope NÃO anda: sem estoque não é começo de atendimento
    assert linha.requisicao.estado == "ANALISADA"


def test_sem_estoque_volta_para_reservado_quando_o_almoxarifado_reserva(sessao, banco):
    """A aresta `SEM_ESTOQUE → RESERVADO`, e a decisão de como ela é disparada.

    O §4.3 diz "sistema" nesta aresta. Aqui ela é **ação explícita** do
    almoxarifado, e a entrada de lote não reserva ninguém sozinha — o que ela faz
    é avisar quem espera. Reserva automática mudaria o disponível do lote que
    acabou de chegar por decisão que não está em tela nenhuma, e escolher qual
    pedido fica com estoque escasso é decisão, não ordem de laço por `id`.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, com_lote=False)
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.marcar_sem_estoque(sessao, usuario, linha)

    entrada = epi_estoque.registrar_entrada(
        sessao,
        usuario,
        item=cenario["item"],
        quantidade_recebida=6,
        tamanho="M",
        lote="L-2026-11",
        numero_ca="41234",
        validade_ca=DAQUI_A_UM_ANO,
    )
    # a entrada NÃO reservou sozinha
    assert linha.estado == "SEM_ESTOQUE"
    assert epi_estoque.reservado(sessao, entrada.id) == 0
    # e o item aparece na fila de quem espera aquele equipamento
    esperando = servico.itens_esperando_estoque(
        sessao, epi_item_id=cenario["item"].id, tamanho="M"
    )
    assert [i.id for i in esperando] == [linha.id]

    servico.reservar_item(sessao, usuario, linha, entrada=entrada)
    assert linha.estado == "RESERVADO"
    assert epi_estoque.reservado(sessao, entrada.id) == 2


def test_a_maquina_recusa_toda_transicao_de_reserva_nao_declarada(sessao, banco):
    """As arestas que a §4.3 não declara continuam fechadas.

    `SOLICITADO → RESERVADO` (reservar antes de decidir), `SEM_ESTOQUE →
    ENTREGUE` (entregar sem passar pela reserva) e a volta de `RESERVADO` para
    `APROVADO` (que apagaria da tela que houve promessa desfeita).
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    requisicao = servico.criar_rascunho(
        sessao,
        usuario,
        servidor=cenario["servidor"],
        descricao_atividade="Manipulação de reagentes",
    )
    servico.adicionar_item(
        sessao, usuario, requisicao, item=cenario["item"], quantidade=1, tamanho="M"
    )
    servico.enviar(sessao, usuario, requisicao)
    solicitada = requisicao.itens[0]

    for destino in ("RESERVADO", "SEM_ESTOQUE"):
        with pytest.raises(TransicaoInvalida):
            servico._mover_item(
                sessao,
                solicitada,
                destino,
                usuario,
                tipo_evento=servico.EPI_ITEM_RESERVADO,
            )

    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.reservar_item(sessao, usuario, linha, entrada=cenario["entrada"])
    for destino in ("APROVADO", "SOLICITADO", "RECUSADO"):
        with pytest.raises(TransicaoInvalida):
            servico._mover_item(
                sessao, linha, destino, usuario, tipo_evento=servico.EPI_ITEM_APROVADO
            )

    servico.soltar_reserva(sessao, usuario, linha, "lote separado para outro caso")
    with pytest.raises(TransicaoInvalida):
        servico._mover_item(
            sessao, linha, "ENTREGUE", usuario, tipo_evento=servico.EPI_ITEM_ENTREGUE
        )


def test_reservar_e_soltar_exigem_a_permissao_de_estoque(sessao, banco):
    """A reserva é do almoxarifado (§4.3), não de quem analisa nem de quem pede."""
    dono = _usuario(sessao, login="operador")
    cenario = _cenario(sessao, recebido=5)
    linha = _pedido_analisado(sessao, cenario, dono, quantidade=2)
    analista = _usuario(
        sessao,
        permissoes={"epi.ver", "epi.requisitar", "epi.analisar"},
        login="analista",
    )

    with pytest.raises(PermissaoNegada):
        servico.reservar_item(sessao, analista, linha, entrada=cenario["entrada"])
    with pytest.raises(PermissaoNegada):
        servico.marcar_sem_estoque(sessao, analista, linha)

    servico.reservar_item(sessao, dono, linha, entrada=cenario["entrada"])
    with pytest.raises(PermissaoNegada):
        servico.soltar_reserva(sessao, analista, linha, "não deveria passar")


def test_reservar_recusa_lote_de_outro_item_e_de_outro_tamanho(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    outro_item = EpiItem(
        nome="Óculos de proteção",
        categoria_id=cenario["item"].categoria_id,
        exige_ca=True,
        numero_ca="55555",
        validade_ca=DAQUI_A_UM_ANO,
        quantidade_padrao=1,
    )
    sessao.add(outro_item)
    sessao.flush()
    lote_de_outro_item = _lote(
        sessao, outro_item, recebido=5, validade_ca=DAQUI_A_UM_ANO, lote="L-OC-01"
    )
    lote_tamanho_p = _lote(
        sessao,
        cenario["item"],
        recebido=5,
        validade_ca=DAQUI_A_UM_ANO,
        lote="L-2026-P",
        tamanho="P",
    )
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.reservar_item(sessao, usuario, linha, entrada=lote_de_outro_item)
    assert "outro item do catálogo" in str(falha.value)

    with pytest.raises(servico.RequisicaoBloqueada) as falha:
        servico.reservar_item(sessao, usuario, linha, entrada=lote_tamanho_p)
    assert "tamanho" in str(falha.value)


# =====================================================================
# 5. A promessa se desfaz onde perdeu o lastro
# =====================================================================
def test_cancelar_item_reservado_solta_a_reserva(sessao, banco):
    """Pedido morto que continuasse segurando lote faria o disponível mentir."""
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=3)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)
    assert epi_estoque.disponivel(sessao, entrada.id) == 2

    servico.cancelar_item(sessao, usuario, linha, "servidor foi desligado")
    assert linha.estado == "CANCELADO"
    assert linha.quantidade_reservada == 0
    assert linha.entrada_id is None
    assert epi_estoque.disponivel(sessao, entrada.id) == 5


def test_cancelar_o_pedido_inteiro_solta_as_reservas_dele(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=3)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)

    servico.cancelar(
        sessao, usuario, linha.requisicao, "pedido substituído por outro protocolo"
    )
    assert linha.estado == "CANCELADO"
    assert epi_estoque.reservado(sessao, entrada.id) == 0
    assert epi_estoque.disponivel(sessao, entrada.id) == 5


def test_descartar_o_lote_solta_a_reserva_que_ficou_sem_lastro(sessao, banco):
    """Quem descobrisse isso no balcão teria a pessoa na frente e nenhum motivo.

    Solta o mínimo e da mais nova para a mais antiga: quem esperou mais tempo é
    quem menos deve perder o lugar.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=6)
    entrada = cenario["entrada"]
    outra = _cenario(sessao, com_lote=False, siape="1112223", nome="Carlos Menezes")

    antiga = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.reservar_item(sessao, usuario, antiga, entrada=entrada)
    nova = _pedido_analisado(
        sessao, cenario, usuario, quantidade=3, servidor=outra["servidor"]
    )
    servico.reservar_item(sessao, usuario, nova, entrada=entrada)
    assert epi_estoque.reservado(sessao, entrada.id) == 5

    # sobram 2 físicos: a promessa de 5 não cabe, e a mais nova cai
    epi_estoque.descartar(
        sessao,
        usuario,
        entrada=entrada,
        quantidade=4,
        motivo="caixa molhada em alagamento do almoxarifado",
    )
    assert nova.estado == "SEM_ESTOQUE"
    assert antiga.estado == "RESERVADO"
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 2
    assert epi_estoque.reservado(sessao, entrada.id) == 2
    assert epi_estoque.disponivel(sessao, entrada.id) == 0
    assert "descartadas" in str(
        next(
            e.comentario
            for e in sessao.execute(
                select(HistoricoEvento).where(
                    HistoricoEvento.entidade == servico.ENTIDADE_ITEM,
                    HistoricoEvento.entidade_id == nova.id,
                    HistoricoEvento.tipo_evento == servico.EPI_ITEM_RESERVA_SOLTA,
                )
            ).scalars()
        )
    )


def test_inativar_o_lote_solta_todas_as_reservas_dele(sessao, banco):
    """Lote inativo é impedimento: reserva nele é promessa que já se sabe morta."""
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=10)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)

    epi_estoque.atualizar_lote(
        sessao,
        usuario,
        entrada=entrada,
        nota_fiscal="",
        fornecedor_contato="",
        observacao="",
        ativo=False,
        motivo_inativacao="recolhimento do fabricante por defeito de costura",
    )
    assert linha.estado == "SEM_ESTOQUE"
    assert epi_estoque.reservado(sessao, entrada.id) == 0
    # o saldo físico continua lá: inativar não é descartar
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 10


def test_ajuste_de_inventario_para_menos_solta_o_que_nao_cabe(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=6)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=5)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)

    epi_estoque.ajustar(
        sessao,
        usuario,
        entrada=entrada,
        contagem=3,
        motivo="contagem do inventário anual",
    )
    assert linha.estado == "SEM_ESTOQUE"
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 3
    assert epi_estoque.reservado(sessao, entrada.id) == 0


def test_reserva_parcial_entregue_inteira_devolve_o_item_para_sem_estoque(
    sessao, banco
):
    """`RESERVADO` com zero reservado seria estado que não descreve fato nenhum.

    É o defeito que a §4.1 aponta em "liberada", e o caso chega aqui pelo caminho
    legítimo: o lote tinha 2 de um pedido de 5, reservou-se o que havia, e a
    entrega consumiu a reserva inteira deixando 3 a dever.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=2)
    entrada = cenario["entrada"]
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=5)

    servico.reservar_item(sessao, usuario, linha, entrada=entrada, quantidade=2)
    servico.entregar_item(sessao, usuario, linha)

    assert linha.quantidade_entregue == 2
    assert linha.quantidade_devida == 3
    assert linha.estado == "SEM_ESTOQUE"
    assert linha.quantidade_reservada == 0
    assert linha.entrada_id is None
    # o envelope continua em atendimento: ainda deve 3
    assert linha.requisicao.estado == "EM_ATENDIMENTO"


def test_reserva_solta_e_reservada_de_novo_no_mesmo_lote(sessao, banco):
    """O caminho de ida e volta, que é o caso real do lote trocado.

    Solta com motivo, o item volta a esperar estoque, e a reserva seguinte parte
    do disponível recomposto — sem que nada tenha entrado nem saído do razão.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    entrada = cenario["entrada"]
    outro = _lote(
        sessao,
        cenario["item"],
        recebido=4,
        validade_ca=DAQUI_A_UM_ANO,
        lote="L-2026-09",
    )
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=3)

    servico.reservar_item(sessao, usuario, linha, entrada=entrada)
    servico.soltar_reserva(sessao, usuario, linha, "lote trocado a pedido do setor")
    servico.reservar_item(sessao, usuario, linha, entrada=outro)

    assert linha.estado == "RESERVADO"
    assert linha.entrada_id == outro.id
    assert epi_estoque.disponivel(sessao, entrada.id) == 5
    assert epi_estoque.disponivel(sessao, outro.id) == 1
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 5
    assert epi_estoque.saldo_fisico(sessao, outro.id) == 4


def test_recusar_item_reservado_nao_e_caminho_e_o_estado_nao_muda(sessao, banco):
    """Recusa é decisão de mérito, e ela acontece antes da reserva existir.

    A máquina não declara `RESERVADO → RECUSADO`, e é a máquina que recusa: um
    item já prometido não vira negativa fundamentada — ele vira reserva solta
    (com motivo) e depois cancelamento, se for o caso.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, recebido=5)
    linha = _pedido_analisado(sessao, cenario, usuario, quantidade=2)
    servico.reservar_item(sessao, usuario, linha, entrada=cenario["entrada"])
    motivo = sessao.execute(
        select(EpiMotivoRecusa).where(EpiMotivoRecusa.codigo == "SEM_EXPOSICAO")
    ).scalar_one()

    with pytest.raises(servico.RequisicaoBloqueada):
        servico.recusar_item(sessao, usuario, linha, motivo=motivo)
    assert linha.estado == "RESERVADO"


# =====================================================================
# 6. Pela tela — o que só a tela pode quebrar
# =====================================================================
def _pedido_pela_tela(cliente, *, recebido=5, validade_ca=None, com_lote=True) -> dict:
    """Um pedido analisado, com a linha em APROVADO, pronto para reservar."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        operador = _usuario(s, login="montagem")
        cenario = _cenario(
            s, recebido=recebido, validade_ca=validade_ca, com_lote=com_lote
        )
        linha = _pedido_analisado(s, cenario, operador, quantidade=2)
        dados = {
            "requisicao": linha.requisicao_id,
            "linha": linha.id,
            "entrada": cenario["entrada"].id if cenario["entrada"] else None,
            "item": cenario["item"].id,
        }
        s.commit()
    return dados


def _estado_da_linha(linha_id: int) -> EpiRequisicaoItem:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return s.get(EpiRequisicaoItem, linha_id)


def test_a_ficha_do_pedido_oferece_reservar_a_quem_opera_o_estoque(
    app_cliente, contas, banco
):
    """Quem analisa vê o pedido e não promete lote: a reserva é do almoxarifado.

    O `engenheiro_seguranca` da matriz do §8 tem `epi.analisar` e **não** tem
    `epi.estoque`; o `almoxarife_sesmt` tem o contrário. A tela tem de refletir a
    mesma divisão que a rota exige — botão oferecido que a rota recusa é a porta
    trancada que o menu do sistema já aprendeu a não oferecer.
    """
    from testes.integracao.conftest import entrar

    dados = _pedido_pela_tela(app_cliente)
    caminho = f"/epis/requisicoes/{dados['requisicao']}"

    entrar(app_cliente, contas, "engenheiro_seguranca")
    corpo = app_cliente.get(caminho).text
    assert "Reservar lote" not in corpo
    app_cliente.get("/sair")

    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = app_cliente.get(caminho).text
    assert "Reservar lote" in corpo
    assert "Marcar como sem estoque" in corpo
    # o lote candidato aparece com saldo e CA ao lado da escolha
    assert "L-2026-08" in corpo
    assert "5 em estoque" in corpo


def test_a_tela_reserva_solta_e_mostra_o_lote_reservado(app_cliente, contas, banco):
    from testes.integracao.conftest import entrar

    dados = _pedido_pela_tela(app_cliente)
    caminho = f"/epis/requisicoes/{dados['requisicao']}"
    entrar(app_cliente, contas, "almoxarife_sesmt")

    resposta = app_cliente.post(
        f"{caminho}/itens/{dados['linha']}/reservar",
        data={"entrada_id": str(dados["entrada"]), "quantidade": "2"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert _estado_da_linha(dados["linha"]).estado == "RESERVADO"

    corpo = app_cliente.get(caminho).text
    assert "2\n            reservado(s) no lote L-2026-08" in corpo.replace("\r\n", "\n")
    assert "Soltar a reserva" in corpo

    resposta = app_cliente.post(
        f"{caminho}/itens/{dados['linha']}/soltar-reserva",
        data={"motivo": "lote separado para a brigada de emergência"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    linha = _estado_da_linha(dados["linha"])
    assert linha.estado == "SEM_ESTOQUE"
    assert linha.quantidade_reservada == 0


def test_a_tela_recusa_reservar_sem_dizer_o_lote(app_cliente, contas, banco):
    """Reservar sem lote seria prometer um número; o que a pessoa calça é a caixa."""
    from testes.integracao.conftest import entrar
    from urllib.parse import unquote

    dados = _pedido_pela_tela(app_cliente)
    entrar(app_cliente, contas, "almoxarife_sesmt")
    resposta = app_cliente.post(
        f"/epis/requisicoes/{dados['requisicao']}/itens/{dados['linha']}/reservar",
        data={"entrada_id": "", "quantidade": "2"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "Escolha o lote" in unquote(resposta.headers["location"])
    assert _estado_da_linha(dados["linha"]).estado == "APROVADO"


def test_ca_vencido_e_etiqueta_vermelha_com_o_botao_desabilitado_e_o_motivo(
    app_cliente, contas, banco
):
    """RN-25 na tela: o lote não some, fica marcado, e o botão diz por quê.

    Botão que some sem explicação faz quem opera procurar defeito no sistema em
    vez de resolver o problema do lote — e o problema do lote tem dois caminhos
    escritos ao lado: renovar o CA ou dar entrada de lote novo.
    """
    from testes.integracao.conftest import entrar

    dados = _pedido_pela_tela(
        app_cliente, recebido=5, validade_ca=HOJE - timedelta(days=15)
    )
    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = app_cliente.get(f"/epis/requisicoes/{dados['requisicao']}").text

    # o lote continua na lista, com saldo, e marcado
    assert "L-2026-08" in corpo
    assert "pilula erro" in corpo
    assert "venceu em" in corpo
    assert "INDISPONÍVEL" in corpo
    assert "Botão desabilitado" in corpo
    assert "renovar o CA do lote" in corpo

    # e a rota recusa, caso alguém remova o `disabled` no navegador
    resposta = app_cliente.post(
        f"/epis/requisicoes/{dados['requisicao']}/itens/{dados['linha']}/reservar",
        data={"entrada_id": str(dados["entrada"]), "quantidade": "2"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert _estado_da_linha(dados["linha"]).estado == "APROVADO"


def test_a_tela_do_estoque_nao_diz_mais_que_reservar_nao_existe(
    app_cliente, contas, banco
):
    """A coluna deixou de ser sempre zero, e o texto ao pé deixou de mentir."""
    from testes.integracao.conftest import entrar

    dados = _pedido_pela_tela(app_cliente)
    entrar(app_cliente, contas, "almoxarife_sesmt")
    app_cliente.post(
        f"/epis/requisicoes/{dados['requisicao']}/itens/{dados['linha']}/reservar",
        data={"entrada_id": str(dados["entrada"]), "quantidade": "2"},
        follow_redirects=False,
    )

    corpo = app_cliente.get("/epis/estoque").text
    assert "Reservado" in corpo
    assert "Reserva não é movimento" in corpo
    # físico 5, reservado 2, disponível 3 — os três lado a lado (RN-24).
    # A classe é `numerico` e não `mono`: as quatro colunas de conferência do
    # estoque passaram a levar o alinhamento à direita e o dígito de largura fixa
    # que `.mono` não dava — e a asserção continua sendo sobre a MARCAÇÃO, e não
    # só sobre o número solto, para não passar por causa de um "5" em qualquer
    # outra célula da página.
    assert '<td class="numerico">5</td>' in corpo
    assert '<td class="numerico">2</td>' in corpo
    assert '<td class="numerico">3</td>' in corpo


def test_a_entrada_de_lote_avisa_quem_espera_em_vez_de_reservar_sozinha(
    app_cliente, contas, banco
):
    """A decisão da aresta `SEM_ESTOQUE → RESERVADO`, conferida pela tela.

    O que a entrada de lote faz é **avisar**. Reservar sozinha mudaria o
    disponível do lote que acabou de chegar por decisão que não está nesta tela,
    e é assim que a contagem manual passa a divergir do sistema sem explicação.
    """
    from urllib.parse import unquote

    from testes.integracao.conftest import entrar

    dados = _pedido_pela_tela(app_cliente, com_lote=False)
    entrar(app_cliente, contas, "almoxarife_sesmt")
    app_cliente.post(
        f"/epis/requisicoes/{dados['requisicao']}/itens/{dados['linha']}/sem-estoque",
        data={"complemento": ""},
        follow_redirects=False,
    )
    assert _estado_da_linha(dados["linha"]).estado == "SEM_ESTOQUE"

    resposta = app_cliente.post(
        "/epis/estoque",
        data={
            "item_id": str(dados["item"]),
            "quantidade_recebida": "12",
            "data_entrada": HOJE.isoformat(),
            "tamanho": "M",
            "lote": "L-2026-12",
            "numero_ca": "41234",
            "validade_ca": DAQUI_A_UM_ANO.isoformat(),
        },
        follow_redirects=False,
    )
    recado = unquote(resposta.headers["location"])
    assert "1 item(ns) de pedido(s) esperam este equipamento" in recado
    assert "a reserva não é automática" in recado
    # e nada foi reservado por conta própria
    assert _estado_da_linha(dados["linha"]).estado == "SEM_ESTOQUE"
