"""Fluxo feliz das telas + CA-10 (403 duro na assinatura) + CA-12 (autenticacao)."""

from __future__ import annotations

from sqlalchemy import select

from testes.integracao.conftest import entrar

PAGINAS = [
    "/",
    "/kanban",
    "/processos",
    "/laudos",
    "/servidores",
    "/relatorios",
    "/catalogos",
    "/catalogos/unidades-uorg",
    "/catalogos/agentes-nocivos",
    "/catalogos/textos-padrao",
    "/config",
    "/perfis",
]


def test_saude_sem_autenticacao(app_cliente):
    """Prova de vida, e só. Versão, ambiente e avisos ficaram do outro lado da
    porta (§S-2): o campo `avisos` existe para publicar falha de configuração, e
    a versão exata é o que se usa para escolher a vulnerabilidade certa."""
    resposta = app_cliente.get("/saude")
    assert resposta.status_code == 200
    assert resposta.json() == {"status": "ok"}


def test_saude_detalhe_exige_login(app_cliente, contas):
    assert app_cliente.get("/saude/detalhe", follow_redirects=False).status_code == 303
    entrar(app_cliente, contas, "coordenador_csso")
    dados = app_cliente.get("/saude/detalhe").json()
    assert dados["ambiente"] == "teste"
    assert dados["versao"]


def test_saude_db(app_cliente, contas):
    """`integrity_check` lê o banco inteiro: sem login era negação de serviço de
    graça (§S-1). O `admin_ti` é quem opera a máquina, e continua entrando."""
    assert app_cliente.get("/saude/db", follow_redirects=False).status_code == 303

    entrar(app_cliente, contas, "secretaria_csso")
    assert app_cliente.get("/saude/db").status_code == 403

    entrar(app_cliente, contas, "admin_ti")
    dados = app_cliente.get("/saude/db").json()
    assert dados["integrity_check"] == "ok"


def test_sem_sessao_redireciona_para_login(app_cliente):
    resposta = app_cliente.get("/kanban", follow_redirects=False)
    assert resposta.status_code == 303
    assert "/login" in resposta.headers["location"]


