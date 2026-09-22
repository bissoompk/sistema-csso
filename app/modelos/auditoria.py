"""Anexos, checklist, historico append-only e tabelas de staging da migracao."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.modelos.base import (
    Base,
    DataPura,
    Inet,
    JSONTexto,
    MomentoUTC,
    agora_utc,
)


class Anexo(Base):
    __tablename__ = "anexo"

    id: Mapped[int] = mapped_column(primary_key=True)
    entidade: Mapped[str] = mapped_column(String(30), nullable=False)
    entidade_id: Mapped[int] = mapped_column(Integer, nullable=False)
    nome_arquivo: Mapped[str] = mapped_column(String(255), nullable=False)
    nome_original: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    tamanho_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    categoria: Mapped[str] = mapped_column(String(30), nullable=False, default="OUTRO")
    nivel_acesso: Mapped[str] = mapped_column(String(12), nullable=False, default="PUBLICO")
    numero_documento_sei: Mapped[str | None] = mapped_column(String(10))
    assinado: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    versao: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    origem_migracao: Mapped[str | None] = mapped_column(String(20))
    origem_ref: Mapped[str | None] = mapped_column(String(200))
    enviado_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    enviado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    __table_args__ = (
        # As oito primeiras sao do Processos SEI; as oito seguintes entraram de
        # uma vez para EPI, Certificados e Acidentes. Estender a CHECK no SQLite
        # reconstroi a tabela inteira, e `anexo` tem dados e e referenciada:
        # tres reconstrucoes (uma por modulo) seriam tres vezes o mesmo risco.
        # A lista aqui e a mesma de `anexos.CATEGORIAS` — um teste compara as duas.
        CheckConstraint(
            "categoria IN ('PARECER_ASSINADO','LAUDO','PORTARIA','DESPACHO','FORMULARIO',"
            "'RELATORIO_CAMPO','FOTO','OUTRO',"
            "'MANUAL_EPI','FICHA_EPI',"
            "'RUBRICA_INSTRUTOR','LISTA_PRESENCA','CERTIFICADO',"
            "'CAT_SP','RELATORIO_INVESTIGACAO','EVIDENCIA_ACIDENTE')",
            name="ck_anexo_cat",
        ),
        Index("uq_anexo_dedup", "entidade", "entidade_id", "sha256", unique=True),
        Index("ix_anexo_sha", "sha256"),
    )


# RN-12 - no maximo um PARECER_ASSINADO ativo por parecer
Index(
    "uq_parecer_assinado_ativo",
    Anexo.entidade_id,
    unique=True,
    sqlite_where=(Anexo.entidade == "parecer_tecnico")
    & (Anexo.categoria == "PARECER_ASSINADO")
    & (Anexo.ativo.is_(True)),
    postgresql_where=(Anexo.entidade == "parecer_tecnico")
    & (Anexo.categoria == "PARECER_ASSINADO")
    & (Anexo.ativo.is_(True)),
)


class Checklist(Base):
    __tablename__ = "checklist"

    id: Mapped[int] = mapped_column(primary_key=True)
    processo_id: Mapped[int] = mapped_column(
        ForeignKey("processo.id", ondelete="CASCADE"), nullable=False
    )
    nome: Mapped[str] = mapped_column(String(120), nullable=False)
    ordem: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)

    itens: Mapped[list["ChecklistItem"]] = relationship(
        back_populates="checklist", cascade="all, delete-orphan", lazy="selectin"
    )


class ChecklistItem(Base):
    __tablename__ = "checklist_item"

    id: Mapped[int] = mapped_column(primary_key=True)
    checklist_id: Mapped[int] = mapped_column(
        ForeignKey("checklist.id", ondelete="CASCADE"), nullable=False
    )
    descricao: Mapped[str] = mapped_column(String(255), nullable=False)
    concluido: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    concluido_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    concluido_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    ordem: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)

    checklist: Mapped[Checklist] = relationship(back_populates="itens")


class Pendencia(Base):
    """Tarefa com dono e prazo. Alimenta o sino e a RN-06.

    Diferente do checklist (que e uma lista livre do processo), a pendencia
    nasce de uma regra: agente quimico exige avaliacao quantitativa, laudo
    superado exige reavaliacao, parecer emitido exige inclusao no SEI.
    """

    __tablename__ = "pendencia"

    id: Mapped[int] = mapped_column(primary_key=True)
    tipo: Mapped[str] = mapped_column(String(40), nullable=False)
    descricao: Mapped[str] = mapped_column(Text, nullable=False)
    processo_id: Mapped[int | None] = mapped_column(ForeignKey("processo.id"))
    parecer_id: Mapped[int | None] = mapped_column(ForeignKey("parecer_tecnico.id"))
    laudo_id: Mapped[int | None] = mapped_column(ForeignKey("laudo_tecnico.id"))
    # Ancora generica, o mesmo par de `historico_evento` e `anexo`. As tres FKs
    # acima sao do Processos SEI; CA a vencer, reciclagem de treinamento e prazo
    # do art. 214 nao tem nenhuma delas, e sem ancora a tela mostra a descricao
    # e nao leva a lugar nenhum. Nasce cedo porque depois exigiria backfill em
    # pendencia ja aberta.
    entidade: Mapped[str | None] = mapped_column(String(30))
    entidade_id: Mapped[int | None] = mapped_column(Integer)
    responsavel_id: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    prazo: Mapped[date | None] = mapped_column(DataPura)
    concluida: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    concluida_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    concluida_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    criada_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    # chave de deduplicacao: a mesma regra nao abre duas pendencias iguais
    chave: Mapped[str] = mapped_column(String(120), nullable=False)

    responsavel = relationship("Usuario", foreign_keys=[responsavel_id], lazy="selectin")

    __table_args__ = (
        # meia ancora nao leva a lugar nenhum: ou o par esta completo, ou e nulo
        CheckConstraint(
            "(entidade IS NULL AND entidade_id IS NULL) "
            "OR (entidade IS NOT NULL AND entidade_id IS NOT NULL)",
            name="ck_pendencia_entidade",
        ),
        Index("uq_pendencia_chave", "chave", unique=True),
        Index("ix_pendencia_aberta", "concluida", "prazo"),
        Index("ix_pendencia_entidade", "entidade", "entidade_id"),
    )

    def atrasada(self, hoje: date | None = None) -> bool:
        from datetime import date as _date

        if self.concluida or self.prazo is None:
            return False
        return self.prazo < (hoje or _date.today())


class HistoricoEvento(Base):
    """Append-only: trigger de banco aborta UPDATE e DELETE (CA-16)."""

    __tablename__ = "historico_evento"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    entidade: Mapped[str] = mapped_column(String(30), nullable=False)
    entidade_id: Mapped[int] = mapped_column(Integer, nullable=False)
    processo_id: Mapped[int | None] = mapped_column(ForeignKey("processo.id"))
    tipo_evento: Mapped[str] = mapped_column(String(40), nullable=False)
    descricao: Mapped[str] = mapped_column(Text, nullable=False)
    comentario: Mapped[str | None] = mapped_column(Text)
    campo: Mapped[str | None] = mapped_column(String(60))
    valor_anterior: Mapped[Any | None] = mapped_column(JSONTexto)
    valor_novo: Mapped[Any | None] = mapped_column(JSONTexto)
    usuario_id: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    usuario_nome: Mapped[str] = mapped_column(String(160), nullable=False)
    ocorrido_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    registrado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    origem: Mapped[str] = mapped_column(String(20), nullable=False, default="SISTEMA")
    origem_ref: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(Inet)
    user_agent: Mapped[str | None] = mapped_column(Text)
    # encadeamento anti-adulteracao
    hash_anterior: Mapped[str | None] = mapped_column(String(64))
    hash_atual: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        Index("ix_hist_entidade", "entidade", "entidade_id"),
        Index("ix_hist_processo", "processo_id"),
        Index("ix_hist_ocorrido", "ocorrido_em"),
    )


class ConferenciaCadeia(Base):
    """O resultado guardado de uma conferencia da cadeia INTEIRA (Q-2).

    A conferencia completa refaz um SHA-256 por evento. Medida em ~55 us por
    evento, ela custa 43 ms com 1.292 eventos e 2,7 s com 50 mil — e a `/auditoria`
    a chamava a cada abertura, dentro da requisicao, com o lock de escrita do
    SQLite na mao (RN-03). Projetando, aos ~90 mil eventos uma unica abertura da
    tela passava dos 5 s de `busy_timeout` e derrubava a tela de todo mundo.

    A tela passou a conferir so a janela exibida (`auditoria.janela_integra`), que
    e barata e constante. O passe completo continua existindo — ele e o que
    responde "a trilha inteira ainda fecha?" — mas virou ato deliberado: o botao
    da tela ou a rotina agendada. Como ele deixou de rodar a cada abertura,
    alguem tem de guardar QUANDO rodou pela ultima vez e o que deu; e esta tabela.

    **Sem FK para `historico_evento`.** `ultimo_evento_id` e `primeiro_defeito_id`
    apontam para a trilha, mas por numero e nao por chave estrangeira: a linha
    aqui e o LAUDO sobre aquela tabela, e laudo que o banco recusa gravar porque
    o objeto do laudo mudou nao serve de laudo. A trilha e append-only por
    trigger (`app/banco.py`), entao o alvo nao some — e no dia em que sumisse, e
    justamente esta linha que precisa sobreviver para dizer que sumiu.
    """

    __tablename__ = "conferencia_cadeia"

    id: Mapped[int] = mapped_column(primary_key=True)
    iniciada_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    concluida_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False)
    # o numero que diz quando a conferencia completa deixa de caber num clique:
    # e ele que a tela mostra ao lado da data, e e ele que vira a decisao de
    # passar o passe completo para a madrugada.
    duracao_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    eventos: Mapped[int] = mapped_column(Integer, nullable=False)
    ultimo_evento_id: Mapped[int | None] = mapped_column(BigInteger)
    integra: Mapped[bool] = mapped_column(Boolean, nullable=False)
    primeiro_defeito_id: Mapped[int | None] = mapped_column(BigInteger)
    origem: Mapped[str] = mapped_column(String(10), nullable=False)
    usuario_id: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))

    __table_args__ = (
        CheckConstraint("origem IN ('BOTAO','ROTINA')", name="ck_conferencia_origem"),
        # cadeia rompida sem apontar onde e diagnostico sem endereco; e cadeia
        # integra com defeito apontado e contradicao gravada.
        CheckConstraint(
            "(integra = 1 AND primeiro_defeito_id IS NULL) "
            "OR (integra = 0 AND primeiro_defeito_id IS NOT NULL)",
            name="ck_conferencia_defeito",
        ),
    )


class MigracaoRejeitada(Base):
    __tablename__ = "migracao_rejeitada"

    id: Mapped[int] = mapped_column(primary_key=True)
    origem: Mapped[str] = mapped_column(String(20), nullable=False)
    ref: Mapped[str] = mapped_column(String(200), nullable=False)
    motivo: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[Any] = mapped_column(JSONTexto, nullable=False)
    expurgar_apos: Mapped[date | None] = mapped_column(DataPura)
    criado_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False, default=agora_utc)

    __table_args__ = (Index("ix_rejeitada_origem", "origem", "ref"),)


class StgPlanilhaParecer(Base):
    """As 25 colunas da planilha como texto puro + linha de origem."""

    __tablename__ = "stg_planilha_parecer"

    id: Mapped[int] = mapped_column(primary_key=True)
    arquivo: Mapped[str] = mapped_column(String(255), nullable=False)
    linha_origem: Mapped[int] = mapped_column(Integer, nullable=False)
    col_a_data_solicitacao: Mapped[str | None] = mapped_column(Text)
    col_b_numero_parecer: Mapped[str | None] = mapped_column(Text)
    col_c_nome_servidor: Mapped[str | None] = mapped_column(Text)
    col_d_ano: Mapped[str | None] = mapped_column(Text)
    col_e_data: Mapped[str | None] = mapped_column(Text)
    col_f_laudo_de: Mapped[str | None] = mapped_column(Text)
    col_g_unidade: Mapped[str | None] = mapped_column(Text)
    col_h_posto_trabalho: Mapped[str | None] = mapped_column(Text)
    col_i_uorg: Mapped[str | None] = mapped_column(Text)
    col_j_tipo_laudo: Mapped[str | None] = mapped_column(Text)
    col_k_numero_processo: Mapped[str | None] = mapped_column(Text)
    col_l_matricula: Mapped[str | None] = mapped_column(Text)
    col_m_cargo: Mapped[str | None] = mapped_column(Text)
    col_n_funcao: Mapped[str | None] = mapped_column(Text)
    col_o_laudo_siape: Mapped[str | None] = mapped_column(Text)
    col_p_agente_nocivo: Mapped[str | None] = mapped_column(Text)
    col_q_tipo_risco: Mapped[str | None] = mapped_column(Text)
    col_r_percentual: Mapped[str | None] = mapped_column(Text)
    col_s_portaria: Mapped[str | None] = mapped_column(Text)
    col_t_fundamentacao: Mapped[str | None] = mapped_column(Text)
    col_u_alteracao: Mapped[str | None] = mapped_column(Text)
    col_v_recomendacao: Mapped[str | None] = mapped_column(Text)
    col_w_reavaliacao: Mapped[str | None] = mapped_column(Text)
    col_x_pro_reitor: Mapped[str | None] = mapped_column(Text)
    col_Y_sem_cabecalho: Mapped[str | None] = mapped_column(Text)
    classificacao: Mapped[str | None] = mapped_column(String(12))
    importado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    __table_args__ = (Index("uq_stg_planilha", "arquivo", "linha_origem", unique=True),)


class StgTrelloCartao(Base):
    __tablename__ = "stg_trello_cartao"

    id: Mapped[int] = mapped_column(primary_key=True)
    card_id: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    nome: Mapped[str | None] = mapped_column(Text)
    descricao: Mapped[str | None] = mapped_column(Text)
    lista: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[Any] = mapped_column(JSONTexto, nullable=False)
    parecer_candidato: Mapped[str | None] = mapped_column(String(12))
    laudo_candidato: Mapped[str | None] = mapped_column(String(24))


class StgTrelloAcao(Base):
    __tablename__ = "stg_trello_acao"

    id: Mapped[int] = mapped_column(primary_key=True)
    action_id: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    card_id: Mapped[str | None] = mapped_column(String(40))
    tipo: Mapped[str | None] = mapped_column(String(60))
    data: Mapped[str | None] = mapped_column(String(40))
    autor: Mapped[str | None] = mapped_column(String(160))
    payload: Mapped[Any] = mapped_column(JSONTexto, nullable=False)


__all__ = [
    "Anexo",
    "Checklist",
    "ChecklistItem",
    "ConferenciaCadeia",
    "HistoricoEvento",
    "MigracaoRejeitada",
    "Pendencia",
    "StgPlanilhaParecer",
    "StgTrelloAcao",
    "StgTrelloCartao",
]
