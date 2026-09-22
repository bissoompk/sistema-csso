"""Backup cifrado (VACUUM INTO + AES-256) e exportacao completa.

Criterio do EXPORTAR-TUDO: "desligue o sistema para sempre; com este zip o setor
trabalha amanha."

O destino do backup vem do .env. Nuvem pessoal e PROIBIDA (LGPD arts. 33-36, 39
e 46) - o sistema recusa destinos obviamente sincronizados.
"""

from __future__ import annotations

import csv
import io
import os
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.banco import obter_engine
from app.config import obter_config
from app.modelos import (
    LaudoTecnico,
    ParecerTecnico,
    Processo,
    Servidor,
    StgPlanilhaParecer,
)

MAGICO = b"CSSOBK01"
ITERACOES = 390_000

# O envelope cifrado nao mudou (MAGICO + sal + nonce + AES-256-GCM); o que mudou
# foi o RECHEIO. Ate a 1.30.0 o recheio era o `.db` cru, e por isso restaurar
# devolvia a ficha de EPI sem o comprovante assinado e o parecer sem o PDF: o
# banco trazia o `sha256` e o caminho, e o arquivo apontado nao existia. Metade
# que nao prova nada — a ficha existe para ser prova de entrega em fiscalizacao,
# e a assinatura do servidor esta no arquivo, nao na linha.
#
# Agora o recheio e um zip com o banco mais `dados/anexos` e `dados/documentos`.
# O `.enc` antigo continua restaurando: `restaurar` olha os primeiros bytes do
# conteudo decifrado e reconhece os dois formatos.
ZIP_MAGICO = b"PK\x03\x04"
NOME_BANCO_NO_PACOTE = "csso.db"

# Custo medido em 24/08/2026, nesta maquina: `dados/anexos` 16 arquivos / 239 B
# e `dados/documentos` 9 arquivos / 357.639 B — 25 arquivos, 349 KB somados,
# contra 816 KB de banco depois do VACUUM. O `.enc` nao cresceu: caiu de 835.636
# para 381.217 bytes, porque o recheio agora e um zip deflacionado e antes era o
# `.db` cru. Levar os anexos ficou mais barato que nao levar.
#
# Hoje e barato; a conta que importa e a de amanha, porque anexo so cresce: cada
# comprovante assinado e um PDF digitalizado, e a guarda dele e PERMANENTE
# (POLITICA_RETENCAO §2.3) — e PDF digitalizado nao deflaciona. Se um dia a
# pasta passar a ordem de grandeza do banco, a rotacao de 90 dias
# (POLITICA_RETENCAO §4) e que precisa ser revista — nao a inclusao do anexo,
# porque backup sem o anexo nao e backup deste sistema.
#
# O pacote inteiro passa pela memoria: `AESGCM.encrypt` e de uma tacada so, e ja
# era assim quando o recheio era o banco sozinho. E o teto que chega primeiro se
# a pasta crescer — e o sinal de que a cifra precisaria virar por blocos.
PASTAS_DO_PACOTE = ("documentos", "anexos")

NUVENS_PROIBIDAS = ("onedrive", "dropbox", "google drive", "\\meu drive", "icloud")

# CA-14: as 24 colunas rotuladas (A-X) na ordem e com os rotulos originais
CABECALHO_PLANILHA = [
    "Data da Solicitação no SEST",
    "Nº do Parecer",
    "Nome do Servidor",
    "Ano",
    "Data",
    "Laudo de ",
    "Unidade",
    "Posto de Trabalho",
    "UORG",
    "Tipo de Laudo",
    "Nº do Processo",
    "Matricula",
    "Cargo",
    "Função",
    "Laudo SIAPE",
    "Agente nocivo à saúde",
    "Tipo de Risco",
    "Percentual Aplicável",
    "Portaria de Localização",
    "Fundamentação Legal",
    "Alteração",
    "Recomendação Técnica:",
    "Reavaliação",
    "Pró Reitor",
]

LEIA_ME_EXPORT = """CONTEÚDO DESTE PACOTE
=====================
Pareceres.xlsx  — a planilha nas 24 colunas originais (A–X) + col_Y_sem_cabecalho
csv/            — CSVs UTF-8 com BOM e separador ';' (abrem direto no Excel pt-BR)
csso.db         — o banco SQLite completo
documentos/     — os .docx e .pdf gerados pelo sistema
anexos/         — todos os arquivos anexados, nomeados pelo SHA-256

ATENÇÃO — DADOS PESSOAIS DE SERVIDORES (LGPD arts. 33-36, 39 e 46)
Este pacote contém dados pessoais. NÃO o coloque em nuvem pessoal ou de
terceiros. Qualquer destino em nuvem exige autorização formal da UFVJM e
contrato de operador.

O processo oficial é o SEI. Este sistema é apoio da CSSO.
"""


