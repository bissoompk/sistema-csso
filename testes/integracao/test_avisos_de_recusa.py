"""Recusa não sai no banner verde.

`base.html` pinta `mensagem` de verde (`.aviso-ok`) e `erro` de vermelho
(`.aviso-erro`). O módulo Certificados e Treinamentos tinha um canal só — o
verde — e mandava a recusa por ele: "Informe a data de início (AAAA-MM-DD)." e
"Ninguém apto a emitir nesta turma." chegavam à tela com a mesma cor de "Turma
TUR-2026-0001 aberta." Numa turma, a diferença entre emitiu e não emitiu passou
a estar na cor de uma caixa, e a cor estava errada.

O mesmo padrão vivia em `/treinamentos/*`, `/epis/catalogo/*`, `/catalogos/*`,
`/usuarios` e na conclusão de pendência — sempre pela mesma causa: a rota GET
que recebe o aviso não aceitava `erro`, então não havia para onde mandá-lo.

O teste que impede a volta é o último daqui: **toda rota de página que aceita
`mensagem` tem de aceitar `erro`**. É o invariante, e não a lista de casos, que
protege o módulo que ainda não existe.
"""

from __future__ import annotations

import inspect
import re
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from testes.integracao.conftest import entrar

INICIO = date.today() + timedelta(days=30)


def _faixa(corpo: str, texto: str) -> str | None:
    """A classe da caixa de aviso que carrega `texto`, ou None se não houver.

    `[^>]*` no fim da abertura, e não `>`: a recusa de um CADASTRO agora sai
    dentro do popup (`popup_cadastro`, em `partes/macros.html`), e lá a caixa
    leva `role="alert"` junto. O que este teste cobra é a COR — que a recusa não
    saia no verde do sucesso —, e ela é a mesma nos dois lugares.
    """
    achado = re.search(
        r'<div class="aviso (aviso-\w+)"[^>]*>\s*' + re.escape(texto), corpo
    )
    return achado.group(1) if achado else None


@pytest.fixture()
def treinamento(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/treinamentos/catalogo",
        data={
            "codigo": "NR-35",
            "nome": "Trabalho em Altura — NR-35",
            "carga_horaria_horas": "8",
            "validade_meses": "24",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    from app import banco as mod_banco
    from app.modelos import Treinamento

    with mod_banco.sessao() as s:
        return s.execute(
            select(Treinamento).where(Treinamento.codigo == "NR-35")
        ).scalar_one().id


def test_turma_sem_data_de_inicio_sai_em_vermelho(app_cliente, contas, treinamento):
    resposta = app_cliente.post(
        "/turmas",
        data={"treinamento_id": str(treinamento), "data_inicio": "", "data_fim": ""},
        follow_redirects=True,
    )
    assert resposta.status_code == 200
    assert (
        _faixa(resposta.text, "Informe a data de início (AAAA-MM-DD).") == "aviso-erro"
    )


def test_emissao_sem_ninguem_apto_sai_em_vermelho(app_cliente, contas, treinamento):
    from app import banco as mod_banco
    from app.modelos import Turma

    criada = app_cliente.post(
        "/turmas",
        data={
            "treinamento_id": str(treinamento),
            "data_inicio": INICIO.isoformat(),
            "data_fim": (INICIO + timedelta(days=1)).isoformat(),
        },
        follow_redirects=False,
    )
    assert criada.status_code == 303, criada.text
    with mod_banco.sessao() as s:
        turma_id = s.execute(select(Turma)).scalars().one().id

    resposta = app_cliente.post(
        f"/turmas/{turma_id}/certificados", data={}, follow_redirects=True
    )
    assert resposta.status_code == 200
    assert _faixa(resposta.text, "Ninguém apto a emitir nesta turma.") == "aviso-erro"


def test_sucesso_continua_em_verde(app_cliente, contas, treinamento):
    """A correção não pode pintar tudo de vermelho: o verde tem de continuar
    significando o que significava."""
    resposta = app_cliente.post(
        "/turmas",
        data={
            "treinamento_id": str(treinamento),
            "data_inicio": INICIO.isoformat(),
            "data_fim": (INICIO + timedelta(days=1)).isoformat(),
        },
        follow_redirects=True,
    )
    assert 'class="aviso aviso-ok"' in resposta.text
    assert "aberta." in resposta.text


def test_catalogo_recusa_duplicata_em_vermelho(app_cliente, contas, treinamento):
    """`/treinamentos/catalogo`: mesmo defeito, outro módulo."""
    resposta = app_cliente.post(
        "/treinamentos/catalogo",
        data={
            "codigo": "NR-35",
            "nome": "Trabalho em Altura — NR-35",
            "carga_horaria_horas": "8",
            "validade_meses": "24",
        },
        follow_redirects=True,
    )
    assert 'class="aviso aviso-erro"' in resposta.text
    assert "Já existe treinamento" in resposta.text


def test_catalogo_de_epi_recusa_em_vermelho(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/epis/catalogo/motivos-recusa",
        data={"codigo": "COM-HIFEN", "rotulo": "x", "texto": "y"},
        follow_redirects=True,
    )
    assert (
        _faixa(resposta.text, "Código inválido: use letras maiúsculas")
        == "aviso-erro"
    )


def test_catalogo_base_recusa_em_vermelho(app_cliente, contas):
    """`/catalogos/*` montava o redirect à mão, sempre com `mensagem=`."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/catalogos/cargos", data={"nome": "   "}, follow_redirects=True
    )
    assert (
        _faixa(resposta.text, "O nome do cargo não pode ficar em branco.")
        == "aviso-erro"
    )


def test_toda_rota_que_aceita_mensagem_aceita_erro():
    """O invariante. Sem ele, o módulo seguinte repete o defeito por omissão:
    quem escreve a rota GET não tem como saber que o canal vermelho existe."""
    from app.principal import criar_app

    def _folhas(rotas):
        """As versões novas do FastAPI embrulham cada router incluído num
        `_IncludedRouter`, que guarda o original em `original_router`. Sem descer
        até lá, o laço não acha rota nenhuma e o teste passa por vazio — que é
        pior do que não existir."""
        for rota in rotas:
            interno = getattr(rota, "original_router", None)
            aninhadas = getattr(interno or rota, "routes", None)
            if aninhadas:
                yield from _folhas(aninhadas)
            elif getattr(rota, "endpoint", None) is not None:
                yield rota

    encontradas = list(_folhas(criar_app().routes))
    assert len(encontradas) > 100, "o teste não achou as rotas — invariante não cobrado"

    sem_erro = []
    for rota in encontradas:
        endpoint = rota.endpoint
        if "GET" not in (getattr(rota, "methods", None) or set()):
            continue
        parametros = inspect.signature(endpoint).parameters
        if "mensagem" in parametros and "erro" not in parametros:
            sem_erro.append(f"{endpoint.__module__}.{endpoint.__name__}")
    assert not sem_erro, (
        "rota de página que recebe aviso mas não sabe receber recusa — a recusa "
        f"vai sair no banner verde: {sem_erro}"
    )
