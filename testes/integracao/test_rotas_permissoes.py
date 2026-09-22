"""CA-17 - toda rota tem fluxo feliz e negativa de permissao."""

from __future__ import annotations

import pytest

from testes.integracao.conftest import entrar

# (caminho, perfil que ve, perfil que NAO ve)
MATRIZ = [
    ("/", "coordenador_csso", None),
    ("/modulos", "admin_ti", None),
    ("/kanban", "coordenador_csso", None),
    ("/processos", "coordenador_csso", None),
    ("/processos/novo", "coordenador_csso", "consulta_progep"),
    ("/laudos", "coordenador_csso", "admin_ti"),
    ("/adicionais", "coordenador_csso", "admin_ti"),
    ("/pendencias", "coordenador_csso", "admin_ti"),
    # a fila do setor: a equipe toda enxerga, e o `admin_ti` continua fora —
    # demanda é conteúdo técnico, e a base normativa do perfil o mantém longe
    ("/demandas", "coordenador_csso", "admin_ti"),
    ("/importar/reconciliacao", "coordenador_csso", "secretaria_csso"),
    ("/servidores", "coordenador_csso", "admin_ti"),
    ("/catalogos", "coordenador_csso", "admin_ti"),
    ("/relatorios", "coordenador_csso", None),
    ("/auditoria", "auditor_interno", "secretaria_csso"),
    ("/importar", "coordenador_csso", "secretaria_csso"),
    # `/config` aceita `("processo.ver", "backup.executar")`, e o negado deixou
    # de ser o `admin_ti`: ele é justamente quem tem `backup.executar`, e a tela
    # que guarda o backup cifrado e a exportação total estava trancada para o
    # único perfil que existe para operá-los. O que ele vê lá dentro continua
    # sendo só a máquina — setor emissor, autoridade e SLA pedem `processo.ver`,
    # e é isso que `test_config_reparte_o_que_e_processo` cobra. O almoxarife
    # entra no lugar dele: não tem nenhuma das duas.
    ("/config", "coordenador_csso", "almoxarife_sesmt"),
    ("/perfis", "coordenador_csso", "admin_ti"),
    ("/usuarios", "superintendente", "secretaria_csso"),
    ("/turmas", "coordenador_csso", "admin_ti"),
    # `servidor_consulta` tem `treinamento.ver` e NÃO tem `certificado.ver`
    # (§8 do desenho): ele consulta o próprio histórico, não a lista nominal
    ("/certificados", "coordenador_csso", "servidor_consulta"),
    # a tela do titular, que é a outra metade da linha acima: ela abre com
    # `treinamento.ver` e prende a consulta ao `servidor_id` da conta. O `admin_ti`
    # é o negado porque ele não tem conteúdo técnico nenhum — e é ele, e não o
    # `servidor_consulta`, que esta tela existe para deixar de fora.
    ("/certificados/meus", "coordenador_csso", "admin_ti"),
    # o atalho do titular para a própria ficha de EPI: `epi.ver`, exatamente como
    # `epi_ficha.exigir_leitura_da_ficha` exige de quem lê a própria
    ("/epis/fichas/minha", "coordenador_csso", "admin_ti"),
    ("/treinamentos/catalogo", "coordenador_csso", "admin_ti"),
    ("/treinamentos/modelos", "coordenador_csso", "secretaria_csso"),
    ("/treinamentos/assinaturas", "coordenador_csso", "secretaria_csso"),
    # `admin_ti` continua sem conteúdo técnico: catálogo de EPI é conteúdo
    ("/epis/catalogo", "coordenador_csso", "admin_ti"),
    ("/epis/catalogo/categorias", "coordenador_csso", "admin_ti"),
    ("/epis/catalogo/motivos-recusa", "coordenador_csso", "admin_ti"),
    # o estoque abre em leitura para quem tem `epi.ver` — saldo de bota não
    # nomeia ninguém. Escrever no razão é que pede `epi.estoque`.
    ("/epis/estoque", "coordenador_csso", "admin_ti"),
    # o painel do módulo é `epi.ver`, como a fila e o estoque
    ("/epis", "coordenador_csso", "admin_ti"),
    # e o relatório é `indicador.ver`, como a §9 declara: o almoxarife opera o
    # módulo inteiro e não o abre. A permissão diferente é a razão de a tela
    # existir separada do painel.
    ("/epis/relatorios", "coordenador_csso", "almoxarife_sesmt"),
    # a busca global não exige permissão nenhuma, como `/modulos`: a permissão
    # vive em cada bloco, e um 403 na tela inteira devolveria ao almoxarife o
    # campo de texto que responde "acesso negado"
    ("/buscar", "almoxarife_sesmt", None),
]


@pytest.mark.parametrize("caminho,perfil,_negado", MATRIZ)
def test_fluxo_feliz(app_cliente, contas, caminho, perfil, _negado):
    entrar(app_cliente, contas, perfil)
    resposta = app_cliente.get(caminho)
    assert resposta.status_code == 200, f"{caminho} como {perfil}"


@pytest.mark.parametrize(
    "caminho,perfil",
    [(c, n) for c, _p, n in MATRIZ if n],
)
def test_permissao_negada(app_cliente, contas, caminho, perfil):
    entrar(app_cliente, contas, perfil)
    resposta = app_cliente.get(caminho)
    assert resposta.status_code == 403, f"{caminho} deveria negar {perfil}"


