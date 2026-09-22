"""`/api/v1` e `/celular` — o contrato da fase 2, provado pelo lado de fora.

O que se prova aqui não é regra de negócio (ela mora nos serviços e tem os
próprios testes): é que a API chama a MESMA regra, com a mesma sessão, a mesma
RN-19 e a mesma trilha — e que responde JSON em todo caminho, inclusive nos
que a tela responderia com 303 ou com HTML.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.modelos import EpiFichaRegistro, EpiItem
from testes.integracao.conftest import entrar

FETCH = {"x-requested-with": "fetch"}


def _servidor(app_cliente, siape="1110654", nome="Marco Antônio") -> int:
    criado = app_cliente.post(
        "/servidores", data={"siape": siape, "nome": nome}, follow_redirects=False
    )
    assert criado.status_code == 303, criado.text
    return int(criado.headers["location"].rsplit("/", 1)[-1].split("?")[0])


# ---------------------------------------------------------------------
# Sessão, permissão e forma — sempre em JSON
# ---------------------------------------------------------------------
def test_sem_sessao_a_api_responde_401_em_json_e_nao_303(app_cliente, contas):
    resposta = app_cliente.get("/api/v1/eu", follow_redirects=False)
    assert resposta.status_code == 401
    assert resposta.json()["erro"].startswith("Sessão ausente")


def test_o_indice_e_a_identidade(app_cliente, contas):
    entrar(app_cliente, contas, "almoxarife_sesmt")
    indice = app_cliente.get("/api/v1").json()
    assert "GET  /api/v1/eu" in indice["rotas"]
    eu = app_cliente.get("/api/v1/eu").json()
    assert eu["login"] == "almoxarife_sesmt"
    assert "epi.entregar" in eu["permissoes"]
    assert "processo.ver" not in eu["permissoes"]
    assert eu["versao"]


def test_sem_permissao_a_api_responde_403_em_json(app_cliente, contas):
    entrar(app_cliente, contas, "consulta_progep")
    resposta = app_cliente.get("/api/v1/epis/itens")
    assert resposta.status_code == 403
    assert "epi.entregar" in resposta.json()["motivos"][0]


def test_todo_post_exige_o_cabecalho_de_fetch(app_cliente, contas):
    """A guarda de CSRF de quem usa cookie: um <form> de outro site posta com o
    cookie da pessoa, mas não escreve este cabeçalho."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post("/api/v1/epis/entregas", json={"servidor_id": 1, "item_id": 1, "quantidade": 1})
    assert resposta.status_code == 403
    assert "X-Requested-With" in resposta.json()["erro"]


