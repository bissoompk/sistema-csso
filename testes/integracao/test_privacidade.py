"""RN-19, RN-21, RN-23 / CA-18 - identificacao suprimida e registro de acesso."""

from __future__ import annotations

import ast
import re
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select

from app.modelos import AcessoDadoSensivel, Cargo, Servidor, UnidadeUorg
from app.rotas.relatorios import MARCA_SUPRIMIDO, suprimir
from testes.integracao.conftest import entrar

NOME = "Marco Antônio Alves Schetino"
SIAPE = "1110654"


@pytest.fixture()
def servidor(banco):
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        cargo = s.execute(
            select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
        ).scalar_one()
        registro = Servidor(
            siape=SIAPE,
            nome=NOME,
            cargo_id=cargo.id,
            unidade_uorg_id=famed.id,
        )
        s.add(registro)
        s.commit()
        return registro.id


@pytest.fixture()
def processo_do_servidor(banco, servidor):
    """Um processo do Marco Antônio em triagem: cai na coluna 'A fazer', então
    aparece no kanban, na lista e no 'precisam de você hoje' do painel."""
    from app import banco as mod_banco
    from app.modelos import FluxoEtapa, Processo, TipoProcesso

    with mod_banco.sessao() as s:
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
        tipo = s.execute(select(TipoProcesso).order_by(TipoProcesso.id)).scalars().first()
        processo = Processo(
            nup="23086.000777/2026-11",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico="EM_TRIAGEM",
            servidor_id=servidor,
            unidade_uorg_id=None,
            data_autuacao=date(2026, 1, 5),
            ano_referencia=2026,
        )
        s.add(processo)
        s.commit()
        return processo.id


def test_ca18_consulta_com_permissao_gera_registro(app_cliente, contas, servidor):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get(f"/servidores/{servidor}")
    assert resposta.status_code == 200
    assert "Marco Antônio Alves Schetino" in resposta.text

    with mod_banco.sessao() as s:
        acessos = list(
            s.execute(
                select(AcessoDadoSensivel).where(
                    AcessoDadoSensivel.servidor_id == servidor
                )
            ).scalars()
        )
    assert acessos, "toda leitura nominal grava linha em acesso_dado_sensivel"
    assert acessos[0].campo == "servidor.ficha"
    assert acessos[0].finalidade


def test_ca18_sem_permissao_matricula_vira_identificador_opaco(
    app_cliente, contas, servidor
):
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get("/servidores")
    assert resposta.status_code == 200
    assert "Marco Antônio Alves Schetino" not in resposta.text
    assert "1110654" not in resposta.text
    assert "SRV-" in resposta.text


def test_rn19_identificador_nao_e_mascara_parcial(app_cliente, contas, servidor):
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/servidores").text
    for parcial in ("111****", "***0654", "1110***"):
        assert parcial not in corpo


# ---------------------------------------------------------------------
# RN-19 — a busca de /servidores não pode ser oráculo de nome
# ---------------------------------------------------------------------
def test_rn19_busca_por_nome_nao_revela_quem_e_o_codigo_opaco(
    app_cliente, contas, servidor
):
    """O oráculo: a lista suprime o nome e a busca por nome o devolvia de volta.

    Digitar "Marco" e receber UMA linha amarra o nome ao código `SRV-xxxx` da
    sessão — que é exatamente a ligação que a supressão existe para não deixar
    fazer. Esconder a coluna não adianta se o filtro responde "sim, é este".
    """
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/servidores?q=Marco").text
    assert not re.findall(r"SRV-[0-9a-f]{4}\b", corpo), (
        "a busca por nome devolveu linha para quem não vê nome: o filtro vira "
        "oráculo e amarra o nome ao código opaco"
    )
    assert "Nenhum servidor" in corpo


def test_rn19_busca_por_siape_continua_valendo_sem_exposicao_ver(
    app_cliente, contas, servidor
):
    """O contrapeso.

    "A chave é o SIAPE — nunca o nome" é o que a própria tela promete; fechar a
    busca inteira tiraria da secretaria a única forma de achar alguém numa lista
    longa, e o SIAPE ela já traz do processo no SEI.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get(f"/servidores?q={SIAPE}").text
    assert re.findall(r"SRV-[0-9a-f]{4}\b", corpo), "o SIAPE tem de achar a linha"
    assert NOME not in corpo


def test_rn19_quem_ve_nome_continua_buscando_por_nome(app_cliente, contas, servidor):
    """A correção não pode mudar a tela para quem TEM a permissão."""
    entrar(app_cliente, contas, "coordenador_csso")
    assert NOME in app_cliente.get("/servidores?q=Marco").text


def test_rn19_titular_acha_o_proprio_nome_na_busca(app_cliente, contas, banco, servidor):
    """LGPD art. 18, II: quem pode ver aquele nome pode buscá-lo.

    A regra da busca é a mesma da exibição — `pode_ver_nominal`, linha a linha —
    e não "tem ou não tem `exposicao.ver`". Sem isso o titular leria o próprio
    nome na ficha e não o acharia na busca da lista.
    """
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = servidor
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    assert NOME in app_cliente.get("/servidores?q=Marco").text


# ---------------------------------------------------------------------
# RN-19 - a supressao vale em TODA tela, nao so nas que alguem lembrou
# ---------------------------------------------------------------------
# O painel e o kanban sao as duas telas que mais gente abre, e eram justamente
# as que mostravam o nome inteiro a quem nao tem `exposicao.ver`. O parametro
# lista as telas que exibem servidor para que tela nova entre aqui, e nao seja
# descoberta por vazamento.
TELAS_COM_SERVIDOR = ("/", "/kanban", "/processos", "/adicionais", "/servidores")


@pytest.mark.parametrize("caminho", TELAS_COM_SERVIDOR)
def test_rn19_tela_nao_mostra_nome_de_servidor(
    app_cliente, contas, processo_do_servidor, caminho
):
    """Perfil sem `exposicao.ver` abre a tela e o nome nao esta no corpo."""
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get(caminho)
    assert resposta.status_code == 200, caminho
    assert NOME not in resposta.text, caminho
    assert SIAPE not in resposta.text, caminho


def test_rn19_quem_tem_exposicao_ver_continua_lendo_o_nome(
    app_cliente, contas, processo_do_servidor
):
    """O contrapeso do teste acima.

    Sem ele, um `identificar()` que não achasse o usuário no contexto suprimiria
    tudo para todo mundo — e o teste de vazamento passaria, satisfeito, com o
    sistema quebrado para quem tem a permissão. O `/processos` é o caso concreto:
    a linha é montada dentro de um `{% macro %}`.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    for caminho in ("/", "/kanban", "/processos", "/servidores", "/processos/novo",
                    f"/processos/{processo_do_servidor}"):
        resposta = app_cliente.get(caminho)
        assert resposta.status_code == 200, caminho
        assert NOME in resposta.text, caminho


def test_rn19_cartao_devolvido_pelo_arrasto_tambem_suprime(
    app_cliente, contas, processo_do_servidor
):
    """A secretaria tem `processo.status`: o cartão volta pelo HTMX, fora do
    `pagina()`, e é o mesmo template — o helper precisa valer no fragmento."""
    entrar(app_cliente, contas, "secretaria_csso")
    # ARQUIVADO é a única saída da triagem que não exige portaria nem formulário
    # anexados — aqui o que se testa é o cartão que volta, não a máquina.
    resposta = app_cliente.post(
        f"/kanban/mover/{processo_do_servidor}",
        data={"coluna": "CONCLUIDO", "estado": "ARQUIVADO"},
    )
    assert resposta.status_code == 200, resposta.text
    assert NOME not in resposta.text
    assert SIAPE not in resposta.text


def test_rn19_ficha_do_servidor_nao_entrega_o_nome_no_formulario(
    app_cliente, contas, servidor
):
    """A secretaria tem `processo.editar`: o formulario de identificacao
    devolvia nome e SIAPE em `value=` para quem nao pode ve-los."""
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get(f"/servidores/{servidor}").text
    assert NOME not in corpo
    assert SIAPE not in corpo


def test_rn19_selecao_de_servidor_do_processo_novo_e_opaca(app_cliente, contas, servidor):
    """A secretaria tem `processo.criar`: o <select> listava o cadastro inteiro
    com nome e SIAPE."""
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/processos/novo").text
    assert NOME not in corpo
    assert SIAPE not in corpo


