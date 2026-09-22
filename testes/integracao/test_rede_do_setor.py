"""O que muda quando o sistema deixa de ser um programa de mesa.

Quatro assuntos, e os quatro nasceram do levantamento
`entrada/implantacao/00_PRONTIDAO.md`:

* **T-2** — o `Secure` do cookie decidido pelo endereco de ligacao. E o defeito
  que ninguem ve: o login parece dar certo, devolve 303, e a tela seguinte
  manda de volta para `/login` sem mensagem nenhuma. Os testes de cookie daqui
  existem porque **laco de login nao aparece em teste de fluxo feliz** — o
  `TestClient` guarda o cookie `Secure` e o reenvia por http, que e justamente o
  que o navegador NAO faz. Por isso o que se afirma aqui e o atributo do
  `Set-Cookie`, e nao o efeito.
* **C-1/C-2** — os cabecalhos de seguranca, que nao existiam.
* **L-1/L-2** — o registro de acesso, que nao existia, e sobretudo o que ele
  **nao** pode conter (`docs/ROPA.md` §6).
* **K-2** — `exportar-tudo` deixando de ser GET.
"""

from __future__ import annotations

import logging
import re

import pytest
from fastapi.testclient import TestClient

from app.config import RAIZ, obter_config
from testes.integracao.conftest import entrar

TEMPLATES = RAIZ / "app" / "templates"
_SEM_COMENTARIO = re.compile(r"\{#.*?#\}", re.DOTALL)


@pytest.fixture()
def cliente_https(banco):
    """O mesmo app, alcancado por https — e o proxy com TLS a frente."""
    from app.principal import criar_app

    with TestClient(
        criar_app(), base_url="https://testserver", raise_server_exceptions=False
    ) as cliente:
        yield cliente


def _set_cookie_de_sessao(resposta) -> str:
    for bruto in resposta.headers.get_list("set-cookie"):
        if bruto.startswith("csso_sessao="):
            return bruto
    raise AssertionError(f"nenhum cookie de sessao em {resposta.headers}")


# =====================================================================
# T-2 — o `Secure` sai da conexao, nunca do endereco de ligacao
# =====================================================================
def test_cookie_de_sessao_nao_sai_secure_por_http(app_cliente, contas):
    login, senha = contas["coordenador_csso"]
    resposta = app_cliente.post(
        "/login", data={"login": login, "senha": senha}, follow_redirects=False
    )
    assert resposta.status_code == 303
    assert "Secure" not in _set_cookie_de_sessao(resposta)


def test_cookie_de_sessao_sai_secure_por_https(cliente_https, contas):
    login, senha = contas["coordenador_csso"]
    resposta = cliente_https.post(
        "/login", data={"login": login, "senha": senha}, follow_redirects=False
    )
    assert resposta.status_code == 303
    assert "Secure" in _set_cookie_de_sessao(resposta)


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.0.7"])
def test_o_endereco_de_ligacao_nao_decide_mais_o_secure(
    app_cliente, contas, monkeypatch, host
):
    """O defeito reproduzido, e a correcao amarrada.

    `CSSO_HOST=0.0.0.0` e literalmente o que o `LEIA-ME.txt` mandava fazer, com
    a frase "nenhuma linha de codigo muda" ao lado. Com o calculo antigo o
    cookie saia `Secure` numa conexao http, o navegador parava de devolve-lo e o
    setor inteiro ficava do lado de fora — sem erro, sem log, sem mensagem.
    """
    monkeypatch.setattr(obter_config(), "host", host)
    login, senha = contas["coordenador_csso"]
    resposta = app_cliente.post(
        "/login", data={"login": login, "senha": senha}, follow_redirects=False
    )
    assert "Secure" not in _set_cookie_de_sessao(resposta), (
        f"ligar em {host} voltou a marcar o cookie como Secure sem haver TLS: "
        "e o laco de login de volta."
    )
    # e a sessao vale de fato na requisicao seguinte
    assert app_cliente.get("/inicio", follow_redirects=False).status_code == 303
    assert app_cliente.get("/processos").status_code == 200


def test_o_cookie_de_modulo_segue_a_mesma_decisao(app_cliente, contas, monkeypatch):
    """`web.pagina` tinha o calculo DUPLICADO, e por isso errava junto."""
    monkeypatch.setattr(obter_config(), "host", "0.0.0.0")
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/processos")
    for bruto in resposta.headers.get_list("set-cookie"):
        assert "Secure" not in bruto, bruto


