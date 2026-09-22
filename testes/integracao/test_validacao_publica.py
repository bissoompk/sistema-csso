"""/validar — a página pública, e as três coisas que ela nunca pode fazer.

O defeito que ela conserta é medível e antigo:
`emissao_certificado.montar_contexto_para_emitir` grava
`url_validacao = "{url_base}/validar/{chave}"` em TODO certificado, o docxtpl a
imprime no papel e no QR, e a rota não existia. Cada certificado já emitido
circula com um endereço morto — e papel não se corrige depois de entregue. O
primeiro teste deste arquivo é exatamente esse: **a URL impressa no documento
responde**.

As três negativas, que valem mais do que a funcionalidade:

1. **Não diz o nome de quem se formou** — nem inteiro, nem mascarado, nem por
   qualquer outro campo que o identifique (SIAPE, lotação, e-mail).
2. **Não distingue** chave inexistente de chave malformada de dígito errado: a
   resposta é a mesma página, palavra por palavra.
3. **Não deixa varrer**: o limite por IP corta a rajada, e ele conta a tentativa
   mesmo quando a chave é boa.
"""

from __future__ import annotations

import re

import pytest
from sqlalchemy import select

from app.modelos import Certificado
from app.servicos import validacao_certificado as servico
from app.servicos.certificado import montar_chave, normalizar_chave
from testes.integracao.conftest import entrar
from testes.integracao.test_certificados import _cenario, _usuario

# Uma chave com formato e dígito verificador corretos que não existe no banco: é
# o caso que tem de responder igual à malformada. Montada pela mesma função da
# emissão, e NÃO escrita à mão — o `CSSO-2026-K7QMX-3FTB9-H` do desenho é o
# `placeholder` do próprio formulário, e usá-lo aqui faria o teste comparar
# respostas que diferem só porque o eco casou com o exemplo da tela.
INEXISTENTE = montar_chave(2026, "3QRST4VWXY")
# mesmo sorteio, dígito verificador trocado: o terceiro caso da negativa única
DIGITO_ERRADO = INEXISTENTE[:-1] + ("2" if INEXISTENTE[-1] != "2" else "3")
MALFORMADA = "nao-e-uma-chave"


def _sessao():
    from app import banco as mod_banco

    return mod_banco.sessao()


@pytest.fixture(autouse=True)
def _sem_limite_herdado():
    """O contador vive no processo, e o processo é o mesmo para a suíte inteira.

    Sem isto o teste do limite envenenaria os que rodassem depois dele — e o
    teste do limite ficaria dependendo de nenhum outro ter consultado antes.
    """
    servico.limpar_limites()
    yield
    servico.limpar_limites()


@pytest.fixture()
def emitido(app_cliente, contas, banco):
    with _sessao() as s:
        montador = _usuario(s, login="montador")
        dados = _cenario(s, montador)
        turma_id, inscricao_id = dados["turma"].id, dados["inscricao"].id

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        f"/turmas/{turma_id}/certificados",
        data={"inscricao_id": str(inscricao_id)},
        follow_redirects=False,
    )
    with _sessao() as s:
        certificado = s.execute(select(Certificado)).scalars().one()
        dados_do_papel = {
            "id": certificado.id,
            "chave": certificado.chave_validacao,
            "url": (certificado.contexto_congelado or {}).get("url_validacao", ""),
            "nome": (certificado.contexto_congelado or {}).get("participante_nome", ""),
            "rotulo": certificado.rotulo,
        }
    app_cliente.get("/sair")
    return dados_do_papel


# =====================================================================
# O defeito que já circulou em papel
# =====================================================================
def test_o_endereco_impresso_no_certificado_responde(app_cliente, emitido):
    """O caminho vem do CONGELADO, e não de uma string escrita no teste.

    É o que faz este teste medir o defeito de verdade: se alguém mudar o formato
    da URL na emissão e esquecer a rota, este teste quebra — que é exatamente o
    que não aconteceu quando a URL foi escrita no documento sem rota nenhuma.
    """
    caminho = "/validar/" + emitido["url"].rsplit("/validar/", 1)[1]
    resposta = app_cliente.get(caminho)
    assert resposta.status_code == 200
    assert "Certificado autêntico" in resposta.text


def test_a_pagina_abre_sem_sessao(app_cliente):
    for caminho in ("/validar", f"/validar/{INEXISTENTE}"):
        resposta = app_cliente.get(caminho, follow_redirects=False)
        assert resposta.status_code == 200, caminho
        assert "/login" not in resposta.headers.get("location", "")


