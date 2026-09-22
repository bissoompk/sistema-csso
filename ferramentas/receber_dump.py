"""Receptor local de despejo do navegador.

Por que existe: a engenharia reversa do IntegraSST precisa trazer ~15 mil linhas
de Apps Script para o disco. Passar isso pelo chat consumiria o contexto inteiro
sem nenhum ganho — o que importa é o arquivo em disco, para os agentes lerem.

Sobe um HTTP local que aceita POST do navegador e grava o corpo num arquivo.
Escuta so em 127.0.0.1, aceita so os caminhos declarados e morre sozinho: nao e
servico, e um funil de uso unico.

    python -m ferramentas.receber_dump --destino entrada\\integrasst --porta 8799
"""

from __future__ import annotations

import argparse
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

LIMITE_BYTES = 40 * 1024 * 1024
NOME_VALIDO = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


class Receptor(BaseHTTPRequestHandler):
    destino: Path
    ocioso: threading.Event

    def _cabecalhos_cors(self) -> None:
        # o navegador chama de https://script.google.com para 127.0.0.1: sem
        # estes tres cabecalhos o Chrome barra no preflight de rede privada
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cabecalhos_cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        # o nome vem no cabecalho quando da para usar fetch; quando o Chrome
        # barra a rede privada, sobra o POST de formulario, que nao manda
        # cabecalho proprio - ai o nome vem na query
        nome = (self.headers.get("X-Nome-Arquivo") or "").strip()
        if not nome:
            consulta = parse_qs(urlparse(self.path).query)
            nome = (consulta.get("nome") or [""])[0].strip()
        if not NOME_VALIDO.match(nome):
            self.send_response(400)
            self._cabecalhos_cors()
            self.end_headers()
            self.wfile.write(b"nome de arquivo invalido")
            return

        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho <= 0 or tamanho > LIMITE_BYTES:
            self.send_response(413)
            self._cabecalhos_cors()
            self.end_headers()
            return

        corpo = self.rfile.read(tamanho)
        # form com enctype text/plain manda "campo=conteudo"; tira o prefixo
        if corpo.startswith(b"conteudo="):
            corpo = corpo[len(b"conteudo=") :]
        alvo = self.destino / nome
        alvo.write_bytes(corpo)
        print(f"gravado: {alvo} ({len(corpo)} bytes)", flush=True)

        self.send_response(200)
        self._cabecalhos_cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"ok {len(corpo)}".encode())
        self.ocioso.set()

    def log_message(self, *_args) -> None:  # silencia o log padrao
        return


def principal() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--destino", required=True)
    p.add_argument("--porta", type=int, default=8799)
    p.add_argument("--minutos", type=int, default=15)
    args = p.parse_args()

    destino = Path(args.destino).resolve()
    destino.mkdir(parents=True, exist_ok=True)
    Receptor.destino = destino
    Receptor.ocioso = threading.Event()

    servidor = ThreadingHTTPServer(("127.0.0.1", args.porta), Receptor)
    print(f"recebendo em http://127.0.0.1:{args.porta}/ -> {destino}", flush=True)
    threading.Timer(args.minutos * 60, servidor.shutdown).start()
    servidor.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
