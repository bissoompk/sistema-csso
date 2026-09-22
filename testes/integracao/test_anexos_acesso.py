"""O ataque contra `GET /anexos/{id}`, reproduzido — e recusado.

O defeito §A-1 do `entrada/implantacao/00_PRONTIDAO.md` foi medido com contas
reais dos perfis de produção:

```
coordenador_csso     GET /anexos/1 [PARECER_ASSINADO(PUBLICO)] -> 200
almoxarife_sesmt     GET /anexos/1 [PARECER_ASSINADO(PUBLICO)] -> 200
servidor_consulta    GET /anexos/1 [PARECER_ASSINADO(PUBLICO)] -> 200
```

O `almoxarife_sesmt` lia o parecer que a base normativa do próprio perfil diz
que ele não lê; o `servidor_consulta`, que existe para o titular ver o **próprio**
processo (LGPD art. 18, II), lia o de qualquer servidor por contagem de inteiros.
Nada disso entrava em `acesso_dado_sensivel`.

Este arquivo é a varredura: para cada perfil, tentar baixar o anexo de cada dono,
e exigir que o resultado seja **exatamente** o que a tela daquele dono já
concedia — nem mais, nem menos. A tabela `ALCANCA` é a especificação: quem
alcança o dono alcança o anexo.

E a sonda no fim, pela regra da casa: teste de segurança que não consegue falhar
não vale nada. Ela monta uma porta deliberadamente aberta e exige que a mesma
varredura a pegue.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.modelos import (
    AcessoDadoSensivel,
    Anexo,
    Cargo,
    Certificado,
    FluxoEtapa,
    HistoricoEvento,
    Inscricao,
    ParecerTecnico,
    Participante,
    Processo,
    Servidor,
    TipoProcesso,
    Treinamento,
    Turma,
    UnidadeUorg,
    Usuario,
)
from app.servicos.rbac import UsuarioAtual
from testes.integracao.conftest import entrar

# A montagem da entrega de EPI vem do arquivo que a define, e não de uma cópia:
# é o balcão de verdade (catálogo, lote, saldo, congelamento), e duas montagens
# do mesmo cenário divergem na primeira regra que alguém apertar lá.
from testes.integracao.test_epi_ficha import (
    _cenario as _cenario_epi,
    _entregar as _entregar_epi,
    _registros as _registros_epi,
)

FICHAS = "/epis/fichas"

# O texto medido no levantamento. Ele existe aqui para que a asserção não seja
# só sobre o código de status: se um dia a recusa passar a devolver o arquivo
# com 200 mascarado de outra coisa, é o conteúdo que denuncia.
SEGREDO = {
    "processo": b"PARECER NOMINAL - texto que fundamenta o adicional",
    "parecer_tecnico": b"PARECER ASSINADO - agente nocivo e percentual",
    "epi_ficha_registro": b"%PDF-1.4 assinatura manuscrita digitalizada",
    "certificado": b"CERTIFICADO NOMINAL - NR-35",
    "sem_dono": b"LISTA DE PRESENCA - assinatura de quem esteve na turma",
}

TODOS_OS_PERFIS = (
    "admin_ti",
    "superintendente",
    "coordenador_csso",
    "engenheiro_seguranca",
    "medico_trabalho",
    "tecnico_seguranca",
    "almoxarife_sesmt",
    "secretaria_csso",
    "consulta_progep",
    "servidor_consulta",
    "auditor_interno",
)

# Quem alcança a TELA do dono — e, portanto, quem alcança o anexo dele.
#
# Não é uma regra nova: é a leitura da matriz de perfis (`rbac.MATRIZ_PERFIS`)
# cruzada com o escopo. `admin_ti` não tem conteúdo técnico e não entra em lugar
# nenhum; `almoxarife_sesmt` entra só na ficha de EPI, que é o módulo que ele
# opera; `servidor_consulta` tem escopo próprio e o anexo aqui é de OUTRA pessoa,
# então ele não entra em lugar nenhum — o próprio tem teste separado, mais
# abaixo, porque é direito dele (LGPD art. 18, II).
#
# `secretaria_csso` fica de fora da ficha de EPI por ter `epi.ver` e não
# `epi.ficha`, que é a permissão de ler a ficha nominal DOS OUTROS.
ALCANCA: dict[str, frozenset[str]] = {
    "processo": frozenset(
        {
            "superintendente",
            "coordenador_csso",
            "engenheiro_seguranca",
            "medico_trabalho",
            "tecnico_seguranca",
            "secretaria_csso",
            "consulta_progep",
            "auditor_interno",
        }
    ),
    "parecer_tecnico": frozenset(
        {
            "superintendente",
            "coordenador_csso",
            "engenheiro_seguranca",
            "medico_trabalho",
            "tecnico_seguranca",
            "secretaria_csso",
            "consulta_progep",
            "auditor_interno",
        }
    ),
    "epi_ficha_registro": frozenset(
        {
            "superintendente",
            "coordenador_csso",
            "engenheiro_seguranca",
            "medico_trabalho",
            "tecnico_seguranca",
            "almoxarife_sesmt",
            "consulta_progep",
            "auditor_interno",
        }
    ),
    "certificado": frozenset(
        {
            "superintendente",
            "coordenador_csso",
            "engenheiro_seguranca",
            "medico_trabalho",
            "tecnico_seguranca",
            "secretaria_csso",
            "consulta_progep",
            "auditor_interno",
        }
    ),
    # `turma` ainda não tem tela de anexo. Sem regra declarada, ninguém baixa —
    # nem o coordenador. É a mesma escolha de `EscopoNaoDeclarado`: negar em vez
    # de cair num padrão permissivo que ninguém vê.
    "sem_dono": frozenset(),
}


# =====================================================================
# Cenário: um anexo de cada dono, todos do MESMO titular
# =====================================================================
def _usuario_coordenador(s) -> UsuarioAtual:
    """`guardar` grava `enviado_por` e um evento na trilha: precisa de linha real."""
    conta = s.execute(
        select(Usuario).where(Usuario.login == "coordenador_csso")
    ).scalar_one()
    return UsuarioAtual(
        id=conta.id,
        login=conta.login,
        nome=conta.nome,
        permissoes=frozenset({"anexo.enviar"}),
        perfis=("coordenador_csso",),
    )


@pytest.fixture()
def alheios(app_cliente, contas, banco) -> dict:
    """Quatro anexos de quatro donos, todos do mesmo servidor — e um sem dono.

    Todos pertencem a uma pessoa que **não** é a conta de nenhum teste: é o
    "anexo de outra pessoa" contra o qual a varredura roda.
    """
    from app import banco as mod_banco
    from app.servicos import anexos as servico_anexos

    epi = _cenario_epi()
    entrar(app_cliente, contas, "coordenador_csso")

    with mod_banco.sessao() as s:
        usuario = _usuario_coordenador(s)
        cargo = s.execute(select(Cargo)).scalars().first()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        titular = Servidor(
            siape="1110654",
            nome="Marco Antônio Alves Schetino",
            cargo_id=cargo.id,
            unidade_uorg_id=unidade.id,
        )
        s.add(titular)
        s.flush()

        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "EM_ANDAMENTO")
        ).scalar_one()
        tipo = s.execute(
            select(TipoProcesso).where(TipoProcesso.codigo == "ADICIONAL_OCUPACIONAL")
        ).scalar_one()
        processo = Processo(
            nup="23086.021284/2024-56",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico="PARECER_EM_ELABORACAO",
            servidor_id=titular.id,
            unidade_uorg_id=unidade.id,
            data_autuacao=date(2024, 10, 1),
        )
        s.add(processo)
        s.flush()

        parecer = ParecerTecnico(
            numero=1,
            ano=2025,
            # RASCUNHO porque emitir exige signatário habilitado (RN-01, trava de
            # banco) e o que este cenário precisa é da linha dona do anexo
            situacao="RASCUNHO",
            processo_id=processo.id,
            servidor_id=titular.id,
            unidade_uorg_id=unidade.id,
        )
        s.add(parecer)

        treinamento = Treinamento(
            codigo="NR-35.TESTE",
            nome="Trabalho em Altura — turma de teste",
            carga_horaria_horas=Decimal(8),
        )
        s.add(treinamento)
        s.flush()
        turma = Turma(
            treinamento_id=treinamento.id,
            numero=1,
            ano=2026,
            codigo="TUR-2026-0001",
            data_inicio=date(2026, 3, 2),
            data_fim=date(2026, 3, 3),
        )
        participante = Participante(
            servidor_id=titular.id,
            identificador_publico="PTC-ABCDEFGH",
            vinculo="SERVIDOR",
        )
        s.add_all([turma, participante])
        s.flush()
        inscricao = Inscricao(turma_id=turma.id, participante_id=participante.id)
        s.add(inscricao)
        s.flush()
        certificado = Certificado(
            inscricao_id=inscricao.id,
            numero=1,
            ano=2026,
            chave_validacao="CSSO-2026-ABCDE-FGHJK-M",
            data_emissao=date(2026, 3, 10),
            data_base_vencimento=date(2026, 3, 10),
            validade_meses_congelada=0,
            contexto_congelado={},
            modelo_arquivo="certificado_padrao_v1.docx",
            treinamento_id=treinamento.id,
            participante_id=participante.id,
            servidor_id=titular.id,
        )
        s.add(certificado)
        s.flush()

        ids = {"titular": titular.id, "processo_id": processo.id}
        for chave, entidade, entidade_id, categoria in (
            ("processo", "processo", processo.id, "PARECER_ASSINADO"),
            ("parecer_tecnico", "parecer_tecnico", parecer.id, "PARECER_ASSINADO"),
            ("certificado", "certificado", certificado.id, "CERTIFICADO"),
            ("sem_dono", "turma", turma.id, "LISTA_PRESENCA"),
        ):
            resultado = servico_anexos.guardar(
                s,
                entidade=entidade,
                entidade_id=entidade_id,
                nome_original=f"{chave}.pdf",
                conteudo=SEGREDO[chave],
                mime_type="application/pdf",
                categoria=categoria,
                usuario=usuario,
            )
            ids[chave] = resultado.anexo.id
        s.commit()

    # O comprovante de EPI entra pela porta de verdade: entrega no balcão e o
    # PDF assinado digitalizado por cima. É o arquivo que o ROPA §4.3 chama de o
    # item mais sensível do módulo.
    _entregar_epi(app_cliente, epi, servidor_id=ids["titular"])
    registro_id = _registros_epi()[0].id
    app_cliente.post(
        f"{FICHAS}/registros/{registro_id}/comprovante",
        files={
            "arquivo": (
                "assinado.pdf",
                SEGREDO["epi_ficha_registro"],
                "application/pdf",
            )
        },
    )
    with mod_banco.sessao() as s:
        from app.modelos import EpiFichaRegistro

        registro = s.get(EpiFichaRegistro, registro_id)
        ids["epi_ficha_registro"] = registro.comprovante_anexo_id
        ids["registro_epi"] = registro_id
    return ids


def _tentar(cliente, url: str, segredo: bytes) -> str:
    """Baixa e devolve 'liberado' ou 'recusado'. Recusa também é o corpo."""
    resposta = cliente.get(url, follow_redirects=False)
    if resposta.status_code == 200:
        assert segredo in resposta.content, f"{url}: 200 sem o conteúdo do anexo"
        return "liberado"
    assert segredo not in resposta.content, (
        f"{url}: status {resposta.status_code} e o conteúdo do anexo no corpo — "
        "recusa que entrega o arquivo não é recusa"
    )
    return "recusado"


# =====================================================================
# 1. A varredura
# =====================================================================
@pytest.mark.parametrize("perfil", TODOS_OS_PERFIS)
def test_o_anexo_alheio_so_abre_para_quem_abre_o_dono(
    app_cliente, contas, alheios, perfil
):
    """Enumerar `/anexos/1, 2, 3…` como cada perfil de produção.

    O critério não é "todo mundo é recusado" — seria fácil e seria falso: quem
    instrui o processo precisa do anexo dele. O critério é que a resposta do
    download seja a MESMA que a da tela do dono, perfil a perfil.
    """
    entrar(app_cliente, contas, perfil)
    divergencias = []
    for dono, frozen in ALCANCA.items():
        esperado = "liberado" if perfil in frozen else "recusado"
        obtido = _tentar(app_cliente, f"/anexos/{alheios[dono]}", SEGREDO[dono])
        if obtido != esperado:
            divergencias.append(f"{dono}: esperado {esperado}, obtido {obtido}")
    assert not divergencias, f"{perfil} — " + "; ".join(divergencias)


def test_o_ataque_medido_no_levantamento_nao_passa_mais(app_cliente, contas, alheios):
    """§A-1, literal: as duas contas que baixavam o parecer assinado de qualquer um.

    O `almoxarife_sesmt` continua alcançando o comprovante de EPI — é o módulo
    dele, é ele quem colhe a assinatura — e não alcança mais nada. O
    `servidor_consulta` não alcança nada que não seja dele.
    """
    for perfil in ("almoxarife_sesmt", "servidor_consulta"):
        entrar(app_cliente, contas, perfil)
        for dono in ("processo", "parecer_tecnico", "certificado"):
            assert (
                _tentar(app_cliente, f"/anexos/{alheios[dono]}", SEGREDO[dono])
                == "recusado"
            ), f"{perfil} baixou o anexo de {dono} de outra pessoa"


def test_entidade_sem_regra_declarada_nega_ate_para_o_coordenador(
    app_cliente, contas, alheios
):
    """Negado por padrão: categoria nova entra com o módulo que a cria."""
    entrar(app_cliente, contas, "coordenador_csso")
    assert (
        _tentar(app_cliente, f"/anexos/{alheios['sem_dono']}", SEGREDO["sem_dono"])
        == "recusado"
    )


# =====================================================================
# 2. O titular continua vendo o que é dele (LGPD art. 18, II)
# =====================================================================
def test_o_titular_baixa_o_proprio_anexo(app_cliente, contas, banco, alheios):
    """A porta não pode fechar em cima de quem ela existe para atender.

    `servidor_consulta` tem `ESCOPO_PROPRIO`: o processo é dele, o parecer é
    dele, a ficha de EPI é dele — **e agora o certificado também**.

    Este teste afirmava o contrário e explicava por quê: a tela de certificado
    exigia `certificado.ver`, que o perfil não tem, e o docstring terminava com
    a previsão de que "no dia em que essa decisão mudar, o anexo acompanha
    sozinho, sem ninguém tocar em `/anexos/{id}`". O dia chegou, e a previsão se
    cumpriu ao pé da letra: quem mudou foi
    `emissao_certificado.exigir_leitura_do_certificado` — a mesma função que a
    ficha e a segunda via consultam —, e `_dono_certificado` passou a alcançar o
    anexo pela regra do dono, não por uma segunda cópia dela. É exatamente isso
    que "derivar a regra do dono" comprava.

    `certificado.ver` continua fora do perfil, e continua sendo a permissão de
    ler o certificado de OUTRO: o que o titular alcança é o dele.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = alheios["titular"]
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    for dono in ("processo", "parecer_tecnico", "epi_ficha_registro", "certificado"):
        assert (
            _tentar(app_cliente, f"/anexos/{alheios[dono]}", SEGREDO[dono])
            == "liberado"
        ), f"o titular não alcançou o próprio anexo de {dono}"


