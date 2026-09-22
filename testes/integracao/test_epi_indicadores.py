"""Fatia 7 de Gestão de EPI: painel, vida útil, indicadores e exportação.

O que estes testes protegem, em ordem de gravidade:

1. **A supressão não se desfaz pela margem.** É o defeito mais fácil de não ver
   num indicador: cada tabela, olhada sozinha, parece certa, e o total do campus
   devolve a unidade escondida por uma subtração de cabeça. Uma unidade com três
   servidores, cruzada com a categoria da NR-6, nomeia gente sem citar nome.
2. **RN-32 não cobra troca de quem não deve.** Devolvido, estornado e
   substituído são fatos posteriores que encerram a cobrança, cada um por um
   motivo diferente — e a pendência tem de morrer com eles, ou a fila do sino
   vira ruído que ninguém lê.
3. **O item parado em `SEM_ESTOQUE` não depende de memória.** A pendência entra
   quando ele para e sai quando ele anda, inclusive na volta (reserva solta).
4. **As duas telas têm permissões diferentes**, e é a §9 quem manda: `/epis` é
   `epi.ver`, `/epis/relatorios` é `indicador.ver`.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.modelos import (
    Cargo,
    EpiCategoria,
    EpiEntradaEstoque,
    EpiItem,
    EpiMotivoRecusa,
    EpiMovimentoEstoque,
    Pendencia,
    Servidor,
    UnidadeUorg,
    Usuario,
)
from app.rotas.relatorios import MARCA_SUPRIMIDO, suprimir_aninhado
from app.servicos import epi_ficha, epi_indicadores
from app.servicos import epi_requisicao as servico
from app.servicos.autenticacao import gerar_hash
from app.servicos.rbac import UsuarioAtual
from testes.integracao.conftest import entrar

HOJE = date.today()
DAQUI_A_UM_ANO = HOJE + timedelta(days=365)

TUDO = frozenset(
    {"epi.ver", "epi.requisitar", "epi.analisar", "epi.estoque", "epi.entregar"}
)


# =====================================================================
# Montagem
# =====================================================================
def _usuario(sessao, login="operador") -> UsuarioAtual:
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
        permissoes=TUDO,
        perfis=("coordenador_csso",),
        servidor_id=None,
    )


def _item(sessao, *, nome="Luva de proteção química nitrílica", vida_util=6) -> EpiItem:
    categoria = sessao.execute(
        select(EpiCategoria).where(EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES")
    ).scalar_one()
    item = EpiItem(
        nome=nome,
        categoria_id=categoria.id,
        exige_ca=True,
        numero_ca="41234",
        validade_ca=DAQUI_A_UM_ANO,
        unidade_medida="PAR",
        tamanhos="P\nM\nG",
        vida_util_meses=vida_util,
        quantidade_padrao=1,
    )
    sessao.add(item)
    sessao.flush()
    return item


def _servidor(sessao, siape: str, nome: str, sigla_unidade: str = "FAMED") -> Servidor:
    unidade = sessao.execute(
        select(UnidadeUorg).where(UnidadeUorg.sigla == sigla_unidade)
    ).scalar_one()
    cargo = sessao.execute(select(Cargo)).scalars().first()
    servidor = Servidor(
        siape=siape,
        nome=nome,
        cargo_id=cargo.id,
        unidade_uorg_id=unidade.id,
    )
    sessao.add(servidor)
    sessao.flush()
    return servidor


def _entregar(sessao, usuario, servidor, item, *, dias_atras=0, quantidade=1):
    """Entrega de balcão, sem lote — o caminho mais curto até uma linha de ficha."""
    return epi_ficha.registrar_entrega(
        sessao,
        usuario,
        servidor=servidor,
        item=item,
        quantidade=quantidade,
        data_evento=HOJE - timedelta(days=dias_atras),
    )


def _pendencia(sessao, chave: str) -> Pendencia | None:
    return sessao.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one_or_none()


# =====================================================================
# 1. Supressão de célula pequena COM margem — o cuidado que vale mais
# =====================================================================
def test_a_margem_do_campus_nao_devolve_a_unidade_suprimida():
    """O total do campus é a margem das unidades dele, e a subtração é trivial.

    Sem tratar a margem, "Campus JK: 12 · FAMED: 9 · DODO: —" publica o número
    escondido: 12 − 9 = 3. A supressão secundária DENTRO do grupo é o que fecha
    a porta — as duas menores somem juntas, e a subtração devolve a soma das
    duas, que não nomeia ninguém.
    """
    grupos = {"DIA": {"FAMED": 9, "DODO": 3}, "MUC": {"IECT": 40}}
    linhas = {linha.rotulo: linha for linha in suprimir_aninhado(grupos, False)}

    dia = linhas["DIA"]
    assert dia.valor == "12"
    assert dict(dia.folhas) == {"FAMED": MARCA_SUPRIMIDO, "DODO": MARCA_SUPRIMIDO}
    # a prova de que a margem não devolve nada: o que sobra da subtração é a
    # soma de DUAS células, e não uma
    visiveis = [int(v) for _, v in dia.folhas if v.isdigit()]
    assert int(dia.valor) - sum(visiveis) == 12
    assert linhas["MUC"].valor == "40"


def test_grupo_de_folha_unica_esconde_o_total_junto():
    """Campus com uma unidade só: o total do campus É a unidade.

    Esconder a folha e publicar o total seria escrever o número duas vezes e
    apagar uma. A regra de folha única é o caso que a supressão secundária de
    `suprimir` não alcança sozinha — ali não há sobrevivente a sacrificar.

    A consequência é dura de propósito: com a única outra célula sendo a maior,
    ela vai junto (senão o grand total, que outra tabela do relatório pode
    entregar, devolveria a pequena). Tabela inteira suprimida é o preço de um
    recorte com três pessoas — e é o preço certo.
    """
    grupos = {"UNA": {"ICA": 3}, "DIA": {"FAMED": 40, "FCBS": 30}}
    linhas = {linha.rotulo: linha for linha in suprimir_aninhado(grupos, False)}

    assert linhas["UNA"].valor == MARCA_SUPRIMIDO
    assert dict(linhas["UNA"].folhas) == {"ICA": MARCA_SUPRIMIDO}
    # regra 3: nunca UM total sozinho — e a vítima leva as folhas dela junto
    assert linhas["DIA"].valor == MARCA_SUPRIMIDO
    assert set(dict(linhas["DIA"].folhas).values()) == {MARCA_SUPRIMIDO}


def test_total_do_campus_suprimido_nao_convive_com_unidade_visivel():
    """Campus com menos de 5 no total: todas as unidades dele somem.

    É o outro lado da mesma conta — somar as unidades devolveria o total. Aqui a
    supressão primária do total já implica a das folhas (o total é maior que
    qualquer uma), e o teste existe para que continue implicando depois de
    alguém mexer na função.
    """
    grupos = {"UNA": {"ICA": 2, "DZO": 2}, "DIA": {"FAMED": 40, "FCBS": 30}}
    linhas = {linha.rotulo: linha for linha in suprimir_aninhado(grupos, False)}
    assert linhas["UNA"].valor == MARCA_SUPRIMIDO
    assert set(dict(linhas["UNA"].folhas).values()) == {MARCA_SUPRIMIDO}


def test_quem_ve_exposicao_ve_a_celula_pequena():
    grupos = {"DIA": {"FAMED": 9, "DODO": 3}}
    linhas = suprimir_aninhado(grupos, True)
    assert linhas[0].valor == "12"
    assert dict(linhas[0].folhas) == {"FAMED": "9", "DODO": "3"}


# =====================================================================
# 2. RN-32 — vida útil e troca devida
# =====================================================================
def test_troca_vencida_abre_pendencia_idempotente(sessao, banco):
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao, vida_util=6)
    registro = _entregar(sessao, usuario, servidor, item, dias_atras=400)

    chave = epi_ficha.chave_da_pendencia_de_troca(registro.id)
    assert chave == f"troca:ficha:{registro.id}"
    pendencia = _pendencia(sessao, chave)
    assert pendencia is not None
    assert pendencia.tipo == "TROCA_EPI_DEVIDA"
    assert pendencia.entidade == "epi_ficha_registro"
    assert pendencia.entidade_id == registro.id
    # o prazo é a própria previsão, que já passou: a tarefa nasce atrasada
    assert pendencia.prazo == registro.previsao_troca
    assert pendencia.atrasada()
    # RN-19: a fila de tarefas não é tela nominal
    assert servidor.nome not in pendencia.descricao
    assert f"#{servidor.id}" in pendencia.descricao

    # idempotente: sincronizar de novo não abre uma segunda
    epi_ficha.sincronizar_pendencia_de_troca(sessao, registro, usuario)
    assert (
        len(list(sessao.execute(select(Pendencia).where(Pendencia.chave == chave)).scalars()))
        == 1
    )


def test_troca_ainda_no_prazo_nao_abre_nada(sessao, banco):
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao, vida_util=6)
    registro = _entregar(sessao, usuario, servidor, item, dias_atras=30)
    assert _pendencia(sessao, epi_ficha.chave_da_pendencia_de_troca(registro.id)) is None
    assert not epi_ficha.troca_devida_em(sessao, registro)


def test_item_sem_vida_util_nunca_deve_troca(sessao, banco):
    """Sem `vida_util_meses` não há `previsao_troca`, e sem ela não há dívida.

    "Não sei quanto dura" não é "durou o suficiente" — mas também não é uma data
    que se possa cobrar. O lugar de consertar isso é o catálogo.
    """
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao, vida_util=None)
    registro = _entregar(sessao, usuario, servidor, item, dias_atras=400)
    assert registro.previsao_troca is None
    assert not epi_ficha.troca_devida_em(sessao, registro)


def test_devolucao_integral_encerra_a_cobranca_e_a_parcial_nao(sessao, banco):
    """O equipamento voltou: não há o que trocar. Metade devolvida não é isso."""
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao, vida_util=6)
    registro = _entregar(sessao, usuario, servidor, item, dias_atras=400, quantidade=2)
    chave = epi_ficha.chave_da_pendencia_de_troca(registro.id)
    assert _pendencia(sessao, chave) is not None

    epi_ficha.registrar_devolucao(
        sessao, usuario, registro, quantidade=1, motivo="uma das duas rasgou"
    )
    assert epi_ficha.troca_devida_em(sessao, registro)
    assert not _pendencia(sessao, chave).concluida

    epi_ficha.registrar_devolucao(
        sessao, usuario, registro, quantidade=1, motivo="a outra também voltou"
    )
    assert not epi_ficha.troca_devida_em(sessao, registro)
    assert _pendencia(sessao, chave).concluida


def test_estorno_encerra_a_cobranca_de_troca(sessao, banco):
    """Estorno diz que a entrega não vale: cobrar troca dela é inventar dívida."""
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao, vida_util=6)
    registro = _entregar(sessao, usuario, servidor, item, dias_atras=400)
    chave = epi_ficha.chave_da_pendencia_de_troca(registro.id)
    assert not _pendencia(sessao, chave).concluida

    epi_ficha.estornar(sessao, usuario, registro, "lançado no servidor errado")
    assert not epi_ficha.troca_devida_em(sessao, registro)
    assert _pendencia(sessao, chave).concluida


def test_substituicao_encerra_a_cobranca_da_entrega_antiga(sessao, banco):
    """A troca **foi feita**: a entrega nova é a substituição da antiga.

    É a exceção que não deixa rastro próprio — devolução e estorno criam linha
    apontando para a entrega, a substituição é só outra entrega. Sem ela, quem
    trocou continuaria sendo cobrado, e a fila do sino viraria ruído.
    """
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao, vida_util=6)
    antiga = _entregar(sessao, usuario, servidor, item, dias_atras=400)
    chave = epi_ficha.chave_da_pendencia_de_troca(antiga.id)
    assert not _pendencia(sessao, chave).concluida

    nova = _entregar(sessao, usuario, servidor, item, dias_atras=0)
    assert not epi_ficha.troca_devida_em(sessao, antiga)
    assert _pendencia(sessao, chave).concluida
    # a nova ainda está no prazo — trocar não gera dívida nova
    assert _pendencia(sessao, epi_ficha.chave_da_pendencia_de_troca(nova.id)) is None
    assert epi_ficha.trocas_devidas(sessao) == []


def test_substituicao_de_OUTRO_item_nao_encerra_nada(sessao, banco):
    """Bota nova não substitui luva vencida — a exceção é por item."""
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    luva = _item(sessao, vida_util=6)
    bota = _item(sessao, nome="Bota de segurança com biqueira", vida_util=24)
    antiga = _entregar(sessao, usuario, servidor, luva, dias_atras=400)
    _entregar(sessao, usuario, servidor, bota, dias_atras=0)

    assert epi_ficha.troca_devida_em(sessao, antiga)
    assert [r.id for r in epi_ficha.trocas_devidas(sessao)] == [antiga.id]


# =====================================================================
# 3. O item parado em SEM_ESTOQUE
# =====================================================================
def _pedido_aprovado(sessao, usuario, servidor, item, *, quantidade=2):
    requisicao = servico.criar_rascunho(
        sessao,
        usuario,
        servidor=servidor,
        descricao_atividade="Manipulação de reagentes no laboratório",
    )
    servico.adicionar_item(
        sessao, usuario, requisicao, item=item, quantidade=quantidade, tamanho="M"
    )
    servico.enviar(sessao, usuario, requisicao)
    servico.iniciar_analise(sessao, usuario, requisicao)
    linha = requisicao.itens[0]
    servico.aprovar_item(sessao, usuario, linha)
    servico.concluir_analise(sessao, usuario, requisicao)
    return linha


def _lote(sessao, item, *, recebido=10) -> EpiEntradaEstoque:
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id,
        empenho="2026NE000123",
        data_entrada=HOJE - timedelta(days=10),
        quantidade_recebida=recebido,
        valor_unitario=Decimal("12.50"),
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
    return entrada


def test_item_sem_estoque_entra_no_sino_e_sai_quando_anda(sessao, banco):
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao)
    linha = _pedido_aprovado(sessao, usuario, servidor, item)

    servico.marcar_sem_estoque(
        sessao, usuario, linha, complemento="pregão em andamento"
    )
    chave = servico.chave_da_pendencia_de_falta(linha.id)
    assert chave == f"sem_estoque:requisicao_item:{linha.id}"
    pendencia = _pendencia(sessao, chave)
    assert pendencia is not None
    assert pendencia.tipo == "EPI_SEM_ESTOQUE"
    assert pendencia.responsavel_id == usuario.id
    # RN-19: o pedido é identificado pelo protocolo, que não nomeia ninguém
    assert servidor.nome not in pendencia.descricao
    assert linha.requisicao.identificacao in pendencia.descricao

    entrada = _lote(sessao, item)
    servico.reservar_item(sessao, usuario, linha, entrada=entrada)
    assert _pendencia(sessao, chave).concluida


def test_reserva_solta_devolve_o_item_ao_sino(sessao, banco):
    """Ida e volta é caminho normal aqui, e `abrir` sozinha não reabriria nada.

    `pendencias.abrir` é idempotente por CHAVE, e não por chave-em-aberto: sem
    `reabrir`, o item voltaria a `SEM_ESTOQUE` pelo mesmo motivo de antes e
    sairia do sino em silêncio — que é exatamente o que a fatia 7 veio consertar.
    """
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao)
    linha = _pedido_aprovado(sessao, usuario, servidor, item)
    entrada = _lote(sessao, item)

    servico.reservar_item(sessao, usuario, linha, entrada=entrada)
    chave = servico.chave_da_pendencia_de_falta(linha.id)
    assert _pendencia(sessao, chave) is None

    servico.soltar_reserva(sessao, usuario, linha, "o lote foi para um caso urgente")
    assert _pendencia(sessao, chave) is not None
    assert not _pendencia(sessao, chave).concluida

    servico.reservar_item(sessao, usuario, linha, entrada=entrada)
    assert _pendencia(sessao, chave).concluida

    servico.soltar_reserva(sessao, usuario, linha, "de novo, e pelo mesmo motivo")
    # a MESMA tarefa reabre — duas linhas fariam a fila contar duas vezes o que
    # é uma coisa só
    abertas = list(
        sessao.execute(select(Pendencia).where(Pendencia.chave == chave)).scalars()
    )
    assert len(abertas) == 1
    assert not abertas[0].concluida


def test_cancelar_o_pedido_fecha_a_pendencia_de_falta(sessao, banco):
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao)
    linha = _pedido_aprovado(sessao, usuario, servidor, item)
    servico.marcar_sem_estoque(sessao, usuario, linha, complemento="sem previsão")
    chave = servico.chave_da_pendencia_de_falta(linha.id)
    assert not _pendencia(sessao, chave).concluida

    servico.cancelar(
        sessao, usuario, linha.requisicao, "o servidor foi transferido de posto"
    )
    assert _pendencia(sessao, chave).concluida


# =====================================================================
# 4. O painel de /epis
# =====================================================================
def test_painel_reune_as_cinco_medidas(sessao, banco):
    usuario = _usuario(sessao)
    joana = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    carlos = _servidor(sessao, "1112223", "Carlos Menezes", "IECT")
    item = _item(sessao, vida_util=6)

    vencida = _entregar(sessao, usuario, joana, item, dias_atras=400)
    do_mes = _entregar(sessao, usuario, carlos, item, dias_atras=0)
    linha = _pedido_aprovado(sessao, usuario, joana, item)
    servico.marcar_sem_estoque(sessao, usuario, linha, complemento="pregão deserto")
    # um lote com CA vencendo dentro da janela dos 60 dias
    entrada = _lote(sessao, item)
    entrada.validade_ca = HOJE + timedelta(days=10)
    sessao.flush()

    p = epi_indicadores.painel(sessao)
    assert [r.id for r in p.trocas_devidas] == [vencida.id]
    assert [r.id for r in p.entregas_do_mes] == [do_mes.id]
    assert [i.id for i in p.esperando_estoque] == [linha.id]
    assert [lote.entrada.id for lote in p.lotes_a_vencer] == [entrada.id]
    # o pedido segue ANALISADA: `EM_ATENDIMENTO` chega na primeira RESERVA, e
    # marcar falta é justamente dizer que não há lote a reservar
    assert p.requisicoes_por_estado["ANALISADA"] == 1
    assert p.requisicoes_abertas == 1


def test_painel_nao_conta_entrega_estornada(sessao, banco):
    """Estorno declara que a entrega não aconteceu — contá-la mediria digitação."""
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao)
    registro = _entregar(sessao, usuario, servidor, item)
    assert len(epi_indicadores.entregas_do_mes(sessao)) == 1

    epi_ficha.estornar(sessao, usuario, registro, "quantidade digitada errada")
    assert epi_indicadores.entregas_do_mes(sessao) == []


def test_painel_abre_para_epi_ver_e_nega_quem_nao_opera(app_cliente, contas):
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert app_cliente.get("/epis").status_code == 200
    entrar(app_cliente, contas, "admin_ti")
    assert app_cliente.get("/epis").status_code == 403


def test_painel_da_a_medida_a_todos_e_a_linha_so_a_quem_le_ficha(
    app_cliente, contas, banco
):
    """A medida é do setor; a linha é da ficha, e a ficha é `epi.ficha`.

    `secretaria_csso` tem `epi.ver` e não tem `epi.ficha`: ela vê que há uma
    troca vencida e não vê de quem. Publicar a linha aqui abriria pela porta do
    painel o que `/epis/fichas` fecha na porta da frente — e o painel não é lugar
    de afrouxar a permissão de outra tela.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        usuario = _usuario(s)
        servidor = _servidor(s, "7654321", "Joana Ribeiro de Almeida")
        item = _item(s, vida_util=6)
        _entregar(s, usuario, servidor, item, dias_atras=400)
        s.commit()

    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/epis").text
    assert "Trocas devidas" in corpo
    assert "Joana Ribeiro de Almeida" not in corpo
    assert "Luva de proteção química nitrílica" not in corpo

    # o almoxarife tem `epi.ficha` e é quem entrega: ele vê a linha e o nome
    entrar(app_cliente, contas, "almoxarife_sesmt")
    com_ficha = app_cliente.get("/epis").text
    assert "Luva de proteção química nitrílica" in com_ficha
    assert "Joana Ribeiro de Almeida" in com_ficha


