"""Fatia 2 de Certificados e Treinamentos: turma, participante e inscrição.

Os testes exercitam o cenário do usuário pela porta da frente (HTTP) sempre que
possível. Onde a granularidade da permissão não existe em nenhum perfil real —
todos os perfis operacionais recebem as três permissões de uma vez —, o teste
monta o `UsuarioAtual` à mão e chama o serviço, que é onde a recusa mora.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError

from app.modelos import (
    AssinaturaInstrutor,
    HistoricoEvento,
    Inscricao,
    Participante,
    ParticipanteEmail,
    Servidor,
    Treinamento,
    Turma,
)
from app.servicos.rbac import PermissaoNegada, UsuarioAtual
from testes.integracao.conftest import entrar

NR35 = {
    "codigo": "NR-35",
    "nome": "Trabalho em Altura — NR-35",
    "carga_horaria_horas": "8",
    "validade_meses": "24",
    "norma_referencia": "NR-35",
}

# As datas são relativas a hoje, e não literais: a regra "não se abre inscrição
# para turma que já terminou" tornaria um literal de 2026 um teste que passa
# hoje e falha no ano que vem, sem nada ter mudado no sistema. Pelo mesmo
# motivo o código esperado é derivado do ano, e não escrito à mão.
INICIO = date.today() + timedelta(days=30)
FIM = INICIO + timedelta(days=2)
ANO = INICIO.year
PRIMEIRA = f"TUR-{ANO}-0001"
SEGUNDA = f"TUR-{ANO}-0002"

TURMA = {
    "data_inicio": INICIO.isoformat(),
    "data_fim": FIM.isoformat(),
    "local": "Auditório do Campus JK",
    "frequencia_minima_percentual": "75",
}


# =====================================================================
# Montagem
# =====================================================================
def _sessao():
    from app import banco as mod_banco

    return mod_banco.sessao()


def _criar_treinamento(cliente, dados: dict | None = None) -> int:
    resposta = cliente.post(
        "/treinamentos/catalogo", data={**NR35, **(dados or {})}, follow_redirects=False
    )
    assert resposta.status_code == 303, resposta.text
    codigo = (dados or {}).get("codigo", NR35["codigo"])
    with _sessao() as s:
        return s.execute(
            select(Treinamento).where(Treinamento.codigo == codigo)
        ).scalar_one().id


def _criar_turma(cliente, treinamento_id: int, dados: dict | None = None):
    return cliente.post(
        "/turmas",
        data={"treinamento_id": str(treinamento_id), **TURMA, **(dados or {})},
        follow_redirects=False,
    )


def _id_da_turma(codigo: str = PRIMEIRA) -> int:
    with _sessao() as s:
        return s.execute(select(Turma).where(Turma.codigo == codigo)).scalar_one().id


@pytest.fixture()
def turma_aberta(app_cliente, contas, banco):
    """Coordenador logado, um treinamento no catálogo e a primeira turma aberta."""
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    assert _criar_turma(app_cliente, treinamento_id).status_code == 303
    return {"cliente": app_cliente, "treinamento_id": treinamento_id,
            "turma_id": _id_da_turma()}


def _criar_servidor(siape: str = "1110654", nome: str = "Marco Antônio Alves Schetino",
                    email: str | None = None) -> int:
    with _sessao() as s:
        servidor = Servidor(siape=siape, nome=nome, email=email)
        s.add(servidor)
        s.commit()
        return servidor.id


def _usuario_com(*permissoes: str, login: str = "operador") -> UsuarioAtual:
    """Um `UsuarioAtual` com exatamente estas permissões, e a linha de `usuario`
    que as FKs de auditoria exigem."""
    from app.modelos import Usuario

    with _sessao() as s:
        usuario = Usuario(
            login=login,
            nome="Operador de teste",
            email=f"{login}@teste.ufvjm.edu.br",
            senha_hash="nao-usado-neste-teste",
            precisa_trocar_senha=False,
        )
        s.add(usuario)
        s.commit()
        identificador = usuario.id
    return UsuarioAtual(
        id=identificador,
        login=login,
        nome="Operador de teste",
        permissoes=frozenset(permissoes),
        perfis=("coordenador_csso",),
    )


def _mensagem(cliente, resposta) -> str:
    """O texto da página onde o aviso é renderizado, venha ele por qual caminho vier.

    Duas formas de recusa convivem de propósito. A maioria das rotas ainda
    responde 303 e o aviso viaja na querystring. A abertura de turma, não: ela
    tem treze campos, e devolver o digitado exige **renderizar** a tela em vez de
    redirecionar para ela em branco (o padrão `digitado` de
    `processos.criar`). O helper aceita as duas para que o teste continue
    afirmando o que interessa — o texto que chega à tela —, e não o mecanismo.
    """
    if resposta.status_code == 200:
        return resposta.text
    assert resposta.status_code == 303, resposta.text
    return cliente.get(resposta.headers["location"]).text


# =====================================================================
# Numeração — RN-03 generalizada
# =====================================================================
def test_turma_recebe_numero_sequencial_por_ano(app_cliente, contas, banco):
    """A sequência é por ano e reinicia: a primeira do ano seguinte volta a 1."""
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    _criar_turma(app_cliente, treinamento_id)
    _criar_turma(app_cliente, treinamento_id)
    ano_seguinte = INICIO.replace(year=ANO + 1)
    _criar_turma(
        app_cliente,
        treinamento_id,
        {
            "data_inicio": ano_seguinte.isoformat(),
            "data_fim": ano_seguinte.isoformat(),
        },
    )
    with _sessao() as s:
        codigos = [
            t.codigo for t in s.execute(select(Turma).order_by(Turma.id)).scalars()
        ]
    assert codigos == [PRIMEIRA, SEGUNDA, f"TUR-{ANO + 1}-0001"]


def test_numeracao_pula_numero_ja_gravado(app_cliente, contas, banco):
    """Mesma disciplina da RN-03: nunca MAX+1, e número ocupado é pulado.

    Cenário real: o setor já numerou turmas fora do sistema e a linha entrou
    por carga. Sem o pulo, a próxima turma colidiria no `uq_turma`.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    ja_numerada = date(ANO, 1, 5)
    with _sessao() as s:
        s.add(
            Turma(
                treinamento_id=treinamento_id,
                numero=1,
                ano=ANO,
                codigo=PRIMEIRA,
                data_inicio=ja_numerada,
                data_fim=ja_numerada,
                frequencia_minima_percentual=Decimal(75),
            )
        )
        s.commit()
    assert _criar_turma(app_cliente, treinamento_id).status_code == 303
    with _sessao() as s:
        nova = s.execute(
            select(Turma).where(Turma.data_inicio == INICIO)
        ).scalar_one()
    assert nova.numero == 2
    assert nova.codigo == SEGUNDA


