"""Fatia 4 de Gestão de EPI: a requisição — protocolo, decisão e prazo.

O que estes testes protegem, em ordem de gravidade:

1. **RN-28 — quem analisa não é quem requisita.** Bloqueio duro, sem exceção, e
   a mensagem tem de dizer as duas saídas legítimas: erro que só nega, sem
   apontar caminho, é o que faz a pessoa contornar o sistema por fora.
2. **O congelamento.** A lotação no envio é a que fica: transferir a pessoa
   depois não pode reescrever de onde veio o pedido (RN-15).
3. **RN-27 — a negativa que a pessoa recebeu é a que fica.** Editar o catálogo
   depois não reescreve o texto congelado.
4. **RN-03 no protocolo.** Consumido só no envio, sem buraco sob concorrência,
   e rascunho abandonado não gasta número.
5. **RN-26 conta a FICHA**, não requisições aprovadas — aprovação é promessa,
   entrega é fato.
6. **A máquina de estado é a guarda.** Toda transição não declarada é recusada,
   e `ATENDIDA` chega sozinha.
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
    EpiItem,
    EpiMotivoRecusa,
    EpiMovimentoEstoque,
    EpiRequisicao,
    EpiRequisicaoItem,
    HistoricoEvento,
    PostoTrabalho,
    Servidor,
    ServidorLotacao,
    UnidadeUorg,
    Usuario,
)
from app.modelos.estados import TransicaoInvalida
from app.servicos import epi_ficha, numeracao
from app.servicos import epi_requisicao as servico
from app.servicos.autenticacao import gerar_hash
from app.servicos.rbac import PermissaoNegada, UsuarioAtual
from app.servicos.textos import TextoProibido

HOJE = date.today()
DAQUI_A_UM_ANO = HOJE + timedelta(days=365)

REQUERENTE = frozenset({"epi.requisitar", "epi.ver"})
ANALISTA = frozenset({"epi.requisitar", "epi.analisar", "epi.ver", "epi.entregar"})


# =====================================================================
# Montagem
# =====================================================================
def _usuario(
    sessao, permissoes=ANALISTA, login="analista", servidor_id: int | None = None
) -> UsuarioAtual:
    """Um `UsuarioAtual` com linha real em `usuario`.

    A linha precisa existir porque `solicitado_por_id`, `decidido_por`,
    `autorizado_por` e a trilha de auditoria apontam para ela por FK.
    """
    registro = Usuario(
        login=login,
        nome=f"Operador {login}",
        email=f"{login}@teste.ufvjm.edu.br",
        senha_hash=gerar_hash("SenhaDeTeste2026"),
        precisa_trocar_senha=False,
        servidor_id=servidor_id,
    )
    sessao.add(registro)
    sessao.flush()
    return UsuarioAtual(
        id=registro.id,
        login=login,
        nome=registro.nome,
        permissoes=frozenset(permissoes),
        perfis=("coordenador_csso",),
        servidor_id=servidor_id,
    )


def _cenario(
    sessao,
    *,
    quantidade_maxima: int | None = None,
    periodo_maximo_meses: int | None = None,
    exige_justificativa: bool = False,
    recebido: int = 10,
) -> dict:
    """Um servidor com lotação datada, um item de catálogo e um lote com saldo."""
    categoria = sessao.execute(
        select(EpiCategoria).where(EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES")
    ).scalar_one()
    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    outra_unidade = (
        sessao.execute(
            select(UnidadeUorg).where(UnidadeUorg.id != unidade.id)
        ).scalars().first()
    )
    posto = sessao.execute(
        select(PostoTrabalho).where(PostoTrabalho.unidade_uorg_id == unidade.id)
    ).scalars().first()
    cargo = sessao.execute(select(Cargo)).scalars().first()

    servidor = Servidor(
        siape="7654321",
        nome="Joana Ribeiro de Almeida",
        cargo_id=cargo.id,
        funcao="Chefe de Laboratório",
        unidade_uorg_id=unidade.id,
    )
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
        vida_util_meses=6,
        quantidade_padrao=1,
        quantidade_maxima=quantidade_maxima,
        periodo_maximo_meses=periodo_maximo_meses,
        exige_justificativa=exige_justificativa,
    )
    sessao.add_all([servidor, item])
    sessao.flush()

    lotacao = ServidorLotacao(
        servidor_id=servidor.id,
        unidade_uorg_id=unidade.id,
        cargo_id=cargo.id,
        funcao="Chefe de Laboratório",
        vigencia_inicio=HOJE - timedelta(days=400),
    )
    sessao.add(lotacao)
    sessao.flush()
    if posto is not None:
        from app.modelos import LotacaoPosto

        sessao.add(
            LotacaoPosto(lotacao_id=lotacao.id, posto_trabalho_id=posto.id, ordem=1)
        )
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id,
        tamanho="M",
        empenho="2026NE000123",
        data_entrada=HOJE - timedelta(days=30),
        quantidade_recebida=recebido,
        lote="L-2026-08",
        numero_ca="41234",
        validade_ca=DAQUI_A_UM_ANO,
    )
    sessao.add(entrada)
    sessao.flush()
    sessao.add(
        EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=recebido)
    )
    sessao.flush()
    return {
        "servidor": servidor,
        "item": item,
        "entrada": entrada,
        "unidade": unidade,
        "outra_unidade": outra_unidade,
        "posto": posto,
        "lotacao": lotacao,
    }


def _motivo(sessao, codigo="SEM_EXPOSICAO") -> EpiMotivoRecusa:
    return sessao.execute(
        select(EpiMotivoRecusa).where(EpiMotivoRecusa.codigo == codigo)
    ).scalar_one()


def _pedido_pronto(sessao, cenario, usuario, *, quantidade=2, justificativa=""):
    """Rascunho com uma linha, pronto para enviar."""
    requisicao = servico.criar_rascunho(
        sessao,
        usuario,
        servidor=cenario["servidor"],
        descricao_atividade="Manipulação de reagentes no laboratório de análises",
    )
    servico.adicionar_item(
        sessao,
        usuario,
        requisicao,
        item=cenario["item"],
        quantidade=quantidade,
        tamanho="M",
        justificativa=justificativa,
    )
    return requisicao


def _eventos(sessao, entidade: str, entidade_id: int) -> list[HistoricoEvento]:
    return list(
        sessao.execute(
            select(HistoricoEvento)
            .where(
                HistoricoEvento.entidade == entidade,
                HistoricoEvento.entidade_id == entidade_id,
            )
            .order_by(HistoricoEvento.id)
        ).scalars()
    )


# =====================================================================
# 1. RN-03 — o protocolo
# =====================================================================
def test_rascunho_nao_consome_protocolo_e_o_envio_consome(sessao, banco):
    """Rascunho abandonado não pode abrir buraco na numeração.

    É a razão de o protocolo nascer no envio: um formulário aberto e fechado não
    é documento de ninguém, e número gasto por ele é a primeira pergunta que a
    auditoria faz.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)

    assert requisicao.protocolo is None
    assert requisicao.numero is None
    assert requisicao.ano is None

    servico.enviar(sessao, usuario, requisicao, quando=date(2026, 3, 4))
    assert requisicao.protocolo == "EPI-2026-0001"
    assert (requisicao.numero, requisicao.ano) == (1, 2026)
    assert requisicao.enviada_em is not None


