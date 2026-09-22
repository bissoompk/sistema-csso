"""O servidor comum alcança o que é dele — e continua sem alcançar o dos outros.

A 1.35.0 fechou o escopo: a fila de EPI deixou de entregar o pedido de todo
mundo a quem tinha `epi.ver`. Este arquivo guarda a outra metade, que é onde o
fechamento pode virar tranca: **o titular tem de continuar alcançando o próprio
certificado e a própria ficha**, e tem de conseguir CHEGAR neles.

Os dois casos que este arquivo prova, e que são o mesmo caso:

1. **O certificado.** `Certificado.servidor_id` existe desde a fatia 4 e foi
   denormalizado exatamente para o escopo próprio (`treinamento.py`, SS8), e
   `certificados.py` já chamava `aplicar_escopo` — só que depois de um
   `exigir("certificado.ver")` que barrava antes. Fechadura instalada, chave
   nunca entregue.
2. **A ficha de EPI.** A regra "`epi.ficha` ou próprio" estava construída e
   testada (`test_epi_ficha.py`), e não tinha caminho: o único `href` para a
   ficha própria saía de `/servidores`, que pede `processo.ver` — permissão de
   OUTRO módulo, que ninguém garante que este perfil vai continuar tendo.

E o invariante que nenhuma das duas pode quebrar: `certificado.ver` continua
sendo a permissão de ler o de outro, e ler o de outro continua sendo registrado.
"""

from __future__ import annotations

import concurrent.futures
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.modelos import (
    AcessoDadoSensivel,
    Certificado,
    Inscricao,
    Pendencia,
    Servidor,
    Treinamento,
    Turma,
    Usuario,
)
from app.servicos import participante as servico_participante
from app.servicos import turma as servico_turma
from app.servicos.autenticacao import gerar_hash
from app.servicos.certificado import montar_chave
from app.servicos.rbac import UsuarioAtual
from testes.integracao.conftest import entrar
from testes.integracao.test_certificados import _cenario, _usuario

MEUS = "/certificados/meus"
MINHA_FICHA = "/epis/fichas/minha"
MINHAS_TURMAS = "/turmas/minhas"

# O perfil real do servidor comum, para os testes que chamam o serviço direto.
# É a lista de `rbac.MATRIZ_PERFIS['servidor_consulta']`, e ela importa: um teste
# que passasse com `TODAS` provaria que o serviço funciona, não que ELE alcança.
SERVIDOR = frozenset(
    {
        "processo.ver", "parecer.ver", "treinamento.ver", "turma.inscrever_se",
        "epi.ver", "epi.requisitar",
    }
)


def _sessao():
    from app import banco as mod_banco

    return mod_banco.sessao()