def test_relatorios_e_indicador_ver_e_nao_epi_ver(app_cliente, contas):
    """A §9 declara `indicador.ver`, e a diferença tem consequência: o almoxarife
    opera o módulo inteiro e não abre o relatório.

    Não é rigor de tabela. O painel conta o trabalho parado do setor; o relatório
    recorta a população por unidade e por categoria da NR-6, que é onde a
    reidentificação acontece por acidente.
    """
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert app_cliente.get("/epis/relatorios").status_code == 403
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/epis/relatorios").status_code == 200


# =====================================================================
# 5. Os indicadores
# =====================================================================
def _populacao(sessao, usuario, *, quantos: int, sigla: str, inicio: int = 0):
    item = sessao.execute(
        select(EpiItem).where(EpiItem.nome == "Luva de proteção química nitrílica")
    ).scalar_one_or_none() or _item(sessao)
    for n in range(quantos):
        servidor = _servidor(
            sessao, f"{2000000 + inicio + n}", f"Servidor {inicio + n}", sigla
        )
        _entregar(sessao, usuario, servidor, item, quantidade=2)
    return item


def test_entregue_conta_servidores_e_nao_pecas(sessao, banco):
    """A célula é sobre gente, porque o limiar da RN-19 é sobre gente.

    Uma pessoa que levou doze pares apareceria como "12" numa contagem de peças,
    passaria por qualquer limiar e continuaria sendo uma pessoa só — nomeada pelo
    cruzamento com a categoria e o exercício.
    """
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao)
    _entregar(sessao, usuario, servidor, item, quantidade=6)
    _entregar(sessao, usuario, servidor, item, quantidade=6)

    dados = epi_indicadores.relatorio(sessao)
    categoria = item.categoria.nome
    assert dados.por_categoria.servidores[categoria] == 1
    assert dados.por_categoria.quantidade[categoria] == 12


