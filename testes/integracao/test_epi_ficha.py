"""Fatia 2 de Gestão de EPI: a ficha — a prova legal de que o EPI foi entregue.

O que estes testes protegem, em ordem de gravidade:

1. **O congelamento.** Renomear o item no catálogo amanhã não pode reescrever a
   entrega de ontem, nem na linha da ficha nem no comprovante impresso.
2. **CA vencido não sai** — e o CA que decide é o do LOTE, não o do catálogo.
   É a única regra do módulo com consequência jurídica direta.
3. **Append-only.** Correção é `ESTORNO`, linha nova com motivo; o conteúdo da
   linha errada continua intacto e visível.
4. **A janela da decisão 8.** Entre a entrega e o comprovante assinado a ficha
   tem registro e não tem prova, e isso não pode ser silencioso.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
import sqlalchemy as sa
from sqlalchemy import select

from app.modelos import (
    AcessoDadoSensivel,
    Cargo,
    EpiCategoria,
    EpiEntradaEstoque,
    EpiFichaRegistro,
    EpiItem,
    EpiMotivoRecusa,
    HistoricoEvento,
    Pendencia,
    Servidor,
    UnidadeUorg,
    Usuario,
)
from app.servicos import identificacao
from testes.integracao.conftest import entrar

FICHAS = "/epis/fichas"
ENTREGAS = "/epis/entregas"
NOVA = "/epis/entregas/nova"

HOJE = date.today()
ONTEM = HOJE - timedelta(days=1)
DAQUI_A_UM_ANO = HOJE + timedelta(days=365)


# =====================================================================
# Cenário
# =====================================================================
def _cenario(
    *,
    validade_ca_catalogo: date | None = DAQUI_A_UM_ANO,
    validade_ca_lote: date | None = DAQUI_A_UM_ANO,
    recebido: int = 10,
    quantidade_maxima: int | None = None,
    periodo_maximo_meses: int | None = None,
    vida_util_meses: int | None = 6,
) -> dict:
    """Um servidor, um item de catálogo e um lote com saldo — direto no banco."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        categoria = s.execute(
            select(EpiCategoria).where(
                EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES"
            )
        ).scalar_one()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        cargo = s.execute(select(Cargo)).scalars().first()
        servidor = Servidor(
            siape="7654321",
            nome="Joana Ribeiro de Almeida",
            cargo_id=cargo.id,
            unidade_uorg_id=unidade.id,
        )
        item = EpiItem(
            nome="Luva de proteção química nitrílica",
            categoria_id=categoria.id,
            fabricante="Fabricante Exemplo Ltda",
            marca="Nitri",
            modelo="NX-200",
            normas="ABNT NBR 13697",
            exige_ca=True,
            numero_ca="41234",
            validade_ca=validade_ca_catalogo,
            unidade_medida="PAR",
            tamanhos="P\nM\nG",
            vida_util_meses=vida_util_meses,
            quantidade_padrao=2,
            quantidade_maxima=quantidade_maxima,
            periodo_maximo_meses=periodo_maximo_meses,
        )
        s.add_all([servidor, item])
        s.flush()
        entrada = EpiEntradaEstoque(
            epi_item_id=item.id,
            tamanho="M",
            pregao="90012/2025",
            item_pregao="7",
            empenho="2026NE000123",
            nota_fiscal="4471",
            fornecedor_nome="Distribuidora de EPI Ltda",
            data_entrada=HOJE - timedelta(days=30),
            quantidade_recebida=recebido,
            lote="L-2026-08",
            numero_ca="41234",
            validade_ca=validade_ca_lote,
        )
        s.add(entrada)
        s.flush()
        # o lote entra no razão: saldo é soma de movimentos, nunca célula
        from app.modelos import EpiMovimentoEstoque

        s.add(
            EpiMovimentoEstoque(
                entrada_id=entrada.id, tipo="ENTRADA", quantidade=recebido
            )
        )
        s.commit()
        return {"servidor": servidor.id, "item": item.id, "entrada": entrada.id}


def _entregar(cliente, cenario, **troca):
    dados = {
        "servidor_id": str(cenario["servidor"]),
        "item_id": str(cenario["item"]),
        "quantidade": "2",
        "entrada_id": str(cenario["entrada"]),
        "tamanho": "M",
        "data_evento": HOJE.isoformat(),
        "observacao": "",
        "justificativa_excecao": "",
    }
    dados.update({k: str(v) for k, v in troca.items()})
    return cliente.post(ENTREGAS, data=dados, follow_redirects=False)


def _registros() -> list[EpiFichaRegistro]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return list(
            s.execute(
                select(EpiFichaRegistro).order_by(EpiFichaRegistro.id)
            ).scalars()
        )


def _movimentos_do_lote(cenario: dict) -> list:
    """O razão do lote inteiro, na ordem em que foi gravado."""
    from app import banco as mod_banco
    from app.modelos import EpiMovimentoEstoque

    with mod_banco.sessao() as s:
        return list(
            s.execute(
                select(EpiMovimentoEstoque)
                .where(EpiMovimentoEstoque.entrada_id == cenario["entrada"])
                .order_by(EpiMovimentoEstoque.id)
            ).scalars()
        )


