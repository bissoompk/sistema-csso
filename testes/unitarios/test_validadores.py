"""Validadores Pydantic - a metade que o SQLite nao consegue impor."""

from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from app.esquemas.validadores import (
    ExposicaoEntrada,
    LaudoEntrada,
    PortariaEntrada,
    ProcessoEntrada,
    ServidorEntrada,
)


def test_a_check_do_banco_prende_a_string_inteira():
    """`~` do PostgreSQL casa substring: sem âncora, `siape ~ '\\d{7}'` aceita
    'abc1234567xyz'. O banco ficava mais frouxo que o `re.fullmatch` do
    validador Python — e a constraint dava confiança falsa a quem lê o esquema.
    """
    import re

    from app.modelos.base import ancorar, check_regex, confere_regex
    from app.modelos.organizacao import PADRAO_SIAPE

    # `re.search` é o equivalente do `~`: casa em qualquer posição
    assert ancorar(PADRAO_SIAPE) == r"^(?:\d{7})$"
    ancorado = ancorar(PADRAO_SIAPE)
    assert re.search(PADRAO_SIAPE, "abc1234567xyz") is not None  # o que passava antes
    assert re.search(ancorado, "abc1234567xyz") is None
    assert re.search(ancorado, "1110654") is not None

    # o grupo (?:) é o que faz a âncora valer para a alternância inteira
    assert re.search(ancorar("a|b"), "qualquer coisa terminada em b") is None
    assert re.search(ancorar("a|b"), "b") is not None
    assert re.search("^a|b$", "qualquer coisa terminada em b") is not None  # sem o grupo

    texto = str(check_regex("ck_x", "siape", PADRAO_SIAPE).sqltext)
    assert texto == r"siape ~ '^(?:\d{7})$'"

    # banco e validador Python passam a dizer a mesma coisa
    for valor in ("1110654", "abc1234567xyz", "111065", ""):
        assert confere_regex(valor, PADRAO_SIAPE) == (
            re.fullmatch(ancorado, valor) is not None
        )


def test_todo_padrao_do_esquema_fica_ancorado():
    import re

    from app.modelos.base import ancorar
    from app.modelos.organizacao import PADRAO_SIAPE
    from app.modelos.processo import PADRAO_LAUDO, PADRAO_NUP
    from app.modelos.treinamento import PADRAO_CODIGO_TREINAMENTO, PADRAO_MARCADOR

    sujeira = {
        PADRAO_SIAPE: "x1110654x",
        PADRAO_NUP: "SEI 23086.021284/2024-56 (cópia)",
        PADRAO_LAUDO: "laudo 26255-000.125/2019 conferido",
        PADRAO_CODIGO_TREINAMENTO: "NR35 e mais um pouco",
        PADRAO_MARCADOR: "nome; DROP TABLE",
    }
    for padrao, valor in sujeira.items():
        assert re.search(padrao, valor) is not None, f"o `~` cru aceitava: {padrao}"
        assert re.search(ancorar(padrao), valor) is None, f"ancorado recusa: {padrao}"


def test_siape_precisa_de_sete_digitos():
    assert ServidorEntrada(siape="1110654", nome="Marco Antônio").siape == "1110654"
    for invalido in ("111065", "11106544", "abcdefg"):
        with pytest.raises(ValidationError):
            ServidorEntrada(siape=invalido, nome="X Y Z")


def test_nome_com_termo_proibido_e_recusado():
    """O pydantic embrulha o TextoProibido, mas a mensagem chega inteira."""
    with pytest.raises(ValidationError, match="termo proibido"):
        ServidorEntrada(siape="1110654", nome="Servidora gestante do LEAC")


def test_nup_normaliza_e_valida_formato():
    entrada = ProcessoEntrada(nup="23086 021284 2024 56", tipo_processo_id=1)
    assert entrada.nup == "23086.021284/2024-56"
    with pytest.raises(ValidationError):
        ProcessoEntrada(nup="123", tipo_processo_id=1)


def test_nup_com_dv_errado_passa_no_esquema():
    """RN-10: DV inválido é aviso, não bloqueio — quem decide é a rota."""
    entrada = ProcessoEntrada(nup="23086.021284/2024-99", tipo_processo_id=1)
    assert entrada.nup == "23086.021284/2024-99"


def test_observacoes_com_dado_de_saude():
    with pytest.raises(ValidationError, match="termo proibido"):
        ProcessoEntrada(
            nup="23086.021284/2024-56",
            tipo_processo_id=1,
            observacoes="apresentou atestado medico",
        )


def test_laudo_valida_o_padrao_siape():
    laudo = LaudoEntrada(
        numero_siape="26255-000.125/2019", tipo_adicional_id=1, unidade_uorg_id=1
    )
    assert laudo.ano == 2019
    with pytest.raises(ValidationError):
        LaudoEntrada(numero_siape="1/2019", tipo_adicional_id=1, unidade_uorg_id=1)


def test_laudo_nao_aceita_data_de_validade():
    """IN 15/2022, art. 10, §3º — não existe campo de validade."""
    with pytest.raises(ValidationError):
        LaudoEntrada(
            numero_siape="26255-000.125/2019",
            tipo_adicional_id=1,
            unidade_uorg_id=1,
            data_validade=date(2029, 1, 1),
        )


def test_excecao_do_art9_exige_justificativa():
    exposicao = ExposicaoEntrada(
        agente_nocivo_id=1, percentual_id=1, excecao_art9_par_unico=True
    )
    with pytest.raises(ValueError, match="art. 9º"):
        exposicao.conferir_excecao()

    com_justificativa = ExposicaoEntrada(
        agente_nocivo_id=1,
        percentual_id=1,
        excecao_art9_par_unico=True,
        justificativa_art9="Anexo 14 da NR-15 dispensa a habitualidade.",
    )
    com_justificativa.conferir_excecao()


def test_jornada_precisa_ser_positiva():
    with pytest.raises(ValidationError):
        ExposicaoEntrada(agente_nocivo_id=1, percentual_id=1, jornada_mensal_horas=0)


def test_numero_da_portaria_perde_zeros_a_esquerda():
    """RN-10: 001, 01 e 1 são a mesma portaria."""
    for bruto in ("001", "01", "1"):
        entrada = PortariaEntrada(
            texto_original="PORTARIA/FAMED Nº 001, DE 05 DE MARÇO DE 2024",
            unidade_emissora_id=1,
            numero=bruto,
        )
        assert entrada.numero == "1"
    assert entrada.texto_original == "PORTARIA/FAMED Nº 001, DE 05 DE MARÇO DE 2024"


def test_campo_desconhecido_e_recusado():
    with pytest.raises(ValidationError):
        ServidorEntrada(siape="1110654", nome="Fulano de Tal", cpf="000.000.000-00")
