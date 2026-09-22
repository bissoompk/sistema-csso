"""/relatorios - indicadores, lacunas de numeracao e fila de conferencia.

RN-19: toda visao agregada aplica supressao de celula n<5 e supressao
secundaria; recorte com menos de 5 servidores exige `exposicao.ver`.
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import Response
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AdicionalVigencia,
    LaudoTecnico,
    ParecerTecnico,
    Processo,
    UnidadeUorg,
)
from app.repositorios import processos as repo
from app.servicos import datas_br
from app.servicos.numeracao import lacunas_de_numeracao
from app.web import marcar_download, pagina

rotas = APIRouter(tags=["relatorios"])

LIMIAR_SUPRESSAO = 5
MARCA_SUPRIMIDO = "—"
RODAPE_FILA_LAUDOS = (
    "o laudo não tem prazo de validade (IN 15/2022, art. 10, §3º); esta lista é "
    "apenas fila de trabalho, não vencimento."
)


def _primarias(contagens: dict[str, int]) -> set[str]:
    return {k for k, v in contagens.items() if v < LIMIAR_SUPRESSAO}


def _com_secundaria(contagens: dict[str, int], marcadas: set[str]) -> set[str]:
    """Nunca deixa sobrar UMA celula suprimida sozinha numa distribuicao.

    Com uma so escondida, quem tiver o total da distribuicao a recupera por
    subtracao. Com duas, a subtracao devolve a SOMA das duas, que nao nomeia
    ninguem. E o unico motivo de a supressao secundaria existir.

    Vive separada de `suprimir` porque a regra e a mesma nas margens (ver
    `suprimir_aninhado`), e duas copias dela divergiriam na primeira correcao.
    """
    if len(marcadas) != 1:
        return marcadas
    sobreviventes = [k for k in contagens if k not in marcadas]
    if not sobreviventes:
        return marcadas
    return marcadas | {min(sobreviventes, key=lambda k: contagens[k])}


def _formatar(contagens: dict[str, int], marcadas: set[str]) -> dict[str, str]:
    return {
        k: (MARCA_SUPRIMIDO if k in marcadas else str(v))
        for k, v in contagens.items()
    }


def suprimir(contagens: dict[str, int], pode_ver: bool) -> dict[str, str]:
    """Supressao primaria (n<5) + secundaria (esconde a menor sobrevivente
    quando so uma celula foi suprimida, senao a diferenca a revela)."""
    if pode_ver:
        return {k: str(v) for k, v in contagens.items()}
    return _formatar(contagens, _com_secundaria(contagens, _primarias(contagens)))


@dataclass(frozen=True)
class LinhaAninhada:
    """Um grupo e as celulas dele, ja suprimidos de forma consistente."""

    rotulo: str
    valor: str
    folhas: tuple[tuple[str, str], ...]

    @property
    def suprimido(self) -> bool:
        return self.valor == MARCA_SUPRIMIDO


def suprimir_aninhado(
    grupos: dict[str, dict[str, int]], pode_ver: bool
) -> list[LinhaAninhada]:
    """Distribuicao com margem: o total do grupo E a margem das celulas dele.

    **Por que `suprimir` sozinha nao basta aqui.** Ela trata uma distribuicao
    isolada e assume que nenhum total e publicado ao lado — e e por isso que
    `/relatorios` funciona: o contador que aparece la e `|length`, o numero de
    unidades, e nao a soma. Publicar "Campus JK: 12" ao lado de "IECT: 9 · ICA:
    —" devolve a celula escondida por uma subtracao de cabeca. Somar celula
    pequena e margem intacta e a forma mais comum de reidentificacao acidental
    em indicador, e a mais facil de nao ver: cada tabela, olhada sozinha, parece
    certa.

    Tres regras, e cada uma fecha uma das portas:

    1. **Secundaria DENTRO do grupo.** Se uma unidade do campus foi suprimida, a
       menor sobrevivente do MESMO campus vai junto — senao o total do campus
       menos as visiveis devolve exatamente a escondida. Aplicar a secundaria so
       no conjunto global deixaria essa porta aberta, porque as duas suprimidas
       podiam estar em campi diferentes.
    2. **Total suprimido nao convive com folha visivel.** Se o total do campus
       sumiu, somar as unidades dele o devolveria — entao elas somem juntas.
    3. **Nunca UM total sozinho.** Vale a mesma logica da secundaria, um nivel
       acima: com um unico campus escondido, o grand total (que outra tabela do
       mesmo relatorio pode entregar, quando nenhuma celula dela e suprimida) o
       devolve. A vitima escolhida leva as folhas dela junto, pela regra 2.

    O que isto **nao** resolve, e fica dito: duas tabelas do mesmo relatorio
    particionam a mesma populacao, entao a soma de uma e margem da outra. Com a
    secundaria valendo, o que se recupera dai e a SOMA de duas celulas
    suprimidas, nunca uma; o caso em que sobra uma so e o da distribuicao de
    celula unica, em que nao ha o que suprimir sem apagar a tabela inteira.
    """
    totais = {rotulo: sum(folhas.values()) for rotulo, folhas in grupos.items()}
    if pode_ver:
        return [
            LinhaAninhada(
                rotulo=rotulo,
                valor=str(totais[rotulo]),
                folhas=tuple((k, str(v)) for k, v in grupos[rotulo].items()),
            )
            for rotulo in grupos
        ]

    marcadas: dict[str, set[str]] = {
        rotulo: _com_secundaria(folhas, _primarias(folhas))
        for rotulo, folhas in grupos.items()
    }
    # grupo de folha unica: o total E a folha, entao esconder so a folha nao
    # esconde nada
    marcados_grupo = _primarias(totais) | {
        rotulo for rotulo, m in marcadas.items() if len(m) == 1
    }
    marcados_grupo = _com_secundaria(totais, marcados_grupo)
    for rotulo in marcados_grupo:
        marcadas[rotulo] = set(grupos[rotulo])

    formatados = _formatar(totais, marcados_grupo)
    return [
        LinhaAninhada(
            rotulo=rotulo,
            valor=formatados[rotulo],
            folhas=tuple(_formatar(grupos[rotulo], marcadas[rotulo]).items()),
        )
        for rotulo in grupos
    ]


@rotas.get("/relatorios")
def indice(request: Request, s: SessaoDep, usuario: UsuarioDep, exercicio: int | None = None):
    usuario.exigir("indicador.ver")
    ano = exercicio or date.today().year

    por_unidade: dict[str, int] = defaultdict(int)
    for processo in s.execute(select(Processo)).scalars():
        nome = processo.unidade.nome_extenso if processo.unidade else "(sem unidade)"
        por_unidade[nome] += 1

    por_risco: dict[str, int] = defaultdict(int)
    for parecer in s.execute(select(ParecerTecnico)).scalars():
        principal = next((e for e in parecer.exposicoes if e.principal), None)
        if principal:
            por_risco[principal.agente_nocivo.tipo_risco.nome] += 1

    lacunas = {
        a: lacunas_de_numeracao(s, a)
        for a in sorted(
            {n for (n,) in s.execute(select(ParecerTecnico.ano).distinct()).all()}
        )
    }

    laudos_fila = [
        (
            laudo,
            datas_br.meses_entre(laudo.data_ultima_conferencia, date.today())
            if laudo.data_ultima_conferencia
            else None,
        )
        for laudo in s.execute(
            select(LaudoTecnico).where(LaudoTecnico.status == "VIGENTE")
        ).scalars()
        if laudo.data_ultima_conferencia is None
        or datas_br.meses_entre(laudo.data_ultima_conferencia, date.today()) > 24
    ]

    vigencias_por_laudo: dict[str, int] = defaultdict(int)
    for vigencia in s.execute(
        select(AdicionalVigencia).where(AdicionalVigencia.estado == "VIGENTE")
    ).scalars():
        laudo = vigencia.parecer.laudo if vigencia.parecer else None
        vigencias_por_laudo[laudo.numero_siape if laudo else "(sem laudo)"] += 1

    return pagina(
        request,
        "paginas/relatorios.html",
        usuario=usuario,
        exercicio=ano,
        por_unidade=suprimir(dict(por_unidade), usuario.ve_dado_nominal),
        por_risco=suprimir(dict(por_risco), usuario.ve_dado_nominal),
        lacunas=lacunas,
        laudos_fila=laudos_fila,
        vigencias_por_laudo=dict(vigencias_por_laudo),
        rodape_fila=RODAPE_FILA_LAUDOS,
        limiar=LIMIAR_SUPRESSAO,
    )


@rotas.get("/relatorios/exportar-processos")
def exportar_processos(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("exportar")
    filtro = repo.Filtro(
        q=request.query_params.get("q") or None,
        estado=request.query_params.get("estado") or None,
        por_pagina=100000,
    )
    itens, _ = repo.listar(s, usuario, filtro)

    buffer = io.StringIO(newline="")
    escritor = csv.writer(buffer, delimiter=";")
    escritor.writerow(
        ["NUP", "Estado", "Servidor", "SIAPE", "Unidade", "Responsável", "Autuação", "Prazo"]
    )
    for p in itens:
        nominal = usuario.ve_dado_nominal
        escritor.writerow(
            [
                p.nup,
                p.estado_tecnico,
                (p.servidor.nome if p.servidor else "") if nominal else MARCA_SUPRIMIDO,
                (p.servidor.siape if p.servidor else "") if nominal else MARCA_SUPRIMIDO,
                p.unidade.nome_extenso if p.unidade else "",
                p.responsavel.nome if p.responsavel else "",
                p.data_autuacao.isoformat() if p.data_autuacao else "",
                p.prazo.isoformat() if p.prazo else "",
            ]
        )
    conteudo = b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8")
    return marcar_download(Response(
        conteudo,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="processos.csv"'},
    ), request)


_ = UnidadeUorg
