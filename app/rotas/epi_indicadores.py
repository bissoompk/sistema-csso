"""/epis e /epis/relatorios — o painel do módulo e os indicadores da §9.

Fatia 7 do desenho (`entrada/integrasst/desenho_epi.md`). São duas telas com
**permissões diferentes**, e a diferença não é acabamento:

- `/epis` é `epi.ver`. É a tela de trabalho de quem opera o módulo: quantos
  pedidos estão parados, o que falta comprar, qual CA vence, quantas entregas
  saíram, quais trocas venceram. Cada número leva à fila dele.
- `/epis/relatorios` é **`indicador.ver`**, como a §9 manda e como `/relatorios`
  já faz. Não é a mesma permissão da tela anterior porque não é a mesma leitura:
  o painel conta o trabalho do setor, o relatório recorta a população por
  unidade e por categoria da NR-6 — que é onde a reidentificação acontece por
  acidente, e por isso a supressão da RN-19 vale nele e o portão é o de quem
  responde por indicador.

**A supressão é a que o sistema já tem.** `suprimir` mora em
`app/rotas/relatorios.py` desde a fase de indicadores do Processos SEI, com
supressão primária (n<5) e secundária; é ela que este arquivo importa. O que
nasceu aqui foi `suprimir_aninhado`, e nasceu por necessidade: `/relatorios`
nunca publicou margem nenhuma (o contador ao lado da distribuição é `|length`, o
número de unidades, e não a soma), e a §9 pede o entregue **por unidade e por
campus** — o total do campus é, por definição, a margem das unidades dele.
Célula pequena com margem intacta se recupera por subtração de cabeça.
"""

from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import Response
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import Servidor
from app.modelos.estados import ROTULO_EPI_ITEM, ROTULO_EPI_REQUISICAO
from app.rotas.relatorios import (
    LIMIAR_SUPRESSAO,
    MARCA_SUPRIMIDO,
    suprimir,
    suprimir_aninhado,
)
from app.servicos import epi_indicadores as servico
from app.web import marcar_download, pagina

rotas = APIRouter(tags=["epis"])

PAINEL = "/epis"
RELATORIOS = "/epis/relatorios"
EXPORTAR = "/epis/relatorios/exportar"


def _servidores_de(s, registros) -> dict[int, Servidor]:
    """`{id: Servidor}` numa consulta, para o painel inteiro."""
    ids = {r.servidor_id for r in registros}
    if not ids:
        return {}
    return {
        sv.id: sv
        for sv in s.execute(select(Servidor).where(Servidor.id.in_(ids))).scalars()
    }


def _atrelar(celulas: servico.Celulas, visiveis: dict[str, str]) -> dict[str, str]:
    """A quantidade entregue, escondida onde a célula de servidores foi escondida.

    Publicar "— servidores · 12 pares" seria suprimir o número de pessoas e
    entregar, ao lado, um número que varia com elas: doze pares numa unidade de
    três pessoas continua dizendo que ali há pouca gente. A quantidade é
    informação do setor, não da pessoa — mas só depois que a célula sobreviveu.
    """
    return {
        rotulo: (
            str(celulas.quantidade.get(rotulo, 0))
            if visiveis.get(rotulo) != MARCA_SUPRIMIDO
            else MARCA_SUPRIMIDO
        )
        for rotulo in celulas.servidores
    }