def test_rascunho_excluido_nao_gasta_numero_e_o_seguinte_e_o_primeiro(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    descartado = _pedido_pronto(sessao, cenario, usuario)
    servico.excluir_rascunho(sessao, usuario, descartado)

    outro = _pedido_pronto(sessao, cenario, usuario)
    servico.enviar(sessao, usuario, outro, quando=date(2026, 3, 4))
    assert outro.protocolo == "EPI-2026-0001"


def test_cinquenta_protocolos_concorrentes_sem_buraco_nem_repeticao(banco):
    """RN-03 sob concorrência: `BEGIN IMMEDIATE`, nunca `MAX(numero)+1`.

    Cinquenta consumos em oito linhas de execução. Se a sequência fosse
    `MAX(numero)+1`, duas transações leriam o mesmo máximo e dois pedidos
    diferentes circulariam como "EPI-2026-0007".
    """
    from app import banco as mod_banco

    def consumir(_):
        with mod_banco.sessao() as s:
            return numeracao.proximo_numero_requisicao_epi(s, 2026)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        numeros = list(executor.map(consumir, range(50)))

    assert len(set(numeros)) == 50
    assert sorted(numeros) == list(range(1, 51))


def test_numeracao_da_requisicao_recusa_alvo_errado(sessao, banco):
    """A lista fechada de `SEQUENCIAS` é o que impede injeção pelo nome da tabela."""
    with pytest.raises(numeracao.SequenciaDesconhecida):
        numeracao.proximo_numero(
            sessao,
            2026,
            tabela_sequencia="epi_requisicao_sequencia",
            tabela_alvo="parecer_tecnico",
        )


# =====================================================================
# 2. O snapshot congelado no envio
# =====================================================================
def test_snapshot_de_lotacao_nao_muda_quando_o_servidor_troca_de_setor(sessao, banco):
    """RN-15 aplicada ao pedido: a pessoa muda de setor, o pedido não.

    Um pedido fundamentado no risco do laboratório não pode, depois da
    transferência, passar a dizer que veio de outra unidade — a decisão ficaria
    descrevendo outro lugar.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    servico.enviar(sessao, usuario, requisicao)

    congelados = (
        requisicao.unidade_uorg_id,
        requisicao.posto_trabalho_id,
        requisicao.cargo_snapshot,
        requisicao.funcao_snapshot,
    )
    assert congelados[0] == cenario["unidade"].id
    assert congelados[2]

    # a pessoa é transferida DEPOIS do envio, e o cadastro atual muda junto
    cenario["lotacao"].vigencia_fim = HOJE
    servidor = cenario["servidor"]
    servidor.unidade_uorg_id = cenario["outra_unidade"].id
    servidor.funcao = "Assessora"
    sessao.add(
        ServidorLotacao(
            servidor_id=servidor.id,
            unidade_uorg_id=cenario["outra_unidade"].id,
            funcao="Assessora",
            vigencia_inicio=HOJE + timedelta(days=1),
        )
    )
    sessao.flush()
    sessao.refresh(requisicao)

    assert (
        requisicao.unidade_uorg_id,
        requisicao.posto_trabalho_id,
        requisicao.cargo_snapshot,
        requisicao.funcao_snapshot,
    ) == congelados


# =====================================================================
# 3. RN-29 — justificativa onde o catálogo exige
# =====================================================================
def test_rn29_item_que_exige_justificativa_nao_e_enviado_sem_ela(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao, exige_justificativa=True)
    requisicao = _pedido_pronto(sessao, cenario, usuario)

    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.enviar(sessao, usuario, requisicao)
    assert "exige justificativa" in str(erro.value)
    # e o pedido continua rascunho, sem número gasto
    assert requisicao.estado == "RASCUNHO"
    assert requisicao.protocolo is None

    servico.editar_item(
        sessao,
        usuario,
        requisicao.itens[0],
        quantidade=2,
        tamanho="M",
        justificativa="Manipulação diária de solvente orgânico no LEAC",
    )
    servico.enviar(sessao, usuario, requisicao)
    assert requisicao.estado == "ENVIADA"


def test_pedido_sem_item_nao_sai_do_rascunho(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = servico.criar_rascunho(
        sessao, usuario, servidor=cenario["servidor"]
    )
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.enviar(sessao, usuario, requisicao)
    assert "nenhum item" in str(erro.value)


# =====================================================================
# 4. RN-30 — texto livre passa pelo filtro da RN-21
# =====================================================================
def test_rn30_rotina_de_trabalho_com_termo_de_saude_e_recusada(sessao, banco):
    """O campo do legado em que alguém escreve "estou grávida e não posso pegar peso".

    Sem o filtro, o sistema passaria a tratar dado de saúde sem base legal — e o
    faria justamente no campo que a tela pede que seja detalhado.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    with pytest.raises(TextoProibido):
        servico.criar_rascunho(
            sessao,
            usuario,
            servidor=cenario["servidor"],
            descricao_atividade="Estou grávida e não posso pegar peso no setor",
        )


def test_rn30_justificativa_do_item_e_motivo_de_cancelamento_tambem_passam(
    sessao, banco
):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = servico.criar_rascunho(
        sessao, usuario, servidor=cenario["servidor"]
    )
    with pytest.raises(TextoProibido):
        servico.adicionar_item(
            sessao,
            usuario,
            requisicao,
            item=cenario["item"],
            quantidade=1,
            tamanho="M",
            justificativa="Tem diagnóstico de dermatite pelo médico do trabalho",
        )
    servico.adicionar_item(
        sessao, usuario, requisicao, item=cenario["item"], quantidade=1, tamanho="M"
    )
    servico.enviar(sessao, usuario, requisicao)
    with pytest.raises(TextoProibido):
        servico.cancelar(
            sessao, usuario, requisicao, "Servidora afastada por atestado médico"
        )


# =====================================================================
# 5. RN-28 — quem analisa não é quem requisita
# =====================================================================
def test_rn28_analisar_o_proprio_pedido_e_recusado(sessao, banco):
    """Bloqueio duro. Não há autoanálise registrada, e o motivo está no docstring
    de `AutoanaliseProibida`: gravar "analisado por X" num pedido de X produziria
    no banco a aparência de um controle que não houve."""
    cenario = _cenario(sessao)
    dono = _usuario(
        sessao, login="tecnico", servidor_id=cenario["servidor"].id
    )
    requisicao = _pedido_pronto(sessao, cenario, dono)
    servico.enviar(sessao, dono, requisicao)

    with pytest.raises(servico.AutoanaliseProibida):
        servico.iniciar_analise(sessao, dono, requisicao)
    assert requisicao.estado == "ENVIADA"
    assert requisicao.analisado_por is None


def test_rn28_a_mensagem_cita_as_duas_saidas_legitimas(sessao, banco):
    """Erro que só nega, sem dizer o caminho, é o que faz contornar por fora."""
    cenario = _cenario(sessao)
    dono = _usuario(sessao, login="tecnico", servidor_id=cenario["servidor"].id)
    requisicao = _pedido_pronto(sessao, cenario, dono)
    servico.enviar(sessao, dono, requisicao)

    with pytest.raises(servico.AutoanaliseProibida) as erro:
        servico.iniciar_analise(sessao, dono, requisicao)
    mensagem = str(erro.value)
    assert "outra pessoa" in mensagem
    assert "balcão" in mensagem and "/epis/entregas/nova" in mensagem
    assert "RN-28" in mensagem
    # é PermissaoNegada: a rota devolve 403, e não 500
    assert isinstance(erro.value, PermissaoNegada)
    assert erro.value.codigo == "epi.analisar"


def test_rn28_alcanca_todas_as_operacoes_de_analise(sessao, banco):
    """A regra vale em cada porta, e não só na primeira.

    Se ela morasse só em `iniciar_analise`, bastaria outra pessoa abrir o pedido
    para o dono decidi-lo em seguida.
    """
    cenario = _cenario(sessao)
    dono = _usuario(sessao, login="tecnico", servidor_id=cenario["servidor"].id)
    outro = _usuario(sessao, login="colega")
    requisicao = _pedido_pronto(sessao, cenario, dono)
    servico.enviar(sessao, dono, requisicao)
    servico.iniciar_analise(sessao, outro, requisicao)

    linha = requisicao.itens[0]
    with pytest.raises(servico.AutoanaliseProibida):
        servico.aprovar_item(sessao, dono, linha)
    with pytest.raises(servico.AutoanaliseProibida):
        servico.recusar_item(sessao, dono, linha, motivo=_motivo(sessao))
    with pytest.raises(servico.AutoanaliseProibida):
        servico.concluir_analise(sessao, dono, requisicao)
    with pytest.raises(servico.AutoanaliseProibida):
        servico.devolver_para_fila(sessao, dono, requisicao, "não sei decidir")
    with pytest.raises(servico.AutoanaliseProibida):
        servico.indeferir(sessao, dono, requisicao, motivo=_motivo(sessao))


def test_o_dono_do_pedido_ainda_recebe_epi_pela_entrega_de_balcao(sessao, banco):
    """A RN-28 não trava trabalho, e é este teste que sustenta a afirmação.

    Quem tem `epi.analisar` e precisa de EPI continua atendido pela entrega
    avulsa da fatia 2, que já baixa o lote, congela os snapshots e abre a
    pendência do comprovante.
    """
    cenario = _cenario(sessao)
    dono = _usuario(sessao, login="tecnico", servidor_id=cenario["servidor"].id)
    registro = epi_ficha.registrar_entrega(
        sessao,
        dono,
        servidor=cenario["servidor"],
        item=cenario["item"],
        quantidade=1,
        entrada=cenario["entrada"],
        tamanho="M",
    )
    assert registro.id is not None
    assert registro.requisicao_item_id is None  # entrega de balcão não tem pedido


def test_quem_nao_tem_a_permissao_de_analisar_e_barrado_antes_da_rn28(sessao, banco):
    cenario = _cenario(sessao)
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="secretaria")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    with pytest.raises(PermissaoNegada) as erro:
        servico.iniciar_analise(sessao, requerente, requisicao)
    assert not isinstance(erro.value, servico.AutoanaliseProibida)