def test_cookie_seguro_sim_forca_secure_mesmo_sem_tls(app_cliente, contas, monkeypatch):
    """A saida explicita: TLS num proxy que o uvicorn nao confia.

    O esquema chega `http` e mesmo assim ha TLS de verdade a frente — e quem
    sabe disso e quem instalou, nao a requisicao.
    """
    monkeypatch.setattr(obter_config(), "cookie_seguro", "sim")
    login, senha = contas["coordenador_csso"]
    resposta = app_cliente.post(
        "/login", data={"login": login, "senha": senha}, follow_redirects=False
    )
    assert "Secure" in _set_cookie_de_sessao(resposta)


def test_cookie_seguro_nao_desliga_mesmo_com_tls(cliente_https, contas, monkeypatch):
    monkeypatch.setattr(obter_config(), "cookie_seguro", "nao")
    login, senha = contas["coordenador_csso"]
    resposta = cliente_https.post(
        "/login", data={"login": login, "senha": senha}, follow_redirects=False
    )
    assert "Secure" not in _set_cookie_de_sessao(resposta)


def test_valor_torto_cai_em_auto_e_nao_derruba_o_boot(monkeypatch):
    from app import seguranca

    monkeypatch.setattr(obter_config(), "cookie_seguro", "SIM, POR FAVOR")
    assert seguranca.modo_do_cookie() == "auto"


@pytest.mark.parametrize(
    "valor,trecho",
    [
        ("sim", "ninguem entra"),
        ("nao", "sem o atributo"),
        ("mais ou menos", "nao e um valor valido"),
    ],
)
def test_a_escolha_arriscada_do_secure_fica_escrita(monkeypatch, valor, trecho):
    """Quem escolher errado tem de LER isso, e nao descobrir pelo laco de login.

    `Config.inseguro` sai em tres lugares — o console do INICIAR.bat, o `/saude`
    e a faixa da casca de toda tela.
    """
    cfg = obter_config()
    monkeypatch.setattr(cfg, "cookie_seguro", valor)
    assert any(trecho in aviso for aviso in cfg.inseguro), cfg.inseguro


def test_ligar_fora_do_loopback_avisa_que_a_porta_ficou_alcancavel(monkeypatch):
    cfg = obter_config()
    monkeypatch.setattr(cfg, "host", "0.0.0.0")
    assert any("alcancavel por outras maquinas" in a for a in cfg.inseguro), cfg.inseguro
    monkeypatch.setattr(cfg, "host", "127.0.0.1")
    assert not any("alcancavel" in a for a in cfg.inseguro)


# =====================================================================
# C-1 / C-2 — cabecalhos e CSP
# =====================================================================
CABECALHOS = ("content-security-policy", "x-content-type-options", "referrer-policy",
              "x-frame-options")


@pytest.mark.parametrize("caminho", ["/login", "/saude", "/estaticos/htmx.min.js"])
def test_cabecalhos_de_seguranca_em_toda_resposta(app_cliente, caminho):
    """Inclusive no estatico e no JSON: era `content-length` e `content-type`,
    e mais nada, medido no levantamento."""
    resposta = app_cliente.get(caminho)
    assert resposta.status_code == 200, caminho
    for nome in CABECALHOS:
        assert nome in resposta.headers, f"{caminho} saiu sem {nome}"
    assert resposta.headers["x-content-type-options"] == "nosniff"
    assert resposta.headers["x-frame-options"] == "DENY"
    assert resposta.headers["referrer-policy"] == "same-origin"


def test_cabecalhos_tambem_na_tela_de_erro(app_cliente, contas):
    entrar(app_cliente, contas, "almoxarife_sesmt")
    resposta = app_cliente.get("/config")
    assert resposta.status_code == 403
    for nome in CABECALHOS:
        assert nome in resposta.headers


