"""Maquinas de estado: processo (A), direito (B), requisicao e item de EPI
(C e D), turma (E) e inscricao (F)."""

from __future__ import annotations

import pytest

from app.modelos.estados import (
    COLUNAS_KANBAN,
    EPI_ITEM_DECIDIDO,
    EPI_ITEM_PENDENTE_DE_ATENDIMENTO,
    EPI_REQUISICAO_CANCELAVEL,
    EPI_REQUISICAO_ENCERRADA,
    ESTADOS_EPI_ITEM,
    ESTADOS_EPI_REQUISICAO,
    ESTADOS_INSCRICAO,
    ESTADOS_PROCESSO,
    ESTADOS_TURMA,
    ESTADO_PARA_COLUNA,
    INSCRICAO_OCUPA_VAGA,
    ROTULO_EPI_ITEM,
    ROTULO_EPI_REQUISICAO,
    ROTULO_ESTADO,
    ROTULO_ESTADO_TELA,
    ROTULO_INSCRICAO,
    ROTULO_TURMA,
    TRANSICOES,
    TRANSICOES_DIREITO,
    TRANSICOES_EPI_ITEM,
    TRANSICOES_EPI_REQUISICAO,
    TRANSICOES_INSCRICAO,
    TRANSICOES_TURMA,
    TURMA_ACEITA_INSCRICAO,
    TransicaoInvalida,
    coluna_de,
    destinos_de_turma,
    exigir,
    exigir_transicao,
    exigir_transicao_epi_item,
    exigir_transicao_epi_requisicao,
    exigir_transicao_inscricao,
    exigir_transicao_turma,
    pode,
    pode_transitar,
)

CAMINHO_FELIZ = [
    ("RECEBIDO", "EM_TRIAGEM"),
    ("EM_TRIAGEM", "AGUARDANDO_INSPECAO"),
    ("AGUARDANDO_INSPECAO", "INSPECIONADO"),
    ("INSPECIONADO", "LAUDO_EM_ELABORACAO"),
    ("LAUDO_EM_ELABORACAO", "LAUDO_EMITIDO"),
    ("LAUDO_EMITIDO", "PARECER_EM_ELABORACAO"),
    ("PARECER_EM_ELABORACAO", "PARECER_PRONTO_P_ASSINATURA"),
    ("PARECER_PRONTO_P_ASSINATURA", "PARECER_ASSINADO"),
    ("PARECER_ASSINADO", "INSERIDO_NO_SEI"),
    ("INSERIDO_NO_SEI", "DEVOLVIDO_A_PROGEP"),
    ("DEVOLVIDO_A_PROGEP", "CONCLUIDO"),
]

PROIBIDAS = [
    ("RECEBIDO", "CONCLUIDO"),
    ("EM_TRIAGEM", "PARECER_ASSINADO"),
    ("AGUARDANDO_INSPECAO", "LAUDO_EMITIDO"),
    ("CONCLUIDO", "EM_TRIAGEM"),
    ("ARQUIVADO", "EM_TRIAGEM"),
]


def test_sao_dezenove_estados():
    """18 estados de fluxo + NAO_INICIADO (só cartões migrados)."""
    assert len(ESTADOS_PROCESSO) == 19
    assert "NAO_INICIADO" in ESTADOS_PROCESSO


@pytest.mark.parametrize("origem,destino", CAMINHO_FELIZ)
def test_caminho_feliz(origem, destino):
    assert pode_transitar(origem, destino)


@pytest.mark.parametrize("origem,destino", PROIBIDAS)
def test_transicoes_proibidas(origem, destino):
    assert not pode_transitar(origem, destino)
    with pytest.raises(TransicaoInvalida):
        exigir_transicao(origem, destino)


def test_atalho_de_reuso_de_laudo():
    """EM_TRIAGEM -> PARECER_EM_ELABORACAO é legítimo (art. 10, §3º)."""
    assert pode_transitar("EM_TRIAGEM", "PARECER_EM_ELABORACAO")


def test_sobrestamento_e_retorno():
    assert pode_transitar("AGUARDANDO_INSPECAO", "SOBRESTADO")
    assert pode_transitar("SOBRESTADO", "AGUARDANDO_INSPECAO")
    assert not pode_transitar("ARQUIVADO", "SOBRESTADO")