class DestinoProibido(ValueError):
    pass


@dataclass
class ResultadoBackup:
    arquivo: Path
    tamanho: int
    cifrado: bool
    # Quantos arquivos de `dados/anexos` e `dados/documentos` entraram. Sai na
    # tela e na trilha porque "backup feito" sem este numero e a afirmacao que
    # escondeu o defeito por doze versoes: o backup rodava, dizia que rodou, e
    # nao levava a prova.
    arquivos: int = 0


def _conferir_destino(destino: Path) -> None:
    alvo = str(destino).lower()
    for nuvem in NUVENS_PROIBIDAS:
        if nuvem in alvo:
            raise DestinoProibido(
                f"Destino em nuvem sincronizada ({nuvem}). Backup contém dados "
                "pessoais de servidores: use disco local ou rede institucional "
                "(LGPD arts. 33-36, 39 e 46)."
            )


def _chave(senha: str, sal: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=sal, iterations=ITERACOES)
    return kdf.derive(senha.encode("utf-8"))


def cifrar(conteudo: bytes, senha: str) -> bytes:
    sal = os.urandom(16)
    nonce = os.urandom(12)
    dados = AESGCM(_chave(senha, sal)).encrypt(nonce, conteudo, MAGICO)
    return MAGICO + sal + nonce + dados


def decifrar(pacote: bytes, senha: str) -> bytes:
    if not pacote.startswith(MAGICO):
        raise ValueError("arquivo não é um backup do sistema CSSO")
    sal, nonce, dados = pacote[8:24], pacote[24:36], pacote[36:]
    return AESGCM(_chave(senha, sal)).decrypt(nonce, dados, MAGICO)


def _carimbo() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def _pastas_de_arquivos(cfg) -> list[tuple[str, Path]]:
    return [
        ("documentos", cfg.caminho(cfg.dir_documentos)),
        ("anexos", cfg.caminho(cfg.dir_anexos)),
    ]


def _empacotar(banco: bytes, cfg) -> tuple[bytes, int]:
    """Zip com o banco na raiz e os arquivos em `anexos/` e `documentos/`."""
    buffer = io.BytesIO()
    incluidos = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_:
        zip_.writestr(NOME_BANCO_NO_PACOTE, banco)
        for rotulo, origem in _pastas_de_arquivos(cfg):
            if not origem.exists():
                continue
            for arquivo in sorted(origem.rglob("*")):
                if arquivo.is_file():
                    zip_.write(
                        arquivo, f"{rotulo}/{arquivo.relative_to(origem).as_posix()}"
                    )
                    incluidos += 1
    return buffer.getvalue(), incluidos


def fazer_backup(destino: Path | None = None, senha: str | None = None) -> ResultadoBackup:
    """VACUUM INTO (consistente com WAL) + anexos e documentos, tudo cifrado."""
    cfg = obter_config()
    pasta = destino or cfg.caminho(cfg.backup_destino)
    _conferir_destino(pasta)
    pasta.mkdir(parents=True, exist_ok=True)

    bruto = pasta / f"csso-{_carimbo()}.db"
    # VACUUM nao roda dentro de transacao - e o engine abre BEGIN IMMEDIATE por
    # padrao (RN-03). Por isso a conexao aqui e explicitamente AUTOCOMMIT.
    with obter_engine().connect().execution_options(isolation_level="AUTOCOMMIT") as con:
        con.exec_driver_sql(f"VACUUM INTO '{bruto.as_posix()}'")

    conteudo = bruto.read_bytes()
    bruto.unlink()
    # A copia crua do banco vive o tempo do VACUUM e some antes de a cifra
    # comecar; o zip so existe em memoria. Nao ha instante em que dado pessoal em
    # claro fique no destino do backup — que e, em producao, a rede institucional.
    pacote, incluidos = _empacotar(conteudo, cfg)
    cifrado = pasta / (bruto.name + ".enc")
    cifrado.write_bytes(cifrar(pacote, senha or cfg.backup_senha))
    return ResultadoBackup(cifrado, cifrado.stat().st_size, True, incluidos)


def _destino_seguro(base: Path, nome: str) -> Path:
    """Recusa nome de entrada que escape da pasta de destino.

    O pacote e autenticado pelo AES-GCM, entao forjar um caminho `../..` exige a
    senha do backup — mas restaurar e o gesto que se faz as pressas, num dia
    ruim, e uma linha de defesa que custa quatro nao se dispensa.
    """
    alvo = (base / nome).resolve()
    if base.resolve() not in alvo.parents:
        raise ValueError(f"caminho fora do destino no pacote de backup: {nome}")
    return alvo