def test_numeracao_do_parecer_continua_igual(banco, sessao):
    """A generalização não pode mudar o comportamento de quem já usava."""
    from app.servicos import numeracao

    assert numeracao.proximo_numero_parecer(sessao, 2026) == 1
    assert numeracao.proximo_numero_parecer(sessao, 2026) == 2
    assert numeracao.proximo_numero_parecer(sessao, 2025) == 1


def test_numeracao_recusa_tabela_fora_da_lista(banco, sessao):
    """Nome de tabela não aceita bind parameter: ele é interpolado no SQL.

    A lista fechada é o que impede a função mais transacional do sistema de
    virar superfície de injeção.
    """
    from app.servicos import numeracao

    with pytest.raises(numeracao.SequenciaDesconhecida):
        numeracao.proximo_numero(
            sessao, 2026, tabela_sequencia="usuario", tabela_alvo="usuario"
        )
    # sequência conhecida apontando para o alvo errado também é recusada:
    # consumir de uma e conferir ocupação na outra repetiria número sem erro
    with pytest.raises(numeracao.SequenciaDesconhecida):
        numeracao.proximo_numero(
            sessao, 2026, tabela_sequencia="turma_sequencia", tabela_alvo="parecer_tecnico"
        )
    with pytest.raises(numeracao.SequenciaDesconhecida):
        numeracao.proximo_numero(
            sessao, 2026, tabela_sequencia="turma_sequencia", tabela_alvo="turma",
            coluna="id; DROP TABLE turma",
        )


# =====================================================================
# Turma — abertura
# =====================================================================
def test_abrir_turma_pela_tela(turma_aberta):
    cliente = turma_aberta["cliente"]
    with _sessao() as s:
        turma = s.get(Turma, turma_aberta["turma_id"])
        assert turma.codigo == PRIMEIRA
        assert turma.situacao == "PLANEJADA"
        assert turma.local == "Auditório do Campus JK"
        # a carga da turma vazia significa "usa a do catálogo", e não zero
        assert turma.carga_horaria_horas is None
        assert turma.carga_efetiva == 8
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.entidade == "turma",
                HistoricoEvento.tipo_evento == "TURMA_CRIADA",
            )
        ).scalar_one()
        assert PRIMEIRA in evento.descricao
    assert PRIMEIRA in cliente.get("/turmas").text


def test_o_ano_da_turma_vem_do_inicio(app_cliente, contas, banco):
    """Planejar em dezembro uma turma de janeiro consome o número do ano que a
    turma vai ser citada, não o do dia em que alguém digitou."""
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    ano_seguinte = date(ANO + 1, 1, 11)
    _criar_turma(
        app_cliente,
        treinamento_id,
        {
            "data_inicio": ano_seguinte.isoformat(),
            "data_fim": ano_seguinte.isoformat(),
        },
    )
    with _sessao() as s:
        turma = s.execute(select(Turma)).scalar_one()
    assert (turma.ano, turma.codigo) == (ANO + 1, f"TUR-{ANO + 1}-0001")


