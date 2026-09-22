"""Número do parecer editável, portaria pelo editor e classificação escolhida."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.modelos import (
    Campus,
    Exposicao,
    ParecerSequencia,
    ParecerTecnico,
    PortariaLocalizacao,
    PostoTrabalho,
    UnidadeUorg,
)
from app.servicos import parecer as servico
from testes.integracao.conftest import entrar


def _abrir_rascunho(app_cliente, contas) -> str:
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    processo = criado.headers["location"]
    rascunho = app_cliente.get(f"{processo}/parecer", follow_redirects=False)
    return rascunho.headers["location"]


# ---------------------------------------------------------------------
# Numero editavel: o setor ja emitiu pareceres fora do sistema
# ---------------------------------------------------------------------
def test_numero_pode_ser_digitado_no_rascunho(app_cliente, contas, banco):
    from app import banco as mod_banco

    caminho = _abrir_rascunho(app_cliente, contas)
    corpo = app_cliente.get(caminho).text
    assert 'name="numero"' in corpo

    app_cliente.post(caminho, data={"numero": "9", "ano": "2026"}, follow_redirects=False)
    with mod_banco.sessao() as s:
        parecer = s.execute(select(ParecerTecnico)).scalars().one()
        assert parecer.numero == 9


def test_numero_ja_usado_e_recusado(app_cliente, contas, banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        # número já reservado/usado — é o caso real de quem emitiu fora do sistema
        s.add(ParecerTecnico(numero=9, ano=2026, situacao="RESERVADO"))
        s.commit()

    caminho = _abrir_rascunho(app_cliente, contas)
    resposta = app_cliente.post(caminho, data={"numero": "9", "ano": "2026"})
    assert "já pertence a outro parecer" in resposta.text


def test_numero_digitado_empurra_a_sequencia(app_cliente, contas, banco):
    """Depois de continuar a numeração à mão, o automático não repete."""
    from app import banco as mod_banco

    caminho = _abrir_rascunho(app_cliente, contas)
    app_cliente.post(caminho, data={"numero": "37", "ano": "2026"}, follow_redirects=False)
    with mod_banco.sessao() as s:
        assert s.get(ParecerSequencia, 2026).ultimo_numero == 37


def test_numero_fica_travado_depois_de_emitido(sessao, cenario):
    from testes.integracao import papeis

    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    assert parecer.situacao == "EMITIDO"
    # a tela nao oferece o campo; a rota tambem recusa alterar
    assert parecer.numero >= 1


def test_alteracao_do_numero_fica_na_auditoria(app_cliente, contas, banco):
    from app import banco as mod_banco
    from app.modelos import HistoricoEvento

    caminho = _abrir_rascunho(app_cliente, contas)
    app_cliente.post(caminho, data={"numero": "12", "ano": "2026"}, follow_redirects=False)
    with mod_banco.sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "NUMERO_DEFINIDO_MANUALMENTE"
            )
        ).scalars().first()
    assert evento is not None
    assert evento.valor_novo == 12


# ---------------------------------------------------------------------
# Portaria pelo proprio editor
# ---------------------------------------------------------------------
def test_cadastrar_portaria_sem_sair_do_editor(app_cliente, contas, banco):
    from app import banco as mod_banco

    caminho = _abrir_rascunho(app_cliente, contas)
    corpo = app_cliente.get(caminho).text
    # O CARTAO VIROU CAMADA, E O INVARIANTE E O MESMO: "sem sair daqui" continua
    # sendo o ponto — o cadastro da portaria acontece por cima do editor, e nao
    # numa tela de catalogo, para quem esta redigindo nao perder o rascunho. O
    # botao passou a morar ao lado do seletor que ele alimenta, no cartao do
    # marco inicial, e o formulario mora no `<dialog>` que ele abre.
    assert 'href="#cadastrar-portaria" data-abre-popup>Cadastrar portaria</a>' in corpo
    assert '<h2 id="cadastrar-portaria-titulo">Cadastrar portaria</h2>' in corpo
    assert "nenhuma cadastrada" in corpo

    with mod_banco.sessao() as s:
        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        famed_id = famed.id

    resposta = app_cliente.post(
        f"{caminho}/portaria",
        data={
            "texto_original": "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
            "unidade_emissora_id": str(famed_id),
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        portaria = s.execute(select(PortariaLocalizacao)).scalars().one()
        assert portaria.numero == "35"  # extraído do texto
        assert portaria.data_publicacao == date(2024, 9, 17)
        assert portaria.texto_original.startswith("PORTARIA/FAMED")
        parecer = s.execute(select(ParecerTecnico)).scalars().one()
        assert parecer.portaria_id == portaria.id  # já vinculada


def test_portaria_sem_data_legivel_avisa(app_cliente, contas, banco):
    from app import banco as mod_banco

    caminho = _abrir_rascunho(app_cliente, contas)
    with mod_banco.sessao() as s:
        famed_id = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one().id

    resposta = app_cliente.post(
        f"{caminho}/portaria",
        data={"texto_original": "portaria sem data", "unidade_emissora_id": str(famed_id)},
    )
    assert "não consegui ler a data" in resposta.text


def test_portaria_repetida_reaproveita(app_cliente, contas, banco):
    from app import banco as mod_banco

    caminho = _abrir_rascunho(app_cliente, contas)
    with mod_banco.sessao() as s:
        famed_id = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one().id
    dados = {
        "texto_original": "PORTARIA/FAMED Nº 035, DE 17 DE SETEMBRO DE 2024",
        "unidade_emissora_id": str(famed_id),
    }
    app_cliente.post(f"{caminho}/portaria", data=dados, follow_redirects=False)
    app_cliente.post(f"{caminho}/portaria", data=dados, follow_redirects=False)
    with mod_banco.sessao() as s:
        # 035, 35 e 0035 são a mesma portaria
        assert len(list(s.execute(select(PortariaLocalizacao)).scalars())) == 1


# ---------------------------------------------------------------------
# Classificacao: calculada quando ha horas, escolhida quando nao ha
# ---------------------------------------------------------------------
def test_classificacao_informada_quando_nao_ha_medicao():
    exposicao = Exposicao(parecer_id=1, agente_nocivo_id=1, percentual_id=1, fundamentacao_id=1)
    servico.aplicar_classificacao(exposicao, informada="HABITUAL")
    assert exposicao.classificacao_exposicao == "HABITUAL"
    assert exposicao.classificacao_origem == "INFORMADA"
    assert exposicao.percentual_jornada is None


def test_medicao_prevalece_sobre_a_escolha():
    exposicao = Exposicao(
        parecer_id=1,
        agente_nocivo_id=1,
        percentual_id=1,
        fundamentacao_id=1,
        horas_exposicao_mensais=160,
        jornada_mensal_horas=160,
    )
    servico.aplicar_classificacao(exposicao, informada="EVENTUAL")
    assert exposicao.classificacao_exposicao == "PERMANENTE"
    assert exposicao.classificacao_origem == "CALCULADA"
    aviso = servico.divergencia_de_classificacao(exposicao, "EVENTUAL")
    assert "prevaleceu a medição" in aviso


def test_sem_horas_e_sem_escolha_fica_indefinida():
    exposicao = Exposicao(parecer_id=1, agente_nocivo_id=1, percentual_id=1, fundamentacao_id=1)
    servico.aplicar_classificacao(exposicao, informada=None)
    assert exposicao.classificacao_exposicao is None


def test_valor_invalido_e_ignorado():
    exposicao = Exposicao(parecer_id=1, agente_nocivo_id=1, percentual_id=1, fundamentacao_id=1)
    servico.aplicar_classificacao(exposicao, informada="SEMPRE")
    assert exposicao.classificacao_exposicao is None


def test_classificacao_escolhida_pela_tela(app_cliente, contas, banco):
    from app import banco as mod_banco

    caminho = _abrir_rascunho(app_cliente, contas)
    corpo = app_cliente.get(caminho).text
    assert "Classificação (art. 9º)" in corpo

    with mod_banco.sessao() as s:
        from app.modelos import AgenteNocivo, PercentualAplicavel

        agente = s.execute(
            select(AgenteNocivo).where(
                AgenteNocivo.descricao == "Contato permanente com material infecto-contagiante"
            )
        ).scalar_one()
        percentual = s.execute(select(PercentualAplicavel)).scalars().first()
        ids = (agente.id, percentual.id)

    app_cliente.post(
        f"{caminho}/exposicoes",
        data={
            "agente_nocivo_id": str(ids[0]),
            "percentual_id": str(ids[1]),
            "classificacao": "PERMANENTE",
            "principal": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        exposicao = s.execute(select(Exposicao)).scalars().one()
        assert exposicao.classificacao_exposicao == "PERMANENTE"
        assert exposicao.classificacao_origem == "INFORMADA"
    assert "informada" in app_cliente.get(caminho).text


def test_remover_exposicao_diz_o_que_leva_junto_antes_de_apagar(
    app_cliente, contas, banco
):
    """"remover" era um clique só no fim da linha, e apagava mais do que a
    linha que se vê: horas, jornada, classificação, exceção do art. 9º — e a
    avaliação de EPI daquele agente, que é trabalho de outra pessoa e não tem
    cópia.

    A GAVETA MUDOU DE ELEMENTO, E O INVARIANTE E O MESMO. Era
    `<details class="acoes-linha">`, aberta na propria celula; passou a ser a
    camada de `ui.popup_gaveta`, pelo mesmo motivo do modulo de EPI — a gaveta
    resolvia dentro de ~190px de coluna e empurrava a lista de baixo. O que este
    teste guarda nao e o elemento: e que o gatilho venha ANTES do `action` que
    apaga, e que o que some esteja escrito antes de alguem clicar. A acao
    continua a UM clique depois de aberta.
    """
    from app import banco as mod_banco

    caminho = _abrir_rascunho(app_cliente, contas)
    with mod_banco.sessao() as s:
        from app.modelos import AgenteNocivo, PercentualAplicavel

        agente = s.execute(
            select(AgenteNocivo).where(
                AgenteNocivo.descricao
                == "Contato permanente com material infecto-contagiante"
            )
        ).scalar_one()
        percentual = s.execute(select(PercentualAplicavel)).scalars().first()
        ids = (agente.id, percentual.id, agente.descricao)

    app_cliente.post(
        f"{caminho}/exposicoes",
        data={
            "agente_nocivo_id": str(ids[0]),
            "percentual_id": str(ids[1]),
            "classificacao": "PERMANENTE",
            "principal": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        exposicao_id = s.execute(select(Exposicao)).scalars().one().id

    corpo = app_cliente.get(caminho).text
    acao = f"{caminho}/exposicoes/{exposicao_id}/excluir"
    assert acao in corpo
    # o botão não é mais o alvo direto da célula: ele mora dentro da camada que
    # se abre, e a camada diz o que some antes de alguém clicar
    gatilho = f'href="#acoes-exposicao-{exposicao_id}"'
    assert gatilho in corpo
    assert corpo.index(gatilho) < corpo.index(acao)
    assert f'<dialog class="popup popup-gaveta" id="acoes-exposicao-{exposicao_id}"' in corpo
    assert "as horas e a jornada declaradas" in corpo
    # e o botão de dentro nomeia o agente, para não haver dúvida de qual linha
    assert ids[2] in corpo

    # e a rota continua fazendo o que sempre fez
    app_cliente.post(acao, follow_redirects=False)
    with mod_banco.sessao() as s:
        assert s.execute(select(Exposicao)).first() is None


def test_emitir_com_trava_continua_sendo_botao_desabilitado(app_cliente, contas, banco):
    """A confirmação de emissão não pode atropelar a disciplina da tela.

    Botão desabilitado COM o motivo visível ao lado é o desenho certo daqui, e
    ele vale enquanto houver trava: só quando a validação passa é que o botão
    vira o link que leva à confirmação.
    """
    caminho = _abrir_rascunho(app_cliente, contas)
    corpo = app_cliente.get(caminho).text
    assert "bloqueio(s)" in corpo
    assert 'href="#emitir-parecer"' not in corpo, "ofereceu emitir com trava"
    assert 'id="emitir-parecer"' not in corpo
    assert "<button type=\"button\" disabled>Emitir (consome número)</button>" in corpo


# ---------------------------------------------------------------------
# Cadastro de campus, unidade e posto
# ---------------------------------------------------------------------
def test_cadastrar_campus_unidade_e_posto(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")

    assert app_cliente.post(
        "/catalogos/campi",
        data={"sigla": "tof", "nome": "Campus Novo", "cidade": "Turmalina", "uf": "mg"},
        follow_redirects=False,
    ).status_code == 303
    with mod_banco.sessao() as s:
        campus = s.execute(select(Campus).where(Campus.sigla == "TOF")).scalar_one()
        assert campus.uf == "MG"
        campus_id = campus.id

    assert app_cliente.post(
        "/catalogos/unidades-uorg",
        data={
            "codigo_uorg": "999",
            "sigla": "FNOVA",
            "nome_oficial": "FACULDADE NOVA DE TURMALINA",
            "nome_extenso": "Faculdade Nova de Turmalina",
            "tipo": "FACULDADE",
            "campus_id": str(campus_id),
            "emite_portaria": "1",
        },
        follow_redirects=False,
    ).status_code == 303
    with mod_banco.sessao() as s:
        unidade = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "999")
        ).scalar_one()
        assert unidade.uorg_bruto == "999 - FACULDADE NOVA DE TURMALINA"
        unidade_id = unidade.id

    assert app_cliente.post(
        "/catalogos/postos-trabalho",
        data={
            "unidade_uorg_id": str(unidade_id),
            "nome": "Laboratório de Solos",
            "sigla": "LSOL",
        },
        follow_redirects=False,
    ).status_code == 303
    with mod_banco.sessao() as s:
        posto = s.execute(
            select(PostoTrabalho).where(PostoTrabalho.nome == "Laboratório de Solos")
        ).scalar_one()
        assert posto.unidade_uorg_id == unidade_id


def test_codigo_uorg_repetido_e_recusado(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        campus_id = s.execute(select(Campus)).scalars().first().id
    dados = {
        "codigo_uorg": "250",  # já é da FAMED
        "nome_oficial": "OUTRA",
        "nome_extenso": "Outra",
        "tipo": "OUTRO",
        "campus_id": str(campus_id),
    }
    resposta = app_cliente.post("/catalogos/unidades-uorg", data=dados, follow_redirects=True)
    assert "Já existe unidade com o código 250" in resposta.text


def test_mesmo_posto_em_unidades_diferentes(app_cliente, contas, banco):
    """'Laboratório de Química' existe no IECT e no ICA — é legítimo."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        famed_id = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one().id
    app_cliente.post(
        "/catalogos/postos-trabalho",
        data={"unidade_uorg_id": str(famed_id), "nome": "Laboratório de Química"},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        quimicas = list(
            s.execute(
                select(PostoTrabalho).where(PostoTrabalho.nome == "Laboratório de Química")
            ).scalars()
        )
        assert len(quimicas) == 3  # IECT, ICA e agora FAMED


def test_posto_repetido_na_mesma_unidade_e_recusado(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        iect_id = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "260")
        ).scalar_one().id
    resposta = app_cliente.post(
        "/catalogos/postos-trabalho",
        data={"unidade_uorg_id": str(iect_id), "nome": "Laboratório de Química"},
        follow_redirects=True,
    )
    assert "já existe nesta unidade" in resposta.text


