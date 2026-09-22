"""Fase 5 - criterio de aceite da migracao.

Reimprime pareceres migrados (com o modelo v1 e o `texto_recomendacao` literal)
e compara com os PDFs originais assinados. Divergencia nao e erro automatico:
o relatorio existe para o Fabricio decidir caso a caso.

Uso:
    python -m ferramentas.conferir_reimpressao PASTA_COM_OS_PDFS [--limite 10]

Casa o PDF com o parecer pelo padrao 'NN-AAAA' no nome do arquivo.
"""

from __future__ import annotations

import argparse
import difflib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.banco import sessao  # noqa: E402
from app.modelos import ParecerTecnico  # noqa: E402
from app.servicos import parecer as servico  # noqa: E402
from app.servicos.documento import extrair_texto, renderizar  # noqa: E402
from app.servicos.textos import normalizar_fluxo  # noqa: E402

RE_NUMERO = re.compile(r"(?<!\d)(\d{1,3})[-_ ](\d{4})(?!\d)")
PREFIXO_RODAPE = "LT Nº"
INICIO_CABECALHO = "MINISTÉRIO DA EDUCAÇÃO"


@dataclass
class Comparacao:
    pdf: Path
    numero: int
    ano: int
    igual: bool
    diferencas: list[str] = field(default_factory=list)
    erro: str | None = None


def _texto_do_pdf(caminho: Path) -> str:
    import fitz

    doc = fitz.open(str(caminho))
    return "\n".join(pagina.get_text("text") for pagina in doc)


def _reordenar(bruto: str) -> str:
    """Do PDF (cabecalho, rodape, corpo) para a ordem do .docx (corpo, cabecalho, rodape)."""
    linhas = [linha.strip() for linha in bruto.splitlines() if linha.strip()]
    i_cab = next((i for i, l in enumerate(linhas) if l.startswith(INICIO_CABECALHO)), None)
    i_rod = next((i for i, l in enumerate(linhas) if l.startswith(PREFIXO_RODAPE)), None)
    if i_cab is None or i_rod is None:
        return "\n".join(linhas)
    return "\n".join([*linhas[i_rod + 1 :], *linhas[i_cab : i_cab + 6], linhas[i_rod]])


def _aspas_curvas(texto: str) -> str:
    saida, abrindo = [], True
    for ch in texto:
        if ch == '"':
            saida.append("“" if abrindo else "”")
            abrindo = not abrindo
        else:
            saida.append(ch)
    return "".join(saida)


def _numero_do_arquivo(nome: str) -> tuple[int, int] | None:
    m = RE_NUMERO.search(nome)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def conferir(pasta: Path, limite: int, saida: Path) -> list[Comparacao]:
    resultados: list[Comparacao] = []
    pdfs = sorted(p for p in pasta.glob("*.pdf") if _numero_do_arquivo(p.name))

    with sessao() as s:
        for pdf in pdfs:
            if len(resultados) >= limite:
                break
            numero, ano = _numero_do_arquivo(pdf.name)  # type: ignore[misc]
            registro = s.execute(
                select(ParecerTecnico).where(
                    ParecerTecnico.numero == numero, ParecerTecnico.ano == ano
                )
            ).scalar_one_or_none()
            if registro is None:
                continue

            comparacao = Comparacao(pdf, numero, ano, igual=False)
            try:
                contexto = servico.montar_contexto(s, registro)
                faltantes = contexto.obrigatorios_faltantes()
                if faltantes:
                    comparacao.erro = "parecer incompleto: " + "; ".join(faltantes)
                    resultados.append(comparacao)
                    continue
                destino = saida / f"reimpresso_{numero:02d}-{ano}.docx"
                renderizar(
                    contexto, destino, registro.modelo_arquivo or "modelo_parecer_v1.docx"
                )
                gerado = normalizar_fluxo(extrair_texto(destino))
                original = normalizar_fluxo(_aspas_curvas(_reordenar(_texto_do_pdf(pdf))))
                comparacao.igual = gerado == original
                if not comparacao.igual:
                    comparacao.diferencas = [
                        linha
                        for linha in difflib.unified_diff(
                            original.split(" "), gerado.split(" "), "assinado", "reimpresso",
                            lineterm="", n=2,
                        )
                        if linha.startswith(("+", "-")) and not linha.startswith(("+++", "---"))
                    ][:40]
            except Exception as erro:  # pragma: no cover - diagnostico
                comparacao.erro = f"{type(erro).__name__}: {erro}"
            resultados.append(comparacao)
    return resultados


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pasta", type=Path)
    parser.add_argument("--limite", type=int, default=10)
    parser.add_argument("--saida", type=Path, default=Path("dados/documentos/_conferencia"))
    args = parser.parse_args(argv)
    args.saida.mkdir(parents=True, exist_ok=True)

    resultados = conferir(args.pasta, args.limite, args.saida)
    if not resultados:
        print("Nenhum PDF casou com parecer no banco. Rode a importacao antes.")
        return 1

    iguais = sum(1 for r in resultados if r.igual)
    print(f"Conferidos {len(resultados)} pareceres: {iguais} identicos.\n")
    for r in resultados:
        marca = "OK " if r.igual else "DIF"
        print(f"[{marca}] {r.numero}/{r.ano}  {r.pdf.name}")
        if r.erro:
            print(f"       {r.erro}")
        for linha in r.diferencas:
            print(f"       {linha}")
    print(
        "\nDivergencia nao e erro automatico: confira caso a caso antes do corte "
        "(de-para de posto, texto do setor emissor, aspas)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
