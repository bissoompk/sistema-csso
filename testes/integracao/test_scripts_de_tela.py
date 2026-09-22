"""Todo script embutido de toda tela é JavaScript que o navegador consegue ler.

Este é um teste de VARREDURA, irmão dos de template, e nasceu de um defeito
real: um refactor do script do kanban cortou o corpo de uma função no meio (o
trecho de busca casou com uma ocorrência anterior do mesmo seletor), o bloco
inteiro deixou de ser analisável, e **o arrasto do quadro parou de existir sem
uma linha de erro na suíte** — os testes liam a página e achavam nela as
palavras que procuravam. Um `SyntaxError` num `<script>` não é "um
comportamento a menos": é o bloco INTEIRO que não roda, e o único sinal é o
console do navegador, que a suíte não vê.

Quem lê a sintaxe é o `node` (`node --check`), quando está na máquina. Sem
ele o teste é pulado — e diz por quê — em vez de fingir que passou. A
verificação é sobre as páginas RENDERIZADAS, não sobre os templates: o
script pode carregar Jinja dentro (a política de senha entra assim), e só o
HTML que chega ao navegador é o que o navegador lê.
"""

from __future__ import annotations

import re
import shutil
import subprocess

import pytest

from app.config import RAIZ
from testes.integracao.conftest import entrar

NODE = shutil.which("node")

# uma tela por família de script embutido: casca, kanban, popup, senha,
# editor, lista com ações em lote, balcão de EPI, ficha de turma
TELAS = [
    "/kanban",
    "/processos",
    "/processos/novo",
    "/servidores",
    "/epis/entregas/nova",
    "/turmas",
    "/login",
    "/trocar-senha",
    "/celular",
]

_SCRIPT = re.compile(r"<script(?P<attrs>[^>]*)>(?P<corpo>.*?)</script>", re.S)


def _checar(codigo: str) -> str | None:
    """Mensagem do `node --check`, ou None quando a sintaxe está certa."""
    resultado = subprocess.run(
        [NODE, "--check", "-"], input=codigo, capture_output=True, text=True,
        encoding="utf-8", timeout=30,
    )
    return None if resultado.returncode == 0 else resultado.stderr.strip()


@pytest.mark.skipif(NODE is None, reason="node não está na máquina: a sintaxe dos scripts fica sem conferência")
def test_todo_script_embutido_das_telas_e_javascript_valido(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    defeitos: list[str] = []
    vistos = 0
    for tela in TELAS:
        html = app_cliente.get(tela).text
        for i, achado in enumerate(_SCRIPT.finditer(html)):
            if "src=" in achado.group("attrs") or not achado.group("corpo").strip():
                continue
            vistos += 1
            erro = _checar(achado.group("corpo"))
            if erro:
                defeitos.append(f"{tela} · script {i}:\n{erro}")
    assert vistos >= len(TELAS), "a varredura não encontrou os scripts que esperava"
    assert not defeitos, "script embutido com erro de sintaxe:\n\n" + "\n\n".join(defeitos)


@pytest.mark.skipif(NODE is None, reason="node não está na máquina")
def test_o_arquivo_de_comportamentos_e_javascript_valido():
    codigo = (RAIZ / "app" / "estaticos" / "js" / "csso.js").read_text(encoding="utf-8")
    assert _checar(codigo) is None


@pytest.mark.skipif(NODE is None, reason="node não está na máquina")
def test_a_varredura_acha_o_defeito_que_ela_procura():
    """Sonda: um conferidor que não consegue reprovar não vale nada."""
    assert _checar("function a() {\n})();") is not None
    assert _checar("(function () { var x = 1; })();") is None
