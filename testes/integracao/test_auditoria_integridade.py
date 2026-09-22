"""A prova de integridade da trilha não pode depender do TIPO que o serviço gravou.

O cenário do usuário é banal: alguém corrige o SIAPE de um servidor na tela de
cadastro, ou lança a nota de uma turma. O serviço registra o antes e o depois em
`historico_evento.valor_anterior`/`valor_novo`, que são `JSONTexto`. O digest de
cada evento é calculado sobre o valor **em memória**; a conferência da cadeia lê
o valor **do banco**. Se os dois não forem o mesmo valor, `/auditoria` passa a
dizer que a trilha foi adulterada — e ninguém tocou em nada.

Era exatamente o que acontecia: `JSONTexto` gravava string crua, sem aspas de
JSON, e `"1110654"` (SIAPE) voltava do banco como o inteiro `1110654`,
`"50.00"` (nota) como o float `50.0`, `"true"` como o booleano. A trilha
encadeada por hash é a espinha da auditoria; um falso positivo aqui é pior do
que nenhuma verificação, porque quem confia nela não sabe mais de que lado está
o erro.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select

from testes.integracao.conftest import entrar

# Texto que o JSON relê como outra coisa. Nenhum é hipotético: SIAPE tem sete
# dígitos, nota e frequência saem de `Decimal`, e código UORG ("250") é o que a
# tela de catálogos edita.
TEXTO_AMBIGUO = [
    "50.00",
    "100.00",
    "1110654",
    "250",
    "0",
    "1.5e3",
    "true",
    "false",
    "null",
    "NaN",
    "[1, 2]",
    '{"a": 1}',
    '"aspas"',
]

# O que o sistema grava hoje, por tipo. Nenhum destes pode ser recusado pela
# trava: recusar gravação legítima transformaria a proteção em queda de tela.
VALOR_LEGITIMO = [
    None,
    "",
    "Marco Antônio Alves Schetino",
    "TECNICO DE LABORATORIO AREA",
    "2026-01-01",
    "007",
    "None",
    12,
    1.5,
    True,
    False,
    Decimal("50.00"),
    date(2026, 1, 1),
    datetime(2026, 1, 1, tzinfo=timezone.utc),
    {"numero": 1, "ano": 2026},
    [1, 2, 3],
]


def _registrar(s, valor):
    from app.servicos import auditoria

    return auditoria.registrar(
        s,
        entidade="servidor",
        entidade_id=1,
        tipo_evento="CAMPO_ALTERADO",
        descricao="conferência de integridade",
        campo="siape",
        valor_anterior=valor,
        valor_novo=valor,
    )


@pytest.mark.parametrize("valor", TEXTO_AMBIGUO, ids=repr)
def test_texto_que_o_json_rele_diferente_nao_quebra_a_cadeia(sessao, valor):
    """O defeito, na sua forma mínima."""
    from app.servicos import auditoria

    _registrar(sessao, valor)
    sessao.commit()
    # a conferência tem de ler o banco, e não o objeto que ficou na sessão:
    # é lendo o banco que `/auditoria` roda
    sessao.expire_all()

    ok, defeito = auditoria.cadeia_integra(sessao)
    assert ok, f"cadeia acusada de adulterada no evento {defeito} por gravar {valor!r}"


@pytest.mark.parametrize("valor", TEXTO_AMBIGUO, ids=repr)
def test_texto_ambiguo_volta_do_banco_como_texto(sessao, valor):
    """Íntegro não basta: a trilha tem de dizer o que o serviço gravou.

    Uma cadeia que confere sobre `50.0` onde o serviço gravou `"50.00"` está
    íntegra e mentindo — e é justamente a trilha que responde depois "o que foi
    alterado, de quê para quê".
    """
    from app.modelos import HistoricoEvento

    evento_id = _registrar(sessao, valor).id
    sessao.commit()
    sessao.expire_all()

    relido = sessao.get(HistoricoEvento, evento_id)
    assert relido.valor_anterior == valor
    assert relido.valor_novo == valor


@pytest.mark.parametrize("valor", VALOR_LEGITIMO, ids=repr)
def test_a_trava_aceita_o_que_o_sistema_grava_hoje(sessao, valor):
    from app.servicos import auditoria

    _registrar(sessao, valor)
    sessao.commit()
    sessao.expire_all()

    ok, defeito = auditoria.cadeia_integra(sessao)
    assert ok, f"cadeia rompida no evento {defeito} por gravar {valor!r}"


def test_decimal_continua_voltando_como_texto_decimal(sessao):
    """`Decimal` não sobrevive ao JSON, e isso é decisão antiga, não defeito.

    `default=str` transforma `Decimal('50.00')` no texto `'50.00'` — o que
    importa é que ele volte SEMPRE assim, para o digest fechar. Fixado aqui
    porque a tela de turmas depende disso (`test_a_trilha_registra_cada_lancamento`).
    """
    from app.modelos import HistoricoEvento

    evento_id = _registrar(sessao, Decimal("50.00")).id
    sessao.commit()
    sessao.expire_all()

    assert sessao.get(HistoricoEvento, evento_id).valor_novo == "50.00"


def test_a_trava_recusa_gravacao_que_o_banco_nao_devolveria_igual(sessao, monkeypatch):
    """A trava propriamente dita — o teste que impede o defeito de renascer.

    Aqui o atalho antigo de `JSONTexto` é reposto de propósito: string ia crua
    para a coluna, sem aspas de JSON. Com ele de volta, `registrar` tem de
    recusar na hora, com mensagem que diz o que fazer — e não gravar um evento
    que só vai ser descoberto meses depois, quando a conferência da cadeia
    acusar adulteração.
    """
    from app.modelos.base import JSONTexto
    from app.servicos import auditoria

    original = JSONTexto.process_bind_param

    def atalho_antigo(self, value, dialect):
        if isinstance(value, str):
            return value
        return original(self, value, dialect)

    monkeypatch.setattr(JSONTexto, "process_bind_param", atalho_antigo)

    with pytest.raises(auditoria.ValorNaoAuditavel) as erro:
        _registrar(sessao, "50.00")
    assert "valor_anterior" in str(erro.value)

    # e nada foi gravado: evento com digest que não fecha é pior que evento nenhum
    sessao.rollback()
    from app.modelos import HistoricoEvento

    assert sessao.execute(select(HistoricoEvento)).scalars().all() == []


# ---------------------------------------------------------------------
# Pela porta da frente
# ---------------------------------------------------------------------
def test_corrigir_o_siape_na_tela_nao_acusa_adulteracao(app_cliente, contas, banco):
    """O caso real: SIAPE é texto de sete dígitos e passa por `registrar_diferencas`.

    Antes da correção, `/auditoria` acusava adulteração logo depois de alguém
    corrigir um SIAPE digitado errado — a operação mais banal do cadastro.
    """
    from app import banco as mod_banco
    from app.modelos import Cargo, Servidor, UnidadeUorg
    from app.servicos import auditoria

    with mod_banco.sessao() as s:
        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        cargo = s.execute(
            select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
        ).scalar_one()
        servidor = Servidor(
            siape="1110654",
            nome="Marco Antônio Alves Schetino",
            cargo_id=cargo.id,
            unidade_uorg_id=famed.id,
        )
        s.add(servidor)
        s.commit()
        servidor_id = servidor.id

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        f"/servidores/{servidor_id}",
        data={
            "nome": "Marco Antônio Alves Schetino",
            "siape": "1110655",
            "email": "",
            "situacao": "ATIVO",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303, resposta.text

    with mod_banco.sessao() as s:
        ok, defeito = auditoria.cadeia_integra(s)
    assert ok, f"cadeia acusada de adulterada no evento {defeito} após corrigir o SIAPE"

    # a tela de auditoria é quem dá a notícia ao usuário: ela não pode dar alarme falso
    entrar(app_cliente, contas, "auditor_interno")
    corpo = app_cliente.get("/auditoria").text
    assert "1110655" in corpo
