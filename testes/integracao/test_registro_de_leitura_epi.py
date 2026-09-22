"""A metade restante do G-3: as rotas de EPI passam a deixar rastro.

Medido em `entrada/servidor/03_PRIVACIDADE.md` e refeito aqui com a conta que
mais interessa — o `almoxarife_sesmt`, que **tem** `epi.ficha` e portanto lê o
nome de todo mundo, e que mesmo assim não deixava linha nenhuma:

```
almoxarife_sesmt lê 9 requisições nominais
acesso_dado_sensivel                      antes: 0     depois: 9
```

Zero porque as rotas de `app/rotas/epi_*.py` não chamavam gravação nenhuma — nem
a antiga `registrar_acesso_sensivel`, nem a decisão da 1.35.0. A ficha de EPI
gravava desde a fatia 3 e a requisição, que é a tela com "rotina de trabalho" e
"riscos declarados pelo próprio requerente", nunca gravou.

**O que este arquivo fixa dos dois lados**, porque um teste que só prova que
passou a gravar não protege a metade cara da decisão:

1. a ficha da requisição e a guia gravam, com `campo` e `finalidade` que dizem o
   que foi lido e por quê — linha que não diz isso não sustenta investigação
   nenhuma, e foi o defeito da porta de trás do `FICHA_EPI` (1.31.0);
2. **a fila não grava**, e as duas buscas por HTMX também não: elas mostram
   identificação já suprimida pela RN-19, e uma linha por pessoa por abertura de
   tela afogaria o sinal que a tabela existe para dar;
3. **o titular lendo o próprio pedido não grava** (LGPD art. 18, II — o
   argumento inteiro está em `auditoria.registrar_leitura_nominal`).
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.modelos import (
    AcessoDadoSensivel,
    Cargo,
    EpiRequisicao,
    Servidor,
    UnidadeUorg,
    Usuario,
)
from testes.integracao.conftest import entrar

FILA = "/epis/requisicoes"

# As nove do ambiente de teste. O número não é enfeite: é a linha de base do
# relatório ("9 de 9 requisições, 200 nas nove"), e é contra ela que o depois
# desta versão se compara.
QUANTAS = 9


@pytest.fixture()
def nove(app_cliente, contas, banco) -> dict:
    """Nove servidores com um pedido cada — e o titular da conta entre eles."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        cargo = s.execute(select(Cargo)).scalars().first()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        conta_coord = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        conta_titular = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()

        servidores: list[int] = []
        requisicoes: list[int] = []
        for ordem in range(QUANTAS):
            servidor = Servidor(
                siape=f"30100{ordem:02d}",
                nome=f"Servidora Nominal {ordem}",
                cargo_id=cargo.id,
                unidade_uorg_id=unidade.id,
            )
            s.add(servidor)
            s.flush()
            requisicao = EpiRequisicao(
                servidor_id=servidor.id,
                solicitado_por_id=conta_coord.id,
                finalidade="ROTINA",
                descricao_atividade=f"Rotina de trabalho declarada pela {ordem}.",
                riscos_declarados="Agente químico e agente biológico no posto.",
                urgencia="NORMAL",
                estado="RASCUNHO",
            )
            s.add(requisicao)
            s.flush()
            servidores.append(servidor.id)
            requisicoes.append(requisicao.id)

        # o primeiro dos nove é a pessoa por trás da conta de escopo próprio
        conta_titular.servidor_id = servidores[0]
        s.commit()
    return {"servidores": servidores, "requisicoes": requisicoes}


def _acessos(campo: str | None = None) -> list[AcessoDadoSensivel]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        linhas = list(s.execute(select(AcessoDadoSensivel)).scalars())
    if campo is None:
        return linhas
    return [a for a in linhas if a.campo == campo]


# =====================================================================
# 1. A medição
# =====================================================================
def test_nove_leituras_nominais_deixam_nove_linhas(app_cliente, contas, nove):
    """O antes e o depois do relatório, no mesmo perfil que ele mediu.

    `almoxarife_sesmt` não tem `servidor_id`: pela regra de
    `auditoria.leitura_de_terceiro`, quem não é titular de linha nenhuma lê
    sempre como terceiro — e está certo, é a conta de quem opera o balcão.
    """
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert _acessos() == [], "a linha de base não era zero"

    for requisicao_id in nove["requisicoes"]:
        assert app_cliente.get(f"{FILA}/{requisicao_id}").status_code == 200

    linhas = _acessos("epi_requisicao.nominal")
    assert len(linhas) == QUANTAS
    assert {a.servidor_id for a in linhas} == set(nove["servidores"])


def test_a_linha_diz_o_que_foi_lido_e_por_que(app_cliente, contas, nove):
    """`campo` e `finalidade` preenchidos — foi a falta dos dois que fez o
    registro da porta de trás do `FICHA_EPI` não responder pergunta nenhuma."""
    entrar(app_cliente, contas, "almoxarife_sesmt")
    app_cliente.get(f"{FILA}/{nove['requisicoes'][1]}")

    linha = _acessos("epi_requisicao.nominal")[0]
    assert linha.servidor_id == nove["servidores"][1]
    assert "riscos declarados" in (linha.finalidade or "")
    assert linha.usuario_id is not None


