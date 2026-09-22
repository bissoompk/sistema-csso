"""Fatia 3 de Gestão de EPI: o estoque — entrada de lote, razão e saldo.

O que estes testes protegem, em ordem de gravidade:

1. **Saldo é soma de movimentos, nunca célula.** No legado `Qtd_Estoque` era uma
   coluna que se sobrescrevia: duas entregas simultâneas perdiam uma, sem rastro
   do que baixou. Aqui o saldo se calcula do razão em cada passo, e o razão é
   append-only.
2. **Devolução não é estorno.** Devolução repõe saldo porque o equipamento
   voltou; estorno não repõe nada porque o que estava errado era o registro.
   Trocar uma pela outra estraga o razão de um jeito que só a contagem física
   descobre.
3. **O lote vencido continua no estoque, marcado.** Ele tem saldo, é patrimônio,
   e sai da prateleira por decisão registrada — `DESCARTE` com motivo —, nunca
   por desaparecimento automático.
4. **Ajuste é a única forma legítima de o saldo encontrar a contagem física**, e
   deixa rastro de quem contou, quanto contou e por quê.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from urllib.parse import unquote

import pytest
import sqlalchemy as sa
from sqlalchemy import select

from app.modelos import (
    Cargo,
    EpiCategoria,
    EpiEntradaEstoque,
    EpiFichaRegistro,
    EpiItem,
    EpiMovimentoEstoque,
    HistoricoEvento,
    Pendencia,
    Servidor,
    UnidadeUorg,
)
from testes.integracao.conftest import entrar

ESTOQUE = "/epis/estoque"
ENTREGAS = "/epis/entregas"
FICHAS = "/epis/fichas"

HOJE = date.today()
ONTEM = HOJE - timedelta(days=1)
DAQUI_A_UM_ANO = HOJE + timedelta(days=365)
DAQUI_A_UM_MES = HOJE + timedelta(days=30)


# =====================================================================
# Cenário
# =====================================================================
def _cenario(*, vida_util_meses: int | None = 6) -> dict:
    """Um item de catálogo e um servidor. Os lotes entram pela tela."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        categoria = s.execute(
            select(EpiCategoria).where(EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES")
        ).scalar_one()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        cargo = s.execute(select(Cargo)).scalars().first()
        item = EpiItem(
            nome="Luva de proteção química nitrílica",
            categoria_id=categoria.id,
            fabricante="Fabricante Exemplo Ltda",
            marca="Nitri",
            modelo="NX-200",
            exige_ca=True,
            numero_ca="41234",
            validade_ca=DAQUI_A_UM_ANO,
            unidade_medida="PAR",
            tamanhos="P\nM\nG",
            vida_util_meses=vida_util_meses,
            quantidade_padrao=2,
        )
        servidor = Servidor(
            siape="7654321",
            nome="Joana Ribeiro de Almeida",
            cargo_id=cargo.id,
            unidade_uorg_id=unidade.id,
        )
        s.add_all([item, servidor])
        s.commit()
        return {"item": item.id, "servidor": servidor.id}


def _lote(cliente, cenario, **troca):
    dados = {
        "item_id": str(cenario["item"]),
        "quantidade_recebida": "10",
        "data_entrada": HOJE.isoformat(),
        "tamanho": "M",
        "pregao": "90012/2025",
        "item_pregao": "7",
        "empenho": "2026NE000123",
        "nota_fiscal": "4471",
        "quantidade_empenhada": "12",
        "valor_unitario": "12,50",
        "fornecedor_nome": "Distribuidora de EPI Ltda",
        "fornecedor_cnpj": "12345678000199",
        "fornecedor_contato": "vendas@distribuidora.com.br",
        "lote": "L-2026-08",
        "numero_ca": "41234",
        "validade_ca": DAQUI_A_UM_ANO.isoformat(),
        "data_fabricacao": "",
        "observacao": "",
    }
    dados.update({k: str(v) for k, v in troca.items()})
    return cliente.post(ESTOQUE, data=dados, follow_redirects=False)


def _entradas() -> list[EpiEntradaEstoque]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return list(
            s.execute(select(EpiEntradaEstoque).order_by(EpiEntradaEstoque.id)).scalars()
        )


def _movimentos(entrada_id: int) -> list[EpiMovimentoEstoque]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return list(
            s.execute(
                select(EpiMovimentoEstoque)
                .where(EpiMovimentoEstoque.entrada_id == entrada_id)
                .order_by(EpiMovimentoEstoque.id)
            ).scalars()
        )


def _saldo(entrada_id: int) -> int:
    from app import banco as mod_banco
    from app.servicos import epi_estoque

    with mod_banco.sessao() as s:
        return epi_estoque.saldo_fisico(s, entrada_id)