@pytest.fixture()
def titular(app_cliente, contas, banco):
    """Um certificado emitido, e a conta `servidor_consulta` amarrada ao titular.

    A amarração é o que a suíte não tinha: sem `usuario.servidor_id`,
    `aplicar_escopo` filtra por `servidor_id == -1` e todo escopo próprio
    devolve lista vazia — o perfil passava nos testes sem nunca exercitar a
    condição que ele existe para exercitar.
    """
    with _sessao() as s:
        montador = _usuario(s, login="montador")
        dados = _cenario(s, montador)
        ids = {
            "turma_id": dados["turma"].id,
            "inscricao_id": dados["inscricao"].id,
            "servidor_id": dados["servidor"].id,
        }

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        f"/turmas/{ids['turma_id']}/certificados",
        data={"inscricao_id": str(ids["inscricao_id"])},
        follow_redirects=False,
    )
    app_cliente.get("/sair")

    with _sessao() as s:
        certificado = s.execute(select(Certificado)).scalars().one()
        ids["certificado_id"] = certificado.id
        ids["chave"] = certificado.chave_validacao
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = ids["servidor_id"]
        # um certificado de OUTRA pessoa, para medir o que continua fechado
        outro = Servidor(siape="5550001", nome="Carlos de Outro Setor")
        s.add(outro)
        s.flush()
        alheio = Certificado(
            inscricao_id=certificado.inscricao_id,
            numero=certificado.numero + 1,
            ano=certificado.ano,
            # chave própria, montada pela função da emissão: a coluna é única, e
            # derivar a do vizinho trocando um caractere colide quando o sorteio
            # já terminava naquele caractere
            chave_validacao=montar_chave(certificado.ano, "3QRST4VWXY"),
            situacao="ANULADO",
            motivo_anulacao="cópia de teste, para medir o alcance de terceiro",
            data_emissao=certificado.data_emissao,
            data_base_vencimento=certificado.data_base_vencimento,
            data_vencimento=certificado.data_vencimento,
            validade_meses_congelada=certificado.validade_meses_congelada,
            contexto_congelado=dict(certificado.contexto_congelado),
            modelo_arquivo=certificado.modelo_arquivo,
            servidor_id=outro.id,
            treinamento_id=certificado.treinamento_id,
            participante_id=certificado.participante_id,
        )
        s.add(alheio)
        s.commit()
        ids["alheio_id"] = alheio.id
        ids["outro_servidor_id"] = outro.id
    return ids


def _acessos(campo: str) -> int:
    with _sessao() as s:
        return len(
            list(
                s.execute(
                    select(AcessoDadoSensivel).where(AcessoDadoSensivel.campo == campo)
                ).scalars()
            )
        )


# =====================================================================
# O certificado
# =====================================================================
def test_o_titular_abre_o_proprio_certificado_sem_certificado_ver(app_cliente, contas, titular):
    """LGPD art. 18, II — e `certificado.ver` continua fora do perfil.

    O que abre a ficha para ele é `treinamento.ver`, que o §8 do desenho já lhe
    dava "(escopo próprio)". A permissão que ele NÃO tem continua sendo a de ler
    o certificado de outra pessoa, e a lista nominal do setor continua fechada.
    """
    entrar(app_cliente, contas, "servidor_consulta")
    cid = titular["certificado_id"]

    assert app_cliente.get(f"/certificados/{cid}").status_code == 200
    assert app_cliente.get(f"/certificados/{cid}/documento").status_code == 200
    assert app_cliente.get(MEUS).status_code == 200
    # a lista do setor continua sendo a lista do setor
    assert app_cliente.get("/certificados").status_code == 403


def test_o_certificado_de_outro_continua_fora_de_alcance(app_cliente, contas, titular):
    """O 303 é o mesmo para "de outro" e para "não existe".

    Distinguir os dois transformaria a URL num contador de certificados
    emitidos — a mesma razão pela qual `/epis/fichas/{id}` responde 403 tanto
    para id de terceiro quanto para id inexistente.
    """
    entrar(app_cliente, contas, "servidor_consulta")
    alheio = app_cliente.get(
        f"/certificados/{titular['alheio_id']}", follow_redirects=False
    )
    inexistente = app_cliente.get("/certificados/99999", follow_redirects=False)
    assert alheio.status_code == 303
    assert inexistente.status_code == 303
    assert alheio.headers["location"] == inexistente.headers["location"] == MEUS
    # e o documento também não sai
    assert (
        app_cliente.get(
            f"/certificados/{titular['alheio_id']}/documento", follow_redirects=False
        ).status_code
        == 303
    )


def test_ler_o_proprio_certificado_nao_grava_acesso_sensivel(app_cliente, contas, titular):
    """Decisão da 1.35.0: o titular lendo o dele não é leitura de dado de outro.

    A linha diria "o titular leu o dele", que não responde nenhuma pergunta de
    investigação — e encheria a tabela que o `docs/ROPA.md` §6 promete para
    responder "quem abriu o dado de quantas pessoas".
    """
    antes = _acessos("certificado")
    entrar(app_cliente, contas, "servidor_consulta")
    cid = titular["certificado_id"]
    app_cliente.get(f"/certificados/{cid}")
    app_cliente.get(f"/certificados/{cid}/documento")
    assert _acessos("certificado") == antes