def _recado(resposta) -> str:
    """O que o sistema respondeu, venha por redirect ou pela tela redesenhada.

    O sucesso continua saindo em 303 com o recado na querystring. A **recusa**
    do balcão, não: ela agora redesenha o formulário com o que foi digitado de
    volta (o padrão `digitado` de `processos.criar`), porque perder oito campos —
    quem recebe, o equipamento, o lote, a quantidade — por causa de uma data mal
    escrita é o atrito que faz o atendimento sair do sistema. O helper aceita as
    duas para que o teste continue afirmando o motivo que chega à pessoa, e não o
    mecanismo que o carrega.
    """
    from urllib.parse import unquote

    destino = resposta.headers.get("location")
    return unquote(destino) if destino else resposta.text


# =====================================================================
# 1. O congelamento — RN-15 aplicada ao EPI
# =====================================================================
def test_a_entrega_congela_o_que_valia_no_ato(app_cliente, contas, banco):
    """Nome, CA, validade, fabricante, lote e a identificação da pessoa.

    É o que separa uma ficha de um relatório: o relatório recalcula, a ficha
    afirma o que aconteceu.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    assert _entregar(app_cliente, cenario).status_code == 303

    registro = _registros()[0]
    assert registro.tipo == "ENTREGA"
    assert registro.nome_epi_snapshot == "Luva de proteção química nitrílica"
    assert registro.categoria_snapshot == "Proteção dos membros superiores"
    assert registro.numero_ca_snapshot == "41234"
    assert registro.validade_ca_snapshot == DAQUI_A_UM_ANO
    assert registro.lote_snapshot == "L-2026-08"
    assert registro.tamanho_snapshot == "M"
    assert registro.siape_snapshot == "7654321"
    assert registro.nome_servidor_snapshot == "Joana Ribeiro de Almeida"
    # RN-32: a previsão de troca é congelada, porque a vida útil do catálogo pode
    # mudar depois
    from app.servicos.datas_br import somar_meses

    assert registro.previsao_troca == somar_meses(HOJE, 6)
    # o resto do contexto (empenho, pregão, fornecedor) vai no congelado
    assert registro.contexto_congelado["empenho"] == "2026NE000123"
    assert registro.contexto_congelado["pregao"] == "90012/2025"


def test_o_extrato_do_lote_nao_publica_a_matricula_de_quem_recebeu(
    app_cliente, contas, banco
):
    """RN-19 pela PROSA: a identificação que escapa por texto livre gravado.

    O razão do lote guardava o motivo da saída como "entrega ao SIAPE 7654321",
    e `/epis/estoque/{id}/movimentos` o imprimia cru — sob `epi.ver`, que é a
    permissão que o **servidor comum** tem. Quem abrisse o extrato de um lote
    lia a matrícula de todo mundo que recebeu daquele lote, por fora de toda a
    supressão que a RN-19 aplica em coluna de nome.

    As duas metades, e as duas importam:

    - **Escrita**: o motivo passou a referenciar `servidor #{id}`, como
      `direito.py` já fazia. Vale para o que vier.
    - **Leitura**: `texto_livre()` no template. É a única metade que alcança o
      que **já está gravado** — `epi_movimento_estoque` é append-only com
      trigger, e reescrever o passado não é opção. Mesma divisão da 1.35.0 para
      a trilha e a pendência.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    assert _entregar(app_cliente, cenario).status_code == 303

    from app import banco as mod_banco
    from app.modelos import EpiMovimentoEstoque

    with mod_banco.sessao() as s:
        saida = (
            s.execute(
                select(EpiMovimentoEstoque).where(EpiMovimentoEstoque.tipo == "SAIDA")
            )
            .scalars()
            .one()
        )
        motivo = saida.motivo or ""

    assert "7654321" not in motivo, (
        f"a matrícula foi gravada no motivo do movimento: {motivo!r}"
    )

    corpo = app_cliente.get(f"/epis/estoque/{cenario['entrada']}/movimentos").text
    assert "7654321" not in corpo, "o extrato do lote publicou a matrícula"