def _entregar(cliente, cenario, entrada_id: int, quantidade: int = 3):
    return cliente.post(
        ENTREGAS,
        data={
            "servidor_id": str(cenario["servidor"]),
            "item_id": str(cenario["item"]),
            "quantidade": str(quantidade),
            "entrada_id": str(entrada_id),
            "tamanho": "M",
            "data_evento": HOJE.isoformat(),
            "observacao": "",
            "justificativa_excecao": "",
        },
        follow_redirects=False,
    )


def _registros() -> list[EpiFichaRegistro]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return list(
            s.execute(select(EpiFichaRegistro).order_by(EpiFichaRegistro.id)).scalars()
        )


def _recado(resposta) -> str:
    """O que o sistema respondeu, venha por redirect ou pela tela redesenhada.

    O sucesso continua saindo em 303 com o recado na querystring. A **recusa** da
    entrada de lote, não: ela redesenha a tela com os dezenove campos como foram
    digitados (o padrão `digitado` de `processos.criar`), porque refazer a
    transcrição de uma nota fiscal por causa de uma data é o atrito que faz a
    conferência ser feita fora do sistema.
    """
    destino = resposta.headers.get("location")
    return unquote(destino) if destino else resposta.text


# =====================================================================
# 1. A entrada do lote
# =====================================================================
def test_a_entrada_grava_a_compra_publica_e_o_primeiro_movimento(
    app_cliente, contas, banco
):
    """Pregão, item, empenho, fornecedor e valor — o que o legado acertou.

    E o que ele errou: aqui a quantidade recebida é fato imutável da nota, e o
    saldo nasce como movimento do razão, não como célula.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    assert _lote(app_cliente, cenario).status_code == 303

    entrada = _entradas()[0]
    assert entrada.pregao == "90012/2025"
    assert entrada.item_pregao == "7"
    assert entrada.empenho == "2026NE000123"
    assert entrada.nota_fiscal == "4471"
    assert entrada.fornecedor_nome == "Distribuidora de EPI Ltda"
    assert entrada.fornecedor_cnpj == "12345678000199"
    # o contato do fornecedor é o que permite acionar quem entregou o lote
    assert entrada.fornecedor_contato == "vendas@distribuidora.com.br"
    assert entrada.quantidade_empenhada == 12
    assert entrada.quantidade_recebida == 10
    # dinheiro é Decimal, e "12,50" é como se digita em português
    assert entrada.valor_unitario == Decimal("12.50")
    # o CA do LOTE, que é o que decide a entrega
    assert entrada.numero_ca == "41234"
    assert entrada.validade_ca == DAQUI_A_UM_ANO

    movimentos = _movimentos(entrada.id)
    assert len(movimentos) == 1
    assert movimentos[0].tipo == "ENTRADA"
    assert movimentos[0].quantidade == 10
    assert _saldo(entrada.id) == 10


def test_o_lote_vai_para_a_trilha_com_numero_e_dinheiro_de_verdade(
    app_cliente, contas, banco
):
    """A trava da auditoria (1.19.1) recusa valor que não volta igual do banco.

    Gravar `"10"` onde o valor é `10` faria o digest ser calculado sobre uma
    coisa e conferido sobre outra — e a cadeia acusaria adulteração onde ninguém
    tocou em nada.
    """
    from app import banco as mod_banco
    from app.servicos.auditoria import cadeia_integra

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)

    with mod_banco.sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "EPI_LOTE_REGISTRADO"
            )
        ).scalar_one()
        assert evento.valor_novo["quantidade_recebida"] == 10
        assert isinstance(evento.valor_novo["quantidade_recebida"], int)
        assert evento.valor_novo["empenho"] == "2026NE000123"
        # `Decimal` sobrevive à ida e à volta pela coluna; `float` não
        assert evento.valor_novo["valor_unitario"] == "12.50"
        assert cadeia_integra(s) == (True, None)


def test_receber_mais_do_que_o_empenho_e_recusado(app_cliente, contas, banco):
    """Ou é erro de digitação, ou é entrega fora do contrato. Nos dois casos
    alguém tem de olhar antes de o número entrar no razão."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _lote(app_cliente, cenario, quantidade_empenhada="5", quantidade_recebida="10")
    assert "empenho é de 5" in _recado(resposta)
    assert _entradas() == []


