"""Histórico datado de lotação e cargo do servidor."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.modelos import Cargo, PostoTrabalho, Servidor, ServidorLotacao, UnidadeUorg
from app.servicos import servidores as servico
from app.servicos.rbac import PermissaoNegada
from testes.integracao import papeis
from testes.integracao.conftest import entrar


@pytest.fixture()
def coord(atores):
    return papeis.COORDENADOR


def _postos_da_famed(sessao, famed_id) -> list[PostoTrabalho]:
    return list(
        sessao.execute(
            select(PostoTrabalho)
            .where(PostoTrabalho.unidade_uorg_id == famed_id)
            .order_by(PostoTrabalho.nome)
        ).scalars()
    )


@pytest.fixture()
def marco(sessao, coord):
    famed = sessao.execute(
        select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
    ).scalar_one()
    cargo = sessao.execute(
        select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
    ).scalar_one()
    leac = sessao.execute(
        select(PostoTrabalho).where(
            PostoTrabalho.unidade_uorg_id == famed.id,
            PostoTrabalho.nome == "Laboratório Escola de análises Clínicas (LEAC)",
        )
    ).scalar_one()
    servidor = Servidor(
        siape="1110654",
        nome="Marco Antônio Alves Schetino",
        cargo_id=cargo.id,
        unidade_uorg_id=famed.id,
    )
    sessao.add(servidor)
    sessao.flush()
    servico.registrar_lotacao_inicial(
        sessao,
        servidor,
        coord,
        inicio=date(2019, 3, 1),
        documento="Posse",
        postos=[leac.id],
    )
    return servidor


def _outra_unidade(sessao):
    return sessao.execute(
        select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "261")
    ).scalar_one()


def test_lotacao_inicial_abre_o_primeiro_periodo(sessao, marco):
    linha = servico.historico(sessao, marco.id)
    assert len(linha) == 1
    assert linha[0].vigencia_inicio == date(2019, 3, 1)
    assert linha[0].aberta is True


def test_lotacao_inicial_e_idempotente(sessao, marco, coord):
    servico.registrar_lotacao_inicial(sessao, marco, coord)
    assert len(servico.historico(sessao, marco.id)) == 1


def test_mudanca_fecha_o_anterior_na_vespera(sessao, marco, coord):
    ica = _outra_unidade(sessao)
    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=ica.id,
        cargo_id=marco.cargo_id,
        funcao=None,
        a_partir_de=date(2024, 5, 10),
        documento="PORTARIA/ICA Nº 12, DE 09 DE MAIO DE 2024",
    )
    linha = servico.historico(sessao, marco.id)
    assert len(linha) == 2
    assert linha[0].vigencia_fim == date(2024, 5, 9)  # véspera
    assert linha[1].vigencia_inicio == date(2024, 5, 10)
    assert linha[1].aberta
    assert servico.inconsistencias(sessao, marco.id) == []


def test_o_cadastro_passa_a_refletir_o_periodo_atual(sessao, marco, coord):
    ica = _outra_unidade(sessao)
    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=ica.id,
        cargo_id=None,
        funcao="Chefia do laboratório",
        a_partir_de=date.today(),
    )
    assert marco.unidade_uorg_id == ica.id
    assert marco.funcao == "Chefia do laboratório"


def test_mudanca_futura_nao_altera_o_cadastro_ainda(sessao, marco, coord):
    ica = _outra_unidade(sessao)
    antes = marco.unidade_uorg_id
    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=ica.id,
        cargo_id=None,
        funcao=None,
        a_partir_de=date.today() + timedelta(days=30),
    )
    assert marco.unidade_uorg_id == antes  # só muda quando a data chegar
    assert len(servico.historico(sessao, marco.id)) == 2


def test_onde_o_servidor_estava_naquela_data(sessao, marco, coord):
    """É disto que a aposentadoria especial vai precisar."""
    famed = marco.unidade_uorg_id
    ica = _outra_unidade(sessao).id
    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=ica,
        cargo_id=None,
        funcao=None,
        a_partir_de=date(2024, 5, 10),
    )
    assert servico.lotacao_em(sessao, marco.id, date(2020, 1, 1)).unidade_uorg_id == famed
    assert servico.lotacao_em(sessao, marco.id, date(2024, 5, 9)).unidade_uorg_id == famed
    assert servico.lotacao_em(sessao, marco.id, date(2024, 5, 10)).unidade_uorg_id == ica
    assert servico.lotacao_em(sessao, marco.id, date(2018, 1, 1)) is None


def test_data_anterior_ao_periodo_atual_e_recusada(sessao, marco, coord):
    with pytest.raises(servico.LotacaoInvalida, match="depois do início"):
        servico.alterar_lotacao(
            sessao,
            marco,
            coord,
            unidade_uorg_id=_outra_unidade(sessao).id,
            cargo_id=None,
            funcao=None,
            a_partir_de=date(2018, 1, 1),
        )


def test_mudanca_sem_mudanca_e_recusada(sessao, marco, coord):
    atuais = [p.id for p in servico.postos_atuais(sessao, marco.id)]
    with pytest.raises(servico.LotacaoInvalida, match="nada mudou"):
        servico.alterar_lotacao(
            sessao,
            marco,
            coord,
            unidade_uorg_id=marco.unidade_uorg_id,
            uorg_id=marco.uorg_id,
            postos=atuais,
            cargo_id=marco.cargo_id,
            funcao=marco.funcao,
            a_partir_de=date.today(),
        )


def test_posto_de_outra_unidade_e_recusado(sessao, marco, coord):
    ica = _outra_unidade(sessao)
    leac = servico.postos_atuais(sessao, marco.id)[0].id
    with pytest.raises(servico.LotacaoInvalida, match="pertence a outra unidade"):
        servico.alterar_lotacao(
            sessao,
            marco,
            coord,
            unidade_uorg_id=ica.id,
            postos=[leac],
            cargo_id=None,
            funcao=None,
            a_partir_de=date.today(),
        )


def test_alteracao_fica_na_auditoria(sessao, marco, coord):
    from app.modelos import HistoricoEvento

    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=_outra_unidade(sessao).id,
        cargo_id=None,
        funcao=None,
        a_partir_de=date(2024, 5, 10),
        documento="PORTARIA/ICA Nº 12",
    )
    eventos = sessao.execute(
        select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "LOTACAO_ALTERADA")
    ).scalars().all()
    assert eventos
    assert "unidade" in eventos[0].descricao
    assert "PORTARIA/ICA Nº 12" in eventos[0].descricao


def test_sem_permissao_nao_altera(sessao, marco):
    from app.servicos.rbac import UsuarioAtual

    leitor = UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset({"processo.ver"}), perfis=()
    )
    with pytest.raises(PermissaoNegada):
        servico.alterar_lotacao(
            sessao,
            marco,
            leitor,
            unidade_uorg_id=None,
            cargo_id=None,
            funcao="x",
            a_partir_de=date.today(),
        )


def test_cadastro_sem_historico_ganha_periodo_de_origem(sessao, coord):
    """Servidor migrado, sem linha do tempo: a primeira alteração abre as duas."""
    servidor = Servidor(siape="1473142", nome="Gabriela Silva")
    sessao.add(servidor)
    sessao.flush()
    assert servico.historico(sessao, servidor.id) == []

    servico.alterar_lotacao(
        sessao,
        servidor,
        coord,
        unidade_uorg_id=_outra_unidade(sessao).id,
        cargo_id=None,
        funcao=None,
        a_partir_de=date.today(),
    )
    assert len(servico.historico(sessao, servidor.id)) == 2
    assert servico.inconsistencias(sessao, servidor.id) == []


def test_inconsistencia_detecta_lacuna(sessao, marco):
    linha = servico.historico(sessao, marco.id)
    linha[0].vigencia_fim = date(2024, 1, 1)
    sessao.add(
        ServidorLotacao(
            servidor_id=marco.id,
            unidade_uorg_id=marco.unidade_uorg_id,
            vigencia_inicio=date(2024, 3, 1),
        )
    )
    sessao.flush()
    assert any("lacuna" in p for p in servico.inconsistencias(sessao, marco.id))


def test_servidor_atende_mais_de_um_posto(sessao, marco, coord):
    """Foi o caso do parecer 1/2025: LEAC e Laboratório de Doenças Infecciosas."""
    postos = _postos_da_famed(sessao, marco.unidade_uorg_id)
    assert len(postos) >= 2
    escolhidos = [p.id for p in postos[:2]]
    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=marco.unidade_uorg_id,
        postos=escolhidos,
        cargo_id=marco.cargo_id,
        funcao=None,
        a_partir_de=date(2024, 5, 10),
    )
    assert [p.id for p in servico.postos_atuais(sessao, marco.id)] == escolhidos
    # o período anterior guarda o posto de então — é o que prova a exposição passada
    anterior = servico.lotacao_em(sessao, marco.id, date(2020, 1, 1))
    assert [p.nome for p in anterior.postos] == [
        "Laboratório Escola de análises Clínicas (LEAC)"
    ]


def test_a_ordem_dos_postos_e_preservada(sessao, marco, coord):
    postos = _postos_da_famed(sessao, marco.unidade_uorg_id)
    invertidos = [p.id for p in reversed(postos[:2])]
    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=marco.unidade_uorg_id,
        postos=invertidos,
        cargo_id=marco.cargo_id,
        funcao=None,
        a_partir_de=date(2024, 5, 10),
    )
    assert [p.id for p in servico.postos_atuais(sessao, marco.id)] == invertidos


def test_uorg_e_campo_proprio_e_pode_divergir_da_unidade(sessao, marco, coord):
    """A Unidade é o lugar; a UORG é o código de lotação no SIAPE."""
    ica = _outra_unidade(sessao)
    servico.alterar_lotacao(
        sessao,
        marco,
        coord,
        unidade_uorg_id=marco.unidade_uorg_id,
        uorg_id=ica.id,
        cargo_id=marco.cargo_id,
        funcao=None,
        a_partir_de=date(2024, 5, 10),
    )
    vigente = servico.lotacao_vigente(sessao, marco.id)
    assert vigente.unidade_uorg_id == marco.unidade_uorg_id
    assert vigente.uorg_id == ica.id
    assert marco.uorg_id == ica.id


def test_correcao_no_mesmo_dia_nao_cria_periodo_de_duracao_zero(sessao, coord):
    """Cadastrar e ajustar em seguida é o caso comum — não vira histórico."""
    servidor = Servidor(siape="1473142", nome="Gabriela Silva")
    sessao.add(servidor)
    sessao.flush()
    servico.registrar_lotacao_inicial(sessao, servidor, coord)

    ica = _outra_unidade(sessao)
    servico.alterar_lotacao(
        sessao,
        servidor,
        coord,
        unidade_uorg_id=ica.id,
        cargo_id=None,
        funcao=None,
        a_partir_de=date.today(),
    )
    linha = servico.historico(sessao, servidor.id)
    assert len(linha) == 1
    assert linha[0].unidade_uorg_id == ica.id


def test_corrigir_so_mexe_em_documento_e_observacao(sessao, marco, coord):
    lotacao = servico.historico(sessao, marco.id)[0]
    inicio = lotacao.vigencia_inicio
    servico.corrigir_lotacao(
        sessao, lotacao, coord, documento="Termo de posse nº 3", observacao="conferido"
    )
    assert lotacao.documento == "Termo de posse nº 3"
    assert lotacao.vigencia_inicio == inicio


# ---------------------------------------------------------------------
def test_tela_do_servidor_mostra_e_altera(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/servidores",
        data={"siape": "1110654", "nome": "Marco Antônio Alves Schetino"},
        follow_redirects=False,
    )
    caminho = criado.headers["location"]
    corpo = app_cliente.get(caminho).text
    assert "Lotação e cargo" in corpo
    assert "Registrar mudança" in corpo

    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        unidade = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        unidade_id = unidade.id

    resposta = app_cliente.post(
        f"{caminho}/lotacao",
        data={
            "a_partir_de": date.today().isoformat(),
            "unidade_uorg_id": str(unidade_id),
            "funcao": "Chefia",
            "documento": "PORTARIA/FAMED Nº 35",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    depois = app_cliente.get(caminho).text
    assert "PORTARIA/FAMED Nº 35" in depois
    assert "atual" in depois


def test_cadastro_ja_aceita_postos_e_uorg(app_cliente, contas, banco):
    """O que o usuário pediu: escolher os postos já na tela de cadastro."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        ica = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "261")
        ).scalar_one()
        famed_id, ica_id = famed.id, ica.id
        postos = [p.id for p in _postos_da_famed(s, famed_id)[:2]]
    assert len(postos) == 2

    criado = app_cliente.post(
        "/servidores",
        data={
            "siape": "1110654",
            "nome": "Marco Antônio Alves Schetino",
            "unidade_uorg_id": str(famed_id),
            "uorg_id": str(ica_id),
            "posto_id": [str(p) for p in postos],
        },
        follow_redirects=False,
    )
    caminho = criado.headers["location"]
    with mod_banco.sessao() as s:
        servidor = s.execute(
            select(Servidor).where(Servidor.siape == "1110654")
        ).scalar_one()
        assert servidor.uorg_id == ica_id
        assert [p.id for p in servico.postos_atuais(s, servidor.id)] == postos

    # e o cadastro é editável depois — era o outro pedido
    resposta = app_cliente.post(
        caminho,
        data={
            "nome": "Marco Antonio Alves Schetino",
            "siape": "1110654",
            "email": "marco@ufvjm.edu.br",
            "situacao": "APOSENTADO",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        servidor = s.execute(
            select(Servidor).where(Servidor.siape == "1110654")
        ).scalar_one()
        assert servidor.situacao == "APOSENTADO"
        assert servidor.email == "marco@ufvjm.edu.br"


def test_siape_de_outro_servidor_e_recusado_na_edicao(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post("/servidores", data={"siape": "1110654", "nome": "Marco"})
    segundo = app_cliente.post(
        "/servidores", data={"siape": "1473142", "nome": "Gabriela"},
        follow_redirects=False,
    )
    resposta = app_cliente.post(
        segundo.headers["location"],
        data={"nome": "Gabriela", "siape": "1110654", "email": "", "situacao": "ATIVO"},
    )
    assert "já é de" in resposta.text
    with mod_banco.sessao() as s:
        assert s.execute(
            select(Servidor).where(Servidor.siape == "1473142")
        ).scalar_one_or_none() is not None


def test_siape_ja_cadastrado_diz_por_que_caiu_na_ficha_do_outro(app_cliente, contas):
    """Redirecionava em silêncio para a ficha do existente, e a pessoa concluía
    que tinha cadastrado — inclusive os campos que acabara de digitar e que não
    foram gravados em lugar nenhum."""
    entrar(app_cliente, contas, "coordenador_csso")
    primeiro = app_cliente.post(
        "/servidores", data={"siape": "1110654", "nome": "Marco"}, follow_redirects=False
    )
    repetido = app_cliente.post(
        "/servidores", data={"siape": "1110654", "nome": "Outro Nome"}, follow_redirects=False
    )
    assert repetido.status_code == 303
    assert repetido.headers["location"].startswith(primeiro.headers["location"] + "?")
    tela = app_cliente.get(repetido.headers["location"])
    assert "já estava cadastrado" in tela.text
    assert "Nada foi criado" in tela.text
