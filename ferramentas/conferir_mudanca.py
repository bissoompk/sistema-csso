"""Confere se a copia do sistema chegou inteira em outra maquina.

Uso:
    python -m ferramentas.conferir_mudanca

A saida:
    0 - nada impede o sistema de subir aqui
    1 - ha impedimento (a linha correspondente comeca com ERRO)

Isto NAO e um teste de software — a suite faz isso, e o passo esta em
MUDAR-DE-PC.md. Isto confere as cinco coisas que a suite nao alcanca porque
NENHUMA delas esta no codigo: o endereco de ligacao, o .env, o arquivo do banco,
o LibreOffice e a contagem de linhas. Sao exatamente as que mudam quando o
mesmo codigo troca de computador.

O ponto mais importante e o primeiro. `CSSO_HOST` guarda o IP da maquina de
ORIGEM (10.0.73.198 quando este arquivo foi escrito), e esse endereco nao existe
na maquina de destino. O uvicorn morre com WinError 10049 ("o endereco
solicitado nao e valido no contexto"), a janela preta fecha, e a mensagem nao
diz em lugar nenhum que o problema e uma linha do .env. Aqui diz.

Roda com o sistema no ar: nao escreve nada, e a prova de endereco liga na porta
0 (o sistema operacional escolhe uma porta livre), entao nao disputa a 8765.
"""

from __future__ import annotations

import socket
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import RAIZ, SO_LOOPBACK, VERSAO, obter_config  # noqa: E402
from app.servicos import pdf  # noqa: E402

# As entidades que uma pessoa consegue conferir de cabeca contra a outra
# maquina. A lista e curta de proposito: 74 tabelas viram um muro de numeros que
# ninguem compara de verdade. O total no fim pega o que ficou de fora.
ENTIDADES = (
    "processo",
    "parecer_tecnico",
    "laudo_tecnico",
    "adicional_vigencia",
    "servidor",
    "anexo",
    "demanda",
    "epi_requisicao",
    "epi_item",
    "turma",
    "participante",
    "certificado",
    "usuario",
    "historico_evento",
)


class Relato:
    """Acumula as linhas e lembra se alguma delas impede o sistema de subir."""

    def __init__(self) -> None:
        self.impedimentos = 0

    def ok(self, texto: str) -> None:
        print(f"  ok    {texto}")

    def aviso(self, texto: str) -> None:
        print(f"  aviso {texto}")

    def erro(self, texto: str) -> None:
        print(f"  ERRO  {texto}")
        self.impedimentos += 1


def _conferir_endereco(r: Relato, host: str, porta: int) -> None:
    print("Endereco de ligacao (CSSO_HOST)")
    familia = socket.AF_INET6 if ":" in host and host != "::1" else socket.AF_INET
    try:
        with socket.socket(familia, socket.SOCK_STREAM) as s:
            # Porta 0, e nao `porta`: o que se prova aqui e que o ENDERECO
            # pertence a esta maquina. Ligar na 8765 acusaria "em uso" quando o
            # sistema ja estivesse no ar — que e o caso saudavel, nao o defeito.
            s.bind((host, 0))
    except OSError as erro:
        r.erro(
            f"nao da para ligar em {host}: {erro.strerror or erro}.\n"
            f"        Este endereco e de outra maquina. Abra o .env e ponha\n"
            f"        CSSO_HOST=127.0.0.1 (so esta maquina) ou o IP desta aqui\n"
            f"        (rode ipconfig para descobrir)."
        )
        return

    if host in SO_LOOPBACK:
        r.ok(f"{host}:{porta} — so esta maquina alcanca.")
    else:
        r.aviso(
            f"{host}:{porta} — a porta aceita conexao de fora desta maquina.\n"
            "        Quem limita a origem e o firewall. Se esta e a maquina de\n"
            "        desenvolvimento e nao a do setor, use 127.0.0.1."
        )


def _conferir_env(r: Relato, cfg) -> None:
    print("Configuracao (.env)")
    caminho = RAIZ / ".env"
    if not caminho.exists():
        r.erro(".env nao existe. Copie o da maquina de origem — e NAO deixe o\n"
               "        INICIAR.bat criar um novo: a senha nova nao abre backup velho.")
        return
    r.ok(f"{caminho} ({caminho.stat().st_size} bytes)")
    for aviso in cfg.inseguro:
        # `inseguro` ja e a lista que o /saude e a faixa do topo mostram. Repetir
        # a regra aqui daria duas fontes de verdade que divergem no primeiro
        # aviso novo.
        r.aviso(aviso)


