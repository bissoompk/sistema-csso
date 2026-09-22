"""Presenca, nota e resultado da turma — fatia 3 de Certificados.

Tres regras governam este arquivo, e as tres existem porque o numero que sai
daqui decide se o certificado pode ser emitido:

1. **A frequencia e calculada, nunca digitada.** Sai da soma das horas
   presentes em `turma_presenca` sobre a carga da turma, e e recalculada a cada
   lancamento. Percentual digitado e percentual que ninguem consegue conferir
   depois — e este e o mesmo espirito da RN-07.

2. **O denominador e a carga da TURMA, nao a do catalogo.** `turma.carga_efetiva`
   ja resolve isso: a turma pode ter rodado com carga diferente da prevista (o
   NR-35 de 8h que virou 6h por causa da chuva), e usar a carga do catalogo
   produziria percentual errado em silencio. Errado em silencio, num numero que
   decide a emissao do certificado, e o pior defeito possivel aqui.

3. **O resultado nasce do fecho da turma, e nao se digita.** Concluir a turma e
   um ato so: muda a situacao E apura cada inscrito. Apurar depois, num segundo
   botao, deixaria a turma "concluida" com gente sem resultado — que e
   exatamente o estado que ninguem sabe ler.

Corrigir depois do fecho e possivel e **e um ato registrado**: pede
`turma.concluir`, exige motivo por escrito, recalcula a frequencia a partir dos
lancamentos e audita. Nao existe volta de estado silenciosa.

**Ha um limite para essa correcao, e ele entrou com a fatia 4:** inscricao que
ja tem certificado NAO anulado nao recebe lancamento nenhum. A regra e a do
SS11, item 12 do desenho — documento que circulou se anula e se reemite, nunca
se reescreve. Sem essa guarda, corrigir a presenca de quem ja tem o papel na mao
mudaria a frequencia da linha e deixaria o certificado emitido descrevendo um
resultado que o sistema nao afirma mais; pior, um REPROVADO superveniente
conviveria com um certificado valido. A guarda esta em `_exigir_lancamento`, que
e o unico portao por onde presenca e nota passam.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from sqlalchemy.orm import Session

from app.modelos import Certificado, Inscricao, Turma, TurmaPresenca, agora_utc
from app.modelos.estados import (
    INSCRICAO_COM_RESULTADO,
    INSCRICAO_FORA_DA_APURACAO,
    ROTULO_INSCRICAO,
    ROTULO_TURMA,
    exigir_transicao_inscricao,
)
from app.servicos import auditoria
from app.servicos.rbac import UsuarioAtual
from app.servicos.turma import RegraDaTurma, inscricoes_da_turma

CEM = Decimal(100)
CENTESIMO = Decimal("0.01")

PRESENCA_LANCADA = "PRESENCA_LANCADA"
PRESENCA_EM_LOTE = "PRESENCA_EM_LOTE"
NOTA_LANCADA = "NOTA_LANCADA"
TURMA_APURADA = "TURMA_APURADA"
RESULTADO_RETIFICADO = "RESULTADO_RETIFICADO"


# ---------------------------------------------------------------------
# Formatacao
# ---------------------------------------------------------------------
def numero(valor: Decimal | int | float | None) -> str:
    """8, 7,5 e 75 — sem os zeros que o Numeric(5,2) arrasta.

    A tela e a trilha de auditoria mostram o mesmo texto, e "frequencia de
    75,00%" numa mensagem de recusa parece saida de maquina, nao de gente.
    """
    if valor is None:
        return "—"
    texto = f"{Decimal(valor):.2f}".rstrip("0").rstrip(".")
    return (texto or "0").replace(".", ",")


def para_decimal(valor: str | Decimal | int | float | None) -> Decimal | None:
    """Aceita 8, 8,5 e 8.5 — a virgula e o separador que o setor digita."""
    if valor is None:
        return None
    if isinstance(valor, Decimal):
        return valor
    if isinstance(valor, (int, float)):
        return Decimal(str(valor))
    bruto = valor.strip().replace(",", ".")
    if not bruto:
        return None
    try:
        return Decimal(bruto)
    except (InvalidOperation, ValueError):
        return None


# ---------------------------------------------------------------------
# Leitura
# ---------------------------------------------------------------------
def dias_da_turma(turma: Turma) -> list[date]:
    """Os dias corridos entre inicio e fim.

    Corridos, e nao uteis: turma de NR acontece em sabado com frequencia, e
    esconder o sabado da grade obrigaria a lancar aquele dia por fora.
    """
    total = (turma.data_fim - turma.data_inicio).days
    return [turma.data_inicio + timedelta(days=passo) for passo in range(total + 1)]


def contagem_por_situacao(s: Session, turma: Turma) -> dict[str, int]:
    """Quantos inscritos em cada situacao — o cabecalho da aba e a mensagem do
    fecho leem daqui, e nao de uma contagem escrita duas vezes."""
    from sqlalchemy import func, select

    linhas = s.execute(
        select(Inscricao.situacao, func.count())
        .where(Inscricao.turma_id == turma.id)
        .group_by(Inscricao.situacao)
    ).all()
    return {situacao: int(total) for situacao, total in linhas}


def frequencia_de(inscricao: Inscricao) -> Decimal:
    """Horas presentes sobre a carga EFETIVA da turma, em percentual."""
    carga = Decimal(inscricao.turma.carga_efetiva or 0)
    if carga <= 0:  # pragma: no cover - `ck_treinamento_carga` ja impede
        return Decimal(0)
    bruta = inscricao.horas_presentes / carga * CEM
    return bruta.quantize(CENTESIMO, rounding=ROUND_HALF_UP)


def recalcular_frequencia(inscricao: Inscricao) -> Decimal:
    """Grava a frequencia derivada. Chamada a cada lancamento e no fecho.

    `None` significa "nunca se lancou nada"; zero significa "apurado e faltou a
    tudo". A diferenca importa na tela: uma pede lancamento, a outra ja e o
    resultado.
    """
    calculada = frequencia_de(inscricao)
    inscricao.frequencia_percentual = calculada
    return calculada


@dataclass(frozen=True)
class Avaliacao:
    """O resultado de um inscrito e por que ele e esse."""

    situacao: str
    motivos: tuple[str, ...] = ()

    @property
    def aprovado(self) -> bool:
        return self.situacao == "APROVADO"


def avaliar(turma: Turma, inscricao: Inscricao) -> Avaliacao:
    """APROVADO ou REPROVADO, com o motivo por escrito quando reprova.

    Recalcula a frequencia a partir dos lancamentos em vez de ler a coluna: a
    coluna e derivada, e julgar por uma copia e deixar aberta a hipotese de o
    resultado discordar da folha que o sustenta.

    A nota so entra na conta quando a turma declara `nota_minima_aprovacao`:
    nula significa que aquele treinamento nao avalia e basta a frequencia
    (SS11, item 4 do desenho). Com minima declarada e sem nota lancada, reprova
    — aprovar sem a nota que a propria turma exigiu seria dispensar a prova em
    silencio.
    """
    motivos: list[str] = []
    if not inscricao.compareceu:
        motivos.append("não há presença registrada")
    frequencia = frequencia_de(inscricao)
    if frequencia < turma.frequencia_minima_percentual:
        motivos.append(
            f"frequência de {numero(frequencia)}% abaixo do mínimo de "
            f"{numero(turma.frequencia_minima_percentual)}%"
        )
    if turma.nota_minima_aprovacao is not None:
        if inscricao.nota_final is None:
            motivos.append(
                f"nota não lançada, e a turma exige no mínimo "
                f"{numero(turma.nota_minima_aprovacao)}"
            )
        elif inscricao.nota_final < turma.nota_minima_aprovacao:
            motivos.append(
                f"nota {numero(inscricao.nota_final)} abaixo da mínima "
                f"{numero(turma.nota_minima_aprovacao)}"
            )
    if motivos:
        return Avaliacao("REPROVADO", tuple(motivos))
    return Avaliacao("APROVADO")


@dataclass(frozen=True)
class LinhaDaGrade:
    """Uma linha da grade dias x participantes da aba 3."""

    inscricao: Inscricao
    por_dia: dict[date, TurmaPresenca]
    horas: Decimal
    frequencia: Decimal
    avaliacao: Avaliacao

    @property
    def abaixo_do_minimo(self) -> bool:
        return not self.avaliacao.aprovado


def grade_da_turma(s: Session, turma: Turma) -> list[LinhaDaGrade]:
    """A grade da tela, montada uma vez e no servico.

    Na tela, quem esta abaixo do minimo aparece destacado — e o destaque usa a
    MESMA funcao que decide o resultado no fecho (`avaliar`). Uma segunda conta
    para a cor da linha seria a forma mais barata de a tela dizer "apto" e o
    fecho reprovar.
    """
    return [
        linha_da_grade(turma, inscricao)
        for inscricao in inscricoes_da_turma(s, turma)
        if inscricao.situacao not in INSCRICAO_FORA_DA_APURACAO
    ]


def linha_da_grade(turma: Turma, inscricao: Inscricao) -> LinhaDaGrade:
    """UMA linha, montada pela mesma conta que monta a grade inteira.

    Existe separada porque a troca parcial da aba de presenca devolve uma linha
    so — lancar um dia recalcula horas, frequencia e situacao daquele inscrito, e
    a tela troca a linha inteira em vez de recarregar a pagina. Uma segunda conta
    para a linha isolada seria a forma mais barata de a celula recem-trocada
    discordar da grade que ela esta dentro.
    """
    return LinhaDaGrade(
        inscricao=inscricao,
        por_dia={p.data: p for p in inscricao.presencas},
        horas=inscricao.horas_presentes,
        frequencia=frequencia_de(inscricao),
        avaliacao=avaliar(turma, inscricao),
    )


# ---------------------------------------------------------------------
# Guardas
# ---------------------------------------------------------------------
def certificado_ativo(s: Session, inscricao: Inscricao) -> Certificado | None:
    """O certificado nao anulado desta inscricao, se houver.

    `uq_certificado_ativo` garante que ha no maximo um; o `first()` e so para
    nao depender da constraint para nao levantar.
    """
    from sqlalchemy import select

    return (
        s.execute(
            select(Certificado).where(
                Certificado.inscricao_id == inscricao.id,
                Certificado.situacao != "ANULADO",
            )
        )
        .scalars()
        .first()
    )


def _exigir_lancamento(
    s: Session, usuario: UsuarioAtual, inscricao: Inscricao, motivo: str | None
) -> str | None:
    """Devolve o motivo da retificacao, ou `None` quando e lancamento comum.

    A permissao vem antes da situacao de proposito: quem nao pode avaliar ouve
    "permissao negada", e nao um conselho sobre o estado da turma que ele nao
    poderia mudar de qualquer jeito.

    Logo depois dela vem a guarda do certificado, e vem ANTES da conferencia de
    situacao porque a mensagem util aqui e a do certificado: quem tem papel
    emitido nao precisa ouvir "informe o motivo da retificacao" para descobrir,
    na tentativa seguinte, que o motivo nao adiantaria.
    """
    usuario.exigir("turma.avaliar")
    turma = inscricao.turma
    emitido = certificado_ativo(s, inscricao)
    if emitido is not None:
        # SS11, item 12: o certificado ja circulou. Reescrever a frequencia por
        # tras dele deixaria o papel afirmando um resultado que o sistema nao
        # afirma mais — e, no limite, um REPROVADO com certificado valido.
        raise RegraDaTurma(
            f"{inscricao.participante.nome_exibicao} já tem o certificado "
            f"{emitido.rotulo} emitido, e certificado que saiu não se reescreve: "
            "anule-o com o motivo e reemita depois de corrigir. Enquanto ele "
            "estiver válido, presença e nota desta inscrição ficam como estão."
        )
    limpo = (motivo or "").strip() or None
    if turma.situacao == "CONCLUIDA":
        # retificar e desfazer, em parte, um resultado ja comunicado: mesma
        # simetria do parecer, em que o tecnico emite e nao anula
        usuario.exigir("turma.concluir")
        if limpo is None:
            raise RegraDaTurma(
                f"{turma.codigo} já foi concluída: corrigir presença ou nota agora "
                "é retificação, e retificação exige o motivo por escrito — o "
                "resultado já foi comunicado a quem participou."
            )
        return limpo
    if turma.situacao != "EM_ANDAMENTO":
        raise RegraDaTurma(
            f"{turma.codigo} está {ROTULO_TURMA[turma.situacao].lower()}: passe a "
            "turma para em andamento antes de lançar presença ou nota."
        )
    return None


def _exigir_inscricao_lancavel(inscricao: Inscricao) -> None:
    if inscricao.situacao in INSCRICAO_FORA_DA_APURACAO:
        raise RegraDaTurma(
            f"A inscrição de {inscricao.participante.nome_exibicao} está "
            f"{ROTULO_INSCRICAO[inscricao.situacao].lower()} e não recebe lançamento."
        )


def _mover(
    s: Session,
    usuario: UsuarioAtual,
    inscricao: Inscricao,
    destino: str,
    *,
    tipo_evento: str = auditoria.ESTADO_ALTERADO,
    comentario: str | None = None,
    detalhe: str | None = None,
) -> None:
    """Transicao da maquina F disparada por lancamento, e nao por escolha.

    Nao reconfere permissao: quem chega aqui ja passou por `_exigir_lancamento`
    ou pelo `turma.concluir` do fecho. O que ela nao dispensa e a maquina —
    `exigir_transicao_inscricao` continua sendo a unica porta.
    """
    origem = inscricao.situacao
    if origem == destino:
        return
    exigir_transicao_inscricao(origem, destino)
    inscricao.situacao = destino
    if destino == "CONFIRMADA" and inscricao.confirmada_em is None:
        inscricao.confirmada_em = agora_utc()
        inscricao.confirmada_por = usuario.id
    auditoria.registrar(
        s,
        entidade="inscricao",
        entidade_id=inscricao.id,
        tipo_evento=tipo_evento,
        # RN-19 na ESCRITA: o `PTC-` no lugar do nome. Quem esta numa turma de
        # NR-35 nao e "fulano existe", e sim em que atividade de risco ele
        # trabalha — foi o que a 1.37.0 mediu na lista de chamada e fechou sob
        # `certificado.ver`. A trilha se le sob `auditoria.ver`, que nao e
        # permissao de ler nome; o `PTC-` identifica a linha sem dizer de quem e.
        descricao=(
            f"{inscricao.turma.codigo} · "
            f"{inscricao.participante.identificador_publico}: "
            f"{ROTULO_INSCRICAO.get(origem, origem)} -> "
            f"{ROTULO_INSCRICAO.get(destino, destino)}"
            + (f" — {detalhe}" if detalhe else "")
        ),
        campo="situacao",
        valor_anterior=origem,
        valor_novo=destino,
        comentario=comentario,
        usuario=usuario,
    )
    s.flush()


def _confirmar_por_presenca(s: Session, usuario: UsuarioAtual, inscricao: Inscricao) -> None:
    """Quem assinou a folha esta, por definicao, confirmado na turma.

    Sem isto, lancar a folha de trinta pessoas exigiria trinta cliques de
    "confirmar" antes — um ritual, nao uma decisao. A confirmacao continua sendo
    um ato registrado: entra na trilha com o motivo, so nao precisa de um botao
    proprio quando a prova de que a pessoa estava la e a assinatura dela.
    """
    if inscricao.situacao == "INSCRITA":
        _mover(
            s,
            usuario,
            inscricao,
            "CONFIRMADA",
            detalhe="confirmada pelo lançamento de presença",
        )


def _reapurar(
    s: Session, usuario: UsuarioAtual, inscricao: Inscricao, *, motivo: str
) -> Avaliacao:
    """Recalcula o resultado de quem ja tem um, depois de uma retificacao."""
    nova = avaliar(inscricao.turma, inscricao)
    _mover(
        s,
        usuario,
        inscricao,
        nova.situacao,
        tipo_evento=RESULTADO_RETIFICADO,
        comentario=motivo,
        detalhe="; ".join(nova.motivos) if nova.motivos else "critérios atendidos",
    )
    return nova


def _normalizar_comparecimento(
    s: Session, usuario: UsuarioAtual, inscricao: Inscricao
) -> None:
    """Poe a inscricao no estado que os lancamentos descrevem: PRESENTE ou AUSENTE.

    Quem compareceu passa por CONFIRMADA — a maquina F nao admite
    INSCRITA -> PRESENTE, e nao deve mesmo: presenca de quem a CSSO nunca
    aceitou na turma seria presenca de estranho. Quem nao compareceu vai direto
    a AUSENTE, porque confirmar alguem para em seguida marcar sua falta
    inventaria um ato que ninguem praticou.
    """
    destino = "PRESENTE" if inscricao.compareceu else "AUSENTE"
    if destino == "PRESENTE":
        _confirmar_por_presenca(s, usuario, inscricao)
    _mover(s, usuario, inscricao, destino)


def _ajustar_situacao(
    s: Session, usuario: UsuarioAtual, inscricao: Inscricao, *, motivo: str | None
) -> None:
    """Depois de mexer na presenca, poe a inscricao no estado que ela descreve —
    resultado inclusive, quando ja houver um."""
    if inscricao.situacao in INSCRICAO_COM_RESULTADO:
        # turma concluida: o estado intermediario ja passou, e o que se corrige
        # e o resultado. `motivo` e obrigatorio nesse caminho (`_exigir_lancamento`).
        _reapurar(s, usuario, inscricao, motivo=motivo or "")
        return
    _normalizar_comparecimento(s, usuario, inscricao)


# ---------------------------------------------------------------------
# Presenca
# ---------------------------------------------------------------------
def lancar_presenca(
    s: Session,
    usuario: UsuarioAtual,
    inscricao: Inscricao,
    *,
    data: date,
    presente: bool = True,
    horas: Decimal | None = None,
    justificativa: str | None = None,
    motivo: str | None = None,
) -> TurmaPresenca:
    """Um dia, um inscrito, uma linha. Relancar o mesmo dia corrige a linha.

    Corrigir em vez de acrescentar nao e detalhe de implementacao: com duas
    linhas para o mesmo dia, a frequencia somaria as duas e passaria de 100%
    sem que ninguem tivesse ficado a mais na sala. O `uq_turma_presenca_dia`
    garante isso no banco; aqui a gente evita o erro em vez de esperar por ele.
    """
    turma = inscricao.turma
    retificacao = _exigir_lancamento(s, usuario, inscricao, motivo)
    _exigir_inscricao_lancavel(inscricao)

    if not (turma.data_inicio <= data <= turma.data_fim):
        raise RegraDaTurma(
            f"{data.strftime('%d/%m/%Y')} não é dia de {turma.codigo}, que vai de "
            f"{turma.data_inicio.strftime('%d/%m/%Y')} a "
            f"{turma.data_fim.strftime('%d/%m/%Y')}."
        )

    carga = Decimal(turma.carga_efetiva)
    if not presente:
        # ausencia nao acumula hora — a mesma regra do `ck_turma_presenca_coerente`
        lancadas = Decimal(0)
    elif horas is not None:
        lancadas = horas
    elif turma.data_inicio == turma.data_fim:
        # curso de um dia: o dia E a carga inteira, e nao ha o que escolher
        lancadas = carga
    else:
        raise RegraDaTurma(
            f"{turma.codigo} tem mais de um dia: informe as horas deste dia. "
            "Assumir a carga inteira daria 100% a quem veio um dia só."
        )
    if presente and lancadas <= 0:
        raise RegraDaTurma(
            "Informe as horas do dia: presença de zero hora não é presença, e "
            "deixaria a frequência mentindo para mais."
        )
    if lancadas > carga:
        raise RegraDaTurma(
            f"{numero(lancadas)}h num dia só passa da carga da turma "
            f"({numero(carga)}h)."
        )

    ja = next((p for p in inscricao.presencas if p.data == data), None)
    outras = inscricao.horas_presentes - (
        ja.horas if ja is not None and ja.presente else Decimal(0)
    )
    if outras + lancadas > carga:
        raise RegraDaTurma(
            f"O total lançado ficaria em {numero(outras + lancadas)}h, acima da "
            f"carga da turma ({numero(carga)}h). Confira os dias já lançados."
        )

    anterior = None if ja is None else (ja.presente, ja.horas)
    frequencia_antes = inscricao.frequencia_percentual
    limpa = (justificativa or "").strip() or None
    if ja is None:
        ja = TurmaPresenca(data=data)
        inscricao.presencas.append(ja)
    ja.presente = presente
    ja.horas = lancadas
    ja.justificativa = limpa
    ja.registrado_por = usuario.id
    ja.registrado_em = agora_utc()
    s.flush()

    calculada = recalcular_frequencia(inscricao)
    auditoria.registrar(
        s,
        entidade="inscricao",
        entidade_id=inscricao.id,
        tipo_evento=PRESENCA_LANCADA,
        descricao=(
            f"{turma.codigo} · {inscricao.participante.identificador_publico} · "
            f"{data.strftime('%d/%m/%Y')}: "
            + ("presente" if presente else "ausente")
            + f", {numero(lancadas)}h"
            + (f" (antes: {'presente' if anterior[0] else 'ausente'}, "
               f"{numero(anterior[1])}h)" if anterior is not None else "")
            + f" — frequência {numero(calculada)}%"
            + (f" · {limpa}" if limpa else "")
        ),
        campo="frequencia_percentual",
        # Decimal, e nao `str(Decimal)`: a trilha registra o valor, nao a
        # formatacao dele. (Ate a 1.19.1 isto tambem era questao de integridade —
        # `"50.00"` voltava do banco como float e o digest da cadeia deixava de
        # conferir. A causa foi fechada em `JSONTexto`; a preferencia pelo valor
        # de verdade continua valendo pela fidelidade do registro.)
        valor_anterior=frequencia_antes,
        valor_novo=calculada,
        comentario=retificacao,
        usuario=usuario,
    )
    _ajustar_situacao(s, usuario, inscricao, motivo=retificacao)
    s.flush()
    return ja


def marcar_todos_presentes(
    s: Session, usuario: UsuarioAtual, turma: Turma, *, motivo: str | None = None
) -> list[Inscricao]:
    """Curso de um dia so: todo mundo presente, com a carga efetiva da turma.

    Recusado em turma de mais de um dia, e a recusa e o ponto: numa turma de
    tres dias, "marcar todos presentes" num clique so daria 100% a quem faltou
    dois deles. Frequencia por dia existe justamente para isso.
    """
    # a permissao vem antes de qualquer conferencia de regra, e antes do laco:
    # numa turma de varios dias ou sem ninguem inscrito, `lancar_presenca` nunca
    # chegaria a rodar e quem nao pode avaliar receberia um conselho sobre a
    # turma em vez de "permissao negada"
    usuario.exigir("turma.avaliar")
    if turma.data_inicio != turma.data_fim:
        dias = (turma.data_fim - turma.data_inicio).days + 1
        raise RegraDaTurma(
            f"{turma.codigo} tem {dias} dias: marque dia a dia. Num clique só, "
            "quem faltou um dia sairia com 100% de frequência."
        )
    alcancadas = [
        i
        for i in inscricoes_da_turma(s, turma)
        if i.situacao not in INSCRICAO_FORA_DA_APURACAO
    ]
    if not alcancadas:
        raise RegraDaTurma(f"{turma.codigo} não tem ninguém para marcar presente.")
    for inscricao in alcancadas:
        lancar_presenca(
            s,
            usuario,
            inscricao,
            data=turma.data_inicio,
            presente=True,
            horas=Decimal(turma.carga_efetiva),
            motivo=motivo,
        )
    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento=PRESENCA_EM_LOTE,
        descricao=(
            f"{turma.codigo}: {len(alcancadas)} presença(s) de "
            f"{numero(turma.carga_efetiva)}h em "
            f"{turma.data_inicio.strftime('%d/%m/%Y')}"
        ),
        comentario=(motivo or "").strip() or None,
        usuario=usuario,
    )
    s.flush()
    return alcancadas


def marcar_dia_presente(
    s: Session,
    usuario: UsuarioAtual,
    turma: Turma,
    *,
    data: date,
    horas: Decimal | None = None,
    motivo: str | None = None,
) -> list[Inscricao]:
    """Uma COLUNA da grade: todo mundo presente NAQUELE dia.

    A diferenca para `marcar_todos_presentes` e a diferenca entre um lote
    legitimo e um lote que mente. Aquele e recusado em turma de mais de um dia
    porque num clique so ele daria 100% a quem faltou dois dos tres; este marca
    UM dia, que e exatamente a unidade em que a folha de presenca chega em papel
    — uma folha por dia, assinada por quem esteve. Transcrever a folha do dia e
    depois desmarcar quem faltou e o gesto real de quem opera; abrir trinta
    formularios para lancar a mesma coisa trinta vezes nao e.

    Nao ha regra nova aqui: `lancar_presenca` continua sendo quem confere o dia
    contra o periodo da turma, quem exige as horas em turma de varios dias e quem
    recusa passar da carga. `horas=None` cai na mesma regra de sempre — em curso
    de um dia o dia E a carga inteira, em turma de varios dias o servico pede o
    numero em vez de assumir um.

    **Sobrescreve o dia, inclusive quem ja estava marcado ausente**, e e o que se
    quer: quem lanca a coluna esta com a folha daquele dia na mao, e a folha e a
    autoridade. Cada sobrescrita entra na trilha com o valor de antes, como
    qualquer relancamento.
    """
    usuario.exigir("turma.avaliar")
    if not (turma.data_inicio <= data <= turma.data_fim):
        raise RegraDaTurma(
            f"{data.strftime('%d/%m/%Y')} não é dia de {turma.codigo}, que vai de "
            f"{turma.data_inicio.strftime('%d/%m/%Y')} a "
            f"{turma.data_fim.strftime('%d/%m/%Y')}."
        )
    alcancadas = [
        i
        for i in inscricoes_da_turma(s, turma)
        if i.situacao not in INSCRICAO_FORA_DA_APURACAO
    ]
    if not alcancadas:
        raise RegraDaTurma(f"{turma.codigo} não tem ninguém para marcar presente.")
    for inscricao in alcancadas:
        lancar_presenca(
            s,
            usuario,
            inscricao,
            data=data,
            presente=True,
            horas=horas,
            motivo=motivo,
        )
    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento=PRESENCA_EM_LOTE,
        descricao=(
            f"{turma.codigo}: {len(alcancadas)} presença(s) em "
            f"{data.strftime('%d/%m/%Y')}"
            + (f", {numero(horas)}h" if horas is not None else "")
        ),
        comentario=(motivo or "").strip() or None,
        usuario=usuario,
    )
    s.flush()
    return alcancadas


# ---------------------------------------------------------------------
# Nota
# ---------------------------------------------------------------------
def lancar_nota(
    s: Session,
    usuario: UsuarioAtual,
    inscricao: Inscricao,
    nota: Decimal | None,
    *,
    motivo: str | None = None,
) -> Inscricao:
    """A nota da avaliacao, de 0 a 10. `None` apaga a nota lancada.

    Apagar e um pedido explicito da tela, e nao o efeito de mandar o campo
    vazio: campo vazio que vira valor gravado foi como uma validade de 24 meses
    virou "nao expira" na fatia 1.
    """
    retificacao = _exigir_lancamento(s, usuario, inscricao, motivo)
    _exigir_inscricao_lancavel(inscricao)
    if nota is not None and not (Decimal(0) <= nota <= Decimal(10)):
        raise RegraDaTurma("Nota: use um valor entre 0 e 10.")

    anterior = inscricao.nota_final
    if anterior == nota:
        return inscricao
    inscricao.nota_final = nota
    auditoria.registrar(
        s,
        entidade="inscricao",
        entidade_id=inscricao.id,
        tipo_evento=NOTA_LANCADA,
        descricao=(
            f"{inscricao.turma.codigo} · "
            f"{inscricao.participante.identificador_publico}: "
            f"nota {numero(anterior)} -> {numero(nota)}"
        ),
        campo="nota_final",
        # Decimal por inteiro, pelo mesmo motivo da frequencia acima
        valor_anterior=anterior,
        valor_novo=nota,
        comentario=retificacao,
        usuario=usuario,
    )
    if inscricao.situacao in INSCRICAO_COM_RESULTADO:
        _reapurar(s, usuario, inscricao, motivo=retificacao or "")
    s.flush()
    return inscricao


# ---------------------------------------------------------------------
# Fecho da turma
# ---------------------------------------------------------------------
@dataclass
class Apuracao:
    """O que o fecho da turma produziu, para a mensagem da tela."""

    aprovados: list[Inscricao] = field(default_factory=list)
    reprovados: list[Inscricao] = field(default_factory=list)
    fora: list[Inscricao] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.aprovados) + len(self.reprovados)

    @property
    def resumo(self) -> str:
        if not self.total:
            return "nenhum inscrito a apurar"
        return f"{len(self.aprovados)} aprovado(s), {len(self.reprovados)} reprovado(s)"


def apurar_turma(s: Session, usuario: UsuarioAtual, turma: Turma) -> Apuracao:
    """Calcula a frequencia de cada inscrito e atribui APROVADO/REPROVADO.

    Chamada de dentro de `turma.mudar_situacao` quando o destino e CONCLUIDA:
    concluir passou a ser um ato so. A permissao ja foi exigida la
    (`turma.concluir`) — repetir aqui nao acrescentaria guarda nenhuma e
    esconderia que existe um unico ponto de entrada.

    Turma sem nenhum inscrito conclui normalmente, com apuracao vazia: nao ter
    ninguem e um resultado legitimo (a turma aconteceu e ninguem veio), e
    recusar o fecho deixaria a turma aberta para sempre.
    """
    apuracao = Apuracao()
    for inscricao in inscricoes_da_turma(s, turma):
        if inscricao.situacao in INSCRICAO_FORA_DA_APURACAO:
            apuracao.fora.append(inscricao)
            continue
        recalcular_frequencia(inscricao)
        # o estado intermediario nao e enfeite: e ele que impede APROVADO de
        # aparecer para quem nunca compareceu, porque a maquina F so admite
        # AUSENTE -> REPROVADO
        _normalizar_comparecimento(s, usuario, inscricao)
        resultado = avaliar(turma, inscricao)
        _mover(
            s,
            usuario,
            inscricao,
            resultado.situacao,
            detalhe="; ".join(resultado.motivos)
            if resultado.motivos
            else f"frequência {numero(inscricao.frequencia_percentual)}%",
        )
        alvo = apuracao.aprovados if resultado.aprovado else apuracao.reprovados
        alvo.append(inscricao)

    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento=TURMA_APURADA,
        descricao=f"{turma.codigo}: {apuracao.resumo}",
        usuario=usuario,
    )
    s.flush()
    return apuracao


__all__ = [
    "NOTA_LANCADA",
    "PRESENCA_EM_LOTE",
    "PRESENCA_LANCADA",
    "RESULTADO_RETIFICADO",
    "TURMA_APURADA",
    "Apuracao",
    "Avaliacao",
    "LinhaDaGrade",
    "apurar_turma",
    "avaliar",
    "certificado_ativo",
    "contagem_por_situacao",
    "dias_da_turma",
    "frequencia_de",
    "grade_da_turma",
    "lancar_nota",
    "lancar_presenca",
    "linha_da_grade",
    "marcar_dia_presente",
    "marcar_todos_presentes",
    "numero",
    "para_decimal",
    "recalcular_frequencia",
]
