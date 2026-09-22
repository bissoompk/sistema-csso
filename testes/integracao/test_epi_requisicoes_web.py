"""Fatia 4 de Gestão de EPI, pela tela: fila, formulário, análise e entrega.

As máquinas de estado e as regras já estão cobertas em `test_epi_requisicao.py`,
que exercita o serviço direto. O que ESTES testes protegem é o que só a tela
pode quebrar — e cada um deles corresponde a um modo de falha conhecido:

1. **A permissão do menu é a mesma da rota.** Foi assim que Relatórios e
   Importar apareceram escondidos na 1.6.0; aqui a fila abre para `epi.ver` e o
   formulário só para `epi.requisitar`, e os dois são conferidos perfil a perfil.
2. **O 403 da RN-28 chega com a mensagem INTEIRA.** Erro que só nega, sem dizer
   o caminho, é o que faz a pessoa contornar o sistema por fora — e a mensagem
   cita as duas saídas legítimas. Truncá-la na tela desfaria a decisão do §12.3
   sem mudar uma linha do serviço.
3. **A RN-26 tem caminho de reenvio na própria tela.** O bloqueio da janela não
   é duro: sem a caixa de autorização e a justificativa no mesmo formulário, o
   analista fica preso no erro — e resolve o caso por fora.
4. **A busca não aceita CPF.** Não há coluna de CPF em lugar nenhum do módulo
   (decisão 1), e a tela diz isso em vez de responder "nada encontrado", que
   faria a pessoa concluir que o pedido não existe.
5. **Só RASCUNHO é editável.** Depois do envio o pedido é documento
   protocolado, e a tela não pode oferecer o que o serviço vai recusar.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from urllib.parse import unquote

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
    Servidor,
    UnidadeUorg,
    Usuario,
)
from testes.integracao.conftest import entrar

FILA = "/epis/requisicoes"
NOVA = "/epis/requisicoes/nova"
ENTREGAS = "/epis/entregas"

HOJE = date.today()
DAQUI_A_UM_ANO = HOJE + timedelta(days=365)


# =====================================================================
# Cenário
# =====================================================================
def _cenario(
    *,
    quantidade_maxima: int | None = None,
    periodo_maximo_meses: int | None = None,
    exige_justificativa: bool = False,
) -> dict:
    """Um servidor, um item de catálogo com tamanhos e um lote com saldo."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        categoria = s.execute(
            select(EpiCategoria).where(EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES")
        ).scalar_one()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        cargo = s.execute(select(Cargo)).scalars().first()
        servidor = Servidor(
            siape="7654321",
            nome="Joana Ribeiro de Almeida",
            email="joana.almeida@ufvjm.edu.br",
            cargo_id=cargo.id,
            unidade_uorg_id=unidade.id,
        )
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
            quantidade_maxima=quantidade_maxima,
            periodo_maximo_meses=periodo_maximo_meses,
            exige_justificativa=exige_justificativa,
        )
        s.add_all([servidor, item])
        s.flush()
        entrada = EpiEntradaEstoque(
            epi_item_id=item.id,
            tamanho="M",
            empenho="2026NE000123",
            data_entrada=HOJE - timedelta(days=30),
            quantidade_recebida=10,
            lote="L-2026-08",
            numero_ca="41234",
            validade_ca=DAQUI_A_UM_ANO,
        )
        s.add(entrada)
        s.flush()
        s.add(
            EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=10)
        )
        s.commit()
        return {
            "servidor": servidor.id,
            "item": item.id,
            "entrada": entrada.id,
            "unidade": unidade.id,
        }


def _lote_vencido(cenario: dict) -> int:
    """Um segundo lote do mesmo item, com o CA vencido. RN-25 na tela."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        entrada = EpiEntradaEstoque(
            epi_item_id=cenario["item"],
            tamanho="M",
            data_entrada=HOJE - timedelta(days=800),
            quantidade_recebida=5,
            lote="L-2023-01",
            numero_ca="30001",
            validade_ca=HOJE - timedelta(days=10),
        )
        s.add(entrada)
        s.flush()
        s.add(EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=5))
        s.commit()
        return entrada.id


def _amarrar_conta_ao_servidor(login: str, servidor_id: int) -> None:
    """Faz da conta o titular do pedido — é o que arma a RN-28."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        conta = s.execute(select(Usuario).where(Usuario.login == login)).scalar_one()
        conta.servidor_id = servidor_id
        s.commit()


def _abrir(cliente, cenario, **troca):
    dados = {
        "servidor_id": str(cenario["servidor"]),
        "chefia_servidor_id": "",
        "finalidade": "ROTINA",
        "descricao_atividade": "Manipulação de reagentes no laboratório",
        "riscos_declarados": "Contato com ácidos e solventes",
        "urgencia": "NORMAL",
        "justificativa_urgencia": "",
    }
    dados.update({k: str(v) for k, v in troca.items()})
    return cliente.post(FILA, data=dados, follow_redirects=False)


def _acrescentar(cliente, requisicao_id, cenario, **troca):
    dados = {
        "item_id": str(cenario["item"]),
        "quantidade": "1",
        "tamanho": "M",
        "justificativa": "",
    }
    dados.update({k: str(v) for k, v in troca.items()})
    return cliente.post(
        f"{FILA}/{requisicao_id}/itens", data=dados, follow_redirects=False
    )


def _requisicoes() -> list[EpiRequisicao]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return list(
            s.execute(select(EpiRequisicao).order_by(EpiRequisicao.id)).scalars()
        )


def _linhas(requisicao_id: int) -> list[EpiRequisicaoItem]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return list(
            s.execute(
                select(EpiRequisicaoItem)
                .where(EpiRequisicaoItem.requisicao_id == requisicao_id)
                .order_by(EpiRequisicaoItem.id)
            ).scalars()
        )


def _motivo(codigo="SEM_EXPOSICAO") -> int:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return s.execute(
            select(EpiMotivoRecusa).where(EpiMotivoRecusa.codigo == codigo)
        ).scalar_one().id


def _recado(resposta) -> str:
    """O que o sistema respondeu, venha por redirect ou pela tela redesenhada.

    A abertura do rascunho recusada não redireciona mais: ela redesenha o
    formulário com o digitado de volta (o padrão `digitado` de
    `processos.criar`), porque os dois campos longos daqui — rotina de trabalho e
    riscos declarados — são o que fundamenta a decisão de quem vai analisar, e
    quem os redigita escreve menos.
    """
    destino = resposta.headers.get("location")
    return unquote(destino) if destino else resposta.text


def _pedido_enviado(cliente, cenario, **troca):
    """Rascunho com uma linha, já protocolado."""
    _abrir(cliente, cenario)
    requisicao = _requisicoes()[-1]
    _acrescentar(cliente, requisicao.id, cenario, **troca)
    resposta = cliente.post(f"{FILA}/{requisicao.id}/enviar", follow_redirects=False)
    assert resposta.status_code == 303, _recado(resposta)
    return requisicao.id