def test_turma_de_treinamento_inativo_e_recusada(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    app_cliente.post(
        f"/treinamentos/catalogo/{treinamento_id}",
        data={
            "nome": NR35["nome"],
            "carga_horaria_horas": "8",
            "validade_meses": "24",
        },  # sem `ativo` marcado: o catálogo desativa
        follow_redirects=False,
    )
    texto = _mensagem(app_cliente, _criar_turma(app_cliente, treinamento_id))
    assert "está inativo no catálogo" in texto
    with _sessao() as s:
        assert s.execute(select(Turma)).first() is None


def test_data_fim_antes_do_inicio_e_recusada(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    texto = _mensagem(
        app_cliente,
        _criar_turma(
            app_cliente,
            treinamento_id,
            {"data_inicio": FIM.isoformat(), "data_fim": INICIO.isoformat()},
        ),
    )
    assert "não pode ser anterior ao início" in texto


def test_data_em_branco_nao_vira_hoje(app_cliente, contas, banco):
    """Campo de data apagado é recusa, não valor plausível.

    É a lição do achado 5 da revisão da fatia 1: o FastAPI troca string vazia
    pelo default do `Form` antes de a rota rodar, e um default plausível grava
    valor que ninguém digitou.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    texto = _mensagem(
        app_cliente, _criar_turma(app_cliente, treinamento_id, {"data_inicio": ""})
    )
    assert "Informe a data de início" in texto
    with _sessao() as s:
        assert s.execute(select(Turma)).first() is None


def test_vagas_e_nota_fora_da_faixa_sao_recusadas(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    assert "maior que zero" in _mensagem(
        app_cliente, _criar_turma(app_cliente, treinamento_id, {"vagas": "0"})
    )
    assert "entre 0 e 10" in _mensagem(
        app_cliente,
        _criar_turma(app_cliente, treinamento_id, {"nota_minima_aprovacao": "11"}),
    )


# =====================================================================
# Turma — edição
# =====================================================================
def test_editar_turma_registra_diff_campo_a_campo(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    resposta = cliente.post(
        f"/turmas/{turma_id}",
        data={**TURMA, "local": "Sala 3 do IECT", "vagas": "20"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with _sessao() as s:
        turma = s.get(Turma, turma_id)
        assert (turma.local, turma.vagas) == ("Sala 3 do IECT", 20)
        diffs = {
            e.campo: (e.valor_anterior, e.valor_novo)
            for e in s.execute(
                select(HistoricoEvento).where(
                    HistoricoEvento.entidade == "turma",
                    HistoricoEvento.tipo_evento == "CAMPO_ALTERADO",
                )
            ).scalars()
        }
    assert diffs["local"] == ("Auditório do Campus JK", "Sala 3 do IECT")
    assert "vagas" in diffs
    # campo que não mudou não vira evento
    assert "data_inicio" not in diffs


def test_adiar_a_turma_para_outro_ano_e_recusado(turma_aberta):
    """O número saiu da sequência daquele ano e o código já foi divulgado."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}",
            data={
                **TURMA,
                "data_inicio": INICIO.replace(year=ANO + 1).isoformat(),
                "data_fim": FIM.replace(year=ANO + 1).isoformat(),
            },
            follow_redirects=False,
        ),
    )
    assert "Cancele esta turma e abra outra" in texto
    with _sessao() as s:
        assert s.get(Turma, turma_id).data_inicio == INICIO


def test_turma_cancelada_nao_se_edita(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/situacao",
        data={"destino": "CANCELADA", "motivo": "instrutor adoeceu"},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}", data={**TURMA, "local": "outro lugar"},
            follow_redirects=False,
        ),
    )
    assert "não se edita" in texto
    with _sessao() as s:
        assert s.get(Turma, turma_id).local == "Auditório do Campus JK"


def test_reduzir_vagas_para_menos_que_os_inscritos(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    for siape, nome in (("1110654", "Marco Antônio"), ("2165804", "Fabrício Andrade")):
        servidor_id = _criar_servidor(siape=siape, nome=nome)
        cliente.post(
            f"/turmas/{turma_id}/inscricoes",
            data={"servidor_id": str(servidor_id)},
            follow_redirects=False,
        )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}", data={**TURMA, "vagas": "1"}, follow_redirects=False
        ),
    )
    assert "deixaria gente inscrita fora da conta" in texto


# =====================================================================
# Máquina E — a turma
# =====================================================================
def test_caminho_feliz_da_turma(turma_aberta):
    """Planejada -> inscrições abertas -> em andamento -> concluída."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    for destino in ("INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CONCLUIDA"):
        resposta = cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": destino},
            follow_redirects=False,
        )
        assert resposta.status_code == 303
        with _sessao() as s:
            assert s.get(Turma, turma_id).situacao == destino
    with _sessao() as s:
        turma = s.get(Turma, turma_id)
        assert turma.concluida_em is not None
        estados = [
            (e.valor_anterior, e.valor_novo)
            for e in s.execute(
                select(HistoricoEvento)
                .where(
                    HistoricoEvento.entidade == "turma",
                    HistoricoEvento.campo == "situacao",
                )
                .order_by(HistoricoEvento.id)
            ).scalars()
        ]
    assert estados == [
        ("PLANEJADA", "INSCRICOES_ABERTAS"),
        ("INSCRICOES_ABERTAS", "EM_ANDAMENTO"),
        ("EM_ANDAMENTO", "CONCLUIDA"),
    ]


def test_fechar_inscricoes_sem_cancelar_a_turma(turma_aberta):
    """Vagas esgotadas ou data adiada: volta para planejada, não vira cancelada."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/situacao", data={"destino": "INSCRICOES_ABERTAS"},
        follow_redirects=False,
    )
    cliente.post(
        f"/turmas/{turma_id}/situacao", data={"destino": "PLANEJADA"},
        follow_redirects=False,
    )
    with _sessao() as s:
        assert s.get(Turma, turma_id).situacao == "PLANEJADA"


