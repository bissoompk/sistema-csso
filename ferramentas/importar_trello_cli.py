"""Importa o quadro do Trello pela linha de comando.

Uso:
    python -m ferramentas.importar_trello_cli entrada/trello_KBZgbh38.json --simular
    python -m ferramentas.importar_trello_cli entrada/trello_KBZgbh38.json --aplicar \
        --anexos entrada/anexos_trello

Sem `--aplicar` nada e gravado: roda, mostra o relatorio e desfaz.
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
from app.servicos import importacao_trello as imp  # noqa: E402
from app.servicos.rbac import carregar_usuario_atual  # noqa: E402


def _operador(s, login: str | None):
    consulta = select(Usuario).where(Usuario.ativo.is_(True))
    if login:
        consulta = consulta.where(Usuario.login == login)
    usuario = s.execute(consulta).scalars().first()
    if usuario is None:
        raise SystemExit(
            "Nenhum usuário no banco. Suba o sistema e faça o primeiro acesso antes."
        )
    return carregar_usuario_atual(s, usuario.id)


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arquivo", type=Path)
    parser.add_argument("--aplicar", action="store_true")
    parser.add_argument("--anexos", type=Path, default=None, help="pasta com os anexos já baixados")
    parser.add_argument("--baixar-anexos", action="store_true", help="buscar anexos na rede")
    parser.add_argument("--login", default=None)
    args = parser.parse_args(argv)

    if args.anexos:
        buscar = imp.buscar_em_pasta(args.anexos)
    elif args.baixar_anexos:
        buscar = imp.baixar_url
    else:
        buscar = None

    with sessao() as s:
        operador = _operador(s, args.login)
        relatorio = imp.importar(s, args.arquivo, operador, args.aplicar, buscar_anexo=buscar)
        if not args.aplicar:
            s.rollback()

    print()
    print("=" * 62)
    print(f"{'APLICADO' if args.aplicar else 'SIMULAÇÃO — nada foi gravado'}")
    print("=" * 62)
    print(f"cartões lidos ............ {relatorio.cartoes}")
    print(f"processos ................ {relatorio.processos}")
    print(f"eventos de histórico ..... {relatorio.eventos}  (com a data original)")
    print(f"anexos guardados ......... {relatorio.anexos}")
    print(f"anexos duplicados ........ {relatorio.anexos_duplicados}")
    print(f"anexos não baixados ...... {len(relatorio.anexos_perdidos)}")
    print()
    print("BACKLOG SEPARADO")
    print(f"  trabalho pendente ...... {relatorio.backlog_pendente}  (vai para a fila)")
    print(f"  cadastro histórico ..... {relatorio.backlog_historico}  (repositório, fora dos indicadores)")
    print()
    print(f"rejeitados ............... {len(relatorio.rejeitados)}")
    if relatorio.listas_desconhecidas:
        print(f"  LISTAS NÃO MAPEADAS: {', '.join(sorted(relatorio.listas_desconhecidas))}")
    print(f"órfãos de processo ....... {len(relatorio.orfaos_processo)}")
    print(f"conflitos de numeração ... {len(relatorio.conflitos_numeracao)}")
    print(f"laudos candidatos ........ {len(relatorio.laudos_candidatos)}")

    if relatorio.motivos_pendente:
        print()
        print("por que estes ficaram na fila:")
        for item in relatorio.motivos_pendente[:30]:
            print(f"  {(item['cartao'] or '')[:42]:42} {item['motivo']}")
    if relatorio.anexos_perdidos:
        print()
        print("anexos que precisam ser buscados à mão (as URLs expiram):")
        for nome, motivo in relatorio.anexos_perdidos[:20]:
            print(f"  {nome[:50]:50} {motivo[:60]}")
    print()
    print("Confira /importar/reconciliacao antes do corte.")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
