"""O que o titular alcança, o que a CSSO continua alcançando, e o que fica gravado.

Medido em `entrada/servidor/03_PRIVACIDADE.md` com a conta `servidor_consulta`
contra uma cópia do ambiente de teste:

```
GET /pareceres/{id}          200 em 3 de 3  (2 de terceiros, com agente nocivo,
                                             percentual e o .docx oficial)
GET /epis/requisicoes        9 de 9 na fila
GET /epis/requisicoes/{id}   200 em 9 de 9  (rotina de trabalho e riscos declarados)
GET /servidores              12 de 12 fichas
GET /pendencias              15 de 15
acesso_dado_sensivel         0 -> 0 depois de 35 leituras nominais
```

Este arquivo fixa as três coisas que o conserto tinha de fazer ao mesmo tempo:

1. o titular vê **o que é dele** (LGPD art. 18, II — é a razão de o perfil existir);
2. a equipe da CSSO **não perde nada** (o escopo é por perfil, e o dela é de unidade);
3. a recusa **não vira oráculo** — "não existe" e "não pode" respondem igual, a
   disciplina que `/anexos/{id}` fixou na 1.31.0.

E o registro de acesso, que vem antes de tudo isso: a leitura de dado nominal de
**terceiro** grava linha, a do **próprio titular** não grava. O argumento está em
`auditoria.registrar_leitura_nominal`.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.modelos import (
    AcessoDadoSensivel,
    Cargo,
    EpiRequisicao,
    FluxoEtapa,
    ParecerTecnico,
    Pendencia,
    Processo,
    Servidor,
    TipoProcesso,
    UnidadeUorg,
    Usuario,
)
from testes.integracao.conftest import entrar

# A equipe que opera o setor. Nenhuma destas contas pode perder uma linha por
# causa do conserto: o escopo delas é de unidade, e sem campus atribuído
# `aplicar_escopo` devolve a consulta inteira.
EQUIPE_CSSO = (
    "coordenador_csso",
    "engenheiro_seguranca",
    "tecnico_seguranca",
    "medico_trabalho",
)


@pytest.fixture()
def cena(app_cliente, contas, banco) -> dict:
    """Dois servidores — o titular da conta e um terceiro — com tudo em duplicata.

    Tudo em duplicata de propósito: o teste que só monta o dado de terceiro prova
    que a porta fechou e não prova que ela abre para quem tem direito, que é a
    metade do conserto que dá errado calado.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        cargo = s.execute(select(Cargo)).scalars().first()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "EM_ANDAMENTO")
        ).scalar_one()
        tipo = s.execute(
            select(TipoProcesso).where(TipoProcesso.codigo == "ADICIONAL_OCUPACIONAL")
        ).scalar_one()
        conta_titular = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta_coord = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()

        ids: dict[str, int] = {}
        for papel, siape, nome, nup, numero in (
            ("titular", "3010011", "Adelaide Nunes Prata", "23086.000111/2026-11", 901),
            (
                "terceiro",
                "3010077",
                "Gorete Vasconcelos Pimenta",
                "23086.000222/2026-22",
                902,
            ),
        ):
            servidor = Servidor(
                siape=siape,
                nome=nome,
                cargo_id=cargo.id,
                unidade_uorg_id=unidade.id,
            )
            s.add(servidor)
            s.flush()
            processo = Processo(
                nup=nup,
                tipo_processo_id=tipo.id,
                etapa_id=etapa.id,
                estado_tecnico="PARECER_EM_ELABORACAO",
                servidor_id=servidor.id,
                unidade_uorg_id=unidade.id,
                data_autuacao=date(2026, 1, 5),
            )
            s.add(processo)
            s.flush()
            parecer = ParecerTecnico(
                # numero explícito e distinto: `parecer_tecnico` tem unicidade
                # em (numero, ano), e dois rascunhos com o `0` da convenção não
                # entram no mesmo ano
                numero=numero,
                ano=2026,
                situacao="RASCUNHO",
                processo_id=processo.id,
                servidor_id=servidor.id,
                unidade_uorg_id=unidade.id,
            )
            requisicao = EpiRequisicao(
                servidor_id=servidor.id,
                solicitado_por_id=conta_coord.id,
                finalidade="ROTINA",
                descricao_atividade=f"Rotina declarada por {nome}.",
                riscos_declarados="Agente químico e agente biológico no posto.",
                urgencia="NORMAL",
                estado="RASCUNHO",
            )
            s.add_all([parecer, requisicao])
            s.flush()
            ids[f"servidor_{papel}"] = servidor.id
            ids[f"processo_{papel}"] = processo.id
            ids[f"parecer_{papel}"] = parecer.id
            ids[f"requisicao_{papel}"] = requisicao.id

        # A fila do setor: tarefa de quem opera, com nome de terceiro na descrição
        # livre. A frase é montada À MÃO de propósito: `epi_ficha` já não a
        # escreve assim (a pendência do comprovante passou a gravar
        # `servidor #{id}`), e as pendências antigas continuam no banco com o
        # nome dentro. É esse passado que o escopo tem de fechar — a correção da
        # escrita não o alcança, e nunca vai alcançar.
        s.add(
            Pendencia(
                tipo="INCLUIR_NO_SEI",
                chave="teste-escopo-1",
                descricao=(
                    "Anexar o comprovante assinado de 1 × Óculos de proteção "
                    "entregue a Gorete Vasconcelos Pimenta em 14/08/2026"
                ),
                processo_id=ids["processo_terceiro"],
                responsavel_id=conta_coord.id,
            )
        )
        # A conta do titular passa a ser a pessoa
        conta_titular.servidor_id = ids["servidor_titular"]
        ids["conta_titular"] = conta_titular.id
        s.commit()
    return ids