# =====================================================================
# 1. Permissão de cada rota — e o menu que não pode mentir
# =====================================================================
@pytest.mark.parametrize(
    "perfil,fila,nova",
    [
        ("coordenador_csso", 200, 200),
        ("tecnico_seguranca", 200, 200),
        ("engenheiro_seguranca", 200, 200),
        ("medico_trabalho", 200, 200),
        # pede pelo servidor e não decide (§8): a fila e o formulário abrem
        ("secretaria_csso", 200, 200),
        ("servidor_consulta", 200, 200),
        # veem a fila e não abrem pedido: o almoxarife opera estoque e entrega,
        # e os três de consulta leem sem escrever
        ("almoxarife_sesmt", 200, 403),
        ("consulta_progep", 200, 403),
        ("auditor_interno", 200, 403),
        ("superintendente", 200, 403),
        # admin_ti continua sem conteúdo técnico
        ("admin_ti", 403, 403),
    ],
)
def test_permissao_das_telas_de_requisicao(app_cliente, contas, banco, perfil, fila, nova):
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(FILA).status_code == fila
    assert app_cliente.get(NOVA).status_code == nova


@pytest.mark.parametrize(
    "perfil,abrir,decidir",
    [
        ("coordenador_csso", 303, 303),
        # abre pedido e NÃO decide: decidir é ato técnico (§8)
        ("secretaria_csso", 303, 403),
        ("servidor_consulta", 303, 403),
        # nem abre nem decide
        ("almoxarife_sesmt", 403, 403),
        ("auditor_interno", 403, 403),
    ],
)
def test_permissao_de_escrever_e_de_decidir(
    app_cliente, contas, banco, perfil, abrir, decidir
):
    """Quem pede não é quem decide, e o RBAC é que sustenta a RN-28 na tela.

    Uma permissão única de "operar requisição" tornaria a regra indefensável:
    todo mundo que pede poderia decidir, e o bloqueio viraria uma comparação
    solitária dentro de um serviço, sem nada no RBAC que a sustentasse.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.get("/sair")

    entrar(app_cliente, contas, perfil)
    assert _abrir(app_cliente, cenario).status_code == abrir
    assert (
        app_cliente.post(
            f"{FILA}/{requisicao_id}/analise", follow_redirects=False
        ).status_code
        == decidir
    )


def test_o_menu_oferece_a_fila_e_esconde_o_formulario_de_quem_nao_pede(
    app_cliente, contas, banco
):
    """`test_link_no_menu_sempre_abre` cobre a igualdade; este diz o caso concreto.

    O almoxarife é o perfil que expõe o erro: ele opera o módulo inteiro sem ter
    `processo.ver`, então um item declarado com a permissão errada some (ou
    aparece trancado) só para ele.
    """
    entrar(app_cliente, contas, "almoxarife_sesmt")
    mapa = app_cliente.get("/modulos").text
    assert f'href="{FILA}"' in mapa
    assert f'href="{NOVA}"' not in mapa


# =====================================================================
# 2. O caminho inteiro, pela tela
# =====================================================================
def test_do_rascunho_a_entrega_o_pedido_atravessa_o_sistema(app_cliente, contas, banco):
    """O fluxo completo — e cada asserção é um fato que o e-mail não produzia."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")

    assert _abrir(app_cliente, cenario).status_code == 303
    requisicao = _requisicoes()[-1]
    # rascunho não gasta protocolo (RN-03)
    assert requisicao.protocolo is None
    assert requisicao.estado == "RASCUNHO"

    assert _acrescentar(app_cliente, requisicao.id, cenario).status_code == 303
    enviada = app_cliente.post(f"{FILA}/{requisicao.id}/enviar", follow_redirects=False)
    assert enviada.status_code == 303
    assert "EPI-" in _recado(enviada)

    requisicao = _requisicoes()[-1]
    assert requisicao.estado == "ENVIADA"
    assert requisicao.protocolo == f"EPI-{HOJE.year}-0001"
    # a lotação ficou congelada no envio (RN-15)
    assert requisicao.unidade_uorg_id == cenario["unidade"]
    assert requisicao.cargo_snapshot

    assert (
        app_cliente.post(f"{FILA}/{requisicao.id}/analise", follow_redirects=False)
    ).status_code == 303
    linha = _linhas(requisicao.id)[0]
    aprovada = app_cliente.post(
        f"{FILA}/{requisicao.id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1", "justificativa": "", "autorizar_excesso": ""},
        follow_redirects=False,
    )
    assert aprovada.status_code == 303, _recado(aprovada)
    assert app_cliente.post(
        f"{FILA}/{requisicao.id}/concluir",
        data={"parecer": "Exposição compatível com o posto."},
        follow_redirects=False,
    ).status_code == 303
    assert _requisicoes()[-1].estado == "ANALISADA"

    entregue = app_cliente.post(
        f"{FILA}/{requisicao.id}/itens/{linha.id}/entregar",
        data={
            "entrada_id": str(cenario["entrada"]),
            "quantidade": "1",
            "observacao": "",
        },
        follow_redirects=False,
    )
    assert entregue.status_code == 303, _recado(entregue)
    assert "comprovante" in _recado(entregue)

    # `EM_ATENDIMENTO` e `ATENDIDA` chegam sozinhas — ninguém clicou nelas
    assert _requisicoes()[-1].estado == "ATENDIDA"
    assert _linhas(requisicao.id)[0].estado == "ENTREGUE"


def test_a_tela_nao_oferece_botao_para_os_estados_do_sistema(app_cliente, contas, banco):
    """`EM_ATENDIMENTO` e `ATENDIDA` são do sistema, e a tela diz isso.

    Um botão para elas produziria o defeito que o §4.1 do desenho aponta em
    "liberada": um estado que a tela mostra e que não corresponde a fato nenhum.
    """
    import re

    cenario = _cenario(quantidade_maxima=None)
    entrar(app_cliente, contas, "coordenador_csso")
    _abrir(app_cliente, cenario)
    requisicao_id = _requisicoes()[-1].id
    _acrescentar(app_cliente, requisicao_id, cenario, quantidade="2")
    app_cliente.post(f"{FILA}/{requisicao_id}/enviar", follow_redirects=False)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "2"},
        follow_redirects=False,
    )
    app_cliente.post(
        f"{FILA}/{requisicao_id}/concluir", data={"parecer": ""}, follow_redirects=False
    )
    # entrega PARCIAL: o envelope entra em EM_ATENDIMENTO sozinho e ainda deve
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/entregar",
        data={"entrada_id": str(cenario["entrada"]), "quantidade": "1"},
        follow_redirects=False,
    )
    assert _requisicoes()[-1].estado == "EM_ATENDIMENTO"

    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    acoes = set(re.findall(r'action="(/epis/requisicoes/[^"]*)"', corpo))
    assert acoes, "a tela de um pedido em atendimento tem de oferecer a entrega"
    assert not [a for a in acoes if "atend" in a], acoes
    assert "Este estado é do sistema, não de um botão." in corpo