def test_relatorio_agrupa_campus_e_unidade_da_mesma_leitura(sessao, banco):
    usuario = _usuario(sessao)
    _populacao(sessao, usuario, quantos=6, sigla="FAMED")
    _populacao(sessao, usuario, quantos=5, sigla="IECT", inicio=100)

    dados = epi_indicadores.relatorio(sessao)
    assert dados.por_campus["DIA"] == {"Faculdade de Medicina de Diamantina": 6}
    assert dados.por_campus["MUC"] == {
        "Instituto de Engenharia, Ciência e Tecnologia (IECT)": 5
    }


def test_custo_por_empenho_nao_e_suprimido_e_diz_quando_e_piso(sessao, banco):
    """Empenho é execução orçamentária: público pela Lei 12.527, e não nomeia
    ninguém. O que ele precisa dizer é quando o número é piso."""
    usuario = _usuario(sessao)
    item = _item(sessao)
    _lote(sessao, item, recebido=10)
    sem_valor = _lote(sessao, item, recebido=4)
    sem_valor.valor_unitario = None
    sessao.flush()
    _ = usuario

    linhas = {linha.empenho: linha for linha in epi_indicadores.relatorio(sessao).empenhos}
    empenho = linhas["2026NE000123"]
    assert empenho.lotes == 2
    assert empenho.recebido == 14
    assert empenho.custo == Decimal("125.00")
    assert empenho.incompleto


