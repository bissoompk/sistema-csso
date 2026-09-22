"""O quadro: filtros em gaveta, quadro vazio que fala, e mover sem arrastar.

Três coisas que a auditoria de interação mediu no `/kanban` e que a tela de
`/processos` já tinha resolvido para si:

* o cartão de filtros aberto custava metade da altura útil a 1366×641, e o
  quadro rola dentro de si — cada pixel acima dele é um cartão a menos visível;
* o quadro vazio eram cinco colunas em branco sem uma palavra, na tela que se
  abre primeiro (a coluna vazia já se explicava pela folha; o QUADRO não);
* mover um cartão só existia pelo arrasto do HTML5, que não existe no toque
  nem no teclado — quem estava num tablet ou navegando por Tab saía do quadro
  e movia pela ficha.

O menu "mover para…" é um `<form method="post">` de verdade: sem JavaScript
ele submete e a rota devolve o quadro inteiro; com JavaScript o script do
quadro intercepta e o cartão percorre o MESMO caminho do arrasto. A rota
distingue os dois pelo pedido, e o contrato do `fetch` (fragmento, 200/422)
continua o que era — é o que os testes de `test_web_fluxo.py` provam.
"""

from __future__ import annotations

from testes.integracao.conftest import entrar

# o navegador submetendo um <form> pede HTML; o fetch do quadro aceita */*
FORMULARIO = {"accept": "text/html,application/xhtml+xml"}


def _processo_novo(app_cliente, nup="23086.021284/2024-56") -> int:
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": nup, "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    assert criado.status_code == 303, criado.text
    return int(criado.headers["location"].rsplit("/", 1)[-1].split("?")[0])


def _em_triagem(app_cliente, processo_id: int) -> None:
    """RECEBIDO só sai para EM_TRIAGEM; e da triagem, ARQUIVADO é a única saída
    que não exige portaria nem formulário anexados. O que se prova nestes
    testes é a volta ao quadro, não a máquina de estados."""
    resposta = app_cliente.post(
        f"/kanban/mover/{processo_id}",
        data={"coluna": "A_FAZER", "estado": "EM_TRIAGEM"},
        headers={"x-requested-with": "fetch"},
    )
    assert resposta.status_code == 200, resposta.text


