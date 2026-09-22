"""Fase 3 - importacao do quadro do Trello (8 listas, actions, orfaos)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select

from app.config import RAIZ
from app.modelos import (
    Checklist,
    HistoricoEvento,
    MigracaoRejeitada,
    Processo,
    StgTrelloAcao,
    StgTrelloCartao,
)
from app.servicos import importacao_trello as imp
from app.servicos.rbac import UsuarioAtual

QUADRO = RAIZ / "testes" / "fixtures" / "trello_quadro.json"


def sem_rede(url: str) -> bytes:
    """Buscador de anexo que falha na hora, sem sair da máquina.

    O padrão de `imp.importar` é `imp.baixar_url`, que faz requisição de
    verdade. As URLs do quadro de fixture são `https://exemplo/{a,b}.pdf`, e
    aqui a resolução de DNS falhava depois de **2,756 s e 2,714 s medidos** —
    ~5,5 s por chamada de `importar`, em 5 chamadas deste arquivo.

    **O tempo era o menor problema.** Nesta máquina a resolução falhava e o
    teste caía no ramo `except` de `_importar_anexos`, que é o desejado — por
    acidente. Numa rede cujo provedor resolve NXDOMAIN para portal cativo — o
    que é comum —, `baixar_url` devolveria bytes de HTML, `relatorio.anexos`
    viraria 1 em vez de 0 e a suíte passaria a falhar de forma intermitente e
    inexplicável, num arquivo que não tem nada a ver com a causa.

    Levanta exceção em vez de receber `None`: `None` é o outro ramo — o do modo
    sem rede, com motivo diferente e caminho próprio na simulação. O que este
    arquivo exercita, e continua exercitando, é o `except`.
    """
    raise ConnectionError(f"a suíte não vai à rede: {url}")


@pytest.fixture()
def operador(sessao):
    from app.modelos import Usuario
    from app.servicos import autenticacao

    usuario = Usuario(
        login="migrador",
        nome="Migrador",
        email="migrador@teste.ufvjm.edu.br",
        senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
    )
    sessao.add(usuario)
    sessao.flush()
    return UsuarioAtual(
        id=usuario.id,
        login="migrador",
        nome="Migrador",
        permissoes=frozenset({"catalogo.gerenciar"}),
        perfis=("coordenador_csso",),
    )


@pytest.fixture()
def importado(sessao, operador):
    relatorio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=sem_rede
    )
    sessao.flush()
    return relatorio


def test_staging_guarda_cartoes_e_acoes(sessao, importado):
    assert len(list(sessao.execute(select(StgTrelloCartao)).scalars())) == 11
    assert len(list(sessao.execute(select(StgTrelloAcao)).scalars())) == 3


def test_lista_nao_mapeada_vira_rejeitada(sessao, importado):
    assert "Lista que ninguém mapeou" in importado.listas_desconhecidas
    rejeitada = sessao.execute(
        select(MigracaoRejeitada).where(MigracaoRejeitada.ref == "c010")
    ).scalar_one()
    assert "não mapeada" in rejeitada.motivo
    # e NAO virou processo
    assert (
        sessao.execute(
            select(Processo).where(Processo.nup == "23086.009245/2026-42")
        ).scalar_one_or_none()
        is None
    )


def test_cartao_nao_processo(sessao, importado):
    refs = {
        r.ref: r.motivo
        for r in sessao.execute(
            select(MigracaoRejeitada).where(
                MigracaoRejeitada.motivo == imp.MOTIVO_NAO_PROCESSO
            )
        ).scalars()
    }
    assert {"c007", "c008", "c009"} <= set(refs)


def test_mapa_de_listas_para_estado(sessao, importado):
    processo = sessao.execute(
        select(Processo).where(Processo.nup == "23086.003498/2015-50")
    ).scalar_one()
    assert processo.estado_tecnico == "EM_TRIAGEM"
    assert processo.origem_migracao == "TRELLO"
    assert processo.origem_ref == "c001"
    assert processo.pronto_para_emissao is True


def test_lista_de_concluidos_traz_o_exercicio(sessao, importado):
    processo = sessao.execute(
        select(Processo).where(Processo.nup == "23086.021284/2024-56")
    ).scalar_one()
    assert processo.ano_referencia == 2025
    assert processo.situacao == "CONCLUIDO"


def test_repositorios_sao_marcados(sessao, importado):
    campi = sessao.execute(
        select(Processo).where(Processo.nup == "23086.005413/2026-21")
    ).scalar_one()
    assert campi.origem_repositorio is True
    aposentadoria = sessao.execute(
        select(Processo).where(Processo.nup == "23086.001198/2008-15")
    ).scalar_one()
    assert aposentadoria.tipo_processo.codigo == "APOSENTADORIA_ESPECIAL"
    assert aposentadoria.situacao == "CONCLUIDO"


def test_cartao_fechado_vira_arquivado(sessao, importado):
    processo = sessao.execute(
        select(Processo).where(Processo.nup == "23086.008530/2026-46")
    ).scalar_one()
    assert processo.estado_tecnico == "ARQUIVADO"


def test_checklists_importados(sessao, importado):
    processo = sessao.execute(
        select(Processo).where(Processo.nup == "23086.003498/2015-50")
    ).scalar_one()
    checklist = sessao.execute(
        select(Checklist).where(Checklist.processo_id == processo.id)
    ).scalar_one()
    assert checklist.nome == "Instrução"
    assert len(checklist.itens) == 2
    assert sum(1 for i in checklist.itens if i.concluido) == 1


def test_acoes_preservam_a_data_original(sessao, importado):
    eventos = list(
        sessao.execute(
            select(HistoricoEvento).where(HistoricoEvento.origem == "MIGRACAO_TRELLO")
        ).scalars()
    )
    assert len(eventos) == 3
    criacao = next(e for e in eventos if e.origem_ref == "a001")
    assert criacao.ocorrido_em == datetime(2021, 2, 3, 13, 5, tzinfo=timezone.utc)
    assert criacao.registrado_em > criacao.ocorrido_em
    assert criacao.usuario_nome == "Fátima da Silva"


def test_candidatos_extraidos_nao_sao_vinculados(sessao, importado):
    cartao = sessao.execute(
        select(StgTrelloCartao).where(StgTrelloCartao.card_id == "c002")
    ).scalar_one()
    assert cartao.parecer_candidato == "1/2025"
    assert cartao.laudo_candidato == "26255-000.110/2022"
    assert any(
        c["parecer_candidato"] == "1/2025" for c in importado.conflitos_numeracao
    )


def test_orfaos_de_processo(importado):
    assert "Sebastião Aparecido" in importado.orfaos_processo


def test_o_fixture_nao_vai_a_rede_e_mantem_o_ramo_de_anexo_perdido(sessao, importado):
    """Tranca a injeção de `sem_rede` — sem ela, isto aqui é uma requisição.

    Duas coisas de uma vez. A primeira é que os dois anexos do quadro entram
    como perdidos pelo ramo `except`, e não pelo ramo `buscar is None`: trocar a
    injeção por `None` passaria por outro caminho, com outro motivo, e nada
    apitaria. A segunda é que a falha é local — `ConnectionError` levantado
    aqui, e não um `URLError` vindo de DNS que num dia de portal cativo
    devolveria HTML e viraria anexo de verdade.
    """
    assert importado.anexos == 0
    assert len(importado.anexos_perdidos) == 2
    assert all(
        motivo.startswith("ConnectionError") for _nome, motivo in importado.anexos_perdidos
    )
    # e o perdido continua registrado para conferência manual antes da URL expirar
    rejeitadas = list(
        sessao.execute(
            select(MigracaoRejeitada).where(MigracaoRejeitada.motivo.like("falha ao baixar%"))
        ).scalars()
    )
    assert len(rejeitadas) == 2
    assert all(r.payload.get("url") for r in rejeitadas)


def test_reimportar_e_idempotente(sessao, operador, importado):
    antes = len(list(sessao.execute(select(Processo)).scalars()))
    eventos_antes = len(list(sessao.execute(select(HistoricoEvento)).scalars()))
    imp.importar(sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=sem_rede)
    sessao.flush()
    assert len(list(sessao.execute(select(Processo)).scalars())) == antes
    assert len(list(sessao.execute(select(HistoricoEvento)).scalars())) == eventos_antes


def test_simulacao_calcula_sem_gravar(sessao, operador):
    """Um ensaio que responde '0 processos' não serve para revisar nada."""
    relatorio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=False, buscar_anexo=sem_rede
    )
    sessao.flush()

    assert relatorio.processos > 0
    assert relatorio.eventos > 0
    assert relatorio.conflitos_numeracao
    # e nada foi gravado
    assert not list(sessao.execute(select(Processo)).scalars())
    assert not list(sessao.execute(select(HistoricoEvento)).scalars())


def test_simulacao_e_carga_contam_o_mesmo(sessao, operador):
    ensaio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=False, buscar_anexo=sem_rede
    )
    sessao.rollback()
    real = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=sem_rede
    )
    sessao.flush()
    assert ensaio.processos == real.processos
    assert ensaio.backlog_historico == real.backlog_historico
    assert ensaio.backlog_pendente == real.backlog_pendente


def test_extratores_de_identificador():
    assert imp.parecer_candidato("Flávio Rodrigues de Matos - 06-2025") == "6/2025"
    assert imp.parecer_candidato("Relatório de Anatomia Humana") is None
    assert imp.laudo_candidato("Laudo 26255-000.1102022") == "26255-000.110/2022"


@pytest.mark.parametrize(
    "nome,esperado",
    [
        # as duas grafias que aparecem no quadro real
        ("Parecer_Tecnico_05-2026 (1234567).pdf", "1234567"),
        ("SEI_1486577_Oficio_24.pdf", "1486577"),
        ("SEI 1911207 Documento Check List.pdf", "1911207"),
        ("LTCAT.pdf", None),
        ("SEI_12345_curto.pdf", None),
    ],
)
def test_numero_do_documento_sei_no_nome(nome, esperado):
    assert imp.documento_sei_de_anexo(nome) == esperado
