"""Entrar tem de funcionar: caixa do login, mensagem única, conta bloqueada."""

from __future__ import annotations

from sqlalchemy import select

from app.modelos import Usuario
from app.servicos import autenticacao
from testes.integracao.conftest import entrar


def test_login_ignora_maiusculas(app_cliente, contas):
    """'Bisso' e 'bisso' são a mesma pessoa — exigir a caixa exata só produz um
    'usuário ou senha inválidos' impossível de depurar."""
    for variante in ("coordenador_csso", "COORDENADOR_CSSO", "Coordenador_CSSO"):
        resposta = app_cliente.post(
            "/login",
            data={"login": variante, "senha": "SenhaDeTeste2026"},
            follow_redirects=False,
        )
        assert resposta.status_code == 303, variante
        app_cliente.get("/sair")


def test_login_ignora_espacos_em_volta(app_cliente, contas):
    resposta = app_cliente.post(
        "/login",
        data={"login": "  coordenador_csso  ", "senha": "SenhaDeTeste2026"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303


def test_a_senha_continua_sensivel_a_maiusculas(app_cliente, contas):
    resposta = app_cliente.post(
        "/login", data={"login": "coordenador_csso", "senha": "senhadeteste2026"}
    )
    assert "inválidos" in resposta.text


def test_erro_aparece_uma_vez_so(app_cliente, contas):
    resposta = app_cliente.post("/login", data={"login": "ninguem", "senha": "x"})
    assert resposta.text.count("Usuário ou senha inválidos.") == 1


def test_usuario_inexistente_nao_bloqueia_conta_alheia(app_cliente, contas, banco):
    from app import banco as mod_banco

    for _ in range(6):
        app_cliente.post("/login", data={"login": "nao_existe", "senha": "x"})
    with mod_banco.sessao() as s:
        for usuario in s.execute(select(Usuario)).scalars():
            assert usuario.tentativas_falhas == 0
            assert usuario.bloqueado_ate is None


def test_buscar_por_login(banco, contas):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        assert autenticacao.buscar_por_login(s, "AUDITOR_INTERNO") is not None
        assert autenticacao.buscar_por_login(s, " auditor_interno ") is not None
        assert autenticacao.buscar_por_login(s, "auditor_intern") is None
        assert autenticacao.buscar_por_login(s, "") is None
        assert autenticacao.buscar_por_login(s, None) is None


def test_entra_pelo_email(banco, contas):
    """O e-mail é a credencial de entrada — é o que permite entrar quem não tem
    SIAPE, e é o que a pessoa sabe de cor."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        conta = autenticacao.buscar_por_login(s, "auditor_interno")
        email = conta.email
        assert email

        achado = autenticacao.buscar_por_login(s, email)
        assert achado is not None and achado.id == conta.id
        # o e-mail também não depende de caixa nem de espaço em volta
        assert autenticacao.buscar_por_login(s, email.upper()).id == conta.id
        assert autenticacao.buscar_por_login(s, f"  {email}  ").id == conta.id
        assert autenticacao.buscar_por_login(s, "ninguem@ufvjm.edu.br") is None


def test_login_pela_tela_aceita_email(app_cliente, contas, banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        email = autenticacao.buscar_por_login(s, "coordenador_csso").email

    resposta = app_cliente.post(
        "/login",
        data={"login": email, "senha": "SenhaDeTeste2026"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303


def test_o_nome_de_usuario_antigo_continua_valendo(app_cliente, contas):
    """A troca não pode trancar quem já entrava pelo usuário."""
    resposta = app_cliente.post(
        "/login",
        data={"login": "coordenador_csso", "senha": "SenhaDeTeste2026"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303


def test_a_tela_de_login_pede_email(app_cliente, contas):
    """`contas` é necessário: sem nenhum usuário, /login manda para o primeiro acesso."""
    app_cliente.get("/sair")
    corpo = app_cliente.get("/login").text
    assert "E-mail" in corpo
    assert "nome@ufvjm.edu.br" in corpo
    assert "Usuário</label>" not in corpo


def test_primeiro_acesso_nao_pede_nome_de_usuario(app_cliente, banco):
    """Um segundo identificador que ninguém volta a digitar só serve p/ esquecer."""
    corpo = app_cliente.get("/primeiro-acesso").text
    assert "Usuário</label>" not in corpo
    assert "E-mail institucional" in corpo

    resposta = app_cliente.post(
        "/primeiro-acesso",
        data={
            "nome": "Fabrício Raimundi Andrade",
            "email": "Fabricio.Andrade@ufvjm.edu.br",
            "senha": "primeira1",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    entrou = app_cliente.post(
        "/login",
        data={"login": "fabricio.andrade@ufvjm.edu.br", "senha": "primeira1"},
        follow_redirects=False,
    )
    assert entrou.status_code == 303


def test_usuario_derivado_do_email():
    d = autenticacao.usuario_a_partir_do_email
    assert d("Fabricio.Andrade@ufvjm.edu.br") == "fabricio.andrade"
    assert d("nome+marca@dominio.br") == "nomemarca"
    assert d("") == "usuario"
    assert d("@só.acento") == "usuario"


def test_depois_de_trocar_a_senha_a_antiga_nao_serve(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/trocar-senha",
        data={
            "senha_atual": "SenhaDeTeste2026",
            "nova": "novasenha1",
            "confirmacao": "novasenha1",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    app_cliente.get("/sair")

    velha = app_cliente.post(
        "/login", data={"login": "coordenador_csso", "senha": "SenhaDeTeste2026"}
    )
    assert "inválidos" in velha.text

    nova = app_cliente.post(
        "/login",
        data={"login": "coordenador_csso", "senha": "novasenha1"},
        follow_redirects=False,
    )
    assert nova.status_code == 303
    _ = mod_banco


def _segundo_cliente():
    """Outra sessão do MESMO usuário — é o intruso do I-1."""
    from fastapi.testclient import TestClient

    from app.principal import criar_app

    return TestClient(criar_app(), raise_server_exceptions=False)


def test_autotroca_de_senha_derruba_as_outras_sessoes(app_cliente, contas):
    """I-1 — trocar a própria senha é o gesto de quem desconfia que alguém a viu.

    Antes da correção esse gesto não expulsava ninguém: o reset feito por
    administrador revogava e a inativação de conta também, e só a autotroca
    deixava a sessão do outro válida por até 12 h. O teste exige as DUAS metades
    — a outra sessão cai, e a de quem trocou sobrevive. Derrubar quem está
    trocando seria a correção pela metade na direção oposta: ensina a não trocar
    senha.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    with _segundo_cliente() as outra:
        entrar(outra, contas, "coordenador_csso")
        assert outra.get("/kanban").status_code == 200

        resposta = app_cliente.post(
            "/trocar-senha",
            data={
                "senha_atual": "SenhaDeTeste2026",
                "nova": "trocada2026",
                "confirmacao": "trocada2026",
            },
            follow_redirects=False,
        )
        assert resposta.status_code == 303

        caiu = outra.get("/kanban", follow_redirects=False)
        assert caiu.status_code == 303 and "/login" in caiu.headers["location"]

    assert app_cliente.get("/kanban").status_code == 200


def test_reset_por_administrador_continua_derrubando_tudo(banco, contas):
    """A revogação em massa não pode ter sido enfraquecida pela exceção do I-1."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        usuario = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        _, token = autenticacao.autenticar(s, "coordenador_csso", "SenhaDeTeste2026")
        s.flush()
        assert autenticacao.sessao_valida(s, token) is not None
        # sem `exceto_token` nenhuma sessão é poupada — é o caminho do
        # `rotas/usuarios.py` e do `senha_cli`
        assert autenticacao.revogar_do_usuario(s, usuario.id) >= 1
        assert autenticacao.sessao_valida(s, token) is None


def test_o_token_de_sessao_e_assinado_com_a_chave_secreta(monkeypatch):
    """I-4 — a chave existe para chavear ISTO, e não para o /saude dizer que sim.

    Enquanto o token era SHA-256 puro, `CSSO_CHAVE_SECRETA` não era lida por
    nada e trocá-la não fazia absolutamente nada — mas o aviso do /saude
    afirmava que ela protegia a instalação. Aqui se exige o contrário das duas
    coisas: o digest muda com a chave, e não é mais o SHA-256 do token.
    """
    import hashlib

    class Chaveiro:
        chave_secreta = "chave-de-teste-a"

    monkeypatch.setattr(autenticacao, "obter_config", lambda: Chaveiro())
    com_a = autenticacao._hash_token("token-qualquer")

    Chaveiro.chave_secreta = "chave-de-teste-b"
    com_b = autenticacao._hash_token("token-qualquer")

    assert com_a != com_b, "trocar a chave não mudou nada — ela continua órfã"
    assert len(com_a) == 64, "a coluna token_hash é String(64)"
    assert com_a != hashlib.sha256(b"token-qualquer").hexdigest()


def test_rotacionar_a_chave_secreta_derruba_toda_sessao_aberta(app_cliente, contas, monkeypatch):
    """Rotação de segredo é a primeira linha de um plano de resposta a incidente.

    Até a 1.30.0 este sistema não tinha o que rotacionar: nenhuma chave entrava
    em nada. Agora trocar `CSSO_CHAVE_SECRETA` invalida toda sessão de todo
    mundo no ato, sem tocar no banco.
    """
    from app.config import obter_config

    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/kanban").status_code == 200

    real = obter_config()

    class Girada:
        chave_secreta = "chave-rotacionada-depois-do-incidente"

        def __getattr__(self, nome):
            return getattr(real, nome)

    monkeypatch.setattr(autenticacao, "obter_config", lambda: Girada())
    depois = app_cliente.get("/kanban", follow_redirects=False)
    assert depois.status_code == 303 and "/login" in depois.headers["location"]


# ---------------------------------------------------------------------
# A recusa diz até quando, e a tela de login diz por que se está nela
# ---------------------------------------------------------------------
def test_conta_bloqueada_diz_ate_quando_e_a_saida(app_cliente, contas):
    """"Temporariamente bloqueada" não dizia por quanto tempo. O valor existe
    (15 minutos, `bloqueio_minutos`) e o horário está no registro da conta;
    quem está sob prazo lia a recusa e ligava para alguém, ou desistia."""
    from app.config import obter_config

    for _ in range(obter_config().max_tentativas):
        app_cliente.post("/login", data={"login": "coordenador_csso", "senha": "errada"})
    resposta = app_cliente.post(
        "/login", data={"login": "coordenador_csso", "senha": "SenhaDeTeste2026"}
    )
    assert "Conta bloqueada até" in resposta.text
    assert "tentativas malsucedidas seguidas" in resposta.text
    assert "quem administra o sistema redefine" in resposta.text
    assert "temporariamente" not in resposta.text


def test_sessao_expirada_volta_ao_login_com_o_motivo_e_o_filtro(app_cliente, contas):
    """Sessão expirada em `/processos?estado=X&pagina=3` voltava para
    `/processos` — o filtro que a pessoa tinha montado sumia no exato momento em
    que ela entrava de novo para vê-lo. E a tela não dizia que a sessão tinha
    expirado: só um cookie que não vale mais distingue "cheguei" de "caí"."""
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.get("/sair")  # o cookie de sessão foi revogado no servidor
    app_cliente.cookies.set(autenticacao.COOKIE_SESSAO, "sessao-que-nao-vale-mais")

    resposta = app_cliente.get("/processos?estado=EM_TRIAGEM&pagina=3", follow_redirects=False)
    assert resposta.status_code == 303
    destino = resposta.headers["location"]
    assert destino.startswith("/login?")
    assert "motivo=sessao" in destino
    # o `proximo` carrega a query inteira, codificada — `?` e `&` dentro dele
    # não podem cortar a URL do login
    assert "proximo=%2Fprocessos%3Festado%3DEM_TRIAGEM%26pagina%3D3" in destino

    tela = app_cliente.get(destino)
    assert "Sua sessão expirou" in tela.text
    assert 'value="/processos?estado=EM_TRIAGEM&amp;pagina=3"' in tela.text


def test_envio_com_sessao_expirada_diz_que_nada_foi_gravado(app_cliente, contas):
    """Um POST sem sessão virava um 303 para `/login` e o corpo sumia em
    silêncio. Com `sessao_horas = 12` é raro; num editor de parecer aberto
    desde a manhã, é possível. O `proximo` de um POST não é a rota do POST (voltar
    por GET a ela é 405): é a tela de origem, lida do Referer."""
    app_cliente.cookies.set(autenticacao.COOKIE_SESSAO, "expirada")
    resposta = app_cliente.post(
        "/kanban/mover/1",
        data={"coluna": "A_FAZER"},
        headers={"referer": "http://testserver/kanban?q=abc"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    destino = resposta.headers["location"]
    assert "motivo=envio" in destino
    assert "proximo=%2Fkanban%3Fq%3Dabc" in destino
    tela = app_cliente.get(destino)
    assert "não foi salvo" in tela.text


def test_chegar_sem_cookie_nenhum_nao_e_sessao_expirada(app_cliente, contas):
    resposta = app_cliente.get("/kanban", follow_redirects=False)
    assert "motivo=" not in resposta.headers["location"]
    tela = app_cliente.get(resposta.headers["location"])
    assert "sessão expirou" not in tela.text


def test_o_login_so_devolve_para_dentro_do_sistema(app_cliente, contas):
    """`proximo` chega pela query e pelo formulário e ia direto para o
    `Location`: `?proximo=https://outro.site` mandava quem acabou de digitar a
    senha para fora — o disfarce clássico de phishing."""
    for fora in ("https://evil.example", "//evil.example", "/" + chr(92) + "evil.example", "inicio"):
        tela = app_cliente.get("/login", params={"proximo": fora})
        assert 'name="proximo" value="/inicio"' in tela.text, fora
        resposta = app_cliente.post(
            "/login",
            data={"login": "coordenador_csso", "senha": "SenhaDeTeste2026", "proximo": fora},
            follow_redirects=False,
        )
        assert resposta.headers["location"] == "/inicio", fora
        app_cliente.get("/sair")

    # e o caminho legítimo continua sendo honrado, com a query
    resposta = app_cliente.post(
        "/login",
        data={
            "login": "coordenador_csso",
            "senha": "SenhaDeTeste2026",
            "proximo": "/processos?estado=EM_TRIAGEM",
        },
        follow_redirects=False,
    )
    assert resposta.headers["location"] == "/processos?estado=EM_TRIAGEM"
