"""Visoes salvas que filtram de verdade, agrupamento e acoes em lote."""

from __future__ import annotations

import re
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.modelos import (
    AgenteNocivo,
    Anexo,
    Exposicao,
    FluxoEtapa,
    ParecerTecnico,
    Processo,
    TipoProcesso,
    agora_utc,
)
from app.repositorios import processos as repo
from app.servicos.processo import CHAVES_AGRUPAMENTO, agrupar
from testes.integracao import papeis
from testes.integracao.conftest import entrar


@pytest.fixture()
def coord(atores):
    return papeis.COORDENADOR


def _processo(sessao, nup: str, **campos) -> Processo:
    tipo = sessao.execute(select(TipoProcesso)).scalars().first()
    etapa = sessao.execute(
        select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
    ).scalar_one()
    processo = Processo(
        nup=nup, tipo_processo_id=tipo.id, etapa_id=etapa.id, **campos
    )
    sessao.add(processo)
    sessao.flush()
    return processo


# ---------------------------------------------------------------------
def test_visao_parados_ha_mais_de_90_dias(sessao, coord):
    antigo = _processo(sessao, "23086.000608/2026-84")
    antigo.entrou_na_etapa_em = agora_utc() - timedelta(days=120)
    novo = _processo(sessao, "23086.000540/2026-33")
    novo.entrou_na_etapa_em = agora_utc() - timedelta(days=3)
    sessao.flush()

    itens, total = repo.listar(sessao, coord, repo.Filtro(dias_parado=90))
    assert total == 1
    assert itens[0].id == antigo.id


def test_visao_sem_numero_sei(sessao, coord):
    com = _processo(sessao, "23086.000608/2026-84", url_permanente="https://sei/x")
    sem = _processo(sessao, "23086.000540/2026-33")
    itens, total = repo.listar(sessao, coord, repo.Filtro(sem_numero_sei=True))
    assert total == 1 and itens[0].id == sem.id
    _ = com


def test_visao_sem_percentual(sessao, cenario, coord):
    """O processo do cenário tem exposição; um novo, não."""
    sem_parecer = _processo(sessao, "23086.000608/2026-84")
    itens, _total = repo.listar(sessao, coord, repo.Filtro(sem_percentual=True))
    ids = {p.id for p in itens}
    assert sem_parecer.id in ids
    assert cenario["processo"].id not in ids


def test_visao_reavaliacao_pendente_quimicos(sessao, cenario, coord):
    itens, _t = repo.listar(sessao, coord, repo.Filtro(reavaliacao_pendente=True))
    assert itens == []  # o cenário é biológico

    quimico = sessao.execute(
        select(AgenteNocivo).where(
            AgenteNocivo.descricao == "Manipulação de produtos químicos"
        )
    ).scalar_one()
    exposicao = sessao.execute(select(Exposicao)).scalars().first()
    exposicao.agente_nocivo_id = quimico.id
    exposicao.fundamentacao_id = quimico.fundamentacao_id
    sessao.flush()
    sessao.expire_all()

    itens, total = repo.listar(sessao, coord, repo.Filtro(reavaliacao_pendente=True))
    assert total == 1 and itens[0].id == cenario["processo"].id


def test_visao_sem_parecer_assinado_anexado(sessao, cenario, coord):
    itens, total = repo.listar(sessao, coord, repo.Filtro(sem_parecer_assinado=True))
    assert total == 1 and itens[0].id == cenario["processo"].id

    parecer = sessao.execute(select(ParecerTecnico)).scalars().first()
    sessao.add(
        Anexo(
            entidade="parecer_tecnico",
            entidade_id=parecer.id,
            nome_arquivo="p.pdf",
            nome_original="p.pdf",
            mime_type="application/pdf",
            tamanho_bytes=3,
            sha256="a" * 64,
            storage_key="aa/" + "a" * 64,
            categoria="PARECER_ASSINADO",
        )
    )
    sessao.flush()
    _itens, total = repo.listar(sessao, coord, repo.Filtro(sem_parecer_assinado=True))
    assert total == 0