def test_paginas_do_coordenador(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    for caminho in PAGINAS:
        resposta = app_cliente.get(caminho)
        assert resposta.status_code == 200, f"{caminho}: {resposta.status_code}"
        assert "Sistema de apoio da CSSO" in resposta.text


def test_rodape_institucional_em_toda_tela(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/processos")
    assert "O processo oficial e o SEI." in resposta.text


def test_importar_e_auditoria_exigem_permissao(app_cliente, contas):
    entrar(app_cliente, contas, "secretaria_csso")
    assert app_cliente.get("/importar").status_code == 403
    assert app_cliente.get("/auditoria").status_code == 403


def test_auditor_ve_auditoria(app_cliente, contas):
    entrar(app_cliente, contas, "auditor_interno")
    assert app_cliente.get("/auditoria").status_code == 200


# ---------------------------------------------------------------------
# A tela de erro tambem e tela: sem a lateral o usuario fica sem caminho de
# volta e so sai pelo botao do navegador.
# ---------------------------------------------------------------------
CASCA = '<aside class="lateral">'


def test_403_sai_com_a_casca(app_cliente, contas):
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get("/auditoria")
    assert resposta.status_code == 403
    assert CASCA in resposta.text
    assert "/kanban" in resposta.text or 'href="/"' in resposta.text


def test_404_sai_com_a_casca(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/nao-existe", headers={"accept": "text/html"})
    assert resposta.status_code == 404
    assert CASCA in resposta.text


def test_erro_sem_sessao_nao_derruba_a_aplicacao(app_cliente, banco):
    """Erro antes de logar e o caso legitimo de tela sem casca — e ele nao pode
    virar 500 dentro do tratador."""
    resposta = app_cliente.get("/nao-existe", headers={"accept": "text/html"})
    assert resposta.status_code == 404
    assert CASCA not in resposta.text


def test_ca12_bloqueio_apos_tentativas(app_cliente, contas):
    for _ in range(5):
        resposta = app_cliente.post(
            "/login", data={"login": "coordenador_csso", "senha": "errada"}
        )
        assert "inválidos" in resposta.text
    resposta = app_cliente.post(
        "/login", data={"login": "coordenador_csso", "senha": "errada"}
    )
    assert "bloqueada" in resposta.text.lower()


# =====================================================================
# Troca parcial não falha em silêncio
#
# O quadro rola dentro de si e tem cinco colunas longas: soltar um cartão no pé
# de uma delas escrevia a recusa numa caixa fixa no topo da página, fora da
# tela. A conclusão de quem operava era "o sistema travou". E o `fetch` não
# tinha `.catch`: rede caída rejeitava a promessa e NADA aparecia.
# =====================================================================
def _processo_novo(app_cliente) -> int:
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    assert criado.status_code == 303, criado.text
    return int(criado.headers["location"].rsplit("/", 1)[-1].split("?")[0])


def test_recusa_do_arrasto_sai_anunciada_e_com_o_motivo_inteiro(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    processo_id = _processo_novo(app_cliente)
    resposta = app_cliente.post(
        f"/kanban/mover/{processo_id}", data={"coluna": "CONCLUIDO"}
    )
    assert resposta.status_code == 422, resposta.text
    assert 'role="alert"' in resposta.text, "a recusa entra na tela sem ser anunciada"
    assert "recusa-de-movimento" in resposta.text
    # o `id` sumiu porque a caixa não é mais única nem fixa: ela nasce dentro da
    # coluna onde o cartão foi solto, e duas delas na página teriam o mesmo id
    assert 'id="erro-movimento"' not in resposta.text


def test_o_quadro_nao_guarda_mais_a_caixa_de_erro_no_topo(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/kanban").text
    assert '<div id="erro-movimento"></div>' not in corpo
    assert ".catch(" in corpo, "fetch sem .catch: rede caída não dizia nada"
    assert "scrollIntoView" in corpo
    assert "function recontar" in corpo, "os contadores de coluna não se atualizam"


def test_toda_tela_carrega_o_retorno_das_trocas_parciais(app_cliente, contas):
    """Os três estados de uma troca de HTMX, uma vez só e para todas as telas.

    É global de propósito: `hx-indicator` em cada um dos quatro usos obrigaria
    quem escrever o quinto a lembrar — e a omissão é o que se está consertando.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/epis/entregas/nova").text
    assert "htmx:beforeRequest" in corpo
    assert "htmx:responseError" in corpo
    assert "htmx:sendError" in corpo
    assert "data-carregando" in corpo
    assert "recem-trocado" in corpo


def test_ca12_nenhuma_senha_em_claro_no_banco(banco, contas):
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        for usuario in s.execute(select(Usuario)).scalars():
            assert "SenhaDeTeste2026" not in usuario.senha_hash
            assert usuario.senha_hash.startswith("$argon2id$")


def test_ca12_sessao_revogada_rejeita_imediatamente(app_cliente, contas):
    from app import banco as mod_banco
    from app.modelos import Usuario
    from app.servicos import autenticacao

    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/kanban").status_code == 200
    with mod_banco.sessao() as s:
        usuario = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        autenticacao.revogar_do_usuario(s, usuario.id)
        s.commit()
    resposta = app_cliente.get("/kanban", follow_redirects=False)
    assert resposta.status_code == 303
    assert "/login" in resposta.headers["location"]


def test_primeiro_acesso_bloqueado_com_usuario_existente(app_cliente, contas):
    resposta = app_cliente.get("/primeiro-acesso", follow_redirects=False)
    assert resposta.status_code == 303
    assert "/login" in resposta.headers["location"]


def test_bootstrap_cria_superintendente(app_cliente, banco):
    """Sem nenhum usuario, /login manda para /primeiro-acesso; nao existe admin/admin."""
    resposta = app_cliente.get("/login", follow_redirects=False)
    assert resposta.status_code == 303
    assert "/primeiro-acesso" in resposta.headers["location"]

    app_cliente.post(
        "/primeiro-acesso",
        data={
            "nome": "Chefe da Sisa",
            "login": "sisa",
            "email": "sisa@ufvjm.edu.br",
            "senha": "PrimeiroAcesso2026",
        },
        follow_redirects=False,
    )
    from app import banco as mod_banco
    from app.modelos import Atribuicao, HistoricoEvento, Usuario

    with mod_banco.sessao() as s:
        usuario = s.execute(select(Usuario).where(Usuario.login == "sisa")).scalar_one()
        assert usuario.precisa_trocar_senha
        atribuicao = s.execute(
            select(Atribuicao).where(Atribuicao.usuario_id == usuario.id)
        ).scalar_one()
        assert atribuicao.ato_normativo == "BOOTSTRAP — substituir pelo ato real"
        eventos = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "BOOTSTRAP_SUPERINTENDENTE"
            )
        ).scalars().all()
        assert len(eventos) == 1


def test_senha_fraca_recusada(app_cliente, banco):
    resposta = app_cliente.post(
        "/primeiro-acesso",
        data={"nome": "X", "login": "x", "email": "x@y.z", "senha": "123"},
    )
    assert "Senha fraca" in resposta.text


def test_senha_de_seis_caracteres_e_aceita(app_cliente, banco):
    resposta = app_cliente.post(
        "/primeiro-acesso",
        data={"nome": "Chefe", "login": "chefe", "email": "c@ufvjm.edu.br", "senha": "csso26"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    entrada = app_cliente.post(
        "/login", data={"login": "chefe", "senha": "csso26"}, follow_redirects=False
    )
    assert entrada.status_code == 303