def test_a_devolucao_tambem_nao_publica_a_matricula_no_razao(
    app_cliente, contas, banco
):
    """A outra linha que o razão grava sobre uma pessoa, e a que ficou de fora.

    A correção acima fechou a `SAIDA` e deixou a `DEVOLUCAO` gravando
    "devolução do SIAPE 7654321" — e isso não é um segundo caso independente:
    **toda devolução tem uma entrega antes**, no mesmo lote, uma linha abaixo
    da outra no mesmo extrato. Fechar só a saída publicava a mesma matrícula
    pela linha seguinte, e bastava devolver um par de luvas para reabrir o que
    a metade anterior tinha acabado de fechar.

    O SIAPE ali era redundante além de vazado: `ficha_registro_id` já aponta
    para a linha da ficha, que diz de quem é a devolução sem nomear ninguém.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    assert _entregar(app_cliente, cenario).status_code == 303
    entrega = _registros()[0]

    devolucao = app_cliente.post(
        f"{FICHAS}/registros/{entrega.id}/devolucao",
        data={"quantidade": "1", "motivo": "desgaste no uso", "data_evento": ""},
        follow_redirects=False,
    )
    assert devolucao.status_code == 303, devolucao.text

    razao = [(m.tipo, m.motivo or "") for m in _movimentos_do_lote(cenario)]
    assert any(tipo == "DEVOLUCAO" for tipo, _ in razao), (
        "a devolução não chegou ao razão: o teste não mediu nada"
    )
    for tipo, motivo in razao:
        assert "7654321" not in motivo, (
            f"a matrícula foi gravada no motivo do movimento {tipo}: {motivo!r}"
        )

    corpo = app_cliente.get(f"/epis/estoque/{cenario['entrada']}/movimentos").text
    assert "7654321" not in corpo, "o extrato do lote publicou a matrícula"


def _linha_antiga_do_razao(cenario: dict, motivo: str) -> None:
    """Uma linha gravada do jeito antigo, direto no banco.

    `INSERT` é o único verbo que a tabela aceita (a trava recusa `UPDATE` e
    `DELETE`), e é exatamente por isso que o passado existe: nenhuma correção
    de escrita alcança estas linhas. Escrevê-la à mão é a única forma honesta
    de medir a metade da LEITURA — depois da correção da escrita, nenhum
    caminho do sistema produz mais uma frase destas.
    """
    from app import banco as mod_banco
    from app.modelos import EpiMovimentoEstoque

    with mod_banco.sessao() as s:
        s.add(
            EpiMovimentoEstoque(
                entrada_id=cenario["entrada"],
                tipo="SAIDA",
                quantidade=-1,
                motivo=motivo,
            )
        )
        s.commit()


def test_o_extrato_suprime_a_matricula_que_o_razao_ja_gravou(
    app_cliente, contas, banco
):
    """A metade da LEITURA, medida sobre o que ela existe para alcançar.

    A correção da escrita não conserta nada do que já está no razão: a tabela é
    append-only por trava de banco, e reescrever o passado é o que ela existe
    para impedir. Quem alcança as linhas antigas é `texto_livre()` na
    renderização — e, depois da correção, **nenhum caminho do sistema produz
    mais uma frase com matrícula**, o que deixaria esta metade sem prova
    nenhuma se o teste não gravasse a linha antiga à mão.

    O ator é `servidor_consulta`: ele tem `epi.ver` só para abrir o catálogo do
    setor, e é com ela que o extrato de qualquer lote se abre — a rota não
    aplica escopo, porque o lote não é de ninguém.
    """
    cenario = _cenario()
    _linha_antiga_do_razao(cenario, "entrega ao SIAPE 7654321")

    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get(f"/epis/estoque/{cenario['entrada']}/movimentos")
    assert resposta.status_code == 200
    assert "7654321" not in resposta.text, (
        "o extrato publicou a matrícula que o razão antigo gravou"
    )
    assert identificacao.TEXTO_SUPRIMIDO in resposta.text, (
        "suprimiu e não disse que suprimiu — célula vazia se lê como movimento "
        "sem motivo, e movimento sem motivo é razão quebrado"
    )


def test_o_extrato_continua_legivel_para_quem_ve_exposicao(
    app_cliente, contas, banco
):
    """O contrapeso, e sem ele o teste acima passaria com a tela inutilizada.

    Um `texto_livre()` que não achasse o usuário no contexto suprimiria tudo
    para todo mundo, e a medição de vazamento passaria satisfeita com o extrato
    ilegível para quem confere o estoque. O motivo é a única resposta a "por que
    o saldo mudou": apagá-lo para a CSSO seria trocar um vazamento por um razão
    que não explica nada.
    """
    cenario = _cenario()
    _linha_antiga_do_razao(cenario, "entrega ao SIAPE 7654321")

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(f"/epis/estoque/{cenario['entrada']}/movimentos").text
    assert "entrega ao SIAPE 7654321" in corpo
    assert identificacao.TEXTO_SUPRIMIDO not in corpo


def test_renomear_o_item_nao_reescreve_a_entrega_de_ontem(app_cliente, contas, banco):
    """A lição do CHANGELOG 1.4.0, aplicada ao EPI: editar catálogo reescrevia
    parecer emitido em silêncio."""
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)

    with mod_banco.sessao() as s:
        item = s.get(EpiItem, cenario["item"])
        item.nome = "Luva de procedimento"
        item.numero_ca = "99999"
        s.commit()

    registro = _registros()[0]
    assert registro.nome_epi_snapshot == "Luva de proteção química nitrílica"
    assert registro.numero_ca_snapshot == "41234"
    corpo = app_cliente.get(f"{FICHAS}/{cenario['servidor']}").text
    assert "Luva de proteção química nitrílica" in corpo
    assert "Luva de procedimento" not in corpo


def test_o_comprovante_sai_dos_snapshots_e_reimprime_igual(app_cliente, contas, banco):
    """Reimprimir uma ficha antiga tem de dar texto idêntico — mesma disciplina
    do texto de ouro do parecer."""
    from app import banco as mod_banco
    from app.servicos import comprovante_epi, documento

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id

    primeira = app_cliente.get(f"{FICHAS}/registros/{registro_id}/comprovante")
    assert primeira.status_code == 200
    assert "Comprovante_EPI" in primeira.headers["content-disposition"]

    with mod_banco.sessao() as s:
        registro = s.get(EpiFichaRegistro, registro_id)
        caminho = comprovante_epi.caminho_saida(registro_id, registro.data_evento.year)
        texto_antes = documento.texto_normalizado(caminho)
        # o catálogo muda embaixo, e o papel não pode mudar junto
        item = s.get(EpiItem, cenario["item"])
        item.nome = "Luva qualquer coisa"
        item.numero_ca = "00000"
        s.commit()

    app_cliente.get(f"{FICHAS}/registros/{registro_id}/comprovante")
    assert documento.texto_normalizado(caminho) == texto_antes
    assert "Luva de proteção química nitrílica" in texto_antes
    assert "41234" in texto_antes
    # o termo que a pessoa assina, e a norma que o sustenta
    assert "NR-6" in texto_antes
    assert "7654321" in texto_antes


# =====================================================================
# 2. RN-25 — CA vencido não se entrega, e quem manda é o do lote
# =====================================================================
def test_ca_vencido_no_lote_bloqueia_a_entrega(app_cliente, contas, banco):
    """Pela NR-6 o CA é o que constitui o equipamento como EPI: entregar um
    vencido significa que a instituição não entregou proteção nenhuma."""
    cenario = _cenario(validade_ca_lote=ONTEM)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _entregar(app_cliente, cenario)
    assert "CA vencido" in _recado(resposta)
    assert _registros() == []


def test_o_ca_que_vale_e_o_do_lote_e_nao_o_do_catalogo(app_cliente, contas, banco):
    """O caso concreto: o catálogo já aponta para o CA renovado de 2026 e a
    prateleira ainda tem o lote de 2023."""
    cenario = _cenario(
        validade_ca_catalogo=DAQUI_A_UM_ANO, validade_ca_lote=ONTEM
    )
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _entregar(app_cliente, cenario)
    assert "venceu em" in _recado(resposta)
    assert _registros() == []


def test_lote_sem_validade_de_ca_tambem_nao_sai(app_cliente, contas, banco):
    """“Não sei” não é “está válido”."""
    cenario = _cenario(validade_ca_lote=None)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _entregar(app_cliente, cenario)
    assert "não tem validade de CA" in _recado(resposta)
    assert _registros() == []


def test_o_lote_vencido_nao_some_da_tela(app_cliente, contas, banco):
    """Ele continua com saldo físico e fica indisponível, com o motivo ao lado.

    Sumir seria repetir o defeito do legado — saldo mudando sem rastro — e
    deixaria quem opera procurando defeito no sistema. Tirar do estoque é
    `DESCARTE` com motivo, que é decisão registrada.
    """
    cenario = _cenario(validade_ca_lote=ONTEM)
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(f"/epis/entregas/opcoes?item_id={cenario['item']}").text
    assert "L-2026-08" in corpo
    assert "INDISPONÍVEL" in corpo


# =====================================================================
# 3. RN-24 — saldo nunca fica negativo, e a baixa é pelo razão
# =====================================================================
def test_entregar_mais_do_que_o_lote_tem_e_recusado(app_cliente, contas, banco):
    cenario = _cenario(recebido=2)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _entregar(app_cliente, cenario, quantidade=3)
    assert "2 disponível(is)" in _recado(resposta)
    assert _registros() == []


def test_a_entrega_baixa_o_lote_pelo_livro_razao(app_cliente, contas, banco):
    from app import banco as mod_banco
    from app.servicos import epi_estoque

    cenario = _cenario(recebido=10)
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario, quantidade=3)
    registro_id = _registros()[0].id

    with mod_banco.sessao() as s:
        assert epi_estoque.saldo_fisico(s, cenario["entrada"]) == 7
        from app.modelos import EpiMovimentoEstoque

        saida = s.execute(
            select(EpiMovimentoEstoque).where(EpiMovimentoEstoque.tipo == "SAIDA")
        ).scalar_one()
        # o movimento aponta para a linha da ficha: é o que amarra o saldo à prova
        assert saida.quantidade == -3
        assert saida.ficha_registro_id == registro_id


# =====================================================================
# 4. A janela da decisão 8 — registro sem prova é pendência
# =====================================================================
def test_entrega_sem_comprovante_abre_pendencia_e_aparece_na_tela(
    app_cliente, contas, banco
):
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)

    with mod_banco.sessao() as s:
        pendencia = s.execute(
            select(Pendencia).where(
                Pendencia.tipo == "COMPROVANTE_EPI_PENDENTE"
            )
        ).scalar_one()
        assert not pendencia.concluida
        assert pendencia.entidade == "epi_ficha_registro"
        assert pendencia.responsavel_id is not None

    corpo = app_cliente.get(f"{FICHAS}/{cenario['servidor']}").text
    assert "sem comprovante" in corpo
    assert "registro e sem prova" in corpo
    # e na lista, contado, para não obrigar a abrir uma ficha por vez
    assert "1 pendente(s)" in app_cliente.get(FICHAS).text


def test_a_pendencia_leva_ate_a_ficha(app_cliente, contas, banco):
    """A âncora só vira link quando a tela existe — e agora ela existe.

    `Pendencia` guarda `entidade` e `entidade_id`, não `servidor_id`: sem a rota
    de redirecionamento a tela mostraria `epi_ficha_registro #1` e pararia aí.
    """
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id

    fila = app_cliente.get("/pendencias").text
    # a âncora da fila carrega o caminho de volta (`?de=pendencias`)
    assert f'href="{FICHAS}/registros/{registro_id}?de=pendencias"' in fila
    salto = app_cliente.get(f"{FICHAS}/registros/{registro_id}", follow_redirects=False)
    assert salto.status_code == 303
    assert salto.headers["location"] == f"{FICHAS}/{cenario['servidor']}"


def test_anexar_o_assinado_fecha_a_janela(app_cliente, contas, banco):
    from app import banco as mod_banco
    from app.modelos import Anexo

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id

    resposta = app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/comprovante",
        files={"arquivo": ("assinado.pdf", b"%PDF-1.4 assinatura", "application/pdf")},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "SHA-256" in _recado(resposta)

    with mod_banco.sessao() as s:
        registro = s.get(EpiFichaRegistro, registro_id)
        assert registro.comprovante_anexo_id is not None
        assert registro.recebimento_confirmado_em is not None
        anexo = s.get(Anexo, registro.comprovante_anexo_id)
        # categoria não é rótulo: é ela que decide quando o arquivo pode sumir
        assert anexo.categoria == "FICHA_EPI"
        assert anexo.nivel_acesso == "RESTRITO"
        assert anexo.assinado
        pendencia = s.execute(
            select(Pendencia).where(Pendencia.tipo == "COMPROVANTE_EPI_PENDENTE")
        ).scalar_one()
        assert pendencia.concluida

    corpo = app_cliente.get(f"{FICHAS}/{cenario['servidor']}").text
    assert "sem comprovante" not in corpo
    assert "comprovante ·" in corpo


def test_trocar_o_comprovante_ja_anexado_e_recusado(app_cliente, contas, banco):
    """Trocar a prova de uma entrega registrada é estorno, não substituição de
    arquivo — e o banco recusa a reescrita mesmo que a rota deixasse passar."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id
    arquivo = {"arquivo": ("a.pdf", b"%PDF-1.4 um", "application/pdf")}
    app_cliente.post(f"{FICHAS}/registros/{registro_id}/comprovante", files=arquivo)

    segunda = app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/comprovante",
        files={"arquivo": ("b.pdf", b"%PDF-1.4 dois", "application/pdf")},
        follow_redirects=False,
    )
    assert "já tem comprovante" in _recado(segunda)


