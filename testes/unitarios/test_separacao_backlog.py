"""Separação do backlog: cadastro histórico x trabalho pendente.

Conferido contra o quadro real em 11/08/2026: dos 382 cartões da lista
"Adicional Ocupacional", 28 têm rastro de trabalho e 354 são apenas nome +
número de processo parados há anos.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.servicos.importacao_trello import DIAS_PARA_HISTORICO, classificar_backlog

HOJE = date(2026, 8, 11)
ANTIGO = "2021-05-20T10:00:00.000Z"   # ~1.909 dias
RECENTE = "2026-06-26T10:00:00.000Z"  # ~46 dias


def cartao(**campos) -> dict:
    base = {
        "name": "FULANO DE TAL",
        "desc": "SEI 23086.000171/1993-41",
        "dateLastActivity": ANTIGO,
        "badges": {"attachments": 0, "checkItems": 0, "comments": 0},
    }
    base.update(campos)
    return base


def test_cadastro_historico_e_so_nome_e_numero():
    c = classificar_backlog(cartao(), HOJE)
    assert c.historico is True
    assert "somente nome e número" in c.motivo


def test_sem_descricao_nenhuma_tambem_e_historico():
    assert classificar_backlog(cartao(desc=""), HOJE).historico is True


@pytest.mark.parametrize(
    "campos,esperado",
    [
        ({"badges": {"attachments": 1, "checkItems": 0, "comments": 0}}, "tem anexo"),
        ({"badges": {"attachments": 0, "checkItems": 4, "comments": 0}}, "tem checklist"),
        ({"badges": {"attachments": 0, "checkItems": 0, "comments": 2}}, "tem comentário"),
        ({"due": "2026-04-18T00:00:00.000Z"}, "tem prazo em aberto"),
        ({"dateLastActivity": RECENTE}, "movimentado há 46 dias"),
    ],
)
def test_qualquer_rastro_de_trabalho_mantem_na_fila(campos, esperado):
    c = classificar_backlog(cartao(**campos), HOJE)
    assert c.historico is False
    assert esperado in c.motivo


def test_prazo_ja_cumprido_nao_conta_como_rastro():
    c = classificar_backlog(
        cartao(due="2021-04-18T00:00:00.000Z", dueComplete=True), HOJE
    )
    assert c.historico is True


def test_descricao_com_conteudo_conta():
    c = classificar_backlog(
        cartao(
            desc="SEI 23086.000171/1993-41 — aguardando o formulário do art. 17 "
            "assinado pela chefia do laboratório"
        ),
        HOJE,
    )
    assert c.historico is False
    assert "descrição com conteúdo" in c.motivo


def test_a_descricao_padrao_do_cadastro_nao_conta():
    """'SEI 23086.xxxxxx/aaaa-dd' é a descrição de 92% do backlog."""
    for texto in (
        "SEI 23086.000171/1993-41",
        "sei 23086.000519/2011-51",
        "  SEI  23086.002359/2011-85  ",
    ):
        assert classificar_backlog(cartao(desc=texto), HOJE).historico is True


def test_fronteira_de_um_ano():
    from datetime import timedelta

    limite = HOJE - timedelta(days=DIAS_PARA_HISTORICO)
    dentro = limite.isoformat() + "T12:00:00.000Z"
    fora = (limite - timedelta(days=2)).isoformat() + "T12:00:00.000Z"
    assert classificar_backlog(cartao(dateLastActivity=dentro), HOJE).historico is False
    assert classificar_backlog(cartao(dateLastActivity=fora), HOJE).historico is True


def test_cartao_sem_data_de_atividade():
    assert classificar_backlog(cartao(dateLastActivity=None), HOJE).historico is True


def test_anexo_pela_lista_e_nao_so_pelo_badge():
    c = classificar_backlog(cartao(attachments=[{"name": "laudo.pdf"}]), HOJE)
    assert c.historico is False


def test_o_motivo_e_legivel_para_o_coordenador():
    c = classificar_backlog(
        cartao(dateLastActivity=RECENTE, due="2026-04-18T00:00:00.000Z"), HOJE
    )
    assert c.motivo == "tem prazo em aberto; movimentado há 46 dias"


# ---------------------------------------------------------------------
def test_separacao_no_importador(sessao):
    """O pendente sobe para a fila; o histórico fica no repositório."""
    import json
    from pathlib import Path

    from app.modelos import Processo, Usuario
    from app.servicos import autenticacao, importacao_trello as imp
    from app.servicos.rbac import UsuarioAtual

    usuario = Usuario(
        login="mig",
        nome="Migrador",
        email="mig@teste.ufvjm.edu.br",
        senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
    )
    sessao.add(usuario)
    sessao.flush()
    atual = UsuarioAtual(
        id=usuario.id,
        login="mig",
        nome="Migrador",
        permissoes=frozenset({"catalogo.gerenciar", "anexo.enviar"}),
        perfis=("coordenador_csso",),
    )

    quadro = {
        "id": "q1",
        "name": "SEI",
        "lists": [{"id": "l6", "name": "Adicional Ocupacional"}],
        "cards": [
            {
                # nome neutro de propósito: 'ANTIGO' no título é palavra
                # reservada da regra CARTAO_NAO_PROCESSO
                "id": "hist1",
                "name": "MARIA DA SILVA PARADA",
                "desc": "SEI 23086.003498/2015-50",
                "idList": "l6",
                "dateLastActivity": ANTIGO,
            },
            {
                "id": "pend1",
                "name": "JOAO SOUZA ATIVO",
                "desc": "SEI 23086.002365/2016-47",
                "idList": "l6",
                "dateLastActivity": RECENTE,
            },
        ],
        "actions": [],
    }
    arquivo = Path(sessao.get_bind().url.database).parent / "quadro.json"
    arquivo.write_text(json.dumps(quadro), encoding="utf-8")

    relatorio = imp.importar(sessao, arquivo, atual, aplicar=True, buscar_anexo=None)
    sessao.flush()

    assert relatorio.backlog_historico == 1
    assert relatorio.backlog_pendente == 1
    assert relatorio.motivos_pendente[0]["cartao"] == "JOAO SOUZA ATIVO"

    historico = sessao.query(Processo).filter_by(nup="23086.003498/2015-50").one()
    pendente = sessao.query(Processo).filter_by(nup="23086.002365/2016-47").one()
    assert historico.origem_repositorio is True
    assert historico.estado_tecnico == "RECEBIDO"
    assert pendente.origem_repositorio is False
    assert pendente.estado_tecnico == "EM_TRIAGEM"


def test_indicadores_ignoram_o_repositorio(sessao):
    """354 registros de arquivo não podem virar 354 'pendências' no painel."""
    from app.modelos import FluxoEtapa, Processo, TipoProcesso, Usuario
    from app.repositorios import processos as repo
    from app.servicos import autenticacao
    from app.servicos.rbac import UsuarioAtual

    usuario = Usuario(
        login="ind",
        nome="Indicador",
        email="ind@teste.ufvjm.edu.br",
        senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
    )
    sessao.add(usuario)
    sessao.flush()
    atual = UsuarioAtual(
        id=usuario.id,
        login="ind",
        nome="Indicador",
        permissoes=frozenset({"processo.ver"}),
        perfis=("coordenador_csso",),
    )
    tipo = sessao.query(TipoProcesso).first()
    etapa = sessao.query(FluxoEtapa).filter_by(codigo="A_FAZER").one()
    sessao.add_all(
        [
            Processo(
                nup="23086.000608/2026-84",
                tipo_processo_id=tipo.id,
                etapa_id=etapa.id,
                estado_tecnico="EM_TRIAGEM",
                origem_repositorio=False,
            ),
            Processo(
                nup="23086.000540/2026-33",
                tipo_processo_id=tipo.id,
                etapa_id=etapa.id,
                estado_tecnico="RECEBIDO",
                origem_repositorio=True,
            ),
        ]
    )
    sessao.flush()

    kpis = repo.indicadores(sessao, atual)
    assert kpis["total"] == 1
    assert kpis["a_fazer"] == 1
