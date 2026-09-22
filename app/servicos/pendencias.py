"""Pendencias com dono e prazo. Alimentam a RN-06 e o sino do topo."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import Pendencia, agora_utc
from app.servicos import auditoria
from app.servicos.rbac import ESCOPO_PROPRIO, PermissaoNegada, UsuarioAtual

# tipo -> (rotulo, prazo padrao em dias)
TIPOS: dict[str, tuple[str, int]] = {
    "AVALIACAO_QUANTITATIVA": ("Avaliação quantitativa de agente químico", 180),
    "REAVALIACAO_LAUDO": ("Reavaliação por laudo superado", 90),
    "INCLUIR_NO_SEI": ("Incluir o parecer assinado no SEI", 10),
    # --- Os dois tipos que ainda NÃO nascem, e o que falta em cada um ---
    #
    # Ficam declarados de propósito, e não por esquecimento: a regra de negócio
    # dos dois existe e está escrita em outro lugar do sistema. Apagá-los faria
    # o próximo a chegar reinventar o código com outro nome, e a fila de tarefas
    # passaria a ter duas gerações de rótulo para o mesmo trabalho. O que falta
    # não é a linha que abre — é a decisão que vem antes dela.
    #
    # CONFERIR_LAUDO: o trabalho é real e já está calculado em dois lugares
    # (`rotas/painel.py`, "Laudos sem conferência", e `rotas/relatorios.py`,
    # "Laudos sem conferência há mais de 24 meses"). Falta decidir o MARCO de
    # quem nunca foi conferido: hoje as duas telas tratam
    # `data_ultima_conferencia is None` como já vencido, e abrir a pendência com
    # esse critério jogaria o acervo inteiro no sino de uma vez, no dia em que
    # alguém cadastrasse o primeiro laudo. Decidido o marco (emissão? cadastro?),
    # o gatilho já existe e é de escrita, como o de `CA_A_VENCER`:
    # `rotas/laudos.py` — criar, registrar conferência e superar.
    "CONFERIR_LAUDO": ("Conferir laudo sem conferência há mais de 24 meses", 60),
    # REGISTRO_DE_OPCAO: a regra existe e já é cobrada — `servicos/direito.py`
    # recusa a concessão sobre adicional vigente sem o registro anexado (RN-09;
    # Lei 8.112/90, art. 68, §1º). Falta a PORTA: `registro_opcao_anexo_id` não é
    # escrito por rota nem por template nenhum, então a tarefa nasceria sem
    # ninguém poder cumpri-la dentro do sistema, e a única saída seria fechá-la à
    # mão — que é o mesmo que apagar a regra. O gatilho natural é
    # `direito.propor`, quando o servidor já tem vigência.
    "REGISTRO_DE_OPCAO": ("Anexar o registro de opção do servidor", 30),
    # CONFLITO_NUMERACAO passou a nascer em
    # `servicos/importacao_planilha._obter_parecer`: a carga da planilha
    # reencontra o número já ocupado por um parecer criado DENTRO do sistema e
    # escreve por cima dele. Trinta dias porque o que a tarefa cobra não é
    # renumerar — é decidir qual dos dois documentos fica com `N/AAAA`, com os
    # dois na mão.
    "CONFLITO_NUMERACAO": ("Resolver conflito de numeração da migração", 30),
    # Decisão 8 (18/08/2026): o comprovante de EPI é papel assinado no ato e
    # digitalizado depois. Entre a entrega e o anexo existe uma janela em que a
    # ficha tem o REGISTRO e não tem a PROVA — e a decisão manda torná-la
    # visível, porque lacuna silenciosa só aparece na fiscalização.
    #
    # Dez dias, o mesmo prazo de `INCLUIR_NO_SEI`, e pela mesma razão: nos dois
    # casos o documento JÁ EXISTE e falta guardá-lo no lugar certo. Não é prazo
    # de norma — é meta interna do setor, e muda com a rotina do almoxarifado.
    "COMPROVANTE_EPI_PENDENTE": ("Anexar o comprovante assinado de EPI", 10),
    # RN-25. Abre 60 dias antes de o CA do lote vencer, e o prazo dela é a
    # PRÓPRIA validade do CA — não 60 dias contados de hoje: depois daquela data
    # o lote deixa de ser EPI pela NR-6, e a tarefa perdeu o objeto. Os 60 dias
    # aqui são só o padrão de quem abrir sem informar prazo.
    "CA_A_VENCER": ("Certificado de Aprovação do lote a vencer", 60),
    # §7.2 do desenho de EPI, e a razao de ela existir e a que esta escrita na
    # negativa: o modulo de EPI NUNCA escreve em `adicional_vigencia`. Se uma
    # entrega pudesse suspender ou cessar um adicional, o clique de quem opera o
    # almoxarifado cortaria o pagamento de alguem. Entao a entrega nao empurra
    # efeito nenhum — ela abre uma tarefa, com dono na CSSO e prazo, e quem
    # decide continua sendo quem subscreve laudo e assina parecer.
    #
    # Noventa dias, o mesmo prazo de `REAVALIACAO_LAUDO`, e pelo mesmo motivo:
    # reavaliar adicional e ir ao posto, medir e escrever parecer, nao e
    # despachar papel.
    "REAVALIAR_ADICIONAL_POR_EPI": (
        "Reavaliar o adicional após entrega de EPI",
        90,
    ),
    # RN-32. O prazo real de uma troca devida e a PROPRIA `previsao_troca`, que
    # ja passou quando a pendencia nasce — quem abre informa `prazo=` e a tarefa
    # entra atrasada, que e a verdade. Os 30 dias aqui sao so o padrao de quem
    # abrir sem informar, pela mesma logica de `CA_A_VENCER`.
    "TROCA_EPI_DEVIDA": ("Troca de EPI vencida (vida útil esgotada)", 30),
    # Fatia 7. O aviso que substituia a reserva automatica era uma mensagem na
    # tela de entrada de lote: so via quem estivesse lancando naquele momento, e
    # depois disso o item ficava dependendo de alguem lembrar dele. A reserva
    # continua sendo ato explicito (mudar o disponivel sozinho e o que a fatia 5
    # recusou); o que passa a nao depender de memoria e a LEMBRANCA.
    #
    # Trinta dias porque o que a tarefa cobra nao e entregar — pode nao haver o
    # que entregar —, e sim decidir: comprar, reservar o que entrou ou dizer ao
    # requerente que o item nao vem. Item parado em SEM_ESTOQUE sem nenhuma
    # dessas tres coisas e pedido esquecido.
    "EPI_SEM_ESTOQUE": ("Item de requisição de EPI esperando estoque", 30),
    # --- Os dois avisos do REQUERENTE (fatia do servidor comum) ---
    #
    # Todo tipo acima tem dono dentro da CSSO. Estes dois são os primeiros cuja
    # tarefa é de quem PEDIU — e nascem porque a auditoria da jornada mediu o
    # sino do requerente em zero ao enviar, zero ao ter item aprovado, zero ao
    # ter item recusado e zero ao ter item reservado. Um pedido formal, com
    # protocolo e prazo, produzia menos aviso do que o e-mail que ele veio
    # substituir: para saber o desfecho a pessoa tinha de reabrir a fila por
    # iniciativa própria.
    #
    # **Não é um segundo mecanismo.** O sistema tem um só canal de aviso — o
    # sino —, e é o que a pessoa já olha. Não há SMTP aqui, e um segundo canal
    # seria uma segunda lista para manter viva.
    #
    # **O que NÃO abre tarefa, e por quê.** Pedido enviado: foi ele quem enviou,
    # e a tela do envio já responde com o protocolo. Item entregue: ele estava no
    # balcão e assinou o comprovante — tarefa para avisar de um fato que a pessoa
    # presenciou é ruído, e ruído faz parar de olhar o sino. Item aprovado
    # sozinho: aprovação é promessa, não é o que se vai buscar; o aviso útil vem
    # depois, quando há lote reservado. Sobram os três momentos em que o sistema
    # sabe algo que a pessoa NÃO tem como saber: a decisão, o indeferimento e a
    # reserva.
    #
    # Quinze dias nos dois, e é o prazo de `DEMANDA_COM_PRAZO` pela mesma razão:
    # é a meia dúzia de dias úteis em que a informação ainda é resposta.
    #
    # Ler a decisão é o que a RN-27 existe para permitir: o motivo da recusa sai
    # congelado como a pessoa o recebeu. Fecha sozinha quando o pedido é atendido,
    # cancelado ou reaberto para análise — ver `DECIDIDO_E_NAO_LIDO` e
    # `epi_requisicao.sincronizar_pendencia_de_decisao`.
    "EPI_DECISAO_A_LER": ("Ler a decisão do seu pedido de EPI", 15),
    # A reserva é o único momento em que existe equipamento separado com o nome
    # do pedido. Sem este aviso a pessoa não sabe que pode ir buscar, e a reserva
    # segura estoque que nenhum outro pedido pode receber. Fecha sozinha na saída
    # de `RESERVADO`, seja qual for — ver `sincronizar_pendencia_de_retirada`.
    "EPI_RETIRADA_DISPONIVEL": ("Retirar o EPI reservado para você", 15),
    # A demanda que chegou com prazo. É a terceira decisão do dono do sistema
    # ("o prazo é opcional e cobra"): informado o prazo, a demanda deixa de
    # depender de alguém abrir a tela dela e passa a cair no MESMO sino das
    # outras tarefas do setor — e fica vermelha no mesmo dia em que as outras
    # ficariam. Sem prazo não abre pendência nenhuma: uma tarefa por demanda
    # registrada encheria o sino de coisa que ninguém prometeu para data
    # nenhuma, e sino que grita sempre deixa de ser lido.
    #
    # O prazo REAL é o que quem registrou informou, e `abrir` o recebe pronto.
    # Os quinze dias aqui são só o padrão de quem chamar sem informar — pela
    # mesma lógica de `CA_A_VENCER` e `TROCA_EPI_DEVIDA` —, e são quinze porque
    # é a meia dúzia de dias úteis em que um pedido de balcão ainda é resposta,
    # e não desculpa.
    "DEMANDA_COM_PRAZO": ("Demanda com prazo a cumprir", 15),
    # O pedido de vaga que o próprio servidor fez (`turma.inscrever_se`). É a
    # única tarefa desta lista que nasce de um ato de FORA da CSSO, e é por isso
    # que ela precisa existir: sem SMTP, o sino é o único lugar onde o setor
    # descobre que alguém pediu alguma coisa. Sem ela, o pedido ficaria numa aba
    # que ninguém tem motivo para reabrir — e "inscrição que morre na fila" é
    # exatamente o defeito que esta fatia veio consertar.
    #
    # Nasce SEM responsável: é do setor, e `no_escopo` só recorta por
    # `responsavel_id` no escopo próprio — a tarefa aparece para toda a CSSO e
    # não aparece para quem a gerou. Fecha sozinha quando a inscrição sai de
    # INSCRITA, seja por confirmação, seja por cancelamento — ver
    # `turma.fechar_pendencia_de_confirmacao`.
    #
    # Dez dias são só o padrão de quem abrir sem informar: o prazo REAL é o fim
    # das inscrições da turma, ou o início dela — confirmar depois do início não
    # confirma nada. Mesma lógica de `CA_A_VENCER`.
    "TURMA_INSCRICAO_A_CONFIRMAR": (
        "Confirmar inscrição pedida pelo próprio servidor",
        10,
    ),
}

# ---------------------------------------------------------------------
# Quem entra em /pendencias
# ---------------------------------------------------------------------
# A tela nasceu dentro do Processos SEI e exigia `processo.ver` para ler e
# `processo.editar` para fechar. A pendencia deixou de ser so do processo:
# reciclagem de treinamento, CA a vencer e prazo do art. 214 caem no mesmo sino,
# e quem opera esses modulos nao tem nenhuma das duas permissoes — receberia a
# tarefa sem conseguir ver nem fechar.
#
# A solucao nao e abrir para todo mundo: aceitar "qualquer permissao" deixaria
# entrar o admin_ti, que tem `indicador.ver` e, por decisao de projeto, nao ve
# conteudo tecnico. E uma lista explicita de permissoes de LEITURA de modulo —
# modulo novo acrescenta a sua aqui, e o teste cobra que ela exista.
#
# Nao criamos uma permissao `pendencia.ver` de proposito: ela teria de ser
# semeada em todos os perfis operacionais, e `semear_rbac` nunca remove nada de
# perfil — um nome errado so sai por SQL.
#
# `epi.ver` entrou com a fatia 2 do modulo de EPI, que e a primeira a abrir
# pendencia (`COMPROVANTE_EPI_PENDENTE`). Hoje ela nao muda a visibilidade de
# ninguem — todo perfil que tem `epi.ver` ja tem `processo.ver` —, e e
# exatamente por isso que o momento de acrescenta-la e agora: quando o perfil
# `almoxarife_sesmt` nascer na fatia 3, sem SST nenhuma, a lista ja estara
# certa. Ele receberia a tarefa e nao veria a tela.
# `demanda.ver` entrou com a fatia de Demandas, e pela mesma razao que `epi.ver`
# entrou na fatia 2 do EPI: hoje ela nao muda a visibilidade de ninguem (todo
# perfil que a tem ja tem `processo.ver` ou `epi.ver`), e e exatamente por isso
# que o momento de acrescenta-la e agora — no dia em que existir um perfil que
# so registre demanda, ele receberia a tarefa do prazo e nao veria a tela.
PERMISSOES_VER: tuple[str, ...] = (
    "processo.ver",
    "treinamento.ver",
    "epi.ver",
    "demanda.ver",
)

# Fechar pendencia dos outros e ato de quem opera o modulo. Fechar a PROPRIA
# pendencia nao depende desta lista: ver `pode_concluir`.
PERMISSOES_CONCLUIR: tuple[str, ...] = (
    "processo.editar",
    "treinamento.gerenciar",
    "epi.entregar",
)


def pode_ver(usuario: UsuarioAtual | None) -> bool:
    return usuario is not None and any(usuario.pode(c) for c in PERMISSOES_VER)


def exigir_ver(usuario: UsuarioAtual) -> None:
    if not pode_ver(usuario):
        raise PermissaoNegada(
            PERMISSOES_VER[0],
            "As pendências são de quem opera algum módulo. É preciso ao menos "
            "uma destas permissões: " + ", ".join(PERMISSOES_VER) + ".",
        )


def pode_concluir(usuario: UsuarioAtual | None, pendencia: Pendencia) -> bool:
    """Fecha quem opera o modulo — e sempre o dono da tarefa.

    O responsavel fecha a propria pendencia mesmo sem permissao de escrita: foi
    a ele que a regra atribuiu o trabalho, e tarefa que o dono nao consegue
    riscar da lista vira lista que ninguem le.
    """
    if not pode_ver(usuario):
        return False
    if pendencia.responsavel_id is not None and pendencia.responsavel_id == usuario.id:
        return True
    return any(usuario.pode(c) for c in PERMISSOES_CONCLUIR)


def exigir_concluir(usuario: UsuarioAtual, pendencia: Pendencia) -> None:
    exigir_ver(usuario)  # a mensagem certa para quem nem ve a tela
    if not pode_concluir(usuario, pendencia):
        raise PermissaoNegada(
            PERMISSOES_CONCLUIR[0],
            "Concluir pendência de outra pessoa exige permissão de escrita no "
            "módulo: " + ", ".join(PERMISSOES_CONCLUIR) + ".",
        )


def abrir(
    s: Session,
    *,
    tipo: str,
    chave: str,
    descricao: str,
    usuario: UsuarioAtual | None = None,
    processo_id: int | None = None,
    parecer_id: int | None = None,
    laudo_id: int | None = None,
    entidade: str | None = None,
    entidade_id: int | None = None,
    responsavel_id: int | None = None,
    prazo: date | None = None,
) -> Pendencia:
    """Idempotente por `chave`: a mesma regra nao abre duas pendencias iguais.

    `entidade`/`entidade_id` sao a ancora dos modulos que nao tem processo,
    parecer nem laudo. O par vai junto ou nao vai: meia ancora nao leva a lugar
    nenhum, e a CHECK do banco recusa.
    """
    if (entidade is None) != (entidade_id is None):
        raise ValueError("entidade e entidade_id andam juntos: informe os dois ou nenhum")

    existente = s.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one_or_none()
    if existente is not None:
        return existente

    dias = TIPOS.get(tipo, ("", 30))[1]
    pendencia = Pendencia(
        tipo=tipo,
        chave=chave,
        descricao=descricao,
        processo_id=processo_id,
        parecer_id=parecer_id,
        laudo_id=laudo_id,
        entidade=entidade,
        entidade_id=entidade_id,
        responsavel_id=responsavel_id or (usuario.id if usuario else None),
        prazo=prazo or (date.today() + timedelta(days=dias)),
    )
    s.add(pendencia)
    s.flush()
    auditoria.registrar(
        s,
        entidade="pendencia",
        entidade_id=pendencia.id,
        processo_id=processo_id,
        tipo_evento="PENDENCIA_ABERTA",
        descricao=f"{TIPOS.get(tipo, (tipo,))[0]}: {descricao}",
        usuario=usuario,
    )
    return pendencia


def reabrir(
    s: Session, pendencia: Pendencia, usuario: UsuarioAtual, motivo: str
) -> Pendencia:
    """A tarefa voltou a ter objeto — a mesma tarefa, e nao uma segunda.

    Existe porque a idempotencia de `abrir` e por CHAVE, e nao por chave-em-
    aberto: chamada de novo, ela devolve a pendencia CONCLUIDA sem reabrir nada.
    Isso e o certo para a regra que so acontece uma vez (o comprovante de uma
    entrega), e e o errado para a que vai e volta — o item de EPI que foi
    reservado e teve a reserva solta esta sem estoque de novo, pelo mesmo motivo
    de antes, e sem isto ele sairia do sino em silencio.

    Reabrir, e nao abrir outra com chave nova: o historico da tarefa e um so, e
    duas linhas para o mesmo item fariam a fila contar duas vezes o que e uma
    coisa. A ida e a volta ficam na trilha, que e onde elas se leem.
    """
    if not pendencia.concluida:
        return pendencia
    pendencia.concluida = False
    pendencia.concluida_em = None
    pendencia.concluida_por = None
    auditoria.registrar(
        s,
        entidade="pendencia",
        entidade_id=pendencia.id,
        processo_id=pendencia.processo_id,
        tipo_evento="PENDENCIA_REABERTA",
        descricao=f"{pendencia.descricao} — {motivo}",
        comentario=motivo,
        usuario=usuario,
    )
    s.flush()
    return pendencia


def concluir_pela_rotina(s: Session, pendencia: Pendencia, motivo: str) -> Pendencia:
    """A tarefa que perdeu o objeto, fechada por quem nao e ninguem.

    A varredura noturna (`ferramentas/varrer_pendencias.py`) revê lotes e
    fichas sem usuario — a rotina nao e uma pessoa, e por o nome de alguem como
    "quem fechou" seria mentir na trilha. `concluida_por` fica nulo e a linha
    da auditoria sai com `usuario_nome` dizendo que foi a rotina, e por que:
    o CA renovado, o lote inativado, a troca substituida. O que a tarefa
    cobrava deixou de existir; ninguem a "fez".
    """
    if pendencia.concluida:
        return pendencia
    pendencia.concluida = True
    pendencia.concluida_em = agora_utc()
    pendencia.concluida_por = None
    auditoria.registrar(
        s,
        entidade="pendencia",
        entidade_id=pendencia.id,
        processo_id=pendencia.processo_id,
        tipo_evento="PENDENCIA_CONCLUIDA",
        descricao=f"{pendencia.descricao} — fechada pela rotina de varredura: {motivo}",
        usuario=None,
        usuario_nome="rotina de varredura",
    )
    s.flush()
    return pendencia


def concluir(s: Session, pendencia: Pendencia, usuario: UsuarioAtual) -> Pendencia:
    if pendencia.concluida:
        return pendencia
    pendencia.concluida = True
    pendencia.concluida_em = agora_utc()
    pendencia.concluida_por = usuario.id
    auditoria.registrar(
        s,
        entidade="pendencia",
        entidade_id=pendencia.id,
        processo_id=pendencia.processo_id,
        tipo_evento="PENDENCIA_CONCLUIDA",
        descricao=pendencia.descricao,
        usuario=usuario,
    )
    s.flush()
    return pendencia


def no_escopo(consulta, usuario: UsuarioAtual | None):
    """A fila do setor, recortada pelo escopo de quem abre a tela.

    `Pendencia` **não** tem `servidor_id`, e por isso não passa por
    `aplicar_escopo`: o ramo de escopo próprio devolveria `where(False)` e o
    aviso de "modelo sem `servidor_id`", que é a mensagem errada. A lista não
    ficaria vazia por engano de escopo — ela fica vazia porque a fila é do setor,
    e a âncora de dono que a pendência tem é `responsavel_id`, um usuário a quem
    a regra atribuiu trabalho. Quem não opera módulo nenhum não é responsável por
    tarefa nenhuma, e a lista dele é vazia por regra, não por acidente.

    Isso importa porque a `descricao` é texto livre e nomeia terceiros —
    `"… entregue a Fulano de Tal em 14/08/2026"` —, por fora do helper da RN-19.
    Enquanto a descrição não for reescrita (é a outra metade do M-1), o escopo é
    o que impede a fila de publicar nome, EPI recebido e data de quatro pessoas
    para quem só entrou para pedir uma bota.
    """
    if usuario is None or usuario.escopo != ESCOPO_PROPRIO:
        return consulta
    return consulta.where(Pendencia.responsavel_id == usuario.id)


# A ancora que sabe dizer DE QUEM e a tarefa. Entidade nova entra aqui quando
# tiver como responder a pergunta — e nao antes: chave ausente cai no lado
# seguro (`None`), que e a leitura de hoje.
_TITULAR_POR_ENTIDADE: tuple[str, ...] = (
    "epi_requisicao",
    "epi_requisicao_item",
    "epi_ficha_registro",
)


def titular_de(s: Session, itens: list[Pendencia]) -> dict[int, int | None]:
    """`{pendencia.id: servidor_id}` — a outra metade do M-1, do lado da leitura.

    `/pendencias` chamava `texto_livre(p.descricao)` sem `sobre`, e o proprio
    docstring de `identificacao.texto_livre` registrava por que: "a lista de
    /pendencias nao sabe" de quem e o texto. Nao saber e cair no lado seguro —
    so quem le nome de qualquer pessoa le a frase —, e o lado seguro suprimia
    tambem a frase do **titular**, que e quem a LGPD art. 18, II manda atender.
    Com a fatia do requerente isso deixou de ser uma imprecisao e passou a ser o
    defeito: a tarefa nasce para ele, entra no sino dele, e ele abre a tela e le
    "conteudo suprimido (RN-19)" sobre o proprio pedido.

    A lista passa a saber pela ANCORA, que ja esta na linha: a requisicao, o item
    dela e o registro da ficha todos sabem de que servidor sao. Nao alarga nada —
    `pode_ver_nominal` continua decidindo, e continua exigindo `exposicao.ver`
    para ler a frase de terceiro. O que muda e que o titular deixa de ser tratado
    como terceiro sobre o proprio dado.

    Uma consulta por entidade, e nao uma por linha: a tela lista dezenas.
    """
    from app.modelos import EpiFichaRegistro, EpiRequisicao, EpiRequisicaoItem

    modelos = {
        "epi_requisicao": EpiRequisicao,
        "epi_ficha_registro": EpiFichaRegistro,
    }
    por_entidade: dict[str, set[int]] = {}
    for pendencia in itens:
        if pendencia.entidade in _TITULAR_POR_ENTIDADE and pendencia.entidade_id:
            por_entidade.setdefault(pendencia.entidade, set()).add(pendencia.entidade_id)

    dono: dict[tuple[str, int], int | None] = {}
    for entidade, ids in por_entidade.items():
        if entidade == "epi_requisicao_item":
            # o item nao tem `servidor_id`: quem o tem e o envelope dele
            linhas = s.execute(
                select(EpiRequisicaoItem.id, EpiRequisicao.servidor_id)
                .join(EpiRequisicao, EpiRequisicaoItem.requisicao_id == EpiRequisicao.id)
                .where(EpiRequisicaoItem.id.in_(ids))
            )
        else:
            modelo = modelos[entidade]
            linhas = s.execute(
                select(modelo.id, modelo.servidor_id).where(modelo.id.in_(ids))
            )
        for identificador, servidor_id in linhas:
            dono[(entidade, identificador)] = servidor_id

    return {
        p.id: dono.get((p.entidade or "", p.entidade_id or 0)) for p in itens
    }


def abertas(
    s: Session, usuario: UsuarioAtual | None = None, apenas_minhas: bool = False
) -> list[Pendencia]:
    consulta = no_escopo(
        select(Pendencia).where(Pendencia.concluida.is_(False)), usuario
    )
    if apenas_minhas and usuario is not None:
        consulta = consulta.where(Pendencia.responsavel_id == usuario.id)
    itens = list(s.execute(consulta).scalars())
    # sem prazo vai para o fim; atrasadas primeiro
    return sorted(itens, key=lambda p: (p.prazo is None, p.prazo or date.max))


def contar_abertas(s: Session, usuario: UsuarioAtual | None = None) -> tuple[int, int]:
    """Devolve (total abertas, atrasadas)."""
    itens = abertas(s, usuario)
    return len(itens), sum(1 for p in itens if p.atrasada())