# =====================================================================
# 3. O registro que sustenta investigação (LGPD art. 37)
# =====================================================================
def test_o_registro_de_acesso_diz_de_quem_e_o_dado(app_cliente, contas, alheios):
    """A porta de trás do `FICHA_EPI` gravava `servidor_id=None` e a finalidade
    padrão do outro módulo — registro que existe e não responde a pergunta que
    uma investigação faz."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    anexo_id = alheios["epi_ficha_registro"]
    assert app_cliente.get(f"/anexos/{anexo_id}").status_code == 200

    with mod_banco.sessao() as s:
        linhas = [
            a
            for a in s.execute(select(AcessoDadoSensivel)).scalars()
            if a.campo == "anexo.FICHA_EPI"
        ]
        assert linhas, "baixar o comprovante assinado não deixou registro"
        acesso = linhas[-1]
        assert acesso.servidor_id == alheios["titular"]
        assert "comprovante" in (acesso.finalidade or "")

        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.entidade == "anexo",
                HistoricoEvento.entidade_id == anexo_id,
                HistoricoEvento.tipo_evento == "ANEXO_BAIXADO",
            )
        ).scalars()
        assert list(evento), "a trilha não diz QUAL anexo saiu"


def test_as_duas_portas_do_comprovante_gravam_a_mesma_coisa(
    app_cliente, contas, alheios
):
    """§A-2: o mesmo arquivo saía por duas portas com rigor diferente."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.get(f"/anexos/{alheios['epi_ficha_registro']}")
    app_cliente.get(f"{FICHAS}/registros/{alheios['registro_epi']}/anexo")

    with mod_banco.sessao() as s:
        linhas = [
            (a.campo, a.servidor_id, a.finalidade)
            for a in s.execute(select(AcessoDadoSensivel)).scalars()
            if a.campo == "anexo.FICHA_EPI"
        ]
    assert len(linhas) == 2
    assert linhas[0] == linhas[1], "as duas portas do mesmo arquivo divergem"


