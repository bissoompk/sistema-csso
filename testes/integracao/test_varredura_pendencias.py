"""A varredura noturna de pendências de EPI — o agendador que faltava.

As duas funções de sincronização (`epi_estoque.sincronizar_pendencia_de_ca`,
`epi_ficha.sincronizar_pendencia_de_troca`) dizem, com todas as letras, que
um lote parado atravessa a janela do CA sem abrir pendência, e que um servidor
que não recebe nada de novo atravessa a data da troca sem tarefa. O que se
prova aqui é que a rotina fecha esse buraco chamando AS MESMAS funções — sem
regra nova, sem dono na tarefa, idempotente, e desfazendo tudo em `--simular`.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.modelos import (
    EpiCategoria,
    EpiEntradaEstoque,
    EpiFichaRegistro,
    EpiItem,
    EpiMovimentoEstoque,
    Pendencia,
    Servidor,
    UnidadeUorg,
)
from ferramentas import varrer_pendencias

HOJE = date.today()


def _item(s) -> EpiItem:
    categoria = s.execute(select(EpiCategoria)).scalars().first()
    item = EpiItem(nome="Luva nitrílica", categoria_id=categoria.id, exige_ca=True,
                   numero_ca="41234", validade_ca=HOJE + timedelta(days=400), quantidade_padrao=1)
    s.add(item)
    s.flush()
    return item


def _lote_parado(s, item: EpiItem, validade: date) -> EpiEntradaEstoque:
    """Um lote com saldo cujo CA vence em `validade` — gravado direto, sem
    passar pelo serviço, para NÃO disparar a sincronização por escrita. É o
    lote que ninguém mexe: exatamente o caso que a varredura existe para achar."""
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id, data_entrada=HOJE - timedelta(days=200),
        quantidade_recebida=5, numero_ca="41234", validade_ca=validade, lote="L-1",
    )
    s.add(entrada)
    s.flush()
    s.add(EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=5))
    s.flush()
    return entrada


def _abertas(s, tipo: str) -> list[Pendencia]:
    return list(
        s.execute(
            select(Pendencia).where(Pendencia.tipo == tipo, Pendencia.concluida.is_(False))
        ).scalars()
    )


def test_o_lote_parado_na_janela_do_ca_ganha_pendencia_sem_dono(sessao, atores):
    item = _item(sessao)
    _lote_parado(sessao, item, HOJE + timedelta(days=30))
    sessao.commit()
    assert _abertas(sessao, "CA_A_VENCER") == [], "gravado sem passar pelo serviço: nada aberto ainda"

    resultado = varrer_pendencias.varrer(sessao)
    sessao.commit()
    assert resultado.lotes == 1 and resultado.abertas("CA_A_VENCER") == 1
    [pendencia] = _abertas(sessao, "CA_A_VENCER")
    assert pendencia.responsavel_id is None, "a rotina não é ninguém: a tarefa nasce sem dono"
    assert "vence em" in pendencia.descricao


def test_a_varredura_e_idempotente_e_fecha_o_que_perdeu_o_objeto(sessao, atores):
    item = _item(sessao)
    entrada = _lote_parado(sessao, item, HOJE + timedelta(days=30))
    sessao.commit()
    varrer_pendencias.varrer(sessao)
    sessao.commit()
    de_novo = varrer_pendencias.varrer(sessao)
    sessao.commit()
    assert de_novo.abertas("CA_A_VENCER") == 0
    assert len(_abertas(sessao, "CA_A_VENCER")) == 1

    # o CA foi renovado: a tarefa perdeu o objeto e a MESMA passada a fecha
    entrada.validade_ca = HOJE + timedelta(days=400)
    sessao.commit()
    fechou = varrer_pendencias.varrer(sessao)
    sessao.commit()
    assert fechou.abertas("CA_A_VENCER") == -1
    assert _abertas(sessao, "CA_A_VENCER") == []


def test_a_troca_vencida_de_quem_nao_recebe_nada_ganha_pendencia(sessao, atores):
    item = _item(sessao)
    unidade = sessao.execute(select(UnidadeUorg)).scalars().first()
    servidor = Servidor(siape="1212121", nome="Alvo", unidade_uorg_id=unidade.id)
    sessao.add(servidor)
    sessao.flush()
    # entrega antiga com troca prevista para ontem — e nenhuma escrita depois
    sessao.add(
        EpiFichaRegistro(
            servidor_id=servidor.id, epi_item_id=item.id, tipo="ENTREGA", quantidade=1,
            data_evento=HOJE - timedelta(days=200), previsao_troca=HOJE - timedelta(days=1),
            nome_epi_snapshot=item.nome, categoria_snapshot="X",
            nome_servidor_snapshot=servidor.nome, siape_snapshot=servidor.siape,
            entregue_por=atores["coord"].id,
        )
    )
    sessao.commit()
    assert _abertas(sessao, "TROCA_EPI_DEVIDA") == []

    resultado = varrer_pendencias.varrer(sessao)
    sessao.commit()
    assert resultado.servidores == 1 and resultado.abertas("TROCA_EPI_DEVIDA") == 1
    [pendencia] = _abertas(sessao, "TROCA_EPI_DEVIDA")
    # RN-19: a descrição diz o servidor pelo id, nunca pelo nome
    assert "Alvo" not in pendencia.descricao and f"#{servidor.id}" in pendencia.descricao


def test_simular_mostra_e_desfaz(sessao, atores, capsys, monkeypatch):
    from app import banco as mod_banco

    item = _item(sessao)
    _lote_parado(sessao, item, HOJE + timedelta(days=30))
    sessao.commit()
    monkeypatch.setattr(varrer_pendencias, "sessao", mod_banco.sessao)

    assert varrer_pendencias.principal(["--simular"]) == 0
    saida = capsys.readouterr().out
    assert "SIMULADA" in saida and "CA_A_VENCER" in saida and "+1" in saida
    with mod_banco.sessao() as s:
        assert _abertas(s, "CA_A_VENCER") == [], "simular não pode gravar"

    assert varrer_pendencias.principal([]) == 0
    assert "Varredura feita" in capsys.readouterr().out
    with mod_banco.sessao() as s:
        assert len(_abertas(s, "CA_A_VENCER")) == 1
