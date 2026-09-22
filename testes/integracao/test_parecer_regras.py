"""RN-15 (congelamento), RN-22 (radiologicos) e montagem da recomendacao."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.modelos import ParecerTecnico, SetorEmissor, TextoPadrao, TipoAdicional
from app.servicos import parecer as servico
from app.servicos.rbac import UsuarioAtual

TODAS = frozenset({"parecer.emitir", "parecer.assinar", "parecer.anular", "laudo.criar"})


def test_setor_emissor_vigente_por_data(sessao):
    antigo = servico.setor_emissor_vigente(sessao, date(2025, 2, 11))
    intermediario = servico.setor_emissor_vigente(sessao, date(2026, 2, 11))
    novo = servico.setor_emissor_vigente(sessao, date(2026, 7, 1))
    assert antigo.sigla_composta == "SEST/DASA/PROGEP"
    assert antigo.nome_extenso == "Serviço Especializado em Segurança do Trabalho"
    # mesma sigla, cabecalho diferente em 2026 (observado nos assinados 1, 2 e 8/2026)
    assert intermediario.sigla_composta == "SEST/DASA/PROGEP"
    assert intermediario.nome_extenso == "Seção de Segurança do Trabalho"
    assert novo.sigla_composta == "CSSO/Sisa"


def test_cidade_e_do_setor_emissor_nao_do_campus_avaliado(sessao):
    """O 2/2026 é da FAMMUC (Teófilo Otoni) e foi datado em Diamantina."""
    for setor in sessao.execute(select(SetorEmissor)).scalars():
        assert setor.cidade == "Diamantina"


def test_parecer_de_18_06_2026_ainda_sai_com_a_sigla_antiga(sessao):
    """A data de corte é 18/06/2026 (o 8/2026 saiu assim). Ver PENDENCIAS.md."""
    setor = servico.setor_emissor_vigente(sessao, date(2026, 6, 18))
    assert setor.sigla_composta == "SEST/DASA/PROGEP"


def test_sem_setor_vigente_devolve_none(sessao):
    # empurra todas as vigencias para o futuro (datas distintas: a chave e
    # (sigla, inicio de vigencia))
    for i, setor in enumerate(sessao.execute(select(SetorEmissor)).scalars()):
        setor.vigencia_inicio = date(2030, 1, 1 + i)
        setor.vigencia_fim = None
    sessao.flush()
    assert servico.setor_emissor_vigente(sessao, date(2026, 1, 1)) is None


@pytest.mark.parametrize(
    "codigo,esperado",
    [
        (
            "RECONHECER_DIREITO_PORTARIA_V1",
            "a partir da data da Portaria de Localização: 17 de Setembro de 2024",
        ),
        (
            "RECONHECER_DIREITO_PORTARIA_V2",
            "a partir da portaria de localização 17 de setembro de 2024",
        ),
        ("RECONHECER_DIREITO_SOLICITACAO", "a partir da data da solicitação 17/09/2024"),
    ],
)
def test_tres_variantes_de_recomendacao(sessao, codigo, esperado):
    modelo = sessao.execute(
        select(TextoPadrao).where(
            TextoPadrao.categoria == "RECOMENDACAO", TextoPadrao.codigo == codigo
        )
    ).scalar_one()
    texto = servico.montar_recomendacao(
        codigo,
        "adicional de insalubridade",
        "Agente Biológico",
        date(2024, 9, 17),
        modelo.template,
    )
    assert texto.startswith(
        "Reconhecer o direito ao adicional de insalubridade caracterizado pela "
        "exposição ao Agente Biológico"
    )
    assert texto.endswith(esperado)


def test_rn22_raios_x_exige_os_tres_requisitos(sessao):
    raios = sessao.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "RAIOS_X")
    ).scalar_one()
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    parecer.tipo_adicional_id = raios.id
    sessao.add(parecer)
    sessao.flush()

    bloqueios = servico._validar_radiologico(parecer)
    assert any("12 horas semanais" in b for b in bloqueios)
    assert any("designação do dirigente" in b for b in bloqueios)
    assert any("CONTROLADA" in b for b in bloqueios)

    parecer.horas_semanais_fonte = 20
    parecer.portaria_designacao_dirigente_id = 1
    parecer.area_radiologica = "CONTROLADA"
    assert servico._validar_radiologico(parecer) == []


def test_rn22_irradiacao_exige_area(sessao):
    irradiacao = sessao.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "IRRADIACAO_IONIZANTE")
    ).scalar_one()
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    parecer.tipo_adicional_id = irradiacao.id
    sessao.add(parecer)
    sessao.flush()

    bloqueios = servico._validar_radiologico(parecer)
    assert any("CNEN" in b for b in bloqueios)

    parecer.area_radiologica = "SUPERVISIONADA"
    assert servico._validar_radiologico(parecer) == []


def test_insalubridade_nao_dispara_regra_radiologica(sessao):
    insalubridade = sessao.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
    ).scalar_one()
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    parecer.tipo_adicional_id = insalubridade.id
    assert servico._validar_radiologico(parecer) == []


def test_sem_tipo_de_adicional_nao_valida_radiologico():
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    assert servico._validar_radiologico(parecer) == []


def test_rn13_revisao_exige_parecer_anterior(sessao):
    from app.modelos import TipoMovimento

    revisao = sessao.execute(
        select(TipoMovimento).where(TipoMovimento.codigo == "REVISAO")
    ).scalar_one()
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    parecer.tipo_movimento_id = revisao.id
    sessao.add(parecer)
    sessao.flush()
    validacao = servico.validar(sessao, parecer)
    assert any("parecer anterior" in b for b in validacao.bloqueios)


def test_emissao_sem_permissao(sessao):
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    sessao.add(parecer)
    sessao.flush()
    sem = UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset({"parecer.ver"}), perfis=()
    )
    from app.servicos.rbac import PermissaoNegada

    with pytest.raises(PermissaoNegada):
        servico.emitir(sessao, parecer, sem)


def test_exposicao_principal_sem_marcacao_usa_a_primeira():
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    assert servico.exposicao_principal(parecer) is None


def test_classificacao_sem_horas_fica_nula():
    assert servico.classificar_exposicao(None, 160) == (None, None)
    assert servico.classificar_exposicao(160, None) == (None, None)
    assert servico.classificar_exposicao(0, 160) == (None, None)


def test_anular_exige_permissao(sessao):
    parecer = ParecerTecnico(numero=0, ano=2026, situacao="RASCUNHO")
    sessao.add(parecer)
    sessao.flush()
    sem = UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset({"parecer.ver"}), perfis=()
    )
    from app.servicos.rbac import PermissaoNegada

    with pytest.raises(PermissaoNegada):
        servico.anular(sessao, parecer, sem, "motivo qualquer")


def test_superar_laudo_exige_permissao(sessao):
    from app.modelos import LaudoTecnico, UnidadeUorg
    from app.servicos.rbac import PermissaoNegada

    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    insalubridade = sessao.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
    ).scalar_one()
    laudo = LaudoTecnico(
        numero_siape="26255-000.999/2019",
        ano=2019,
        tipo_adicional_id=insalubridade.id,
        unidade_uorg_id=unidade.id,
    )
    sessao.add(laudo)
    sessao.flush()
    sem = UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset({"laudo.ver"}), perfis=()
    )
    with pytest.raises(PermissaoNegada):
        servico.marcar_laudo_superado(sessao, laudo, sem, "motivo")


_ = TODAS