def test_pular_de_planejada_para_concluida_e_recusado(turma_aberta):
    """Sem a máquina, uma turma "concluiria" sem nunca ter acontecido."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": "CONCLUIDA"},
            follow_redirects=False,
        ),
    )
    assert "Transição proibida" in texto
    with _sessao() as s:
        assert s.get(Turma, turma_id).situacao == "PLANEJADA"


def test_cancelar_sem_motivo_e_recusado(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": "CANCELADA"},
            follow_redirects=False,
        ),
    )
    assert "exige o motivo" in texto
    with _sessao() as s:
        assert s.get(Turma, turma_id).situacao == "PLANEJADA"


def test_concluir_leva_a_confirmacao_e_nao_executa_no_primeiro_clique(turma_aberta):
    """Concluir era um clique só, e saía na classe MENOS enfática do sistema.

    Ao lado dela, "Cancelar turma" — igualmente final — sai em `perigo` e exige
    motivo. As duas encerram a turma para sempre; só uma delas parecia grave. E
    concluir não é só mudar de estado: no mesmo ato o sistema apura cada
    inscrito, calcula frequência e grava aprovado ou reprovado.
    """
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    servidor_id = _criar_servidor()
    for destino in ("INSCRICOES_ABERTAS",):
        cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": destino},
            follow_redirects=False,
        )
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(servidor_id)},
        follow_redirects=False,
    )
    cliente.post(
        f"/turmas/{turma_id}/situacao", data={"destino": "EM_ANDAMENTO"},
        follow_redirects=False,
    )

    ficha = cliente.get(f"/turmas/{turma_id}").text
    assert 'href="#concluir-turma"' in ficha, "o botão de concluir ainda executa"
    assert 'id="concluir-turma"' in ficha
    assert "apura 1 inscrito(s)" in ficha, "a confirmação não diz quantos"
    assert "não tem volta" in ficha
    with _sessao() as s:
        assert s.get(Turma, turma_id).situacao == "EM_ANDAMENTO", "concluiu sozinha"


def test_confirmacao_de_concluir_some_quando_nao_ha_para_onde_ir(turma_aberta):
    """Turma já concluída não pode continuar oferecendo a confirmação."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    for destino in ("INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CONCLUIDA"):
        cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": destino},
            follow_redirects=False,
        )
    ficha = cliente.get(f"/turmas/{turma_id}").text
    assert 'id="concluir-turma"' not in ficha
    assert "é situação final" in ficha


def test_turma_concluida_e_terminal(turma_aberta):
    """Reabrir turma fechada faria um certificado já emitido descrever uma
    turma que mudou depois."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    for destino in ("INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CONCLUIDA"):
        cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": destino},
            follow_redirects=False,
        )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": "EM_ANDAMENTO"},
            follow_redirects=False,
        ),
    )
    assert "Transição proibida" in texto
    with _sessao() as s:
        assert s.get(Turma, turma_id).situacao == "CONCLUIDA"


def test_turma_cancelada_e_terminal(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/situacao",
        data={"destino": "CANCELADA", "motivo": "sem quórum"},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": "PLANEJADA"},
            follow_redirects=False,
        ),
    )
    assert "Transição proibida" in texto
    with _sessao() as s:
        turma = s.get(Turma, turma_id)
    assert (turma.situacao, turma.motivo_cancelamento) == ("CANCELADA", "sem quórum")


def test_abrir_inscricao_de_turma_que_ja_terminou_e_recusado(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    ontem = date.today() - timedelta(days=30)
    _criar_turma(
        app_cliente,
        treinamento_id,
        {"data_inicio": ontem.isoformat(), "data_fim": ontem.isoformat()},
    )
    with _sessao() as s:
        turma_id = s.execute(select(Turma)).scalar_one().id
    texto = _mensagem(
        app_cliente,
        app_cliente.post(
            f"/turmas/{turma_id}/situacao", data={"destino": "INSCRICOES_ABERTAS"},
            follow_redirects=False,
        ),
    )
    assert "não há como abrir inscrição" in texto


def test_concluir_exige_permissao_propria(turma_aberta):
    """`turma.criar` abre e começa a turma; concluir e cancelar são de quem
    responde por ela — mesma simetria do parecer, em que o técnico emite e não
    anula."""
    from app.servicos import turma as servico_turma

    turma_id = turma_aberta["turma_id"]
    operador = _usuario_com("turma.criar", "turma.inscrever")
    with _sessao() as s:
        turma = s.get(Turma, turma_id)
        servico_turma.mudar_situacao(s, operador, turma, "INSCRICOES_ABERTAS")
        servico_turma.mudar_situacao(s, operador, turma, "EM_ANDAMENTO")
        with pytest.raises(PermissaoNegada) as erro:
            servico_turma.mudar_situacao(s, operador, turma, "CONCLUIDA")
        assert erro.value.codigo == "turma.concluir"
        with pytest.raises(PermissaoNegada):
            servico_turma.mudar_situacao(
                s, operador, turma, "CANCELADA", motivo="qualquer"
            )
        s.rollback()


# =====================================================================
# Instrutores da turma
# =====================================================================
def _criar_assinatura(cliente, nome="Fabrício Raimundi Andrade", inicio="2020-01-01",
                      fim=""):
    resposta = cliente.post(
        "/treinamentos/assinaturas",
        data={
            "nome": nome,
            "externo": "1",
            "titulo": "Eng. Seg. do Trabalho",
            "vigencia_inicio": inicio,
            "vigencia_fim": fim,
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with _sessao() as s:
        return s.execute(
            select(AssinaturaInstrutor).where(AssinaturaInstrutor.nome == nome)
        ).scalar_one().id


def test_vincular_e_desvincular_instrutor(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    instrutor_id = _criar_assinatura(cliente)
    resposta = cliente.post(
        f"/turmas/{turma_id}/instrutores",
        data={"assinatura_instrutor_id": str(instrutor_id), "assina_certificado": "1"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with _sessao() as s:
        turma = s.get(Turma, turma_id)
        assert [v.instrutor.nome for v in turma.instrutores] == [
            "Fabrício Raimundi Andrade"
        ]
        assert turma.instrutores[0].assina_certificado is True

    cliente.post(
        f"/turmas/{turma_id}/instrutores",
        data={"assinatura_instrutor_id": str(instrutor_id), "remover": "1"},
        follow_redirects=False,
    )
    with _sessao() as s:
        assert s.get(Turma, turma_id).instrutores == []


def test_instrutor_repetido_e_recusado(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    instrutor_id = _criar_assinatura(cliente)
    cliente.post(
        f"/turmas/{turma_id}/instrutores",
        data={"assinatura_instrutor_id": str(instrutor_id)},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/instrutores",
            data={"assinatura_instrutor_id": str(instrutor_id)},
            follow_redirects=False,
        ),
    )
    assert "já é instrutor desta turma" in texto


def test_instrutor_fora_de_vigencia_e_recusado(turma_aberta):
    """Assinatura vencida seria recusada na emissão, com a turma já realizada."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    instrutor_id = _criar_assinatura(
        cliente, nome="Antiga Instrutora", inicio="2019-01-01", fim="2024-12-31"
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/instrutores",
            data={"assinatura_instrutor_id": str(instrutor_id)},
            follow_redirects=False,
        ),
    )
    assert f"não vigora em {INICIO.strftime('%d/%m/%Y')}" in texto
    # e nem chega a ser oferecida na tela, para não fazer a pessoa tentar
    assert "Antiga Instrutora" not in cliente.get(f"/turmas/{turma_id}").text