# =====================================================================
# O painel do módulo
# =====================================================================
@rotas.get(PAINEL)
def painel(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """As cinco medidas do §9, cada uma com o caminho para a fila dela.

    **A fileira de filtros por estado continua na fila de `/epis/requisicoes`.**
    Ela nasceu ali na fatia 4 como substituta provisória do painel, mas o painel
    não a torna redundante: lá cada número **é** o filtro — clicar em "Em
    análise" recarrega a mesma tela já filtrada, sem trocar de contexto —, e aqui
    o mesmo número é uma das cinco medidas, ao lado das outras quatro. Tirá-la da
    fila custaria uma ida ao painel e uma volta para filtrar uma lista que já
    estava na tela; mantê-la custa uma consulta agregada que a fila já fazia.
    São duas leituras da mesma função (`resumo_de_estados`), e não dois números.
    """
    usuario.exigir("epi.ver")
    medidas = servico.painel(s)
    return pagina(
        request,
        "paginas/epis_painel.html",
        usuario=usuario,
        p=medidas,
        hoje=medidas.quando,
        rotulos=ROTULO_EPI_REQUISICAO,
        rotulos_item=ROTULO_EPI_ITEM,
        # As cinco MEDIDAS são `epi.ver`, como a §9 declara. As LINHAS de ficha
        # que estão embaixo de duas delas — quem recebeu o quê e quando — são
        # `epi.ficha` desde a fatia 2, porque são histórico sobre a segurança de
        # uma pessoa determinada. Publicá-las no painel sob `epi.ver` abriria
        # pela porta dos fundos o que `/epis/fichas` fecha na porta da frente, e
        # o painel não é lugar de afrouxar permissão de outra tela.
        ve_ficha=usuario.pode("epi.ficha"),
        # `identificar(...)` precisa do OBJETO: com o id sozinho ela cai no lado
        # seguro do erro e devolve o código opaco a todo mundo — inclusive ao
        # almoxarife, que tem `epi.ficha` e precisa saber a quem entregou.
        servidores=(
            _servidores_de(s, medidas.trocas_devidas + medidas.entregas_do_mes)
            if usuario.pode("epi.ficha")
            else {}
        ),
        pode_indicador=usuario.pode("indicador.ver"),
    )


# =====================================================================
# Os indicadores
# =====================================================================
def _contexto(s, usuario, exercicio: int | None):
    ano = exercicio or date.today().year
    dados = servico.relatorio(
        s, inicio=date(ano, 1, 1), fim=date(ano, 12, 31)
    )
    nominal = usuario.ve_dado_nominal
    por_categoria = suprimir(dados.por_categoria.servidores, nominal)
    return {
        "exercicio": ano,
        "dados": dados,
        "por_categoria": por_categoria,
        "quantidade_categoria": _atrelar(dados.por_categoria, por_categoria),
        "por_campus": suprimir_aninhado(dados.por_campus, nominal),
        "recusas_motivo": suprimir(dados.recusas_por_motivo, nominal),
        "recusas_unidade": suprimir(dados.recusas_por_unidade, nominal),
        "limiar": LIMIAR_SUPRESSAO,
        "suprime": not nominal,
    }


@rotas.get(RELATORIOS)
def relatorios(
    request: Request, s: SessaoDep, usuario: UsuarioDep, exercicio: int | None = None
):
    usuario.exigir("indicador.ver")
    return pagina(
        request,
        "paginas/epis_relatorios.html",
        usuario=usuario,
        pode_exportar=usuario.pode("exportar"),
        **_contexto(s, usuario, exercicio),
    )


@rotas.get(EXPORTAR)
def exportar(
    request: Request, s: SessaoDep, usuario: UsuarioDep, exercicio: int | None = None
):
    """O mesmo relatório em CSV, com a MESMA supressão.

    Duas exigências, e as duas importam: `indicador.ver` porque é o mesmo
    conteúdo da tela, e `exportar` porque planilha sai da máquina e a tela não.
    Exigir só a segunda deixaria a URL ser a porta dos fundos do relatório.

    O formato é o que o sistema já usa (`/relatorios/exportar-processos` e
    `/importar/reconciliacao.csv`): ponto e vírgula, UTF-8 com BOM. O BOM não é
    enfeite — sem ele o Excel em português abre "Odontologia" como "OdontolÃ³gia"
    e alguém conserta à mão, uma célula por vez.

    Uma linha por célula, com a dimensão na primeira coluna: o formato longo
    sobrevive a um filtro de tabela dinâmica, e a tabela larga com uma coluna por
    campus não sobrevive ao campus novo.
    """
    usuario.exigir("indicador.ver")
    usuario.exigir("exportar")
    ctx = _contexto(s, usuario, exercicio)
    dados = ctx["dados"]

    buffer = io.StringIO(newline="")
    escritor = csv.writer(buffer, delimiter=";")
    escritor.writerow(
        ["Indicador", "Recorte", "Detalhe", "Servidores", "Quantidade"]
    )
    for rotulo, valor in ctx["por_categoria"].items():
        escritor.writerow(
            [
                "Entregue por categoria (NR-6)",
                rotulo,
                "",
                valor,
                ctx["quantidade_categoria"].get(rotulo, ""),
            ]
        )
    for linha in ctx["por_campus"]:
        escritor.writerow(
            ["Entregue por campus", linha.rotulo, "", linha.valor, ""]
        )
        for unidade, valor in linha.folhas:
            escritor.writerow(
                ["Entregue por unidade", linha.rotulo, unidade, valor, ""]
            )
    for linha in dados.empenhos:
        escritor.writerow(
            [
                "Custo por empenho",
                linha.empenho,
                "piso (há lote sem valor)" if linha.incompleto else "",
                "",
                f"{linha.custo:.2f}" if linha.custo is not None else "",
            ]
        )
    for rotulo, valor in ctx["recusas_motivo"].items():
        escritor.writerow(["Recusas por motivo (RN-27)", rotulo, "", valor, ""])
    for rotulo, valor in ctx["recusas_unidade"].items():
        escritor.writerow(["Recusas por unidade (RN-27)", rotulo, "", valor, ""])

    # o cabeçalho da supressão vai DENTRO do arquivo: o CSV se descola da tela no
    # primeiro anexo de e-mail, e quem o receber precisa saber por que há traço
    # onde deveria haver número
    if ctx["suprime"]:
        escritor.writerow([])
        escritor.writerow(
            [
                "Nota",
                f"Célula com menos de {LIMIAR_SUPRESSAO} servidores sai como "
                f"'{MARCA_SUPRIMIDO}' (RN-19). Quando só uma seria suprimida, a "
                "menor sobrevivente vai junto, e o total do campus some com as "
                "unidades dele — senão a subtração devolveria o número escondido.",
                "",
                "",
                "",
            ]
        )
    nome = f"epi-indicadores-{ctx['exercicio']}.csv"
    return marcar_download(
        Response(
            b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{nome}"'},
        ),
        request,
    )