@pytest.mark.parametrize("caminho,_perfil,_negado", MATRIZ)
def test_sem_sessao_vai_para_login(app_cliente, caminho, _perfil, _negado):
    resposta = app_cliente.get(caminho, follow_redirects=False)
    assert resposta.status_code == 303
    assert "/login" in resposta.headers["location"]


def test_exportar_csv_exige_permissao(app_cliente, contas):
    entrar(app_cliente, contas, "secretaria_csso")
    assert app_cliente.get("/relatorios/exportar-processos").status_code == 403

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/relatorios/exportar-processos")
    assert resposta.status_code == 200
    assert resposta.content.startswith(b"\xef\xbb\xbf")


def test_backup_exige_permissao(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.post("/config/backup").status_code == 403

    entrar(app_cliente, contas, "admin_ti")
    resposta = app_cliente.post("/config/backup")
    # Era `in (200, 403)`: o `admin_ti` tinha `backup.executar` e a resposta da
    # rota é a própria tela, que exigia `processo.ver` — ele executava o backup e
    # levava 403 na confirmação, ou não executava, e o teste aceitava os dois.
    # Com `/config` abrindo para `("processo.ver", "backup.executar")` a
    # ambiguidade acaba: quem faz o backup lê que ele foi feito.
    assert resposta.status_code == 200
    assert "Backup cifrado gerado" in resposta.text


def test_criar_processo_e_ver_ficha(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/processos/novo",
        data={
            "nup": "23086.021284/2024-56",
            "tipo_processo_id": "1",
            "observacoes": "Instrução iniciada pela CSSO.",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    ficha = app_cliente.get(resposta.headers["location"])
    assert ficha.status_code == 200
    assert "23086.021284/2024-56" in ficha.text


def test_nup_com_dv_invalido_pede_confirmacao(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-99", "tipo_processo_id": "1"},
    )
    assert "confirmei no SEI" in resposta.text

    confirmado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-99", "tipo_processo_id": "1", "dispensar_dv": "1"},
        follow_redirects=False,
    )
    assert confirmado.status_code == 303


def test_nup_duplicado_e_recusado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    dados = {"nup": "23086.000608/2026-84", "tipo_processo_id": "1"}
    app_cliente.post("/processos/novo", data=dados, follow_redirects=False)
    repetido = app_cliente.post("/processos/novo", data=dados)
    assert "já existe processo com este NUP" in repetido.text


def test_criar_servidor_e_abrir_ficha(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/servidores",
        data={"siape": "1110654", "nome": "Marco Antônio Alves Schetino"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    ficha = app_cliente.get(resposta.headers["location"])
    assert "Marco Antônio Alves Schetino" in ficha.text


def test_siape_invalido_e_recusado(app_cliente, contas):
    """A recusa deixou de trocar a lista pela página de erro do sistema: ela
    volta a própria tela com o popup de cadastro reaberto e preenchido
    (`test_popup_de_cadastro.py`)."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post("/servidores", data={"siape": "123", "nome": "X"})
    assert "A matrícula SIAPE tem exatamente 7 dígitos" in resposta.text
    assert 'value="X"' in resposta.text


def test_cadastrar_laudo_e_marcar_superado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/laudos",
        data={
            "numero_siape": "26255-000.125/2019",
            "tipo_adicional_id": "1",
            "unidade_uorg_id": "1",
            "data_emissao": "2019-06-01",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    caminho = resposta.headers["location"]
    assert app_cliente.get(caminho).status_code == 200

    superar = app_cliente.post(
        f"{caminho}/superar",
        data={"motivo": "mudança no processo de trabalho"},
        follow_redirects=False,
    )
    assert superar.status_code == 303
    assert "superado" in app_cliente.get(caminho).text


def test_laudo_com_numero_invalido(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/laudos",
        data={"numero_siape": "1/2019", "tipo_adicional_id": "1", "unidade_uorg_id": "1"},
    )
    assert "Número de laudo inválido" in resposta.text


def test_cadastrar_portaria_normalizando_o_numero(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/catalogos/portarias",
        data={
            "texto_original": "PORTARIA/FAMED Nº 035, DE 17 DE SETEMBRO DE 2024",
            "unidade_emissora_id": "1",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    lista = app_cliente.get("/catalogos/portarias")
    assert "PORTARIA/FAMED Nº 035" in lista.text


def test_nova_versao_de_texto_padrao(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/catalogos/textos-padrao",
        data={
            "categoria": "ALTERACAO",
            "codigo": "COMUNICAR_SEST",
            "template": 'Novo texto com "aspas".',
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    lista = app_cliente.get("/catalogos/textos-padrao")
    assert "“aspas”" in lista.text


def test_saude_e_publica_mas_login_nao_vaza_usuario(app_cliente, contas):
    resposta = app_cliente.post("/login", data={"login": "inexistente", "senha": "x"})
    assert "Usuário ou senha inválidos" in resposta.text
    assert "inexistente" not in resposta.text.split("<title>")[1][:400]


def test_quem_sou_eu(app_cliente, contas):
    assert app_cliente.get("/quem-sou-eu").json() == {"autenticado": False}
    entrar(app_cliente, contas, "coordenador_csso")
    dados = app_cliente.get("/quem-sou-eu").json()
    assert dados["autenticado"] is True
    assert "parecer.assinar" in dados["permissoes"]


def test_sair_revoga_a_sessao(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.get("/sair", follow_redirects=False)
    resposta = app_cliente.get("/kanban", follow_redirects=False)
    assert resposta.status_code == 303