def test_ler_o_certificado_de_outro_grava_acesso_sensivel(app_cliente, contas, titular):
    """A outra metade da mesma regra — e o §5 do desenho já a prometia."""
    antes = _acessos("certificado")
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get(f"/certificados/{titular['certificado_id']}").status_code == 200
    assert _acessos("certificado") == antes + 1


def test_meus_certificados_lista_so_os_do_titular(app_cliente, contas, titular):
    entrar(app_cliente, contas, "servidor_consulta")
    corpo = app_cliente.get(MEUS).text
    assert "1 certificado(s) emitido(s) em seu nome" in corpo
    assert f'href="/certificados/{titular["certificado_id"]}"' in corpo
    assert f'href="/certificados/{titular["alheio_id"]}"' not in corpo


def test_meus_certificados_explica_a_conta_sem_servidor(app_cliente, contas, banco):
    """Conta sem cadastro de servidor recebe tela, e não 403 nem lista muda.

    É a condição do `almoxarife_sesmt` e do `admin_ti` reais: "nenhum
    certificado" e "não há de quem" são coisas diferentes, e a segunda tem
    conserto — que a tela escreve.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get(MEUS)
    assert resposta.status_code == 200
    assert "não está ligada a um cadastro de servidor" in resposta.text


def test_o_menu_do_servidor_oferece_o_que_e_dele(app_cliente, contas, titular):
    """O item novo aparece para ele, e o da lista nominal continua sumindo."""
    entrar(app_cliente, contas, "servidor_consulta")
    menu = app_cliente.get("/modulos").text
    assert 'href="/certificados/meus"' in menu
    assert 'href="/epis/fichas/minha"' in menu
    assert 'href="/certificados"' not in menu
    assert 'href="/epis/fichas"' not in menu


# =====================================================================
# A ficha de EPI
# =====================================================================
def test_minha_ficha_leva_a_ficha_do_titular(app_cliente, contas, titular):
    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get(MINHA_FICHA, follow_redirects=False)
    assert resposta.status_code == 303
    assert resposta.headers["location"] == f"/epis/fichas/{titular['servidor_id']}"
    assert app_cliente.get(MINHA_FICHA).status_code == 200


def test_minha_ficha_sem_cadastro_de_servidor_e_tela_e_nao_403(app_cliente, contas, banco):
    """403 aqui faria o menu oferecer porta trancada a quem tem `epi.ver`.

    `secretaria_csso` é o caso exato: tem `epi.ver` (abre a fila e o catálogo),
    **não** tem `epi.ficha` (a lista nominal continua 403) e a conta dela não
    está amarrada a um `Servidor`. Os dois itens de EPI que ela vê no menu têm de
    abrir, e é a soma das três condições que o atalho precisava atravessar.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get(MINHA_FICHA)
    assert resposta.status_code == 200
    assert "não está ligada a um cadastro de servidor" in resposta.text
    # e a lista nominal continua fechada para quem não tem `epi.ficha`
    assert app_cliente.get("/epis/fichas").status_code == 403


def test_a_ficha_de_outro_continua_403_para_o_titular(app_cliente, contas, titular):
    entrar(app_cliente, contas, "servidor_consulta")
    assert app_cliente.get(f"/epis/fichas/{titular['servidor_id']}").status_code == 200
    assert (
        app_cliente.get(f"/epis/fichas/{titular['outro_servidor_id']}").status_code == 403
    )


# =====================================================================
# A turma: ver que ela existe, e pedir a própria vaga
# =====================================================================
INICIO_FUTURO = date.today() + timedelta(days=30)