def test_csp_nao_afrouxa_o_script(app_cliente):
    """O afrouxamento existe e e UM SO, e e no estilo.

    `script-src` sem `'unsafe-inline'` e o ponto inteiro do nonce; o
    `'unsafe-inline'` do estilo esta cercado por `style-src-elem 'self'`, e a
    razao esta escrita em `app/seguranca.py`.
    """
    csp = app_cliente.get("/login").headers["content-security-policy"]
    diretivas = {
        parte.split(" ", 1)[0]: parte.split(" ", 1)[1] if " " in parte else ""
        for parte in (p.strip() for p in csp.split(";"))
        if parte
    }
    assert "'unsafe-inline'" not in diretivas["script-src"]
    assert "'unsafe-eval'" not in diretivas["script-src"]
    assert diretivas["script-src"].startswith("'self' 'nonce-")
    assert diretivas["default-src"] == "'self'"
    assert diretivas["frame-ancestors"] == "'none'"
    assert diretivas["base-uri"] == "'none'"
    assert diretivas["object-src"] == "'none'"
    assert diretivas["form-action"] == "'self'"
    # o unico afrouxamento, e cercado
    assert "'unsafe-inline'" in diretivas["style-src"]
    assert diretivas["style-src-elem"] == "'self'"


def test_hsts_so_existe_quando_ha_https(app_cliente, cliente_https):
    assert "strict-transport-security" not in app_cliente.get("/saude").headers
    assert "strict-transport-security" in cliente_https.get("/saude").headers


def test_o_nonce_muda_a_cada_resposta(app_cliente):
    marcas = {
        app_cliente.get("/login").headers["content-security-policy"]
        for _ in range(3)
    }
    assert len(marcas) == 3, "nonce repetido entre respostas nao e nonce"


@pytest.mark.parametrize("caminho", ["/login", "/trocar-senha", "/processos", "/kanban"])
def test_todo_script_embutido_da_tela_carrega_o_nonce_da_resposta(
    app_cliente, contas, caminho
):
    """A tela renderizada de verdade, e nao so o template.

    Um `<script>` embutido sem a marca simplesmente nao roda no navegador, e o
    sintoma seria uma funcionalidade sumindo em silencio — o `Esc` do popup, o
    tratador de erro do HTMX, a barra de forca da senha.
    """
    if caminho != "/login":
        entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get(caminho)
    assert resposta.status_code == 200, caminho
    marca = re.search(r"'nonce-([^']+)'", resposta.headers["content-security-policy"])
    assert marca, "sem nonce no cabecalho"
    embutidos = [
        atributos
        for atributos in re.findall(r"<script([^>]*)>", resposta.text)
        if "src=" not in atributos
    ]
    assert embutidos, f"{caminho} nao tem script embutido — o teste perdeu o alvo"
    for atributos in embutidos:
        assert f'nonce="{marca.group(1)}"' in atributos, f"{caminho}: <script{atributos}>"


def test_o_htmx_nao_injeta_o_style_que_a_csp_recusa(app_cliente):
    """O único recurso que a CSP quebrava, medido antes de declará-la.

    O HTMX insere um `<style>` com as regras de `.htmx-indicator` ao carregar, e
    `style-src-elem 'self'` o recusa — uma violação no console de toda tela. As
    regras não pintam nada aqui: `hx-indicator` não aparece em atributo nenhum
    dos templates e `csso.css` não tem regra de `.htmx-indicator`. Desligar tira
    a violação sem tirar comportamento.
    """
    corpo = app_cliente.get("/login").text
    assert '"includeIndicatorStyles":false' in corpo
    assert corpo.index("htmx-config") < corpo.index("htmx.min.js"), (
        "a configuração tem de vir antes do htmx, senão ele já injetou"
    )

    css = (RAIZ / "app" / "estaticos" / "css" / "csso.css").read_text(encoding="utf-8")
    assert "htmx-indicator" not in css, (
        "a folha passou a usar .htmx-indicator: ou as regras voltam a ser "
        "necessárias, ou elas viram regra própria do csso.css"
    )


def test_o_htmx_nao_precisa_de_unsafe_eval():
    """`hx-vals=\"js:...\"` e filtro de evento `[...]` em `hx-trigger` passam por
    `new Function`, que `script-src` sem `'unsafe-eval'` recusa. Não há nenhum
    dos dois — e este teste é o que impede o primeiro de entrar sem que alguém
    perceba que ele não vai rodar."""
    for arquivo in TEMPLATES.rglob("*.html"):
        texto = _SEM_COMENTARIO.sub("", arquivo.read_text(encoding="utf-8"))
        assert "hx-vals" not in texto, arquivo
        for gatilho in re.findall(r'hx-trigger="([^"]*)"', texto):
            assert "[" not in gatilho, f"{arquivo}: filtro de evento em {gatilho!r}"


