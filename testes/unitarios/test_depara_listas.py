"""De-para das listas do quadro real "SEI" (23 listas, 727 cartoes).

Os nomes abaixo foram lidos do quadro em 11/08/2026. Se alguem renomear uma
lista no Trello, este teste quebra antes da carga - que e exatamente o ponto:
lista nao mapeada nunca vira chute.
"""

from __future__ import annotations

import pytest

from app.servicos.importacao_trello import DEPARA_LISTAS, _mapear_lista

# (nome exatamente como esta no quadro, cartoes abertos em 11/08/2026)
LISTAS_REAIS = [
    ("Painel Geral", 1),
    ("Painel de Controle", 5),
    ("Entrada", 2),
    ("Processos", 16),
    ("Delegar", 1),
    ("Não Iniciado", 3),
    ("A fazer", 5),
    ("Em andamento", 4),
    ("Aguardando", 4),
    ("Adicional Ocupacional", 381),
    ("Adicional Ocupacional - Campus Avançados", 10),
    ("Aposentadoria Especial = Concluídos", 50),
    ("Concluído 2026", 18),
    ("Concluído 2025", 35),
    ("Processos Geral - Informação", 6),
    ("Concluído 2024", 28),
    ("Adicional Ocupacional - Digitalizados", 12),
    ("Comissões", 6),
    ("Concluído 2023", 35),
    ("Concluído 2020", 2),
    ("Concluído - 2021", 38),
    ("Processos Concluidos - 2022", 53),
    ("Concluído 2022", 12),
]

TOTAL_CARTOES = 727


def test_o_quadro_real_tem_23_listas():
    assert len(LISTAS_REAIS) == 23
    assert sum(n for _nome, n in LISTAS_REAIS) == TOTAL_CARTOES


@pytest.mark.parametrize("nome,_n", LISTAS_REAIS)
def test_toda_lista_do_quadro_esta_mapeada(nome: str, _n: int):
    assert _mapear_lista(nome) is not None, f"lista sem de-para: {nome!r}"


def test_nenhum_cartao_do_quadro_seria_rejeitado_por_lista():
    perdidos = sum(n for nome, n in LISTAS_REAIS if _mapear_lista(nome) is None)
    assert perdidos == 0


@pytest.mark.parametrize(
    "nome,ano",
    [
        ("Concluído 2026", 2026),
        ("Concluído 2020", 2020),
        ("Concluído - 2021", 2021),          # com hifen
        ("Processos Concluidos - 2022", 2022),  # outra grafia, sem acento
    ],
)
def test_listas_de_concluidos_extraem_o_exercicio(nome: str, ano: int):
    regra = _mapear_lista(nome)
    assert regra["ano_referencia"] == ano
    assert regra["situacao"] == "CONCLUIDO"


def test_dois_anos_de_2022_convivem():
    """O quadro tem 'Processos Concluidos - 2022' (53) e 'Concluído 2022' (12)."""
    a = _mapear_lista("Processos Concluidos - 2022")
    b = _mapear_lista("Concluído 2022")
    assert a["ano_referencia"] == b["ano_referencia"] == 2022


@pytest.mark.parametrize(
    "nome", ["Painel Geral", "Painel de Controle", "Processos Geral - Informação"]
)
def test_paineis_nao_viram_processo(nome: str):
    assert _mapear_lista(nome).get("ignorar") is True


@pytest.mark.parametrize(
    "nome,tipo",
    [
        ("Adicional Ocupacional", "ADICIONAL_OCUPACIONAL"),
        ("Adicional Ocupacional - Digitalizados", "ADICIONAL_OCUPACIONAL"),
        ("Adicional Ocupacional - Campus Avançados", "ADICIONAL_OCUPACIONAL"),
        ("Aposentadoria Especial = Concluídos", "APOSENTADORIA_ESPECIAL"),
        ("Comissões", "CONSULTA_NORMATIVA"),
    ],
)
def test_tipo_de_processo_por_lista(nome: str, tipo: str):
    assert _mapear_lista(nome)["tipo"] == tipo


def test_repositorios_sao_marcados_como_tal():
    for nome in (
        "Adicional Ocupacional",
        "Adicional Ocupacional - Digitalizados",
        "Adicional Ocupacional - Campus Avançados",
        "Aposentadoria Especial = Concluídos",
    ):
        assert _mapear_lista(nome)["repositorio"] is True


def test_lista_desconhecida_continua_sem_mapeamento():
    """A trava tem de continuar valendo para o que ninguém previu."""
    assert _mapear_lista("Lista inventada agora") is None
    assert _mapear_lista("") is None
    assert _mapear_lista(None) is None


def test_de_para_nao_inventa_estado_fora_da_maquina():
    from app.modelos.estados import ESTADOS_PROCESSO

    for regra in DEPARA_LISTAS.values():
        if regra.get("ignorar"):
            continue
        assert regra["estado"] in ESTADOS_PROCESSO
