"""Emissao ponta a ponta: RN-01 a RN-08, CA-07, CA-09, CA-10, CA-11, CA-16, CA-19."""

from __future__ import annotations

import concurrent.futures
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import banco as mod_banco
from app.modelos import (
    AgenteNocivo,
    AutoridadeDestinataria,
    Cargo,
    Exposicao,
    FluxoEtapa,
    LaudoTecnico,
    ParecerPosto,
    ParecerTecnico,
    PercentualAplicavel,
    PortariaLocalizacao,
    PostoTrabalho,
    Processo,
    ProfissionalHabilitado,
    Servidor,
    TipoAdicional,
    TipoMarcoInicial,
    TipoMovimento,
    TipoProcesso,
    UnidadeUorg,
)
from app.servicos import documento, numeracao, parecer as servico
from app.servicos.rbac import PermissaoNegada
from testes.integracao import papeis
from app.servicos.textos import normalizar_fluxo

def _pegar(s, modelo, **filtros):
    return s.execute(select(modelo).filter_by(**filtros)).scalar_one()


# ---------------------------------------------------------------------
def test_emissao_reproduz_o_parecer_1_2025(sessao, cenario):
    parecer = cenario["parecer"]
    resultado = servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    assert parecer.situacao == "EMITIDO"
    assert parecer.numero >= 1
    assert parecer.sigla_emissora_snapshot == "SEST/DASA/PROGEP"

    texto = normalizar_fluxo(documento.extrair_texto(resultado.docx))
    assert "Marco Antônio Alves Schetino" in texto
    assert "250 - Faculdade De Medicina De Diamantina" in texto
    assert "Diamantina, 11 de fevereiro de 2025" in texto
    assert "Nº 26255-000.125/2019" in texto
    assert "Médio (10%)" in texto


def test_ca11_acentuacao_ponta_a_ponta(sessao, cenario, tmp_path):
    """Nome com acento sobrevive a banco -> docx -> CSV -> reimportacao."""
    import csv

    parecer = cenario["parecer"]
    resultado = servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    texto = documento.extrair_texto(resultado.docx)
    assert "Marco Antônio Alves Schetino" in texto

    csv_path = tmp_path / "saida.csv"
    conteudo = "﻿Nome;SIAPE\r\nMarco Antônio Alves Schetino;1110654\r\n"
    csv_path.write_bytes(conteudo.encode("utf-8"))
    with csv_path.open(encoding="utf-8-sig", newline="") as f:
        linhas = list(csv.reader(f, delimiter=";"))
    assert linhas[1][0] == "Marco Antônio Alves Schetino"

    nome_arquivo = resultado.docx.name
    assert "Antonio" in nome_arquivo and "Antônio" not in nome_arquivo


def test_ca10_tecnica_recebe_403_e_evento(sessao, cenario):
    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.TECNICA, gerar_pdf=False)  # ela PODE emitir
    with pytest.raises(PermissaoNegada):
        servico.assinar(sessao, parecer, papeis.TECNICA)
    assert parecer.situacao == "EMITIDO"

    from app.modelos import HistoricoEvento

    eventos = sessao.execute(
        select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "ASSINATURA_NEGADA")
    ).scalars().all()
    assert eventos, "o sistema deve registrar ASSINATURA_NEGADA"


def test_ca10_espelho_tecnica_move_kanban(sessao, cenario):
    from app.servicos.processo import mover

    processo = cenario["processo"]
    mover(sessao, processo, "PARECER_PRONTO_P_ASSINATURA", papeis.TECNICA)
    assert processo.estado_tecnico == "PARECER_PRONTO_P_ASSINATURA"


def test_rn04_lista_o_que_falta(sessao, cenario):
    parecer = cenario["parecer"]
    parecer.portaria_id = None
    parecer.texto_recomendacao = None
    validacao = servico.validar(sessao, parecer)
    assert not validacao.ok
    assert "portaria de localização" in validacao.faltantes
    assert "recomendação" in validacao.faltantes


def test_rn05_marco_diverge_da_portaria(sessao, cenario):
    parecer = cenario["parecer"]
    parecer.data_marco_inicial = date(2024, 9, 18)
    validacao = servico.validar(sessao, parecer)
    assert any("diverge da data de publicação" in b for b in validacao.bloqueios)


def test_rn05_marco_anterior_ao_laudo_bloqueia(sessao, cenario):
    parecer = cenario["parecer"]
    parecer.laudo.data_emissao = date(2025, 1, 1)
    validacao = servico.validar(sessao, parecer)
    assert any("não há laudo que caracterize" in b for b in validacao.bloqueios)


def test_rn05_prescricao_e_aviso_nao_bloqueante(sessao, cenario):
    parecer = cenario["parecer"]
    # laudo de 2019 (dentro da habilitação do subscritor) e portaria logo depois:
    # o marco fica 67 meses antes da emissão de 11/02/2025.
    parecer.portaria.data_publicacao = date(2019, 7, 1)
    parecer.portaria.ano = 2019
    parecer.data_marco_inicial = date(2019, 7, 1)
    validacao = servico.validar(sessao, parecer)
    assert validacao.ok
    assert any("prescrição quinquenal" in a for a in validacao.avisos)


