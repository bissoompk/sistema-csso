"""Conversor do .docx de mala direta -> modelo docxtpl."""

from __future__ import annotations

import zipfile

import pytest

from app.config import RAIZ
from app.servicos.documento import DIR_MODELOS, MODELO_V1, MODELO_V2
from ferramentas.converter_modelo_maladireta import (
    CHAVES_RICHTEXT,
    MAPA_CAMPOS,
    contar_asteriscos,
    converter,
)

ORIGINAL = RAIZ / "entrada" / "CSSO_Modelo_Parecer_Adicionais.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _xml(caminho, parte):
    from lxml import etree

    with zipfile.ZipFile(caminho) as z:
        return etree.fromstring(z.read(parte))


def test_modelos_convertidos_estao_no_repositorio():
    assert (DIR_MODELOS / MODELO_V1).exists()
    assert (DIR_MODELOS / MODELO_V2).exists()


def test_nao_sobrou_mergefield_no_modelo():
    with zipfile.ZipFile(DIR_MODELOS / MODELO_V1) as z:
        for parte in ("word/document.xml", "word/header1.xml", "word/footer1.xml"):
            conteudo = z.read(parte).decode("utf-8")
            assert "MERGEFIELD" not in conteudo, parte


def test_todas_as_chaves_aparecem_no_modelo():
    with zipfile.ZipFile(DIR_MODELOS / MODELO_V1) as z:
        texto = "".join(
            z.read(p).decode("utf-8")
            for p in ("word/document.xml", "word/header1.xml", "word/footer1.xml")
        )
    for chave in MAPA_CAMPOS.values():
        assert "{{r %s }}" % chave in texto or "{{ %s }}" % chave in texto, chave


def test_richtext_usa_a_sintaxe_r():
    with zipfile.ZipFile(DIR_MODELOS / MODELO_V1) as z:
        texto = z.read("word/document.xml").decode("utf-8")
    for chave in CHAVES_RICHTEXT:
        assert "{{r %s }}" % chave in texto, chave


def test_condicional_da_reavaliacao_existe():
    with zipfile.ZipFile(DIR_MODELOS / MODELO_V1) as z:
        texto = z.read("word/document.xml").decode("utf-8")
    assert "{%p if reavaliacao %}" in texto
    assert "{%p endif %}" in texto


def test_modelo_nao_e_mais_mala_direta():
    with zipfile.ZipFile(DIR_MODELOS / MODELO_V1) as z:
        assert "mailMerge" not in z.read("word/settings.xml").decode("utf-8")


def test_v1_preserva_o_defeito_de_rotulo():
    texto = "".join(
        (t.text or "")
        for t in _xml(DIR_MODELOS / MODELO_V1, "word/document.xml").iter(W + "t")
    )
    assert "Laudo Técnico:" in texto.replace(" ", " ")


def test_v2_corrige_o_rotulo():
    texto = "".join(
        (t.text or "")
        for t in _xml(DIR_MODELOS / MODELO_V2, "word/document.xml").iter(W + "t")
    )
    assert "Parecer Técnico:" in texto


@pytest.mark.skipif(not ORIGINAL.exists(), reason="modelo original ausente")
def test_contagem_de_asteriscos_nao_muda(tmp_path):
    """Os '*' são texto estático do modelo (marcador da nota do rodapé)."""
    destino = tmp_path / "convertido.docx"
    relatorio = converter(ORIGINAL, destino, "v1")
    assert relatorio["asteriscos_antes"] == relatorio["asteriscos_depois"] == 3
    assert relatorio["fldChar"] >= 23


@pytest.mark.skipif(not ORIGINAL.exists(), reason="modelo original ausente")
def test_conversao_e_deterministica(tmp_path):
    a = converter(ORIGINAL, tmp_path / "a.docx", "v1")
    b = converter(ORIGINAL, tmp_path / "b.docx", "v1")
    assert a == b


def test_asteriscos_conta_so_texto_visivel():
    root = _xml(DIR_MODELOS / MODELO_V1, "word/document.xml")
    assert contar_asteriscos(root) == 3