# =====================================================================
# O que ela nunca mostra
# =====================================================================
def test_a_pagina_nao_expoe_o_nome_nem_o_siape(app_cliente, emitido):
    corpo = app_cliente.get(f"/validar/{emitido['chave']}").text
    assert emitido["nome"] not in corpo
    for pedaco in emitido["nome"].split():
        # nem em pedaço: máscara parcial está fora por coerência com o ROPA §6
        assert pedaco not in corpo, pedaco
    assert "1110654" not in corpo  # o SIAPE do cenário
    # e não há caminho para o documento
    assert "/documento" not in corpo
    assert ".docx" not in corpo


def test_a_pagina_mostra_o_que_da_credito_ao_papel(app_cliente, emitido):
    corpo = app_cliente.get(f"/validar/{emitido['chave']}").text
    assert "Trabalho em Altura" in corpo
    assert "NR-35" in corpo
    # instrutor sai: é informação profissional de quem assina, e é o que
    # distingue um certificado conferível de um selo sem procedência
    assert "Fabrício Raimundi Andrade" in corpo
    # e o identificador público do participante, que não é o nome
    assert "PTC-" in corpo


def test_os_cabecalhos_impedem_indexacao_e_cache(app_cliente, emitido):
    resposta = app_cliente.get(f"/validar/{emitido['chave']}")
    assert resposta.headers["x-robots-tag"] == "noindex, nofollow"
    assert resposta.headers["cache-control"] == "no-store"


# =====================================================================
# A negativa é uma só
# =====================================================================
def test_chave_inexistente_e_malformada_respondem_igual(app_cliente, banco):
    """"Certificado não encontrado" versus "chave inválida" já é meia informação.

    E a metade que sobra é justamente a que orienta quem varre: ela diria que o
    formato está certo e que faltou só acertar os dez caracteres sorteados.
    """
    def _resposta(chave: str) -> str:
        corpo = app_cliente.get(f"/validar/{chave}").text
        # o campo devolve o que foi digitado — é o que ele tem de fazer para a
        # pessoa conferir a própria digitação. Esse eco é a ÚNICA diferença que
        # pode existir entre as três respostas, e este teste a neutraliza para
        # medir o resto — junto da marca de CSP, que é sorteada por resposta.
        corpo = corpo.replace(normalizar_chave(chave), "«o que foi digitado»")
        return re.sub(r'nonce="[^"]*"', 'nonce="«marca»"', corpo)

    uma = _resposta(INEXISTENTE)
    outra = _resposta(MALFORMADA)
    # o dígito verificador errado é o terceiro caso, e responde igual aos dois
    digito_errado = _resposta(DIGITO_ERRADO)
    assert uma == outra == digito_errado
    assert "Não foi possível confirmar" in uma


def test_o_certificado_anulado_responde_anulado(app_cliente, contas, emitido):
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        f"/certificados/{emitido['id']}/anular",
        data={"motivo": "nome social"},
        follow_redirects=False,
    )
    app_cliente.get("/sair")
    corpo = app_cliente.get(f"/validar/{emitido['chave']}").text
    assert "foi anulado" in corpo
    # o motivo da anulação NÃO é público: ele conta sobre a pessoa
    assert "nome social" not in corpo


# =====================================================================
# A conferência do nome — um bit, no lugar do nome
# =====================================================================
def test_conferir_o_nome_responde_confere_e_nao_confere(app_cliente, emitido):
    certo = app_cliente.post(
        f"/validar/{emitido['chave']}/conferir",
        data={"nome": "marco antonio alves de schetino"},
    )
    assert certo.status_code == 200
    assert "<strong>Confere.</strong>" in certo.text

    errado = app_cliente.post(
        f"/validar/{emitido['chave']}/conferir", data={"nome": "Fulano de Tal"}
    )
    assert "<strong>Não confere.</strong>" in errado.text
    # e nem no "não confere" o nome verdadeiro escapa
    assert emitido["nome"] not in errado.text


# =====================================================================
# Antienumeração
# =====================================================================
def test_a_rajada_bate_no_limite_por_ip(app_cliente, banco):
    """O limite conta a tentativa BEM-SUCEDIDA também.

    Contar só o erro convidaria a varrer com uma chave conhecida no meio; contar
    só o acerto não limitaria varredura nenhuma.
    """
    for _ in range(servico.LIMITE_CURTO):
        assert app_cliente.get(f"/validar/{INEXISTENTE}").status_code == 200
    excedeu = app_cliente.get(f"/validar/{INEXISTENTE}")
    assert excedeu.status_code == 429
    assert "Consultas demais deste endereço" in excedeu.text


