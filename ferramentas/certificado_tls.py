"""Gera (ou renova) o certificado HTTPS do sistema, e a AC do setor na primeira vez.

Uso:
    python -m ferramentas.certificado_tls 10.0.73.198
    python -m ferramentas.certificado_tls 10.0.73.198 csso.sisa.ufvjm.edu.br
    python -m ferramentas.certificado_tls 10.0.73.198 --nova-ac
    python -m ferramentas.certificado_tls --ver

Os nomes sao TODOS os enderecos pelos quais as estacoes abrem o sistema — o IP
fixo desta maquina e, se o TI tiver dado um, o nome dela. Endereco que nao
estiver aqui abre com o aviso vermelho do navegador.

Primeira vez: cria `dados/tls/ca.crt` (a raiz, que vai para cada estacao) e
`dados/tls/ca.key` (que NUNCA sai desta maquina). Depois: renova so o
certificado do servidor, com a mesma AC — as estacoes nao precisam de nada.
O passo a passo inteiro, inclusive a instalacao da raiz nas estacoes, esta em
`docs/HTTPS_NA_REDE.md`. O porque da AC restrita, em `app/servicos/tls.py`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from app.config import obter_config  # noqa: E402
from app.servicos import tls  # noqa: E402

PASTA_PADRAO = "dados/tls"


def ver(pasta: Path) -> int:
    cert = pasta / tls.ARQ_CERT
    vence = tls.vencimento(cert)
    if vence is None:
        print(f"Nenhum certificado em {cert}.")
        return 1
    print(f"Certificado: {cert}")
    print(f"Endereço:    {tls.primeiro_nome(cert)}")
    print(f"Vence em:    {vence:%d/%m/%Y}")
    for aviso in tls.avisos(cert, pasta / tls.ARQ_CHAVE):
        print(f"ATENÇÃO: {aviso}")
    return 0


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("nomes", nargs="*", help="IP e/ou nome desta máquina na rede")
    parser.add_argument("--pasta", default=PASTA_PADRAO)
    parser.add_argument(
        "--nova-ac",
        action="store_true",
        help="descarta a AC atual e cria outra (obriga a reinstalar a raiz nas estações)",
    )
    parser.add_argument("--ver", action="store_true", help="mostra o certificado atual e sai")
    args = parser.parse_args(argv)

    cfg = obter_config()
    pasta = cfg.caminho(args.pasta)
    if args.ver:
        return ver(pasta)
    if not args.nomes:
        parser.error("informe o IP desta máquina na rede (ex.: 10.0.73.198)")

    try:
        emissao = tls.emitir(pasta, args.nomes, nova_ac=args.nova_ac)
    except tls.NomeInvalido as erro:
        print(f"Nada foi gerado: {erro}")
        return 1

    relativo = Path(args.pasta).as_posix()
    print(f"Certificado do servidor gerado para: {', '.join(emissao.nomes)}")
    print(f"Vence em {emissao.vence_em:%d/%m/%Y}. Para renovar, rode este mesmo comando.")
    print()
    if emissao.ac_nova:
        print("AC NOVA criada. Instale a raiz em CADA estação que abre o sistema:")
        print(f"  arquivo: {pasta / tls.ARQ_AC}")
        print("  Windows (prompt como administrador):")
        print(f"    certutil -addstore -f Root {tls.ARQ_AC}")
        print(f"  NUNCA copie {tls.ARQ_AC_CHAVE} para fora desta máquina.")
        print()
    print("No .env desta máquina (e reinicie o sistema):")
    print(f"  CSSO_TLS_CERTIFICADO={relativo}/{tls.ARQ_CERT}")
    print(f"  CSSO_TLS_CHAVE={relativo}/{tls.ARQ_CHAVE}")
    print()
    # A porta sai do .env que ESTA valendo agora (CSSO_ENV_FILE, ou o da raiz).
    # Gerar o certificado do ambiente de teste com o .env da raiz em vigor
    # imprimia a porta do sistema de verdade — endereco que nao abre nada.
    from app.config import caminho_env_file

    print(f"Endereço para as estações: https://{emissao.nomes[0]}:{cfg.porta}/")
    print(f"(porta lida de {caminho_env_file()})")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
