"""Fatia 3 de Certificados e Treinamentos: presença, nota e conclusão.

Os cenários são do usuário e passam pela porta da frente (HTTP) sempre que
possível. Onde a granularidade da permissão não existe em nenhum perfil real —
todos os perfis operacionais recebem `turma.avaliar` junto com as outras —, o
teste monta o `UsuarioAtual` à mão e chama o serviço, que é onde a recusa mora.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.modelos import HistoricoEvento, Inscricao, Servidor, Treinamento, Turma
from app.modelos import TurmaPresenca
from app.servicos.rbac import PermissaoNegada, UsuarioAtual
from testes.integracao.conftest import entrar

INICIO = date.today() - timedelta(days=2)
FIM = INICIO
ANO = INICIO.year
PRIMEIRA = f"TUR-{ANO}-0001"

NR35 = {
    "codigo": "NR-35",
    "nome": "Trabalho em Altura — NR-35",
    "carga_horaria_horas": "8",
    "validade_meses": "24",
    "norma_referencia": "NR-35",
}

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


def _mensagem(cliente, resposta) -> str:
    assert resposta.status_code == 303, resposta.text
    return cliente.get(resposta.headers["location"]).text


def _criar_servidor(siape: str = "1110654", nome: str = "Marco Antônio") -> int:
    with _sessao() as s:
        servidor = Servidor(siape=siape, nome=nome)
        s.add(servidor)
        s.commit()
        return servidor.id


def _usuario_com(*permissoes: str, login: str = "operador") -> UsuarioAtual:
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


def _montar(cliente, *, turma: dict | None = None, treinamento: dict | None = None) -> int:
    """Catálogo + turma + a turma já em andamento, que é quando se lança."""
    resposta = cliente.post(
        "/treinamentos/catalogo",
        data={**NR35, **(treinamento or {})},
        follow_redirects=False,
    )
    assert resposta.status_code == 303, resposta.text
    with _sessao() as s:
        treinamento_id = s.execute(select(Treinamento)).scalars().first().id
    resposta = cliente.post(
        "/turmas",
        data={"treinamento_id": str(treinamento_id), **TURMA, **(turma or {})},
        follow_redirects=False,
    )
    assert resposta.status_code == 303, resposta.text
    with _sessao() as s:
        turma_id = s.execute(select(Turma)).scalars().first().id
    for destino in ("INSCRICOES_ABERTAS", "EM_ANDAMENTO"):
        assert (
            cliente.post(
                f"/turmas/{turma_id}/situacao",
                data={"destino": destino},
                follow_redirects=False,
            ).status_code
            == 303
        )
    return turma_id


def _inscrever(cliente, turma_id: int, siape: str, nome: str) -> int:
    resposta = cliente.post(
        f"/turmas/{turma_id}/inscricoes",
        data={"servidor_id": str(_criar_servidor(siape, nome))},
        follow_redirects=False,
    )
    assert resposta.status_code == 303, resposta.text
    with _sessao() as s:
        return (
            s.execute(
                select(Inscricao)
                .join(Inscricao.participante)
                .order_by(Inscricao.id.desc())
            )
            .scalars()
            .first()
            .id
        )


@pytest.fixture()
def turma_rodando(app_cliente, contas, banco):
    """Coordenador logado, turma de 8h de um dia, em andamento, com uma inscrita."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(app_cliente)
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    return {
        "cliente": app_cliente,
        "turma_id": turma_id,
        "inscricao_id": inscricao_id,
    }


def _lancar(cliente, turma_id, inscricao_id, **campos):
    dados = {
        "inscricao_id": str(inscricao_id),
        "data": INICIO.isoformat(),
        "presente": "1",
        **campos,
    }
    return cliente.post(f"/turmas/{turma_id}/presencas", data=dados, follow_redirects=False)


def _concluir(cliente, turma_id):
    return cliente.post(
        f"/turmas/{turma_id}/situacao",
        data={"destino": "CONCLUIDA"},
        follow_redirects=False,
    )