def test_entrada_com_data_futura_e_recusada(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _lote(
        app_cliente, cenario, data_entrada=(HOJE + timedelta(days=1)).isoformat()
    )
    assert "não pode ser futura" in _recado(resposta)
    assert _entradas() == []


def test_valor_em_branco_nao_vira_zero(app_cliente, contas, banco):
    """"Não sei quanto custou" e "custou nada" são coisas diferentes."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, valor_unitario="")
    assert _entradas()[0].valor_unitario is None


# =====================================================================
# 2. RN-25 — o lote vencido entra, aparece e não sai
# =====================================================================
def test_lote_com_ca_vencido_entra_no_estoque_e_avisa(app_cliente, contas, banco):
    """Recusar a entrada faria o setor guardar caixa que o sistema não conhece —
    que é como o estoque paralelo nasce."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _lote(app_cliente, cenario, validade_ca=ONTEM.isoformat())
    assert resposta.status_code == 303
    assert "não pode ser entregue" in _recado(resposta)
    assert len(_entradas()) == 1


def test_o_lote_vencido_fica_visivel_e_marcado_no_estoque(app_cliente, contas, banco):
    """Some da lista de entrega, não da lista de estoque: ele tem saldo, é
    patrimônio, e alguém vai ter de dar baixa nele."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, validade_ca=ONTEM.isoformat())

    corpo = app_cliente.get(ESTOQUE).text
    assert f"/epis/estoque/{_entradas()[0].id}/movimentos" in corpo
    assert "venceu em" in corpo
    assert "não pode ser entregue" in corpo
    assert "10 unidade(s) em 1 lote(s)" in corpo


def test_lote_vencido_nao_sai_e_o_saldo_nao_se_move(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, validade_ca=ONTEM.isoformat())
    entrada = _entradas()[0]

    resposta = _entregar(app_cliente, cenario, entrada.id)
    assert "CA vencido" in _recado(resposta)
    assert _saldo(entrada.id) == 10


# =====================================================================
# 3. O saldo em cada passo — a fatia inteira, de ponta a ponta
# =====================================================================
def test_o_saldo_bate_em_cada_passo_da_vida_do_lote(app_cliente, contas, banco):
    """Entrada, entrega, devolução, descarte e ajuste — conferindo a cada um.

    É o teste que substitui a coluna `Qtd_Estoque`: nenhum destes números está
    gravado em lugar nenhum, todos saem da soma do razão.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    assert _saldo(entrada.id) == 10

    assert _entregar(app_cliente, cenario, entrada.id, 3).status_code == 303
    assert _saldo(entrada.id) == 7

    registro = _registros()[0]
    devolucao = app_cliente.post(
        f"{FICHAS}/registros/{registro.id}/devolucao",
        data={"quantidade": "2", "motivo": "troca por desgaste", "data_evento": ""},
        follow_redirects=False,
    )
    assert devolucao.status_code == 303
    assert _saldo(entrada.id) == 9

    descarte = app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/descarte",
        data={"quantidade": "1", "motivo": "par rasgado na conferência"},
        follow_redirects=False,
    )
    assert descarte.status_code == 303
    assert _saldo(entrada.id) == 8

    ajuste = app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/ajuste",
        data={"contagem": "6", "motivo": "contagem do inventário anual"},
        follow_redirects=False,
    )
    assert ajuste.status_code == 303
    assert _saldo(entrada.id) == 6

    # e o extrato conta a mesma história, com o saldo acumulado linha a linha
    tipos = [(m.tipo, m.quantidade) for m in _movimentos(entrada.id)]
    assert tipos == [
        ("ENTRADA", 10),
        ("SAIDA", -3),
        ("DEVOLUCAO", 2),
        ("DESCARTE", -1),
        ("AJUSTE", -2),
    ]
    corpo = app_cliente.get(f"{ESTOQUE}/{entrada.id}/movimentos").text
    for esperado in ("entrada", "saída", "devolução", "descarte", "ajuste"):
        assert esperado in corpo
    assert "contagem física 6" in corpo


def test_o_extrato_acumula_o_saldo_na_ordem_em_que_os_fatos_foram_gravados(
    app_cliente, contas, banco
):
    from app import banco as mod_banco
    from app.servicos import epi_estoque

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 4)

    with mod_banco.sessao() as s:
        linhas = epi_estoque.extrato(s, entrada.id)
        assert [l.saldo_depois for l in linhas] == [10, 6]
        assert linhas[-1].saldo_depois == epi_estoque.saldo_fisico(s, entrada.id)