def restaurar(
    arquivo: Path,
    destino: Path,
    senha: str | None = None,
    pasta_arquivos: Path | None = None,
) -> Path:
    """Devolve o banco E os arquivos apontados por ele.

    `pasta_arquivos` (padrao: a pasta do banco restaurado) recebe `anexos/` e
    `documentos/`. O padrao NAO e `dados/` de proposito: restaurar e feito para
    conferir antes de trocar, e sobrescrever a pasta viva por reflexo seria a
    perda que a restauracao existe para evitar.
    """
    cfg = obter_config()
    conteudo = decifrar(Path(arquivo).read_bytes(), senha or cfg.backup_senha)
    destino.parent.mkdir(parents=True, exist_ok=True)

    if not conteudo.startswith(ZIP_MAGICO):
        # Backup ate a 1.30.0: o recheio e o `.db` cru, sem anexo nenhum.
        destino.write_bytes(conteudo)
        return destino

    base = pasta_arquivos or destino.parent
    with zipfile.ZipFile(io.BytesIO(conteudo)) as zip_:
        destino.write_bytes(zip_.read(NOME_BANCO_NO_PACOTE))
        for nome in zip_.namelist():
            if nome == NOME_BANCO_NO_PACOTE or nome.endswith("/"):
                continue
            if nome.split("/", 1)[0] not in PASTAS_DO_PACOTE:
                continue
            alvo = _destino_seguro(base, nome)
            alvo.parent.mkdir(parents=True, exist_ok=True)
            alvo.write_bytes(zip_.read(nome))
    return destino


# ---------------------------------------------------------------------
# Exportacao completa
# ---------------------------------------------------------------------
def _linhas_planilha(s: Session) -> list[list[str]]:
    linhas: list[list[str]] = []
    pareceres = s.execute(
        select(ParecerTecnico).order_by(ParecerTecnico.ano, ParecerTecnico.numero)
    ).scalars()
    for p in pareceres:
        principal = next((e for e in p.exposicoes if e.principal), None)
        postos = " / ".join(
            pp.posto.nome for pp in sorted(p.postos, key=lambda x: x.ordem)
        )
        orfa = s.execute(
            select(StgPlanilhaParecer.col_Y_sem_cabecalho).where(
                StgPlanilhaParecer.arquivo.isnot(None),
                StgPlanilhaParecer.col_b_numero_parecer == str(p.numero),
                StgPlanilhaParecer.col_d_ano == str(p.ano),
            )
        ).scalars().first()
        linhas.append(
            [
                p.processo.data_solicitacao_sest.isoformat()
                if p.processo and p.processo.data_solicitacao_sest
                else "",
                str(p.numero),
                p.servidor.nome if p.servidor else "",
                str(p.ano),
                p.data_emissao.isoformat() if p.data_emissao else "",
                p.tipo_movimento.nome if p.tipo_movimento else "",
                p.unidade.nome_extenso if p.unidade else "",
                postos,
                p.unidade.uorg_bruto if p.unidade else "",
                p.tipo_adicional.nome if p.tipo_adicional else "",
                p.processo.nup if p.processo else "",
                p.servidor.siape if p.servidor else "",
                p.cargo_snapshot or (p.servidor.cargo.nome if p.servidor and p.servidor.cargo else ""),
                p.funcao_snapshot or "",
                p.laudo.numero_siape if p.laudo else "",
                principal.agente_nocivo.descricao if principal else "",
                principal.agente_nocivo.tipo_risco.nome if principal else "",
                principal.percentual.rotulo if principal else "",
                p.portaria.texto_original if p.portaria else "",
                principal.fundamentacao.texto if principal else "",
                p.texto_alteracao or "",
                p.texto_recomendacao or "",
                p.texto_reavaliacao or "",
                p.destinatario.nome if p.destinatario else "",
                orfa or "",
            ]
        )
    return linhas


