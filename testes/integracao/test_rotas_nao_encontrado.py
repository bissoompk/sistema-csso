"""Ficha de registro inexistente não pode responder "200 OK".

O usuário digita `/processos/9999`, o sistema desenha a tela que diz "processo
não encontrado" — e devolve **200**. O navegador guarda a página no histórico
como sucesso, o `curl` de um script de conferência acha que deu certo, e um
monitor de disponibilidade nunca vê o erro. A tela está certa; o status mente.

O contrário também vale: onde a rota decide **voltar para a lista** em vez de
mostrar erro, a decisão é dela e este teste a preserva. O que ele proíbe é a
terceira forma — 200 com uma página que diz "não encontrado".
"""

from __future__ import annotations

import pytest

from testes.integracao.conftest import entrar

INEXISTENTE = 999999

# Toda ficha de registro do sistema. Rota nova entra aqui — descobrir o defeito
# olhando a tela, como foi desta vez, é caro demais para virar o método.
FICHAS = [
    "/processos",
    "/pareceres",
    "/laudos",
    "/servidores",
    "/turmas",
    "/certificados",
    "/treinamentos/modelos",
    "/epis/requisicoes",
    "/demandas",
]


@pytest.mark.parametrize("prefixo", FICHAS)
def test_ficha_inexistente_nao_responde_200(app_cliente, contas, prefixo):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get(
        f"{prefixo}/{INEXISTENTE}",
        headers={"accept": "text/html"},
        follow_redirects=False,
    )
    assert resposta.status_code != 200, (
        f"{prefixo}/{INEXISTENTE} respondeu 200 — o navegador e qualquer "
        "integração leem como sucesso"
    )
    assert resposta.status_code in (303, 404), (
        f"{prefixo}/{INEXISTENTE}: esperado 404 (erro) ou 303 (volta à lista), "
        f"veio {resposta.status_code}"
    )


# Download e prévia não são ficha: não têm para onde redirecionar. Devolver a
# lista de processos a quem pediu um `.docx` entrega HTML no lugar do arquivo, e
# o fragmento da prévia é buscado por HTMX, que não navega. Aqui é 404 sempre.
ENTREGAS_DE_PARECER = [
    "/pareceres/{id}/docx",
    "/pareceres/{id}/pdf",
    "/pareceres/{id}/previa",
]


@pytest.mark.parametrize("rota", ENTREGAS_DE_PARECER)
def test_entrega_de_parecer_inexistente_devolve_404_e_nao_500(app_cliente, contas, rota):
    """Sem a conferência, `s.get()` devolve None e o AttributeError vira 500.

    500 diz "o sistema quebrou" a quem apenas digitou um id que não existe — e
    esconde o defeito real no meio dos erros de infraestrutura do monitoramento.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get(
        rota.format(id=INEXISTENTE),
        headers={"accept": "text/html"},
        follow_redirects=False,
    )
    assert resposta.status_code == 404, (
        f"{rota.format(id=INEXISTENTE)}: esperado 404, veio {resposta.status_code}"
    )


def test_processo_inexistente_devolve_404_com_a_tela_de_erro(app_cliente, contas):
    """O caso relatado, por inteiro: o status certo E a tela que explica."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get(
        f"/processos/{INEXISTENTE}", headers={"accept": "text/html"}
    )
    assert resposta.status_code == 404
    assert '<aside class="lateral">' in resposta.text, "a tela de erro sai com a casca"
    assert "não existe ou está fora do seu escopo" in resposta.text


def test_processo_inexistente_responde_json_para_quem_nao_pede_html(app_cliente, contas):
    """"Qualquer integração" é o outro lado do defeito.

    Cliente que não pede HTML recebe o JSON de sempre — mas com 404, que é o que
    ele lê para decidir se deu certo.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get(f"/processos/{INEXISTENTE}", headers={"accept": "*/*"})
    assert resposta.status_code == 404
    assert resposta.json()["detail"]


def test_processo_existente_continua_abrindo(app_cliente, contas, banco):
    """O contrapeso: a correção não pode transformar ficha boa em 404."""
    from datetime import date

    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import FluxoEtapa, Processo, TipoProcesso

    with mod_banco.sessao() as s:
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
        tipo = s.execute(select(TipoProcesso).order_by(TipoProcesso.id)).scalars().first()
        processo = Processo(
            nup="23086.000901/2026-19",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico="EM_TRIAGEM",
            data_autuacao=date(2026, 3, 1),
            ano_referencia=2026,
        )
        s.add(processo)
        s.commit()
        processo_id = processo.id

    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get(f"/processos/{processo_id}").status_code == 200
