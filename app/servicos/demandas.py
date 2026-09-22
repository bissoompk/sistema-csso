"""Demandas — o que chegou por fora do SEI, e o que se fez dele.

O problema, nas palavras de quem opera o setor: *"quero ter a possibilidade de
colocar demandas que chegaram para mim por e-mail ou presencialmente, que ainda
não viraram ou não vão virar processo SEI, mas precisam de encaminhamentos, como
organizar isso para eu não perder essa demanda"*.

Três decisões de projeto atravessam este arquivo inteiro, e é melhor lê-las
antes do que deduzi-las depois:

1. **A equipe toda enxerga.** A lista não é filtrada por dono — é a fila do
   setor. Demanda que só uma pessoa vê some quando ela entra de férias, que é
   exatamente o defeito que a caixa de e-mail já produz.
2. **O vínculo com o processo SEI existe, e é uma chave estrangeira.** Encerrar
   uma demanda como `VIROU_PROCESSO` exige o `processo.id` real; sem processo
   cadastrado, a recusa diz onde cadastrá-lo em vez de aceitar um NUP digitado
   à mão, que seria uma segunda fonte para o mesmo número — sem o `unique` e
   sem o CHECK de formato que `processo.nup` tem.
3. **O prazo é opcional e cobra.** Com prazo, a demanda abre pendência e entra
   no sino junto das outras tarefas; sem prazo, fica só na lista de abertas.
   `_sincronizar_pendencia` é o único lugar que decide isso, e ele é chamado
   depois de toda escrita que possa mexer em prazo, dono ou estado.

**RN-21 em todo texto livre, e este é o campo mais perigoso do sistema.** É aqui
que alguém escreve, com pressa, "servidora está grávida e pediu remoção" ou "tem
laudo de depressão". Cada campo de texto passa por `textos.exigir_texto_limpo`
antes de qualquer gravação — e a recusa sobe como exceção para a rota poder
devolver o formulário com o que foi digitado, porque recusa que apaga o texto
ensina a escrever menos, não a escrever melhor.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import Demanda, DemandaEncaminhamento, Pendencia, Processo, agora_utc
from app.modelos.estados import (
    CANAIS_DEMANDA,
    DESFECHOS_DEMANDA,
    ROTULO_DESFECHO_DEMANDA,
    exigir_transicao_demanda,
)
from app.servicos import auditoria, pendencias, textos
from app.servicos.rbac import UsuarioAtual

PERMISSAO_VER = "demanda.ver"
PERMISSAO_ESCREVER = "demanda.registrar"

TIPO_PENDENCIA = "DEMANDA_COM_PRAZO"


class RegraDaDemanda(ValueError):
    """Recusa de regra de negócio — some na tela como aviso, não como 500."""


def chave_pendencia(demanda_id: int) -> str:
    """A chave idempotente da pendência do prazo.

    Uma por demanda, para sempre: `pendencias.abrir` deduplica por ela, então
    salvar a tela duas vezes não abre duas tarefas, e uma demanda que perdeu o
    prazo e o recuperou volta para a MESMA linha do sino — com o histórico
    inteiro na trilha, em vez de virar duas tarefas para o mesmo trabalho.
    """
    return f"demanda:{demanda_id}"


# ---------------------------------------------------------------------
# A pendência do prazo — o único lugar que decide se a demanda cobra
# ---------------------------------------------------------------------
def _sincronizar_pendencia(
    s: Session, demanda: Demanda, usuario: UsuarioAtual | None
) -> Pendencia | None:
    """Põe a fila de tarefas em dia com o que a demanda diz agora.

    Existe como função única, e chamada depois de toda escrita, porque as quatro
    situações são a mesma pergunta ("esta demanda ainda cobra alguém, e até
    quando?") e três respostas diferentes para ela apareceriam como sino
    mentindo: tarefa aberta de demanda encerrada, tarefa com o dono antigo, ou
    prazo do sino diferente do prazo da tela.

    - encerrada, ou sem prazo  → conclui a tarefa, se houver;
    - com prazo e sem tarefa   → abre;
    - com prazo e com tarefa concluída → **reabre a mesma**, e não abre outra:
      o histórico da tarefa é um só (é o mesmo argumento de `pendencias.reabrir`);
    - com prazo e tarefa aberta → reconfere prazo, dono e descrição.
    """
    existente = s.execute(
        select(Pendencia).where(Pendencia.chave == chave_pendencia(demanda.id))
    ).scalar_one_or_none()

    if demanda.estado == "ENCERRADA" or demanda.prazo is None:
        if existente is not None and not existente.concluida and usuario is not None:
            pendencias.concluir(s, existente, usuario)
        return existente

    descricao = f"{demanda.assunto} — demanda de {demanda.solicitante_nome}"
    if existente is None:
        return pendencias.abrir(
            s,
            tipo=TIPO_PENDENCIA,
            chave=chave_pendencia(demanda.id),
            descricao=descricao,
            usuario=usuario,
            entidade="demanda",
            entidade_id=demanda.id,
            responsavel_id=demanda.responsavel_id,
            prazo=demanda.prazo,
        )
    if existente.concluida and usuario is not None:
        pendencias.reabrir(s, existente, usuario, "a demanda voltou a ter prazo")
    existente.descricao = descricao
    existente.responsavel_id = demanda.responsavel_id
    existente.prazo = demanda.prazo
    return existente


# ---------------------------------------------------------------------
# Registro
# ---------------------------------------------------------------------
def _limpar(valor: str | None, campo: str) -> str | None:
    """`strip`, depois RN-21 — e devolve `None` para o que ficou vazio.

    O `strip` primeiro porque `required` do HTML só barra a string vazia: um
    espaço passa, e um assunto de um espaço é uma linha em branco na fila. Ele
    não muda o que a RN-21 vê — espaço não é termo proibido —, e é o que permite
    quem chama distinguir "não informado" de "informado em branco" com um `is
    None`, em vez de espalhar `.strip()` por cada ponto de chamada.

    `campo` é o RÓTULO DA TELA, e não o nome da coluna: quem lê a recusa é
    engenheiro de segurança do trabalho, e "o campo `descricao`" não ajuda
    ninguém a achar onde consertar.
    """
    texto = (valor or "").strip()
    if not texto:
        return None
    textos.exigir_texto_limpo(texto, campo)
    return texto


def registrar(
    s: Session,
    usuario: UsuarioAtual,
    *,
    assunto: str,
    canal: str,
    solicitante_nome: str,
    data_chegada: date | None = None,
    descricao: str | None = None,
    solicitante_servidor_id: int | None = None,
    solicitante_unidade_uorg_id: int | None = None,
    responsavel_id: int | None = None,
    prazo: date | None = None,
) -> Demanda:
    """Grava a demanda que acabou de chegar.

    Os três padrões que fazem isto caber em trinta segundos moram aqui e não na
    tela: data de hoje, responsável = quem está cadastrando, e o canal mais
    comum primeiro no seletor (a ordem de `CANAIS_DEMANDA`). Se registrar der
    trabalho, ninguém registra — e a funcionalidade morre com a lista vazia.
    """
    usuario.exigir(PERMISSAO_ESCREVER)

    if canal not in CANAIS_DEMANDA:
        raise RegraDaDemanda(f"Canal desconhecido: {canal!r}.")
    assunto_limpo = _limpar(assunto, "assunto")
    if assunto_limpo is None:
        raise RegraDaDemanda(
            "O assunto é obrigatório — é a linha que aparece na fila, e sem ela "
            "a demanda vira uma data sem conteúdo."
        )
    solicitante = _limpar(solicitante_nome, "quem demandou")
    if solicitante is None:
        raise RegraDaDemanda(
            "Diga quem demandou. Pode ser servidor do cadastro, chefia ou alguém "
            "de fora — o nome escrito é o que permite retomar a conversa depois."
        )

    demanda = Demanda(
        data_chegada=data_chegada or date.today(),
        canal=canal,
        solicitante_nome=solicitante,
        solicitante_servidor_id=solicitante_servidor_id,
        solicitante_unidade_uorg_id=solicitante_unidade_uorg_id,
        assunto=assunto_limpo,
        descricao=_limpar(descricao, "descrição da demanda"),
        responsavel_id=responsavel_id or usuario.id,
        prazo=prazo,
        estado="ABERTA",
        criada_por=usuario.id,
    )
    s.add(demanda)
    s.flush()

    auditoria.registrar(
        s,
        entidade="demanda",
        entidade_id=demanda.id,
        tipo_evento="DEMANDA_REGISTRADA",
        descricao=(
            f"{demanda.assunto} — chegou por {canal.lower()} em "
            f"{demanda.data_chegada.isoformat()}"
        ),
        usuario=usuario,
    )
    _sincronizar_pendencia(s, demanda, usuario)
    return demanda


def atribuir(
    s: Session, usuario: UsuarioAtual, demanda: Demanda, *, responsavel_id: int | None
) -> Demanda:
    """Passa a demanda para outra pessoa.

    É o antídoto direto da frase que originou a funcionalidade: férias, licença
    e mudança de atribuição acontecem, e sem esta ação a demanda continuaria
    cobrando quem não está. A pendência acompanha — tarefa com o dono errado é
    tarefa que ninguém lê.
    """
    usuario.exigir(PERMISSAO_ESCREVER)
    if demanda.estado == "ENCERRADA":
        raise RegraDaDemanda("Demanda encerrada não muda de responsável.")
    anterior = demanda.responsavel_id
    if anterior == responsavel_id:
        return demanda
    demanda.responsavel_id = responsavel_id
    auditoria.registrar(
        s,
        entidade="demanda",
        entidade_id=demanda.id,
        tipo_evento="DEMANDA_RESPONSAVEL_ALTERADO",
        descricao=demanda.assunto,
        campo="responsavel_id",
        valor_anterior=anterior,
        valor_novo=responsavel_id,
        usuario=usuario,
    )
    _sincronizar_pendencia(s, demanda, usuario)
    s.flush()
    return demanda


def _passar_a_andamento(
    s: Session, demanda: Demanda, usuario: UsuarioAtual, motivo: str
) -> None:
    """A transição ABERTA -> EM_ANDAMENTO, com a linha na trilha.

    Mora numa função porque ela acontece por DOIS caminhos — o botão explícito
    e o primeiro encaminhamento —, e toda transição de estado deste sistema
    deixa rastro. Escrita duas vezes, o segundo caminho seria o que esqueceria
    de registrar: foi assim que a demanda mudaria de estado em silêncio, e a
    trilha diria que ela nasceu em andamento.
    """
    exigir_transicao_demanda(demanda.estado, "EM_ANDAMENTO")
    demanda.estado = "EM_ANDAMENTO"
    auditoria.registrar(
        s,
        entidade="demanda",
        entidade_id=demanda.id,
        tipo_evento="DEMANDA_EM_ANDAMENTO",
        descricao=f"{demanda.assunto} — {motivo}",
        campo="estado",
        valor_anterior="ABERTA",
        valor_novo="EM_ANDAMENTO",
        usuario=usuario,
    )


def iniciar(s: Session, usuario: UsuarioAtual, demanda: Demanda) -> Demanda:
    """ABERTA -> EM_ANDAMENTO. É a diferença entre "ninguém pegou" e "estou nisso"."""
    usuario.exigir(PERMISSAO_ESCREVER)
    _passar_a_andamento(s, demanda, usuario, "alguém assumiu o caso")
    s.flush()
    return demanda


# ---------------------------------------------------------------------
# Encaminhamento — append-only (RN-31)
# ---------------------------------------------------------------------
def encaminhar(
    s: Session,
    usuario: UsuarioAtual,
    demanda: Demanda,
    *,
    para_quem: str,
    pedido: str,
    data_encaminhamento: date | None = None,
) -> DemandaEncaminhamento:
    """Registra o que foi pedido, a quem e quando. Nada se apaga depois.

    Encaminhar uma demanda ABERTA a põe EM_ANDAMENTO no mesmo ato: pedir alguma
    coisa a alguém **é** estar cuidando dela, e cobrar um segundo clique para
    dizer isso produziria uma fila cheia de demandas "abertas" com três
    encaminhamentos cada — o estado deixaria de descrever fato nenhum.
    """
    usuario.exigir(PERMISSAO_ESCREVER)
    if demanda.estado == "ENCERRADA":
        raise RegraDaDemanda(
            "Demanda encerrada não recebe encaminhamento — o desfecho já está "
            "escrito. Se o assunto voltou, registre uma demanda nova: a data de "
            "chegada é outra, e esta continua legível ao lado."
        )
    destino = _limpar(para_quem, "para quem")
    if destino is None:
        raise RegraDaDemanda("Diga para quem a demanda foi encaminhada.")
    texto = _limpar(pedido, "o que foi pedido")
    if texto is None:
        raise RegraDaDemanda(
            "Escreva o que foi pedido. Encaminhamento sem isso é um carimbo de "
            "data: seis meses depois ninguém sabe o que se esperava de volta."
        )

    encaminhamento = DemandaEncaminhamento(
        demanda_id=demanda.id,
        data_encaminhamento=data_encaminhamento or date.today(),
        para_quem=destino,
        pedido=texto,
        registrado_por=usuario.id,
    )
    s.add(encaminhamento)
    auditoria.registrar(
        s,
        entidade="demanda",
        entidade_id=demanda.id,
        tipo_evento="DEMANDA_ENCAMINHADA",
        descricao=f"{demanda.assunto} — para {destino}",
        comentario=texto,
        usuario=usuario,
    )
    if demanda.estado == "ABERTA":
        _passar_a_andamento(s, demanda, usuario, f"encaminhada a {destino}")
    s.flush()
    return encaminhamento


# ---------------------------------------------------------------------
# Encerramento com desfecho obrigatório — onde está o valor
# ---------------------------------------------------------------------
def encerrar(
    s: Session,
    usuario: UsuarioAtual,
    demanda: Demanda,
    *,
    desfecho: str,
    relato: str | None = None,
    processo_id: int | None = None,
    setor: str | None = None,
    data_desfecho: date | None = None,
) -> Demanda:
    """Fecha a demanda dizendo COMO ela terminou. Sem desfecho não encerra.

    Cada desfecho cobra a sua prova, e a recusa de cada um nomeia o que falta:

    - `RESOLVIDA` — o que foi feito, por escrito;
    - `VIROU_PROCESSO` — o processo REAL, resolvido pelo NUP em `processo_id`
      antes de chegar aqui. **Se o processo não existe no sistema, a resposta é
      recusar e dizer onde cadastrá-lo**, e não aceitar o número como texto: a
      rastreabilidade que esta funcionalidade promete é a de clicar e chegar no
      processo, e um NUP solto seria a promessa sem a coisa;
    - `ENCAMINHADA` — para qual setor e em que data;
    - `SEM_PROVIDENCIA` — o motivo. É o desfecho mais importante dos quatro:
      "não vamos fazer nada" é decisão legítima, e o que não pode é ela ser
      tomada por esquecimento.
    """
    usuario.exigir(PERMISSAO_ESCREVER)
    exigir_transicao_demanda(demanda.estado, "ENCERRADA")
    if desfecho not in DESFECHOS_DEMANDA:
        raise RegraDaDemanda("Escolha um desfecho: é ele que diz como terminou.")

    texto = _limpar(relato, "o desfecho da demanda")
    destino = _limpar(setor, "setor de destino")

    if desfecho == "VIROU_PROCESSO":
        if processo_id is None or s.get(Processo, processo_id) is None:
            raise RegraDaDemanda(
                "Este desfecho aponta para um processo que existe no sistema, e "
                "esse processo não foi encontrado. Cadastre-o em “Novo processo” "
                "e volte: é o que faz a demanda virar um link para o processo, "
                "em vez de um número anotado."
            )
    elif desfecho == "ENCAMINHADA":
        if destino is None:
            raise RegraDaDemanda(
                "Diga para qual setor a demanda foi encaminhada — sem isso o "
                "encerramento não diz onde o assunto está agora."
            )
        data_desfecho = data_desfecho or date.today()
    if desfecho in ("RESOLVIDA", "SEM_PROVIDENCIA") and texto is None:
        exigido = (
            "escreva o que foi feito"
            if desfecho == "RESOLVIDA"
            else "escreva o motivo de não haver providência"
        )
        raise RegraDaDemanda(f"Falta o desfecho por escrito — {exigido}.")

    demanda.estado = "ENCERRADA"
    demanda.desfecho = desfecho
    demanda.desfecho_relato = texto
    demanda.desfecho_processo_id = processo_id if desfecho == "VIROU_PROCESSO" else None
    demanda.desfecho_setor = destino if desfecho == "ENCAMINHADA" else None
    demanda.desfecho_data = data_desfecho if desfecho == "ENCAMINHADA" else None
    demanda.encerrada_em = agora_utc()
    demanda.encerrada_por = usuario.id

    auditoria.registrar(
        s,
        entidade="demanda",
        entidade_id=demanda.id,
        tipo_evento="DEMANDA_ENCERRADA",
        descricao=f"{demanda.assunto} — {ROTULO_DESFECHO_DEMANDA[desfecho]}",
        campo="desfecho",
        valor_novo=desfecho,
        comentario=texto or destino,
        # o processo que a demanda gerou entra na trilha do PROCESSO também:
        # é lá que alguém, meses depois, pergunta de onde aquilo veio
        processo_id=demanda.desfecho_processo_id,
        usuario=usuario,
    )
    # encerrada não cobra mais nada: a tarefa do prazo sai do sino junto
    _sincronizar_pendencia(s, demanda, usuario)
    s.flush()
    return demanda


# ---------------------------------------------------------------------
# Leitura
# ---------------------------------------------------------------------
def listar(
    s: Session,
    *,
    estado: str = "",
    responsavel_id: int | None = None,
    busca: str = "",
) -> list[Demanda]:
    """A fila do setor, sem filtro de escopo — e isso é decisão, não esquecimento.

    `aplicar_escopo` recorta por campus, e demanda não tem campus: ela é o
    pedido que chegou ao setor, que atende os quatro. Recortar por
    `servidor_id` (escopo próprio) devolveria lista vazia para quem tem esse
    escopo, sem erro nenhum — o modo de falha silencioso que `aplicar_escopo`
    registra em log. Por isso o corte é o de PERMISSÃO, na rota: quem não tem
    `demanda.ver` não abre a tela, e quem tem vê a fila inteira, que é a decisão
    do dono do sistema.

    A ordenação é a da urgência: atrasada primeiro, depois por prazo, e as sem
    prazo por último — a mesma de `pendencias.abertas`, para as duas telas
    contarem a mesma história sobre a mesma linha.
    """
    consulta = select(Demanda)
    if estado:
        consulta = consulta.where(Demanda.estado == estado)
    if responsavel_id is not None:
        consulta = consulta.where(Demanda.responsavel_id == responsavel_id)
    itens = list(s.execute(consulta).scalars())

    alvo = textos.chave_busca(busca)
    if alvo:
        # A busca NÃO casa `solicitante_nome` para quem não pode ver nome
        # (RN-19): a lista suprime a identificação, e um filtro que respondesse
        # "sim, é este" amarraria o nome ao código opaco da sessão — o oráculo
        # que `identificacao.casa_a_busca` existe para fechar em /servidores.
        # Aqui o casamento é por ASSUNTO, que é texto do trabalho e não da
        # pessoa, e é o que quem procura tem na cabeça.
        itens = [d for d in itens if alvo in textos.chave_busca(d.assunto)]

    return sorted(
        itens,
        key=lambda d: (d.prazo is None, d.prazo or date.max, -d.id),
    )


def contar_por_estado(s: Session) -> dict[str, int]:
    """O número que vai em cada ficha de filtro da tela.

    Sai da lista COMPLETA e não da filtrada, pelo mesmo motivo de `/laudos`: uma
    ficha "Encerradas (0)" que só diz zero porque o filtro vigente já as excluiu
    não informa nada e ainda contradiz a tela seguinte.
    """
    contagem: dict[str, int] = {}
    for demanda in s.execute(select(Demanda)).scalars():
        contagem[demanda.estado] = contagem.get(demanda.estado, 0) + 1
    return contagem
