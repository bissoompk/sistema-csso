"""Campus, UORG, postos de trabalho, cargos, servidores e portarias."""

from __future__ import annotations

from datetime import date

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.modelos.base import Base, DataPura, check_regex

PADRAO_SIAPE = r"\d{7}"


class Campus(Base):
    __tablename__ = "campus"

    id: Mapped[int] = mapped_column(primary_key=True)
    sigla: Mapped[str] = mapped_column(String(12), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(120), nullable=False)
    cidade: Mapped[str] = mapped_column(String(80), nullable=False)
    uf: Mapped[str] = mapped_column(String(2), nullable=False, default="MG")
    avancado: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class UnidadeUorg(Base):
    __tablename__ = "unidade_uorg"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo_uorg: Mapped[str | None] = mapped_column(String(6), unique=True)
    sigla: Mapped[str | None] = mapped_column(String(20))
    # nome_oficial: caixa alta do SIAPE (coluna I da planilha)
    nome_oficial: Mapped[str] = mapped_column(String(160), nullable=False)
    # nome_extenso: como sai no parecer (coluna G)
    nome_extenso: Mapped[str] = mapped_column(String(160), nullable=False)
    tipo: Mapped[str] = mapped_column(String(20), nullable=False)
    unidade_pai_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    campus_id: Mapped[int] = mapped_column(ForeignKey("campus.id"), nullable=False)
    emite_portaria: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    campus: Mapped[Campus] = relationship(lazy="selectin")
    postos: Mapped[list["PostoTrabalho"]] = relationship(back_populates="unidade")

    __table_args__ = (
        CheckConstraint(
            "tipo IN ('FACULDADE','INSTITUTO','DEPARTAMENTO','PRO_REITORIA','DIRETORIA',"
            "'COORDENADORIA','SUPERINTENDENCIA','SECRETARIA','OUTRO')",
            name="ck_uorg_tipo",
        ),
    )

    @property
    def uorg_bruto(self) -> str:
        """'250 - FACULDADE DE MEDICINA DE DIAMANTINA' (formato da coluna I)."""
        if self.codigo_uorg:
            return f"{self.codigo_uorg} - {self.nome_oficial}"
        return self.nome_oficial


class PostoTrabalho(Base):
    __tablename__ = "posto_trabalho"

    id: Mapped[int] = mapped_column(primary_key=True)
    unidade_uorg_id: Mapped[int] = mapped_column(
        ForeignKey("unidade_uorg.id"), nullable=False
    )
    nome: Mapped[str] = mapped_column(String(180), nullable=False)
    sigla: Mapped[str | None] = mapped_column(String(20))
    descricao: Mapped[str | None] = mapped_column(Text)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    unidade: Mapped[UnidadeUorg] = relationship(back_populates="postos", lazy="selectin")

    # 'Laboratorio de Quimica' existe no IECT e no ICA - unico por unidade
    __table_args__ = (UniqueConstraint("unidade_uorg_id", "nome", name="uq_posto"),)


class Cargo(Base):
    __tablename__ = "cargo"

    id: Mapped[int] = mapped_column(primary_key=True)
    nome: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    codigo_siape: Mapped[str | None] = mapped_column(String(10))


class Servidor(Base):
    __tablename__ = "servidor"

    id: Mapped[int] = mapped_column(primary_key=True)
    siape: Mapped[str] = mapped_column(String(7), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(160), nullable=False)
    cargo_id: Mapped[int | None] = mapped_column(ForeignKey("cargo.id"))
    funcao: Mapped[str | None] = mapped_column(String(120))
    unidade_uorg_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    uorg_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    situacao: Mapped[str] = mapped_column(String(20), nullable=False, default="ATIVO")
    email: Mapped[str | None] = mapped_column(String(160))

    cargo: Mapped[Cargo | None] = relationship(lazy="selectin")
    unidade: Mapped[UnidadeUorg | None] = relationship(
        lazy="selectin", foreign_keys=[unidade_uorg_id]
    )
    uorg: Mapped[UnidadeUorg | None] = relationship(
        lazy="selectin", foreign_keys=[uorg_id]
    )
    lotacoes: Mapped[list["ServidorLotacao"]] = relationship(
        back_populates="servidor",
        order_by="ServidorLotacao.vigencia_inicio",
        cascade="all, delete-orphan",
    )

    __table_args__ = (check_regex("ck_siape", "siape", PADRAO_SIAPE),)


class LotacaoPosto(Base):
    """Os postos de um período de lotação.

    São vários de propósito: o mesmo servidor atende, por exemplo, o LEAC e o
    Laboratório de Doenças Infecciosas e Parasitárias — foi assim no parecer
    1/2025. O parecer já tratava posto como lista; o cadastro também precisa.
    """

    __tablename__ = "lotacao_posto"

    lotacao_id: Mapped[int] = mapped_column(
        ForeignKey("servidor_lotacao.id", ondelete="CASCADE"), primary_key=True
    )
    posto_trabalho_id: Mapped[int] = mapped_column(
        ForeignKey("posto_trabalho.id"), primary_key=True
    )
    ordem: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    posto: Mapped["PostoTrabalho"] = relationship(lazy="selectin")