def test_nenhum_template_traz_atributo_de_evento_inline():
    """A trava, no espirito de `test_rn19_nenhum_template_le_nome_de_servidor_direto`.

    Atributo `on*=` e a unica forma de script embutido que o nonce NAO alcanca:
    um so obrigaria a CSP a carregar `script-src-attr 'unsafe-inline'`, que e a
    porta pela qual a injecao em atributo passa. Os tres que existiam viraram
    tratadores delegados no `base.html` (`data-envia-ao-mudar`, `data-imprimir`).
    """
    padrao = re.compile(r"\son[a-z]+\s*=\s*[\"']", re.IGNORECASE)
    achados = [
        f"{arquivo.relative_to(TEMPLATES)}:{numero}"
        for arquivo in TEMPLATES.rglob("*.html")
        for numero, linha in enumerate(
            _SEM_COMENTARIO.sub("", arquivo.read_text(encoding="utf-8")).splitlines(), 1
        )
        if padrao.search(linha)
    ]
    assert not achados, f"atributo de evento inline (a CSP recusa): {achados}"


def test_todo_script_embutido_do_template_pede_o_nonce():
    """Complementa o teste de tela: cobre tambem o template que nenhuma das
    quatro telas acima renderiza."""
    sem_marca = []
    for arquivo in TEMPLATES.rglob("*.html"):
        # os comentarios `{# #}` do Jinja nao chegam ao navegador, e varios
        # deles citam `<script>` ao explicar por que a marca existe
        texto = _SEM_COMENTARIO.sub("", arquivo.read_text(encoding="utf-8"))
        for atributos in re.findall(r"<script([^>]*)>", texto):
            if "src=" in atributos:
                continue
            if "nonce=" not in atributos:
                sem_marca.append(str(arquivo.relative_to(TEMPLATES)))
    assert not sem_marca, f"<script> embutido sem nonce (nao vai rodar): {sem_marca}"


# =====================================================================
# L-1 / L-2 — o registro de acesso, e o que ele NAO leva
# =====================================================================
@pytest.fixture()
def acesso(caplog):
    caplog.set_level(logging.INFO, logger="csso.acesso")
    return caplog


def _linhas(acesso) -> list[str]:
    return [r.getMessage() for r in acesso.records if r.name == "csso.acesso"]


@pytest.fixture()
def servidor_qualquer(banco):
    """Um servidor gravado por sessao curta — nao pela fixture `sessao`, que
    seguraria o lock de escrita durante as requisicoes do `app_cliente`."""
    from app import banco as mod_banco
    from app.modelos import Cargo, Servidor, UnidadeUorg
    from sqlalchemy import select

    with mod_banco.sessao() as s:
        cargo = s.execute(select(Cargo)).scalars().first()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        registro = Servidor(
            siape="9900112",
            nome="Marco Antônio Alves Schetino",
            cargo_id=cargo.id if cargo else None,
            unidade_uorg_id=unidade.id if unidade else None,
        )
        s.add(registro)
        s.commit()
        return registro.id


def test_o_registro_grava_a_forma_da_rota_e_nao_o_caminho(
    app_cliente, contas, servidor_qualquer, acesso
):
    """`/servidores/12` e identificador: com a tabela na mao, o 12 e uma pessoa.

    O que fica no arquivo e `/servidores/{servidor_id}`. Quem le a ficha de quem
    ja e registrado, com o titular e a finalidade, em `acesso_dado_sensivel` —
    la dentro do banco, sob RBAC e sob a cifra do backup.
    """
    alvo = servidor_qualquer
    entrar(app_cliente, contas, "coordenador_csso")
    acesso.clear()
    assert app_cliente.get(f"/servidores/{alvo}").status_code == 200

    linhas = _linhas(acesso)
    assert any("/servidores/{servidor_id}" in linha for linha in linhas), linhas
    assert not any(f"/servidores/{alvo} " in linha for linha in linhas), linhas


