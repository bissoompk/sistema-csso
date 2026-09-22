"""A fundação que EPI, Certificados e Acidentes precisam ter pronta antes.

Quatro peças compartilhadas, levantadas no `04_PLANO_CONSOLIDADO.md`. Todas têm
em comum o fato de ficarem caras depois: categoria de anexo obriga a reconstruir
uma tabela com dados, âncora de pendência obriga a backfill em tarefa já aberta,
e permissão errada só se descobre quando alguém reclama de tela vazia.
"""

from __future__ import annotations

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError

from app.modelos import Anexo, Pendencia
from app.servicos import anexos as servico_anexos, pendencias
from app.servicos.rbac import PermissaoNegada, UsuarioAtual
from testes.integracao import papeis
from testes.integracao.conftest import entrar


@pytest.fixture()
def coord(atores):
    return papeis.COORDENADOR


def _guardar(sessao, categoria: str, ator: UsuarioAtual):
    return servico_anexos.guardar(
        sessao,
        entidade="teste",
        entidade_id=1,
        nome_original=f"{categoria.lower()}.pdf",
        conteudo=categoria.encode(),
        mime_type="application/pdf",
        categoria=categoria,
        usuario=ator,
    )


# =====================================================================
# 1. `ck_anexo_cat` com as categorias dos três módulos, de uma vez (M2)
# =====================================================================
CATEGORIAS_NOVAS = (
    "MANUAL_EPI",
    "FICHA_EPI",
    "RUBRICA_INSTRUTOR",
    "LISTA_PRESENCA",
    "CERTIFICADO",
    "CAT_SP",
    "RELATORIO_INVESTIGACAO",
    "EVIDENCIA_ACIDENTE",
)


def test_as_oito_categorias_dos_modulos_estao_declaradas():
    for categoria in CATEGORIAS_NOVAS:
        assert categoria in servico_anexos.CATEGORIAS
    # a coluna é String(30): nome maior seria truncado em silêncio no PostgreSQL
    assert max(len(c) for c in servico_anexos.CATEGORIAS) <= 30


def test_a_lista_do_servico_e_a_check_do_banco_dizem_a_mesma_coisa():
    """Duas listas separadas é como `guardar` passaria a aceitar uma categoria
    que a constraint recusa — o erro apareceria no INSERT, não na validação."""
    texto = next(
        str(c.sqltext)
        for c in Anexo.__table__.constraints
        if getattr(c, "name", None) == "ck_anexo_cat"
    )
    for categoria in servico_anexos.CATEGORIAS:
        assert f"'{categoria}'" in texto
    # e nada a mais do lado da constraint
    assert texto.count("'") == 2 * len(servico_anexos.CATEGORIAS)


@pytest.mark.parametrize("categoria", CATEGORIAS_NOVAS)
def test_o_banco_aceita_cada_categoria_nova(sessao, coord, categoria):
    resultado = _guardar(sessao, categoria, coord)
    sessao.flush()
    assert resultado.anexo.id is not None
    assert resultado.anexo.categoria == categoria


def test_categoria_desconhecida_continua_recusada(sessao, coord):
    with pytest.raises(ValueError):
        _guardar(sessao, "CATEGORIA_INVENTADA", coord)


def test_nivel_de_acesso_de_quem_nomeia_pessoa_nasce_restrito(sessao, coord):
    """A ficha de EPI e a lista de presença dizem o que a pessoa fez e onde
    esteve; o manual do fabricante e a rubrica do instrutor não têm titular."""
    for categoria in ("FICHA_EPI", "LISTA_PRESENCA", "CERTIFICADO", "CAT_SP"):
        assert _guardar(sessao, categoria, coord).anexo.nivel_acesso == "RESTRITO"
    for categoria in ("MANUAL_EPI", "RUBRICA_INSTRUTOR"):
        assert _guardar(sessao, categoria, coord).anexo.nivel_acesso == "PUBLICO"


def test_a_tela_do_processo_so_oferece_o_que_e_do_processo(app_cliente, contas):
    """A CHECK aceita dezesseis categorias; o formulário do processo não pode
    oferecer 'ficha de EPI' num processo de adicional ocupacional."""
    assert set(servico_anexos.CATEGORIAS_PROCESSO).isdisjoint(CATEGORIAS_NOVAS)
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    corpo = app_cliente.get(criado.headers["location"] + "?aba=anexos").text
    assert "<option>FORMULARIO</option>" in corpo
    for categoria in CATEGORIAS_NOVAS:
        assert f"<option>{categoria}</option>" not in corpo


