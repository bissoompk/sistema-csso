from __future__ import annotations

import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))


@pytest.fixture(scope="session", autouse=True)
def _ambiente_de_teste():
    """Entrega a caixa de areia ja montada pelo conftest.py da RAIZ.

    A montagem NAO pode morar aqui: fixture roda no setup do primeiro teste,
    depois de `app.config` ja ter sido importado na coleta. Aqui so se consome
    o que ja esta pronto - e se confere que esta mesmo.
    """
    from conftest import CAIXA_DE_AREIA, violacoes_de_isolamento
    from app.config import obter_config

    obter_config()
    assert not violacoes_de_isolamento()
    yield CAIXA_DE_AREIA


@pytest.fixture(scope="session", autouse=True)
def _argon2_barato():
    """Troca o custo do Argon2id pelo mínimo, só dentro da suíte.

    O hash de produção custa ~83 ms medidos (64 MiB, 3 passagens). O fixture
    `contas` cria 12 contas por teste de integração, e quase todo teste faz
    login por cima: só em `test_web_fluxo.py` foram 112 hashes e 13 verificações
    em 17 testes — 11,0 s dos 32,4 s do arquivo, gastos provando repetidamente
    que a biblioteca de hash funciona.

    O que se troca é só o CUSTO. Continua sendo Argon2id de verdade, com salt
    aleatório, e `verify` continua lendo os parâmetros do próprio hash — por
    isso nada nos testes precisa saber que a troca aconteceu.

    A troca mexe em `_hasher`, e nunca em `PARAMETROS_ARGON2_PRODUCAO`: é a
    constante que diz o que vai para produção, e há teste amarrado nela
    (`test_politica_senha.py`) justamente para esta fixture não conseguir
    afrouxar o sistema de verdade sem que alguém veja.
    """
    from argon2 import PasswordHasher

    from app.servicos import autenticacao

    original = autenticacao._hasher
    autenticacao._hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)
    yield
    autenticacao._hasher = original


@pytest.fixture()
def banco(_ambiente_de_teste, tmp_path):
    """Banco SQLite limpo, com esquema, triggers e seeds."""
    from app import banco as mod_banco
    from app.servicos import sementes

    url = f"sqlite+pysqlite:///{(tmp_path / 'teste.db').as_posix()}"
    engine = mod_banco.redefinir_engine(url)
    mod_banco.criar_esquema(engine)
    with mod_banco.sessao() as s:
        sementes.semear(s)
    yield engine
    engine.dispose()


@pytest.fixture()
def sessao(banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        yield s