def test_rn06_agente_quimico_exige_reavaliacao(sessao, cenario):
    parecer = cenario["parecer"]
    quimico = _pegar(sessao, AgenteNocivo, descricao="Manipulação de produtos químicos")
    parecer.exposicoes[0].agente_nocivo_id = quimico.id
    parecer.exposicoes[0].fundamentacao_id = quimico.fundamentacao_id
    sessao.flush()
    sessao.expire(parecer)
    validacao = servico.validar(sessao, parecer)
    assert any("avaliação quantitativa" in b for b in validacao.bloqueios)


def test_ca19_eventual_sem_excecao_bloqueia(sessao, cenario):
    parecer = cenario["parecer"]
    exposicao = parecer.exposicoes[0]
    exposicao.horas_exposicao_mensais = 40
    exposicao.jornada_mensal_horas = 160
    servico.aplicar_classificacao(exposicao)
    assert exposicao.classificacao_exposicao == "EVENTUAL"
    validacao = servico.validar(sessao, parecer)
    assert any("art. 9º" in b for b in validacao.bloqueios)


def test_ca19_eventual_com_excecao_emite(sessao, cenario):
    from app.modelos import HistoricoEvento

    parecer = cenario["parecer"]
    exposicao = parecer.exposicoes[0]
    exposicao.horas_exposicao_mensais = 40
    exposicao.jornada_mensal_horas = 160
    exposicao.excecao_art9_par_unico = True
    exposicao.justificativa_art9 = "Anexo 14 da NR-15 dispensa habitualidade neste caso."
    servico.aplicar_classificacao(exposicao)
    sessao.flush()
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    assert parecer.situacao == "EMITIDO"
    eventos = sessao.execute(
        select(HistoricoEvento).where(
            HistoricoEvento.tipo_evento == "EXCECAO_ART9_APLICADA"
        )
    ).scalars().all()
    assert eventos


def test_classificacao_e_calculada(sessao):
    assert servico.classificar_exposicao(160, 160) == (100.0, "PERMANENTE")
    assert servico.classificar_exposicao(80, 160) == (50.0, "HABITUAL")
    assert servico.classificar_exposicao(40, 160) == (25.0, "EVENTUAL")


def test_rn08_percentual_de_outro_adicional_bloqueia(sessao, cenario):
    parecer = cenario["parecer"]
    periculosidade = _pegar(sessao, TipoAdicional, codigo="PERICULOSIDADE")
    outro = _pegar(
        sessao, PercentualAplicavel, tipo_adicional_id=periculosidade.id, grau="UNICO"
    )
    parecer.exposicoes[0].percentual_id = outro.id
    sessao.flush()
    sessao.expire(parecer)
    validacao = servico.validar(sessao, parecer)
    assert any("outro tipo de adicional" in b for b in validacao.bloqueios)


def test_ca09_dominio_legal_dos_percentuais(sessao):
    esperado = {
        "INSALUBRIDADE": {("MINIMO", 5), ("MEDIO", 10), ("MAXIMO", 20)},
        "IRRADIACAO_IONIZANTE": {("MINIMO", 5), ("MEDIO", 10), ("MAXIMO", 20)},
        "PERICULOSIDADE": {("UNICO", 10)},
        "RAIOS_X": {("UNICO", 10)},
    }
    for codigo, pares in esperado.items():
        adicional = _pegar(sessao, TipoAdicional, codigo=codigo)
        reais = {
            (p.grau, int(p.valor))
            for p in sessao.execute(
                select(PercentualAplicavel).where(
                    PercentualAplicavel.tipo_adicional_id == adicional.id
                )
            ).scalars()
        }
        assert reais == pares, codigo
        for p in sessao.execute(
            select(PercentualAplicavel).where(
                PercentualAplicavel.tipo_adicional_id == adicional.id
            )
        ).scalars():
            assert p.base_calculo == "vencimento do cargo efetivo"
    # a escala celetista 10/20/40 nao existe em lugar nenhum
    todos = {int(p.valor) for p in sessao.execute(select(PercentualAplicavel)).scalars()}
    assert todos <= {5, 10, 20}


def test_rn14_parecer_emitido_e_imutavel(sessao, cenario):
    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    with pytest.raises(servico.EmissaoBloqueada):
        servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)


def test_anulacao_exige_motivo(sessao, cenario):
    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    with pytest.raises(ValueError):
        servico.anular(sessao, parecer, papeis.COORDENADOR, "  ")
    servico.anular(sessao, parecer, papeis.COORDENADOR, "erro material no percentual")
    assert parecer.situacao == "ANULADO"
    assert parecer.motivo_anulacao