# =====================================================================
# Frequência — a conta e o denominador
# =====================================================================
def test_lancar_presenca_calcula_a_frequencia(turma_rodando):
    """A frequência é derivada do lançamento, não digitada."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    assert _lancar(cliente, turma_id, inscricao_id, horas="8").status_code == 303
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.frequencia_percentual == Decimal("100.00")
        assert inscricao.situacao == "PRESENTE"
        assert [(p.data, p.presente, p.horas) for p in inscricao.presencas] == [
            (INICIO, True, Decimal("8.0"))
        ]


def test_o_denominador_e_a_carga_da_turma_e_nao_a_do_catalogo(app_cliente, contas, banco):
    """O caso que produz número errado em silêncio.

    O catálogo diz 40h; a turma rodou em 8h (era a reciclagem, não o curso
    inteiro). Seis horas presentes valem 75% da turma — e 15% do catálogo. Usar
    o número errado aqui reprova quem passou.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(
        app_cliente,
        treinamento={"carga_horaria_horas": "40"},
        turma={"carga_horaria_horas": "8"},
    )
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    _lancar(app_cliente, turma_id, inscricao_id, horas="6")
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.turma.treinamento.carga_horaria_horas == Decimal("40.0")
        assert inscricao.turma.carga_efetiva == Decimal("8.0")
        assert inscricao.frequencia_percentual == Decimal("75.00")


def test_frequencia_na_fronteira_exata_do_minimo_aprova(app_cliente, contas, banco):
    """75% de 8h são 6h. O mínimo é "pelo menos", e a fronteira é o caso que
    decide se o certificado sai."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(app_cliente, turma={"data_fim": (INICIO + timedelta(days=1)).isoformat()})
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    _lancar(app_cliente, turma_id, inscricao_id, horas="6")
    _concluir(app_cliente, turma_id)
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
    assert inscricao.frequencia_percentual == Decimal("75.00")
    assert inscricao.situacao == "APROVADO"


def test_um_centesimo_abaixo_do_minimo_reprova(app_cliente, contas, banco):
    """5,9h de 8h dão 73,75%. Abaixo do mínimo é abaixo, e o motivo sai escrito."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(app_cliente, turma={"data_fim": (INICIO + timedelta(days=1)).isoformat()})
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    _lancar(app_cliente, turma_id, inscricao_id, horas="5,9")
    _concluir(app_cliente, turma_id)
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.frequencia_percentual == Decimal("73.75")
        assert inscricao.situacao == "REPROVADO"
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.entidade == "inscricao",
                HistoricoEvento.valor_novo == "REPROVADO",
            )
        ).scalar_one()
    assert "abaixo do mínimo de 75%" in evento.descricao


def test_total_acima_da_carga_da_turma_e_recusado(app_cliente, contas, banco):
    """Somar mais horas do que a turma teve produziria frequência acima de 100%
    — que a CHECK do banco recusa, mas tarde demais e sem explicação."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(
        app_cliente, turma={"data_fim": (INICIO + timedelta(days=1)).isoformat()}
    )
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    _lancar(app_cliente, turma_id, inscricao_id, horas="6")
    texto = _mensagem(
        app_cliente,
        _lancar(
            app_cliente,
            turma_id,
            inscricao_id,
            data=(INICIO + timedelta(days=1)).isoformat(),
            horas="4",
        ),
    )
    assert "acima da carga da turma" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).frequencia_percentual == Decimal("75.00")


def test_relancar_o_mesmo_dia_corrige_em_vez_de_somar(turma_rodando):
    """Com duas linhas para o mesmo dia a frequência somaria as duas."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _lancar(cliente, turma_id, inscricao_id, horas="4")
    _lancar(cliente, turma_id, inscricao_id, horas="8")
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert len(inscricao.presencas) == 1
        assert inscricao.frequencia_percentual == Decimal("100.00")


def test_dia_fora_do_periodo_da_turma_e_recusado(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    texto = _mensagem(
        cliente,
        _lancar(
            cliente,
            turma_id,
            inscricao_id,
            data=(INICIO + timedelta(days=30)).isoformat(),
            horas="8",
        ),
    )
    assert "não é dia de" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).presencas == []


def test_falta_nao_acumula_hora_e_a_justificativa_nao_abate(turma_rodando):
    """Justificar explica o que aconteceu; não substitui a carga ministrada."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _lancar(
        cliente,
        turma_id,
        inscricao_id,
        presente="",
        horas="8",
        justificativa="atestado médico",
    )
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.presencas[0].horas == Decimal("0.0")
        assert inscricao.presencas[0].justificativa == "atestado médico"
        assert inscricao.frequencia_percentual == Decimal("0.00")
        assert inscricao.situacao == "AUSENTE"


def test_turma_de_varios_dias_exige_as_horas_do_dia(app_cliente, contas, banco):
    """Assumir a carga inteira num dia daria 100% a quem veio um dia só."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(
        app_cliente, turma={"data_fim": (INICIO + timedelta(days=2)).isoformat()}
    )
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    texto = _mensagem(app_cliente, _lancar(app_cliente, turma_id, inscricao_id))
    assert "informe as horas deste dia" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).presencas == []