# =====================================================================
# 4. Devolução × estorno — a distinção que a fatia 2 deixou explícita
# =====================================================================
def test_devolucao_repoe_saldo_e_estorno_nao(app_cliente, contas, banco):
    """Estorno diz que o REGISTRO estava errado; devolução é fato do mundo.

    São movimentos diferentes e não se confundem: fazer as duas coisas com um
    clique só criaria a divergência que o razão existe para impedir.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]

    _entregar(app_cliente, cenario, entrada.id, 4)
    assert _saldo(entrada.id) == 6
    primeira = _registros()[0]

    # estorno: o registro estava errado, e nada voltou da prateleira
    app_cliente.post(
        f"{FICHAS}/registros/{primeira.id}/estorno",
        data={"motivo": "servidor errado"},
    )
    assert _saldo(entrada.id) == 6

    # devolução: o equipamento voltou, e o saldo sobe
    _entregar(app_cliente, cenario, entrada.id, 2)
    assert _saldo(entrada.id) == 4
    segunda = _registros()[-1]
    app_cliente.post(
        f"{FICHAS}/registros/{segunda.id}/devolucao",
        data={"quantidade": "2", "motivo": "desligamento do servidor"},
    )
    assert _saldo(entrada.id) == 6

    tipos = [m.tipo for m in _movimentos(entrada.id)]
    assert tipos == ["ENTRADA", "SAIDA", "SAIDA", "DEVOLUCAO"]


def test_a_devolucao_vira_linha_na_ficha_sem_desfazer_a_entrega(
    app_cliente, contas, banco
):
    """A entrega continua tendo acontecido: o comprovante assinado dela continua
    valendo, e a devolução é um fato posterior."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 3)
    entrega = _registros()[0]

    app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/devolucao",
        data={"quantidade": "1", "motivo": "luva furada"},
    )
    registros = _registros()
    assert len(registros) == 2
    devolucao = registros[1]
    assert devolucao.tipo == "DEVOLUCAO"
    assert devolucao.quantidade == 1
    # herda os snapshots: fala DAQUELE equipamento, com aquele CA e aquele lote
    assert devolucao.nome_epi_snapshot == entrega.nome_epi_snapshot
    assert devolucao.numero_ca_snapshot == entrega.numero_ca_snapshot
    assert devolucao.lote_snapshot == entrega.lote_snapshot
    # e aponta para a entrega de onde veio, sem usar `registro_estornado_id`,
    # que quer dizer "esta linha anula aquela"
    assert devolucao.registro_estornado_id is None
    assert devolucao.contexto_congelado["registro_devolvido"] == entrega.id

    corpo = app_cliente.get(f"{FICHAS}/{cenario['servidor']}").text
    assert "devolução" in corpo
    # a entrega não virou estorno nem sumiu
    assert "estornado pelo" not in corpo


def test_nao_se_devolve_mais_do_que_a_pessoa_recebeu(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 2)
    entrega = _registros()[0]

    resposta = app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/devolucao",
        data={"quantidade": "5", "motivo": "devolveu tudo"},
        follow_redirects=False,
    )
    assert "está com 2" in _recado(resposta)
    assert _saldo(entrada.id) == 8


def test_devolucao_sem_motivo_e_recusada(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 2)
    entrega = _registros()[0]

    resposta = app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/devolucao",
        data={"quantidade": "1", "motivo": "   "},
        follow_redirects=False,
    )
    assert "por que o equipamento voltou" in _recado(resposta)
    assert _saldo(entrada.id) == 8


def test_estornar_entrega_ja_devolvida_e_recusado(app_cliente, contas, banco):
    """Os dois juntos criariam unidades que nunca existiram: a devolução já
    repôs o saldo, e o estorno diria que a entrega que o gerou não valia."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 3)
    entrega = _registros()[0]
    app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/devolucao",
        data={"quantidade": "3", "motivo": "trocou de posto"},
    )

    resposta = app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/estorno",
        data={"motivo": "quantidade errada"},
        follow_redirects=False,
    )
    assert "já teve 3 devolvido" in _recado(resposta)
    assert _saldo(entrada.id) == 10


def test_devolucao_de_entrega_estornada_e_recusada(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 3)
    entrega = _registros()[0]
    app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/estorno", data={"motivo": "servidor errado"}
    )

    resposta = app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/devolucao",
        data={"quantidade": "1", "motivo": "voltou"},
        follow_redirects=False,
    )
    assert "foi estornado" in _recado(resposta)
    assert _saldo(entrada.id) == 7


# =====================================================================
# 5. Ajuste de inventário
# =====================================================================
def test_o_ajuste_registra_a_contagem_o_motivo_e_quem_contou(
    app_cliente, contas, banco
):
    """É a única forma legítima de o saldo do sistema encontrar a prateleira, e
    por isso ela precisa deixar rastro de quem contou e quando."""
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]

    app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/ajuste",
        data={"contagem": "7", "motivo": "inventário de agosto"},
    )
    ajuste = _movimentos(entrada.id)[-1]
    assert ajuste.tipo == "AJUSTE"
    assert ajuste.quantidade == -3
    assert "contagem física 7" in ajuste.motivo
    assert "saldo do sistema 10" in ajuste.motivo
    assert "inventário de agosto" in ajuste.motivo
    assert ajuste.registrado_por is not None
    assert ajuste.ocorrido_em is not None

    with mod_banco.sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "EPI_ESTOQUE_AJUSTADO"
            )
        ).scalar_one()
        # números de verdade dos dois lados, para o digest fechar
        assert evento.valor_anterior == 10
        assert evento.valor_novo == 7
        assert evento.usuario_nome == "Coordenador de Teste"


def test_ajuste_sem_motivo_e_recusado(app_cliente, contas, banco):
    """Ajuste sem explicação é saldo que sumiu."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]

    resposta = app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/ajuste",
        data={"contagem": "7", "motivo": "  "},
        follow_redirects=False,
    )
    assert "é obrigatório" in _recado(resposta)
    assert _saldo(entrada.id) == 10


