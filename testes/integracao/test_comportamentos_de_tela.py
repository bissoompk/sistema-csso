"""Os comportamentos de tela de `csso.js` — o que a suíte alcança deles.

O arquivo é JavaScript e roda no navegador; o que se prova aqui é o CONTRATO
entre ele e o servidor, que é o que quebra sem ninguém ver:

* a casca carrega o arquivo e ele é servido (sem isso nenhum bloco existe);
* a lista de atalhos existe em toda tela com casca e em nenhuma sem;
* o formulário do parecer declara chave e versão do rascunho local, e a
  versão muda quando o servidor salva — é a trava que impede um rascunho
  velho de se sobrepor a um salvamento novo;
* o campo do NUP declara `data-nup`;
* a rota de download devolve o cookie com o token que a página mandou — e
  só com token, e só com token bem formado.

A conta do dígito verificador em JavaScript é conferida contra a de Python
lendo o próprio arquivo: os dois têm de aplicar a mesma regra (pesos 16..2 e
17..2, 11→1, 10→0). É teste de leitura, não de execução — mas é a divergência
que faria a tela dizer "não confere" para um NUP certo, e ela nasceria por
omissão.
"""

from __future__ import annotations

import re

from app.config import RAIZ
from testes.integracao.conftest import entrar

JS = RAIZ / "app" / "estaticos" / "js" / "csso.js"