# =====================================================================
# 6. RN-26 — a janela conta a FICHA
# =====================================================================
def test_rn26_a_janela_estoura_pela_ficha_e_nao_por_requisicoes_aprovadas(
    sessao, banco
):
    """Aprovação é promessa; entrega é fato; a ficha é a verdade.

    O item aqui é "1 por 12 meses". A primeira entrega vai pelo balcão — não há
    requisição nenhuma envolvida —, e mesmo assim ela é o que trava a aprovação
    seguinte. Se a conta somasse requisições aprovadas, esta entrega passaria
    despercebida.
    """
    cenario = _cenario(sessao, quantidade_maxima=1, periodo_maximo_meses=12)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")

    epi_ficha.registrar_entrega(
        sessao,
        analista,
        servidor=cenario["servidor"],
        item=cenario["item"],
        quantidade=1,
        entrada=cenario["entrada"],
        tamanho="M",
    )

    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=1)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)

    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.aprovar_item(sessao, analista, requisicao.itens[0])
    assert "a ficha registra 1" in str(erro.value)
    assert requisicao.itens[0].estado == "SOLICITADO"


def test_rn26_a_excecao_exige_autorizacao_e_justificativa_e_vira_evento(sessao, banco):
    """Bloqueio até que alguém assine com o próprio nome — como o art. 9º."""
    cenario = _cenario(sessao, quantidade_maxima=1, periodo_maximo_meses=12)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    epi_ficha.registrar_entrega(
        sessao,
        analista,
        servidor=cenario["servidor"],
        item=cenario["item"],
        quantidade=1,
        entrada=cenario["entrada"],
        tamanho="M",
    )
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=1)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    linha = requisicao.itens[0]

    # autorizar sem escrever por quê não basta: a justificativa é o que sustenta
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.aprovar_item(sessao, analista, linha, autorizar_excesso=True)
    assert "justificativa por escrito" in str(erro.value)

    servico.aprovar_item(
        sessao,
        analista,
        linha,
        autorizar_excesso=True,
        justificativa="Par anterior rasgou em serviço; incidente registrado no LEAC",
    )
    assert linha.estado == "APROVADO"
    assert linha.excedeu_maximo is True
    assert linha.autorizado_por == analista.id

    tipos = [e.tipo_evento for e in _eventos(sessao, "epi_requisicao_item", linha.id)]
    assert servico.EPI_MAXIMO_EXCEDIDO in tipos


