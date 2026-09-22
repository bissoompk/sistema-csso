"""CA-05 - PDF do 1/2025 (opcional: degrada com elegancia sem LibreOffice)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.servicos import documento, pdf
from testes.fixtures.dados_parecer_1_2025 import contexto_1_2025


def test_degradacao_elegante_sem_soffice(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf, "localizar_soffice", lambda: None)
    docx = tmp_path / "p.docx"
    documento.renderizar(contexto_1_2025(), docx, documento.MODELO_V1)
    resultado = pdf.converter(docx)
    assert resultado.gerado is False
    assert resultado.caminho is None
    assert "PDF indisponível" in (resultado.aviso or "")
    # o .docx continua lá: a emissão nunca falha por causa do PDF
    assert docx.exists()


def test_emissao_nao_falha_sem_pdf(sessao, monkeypatch):
    monkeypatch.setattr(pdf, "localizar_soffice", lambda: None)
    docx = Path(documento.caminho_saida(1, 2025, "SEST", "Teste"))
    documento.renderizar(contexto_1_2025(), docx, documento.MODELO_V1)
    resultado = pdf.converter(docx)
    assert not resultado.gerado


def test_comando_usa_perfil_proprio_e_writer_export(monkeypatch, tmp_path):
    """Sem o perfil próprio, a conversão falha em silêncio com o LO aberto."""
    capturado = {}

    class FalsoProcesso:
        stderr = b""

    def falso_run(comando, **kwargs):
        capturado["comando"] = comando
        (Path(comando[-2]) / (Path(comando[-1]).stem + ".pdf")).write_bytes(b"%PDF-1.4")
        return FalsoProcesso()

    monkeypatch.setattr(pdf, "localizar_soffice", lambda: Path("soffice"))
    monkeypatch.setattr(pdf.subprocess, "run", falso_run)

    docx = tmp_path / "x.docx"
    documento.renderizar(contexto_1_2025(), docx, documento.MODELO_V1)
    resultado = pdf.converter(docx, tmp_path / "x.pdf")

    assert resultado.gerado
    comando = capturado["comando"]
    assert "--headless" in comando
    assert "--norestore" in comando
    assert any(a.startswith("-env:UserInstallation=file:///") for a in comando)
    assert "pdf:writer_pdf_Export" in comando


@pytest.mark.skipif(not pdf.disponivel(), reason="LibreOffice nao instalado")
def test_ca05_pdf_do_1_2025_tem_uma_pagina(tmp_path):
    import fitz

    docx = tmp_path / "parecer.docx"
    documento.renderizar(contexto_1_2025(), docx, documento.MODELO_V1)
    resultado = pdf.converter(docx, tmp_path / "parecer.pdf")
    assert resultado.gerado, resultado.aviso

    doc = fitz.open(str(resultado.caminho))
    assert doc.page_count == 1
    texto = doc[0].get_text("text")
    for esperado in ("LT Nº 1/2025", "1110654", "Médio (10%)"):
        assert esperado in texto


# =====================================================================
# O espaco no caminho — o defeito que nao reclamava
# =====================================================================
def test_o_perfil_vai_como_uri_e_o_espaco_no_caminho_e_codificado(monkeypatch, tmp_path):
    """O caminho documentado deste sistema e `C:\Projetos\Sistema CSSO`, com
    espaco. Ele ia cru para dentro de um `file:///`, o que torna a URL invalida
    — e o LibreOffice, diante disso, sai com codigo 0, sem PDF e com stderr
    VAZIO. O sistema entregava o `.docx` com o aviso "instale o LibreOffice"
    numa maquina que o tinha instalado.

    O teste monta o caso pelo nome da pasta, e nao pelo caminho da maquina:
    assim ele vale tambem onde o repositorio nao tem espaco no caminho.
    """
    perfil = tmp_path / "pasta com espaco" / "perfil_lo"
    capturado = {}

    class FalsoProcesso:
        stderr = b""
        returncode = 0

    def falso_run(comando, **kwargs):
        capturado["comando"] = comando
        (Path(comando[-2]) / (Path(comando[-1]).stem + ".pdf")).write_bytes(b"%PDF-1.4")
        return FalsoProcesso()

    from app.config import obter_config

    cfg = obter_config()
    monkeypatch.setattr(cfg, "perfil_lo", str(perfil), raising=False)
    monkeypatch.setattr(pdf, "localizar_soffice", lambda: Path("soffice"))
    monkeypatch.setattr(pdf.subprocess, "run", falso_run)

    docx = tmp_path / "x.docx"
    docx.write_bytes(b"nao importa: o `run` e falso")
    assert pdf.converter(docx, tmp_path / "x.pdf").gerado

    env = next(a for a in capturado["comando"] if a.startswith("-env:UserInstallation="))
    assert "%20" in env, f"o espaco tem de ser codificado: {env}"
    assert " " not in env, f"espaco cru na URL do perfil: {env}"
    assert env.startswith("-env:UserInstallation=file:///")


def test_conversao_que_nao_escreve_o_pdf_diz_o_codigo_de_saida(monkeypatch, tmp_path):
    """"(soffice: )" nao distinguia "nao rodou" de "rodou e nao fez"."""

    class FalsoProcesso:
        stderr = b""
        returncode = 0

    monkeypatch.setattr(pdf, "localizar_soffice", lambda: Path("soffice"))
    monkeypatch.setattr(pdf.subprocess, "run", lambda *a, **k: FalsoProcesso())

    docx = tmp_path / "x.docx"
    docx.write_bytes(b"x")
    resultado = pdf.converter(docx, tmp_path / "x.pdf")

    assert not resultado.gerado
    assert "codigo 0" in resultado.aviso
    assert "nao escreveu o PDF" in resultado.aviso
    # e continua NAO sendo "indisponivel": o LibreOffice existe nesta maquina
    assert not resultado.indisponivel