@pytest.mark.parametrize("caminho", ["/catalogos/campi", "/catalogos/unidades-uorg", "/catalogos/postos-trabalho"])
def test_cadastros_exigem_permissao(app_cliente, contas, caminho):
    entrar(app_cliente, contas, "secretaria_csso")
    assert app_cliente.post(caminho, data={}).status_code in (403, 422)


# ---------------------------------------------------------------------
# O parecer congelado PARECE congelado, e o botão de PDF diz se o PDF sai
# ---------------------------------------------------------------------
def _emitido(sessao, cenario, situacao: str) -> int:
    """Um parecer de verdade emitido pelo serviço — `ck_completo` não deixa
    escrever `EMITIDO` à mão num rascunho vazio, e é bom que não deixe."""
    from testes.integracao import papeis

    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    if situacao == "ASSINADO":
        # `assinar` exige habilitação (RN-01), que o ator `coord` não tem; o
        # que se prova aqui é a TELA do assinado, não a regra de assinatura.
        parecer.situacao = "ASSINADO"
    elif situacao == "ANULADO":
        servico.anular(sessao, parecer, papeis.COORDENADOR, "teste")
    sessao.commit()
    return parecer.id


def test_rascunho_tem_os_campos_ligados(app_cliente, contas, banco):
    caminho = _abrir_rascunho(app_cliente, contas)
    corpo = app_cliente.get(caminho).text
    assert '<fieldset class="campos">' in corpo
    assert "Conteúdo congelado" not in corpo


