"""Os módulos do sistema: agrupamento, base compartilhada e o que vem depois."""

from __future__ import annotations

import re

import pytest

from app import modulos
from app.servicos.rbac import UsuarioAtual
from testes.integracao.conftest import entrar


def _usuario(*permissoes: str) -> UsuarioAtual:
    return UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset(permissoes), perfis=()
    )


def test_processos_sei_reune_o_fluxo_do_processo():
    modulo = modulos.por_codigo(modulos.PROCESSOS_SEI)
    caminhos = [item.caminho for item in modulo.itens]
    assert caminhos == [
        "/",
        "/kanban",
        "/processos",
        "/laudos",
        "/adicionais",
        "/relatorios",
        "/importar",
    ]
    assert modulo.disponivel


def test_a_base_fica_fora_dos_modulos():
    """Pendência, servidor, catálogo, auditoria e usuário são de todos os módulos.

    Se um dia caírem dentro de Processos SEI, o módulo de EPI vai precisar do
    próprio cadastro de servidor — e aí o mesmo SIAPE passa a existir duas vezes.
    """
    base = [item.caminho for item in modulos.BASE]
    assert base == [
        "/pendencias",
        # A demanda entra aqui, e não em Processos SEI: metade delas nunca vira
        # processo, e as que viram podem ser de qualquer módulo — EPI,
        # treinamento, adicional. Dentro de um módulo, o módulo seguinte
        # precisaria da sua própria lista de demandas.
        "/demandas",
        "/servidores",
        "/catalogos",
        "/auditoria",
        "/usuarios",
    ]
    de_modulos = {
        item.caminho for modulo in modulos.MODULOS for item in modulo.itens
    }
    assert de_modulos.isdisjoint(base)


def test_modulos_previstos_estao_declarados_e_marcados():
    previstos = {m.nome: m for m in modulos.MODULOS if not m.disponivel}
    assert set(previstos) == {
        "Análise de Acidentes",
        "CISSP",
        "PGR",
    }
    for modulo in previstos.values():
        assert modulo.itens == ()
        assert modulo.itens_previstos, f"{modulo.nome} sem nada declarado"


def test_modulo_entregue_por_fatias_declara_o_que_falta():
    """Certificados já está em uso, mas incompleto — e diz quais telas faltam.

    Módulo previsto aparece marcado desde sempre; módulo em uso pela metade
    tinha como esconder o que falta, e esconder é o que faz o usuário procurar
    uma tela que não existe.
    """
    certificados = modulos.por_codigo("certificados")
    assert certificados.disponivel
    assert certificados.itens
    assert certificados.itens_previstos


@pytest.mark.parametrize(
    "caminho",
    ["/", "/kanban", "/processos", "/processos/12", "/pareceres/3", "/laudos"],
)
def test_a_tela_do_fluxo_fica_dentro_do_modulo(caminho):
    """Abrir o editor do parecer não pode tirar você de Processos SEI."""
    assert modulos.modulo_ativo(caminho).codigo == modulos.PROCESSOS_SEI


@pytest.mark.parametrize(
    "caminho", ["/servidores", "/catalogos", "/usuarios", "/pendencias", "/demandas"]
)
def test_a_base_nao_pertence_a_modulo_nenhum(caminho):
    assert modulos.modulo_ativo(caminho) is None


def test_a_pendencia_e_da_base_e_nao_de_processos_sei():
    """A trilha de /pendencias dizia "Processos SEI", e isso deixou de ser verdade.

    Reciclagem de treinamento já cai no mesmo sino; EPI e acidentes vão cair. A
    tela é a mesma para todos, então o primeiro nível da trilha é "Base
    compartilhada" — quem dá esse nome é o item estar em `BASE`.
    """
    assert modulos.modulo_ativo("/pendencias") is None
    assert modulos.item_ativo("/pendencias").rotulo == "Pendências"
    assert modulos.item_ativo("/pendencias") in modulos.BASE
    # o editor do parecer continua sendo do módulo: ele é do processo, e só dele
    assert modulos.modulo_ativo("/pareceres/3").codigo == modulos.PROCESSOS_SEI