def test_rn19_identificador_opaco_e_o_mesmo_em_todas_as_telas(
    app_cliente, contas, processo_do_servidor
):
    """A semente e a sessao: dentro dela o codigo tem de ser um so.

    /processos e /adicionais formatavam o proprio id do banco (`SRV-0007`), que
    alem de nao ser opaco — e enumeravel, estavel entre sessoes e igual para
    todos os usuarios — nunca batia com o `SRV-7f3a` de /servidores. Quem via as
    duas telas via dois codigos para a mesma pessoa.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    achados = {}
    for caminho in TELAS_COM_SERVIDOR:
        corpo = app_cliente.get(caminho).text
        achados[caminho] = set(re.findall(r"SRV-[0-9a-f]{4}\b", corpo))

    referencia = achados["/servidores"]
    assert referencia, "/servidores e a implementacao de referencia da RN-19"
    for caminho, codigos in achados.items():
        if codigos:
            assert codigos == referencia, caminho


def test_rn19_titular_ve_o_proprio_nome(app_cliente, contas, banco, servidor):
    """LGPD art. 18, II: `servidor_consulta` nao tem `exposicao.ver` e existe
    exatamente para o titular consultar o proprio processo."""
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = servidor
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    assert NOME in app_cliente.get(f"/servidores/{servidor}").text


# A regra so continua valendo se a proxima tela for obrigada a passar pelo
# helper. Este teste e a obrigacao: template que ler nome ou SIAPE direto do
# cadastro reprova, e quem tiver um motivo o escreve aqui.
DISPENSAS_RN19: dict[str, str] = {
    "paginas/assinaturas.html": (
        "instrutor de treinamento, nao servidor sob avaliacao: a tela exige "
        "`assinatura.gerenciar` e o nome e o que sera impresso na rubrica"
    ),
    "paginas/turma_ficha.html": (
        "a linha `SIAPE {{ i.participante.servidor.siape }}` do roster, e so "
        "ela, sob a guarda `pode_nominal` do proprio template — que e "
        "`certificado.ver` (a permissao cuja descricao e 'certificado nominal e "
        "dados do participante') ou a RN-19 comum de `identificar()`, que da o "
        "`SRV-…` da sessao a quem nao a tem e o proprio nome ao titular. A "
        "frase antiga dizia 'sob `certificado.ver`' e a tela nao a cumpria: ela "
        "renderizava sob `treinamento.ver`, que e o que o servidor comum tera. "
        "Quem prova a frase nao e esta varredura — que nao acusaria "
        "`nome_exibicao`, `email_exibicao` nem `identificador_publico`, os tres "
        "caminhos pelos quais o nome sai daqui — e sim "
        "`test_rn19_lista_de_chamada_nao_nomeia_quem_esta_na_turma` e as irmas, "
        "que ABREM as tres abas como quem nao tem a permissao. O papel continua "
        "nominal por fora deste arquivo: `servicos/lista_presenca.py`, sob "
        "`turma.avaliar`"
    ),
    "partes/previa_parecer.html": (
        "o fac-simile do .docx imprime o contexto CONGELADO do parecer (RN-15), "
        "e o congelado tem de sair como foi emitido — `identificar(parecer).nome` "
        "leria o cadastro de hoje e a previa deixaria de ser o que sai no papel. "
        "A supressao esta uma linha acima, em `identificar(parecer)`, que decide "
        "SE `c.nome_servidor` aparece; quem prova que ela continua de pe nao e "
        "esta varredura e sim "
        "`test_rn19_previa_do_parecer_nao_entrega_nome_nem_siape`, que ABRE a "
        "tela como quem nao tem `exposicao.ver`. Para este arquivo o teste de "
        "comportamento e mais forte que o de texto: pega qualquer apelido novo, "
        "e nao so os que a expressao regular previu"
    ),
}

# Duas formas do mesmo defeito, e a segunda e a que faltava.
#
# A primeira e o cadastro lido pelo OBJETO — `servidor.nome`, `p.servidor.siape`,
# `sv.nome`. A segunda e o MESMO dado com outro nome de campo, e foi por ela que
# `previa_parecer.html` passou: `c.nome_servidor` nao e `servidor.nome`, entao a
# guarda nunca o acusou e o arquivo nem chegou a precisar de dispensa. O campo
# mudou de nome; o dado nao. Fechar o caso sem fechar a classe deixaria o defeito
# voltar no proximo `nome_servidor_snapshot` ou `servidor_nome`.
#
# A segunda forma exige as DUAS palavras juntas ("servidor" colada em
# "nome"/"siape"/"matricula") de proposito: `assinante_matricula`,
# `participante_siape` e `usuario_nome` sao identificacao de quem ASSINA, de quem
# PARTICIPA e de quem OPEROU — documento e trilha, nominais por definicao —, e
# uma guarda que os acusasse seria desligada por dispensa no mesmo dia.
_RE_LEITURA_NOMINAL = re.compile(
    r"\b(?:\w+\.)?(?:servidor|sv)\.(?:nome|siape)\b"
    r"|\.\w*(?:nome|siape|matricula)_servidor\w*"
    r"|\.\w*servidor_(?:nome|siape|matricula)\w*"
)

# Comentario Jinja nao chega a pagina nenhuma, entao nao pode vazar nome. Sai
# antes da varredura por um motivo concreto: o comentario que ABRE `busca.html`
# explica a regra escrevendo `servidor.nome` no meio da frase, e a guarda casava
# com a propria prosa que a descreve. O caminho errado seria dispensar o arquivo
# — a tela de busca e onde vazamento de nome mais importa, e ela ficaria sem
# guarda por causa de um comentario.
_RE_COMENTARIO_JINJA = re.compile(r"\{#.*?#\}", re.S)


def _leituras_nominais(texto: str) -> list[str]:
    """O que este template imprime lendo o cadastro direto. So o que RENDERIZA."""
    return _RE_LEITURA_NOMINAL.findall(_RE_COMENTARIO_JINJA.sub("", texto))


def test_rn19_nenhum_template_le_nome_de_servidor_direto():
    raiz = Path(__file__).resolve().parents[2] / "app" / "templates"
    reincidentes = {}
    for arquivo in sorted(raiz.rglob("*.html")):
        relativo = arquivo.relative_to(raiz).as_posix()
        if relativo in DISPENSAS_RN19:
            continue
        achados = _leituras_nominais(arquivo.read_text(encoding="utf-8"))
        if achados:
            reincidentes[relativo] = sorted(set(achados))
    assert not reincidentes, (
        "template lendo identificacao nominal direto do cadastro — use "
        f"`identificar(...)` (RN-19): {reincidentes}"
    )


def test_a_guarda_da_rn19_continua_mordendo():
    """Sonda da guarda acima — a exclusao de comentario nao pode esvazia-la.

    Guarda de privacidade que deixou de acusar nao avisa ninguem: ela passa, e o
    silencio se le como "esta tudo certo". Depois de ensina-la a pular
    comentario, o que prova que ela serve e ela reprovar codigo de verdade.
    """
    assert _leituras_nominais("<td>{{ servidor.nome }}</td>") == ["servidor.nome"]
    assert _leituras_nominais("<td>{{ p.servidor.siape }}</td>") == ["p.servidor.siape"]
    assert _leituras_nominais("<td>{{ sv.nome }}</td>") == ["sv.nome"]

    # o caso que motivou a exclusao: a mesma expressao, dentro de comentario
    assert _leituras_nominais("{# nenhuma linha imprime `servidor.nome` #}") == []

    # e a armadilha do meio-termo: comentario ao lado de codigo de verdade nao
    # pode servir de esconderijo para o codigo
    assert _leituras_nominais(
        "{# use identificar, nunca servidor.nome #}\n<td>{{ servidor.nome }}</td>"
    ) == ["servidor.nome"]


def test_a_guarda_da_rn19_pega_o_apelido_e_nao_so_o_nome_canonico():
    """A segunda sonda: o defeito de `previa_parecer.html` era de NOME DE CAMPO.

    A guarda casava `servidor.nome` e `sv.nome` e passou trinta e quatro versoes
    convencida de que nenhum template lia identificacao direto — enquanto
    `{{ c.nome_servidor }}` imprimia nome e `{{ c.matricula }}` imprimia SIAPE
    sob `parecer.ver`. Nao foi burla: foi o mesmo dado com outro rotulo, que e
    como este defeito volta. Fechar so o caso e convidar o proximo apelido.
    """
    # o caso medido, e os dois apelidos que o dominio ja tem escritos no banco
    assert _leituras_nominais("<td>{{ c.nome_servidor }}</td>") == [".nome_servidor"]
    assert _leituras_nominais("{{ r.nome_servidor_snapshot }}") == [
        ".nome_servidor_snapshot"
    ]
    assert _leituras_nominais("{{ ctx.servidor_nome }} {{ ctx.siape_servidor }}") == [
        ".servidor_nome",
        ".siape_servidor",
    ]

    # ...e o contrapeso, sem o qual a guarda seria desligada por dispensa:
    # identificacao de quem ASSINA, de quem PARTICIPA e de quem OPEROU e
    # documento e trilha, nominais por definicao.
    assert _leituras_nominais(
        "{{ c.assinante_nome }} · Mat. SIAPE {{ c.assinante_matricula }}"
    ) == []
    assert _leituras_nominais("{{ ct.participante_nome }} / {{ ct.participante_siape }}") == []
    assert _leituras_nominais("{{ e.usuario_nome }}") == []
    # o resultado de `identificar()` NAO pode ser acusado: e a saida certa
    assert _leituras_nominais("{{ identificar(p).com_siape }} {{ ident.siape }}") == []
    # e a prosa que descreve a regra continua fora da varredura
    assert _leituras_nominais("{# nunca imprima c.nome_servidor aqui #}") == []


# =====================================================================
# RN-19 no TEXTO LIVRE — a trilha de auditoria e a pendência
# =====================================================================
# As duas primeiras das três portas que a auditoria de privacidade mediu. Nas
# duas o nome sai por FORA de `identificar()`, e não por descuido de template: a
# frase inteira foi escrita no ato do evento — "Rascunho de requisição de EPI
# para Fulano (SIAPE 3010077) aberto por Beltrana" — e não existe campo de nome
# que o helper pudesse interceptar.
#
# O conserto é na LEITURA porque não pode ser na escrita já gravada:
# `descricao` entra no digest SHA-256 da cadeia (`auditoria._digerir`), e
# reescrever o passado derrubaria a conferência que dá valor probatório à
# trilha. A outra metade — parar de escrever nome em `descricao` nova — é
# definitiva e vale só para o que ainda não foi gravado; as duas não se
# substituem.


@pytest.fixture()
def texto_livre_com_nome(banco, servidor, processo_do_servidor):
    """Um evento de trilha e uma pendência com o nome e o SIAPE por dentro.

    Reproduz a forma exata que a auditoria mediu em `/epis/requisicoes/6` e em
    `/pendencias`: o dado identificador no meio da frase, e não numa coluna.
    """
    from app import banco as mod_banco
    from app.modelos import Processo
    from app.servicos import pendencias
    from app.servicos.auditoria import registrar

    with mod_banco.sessao() as s:
        registrar(
            s,
            entidade=Processo.__tablename__,
            entidade_id=processo_do_servidor,
            processo_id=processo_do_servidor,
            tipo_evento="COMENTARIO",
            descricao=f"Rascunho aberto para {NOME} (SIAPE {SIAPE}).",
            usuario_nome="Quem Escreveu",
        )
        pendencias.abrir(
            s,
            tipo="INCLUIR_NO_SEI",
            chave=f"rn19:{processo_do_servidor}",
            descricao=f"Anexar o comprovante assinado entregue a {NOME}",
            processo_id=processo_do_servidor,
        )
        s.commit()
    return processo_do_servidor


# A lista existe pelo mesmo motivo de `TELAS_COM_SERVIDOR`: tela que renderiza
# texto livre da trilha ou da pendência entra aqui, e não é descoberta por
# vazamento. Hoje são seis (`/auditoria` fica de fora só porque este perfil não
# a abre — o teste logo abaixo cobre quem a abre).
TELAS_COM_TEXTO_LIVRE = ("/", "/pendencias")


@pytest.mark.parametrize("caminho", TELAS_COM_TEXTO_LIVRE)
def test_rn19_texto_livre_nao_entrega_nome_nem_siape(
    app_cliente, contas, texto_livre_com_nome, caminho
):
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get(caminho)
    assert resposta.status_code == 200, caminho
    assert NOME not in resposta.text, caminho
    assert SIAPE not in resposta.text, caminho


def test_rn19_trilha_do_processo_nao_entrega_nome_nem_siape(
    app_cliente, contas, texto_livre_com_nome
):
    """A ficha do processo tem as duas portas, uma em cada aba: o histórico é o
    texto livre da trilha, o checklist traz as pendências abertas dele."""
    entrar(app_cliente, contas, "secretaria_csso")
    for aba in ("historico", "checklist"):
        resposta = app_cliente.get(f"/processos/{texto_livre_com_nome}?aba={aba}")
        assert resposta.status_code == 200, aba
        assert NOME not in resposta.text, aba
        assert SIAPE not in resposta.text, aba


def test_rn19_auditoria_nao_entrega_nome_a_quem_so_audita(
    app_cliente, contas, texto_livre_com_nome
):
    """`auditoria.ver` não é permissão de ler nome.

    `admin_ti` a tem, e a base normativa do perfil diz "sem acesso ao conteúdo
    técnico" — a trilha renderizada era o caminho por onde o conteúdo voltava. O
    resto da linha (quem, quando, entidade, campo, antes → depois) continua
    inteiro: é dele que a conferência da cadeia depende.
    """
    entrar(app_cliente, contas, "admin_ti")
    resposta = app_cliente.get("/auditoria")
    assert resposta.status_code == 200
    assert NOME not in resposta.text
    assert SIAPE not in resposta.text


def test_rn19_titular_le_a_propria_trilha(
    app_cliente, contas, banco, servidor, texto_livre_com_nome
):
    """LGPD art. 18, II — o contrapeso, e o que obriga o `sobre=` a existir.

    Sem ele a supressão do texto livre acertaria o dono do dado junto com o
    terceiro: o perfil que existe para consultar o próprio processo leria a
    própria história como "conteúdo suprimido".
    """
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = servidor
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    corpo = app_cliente.get(f"/processos/{texto_livre_com_nome}?aba=historico").text
    assert NOME in corpo


def test_rn19_quem_ve_exposicao_continua_lendo_o_texto_livre(
    app_cliente, contas, texto_livre_com_nome
):
    """O outro contrapeso: a supressão não pode esvaziar a tela de quem trabalha.

    Sem este teste, um `texto_livre()` que não achasse o usuário no contexto
    suprimiria tudo para todo mundo — e o teste de vazamento acima passaria,
    satisfeito, com a trilha ilegível para a CSSO inteira.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    for caminho in (
        "/",
        "/pendencias",
        f"/processos/{texto_livre_com_nome}?aba=historico",
        f"/processos/{texto_livre_com_nome}?aba=checklist",
    ):
        resposta = app_cliente.get(caminho)
        assert resposta.status_code == 200, caminho
        assert NOME in resposta.text, caminho