# =====================================================================
# 5. Append-only — a trava do banco, revista sem afrouxar a prova
# =====================================================================
def test_o_conteudo_da_ficha_continua_inalteravel(sessao, atores):
    """A trava afrouxou para três colunas de completude, e só para elas."""
    from app.modelos import EpiCategoria as Cat

    categoria = sessao.execute(select(Cat)).scalars().first()
    item = EpiItem(
        nome="Bota de segurança", categoria_id=categoria.id, exige_ca=False,
        quantidade_padrao=1,
    )
    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    servidor = Servidor(siape="1212121", nome="Alvo", unidade_uorg_id=unidade.id)
    sessao.add_all([item, servidor])
    sessao.flush()
    registro = EpiFichaRegistro(
        servidor_id=servidor.id, epi_item_id=item.id, tipo="ENTREGA", quantidade=1,
        data_evento=HOJE, nome_epi_snapshot=item.nome, categoria_snapshot="X",
        nome_servidor_snapshot=servidor.nome, siape_snapshot=servidor.siape,
        entregue_por=atores["coord"].id,
    )
    sessao.add(registro)
    sessao.commit()

    for coluna, valor in (
        ("quantidade", 9),
        ("nome_epi_snapshot", "outra coisa"),
        ("siape_snapshot", "9999999"),
        ("motivo", "rasura"),
        ("data_evento", "2020-01-01"),
    ):
        with pytest.raises(Exception) as erro:
            sessao.execute(
                sa.text(f"UPDATE epi_ficha_registro SET {coluna}=:v WHERE id=:i"),
                {"v": valor, "i": registro.id},
            )
        assert "append-only" in str(erro.value), coluna
        sessao.rollback()

    with pytest.raises(Exception, match="append-only"):
        sessao.execute(
            sa.text("DELETE FROM epi_ficha_registro WHERE id=:i"), {"i": registro.id}
        )
    sessao.rollback()


