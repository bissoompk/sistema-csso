"""Caminho de arquivo nunca entra numa URI por concatenacao.

Este e um teste de VARREDURA, irmao dos de template, e nasceu de um defeito
que custou uma hora para achar e nao dizia nada:

    f"-env:UserInstallation=file:///{perfil.as_posix()}"

O caminho de instalacao documentado deste sistema e `C:\\Projetos\\Sistema CSSO`,
com ESPACO. Num `file:///` o espaco cru torna a URL invalida — e o LibreOffice,
diante disso, **sai com codigo 0, com stderr vazio e sem escrever o PDF**. O
sistema entregava o `.docx` com o aviso "instale o LibreOffice" numa maquina
que o tinha instalado, e o teste-ouro que provaria o contrario vivia pulado
por falta do programa. Ou seja: a geracao de PDF nunca teria funcionado no
caminho padrao, e o defeito so apareceria no dia em que alguem instalasse o
LibreOffice.

`Path.as_uri()` resolve a classe inteira: exige caminho absoluto e
percent-codifica o espaco, o `?`, o `#` e o resto. A varredura e sobre o
diretorio, e nao sobre uma lista de arquivos conhecidos, pelo mesmo motivo das
outras: uma lista fecharia as ocorrencias de hoje e deixaria a porta aberta
para a proxima — que nasce por copia do vizinho.

**Docstring e comentario nao entram.** O que se procura e uma URI MONTADA: uma
f-string ou uma concatenacao. Texto que apenas CITA `file://` — inclusive o
comentario que explica este defeito, em `servicos/pdf.py` — e documentacao, e
documentacao nao roda.
"""

from __future__ import annotations

import ast
from pathlib import Path

from app.config import RAIZ

PASTAS = (Path(RAIZ) / "app", Path(RAIZ) / "ferramentas")

# `file://` e `file:` (o SQLite aceita a segunda forma). Basta o prefixo do
# esquema aparecer no pedaco LITERAL de uma f-string ou de uma soma.
MARCAS = ("file://", "file:")


def _literais_montados(arvore: ast.AST) -> list[tuple[int, str]]:
    """Trechos de texto que fazem parte de uma f-string ou de uma soma."""
    achados: list[tuple[int, str]] = []

    for no in ast.walk(arvore):
        if isinstance(no, ast.JoinedStr):
            # f-string: junta os pedacos literais e ignora o que e interpolado
            texto = "".join(
                parte.value
                for parte in no.values
                if isinstance(parte, ast.Constant) and isinstance(parte.value, str)
            )
            if texto:
                achados.append((no.lineno, texto))
        elif isinstance(no, ast.BinOp) and isinstance(no.op, ast.Add):
            for lado in (no.left, no.right):
                if isinstance(lado, ast.Constant) and isinstance(lado.value, str):
                    achados.append((no.lineno, lado.value))
    return achados


def _ocorrencias() -> list[str]:
    fora: list[str] = []
    for pasta in PASTAS:
        for arquivo in sorted(pasta.rglob("*.py")):
            arvore = ast.parse(arquivo.read_text(encoding="utf-8"))
            for linha, texto in _literais_montados(arvore):
                if any(marca in texto for marca in MARCAS):
                    fora.append(f"{arquivo.relative_to(RAIZ).as_posix()}:{linha} {texto!r}")
    return fora


def test_nenhuma_uri_de_arquivo_montada_por_concatenacao() -> None:
    fora = _ocorrencias()
    assert not fora, (
        "URI de arquivo montada com o caminho cru. Use `Path.as_uri()`, que "
        "percent-codifica o espaco de 'Sistema CSSO' e o resto:\n" + "\n".join(fora)
    )


def test_a_varredura_acha_o_defeito_que_ela_procura() -> None:
    """Sonda: uma varredura que nao consegue reprovar nao vale nada.

    Os dois primeiros casos sao o defeito real, nas duas formas em que ele
    aparece; os dois ultimos sao o que ela tem de deixar passar.
    """
    def achou(codigo: str) -> bool:
        return any(
            marca in texto
            for _, texto in _literais_montados(ast.parse(codigo))
            for marca in MARCAS
        )

    assert achou('x = f"-env:UserInstallation=file:///{p.as_posix()}"')
    assert achou('x = "file:" + str(p) + "?mode=ro"')
    # o certo, e a documentacao
    assert not achou('x = f"{p.as_uri()}?mode=ro"')
    assert not achou('"""Comentario que cita file:/// e nao monta nada."""')