def test_quem_so_opera_treinamento_ve_a_pendencia_no_menu():
    """A permissão do item é a mesma lista que a rota exige (`PERMISSOES_VER`).

    Sem a tupla, o item exigiria `processo.ver` e sumiria justamente para quem
    recebe tarefa de reciclagem — que foi o motivo de a rota abrir para os dois.
    """
    so_treinamento = _usuario("treinamento.ver")
    assert [item.rotulo for item in modulos.base_de(so_treinamento)] == ["Pendências"]
    assert not modulos.base_de(_usuario("indicador.ver", "backup.executar"))


def test_o_menu_esconde_o_que_o_usuario_nao_pode_ver():
    so_processo = _usuario("processo.ver")
    modulo = modulos.por_codigo(modulos.PROCESSOS_SEI)
    rotulos = [item.rotulo for item in modulo.itens_de(so_processo)]
    assert "Laudos" not in rotulos  # exige laudo.ver
    assert "Importar" not in rotulos  # exige importacao.executar
    assert "Kanban" in rotulos
    # Catálogos abre em leitura para quem só consulta; Auditoria e Usuários não.
    # Pendências entra porque `processo.ver` é uma das permissões de leitura que
    # abrem a fila — a mesma que a rota aceita.
    assert [item.rotulo for item in modulos.base_de(so_processo)] == [
        "Pendências",
        "Servidores",
        "Catálogos",
    ]


def test_navegacao_na_base_nao_esvazia_a_barra():
    """Em /catalogos a lateral continua com um módulo: sair para a base não pode
    esvaziar a barra e deixar o usuário sem caminho de volta.

    Sem origem declarada o recuo é o primeiro módulo que ABRE para a pessoa —
    para quem tem `processo.ver` isso continua sendo Processos SEI, como sempre
    foi. O que mudou é o caso em que o padrão fixo mentia (logo abaixo).
    """
    nav = modulos.navegacao("/catalogos", _usuario("processo.ver", "catalogo.gerenciar"))
    assert nav["modulo_ativo"].codigo == modulos.PROCESSOS_SEI
    assert nav["itens_modulo"]
    # a tela é da base, e a lateral sabe disso: quem está fora do módulo não
    # recebe o destaque no bloco de cima
    assert nav["no_modulo"] is False


def test_a_base_preserva_o_modulo_de_onde_a_pessoa_veio():
    """Quem sai de /epis/fichas/12 para o cadastro do servidor não perde o EPI.

    Era o beco mais caro da lateral: `/servidores/{id}` trocava as oito telas de
    EPI por sete de Processos SEI que a pessoa não estava usando, e voltar
    custava três cliques. O caminho não pertence a módulo nenhum — a base é o
    chão que todos pisam —, então quem responde "qual módulo destacar" é a
    origem, e não um padrão fixo.
    """
    usuario = _usuario("processo.ver", "epi.ver", "epi.ficha")
    nav = modulos.navegacao("/servidores/12", usuario, origem="epis")
    assert nav["modulo_ativo"].codigo == "epis"
    assert "/epis/fichas" in [item.caminho for item in nav["itens_modulo"]]
    # e o destaque continua caindo na base, que é onde a pessoa está de fato
    assert nav["item_ativo"].caminho == "/servidores"
    assert nav["no_modulo"] is False


def test_o_caminho_manda_sobre_a_origem():
    """Origem é resposta para "de onde vim", não para "onde estou".

    Sem esta precedência o cookie sequestraria a lateral: quem viesse do EPI
    veria o menu de EPI dentro de /processos.
    """
    usuario = _usuario("processo.ver", "epi.ver")
    nav = modulos.navegacao("/processos", usuario, origem="epis")
    assert nav["modulo_ativo"].codigo == modulos.PROCESSOS_SEI
    assert nav["no_modulo"] is True
    assert nav["modulo_a_lembrar"] == modulos.PROCESSOS_SEI
    # a base não reescreve a origem: ela não é de módulo nenhum
    assert modulos.navegacao("/servidores", usuario)["modulo_a_lembrar"] is None


