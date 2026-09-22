"""Gera `app/templates/comprovante_epi_v1.docx`, o modelo do comprovante de EPI.

Por que um gerador, e nao um .docx desenhado a mao no Word: o modelo e um
binario dentro do repositorio, e binario que ninguem sabe reproduzir vira
artefato orfao no dia em que alguem precisar mexer nele. Aqui o layout esta em
texto, versionado, e o .docx e a saida. Mesmo caminho do modelo da lista de
presenca e do certificado.

O setor PODE substituir este arquivo por um desenhado no Word — e a mesma
liberdade que o modelo do parecer tem. O contrato e a lista de marcadores
abaixo; qualquer .docx que os use serve.

    python -m ferramentas.gerar_modelo_comprovante_epi

Uma escolha de layout que e regra de negocio disfarcada: **o CA e a validade do
CA ficam em destaque, na primeira linha do bloco do equipamento.** Pela NR-6 o
Certificado de Aprovacao e o que constitui o equipamento como EPI — um
comprovante que enterra o CA no meio da tabela deixa quem assina sem a
informacao que faz o papel valer.

E **nao ha data de impressao no rodape**, de proposito: a segunda via de um
comprovante de 2024 tem de sair com texto identico ao da primeira, e um carimbo
de "emitido em" faria cada reimpressao divergir da anterior por construcao. Quem
imprimiu e quando fica na trilha de auditoria.

Marcadores esperados por `app/servicos/comprovante_epi.py`:

    {{ titulo }} {{ registro }}
    {{ setor_sigla }} {{ setor_nome }} {{ setor_endereco }} {{ cidade }}
    {{ servidor_nome }} {{ siape }} {{ cargo }} {{ funcao }} {{ unidade }} {{ posto }}
    {{ epi_nome }} {{ categoria }} {{ identificacao }} {{r normas }}
    {{ numero_ca }} {{ validade_ca }} {{ lote }} {{ tamanho }} {{ quantidade }}
    {{ data_evento }} {{ data_extenso }} {{ previsao_troca }} {{ aquisicao }}
    {{ entregue_por }} {{ motivo }} {{r termo }}
"""

from __future__ import annotations

import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "app" / "templates" / "comprovante_epi_v1.docx"

QUEM_RECEBE: tuple[tuple[str, str], ...] = (
    ("Servidor", "{{ servidor_nome }}"),
    ("Matrícula SIAPE", "{{ siape }}"),
    ("Cargo", "{{ cargo }}"),
    ("Função", "{{ funcao }}"),
    ("Unidade / UORG", "{{ unidade }}"),
    ("Posto de trabalho", "{{ posto }}"),
)

# A ordem nao e alfabetica nem a do modelo de dados: e a da conferencia que quem
# entrega faz de fato, com o equipamento na mao. Primeiro o que se le na
# etiqueta (CA, validade, lote), depois o que se conta (tamanho, quantidade).
O_EQUIPAMENTO: tuple[tuple[str, str], ...] = (
    ("Equipamento", "{{ epi_nome }}"),
    ("Categoria (NR-6)", "{{ categoria }}"),
    ("Certificado de Aprovação", "CA {{ numero_ca }} — válido até {{ validade_ca }}"),
    ("Fabricante / modelo", "{{ identificacao }}"),
    ("Normas de referência", "{{r normas }}"),
    ("Lote", "{{ lote }}"),
    ("Tamanho", "{{ tamanho }}"),
    ("Quantidade", "{{ quantidade }}"),
    ("Data da entrega", "{{ data_evento }}"),
    ("Previsão de troca", "{{ previsao_troca }}"),
    ("Aquisição", "{{ aquisicao }}"),
    ("Observação", "{{ motivo }}"),
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


def _bloco(doc, titulo: str, linhas: tuple[tuple[str, str], ...]) -> None:
    _paragrafo(doc, titulo, tamanho=10, negrito=True, espaco=4)
    tabela = doc.add_table(rows=len(linhas), cols=2)
    tabela.style = "Table Grid"
    for linha, (rotulo, marcador) in zip(tabela.rows, linhas, strict=True):
        linha.cells[0].width = Cm(5.0)
        linha.cells[1].width = Cm(12.0)
        run_rotulo = linha.cells[0].paragraphs[0].add_run(rotulo)
        run_rotulo.bold = True
        run_rotulo.font.size = Pt(9)
        run_valor = linha.cells[1].paragraphs[0].add_run(marcador)
        run_valor.font.size = Pt(9.5)
    _paragrafo(doc, "", tamanho=6, espaco=0)


def montar():
    doc = Document()
    secao = doc.sections[0]
    for margem in ("left_margin", "right_margin"):
        setattr(secao, margem, Cm(2.0))
    for margem in ("top_margin", "bottom_margin"):
        setattr(secao, margem, Cm(1.6))

    _paragrafo(doc, "{{ setor_nome }}", tamanho=10, centro=True, espaco=0)
    _paragrafo(doc, "{{ setor_sigla }} · {{ setor_endereco }}", tamanho=8, centro=True)
    _paragrafo(doc, "{{ titulo }}", tamanho=13, negrito=True, centro=True, espaco=2)
    _paragrafo(doc, "Registro nº {{ registro }}", tamanho=9, centro=True, espaco=12)

    _bloco(doc, "1. QUEM RECEBEU", QUEM_RECEBE)
    _bloco(doc, "2. O EQUIPAMENTO", O_EQUIPAMENTO)

    _paragrafo(doc, "3. TERMO DE RESPONSABILIDADE", tamanho=10, negrito=True, espaco=4)
    termo = doc.add_table(rows=1, cols=1)
    termo.style = "Table Grid"
    corrida = termo.rows[0].cells[0].paragraphs[0].add_run("{{r termo }}")
    corrida.font.size = Pt(9)
    termo.rows[0].cells[0].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

    _paragrafo(doc, "", tamanho=8, espaco=6)
    _paragrafo(doc, "{{ cidade }}, {{ data_extenso }}.", tamanho=10, espaco=26)

    assinaturas = doc.add_table(rows=2, cols=2)
    for celula, texto in zip(
        assinaturas.rows[0].cells, ("_" * 42, "_" * 42), strict=True
    ):
        paragrafo = celula.paragraphs[0]
        paragrafo.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragrafo.add_run(texto).font.size = Pt(10)
    for celula, texto in zip(
        assinaturas.rows[1].cells,
        (
            "{{ servidor_nome }}\nSIAPE {{ siape }}\nAssinatura de quem recebeu",
            "{{ entregue_por }}\nCSSO / Sisa — UFVJM\nAssinatura de quem entregou",
        ),
        strict=True,
    ):
        paragrafo = celula.paragraphs[0]
        paragrafo.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for i, linha in enumerate(texto.split("\n")):
            if i:
                paragrafo.add_run().add_break()
            corrida = paragrafo.add_run(linha)
            corrida.font.size = Pt(8.5)

    _paragrafo(doc, "", tamanho=8, espaco=10)
    _paragrafo(
        doc,
        "Documento gerado pelo Sistema CSSO a partir dos dados congelados no ato "
        "da entrega. Depois de assinado, deve ser digitalizado e anexado à ficha "
        "de EPI do servidor — enquanto isso não acontece, a entrega consta como "
        "pendente de comprovante.",
        tamanho=7.5,
        espaco=0,
    )
    return doc


def main() -> int:
    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    montar().save(str(DESTINO))
    print(f"modelo gravado em {DESTINO}")
    return 0


if __name__ == "__main__":  # pragma: no cover - utilitario de linha de comando
    sys.exit(main())