def test_as_tres_colunas_de_completude_se_preenchem_uma_vez_so(sessao, atores, banco):
    """De nulo para valor, e nunca mais. Completar não é reescrever."""
    from app.modelos import EpiCategoria as Cat

    categoria = sessao.execute(select(Cat)).scalars().first()
    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    item = EpiItem(nome="Capacete", categoria_id=categoria.id, exige_ca=False,
                   quantidade_padrao=1)
    servidor = Servidor(siape="1313131", nome="Alvo 2", unidade_uorg_id=unidade.id)
    sessao.add_all([item, servidor])
    sessao.flush()
    registro = EpiFichaRegistro(
        servidor_id=servidor.id, epi_item_id=item.id, tipo="ENTREGA", quantidade=1,
        data_evento=HOJE, nome_epi_snapshot=item.nome, categoria_snapshot="X",
        nome_servidor_snapshot=servidor.nome, siape_snapshot=servidor.siape,
        entregue_por=atores["coord"].id,
    )
    sessao.add(registro)
    sessao.commit()

    from app.servicos import auditoria

    primeiro = auditoria.registrar(
        sessao, entidade="epi_ficha_registro", entidade_id=registro.id,
        tipo_evento="EPI_ENTREGUE", descricao="primeiro",
    ).id
    segundo = auditoria.registrar(
        sessao, entidade="epi_ficha_registro", entidade_id=registro.id,
        tipo_evento="EPI_ENTREGUE", descricao="segundo",
    ).id
    sessao.commit()

    sessao.execute(
        sa.text("UPDATE epi_ficha_registro SET evento_id=:e WHERE id=:i"),
        {"e": primeiro, "i": registro.id},
    )
    sessao.commit()
    with pytest.raises(Exception, match="append-only"):
        sessao.execute(
            sa.text("UPDATE epi_ficha_registro SET evento_id=:e WHERE id=:i"),
            {"e": segundo, "i": registro.id},
        )
    sessao.rollback()