def test_aprovar_mais_do_que_se_pediu_e_recusado(sessao, banco):
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=2)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.aprovar_item(
            sessao, analista, requisicao.itens[0], quantidade_aprovada=5
        )
    assert "foram pedidos 2" in str(erro.value)


def test_aprovar_zero_manda_recusar_com_motivo(sessao, banco):
    """Aprovar zero seria negar sem dizer por quê — e a pessoa não recebe nada
    por escrito. O caminho é a recusa fundamentada da RN-27."""
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.aprovar_item(
            sessao, analista, requisicao.itens[0], quantidade_aprovada=0
        )
    assert "RN-27" in str(erro.value)


# =====================================================================
# 7. RN-27 — a recusa fundamentada, catalogada e congelada
# =====================================================================
def test_rn27_o_texto_da_recusa_sobrevive_a_edicao_do_catalogo(sessao, banco):
    """A negativa que a pessoa recebeu é a que fica (mesmo princípio da RN-15).

    É a lição do CHANGELOG 1.4.0, quando editar catálogo reescrevia parecer
    emitido em silêncio.
    """
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)

    motivo = _motivo(sessao, "SEM_EXPOSICAO")
    texto_do_dia = motivo.texto
    linha = servico.recusar_item(sessao, analista, requisicao.itens[0], motivo=motivo)
    assert linha.estado == "RECUSADO"
    assert linha.texto_recusa_snapshot == texto_do_dia

    motivo.texto = "Texto novo, escrito depois, que não vale para a recusa de ontem."
    sessao.flush()
    sessao.refresh(linha)
    assert linha.texto_recusa_snapshot == texto_do_dia


