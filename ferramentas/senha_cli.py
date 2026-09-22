"""Define a senha de um usuario local, digitada por quem roda o comando.

Existe porque o sistema nao manda e-mail: se ninguem consegue entrar, nao ha
como recuperar pela tela. A senha e lida do terminal com `getpass` — nao passa
por argumento (ficaria no historico do shell) nem aparece na tela.

Uso:
    python -m ferramentas.senha_cli Bisso
    python -m ferramentas.senha_cli Bisso --desbloquear
    python -m ferramentas.senha_cli --listar

Toda troca por aqui e registrada na auditoria como SENHA_REDEFINIDA_LOCALMENTE.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from sqlalchemy import select  # noqa: E402

from app.banco import sessao  # noqa: E402
from app.modelos import Usuario  # noqa: E402
from app.servicos import auditoria, autenticacao  # noqa: E402


def listar() -> int:
    with sessao() as s:
        contas = list(s.execute(select(Usuario).order_by(Usuario.login)).scalars())
    if not contas:
        print("Nenhuma conta. Suba o sistema e faça o primeiro acesso.")
        return 1
    print(f"{'login':<20} {'situação':<12} {'último acesso'}")
    for u in contas:
        situacao = "ativo" if u.ativo else "inativo"
        if u.bloqueado_ate:
            situacao = "bloqueado"
        print(f"{u.login:<20} {situacao:<12} {u.ultimo_login_em or 'nunca'}")
    return 0


def definir(login: str, desbloquear: bool) -> int:
    with sessao() as s:
        usuario = autenticacao.buscar_por_login(s, login)
        if usuario is None:
            print(f"Conta '{login}' não encontrada. Use --listar para ver as existentes.")
            return 1

        print(f"Definindo nova senha de '{usuario.login}'.")
        nova = getpass.getpass("nova senha: ")
        confirmacao = getpass.getpass("repita: ")
        if nova != confirmacao:
            print("As duas digitações não conferem. Nada foi alterado.")
            return 1
        problemas = autenticacao.politica_de_senha(nova)
        if problemas:
            print("Senha fraca: " + "; ".join(problemas))
            return 1

        usuario.senha_hash = autenticacao.gerar_hash(nova)
        usuario.precisa_trocar_senha = False
        if desbloquear:
            usuario.tentativas_falhas = 0
            usuario.bloqueado_ate = None
            usuario.ativo = True
        revogadas = autenticacao.revogar_do_usuario(s, usuario.id)
        auditoria.registrar(
            s,
            entidade="usuario",
            entidade_id=usuario.id,
            tipo_evento="SENHA_REDEFINIDA_LOCALMENTE",
            descricao=(
                f"Senha de '{usuario.login}' redefinida pelo terminal da máquina; "
                f"{revogadas} sessão(ões) revogada(s)."
            ),
            usuario_nome=usuario.nome,
        )
        s.commit()

    print(f"Pronto. Entre com o usuário '{usuario.login}' e a senha que você acabou de digitar.")
    return 0


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("login", nargs="?", help="login da conta")
    parser.add_argument("--desbloquear", action="store_true")
    parser.add_argument("--listar", action="store_true")
    args = parser.parse_args(argv)

    if args.listar or not args.login:
        return listar()
    return definir(args.login, args.desbloquear)


if __name__ == "__main__":
    raise SystemExit(principal())