class ServidorLotacao(Base):
    """Histórico datado de lotação e cargo do servidor.

    Por que existe: o servidor muda de unidade, de posto e de cargo, e o
    adicional depende de ONDE e EM QUE FUNÇÃO ele estava em cada período.
    Sobrescrever o cadastro apagaria a prova da exposição passada — que é
    exatamente o que a aposentadoria especial vai precisar depois (Lei 8.112,
    arts. 206-A e 211-214).

    O `servidor` guarda o estado ATUAL (é o que a tela mostra e o parecer usa);
    esta tabela guarda a linha do tempo.
    """

    __tablename__ = "servidor_lotacao"

    id: Mapped[int] = mapped_column(primary_key=True)
    servidor_id: Mapped[int] = mapped_column(ForeignKey("servidor.id"), nullable=False)
    # Unidade e UORG sao campos DIFERENTES no parecer e nem sempre apontam para
    # o mesmo nivel: a Unidade e o lugar ('Faculdade de Medicina de Diamantina')
    # e a UORG e o codigo de lotacao no SIAPE ('250 - FACULDADE DE MEDICINA...').
    # Quando a UORG nao for informada, o parecer usa a propria Unidade.
    unidade_uorg_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    uorg_id: Mapped[int | None] = mapped_column(ForeignKey("unidade_uorg.id"))
    cargo_id: Mapped[int | None] = mapped_column(ForeignKey("cargo.id"))
    funcao: Mapped[str | None] = mapped_column(String(120))
    vigencia_inicio: Mapped[date] = mapped_column(DataPura, nullable=False)
    vigencia_fim: Mapped[date | None] = mapped_column(DataPura)
    # portaria de localização, memorando, ato — o documento que sustenta a mudança
    documento: Mapped[str | None] = mapped_column(String(200))
    observacao: Mapped[str | None] = mapped_column(Text)
    registrado_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))

    servidor: Mapped["Servidor"] = relationship(
        back_populates="lotacoes", lazy="selectin"
    )
    unidade: Mapped[UnidadeUorg | None] = relationship(
        lazy="selectin", foreign_keys=[unidade_uorg_id]
    )
    uorg: Mapped[UnidadeUorg | None] = relationship(
        lazy="selectin", foreign_keys=[uorg_id]
    )
    cargo: Mapped[Cargo | None] = relationship(lazy="selectin")
    vinculos_posto: Mapped[list[LotacaoPosto]] = relationship(
        cascade="all, delete-orphan",
        order_by="LotacaoPosto.ordem",
        lazy="selectin",
    )

    @property
    def postos(self) -> list[PostoTrabalho]:
        return [vinculo.posto for vinculo in self.vinculos_posto]

    __table_args__ = (
        UniqueConstraint("servidor_id", "vigencia_inicio", name="uq_lotacao_inicio"),
        CheckConstraint(
            "vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio",
            name="ck_lotacao_periodo",
        ),
    )

    @property
    def aberta(self) -> bool:
        return self.vigencia_fim is None

    def vigente_em(self, quando: date) -> bool:
        return self.vigencia_inicio <= quando and (
            self.vigencia_fim is None or self.vigencia_fim >= quando
        )


class PortariaLocalizacao(Base):
    __tablename__ = "portaria_localizacao"

    id: Mapped[int] = mapped_column(primary_key=True)
    unidade_emissora_id: Mapped[int] = mapped_column(
        ForeignKey("unidade_uorg.id"), nullable=False
    )
    # numero normalizado sem zeros a esquerda (RN-10); o literal fica em texto_original
    numero: Mapped[str] = mapped_column(String(10), nullable=False)
    ano: Mapped[int] = mapped_column(Integer, nullable=False)
    data_publicacao: Mapped[date] = mapped_column(DataPura, nullable=False)
    texto_original: Mapped[str] = mapped_column(Text, nullable=False)
    arquivo_anexo_id: Mapped[int | None] = mapped_column(Integer)

    unidade_emissora: Mapped[UnidadeUorg] = relationship(lazy="selectin")

    __table_args__ = (
        UniqueConstraint("unidade_emissora_id", "numero", "ano", name="uq_portaria"),
        CheckConstraint(
            "CAST(strftime('%Y', data_publicacao) AS integer) = ano",
            name="ck_portaria_ano",
        ),
    )


class PortariaServidor(Base):
    __tablename__ = "portaria_servidor"

    portaria_id: Mapped[int] = mapped_column(
        ForeignKey("portaria_localizacao.id"), primary_key=True
    )
    servidor_id: Mapped[int] = mapped_column(ForeignKey("servidor.id"), primary_key=True)
    posto_trabalho_id: Mapped[int | None] = mapped_column(ForeignKey("posto_trabalho.id"))


__all__ = [
    "Cargo",
    "Campus",
    "LotacaoPosto",
    "PortariaLocalizacao",
    "PortariaServidor",
    "PostoTrabalho",
    "Servidor",
    "ServidorLotacao",
    "UnidadeUorg",
    "PADRAO_SIAPE",
]