# ---------------------------------------------------------------------
# A casca e o arquivo
# ---------------------------------------------------------------------
def test_a_casca_carrega_o_arquivo_e_ele_e_servido(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/kanban").text
    assert '<script src="/estaticos/js/csso.js" defer></script>' in corpo
    arquivo = app_cliente.get("/estaticos/js/csso.js")
    assert arquivo.status_code == 200
    assert "javascript" in arquivo.headers["content-type"]
    for bloco in ("1. Atalhos de teclado", "2. O rascunho local", "3. A máscara do NUP", "4. O retorno do download"):
        assert bloco in arquivo.text, bloco


def test_o_arquivo_explica_por_que_nao_ha_framework():
    """A decisão de não adotar Alpine/Vue/React por causa da CSP fica escrita
    no cabeçalho, para ninguém a desfazer sem ler."""
    texto = JS.read_text(encoding="utf-8")
    assert "'unsafe-eval'" in texto
    assert "framework" in texto


def test_a_lista_de_atalhos_existe_com_casca_e_nao_sem(app_cliente, contas):
    sem_casca = app_cliente.get("/login").text
    assert 'id="atalhos-do-teclado"' not in sem_casca
    entrar(app_cliente, contas, "coordenador_csso")
    com_casca = app_cliente.get("/kanban").text
    assert 'id="atalhos-do-teclado"' in com_casca
    for tecla in ("<kbd>/</kbd>", "<kbd>n</kbd>", "<kbd>?</kbd>", "<kbd>Esc</kbd>"):
        assert tecla in com_casca, tecla


# ---------------------------------------------------------------------
# O rascunho local do parecer
# ---------------------------------------------------------------------
def _abrir_rascunho(app_cliente, contas) -> str:
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    rascunho = app_cliente.get(f"{criado.headers['location']}/parecer", follow_redirects=False)
    return rascunho.headers["location"]


def test_o_formulario_do_parecer_declara_chave_e_versao_do_rascunho(app_cliente, contas):
    caminho = _abrir_rascunho(app_cliente, contas)
    corpo = app_cliente.get(caminho).text
    parecer_id = caminho.rsplit("/", 1)[1]
    assert f'data-rascunho-local="parecer-{parecer_id}"' in corpo
    versao = re.search(r'data-rascunho-versao="(\d+)"', corpo).group(1)

    # salvar incrementa a versão: é o que invalida o rascunho guardado antes
    app_cliente.post(caminho, data={"ano": "2026"}, follow_redirects=False)
    depois = app_cliente.get(caminho).text
    nova = re.search(r'data-rascunho-versao="(\d+)"', depois).group(1)
    assert int(nova) == int(versao) + 1


# ---------------------------------------------------------------------
# A máscara do NUP
# ---------------------------------------------------------------------
def test_o_campo_do_nup_declara_a_mascara(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    corpo = app_cliente.get("/processos/novo").text
    assert re.search(r'<input id="nup" name="nup"[^>]*\bdata-nup\b', corpo)


def test_a_conta_do_dv_em_javascript_e_a_mesma_de_python():
    texto = JS.read_text(encoding="utf-8")
    # os pesos iniciais das duas passadas, e as duas excecoes do modulo 11
    assert "digitoNup(base15, 16)" in texto
    assert "digitoNup(base15 + String(dv1), 17)" in texto
    assert "if (dv === 11) return 1;" in texto
    assert "if (dv === 10) return 0;" in texto
    # e a conta nunca bloqueia o envio: nao ha preventDefault no submit do NUP
    bloco = texto[texto.index("3. A máscara do NUP") : texto.index("4. O retorno do download")]
    assert "preventDefault" not in bloco


# ---------------------------------------------------------------------
# O retorno do download
# ---------------------------------------------------------------------
def test_download_devolve_o_cookie_com_o_token_da_pagina(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/relatorios/exportar-processos?baixar=abc123XYZ")
    assert resposta.status_code == 200
    assert resposta.cookies.get("csso_baixou") == "abc123XYZ"
    marca = resposta.headers["set-cookie"]
    assert "HttpOnly" not in marca, "a página precisa LER o cookie"
    assert "Max-Age=60" in marca


def test_download_sem_token_nao_grava_cookie_nenhum(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.get("/relatorios/exportar-processos")
    assert resposta.status_code == 200
    assert "csso_baixou" not in resposta.headers.get("set-cookie", "")


def test_download_com_token_malformado_nao_grava(app_cliente, contas):
    """O token chega pela URL, e URL e entrada: so letra e numero, ate 64."""
    entrar(app_cliente, contas, "coordenador_csso")
    for ruim in ("a b", "x=y", "<script>", "a" * 65):
        resposta = app_cliente.get("/relatorios/exportar-processos", params={"baixar": ruim})
        assert "csso_baixou" not in resposta.headers.get("set-cookie", ""), ruim


def test_os_links_de_arquivo_carregam_o_rotulo_de_espera(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    assert 'data-baixar="Exportando…"' in app_cliente.get("/processos").text
    assert 'data-baixar="Exportando…"' in app_cliente.get("/relatorios").text


# ---------------------------------------------------------------------
# O papel: onde assinar, e o botão que diz que imprimir é um caminho
# ---------------------------------------------------------------------
def test_a_guia_de_entrega_tem_onde_assinar_so_no_papel():
    from app.config import RAIZ as _RAIZ

    guia = (_RAIZ / "app" / "templates" / "paginas" / "epis_requisicao_guia.html").read_text(encoding="utf-8")
    assert 'class="so-papel assinaturas-guia"' in guia
    for rotulo in ("Separou", "Conferiu", "Data"):
        assert f"<dt>{rotulo}</dt>" in guia, rotulo
    folha = (_RAIZ / "app" / "estaticos" / "css" / "csso.css").read_text(encoding="utf-8")
    assert ".so-papel { display: none; }" in folha
    impressao = folha[folha.index("@media print {") :]
    assert ".so-papel { display: block; }" in impressao


def test_as_fichas_que_vao_para_o_papel_tem_o_botao_de_imprimir(app_cliente, contas):
    """A guia era a única tela com botão de imprimir. O comprovante, o
    certificado e a ficha do servidor também vão para o papel, e ali a pessoa
    tinha de saber que Ctrl+P produz um resultado bom."""
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/servidores", data={"siape": "1110654", "nome": "Marco"}, follow_redirects=False
    )
    ficha = app_cliente.get(criado.headers["location"]).text
    assert '<button type="button" class="secundario" data-imprimir>Imprimir</button>' in ficha


# ---------------------------------------------------------------------
# O 422 do FastAPI vira tela, e a mensagem de redirecionamento viaja inteira
# ---------------------------------------------------------------------
def test_formulario_incompleto_vira_tela_com_casca_e_saida(app_cliente, contas):
    """`Form(...)` obrigatório que não veio despejava a validação em JSON na
    cara de quem usa a tela. São 115 `Form(...)`; a rede é uma só."""
    entrar(app_cliente, contas, "coordenador_csso")
    tela = app_cliente.post(
        "/pareceres/1/portaria",
        data={"texto_original": "PORTARIA X"},  # sem unidade_emissora_id
        headers={"accept": "text/html,application/xhtml+xml"},
    )
    assert tela.status_code == 422
    assert "formulário incompleto" in tela.text
    assert "unidade_emissora_id" in tela.text
    assert "nada foi gravado" in tela.text
    assert 'class="lateral"' in tela.text, "a tela de erro sai com a casca"


def test_quem_nao_pede_html_continua_recebendo_o_json_do_422(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post("/pareceres/1/portaria", data={"texto_original": "PORTARIA X"})
    assert resposta.status_code == 422
    assert "detail" in resposta.json()


def test_mensagem_de_epi_com_e_comercial_chega_inteira():
    """`f"{destino}?mensagem={mensagem}"` cortava o recado no primeiro `&` —
    e nome de fornecedor, lote e motivo digitado entram na mensagem."""
    from app.rotas import epi_estoque, epi_fichas

    local = epi_fichas._volta("/epis/fichas/1", "Lote A&B registrado (#3)").headers["location"]
    assert local == "/epis/fichas/1?mensagem=Lote%20A%26B%20registrado%20%28%233%29"
    local = epi_estoque._erro("Fornecedor P&G não cadastrado").headers["location"]
    assert "P%26G" in local and local.startswith("/epis/estoque?erro=")
    # destino que já tem query ganha `&`, não um segundo `?`
    local = epi_fichas._erro("/epis/fichas?aba=x", "ops").headers["location"]
    assert local == "/epis/fichas?aba=x&erro=ops"
