"""Conversao .docx -> .pdf via LibreOffice headless. Opcional e degradavel.

Quatro regras:
  1. perfil proprio (-env:UserInstallation) - sem isso a conversao falha em
     silencio se o LibreOffice estiver aberto;
  2. conversoes serializadas por lock de arquivo;
  3. degradacao elegante - sem soffice, entrega o .docx com aviso;
  4. **dentro de requisicao, so por `converter_fora_da_transacao`** - o
     LibreOffice leva segundos e o SQLite tem um escritor so.

Nunca falhe a emissao por causa do PDF.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import obter_config

AVISO_SEM_PDF = (
    "PDF indisponível — abra o .docx no Word e use Salvar como PDF. "
    "Instale o LibreOffice para gerar o PDF automaticamente."
)

CAMINHOS_PADRAO = (
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
)

TEMPO_LIMITE = 180


@dataclass(frozen=True)
class ResultadoPdf:
    gerado: bool
    caminho: Path | None
    aviso: str | None = None
    # Separa "nao ha LibreOffice nesta maquina" de "havia e nao deu certo". Sao
    # a mesma tela para quem emite (o .docx sai, com aviso) e coisas opostas para
    # quem opera: a primeira e configuracao declarada e conhecida; a segunda e
    # incidente numa maquina que TEM a ferramenta, e so essa merece linha na
    # trilha. Sem a distincao, ou toda emissao em maquina sem LibreOffice suja a
    # cadeia de auditoria, ou a falha de verdade se esconde no meio do ruido.
    indisponivel: bool = False


def localizar_soffice() -> Path | None:
    cfg = obter_config()
    if cfg.soffice:
        candidato = Path(cfg.soffice)
        return candidato if candidato.exists() else None
    encontrado = shutil.which("soffice") or shutil.which("soffice.exe")
    if encontrado:
        return Path(encontrado)
    for caminho in CAMINHOS_PADRAO:
        if Path(caminho).exists():
            return Path(caminho)
    return None


def disponivel() -> bool:
    return localizar_soffice() is not None


class _Trava:
    """Lock de arquivo: as conversoes rodam serializadas."""

    def __init__(self, caminho: Path, espera: float = 120.0):
        self.caminho = caminho
        self.espera = espera
        self._fd: int | None = None

    def __enter__(self):
        self.caminho.parent.mkdir(parents=True, exist_ok=True)
        limite = time.monotonic() + self.espera
        while True:
            try:
                self._fd = os.open(str(self.caminho), os.O_CREAT | os.O_EXCL | os.O_RDWR)
                return self
            except FileExistsError:
                if time.monotonic() > limite:
                    raise TimeoutError("outra conversao de PDF esta em andamento")
                time.sleep(0.2)

    def __exit__(self, *_):
        if self._fd is not None:
            os.close(self._fd)
        self.caminho.unlink(missing_ok=True)


def converter(docx: Path, saida: Path | None = None) -> ResultadoPdf:
    cfg = obter_config()
    soffice = localizar_soffice()
    destino = saida or docx.with_suffix(".pdf")
    if soffice is None:
        return ResultadoPdf(False, None, AVISO_SEM_PDF, indisponivel=True)

    perfil = cfg.caminho(cfg.perfil_lo)
    perfil.mkdir(parents=True, exist_ok=True)
    destino.parent.mkdir(parents=True, exist_ok=True)

    comando = [
        str(soffice),
        "--headless",
        "--norestore",
        # `as_uri()`, e nao `f"file:///{perfil.as_posix()}"`. A diferenca e um
        # espaco: o caminho de instalacao documentado deste sistema e
        # `C:\Projetos\Sistema CSSO`, e num `file:///` o espaco cru torna a URL
        # invalida. O LibreOffice entao NAO reclama — ele sai com codigo 0, sem
        # PDF e com stderr vazio —, e o sistema entregava o `.docx` com o aviso
        # "instale o LibreOffice" numa maquina que o tinha instalado. Custou uma
        # hora para achar, e so aparecia onde o caminho tem espaco: ou seja,
        # aqui, sempre, no dia em que alguem instalasse o LibreOffice.
        # `as_uri()` exige caminho absoluto e percent-codifica o que precisa.
        f"-env:UserInstallation={perfil.resolve().as_uri()}",
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        str(destino.parent),
        str(docx),
    ]
    try:
        with _Trava(perfil / "conversao.lock"):
            processo = subprocess.run(
                comando, capture_output=True, timeout=TEMPO_LIMITE, check=False
            )
    except (TimeoutError, subprocess.TimeoutExpired) as erro:
        return ResultadoPdf(False, None, f"{AVISO_SEM_PDF} (detalhe: {erro})")
    except OSError as erro:  # pragma: no cover
        return ResultadoPdf(False, None, f"{AVISO_SEM_PDF} (detalhe: {erro})")

    gerado = destino.parent / (docx.stem + ".pdf")
    if not gerado.exists():
        # O `codigo` entra na frase porque o modo de falha mais caro deste
        # ponto e justamente o silencioso: o LibreOffice sai com 0, sem escrever
        # nada em stderr, e sem produzir o PDF. Sem o codigo e sem o "nao
        # escreveu o arquivo", o aviso dizia apenas "(soffice: )" — que nao
        # distingue "nao rodou" de "rodou e nao fez", e manda quem le procurar
        # no lugar errado.
        detalhe = (processo.stderr or b"").decode("utf-8", "replace").strip()[:300]
        codigo = getattr(processo, "returncode", "?")
        return ResultadoPdf(
            False,
            None,
            f"{AVISO_SEM_PDF} (o LibreOffice saiu com codigo {codigo} e nao "
            f"escreveu o PDF{'; ' + detalhe if detalhe else ''})",
        )
    if gerado != destino:
        gerado.replace(destino)
    return ResultadoPdf(True, destino, None)


def converter_fora_da_transacao(
    s: Session, docx: Path, saida: Path | None = None
) -> ResultadoPdf:
    """A UNICA forma de converter dentro de uma requisicao. Comita e so entao roda.

    **O defeito que ela existe para impedir.** Toda transacao deste sistema abre
    com `BEGIN IMMEDIATE` (RN-03, `app/banco.py`) e toma o lock de escrita ja na
    primeira instrucao — que, em requisicao autenticada, e o SELECT do cookie.
    A sessao so o solta no fim. Chamar `converter` no meio disso entrega o unico
    lock de escrita do banco ao `subprocess.run` do LibreOffice, que leva de 2 a
    8 s a frio. Medido nesta maquina, com a conversao de 6 s: da SEGUNDA pessoa
    em diante, todo mundo espera os 5 s de `busy_timeout` e recebe
    "database is locked" — que na tela vira 500, sem dizer por que.

    **Por que o commit mora AQUI e nao na linha de cima de quem chama.** Um
    `commit()` solto nao resolve, e isso ja custou uma versao: em `exportar_tudo`
    (1.22.2) o commit existia, mas entre ele e o `PRAGMA` havia SELECTs, e cada
    SELECT reabre a transacao com `BEGIN IMMEDIATE`. O lock voltava para a
    propria requisicao antes da operacao lenta, e a espera de 5,7 s continuava
    igual. Com o commit e a conversao na MESMA chamada, nao existe linha entre
    os dois onde alguem possa, meses depois, encaixar uma leitura inocente.

    **Sem LibreOffice nao ha o que soltar.** `converter` volta na hora, com o
    aviso; comitar ali seria mexer no contrato de transacao de quem chama sem
    ganhar nada. E o que mantem a suite e a maquina sem LibreOffice com o
    comportamento identico ao de antes desta funcao.

    Depois daqui a transacao esta FECHADA. Quem precisar gravar o resultado
    (o anexo do PDF do certificado, ou a linha de falha na trilha) abre uma
    transacao nova, curta, e comita — nao ha nada em aberto para carregar.
    """
    if not disponivel():
        return converter(docx, saida)
    s.commit()
    return converter(docx, saida)
