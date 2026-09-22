"""Baixa as fontes do redesign e as guarda no proprio sistema.

Por que existe: o desenho pede Public Sans e JetBrains Mono, e o Google Fonts
serviria as duas por CDN. Nao serve aqui por dois motivos. O primeiro e a regra
que ja fez o HTMX ser vendorizado: nada de CDN, para o sistema abrir numa rede
que so alcanca a UFVJM. O segundo e mais serio - cada pagina faria o navegador
do servidor chamar `fonts.gstatic.com`, e o ROPA declara que nao ha operador
terceiro nem transferencia internacional.

Entao a busca acontece UMA vez, aqui, na maquina de quem desenvolve, e o
resultado entra no repositorio. Rode de novo so para atualizar a fonte.

    python -m ferramentas.baixar_fontes
"""

from __future__ import annotations

import re
import urllib.request
from pathlib import Path

from app.config import RAIZ

DESTINO = RAIZ / "app" / "estaticos" / "fontes"

# O `user-agent` decide o formato que a API devolve: sem um navegador moderno
# ela entrega TTF em vez de woff2, que é três vezes maior.
NAVEGADOR = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

FAMILIAS = {
    "public-sans": "https://fonts.googleapis.com/css2?family=Public+Sans:wght@300..800",
    "jetbrains-mono": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..500",
}

# Só latin e latin-ext: o português cabe nos dois, e o cirílico e o grego que a
# API também oferece seriam peso morto para este sistema.
SUBCONJUNTOS = ("latin", "latin-ext")


def _buscar(url: str) -> str:
    pedido = urllib.request.Request(url, headers={"User-Agent": NAVEGADOR})
    with urllib.request.urlopen(pedido, timeout=30) as resposta:
        return resposta.read().decode("utf-8")


def _blocos(css: str) -> list[tuple[str, str]]:
    """(subconjunto, url do woff2) para cada @font-face da folha."""
    achados = []
    for bloco in css.split("@font-face")[1:]:
        comentario = re.search(r"/\*\s*([a-z\-]+)\s*\*/", bloco)
        arquivo = re.search(r"url\((https://[^)]+\.woff2)\)", bloco)
        if comentario and arquivo:
            achados.append((comentario.group(1), arquivo.group(1)))
    return achados


def principal() -> int:
    DESTINO.mkdir(parents=True, exist_ok=True)
    total = 0
    for nome, url in FAMILIAS.items():
        css = _buscar(url)
        for subconjunto, endereco in _blocos(css):
            if subconjunto not in SUBCONJUNTOS:
                continue
            alvo = DESTINO / f"{nome}-{subconjunto}.woff2"
            pedido = urllib.request.Request(endereco, headers={"User-Agent": NAVEGADOR})
            with urllib.request.urlopen(pedido, timeout=60) as resposta:
                dados = resposta.read()
            alvo.write_bytes(dados)
            print(f"{alvo.name}: {len(dados) // 1024} KB")
            total += len(dados)
    print(f"total: {total // 1024} KB em {DESTINO}")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
