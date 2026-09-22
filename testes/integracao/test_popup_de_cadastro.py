"""O popup de cadastro: abre sem JavaScript, e a recusa nao apaga o digitado.

O cadastro saiu da tela da lista e virou `<dialog>` (macro `popup_cadastro`, em
`partes/macros.html`). Duas coisas podiam se perder nessa mudanca, e as duas
custam caro:

1. **A abertura sem JavaScript.** `showModal()` e script, e um `<dialog>` sem
   `open` e `display: none`. Um popup que so abrisse por script nao deixaria o
   cadastro feio para quem nao tem script — deixaria IMPOSSIVEL, o que e pior do
   que o formulario empurrando a lista, que era o defeito original. Por isso o
   botao continua sendo um link para o `id` do dialogo, e e `:target` quem o abre
   na folha.

2. **O que foi digitado, quando a gravacao e recusada.** Sete formularios
   grandes passaram na 1.27.0 a devolver o digitado na recusa. Um popup que
   fechasse no erro desfaria a correcao com juros: o formulario some da tela E
   leva junto o que a pessoa escreveu. A rota recusa RENDERIZANDO a tela de novo
   — nunca redirecionando, que nao tem como carregar um dicionario — com o
   `open` escrito no dialogo, os campos preenchidos, o erro DENTRO do popup e
   `autofocus` no campo do problema.

3. **A largura, que agora sao DUAS.** A caixa de 720px cabe tres campos por
   linha, que e a medida do cadastro de pessoa. Os formularios de compra publica
   tem linha de CINCO: em tres colunas eles nao ficam apertados, quebram em 3+2 e
   DOBRAM a altura da linha — a entrada de lote chegou a 1387px de conteudo
   contra 575px de corpo visivel. `largo=true` troca o teto por 1062. O que nao
   pode voltar e a largura escrita em `style=` na tela, que foi o que produziu a
   deriva de 120px que a auditoria de ergonomia fechou.

4. **O foco voltando ao botao quando o popup fecha.** E requisito de dialogo
   modal, e o unico dos quatro que o padrao nao cumpria. A primeira versao ouvia
   o evento `close` do <dialog>, que e onde a especificacao poe o assunto; medido
   no navegador, esse evento nao chega (ver o comentario em `base.html`), e o
   requisito existia so no codigo. Quem devolve o foco agora e o `fechar()`, nos
   dois caminhos que fecham o popup com JavaScript.

As duas primeiras varreduras aqui sao de invariante, e nao de caso: o proximo
modulo que ganhar cadastro tem de cair nelas por omissao, e nao por alguem
lembrar de escrever o teste. As da largura e a do foco tambem.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from sqlalchemy import select

from app.config import RAIZ
from testes.integracao.conftest import entrar

TEMPLATES = Path(RAIZ) / "app" / "templates"
BASE = TEMPLATES / "base.html"
FOLHA = Path(RAIZ) / "app" / "estaticos" / "css" / "csso.css"

_BOTAO = re.compile(r"ui\.botao_cadastro\(\s*'([^']+)'")
_POPUP = re.compile(r"ui\.popup_cadastro\(\s*'([^']+)'")

_JINJA_COMENTARIO = re.compile(r"\{#.*?#\}", re.S)
_CHAMADA = re.compile(r"\{%\s*call ui\.popup_cadastro\(\s*'([^']+)'")
_ABRE_LINHA = re.compile(r'<div class="linha-campos"')
_TAG_DIV = re.compile(r"</?div\b")
_ABRE_CAMPO = re.compile(r'<div class="campo\b')


def _paginas() -> list[Path]:
    return sorted((TEMPLATES / "paginas").rglob("*.html"))


def _popups(arquivo: Path) -> list[tuple[str, str, str]]:
    """(alvo, argumentos da chamada, corpo do `{% call %}`) de cada popup.

    Os comentarios do Jinja saem antes de qualquer coisa: este repositorio
    comenta muito e comenta com marcacao dentro (o exemplo de uso do macro tem
    `<div>` no meio), e um `<div` citado em prosa desequilibraria a contagem de
    profundidade tanto quanto um `<div>` de verdade.
    """
    texto = _JINJA_COMENTARIO.sub("", arquivo.read_text(encoding="utf-8"))
    achados = []
    for m in _CHAMADA.finditer(texto):
        cabeca = texto.find("%}", m.end())
        fim = texto.find("{% endcall %}", m.end())
        achados.append(
            (
                m.group(1),
                texto[m.start() : cabeca if cabeca != -1 else m.end()],
                texto[cabeca + 2 : fim if fim != -1 else len(texto)],
            )
        )
    return achados


def _maior_linha_de_campos(corpo: str) -> int:
    """Quantos campos tem a `.linha-campos` mais cheia deste popup.

    A conta e por profundidade de `<div>`, e nao por fatia entre uma
    `.linha-campos` e a seguinte: o popup costuma terminar com `.campo` soltos
    (a observacao, o e-mail), e a fatia final os somaria a ultima linha —
    /servidores, que tem tres linhas de dois, apareceria com quatro.
    """
    maior = 0
    for abre in _ABRE_LINHA.finditer(corpo):
        profundidade, fim = 0, None
        for tag in _TAG_DIV.finditer(corpo, abre.start()):
            profundidade += 1 if tag.group(0) == "<div" else -1
            if profundidade == 0:
                fim = tag.start()
                break
        trecho = corpo[abre.end() : fim if fim is not None else len(corpo)]
        maior = max(maior, len(_ABRE_CAMPO.findall(trecho)))
    return maior


# ---------------------------------------------------------------------------
# Invariantes de marcacao — valem para a tela que ainda vai ser escrita
# ---------------------------------------------------------------------------
def test_todo_botao_de_cadastro_tem_o_popup_que_ele_abre() -> None:
    """Botao que aponta para um `id` inexistente nao faz nada — e em silencio.

    Sem JavaScript o botao e um link, e link para ancora que nao existe nao
    navega, nao avisa e nao registra nada: a pessoa clica em "Cadastrar
    servidor" e a tela fica igual. Com JavaScript o clique tambem cai no vazio,
    porque nao ha `<dialog>` para promover a modal.
    """
    orfaos: list[str] = []
    for arquivo in _paginas():
        texto = arquivo.read_text(encoding="utf-8")
        botoes = set(_BOTAO.findall(texto))
        popups = set(_POPUP.findall(texto))
        relativo = arquivo.relative_to(TEMPLATES).as_posix()
        for alvo in sorted(botoes - popups):
            orfaos.append(f"{relativo}: botao para '{alvo}', que nao tem popup")
        for alvo in sorted(popups - botoes):
            orfaos.append(f"{relativo}: popup '{alvo}', que nenhum botao abre")
    assert not orfaos, "\n".join(orfaos)


def test_nenhuma_tela_escreve_o_dialogo_a_mao() -> None:
    """A deriva recomeca no primeiro `<dialog>` escrito fora do macro.

    O que o macro carrega nao e desenho: e o `aria-labelledby`, o link de fechar
    que funciona sem script, o `open` que a recusa escreve e a promocao a
    `showModal()` que `base.html` faz. Uma tela que monte o proprio dialogo
    perde as quatro coisas sem nada acusar.
    """
    a_mao = [
        f"{arquivo.relative_to(TEMPLATES).as_posix()}"
        for arquivo in _paginas()
        if "<dialog" in arquivo.read_text(encoding="utf-8")
    ]
    assert not a_mao, (
        "tela montando <dialog> por conta propria; use `ui.popup_cadastro`: "
        + ", ".join(a_mao)
    )


def test_todo_template_compila() -> None:
    """O Jinja NAO aninha comentarios, e este repositorio comenta muito.

    O macro do popup carrega quarenta linhas de argumento, e o exemplo de uso
    dentro dele quase levou junto um `{#` com o seu `#}`: o `#}` de dentro fecha
    o comentario de fora, e o resto da explicacao vira codigo. `macros.html`
    parou de compilar e TODA tela que o importa respondeu 500 — sem que nada no
    arquivo parecesse errado a olho nu.

    A varredura e do diretorio inteiro, e nao dos templates que este lote mexeu:
    o proximo comentario longo pode ser em qualquer tela, e o sintoma e sempre
    uma pagina que so quebra quando alguem a abre.
    """
    from app.web import templates

    ruins: list[str] = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        nome = arquivo.relative_to(TEMPLATES).as_posix()
        try:
            templates.env.get_template(nome)
        except Exception as falha:  # noqa: BLE001 — o que interessa e o nome
            ruins.append(f"{nome}: {type(falha).__name__}: {falha}")
    assert not ruins, "template que nao compila:\n" + "\n".join(ruins)


def test_a_varredura_acha_o_defeito_que_ela_procura() -> None:
    """Sonda: varredura que nao consegue falhar nao vale nada."""
    assert _BOTAO.findall("{{ ui.botao_cadastro('novo-x', X) }}") == ["novo-x"]
    assert _POPUP.findall("{% call ui.popup_cadastro('novo-x', X, '/x', X) %}") == [
        "novo-x"
    ]


def test_o_bloco_de_impressao_continua_sendo_o_ultimo_da_folha() -> None:
    """O porque esta escrito na propria folha, e agora ha um teste cobrando.

    `@media print` nao desliga as faixas de largura: o Chrome monta a pagina na
    medida do PAPEL (~688px numa A4 com 14mm), abaixo dos 900px da faixa
    estreita. Com o bloco no meio da folha, a regra de 900px devolveria a lateral
    que o papel acabara de desmontar. O popup entrou logo acima dos botoes, e e
    exatamente o tipo de secao nova que empurraria o bloco para cima sem
    ninguem perceber.
    """
    # sem os comentarios: eles citam `@media print` em texto corrido, e e o
    # BLOCO que precisa ser o ultimo, nao a mencao a ele
    regras = re.sub(r"/\*.*?\*/", "", FOLHA.read_text(encoding="utf-8"), flags=re.S)
    ultimo = regras.rindex("@media ")
    assert regras[ultimo:].startswith("@media print"), (
        "ha bloco @media depois do de impressao — leia o comentario acima de "
        "`@media print` em csso.css"
    )


def test_o_popup_nao_sai_no_papel() -> None:
    """A recusa devolve a tela com o popup ABERTO; imprimindo dali, ele iria
    junto — um formulario em branco por cima da lista."""
    folha = FOLHA.read_text(encoding="utf-8")
    impressao = folha[folha.index("@media print") :]
    assert "dialog.popup { display: none !important; }" in impressao


# ---------------------------------------------------------------------------
# A tela fechada: o cadastro nao ocupa mais a lista
# ---------------------------------------------------------------------------
def test_o_cadastro_nasce_fechado_e_o_botao_e_um_link(app_cliente, contas) -> None:
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/servidores").text

    dialogo = re.search(r"<dialog[^>]*id=\"novo-servidor\"[^>]*>", corpo)
    assert dialogo, "o dialogo do cadastro sumiu de /servidores"
    assert " open" not in dialogo.group(0), "a lista abre com o cadastro por cima"
    # o nome do dialogo e o titulo escrito dentro dele
    assert 'aria-labelledby="novo-servidor-titulo"' in dialogo.group(0)
    assert '<h2 id="novo-servidor-titulo">Cadastrar servidor</h2>' in corpo
    # sem JavaScript, o botao e um link para a ancora — e e `:target` quem abre
    assert 'href="#novo-servidor" data-abre-popup>Cadastrar servidor</a>' in corpo
    # o verbo do botao e o do titulo sao o mesmo: quem clicou reconhece onde chegou
    assert corpo.count("Cadastrar servidor") >= 3  # botao, titulo e botao de gravar


# ---------------------------------------------------------------------------
# A recusa: reabre, preenche, mostra o erro dentro e foca o campo do problema
# ---------------------------------------------------------------------------
@pytest.fixture()
def recusa_de_servidor(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    return app_cliente.post(
        "/servidores",
        data={
            "siape": "123",
            "nome": "Marco Antônio Alves Schetino",
            "funcao": "Chefe do laboratório",
            "email": "marco@ufvjm.edu.br",
        },
    )


def test_a_recusa_reabre_o_popup_sem_depender_de_javascript(recusa_de_servidor) -> None:
    corpo = recusa_de_servidor.text
    dialogo = re.search(r"<dialog[^>]*id=\"novo-servidor\"[^>]*>", corpo)
    assert dialogo and " open" in dialogo.group(0), (
        "a recusa voltou com o cadastro fechado: sem `open` no <dialog> quem nao "
        "tem JavaScript nao ve nem o erro nem o que digitou"
    )


def test_a_recusa_devolve_tudo_o_que_foi_digitado(recusa_de_servidor) -> None:
    """O requisito da 1.27.0, agora dentro do popup."""
    corpo = recusa_de_servidor.text
    assert 'value="123"' in corpo
    assert 'value="Marco Antônio Alves Schetino"' in corpo
    assert 'value="Chefe do laboratório"' in corpo
    assert 'value="marco@ufvjm.edu.br"' in corpo


def test_o_erro_fica_dentro_do_popup_e_nao_se_repete(recusa_de_servidor) -> None:
    """Fora do popup a mensagem vira aviso de pagina e ninguem sabe qual campo;
    escrita nos dois lugares, faz procurar dois problemas."""
    corpo = recusa_de_servidor.text
    recado = "A matrícula SIAPE tem exatamente 7 dígitos"
    assert corpo.count(recado) == 1
    dentro = corpo[corpo.index('id="novo-servidor"') :]
    assert recado in dentro[: dentro.index("</dialog>")]
    assert '<div class="aviso aviso-erro" role="alert">' in corpo


def test_o_foco_cai_no_campo_do_problema(recusa_de_servidor) -> None:
    """`autofocus` vale nos dois caminhos: sozinho o navegador foca o campo no
    carregamento, e `showModal()` respeita o mesmo atributo ao promover."""
    corpo = recusa_de_servidor.text
    campo = re.search(r"<input id=\"novo-siape\"[^>]*>", corpo)
    assert campo and "autofocus" in campo.group(0)
    assert 'class="campo codigo com-erro"' in corpo


def test_o_cadastro_bom_continua_gravando(app_cliente, contas) -> None:
    """A correcao nao pode transformar em recusa o que passava."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/servidores",
        data={"siape": "1110654", "nome": "Marco Antônio Alves Schetino"},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "Marco Antônio" in app_cliente.get(resposta.headers["location"]).text