def test_recusa_por_motivo_sai_da_trilha_nas_duas_origens(sessao, banco):
    """RN-27: a contagem sai da trilha, e as duas portas de recusa contam.

    A de balcão é a que mais importa aqui: pedido de terceirizado (decisão 3) não
    vira requisição nenhuma, porque quem não é servidor não está no cadastro.
    Contar só a recusa de item deixaria de fora exatamente a negativa que instrui
    o ofício à empresa contratante.
    """
    usuario = _usuario(sessao)
    servidor = _servidor(sessao, "7654321", "Joana Ribeiro de Almeida")
    item = _item(sessao)
    motivo = sessao.execute(
        select(EpiMotivoRecusa).where(
            EpiMotivoRecusa.codigo == "VINCULO_NAO_ATENDIDO"
        )
    ).scalar_one()

    epi_ficha.recusar(
        sessao,
        usuario,
        motivo=motivo,
        a_quem="prestador da empresa de limpeza",
        item=item,
        unidade="Faculdade de Medicina de Diamantina",
        complemento="encaminhado à contratante",
    )

    linha = _pedido_aprovado(sessao, usuario, servidor, item)
    outro = servico.criar_rascunho(
        sessao,
        usuario,
        servidor=servidor,
        descricao_atividade="Atividade administrativa sem exposição",
    )
    servico.adicionar_item(
        sessao, usuario, outro, item=item, quantidade=1, tamanho="M"
    )
    servico.enviar(sessao, usuario, outro)
    servico.iniciar_analise(sessao, usuario, outro)
    servico.recusar_item(
        sessao, usuario, outro.itens[0], motivo=motivo, complemento="idem"
    )
    _ = linha

    dados = epi_indicadores.relatorio(sessao)
    assert dados.total_recusas == 2
    assert sum(dados.recusas_por_motivo.values()) == 2
    assert dados.recusas_por_motivo[motivo.rotulo] == 2
    assert (
        dados.recusas_por_unidade["Faculdade de Medicina de Diamantina"] == 2
    )