def _conferir_banco(r: Relato, cfg) -> None:
    print("Banco de dados")
    caminho = cfg.caminho_banco
    if not caminho.exists():
        r.erro(f"{caminho} nao existe.")
        return

    # `as_uri()` e nao `f"file:{...as_posix()}"`. O caminho deste sistema tem
    # espaco (`C:\Projetos\Sistema CSSO`), e caminho cru dentro de URI e a
    # familia de defeito que custou a conversao de PDF na 1.42.2: la o espaco
    # invalidava a URL e o LibreOffice saia com codigo 0, sem dizer nada. O
    # SQLite tolera o espaco, mas nao toleraria um `?` nem um `#` — e o certo
    # e nao ter de saber quais caracteres cada leitor de URI perdoa.
    con = sqlite3.connect(f"{caminho.resolve().as_uri()}?mode=ro", uri=True)
    try:
        veredito = con.execute("pragma integrity_check").fetchone()[0]
        if veredito != "ok":
            r.erro(f"integridade: {veredito}")
        else:
            r.ok(f"{caminho} ({caminho.stat().st_size // 1024} KB), integridade ok")

        atual = con.execute("select version_num from alembic_version").fetchone()
        atual = atual[0] if atual else "(nenhuma)"
        _conferir_migracao(r, atual)
        _contar(r, con)
    finally:
        con.close()

    # O -wal cheio significa transacao ainda nao incorporada ao .db. Copiar so o
    # .db nesse estado perde o que estava no -wal, e o banco abre sem erro
    # nenhum: some dado, nao aparece defeito.
    wal = caminho.with_name(caminho.name + "-wal")
    if wal.exists() and wal.stat().st_size > 0:
        r.aviso(
            f"{wal.name} tem {wal.stat().st_size} bytes de escrita pendente.\n"
            "        Se este banco veio de outra maquina, confirme que o -wal e o\n"
            "        -shm vieram junto com o .db."
        )


def _conferir_migracao(r: Relato, atual: str) -> None:
    try:
        from alembic.config import Config as ConfigAlembic
        from alembic.script import ScriptDirectory

        cfg_alembic = ConfigAlembic(str(RAIZ / "alembic.ini"))
        cfg_alembic.set_main_option("script_location", str(RAIZ / "alembic"))
        cabecas = ScriptDirectory.from_config(cfg_alembic).get_heads()
    except Exception as erro:  # noqa: BLE001 - diagnostico, nao fluxo
        r.aviso(f"migracao: {atual} (nao consegui ler o alembic: {erro})")
        return

    if atual in cabecas:
        r.ok(f"migracao: {atual} (no topo)")
    else:
        r.erro(
            f"migracao: o banco esta em {atual} e o codigo espera {', '.join(cabecas)}.\n"
            "        Rode:  uv run alembic upgrade head  (com backup antes)."
        )


def _contar(r: Relato, con: sqlite3.Connection) -> None:
    print("Linhas (compare com o que a outra maquina imprimiu)")
    existentes = {n for (n,) in con.execute("select name from sqlite_master where type='table'")}
    total = 0
    for tabela in existentes:
        total += con.execute(f"select count(*) from {tabela}").fetchone()[0]
    for tabela in ENTIDADES:
        if tabela not in existentes:
            print(f"        {tabela:22} (tabela nao existe)")
            continue
        print(f"        {tabela:22} {con.execute(f'select count(*) from {tabela}').fetchone()[0]}")
    print(f"        {'TOTAL (74 tabelas)':22} {total}")


def _conferir_pastas(r: Relato, cfg) -> None:
    print("Pastas de dados")
    for campo, caminho in cfg.diretorios_de_dados.items():
        if caminho.exists():
            quantos = sum(1 for _ in caminho.rglob("*") if _.is_file())
            r.ok(f"{campo}: {caminho} ({quantos} arquivo(s))")
        else:
            r.aviso(f"{campo}: {caminho} nao existe — sera criada no primeiro boot.")


def _conferir_pdf(r: Relato) -> None:
    print("LibreOffice (PDF)")
    achado = pdf.localizar_soffice()
    if achado:
        r.ok(f"{achado}")
    else:
        # Nao e impedimento por decisao de projeto: sem soffice a emissao entrega
        # o .docx com aviso, e nunca falha. Mas quem muda de maquina e emite um
        # parecer precisa saber por que o PDF parou de sair.
        r.aviso(
            "nao encontrado. O sistema entrega o .docx com aviso e a emissao nao\n"
            "        falha, mas o PDF nao sai sozinho. Instale o LibreOffice ou\n"
            "        aponte CSSO_SOFFICE no .env."
        )


def principal() -> int:
    cfg = obter_config()
    print(f"Sistema CSSO v{VERSAO} — conferencia de mudanca de maquina")
    print(f"Pasta: {RAIZ}\n")

    r = Relato()
    _conferir_endereco(r, cfg.host, cfg.porta)
    _conferir_env(r, cfg)
    _conferir_banco(r, cfg)
    _conferir_pastas(r, cfg)
    _conferir_pdf(r)

    print()
    if r.impedimentos:
        print(f"{r.impedimentos} impedimento(s). O sistema NAO vai subir assim.")
        print("Cada linha ERRO acima diz o que fazer.")
        return 1
    print("Nenhum impedimento. Falta so a suite: uv run pytest")
    print("E a prova da senha do backup — passo 6 de MUDAR-DE-PC.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