# =====================================================================
# RN-19 na ESCRITA — a outra metade: parar de GRAVAR nome em prosa nova
# =====================================================================
# A supressão acima é a única metade que alcança o que JÁ ESTÁ GRAVADO: a trilha
# entra num digest SHA-256 encadeado e o razão do lote tem trigger, e nenhum dos
# dois se reescreve. Ela continua de pé, e é a rede de segurança do histórico.
#
# Esta seção é a outra metade, e é a definitiva: prosa nova não nasce mais com
# nome nem SIAPE dentro. Feito isso, a supressão na leitura deixa de ser a regra
# de operação — a frase que chega à tela de quem PODE lê-la já não identifica
# ninguém por si, e a permissão volta a decidir sobre conteúdo que não é bomba.
#
# QUAL É O CRITÉRIO. É identificação o nome (ou a matrícula) de uma PESSOA
# NATURAL de quem o registro fala — o titular do dado ocupacional: o servidor da
# ficha, do pedido, do parecer; o participante da turma. Não é identificação o
# nome de COISA — `campus.nome`, `posto.nome`, `modelo.nome`, `item.nome`,
# `treinamento.nome`, `entrada.fornecedor_nome`, `laudo.numero_siape` (que é
# número de laudo, e não matrícula de gente). E há duas pessoas que continuam
# nominais de propósito, pela mesma razão que a lista `DISPENSAS_RN19` acima já
# escreve: quem OPEROU (`usuario.nome`), porque a trilha imprime `usuario_nome`
# numa COLUNA ao lado da descrição, por desenho — repeti-lo na prosa não expõe
# nada que a linha já não diga; e quem ASSINA (o instrutor), porque o nome dele
# é o que vai impresso na rubrica do certificado, e ele não é servidor sob
# avaliação.
#
# O QUE A FRASE PERDE, e por que se aceita. "Entregue a Joana Ribeiro" virou
# "entregue ao servidor #12" — mais pobre para quem PODE ler. Aceita-se porque a
# supressão na leitura já tornava a frase INTEIRA invisível para quem não pode:
# a troca não é entre nome e id, é entre "conteúdo suprimido" e uma frase
# legível com um id no lugar do nome.
#
# E NÃO SE RESOLVE O `#id` DE VOLTA EM NOME NA TELA. A tentação existe — seria
# devolver a legibilidade a quem tem `exposicao.ver` sem devolver o vazamento.
# Três razões somadas dizem que não: (a) só ajudaria quem já tem a permissão, e
# para essa pessoa a ficha está a UM CLIQUE pela âncora `entidade#entidade_id` —
# e é lá, e não na lista, que a leitura nominal fica registrada
# (`registrar_leitura_nominal`, RN-23); resolver o nome no meio da trilha
# entregaria dado identificado por uma tela que deliberadamente NÃO registra
# (1.38.0), que é o defeito "35 leituras, tabela de 0 a 0" voltando pela porta
# dos fundos; (b) substituir padrão dentro de prosa arbitrária é a mesma coisa
# que `texto_livre` recusa fazer para raspar nome, com o erro invertido e igual
# de ruim — `Registro 12`, `pedido #45` e `lote #7` se parecem, e resolver
# errado põe o nome da PESSOA ERRADA numa linha de auditoria; (c) `texto_livre`
# não tem sessão, e dá-la a ele faria cada linha da trilha custar uma consulta.
#
# O QUE NÃO SAI: o congelado da RN-15 em COLUNA — `nome_servidor_snapshot`,
# `siape_snapshot`, `participante_nome` do contexto do certificado. É ele que faz
# o comprovante reimprimir igual anos depois, e documento nomeia a pessoa por
# definição. O que saiu foi o nome dentro do TEXTO LIVRE. A varredura abaixo
# separa os dois: ela só olha a prosa, e a sonda prova que a coluna passa.

# Os quatro campos por onde a prosa é gravada: descrição de trilha, descrição de
# pendência, motivo de movimento do razão, e as duas justificativas.
CAMPOS_DE_PROSA = ("descricao", "motivo", "finalidade", "justificativa")

# O titular do dado ocupacional lido pelo OBJETO.
DONOS_DO_TITULAR = ("servidor", "sv", "participante", "inscrito", "requerente", "titular")

