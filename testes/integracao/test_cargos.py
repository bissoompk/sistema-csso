"""Cadastro e edição de cargos."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.modelos import Cargo, HistoricoEvento, ParecerTecnico, Servidor
from testes.integracao.conftest import entrar


def test_catalogo_de_cargos_esta_listado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    indice = app_cliente.get("/catalogos").text
    assert "/catalogos/cargos" in indice

    lista = app_cliente.get("/catalogos/cargos")
    assert lista.status_code == 200
    assert "TECNICO DE LABORATORIO AREA" in lista.text  # veio dos seeds


def test_cadastrar_cargo(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/catalogos/cargos",
        data={"nome": "ENGENHEIRO AREA", "codigo_siape": "701001"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        cargo = s.execute(select(Cargo).where(Cargo.nome == "ENGENHEIRO AREA")).scalar_one()
        assert cargo.codigo_siape == "701001"


def test_cargo_repetido_e_recusado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    dados = {"nome": "ENGENHEIRO AREA", "codigo_siape": ""}
    app_cliente.post("/catalogos/cargos", data=dados, follow_redirects=False)
    resposta = app_cliente.post("/catalogos/cargos", data=dados, follow_redirects=True)
    assert "já está cadastrado" in resposta.text


def test_nome_em_branco_e_recusado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/catalogos/cargos", data={"nome": "   "}, follow_redirects=True
    )
    assert "não pode ficar em branco" in resposta.text


def test_editar_cargo(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        cargo_id = s.execute(
            select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
        ).scalar_one().id

    app_cliente.post(
        "/catalogos/cargos",
        data={
            "cargo_id": str(cargo_id),
            "nome": "TÉCNICO DE LABORATÓRIO/ÁREA",
            "codigo_siape": "701200",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        cargo = s.get(Cargo, cargo_id)
        assert cargo.nome == "TÉCNICO DE LABORATÓRIO/ÁREA"
        assert cargo.codigo_siape == "701200"
        evento = s.execute(
            select(HistoricoEvento).where(HistoricoEvento.campo == "nome")
        ).scalars().first()
        assert evento is not None
        assert evento.valor_anterior == "TECNICO DE LABORATORIO AREA"


def test_renomear_para_nome_de_outro_e_recusado(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/catalogos/cargos", data={"nome": "ENGENHEIRO AREA"}, follow_redirects=False
    )
    with mod_banco.sessao() as s:
        outro = s.execute(
            select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
        ).scalar_one()
        outro_id = outro.id

    resposta = app_cliente.post(
        "/catalogos/cargos",
        data={"cargo_id": str(outro_id), "nome": "ENGENHEIRO AREA"},
        follow_redirects=True,
    )
    assert "Já existe outro cargo" in resposta.text


def test_lista_mostra_quantos_servidores_usam(app_cliente, contas, banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        cargo = s.execute(
            select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
        ).scalar_one()
        s.add(Servidor(siape="1110654", nome="Marco Antônio", cargo_id=cargo.id))
        s.add(Servidor(siape="1473142", nome="Gabriela Silva", cargo_id=cargo.id))
        s.commit()

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/catalogos/cargos").text
    assert "Servidores" in corpo


def test_renomear_nao_afeta_parecer_ja_emitido(sessao, cenario):
    """RN-15: o parecer congela o cargo na emissão."""
    from testes.integracao import papeis
    from app.servicos import parecer as servico

    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    congelado = parecer.cargo_snapshot
    assert congelado == "TECNICO DE LABORATORIO AREA"

    cargo = sessao.execute(
        select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
    ).scalar_one()
    cargo.nome = "NOME NOVO DO CARGO"
    sessao.flush()

    contexto = servico.montar_contexto(sessao, parecer)
    assert contexto.cargo == congelado  # a reimpressão traz o cargo daquele dia


def test_cadastro_de_cargo_exige_permissao(app_cliente, contas):
    entrar(app_cliente, contas, "secretaria_csso")
    assert app_cliente.post("/catalogos/cargos", data={"nome": "X"}).status_code == 403


def test_tela_sem_cargo_aponta_o_caminho(app_cliente, contas, banco):
    """Seletor vazio sem dizer o que fazer é beco sem saída."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        for cargo in s.execute(select(Cargo)).scalars():
            s.delete(cargo)
        s.commit()

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/servidores").text
    assert "cadastre um cargo" in corpo


_ = (date, ParecerTecnico)