# ---------------------------------------------------------------------------
# Tres cadastros na mesma tela: a recusa reabre UM, e o certo
# ---------------------------------------------------------------------------
def test_a_recusa_reabre_so_o_popup_de_onde_ela_veio(app_cliente, contas) -> None:
    # o superintendente e quem concede perfil e atesta habilitacao (Resolucao
    # Consu 11/2026, art. 11, IX): dois popups na mesma tela, e a recusa tem de
    # reabrir so o dela
    entrar(app_cliente, contas, "superintendente")
    corpo = app_cliente.post(
        "/habilitacoes",
        data={
            "nome": "Fulano de Tal",
            "habilitacao": "ENG_SEG_TRABALHO",
            "titulo_assinatura": "Eng. Seg. do Trabalho",
            "conselho": "CREA",
            "registro_conselho": "MG-123456",
            "externo": "1",
            "justificativa_art10_par5": "   ",
        },
    ).text

    abertos = re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo)
    assert abertos == ["atestar-habilitacao"], (
        "a recusa da habilitacao abriu o popup errado (ou mais de um): a tela "
        f"oferece tres cadastros e a FORMA e quem decide — {abertos}"
    )
    # e os onze campos voltaram
    assert 'value="Fulano de Tal"' in corpo
    assert 'value="MG-123456"' in corpo
    assert "Habilitação externa exige justificativa" in corpo