# =====================================================================
# 3. RN-28 — o 403 com a mensagem inteira
# =====================================================================
def test_rn28_a_tela_nega_a_autoanalise_e_mostra_as_duas_saidas(
    app_cliente, contas, banco
):
    """403 na tela, e a mensagem chega **inteira**.

    Ela cita as duas saídas legítimas: outra pessoa com `epi.analisar`, ou a
    entrega avulsa de balcão. Erro que só nega, sem dizer o caminho, é o que faz
    a pessoa contornar o sistema por fora — e o contorno por fora é o estado do
    mundo que este módulo veio consertar.
    """
    cenario = _cenario()
    _amarrar_conta_ao_servidor("coordenador_csso", cenario["servidor"])
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)

    negado = app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    assert negado.status_code == 403
    corpo = negado.text
    assert "RN-28" in corpo
    assert "epi.analisar" in corpo
    assert "/epis/entregas/nova" in corpo
    assert "outra pessoa com a permissão de analisar EPI" in corpo
    # o pedido não se moveu: bloqueio duro é bloqueio duro
    assert _requisicoes()[-1].estado == "ENVIADA"


def test_rn28_vale_em_toda_operacao_de_decisao_e_nao_so_ao_pegar_o_pedido(
    app_cliente, contas, banco
):
    """Aprovar, recusar, concluir, indeferir e reconsiderar caem no mesmo bloqueio.

    Espalhar a comparação por sete rotas seria espalhar sete chances de esquecê-la
    em uma — e a que fosse esquecida seria a porta.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    assert app_cliente.post(
        f"{FILA}/{requisicao_id}/analise", follow_redirects=False
    ).status_code == 303
    linha = _linhas(requisicao_id)[0]

    # só AGORA a conta vira a titular do pedido: a análise já estava aberta
    _amarrar_conta_ao_servidor("coordenador_csso", cenario["servidor"])
    for caminho, dados in (
        (f"/itens/{linha.id}/aprovar", {"quantidade_aprovada": "1"}),
        (f"/itens/{linha.id}/recusar", {"motivo_id": str(_motivo())}),
        ("/concluir", {"parecer": ""}),
        ("/indeferir", {"motivo_id": str(_motivo())}),
        ("/devolver", {"motivo": "não é meu caso"}),
    ):
        resposta = app_cliente.post(
            f"{FILA}/{requisicao_id}{caminho}", data=dados, follow_redirects=False
        )
        assert resposta.status_code == 403, caminho
        assert "RN-28" in resposta.text, caminho


def test_a_rn28_nao_trava_o_trabalho_porque_o_balcao_continua_aberto(
    app_cliente, contas, banco
):
    """A afirmação da mensagem é verdadeira, e é este teste que a sustenta.

    Se a saída indicada não funcionasse, a mensagem seria consolo — e a pessoa
    resolveria por fora do sistema do mesmo jeito.
    """
    cenario = _cenario()
    _amarrar_conta_ao_servidor("coordenador_csso", cenario["servidor"])
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/epis/entregas/nova").status_code == 200
    entrega = app_cliente.post(
        ENTREGAS,
        data={
            "servidor_id": str(cenario["servidor"]),
            "item_id": str(cenario["item"]),
            "quantidade": "1",
            "entrada_id": str(cenario["entrada"]),
            "tamanho": "M",
            "data_evento": HOJE.isoformat(),
            "observacao": "",
            "justificativa_excecao": "",
        },
        follow_redirects=False,
    )
    assert entrega.status_code == 303, _recado(entrega)


# =====================================================================
# 4. RN-26 — o bloqueio com caminho de reenvio na própria tela
# =====================================================================
def test_rn26_a_tela_bloqueia_o_excesso_e_oferece_a_autorizacao(
    app_cliente, contas, banco
):
    """Primeiro o bloqueio com o motivo; depois o reenvio que resolve.

    O bloqueio não é duro: sem a caixa de autorização e a justificativa no MESMO
    formulário, o analista fica preso no erro. E o formulário diz por escrito que
    quem marca a caixa assume o nome — a exceção fica registrada com ele.
    """
    cenario = _cenario(quantidade_maxima=1, periodo_maximo_meses=12)
    entrar(app_cliente, contas, "coordenador_csso")
    # a ficha já registra uma entrega na janela: é a FICHA que a RN-26 conta,
    # e não requisições aprovadas — aprovação é promessa, entrega é fato
    app_cliente.post(
        ENTREGAS,
        data={
            "servidor_id": str(cenario["servidor"]),
            "item_id": str(cenario["item"]),
            "quantidade": "1",
            "entrada_id": str(cenario["entrada"]),
            "tamanho": "M",
            "data_evento": HOJE.isoformat(),
            "observacao": "",
            "justificativa_excecao": "",
        },
        follow_redirects=False,
    )

    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]

    bloqueada = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1", "justificativa": "", "autorizar_excesso": ""},
        follow_redirects=False,
    )
    assert bloqueada.status_code == 303
    recado = _recado(bloqueada)
    assert "erro=" in recado
    assert "autorize a exceção" in recado
    assert _linhas(requisicao_id)[0].estado == "SOLICITADO"

    # marcar sem escrever a justificativa continua barrado: é a justificativa
    # que sustenta a decisão de quem a assinou
    sem_texto = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1", "justificativa": "", "autorizar_excesso": "1"},
        follow_redirects=False,
    )
    assert "justificativa por escrito" in _recado(sem_texto)

    # o reenvio que resolve — e é ele que a tela precisa oferecer
    autorizada = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={
            "quantidade_aprovada": "1",
            "justificativa": "A primeira luva foi perfurada por respingo de ácido.",
            "autorizar_excesso": "1",
        },
        follow_redirects=False,
    )
    assert autorizada.status_code == 303
    assert "seu nome" in _recado(autorizada)
    decidida = _linhas(requisicao_id)[0]
    assert decidida.estado == "APROVADO"
    assert decidida.excedeu_maximo is True
    assert decidida.autorizado_por is not None


def test_a_tela_de_analise_traz_a_caixa_de_autorizacao_antes_de_qualquer_erro(
    app_cliente, contas, banco
):
    """O caminho de saída não pode aparecer só depois de a pessoa bater no erro."""
    cenario = _cenario(quantidade_maxima=1, periodo_maximo_meses=12)
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)

    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert 'name="autorizar_excesso"' in corpo
    assert "1 por 12 meses" in corpo
    assert "com o seu nome" in corpo


# =====================================================================
# 5. A fila: filtro, contagem e a busca que recusa CPF
# =====================================================================
def test_a_fila_filtra_por_estado_e_conta_cada_um(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    enviado = _pedido_enviado(app_cliente, cenario)
    _abrir(app_cliente, cenario)  # um rascunho, que fica de fora do filtro
    rascunho = _requisicoes()[-1].id

    todos = app_cliente.get(FILA)
    assert todos.status_code == 200
    assert f'href="/epis/requisicoes/{enviado}"' in todos.text
    assert f'href="/epis/requisicoes/{rascunho}"' in todos.text

    so_enviadas = app_cliente.get(f"{FILA}?estado=ENVIADA").text
    assert f'href="/epis/requisicoes/{enviado}"' in so_enviadas
    assert f'href="/epis/requisicoes/{rascunho}"' not in so_enviadas


def test_a_busca_da_fila_acha_pelo_protocolo_pelo_siape_e_pelo_email(
    app_cliente, contas, banco
):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    protocolo = _requisicoes()[-1].protocolo

    for termo in (protocolo, "7654321", "Joana", "joana.almeida@ufvjm.edu.br"):
        corpo = app_cliente.get(f"{FILA}?q={termo}").text
        assert f'href="/epis/requisicoes/{requisicao_id}"' in corpo, termo

    vazio = app_cliente.get(f"{FILA}?q=Fulano de Tal").text
    assert f'href="/epis/requisicoes/{requisicao_id}"' not in vazio


def test_a_busca_nao_aceita_cpf_e_diz_por_que(app_cliente, contas, banco):
    """Não há coluna de CPF em lugar nenhum do módulo (decisão 1).

    Responder "nada encontrado" faria a pessoa concluir que o pedido não existe,
    quando o que não existe é a busca — e ela iria procurar o número em outro
    lugar, que é justamente a planilha que este módulo veio substituir.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)

    for cpf in ("12345678909", "123.456.789-09"):
        corpo = app_cliente.get(f"{FILA}?q={cpf}").text
        assert "não armazena CPF" in corpo, cpf
        assert f'href="/epis/requisicoes/{requisicao_id}"' not in corpo, cpf