# =====================================================================
# Participante — o ponteiro, o externo e o e-mail
# =====================================================================
def test_servidor_vira_ponteiro_e_nunca_copia_o_nome(turma_aberta):
    """Nome, cargo e lotação continuam em `servidor`; aqui fica só o vínculo.

    Copiar o nome faria os dois divergirem no dia em que um fosse corrigido —
    e o certificado sairia com o errado.
    """
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    servidor_id = _criar_servidor()
    resposta = cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(servidor_id)},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with _sessao() as s:
        pessoa = s.execute(select(Participante)).scalar_one()
        assert pessoa.servidor_id == servidor_id
        assert pessoa.nome is None
        assert pessoa.vinculo == "SERVIDOR"
        assert pessoa.nome_exibicao == "Marco Antônio Alves Schetino"
        # corrigir o cadastro corrige a exibição, porque não há cópia
        s.get(Servidor, servidor_id).nome = "Marco Antônio A. Schetino"
        s.commit()
    with _sessao() as s:
        assert (
            s.execute(select(Participante)).scalar_one().nome_exibicao
            == "Marco Antônio A. Schetino"
        )


def test_o_mesmo_servidor_nao_vira_dois_participantes(turma_aberta):
    """Duas turmas, uma pessoa: se virasse dois participantes, o histórico de
    reciclagem se partiria em dois e o monitor diria "nunca fez" de metade."""
    cliente = turma_aberta["cliente"]
    servidor_id = _criar_servidor()
    _criar_turma(cliente, turma_aberta["treinamento_id"])
    outra_id = _id_da_turma(SEGUNDA)
    for turma_id in (turma_aberta["turma_id"], outra_id):
        cliente.post(
            f"/turmas/{turma_id}/inscricoes",
            data={"servidor_id": str(servidor_id)},
            follow_redirects=False,
        )
    with _sessao() as s:
        assert len(list(s.execute(select(Participante)).scalars())) == 1
        assert len(list(s.execute(select(Inscricao)).scalars())) == 2


def test_externo_recebe_identificador_publico_opaco(turma_aberta):
    """`PTC-7F3K9Q2M`: opaco, estável e sem relação com nome nem e-mail."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={
            "nome": "Maria Aparecida de Souza",
            "vinculo": "TERCEIRIZADO",
            "organizacao": "Limpeza Ltda",
            "email": "maria@exemplo.com.br",
        },
        follow_redirects=False,
    )
    with _sessao() as s:
        pessoa = s.execute(select(Participante)).scalar_one()
    assert re.fullmatch(r"PTC-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}",
                        pessoa.identificador_publico)
    assert pessoa.nome == "Maria Aparecida de Souza"
    assert pessoa.servidor_id is None
    assert pessoa.nome_exibicao == "Maria Aparecida de Souza"


def test_nao_ha_coluna_de_cpf_em_nenhuma_tabela_nova(banco):
    """Decisão 1 do coordenador: nenhum campo `cpf` em tabela nova."""
    from app import banco as mod_banco

    inspetor = inspect(mod_banco.obter_engine())
    for tabela in ("participante", "participante_email", "turma", "inscricao"):
        colunas = {c["name"].lower() for c in inspetor.get_columns(tabela)}
        assert not any("cpf" in nome for nome in colunas), tabela


def test_cadastrar_externo_com_vinculo_de_servidor_e_recusado(turma_aberta):
    """Quem tem SIAPE entra pelo cadastro de servidor; deixar passar aqui
    criaria uma segunda 'pessoa servidor' com nome copiado."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/inscricoes",
            data={"nome": "Alguém", "vinculo": "SERVIDOR"},
            follow_redirects=False,
        ),
    )
    assert "entra pelo cadastro de servidor" in texto
    with _sessao() as s:
        assert s.execute(select(Participante)).first() is None