# =====================================================================
# Marcar todos presentes
# =====================================================================
def test_marcar_todos_presentes_no_curso_de_um_dia(turma_rodando):
    cliente, turma_id = turma_rodando["cliente"], turma_rodando["turma_id"]
    _inscrever(cliente, turma_id, "2165804", "Fabrício Andrade")
    resposta = cliente.post(
        f"/turmas/{turma_id}/presencas/todos", data={}, follow_redirects=False
    )
    assert resposta.status_code == 303
    with _sessao() as s:
        inscricoes = list(s.execute(select(Inscricao)).scalars())
        assert len(inscricoes) == 2
        for inscricao in inscricoes:
            assert inscricao.situacao == "PRESENTE"
            assert inscricao.frequencia_percentual == Decimal("100.00")
            assert [p.horas for p in inscricao.presencas] == [Decimal("8.0")]


def test_marcar_todos_presentes_e_recusado_em_turma_de_varios_dias(
    app_cliente, contas, banco
):
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(
        app_cliente, turma={"data_fim": (INICIO + timedelta(days=2)).isoformat()}
    )
    _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    texto = _mensagem(
        app_cliente,
        app_cliente.post(
            f"/turmas/{turma_id}/presencas/todos", data={}, follow_redirects=False
        ),
    )
    assert "marque dia a dia" in texto
    with _sessao() as s:
        assert s.execute(select(TurmaPresenca)).first() is None
    # e o botão nem aparece na tela, para não fazer a pessoa tentar
    assert "Marcar todos presentes" not in app_cliente.get(
        f"/turmas/{turma_id}?aba=presencas"
    ).text


def test_inscricao_cancelada_fica_de_fora_do_lote(turma_rodando):
    """Quem cancelou não assina folha e não recebe presença."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    outra = _inscrever(cliente, turma_id, "2165804", "Fabrício Andrade")
    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{outra}",
        data={"destino": "CANCELADA", "motivo": "desistiu"},
        follow_redirects=False,
    )
    cliente.post(f"/turmas/{turma_id}/presencas/todos", data={}, follow_redirects=False)
    with _sessao() as s:
        assert s.get(Inscricao, outra).presencas == []
        assert s.get(Inscricao, outra).situacao == "CANCELADA"
        assert s.get(Inscricao, inscricao_id).situacao == "PRESENTE"


def test_lancar_para_inscricao_cancelada_e_recusado(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
        data={"destino": "CANCELADA", "motivo": "desistiu"},
        follow_redirects=False,
    )
    texto = _mensagem(cliente, _lancar(cliente, turma_id, inscricao_id, horas="8"))
    assert "não recebe lançamento" in texto


def test_lancar_em_turma_planejada_e_recusado(app_cliente, contas, banco):
    """A turma nem começou: lançar presença aí é registrar o que não aconteceu."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post("/treinamentos/catalogo", data=NR35, follow_redirects=False)
    assert resposta.status_code == 303
    with _sessao() as s:
        treinamento_id = s.execute(select(Treinamento)).scalars().first().id
    app_cliente.post(
        "/turmas",
        data={"treinamento_id": str(treinamento_id), **TURMA},
        follow_redirects=False,
    )
    with _sessao() as s:
        turma_id = s.execute(select(Turma)).scalars().first().id
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    texto = _mensagem(app_cliente, _lancar(app_cliente, turma_id, inscricao_id, horas="8"))
    assert "passe a turma para em andamento" in texto
    with _sessao() as s:
        assert s.execute(select(TurmaPresenca)).first() is None


# =====================================================================
# Nota
# =====================================================================
def test_lancar_nota_e_apagar_nota(turma_rodando):
    """Campo em branco NÃO apaga: apagar tem botão próprio.

    É a lição do achado 5 da revisão da fatia 1 aplicada a um campo em que o
    estrago seria reprovar quem passou.
    """
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    cliente.post(
        f"/turmas/{turma_id}/notas",
        data={"inscricao_id": str(inscricao_id), "nota": "9,5"},
        follow_redirects=False,
    )
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).nota_final == Decimal("9.50")

    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/notas",
            data={"inscricao_id": str(inscricao_id), "nota": ""},
            follow_redirects=False,
        ),
    )
    assert "não apaga o que já está lançado" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).nota_final == Decimal("9.50")

    cliente.post(
        f"/turmas/{turma_id}/notas",
        data={"inscricao_id": str(inscricao_id), "apagar": "1"},
        follow_redirects=False,
    )
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).nota_final is None


def test_nota_fora_da_faixa_e_recusada(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/notas",
            data={"inscricao_id": str(inscricao_id), "nota": "11"},
            follow_redirects=False,
        ),
    )
    assert "entre 0 e 10" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).nota_final is None