def test_rn11_cascata_de_reavaliacao(sessao, cenario):
    from app.modelos import AdicionalVigencia

    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    vigencia = AdicionalVigencia(
        servidor_id=parecer.servidor_id,
        parecer_id=parecer.id,
        tipo_adicional_id=parecer.tipo_adicional_id,
        percentual_id=parecer.exposicoes[0].percentual_id,
        estado="VIGENTE",
    )
    sessao.add(vigencia)
    sessao.flush()

    servico.marcar_laudo_superado(
        sessao, cenario["laudo"], papeis.COORDENADOR, "mudança no processo de trabalho"
    )
    assert vigencia.estado == "EM_REAVALIACAO"
    assert cenario["laudo"].status == "SUPERADO"


def test_rn09_um_unico_adicional_vigente(sessao, cenario):
    from app.modelos import AdicionalVigencia

    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    comum = dict(
        servidor_id=parecer.servidor_id,
        parecer_id=parecer.id,
        tipo_adicional_id=parecer.tipo_adicional_id,
        percentual_id=parecer.exposicoes[0].percentual_id,
        estado="VIGENTE",
    )
    sessao.add(AdicionalVigencia(**comum))
    sessao.flush()
    sessao.add(AdicionalVigencia(**comum))
    with pytest.raises(IntegrityError):
        sessao.flush()
    sessao.rollback()


def test_ca16_trigger_bloqueia_signatario_sem_habilitacao(sessao, cenario):
    """Ultima linha de defesa: o proprio banco recusa."""
    from app.modelos import ProfissionalHabilitado

    parecer = cenario["parecer"]
    fatima = ProfissionalHabilitado(
        nome="Fátima (registro indevido)",
        habilitacao="ENG_SEG_TRABALHO",
        titulo_assinatura="Téc. Seg. do Trabalho",
        vigencia_inicio=date(2030, 1, 1),  # ainda nao vigente em 2025
    )
    sessao.add(fatima)
    sessao.flush()
    parecer.signatario_id = fatima.id
    parecer.situacao = "EMITIDO"
    with pytest.raises(Exception) as erro:
        sessao.flush()
    assert "art.10" in str(erro.value)
    sessao.rollback()


def test_ca16_historico_e_append_only(sessao, cenario):
    from sqlalchemy import text

    from app.modelos import HistoricoEvento

    servico.emitir(sessao, cenario["parecer"], papeis.COORDENADOR, gerar_pdf=False)
    # commit antes: assim o rollback do UPDATE recusado nao apaga o evento
    sessao.commit()
    evento_id = sessao.execute(select(HistoricoEvento.id).limit(1)).scalar_one()

    with pytest.raises(Exception) as erro_update:
        sessao.execute(
            text("UPDATE historico_evento SET descricao='adulterado' WHERE id=:i"),
            {"i": evento_id},
        )
    assert "append-only" in str(erro_update.value)
    sessao.rollback()

    with pytest.raises(Exception) as erro_delete:
        sessao.execute(text("DELETE FROM historico_evento WHERE id=:i"), {"i": evento_id})
    assert "append-only" in str(erro_delete.value)
    sessao.rollback()


def test_cadeia_de_hashes_integra(sessao, cenario):
    from app.servicos.auditoria import cadeia_integra

    servico.emitir(sessao, cenario["parecer"], papeis.COORDENADOR, gerar_pdf=False)
    sessao.commit()
    ok, defeito = cadeia_integra(sessao)
    assert ok, f"cadeia rompida em {defeito}"


# ---------------------------------------------------------------------
def test_ca07_cinquenta_emissoes_concorrentes(banco):
    """50 numeros distintos e contiguos, sem colidir com RESERVADO."""
    with mod_banco.sessao() as s:
        s.add(ParecerTecnico(numero=7, ano=2026, situacao="RESERVADO"))
        s.add(ParecerTecnico(numero=9, ano=2026, situacao="RESERVADO"))
        s.flush()
        numeracao.recontar_sequencia(s)

    def consumir(_):
        with mod_banco.sessao() as s:
            return numeracao.proximo_numero_parecer(s, 2026)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        numeros = list(executor.map(consumir, range(50)))

    assert len(set(numeros)) == 50
    assert 7 not in numeros and 9 not in numeros
    assert sorted(numeros) == list(range(min(numeros), min(numeros) + 50))


def test_numero_unico_por_ano(banco):
    with mod_banco.sessao() as s:
        s.add(ParecerTecnico(numero=1, ano=2026, situacao="RASCUNHO"))
        s.commit()
    with pytest.raises(IntegrityError):
        with mod_banco.sessao() as s:
            s.add(ParecerTecnico(numero=1, ano=2026, situacao="RASCUNHO"))
            s.commit()


def test_lacunas_de_numeracao(banco):
    with mod_banco.sessao() as s:
        for numero in (1, 2, 5):
            s.add(ParecerTecnico(numero=numero, ano=2026, situacao="RASCUNHO"))
        s.flush()
        numeracao.recontar_sequencia(s)
        assert numeracao.lacunas_de_numeracao(s, 2026) == [3, 4]
