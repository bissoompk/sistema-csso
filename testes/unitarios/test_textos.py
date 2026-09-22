"""CA-03 (UORG), RN-19 (identificador opaco) e RN-21 (termos proibidos)."""

from __future__ import annotations

import pytest

from app.servicos import textos


def test_ca03_uorg_famed() -> None:
    assert (
        textos.uorg_formatado("250 - FACULDADE DE MEDICINA DE DIAMANTINA")
        == "250 - Faculdade De Medicina De Diamantina"
    )


def test_ca03_uorg_iect() -> None:
    assert (
        textos.uorg_formatado("260 - INSTITUTO DE ENG., CIENCIA E TECNOLOGIA")
        == "260 - Instituto De Eng., Ciencia E Tecnologia"
    )


def test_codigo_e_nome_uorg() -> None:
    bruto = "234 - DEPARTAMENTO DE ZOOTECNIA"
    assert textos.codigo_uorg(bruto) == "234"
    assert textos.nome_uorg(bruto) == "DEPARTAMENTO DE ZOOTECNIA"


def test_aspas_curvas_alternam() -> None:
    assert textos.aspas_curvas('"Manipulação de álcalis cáusticos."') == (
        "“Manipulação de álcalis cáusticos.”"
    )


def test_slug_ascii_para_nome_de_arquivo() -> None:
    assert textos.slug_ascii("Marco Antônio Alves Schetino") == "Marco_Antonio_Alves_Schetino"
    assert textos.nome_arquivo_parecer(8, 2026, "SEST/DASA/PROGEP", "Talita") == (
        "Parecer_Tecnico_08-2026_SEST_Talita"
    )


def test_normalizar_fluxo_colapsa_quebra() -> None:
    assert textos.normalizar_fluxo("linha um\n  linha   dois \n") == "linha um linha dois"


@pytest.mark.parametrize(
    "texto",
    [
        "servidora gestante afastada",
        "consta CID-10 no atestado",
        "informar o CPF do servidor",
    ],
)
def test_rn21_bloqueia_dado_de_saude(texto: str) -> None:
    with pytest.raises(textos.TextoProibido):
        textos.exigir_texto_limpo(texto, "observacoes")


def test_rn21_deixa_passar_texto_tecnico() -> None:
    limpo = (
        "Exposição a agentes químicos no Laboratório de Química; avaliação "
        "qualitativa conforme Anexo 13 da NR-15."
    )
    assert textos.exigir_texto_limpo(limpo, "observacoes") == limpo


# ---------------------------------------------------------------------
# RN-21 por contexto - o parecer nao afrouxa; Acidentes nomeia a especie
# ---------------------------------------------------------------------
def test_rn21_doenca_continua_barrada_no_contexto_padrao() -> None:
    """O parecer de adicional ocupacional nao muda em nada: a insalubridade se
    prova pelo agente e pelo ambiente, nunca pelo corpo do servidor."""
    with pytest.raises(textos.TextoProibido):
        textos.exigir_texto_limpo("servidor afastado por doença", "observacoes")
    with pytest.raises(textos.TextoProibido):
        textos.exigir_texto_limpo("quadro de enfermidade cronica", "observacoes")


def test_rn21_doenca_relacionada_ao_trabalho_passa_no_contexto_de_acidente() -> None:
    """Lei 8.112/90, art. 212 + decisao 4: e o NOME da especie de acidente em
    servico, nao diagnostico de ninguem. Sem isso o modulo de Acidentes nao
    registra a especie que a lei manda registrar."""
    narrativa = (
        "Ocorrencia registrada na especie doença relacionada ao trabalho, com "
        "exposicao a ruido continuo no Setor de Marcenaria desde 2019."
    )
    assert (
        textos.exigir_texto_limpo(
            narrativa, "descricao_evento", textos.CONTEXTO_NEXO_OCUPACIONAL
        )
        == narrativa
    )
    sem_acento = textos.termos_proibidos_em(
        "doenca sem acento", textos.CONTEXTO_NEXO_OCUPACIONAL
    )
    assert sem_acento == []


@pytest.mark.parametrize(
    "texto",
    [
        "doença relacionada ao trabalho, CID-10 registrado no prontuario",
        "doença relacionada ao trabalho conforme diagnóstico do medico assistente",
        "doença relacionada ao trabalho, ver atestado médico anexo",
        "servidora gestante com doença relacionada ao trabalho",
        "doença relacionada ao trabalho; enfermidade degenerativa previa",
        "doença relacionada ao trabalho - CPF 000.000.000-00",
    ],
)
def test_rn21_contexto_de_acidente_dispensa_so_a_palavra_da_especie(texto: str) -> None:
    """A dispensa e de uma palavra, nao um portao aberto: CID, diagnostico,
    atestado medico, gestacao, enfermidade e CPF seguem barrados tambem la."""
    with pytest.raises(textos.TextoProibido):
        textos.exigir_texto_limpo(
            texto, "descricao_evento", textos.CONTEXTO_NEXO_OCUPACIONAL
        )