def test_o_anexo_publico_do_processo_tambem_e_registrado(
    app_cliente, contas, alheios
):
    """`PARECER_ASSINADO` nasce `PUBLICO` em `NIVEL_POR_CATEGORIA`, e era só o
    `RESTRITO` que registrava. "Público" ali quer dizer retenção, não acesso."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get(f"/anexos/{alheios['processo']}").status_code == 200

    with mod_banco.sessao() as s:
        acessos = [
            a
            for a in s.execute(select(AcessoDadoSensivel)).scalars()
            if a.campo == "anexo.PARECER_ASSINADO"
        ]
    assert acessos, "o parecer assinado saiu sem deixar linha"
    assert acessos[-1].servidor_id == alheios["titular"]
    assert acessos[-1].processo_id == alheios["processo_id"]


# =====================================================================
# 4. A resposta não pode virar oráculo
# =====================================================================
def test_id_inexistente_e_id_proibido_respondem_igual(app_cliente, contas, alheios):
    """Distinguir "não existe" de "não pode" mantém a enumeração viva: ela deixa
    de baixar o arquivo e passa a contar quantos existem — e "este id existe e
    você não pode" já é informação sobre a pessoa por trás dele."""
    entrar(app_cliente, contas, "servidor_consulta")
    proibido = app_cliente.get(f"/anexos/{alheios['processo']}")
    inexistente = app_cliente.get("/anexos/99999")

    assert proibido.status_code == inexistente.status_code == 404
    assert proibido.text == inexistente.text


