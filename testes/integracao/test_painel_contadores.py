"""O painel não pode afirmar dois números para o mesmo fato.

O defeito que estes testes fecham: o cartão "Precisam de você hoje" e o link
"Ver todos", lado a lado na tela de entrada, contavam coisas diferentes.

- o cartão filtrava à mão a **primeira página de 50** que `repo.listar` devolve,
  cortava em oito e publicava `precisam_de_voce|length` — um contador que nunca
  passava de 8, qualquer que fosse a fila;
- o link levava a `/processos?atrasados=1`, que aplica um critério **menor**
  (só o SLA estourado, sem o "A fazer" que ninguém pegou);
- e o KPI "Acima do SLA" ao lado contava um terceiro recorte, esse sobre todos
  os processos.

Três definições de um fato só, e a de menor número era a que tinha o link. A
correção é uma função (`servicos.processo.precisa_de_atencao`), um filtro que a
usa (`repositorios.processos.Filtro.precisam`) e um link que aponta para ele.
"""

from __future__ import annotations

import re
from datetime import date

import pytest
from sqlalchemy import select

from testes.integracao.conftest import entrar

# mais que os oito que cabem no cartão: é o que faz o corte aparecer
QUANTOS = 11


@pytest.fixture()
def fila_de_trabalho(banco):
    """`QUANTOS` processos em 'A fazer' — todos entram em `precisa_de_atencao`."""
    from app import banco as mod_banco
    from app.modelos import FluxoEtapa, Processo, TipoProcesso

    with mod_banco.sessao() as s:
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
        tipo = s.execute(select(TipoProcesso).order_by(TipoProcesso.id)).scalars().first()
        for n in range(QUANTOS):
            s.add(
                Processo(
                    nup=f"23086.00{700 + n}00/2026-11",
                    tipo_processo_id=tipo.id,
                    etapa_id=etapa.id,
                    estado_tecnico="RECEBIDO",
                    data_autuacao=date(2026, 1, 5),
                    ano_referencia=2026,
                )
            )
        s.commit()
    return QUANTOS


def _total_da_lista(corpo: str) -> int:
    """O total que `/processos` publica no subtítulo, nas três formas dele."""
    if "Nenhum processo no filtro atual." in corpo:
        return 0
    achado = re.search(r"(\d+) de (\d+) processo\(s\) no filtro atual", corpo)
    if achado:
        return int(achado.group(2))
    achado = re.search(r"(\d+) processo\(s\) no filtro atual", corpo)
    assert achado is not None, "subtítulo de /processos não encontrado"
    return int(achado.group(1))


def test_o_contador_do_cartao_nao_para_em_oito(app_cliente, contas, fila_de_trabalho):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/").text
    # "8 de 11": a lista está cortada e a tela diz que está
    assert f"8 de {QUANTOS}" in corpo, "o cartão voltou a publicar o tamanho da lista"


def test_o_link_do_cartao_leva_a_lista_que_ele_conta(
    app_cliente, contas, fila_de_trabalho
):
    entrar(app_cliente, contas, "coordenador_csso")
    painel = app_cliente.get("/").text
    assert 'href="/processos?precisam=1">Ver todos' in painel

    lista = app_cliente.get("/processos?precisam=1").text
    assert _total_da_lista(lista) == QUANTOS


def test_kpi_do_sla_e_a_fila_dele_tambem_concordam(app_cliente, contas, fila_de_trabalho):
    """O outro par da mesma tela: "Acima do SLA" e `?atrasados=1`.

    Ele já concordava e continua concordando — o teste existe para que a
    correção do cartão não o desalinhe de carona.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    painel = app_cliente.get("/").text
    kpi = re.search(
        r"Acima do SLA</div>\s*<div class=\"medida\"><span class=\"valor\">(\d+)</span>",
        painel,
    )
    assert kpi is not None, painel
    lista = app_cliente.get("/processos?atrasados=1").text
    assert _total_da_lista(lista) == int(kpi.group(1))


def test_o_criterio_do_cartao_e_o_criterio_do_filtro(banco):
    """Uma função, e é ela que os dois lados chamam.

    Sem isto, o critério volta a ser escrito duas vezes — que é como o cartão e
    o link passaram a discordar em primeiro lugar.
    """
    from app import banco as mod_banco
    from app.modelos import FluxoEtapa, Processo, TipoProcesso
    from app.repositorios import processos as repo
    from app.servicos.processo import precisa_de_atencao, resumir
    from app.servicos.rbac import UsuarioAtual

    usuario = UsuarioAtual(
        id=1,
        login="conferente",
        nome="Conferente",
        permissoes=frozenset({"processo.ver", "exposicao.ver"}),
        perfis=("coordenador_csso",),
    )
    with mod_banco.sessao() as s:
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
        tipo = s.execute(select(TipoProcesso).order_by(TipoProcesso.id)).scalars().first()
        for n in range(3):
            s.add(
                Processo(
                    nup=f"23086.00{900 + n}00/2026-11",
                    tipo_processo_id=tipo.id,
                    etapa_id=etapa.id,
                    estado_tecnico="RECEBIDO",
                    data_autuacao=date(2026, 1, 5),
                    ano_referencia=2026,
                )
            )
        s.commit()

    with mod_banco.sessao() as s:
        _, total = repo.listar(s, usuario, repo.Filtro(precisam=True, por_pagina=1000))
        todos, _ = repo.listar(s, usuario, repo.Filtro(por_pagina=1000))
        a_mao = sum(1 for p in todos if precisa_de_atencao(resumir(s, p)))
    assert total == a_mao