# Os dois papéis que continuam nominais, e o motivo está no cabeçalho da seção.
# Sem eles a varredura acusaria `usuario.nome` em quatro pontos legítimos e
# seria desligada por dispensa no mesmo dia — que é como guarda morre.
DONOS_NOMINAIS_POR_DEFINICAO = ("usuario", "instrutor", "assinatura", "assinante")

_RE_ATRIBUTO_DO_TITULAR = re.compile(r"(?:nome|siape|email|matricula)(?:_\w+)?")

# A segunda forma do mesmo defeito, e é a que a 1.35.0 aprendeu: o MESMO dado com
# outro rótulo. `nome_servidor_snapshot` não é `servidor.nome`, e foi por um
# apelido assim que a prévia do parecer passou trinta e quatro versões. Aqui o
# apelido é acusado por ele mesmo, sem depender de quem é o dono.
_RE_ATRIBUTO_APELIDADO = re.compile(
    r"\w*(?:nome|siape|matricula)_(?:servidor|participante)\w*"
    r"|\w*(?:servidor|participante)_(?:nome|siape|matricula)\w*"
    r"|siape_snapshot"
    r"|nome_exibicao"
)

# A lista está VAZIA, e é assim que ela tem de ficar. Ela nasceu com uma entrada
# só — `servicos/epi_ficha.py`, os seis pontos da entrega, do estorno, da
# devolução, do comprovante impresso, do comprovante anexado e da pendência do
# comprovante —, escrita como bilhete com prazo enquanto o arquivo estava em
# edição por outra sessão. Os seis foram convertidos para `servidor #{id}` e o
# bilhete venceu. Dispensa aqui é confissão de vazamento conhecido, e não
# licença: quem precisar de uma escreve o motivo e assume que a prosa daquele
# arquivo continua nomeando gente.
DISPENSAS_RN19_ESCRITA: dict[str, str] = {}


def _caminho_pontilhado(no: ast.Attribute) -> str:
    """`inscricao.participante.nome_exibicao` — a expressão como ela foi escrita."""
    partes: list[str] = []
    atual: ast.expr = no
    while isinstance(atual, ast.Attribute):
        partes.append(atual.attr)
        atual = atual.value
    partes.append(atual.id if isinstance(atual, ast.Name) else "…")
    return ".".join(reversed(partes))


def _identifica_pessoa(caminho: str) -> bool:
    dono, _, atributo = caminho.rpartition(".")
    if not dono:
        return False
    ultimo_dono = dono.rpartition(".")[2]
    if ultimo_dono in DONOS_NOMINAIS_POR_DEFINICAO:
        return False
    if ultimo_dono in DONOS_DO_TITULAR and _RE_ATRIBUTO_DO_TITULAR.fullmatch(atributo):
        return True
    return bool(_RE_ATRIBUTO_APELIDADO.fullmatch(atributo))


def _prosa_gravada(arvore: ast.AST):
    """Só o que vai virar texto livre: o valor dos campos de prosa.

    Fica de fora, e é o ponto: `EpiFichaRegistro(nome_servidor_snapshot=...)` e
    `ContextoComprovante(servidor_nome=...)` são COLUNA, e a RN-15 manda o
    congelado ficar. A varredura nunca olha para eles porque nunca olha para
    keyword que não seja de prosa.
    """
    for no in ast.walk(arvore):
        if isinstance(no, ast.Call):
            for kw in no.keywords:
                if kw.arg in CAMPOS_DE_PROSA:
                    yield kw.value
        elif isinstance(no, ast.Assign):
            for alvo in no.targets:
                rotulo = (
                    alvo.id
                    if isinstance(alvo, ast.Name)
                    else alvo.attr if isinstance(alvo, ast.Attribute) else None
                )
                if rotulo in CAMPOS_DE_PROSA:
                    yield no.value


def identificacao_em_prosa(fonte: str) -> list[str]:
    """A varredura vai pela ÁRVORE, e não pelo texto, e isso resolve de graça o
    problema que a guarda dos templates teve de resolver com expressão regular:
    comentário e literal de string não são expressão, então prosa que EXPLICA a
    regra escrevendo `servidor.nome` no meio da frase nunca é acusada — e um
    `#` dentro de f-string (`f"servidor #{id}"`) não engole o resto da linha,
    que é o que aconteceria raspando comentário por regex."""
    achados: set[str] = set()
    for valor in _prosa_gravada(ast.parse(fonte)):
        for no in ast.walk(valor):
            if isinstance(no, ast.Attribute):
                caminho = _caminho_pontilhado(no)
                if _identifica_pessoa(caminho):
                    achados.add(caminho)
    return sorted(achados)


def test_rn19_nenhuma_prosa_nova_grava_nome_de_pessoa():
    raiz = Path(__file__).resolve().parents[2] / "app"
    reincidentes = {}
    for arquivo in sorted(raiz.rglob("*.py")):
        relativo = arquivo.relative_to(raiz).as_posix()
        if relativo in DISPENSAS_RN19_ESCRITA:
            continue
        achados = identificacao_em_prosa(arquivo.read_text(encoding="utf-8"))
        if achados:
            reincidentes[relativo] = achados
    assert not reincidentes, (
        "descrição de trilha, descrição de pendência ou motivo de movimento "
        "gravando identificação de pessoa dentro da frase — grave o "
        "`servidor #{id}` (ou o `PTC-` do participante) e deixe quem pode ler "
        f"resolver quem é pela ficha (RN-19): {reincidentes}"
    )


def test_a_trava_da_escrita_morde():
    """Sonda: sem ela, uma expressão regular torta faz a varredura passar por vazio.

    As quatro linhas abaixo são as que o sistema gravava de verdade — a primeira
    é a frase que `identificacao.texto_livre` cita como o caso, a segunda e a
    terceira são o par da ficha de EPI, a quarta é a lista de chamada gravada em
    prosa. Se alguma delas parar de ser acusada, a guarda não serve.
    """
    assert identificacao_em_prosa(
        'auditoria.registrar(s, descricao=f"Rascunho de requisição de EPI para '
        '{servidor.nome} (SIAPE {servidor.siape}) aberto por {usuario.nome}")'
    ) == ["servidor.nome", "servidor.siape"]

    assert identificacao_em_prosa(
        'epi_estoque.devolver(s, motivo=f"devolução do SIAPE '
        '{registro.siape_snapshot}: {limpo}")'
    ) == ["registro.siape_snapshot"]

    assert identificacao_em_prosa(
        'auditoria.registrar(s, descricao=f"{q} × {registro.nome_epi_snapshot} '
        'para {registro.nome_servidor_snapshot} (SIAPE {registro.siape_snapshot})")'
    ) == ["registro.nome_servidor_snapshot", "registro.siape_snapshot"]

    assert identificacao_em_prosa(
        'auditoria.registrar(s, descricao=f"{turma.codigo} · '
        '{inscricao.participante.nome_exibicao}: presente")'
    ) == ["inscricao.participante.nome_exibicao"]

    # e o apelido de campo, que é como este defeito volta: outro rótulo, mesmo
    # dado — nenhum deles se escreve `servidor.nome`
    assert identificacao_em_prosa(
        'pendencias.abrir(s, descricao=f"{c.servidor_nome} {ctx.participante_nome} '
        '{p.siape_servidor}")'
    ) == ["c.servidor_nome", "ctx.participante_nome", "p.siape_servidor"]


def test_a_trava_da_escrita_nao_acusa_nome_de_coisa():
    """O contrapeso, sem o qual a guarda seria desligada por dispensa.

    Dos 33 pontos que o levantamento marcou, a maioria era nome de COISA. Uma
    varredura que acusasse `campus.nome` obrigaria a dispensar meia dúzia de
    arquivos legítimos, e arquivo dispensado deixa de ser varrido por inteiro —
    inclusive pelo vazamento de verdade que aparecer nele amanhã.
    """
    for fonte in (
        'registrar(s, descricao=f"{sigla} · {campus.nome} · {campus.cidade}")',
        'registrar(s, descricao=f"{posto.nome} — {posto.unidade.nome_extenso}")',
        'registrar(s, descricao=f"{modelo.nome} ({n} itens)")',
        'registrar(s, descricao=f"{item.nome} · {item.categoria.nome}")',
        'registrar(s, descricao=f"{treinamento.codigo} · {treinamento.nome}")',
        'registrar(s, descricao=f"{q} × {item.nome} · {entrada.fornecedor_nome}")',
        'abrir(s, descricao=f"Laudo {laudo.numero_siape} superado")',
        'registrar(s, descricao=f"{parecer.tipo_adicional.nome} {pct.rotulo}")',
    ):
        assert identificacao_em_prosa(fonte) == [], fonte

    # quem OPEROU e quem ASSINA: nominais por definição, e o cabeçalho da seção
    # diz por quê. A trilha já imprime `usuario_nome` na coluna ao lado.
    assert identificacao_em_prosa(
        'registrar(s, descricao=f"Máximo excedido e autorizado por {usuario.nome}")'
    ) == []
    assert identificacao_em_prosa(
        'registrar(s, descricao=f"{turma.codigo}: {instrutor.nome_exibicao}")'
    ) == []
    assert identificacao_em_prosa(
        'registrar(s, descricao=f"{assinatura.nome} · {assinatura.titulo}")'
    ) == []

    # a identidade que SUBSTITUI o nome não pode ser acusada: é a saída certa
    assert identificacao_em_prosa(
        'registrar(s, descricao=f"para o servidor #{servidor.id} · '
        '{participante.identificador_publico}")'
    ) == []

    # e a prosa que DESCREVE a regra continua fora — o comentário e o literal
    # não são expressão, então a árvore nem os vê
    assert identificacao_em_prosa(
        'registrar(\n'
        '    s,\n'
        '    # nunca grave servidor.nome aqui\n'
        '    descricao="use servidor.nome? não: use o id",\n'
        ')'
    ) == []


