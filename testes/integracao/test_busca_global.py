"""A busca que atravessa o sistema — e o que ela recusa a atravessar.

A caixa do cabeçalho despejava em `/processos` e só sabia achar processo: quem
procurava uma pessoa **sem** processo recebia lista vazia e concluía que ela não
estava cadastrada, e quem não tem `processo.ver` não tinha caixa nenhuma. Estes
testes cobram as duas metades do conserto: que ela agora ache, e que achar não
tenha virado uma janela nova para o lado de dentro.
"""

from __future__ import annotations

import re
from datetime import date

import pytest
from sqlalchemy import select

from app.modelos import AcessoDadoSensivel, Cargo, Servidor, UnidadeUorg
from app.servicos import busca as servico
from app.servicos.rbac import UsuarioAtual
from testes.integracao.conftest import entrar

NOME = "Marco Antônio Alves Schetino"
SIAPE = "1110654"
NUP = "23086.000777/2026-11"
LAUDO = "26255-000.125/2019"


def _usuario(*permissoes: str) -> UsuarioAtual:
    return UsuarioAtual(
        id=1, login="x", nome="x", permissoes=frozenset(permissoes), perfis=()
    )


@pytest.fixture()
def servidor_sem_processo(banco):
    """O caso que deu nome à queixa: cadastrado, e sem processo nenhum.

    Era exatamente ele que a busca velha não achava — e não por falta de dado,
    mas porque ela só sabia consultar a tabela de processo.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        cargo = s.execute(
            select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
        ).scalar_one()
        registro = Servidor(
            siape=SIAPE, nome=NOME, cargo_id=cargo.id, unidade_uorg_id=famed.id
        )
        s.add(registro)
        s.commit()
        return registro.id


@pytest.fixture()
def processo_e_laudo(banco, servidor_sem_processo):
    from app import banco as mod_banco
    from app.modelos import FluxoEtapa, LaudoTecnico, Processo, TipoAdicional, TipoProcesso

    with mod_banco.sessao() as s:
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
        tipo = s.execute(select(TipoProcesso).order_by(TipoProcesso.id)).scalars().first()
        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        insalubridade = s.execute(
            select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
        ).scalar_one()
        s.add(
            Processo(
                nup=NUP,
                tipo_processo_id=tipo.id,
                etapa_id=etapa.id,
                estado_tecnico="EM_TRIAGEM",
                servidor_id=servidor_sem_processo,
                data_autuacao=date(2026, 1, 5),
                ano_referencia=2026,
            )
        )
        s.add(
            LaudoTecnico(
                numero_siape=LAUDO,
                ano=2019,
                tipo_adicional_id=insalubridade.id,
                unidade_uorg_id=famed.id,
                data_emissao=date(2019, 6, 1),
            )
        )
        s.commit()


def _corpo_principal(html: str) -> str:
    """Só o `<main>`: a lateral e a trilha têm invariante próprio."""
    achado = re.search(r"<main class=\"conteudo.*?</main>", html, re.S)
    return achado.group(0) if achado else ""


# ---------------------------------------------------------------------
# O conserto: achar o que a busca velha não achava
# ---------------------------------------------------------------------
def test_acha_servidor_que_nao_tem_processo(app_cliente, contas, servidor_sem_processo):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = _corpo_principal(app_cliente.get("/buscar?q=Marco").text)
    assert NOME in corpo
    assert f'href="/servidores/{servidor_sem_processo}"' in corpo


def test_acha_por_siape_nup_e_numero_de_laudo(app_cliente, contas, processo_e_laudo):
    entrar(app_cliente, contas, "coordenador_csso")
    assert NOME in _corpo_principal(app_cliente.get(f"/buscar?q={SIAPE}").text)
    assert NUP in _corpo_principal(app_cliente.get(f"/buscar?q={NUP}").text)
    assert LAUDO in _corpo_principal(app_cliente.get(f"/buscar?q={LAUDO}").text)


def test_o_almoxarife_acha_a_pessoa_e_cai_na_ficha_dele(
    app_cliente, contas, servidor_sem_processo
):
    """Ele não tem `processo.ver`, e tem `epi.ficha`: as duas coisas contam.

    A linha existe para ele — precisa saber a quem vai entregar a bota, que é a
    razão de `epi.ficha` entrar em `ve_dado_nominal` —, e o link é o da tela que
    abre para ele. Oferecer `/servidores/{id}` seria o 403 que o invariante da
    trilha já fechou uma vez.
    """
    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = _corpo_principal(app_cliente.get("/buscar?q=Marco").text)
    assert NOME in corpo
    assert f'href="/epis/fichas/{servidor_sem_processo}"' in corpo
    assert f'href="/servidores/{servidor_sem_processo}"' not in corpo


# ---------------------------------------------------------------------
# RN-19 — a busca é o lugar clássico do vazamento
# ---------------------------------------------------------------------
def test_rn19_nome_nao_casa_para_quem_nao_pode_ler_aquele_nome(
    app_cliente, contas, servidor_sem_processo
):
    """O oráculo, agora em escala de sistema.

    A secretaria não tem `exposicao.ver`: a tela suprime o nome dela. Se o filtro
    continuasse casando, digitar "Marco" devolveria UMA linha e amarraria o nome
    ao `SRV-xxxx` da sessão — a ligação exata que a supressão existe para
    impedir, e agora atravessando seis blocos de uma vez.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = _corpo_principal(app_cliente.get("/buscar?q=Marco").text)
    assert NOME not in corpo
    assert not re.findall(r"SRV-[0-9a-f]{4}\b", corpo), (
        "a busca global devolveu linha para quem não vê o nome: o filtro voltou "
        "a ser oráculo"
    )
    assert "Nada encontrado" in corpo