def test_o_registro_nao_leva_query_string_nem_nome(app_cliente, contas, acesso):
    """A query string carrega o filtro digitado, e o filtro digitado e o nome."""
    entrar(app_cliente, contas, "coordenador_csso")
    acesso.clear()
    app_cliente.get("/servidores", params={"q": "Marco Antonio Alves Schetino"})

    linhas = _linhas(acesso)
    assert linhas
    for linha in linhas:
        # o nome digitado nao aparece, e a linha inteira nao tem query string:
        # o campo da rota e o ultimo antes do status, e ele para em `/servidores`
        assert "Marco" not in linha, linha
        assert "?" not in linha, linha
        assert re.search(r" GET /servidores \d+ \d+ms$", linha), linha


def test_o_registro_traz_a_conta_por_id_e_nunca_o_login(app_cliente, contas, acesso):
    """`login` sai da parte local do e-mail institucional: e `nome.sobrenome`,
    ou seja, nome de pessoa — e nome de pessoa nao entra em arquivo de log."""
    from app import banco as mod_banco
    from app.modelos import Usuario
    from sqlalchemy import select

    entrar(app_cliente, contas, "coordenador_csso")
    with mod_banco.sessao() as s:
        usuario = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        conta_id, nome = usuario.id, usuario.nome
    acesso.clear()
    app_cliente.get("/processos")

    linhas = _linhas(acesso)
    assert any(f"conta={conta_id} " in linha for linha in linhas), linhas
    for linha in linhas:
        assert "coordenador_csso" not in linha, linha
        assert nome not in linha, linha


def test_o_login_bem_sucedido_fica_atribuido_a_conta(app_cliente, contas, acesso):
    """E a primeira linha que uma investigacao procura, e a unica rota que
    estabelece identidade sem passar por `usuario_opcional`."""
    acesso.clear()
    entrar(app_cliente, contas, "coordenador_csso")
    linha = next(l for l in _linhas(acesso) if "POST /login" in l)
    assert "conta=-" not in linha, linha


def test_rota_desconhecida_nao_escreve_o_caminho_no_registro(app_cliente, acesso):
    """URL que nao casou com rota nenhuma e texto livre de quem chamou: bastaria
    pedir `/fulano-de-tal-tem-insalubridade` para plantar uma frase nominal
    dentro do arquivo que o ROPA governa. O 404 e a origem continuam la."""
    acesso.clear()
    app_cliente.get("/fulano-de-tal-tem-insalubridade")
    linhas = _linhas(acesso)
    assert linhas
    assert not any("fulano" in linha.lower() for linha in linhas), linhas
    assert any(" 404 " in linha for linha in linhas), linhas


def test_o_registro_traz_status_duracao_e_origem(app_cliente, acesso):
    acesso.clear()
    app_cliente.get("/saude")
    linha = next(l for l in _linhas(acesso) if "/saude" in l)
    assert re.search(
        r"^req=[0-9a-f]{8} ip=\S+ conta=\S+ GET /saude 200 \d+ms$", linha
    ), linha


def test_requisicao_que_estoura_continua_deixando_linha(app_cliente, acesso):
    """E a requisicao que mais interessa a uma investigacao.

    A excecao nao tratada sobe alem deste middleware — quem a converte em
    resposta e o `ServerErrorMiddleware`, que o Starlette monta por fora de todo
    middleware de usuario. A linha sai assim mesmo, com o 500 que o navegador
    de fato recebe.

    A rota entra na aplicacao JA construida pelo fixture, e nao numa aplicacao
    montada aqui dentro: subir o ciclo de vida no corpo do teste faria o
    `fileConfig` do alembic trocar os tratadores da raiz no meio da fase, e o
    `caplog` perderia a propria linha que se quer conferir.
    """

    @app_cliente.app.get("/rota-que-estoura-so-neste-teste")
    def _estoura():  # pragma: no cover - o corpo e a excecao
        raise RuntimeError("proposital")

    acesso.clear()
    assert app_cliente.get("/rota-que-estoura-so-neste-teste").status_code == 500

    linhas = _linhas(acesso)
    assert any(" 500 " in linha for linha in linhas), linhas
    assert not any(" 0 " in linha for linha in linhas), linhas