# =====================================================================
# 2. `pendencia.entidade` + `entidade_id` (M3)
# =====================================================================
def test_pendencia_ancora_em_entidade_que_nao_e_processo(sessao, coord):
    """`CA_A_VENCER` aponta para um lote de entrada de estoque, que não é
    processo, nem parecer, nem laudo. Sem isto a tela mostraria a descrição e
    não levaria a lugar nenhum."""
    pendencia = pendencias.abrir(
        s=sessao,
        tipo="CA_A_VENCER",
        chave="ca:entrada:7",
        descricao="CA do lote 7 vence em 60 dias",
        usuario=coord,
        entidade="epi_entrada_estoque",
        entidade_id=7,
    )
    sessao.flush()
    lida = sessao.get(Pendencia, pendencia.id)
    assert (lida.entidade, lida.entidade_id) == ("epi_entrada_estoque", 7)
    assert lida.processo_id is None


def test_pendencia_sem_ancora_continua_valendo(sessao, coord):
    pendencia = pendencias.abrir(
        s=sessao,
        tipo="INCLUIR_NO_SEI",
        chave="sem:ancora",
        descricao="incluir no SEI",
        usuario=coord,
    )
    sessao.flush()
    assert (pendencia.entidade, pendencia.entidade_id) == (None, None)


def test_meia_ancora_e_recusada_pelo_servico(sessao, coord):
    with pytest.raises(ValueError, match="andam juntos"):
        pendencias.abrir(
            s=sessao,
            tipo="CA_A_VENCER",
            chave="meia:1",
            descricao="x",
            usuario=coord,
            entidade="epi_entrada_estoque",
        )


def test_meia_ancora_e_recusada_pelo_banco(sessao, coord):
    """A validação do serviço é a primeira camada; a CHECK é a que vale mesmo
    quando alguém gravar direto pelo modelo."""
    sessao.add(
        Pendencia(
            tipo="CA_A_VENCER",
            chave="meia:2",
            descricao="x",
            entidade="epi_entrada_estoque",
            entidade_id=None,
        )
    )
    with pytest.raises(IntegrityError, match="ck_pendencia_entidade"):
        sessao.flush()
    sessao.rollback()


def test_o_indice_da_ancora_existe(sessao):
    """Sem índice, 'o que está pendente sobre este lote?' vira varredura de
    tabela — e é a pergunta que toda ficha de módulo vai fazer."""
    indices = sessao.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pendencia'")
    ).scalars()
    assert "ix_pendencia_entidade" in set(indices)


# =====================================================================
# 3. Quem abre e quem fecha /pendencias
# =====================================================================
def test_as_permissoes_declaradas_existem():
    from app.servicos.rbac import PERMISSOES

    for codigo in pendencias.PERMISSOES_VER + pendencias.PERMISSOES_CONCLUIR:
        assert codigo in PERMISSOES, codigo


def _com(*permissoes: str, id: int = 1) -> UsuarioAtual:
    return UsuarioAtual(
        id=id, login="x", nome="x", permissoes=frozenset(permissoes), perfis=()
    )


def test_quem_so_opera_treinamento_ve_as_pendencias():
    """O motivo da mudança: a rota exigia `processo.ver`, e quem recebe
    reciclagem de NR ou CA a vencer não tem essa permissão."""
    assert pendencias.pode_ver(_com("treinamento.ver"))
    assert pendencias.pode_ver(_com("processo.ver"))


def test_quem_nao_opera_modulo_nenhum_continua_de_fora():
    """`indicador.ver` e `auditoria.ver` são do admin de TI, que por decisão de
    projeto não vê conteúdo técnico. Abrir para 'qualquer permissão' o deixaria
    entrar — por isso a lista é explícita."""
    assert not pendencias.pode_ver(_com("indicador.ver", "auditoria.ver", "backup.executar"))
    assert not pendencias.pode_ver(None)
    with pytest.raises(PermissaoNegada):
        pendencias.exigir_ver(_com("indicador.ver"))


def test_o_dono_fecha_a_propria_pendencia_sem_permissao_de_escrita():
    dona = _com("treinamento.ver", id=42)
    minha = Pendencia(tipo="RECICLAGEM_TREINAMENTO", chave="r:1", descricao="x")
    minha.responsavel_id = 42
    assert pendencias.pode_concluir(dona, minha)

    de_outro = Pendencia(tipo="RECICLAGEM_TREINAMENTO", chave="r:2", descricao="x")
    de_outro.responsavel_id = 7
    assert not pendencias.pode_concluir(dona, de_outro)