def _leitor(*permissoes: str) -> UsuarioAtual:
    return UsuarioAtual(
        id=1,
        login="leitor",
        nome="Leitor",
        permissoes=frozenset(permissoes),
        perfis=("auditor_interno",),
    )


def test_relatorio_suprime_a_celula_pequena_e_a_margem_dela(sessao, banco):
    """O caminho da tela, não só o da função pura.

    Três servidores na Odontologia e cinco na FAMED: sem tratamento de margem,
    "DIA: 8 · FAMED: 5 · DODO: —" devolveria o 3 por subtração. Aqui a FAMED some
    junto (secundária dentro do grupo), e o que a margem entrega é a soma das
    duas.
    """
    from app.rotas import epi_indicadores as rota

    usuario = _usuario(sessao)
    _populacao(sessao, usuario, quantos=3, sigla="DODO")
    _populacao(sessao, usuario, quantos=5, sigla="FAMED", inicio=100)

    escondido = rota._contexto(sessao, _leitor("indicador.ver"), None)
    dia = {linha.rotulo: linha for linha in escondido["por_campus"]}["DIA"]
    assert dict(dia.folhas) == {
        "Departamento de Odontologia": MARCA_SUPRIMIDO,
        "Faculdade de Medicina de Diamantina": MARCA_SUPRIMIDO,
    }
    assert dia.valor == "8"
    # a categoria reúne os oito e sobrevive: aí a quantidade de peças sai
    assert set(escondido["quantidade_categoria"].values()) == {"16"}

    visto = rota._contexto(sessao, _leitor("indicador.ver", "exposicao.ver"), None)
    dia_nominal = {linha.rotulo: linha for linha in visto["por_campus"]}["DIA"]
    assert dict(dia_nominal.folhas) == {
        "Departamento de Odontologia": "3",
        "Faculdade de Medicina de Diamantina": "5",
    }


