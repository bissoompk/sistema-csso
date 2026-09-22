"""Fatia 1 de Gestão de EPI: o catálogo, as categorias da NR-6 e as recusas.

O esquema inteiro do módulo (catálogo + estoque + ficha) nasce nesta fatia, por
causa do grafo de FK; as telas, não. Por isso este arquivo tem duas metades: as
telas do catálogo, e o esquema das tabelas que ainda não têm tela — que é
justamente onde um defeito passaria despercebido por dois meses.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from urllib.parse import unquote

import pytest
import sqlalchemy as sa
from sqlalchemy import select

from app import modulos
from app.modelos import EpiCategoria, EpiItem, EpiMotivoRecusa
from testes.integracao.conftest import entrar

CATALOGO = "/epis/catalogo"
CATEGORIAS = "/epis/catalogo/categorias"
MOTIVOS = "/epis/catalogo/motivos-recusa"

# O caso do levantamento: luva nitrílica, com CA, quantidade máxima por janela e
# justificativa exigida — as colunas que o formulário do legado não expunha.
LUVA = {
    "nome": "Luva de proteção química nitrílica",
    "descricao": "Luva para manipulação de ácidos e álcalis.",
    "codigo_catmat": "150011",
    "codigo_ecampus": "EC-9001",
    "fabricante": "Fabricante Exemplo Ltda",
    "marca": "Nitri",
    "modelo": "NX-200",
    "normas": "ABNT NBR 13697\nABNT NBR 13698",
    "exige_ca": "1",
    "numero_ca": "41234",
    "validade_ca": "2028-05-31",
    "unidade_medida": "PAR",
    "tamanhos": "P\nM\nG",
    "vida_util_meses": "6",
    "quantidade_padrao": "2",
    "quantidade_maxima": "6",
    "periodo_maximo_meses": "12",
    "exige_justificativa": "1",
    "exige_treinamento": "",
}


def _id_da_categoria(codigo: str = "PROT_MEMBROS_SUPERIORES") -> int:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return s.execute(
            select(EpiCategoria.id).where(EpiCategoria.codigo == codigo)
        ).scalar_one()


def _dados(**troca) -> dict:
    dados = dict(LUVA, categoria_id=str(_id_da_categoria()))
    dados.update({k: str(v) for k, v in troca.items()})
    return dados


def _cadastrar(cliente, **troca):
    return cliente.post(CATALOGO, data=_dados(**troca), follow_redirects=False)


def _itens() -> list[EpiItem]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return list(s.execute(select(EpiItem).order_by(EpiItem.id)).scalars())


def _recado(resposta) -> str:
    """A recusa do CADASTRO, lida de onde ela sai agora: o corpo da própria tela.

    O cadastro saiu do fim da lista e virou `<dialog>` (`ui.popup_cadastro`), e
    com isso a recusa deixou de redirecionar: ela RENDERIZA a tela de novo, com o
    popup reaberto e os vinte campos preenchidos. Redirecionar não tem como levar
    um dicionário, e era exatamente isso que fazia um "2 sem janela" apagar
    tamanhos, normas e descrição.

    A recusa da EDIÇÃO em linha continua vindo por `?erro=` no `Location` — lá a
    linha volta do banco intacta e não há digitado a preservar —, e por isso os
    dois caminhos continuam sendo lidos aqui.
    """
    if resposta.status_code == 303:
        # sem o `unquote`, "Já existe" nunca casa: o acento vai percentualmente
        # escapado no cabeçalho `Location`
        return unquote(resposta.headers["location"])
    return resposta.text


def _popups_abertos(resposta) -> list[str]:
    """Os `id` dos diálogos que voltaram com `open` escrito pelo servidor."""
    return re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", resposta.text)


# =====================================================================
# Catálogo de EPI
# =====================================================================
def test_cadastro_grava_as_colunas_que_governam_a_requisicao(app_cliente, contas, banco):
    """As colunas do legado que o formulário nunca expôs.

    `Qtd_Padrao`, `Qtd_Maxima`, `Exige_Justificativa` e a validade do CA
    existiam em `EPI_Cadastro` e não apareciam na tela — ou alguém editava a
    planilha à mão, ou a regra nunca rodou. Se elas voltarem a sumir do
    formulário, este teste é o que percebe.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    assert _cadastrar(app_cliente).status_code == 303

    item = _itens()[0]
    assert item.quantidade_padrao == 2
    assert item.quantidade_maxima == 6
    assert item.periodo_maximo_meses == 12
    assert item.exige_justificativa
    assert item.validade_ca == date(2028, 5, 31)
    assert item.numero_ca == "41234"
    assert item.vida_util_meses == 6
    assert item.lista_de_tamanhos == ["P", "M", "G"]
    assert item.lista_de_normas == ["ABNT NBR 13697", "ABNT NBR 13698"]


