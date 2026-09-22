"""Demandas — o que chega por e-mail ou no balcão e ainda não é processo SEI.

O que estes testes guardam, na ordem em que a funcionalidade perde o valor se
falhar:

1. **O desfecho é obrigatório para encerrar**, e cada um dos quatro cobra a sua
   prova. Sem isso, "encerrar" vira "arquivar" e a lista volta a ser a caixa de
   e-mail, onde as coisas somem sem ninguém conseguir dizer o que houve delas.
2. **`VIROU_PROCESSO` aponta para um `processo.id` real.** É a rastreabilidade
   que a funcionalidade promete, e ela só existe se der para clicar — por isso
   o NUP de um processo que não está cadastrado é recusado, e a recusa diz onde
   cadastrá-lo.
3. **O prazo cobra.** Com prazo, a demanda entra no mesmo sino das pendências e
   sai dele ao encerrar; sem prazo, não abre tarefa nenhuma.
4. **RN-21 em todo texto livre, e a recusa preserva o que foi digitado.** Este é
   o campo mais perigoso do sistema: é onde alguém escreve, com pressa, o dado
   de saúde que ouviu no balcão.
5. **RN-31 no encaminhamento** — a trava é de banco, não de disciplina.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError

from app.modelos import Demanda, DemandaEncaminhamento, Pendencia, Processo
from testes.integracao.conftest import entrar

HOJE = date.today()
NOME_SERVIDOR = "Marco Antônio Alves Schetino"
SIAPE = "1110654"


# ---------------------------------------------------------------------
# Ajudantes
# ---------------------------------------------------------------------
def _registrar(cliente, **campos):
    dados = {
        "assunto": "Chefia da FAMED pergunta sobre laudo do laboratório",
        "canal": "EMAIL",
        "solicitante_nome": "Chefia da FAMED",
        "data_chegada": HOJE.isoformat(),
        "descricao": "Pediu orientação sobre o laudo do laboratório de análises.",
    }
    dados.update(campos)
    return cliente.post("/demandas", data=dados, follow_redirects=False)


def _id_da_criada(resposta) -> int:
    assert resposta.status_code == 303, resposta.text
    return int(resposta.headers["location"].split("/demandas/")[1].split("?")[0])


@pytest.fixture()
def demanda(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    return _id_da_criada(_registrar(app_cliente))


@pytest.fixture()
def processo_no_sistema(app_cliente, contas):
    """Um processo SEI de verdade, criado pela rota que o cria."""
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    assert criado.status_code == 303
    return "23086.021284/2024-56"


# =====================================================================
# 1. Registro — e os três padrões que fazem caber em trinta segundos
# =====================================================================
def test_registrar_preenche_hoje_e_o_proprio_usuario(app_cliente, contas, banco):
    """Se registrar der trabalho, ninguém registra — e a lista vazia não é
    sinal de que não há demanda."""
    from app import banco as mod_banco
    from app.modelos import Usuario

    entrar(app_cliente, contas, "coordenador_csso")
    # sem data e sem responsável: os dois padrões têm de sair do serviço
    demanda_id = _id_da_criada(_registrar(app_cliente, data_chegada="", responsavel_id=""))

    with mod_banco.sessao() as s:
        gravada = s.get(Demanda, demanda_id)
        quem = s.execute(
            sa.select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        assert gravada.data_chegada == HOJE
        assert gravada.responsavel_id == quem.id
        assert gravada.estado == "ABERTA"
        assert gravada.desfecho is None


def test_o_canal_e_vocabulario_fechado(app_cliente, contas, banco):
    """Texto livre aqui devolveria 'email', 'e-mail' e 'correio eletrônico' na
    mesma coluna — e a pergunta que o campo responde é contável."""
    entrar(app_cliente, contas, "coordenador_csso")
    recusa = _registrar(app_cliente, canal="POMBO_CORREIO")
    assert recusa.status_code == 200
    assert "Canal desconhecido" in recusa.text


def test_assunto_em_branco_nao_vira_linha_na_fila(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    recusa = _registrar(app_cliente, assunto="   ")
    assert recusa.status_code == 200
    assert "O assunto é obrigatório" in recusa.text


# =====================================================================
# 2. RN-21 — o campo mais perigoso do sistema, e a recusa que não apaga
# =====================================================================
@pytest.mark.parametrize(
    "campo,valor",
    [
        ("descricao", "A servidora está grávida e pediu remoção do laboratório."),
        ("assunto", "Atestado médico da servidora do LEAC"),
        ("solicitante_nome", "Servidora com doença ocupacional"),
    ],
)
def test_rn21_recusa_dado_de_saude_em_todo_texto_livre(
    app_cliente, contas, banco, campo, valor
):
    entrar(app_cliente, contas, "coordenador_csso")
    recusa = _registrar(app_cliente, **{campo: valor})
    assert recusa.status_code == 200
    assert "termo proibido" in recusa.text


def test_rn21_recusada_devolve_o_popup_aberto_com_o_que_foi_digitado(
    app_cliente, contas, banco
):
    """A recusa que apaga o texto ensina a escrever menos, não a escrever
    melhor — e o texto aqui foi escrito ouvindo a pessoa falar."""
    import re

    entrar(app_cliente, contas, "coordenador_csso")
    corpo = _registrar(
        app_cliente,
        assunto="Pedido de avaliação do laboratório",
        solicitante_nome="Chefia do LEAC",
        descricao="A servidora está grávida e pediu remoção.",
        prazo=(HOJE + timedelta(days=7)).isoformat(),
    ).text

    assert re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo) == [
        "nova-demanda"
    ]
    assert 'value="Pedido de avaliação do laboratório"' in corpo
    assert 'value="Chefia do LEAC"' in corpo
    assert "A servidora está grávida e pediu remoção." in corpo
    assert f'value="{(HOJE + timedelta(days=7)).isoformat()}"' in corpo


def test_rn21_nada_e_gravado_na_recusa(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _registrar(app_cliente, descricao="Tem diagnóstico de LER no laudo.")
    with mod_banco.sessao() as s:
        assert s.execute(sa.select(sa.func.count()).select_from(Demanda)).scalar() == 0


# =====================================================================
# 3. Encaminhamento — append-only (RN-31)
# =====================================================================
def test_encaminhar_poe_a_demanda_em_andamento(app_cliente, contas, banco, demanda):
    """Pedir alguma coisa a alguém É estar cuidando dela; cobrar um segundo
    clique para dizer isso produziria uma fila de "abertas" com três
    encaminhamentos cada."""
    from app import banco as mod_banco

    resposta = app_cliente.post(
        f"/demandas/{demanda}/encaminhar",
        data={
            "para_quem": "Engenharia de Segurança",
            "pedido": "Avaliar o posto e dizer se cabe laudo novo.",
            "data_encaminhamento": HOJE.isoformat(),
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        gravada = s.get(Demanda, demanda)
        assert gravada.estado == "EM_ANDAMENTO"
        assert len(gravada.encaminhamentos) == 1
        assert gravada.encaminhamentos[0].para_quem == "Engenharia de Segurança"


def test_encaminhamento_sem_o_que_foi_pedido_e_recusado(
    app_cliente, contas, banco, demanda
):
    corpo = app_cliente.post(
        f"/demandas/{demanda}/encaminhar",
        data={"para_quem": "PROGEP", "pedido": "  "},
    ).text
    assert "Escreva o que foi pedido" in corpo


def test_rn31_o_encaminhamento_nao_se_edita_nem_se_apaga(sessao, banco):
    """A trava é de banco, e não de disciplina: a linha diz que em tal dia se
    pediu tal coisa a tal pessoa, e quem cobra é quem escreveu."""
    demanda = Demanda(
        data_chegada=HOJE,
        canal="PRESENCIAL",
        solicitante_nome="Balcão",
        assunto="teste da trava",
        estado="ABERTA",
    )
    sessao.add(demanda)
    sessao.flush()
    linha = DemandaEncaminhamento(
        demanda_id=demanda.id,
        data_encaminhamento=HOJE,
        para_quem="PROGEP",
        pedido="conferir a lotação",
    )
    sessao.add(linha)
    # `commit`, e não `flush`: o `rollback` da primeira recusa desfaria a
    # inserção junto, e o `DELETE` seguinte não encontraria linha nenhuma para
    # a trava recusar — o teste passaria sem ter medido a segunda metade.
    sessao.commit()

    # `Exception` e não a classe exata, como em `test_epi_estoque`: o que
    # importa é o ABORT do banco chegar com a razão escrita nele.
    with pytest.raises(Exception, match="append-only"):
        sessao.execute(
            sa.text("UPDATE demanda_encaminhamento SET para_quem = 'outro'")
        )
    sessao.rollback()
    with pytest.raises(Exception, match="append-only"):
        sessao.execute(sa.text("DELETE FROM demanda_encaminhamento"))
    sessao.rollback()


# =====================================================================
# 4. Encerramento com desfecho obrigatório — onde está o valor
# =====================================================================
def test_encerrar_sem_desfecho_e_recusado(app_cliente, contas, banco, demanda):
    corpo = app_cliente.post(
        f"/demandas/{demanda}/encerrar", data={"desfecho": ""}
    ).text
    assert "Escolha um desfecho" in corpo


@pytest.mark.parametrize("desfecho", ["RESOLVIDA", "SEM_PROVIDENCIA"])
def test_os_dois_desfechos_narrativos_exigem_o_texto(
    app_cliente, contas, banco, demanda, desfecho
):
    """"Não vamos fazer nada" é decisão legítima — o que não pode é ela ser
    tomada por esquecimento."""
    corpo = app_cliente.post(
        f"/demandas/{demanda}/encerrar", data={"desfecho": desfecho, "relato": " "}
    ).text
    assert "Falta o desfecho por escrito" in corpo


def test_encerrar_resolvida_grava_o_que_foi_feito(app_cliente, contas, banco, demanda):
    from app import banco as mod_banco

    resposta = app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={
            "desfecho": "RESOLVIDA",
            "relato": "Respondi por e-mail com o laudo vigente do posto.",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        gravada = s.get(Demanda, demanda)
        assert gravada.estado == "ENCERRADA"
        assert gravada.desfecho == "RESOLVIDA"
        assert "laudo vigente" in gravada.desfecho_relato
        assert gravada.encerrada_por is not None


def test_encaminhada_exige_o_setor(app_cliente, contas, banco, demanda):
    corpo = app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={"desfecho": "ENCAMINHADA", "setor": ""},
    ).text
    assert "Diga para qual setor" in corpo


def test_encaminhada_grava_setor_e_data(app_cliente, contas, banco, demanda):
    from app import banco as mod_banco

    app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={
            "desfecho": "ENCAMINHADA",
            "setor": "PROGEP",
            "data_desfecho": HOJE.isoformat(),
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        gravada = s.get(Demanda, demanda)
        assert (gravada.desfecho_setor, gravada.desfecho_data) == ("PROGEP", HOJE)


def test_encerrada_nao_recebe_mais_encaminhamento(app_cliente, contas, banco, demanda):
    app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={"desfecho": "RESOLVIDA", "relato": "respondido por e-mail"},
        follow_redirects=False,
    )
    corpo = app_cliente.post(
        f"/demandas/{demanda}/encaminhar",
        data={"para_quem": "PROGEP", "pedido": "cobrar de novo"},
    ).text
    assert "não recebe encaminhamento" in corpo


def test_encerrada_e_terminal(app_cliente, contas, banco, demanda):
    """Reabrir apagaria o desfecho, que é a única coisa que esta tabela existe
    para guardar."""
    app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={"desfecho": "RESOLVIDA", "relato": "respondido por e-mail"},
        follow_redirects=False,
    )
    segunda = app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={"desfecho": "SEM_PROVIDENCIA", "relato": "mudei de ideia"},
        follow_redirects=True,
    )
    assert "Transição proibida" in segunda.text


# =====================================================================
# 5. VIROU_PROCESSO — a rastreabilidade que só vale se der para clicar
# =====================================================================
def test_virou_processo_liga_a_demanda_ao_processo_real(
    app_cliente, contas, banco, processo_no_sistema
):
    from app import banco as mod_banco

    demanda_id = _id_da_criada(_registrar(app_cliente))
    resposta = app_cliente.post(
        f"/demandas/{demanda_id}/encerrar",
        data={"desfecho": "VIROU_PROCESSO", "nup": processo_no_sistema},
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        gravada = s.get(Demanda, demanda_id)
        processo = s.execute(
            sa.select(Processo).where(Processo.nup == processo_no_sistema)
        ).scalar_one()
        assert gravada.desfecho == "VIROU_PROCESSO"
        assert gravada.desfecho_processo_id == processo.id

    # e a ficha oferece o link, que é a razão de a FK existir
    corpo = app_cliente.get(f"/demandas/{demanda_id}").text
    assert f'href="/processos/{processo.id}"' in corpo


def test_nup_de_processo_inexistente_recusa_dizendo_onde_cadastrar(
    app_cliente, contas, banco, demanda
):
    """A decisão registrada: aceitar o NUP como texto seria uma segunda fonte
    para o mesmo número, sem `unique` e sem o CHECK de formato de
    `processo.nup` — e a promessa de clicar e chegar no processo ficaria sem a
    coisa."""
    corpo = app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={"desfecho": "VIROU_PROCESSO", "nup": "23086.000608/2026-84"},
    ).text
    assert "Não há processo 23086.000608/2026-84 cadastrado" in corpo
    assert "Novo processo" in corpo


def test_nup_mal_formado_recusa_com_o_formato(app_cliente, contas, banco, demanda):
    corpo = app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={"desfecho": "VIROU_PROCESSO", "nup": "123"},
    ).text
    assert "não é um NUP" in corpo


def test_nup_colado_sujo_e_aceito(app_cliente, contas, banco, processo_no_sistema):
    """O NUP vem de copiar-e-colar do SEI; `nup.normalizar` tira a sujeira."""
    demanda_id = _id_da_criada(_registrar(app_cliente))
    resposta = app_cliente.post(
        f"/demandas/{demanda_id}/encerrar",
        data={"desfecho": "VIROU_PROCESSO", "nup": " 23086 021284 2024 56 "},
        follow_redirects=False,
    )
    assert resposta.status_code == 303


def test_o_banco_recusa_desfecho_sem_a_prova_que_ele_exige(sessao, banco):
    """A CHECK é a camada que vale quando alguém grava direto pelo modelo."""
    sessao.add(
        Demanda(
            data_chegada=HOJE,
            canal="EMAIL",
            solicitante_nome="X",
            assunto="virou processo sem processo",
            estado="ENCERRADA",
            desfecho="VIROU_PROCESSO",
        )
    )
    with pytest.raises(IntegrityError, match="ck_demanda_desfecho_campos"):
        sessao.flush()
    sessao.rollback()


def test_o_banco_recusa_encerrar_sem_desfecho(sessao, banco):
    sessao.add(
        Demanda(
            data_chegada=HOJE,
            canal="EMAIL",
            solicitante_nome="X",
            assunto="encerrada sem dizer como",
            estado="ENCERRADA",
        )
    )
    with pytest.raises(IntegrityError, match="ck_demanda_encerrada_tem_desfecho"):
        sessao.flush()
    sessao.rollback()


# =====================================================================
# 6. O prazo cobra — a demanda no mesmo sino das pendências
# =====================================================================
def test_demanda_com_prazo_abre_pendencia_ancorada(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    demanda_id = _id_da_criada(
        _registrar(app_cliente, prazo=(HOJE + timedelta(days=5)).isoformat())
    )
    with mod_banco.sessao() as s:
        tarefa = s.execute(
            sa.select(Pendencia).where(Pendencia.chave == f"demanda:{demanda_id}")
        ).scalar_one()
        assert tarefa.tipo == "DEMANDA_COM_PRAZO"
        assert (tarefa.entidade, tarefa.entidade_id) == ("demanda", demanda_id)
        assert tarefa.prazo == HOJE + timedelta(days=5)
        assert not tarefa.concluida


def test_demanda_sem_prazo_nao_enche_o_sino(app_cliente, contas, banco):
    """Uma tarefa por demanda registrada encheria o sino de coisa que ninguém
    prometeu para data nenhuma — e sino que grita sempre deixa de ser lido."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    demanda_id = _id_da_criada(_registrar(app_cliente, prazo=""))
    with mod_banco.sessao() as s:
        assert (
            s.execute(
                sa.select(Pendencia).where(Pendencia.chave == f"demanda:{demanda_id}")
            ).scalar_one_or_none()
            is None
        )