def test_conceder_perfil_grava_sem_javascript(app_cliente, contas) -> None:
    """O `action` do formulario aponta para o usuario 0 e o alvo vem no campo.

    Era um `onsubmit` que reescrevia o `action` em JavaScript: sem script a
    concessao ia para um id que nao existe e morria numa violacao de chave
    estrangeira. Dentro de um popup que se propoe a funcionar sem script isso
    deixou de ser tolerado.
    """
    from app import banco as mod_banco
    from app.modelos import Atribuicao, Perfil, Usuario

    entrar(app_cliente, contas, "superintendente")
    assert 'action="/usuarios/0/atribuicoes"' in app_cliente.get("/usuarios").text

    with mod_banco.sessao() as s:
        alvo = s.execute(select(Usuario).order_by(Usuario.id)).scalars().first().id
        perfil = s.execute(select(Perfil).order_by(Perfil.id)).scalars().first().id

    resposta = app_cliente.post(
        "/usuarios/0/atribuicoes",
        data={
            "usuario_alvo": str(alvo),
            "perfil_id": str(perfil),
            "ato_normativo": "Portaria Reitoria nº 1.553/2026",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    with mod_banco.sessao() as s:
        gravadas = list(
            s.execute(
                select(Atribuicao).where(
                    Atribuicao.ato_normativo == "Portaria Reitoria nº 1.553/2026"
                )
            ).scalars()
        )
    assert len(gravadas) == 1 and gravadas[0].usuario_id == alvo


def test_concessao_sem_ato_normativo_volta_com_o_que_foi_escolhido(
    app_cliente, contas
) -> None:
    """`required` no campo so barra o vazio; um espaco passava e a concessao
    entrava na auditoria com autorizacao em branco."""
    from app import banco as mod_banco
    from app.modelos import Usuario

    entrar(app_cliente, contas, "superintendente")
    with mod_banco.sessao() as s:
        alvo = s.execute(select(Usuario).order_by(Usuario.id)).scalars().first().id

    corpo = app_cliente.post(
        "/usuarios/0/atribuicoes",
        data={
            "usuario_alvo": str(alvo),
            "perfil_id": "1",
            "ato_normativo": "   ",
            "vigencia_inicio": "2026-03-01",
        },
    ).text
    abertos = re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo)
    assert abertos == ["conceder-perfil"]
    assert 'value="2026-03-01"' in corpo
    assert "Sem o ato normativo não há concessão" in corpo


# ---------------------------------------------------------------------------
# Catalogo: o popup e do CADASTRO; a edicao em linha continua em linha
# ---------------------------------------------------------------------------
def test_catalogo_recusa_o_cadastro_reabrindo_o_popup(app_cliente, contas) -> None:
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/catalogos/cargos",
        data={"nome": "TECNICO DE LABORATORIO AREA", "codigo_siape": "701200"},
        follow_redirects=False,
    )
    corpo = app_cliente.post(
        "/catalogos/cargos",
        data={"nome": "TECNICO DE LABORATORIO AREA", "codigo_siape": "701200"},
    ).text
    abertos = re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo)
    assert abertos == ["novo"]
    assert "já está cadastrado" in corpo
    assert 'value="TECNICO DE LABORATORIO AREA"' in corpo
    assert 'value="701200"' in corpo


