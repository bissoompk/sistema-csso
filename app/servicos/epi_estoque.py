"""O estoque de EPI: o lote, o livro razão e o saldo que sai da soma dele.

Fatia 3 do módulo Gestão de EPI. A fatia 2 deixou aqui só o que a entrega
precisava — `saldo_fisico`, `lotes_de`, `baixar`; agora entram a entrada do lote,
a devolução, o descarte e o ajuste de inventário, que são os outros quatro
movimentos do razão.

A **regra** da devolução não mora aqui, e sim em
`epi_ficha.registrar_devolucao`: devolver é fato de uma pessoa que recebeu, e é
na ficha dela que essa história pertence — aqui fica só o lançamento no razão.
É a mesma divisão que a entrega já tinha, e é o que põe `estornar` e
`registrar_devolucao` lado a lado no arquivo onde a diferença entre as duas
precisa estar à vista.

**Saldo é soma, nunca célula.** No legado `Estoque_Entradas.Qtd_Estoque` era uma
coluna mutável: duas entregas simultâneas perdiam uma, e não havia como
reconciliar depois porque não sobrava rastro do que baixou. Aqui
`saldo_fisico(entrada) = SUM(epi_movimento_estoque.quantidade)`, sobre uma tabela
que o banco recusa alterar.

Não há saldo materializado em lugar nenhum deste arquivo, e isso é decisão, não
esquecimento: uma coluna de saldo é uma segunda fonte para o mesmo número, e
duas fontes divergem no dia em que alguém gravar um movimento sem passar por
aqui — que é exatamente o defeito que o razão existe para tornar impossível. O
custo é um `SUM` por lote, sobre uma tabela indexada por `entrada_id`, num
almoxarifado que tem dezenas de lotes.

**Reserva não é movimento, e por isso `disponivel` não é o físico.** Reservar
não tira nada da prateleira — tira da disponibilidade —, e a reserva mora em
`epi_requisicao_item.quantidade_reservada`, nunca no razão (fatia 5). Se ela
entrasse no razão, o saldo físico deixaria de bater com a contagem manual, que é
a conferência que o razão existe para permitir. `disponivel = físico −
reservado`, cada conceito com uma fonte só, e a contagem da prateleira compara
com a primeira.

**O lote vencido não some.** Ele continua com saldo, é patrimônio, e alguém vai
ter de dar baixa nele. Sai da lista de entrega (`lotes_de` o marca com
impedimento) e continua na lista de estoque, etiquetado. Tirá-lo da prateleira é
`DESCARTE` com motivo — decisão registrada, não desaparecimento automático.

**Correção é movimento novo.** Não há `UPDATE` no razão: erro de contagem se
conserta com `AJUSTE`, que carrega o motivo e o nome de quem contou.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modelos import (
    EpiEntradaEstoque,
    EpiItem,
    EpiMovimentoEstoque,
    EpiRequisicaoItem,
)
from app.servicos import auditoria, datas_br, pendencias, textos
from app.servicos.rbac import UsuarioAtual

ENTRADA = "ENTRADA"
SAIDA = "SAIDA"
DEVOLUCAO = "DEVOLUCAO"
DESCARTE = "DESCARTE"
AJUSTE = "AJUSTE"

EPI_LOTE_REGISTRADO = "EPI_LOTE_REGISTRADO"
EPI_LOTE_ALTERADO = "EPI_LOTE_ALTERADO"
EPI_ESTOQUE_DESCARTADO = "EPI_ESTOQUE_DESCARTADO"
EPI_ESTOQUE_AJUSTADO = "EPI_ESTOQUE_AJUSTADO"

TIPO_PENDENCIA_CA = "CA_A_VENCER"

# RN-25: a pendência do CA abre 60 dias antes do vencimento. É o mesmo horizonte
# que o catálogo já usa em `EpiItem.ca_a_vencer_em` — dois números diferentes
# para o mesmo aviso fariam a tela dizer "a vencer" e a fila de pendências
# discordar.
DIAS_AVISO_CA = 60


class EstoqueBloqueado(ValueError):
    """O que impede este movimento, tudo de uma vez.

    Lista em vez de primeiro-erro, pela mesma razão do `EntregaBloqueada` da
    ficha: quem está conferindo a prateleira precisa saber tudo o que falta numa
    passada, e não descobrir um problema por tentativa.
    """

    def __init__(self, motivos: list[str]):
        self.motivos = motivos
        super().__init__("Movimento recusado: " + "; ".join(motivos))


# =====================================================================
# Saldo — a soma do razão
# =====================================================================
def saldo_fisico(s: Session, entrada_id: int) -> int:
    """O que está na prateleira, pela soma do razão."""
    return int(
        s.execute(
            select(func.coalesce(func.sum(EpiMovimentoEstoque.quantidade), 0)).where(
                EpiMovimentoEstoque.entrada_id == entrada_id
            )
        ).scalar_one()
    )


def saldos_de_todos(s: Session) -> dict[int, int]:
    """`{entrada_id: saldo}` numa consulta só, para a tela do estoque.

    A tela lista todos os lotes; chamar `saldo_fisico` por linha seria uma
    consulta por lote. O agregado é o mesmo `SUM` — a única diferença é o
    `GROUP BY`, e por isso não há risco de os dois números divergirem.
    """
    linhas = s.execute(
        select(
            EpiMovimentoEstoque.entrada_id,
            func.coalesce(func.sum(EpiMovimentoEstoque.quantidade), 0),
        ).group_by(EpiMovimentoEstoque.entrada_id)
    )
    return {int(entrada_id): int(soma) for entrada_id, soma in linhas}


def reservado(s: Session, entrada_id: int) -> int:
    """O que este lote já prometeu a pedidos abertos.

    Soma `epi_requisicao_item.quantidade_reservada` dos itens **em `RESERVADO`**
    que apontam para este lote. O filtro por estado não é redundante com a
    coluna: item cancelado ou solto por CA vencido zera a quantidade, e um dos
    dois sozinho já bastaria — os dois juntos fazem com que um esquecimento de um
    lado não vire promessa fantasma do outro.

    **Reserva não é movimento**, e por isso ela não sai daqui somando o razão:
    reservar não tira nada da prateleira, tira da disponibilidade. Se a reserva
    entrasse no razão, o saldo físico deixaria de bater com a contagem manual —
    que é justamente a conferência que o razão existe para permitir.
    """
    return int(
        s.execute(
            select(
                func.coalesce(func.sum(EpiRequisicaoItem.quantidade_reservada), 0)
            ).where(
                EpiRequisicaoItem.entrada_id == entrada_id,
                EpiRequisicaoItem.estado == "RESERVADO",
            )
        ).scalar_one()
    )


def reservas_de_todos(s: Session) -> dict[int, int]:
    """`{entrada_id: reservado}` numa consulta só, para a tela do estoque.

    O par agregado de `saldos_de_todos`, e pelo mesmo motivo: a tela lista todos
    os lotes, e uma consulta por linha seria uma consulta por lote. É o mesmo
    `SUM` com o mesmo filtro — só muda o `GROUP BY` —, e por isso os dois números
    não podem divergir. Há teste que compara os dois lado a lado, porque "não
    podem divergir" é exatamente o tipo de afirmação que envelhece sozinha.
    """
    linhas = s.execute(
        select(
            EpiRequisicaoItem.entrada_id,
            func.coalesce(func.sum(EpiRequisicaoItem.quantidade_reservada), 0),
        )
        .where(
            EpiRequisicaoItem.entrada_id.is_not(None),
            EpiRequisicaoItem.estado == "RESERVADO",
        )
        .group_by(EpiRequisicaoItem.entrada_id)
    )
    return {int(entrada_id): int(soma) for entrada_id, soma in linhas}


def disponivel(s: Session, entrada_id: int) -> int:
    """RN-24 lê daqui. Físico menos o que já foi prometido a outro pedido.

    É este número — e não o físico — que a reserva e a entrega conferem. Reservar
    contra o físico deixaria dois pedidos prometerem o mesmo par de botas, que é
    a coisa que a reserva existe para impedir.
    """
    return saldo_fisico(s, entrada_id) - reservado(s, entrada_id)


@dataclass(frozen=True)
class LoteDisponivel:
    """Um lote na tela da entrega, com o que decide se ele pode sair.

    `impedimento` é texto, e não booleano, porque a tela precisa dizer **por
    quê** o botão está desabilitado. Botão que some sem explicação faz quem opera
    procurar defeito no sistema em vez de resolver o problema do lote.
    """

    entrada: EpiEntradaEstoque
    saldo: int
    impedimento: str = ""

    @property
    def pode_sair(self) -> bool:
        return not self.impedimento and self.saldo > 0

    @property
    def rotulo(self) -> str:
        partes = [f"Lote {self.entrada.lote}" if self.entrada.lote else "Lote sem número"]
        if self.entrada.tamanho:
            partes.append(f"tam. {self.entrada.tamanho}")
        partes.append(f"CA {self.entrada.numero_ca or '—'}")
        partes.append(f"{self.saldo} em estoque")
        return " · ".join(partes)


def impedimento_do_lote(
    entrada: EpiEntradaEstoque, item: EpiItem, quando: date
) -> str:
    """RN-25 — a regra do módulo com consequência jurídica direta.

    O CA que governa a entrega é o **do lote**, não o do catálogo: um lote de
    2023 pode ter CA vencido enquanto o catálogo já aponta para o CA renovado de
    2026. Pela NR-6 o Certificado de Aprovação é o que constitui o equipamento
    como EPI — entregar um com CA vencido significa que a instituição não
    entregou proteção nenhuma.

    "Não sei" não é "está válido": lote sem validade de CA, num item que exige
    CA, também não sai.
    """
    if not entrada.ativo:
        return f"lote inativado: {entrada.motivo_inativacao or 'sem motivo registrado'}"
    if not item.exige_ca:
        return ""
    if not entrada.numero_ca:
        return "o lote não tem número de CA registrado"
    if entrada.validade_ca is None:
        return "o lote não tem validade de CA registrada — “não sei” não é “está válido”"
    if entrada.validade_ca < quando:
        # data em dd/mm/aaaa: este texto vai para a tela e para a mensagem de
        # recusa, e ISO é forma de banco, não de quem lê
        return (
            f"o CA {entrada.numero_ca} do lote venceu em "
            f"{datas_br.numerica(entrada.validade_ca)}"
        )
    return ""


def lotes_de(
    s: Session,
    item: EpiItem,
    *,
    quando: date | None = None,
    tamanho: str | None = None,
) -> list[LoteDisponivel]:
    """Os lotes do item, com saldo e impedimento — inclusive os impedidos.

    O lote com CA vencido **não some** da lista: ele continua com saldo físico e
    fica indisponível, com o motivo escrito ao lado. Sumir seria o mesmo defeito
    do legado, em que o saldo mudava sem rastro; tirá-lo do estoque é `DESCARTE`
    com motivo, que é decisão registrada e não desaparecimento automático.
    """
    quando = quando or date.today()
    consulta = select(EpiEntradaEstoque).where(EpiEntradaEstoque.epi_item_id == item.id)
    if tamanho:
        consulta = consulta.where(EpiEntradaEstoque.tamanho == tamanho)
    entradas = list(s.execute(consulta.order_by(EpiEntradaEstoque.data_entrada)).scalars())
    return [
        LoteDisponivel(
            entrada=entrada,
            saldo=disponivel(s, entrada.id),
            impedimento=impedimento_do_lote(entrada, item, quando),
        )
        for entrada in entradas
    ]


# =====================================================================
# A tela do estoque: saldo por item e por lote
# =====================================================================
@dataclass(frozen=True)
class LinhaDeLote:
    """Um lote na tela do estoque, com físico, reservado e disponível lado a lado.

    Os três aparecem juntos porque é assim que a conferência contra a contagem
    manual funciona (RN-24): quem conta a prateleira encontra o **físico**, e
    achar o número certo escondido atrás de uma subtração é como a divergência
    passa despercebida.
    """

    entrada: EpiEntradaEstoque
    fisico: int
    reservado: int
    impedimento: str

    @property
    def disponivel(self) -> int:
        return self.fisico - self.reservado

    @property
    def impedido(self) -> bool:
        return bool(self.impedimento)

    @property
    def valor_em_estoque(self) -> Decimal | None:
        """Quanto o que sobrou custou. `None` quando o lote não trouxe valor.

        Zero seria mentira barata: "não sei quanto custou" e "custou nada" são
        coisas diferentes, e é a primeira que aparece em lote recebido por
        doação ou digitado sem a nota.
        """
        if self.entrada.valor_unitario is None:
            return None
        return self.entrada.valor_unitario * self.fisico


@dataclass(frozen=True)
class LinhaDeItem:
    """Um item do catálogo com os lotes dele. O agrupamento é o da prateleira."""

    item: EpiItem
    lotes: list[LinhaDeLote]

    @property
    def fisico(self) -> int:
        return sum(lote.fisico for lote in self.lotes)

    @property
    def disponivel(self) -> int:
        """O que pode sair hoje: sem os lotes impedidos, e sem os zerados."""
        return sum(
            lote.disponivel for lote in self.lotes if not lote.impedimento
        )

    @property
    def preso_em_lote_vencido(self) -> int:
        """Saldo que existe e não pode sair. É o número que pede decisão.

        Ele não se soma ao disponível nem some da tela: é patrimônio parado, e
        alguém tem de descartá-lo ou renovar o CA.
        """
        return sum(lote.fisico for lote in self.lotes if lote.impedimento)


def panorama(
    s: Session, *, quando: date | None = None, busca: str = ""
) -> list[LinhaDeItem]:
    """O estoque inteiro, por item e por lote — inclusive o que não pode sair.

    Itens sem lote nenhum ficam de fora: a tela é do estoque, e catálogo sem
    entrada não é estoque zerado, é item que nunca foi comprado. Quem quer ver o
    catálogo inteiro abre `/epis/catalogo`.
    """
    quando = quando or date.today()
    alvo = textos.chave_busca(busca) if busca.strip() else ""
    entradas = list(
        s.execute(
            select(EpiEntradaEstoque).order_by(
                EpiEntradaEstoque.data_entrada, EpiEntradaEstoque.id
            )
        ).scalars()
    )
    saldos = saldos_de_todos(s)
    # os dois agregados, e não um `SUM` por linha: a tela lista o estoque
    # inteiro, e a versão individual aqui dentro seria duas consultas por lote
    reservas = reservas_de_todos(s)

    por_item: dict[int, list[LinhaDeLote]] = {}
    itens: dict[int, EpiItem] = {}
    for entrada in entradas:
        item = entrada.item
        if alvo and not _casa_a_busca(entrada, item, alvo):
            continue
        itens[item.id] = item
        por_item.setdefault(item.id, []).append(
            LinhaDeLote(
                entrada=entrada,
                fisico=saldos.get(entrada.id, 0),
                reservado=reservas.get(entrada.id, 0),
                impedimento=impedimento_do_lote(entrada, item, quando),
            )
        )
    return sorted(
        (LinhaDeItem(item=itens[item_id], lotes=lotes) for item_id, lotes in por_item.items()),
        key=lambda linha: textos.chave_busca(linha.item.nome),
    )


def _casa_a_busca(entrada: EpiEntradaEstoque, item: EpiItem, alvo: str) -> bool:
    """Nome do item, lote, empenho, pregão, CA e fornecedor.

    São os seis campos pelos quais alguém procura um lote na prática — e o
    empenho é o mais usado, porque é por ele que a pergunta chega ("esse
    capacete veio de qual empenho?").
    """
    campos = (
        item.nome,
        item.modelo or "",
        entrada.lote or "",
        entrada.empenho or "",
        entrada.pregao or "",
        entrada.numero_ca or "",
        entrada.fornecedor_nome or "",
    )
    return any(alvo in textos.chave_busca(campo) for campo in campos)


@dataclass(frozen=True)
class LinhaDoExtrato:
    """Um movimento com o saldo que ele deixou. O extrato é do lote."""

    movimento: EpiMovimentoEstoque
    saldo_depois: int


def extrato(s: Session, entrada_id: int) -> list[LinhaDoExtrato]:
    """O razão do lote, do mais antigo para o mais novo, com saldo acumulado.

    Em ordem de `id`, e não de `ocorrido_em`: `id` é a ordem em que os fatos
    foram gravados, e é ela que faz o saldo acumulado bater com o `SUM`. Duas
    linhas com o mesmo carimbo de tempo — que acontece — embaralhariam a coluna
    de saldo sem que nada mudasse no total.
    """
    movimentos = list(
        s.execute(
            select(EpiMovimentoEstoque)
            .where(EpiMovimentoEstoque.entrada_id == entrada_id)
            .order_by(EpiMovimentoEstoque.id)
        ).scalars()
    )
    linhas: list[LinhaDoExtrato] = []
    acumulado = 0
    for movimento in movimentos:
        acumulado += movimento.quantidade
        linhas.append(LinhaDoExtrato(movimento=movimento, saldo_depois=acumulado))
    return linhas


# =====================================================================
# Os movimentos
# =====================================================================
def _movimentar(
    s: Session,
    *,
    entrada: EpiEntradaEstoque,
    tipo: str,
    quantidade: int,
    usuario: UsuarioAtual,
    motivo: str | None = None,
    ficha_registro_id: int | None = None,
    requisicao_item_id: int | None = None,
) -> EpiMovimentoEstoque:
    """A única porta de escrita no razão. Grava a linha e reconfere a pendência.

    Porta única porque o sinal do movimento é o que faz `SUM(quantidade)` ser um
    saldo: entrada positiva, saída negativa. Espalhar a montagem da linha por
    cinco funções seria espalhar cinco chances de trocar o sinal — e o banco
    recusaria (`ck_mov_sinal`), mas na cara de quem opera, no meio do
    atendimento.
    """
    movimento = EpiMovimentoEstoque(
        entrada_id=entrada.id,
        tipo=tipo,
        quantidade=quantidade,
        ficha_registro_id=ficha_registro_id,
        requisicao_item_id=requisicao_item_id,
        motivo=motivo,
        registrado_por=usuario.id,
    )
    s.add(movimento)
    s.flush()
    sincronizar_pendencia_de_ca(s, entrada, usuario)
    return movimento


def baixar(
    s: Session,
    *,
    entrada: EpiEntradaEstoque,
    quantidade: int,
    ficha_registro_id: int,
    usuario: UsuarioAtual,
    motivo: str | None = None,
    requisicao_item_id: int | None = None,
) -> EpiMovimentoEstoque:
    """Uma linha `SAIDA` no razão, amarrada à linha da ficha.

    `requisicao_item_id` é nulo na entrega de balcão — que é entrega sem pedido
    formal, e é legítima — e preenchido quando a saída atende uma requisição
    (fatia 4). É por essa coluna que "esse par de botas saiu por qual pedido"
    tem resposta sem passar por busca de texto.

    Quantidade negativa porque o saldo é `SUM(quantidade)`: sinal trocado faria a
    soma deixar de ser saldo e virar um número que não quer dizer nada — é o que
    `ck_mov_sinal` recusa no banco.

    A conferência de saldo (RN-24) **não** mora aqui, e sim em quem chama: o
    serviço da ficha precisa recusar a entrega inteira antes de gravar a linha da
    prova, não depois. Baixar estoque de uma entrega que não aconteceu seria pior
    que o erro que ela evita.

    Não há evento de auditoria próprio: a saída **é** a entrega, e a entrega já
    entra na trilha com o lote, o CA e a quantidade em `forma_canonica`. Um
    segundo evento para o mesmo fato faria a contagem por tipo de evento somar em
    dobro.
    """
    return _movimentar(
        s,
        entrada=entrada,
        tipo=SAIDA,
        quantidade=-abs(quantidade),
        usuario=usuario,
        motivo=motivo,
        ficha_registro_id=ficha_registro_id,
        requisicao_item_id=requisicao_item_id,
    )


def devolver(
    s: Session,
    *,
    entrada: EpiEntradaEstoque,
    quantidade: int,
    usuario: UsuarioAtual,
    ficha_registro_id: int | None = None,
    motivo: str | None = None,
) -> EpiMovimentoEstoque:
    """`DEVOLUCAO`: o equipamento voltou para a prateleira. Positiva.

    **Devolução não é estorno, e a diferença não é de vocabulário.** Estorno diz
    que o REGISTRO estava errado — a entrega não devia ter sido lançada daquele
    jeito —, e por isso não devolve saldo nenhum: nada voltou da prateleira
    porque nada saiu de verdade daquele jeito. Devolução diz que o registro
    estava certo e que o EPI **voltou**: o fato é do mundo, é posterior à
    entrega, e o saldo sobe.

    Fazer as duas coisas com um clique só criaria a divergência que o razão
    existe para impedir: o físico do sistema deixaria de bater com a contagem da
    prateleira, e ninguém saberia qual dos dois está errado.

    Quem chama é `epi_ficha.registrar_devolucao`, que grava antes a linha da
    ficha — a devolução é fato da pessoa que recebeu, e é na ficha dela que essa
    história pertence.
    """
    return _movimentar(
        s,
        entrada=entrada,
        tipo=DEVOLUCAO,
        quantidade=abs(quantidade),
        usuario=usuario,
        motivo=motivo,
        ficha_registro_id=ficha_registro_id,
    )


def descartar(
    s: Session,
    usuario: UsuarioAtual,
    *,
    entrada: EpiEntradaEstoque,
    quantidade: int,
    motivo: str,
) -> EpiMovimentoEstoque:
    """`DESCARTE`: o lote sai da prateleira por decisão, com motivo. Negativa.

    É o único caminho legítimo para tirar do estoque o lote de CA vencido. Ele
    não some sozinho quando a validade passa — some quando alguém decide, assina
    a decisão e diz por quê. Sumiço automático seria o defeito do legado com
    outra roupa: saldo mudando sem rastro.

    **A reserva que o descarte deixou sem lastro é solta aqui**, e não descoberta
    depois no balcão. Descartar 8 de um lote que prometeu 5 a um pedido produz uma
    promessa que a prateleira não sustenta; quem só descobrisse isso na hora de
    entregar teria a pessoa na frente e um erro sem explicação. Solta-se o mínimo
    e da reserva mais nova para a mais antiga — a fila de quem esperou mais tempo
    é a que menos deve perder o lugar (RN-24).
    """
    usuario.exigir("epi.estoque")
    limpo = _motivo_obrigatorio(motivo, "motivo do descarte")
    saldo = saldo_fisico(s, entrada.id)
    if quantidade <= 0:
        raise EstoqueBloqueado(["a quantidade a descartar tem de ser maior que zero"])
    if quantidade > saldo:
        raise EstoqueBloqueado(
            [
                f"o lote tem {saldo} em estoque e o descarte pede {quantidade}: "
                "saldo não fica negativo (RN-24). Se a prateleira discorda do "
                "sistema, o caminho é o ajuste de inventário"
            ]
        )
    movimento = _movimentar(
        s,
        entrada=entrada,
        tipo=DESCARTE,
        quantidade=-abs(quantidade),
        usuario=usuario,
        motivo=limpo,
    )
    auditoria.registrar(
        s,
        entidade=EpiEntradaEstoque.__tablename__,
        entidade_id=entrada.id,
        tipo_evento=EPI_ESTOQUE_DESCARTADO,
        descricao=(
            f"{quantidade} × {entrada.item.nome} descartado(s) do lote "
            f"{entrada.lote or '—'} (CA {entrada.numero_ca or '—'}): {limpo}"
        ),
        campo="saldo",
        # inteiros de verdade: a trava da auditoria recusa valor que não volta
        # igual do banco, e "12" não é 12
        valor_anterior=saldo,
        valor_novo=saldo - quantidade,
        comentario=limpo,
        usuario=usuario,
    )
    s.flush()
    _soltar_reservas_sem_lastro(
        s,
        entrada,
        usuario,
        motivo=(
            f"{quantidade} unidade(s) do lote {entrada.lote or '—'} foram "
            f"descartadas: {limpo}"
        ),
    )
    return movimento


def _soltar_reservas_sem_lastro(
    s: Session, entrada: EpiEntradaEstoque, usuario: UsuarioAtual, *, motivo: str
) -> int:
    """Solta o que o lote prometeu e já não tem — devolve quantos itens soltou.

    O import é local, e isso é a fatia 5 pagando o preço da direção certa das
    dependências: `epi_requisicao` importa `epi_ficha`, que importa este módulo.
    Uma reserva é fato do **pedido**, e é lá que a transição da máquina D mora;
    inverter isso para poupar um import local poria a máquina de estado do item
    dentro do serviço do almoxarifado, onde ninguém iria procurá-la.
    """
    from app.servicos import epi_requisicao

    return epi_requisicao.soltar_reservas_do_lote(s, usuario, entrada, motivo=motivo)


def ajustar(
    s: Session,
    usuario: UsuarioAtual,
    *,
    entrada: EpiEntradaEstoque,
    contagem: int,
    motivo: str,
) -> EpiMovimentoEstoque:
    """`AJUSTE`: o saldo do sistema encontra a contagem física, com motivo.

    Recebe **o que foi contado**, e não a diferença. Quem está com a prateleira
    na frente sabe que há 7 pares; obrigá-lo a calcular "-3" é obrigá-lo a fazer
    uma conta que o sistema faz melhor, e é onde nasce o ajuste com sinal
    trocado.

    Esta é a única forma legítima de o saldo mudar sem que nada tenha entrado
    nem saído — e por isso ela deixa rastro completo: a linha do razão guarda a
    diferença, o motivo, quem contou e quando, e nada disso se altera depois
    (append-only). O motivo é obrigatório no banco (`ck_mov_motivo`) porque
    ajuste sem explicação é saldo que sumiu.
    """
    usuario.exigir("epi.estoque")
    limpo = _motivo_obrigatorio(motivo, "motivo do ajuste de inventário")
    if contagem < 0:
        raise EstoqueBloqueado(["a contagem física não pode ser negativa"])
    saldo = saldo_fisico(s, entrada.id)
    diferenca = contagem - saldo
    if diferenca == 0:
        raise EstoqueBloqueado(
            [
                f"a contagem física ({contagem}) confere com o saldo do sistema: "
                "não há ajuste a registrar. Movimento de quantidade zero o banco "
                "recusa, e com razão — ele não diria nada"
            ]
        )
    # o texto do movimento carrega os dois números: quem ler o extrato daqui a
    # dois anos precisa saber de quanto para quanto foi, sem ter de refazer a
    # soma do razão até aquela linha
    registro_do_motivo = (
        f"Inventário: contagem física {contagem}, saldo do sistema {saldo} "
        f"({diferenca:+d}). {limpo}"
    )
    movimento = _movimentar(
        s,
        entrada=entrada,
        tipo=AJUSTE,
        quantidade=diferenca,
        usuario=usuario,
        motivo=registro_do_motivo,
    )
    auditoria.registrar(
        s,
        entidade=EpiEntradaEstoque.__tablename__,
        entidade_id=entrada.id,
        tipo_evento=EPI_ESTOQUE_AJUSTADO,
        descricao=(
            f"Ajuste de inventário no lote {entrada.lote or '—'} de "
            f"{entrada.item.nome}: {saldo} → {contagem} ({diferenca:+d}). {limpo}"
        ),
        campo="saldo",
        valor_anterior=saldo,
        valor_novo=contagem,
        comentario=limpo,
        usuario=usuario,
    )
    s.flush()
    # inventário para menos também tira lastro de reserva: o lote prometeu 5 e a
    # contagem achou 3. Soltar aqui é o mesmo raciocínio do descarte — a promessa
    # que a prateleira não sustenta se desfaz onde ela deixou de existir, e não na
    # frente da pessoa que veio buscar.
    if diferenca < 0:
        _soltar_reservas_sem_lastro(
            s,
            entrada,
            usuario,
            motivo=(
                f"a contagem física do lote {entrada.lote or '—'} encontrou "
                f"{contagem} onde o sistema dizia {saldo}: {limpo}"
            ),
        )
    return movimento


def _motivo_obrigatorio(motivo: str, campo: str) -> str:
    """Texto limpo e não vazio. RN-30: passa pelo filtro da RN-21 antes de gravar."""
    limpo = textos.exigir_texto_limpo((motivo or "").strip(), campo=campo)
    if not limpo:
        raise EstoqueBloqueado(
            [
                f"{campo} é obrigatório: é o único registro que sobra para quem "
                "ler o extrato depois e perguntar por que o saldo mudou"
            ]
        )
    return limpo


# =====================================================================
# A entrada do lote
# =====================================================================
def registrar_entrada(
    s: Session,
    usuario: UsuarioAtual,
    *,
    item: EpiItem,
    quantidade_recebida: int,
    data_entrada: date | None = None,
    tamanho: str = "",
    pregao: str = "",
    item_pregao: str = "",
    empenho: str = "",
    nota_fiscal: str = "",
    fornecedor_nome: str = "",
    fornecedor_cnpj: str = "",
    fornecedor_contato: str = "",
    quantidade_empenhada: int | None = None,
    valor_unitario: Decimal | None = None,
    lote: str = "",
    numero_ca: str = "",
    validade_ca: date | None = None,
    data_fabricacao: date | None = None,
    observacao: str = "",
) -> EpiEntradaEstoque:
    """O lote entra: a linha da compra e o primeiro movimento do razão.

    Os dois na mesma transação, e é isso que faz a quantidade recebida ser
    imutável: ela é gravada uma vez na entrada (como fato da nota fiscal) e uma
    vez no razão (como movimento). Daí em diante o saldo é só a soma do razão —
    a coluna `quantidade_recebida` nunca mais muda, ao contrário do
    `Qtd_Estoque` do legado, que era o saldo corrente e se sobrescrevia.

    **O CA que importa é o deste lote.** O do catálogo é o que o pregão
    especificou; o da etiqueta da caixa que chegou é o que decide se o
    equipamento pode ser entregue (RN-25). Lote com CA já vencido **é aceito** —
    ele existe, está na prateleira e é patrimônio; o que ele não pode é sair.
    Recusar a entrada faria o setor guardar caixa que o sistema não conhece, que
    é como o estoque paralelo nasce.
    """
    usuario.exigir("epi.estoque")
    quando = data_entrada or date.today()
    limpo = textos.exigir_texto_limpo(
        (observacao or "").strip(), campo="observação do lote"
    )

    problemas: list[str] = []
    if quantidade_recebida <= 0:
        problemas.append("a quantidade recebida tem de ser maior que zero")
    if quantidade_empenhada is not None and quantidade_empenhada < quantidade_recebida:
        problemas.append(
            f"o empenho é de {quantidade_empenhada} e a entrada registra "
            f"{quantidade_recebida} recebidas: receber mais do que se empenhou é "
            "erro de digitação ou entrega fora do contrato"
        )
    if quando > date.today():
        problemas.append("a data de entrada não pode ser futura")
    if valor_unitario is not None and valor_unitario < 0:
        problemas.append("o valor unitário não pode ser negativo")
    if (
        data_fabricacao is not None
        and validade_ca is not None
        and data_fabricacao > validade_ca
    ):
        problemas.append("a fabricação é posterior à validade do CA: confira as duas datas")
    if problemas:
        raise EstoqueBloqueado(problemas)

    entrada = EpiEntradaEstoque(
        epi_item_id=item.id,
        tamanho=_ou_nada(tamanho),
        pregao=_ou_nada(pregao),
        item_pregao=_ou_nada(item_pregao),
        empenho=_ou_nada(empenho),
        nota_fiscal=_ou_nada(nota_fiscal),
        fornecedor_nome=_ou_nada(fornecedor_nome),
        # normalizado, e não `_ou_nada`: o campo vem de nota fiscal impressa e
        # chega pontuado. O porquê está em `normalizar_cnpj`.
        fornecedor_cnpj=normalizar_cnpj(fornecedor_cnpj),
        fornecedor_contato=_ou_nada(fornecedor_contato),
        data_entrada=quando,
        quantidade_empenhada=quantidade_empenhada,
        quantidade_recebida=quantidade_recebida,
        valor_unitario=valor_unitario,
        lote=_ou_nada(lote),
        numero_ca=_ou_nada(numero_ca),
        validade_ca=validade_ca,
        data_fabricacao=data_fabricacao,
        observacao=limpo or None,
        registrado_por=usuario.id,
    )
    s.add(entrada)
    s.flush()

    _movimentar(
        s,
        entrada=entrada,
        tipo=ENTRADA,
        quantidade=quantidade_recebida,
        usuario=usuario,
        motivo=(
            f"Entrada do lote {entrada.lote or 'sem número'}"
            + (f", empenho {entrada.empenho}" if entrada.empenho else "")
        ),
    )
    auditoria.registrar(
        s,
        entidade=EpiEntradaEstoque.__tablename__,
        entidade_id=entrada.id,
        tipo_evento=EPI_LOTE_REGISTRADO,
        descricao=(
            f"{quantidade_recebida} × {item.nome} · lote {entrada.lote or '—'} · "
            f"CA {entrada.numero_ca or '—'} · empenho {entrada.empenho or '—'} · "
            f"{entrada.fornecedor_nome or 'fornecedor não informado'}"
        ),
        campo="entrada",
        # número é número e dinheiro é Decimal: a trava da auditoria (1.19.1)
        # recusa o que não volta igual do banco, e é ela que impede o digest de
        # ser calculado sobre uma coisa e conferido sobre outra
        valor_novo={
            "quantidade_recebida": quantidade_recebida,
            "quantidade_empenhada": quantidade_empenhada,
            "valor_unitario": valor_unitario,
            "pregao": entrada.pregao,
            "item_pregao": entrada.item_pregao,
            "empenho": entrada.empenho,
            "nota_fiscal": entrada.nota_fiscal,
            "fornecedor": entrada.fornecedor_nome,
            "cnpj": entrada.fornecedor_cnpj,
            "lote": entrada.lote,
            "tamanho": entrada.tamanho,
            "numero_ca": entrada.numero_ca,
            "validade_ca": validade_ca.isoformat() if validade_ca else None,
            "data_entrada": quando.isoformat(),
        },
        usuario=usuario,
    )
    s.flush()
    return entrada


def _ou_nada(valor: str) -> str | None:
    return (valor or "").strip() or None


def normalizar_cnpj(bruto: str) -> str | None:
    """`12.345.678/0001-90` e `12345678000190` são o mesmo CNPJ. Vazio vira `None`.

    A regra mora AQUI e não no `maxlength` do campo, e a diferença não é de
    estilo. O campo é transcrito de uma **nota fiscal impressa**, onde o CNPJ vem
    pontuado e ocupa 18 caracteres; o `maxlength="14"` da coluna cortava no
    décimo quarto — `12.345.678/000` — sem mensagem, sem borda vermelha e sem
    som. Gravava-se um CNPJ que não existe, e ninguém ficava sabendo: `maxlength`
    é o pior tipo de validação, a que não avisa.

    O sistema já sabia fazer isto no NUP, que promete por escrito ao lado do
    campo que "pontuação, espaço e traço são acertados sozinhos" (`servicos.nup`)
    porque o serviço normaliza. Aqui é o mesmo gesto, e aqui é o campo copiado de
    papel.

    Contagem errada é **recusa escrita**, não corte silencioso: 11 dígitos é CPF
    no campo do fornecedor ou transcrição pela metade, e as duas coisas precisam
    voltar para quem está com o papel na mão. Guarda-se só o dígito — a
    pontuação é leitura, e a coluna é `String(14)`.
    """
    digitos = re.sub(r"\D", "", bruto or "")
    if not digitos:
        return None
    if len(digitos) != 14:
        raise EstoqueBloqueado(
            [
                f"CNPJ do fornecedor com {len(digitos)} dígito(s): o CNPJ tem 14. "
                "Copie o número inteiro da nota — a pontuação pode vir junto, "
                "ela é descartada na gravação"
            ]
        )
    return digitos


def formatar_cnpj(valor: str | None) -> str:
    """Os 14 dígitos guardados, de volta ao formato em que se conferem."""
    digitos = re.sub(r"\D", "", valor or "")
    if len(digitos) != 14:
        return valor or ""
    return (
        f"{digitos[:2]}.{digitos[2:5]}.{digitos[5:8]}/{digitos[8:12]}-{digitos[12:]}"
    )


def valor_decimal(bruto: str) -> Decimal | None:
    """Lê `12,50` e `12.50` como o mesmo número. Vazio vira `None`.

    Vírgula porque é assim que se digita dinheiro em português, e o campo é
    preenchido a partir de uma nota fiscal impressa. `None` para vazio, e não
    zero: "não sei quanto custou" e "custou nada" são coisas diferentes — a
    primeira é o lote recebido por doação ou digitado sem a nota.
    """
    limpo = (bruto or "").strip().replace(".", "").replace(",", ".")
    if not limpo:
        return None
    try:
        return Decimal(limpo)
    except InvalidOperation:
        raise EstoqueBloqueado(
            [f"valor unitário inválido: '{bruto.strip()}' não é um número"]
        ) from None


def atualizar_lote(
    s: Session,
    usuario: UsuarioAtual,
    *,
    entrada: EpiEntradaEstoque,
    nota_fiscal: str,
    fornecedor_contato: str,
    observacao: str,
    ativo: bool,
    motivo_inativacao: str,
) -> None:
    """Edição em linha do que é documento, nunca do que é quantidade.

    Nota fiscal, contato e observação se corrigem porque são transcrição de
    papel: digitou o número errado, conserta. **Quantidade não está aqui**, e
    isso é o desenho da tela e não uma omissão: quantidade muda por movimento,
    porque é o movimento que diz quando mudou e por quê. Um campo de saldo
    editável seria o `Qtd_Estoque` do legado de volta.

    Lote não se exclui (RN-31): inativa com motivo, e o `ck_entrada_inativa` do
    banco cobra o motivo. Inativado, ele some da lista de entrega — mas continua
    no estoque, com o saldo à vista, porque o saldo continua existindo.

    **Inativar solta toda reserva do lote**, e não só a que não couber: um lote
    inativo é impedimento em `impedimento_do_lote`, e reserva num lote impedido é
    promessa que já se sabe que não vai ser cumprida. Deixá-la de pé faria o
    pedido continuar dizendo "reservado" enquanto a entrega o recusava.
    """
    usuario.exigir("epi.estoque")
    limpa = textos.exigir_texto_limpo(
        (observacao or "").strip(), campo="observação do lote"
    )
    motivo = textos.exigir_texto_limpo(
        (motivo_inativacao or "").strip(), campo="motivo da inativação"
    )
    if not ativo and not motivo:
        raise EstoqueBloqueado(
            [
                "inativar o lote exige o motivo: é ele que explica, para quem "
                "olhar o saldo parado depois, por que aquelas unidades não saem"
            ]
        )
    campos = {
        "nota_fiscal": _ou_nada(nota_fiscal),
        "fornecedor_contato": _ou_nada(fornecedor_contato),
        "observacao": limpa or None,
        "ativo": ativo,
        "motivo_inativacao": motivo or None,
    }
    antes = {campo: getattr(entrada, campo) for campo in campos}
    inativou = bool(antes["ativo"]) and not ativo
    for campo, valor in campos.items():
        setattr(entrada, campo, valor)
    auditoria.registrar_diferencas(
        s,
        entidade=EpiEntradaEstoque.__tablename__,
        entidade_id=entrada.id,
        antes=antes,
        depois={campo: getattr(entrada, campo) for campo in campos},
        usuario=usuario,
        tipo_evento=EPI_LOTE_ALTERADO,
    )
    sincronizar_pendencia_de_ca(s, entrada, usuario)
    s.flush()
    if inativou:
        from app.servicos import epi_requisicao

        epi_requisicao.soltar_reservas_do_lote(
            s,
            usuario,
            entrada,
            motivo=f"o lote {entrada.lote or '—'} foi inativado: {motivo}",
            tudo=True,
        )


# =====================================================================
# RN-25 — a pendência do CA a vencer
# =====================================================================
def chave_da_pendencia_de_ca(entrada_id: int) -> str:
    return f"ca:entrada:{entrada_id}"


def sincronizar_pendencia_de_ca(
    s: Session, entrada: EpiEntradaEstoque, usuario: UsuarioAtual | None = None
) -> None:
    """Abre a pendência do CA a vencer, ou a fecha quando ela perdeu o objeto.

    **Por que ela é disparada por movimento, e não por relógio.** O sistema não
    tem agendador: toda pendência dele nasce de uma escrita (ver
    `parecer.py`, `direito.py` e `epi_ficha.py`). Aqui a escrita é o movimento —
    entrada do lote, saída, devolução, descarte, ajuste — e a inativação.

    O buraco que isso deixa, dito com todas as letras: **um lote parado, sem
    nenhum movimento, atravessa a janela dos 60 dias sem abrir pendência.** Ele
    aparece etiquetado em `/epis/estoque` desde o primeiro dia da janela, porque
    a tela calcula o estado na hora; o que atrasa é a tarefa com dono e prazo.
    Fechar esse buraco pede um agendador, que é peça nova e não é desta fatia —
    e inventar um laço que abrisse pendência a cada GET da tela poria o nome de
    quem apenas olhou o estoque como responsável pela tarefa.

    Fecha quando a tarefa deixou de existir: saldo zerado (não há o que
    descartar nem renovar) ou lote inativado (a decisão já foi tomada).
    """
    if entrada.validade_ca is None:
        return
    chave = chave_da_pendencia_de_ca(entrada.id)
    saldo = saldo_fisico(s, entrada.id)
    hoje = date.today()
    na_janela = entrada.validade_ca <= hoje + timedelta(days=DIAS_AVISO_CA)

    if saldo <= 0 or not entrada.ativo or not na_janela:
        _fechar_pendencia_de_ca(s, chave, usuario)
        return

    vencido = entrada.validade_ca < hoje
    pendencias.abrir(
        s,
        tipo=TIPO_PENDENCIA_CA,
        chave=chave,
        # A descrição não traz o saldo do momento, de propósito: `abrir` é
        # idempotente por chave e não reescreve o texto, então o número
        # envelheceria na fila enquanto a prateleira anda. O saldo de agora está
        # a um clique, no extrato do lote.
        descricao=(
            f"O CA {entrada.numero_ca or '—'} do lote {entrada.lote or '—'} de "
            f"{entrada.item.nome} "
            + ("VENCEU em " if vencido else "vence em ")
            + f"{datas_br.numerica(entrada.validade_ca)} e o lote ainda tem "
            "saldo em estoque. Pela NR-6 o equipamento deixa de ser EPI: renove "
            "o CA junto ao fabricante ou registre o descarte com motivo."
        ),
        entidade=EpiEntradaEstoque.__tablename__,
        entidade_id=entrada.id,
        # o prazo é a validade do CA, não 60 dias contados de hoje: depois dela
        # o lote já não pode sair, e a tarefa está atrasada por definição
        prazo=entrada.validade_ca,
        usuario=usuario,
    )


def _fechar_pendencia_de_ca(
    s: Session, chave: str, usuario: UsuarioAtual | None
) -> None:
    from app.modelos import Pendencia

    pendencia = s.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one_or_none()
    if pendencia is None or pendencia.concluida:
        return
    if usuario is None:
        # sem usuario e a varredura noturna: a tarefa perdeu o objeto e fecha
        # em nome da rotina, nao de uma pessoa (ver `pendencias.concluir_pela_rotina`)
        pendencias.concluir_pela_rotina(s, pendencia, "o lote saiu da janela do CA, zerou ou foi inativado")
        return
    pendencias.concluir(s, pendencia, usuario)


__all__ = [
    "AJUSTE",
    "DESCARTE",
    "DEVOLUCAO",
    "DIAS_AVISO_CA",
    "ENTRADA",
    "EPI_ESTOQUE_AJUSTADO",
    "EPI_ESTOQUE_DESCARTADO",
    "EPI_LOTE_ALTERADO",
    "EPI_LOTE_REGISTRADO",
    "SAIDA",
    "TIPO_PENDENCIA_CA",
    "EstoqueBloqueado",
    "LinhaDeItem",
    "LinhaDeLote",
    "LinhaDoExtrato",
    "LoteDisponivel",
    "ajustar",
    "atualizar_lote",
    "baixar",
    "chave_da_pendencia_de_ca",
    "descartar",
    "devolver",
    "disponivel",
    "extrato",
    "impedimento_do_lote",
    "lotes_de",
    "panorama",
    "registrar_entrada",
    "reservado",
    "reservas_de_todos",
    "saldo_fisico",
    "saldos_de_todos",
    "sincronizar_pendencia_de_ca",
]