def test_ajuste_que_confere_com_o_saldo_nao_grava_nada(app_cliente, contas, banco):
    """Movimento de quantidade zero o banco recusa, e com razão: ele não diria
    nada — e o extrato ficaria cheio de linhas que não são fato nenhum."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]

    resposta = app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/ajuste",
        data={"contagem": "10", "motivo": "conferência de rotina"},
        follow_redirects=False,
    )
    assert "confere com o saldo do sistema" in _recado(resposta)
    assert len(_movimentos(entrada.id)) == 1


def test_ajuste_para_cima_tambem_e_movimento(app_cliente, contas, banco):
    """A contagem pode achar mais do que o sistema sabia — devolução que não foi
    registrada, por exemplo. O ajuste sobe do mesmo jeito, com motivo."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]

    app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/ajuste",
        data={"contagem": "13", "motivo": "caixa encontrada no armário 2"},
    )
    assert _saldo(entrada.id) == 13
    assert _movimentos(entrada.id)[-1].quantidade == 3


# =====================================================================
# 6. Descarte
# =====================================================================
def test_descartar_mais_do_que_ha_e_recusado(app_cliente, contas, banco):
    """RN-24: saldo não fica negativo. Se a prateleira discorda do sistema, o
    caminho é o ajuste."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]

    resposta = app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/descarte",
        data={"quantidade": "11", "motivo": "tudo vencido"},
        follow_redirects=False,
    )
    assert "saldo não fica negativo" in _recado(resposta)
    assert _saldo(entrada.id) == 10


def test_descarte_sem_motivo_e_recusado(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]
    resposta = app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/descarte",
        data={"quantidade": "1", "motivo": ""},
        follow_redirects=False,
    )
    assert "é obrigatório" in _recado(resposta)
    assert _saldo(entrada.id) == 10


def test_descartar_o_lote_vencido_e_como_ele_sai_do_estoque(
    app_cliente, contas, banco
):
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, validade_ca=ONTEM.isoformat())
    entrada = _entradas()[0]

    app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/descarte",
        data={"quantidade": "10", "motivo": "CA vencido, sem renovação pelo fabricante"},
    )
    assert _saldo(entrada.id) == 0
    with mod_banco.sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "EPI_ESTOQUE_DESCARTADO"
            )
        ).scalar_one()
        assert evento.valor_anterior == 10
        assert evento.valor_novo == 0
    # a linha do lote continua no estoque, com saldo zero e o descarte no extrato
    assert f"/epis/estoque/{entrada.id}/movimentos" in app_cliente.get(ESTOQUE).text


# =====================================================================
# 7. O que não se edita
# =====================================================================
def test_a_quantidade_nao_muda_pela_edicao_do_lote(app_cliente, contas, banco):
    """Nota fiscal e observação editam em linha; quantidade não.

    Quantidade muda por movimento, porque é o movimento que diz quando mudou e
    por quê. Um campo de saldo editável seria o `Qtd_Estoque` do legado de volta.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]

    app_cliente.post(
        f"{ESTOQUE}/{entrada.id}",
        data={
            "nota_fiscal": "4472",
            "fornecedor_contato": "(38) 3532-1200",
            "observacao": "caixa com etiqueta rasurada",
            "ativo": "1",
            "motivo_inativacao": "",
            # o formulário da tela nem tem estes campos; se um dia tiver, este
            # teste é o que percebe
            "quantidade_recebida": "999",
            "quantidade_empenhada": "999",
        },
        follow_redirects=False,
    )
    depois = _entradas()[0]
    assert depois.nota_fiscal == "4472"
    assert depois.fornecedor_contato == "(38) 3532-1200"
    assert depois.quantidade_recebida == 10
    assert depois.quantidade_empenhada == 12
    assert _saldo(entrada.id) == 10