def test_recurso_reabre_o_processo():
    assert pode_transitar("CONCLUIDO", "EM_RECURSO")
    assert pode_transitar("INDEFERIDO_TECNICAMENTE", "EM_RECURSO")
    assert pode_transitar("EM_RECURSO", "EM_TRIAGEM")


def test_todo_estado_tem_coluna():
    for estado in ESTADOS_PROCESSO:
        assert estado in ESTADO_PARA_COLUNA, estado
        assert coluna_de(estado) in {c for c, _ in COLUNAS_KANBAN}


def test_mapa_de_colunas_sem_ambiguidade():
    esperado = {
        "A_FAZER": {"RECEBIDO", "EM_TRIAGEM"},
        "AGUARDANDO": {
            "PENDENTE_DOCUMENTO",
            "SOBRESTADO",
            "AGUARDANDO_QUANTIFICACAO",
            "PARECER_PRONTO_P_ASSINATURA",
            "DEVOLVIDO_A_PROGEP",
        },
        "EM_ANDAMENTO": {
            "AGUARDANDO_INSPECAO",
            "INSPECIONADO",
            "LAUDO_EM_ELABORACAO",
            "LAUDO_EMITIDO",
            "PARECER_EM_ELABORACAO",
            "PARECER_ASSINADO",
            "INSERIDO_NO_SEI",
            "EM_RECURSO",
        },
        "CONCLUIDO": {"CONCLUIDO", "INDEFERIDO_TECNICAMENTE", "ARQUIVADO"},
        "NAO_INICIADO": {"NAO_INICIADO"},
    }
    real: dict[str, set[str]] = {}
    for estado, coluna in ESTADO_PARA_COLUNA.items():
        real.setdefault(coluna, set()).add(estado)
    assert real == esperado


def test_maquina_do_direito():
    assert "VIGENTE" in TRANSICOES_DIREITO["PROPOSTO"]
    assert "EM_REAVALIACAO" in TRANSICOES_DIREITO["VIGENTE"]
    assert TRANSICOES_DIREITO["CESSADO"] == frozenset()


def test_nenhuma_transicao_para_estado_inexistente():
    for origem, destinos in TRANSICOES.items():
        assert origem in ESTADOS_PROCESSO
        for destino in destinos:
            assert destino in ESTADOS_PROCESSO, f"{origem} -> {destino}"


# ---------------------------------------------------------------------
# O conferidor generico, usado pelas quatro maquinas
# ---------------------------------------------------------------------
def test_origem_desconhecida_nao_e_porta_aberta():
    """Estado que a maquina nao declara nao autoriza nada.

    E o modo de falha que importa: um valor gravado a mao no banco, ou um
    estado novo esquecido na tabela, nao pode virar "vale tudo".
    """
    assert not pode({"A": frozenset({"B"})}, "INEXISTENTE", "B")
    with pytest.raises(TransicaoInvalida):
        exigir({"A": frozenset({"B"})}, "INEXISTENTE", "B")


def test_a_mensagem_da_recusa_usa_o_rotulo_da_tela():
    with pytest.raises(TransicaoInvalida) as erro:
        exigir({"A": frozenset()}, "A", "B", {"A": "Primeiro", "B": "Segundo"})
    assert "Transição proibida: Primeiro → Segundo." in str(erro.value)
    # situacao final: a frase diz que nao ha saida, em vez de listar nada
    assert "é situação final" in str(erro.value)


def test_a_recusa_diz_para_onde_da_para_ir():
    """Era "Transicao proibida: X -> Y." e mais nada — o erro mais frequente do
    kanban (pular a triagem) devolvia o cartão sem dizer qual coluna aceitava.
    As saídas vêm da mesma tabela que recusou, então nunca divergem dela."""
    with pytest.raises(TransicaoInvalida) as erro:
        exigir(
            {"A": frozenset({"B", "C"})}, "A", "D",
            {"A": "Primeiro", "B": "Segundo", "C": "Terceiro", "D": "Quarto"},
        )
    assert "De “Primeiro” dá para ir a: Segundo, Terceiro." in str(erro.value)