def test_a_trava_da_escrita_nao_acusa_o_snapshot_em_coluna():
    """RN-15 e RN-19 não se confundem, e a diferença é COLUNA versus PROSA.

    `nome_servidor_snapshot` numa coluna é o congelado que faz o comprovante
    reimprimir igual daqui a cinco anos; tirá-lo seria trocar um problema de
    privacidade por um de prova. O que sai é o nome dentro da frase. Sem esta
    sonda, um zelo a mais na varredura levaria junto o congelado inteiro.
    """
    assert identificacao_em_prosa(
        "registro = EpiFichaRegistro(\n"
        "    nome_servidor_snapshot=servidor.nome,\n"
        "    siape_snapshot=servidor.siape,\n"
        "    nome_epi_snapshot=item.nome,\n"
        ")"
    ) == []
    assert identificacao_em_prosa(
        "ctx = ContextoComprovante(\n"
        "    servidor_nome=registro.nome_servidor_snapshot,\n"
        "    participante_nome=participante.nome_exibicao,\n"
        ")"
    ) == []
    # o documento emitido também continua nominal: ele não passa por campo de
    # prosa nenhum
    assert identificacao_em_prosa(
        'contexto = {"nome": servidor.nome, "matricula": servidor.siape}'
    ) == []


def test_a_trava_da_escrita_acusa_a_linha_real_se_ela_voltar():
    """A prova na prática, e não só em fragmento: o arquivo de verdade.

    Sonda de fragmento prova o que a expressão regular faz; ela não prova que a
    varredura chega ao código que importa. Aqui o arquivo real é lido, a frase
    de antes é reposta nele em memória — nada é gravado —, e exige-se que a
    varredura a acuse pelo nome. É o que a 1.38.0 fez com a rota de escopo.
    """
    alvo = (
        Path(__file__).resolve().parents[2]
        / "app"
        / "servicos"
        / "epi_requisicao.py"
    )
    fonte = alvo.read_text(encoding="utf-8")

    # o arquivo, como está hoje, passa
    assert identificacao_em_prosa(fonte) == []

    de_antes = fonte.replace(
        'f"Rascunho de requisição de EPI para o servidor #{servidor.id} "\n'
        '            f"aberto por {usuario.nome}"',
        'f"Rascunho de requisição de EPI para {servidor.nome} "\n'
        '            f"(SIAPE {servidor.siape}) aberto por {usuario.nome}"',
    )
    assert de_antes != fonte, "a frase de antes não foi reposta — a sonda não provou nada"
    assert identificacao_em_prosa(de_antes) == ["servidor.nome", "servidor.siape"]


def test_a_dispensa_da_escrita_aponta_para_arquivo_que_existe():
    """A lista está vazia hoje, e este teste é a condição de qualquer entrada nela.

    Dispensa que aponta para arquivo que já não existe é dispensa que ninguém
    tira: ela fica no arquivo parecendo cuidado e não absolve nada — até o dia em
    que o caminho volta a existir e ela passa a absolver em silêncio. E dispensa
    sem motivo escrito é dispensa que se copia. Por isso as duas cobranças, e por
    isso elas ficam de pé mesmo com a lista vazia: elas valem para a PRÓXIMA
    entrada, que é quando ninguém está olhando.
    """
    raiz = Path(__file__).resolve().parents[2] / "app"
    for relativo, frase in DISPENSAS_RN19_ESCRITA.items():
        assert (raiz / relativo).exists(), relativo
        assert len(frase) > 80, relativo


# =====================================================================
# RN-19 na PRÉVIA do parecer — e o documento emitido continua nominal
# =====================================================================


@pytest.fixture()
def parecer_do_servidor(banco, servidor):
    from app import banco as mod_banco
    from app.modelos import ParecerTecnico, TipoAdicional

    with mod_banco.sessao() as s:
        insalubridade = s.execute(
            select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
        ).scalar_one()
        parecer = ParecerTecnico(
            numero=0,
            ano=date.today().year,
            situacao="RASCUNHO",
            servidor_id=servidor,
            tipo_adicional_id=insalubridade.id,
        )
        s.add(parecer)
        s.commit()
        return parecer.id


def test_rn19_previa_do_parecer_nao_entrega_nome_nem_siape(
    app_cliente, contas, parecer_do_servidor
):
    """A terceira porta, e a guarda de comportamento que substitui a varredura.

    `previa_parecer.html` está nas dispensas da varredura de texto (o motivo
    está escrito lá: o fac-símile imprime o CONGELADO da RN-15). Quem prova que
    a supressão continua de pé é este teste — e ele é mais forte que a
    varredura, porque pega qualquer apelido novo, e não só os que a expressão
    regular previu. `secretaria_csso` tem `parecer.ver` e não tem
    `exposicao.ver`: é exatamente o leitor que a RN-19 existe para conter.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    for caminho in (
        f"/pareceres/{parecer_do_servidor}",
        f"/pareceres/{parecer_do_servidor}/previa",
    ):
        resposta = app_cliente.get(caminho)
        assert resposta.status_code == 200, caminho
        assert NOME not in resposta.text, caminho
        assert SIAPE not in resposta.text, caminho
        assert re.findall(r"SRV-[0-9a-f]{4}\b", resposta.text), (
            f"{caminho}: suprimiu o nome e não pôs o código opaco no lugar — "
            "célula vazia se lê como parecer sem servidor"
        )


def test_rn19_previa_continua_nominal_para_quem_ve_exposicao(
    app_cliente, contas, parecer_do_servidor
):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(f"/pareceres/{parecer_do_servidor}/previa").text
    assert NOME in corpo
    assert SIAPE in corpo


def test_rn19_titular_ve_o_proprio_parecer_nominal(
    app_cliente, contas, banco, servidor, parecer_do_servidor
):
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "servidor_consulta")
        ).scalar_one()
        conta.servidor_id = servidor
        s.commit()

    entrar(app_cliente, contas, "servidor_consulta")
    assert NOME in app_cliente.get(f"/pareceres/{parecer_do_servidor}/previa").text


def test_rn19_o_documento_emitido_continua_nominal():
    """O limite da correção da prévia: o PAPEL não muda.

    Parecer é documento — ele nomeia a pessoa por definição, e o `.docx` e o
    `.pdf` não passam por `previa_parecer.html`: `documento.renderizar` alimenta
    o modelo congelado com `ContextoParecer.como_dicionario()`. Este teste é o
    que impede a próxima correção de privacidade de "consertar" o documento
    junto com a tela.
    """
    from testes.fixtures.dados_parecer_1_2025 import contexto_1_2025

    campos = contexto_1_2025().como_dicionario()
    assert campos["nome_servidor"] == "Marco Antônio Alves Schetino"
    assert campos["matricula"] == "1110654"

    raiz = Path(__file__).resolve().parents[2] / "app" / "servicos" / "documento.py"
    assert "previa_parecer" not in raiz.read_text(encoding="utf-8"), (
        "o documento passou a sair do template da prévia — a supressão da tela "
        "iria junto para o papel"
    )


# =====================================================================
# RN-19 na TURMA — a lista de chamada e a busca que inscreve
# =====================================================================
# As duas portas que a auditoria de privacidade marcou como "graves só ao
# ampliar" (G-4 e G-5). Elas são teóricas enquanto ninguém de fora do setor tem
# conta, e deixam de ser no dia em que a inscrição do servidor comum existir —
# porque o que a faz existir não é a permissão nova, é o ESCOPO que terá de
# mudar para ela funcionar.
#
# O que a lista de chamada diz não é "fulano existe": é **fulano fez NR-35**,
# ou seja, em que atividade de risco ele trabalha. É a mesma classe de dado que
# a RN-19 protege no parecer, chegando por outra tela.
#
# A divisão é a mesma que a 1.35.0 fez entre a prévia do parecer e o `.docx`
# emitido, e ela se repete aqui: **o papel continua nominal** — a folha que
# circula em campo para assinar nomeia quem assina, por definição, sai em .docx
# por `servicos/lista_presenca.py` e pede `turma.avaliar` —, **a tela obedece à
# RN-19**.

NOME_EXTERNO = "Zulmira Tavares Bittencourt"
EMAIL_EXTERNO = "zulmira@empresacontratada.com.br"
SIAPE_SEM_TURMA = "1110777"
NOME_SEM_TURMA = "Lourival Bittencourt Sá"


@pytest.fixture()
def turma_com_inscritos(banco, servidor):
    """Uma turma de NR-35 com os dois tipos de inscrito que existem.

    O servidor do cadastro (ponteiro, nome lido de `servidor`) e um
    terceirizado (o único lugar do sistema onde o nome dele existe). São dois
    porque a pergunta "quem pode ler este nome" tem resposta diferente para cada
    um, e uma correção que só olhasse o servidor deixaria o terceirizado
    nominal na mesma tabela.
    """
    from datetime import timedelta

    from app import banco as mod_banco
    from app.modelos import Inscricao, Servidor, Treinamento, Turma
    from app.servicos import participante as servico_participante

    inicio = date.today() + timedelta(days=10)
    with mod_banco.sessao() as s:
        treinamento = Treinamento(
            codigo="NR35-RN19",
            nome="NR-35 — Segurança no Trabalho em Altura (RN-19)",
            carga_horaria_horas=8,
        )
        s.add(treinamento)
        s.flush()
        turma = Turma(
            treinamento_id=treinamento.id,
            numero=901,
            ano=inicio.year,
            codigo=f"TUR-{inicio.year}-0901",
            data_inicio=inicio,
            data_fim=inicio,
            situacao="INSCRICOES_ABERTAS",
        )
        s.add(turma)
        s.flush()
        do_servidor = servico_participante.de_servidor(
            s, s.get(Servidor, servidor)
        )
        externo = servico_participante.criar_externo(
            s, nome=NOME_EXTERNO, vinculo="TERCEIRIZADO", email=EMAIL_EXTERNO
        )
        s.add_all(
            [
                Inscricao(turma_id=turma.id, participante_id=do_servidor.id),
                Inscricao(turma_id=turma.id, participante_id=externo.id),
            ]
        )
        s.commit()
        return {
            "turma": turma.id,
            "ptc_servidor": do_servidor.identificador_publico,
            "ptc_externo": externo.identificador_publico,
        }


@pytest.fixture()
def sem_certificado_ver(banco):
    """A conta que o cenário 6 da auditoria mediu, montada com peça de verdade.

    Ela ainda não existe: `servidor_consulta` tem escopo próprio, e a ficha da
    turma lhe responde 303 antes de renderizar coisa alguma — é por isso que o
    achado é "grave só ao ampliar". O que a auditoria mediu foi o escopo
    alargado para `E`, e o que sobra dessa conta é exatamente uma secretaria sem
    `certificado.ver`: `treinamento.ver` e `turma.inscrever`, escopo de unidade,
    sem `exposicao.ver`.

    Tirar a permissão do Perfil de verdade — e não fabricar um `UsuarioAtual` à
    mão — é o que faz este teste ABRIR a tela pelo caminho inteiro: rota,
    escopo, `pagina()` e template.
    """
    from app import banco as mod_banco
    from app.modelos import Perfil

    with mod_banco.sessao() as s:
        perfil = s.execute(
            select(Perfil).where(Perfil.codigo == "secretaria_csso")
        ).scalar_one()
        perfil.permissoes = [
            p for p in perfil.permissoes if p.codigo != "certificado.ver"
        ]
        s.commit()


ABAS_DA_TURMA = ("inscricoes", "presencas", "emissao")


@pytest.mark.parametrize("aba", ABAS_DA_TURMA)
def test_rn19_lista_de_chamada_nao_nomeia_quem_esta_na_turma(
    app_cliente, contas, sem_certificado_ver, turma_com_inscritos, aba
):
    """G-4. As três abas mostram a mesma lista de chamada, e as três suprimem.

    Suprimir só a aba de inscrições seria mudar de aba para ler o mesmo nome —
    e a grade de presença é a lista de chamada transcrita, com a mesma gente.

    O `PTC-…` cai junto com o nome, e é a parte não óbvia: ele é sorteado e não
    é enumerável, mas — ao contrário do `SRV-…`, que troca a cada sessão por
    desenho — é estável para sempre e sai impresso ao lado do nome na folha de
    presença que passa de mão em mão na sala. Publicá-lo a quem não pode ver o
    nome entrega um apelido permanente que uma única folha assinada resolve.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get(f"/turmas/{turma_com_inscritos['turma']}?aba={aba}")
    assert resposta.status_code == 200, aba
    for vazamento in (
        NOME,
        SIAPE,
        NOME_EXTERNO,
        EMAIL_EXTERNO,
        turma_com_inscritos["ptc_servidor"],
        turma_com_inscritos["ptc_externo"],
    ):
        assert vazamento not in resposta.text, f"{aba}: {vazamento}"
    assert re.findall(r"SRV-[0-9a-f]{4}\b", resposta.text), (
        f"{aba}: suprimiu o nome e não pôs o código opaco no lugar — célula "
        "vazia se lê como turma sem inscrito"
    )