def test_sem_dono_fecha_quem_escreve_no_modulo():
    orfa = Pendencia(tipo="INCLUIR_NO_SEI", chave="o:1", descricao="x")
    assert pendencias.pode_concluir(_com("processo.ver", "processo.editar"), orfa)
    assert pendencias.pode_concluir(_com("treinamento.ver", "treinamento.gerenciar"), orfa)
    assert not pendencias.pode_concluir(_com("treinamento.ver"), orfa)


def test_admin_ti_continua_sem_a_tela_e_sem_o_sino(app_cliente, contas):
    entrar(app_cliente, contas, "admin_ti")
    assert app_cliente.get("/pendencias").status_code == 403
    # o sino é um link para a tela: oferecê-lo seria a mesma mentira do menu
    assert 'class="sino' not in app_cliente.get("/modulos").text


def test_quem_le_mas_nao_escreve_fecha_a_pendencia_que_e_dele(app_cliente, contas, banco):
    """`consulta_progep` tem `processo.ver` e nenhuma permissão de escrita. A
    regra atribuiu a tarefa a ela; tarefa que o dono não consegue riscar da
    lista vira lista que ninguém lê."""
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        dona = s.execute(
            sa.select(Usuario).where(Usuario.login == "consulta_progep")
        ).scalar_one()
        outro = s.execute(
            sa.select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        minha = pendencias.abrir(
            s=s,
            tipo="REGISTRO_DE_OPCAO",
            chave="progep:minha",
            descricao="anexar o registro de opção",
            responsavel_id=dona.id,
        )
        alheia = pendencias.abrir(
            s=s,
            tipo="INCLUIR_NO_SEI",
            chave="progep:alheia",
            descricao="incluir no SEI",
            responsavel_id=outro.id,
        )
        s.commit()
        id_minha, id_alheia = minha.id, alheia.id

    entrar(app_cliente, contas, "consulta_progep")
    tela = app_cliente.get("/pendencias")
    assert tela.status_code == 200
    assert f'action="/pendencias/{id_minha}/concluir"' in tela.text
    assert f'action="/pendencias/{id_alheia}/concluir"' not in tela.text

    assert (
        app_cliente.post(f"/pendencias/{id_alheia}/concluir", follow_redirects=False).status_code
        == 403
    )
    assert (
        app_cliente.post(f"/pendencias/{id_minha}/concluir", follow_redirects=False).status_code
        == 303
    )
    with mod_banco.sessao() as s:
        assert s.get(Pendencia, id_minha).concluida
        assert not s.get(Pendencia, id_alheia).concluida


def test_a_ancora_aparece_na_tela_quando_nao_ha_processo(app_cliente, contas, banco):
    """A âncora vira link quando a tela existe, e texto quando ainda não existe.

    `epi_entrada_estoque` ganhou tela na fatia 3 do EPI e passou a ser link;
    `epi_requisicao` ganhou a dela na fatia 4 e passou a ser link com os avisos
    do requerente, que sem ele nasceriam apontando para lugar nenhum — era o que
    o mapa da tela sempre prometeu ("módulo novo acrescenta uma linha quando
    entregar a tela, e não antes").

    O outro lado da regra continua valendo, e é `epi_requisicao_item` que o
    sustenta: a linha do pedido é a âncora de `EPI_SEM_ESTOQUE` e **não** tem
    tela própria — o que existe é a ficha do pedido inteiro. Oferecer link para
    ela seria oferecer porta trancada, que é a mesma mentira do menu.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        pendencias.abrir(
            s=s,
            tipo="CA_A_VENCER",
            chave="ca:entrada:9",
            descricao="CA do lote 9 vence em 60 dias",
            entidade="epi_entrada_estoque",
            entidade_id=9,
        )
        pendencias.abrir(
            s=s,
            tipo="EPI_DECISAO_A_LER",
            chave="decisao:requisicao:7",
            descricao="o pedido EPI-2026-0007 foi decidido",
            entidade="epi_requisicao",
            entidade_id=7,
        )
        pendencias.abrir(
            s=s,
            tipo="EPI_SEM_ESTOQUE",
            chave="sem_estoque:requisicao_item:11",
            descricao="âncora de tabela que ainda não tem tela",
            entidade="epi_requisicao_item",
            entidade_id=11,
        )
        s.commit()

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/pendencias").text
    # as âncoras da fila carregam o caminho de volta (`?de=pendencias`)
    assert 'href="/epis/estoque/9/movimentos?de=pendencias"' in corpo
    assert 'href="/epis/requisicoes/7?de=pendencias"' in corpo
    assert "epi_requisicao_item #11" in corpo
