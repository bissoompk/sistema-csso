"""Cartões que não são processo (títulos reais do quadro SEI)."""

from __future__ import annotations

import pytest

from app.servicos.importacao_trello import _e_cartao_de_processo


def cartao(nome: str) -> dict:
    return {"name": nome}


NAO_SAO_PROCESSO = [
    "1-Modelo",
    "MODELO",
    "Laudos MODELO para Dr. Evanildo",
    "ADICIONAL DE INSALUBRIDADE ANTIGO",
    "Pessoal: Conversão de Tempo Especial em Comum - desativado",
    "Modelo de parecer",
    "PROCESSO ANTIGO - não usar",
]

SAO_PROCESSO = [
    "MARCÍLIO COELHO FERREIRA 01-2025",
    "Jaqueline G V P Miranda",
    "GENILTON DOS SANTOS",
    "Ana Mara Fonseca Nunes",
    "Christiane Motta Araujo",
]


@pytest.mark.parametrize("nome", NAO_SAO_PROCESSO)
def test_recusa_cartao_que_nao_e_processo(nome: str):
    """A palavra aparece no MEIO do título — foi assim que passou batido antes."""
    assert _e_cartao_de_processo(cartao(nome), "23086.000608/2026-84", None) is False


@pytest.mark.parametrize("nome", SAO_PROCESSO)
def test_aceita_cartao_de_processo(nome: str):
    assert _e_cartao_de_processo(cartao(nome), "23086.000608/2026-84", None) is True


def test_sem_nup_e_sem_servidor_nao_e_processo():
    assert _e_cartao_de_processo(cartao("FULANO DE TAL"), None, None) is False


def test_sem_nup_mas_com_servidor_casado_e_processo():
    assert _e_cartao_de_processo(cartao("FULANO DE TAL"), None, object()) is True


def test_nome_de_servidor_com_palavra_parecida_nao_e_recusado():
    """'Antigone', 'Modelos' como sobrenome — a busca é por palavra inteira."""
    assert _e_cartao_de_processo(cartao("ANTIGONE SILVA"), "23086.000608/2026-84", None) is True
