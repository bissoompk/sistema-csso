"""`/app` (o front compilado) e `/api/v1/pendencias` — a fase 3 pelo lado de fora.

O bundle é gerado pelo Vite a partir de `frontend/` e fica em
`app/estaticos/app/`. O que se prova aqui é o contrato do servidor com ele:
a página exige sessão, os assets que ela cita existem e são servidos, nada
nela é script embutido (a CSP não tem `unsafe-inline`), e sem o bundle a rota
diz que ele não foi montado em vez de fingir.
"""

from __future__ import annotations

import re

import pytest
from sqlalchemy import select

from app.config import RAIZ
from app.rotas import aplicativo
from testes.integracao.conftest import entrar

BUNDLE = RAIZ / "app" / "estaticos" / "app" / "index.html"


def test_o_app_exige_sessao(app_cliente, contas):
    resposta = app_cliente.get("/app", follow_redirects=False)
    assert resposta.status_code == 303
    assert "/login?proximo=%2Fapp" in resposta.headers["location"]


@pytest.mark.skipif(not BUNDLE.is_file(), reason="o bundle do front não foi montado nesta máquina (cd frontend && npm run build)")
def test_o_app_serve_a_pagina_e_os_assets_que_ela_cita(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    pagina = app_cliente.get("/app")
    assert pagina.status_code == 200
    assert pagina.headers["cache-control"] == "no-cache"
    assert '<div id="raiz"></div>' in pagina.text
    # o endereco colado sem a ancora tambem abre a pagina
    assert app_cliente.get("/app/balcao").status_code == 200

    scripts = re.findall(r'<script[^>]*src="([^"]+)"', pagina.text)
    folhas = re.findall(r'<link rel="stylesheet"[^>]*href="([^"]+)"', pagina.text)
    assert scripts and all(s.startswith("/estaticos/app/assets/") for s in scripts)
    for caminho in scripts + folhas:
        assert app_cliente.get(caminho).status_code == 200, caminho


@pytest.mark.skipif(not BUNDLE.is_file(), reason="o bundle do front não foi montado nesta máquina")
def test_a_pagina_do_app_nao_tem_script_embutido(app_cliente, contas):
    """A CSP e `script-src 'self' 'nonce-…'`: um script embutido sem nonce no
    HTML do Vite simplesmente nao rodaria, e o app abriria em branco."""
    entrar(app_cliente, contas, "coordenador_csso")
    pagina = app_cliente.get("/app").text
    for achado in re.finditer(r"<script(?P<attrs>[^>]*)>(?P<corpo>.*?)</script>", pagina, re.S):
        assert "src=" in achado.group("attrs"), "script embutido no index do Vite"
        assert not achado.group("corpo").strip()


def test_sem_o_bundle_a_rota_diz_como_monta_lo(app_cliente, contas, monkeypatch):
    entrar(app_cliente, contas, "coordenador_csso")
    monkeypatch.setattr(aplicativo, "ENTRADA", RAIZ / "nao-existe" / "index.html")
    resposta = app_cliente.get("/app")
    assert resposta.status_code == 503
    assert "npm run build" in resposta.text
    assert "/celular" in resposta.text and "/inicio" in resposta.text


# ---------------------------------------------------------------------
# A fila de pendências em JSON
# ---------------------------------------------------------------------
def test_pendencias_exige_operar_algum_modulo(app_cliente, contas, monkeypatch):
    """A porta e a de `/pendencias` (`pendencias.pode_ver`): todo perfil semeado
    opera algum modulo, entao a recusa se prova fechando a porta."""
    from app.servicos import pendencias

    entrar(app_cliente, contas, "servidor_consulta")
    assert app_cliente.get("/api/v1/pendencias").status_code == 200
    monkeypatch.setattr(pendencias, "pode_ver", lambda usuario: False)
    resposta = app_cliente.get("/api/v1/pendencias")
    assert resposta.status_code == 403
    assert "permissão exigida" in resposta.json()["motivos"][0]


def test_pendencias_lista_com_rotulo_prazo_e_ancora(app_cliente, contas, banco):
    from app import banco as mod_banco
    from app.modelos import Usuario
    from app.servicos import pendencias
    from app.servicos.rbac import UsuarioAtual

    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    processo_id = int(criado.headers["location"].rsplit("/", 1)[-1].split("?")[0])
    with mod_banco.sessao() as s:
        usuario = s.execute(select(Usuario).where(Usuario.login == "coordenador_csso")).scalar_one()
        atual = UsuarioAtual(
            id=usuario.id, login=usuario.login, nome=usuario.nome,
            permissoes=frozenset({"processo.ver"}), perfis=("coordenador_csso",),
        )
        pendencias.abrir(
            s=s, tipo="INCLUIR_NO_SEI", chave="app:1", descricao="incluir no SEI",
            usuario=atual, processo_id=processo_id,
        )
        s.commit()

    fila = app_cliente.get("/api/v1/pendencias").json()
    assert fila["abertas"] == 1 and fila["atrasadas"] == 0
    item = fila["itens"][0]
    assert item["rotulo_tipo"] == "Incluir o parecer assinado no SEI"
    assert item["descricao"] == "incluir no SEI"
    assert item["prazo"] is not None
    assert item["onde"] == f"/processos/{processo_id}"
