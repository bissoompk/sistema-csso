"""Importa a planilha de pareceres pela linha de comando.

Uso:
    python -m ferramentas.importar_planilha_cli entrada/CSSO_Planilha_Pareceres_2026.xlsx
    python -m ferramentas.importar_planilha_cli ...xlsx --aplicar

Sem `--aplicar` nada e gravado.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from sqlalchemy import select  # noqa: E402

from app.banco import sessao  # noqa: E402
from app.modelos import Usuario  # noqa: E402
from app.servicos import importacao_planilha as imp  # noqa: E402
from app.servicos.numeracao import recontar_sequencia  # noqa: E402
from app.servicos.rbac import carregar_usuario_atual  # noqa: E402


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arquivo", type=Path)
    parser.add_argument("--aplicar", action="store_true")
    parser.add_argument("--login", default=None)
    args = parser.parse_args(argv)

    with sessao() as s:
        consulta = select(Usuario).where(Usuario.ativo.is_(True))
        if args.login:
            consulta = consulta.where(Usuario.login == args.login)
        usuario = s.execute(consulta).scalars().first()
        if usuario is None:
            raise SystemExit("Nenhum usuário no banco. Faça o primeiro acesso antes.")
        operador = carregar_usuario_atual(s, usuario.id)

        relatorio = imp.importar(s, args.arquivo, operador, args.aplicar)
        if args.aplicar:
            recontar_sequencia(s)
        else:
            s.rollback()

    print()
    print("=" * 62)
    print("APLICADO" if args.aplicar else "SIMULAÇÃO — nada foi gravado")
    print("=" * 62)
    print(f"arquivo .................. {relatorio.arquivo}")
    print(f"linhas ................... {relatorio.total}")
    print(f"  completas .............. {relatorio.contar('COMPLETA')}")
    print(f"  parciais ............... {relatorio.contar('PARCIAL')}")
    print(f"  reservas ............... {relatorio.contar('RESERVA')}")
    print(f"rejeitadas ............... {len(relatorio.rejeitadas)}")
    print()
    print(f"{'linha':>5}  {'nº/ano':>9}  {'classe':<9} {'ação':<10} pendências / divergências")
    for linha in relatorio.linhas:
        avisos = "; ".join([*linha.pendencias, *linha.divergencias])
        print(
            f"{linha.linha:>5}  {str(linha.numero) + '/' + str(linha.ano):>9}  "
            f"{linha.classificacao:<9} {linha.acao:<10} {avisos[:70]}"
        )
    print()
    print("Confira /importar/reconciliacao antes do corte.")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