def test_turma_sem_nota_minima_aprova_so_pela_frequencia(turma_rodando):
    """`nota_minima_aprovacao` nula = o treinamento não avalia (§11, item 4)."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _lancar(cliente, turma_id, inscricao_id, horas="8")
    _concluir(cliente, turma_id)
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.turma.nota_minima_aprovacao is None
        assert inscricao.nota_final is None
        assert inscricao.situacao == "APROVADO"


def test_turma_com_nota_minima_reprova_quem_nao_tem_nota(app_cliente, contas, banco):
    """Aprovar sem a nota que a própria turma exigiu dispensaria a prova em
    silêncio."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(app_cliente, turma={"nota_minima_aprovacao": "7"})
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    _lancar(app_cliente, turma_id, inscricao_id, horas="8")
    _concluir(app_cliente, turma_id)
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.frequencia_percentual == Decimal("100.00")
        assert inscricao.situacao == "REPROVADO"
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.entidade == "inscricao",
                HistoricoEvento.valor_novo == "REPROVADO",
            )
        ).scalar_one()
    assert "nota não lançada" in evento.descricao


def test_nota_abaixo_da_minima_reprova_com_frequencia_cheia(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(app_cliente, turma={"nota_minima_aprovacao": "7"})
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    _lancar(app_cliente, turma_id, inscricao_id, horas="8")
    app_cliente.post(
        f"/turmas/{turma_id}/notas",
        data={"inscricao_id": str(inscricao_id), "nota": "6,5"},
        follow_redirects=False,
    )
    _concluir(app_cliente, turma_id)
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).situacao == "REPROVADO"


# =====================================================================
# Conclusão da turma — o mesmo ato
# =====================================================================
def test_concluir_apura_todo_mundo_no_mesmo_ato(turma_rodando):
    """Concluir deixou de ser só um carimbo: calcula e atribui resultado."""
    cliente = turma_rodando["cliente"]
    turma_id, presente_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    faltoso_id = _inscrever(cliente, turma_id, "2165804", "Fabrício Andrade")
    _lancar(cliente, turma_id, presente_id, horas="8")

    assert _concluir(cliente, turma_id).status_code == 303
    with _sessao() as s:
        turma = s.get(Turma, turma_id)
        assert turma.situacao == "CONCLUIDA"
        assert turma.concluida_em is not None
        assert s.get(Inscricao, presente_id).situacao == "APROVADO"
        faltoso = s.get(Inscricao, faltoso_id)
        # §7: inscrição sem presença registrada vira AUSENTE e daí REPROVADO
        assert faltoso.situacao == "REPROVADO"
        assert faltoso.frequencia_percentual == Decimal("0.00")
        estados = [
            (e.valor_anterior, e.valor_novo)
            for e in s.execute(
                select(HistoricoEvento)
                .where(
                    HistoricoEvento.entidade == "inscricao",
                    HistoricoEvento.entidade_id == faltoso_id,
                    HistoricoEvento.campo == "situacao",
                )
                .order_by(HistoricoEvento.id)
            ).scalars()
        ]
        resumo = s.execute(
            select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "TURMA_APURADA")
        ).scalar_one()
    assert estados == [("INSCRITA", "AUSENTE"), ("AUSENTE", "REPROVADO")]
    assert "1 aprovado(s), 1 reprovado(s)" in resumo.descricao


def test_concluir_turma_sem_ninguem_inscrito(app_cliente, contas, banco):
    """A turma aconteceu e ninguém veio: é resultado legítimo, e recusar o fecho
    deixaria a turma aberta para sempre."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(app_cliente)
    assert _concluir(app_cliente, turma_id).status_code == 303
    with _sessao() as s:
        assert s.get(Turma, turma_id).situacao == "CONCLUIDA"
        resumo = s.execute(
            select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "TURMA_APURADA")
        ).scalar_one()
    assert "nenhum inscrito a apurar" in resumo.descricao


def test_conclusao_nao_apura_quem_cancelou(turma_rodando):
    """Cancelada saiu por ato próprio, com motivo: o fecho não a transforma em
    reprovada."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{inscricao_id}",
        data={"destino": "CANCELADA", "motivo": "mudou de setor"},
        follow_redirects=False,
    )
    _concluir(cliente, turma_id)
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.situacao == "CANCELADA"
        assert inscricao.frequencia_percentual is None