def test_a_busca_por_nome_nao_vira_oraculo_para_quem_nao_ve_nome(
    app_cliente, contas, banco
):
    """RN-19: a fila suprime a identificação, e o filtro não pode devolvê-la.

    Digitar o nome e receber UMA linha amarraria o nome ao código `SRV-xxxx` da
    sessão — a ligação exata que a supressão existe para impedir. O SIAPE
    continua achando, porque é a chave que a tela declara.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.get("/sair")

    entrar(app_cliente, contas, "secretaria_csso")
    lista = app_cliente.get(FILA).text
    assert "Joana Ribeiro de Almeida" not in lista

    por_nome = app_cliente.get(f"{FILA}?q=Joana").text
    assert f'href="/epis/requisicoes/{requisicao_id}"' not in por_nome
    por_siape = app_cliente.get(f"{FILA}?q=7654321").text
    assert f'href="/epis/requisicoes/{requisicao_id}"' in por_siape
    assert "Joana Ribeiro de Almeida" not in por_siape


# =====================================================================
# 6. A recusa é um seletor, e o texto sai congelado
# =====================================================================
def test_a_recusa_vem_do_catalogo_com_o_texto_visivel_antes_da_escolha(
    app_cliente, contas, banco
):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)

    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert 'class="seletor-motivo"' in corpo
    # o texto que vai sair para o requerente viaja com a opção: a tela mostra a
    # negativa ANTES de alguém clicar, e não depois de ela já ter saído
    assert "data-texto=" in corpo
    assert "data-exige=" in corpo


def test_a_recusa_congela_o_texto_e_ele_aparece_na_ficha_do_pedido(
    app_cliente, contas, banco
):
    """RN-27: a negativa que a pessoa recebeu é a que fica, na tela e no banco."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]

    recusada = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/recusar",
        data={"motivo_id": str(_motivo()), "complemento": ""},
        follow_redirects=False,
    )
    assert recusada.status_code == 303, _recado(recusada)
    decidida = _linhas(requisicao_id)[0]
    assert decidida.estado == "RECUSADO"
    assert decidida.texto_recusa_snapshot

    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert decidida.texto_recusa_snapshot[:40] in corpo
    assert "SEM_EXPOSICAO" in corpo


def test_recusar_sem_motivo_do_catalogo_e_barrado_com_a_razao_escrita(
    app_cliente, contas, banco
):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]

    resposta = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/recusar",
        data={"motivo_id": "", "complemento": ""},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "RN-27" in _recado(resposta)
    assert _linhas(requisicao_id)[0].estado == "SOLICITADO"


# =====================================================================
# 7. Só RASCUNHO é editável
# =====================================================================
def test_editar_e_acrescentar_item_so_existem_no_rascunho(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _abrir(app_cliente, cenario)
    requisicao_id = _requisicoes()[-1].id

    rascunho = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert 'id="novo-item"' in rascunho
    assert f'action="{FILA}/{requisicao_id}/excluir"' in rascunho

    _acrescentar(app_cliente, requisicao_id, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/enviar", follow_redirects=False)

    enviado = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert 'id="novo-item"' not in enviado
    assert f'action="{FILA}/{requisicao_id}/excluir"' not in enviado

    # e a rota também recusa, porque esconder botão não é controle.
    # 200 e não 303: acrescentar item passou a redesenhar a ficha com o digitado
    # de volta (o padrão `digitado` de `processos.criar`), porque quantidade,
    # tamanho e a justificativa da RN-29 chegam pelo fragmento `#opcoes-do-item`
    # e o redirect os apagava. O que o teste guarda é a recusa: o motivo chega à
    # tela e nada foi gravado.
    bloqueado = _acrescentar(app_cliente, requisicao_id, cenario, tamanho="G")
    assert bloqueado.status_code == 200
    assert "rascunho" in _recado(bloqueado)
    assert len(_linhas(requisicao_id)) == 1


def test_excluir_rascunho_nao_fica_colado_em_enviar_pedido(app_cliente, contas, banco):
    """A única exclusão física do sistema estava a um clique, no mesmo cartão de
    "Enviar pedido" e a um parágrafo de distância dele.

    Um protocola o pedido, o outro o destrói. Agora o cartão do trâmite oferece
    um LINK — o padrão de `certificado_ficha.html:12-15` —, e o formulário mora
    numa confirmação que conta o que vai sumir.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _abrir(app_cliente, cenario)
    requisicao_id = _requisicoes()[-1].id
    _acrescentar(app_cliente, requisicao_id, cenario)

    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert 'href="#excluir-rascunho"' in corpo, "o botão do trâmite ainda apaga direto"
    assert 'id="excluir-rascunho"' in corpo

    # a confirmação diz o QUE some, e quanto: "tem certeza?" sem conteúdo
    # ensina a clicar em sim sem ler
    assert "1 linha(s) de item" in corpo
    assert "a rotina de trabalho e os riscos declarados" in corpo

    # e o `<form>` que apaga existe uma vez só, DENTRO da confirmação — não no
    # cartão do trâmite, logo abaixo do botão que protocola
    acao = f'action="{FILA}/{requisicao_id}/excluir"'
    assert corpo.count(acao) == 1
    assert corpo.index("Enviar pedido") < corpo.index('id="excluir-rascunho"')
    assert corpo.index('id="excluir-rascunho"') < corpo.index(acao)


def test_excluir_rascunho_some_com_o_pedido_e_deixa_o_evento(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _abrir(app_cliente, cenario)
    requisicao_id = _requisicoes()[-1].id

    resposta = app_cliente.post(
        f"{FILA}/{requisicao_id}/excluir", follow_redirects=False
    )
    assert resposta.status_code == 303
    assert not _requisicoes()
    assert "trilha" in _recado(resposta)


# =====================================================================
# 8. RN-25 na tela da entrega: etiqueta vermelha e motivo escrito
# =====================================================================
def test_lote_com_ca_vencido_aparece_marcado_e_com_o_motivo_ao_lado(
    app_cliente, contas, banco
):
    """O lote vencido NÃO some da tela: some da entrega.

    Botão que desaparece sem explicação faz quem opera procurar defeito no
    sistema em vez de resolver o problema do lote.
    """
    cenario = _cenario()
    _lote_vencido(cenario)
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1"},
        follow_redirects=False,
    )
    app_cliente.post(
        f"{FILA}/{requisicao_id}/concluir", data={"parecer": ""}, follow_redirects=False
    )

    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert "L-2023-01" in corpo
    assert "INDISPONÍVEL" in corpo
    assert "venceu em" in corpo
    assert "CA vencido" in corpo


def test_o_lote_candidato_aparece_ao_lado_do_item_para_quem_so_le(
    app_cliente, contas, banco
):
    """§9: saldo e CA do lote candidato ao lado do item, e não só para quem entrega.

    É a diferença entre uma aprovação que vira equipamento na mão da pessoa e uma
    que vai ficar esperando compra — e quem analisou precisa disso tanto quanto
    quem separa a caixa. Saldo de bota não nomeia ninguém.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1"},
        follow_redirects=False,
    )
    app_cliente.get("/sair")

    # o auditor lê o módulo e não entrega nada
    entrar(app_cliente, contas, "auditor_interno")
    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert "L-2026-08" in corpo
    assert "CA 41234" in corpo
    assert "disponível" in corpo
    # e continua sem o formulário de entregar
    assert f"/itens/{linha.id}/entregar" not in corpo


def test_entregar_de_lote_vencido_e_recusado_com_o_motivo_escrito(
    app_cliente, contas, banco
):
    cenario = _cenario()
    vencido = _lote_vencido(cenario)
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1"},
        follow_redirects=False,
    )
    app_cliente.post(
        f"{FILA}/{requisicao_id}/concluir", data={"parecer": ""}, follow_redirects=False
    )

    resposta = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/entregar",
        data={"entrada_id": str(vencido), "quantidade": "1", "observacao": ""},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "venceu em" in _recado(resposta)
    assert _linhas(requisicao_id)[0].estado == "APROVADO"