def test_a_lista_da_trava_cobre_todas_as_colunas_do_modelo():
    """Proteção contra deriva: coluna nova no modelo tem de entrar na trava.

    A cláusula da trigger é literal — migração lê o passado, e gerá-la do modelo
    faria uma coluna de 2027 reescrever em silêncio o que a revisão de hoje
    criou. O preço dessa escolha é este teste.
    """
    from app.banco import FICHA_COMPLETAVEL, _FICHA_CONGELADA

    do_modelo = {c.name for c in EpiFichaRegistro.__table__.columns}
    assert set(_FICHA_CONGELADA) | set(FICHA_COMPLETAVEL) == do_modelo
    assert not set(_FICHA_CONGELADA) & set(FICHA_COMPLETAVEL)


# =====================================================================
# 6. Estorno — a única forma de corrigir
# =====================================================================
def test_estorno_e_linha_nova_e_a_errada_continua_visivel(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario, quantidade=5)
    original = _registros()[0]

    resposta = app_cliente.post(
        f"{FICHAS}/registros/{original.id}/estorno",
        data={"motivo": "quantidade digitada errada"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    registros = _registros()
    assert len(registros) == 2
    estorno = registros[1]
    assert estorno.tipo == "ESTORNO"
    assert estorno.registro_estornado_id == original.id
    assert estorno.motivo == "quantidade digitada errada"
    # herda os snapshots: o estorno fala DAQUELA entrega
    assert estorno.nome_epi_snapshot == original.nome_epi_snapshot

    corpo = app_cliente.get(f"{FICHAS}/{cenario['servidor']}").text
    assert f"estornado pelo nº {estorno.id}" in corpo
    assert "estorna o nº" in corpo


def test_estorno_sem_motivo_e_recusado(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id
    resposta = app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/estorno",
        data={"motivo": "   "},
        follow_redirects=False,
    )
    assert "exige o motivo" in _recado(resposta)
    assert len(_registros()) == 1


def test_estorno_fecha_a_pendencia_do_comprovante(app_cliente, contas, banco):
    """Não há papel a colher de uma entrega que o próprio setor invalidou."""
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id
    app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/estorno", data={"motivo": "lançamento em duplicidade"}
    )
    with mod_banco.sessao() as s:
        pendencia = s.execute(
            select(Pendencia).where(Pendencia.tipo == "COMPROVANTE_EPI_PENDENTE")
        ).scalar_one()
        assert pendencia.concluida


def test_o_estorno_nao_devolve_saldo_ao_estoque(app_cliente, contas, banco):
    """Estornar diz que o REGISTRO está errado, não que o equipamento voltou.

    O que devolve saldo é `DEVOLUCAO`, que é fato do mundo. Fazer as duas coisas
    num clique criaria a divergência que o razão existe para impedir.
    """
    from app import banco as mod_banco
    from app.servicos import epi_estoque

    cenario = _cenario(recebido=10)
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario, quantidade=4)
    registro_id = _registros()[0].id
    app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/estorno", data={"motivo": "servidor errado"}
    )
    with mod_banco.sessao() as s:
        assert epi_estoque.saldo_fisico(s, cenario["entrada"]) == 6


# =====================================================================
# 7. A amarração com a cadeia de hash (§6.2)
# =====================================================================
def test_a_linha_da_ficha_aponta_para_o_evento_que_a_registrou(
    app_cliente, contas, banco
):
    from app import banco as mod_banco
    from app.servicos import epi_ficha
    from app.servicos.auditoria import cadeia_integra

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)

    with mod_banco.sessao() as s:
        registro = s.execute(select(EpiFichaRegistro)).scalar_one()
        assert registro.evento_id is not None
        evento = s.get(HistoricoEvento, registro.evento_id)
        assert evento.tipo_evento == "EPI_ENTREGUE"
        # a prova fica a um JOIN de distância, não a uma busca por texto
        assert evento.valor_novo == epi_ficha.forma_canonica(registro)
        assert cadeia_integra(s) == (True, None)
        assert epi_ficha.conferir(s, cenario["servidor"]) == []


def test_a_conferencia_acusa_linha_sem_evento(sessao, atores):
    """Linha gravada por fora do serviço não tem com o que ser conferida."""
    from app.modelos import EpiCategoria as Cat
    from app.servicos import epi_ficha

    categoria = sessao.execute(select(Cat)).scalars().first()
    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    item = EpiItem(nome="Avental", categoria_id=categoria.id, exige_ca=False,
                   quantidade_padrao=1)
    servidor = Servidor(siape="1414141", nome="Sem evento", unidade_uorg_id=unidade.id)
    sessao.add_all([item, servidor])
    sessao.flush()
    sessao.add(
        EpiFichaRegistro(
            servidor_id=servidor.id, epi_item_id=item.id, tipo="ENTREGA", quantidade=1,
            data_evento=HOJE, nome_epi_snapshot=item.nome, categoria_snapshot="X",
            nome_servidor_snapshot=servidor.nome, siape_snapshot=servidor.siape,
            entregue_por=atores["coord"].id,
        )
    )
    sessao.commit()
    achados = epi_ficha.conferir(sessao, servidor.id)
    assert len(achados) == 1
    assert "não aponta para nenhum evento" in achados[0].detalhe


# =====================================================================
# 8. RN-26 — a máxima conta o que a FICHA registra
# =====================================================================
def test_maximo_excedido_bloqueia_ate_alguem_assinar_a_excecao(
    app_cliente, contas, banco
):
    cenario = _cenario(quantidade_maxima=2, periodo_maximo_meses=12)
    entrar(app_cliente, contas, "coordenador_csso")
    assert _entregar(app_cliente, cenario, quantidade=2).status_code == 303

    barrada = _entregar(app_cliente, cenario, quantidade=2)
    assert "já recebeu 2" in _recado(barrada)
    assert len(_registros()) == 1

    com_excecao = _entregar(
        app_cliente,
        cenario,
        quantidade=2,
        justificativa_excecao="par danificado em incidente no laboratório",
    )
    assert com_excecao.status_code == 303
    assert len(_registros()) == 2

    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "EPI_MAXIMO_EXCEDIDO"
            )
        ).scalar_one()
        assert "par danificado" in evento.descricao