def test_rn27_o_codigo_do_motivo_vai_para_a_trilha_e_a_contagem_sai_dela(sessao, banco):
    """É essa contagem que faz a decisão 3 virar número, e não anedota."""
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    linha = servico.recusar_item(
        sessao,
        analista,
        requisicao.itens[0],
        motivo=_motivo(sessao, "VINCULO_NAO_ATENDIDO"),
    )

    evento = [
        e
        for e in _eventos(sessao, "epi_requisicao_item", linha.id)
        if e.tipo_evento == servico.EPI_ITEM_RECUSADO
    ][0]
    assert evento.campo == "estado"
    assert evento.valor_anterior == "SOLICITADO"
    assert evento.valor_novo["motivo"] == "VINCULO_NAO_ATENDIDO"


def test_rn27_motivo_que_exige_complemento_nao_passa_sem_ele(sessao, banco):
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.recusar_item(
            sessao, analista, requisicao.itens[0], motivo=_motivo(sessao, "OUTRO")
        )
    assert "complemento" in str(erro.value)


# =====================================================================
# 8. RN-31 — só rascunho some de verdade
# =====================================================================
def test_rn31_rascunho_some_e_deixa_evento_na_trilha(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    identificador = requisicao.id
    servico.excluir_rascunho(sessao, usuario, requisicao)

    assert sessao.get(EpiRequisicao, identificador) is None
    assert (
        sessao.execute(
            select(EpiRequisicaoItem).where(
                EpiRequisicaoItem.requisicao_id == identificador
            )
        ).scalars().first()
        is None
    )
    tipos = [e.tipo_evento for e in _eventos(sessao, "epi_requisicao", identificador)]
    assert servico.EPI_REQUISICAO_EXCLUIDA in tipos


def test_rn31_requisicao_enviada_nao_se_exclui_cancela_com_motivo(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    servico.enviar(sessao, usuario, requisicao)

    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.excluir_rascunho(sessao, usuario, requisicao)
    assert "RN-31" in str(erro.value)

    servico.cancelar(sessao, usuario, requisicao, "A compra saiu por outro caminho")
    assert requisicao.estado == "CANCELADA"
    assert requisicao.motivo_cancelamento
    # o protocolo NÃO volta para a sequência: ele circulou
    assert requisicao.protocolo == f"EPI-{HOJE.year}-0001"


def test_cancelar_sem_motivo_e_recusado(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    servico.enviar(sessao, usuario, requisicao)
    with pytest.raises(servico.RequisicaoBloqueada):
        servico.cancelar(sessao, usuario, requisicao, "   ")


def test_cancelar_leva_os_itens_abertos_junto(sessao, banco):
    """Envelope terminal com item em SOLICITADO seria estado que não descreve
    fato nenhum — e a fila continuaria mostrando o que ninguém vai decidir."""
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    servico.enviar(sessao, usuario, requisicao)
    servico.cancelar(sessao, usuario, requisicao, "Servidora mudou de posto")
    assert [i.estado for i in requisicao.itens] == ["CANCELADO"]


def test_editar_pedido_protocolado_e_recusado(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    servico.enviar(sessao, usuario, requisicao)
    for chamada in (
        lambda: servico.atualizar_rascunho(sessao, usuario, requisicao),
        lambda: servico.adicionar_item(
            sessao, usuario, requisicao, item=cenario["item"], quantidade=1, tamanho="P"
        ),
        lambda: servico.remover_item(sessao, usuario, requisicao.itens[0]),
    ):
        with pytest.raises(servico.RequisicaoBloqueada):
            chamada()


def test_o_mesmo_item_e_tamanho_nao_entram_duas_vezes(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.adicionar_item(
            sessao, usuario, requisicao, item=cenario["item"], quantidade=1, tamanho="M"
        )
    assert "some as quantidades" in str(erro.value)


# =====================================================================
# 9. As duas máquinas de estado
# =====================================================================
def test_a_maquina_do_envelope_recusa_toda_transicao_nao_declarada(sessao, banco):
    """O que não está declarado é proibido — inclusive pular etapa.

    Sem isto, esconder o botão na tela seria a única guarda, e o POST continua
    chegando.
    """
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)

    # RASCUNHO não vai direto para EM_ANALISE
    with pytest.raises(TransicaoInvalida):
        servico._mover(
            sessao,
            requisicao,
            "EM_ANALISE",
            usuario,
            tipo_evento=servico.EPI_REQUISICAO_EM_ANALISE,
        )
    # ENVIADA não vai direto para ANALISADA nem para ATENDIDA
    servico.enviar(sessao, usuario, requisicao)
    for destino in ("ANALISADA", "ATENDIDA", "EM_ATENDIMENTO", "INDEFERIDA"):
        with pytest.raises(TransicaoInvalida):
            servico._mover(
                sessao,
                requisicao,
                destino,
                usuario,
                tipo_evento=servico.EPI_REQUISICAO_ANALISADA,
            )


def test_a_maquina_do_item_recusa_toda_transicao_nao_declarada(sessao, banco):
    usuario = _usuario(sessao)
    cenario = _cenario(sessao)
    requisicao = _pedido_pronto(sessao, cenario, usuario)
    servico.enviar(sessao, usuario, requisicao)
    linha = requisicao.itens[0]

    for destino in ("ENTREGUE", "RESERVADO", "SEM_ESTOQUE"):
        with pytest.raises(TransicaoInvalida):
            servico._mover_item(
                sessao, linha, destino, usuario, tipo_evento=servico.EPI_ITEM_ENTREGUE
            )


def test_terminal_e_terminal_recusado_e_cancelado_nao_voltam(sessao, banco):
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    linha = servico.recusar_item(
        sessao, analista, requisicao.itens[0], motivo=_motivo(sessao)
    )
    with pytest.raises(TransicaoInvalida):
        servico._mover_item(
            sessao, linha, "APROVADO", analista, tipo_evento=servico.EPI_ITEM_APROVADO
        )


def test_concluir_analise_exige_todo_item_decidido_e_um_aprovado(sessao, banco):
    """Concluir com metade das linhas em SOLICITADO tiraria da fila o que
    ninguém decidiu — e ninguém mais olharia."""
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    outro_item = EpiItem(
        nome="Óculos de proteção",
        categoria_id=cenario["item"].categoria_id,
        exige_ca=True,
        numero_ca="55555",
        quantidade_padrao=1,
    )
    sessao.add(outro_item)
    sessao.flush()

    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.adicionar_item(
        sessao, requerente, requisicao, item=outro_item, quantidade=1
    )
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)

    servico.aprovar_item(sessao, analista, requisicao.itens[0])
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.concluir_analise(sessao, analista, requisicao)
    assert "sem decisão" in str(erro.value)

    servico.recusar_item(
        sessao, analista, requisicao.itens[1], motivo=_motivo(sessao)
    )
    servico.concluir_analise(sessao, analista, requisicao, parecer="Luva devida")
    assert requisicao.estado == "ANALISADA"


def test_indeferir_exige_todo_item_recusado_e_motivo_do_catalogo(sessao, banco):
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)

    servico.aprovar_item(sessao, analista, requisicao.itens[0])
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.indeferir(sessao, analista, requisicao, motivo=_motivo(sessao))
    assert "TODO item" in str(erro.value)


def test_reconsideracao_traz_o_indeferido_de_volta_com_motivo(sessao, banco):
    """O único caminho de volta de um terminal, e ele fica na trilha.

    Sem ele, indeferimento errado só se consertava abrindo pedido novo — e o
    pedido novo apaga a história de que houve um erro.
    """
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    servico.recusar_item(sessao, analista, requisicao.itens[0], motivo=_motivo(sessao))
    servico.indeferir(sessao, analista, requisicao, motivo=_motivo(sessao))
    assert requisicao.estado == "INDEFERIDA"
    assert requisicao.motivo_recusa_id is not None

    with pytest.raises(servico.RequisicaoBloqueada):
        servico.reconsiderar(sessao, analista, requisicao, "")
    servico.reconsiderar(
        sessao, analista, requisicao, "A chefia trouxe a descrição correta da atividade"
    )
    assert requisicao.estado == "EM_ANALISE"
    # os itens NÃO voltam sozinhos: cada recusa foi decisão própria
    assert requisicao.itens[0].estado == "RECUSADO"

    tipos = [e.tipo_evento for e in _eventos(sessao, "epi_requisicao", requisicao.id)]
    assert servico.EPI_REQUISICAO_RECONSIDERADA in tipos


def test_devolver_para_a_fila_solta_o_analista(sessao, banco):
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    assert requisicao.analisado_por == analista.id
    servico.devolver_para_fila(sessao, analista, requisicao, "Falta a descrição do posto")
    assert requisicao.estado == "ENVIADA"
    assert requisicao.analisado_por is None


def test_toda_transicao_do_envelope_entra_na_trilha_no_formato_de_processo_mover(
    sessao, banco
):
    cenario = _cenario(sessao)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)

    eventos = _eventos(sessao, "epi_requisicao", requisicao.id)
    tipos = [e.tipo_evento for e in eventos]
    assert tipos == [
        servico.EPI_REQUISICAO_CRIADA,
        servico.EPI_REQUISICAO_ENVIADA,
        servico.EPI_REQUISICAO_EM_ANALISE,
    ]
    envio = eventos[1]
    assert envio.campo == "estado"
    assert (envio.valor_anterior, envio.valor_novo) == ("RASCUNHO", "ENVIADA")


# =====================================================================
# 10. A entrega — APROVADO direto para ENTREGUE, e a ATENDIDA automática
# =====================================================================
def test_entregar_reaproveita_a_ficha_baixa_o_lote_e_amarra_o_pedido(sessao, banco):
    """Nada de baixa de estoque escrita duas vezes: quem entrega é a fatia 2."""
    cenario = _cenario(sessao, recebido=10)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=2)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    linha = requisicao.itens[0]
    servico.aprovar_item(sessao, analista, linha)
    servico.concluir_analise(sessao, analista, requisicao)

    from app.servicos import epi_estoque

    antes = epi_estoque.saldo_fisico(sessao, cenario["entrada"].id)
    registro = servico.entregar_item(
        sessao, analista, linha, entrada=cenario["entrada"]
    )
    assert epi_estoque.saldo_fisico(sessao, cenario["entrada"].id) == antes - 2

    # o vínculo existe nos dois lados, e é FK de verdade
    assert registro.requisicao_item_id == linha.id
    movimento = sessao.execute(
        select(EpiMovimentoEstoque).where(
            EpiMovimentoEstoque.ficha_registro_id == registro.id
        )
    ).scalar_one()
    assert movimento.requisicao_item_id == linha.id
    # e a ficha nasceu com os snapshots congelados, como toda entrega
    assert registro.numero_ca_snapshot == "41234"