# =====================================================================
# 9. Os três lugares de HTMX, e a guia
# =====================================================================
def test_os_fragmentos_htmx_respondem_e_exigem_a_permissao_de_pedir(
    app_cliente, contas, banco
):
    cenario = _cenario(exige_justificativa=True)
    entrar(app_cliente, contas, "coordenador_csso")

    servidores = app_cliente.get(f"{FILA}/servidores?q=7654321")
    assert servidores.status_code == 200
    assert "SIAPE 7654321" in servidores.text

    opcoes = app_cliente.get(f"{FILA}/item-opcoes?item_id={cenario['item']}")
    assert opcoes.status_code == 200
    # RN-29: a justificativa aparece no ato da escolha, e não no envio
    assert "obrigatória para este item" in opcoes.text

    saldo = app_cliente.get(f"{FILA}/item-saldo?item_id={cenario['item']}&tamanho=M")
    assert saldo.status_code == 200
    assert "L-2026-08" in saldo.text
    assert "não reserva nada" in saldo.text

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "almoxarife_sesmt")
    for caminho in ("servidores", "item-opcoes", "item-saldo"):
        assert app_cliente.get(f"{FILA}/{caminho}").status_code == 403, caminho


def test_a_guia_de_entrega_sai_do_congelado(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/recusar",
        data={"motivo_id": str(_motivo()), "complemento": ""},
        follow_redirects=False,
    )

    guia = app_cliente.get(f"{FILA}/{requisicao_id}/guia")
    assert guia.status_code == 200
    assert _requisicoes()[-1].protocolo in guia.text
    assert _linhas(requisicao_id)[0].texto_recusa_snapshot[:40] in guia.text
    # a guia não é a prova de entrega, e ela diz isso
    assert "não é a prova de entrega" in guia.text