def test_pos_filtro_pagina_com_o_total_correto(sessao, coord):
    """Se o total mentir, a paginação pula registros."""
    for i in range(7):
        p = _processo(sessao, f"23086.00060{i}/2026-84".replace("//", "/"))
        p.entrou_na_etapa_em = agora_utc() - timedelta(days=200)
    sessao.flush()
    filtro = repo.Filtro(dias_parado=90, por_pagina=3)
    pagina1, total = repo.listar(sessao, coord, filtro)
    assert total == 7
    assert len(pagina1) == 3
    filtro.pagina = 3
    pagina3, _ = repo.listar(sessao, coord, filtro)
    assert len(pagina3) == 1


def test_query_string_carrega_as_visoes():
    filtro = repo.Filtro(
        dias_parado=90, sem_percentual=True, reavaliacao_pendente=True, agrupar="unidade"
    )
    qs = filtro.como_query_string()
    assert "dias=90" in qs
    assert "sem_percentual=1" in qs
    assert "reavaliacao_pendente=1" in qs
    assert "agrupar=unidade" in qs


# ---------------------------------------------------------------------
def test_agrupamento(sessao, cenario, coord):
    _processo(sessao, "23086.000608/2026-84")
    itens, _t = repo.listar(sessao, coord, repo.Filtro())
    # agrupa pelo ESTADO TÉCNICO (a verdade), não pela coluna do kanban (a visão)
    grupos = agrupar(itens, "estado")
    # o rotulo do grupo e o <summary> que a pessoa le, e sai do mapa de tela
    # (`ROTULO_ESTADO_TELA`), acentuado — o ASCII continua sendo o da trilha
    assert set(grupos) == {"Recebido", "Parecer em elaboração"}
    por_unidade = agrupar(itens, "unidade")
    assert "(sem unidade)" in por_unidade
    assert "Faculdade de Medicina de Diamantina" in por_unidade
    assert set(CHAVES_AGRUPAMENTO) == {"estado", "unidade", "responsavel", "tipo"}


# ---------------------------------------------------------------------
# Acoes em lote pela tela
# ---------------------------------------------------------------------
def test_lote_move_o_que_pode_e_relata_o_que_nao(app_cliente, contas, banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        tipo = s.execute(select(TipoProcesso)).scalars().first()
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
        pode = Processo(
            nup="23086.000608/2026-84",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico="RECEBIDO",
        )
        nao_pode = Processo(
            nup="23086.000540/2026-33",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico="CONCLUIDO",
            situacao="CONCLUIDO",
            data_conclusao=agora_utc().date(),
        )
        s.add_all([pode, nao_pode])
        s.commit()
        ids = [pode.id, nao_pode.id]

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/processos/lote",
        data={
            "processo_id": [str(i) for i in ids],
            "acao": "estado",
            "destino": "EM_TRIAGEM",
        },
        follow_redirects=True,
    )
    assert resposta.status_code == 200
    assert "1 processo(s) atualizado" in resposta.text
    assert "não passaram" in resposta.text

    with mod_banco.sessao() as s:
        assert s.get(Processo, ids[0]).estado_tecnico == "EM_TRIAGEM"
        assert s.get(Processo, ids[1]).estado_tecnico == "CONCLUIDO"