def test_corpo_sem_forma_volta_no_formato_de_erro_da_api(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post("/api/v1/epis/entregas", json={"quantidade": "x"}, headers=FETCH)
    assert resposta.status_code == 422
    corpo = resposta.json()
    assert corpo["erro"] == "O envio não tem a forma esperada."
    assert any("servidor_id" in m for m in corpo["motivos"])


# ---------------------------------------------------------------------
# O balcão
# ---------------------------------------------------------------------
def test_a_busca_de_quem_recebe_aplica_a_rn19_por_linha(app_cliente, contas, monkeypatch):
    """A API passa pela MESMA função da tela (`identificacao.pode_ver_nominal`):
    quando ela diz não, o nome não acha e o rótulo sai opaco; o SIAPE acha
    sempre. Provado trocando a função, porque nenhum perfil semeado tem
    `epi.entregar` sem poder ler nome — o almoxarife lê pela `epi.ficha`."""
    from app.servicos import identificacao

    entrar(app_cliente, contas, "coordenador_csso")
    _servidor(app_cliente)
    nominal = app_cliente.get("/api/v1/epis/servidores", params={"q": "Marco"}).json()
    assert nominal and nominal[0]["nominal"] is True
    assert nominal[0]["rotulo"] == "Marco Antônio · SIAPE 1110654"

    monkeypatch.setattr(identificacao, "pode_ver_nominal", lambda usuario, servidor_id: False)
    por_nome = app_cliente.get("/api/v1/epis/servidores", params={"q": "Marco"}).json()
    assert por_nome == [], "o nome não pode achar para quem não pode lê-lo"
    por_siape = app_cliente.get("/api/v1/epis/servidores", params={"q": "1110654"}).json()
    assert por_siape and por_siape[0]["nominal"] is False
    assert "Marco" not in por_siape[0]["rotulo"]
    assert "1110654" not in por_siape[0]["rotulo"]


def _item(app_cliente, banco) -> int:
    """Um item de catálogo sem exigência de CA — o seed não traz item nenhum."""
    from app import banco as mod_banco
    from app.modelos import EpiCategoria

    with mod_banco.sessao() as s:
        item = s.execute(select(EpiItem).where(EpiItem.ativo.is_(True))).scalars().first()
        if item is None:
            categoria = s.execute(select(EpiCategoria)).scalars().first()
            item = EpiItem(
                nome="Bota de segurança", categoria_id=categoria.id, exige_ca=False,
                quantidade_padrao=1,
            )
            s.add(item)
            s.commit()
        return item.id


def test_itens_e_lotes(app_cliente, contas, banco):
    _item(app_cliente, banco)
    entrar(app_cliente, contas, "almoxarife_sesmt")
    itens = app_cliente.get("/api/v1/epis/itens").json()
    assert itens and {"id", "nome", "quantidade_padrao", "tamanhos", "exige_ca"} <= set(itens[0])
    lotes = app_cliente.get(f"/api/v1/epis/itens/{itens[0]['id']}/lotes")
    assert lotes.status_code == 200 and isinstance(lotes.json(), list)
    assert app_cliente.get("/api/v1/epis/itens/999999/lotes").status_code == 404


def test_registrar_entrega_pela_api_grava_a_mesma_ficha(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    servidor_id = _servidor(app_cliente)
    item_id = _item(app_cliente, banco)
    resposta = app_cliente.post(
        "/api/v1/epis/entregas",
        json={"servidor_id": servidor_id, "item_id": item_id, "quantidade": 1,
              "data_evento": date.today().isoformat()},
        headers=FETCH,
    )
    if resposta.status_code == 422:
        # sem lote com CA valido o servico recusa (RN-25): a recusa vem inteira
        corpo = resposta.json()
        assert corpo["erro"] == "A entrega foi recusada." and corpo["motivos"]
        return
    assert resposta.status_code == 201, resposta.text
    corpo = resposta.json()
    assert corpo["ficha"] == f"/epis/fichas/{servidor_id}"
    assert corpo["comprovante"].startswith("/epis/fichas/registros/")
    with mod_banco.sessao() as s:
        registro = s.get(EpiFichaRegistro, corpo["registro_id"])
        assert registro is not None and registro.servidor_id == servidor_id

    ficha = app_cliente.get(f"/api/v1/epis/fichas/{servidor_id}").json()
    assert ficha["nominal"] is True
    assert ficha["linhas"][0]["registro_id"] == corpo["registro_id"]


def test_entrega_com_data_futura_e_recusada_como_na_tela(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    servidor_id = _servidor(app_cliente)
    item_id = _item(app_cliente, banco)
    resposta = app_cliente.post(
        "/api/v1/epis/entregas",
        json={"servidor_id": servidor_id, "item_id": item_id, "quantidade": 1,
              "data_evento": "2099-01-01"},
        headers=FETCH,
    )
    assert resposta.status_code == 422
    assert resposta.json()["erro"] == "A entrega não pode ter data futura."


def test_a_ficha_de_outro_exige_a_permissao(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    servidor_id = _servidor(app_cliente)
    app_cliente.get("/sair")
    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get(f"/api/v1/epis/fichas/{servidor_id}")
    assert resposta.status_code == 403


# ---------------------------------------------------------------------
# A chamada
# ---------------------------------------------------------------------
def test_turmas_exige_avaliar_e_filtra_por_situacao(app_cliente, contas):
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert app_cliente.get("/api/v1/turmas").status_code == 403
    app_cliente.get("/sair")
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/api/v1/turmas").json() == []
    ruim = app_cliente.get("/api/v1/turmas", params={"situacao": "NADA"})
    assert ruim.status_code == 422 and "EM_ANDAMENTO" in ruim.json()["motivos"]


def test_grade_de_turma_inexistente_e_404_em_json(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/api/v1/turmas/999/presencas")
    assert resposta.status_code == 404
    assert "escopo" in resposta.json()["erro"]


# ---------------------------------------------------------------------
# A tela de bolso e o que a sustenta
# ---------------------------------------------------------------------
def test_a_tela_de_bolso_abre_e_declara_o_que_a_pessoa_pode(app_cliente, contas):
    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = app_cliente.get("/celular").text
    assert 'data-pode-entregar="1"' in corpo
    assert 'data-pode-chamada=""' in corpo
    assert 'id="tela-balcao"' in corpo and 'id="tela-chamada"' not in corpo
    assert '<link rel="manifest" href="/estaticos/manifest.webmanifest">' in corpo
    assert '<script src="/estaticos/js/celular.js" defer></script>' in corpo


def test_a_tela_de_bolso_diz_por_que_esta_vazia_para_quem_nao_tem_trabalho_nela(app_cliente, contas):
    entrar(app_cliente, contas, "consulta_progep")
    corpo = app_cliente.get("/celular").text
    assert "ainda não tem trabalho para você" in corpo


def test_a_tela_de_bolso_exige_sessao(app_cliente, contas):
    resposta = app_cliente.get("/celular", follow_redirects=False)
    assert resposta.status_code == 303 and "/login" in resposta.headers["location"]


def test_o_service_worker_o_manifesto_e_a_folha_sao_servidos(app_cliente, contas):
    sw = app_cliente.get("/sw.js")
    assert sw.status_code == 200 and "javascript" in sw.headers["content-type"]
    assert sw.headers["cache-control"] == "no-cache"
    assert "/api/" in sw.text and "CASCA" in sw.text
    manifesto = app_cliente.get("/estaticos/manifest.webmanifest")
    assert manifesto.status_code == 200 and manifesto.json()["start_url"] == "/celular"
    assert app_cliente.get("/estaticos/css/celular.css").status_code == 200
    assert app_cliente.get("/estaticos/img/icone.svg").status_code == 200


def test_o_service_worker_nunca_guarda_resposta_da_api():
    """Dado pessoal não fica em cache de celular. O worker só intercepta a
    casca, e a lista de casca não tem `/api/`."""
    from app.config import RAIZ

    texto = (RAIZ / "app" / "estaticos" / "js" / "sw.js").read_text(encoding="utf-8")
    casca = texto[texto.index("var CASCA = [") : texto.index("];", texto.index("var CASCA = ["))]
    assert "/api/" not in casca
    assert "CASCA.indexOf(url.pathname) === -1" in texto


# ---------------------------------------------------------------------
# A chamada, com uma turma de verdade — a fixture é a de `test_presenca.py`
# ---------------------------------------------------------------------
from testes.integracao.test_presenca import INICIO, turma_rodando  # noqa: E402,F401


def test_a_chamada_pela_api_lanca_pelo_mesmo_servico(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id = turma_rodando["turma_id"]
    inscricao_id = turma_rodando["inscricao_id"]

    turmas = cliente.get("/api/v1/turmas").json()
    assert [t["id"] for t in turmas] == [turma_id]
    assert turmas[0]["dias"] == [INICIO.isoformat()]
    assert turmas[0]["inscritos"] == 1

    grade = cliente.get(f"/api/v1/turmas/{turma_id}/presencas").json()
    assert grade["retificando"] is False
    linha = grade["linhas"][0]
    assert linha["inscricao_id"] == inscricao_id
    assert linha["nominal"] is True and linha["participante"] == "Marco Antônio"
    assert linha["por_dia"] == {} and linha["frequencia"] == "0"

    lancado = cliente.post(
        f"/api/v1/turmas/{turma_id}/presencas",
        json={"inscricao_id": inscricao_id, "data": INICIO.isoformat(), "presente": True},
        headers=FETCH,
    )
    assert lancado.status_code == 200, lancado.text
    linha = lancado.json()["linhas"][0]
    assert linha["por_dia"][INICIO.isoformat()]["presente"] is True
    assert linha["frequencia"] == "100"


def test_a_chamada_pela_api_devolve_a_recusa_do_servico(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id = turma_rodando["turma_id"]
    fora = (INICIO.replace(year=INICIO.year - 1)).isoformat()
    recusa = cliente.post(
        f"/api/v1/turmas/{turma_id}/presencas",
        json={"inscricao_id": turma_rodando["inscricao_id"], "data": fora, "presente": True},
        headers=FETCH,
    )
    assert recusa.status_code == 422
    assert recusa.json()["erro"] == "O lançamento foi recusado."
    assert "não é dia de" in recusa.json()["motivos"][0]
    inexistente = cliente.post(
        f"/api/v1/turmas/{turma_id}/presencas",
        json={"inscricao_id": 999, "data": INICIO.isoformat()},
        headers=FETCH,
    )
    assert inexistente.status_code == 422
    assert "Inscrição não encontrada" in inexistente.json()["erro"]