def test_rn19_siape_continua_achando_com_a_identificacao_suprimida(
    app_cliente, contas, servidor_sem_processo
):
    """O contrapeso: o SIAPE é a chave, e ela vale para quem abre a tela.

    Fechar a busca inteira tiraria da secretaria a única forma de achar alguém —
    e o SIAPE ela já traz do processo no SEI.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = _corpo_principal(app_cliente.get(f"/buscar?q={SIAPE}").text)
    assert re.findall(r"SRV-[0-9a-f]{4}\b", corpo), "o SIAPE tem de achar a linha"
    assert NOME not in corpo


def test_rn19_titular_acha_o_proprio_nome(app_cliente, contas, banco, servidor_sem_processo):
    """LGPD art. 18, II: quem pode ler aquele nome pode buscá-lo.

    O critério é por LINHA (`pode_ver_nominal`), e não "tem ou não tem
    `exposicao.ver`" — senão o titular leria o próprio nome na ficha e não o
    acharia na busca.
    """
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = servidor_sem_processo
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    assert NOME in _corpo_principal(app_cliente.get("/buscar?q=Marco").text)


def test_a_busca_nao_aceita_cpf(app_cliente, contas, servidor_sem_processo):
    """Onze dígitos seguidos. O sistema não armazena CPF em campo nenhum (RN-21).

    Responder "nada encontrado" sugeriria que armazena e que a pessoa não está
    lá; a recusa diz que a chave não existe e oferece as que existem.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/buscar?q=123.456.789-09").text
    assert "não aceita CPF" in corpo
    assert "Nada encontrado" not in corpo


def test_a_busca_nao_grava_acesso_a_dado_sensivel(
    app_cliente, contas, banco, servidor_sem_processo
):
    """Decisão registrada em `rotas/busca.py`: o índice não conta, a porta conta.

    `acesso_dado_sensivel` é a tabela em que o auditor pergunta "quem abriu a
    ficha de quantas pessoas". Uma linha por busca — o gesto que mais se repete
    num sistema com `Ctrl+K` — afogaria as leituras de verdade. Quem achou o nome
    aqui ainda precisa clicar, e o clique cai numa rota que já registra.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get("/buscar?q=Marco").status_code == 200
    with mod_banco.sessao() as s:
        assert not list(
            s.execute(
                select(AcessoDadoSensivel).where(
                    AcessoDadoSensivel.servidor_id == servidor_sem_processo
                )
            ).scalars()
        )

    # e a porta continua contando
    app_cliente.get(f"/servidores/{servidor_sem_processo}")
    with mod_banco.sessao() as s:
        assert list(
            s.execute(
                select(AcessoDadoSensivel).where(
                    AcessoDadoSensivel.servidor_id == servidor_sem_processo
                )
            ).scalars()
        )


# ---------------------------------------------------------------------
# O vazio útil, e o que ele não pode contar
# ---------------------------------------------------------------------
def test_o_vazio_diz_onde_procurou_e_nao_o_que_escondeu(app_cliente, contas):
    """"Nada encontrado" sem dizer onde faz a pessoa repetir a mesma busca.

    E nomear o bloco que ficou de fora já afirmaria que existe alguma coisa que
    ela não pode ver: "não achei" e "você não pode ver" têm de ser
    indistinguíveis de fora.
    """
    entrar(app_cliente, contas, "almoxarife_sesmt")
    corpo = _corpo_principal(app_cliente.get("/buscar?q=zzzznadaaqui").text)
    assert "Nada encontrado" in corpo
    assert "servidores" in corpo
    assert "requisições de EPI" in corpo
    for escondido in ("processos", "laudos", "turmas", "certificados"):
        assert escondido not in corpo, f"o vazio revelou o bloco {escondido}"


def test_cobertura_e_a_mesma_lista_que_guarda_os_blocos():
    """A tabela de permissões e a de rótulos respondem à mesma pergunta.

    Uma lista pela metade nomearia bloco sem guarda ou guardaria bloco sem nome —
    e o segundo caso some da tela sem erro nenhum.
    """
    assert set(servico.PERMISSOES_POR_BLOCO) == set(servico.ROTULO_POR_BLOCO)
    assert servico.cobertura(_usuario("epi.ver", "epi.ficha")) == [
        "servidores",
        "requisições de EPI",
    ]
    assert servico.cobertura(_usuario("backup.executar", "auditoria.ver")) == []
    assert not servico.pode_buscar(_usuario("backup.executar"))
    assert servico.pode_buscar(_usuario("certificado.ver"))


# ---------------------------------------------------------------------
# O invariante: link que a busca oferece é link que abre
# ---------------------------------------------------------------------
@pytest.mark.parametrize(
    "perfil",
    [
        "coordenador_csso",
        "secretaria_csso",
        "almoxarife_sesmt",
        "auditor_interno",
        "consulta_progep",
    ],
)
def test_todo_link_da_busca_abre(app_cliente, contas, processo_e_laudo, perfil):
    """O invariante do menu, cobrado da busca.

    Resultado que leva a 403 é porta trancada em forma de resultado — e a busca é
    onde ela nasceria mais fácil, porque cada bloco aponta para um módulo
    diferente e nenhum deles sabe o que os outros exigem.
    """
    entrar(app_cliente, contas, perfil)
    for termo in ("Marco", SIAPE, NUP, LAUDO):
        resposta = app_cliente.get(f"/buscar?q={termo}")
        assert resposta.status_code == 200, termo
        for destino in re.findall(r'href="(/[^"]*)"', _corpo_principal(resposta.text)):
            assert app_cliente.get(destino).status_code != 403, (
                f"{perfil} buscou {termo} e recebeu um link para {destino}, que "
                "devolve 403"
            )