def test_quantidade_de_pecas_some_junto_com_a_celula(sessao, banco):
    """Publicar "— servidores · 6 pares" seria esconder e mostrar o mesmo.

    A quantidade varia com as mesmas pessoas: seis pares numa unidade continua
    dizendo que ali há pouca gente. Ela é informação do setor — mas só depois que
    a célula sobreviveu.
    """
    from app.rotas import epi_indicadores as rota

    usuario = _usuario(sessao)
    _populacao(sessao, usuario, quantos=3, sigla="DODO")

    escondido = rota._contexto(sessao, _leitor("indicador.ver"), None)
    assert set(escondido["por_categoria"].values()) == {MARCA_SUPRIMIDO}
    assert set(escondido["quantidade_categoria"].values()) == {MARCA_SUPRIMIDO}

    visto = rota._contexto(sessao, _leitor("indicador.ver", "exposicao.ver"), None)
    assert set(visto["por_categoria"].values()) == {"3"}
    assert set(visto["quantidade_categoria"].values()) == {"6"}


def test_a_tela_do_relatorio_avisa_por_que_ha_traco(app_cliente, contas, banco):
    """`secretaria_csso` tem `indicador.ver` e não vê nominal — é o perfil que
    prova que a supressão está ligada na tela, e não só na função."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        usuario = _usuario(s)
        _populacao(s, usuario, quantos=3, sigla="DODO")
        s.commit()

    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/epis/relatorios").text
    assert "célula suprimida" in corpo
    assert "margem intacta" in corpo

    entrar(app_cliente, contas, "coordenador_csso")
    assert "margem intacta" not in app_cliente.get(
        "/epis/relatorios"
    ).text


# =====================================================================
# 6. Exportação — mesmo formato do sistema, mesma supressão
# =====================================================================
def test_exportacao_segue_o_formato_da_casa(app_cliente, contas, banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        usuario = _usuario(s)
        item = _populacao(s, usuario, quantos=6, sigla="FAMED")
        _lote(s, item)
        s.commit()

    entrar(app_cliente, contas, "secretaria_csso")
    # `indicador.ver` sem `exportar`: a URL não é a porta dos fundos do relatório
    assert app_cliente.get("/epis/relatorios/exportar").status_code == 403

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/epis/relatorios/exportar")
    assert resposta.status_code == 200
    # o mesmo formato de `/relatorios/exportar-processos`: BOM e ponto e vírgula
    assert resposta.content.startswith(b"\xef\xbb\xbf")
    assert "attachment" in resposta.headers["content-disposition"]
    corpo = resposta.content.decode("utf-8-sig")
    assert corpo.splitlines()[0].startswith("Indicador;Recorte")
    assert "Entregue por categoria (NR-6)" in corpo
    assert "Entregue por unidade;DIA;Faculdade de Medicina de Diamantina;6" in corpo
    assert "Custo por empenho;2026NE000123" in corpo
    # quem vê nominal não recebe traço nenhum, e a nota não sai
    assert "Nota;" not in corpo


def test_exportacao_de_quem_nao_ve_nominal_leva_supressao_e_a_nota(sessao, banco):
    """O CSV se descola da tela no primeiro anexo de e-mail.

    Sem a nota dentro do arquivo, quem o receber lê traço onde esperava número e
    conclui que o sistema perdeu o dado. O teste corre pela função da rota porque
    **nenhum perfil semeado hoje tem `exportar` sem enxergar nominal** — o que
    não torna o caminho hipotético: a combinação nasce de uma concessão avulsa,
    que é o que `/usuarios` existe para permitir.
    """
    from app.rotas import epi_indicadores as rota

    usuario = _usuario(sessao)
    _populacao(sessao, usuario, quantos=3, sigla="DODO")

    resposta = rota.exportar(None, sessao, _leitor("indicador.ver", "exportar"), None)
    corpo = resposta.body.decode("utf-8-sig")
    assert f"Entregue por unidade;DIA;Departamento de Odontologia;{MARCA_SUPRIMIDO}" in corpo
    assert "Nota;" in corpo
    assert "menos de 5 servidores" in corpo
