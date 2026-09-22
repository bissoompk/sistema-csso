"""CA-01 / CA-02 / CA-05 - o teste de ouro do parecer 1/2025.

Nao compara bytes do .docx: extrai todo o texto (paragrafos + celulas + header
+ footer), normaliza e compara com a fixture gerada a partir do PDF assinado.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from docx import Document

from app.config import RAIZ
from app.servicos import documento
from app.servicos.textos import normalizar_fluxo
from testes.fixtures.dados_parecer_1_2025 import contexto_1_2025

OURO = RAIZ / "testes" / "fixtures" / "ouro_parecer_1_2025.txt"

ASSERCOES_NOMEADAS = [
    "Parecer técnico no 1/2025",
    "Serviço Especializado em Segurança do Trabalho",
    "Diamantina, 11 de fevereiro de 2025",
    "MARINA FERREIRA DA COSTA",
    "Faculdade de Medicina de Diamantina",
    "Laboratório Escola de análises Clínicas (LEAC)",
    "Laboratório de Doenças Infecciosas e Parasitárias",
    "250 - Faculdade De Medicina De Diamantina",
    "Adicional de Insalubridade",
    "23086.021284/2024-56",
    "Marco Antônio Alves Schetino",
    "1110654",
    "TECNICO DE LABORATORIO AREA",
    "Nº 26255-000.125/2019",
    "Agente Biológico",
    "Contato permanente com material infecto-contagiante*",
    "Médio (10%)",
    "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
    "Anexo 14 da NR 15 e Instrução Normativa 15/2022",
    "Art. 17 da IN 15/2022",
    "a partir da data da Portaria de Localização: 17 de setembro de 2024",
    "Fabrício Raimundi Andrade",
    "Mat. SIAPE 2165804",
    "LT Nº 1/2025",
    "IN 15/2022",
]


@pytest.fixture(scope="module")
def docx_1_2025(tmp_path_factory) -> Path:
    destino = tmp_path_factory.mktemp("ouro") / "parecer_1_2025.docx"
    documento.renderizar(contexto_1_2025(), destino, documento.MODELO_V1)
    return destino


@pytest.fixture(scope="module")
def texto_1_2025(docx_1_2025: Path) -> str:
    return documento.extrair_texto(docx_1_2025)


def test_gera_parecer_1_2025_marco_antonio(texto_1_2025: str) -> None:
    esperado = OURO.read_text(encoding="utf-8")
    assert normalizar_fluxo(texto_1_2025) == normalizar_fluxo(esperado)


@pytest.mark.parametrize("trecho", ASSERCOES_NOMEADAS)
def test_asercoes_nomeadas(texto_1_2025: str, trecho: str) -> None:
    assert normalizar_fluxo(trecho) in normalizar_fluxo(texto_1_2025)


def test_defeito_do_v1_preservado(texto_1_2025: str) -> None:
    """O v1 rotula 'Nº do Laudo Técnico:' acima do numero do PARECER.
    O defeito e preservado por fidelidade documental (RN-02)."""
    fluxo = normalizar_fluxo(texto_1_2025)
    assert "Nº do Laudo Técnico: Nº 1/2025" in fluxo


def test_v2_corrige_o_rotulo(tmp_path: Path) -> None:
    destino = tmp_path / "v2.docx"
    documento.renderizar(contexto_1_2025(), destino, documento.MODELO_V2)
    fluxo = normalizar_fluxo(documento.extrair_texto(destino))
    assert "Nº do Parecer Técnico: Nº 1/2025" in fluxo
    assert "Nº do Laudo Técnico:" not in fluxo


def test_celula_de_posto_tem_exatamente_duas_linhas(docx_1_2025: Path) -> None:
    doc = Document(str(docx_1_2025))
    tabela = doc.tables[1]  # IDENTIFICACAO DO LOCAL AVALIADO
    celula = tabela.rows[2].cells[-1]
    linhas = [p.text.strip() for p in celula.paragraphs if p.text.strip()]
    # o docxtpl usa <w:br/> dentro do mesmo paragrafo (RichText com \a)
    bruto = celula.text.replace("\x0b", "\n")
    linhas = [linha for linha in bruto.split("\n") if linha.strip()]
    assert linhas == [
        "Laboratório Escola de análises Clínicas (LEAC)",
        "Laboratório de Doenças Infecciosas e Parasitárias",
    ]


def test_ca02_condicional_de_reavaliacao_ausente(texto_1_2025: str) -> None:
    assert "avaliados quantitativamente" not in texto_1_2025


def test_ca02_condicional_de_reavaliacao_presente(tmp_path: Path) -> None:
    contexto = contexto_1_2025()
    contexto.numero_parecer = 8
    contexto.ano = 2026
    contexto.data_emissao = date(2026, 6, 18)
    contexto.fundamentacao_legal = (
        "“Fabricação e manipulação de ácido oxálico, nítrico sulfúrico, clorídrico, "
        "fosfórico, pícrico.”\n“Manipulação de álcalis cáusticos.”\n"
        "Anexo 13 da NR 15 e Instrução Normativa 15/2022."
    )
    contexto.reavaliacao = (
        "Os agentes químicos devem ser avaliados quantitativamente para fins de "
        "prevenção e controle do risco. Após a realização da avaliação quantitativa "
        "dos agentes químicos um novo laudo deverá ser elaborado."
    )
    destino = tmp_path / "8_2026.docx"
    documento.renderizar(contexto, destino, documento.MODELO_V1)
    fluxo = normalizar_fluxo(documento.extrair_texto(destino))
    assert "avaliados quantitativamente" in fluxo
    assert "Anexo 13 da NR 15 e Instrução Normativa 15/2022.*" in fluxo


def test_cabecalho_espelho_csso_2026(tmp_path: Path) -> None:
    """Parecer emitido em 07/2026 sai com a sigla nova no cabecalho."""
    contexto = contexto_1_2025()
    contexto.numero_parecer = 12
    contexto.ano = 2026
    contexto.data_emissao = date(2026, 7, 1)
    contexto.sigla_unidade_emissora = "CSSO/Sisa"
    contexto.nome_extenso_emissor = "Coordenadoria de Segurança e Saúde Ocupacional"
    destino = tmp_path / "12_2026.docx"
    documento.renderizar(contexto, destino, documento.MODELO_V1)
    fluxo = normalizar_fluxo(documento.extrair_texto(destino))
    assert "Coordenadoria de Segurança e Saúde Ocupacional" in fluxo
    assert "Parecer técnico no 12/2026 – CSSO/Sisa" in fluxo


def test_hash_do_modelo_e_registrado(tmp_path: Path) -> None:
    info = documento.renderizar(
        contexto_1_2025(), tmp_path / "h.docx", documento.MODELO_V1
    )
    assert info["modelo_arquivo"] == documento.MODELO_V1
    assert len(info["modelo_sha256"]) == 64
    assert len(info["hash_conteudo"]) == 64


def test_rn04_lista_o_que_falta(tmp_path: Path) -> None:
    contexto = contexto_1_2025()
    contexto.matricula = ""
    contexto.percentual_aplicavel = ""
    with pytest.raises(documento.DadosIncompletos) as erro:
        documento.renderizar(contexto, tmp_path / "x.docx", documento.MODELO_V1)
    assert "matricula SIAPE" in erro.value.faltantes
    assert "percentual aplicavel" in erro.value.faltantes
