"""Fase 4 - os cinco relatorios, e os anexos do Trello."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select

from app.config import RAIZ
from app.modelos import Anexo, MigracaoRejeitada, ParecerTecnico, Processo
from app.servicos import importacao_trello as imp, reconciliacao
from app.servicos.rbac import UsuarioAtual
from testes.integracao.conftest import entrar

QUADRO = RAIZ / "testes" / "fixtures" / "trello_quadro.json"

ARQUIVOS_FALSOS = {
    "https://exemplo/a.pdf": b"%PDF-1.4 parecer assinado do Genilton",
    "https://exemplo/b.pdf": b"%PDF-1.4 laudo do Marcilio",
}


def buscar_falso(url: str) -> bytes:
    if url not in ARQUIVOS_FALSOS:
        raise FileNotFoundError(f"URL expirada: {url}")
    return ARQUIVOS_FALSOS[url]


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
        permissoes=frozenset({"catalogo.gerenciar", "anexo.enviar"}),
        perfis=("coordenador_csso",),
    )


# ---------------------------------------------------------------------
# Anexos do Trello
# ---------------------------------------------------------------------
def test_anexos_sao_baixados_e_guardados(sessao, operador):
    relatorio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=buscar_falso
    )
    sessao.flush()
    assert relatorio.anexos == 2
    assert relatorio.anexos_perdidos == []

    guardados = list(sessao.execute(select(Anexo)).scalars())
    assert len(guardados) == 2
    nomes = {a.nome_original for a in guardados}
    assert "Parecer_Tecnico_05-2026 (1234567).pdf" in nomes
    # SHA-256 calculado no momento da carga
    assert all(len(a.sha256) == 64 for a in guardados)
    assert all(a.origem_migracao == "TRELLO" for a in guardados)


def test_numero_do_documento_sei_sai_do_nome_do_anexo(sessao, operador):
    imp.importar(sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=buscar_falso)
    sessao.flush()
    anexo = sessao.execute(
        select(Anexo).where(Anexo.nome_original.like("Parecer%"))
    ).scalar_one()
    assert anexo.numero_documento_sei == "1234567"
    assert anexo.categoria == "PARECER_ASSINADO"


def test_categoria_deduzida_do_nome(sessao, operador):
    imp.importar(sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=buscar_falso)
    sessao.flush()
    laudo = sessao.execute(
        select(Anexo).where(Anexo.nome_original.like("Laudo%"))
    ).scalar_one()
    assert laudo.categoria == "LAUDO"
    assert imp.categoria_do_anexo("Portaria FAMED.pdf") == "PORTARIA"
    assert imp.categoria_do_anexo("qualquer coisa.txt") == "OUTRO"


def test_sem_rede_o_anexo_vira_pendencia_com_a_url(sessao, operador):
    """As URLs expiram: o que não baixou precisa aparecer, não sumir."""
    relatorio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=None
    )
    sessao.flush()
    assert relatorio.anexos == 0
    assert len(relatorio.anexos_perdidos) == 2
    assert any("https://exemplo/" in motivo for _nome, motivo in relatorio.anexos_perdidos)

    rejeitadas = list(
        sessao.execute(
            select(MigracaoRejeitada).where(MigracaoRejeitada.motivo.like("anexo%"))
        ).scalars()
    )
    assert len(rejeitadas) == 2
    assert all(r.payload.get("url") for r in rejeitadas)


def test_url_expirada_nao_derruba_a_carga(sessao, operador):
    def sempre_falha(url: str) -> bytes:
        raise TimeoutError("a URL expirou")

    relatorio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=sempre_falha
    )
    sessao.flush()
    assert relatorio.processos > 0
    assert len(relatorio.anexos_perdidos) == 2
    assert any("TimeoutError" in motivo for _n, motivo in relatorio.anexos_perdidos)


def test_anexo_duplicado_nao_entra_duas_vezes(sessao, operador):
    imp.importar(sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=buscar_falso)
    sessao.flush()
    relatorio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=buscar_falso
    )
    sessao.flush()
    assert relatorio.anexos == 0
    assert relatorio.anexos_duplicados == 2
    assert len(list(sessao.execute(select(Anexo)).scalars())) == 2


def test_laudo_candidato_entra_no_relatorio(sessao, operador):
    relatorio = imp.importar(
        sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=buscar_falso
    )
    assert any(
        c["laudo_candidato"] == "26255-000.110/2022" for c in relatorio.laudos_candidatos
    )


# ---------------------------------------------------------------------
# Os cinco relatorios
# ---------------------------------------------------------------------
@pytest.fixture()
def migrado(sessao, operador):
    imp.importar(sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=buscar_falso)
    sessao.flush()
    return operador


def test_reconciliacao_tem_as_cinco_secoes(sessao, migrado):
    resultado = reconciliacao.reconciliar(sessao)
    titulos = [titulo for titulo, _d, _a in resultado.como_secoes()]
    assert titulos == [
        "Órfãos de processo",
        "Órfãos de parecer",
        "Conflito de numeração",
        "NUPs com dígito verificador inválido",
        "Divergência de marco inicial",
    ]


def test_orfaos_de_processo_pegam_cartao_sem_nup(sessao, migrado):
    resultado = reconciliacao.reconciliar(sessao)
    detalhes = " ".join(a.detalhe for a in resultado.orfaos_processo)
    assert "Sebastião Aparecido" in detalhes


def test_nup_sintetico_aparece_como_orfao(sessao, operador):
    """Cartão com servidor conhecido mas sem NUP vira processo com NUP sintético."""
    from app.modelos import Servidor

    sessao.add(Servidor(siape="9999999", nome="Sebastião Aparecido"))
    sessao.flush()

    imp.importar(sessao, Path(QUADRO), operador, aplicar=True, buscar_anexo=None)
    sessao.flush()

    sinteticos = list(
        sessao.execute(select(Processo).where(Processo.nup.like("23086.%/1900-%"))).scalars()
    )
    assert sinteticos, "o cartão sem NUP precisa de chave única para existir"
    from app.servicos import nup as servico_nup

    assert servico_nup.validar(sinteticos[0].nup).dv_ok, "o NUP sintético tem DV válido"

    resultado = reconciliacao.reconciliar(sessao)
    assert any("sintético" in a.detalhe for a in resultado.orfaos_processo)


def test_conflito_de_numeracao_expoe_candidato_sem_parecer(sessao, migrado):
    resultado = reconciliacao.reconciliar(sessao)
    detalhes = " ".join(a.detalhe for a in resultado.conflitos_numeracao)
    assert "1/2025" in detalhes


def test_nup_com_dv_invalido_aparece(sessao, migrado):
    from app.modelos import FluxoEtapa, TipoProcesso

    tipo = sessao.execute(select(TipoProcesso)).scalars().first()
    etapa = sessao.execute(select(FluxoEtapa)).scalars().first()
    sessao.add(
        Processo(
            nup="23086.021284/2024-99",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            nup_dv_dispensado=True,
        )
    )
    sessao.flush()
    resultado = reconciliacao.reconciliar(sessao)
    achados = {a.referencia for a in resultado.nups_dv_invalido}
    assert "23086.021284/2024-99" in achados
    assert any("dispensa registrada" in a.detalhe for a in resultado.nups_dv_invalido)


def test_divergencia_de_marco(sessao, cenario, migrado):
    parecer = cenario["parecer"]
    parecer.data_marco_inicial = date(2024, 1, 1)  # portaria e 17/09/2024
    sessao.flush()
    resultado = reconciliacao.reconciliar(sessao)
    assert any("01/01/2024" in a.detalhe for a in resultado.divergencias_marco)


def test_orfao_de_parecer_sem_processo(sessao, migrado):
    sessao.add(ParecerTecnico(numero=77, ano=2026, situacao="RASCUNHO"))
    sessao.flush()
    resultado = reconciliacao.reconciliar(sessao)
    assert any(a.referencia == "77/2026" for a in resultado.orfaos_parecer)


def test_reservado_nao_conta_como_orfao(sessao, migrado):
    sessao.add(ParecerTecnico(numero=78, ano=2026, situacao="RESERVADO"))
    sessao.flush()
    resultado = reconciliacao.reconciliar(sessao)
    assert not any(a.referencia == "78/2026" for a in resultado.orfaos_parecer)
    # mas aparece no conflito de numeracao, para conferencia
    assert any(a.referencia == "78/2026" for a in resultado.conflitos_numeracao)


def test_tela_de_reconciliacao(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/importar/reconciliacao")
    assert resposta.status_code == 200
    for titulo in ("Órfãos de processo", "Conflito de numeração", "Divergência de marco"):
        assert titulo in resposta.text


def test_reconciliacao_em_csv(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/importar/reconciliacao.csv")
    assert resposta.status_code == 200
    assert resposta.content.startswith(b"\xef\xbb\xbf")
    assert b"Relat" in resposta.content


def test_reconciliacao_exige_permissao(app_cliente, contas):
    entrar(app_cliente, contas, "secretaria_csso")
    assert app_cliente.get("/importar/reconciliacao").status_code == 403