def test_a_recusa_do_processo_inclui_o_sobrestamento_e_o_rotulo_acentuado():
    from app.modelos.estados import exigir_transicao

    with pytest.raises(TransicaoInvalida) as erro:
        exigir_transicao("RECEBIDO", "AGUARDANDO_INSPECAO")
    texto = str(erro.value)
    assert "Recebido → Aguardando inspeção" in texto
    assert "Em triagem" in texto and "Sobrestado" in texto
    with pytest.raises(TransicaoInvalida) as erro:
        exigir_transicao("ARQUIVADO", "EM_TRIAGEM")
    assert "situação final" in str(erro.value)


# ---------------------------------------------------------------------
# C) Maquina da REQUISICAO DE EPI
# ---------------------------------------------------------------------
CAMINHO_DA_REQUISICAO = [
    ("RASCUNHO", "ENVIADA"),
    ("ENVIADA", "EM_ANALISE"),
    ("EM_ANALISE", "ANALISADA"),
    ("ANALISADA", "EM_ATENDIMENTO"),
    ("EM_ATENDIMENTO", "ATENDIDA"),
]

REQUISICAO_PROIBIDAS = [
    # pular a analise: o pedido sairia atendido sem ninguem ter decidido nada
    ("RASCUNHO", "EM_ANALISE"),
    ("RASCUNHO", "ANALISADA"),
    ("ENVIADA", "ANALISADA"),
    ("ENVIADA", "ATENDIDA"),
    ("EM_ANALISE", "EM_ATENDIMENTO"),
    ("ANALISADA", "ATENDIDA"),
    # terminal e terminal: atendida e cancelada nao voltam por caminho nenhum
    ("ATENDIDA", "EM_ATENDIMENTO"),
    ("ATENDIDA", "EM_ANALISE"),
    ("CANCELADA", "RASCUNHO"),
    ("CANCELADA", "ENVIADA"),
    # indeferida so volta por reconsideracao, e so para a analise
    ("INDEFERIDA", "ANALISADA"),
    ("INDEFERIDA", "ENVIADA"),
]


@pytest.mark.parametrize("origem,destino", CAMINHO_DA_REQUISICAO)
def test_caminho_feliz_da_requisicao_de_epi(origem, destino):
    exigir_transicao_epi_requisicao(origem, destino)


@pytest.mark.parametrize("origem,destino", REQUISICAO_PROIBIDAS)
def test_transicoes_de_requisicao_proibidas(origem, destino):
    with pytest.raises(TransicaoInvalida):
        exigir_transicao_epi_requisicao(origem, destino)


def test_a_reconsideracao_e_o_unico_caminho_de_volta_de_um_terminal():
    """Sem ela, indeferimento errado so se conserta abrindo pedido novo — e o
    pedido novo apaga a historia de que houve um erro."""
    exigir_transicao_epi_requisicao("INDEFERIDA", "EM_ANALISE")


def test_cancelar_vale_ate_o_atendimento_comecar_e_nao_depois():
    for origem in EPI_REQUISICAO_CANCELAVEL:
        exigir_transicao_epi_requisicao(origem, "CANCELADA")
    for origem in ("ATENDIDA", "INDEFERIDA"):
        with pytest.raises(TransicaoInvalida):
            exigir_transicao_epi_requisicao(origem, "CANCELADA")


def test_devolver_para_a_fila_e_a_saida_de_em_analise_sem_decidir():
    """Decidir sem base e pior do que devolver."""
    exigir_transicao_epi_requisicao("EM_ANALISE", "ENVIADA")


def test_os_tres_terminais_da_requisicao():
    terminais = {e for e in ESTADOS_EPI_REQUISICAO if not TRANSICOES_EPI_REQUISICAO[e]}
    assert terminais == {"ATENDIDA", "CANCELADA"}
    # INDEFERIDA e terminal "salvo a reconsideracao": o unico destino dela e a
    # volta para a analise, e e por isso que ela nao entra no conjunto acima
    assert TRANSICOES_EPI_REQUISICAO["INDEFERIDA"] == frozenset({"EM_ANALISE"})
    assert EPI_REQUISICAO_ENCERRADA == {"ATENDIDA", "INDEFERIDA", "CANCELADA"}


