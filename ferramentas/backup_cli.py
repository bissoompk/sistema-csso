"""Backup cifrado e exportacao completa pela linha de comando.

Uso:
    python -m ferramentas.backup_cli backup
    python -m ferramentas.backup_cli exportar
    python -m ferramentas.backup_cli restaurar ARQUIVO.enc DESTINO.db
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.banco import sessao  # noqa: E402
from app.servicos import backup  # noqa: E402


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="acao", required=True)
    sub.add_parser("backup")
    sub.add_parser("exportar")
    restaurar = sub.add_parser("restaurar")
    restaurar.add_argument("arquivo", type=Path)
    restaurar.add_argument("destino", type=Path)
    args = parser.parse_args(argv)

    try:
        if args.acao == "backup":
            resultado = backup.fazer_backup()
            print(f"Backup cifrado: {resultado.arquivo} ({resultado.tamanho} bytes)")
            print(
                f"Inclui o banco e {resultado.arquivos} arquivo(s) de "
                "dados/anexos e dados/documentos."
            )
        elif args.acao == "exportar":
            with sessao() as s:
                alvo = backup.exportar_tudo(s)
            print(f"Pacote completo: {alvo}")
            print("Leia o LEIA-ME-DO-EXPORT.txt de dentro do zip antes de compartilhar.")
        else:
            alvo = backup.restaurar(args.arquivo, args.destino)
            print(f"Banco restaurado em {alvo}")
            print(
                f"Anexos e documentos em {alvo.parent} — confira ANTES de trocar "
                "dados/ pelo restaurado."
            )
    except backup.DestinoProibido as erro:
        print(f"ERRO: {erro}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