def test_a_edicao_em_linha_recusada_nao_abre_popup_nenhum(app_cliente, contas) -> None:
    """A linha da tabela E o formulario dela: reabrir o cadastro em branco por
    cima de uma correcao de linha mostraria a coisa errada."""
    from app import banco as mod_banco
    from app.modelos import Cargo

    entrar(app_cliente, contas, "coordenador_csso")
    for nome in ("CARGO A", "CARGO B"):
        app_cliente.post("/catalogos/cargos", data={"nome": nome}, follow_redirects=False)
    with mod_banco.sessao() as s:
        b = s.execute(select(Cargo).where(Cargo.nome == "CARGO B")).scalar_one().id

    corpo = app_cliente.post(
        "/catalogos/cargos",
        data={"nome": "CARGO A", "cargo_id": str(b)},
        follow_redirects=True,
    ).text
    assert not re.findall(r"<dialog[^>]*\sopen>", corpo)
    assert "Já existe outro cargo chamado" in corpo


def test_a_edicao_em_linha_do_catalogo_continua_em_linha(app_cliente, contas) -> None:
    """A auditoria elogiou este padrao, e converte-lo seria pioria: ali o
    formulario aberto na linha E o registro que se veio conferir."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/catalogos/campi").text
    assert 'form="f-campus-' in corpo, "a edicao em linha dos campi sumiu"


# ---------------------------------------------------------------------------
# Assinaturas: cadastro em popup, edicao em linha intacta
# ---------------------------------------------------------------------------
def test_assinatura_recusada_volta_com_a_vigencia_digitada(app_cliente, contas) -> None:
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.post(
        "/treinamentos/assinaturas",
        data={
            "servidor_id": "",
            "externo": "",
            "nome": "",
            "titulo": "Eng. Seg. do Trabalho",
            "organizacao": "UFVJM",
            "vigencia_inicio": "2026-01-01",
        },
    ).text
    abertos = re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo)
    assert abertos == ["nova-assinatura"]
    assert "precisa estar vinculado a um servidor" in corpo
    assert 'value="Eng. Seg. do Trabalho"' in corpo
    assert 'value="2026-01-01"' in corpo
    # a edicao em linha da tabela continua ali
    assert "/treinamentos/assinaturas" in corpo


def test_laudo_recusado_volta_com_o_tipo_e_a_unidade(app_cliente, contas) -> None:
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.post(
        "/laudos",
        data={
            "numero_siape": "1/2019",
            "tipo_adicional_id": "1",
            "unidade_uorg_id": "1",
            "data_emissao": "2019-06-01",
            "coletivo": "1",
        },
    ).text
    abertos = re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo)
    assert abertos == ["novo-laudo"]
    assert 'value="1/2019"' in corpo
    assert 'value="2019-06-01"' in corpo
    assert "checked" in corpo, "a marca de laudo coletivo se perdeu na recusa"
    # a escolha de um <select> tambem volta — e quem a devolve e `ui.sel`
    assert '<option value="1" selected>' in corpo


# ---------------------------------------------------------------------------
# Gestao de EPI e Certificados: as seis telas de LISTA destes dois modulos
#
# O criterio que separa o que virou popup do que ficou: tela de LISTA ganha
# popup; FICHA de um registro, nao. Na ficha do pedido de EPI e na da turma o
# formulario embutido COMPOE aquele registro (acrescentar item, cadastrar o
# participante externo) e e usado varias vezes seguidas na mesma sessao — cada
# gravacao recarrega a tela, e um popup cobraria um clique a mais por linha
# enquanto tira da vista a lista de onde a proxima linha e lida. E o mesmo
# argumento da edicao em linha, que a auditoria elogiou.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "caminho,alvo,verbo",
    [
        ("/epis/catalogo", "novo-epi", "Cadastrar EPI"),
        ("/epis/catalogo/motivos-recusa", "novo-motivo", "Cadastrar motivo de recusa"),
        ("/turmas", "nova-turma", "Abrir turma"),
        ("/treinamentos/catalogo", "novo-treinamento", "Cadastrar treinamento"),
        ("/treinamentos/modelos", "novo-modelo", "Cadastrar modelo"),
    ],
)
def test_a_lista_do_lote_abre_sem_o_cadastro_por_cima(
    app_cliente, contas, caminho, alvo, verbo
) -> None:
    """A lista voltou a ser so a lista, e o verbo e o mesmo nos tres lugares."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(caminho).text

    dialogo = re.search(rf"<dialog[^>]*id=\"{alvo}\"[^>]*>", corpo)
    assert dialogo, f"o dialogo do cadastro sumiu de {caminho}"
    assert " open" not in dialogo.group(0), "a lista abre com o cadastro por cima"
    assert f'aria-labelledby="{alvo}-titulo"' in dialogo.group(0)
    assert f'<h2 id="{alvo}-titulo">{verbo}</h2>' in corpo
    # sem JavaScript o botao e um link para a ancora — e e `:target` quem abre
    assert f'href="#{alvo}" data-abre-popup>{verbo}</a>' in corpo
    # botao, titulo e botao de gravar dizem a mesma coisa
    assert corpo.count(verbo) >= 3