def test_a_tela_mostra_a_validade_do_ca(app_cliente, contas, banco):
    """A única coluna do módulo com consequência jurídica direta.

    Pela NR-6 o CA é o que constitui o equipamento como EPI. No legado ela
    estava no modelo e não estava no formulário; aqui ela precisa aparecer na
    lista, com o estado calculado, desde a primeira entrega.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    vencido = (date.today() - timedelta(days=1)).isoformat()
    _cadastrar(app_cliente, validade_ca=vencido)

    corpo = app_cliente.get(CATALOGO).text
    assert "CA vencido" in corpo
    assert "41234" in corpo


def test_maxima_sem_janela_e_recusada(app_cliente, contas, banco):
    """RN-26: "2 por ano" é regra, "2" sozinho não quer dizer nada.

    Sem a janela, ninguém sabe aplicar o máximo — e a regra vira um número que
    cada analista interpreta de um jeito.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _cadastrar(app_cliente, periodo_maximo_meses="")
    # 200, e não 303: a recusa do cadastro devolve a tela com o popup reaberto —
    # redirecionar não tem como carregar os vinte campos de volta
    assert resposta.status_code == 200
    assert "andam juntos" in _recado(resposta)
    assert _popups_abertos(resposta) == ["novo-epi"]
    # e o que foi digitado voltou, inclusive o que custa a redigitar
    assert 'value="41234"' in resposta.text
    assert "ABNT NBR 13697" in resposta.text
    assert _itens() == []