def _turma_aberta(s, usuario, *, vagas=2, aberta_ate=None, codigo="NR-35"):
    treinamento = Treinamento(
        codigo=codigo,
        nome=f"{codigo} — Trabalho em Altura",
        carga_horaria_horas=Decimal(8),
        conteudo_programatico="Análise de risco\nEquipamentos",
        validade_meses=24,
        norma_referencia=codigo,
    )
    s.add(treinamento)
    s.flush()
    turma = servico_turma.criar_turma(
        s,
        usuario,
        treinamento=treinamento,
        data_inicio=INICIO_FUTURO,
        data_fim=INICIO_FUTURO,
        local="Auditório do Campus JK",
        vagas=vagas,
        inscricao_aberta_ate=aberta_ate or (date.today() + timedelta(days=10)),
    )
    servico_turma.mudar_situacao(s, usuario, turma, "INSCRICOES_ABERTAS")
    return turma


@pytest.fixture()
def turma_com_vaga(app_cliente, contas, banco):
    """Uma turma com inscrições abertas e vinte vagas, e a conta amarrada.

    É o cenário exato da auditoria: turma em `INSCRICOES_ABERTAS`, com vaga, e a
    conta `servidor_consulta` ligada a um `Servidor`. Sem a amarração,
    `usuario.servidor_id` é `None` e nada do escopo próprio chega a ser
    exercitado.
    """
    with _sessao() as s:
        montador = _usuario(s, login="montador-turma")
        turma = _turma_aberta(s, montador, vagas=20)
        eu = Servidor(siape="7654321", nome="Joana Ribeiro de Almeida")
        outro = Servidor(siape="7654322", nome="Carlos de Outro Setor")
        s.add_all([eu, outro])
        s.flush()
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = eu.id
        ids = {
            "turma_id": turma.id,
            "codigo": turma.codigo,
            "servidor_id": eu.id,
            "outro_servidor_id": outro.id,
        }
        s.commit()
    return ids


def test_a_lista_de_turmas_deixa_de_mentir_para_o_escopo_proprio(
    app_cliente, contas, turma_com_vaga
):
    """O defeito medido: 200 com "Nenhuma turma aberta ainda", havendo turma.

    `aplicar_escopo` procurava `servidor_id` em `Turma`, não achava e devolvia
    `where(False)`. A tela não negava — ela AFIRMAVA um fato falso, e ainda
    mandava pedir `turma.criar`, que não era o problema.
    """
    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get("/turmas")
    assert resposta.status_code == 200
    assert "Nenhuma turma aberta ainda" not in resposta.text
    assert turma_com_vaga["codigo"] in resposta.text


def test_o_antes_e_o_depois_do_escopo_sobre_a_turma(turma_com_vaga):
    """A medida do defeito, presa por teste — e a razão do ramo novo.

    `aplicar_escopo` sobre `Turma` em escopo próprio continua devolvendo zero, e
    tem de continuar: `Turma` não tem `servidor_id`, e o `where(False)` com
    `log.warning` é a resposta certa de uma função genérica que não sabe o que
    "próprio" quer dizer naquele modelo. O que estava errado era a PERGUNTA — e é
    ela que `consulta_no_escopo` corrige, dizendo que a oferta é cartaz.
    """
    from app.servicos.rbac import aplicar_escopo

    servidor = UsuarioAtual(
        id=1,
        login="serv",
        nome="Servidor",
        permissoes=SERVIDOR,
        perfis=("servidor_consulta",),
        servidor_id=turma_com_vaga["servidor_id"],
    )
    with _sessao() as s:
        antes = list(
            s.execute(aplicar_escopo(select(Turma), servidor, Turma)).scalars()
        )
        depois = list(s.execute(servico_turma.consulta_no_escopo(servidor)).scalars())
    assert antes == []
    assert [t.codigo for t in depois] == [turma_com_vaga["codigo"]]