def test_a_guia_abre_para_quem_so_le(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.get("/sair")

    entrar(app_cliente, contas, "auditor_interno")
    assert app_cliente.get(f"{FILA}/{requisicao_id}").status_code == 200
    assert app_cliente.get(f"{FILA}/{requisicao_id}/guia").status_code == 200
    app_cliente.get("/sair")

    entrar(app_cliente, contas, "admin_ti")
    assert app_cliente.get(f"{FILA}/{requisicao_id}").status_code == 403
    assert app_cliente.get(f"{FILA}/{requisicao_id}/guia").status_code == 403


# =====================================================================
# 10. A trilha embaixo da ficha
# =====================================================================
def test_a_ficha_mostra_as_duas_maquinas_na_mesma_linha_do_tempo(
    app_cliente, contas, banco
):
    """Duas máquinas, uma história.

    Separar as trilhas obrigaria quem lê a intercalar duas listas de cabeça para
    responder "o que aconteceu com este pedido", que é a única pergunta que se
    faz nesta tela.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/recusar",
        data={"motivo_id": str(_motivo()), "complemento": ""},
        follow_redirects=False,
    )

    from app.servicos.auditoria import ROTULO_EVENTO

    corpo = app_cliente.get(f"{FILA}/{requisicao_id}").text
    # Os quatro eventos continuam na mesma lista; o que mudou é a língua em que
    # eles se apresentam. `tipo_evento` é chave — entra no digest encadeado — e
    # por isso não muda; quem muda é a tela, que passou a escrever o rótulo de
    # `ROTULO_EVENTO`. Exigir os dois lados (o rótulo presente E o código fora)
    # é o que impede tanto a regressão do código cru quanto um rótulo que
    # apareça sem o evento por trás.
    for codigo in (
        "EPI_REQUISICAO_CRIADA",
        "EPI_REQUISICAO_ENVIADA",
        "EPI_REQUISICAO_EM_ANALISE",
        "EPI_ITEM_RECUSADO",
    ):
        assert ROTULO_EVENTO[codigo] in corpo, codigo
        assert codigo not in corpo, f"{codigo} cru voltou para a trilha"


# =====================================================================
# 11. A recusa dentro do rascunho não apaga o que foi digitado
#
# Os três formulários do rascunho — cabeçalho, acrescentar item e editar a
# linha — recusavam com `RedirectResponse`, e a recusa faz `rollback`: o GET
# seguinte relia o banco e reescrevia na tela a versão ANTERIOR ao que a pessoa
# tinha acabado de escrever. Para os dois textos longos do cabeçalho isso é o
# custo que `epis_requisicao_nova.html` já nomeia; para o cartão de acrescentar
# é pior, porque quantidade, tamanho e a justificativa da RN-29 nem existem no
# HTML da página — chegam pelo fragmento `#opcoes-do-item`, e o redirect voltava
# com "escolha o equipamento" e o equipamento já escolhido no seletor acima.
# =====================================================================
ROTINA_LONGA = (
    "Transferência diária de ácido sulfúrico concentrado entre frascos de 20 L "
    "na capela 3 do bloco B, das 8h às 12h, com apoio de bomba peristáltica."
)
RISCOS_LONGOS = (
    "Respingo de ácido em face e antebraço, vapor ácido na zona respiratória e "
    "contato dérmico durante a troca de mangueira."
)


def _valor(corpo: str, campo: str) -> str | None:
    achado = re.search(
        rf'<(?:input|textarea)[^>]*\bname="{campo}"[^>]*>', corpo
    )
    if achado is None:
        return None
    valor = re.search(r'\bvalue="([^"]*)"', achado.group(0))
    return valor.group(1) if valor else None


def test_rascunho_recusado_devolve_os_dois_textos_longos(app_cliente, contas, banco):
    """A recusa é de UM campo; os outros seis não têm por que ser apagados."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _abrir(app_cliente, cenario)
    requisicao_id = _requisicoes()[-1].id

    recusada = app_cliente.post(
        f"{FILA}/{requisicao_id}",
        data={
            "chefia_servidor_id": "",
            "finalidade": "ROTINA",
            "urgencia": "URGENTE",
            # é ESTE campo que a RN-21 recusa; os dois longos estão limpos
            "justificativa_urgencia": "reposição pedida no atestado médico",
            "descricao_atividade": ROTINA_LONGA,
            "riscos_declarados": RISCOS_LONGOS,
        },
        follow_redirects=False,
    )
    assert recusada.status_code == 200, "voltou a redirecionar e a perder o texto"
    corpo = recusada.text
    assert 'class="aviso aviso-erro"' in corpo
    assert ROTINA_LONGA in corpo, "a rotina de trabalho foi apagada pela recusa"
    assert RISCOS_LONGOS in corpo, "os riscos declarados foram apagados pela recusa"
    # a urgência escolhida também volta: perdê-la faria a justificativa que a
    # tela exige deixar de fazer sentido na segunda tentativa
    assert re.search(r'<option value="URGENTE"[^>]*\bselected\b', corpo)
    # e nada foi gravado
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        gravada = s.get(EpiRequisicao, requisicao_id)
        assert gravada.descricao_atividade != ROTINA_LONGA


def test_acrescentar_item_recusado_devolve_o_bloco_do_item_inteiro(
    app_cliente, contas, banco
):
    """O caso em que o redirect era pior: os três campos vêm de um fragmento.

    Quantidade, tamanho e justificativa não estão no HTML que o navegador
    carregou — o HTMX os traz quando o item muda. Sem montar o mesmo fragmento
    no servidor, a recusa devolvia um cartão em branco com o item escolhido.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _abrir(app_cliente, cenario)
    requisicao_id = _requisicoes()[-1].id

    recusado = _acrescentar(
        app_cliente,
        requisicao_id,
        cenario,
        quantidade="3",
        justificativa="uso exigido pelo atestado médico da chefia",
    )
    assert recusado.status_code == 200
    corpo = recusado.text
    assert "termo proibido" in corpo
    assert re.search(rf'<option value="{cenario["item"]}"[^>]*\bselected\b', corpo), (
        "o equipamento escolhido voltou a ser esquecido"
    )
    assert _valor(corpo, "quantidade") == "3"
    assert "uso exigido pelo atestado médico da chefia" in corpo
    assert re.search(r'<option value="M"[^>]*\bselected\b', corpo)
    assert _linhas(requisicao_id) == []


def test_editar_linha_recusada_volta_na_propria_linha_e_de_gaveta_aberta(
    app_cliente, contas, banco
):
    """A forma do `digitado` carrega o id da linha, e a gaveta dela abre.

    Sem o id, o texto recusado de uma linha apareceria dentro de todas as
    outras; sem abrir a gaveta, ele voltaria para dentro de uma gaveta fechada —
    o motivo no topo da tela e a correção escondida embaixo.

    A GAVETA MUDOU DE ELEMENTO, E O INVARIANTE E O MESMO. Ate a 1.28.x ela era
    `<details class="acoes-linha">`, aberta na propria celula; passou a ser a
    camada de `ui.popup_gaveta`, porque nove formularios com rotulo, dica e
    paragrafo nao cabem nos ~190px da ultima coluna da tabela. O que este teste
    guarda nao e o elemento: e que EXATAMENTE UMA gaveta volte aberta, a da linha
    que foi recusada. O atributo que a abre continua sendo `open`, escrito pelo
    servidor a partir do mesmo `digitado.forma`, e continua funcionando sem
    JavaScript — com ele, `base.html` o promove a `showModal()`.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _abrir(app_cliente, cenario)
    requisicao_id = _requisicoes()[-1].id
    _acrescentar(app_cliente, requisicao_id, cenario)
    _acrescentar(app_cliente, requisicao_id, cenario, tamanho="G")
    primeira, segunda = _linhas(requisicao_id)

    texto = "troca por desgaste conforme atestado médico"
    recusada = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{segunda.id}",
        data={"quantidade": "4", "tamanho": "G", "justificativa": texto},
        follow_redirects=False,
    )
    assert recusada.status_code == 200
    corpo = recusada.text
    assert texto in corpo, "a justificativa recusada foi apagada"
    # dentro da linha certa, e só dela
    assert corpo.count(texto) == 1
    assert re.search(
        rf'id="j-{segunda.id}"[^>]*>[^<]*{re.escape(texto)}', corpo
    ), "o texto voltou fora do campo da linha que o recebeu"
    assert f'id="j-{primeira.id}"' in corpo  # a outra linha continua na tela
    # a gaveta da linha recusada abre; a da outra não
    gavetas = re.findall(r'<dialog class="popup popup-gaveta"[^>]*>', corpo)
    assert len(gavetas) == 2, f"uma gaveta por linha, e sao duas linhas: {gavetas}"
    abertas = [g for g in gavetas if " open>" in g]
    assert len(abertas) == 1, f"exatamente a gaveta da linha recusada: {gavetas}"
    assert f'id="acoes-item-{segunda.id}"' in abertas[0], (
        "abriu a gaveta da linha errada"
    )
    # e a quantidade não foi gravada
    assert _linhas(requisicao_id)[1].quantidade_solicitada == segunda.quantidade_solicitada


# =====================================================================
# A troca parcial da lista de itens — dez itens sem dez recargas
# =====================================================================
def test_decidir_item_por_htmx_devolve_a_secao_e_nao_a_pagina(app_cliente, contas, banco):
    """Aprovar um item nao recarrega a ficha inteira.

    E o alvo e a SECAO, e nao a linha: a pilula "N sem decisao" do cabecalho
    conta as linhas pendentes, e trocar so a `<tr>` a deixaria mentindo ao lado
    da decisao que acabou de ser tomada.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    assert app_cliente.post(
        f"{FILA}/{requisicao_id}/analise", follow_redirects=False
    ).status_code == 303
    linha = _linhas(requisicao_id)[0]

    resposta = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1"},
        headers={"HX-Request": "true"},
        follow_redirects=False,
    )
    assert resposta.status_code == 200, resposta.text
    corpo = resposta.text
    # o MIOLO da secao, e nao a secao: a `<section id="itens-do-pedido">` fica no
    # template da pagina, e o `hx-swap` e `innerHTML` — com `outerHTML` o
    # tratador global realca um no que a troca ja desligou do documento
    assert "<html" not in corpo, "voltou a pagina inteira em vez da secao"
    assert "Itens do pedido" in corpo and "<table>" in corpo
    # o cabecalho veio recalculado: nao ha mais linha sem decisao
    assert "sem decisão" not in corpo
    assert _linhas(requisicao_id)[0].estado == "APROVADO"


def test_sem_htmx_decidir_item_continua_respondendo_303(app_cliente, contas, banco):
    """O `<form method=post>` continua sendo um form: sem JavaScript nada muda."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    resposta = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert _linhas(requisicao_id)[0].estado == "APROVADO"