def _csv_bytes(cabecalho: list[str], linhas: list[list[str]]) -> bytes:
    buffer = io.StringIO(newline="")
    escritor = csv.writer(buffer, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    escritor.writerow(cabecalho)
    escritor.writerows(linhas)
    # UTF-8 COM BOM: e o que faz o Excel pt-BR abrir acentuado corretamente
    return b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8")


def _planilha_bytes(linhas: list[list[str]]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Planilha1"
    ws.append([*CABECALHO_PLANILHA, "col_Y_sem_cabecalho"])
    for linha in linhas:
        ws.append(linha)
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def exportar_tudo(s: Session, destino: Path | None = None) -> Path:
    cfg = obter_config()
    pasta = destino or cfg.caminho(cfg.backup_destino)
    _conferir_destino(pasta)
    pasta.mkdir(parents=True, exist_ok=True)
    alvo = pasta / f"csso-export-{_carimbo()}.zip"

    linhas = _linhas_planilha(s)
    # solta a transacao antes de tirar a copia consistente do banco
    s.commit()

    with zipfile.ZipFile(alvo, "w", zipfile.ZIP_DEFLATED) as zip_:
        zip_.writestr("LEIA-ME-DO-EXPORT.txt", LEIA_ME_EXPORT)
        zip_.writestr("Pareceres.xlsx", _planilha_bytes(linhas))
        zip_.writestr(
            "csv/pareceres.csv",
            _csv_bytes([*CABECALHO_PLANILHA, "col_Y_sem_cabecalho"], linhas),
        )
        zip_.writestr(
            "csv/processos.csv",
            _csv_bytes(
                ["NUP", "Estado", "Situação", "Servidor", "SIAPE", "Unidade", "Autuação"],
                [
                    [
                        p.nup,
                        p.estado_tecnico,
                        p.situacao,
                        p.servidor.nome if p.servidor else "",
                        p.servidor.siape if p.servidor else "",
                        p.unidade.nome_extenso if p.unidade else "",
                        p.data_autuacao.isoformat() if p.data_autuacao else "",
                    ]
                    for p in s.execute(select(Processo).order_by(Processo.nup)).scalars()
                ],
            ),
        )
        zip_.writestr(
            "csv/laudos.csv",
            _csv_bytes(
                ["Nº SIAPE", "Unidade", "Subscritor", "Emissão", "Última conferência", "Status"],
                [
                    [
                        l.numero_siape,
                        l.unidade.nome_extenso if l.unidade else "",
                        l.subscritor.nome if l.subscritor else "",
                        l.data_emissao.isoformat() if l.data_emissao else "",
                        l.data_ultima_conferencia.isoformat()
                        if l.data_ultima_conferencia
                        else "",
                        l.status,
                    ]
                    for l in s.execute(
                        select(LaudoTecnico).order_by(LaudoTecnico.numero_siape)
                    ).scalars()
                ],
            ),
        )
        zip_.writestr(
            "csv/servidores.csv",
            _csv_bytes(
                ["SIAPE", "Nome", "Cargo", "Unidade", "Situação"],
                [
                    [
                        sv.siape,
                        sv.nome,
                        sv.cargo.nome if sv.cargo else "",
                        sv.unidade.nome_extenso if sv.unidade else "",
                        sv.situacao,
                    ]
                    for sv in s.execute(select(Servidor).order_by(Servidor.nome)).scalars()
                ],
            ),
        )

        # Copia consistente do banco. O `VACUUM INTO` le o banco LOGICO — WAL
        # incluido —, entao a copia ja sai com tudo o que foi commitado, tenha
        # ou nao passado para o `.db` principal. E o mesmo caminho do
        # `fazer_backup`, o do CA-13, que restaura e regera o parecer de ouro.
        #
        # Aqui havia um `PRAGMA wal_checkpoint(TRUNCATE)` antes do VACUUM. Ele
        # nao ajudava e custava caro: `exportar_tudo` roda com a sessao do
        # chamador aberta — os SELECTs de processos, laudos e servidores acima
        # reabrem a transacao, e toda transacao nasce com BEGIN IMMEDIATE
        # (RN-03, `banco.py`). O checkpoint precisa de exclusividade, batia no
        # lock da propria requisicao e esperava o `busy_timeout` inteiro:
        # medidos 5,664 s contra 0,001 s sem a sessao, devolvendo (1, ...) —
        # SQLITE_BUSY, ou seja, esperava quase seis segundos para NAO fazer o
        # checkpoint. Ninguem lia esse retorno. A conexao segue AUTOCOMMIT
        # porque VACUUM nao roda dentro de transacao.
        copia = pasta / f".csso-export-{_carimbo()}.db"
        with obter_engine().connect().execution_options(
            isolation_level="AUTOCOMMIT"
        ) as con:
            con.exec_driver_sql(f"VACUUM INTO '{copia.as_posix()}'")
        zip_.write(copia, "csso.db")
        copia.unlink(missing_ok=True)

        for rotulo, pasta_origem in _pastas_de_arquivos(cfg):
            if not pasta_origem.exists():
                continue
            for arquivo in pasta_origem.rglob("*"):
                if arquivo.is_file():
                    zip_.write(arquivo, f"{rotulo}/{arquivo.relative_to(pasta_origem).as_posix()}")

    return alvo