def test_lote_define_prazo(app_cliente, contas, banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        tipo = s.execute(select(TipoProcesso)).scalars().first()
        etapa = s.execute(select(FluxoEtapa)).scalars().first()
        processo = Processo(
            nup="23086.000608/2026-84", tipo_processo_id=tipo.id, etapa_id=etapa.id
        )
        s.add(processo)
        s.commit()
        processo_id = processo.id

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/processos/lote",
        data={"processo_id": str(processo_id), "acao": "prazo", "prazo": "2026-12-31"},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.get(Processo, processo_id).prazo.isoformat() == "2026-12-31"


def test_lote_sem_permissao_de_atribuir(app_cliente, contas, banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        tipo = s.execute(select(TipoProcesso)).scalars().first()
        etapa = s.execute(select(FluxoEtapa)).scalars().first()
        processo = Processo(
            nup="23086.000608/2026-84", tipo_processo_id=tipo.id, etapa_id=etapa.id
        )
        s.add(processo)
        s.commit()
        processo_id = processo.id

    entrar(app_cliente, contas, "tecnico_seguranca")  # nao tem processo.atribuir
    resposta = app_cliente.post(
        "/processos/lote",
        data={"processo_id": str(processo_id), "acao": "responsavel", "responsavel_id": "1"},
        follow_redirects=True,
    )
    assert "não passaram" in resposta.text


def test_tela_mostra_as_oito_visoes(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/processos").text
    for nome in (
        "Minha fila",
        "Atrasados",
        "Parados há mais de 90 dias",
        "Sem nº SEI",
        "Sem percentual",
        "Reavaliação pendente",
        "Campus Avançados",
        "Sem parecer assinado anexado",
    ):
        assert nome in corpo


def test_tela_agrupada_responde(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/processos?agrupar=unidade").status_code == 200
    assert app_cliente.get("/processos?agrupar=nao_existe").status_code == 200


# =====================================================================
# O cartao de filtros de /processos — encolher sem esconder
# =====================================================================
def test_o_cartao_de_filtros_nasce_fechado_e_diz_quantos_controles_tem(
    app_cliente, contas, banco
):
    """Medido a 1366x641: com o cartao aberto cabem 4 das 50 linhas da pagina;
    fechado, 8. O caso raro (seis controles ao mesmo tempo) nao precisa estar
    aberto por padrao — quem cobre o dia a dia sao as visoes salvas."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/processos").text
    gaveta = re.search(r"<details class=\"cartao filtros\"[^>]*>", corpo)
    assert gaveta, "o cartao de filtros deixou de ser <details>"
    assert " open" not in gaveta.group(0), "a lista abre com o cartao ocupando meia tela"
    assert "seis controles" in corpo


def test_filtro_aplicado_abre_a_gaveta_e_sai_escrito_no_resumo(
    app_cliente, contas, banco
):
    """Filtro ativo NAO PODE FICAR ESCONDIDO: quem chega numa lista recortada e
    nao ve o recorte conclui que o sistema perdeu registros.

    Sao duas travas, e as duas sao conferidas aqui: a gaveta nasce `open`, e o
    `<summary>` escreve o que esta aplicado — a segunda e a que sobrevive a
    alguem fechar o cartao com a mao."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/processos?estado=RECEBIDO&q=23086").text
    gaveta = re.search(r"<details class=\"cartao filtros\"[^>]*>", corpo)
    assert gaveta and " open" in gaveta.group(0)
    # a partir da gaveta: o primeiro `</summary>` da pagina e o do seletor de
    # modulo da lateral, que vem muito antes
    resumo = corpo[gaveta.end() : corpo.index("</summary>", gaveta.end())]
    assert "2 aplicado(s)" in resumo
    assert "23086" in resumo, "a busca aplicada tem de estar escrita no resumo"


def test_visao_salva_nao_abre_a_gaveta_dos_seis_controles(app_cliente, contas, banco):
    """`como_query_string()` seria mais curto e estaria errado: ela e nao-vazia
    quando quem filtrou foi uma VISAO SALVA, e abrir um cartao cujos seis
    controles estao todos vazios diria que ha filtro onde nao ha. Quem mostra a
    visao ativa e a fileira acima, com a ficha solida."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/processos?atrasados=1").text
    gaveta = re.search(r"<details class=\"cartao filtros\"[^>]*>", corpo)
    assert gaveta and " open" not in gaveta.group(0)