def test_rn21_dispensa_nao_vaza_para_o_contexto_padrao() -> None:
    """Prova de que a dispensa e por contexto e nao mexe na lista global."""
    assert "doença" in textos.TERMOS_PROIBIDOS
    # As duas grafias da lista colapsam na mesma chave de busca e sao relatadas
    # juntas - comportamento que ja existia e que a mudanca preserva.
    assert textos.termos_proibidos_em("doença relacionada ao trabalho") == [
        "doenca",
        "doença",
    ]


def test_rn21_contexto_desconhecido_falha_alto() -> None:
    """Typo no contexto nao pode virar filtro silenciosamente diferente."""
    with pytest.raises(ValueError, match="contexto de RN-21 desconhecido"):
        textos.termos_proibidos_em("qualquer texto", "acidentes")


def test_rn21_contexto_padrao_e_o_default_da_assinatura() -> None:
    """Quem esquecer o parametro erra para o lado seguro."""
    assert textos.termos_proibidos_em("doença") == textos.termos_proibidos_em(
        "doença", textos.CONTEXTO_PADRAO
    )


# ---------------------------------------------------------------------
# A frase da recusa: quem a le e engenheiro de seguranca, nao o banco
# ---------------------------------------------------------------------
def test_rn21_a_recusa_fala_portugues_e_nomeia_o_campo_da_TELA() -> None:
    """A recusa e deliberada; a forma de recusar e que estava errada.

    Ela dizia `O campo 'comentario' contem termo proibido` — nome de coluna,
    entre aspas, e a frase inteira sem acento num sistema cujo resto do texto e
    portugues. O nome de coluna nem ajuda a achar o campo: a tela nao chama
    nenhum deles assim.
    """
    with pytest.raises(textos.TextoProibido) as recusa:
        textos.exigir_texto_limpo("consta atestado médico", "comentário")
    frase = str(recusa.value)

    assert "comentário" in frase, "o rotulo da tela sumiu da frase"
    assert "'comentario'" not in frase, "voltou a citar o nome da coluna"
    assert "contem" not in frase and "saude" not in frase, "voltou ao ASCII"
    assert "contém termo proibido" in frase
    assert "Estado de saúde, gestação, CID e diagnóstico" in frase
    assert "RN-21" in frase and "LGPD art. 11" in frase


def test_rn21_a_recusa_diz_a_saida_e_nao_so_o_nao() -> None:
    """A terceira parte da regra da casa: O, P e **S**.

    Negar sem dizer o caminho e o que faz a pessoa contornar o sistema por fora
    — e aqui a saida existe, e cabe numa linha: o adicional se fundamenta pelo
    agente e pelo ambiente, nunca pelo corpo de quem trabalha.
    """
    with pytest.raises(textos.TextoProibido) as recusa:
        textos.exigir_texto_limpo("servidora gestante", "observações")
    frase = str(recusa.value)
    assert "agente" in frase and "ambiente" in frase
    assert "não a pessoa" in frase


def test_rn21_o_campo_recebe_rotulo_de_tela_e_nao_nome_de_coluna() -> None:
    """Sonda de contrato: `campo` e rotulo de tela, nao identificador do esquema.

    Os pontos de chamada do modulo de EPI ja mandavam rotulo; os tres do
    Processos SEI mandavam `observacoes`, `comentario` e `justificativa_art9`.
    Se um deles voltar, a frase volta a falar como banco de dados com quem la e
    engenheiro de seguranca — e nenhum outro teste percebe, porque a recusa
    continua acontecendo do mesmo jeito.

    O alcance e o das chamadas que trazem o rotulo na propria linha (as oito de
    argumento literal). As de varias linhas ficam de fora, e e por isso que a
    assercao e sobre a FORMA do rotulo e nao sobre uma lista de arquivos: o que
    esta regex reconhece — minusculas ASCII, sem espaco e sem acento — nao e
    portugues de tela em nenhuma hipotese, so identificador de coluna.
    """
    import re
    from pathlib import Path

    from app.config import RAIZ

    coluna = re.compile(
        r"""exigir_texto_limpo\(\s*[^,)]+,\s*(?:campo=)?["']([a-z0-9_]+)["']"""
    )
    achados: list[str] = []
    for arquivo in sorted((Path(RAIZ) / "app").rglob("*.py")):
        texto = arquivo.read_text(encoding="utf-8")
        for chamada in coluna.finditer(texto):
            if chamada.group(1) == "texto":
                continue  # o default da assinatura, que nao nomeia campo nenhum
            linha = texto[: chamada.start()].count("\n") + 1
            achados.append(f"{arquivo.name}:{linha} campo={chamada.group(1)!r}")
    assert not achados, "nome de coluna chegando à tela pela RN-21:\n" + "\n".join(
        achados
    )
    # sonda da sonda: sem isto, um erro no regex faz o teste passar por vazio
    assert coluna.search('exigir_texto_limpo(valor, "justificativa_art9")')
    assert not coluna.search('exigir_texto_limpo(valor, "justificativa do art. 9º")')


def test_rn19_identificador_opaco_nao_revela_matricula() -> None:
    opaco = textos.identificador_opaco(42, "sessao-abc")
    assert opaco.startswith("SRV-") and len(opaco) == 8
    assert "42" not in opaco
    assert textos.identificador_opaco(42, "outra-sessao") != opaco
