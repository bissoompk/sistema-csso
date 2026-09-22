"""Caixa de areia da suite de testes.

Este arquivo mora na RAIZ de proposito, e nao dentro de `testes/`.

O pytest importa o conftest.py do rootdir antes de coletar qualquer coisa:
antes dos outros conftest, antes dos modulos de teste e, portanto, antes do
primeiro `import app.config`. E o unico ponto do ciclo de vida em que da para
preparar o ambiente sem depender de ordem de import.

Fazer isso dentro de um fixture (era o que `testes/conftest.py` fazia) e tarde
demais: fixture roda no setup do primeiro teste, muito depois de a configuracao
ja ter nascido apontando para o `.env` de producao. O resultado media-se em
arquivo: documento de teste gravado em `dados/documentos/` e backup do banco de
teste gravado em `dados/backups/`, na mesma rotacao que o setor restauraria.

Cinto e suspensorio - sao duas travas independentes, de proposito:

1. `CSSO_ENV_FILE` aponta para um .env descartavel. Depende de `app.config`
   resolver o env_file na instanciacao (e resolve - veja `caminho_env_file`).
2. As variaveis `CSSO_*` exportadas direto no ambiente. No pydantic-settings a
   variavel de ambiente tem precedencia sobre o arquivo .env, sempre, sem
   depender de ordem nenhuma. Se um dia alguem refatorar o env_file de volta
   para o corpo da classe, esta segunda trava segura o isolamento sozinha.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent


def _montar_caixa_de_areia() -> Path:
    """Cria o diretorio descartavel e exporta a configuracao de teste.

    Roda no corpo do modulo, nao em fixture: precisa valer ja no import.
    """
    base = Path(tempfile.mkdtemp(prefix="csso-testes-"))

    valores = {
        "CSSO_BANCO_URL": f"sqlite+pysqlite:///{(base / 'csso.db').as_posix()}",
        "CSSO_CHAVE_SECRETA": "chave-de-teste-0123456789abcdef",
        "CSSO_BACKUP_SENHA": "senha-de-teste",
        "CSSO_DIR_DOCUMENTOS": (base / "documentos").as_posix(),
        "CSSO_DIR_ANEXOS": (base / "anexos").as_posix(),
        "CSSO_DIR_ENTRADA": (base / "entrada").as_posix(),
        "CSSO_PERFIL_LO": (base / "perfil_lo").as_posix(),
        "CSSO_BACKUP_DESTINO": (base / "backups").as_posix(),
        # O registro de acesso HTTP grava em disco e tem retencao propria. Sem
        # esta linha `dir_logs` cairia no padrao `dados/logs` — dentro do
        # repositorio — e `pytest_configure` abortaria a sessao inteira, que e
        # exatamente o que a trava existe para fazer.
        "CSSO_DIR_LOGS": (base / "logs").as_posix(),
        "CSSO_ABRIR_NAVEGADOR": "false",
        "CSSO_AMBIENTE": "teste",
    }

    env = base / ".env"
    env.write_text(
        "\n".join(f"{chave}={valor}" for chave, valor in valores.items()),
        encoding="utf-8",
    )

    os.environ["CSSO_ENV_FILE"] = str(env)
    os.environ.update(valores)
    return base


CAIXA_DE_AREIA = _montar_caixa_de_areia()


@atexit.register
def _limpar_caixa_de_areia() -> None:
    # ignore_errors: no Windows o SQLite as vezes ainda segura o arquivo quando
    # o processo termina. Sobrar lixo em %TEMP% e menos grave do que estourar no
    # encerramento da suite.
    shutil.rmtree(CAIXA_DE_AREIA, ignore_errors=True)


def violacoes_de_isolamento() -> list[str]:
    """Nomes dos caminhos da config que caem dentro do repositorio.

    Lista vazia = suite isolada. Qualquer item = a suite vai escrever em
    `dados/` (ou em `entrada/`) do coordenador.
    """
    from app.config import obter_config

    cfg = obter_config()
    alvos = dict(cfg.diretorios_de_dados)
    alvos["banco"] = cfg.caminho_banco

    fora = []
    for nome, caminho in alvos.items():
        if caminho.resolve() == RAIZ or RAIZ in caminho.resolve().parents:
            fora.append(f"{nome} -> {caminho}")
    return sorted(fora)


def pytest_configure(config: pytest.Config) -> None:
    """Aborta a sessao inteira se o isolamento nao pegou.

    Um teste que falha pode ser desmarcado, ignorado ou simplesmente rodar
    depois de outro ja ter escrito. Aqui nao roda teste nenhum: e a diferenca
    entre descobrir o furo no CI e descobrir olhando documento de producao
    sobrescrito.
    """
    problemas = violacoes_de_isolamento()
    if problemas:
        pytest.exit(
            "ISOLAMENTO QUEBRADO - a suite esta configurada para escrever "
            "dentro do repositorio:\n  " + "\n  ".join(problemas) + "\n"
            "Nenhum teste foi executado. Veja o conftest.py da raiz.",
            returncode=3,
        )