def test_email_invalido_nao_deixa_participante_gravado(turma_aberta):
    """`criar_externo` grava a pessoa e só então registra o endereço: sem o
    rollback, o e-mail errado deixaria o cadastro pela metade."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"nome": "Alguém", "vinculo": "VISITANTE", "email": "sem-arroba"},
        follow_redirects=False,
    )
    with _sessao() as s:
        assert s.execute(select(Participante)).first() is None
        assert s.execute(select(Inscricao)).first() is None


def test_email_normalizado_nasce_do_email_bruto(turma_aberta):
    """A forma normalizada não se digita: derivá-la é o que impede um script de
    carga de gravar só a bruta e a busca por e-mail parar de achar a pessoa."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={
            "nome": "Maria Aparecida de Souza",
            "vinculo": "VISITANTE",
            "email": "  Maria.Souza@UFVJM.EDU.BR  ",
        },
        follow_redirects=False,
    )
    with _sessao() as s:
        endereco = s.execute(select(ParticipanteEmail)).scalar_one()
    assert endereco.email == "Maria.Souza@UFVJM.EDU.BR"
    assert endereco.email_normalizado == "maria.souza@ufvjm.edu.br"
    assert endereco.confirmado_em is None


def test_email_invalido_e_recusado(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/inscricoes",
            data={"nome": "Alguém", "vinculo": "VISITANTE", "email": "sem-arroba"},
            follow_redirects=False,
        ),
    )
    assert "E-mail invalido" in texto


def test_inscricao_recusada_nao_deixa_participante_orfao(turma_aberta):
    """A recusa desfaz o cadastro que a mesma requisição já tinha gravado.

    A sessão do FastAPI dá commit ao terminar a rota, mesmo quando a rota
    devolveu um aviso. Sem o rollback, cadastrar um externo e esbarrar na turma
    lotada guardaria o nome e o e-mail de quem nunca chegou a se inscrever — e
    a segunda tentativa criaria a mesma pessoa outra vez.
    """
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}", data={**TURMA, "vagas": "1"}, follow_redirects=False
    )
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/inscricoes",
            data={
                "nome": "Maria Aparecida de Souza",
                "vinculo": "TERCEIRIZADO",
                "email": "maria@exemplo.com.br",
            },
            follow_redirects=False,
        ),
    )
    assert "não tem vaga" in texto
    with _sessao() as s:
        nomes = [p.nome for p in s.execute(select(Participante)).scalars()]
        enderecos = list(s.execute(select(ParticipanteEmail)).scalars())
    assert nomes == [None]  # só o ponteiro do servidor que entrou
    assert enderecos == []


def test_dois_emails_da_mesma_pessoa_reconciliam_o_historico(turma_aberta):
    """O caso que justifica a tabela filha de e-mail.

    Maria se inscreve em março com o e-mail pessoal e em agosto com o
    institucional. Se o e-mail fosse coluna, seriam duas pessoas — e a
    reciclagem de NR-35 feita em 2026 não apareceria para a "Maria
    institucional" de 2028.
    """
    cliente = turma_aberta["cliente"]
    primeira = turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{primeira}/inscricoes",
        data={
            "nome": "Maria Aparecida de Souza",
            "vinculo": "DISCENTE",
            "email": "maria@gmail.com",
        },
        follow_redirects=False,
    )
    _criar_turma(cliente, turma_aberta["treinamento_id"])
    segunda = _id_da_turma(SEGUNDA)
    with _sessao() as s:
        pessoa_id = s.execute(select(Participante)).scalar_one().id
    # a busca acha pelo e-mail antigo; inscrever a MESMA pessoa com o endereço
    # novo acrescenta o endereço, não cria outro cadastro
    cliente.post(
        f"/turmas/{segunda}/inscricoes",
        data={"participante_id": str(pessoa_id), "email": "maria@ufvjm.edu.br"},
        follow_redirects=False,
    )
    with _sessao() as s:
        pessoas = list(s.execute(select(Participante)).scalars())
        assert len(pessoas) == 1
        assert sorted(e.email_normalizado for e in pessoas[0].emails) == [
            "maria@gmail.com",
            "maria@ufvjm.edu.br",
        ]
    # e a busca por qualquer um dos dois devolve a mesma pessoa
    from app.servicos import participante as servico_participante

    # `certificado.ver` porque endereço é identificação nominal — é o nome
    # escrito de outro jeito (RN-19, `casa_a_busca_de_participante`). É a
    # permissão que todo perfil capaz de inscrever alguém tem, e é como a ficha
    # da turma chama a busca.
    quem_inscreve = _usuario_com("certificado.ver", login="reconciliador")
    with _sessao() as s:
        por_pessoal = servico_participante.por_email(s, "MARIA@gmail.com")
        por_institucional = servico_participante.por_email(s, "maria@ufvjm.edu.br")
        assert por_pessoal.id == por_institucional.id == pessoa_id
        assert (
            len(servico_participante.buscar(s, "maria@ufvjm.edu.br", quem_inscreve))
            == 1
        )


def test_email_confirmado_pertence_a_um_participante_so(banco, sessao):
    """Índice único parcial: o confirmado é único, o não confirmado pode
    repetir — e é o repetido que sinaliza duplicata a mesclar."""
    from app.modelos import agora_utc
    from app.servicos import participante as servico_participante

    um = servico_participante.criar_externo(
        sessao, nome="Maria A. de Souza", vinculo="VISITANTE", email="maria@x.com"
    )
    outro = servico_participante.criar_externo(
        sessao, nome="Maria Aparecida", vinculo="VISITANTE", email="maria@x.com"
    )
    sessao.flush()  # duas linhas NAO confirmadas convivem: é o sinal da duplicata
    assert um.id != outro.id

    servico_participante.registrar_email(
        sessao, um, "maria@x.com", confirmado_em=agora_utc()
    )
    # o segundo bate no índice parcial: posse de caixa não se divide
    with pytest.raises(IntegrityError):
        servico_participante.registrar_email(
            sessao, outro, "maria@x.com", confirmado_em=agora_utc()
        )
    sessao.rollback()