def test_a_ficha_da_turma_abre_o_cartaz_e_nao_a_lista_de_inscritos(
    app_cliente, contas, turma_com_vaga
):
    """Abrir a lista de turmas não pode abrir junto a lista de quem está nelas.

    O escopo da turma deixou de recortar porque a oferta é cartaz. A ficha tem
    três abas NOMINAIS, e elas continuam fechadas — `?aba=inscricoes` chega à
    rota mesmo com a aba escondida, e é a rota que recusa.
    """
    with _sessao() as s:
        montador = _usuario(s, login="inscritor")
        turma = s.get(Turma, turma_com_vaga["turma_id"])
        outro = s.get(Servidor, turma_com_vaga["outro_servidor_id"])
        pessoa = servico_participante.de_servidor(s, outro, montador)
        servico_turma.inscrever(s, montador, turma, pessoa)
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    corpo = app_cliente.get(f"/turmas/{turma_com_vaga['turma_id']}?aba=inscricoes").text
    assert turma_com_vaga["codigo"] in corpo
    assert "Carlos de Outro Setor" not in corpo

    # e para quem opera a turma a aba continua abrindo, com o nome
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get(f"/turmas/{turma_com_vaga['turma_id']}?aba=inscricoes").text
    assert "Carlos de Outro Setor" in corpo


def test_o_servidor_se_inscreve_de_ponta_a_ponta(app_cliente, contas, turma_com_vaga):
    """A jornada inteira pela tela: menu → lista → botão → inscrição pedida."""
    entrar(app_cliente, contas, "servidor_consulta")
    assert 'href="/turmas/minhas"' in app_cliente.get("/modulos").text

    tela = app_cliente.get(MINHAS_TURMAS)
    assert tela.status_code == 200
    assert turma_com_vaga["codigo"] in tela.text
    assert "Quero me inscrever" in tela.text

    resposta = app_cliente.post(
        f"/turmas/{turma_com_vaga['turma_id']}/inscrever-me", follow_redirects=True
    )
    assert resposta.status_code == 200
    assert "Inscrição pedida" in resposta.text

    with _sessao() as s:
        inscricao = s.execute(select(Inscricao)).scalars().one()
        assert inscricao.situacao == "INSCRITA"
        assert inscricao.participante.servidor_id == turma_com_vaga["servidor_id"]

    # o botão não se repete: a tela passa a dizer que ele já está inscrito
    de_novo = app_cliente.get(MINHAS_TURMAS).text
    assert "já inscrito" in de_novo
    assert "aguardando confirmação da CSSO" in de_novo


def test_a_rota_de_inscricao_propria_nao_aceita_quem(
    app_cliente, contas, turma_com_vaga
):
    """A propriedade de segurança da fatia: não há onde escrever "outra pessoa".

    O teste TENTA — manda `servidor_id`, `participante_id` e `inscricao_id` de
    terceiro no corpo do POST — e exige que a inscrição criada seja a do titular
    da sessão, e nenhuma outra. A recusa não é uma comparação dentro do serviço:
    é a ausência do parâmetro na rota.
    """
    entrar(app_cliente, contas, "servidor_consulta")
    app_cliente.post(
        f"/turmas/{turma_com_vaga['turma_id']}/inscrever-me",
        data={
            "servidor_id": str(turma_com_vaga["outro_servidor_id"]),
            "participante_id": "1",
            "inscricao_id": "1",
            "nome": "Carlos de Outro Setor",
        },
        follow_redirects=False,
    )
    with _sessao() as s:
        inscricoes = list(s.execute(select(Inscricao)).scalars())
        assert len(inscricoes) == 1
        assert inscricoes[0].participante.servidor_id == turma_com_vaga["servidor_id"]

    # e a porta da CSSO continua fechada para ele
    assert (
        app_cliente.post(
            f"/turmas/{turma_com_vaga['turma_id']}/inscricoes",
            data={"servidor_id": str(turma_com_vaga["outro_servidor_id"])},
            follow_redirects=False,
        ).status_code
        == 403
    )


