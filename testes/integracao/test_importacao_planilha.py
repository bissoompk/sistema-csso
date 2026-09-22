"""CA-06 - importacao da planilha real de 2026."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select

from app.config import RAIZ
from app.modelos import ParecerTecnico, PortariaLocalizacao, Processo, StgPlanilhaParecer
from app.servicos import importacao_planilha as imp
from app.servicos.numeracao import recontar_sequencia
from app.servicos.rbac import UsuarioAtual

PLANILHA = RAIZ / "entrada" / "CSSO_Planilha_Pareceres_2026.xlsx"

OPERADOR = UsuarioAtual(
    id=1, login="op", nome="Operador", permissoes=frozenset({"catalogo.gerenciar"}),
    perfis=("coordenador_csso",),
)

pytestmark = pytest.mark.skipif(
    not PLANILHA.exists(), reason="planilha real ausente em entrada/"
)


@pytest.fixture()
def usuario_real(sessao):
    from app.modelos import Usuario
    from app.servicos import autenticacao

    usuario = Usuario(
        login="importador",
        nome="Importador",
        email="importador@teste.ufvjm.edu.br",
        senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
    )
    sessao.add(usuario)
    sessao.flush()
    return UsuarioAtual(
        id=usuario.id,
        login="importador",
        nome="Importador",
        permissoes=frozenset({"catalogo.gerenciar"}),
        perfis=("coordenador_csso",),
    )


@pytest.fixture()
def importado(sessao, usuario_real):
    relatorio = imp.importar(sessao, PLANILHA, usuario_real, aplicar=True)
    recontar_sequencia(sessao)
    sessao.flush()
    return relatorio


def _por_linha(relatorio, numero_linha):
    return next(l for l in relatorio.linhas if l.linha == numero_linha)


def test_staging_guarda_as_25_colunas(sessao, importado):
    registros = list(sessao.execute(select(StgPlanilhaParecer)).scalars())
    assert registros
    assert all(r.arquivo == PLANILHA.name for r in registros)
    # a coluna Y (orfa, sem cabecalho) existe como campo proprio
    assert hasattr(registros[0], "col_Y_sem_cabecalho")


def test_ca06_linha_8_e_reserva_com_ano_inferido(sessao, importado):
    """A linha 8 traz só o número (B8=7, sem ano): herda D da linha vizinha."""
    linha = _por_linha(importado, 8)
    assert linha.classificacao == "RESERVA"
    assert linha.numero == 7
    assert linha.ano == 2026

    parecer = sessao.execute(
        select(ParecerTecnico).where(ParecerTecnico.numero == 7, ParecerTecnico.ano == 2026)
    ).scalar_one()
    assert parecer.situacao == "RESERVADO"
    assert parecer.ano_inferido is True

    from app.modelos import HistoricoEvento

    eventos = sessao.execute(
        select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "ANO_INFERIDO")
    ).scalars().all()
    assert eventos


def test_ca06_linhas_com_numero_e_ano_viram_reservado(sessao, importado):
    for numero_linha in (10, 11, 12):
        linha = _por_linha(importado, numero_linha)
        assert linha.classificacao == "RESERVA", numero_linha
        parecer = sessao.execute(
            select(ParecerTecnico).where(
                ParecerTecnico.numero == linha.numero, ParecerTecnico.ano == linha.ano
            )
        ).scalar_one()
        assert parecer.situacao == "RESERVADO"


def test_ca06_linha_5_importada_mas_bloqueada_sem_percentual(sessao, importado):
    """Claudia (parecer 4/2026) entra, mas sem percentual não pode ser emitida."""
    linha = _por_linha(importado, 5)
    assert linha.classificacao == "PARCIAL"
    assert "Percentual aplicável ausente" in linha.pendencias
    parecer = sessao.execute(
        select(ParecerTecnico).where(ParecerTecnico.numero == 4, ParecerTecnico.ano == 2026)
    ).scalar_one()
    assert parecer.situacao == "RASCUNHO"


def test_ca06_linhas_6_e_7_entram_sem_processo(sessao, importado):
    for numero_linha in (6, 7):
        linha = _por_linha(importado, numero_linha)
        parecer = sessao.execute(
            select(ParecerTecnico).where(
                ParecerTecnico.numero == linha.numero, ParecerTecnico.ano == linha.ano
            )
        ).scalar_one()
        assert parecer.processo_id is None
        assert "sem número de processo (NUP)" in linha.pendencias


def test_ca06_linhas_completas_viram_emitido(sessao, importado):
    completas = [l for l in importado.linhas if l.classificacao == "COMPLETA"]
    assert completas, "a planilha real tem linhas completas"
    for linha in completas:
        parecer = sessao.execute(
            select(ParecerTecnico).where(
                ParecerTecnico.numero == linha.numero, ParecerTecnico.ano == linha.ano
            )
        ).scalar_one()
        assert parecer.situacao in ("EMITIDO", "RASCUNHO")
        assert parecer.texto_recomendacao_literal is True


def test_ca06_reimportar_nao_duplica(sessao, usuario_real, importado):
    antes = len(list(sessao.execute(select(ParecerTecnico)).scalars()))
    imp.importar(sessao, PLANILHA, usuario_real, aplicar=True)
    sessao.flush()
    depois = len(list(sessao.execute(select(ParecerTecnico)).scalars()))
    assert antes == depois


def test_ca06_relatorio_linha_a_linha(importado):
    assert importado.total >= 14
    assert importado.contar("RESERVA") >= 4
    assert importado.contar("COMPLETA") >= 3
    for linha in importado.linhas:
        assert linha.acao in ("emitido", "rascunho", "reservado", "rejeitada", "ignorada")


def test_portaria_normaliza_numero_preservando_literal(sessao, importado):
    portarias = list(sessao.execute(select(PortariaLocalizacao)).scalars())
    assert portarias
    for p in portarias:
        assert not p.numero.startswith("0") or p.numero == "0"
        assert p.texto_original


def test_marco_extraido_da_recomendacao(sessao, importado):
    parecer = sessao.execute(
        select(ParecerTecnico).where(ParecerTecnico.numero == 1, ParecerTecnico.ano == 2026)
    ).scalar_one()
    assert parecer.data_marco_inicial == date(2026, 2, 9)
    assert parecer.tipo_marco is not None
    assert parecer.tipo_marco.codigo == "PORTARIA_LOCALIZACAO"


def test_data_solicitacao_recuperada_da_recomendacao(sessao, importado):
    """A coluna A está 100% vazia; a data da solicitação vive na recomendação."""
    parecer = sessao.execute(
        select(ParecerTecnico).where(ParecerTecnico.numero == 8, ParecerTecnico.ano == 2026)
    ).scalar_one()
    assert parecer.tipo_marco.codigo == "SOLICITACAO_SEST"
    assert parecer.data_marco_inicial == date(2026, 5, 1)
    processo = sessao.get(Processo, parecer.processo_id)
    assert processo.data_solicitacao_sest == date(2026, 5, 1)


def test_rn18_data_da_planilha_nao_desloca(sessao, importado):
    parecer = sessao.execute(
        select(ParecerTecnico).where(ParecerTecnico.numero == 1, ParecerTecnico.ano == 2026)
    ).scalar_one()
    assert parecer.data_emissao == date(2026, 2, 11)


def test_sinonimo_de_agente_vai_para_o_canonico(sessao, importado):
    """'Manuseio de substâncias químicas' -> 'Manipulação de produtos químicos'."""
    parecer = sessao.execute(
        select(ParecerTecnico).where(ParecerTecnico.numero == 3, ParecerTecnico.ano == 2026)
    ).scalar_one()
    descricoes = {e.agente_nocivo.descricao for e in parecer.exposicoes}
    assert descricoes == {"Manipulação de produtos químicos"}


def test_de_para_de_posto_corrige_esterelizacao(sessao, importado):
    from app.modelos import PostoTrabalho

    nomes = {p.nome for p in sessao.execute(select(PostoTrabalho)).scalars()}
    assert "Central de Esterilização de Materiais (CME)" in nomes
    assert "Central de Esterelização de Materiais (CME)" not in nomes


def test_rn06_parecer_quimico_migrado_herda_a_pendencia(sessao, importado):
    """O parecer já saiu, mas a avaliação quantitativa continua devida."""
    from app.modelos import Pendencia

    abertas = list(
        sessao.execute(
            select(Pendencia).where(Pendencia.tipo == "AVALIACAO_QUANTITATIVA")
        ).scalars()
    )
    assert abertas, "os pareceres de agente químico devem abrir a pendência"
    assert all(p.prazo is not None for p in abertas)
    assert all("migrado" in p.descricao for p in abertas)


def test_recontagem_da_sequencia(sessao, importado):
    from app.modelos import ParecerSequencia

    sequencia = sessao.get(ParecerSequencia, 2026)
    assert sequencia is not None
    maximo = max(
        p.numero
        for p in sessao.execute(
            select(ParecerTecnico).where(ParecerTecnico.ano == 2026)
        ).scalars()
    )
    assert sequencia.ultimo_numero == maximo


def test_simulacao_nao_grava(sessao, usuario_real):
    relatorio = imp.importar(sessao, PLANILHA, usuario_real, aplicar=False)
    assert all(l.acao in ("simulada", "rejeitada") for l in relatorio.linhas)
    assert not list(sessao.execute(select(ParecerTecnico)).scalars())


# ---------------------------------------------------------------------
def test_analisar_portaria_nas_seis_variantes():
    exemplos = [
        ("PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024", "FAMED", "35", date(2024, 9, 17)),
        ("PORTARIA FCA Nº 001, DE 05 DE MARÇO DE 2024", "FCA", "1", date(2024, 3, 5)),
        ("PORTARIA/IECT Nº 001/IECT, DE 16 DE JANEIRO DE 2026", "IECT", "1", date(2026, 1, 16)),
        ("PORTARIA/FCBS Nº 07, DE 09 DE FEVEREIRO DE 2026", "FCBS", "7", date(2026, 2, 9)),
        ("PORTARIA/FAMMUC Nº 01/2026, DE 07 DE JANEIRO DE 2026", "FAMMUC", "1", date(2026, 1, 7)),
        ("Portaria/ICA Nº 79, de 12 de novembro de 2024", "ICA", "79", date(2024, 11, 12)),
    ]
    for texto, emissor, numero, quando in exemplos:
        analise = imp.analisar_portaria(texto)
        assert analise is not None, texto
        assert analise.emissor == emissor
        assert analise.numero == numero
        assert analise.data == quando
        assert analise.texto == texto


def test_extrair_marco_das_tres_formas():
    casos = [
        ("... a partir da data da Portaria de Localização: 17 de setembro de 2024",
         "PORTARIA_LOCALIZACAO", date(2024, 9, 17)),
        ("... a partir da portaria de localização 12 de novembro de 2024",
         "PORTARIA_LOCALIZACAO", date(2024, 11, 12)),
        ("... a partir da data da solicitação 01/05/2026",
         "SOLICITACAO_SEST", date(2026, 5, 1)),
    ]
    for texto, codigo, quando in casos:
        marco = imp.extrair_marco(texto)
        assert marco is not None
        assert marco.codigo == codigo
        assert marco.data == quando


def test_arquivo_de_entrada_existe():
    assert Path(PLANILHA).exists()