def test_inativar_lote_exige_motivo(app_cliente, contas, banco):
    """RN-31: lote não se exclui, inativa com motivo."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]

    resposta = app_cliente.post(
        f"{ESTOQUE}/{entrada.id}",
        data={
            "nota_fiscal": "4471",
            "fornecedor_contato": "",
            "observacao": "",
            "ativo": "",
            "motivo_inativacao": "",
        },
        follow_redirects=False,
    )
    assert "exige o motivo" in _recado(resposta)
    assert _entradas()[0].ativo


def test_lote_inativado_sai_da_entrega_e_fica_no_estoque(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)
    entrada = _entradas()[0]
    app_cliente.post(
        f"{ESTOQUE}/{entrada.id}",
        data={
            "nota_fiscal": "",
            "fornecedor_contato": "",
            "observacao": "",
            "ativo": "",
            "motivo_inativacao": "recolhido pelo fabricante por defeito de lote",
        },
    )
    assert not _entradas()[0].ativo

    resposta = _entregar(app_cliente, cenario, entrada.id, 1)
    assert "lote inativado" in _recado(resposta)
    # o saldo continua existindo, e a tela continua mostrando
    assert _saldo(entrada.id) == 10
    assert f"/epis/estoque/{entrada.id}/movimentos" in app_cliente.get(ESTOQUE).text


def test_o_lote_nao_guarda_saldo_materializado():
    """A prova de que a lição do legado ficou no esquema, e não só no comentário.

    `Qtd_Estoque` era coluna mutável na linha da entrada. Se um dia alguém
    acrescentar uma coluna de saldo "por desempenho", este teste é o que
    pergunta por quê antes de ela existir.
    """
    colunas = {c.name for c in EpiEntradaEstoque.__table__.columns}
    suspeitas = {c for c in colunas if "saldo" in c or "estoque" in c.split("_")}
    assert suspeitas == set(), suspeitas
    # as duas quantidades que existem são fatos da compra, não saldo corrente
    assert {"quantidade_recebida", "quantidade_empenhada"} <= colunas


# =====================================================================
# 8. A pendência do CA a vencer (RN-25)
# =====================================================================
def test_lote_a_vencer_abre_pendencia_com_prazo_na_validade(
    app_cliente, contas, banco
):
    from app import banco as mod_banco
    from app.servicos import datas_br, epi_estoque

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, validade_ca=DAQUI_A_UM_MES.isoformat())
    entrada = _entradas()[0]

    with mod_banco.sessao() as s:
        pendencia = s.execute(
            select(Pendencia).where(Pendencia.tipo == "CA_A_VENCER")
        ).scalar_one()
        assert pendencia.chave == epi_estoque.chave_da_pendencia_de_ca(entrada.id)
        assert pendencia.prazo == DAQUI_A_UM_MES
        assert pendencia.entidade == "epi_entrada_estoque"
        assert "ainda tem saldo em estoque" in pendencia.descricao
        # o saldo do momento NÃO entra no texto: `abrir` é idempotente por chave
        # e não o reescreveria, e o número envelheceria na fila.
        #
        # A DATA sai do texto antes da procura, e isso não afrouxa nada: a
        # validade é escrita formatada (`03/10/2026`) e carrega dígitos que não
        # têm relação nenhuma com o saldo. Sem tirá-la, a asserção acusava
        # defeito inexistente em todo mês 10, todo dia 10 e todo ano com "10" —
        # e foi o que aconteceu em 03/09/2026, com a validade caindo em
        # 03/10/2026. O que o teste quer dizer continua dito: a quantidade
        # recebida não aparece na descrição.
        sem_a_data = pendencia.descricao.replace(
            datas_br.numerica(DAQUI_A_UM_MES), ""
        )
        assert "10" not in sem_a_data


def test_lote_com_validade_distante_nao_abre_pendencia(app_cliente, contas, banco):
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, validade_ca=DAQUI_A_UM_ANO.isoformat())
    with mod_banco.sessao() as s:
        assert (
            s.execute(
                select(Pendencia).where(Pendencia.tipo == "CA_A_VENCER")
            ).scalar_one_or_none()
            is None
        )


def test_descartar_o_saldo_fecha_a_pendencia_do_ca(app_cliente, contas, banco):
    """Sem saldo não há o que renovar nem o que descartar: a tarefa perdeu o
    objeto, e tarefa sem objeto na fila é ruído que faz a fila ser ignorada."""
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, validade_ca=DAQUI_A_UM_MES.isoformat())
    entrada = _entradas()[0]

    app_cliente.post(
        f"{ESTOQUE}/{entrada.id}/descarte",
        data={"quantidade": "10", "motivo": "CA a vencer sem previsão de renovação"},
    )
    with mod_banco.sessao() as s:
        pendencia = s.execute(
            select(Pendencia).where(Pendencia.tipo == "CA_A_VENCER")
        ).scalar_one()
        assert pendencia.concluida


# =====================================================================
# 9. A tela
# =====================================================================
def test_a_tela_mostra_fisico_reservado_e_disponivel(app_cliente, contas, banco):
    """Os três lado a lado: quem conta a prateleira encontra o FÍSICO, e achar o
    número certo atrás de uma subtração é como a divergência passa despercebida."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 4)

    corpo = app_cliente.get(ESTOQUE).text
    assert "Físico" in corpo
    assert "Reservado" in corpo
    assert "Disponível" in corpo
    assert "2026NE000123" in corpo
    assert "Distribuidora de EPI Ltda" in corpo
    assert "pode sair" in corpo