def test_a_guia_grava_por_conta_propria(app_cliente, contas, nove):
    """A guia é o papel nominal do balcão e abre sem passar pela ficha."""
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert (
        app_cliente.get(f"{FILA}/{nove['requisicoes'][2]}/guia").status_code == 200
    )

    linhas = _acessos("epi_requisicao.guia")
    assert len(linhas) == 1
    assert linhas[0].servidor_id == nove["servidores"][2]
    assert "balcão" in (linhas[0].finalidade or "")


# =====================================================================
# 2. O que deliberadamente NÃO grava
# =====================================================================
def test_a_fila_inteira_nao_grava_uma_linha(app_cliente, contas, nove):
    """Nove pessoas numa tela, zero linhas — e é a decisão, não o esquecimento.

    A fila mostra o `SRV-xxxx` da RN-19 e serve para escolher o próximo pedido a
    analisar. Uma linha por pessoa por abertura afogaria a leitura de terceiro,
    que é o sinal, e o custo seria pago com o lock de escrita na mão.
    """
    entrar(app_cliente, contas, "almoxarife_sesmt")
    resposta = app_cliente.get(FILA)
    assert resposta.status_code == 200
    for requisicao_id in nove["requisicoes"]:
        assert f"{FILA}/{requisicao_id}" in resposta.text
    assert _acessos() == []


@pytest.mark.parametrize(
    "perfil,rota",
    [
        ("coordenador_csso", "/epis/requisicoes/servidores"),
        ("coordenador_csso", "/epis/entregas/servidores"),
    ],
)
def test_a_busca_de_servidor_por_htmx_nao_grava(
    app_cliente, contas, nove, perfil, rota
):
    """As duas buscas estreitas do módulo — e a decisão é a mesma da busca global.

    Elas devolvem pessoas, e por isso a pergunta se coloca. Três razões para não
    gravar, e a terceira é a que decide: (a) o que sai é o que a RN-19 do lado do
    filtro já autorizou — `servidores.buscar` passa por
    `identificacao.casa_a_busca`, que é a regra única de `/servidores` e da fila;
    (b) elas são fragmentos HTMX disparados **a cada tecla**, e sem busca a lista
    vem inteira, então uma gravação aqui seria N linhas por tecla digitada, com o
    `BEGIN IMMEDIATE` na mão, no balcão com fila de pé; (c) o ato que a
    investigação procura não é "digitei três letras", é abrir o registro de
    alguém — e esse ato tem tela própria, que grava.
    """
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(f"{rota}?q=").status_code == 200
    assert app_cliente.get(f"{rota}?q=Nominal").status_code == 200
    assert _acessos() == []


def test_o_titular_lendo_o_proprio_pedido_nao_grava(app_cliente, contas, nove):
    """Art. 18, II. Gravar o titular transforma em suspeita o ato que a lei garante."""
    entrar(app_cliente, contas, "servidor_consulta")
    propria = nove["requisicoes"][0]
    assert app_cliente.get(f"{FILA}/{propria}").status_code == 200
    assert app_cliente.get(f"{FILA}/{propria}/guia").status_code == 200
    assert _acessos() == []


def test_o_pedido_de_terceiro_continua_fechado_para_o_titular(
    app_cliente, contas, nove
):
    """Registrar não pode virar pretexto para abrir: o escopo da 1.35.0 de pé."""
    entrar(app_cliente, contas, "servidor_consulta")
    alheia = nove["requisicoes"][3]
    assert app_cliente.get(f"{FILA}/{alheia}", follow_redirects=False).status_code == 303
    assert (
        app_cliente.get(f"{FILA}/{alheia}/guia", follow_redirects=False).status_code
        == 303
    )
    assert _acessos() == []


def test_o_extrato_do_lote_nao_grava(app_cliente, contas, banco):
    """O extrato do lote é do LOTE, e não de quem recebeu.

    Conferido linha a linha em `paginas/epis_estoque_movimentos.html`: as colunas
    são quando, movimento, quantidade, saldo, motivo, vínculo (`ficha nº 4`, um
    id) e quem **registrou** — que é o operador do balcão, não o servidor. Não há
    "sobre quem" único: um lote atende dezenas de pessoas, e `servidor_id`
    receberia nulo, que é o registro que `anexo_acesso.Dono` descreve como
    incapaz de sustentar investigação nenhuma.
    """
    from datetime import timedelta

    from app import banco as mod_banco
    from app.modelos import EpiCategoria, EpiEntradaEstoque, EpiItem, EpiMovimentoEstoque

    with mod_banco.sessao() as s:
        categoria = s.execute(select(EpiCategoria)).scalars().first()
        item = EpiItem(
            nome="Bota de segurança",
            categoria_id=categoria.id,
            exige_ca=False,
            unidade_medida="PAR",
        )
        s.add(item)
        s.flush()
        entrada = EpiEntradaEstoque(
            epi_item_id=item.id,
            data_entrada=date.today() - timedelta(days=10),
            quantidade_recebida=5,
            lote="L-EXTRATO",
        )
        s.add(entrada)
        s.flush()
        s.add(
            EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=5)
        )
        s.commit()
        entrada_id = entrada.id

    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert (
        app_cliente.get(f"/epis/estoque/{entrada_id}/movimentos").status_code == 200
    )
    assert _acessos() == []
