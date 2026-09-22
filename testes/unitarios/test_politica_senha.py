"""Politica de senha: 6 caracteres, letras e numeros, sem trivialidade."""

from __future__ import annotations

import pytest

from app.servicos.autenticacao import (
    TAMANHO_MINIMO_SENHA,
    conferir_senha,
    gerar_hash,
    politica_de_senha,
)


def test_minimo_e_seis():
    assert TAMANHO_MINIMO_SENHA == 6


@pytest.mark.parametrize("senha", ["csso26", "Fab2026", "Lab7x9", "a1b2c3"])
def test_senhas_aceitas(senha: str):
    assert politica_de_senha(senha) == []


@pytest.mark.parametrize(
    "senha,problema",
    [
        ("a1b2", "mínimo de 6 caracteres"),
        ("", "mínimo de 6 caracteres"),
        ("somenteletras", "misture letras e números"),
        ("123456789", "misture letras e números"),
        ("abc123", "senha trivial"),
        ("Senha123", "senha trivial"),
    ],
)
def test_senhas_recusadas(senha: str, problema: str):
    assert problema in politica_de_senha(senha)


def test_hash_continua_argon2id():
    """Encurtar a senha não afrouxa o armazenamento."""
    hash_ = gerar_hash("csso26")
    assert hash_.startswith("$argon2id$")
    assert "csso26" not in hash_
    assert conferir_senha(hash_, "csso26")
    assert not conferir_senha(hash_, "csso27")


def test_hash_e_salgado():
    assert gerar_hash("csso26") != gerar_hash("csso26")


def test_custo_de_producao_do_argon2_continua_o_do_rfc_9106():
    """A suíte roda com Argon2 barato — produção NÃO.

    A fixture `_argon2_barato` (em `testes/conftest.py`) troca o `_hasher` do
    módulo por um de custo mínimo, porque o custo real são ~83 ms por hash e a
    suíte faz milhares deles. Essa troca é exatamente o tipo de coisa que um dia
    vaza para o código que vai ao ar — e o vazamento seria invisível: o sistema
    continuaria logando, com hashes 500 vezes mais baratos de quebrar offline.

    Este teste é o que impede isso. Ele não olha o `_hasher` que está em uso
    (esse é o barato, de propósito): olha a constante que produção instancia.
    Se alguém baixar os números lá, este teste cai — e cai com o motivo escrito.

    64 MiB / 3 passagens / 2 threads é o perfil de servidor do RFC 9106.
    """
    from app.servicos.autenticacao import PARAMETROS_ARGON2_PRODUCAO

    assert PARAMETROS_ARGON2_PRODUCAO == {
        "time_cost": 3,
        "memory_cost": 65536,
        "parallelism": 2,
    }


def test_o_hasher_de_producao_nasce_dos_parametros_de_producao():
    """A constante só vale se for ela que o módulo usa.

    Sem esta segunda amarra, `PARAMETROS_ARGON2_PRODUCAO` poderia virar um
    número decorativo — correto na constante e ignorado na chamada. Lê-se a
    fonte, e não o `_hasher` do processo, porque no processo da suíte ele já foi
    trocado pelo barato.
    """
    import inspect

    from app.servicos import autenticacao

    fonte = inspect.getsource(autenticacao)
    assert "_hasher = PasswordHasher(**PARAMETROS_ARGON2_PRODUCAO)" in fonte