def test_o_almoxarife_na_base_nao_recebe_menu_em_branco():
    """O padrão fixo de Processos SEI criava o vazio que ele existia para evitar.

    Quem só tem `epi.ver` não abre nenhuma das sete telas de Processos SEI: a
    lateral exibia o seletor escrito "Processos SEI" sobre um menu vazio — um
    módulo nomeado do qual ele não abre uma única tela.
    """
    almoxarife = _usuario("epi.ver", "epi.estoque", "epi.entregar", "epi.ficha")
    nav = modulos.navegacao("/pendencias", almoxarife)
    assert nav["modulo_ativo"].codigo == "epis"
    assert nav["itens_modulo"], "a lateral do almoxarife ficou sem nenhuma tela"


def test_a_origem_so_vale_se_o_modulo_abrir_para_a_pessoa():
    """Cookie velho de quem perdeu a permissão não pode esvaziar a lateral."""
    almoxarife = _usuario("epi.ver", "epi.entregar", "epi.ficha")
    nav = modulos.navegacao("/pendencias", almoxarife, origem=modulos.PROCESSOS_SEI)
    assert nav["modulo_ativo"].codigo == "epis"
    assert nav["itens_modulo"]
    # e origem inventada não derruba a tela
    assert modulos.navegacao("/pendencias", almoxarife, origem="inexistente")["itens_modulo"]


def test_o_seletor_leva_a_primeira_tela_do_modulo():
    """"Trocar de módulo" tem de trocar de módulo, e não abrir o mapa.

    O link ia para `/modulos#codigo`: três cliques por alternância, e no meio do
    caminho o seletor continuava escrito com o nome do módulo antigo.
    """
    coordenador = _usuario("processo.ver", "epi.ver", "treinamento.ver")
    epis = modulos.por_codigo("epis")
    assert modulos.porta_de_entrada(epis, coordenador) == "/epis"
    # o almoxarife não abre `/epis` nem `/turmas`? abre `/epis`, e o módulo de
    # treinamento sem nenhuma tela visível recua para o mapa, que explica por quê
    almoxarife = _usuario("epi.ver", "epi.ficha")
    assert modulos.porta_de_entrada(epis, almoxarife) == "/epis"
    certificados = modulos.por_codigo("certificados")
    assert modulos.porta_de_entrada(certificados, almoxarife) == "/modulos#certificados"


def test_a_primeira_tela_e_a_do_modulo_que_abre_para_a_pessoa():
    """`/inicio` existe porque `/` é o painel de um módulo só."""
    assert modulos.primeira_tela(_usuario("processo.ver")) == "/"
    almoxarife = _usuario("epi.ver", "epi.estoque", "epi.entregar", "epi.ficha")
    assert modulos.primeira_tela(almoxarife) == "/epis"
    # quem só vê a fila de pendências cai nela; quem não vê nada cai no mapa,
    # que não exige permissão nenhuma — o mesmo recuo da tela de erro
    assert modulos.primeira_tela(_usuario("treinamento.ver")) == "/turmas"
    assert modulos.primeira_tela(_usuario("backup.executar")) == "/modulos"