def test_a_busca_encontra_o_lote_pelo_empenho(app_cliente, contas, banco):
    """É por ele que a pergunta chega: "esse capacete veio de qual empenho?"."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario)

    entrada = _entradas()[0]
    achou = app_cliente.get(f"{ESTOQUE}?q=2026NE000123").text
    assert f"/epis/estoque/{entrada.id}/movimentos" in achou

    vazia = app_cliente.get(f"{ESTOQUE}?q=2027NE999999").text
    # o link do extrato, e não o número do lote: "L-2026-08" também é o exemplo
    # do campo "Lote" no formulário de entrada, que aparece na página inteira
    assert f"/epis/estoque/{entrada.id}/movimentos" not in vazia
    assert "Nenhum lote em estoque" in vazia


def test_o_extrato_liga_a_saida_a_linha_da_ficha(app_cliente, contas, banco):
    """É o que amarra o saldo à prova: a baixa aponta para a entrega que a
    causou, e a entrega aponta para o evento da cadeia de hash."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 2)
    registro = _registros()[0]

    corpo = app_cliente.get(f"{ESTOQUE}/{entrada.id}/movimentos").text
    assert f'href="/epis/fichas/registros/{registro.id}"' in corpo
    assert "Coordenador de Teste" in corpo


def test_o_razao_recusa_alteracao_mesmo_por_sql(sessao, atores):
    """A trava é do banco, não da tela: correção é linha nova de tipo AJUSTE."""
    from app.servicos import epi_estoque

    categoria = sessao.execute(select(EpiCategoria)).scalars().first()
    item = EpiItem(
        nome="Capacete de teste", categoria_id=categoria.id, exige_ca=False,
        quantidade_padrao=1,
    )
    sessao.add(item)
    sessao.flush()
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id, data_entrada=HOJE, quantidade_recebida=5
    )
    sessao.add(entrada)
    sessao.flush()
    movimento = EpiMovimentoEstoque(
        entrada_id=entrada.id, tipo="ENTRADA", quantidade=5
    )
    sessao.add(movimento)
    sessao.commit()

    with pytest.raises(Exception, match="append-only"):
        sessao.execute(
            sa.text("UPDATE epi_movimento_estoque SET quantidade=99 WHERE id=:i"),
            {"i": movimento.id},
        )
    sessao.rollback()
    with pytest.raises(Exception, match="append-only"):
        sessao.execute(
            sa.text("DELETE FROM epi_movimento_estoque WHERE id=:i"), {"i": movimento.id}
        )
    sessao.rollback()
    assert epi_estoque.saldo_fisico(sessao, entrada.id) == 5


# =====================================================================
# 10. Permissões e o perfil novo
# =====================================================================
@pytest.mark.parametrize(
    "perfil,ver,escrever",
    [
        ("coordenador_csso", 200, 303),
        ("tecnico_seguranca", 200, 303),
        ("almoxarife_sesmt", 200, 303),
        # veem o estoque e não escrevem: o saldo é insumo do parecer e da
        # análise, e mexer no razão é ato de quem conta a prateleira
        ("engenheiro_seguranca", 200, 403),
        ("medico_trabalho", 200, 403),
        ("secretaria_csso", 200, 403),
        ("consulta_progep", 200, 403),
        ("auditor_interno", 200, 403),
        ("servidor_consulta", 200, 403),
        # admin_ti continua sem conteúdo técnico
        ("admin_ti", 403, 403),
    ],
)
def test_permissao_do_estoque(app_cliente, contas, banco, perfil, ver, escrever):
    cenario = _cenario()
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(ESTOQUE).status_code == ver
    assert _lote(app_cliente, cenario).status_code == escrever