def _acessos(servidor_id: int | None = None) -> list[AcessoDadoSensivel]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        consulta = select(AcessoDadoSensivel)
        if servidor_id is not None:
            consulta = consulta.where(AcessoDadoSensivel.servidor_id == servidor_id)
        return list(s.execute(consulta).scalars())


# =====================================================================
# 1. O registro de acesso — antes do escopo, e por isso primeiro aqui
# =====================================================================
def test_titular_lendo_o_proprio_parecer_nao_vira_linha_de_acesso(
    app_cliente, contas, cena
):
    """O art. 18, II não é evento de risco. Registrá-lo afoga o que interessa."""
    entrar(app_cliente, contas, "servidor_consulta")
    assert app_cliente.get(f"/pareceres/{cena['parecer_titular']}").status_code == 200
    assert _acessos(cena["servidor_titular"]) == []


def test_titular_lendo_a_propria_ficha_nao_vira_linha_de_acesso(
    app_cliente, contas, cena
):
    entrar(app_cliente, contas, "servidor_consulta")
    assert app_cliente.get(f"/servidores/{cena['servidor_titular']}").status_code == 200
    assert _acessos(cena["servidor_titular"]) == []


@pytest.mark.parametrize("perfil", ["coordenador_csso", "secretaria_csso"])
def test_leitura_de_parecer_de_terceiro_deixa_rastro(app_cliente, contas, cena, perfil):
    """Inclusive de quem NÃO tem `exposicao.ver` — era esse o buraco.

    `secretaria_csso` lia os três pareceres nominais do ambiente e não deixava
    uma linha, porque a gravação era condicionada a `ve_dado_nominal`
    (`exposicao.ver or epi.ficha`), que ela não tem. O critério agora é a relação
    titular/terceiro, e quem não é titular de linha nenhuma lê sempre como terceiro.
    """
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(f"/pareceres/{cena['parecer_terceiro']}").status_code == 200
    campos = {a.campo for a in _acessos(cena["servidor_terceiro"])}
    assert "parecer_tecnico.nominal" in campos


def test_leitura_de_ficha_de_terceiro_deixa_rastro_com_sobre_quem(
    app_cliente, contas, cena
):
    """A coluna `servidor_id` é o "sobre quem" do art. 37: sem ela não há investigação."""
    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get(f"/servidores/{cena['servidor_terceiro']}").status_code == 200
    linhas = [
        a for a in _acessos(cena["servidor_terceiro"]) if a.campo == "servidor.ficha"
    ]
    assert linhas and all(a.servidor_id == cena["servidor_terceiro"] for a in linhas)


# =====================================================================
# 2. O escopo — o titular vê o dele, e só o dele
# =====================================================================
def test_titular_abre_o_proprio_parecer_e_nao_o_de_terceiro(app_cliente, contas, cena):
    entrar(app_cliente, contas, "servidor_consulta")
    proprio = app_cliente.get(
        f"/pareceres/{cena['parecer_titular']}", follow_redirects=False
    )
    alheio = app_cliente.get(
        f"/pareceres/{cena['parecer_terceiro']}", follow_redirects=False
    )
    assert proprio.status_code == 200
    assert alheio.status_code == 303


@pytest.mark.parametrize("sufixo", ["/docx", "/pdf", "/previa"])
def test_o_documento_do_parecer_de_terceiro_nao_sai(app_cliente, contas, cena, sufixo):
    """O `.docx` leva o nome do terceiro no próprio `filename`."""
    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get(f"/pareceres/{cena['parecer_terceiro']}{sufixo}")
    assert resposta.status_code == 404


def test_titular_ve_so_a_propria_requisicao_na_fila(app_cliente, contas, cena):
    entrar(app_cliente, contas, "servidor_consulta")
    corpo = app_cliente.get("/epis/requisicoes").text
    assert f"/epis/requisicoes/{cena['requisicao_titular']}" in corpo
    assert f"/epis/requisicoes/{cena['requisicao_terceiro']}" not in corpo


def test_a_ficha_da_requisicao_de_terceiro_nao_abre(app_cliente, contas, cena):
    """Rotina de trabalho e riscos declarados são texto do próprio requerente."""
    entrar(app_cliente, contas, "servidor_consulta")
    propria = app_cliente.get(
        f"/epis/requisicoes/{cena['requisicao_titular']}", follow_redirects=False
    )
    alheia = app_cliente.get(
        f"/epis/requisicoes/{cena['requisicao_terceiro']}", follow_redirects=False
    )
    assert propria.status_code == 200
    assert alheia.status_code == 303
    assert "Agente químico" in propria.text