def test_a_conferencia_de_nome_passa_pelo_mesmo_limite(app_cliente, emitido):
    """Um bit por requisição ainda é um oráculo quando as requisições são livres."""
    for _ in range(servico.LIMITE_CURTO):
        app_cliente.post(
            f"/validar/{emitido['chave']}/conferir", data={"nome": "tentativa"}
        )
    ultima = app_cliente.post(
        f"/validar/{emitido['chave']}/conferir", data={"nome": "tentativa"}
    )
    assert ultima.status_code == 429


def test_nao_ha_listagem_nem_busca_por_nome(app_cliente, emitido):
    """A página é uma consulta por chave exata, e nada mais.

    O formulário tem UM campo, ele se chama `chave`, e não existe endpoint que
    devolva mais de um certificado sem sessão.
    """
    corpo = app_cliente.get("/validar").text
    assert corpo.count("<form") == 1
    assert 'name="chave"' in corpo
    assert 'name="nome"' not in corpo
    assert 'name="q"' not in corpo
    # e a chave não casa por prefixo: metade dela não devolve nada
    assert "Não foi possível confirmar" in app_cliente.get(
        f"/validar/{emitido['chave'][:15]}"
    ).text


# =====================================================================
# O invariante: negado por padrão continua valendo
# =====================================================================
# As únicas rotas GET que respondem 200 sem sessão. Cada linha é uma decisão
# escrita, e a lista existe justamente porque `/validar` é a segunda: enquanto
# `/saude` e `/login` eram as únicas, "negado por padrão" era verdade por
# inspeção; com uma terceira ela precisa de trava.
ABERTAS_SEM_SESSAO = {
    "/saude": "teste de vida do processo — não toca no banco e não diz a versão",
    "/login": "a tela anterior à sessão; o POST dela é que autentica",
    "/quem-sou-eu": (
        "responde `{autenticado: false}` a quem não entrou, e é isso que ela "
        "existe para responder — não há dado de ninguém antes da sessão"
    ),
    "/validar": "o formulário da validação pública por chave",
    "/sw.js": (
        "o service worker da tela de bolso: o navegador o baixa ANTES de haver "
        "sessão (é assim que a casca abre sem rede), e ele é código, não dado — "
        "a lista do que ele guarda não tem /api/ e há teste disso"
    ),
    "/validar/{chave}": (
        "a resposta da validação: existe uma decisão escrita em "
        "`app/rotas/validacao.py` para ela não pedir sessão — quem valida um "
        "certificado é justamente quem não tem conta neste sistema"
    ),
}


def _caminhos_get(app) -> list[str]:
    esquema = app.openapi()["paths"]
    return sorted(caminho for caminho, verbos in esquema.items() if "get" in verbos)


def test_so_estas_rotas_abrem_sem_sessao(app_cliente, contas, banco):
    """Nenhuma rota GET fora da lista responde 200 a quem não entrou.

    A varredura é sobre o esquema INTEIRO e não sobre uma lista de caminhos
    conhecidos, pelo mesmo motivo das varreduras de template: uma lista fecharia
    as de hoje e deixaria a porta aberta para a próxima tela.

    `contas` entra aqui e não é decoração: com o banco vazio, `/login` redireciona
    para `/primeiro-acesso` e é o bootstrap que responde 200. Com contas criadas —
    que é o estado de qualquer instalação em uso — a porta aberta é `/login`, e é
    esse estado que a lista descreve.
    """
    abertas: list[str] = []
    for caminho in _caminhos_get(app_cliente.app):
        # `{param}` vira `1`: o que se mede aqui é a porta, não o conteúdo — e um
        # id inexistente responde 303/404, nunca 200 com dado de alguém.
        concreto = caminho
        while "{" in concreto:
            inicio = concreto.index("{")
            fim = concreto.index("}", inicio)
            concreto = concreto[:inicio] + "1" + concreto[fim + 1 :]
        resposta = app_cliente.get(concreto, follow_redirects=False)
        if resposta.status_code == 200:
            abertas.append(caminho)
    assert set(abertas) == set(ABERTAS_SEM_SESSAO), (
        "rota que responde sem sessão e não está declarada em "
        f"ABERTAS_SEM_SESSAO: {sorted(set(abertas) - set(ABERTAS_SEM_SESSAO))}; "
        f"declarada e que já não abre: {sorted(set(ABERTAS_SEM_SESSAO) - set(abertas))}"
    )


def test_cada_rota_aberta_tem_o_motivo_escrito():
    """Lista sem argumento é lista que cresce sozinha."""
    for caminho, motivo in ABERTAS_SEM_SESSAO.items():
        assert len(motivo) > 40, caminho
