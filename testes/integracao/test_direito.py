"""Maquina B - o direito concedido. RN-09 e RN-21."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.modelos import (
    AdicionalVigencia,
    Anexo,
    HistoricoEvento,
    ParecerTecnico,
    Pendencia,
    PercentualAplicavel,
    TipoAdicional,
)
from app.modelos.estados import TransicaoInvalida
from app.servicos import direito, parecer as servico_parecer
from app.servicos.rbac import PermissaoNegada
from testes.integracao import papeis


@pytest.fixture()
def coord(atores):
    return papeis.COORDENADOR


@pytest.fixture()
def emitido(sessao, cenario, coord):
    """Reaproveita o cenário do 1/2025 e emite."""
    servico_parecer.emitir(sessao, cenario["parecer"], coord, gerar_pdf=False)
    return cenario


def test_propor_a_partir_do_parecer(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    assert vigencia.estado == "PROPOSTO"
    assert vigencia.servidor_id == emitido["parecer"].servidor_id
    assert vigencia.percentual_id == emitido["parecer"].exposicoes[0].percentual_id
    # idempotente
    assert direito.propor(sessao, emitido["parecer"], coord).id == vigencia.id


def test_propor_exige_parecer_emitido(sessao, cenario, coord):
    with pytest.raises(direito.RegraDoDireito, match="emitido ou assinado"):
        direito.propor(sessao, cenario["parecer"], coord)


def test_propor_recusa_movimento_que_nao_gera_direito(sessao, emitido, coord):
    from app.modelos import TipoMovimento

    cancelamento = sessao.execute(
        select(TipoMovimento).where(TipoMovimento.codigo == "CANCELAMENTO")
    ).scalar_one()
    emitido["parecer"].tipo_movimento_id = cancelamento.id
    sessao.flush()
    sessao.expire(emitido["parecer"])
    with pytest.raises(direito.RegraDoDireito, match="não gera direito"):
        direito.propor(sessao, emitido["parecer"], coord)


def test_conceder_exige_portaria(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    with pytest.raises(direito.RegraDoDireito, match="portaria de concessão"):
        direito.conceder(
            sessao,
            vigencia,
            coord,
            portaria_concessao="   ",
            data_portaria=date(2025, 3, 1),
            data_inicio=date(2024, 9, 17),
        )


def test_conceder_coloca_em_vigor(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        vigencia,
        coord,
        portaria_concessao="Portaria PROGEP nº 120/2025",
        data_portaria=date(2025, 3, 1),
        data_inicio=date(2024, 9, 17),
    )
    assert vigencia.estado == "VIGENTE"
    assert vigencia.data_inicio == date(2024, 9, 17)
    assert direito.vigente_do_servidor(sessao, vigencia.servidor_id) is vigencia

    eventos = sessao.execute(
        select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "DIREITO_VIGENTE")
    ).scalars().all()
    assert eventos


def _segundo_parecer(sessao, cenario):
    """Um segundo parecer do mesmo servidor, para testar a não acumulação."""
    original = cenario["parecer"]
    novo = ParecerTecnico(
        numero=99,
        ano=2025,
        situacao="EMITIDO",
        processo_id=original.processo_id,
        servidor_id=original.servidor_id,
        laudo_id=original.laudo_id,
        tipo_adicional_id=original.tipo_adicional_id,
        tipo_movimento_id=original.tipo_movimento_id,
        unidade_uorg_id=original.unidade_uorg_id,
        portaria_id=original.portaria_id,
        destinatario_id=original.destinatario_id,
        signatario_id=original.signatario_id,
        tipo_marco_id=original.tipo_marco_id,
        data_marco_inicial=original.data_marco_inicial,
        data_emissao=original.data_emissao,
        texto_recomendacao=original.texto_recomendacao,
    )
    sessao.add(novo)
    sessao.flush()
    from app.modelos import Exposicao

    exposicao = original.exposicoes[0]
    sessao.add(
        Exposicao(
            parecer_id=novo.id,
            agente_nocivo_id=exposicao.agente_nocivo_id,
            percentual_id=exposicao.percentual_id,
            fundamentacao_id=exposicao.fundamentacao_id,
            principal=True,
        )
    )
    sessao.flush()
    sessao.expire(novo)
    return novo


def test_rn09_sem_registro_de_opcao_nao_concede_o_segundo(sessao, emitido, coord):
    primeiro = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        primeiro,
        coord,
        portaria_concessao="Portaria PROGEP nº 1/2025",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    segundo = direito.propor(sessao, _segundo_parecer(sessao, emitido), coord)
    with pytest.raises(direito.RegraDoDireito, match="registro de opção"):
        direito.conceder(
            sessao,
            segundo,
            coord,
            portaria_concessao="Portaria PROGEP nº 2/2025",
            data_portaria=date(2025, 6, 1),
            data_inicio=date(2025, 6, 1),
        )
    assert primeiro.estado == "VIGENTE"
    assert segundo.estado == "PROPOSTO"


def test_rn09_com_registro_de_opcao_encadeia_as_datas(sessao, emitido, coord):
    primeiro = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        primeiro,
        coord,
        portaria_concessao="Portaria PROGEP nº 1/2025",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    segundo = direito.propor(sessao, _segundo_parecer(sessao, emitido), coord)

    registro = Anexo(
        entidade="adicional_vigencia",
        entidade_id=segundo.id,
        nome_arquivo="opcao.pdf",
        nome_original="opcao.pdf",
        mime_type="application/pdf",
        tamanho_bytes=10,
        sha256="f" * 64,
        storage_key="ff/" + "f" * 64,
        categoria="OUTRO",
    )
    sessao.add(registro)
    sessao.flush()
    segundo.registro_opcao_anexo_id = registro.id
    sessao.flush()

    direito.conceder(
        sessao,
        segundo,
        coord,
        portaria_concessao="Portaria PROGEP nº 2/2025",
        data_portaria=date(2025, 6, 1),
        data_inicio=date(2025, 6, 1),
    )
    assert segundo.estado == "VIGENTE"
    assert primeiro.estado == "CESSADO"
    # sem lacuna nem sobreposicao: o anterior termina na vespera
    assert primeiro.data_fim == date(2025, 5, 31)
    assert direito.lacunas_na_linha_do_tempo(sessao, segundo.servidor_id) == []


def test_indice_unico_impede_dois_vigentes(sessao, emitido, coord):
    primeiro = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        primeiro,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    sessao.add(
        AdicionalVigencia(
            servidor_id=primeiro.servidor_id,
            parecer_id=primeiro.parecer_id,
            tipo_adicional_id=primeiro.tipo_adicional_id,
            percentual_id=primeiro.percentual_id,
            estado="VIGENTE",
        )
    )
    with pytest.raises(IntegrityError):
        sessao.flush()
    sessao.rollback()


def test_rn21_afastamento_legal_nao_cita_gestacao(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        vigencia,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    direito.suspender_por_afastamento_legal(sessao, vigencia, coord)
    assert vigencia.estado == "SUSPENSO"
    assert vigencia.motivo_suspensao == "AFASTAMENTO_LEGAL"
    assert vigencia.base_legal_suspensao == "Lei 8.112/90, art. 69, p.ú."

    eventos = sessao.execute(
        select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "DIREITO_SUSPENSO")
    ).scalars().all()
    for evento in eventos:
        texto = (evento.descricao or "").lower()
        for proibido in ("gesta", "gravid", "lacta"):
            assert proibido not in texto


def test_motivo_de_suspensao_fora_do_enum(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        vigencia,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    with pytest.raises(direito.RegraDoDireito, match="motivo de suspensão inválido"):
        direito.suspender(sessao, vigencia, coord, motivo="GESTACAO")


def test_retomar_depois_de_suspender(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        vigencia,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    direito.suspender(sessao, vigencia, coord, motivo="AFASTAMENTO_DO_LOCAL")
    direito.retomar(sessao, vigencia, coord, date(2025, 8, 1))
    assert vigencia.estado == "VIGENTE"
    assert vigencia.motivo_suspensao is None


def test_cessar_recusa_data_anterior_ao_inicio(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        vigencia,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 6, 1),
    )
    with pytest.raises(direito.RegraDoDireito, match="anterior ao início"):
        direito.cessar(sessao, vigencia, coord, data_fim=date(2025, 1, 1))


def test_cessado_e_terminal(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.cessar(sessao, vigencia, coord, data_fim=date(2025, 12, 31))
    assert vigencia.estado == "CESSADO"
    with pytest.raises(TransicaoInvalida):
        direito.retomar(sessao, vigencia, coord, date(2026, 1, 1))


def test_alterar_percentual_registra_o_antes_e_depois(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        vigencia,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    insalubridade = sessao.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
    ).scalar_one()
    maximo = sessao.execute(
        select(PercentualAplicavel).where(
            PercentualAplicavel.tipo_adicional_id == insalubridade.id,
            PercentualAplicavel.grau == "MAXIMO",
        )
    ).scalar_one()
    anterior = vigencia.percentual_id
    direito.alterar(
        sessao, vigencia, coord, percentual_id=maximo.id, motivo="nova quantificação"
    )
    assert vigencia.percentual_id == maximo.id
    evento = sessao.execute(
        select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "DIREITO_ALTERADO")
    ).scalars().first()
    assert evento.valor_anterior == anterior
    assert evento.valor_novo == maximo.id


def test_reavaliar_abre_pendencia(sessao, emitido, coord):
    vigencia = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        vigencia,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    direito.reavaliar(sessao, vigencia, coord, "mudança de layout do laboratório")
    assert vigencia.estado == "EM_REAVALIACAO"
    pendencia = sessao.execute(
        select(Pendencia).where(Pendencia.tipo == "REAVALIACAO_LAUDO")
    ).scalars().first()
    assert pendencia is not None and not pendencia.concluida


def test_sem_permissao_nao_concede(sessao, emitido):
    from app.servicos.rbac import UsuarioAtual

    consulta = UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset({"parecer.ver"}), perfis=()
    )
    with pytest.raises(PermissaoNegada):
        direito.propor(sessao, emitido["parecer"], consulta)


def test_lacuna_na_linha_do_tempo_e_detectada(sessao, emitido, coord):
    primeiro = direito.propor(sessao, emitido["parecer"], coord)
    direito.conceder(
        sessao,
        primeiro,
        coord,
        portaria_concessao="Portaria 1",
        data_portaria=date(2025, 1, 2),
        data_inicio=date(2025, 1, 1),
    )
    direito.cessar(sessao, primeiro, coord, data_fim=date(2025, 3, 31))
    segundo = direito.propor(sessao, _segundo_parecer(sessao, emitido), coord)
    direito.conceder(
        sessao,
        segundo,
        coord,
        portaria_concessao="Portaria 2",
        data_portaria=date(2025, 6, 1),
        data_inicio=date(2025, 6, 1),
    )
    problemas = direito.lacunas_na_linha_do_tempo(sessao, segundo.servidor_id)
    assert any("lacuna" in p for p in problemas)