# =====================================================================
# Retificação depois do fecho
# =====================================================================
def test_retificar_depois_do_fecho_exige_motivo_e_vira_o_resultado(turma_rodando):
    """O caso concreto que abriu APROVADO <-> REPROVADO.

    A turma fechou e Marco consta reprovado por falta que ninguém lançou. Sem a
    retificação a única saída seria SQL à mão; com ela, a correção é um ato com
    motivo, recálculo e trilha.
    """
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _concluir(cliente, turma_id)
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).situacao == "REPROVADO"

    sem_motivo = _mensagem(cliente, _lancar(cliente, turma_id, inscricao_id, horas="8"))
    assert "retificação exige o motivo" in sem_motivo
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).situacao == "REPROVADO"
        assert s.execute(select(TurmaPresenca)).first() is None

    assert (
        _lancar(
            cliente,
            turma_id,
            inscricao_id,
            horas="8",
            motivo="folha do dia 1 chegou depois do fecho",
        ).status_code
        == 303
    )
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.situacao == "APROVADO"
        assert inscricao.frequencia_percentual == Decimal("100.00")
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "RESULTADO_RETIFICADO"
            )
        ).scalar_one()
    assert (evento.valor_anterior, evento.valor_novo) == ("REPROVADO", "APROVADO")
    assert evento.comentario == "folha do dia 1 chegou depois do fecho"


def test_retificar_exige_a_permissao_de_concluir(turma_rodando):
    """Desfazer resultado já comunicado é decisão de quem responde pela turma —
    mesma simetria do parecer, em que o técnico emite e não anula."""
    from app.servicos import presenca as servico_presenca

    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _concluir(turma_rodando["cliente"], turma_id)
    avaliador = _usuario_com("turma.avaliar")
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        with pytest.raises(PermissaoNegada) as erro:
            servico_presenca.lancar_presenca(
                s,
                avaliador,
                inscricao,
                data=INICIO,
                horas=Decimal(8),
                motivo="qualquer",
            )
        assert erro.value.codigo == "turma.concluir"
        s.rollback()