def test_a_csso_ve_o_pedido_no_sino_e_o_confirma(app_cliente, contas, turma_com_vaga):
    """Onde a CSSO vê, e como confirma — reusando o sino, sem inventar fila."""
    entrar(app_cliente, contas, "servidor_consulta")
    app_cliente.post(f"/turmas/{turma_com_vaga['turma_id']}/inscrever-me")
    # a tarefa é do SETOR: não aparece no sino de quem a gerou
    assert "Confirmar inscrição pedida" not in app_cliente.get("/pendencias").text

    entrar(app_cliente, contas, "secretaria_csso")
    fila = app_cliente.get("/pendencias").text
    assert "Confirmar inscrição pedida pelo próprio servidor" in fila
    # a âncora da fila carrega o caminho de volta (`&de=pendencias`)
    assert f'href="/turmas/{turma_com_vaga["turma_id"]}?aba=inscricoes&amp;de=pendencias"' in fila

    with _sessao() as s:
        inscricao = s.execute(select(Inscricao)).scalars().one()
        alvo = inscricao.id
    app_cliente.post(
        f"/turmas/{turma_com_vaga['turma_id']}/inscricoes/{alvo}",
        data={"destino": "CONFIRMADA"},
    )
    with _sessao() as s:
        inscricao = s.get(Inscricao, alvo)
        assert inscricao.situacao == "CONFIRMADA"
        assert inscricao.confirmada_por is not None
        pendencia = s.execute(select(Pendencia)).scalars().one()
        assert pendencia.concluida, "a tarefa continuou cobrando trabalho já feito"


def test_o_servidor_desiste_e_nada_e_apagado(app_cliente, contas, turma_com_vaga):
    """RN-31: desistir cancela com motivo escrito, não apaga a linha."""
    entrar(app_cliente, contas, "servidor_consulta")
    app_cliente.post(f"/turmas/{turma_com_vaga['turma_id']}/inscrever-me")
    resposta = app_cliente.post(
        f"/turmas/{turma_com_vaga['turma_id']}/desistir",
        data={"motivo": "Conflito com a escala do plantão."},
        follow_redirects=True,
    )
    assert "Desistência registrada" in resposta.text
    with _sessao() as s:
        inscricao = s.execute(select(Inscricao)).scalars().one()
        assert inscricao.situacao == "CANCELADA"
        assert inscricao.motivo_cancelamento == "Conflito com a escala do plantão."
        # a vaga voltou, e a tarefa da CSSO fechou junto
        assert s.execute(select(Pendencia)).scalars().one().concluida


def test_desistir_da_inscricao_de_outro_e_recusado(app_cliente, contas, turma_com_vaga):
    """O serviço também recusa, e não só a rota — é a segunda camada."""
    with _sessao() as s:
        montador = _usuario(s, login="inscritor-2")
        turma = s.get(Turma, turma_com_vaga["turma_id"])
        outro = s.get(Servidor, turma_com_vaga["outro_servidor_id"])
        pessoa = servico_participante.de_servidor(s, outro, montador)
        alheia = servico_turma.inscrever(s, montador, turma, pessoa)
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        eu = UsuarioAtual(
            id=conta.id,
            login=conta.login,
            nome=conta.nome,
            permissoes=SERVIDOR,
            perfis=("servidor_consulta",),
            servidor_id=turma_com_vaga["servidor_id"],
        )
        with pytest.raises(servico_turma.RegraDaTurma, match="não é sua"):
            servico_turma.desistir(s, eu, alheia)
        s.rollback()