def test_a_retencao_do_registro_e_a_mesma_da_sessao(tmp_path, monkeypatch):
    """90 dias, e cumprida pelo mecanismo — nao so declarada.

    `docs/POLITICA_RETENCAO.md` da 90 dias a `sessao` por causa do IP que a
    tabela guarda; este arquivo guarda o mesmo IP. Dois prazos para o mesmo dado
    pessoal na mesma instalacao seria uma politica que se contradiz.
    """
    import logging.handlers

    from app import registro_acesso

    cfg = obter_config()
    assert cfg.log_retencao_dias == 90

    solto = logging.getLogger("csso.acesso.teste-de-retencao")
    monkeypatch.setattr(registro_acesso, "log", solto)
    monkeypatch.setattr(cfg, "dir_logs", str(tmp_path / "logs"))
    alvo = registro_acesso.configurar_arquivo(cfg)
    try:
        assert alvo == tmp_path / "logs" / "acesso.log"
        tratador = solto.handlers[-1]
        assert isinstance(tratador, logging.handlers.TimedRotatingFileHandler)
        assert tratador.when == "MIDNIGHT"
        assert tratador.backupCount == 90
        # idempotente: a suite constroi uma aplicacao por teste
        assert registro_acesso.configurar_arquivo(cfg) is None
        assert len(solto.handlers) == 1
    finally:
        for tratador in list(solto.handlers):
            tratador.close()
            solto.removeHandler(tratador)


def test_o_arquivo_do_registro_nasce_fora_do_repositorio():
    """Mesma trava do `test_isolamento`: campo de diretorio novo entra em
    `diretorios_de_dados` ou escapa da conferencia."""
    cfg = obter_config()
    assert "dir_logs" in cfg.diretorios_de_dados
    caminho = cfg.diretorios_de_dados["dir_logs"].resolve()
    assert RAIZ not in caminho.parents and caminho != RAIZ


# =====================================================================
# K-2 — exportar-tudo deixa de ser GET
# =====================================================================
def test_exportar_tudo_recusa_get(app_cliente, contas):
    """Com `SameSite=lax` o cookie VAI numa navegacao de topo: uma pagina
    externa fazia o navegador de quem tem `exportar` gerar o pacote — em claro,
    com o banco, os CSVs nominais e todos os comprovantes assinados."""
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/config/exportar-tudo").status_code == 405


def test_exportar_tudo_funciona_por_post(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post("/config/exportar-tudo")
    assert resposta.status_code == 200
    assert resposta.headers["content-type"] == "application/zip"


def test_exportar_tudo_continua_exigindo_a_permissao(app_cliente, contas):
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert app_cliente.post("/config/exportar-tudo").status_code == 403


def test_a_tela_de_config_oferece_o_export_por_formulario(app_cliente, contas):
    """Link para uma rota POST daria 405 na cara de quem clicasse.

    O TESTE PASSOU A OLHAR O HTML RENDERIZADO, e nao o texto do template, e o
    invariante e o mesmo. A acao virou camada (`ui.popup_cadastro`): o `action`
    deixou de estar escrito em `config.html` — ele e argumento do macro — e um
    `assert` sobre o texto do template passaria a cobrar a grafia de um `<form>`
    que a tela nao escreve mais. O que importa nunca foi onde a string mora: e
    que o endereco chegue ao navegador como `action` de um `<form method=post>`,
    e nunca como `href`. Na pagina pronta isso se ve direto — e continua valendo
    no dia em que o macro mudar de forma outra vez.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/config").text
    formulario = re.search(
        r'<form[^>]*method="post"[^>]*action="/config/exportar-tudo"', corpo
    )
    assert formulario, "o export deixou de sair como <form method=post>"
    assert 'href="/config/exportar-tudo"' not in corpo


# =====================================================================
# L-2, ponto 1 — nome de pessoa no log da aplicacao
# =====================================================================
def test_o_aviso_de_escopo_nao_escreve_o_login(caplog):
    """`usuario.login` e `nome.sobrenome`. Enquanto o log era efemero isso era
    tolerado; com arquivo e retencao, nao e mais."""
    from app.modelos import Cargo
    from app.servicos import rbac
    from sqlalchemy import select

    usuario = rbac.UsuarioAtual(
        id=99,
        login="fulano.de.tal",
        nome="Fulano de Tal",
        permissoes=frozenset(),
        perfis=("servidor_consulta",),
        campi=(),
        servidor_id=None,
        precisa_trocar_senha=False,
    )
    caplog.set_level(logging.WARNING, logger="csso")
    rbac.aplicar_escopo(select(Cargo), usuario, Cargo)
    texto = caplog.text
    assert "fulano.de.tal" not in texto, texto
    assert "conta 99" in texto, texto
