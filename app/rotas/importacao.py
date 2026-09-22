"""/importar - carga da planilha e do JSON do Trello, com pre-visualizacao."""

from __future__ import annotations

import csv
import io
from pathlib import Path

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import select

from app.config import obter_config
from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import MigracaoRejeitada, StgTrelloCartao
from app.servicos import (
    importacao_planilha,
    importacao_trello,
    reconciliacao as servico_reconciliacao,
)
from app.servicos.numeracao import recontar_sequencia
from app.web import marcar_download, pagina

rotas = APIRouter(tags=["importacao"])


@rotas.get("/importar")
def tela(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("catalogo.gerenciar")
    cfg = obter_config()
    return pagina(
        request,
        "paginas/importar.html",
        usuario=usuario,
        entrada=[
            p.name
            for p in sorted(cfg.caminho(cfg.dir_entrada).glob("*"))
            if p.suffix.lower() in (".xlsx", ".json")
        ],
        rejeitadas=list(
            s.execute(select(MigracaoRejeitada).order_by(MigracaoRejeitada.id.desc()).limit(100)).scalars()
        ),
        candidatos=list(
            s.execute(
                select(StgTrelloCartao).where(StgTrelloCartao.parecer_candidato.isnot(None))
            ).scalars()
        ),
    )


@rotas.get("/importar/reconciliacao")
def reconciliacao(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """Os cinco relatórios da Fase 4 — expõem, nunca resolvem sozinhos."""
    usuario.exigir("catalogo.gerenciar")
    resultado = servico_reconciliacao.reconciliar(s)
    return pagina(
        request,
        "paginas/reconciliacao.html",
        usuario=usuario,
        reconciliacao=resultado,
        rejeitadas=servico_reconciliacao.rejeitadas(s),
    )


@rotas.get("/importar/reconciliacao.csv")
def reconciliacao_csv(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("exportar")
    resultado = servico_reconciliacao.reconciliar(s)
    buffer = io.StringIO(newline="")
    escritor = csv.writer(buffer, delimiter=";")
    escritor.writerow(["Relatório", "Referência", "Detalhe"])
    for titulo, _descricao, achados in resultado.como_secoes():
        for achado in achados:
            escritor.writerow([titulo, achado.referencia, achado.detalhe])
    return marcar_download(
        Response(
            b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="reconciliacao.csv"'},
        ),
        request,
    )


@rotas.post("/importar/planilha")
async def importar_planilha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    arquivo: UploadFile = File(...),
    aplicar: str = Form(""),
):
    usuario.exigir("catalogo.gerenciar")
    cfg = obter_config()
    destino = cfg.caminho(cfg.dir_entrada) / (arquivo.filename or "planilha.xlsx")
    destino.write_bytes(await arquivo.read())

    relatorio = importacao_planilha.importar(s, destino, usuario, aplicar == "1")
    if aplicar == "1":
        recontar_sequencia(s)
        s.commit()
    else:
        s.rollback()
    return pagina(
        request,
        "paginas/importar_relatorio.html",
        usuario=usuario,
        relatorio=relatorio,
        aplicado=aplicar == "1",
        origem="planilha",
    )


@rotas.post("/importar/trello")
async def importar_trello(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    arquivo: UploadFile = File(...),
    aplicar: str = Form(""),
    baixar_anexos: str = Form(""),
):
    usuario.exigir("catalogo.gerenciar")
    cfg = obter_config()
    destino = cfg.caminho(cfg.dir_entrada) / (arquivo.filename or "trello.json")
    destino.write_bytes(await arquivo.read())

    relatorio = importacao_trello.importar(
        s,
        Path(destino),
        usuario,
        aplicar == "1",
        # sem marcar, nada e baixado: os anexos entram no relatorio de perdidos
        buscar_anexo=importacao_trello.baixar_url if baixar_anexos == "1" else None,
    )
    if aplicar == "1":
        s.commit()
    else:
        s.rollback()
    return pagina(
        request,
        "paginas/importar_relatorio_trello.html",
        usuario=usuario,
        relatorio=relatorio,
        aplicado=aplicar == "1",
    )
