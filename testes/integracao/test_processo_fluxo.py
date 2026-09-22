"""Servico de processo: requisitos de saida, SLA, sobrestamento e kanban."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.modelos import (
    FluxoEtapa,
    LaudoTecnico,
    Processo,
    TipoAdicional,
    TipoProcesso,
    UnidadeUorg,
    agora_utc,
)
from app.modelos.estados import TransicaoInvalida
from app.repositorios import processos as repo
from app.servicos import anexos as servico_anexos
from app.servicos.processo import (
    SLA_PADRAO,
    RequisitoDeSaidaNaoAtendido,
    mover,
    requisitos_de_saida,
    resumir,
    voltar_do_sobrestamento,
)
from app.servicos.rbac import PermissaoNegada, UsuarioAtual

PERMISSOES = frozenset(
    {"processo.ver", "processo.criar", "processo.editar", "processo.status", "anexo.enviar"}
)


@pytest.fixture()
def ator(sessao):
    from app.modelos import Usuario
    from app.servicos import autenticacao

    usuario = Usuario(
        login="op",
        nome="Operador",
        email="op@teste.ufvjm.edu.br",
        senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
    )
    sessao.add(usuario)
    sessao.flush()
    return UsuarioAtual(
        id=usuario.id,
        login="op",
        nome="Operador",
        permissoes=PERMISSOES,
        perfis=("coordenador_csso",),
    )


@pytest.fixture()
def processo(sessao):
    tipo = sessao.execute(
        select(TipoProcesso).where(TipoProcesso.codigo == "ADICIONAL_OCUPACIONAL")
    ).scalar_one()
    etapa = sessao.execute(
        select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
    ).scalar_one()
    famed = sessao.execute(
        select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
    ).scalar_one()
    registro = Processo(
        nup="23086.021284/2024-56",
        tipo_processo_id=tipo.id,
        etapa_id=etapa.id,
        estado_tecnico="EM_TRIAGEM",
        unidade_uorg_id=famed.id,
    )
    sessao.add(registro)
    sessao.flush()
    return registro


def _anexar(sessao, processo, categoria, ator, conteudo=b"x"):
    return servico_anexos.guardar(
        sessao,
        entidade="processo",
        entidade_id=processo.id,
        nome_original=f"{categoria.lower()}.pdf",
        conteudo=conteudo + categoria.encode(),
        mime_type="application/pdf",
        categoria=categoria,
        usuario=ator,
        processo_id=processo.id,
    )


def test_saida_da_triagem_exige_portaria_e_formulario(sessao, processo, ator):
    faltas = requisitos_de_saida(sessao, processo, "AGUARDANDO_INSPECAO")
    assert "anexe a portaria de localização" in faltas
    assert any("formulário assinado" in f for f in faltas)

    with pytest.raises(RequisitoDeSaidaNaoAtendido):
        mover(sessao, processo, "AGUARDANDO_INSPECAO", ator)

    _anexar(sessao, processo, "PORTARIA", ator)
    _anexar(sessao, processo, "FORMULARIO", ator)
    mover(sessao, processo, "AGUARDANDO_INSPECAO", ator)
    assert processo.estado_tecnico == "AGUARDANDO_INSPECAO"


def test_arquivar_da_triagem_nao_exige_documento(sessao, processo, ator):
    mover(sessao, processo, "ARQUIVADO", ator)
    assert processo.estado_tecnico == "ARQUIVADO"


def test_saida_da_quantificacao_exige_ensaio_ou_justificativa(sessao, processo, ator):
    processo.estado_tecnico = "AGUARDANDO_QUANTIFICACAO"
    sessao.flush()
    faltas = requisitos_de_saida(sessao, processo, "LAUDO_EM_ELABORACAO")
    assert any("relatório de ensaio" in f for f in faltas)

    processo.observacoes = "Avaliação qualitativa justificada conforme Anexo 13 da NR-15."
    sessao.flush()
    assert requisitos_de_saida(sessao, processo, "LAUDO_EM_ELABORACAO") == []
    mover(sessao, processo, "LAUDO_EM_ELABORACAO", ator)


def test_atalho_de_reuso_exige_laudo_vigente(sessao, processo, ator):
    # sair de EM_TRIAGEM sempre exige portaria + formulario, inclusive no atalho
    _anexar(sessao, processo, "PORTARIA", ator)
    _anexar(sessao, processo, "FORMULARIO", ator)

    with pytest.raises(RequisitoDeSaidaNaoAtendido) as erro:
        mover(sessao, processo, "PARECER_EM_ELABORACAO", ator)
    assert any("laudo VIGENTE" in m for m in erro.value.motivos)

    insalubridade = sessao.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
    ).scalar_one()
    laudo = LaudoTecnico(
        numero_siape="26255-000.125/2019",
        ano=2019,
        tipo_adicional_id=insalubridade.id,
        unidade_uorg_id=processo.unidade_uorg_id,
    )
    sessao.add(laudo)
    sessao.flush()

    mover(sessao, processo, "PARECER_EM_ELABORACAO", ator, laudo_reusado=laudo)
    assert processo.estado_tecnico == "PARECER_EM_ELABORACAO"

    from app.modelos import HistoricoEvento

    eventos = sessao.execute(
        select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "REUSO_DE_LAUDO")
    ).scalars().all()
    assert eventos


def test_indeferimento_exige_inciso_do_art11(sessao, processo, ator):
    with pytest.raises(RequisitoDeSaidaNaoAtendido) as erro:
        mover(sessao, processo, "INDEFERIDO_TECNICAMENTE", ator, forcar=True)
    assert "art. 11" in erro.value.motivos[0]

    mover(sessao, processo, "INDEFERIDO_TECNICAMENTE", ator, inciso_art11="II", forcar=True)
    assert processo.estado_tecnico == "INDEFERIDO_TECNICAMENTE"


def test_sobrestar_e_voltar(sessao, processo, ator):
    mover(sessao, processo, "SOBRESTADO", ator, forcar=True)
    assert processo.estado_tecnico == "SOBRESTADO"
    assert processo.estado_anterior == "EM_TRIAGEM"

    voltar_do_sobrestamento(sessao, processo, ator)
    assert processo.estado_tecnico == "EM_TRIAGEM"
    assert processo.estado_anterior is None


def test_voltar_sem_estar_sobrestado(sessao, processo, ator):
    with pytest.raises(TransicaoInvalida):
        voltar_do_sobrestamento(sessao, processo, ator)


def test_transicao_proibida(sessao, processo, ator):
    with pytest.raises(TransicaoInvalida):
        mover(sessao, processo, "CONCLUIDO", ator)


def test_mover_para_o_mesmo_estado_nao_faz_nada(sessao, processo, ator):
    versao = processo.versao
    mover(sessao, processo, "EM_TRIAGEM", ator)
    assert processo.versao == versao


def test_status_exige_permissao(sessao, processo):
    sem_permissao = UsuarioAtual(
        id=99,
        login="x",
        nome="Sem permissão",
        permissoes=frozenset({"processo.ver"}),
        perfis=("consulta_progep",),
    )
    with pytest.raises(PermissaoNegada):
        mover(sessao, processo, "ARQUIVADO", sem_permissao)


def test_conclusao_preenche_a_data(sessao, processo, ator):
    processo.estado_tecnico = "DEVOLVIDO_A_PROGEP"
    sessao.flush()
    mover(sessao, processo, "CONCLUIDO", ator)
    assert processo.situacao == "CONCLUIDO"
    assert processo.data_conclusao == date.today()


def test_sla_e_contador_de_dias(sessao, processo, ator):
    processo.entrou_na_etapa_em = agora_utc() - timedelta(days=SLA_PADRAO["A_FAZER"] + 3)
    sessao.flush()
    resumo = resumir(sessao, processo)
    assert resumo.coluna == "A_FAZER"
    assert resumo.dias_no_estado >= SLA_PADRAO["A_FAZER"]
    assert resumo.atrasado is True

    _anexar(sessao, processo, "PORTARIA", ator)
    _anexar(sessao, processo, "FORMULARIO", ator)
    mover(sessao, processo, "AGUARDANDO_INSPECAO", ator)
    # o contador reinicia a cada mudanca de coluna
    assert resumir(sessao, processo).dias_no_estado == 0


def test_resumo_conta_anexos_e_checklist(sessao, processo, ator):
    from app.modelos import Checklist, ChecklistItem

    _anexar(sessao, processo, "PORTARIA", ator)
    checklist = Checklist(processo_id=processo.id, nome="Instrução")
    sessao.add(checklist)
    sessao.flush()
    sessao.add_all(
        [
            ChecklistItem(checklist_id=checklist.id, descricao="a", concluido=True),
            ChecklistItem(checklist_id=checklist.id, descricao="b", concluido=False),
        ]
    )
    sessao.flush()
    resumo = resumir(sessao, processo)
    assert resumo.anexos == 1
    assert (resumo.checklist_feitos, resumo.checklist_total) == (1, 2)


def test_kanban_agrupa_por_coluna(sessao, processo, ator):
    colunas = repo.kanban(sessao, ator, repo.Filtro())
    assert processo in colunas["A_FAZER"]
    contagem = repo.contar_por_coluna(sessao, ator, repo.Filtro())
    assert contagem["A_FAZER"] == 1
    assert contagem["CONCLUIDO"] == 0


def test_busca_por_nup_e_laudo(sessao, processo, ator):
    itens, total = repo.listar(sessao, ator, repo.Filtro(q="021284"))
    assert total == 1 and itens[0].id == processo.id
    _, vazio = repo.listar(sessao, ator, repo.Filtro(q="nada disso"))
    assert vazio == 0


def test_indicadores(sessao, processo, ator):
    kpis = repo.indicadores(sessao, ator)
    assert kpis["total"] == 1
    assert kpis["a_fazer"] == 1


def test_unidades_com_processo(sessao, processo, ator):
    unidades = repo.unidades_com_processo(sessao, ator)
    assert any(u.codigo_uorg == "250" for u in unidades)


def test_por_nup_e_por_id(sessao, processo, ator):
    assert repo.por_id(sessao, ator, processo.id) is processo
    assert repo.por_nup(sessao, ator, processo.nup) is processo
    assert repo.por_id(sessao, ator, 999999) is None


def test_query_string_do_filtro():
    filtro = repo.Filtro(q="marco", estado="EM_TRIAGEM", atrasados=True)
    qs = filtro.como_query_string()
    assert "q=marco" in qs and "estado=EM_TRIAGEM" in qs and "atrasados=1" in qs
    assert "tipo=" not in qs