def test_encerrar_tira_a_demanda_do_sino(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    demanda_id = _id_da_criada(
        _registrar(app_cliente, prazo=(HOJE + timedelta(days=5)).isoformat())
    )
    app_cliente.post(
        f"/demandas/{demanda_id}/encerrar",
        data={"desfecho": "SEM_PROVIDENCIA", "relato": "o posto foi desativado"},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        tarefa = s.execute(
            sa.select(Pendencia).where(Pendencia.chave == f"demanda:{demanda_id}")
        ).scalar_one()
        assert tarefa.concluida


def test_a_demanda_atrasada_aparece_no_sino_e_leva_ate_ela(app_cliente, contas, banco):
    """O vermelho e a âncora: a tarefa do sino tem de abrir a demanda, e não
    mostrar a descrição sem levar a lugar nenhum."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    demanda_id = _id_da_criada(
        _registrar(app_cliente, prazo=(HOJE - timedelta(days=3)).isoformat())
    )
    with mod_banco.sessao() as s:
        assert s.get(Demanda, demanda_id).atrasada(HOJE)

    corpo = app_cliente.get("/pendencias").text
    assert "Demanda com prazo a cumprir" in corpo
    # a âncora da fila carrega o caminho de volta (`?de=pendencias`)
    assert f'href="/demandas/{demanda_id}?de=pendencias"' in corpo
    # e o sino do cabeçalho conta a atrasada
    assert 'class="sino' in corpo


def test_trocar_o_responsavel_leva_a_tarefa_junto(app_cliente, contas, banco):
    """Demanda que só uma pessoa vê some quando ela entra de férias — e tarefa
    com o dono errado é tarefa que ninguém lê."""
    from app import banco as mod_banco
    from app.modelos import Usuario

    entrar(app_cliente, contas, "coordenador_csso")
    demanda_id = _id_da_criada(
        _registrar(app_cliente, prazo=(HOJE + timedelta(days=5)).isoformat())
    )
    with mod_banco.sessao() as s:
        outro = s.execute(
            sa.select(Usuario).where(Usuario.login == "tecnico_seguranca")
        ).scalar_one().id

    app_cliente.post(
        f"/demandas/{demanda_id}/atribuir",
        data={"responsavel_id": str(outro)},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.get(Demanda, demanda_id).responsavel_id == outro
        tarefa = s.execute(
            sa.select(Pendencia).where(Pendencia.chave == f"demanda:{demanda_id}")
        ).scalar_one()
        assert tarefa.responsavel_id == outro


# =====================================================================
# 7. RN-19 — onde há servidor, o nome sai por `identificar(...)`
# =====================================================================
@pytest.fixture()
def servidor_id(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/servidores",
        data={"siape": SIAPE, "nome": NOME_SERVIDOR},
        follow_redirects=False,
    )
    return int(criado.headers["location"].rsplit("/", 1)[-1].split("?")[0])


def test_rn19_a_lista_suprime_o_servidor_vinculado(app_cliente, contas, servidor_id):
    """Havendo vínculo, quem manda é `identificar(...)` — e a secretaria não
    tem `exposicao.ver`."""
    import re

    _registrar(
        app_cliente,
        solicitante_nome="pedido do laboratório",
        solicitante_servidor_id=str(servidor_id),
    )
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/demandas").text
    assert NOME_SERVIDOR not in corpo
    assert SIAPE not in corpo
    assert re.findall(r"SRV-[0-9a-f]{4}\b", corpo)


def test_rn19_quem_ve_nominal_continua_lendo_o_nome(app_cliente, contas, servidor_id):
    demanda_id = _id_da_criada(
        _registrar(
            app_cliente,
            solicitante_nome="pedido do laboratório",
            solicitante_servidor_id=str(servidor_id),
        )
    )
    for caminho in ("/demandas", f"/demandas/{demanda_id}"):
        assert NOME_SERVIDOR in app_cliente.get(caminho).text, caminho


def test_a_busca_nao_e_oraculo_de_nome(app_cliente, contas, servidor_id):
    """A busca olha o ASSUNTO. Casar por nome devolveria uma linha e amarraria
    o nome ao código opaco da sessão — o oráculo que a RN-19 fecha.

    A asserção é sobre a LINHA da fila, e não sobre a presença de um `SRV-xxxx`
    na página: o seletor de servidor do popup de cadastro já imprime um por
    servidor do cadastro, e procurar o código solto daria um teste que nunca
    passa — e que, se alguém o "consertasse" afrouxando-o, deixaria de guardar
    coisa nenhuma.
    """
    _registrar(
        app_cliente,
        assunto="Avaliação do laboratório de análises",
        solicitante_nome=NOME_SERVIDOR,
        solicitante_servidor_id=str(servidor_id),
    )
    entrar(app_cliente, contas, "secretaria_csso")
    por_nome = app_cliente.get("/demandas?q=Marco").text
    assert "Avaliação do laboratório de análises" not in por_nome
    assert "Nenhuma demanda nesta seleção." in por_nome
    assert NOME_SERVIDOR not in por_nome

    por_assunto = app_cliente.get("/demandas?q=laboratório").text
    assert "Avaliação do laboratório de análises" in por_assunto


# =====================================================================
# 8. Permissão — a equipe toda enxerga, e nem toda ela escreve
# =====================================================================
def test_admin_ti_nao_ve_a_fila(app_cliente, contas, banco):
    """Sem conteúdo técnico — e demanda é conteúdo técnico do setor."""
    entrar(app_cliente, contas, "admin_ti")
    assert app_cliente.get("/demandas").status_code == 403
    assert 'href="/demandas"' not in app_cliente.get("/modulos").text


def test_o_auditor_le_e_nao_escreve(app_cliente, contas, banco, demanda):
    entrar(app_cliente, contas, "auditor_interno")
    corpo = app_cliente.get("/demandas")
    assert corpo.status_code == 200
    ficha = app_cliente.get(f"/demandas/{demanda}").text
    assert "somente leitura" in ficha
    assert (
        app_cliente.post(
            f"/demandas/{demanda}/encerrar",
            data={"desfecho": "RESOLVIDA", "relato": "x"},
            follow_redirects=False,
        ).status_code
        == 403
    )


def test_o_seletor_de_responsavel_so_oferece_quem_abre_a_tela(
    app_cliente, contas, banco
):
    """Tarefa com dono que o dono não consegue abrir é lista que ninguém lê.

    O `admin_ti` não tem `demanda.ver` por decisão de projeto (sem conteúdo
    técnico): oferecê-lo no seletor lhe daria uma linha no sino, o nome em
    `responsavel_id` e 403 no link dela — o mesmo modo de falha que
    `pendencias.PERMISSOES_VER` existe para impedir.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/demandas").text
    dentro = corpo[corpo.index('id="responsavel_id"') :]
    seletor = dentro[: dentro.index("</select>")]
    assert "Coordenador de Teste" in seletor
    assert "Almoxarife de Teste" in seletor
    assert "Admin TI de Teste" not in seletor
    assert "Servidor de Teste" not in seletor


def test_o_almoxarife_registra_o_que_chega_no_balcao(app_cliente, contas, banco):
    """O canal PRESENCIAL é dele: mandar quem está no balcão "avisar alguém da
    CSSO" é o caminho por onde a demanda se perde hoje."""
    entrar(app_cliente, contas, "almoxarife_sesmt")
    assert app_cliente.get("/demandas").status_code == 200
    assert _registrar(app_cliente, canal="PRESENCIAL").status_code == 303


# =====================================================================
# 9. A trilha de auditoria
# =====================================================================
def test_toda_transicao_deixa_rastro_na_cadeia(app_cliente, contas, banco, demanda):
    from app import banco as mod_banco
    from app.modelos import HistoricoEvento
    from app.servicos.auditoria import ROTULO_EVENTO, cadeia_integra

    app_cliente.post(f"/demandas/{demanda}/iniciar", follow_redirects=False)
    app_cliente.post(
        f"/demandas/{demanda}/encaminhar",
        data={"para_quem": "PROGEP", "pedido": "conferir a lotação"},
        follow_redirects=False,
    )
    app_cliente.post(
        f"/demandas/{demanda}/encerrar",
        data={"desfecho": "RESOLVIDA", "relato": "a PROGEP respondeu"},
        follow_redirects=False,
    )

    with mod_banco.sessao() as s:
        tipos = [
            e.tipo_evento
            for e in s.execute(
                sa.select(HistoricoEvento).where(HistoricoEvento.entidade == "demanda")
            ).scalars()
        ]
        assert cadeia_integra(s)[0]

    for esperado in (
        "DEMANDA_REGISTRADA",
        "DEMANDA_EM_ANDAMENTO",
        "DEMANDA_ENCAMINHADA",
        "DEMANDA_ENCERRADA",
    ):
        assert esperado in tipos, esperado
        assert esperado in ROTULO_EVENTO, esperado