# =====================================================================
# Inscrição — máquina F
# =====================================================================
def test_inscrever_e_confirmar(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    servidor_id = _criar_servidor()
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(servidor_id)},
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricao = s.execute(select(Inscricao)).scalar_one()
        assert (inscricao.situacao, inscricao.origem) == ("INSCRITA", "INTERNA")
        inscricao_id = inscricao.id

    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
        data={"destino": "CONFIRMADA"},
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.situacao == "CONFIRMADA"
        assert inscricao.confirmada_em is not None
        assert inscricao.confirmada_por is not None
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.entidade == "inscricao",
                HistoricoEvento.campo == "situacao",
            )
        ).scalar_one()
    assert (evento.valor_anterior, evento.valor_novo) == ("INSCRITA", "CONFIRMADA")


def test_inscricao_duplicada_e_recusada(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    servidor_id = _criar_servidor()
    dados = {"servidor_id": str(servidor_id)}
    cliente.post(f"/turmas/{turma_id}/inscricoes", data=dados, follow_redirects=False)
    texto = _mensagem(
        cliente,
        cliente.post(f"/turmas/{turma_id}/inscricoes", data=dados, follow_redirects=False),
    )
    assert f"já consta em {PRIMEIRA}" in texto
    with _sessao() as s:
        assert len(list(s.execute(select(Inscricao)).scalars())) == 1


def test_turma_sem_vaga_recusa_inscricao(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}", data={**TURMA, "vagas": "1"}, follow_redirects=False
    )
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/inscricoes",
            data={"servidor_id": str(_criar_servidor("2165804", "Fabrício"))},
            follow_redirects=False,
        ),
    )
    assert "não tem vaga" in texto


def test_cancelar_inscricao_libera_a_vaga(turma_aberta):
    """Cancelada não ocupa vaga: a turma de 1 lugar volta a receber."""
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}", data={**TURMA, "vagas": "1"}, follow_redirects=False
    )
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricao_id = s.execute(select(Inscricao)).scalar_one().id
    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
        data={"destino": "CANCELADA", "motivo": "desistiu"},
        follow_redirects=False,
    )
    resposta = cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor("2165804", "Fabrício"))},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with _sessao() as s:
        situacoes = sorted(
            i.situacao for i in s.execute(select(Inscricao)).scalars()
        )
    assert situacoes == ["CANCELADA", "INSCRITA"]


def test_cancelar_inscricao_sem_motivo_e_recusado(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricao_id = s.execute(select(Inscricao)).scalar_one().id
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
            data={"destino": "CANCELADA"},
            follow_redirects=False,
        ),
    )
    assert "exige o motivo" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).situacao == "INSCRITA"


def test_confirmar_inscricao_cancelada_e_recusado(turma_aberta):
    """Máquina F pela porta da frente: cancelada é terminal.

    Confirmar quem cancelou faria a vaga voltar a ser ocupada por alguém que
    desistiu — e a lista de presença sairia com um nome a mais.
    """
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricao_id = s.execute(select(Inscricao)).scalar_one().id
    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
        data={"destino": "CANCELADA", "motivo": "desistiu"},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
            data={"destino": "CONFIRMADA"},
            follow_redirects=False,
        ),
    )
    assert "Transição proibida" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).situacao == "CANCELADA"


def test_aprovar_por_fora_da_tela_tambem_e_recusado(turma_aberta):
    """A recusa é do serviço, não da tela: o POST direto bate na mesma guarda.

    APROVADO é estado derivado e não se escolhe por aqui nem depois da fatia 3;
    a mensagem diz isso em vez de responder "permissão negada", que mandaria a
    pessoa pedir acesso a uma porta que não existe.
    """
    from app.servicos import turma as servico_turma

    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    operador = _usuario_com("turma.inscrever")
    with _sessao() as s:
        inscricao = s.execute(select(Inscricao)).scalar_one()
        with pytest.raises(servico_turma.RegraDaTurma):
            servico_turma.mudar_situacao_inscricao(s, operador, inscricao, "APROVADO")
        with pytest.raises(servico_turma.RegraDaTurma):
            servico_turma.mudar_situacao_inscricao(s, operador, inscricao, "INVENTADA")
        s.rollback()


def test_presenca_e_resultado_nao_se_digitam(turma_aberta):
    """PRESENTE, AUSENTE, APROVADO e REPROVADO são estados DERIVADOS.

    Continuam fora do seletor de situação depois da fatia 3, e a recusa explica
    por quê: presença sai do lançamento por dia e o resultado sai do fecho da
    turma. Um botão "marcar aprovado" faria a aprovação existir sem a frequência
    que a sustenta.
    """
    from app.servicos import turma as servico_turma

    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricao_id = s.execute(select(Inscricao)).scalar_one().id
    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
        data={"destino": "CONFIRMADA"},
        follow_redirects=False,
    )
    for derivado in ("PRESENTE", "APROVADO"):
        texto = _mensagem(
            cliente,
            cliente.post(
                f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
                data={"destino": derivado},
                follow_redirects=False,
            ),
        )
        assert "não se digitam" in texto, derivado
    assert servico_turma.SITUACAO_DERIVADA
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).situacao == "CONFIRMADA"