# ---------------------------------------------------------------------
# D) Maquina do ITEM DE REQUISICAO DE EPI
# ---------------------------------------------------------------------
CAMINHO_DO_ITEM = [
    ("SOLICITADO", "APROVADO"),
    # fatia 4, sem reserva (SS10): aprovar e entregar direto
    ("APROVADO", "ENTREGUE"),
    # e o caminho com reserva, que a maquina ja declara para a fatia seguinte
    ("APROVADO", "RESERVADO"),
    ("RESERVADO", "ENTREGUE"),
    ("APROVADO", "SEM_ESTOQUE"),
    ("SEM_ESTOQUE", "RESERVADO"),
    ("RESERVADO", "SEM_ESTOQUE"),
]

ITEM_PROIBIDAS = [
    # entregar o que ninguem decidiu
    ("SOLICITADO", "ENTREGUE"),
    ("SOLICITADO", "RESERVADO"),
    ("SOLICITADO", "SEM_ESTOQUE"),
    # sem estoque nao vira entrega sem passar pela reserva
    ("SEM_ESTOQUE", "ENTREGUE"),
    ("SEM_ESTOQUE", "APROVADO"),
    # os tres terminais. Devolucao, substituicao e descarte NAO mexem no estado
    # do item: sao fatos posteriores e viram linha nova na ficha.
    ("ENTREGUE", "SEM_ESTOQUE"),
    ("ENTREGUE", "CANCELADO"),
    ("ENTREGUE", "APROVADO"),
    ("RECUSADO", "APROVADO"),
    ("RECUSADO", "CANCELADO"),
    ("CANCELADO", "APROVADO"),
    # recusar depois de aprovar seria trocar a decisao em silencio: o caminho e
    # cancelar o item, que diz outra coisa e conta em outro lugar (RN-27)
    ("APROVADO", "RECUSADO"),
]


@pytest.mark.parametrize("origem,destino", CAMINHO_DO_ITEM)
def test_caminho_feliz_do_item_de_epi(origem, destino):
    exigir_transicao_epi_item(origem, destino)


@pytest.mark.parametrize("origem,destino", ITEM_PROIBIDAS)
def test_transicoes_de_item_de_epi_proibidas(origem, destino):
    with pytest.raises(TransicaoInvalida):
        exigir_transicao_epi_item(origem, destino)


def test_item_solicitado_pode_ser_cancelado_junto_com_o_pedido():
    """Fora da tabela do SS4.3 de proposito, e o argumento esta em `estados.py`:
    cancelar o envelope em ENVIADA deixaria os itens parados em SOLICITADO,
    dentro de um pedido terminal — estado que nao descreve fato nenhum."""
    exigir_transicao_epi_item("SOLICITADO", "CANCELADO")


def test_os_tres_terminais_do_item():
    terminais = {e for e in ESTADOS_EPI_ITEM if not TRANSICOES_EPI_ITEM[e]}
    assert terminais == {"ENTREGUE", "RECUSADO", "CANCELADO"}


def test_os_conjuntos_derivados_do_item_batem_com_a_maquina():
    """`ANALISADA` exige todo item decidido; `ATENDIDA`, nenhum devendo."""
    assert EPI_ITEM_DECIDIDO == set(ESTADOS_EPI_ITEM) - {"SOLICITADO"}
    assert EPI_ITEM_PENDENTE_DE_ATENDIMENTO == {
        "APROVADO",
        "RESERVADO",
        "SEM_ESTOQUE",
    }
    assert not EPI_ITEM_PENDENTE_DE_ATENDIMENTO & {"ENTREGUE", "RECUSADO", "CANCELADO"}


# ---------------------------------------------------------------------
# E) Maquina da TURMA
# ---------------------------------------------------------------------
CAMINHO_DA_TURMA = [
    ("PLANEJADA", "INSCRICOES_ABERTAS"),
    ("INSCRICOES_ABERTAS", "EM_ANDAMENTO"),
    ("EM_ANDAMENTO", "CONCLUIDA"),
]

TURMA_PROIBIDAS = [
    # "concluir" uma turma que nunca aconteceu
    ("PLANEJADA", "CONCLUIDA"),
    ("INSCRICOES_ABERTAS", "CONCLUIDA"),
    # reabrir turma fechada: o certificado ja emitido passaria a descrever uma
    # turma que mudou depois
    ("CONCLUIDA", "EM_ANDAMENTO"),
    ("CONCLUIDA", "CANCELADA"),
    ("CANCELADA", "PLANEJADA"),
    ("CANCELADA", "EM_ANDAMENTO"),
    # voltar do meio do curso para "aceitando inscricao" e para a agenda
    ("EM_ANDAMENTO", "PLANEJADA"),
    ("EM_ANDAMENTO", "INSCRICOES_ABERTAS"),
]


