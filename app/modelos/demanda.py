"""Demanda — o pedido que chegou por e-mail ou no balcao e ainda nao e processo.

**Por que uma tabela nova, e nao um campo em `processo` ou em `pendencia`.** O
caminho esta fechado dos dois lados, e nenhum dos dois fechos e acidente:

- `processo.nup` e `nullable=False`, `unique=True` e tem CHECK de formato
  (`23086.XXXXXX/AAAA-DD`). Um `processo` **e** um processo SEI, e os dezenove
  estados da maquina A sao os do adicional ocupacional. Demanda ali entraria sem
  NUP (impossivel) ou com NUP inventado (pior), e ainda poluiria kanban, SLA e
  toda contagem do painel com trabalho que nao e processo.
- `pendencia` nasce **de regra**, ancorada em algo que ja existe, e e TAREFA —
  descricao, dono, prazo, feito/nao feito. A demanda que chegou por e-mail nao
  tem ancora nenhuma, e precisa guardar coisas que tarefa nao guarda: quem
  pediu, por onde chegou, o que foi pedido, o que se respondeu e como terminou.

A demanda mora na **base compartilhada**, ao lado de Pendencias, e nao dentro de
Processos SEI: ela e transversal por natureza — pode ser sobre adicional, EPI,
treinamento ou sobre nada disso. Poe-la dentro de um modulo obrigaria o modulo
seguinte a criar a sua propria.

**O campo mais perigoso do sistema inteiro esta aqui.** `descricao`,
`pedido` do encaminhamento e `desfecho_relato` sao texto livre escrito com
pressa, sobre uma pessoa, por quem acabou de ouvi-la no balcao — e e onde
alguem escreve "servidora esta gravida e pediu remocao" ou "tem laudo de
depressao". A protecao e tecnica e fica no servico (`servicos/demandas.py`, RN-21
por `textos.exigir_texto_limpo`), nao num aviso no rodape do formulario; a
recusa preserva o que foi digitado, porque recusa que apaga o texto ensina a
pessoa a escrever menos, e nao a escrever melhor.

**Nao ha CPF, CID, diagnostico, atestado nem gestacao em coluna nenhuma** — a
mesma negativa do modulo de EPI, e ela vale aqui com mais forca, porque aqui o
texto e o registro.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.modelos.base import Base, DataPura, MomentoUTC, agora_utc
from app.modelos.estados import (
    CANAIS_DEMANDA,
    DESFECHOS_DEMANDA,
    ESTADOS_DEMANDA,
)


def _lista(valores: tuple[str, ...]) -> str:
    return ",".join(f"'{valor}'" for valor in valores)


# As tres CHECK de vocabulario saem das MESMAS tuplas que a maquina H usa para
# decidir transicao e que o formulario usa para montar o seletor. Duas listas do
# mesmo conjunto divergem no dia em que alguem acrescenta valor a uma so, e o
# resultado seria a tela oferecer o que o banco recusa — na cara de quem opera.
_LISTA_ESTADOS = _lista(ESTADOS_DEMANDA)
_LISTA_CANAIS = _lista(CANAIS_DEMANDA)
_LISTA_DESFECHOS = _lista(DESFECHOS_DEMANDA)


class Demanda(Base):
    """O registro do que chegou. Um por pedido, com dono e com desfecho."""

    __tablename__ = "demanda"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Padrao: hoje. E a primeira das tres economias de digitacao que fazem a
    # entrada caber em trinta segundos (as outras duas sao o responsavel e o
    # canal). Editavel porque o e-mail de sexta as vezes so e registrado na
    # segunda, e mentir a data de chegada estragaria a unica medida de atraso
    # que esta tabela produz.
    data_chegada: Mapped[date] = mapped_column(DataPura, nullable=False)
    canal: Mapped[str] = mapped_column(String(12), nullable=False)

    # --- quem pediu: o texto livre E o vinculo, e os dois de proposito ---
    # O texto e obrigatorio porque quem demanda muitas vezes NAO esta no
    # cadastro: e a chefia de uma unidade, e o pessoal de outro campus, e alguem
    # de fora. Exigir `servidor_id` obrigaria a cadastrar a pessoa para poder
    # anotar o pedido dela — que e exatamente o atrito que faz a demanda voltar
    # para o post-it.
    #
    # O vinculo e opcional e vale ouro quando existe: e ele que liga a demanda a
    # ficha do servidor e a unidade, e e por ele que a RN-19 sabe o que suprimir
    # na tela. Quando ele existe, o nome na tela sai por `identificar(...)`, e
    # nunca deste campo de texto.
    solicitante_nome: Mapped[str] = mapped_column(String(160), nullable=False)
    solicitante_servidor_id: Mapped[int | None] = mapped_column(
        ForeignKey("servidor.id")
    )
    solicitante_unidade_uorg_id: Mapped[int | None] = mapped_column(
        ForeignKey("unidade_uorg.id")
    )

    # Uma linha, e e o que a lista mostra. Separado da `descricao` porque sao
    # coisas diferentes: o assunto e o que se le correndo os olhos pela fila, a
    # descricao e o que se le quando a fila parou naquela linha.
    assunto: Mapped[str] = mapped_column(String(160), nullable=False)
    descricao: Mapped[str | None] = mapped_column(Text)

    # Padrao: quem cadastrou. Anulavel porque a demanda pode chegar sem dono
    # definido e ser distribuida depois — e tarefa sem dono aparece assim na
    # tela, em vez de aparecer com um dono falso.
    responsavel_id: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))

    # Opcional, e COBRA. Com prazo, a demanda abre pendencia e entra no sino
    # junto das outras tarefas do setor, ficando vermelha quando atrasa; sem
    # prazo, ela fica na lista de abertas e nao incomoda ninguem. E essa a
    # decisao do dono: o prazo e o que impede a demanda de sumir.
    prazo: Mapped[date | None] = mapped_column(DataPura)

    estado: Mapped[str] = mapped_column(String(14), nullable=False, default="ABERTA")

    # --- o desfecho: obrigatorio no fecho, e cada tipo cobra a sua prova ---
    desfecho: Mapped[str | None] = mapped_column(String(16))
    # O que foi feito (RESOLVIDA) ou por que nao se fez nada (SEM_PROVIDENCIA).
    desfecho_relato: Mapped[str | None] = mapped_column(Text)
    # **FK de verdade para `processo.id`**, e nao um NUP em texto. E a diferenca
    # entre rastreabilidade e anotacao: com a FK, "esta demanda gerou aquele
    # processo" e um link que abre, o banco garante que o processo existe, e a
    # ficha do processo pode um dia listar as demandas que o originaram. Com um
    # NUP digitado seriam duas fontes para o mesmo numero — e a segunda sem o
    # `unique` e sem o CHECK de formato que a primeira tem.
    desfecho_processo_id: Mapped[int | None] = mapped_column(ForeignKey("processo.id"))
    # Para qual setor foi, quando ENCAMINHADA. Texto livre porque o destino
    # muitas vezes esta fora do cadastro de unidades (procuradoria, SIASS,
    # empresa contratada), e um seletor que nao contem o destino real produz
    # encaminhamento para "OUTRO".
    desfecho_setor: Mapped[str | None] = mapped_column(String(160))
    desfecho_data: Mapped[date | None] = mapped_column(DataPura)

    encerrada_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    encerrada_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))

    criada_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    criada_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))

    responsavel = relationship(
        "Usuario", foreign_keys=[responsavel_id], lazy="selectin"
    )
    servidor = relationship("Servidor", lazy="selectin")
    unidade = relationship("UnidadeUorg", lazy="selectin")
    processo = relationship("Processo", lazy="selectin")
    encaminhamentos: Mapped[list["DemandaEncaminhamento"]] = relationship(
        back_populates="demanda",
        lazy="selectin",
        order_by="DemandaEncaminhamento.id",
    )

    __table_args__ = (
        CheckConstraint(f"canal IN ({_LISTA_CANAIS})", name="ck_demanda_canal"),
        CheckConstraint(f"estado IN ({_LISTA_ESTADOS})", name="ck_demanda_estado"),
        CheckConstraint(
            f"desfecho IS NULL OR desfecho IN ({_LISTA_DESFECHOS})",
            name="ck_demanda_desfecho",
        ),
        # O par que carrega a decisao do dono: **encerrar exige dizer como**.
        # Nos dois sentidos — demanda aberta com desfecho gravado seria um fecho
        # que ninguem completou, e e tao errado quanto o contrario.
        CheckConstraint(
            "(estado <> 'ENCERRADA' AND desfecho IS NULL) "
            "OR (estado = 'ENCERRADA' AND desfecho IS NOT NULL)",
            name="ck_demanda_encerrada_tem_desfecho",
        ),
        # Cada desfecho cobra o seu campo, e proibe os dos outros. Sem a segunda
        # metade, uma demanda RESOLVIDA poderia carregar um `desfecho_setor`
        # sobrando de um encaminhamento que nao aconteceu — e a tela leria o
        # campo e afirmaria uma coisa que nao houve.
        CheckConstraint(
            "(desfecho IS NULL"
            " AND desfecho_relato IS NULL AND desfecho_processo_id IS NULL"
            " AND desfecho_setor IS NULL AND desfecho_data IS NULL)"
            " OR ("
            "     (desfecho <> 'VIROU_PROCESSO' OR desfecho_processo_id IS NOT NULL)"
            " AND (desfecho =  'VIROU_PROCESSO' OR desfecho_processo_id IS NULL)"
            " AND (desfecho <> 'ENCAMINHADA'"
            "      OR (desfecho_setor IS NOT NULL AND desfecho_data IS NOT NULL))"
            " AND (desfecho =  'ENCAMINHADA' OR desfecho_setor IS NULL)"
            " AND (desfecho NOT IN ('RESOLVIDA','SEM_PROVIDENCIA')"
            "      OR desfecho_relato IS NOT NULL))",
            name="ck_demanda_desfecho_campos",
        ),
        # A consulta da tela: as abertas, por prazo. E a mesma forma do
        # `ix_pendencia_aberta`, e pelo mesmo motivo — e a pergunta que a lista
        # faz a cada abertura.
        Index("ix_demanda_estado", "estado", "prazo"),
        Index("ix_demanda_responsavel", "responsavel_id"),
        # "o que ha em aberto sobre esta pessoa?" — a pergunta que a ficha do
        # servidor vai fazer, e que sem indice varre a tabela.
        Index("ix_demanda_servidor", "solicitante_servidor_id"),
    )

    def atrasada(self, hoje: date | None = None) -> bool:
        """Vermelho na tela. A regra e a mesma de `Pendencia.atrasada`, e e de
        propósito: a demanda com prazo aparece no MESMO sino, e duas contas de
        atraso divergentes fariam a fila e a lista discordarem sobre a mesma
        linha."""
        from datetime import date as _date

        if self.estado == "ENCERRADA" or self.prazo is None:
            return False
        return self.prazo < (hoje or _date.today())


class DemandaEncaminhamento(Base):
    """O que foi pedido, a quem, e quando — append-only (RN-31).

    E o historico do trabalho: "pedi o parecer a engenharia em 12/03", "cobrei a
    PROGEP em 02/04". Nada se apaga e nada se edita, e a trava e de banco
    (`app/banco.py`, `TRIGGERS_DEMANDA`), como a de `historico_evento` e a da
    ficha de EPI. Corrigir e escrever a linha seguinte dizendo o que mudou — o
    que se perderia editando e justamente a informacao de que houve duas
    cobrancas, que e a que sustenta a proxima conversa sobre o caso.
    """

    __tablename__ = "demanda_encaminhamento"

    id: Mapped[int] = mapped_column(primary_key=True)
    demanda_id: Mapped[int] = mapped_column(
        ForeignKey("demanda.id", ondelete="CASCADE"), nullable=False
    )
    data_encaminhamento: Mapped[date] = mapped_column(DataPura, nullable=False)
    # Texto livre pelo mesmo motivo de `desfecho_setor`: metade dos destinos
    # esta fora do cadastro de unidades, e um seletor incompleto produz
    # encaminhamento para "OUTRO", que nao encaminha ninguem para lugar nenhum.
    para_quem: Mapped[str] = mapped_column(String(160), nullable=False)
    # Obrigatorio. Encaminhamento sem o que foi pedido e um carimbo de data: seis
    # meses depois ninguem sabe o que se esperava de volta, e a cobranca seguinte
    # comeca do zero.
    pedido: Mapped[str] = mapped_column(Text, nullable=False)
    registrado_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    registrado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    demanda: Mapped[Demanda] = relationship(back_populates="encaminhamentos")
    autor = relationship("Usuario", foreign_keys=[registrado_por], lazy="selectin")

    __table_args__ = (
        Index("ix_demanda_encaminhamento", "demanda_id"),
    )


__all__ = ["Demanda", "DemandaEncaminhamento"]