def test_a_turma_fora_do_prazo_e_da_situacao_recusa_o_pedido_proprio(
    app_cliente, contas, banco
):
    """`INSCRICOES_ABERTAS` e dentro do prazo — mais estreito que `aceita_inscricao`.

    A CSSO continua inscrevendo retardatário em turma `EM_ANDAMENTO`; o pedido do
    próprio só cabe onde o cartaz está no ar.
    """
    with _sessao() as s:
        montador = _usuario(s, login="montador-prazo")
        planejada = _turma_aberta(s, montador, codigo="NR-10")
        servico_turma.mudar_situacao(s, montador, planejada, "PLANEJADA")
        vencida = _turma_aberta(
            s,
            montador,
            codigo="NR-12",
            aberta_ate=date.today() - timedelta(days=1),
        )
        eu = Servidor(siape="7654323", nome="Joana Ribeiro de Almeida")
        s.add(eu)
        s.flush()
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = eu.id
        ids = {"planejada": planejada.id, "vencida": vencida.id}
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    # nenhuma das duas aparece no cartaz
    tela = app_cliente.get(MINHAS_TURMAS).text
    assert "Nenhuma turma com inscrições abertas hoje" in tela

    for alvo, trecho in ((ids["planejada"], "inscrições abertas"), (ids["vencida"], "fecharam em")):
        resposta = app_cliente.post(
            f"/turmas/{alvo}/inscrever-me", follow_redirects=True
        )
        assert trecho in resposta.text
    with _sessao() as s:
        assert not list(s.execute(select(Inscricao)).scalars())


def test_duas_pessoas_disputando_a_ultima_vaga_nao_somam_duas_inscricoes(banco):
    """A corrida de verdade, em duas linhas de execução e duas conexões.

    `BEGIN IMMEDIATE` (app/banco.py) é o que basta, e é a mesma garantia que a
    reserva de lote de EPI usa: o lock de escrita é tomado na PRIMEIRA instrução
    da transação, então a leitura de `vagas_restantes` e a gravação da inscrição
    cabem numa janela que nenhum outro escritor atravessa. Sem ele, as duas
    transações leriam "resta 1" e gravariam duas inscrições para uma vaga.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        montador = _usuario(s, login="montador-corrida")
        turma = _turma_aberta(s, montador, vagas=1)
        contas_ids = []
        for numero, nome in ((1, "Joana Ribeiro"), (2, "Carlos Menezes")):
            servidor = Servidor(siape=f"999000{numero}", nome=nome)
            s.add(servidor)
            s.flush()
            registro = Usuario(
                login=f"corrida{numero}",
                nome=nome,
                email=f"corrida{numero}@teste.ufvjm.edu.br",
                senha_hash=gerar_hash("SenhaDeTeste2026"),
                servidor_id=servidor.id,
            )
            s.add(registro)
            s.flush()
            contas_ids.append((registro.id, servidor.id))
        turma_id = turma.id
        s.commit()

    def pedir(par: tuple[int, int]) -> str:
        conta_id, servidor_id = par
        with mod_banco.sessao() as s:
            eu = UsuarioAtual(
                id=conta_id,
                login=f"conta{conta_id}",
                nome="Titular",
                permissoes=SERVIDOR,
                perfis=("servidor_consulta",),
                servidor_id=servidor_id,
            )
            try:
                servico_turma.inscrever_se(s, eu, s.get(Turma, turma_id))
                s.commit()
                return "inscreveu"
            except servico_turma.RegraDaTurma:
                return "recusado"

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        resultados = sorted(executor.map(pedir, contas_ids))

    assert resultados == ["inscreveu", "recusado"]
    with mod_banco.sessao() as s:
        assert len(list(s.execute(select(Inscricao)).scalars())) == 1
        assert servico_turma.vagas_restantes(s, s.get(Turma, turma_id)) == 0


# =====================================================================
# As três portas do titular continuam pedindo sessão
# =====================================================================
@pytest.mark.parametrize("caminho", [MEUS, MINHA_FICHA, MINHAS_TURMAS])
def test_as_portas_do_titular_exigem_sessao(app_cliente, caminho):
    resposta = app_cliente.get(caminho, follow_redirects=False)
    assert resposta.status_code == 303
    assert "/login" in resposta.headers["location"]