# ---------------------------------------------------------------------------
# A entrada de lote: a excecao medida
#
# E o unico cadastro do sistema que NAO virou popup, e a razao tem numero.
# Dezenove campos: mesmo na variante larga o corpo pedia 864px contra os 577
# visiveis de um 1366x768, que e a tela do setor — uma tela e meia de rolagem
# dentro da camada, que e a unica coisa de que um dialogo nao dispoe. O pedido
# que criou os popups continua atendido, porque o que ele pedia era que a LISTA
# deixasse de carregar o formulario, e a pagina dedicada faz isso igual.
#
# Os tres testes abaixo guardam as tres metades disso: a lista nao tem popup, o
# botao leva a pagina, e a pagina preserva o digitado na recusa.
# ---------------------------------------------------------------------------
def test_a_lista_do_estoque_manda_o_cadastro_para_a_pagina_dedicada(
    app_cliente, contas
) -> None:
    """Nem cadastro por cima, nem popup escondido: um link."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/epis/estoque").text

    # `<dialog class="popup"` e nao `<dialog`: a palavra aparece no comentario do
    # script compartilhado do base.html, que TODA tela carrega. Procurar a string
    # solta daria um teste que nunca passa — e que, se alguem "consertasse"
    # afrouxando-o, deixaria de guardar qualquer coisa.
    assert '<dialog class="popup"' not in corpo, "a entrada de lote voltou a ser popup"
    assert 'href="/epis/estoque/nova-entrada"' in corpo
    assert "Dar entrada em lote" in corpo
    # o catalogo era consultado so para preencher o <select> do popup; quem abre
    # esta tela vem conferir saldo, e a consulta morreu junto com o dialogo
    assert 'name="item_id"' not in corpo


def test_a_entrada_de_lote_recusada_volta_com_a_nota_fiscal_inteira(
    app_cliente, contas
) -> None:
    """O formulario mais caro de redigitar do modulo: dezenove campos.

    Pregao, empenho, nota, fornecedor, CNPJ e valor sao transcritos papel a
    papel de uma nota fiscal e de uma etiqueta que estao em cima da mesa. Uma
    validade de CA mal digitada recomecava a conferencia do zero.

    Isto foi conquistado na 1.27.0, quando o formulario era embutido, e
    sobreviveu a duas mudancas de casa — popup e depois pagina. E o teste que
    torna a travessia segura: a terceira mudanca vai passar por aqui.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/epis/estoque",
        data={
            "item_id": "",
            "quantidade_recebida": "40",
            "pregao": "90012/2025",
            "empenho": "2026NE000123",
            "fornecedor_cnpj": "12345678000199",
            "numero_ca": "41234",
        },
    )
    corpo = resposta.text

    # renderiza a pagina do formulario, e nao redireciona: redirecionamento nao
    # carrega dicionario, que e o motivo de todo este arquivo existir
    assert resposta.status_code == 200
    assert '<dialog class="popup"' not in corpo
    assert "Escolha o item do catálogo" in corpo
    for valor in ("40", "90012/2025", "2026NE000123", "12345678000199", "41234"):
        assert f'value="{valor}"' in corpo