def test_o_almoxarife_opera_o_estoque_e_nao_toca_no_resto(app_cliente, contas, banco):
    """O perfil novo, no que ele é: opera estoque e entrega, não decide o direito
    ao item, não lê parecer, não vê exposição."""
    cenario = _cenario()
    entrar(app_cliente, contas, "almoxarife_sesmt")

    assert _lote(app_cliente, cenario).status_code == 303
    entrada = _entradas()[0]
    assert app_cliente.get(f"{ESTOQUE}/{entrada.id}/movimentos").status_code == 200
    assert _entregar(app_cliente, cenario, entrada.id, 2).status_code == 303
    assert _saldo(entrada.id) == 8

    # o que ele NÃO faz
    assert app_cliente.get("/processos").status_code == 403
    assert app_cliente.get("/laudos").status_code == 403
    assert app_cliente.get("/auditoria").status_code == 403
    # vê o catálogo de EPI e não o edita
    assert app_cliente.get("/epis/catalogo").status_code == 200
    assert "somente leitura" in app_cliente.get("/epis/catalogo").text


def test_o_almoxarife_fecha_a_propria_pendencia_de_comprovante(
    app_cliente, contas, banco
):
    """A entrega que ele registra abre a pendência do comprovante com o nome
    dele. Sem poder abrir a ficha, ele receberia a tarefa e um 403 no link —
    que é o modo de falha que a lista de `PERMISSOES_VER` existe para impedir."""
    cenario = _cenario()
    entrar(app_cliente, contas, "almoxarife_sesmt")
    _lote(app_cliente, cenario, quantidade_recebida="10", quantidade_empenhada="10")
    entrada = _entradas()[0]
    _entregar(app_cliente, cenario, entrada.id, 2)
    registro = _registros()[0]

    assert app_cliente.get("/pendencias").status_code == 200
    salto = app_cliente.get(f"{FICHAS}/registros/{registro.id}", follow_redirects=False)
    assert salto.status_code == 303
    assert app_cliente.get(f"{FICHAS}/{cenario['servidor']}").status_code == 200
    anexo = app_cliente.post(
        f"{FICHAS}/registros/{registro.id}/comprovante",
        files={"arquivo": ("assinado.pdf", b"%PDF-1.4 x", "application/pdf")},
        follow_redirects=False,
    )
    assert anexo.status_code == 303
    assert "SHA-256" in _recado(anexo)


# =====================================================================
# O CNPJ que truncava em silencio
# =====================================================================
def test_o_cnpj_da_nota_entra_pontuado_e_e_gravado_so_em_digito(
    app_cliente, contas, banco
):
    """O campo e transcrito de uma NOTA FISCAL IMPRESSA, onde o CNPJ tem 18
    caracteres. O `maxlength="14"` cortava no decimo quarto sem mensagem, sem
    borda vermelha e sem som: gravava-se `12.345.678/000`. Agora o servico
    normaliza, como o NUP ja fazia, e a coluna recebe os 14 digitos."""
    cenario = _cenario()
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert _lote(
        app_cliente, cenario, fornecedor_cnpj="12.345.678/0001-90"
    ).status_code == 303
    assert _entradas()[-1].fornecedor_cnpj == "12345678000190"


def test_cnpj_com_contagem_errada_e_recusado_por_escrito_e_nada_grava(
    app_cliente, contas, banco
):
    """Contagem errada e recusa escrita, nao corte silencioso: 11 digitos e CPF
    no campo do fornecedor ou transcricao pela metade, e as duas coisas
    precisam voltar para quem esta com o papel na mao."""
    cenario = _cenario()
    entrar(app_cliente, contas, "almoxarife_sesmt")
    resposta = _lote(app_cliente, cenario, fornecedor_cnpj="12345678901")
    assert resposta.status_code == 200
    corpo = resposta.text
    assert "11 dígito(s)" in corpo
    assert "o CNPJ tem 14" in corpo
    # e o que foi digitado continua na tela: dezenove campos nao se redigitam
    assert "12345678901" in corpo
    assert 'name="empenho"' in corpo and "2026NE000123" in corpo
    assert not _entradas()


def test_o_campo_de_cnpj_nao_tem_mais_maxlength(app_cliente, contas, banco):
    """`maxlength` e o pior tipo de validacao: a que nao avisa."""
    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = app_cliente.get("/epis/estoque/nova-entrada").text
    campo = corpo[corpo.index('id="fornecedor_cnpj"') : corpo.index('id="fornecedor_cnpj"') + 300]
    assert "maxlength" not in campo
    assert 'inputmode="numeric"' in campo
    assert "12.345.678/0001-90" in campo