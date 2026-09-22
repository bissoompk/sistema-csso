"""O rotulo nomeia o campo — em todo template, e nao so nos que ja passaram.

Este e um teste de VARREDURA, e existe porque o defeito que ele guarda nasce por
omissao: um `<label>` sem `for=` nao quebra nada, nao aparece no navegador de
quem enxerga e sobrevive a qualquer revisao de tela. Foram 68 deles no sistema,
37 so no editor do parecer — a tela em que se redige um documento assinado —, e
nenhum foi escrito de ma-fe: cada um foi copiado do vizinho que ja estava assim.

E por isso que a assercao e sobre o TOTAL do diretorio e nao sobre uma lista de
arquivos conhecidos. Uma lista fecharia os 68 e deixaria a porta aberta para o
69o, na tela que ainda vai ser escrita.

A excecao unica e legitima: o rotulo que ENVOLVE o proprio controle
(`<label><input type=checkbox> principal</label>`). Ali o vinculo existe pelo
aninhamento, o `for=` seria redundante, e e a forma correta para caixa de
selecao com o texto a direita.

O espacador de linha de campos NAO e excecao: `<label>&nbsp;</label>` e um
rotulo que nao nomeia campo nenhum e que o leitor de tela anuncia entre os
rotulos de verdade. Para ele existe `.rotulo-vago` (`csso.css`), que ocupa o
mesmo espaco e nao entra na arvore de acessibilidade.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.config import RAIZ

TEMPLATES = Path(RAIZ) / "app" / "templates"

_ABERTURA = re.compile(r"<label\b[^>]*>", re.IGNORECASE)
_CONTROLE = re.compile(r"<(input|select|textarea)\b", re.IGNORECASE)


def _orfaos(texto: str) -> list[tuple[int, str]]:
    """Rotulos que nao apontam para campo nenhum, com a linha de cada um."""
    achados = []
    for abertura in _ABERTURA.finditer(texto):
        if "for=" in abertura.group(0).lower():
            continue
        fim = texto.find("</label>", abertura.end())
        corpo = texto[abertura.end() : fim if fim != -1 else len(texto)]
        if _CONTROLE.search(corpo):
            continue  # o rotulo envolve o controle: o vinculo e o aninhamento
        linha = texto[: abertura.start()].count("\n") + 1
        achados.append((linha, abertura.group(0)))
    return achados


def test_nenhum_rotulo_orfao_em_template_nenhum() -> None:
    sobrando: list[str] = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        texto = arquivo.read_text(encoding="utf-8")
        for linha, marcacao in _orfaos(texto):
            relativo = arquivo.relative_to(TEMPLATES).as_posix()
            sobrando.append(f"{relativo}:{linha} {marcacao}")
    assert not sobrando, "rotulo que nao nomeia campo nenhum:\n" + "\n".join(sobrando)


def test_a_varredura_acha_o_defeito_que_ela_procura() -> None:
    """Sonda: teste negativo que nao consegue falhar nao vale nada.

    Sem isto, um erro no regex faria a varredura acima passar por vazio, e o
    sistema voltaria aos 68 sem ninguem perceber.
    """
    assert _orfaos('<div><label>Nº</label><input name="numero"></div>')
    assert _orfaos("<label>&nbsp;</label>")
    # e os dois casos que ela tem de deixar passar
    assert not _orfaos('<label for="n">Nº</label><input id="n">')
    assert not _orfaos('<label><input type="checkbox" name="p"> principal</label>')


def test_o_espacador_de_grade_usa_a_classe_e_nao_um_rotulo_vazio() -> None:
    """`<label>&nbsp;</label>` era o espacador de quatro telas.

    A varredura acima ja o pegaria, mas so depois de alguem escreve-lo. Este
    aqui diz qual e a saida — e falha com o nome dela na mensagem.
    """
    com_nbsp: list[str] = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        texto = arquivo.read_text(encoding="utf-8")
        for achado in re.finditer(r"<label[^>]*>\s*(&nbsp;|\s)*</label>", texto):
            linha = texto[: achado.start()].count("\n") + 1
            com_nbsp.append(f"{arquivo.relative_to(TEMPLATES).as_posix()}:{linha}")
    assert not com_nbsp, (
        "espacador escrito como rotulo vazio; use "
        '`<span class="rotulo-vago" aria-hidden="true">&nbsp;</span>`:\n'
        + "\n".join(com_nbsp)
    )


# ===================================================================
# O salto para o conteudo, o alto contraste e os tres glifos
# ===================================================================
FOLHA = Path(RAIZ) / "app" / "estaticos" / "css" / "csso.css"
BASE = TEMPLATES / "base.html"


def test_o_salto_para_o_conteudo_e_o_primeiro_filho_do_body() -> None:
    """Sao ~17 tabulacoes ate o <h1> de qualquer tela com casca, e sao as
    mesmas 17 em cada pagina. "Primeiro Tab" so e verdade se o link for o
    primeiro elemento do documento."""
    corpo = BASE.read_text(encoding="utf-8")
    depois = corpo[corpo.index("<body>") + len("<body>") :]
    sem_comentario = re.sub(r"\{#.*?#\}", "", depois, flags=re.S).strip()
    assert sem_comentario.startswith('<a class="salto" href="#conteudo">'), (
        "o salto deixou de ser o primeiro elemento do <body>: a ordem do "
        "documento e a ordem do foco"
    )
    # e o destino existe, focavel: sem `tabindex=-1` o clique rola a pagina e o
    # foco continua na lateral, que e o que o salto existe para evitar
    main = re.search(r"<main class=[^>]*>", corpo).group(0)
    assert 'id="conteudo"' in main and 'tabindex="-1"' in main


def test_o_salto_some_da_tela_e_volta_no_foco() -> None:
    folha = FOLHA.read_text(encoding="utf-8")
    assert ".salto {" in folha and ".salto:focus {" in folha
    fora = folha[folha.index(".salto {") : folha.index(".salto:focus {")]
    assert "clip: rect(0 0 0 0)" in fora, "o salto tem de nascer fora da tela"


def test_ha_bloco_de_alto_contraste_e_ele_vem_antes_da_impressao() -> None:
    """O Windows 11 em alto contraste forca todo `background`, e e ele que
    desenha o ponto de 6px da pilula, o ponto de estado e o preenchimento das
    barras — o dispositivo que faz o estado nao depender so de cor."""
    regras = re.sub(r"/\*.*?\*/", "", FOLHA.read_text(encoding="utf-8"), flags=re.S)
    assert "@media (forced-colors: active)" in regras
    assert regras.index("@media (forced-colors: active)") < regras.index("@media print"), (
        "o bloco de impressao continua sendo o ultimo da folha"
    )
    bloco = regras[regras.index("@media (forced-colors: active)") : regras.index("@media print")]
    # so palavra-chave de cor de SISTEMA vale dentro do modo: cor de autor e
    # ignorada, e e por isso que o ponto sumia
    assert "CanvasText" in bloco and "Highlight" in bloco


def test_a_politica_de_texto_continua_e_os_glifos_sao_exatamente_tres() -> None:
    """A recomendacao era estreita: sino, engrenagem e caixa de marcar, e nada
    alem disso. Zero <img>, zero fonte de icone, zero CDN — o vocabulario deste
    sistema nao tem iconografia convencional, e icone inventado pede legenda."""
    com_svg = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        texto = re.sub(r"\{#.*?#\}", "", arquivo.read_text(encoding="utf-8"), flags=re.S)
        for _ in re.finditer(r"<svg\b", texto):
            com_svg.append(arquivo.relative_to(TEMPLATES).as_posix())
    # a marca do sistema mora em `partes/marca.svg`, que nao e .html e por isso
    # nao entra nesta contagem; o que se conta aqui sao os tres glifos: o sino e
    # a engrenagem em `base.html`, a caixa de marcar na ficha do processo
    assert com_svg.count("base.html") == 2, com_svg
    assert com_svg.count("paginas/processo_ficha.html") == 1, com_svg
    assert len(com_svg) == 3, f"glifo novo em SVG fora dos tres recomendados: {com_svg}"
    # e nenhuma imagem externa entrou junto
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        texto = re.sub(r"\{#.*?#\}", "", arquivo.read_text(encoding="utf-8"), flags=re.S)
        assert "<img" not in texto or "marca-brasao" in texto, arquivo.name

# ===================================================================
# A largura de campo e nomeada, nunca escrita em pixel
# ===================================================================
def test_nenhuma_largura_de_campo_escrita_a_mao_em_template_nenhum() -> None:
    """Eram 21 `style="max-width:NNpx"` com doze valores distintos em cinco
    telas — a mesma deriva que `.cartao.formulario` e as larguras de popup
    fecharam antes, so que em celula de tabela. Agora ha uma escala de tres
    larguras nomeadas pelo que o campo E (`.campo-curto/medio/longo`), e esta
    varredura e o que impede o proximo valor de entrar pela mao."""
    sobrando: list[str] = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        texto = re.sub(r"\{#.*?#\}", "", arquivo.read_text(encoding="utf-8"), flags=re.S)
        for achado in re.finditer(r'style="[^"]*max-width', texto):
            linha = texto[: achado.start()].count("\n") + 1
            sobrando.append(f"{arquivo.relative_to(TEMPLATES).as_posix()}:{linha}")
    assert not sobrando, (
        "largura de campo escrita a mao; use `.campo-curto`, `.campo-medio` ou "
        "`.campo-longo` (csso.css, secao formularios):\n" + "\n".join(sobrando)
    )


def test_a_escala_de_larguras_existe_na_folha() -> None:
    folha = FOLHA.read_text(encoding="utf-8")
    for classe in (".campo-curto {", ".campo-medio {", ".campo-longo {"):
        assert classe in folha, classe