# A medida "perfil a perfil" que a 1.35.0 fixou como método: a correção não pode
# tirar nada de quem trabalha. Todo perfil da CSSO que abre a ficha da turma tem
# `certificado.ver` — é essa a razão de ela ser o discriminador, e não uma
# permissão nova.
PERFIS_QUE_OPERAM_TURMA = (
    "coordenador_csso",
    "engenheiro_seguranca",
    "medico_trabalho",
    "tecnico_seguranca",
    "secretaria_csso",
    "superintendente",
    "consulta_progep",
    "auditor_interno",
)


@pytest.mark.parametrize("perfil", PERFIS_QUE_OPERAM_TURMA)
def test_rn19_lista_de_chamada_continua_nominal_para_a_csso(
    app_cliente, contas, turma_com_inscritos, perfil
):
    """O contrapeso, e sem ele o teste acima passaria com a tela quebrada.

    `secretaria_csso` é o caso que decide: ela NÃO tem `exposicao.ver` e opera a
    inscrição e a emissão — se a supressão fosse pendurada em `exposicao.ver`,
    ela emitiria certificado para uma lista de códigos.
    """
    entrar(app_cliente, contas, perfil)
    corpo = app_cliente.get(
        f"/turmas/{turma_com_inscritos['turma']}?aba=inscricoes"
    ).text
    assert NOME in corpo, perfil
    assert NOME_EXTERNO in corpo, perfil
    assert turma_com_inscritos["ptc_servidor"] in corpo, perfil


def test_rn19_titular_se_le_na_lista_de_chamada(
    app_cliente, contas, banco, servidor, sem_certificado_ver, turma_com_inscritos
):
    """LGPD art. 18, II — e é o que obriga a decisão a ser por LINHA.

    A supressão em bloco acertaria o dono do dado junto com o terceiro: a conta
    do próprio servidor leria a turma em que ela está inscrita como uma lista de
    códigos, inclusive a linha dela. Quem separa é `identificar()`, que já
    decide por linha, e não a permissão.
    """
    from app import banco as mod_banco
    from app.modelos import Usuario

    with mod_banco.sessao() as s:
        conta = s.execute(
            select(Usuario).where(Usuario.login == "secretaria_csso")
        ).scalar_one()
        conta.servidor_id = servidor
        s.commit()

    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get(
        f"/turmas/{turma_com_inscritos['turma']}?aba=inscricoes"
    ).text
    assert NOME in corpo, "o titular não leu o próprio nome na turma dele"
    assert NOME_EXTERNO not in corpo, "ler o próprio não é ler o do vizinho"


def test_rn19_a_folha_de_presenca_impressa_continua_nominal(banco, turma_com_inscritos):
    """O limite da correção da tela: o PAPEL não muda.

    A folha de presença é o documento que circula em campo para assinar — ela
    nomeia quem assina, por definição, e uma folha de `SRV-…` não serve para
    nada. Este teste é o que impede a próxima correção de privacidade de
    "consertar" o documento junto com a tela, como
    `test_rn19_o_documento_emitido_continua_nominal` faz pelo parecer.

    O que separa o papel da tela não é confiança: é `turma.avaliar`, que a rota
    do .docx exige (`rotas/turmas.py:1052`) e o serviço exige de novo — e que
    nenhum perfil de fora do setor tem.
    """
    from app import banco as mod_banco
    from app.modelos import Turma
    from app.servicos import lista_presenca
    from app.servicos.rbac import PermissaoNegada, UsuarioAtual

    with mod_banco.sessao() as s:
        turma = s.get(Turma, turma_com_inscritos["turma"])
        contexto = lista_presenca.montar_contexto(s, turma)
        nomes = [p["nome"] for p in contexto["participantes"]]
        assert NOME in nomes
        assert NOME_EXTERNO in nomes
        assert turma_com_inscritos["ptc_servidor"] in [
            p["identificador"] for p in contexto["participantes"]
        ]

        de_fora = UsuarioAtual(
            id=None,
            login="servidor",
            nome="Servidor comum",
            permissoes=frozenset({"treinamento.ver", "turma.inscrever"}),
            perfis=("servidor_consulta",),
        )
        with pytest.raises(PermissaoNegada):
            lista_presenca.gerar(s, de_fora, turma)


# ---------------------------------------------------------------------
# G-5 — a busca de participante era oráculo de nome sobre o cadastro inteiro
# ---------------------------------------------------------------------
# O mesmo desenho de `/servidores`, medido pelos mesmos três testes irmãos:
# busca por nome fechada para quem não vê nome, busca por chave (SIAPE, PTC-…)
# aberta porque quem procura já a trouxe de outro lugar, e quem vê nome
# continuando a buscar por nome.
#
# A busca é medida no SERVIÇO, e não pela tela, porque é lá que o oráculo mora:
# devolver UMA linha já é a resposta, independentemente de como a tela a pinta.


def _conta(*permissoes: str, servidor_id: int | None = None):
    from app.servicos.rbac import UsuarioAtual

    return UsuarioAtual(
        id=None,
        login="quem-pergunta",
        nome="Quem pergunta",
        permissoes=frozenset(permissoes),
        perfis=("servidor_consulta",),
        servidor_id=servidor_id,
    )