def test_maxima_menor_que_a_padrao_e_recusada(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _cadastrar(app_cliente, quantidade_padrao="4", quantidade_maxima="2")
    assert "não pode ser menor" in _recado(resposta)
    assert _itens() == []


def test_item_que_exige_ca_sem_numero_de_ca_e_recusado(app_cliente, contas, banco):
    """RN-25 começa no cadastro: "não sei" não é "está válido".

    Item marcado como "exige CA" e sem número de CA é item que a entrega não
    tem como conferir — e o erro apareceria só na hora de entregar.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _cadastrar(app_cliente, numero_ca="")
    assert "número do CA" in _recado(resposta)
    assert _itens() == []


def test_o_mesmo_nome_com_outro_modelo_e_outro_item(app_cliente, contas, banco):
    """`uq_epi_item` é (nome, modelo): é o modelo que distingue duas botas.

    E o par repetido é recusado ANTES do banco, inclusive quando o modelo é
    vazio — `NULL` não colide com `NULL` no índice único, então duas linhas
    para a mesma bota passariam.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    assert _cadastrar(app_cliente, modelo="").status_code == 303
    repetido = _cadastrar(app_cliente, modelo="")
    assert "Já existe" in _recado(repetido)
    assert len(_itens()) == 1

    assert _cadastrar(app_cliente, modelo="NX-300").status_code == 303
    assert len(_itens()) == 2


def test_edicao_registra_o_diff_na_auditoria(app_cliente, contas, banco):
    """Renomear é seguro para o que já saiu — a ficha congela o nome do dia da
    entrega —, mas tem de ficar registrado quem mudou o quê."""
    from app import banco as mod_banco
    from app.modelos import HistoricoEvento

    entrar(app_cliente, contas, "coordenador_csso")
    _cadastrar(app_cliente)
    item = _itens()[0]

    resposta = app_cliente.post(
        f"{CATALOGO}/{item.id}",
        data=_dados(nome="Luva nitrílica (corrigido)", ativo="1"),
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert _itens()[0].nome == "Luva nitrílica (corrigido)"

    with mod_banco.sessao() as s:
        eventos = list(
            s.execute(
                select(HistoricoEvento).where(HistoricoEvento.entidade == "epi_item")
            ).scalars()
        )
    assert "nome" in {e.campo for e in eventos}
    assert any(e.tipo_evento == "EPI_ITEM_CRIADO" for e in eventos)


def test_quantidade_vai_para_a_trilha_como_numero(app_cliente, contas, banco):
    """A trava da auditoria recusa valor que não volta igual do banco.

    Gravar `"6"` onde o valor é `6` faria o digest do evento ser calculado sobre
    uma coisa e conferido sobre outra — e a cadeia acusaria adulteração onde
    ninguém tocou em nada.
    """
    from app import banco as mod_banco
    from app.modelos import HistoricoEvento
    from app.servicos.auditoria import cadeia_integra

    entrar(app_cliente, contas, "coordenador_csso")
    _cadastrar(app_cliente)
    item = _itens()[0]
    app_cliente.post(
        f"{CATALOGO}/{item.id}",
        data=_dados(quantidade_maxima="8", ativo="1"),
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        evento = (
            s.execute(
                select(HistoricoEvento)
                .where(HistoricoEvento.campo == "quantidade_maxima")
                .order_by(HistoricoEvento.id.desc())
            )
            .scalars()
            .first()
        )
        assert evento is not None
        assert evento.valor_novo == 8 and isinstance(evento.valor_novo, int)
        assert cadeia_integra(s) == (True, None)


# =====================================================================
# Categorias da NR-6
# =====================================================================
def test_as_nove_categorias_da_nr6_estao_semeadas(sessao):
    """No legado a categoria era texto livre, e a mesma tela mostrava quatro
    grafias de uma lista que a norma fecha em nove."""
    categorias = list(
        sessao.execute(select(EpiCategoria).order_by(EpiCategoria.ordem)).scalars()
    )
    assert [c.codigo for c in categorias] == [
        "PROT_CABECA",
        "PROT_OLHOS_FACE",
        "PROT_AUDITIVA",
        "PROT_RESPIRATORIA",
        "PROT_TRONCO",
        "PROT_MEMBROS_SUPERIORES",
        "PROT_MEMBROS_INFERIORES",
        "PROT_CORPO_INTEIRO",
        "PROT_QUEDAS_DESNIVEL",
    ]
    assert [c.referencia_nr6 for c in categorias] == list("ABCDEFGHI")


def test_categoria_nao_se_cadastra_pela_tela(app_cliente, contas, banco):
    """A lista é o Anexo I da NR-6: criar a décima seria inventar norma.

    Mesmo critério de `/catalogos/percentuais` e `/catalogos/tipos-risco`, que
    também só editam o que os seeds trouxeram.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    tela = app_cliente.get(CATEGORIAS)
    assert f'action="{CATEGORIAS}"' not in tela.text
    app_cliente.post(CATEGORIAS, data={"nome": "Inventada", "ordem": "10"})
    with mod_banco.sessao() as s:
        assert s.execute(sa.select(sa.func.count()).select_from(EpiCategoria)).scalar_one() == 9


def test_categoria_edita_rotulo_e_ordem(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    alvo = _id_da_categoria("PROT_AUDITIVA")
    resposta = app_cliente.post(
        f"{CATEGORIAS}/{alvo}",
        data={
            "nome": "Proteção dos ouvidos",
            "referencia_nr6": "C",
            "ordem": "3",
            "ativo": "1",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        assert s.get(EpiCategoria, alvo).nome == "Proteção dos ouvidos"


def test_a_tela_conta_os_itens_de_cada_categoria(app_cliente, contas, banco):
    """Desativar categoria em uso esconde o item do formulário; quem edita
    precisa saber disso antes de clicar."""
    entrar(app_cliente, contas, "coordenador_csso")
    _cadastrar(app_cliente)
    corpo = app_cliente.get(CATEGORIAS).text
    assert "Proteção dos membros superiores" in corpo
    assert "Anexo I da NR-6" in corpo


# =====================================================================
# Motivos de recusa
# =====================================================================
def test_o_motivo_de_vinculo_encaminha_alem_de_negar(sessao):
    """A decisão 3 virando comportamento de sistema, e não ausência de cadastro.

    A negativa não é só um "não": ela diz que o pedido vai à contratante e que a
    fiscalização do contrato pode ser acionada. Sem esse período, quem recebe
    fica sem saber o que fazer e a fiscalização não fica sabendo do caso.
    """
    motivo = sessao.execute(
        select(EpiMotivoRecusa).where(EpiMotivoRecusa.codigo == "VINCULO_NAO_ATENDIDO")
    ).scalar_one()
    assert motivo.base_normativa == "NR-6"
    assert "obrigação do empregador" in motivo.texto
    assert "empresa contratante" in motivo.texto
    assert "fiscalização do contrato" in motivo.texto


def test_os_oito_motivos_estao_semeados_e_so_um_exige_complemento(sessao):
    motivos = {m.codigo: m for m in sessao.execute(select(EpiMotivoRecusa)).scalars()}
    assert set(motivos) == {
        "VINCULO_NAO_ATENDIDO",
        "SEM_EXPOSICAO",
        "EPI_INADEQUADO",
        "SEM_TREINAMENTO",
        "DENTRO_DA_VIDA_UTIL",
        "ACIMA_DO_MAXIMO",
        "COMPETENCIA_DE_ENSINO",
        "OUTRO",
    }
    assert [c for c, m in motivos.items() if m.exige_complemento] == ["OUTRO"]
    # texto vazio faria a negativa sair em branco para quem pediu
    assert all(m.texto.strip() for m in motivos.values())


def test_motivo_novo_e_editado_sem_versionar(app_cliente, contas, banco):
    """Editar o catálogo não reescreve negativa já emitida — quem garante isso é
    `texto_recusa_snapshot` (RN-27), congelado no ato da decisão.

    Por isso a edição é direta e não versionada como `/catalogos/textos-padrao`:
    `codigo` é único, e duas garantias para o mesmo fato é como uma delas deixa
    de valer.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        MOTIVOS,
        data={
            "codigo": "sem estoque previsto",
            "rotulo": "Sem previsão de estoque",
            "texto": "O item não tem previsão de compra no exercício.",
            "base_normativa": "",
            "exige_complemento": "1",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        novo = s.execute(
            select(EpiMotivoRecusa).where(
                EpiMotivoRecusa.codigo == "SEM_ESTOQUE_PREVISTO"
            )
        ).scalar_one()
        alvo, antes = novo.id, novo.texto

    app_cliente.post(
        f"{MOTIVOS}/{alvo}",
        data={
            "rotulo": "Sem previsão de estoque",
            "texto": "O item não tem previsão de compra neste exercício.",
            "base_normativa": "Lei 14.133/2021",
            "exige_complemento": "1",
            "ativo": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        # continua sendo UMA linha: editar não cria versão
        linhas = list(
            s.execute(
                select(EpiMotivoRecusa).where(
                    EpiMotivoRecusa.codigo == "SEM_ESTOQUE_PREVISTO"
                )
            ).scalars()
        )
        assert len(linhas) == 1
        assert linhas[0].texto != antes
        assert linhas[0].dispositivo_conferido_em == date.today()


def test_motivo_com_codigo_repetido_e_recusado(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        MOTIVOS,
        data={"codigo": "OUTRO", "rotulo": "Outro", "texto": "x"},
        follow_redirects=False,
    )
    assert "Já existe" in _recado(resposta)
    assert _popups_abertos(resposta) == ["novo-motivo"]
    # o texto da negativa é o campo caro desta tela, e ele volta
    assert ">x</textarea>" in resposta.text


# =====================================================================
# Permissões
# =====================================================================
def test_quem_so_consulta_ve_o_catalogo_mas_nao_edita(app_cliente, contas, banco):
    """`epi.catalogo` é separada de `catalogo.gerenciar` de propósito: quem
    cadastra bota não precisa das fundamentações legais do parecer."""
    entrar(app_cliente, contas, "coordenador_csso")
    _cadastrar(app_cliente)
    app_cliente.get("/sair")

    entrar(app_cliente, contas, "consulta_progep")
    tela = app_cliente.get(CATALOGO)
    assert tela.status_code == 200
    assert "somente leitura" in tela.text
    assert f'action="{CATALOGO}/' not in tela.text
    assert _cadastrar(app_cliente).status_code == 403


@pytest.mark.parametrize(
    "perfil,esperado",
    [
        ("coordenador_csso", 200),
        ("engenheiro_seguranca", 200),
        ("medico_trabalho", 200),
        ("tecnico_seguranca", 200),
        ("secretaria_csso", 200),
        ("auditor_interno", 200),
        ("servidor_consulta", 200),
        ("admin_ti", 403),
    ],
)
@pytest.mark.parametrize("caminho", [CATALOGO, CATEGORIAS, MOTIVOS])
def test_permissao_das_telas(app_cliente, contas, perfil, caminho, esperado):
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(caminho).status_code == esperado


def test_quem_mantem_o_catalogo_e_quem_so_o_consulta(app_cliente, contas, banco):
    """A matriz do §8: o técnico de segurança e o almoxarifado mantêm o
    catálogo de EPI; o médico do trabalho consulta e não cadastra CA."""
    entrar(app_cliente, contas, "tecnico_seguranca")
    assert _cadastrar(app_cliente).status_code == 303

    entrar(app_cliente, contas, "medico_trabalho")
    assert app_cliente.get(CATALOGO).status_code == 200
    assert _cadastrar(app_cliente, nome="Outra luva").status_code == 403


def test_permissoes_novas_nascem_no_modulo_epi(sessao):
    """`Permissao.modulo` semeada errada só sai com migração de dados."""
    from app.modelos import Permissao

    for codigo in ("epi.ver", "epi.catalogo"):
        permissao = sessao.execute(
            select(Permissao).where(Permissao.codigo == codigo)
        ).scalar_one()
        assert permissao.modulo == "EPI"


def test_as_seis_permissoes_do_modulo_entraram_cada_uma_na_sua_fatia():
    """`semear_rbac` nunca REMOVE permissão de perfil: semear cedo é conceder
    acesso que só sai por SQL manual.

    `epi.ver` e `epi.catalogo` nasceram na fatia 1; `epi.entregar` e `epi.ficha`
    na fatia 2; `epi.estoque` na 3; `epi.requisitar` e `epi.analisar` na 4, que
    é a que as usa. Com a última fatia do §8 entregue, a lista fecha — e este
    teste passa a guardar o outro lado: permissão de EPI inventada fora do §8
    não entra sem alguém discutir para que ela serve.
    """
    from app.servicos.rbac import PERMISSOES

    do_modulo = {c for c in PERMISSOES if c.startswith("epi.")}
    assert do_modulo == {
        "epi.ver",
        "epi.catalogo",
        "epi.entregar",
        "epi.ficha",
        "epi.estoque",
        "epi.requisitar",
        "epi.analisar",
    }


# =====================================================================
# O módulo no menu e no mapa
# =====================================================================
def test_modulo_declara_as_telas_que_existem():
    modulo = modulos.por_codigo("epis")
    assert modulo.disponivel
    assert [(i.caminho, i.permissao) for i in modulo.itens] == [
        # a fatia 7 abriu o painel do módulo, que a §9 pedia desde sempre e que
        # nunca existiu: ele é `epi.ver`, como a fila e o estoque
        ("/epis", "epi.ver"),
        # a fatia 4 promoveu a requisição de `itens_previstos` a duas telas de
        # verdade: a fila abre para quem lê o módulo, e abrir pedido pede
        # `epi.requisitar` — que é exatamente o que a rota exige
        ("/epis/requisicoes", "epi.ver"),
        ("/epis/requisicoes/nova", "epi.requisitar"),
        # a porta do titular para o que é dele: `epi.ver`, que é o que
        # `epi_ficha.exigir_leitura_da_ficha` exige de quem lê a PRÓPRIA ficha.
        # Ela vem antes de "Fichas de EPI" no menu de propósito — quem tem as
        # duas lê primeiro a sua, e quem só tem esta não vê a outra.
        ("/epis/fichas/minha", "epi.ver"),
        ("/epis/fichas", "epi.ficha"),
        ("/epis/entregas/nova", "epi.entregar"),
        ("/epis/estoque", "epi.ver"),
        (CATALOGO, "epi.ver"),
        # `indicador.ver` e não `epi.ver`: é o que o §9 declara e o que a rota
        # exige. O almoxarife opera o módulo inteiro e NÃO tem esta permissão —
        # é ele quem prova a diferença em `test_link_no_menu_sempre_abre`.
        ("/epis/relatorios", "indicador.ver"),
    ]
    # a última fatia esvaziou a lista: as três telas que faltavam existem, e
    # declarar como previsto o que já chegou é a mesma mentira ao contrário
    assert modulo.itens_previstos == ()


@pytest.mark.parametrize("caminho", [CATALOGO, CATEGORIAS, MOTIVOS])
def test_a_tela_do_catalogo_marca_o_modulo(caminho):
    assert modulos.modulo_ativo(caminho).codigo == "epis"
    assert modulos.item_ativo(caminho).caminho == CATALOGO


def test_menu_e_mapa_mostram_o_modulo(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    mapa = app_cliente.get("/modulos").text
    assert "Gestão de EPI" in mapa
    assert f'href="{CATALOGO}"' in mapa


# =====================================================================
# O esquema — as tabelas que ainda não têm tela
# =====================================================================
TABELAS_DO_MODULO = (
    "epi_categoria",
    "epi_motivo_recusa",
    "epi_item",
    "epi_entrada_estoque",
    "epi_ficha_registro",
    "epi_movimento_estoque",
)


def test_as_seis_tabelas_nascem_juntas(banco):
    """Migração não é fatia: as telas saem em três entregas, o esquema não pode.

    `epi_ficha_registro` aponta para `epi_entrada_estoque`; criada sozinha na
    fatia da ficha, ela referenciaria tabela inexistente — e o SQLite aceita o
    `CREATE TABLE`, e o `foreign_key_check` do `env.py` não pega porque a tabela
    está vazia. O erro apareceria no primeiro registro de entrega.
    """
    existentes = set(sa.inspect(banco).get_table_names())
    assert set(TABELAS_DO_MODULO) <= existentes


@pytest.mark.parametrize("tabela", TABELAS_DO_MODULO)
def test_nao_ha_coluna_de_cpf_em_nenhuma_tabela_nova(banco, tabela):
    """Decisão 1. No IntegraSST o CPF é login, chave de três abas e campo de
    busca de `EPI_REQUISICOES` — nada disso vem junto."""
    for coluna in sa.inspect(banco).get_columns(tabela):
        assert "cpf" not in coluna["name"].lower().split("_")


@pytest.mark.parametrize("tabela", ["epi_ficha_registro", "epi_movimento_estoque"])
def test_requisicao_item_id_ja_e_chave_estrangeira(banco, tabela):
    """A promessa da fatia 2, cumprida na fatia 4.

    As duas colunas nasceram `Integer` sem FK porque `epi_requisicao_item` não
    existia, e declará-la antes seria escrever no esquema uma promessa que o
    banco não consegue cobrar — o SQLite aceitaria a referência calada até a
    primeira gravação, que é justamente a linha da entrega. Com a tabela
    criada, a FK entrou (`c1d9e47a2b30`).

    Este teste é a trava contra a regressão silenciosa: a migração usa
    `batch_alter_table`, que reconstrói as duas tabelas append-only, e uma
    reconstrução mal feita perderia a FK sem erro nenhum.
    """
    inspetor = sa.inspect(banco)
    colunas = {c["name"] for c in inspetor.get_columns(tabela)}
    assert "requisicao_item_id" in colunas
    alvo = {
        fk["referred_table"]
        for fk in inspetor.get_foreign_keys(tabela)
        if "requisicao_item_id" in fk["constrained_columns"]
    }
    assert alvo == {"epi_requisicao_item"}


def test_a_janela_da_quantidade_maxima_e_cobrada_pelo_banco(sessao):
    """A guarda da tela é a primeira camada; a CHECK é a que vale mesmo quando
    alguém gravar direto pelo modelo."""
    categoria = sessao.execute(select(EpiCategoria)).scalars().first()
    sessao.add(
        EpiItem(
            nome="Bota sem janela",
            categoria_id=categoria.id,
            exige_ca=False,
            quantidade_padrao=1,
            quantidade_maxima=3,
            periodo_maximo_meses=None,
        )
    )
    with pytest.raises(Exception, match="ck_epi_janela"):
        sessao.flush()
    sessao.rollback()


def _ficha_de_teste(sessao, atores) -> int:
    """Uma linha de entrega mínima, para exercitar a trava append-only."""
    from app.modelos import Cargo, EpiFichaRegistro, Servidor, UnidadeUorg

    categoria = sessao.execute(
        select(EpiCategoria).where(EpiCategoria.codigo == "PROT_CABECA")
    ).scalar_one()
    item = EpiItem(
        nome="Capacete de segurança",
        categoria_id=categoria.id,
        exige_ca=True,
        numero_ca="31000",
        quantidade_padrao=1,
    )
    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    cargo = sessao.execute(select(Cargo)).scalars().first()
    servidor = Servidor(
        siape="1234567",
        nome="Servidor de Teste do EPI",
        cargo_id=cargo.id,
        unidade_uorg_id=unidade.id,
    )
    sessao.add_all([item, servidor])
    sessao.flush()
    registro = EpiFichaRegistro(
        servidor_id=servidor.id,
        epi_item_id=item.id,
        tipo="ENTREGA",
        quantidade=1,
        data_evento=date.today(),
        nome_epi_snapshot=item.nome,
        categoria_snapshot=categoria.nome,
        numero_ca_snapshot=item.numero_ca,
        nome_servidor_snapshot=servidor.nome,
        siape_snapshot=servidor.siape,
        entregue_por=atores["coord"].id,
    )
    sessao.add(registro)
    sessao.flush()
    sessao.commit()
    return registro.id


def test_a_ficha_de_epi_e_append_only(sessao, atores):
    """RN-31 e CA-16: a ficha vale como prova, e prova que se edita não é prova.

    Correção é linha nova de tipo `ESTORNO` apontando para a errada, com motivo
    — nunca rasura. A trava nasce com o esquema, e não com a tela que escreve
    nela: uma tabela append-only que passa um mês aceitando `UPDATE` é uma
    tabela cujo histórico ninguém consegue mais afirmar que está intacto.
    """
    registro_id = _ficha_de_teste(sessao, atores)

    with pytest.raises(Exception) as erro:
        sessao.execute(
            sa.text("UPDATE epi_ficha_registro SET quantidade=9 WHERE id=:i"),
            {"i": registro_id},
        )
    assert "append-only" in str(erro.value)
    sessao.rollback()

    with pytest.raises(Exception) as erro_delete:
        sessao.execute(
            sa.text("DELETE FROM epi_ficha_registro WHERE id=:i"), {"i": registro_id}
        )
    assert "append-only" in str(erro_delete.value)
    sessao.rollback()


def test_o_razao_do_estoque_e_append_only(sessao, atores):
    """Saldo é soma de movimentos, não célula que se sobrescreve.

    No legado `Qtd_Estoque` era coluna mutável: duas entregas simultâneas
    perdiam uma, e não havia como reconciliar depois porque não sobrava rastro
    do que baixou.
    """
    from app.modelos import EpiEntradaEstoque, EpiMovimentoEstoque

    registro_id = _ficha_de_teste(sessao, atores)
    item = sessao.execute(select(EpiItem)).scalars().first()
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id,
        data_entrada=date.today(),
        quantidade_recebida=10,
        empenho="2026NE000123",
    )
    sessao.add(entrada)
    sessao.flush()
    movimento = EpiMovimentoEstoque(
        entrada_id=entrada.id,
        tipo="SAIDA",
        quantidade=-1,
        ficha_registro_id=registro_id,
    )
    sessao.add(movimento)
    sessao.flush()
    sessao.commit()

    with pytest.raises(Exception) as erro:
        sessao.execute(
            sa.text("UPDATE epi_movimento_estoque SET quantidade=-5 WHERE id=:i"),
            {"i": movimento.id},
        )
    assert "append-only" in str(erro.value)
    sessao.rollback()


def test_o_sinal_do_movimento_segue_o_tipo(sessao):
    """Entrada positiva, saída negativa: sem isso, `SUM(quantidade)` deixa de
    ser o saldo e vira um número que não quer dizer nada."""
    from app.modelos import EpiEntradaEstoque, EpiMovimentoEstoque

    categoria = sessao.execute(select(EpiCategoria)).scalars().first()
    item = EpiItem(
        nome="Protetor auricular",
        categoria_id=categoria.id,
        exige_ca=False,
        quantidade_padrao=1,
    )
    sessao.add(item)
    sessao.flush()
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id, data_entrada=date.today(), quantidade_recebida=5
    )
    sessao.add(entrada)
    sessao.flush()
    sessao.add(EpiMovimentoEstoque(entrada_id=entrada.id, tipo="SAIDA", quantidade=3))
    with pytest.raises(Exception, match="ck_mov_sinal"):
        sessao.flush()
    sessao.rollback()