def test_a_guia_da_requisicao_de_terceiro_nao_sai(app_cliente, contas, cena):
    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get(
        f"/epis/requisicoes/{cena['requisicao_terceiro']}/guia", follow_redirects=False
    )
    assert resposta.status_code == 303


def test_titular_ve_so_a_propria_linha_em_servidores(app_cliente, contas, cena):
    entrar(app_cliente, contas, "servidor_consulta")
    corpo = app_cliente.get("/servidores").text
    assert f"/servidores/{cena['servidor_titular']}" in corpo
    assert f"/servidores/{cena['servidor_terceiro']}" not in corpo


def test_a_ficha_de_servidor_de_terceiro_nao_abre(app_cliente, contas, cena):
    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get(
        f"/servidores/{cena['servidor_terceiro']}", follow_redirects=False
    )
    assert resposta.status_code == 303


def test_a_fila_de_pendencias_nao_publica_nome_de_terceiro(app_cliente, contas, cena):
    """A `descricao` é texto livre e passa por fora do helper da RN-19."""
    entrar(app_cliente, contas, "servidor_consulta")
    resposta = app_cliente.get("/pendencias")
    assert resposta.status_code == 200
    assert "Gorete Vasconcelos Pimenta" not in resposta.text


# =====================================================================
# 3. A CSSO não perde nada
# =====================================================================
@pytest.mark.parametrize("perfil", EQUIPE_CSSO)
def test_a_equipe_continua_vendo_o_parecer_de_qualquer_servidor(
    app_cliente, contas, cena, perfil
):
    entrar(app_cliente, contas, perfil)
    for chave in ("parecer_titular", "parecer_terceiro"):
        assert app_cliente.get(f"/pareceres/{cena[chave]}").status_code == 200


@pytest.mark.parametrize("perfil", EQUIPE_CSSO)
def test_a_equipe_continua_vendo_a_fila_inteira_de_epi(
    app_cliente, contas, cena, perfil
):
    entrar(app_cliente, contas, perfil)
    corpo = app_cliente.get("/epis/requisicoes").text
    for chave in ("requisicao_titular", "requisicao_terceiro"):
        assert f"/epis/requisicoes/{cena[chave]}" in corpo
    for chave in ("requisicao_titular", "requisicao_terceiro"):
        assert app_cliente.get(f"/epis/requisicoes/{cena[chave]}").status_code == 200


@pytest.mark.parametrize("perfil", EQUIPE_CSSO)
def test_a_equipe_continua_vendo_o_cadastro_inteiro(app_cliente, contas, cena, perfil):
    entrar(app_cliente, contas, perfil)
    corpo = app_cliente.get("/servidores").text
    for chave in ("servidor_titular", "servidor_terceiro"):
        assert f"/servidores/{cena[chave]}" in corpo
        assert app_cliente.get(f"/servidores/{cena[chave]}").status_code == 200


@pytest.mark.parametrize("perfil", EQUIPE_CSSO)
def test_a_equipe_continua_vendo_a_fila_de_pendencias(app_cliente, contas, cena, perfil):
    entrar(app_cliente, contas, perfil)
    resposta = app_cliente.get("/pendencias")
    assert resposta.status_code == 200
    assert "Gorete Vasconcelos Pimenta" in resposta.text


def test_o_auditor_com_escopo_total_nao_perde_nada(app_cliente, contas, cena):
    entrar(app_cliente, contas, "auditor_interno")
    for chave in ("parecer_titular", "parecer_terceiro"):
        assert app_cliente.get(f"/pareceres/{cena[chave]}").status_code == 200


# =====================================================================
# 4. A recusa não vira oráculo
# =====================================================================
INEXISTENTE = 999_999


@pytest.mark.parametrize(
    "molde,chave",
    [
        ("/pareceres/{}", "parecer_terceiro"),
        ("/pareceres/{}/docx", "parecer_terceiro"),
        ("/pareceres/{}/previa", "parecer_terceiro"),
        ("/epis/requisicoes/{}", "requisicao_terceiro"),
        ("/epis/requisicoes/{}/guia", "requisicao_terceiro"),
        ("/servidores/{}", "servidor_terceiro"),
    ],
)
def test_nao_existe_e_nao_pode_respondem_igual(app_cliente, contas, cena, molde, chave):
    """A mesma disciplina de `/anexos/{id}`: a recusa não conta que o id existe."""
    entrar(app_cliente, contas, "servidor_consulta")
    inexistente = app_cliente.get(molde.format(INEXISTENTE), follow_redirects=False)
    proibido = app_cliente.get(molde.format(cena[chave]), follow_redirects=False)
    assert inexistente.status_code == proibido.status_code
    assert inexistente.headers.get("location") == proibido.headers.get("location")