@pytest.mark.parametrize("origem,destino", CAMINHO_DA_TURMA)
def test_caminho_feliz_da_turma(origem, destino):
    exigir_transicao_turma(origem, destino)


@pytest.mark.parametrize("origem,destino", TURMA_PROIBIDAS)
def test_transicoes_de_turma_proibidas(origem, destino):
    with pytest.raises(TransicaoInvalida):
        exigir_transicao_turma(origem, destino)


def test_fechar_inscricao_sem_cancelar_a_turma():
    """Vagas esgotadas ou data adiada nao sao cancelamento: sem esta volta, o
    unico jeito de parar de receber inscrito seria cancelar a turma."""
    exigir_transicao_turma("INSCRICOES_ABERTAS", "PLANEJADA")


def test_cancelar_vale_de_qualquer_estado_nao_terminal():
    for origem in ("PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"):
        exigir_transicao_turma(origem, "CANCELADA")


def test_a_turma_tem_dois_estados_terminais():
    terminais = {e for e in ESTADOS_TURMA if not TRANSICOES_TURMA[e]}
    assert terminais == {"CONCLUIDA", "CANCELADA"}


def test_destinos_de_turma_saem_na_ordem_da_maquina():
    """O `frozenset` nao tem ordem; a tela precisa de uma estavel, senao os
    botoes trocam de lugar entre dois carregamentos da mesma pagina."""
    assert destinos_de_turma("PLANEJADA") == [
        "INSCRICOES_ABERTAS",
        "EM_ANDAMENTO",
        "CANCELADA",
    ]
    assert destinos_de_turma("CONCLUIDA") == []


def test_turma_encerrada_nao_aceita_inscricao():
    assert TURMA_ACEITA_INSCRICAO == {
        "PLANEJADA",
        "INSCRICOES_ABERTAS",
        "EM_ANDAMENTO",
    }
    assert not {"CONCLUIDA", "CANCELADA"} & TURMA_ACEITA_INSCRICAO


# ---------------------------------------------------------------------
# F) Maquina da INSCRICAO
# ---------------------------------------------------------------------
CAMINHO_DA_INSCRICAO = [
    ("AGUARDANDO_EMAIL", "INSCRITA"),
    ("INSCRITA", "CONFIRMADA"),
    ("CONFIRMADA", "PRESENTE"),
    ("PRESENTE", "APROVADO"),
]

INSCRICAO_PROIBIDAS = [
    # o que o plano consolidado apontou: aprovar quem nunca compareceu
    ("INSCRITA", "APROVADO"),
    ("INSCRITA", "PRESENTE"),
    ("CONFIRMADA", "APROVADO"),
    ("CONFIRMADA", "REPROVADO"),
    ("AGUARDANDO_EMAIL", "CONFIRMADA"),
    # resultado lancado nao volta para inscricao nem some: inscricao de turma
    # concluida SEMPRE tem resultado
    ("APROVADO", "CANCELADA"),
    ("APROVADO", "PRESENTE"),
    ("APROVADO", "AUSENTE"),
    ("REPROVADO", "CONFIRMADA"),
    ("CANCELADA", "INSCRITA"),
    # ausente nao vira aprovado por nenhum caminho direto
    ("AUSENTE", "APROVADO"),
]


@pytest.mark.parametrize("origem,destino", CAMINHO_DA_INSCRICAO)
def test_caminho_feliz_da_inscricao(origem, destino):
    exigir_transicao_inscricao(origem, destino)


@pytest.mark.parametrize("origem,destino", INSCRICAO_PROIBIDAS)
def test_transicoes_de_inscricao_proibidas(origem, destino):
    with pytest.raises(TransicaoInvalida):
        exigir_transicao_inscricao(origem, destino)


def test_lancamento_de_presenca_se_corrige():
    """Marcar presente por engano e um erro de digitacao, nao um estado final."""
    exigir_transicao_inscricao("PRESENTE", "AUSENTE")
    exigir_transicao_inscricao("AUSENTE", "PRESENTE")