# ---------------------------------------------------------------------
# Os filtros em gaveta
# ---------------------------------------------------------------------
def test_filtros_do_quadro_nascem_fechados(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/kanban").text
    assert '<details class="cartao filtros">' in corpo
    assert "cinco controles" in corpo


def test_filtros_do_quadro_abrem_e_dizem_o_que_esta_aplicado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/kanban?q=021284&atrasados=1").text
    assert '<details class="cartao filtros" open>' in corpo
    assert "2 aplicado(s)" in corpo
    assert "busca “021284”" in corpo
    assert "só acima do SLA" in corpo


# ---------------------------------------------------------------------
# O quadro vazio fala
# ---------------------------------------------------------------------
def test_quadro_vazio_no_primeiro_uso_diz_por_onde_comecar(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/kanban").text
    assert "Nenhum processo no fluxo ainda." in corpo
    assert "Novo processo" in corpo
    assert 'href="/importar"' in corpo
    # e as cinco colunas em branco não ficam embaixo repetindo a informação
    assert '<div class="rolagem-quadro" hidden>' in corpo


def test_quadro_vazio_por_filtro_diz_onde_o_filtro_olhou(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    _processo_novo(app_cliente)
    corpo = app_cliente.get("/kanban?q=nada-disso-existe").text
    assert "Nenhum processo neste recorte." in corpo
    assert "O filtro olha NUP" in corpo
    assert "Nenhum processo no fluxo ainda." not in corpo


def test_quadro_com_cartao_nao_mostra_o_vazio(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    _processo_novo(app_cliente)
    corpo = app_cliente.get("/kanban").text
    assert "quadro-vazio" not in corpo
    assert '<div class="rolagem-quadro">' in corpo


# ---------------------------------------------------------------------
# Mover sem arrastar
# ---------------------------------------------------------------------
def test_o_cartao_tem_o_menu_de_mover_sem_a_coluna_em_que_esta(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    processo_id = _processo_novo(app_cliente)
    corpo = app_cliente.get("/kanban").text
    inicio = corpo.index(f'id="cartao-{processo_id}"')
    cartao = corpo[inicio : corpo.index("</article>", inicio)]
    assert f'action="/kanban/mover/{processo_id}" data-mover' in cartao
    # o processo novo nasce em A_FAZER (RECEBIDO): essa coluna não é destino
    assert 'value="A_FAZER"' not in cartao
    for destino in ("NAO_INICIADO", "EM_ANDAMENTO", "AGUARDANDO", "CONCLUIDO"):
        assert f'name="coluna" value="{destino}"' in cartao, destino
    assert "mover para…" in cartao


def test_quem_nao_move_processo_nao_ganha_o_menu(app_cliente, contas):
    """Menu que oferece porta trancada é a mesma mentira do item de menu."""
    entrar(app_cliente, contas, "coordenador_csso")
    _processo_novo(app_cliente)
    app_cliente.get("/sair")
    entrar(app_cliente, contas, "consulta_progep")
    corpo = app_cliente.get("/kanban").text
    # `data-mover` aparece no script do quadro (o seletor do tratador); o que
    # não pode aparecer é o FORMULÁRIO com o atributo
    if "cartao-kanban" in corpo:
        assert " data-mover>" not in corpo


def test_formulario_comum_move_e_volta_ao_quadro_com_a_mensagem(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    processo_id = _processo_novo(app_cliente)
    _em_triagem(app_cliente, processo_id)
    resposta = app_cliente.post(
        f"/kanban/mover/{processo_id}",
        data={"coluna": "CONCLUIDO", "estado": "ARQUIVADO"},
        headers=FORMULARIO,
        follow_redirects=False,
    )
    assert resposta.status_code == 303, resposta.text
    assert resposta.headers["location"].startswith("/kanban?mensagem=")
    quadro = app_cliente.get(resposta.headers["location"]).text
    assert "movido para “Concluído”" in quadro


def test_formulario_comum_recusado_volta_ao_quadro_com_o_motivo(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    processo_id = _processo_novo(app_cliente)
    resposta = app_cliente.post(
        f"/kanban/mover/{processo_id}",
        data={"coluna": "CONCLUIDO"},
        headers=FORMULARIO,
        follow_redirects=False,
    )
    assert resposta.status_code == 303, resposta.text
    assert resposta.headers["location"].startswith("/kanban?erro=")
    quadro = app_cliente.get(resposta.headers["location"]).text
    assert 'class="aviso aviso-erro"' in quadro


def test_o_fetch_do_quadro_continua_recebendo_o_fragmento(app_cliente, contas):
    """O contrato do arrasto não mudou: cartão em 200, recusa em 422."""
    entrar(app_cliente, contas, "coordenador_csso")
    processo_id = _processo_novo(app_cliente)
    fetch = {"x-requested-with": "fetch", "accept": "*/*"}
    _em_triagem(app_cliente, processo_id)
    recusa = app_cliente.post(
        f"/kanban/mover/{processo_id}", data={"coluna": "CONCLUIDO"}, headers=fetch
    )
    assert recusa.status_code == 422 and "recusa-de-movimento" in recusa.text
    ok = app_cliente.post(
        f"/kanban/mover/{processo_id}",
        data={"coluna": "CONCLUIDO", "estado": "ARQUIVADO"},
        headers=fetch,
    )
    assert ok.status_code == 200 and 'class="cartao-kanban"' in ok.text, ok.text
    # o cartão que volta já traz o menu SEM a coluna nova
    assert 'value="CONCLUIDO"' not in ok.text and 'value="A_FAZER"' in ok.text


def test_o_script_do_quadro_tem_um_caminho_so_para_os_dois_gestos(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/kanban").text
    assert "function mover(cartao, coluna)" in corpo
    assert "mover(arrastando, coluna)" in corpo, "o arrasto tem de passar por mover()"
    assert "form[data-mover]" in corpo, "o menu tem de passar por mover()"
    assert "'X-Requested-With': 'fetch'" in corpo
