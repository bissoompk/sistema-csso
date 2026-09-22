"""Edição dos catálogos — e a garantia de que ela não reescreve o passado."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.modelos import (
    AgenteNocivo,
    Campus,
    ChecklistModelo,
    FundamentacaoLegal,
    HistoricoEvento,
    PercentualAplicavel,
    PortariaLocalizacao,
    PostoTrabalho,
    TipoRisco,
    UnidadeUorg,
)
from app.servicos import documento, parecer as servico
from app.servicos.textos import normalizar_fluxo
from testes.integracao import papeis
from testes.integracao.conftest import entrar


# ---------------------------------------------------------------------
# O congelamento: editar catálogo NÃO muda parecer já emitido (RN-15)
# ---------------------------------------------------------------------
def test_parecer_emitido_reimprime_do_congelado(sessao, cenario, tmp_path):
    parecer = cenario["parecer"]
    resultado = servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    antes = normalizar_fluxo(documento.extrair_texto(resultado.docx))
    assert parecer.contexto_congelado is not None

    # agora o catálogo inteiro muda embaixo do parecer
    agente = sessao.execute(
        select(AgenteNocivo).where(
            AgenteNocivo.descricao == "Contato permanente com material infecto-contagiante"
        )
    ).scalar_one()
    agente.descricao = "OUTRA COISA COMPLETAMENTE DIFERENTE"
    fundamentacao = sessao.execute(
        select(FundamentacaoLegal).where(FundamentacaoLegal.codigo == "NR15_AX14_INFECTO")
    ).scalar_one()
    fundamentacao.texto = "texto trocado"
    unidade = sessao.execute(
        select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
    ).scalar_one()
    unidade.nome_extenso = "Faculdade Renomeada"
    unidade.nome_oficial = "FACULDADE RENOMEADA"
    risco = sessao.execute(select(TipoRisco).where(TipoRisco.codigo == "BIOLOGICO")).scalar_one()
    risco.nome = "Risco Trocado"
    sessao.flush()
    sessao.expire_all()

    # reimprime: tem de sair idêntico
    parecer = sessao.get(type(parecer), parecer.id)
    novo = tmp_path / "reimpresso.docx"
    documento.renderizar(
        servico.montar_contexto(sessao, parecer), novo, parecer.modelo_arquivo
    )
    depois = normalizar_fluxo(documento.extrair_texto(novo))
    assert depois == antes
    assert "OUTRA COISA" not in depois
    assert "Faculdade Renomeada" not in depois


def test_rascunho_continua_seguindo_o_catalogo(sessao, cenario):
    """Antes de emitir, mudar o catálogo TEM de refletir — é rascunho."""
    parecer = cenario["parecer"]
    assert parecer.contexto_congelado is None
    unidade = sessao.execute(
        select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
    ).scalar_one()
    unidade.nome_extenso = "Faculdade Renomeada"
    sessao.flush()
    sessao.expire_all()
    parecer = sessao.get(type(parecer), parecer.id)
    assert servico.montar_contexto(sessao, parecer).unidade == "Faculdade Renomeada"


def test_congelado_ida_e_volta(sessao, cenario):
    contexto = servico.montar_contexto(sessao, cenario["parecer"])
    igual = documento.ContextoParecer.descongelar(contexto.congelar())
    assert igual.como_dicionario().keys() == contexto.como_dicionario().keys()
    assert igual.nome_servidor == contexto.nome_servidor
    assert igual.postos == contexto.postos
    assert igual.data_emissao == contexto.data_emissao


# ---------------------------------------------------------------------
# As telas de edição
# ---------------------------------------------------------------------
def _id(s, modelo, **filtros):
    return s.execute(select(modelo).filter_by(**filtros)).scalar_one().id


def test_editar_campus(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        campus_id = _id(s, Campus, sigla="DIA")
    resposta = app_cliente.post(
        f"/catalogos/campi/{campus_id}",
        data={"nome": "Campus Juscelino Kubitschek", "cidade": "Diamantina", "uf": "mg"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        campus = s.get(Campus, campus_id)
        assert campus.nome == "Campus Juscelino Kubitschek"
        assert campus.uf == "MG"
        assert campus.avancado is False  # checkbox ausente = desmarcado


def test_editar_unidade(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        unidade_id = _id(s, UnidadeUorg, codigo_uorg="250")
        campus_id = _id(s, Campus, sigla="DIA")
    app_cliente.post(
        f"/catalogos/unidades-uorg/{unidade_id}",
        data={
            "codigo_uorg": "250",
            "sigla": "FAMED",
            "nome_oficial": "FACULDADE DE MEDICINA DE DIAMANTINA",
            "nome_extenso": "Faculdade de Medicina",
            "tipo": "FACULDADE",
            "campus_id": str(campus_id),
            "emite_portaria": "1",
            "ativo": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.get(UnidadeUorg, unidade_id).nome_extenso == "Faculdade de Medicina"


def test_codigo_uorg_de_outra_unidade_e_recusado(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        alvo = _id(s, UnidadeUorg, codigo_uorg="261")
        campus_id = _id(s, Campus, sigla="DIA")
    resposta = app_cliente.post(
        f"/catalogos/unidades-uorg/{alvo}",
        data={
            "codigo_uorg": "250",  # já é da FAMED
            "nome_oficial": "X",
            "nome_extenso": "X",
            "tipo": "INSTITUTO",
            "campus_id": str(campus_id),
        },
        follow_redirects=True,
    )
    assert "já é de outra unidade" in resposta.text


def test_editar_posto(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        famed = _id(s, UnidadeUorg, codigo_uorg="250")
        posto_id = _id(
            s, PostoTrabalho, unidade_uorg_id=famed,
            nome="Laboratório Escola de análises Clínicas (LEAC)",
        )
    app_cliente.post(
        f"/catalogos/postos-trabalho/{posto_id}",
        data={
            "nome": "Laboratório Escola de Análises Clínicas (LEAC)",
            "unidade_uorg_id": str(famed),
            "sigla": "LEAC",
            "ativo": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.get(PostoTrabalho, posto_id).nome.endswith("Análises Clínicas (LEAC)")


def test_posto_duplicado_na_edicao_e_recusado(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        famed = _id(s, UnidadeUorg, codigo_uorg="250")
        alvo = _id(
            s, PostoTrabalho, unidade_uorg_id=famed,
            nome="Laboratório de Doenças Infecciosas e Parasitárias",
        )
    resposta = app_cliente.post(
        f"/catalogos/postos-trabalho/{alvo}",
        data={
            "nome": "Laboratório Escola de análises Clínicas (LEAC)",
            "unidade_uorg_id": str(famed),
        },
        follow_redirects=True,
    )
    assert "Já existe esse posto" in resposta.text


def test_editar_tipo_de_risco(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        risco_id = _id(s, TipoRisco, codigo="BIOLOGICO")
    app_cliente.post(
        f"/catalogos/tipos-risco/{risco_id}",
        data={"nome": "Agente Biológico (NR-15, Anexo 14)"},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.get(TipoRisco, risco_id).nome.startswith("Agente Biológico (")


def test_editar_fundamentacao_normaliza_aspas(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        fund_id = _id(s, FundamentacaoLegal, codigo="NR15_AX14_INFECTO")
    app_cliente.post(
        f"/catalogos/fundamentacoes-legais/{fund_id}",
        data={
            "norma": "NR-15",
            "anexo": "Anexo 14",
            "texto": '"Trabalhos em contato permanente"\nAnexo 14 da NR 15.',
            "vigente": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        fundamentacao = s.get(FundamentacaoLegal, fund_id)
        assert "“Trabalhos em contato permanente”" in fundamentacao.texto
        assert fundamentacao.dispositivo_conferido_em == date.today()


def test_percentual_so_edita_o_rotulo(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        percentual = s.execute(
            select(PercentualAplicavel).where(PercentualAplicavel.rotulo == "Médio (10%)")
        ).scalars().first()
        pid, valor = percentual.id, percentual.valor

    app_cliente.post(
        f"/catalogos/percentuais/{pid}",
        data={"rotulo": "Médio (10 %)", "valor": "35"},  # valor é ignorado
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        atual = s.get(PercentualAplicavel, pid)
        assert atual.rotulo == "Médio (10 %)"
        assert atual.valor == valor  # a lei não se edita pela tela
        assert atual.base_calculo == "vencimento do cargo efetivo"


def test_editar_agente_nocivo(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        agente_id = _id(s, AgenteNocivo, descricao="Manipulação de produtos químicos")
        risco_id = _id(s, TipoRisco, codigo="QUIMICO")
    app_cliente.post(
        f"/catalogos/agentes-nocivos/{agente_id}",
        data={
            "descricao": "Manipulação de produtos químicos diversos",
            "tipo_risco_id": str(risco_id),
            "exige_quantitativa": "1",
            "ativo": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        agente = s.get(AgenteNocivo, agente_id)
        assert agente.descricao.endswith("diversos")
        assert agente.exige_reavaliacao_quantitativa is True


def test_editar_portaria(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        famed = _id(s, UnidadeUorg, codigo_uorg="250")
        s.add(
            PortariaLocalizacao(
                unidade_emissora_id=famed,
                numero="35",
                ano=2024,
                data_publicacao=date(2024, 9, 17),
                texto_original="PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
            )
        )
        s.commit()
        portaria_id = s.execute(select(PortariaLocalizacao)).scalars().one().id

    app_cliente.post(
        f"/catalogos/portarias/{portaria_id}",
        data={
            "texto_original": "PORTARIA/FAMED Nº 35, DE 18 DE SETEMBRO DE 2024",
            "numero": "035",
            "data_publicacao": "2024-09-18",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        portaria = s.get(PortariaLocalizacao, portaria_id)
        assert portaria.data_publicacao == date(2024, 9, 18)
        assert portaria.numero == "35"  # zeros à esquerda continuam sumindo
        assert portaria.ano == 2024


def test_editar_checklist_modelo(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/catalogos/checklists-modelo",
        data={"nome": "Instrução", "itens": "a\nb"},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        modelo_id = s.execute(select(ChecklistModelo)).scalars().one().id
    app_cliente.post(
        f"/catalogos/checklists-modelo/{modelo_id}",
        data={"nome": "Instrução do adicional", "itens": "a\nb\nc", "ativo": "1"},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        modelo = s.get(ChecklistModelo, modelo_id)
        assert modelo.nome == "Instrução do adicional"
        assert len(modelo.lista_de_itens) == 3


def test_toda_edicao_deixa_diff_na_auditoria(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        risco_id = _id(s, TipoRisco, codigo="BIOLOGICO")
    app_cliente.post(
        f"/catalogos/tipos-risco/{risco_id}", data={"nome": "Novo nome"}, follow_redirects=False
    )
    with mod_banco.sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(HistoricoEvento.entidade == "tipo_risco")
        ).scalars().first()
    assert evento is not None
    assert evento.valor_anterior == "Agente Biológico"
    assert evento.valor_novo == "Novo nome"


@pytest.mark.parametrize(
    "caminho",
    [
        "/catalogos/campi/1",
        "/catalogos/unidades-uorg/1",
        "/catalogos/postos-trabalho/1",
        "/catalogos/tipos-risco/1",
        "/catalogos/fundamentacoes-legais/1",
        "/catalogos/percentuais/1",
        "/catalogos/agentes-nocivos/1",
        "/catalogos/portarias/1",
        "/catalogos/checklists-modelo/1",
    ],
)
def test_edicoes_exigem_permissao(app_cliente, contas, caminho):
    entrar(app_cliente, contas, "secretaria_csso")
    assert app_cliente.post(caminho, data={}).status_code in (403, 422)


@pytest.mark.parametrize(
    "catalogo",
    [
        "campi", "unidades-uorg", "postos-trabalho", "cargos", "agentes-nocivos",
        "tipos-risco", "fundamentacoes-legais", "percentuais", "textos-padrao",
        "portarias", "checklists-modelo",
    ],
)
def test_todo_catalogo_oferece_edicao(app_cliente, contas, catalogo):
    """Nenhuma tela de catálogo fica só de leitura para quem gerencia."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(f"/catalogos/{catalogo}").text
    assert corpo.count("</form>") >= 1, catalogo
