"""Receptor temporario para trazer o export do Trello do navegador ao disco.

Por que existe: o Chrome, sob automacao, bloqueia download por script, e uma
pagina em https://trello.com nao consegue falar com o app local. A ponte usa
`window.name`, que sobrevive a navegacao entre origens: a aba do Trello guarda
o JSON em window.name e navega para este servidor, que le e grava em entrada/.

Escopo deliberadamente minimo:
  * escuta so em 127.0.0.1;
  * exige um token de uso unico passado na URL;
  * grava UM arquivo dentro de entrada/ e encerra sozinho;
  * NAO faz parte do sistema - e ferramenta de migracao, rodada a mao.

Uso:
    python -m ferramentas.receber_export ARQUIVO.json [--porta 8799]
"""

from __future__ import annotations

import argparse
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

PAGINA = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Recebendo export</title>
<style>body{font:16px system-ui;margin:60px;color:#14212b}
.ok{color:#1f7a4d}.erro{color:#a52121}code{background:#eef2f5;padding:2px 6px}</style>
</head><body>
<h1>Recebendo o export do Trello</h1>
<p id="s">lendo <code>window.name</code>…</p>
<script>
(async () => {
  const s = document.getElementById('s');
  const carga = window.name || '';
  if (!carga) { s.textContent = 'window.name veio vazio — nada a gravar.'; s.className='erro'; return; }
  s.textContent = 'enviando ' + (carga.length/1048576).toFixed(1) + ' MB…';
  const r = await fetch('/salvar?token=__TOKEN__', {method:'POST', body: carga,
                        headers:{'Content-Type':'text/plain'}});
  const t = await r.text();
  s.textContent = t;
  s.className = r.ok ? 'ok' : 'erro';
  window.name = '';
})();
</script></body></html>"""


def servir(destino: Path, porta: int, token: str) -> None:
    encerrar = threading.Event()

    class Manipulador(BaseHTTPRequestHandler):
        def _responder(self, codigo: int, corpo: bytes, tipo: str) -> None:
            self.send_response(codigo)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)

        def _loopback(self) -> bool:
            return self.client_address[0] in ("127.0.0.1", "::1")

        def do_GET(self) -> None:  # noqa: N802
            if not self._loopback():
                self._responder(403, b"somente 127.0.0.1", "text/plain; charset=utf-8")
                return
            pagina = PAGINA.replace("__TOKEN__", token).encode("utf-8")
            self._responder(200, pagina, "text/html; charset=utf-8")

        def do_POST(self) -> None:  # noqa: N802
            if not self._loopback():
                self._responder(403, b"somente 127.0.0.1", "text/plain; charset=utf-8")
                return
            if f"token={token}" not in (self.path or ""):
                self._responder(403, b"token invalido", "text/plain; charset=utf-8")
                return
            tamanho = int(self.headers.get("Content-Length") or 0)
            dados = self.rfile.read(tamanho)
            destino.parent.mkdir(parents=True, exist_ok=True)
            destino.write_bytes(dados)
            mensagem = f"gravado: {destino} ({len(dados)} bytes)"
            print(mensagem, flush=True)
            self._responder(200, mensagem.encode("utf-8"), "text/plain; charset=utf-8")
            encerrar.set()

        def log_message(self, *_args):  # silencia o log padrao
            return

    servidor = HTTPServer(("127.0.0.1", porta), Manipulador)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    print(f"aguardando em http://127.0.0.1:{porta}/?token={token}", flush=True)
    if not encerrar.wait(timeout=600):
        print("tempo esgotado sem receber nada", flush=True)
    servidor.shutdown()


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destino", type=Path)
    parser.add_argument("--porta", type=int, default=8799)
    args = parser.parse_args(argv)
    servir(args.destino, args.porta, secrets.token_urlsafe(24))
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