def test_a_turma_recusada_volta_com_local_vagas_e_observacoes(
    app_cliente, contas, banco
) -> None:
    """A recusa mais comum de /turmas e de formato de data, e ela levava junto
    os doze campos que nao tinham nada de errado."""
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/treinamentos/catalogo",
        data={
            "codigo": "NR-35",
            "nome": "Trabalho em Altura — NR-35",
            "carga_horaria_horas": "8",
            "validade_meses": "24",
        },
        follow_redirects=False,
    )
    from app import banco as mod_banco
    from app.modelos import Treinamento

    with mod_banco.sessao() as s:
        alvo = s.execute(select(Treinamento)).scalars().first().id

    corpo = app_cliente.post(
        "/turmas",
        data={
            "treinamento_id": str(alvo),
            "data_inicio": "12/03/2026",
            "data_fim": "2026-03-14",
            "local": "Auditório do Campus JK",
            "vagas": "20",
            "observacoes": "trazer o cinturão tipo paraquedista",
        },
    ).text
    assert re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo) == [
        "nova-turma"
    ]
    assert "AAAA-MM-DD" in corpo
    assert 'value="Auditório do Campus JK"' in corpo
    assert 'value="20"' in corpo
    assert "trazer o cinturão tipo paraquedista" in corpo
    # a escolha do <select> tambem volta, e quem a devolve e `ui.sel`
    assert f'<option value="{alvo}" selected>' in corpo