# ---------------------------------------------------------------------
def test_barra_mostra_o_modulo_e_separa_a_base(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/processos").text
    assert "Processos SEI" in corpo
    assert 'class="menu menu-base"' in corpo
    assert "Gestão de EPI" in corpo  # previsto aparece no seletor, marcado
    assert "em breve" not in corpo.lower() or 'class="em-breve"' in corpo


def test_mapa_dos_modulos(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/modulos").text
    assert "Processos SEI" in corpo
    assert "Base compartilhada" in corpo
    for nome in (
        "Gestão de EPI",
        "Certificados e Treinamentos",
        "Análise de Acidentes",
        "CISSP",
        "PGR",
    ):
        assert nome in corpo
    assert "ainda não desenvolvido" in corpo


# O "/" entra na lista. Ele ficava de fora porque o href="/" da marca aparecia
# em toda pagina e o teste nao conseguia distinguir menu de logotipo — e o unico
# item fora do invariante era justamente o que o violava: `/` e o painel de
# Processos SEI, exige `processo.ver`, e a marca o oferecia ao almoxarife em toda
# tela. A marca agora aponta para `/inicio`, que e despachante e abre para
# qualquer sessao, entao `href="/"` voltou a ser so o item de menu.
TODOS_OS_ITENS = [i for m in modulos.MODULOS for i in m.itens] + list(modulos.BASE)


@pytest.mark.parametrize("item", TODOS_OS_ITENS, ids=lambda i: i.caminho)
@pytest.mark.parametrize(
    "perfil",
    [
        "coordenador_csso",
        "secretaria_csso",
        "admin_ti",
        "auditor_interno",
        # o almoxarife entrou na lista com a fatia 3 do EPI, e não por simetria:
        # ele é o primeiro perfil do sistema que opera um módulo sem ter
        # `processo.ver`. Onde os outros quatro veem a base inteira por causa
        # dela, ele vê exatamente o que o módulo de EPI lhe deu — que é a
        # condição em que uma permissão declarada errada no menu passa
        # despercebida.
        "almoxarife_sesmt",
        # O servidor comum entrou com a fatia da inscrição própria, e ele é o
        # perfil que este invariante mais precisava cobrir: é o único de escopo
        # PRÓPRIO, e a auditoria da jornada registrou que o menu dele nunca
        # tinha sido renderizado por teste nenhum. As três telas que existem
        # para ele — "Meus treinamentos", "Meus certificados" e "Minha ficha de
        # EPI" — declaram a permissão de leitura do módulo, e não a da lista
        # nominal ao lado; é exatamente a confusão que este teste pega.
        "servidor_consulta",
    ],
)
def test_link_no_menu_sempre_abre(app_cliente, contas, perfil, item):
    """A permissão declarada no menu tem que ser a mesma que a rota exige.

    Sem esta trava o menu mente nas duas direções: some com tela que a pessoa
    podia abrir (foi o que aconteceu com Relatórios e Importar, declarados com
    permissão inexistente) ou oferece porta trancada.
    """
    entrar(app_cliente, contas, perfil)
    aparece = f'href="{item.caminho}"' in app_cliente.get("/modulos").text
    abre = app_cliente.get(item.caminho).status_code != 403
    assert aparece == abre, f"{item.caminho} como {perfil}: menu={aparece}, rota={abre}"


@pytest.mark.parametrize(
    "perfil,negado",
    [
        ("secretaria_csso", "/auditoria"),
        ("admin_ti", "/catalogos"),
        ("admin_ti", "/processos"),
    ],
)
def test_mapa_nao_oferece_tela_que_o_usuario_nao_pode_abrir(
    app_cliente, contas, perfil, negado
):
    """O mapa não pode virar um catálogo de portas trancadas."""
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(negado).status_code == 403
    assert f'href="{negado}"' not in app_cliente.get("/modulos").text


# ---------------------------------------------------------------------
# A trilha, sob o mesmo invariante do menu
# ---------------------------------------------------------------------
def _links_da_trilha(html: str) -> list[str]:
    bloco = re.search(r'<nav class="trilha".*?</nav>', html, re.S)
    if bloco is None:
        return []
    return [
        destino
        for destino in re.findall(r'href="([^"]+)"', bloco.group(0))
        if destino.startswith("/")
    ]


# As telas com trilha de mais de um nível, que é onde o segundo nível é escrito
# à mão pelo template e escapa do filtro de permissão que `modulos.py` aplica.
TELAS_COM_TRILHA = (
    "/",
    "/kanban",
    "/processos",
    "/laudos",
    "/adicionais",
    "/relatorios",
    "/pendencias",
    "/demandas",
    "/servidores",
    "/servidores/{servidor}",
    "/catalogos",
    "/catalogos/cargos",
    "/auditoria",
    "/usuarios",
    "/perfis",
    "/config",
    "/modulos",
    "/buscar",
    "/epis",
    "/epis/requisicoes",
    "/epis/fichas",
    "/epis/fichas/{servidor}",
    "/epis/estoque",
    "/epis/catalogo",
    "/epis/catalogo/categorias",
    "/epis/relatorios",
    "/turmas",
    "/certificados",
    "/treinamentos/catalogo",
)


@pytest.mark.parametrize(
    "perfil",
    [
        "coordenador_csso",
        "secretaria_csso",
        "admin_ti",
        "auditor_interno",
        "almoxarife_sesmt",
    ],
)
def test_a_trilha_nunca_oferece_porta_trancada(app_cliente, contas, perfil):
    """O invariante do menu, cobrado também da trilha.

    `modulos.py` já filtra os dois primeiros níveis por permissão, e o comentário
    de `navegacao()` diz por quê: "a trilha não pode oferecer porta trancada,
    pela mesma razão do menu". O que escapava era o nível que **o template
    escreve à mão** no bloco `trilha` — e escapou de verdade: a ficha de EPI
    punha o cadastro do servidor na trilha, que exige `processo.ver`, para o
    almoxarife, que não tem. A tela central do trabalho dele oferecia 403 no nome
    da pessoa que ele estava atendendo.

    O teste percorre a trilha renderizada e cobra que cada link abra. É o que
    impede a reincidência: tela nova com trilha escrita à mão entra aqui pela
    lista, e link novo não precisa de nada.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/servidores",
        data={"siape": "1110654", "nome": "Marco Antônio Alves Schetino"},
        follow_redirects=False,
    )
    servidor = criado.headers["location"].rsplit("/", 1)[-1].split("?")[0]

    entrar(app_cliente, contas, perfil)
    visitadas = 0
    for molde in TELAS_COM_TRILHA:
        tela = molde.format(servidor=servidor)
        resposta = app_cliente.get(tela)
        if resposta.status_code != 200:
            continue
        visitadas += 1
        for destino in _links_da_trilha(resposta.text):
            assert app_cliente.get(destino).status_code != 403, (
                f"{tela} como {perfil}: a trilha oferece {destino}, que devolve 403"
            )
    assert visitadas, f"{perfil} não abriu nenhuma das telas com trilha"


def test_a_ficha_de_epi_nao_manda_o_almoxarife_para_o_403(app_cliente, contas):
    """O caso concreto que o invariante acima passou a cobrir.

    O nome do servidor continua na trilha e no cabeçalho — o almoxarife precisa
    saber a quem está entregando (é a razão de `epi.ficha` entrar em
    `ve_dado_nominal`). O que sai é o link, não a informação.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/servidores",
        data={"siape": "1110654", "nome": "Marco Antônio Alves Schetino"},
        follow_redirects=False,
    )
    servidor = criado.headers["location"].rsplit("/", 1)[-1].split("?")[0]

    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = app_cliente.get(f"/epis/fichas/{servidor}").text
    assert app_cliente.get(f"/servidores/{servidor}").status_code == 403
    assert f'href="/servidores/{servidor}"' not in corpo
    assert "Marco Antônio Alves Schetino" in corpo

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(f"/epis/fichas/{servidor}").text
    assert f'href="/servidores/{servidor}"' in corpo


# ---------------------------------------------------------------------
# A porta da frente
# ---------------------------------------------------------------------
@pytest.mark.parametrize(
    "perfil,destino",
    [
        ("coordenador_csso", "/"),
        ("almoxarife_sesmt", "/epis"),
        ("admin_ti", "/relatorios"),
    ],
)
def test_inicio_despacha_para_a_primeira_tela_que_abre(
    app_cliente, contas, perfil, destino
):
    """A porta da frente não pode ser a tela de um módulo só.

    O almoxarife trocava a senha provisória e recebia 403 na primeira tela do
    sistema, porque `/` é o painel de Processos SEI.
    """
    entrar(app_cliente, contas, perfil)
    resposta = app_cliente.get("/inicio", follow_redirects=False)
    assert resposta.status_code == 303
    assert resposta.headers["location"] == destino
    assert app_cliente.get(destino).status_code == 200


def test_a_marca_da_lateral_abre_para_todo_mundo(app_cliente, contas):
    """`<a class="marca">` é o "voltar ao começo" de toda tela, e era 403."""
    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = app_cliente.get("/epis").text
    assert 'class="marca" href="/inicio"' in corpo
    assert app_cliente.get("/inicio").status_code == 200


def test_login_leva_ao_despachante_e_nao_ao_painel(app_cliente, contas):
    login, senha = contas["almoxarife_sesmt"]
    resposta = app_cliente.post(
        "/login", data={"login": login, "senha": senha}, follow_redirects=False
    )
    assert resposta.headers["location"] == "/inicio"


# ---------------------------------------------------------------------
# /config tinha o backup e o SLA e nenhuma porta
# ---------------------------------------------------------------------
def test_config_tem_porta_e_ela_segue_a_permissao_da_rota(app_cliente, contas):
    """Nenhum template apontava para `/config`: só chegava quem digitasse a URL.

    A porta é a engrenagem do bloco do usuário, e a permissão é a mesma tupla que
    a rota exige (`PERMISSOES_CONFIG`) — o invariante do menu vale para ela do
    mesmo jeito, e nas duas direções.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/config").status_code == 200
    assert 'href="/config"' in app_cliente.get("/processos").text

    # quem faz backup alcança a tela do backup — e vê a engrenagem
    entrar(app_cliente, contas, "admin_ti")
    assert app_cliente.get("/config").status_code == 200
    assert 'href="/config"' in app_cliente.get("/relatorios").text

    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert app_cliente.get("/config").status_code == 403
    assert 'href="/config"' not in app_cliente.get("/epis").text


def test_config_reparte_o_que_e_processo_e_o_que_e_maquina(app_cliente, contas):
    """Abrir a rota não é abrir a tela inteira.

    `/config` guarda duas naturezas: parâmetro do processo (setor emissor
    congelado no parecer, autoridade destinatária, SLA das colunas) e operação da
    máquina (onde o dado mora, backup cifrado, exportação). O `admin_ti` existe
    para a segunda, e a base normativa do perfil — "sem acesso ao conteúdo
    técnico" — é a razão de a primeira continuar fechada para ele. Abrir demais é
    defeito do mesmo tamanho que trancar demais.
    """
    entrar(app_cliente, contas, "admin_ti")
    corpo = app_cliente.get("/config").text
    assert "Backup e exportação" in corpo
    assert "Onde o dado mora" in corpo
    assert "Setor emissor" not in corpo
    assert "SLA por coluna" not in corpo
    assert "Autoridade destinatária" not in corpo

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/config").text
    for bloco in ("Setor emissor", "SLA por coluna", "Onde o dado mora"):
        assert bloco in corpo, bloco


# ---------------------------------------------------------------------
# A busca global
# ---------------------------------------------------------------------
def test_a_busca_global_atravessa_o_sistema(app_cliente, contas):
    """A caixa despejava em `/processos` e só sabia achar processo.

    Quem procurava uma pessoa sem processo recebia lista vazia e concluía que ela
    não estava cadastrada; quem não tem `processo.ver` não tinha caixa nenhuma. A
    caixa agora vai para `/buscar`, e quem opera EPI tem `Ctrl+K`.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/processos").text
    assert 'action="/buscar"' in corpo
    assert 'id="busca-global"' in corpo

    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = app_cliente.get("/epis").text
    assert app_cliente.get("/processos").status_code == 403
    assert 'action="/buscar"' in corpo, "o almoxarife voltou a ficar sem Ctrl+K"
    assert app_cliente.get("/buscar").status_code == 200


def test_a_caixa_some_para_quem_nao_abre_bloco_nenhum(app_cliente, contas):
    """`admin_ti` é conta, senha, auditoria e backup — nenhum dos seis blocos.

    Campo de texto que aceita o que a pessoa digitou e nunca acha nada é a porta
    trancada do menu em outra forma, e mais lenta de descobrir: ela responde
    "nada encontrado" em vez de 403. A rota continua abrindo, e explica.
    """
    entrar(app_cliente, contas, "admin_ti")
    assert 'id="busca-global"' not in app_cliente.get("/relatorios").text
    resposta = app_cliente.get("/buscar")
    assert resposta.status_code == 200
    assert "Não há o que buscar" in resposta.text