def test_resultado_se_retifica_de_um_para_o_outro():
    """A turma fechou na sexta e na segunda aparece a folha de um dia esquecido.

    Sem estas duas arestas, corrigir a reprovacao de quem fez o curso inteiro
    exigiria SQL a mao. Com elas, a correcao continua sendo um ato registrado —
    quem a percorre e a retificacao de `presenca.py`, que pede motivo e recalcula
    a frequencia a partir dos lancamentos.
    """
    exigir_transicao_inscricao("REPROVADO", "APROVADO")
    exigir_transicao_inscricao("APROVADO", "REPROVADO")


def test_quem_nunca_foi_confirmado_termina_ausente():
    """SS7 do desenho: no fecho, inscricao sem presenca registrada vira AUSENTE.

    Sem esta aresta a turma fecharia deixando gente "inscrita" numa turma que ja
    acabou — estado que nao descreve nada e que o monitor de reciclagem nao sabe
    ler. Presente continua fora: quem compareceu passa por confirmada.
    """
    exigir_transicao_inscricao("INSCRITA", "AUSENTE")
    with pytest.raises(TransicaoInvalida):
        exigir_transicao_inscricao("INSCRITA", "PRESENTE")


def test_quem_aguarda_confirmacao_de_email_nao_ocupa_vaga():
    """Se ocupasse, qualquer um esgotaria as vagas inscrevendo e-mail alheio."""
    assert "AGUARDANDO_EMAIL" not in INSCRICAO_OCUPA_VAGA
    assert "CANCELADA" not in INSCRICAO_OCUPA_VAGA
    assert "INSCRITA" in INSCRICAO_OCUPA_VAGA


@pytest.mark.parametrize(
    "estados,transicoes,rotulos",
    [
        (ESTADOS_TURMA, TRANSICOES_TURMA, ROTULO_TURMA),
        (ESTADOS_INSCRICAO, TRANSICOES_INSCRICAO, ROTULO_INSCRICAO),
        (
            ESTADOS_EPI_REQUISICAO,
            TRANSICOES_EPI_REQUISICAO,
            ROTULO_EPI_REQUISICAO,
        ),
        (ESTADOS_EPI_ITEM, TRANSICOES_EPI_ITEM, ROTULO_EPI_ITEM),
    ],
    ids=["turma", "inscricao", "epi_requisicao", "epi_item"],
)
def test_a_maquina_e_completa_e_fechada(estados, transicoes, rotulos):
    """Todo estado tem linha, rotulo, e nao aponta para fora da maquina.

    Estado sem linha na tabela cai no `frozenset()` do `get` e vira terminal
    sem que ninguem tenha decidido isso; estado sem rotulo aparece na tela como
    o codigo cru.
    """
    assert set(transicoes) == set(estados)
    assert set(rotulos) == set(estados)
    for origem, destinos in transicoes.items():
        for destino in destinos:
            assert destino in estados, f"{origem} -> {destino}"


def test_os_dois_mapas_do_processo_andam_juntos():
    """A maquina A tem dois mapas de rotulo, e eles precisam ter as mesmas chaves.

    O ASCII e lido por mensagem de servico e pela descricao da trilha de
    auditoria — texto que entra no digest da cadeia, e por isso nao se reescreve.
    O de tela e o que a pilula, o quadro e o seletor de destino escrevem. Estado
    que entre num e nao no outro cai no recuo do `get` e volta a aparecer como
    codigo cru, que e o defeito que os dois mapas existem para consertar.
    """
    assert set(ROTULO_ESTADO) == set(ESTADOS_PROCESSO)
    assert set(ROTULO_ESTADO_TELA) == set(ESTADOS_PROCESSO)
    # e o de tela e mesmo o acentuado: sem isto os dois poderiam ser copia
    assert ROTULO_ESTADO_TELA["CONCLUIDO"] == "Concluído"
    assert ROTULO_ESTADO["CONCLUIDO"] == "Concluido"


def test_a_coluna_do_kanban_escreve_portugues():
    """O rotulo da coluna e so tela, entao e acentuado e em caixa de frase."""
    rotulos = dict(COLUNAS_KANBAN)
    assert rotulos["NAO_INICIADO"] == "Não iniciado"
    assert rotulos["CONCLUIDO"] == "Concluído"