def test_a_recusa_de_regra_por_htmx_volta_em_200_com_o_motivo(app_cliente, contas, banco):
    """Recusar sem motivo do catalogo nao e falha de rede.

    Em 4xx o tratador global de `base.html` escreveria "nao deu para atualizar
    este trecho" por cima do texto que diz o que fazer a seguir.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    resposta = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/recusar",
        data={"motivo_id": ""},
        headers={"HX-Request": "true"},
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    assert "RN-27" in resposta.text
    assert "Itens do pedido" in resposta.text
    assert _linhas(requisicao_id)[0].estado == "SOLICITADO"


def test_a_entrega_continua_recarregando_a_pagina_de_proposito(app_cliente, contas, banco):
    """Entregar muda o estado do PEDIDO, escreve na trilha e abre pendencia.

    As tres coisas moram fora da secao dos itens; trocar so a secao deixaria o
    cartao de tramite, a linha do tempo e o sino dizendo o de antes.
    """
    from app.config import RAIZ
    from pathlib import Path

    bruto = (Path(RAIZ) / "app" / "templates" / "partes" / "itens_do_pedido.html").read_text(
        encoding="utf-8"
    )
    # sem os comentarios, pelo mesmo motivo da guarda da RN-19: o comentario
    # acima da entrega EXPLICA por que ela nao tem `hx-post`, e a guarda casava
    # com a propria prosa que a descreve
    fonte = re.sub(r"\{#.*?#\}", "", bruto, flags=re.S)
    entregar = fonte[fonte.index("<h3>Entregar</h3>") - 400 : fonte.index("<h3>Entregar</h3>")]
    assert "hx-post" not in entregar, (
        "a entrega ganhou troca parcial; leia o comentario acima dela em "
        "partes/itens_do_pedido.html"
    )


# =====================================================================
# 13. O sino do requerente — a jornada que morria depois do protocolo
# =====================================================================
# A auditoria de ergonomia mediu a jornada do servidor comum e achou onde ela
# para: cinco ações da porta ao protocolo, e depois disso nada. O sino marcava
# ZERO ao enviar, zero depois de aprovado, zero depois de recusado, zero depois
# de reservado. O único toque em toda a jornada vinha DEPOIS da entrega, e era a
# tarefa de outra pessoa (o comprovante assinado, do coordenador). Para saber que
# o pedido tinha sido decidido a pessoa tinha de reabrir a fila por conta
# própria — um pedido com protocolo e prazo produzindo menos aviso do que o
# e-mail que ele veio substituir.
#
# Estes testes medem o sino nos mesmos quatro momentos, agora pela conta
# `servidor_consulta` amarrada ao servidor do pedido. Eles são a medição, e não
# só a garantia: quem mexer nos gatilhos vê o número mudar aqui.
SINO = re.compile(r"(\d+) pendência\(s\) aberta\(s\)")


def _sino(cliente) -> int:
    """O número que o sino do topo mostra para quem está logado agora."""
    resposta = cliente.get(FILA)
    assert resposta.status_code == 200, resposta.text[:400]
    achado = SINO.search(resposta.text)
    return int(achado.group(1)) if achado else 0


def _pedido_de_duas_linhas(cliente, cenario) -> int:
    """Protocolado com duas linhas — uma para aprovar, outra para recusar."""
    _abrir(cliente, cenario)
    requisicao_id = _requisicoes()[-1].id
    _acrescentar(cliente, requisicao_id, cenario, tamanho="M")
    _acrescentar(cliente, requisicao_id, cenario, tamanho="G")
    enviada = cliente.post(f"{FILA}/{requisicao_id}/enviar", follow_redirects=False)
    assert enviada.status_code == 303, _recado(enviada)
    return requisicao_id


def _decidir(cliente, requisicao_id, *, aprovar, recusar):
    cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    cliente.post(
        f"{FILA}/{requisicao_id}/itens/{aprovar}/aprovar",
        data={"quantidade_aprovada": "1", "justificativa": ""},
        follow_redirects=False,
    )
    cliente.post(
        f"{FILA}/{requisicao_id}/itens/{recusar}/recusar",
        data={"motivo_id": str(_motivo()), "complemento": ""},
        follow_redirects=False,
    )
    concluida = cliente.post(
        f"{FILA}/{requisicao_id}/concluir", data={"parecer": ""}, follow_redirects=False
    )
    assert concluida.status_code == 303, _recado(concluida)


def test_o_sino_do_requerente_toca_na_decisao_e_na_reserva(app_cliente, contas, banco):
    """Zero → 1 (decidido) → 2 (separado para retirada) → 0 (entregue).

    Os quatro momentos são os da auditoria, na mesma ordem. O que mudou é que
    três deles deixaram de ser zero — e o quarto continua zero de propósito: a
    entrega não abre aviso nenhum, porque a pessoa estava no balcão e assinou o
    comprovante. Avisar de um fato que o destinatário presenciou é ruído, e ruído
    faz parar de olhar o sino.
    """
    cenario = _cenario()
    _amarrar_conta_ao_servidor("servidor_consulta", cenario["servidor"])

    entrar(app_cliente, contas, "servidor_consulta")
    assert _sino(app_cliente) == 0, "sino sujo antes de a jornada começar"
    requisicao_id = _pedido_de_duas_linhas(app_cliente, cenario)
    assert _sino(app_cliente) == 0, (
        "enviar não abre tarefa: foi ele quem enviou, e a tela do envio já "
        "respondeu com o protocolo"
    )

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "tecnico_seguranca")
    linhas = _linhas(requisicao_id)
    _decidir(app_cliente, requisicao_id, aprovar=linhas[0].id, recusar=linhas[1].id)

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "servidor_consulta")
    assert _sino(app_cliente) == 1, "a decisão continua sem chegar a quem pediu"

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "tecnico_seguranca")
    reservada = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linhas[0].id}/reservar",
        data={"entrada_id": str(cenario["entrada"]), "quantidade": "1"},
        follow_redirects=False,
    )
    assert reservada.status_code == 303, _recado(reservada)

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "servidor_consulta")
    assert _sino(app_cliente) == 2, (
        "o item está separado com o nome dele e ninguém o chamou para buscar"
    )
    fila_de_tarefas = app_cliente.get("/pendencias").text
    assert "espera você retirar" in fila_de_tarefas
    # e a tarefa leva a algum lugar: a coluna "Onde" era texto puro, sem link
    # a âncora da fila carrega o caminho de volta (`?de=pendencias`)
    assert f'href="/epis/requisicoes/{requisicao_id}?de=pendencias"' in fila_de_tarefas

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "tecnico_seguranca")
    entregue = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linhas[0].id}/entregar",
        data={
            "entrada_id": str(cenario["entrada"]),
            "quantidade": "1",
            "observacao": "",
        },
        follow_redirects=False,
    )
    assert entregue.status_code == 303, _recado(entregue)

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "servidor_consulta")
    assert _sino(app_cliente) == 0, (
        "as duas tarefas do requerente têm de fechar sozinhas na entrega — "
        "tarefa que só o dono fecha à mão vira lista morta"
    )
    # a do comprovante assinado nasceu na entrega e é de quem entregou: ela não
    # pode aparecer no sino de quem não a executa (foi o defeito medido)
    assert "comprovante assinado" not in app_cliente.get("/pendencias").text


def test_o_aviso_do_requerente_nao_nomeia_ninguem_e_o_titular_o_le(
    app_cliente, contas, banco
):
    """RN-19 nos dois lados: a descrição nasce sem nome, e o dono a lê.

    A 1.35.0 passou a suprimir descrição de pendência na LEITURA porque a frase
    antiga nascia com nome e SIAPE dentro. Descrição nova não pode repetir aquilo
    — o pedido entra pelo protocolo, que já identifica sem nomear. E a supressão
    não pode acertar o titular junto com o terceiro: quem tem a tarefa no sino
    precisa conseguir ler o que ela diz, senão o aviso não é aviso.
    """
    cenario = _cenario()
    _amarrar_conta_ao_servidor("servidor_consulta", cenario["servidor"])
    entrar(app_cliente, contas, "servidor_consulta")
    requisicao_id = _pedido_de_duas_linhas(app_cliente, cenario)
    protocolo = _requisicoes()[-1].protocolo

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "tecnico_seguranca")
    linhas = _linhas(requisicao_id)
    _decidir(app_cliente, requisicao_id, aprovar=linhas[0].id, recusar=linhas[1].id)

    from app.modelos import Pendencia
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        aviso = s.execute(
            select(Pendencia).where(Pendencia.tipo == "EPI_DECISAO_A_LER")
        ).scalar_one()
        assert protocolo in aviso.descricao
        assert "Joana" not in aviso.descricao, "voltou a nascer com nome dentro"
        assert "7654321" not in aviso.descricao, "voltou a nascer com SIAPE dentro"

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "servidor_consulta")
    corpo = app_cliente.get("/pendencias").text
    assert protocolo in corpo, "o dono da tarefa lê 'conteúdo suprimido' sobre si"
    assert "conteúdo suprimido" not in corpo


def test_o_aviso_de_retirada_fecha_quando_a_reserva_e_solta(app_cliente, contas, banco):
    """A promessa se desfez: não há mais o que buscar, e o sino não pode chamar.

    É a mesma ida e volta de `EPI_SEM_ESTOQUE`, do outro lado: lá o item volta a
    esperar estoque e a tarefa do almoxarifado reabre; aqui a tarefa do
    requerente fecha, porque o que ela mandava fazer deixou de existir.
    """
    cenario = _cenario()
    _amarrar_conta_ao_servidor("servidor_consulta", cenario["servidor"])
    entrar(app_cliente, contas, "servidor_consulta")
    requisicao_id = _pedido_de_duas_linhas(app_cliente, cenario)

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "tecnico_seguranca")
    linhas = _linhas(requisicao_id)
    _decidir(app_cliente, requisicao_id, aprovar=linhas[0].id, recusar=linhas[1].id)
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linhas[0].id}/reservar",
        data={"entrada_id": str(cenario["entrada"]), "quantidade": "1"},
        follow_redirects=False,
    )
    solta = app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linhas[0].id}/soltar-reserva",
        data={"motivo": "lote descartado por avaria no transporte"},
        follow_redirects=False,
    )
    assert solta.status_code == 303, _recado(solta)

    from app import banco as mod_banco
    from app.modelos import Pendencia

    with mod_banco.sessao() as s:
        retirada = s.execute(
            select(Pendencia).where(Pendencia.tipo == "EPI_RETIRADA_DISPONIVEL")
        ).scalar_one()
        assert retirada.concluida, "o sino continua chamando para buscar o que sumiu"

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "servidor_consulta")
    # sobra a de ler a decisão: o pedido não terminou. A de retirada desceu para
    # "concluídas recentemente", que é onde a conclusão se lê.
    assert _sino(app_cliente) == 1


def test_o_indeferimento_chega_a_quem_pediu(app_cliente, contas, banco):
    """Negativa total é o desfecho que mais precisa ser lido, e o único terminal."""
    cenario = _cenario()
    _amarrar_conta_ao_servidor("servidor_consulta", cenario["servidor"])
    entrar(app_cliente, contas, "servidor_consulta")
    requisicao_id = _pedido_enviado(app_cliente, cenario)

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "tecnico_seguranca")
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/recusar",
        data={"motivo_id": str(_motivo()), "complemento": ""},
        follow_redirects=False,
    )
    indeferida = app_cliente.post(
        f"{FILA}/{requisicao_id}/indeferir",
        data={"motivo_id": str(_motivo()), "complemento": "", "parecer": ""},
        follow_redirects=False,
    )
    assert indeferida.status_code == 303, _recado(indeferida)

    app_cliente.get("/sair")
    entrar(app_cliente, contas, "servidor_consulta")
    assert _sino(app_cliente) == 1
    assert "foi indeferido" in app_cliente.get("/pendencias").text


def test_a_ficha_diz_onde_retirar_ou_diz_que_nao_sabe(app_cliente, contas, banco):
    """O estado RESERVADO dizia o lote e o CA, e não dizia a que porta ir.

    O sistema não sabia responder: não há coluna de localização em lote nenhum, e
    o endereço do setor emissor é o de quem assina parecer, não o do balcão.
    Virou parâmetro de instalação — e vazio a tela diz que não sabe, em vez de
    mandar a pessoa a um endereço inventado.
    """
    from app.config import obter_config

    cenario = _cenario()
    _amarrar_conta_ao_servidor("servidor_consulta", cenario["servidor"])
    entrar(app_cliente, contas, "tecnico_seguranca")
    requisicao_id = _pedido_enviado(app_cliente, cenario)
    linha = _linhas(requisicao_id)[0]
    app_cliente.post(f"{FILA}/{requisicao_id}/analise", follow_redirects=False)
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/aprovar",
        data={"quantidade_aprovada": "1", "justificativa": ""},
        follow_redirects=False,
    )
    app_cliente.post(
        f"{FILA}/{requisicao_id}/concluir", data={"parecer": ""}, follow_redirects=False
    )
    app_cliente.post(
        f"{FILA}/{requisicao_id}/itens/{linha.id}/reservar",
        data={"entrada_id": str(cenario["entrada"]), "quantidade": "1"},
        follow_redirects=False,
    )

    sem_parametro = app_cliente.get(f"{FILA}/{requisicao_id}").text
    assert "local de retirada ainda não está registrado" in sem_parametro
    assert "CSSO_EPI_LOCAL_RETIRADA" in sem_parametro

    endereco = "Almoxarifado do SESMT — prédio 5, sala 12, de 8h às 11h"
    import os

    os.environ["CSSO_EPI_LOCAL_RETIRADA"] = endereco
    obter_config.cache_clear()
    try:
        com_parametro = app_cliente.get(f"{FILA}/{requisicao_id}").text
        assert endereco in com_parametro
        assert "ainda não está registrado" not in com_parametro
    finally:
        del os.environ["CSSO_EPI_LOCAL_RETIRADA"]
        obter_config.cache_clear()