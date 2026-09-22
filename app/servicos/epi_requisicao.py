"""A requisição de EPI: o pedido formal, com protocolo, decisão e prazo.

Fatia 4 do módulo Gestão de EPI. É aqui que o fornecimento deixa de ser um
e-mail com o assunto "preciso de luva" e vira documento: protocolo consumido no
envio, contexto congelado, decisão **por item** com motivo catalogado, e trilha
de auditoria em cada transição das duas máquinas de estado.

**Duas máquinas, e não uma.** O envelope (`EpiRequisicao`, máquina C) diz em que
ponto do trâmite o pedido está; o item (`EpiRequisicaoItem`, máquina D) é onde a
decisão acontece. O legado misturava as duas coisas numa fila só, e por isso não
conseguia representar o caso comum: aprovar a luva e recusar o respirador do
mesmo pedido. A tela dele já fazia isso; a máquina é que não acompanhou.

Quatro regras moram aqui, e cada uma tem um mecanismo próprio:

1. **RN-03 aplicada ao protocolo.** `EPI-AAAA-NNNN` é consumido no **envio**,
   por `numeracao.proximo_numero_requisicao_epi`, dentro da transação imediata
   de quem chama. Nunca `MAX(numero)+1`, e rascunho abandonado não gasta número.
2. **RN-26 conta a FICHA, não requisições aprovadas.** Aprovação é promessa,
   entrega é fato — e a ficha é a verdade. Estourar a janela não é bloqueio
   duro: é bloqueio até que alguém escreva a justificativa e assine com o
   próprio `usuario.id`, exatamente como `excecao_art9_par_unico` já faz na
   exposição.
3. **RN-27 congela o texto da recusa.** O que a pessoa recebeu é o que fica;
   editar o catálogo amanhã não reescreve a negativa de ontem.
4. **RN-28 é bloqueio duro, sem exceção.** Ver `_exigir_analista_diferente`.

**A reserva, que é a fatia 5.** `APROVADO → RESERVADO → ENTREGUE` passou a ser o
caminho normal, e com ele entraram `SEM_ESTOQUE`, a soltura da reserva com
motivo e a RN-24 valendo sobre `disponivel`, que já não é o físico. O que a
reserva compra é uma coisa só, e ela é o motivo de o estado existir: **impedir
que dois pedidos prometam o mesmo par de botas.** Sem ela, dois analistas
aprovam contra o mesmo saldo e o segundo descobre o problema com a pessoa na
frente.

Três decisões desta fatia que não se leem no código sozinhas:

1. **`SEM_ESTOQUE → RESERVADO` é ação explícita do almoxarifado, não efeito da
   entrada de lote.** Ver `reservar_item`.
2. **Entregar continua sendo `epi_ficha.registrar_entrega`**, e a reserva é
   solta imediatamente antes de chamá-la — senão a RN-24 recusaria a entrega por
   causa da própria promessa que ela vem cumprir. Ver `entregar_item`.
3. **Soltar reserva é sempre com motivo, e vai para `SEM_ESTOQUE`**, não de volta
   para `APROVADO`: o item continua devido e continua sem lote, que é exatamente
   o que `SEM_ESTOQUE` diz. Voltar para `APROVADO` apagaria da tela que houve uma
   promessa desfeita.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.modelos import (
    EpiEntradaEstoque,
    EpiFichaRegistro,
    EpiItem,
    EpiMotivoRecusa,
    EpiRequisicao,
    EpiRequisicaoItem,
    Servidor,
    agora_utc,
)
from app.modelos.epi import FINALIDADES_REQUISICAO, URGENCIAS_REQUISICAO
from app.modelos.estados import (
    EPI_ITEM_DECIDIDO,
    EPI_ITEM_PENDENTE_DE_ATENDIMENTO,
    ROTULO_EPI_ITEM,
    ROTULO_EPI_REQUISICAO,
    exigir_transicao_epi_item,
    exigir_transicao_epi_requisicao,
)
from app.servicos import (
    auditoria,
    datas_br,
    epi_estoque,
    epi_ficha,
    numeracao,
    pendencias,
    servidores as servico_servidores,
    textos,
)
from app.servicos.epi_ficha import EPI_MAXIMO_EXCEDIDO
from app.servicos.rbac import (
    ESCOPO_PROPRIO,
    ESCOPO_UNIDADE,
    PermissaoNegada,
    UsuarioAtual,
    aplicar_escopo,
)

# --- eventos do envelope (máquina C) ---
EPI_REQUISICAO_CRIADA = "EPI_REQUISICAO_CRIADA"
EPI_REQUISICAO_ENVIADA = "EPI_REQUISICAO_ENVIADA"
EPI_REQUISICAO_EM_ANALISE = "EPI_REQUISICAO_EM_ANALISE"
EPI_REQUISICAO_DEVOLVIDA = "EPI_REQUISICAO_DEVOLVIDA"
EPI_REQUISICAO_ANALISADA = "EPI_REQUISICAO_ANALISADA"
EPI_REQUISICAO_INDEFERIDA = "EPI_REQUISICAO_INDEFERIDA"
EPI_REQUISICAO_RECONSIDERADA = "EPI_REQUISICAO_RECONSIDERADA"
EPI_REQUISICAO_EM_ATENDIMENTO = "EPI_REQUISICAO_EM_ATENDIMENTO"
EPI_REQUISICAO_ATENDIDA = "EPI_REQUISICAO_ATENDIDA"
EPI_REQUISICAO_CANCELADA = "EPI_REQUISICAO_CANCELADA"
EPI_REQUISICAO_EXCLUIDA = "EPI_REQUISICAO_EXCLUIDA"

# --- eventos do item (máquina D) ---
EPI_ITEM_APROVADO = "EPI_ITEM_APROVADO"
EPI_ITEM_RECUSADO = "EPI_ITEM_RECUSADO"
EPI_ITEM_CANCELADO = "EPI_ITEM_CANCELADO"
EPI_ITEM_ENTREGUE = "EPI_ITEM_ENTREGUE"
EPI_ITEM_RESERVADO = "EPI_ITEM_RESERVADO"
EPI_ITEM_SEM_ESTOQUE = "EPI_ITEM_SEM_ESTOQUE"
# a reserva desfeita tem evento PRÓPRIO, e não o mesmo `EPI_ITEM_SEM_ESTOQUE` do
# item que nunca chegou a ter lote: os dois terminam no mesmo estado e contam
# coisas diferentes. "Faltou comprar" é planejamento; "prometi e não pude
# cumprir" é o número que diz que o estoque está sendo prometido duas vezes ou
# que o CA está vencendo na prateleira.
EPI_ITEM_RESERVA_SOLTA = "EPI_ITEM_RESERVA_SOLTA"

ENTIDADE = EpiRequisicao.__tablename__
ENTIDADE_ITEM = EpiRequisicaoItem.__tablename__

TIPO_PENDENCIA_SEM_ESTOQUE = "EPI_SEM_ESTOQUE"
# Os dois avisos que vão para o REQUERENTE, e não para a CSSO. Ver o bloco de
# argumento em `pendencias.TIPOS` — inclusive o que deliberadamente não avisa.
TIPO_PENDENCIA_DECISAO = "EPI_DECISAO_A_LER"
TIPO_PENDENCIA_RETIRADA = "EPI_RETIRADA_DISPONIVEL"

# Os estados em que existe decisão tomada e o pedido ainda não terminou. Fora
# deles a tarefa de LER perdeu o objeto, e cada saída tem o seu motivo:
# `EM_ANALISE` porque a reconsideração desfez a decisão que havia para ler;
# `ATENDIDA` porque a pessoa esteve no balcão e recebeu o que foi aprovado — a
# decisão se consumou, e é o mesmo argumento pelo qual a entrega não abre aviso
# nenhum; `CANCELADA` porque não há mais pedido.
#
# `EM_ATENDIMENTO` fica DENTRO, e é a escolha que custa alguma coisa: durante o
# atendimento o requerente pode ter dois avisos deste pedido — ler a decisão e
# retirar o item. Fechar no primeiro lote reservado seria mais limpo e apagaria
# em silêncio, pela pressa do almoxarifado, justamente o aviso de que houve item
# RECUSADO: a negativa fundamentada é a coisa que ele mais precisa ler, e ela
# não sai por mais nenhum canal.
DECIDIDO_E_NAO_LIDO = frozenset({"ANALISADA", "EM_ATENDIMENTO", "INDEFERIDA"})

# Os estados em que o pedido ainda é do requerente e admite edição de conteúdo.
# Só um, e é deliberado: depois de protocolado o pedido é documento, e documento
# não se reescreve — corrige-se por cancelamento com motivo e pedido novo.
EDITAVEL = frozenset({"RASCUNHO"})


class RequisicaoBloqueada(ValueError):
    """O que impede esta operação, tudo de uma vez.

    Lista em vez de primeiro-erro, pela mesma razão do `EntregaBloqueada` da
    ficha e do `EstoqueBloqueado` do estoque: quem está preenchendo o pedido
    precisa saber tudo o que falta numa passada, e não descobrir um problema por
    tentativa.
    """

    def __init__(self, motivos: list[str]):
        self.motivos = motivos
        super().__init__("Requisição bloqueada: " + "; ".join(motivos))


class AutoanaliseProibida(PermissaoNegada):
    """RN-28 — quem analisa não é quem requisita. Bloqueio duro, sem exceção.

    **Por que não existe autoanálise registrada** (decisão do Fabrício, §12.3,
    tomada em 20/08/2026, contra a alternativa "aceitar a exceção e registrar
    quem se autoanalisou"):

    Registrar a autoanálise gravaria "analisado por X" num pedido de X. O banco
    passaria a ter a aparência de um controle que não houve — e a trilha de
    auditoria, que existe justamente para sustentar afirmações perante terceiros,
    passaria a produzir a afirmação falsa em série, uma por pedido. Uma
    fiscalização que abrisse a tabela leria segregação de função onde havia uma
    pessoa só. É pior do que não ter o controle: é ter o registro dele.

    **E a regra não trava trabalho**, que é o argumento de quem quer a exceção. O
    técnico de segurança também usa luva, e o pedido dele continua atendido: a
    entrega avulsa de balcão da fatia 2 (`epi_ficha.registrar_entrega`) já existe,
    já baixa o lote, já congela os snapshots, já confere o CA (RN-25) e a janela
    da RN-26, e já abre a pendência do comprovante assinado. O que ela não produz
    é um pedido decidido por quem o fez — que é exatamente o que não deve existir.

    A mensagem diz **as duas saídas**, e isso não é cortesia: erro que só nega,
    sem dizer o caminho, é o que faz a pessoa contornar o sistema por fora — e o
    contorno por fora é o estado do mundo que este módulo veio consertar.
    """

    def __init__(self, requisicao: EpiRequisicao, nome_servidor: str):
        self.requisicao_id = requisicao.id
        super().__init__(
            "epi.analisar",
            f"Quem analisa não é quem requisita (RN-28): a requisição "
            f"{requisicao.identificacao} é de {nome_servidor}, e essa pessoa é "
            "você. Há duas saídas legítimas, e nenhuma delas é analisar o "
            "próprio pedido: (1) outra pessoa com a permissão de analisar EPI "
            "decide esta requisição; ou (2) o equipamento sai pela entrega "
            "avulsa de balcão (/epis/entregas/nova), que registra a ficha, o "
            "lote, o CA e o comprovante assinado do mesmo jeito — só não produz "
            "um pedido decidido por quem o fez.",
        )


# =====================================================================
# RN-28 — o bloqueio, num lugar só
# =====================================================================
def _exigir_analista_diferente(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao
) -> None:
    """`epi.analisar` mais a conferência de que o analista não é o requerente.

    Uma função só, chamada por TODA operação de análise, porque a regra vale em
    todas: iniciar a análise, aprovar item, recusar item, concluir, indeferir,
    reconsiderar e cancelar pelo lado do SESMT. Espalhar a comparação por sete
    funções seria espalhar sete chances de esquecê-la em uma.

    Compara `requisicao.servidor_id` com `usuario.servidor_id` — quem VAI USAR o
    equipamento, e não quem digitou. A chefia que abre o pedido para a equipe não
    tem conflito de interesse nenhum; quem o tem é a pessoa que vai calçar a bota.
    """
    usuario.exigir("epi.analisar")
    if usuario.servidor_id is None:
        # conta sem vínculo com servidor não pode ser o requerente de nada: não
        # há como ela aparecer em `requisicao.servidor_id`
        return
    if requisicao.servidor_id != usuario.servidor_id:
        return
    servidor = s.get(Servidor, requisicao.servidor_id)
    raise AutoanaliseProibida(requisicao, servidor.nome if servidor else "você mesmo")


# =====================================================================
# As duas transições, no formato de `processo.mover()`
# =====================================================================
def _mover(
    s: Session,
    requisicao: EpiRequisicao,
    destino: str,
    usuario: UsuarioAtual | None,
    *,
    tipo_evento: str,
    comentario: str | None = None,
) -> EpiRequisicao:
    """Uma transição do envelope: confere a máquina, grava e audita.

    Porta única, como `processo.mover()`: o par (origem, destino) é conferido
    contra `TRANSICOES_EPI_REQUISICAO` antes de qualquer escrita, e o evento sai
    com `campo='estado'`, `valor_anterior` e `valor_novo` — que é o formato de
    que a contagem por transição depende.
    """
    origem = requisicao.estado
    exigir_transicao_epi_requisicao(origem, destino)
    requisicao.estado_anterior = origem
    requisicao.estado = destino
    requisicao.entrou_no_estado_em = agora_utc()
    requisicao.versao += 1
    auditoria.registrar(
        s,
        entidade=ENTIDADE,
        entidade_id=requisicao.id,
        tipo_evento=tipo_evento,
        descricao=(
            f"{requisicao.identificacao}: "
            f"{ROTULO_EPI_REQUISICAO.get(origem, origem)} → "
            f"{ROTULO_EPI_REQUISICAO.get(destino, destino)}"
            + (f" — {comentario}" if comentario else "")
        ),
        campo="estado",
        valor_anterior=origem,
        valor_novo=destino,
        comentario=comentario,
        usuario=usuario,
    )
    s.flush()
    # A porta única do envelope, pela mesma razão do `_mover_item`: são sete
    # arestas que entram ou saem de ANALISADA/INDEFERIDA (concluir, indeferir,
    # reconsiderar, reservar, entregar, cancelar), e pendurar o aviso em cada uma
    # seria pendurá-lo em cinco e esquecer a sexta.
    sincronizar_pendencia_de_decisao(s, requisicao, usuario)
    return requisicao


def _mover_item(
    s: Session,
    item: EpiRequisicaoItem,
    destino: str,
    usuario: UsuarioAtual | None,
    *,
    tipo_evento: str,
    comentario: str | None = None,
    valor_novo=None,
    detalhe: str = "",
) -> EpiRequisicaoItem:
    """Uma transição do item. Mesmo formato, mesma disciplina.

    `valor_novo` aceita substituição porque a RN-27 pede o **código do motivo**
    em `valor_novo` no evento de recusa, para que a contagem por motivo saia da
    própria trilha sem depender de casar texto. Quando ninguém o informa, vale o
    estado de destino, como em toda outra transição.
    """
    origem = item.estado
    exigir_transicao_epi_item(origem, destino)
    item.estado = destino
    auditoria.registrar(
        s,
        entidade=ENTIDADE_ITEM,
        entidade_id=item.id,
        tipo_evento=tipo_evento,
        descricao=(
            f"{item.item.nome}: {ROTULO_EPI_ITEM.get(origem, origem)} → "
            f"{ROTULO_EPI_ITEM.get(destino, destino)}"
            + (f" — {detalhe}" if detalhe else "")
        ),
        campo="estado",
        valor_anterior=origem,
        valor_novo=destino if valor_novo is None else valor_novo,
        comentario=comentario,
        usuario=usuario,
    )
    s.flush()
    # A pendência de falta entra AQUI, na porta única das transições do item, e
    # não em `marcar_sem_estoque`: são cinco arestas que entram ou saem de
    # `SEM_ESTOQUE` (aprovar, faltar, soltar reserva, reservar, entregar,
    # cancelar), e pendurar a sincronização em cada uma seria pendurá-la em
    # quatro e esquecer a quinta. É a mesma razão pela qual a transição inteira
    # tem porta única.
    sincronizar_pendencia_de_falta(s, item, usuario)
    sincronizar_pendencia_de_retirada(s, item, usuario)
    return item


# =====================================================================
# Fatia 7 — o item parado em SEM_ESTOQUE vai para o sino
# =====================================================================
def chave_da_pendencia_de_falta(linha_id: int) -> str:
    return f"sem_estoque:requisicao_item:{linha_id}"


def sincronizar_pendencia_de_falta(
    s: Session, linha: EpiRequisicaoItem, usuario: UsuarioAtual | None = None
) -> None:
    """Abre a pendência do item sem estoque, ou a fecha quando ela perdeu o objeto.

    **Por que ela existe.** A fatia 5 recusou reservar sozinha quando o lote
    entra, e a razão continua de pé: reserva automática mudaria o disponível sem
    ninguém mandar, e escolher quem fica com estoque escasso é decisão, não ordem
    de laço por `id`. Mas o que substituiu o automatismo foi uma **mensagem na
    tela de entrada de lote** — vista só por quem estivesse lançando naquele
    momento e por mais ninguém depois. O item ficava dependendo de alguém lembrar
    dele, o que é a definição de pedido esquecido.

    A pendência não desfaz aquela decisão: ela não reserva nada. Ela põe a
    lembrança no sino, com dono e prazo, e deixa a reserva onde estava — na mão
    de quem responde por ela.

    O dono é quem marcou a falta: é o almoxarifado que compra, e é ele que sabe
    se o item entrou no próximo pregão.

    Fecha sozinha na saída do estado, seja qual for: reservado, entregue ou
    cancelado, o item deixou de esperar. Não há caminho em que a tarefa continue
    aberta depois de o pedido andar.
    """
    if usuario is None:  # pragma: no cover - toda transição tem autor
        return
    from app.modelos import Pendencia

    chave = chave_da_pendencia_de_falta(linha.id)
    if linha.estado != "SEM_ESTOQUE":
        pendencia = s.execute(
            select(Pendencia).where(Pendencia.chave == chave)
        ).scalar_one_or_none()
        if pendencia is not None and not pendencia.concluida:
            pendencias.concluir(s, pendencia, usuario)
        return

    # Ida e volta é o caminho normal aqui: o item pode ser reservado e ter a
    # reserva solta, e aí ele está sem estoque de novo, pelo mesmo motivo de
    # antes. `abrir` é idempotente por chave e devolveria a concluída sem
    # reabrir — o item sairia do sino em silêncio. Ver `pendencias.reabrir`.
    existente = s.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one_or_none()
    if existente is not None:
        if existente.concluida:
            pendencias.reabrir(
                s,
                existente,
                usuario,
                "o item voltou a esperar estoque",
            )
        return

    requisicao = linha.requisicao
    pendencias.abrir(
        s,
        tipo=TIPO_PENDENCIA_SEM_ESTOQUE,
        chave=chave,
        # RN-19: o pedido é identificado pelo protocolo, que não nomeia ninguém —
        # e é por ele que a conversa acontece no balcão. O nome de quem pediu
        # está a um clique, na ficha do pedido, para quem pode lê-lo.
        descricao=(
            f"{linha.quantidade_devida} × '{linha.item.nome}'"
            + (f" tamanho {linha.tamanho}" if linha.tamanho else "")
            + f" do pedido {requisicao.identificacao} está aprovado e sem lote "
            "desde " + datas_br.numerica(date.today()) + ". Compre, reserve o "
            "que entrar ou diga ao requerente que o item não vem — item aprovado "
            "que ninguém mais olha é proteção que a pessoa não recebeu."
        ),
        entidade=ENTIDADE_ITEM,
        entidade_id=linha.id,
        usuario=usuario,
    )


# =====================================================================
# Os dois avisos do requerente — a jornada que morria depois do protocolo
# =====================================================================
def _conta_do_requerente(s: Session, requisicao: EpiRequisicao) -> int | None:
    """A conta que deve receber o aviso, ou `None` se não há nenhuma.

    Quem vai USAR o equipamento vem primeiro: é dele o pedido, e é ele que
    precisa ler a negativa e ir ao balcão. Só que nem todo servidor tem conta —
    o cadastro de pessoas é maior que o de contas —, e aí o endereço legítimo é
    quem digitou (`solicitado_por_id`), que é a chefia ou a secretaria que abriu
    o pedido pela pessoa e é quem vai lhe repassar o recado.

    **Sem conta nenhuma, não abre tarefa.** `pendencias.abrir` cai em
    `usuario.id` quando `responsavel_id` vem vazio, e isso poria o aviso do
    requerente no sino de quem analisou — tarefa que o dono não pode cumprir e
    que ninguém pode riscar da lista, que é a definição de ruído. Aviso sem
    destinatário não é aviso.
    """
    from app.modelos import Usuario

    conta = s.execute(
        select(Usuario.id)
        .where(Usuario.servidor_id == requisicao.servidor_id, Usuario.ativo.is_(True))
        .order_by(Usuario.id)
    ).scalars().first()
    return conta or requisicao.solicitado_por_id


def chave_da_pendencia_de_decisao(requisicao_id: int) -> str:
    return f"decisao:requisicao:{requisicao_id}"


def chave_da_pendencia_de_retirada(linha_id: int) -> str:
    return f"retirada:requisicao_item:{linha_id}"


def sincronizar_pendencia_de_decisao(
    s: Session, requisicao: EpiRequisicao, usuario: UsuarioAtual | None = None
) -> None:
    """Põe a decisão no sino de quem pediu — e a tira de lá quando ela envelhece.

    **O defeito que ela fecha.** A auditoria da jornada mediu o sino do
    requerente: zero ao enviar, zero depois de aprovado, recusado, analisado e
    reservado. Para descobrir que o pedido foi decidido ele tinha de reabrir
    `/epis/requisicoes` por conta própria. O motivo da recusa já saía
    fundamentado e congelado na ficha (RN-27) — e ninguém lhe dizia que havia o
    que ler.

    **Uma tarefa por PEDIDO, e não por item.** A decisão é por item, mas a
    leitura é uma só: cinco linhas decididas no mesmo ato produziriam cinco
    tarefas idênticas apontando para a mesma tela, e cinco linhas no sino de quem
    tem um pedido é o que faz alguém parar de abrir o sino.

    **Quando fecha.** Sozinha, na saída de `DECIDIDO_E_NAO_LIDO` — é a mesma
    forma de `sincronizar_pendencia_de_falta`, e pelo mesmo motivo: tarefa que
    depende de alguém lembrar de fechá-la vira lista morta. O dono também pode
    riscá-la assim que ler (`pendencias.pode_concluir` já deixa o responsável
    fechar a própria), e é esse o caminho normal.

    **RN-19.** A descrição não nomeia ninguém: o pedido entra pelo protocolo,
    que já é identificador sem nome, no mesmo espírito do `servidor #{id}` que
    `direito.py:243` pratica. Quem quiser saber de quem é o pedido abre a ficha,
    onde a identificação continua governada pela regra de sempre.
    """
    if usuario is None:  # pragma: no cover - toda transição tem autor
        return
    from app.modelos import Pendencia

    chave = chave_da_pendencia_de_decisao(requisicao.id)
    existente = s.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one_or_none()

    if requisicao.estado not in DECIDIDO_E_NAO_LIDO:
        if existente is not None and not existente.concluida:
            pendencias.concluir(s, existente, usuario)
        return

    if existente is not None:
        # Reconsiderar e decidir de novo é decisão NOVA sobre o mesmo pedido, e
        # `abrir` devolveria a concluída sem reabrir nada — o segundo desfecho
        # não chegaria ao requerente. Ver `pendencias.reabrir`.
        if existente.concluida:
            pendencias.reabrir(
                s, existente, usuario, "o pedido foi decidido de novo"
            )
        return

    dono = _conta_do_requerente(s, requisicao)
    if dono is None:
        return

    if requisicao.estado == "INDEFERIDA":
        motivo = requisicao.motivo_recusa
        descricao = (
            f"O pedido {requisicao.identificacao} foi indeferido"
            + (f" — motivo {motivo.codigo}" if motivo else "")
            + ". Abra o pedido e leia a negativa: o texto é o que estava vigente "
            "no dia da decisão e não muda depois (RN-27). Discordando, o caminho "
            "é pedir reconsideração à CSSO, não abrir outro pedido igual."
        )
    else:
        aprovados = sum(1 for i in requisicao.itens if i.estado == "APROVADO")
        recusados = sum(1 for i in requisicao.itens if i.estado == "RECUSADO")
        descricao = (
            f"O pedido {requisicao.identificacao} foi decidido: {aprovados} item(ns) "
            f"aprovado(s) e {recusados} recusado(s). Abra o pedido e leia — o "
            "motivo de cada recusa fica escrito como você o recebeu, e o que foi "
            "aprovado ainda depende de haver lote no estoque."
        )

    pendencias.abrir(
        s,
        tipo=TIPO_PENDENCIA_DECISAO,
        chave=chave,
        descricao=descricao,
        entidade=ENTIDADE,
        entidade_id=requisicao.id,
        responsavel_id=dono,
        usuario=usuario,
    )


def sincronizar_pendencia_de_retirada(
    s: Session, linha: EpiRequisicaoItem, usuario: UsuarioAtual | None = None
) -> None:
    """O aviso que faz a pessoa ir buscar — e some quando ela buscou.

    A reserva é o único momento em que existe equipamento separado com o nome
    deste pedido. Até a fatia do requerente ela era invisível para quem pediu: a
    ficha dizia "1 reservado(s) no lote L-2026-08" para quem abrisse a tela, e
    ninguém abria a tela porque nada avisava que havia o que ver. O custo é dos
    dois lados — a pessoa continua sem o EPI, e a reserva segura estoque que
    nenhum outro pedido pode receber.

    Irmã de `sincronizar_pendencia_de_falta`, na mesma porta única e com a mesma
    disciplina: enquanto o item está `RESERVADO` a tarefa existe; em qualquer
    saída — entregue, reserva solta, cancelado — ela fecha sozinha. As duas nunca
    coexistem, porque os estados que as abrem são mutuamente exclusivos.

    O dono é o requerente, e não o almoxarifado: a tarefa é ir buscar.
    """
    if usuario is None:  # pragma: no cover - toda transição tem autor
        return
    from app.modelos import Pendencia

    chave = chave_da_pendencia_de_retirada(linha.id)
    existente = s.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one_or_none()

    if linha.estado != "RESERVADO":
        if existente is not None and not existente.concluida:
            pendencias.concluir(s, existente, usuario)
        return

    if existente is not None:
        if existente.concluida:
            pendencias.reabrir(
                s, existente, usuario, "o item voltou a ter lote reservado"
            )
        return

    requisicao = linha.requisicao
    dono = _conta_do_requerente(s, requisicao)
    if dono is None:
        return

    pendencias.abrir(
        s,
        tipo=TIPO_PENDENCIA_RETIRADA,
        chave=chave,
        # RN-19: quantidade, item e protocolo. Nome de equipamento não identifica
        # pessoa, e o protocolo é o que se diz no balcão.
        descricao=(
            f"{linha.quantidade_reservada} × '{linha.item.nome}'"
            + (f" tamanho {linha.tamanho}" if linha.tamanho else "")
            + f" do pedido {requisicao.identificacao} está separado no lote "
            f"{_rotulo_do_lote(s, linha.entrada_id)} e espera você retirar. Abra "
            "o pedido: é lá que está onde e quando retirar. Reserva parada segura "
            "estoque que nenhum outro pedido pode receber."
        ),
        entidade=ENTIDADE,
        entidade_id=requisicao.id,
        responsavel_id=dono,
        usuario=usuario,
    )


def requisicoes_de(s: Session, servidor_id: int) -> list[EpiRequisicao]:
    return list(
        s.execute(
            select(EpiRequisicao)
            .where(EpiRequisicao.servidor_id == servidor_id)
            .order_by(EpiRequisicao.id.desc())
        ).scalars()
    )


def _no_escopo(consulta, usuario: UsuarioAtual):
    """A terceira camada sobre `EpiRequisicao` — com as duas ressalvas do modelo.

    O eixo é o de `aplicar_escopo`: `epi_requisicao.servidor_id` é a coluna que
    ele procura, existe desde a criação do rascunho e nunca é nula. É o que
    `desenho_epi.md:1129-1132` e o comentário do perfil em `rbac.py:389-392`
    sempre afirmaram — e o que, até a 1.34.0, nada fazia: `aplicar_escopo` não
    era chamado uma única vez em `app/rotas/epi_*.py`.

    As duas ressalvas são do modelo, não do escopo, e por isso ficam aqui e não
    dentro de `aplicar_escopo`, que vale para o sistema inteiro:

    - **Unidade.** `campus_id` só é congelado no **envio**
      (`PENDENCIAS.md:251-255`). Filtrar por ele esconderia do próprio setor todo
      rascunho ainda em digitação — rascunho sem campus não é de outra unidade, é
      de nenhuma ainda.
    - **Próprio.** O pedido tem duas pessoas, e `solicitado_por_id` é a segunda.

    O caminho `ESCOPO_TOTAL`/`AGREGADO` desce para `aplicar_escopo` inteiro.
    """
    if usuario.escopo == ESCOPO_UNIDADE and usuario.campi:
        return consulta.where(
            or_(
                EpiRequisicao.campus_id.in_(usuario.campi),
                EpiRequisicao.campus_id.is_(None),
            )
        )
    if usuario.escopo == ESCOPO_PROPRIO:
        # `solicitado_por_id` entra ao lado de `servidor_id` porque o pedido tem
        # duas pessoas: quem vai usar o equipamento e quem digitou (a RN-28 olha
        # a primeira, e por isso as duas colunas existem separadas). Sem o
        # segundo ramo, quem abrisse um rascunho para outra pessoa perderia o
        # proprio rascunho na volta — a tela some, o pedido fica, e ninguem
        # descobre. E nao alarga nada: `solicitado_por_id` e a conta que gravou,
        # e nenhuma requisicao alheia nasce com ela.
        return consulta.where(
            or_(
                EpiRequisicao.servidor_id == (usuario.servidor_id or -1),
                EpiRequisicao.solicitado_por_id == usuario.id,
            )
        )
    return aplicar_escopo(consulta, usuario, EpiRequisicao)


def no_escopo(
    s: Session, usuario: UsuarioAtual, requisicao_id: int
) -> EpiRequisicao | None:
    """A única leitura de requisição por id. Devolve `None` ou a linha.

    Fora do escopo e inexistente devolvem a mesma coisa de propósito: a ficha
    traz rotina de trabalho e riscos declarados pelo próprio requerente, texto
    que o `docs/ROPA.md` §0.2 identifica como onde dado de saúde entra por
    engano. Quem responde "existe, mas não é seu" já disse o que a fila não devia
    ter dito.
    """
    consulta = select(EpiRequisicao).where(EpiRequisicao.id == requisicao_id)
    return s.execute(_no_escopo(consulta, usuario)).scalar_one_or_none()


def fila(
    s: Session, usuario: UsuarioAtual, *, estados: tuple[str, ...] = ()
) -> list[EpiRequisicao]:
    """A fila de `/epis/requisicoes`, do mais antigo para o mais novo.

    Ordem por `id`, e não por `enviada_em`: rascunho não tem data de envio, e
    ordenar por coluna nula joga o pedido em digitação para uma ponta arbitrária
    da lista. `id` é a ordem em que os pedidos nasceram, e ela sempre existe.

    `usuario` é obrigatório e não tem padrão: fila sem escopo foi exatamente o
    defeito, e um parâmetro opcional deixaria a próxima chamada esquecê-lo em
    silêncio — que é como este módulo chegou até aqui.
    """
    consulta = select(EpiRequisicao)
    if estados:
        consulta = consulta.where(EpiRequisicao.estado.in_(estados))
    consulta = _no_escopo(consulta, usuario)
    return list(s.execute(consulta.order_by(EpiRequisicao.id)).scalars())


# =====================================================================
# O rascunho
# =====================================================================
def criar_rascunho(
    s: Session,
    usuario: UsuarioAtual,
    *,
    servidor: Servidor,
    chefia_servidor_id: int | None = None,
    finalidade: str = "ROTINA",
    descricao_atividade: str = "",
    riscos_declarados: str = "",
    urgencia: str = "NORMAL",
    justificativa_urgencia: str = "",
) -> EpiRequisicao:
    """O pedido em digitação. **Não consome protocolo** — ver RN-03.

    Nasce sem item nenhum: os itens entram por `adicionar_item`, e é o `enviar`
    que cobra pelo menos um. Exigir o primeiro item aqui obrigaria a tela a
    montar o cabeçalho e a primeira linha num POST só, e um erro de digitação na
    linha perderia o cabeçalho inteiro.
    """
    usuario.exigir("epi.requisitar")
    campos = _campos_do_cabecalho(
        finalidade=finalidade,
        descricao_atividade=descricao_atividade,
        riscos_declarados=riscos_declarados,
        urgencia=urgencia,
        justificativa_urgencia=justificativa_urgencia,
    )
    requisicao = EpiRequisicao(
        servidor_id=servidor.id,
        solicitado_por_id=usuario.id,
        chefia_servidor_id=chefia_servidor_id,
        estado="RASCUNHO",
        **campos,
    )
    s.add(requisicao)
    s.flush()
    auditoria.registrar(
        s,
        entidade=ENTIDADE,
        entidade_id=requisicao.id,
        tipo_evento=EPI_REQUISICAO_CRIADA,
        # RN-19 na ESCRITA: esta é a frase que a auditoria mediu identificada em
        # `/epis/requisicoes/6` e que o docstring de `identificacao.texto_livre`
        # cita como o caso. O pedido sai pelo id do servidor, como `direito.py:243`
        # já pratica: quem pode ler resolve quem é pela ficha, que é onde a
        # leitura nominal fica registrada (RN-23). Quem operou continua nominal —
        # a trilha imprime `usuario_nome` na coluna ao lado, por desenho.
        descricao=(
            f"Rascunho de requisição de EPI para o servidor #{servidor.id} "
            f"aberto por {usuario.nome}"
        ),
        campo="estado",
        valor_novo="RASCUNHO",
        usuario=usuario,
    )
    s.flush()
    return requisicao


def atualizar_rascunho(
    s: Session,
    usuario: UsuarioAtual,
    requisicao: EpiRequisicao,
    *,
    chefia_servidor_id: int | None = None,
    finalidade: str = "ROTINA",
    descricao_atividade: str = "",
    riscos_declarados: str = "",
    urgencia: str = "NORMAL",
    justificativa_urgencia: str = "",
) -> EpiRequisicao:
    """Edita o cabeçalho enquanto ele é rascunho, e só enquanto.

    Depois do envio o pedido é documento protocolado: corrigir passa a ser
    cancelar com motivo e abrir outro. É a mesma escolha do parecer emitido —
    editar em silêncio o que já circulou é o que faz o papel na mão da pessoa
    deixar de corresponder ao que o banco diz.
    """
    usuario.exigir("epi.requisitar")
    _exigir_editavel(requisicao, "editar o pedido")
    campos = _campos_do_cabecalho(
        finalidade=finalidade,
        descricao_atividade=descricao_atividade,
        riscos_declarados=riscos_declarados,
        urgencia=urgencia,
        justificativa_urgencia=justificativa_urgencia,
    )
    antes = {campo: getattr(requisicao, campo) for campo in campos}
    antes["chefia_servidor_id"] = requisicao.chefia_servidor_id
    for campo, valor in campos.items():
        setattr(requisicao, campo, valor)
    requisicao.chefia_servidor_id = chefia_servidor_id
    depois = {campo: getattr(requisicao, campo) for campo in antes}
    auditoria.registrar_diferencas(
        s,
        entidade=ENTIDADE,
        entidade_id=requisicao.id,
        antes=antes,
        depois=depois,
        usuario=usuario,
    )
    s.flush()
    return requisicao


def _campos_do_cabecalho(
    *,
    finalidade: str,
    descricao_atividade: str,
    riscos_declarados: str,
    urgencia: str,
    justificativa_urgencia: str,
) -> dict:
    """Valida e limpa o cabeçalho. RN-30 antes de qualquer gravação.

    Os três textos livres passam por `exigir_texto_limpo` **aqui**, e não na
    rota: "rotina de trabalho e exposição alegada" é exatamente o campo em que
    alguém escreve "tenho problema de coluna", e a regra tem de valer para quem
    chama o serviço direto tanto quanto para quem preenche o formulário.
    """
    problemas: list[str] = []
    if finalidade not in FINALIDADES_REQUISICAO:
        problemas.append(
            f"finalidade desconhecida: {finalidade!r}. Conhecidas: "
            + ", ".join(FINALIDADES_REQUISICAO)
        )
    if urgencia not in URGENCIAS_REQUISICAO:
        problemas.append(
            f"urgência desconhecida: {urgencia!r}. Conhecidas: "
            + ", ".join(URGENCIAS_REQUISICAO)
        )
    justificativa = (justificativa_urgencia or "").strip()
    if urgencia == "URGENTE" and not justificativa:
        problemas.append(
            "pedido urgente exige a justificativa da urgência: sem ela "
            "'urgente' vira o padrão de todo mundo e deixa de ordenar a fila"
        )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    return {
        "finalidade": finalidade,
        "descricao_atividade": textos.exigir_texto_limpo(
            (descricao_atividade or "").strip(), campo="rotina de trabalho"
        )
        or None,
        "riscos_declarados": textos.exigir_texto_limpo(
            (riscos_declarados or "").strip(), campo="riscos declarados"
        )
        or None,
        "urgencia": urgencia,
        "justificativa_urgencia": textos.exigir_texto_limpo(
            justificativa, campo="justificativa da urgência"
        )
        or None,
    }


def _exigir_editavel(requisicao: EpiRequisicao, acao: str) -> None:
    if requisicao.estado in EDITAVEL:
        return
    raise RequisicaoBloqueada(
        [
            f"{acao} só é possível enquanto a requisição é rascunho, e "
            f"{requisicao.identificacao} está em "
            f"{ROTULO_EPI_REQUISICAO.get(requisicao.estado, requisicao.estado).lower()}. "
            "Pedido protocolado se corrige por cancelamento com motivo e pedido "
            "novo (RN-31) — não por edição em silêncio do que já circulou"
        ]
    )


def excluir_rascunho(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao
) -> None:
    """RN-31 — o único estado que some de verdade.

    Rascunho não é documento de ninguém: não tem protocolo, não foi lido por
    ninguém e não gerou expectativa. Tudo o mais se cancela com motivo.

    O evento de exclusão é gravado **antes** do `delete`, e sobrevive a ele: a
    trilha é append-only e independente, e é o único lugar em que fica registrado
    que existiu um pedido ali. Apagar sem rastro seria repetir o defeito do
    legado, em que a linha da planilha sumia e nada dizia que ela existiu.
    """
    usuario.exigir("epi.requisitar")
    if requisicao.estado != "RASCUNHO":
        raise RequisicaoBloqueada(
            [
                f"{requisicao.identificacao} está em "
                f"{ROTULO_EPI_REQUISICAO.get(requisicao.estado, requisicao.estado).lower()} "
                "e não se exclui: requisição enviada cancela com motivo (RN-31). "
                "Só rascunho pode sumir de verdade"
            ]
        )
    auditoria.registrar(
        s,
        entidade=ENTIDADE,
        entidade_id=requisicao.id,
        tipo_evento=EPI_REQUISICAO_EXCLUIDA,
        # RN-19 na ESCRITA, como em `criar_rascunho`. O id do servidor vem da
        # própria requisição e não precisa mais do `s.get(Servidor, ...)` que
        # existia só para ler o nome — e que devolvia `None` quando o cadastro
        # tinha sumido, obrigando a frase a inventar "servidor removido".
        descricao=(
            f"Rascunho #{requisicao.id} de requisição de EPI para o servidor "
            f"#{requisicao.servidor_id} excluído por {usuario.nome} — "
            f"{len(requisicao.itens)} item(ns) em digitação"
        ),
        campo="estado",
        valor_anterior="RASCUNHO",
        valor_novo=None,
        usuario=usuario,
    )
    s.delete(requisicao)
    s.flush()


# =====================================================================
# Os itens do rascunho
# =====================================================================
def adicionar_item(
    s: Session,
    usuario: UsuarioAtual,
    requisicao: EpiRequisicao,
    *,
    item: EpiItem,
    quantidade: int,
    tamanho: str = "",
    justificativa: str = "",
) -> EpiRequisicaoItem:
    """Uma linha do pedido. Item inativo não entra; quantidade tem de ser > 0.

    A RN-29 (justificativa onde o catálogo exige) **não** é cobrada aqui, e sim
    no envio: o `uq_req_item` já obriga a linha a nascer inteira, e travar o
    acréscimo obrigaria a pessoa a escrever a justificativa antes de ver o
    pedido tomar forma. O envio é o ato que produz o documento, e é lá que a
    conferência tem de estar completa.
    """
    usuario.exigir("epi.requisitar")
    _exigir_editavel(requisicao, "acrescentar item")
    problemas: list[str] = []
    if quantidade <= 0:
        problemas.append("a quantidade pedida tem de ser maior que zero")
    if not item.ativo:
        problemas.append(
            f"'{item.nome}' está inativo no catálogo e não pode ser requisitado"
        )
    limpo = (tamanho or "").strip()
    tamanhos = item.lista_de_tamanhos
    if tamanhos and limpo and limpo not in tamanhos:
        problemas.append(
            f"'{limpo}' não é um dos tamanhos cadastrados para '{item.nome}': "
            + ", ".join(tamanhos)
        )
    if tamanhos and not limpo:
        problemas.append(
            f"'{item.nome}' tem tamanho cadastrado ({', '.join(tamanhos)}): "
            "pedir sem dizer qual é pedir o que não se pode separar da prateleira"
        )
    if _linha_igual(requisicao, item.id, limpo) is not None:
        problemas.append(
            f"'{item.nome}' já está no pedido com este tamanho: some as "
            "quantidades numa linha só, em vez de repetir o item"
        )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    linha = EpiRequisicaoItem(
        epi_item_id=item.id,
        tamanho=limpo or None,
        quantidade_solicitada=quantidade,
        justificativa=textos.exigir_texto_limpo(
            (justificativa or "").strip(), campo="justificativa do item"
        )
        or None,
        estado="SOLICITADO",
    )
    # pela coleção, e não por `requisicao_id=`: `itens` já está carregada
    # (`lazy="selectin"`), e gravar a FK à mão deixaria a linha no banco e fora
    # da coleção em memória — o `enviar` seguinte contaria zero itens e recusaria
    # o envio de um pedido que tem item
    requisicao.itens.append(linha)
    s.flush()
    return linha


def editar_item(
    s: Session,
    usuario: UsuarioAtual,
    linha: EpiRequisicaoItem,
    *,
    quantidade: int,
    tamanho: str = "",
    justificativa: str = "",
) -> EpiRequisicaoItem:
    usuario.exigir("epi.requisitar")
    _exigir_editavel(linha.requisicao, "editar item")
    problemas: list[str] = []
    if quantidade <= 0:
        problemas.append("a quantidade pedida tem de ser maior que zero")
    limpo = (tamanho or "").strip()
    tamanhos = linha.item.lista_de_tamanhos
    if tamanhos and limpo not in tamanhos:
        problemas.append(
            f"'{limpo or '—'}' não é um dos tamanhos cadastrados para "
            f"'{linha.item.nome}': " + ", ".join(tamanhos)
        )
    outra = _linha_igual(linha.requisicao, linha.epi_item_id, limpo)
    if outra is not None and outra.id != linha.id:
        problemas.append(
            f"já existe outra linha de '{linha.item.nome}' com este tamanho"
        )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    linha.quantidade_solicitada = quantidade
    linha.tamanho = limpo or None
    linha.justificativa = (
        textos.exigir_texto_limpo(
            (justificativa or "").strip(), campo="justificativa do item"
        )
        or None
    )
    s.flush()
    return linha


def remover_item(s: Session, usuario: UsuarioAtual, linha: EpiRequisicaoItem) -> None:
    """Some de verdade — mas só dentro do rascunho, que também some.

    Depois do envio a linha existe dentro de um documento protocolado, e sair
    dele é `cancelar_item`, com motivo. Não há caminho em que uma linha
    desapareça de um pedido que alguém já leu.
    """
    usuario.exigir("epi.requisitar")
    requisicao = linha.requisicao
    _exigir_editavel(requisicao, "remover item")
    # pela coleção (`delete-orphan` apaga a linha), pelo mesmo motivo do
    # `adicionar_item`: `s.delete` sozinho deixaria a coleção em memória
    # dizendo que o item ainda está lá
    requisicao.itens.remove(linha)
    s.flush()


def _linha_igual(
    requisicao: EpiRequisicao, epi_item_id: int, tamanho: str
) -> EpiRequisicaoItem | None:
    """A conferência que o `uq_req_item` faz no banco, feita antes, em Python.

    Existe para a mensagem: o `IntegrityError` do índice único diria
    "UNIQUE constraint failed: epi_requisicao_item.requisicao_id, ..." para quem
    só quis pedir mais uma luva.
    """
    alvo = tamanho or None
    for linha in requisicao.itens:
        if linha.epi_item_id == epi_item_id and (linha.tamanho or None) == alvo:
            return linha
    return None


# =====================================================================
# Enviar — o protocolo, o congelamento e a RN-29
# =====================================================================
def enviar(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao, *, quando: date | None = None
) -> EpiRequisicao:
    """RASCUNHO → ENVIADA. É aqui que o pedido vira documento.

    A ordem importa, e é esta:

    1. permissão e estado;
    2. **validar tudo** — ≥1 item e a RN-29, antes de gastar número;
    3. congelar o contexto de lotação (§3.6, mesmo princípio da RN-15);
    4. consumir o protocolo na sequência (RN-03);
    5. mover a máquina C e auditar.

    O passo 4 depois do 2 não é detalhe: número consumido por um envio que a
    validação vai recusar é um buraco na sequência que ninguém consegue explicar
    depois. O da numeração do parecer segue a mesma ordem, pelo mesmo motivo.
    """
    usuario.exigir("epi.requisitar")
    quando = quando or date.today()
    if requisicao.estado != "RASCUNHO":
        raise RequisicaoBloqueada(
            [
                f"{requisicao.identificacao} já foi enviada — o protocolo é "
                "consumido uma vez só"
            ]
        )

    problemas: list[str] = []
    if not requisicao.itens:
        problemas.append(
            "o pedido não tem nenhum item: um envelope vazio ocuparia protocolo "
            "e fila sem pedir nada"
        )
    # RN-29 — justificativa obrigatória onde o CATÁLOGO exige. Depende de outra
    # tabela (`epi_item.exige_justificativa`), então mora no serviço e não num
    # `CHECK`: o banco não enxerga a linha do catálogo daqui.
    for linha in requisicao.itens:
        if linha.item.exige_justificativa and not (linha.justificativa or "").strip():
            problemas.append(
                f"'{linha.item.nome}' exige justificativa no catálogo e a linha "
                "está sem: diga por que este equipamento é necessário neste posto"
            )
        if not linha.item.ativo:
            problemas.append(
                f"'{linha.item.nome}' foi inativado no catálogo depois de entrar "
                "no rascunho: remova a linha ou escolha o item que o substituiu"
            )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    _congelar_lotacao(s, requisicao, quando)

    ano = quando.year
    numero = numeracao.proximo_numero_requisicao_epi(s, ano)
    requisicao.ano = ano
    requisicao.numero = numero
    requisicao.protocolo = protocolo_de(ano, numero)
    requisicao.enviada_em = agora_utc()

    return _mover(
        s,
        requisicao,
        "ENVIADA",
        usuario,
        tipo_evento=EPI_REQUISICAO_ENVIADA,
        comentario=(
            f"{len(requisicao.itens)} item(ns) · "
            f"{'URGENTE' if requisicao.urgencia == 'URGENTE' else 'normal'}"
        ),
    )


def protocolo_de(ano: int, numero: int) -> str:
    """`EPI-2026-0001`. Quatro dígitos porque a fila do setor é anual e pequena;
    se um dia passar de 9999, o formato cresce sozinho em vez de truncar."""
    return f"EPI-{ano}-{numero:04d}"


def _congelar_lotacao(s: Session, requisicao: EpiRequisicao, quando: date) -> None:
    """Onde a pessoa estava NO ENVIO — não onde ela está hoje.

    Mesmo critério do `_posto_e_unidade` da ficha e do `_lotacao_na_data` do
    certificado: a lotação vigente na data, com o cadastro atual como fallback
    para quem ainda não tem histórico datado.

    Um pedido fundamentado no risco do laboratório não pode, depois que a pessoa
    for transferida, passar a dizer que veio da secretaria — a decisão ficaria
    descrevendo outro lugar, e é a decisão que se tem de poder defender depois.
    """
    servidor = s.get(Servidor, requisicao.servidor_id)
    if servidor is None:  # pragma: no cover - FK impede
        return
    lotacao = servico_servidores.lotacao_em(s, servidor.id, quando)
    unidade = (lotacao.unidade if lotacao else None) or servidor.unidade
    postos = lotacao.postos if lotacao else []
    cargo = (lotacao.cargo if lotacao else None) or servidor.cargo
    funcao = (lotacao.funcao if lotacao else None) or servidor.funcao

    requisicao.unidade_uorg_id = unidade.id if unidade else None
    requisicao.campus_id = unidade.campus_id if unidade else None
    # um posto, e o primeiro da ordem: a lotação admite vários (o mesmo servidor
    # atende dois laboratórios), mas o pedido de EPI é sobre o risco de UM posto
    # — e escolher qual é ato de quem pede, não do sistema. O primeiro é o
    # principal na ordem que o cadastro já mantém.
    requisicao.posto_trabalho_id = postos[0].id if postos else None
    requisicao.cargo_snapshot = cargo.nome if cargo else None
    requisicao.funcao_snapshot = funcao or None


# =====================================================================
# A análise — envelope
# =====================================================================
def iniciar_analise(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao
) -> EpiRequisicao:
    """ENVIADA → EM_ANALISE. Quem pega o pedido assume o nome nele."""
    _exigir_analista_diferente(s, usuario, requisicao)
    requisicao.analisado_por = usuario.id
    requisicao.analisado_em = agora_utc()
    return _mover(
        s,
        requisicao,
        "EM_ANALISE",
        usuario,
        tipo_evento=EPI_REQUISICAO_EM_ANALISE,
        comentario=f"em análise com {usuario.nome}",
    )


def devolver_para_fila(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao, motivo: str
) -> EpiRequisicao:
    """EM_ANALISE → ENVIADA. O analista solta o pedido, com o motivo na trilha.

    Existe porque a alternativa é pior: sem essa aresta, a única saída de
    EM_ANALISE seria decidir — e decidir sem base é pior do que devolver.
    """
    _exigir_analista_diferente(s, usuario, requisicao)
    limpo = _motivo_obrigatorio(motivo, "motivo da devolução à fila")
    requisicao.analisado_por = None
    requisicao.analisado_em = None
    return _mover(
        s,
        requisicao,
        "ENVIADA",
        usuario,
        tipo_evento=EPI_REQUISICAO_DEVOLVIDA,
        comentario=limpo,
    )


def concluir_analise(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao, *, parecer: str = ""
) -> EpiRequisicao:
    """EM_ANALISE → ANALISADA: todo item decidido, e ao menos um APROVADO.

    "Todo item decidido" é a condição que impede o defeito mais barato desta
    tela: concluir com metade das linhas ainda em SOLICITADO, que produziria um
    pedido cuja resposta é parcial e cuja outra metade ninguém mais olharia —
    ela sairia da fila de análise junto com o envelope.
    """
    _exigir_analista_diferente(s, usuario, requisicao)
    pendentes = [i for i in requisicao.itens if i.estado not in EPI_ITEM_DECIDIDO]
    problemas: list[str] = []
    if pendentes:
        problemas.append(
            "ainda há item sem decisão: "
            + ", ".join(sorted(i.item.nome for i in pendentes))
            + ". Analisar pela metade tiraria da fila o que ninguém decidiu"
        )
    if not any(i.estado == "APROVADO" for i in requisicao.itens):
        problemas.append(
            "nenhum item foi aprovado: se a resposta é negativa em tudo, o "
            "caminho é indeferir, que exige o motivo do catálogo (RN-27)"
        )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    requisicao.parecer_analise = (
        textos.exigir_texto_limpo((parecer or "").strip(), campo="parecer da análise")
        or None
    )
    requisicao.analisado_por = usuario.id
    requisicao.analisado_em = agora_utc()
    return _mover(
        s,
        requisicao,
        "ANALISADA",
        usuario,
        tipo_evento=EPI_REQUISICAO_ANALISADA,
        comentario=requisicao.parecer_analise,
    )


def indeferir(
    s: Session,
    usuario: UsuarioAtual,
    requisicao: EpiRequisicao,
    *,
    motivo: EpiMotivoRecusa,
    complemento: str = "",
    parecer: str = "",
) -> EpiRequisicao:
    """EM_ANALISE → INDEFERIDA: todo item RECUSADO, com motivo do catálogo.

    O motivo do envelope é o do pedido inteiro, e existe além dos motivos por
    item porque é ele que sai na resposta ao requerente. Um indeferimento sem
    motivo catalogado seria a recusa em texto livre do legado de volta: sai
    diferente a cada vez, não cita norma e não se conta.
    """
    _exigir_analista_diferente(s, usuario, requisicao)
    limpo = textos.exigir_texto_limpo(
        (complemento or "").strip(), campo="complemento do indeferimento"
    )
    problemas: list[str] = []
    if not requisicao.itens:
        problemas.append("não há item para indeferir")
    nao_recusados = [i for i in requisicao.itens if i.estado != "RECUSADO"]
    if nao_recusados:
        problemas.append(
            "indeferir é a resposta quando TODO item foi recusado, e ainda há "
            + ", ".join(sorted(i.item.nome for i in nao_recusados))
            + " fora disso. Com item aprovado, o caminho é concluir a análise"
        )
    if not motivo.ativo:
        problemas.append(f"o motivo {motivo.codigo} está inativo no catálogo")
    if motivo.exige_complemento and not limpo:
        problemas.append(f"o motivo {motivo.codigo} exige o complemento por escrito")
    if problemas:
        raise RequisicaoBloqueada(problemas)

    requisicao.motivo_recusa_id = motivo.id
    requisicao.complemento_recusa = limpo or None
    requisicao.parecer_analise = (
        textos.exigir_texto_limpo((parecer or "").strip(), campo="parecer da análise")
        or None
    )
    requisicao.analisado_por = usuario.id
    requisicao.analisado_em = agora_utc()
    return _mover(
        s,
        requisicao,
        "INDEFERIDA",
        usuario,
        tipo_evento=EPI_REQUISICAO_INDEFERIDA,
        comentario=f"{motivo.codigo}: {motivo.rotulo}"
        + (f" — {limpo}" if limpo else ""),
    )


def reconsiderar(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao, motivo: str
) -> EpiRequisicao:
    """INDEFERIDA → EM_ANALISE. O único caminho de volta de um terminal.

    Existe porque o legado não tinha nenhum: indeferimento errado só se
    consertava abrindo pedido novo, e o pedido novo apaga a história de que houve
    um erro. Aqui a volta fica na trilha, com o motivo, e o pedido continua sendo
    o mesmo documento.

    Os itens **não** voltam sozinhos: cada recusa foi uma decisão própria, com
    texto congelado, e desfazê-las em bloco reescreveria em silêncio negativas
    que talvez estivessem certas. Quem reconsidera decide item a item, de novo.
    """
    _exigir_analista_diferente(s, usuario, requisicao)
    limpo = _motivo_obrigatorio(motivo, "motivo da reconsideração")
    requisicao.analisado_por = usuario.id
    requisicao.analisado_em = agora_utc()
    return _mover(
        s,
        requisicao,
        "EM_ANALISE",
        usuario,
        tipo_evento=EPI_REQUISICAO_RECONSIDERADA,
        comentario=limpo,
    )


def cancelar(
    s: Session, usuario: UsuarioAtual, requisicao: EpiRequisicao, motivo: str
) -> EpiRequisicao:
    """A desistência, com motivo — em qualquer estado antes da entrega.

    Aceita `epi.requisitar` **ou** `epi.analisar`: o pedido é do requerente e o
    trâmite é do SESMT, e os dois lados desistem por razões legítimas. Quando
    quem cancela é o SESMT sobre pedido de outra pessoa, a RN-28 não se aplica —
    ela governa a **decisão** (aprovar, recusar, indeferir), não a desistência.

    No legado a desistência não existia: cancelar era registrar uma recusa
    mentirosa, e a contagem por motivo passava a somar negativas que nunca
    aconteceram.
    """
    if not (usuario.pode("epi.requisitar") or usuario.pode("epi.analisar")):
        raise PermissaoNegada("epi.requisitar")
    limpo = _motivo_obrigatorio(motivo, "motivo do cancelamento")
    entregues = [i for i in requisicao.itens if i.quantidade_entregue > 0]
    if entregues:
        raise RequisicaoBloqueada(
            [
                "já houve entrega neste pedido ("
                + ", ".join(
                    f"{i.quantidade_entregue} × {i.item.nome}" for i in entregues
                )
                + "), e o que foi entregue não se desfaz por cancelamento. A "
                "ficha registra a entrega; devolver o equipamento é devolução, "
                "e corrigir o registro é estorno"
            ]
        )
    requisicao.motivo_cancelamento = limpo
    # os itens abertos vão junto: o envelope cancelado é terminal, e deixar
    # linha em SOLICITADO ou APROVADO dentro dele produziria item que a fila
    # ainda mostra e que ninguém mais vai decidir nem entregar
    for linha in requisicao.itens:
        if linha.estado in ("SOLICITADO", "APROVADO", "RESERVADO", "SEM_ESTOQUE"):
            # cancelar solta a reserva: pedido cancelado que continuasse
            # segurando lote faria o disponível mentir para todo mundo, e a
            # unidade presa não apareceria em tela nenhuma como presa
            liberar_reserva(linha)
            _mover_item(
                s,
                linha,
                "CANCELADO",
                usuario,
                tipo_evento=EPI_ITEM_CANCELADO,
                comentario=limpo,
                detalhe="pedido cancelado",
            )
    return _mover(
        s,
        requisicao,
        "CANCELADA",
        usuario,
        tipo_evento=EPI_REQUISICAO_CANCELADA,
        comentario=limpo,
    )


# =====================================================================
# A análise — item a item (é aqui que a decisão acontece)
# =====================================================================
def aprovar_item(
    s: Session,
    usuario: UsuarioAtual,
    linha: EpiRequisicaoItem,
    *,
    quantidade_aprovada: int | None = None,
    justificativa: str = "",
    autorizar_excesso: bool = False,
    quando: date | None = None,
) -> EpiRequisicaoItem:
    """SOLICITADO → APROVADO, com a RN-26 contada **na ficha**.

    `quantidade_aprovada` omitida vale o que foi pedido. Aprovar mais do que se
    pediu o banco recusa (`ck_item_aprovada`), e com razão: seria o setor
    decidindo sozinho o que a pessoa vai receber.

    **RN-26 — a janela conta a ficha, não requisições aprovadas.** Aprovação é
    promessa; entrega é fato; e a ficha é a verdade. Somar aprovações faria a
    conta bloquear por causa de um pedido que nunca chegou a ser entregue, e
    deixar passar duas entregas de balcão que a ficha registrou.

    Estourar não é bloqueio duro: é bloqueio até que alguém marque
    `excedeu_maximo`, escreva a justificativa e assine com o próprio `usuario.id`
    em `autorizado_por` — precedente exato de `excecao_art9_par_unico` na
    exposição. O evento é `EPI_MAXIMO_EXCEDIDO`, e é ele que permite ao setor
    contar quantas exceções foram abertas, por quem e para quê.
    """
    requisicao = linha.requisicao
    _exigir_analista_diferente(s, usuario, requisicao)
    quando = quando or date.today()
    limpa = textos.exigir_texto_limpo(
        (justificativa or "").strip(), campo="justificativa do item"
    )
    quantidade = (
        linha.quantidade_solicitada if quantidade_aprovada is None else quantidade_aprovada
    )

    problemas: list[str] = []
    if requisicao.estado != "EM_ANALISE":
        problemas.append(
            f"decidir item exige a requisição em análise, e "
            f"{requisicao.identificacao} está em "
            f"{ROTULO_EPI_REQUISICAO.get(requisicao.estado, requisicao.estado).lower()}"
        )
    if quantidade <= 0:
        problemas.append(
            "aprovar zero não é aprovar: se o item não vai sair, o caminho é "
            "recusar com motivo do catálogo (RN-27), que é o que o requerente "
            "precisa receber por escrito"
        )
    if quantidade > linha.quantidade_solicitada:
        problemas.append(
            f"foram pedidos {linha.quantidade_solicitada} de "
            f"'{linha.item.nome}' e a aprovação registra {quantidade}"
        )

    # RN-26, com a conta saindo da ficha
    excedeu = False
    ja = 0
    if linha.item.quantidade_maxima is not None and quantidade > 0:
        ja = epi_ficha.entregue_na_janela(
            s, requisicao.servidor_id, linha.item, quando
        )
        if ja + quantidade > linha.item.quantidade_maxima:
            excedeu = True
            recado = (
                f"a ficha registra {ja} de '{linha.item.nome}' entregue(s) nos "
                f"últimos {linha.item.periodo_maximo_meses} meses, o máximo é "
                f"{linha.item.quantidade_maxima} e esta aprovação soma "
                f"{ja + quantidade}"
            )
            if not autorizar_excesso:
                problemas.append(
                    f"{recado}. Para aprovar assim mesmo, autorize a exceção: "
                    "ela fica registrada com o seu nome (RN-26)"
                )
            elif not limpa:
                problemas.append(
                    f"{recado}. A exceção exige a justificativa por escrito — é "
                    "ela que sustenta a decisão de quem a assinou"
                )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    linha.quantidade_aprovada = quantidade
    if limpa:
        linha.justificativa = limpa
    linha.decidido_por = usuario.id
    linha.decidido_em = agora_utc()
    if excedeu:
        linha.excedeu_maximo = True
        linha.autorizado_por = usuario.id

    _mover_item(
        s,
        linha,
        "APROVADO",
        usuario,
        tipo_evento=EPI_ITEM_APROVADO,
        detalhe=f"{quantidade} de {linha.quantidade_solicitada} pedido(s)",
        comentario=limpa or None,
    )
    if excedeu:
        auditoria.registrar(
            s,
            entidade=ENTIDADE_ITEM,
            entidade_id=linha.id,
            tipo_evento=EPI_MAXIMO_EXCEDIDO,
            descricao=(
                f"Máximo de '{linha.item.nome}' ({linha.item.regra_de_quantidade}) "
                f"excedido em {requisicao.identificacao} e autorizado por "
                f"{usuario.nome}: {linha.justificativa}"
            ),
            campo="excedeu_maximo",
            # inteiros de verdade: a trava da auditoria recusa valor que não
            # volta igual do banco, e "3" não é 3
            valor_anterior=ja,
            valor_novo=ja + quantidade,
            comentario=linha.justificativa,
            usuario=usuario,
        )
        s.flush()
    return linha


def recusar_item(
    s: Session,
    usuario: UsuarioAtual,
    linha: EpiRequisicaoItem,
    *,
    motivo: EpiMotivoRecusa,
    complemento: str = "",
) -> EpiRequisicaoItem:
    """SOLICITADO → RECUSADO. RN-27: fundamentada, catalogada e **congelada**.

    O texto vigente do motivo é copiado para `texto_recusa_snapshot` no ato. Não
    é redundância com o catálogo: é a mesma lição do CHANGELOG 1.4.0, quando
    editar catálogo reescrevia parecer emitido em silêncio. A negativa que a
    pessoa recebeu é a que fica, e um ponteiro para o catálogo mudaria de
    conteúdo junto com ele.

    O **código** do motivo vai em `valor_novo` do evento — e não o estado de
    destino, como nas outras transições —, porque é isso que faz a contagem por
    motivo sair da própria trilha sem depender de casar texto. É por essa
    contagem que a decisão 3 vira número: quantos pedidos de terceirizado o setor
    recusou, em qual unidade, é o insumo para acionar a fiscalização do contrato.
    """
    requisicao = linha.requisicao
    _exigir_analista_diferente(s, usuario, requisicao)
    limpo = textos.exigir_texto_limpo(
        (complemento or "").strip(), campo="complemento da recusa"
    )
    problemas: list[str] = []
    if requisicao.estado != "EM_ANALISE":
        problemas.append(
            f"decidir item exige a requisição em análise, e "
            f"{requisicao.identificacao} está em "
            f"{ROTULO_EPI_REQUISICAO.get(requisicao.estado, requisicao.estado).lower()}"
        )
    if not motivo.ativo:
        problemas.append(f"o motivo {motivo.codigo} está inativo no catálogo")
    if motivo.exige_complemento and not limpo:
        problemas.append(
            f"o motivo {motivo.codigo} exige o complemento por escrito: sem ele "
            "a negativa não diz à pessoa o que fazer a seguir"
        )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    linha.motivo_recusa_id = motivo.id
    linha.complemento_recusa = limpo or None
    # o texto vai INTEIRO, e não um ponteiro: é ele que sai literal para quem
    # pediu, na guia e na notificação
    linha.texto_recusa_snapshot = motivo.texto
    linha.quantidade_aprovada = 0
    linha.decidido_por = usuario.id
    linha.decidido_em = agora_utc()
    return _mover_item(
        s,
        linha,
        "RECUSADO",
        usuario,
        tipo_evento=EPI_ITEM_RECUSADO,
        detalhe=f"{motivo.codigo} — {motivo.rotulo}",
        comentario=limpo or None,
        valor_novo={
            "estado": "RECUSADO",
            "motivo": motivo.codigo,
            "rotulo": motivo.rotulo,
            "base_normativa": motivo.base_normativa,
            "complemento": limpo or None,
            "unidade": requisicao.unidade.nome_extenso if requisicao.unidade else None,
        },
    )


def cancelar_item(
    s: Session, usuario: UsuarioAtual, linha: EpiRequisicaoItem, motivo: str
) -> EpiRequisicaoItem:
    """A linha sai do pedido sem virar recusa. Motivo obrigatório.

    Recusar e cancelar dizem coisas diferentes, e confundi-las estraga a
    contagem da RN-27: recusa é decisão técnica fundamentada (o item não é
    devido), cancelamento é desistência (não é mais preciso, ou o pedido mudou).
    Registrar desistência como recusa foi exatamente o que o legado fez, e por
    isso o relatório de recusas dele não valia nada.

    **Cancelar solta a reserva.** Uma linha cancelada que continuasse com
    `quantidade_reservada` faria o lote prometer unidades a um pedido morto: o
    disponível diria menos do que existe, e nenhuma tela mostraria por quê — o
    item cancelado não aparece mais como esperando nada.
    """
    if not (usuario.pode("epi.requisitar") or usuario.pode("epi.analisar")):
        raise PermissaoNegada("epi.analisar")
    limpo = _motivo_obrigatorio(motivo, "motivo do cancelamento do item")
    if linha.quantidade_entregue > 0:
        raise RequisicaoBloqueada(
            [
                f"'{linha.item.nome}' já teve {linha.quantidade_entregue} "
                "entregue(s), e entrega registrada não se desfaz por "
                "cancelamento: a ficha é a prova de que o equipamento saiu"
            ]
        )
    linha.decidido_por = usuario.id
    linha.decidido_em = agora_utc()
    liberar_reserva(linha)
    resultado = _mover_item(
        s,
        linha,
        "CANCELADO",
        usuario,
        tipo_evento=EPI_ITEM_CANCELADO,
        comentario=limpo,
        detalhe=limpo,
    )
    sincronizar_atendimento(s, linha.requisicao, usuario)
    return resultado


# =====================================================================
# A reserva (fatia 5) — é ela que impede dois pedidos de prometerem a
# mesma bota
# =====================================================================
# Onde a reserva ainda pode nascer ou renascer. `SEM_ESTOQUE` está aqui porque a
# §4.3 declara `SEM_ESTOQUE → RESERVADO`: o item voltou a ter lote, e reservar é
# a mesma operação com a mesma conferência.
RESERVAVEL = frozenset({"APROVADO", "SEM_ESTOQUE"})

# O envelope em que o almoxarifado opera. Antes de ANALISADA não há o que
# reservar (nada foi decidido) e depois de ATENDIDA não há o que prometer.
ATENDIVEL = ("ANALISADA", "EM_ATENDIMENTO")


def reservar_item(
    s: Session,
    usuario: UsuarioAtual,
    linha: EpiRequisicaoItem,
    *,
    entrada: EpiEntradaEstoque,
    quantidade: int | None = None,
    quando: date | None = None,
) -> EpiRequisicaoItem:
    """APROVADO (ou SEM_ESTOQUE) → RESERVADO, com RN-24 e RN-25 na porta.

    **Por que a reserva é ato explícito, e nunca automática na entrada de lote.**
    A §4.3 diz "sistema" na aresta `SEM_ESTOQUE → RESERVADO`, e a leitura fácil
    seria varrer os pedidos que esperam sempre que um lote entra. Não é o que
    esta fatia faz, por três razões:

    1. **Reserva automática muda saldo sem ninguém mandar.** Quem acabou de
       lançar 50 pares veria 38 disponíveis na mesma tela, por decisão que não
       está nela. É assim que a contagem manual passa a divergir do sistema sem
       explicação — e conferir físico contra prateleira é o que este módulo
       inteiro existe para permitir.
    2. **Escolher quem recebe estoque escasso é decisão, não ordem de laço.**
       Chegaram 10 e três pedidos somam 22: quem fica com o quê depende de
       urgência, de risco do posto e de quem já está descalço. Um `ORDER BY id`
       responderia isso em silêncio e com a aparência de regra.
    3. **O que falta não é a reserva, é a informação.** Então o sistema *avisa*:
       `itens_esperando_estoque` conta quem espera aquele item, e a entrada de
       lote diz o número na mensagem. A ação continua sendo de gente, com nome na
       trilha.

    A conferência é a mesma dos dois estados de origem, e é aqui que a RN-24 mora
    de verdade: `disponivel` já desconta o que outros pedidos prometeram, e o
    `BEGIN IMMEDIATE` de `app/banco.py` faz esta leitura e a gravação seguinte
    caberem numa transação que nenhum outro escritor atravessa. Sem ele, duas
    reservas simultâneas leriam o mesmo disponível e somariam mais que o lote
    tem — que é o defeito do `Qtd_Estoque` do legado com outra roupa.
    """
    usuario.exigir("epi.estoque")
    requisicao = linha.requisicao
    quando = quando or date.today()
    quantidade = linha.quantidade_devida if quantidade is None else quantidade

    problemas: list[str] = []
    if requisicao.estado not in ATENDIVEL:
        problemas.append(
            f"reservar exige a requisição analisada, e "
            f"{requisicao.identificacao} está em "
            f"{ROTULO_EPI_REQUISICAO.get(requisicao.estado, requisicao.estado).lower()}"
        )
    if linha.estado not in RESERVAVEL:
        problemas.append(
            f"'{linha.item.nome}' está em "
            f"{ROTULO_EPI_ITEM.get(linha.estado, linha.estado).lower()} e só se "
            "reserva o que foi aprovado e ainda não saiu"
        )
    if quantidade <= 0:
        problemas.append("a quantidade a reservar tem de ser maior que zero")
    elif quantidade > linha.quantidade_devida:
        problemas.append(
            f"foram aprovados {linha.quantidade_aprovada} de "
            f"'{linha.item.nome}', {linha.quantidade_entregue} já saíram e a "
            f"reserva pede {quantidade}: reservar mais do que se deve é prometer "
            "a prateleira a quem não tem direito a ela"
        )
    if entrada.epi_item_id != linha.epi_item_id:
        problemas.append("o lote escolhido é de outro item do catálogo")
    elif linha.tamanho and entrada.tamanho and entrada.tamanho != linha.tamanho:
        problemas.append(
            f"o pedido é do tamanho {linha.tamanho} e o lote é do tamanho "
            f"{entrada.tamanho}: '40 luvas' não quer dizer nada se são todas P"
        )

    # RN-25, primeiro dos dois momentos. O segundo é a entrega, porque o CA pode
    # vencer no intervalo — e é o lote que manda, não o catálogo.
    impedimento = epi_estoque.impedimento_do_lote(entrada, linha.item, quando)
    if impedimento:
        problemas.append(f"o lote não pode ser prometido — {impedimento}")

    # RN-24, e ela não cabe num CHECK: é agregado sobre outra tabela
    livre = epi_estoque.disponivel(s, entrada.id)
    if quantidade > livre:
        problemas.append(
            f"o lote {entrada.lote or '—'} tem {livre} disponível(is) "
            f"(físico {epi_estoque.saldo_fisico(s, entrada.id)}, "
            f"{epi_estoque.reservado(s, entrada.id)} já prometido(s) a outro "
            f"pedido) e a reserva pede {quantidade}: saldo não fica negativo "
            "(RN-24)"
        )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    linha.entrada_id = entrada.id
    linha.quantidade_reservada = quantidade
    resultado = _mover_item(
        s,
        linha,
        "RESERVADO",
        usuario,
        tipo_evento=EPI_ITEM_RESERVADO,
        detalhe=(
            f"{quantidade} × lote {entrada.lote or '—'} "
            f"(CA {entrada.numero_ca or '—'})"
        ),
    )
    # §4.2: ANALISADA → EM_ATENDIMENTO é automática na PRIMEIRA reserva, e não
    # só na primeira entrega. É a reserva que marca o começo do atendimento —
    # dela em diante o pedido já consumiu disponibilidade da prateleira.
    sincronizar_atendimento(s, requisicao, usuario)
    return resultado


def marcar_sem_estoque(
    s: Session,
    usuario: UsuarioAtual,
    linha: EpiRequisicaoItem,
    *,
    complemento: str = "",
    quando: date | None = None,
) -> EpiRequisicaoItem:
    """APROVADO → SEM_ESTOQUE: o item é devido e a prateleira não tem.

    **Recusa quando existe lote elegível**, e isso é o ponto da função: se há
    saldo que pode sair, "sem estoque" é afirmação falsa, e uma falsa dessas
    entra no indicador de compras e vira pregão para item que estava na
    prateleira. O caminho, quando existe lote, é reservar o que existe — mesmo
    que seja menos do que o pedido, porque metade entregue hoje é metade de
    proteção que a pessoa passa a ter.

    Não confundir com `soltar_reserva`: aqui o item nunca teve lote. Lá ele teve,
    e a promessa se desfez — dois fatos diferentes, dois eventos diferentes, para
    que a contagem por evento não some laranja com maçã.
    """
    usuario.exigir("epi.estoque")
    requisicao = linha.requisicao
    quando = quando or date.today()
    limpo = textos.exigir_texto_limpo(
        (complemento or "").strip(), campo="complemento da falta de estoque"
    )

    problemas: list[str] = []
    if requisicao.estado not in ATENDIVEL:
        problemas.append(
            f"marcar falta de estoque exige a requisição analisada, e "
            f"{requisicao.identificacao} está em "
            f"{ROTULO_EPI_REQUISICAO.get(requisicao.estado, requisicao.estado).lower()}"
        )
    if linha.estado == "RESERVADO":
        problemas.append(
            f"'{linha.item.nome}' está reservado: desfazer promessa feita é "
            "soltar a reserva, que exige o motivo por escrito — e o evento é "
            "outro, porque 'faltou comprar' e 'prometi e não pude cumprir' são "
            "fatos diferentes"
        )
    elif linha.estado != "APROVADO":
        problemas.append(
            f"'{linha.item.nome}' está em "
            f"{ROTULO_EPI_ITEM.get(linha.estado, linha.estado).lower()} e só "
            "fica sem estoque o que foi aprovado"
        )

    # a conferência da prateleira só faz sentido quando o estado é o certo:
    # somá-la a "este item está reservado" daria dois recados que se contradizem
    # na mesma lista de problemas
    candidatos = (
        [
            lote
            for lote in epi_estoque.lotes_de(
                s, linha.item, quando=quando, tamanho=linha.tamanho or None
            )
            if lote.pode_sair
        ]
        if linha.estado == "APROVADO"
        else []
    )
    if candidatos:
        problemas.append(
            "há lote elegível deste item com saldo — "
            + "; ".join(f"{lote.rotulo}" for lote in candidatos)
            + ". 'Sem estoque' com prateleira cheia vira pedido de compra para "
            "item que já existe: reserve o que houver, mesmo que seja menos do "
            "que o pedido"
        )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    detalhe = (
        "nenhum lote elegível com saldo" + (f" — {limpo}" if limpo else "")
    )
    resultado = _mover_item(
        s,
        linha,
        "SEM_ESTOQUE",
        usuario,
        tipo_evento=EPI_ITEM_SEM_ESTOQUE,
        comentario=limpo or None,
        detalhe=detalhe,
    )
    sincronizar_atendimento(s, requisicao, usuario)
    return resultado


def soltar_reserva(
    s: Session, usuario: UsuarioAtual, linha: EpiRequisicaoItem, motivo: str
) -> EpiRequisicaoItem:
    """RESERVADO → SEM_ESTOQUE. A promessa se desfaz, e diz por quê.

    Motivo obrigatório porque é o único registro que sobra: o item volta a
    aparecer esperando estoque, e quem o vir daqui a duas semanas precisa saber
    se o lote foi descartado, se o CA venceu no intervalo ou se alguém precisou
    daquelas unidades para um caso mais urgente.

    Vai para `SEM_ESTOQUE`, e não de volta para `APROVADO`, porque é a verdade do
    momento: o item continua devido e continua sem lote. `APROVADO` diria que a
    reserva nunca aconteceu.
    """
    usuario.exigir("epi.estoque")
    limpo = _motivo_obrigatorio(motivo, "motivo para soltar a reserva")
    if linha.estado != "RESERVADO":
        raise RequisicaoBloqueada(
            [
                f"'{linha.item.nome}' está em "
                f"{ROTULO_EPI_ITEM.get(linha.estado, linha.estado).lower()} e não "
                "há reserva a soltar"
            ]
        )
    return _soltar(s, usuario, linha, limpo)


def soltar_reservas_do_lote(
    s: Session,
    usuario: UsuarioAtual,
    entrada: EpiEntradaEstoque,
    *,
    motivo: str,
    tudo: bool = False,
) -> int:
    """Solta o que o lote prometeu e já não tem lastro. Devolve quantas soltou.

    Chamada pelo estoque quando o chão muda sob a promessa: descarte, ajuste de
    inventário para menos (`tudo=False`, solta só o excedente) e inativação do
    lote (`tudo=True`, solta todas, porque lote inativo é impedimento e nenhuma
    reserva nele pode ser cumprida).

    **Da mais nova para a mais antiga.** Quem esperou mais tempo é quem menos
    deve perder o lugar; e a alternativa — soltar todas — puniria um pedido
    inteiro por um descarte de duas unidades.
    """
    itens = list(
        s.execute(
            select(EpiRequisicaoItem)
            .where(
                EpiRequisicaoItem.entrada_id == entrada.id,
                EpiRequisicaoItem.estado == "RESERVADO",
            )
            .order_by(EpiRequisicaoItem.id.desc())
        ).scalars()
    )
    if not itens:
        return 0

    if tudo:
        alvos = itens
    else:
        fisico = epi_estoque.saldo_fisico(s, entrada.id)
        prometido = sum(i.quantidade_reservada for i in itens)
        alvos = []
        for item in itens:
            if prometido <= fisico:
                break
            alvos.append(item)
            prometido -= item.quantidade_reservada

    for item in alvos:
        _soltar(s, usuario, item, motivo)
    return len(alvos)


def _soltar(
    s: Session, usuario: UsuarioAtual, linha: EpiRequisicaoItem, motivo: str
) -> EpiRequisicaoItem:
    """A soltura em si: zera a promessa, move e sincroniza o envelope."""
    liberar_reserva(linha)
    resultado = _mover_item(
        s,
        linha,
        "SEM_ESTOQUE",
        usuario,
        tipo_evento=EPI_ITEM_RESERVA_SOLTA,
        comentario=motivo,
        detalhe=motivo,
    )
    sincronizar_atendimento(s, linha.requisicao, usuario)
    return resultado


def liberar_reserva(linha: EpiRequisicaoItem) -> None:
    """Devolve à prateleira o que este item tinha prometido.

    Zera **as duas** colunas. `entrada_id` some junto porque, na linha do pedido,
    ele é o ponteiro da reserva — de qual lote a entrega saiu de fato fica em
    `epi_ficha_registro.entrada_id`, que é append-only e é a prova. Um ponteiro
    de reserva que sobrevive à reserva faria a tela mostrar um lote ao lado de um
    item que não tem lote nenhum.
    """
    linha.quantidade_reservada = 0
    linha.entrada_id = None


def _rotulo_do_lote(s: Session, entrada_id: int | None) -> str:
    """Como o lote aparece na mensagem de erro. Número, não `id` interno.

    "reservado no lote 47" manda quem lê procurar 47 numa etiqueta que diz
    `L-2026-08`.
    """
    entrada = s.get(EpiEntradaEstoque, entrada_id) if entrada_id else None
    if entrada is None:  # pragma: no cover - ck_item_lote impede
        return "—"
    return entrada.lote or f"sem número (#{entrada.id})"


def itens_esperando_estoque(
    s: Session, *, epi_item_id: int | None = None, tamanho: str | None = None
) -> list[EpiRequisicaoItem]:
    """Quem está em `SEM_ESTOQUE` — a fila que a entrada de lote pode atender.

    É o substituto da reserva automática: em vez de decidir sozinho quem fica com
    o lote que acabou de chegar, o sistema mostra a fila e deixa a decisão com
    quem responde por ela. Ordenada por `id`, que é a ordem de chegada.
    """
    consulta = select(EpiRequisicaoItem).where(
        EpiRequisicaoItem.estado == "SEM_ESTOQUE"
    )
    if epi_item_id is not None:
        consulta = consulta.where(EpiRequisicaoItem.epi_item_id == epi_item_id)
    linhas = list(s.execute(consulta.order_by(EpiRequisicaoItem.id)).scalars())
    if tamanho:
        # em Python e não no WHERE: linha sem tamanho casa com qualquer lote, e
        # exprimir isso em SQL custaria um OR que esconde a regra
        linhas = [i for i in linhas if not i.tamanho or i.tamanho == tamanho]
    return linhas


# =====================================================================
# A entrega — RESERVADO → ENTREGUE é o caminho normal (fatia 5)
# =====================================================================
def entregar_item(
    s: Session,
    usuario: UsuarioAtual,
    linha: EpiRequisicaoItem,
    *,
    entrada: EpiEntradaEstoque | None = None,
    quantidade: int | None = None,
    data_evento: date | None = None,
    observacao: str = "",
) -> EpiFichaRegistro:
    """RESERVADO → ENTREGUE (ou APROVADO → ENTREGUE), reaproveitando a fatia 2.

    **Não há baixa de estoque nem linha de ficha escritas aqui**, e isso é
    deliberado: `epi_ficha.registrar_entrega` já sabe validar a RN-24, a RN-25 e
    a RN-26, congelar os snapshots, baixar o lote no razão amarrado ao `id` da
    linha da ficha, auditar com a forma canônica e abrir a pendência do
    comprovante assinado. Uma segunda implementação disso divergiria da primeira
    no primeiro campo que alguém acrescentasse a uma só — e o campo esquecido
    seria numa prova legal.

    O que esta função acrescenta é o vínculo (`requisicao_item_id` na linha da
    ficha e no movimento do razão) e as duas máquinas de estado.

    **A reserva é solta imediatamente antes de delegar**, e a ordem é a coisa
    mais fácil de errar nesta fatia: `disponivel` desconta as reservas, inclusive
    a deste item. Entregar sem soltar antes faria a RN-24 recusar a entrega por
    causa da própria promessa que ela vem cumprir — o lote com 3 físicos e 3
    reservados para este pedido mostraria zero disponível. Por isso a conferência
    daqui soma a própria reserva de volta ao disponível: é a folga real deste
    item naquele lote.

    **A entrega não troca o lote da reserva.** Reservar é dizer "estas unidades
    são deste pedido"; sair de outro lote na hora deixaria a promessa de pé sobre
    um saldo que ninguém mais vai buscar. Quem precisa trocar solta a reserva com
    motivo e reserva no lote certo — dois atos, dois registros.

    **RN-25 é revalidada aqui, no segundo momento.** Não por código novo: a
    validação de `registrar_entrega` roda com `quando = data_evento`, e o CA que
    ela confere é o do lote. Um lote reservado em agosto com CA vencendo em
    setembro é recusado na entrega de outubro, e a mensagem diz a data.

    A exceção da RN-26 autorizada na aprovação é repassada como
    `justificativa_excecao`: sem isso, a validação da entrega recusaria de novo o
    que o analista já autorizou por escrito — e quem está no balcão descobriria
    na frente da pessoa que a autorização não valia.
    """
    usuario.exigir("epi.entregar")
    requisicao = linha.requisicao
    reservado = linha.estado == "RESERVADO"
    if quantidade is None:
        quantidade = linha.quantidade_reservada if reservado else linha.quantidade_devida
    if reservado and entrada is None:
        # o lote da reserva é o padrão: quem reservou já escolheu, e obrigar a
        # escolher de novo no balcão é a chance de escolher diferente
        entrada = s.get(EpiEntradaEstoque, linha.entrada_id)

    problemas: list[str] = []
    if requisicao.estado not in ATENDIVEL:
        problemas.append(
            f"entregar exige a requisição analisada, e "
            f"{requisicao.identificacao} está em "
            f"{ROTULO_EPI_REQUISICAO.get(requisicao.estado, requisicao.estado).lower()}"
        )
    if linha.estado not in ("APROVADO", "RESERVADO"):
        problemas.append(
            f"'{linha.item.nome}' está em "
            f"{ROTULO_EPI_ITEM.get(linha.estado, linha.estado).lower()} e só se "
            "entrega o que foi aprovado ou reservado"
        )
    if quantidade <= 0:
        problemas.append("a quantidade a entregar tem de ser maior que zero")
    elif quantidade > linha.quantidade_devida:
        problemas.append(
            f"foram aprovados {linha.quantidade_aprovada} de "
            f"'{linha.item.nome}', {linha.quantidade_entregue} já saíram e a "
            f"entrega pede {quantidade}"
        )
    if reservado:
        if entrada is None or entrada.id != linha.entrada_id:
            problemas.append(
                f"'{linha.item.nome}' está reservado no lote "
                f"{_rotulo_do_lote(s, linha.entrada_id)}, e a entrega tem de sair "
                "dele: trocar de lote no balcão deixaria a reserva de pé sobre um "
                "saldo que ninguém mais vai buscar. Solte a reserva com motivo e "
                "reserve no lote certo"
            )
        elif quantidade > linha.quantidade_reservada:
            problemas.append(
                f"a reserva é de {linha.quantidade_reservada} × "
                f"'{linha.item.nome}' e a entrega pede {quantidade}: o que passa "
                "da reserva não está prometido a este pedido. Reserve o restante "
                "antes, se o lote tiver saldo"
            )
        elif entrada is not None:
            # RN-24 com a folga REAL deste item: o disponível já desconta a
            # própria reserva, e conferir contra ele recusaria a entrega que a
            # reserva existe para garantir
            folga = epi_estoque.disponivel(s, entrada.id) + linha.quantidade_reservada
            if quantidade > folga:
                problemas.append(
                    f"o lote {entrada.lote or '—'} tem {folga} para este pedido "
                    f"e a entrega pede {quantidade}: saldo não fica negativo "
                    "(RN-24)"
                )
    if problemas:
        raise RequisicaoBloqueada(problemas)

    if reservado:
        # solta ANTES de delegar, para que `epi_ficha.validar` enxergue a folga
        # que esta entrega vai consumir. O flush é o que faz a soma de
        # `epi_estoque.reservado` já sair sem estas unidades.
        linha.quantidade_reservada -= quantidade
        s.flush()

    servidor = s.get(Servidor, requisicao.servidor_id)
    registro = epi_ficha.registrar_entrega(
        s,
        usuario,
        servidor=servidor,
        item=linha.item,
        quantidade=quantidade,
        entrada=entrada,
        tamanho=linha.tamanho or "",
        data_evento=data_evento,
        observacao=observacao,
        # a exceção já foi autorizada, por escrito e com nome, na aprovação
        justificativa_excecao=(
            (linha.justificativa or "") if linha.excedeu_maximo else ""
        ),
        requisicao_item_id=linha.id,
    )

    linha.quantidade_entregue += quantidade
    if entrada is not None:
        linha.entrada_id = entrada.id
    # a entrega parcial não fecha o item: ele continua devendo o resto, que é o
    # que a coluna `quantidade_entregue` existe para dizer
    if linha.quantidade_devida == 0:
        _mover_item(
            s,
            linha,
            "ENTREGUE",
            usuario,
            tipo_evento=EPI_ITEM_ENTREGUE,
            detalhe=(
                f"{linha.quantidade_entregue} × {linha.item.nome} · "
                f"ficha {registro.id}"
            ),
        )
    elif linha.estado == "RESERVADO" and linha.quantidade_reservada == 0:
        # A reserva era menor que o devido e foi consumida inteira. Deixar o item
        # em `RESERVADO` com zero reservado seria o defeito que a §4.1 aponta em
        # "liberada": um estado que a tela mostra e que não corresponde a fato
        # nenhum — não há lote prometido, e a tela diria que há.
        _soltar(
            s,
            usuario,
            linha,
            f"a reserva de {quantidade} × '{linha.item.nome}' foi entregue "
            f"inteira e o pedido ainda deve {linha.quantidade_devida}: reserve "
            "de novo quando houver lote",
        )
    sincronizar_atendimento(s, requisicao, usuario)
    return registro


def sincronizar_atendimento(
    s: Session, requisicao: EpiRequisicao, usuario: UsuarioAtual | None
) -> None:
    """ANALISADA → EM_ATENDIMENTO → ATENDIDA, sem ninguém clicar.

    As duas transições são do **sistema**, e é por isso que estão numa função só,
    chamada depois de toda entrega e de todo cancelamento de item. Deixá-las a
    cargo de um botão produziria o estado que o §4.1 do desenho critica em
    "liberada": uma coluna que a tela mostra e que não corresponde a fato nenhum
    — o pedido estaria atendido e continuaria aparecendo como pendente na fila.

    `ATENDIDA` chega quando todo item aprovado está `ENTREGUE` ou `CANCELADO`.
    Item recusado não conta: ele não devia nada desde a decisão.

    **`EM_ATENDIMENTO` chega na primeira RESERVA** (§4.2), e não só na primeira
    entrega: é a reserva que marca o começo do atendimento, porque dela em diante
    o pedido já consumiu disponibilidade da prateleira. Esperar a entrega deixaria
    "analisada" um pedido que já está segurando estoque de outro — e a fila diria
    que ninguém mexeu nele.
    """
    if requisicao.estado not in ("ANALISADA", "EM_ATENDIMENTO"):
        return
    comecou = next(
        (
            "primeira entrega registrada"
            if i.quantidade_entregue > 0
            else "primeira reserva de lote registrada"
            for i in requisicao.itens
            if i.quantidade_entregue > 0 or i.estado == "RESERVADO"
        ),
        "",
    )
    if requisicao.estado == "ANALISADA" and comecou:
        _mover(
            s,
            requisicao,
            "EM_ATENDIMENTO",
            usuario,
            tipo_evento=EPI_REQUISICAO_EM_ATENDIMENTO,
            comentario=comecou,
        )
    if requisicao.estado != "EM_ATENDIMENTO":
        return
    devendo = [
        i for i in requisicao.itens if i.estado in EPI_ITEM_PENDENTE_DE_ATENDIMENTO
    ]
    if devendo:
        return
    _mover(
        s,
        requisicao,
        "ATENDIDA",
        usuario,
        tipo_evento=EPI_REQUISICAO_ATENDIDA,
        comentario="todo item aprovado foi entregue ou cancelado",
    )


# =====================================================================
def _motivo_obrigatorio(motivo: str, campo: str) -> str:
    """Texto limpo e não vazio. RN-30 antes de gravar, como no estoque."""
    limpo = textos.exigir_texto_limpo((motivo or "").strip(), campo=campo)
    if not limpo:
        raise RequisicaoBloqueada(
            [
                f"{campo} é obrigatório: é o único registro que sobra para quem "
                "ler o pedido depois e perguntar por que ele terminou assim"
            ]
        )
    return limpo


def resumo_de_estados(
    s: Session, usuario: UsuarioAtual | None = None
) -> dict[str, int]:
    """`{estado: quantas}` — o painel de `/epis`, numa consulta só.

    Conta o mesmo conjunto que a fila mostra: cada número em cima da fila é o
    filtro que leva às linhas dele, e um contador que somasse além do escopo
    diria "há nove em análise" sobre uma tela que exibe uma. Contagem também é
    informação — sobre quantos pedidos existem, e a de quem não os vê.

    `usuario` opcional só porque o indicador do módulo (`epi_indicadores`) mede o
    setor inteiro sob `indicador.ver`, que é permissão de agregado.
    """
    from sqlalchemy import func

    consulta = select(EpiRequisicao.estado, func.count(EpiRequisicao.id))
    if usuario is not None:
        consulta = _no_escopo(consulta, usuario)
    linhas = s.execute(consulta.group_by(EpiRequisicao.estado))
    return {estado: int(quantas) for estado, quantas in linhas}


def prazo_em_analise(requisicao: EpiRequisicao, agora: datetime | None = None) -> int:
    """Há quantos dias o pedido está parado no estado atual.

    Calculado agora, nunca gravado: dias parados é estado, e estado gravado é
    estado que envelhece em silêncio — a mesma escolha de `EpiItem.ca_vencido_em`
    e de `LinhaDaFicha.troca_vencida_em`.
    """
    return ((agora or agora_utc()) - requisicao.entrou_no_estado_em).days


__all__ = [
    "ATENDIVEL",
    "EDITAVEL",
    "EPI_ITEM_APROVADO",
    "EPI_ITEM_CANCELADO",
    "EPI_ITEM_ENTREGUE",
    "EPI_ITEM_RECUSADO",
    "EPI_ITEM_RESERVADO",
    "EPI_ITEM_RESERVA_SOLTA",
    "EPI_ITEM_SEM_ESTOQUE",
    "EPI_MAXIMO_EXCEDIDO",
    "EPI_REQUISICAO_ANALISADA",
    "EPI_REQUISICAO_ATENDIDA",
    "EPI_REQUISICAO_CANCELADA",
    "EPI_REQUISICAO_CRIADA",
    "EPI_REQUISICAO_DEVOLVIDA",
    "EPI_REQUISICAO_EM_ANALISE",
    "EPI_REQUISICAO_EM_ATENDIMENTO",
    "EPI_REQUISICAO_ENVIADA",
    "EPI_REQUISICAO_EXCLUIDA",
    "EPI_REQUISICAO_INDEFERIDA",
    "EPI_REQUISICAO_RECONSIDERADA",
    "DECIDIDO_E_NAO_LIDO",
    "RESERVAVEL",
    "TIPO_PENDENCIA_DECISAO",
    "TIPO_PENDENCIA_RETIRADA",
    "TIPO_PENDENCIA_SEM_ESTOQUE",
    "AutoanaliseProibida",
    "RequisicaoBloqueada",
    "adicionar_item",
    "aprovar_item",
    "atualizar_rascunho",
    "cancelar",
    "cancelar_item",
    "chave_da_pendencia_de_decisao",
    "chave_da_pendencia_de_falta",
    "chave_da_pendencia_de_retirada",
    "concluir_analise",
    "criar_rascunho",
    "devolver_para_fila",
    "editar_item",
    "enviar",
    "entregar_item",
    "excluir_rascunho",
    "fila",
    "indeferir",
    "iniciar_analise",
    "itens_esperando_estoque",
    "liberar_reserva",
    "marcar_sem_estoque",
    "no_escopo",
    "prazo_em_analise",
    "protocolo_de",
    "reconsiderar",
    "remover_item",
    "requisicoes_de",
    "reservar_item",
    "resumo_de_estados",
    "sincronizar_atendimento",
    "sincronizar_pendencia_de_decisao",
    "sincronizar_pendencia_de_falta",
    "sincronizar_pendencia_de_retirada",
    "soltar_reserva",
    "soltar_reservas_do_lote",
]