def test_turma_cancelada_nao_recebe_inscricao(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    cliente.post(
        f"/turmas/{turma_id}/situacao",
        data={"destino": "CANCELADA", "motivo": "sem quórum"},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/inscricoes",
            data={"servidor_id": str(_criar_servidor())},
            follow_redirects=False,
        ),
    )
    assert "não recebe inscrição" in texto
    with _sessao() as s:
        assert s.execute(select(Inscricao)).first() is None


def test_inscricao_sem_ninguem_escolhido_e_recusada(turma_aberta):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    texto = _mensagem(
        cliente,
        cliente.post(f"/turmas/{turma_id}/inscricoes", data={}, follow_redirects=False),
    )
    assert "Escolha alguém já cadastrado" in texto


# =====================================================================
# Permissão
# =====================================================================
@pytest.mark.parametrize(
    "caminho,dados",
    [
        ("/turmas", {"treinamento_id": "1", **TURMA}),
        ("/turmas/1/situacao", {"destino": "INSCRICOES_ABERTAS"}),
        ("/turmas/1/inscricoes", {"nome": "Alguém", "vinculo": "VISITANTE"}),
        ("/turmas/1/instrutores", {"assinatura_instrutor_id": "1"}),
    ],
)
def test_escrita_negada_para_quem_so_consulta(
    app_cliente, contas, banco, caminho, dados
):
    """O auditor interno vê treinamento e não escreve nada.

    Uma rota de escrita por linha: a revisão da fatia 1 registrou que só uma
    das seis rotas de escrita tinha teste de negativa, e escrita é justamente
    onde a permissão importa.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)
    _criar_turma(app_cliente, treinamento_id)
    _criar_assinatura(app_cliente)

    entrar(app_cliente, contas, "auditor_interno")
    resposta = app_cliente.post(caminho, data=dados)
    assert resposta.status_code == 403, caminho


def test_secretaria_monta_a_turma_e_inscreve(app_cliente, contas, banco):
    """É a secretaria que opera a inscrição (§8 do desenho)."""
    entrar(app_cliente, contas, "coordenador_csso")
    treinamento_id = _criar_treinamento(app_cliente)

    entrar(app_cliente, contas, "secretaria_csso")
    assert _criar_turma(app_cliente, treinamento_id).status_code == 303
    turma_id = _id_da_turma()
    resposta = app_cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with _sessao() as s:
        assert s.execute(select(Inscricao)).scalar_one().situacao == "INSCRITA"


def test_a_csso_continua_achando_participante_pelo_nome_na_ficha(turma_aberta, contas):
    """A busca da ficha casa por NOME para quem pode ler nome.

    Este teste existe porque a coisa que ele guarda já se perdeu uma vez, e
    passou verde. A RN-19 chegou à busca de participante com um padrão
    deliberadamente fechado (`usuario=None` não casa nome), e a rota da ficha
    ficou chamando `buscar(s, busca)` sem repassar quem está olhando: SIAPE e
    `PTC-` continuavam achando, **nome não** — para todo mundo, inclusive a
    coordenação. Medido na época: o coordenador procurando "Adelaide" recebia
    zero achados.

    São duas perguntas diferentes e a tela precisa das duas: `ve_nominal` decide
    SE a busca acontece, e o `usuario=` decide COMO ela casa. Nenhum teste cobria
    a segunda, e por isso a regressão não fez barulho.
    """
    cliente = turma_aberta["cliente"]
    # Duas condições, e as duas custaram uma versão errada deste teste:
    #
    # 1. A pessoa tem de ser PARTICIPANTE, não só servidor — são duas buscas
    #    diferentes na mesma caixa, e quem o `usuario=` fecha é a de
    #    participantes. Com um servidor solto, o teste exercitava a outra.
    # 2. E tem de estar inscrita em OUTRA turma. Inscrita nesta, o nome dela sai
    #    na lista de inscritos e o teste passa sem a busca ter casado nada — que
    #    é exatamente a busca que ela existe para fazer: achar quem ainda NÃO
    #    está aqui, para poder inscrever.
    outra = _id_da_turma()
    assert cliente.post(
        f"/turmas/{outra}/inscricoes",
        data={"servidor_id": str(_criar_servidor())},
        follow_redirects=False,
    ).status_code == 303

    assert _criar_turma(
        cliente, turma_aberta["treinamento_id"], {"codigo": SEGUNDA}
    ).status_code == 303
    vazia = _id_da_turma(SEGUNDA)

    corpo = cliente.get(f"/turmas/{vazia}?aba=inscricoes&busca=Marco").text
    assert "Marco Antônio Alves Schetino" in corpo, (
        "a coordenação procurou pelo primeiro nome e não achou: a rota deixou de "
        "repassar o usuário para a busca, e ela caiu no padrão fechado"
    )


def test_a_ficha_da_turma_abre_para_quem_so_consulta(turma_aberta, contas):
    cliente, turma_id = turma_aberta["cliente"], turma_aberta["turma_id"]
    entrar(cliente, contas, "auditor_interno")
    corpo = cliente.get(f"/turmas/{turma_id}").text
    assert PRIMEIRA in corpo
    # sem permissão de escrita, nenhum formulário de ação aparece — e a rota
    # nega de qualquer jeito: esconder botão nunca foi guarda
    assert f'action="/turmas/{turma_id}/situacao"' not in corpo
    assert "Cadastrar participante externo" not in cliente.get(
        f"/turmas/{turma_id}?aba=inscricoes"
    ).text
