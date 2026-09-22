"""RN-06 (pendencia com dono e prazo), RN-16 (SLA configuravel) e o sino."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.modelos import AgenteNocivo, ChecklistModelo, Parametro, Pendencia
from app.servicos import parecer as servico_parecer, pendencias
from app.servicos.processo import (
    SLA_PADRAO,
    aplicar_checklist_modelo,
    gravar_sla,
    resumir,
    sla_vigente,
)
from app.servicos.rbac import PermissaoNegada
from testes.integracao import papeis
from testes.integracao.conftest import entrar


@pytest.fixture()
def coord(atores):
    return papeis.COORDENADOR


# ---------------------------------------------------------------------
# Pendencias
# ---------------------------------------------------------------------
def test_abrir_e_idempotente(sessao, coord):
    primeira = pendencias.abrir(
        s=sessao,
        tipo="CONFERIR_LAUDO",
        chave="conferir:laudo:1",
        descricao="Conferir o laudo 26255-000.125/2019",
        usuario=coord,
    )
    segunda = pendencias.abrir(
        s=sessao,
        tipo="CONFERIR_LAUDO",
        chave="conferir:laudo:1",
        descricao="texto diferente, mesma chave",
        usuario=coord,
    )
    assert primeira.id == segunda.id
    assert len(list(sessao.execute(select(Pendencia)).scalars())) == 1


def test_prazo_padrao_por_tipo(sessao, coord):
    pendencia = pendencias.abrir(
        s=sessao,
        tipo="INCLUIR_NO_SEI",
        chave="sei:x",
        descricao="incluir",
        usuario=coord,
    )
    dias = pendencias.TIPOS["INCLUIR_NO_SEI"][1]
    assert pendencia.prazo == date.today() + timedelta(days=dias)


def test_atrasada_e_conclusao(sessao, coord):
    pendencia = pendencias.abrir(
        s=sessao,
        tipo="CONFERIR_LAUDO",
        chave="c:1",
        descricao="x",
        usuario=coord,
        prazo=date.today() - timedelta(days=1),
    )
    assert pendencia.atrasada()
    abertas, atrasadas = pendencias.contar_abertas(sessao, coord)
    assert (abertas, atrasadas) == (1, 1)

    pendencias.concluir(sessao, pendencia, coord)
    assert pendencia.concluida and pendencia.concluida_em
    assert not pendencia.atrasada()
    assert pendencias.contar_abertas(sessao, coord) == (0, 0)
    # concluir de novo nao muda nada
    pendencias.concluir(sessao, pendencia, coord)


def test_rn06_emissao_abre_pendencia_de_quantitativa(sessao, cenario, coord):
    parecer = cenario["parecer"]
    quimico = sessao.execute(
        select(AgenteNocivo).where(
            AgenteNocivo.descricao == "Manipulação de produtos químicos"
        )
    ).scalar_one()
    exposicao = parecer.exposicoes[0]
    exposicao.agente_nocivo_id = quimico.id
    exposicao.fundamentacao_id = quimico.fundamentacao_id
    parecer.texto_reavaliacao = (
        "Os agentes químicos devem ser avaliados quantitativamente..."
    )
    sessao.flush()
    sessao.expire(parecer)

    servico_parecer.emitir(sessao, parecer, coord, gerar_pdf=False)
    abertas = pendencias.abertas(sessao)
    tipos = {p.tipo for p in abertas}
    assert "AVALIACAO_QUANTITATIVA" in tipos
    assert "INCLUIR_NO_SEI" in tipos
    quantitativa = next(p for p in abertas if p.tipo == "AVALIACAO_QUANTITATIVA")
    assert quantitativa.responsavel_id == coord.id
    assert quantitativa.prazo is not None


# ---------------------------------------------------------------------
# CONFLITO_NUMERACAO — o tipo declarado que passou a nascer
# ---------------------------------------------------------------------
# `pendencias.TIPOS` declarava três tipos que nenhuma linha de `app/` abria.
# Este era o único dos três cujo gatilho já existia e era inequívoco: a carga da
# planilha reencontra o número por (numero, ano) e escreve por cima do que achou.
# Reencontrar é deliberado — a planilha é editada entre cargas e a linha 40 vira
# 41 —, mas quando o ocupante NÃO veio da migração o número foi consumido dentro
# do sistema, por alguém, e a carga estava reescrevendo um parecer vivo em
# silêncio. A tarefa existia no catálogo; faltava a linha que a abre.
def _registro_de_planilha(sessao, linha: int, numero: int, ano: int):
    from app.modelos import StgPlanilhaParecer

    registro = StgPlanilhaParecer(
        arquivo="planilha-de-teste.xlsx",
        linha_origem=linha,
        col_b_numero_parecer=str(numero),
        col_d_ano=str(ano),
    )
    sessao.add(registro)
    sessao.flush()
    return registro


def test_carga_sobre_numero_do_sistema_abre_conflito(sessao, cenario, coord):
    """O parecer do `cenario` nasceu no sistema. A carga vem por cima dele."""
    from pathlib import Path

    from app.servicos import importacao_planilha as imp

    parecer = cenario["parecer"]
    parecer.numero = 12
    parecer.ano = 2025
    sessao.flush()

    registro = _registro_de_planilha(sessao, 40, 12, 2025)
    achado = imp._obter_parecer(
        sessao, 12, 2025, Path("planilha-de-teste.xlsx"), registro, coord
    )
    assert achado.id == parecer.id, "o reencontro por (numero, ano) tem de continuar"

    conflitos = [p for p in pendencias.abertas(sessao) if p.tipo == "CONFLITO_NUMERACAO"]
    assert conflitos, "a carga assumiu o número em silêncio"
    assert conflitos[0].parecer_id == parecer.id
    assert "12/2025" in conflitos[0].descricao


def test_recarga_da_mesma_planilha_nao_inventa_conflito(sessao, cenario, coord):
    """Idempotência: a segunda passada da mesma linha não abre nada.

    É o caso comum — a carga roda muitas vezes —, e um falso positivo aqui
    encheria o sino de tarefa que ninguém tem o que fazer com ela.
    """
    from pathlib import Path

    from app.servicos import importacao_planilha as imp

    caminho = Path("planilha-de-teste.xlsx")
    registro = _registro_de_planilha(sessao, 40, 77, 2025)
    imp._obter_parecer(sessao, 77, 2025, caminho, registro, coord)
    imp._obter_parecer(sessao, 77, 2025, caminho, registro, coord)

    assert not [p for p in pendencias.abertas(sessao) if p.tipo == "CONFLITO_NUMERACAO"]


def test_tipos_de_pendencia_declarados_sao_os_que_o_sistema_conhece(sessao, coord):
    """Os dois que ainda não nascem continuam declarados, e de propósito.

    `CONFERIR_LAUDO` e `REGISTRO_DE_OPCAO` esperam uma decisão que não é de
    template nem de rota (o marco de quem nunca foi conferido; a porta para
    anexar o registro de opção), e o comentário em `pendencias.TIPOS` diz qual é.
    Apagá-los faria o próximo a chegar reinventar o código com outro nome.
    """
    assert {"CONFERIR_LAUDO", "REGISTRO_DE_OPCAO", "CONFLITO_NUMERACAO"} <= set(
        pendencias.TIPOS
    )
    # e o rótulo de todo tipo declarado é legível — a tela só cai no código cru
    # para o módulo que ainda não registrou o dele
    assert all(rotulo.strip() for rotulo, _ in pendencias.TIPOS.values())


def test_laudo_superado_abre_pendencia_por_parecer(sessao, cenario, coord):
    parecer = cenario["parecer"]
    servico_parecer.emitir(sessao, parecer, coord, gerar_pdf=False)
    servico_parecer.marcar_laudo_superado(
        sessao, cenario["laudo"], coord, "mudança de processo"
    )
    reavaliacoes = [p for p in pendencias.abertas(sessao) if p.tipo == "REAVALIACAO_LAUDO"]
    assert reavaliacoes
    assert reavaliacoes[0].laudo_id == cenario["laudo"].id


def test_sino_conta_na_tela(app_cliente, contas, banco):
    from app import banco as mod_banco
    from app.servicos.rbac import UsuarioAtual

    with mod_banco.sessao() as s:
        from app.modelos import Usuario

        usuario = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        atual = UsuarioAtual(
            id=usuario.id,
            login=usuario.login,
            nome=usuario.nome,
            permissoes=frozenset({"processo.ver"}),
            perfis=("coordenador_csso",),
        )
        pendencias.abrir(
            s=s,
            tipo="INCLUIR_NO_SEI",
            chave="sino:1",
            descricao="incluir no SEI",
            usuario=atual,
        )
        s.commit()

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/").text
    assert 'class="sino' in corpo
    assert "/pendencias" in corpo

    tela = app_cliente.get("/pendencias")
    assert tela.status_code == 200
    assert "incluir no SEI" in tela.text


def test_sino_conta_de_verdade_e_nao_abre_segunda_conexao(
    app_cliente, contas, banco, monkeypatch
):
    """O sino não pode disputar o lock com a requisição que ele decora.

    **O defeito que este teste tranca.** `web._sino` abria uma sessão própria
    para contar. Só que a sessão da requisição já está aberta e já tomou o lock
    de escrita do SQLite — `banco._transacao_imediata` faz toda transação nascer
    com `BEGIN IMMEDIATE`, e o próprio `banco.py` avisa, em letra grande, que
    ninguém deve abrir uma segunda conexão dentro de uma requisição. O sino
    abria. A segunda conexão esperava o `busy_timeout` inteiro (~5,6 s medidos)
    e terminava em "database is locked", que o `except` do sino engolia.

    Custava duas coisas ao mesmo tempo, e as duas em PRODUÇÃO:

    1. **~5,6 s a mais em toda tela HTML** — o usuário sentia o sistema pesado;
    2. **o sino marcava zero, sempre, para todo mundo** — que é a falha grave:
       o sino existe para dizer que há tarefa esperando, e ele nunca disse.

    Por isso o teste afirma as duas coisas. O contador na tela pega a mentira
    (com o defeito, `sino_abertas` era 0 e o `<span class="contador">` nem
    chegava a ser desenhado). A contagem de sessões abertas pega a causa — e é
    ela que impede a correção de ser desfeita por alguém que "só" volte a abrir
    uma sessão ali dentro e não perceba, porque o `except` continuaria calado.
    """
    from app import banco as mod_banco
    from app.modelos import Usuario
    from app.servicos.rbac import UsuarioAtual

    with mod_banco.sessao() as s:
        usuario = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        atual = UsuarioAtual(
            id=usuario.id,
            login=usuario.login,
            nome=usuario.nome,
            permissoes=frozenset({"processo.ver"}),
            perfis=("coordenador_csso",),
        )
        for numero in (1, 2, 3):
            pendencias.abrir(
                s=s,
                tipo="INCLUIR_NO_SEI",
                chave=f"sino:conta:{numero}",
                descricao=f"incluir no SEI {numero}",
                usuario=atual,
            )
        s.commit()

    entrar(app_cliente, contas, "coordenador_csso")

    # a partir daqui, toda abertura de sessão própria é contada
    aberturas: list[int] = []
    original = mod_banco.sessao

    def _sessao_contada(*args, **kwargs):
        aberturas.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(mod_banco, "sessao", _sessao_contada)

    corpo = app_cliente.get("/").text

    assert '<span class="contador">3</span>' in corpo, (
        "o sino desenhou zero: voltou a contar por fora da sessão da requisição"
    )
    assert aberturas == [], (
        "alguém abriu uma sessão própria durante a requisição — é o deadlock "
        f"consigo mesmo de novo ({len(aberturas)} abertura(s))"
    )


def test_concluir_pendencia_pela_tela(app_cliente, contas, banco):
    from app import banco as mod_banco
    from app.modelos import Usuario
    from app.servicos.rbac import UsuarioAtual

    with mod_banco.sessao() as s:
        usuario = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        atual = UsuarioAtual(
            id=usuario.id, login="c", nome="c", permissoes=frozenset(), perfis=()
        )
        pendencia = pendencias.abrir(
            s=s, tipo="CONFERIR_LAUDO", chave="tela:1", descricao="conferir", usuario=atual
        )
        s.commit()
        pendencia_id = pendencia.id

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        f"/pendencias/{pendencia_id}/concluir", follow_redirects=False
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        assert s.get(Pendencia, pendencia_id).concluida


# ---------------------------------------------------------------------
# SLA configuravel (RN-16)
# ---------------------------------------------------------------------
def test_sla_cai_no_padrao_sem_configuracao(sessao):
    assert sla_vigente(sessao) == SLA_PADRAO


def test_gravar_sla_muda_o_alerta(sessao, cenario, coord):
    processo = cenario["processo"]
    processo.estado_tecnico = "EM_TRIAGEM"
    from app.modelos import agora_utc

    processo.entrou_na_etapa_em = agora_utc() - timedelta(days=10)
    sessao.flush()

    assert resumir(sessao, processo).atrasado is False  # padrao A_FAZER = 15
    gravar_sla(sessao, {"A_FAZER": 5}, coord)
    assert sla_vigente(sessao)["A_FAZER"] == 5
    assert resumir(sessao, processo).atrasado is True


def test_sla_zero_desliga_o_alerta(sessao, cenario, coord):
    from app.modelos import agora_utc

    processo = cenario["processo"]
    processo.estado_tecnico = "EM_TRIAGEM"
    processo.entrou_na_etapa_em = agora_utc() - timedelta(days=999)
    sessao.flush()
    gravar_sla(sessao, {"A_FAZER": 0}, coord)
    assert resumir(sessao, processo).atrasado is False


def test_sla_ignora_coluna_desconhecida_e_valor_invalido(sessao, coord):
    gravar_sla(sessao, {"COLUNA_QUE_NAO_EXISTE": 3}, coord)
    sessao.add(Parametro(chave="sla.A_FAZER", valor="não é número"))
    sessao.flush()
    assert sla_vigente(sessao)["A_FAZER"] == SLA_PADRAO["A_FAZER"]


def test_sla_exige_permissao(sessao):
    from app.servicos.rbac import UsuarioAtual

    sem = UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset({"processo.ver"}), perfis=()
    )
    with pytest.raises(PermissaoNegada):
        gravar_sla(sessao, {"A_FAZER": 1}, sem)


def test_sla_pela_tela(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/config/sla",
        data={"sla_A_FAZER": "7", "sla_EM_ANDAMENTO": "21", "sla_AGUARDANDO": "abc"},
    )
    assert resposta.status_code == 200
    assert "SLA atualizado" in resposta.text
    corpo = app_cliente.get("/config").text
    assert 'name="sla_A_FAZER" value="7"' in corpo


# ---------------------------------------------------------------------
# Checklists modelo
# ---------------------------------------------------------------------
def test_aplicar_checklist_modelo(sessao, cenario, coord):
    modelo = ChecklistModelo(
        nome="Instrução do adicional",
        itens="Portaria de localização\nFormulário do art. 17\nInspeção realizada",
    )
    sessao.add(modelo)
    sessao.flush()

    checklist = aplicar_checklist_modelo(sessao, cenario["processo"], modelo, coord)
    assert len(checklist.itens) == 3
    assert checklist.itens[0].descricao == "Portaria de localização"

    # idempotente: aplicar de novo nao duplica
    de_novo = aplicar_checklist_modelo(sessao, cenario["processo"], modelo, coord)
    assert de_novo.id == checklist.id

    resumo = resumir(sessao, cenario["processo"])
    assert resumo.checklist_total == 3
    assert resumo.checklist_feitos == 0


def test_modelo_ignora_linhas_vazias():
    modelo = ChecklistModelo(nome="x", itens="  a  \n\n\n  b\n   \n")
    assert modelo.lista_de_itens == ["a", "b"]


def test_catalogo_de_checklists_pela_tela(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/catalogos/checklists-modelo",
        data={"nome": "Instrução padrão", "itens": "Portaria\nFormulário"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    lista = app_cliente.get("/catalogos/checklists-modelo")
    assert "Instrução padrão" in lista.text
    assert "Formulário" in lista.text


def test_a_ancora_da_fila_leva_o_caminho_de_volta(app_cliente, contas, banco):
    """Nenhuma tela-âncora oferecia a volta a `/pendencias`: era o botão do
    navegador ou procurar "Pendências" na lateral — que, para quem opera só o
    EPI, nem tem o item. `?de=pendencias` viaja na âncora e a casca responde com
    o link de volta; sem o parâmetro, o link não existe."""
    from app import banco as mod_banco
    from app.servicos.rbac import UsuarioAtual

    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    processo_id = int(criado.headers["location"].rsplit("/", 1)[-1].split("?")[0])
    with mod_banco.sessao() as s:
        from app.modelos import Usuario

        usuario = s.execute(select(Usuario).where(Usuario.login == "coordenador_csso")).scalar_one()
        atual = UsuarioAtual(
            id=usuario.id, login=usuario.login, nome=usuario.nome,
            permissoes=frozenset({"processo.ver"}), perfis=("coordenador_csso",),
        )
        pendencias.abrir(
            s=s, tipo="INCLUIR_NO_SEI", chave="volta:1", descricao="incluir no SEI",
            usuario=atual, processo_id=processo_id,
        )
        s.commit()

    fila = app_cliente.get("/pendencias").text
    assert f'href="/processos/{processo_id}?de=pendencias">processo</a>' in fila

    com_volta = app_cliente.get(f"/processos/{processo_id}?de=pendencias").text
    assert 'class="volta-origem" href="/pendencias"' in com_volta
    sem_volta = app_cliente.get(f"/processos/{processo_id}").text
    assert "volta-origem" not in sem_volta