@pytest.fixture()
def servidor_sem_turma(banco):
    """Alguém que NUNCA fez treinamento — a segunda lista da busca.

    É o caso que a auditoria mediu: `?busca=Lourival` devolvia nome e SIAPE de
    quem não tem nada a ver com turma nenhuma. A tela é de treinamento; o
    cadastro que ela varre é o do setor inteiro.
    """
    from app import banco as mod_banco
    from app.modelos import Servidor

    with mod_banco.sessao() as s:
        registro = Servidor(siape=SIAPE_SEM_TURMA, nome=NOME_SEM_TURMA)
        s.add(registro)
        s.commit()
        return registro.id


def test_rn19_busca_de_participante_por_nome_nao_amarra_o_nome_ao_registro(
    banco, turma_com_inscritos
):
    """O oráculo: digitar um nome e receber uma linha é a resposta "é este".

    Vale para as duas origens. O servidor cai na regra de sempre
    (`identificacao.casa_a_busca`); o terceirizado não tem cadastro de servidor
    em que a RN-19 se apoie, e quem responde por ele é `certificado.ver`.
    """
    from app import banco as mod_banco
    from app.servicos import participante as servico_participante

    de_fora = _conta("treinamento.ver", "turma.inscrever")
    with mod_banco.sessao() as s:
        for termo in ("Marco", "Schetino", "Zulmira", "zulmira@empresacontratada"):
            assert servico_participante.buscar(s, termo, de_fora) == [], termo


def test_rn19_busca_de_participante_por_chave_opaca_continua_valendo(
    banco, turma_com_inscritos
):
    """O contrapeso. Fechar a busca inteira quebraria a jornada de quem tem o
    dado e não tem o nome: o SIAPE vem do processo no SEI e o `PTC-…` vem do
    cartaz da turma e do e-mail de suporte."""
    from app import banco as mod_banco
    from app.servicos import participante as servico_participante

    de_fora = _conta("treinamento.ver", "turma.inscrever")
    with mod_banco.sessao() as s:
        assert len(servico_participante.buscar(s, SIAPE, de_fora)) == 1
        for ptc in ("ptc_servidor", "ptc_externo"):
            achados = servico_participante.buscar(
                s, turma_com_inscritos[ptc], de_fora
            )
            assert [p.identificador_publico for p in achados] == [
                turma_com_inscritos[ptc]
            ], ptc


def test_rn19_quem_ve_dados_do_participante_continua_buscando_por_nome(
    banco, turma_com_inscritos
):
    """A correção não pode mudar a tela para quem opera a inscrição.

    **A busca casa por nome exatamente onde a lista mostra o nome**, e é essa a
    regra — uma só, `participante.pode_identificar`, que o template e o filtro
    consultam. Fechar o filtro onde a exibição já escreve o nome não protegeria
    coisa alguma e faria a secretaria ler a pessoa na lista e não a encontrar na
    caixa logo abaixo; abrir o filtro onde a exibição suprime seria o oráculo.

    Todo perfil que hoje pode inscrever alguém tem `certificado.ver`; é por isso
    que ela é o discriminador, e é isto que se mede aqui.
    """
    from app import banco as mod_banco
    from app.servicos import participante as servico_participante

    operador = _conta("treinamento.ver", "turma.inscrever", "certificado.ver")
    with mod_banco.sessao() as s:
        for termo in ("Marco", "Schetino", "Zulmira", "empresacontratada"):
            assert len(servico_participante.buscar(s, termo, operador)) == 1, termo
        # e a outra metade da regra, `exposicao.ver`, continua valendo sozinha
        com_exposicao = _conta("treinamento.ver", "exposicao.ver")
        assert len(servico_participante.buscar(s, "Marco", com_exposicao)) == 1


def test_rn19_titular_acha_o_proprio_nome_na_busca_de_participante(
    banco, servidor, turma_com_inscritos
):
    """LGPD art. 18, II na busca, como em `/servidores`: quem pode ver aquele
    nome pode buscá-lo — e só aquele."""
    from app import banco as mod_banco
    from app.servicos import participante as servico_participante

    titular = _conta("treinamento.ver", servidor_id=servidor)
    with mod_banco.sessao() as s:
        assert len(servico_participante.buscar(s, "Marco", titular)) == 1
        assert servico_participante.buscar(s, "Zulmira", titular) == []


def test_rn19_busca_de_servidor_sem_turma_segue_a_regra_de_servidores(
    banco, servidor_sem_turma
):
    """A segunda lista é o CADASTRO, e aqui não há porta nenhuma além da RN-19.

    `certificado.ver` responde por "dados do participante"; quem nunca fez
    treinamento não é participante de nada, e casar o nome dele aqui faria desta
    tela o buraco por onde a regra de `/servidores` sai pelos fundos — inclusive
    em varredura, porque `%111%` casa SIAPE aos montes.
    """
    from app import banco as mod_banco
    from app.servicos import participante as servico_participante

    with mod_banco.sessao() as s:
        de_fora = _conta("treinamento.ver", "turma.inscrever", "certificado.ver")
        assert servico_participante.buscar_servidores(s, "Lourival", de_fora) == []
        # a chave continua achando, como em `/servidores`
        achados = servico_participante.buscar_servidores(s, SIAPE_SEM_TURMA, de_fora)
        assert [sv.id for sv in achados] == [servidor_sem_turma]
        # e quem vê nome continua buscando por nome
        com_exposicao = _conta("treinamento.ver", "exposicao.ver")
        assert len(
            servico_participante.buscar_servidores(s, "Lourival", com_exposicao)
        ) == 1


def test_rn19_busca_sem_usuario_e_fechada_para_nome(banco, turma_com_inscritos):
    """Sonda do lado seguro do erro.

    Chamador que não diz quem está perguntando é tratado como quem não vê nome.
    É o que impede a correção de ser desfeita em silêncio pela próxima rota que
    esquecer de passar `usuario` — e é o oposto do modo de falha que
    `EscopoNaoDeclarado` foi escrito para não deixar acontecer.
    """
    from app import banco as mod_banco
    from app.servicos import participante as servico_participante

    with mod_banco.sessao() as s:
        assert servico_participante.buscar(s, "Marco") == []
        assert servico_participante.buscar(s, "Zulmira") == []
        assert len(servico_participante.buscar(s, SIAPE)) == 1


def test_rn19_a_caixa_de_busca_da_ficha_nao_devolve_nome(
    app_cliente, contas, sem_certificado_ver, turma_com_inscritos, servidor_sem_turma
):
    """A mesma pergunta, pela tela — que é onde a auditoria a mediu.

    `?busca=Kátia` devolvia `Kátia Lousada Ferrão / 3010112`, gente que nunca
    fez treinamento nenhum. Quem responde é o serviço; esta é a prova de que a
    resposta chega inteira até o HTML, com o rótulo da caixa dizendo o que ela
    de fato procura.
    """
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get(
        f"/turmas/{turma_com_inscritos['turma']}?aba=inscricoes&busca=Lourival"
    ).text
    assert NOME_SEM_TURMA not in corpo
    assert SIAPE_SEM_TURMA not in corpo
    corpo = app_cliente.get(
        f"/turmas/{turma_com_inscritos['turma']}?aba=inscricoes&busca=Zulmira"
    ).text
    assert NOME_EXTERNO not in corpo


def test_rn19_supressao_de_celula_pequena():
    contagens = {"FAMED": 12, "IECT": 3, "ICA": 9}
    visivel = suprimir(contagens, pode_ver=False)
    assert visivel["FAMED"] == "12"
    assert visivel["IECT"] == MARCA_SUPRIMIDO
    # supressao secundaria: com uma unica celula suprimida, a diferenca a revelaria
    assert visivel["ICA"] == MARCA_SUPRIMIDO


def test_rn19_sem_supressao_para_quem_ve_exposicao():
    contagens = {"FAMED": 12, "IECT": 3}
    assert suprimir(contagens, pode_ver=True) == {"FAMED": "12", "IECT": "3"}


# =====================================================================
# RN-19 nas TRÊS distribuições em barras
# =====================================================================
# O macro `distribuicao` esteve copiado em `relatorios.html`, `epis_relatorios.html`
# e `painel.html`, e as três cópias já haviam divergido: as duas primeiras
# suprimiam a célula pequena, a do painel publicava a contagem crua — e sob
# `processo.ver`, permissão mais larga que o `indicador.ver` das outras duas.
# Cada tela, olhada sozinha, parecia certa; era a comparação entre elas que
# mostrava que não havia uma regra, havia duas.
#
# `secretaria_csso` é o ator destes testes porque é o perfil que tem
# `processo.ver` e `indicador.ver` e **não** tem `exposicao.ver` — exatamente
# quem a supressão existe para proteger de si mesmo.
TITULO_SUPRIMIDO = "célula suprimida (RN-19)"


