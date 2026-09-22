"""Duas pessoas no mesmo rascunho: quem salva por ultimo nao apaga quem salvou antes.

Ate a 1.42.2 o segundo salvamento gravava por cima, e o texto do primeiro sumia
em silencio (recuperavel so garimpando a trilha). A trava e a `versao` que o
formulario leva e a rota confere.
"""

from __future__ import annotations

import re

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.modelos import ParecerTecnico
from testes.integracao.conftest import entrar
from testes.integracao.test_editor_ajustes import _abrir_rascunho


def _versao_na_tela(cliente, caminho) -> str:
    corpo = cliente.get(caminho).text
    achado = re.search(r'name="versao_lida" value="(\d+)"', corpo)
    assert achado, "o formulario tem de levar a versao que foi lida"
    return achado.group(1)


def _gravado(campo: str):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return getattr(s.execute(select(ParecerTecnico)).scalars().one(), campo)


def test_segunda_pessoa_com_versao_velha_e_recusada(app_cliente, contas, banco):
    from app.principal import criar_app

    caminho = _abrir_rascunho(app_cliente, contas)

    with TestClient(criar_app(), raise_server_exceptions=False) as outra:
        entrar(outra, contas, "tecnico_seguranca")
        # as duas abrem a tela na mesma versao
        lida_coordenador = _versao_na_tela(app_cliente, caminho)
        lida_tecnica = _versao_na_tela(outra, caminho)
        assert lida_coordenador == lida_tecnica

        # a tecnica salva primeiro
        primeira = outra.post(
            caminho,
            data={
                "ano": "2026",
                "versao_lida": lida_tecnica,
                "texto_alteracao": "Texto da técnica.",
            },
            follow_redirects=False,
        )
        assert primeira.status_code == 303

    # o coordenador salva com a versao que tinha lido
    segunda = app_cliente.post(
        caminho,
        data={
            "ano": "2026",
            "versao_lida": lida_coordenador,
            "texto_alteracao": "Texto do coordenador.",
        },
    )
    assert segunda.status_code == 200
    assert "Técnica de Teste salvou este parecer" in segunda.text
    assert "Nada do que você enviou foi gravado" in segunda.text
    # o que ele escreveu nao se perde: volta num quadro para reaplicar
    assert "Não gravado" in segunda.text
    assert "Texto do coordenador." in segunda.text

    assert _gravado("texto_alteracao") == "Texto da técnica."


def test_a_mesma_pessoa_em_duas_abas_e_avisada_como_tal(app_cliente, contas, banco):
    caminho = _abrir_rascunho(app_cliente, contas)
    lida = _versao_na_tela(app_cliente, caminho)

    app_cliente.post(
        caminho,
        data={"ano": "2026", "versao_lida": lida, "texto_reavaliacao": "Aba 1."},
        follow_redirects=False,
    )
    resposta = app_cliente.post(
        caminho, data={"ano": "2026", "versao_lida": lida, "texto_reavaliacao": "Aba 2."}
    )
    assert "Você mesmo salvou este parecer em outra aba" in resposta.text
    assert _gravado("texto_reavaliacao") == "Aba 1."


def test_versao_em_dia_salva_normalmente(app_cliente, contas, banco):
    caminho = _abrir_rascunho(app_cliente, contas)
    for texto in ("Primeiro.", "Segundo."):
        lida = _versao_na_tela(app_cliente, caminho)
        resposta = app_cliente.post(
            caminho,
            data={"ano": "2026", "versao_lida": lida, "texto_alteracao": texto},
            follow_redirects=False,
        )
        assert resposta.status_code == 303
        assert _gravado("texto_alteracao") == texto


def test_recusa_nao_consome_versao_nem_escreve_auditoria(app_cliente, contas, banco):
    from app import banco as mod_banco
    from app.modelos import HistoricoEvento

    caminho = _abrir_rascunho(app_cliente, contas)
    lida = _versao_na_tela(app_cliente, caminho)
    app_cliente.post(
        caminho,
        data={"ano": "2026", "versao_lida": lida, "texto_alteracao": "Vale."},
        follow_redirects=False,
    )
    versao = _gravado("versao")
    with mod_banco.sessao() as s:
        eventos = len(s.execute(select(HistoricoEvento.id)).all())

    app_cliente.post(
        caminho, data={"ano": "2026", "versao_lida": lida, "texto_alteracao": "Não vale."}
    )
    assert _gravado("versao") == versao
    with mod_banco.sessao() as s:
        assert len(s.execute(select(HistoricoEvento.id)).all()) == eventos
