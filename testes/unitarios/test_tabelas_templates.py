"""A linha de cabecalho de toda tabela mora num `<thead>`, e todo `<th>` diz de
que celula ele e cabecalho.

Este e um teste de VARREDURA, irmao de `test_acessibilidade_templates.py`, e
existe pela mesma razao: o defeito que ele guarda nasce por OMISSAO. Uma tabela
sem `<thead>` renderiza igual, passa em qualquer revisao de tela e nao quebra
nada — e mesmo assim tira tres coisas do sistema:

1. **O cabecalho grudado deixa de ser construivel.** Medido no `csso.css` real,
   com 62 linhas na tabela e 900px de rolagem: `th { position: sticky }` NAO
   gruda (o topo do `th` vai parar a -503px), e `thead { position: sticky }`
   gruda. Nao e preferencia de escrita: e a diferenca entre a regra funcionar e
   nao funcionar, porque em tabela quem participa da rolagem e o grupo de linhas.

2. **No papel, a tabela de duas paginas perde o cabecalho na segunda.** O
   navegador so repete linha de cabecalho que esteja dentro de `<thead>`. O alvo
   concreto e `epis_requisicao_guia.html`: sete colunas — Equipamento, Tam.,
   Pedido, Aprovado, Entregue, A entregar, Decisao — no unico documento que
   circula FORA do sistema, no balcao. Um pedido de trinta itens atravessa a
   folha, e a pagina 2 chegava com sete colunas de numeros sem nome.

3. **`scope` e o que faz o leitor de tela dizer de que coluna e a celula.** Sem
   ele a inferencia e frustra na grade de presenca (uma coluna por dia de aula) e
   no mapa de tags do certificado.

Eram **89 tabelas, zero `<thead>` e zero `scope`**. A assercao e sobre o TOTAL do
diretorio e nao sobre uma lista de arquivos conhecidos, pelo mesmo motivo do
teste de rotulo orfao: uma lista fecharia as 89 e deixaria a porta aberta para a
90a, na tela que ainda vai ser escrita.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.config import RAIZ

TEMPLATES = Path(RAIZ) / "app" / "templates"

# Comentario Jinja vira espaco em branco antes da varredura: os comentarios
# desta base explicam POR QUE as regras existem, e varios citam `<th>` e
# `<thead>` no texto. Sem isto a varredura acusaria a propria documentacao.
_COMENTARIO = re.compile(r"\{#.*?#\}", re.S)
_TABELA = re.compile(r"<table\b[^>]*>", re.I)
_ATE_O_FIM_DA_TABELA = re.compile(r"<table\b|</table\s*>", re.I)
_THEAD = re.compile(r"\s*<thead\b", re.I)
_TH = re.compile(r"<th\b([^>]*)>", re.I)

# As duas tabelas cujo `<th>` e cabecalho de LINHA, e nao de coluna: o rotulo a
# esquerda do valor. Elas NAO levam `<thead>`, e isso e decisao — num `<thead>` o
# navegador repetiria a tarja no alto da pagina 2, anunciando uma secao que
# terminou. O `scope` delas e `row`, e a varredura de `scope` abaixo continua
# valendo para as duas.
CABECALHO_DE_LINHA = {
    "paginas/config.html",       # o SLA por coluna, em `table.tabela-dados`
    "partes/previa_parecer.html",  # o fac-simile do .docx do parecer
}

# A lista `PENDENTE_EM_OUTRA_FRENTE` que existia aqui foi APAGADA, que era o
# destino escrito para ela. Ela isentava `paginas/turma_ficha.html` e
# `partes/itens_do_pedido.html` — as sete tabelas que ficaram de fora da passada
# geral porque os dois arquivos estavam sendo reescritos noutra frente ao mesmo
# tempo (a grade de presenca e a decisao item a item indo para troca parcial por
# HTMX), e marcacao reescrita por duas maos ao mesmo tempo e conflito garantido.
#
# As sete fecharam depois, e as duas varreduras abaixo passaram a valer para o
# diretorio INTEIRO, sem isencao nenhuma. Nao volte a criar a lista: o dia em que
# ela existir de novo e o dia em que a proxima tela entra por ela.


def _sem_comentario(texto: str) -> str:
    """Apaga o comentario preservando a contagem de linhas."""
    return _COMENTARIO.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), texto)


def _tabelas_sem_thead(texto: str) -> list[int]:
    """Linhas das `<table>` que tem `<th>` de coluna e nao tem `<thead>`."""
    achados = []
    for abertura in _TABELA.finditer(texto):
        resto = texto[abertura.end() :]
        fim = _ATE_O_FIM_DA_TABELA.search(resto)
        corpo = resto[: fim.start()] if fim else resto
        if "<th" not in corpo.lower():
            continue  # tabela sem cabecalho nenhum: nao ha o que embrulhar
        if not _THEAD.match(corpo):
            achados.append(texto[: abertura.start()].count("\n") + 1)
    return achados


def _th_sem_scope(texto: str) -> list[int]:
    return [
        texto[: m.start()].count("\n") + 1
        for m in _TH.finditer(texto)
        if "scope=" not in m.group(1).lower()
    ]


def test_toda_tabela_com_cabecalho_de_coluna_tem_thead() -> None:
    sobrando: list[str] = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        relativo = arquivo.relative_to(TEMPLATES).as_posix()
        if relativo in CABECALHO_DE_LINHA:
            continue
        texto = _sem_comentario(arquivo.read_text(encoding="utf-8"))
        for linha in _tabelas_sem_thead(texto):
            sobrando.append(f"{relativo}:{linha}")
    assert not sobrando, (
        "linha de cabecalho fora de <thead> — sem ele o cabecalho nao gruda ao "
        "rolar e nao se repete na pagina 2 do papel:\n" + "\n".join(sobrando)
    )


def test_todo_th_diz_de_que_e_cabecalho() -> None:
    """`scope` em TODO `<th>`, inclusive no vazio.

    O `<th>` vazio — a coluna da caixa de selecao, a da gaveta "Gerir" — tambem
    leva `scope="col"`: ele conta como coluna na grade, e um `scope` faltando no
    meio da fila e o que faz o leitor de tela perder o alinhamento das seguintes.
    """
    sobrando: list[str] = []
    for arquivo in sorted(TEMPLATES.rglob("*.html")):
        relativo = arquivo.relative_to(TEMPLATES).as_posix()
        texto = _sem_comentario(arquivo.read_text(encoding="utf-8"))
        for linha in _th_sem_scope(texto):
            sobrando.append(f"{relativo}:{linha}")
    assert not sobrando, (
        'cabecalho de tabela sem `scope` — use "col" na linha de cabecalho e '
        '"row" no rotulo a esquerda do valor:\n' + "\n".join(sobrando)
    )


def test_a_varredura_acha_o_defeito_que_ela_procura() -> None:
    """Sonda: teste negativo que nao consegue falhar nao vale nada.

    Sem isto, um erro nos regexes faria as duas varreduras acima passarem por
    vazio, e o sistema voltaria as 89 sem ninguem perceber.
    """
    assert _tabelas_sem_thead("<table><tr><th>A</th></tr></table>")
    assert _th_sem_scope("<th>A</th>")
    # e os casos que elas tem de deixar passar
    assert not _tabelas_sem_thead("<table>\n<thead><tr><th>A</th></tr></thead></table>")
    assert not _tabelas_sem_thead("<table><tr><td>so dado</td></tr></table>")
    assert not _th_sem_scope('<th scope="col">A</th>')
    assert not _th_sem_scope('<th scope="row">A</th>')
    # e o comentario, que fala de <th> sem ser um <th>
    assert not _th_sem_scope(_sem_comentario("{# o `<th>` solto nao gruda #}"))


def test_o_comentario_apagado_nao_move_as_linhas() -> None:
    """A linha reportada tem de ser a do arquivo, e nao a de um texto encolhido.

    Um `_sem_comentario` que devolvesse string vazia no lugar de um comentario de
    dez linhas faria toda mensagem apontar dez linhas acima do defeito — e uma
    varredura que aponta o lugar errado custa mais do que nao existir.
    """
    original = "linha1\n{# a\nb\nc #}\n<th>X</th>"
    assert _sem_comentario(original).count("\n") == original.count("\n")
    assert _th_sem_scope(_sem_comentario(original)) == [5]