@pytest.fixture()
def exposicao_de_risco(banco, servidor):
    """Um parecer com UMA exposição: a menor célula possível numa distribuição.

    Uma célula só é o caso extremo e é o que interessa aqui — é ela que a cópia
    do painel publicava como "1", dizendo, para quem cruzasse com a unidade do
    processo, que ali há uma pessoa e quem ela é.
    """
    from app import banco as mod_banco
    from app.modelos import (
        AgenteNocivo,
        Exposicao,
        ParecerTecnico,
        PercentualAplicavel,
        TipoAdicional,
    )

    with mod_banco.sessao() as s:
        agente = s.execute(
            select(AgenteNocivo).where(AgenteNocivo.tipo_risco_id.is_not(None))
        ).scalars().first()
        insalubridade = s.execute(
            select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
        ).scalar_one()
        percentual = s.execute(
            select(PercentualAplicavel).where(
                PercentualAplicavel.tipo_adicional_id == insalubridade.id
            )
        ).scalars().first()
        parecer = ParecerTecnico(
            numero=0,
            ano=date.today().year,
            situacao="RASCUNHO",
            servidor_id=servidor,
            tipo_adicional_id=insalubridade.id,
        )
        s.add(parecer)
        s.flush()
        s.add(
            Exposicao(
                parecer_id=parecer.id,
                agente_nocivo_id=agente.id,
                percentual_id=percentual.id,
                fundamentacao_id=agente.fundamentacao_id,
                principal=True,
            )
        )
        s.commit()
        return agente.tipo_risco.nome


def test_rn19_painel_suprime_a_distribuicao_por_risco(
    app_cliente, contas, exposicao_de_risco
):
    """O defeito: `/` entregava a contagem crua sob `processo.ver`."""
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/").text
    assert "Distribuição por tipo de risco" in corpo
    assert TITULO_SUPRIMIDO in corpo, "painel voltou a publicar contagem crua"


def test_rn19_painel_mostra_o_numero_a_quem_ve_exposicao(
    app_cliente, contas, exposicao_de_risco
):
    """A supressão é da célula pequena, não do cartão: quem pode ler continua lendo."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/").text
    assert TITULO_SUPRIMIDO not in corpo


def test_rn19_relatorios_suprime_a_distribuicao(
    app_cliente, contas, exposicao_de_risco, processo_do_servidor
):
    entrar(app_cliente, contas, "secretaria_csso")
    corpo = app_cliente.get("/relatorios").text
    assert TITULO_SUPRIMIDO in corpo


def test_rn19_indicadores_de_epi_suprimem_a_distribuicao(app_cliente, contas, banco):
    """A terceira tela do trio. Sem entrega nenhuma a distribuição fica vazia,
    então o que se cobra aqui é o aviso da regra — e que a tela continua de pé
    com o macro compartilhado, que é o que a consolidação pôs em risco."""
    entrar(app_cliente, contas, "secretaria_csso")
    resposta = app_cliente.get("/epis/relatorios")
    assert resposta.status_code == 200
    assert "exposicao.ver" in resposta.text


def test_rn19_distribuicao_tem_uma_implementacao_so():
    """Nenhuma tela declara o macro por conta própria.

    É o teste que impede a divergência de voltar: a cópia número três nasceu
    porque nada cobrava que ela não nascesse, e a diferença entre elas era
    justamente a supressão.
    """
    raiz = Path(__file__).resolve().parents[2] / "app" / "templates"
    locais = [
        arquivo.relative_to(raiz).as_posix()
        for arquivo in sorted(raiz.rglob("*.html"))
        if "{% macro distribuicao(" in arquivo.read_text(encoding="utf-8")
        and arquivo.relative_to(raiz).as_posix() != "partes/macros.html"
    ]
    assert not locais, f"macro `distribuicao` redeclarado fora de macros.html: {locais}"


def test_rn21_bloqueia_dado_de_saude_em_observacoes(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/processos/novo",
        data={
            "nup": "23086.000608/2026-84",
            "tipo_processo_id": "1",
            "observacoes": "Servidora gestante afastada do laboratório.",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    assert "termo proibido" in resposta.text


def test_rn21_formulario_nasce_restrito(banco, servidor):
    from app import banco as mod_banco
    from app.servicos import anexos
    from app.servicos.rbac import UsuarioAtual
    from app.modelos import Usuario
    from app.servicos import autenticacao

    with mod_banco.sessao() as s:
        usuario_db = Usuario(
            login="anexador",
            nome="Anexador",
            email="anexador@teste.ufvjm.edu.br",
            senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
        )
        s.add(usuario_db)
        s.flush()
        atual = UsuarioAtual(
            id=usuario_db.id,
            login="anexador",
            nome="Anexador",
            permissoes=frozenset({"anexo.enviar"}),
            perfis=("coordenador_csso",),
        )
        resultado = anexos.guardar(
            s,
            entidade="processo",
            entidade_id=1,
            nome_original="formulario.pdf",
            conteudo=b"conteudo do formulario",
            mime_type="application/pdf",
            categoria="FORMULARIO",
            usuario=atual,
        )
        assert resultado.anexo.nivel_acesso == "RESTRITO"


def test_rn12_dedup_por_sha256(banco):
    from app import banco as mod_banco
    from app.modelos import Usuario
    from app.servicos import anexos, autenticacao
    from app.servicos.rbac import UsuarioAtual

    with mod_banco.sessao() as s:
        usuario_db = Usuario(
            login="dup",
            nome="Dup",
            email="dup@teste.ufvjm.edu.br",
            senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
        )
        s.add(usuario_db)
        s.flush()
        atual = UsuarioAtual(
            id=usuario_db.id,
            login="dup",
            nome="Dup",
            permissoes=frozenset({"anexo.enviar"}),
            perfis=("coordenador_csso",),
        )
        comum = dict(
            entidade="processo",
            entidade_id=1,
            conteudo=b"o mesmo pdf",
            mime_type="application/pdf",
            categoria="PARECER_ASSINADO",
            usuario=atual,
        )
        primeiro = anexos.guardar(s, nome_original="a.pdf", **comum)
        segundo = anexos.guardar(s, nome_original="a (1).pdf", **comum)
        assert segundo.duplicado is True
        assert segundo.anexo.id == primeiro.anexo.id

        # mesmo hash em outro processo reusa o blob e conta os processos
        terceiro = anexos.guardar(
            s, nome_original="a.pdf", **{**comum, "entidade_id": 2}
        )
        assert terceiro.duplicado is False
        assert terceiro.tambem_em == 2


def test_rn12_um_unico_parecer_assinado_ativo(banco):
    from app import banco as mod_banco
    from app.modelos import Anexo, Usuario
    from app.servicos import anexos, autenticacao
    from app.servicos.rbac import UsuarioAtual

    with mod_banco.sessao() as s:
        usuario_db = Usuario(
            login="assin",
            nome="Assin",
            email="assin@teste.ufvjm.edu.br",
            senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
        )
        s.add(usuario_db)
        s.flush()
        atual = UsuarioAtual(
            id=usuario_db.id,
            login="assin",
            nome="Assin",
            permissoes=frozenset({"anexo.enviar"}),
            perfis=("coordenador_csso",),
        )
        for conteudo in (b"versao 1", b"versao 2"):
            anexos.guardar(
                s,
                entidade="parecer_tecnico",
                entidade_id=5,
                nome_original="parecer.pdf",
                conteudo=conteudo,
                mime_type="application/pdf",
                categoria="PARECER_ASSINADO",
                usuario=atual,
            )
        ativos = list(
            s.execute(
                select(Anexo).where(
                    Anexo.entidade == "parecer_tecnico",
                    Anexo.entidade_id == 5,
                    Anexo.categoria == "PARECER_ASSINADO",
                    Anexo.ativo.is_(True),
                )
            ).scalars()
        )
        assert len(ativos) == 1


def test_nenhum_campo_de_cpf_ou_saude_no_modelo():
    """Nunca adicione CPF, CID, diagnóstico, atestado ou gestação."""
    from app.modelos import Base

    # comparacao por palavra inteira: 'cidade' nao e 'cid'
    proibidos = {"cpf", "cid", "diagnostico", "atestado", "gestacao", "gravidez"}
    # 'atestado_por'/'atestado_em' registram QUEM atestou a habilitacao tecnica -
    # nao tem nada a ver com atestado medico.
    legitimos = {
        ("profissional_habilitado", "atestado_por"),
        ("profissional_habilitado", "atestado_em"),
    }
    for tabela in Base.metadata.tables.values():
        for coluna in tabela.columns:
            if (tabela.name, coluna.name) in legitimos:
                continue
            partes = set(coluna.name.lower().split("_"))
            intersecao = partes & proibidos
            assert not intersecao, f"{tabela.name}.{coluna.name}: {intersecao}"


def test_laudo_nao_tem_data_de_validade():
    """IN 15/2022, art. 10, §3º — o laudo não tem prazo de validade."""
    from app.modelos import Base

    colunas = {c.name for c in Base.metadata.tables["laudo_tecnico"].columns}
    assert "data_validade" not in colunas
    assert "validade" not in colunas
    assert "data_ultima_conferencia" in colunas


def test_motivo_de_suspensao_e_enumerado():
    """RN-21 — gestação nunca aparece; entra como AFASTAMENTO_LEGAL."""
    from app.modelos import Base

    tabela = Base.metadata.tables["adicional_vigencia"]
    restricao = next(
        c for c in tabela.constraints if getattr(c, "name", "") == "ck_motivo_susp"
    )
    texto = str(restricao.sqltext)
    assert "AFASTAMENTO_LEGAL" in texto
    assert "gest" not in texto.lower()


_ = date
