"""Baixa o quadro do Trello inteiro: JSON, feed de acoes e anexos.

O quadro e privado, entao precisa de credencial. Coloque no `.env` — nunca em
linha de comando, nunca no repositorio:

    CSSO_TRELLO_KEY=...     (Trello: Power-Ups -> API key)
    CSSO_TRELLO_TOKEN=...   (o token gerado a partir dessa chave)

Uso:
    python -m ferramentas.baixar_trello KBZgbh38
    python -m ferramentas.baixar_trello KBZgbh38 --sem-anexos

As URLs de anexo do Trello expiram: baixe antes do corte da migracao.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from app.config import obter_config  # noqa: E402
from app.servicos.textos import slug_ascii  # noqa: E402

BASE = "https://api.trello.com/1"
PAGINAS_MAXIMAS = 60


def _credenciais() -> tuple[str, str]:
    # o pydantic-settings ja carregou o .env para o processo
    obter_config()
    chave = os.environ.get("CSSO_TRELLO_KEY", "")
    token = os.environ.get("CSSO_TRELLO_TOKEN", "")
    if not (chave and token):
        caminho = RAIZ / ".env"
        for linha in caminho.read_text(encoding="utf-8").splitlines() if caminho.exists() else []:
            if linha.startswith("CSSO_TRELLO_KEY="):
                chave = linha.split("=", 1)[1].strip()
            elif linha.startswith("CSSO_TRELLO_TOKEN="):
                token = linha.split("=", 1)[1].strip()
    if not (chave and token):
        raise SystemExit(
            "Faltam CSSO_TRELLO_KEY e CSSO_TRELLO_TOKEN no .env.\n"
            "Gere em https://trello.com/power-ups/admin (API key) e autorize o token.\n"
            "Escreva os dois no .env — não passe por linha de comando."
        )
    return chave, token


def _pedir(caminho: str, chave: str, token: str, **parametros) -> object:
    parametros.update({"key": chave, "token": token})
    url = f"{BASE}{caminho}?{urllib.parse.urlencode(parametros)}"
    requisicao = urllib.request.Request(url, headers={"User-Agent": "CSSO/1.0"})
    for tentativa in range(4):
        try:
            with urllib.request.urlopen(requisicao, timeout=90) as resposta:
                return json.loads(resposta.read().decode("utf-8"))
        except urllib.error.HTTPError as erro:
            if erro.code == 429:  # limite de taxa do Trello
                time.sleep(2 * (tentativa + 1))
                continue
            raise
    raise SystemExit(f"Trello recusou repetidamente: {caminho}")


def baixar_quadro(short_link: str, com_anexos: bool = True) -> dict:
    chave, token = _credenciais()
    cfg = obter_config()
    entrada = cfg.caminho(cfg.dir_entrada)
    entrada.mkdir(parents=True, exist_ok=True)

    print("lendo o quadro...")
    quadro = _pedir(f"/boards/{short_link}", chave, token, fields="name,shortLink")
    listas = _pedir(
        f"/boards/{short_link}/lists", chave, token, fields="name,closed", filter="all"
    )
    cartoes = _pedir(
        f"/boards/{short_link}/cards",
        chave,
        token,
        filter="all",
        limit=1000,
        fields="name,desc,idList,due,dueComplete,closed,shortLink,dateLastActivity,labels",
        attachments="true",
        attachment_fields="name,url,bytes,mimeType,date",
        checklists="all",
        customFieldItems="true",
        badges="true",
    )
    print(f"  {len(listas)} listas, {len(cartoes)} cartões")

    print("lendo o feed de ações (preserva as datas originais)...")
    acoes: list[dict] = []
    antes = None
    for _ in range(PAGINAS_MAXIMAS):
        parametros = {"limit": 1000, "filter": "all"}
        if antes:
            parametros["before"] = antes
        bloco = _pedir(f"/boards/{short_link}/actions", chave, token, **parametros)
        if not bloco:
            break
        acoes.extend(bloco)
        antes = bloco[-1]["date"]
        print(f"  {len(acoes)} ações...", end="\r")
        if len(bloco) < 1000:
            break
    print(f"  {len(acoes)} ações            ")

    destino = entrada / f"trello_{short_link}.json"
    destino.write_text(
        json.dumps(
            {
                "id": quadro["id"],
                "name": quadro["name"],
                "shortLink": quadro["shortLink"],
                "lists": listas,
                "cards": cartoes,
                "actions": acoes,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"quadro salvo em {destino}")

    resumo = {"listas": len(listas), "cartoes": len(cartoes), "acoes": len(acoes), "anexos": 0}
    if com_anexos:
        resumo["anexos"] = _baixar_anexos(cartoes, chave, token, entrada / "anexos_trello")
    return resumo


ARQUIVO_INDICE = "_indice.json"


def _baixar_anexos(cartoes: list[dict], chave: str, token: str, pasta: Path) -> int:
    """Baixa e grava um indice url -> arquivo.

    O indice existe porque nomes de anexo se repetem entre cartoes ('parecer.pdf'
    aparece dezenas de vezes): casar por nome perderia arquivo. O importador le
    este indice para achar os bytes sem tocar na rede.
    """
    pasta.mkdir(parents=True, exist_ok=True)
    indice_arquivo = pasta / ARQUIVO_INDICE
    indice: dict[str, str] = {}
    if indice_arquivo.exists():
        indice = json.loads(indice_arquivo.read_text(encoding="utf-8"))

    pendentes = [
        (c, a) for c in cartoes for a in (c.get("attachments") or []) if a.get("url")
    ]
    print(f"baixando {len(pendentes)} anexos (as URLs do Trello expiram)...")
    autorizacao = f'OAuth oauth_consumer_key="{chave}", oauth_token="{token}"'
    baixados = 0
    for i, (cartao, anexo) in enumerate(pendentes, start=1):
        url = anexo["url"]
        nome = anexo.get("name") or "anexo"
        sufixo = Path(nome).suffix or Path(url).suffix
        alvo = pasta / f"{cartao['id'][-8:]}_{slug_ascii(Path(nome).stem)[:60]}{sufixo}"

        if alvo.exists() and alvo.stat().st_size > 0:
            indice[url] = alvo.name
            baixados += 1
            continue

        requisicao = urllib.request.Request(
            url, headers={"User-Agent": "CSSO/1.0", "Authorization": autorizacao}
        )
        try:
            with urllib.request.urlopen(requisicao, timeout=180) as resposta:
                alvo.write_bytes(resposta.read())
            indice[url] = alvo.name
            baixados += 1
        except Exception as erro:  # nao derruba a carga por um anexo
            print(f"\n  falhou: {nome} ({type(erro).__name__})")
        print(f"  {i}/{len(pendentes)}", end="\r")

    indice_arquivo.write_text(
        json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"  {baixados}/{len(pendentes)} anexos em {pasta}")
    return baixados


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("short_link", help="ex.: KBZgbh38")
    parser.add_argument("--sem-anexos", action="store_true")
    args = parser.parse_args(argv)
    resumo = baixar_quadro(args.short_link, com_anexos=not args.sem_anexos)
    print(json.dumps(resumo, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