def test_a_linha_estornada_nao_conta_para_o_maximo(app_cliente, contas, banco):
    """Estorno existe justamente para dizer que aquela entrega não vale."""
    cenario = _cenario(quantidade_maxima=2, periodo_maximo_meses=12)
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario, quantidade=2)
    registro_id = _registros()[0].id
    app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/estorno", data={"motivo": "servidor errado"}
    )
    assert _entregar(app_cliente, cenario, quantidade=2).status_code == 303


# =====================================================================
# 9. RN-27 e as decisões 3 e 7 — a recusa fundamentada
# =====================================================================
def test_a_recusa_congela_o_texto_do_motivo_na_trilha(app_cliente, contas, banco):
    """Editar o catálogo depois não reescreve a negativa que já saiu."""
    from app import banco as mod_banco

    _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        motivo = s.execute(
            select(EpiMotivoRecusa).where(
                EpiMotivoRecusa.codigo == "VINCULO_NAO_ATENDIDO"
            )
        ).scalar_one()
        motivo_id, texto_original = motivo.id, motivo.texto

    resposta = app_cliente.post(
        f"{ENTREGAS}/recusa",
        data={
            "motivo_id": str(motivo_id),
            "a_quem": "chefia da FAMED, em nome da equipe de limpeza contratada",
            "unidade": "FAMED",
            "complemento": "",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "VINCULO_NAO_ATENDIDO" in _recado(resposta)

    with mod_banco.sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "EPI_ENTREGA_RECUSADA"
            )
        ).scalar_one()
        assert evento.valor_novo["motivo"] == "VINCULO_NAO_ATENDIDO"
        assert evento.valor_novo["texto"] == texto_original
        # a negativa não é só um "não": ela encaminha
        assert "empresa contratante" in evento.valor_novo["texto"]
        # e é contável pelo código, sem casar texto
        assert evento.entidade == "epi_motivo_recusa"

        s.get(EpiMotivoRecusa, motivo_id).texto = "Texto novo, editado depois."
        s.commit()
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "EPI_ENTREGA_RECUSADA"
            )
        ).scalar_one()
        assert evento.valor_novo["texto"] == texto_original