def test_atendida_chega_sozinha_quando_o_ultimo_item_sai(sessao, banco):
    """As duas transições do sistema: ANALISADA → EM_ATENDIMENTO → ATENDIDA.

    Deixá-las a cargo de um botão produziria o pedido atendido que continua
    aparecendo como pendente na fila.
    """
    cenario = _cenario(sessao, recebido=10)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=2)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    linha = requisicao.itens[0]
    servico.aprovar_item(sessao, analista, linha)
    servico.concluir_analise(sessao, analista, requisicao)
    assert requisicao.estado == "ANALISADA"

    # entrega parcial: o envelope entra em atendimento e o item continua devendo
    servico.entregar_item(
        sessao, analista, linha, entrada=cenario["entrada"], quantidade=1
    )
    assert requisicao.estado == "EM_ATENDIMENTO"
    assert linha.estado == "APROVADO"
    assert linha.quantidade_devida == 1

    servico.entregar_item(
        sessao, analista, linha, entrada=cenario["entrada"], quantidade=1
    )
    assert linha.estado == "ENTREGUE"
    assert requisicao.estado == "ATENDIDA"

    tipos = [e.tipo_evento for e in _eventos(sessao, "epi_requisicao", requisicao.id)]
    assert tipos[-2:] == [
        servico.EPI_REQUISICAO_EM_ATENDIMENTO,
        servico.EPI_REQUISICAO_ATENDIDA,
    ]


