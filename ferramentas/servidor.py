"""Sobe o sistema e abre o navegador. Chamado pelo INICIAR.bat."""

from __future__ import annotations

import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn  # noqa: E402

from app.config import SO_LOOPBACK, VERSAO, obter_config  # noqa: E402


def _porta_livre(host: str, porta: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, porta)) != 0


def _abrir_quando_subir(url: str, host: str, porta: int) -> None:
    for _ in range(120):
        time.sleep(0.5)
        if not _porta_livre(host, porta):
            webbrowser.open(url)
            return


def principal() -> int:
    cfg = obter_config()
    cfg.preparar_diretorios()
    host = cfg.host
    porta = cfg.porta

    if not _porta_livre(host if host != "0.0.0.0" else "127.0.0.1", porta):
        print(f"Ja existe algo escutando em {host}:{porta}. O sistema pode estar aberto.")
        print(f"Abra http://127.0.0.1:{porta}/ no navegador ou rode PARAR.bat antes.")
        return 1

    url = f"http://{'127.0.0.1' if host == '0.0.0.0' else host}:{porta}/"
    print(f"Sistema CSSO v{VERSAO}")
    print(f"Banco:  {cfg.caminho_banco}")
    if cfg.log_acesso:
        # O caminho e anunciado AQUI, e nao no log da aplicacao, porque esta e a
        # janela que o operador tem na frente. Quem investiga um incidente
        # precisa saber onde procurar antes de precisar procurar.
        print(f"Acesso: {cfg.caminho(cfg.dir_logs) / 'acesso.log'} ({cfg.log_retencao_dias} dias)")
    print(f"Ligado em {host}:{porta}")
    if host not in SO_LOOPBACK:
        # Ligar em 0.0.0.0 nao e "abrir para a rede do setor": e aceitar de
        # QUALQUER endereco que consiga rotear ate esta maquina. Quem estreita
        # isso e o firewall, e nao o sistema — a diferenca entre o switch da sala
        # e a VLAN do campus inteiro nao esta em lugar nenhum deste codigo.
        print("  A porta aceita conexao de fora desta maquina.")
        print("  Quem limita a origem e a regra de firewall, nao o sistema.")
        print("  Passo a passo: entrada/implantacao/01_REDE_DO_SETOR.md")
    print(f"Abrindo {url}")
    for aviso in cfg.inseguro:
        print(f"  ATENCAO: {aviso}")

    if cfg.abrir_navegador:
        threading.Thread(
            target=_abrir_quando_subir,
            args=(url, "127.0.0.1" if host == "0.0.0.0" else host, porta),
            daemon=True,
        ).start()

    uvicorn.run("app.principal:app", host=host, port=porta, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
