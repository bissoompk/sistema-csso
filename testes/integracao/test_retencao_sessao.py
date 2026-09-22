"""`sessao` guarda IP: 90 dias apos expirar e eliminacao, cumprida pelo mecanismo.

`docs/POLITICA_RETENCAO.md` SS2.1. Ate a 1.42.2 o prazo era so declarado.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select

from app.modelos import Sessao, Usuario, agora_utc
from app.servicos import autenticacao


def _sessao(s, usuario_id: int, expirou_ha_dias: float, revogada: bool = False) -> int:
    expira = agora_utc() - timedelta(days=expirou_ha_dias)
    registro = Sessao(
        token_hash=f"{usuario_id}-{expirou_ha_dias}-{revogada}".ljust(64, "0")[:64],
        usuario_id=usuario_id,
        criada_em=expira - timedelta(hours=12),
        expira_em=expira,
        ip="10.0.73.50",
        revogada=revogada,
    )
    s.add(registro)
    s.flush()
    return registro.id


def _conta(s) -> int:
    return s.execute(select(Usuario).where(Usuario.login == "coordenador_csso")).scalar_one().id


def test_expurgo_apaga_so_o_que_passou_do_prazo(banco, contas):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        usuario_id = _conta(s)
        vencida = _sessao(s, usuario_id, 91)
        vencida_revogada = _sessao(s, usuario_id, 200, revogada=True)
        no_prazo = _sessao(s, usuario_id, 89)
        viva = _sessao(s, usuario_id, -0.5)

    with mod_banco.sessao() as s:
        assert autenticacao.expurgar_sessoes(s) == 2

    with mod_banco.sessao() as s:
        restantes = set(s.execute(select(Sessao.id)).scalars())
    assert vencida not in restantes
    assert vencida_revogada not in restantes
    # dentro do prazo fica, mesmo expirada: e evidencia de quem entrou de onde
    assert {no_prazo, viva} <= restantes


def test_o_prazo_e_o_mesmo_do_registro_de_acesso(banco, contas, monkeypatch):
    """Os dois guardam o mesmo IP; dois prazos seria politica que se contradiz."""
    from app import banco as mod_banco
    from app.config import obter_config

    monkeypatch.setattr(obter_config(), "log_retencao_dias", 30)
    with mod_banco.sessao() as s:
        usuario_id = _conta(s)
        _sessao(s, usuario_id, 31)
        _sessao(s, usuario_id, 29)
    with mod_banco.sessao() as s:
        assert autenticacao.expurgar_sessoes(s) == 1


def test_o_login_poda_a_tabela(app_cliente, contas):
    """E o login que faz a tabela crescer; e ele que a poda, sem depender de o
    servidor ser reiniciado."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        _sessao(s, _conta(s), 120)

    resposta = app_cliente.post(
        "/login",
        data={"login": "coordenador_csso", "senha": "SenhaDeTeste2026"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        limite = agora_utc() - timedelta(days=90)
        velhas = s.execute(
            select(func.count()).select_from(Sessao).where(Sessao.expira_em < limite)
        ).scalar_one()
        vivas = s.execute(select(func.count()).select_from(Sessao)).scalar_one()
    assert velhas == 0
    # e a sessao que o proprio login acabou de abrir continua la
    assert vivas >= 1


def test_a_sessao_do_login_continua_valendo(app_cliente, contas):
    resposta = app_cliente.post(
        "/login",
        data={"login": "coordenador_csso", "senha": "SenhaDeTeste2026"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert app_cliente.get("/", follow_redirects=False).status_code == 200
