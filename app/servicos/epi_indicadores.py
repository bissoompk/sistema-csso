"""Os números do módulo de EPI: o painel de `/epis` e os indicadores da §9.

Fatia 7 do desenho (`entrada/integrasst/desenho_epi.md`). Aqui não nasce fato
nenhum: tudo o que este arquivo faz é **ler** o que as fatias 1 a 6 gravaram e
somar. Por isso não há `usuario.exigir` em função nenhuma — a permissão é da
rota, que é quem sabe se a tela é `epi.ver` (o painel) ou `indicador.ver` (o
relatório).

Duas decisões governam o arquivo inteiro, e as duas são sobre reidentificação:

1. **A célula conta SERVIDORES DISTINTOS, nunca unidades entregues.** É a
   diferença entre um indicador e um dossiê. "12 pares de luva na Odontologia"
   passa por qualquer limiar e pode ser uma pessoa só — a mesma pessoa, cruzada
   com a categoria da NR-6 e com o mês, fica nomeada sem que o nome apareça. O
   limiar de cinco da RN-19 é sobre **gente**, então a contagem tem de ser sobre
   gente. A quantidade entregue continua na tela, mas atrelada à célula: onde a
   célula é suprimida, ela some junto.
2. **Campus e unidade saem da MESMA leitura.** A ficha congela
   `unidade_snapshot` como texto, para sair impresso no comprovante, e casar
   campus por esse texto seria a busca frágil que o §6.2 recusa. Aqui os dois
   níveis vêm da lotação **na data da entrega** — a mesma fonte de que o
   snapshot nasceu (`epi_ficha._posto_e_unidade`) —, e é isso que faz o total do
   campus ser de fato a soma das unidades dele. Se os dois níveis viessem de
   fontes diferentes, a supressão de margem de `suprimir_aninhado` estaria
   protegendo uma hierarquia que não existe.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    EpiEntradaEstoque,
    EpiFichaRegistro,
    HistoricoEvento,
    Servidor,
)
from app.modelos.estados import EPI_REQUISICAO_ENCERRADA
from app.servicos import datas_br, epi_estoque, epi_ficha, epi_requisicao
from app.servicos import servidores as servico_servidores

SEM_UNIDADE = "(sem unidade)"
SEM_CAMPUS = "(sem campus)"
SEM_EMPENHO = "(sem empenho)"

# Os dois eventos que registram uma negativa de EPI, e é preciso somar os dois.
# `EPI_ITEM_RECUSADO` é a recusa de item de requisição (fatia 4);
# `EPI_ENTREGA_RECUSADA` é a recusa de balcão (fatia 2), que existe justamente
# para o caso da decisão 3 — pedido de terceirizado, que não vira requisição
# porque quem não é servidor não está no cadastro. Contar só o primeiro deixaria
# de fora exatamente a recusa que a RN-27 quer contável.
EVENTOS_DE_RECUSA = (
    epi_requisicao.EPI_ITEM_RECUSADO,
    epi_ficha.EPI_ENTREGA_RECUSADA,
)


# =====================================================================
# O painel de `/epis`
# =====================================================================
@dataclass(frozen=True)
class LoteAVencer:
    entrada: EpiEntradaEstoque
    saldo: int
    dias: int

    @property
    def vencido(self) -> bool:
        return self.dias < 0


@dataclass(frozen=True)
class Painel:
    """As cinco medidas que o §9 pede, calculadas agora e nunca gravadas."""

    quando: date
    requisicoes_por_estado: dict[str, int]
    esperando_estoque: list
    lotes_a_vencer: list[LoteAVencer]
    entregas_do_mes: list[EpiFichaRegistro]
    trocas_devidas: list[EpiFichaRegistro]

    @property
    def requisicoes_abertas(self) -> int:
        """O que ainda dá trabalho: fora do rascunho e dos três terminais.

        A lista dos terminais vem de `EPI_REQUISICAO_ENCERRADA`, e não repetida
        aqui — o comentário dela já diz que fila e indicador leem de lá. Rascunho
        sai por outro motivo: ele ainda é do requerente e não protocolou nada, e
        contá-lo faria o painel do SESMT cobrar trabalho que não chegou.
        """
        return sum(
            n
            for estado, n in self.requisicoes_por_estado.items()
            if estado != "RASCUNHO" and estado not in EPI_REQUISICAO_ENCERRADA
        )

    @property
    def lotes_vencidos(self) -> int:
        return sum(1 for lote in self.lotes_a_vencer if lote.vencido)


def painel(s: Session, quando: date | None = None) -> Painel:
    """As cinco medidas de `/epis`, cada uma da fonte que já a produzia.

    Nenhuma delas é recontada aqui: requisições por estado é
    `epi_requisicao.resumo_de_estados`, a fila de falta é
    `itens_esperando_estoque`, o CA a vencer usa o mesmo `DIAS_AVISO_CA` da
    pendência da RN-25, e as trocas devidas são `epi_ficha.trocas_devidas`. Um
    segundo cálculo para qualquer um desses números seria um segundo número —
    e o painel existe para ser conferido contra as telas, não para discordar
    delas.
    """
    quando = quando or date.today()
    return Painel(
        quando=quando,
        requisicoes_por_estado=epi_requisicao.resumo_de_estados(s),
        esperando_estoque=epi_requisicao.itens_esperando_estoque(s),
        lotes_a_vencer=lotes_a_vencer(s, quando),
        entregas_do_mes=entregas_do_mes(s, quando),
        trocas_devidas=epi_ficha.trocas_devidas(s, quando=quando),
    )


def lotes_a_vencer(s: Session, quando: date | None = None) -> list[LoteAVencer]:
    """Lotes ativos, com saldo, cujo CA vence dentro da janela da RN-25.

    O vencido entra junto, e no topo: ele não some da prateleira quando a data
    passa — continua sendo patrimônio que alguém tem de descartar ou renovar, e
    tirá-lo daqui esconderia o caso mais grave.
    """
    quando = quando or date.today()
    saldos = epi_estoque.saldos_de_todos(s)
    limite = quando.toordinal() + epi_estoque.DIAS_AVISO_CA
    linhas = []
    for entrada in s.execute(
        select(EpiEntradaEstoque).where(
            EpiEntradaEstoque.ativo.is_(True),
            EpiEntradaEstoque.validade_ca.is_not(None),
        )
    ).scalars():
        if entrada.validade_ca.toordinal() > limite:
            continue
        saldo = saldos.get(entrada.id, 0)
        if saldo <= 0:
            continue
        linhas.append(
            LoteAVencer(
                entrada=entrada,
                saldo=saldo,
                dias=(entrada.validade_ca - quando).days,
            )
        )
    return sorted(linhas, key=lambda linha: (linha.dias, linha.entrada.id))


def entregas_do_mes(
    s: Session, quando: date | None = None
) -> list[EpiFichaRegistro]:
    """As entregas do mês corrente, sem as estornadas.

    Estornada fora da conta porque o estorno declara que aquela entrega não
    aconteceu — contá-la faria o painel medir o trabalho de digitação, e não o
    de entrega.
    """
    quando = quando or date.today()
    inicio = quando.replace(day=1)
    return _entregas_validas(s, inicio, quando)


def _entregas_validas(
    s: Session, inicio: date, fim: date
) -> list[EpiFichaRegistro]:
    registros = list(
        s.execute(
            select(EpiFichaRegistro).where(
                EpiFichaRegistro.data_evento >= inicio,
                EpiFichaRegistro.data_evento <= fim,
            )
        ).scalars()
    )
    # os estornos podem estar fora da janela e ainda assim anular uma entrega
    # dentro dela: por isso a lista de estornados vem da tabela inteira
    estornados = {
        ident
        for (ident,) in s.execute(
            select(EpiFichaRegistro.registro_estornado_id).where(
                EpiFichaRegistro.tipo == "ESTORNO",
                EpiFichaRegistro.registro_estornado_id.is_not(None),
            )
        )
    }
    return [
        r
        for r in registros
        if r.tipo == "ENTREGA" and r.id not in estornados
    ]


# =====================================================================
# `/epis/relatorios` — as células, já como células
# =====================================================================
@dataclass(frozen=True)
class Celulas:
    """Uma dimensão do relatório: quem foi atendido, e quanto saiu.

    As duas contagens andam juntas de propósito. `servidores` é o que a RN-19
    mede e o que a supressão protege; `quantidade` é o que o setor quer saber, e
    ela só pode aparecer onde a célula de servidores sobreviveu — senão a
    supressão teria escondido o número de pessoas e publicado, ao lado, um
    número que varia com elas.
    """

    servidores: dict[str, int] = field(default_factory=dict)
    quantidade: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class LinhaEmpenho:
    empenho: str
    lotes: int
    recebido: int
    custo: Decimal | None
    sem_valor: int

    @property
    def incompleto(self) -> bool:
        """Há lote sem valor unitário — o custo é piso, não total.

        Zero seria mentira barata: "não sei quanto custou" e "custou nada" são
        coisas diferentes, e é a primeira que aparece em lote de doação ou
        digitado sem a nota. Mesma leitura de `LinhaDeLote.valor_em_estoque`.
        """
        return self.sem_valor > 0


@dataclass(frozen=True)
class Relatorio:
    inicio: date
    fim: date
    por_categoria: Celulas
    # {campus: {unidade: servidores}} — a hierarquia inteira, porque o total do
    # campus é a MARGEM das unidades dele e as duas têm de ser suprimidas juntas.
    # Entregar os dois níveis já somados obrigaria a supressão a confiar que a
    # soma bate, e ela não teria como conferir.
    por_campus: dict[str, dict[str, int]]
    empenhos: list[LinhaEmpenho]
    recusas_por_motivo: dict[str, int]
    recusas_por_unidade: dict[str, int]
    total_recusas: int


def relatorio(
    s: Session, *, inicio: date | None = None, fim: date | None = None
) -> Relatorio:
    """Tudo o que `/epis/relatorios` mostra, numa leitura só.

    A janela é o exercício corrente por padrão. Indicador sem recorte de tempo
    envelhece para cima: a soma de todos os anos só cresce, e nunca responde "o
    que aconteceu neste ano".
    """
    fim = fim or date.today()
    inicio = inicio or date(fim.year, 1, 1)

    entregas = _entregas_validas(s, inicio, fim)
    por_categoria = _celulas(entregas, lambda r: r.categoria_snapshot or "(sem categoria)")

    onde = _lotacoes(s, entregas)
    por_campus: dict[str, dict[str, set[int]]] = {}
    for registro in entregas:
        campus, unidade = onde[registro.id]
        por_campus.setdefault(campus, {}).setdefault(unidade, set()).add(
            registro.servidor_id
        )

    recusas_motivo, recusas_unidade, total = _recusas(s, inicio, fim)
    return Relatorio(
        inicio=inicio,
        fim=fim,
        por_categoria=por_categoria,
        por_campus={
            campus: {
                unidade: len(pessoas)
                for unidade, pessoas in sorted(unidades.items())
            }
            for campus, unidades in sorted(por_campus.items())
        },
        empenhos=custo_por_empenho(s, inicio, fim),
        recusas_por_motivo=recusas_motivo,
        recusas_por_unidade=recusas_unidade,
        total_recusas=total,
    )


def _celulas(entregas: list[EpiFichaRegistro], chave) -> Celulas:
    pessoas: dict[str, set[int]] = {}
    quantidade: dict[str, int] = {}
    for registro in entregas:
        rotulo = chave(registro)
        pessoas.setdefault(rotulo, set()).add(registro.servidor_id)
        quantidade[rotulo] = quantidade.get(rotulo, 0) + registro.quantidade
    return Celulas(
        servidores={k: len(v) for k, v in sorted(pessoas.items())},
        quantidade=dict(sorted(quantidade.items())),
    )


def _lotacoes(
    s: Session, entregas: list[EpiFichaRegistro]
) -> dict[int, tuple[str, str]]:
    """`{registro_id: (campus, unidade)}` — os dois da mesma leitura.

    A lotação é consultada uma vez por par (servidor, data): a mesma pessoa
    costuma ter várias entregas no mesmo dia, e `lotacao_em` percorre o
    histórico inteiro dela a cada chamada.
    """
    cache: dict[tuple[int, date], tuple[str, str]] = {}
    saida: dict[int, tuple[str, str]] = {}
    for registro in entregas:
        chave = (registro.servidor_id, registro.data_evento)
        if chave not in cache:
            lotacao = servico_servidores.lotacao_em(
                s, registro.servidor_id, registro.data_evento
            )
            unidade = lotacao.unidade if lotacao else None
            if unidade is None:
                servidor = s.get(Servidor, registro.servidor_id)
                unidade = servidor.unidade if servidor else None
            cache[chave] = (
                unidade.campus.sigla if unidade and unidade.campus else SEM_CAMPUS,
                unidade.nome_extenso if unidade else SEM_UNIDADE,
            )
        saida[registro.id] = cache[chave]
    return saida


def custo_por_empenho(
    s: Session, inicio: date, fim: date
) -> list[LinhaEmpenho]:
    """O que cada empenho comprou, pela data de ENTRADA do lote.

    Não passa por supressão, e é deliberado: empenho é execução orçamentária —
    número de nota, fornecedor e valor são públicos por força da Lei 12.527, e
    não nomeiam servidor nenhum. Suprimir aqui esconderia o dado que a
    fiscalização de contrato precisa e não protegeria ninguém.
    """
    agregado: dict[str, list] = {}
    for entrada in s.execute(
        select(EpiEntradaEstoque).where(
            EpiEntradaEstoque.data_entrada >= inicio,
            EpiEntradaEstoque.data_entrada <= fim,
        )
    ).scalars():
        atual = agregado.setdefault(
            entrada.empenho or SEM_EMPENHO, [0, 0, Decimal("0"), 0]
        )
        atual[0] += 1
        atual[1] += entrada.quantidade_recebida
        if entrada.valor_unitario is None:
            atual[3] += 1
        else:
            atual[2] += entrada.valor_unitario * entrada.quantidade_recebida
    return [
        LinhaEmpenho(
            empenho=empenho,
            lotes=lotes,
            recebido=recebido,
            custo=custo if lotes > sem_valor else None,
            sem_valor=sem_valor,
        )
        for empenho, (lotes, recebido, custo, sem_valor) in sorted(agregado.items())
    ]


def _recusas(
    s: Session, inicio: date, fim: date
) -> tuple[dict[str, int], dict[str, int], int]:
    """RN-27: a contagem por motivo e por unidade sai da própria trilha.

    Da trilha, e não das colunas de `epi_requisicao_item`, por duas razões que a
    RN-27 já dá: o **código** do motivo vai em `valor_novo` justamente para a
    contagem não depender de casar texto, e a recusa de balcão (decisão 3) não
    tem linha de requisição nenhuma — ela existe precisamente porque o pedido
    veio de quem não está no cadastro.

    A célula conta **recusas**, e não servidores distintos como as entregas.
    Aqui é a decisão que se conta: dois pedidos recusados da mesma pessoa pelo
    mesmo motivo são duas negativas, e é o número de negativas que instrui o
    ofício à empresa contratante.
    """
    por_motivo: dict[str, int] = {}
    por_unidade: dict[str, int] = {}
    total = 0
    for evento in s.execute(
        select(HistoricoEvento).where(
            HistoricoEvento.tipo_evento.in_(EVENTOS_DE_RECUSA)
        )
    ).scalars():
        # a data da recusa é a LOCAL, não a UTC gravada: uma negativa das 22h de
        # 31 de dezembro cairia no exercício seguinte, e o relatório do exercício
        # deixaria de bater com o que a trilha mostra na tela
        local = datas_br.local(evento.ocorrido_em)
        quando = local.date() if local else None
        if quando is None or quando < inicio or quando > fim:
            continue
        valor = evento.valor_novo if isinstance(evento.valor_novo, dict) else {}
        motivo = valor.get("rotulo") or valor.get("motivo") or "(sem motivo)"
        unidade = valor.get("unidade") or SEM_UNIDADE
        por_motivo[motivo] = por_motivo.get(motivo, 0) + 1
        por_unidade[unidade] = por_unidade.get(unidade, 0) + 1
        total += 1
    return (
        dict(sorted(por_motivo.items())),
        dict(sorted(por_unidade.items())),
        total,
    )


__all__ = [
    "EVENTOS_DE_RECUSA",
    "SEM_CAMPUS",
    "SEM_EMPENHO",
    "SEM_UNIDADE",
    "Celulas",
    "LinhaEmpenho",
    "LoteAVencer",
    "Painel",
    "Relatorio",
    "custo_por_empenho",
    "entregas_do_mes",
    "lotes_a_vencer",
    "painel",
    "relatorio",
]