def test_item_recusado_nao_impede_a_atendida(sessao, banco):
    """Recusado não devia nada desde a decisão: não conta para o atendimento."""
    cenario = _cenario(sessao, recebido=10)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    outro_item = EpiItem(
        nome="Protetor auricular",
        categoria_id=cenario["item"].categoria_id,
        exige_ca=True,
        numero_ca="33333",
        quantidade_padrao=1,
    )
    sessao.add(outro_item)
    sessao.flush()
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=1)
    servico.adicionar_item(
        sessao, requerente, requisicao, item=outro_item, quantidade=1
    )
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    servico.aprovar_item(sessao, analista, requisicao.itens[0])
    servico.recusar_item(sessao, analista, requisicao.itens[1], motivo=_motivo(sessao))
    servico.concluir_analise(sessao, analista, requisicao)
    servico.entregar_item(
        sessao, analista, requisicao.itens[0], entrada=cenario["entrada"]
    )
    assert requisicao.estado == "ATENDIDA"


def test_cancelar_o_ultimo_item_aprovado_tambem_fecha_o_pedido(sessao, banco):
    cenario = _cenario(sessao, recebido=10)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    outro_item = EpiItem(
        nome="Avental de raspa",
        categoria_id=cenario["item"].categoria_id,
        exige_ca=True,
        numero_ca="22222",
        quantidade_padrao=1,
    )
    sessao.add(outro_item)
    sessao.flush()
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=1)
    servico.adicionar_item(
        sessao, requerente, requisicao, item=outro_item, quantidade=1
    )
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    servico.aprovar_item(sessao, analista, requisicao.itens[0])
    servico.aprovar_item(sessao, analista, requisicao.itens[1])
    servico.concluir_analise(sessao, analista, requisicao)
    servico.entregar_item(
        sessao, analista, requisicao.itens[0], entrada=cenario["entrada"]
    )
    assert requisicao.estado == "EM_ATENDIMENTO"
    servico.cancelar_item(
        sessao, analista, requisicao.itens[1], "Item veio pelo almoxarifado central"
    )
    assert requisicao.estado == "ATENDIDA"