def test_motivo_que_exige_complemento_nao_passa_sem_ele(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        outro = s.execute(
            select(EpiMotivoRecusa).where(EpiMotivoRecusa.codigo == "OUTRO")
        ).scalar_one()
        outro_id = outro.id
    resposta = app_cliente.post(
        f"{ENTREGAS}/recusa",
        data={"motivo_id": str(outro_id), "a_quem": "alguém", "complemento": ""},
        follow_redirects=False,
    )
    assert "exige o complemento" in _recado(resposta)


# =====================================================================
# 10. RN-21 e RN-30 — texto livre passa pelo filtro
# =====================================================================
def test_observacao_com_dado_de_saude_e_recusada(app_cliente, contas, banco):
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _entregar(
        app_cliente, cenario, observacao="Servidora gestante, afastada do setor."
    )
    assert "termo proibido" in _recado(resposta)
    assert _registros() == []


def test_entrega_com_data_futura_e_recusada(app_cliente, contas, banco):
    """A ficha registra o que aconteceu — e é append-only, então não há desfazer."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _entregar(
        app_cliente, cenario, data_evento=(HOJE + timedelta(days=1)).isoformat()
    )
    assert "data futura" in _recado(resposta)
    assert _registros() == []


# =====================================================================
# 11. Permissões e RN-23
# =====================================================================
@pytest.mark.parametrize(
    "perfil,fichas,entrega",
    [
        ("coordenador_csso", 200, 200),
        ("tecnico_seguranca", 200, 200),
        ("engenheiro_seguranca", 200, 403),
        ("medico_trabalho", 200, 403),
        ("auditor_interno", 200, 403),
        ("consulta_progep", 200, 403),
        ("secretaria_csso", 403, 403),
        ("servidor_consulta", 403, 403),
        ("admin_ti", 403, 403),
    ],
)
def test_permissao_das_telas(app_cliente, contas, perfil, fichas, entrega):
    """A matriz do §8: `epi.ficha` é histórico nominal, `epi.entregar` é o balcão."""
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(FICHAS).status_code == fichas
    assert app_cliente.get(NOVA).status_code == entrega


def test_o_titular_ve_a_propria_ficha_sem_epi_ficha(app_cliente, contas, banco):
    """LGPD art. 18, II. `servidor_consulta` não tem `epi.ficha` de propósito:
    ela é a permissão de ler a ficha DOS OUTROS."""
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    app_cliente.get("/sair")

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = cenario["servidor"]
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    minha = app_cliente.get(f"{FICHAS}/{cenario['servidor']}")
    assert minha.status_code == 200
    assert "Joana Ribeiro de Almeida" in minha.text
    # e não vê a de outro
    with mod_banco.sessao() as s:
        outro = Servidor(siape="5555555", nome="Outra Pessoa")
        s.add(outro)
        s.commit()
        outro_id = outro.id
    assert app_cliente.get(f"{FICHAS}/{outro_id}").status_code == 403


def test_ler_a_ficha_de_outro_entra_em_acesso_dado_sensivel(app_cliente, contas, banco):
    """RN-23: a ficha é histórico nominal sobre a segurança de uma pessoa."""
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    app_cliente.get(f"{FICHAS}/{cenario['servidor']}")

    with mod_banco.sessao() as s:
        campos = {
            a.campo
            for a in s.execute(
                select(AcessoDadoSensivel).where(
                    AcessoDadoSensivel.servidor_id == cenario["servidor"]
                )
            ).scalars()
        }
    assert "epi_ficha" in campos


def test_baixar_o_comprovante_assinado_tambem_e_registrado(app_cliente, contas, banco):
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id
    app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/comprovante",
        files={"arquivo": ("a.pdf", b"%PDF-1.4 x", "application/pdf")},
    )
    assert app_cliente.get(f"{FICHAS}/registros/{registro_id}/anexo").status_code == 200

    with mod_banco.sessao() as s:
        campos = {
            a.campo
            for a in s.execute(select(AcessoDadoSensivel)).scalars()
        }
    assert "anexo.FICHA_EPI" in campos


def _virar_o_titular(servidor_id: int, login: str = "coordenador_csso") -> None:
    """Amarra a conta que opera ao servidor do cenário.

    É o caso que faltava cobrir: quem tem `epi.entregar` **e** é a pessoa da
    ficha. Ele é raro no balcão e não é hipotético — a equipe da CSSO também
    recebe EPI —, e é exatamente onde as duas regras divergiam.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        conta = s.execute(select(Usuario).where(Usuario.login == login)).scalar_one()
        conta.servidor_id = servidor_id
        s.commit()


def test_imprimir_o_proprio_comprovante_nao_entra_em_acesso_dado_sensivel(
    app_cliente, contas, banco
):
    """A divergência que a 1.35.0 deixou para trás, fechada.

    `epi_ficha.imprimir` era a única das cinco gravações do sistema sem a
    pergunta "é de outro?": tirar a via do próprio comprovante escrevia o titular
    em `acesso_dado_sensivel`, transformando em suspeita o ato que o art. 18, II
    garante. A trilha continua registrando a impressão — quantas vias saíram e
    com que hash é outra pergunta, e essa vale sempre.
    """
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id
    _virar_o_titular(cenario["servidor"])

    assert (
        app_cliente.get(f"{FICHAS}/registros/{registro_id}/comprovante").status_code
        == 200
    )

    with mod_banco.sessao() as s:
        acessos = list(
            s.execute(
                select(AcessoDadoSensivel).where(
                    AcessoDadoSensivel.servidor_id == cenario["servidor"]
                )
            ).scalars()
        )
        impressoes = list(
            s.execute(
                select(HistoricoEvento).where(
                    HistoricoEvento.tipo_evento == "EPI_COMPROVANTE_IMPRESSO"
                )
            ).scalars()
        )
    assert acessos == [], "o titular imprimindo o próprio comprovante virou linha"
    assert impressoes, "a trilha deixou de registrar a impressão"


def test_baixar_o_proprio_comprovante_assinado_nao_entra_em_acesso_dado_sensivel(
    app_cliente, contas, banco
):
    """A quinta gravação, a de `anexo_acesso`, sob a mesma regra.

    Até a 1.36.0 nenhum titular alcançava anexo nenhum e a diferença não existia.
    Desde que ele abre o próprio comprovante, `registrar_leitura` gravava a
    leitura do próprio dado — e `ANEXO_BAIXADO` continua saindo sempre, porque
    "qual arquivo saiu" vale para o titular também.
    """
    from app import banco as mod_banco

    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    registro_id = _registros()[0].id
    app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/comprovante",
        files={"arquivo": ("a.pdf", b"%PDF-1.4 x", "application/pdf")},
    )
    _virar_o_titular(cenario["servidor"])

    assert app_cliente.get(f"{FICHAS}/registros/{registro_id}/anexo").status_code == 200

    with mod_banco.sessao() as s:
        campos = {a.campo for a in s.execute(select(AcessoDadoSensivel)).scalars()}
        baixados = list(
            s.execute(
                select(HistoricoEvento).where(
                    HistoricoEvento.tipo_evento == "ANEXO_BAIXADO"
                )
            ).scalars()
        )
    assert "anexo.FICHA_EPI" not in campos
    assert baixados, "a trilha deixou de dizer qual anexo saiu"


# =====================================================================
# 12. A ficha embutida em /servidores/{id}
# =====================================================================
def test_a_ficha_de_epi_aparece_no_cadastro_do_servidor(app_cliente, contas, banco):
    """É a mesma pessoa: obrigar a trocar de tela é a fragmentação que a base
    compartilhada existe para evitar (§9 do desenho)."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    corpo = app_cliente.get(f"/servidores/{cenario['servidor']}").text
    assert "EPI recebido" in corpo
    assert "Luva de proteção química nitrílica" in corpo
    assert f'href="/epis/fichas/{cenario["servidor"]}"' in corpo


def test_quem_nao_ve_a_ficha_nao_ve_a_secao(app_cliente, contas, banco):
    """A seção segue `epi.ficha`, não `processo.ver`: quem não pode abrir
    /epis/fichas não passa a poder porque entrou por outra porta."""
    cenario = _cenario()
    entrar(app_cliente, contas, "coordenador_csso")
    _entregar(app_cliente, cenario)
    app_cliente.get("/sair")

    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get(f"/servidores/{cenario['servidor']}").text
    assert "EPI recebido" not in corpo