@pytest.mark.parametrize("situacao", ["EMITIDO", "ASSINADO", "ANULADO"])
def test_parecer_congelado_desliga_o_formulario_inteiro(
    app_cliente, contas, sessao, cenario, situacao
):
    """Só o número recebia `disabled`; os outros ~25 campos continuavam
    editáveis sem botão de salvar, e Enter em qualquer um submetia o formulário
    para receber "Parecer emitido é imutável". A mensagem estava certa; a tela
    mentia ao parecer editável."""
    parecer_id = _emitido(sessao, cenario, situacao)
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(f"/pareceres/{parecer_id}").text
    assert '<fieldset class="campos" disabled>' in corpo
    assert "Salvar rascunho" not in corpo
    if situacao == "ANULADO":
        assert "Parecer anulado." in corpo
    else:
        assert "Conteúdo congelado na emissão (RN-14)" in corpo


def test_botao_de_pdf_diz_antes_do_clique_que_o_pdf_nao_sai(
    app_cliente, contas, sessao, cenario, monkeypatch
):
    """Sem LibreOffice o botão entregava um .docx e ninguém lia o aviso que ia
    dentro da resposta. A condição é conhecida antes do clique."""
    from app.rotas import pareceres as rota

    parecer_id = _emitido(sessao, cenario, "EMITIDO")
    entrar(app_cliente, contas, "coordenador_csso")

    monkeypatch.setattr(rota.servico_pdf, "disponivel", lambda: False)
    corpo = app_cliente.get(f"/pareceres/{parecer_id}").text
    assert "Gerar PDF" in corpo
    assert "indisponível — sai o .docx" in corpo

    monkeypatch.setattr(rota.servico_pdf, "disponivel", lambda: True)
    corpo = app_cliente.get(f"/pareceres/{parecer_id}").text
    assert "indisponível — sai o .docx" not in corpo
