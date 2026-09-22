"""Gera a fixture de ouro do CA-01 a partir do PDF do parecer ASSINADO.

A fixture NAO e gerada a partir do nosso proprio render - isso seria circular.
Ela e extraida do PDF assinado e apenas reordenada para a ordem de extracao do
.docx (corpo -> cabecalho -> rodape), aplicando a mesma normalizacao do CA-01.

Uso:
    python -m ferramentas.gerar_ouro_do_pdf entrada/Parecer_...pdf testes/fixtures/ouro_parecer_1_2025.txt
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.servicos.textos import normalizar_para_ouro  # noqa: E402

PREFIXO_RODAPE = "LT Nº"
INICIO_CABECALHO = "MINISTÉRIO DA EDUCAÇÃO"


def texto_do_pdf(caminho: Path) -> str:
    try:
        import fitz  # PyMuPDF
    except ImportError as erro:  # pragma: no cover
        raise SystemExit("instale pymupdf (extra dev) para gerar a fixture") from erro
    doc = fitz.open(str(caminho))
    return "\n".join(pagina.get_text("text") for pagina in doc)


def reordenar(bruto: str) -> str:
    linhas = [linha.strip() for linha in bruto.splitlines()]
    linhas = [linha for linha in linhas if linha]

    try:
        i_cab = next(i for i, l in enumerate(linhas) if l.startswith(INICIO_CABECALHO))
        i_rod = next(i for i, l in enumerate(linhas) if l.startswith(PREFIXO_RODAPE))
    except StopIteration as erro:  # pragma: no cover
        raise SystemExit("nao identifiquei cabecalho/rodape no PDF") from erro

    cabecalho = linhas[i_cab : i_cab + 6]
    rodape = [linhas[i_rod]]
    corpo = linhas[i_rod + 1 :]
    return "\n".join([*corpo, *cabecalho, *rodape])


def normalizar_aspas(texto: str) -> str:
    """O 1/2025 assinado usa aspas RETAS na citacao do Anexo 14 da NR-15,
    enquanto o catalogo do sistema padroniza aspas CURVAS (SS5 do prompt).
    A divergencia esta registrada em PENDENCIAS.md - aqui as aspas retas sao
    convertidas para curvas para que a fixture reflita o catalogo."""
    saida, abrindo = [], True
    for ch in texto:
        if ch == '"':
            saida.append("“" if abrindo else "”")
            abrindo = not abrindo
        else:
            saida.append(ch)
    return "".join(saida)


def gerar(pdf: Path, destino: Path) -> str:
    conteudo = normalizar_para_ouro(normalizar_aspas(reordenar(texto_do_pdf(pdf))))
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(conteudo + "\n", encoding="utf-8")
    return conteudo


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("destino", type=Path)
    args = parser.parse_args(argv)
    conteudo = gerar(args.pdf, args.destino)
    print(f"{args.destino}: {len(conteudo.splitlines())} linhas")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
