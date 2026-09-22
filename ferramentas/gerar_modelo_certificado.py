"""Gera `app/templates/certificados/certificado_padrao_v1.docx`.

Por que um gerador, e nao um .docx desenhado a mao no Word: o modelo e um
binario dentro do repositorio, e binario que ninguem sabe reproduzir vira
artefato orfao no dia em que alguem precisar mexer nele. Aqui o layout esta em
texto, versionado, e o .docx e a saida. Mesmo criterio de
`gerar_modelo_lista_presenca.py`.

**O setor PODE — e deve — substituir este arquivo.** Ele e o ponto de partida
para que a fatia 4 saia usavel no dia da entrega, nao a identidade visual da
universidade. Qualquer .docx serve, desde que todo marcador que ele use tenha
linha no dicionario de tags do modelo: a emissao recusa marcador sem mapa, senao
o certificado sairia com `{{ nome }}` impresso no papel.

    python -m ferramentas.gerar_modelo_certificado

**Os marcadores nao sao nomes de campo do sistema, de proposito.** Eles estao na
lingua de quem desenha o certificado (`nome_do_aluno`, `curso`, `carga`), e o
dicionario de tags e que diz qual campo alimenta cada um. E a divisao do SS3 do
desenho em acao: redesenhar o papel nao pede alteracao de programa.

`MAPA_SUGERIDO`, abaixo, e o de-para que casa com este layout. Quem cadastrar o
modelo em `/treinamentos/modelos` monta essas linhas uma vez.
"""

from __future__ import annotations

import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "app" / "templates" / "certificados" / "certificado_padrao_v1.docx"

# {marcador no .docx: codigo do campo em CAMPOS_CERTIFICADO}
MAPA_SUGERIDO: dict[str, str] = {
    "nome_do_aluno": "participante_nome",
    "identificador": "participante_identificador",
    "vinculo": "participante_vinculo",
    "curso": "treinamento_nome",
    "carga": "treinamento_carga_horaria",
    "norma": "treinamento_norma",
    "conteudo": "treinamento_conteudo",
    "periodo": "turma_periodo_extenso",
    "local": "turma_local",
    "promotora": "turma_unidade_promotora",
    "frequencia": "frequencia_percentual",
    "numero_certificado": "certificado_rotulo",
    "data_extenso": "certificado_data_extenso",
    "vencimento": "certificado_data_vencimento",
    "chave": "certificado_chave",
    "url_validacao": "certificado_url_validacao",
    "instrutores": "turma_instrutores",
    "assinante": "assinante_nome",
    "assinante_titulo": "assinante_titulo",
    "rubrica": "assinante_rubrica",
    "setor_nome": "setor_emissor_nome",
    "setor_sigla": "setor_emissor_sigla",
    "cidade": "cidade",
}

# Marcadores que NAO podem sair em branco no papel. `nome_do_aluno` e `curso`
# encabecam a lista pelo motivo obvio; `chave` entra porque um certificado sem
# chave nao se valida, e a validacao publica e o que substitui o carimbo.
OBRIGATORIOS: tuple[str, ...] = (
    "nome_do_aluno",
    "curso",
    "carga",
    "periodo",
    "numero_certificado",
    "data_extenso",
    "chave",
    "assinante",
)


def _p(doc, texto, *, tamanho=11, negrito=False, centro=False, espaco=6, italico=False):
    paragrafo = doc.add_paragraph()
    if centro:
        paragrafo.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragrafo.paragraph_format.space_after = Pt(espaco)
    corrida = paragrafo.add_run(texto)
    corrida.bold = negrito
    corrida.italic = italico
    corrida.font.size = Pt(tamanho)
    return paragrafo


def montar():
    doc = Document()
    secao = doc.sections[0]
    # paisagem: e a orientacao classica do certificado, e e o default de
    # `CertificadoModelo.orientacao`
    largura, altura = secao.page_width, secao.page_height
    secao.orientation = WD_ORIENT.LANDSCAPE
    secao.page_width, secao.page_height = altura, largura
    for margem in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(secao, margem, Cm(2.0))

    _p(doc, "{{ setor_nome }}", tamanho=11, centro=True, espaco=0)
    _p(doc, "{{ setor_sigla }}", tamanho=9, centro=True, espaco=16)
    _p(doc, "CERTIFICADO", tamanho=26, negrito=True, centro=True, espaco=16)

    _p(
        doc,
        "Certificamos que {{ nome_do_aluno }} ({{ vinculo }}), participante "
        "identificado sob {{ identificador }}, concluiu o treinamento "
        "{{ curso }} {{ norma }}, com carga horária de {{ carga }}, realizado "
        "{{ periodo }} em {{ local }}, promovido por {{ promotora }}, com "
        "frequência de {{ frequencia }}.",
        tamanho=13,
        centro=True,
        espaco=14,
    )

    _p(doc, "Conteúdo programático", tamanho=10, negrito=True, espaco=2)
    _p(doc, "{{r conteudo }}", tamanho=9, espaco=14)

    _p(doc, "{{ cidade }}, {{ data_extenso }}.", tamanho=11, centro=True, espaco=20)

    # a assinatura em tabela de uma linha: a rubrica fica acima do nome, e a
    # celula mantem as duas juntas quando o paragrafo quebra
    assinatura = doc.add_table(rows=3, cols=1)
    assinatura.autofit = True
    for linha, (texto, tamanho, negrito) in zip(
        assinatura.rows,
        [("{{ rubrica }}", 10, False), ("{{ assinante }}", 11, True),
         ("{{ assinante_titulo }}", 9, False)],
        strict=True,
    ):
        paragrafo = linha.cells[0].paragraphs[0]
        paragrafo.alignment = WD_ALIGN_PARAGRAPH.CENTER
        corrida = paragrafo.add_run(texto)
        corrida.bold = negrito
        corrida.font.size = Pt(tamanho)

    _p(doc, "Instrutor(es): {{r instrutores }}", tamanho=9, centro=True, espaco=16)

    _p(
        doc,
        "Certificado nº {{ numero_certificado }} · válido até {{ vencimento }}",
        tamanho=9,
        centro=True,
        espaco=2,
    )
    _p(
        doc,
        "Confira a autenticidade em {{ url_validacao }} com a chave "
        "{{ chave }}",
        tamanho=8,
        centro=True,
        italico=True,
        espaco=0,
    )
    return doc


def main() -> int:
    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    montar().save(str(DESTINO))
    print(f"modelo gravado em {DESTINO}")
    print(f"{len(MAPA_SUGERIDO)} marcadores; obrigatorios: {', '.join(OBRIGATORIOS)}")
    return 0


if __name__ == "__main__":  # pragma: no cover - utilitario de linha de comando
    sys.exit(main())
