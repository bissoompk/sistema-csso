"""Cobertura dos servicos de apoio: datas, RBAC, SEI, numeracao e auditoria."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from app.servicos import datas_br, sei
from app.servicos.rbac import (
    ESCOPO_PROPRIO,
    ESCOPO_TOTAL,
    ESCOPO_UNIDADE,
    MATRIZ_PERFIS,
    PERMISSOES,
    PermissaoNegada,
    UsuarioAtual,
)


# ---------------------------------------------------------------------
# datas_br
# ---------------------------------------------------------------------
def test_por_extenso_cidade():
    assert (
        datas_br.por_extenso_cidade("Diamantina", date(2025, 2, 11))
        == "Diamantina, 11 de fevereiro de 2025"
    )


def test_indice_mes_aceita_acento_e_caixa():
    assert datas_br.indice_mes("MARÇO") == 3
    assert datas_br.indice_mes("marco") == 3
    assert datas_br.indice_mes("brumário") is None


def test_analisar_aceita_date_e_datetime():
    assert datas_br.analisar(date(2026, 1, 2)) == date(2026, 1, 2)
    assert datas_br.analisar(datetime(2026, 1, 2, 15, 30)) == date(2026, 1, 2)
    assert datas_br.analisar(None) is None
    assert datas_br.analisar("  ") is None


def test_data_de_planilha_com_texto_e_none():
    assert datas_br.data_de_planilha(None) is None
    assert datas_br.data_de_planilha("11/02/2026") == date(2026, 2, 11)
    assert datas_br.data_de_planilha(date(2026, 2, 11)) == date(2026, 2, 11)


def test_local_e_formatado():
    momento = datetime(2026, 6, 18, 15, 0, tzinfo=timezone.utc)
    local = datas_br.local(momento)
    assert local is not None and local.utcoffset() != timedelta(0)
    assert datas_br.local_formatado(momento).endswith(("12:00", "11:00"))
    assert datas_br.local_formatado(None) == ""
    assert datas_br.local(None) is None
    assert len(datas_br.local_formatado(momento, com_hora=False)) == 10


def test_local_assume_utc_quando_ingenuo():
    ingenuo = datetime(2026, 6, 18, 15, 0)
    assert datas_br.local(ingenuo) is not None


def test_dias_desde():
    agora = datetime(2026, 6, 18, tzinfo=timezone.utc)
    assert datas_br.dias_desde(None) == 0
    assert datas_br.dias_desde(agora - timedelta(days=7), agora) == 7
    assert datas_br.dias_desde(agora + timedelta(days=3), agora) == 0
    assert datas_br.dias_desde(datetime(2026, 6, 11), agora) == 7


# ---------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------
def _usuario(perfil: str, **extra) -> UsuarioAtual:
    return UsuarioAtual(
        id=1,
        login=perfil,
        nome=perfil,
        permissoes=frozenset(MATRIZ_PERFIS[perfil]["permissoes"]),
        perfis=(perfil,),
        **extra,
    )


def test_toda_permissao_da_matriz_existe():
    for codigo, dados in MATRIZ_PERFIS.items():
        for permissao in dados["permissoes"]:
            assert permissao in PERMISSOES, f"{codigo}: {permissao}"


def test_admin_ti_nao_ve_conteudo_tecnico():
    admin = _usuario("admin_ti")
    for negada in ("processo.ver", "parecer.ver", "parecer.assinar", "exposicao.ver"):
        assert not admin.pode(negada)
    assert admin.pode("backup.executar")
    assert admin.pode("usuario.resetar_senha")


def test_tecnica_emite_mas_nao_assina():
    tecnica = _usuario("tecnico_seguranca")
    assert tecnica.pode("parecer.emitir")
    assert tecnica.pode("processo.status")
    assert not tecnica.pode("parecer.assinar")
    assert not tecnica.pode("laudo.criar")
    with pytest.raises(PermissaoNegada):
        tecnica.exigir("parecer.assinar")


def test_secretaria_nao_ve_exposicao():
    secretaria = _usuario("secretaria_csso")
    assert secretaria.pode("processo.criar")
    assert not secretaria.ve_dado_nominal


def test_superintendente_governa_acesso_mas_nao_assina():
    chefe = _usuario("superintendente")
    assert chefe.pode("perfil.conceder")
    assert chefe.pode("habilitacao.atestar")
    assert not chefe.pode("parecer.assinar")
    assert not chefe.pode("processo.criar")


def test_coordenador_nao_concede_perfil():
    """Governança de acesso é do Superintendente (Resolução 11/2026, art. 11, IX)."""
    coordenador = _usuario("coordenador_csso")
    assert not coordenador.pode("perfil.conceder")
    assert not coordenador.pode("usuario.criar_conta")
    assert coordenador.pode("parecer.assinar")


def test_auditor_so_le():
    auditor = _usuario("auditor_interno")
    assert auditor.pode("auditoria.ver")
    for escrita in ("processo.criar", "processo.editar", "parecer.emitir", "parecer.anular"):
        assert not auditor.pode(escrita)


def test_escopos():
    assert _usuario("auditor_interno").escopo == ESCOPO_TOTAL
    assert _usuario("coordenador_csso").escopo == ESCOPO_UNIDADE
    assert _usuario("servidor_consulta").escopo == ESCOPO_PROPRIO


def test_escopo_sem_perfil_e_o_mais_restrito():
    anonimo = UsuarioAtual(id=0, login="x", nome="x", permissoes=frozenset(), perfis=())
    assert anonimo.escopo == ESCOPO_PROPRIO


def test_escopo_de_modelo_sem_servidor_id_nao_vaza():
    from sqlalchemy import select

    from app.modelos import LaudoTecnico
    from app.servicos.rbac import aplicar_escopo

    servidor = _usuario("servidor_consulta")
    consulta = aplicar_escopo(select(LaudoTecnico), servidor, LaudoTecnico)
    assert "WHERE" in str(consulta).upper()


def test_escopo_de_modelo_sem_servidor_id_deixa_rastro_no_log(caplog):
    """Negar é certo; calar não. Lista vazia sem uma linha de log é o modo de
    falha que ninguém descobre — a pessoa conclui que não há dado."""
    import logging

    from sqlalchemy import select

    from app.modelos import LaudoTecnico
    from app.servicos.rbac import aplicar_escopo

    with caplog.at_level(logging.WARNING, logger="csso.rbac"):
        aplicar_escopo(select(LaudoTecnico), _usuario("servidor_consulta"), LaudoTecnico)
    assert any("laudo_tecnico" in r.getMessage() for r in caplog.records)


def test_migrar_nao_pode_emudecer_o_logger_da_aplicacao():
    """`fileConfig` desliga, por padrão, todo logger que não esteja no .ini — e
    o `alembic.ini` só declara root, sqlalchemy e alembic. Como `migrar()` roda
    no boot, o logger 'csso' nascia calado para o resto do processo, e o
    `log.error` do `integrity_check` nunca chegava a lugar nenhum.

    Foi assim que este arquivo passou isolado e falhou na suíte inteira: quem
    rodou uma migração antes tinha apagado o logger.
    """
    import inspect
    import logging

    from app import banco

    banco.migrar()
    for nome in ("csso", "csso.rbac"):
        assert not logging.getLogger(nome).disabled, f"migrar() calou '{nome}'"

    fonte = inspect.getsource(banco.migrar)
    assert "upgrade" in fonte  # continua sendo o Alembic que manda no esquema


# ---------------------------------------------------------------------
# Perfil sem escopo declarado: o esquecimento que dava tela vazia sem erro
# ---------------------------------------------------------------------
def test_todo_perfil_da_matriz_tem_escopo_declarado():
    """Sem entrada em ESCOPO_POR_PERFIL o perfil cai em escopo próprio, e
    `aplicar_escopo` sobre tabela sem `servidor_id` devolve `where(False)`: a
    tela abre vazia, sem erro nenhum. É o defeito que os módulos novos iam
    herdar — o almoxarife do EPI abriria o estoque e veria zero linhas."""
    from app.servicos.rbac import ESCOPO_POR_PERFIL

    assert set(MATRIZ_PERFIS) == set(ESCOPO_POR_PERFIL)


def test_declarar_perfil_sem_escopo_derruba_a_importacao():
    """A conferência roda na importação do módulo: quem esquecer não sobe o
    sistema, em vez de descobrir meses depois por uma reclamação de tela vazia."""
    from app.servicos import rbac

    original = dict(rbac.MATRIZ_PERFIS)
    rbac.MATRIZ_PERFIS["almoxarife_de_teste"] = {"nome": "x", "permissoes": []}
    try:
        with pytest.raises(RuntimeError, match="almoxarife_de_teste"):
            rbac._conferir_escopos()
    finally:
        rbac.MATRIZ_PERFIS.clear()
        rbac.MATRIZ_PERFIS.update(original)
    rbac._conferir_escopos()  # volta ao estado bom


def test_escopo_declarado_para_perfil_inexistente_tambem_e_recusado():
    from app.servicos import rbac

    rbac.ESCOPO_POR_PERFIL["perfil_fantasma"] = ESCOPO_TOTAL
    try:
        with pytest.raises(RuntimeError, match="perfil_fantasma"):
            rbac._conferir_escopos()
    finally:
        rbac.ESCOPO_POR_PERFIL.pop("perfil_fantasma")


def test_nivel_de_escopo_desconhecido_e_recusado():
    from app.servicos import rbac

    original = rbac.ESCOPO_POR_PERFIL["auditor_interno"]
    rbac.ESCOPO_POR_PERFIL["auditor_interno"] = "X"
    try:
        with pytest.raises(RuntimeError, match="auditor_interno"):
            rbac._conferir_escopos()
    finally:
        rbac.ESCOPO_POR_PERFIL["auditor_interno"] = original


def test_perfil_do_banco_sem_escopo_nega_em_vez_de_esvaziar_a_tela():
    """Perfil inserido à mão por SQL não passa pela conferência de importação.
    Ao consultar o escopo, nega com mensagem — não devolve lista vazia."""
    from app.servicos.rbac import EscopoNaoDeclarado

    intruso = UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset(), perfis=("perfil_inventado",)
    )
    with pytest.raises(EscopoNaoDeclarado) as falha:
        intruso.escopo
    assert "perfil_inventado" in str(falha.value)
    assert isinstance(falha.value, PermissaoNegada)  # vira 403, nao 500


# ---------------------------------------------------------------------
# SEI - interface definida e vazia
# ---------------------------------------------------------------------
def test_cliente_sei_recusa_qualquer_chamada():
    cliente = sei.obter_cliente()
    with pytest.raises(sei.NaoImplementadoNaV1):
        cliente.incluir_documento_externo("23086.000608/2026-84", "x.pdf", "Parecer")
    with pytest.raises(sei.NaoImplementadoNaV1):
        cliente.consultar_processo("23086.000608/2026-84")


def test_passos_do_sei_sao_instrucoes_manuais():
    assert len(sei.PASSOS_INCLUSAO) >= 4
    assert any("Externo" in p for p in sei.PASSOS_INCLUSAO)


def test_nenhuma_url_de_api_do_sei_no_codigo():
    """A v1 nao integra com o SEI: nenhuma API, nenhum scraping."""
    import inspect

    fonte = inspect.getsource(sei)
    assert "requests" not in fonte
    assert "http://" not in fonte and "https://" not in fonte


# ---------------------------------------------------------------------
# numeracao
# ---------------------------------------------------------------------
def test_numeracao_nunca_usa_max_mais_um():
    """Só o código conta: a proibição aparece de propósito na docstring."""
    import ast
    import inspect

    from app.servicos import numeracao

    arvore = ast.parse(inspect.getsource(numeracao))
    # identifica os NÓS de docstring (modulo, funcoes e classes) e os descarta
    nos_docstring = set()
    for no in ast.walk(arvore):
        corpo = getattr(no, "body", None)
        if not isinstance(corpo, list) or not corpo:
            continue
        primeiro = corpo[0]
        if isinstance(primeiro, ast.Expr) and isinstance(primeiro.value, ast.Constant):
            if isinstance(primeiro.value.value, str):
                nos_docstring.add(id(primeiro.value))

    codigo = " ".join(
        no.value
        for no in ast.walk(arvore)
        if isinstance(no, ast.Constant)
        and isinstance(no.value, str)
        and id(no) not in nos_docstring
    )
    assert "MAX(numero)+1" not in codigo.replace(" ", "")
    assert "uuid" not in codigo.lower()
    assert "CREATE SEQUENCE" not in codigo.upper()
    # e a sequencia realmente vem de parecer_sequencia
    assert "parecer_sequencia" in codigo


def test_erro_de_lock_e_reconhecido():
    from sqlalchemy.exc import OperationalError

    from app.servicos.numeracao import _e_lock

    assert _e_lock(OperationalError("BEGIN", {}, Exception("database is locked")))
    assert not _e_lock(ValueError("outra coisa"))


# ---------------------------------------------------------------------
# auditoria - o nome do evento na tela
# ---------------------------------------------------------------------
def test_todo_evento_que_o_sistema_grava_tem_rotulo():
    """`ROTULO_EVENTO` cobre tudo o que `registrar(tipo_evento=...)` recebe.

    A conferencia varre o codigo-fonte, e nao uma lista escrita a mao, pelo
    motivo que o defeito ensinou: o mapa nasceu depois de dezenas de eventos, e
    lista paralela envelhece calada. Evento novo sem rotulo cai no recuo e a
    tela volta a escrever `NUMERO_DEFINIDO_MANUALMENTE` em negrito no painel —
    que e exatamente o que o mapa existe para impedir.
    """
    import ast
    import pathlib

    from app.servicos.auditoria import ROTULO_EVENTO

    raiz = pathlib.Path(__file__).resolve().parents[2] / "app"
    literais: set[str] = set()
    nomes: set[str] = set()
    constantes: dict[str, str] = {}

    for arquivo in raiz.rglob("*.py"):
        arvore = ast.parse(arquivo.read_text(encoding="utf-8"))
        for no in ast.walk(arvore):
            if isinstance(no, ast.Assign):
                for alvo in no.targets:
                    if (
                        isinstance(alvo, ast.Name)
                        and alvo.id.isupper()
                        and isinstance(no.value, ast.Constant)
                        and isinstance(no.value.value, str)
                    ):
                        constantes[alvo.id] = no.value.value
            if isinstance(no, ast.keyword) and no.arg == "tipo_evento":
                lados = (
                    [no.value.body, no.value.orelse]
                    if isinstance(no.value, ast.IfExp)
                    else [no.value]
                )
                for lado in lados:
                    if isinstance(lado, ast.Constant) and isinstance(lado.value, str):
                        literais.add(lado.value)
                    elif isinstance(lado, ast.Attribute):
                        nomes.add(lado.attr)
                    elif isinstance(lado, ast.Name):
                        nomes.add(lado.id)

    emitidos = literais | {constantes[n] for n in nomes if n in constantes}
    assert emitidos, "a varredura nao achou evento nenhum - o teste deixou de medir"
    assert not (emitidos - set(ROTULO_EVENTO)), "evento gravado sem rotulo de tela"


def test_o_recuo_do_rotulo_de_evento_nunca_devolve_o_codigo_cru():
    """A carga do Trello grava o tipo da acao original, que nunca estara no mapa.

    O recuo humaniza; o que ele nao pode fazer e devolver caixa alta com
    sublinhado, porque e disso que a tela adoecia.
    """
    from app.servicos.auditoria import rotulo_evento

    assert rotulo_evento("PROCESSO_CRIADO") == "Processo criado"
    assert rotulo_evento("EVENTO_QUE_NAO_EXISTE") == "Evento que nao existe"
    assert rotulo_evento(None) == "—"
    assert rotulo_evento("") == "—"


# ---------------------------------------------------------------------
# textos / documento
# ---------------------------------------------------------------------
def test_primeira_maiuscula():
    from app.servicos.documento import primeira_maiuscula

    assert primeira_maiuscula("departamento de zootecnia") == "Departamento de zootecnia"
    assert primeira_maiuscula("") == ""
    assert primeira_maiuscula(None) == ""


def test_richtext_vazio_vira_none():
    from app.servicos.documento import _rich

    assert _rich(None) is None
    assert _rich("") is None
    assert _rich("   ") is None
    assert _rich("uma linha") is not None


def test_sha256_de_texto_e_estavel():
    from app.servicos.documento import sha256_texto

    assert sha256_texto("abc") == sha256_texto("abc")
    assert len(sha256_texto("abc")) == 64