def test_entregar_mais_do_que_foi_aprovado_e_recusado(sessao, banco):
    cenario = _cenario(sessao, recebido=10)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=2)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    servico.aprovar_item(
        sessao, analista, requisicao.itens[0], quantidade_aprovada=1
    )
    servico.concluir_analise(sessao, analista, requisicao)
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.entregar_item(
            sessao,
            analista,
            requisicao.itens[0],
            entrada=cenario["entrada"],
            quantidade=2,
        )
    assert "foram aprovados 1" in str(erro.value)


def test_entregar_antes_de_a_analise_terminar_e_recusado(sessao, banco):
    cenario = _cenario(sessao, recebido=10)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    servico.aprovar_item(sessao, analista, requisicao.itens[0])
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.entregar_item(
            sessao, analista, requisicao.itens[0], entrada=cenario["entrada"]
        )
    assert "analisada" in str(erro.value)


def test_cancelar_pedido_com_entrega_registrada_e_recusado(sessao, banco):
    """Entrega registrada não se desfaz por cancelamento: a ficha é a prova."""
    cenario = _cenario(sessao, recebido=10)
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=2)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    servico.aprovar_item(sessao, analista, requisicao.itens[0])
    servico.concluir_analise(sessao, analista, requisicao)
    servico.entregar_item(
        sessao, analista, requisicao.itens[0], entrada=cenario["entrada"], quantidade=1
    )
    with pytest.raises(servico.RequisicaoBloqueada) as erro:
        servico.cancelar(sessao, analista, requisicao, "desisti")
    assert "não se desfaz" in str(erro.value)


def test_a_excecao_da_rn26_autorizada_na_aprovacao_nao_trava_o_balcao(sessao, banco):
    """Sem repassar a justificativa, a validação da entrega recusaria de novo o
    que o analista já autorizou por escrito — na frente da pessoa."""
    cenario = _cenario(
        sessao, quantidade_maxima=1, periodo_maximo_meses=12, recebido=10
    )
    analista = _usuario(sessao, login="analista")
    requerente = _usuario(sessao, permissoes=REQUERENTE, login="joana")
    epi_ficha.registrar_entrega(
        sessao,
        analista,
        servidor=cenario["servidor"],
        item=cenario["item"],
        quantidade=1,
        entrada=cenario["entrada"],
        tamanho="M",
    )
    requisicao = _pedido_pronto(sessao, cenario, requerente, quantidade=1)
    servico.enviar(sessao, requerente, requisicao)
    servico.iniciar_analise(sessao, analista, requisicao)
    servico.aprovar_item(
        sessao,
        analista,
        requisicao.itens[0],
        autorizar_excesso=True,
        justificativa="Par anterior rasgou em serviço",
    )
    servico.concluir_analise(sessao, analista, requisicao)
    registro = servico.entregar_item(
        sessao, analista, requisicao.itens[0], entrada=cenario["entrada"]
    )
    assert registro.requisicao_item_id == requisicao.itens[0].id


# =====================================================================
# 11. Permissões
# =====================================================================
def test_as_duas_permissoes_novas_existem_e_estao_no_modulo_epi(banco):
    from app.servicos.rbac import PERMISSOES, modulo_da_permissao

    for codigo in ("epi.requisitar", "epi.analisar"):
        assert codigo in PERMISSOES, codigo
        assert modulo_da_permissao(codigo) == "EPI"


def test_o_seed_concede_as_permissoes_aos_perfis_da_matriz(sessao, banco):
    from app.modelos import Perfil

    esperado = {
        "coordenador_csso": ("epi.requisitar", "epi.analisar"),
        "engenheiro_seguranca": ("epi.requisitar", "epi.analisar"),
        "medico_trabalho": ("epi.requisitar", "epi.analisar"),
        "tecnico_seguranca": ("epi.requisitar", "epi.analisar"),
        "secretaria_csso": ("epi.requisitar",),
        "servidor_consulta": ("epi.requisitar",),
    }
    for codigo, permissoes in esperado.items():
        perfil = sessao.execute(
            select(Perfil).where(Perfil.codigo == codigo)
        ).scalar_one()
        tem = {p.codigo for p in perfil.permissoes}
        for permissao in permissoes:
            assert permissao in tem, f"{codigo} sem {permissao}"
    # quem só opera a prateleira não decide o direito ao item
    almoxarife = sessao.execute(
        select(Perfil).where(Perfil.codigo == "almoxarife_sesmt")
    ).scalar_one()
    assert "epi.analisar" not in {p.codigo for p in almoxarife.permissoes}


def test_sem_epi_requisitar_nao_se_abre_rascunho(sessao, banco):
    cenario = _cenario(sessao)
    ninguem = _usuario(sessao, permissoes=frozenset({"epi.ver"}), login="curioso")
    with pytest.raises(PermissaoNegada):
        servico.criar_rascunho(sessao, ninguem, servidor=cenario["servidor"])