def test_o_treinamento_recusado_volta_com_o_conteudo_programatico(
    app_cliente, contas, banco
) -> None:
    """A lista de topicos e escrita a mao: perde-la por um codigo mal escrito e
    o atrito que faz quem monta catalogo voltar para a planilha."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.post(
        "/treinamentos/catalogo",
        data={
            "codigo": "nr 35!",
            "nome": "Trabalho em Altura",
            "carga_horaria_horas": "8",
            "validade_meses": "24",
            "conteudo_programatico": "Normas e regulamentos\nAnálise de risco",
            "obrigatorio": "1",
        },
    ).text
    assert re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo) == [
        "novo-treinamento"
    ]
    assert "Código inválido" in corpo
    assert "Análise de risco" in corpo
    assert "checked" in corpo, "a marca de “exigido por norma” se perdeu na recusa"


def test_o_modelo_de_certificado_recusado_reabre_o_popup(app_cliente, contas) -> None:
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.post(
        "/treinamentos/modelos",
        data={
            "nome": "Certificado padrão CSSO",
            "arquivo": "certificado_padrao.pdf",
            "orientacao": "RETRATO",
            "observacao": "o desenhado pela comunicação",
        },
    ).text
    assert re.findall(r"<dialog[^>]*id=\"([^\"]+)\"[^>]*\sopen>", corpo) == [
        "novo-modelo"
    ]
    assert ".docx" in corpo
    assert 'value="certificado_padrao.pdf"' in corpo
    assert 'value="o desenhado pela comunicação"' in corpo
    assert '<option value="RETRATO" selected>' in corpo


# ---------------------------------------------------------------------------
# A largura: sao duas, moram no macro, e a estreita nao cabe cinco campos
# ---------------------------------------------------------------------------
def test_a_largura_do_popup_nao_e_escrita_na_tela() -> None:
    """Varredura de invariante: a deriva recomeca no primeiro `style=` largura.

    Cinco telas ja escreveram `style="max-width:860px"` a mao e uma sexta
    escreveu 980 sem nada explicando a diferenca — em /turmas o cartao de
    cadastro ficava 120px mais largo que o de /certificados/modelos ao lado, na
    mesma sessao de trabalho. A auditoria de ergonomia fechou isso, e a variante
    larga e exatamente o tipo de coisa que convida a reabrir: e um numero, e o
    numero e facil de escrever na tela.
    """
    a_mao: list[str] = []
    for arquivo in _paginas():
        nome = arquivo.relative_to(TEMPLATES).as_posix()
        if "popup-caixa" in arquivo.read_text(encoding="utf-8"):
            a_mao.append(f"{nome}: escreve a classe da caixa do popup")
        for alvo, _, corpo in _popups(arquivo):
            for estilo in re.findall(r'style="[^"]*"', corpo):
                if "width" in estilo:
                    a_mao.append(f"{nome}: popup '{alvo}' tem largura em {estilo}")
    assert not a_mao, (
        "largura de popup escrita na tela; use `largo=true` no macro: "
        + ", ".join(a_mao)
    )


def test_as_duas_larguras_da_folha_cabem_tres_e_cinco_campos() -> None:
    """Os dois numeros tem conta, e a conta e esta.

    `.linha-campos` e `repeat(auto-fit, minmax(180px, 1fr))`: cabem N campos
    quando N x 180 + (N-1) x 12 nao passa da largura util da caixa, que e o teto
    menos as duas bordas de 1px e os dois recuos de 20px do corpo.

    Nao e zelo aritmetico: 720 foi desenhado para o cadastro de pessoa, cuja
    linha mais larga tem tres, e a linha de cinco da compra publica quebra em 3+2
    e dobra de altura ali. Baixar 1062, aumentar o `minmax` ou engordar o recuo
    do corpo desfaz a variante inteira sem mexer numa linha de template — e o
    sintoma seria um popup que voltou a rolar, que ninguem liga a esta folha.
    """
    folha = FOLHA.read_text(encoding="utf-8")
    secao = folha[folha.index("/* ---------- popup de cadastro") :]
    secao = secao[: secao.index("/* ---------- KPIs")]

    # a regra generica, ancorada no comeco da linha: `.filtros .linha-campos`
    # tambem casa por dentro, e ela e a barra de recorte da lista, com outro
    # `minmax` e outro `gap` — foi o primeiro engano deste teste
    regra = re.search(r"^\.linha-campos \{[^}]*\}", folha, re.M).group(0)
    piso = int(re.search(r"minmax\((\d+)px, 1fr\)", regra).group(1))
    intervalo = int(re.search(r"gap: (\d+)px", regra).group(1))
    recuo = int(re.search(r"\.popup-corpo \{ padding: \d+px (\d+)px", secao).group(1))
    estreita = int(
        re.search(r"\.popup-caixa \{[^}]*max-width: (\d+)px", secao, re.S).group(1)
    )
    larga = int(re.search(r"\.popup-caixa\.larga \{ max-width: (\d+)px", secao).group(1))

    def cabem(teto: int) -> int:
        util = teto - 2 - 2 * recuo  # duas bordas de 1px e os dois recuos
        return (util + intervalo) // (piso + intervalo)

    assert cabem(estreita) == 3, (
        f"a caixa estreita ({estreita}px) deixou de caber exatamente tres campos "
        f"por linha: cabe {cabem(estreita)}"
    )
    assert cabem(larga) == 5, (
        f"a caixa larga ({larga}px) tem de caber cinco campos por linha, que e a "
        f"linha da nota fiscal e a da identificacao do EPI: cabe {cabem(larga)}"
    )


def test_popup_com_linha_de_cinco_campos_usa_a_variante_larga() -> None:
    """Varredura de invariante, e o limiar e CINCO por medida, nao por gosto.

    Quatro campos em tres colunas quebram 3+1: a linha ganha uma segunda fileira
    com um campo so. O popup de atestar habilitacao (/usuarios) e assim e cabe
    inteiro nos 575px de corpo visivel — medido no navegador a 1366x768, 466px de
    conteudo, sem rolagem. Cinco quebram 3+2 e DOBRAM a linha, e e onde os dois
    formularios de compra publica estouraram: 843px no catalogo de EPI e 1387px
    na entrada de lote, contra os mesmos 575px.

    O invariante e piso e nao teto: exigir a variante larga onde a linha tem
    cinco nao proibe usa-la onde tem menos — /turmas, com quatro, ganhou-a na
    medicao (722px de conteudo antes, 609px depois).
    """
    faltando: list[str] = []
    for arquivo in _paginas():
        nome = arquivo.relative_to(TEMPLATES).as_posix()
        for alvo, chamada, corpo in _popups(arquivo):
            campos = _maior_linha_de_campos(corpo)
            if campos >= 5 and "largo=true" not in chamada:
                faltando.append(f"{nome}: popup '{alvo}' tem linha de {campos} campos")
    assert not faltando, (
        "popup com linha de cinco campos sem `largo=true`; em 720px ela quebra "
        "em 3+2 e dobra de altura: " + ", ".join(faltando)
    )


def test_a_varredura_da_largura_conta_os_campos_da_linha_certa() -> None:
    """Sonda da contagem por profundidade — e do defeito que ela evita."""
    duas_linhas_e_um_campo_solto = (
        '<div class="linha-campos">'
        '<div class="campo codigo"><input></div><div class="campo"><input></div>'
        "</div>"
        '<div class="linha-campos">'
        '<div class="campo"><span><div class="dica">x</div></span></div>'
        "</div>"
        '<div class="campo"><textarea></textarea></div>'
    )
    # a linha mais cheia tem dois; o `.campo` solto do fim nao entra em nenhuma
    assert _maior_linha_de_campos(duas_linhas_e_um_campo_solto) == 2
    assert _maior_linha_de_campos('<div class="campo"><input></div>') == 0


@pytest.mark.parametrize(
    "caminho,alvo,larga",
    [
        ("/epis/catalogo", "novo-epi", True),
        ("/turmas", "nova-turma", True),
        # a tela de referencia do padrao continua estreita: a variante larga e
        # excecao medida, e nao o novo normal
        ("/servidores", "novo-servidor", False),
    ],
)
def test_a_variante_larga_sai_no_html_de_quem_a_pediu(
    app_cliente, contas, caminho, alvo, larga
) -> None:
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get(caminho).text
    dentro = corpo[corpo.index(f'id="{alvo}"') :]
    caixa = re.search(r'<form class="([^"]+)"', dentro).group(1)
    assert caixa == ("popup-caixa larga" if larga else "popup-caixa"), (
        f"{caminho}: a caixa do popup '{alvo}' saiu como '{caixa}'"
    )


# ---------------------------------------------------------------------------
# O foco voltando ao botao — o quarto requisito de dialogo modal
# ---------------------------------------------------------------------------
def test_a_devolucao_do_foco_mora_num_lugar_so() -> None:
    """Script por tela e como a proxima tela nasce sem `Esc` e sem foco.

    O bloco do popup e delegado no documento, em `base.html`, de proposito. Um
    tratador de fechamento escrito numa tela vale para aquela tela, e a seguinte
    e escrita copiando a anterior menos a parte que ninguem lembra.
    """
    base = BASE.read_text(encoding="utf-8")
    assert "function fechar(" in base
    fora: list[str] = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        if arquivo == BASE:
            continue
        # so o que esta DENTRO de <script>: `macros.html` cita `showModal()` em
        # prosa umas dez vezes, e e onde o padrao esta explicado — proibir a
        # palavra proibiria a explicacao
        texto = arquivo.read_text(encoding="utf-8")
        for script in re.findall(r"<script\b[^>]*>(.*?)</script>", texto, re.S):
            for marca in ("showModal", "data-fecha-popup", "dialog.popup"):
                if marca in script:
                    fora.append(f"{arquivo.relative_to(TEMPLATES).as_posix()}: {marca}")
    assert not fora, (
        "tratador de popup fora de base.html; o bloco e delegado no documento "
        "para que nenhuma tela precise saber que ele existe: " + ", ".join(fora)
    )


def test_os_dois_caminhos_de_fechar_devolvem_o_foco() -> None:
    """O clique no "x"/"Cancelar" e o `Esc` — e nao o evento `close`.

    Este teste e de codigo-fonte, e nao de comportamento: foco de teclado so se
    verifica em navegador, e ali foi verificado (o foco volta ao botao "Cadastrar
    servidor" pelos tres caminhos: "x", "Cancelar" e `Esc`, inclusive depois da
    gravacao recusada). O que ele cobra e a estrutura que sustenta aquilo.

    O `assert` contra `addEventListener('close'` e o mais importante dos tres, e
    e um teste de regressao com data: era assim que a devolucao do foco estava
    escrita, e no navegador o evento `close` nao chegou nem no dialogo, nem na
    captura do documento, nem em `onclose` (Chrome 148 e 151; um `toggle` de
    <details>, tarefa enfileirada do mesmo jeito, chegou no mesmo teste). Ficava
    tudo verde e o foco continuava largado no fim do documento. Voltar a pendurar
    o requisito naquele evento e o defeito que se quer barrar.
    """
    base = BASE.read_text(encoding="utf-8")
    bloco = base[base.index("function fechar(") :]
    corpo_do_fechar = bloco[: bloco.index("\n  }")]
    assert ".focus()" in corpo_do_fechar, (
        "`fechar()` deixou de devolver o foco a quem abriu o popup"
    )
    assert "if (fecha && fechar(fecha.closest('dialog.popup')))" in base, (
        "o clique no 'x'/'Cancelar' nao passa mais por `fechar()`"
    )
    assert re.search(r"'Escape'\) fechar\(", base), (
        "o `Esc` nao passa mais por `fechar()`, e e o gesto de quem esta no "
        "teclado — justamente quem perde o lugar quando o foco fica para tras"
    )
    assert "addEventListener('close'" not in base, (
        "a devolucao do foco voltou a depender do evento `close` do <dialog>; "
        "medido no navegador, esse evento nao chega — leia o comentario acima de "
        "`fechar()` em base.html"
    )


def test_o_popup_oferece_as_duas_saidas_sem_javascript(app_cliente, contas) -> None:
    """`Esc` e o clique fora sao gestos que so existem com script. Sem ele, o
    "x" e o "Cancelar" sao a unica saida — e sao links para uma ancora que nao
    existe em documento nenhum, que e o que faz o `:target` deixar de casar."""
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/servidores").text
    dialogo = corpo[corpo.index('id="novo-servidor"') :]
    dialogo = dialogo[: dialogo.index("</dialog>")]
    assert dialogo.count('href="#sem-popup" data-fecha-popup') == 2
    assert ">Cancelar</a>" in dialogo
    assert 'id="sem-popup"' not in corpo, (
        "alguem criou um elemento com o id `sem-popup`; o fechamento sem "
        "JavaScript depende de essa ancora NAO existir"
    )
