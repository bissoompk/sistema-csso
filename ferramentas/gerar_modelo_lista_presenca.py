"""Gera `app/templates/lista_presenca_v1.docx`, o modelo da folha de presenca.

Por que um gerador, e nao um .docx desenhado a mao no Word: o modelo e um
binario dentro do repositorio, e binario que ninguem sabe reproduzir vira
artefato orfao no dia em que alguem precisar mexer nele. Aqui o layout esta em
texto, versionado, e o .docx e a saida.

O setor PODE substituir este arquivo por um desenhado no Word — e a mesma
liberdade que o modelo do parecer tem. O contrato e a lista de marcadores
abaixo; qualquer .docx que os use serve.

    python -m ferramentas.gerar_modelo_lista_presenca

Marcadores esperados pelo `app/servicos/lista_presenca.py`:

    {{ setor_sigla }} {{ setor_nome }} {{ cidade }}
    {{ turma_codigo }} {{ treinamento }} {{ periodo }} {{ carga_horaria }}
    {{ local }} {{ campus }} {{ unidade_promotora }} {{ instrutores }}
    {{ frequencia_minima }} {{ nota_minima }} {{ total }} {{ gerada_em }}
    {%tr for p in participantes %} ... {{ p.ordem }} {{ p.nome }}
    {{ p.identificador }} {{ p.vinculo }} ... {%tr endfor %}
"""

from __future__ import annotations

import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "app" / "templates" / "lista_presenca_v1.docx"

# largura de cada coluna da grade, em centimetros. A de assinatura e a maior de
# proposito: e nela que a pessoa escreve, e coluna estreita produz rubrica
# ilegivel — que e o unico conteudo desta folha que nao da para refazer depois.
COLUNAS: tuple[tuple[str, float], ...] = (
    ("Nº", 1.0),
    ("Participante", 6.5),
    ("Identificador", 3.0),
    ("Vínculo", 2.5),
    ("Assinatura", 6.0),
)

FICHA: tuple[tuple[str, str], ...] = (
    ("Treinamento", "{{ treinamento }}"),
    ("Turma", "{{ turma_codigo }}"),
    ("Período", "{{ periodo }}"),
    ("Carga horária", "{{ carga_horaria }}"),
    ("Local", "{{ local }}"),
    ("Campus", "{{ campus }}"),
    ("Unidade promotora", "{{ unidade_promotora }}"),
    ("Instrutor(es)", "{{r instrutores }}"),
    ("Frequência mínima", "{{ frequencia_minima }}"),
    ("Nota mínima", "{{ nota_minima }}"),
)


def _paragrafo(doc, texto: str, *, tamanho=11, negrito=False, centro=False, espaco=6):
    p = doc.add_paragraph()
    if centro:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(espaco)
    corrida = p.add_run(texto)
    corrida.bold = negrito
    corrida.font.size = Pt(tamanho)
    return p


def montar():
    doc = Document()
    secao = doc.sections[0]
    # paisagem: a coluna de assinatura precisa de espaco, e retrato espremeria
    # nome e rubrica na mesma largura
    largura, altura = secao.page_width, secao.page_height
    secao.orientation = WD_ORIENT.LANDSCAPE
    secao.page_width, secao.page_height = altura, largura
    for margem in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(secao, margem, Cm(1.5))

    _paragrafo(doc, "{{ setor_nome }}", tamanho=10, centro=True, espaco=0)
    _paragrafo(doc, "{{ setor_sigla }} · {{ cidade }}", tamanho=9, centro=True)
    _paragrafo(doc, "LISTA DE PRESENÇA", tamanho=14, negrito=True, centro=True, espaco=10)

    ficha = doc.add_table(rows=len(FICHA), cols=2)
    ficha.style = "Table Grid"
    for linha, (rotulo, marcador) in zip(ficha.rows, FICHA, strict=True):
        linha.cells[0].width = Cm(4.5)
        linha.cells[1].width = Cm(14.5)
        rotulo_run = linha.cells[0].paragraphs[0].add_run(rotulo)
        rotulo_run.bold = True
        rotulo_run.font.size = Pt(9)
        valor_run = linha.cells[1].paragraphs[0].add_run(marcador)
        valor_run.font.size = Pt(9)

    _paragrafo(doc, "", tamanho=6, espaco=0)

    # As linhas nascem na ordem final: cabecalho, {%tr for %}, conteudo,
    # {%tr endfor %}. Criar as tres de uma vez e reordenar depois mexeria no XML
    # a mao, e XML remendado e a forma mais barata de produzir um .docx que so o
    # Word recusa a abrir.
    grade = doc.add_table(rows=2, cols=len(COLUNAS))
    grade.style = "Table Grid"
    for celula, (titulo, larg) in zip(grade.rows[0].cells, COLUNAS, strict=True):
        celula.width = Cm(larg)
        corrida = celula.paragraphs[0].add_run(titulo)
        corrida.bold = True
        corrida.font.size = Pt(9)

    # docxtpl: a linha marcada com {%tr ... %} some do documento, e o que fica
    # entre o `for` e o `endfor` se repete uma vez por participante
    grade.rows[1].cells[0].paragraphs[0].add_run("{%tr for p in participantes %}")
    conteudo = grade.add_row()
    for celula, (larg, marcador) in zip(
        conteudo.cells,
        [
            (COLUNAS[0][1], "{{ p.ordem }}"),
            (COLUNAS[1][1], "{{ p.nome }}"),
            (COLUNAS[2][1], "{{ p.identificador }}"),
            (COLUNAS[3][1], "{{ p.vinculo }}"),
            (COLUNAS[4][1], ""),
        ],
        strict=True,
    ):
        celula.width = Cm(larg)
        corrida = celula.paragraphs[0].add_run(marcador)
        corrida.font.size = Pt(10)
        celula.paragraphs[0].paragraph_format.space_before = Pt(6)
        celula.paragraphs[0].paragraph_format.space_after = Pt(6)
    grade.add_row().cells[0].paragraphs[0].add_run("{%tr endfor %}")

    _paragrafo(doc, "", tamanho=6, espaco=0)
    _paragrafo(
        doc,
        "{{ total }} participante(s) inscrito(s). Gerada em {{ gerada_em }}.",
        tamanho=8,
        espaco=18,
    )
    _paragrafo(doc, "_" * 45 + "        " + "_" * 45, tamanho=10, centro=True, espaco=0)
    _paragrafo(
        doc,
        "Assinatura do(s) instrutor(es)                    "
        "Responsável pela CSSO",
        tamanho=9,
        centro=True,
    )
    return doc


def main() -> int:
    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    montar().save(str(DESTINO))
    print(f"modelo gravado em {DESTINO}")
    return 0


if __name__ == "__main__":  # pragma: no cover - utilitario de linha de comando
    sys.exit(main())