def test_anexo_desativado_responde_como_inexistente(app_cliente, contas, alheios):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        anexo = s.get(Anexo, alheios["processo"])
        anexo.ativo = False
        s.commit()

    entrar(app_cliente, contas, "coordenador_csso")
    assert app_cliente.get(f"/anexos/{alheios['processo']}").status_code == 404


# =====================================================================
# 5. A sonda — a varredura precisa conseguir falhar
# =====================================================================
def test_a_varredura_pega_uma_porta_aberta(app_cliente, contas, alheios):
    """Sem isto, um erro na montagem faria a varredura passar por vazio.

    A porta falsa é a rota de antes, reduzida ao osso: devolve o arquivo a
    qualquer conta logada. Se `_tentar` não a acusar, ele também não acusaria a
    rota de verdade se ela voltasse a ser assim.
    """
    from fastapi.responses import FileResponse

    from app import banco as mod_banco
    from app.servicos import anexos as servico_anexos

    with mod_banco.sessao() as s:
        caminho = servico_anexos.caminho_absoluto(s.get(Anexo, alheios["processo"]))

    @app_cliente.app.get("/anexos-sonda/{anexo_id}")
    def _porta_aberta(anexo_id: int):  # pragma: no cover - só a sonda a chama
        return FileResponse(caminho, media_type="application/pdf")

    entrar(app_cliente, contas, "servidor_consulta")
    assert (
        _tentar(app_cliente, "/anexos-sonda/1", SEGREDO["processo"]) == "liberado"
    ), "a sonda não conseguiu abrir a porta — a varredura deixou de medir"
    with pytest.raises(AssertionError):
        assert (
            _tentar(app_cliente, "/anexos-sonda/1", SEGREDO["processo"]) == "recusado"
        )
