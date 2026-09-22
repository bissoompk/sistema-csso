"""Processo, laudo tecnico, parecer tecnico, exposicao e vigencia do direito."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.modelos.base import (
    Base,
    DataPura,
    JSONTexto,
    MomentoUTC,
    agora_utc,
    check_regex,
)
from app.modelos.estados import ESTADOS_PROCESSO

PADRAO_NUP = r"23086\.\d{6}/\d{4}-\d{2}"
PADRAO_LAUDO = r"\d{5}-\d{3}\.\d{3}/\d{4}"
PADRAO_PARECER = r"\d+/\d{4}"

_lista_estados = ",".join(f"'{e}'" for e in ESTADOS_PROCESSO)


class Processo(Base):
    __tablename__ = "processo"

    id: Mapped[int] = mapped_column(primary_key=True)
    nup: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    tipo_processo_id: Mapped[int] = mapped_column(
        ForeignKey("tipo_processo.id"), nullable=False
    )
    etapa_id: Mapped[int] = mapped_column(ForeignKey("fluxo_etapa.id"), nullable=False)
    estado_tecnico: Mapped[str] = mapped_column(
        String(32), nullable=False, default="RECEBIDO"
    )
    estado_anterior: Mapped[str | None] = mapped_column(String(32))
    servidor_id: Mapped[int | None] = mapped_column(ForeignKey("servidor.id"))
    unidade_uorg_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    responsavel_id: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    ano_referencia: Mapped[int | None] = mapped_column(Integer)
    data_solicitacao_sest: Mapped[date | None] = mapped_column(DataPura)
    data_autuacao: Mapped[date | None] = mapped_column(DataPura)
    prazo: Mapped[date | None] = mapped_column(DataPura)
    data_conclusao: Mapped[date | None] = mapped_column(DataPura)
    situacao: Mapped[str] = mapped_column(String(20), nullable=False, default="EM_ANDAMENTO")
    nivel_acesso: Mapped[str] = mapped_column(String(12), nullable=False, default="PUBLICO")
    acompanhamento_especial: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    pronto_para_emissao: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    origem_repositorio: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    url_permanente: Mapped[str | None] = mapped_column(Text)
    observacoes: Mapped[str | None] = mapped_column(Text)
    nup_dv_dispensado: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    versao: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    origem_migracao: Mapped[str | None] = mapped_column(String(20))
    origem_ref: Mapped[str | None] = mapped_column(String(64))
    entrou_na_etapa_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    criado_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False, default=agora_utc)
    atualizado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc, onupdate=agora_utc
    )

    tipo_processo = relationship("TipoProcesso", lazy="selectin")
    etapa = relationship("FluxoEtapa", lazy="selectin")
    servidor = relationship("Servidor", lazy="selectin")
    unidade = relationship("UnidadeUorg", lazy="selectin")
    responsavel = relationship("Usuario", lazy="selectin")
    pareceres: Mapped[list["ParecerTecnico"]] = relationship(
        back_populates="processo", foreign_keys="ParecerTecnico.processo_id"
    )

    __table_args__ = (
        check_regex("ck_nup_fmt", "nup", PADRAO_NUP),
        CheckConstraint(
            "nivel_acesso IN ('PUBLICO','RESTRITO','SIGILOSO')", name="ck_acesso"
        ),
        CheckConstraint(
            "(situacao = 'CONCLUIDO') = (data_conclusao IS NOT NULL)", name="ck_conclusao"
        ),
        CheckConstraint(f"estado_tecnico IN ({_lista_estados})", name="ck_estado_tecnico"),
        Index("ix_processo_estado", "estado_tecnico"),
        Index("ix_processo_etapa", "etapa_id"),
        Index("ix_processo_servidor", "servidor_id"),
    )


# indice unico parcial declarado a parte (sintaxe WHERE)
Index(
    "uq_processo_origem",
    Processo.origem_migracao,
    Processo.origem_ref,
    unique=True,
    sqlite_where=Processo.origem_ref.isnot(None),
    postgresql_where=Processo.origem_ref.isnot(None),
)


class LaudoTecnico(Base):
    """SEM coluna data_validade. Nunca crie. (IN 15/2022, art. 10, SS3)"""

    __tablename__ = "laudo_tecnico"

    id: Mapped[int] = mapped_column(primary_key=True)
    numero_siape: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    ano: Mapped[int] = mapped_column(Integer, nullable=False)
    tipo_adicional_id: Mapped[int] = mapped_column(
        ForeignKey("tipo_adicional.id"), nullable=False
    )
    coletivo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    unidade_uorg_id: Mapped[int] = mapped_column(
        ForeignKey("unidade_uorg.id"), nullable=False
    )
    data_emissao: Mapped[date | None] = mapped_column(DataPura)
    data_avaliacao: Mapped[date | None] = mapped_column(DataPura)
    data_ultima_conferencia: Mapped[date | None] = mapped_column(DataPura)
    motivo_ultima_conferencia: Mapped[str | None] = mapped_column(Text)
    subscritor_id: Mapped[int | None] = mapped_column(
        ForeignKey("profissional_habilitado.id")
    )
    processo_id: Mapped[int | None] = mapped_column(ForeignKey("processo.id"))
    numero_documento_sei: Mapped[str | None] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="VIGENTE")
    substituido_por_id: Mapped[int | None] = mapped_column(ForeignKey("laudo_tecnico.id"))
    observacoes: Mapped[str | None] = mapped_column(Text)
    criado_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False, default=agora_utc)

    tipo_adicional = relationship("TipoAdicional", lazy="selectin")
    unidade = relationship("UnidadeUorg", lazy="selectin")
    subscritor = relationship("ProfissionalHabilitado", lazy="selectin")
    postos: Mapped[list["LaudoPosto"]] = relationship(
        back_populates="laudo", cascade="all, delete-orphan"
    )

    __table_args__ = (
        check_regex("ck_laudo_fmt", "numero_siape", PADRAO_LAUDO),
        CheckConstraint(
            "ano = CAST(substr(numero_siape,15,4) AS integer)", name="ck_laudo_ano"
        ),
        CheckConstraint("status IN ('VIGENTE','SUPERADO')", name="ck_laudo_status"),
    )


class LaudoPosto(Base):
    __tablename__ = "laudo_posto"

    laudo_id: Mapped[int] = mapped_column(
        ForeignKey("laudo_tecnico.id", ondelete="CASCADE"), primary_key=True
    )
    posto_trabalho_id: Mapped[int] = mapped_column(
        ForeignKey("posto_trabalho.id"), primary_key=True
    )

    laudo: Mapped[LaudoTecnico] = relationship(back_populates="postos")
    posto = relationship("PostoTrabalho", lazy="selectin")


class ParecerSequencia(Base):
    """RN-03 - sequencia por ano. Nunca MAX(numero)+1."""

    __tablename__ = "parecer_sequencia"

    ano: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    ultimo_numero: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ParecerTecnico(Base):
    __tablename__ = "parecer_tecnico"

    id: Mapped[int] = mapped_column(primary_key=True)
    numero: Mapped[int] = mapped_column(Integer, nullable=False)
    ano: Mapped[int] = mapped_column(Integer, nullable=False)
    data_emissao: Mapped[date | None] = mapped_column(DataPura)
    situacao: Mapped[str] = mapped_column(String(15), nullable=False, default="RASCUNHO")

    processo_id: Mapped[int | None] = mapped_column(ForeignKey("processo.id"))
    servidor_id: Mapped[int | None] = mapped_column(ForeignKey("servidor.id"))
    laudo_id: Mapped[int | None] = mapped_column(ForeignKey("laudo_tecnico.id"))
    tipo_adicional_id: Mapped[int | None] = mapped_column(ForeignKey("tipo_adicional.id"))
    tipo_movimento_id: Mapped[int | None] = mapped_column(ForeignKey("tipo_movimento.id"))
    unidade_uorg_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    # UORG e campo proprio no documento e pode divergir da Unidade
    uorg_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    portaria_id: Mapped[int | None] = mapped_column(ForeignKey("portaria_localizacao.id"))
    destinatario_id: Mapped[int | None] = mapped_column(
        ForeignKey("autoridade_destinataria.id")
    )
    signatario_id: Mapped[int | None] = mapped_column(
        ForeignKey("profissional_habilitado.id")
    )
    setor_emissor_id: Mapped[int | None] = mapped_column(ForeignKey("setor_emissor.id"))
    campus_id: Mapped[int | None] = mapped_column(ForeignKey("campus.id"))
    parecer_anterior_id: Mapped[int | None] = mapped_column(ForeignKey("parecer_tecnico.id"))

    cargo_snapshot: Mapped[str | None] = mapped_column(String(120))
    funcao_snapshot: Mapped[str | None] = mapped_column(String(120))
    sigla_emissora_snapshot: Mapped[str | None] = mapped_column(String(60))
    nome_emissor_snapshot: Mapped[str | None] = mapped_column(String(200))
    endereco_emissor_snapshot: Mapped[str | None] = mapped_column(Text)
    telefone_emissor_snapshot: Mapped[str | None] = mapped_column(String(60))

    tipo_marco_id: Mapped[int | None] = mapped_column(ForeignKey("tipo_marco_inicial.id"))
    data_marco_inicial: Mapped[date | None] = mapped_column(DataPura)
    justificativa_marco: Mapped[str | None] = mapped_column(Text)

    texto_recomendacao: Mapped[str | None] = mapped_column(Text)
    texto_alteracao: Mapped[str | None] = mapped_column(Text)
    texto_reavaliacao: Mapped[str | None] = mapped_column(Text)
    texto_rodape: Mapped[str | None] = mapped_column(Text)
    texto_recomendacao_literal: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    modelo_arquivo: Mapped[str | None] = mapped_column(String(120))
    modelo_sha256: Mapped[str | None] = mapped_column(String(64))
    hash_conteudo: Mapped[str | None] = mapped_column(String(64))
    # RN-15 levada às últimas consequências: TODO o conteúdo renderizado é
    # congelado na emissão. Sem isto, editar um catálogo (nome de agente, texto
    # de fundamentação, nome de unidade) reescreveria o parecer já emitido na
    # próxima reimpressão — o documento mudaria sem ninguém ter assinado nada.
    contexto_congelado: Mapped[dict | None] = mapped_column(JSONTexto)

    horas_semanais_fonte: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    portaria_designacao_dirigente_id: Mapped[int | None] = mapped_column(Integer)
    area_radiologica: Mapped[str | None] = mapped_column(String(16))

    arquivo_docx_id: Mapped[int | None] = mapped_column(Integer)
    arquivo_pdf_id: Mapped[int | None] = mapped_column(Integer)
    numero_documento_sei: Mapped[str | None] = mapped_column(String(10))
    motivo_anulacao: Mapped[str | None] = mapped_column(Text)

    origem_migracao: Mapped[str | None] = mapped_column(String(20))
    origem_ref: Mapped[str | None] = mapped_column(String(64))
    ano_inferido: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    versao: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    criado_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    criado_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False, default=agora_utc)
    emitido_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    emitido_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    assinado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)

    processo: Mapped[Processo | None] = relationship(
        back_populates="pareceres", foreign_keys=[processo_id], lazy="selectin"
    )
    servidor = relationship("Servidor", lazy="selectin")
    laudo = relationship("LaudoTecnico", lazy="selectin")
    tipo_adicional = relationship("TipoAdicional", lazy="selectin")
    tipo_movimento = relationship("TipoMovimento", lazy="selectin")
    unidade = relationship(
        "UnidadeUorg", lazy="selectin", foreign_keys=[unidade_uorg_id]
    )
    uorg = relationship("UnidadeUorg", lazy="selectin", foreign_keys=[uorg_id])
    portaria = relationship("PortariaLocalizacao", lazy="selectin")
    destinatario = relationship("AutoridadeDestinataria", lazy="selectin")
    signatario = relationship("ProfissionalHabilitado", lazy="selectin")
    setor_emissor = relationship("SetorEmissor", lazy="selectin")
    tipo_marco = relationship("TipoMarcoInicial", lazy="selectin")
    postos: Mapped[list["ParecerPosto"]] = relationship(
        back_populates="parecer", cascade="all, delete-orphan", lazy="selectin"
    )
    exposicoes: Mapped[list["Exposicao"]] = relationship(
        back_populates="parecer", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (
        UniqueConstraint("numero", "ano", name="uq_parecer"),
        CheckConstraint(
            "situacao IN ('RESERVADO','RASCUNHO','EM_REVISAO','EMITIDO','ASSINADO','ANULADO')",
            name="ck_situacao",
        ),
        CheckConstraint(
            "data_emissao IS NULL OR CAST(strftime('%Y', data_emissao) AS integer) = ano",
            name="ck_data_ano",
        ),
        CheckConstraint(
            "area_radiologica IS NULL OR area_radiologica IN ('CONTROLADA','SUPERVISIONADA')",
            name="ck_area",
        ),
        CheckConstraint(
            "situacao NOT IN ('EMITIDO','ASSINADO') OR ("
            "servidor_id IS NOT NULL AND laudo_id IS NOT NULL AND data_emissao IS NOT NULL "
            "AND signatario_id IS NOT NULL AND destinatario_id IS NOT NULL "
            "AND portaria_id IS NOT NULL AND processo_id IS NOT NULL "
            "AND tipo_adicional_id IS NOT NULL AND tipo_movimento_id IS NOT NULL "
            "AND unidade_uorg_id IS NOT NULL AND texto_recomendacao IS NOT NULL "
            "AND tipo_marco_id IS NOT NULL AND data_marco_inicial IS NOT NULL)",
            name="ck_completo",
        ),
        CheckConstraint(
            "situacao <> 'ANULADO' OR motivo_anulacao IS NOT NULL", name="ck_anulado"
        ),
        Index("ix_parecer_ano", "ano"),
        Index("ix_parecer_processo", "processo_id"),
    )

    @property
    def rotulo(self) -> str:
        return f"{self.numero}/{self.ano}"


class ParecerPosto(Base):
    __tablename__ = "parecer_posto"

    parecer_id: Mapped[int] = mapped_column(
        ForeignKey("parecer_tecnico.id", ondelete="CASCADE"), primary_key=True
    )
    posto_trabalho_id: Mapped[int] = mapped_column(
        ForeignKey("posto_trabalho.id"), primary_key=True
    )
    ordem: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)

    parecer: Mapped[ParecerTecnico] = relationship(back_populates="postos")
    posto = relationship("PostoTrabalho", lazy="selectin")


class Exposicao(Base):
    __tablename__ = "exposicao"

    id: Mapped[int] = mapped_column(primary_key=True)
    parecer_id: Mapped[int] = mapped_column(
        ForeignKey("parecer_tecnico.id", ondelete="CASCADE"), nullable=False
    )
    agente_nocivo_id: Mapped[int] = mapped_column(
        ForeignKey("agente_nocivo.id"), nullable=False
    )
    percentual_id: Mapped[int] = mapped_column(
        ForeignKey("percentual_aplicavel.id"), nullable=False
    )
    fundamentacao_id: Mapped[int] = mapped_column(
        ForeignKey("fundamentacao_legal.id"), nullable=False
    )
    posto_trabalho_id: Mapped[int | None] = mapped_column(ForeignKey("posto_trabalho.id"))
    principal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tempo_exposicao: Mapped[str | None] = mapped_column(String(60))
    horas_exposicao_mensais: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    jornada_mensal_horas: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    percentual_jornada: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    classificacao_exposicao: Mapped[str | None] = mapped_column(String(16))
    # De onde veio a classificacao: CALCULADA a partir das horas, ou INFORMADA
    # pelo tecnico quando nao ha medicao de jornada. Guardar a origem e o que
    # permite auditar depois se a habitualidade do art. 9o foi medida ou julgada.
    classificacao_origem: Mapped[str] = mapped_column(
        String(10), nullable=False, default="CALCULADA"
    )
    excecao_art9_par_unico: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    justificativa_art9: Mapped[str | None] = mapped_column(Text)
    intensidade: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    unidade_medida: Mapped[str | None] = mapped_column(String(20))
    limite_tolerancia: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    metodologia: Mapped[str | None] = mapped_column(String(120))
    data_avaliacao: Mapped[date | None] = mapped_column(DataPura)

    # §7 do desenho de EPI. Tres colunas e NENHUMA FK para tabela de EPI: o
    # desacoplamento e deliberado. O que o modulo de EPI publica e uma consulta
    # de leitura (`epi_ficha.entregas_ate`); a DECISAO mora aqui, no parecer, e
    # a prova de quais fichas a sustentaram vai para o `contexto_congelado`. Uma
    # FK faria o esquema do parecer depender do esquema do almoxarifado, e
    # apagar um lote passaria a ter opiniao sobre um documento assinado.
    epi_neutraliza: Mapped[str] = mapped_column(
        String(20), nullable=False, default="NAO_AVALIADO"
    )
    justificativa_epi: Mapped[str | None] = mapped_column(Text)
    epi_avaliado_em: Mapped[date | None] = mapped_column(DataPura)

    parecer: Mapped[ParecerTecnico] = relationship(back_populates="exposicoes")
    agente_nocivo = relationship("AgenteNocivo", lazy="selectin")
    percentual = relationship("PercentualAplicavel", lazy="selectin")
    fundamentacao = relationship("FundamentacaoLegal", lazy="selectin")

    __table_args__ = (
        UniqueConstraint("parecer_id", "agente_nocivo_id", name="uq_exposicao"),
        CheckConstraint(
            "classificacao_exposicao IS NULL OR classificacao_exposicao IN "
            "('EVENTUAL','HABITUAL','PERMANENTE')",
            name="ck_exposicao",
        ),
        CheckConstraint(
            "excecao_art9_par_unico = 0 OR justificativa_art9 IS NOT NULL",
            name="ck_excecao",
        ),
        CheckConstraint(
            "classificacao_origem IN ('CALCULADA','INFORMADA')", name="ck_class_origem"
        ),
        CheckConstraint(
            "epi_neutraliza IN ('NAO_AVALIADO','NAO_NEUTRALIZA','NEUTRALIZA_PARCIAL',"
            "'NEUTRALIZA')",
            name="ck_exposicao_epi",
        ),
        # Alegar neutralizacao e reduzir ou cessar o direito de alguem. O banco
        # cobra o porque por escrito, pelo mesmo motivo do `ck_excecao` logo
        # acima: decisao que corta pagamento e nao explica nao e decisao tecnica,
        # e a fiscalizacao pergunta pelo fundamento, nao pelo rotulo.
        CheckConstraint(
            "epi_neutraliza IN ('NAO_AVALIADO','NAO_NEUTRALIZA') "
            "OR justificativa_epi IS NOT NULL",
            name="ck_exposicao_epi_justificada",
        ),
    )


Index(
    "uq_exposicao_principal",
    Exposicao.parecer_id,
    unique=True,
    sqlite_where=Exposicao.principal.is_(True),
    postgresql_where=Exposicao.principal.is_(True),
)


class AdicionalVigencia(Base):
    """Maquina B - o direito concedido."""

    __tablename__ = "adicional_vigencia"

    id: Mapped[int] = mapped_column(primary_key=True)
    servidor_id: Mapped[int] = mapped_column(ForeignKey("servidor.id"), nullable=False)
    parecer_id: Mapped[int] = mapped_column(
        ForeignKey("parecer_tecnico.id"), nullable=False
    )
    tipo_adicional_id: Mapped[int] = mapped_column(
        ForeignKey("tipo_adicional.id"), nullable=False
    )
    percentual_id: Mapped[int] = mapped_column(
        ForeignKey("percentual_aplicavel.id"), nullable=False
    )
    estado: Mapped[str] = mapped_column(String(16), nullable=False, default="PROPOSTO")
    portaria_concessao: Mapped[str | None] = mapped_column(String(120))
    data_portaria_concessao: Mapped[date | None] = mapped_column(DataPura)
    data_inicio: Mapped[date | None] = mapped_column(DataPura)
    data_fim: Mapped[date | None] = mapped_column(DataPura)
    motivo_suspensao: Mapped[str | None] = mapped_column(String(30))
    base_legal_suspensao: Mapped[str | None] = mapped_column(String(120))
    registro_opcao_anexo_id: Mapped[int | None] = mapped_column(Integer)

    servidor = relationship("Servidor", lazy="selectin")
    parecer = relationship("ParecerTecnico", lazy="selectin")
    tipo_adicional = relationship("TipoAdicional", lazy="selectin")
    percentual = relationship("PercentualAplicavel", lazy="selectin")

    __table_args__ = (
        CheckConstraint(
            "estado IN ('PROPOSTO','VIGENTE','SUSPENSO','EM_REAVALIACAO','ALTERADO','CESSADO')",
            name="ck_estado",
        ),
        CheckConstraint(
            "motivo_suspensao IS NULL OR motivo_suspensao IN "
            "('CESSACAO_RISCO','AFASTAMENTO_DO_LOCAL','AFASTAMENTO_LEGAL',"
            "'DECISAO_ADMINISTRATIVA')",
            name="ck_motivo_susp",
        ),
    )


Index(
    "uq_adicional_vigente",
    AdicionalVigencia.servidor_id,
    unique=True,
    sqlite_where=AdicionalVigencia.estado == "VIGENTE",
    postgresql_where=AdicionalVigencia.estado == "VIGENTE",
)


__all__ = [
    "AdicionalVigencia",
    "Exposicao",
    "LaudoPosto",
    "LaudoTecnico",
    "ParecerPosto",
    "ParecerSequencia",
    "ParecerTecnico",
    "Processo",
    "PADRAO_LAUDO",
    "PADRAO_NUP",
    "PADRAO_PARECER",
]