def test_retificar_nota_reavalia_o_resultado(app_cliente, contas, banco):
    cliente = app_cliente
    entrar(cliente, contas, "coordenador_csso")
    turma_id = _montar(cliente, turma={"nota_minima_aprovacao": "7"})
    inscricao_id = _inscrever(cliente, turma_id, "1110654", "Marco Antônio")
    _lancar(cliente, turma_id, inscricao_id, horas="8")
    cliente.post(
        f"/turmas/{turma_id}/notas",
        data={"inscricao_id": str(inscricao_id), "nota": "5"},
        follow_redirects=False,
    )
    _concluir(cliente, turma_id)
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).situacao == "REPROVADO"
    cliente.post(
        f"/turmas/{turma_id}/notas",
        data={
            "inscricao_id": str(inscricao_id),
            "nota": "8",
            "motivo": "erro de digitação conferido na prova",
        },
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        assert (inscricao.nota_final, inscricao.situacao) == (Decimal("8.00"), "APROVADO")


def test_turma_cancelada_nao_recebe_lancamento(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    cliente.post(
        f"/turmas/{turma_id}/situacao",
        data={"destino": "CANCELADA", "motivo": "instrutor adoeceu"},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente, _lancar(cliente, turma_id, inscricao_id, horas="8", motivo="tentativa")
    )
    assert "passe a turma para em andamento" in texto


# =====================================================================
# Recusa deixa o banco limpo — o bug de transação da fatia 2
# =====================================================================
@pytest.mark.parametrize(
    "campos,trecho",
    [
        ({"horas": "99"}, "passa da carga da turma"),
        ({"horas": "8", "data": (INICIO + timedelta(days=90)).isoformat()},
         "não é dia de"),
    ],
    ids=["horas-acima-da-carga", "dia-fora-do-periodo"],
)
def test_recusa_de_presenca_nao_deixa_nada_gravado(turma_rodando, campos, trecho):
    """A sessão do FastAPI dá commit ao terminar a rota, mesmo quando a rota
    devolveu recusa. Sem o rollback explícito, a linha do dia ficaria gravada
    com a mensagem de erro na tela — e a frequência passaria a contar um dia que
    o sistema disse ter recusado.
    """
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    texto = _mensagem(cliente, _lancar(cliente, turma_id, inscricao_id, **campos))
    assert trecho in texto
    with _sessao() as s:
        assert s.execute(select(TurmaPresenca)).first() is None
        inscricao = s.get(Inscricao, inscricao_id)
        assert inscricao.frequencia_percentual is None
        assert inscricao.situacao == "INSCRITA"


def test_recusa_de_nota_nao_deixa_nada_gravado(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    cliente.post(
        f"/turmas/{turma_id}/notas",
        data={"inscricao_id": str(inscricao_id), "nota": "8"},
        follow_redirects=False,
    )
    texto = _mensagem(
        cliente,
        cliente.post(
            f"/turmas/{turma_id}/notas",
            data={"inscricao_id": str(inscricao_id), "nota": "-1"},
            follow_redirects=False,
        ),
    )
    assert "entre 0 e 10" in texto
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).nota_final == Decimal("8.00")


def test_lancamento_em_inscricao_de_outra_turma_e_recusado(turma_rodando, banco):
    """O escopo filtra a turma, não a inscrição: sem a conferência, a presença
    entraria na turma errada — com a carga horária de outra."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    with _sessao() as s:
        treinamento_id = s.execute(select(Treinamento)).scalars().first().id
    cliente.post(
        "/turmas",
        data={"treinamento_id": str(treinamento_id), **TURMA},
        follow_redirects=False,
    )
    with _sessao() as s:
        outra = s.execute(
            select(Turma).where(Turma.id != turma_id)
        ).scalars().first()
        outra_id = outra.id
    texto = _mensagem(cliente, _lancar(cliente, outra_id, inscricao_id, horas="8"))
    assert "Inscrição não encontrada nesta turma" in texto
    with _sessao() as s:
        assert s.execute(select(TurmaPresenca)).first() is None


# =====================================================================
# Permissão
# =====================================================================
@pytest.mark.parametrize(
    "caminho,dados",
    [
        ("/presencas", {"inscricao_id": "1", "data": INICIO.isoformat(), "presente": "1"}),
        ("/presencas/todos", {}),
        ("/notas", {"inscricao_id": "1", "nota": "8"}),
    ],
)
def test_escrita_negada_para_quem_so_consulta(turma_rodando, contas, caminho, dados):
    """O auditor interno vê treinamento e não lança nada."""
    cliente, turma_id = turma_rodando["cliente"], turma_rodando["turma_id"]
    entrar(cliente, contas, "auditor_interno")
    assert cliente.post(f"/turmas/{turma_id}{caminho}", data=dados).status_code == 403


def test_lista_de_presenca_negada_para_quem_so_consulta(turma_rodando, contas):
    cliente, turma_id = turma_rodando["cliente"], turma_rodando["turma_id"]
    entrar(cliente, contas, "auditor_interno")
    assert cliente.get(f"/turmas/{turma_id}/lista-presenca").status_code == 403


def test_lancar_sem_permissao_de_avaliar_e_negado(turma_rodando):
    """A guarda é do serviço: quem chama por fora bate na mesma porta."""
    from app.servicos import presenca as servico_presenca

    inscricao_id = turma_rodando["inscricao_id"]
    sem_permissao = _usuario_com("turma.inscrever", login="so_inscreve")
    with _sessao() as s:
        inscricao = s.get(Inscricao, inscricao_id)
        with pytest.raises(PermissaoNegada) as erro:
            servico_presenca.lancar_presenca(
                s, sem_permissao, inscricao, data=INICIO, horas=Decimal(8)
            )
        assert erro.value.codigo == "turma.avaliar"
        s.rollback()


def test_a_secretaria_lanca_presenca(app_cliente, contas, banco):
    """É a secretaria que opera a turma (§8 do desenho)."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(app_cliente)
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    entrar(app_cliente, contas, "secretaria_csso")
    assert _lancar(app_cliente, turma_id, inscricao_id, horas="8").status_code == 303
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).frequencia_percentual == Decimal("100.00")


# =====================================================================
# Aba 3 e lista de presença
# =====================================================================
def test_aba_de_presenca_mostra_a_grade_e_destaca_quem_esta_abaixo(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _lancar(cliente, turma_id, inscricao_id, horas="4")
    corpo = cliente.get(f"/turmas/{turma_id}?aba=presencas").text
    assert "Presença e notas" in corpo
    assert "Marco Antônio" in corpo
    assert "50.00%" in corpo
    assert "abaixo do mínimo de 75%" in corpo


def test_a_aba_abre_em_leitura_para_quem_so_consulta(turma_rodando, contas):
    """Auditor vê a grade e não recebe formulário nenhum — nem o de baixar a
    folha, que é ato de quem opera a turma. A rota nega de qualquer jeito:
    esconder botão nunca foi guarda."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _lancar(cliente, turma_id, inscricao_id, horas="8")
    entrar(cliente, contas, "auditor_interno")
    corpo = cliente.get(f"/turmas/{turma_id}?aba=presencas").text
    assert "Marco Antônio" in corpo
    assert "100.00%" in corpo
    assert f'action="/turmas/{turma_id}/presencas"' not in corpo
    assert f'action="/turmas/{turma_id}/notas"' not in corpo
    assert "lista-presenca" not in corpo


def test_lista_de_presenca_sai_em_docx(turma_rodando):
    """Critério de pronto da fatia: a folha sai pelo mecanismo de documento que
    já existe, com os inscritos de hoje."""
    from app.servicos import documento

    cliente, turma_id = turma_rodando["cliente"], turma_rodando["turma_id"]
    _inscrever(cliente, turma_id, "2165804", "Fabrício Andrade")
    resposta = cliente.get(f"/turmas/{turma_id}/lista-presenca")
    assert resposta.status_code == 200
    assert resposta.headers["content-type"].startswith(
        "application/vnd.openxmlformats"
    )
    # o código da turma entra inteiro no nome: é por ele que alguém procura a
    # folha na pasta de documentos
    assert f"Lista_Presenca_{PRIMEIRA}.docx" in resposta.headers["content-disposition"]

    from app.servicos import lista_presenca as servico_lista

    with _sessao() as s:
        turma = s.get(Turma, turma_id)
        caminho = servico_lista.caminho_saida(turma)
    texto = documento.extrair_texto(caminho)
    assert "LISTA DE PRESENÇA" in texto
    assert PRIMEIRA in texto
    assert "Marco Antônio" in texto
    assert "Fabrício Andrade" in texto
    assert "8 horas" in texto
    assert "Assinatura" in texto


def test_lista_de_presenca_nao_traz_quem_cancelou(turma_rodando):
    """Deixar o nome de quem desistiu na folha faria alguém assinar por ele."""
    from app.servicos import documento, lista_presenca as servico_lista

    cliente = turma_rodando["cliente"]
    turma_id = turma_rodando["turma_id"]
    outra = _inscrever(cliente, turma_id, "2165804", "Fabrício Andrade")
    cliente.post(
        f"/turmas/{turma_id}/inscricoes/{outra}",
        data={"destino": "CANCELADA", "motivo": "desistiu"},
        follow_redirects=False,
    )
    assert cliente.get(f"/turmas/{turma_id}/lista-presenca").status_code == 200
    with _sessao() as s:
        caminho = servico_lista.caminho_saida(s.get(Turma, turma_id))
    texto = documento.extrair_texto(caminho)
    assert "Marco Antônio" in texto
    assert "Fabrício Andrade" not in texto


def test_gerar_a_lista_entra_na_auditoria(turma_rodando):
    cliente, turma_id = turma_rodando["cliente"], turma_rodando["turma_id"]
    cliente.get(f"/turmas/{turma_id}/lista-presenca")
    with _sessao() as s:
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "LISTA_PRESENCA_GERADA"
            )
        ).scalar_one()
    assert PRIMEIRA in evento.descricao
    assert "1 participante(s)" in evento.descricao


def test_a_trilha_registra_cada_lancamento(turma_rodando):
    """Todo lançamento entra na auditoria, com o antes e o depois."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _lancar(cliente, turma_id, inscricao_id, horas="4")
    _lancar(cliente, turma_id, inscricao_id, horas="8")
    with _sessao() as s:
        eventos = list(
            s.execute(
                select(HistoricoEvento)
                .where(HistoricoEvento.tipo_evento == "PRESENCA_LANCADA")
                .order_by(HistoricoEvento.id)
            ).scalars()
        )
    assert len(eventos) == 2
    assert "frequência 50%" in eventos[0].descricao
    assert "frequência 100%" in eventos[1].descricao
    assert "antes: presente, 4h" in eventos[1].descricao
    # `valor_*` é JSONTexto e `Decimal` não tem forma em JSON: `default=str` o
    # converte em texto na ida e ele volta texto. A conversão é estável — é isso
    # que o digest da cadeia exige —, e a integridade em si está coberta em
    # `test_auditoria_integridade.py`.
    assert (eventos[1].valor_anterior, eventos[1].valor_novo) == ("50.00", "100.00")


def test_a_cadeia_de_auditoria_continua_integra(turma_rodando):
    from app.servicos import auditoria

    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    _lancar(cliente, turma_id, inscricao_id, horas="8")
    _concluir(cliente, turma_id)
    with _sessao() as s:
        ok, defeito = auditoria.cadeia_integra(s)
    assert ok, defeito


# =====================================================================
# A troca parcial da grade — 150 lançamentos sem 150 recargas
# =====================================================================
def test_lancar_presenca_por_htmx_devolve_a_linha_e_nao_a_pagina(turma_rodando):
    """Turma de 30 x 5 dias sao 150 lancamentos; a pagina inteira nao volta.

    O que volta e a LINHA, e nao a celula: lancar um dia recalcula horas,
    frequencia e situacao, que moram em outras tres colunas. Celula sozinha
    deixaria numero velho na tela ao lado da escolha nova — o mesmo defeito que
    o seletor de tamanho tinha antes da 1.27.0.
    """
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    resposta = cliente.post(
        f"/turmas/{turma_id}/presencas",
        data={
            "inscricao_id": str(inscricao_id),
            "data": INICIO.isoformat(),
            "presente": "1",
            "horas": "8",
        },
        headers={"HX-Request": "true"},
        follow_redirects=False,
    )
    assert resposta.status_code == 200, resposta.text
    corpo = resposta.text
    assert corpo.lstrip().startswith("<tr"), corpo[:200]
    assert "<html" not in corpo, "voltou a pagina inteira em vez da linha"
    # as tres colunas derivadas vieram recalculadas junto: horas, frequencia e
    # situacao. E aqui que a linha inteira se paga contra a celula sozinha.
    assert "100.00%" in corpo
    assert '<td class="mono">8h</td>' in corpo
    assert "Presente" in corpo
    # e o formulario que voltou continua sendo um formulario de verdade
    assert 'method="post"' in corpo and 'hx-post="/turmas/' in corpo
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).frequencia_percentual == Decimal("100.00")


def test_sem_htmx_a_mesma_rota_continua_respondendo_303(turma_rodando):
    """O `<form method=post>` continua sendo um form: sem JavaScript nada muda."""
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    resposta = _lancar(cliente, turma_id, inscricao_id, horas="8")
    assert resposta.status_code == 303
    assert resposta.headers["location"].endswith("#grade-presenca"), (
        "o 303 sem ancora devolve o topo da pagina a quem estava na linha 27"
    )


def test_a_recusa_de_regra_volta_em_200_com_o_motivo_na_celula(app_cliente, contas, banco):
    """Recusa de regra nao e falha de rede.

    Devolvendo 4xx, o tratador global de `base.html` escreveria "nao deu para
    atualizar este trecho (erro 422)" por cima de um motivo que o servico sabe
    dizer com todas as letras.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(
        app_cliente, turma={"data_fim": (INICIO + timedelta(days=2)).isoformat()}
    )
    inscricao_id = _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    resposta = app_cliente.post(
        f"/turmas/{turma_id}/presencas",
        data={
            "inscricao_id": str(inscricao_id),
            "data": INICIO.isoformat(),
            "presente": "1",
            "horas": "",  # turma de varios dias: o servico pede o numero
        },
        headers={"HX-Request": "true"},
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    assert "informe as horas deste dia" in resposta.text.lower()
    assert "recusa-na-celula" in resposta.text
    with _sessao() as s:
        assert s.execute(select(TurmaPresenca)).first() is None


def test_lancar_nota_por_htmx_devolve_a_linha(turma_rodando):
    cliente = turma_rodando["cliente"]
    turma_id, inscricao_id = turma_rodando["turma_id"], turma_rodando["inscricao_id"]
    resposta = cliente.post(
        f"/turmas/{turma_id}/notas",
        data={"inscricao_id": str(inscricao_id), "nota": "9,5"},
        headers={"HX-Request": "true"},
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    assert resposta.text.lstrip().startswith("<tr")
    with _sessao() as s:
        assert s.get(Inscricao, inscricao_id).nota_final == Decimal("9.5")


# =====================================================================
# O botao por coluna — a folha de um dia
# =====================================================================
def test_marcar_a_coluna_lanca_o_dia_para_todos(app_cliente, contas, banco):
    """A unidade do meio: uma folha por dia, que e como ela chega assinada."""
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(
        app_cliente, turma={"data_fim": (INICIO + timedelta(days=1)).isoformat()}
    )
    _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    _inscrever(app_cliente, turma_id, "1110655", "Joana Silva")
    resposta = app_cliente.post(
        f"/turmas/{turma_id}/presencas/dia",
        data={"data": INICIO.isoformat(), "horas": "4"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert resposta.headers["location"].endswith("#grade-presenca")
    with _sessao() as s:
        marcas = list(s.execute(select(TurmaPresenca)).scalars())
    assert len(marcas) == 2
    assert {(m.data, m.presente, m.horas) for m in marcas} == {
        (INICIO, True, Decimal("4.0"))
    }


def test_a_coluna_recusa_dia_que_nao_e_da_turma(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    turma_id = _montar(
        app_cliente, turma={"data_fim": (INICIO + timedelta(days=1)).isoformat()}
    )
    _inscrever(app_cliente, turma_id, "1110654", "Marco Antônio")
    texto = _mensagem(
        app_cliente,
        app_cliente.post(
            f"/turmas/{turma_id}/presencas/dia",
            data={"data": (INICIO + timedelta(days=9)).isoformat(), "horas": "4"},
            follow_redirects=False,
        ),
    )
    assert "não é dia de" in texto
    with _sessao() as s:
        assert s.execute(select(TurmaPresenca)).first() is None